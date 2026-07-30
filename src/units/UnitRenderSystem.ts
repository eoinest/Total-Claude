import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { Clip, Faction, SoldierState, type UnitTypeDef } from '../sim/types';
import { unitType, isCavalry } from './roster';
import {
  MAN_CLIP_SET, HORSE_CLIP_SET, FOOT_CLIP_MAP, RIDE_CLIP_MAP,
  HORSE_GAIT_LADDER, HORSE_GAIT_STRIDE, HORSE_CHARGE_CLIP, HORSE_STATE_MAP, HORSE_CHARGE_MASK,
  FOOT_CLIP_VARIANT_MAP, FOOT_VARIANTS, bakePointTrack, meanPointOverClip,
} from '../anim/clips';
import { hash01 } from '../util/rand';
import { bakeAnimTexture, type AnimTexture } from '../anim/animTexture';
import { MAN_RIG, MB, restPos } from '../anim/rig';
import {
  makeSoldierMaterial, type SoldierMaterialSet, type PoseVaryBones,
} from '../anim/skinShader';
import { buildSoldierAtlas, EMBLEM_ORIGIN, EMBLEM_TILE, type SoldierAtlas } from './atlas';
import { buildSoldierGeometry, type Lod } from './soldierMesh';
import {
  buildHorseGeometry, HORSE_MASK_LO, SADDLE_BONES, SADDLE_SEAT, HORSE_GROUND_LIFT,
} from './horseMesh';
import {
  resolveKit, emptyKit, ROUT_DROP_HI, CORPSE_DROP_HI, CORPSE_DROP_LO,
  CORPSE_DROP_COARSE, CORPSE_DROP_COARSE_HELM, Piece, type ResolvedKit,
} from './kit';
import {
  renderImpostorAtlas, buildImpostorGeometry, makeImpostorMaterial, type ImpostorAtlas,
} from './impostor';
import type { SkySystem } from '../render/SkySystem';
import { makeCorpsePose, type CorpsePose, type RagdollSystem } from '../sim/Ragdoll';

/**
 * Soldier rendering: GPU-skinned instances, distance LODs and a billboard far tier.
 *
 * ## Shape of a frame
 * One pass over the pool decides, per man: is he visible, which LOD, which animation rows,
 * which kit mask. He is appended to that LOD's instance arrays, and at the end each LOD
 * uploads one contiguous block. Nothing per-man touches the scene graph, allocates, or
 * issues a draw of its own.
 *
 * ## Draw calls
 *   2 factions x 3 mesh LODs   = 6
 *   1 horse mesh x 3 LODs      = 3   (both factions ride the same animal)
 *   1 impostor billboard sheet = 1
 *                              = 10, inside the 12 the architecture budgets.
 *
 * ## Why the renderer keeps its own playhead
 * `pool.animTime` advances at roughly one cycle per second whatever the clip is, because
 * the sim has no clip table to consult. That is fine for a one-shot but wrong for
 * everything else: an idle breathes at three times life, and a marching man's feet skate
 * because his stride is not his ground speed. So for looping clips this system runs its
 * own phase, advanced by `groundSpeed / clip.rootSpeed` for locomotion and `1 / duration`
 * otherwise. One-shot clips (the four deaths) still read `pool.animTime` directly, because
 * the sim flips Dying to Dead when that reaches 1 and the pose must arrive with it.
 */

/** Per-instance float layout. Must match the attribute declarations in skinShader.ts. */
const enum Stride {
  Pos = 3,
  Orient = 4,
  AnimA = 4,
  AnimB = 4,
  Kit = 2,
  Col0 = 4,
  Col1 = 4,
  Quat = 4,
}

const LOD_COUNT = 3;
/**
 * Band edges as fractions of the quality tier's `lodFarDistance`.
 *
 * The impostor edge sits at 2.0x rather than 1.0x on purpose. LOD2 is 313 triangles, so
 * three thousand men in it cost under a million triangles — cheap enough that pushing the
 * billboard tier out past 600 m costs nothing and keeps real geometry, with real
 * silhouettes and real shadows, over the whole range a player actually watches from.
 */
const LOD_FRACTION = [0.14, 0.5, 2.0];
/** Hysteresis as a fraction of the band distance: a man must cross well past a boundary
 *  before he changes LOD, otherwise a slow camera pan pops a whole rank back and forth. */
const LOD_HYSTERESIS = 0.12;

/**
 * Side of the corpse occupancy grid, metres. A man lying down is about 1.8 m by 0.5 m, so a
 * 0.7 m cell is roughly "one body's worth of ground" — fine enough that two men in the same
 * cell really are overlapping, coarse enough that the neighbourhood test stays 9 lookups.
 */
const CORPSE_CELL = 0.7;

/**
 * Hysteresis either side of a gait crossover, as a fraction of the crossover speed. The gap
 * is what stops a horse whose speed sits on an edge from flickering between two gaits.
 */
const GAIT_HYST = 0.10;

/** Below this ground speed a mount is standing about rather than walking, metres/second. */
const GAIT_IDLE_EDGE = 0.45;

/**
 * Playback bounds for a mount's gait, in cycles per second.
 *
 * Cycles per second is ground speed over stride length — no clip duration in it, because
 * stride already carries the geometry. The bounds only exist so a horse shuffling in a melee
 * does not freeze mid-stride and a bolting one does not blur; between them the hoof is
 * planted exactly. 2.2 covers the fastest thing in the roster (10.2 m/s over a 5.36 m stride
 * needs 1.90) with headroom, so nothing on the field skates.
 */
const GAIT_RATE_MIN = 0.28;
const GAIT_RATE_MAX = 2.2;

/** Rider clearance: how far the hip joint rides above the top of the saddle, metres. */
const SEAT_RISE = 0.07;

/**
 * How much of a man's formation slot he is allowed to stand off from, metres.
 *
 * A rank at attention is not a ruler. These are visual only — the simulation's position is
 * untouched, so collision, combat reach and the spatial hash all still see the slot the
 * formation gave him — and they are drawn from his stable hash, so a man's own untidiness is
 * his for the whole battle. Lateral is kept well under the 0.86 m file spacing so a rank
 * still reads as a rank; the longitudinal term is larger and scales with speed, because a
 * marching column straggles and a halted one closes up.
 */
const SLOT_LATERAL = 0.11;
const SLOT_ALONG = 0.13;
const SLOT_STRAGGLE = 0.30;

interface InstanceBuffers {
  pos: Float32Array;
  orient: Float32Array;
  animA: Float32Array;
  animB: Float32Array;
  kit: Float32Array;
  col0: Float32Array;
  col1: Float32Array;
  quat: Float32Array;
  count: number;
}

interface Tier {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attrs: {
    pos: THREE.InstancedBufferAttribute;
    orient: THREE.InstancedBufferAttribute;
    animA: THREE.InstancedBufferAttribute;
    animB: THREE.InstancedBufferAttribute;
    kit: THREE.InstancedBufferAttribute;
    col0: THREE.InstancedBufferAttribute;
    col1: THREE.InstancedBufferAttribute;
    quat: THREE.InstancedBufferAttribute;
  };
  buf: InstanceBuffers;
}

const rp = { x: 0, y: 0, z: 0 };

/**
 * Bone chains and pivots the per-man pose variation acts on, read off the man rig itself so
 * a re-bake that reorders bones cannot silently start bending the wrong limb.
 *
 * The chains are contiguous by construction: the rig is topologically sorted and the arms
 * hang off the chest, so `clavL..handL` and `clavR..handR` are each four consecutive
 * indices, and everything from `spineLow` to `handR` is the whole upper body.
 */
const MAN_POSE_VARY: PoseVaryBones = {
  upper: [MB.spineLow, MB.handR],
  head: [MB.neck, MB.head],
  leftArm: [MB.clavL, MB.handL],
  rightArm: [MB.clavR, MB.handR],
  neckPivot: restPos(MAN_RIG, MB.neck, [0, 0, 0]),
  leftShoulder: restPos(MAN_RIG, MB.upperArmL, [0, 0, 0]),
  rightShoulder: restPos(MAN_RIG, MB.upperArmR, [0, 0, 0]),
  hipY: MAN_RIG.restT[MB.pelvis * 3 + 1],
  weaponHand: restPos(MAN_RIG, MB.handR, [0, 0, 0]),
  // A hedge of spears fans; a rank of drawn blades varies much less, because a man
  // thrusting is pointing at something.
  poleWeapons: [Piece.WeaponSpear, Piece.Pilum, Piece.JavelinBundle],
  bladeWeapons: [Piece.WeaponSword, Piece.WeaponAxe],
};

/** Precomputed playback facts per packed clip, so the hot loop does no lookups. */
interface ClipFacts {
  rowBase: number;
  frames: number;
  loop: boolean;
  invDuration: number;
  /** Metres per second at rate 1; 0 for a stationary clip. */
  rootSpeed: number;
  /**
   * Take the playhead from `pool.animTime` rather than running our own.
   *
   * The combat system writes `animTime` for a man in melee so the blow lands on the
   * weapon's contact frame, and the ragdoll system reads it while a corpse falls. For
   * those clips the sim is the authority; for idles and locomotion it has no clip table
   * and we are.
   */
  simDriven: boolean;
}

/**
 * Clips whose timing belongs to the simulation, not the renderer.
 *
 * Every shape variant of an attack has to be in here alongside its base clip. A variant
 * left out would run on the renderer's own playhead, and the blow would land wherever that
 * happened to be rather than on the frame the combat system timed the damage to — weapon
 * and wound visibly out of agreement, which is worse than no variant at all.
 */
const SIM_DRIVEN = new Set([
  'attackThrust', 'attackThrustHigh', 'attackOverhead', 'attackOverheadCross',
  'attackSlash', 'shieldBash', 'block', 'parry',
  'stagger', 'throwPilum', 'drawBow', 'releaseBow',
  'deathBack', 'deathForward', 'deathSide', 'deathKneel',
  'rideCharge', 'rideDeath', 'rear', 'death',
]);

function clipFacts(set: typeof MAN_CLIP_SET): ClipFacts[] {
  return set.clips.map((c, i) => ({
    rowBase: set.rows[i],
    frames: c.frames,
    loop: c.loop,
    invDuration: 1 / Math.max(0.05, c.duration),
    rootSpeed: c.rootSpeed > 0.1 ? c.rootSpeed : 0,
    simDriven: !c.loop || SIM_DRIVEN.has(c.name),
  }));
}

export class UnitRenderSystem implements Subsystem {
  readonly name = 'unitRender';
  readonly order = 200;

  private battle!: BattleSystem;
  private atlas!: SoldierAtlas;
  private manAnim!: AnimTexture;
  private horseAnim!: AnimTexture;
  private mats: SoldierMaterialSet[] = [];
  /** [faction][lod] */
  private soldierTiers: Tier[][] = [];
  private horseTiers: Tier[] = [];
  private impostorTier?: Tier;
  private impostors?: ImpostorAtlas;
  private impostorMat?: THREE.MeshBasicMaterial;
  private group = new THREE.Group();

  // ---- per-soldier renderer state ----
  private phase!: Float32Array;
  private prevPhase!: Float32Array;
  private blend!: Float32Array;
  private curClip!: Uint8Array;
  private prevClip!: Uint8Array;
  private lodOf!: Uint8Array;
  private kitLo!: Float32Array;
  private kitHi!: Float32Array;
  private kitHiMelee!: Float32Array;
  private kitCoarse!: Float32Array;
  private kitTunic!: Float32Array;
  private kitLeg!: Float32Array;
  private kitEmblem!: Float32Array;
  private kitMetal!: Float32Array;
  private kitReady!: Uint8Array;
  private typeIndex!: Int32Array;
  /** Stable per-man playhead offset, 0..1 of a cycle. */
  private phaseOff!: Float32Array;
  /** Stable per-man rate multiplier, applied to stationary clips only. */
  private rateMul!: Float32Array;
  /** Which gait of `HORSE_GAIT_LADDER` this man's mount is in; the ladder rung, not a clip. */
  private gaitRung!: Uint8Array;
  /** Horse clip currently playing, the one being faded out, and the fade, per rider. */
  private horseCur!: Uint8Array;
  private horsePrev!: Uint8Array;
  private horseBlend!: Float32Array;
  private horsePrevPhase!: Float32Array;
  /** Which shape variant of a clip this man plays, 0..FOOT_VARIANTS-1. */
  private clipBucket!: Uint8Array;
  /** Extra stature multiplier on top of `pool.scale`. */
  private heightMul!: Float32Array;
  /** Per-man stand-off from his formation slot: lateral, longitudinal, straggle. */
  private slotOff!: Float32Array;
  /** Lateral nudge and lift resolved once per corpse, 3 floats per soldier. */
  private corpseNudge!: Float32Array;
  /**
   * Roll about the corpse's own spine, radians, resolved once with the nudge.
   *
   * The solver tips a body over about a horizontal axis taken from the blow that killed it
   * and stops there, so every corpse ends up belly-down along its line of fall and a field
   * of them reads as one shape repeated. Men die face down, face up and on either side; this
   * is the cheapest way to say so, and unlike the lateral push it costs nothing in the sim.
   */
  private corpseRoll!: Float32Array;
  private corpseNudged!: Uint8Array;
  /**
   * How many settled corpses occupy each cell of a coarse ground grid.
   *
   * The ragdoll solver settles each body where its owner fell and has no notion of the
   * bodies already lying there, so in the heaviest fighting thirty men come to rest inside
   * two metres and the result reads as a heap of parts rather than a field of dead men. This
   * grid is the renderer's answer: it is consulted once, when a body stops moving, to push it
   * clear of its neighbours and let it lie on top of them rather than through them.
   */
  private corpseCells = new Map<number, number>();

  private types: UnitTypeDef[] = [];
  private typeIsCav: boolean[] = [];
  private manFacts!: ClipFacts[];
  private horseFacts!: ClipFacts[];
  /** Animated saddle seat, 3 floats per horse animation row. See `bakePointTrack`. */
  private saddleTrack!: Float32Array;
  /** Mean pelvis height and fore-aft offset per man clip — where his seat is in his own mesh. */
  private riderSeatY!: Float32Array;
  private riderSeatZ!: Float32Array;
  /** Ground speed at which a mount changes up from rung r to r+1, and drops back, m/s. */
  private gaitUp!: Float32Array;
  private gaitDown!: Float32Array;
  private lodDist: number[] = [40, 120, 480];
  private lodEdges = [40, 120, 220];
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 1.4);
  private elapsed = 0;
  private warmed = false;
  private sky?: SkySystem;
  private ragdoll?: RagdollSystem;
  private corpse: CorpsePose = makeCorpsePose();
  private kitScratch: ResolvedKit = emptyKit();

  init(ctx: EngineContext): void {
    this.battle = ctx.get<BattleSystem>('battle');
    this.sky = ctx.tryGet<SkySystem>('sky');
    this.ragdoll = ctx.tryGet<RagdollSystem>('ragdoll');
    const cap = ctx.quality.maxSoldiers;

    this.atlas = buildSoldierAtlas(Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()));
    this.manAnim = bakeAnimTexture(MAN_CLIP_SET, 'man');
    this.horseAnim = bakeAnimTexture(HORSE_CLIP_SET, 'horse');
    this.manFacts = clipFacts(MAN_CLIP_SET);
    this.horseFacts = clipFacts(HORSE_CLIP_SET);

    // Where the saddle actually is on every frame of every gait, and where each rider clip
    // puts his own seat. Seating him is then one subtraction rather than a guessed constant.
    this.saddleTrack = bakePointTrack(
      HORSE_CLIP_SET,
      [0, SADDLE_SEAT.y, SADDLE_SEAT.z],
      SADDLE_BONES.bone0, SADDLE_BONES.bone1, SADDLE_BONES.weight0
    );
    const pelvisRest = restPos(MAN_RIG, MB.pelvis, [0, 0, 0]);
    const pelvisTrack = bakePointTrack(MAN_CLIP_SET, pelvisRest, MB.pelvis);
    this.riderSeatY = new Float32Array(MAN_CLIP_SET.clips.length);
    this.riderSeatZ = new Float32Array(MAN_CLIP_SET.clips.length);
    for (let c = 0; c < MAN_CLIP_SET.clips.length; c++) {
      // The *mean* over the clip, not the per-frame value: subtracting the per-frame pelvis
      // would cancel the rider's own rise out of the saddle, which is half of what a gallop
      // looks like. The mean pins his seat to the saddle and leaves his bounce intact.
      const m = meanPointOverClip(MAN_CLIP_SET, pelvisTrack, c);
      this.riderSeatY[c] = m[1];
      this.riderSeatZ[c] = m[2];
    }

    // Gait crossovers, from the strides the clips were measured to have rather than from
    // guessed speeds. The crossover sits at the *geometric mean* of two adjacent strides, so
    // both gaits are the same factor away from their own tempo either side of it: walk and
    // trot swap at 2.15 m/s where one plays at 1.23 and the other at 0.81, and trot and gallop
    // at 3.76 m/s at 1.42 and 0.70. Nothing on the field ever plays a gait at half speed,
    // which is what a fixed fraction of the faster gait's stride produced — a horse cantering
    // in slow motion beside a walking one.
    const rungs = HORSE_GAIT_LADDER.length;
    this.gaitUp = new Float32Array(rungs - 1);
    this.gaitDown = new Float32Array(rungs - 1);
    for (let r = 0; r < rungs - 1; r++) {
      const slow = HORSE_GAIT_STRIDE[r];
      const fast = HORSE_GAIT_STRIDE[r + 1];
      // The idle has no stride at all, so the bottom edge is a plain "is he moving" test.
      const cross = slow > 0.05 ? Math.sqrt(slow * fast) : GAIT_IDLE_EDGE;
      this.gaitUp[r] = cross * (1 + GAIT_HYST);
      this.gaitDown[r] = cross * (1 - GAIT_HYST);
    }

    this.phase = new Float32Array(cap);
    this.prevPhase = new Float32Array(cap);
    this.blend = new Float32Array(cap).fill(1);
    this.curClip = new Uint8Array(cap).fill(255);
    this.prevClip = new Uint8Array(cap);
    this.lodOf = new Uint8Array(cap);
    this.kitLo = new Float32Array(cap);
    this.kitHi = new Float32Array(cap);
    this.kitHiMelee = new Float32Array(cap);
    this.kitCoarse = new Float32Array(cap);
    this.kitTunic = new Float32Array(cap * 3);
    this.kitLeg = new Float32Array(cap * 3);
    this.kitEmblem = new Float32Array(cap);
    this.kitMetal = new Float32Array(cap);
    this.kitReady = new Uint8Array(cap);
    this.typeIndex = new Int32Array(cap).fill(-1);
    this.phaseOff = new Float32Array(cap);
    // Zero means "not yet resolved"; `ensureGait` fills it on first sight.
    this.rateMul = new Float32Array(cap);
    this.gaitRung = new Uint8Array(cap);
    this.horseCur = new Uint8Array(cap).fill(255);
    this.horsePrev = new Uint8Array(cap);
    this.horseBlend = new Float32Array(cap).fill(1);
    this.horsePrevPhase = new Float32Array(cap);
    this.clipBucket = new Uint8Array(cap);
    this.heightMul = new Float32Array(cap).fill(1);
    this.slotOff = new Float32Array(cap * 3);
    this.corpseNudge = new Float32Array(cap * 3);
    this.corpseRoll = new Float32Array(cap);
    this.corpseNudged = new Uint8Array(cap);

    const baseParams: THREE.MeshStandardMaterialParameters = {
      map: this.atlas.albedo,
      normalMap: this.atlas.normal,
      roughnessMap: this.atlas.orm,
      metalnessMap: this.atlas.orm,
      // The atlas packs cavity AO in the same texture's red channel and it was never bound,
      // so every crevice the generator carefully darkened — between girdle plates, inside a
      // mail ring, at the elbow crease — was being thrown away. Same texture, so the extra
      // fetch is a cache hit.
      aoMap: this.atlas.orm,
      // Enough to read as contact darkening, not enough to crush plate to black now that
      // the rig's shadows are genuinely dark.
      aoMapIntensity: 0.6,
      // Above 1 on purpose, and this is the single number that decides whether an army reads
      // as men or as silhouettes. Measured, by reading back the framebuffer over a rectangle
      // of Roman ranks in the `melee` camera and taking percentiles of display luminance:
      //
      //     envMapIntensity   0.9    1.8    3.2    5.0
      //     median            0.014  0.042  0.051  0.075
      //     mean R            0.063  0.165  0.183  0.204
      //
      // At 0.9 half of every soldier was below 1.4% display luminance — black. Raising
      // albedo does not fix that and raising metalness makes it worse, because with the
      // rig's fill trimmed a part-metal surface in shadow has almost nothing to be lit *by*;
      // what it needs is more energy in the probe it reflects.
      //
      // `tools/probe-units.mjs` then settled the remaining question — whether the probe was
      // reaching this material at all — by zeroing `scene.environmentIntensity` and
      // re-rendering: mean frame luminance fell from 0.0662 to 0.0471, so the environment is
      // bound and supplies 29% of the frame. It is not the wiring, it is the level. The scene
      // trims the probe to 0.6 for the lighting rig's own contrast reasons, so 2.9 here is an
      // effective gain of 1.74 — and it is defensible: the probe is a PMREM of the physical
      // sky with the solar aureole preserved, so this is a real reflection, not a lift.
      envMapIntensity: 2.9,
      roughness: 1,
      metalness: 1,
      normalScale: new THREE.Vector2(0.9, 0.9),
      // Front faces only. Everything here is a closed shell, and the two things that are
      // not — the cloak and the horse's mane — emit both windings in the geometry. Culling
      // backfaces halves the fragment cost at close range, where a rank of men fills the
      // frame several times over and fill rate is what actually limits the frame.
      side: THREE.FrontSide,
      dithering: true,
    };

    const manMat = makeSoldierMaterial(baseParams, {
      anim: this.manAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      // Lean ramps in over the full height of a man so his feet stay on the ground.
      leanHeight: 1.5,
      poseVary: MAN_POSE_VARY,
    });
    const horseMat = makeSoldierMaterial(baseParams, {
      anim: this.horseAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      leanHeight: 1.7,
    });
    this.mats.push(manMat, horseMat);

    for (const faction of [Faction.Rome, Faction.Germanic]) {
      const row: Tier[] = [];
      for (let lod = 0; lod < LOD_COUNT; lod++) {
        const geo = buildSoldierGeometry(faction, lod as Lod);
        row.push(this.makeTier(geo, manMat, cap, `soldiers-${Faction[faction]}-lod${lod}`));
      }
      this.soldierTiers.push(row);
    }
    // Cavalry is a small fraction of any army; a quarter of the pool is generous.
    const horseCap = Math.max(256, Math.ceil(cap * 0.25));
    for (let lod = 0; lod < LOD_COUNT; lod++) {
      const geo = buildHorseGeometry(lod as Lod);
      this.horseTiers.push(this.makeTier(geo, horseMat, horseCap, `horses-lod${lod}`));
    }

    ctx.scene.add(this.group);
    this.buildImpostors(ctx, cap);
    this.applyQuality(ctx);
  }

  /**
   * Compile every soldier program before the first real frame.
   *
   * Each geometry/material pairing is a distinct GPU program and the first frame that needs
   * one stalls for a tenth of a second or more while the driver builds it — a visible hitch
   * the moment the player zooms across an LOD boundary, and a bogus frame time on whichever
   * screenshot happens to be taken first. So every tier is drawn once with a single
   * instance into an 8x8 target.
   *
   * It has to be the *real* scene and camera: a program's cache key includes the scene's
   * light and shadow counts and its fog, so warming against a throwaway scene compiles a
   * variant nothing will ever use again.
   */
  private prewarm(ctx: EngineContext): void {
    const target = new THREE.WebGLRenderTarget(8, 8);
    const prev = ctx.renderer.getRenderTarget();
    const tiers = [...this.soldierTiers.flat(), ...this.horseTiers];
    if (this.impostorTier) tiers.push(this.impostorTier);
    const saved = tiers.map((t) => ({ count: t.geometry.instanceCount, visible: t.mesh.visible }));

    for (const t of tiers) {
      if (t.geometry.instanceCount === 0) {
        t.geometry.instanceCount = 1;
        t.buf.pos[0] = ctx.camera.position.x;
        t.buf.pos[1] = ctx.camera.position.y - 60;
        t.buf.pos[2] = ctx.camera.position.z;
        t.buf.orient[1] = 1;
        if (t.buf.kit.length) { t.buf.kit[0] = 0xffffff; t.buf.kit[1] = 0xffffff; }
        for (const a of Object.values(t.attrs)) a.needsUpdate = true;
      }
      t.mesh.visible = true;
    }
    ctx.renderer.setRenderTarget(target);
    ctx.renderer.render(ctx.scene, ctx.camera);
    ctx.renderer.setRenderTarget(prev);
    tiers.forEach((t, i) => {
      t.geometry.instanceCount = saved[i].count;
      t.mesh.visible = saved[i].visible;
    });
    target.dispose();
  }

  private makeTier(
    geometry: THREE.InstancedBufferGeometry,
    mat: SoldierMaterialSet,
    cap: number,
    name: string
  ): Tier {
    const buf: InstanceBuffers = {
      pos: new Float32Array(cap * Stride.Pos),
      orient: new Float32Array(cap * Stride.Orient),
      animA: new Float32Array(cap * Stride.AnimA),
      animB: new Float32Array(cap * Stride.AnimB),
      kit: new Float32Array(cap * Stride.Kit),
      col0: new Float32Array(cap * Stride.Col0),
      col1: new Float32Array(cap * Stride.Col1),
      quat: new Float32Array(cap * Stride.Quat),
      count: 0,
    };
    const attr = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs = {
      pos: attr(buf.pos, Stride.Pos),
      orient: attr(buf.orient, Stride.Orient),
      animA: attr(buf.animA, Stride.AnimA),
      animB: attr(buf.animB, Stride.AnimB),
      kit: attr(buf.kit, Stride.Kit),
      col0: attr(buf.col0, Stride.Col0),
      col1: attr(buf.col1, Stride.Col1),
      quat: attr(buf.quat, Stride.Quat),
    };
    geometry.setAttribute('iPos', attrs.pos);
    geometry.setAttribute('iOrient', attrs.orient);
    geometry.setAttribute('iAnimA', attrs.animA);
    geometry.setAttribute('iAnimB', attrs.animB);
    geometry.setAttribute('iKit', attrs.kit);
    geometry.setAttribute('iCol0', attrs.col0);
    geometry.setAttribute('iCol1', attrs.col1);
    geometry.setAttribute('iQuat', attrs.quat);
    geometry.instanceCount = 0;

    const mesh = new THREE.Mesh(geometry, mat.material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Culling is per instance on the CPU; three's object-level test would either cull the
    // whole army or never cull anything.
    mesh.frustumCulled = false;
    mesh.customDepthMaterial = mat.depth;
    mesh.customDistanceMaterial = mat.distance;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, geometry, attrs, buf };
  }

  /**
   * Capture the far tier. One atlas row per faction, eight yaws each, taken from LOD1 in a
   * mid-march pose — the pose a man in the far distance is overwhelmingly likely to be in.
   */
  private buildImpostors(ctx: EngineContext, cap: number): void {
    const marchIdx = FOOT_CLIP_MAP[Clip.March];
    const facts = this.manFacts[marchIdx];
    const captureRow = facts.rowBase + Math.floor(facts.frames * 0.22);

    const groups = [Faction.Rome, Faction.Germanic].map((faction) => {
      const geometry = buildSoldierGeometry(faction, 1);
      const def = unitType(faction === Faction.Rome ? 'legio-cohort' : 'juthungi-warband');
      const kit = resolveKit(def, 0.37, emptyKit());
      const one = (arr: number[], n: number): THREE.InstancedBufferAttribute => {
        const at = new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
        return at;
      };
      geometry.setAttribute('iPos', one([0, 0, 0], 3));
      geometry.setAttribute('iOrient', one([0, 1, 0, 0.05], 4));
      geometry.setAttribute('iAnimA', one([captureRow, captureRow, 0, 1], 4));
      geometry.setAttribute('iAnimB', one([captureRow, captureRow, 0, 0.37], 4));
      geometry.setAttribute('iKit', one([kit.maskLo, kit.maskHi], 2));
      geometry.setAttribute('iCol0', one([...kit.tunic, kit.emblem], 4));
      geometry.setAttribute('iCol1', one([...kit.leg, kit.metal], 4));
      geometry.instanceCount = 1;
      return {
        geometry,
        material: this.mats[0].material,
        setup: (g: THREE.InstancedBufferGeometry, yaw: number): void => {
          const o = g.getAttribute('iOrient') as THREE.InstancedBufferAttribute;
          o.array[0] = yaw;
          o.needsUpdate = true;
        },
      };
    });

    this.impostors = renderImpostorAtlas(ctx.renderer, groups, {
      direction: this.sky?.sunDirection.clone() ?? new THREE.Vector3(0.4, 0.7, -0.6),
      colour: this.sky?.sunColour.clone() ?? new THREE.Color(0xfff2dc),
      ambient: this.sky?.ambientColour.clone() ?? new THREE.Color(0x9dbcdc),
    });
    for (const g of groups) g.geometry.dispose();

    this.impostorMat = makeImpostorMaterial(this.impostors);
    const quad = buildImpostorGeometry();
    const buf: InstanceBuffers = {
      pos: new Float32Array(cap * Stride.Pos),
      orient: new Float32Array(cap * Stride.Orient),
      animA: new Float32Array(0),
      animB: new Float32Array(0),
      kit: new Float32Array(0),
      col0: new Float32Array(cap * Stride.Col0),
      col1: new Float32Array(0),
      quat: new Float32Array(0),
      count: 0,
    };
    const pos = new THREE.InstancedBufferAttribute(buf.pos, 3);
    const orient = new THREE.InstancedBufferAttribute(buf.orient, 4);
    const col0 = new THREE.InstancedBufferAttribute(buf.col0, 4);
    for (const a of [pos, orient, col0]) a.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('iPos', pos);
    quad.setAttribute('iOrient', orient);
    quad.setAttribute('iCol0', col0);
    quad.instanceCount = 0;
    const mesh = new THREE.Mesh(quad, this.impostorMat);
    mesh.name = 'soldiers-impostor';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    this.group.add(mesh);
    this.impostorTier = {
      mesh,
      geometry: quad,
      attrs: {
        pos, orient, col0,
        animA: pos, animB: pos, kit: pos, col1: pos, quat: pos,
      },
      buf,
    };
  }

  private applyQuality(ctx: EngineContext): void {
    const far = ctx.quality.lodFarDistance;
    this.lodDist = [far * LOD_FRACTION[0], far * LOD_FRACTION[1], far * LOD_FRACTION[2]];
  }

  resize(_w: number, _h: number, ctx: EngineContext): void {
    this.applyQuality(ctx);
  }

  update(dt: number, ctx: EngineContext): void {
    this.elapsed += dt;
    for (const m of this.mats) m.uniforms.uTime.value = this.elapsed;
    this.advancePlayheads(dt, ctx);
  }

  /**
   * Advance each man's playhead.
   *
   * Locomotion rate comes from his actual ground speed divided by the clip's measured stride
   * speed *and his own stature*, which is what makes feet stay planted. Stature belongs in
   * that division and was missing: a man drawn 7% larger has a 7% longer leg, so his foot
   * drifts 7% faster through the same clip, and dividing by his scale is the difference
   * between a rank of men who each keep their own cadence and a rank running to one
   * metronome. It is exact, not a jitter — the foot plants either way.
   *
   * For a mounted man the playhead is the *horse's* gait phase, because that is what an eye
   * reads, and the rider's clip is authored to the same normalised cycle. Its rate comes from
   * the horse's stride, not the rider's clip, whose `rootSpeed` is zero — which is why a
   * charge used to advance at a flat 1.6 cycles a second whatever the animal's speed and the
   * hooves skated by a third of it.
   */
  private advancePlayheads(dt: number, ctx: EngineContext): void {
    const p = this.battle.pool;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      const state = p.state[i] as SoldierState;
      if (state === SoldierState.Dead) continue;

      this.ensureGait(i);
      const cav = this.isCavalry(i);
      const clip = p.animClip[i];
      // `Math.hypot` is a builtin with subnormal and overflow handling that costs several
      // times a plain square root, and this is 8,600 calls a frame.
      const vx = p.vx[i];
      const vz = p.vz[i];
      const speed = Math.sqrt(vx * vx + vz * vz);
      const want = cav
        ? (RIDE_CLIP_MAP[clip] ?? RIDE_CLIP_MAP[Clip.IdleAlert])
        : (FOOT_CLIP_VARIANT_MAP[clip * FOOT_VARIANTS + this.clipBucket[i]]
          ?? FOOT_CLIP_MAP[Clip.IdleAlert]);
      if (this.curClip[i] !== want) {
        if (this.curClip[i] !== 255) {
          this.prevClip[i] = this.curClip[i];
          this.prevPhase[i] = this.phase[i];
          this.blend[i] = 0;
        } else {
          this.prevClip[i] = want;
          this.blend[i] = 1;
          this.phase[i] = this.phaseOff[i];
        }
        this.curClip[i] = want;
        const f = this.manFacts[want];
        // Locomotion resumes mid-cycle so a stop-start never resets the gait. Everything
        // else restarts from the man's own stable offset rather than from zero: a cohort
        // that halts together must not land on one shared pose, which is exactly what
        // starting every idle at frame 0 produced.
        if (f.rootSpeed === 0 && !cav) this.phase[i] = this.phaseOff[i];
      }

      const facts = this.manFacts[this.curClip[i]];
      if (cav) {
        this.advanceMount(i, dt, clip, speed, facts);
      } else if (facts.simDriven) {
        // The sim owns this one: a blow has to land on the frame the combat system timed
        // it to, and a corpse has to reach the ground when the ragdoll says it has.
        this.phase[i] = facts.loop ? p.animTime[i] % 1 : Math.min(1, p.animTime[i]);
      } else if (facts.rootSpeed > 0) {
        // Stride over ground speed over stature, unjittered, so the foot that is down
        // stays down.
        const stride = facts.rootSpeed * p.scale[i] * this.heightMul[i];
        const rate = Math.min(1.9, Math.max(0.55, speed / stride)) * facts.invDuration;
        this.phase[i] = (this.phase[i] + dt * rate) % 1;
      } else {
        const rate = facts.invDuration * p.animRate[i] * this.rateMul[i];
        this.phase[i] = (this.phase[i] + dt * rate) % 1;
      }
      if (this.blend[i] < 1) {
        // 0.16 s cross-fade: long enough to hide a pose change, short enough that a blow
        // still lands on its hit frame.
        this.blend[i] = Math.min(1, this.blend[i] + dt / 0.16);
        const pf = this.manFacts[this.prevClip[i]];
        if (pf.loop) this.prevPhase[i] = (this.prevPhase[i] + dt * pf.invDuration) % 1;
      }
    }
    void ctx;
  }

  /**
   * Choose a mount's gait from its own speed and advance the shared playhead at that gait's
   * cadence.
   *
   * Gait selection walks `HORSE_GAIT_LADDER` with hysteresis, so a horse hovering on a band
   * edge does not flicker; the rung is remembered per man. A one-shot state — a rear, a fall —
   * overrides the ladder and takes its timing from the simulation, which is what makes a
   * dying horse hit the ground when its rider does.
   */
  private advanceMount(
    i: number,
    dt: number,
    clip: Clip,
    speed: number,
    riderFacts: ClipFacts
  ): void {
    const p = this.battle.pool;
    const forced = HORSE_STATE_MAP[clip] ?? -1;
    let want: number;
    let rate: number;

    if (forced >= 0) {
      want = forced;
      const hf = this.horseFacts[forced];
      rate = hf.invDuration;
      // The sim's own playhead, so the rear and the fall land with the rider's.
      this.setHorseClip(i, want);
      this.phase[i] = hf.loop ? p.animTime[i] % 1 : Math.min(1, p.animTime[i]);
      this.tickHorseBlend(i, dt);
      return;
    }

    // ---- ladder with hysteresis ----
    let rung = this.gaitRung[i];
    while (rung + 1 < HORSE_GAIT_LADDER.length && speed > this.gaitUp[rung]) rung++;
    while (rung > 0 && speed < this.gaitDown[rung - 1]) rung--;
    this.gaitRung[i] = rung;
    // Top of the ladder plus the intent to run somebody down is a charge, not a gallop.
    want = rung === HORSE_GAIT_LADDER.length - 1 && HORSE_CHARGE_MASK[clip]
      ? HORSE_CHARGE_CLIP
      : HORSE_GAIT_LADDER[rung];
    this.setHorseClip(i, want);

    const stride = HORSE_GAIT_STRIDE[rung];
    if (stride > 0.05) {
      rate = Math.min(GAIT_RATE_MAX, Math.max(GAIT_RATE_MIN, speed / stride));
    } else {
      // Standing: the idle breathes at the rider's own stable rate.
      rate = this.horseFacts[want].invDuration * this.rateMul[i];
    }
    this.phase[i] = (this.phase[i] + dt * rate) % 1;
    this.tickHorseBlend(i, dt);
    void riderFacts;
  }

  /** Start a cross-fade on the mount if its gait changed. */
  private setHorseClip(i: number, want: number): void {
    if (this.horseCur[i] === want) return;
    if (this.horseCur[i] === 255) {
      this.horsePrev[i] = want;
      this.horseBlend[i] = 1;
    } else {
      this.horsePrev[i] = this.horseCur[i];
      this.horsePrevPhase[i] = this.phase[i];
      this.horseBlend[i] = 0;
    }
    this.horseCur[i] = want;
  }

  private tickHorseBlend(i: number, dt: number): void {
    if (this.horseBlend[i] >= 1) return;
    // Slower than the rider's fade: a change of gait is a change of the whole animal's
    // rhythm, and 0.16 s of it reads as a jump cut.
    this.horseBlend[i] = Math.min(1, this.horseBlend[i] + dt / 0.24);
    const pf = this.horseFacts[this.horsePrev[i]];
    if (pf.loop) this.horsePrevPhase[i] = (this.horsePrevPhase[i] + dt * pf.invDuration) % 1;
  }

  private isCavalry(i: number): boolean {
    const t = this.typeOf(i);
    return t >= 0 ? this.typeIsCav[t] : false;
  }

  /** Cache the unit-type index for a soldier; unit membership never changes. */
  private typeOf(i: number): number {
    let t = this.typeIndex[i];
    if (t >= 0) return t;
    const u = this.battle.unitById(this.battle.pool.unitId[i]);
    if (!u) return -1;
    const def = unitType(u.typeId);
    t = this.types.indexOf(def);
    if (t < 0) {
      t = this.types.length;
      this.types.push(def);
      this.typeIsCav.push(isCavalry(def));
    }
    this.typeIndex[i] = t;
    return t;
  }

  /**
   * Resolve the three numbers that decorrelate a man's animation from his neighbours'.
   *
   * `pool.animRate` is only +-8%, which after a few seconds still leaves a rank clustered
   * inside a fifth of a cycle — visibly in step — and every man's playhead starts at zero,
   * so a formation that halts together stands in exactly one pose. These are what actually
   * break a rank up:
   *
   *   `phaseOff`   a full-cycle offset, so a rank is spread across the whole clip the
   *                instant it enters it rather than converging on the same pose.
   *   `rateMul`    a wide breathing-rate spread, applied to stationary clips only. A
   *                locomotion clip's rate is ground speed over measured stride, and
   *                jittering that slides the feet; cadence variation comes from the
   *                stride-length clip variants instead, which is honest.
   *   `clipBucket` which shape variant of the clip he plays.
   *
   * All three come from `variant[i]`, so a man's gait is his for the whole battle.
   * Resolved on first sight rather than at spawn because the render system is handed a
   * pool it did not fill.
   */
  private ensureGait(i: number): void {
    if (this.rateMul[i] !== 0) return;
    const t = this.typeOf(i);
    const variance = t >= 0 ? this.types[t].appearance.variance : 0.5;
    const seed = Math.floor(this.battle.pool.variant[i] * 16777216);
    this.phaseOff[i] = hash01(seed, 71);
    // A drilled cohort breathes closer to together than a warband does, so the roster's own
    // `variance` scales the spread — but nobody is within 6% of his neighbour.
    const spread = 0.14 + variance * 0.2;
    this.rateMul[i] = 1 + (hash01(seed, 72) - 0.5) * 2 * spread;
    this.clipBucket[i] = Math.min(FOOT_VARIANTS - 1, Math.floor(hash01(seed, 73) * FOOT_VARIANTS));
    // How untidily he holds his slot. Scaled by the roster's own variance, so a praetorian
    // cohort dresses its line and a warband does not, and resolved here rather than per frame
    // because it never changes.
    const ragged = 0.55 + variance;
    this.slotOff[i * 3] = (hash01(seed, 91) - 0.5) * 2 * SLOT_LATERAL * ragged;
    this.slotOff[i * 3 + 1] = (hash01(seed, 92) - 0.5) * 2 * SLOT_ALONG * ragged;
    this.slotOff[i * 3 + 2] = (hash01(seed, 93) - 0.5) * 2 * SLOT_STRAGGLE * ragged;
    // Stature. `pool.scale` spreads a man only +-3.5%, which is under one standard
    // deviation of adult male height and leaves a rank of 160 men looking cut to a
    // template. Widening it here to about +-7% puts the tallest at 1.88 m and the shortest
    // at 1.62 m, which is what a hundred and sixty conscripts actually look like, and it
    // is a stable per-man appearance choice so it belongs on `variant`.
    this.heightMul[i] = 1 + (hash01(seed, 74) - 0.5) * 0.075;
  }

  /** Grid cell key for a ground position. Biased so negative coordinates pack cleanly. */
  private static cellKey(x: number, z: number): number {
    const cx = Math.floor(x / CORPSE_CELL) + 4096;
    const cz = Math.floor(z / CORPSE_CELL) + 4096;
    return cx * 8192 + cz;
  }

  /** Settled corpses whose footprint covers a ground cell. */
  private cellOcc(x: number, z: number): number {
    return this.corpseCells.get(UnitRenderSystem.cellKey(x, z)) ?? 0;
  }

  /**
   * Resolve a settled corpse's separation from the bodies already lying around it.
   *
   * Called once, on the frame a body stops moving, and then cached for the rest of the
   * battle so a corpse never crawls. Three effects, all of which the reference frames show
   * and none of which the solver can know about:
   *
   *   - a push *sideways*, across the body's own long axis. This is the whole point. A
   *     displacement along a corpse's length leaves it inside the man beneath it, because a
   *     body is 1.8 m long and the overlap is along that direction; half a metre across the
   *     axis puts it beside him, laid like cordwood, which is what a real heap looks like.
   *     The side chosen is whichever of the two has fewer bodies on it.
   *   - a lift proportional to how many are already under his *footprint*, so the third man
   *     to fall on a spot lies across the two below instead of through them. Capped near two
   *     bodies' thickness, because a corpse floating higher than the heap it is on is a worse
   *     error than one slightly inside it.
   *   - a roll about his own spine, so the field has men face down, face up and on their
   *     sides rather than one tipped-over shape repeated.
   *
   * Occupancy is registered over three cells along the body's axis rather than one, because
   * a man lying down covers about 1.8 m by 0.5 m and a single-cell footprint told every later
   * corpse that two thirds of him was empty ground.
   *
   * Visual only. The sim's corpse position is untouched, so nothing that queries the pool
   * sees these metres.
   */
  private resolveCorpseNudge(i: number, x: number, z: number, ux: number, uz: number): void {
    // Left perpendicular to the body's long axis, in the ground plane.
    const nx = -uz;
    const nz = ux;
    let here = 0;
    let left = 0;
    let right = 0;
    for (let s = 0; s < 3; s++) {
      const d = 0.4 + s * 0.55;
      const px = x + ux * d;
      const pz = z + uz * d;
      here += this.cellOcc(px, pz);
      left += this.cellOcc(px + nx * CORPSE_CELL, pz + nz * CORPSE_CELL);
      right += this.cellOcc(px - nx * CORPSE_CELL, pz - nz * CORPSE_CELL);
    }

    const seed = Math.floor(this.battle.pool.variant[i] * 16777216);
    const side = left <= right ? 1 : -1;
    const crowd = here + Math.min(left, right);
    // Spread hard and stack shallow. The two are alternatives: every metre of lateral push is
    // a body that does not need lifting, and a corpse lifted above the heap it is supposed to
    // be lying on reads far worse than one slightly inside it. Rome II's dead cover ground;
    // they do not build a mound. The cap runs to 2 m because the sim kills men within a metre
    // or two of one contact point and the renderer is the only thing that can fan them out.
    const push = Math.min(2.0, 0.16 + 0.19 * Math.min(11, crowd)) * (0.7 + hash01(seed, 82) * 0.6);
    // A stagger along the axis as well, so heads and feet do not line up in rows.
    const along = (hash01(seed, 84) - 0.5) * 1.1;

    const o = i * 3;
    const dx = nx * side * push + ux * along;
    const dz = nz * side * push + uz * along;
    this.corpseNudge[o] = dx;
    // 0.22 m is a man's thickness through the chest, and the constant floor is clearance for
    // the roll below: a body turned onto its side puts its shoulder where its belly was.
    this.corpseNudge[o + 1] =
      0.05 + Math.min(0.33, 0.22 * Math.min(2, here)) * (0.85 + hash01(seed, 83) * 0.3);
    this.corpseNudge[o + 2] = dz;

    // Roll, pulled 45% of the way toward the nearest of face-down and face-up. Uniform roll
    // leaves too many bodies balanced on a shoulder; the bias is what a battlefield photograph
    // shows, and it keeps the shield either under the man or flat on top of him.
    const r = (hash01(seed, 85) - 0.5) * 2 * Math.PI;
    const nearest = Math.abs(r) < Math.PI / 2 ? 0 : Math.sign(r) * Math.PI;
    this.corpseRoll[i] = r + (nearest - r) * 0.45;

    for (let s = 0; s < 3; s++) {
      const d = 0.4 + s * 0.55;
      const key = UnitRenderSystem.cellKey(x + dx + ux * d, z + dz + uz * d);
      this.corpseCells.set(key, (this.corpseCells.get(key) ?? 0) + 1);
    }
    this.corpseNudged[i] = 1;
  }

  /**
   * Apply the settled-corpse offsets to `this.corpse`: the lateral push, the lift and the
   * roll about the body's own spine.
   *
   * The roll is composed on the right — `pose * roll` — so it turns the body about its own
   * long axis rather than about a world axis, which is what keeps the feet where the solver
   * put them. It fades in with `settle` so a body in flight is not seen to spin.
   *
   * A note for whoever tries the obvious next step: cancelling the solver's rigid tip and
   * letting the death clip lay the body down instead does *not* work, and was measured not
   * to. Two of the four death clips are overlays on a retargeted mocap `death` base whose
   * final frame is a slump rather than a prone body, so with the tip removed those corpses
   * sit up out of the grass with their legs under the terrain — visibly worse than the
   * splayed limbs the clip hold-back produces.
   */
  private resolveCorpse(i: number): void {
    const c = this.corpse;
    if (c.settle <= 0.92) return;

    // Image of the body's own up axis under the pose quaternion — the long axis of a man
    // lying down, since the solver has rotated his spine into the ground plane. Column 1 of
    // the rotation matrix, projected to the ground.
    const ax = 2 * (c.qx * c.qy - c.qz * c.qw);
    const az = 2 * (c.qx * c.qw + c.qy * c.qz);
    let len = Math.hypot(ax, az);
    let ux = 1;
    let uz = 0;
    if (len > 1e-3) { ux = ax / len; uz = az / len; }

    if (!this.corpseNudged[i]) this.resolveCorpseNudge(i, c.x, c.z, ux, uz);
    const o = i * 3;
    c.x += this.corpseNudge[o];
    c.y += this.corpseNudge[o + 1];
    c.z += this.corpseNudge[o + 2];

    const t = Math.min(1, Math.max(0, (c.settle - 0.55) / 0.4));
    const a = this.corpseRoll[i] * t * 0.5;
    const s = Math.sin(a);
    const k = Math.cos(a);
    const qx = c.qx * k + c.qz * s;
    const qy = c.qy * k + c.qw * s;
    const qz = c.qz * k - c.qx * s;
    const qw = c.qw * k - c.qy * s;
    len = Math.hypot(qx, qy, qz, qw) || 1;
    c.qx = qx / len; c.qy = qy / len; c.qz = qz / len; c.qw = qw / len;
  }

  private ensureKit(i: number, def: UnitTypeDef): void {
    if (this.kitReady[i]) return;
    const k = resolveKit(def, this.battle.pool.variant[i], this.kitScratch);
    this.kitLo[i] = k.maskLo;
    this.kitHi[i] = k.maskHi;
    this.kitHiMelee[i] = k.maskHiMelee;
    this.kitCoarse[i] = k.maskCoarse;
    this.kitTunic[i * 3] = k.tunic[0];
    this.kitTunic[i * 3 + 1] = k.tunic[1];
    this.kitTunic[i * 3 + 2] = k.tunic[2];
    this.kitLeg[i * 3] = k.leg[0];
    this.kitLeg[i * 3 + 1] = k.leg[1];
    this.kitLeg[i * 3 + 2] = k.leg[2];
    this.kitEmblem[i] = k.emblem;
    this.kitMetal[i] = k.metal;
    this.kitReady[i] = 1;
  }

  preRender(ctx: EngineContext): void {
    const b = this.battle;
    const p = b.pool;
    const alpha = ctx.time.alpha;
    const cam = ctx.camera;

    for (const row of this.soldierTiers) for (const t of row) t.buf.count = 0;
    for (const t of this.horseTiers) t.buf.count = 0;
    if (this.impostorTier) this.impostorTier.buf.count = 0;

    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const camX = cam.position.x;
    const camY = cam.position.y;
    const camZ = cam.position.z;
    const [d0, d1, d2] = this.lodDist;

    for (const u of b.units) {
      const def = unitType(u.typeId);
      const cav = isCavalry(def);
      const selected = u.selected;
      // Slot stand-off is expressed in *formation* space, so the trig is once per unit rather
      // than 8,600 times a frame. A rank dresses to the unit's front, not to each man's own
      // heading, so this is also the more correct frame to offset in.
      const uc = Math.cos(u.facing);
      const us = Math.sin(u.facing);

      for (const i of u.members) {
        const state = p.state[i] as SoldierState;
        this.ensureKit(i, def);
        b.renderPos(i, alpha, rp);

        let facing = b.renderFacing(i, alpha);
        const dying = state === SoldierState.Dying || state === SoldierState.Dead;

        // ---- corpses ------------------------------------------------------
        // The ragdoll system solves the fall — a verlet body for the deaths nearest the
        // camera and a tip-over for the rest — and publishes a rigid transform. Using it
        // means the corpse lies where the physics put it rather than where a clip guessed,
        // and it is the same call for both of its tiers.
        //
        // Resolved *before* the cull and before the LOD distance, both of which used to run
        // against the man's pre-death standing position. That was wrong twice over: a body
        // that fell two metres forward was culled by where he was standing, so heaps at the
        // frame edge popped in and out; and the separation grid never saw a corpse that
        // settled off camera, so the next man to die there had nothing to avoid.
        let hasCorpse = false;
        if (dying && this.ragdoll?.getCorpsePose(i, this.corpse)) {
          hasCorpse = true;
          this.resolveCorpse(i);
          rp.x = this.corpse.x;
          rp.y = this.corpse.y;
          rp.z = this.corpse.z;
        } else if (dying && (p.deathDirX[i] !== 0 || p.deathDirZ[i] !== 0)) {
          // No ragdoll available: turn the man so his death clip's own fall direction
          // points where the blow pushed him.
          const target = Math.atan2(-p.deathDirX[i], -p.deathDirZ[i]);
          let d = (target - facing) % (Math.PI * 2);
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          facing += d * Math.min(1, p.animTime[i] * 2.5);
        }

        const dx = rp.x - camX;
        const dy = rp.y + 0.9 - camY;
        const dz = rp.z - camZ;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // ---- LOD with hysteresis ------------------------------------------
        // Bands are [0,d0) [d0,d1) [d1,far) [far,inf). A man only coarsens once he is
        // 12% past an edge and only refines once he is 12% inside it, so a slow camera
        // pan cannot pop a whole rank back and forth across a boundary.
        const edges = this.lodEdges;
        edges[0] = d0; edges[1] = d1; edges[2] = d2;
        let lod = this.lodOf[i];
        while (lod < 3 && dist > edges[lod] * (1 + LOD_HYSTERESIS)) lod++;
        while (lod > 0 && dist < edges[lod - 1] * (1 - LOD_HYSTERESIS)) lod--;
        this.lodOf[i] = lod;

        // ---- cull ---------------------------------------------------------
        // A settled body lies within a metre of the ground and reaches 1.8 m along it, so
        // its bound is centred lower and is wider than a standing man's.
        this.sphere.center.set(rp.x, rp.y + (hasCorpse ? 0.4 : 0.9), rp.z);
        this.sphere.radius = cav ? 1.9 : hasCorpse ? 1.5 : 1.25;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;

        // A settled corpse is drawn one tier coarser than his distance would give. Lying
        // prone he presents no silhouette to preserve — no upright profile, no crest against
        // the sky, nothing a player reads a unit type off — and by the late battle there are
        // a thousand of them under the camera, which was on its own pushing the frame past
        // the triangle budget. The tier he *would* have had stays in `lodOf`, so a corpse
        // the camera walks up to refines exactly as a living man does.
        // Only out of LOD0, and never as far as the impostor tier — that billboard is a
        // standing man and a corpse promoted into it would get up off the ground. Stopping at
        // LOD1 keeps almost all of the saving (4,135 triangles down to 2,314) while never
        // putting a body on the eight-group coarse mesh sooner than distance alone would,
        // because a heap of coarse bodies is what reads as a pile of parts.
        if (hasCorpse && this.corpse.settle > 0.6 && lod === 0) lod = 1;

        // A mounted man never reaches the billboard tier. The impostor sheet is a standing
        // infantryman and no horse is drawn behind it, so a wing crossing that boundary lost
        // its horses and dropped its riders to the ground — a hard pop on the one unit type a
        // player is always watching. Holding cavalry at LOD2 costs about 300 triangles a man
        // over a few hundred men, which is nothing against a 16 M frame.
        if (lod === 3 && cav) lod = 2;

        if (lod === 3) {
          this.pushImpostor(i, rp.x, rp.y, rp.z, facing, u.faction, selected);
          continue;
        }

        const tier = this.soldierTiers[u.faction][lod];
        const coarse = lod === 2;
        let y = rp.y;
        let x = rp.x;
        let z = rp.z;
        let lean = p.lean[i];
        if (cav) {
          const horseClip = this.horseCur[i] === 255 ? HORSE_GAIT_LADDER[0] : this.horseCur[i];
          const hf = this.horseFacts[horseClip];
          const hFrame = Math.min(hf.frames - 1, Math.floor(this.phase[i] * hf.frames));
          const seat = (hf.rowBase + hFrame) * 3;
          this.pushHorse(i, lod, rp.x, rp.y + HORSE_GROUND_LIFT, rp.z, facing, hf);
          // A body the ragdoll has thrown is on the ground where the solver put it; adding a
          // saddle height to that is how a dead cavalryman came to lie in mid-air.
          if (!hasCorpse) {
            const sc = p.scale[i] * this.heightMul[i];
            // Seat the rider *on* the saddle: put his own pelvis at the saddle's animated
            // height plus a hip's clearance, rather than putting his boots there — which is
            // what adding a rest-pose saddle height to a mesh whose origin is the ground did,
            // and it left him a measured 0.95 m in the air.
            y += HORSE_GROUND_LIFT + this.saddleTrack[seat + 1] + SEAT_RISE
              - this.riderSeatY[this.curClip[i]] * sc;
            // And back onto the seat: the saddle sits 0.15 m behind the withers while a man's
            // rig has his pelvis at z = 0, so without this he rides the horse's shoulders.
            const dz = this.saddleTrack[seat + 2] - this.riderSeatZ[this.curClip[i]] * sc;
            x += Math.sin(facing) * dz;
            z += Math.cos(facing) * dz;
            lean += 0.06;
          }
        } else if (!hasCorpse) {
          // Ragged ranks. See SLOT_LATERAL: visual only, stable per man, and the straggle
          // term scales with his speed so a halted formation still dresses its line.
          const o = i * 3;
          const vx = p.vx[i];
          const vz = p.vz[i];
          const lat = this.slotOff[o];
          const along = this.slotOff[o + 1]
            + this.slotOff[o + 2] * Math.min(1, Math.sqrt(vx * vx + vz * vz) * 0.6);
          x += lat * uc + along * us;
          z += -lat * us + along * uc;
        }
        this.pushSoldier(tier, i, x, y, z, facing, lean, state, selected, coarse, hasCorpse);
      }
    }

    this.flush();
    if (!this.warmed) {
      this.warmed = true;
      this.prewarm(ctx);
    }
  }

  private pushSoldier(
    tier: Tier,
    i: number,
    x: number, y: number, z: number,
    facing: number,
    lean: number,
    state: SoldierState,
    selected: boolean,
    coarse: boolean,
    hasCorpse: boolean
  ): void {
    const buf = tier.buf;
    const n = buf.count;
    if ((n + 1) * Stride.Pos > buf.pos.length) return;
    const p = this.battle.pool;

    buf.pos[n * 3] = x;
    buf.pos[n * 3 + 1] = y;
    buf.pos[n * 3 + 2] = z;

    // Corpse hash, wanted three times below: for what he has dropped and for how flat he
    // settles. Resolved from `variant` so none of it ever flickers.
    const seed = hasCorpse ? Math.floor(p.variant[i] * 16777216) : 0;

    const o = n * Stride.Orient;
    buf.orient[o] = facing;
    buf.orient[o + 1] = p.scale[i] * this.heightMul[i];
    // The lean lane doubles as the corpse squash — see the corpse branch in skinShader.ts.
    // Ramped over the second half of the fall so a body compresses as it comes to rest rather
    // than deflating the moment it is hit.
    if (hasCorpse) {
      const t = Math.min(1, Math.max(0, (this.corpse.settle - 0.35) / 0.5));
      const target = 0.66 + hash01(seed, 88) * 0.22;
      buf.orient[o + 2] = 1 - (1 - target) * t;
    } else {
      buf.orient[o + 2] = lean;
    }
    buf.orient[o + 3] = p.grime[i];

    const q = n * Stride.Quat;
    if (hasCorpse) {
      buf.quat[q] = this.corpse.qx;
      buf.quat[q + 1] = this.corpse.qy;
      buf.quat[q + 2] = this.corpse.qz;
      buf.quat[q + 3] = this.corpse.qw;
    } else {
      buf.quat[q] = 0; buf.quat[q + 1] = 0; buf.quat[q + 2] = 0; buf.quat[q + 3] = 0;
    }

    // A settling corpse holds its death clip part-way into the fall. The ragdoll owns the
    // tipping over, so running the clip all the way to its own prone pose as well would fold
    // the body twice — but holding it at the very start leaves a rigid standing man laid on
    // his side, and a heap of those reads as scaffolding rather than as dead men. A third of
    // the clip gets the arms down, the knees soft and the spine curled before the solver's
    // orientation is applied on top.
    const holdBack = hasCorpse ? 1 - 0.62 * Math.min(1, this.corpse.settle) : 1;
    this.writeAnim(buf.animA, buf.animB, n, i, this.manFacts, p.variant[i], holdBack);

    // Melee variant swaps the missile in the hand for the drawn blade; a routing man
    // throws his shield and his javelins away. The far tier takes the eight-group mask
    // instead, because its geometry is built to that vocabulary.
    // What a corpse has let go of. Resolved from his stable hash so it never flickers, and
    // only once he is down: a man mid-fall still has his shield on his arm.
    const settled = hasCorpse && this.corpse.settle > 0.75;
    const dropShield = settled && hash01(seed, 86) < 0.58;
    const dropHelm = settled && hash01(seed, 87) < 0.16;

    const k = n * Stride.Kit;
    if (coarse) {
      let c = this.kitCoarse[i];
      if (dropShield) c &= ~CORPSE_DROP_COARSE;
      if (dropHelm) c &= ~CORPSE_DROP_COARSE_HELM;
      buf.kit[k] = c;
      buf.kit[k + 1] = 0;
    } else {
      const melee = state === SoldierState.Fighting || state === SoldierState.Staggered ||
        (p.animClip[i] >= Clip.AttackOverhead && p.animClip[i] <= Clip.Parry);
      let hi = melee ? this.kitHiMelee[i] : this.kitHi[i];
      if (state === SoldierState.Routing) hi = this.kitHi[i] & ~ROUT_DROP_HI;
      let lo = this.kitLo[i];
      if (dropShield) hi &= ~CORPSE_DROP_HI;
      if (dropHelm) lo &= ~CORPSE_DROP_LO;
      buf.kit[k] = lo;
      buf.kit[k + 1] = hi;
    }

    const c = n * Stride.Col0;
    const boost = selected ? 1.35 : 1;
    buf.col0[c] = this.kitTunic[i * 3] * boost;
    buf.col0[c + 1] = this.kitTunic[i * 3 + 1] * boost;
    buf.col0[c + 2] = this.kitTunic[i * 3 + 2] * boost;
    buf.col0[c + 3] = this.kitEmblem[i];
    buf.col1[c] = this.kitLeg[i * 3];
    buf.col1[c + 1] = this.kitLeg[i * 3 + 1];
    buf.col1[c + 2] = this.kitLeg[i * 3 + 2];
    buf.col1[c + 3] = this.kitMetal[i];

    buf.count = n + 1;
  }

  private pushHorse(
    i: number,
    lod: number,
    x: number, y: number, z: number,
    facing: number,
    facts: ClipFacts
  ): void {
    const tier = this.horseTiers[lod];
    const buf = tier.buf;
    const n = buf.count;
    if ((n + 1) * Stride.Pos > buf.pos.length) return;
    const p = this.battle.pool;

    buf.pos[n * 3] = x;
    buf.pos[n * 3 + 1] = y;
    buf.pos[n * 3 + 2] = z;
    const o = n * Stride.Orient;
    buf.orient[o] = facing;
    buf.orient[o + 1] = 1;
    buf.orient[o + 2] = 0;
    buf.orient[o + 3] = p.grime[i] * 0.5;

    const ph = this.phase[i];
    const f = ph * facts.frames;
    const f0 = Math.floor(f) % facts.frames;
    const f1 = facts.loop ? (f0 + 1) % facts.frames : Math.min(f0 + 1, facts.frames - 1);
    const a = n * Stride.AnimA;
    buf.animA[a] = facts.rowBase + f0;
    buf.animA[a + 1] = facts.rowBase + f1;
    buf.animA[a + 2] = f - Math.floor(f);
    buf.animA[a + 3] = this.horseBlend[i];
    // The gait being left behind. The lane was already uploaded and was being filled with a
    // copy of the current frame, so a change of gait cut hard from one leg position to
    // another — the most obvious pop a cavalry wing had. Costs nothing extra to blend.
    const pf = this.horseFacts[this.horsePrev[i]] ?? facts;
    const pfr = this.horsePrevPhase[i] * pf.frames;
    const p0 = Math.min(pf.frames - 1, Math.floor(pfr));
    const p1 = pf.loop ? (p0 + 1) % pf.frames : Math.min(p0 + 1, pf.frames - 1);
    buf.animB[a] = pf.rowBase + p0;
    buf.animB[a + 1] = pf.rowBase + p1;
    buf.animB[a + 2] = pfr - Math.floor(pfr);
    buf.animB[a + 3] = p.variant[i];

    const k = n * Stride.Kit;
    buf.kit[k] = HORSE_MASK_LO;
    buf.kit[k + 1] = 0;

    // Coat colour from the man's stable hash: bay, chestnut, dark bay or grey. Roman
    // remount depots bought whatever the province bred, so a wing is never one colour.
    const v = p.variant[i];
    const coat = v < 0.34
      ? [0.28, 0.13, 0.06]
      : v < 0.62
        ? [0.42, 0.2, 0.08]
        : v < 0.84
          ? [0.11, 0.08, 0.07]
          : [0.55, 0.54, 0.52];
    const c = n * Stride.Col0;
    buf.col0[c] = coat[0];
    buf.col0[c + 1] = coat[1];
    buf.col0[c + 2] = coat[2];
    buf.col0[c + 3] = 0;
    // Mane and tail: usually darker than the coat, black on a bay.
    buf.col1[c] = coat[0] * 0.45;
    buf.col1[c + 1] = coat[1] * 0.45;
    buf.col1[c + 2] = coat[2] * 0.5;
    buf.col1[c + 3] = 0.5;
    buf.count = n + 1;
  }

  private pushImpostor(
    i: number,
    x: number, y: number, z: number,
    facing: number,
    faction: Faction,
    selected: boolean
  ): void {
    const tier = this.impostorTier;
    if (!tier) return;
    const buf = tier.buf;
    const n = buf.count;
    if ((n + 1) * Stride.Pos > buf.pos.length) return;
    const p = this.battle.pool;
    buf.pos[n * 3] = x;
    buf.pos[n * 3 + 1] = y;
    buf.pos[n * 3 + 2] = z;
    const o = n * Stride.Orient;
    buf.orient[o] = facing;
    buf.orient[o + 1] = p.scale[i] * this.heightMul[i];
    buf.orient[o + 2] = 0;
    buf.orient[o + 3] = p.grime[i];
    const c = n * Stride.Col0;
    const boost = selected ? 1.3 : 1;
    buf.col0[c] = this.kitTunic[i * 3] * boost;
    buf.col0[c + 1] = this.kitTunic[i * 3 + 1] * boost;
    buf.col0[c + 2] = this.kitTunic[i * 3 + 2] * boost;
    buf.col0[c + 3] = faction === Faction.Rome ? 0 : 1;
    buf.count = n + 1;
  }

  /** Fill the two animation attribute slots for a man. */
  private writeAnim(
    animA: Float32Array,
    animB: Float32Array,
    n: number,
    i: number,
    facts: ClipFacts[],
    variant: number,
    phaseScale = 1
  ): void {
    const cur = facts[this.curClip[i]] ?? facts[0];
    const ph = this.phase[i] * phaseScale;
    const f = ph * cur.frames;
    const f0 = Math.min(cur.frames - 1, Math.floor(f));
    const f1 = cur.loop ? (f0 + 1) % cur.frames : Math.min(f0 + 1, cur.frames - 1);
    const a = n * Stride.AnimA;
    animA[a] = cur.rowBase + f0;
    animA[a + 1] = cur.rowBase + f1;
    animA[a + 2] = f - Math.floor(f);
    animA[a + 3] = this.blend[i];

    const prev = facts[this.prevClip[i]] ?? cur;
    const pf = this.prevPhase[i] * prev.frames;
    const p0 = Math.min(prev.frames - 1, Math.floor(pf));
    const p1 = prev.loop ? (p0 + 1) % prev.frames : Math.min(p0 + 1, prev.frames - 1);
    animB[a] = prev.rowBase + p0;
    animB[a + 1] = prev.rowBase + p1;
    animB[a + 2] = pf - Math.floor(pf);
    animB[a + 3] = variant;
  }

  private flush(): void {
    const push = (t: Tier, full: boolean): void => {
      const n = t.buf.count;
      t.geometry.instanceCount = n;
      t.mesh.visible = n > 0;
      if (n === 0) return;
      const mark = (a: THREE.InstancedBufferAttribute, stride: number): void => {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * stride);
        a.needsUpdate = true;
      };
      mark(t.attrs.pos, Stride.Pos);
      mark(t.attrs.orient, Stride.Orient);
      mark(t.attrs.col0, Stride.Col0);
      if (full) {
        mark(t.attrs.animA, Stride.AnimA);
        mark(t.attrs.animB, Stride.AnimB);
        mark(t.attrs.kit, Stride.Kit);
        mark(t.attrs.col1, Stride.Col1);
        mark(t.attrs.quat, Stride.Quat);
      }
    };
    for (const row of this.soldierTiers) for (const t of row) push(t, true);
    for (const t of this.horseTiers) push(t, true);
    if (this.impostorTier) push(this.impostorTier, false);
  }

  dispose(): void {
    for (const row of this.soldierTiers) for (const t of row) t.geometry.dispose();
    for (const t of this.horseTiers) t.geometry.dispose();
    this.impostorTier?.geometry.dispose();
    this.impostorMat?.dispose();
    this.impostors?.dispose();
    for (const m of this.mats) m.dispose();
    this.manAnim.dispose();
    this.horseAnim.dispose();
    this.atlas.dispose();
    this.group.removeFromParent();
  }
}
