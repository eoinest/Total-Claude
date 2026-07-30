import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { Clip, Faction, SoldierState, type UnitTypeDef } from '../sim/types';
import { unitType, isCavalry } from './roster';
import {
  MAN_CLIP_SET, HORSE_CLIP_SET, FOOT_CLIP_MAP, RIDE_CLIP_MAP, HORSE_CLIP_MAP,
} from '../anim/clips';
import { bakeAnimTexture, type AnimTexture } from '../anim/animTexture';
import { makeSoldierMaterial, type SoldierMaterialSet } from '../anim/skinShader';
import { buildSoldierAtlas, EMBLEM_ORIGIN, EMBLEM_TILE, type SoldierAtlas } from './atlas';
import { buildSoldierGeometry, type Lod } from './soldierMesh';
import { buildHorseGeometry, saddleOffset, HORSE_MASK_LO } from './horseMesh';
import { resolveKit, emptyKit, ROUT_DROP_HI, type ResolvedKit } from './kit';
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

/** Clips whose timing belongs to the simulation, not the renderer. */
const SIM_DRIVEN = new Set([
  'attackThrust', 'attackOverhead', 'attackSlash', 'shieldBash', 'block', 'parry',
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
  private kitWear!: Float32Array;
  private kitReady!: Uint8Array;
  private typeIndex!: Int32Array;

  private types: UnitTypeDef[] = [];
  private typeIsCav: boolean[] = [];
  private manFacts!: ClipFacts[];
  private horseFacts!: ClipFacts[];
  private saddle = { y: 1.3, z: 0 };
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
    this.saddle = saddleOffset();

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
    this.kitWear = new Float32Array(cap);
    this.kitReady = new Uint8Array(cap);
    this.typeIndex = new Int32Array(cap).fill(-1);

    const baseParams: THREE.MeshStandardMaterialParameters = {
      map: this.atlas.albedo,
      normalMap: this.atlas.normal,
      roughnessMap: this.atlas.orm,
      metalnessMap: this.atlas.orm,
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
      geometry.setAttribute('iCol1', one([...kit.leg, kit.wear], 4));
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
   * Locomotion rate comes from his actual ground speed divided by the clip's measured
   * stride speed, which is what makes feet stay planted. The rate is clamped: the source
   * gallop under-reaches badly and letting the ratio run free would spin a horse's legs
   * into a blur, which reads far worse than a little slide.
   */
  private advancePlayheads(dt: number, ctx: EngineContext): void {
    const p = this.battle.pool;
    const n = p.count;
    for (let i = 0; i < n; i++) {
      const state = p.state[i] as SoldierState;
      if (state === SoldierState.Dead) continue;

      const cav = this.isCavalry(i);
      const map = cav ? RIDE_CLIP_MAP : FOOT_CLIP_MAP;
      const want = map[p.animClip[i]] ?? map[Clip.IdleAlert];
      if (this.curClip[i] !== want) {
        if (this.curClip[i] !== 255) {
          this.prevClip[i] = this.curClip[i];
          this.prevPhase[i] = this.phase[i];
          this.blend[i] = 0;
        } else {
          this.prevClip[i] = want;
          this.blend[i] = 1;
        }
        this.curClip[i] = want;
        const f = this.manFacts[want];
        // Locomotion resumes mid-cycle so a stop-start never resets the gait; everything
        // else starts from the top so a strike begins with its wind-up.
        if (f.rootSpeed === 0) this.phase[i] = 0;
      }

      const facts = this.manFacts[this.curClip[i]];
      if (facts.simDriven) {
        // The sim owns this one: a blow has to land on the frame the combat system timed
        // it to, and a corpse has to reach the ground when the ragdoll says it has.
        this.phase[i] = facts.loop ? p.animTime[i] % 1 : Math.min(1, p.animTime[i]);
      } else {
        let rate = facts.invDuration;
        if (facts.rootSpeed > 0) {
          const speed = Math.hypot(p.vx[i], p.vz[i]);
          rate = Math.min(1.9, Math.max(0.55, speed / facts.rootSpeed)) * facts.invDuration;
        }
        this.phase[i] = (this.phase[i] + dt * rate * p.animRate[i]) % 1;
      }
      if (this.blend[i] < 1) {
        // 0.16 s cross-fade: long enough to hide a pose change, short enough that a blow
        // still lands on its hit frame.
        this.blend[i] = Math.min(1, this.blend[i] + dt / 0.16);
        const pf = this.manFacts[this.prevClip[i]];
        const prate = pf.rootSpeed > 0 ? pf.invDuration : pf.invDuration;
        if (pf.loop) this.prevPhase[i] = (this.prevPhase[i] + dt * prate * p.animRate[i]) % 1;
      }
    }
    void ctx;
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
    this.kitWear[i] = k.wear;
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

      for (const i of u.members) {
        const state = p.state[i] as SoldierState;
        this.ensureKit(i, def);
        b.renderPos(i, alpha, rp);

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
        this.sphere.center.set(rp.x, rp.y + 0.9, rp.z);
        this.sphere.radius = cav ? 1.9 : 1.25;
        if (!this.frustum.intersectsSphere(this.sphere)) continue;

        let facing = b.renderFacing(i, alpha);
        const dying = state === SoldierState.Dying || state === SoldierState.Dead;

        // ---- corpses ------------------------------------------------------
        // The ragdoll system solves the fall — a verlet body for the deaths nearest the
        // camera and a tip-over for the rest — and publishes a rigid transform. Using it
        // means the corpse lies where the physics put it rather than where a clip guessed,
        // and it is the same call for both of its tiers.
        let hasCorpse = false;
        if (dying && this.ragdoll?.getCorpsePose(i, this.corpse)) {
          hasCorpse = true;
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

        if (lod === 3) {
          this.pushImpostor(i, rp.x, rp.y, rp.z, facing, u.faction, selected);
          continue;
        }

        const tier = this.soldierTiers[u.faction][lod];
        const coarse = lod === 2;
        let y = rp.y;
        let lean = p.lean[i];
        if (cav) {
          const horseClip = HORSE_CLIP_MAP[p.animClip[i]] ?? HORSE_CLIP_MAP[Clip.IdleAlert];
          const hf = this.horseFacts[horseClip];
          const hFrame = Math.min(hf.frames - 1, Math.floor(this.phase[i] * hf.frames));
          const hClip = HORSE_CLIP_SET.clips[horseClip];
          // Seat the rider on the saddle and let him rise and fall with the horse's back.
          y += this.saddle.y + hClip.rootT[hFrame * 3 + 1];
          this.pushHorse(i, lod, rp.x, rp.y, rp.z, facing, horseClip, hf);
          lean += 0.06;
        }
        this.pushSoldier(tier, i, rp.x, y, rp.z, facing, lean, state, selected, coarse, hasCorpse);
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

    const o = n * Stride.Orient;
    buf.orient[o] = facing;
    buf.orient[o + 1] = p.scale[i];
    buf.orient[o + 2] = lean;
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

    // A settling corpse holds its death clip near the start of the fall. The ragdoll owns
    // the tipping over, so letting the clip run all the way to its own prone pose as well
    // would fold the body twice.
    const holdBack = hasCorpse ? 1 - 0.86 * Math.min(1, this.corpse.settle) : 1;
    this.writeAnim(buf.animA, buf.animB, n, i, this.manFacts, p.variant[i], holdBack);

    // Melee variant swaps the missile in the hand for the drawn blade; a routing man
    // throws his shield and his javelins away. The far tier takes the eight-group mask
    // instead, because its geometry is built to that vocabulary.
    const k = n * Stride.Kit;
    if (coarse) {
      buf.kit[k] = this.kitCoarse[i];
      buf.kit[k + 1] = 0;
    } else {
      const melee = state === SoldierState.Fighting || state === SoldierState.Staggered ||
        (p.animClip[i] >= Clip.AttackOverhead && p.animClip[i] <= Clip.Parry);
      let hi = melee ? this.kitHiMelee[i] : this.kitHi[i];
      if (state === SoldierState.Routing) hi = this.kitHi[i] & ~ROUT_DROP_HI;
      buf.kit[k] = this.kitLo[i];
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
    buf.col1[c + 3] = this.kitWear[i];

    buf.count = n + 1;
  }

  private pushHorse(
    i: number,
    lod: number,
    x: number, y: number, z: number,
    facing: number,
    clipIndex: number,
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
    buf.animA[a + 3] = 1;
    buf.animB[a] = facts.rowBase + f0;
    buf.animB[a + 1] = facts.rowBase + f0;
    buf.animB[a + 2] = 0;
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
    void clipIndex;
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
    buf.orient[o + 1] = p.scale[i];
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
