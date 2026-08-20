import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import type { ProjectileSystem } from '../sim/Projectiles';
import {
  ALL_FACTIONS, Clip, Faction, SoldierState, type UnitGroupState, type UnitTypeDef,
} from '../sim/types';
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
import { buildSoldierAtlas, EMBLEM_COLS, EMBLEM_ORIGIN, EMBLEM_TILE, type SoldierAtlas } from './atlas';
import { buildSoldierGeometry, type Lod } from './soldierMesh';
import {
  buildHorseGeometry, HORSE_MASK_LO, SADDLE_BONES, SADDLE_SEAT, HORSE_GROUND_LIFT,
} from './horseMesh';
import {
  buildElephantGeometry, ELEPHANT_GROUND_LIFT, ELEPHANT_MASK_LO,
  HOWDAH, HOWDAH_BONES, HOWDAH_STATIONS, MAHOUT_BONES, MAHOUT_SEAT,
} from './elephantMesh';
import {
  ELEPHANT_CLIP, ELEPHANT_CLIP_SET, ELEPHANT_GAIT_LADDER, ELEPHANT_GAIT_STRIDE,
  ELEPHANT_IDLE_EDGE,
} from '../anim/elephantClips';
import {
  resolveKit, emptyKit, ROUT_DROP_HI, CORPSE_DROP_HI, CORPSE_DROP_LO,
  CORPSE_DROP_COARSE, CORPSE_DROP_COARSE_HELM, Piece, ridesElephant,
  EMBLEM_TRIBAL_FIRST, EMBLEM_PUNIC_FIRST, type ResolvedKit,
} from './kit';
import {
  renderImpostorAtlas, buildImpostorGeometry, makeImpostorMaterial, type ImpostorAtlas,
} from './impostor';
import { buildScorpioGeometry, buildOnagerGeometry } from './engineMesh';
import { makeEngineMaterial, type EngineMaterialSet } from './engineMaterial';
import {
  ABANDONED, CREW_OF, FORWARD_OF, PITCH_OF, STATIONS_OF, EngineKind, armStateOf,
  crewClip, engineAnchor, engineKindOf, enginePose, emptyPose, initialSinceShot, isEngineUnit,
  onArmTip, sliderZOf, stationJitter, SILHOUETTE_OF,
  type EnginePose,
} from './engines';
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
 *   3 factions x 3 mesh LODs   = 9
 *   1 horse mesh x 3 LODs      = 3   (every faction rides the same animal)
 *   1 war elephant, no LODs    = 1
 *   1 impostor billboard sheet = 1
 *                              = 14 allocated, but that is not what is drawn.
 *
 * **A tier with no instances is hidden, so the budget is spent on what is on screen and not
 * on what exists.** `flush` sets `mesh.visible = count > 0` every frame, so a battle only
 * pays for the factions actually deployed: Rome against the Juthungi draws the same 10 it
 * always did, and Rome against Carthage draws 11 — three Roman tiers, three Punic, three
 * horse, the elephant, and the impostor sheet. Both are inside the 12 the architecture
 * budgets. Three factions at once cannot occur in a scenario, and `tools/probe-draws.mjs`
 * measures the realised figure rather than this one.
 *
 * ## Why the renderer keeps its own playhead
 * `pool.animTime` advances at roughly one cycle per second whatever the clip is, because
 * the sim has no clip table to consult. That is fine for a one-shot but wrong for
 * everything else: an idle breathes at three times life, and a marching man's feet skate
 * because his stride is not his ground speed. So for looping clips this system runs its
 * own phase, advanced by `groundSpeed / (clip.rootSpeed * scale)` for locomotion and
 * `1 / duration` otherwise. One-shot clips (the four deaths) still read `pool.animTime`
 * directly, because the sim flips Dying to Dead when that reaches 1 and the pose must
 * arrive with it.
 *
 * ## Mounted men
 * A rider is two instances that have to agree to the centimetre. The horse owns the shared
 * gait phase — chosen from a speed ladder and advanced at `groundSpeed / stride`, so a hoof
 * never skates — and the rider is placed against the saddle's *animated* height, baked per
 * animation row by `bakePointTrack`, less the mean pelvis height of his own clip. That
 * decomposition is what matters: the saddle track carries the horse's back rising and falling
 * through a gallop, and subtracting a per-clip mean rather than a per-frame value leaves the
 * rider's own rise out of the saddle intact on top of it.
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
 *
 * The middle edge was 0.5, and that is where the triangle budget was going. Measured at the
 * `cavalry` camera by `tools/probe-rider.mjs --lod`, which reports instance counts per tier:
 *
 *     edge   LOD0   LOD1   LOD2   soldier tris   whole frame
 *     0.50    218   1950   2947      6.30 M        19.6 M
 *     0.40    218    ~900  ~3900     ~4.3 M        13.6 M
 *     0.34    218    420   4477      3.40 M        11.5 M
 *
 * LOD1 is 2,012-2,314 triangles against LOD2's 313, so a man who crosses that edge gets
 * seven times cheaper — which is why nineteen hundred of them at LOD1 were most of the frame.
 * At 0.40 x 220 m the edge is 88 m, where a 1.75 m man is 35 px tall at 1080p, and comparing
 * frames at 0.34, 0.40 and 0.50 across establishing, cavalry, romanline, germanhorde, clash
 * and melee found no visible difference at all: germanhorde and clash are byte-identical
 * because every man in them is inside 88 m either way. 0.40 rather than 0.34 only because it
 * keeps a marginal 10 m of real geometry for nothing at 1080p.
 */
export const LOD_FRACTION = [0.14, 0.4, 2.0];

/** A standing man, metres. The height every screen-space threshold below is measured against. */
const MAN_HEIGHT_M = 1.75;

/**
 * Pixel height below which a man stops being a figure and becomes a smudge, and therefore
 * the height at which it is safe to swap him for a billboard.
 *
 * 4.5 px at 1080p and a 43 degree lens puts the edge at 526 m. Above this the impostor is
 * indistinguishable from the mesh; below it, the swap is what made a whole army vanish under
 * its own banners at the `high` tier.
 */
const IMPOSTOR_MIN_PX = 4.5;

/**
 * Metres of slop added to the per-instance cull sphere, purely so shadows survive it.
 *
 * The cull below is against the camera frustum and a culled man is never written to any
 * instance buffer, so he is absent from the shadow cascades as well as from the colour
 * pass. With the sun at 27 deg a 1.8 m man throws 3.5 m of shadow, so a man up to that far
 * outside the frustum still owns pixels inside it. 4.5 m covers the lowest sun the presets
 * reach with margin, and admits well under 1 % extra instances at any battle camera.
 */
const SHADOW_CULL_MARGIN = 4.5;
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

/**
 * Ceiling on machines drawn at once. Four batteries of four is sixteen; sixty-four leaves
 * room for a scenario that fields artillery seriously and still costs one 3 KB buffer.
 */
const MAX_ENGINES = 64;

/** Muzzle velocity of a bolt, m/s, and gravity — for the elevation solution. Mirrors
 *  `PHYSICS.bolt.speed` and `GRAVITY` in `sim/Projectiles.ts`; visual only, so a drift
 *  between the two moves the barrels a degree and nothing else. */
const BOLT_SPEED = 78;
const GRAVITY = 9.81;
/** Elevation with no target: wound and laid on the approach, not stowed flat. */
const ELEV_IDLE = 0.05;

/**
 * One battery's worth of machine state, held by the renderer because the simulation has no
 * concept of a machine. Keyed by unit id and allocated on first sight.
 */
interface Battery {
  kind: EngineKind;
  /** Men to a machine, and metres between machines, for this kind. */
  crew: number;
  pitch: number;
  forward: number;
  count: number;
  /** Seconds since each engine last let go. */
  sinceShot: Float32Array;
  /** Total ammunition across each engine's crew last frame; a fall means it shot. */
  lastAmmo: Int32Array;
  /** Barrel elevation, radians, eased toward the range solution. */
  elev: number;
  /** Seconds until the target range is resolved again. */
  aimTimer: number;
  /**
   * Per-engine yaw. `restJit` is the fixed stand-off a gun sits at when it has nothing to shoot
   * at — no two pieces in a battery are laid on quite the same bearing — and `yawJit` is the
   * live bearing, eased toward the target by `traverseOnto` and back to `restJit` when the
   * target is lost.
   */
  yawJit: Float32Array;
  restJit: Float32Array;
  variant: Float32Array;
}

interface EngineTier {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attrs: {
    pos: THREE.InstancedBufferAttribute;
    orient: THREE.InstancedBufferAttribute;
    state: THREE.InstancedBufferAttribute;
  };
  pos: Float32Array;
  orient: Float32Array;
  state: Float32Array;
  count: number;
}

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
 * Where the tower crew go when the animal goes down, as fractions of the death clip.
 *
 * **Exported, and `src/viewer/` imports them.** They used to be module-private and the model
 * viewer carried a hand-copied set with a comment saying so. One of them had already drifted:
 * `soldierRig.ts` held `CREW_FALL_SIDE = +1` against this file's `-1`, so every carcass frame
 * ever shot in the viewer threw the crew onto the flank the animal rolls *away* from — the
 * exact sign the note below spends two paragraphs establishing. A grade mirror in that same
 * page drifted once before and shipped every model plate at the wrong film grain.
 *
 * A Punic elephant carries a mahout astride the neck and three men in a crenellated tower
 * 3.06 m up. The animal's fall is 2.6 s and the men are not passengers in it: the forelegs
 * buckle first, the whole platform pitches forward, and they are thrown off it. So they
 * hold on while it pitches (the howdah track already carries them down, because it is baked
 * over the death rows like every other row), let go at `CREW_THROW_START`, and are on the
 * ground by `CREW_THROW_START + CREW_THROW_LEN` — a second before the animal has finished
 * settling, which is the right order: the crew land, then the beast comes to rest beside
 * them.
 */
export const CREW_THROW_START = 0.28;
export const CREW_THROW_LEN = 0.22;
/** Peak of the thrown crewman's arc above the straight line from tower to ground, metres. */
export const CREW_THROW_ARC = 0.55;
/**
 * How far from the animal's spine a thrown crewman lands, metres, before his own scatter.
 *
 * Outside the carcass capsule in `BattleSystem` (1.30 m) so a body does not lie inside the
 * animal, and inside the distance at which he would read as belonging to some other death.
 */
export const CREW_LAND_OUT = 1.95;
/**
 * The side the animal rolls onto, as a sign on the model's own +X axis.
 *
 * **Derived from the clip's kinematics, not from the sign of its root key**, because the two
 * disagree. This was `+1`, read off "the root rolls from 0 to +78 degrees" and glossed as
 * "its right"; a roll about the forward axis moves +X up or down depending on the rig's
 * handedness, and here it moves it *up*. `tools/scratch/elepose-side.mjs` runs the death
 * clip's own forward kinematics and prints every bone: at the last frame `earL` finishes at
 * y 1.175 and `earR` at y 0.297, `fShoulderL` 1.353 against `fShoulderR` 0.204, `bHipL`
 * 1.517 against `bHipR` 0.407. The whole right side is on the ground and the spine has moved
 * to −X while the folded legs point +X, so **the tower goes down on −X** and a man thrown out
 * of it goes with it.
 *
 * At +1 the crew were thrown onto the belly side, into the folded legs and the raised flank —
 * i.e. onto the part of the animal still in the air. Nobody caught it because the render-side
 * death turn above used to spin the whole animal up to 180 degrees, which cancelled the error
 * exactly whenever the killing blow came from ahead or astern and left it arbitrary otherwise.
 *
 * Hard coupling to one authored clip, so it lives next to the throw constants and not inside
 * the loop that uses it: if that clip is ever re-authored to fall the other way, this is the
 * one line that moves with it, and the script above is how to tell which way it now falls.
 */
export const CREW_FALL_SIDE = -1;
/**
 * Lift on a landed crewman's mesh origin, metres.
 *
 * The same 0.15 m `RagdollSystem.writeCheapPose` gives a settled corpse. A death clip ends
 * with its root well below the standing pose and the tip quaternion turns most of that drop
 * into a horizontal displacement; the remainder is what this covers. Matching the ragdoll's
 * own figure rather than picking a new one means a crewman lying beside the animal reads at
 * the same height as the men who killed it lying next to him.
 */
export const CREW_GROUND_LIFT = 0.15;

/** Scratch for the thrown crew's lie-down quaternion. Four men per animal per frame. */
const qCrew = new THREE.Quaternion();
const qCrewTip = new THREE.Quaternion();
const vCrewAxis = new THREE.Vector3();
const AXIS_UP = new THREE.Vector3(0, 1, 0);

/**
 * Bone chains and pivots the per-man pose variation acts on, read off the man rig itself so
 * a re-bake that reorders bones cannot silently start bending the wrong limb.
 *
 * The chains are contiguous by construction: the rig is topologically sorted and the arms
 * hang off the chest, so `clavL..handL` and `clavR..handR` are each four consecutive
 * indices, and everything from `spineLow` to `handR` is the whole upper body.
 */
export const MAN_POSE_VARY: PoseVaryBones = {
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
  /**
   * The simulation's own engine clock, when there is one.
   *
   * Artillery fires per machine on a deterministic cycle that `ProjectileSystem` owns, so the
   * animation is a read of that rather than a reconstruction of it. See `updateEngines`.
   */
  private projectiles: ProjectileSystem | null = null;
  /**
   * Hold every battery's cycle where the caller put it, for `tools/probe-scorpion.mjs --bench`.
   * A bench plate is a specific point in the cycle photographed from four sides; without this
   * the sim's clock would advance under the settle frame and the four views would be of four
   * different machine states. Not used by the game.
   */
  freezeEngines = false;
  private atlas!: SoldierAtlas;
  private manAnim!: AnimTexture;
  private horseAnim!: AnimTexture;
  private elephantAnim!: AnimTexture;
  private mats: SoldierMaterialSet[] = [];
  /** [faction][lod] */
  private soldierTiers: Tier[][] = [];
  private horseTiers: Tier[] = [];
  /** One tier, no LOD chain — see `elephantMesh.ts` for why. */
  private elephantTier?: Tier;
  private elephantFacts: ClipFacts[] = [];
  /** Animated howdah floor and mahout seat, 3 floats per elephant animation row. */
  private howdahTrack!: Float32Array;
  private mahoutTrack!: Float32Array;
  /** Clip, previous clip and fade per elephant, indexed by the animal's pool slot. */
  private eleCur!: Uint8Array;
  private elePhase!: Float32Array;
  /**
   * How far through its collapse a dead elephant is, 0 to 1 over the death clip's own
   * 2.6 seconds. Its own timer and not `pool.animTime`, for two reasons that both matter.
   *
   * `animTime` is a *man's* playhead: `BattleSystem.stepAnimation` runs it at the man death
   * clip's rate and flips `Dying` to `Dead` when it reaches 1, which it does in about one
   * second. Driving the animal off it crushed a clip authored for four tonnes going down
   * into the time it takes a man to fold at the knees — and worse, it stopped dead at the
   * state change, because `advancePlayheads` skips anything already `Dead`.
   *
   * And it is a *render* clock, advanced in `preRender` from the frame delta, so nothing
   * about how long the animal takes to fall can reach the simulation. The sim's own timing
   * — one second of `Dying`, then `Dead` — is untouched, and the determinism hash with it.
   */
  private eleDeath!: Float32Array;
  /** Gait crossover speeds, m/s. */
  private eleGaitUp: number[] = [];
  /**
   * Kit for the render-only tower crew, resolved once per (unit type, station).
   *
   * Bounded by the number of distinct elephants times four, so a couple of hundred entries
   * at the largest battle the menu can build. `resolveKit` costs about twenty hashes and
   * this would otherwise run four times per animal per frame.
   */
  private crewKit = new Map<string, ResolvedKit>();
  /**
   * Simulation seconds, mirrored each frame.
   *
   * The tower crew have no pool slot and therefore no `animTime` of their own, so their idle
   * has to be driven from somewhere. It is `time.simTime` and explicitly not a wall clock:
   * this is read in a render path that `tools/shoot.mjs` steps deterministically, and
   * `performance.now()` would make two runs of the harness produce different frames of the
   * same battle — which is the sort of thing that is only noticed as a flaky screenshot diff.
   */
  private animClock = 0;
  private impostorTier?: Tier;
  private impostors?: ImpostorAtlas;
  private impostorMat?: THREE.MeshBasicMaterial;
  private group = new THREE.Group();
  /** One tier per `EngineKind`: same material and therefore the same program, own geometry. */
  private engineTiers: (EngineTier | undefined)[] = [];
  private engineMat?: EngineMaterialSet;
  /** Machine state per artillery unit; see `Battery`. */
  private batteries = new Map<number, Battery>();
  private pose: EnginePose = emptyPose();
  private jitter: [number, number, number] = [0, 0, 0];

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
  /** Parallel to `typeIsCav`: this cavalry type rides an elephant rather than a horse. */
  private typeIsElephant: boolean[] = [];
  private typeIsEngine: boolean[] = [];
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
    this.projectiles = ctx.tryGet<ProjectileSystem>('projectiles') ?? null;
    const cap = ctx.quality.maxSoldiers;

    this.atlas = buildSoldierAtlas(Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy()));
    this.manAnim = bakeAnimTexture(MAN_CLIP_SET, 'man');
    this.horseAnim = bakeAnimTexture(HORSE_CLIP_SET, 'horse');
    this.elephantAnim = bakeAnimTexture(ELEPHANT_CLIP_SET, 'elephant');
    this.manFacts = clipFacts(MAN_CLIP_SET);
    this.horseFacts = clipFacts(HORSE_CLIP_SET);
    this.elephantFacts = clipFacts(ELEPHANT_CLIP_SET);

    /**
     * Where the howdah floor and the mahout's seat actually are on every frame.
     *
     * The same decomposition as the saddle, and it exists for the same recorded reason: a
     * rider's boots were once placed *on the saddle* because a 1.490 m rest-pose offset was
     * added to the ground rather than to the mount, leaving him a measured 0.95 m in the air.
     * A tower crew is four men on a platform 3.06 m up and the error would be four times as
     * visible, so neither the crew nor the mahout is ever positioned from a constant: both
     * are placed against the animated height of the point they are standing on.
     */
    this.howdahTrack = bakePointTrack(
      ELEPHANT_CLIP_SET,
      [0, HOWDAH.y, HOWDAH.z],
      HOWDAH_BONES.bone0, HOWDAH_BONES.bone1, HOWDAH_BONES.weight0
    );
    this.mahoutTrack = bakePointTrack(
      ELEPHANT_CLIP_SET,
      [0, MAHOUT_SEAT.y, MAHOUT_SEAT.z],
      MAHOUT_BONES.bone0, MAHOUT_BONES.bone1, MAHOUT_BONES.weight0
    );

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

    /**
     * Elephant gait crossover, by the same geometric-mean rule as the horse.
     *
     * Two rungs, so one crossover. The strides come from `ELEPHANT_GAIT_STRIDE`, which is
     * *measured* off the authored clips by `measureRootSpeed` rather than written down — see
     * the note at the top of `elephantClips.ts`. Writing the crossover as a speed instead
     * would be the horse's skating-hoof defect wearing a different hat.
     */
    this.eleGaitUp = [];
    for (let r = 0; r < ELEPHANT_GAIT_LADDER.length - 1; r++) {
      const slow = ELEPHANT_GAIT_STRIDE[r];
      const fast = ELEPHANT_GAIT_STRIDE[r + 1];
      this.eleGaitUp.push(Math.sqrt(slow * fast));
    }

    this.eleCur = new Uint8Array(cap).fill(255);
    this.elePhase = new Float32Array(cap);
    this.eleDeath = new Float32Array(cap);
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
      /**
       * Half what it was, and the reason is that this term is subtracting from the only
       * light a soldier has.
       *
       * AO attenuates *indirect* light, which is correct. But measured over the Roman line
       * (tools/probe-units.mjs), the median soldier pixel is in shadow — helmet 0.0370
       * display luminance against a whole-frame mean of 0.117 — so indirect is not a small
       * correction on top of the sun, it is very nearly the whole budget. Taking it to zero
       * recovered 27.6% on a helmet and 24.5% on a face; those are large numbers to be
       * spending on crevice definition that is under a pixel at this range.
       *
       * 0.3 keeps the girdle-plate gutters and the mail cavities reading while giving back
       * about half of that. It is not a substitute for the ambient level itself, which is
       * the lighting rig's and is reported separately.
       */
      aoMapIntensity: 0.3,
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
      /*
       * 2.2, not 2.9, and the reason is a rebalance rather than a retreat.
       *
       * `SkySystem.AMBIENT_TRIM` moves 0.60 -> 0.82 in the same pass — the round-one
       * measurement had our p01 luma at 0.029 against the reference's 0.061, i.e. our
       * shadows are twice as deep as the thing we are aiming at, and the trim was where that
       * came from. Soldiers were the one surface already compensating for it locally, at
       * 2.9 x 0.60 = 1.74 effective, so raising the global trim without lowering this would
       * have lit the men and nothing else. 2.2 x 0.82 = 1.80 leaves a man where he was and
       * lets the ground, the masonry and the grass come up to meet him.
       */
      envMapIntensity: 2.2,
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
      emblemCols: EMBLEM_COLS,
      emblemTribalFirst: EMBLEM_TRIBAL_FIRST,
      emblemPunicFirst: EMBLEM_PUNIC_FIRST,
      // Lean ramps in over the full height of a man so his feet stay on the ground.
      leanHeight: 1.5,
      poseVary: MAN_POSE_VARY,
    });
    const horseMat = makeSoldierMaterial(baseParams, {
      anim: this.horseAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      emblemCols: EMBLEM_COLS,
      emblemTribalFirst: EMBLEM_TRIBAL_FIRST,
      emblemPunicFirst: EMBLEM_PUNIC_FIRST,
      leanHeight: 1.7,
    });
    // The elephant gets its own material because it gets its own animation texture — the rig
    // has 31 bones against the horse's 29 and none of the clips are shared. Same program,
    // same uniforms, one more texture: no extra material in the budget's sense.
    const elephantMat = makeSoldierMaterial(baseParams, {
      anim: this.elephantAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      emblemCols: EMBLEM_COLS,
      emblemTribalFirst: EMBLEM_TRIBAL_FIRST,
      emblemPunicFirst: EMBLEM_PUNIC_FIRST,
      // No lean on an animal that weighs four tonnes and does not bank into a turn.
      leanHeight: 3.0,
    });
    this.mats.push(manMat, horseMat, elephantMat);

    for (const faction of ALL_FACTIONS) {
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

    // War elephants. A unit is eight animals at establishment and sixteen at `ultra`, and a
    // scenario could field two units, so 64 is generous by a factor of two.
    this.elephantTier = this.makeTier(
      buildElephantGeometry(), elephantMat, 64, 'war-elephants'
    );

    // Siege engines. One geometry, no LOD chain and no impostor: LOD exists so that
    // thousands of a thing do not cost thousands of times its triangles, and there are at
    // most a couple of dozen machines on the field.
    //
    // Measured: 8.2 k triangles for a scorpio and 4.7 k for an onager, up from 1.1 k each,
    // much of it spent on the torsion skeins — a spring is eleven to thirteen individually
    // modelled cords a lobe instead of one swept tube, because every blind critic of these
    // machines led with the springs being unreadable. The scorpio's later growth is the arm ports
    // cut through the outer posts, the windlass standards, the second ratchet wheel and the cord
    // wrapping each arm butt, all of which answer named faults. A four-gun battery is 33 k
    // triangles and the 64-machine ceiling is 525 k, against a 16 M frame. It is the right thing
    // to spend geometry on: nothing else on the machine is load-bearing for whether it reads as
    // a machine.
    this.engineMat = makeEngineMaterial({
      ...baseParams,
      // Timber and cord are dielectric; only the fittings are metal, and the ORM tile's
      // blue channel already says which is which per texel.
      envMapIntensity: 2.4,
    });
    this.engineTiers[EngineKind.Scorpio] =
      this.makeEngineTier(buildScorpioGeometry(), this.engineMat, 'siege-scorpio');
    this.engineTiers[EngineKind.Onager] =
      this.makeEngineTier(buildOnagerGeometry(), this.engineMat, 'siege-onager');

    ctx.scene.add(this.group);
    this.buildImpostors(ctx, cap);
    this.applyQuality(ctx);
  }

  private makeEngineTier(
    geometry: THREE.InstancedBufferGeometry,
    mat: EngineMaterialSet,
    name: string
  ): EngineTier {
    const pos = new Float32Array(MAX_ENGINES * 3);
    const orient = new Float32Array(MAX_ENGINES * 4);
    const state = new Float32Array(MAX_ENGINES * 4);
    const attr = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs = { pos: attr(pos, 3), orient: attr(orient, 4), state: attr(state, 4) };
    geometry.setAttribute('iPos', attrs.pos);
    geometry.setAttribute('iOrient', attrs.orient);
    geometry.setAttribute('iState', attrs.state);
    geometry.instanceCount = 0;

    const mesh = new THREE.Mesh(geometry, mat.material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    /*
     * A tier cannot be frustum-culled: its instance buffer is refilled against the camera
     * frustum every frame, so the geometry's own bounding sphere describes nothing. That is
     * also why it needs `shadowRadialBand` — `WebGLShadowMap.renderObject` reads exactly this
     * flag before it reads any bound, so without a band the tier is submitted to every
     * cascade whatever that cascade covers.
     */
    mesh.frustumCulled = false;
    // Declared here, filled by `publishBand` every frame. Declaring the key at construction is
    // what lets `LightingSystem` fit the skip hooks on its first traversal instead of on
    // whichever later one first happens to catch a non-empty buffer.
    mesh.userData.shadowRadialBand = undefined;
    mesh.customDepthMaterial = mat.depth;
    mesh.customDistanceMaterial = mat.distance;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, geometry, attrs, pos, orient, state, count: 0 };
  }

  /** Machine state for a unit, allocated on first sight. */
  private batteryOf(u: { id: number; members: number[] }, def: UnitTypeDef): Battery {
    let bat = this.batteries.get(u.id);
    const kind = engineKindOf(def);
    const crew = CREW_OF[kind];
    const want = Math.max(1, Math.round(u.members.length / crew));
    if (bat && bat.count === want && bat.kind === kind) return bat;
    bat = {
      kind,
      crew,
      pitch: PITCH_OF[kind],
      forward: FORWARD_OF[kind],
      count: want,
      // Spread across the cycle rather than all wound and loaded together — see
      // `initialSinceShot`, which is where the reasoning lives.
      sinceShot: new Float32Array(want),
      lastAmmo: new Int32Array(want).fill(-1),
      elev: ELEV_IDLE,
      aimTimer: 0,
      yawJit: new Float32Array(want),
      restJit: new Float32Array(want),
      variant: new Float32Array(want),
    };
    for (let k = 0; k < want; k++) {
      const seed = u.id * 977 + k * 131;
      bat.sinceShot[k] = initialSinceShot(hash01(seed, 153));
      // No two guns in a battery are laid on exactly the same bearing.
      bat.restJit[k] = (hash01(seed, 151) - 0.5) * 0.09;
      bat.yawJit[k] = bat.restJit[k];
      bat.variant[k] = hash01(seed, 152);
    }
    this.batteries.set(u.id, bat);
    return bat;
  }

  /**
   * Advance every battery's cycle, and detect the shot.
   *
   * **The simulation owns this clock now.** `ProjectileSystem` runs a machine-by-machine
   * artillery cycle in `fixedUpdate` and resets `sinceShot` on the exact tick a shot is
   * created, so the animation is a straight read of it and the string cannot let go on a
   * frame the projectile did not leave on.
   *
   * It used to be inferred here, from a fall in the crew's ammunition — the best available
   * answer when the sim fired per man inside a 0.92 s hashed volley window, and wrong in a way
   * that could not be fixed from this side: three crewmen each fired, so one gun's ammunition
   * fell three times per volley and the recoil restarted three times for what should have been
   * one shot. The fallback below is kept for the case where there is no projectile system at
   * all, which is the model viewer.
   *
   * Visual only, and in `update` rather than `fixedUpdate`, so none of it can perturb the
   * simulation's hash.
   */
  private updateEngines(dt: number): void {
    const b = this.battle;
    const p = b.pool;
    for (const u of b.units) {
      const def = unitType(u.typeId);
      if (!isEngineUnit(def)) continue;
      const bat = this.batteryOf(u, def);
      const cycle = this.freezeEngines ? undefined : this.projectiles?.engineCycle(u.id);
      if (cycle && cycle.length === bat.count) {
        bat.sinceShot.set(cycle);
      } else if (!this.freezeEngines) {
        for (let k = 0; k < bat.count; k++) {
          let ammo = 0;
          for (let c = 0; c < bat.crew; c++) {
            const i = u.members[k * bat.crew + c];
            if (i !== undefined && p.aliveAt(i)) ammo += p.ammo[i];
          }
          if (bat.lastAmmo[k] >= 0 && ammo < bat.lastAmmo[k]) bat.sinceShot[k] = 0;
          bat.lastAmmo[k] = ammo;
          bat.sinceShot[k] += dt;
        }
      }

      // Elevation. Re-solved twice a second against the nearest enemy anchor in range, then
      // eased, so a gun visibly comes down onto a closing target instead of snapping.
      bat.aimTimer -= dt;
      if (bat.aimTimer <= 0) {
        bat.aimTimer = 0.5;
        bat.elev = this.elevationFor(u, def);
      }
      this.traverseOnto(u, bat, dt);
    }
  }

  /**
   * Barrel elevation for the nearest enemy the battery could actually be shooting at.
   *
   * The low root of the ballistic quadratic, the same branch `Projectiles.lowRoot` takes for
   * a flat-arc missile — a bolt at 78 m/s needs 7 degrees at 150 m and 14 at 300, which is
   * enough of a spread to be visible along a line of four guns and is the reason to compute
   * it rather than pick a constant.
   */
  private elevationFor(u: UnitGroupState, def: UnitTypeDef): number {
    const range = def.missile?.range ?? 0;
    if (range <= 0) return ELEV_IDLE;
    let best = Infinity;
    for (const e of this.battle.units) {
      if (e.destroyed || e.faction === u.faction || e.alive === 0) continue;
      const dx = e.x - u.x;
      const dz = e.z - u.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
    if (!Number.isFinite(best) || best > range) return ELEV_IDLE;
    const v2 = BOLT_SPEED * BOLT_SPEED;
    const disc = v2 * v2 - GRAVITY * GRAVITY * best * best;
    if (disc <= 0) return 0.5;
    return Math.min(0.42, Math.max(ELEV_IDLE, Math.atan((v2 - Math.sqrt(disc)) / (GRAVITY * best))));
  }

  /**
   * Draw one machine and no others, for `tools/probe-scorpion.mjs`'s bench. Not used by the game.
   *
   * A mechanism plate has to be of one machine. Photographed in place, a battery on 4.4 m centres
   * puts the next gun's arms and tripod inside the subject's own silhouette from every three-
   * quarter angle, and the reference plates this is graded against are single museum
   * reconstructions — so a frame with four overlapping engines in it is not being compared with
   * like. The engines share one `InstancedMesh`, so hiding the neighbours has to happen where the
   * instances are written.
   */
  benchOnly: { unit: number; k: number } | null = null;

  /**
   * Draw the engines as flat per-part colours, for `tools/probe-scorpion.mjs --debugparts`.
   * Not used by the game. See `FRAG_DEBUG` in `engineMaterial.ts` for why it exists.
   */
  debugEngineParts(on: boolean): void {
    this.engineMat?.setDebugParts(on);
  }

  /** Battery state for `tools/probe-scorpion.mjs`. Not used by the game. */
  debugEngines(): unknown {
    const out: unknown[] = [];
    for (const [id, bat] of this.batteries) {
      const u = this.battle.unitById(id);
      if (!u) continue;
      const engines = [];
      for (let k = 0; k < bat.count; k++) {
        const pose = enginePose(bat.sinceShot[k], this.reloadOf(id), this.pose);
        // The articulation, in the machine's own frame. A still cannot answer "does the arm
        // actually move?" — crew animation and cloud shadow swamp a pixel diff — so the probe
        // reads the moving part's position out of the same function the shader is fed.
        const moving = bat.kind === EngineKind.Onager
          ? { armRad: +armStateOf(bat.kind, pose.draw).toFixed(3), tip: onArmTip(pose.draw) }
          : { armRad: +armStateOf(bat.kind, pose.draw).toFixed(3), sliderZ: +sliderZOf(pose.draw).toFixed(3) };
        // Where this machine actually stands, and which way it points. The probe's bench camera
        // needs the machine's own frame to aim at it, and reconstructing the layout arithmetic
        // outside this file would go stale the moment the pitch or the stand-off changed — as it
        // had: the bench was still framing on a 3.6 m pitch after `ENGINE_PITCH` went to 4.4, so
        // it aimed 1.2 m to one side of the gun it thought it was photographing.
        const place = this.enginePlace(u, bat, k);
        engines.push({
          k,
          sinceShot: +bat.sinceShot[k].toFixed(2),
          draw: +pose.draw.toFixed(3),
          recoil: +pose.recoil.toFixed(3),
          loaded: pose.loaded,
          phase: pose.phase,
          ...moving,
          ...place,
        });
      }
      out.push({
        unit: id, type: u?.typeId, kind: bat.kind, crew: bat.crew, count: bat.count,
        elevDeg: +((bat.elev * 180) / Math.PI).toFixed(2),
        silhouette: SILHOUETTE_OF[bat.kind], engines,
      });
    }
    return out;
  }

  /**
   * Where engine `k` of a battery stands in the world, and its yaw.
   *
   * The single source of the layout: `pushBattery` writes the instance from this and
   * `debugEngines` reports it, so a camera aimed with these numbers is aimed at the machine the
   * renderer actually drew.
   */
  private enginePlace(
    u: UnitGroupState,
    bat: Battery,
    k: number
  ): { x: number; y: number; z: number; yaw: number } {
    // Through `engineAnchor` rather than repeated here, because the simulation now launches
    // from this same point: a bolt leaves the machine's muzzle, so the renderer and the sim
    // agreeing about where the machine is stopped being cosmetic.
    engineAnchor(u.x, u.z, u.facing, bat.kind, k, bat.count, this.anchorScratch,
      this.projectiles?.engineSite());
    const { x, z } = this.anchorScratch;
    return { x, y: this.battle.groundAt(x, z), z, yaw: u.facing + bat.yawJit[k] };
  }

  private anchorScratch = { x: 0, z: 0 };

  /**
   * Train each machine round onto the unit the simulation has it laid on.
   *
   * `yawJit` was a fixed per-gun stand-off — "no two guns in a battery are laid on exactly the
   * same bearing" — which is true of a battery at rest and wrong of one in action. A crew lays
   * its piece: it traverses onto the target, and the guns of a battery therefore *converge*
   * slightly rather than sitting parallel. Reading the target from the sim rather than picking
   * the nearest enemy here means the barrel points where the shot is actually going.
   *
   * Bounded, because these machines traverse by levering the whole carriage round: a tripod
   * scorpio has a useful arc, an onager chassis very little. Beyond the bound the unit itself
   * has to turn, which is the order the player would give.
   */
  private traverseOnto(u: UnitGroupState, bat: Battery, dt: number): void {
    if (this.freezeEngines) return;
    const targets = this.projectiles?.engineTargets(u.id);
    const limit = bat.kind === EngineKind.Onager ? 0.20 : 0.42;
    for (let k = 0; k < bat.count; k++) {
      const id = targets ? targets[k] : -1;
      let want = bat.restJit[k];
      if (id >= 0) {
        const t = this.battle.unitById(id);
        if (t && !t.destroyed && t.alive > 0) {
          // Bearing to the target, in the unit's own frame.
          let d = Math.atan2(t.x - u.x, t.z - u.z) - u.facing;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          want = Math.max(-limit, Math.min(limit, d)) + bat.restJit[k] * 0.35;
        }
      }
      // Ease rather than snap: a crew heaving a carriage round takes a few seconds.
      bat.yawJit[k] += (want - bat.yawJit[k]) * Math.min(1, dt * 1.6);
    }
  }

  /**
   * Append a battery's machines to the engine tier.
   *
   * The guns are laid out on `ENGINE_PITCH` centres in the unit's own frame and set forward
   * of the anchor, so that the crew stations — which are all behind their machine — land
   * close to the formation slots the simulation actually gave the men. See `engines.ts`.
   */
  private pushBattery(u: UnitGroupState, bat: Battery, uc: number, us: number): void {
    const tier = this.engineTiers[bat.kind];
    if (!tier) return;
    const p = this.battle.pool;
    const reload = this.reloadOf(u.id);
    const only = this.benchOnly;
    for (let k = 0; k < bat.count && tier.count < MAX_ENGINES; k++) {
      if (only && (only.unit !== u.id || only.k !== k)) continue;
      let alive = 0;
      for (let c = 0; c < bat.crew; c++) {
        const i = u.members[k * bat.crew + c];
        if (i !== undefined && p.aliveAt(i)) alive++;
      }
      // A gun whose crew are all dead is abandoned where it stood: string forward, groove
      // empty, muzzle down. It is not removed — a wrecked battery is one of the things that
      // makes a late-battle field read as a battle rather than as a tidy simulation.
      const pose = alive > 0 ? enginePose(bat.sinceShot[k], reload, this.pose) : ABANDONED;
      const { x, y, z, yaw } = this.enginePlace(u, bat, k);

      // An onager is a 3.8 m chassis with a 2 m arm over it, so it needs a bound to match.
      const big = bat.kind === EngineKind.Onager;
      this.sphere.center.set(x, y + (big ? 1.3 : 0.85), z);
      this.sphere.radius = big ? 3.4 : 1.8;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;

      const n = tier.count;
      tier.pos[n * 3] = x;
      tier.pos[n * 3 + 1] = y;
      tier.pos[n * 3 + 2] = z;
      const o = n * 4;
      tier.orient[o] = yaw;
      tier.orient[o + 1] = 1;
      tier.orient[o + 2] = alive > 0 ? bat.elev : -0.06;
      tier.orient[o + 3] = bat.variant[k];
      tier.state[o] = armStateOf(bat.kind, pose.draw);
      tier.state[o + 1] = sliderZOf(pose.draw);
      tier.state[o + 2] = pose.recoil;
      tier.state[o + 3] = pose.loaded;
      tier.count = n + 1;
    }
  }

  /**
   * Move a crewman from his formation slot to his station on the machine.
   *
   * Visual only, exactly as `slotOff` is — the pool is untouched, so the spatial hash, melee
   * reach and the projectile origin all still see the slot. The displacement is an order of
   * magnitude bigger than `slotOff`'s, which is why the engines are pitched close to the
   * formation's own frontage: at four engines on 3.6 m centres against a 12-man line, no man
   * moves more than about 2 m from where the simulation has him.
   *
   * The whole thing fades out with the man's ground speed. A battery that is limbering up and
   * marching should be men walking, not men sliding sideways onto marks.
   */
  private stationMan(
    u: UnitGroupState,
    bat: Battery,
    i: number,
    facing: number,
    uc: number,
    us: number,
    out: { x: number; y: number; z: number }
  ): number {
    const p = this.battle.pool;
    const vx = p.vx[i];
    const vz = p.vz[i];
    const t = 1 - Math.min(1, Math.sqrt(vx * vx + vz * vz) / 0.6);
    if (t <= 0.002) return facing;

    const slot = p.slot[i];
    const k = Math.min(bat.count - 1, Math.floor(slot / bat.crew));
    const table = STATIONS_OF[bat.kind];
    const st = table[slot % table.length];
    stationJitter(p.variant[i], this.jitter);
    const lx = (k - (bat.count - 1) * 0.5) * bat.pitch + st.x + this.jitter[0];
    const lz = bat.forward + st.z + this.jitter[1];
    const wx = u.x + lx * uc + lz * us;
    const wz = u.z - lx * us + lz * uc;
    out.x += (wx - out.x) * t;
    out.z += (wz - out.z) * t;
    out.y = this.battle.groundAt(out.x, out.z);

    // Turned to his work rather than to the enemy: the loader faces across the groove and the
    // ammunition server faces back at the basket. A crew all squared up downrange is the
    // giveaway that they are infantry with a prop in front of them.
    const want = u.facing + st.turn + bat.yawJit[k] + this.jitter[2] * 0.4;
    let d = (want - facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return facing + d * t;
  }

  /** The sim's own reload gap for this unit, seconds — the winch's clock. */
  private reloadOf(unitId: number): number {
    const u = this.battle.unitById(unitId);
    if (!u) return 20;
    const rate = unitType(u.typeId).missile?.rate ?? 3;
    return (60 / Math.max(0.5, rate)) * (1 + u.fatigue * 0.5);
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
    // The engine tier has its own attribute layout, so it cannot ride the loop above; but it
    // is a distinct program and the first frame that needs it stalls exactly the same way.
    const engs = this.engineTiers.filter((t): t is EngineTier => !!t);
    const engSaved = engs.map((e) => ({ count: e.geometry.instanceCount, visible: e.mesh.visible }));
    for (const eng of engs) {
      if (eng.count !== 0) continue;
      eng.geometry.instanceCount = 1;
      eng.pos[0] = ctx.camera.position.x;
      eng.pos[1] = ctx.camera.position.y - 60;
      eng.pos[2] = ctx.camera.position.z;
      eng.orient[1] = 1;
      eng.attrs.pos.needsUpdate = true;
      eng.attrs.orient.needsUpdate = true;
      eng.mesh.visible = true;
    }

    ctx.renderer.setRenderTarget(target);
    ctx.renderer.render(ctx.scene, ctx.camera);
    ctx.renderer.setRenderTarget(prev);
    tiers.forEach((t, i) => {
      t.geometry.instanceCount = saved[i].count;
      t.mesh.visible = saved[i].visible;
    });
    engs.forEach((e, i) => {
      e.geometry.instanceCount = engSaved[i].count;
      e.mesh.visible = engSaved[i].visible;
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

    /** The archetype whose kit is baked into each faction's billboard row. */
    const ARCHETYPE: Record<Faction, string> = {
      [Faction.Rome]: 'legio-cohort',
      [Faction.Germanic]: 'juthungi-warband',
      // The Libyan spearman rather than a mercenary, because he is the commonest thing in a
      // Punic line and because at 130 m a billboard is a silhouette: mail, an oval shield
      // and a long spear is the shape most of that army presents.
      [Faction.Carthage]: 'libyan-spearmen',
    };
    const groups = ALL_FACTIONS.map((faction) => {
      const geometry = buildSoldierGeometry(faction, 1);
      const def = unitType(ARCHETYPE[faction]);
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

  /**
   * Distance at which a man is `px` pixels tall, from the viewport and the camera's own FOV.
   *
   * A perspective camera puts a `MAN_H` metre object at distance `d` across
   * `viewH * MAN_H / (2 * d * tan(fov/2))` pixels, so inverting it gives the distance for a
   * wanted pixel height. Derived rather than tabulated because the quantity being chosen is
   * a *legibility* threshold: it depends on how many pixels the player has and how wide the
   * lens is, and on nothing else. A constant would be right at one resolution and one FOV.
   */
  private distanceForPixelHeight(ctx: EngineContext, px: number): number {
    const cam = ctx.camera as THREE.PerspectiveCamera;
    const fov = typeof cam.fov === 'number' && cam.fov > 1 ? cam.fov : 45;
    const halfTan = Math.tan((fov * Math.PI) / 360);
    return (ctx.viewH * MAN_HEIGHT_M) / (2 * px * halfTan);
  }

  private applyQuality(ctx: EngineContext): void {
    const far = ctx.quality.lodFarDistance;
    /**
     * The billboard edge is a floor, not a fraction of the tier's LOD distance.
     *
     * It used to be `far * 2.0`, which gave 180 m at low, 280 at medium, 440 at high and
     * 640 at ultra. The impostor tier's own docblock justifies itself on the grounds that
     * "a man is a handful of pixels tall" out there — but at 1080p those edges are 13.2,
     * 8.5, 5.4 and 3.7 px respectively, so only ultra met the criterion the design was
     * written against and low fired three and a half times too close. A *legibility*
     * threshold was being scaled as though it were a *cost* knob, and the consequence was
     * that 89% of visible men were billboards at `high` against 0% at `ultra` — with the
     * player reporting that most of their army was invisible under its own banners.
     *
     * 4.5 px is the height at which a standing man stops resolving as a figure at all, so
     * that is the criterion, and the distance comes from the viewport rather than a table.
     * Counter-intuitively this is also *faster* at the lower tiers despite drawing more
     * triangles: an alpha-tested billboard costs more per pixel than the opaque LOD2 mesh it
     * replaces, and near the camera it covers far more pixels.
     */
    const impostorEdge = this.distanceForPixelHeight(ctx, IMPOSTOR_MIN_PX);
    this.lodDist = [
      far * LOD_FRACTION[0],
      far * LOD_FRACTION[1],
      Math.max(far * LOD_FRACTION[2], impostorEdge),
    ];
  }

  resize(_w: number, _h: number, ctx: EngineContext): void {
    this.applyQuality(ctx);
  }

  update(dt: number, ctx: EngineContext): void {
    this.elapsed += dt;
    for (const m of this.mats) m.uniforms.uTime.value = this.elapsed;
    // Before the playheads, because a crewman's clip is chosen from his engine's phase.
    this.updateEngines(dt);
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
      // A settled corpse has no playhead left to advance. The one exception is an elephant
      // still going down: the sim calls it `Dead` after a second and its authored collapse
      // runs for 2.6, so stopping here would freeze four tonnes half-way to the ground with
      // its forelegs folded and its hindquarters still up. The extra test costs two array
      // reads on the dead, and stops of its own accord the moment the fall completes.
      if (state === SoldierState.Dead && !(this.eleDeath[i] < 1 && this.isElephant(i))) continue;

      this.ensureGait(i);
      const cav = this.isCavalry(i);
      const clip = p.animClip[i];
      // `Math.hypot` is a builtin with subnormal and overflow handling that costs several
      // times a plain square root, and this is 8,600 calls a frame.
      const vx = p.vx[i];
      const vz = p.vz[i];
      const speed = Math.sqrt(vx * vx + vz * vz);
      // An artillery crewman standing idle is not idle — he is on the windlass or laying a
      // bolt. `serveClip` swaps his clip for one that reads as that, but only while the sim
      // itself has him idle: during the volley the sim owns him and the throw pose is both
      // right and timed to the bolt.
      const served = this.serveClip(i, clip);
      const want = cav
        ? (RIDE_CLIP_MAP[clip] ?? RIDE_CLIP_MAP[Clip.IdleAlert])
        : (FOOT_CLIP_VARIANT_MAP[served * FOOT_VARIANTS + this.clipBucket[i]]
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
      // A war elephant runs its own playhead on its own clip set. Deliberately *before* the
      // cavalry branch: `isCavalry` is true for it — the roster classes it as heavy cavalry
      // so the AI handles it without a new `UnitClass` — and letting it fall through would
      // put it on the horse's gait ladder and its stride, which is the exact shape of the
      // rate-matching defect this whole path is written to avoid.
      if (this.isElephant(i)) {
        this.advanceElephant(i, dt, state, speed);
      } else if (cav) {
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

  /**
   * Substitute a serving pose for an artillery crewman the simulation has left idle.
   *
   * Returns the clip unchanged for everyone else, so this costs one array probe per man per
   * frame. `typeIndex` is already resolved by `ensureGait` above, so the artillery test is a
   * flag lookup rather than a map walk.
   */
  private serveClip(i: number, clip: Clip): Clip {
    if (clip !== Clip.IdleAlert && clip !== Clip.IdleRelaxed && clip !== Clip.IdleBrace) return clip;
    const t = this.typeOf(i);
    if (t < 0 || !this.typeIsEngine[t]) return clip;
    const p = this.battle.pool;
    const u = this.battle.unitById(p.unitId[i]);
    if (!u) return clip;
    const bat = this.batteries.get(u.id);
    if (!bat) return clip;
    const slot = p.slot[i];
    const k = Math.min(bat.count - 1, Math.floor(slot / bat.crew));
    const pose = enginePose(bat.sinceShot[k], this.reloadOf(u.id), this.pose);
    return crewClip(bat.kind, slot % bat.crew, pose.phase);
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

  private isElephant(i: number): boolean {
    const t = this.typeOf(i);
    return t >= 0 ? this.typeIsElephant[t] : false;
  }

  /**
   * What the elephant probe reads. Diagnostic only; nothing in the game calls it.
   *
   * Reports the numbers the horse got wrong — the animal's clip and playback rate, the
   * height of the back, the tower floor and the mahout's seat, and the residual slip of a
   * planted foot. See `tools/probe-elephant.mjs`.
   */
  probeElephant(i: number): {
    clip: number; rate: number; groundSpeed: number; footSlip: number;
    backY: number; towerY: number; mahoutY: number;
    phase: number; fall: number;
  } | null {
    if (!this.isElephant(i)) return null;
    const p = this.battle.pool;
    const speed = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
    const clip = this.eleCur[i] === 255 ? ELEPHANT_CLIP.idle : this.eleCur[i];
    const facts = this.elephantFacts[clip];
    const cps = facts.rootSpeed > 0.05
      ? (speed * facts.invDuration) / facts.rootSpeed
      : facts.invDuration;
    const rate = Math.min(1.9, Math.max(0.2, cps));
    // Foot slip: how fast a planted foot moves over the ground. The clip depicts
    // `rootSpeed / invDuration` metres per cycle, so at `rate` cycles a second it depicts
    // `stride * rate` m/s of travel; the difference from the animal's real ground speed is
    // exactly what an eye reads as skating.
    const stride = facts.rootSpeed > 0.05 ? facts.rootSpeed / facts.invDuration : 0;
    const depicted = stride * rate;
    const scale = 0.9 + p.variant[i] * 0.2;
    const frame = Math.min(facts.frames - 1, Math.floor(this.elePhase[i] * facts.frames));
    const row = (facts.rowBase + frame) * 3;
    return {
      clip,
      rate,
      groundSpeed: speed,
      footSlip: stride > 0 ? Math.abs(depicted - speed) : 0,
      backY: p.y[i] + ELEPHANT_GROUND_LIFT + 2.76 * scale,
      towerY: p.y[i] + ELEPHANT_GROUND_LIFT + this.howdahTrack[row + 1] * scale,
      mahoutY: p.y[i] + ELEPHANT_GROUND_LIFT + this.mahoutTrack[row + 1] * scale,
      /**
       * The animal's own playhead, and how far through its collapse it is.
       *
       * `tools/probe-elephantdeath.mjs` has an `elePhase` column that reads `?.phase` and has
       * therefore printed **-1 on every row of every run**, because this object never carried
       * one. A column that cannot move is the "the arm never ran" signature this project has
       * paid for four times, and here it hid the fact that the collapse was being driven off
       * a man's playhead. `fall` is the render-side death timer, 0 while alive.
       */
      phase: this.elePhase[i],
      fall: this.eleDeath[i],
    };
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
      this.typeIsElephant.push(ridesElephant(def));
      this.typeIsEngine.push(isEngineUnit(def));
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
    if (this.elephantTier) this.elephantTier.buf.count = 0;
    this.animClock = ctx.time.simTime;
    if (this.impostorTier) this.impostorTier.buf.count = 0;
    for (const t of this.engineTiers) if (t) t.count = 0;

    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const camX = cam.position.x;
    const camY = cam.position.y;
    const camZ = cam.position.z;
    const [d0, d1, d2] = this.lodDist;

    for (const u of b.units) {
      const def = unitType(u.typeId);
      const cav = isCavalry(def);
      const onElephant = ridesElephant(def);
      const selected = u.selected;
      // Slot stand-off is expressed in *formation* space, so the trig is once per unit rather
      // than 8,600 times a frame. A rank dresses to the unit's front, not to each man's own
      // heading, so this is also the more correct frame to offset in.
      const uc = Math.cos(u.facing);
      const us = Math.sin(u.facing);
      const battery = isEngineUnit(def) ? this.batteryOf(u, def) : undefined;
      if (battery) this.pushBattery(u, battery, uc, us);

      for (const i of u.members) {
        const state = p.state[i] as SoldierState;
        this.ensureKit(i, def);
        b.renderPos(i, alpha, rp);

        let facing = b.renderFacing(i, alpha);
        const dying = state === SoldierState.Dying || state === SoldierState.Dead;
        // A living crewman stands at his post on the machine, not in his formation slot.
        // Done before the corpse branch so a man who dies at the winch falls at the winch.
        if (battery && !dying) facing = this.stationMan(u, battery, i, facing, uc, us, rp);

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
        } else if (dying && !onElephant && (p.deathDirX[i] !== 0 || p.deathDirZ[i] !== 0)) {
          /**
           * No ragdoll available: turn the man so his death clip's own fall direction
           * points where the blow pushed him.
           *
           * **Never an elephant, and this was the last thing left of "they just disappear".**
           * A man's death clip drops him one fixed way, so the renderer turns *him* to make
           * the blow's direction come out right. An elephant is exempt from the ragdoll by
           * design, so it fell into this branch too, and the result was measurable and
           * ridiculous: killed from dead astern, the drawn heading snapped a **full 180
           * degrees on the frame of the killing blow** (`animTime` is still mid-clip at that
           * instant, so `min(1, animTime * 2.5)` is already 1), then jumped back to 46
           * degrees when `setState` zeroed the playhead and swung round to 180 again over
           * 0.6 s. Four tonnes pirouetting while it collapses reads as a stumble, not a
           * death — see `tools/scratch/eleface-check.mjs`, which prints that sequence.
           *
           * It is also a correctness bug and not only a look. The animal's fall direction is
           * baked into the clip's own roll, so turning the body turns the roll with it; the
           * crew's landing side is computed off the same heading; and
           * `BattleSystem.partCarcasses` builds its 4.7 x 2.6 m capsule on `pool.facing`,
           * which this branch does not touch. A body drawn at 180 degrees to the obstacle
           * men are pushed out of is the worst possible version of that pass. The animal
           * goes down on the heading it was on, and every one of those four agree again.
           */
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
        //
        // An elephant gets its own figure, because a horse's does not fit it in either
        // state. Standing it is 4.5 m long and 3.9 m to the top of the tower, so the 1.9 m
        // sphere at 0.9 m the cavalry branch gave it enclosed about the front half of the
        // animal and none of the crew — at the frame edge the whole beast popped out while
        // most of it was still on screen. Lying down it is 4.7 m along the ground. One
        // sphere at 1.7 m with a 3.6 m radius contains both, and a bigger bound costs
        // instances, never draw calls.
        const bigAnimal = onElephant;
        this.sphere.center.set(rp.x, rp.y + (bigAnimal ? 1.7 : hasCorpse ? 0.4 : 0.9), rp.z);
        this.sphere.radius = (bigAnimal ? 3.6 : cav ? 1.9 : hasCorpse ? 1.5 : 1.25)
          + SHADOW_CULL_MARGIN;
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
        if (onElephant) {
          /**
           * One pool soldier is one whole elephant: the animal, its mahout and three men in
           * the tower. See `war-elephants` in `roster.ts` for why the simulation models it
           * that way — the thing that needs to be pushed, damaged and killed is the beast.
           *
           * So the pool entry draws the animal, and the four men are emitted here as extra
           * instances rather than being pool soldiers of their own. They cost nothing in the
           * draw budget because they come out of the Carthaginian soldier tier this unit is
           * already using, and nothing in the simulation because they do not exist in it.
           *
           * **The animal is drawn dead as well as alive, and this is the fix for "when they
           * die they just disappear".** There used to be an `if (!hasCorpse)` around these
           * two calls, and `hasCorpse` went true on the tick of the killing blow because
           * `Ragdoll` registered every death including this one — so the elephant and its
           * four men left the instance buffer on the first frame after `damage()` and never
           * came back. The carcass is the *same instance in the same tier* at the last frame
           * of the death clip, so it costs exactly nothing: no extra draw call, no extra
           * mesh, no impostor, just an instance that stops moving.
           */
          this.pushElephant(i, rp.x, rp.y + ELEPHANT_GROUND_LIFT, rp.z, facing, dying);
          this.pushElephantCrew(
            u, def, i, rp.x, rp.y + ELEPHANT_GROUND_LIFT, rp.z, facing, lod, state,
            dying ? this.eleDeath[i] : 0
          );
          // The animal is the unit. Nothing is drawn at the man's own slot: a legionary-sized
          // Carthaginian standing inside the elephant's ribs is what the naive path produces.
          continue;
        }
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
        } else if (!hasCorpse && !battery) {
          // Ragged ranks. See SLOT_LATERAL: visual only, stable per man, and the straggle
          // term scales with his speed so a halted formation still dresses its line.
          // Skipped for a gun crew: `stationMan` has already placed them, and adding a rank
          // stand-off on top would push a man off the handspike he is supposed to be on.
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

    this.flush(camX, camY, camZ);
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

  /**
   * Choose the animal's gait from its own ground speed and advance its playhead.
   *
   * **The rate comes from the elephant's clip, never from a man's.** That sentence is the
   * whole point of this method: the horse's gallop never took its rate-matched branch
   * because the rate was read off the rider's clip, every ride clip is an overlay whose
   * `rootSpeed` is zero, and the hooves skated 2.7-4.1 m/s against a 5.362 m stride. There
   * is no rider here to get it from — the elephant *is* the pool entry — but the same
   * mistake is available in the form of using `this.phase[i]`, the man's playhead, so the
   * animal keeps a separate one in `elePhase`.
   */
  private advanceElephant(i: number, dt: number, state: SoldierState, speed: number): number {
    /**
     * Death and rout override speed: a dying elephant goes down and a broken one trumpets,
     * whatever the ground is doing under it.
     *
     * The collapse runs on `eleDeath`, at the death clip's own authored duration — see the
     * field's note. It used to run on `pool.animTime`, which is a man's playhead: 2.6 s of
     * authored fall was played in the 1.0 s the *man* death clip takes, and then froze,
     * because the sim flips `Dying` to `Dead` at that point and `advancePlayheads` skips
     * the dead. Nobody ever saw either failure, because the animal was not being drawn at
     * all — see `Ragdoll.registerDeath`.
     */
    if (state === SoldierState.Dying || state === SoldierState.Dead) {
      this.eleCur[i] = ELEPHANT_CLIP.death;
      const d = Math.min(1, this.eleDeath[i] + dt * this.elephantFacts[ELEPHANT_CLIP.death].invDuration);
      this.eleDeath[i] = d;
      this.elePhase[i] = d;
      return d;
    }
    let want: number;
    if (state === SoldierState.Routing) {
      want = ELEPHANT_CLIP.panic;
    } else if (state === SoldierState.Fighting) {
      want = ELEPHANT_CLIP.attack;
    } else if (speed < ELEPHANT_IDLE_EDGE) {
      want = ELEPHANT_CLIP.idle;
    } else {
      // Two rungs, one crossover, taken at the geometric mean of the two measured strides.
      want = speed > this.eleGaitUp[0] ? ELEPHANT_GAIT_LADDER[1] : ELEPHANT_GAIT_LADDER[0];
    }
    if (this.eleCur[i] !== want) {
      this.eleCur[i] = want;
      /**
       * Start on the animal's own phase, never on zero.
       *
       * Zero put every elephant in a unit into identical lockstep — same footfall, same ear
       * beat, same trunk sway — and three independent blind critics named it without being
       * prompted: "sixteen units, one mesh, one pose, one heading, no animation offset
       * between any two of them", "identical stride phase", "one animation frame, N times".
       * It was the most-cited single defect in the deck.
       *
       * The infantry path already does this through `phaseOff`, and its comment says why: a
       * cohort that halts together must not land on one shared pose. Sixteen four-tonne
       * animals stepping in time is that failure at sixteen times the size.
       */
      this.elePhase[i] = hash01(Math.floor(this.battle.pool.variant[i] * 16777216), 45);
    } else if (want === ELEPHANT_CLIP.attack && this.elePhase[i] >= 1) {
      /**
       * Re-strike rather than freeze.
       *
       * `attack` is a one-shot, so the clamp below leaves the playhead at 1 and the animal
       * holds its last frame — head thrown up and to one side — for as long as the melee
       * lasts. An elephant frozen mid-toss in the middle of a fight is a worse defect than
       * no attack animation at all, because it is a *pose* and the eye reads it as broken
       * rather than as still. Restart from a per-animal offset so a rank of them does not
       * gore in unison.
       */
      this.elePhase[i] = hash01(Math.floor(this.battle.pool.variant[i] * 16777216), 44) * 0.18;
    }
    const facts = this.elephantFacts[want];
    // Locomotion advances at ground speed over the clip's own measured stride; everything
    // else at one cycle per its authored duration. Stride is `rootSpeed / invDuration`,
    // i.e. metres per second times seconds per cycle, and both of those come from the clip.
    const cyclesPerSecond = facts.rootSpeed > 0.05
      ? (speed * facts.invDuration) / facts.rootSpeed
      : facts.invDuration;
    // 1.9 cycles a second is the fastest a real elephant's legs go; below 0.2 it would freeze
    // mid-stride in a melee shuffle. Neither bound is ever reached at roster speeds — the
    // charge needs 1.49 — so they exist only to keep a stalled or shoved animal sane.
    const clamped = Math.min(1.9, Math.max(0.2, cyclesPerSecond));
    let ph = this.elePhase[i] + clamped * dt;
    if (facts.loop) ph -= Math.floor(ph);
    else ph = Math.min(1, ph);
    this.elePhase[i] = ph;
    return ph;
  }

  /** The animal itself: one instance, one geometry, no LOD chain. */
  private pushElephant(
    i: number,
    x: number, y: number, z: number,
    facing: number,
    dying: boolean
  ): void {
    const tier = this.elephantTier;
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
    // Bulls and cows in one herd: a fifth either side of full size, from the stable hash so
    // an animal's size never changes. Elephants in a line are visibly not all the same size,
    // and sixteen identical ones is the uniformity tell that a crowd of men would have.
    buf.orient[o + 1] = 0.9 + p.variant[i] * 0.2;
    buf.orient[o + 2] = 0;
    buf.orient[o + 3] = p.grime[i] * 0.7;

    const facts = this.elephantFacts[this.eleCur[i] === 255 ? ELEPHANT_CLIP.idle : this.eleCur[i]];
    const ph = this.elePhase[i];
    const f = ph * facts.frames;
    const f0 = Math.min(facts.frames - 1, Math.floor(f));
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
    buf.kit[k] = ELEPHANT_MASK_LO;
    buf.kit[k + 1] = 0;

    const c = n * Stride.Col0;
    // The caparison under the tower, which is the one dyed surface on the animal. Punic
    // crimson and purple, varied per animal because a mercenary army's cloth came from
    // whatever lots the quartermaster could buy.
    const v = p.variant[i];
    const cloth: [number, number, number] = v < 0.34
      ? [0.20, 0.030, 0.055]
      : v < 0.68 ? [0.13, 0.022, 0.10] : [0.16, 0.055, 0.032];
    buf.col0[c] = cloth[0];
    buf.col0[c + 1] = cloth[1];
    buf.col0[c + 2] = cloth[2];
    buf.col0[c + 3] = 0;
    buf.col1[c] = 0.5; buf.col1[c + 1] = 0.5; buf.col1[c + 2] = 0.5;
    // Bronze, kept bright: the chamfron is meant to be the brightest thing on the field, and
    // a war elephant's plate was polished for exactly that reason. Class 1 is bronze and the
    // fraction is polish. A dead animal's kit stops being maintained.
    buf.col1[c + 3] = dying ? 1.35 : 1.78;

    buf.count = n + 1;
  }

  /**
   * The mahout on the neck and the three men in the tower.
   *
   * These are **not pool soldiers** — see the note in `preRender`. They are written straight
   * into the faction's own soldier tier with kit resolved once per role, which is why they
   * cost no draw call and no simulation. Their heights come from `howdahTrack` and
   * `mahoutTrack`, both baked per animation row, so they ride the animal's real back rather
   * than a rest-pose constant.
   */
  private pushElephantCrew(
    u: UnitGroupState,
    def: UnitTypeDef,
    i: number,
    x: number, y: number, z: number,
    facing: number,
    lod: number,
    state: SoldierState,
    fall: number
  ): void {
    const tier = this.soldierTiers[u.faction][Math.min(lod, LOD_COUNT - 1)];
    const p = this.battle.pool;
    const scale = 0.9 + p.variant[i] * 0.2;
    const sinF = Math.sin(facing);
    const cosF = Math.cos(facing);

    const facts = this.elephantFacts[this.eleCur[i] === 255 ? ELEPHANT_CLIP.idle : this.eleCur[i]];
    const frame = Math.min(facts.frames - 1, Math.floor(this.elePhase[i] * facts.frames));
    const row = (facts.rowBase + frame) * 3;
    const floorY = this.howdahTrack[row + 1] * scale;
    const floorZ = this.howdahTrack[row + 2] * scale;
    const seatY = this.mahoutTrack[row + 1] * scale;
    const seatZ = this.mahoutTrack[row + 2] * scale;

    // A crewman throws when the animal's unit is shooting and braces otherwise; the mahout
    // never fights, he is holding a goad in both hands and steering four tonnes. Once the
    // animal is going down every one of them is holding on with both hands.
    const shooting = state === SoldierState.Throwing || state === SoldierState.Shooting;
    const routing = state === SoldierState.Routing;
    const crewClipId = fall > 0 || routing
      ? Clip.IdleBrace : shooting ? Clip.ThrowPilum : Clip.IdleAlert;
    // 0 while they are still on the animal, rising to 1 as each is thrown clear.
    const throwT = fall <= CREW_THROW_START
      ? 0
      : Math.min(1, (fall - CREW_THROW_START) / CREW_THROW_LEN);

    for (let k = 0; k < HOWDAH_STATIONS.length + 1; k++) {
      const mahout = k === HOWDAH_STATIONS.length;
      const st = mahout ? { x: 0, z: 0, turn: 0 } : HOWDAH_STATIONS[k];
      // Stable per man for the whole battle: his own hash is the animal's, salted by station.
      const seed = Math.floor(p.variant[i] * 16777216) + k * 7919;
      const jx = (hash01(seed, 61) - 0.5) * 0.14;
      const jz = (hash01(seed, 62) - 0.5) * 0.12;
      const lx = (st.x + jx) * scale;
      const lz = (mahout ? seatZ : floorZ + st.z + jz) * scale;
      // A man standing in the tower stands on its floor; the mahout sits astride the neck, so
      // his hips are at the seat and his legs hang either side.
      const my = y + (mahout ? seatY - 0.86 * scale : floorY);
      // The men are their own size, not the animal's. Scaling a crewman by his mount's
      // `scale` would give the biggest bull the tallest crew, which is backwards — a big
      // elephant is what makes the men on it look *small*.
      const manScale = (mahout ? 0.97 : 1.0) * (0.96 + hash01(seed, 63) * 0.09);
      const wx = x + lx * cosF + lz * sinF;
      const wz = z - lx * sinF + lz * cosF;

      if (throwT <= 0) {
        this.pushCrewman(
          tier, wx, my, wz, facing + st.turn, manScale, def, seed,
          mahout ? Clip.IdleRelaxed : crewClipId, i
        );
        continue;
      }
      this.throwCrewman(tier, def, i, seed, manScale, wx, my, wz, facing, mahout, throwT);
    }
  }

  /**
   * One crewman pitched off a falling elephant, mid-air or landed.
   *
   * The recipe is deliberately the *same one a man's corpse uses*, because that combination
   * is known to sit correctly on the ground: a death clip held at its last frame, a
   * full-body quaternion that tips him out of the standing pose, and a mesh origin at the
   * surface plus `RagdollSystem`'s own 0.15 m. Interpolating the clip phase and the tip
   * angle together over the throw turns the same three numbers into a man tumbling out of a
   * tower and landing flat, without a second solver and without a per-man physics body.
   *
   * He is not a pool soldier, so nothing here reaches the simulation. Four instances per
   * dead animal, in the faction tier that is already being drawn.
   */
  private throwCrewman(
    tier: Tier,
    def: UnitTypeDef,
    i: number,
    seed: number,
    manScale: number,
    fromX: number, fromY: number, fromZ: number,
    facing: number,
    mahout: boolean,
    t: number
  ): void {
    const b = this.battle;
    /**
     * Where he lands, in the animal's frame.
     *
     * The mahout sits forward of the tower and is thrown further forward; the three tower
     * men scatter along the body. All of it off the same stable seed, so a crewman's landing
     * place is fixed the moment he is thrown and does not crawl if the frame rate changes.
     */
    const side = CREW_FALL_SIDE * (CREW_LAND_OUT + hash01(seed, 81) * 1.35);
    const along = mahout ? 1.5 + hash01(seed, 82) * 0.9 : -0.7 + hash01(seed, 82) * 2.4;
    const sinF = Math.sin(facing);
    const cosF = Math.cos(facing);
    const landX = fromX + side * cosF + along * sinF;
    const landZ = fromZ - side * sinF + along * cosF;
    const landY = b.groundAt(landX, landZ) + CREW_GROUND_LIFT;

    /**
     * Two easings, because a man leaving a rotating platform is not a man on a rail.
     *
     * This used to be one smoothstep driving all three axes, and a smoothstep starts at
     * *zero velocity* — so for the first third of the throw he barely moved sideways while
     * the animal rolled into him. Measured against the posed hide
     * (`tools/scratch/carc-crew-entry.ts`, which inverts the spine's rigid transform and
     * tests the man's own body capsule against the swept ellipse the hide is built from),
     * the deepest a crewman got inside the animal was **0.278 m at 33.5 % of the fall** —
     * the reported "they tumble through its back".
     *
     * Out on `t(2 − t)`, which leaves the platform at maximum speed, and down on `t²`, which
     * is what gravity does. Same peak arc, same landing point, same landing frame: both
     * curves are 0 at 0 and 1 at 1. Deepest penetration **0.080 m**, and that is the
     * measurement's own floor — a man standing in the tower already reads 0.097, because
     * the howdah's floor sits 0.21 m inside the hide and his boots are under the planking
     * where nothing can see them.
     *
     * `CREW_THROW_ARC` is deliberately *not* the fix and is unchanged at 0.55 m. Raising it
     * to 0.85 with the old easing only takes 0.278 to 0.157; the easing alone takes it to
     * 0.080 with the arc left alone.
     */
    const sOut = t * (2 - t);
    const sDown = t * t;
    const x = fromX + (landX - fromX) * sOut;
    const z = fromZ + (landZ - fromZ) * sOut;
    // A parabola over the straight line, so he clears the animal's back rather than sliding
    // down it. Zero at both ends by construction.
    const y = fromY + (landY - fromY) * sDown + CREW_THROW_ARC * Math.sin(Math.PI * t);
    const s = sOut;

    // Which way he is turned when he lands, and the horizontal axis he tips about: away
    // from the animal, which is the direction he was thrown.
    const outward = facing + (CREW_FALL_SIDE > 0 ? Math.PI / 2 : -Math.PI / 2)
      + (hash01(seed, 83) - 0.5) * 1.1;
    qCrew.setFromAxisAngle(AXIS_UP, outward);
    vCrewAxis.set(Math.cos(outward), 0, -Math.sin(outward));
    // Tip through a right angle over the throw, a little past it so he does not land as a
    // plank: 96 degrees rolls his shoulder into the ground.
    qCrewTip.setFromAxisAngle(vCrewAxis, s * 1.676);
    qCrew.premultiply(qCrewTip);

    const variants = [Clip.DeathSide, Clip.DeathBack, Clip.DeathForward, Clip.DeathKneel];
    const clip = variants[Math.floor(hash01(seed, 84) * 4) & 3];
    this.pushCrewman(tier, x, y, z, outward, manScale, def, seed, clip, i, s, qCrew);
  }

  /**
   * One render-only man, with his kit resolved from a hash rather than from the pool.
   *
   * A sibling of `pushSoldier` rather than a parameterisation of it: that method reads
   * fourteen per-pool-index arrays, and threading an override through every one of them to
   * serve four men an elephant would make the hot path — eight thousand calls a frame —
   * carry a branch it never needs.
   */
  private pushCrewman(
    tier: Tier,
    x: number, y: number, z: number,
    facing: number,
    scale: number,
    def: UnitTypeDef,
    seed: number,
    clip: Clip,
    hostIndex: number,
    /** Playhead 0-1 for a one-shot, or undefined to run the clip on the shared clock. */
    phase?: number,
    /** Full-body orientation, for a man who is not standing up. See `iQuat` in the shader. */
    quat?: THREE.Quaternion
  ): void {
    const buf = tier.buf;
    const n = buf.count;
    if ((n + 1) * Stride.Pos > buf.pos.length) return;

    // Resolved once per (unit type, station) and cached, because `resolveKit` does about
    // twenty hashes and this runs four times per animal per frame.
    const key = `${def.id}:${seed}`;
    let kit = this.crewKit.get(key);
    if (!kit) {
      kit = resolveKit(def, hash01(seed, 3), emptyKit());
      this.crewKit.set(key, kit);
    }

    buf.pos[n * 3] = x;
    buf.pos[n * 3 + 1] = y;
    buf.pos[n * 3 + 2] = z;
    const o = n * Stride.Orient;
    buf.orient[o] = facing;
    buf.orient[o + 1] = scale;
    buf.orient[o + 2] = 0;
    buf.orient[o + 3] = this.battle.pool.grime[hostIndex] * 0.6;
    const q = n * Stride.Quat;
    if (quat) {
      buf.quat[q] = quat.x; buf.quat[q + 1] = quat.y;
      buf.quat[q + 2] = quat.z; buf.quat[q + 3] = quat.w;
    } else {
      buf.quat[q] = 0; buf.quat[q + 1] = 0; buf.quat[q + 2] = 0; buf.quat[q + 3] = 0;
    }

    const facts = this.manFacts[FOOT_CLIP_MAP[clip]];
    // Desynchronised from his own hash: four men on one animal all breathing in time is the
    // same uniformity tell as a rank of identical legionaries, at four times the magnification
    // because they are three metres up and silhouetted against the sky. A one-shot — a man
    // being thrown off the animal — is driven by its caller instead and must not wrap.
    const ph = phase !== undefined
      ? Math.min(1, phase)
      : (hash01(seed, 71) + this.animClock * facts.invDuration) % 1;
    const f = ph * facts.frames;
    const f0 = Math.min(facts.frames - 1, Math.floor(f));
    const f1 = facts.loop ? (f0 + 1) % facts.frames : Math.min(f0 + 1, facts.frames - 1);
    const a = n * Stride.AnimA;
    buf.animA[a] = facts.rowBase + f0;
    buf.animA[a + 1] = facts.rowBase + f1;
    buf.animA[a + 2] = f - Math.floor(f);
    buf.animA[a + 3] = 1;
    buf.animB[a] = facts.rowBase + f0;
    buf.animB[a + 1] = facts.rowBase + f0;
    buf.animB[a + 2] = 0;
    buf.animB[a + 3] = hash01(seed, 3);

    const k = n * Stride.Kit;
    const coarse = tier === this.soldierTiers[0][2]
      || tier === this.soldierTiers[1][2]
      || tier === this.soldierTiers[2][2];
    buf.kit[k] = coarse ? kit.maskCoarse : kit.maskLo;
    buf.kit[k + 1] = coarse ? 0 : kit.maskHi;

    const c = n * Stride.Col0;
    buf.col0[c] = kit.tunic[0];
    buf.col0[c + 1] = kit.tunic[1];
    buf.col0[c + 2] = kit.tunic[2];
    buf.col0[c + 3] = kit.emblem;
    buf.col1[c] = kit.leg[0];
    buf.col1[c + 1] = kit.leg[1];
    buf.col1[c + 2] = kit.leg[2];
    buf.col1[c + 3] = kit.metal;

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
    // The atlas row, which is the faction index. This was `faction === Rome ? 0 : 1`, a
    // two-row assumption that would have put every distant Carthaginian into the Juthungi
    // warband billboard — the wrong army, silently, and only past the LOD2 boundary.
    buf.col0[c + 3] = faction;
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

  /**
   * Publish the radial distance band a tier's instances actually occupy this frame.
   *
   * `LightingSystem` reads this off `userData` and uses it to skip the cascades the tier
   * cannot reach — see `SHADOW_BAND_MARGIN` there for why it is allowed to.
   *
   * **Measured off the instance buffer, not derived from `lodDist`.** The derivation looks
   * obvious and is wrong: a settled corpse is drawn one tier coarser than his distance gives,
   * so the LOD1 buffer holds bodies at five metres, and a band of `[lodDist[0], lodDist[1]]`
   * would have skipped cascade 0 for a tier that by the late battle holds a thousand corpses
   * piled directly under the camera. Cavalry past the billboard edge are likewise held at
   * LOD2, stretching that tier's far end past `lodDist[2]`. Reading the buffer is immune to
   * both, and to the next promotion rule somebody adds without thinking of this.
   *
   * One pass over the positions already written, squared throughout with a single square root
   * per tier at the end.
   */
  private publishBand(t: Tier, camX: number, camY: number, camZ: number): void {
    const n = t.buf.count;
    if (n === 0) {
      t.mesh.userData.shadowRadialBand = undefined;
      return;
    }
    const p = t.buf.pos;
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const dx = p[i * 3] - camX;
      const dy = p[i * 3 + 1] - camY;
      const dz = p[i * 3 + 2] - camZ;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < lo) lo = d2;
      if (d2 > hi) hi = d2;
    }
    t.mesh.userData.shadowRadialBand = [Math.sqrt(lo), Math.sqrt(hi)];
  }

  private flush(camX: number, camY: number, camZ: number): void {
    // With the bench active nobody is drawn but the one machine. Enforced here rather than at
    // emission because `push` rewrites `mesh.visible` from the instance count every frame, so a
    // probe that reached in and set `visible = false` would have it restored on the next tick —
    // which is exactly what happened, and produced a "single machine" plate with the whole crew
    // still standing in front of it.
    const men = this.benchOnly ? 0 : -1;
    const push = (t: Tier, full: boolean): void => {
      const n = men === 0 ? 0 : t.buf.count;
      t.geometry.instanceCount = n;
      t.mesh.visible = n > 0;
      if (n === 0) {
        t.mesh.userData.shadowRadialBand = undefined;
        return;
      }
      const mark = (a: THREE.InstancedBufferAttribute, stride: number): void => {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * stride);
        a.needsUpdate = true;
      };
      this.publishBand(t, camX, camY, camZ);
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
    if (this.elephantTier) push(this.elephantTier, true);
    if (this.impostorTier) push(this.impostorTier, false);

    for (const e of this.engineTiers) {
      if (!e) continue;
      e.geometry.instanceCount = e.count;
      e.mesh.visible = e.count > 0;
      if (e.count === 0) continue;
      for (const [a, stride] of [
        [e.attrs.pos, 3], [e.attrs.orient, 4], [e.attrs.state, 4],
      ] as const) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, e.count * stride);
        a.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const row of this.soldierTiers) for (const t of row) t.geometry.dispose();
    for (const t of this.horseTiers) t.geometry.dispose();
    this.impostorTier?.geometry.dispose();
    this.impostorMat?.dispose();
    this.impostors?.dispose();
    for (const t of this.engineTiers) t?.geometry.dispose();
    this.engineMat?.dispose();
    for (const m of this.mats) m.dispose();
    this.manAnim.dispose();
    this.horseAnim.dispose();
    this.atlas.dispose();
    this.group.removeFromParent();
  }
}
