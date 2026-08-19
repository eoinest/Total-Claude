import * as THREE from 'three';
import { Clip, Faction, type UnitTypeDef } from '../sim/types';
import { bakeAnimTexture, type AnimTexture } from '../anim/animTexture';
import {
  FOOT_CLIP_MAP, HORSE_CLIP_SET, HORSE_GAIT_LADDER, MAN_CLIP_SET, bakePointTrack,
  meanPointOverClip,
} from '../anim/clips';
import { ELEPHANT_CLIP, ELEPHANT_CLIP_SET } from '../anim/elephantClips';
import { MAN_RIG, MB, restPos } from '../anim/rig';
import { makeSoldierMaterial, type PoseVaryBones, type SoldierMaterialSet } from '../anim/skinShader';
import { EMBLEM_COLS, EMBLEM_ORIGIN, EMBLEM_TILE, buildSoldierAtlas, type SoldierAtlas } from '../units/atlas';
import {
  ELEPHANT_GROUND_LIFT, ELEPHANT_MASK_LO, HOWDAH, HOWDAH_BONES, HOWDAH_STATIONS,
  MAHOUT_BONES, MAHOUT_SEAT, buildElephantGeometry,
} from '../units/elephantMesh';
import {
  HORSE_GROUND_LIFT, HORSE_MASK_LO, SADDLE_BONES, SADDLE_SEAT, buildHorseGeometry,
} from '../units/horseMesh';
import { Piece, emptyKit, mounted, resolveKit, ridesElephant, type ResolvedKit } from '../units/kit';
import { hash01 } from '../util/rand';
import { buildSoldierGeometry, type Lod } from '../units/soldierMesh';
import {
  buildImpostorGeometry, makeImpostorMaterial, renderImpostorAtlas, type ImpostorAtlas,
} from '../units/impostor';
import {
  CREW_FALL_SIDE, CREW_GROUND_LIFT, CREW_LAND_OUT, CREW_THROW_ARC, CREW_THROW_LEN,
  CREW_THROW_START, MAN_POSE_VARY,
} from '../units/UnitRenderSystem';
import { chainPartsDebug } from './partsDebug';

/**
 * Eight constants this page used to restate, and now imports.
 *
 * `MAN_POSE_VARY` and the six `CREW_*` figures were hand-copied here with comments saying so,
 * and the copy had drifted: `CREW_FALL_SIDE` read `+1` against the render system's `-1`, so
 * every carcass frame shot on this page threw the four crew onto the flank the animal rolls
 * *away* from. `LOD_FRACTION` is imported in `main.ts` for the same reason. Nothing in
 * `UnitRenderSystem` runs on import — the module's side effects are all inside the class — so
 * the cost of the dependency is the module graph and nothing else.
 */

/**
 * Posing one man outside the battle.
 *
 * ## Why this file has to exist at all
 * There is no `SkinnedMesh` in this project to grab and orbit. A soldier is not an object;
 * he is a *row of instance attributes* pointing into two shared resources — a geometry that
 * is the union of every kit piece his faction can field, and a bone texture holding
 * quaternion+translation for every frame of every clip. The mesh in the scene graph is one
 * `THREE.Mesh` per faction × LOD holding thousands of men, and which man you are looking at
 * is decided entirely by `iPos`, `iOrient`, `iAnimA/B`, `iKit`, `iCol0/1` and `iQuat`.
 *
 * So a viewer cannot "load the model". It has to re-implement the emit half of
 * `UnitRenderSystem` — the twenty-odd floats per man — while replacing the sim half (which
 * man, where, in what state) with a UI. That is what this is: the same instance-attribute
 * contract, driven by a playhead the user scrubs instead of by a battle.
 *
 * Everything expensive is shared exactly as the game shares it: one atlas, one man bone
 * texture, one horse bone texture, one material set per rig. Building a tier is only a
 * geometry plus eight `InstancedBufferAttribute`s, so tiers are built lazily per faction —
 * which also means a faction added to the roster after this file was written appears in the
 * viewer without touching it.
 *
 * ## What is deliberately *not* reproduced
 * Distance-driven LOD selection, frustum culling, gait hysteresis and corpse ragdolling all
 * belong to the battle. The viewer sets LOD by hand precisely because you want to compare
 * tiers at one distance, which the game will never do.
 */

/** Instances per tier. Enough for the widest variance grid (a 6×4 rank) with headroom. */
const CAP = 48;

/** Rider clearance above the saddle, metres. Matches `SEAT_RISE` in the render system. */
const SEAT_RISE = 0.07;

/** Scratch for the thrown crew's lie-down quaternion — four per animal per frame. */
const qCrew = new THREE.Quaternion();
const qCrewTip = new THREE.Quaternion();
const vCrewAxis = new THREE.Vector3();
const AXIS_UP = new THREE.Vector3(0, 1, 0);

/** Playback facts for one packed clip, read once so the per-frame write does no lookups. */
export interface ClipFacts {
  readonly index: number;
  readonly name: string;
  readonly rowBase: number;
  readonly frames: number;
  readonly loop: boolean;
  readonly duration: number;
  readonly rootSpeed: number;
  readonly hitFrame: number;
}

const factsOf = (set: typeof MAN_CLIP_SET): ClipFacts[] =>
  set.clips.map((c, i) => ({
    index: i,
    name: c.name,
    rowBase: set.rows[i],
    frames: c.frames,
    loop: c.loop,
    duration: c.duration,
    rootSpeed: c.rootSpeed,
    hitFrame: c.hitFrame ?? -1,
  }));

/** One man to draw. Everything the instance attributes need, and nothing else. */
export interface ManPose {
  def: UnitTypeDef;
  /** His stable 0..1 hash — the single input to every appearance decision. */
  variant: number;
  /** 0-2 are mesh tiers; 3 is the billboard impostor. */
  lod: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  z: number;
  yaw: number;
  clip: number;
  /** Normalised playhead within the clip, 0..1. */
  phase: number;
  /** Body scale: the roster's `heightScale` times this man's own stature draw. */
  scale: number;
  lean: number;
  grime: number;
  /** Draw the melee weapon rather than the missile one. */
  melee: boolean;
  /** Bitwise AND applied to the resolved masks, for piece isolation. -1 leaves them alone. */
  maskFilterLo: number;
  maskFilterHi: number;
  maskFilterCoarse: number;
  /**
   * Full-body orientation, for a man who is not standing up — `iQuat` in the shader.
   *
   * Zero or absent is a living man. Anything else sends the shader down the corpse branch,
   * which is what a crewman thrown off a dying elephant needs and what the viewer had no way
   * of expressing before: every man it could draw was upright by construction.
   */
  quat?: readonly [number, number, number, number];
}

/** One war elephant to draw. The animal only; its crew come back from `elephantCrew`. */
export interface ElephantPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Index into `ELEPHANT_CLIP_SET` — see `elephantFacts`. */
  clip: number;
  phase: number;
  /** Stable 0..1 hash: size, caparison dye and the crew's own seeds all come from it. */
  variant: number;
  /**
   * How far through the collapse, 0..1.
   *
   * In the game this is `eleDeath[i]`, advanced on the death clip's own duration, so it and
   * the animal's playhead are the same number while it is dying. Passing it separately keeps
   * the viewer able to scrub a carcass with the clip held at its last frame.
   */
  fall: number;
}

/** Where one crewman goes this frame — a station on the animal, or a man in the air. */
export interface CrewPlacement {
  x: number;
  y: number;
  z: number;
  facing: number;
  scale: number;
  /** His own 0..1 hash, which is what `resolveKit` reads. */
  variant: number;
  /** Index into `MAN_CLIP_SET`, already mapped out of the `Clip` enum. */
  clip: number;
  /** Playhead for a one-shot fall, or undefined to run on the shared clock. */
  phase?: number;
  quat?: [number, number, number, number];
  mahout: boolean;
  /** Off the animal and in the air or on the ground. */
  thrown: boolean;
}

/**
 * The lighting the impostor atlas is captured under.
 *
 * `key` exists so the rig can tell one lighting setup from another without comparing colours:
 * the atlas is a photograph, and a photograph taken under the studio probe is the wrong
 * picture to show beside a mesh lit by the battle's sun.
 */
export interface CaptureLight {
  key: string;
  direction: THREE.Vector3;
  colour: THREE.Color;
  ambient: THREE.Color;
}

/** Where a rider goes, plus the two points that prove it. */
export interface SeatSolution {
  x: number;
  y: number;
  z: number;
  lean: number;
  /** World position of the animated saddle seat this frame. */
  saddle: [number, number, number];
  /** World position of the rider's pelvis once he is placed. */
  pelvis: [number, number, number];
}

/** A mount, and where its rider ends up. */
export interface HorsePose {
  lod: Lod;
  x: number;
  y: number;
  z: number;
  yaw: number;
  clip: number;
  phase: number;
  variant: number;
}

interface Tier {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attrs: Record<string, THREE.InstancedBufferAttribute>;
  buf: {
    pos: Float32Array; orient: Float32Array; animA: Float32Array; animB: Float32Array;
    kit: Float32Array; col0: Float32Array; col1: Float32Array; quat: Float32Array;
  };
  count: number;
  /** Triangles in one instance, measured off the geometry rather than quoted. */
  tris: number;
}

export class SoldierRig {
  readonly group = new THREE.Group();
  readonly manFacts: ClipFacts[];
  readonly horseFacts: ClipFacts[];
  readonly elephantFacts: ClipFacts[];

  private readonly atlas: SoldierAtlas;
  private readonly manAnim: AnimTexture;
  private readonly horseAnim: AnimTexture;
  private readonly elephantAnim: AnimTexture;
  private readonly manMat: SoldierMaterialSet;
  private readonly horseMat: SoldierMaterialSet;
  private readonly elephantMat: SoldierMaterialSet;
  private readonly baseParams: THREE.MeshStandardMaterialParameters;

  /** Lazily built, keyed `faction:lod` — so a faction added to the roster just works. */
  private readonly manTiers = new Map<string, Tier>();
  private readonly boundsCache = new Map<string, Map<number, { cx: number; cy: number; cz: number; r: number }>>();
  private readonly triCache = new Map<string, Map<number, number>>();
  private readonly headTrack = new Map<Faction, Float32Array>();
  private readonly horseTiers = new Map<number, Tier>();
  /** One tier, no LOD chain — `elephantMesh.ts` explains why, and the viewer must not invent one. */
  private elephantTierCache?: Tier;
  private elephantBox?: { cx: number; cy: number; cz: number; hw: number; hh: number; hd: number };
  private impostorTier?: Tier;
  private impostors?: ImpostorAtlas;
  private impostorMat?: THREE.MeshBasicMaterial;
  private impostorKey = '';

  /** Where the saddle is on every frame of every gait, and each rider clip's own seat. */
  private readonly saddleTrack: Float32Array;
  private readonly riderSeatY: Float32Array;
  private readonly riderSeatZ: Float32Array;
  /** Animated howdah floor and mahout seat, three floats per elephant animation row. */
  private readonly howdahTrack: Float32Array;
  private readonly mahoutTrack: Float32Array;

  private readonly kitScratch: ResolvedKit = emptyKit();
  private elapsed = 0;
  /**
   * Triangles this frame's instances actually rasterise.
   *
   * Accumulated as they are pushed, because `renderer.info.render.triangles` cannot answer
   * this and never could: an instanced draw submits the whole index buffer whatever the kit
   * mask says, and the pieces the man is not wearing are collapsed to zero-area triangles in
   * the *vertex* shader — they are counted, then discarded at the rasteriser. So the reported
   * figure is union x instances x passes, which for a 24-man rank overstates the real
   * rasterised load by about 3x. That is a load proxy; this is the asset cost.
   */
  private drawn = 0;

  constructor(anisotropy: number) {
    this.atlas = buildSoldierAtlas(anisotropy);
    this.manAnim = bakeAnimTexture(MAN_CLIP_SET, 'man');
    this.horseAnim = bakeAnimTexture(HORSE_CLIP_SET, 'horse');
    this.elephantAnim = bakeAnimTexture(ELEPHANT_CLIP_SET, 'elephant');
    this.manFacts = factsOf(MAN_CLIP_SET);
    this.horseFacts = factsOf(HORSE_CLIP_SET);
    this.elephantFacts = factsOf(ELEPHANT_CLIP_SET);

    // Copied from `UnitRenderSystem.ts:513-556`. The numbers carry measurements in their
    // comments there; changing any of them here would make the viewer show a man the game
    // does not draw, which defeats the point of the tool.
    this.baseParams = {
      map: this.atlas.albedo,
      normalMap: this.atlas.normal,
      roughnessMap: this.atlas.orm,
      metalnessMap: this.atlas.orm,
      aoMap: this.atlas.orm,
      aoMapIntensity: 0.6,
      envMapIntensity: 2.9,
      roughness: 1,
      metalness: 1,
      normalScale: new THREE.Vector2(0.9, 0.9),
      side: THREE.FrontSide,
      dithering: true,
    };

    this.manMat = makeSoldierMaterial(this.baseParams, {
      anim: this.manAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      emblemCols: EMBLEM_COLS,
      leanHeight: 1.5,
      poseVary: MAN_POSE_VARY,
    });
    this.horseMat = makeSoldierMaterial(this.baseParams, {
      anim: this.horseAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      emblemCols: EMBLEM_COLS,
      leanHeight: 1.7,
    });
    // The elephant gets its own material because it gets its own animation texture: the rig
    // has 31 bones against the horse's 29 and none of the clips are shared. Same program,
    // same uniforms, one more texture — which is exactly what the game does at
    // `UnitRenderSystem.ts:786`, and the reason the animal is one draw call whatever it is
    // doing. `leanHeight` is the game's 3.0: four tonnes does not bank into a turn.
    this.elephantMat = makeSoldierMaterial(this.baseParams, {
      anim: this.elephantAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      emblemCols: EMBLEM_COLS,
      leanHeight: 3.0,
    });
    // Distinct tags, because `makeSoldierMaterial` keys its program cache on the rig flag
    // alone and two chained materials sharing a key would get each other's shader.
    chainPartsDebug(this.manMat.material, 'man');
    chainPartsDebug(this.horseMat.material, 'horse');
    chainPartsDebug(this.elephantMat.material, 'elephant');

    /**
     * Where the howdah floor and the mahout's seat are on every frame, including the death
     * clip's.
     *
     * The same decomposition the saddle uses, and it exists for the same recorded reason: a
     * rider's boots were once placed *on* the saddle because a rest-pose offset was added to
     * the ground rather than to the mount, leaving him a measured 0.95 m in the air. Here it
     * is four men on a platform three metres up, so the error would be four times as visible
     * — and the whole point of a carcass view is that these two tracks carry the crew *down*
     * with the animal before they let go.
     */
    this.howdahTrack = bakePointTrack(
      ELEPHANT_CLIP_SET, [0, HOWDAH.y, HOWDAH.z],
      HOWDAH_BONES.bone0, HOWDAH_BONES.bone1, HOWDAH_BONES.weight0
    );
    this.mahoutTrack = bakePointTrack(
      ELEPHANT_CLIP_SET, [0, MAHOUT_SEAT.y, MAHOUT_SEAT.z],
      MAHOUT_BONES.bone0, MAHOUT_BONES.bone1, MAHOUT_BONES.weight0
    );

    this.saddleTrack = bakePointTrack(
      HORSE_CLIP_SET,
      [0, SADDLE_SEAT.y, SADDLE_SEAT.z],
      SADDLE_BONES.bone0, SADDLE_BONES.bone1, SADDLE_BONES.weight0
    );
    const pelvisTrack = bakePointTrack(
      MAN_CLIP_SET, restPos(MAN_RIG, MB.pelvis, [0, 0, 0]), MB.pelvis
    );
    this.riderSeatY = new Float32Array(MAN_CLIP_SET.clips.length);
    this.riderSeatZ = new Float32Array(MAN_CLIP_SET.clips.length);
    for (let c = 0; c < MAN_CLIP_SET.clips.length; c++) {
      const m = meanPointOverClip(MAN_CLIP_SET, pelvisTrack, c);
      this.riderSeatY[c] = m[1];
      this.riderSeatZ[c] = m[2];
    }

    this.group.name = 'viewer-soldiers';
  }

  /**
   * The atlas-bound material parameters, so the siege engines can be built on the same base.
   *
   * Not a convenience. `makeEngineMaterial` runs `metalness: 1` and `roughness: 1` and reads
   * both out of the atlas ORM tile per texel; handed a base with no maps it takes those
   * literals at face value and renders a mirror-finish white machine under any probe. That
   * is exactly what the first pass of this viewer drew.
   */
  /**
   * Pin the kit cavity gate, for an interleaved A/B.
   *
   * Cross-session before/after is not a measurement on this project — two runs at identical
   * configuration differ on 50-70 % of pixels — so a feature has to be switchable *inside*
   * one page session, and the base arm re-shot last as a drift check. The uniform object is
   * shared between the shader and `material.userData`, so writing it here reaches the GPU on
   * the next frame with no recompile.
   */
  setKitCavity(v: number): boolean {
    let hit = false;
    for (const m of [this.manMat.material, this.horseMat.material]) {
      const u = m.userData.kitCavity as { value: number } | undefined;
      if (u) { u.value = v; hit = true; }
    }
    return hit;
  }

  get materialBase(): THREE.MeshStandardMaterialParameters {
    return this.baseParams;
  }

  // -------------------------------------------------------------------------
  // Tier plumbing
  // -------------------------------------------------------------------------

  private makeTier(
    geometry: THREE.InstancedBufferGeometry,
    mat: SoldierMaterialSet,
    name: string
  ): Tier {
    const buf = {
      pos: new Float32Array(CAP * 3),
      orient: new Float32Array(CAP * 4),
      animA: new Float32Array(CAP * 4),
      animB: new Float32Array(CAP * 4),
      kit: new Float32Array(CAP * 2),
      col0: new Float32Array(CAP * 4),
      col1: new Float32Array(CAP * 4),
      quat: new Float32Array(CAP * 4),
    };
    const attr = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs: Record<string, THREE.InstancedBufferAttribute> = {
      iPos: attr(buf.pos, 3),
      iOrient: attr(buf.orient, 4),
      iAnimA: attr(buf.animA, 4),
      iAnimB: attr(buf.animB, 4),
      iKit: attr(buf.kit, 2),
      iCol0: attr(buf.col0, 4),
      iCol1: attr(buf.col1, 4),
      iQuat: attr(buf.quat, 4),
    };
    for (const [k, v] of Object.entries(attrs)) geometry.setAttribute(k, v);
    geometry.instanceCount = 0;

    const mesh = new THREE.Mesh(geometry, mat.material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // The bounding sphere describes the rest pose at the origin, not where the shader puts
    // the instances, so three's object-level test would cull a man standing off to one side
    // of an LOD ladder. Same reason the game disables it.
    mesh.frustumCulled = false;
    mesh.customDepthMaterial = mat.depth;
    mesh.customDistanceMaterial = mat.distance;
    mesh.visible = false;
    this.group.add(mesh);

    const idx = geometry.getIndex();
    return { mesh, geometry, attrs, buf, count: 0, tris: idx ? idx.count / 3 : 0 };
  }

  private manTier(faction: Faction, lod: Lod): Tier {
    const key = `${faction}:${lod}`;
    let t = this.manTiers.get(key);
    if (!t) {
      t = this.makeTier(
        buildSoldierGeometry(faction, lod), this.manMat, `viewer-man-${faction}-lod${lod}`
      );
      this.manTiers.set(key, t);
    }
    return t;
  }

  private horseTier(lod: Lod): Tier {
    let t = this.horseTiers.get(lod);
    if (!t) {
      t = this.makeTier(buildHorseGeometry(lod), this.horseMat, `viewer-horse-lod${lod}`);
      this.horseTiers.set(lod, t);
    }
    return t;
  }

  private elephantTier(): Tier {
    if (!this.elephantTierCache) {
      this.elephantTierCache = this.makeTier(
        buildElephantGeometry(), this.elephantMat, 'viewer-war-elephants'
      );
    }
    return this.elephantTierCache;
  }

  elephantTriangles(): number {
    return this.elephantTier().tris;
  }

  /**
   * The animal's rest-pose extents, measured off the geometry rather than written down.
   *
   * A framing constant for a subject this size is a constant that goes stale the first time
   * anyone re-authors the tower — and the failure is silent, because a camera fitted to the
   * wrong box still produces a picture. Reading the buffer costs one pass at first use.
   */
  elephantBounds(): { cx: number; cy: number; cz: number; hw: number; hh: number; hd: number } {
    if (this.elephantBox) return this.elephantBox;
    const pos = this.elephantTier().geometry.getAttribute('position');
    let x0 = Infinity; let y0 = Infinity; let z0 = Infinity;
    let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
      if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
    }
    this.elephantBox = {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2 + ELEPHANT_GROUND_LIFT,
      cz: (z0 + z1) / 2,
      hw: Math.max(0.5, (x1 - x0) / 2),
      hh: Math.max(0.5, (y1 - y0) / 2),
      hd: Math.max(0.5, (z1 - z0) / 2),
    };
    return this.elephantBox;
  }

  /**
   * Triangles in a tier's whole geometry — the *union* of every kit piece the faction fields.
   *
   * This is not what one man costs and the viewer must not present it as if it were. The
   * geometry is shared by every man of the faction and the shader collapses the pieces he is
   * not wearing to a point, so an archer with no shield and a legionary with a scutum draw the
   * same buffer at the same vertex cost but rasterise very different amounts. `drawnTriangles`
   * is the per-man figure.
   */
  triangles(faction: Faction, lod: 0 | 1 | 2 | 3): number {
    if (lod === 3) return 2;
    return this.manTier(faction, lod).tris;
  }

  /**
   * Triangles per piece id, counted off the index buffer.
   *
   * A triangle is attributed to the piece of its first vertex. Safe here because the mesh
   * builder emits each piece as its own run of triangles — no triangle spans two piece ids,
   * and if one ever did, the shader's own visibility test would already be ambiguous about it.
   */
  pieceTriangles(faction: Faction, lod: Lod): Map<number, number> {
    const key = `${faction}:${lod}`;
    let m = this.triCache.get(key);
    if (m) return m;
    m = new Map<number, number>();
    const geo = this.manTier(faction, lod).geometry;
    const idx = geo.getIndex();
    const pid = geo.getAttribute('aPieceTint');
    if (idx && pid) {
      for (let t = 0; t < idx.count; t += 3) {
        const id = Math.round(pid.getX(idx.getX(t)));
        m.set(id, (m.get(id) ?? 0) + 1);
      }
    }
    this.triCache.set(key, m);
    return m;
  }

  /** What this man's mask actually rasterises, as opposed to what the buffer contains. */
  drawnTriangles(faction: Faction, lod: Lod, pieces: readonly number[]): number {
    const per = this.pieceTriangles(faction, lod);
    let n = 0;
    for (const p of pieces) n += per.get(p) ?? 0;
    return n;
  }

  /**
   * The man's stature this frame, in metres, measured rather than assumed.
   *
   * Takes the highest vertex bound to the head bone in bind space, bakes its position over
   * every packed clip through the same forward kinematics the bone texture was baked from,
   * and reads it back. So this is the top of the *skull*, not of a plume — a crest would make
   * a 1.75 m man measure 1.95 m and nobody's height includes their hat.
   *
   * This exists because a checkered pole in a perspective camera cannot answer "how tall is
   * he": the subject and the pole are never at exactly the same depth, and the viewer that
   * only draws a ruler is asking you to eyeball a foreshortening correction.
   */
  statureAt(faction: Faction, clip: number, phase: number, scale: number): number {
    let track = this.headTrack.get(faction);
    if (!track) {
      const geo = this.manTier(faction, 0).geometry;
      const pos = geo.getAttribute('position');
      const skin = geo.getAttribute('aSkin');
      const pid = geo.getAttribute('aPieceTint');
      const top: [number, number, number] = [0, 1.7, 0];
      if (pos && skin && pid) {
        let best = -Infinity;
        for (let i = 0; i < pos.count; i++) {
          // Head bone, and the `Head` piece specifically: hair and helmets sit proud of the
          // skull and are not part of a man's height.
          if (Math.round(skin.getX(i)) !== MB.head) continue;
          if (Math.round(pid.getX(i)) !== Piece.Head) continue;
          const y = pos.getY(i);
          if (y > best) {
            best = y;
            top[0] = pos.getX(i);
            top[1] = y;
            top[2] = pos.getZ(i);
          }
        }
      }
      track = bakePointTrack(MAN_CLIP_SET, top, MB.head);
      this.headTrack.set(faction, track);
    }
    const f = this.manFacts[clip] ?? this.manFacts[0];
    const frame = Math.min(f.frames - 1, Math.max(0, Math.floor(phase * f.frames)));
    return track[(f.rowBase + frame) * 3 + 1] * scale;
  }

  /**
   * Standing stature: the tallest the skull gets over a chosen clip.
   *
   * `statureAt` is the head height on the frame in front of you, which moves — a man in a
   * lunging overhead cut measures 1.57 m and that is not his height. For a *scale* review you
   * want the standing figure, so this takes the maximum over the clip and says which one it
   * used. Both numbers are shown, because they answer different questions.
   */
  restStature(faction: Faction, clip: number, scale: number): number {
    const f = this.manFacts[clip] ?? this.manFacts[0];
    let best = 0;
    for (let fr = 0; fr < f.frames; fr++) {
      const h = this.statureAt(faction, clip, (fr + 0.5) / f.frames, scale);
      if (h > best) best = h;
    }
    return best;
  }

  /**
   * How the saddle moves through a whole gait, and what the seating solve does about it.
   *
   * Returned as numbers because a probe that draws two dots and refuses to say how far apart
   * they are is not a measurement. `clearance` is the rider's pelvis above the saddle top and
   * `drift` is how much that clearance varies across every frame of the gait — the figure that
   * decides whether the rider is pinned to the animal or floating over an average of it.
   */
  seatReport(gait: number, riderClip: number, scale: number): {
    clearance: number; drift: number; low: number; high: number; frames: number;
  } {
    const hf = this.horseFacts[gait] ?? this.horseFacts[0];
    let low = Infinity;
    let high = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    for (let f = 0; f < hf.frames; f++) {
      const seat = (hf.rowBase + f) * 3;
      const saddleY = HORSE_GROUND_LIFT + this.saddleTrack[seat + 1];
      const riderY = saddleY + SEAT_RISE - this.riderSeatY[riderClip] * scale;
      const pelvisY = riderY + this.riderSeatY[riderClip] * scale;
      const c = pelvisY - saddleY;
      if (saddleY < low) low = saddleY;
      if (saddleY > high) high = saddleY;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    return { clearance: (minC + maxC) / 2, drift: maxC - minC, low, high, frames: hf.frames };
  }

  /**
   * Rest-pose bounds of every piece id in a tier's geometry.
   *
   * So that soloing a piece can *put the camera on it*. Without this, isolating a helmet
   * leaves you looking at an empty frame with the helmet somewhere off the top edge, and the
   * instrument answers "is it there" with a shrug — which is the exact failure it exists to
   * prevent.
   *
   * These are bind-space positions, not posed ones: the shader applies the bone transform, so
   * a piece bound to a swinging arm is not where this says at every frame. Good enough to aim
   * a camera at, and the alternative — reading back a posed bounding box from the GPU — would
   * cost a readback per frame for a control that is used once per click.
   */
  pieceBounds(faction: Faction, lod: Lod): Map<number, { cx: number; cy: number; cz: number; r: number }> {
    const key = `${faction}:${lod}`;
    let m = this.boundsCache.get(key);
    if (m) return m;
    m = new Map();
    const geo = this.manTier(faction, lod).geometry;
    const pos = geo.getAttribute('position');
    const pid = geo.getAttribute('aPieceTint');
    if (pos && pid) {
      const box = new Map<number, number[]>();
      for (let i = 0; i < pos.count; i++) {
        const id = Math.round(pid.getX(i));
        let b = box.get(id);
        if (!b) {
          b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
          box.set(id, b);
        }
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x;
        if (y > b[4]) b[4] = y;
        if (z > b[5]) b[5] = z;
      }
      for (const [id, b] of box) {
        m.set(id, {
          cx: (b[0] + b[3]) / 2,
          cy: (b[1] + b[4]) / 2,
          cz: (b[2] + b[5]) / 2,
          r: Math.max(0.06, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2),
        });
      }
    }
    this.boundsCache.set(key, m);
    return m;
  }

  horseTriangles(lod: Lod): number {
    return this.horseTier(lod).tris;
  }

  // -------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------

  /** Rasterised triangles pushed this frame — see `drawn`. */
  get drawnTotal(): number {
    return this.drawn;
  }

  begin(): void {
    this.drawn = 0;
    for (const t of this.manTiers.values()) t.count = 0;
    for (const t of this.horseTiers.values()) t.count = 0;
    if (this.elephantTierCache) this.elephantTierCache.count = 0;
    if (this.impostorTier) this.impostorTier.count = 0;
  }

  /**
   * Fill the two animation slots.
   *
   * `iAnimA` is (row0, row1, frac, blend) and `iAnimB` the clip being faded out. With no
   * cross-fade to run the viewer writes blend = 1, which makes the shader skip the second
   * four texel fetches entirely — but `iAnimB.w` is still read as the man's variant hash and
   * drives every colour and pose micro-decision, so it must carry a real value.
   */
  private writeAnim(
    t: Tier, n: number, facts: ClipFacts, phase: number, variant: number
  ): void {
    const f = phase * facts.frames;
    const f0 = Math.min(facts.frames - 1, Math.max(0, Math.floor(f)));
    const f1 = facts.loop ? (f0 + 1) % facts.frames : Math.min(f0 + 1, facts.frames - 1);
    const a = n * 4;
    t.buf.animA[a] = facts.rowBase + f0;
    t.buf.animA[a + 1] = facts.rowBase + f1;
    t.buf.animA[a + 2] = f - Math.floor(f);
    t.buf.animA[a + 3] = 1;
    t.buf.animB[a] = facts.rowBase + f0;
    t.buf.animB[a + 1] = facts.rowBase + f1;
    t.buf.animB[a + 2] = 0;
    t.buf.animB[a + 3] = variant;
  }

  pushMan(m: ManPose): void {
    if (m.lod === 3) {
      this.pushImpostor(m);
      return;
    }
    const t = this.manTier(m.def.faction, m.lod);
    const n = t.count;
    if (n >= CAP) return;

    const kit = resolveKit(m.def, m.variant, this.kitScratch);
    const facts = this.manFacts[m.clip] ?? this.manFacts[0];
    this.writeAnim(t, n, facts, m.phase, m.variant);

    t.buf.pos[n * 3] = m.x;
    t.buf.pos[n * 3 + 1] = m.y;
    t.buf.pos[n * 3 + 2] = m.z;

    const o = n * 4;
    t.buf.orient[o] = m.yaw;
    // Never zero: the shader multiplies the skinned position by it, so a scale of 0 collapses
    // the whole man onto his own origin and reads as "the model failed to load".
    t.buf.orient[o + 1] = Math.max(0.01, m.scale);
    t.buf.orient[o + 2] = m.lean;
    t.buf.orient[o + 3] = m.grime;

    // Zero is a living man. Non-zero sends the shader down the corpse branch and applies a
    // body-wide rotation plus a settle squash — which is what a crewman thrown off a dying
    // elephant needs, and the reason this is no longer hard-wired to zero.
    const q = m.quat;
    t.buf.quat[o] = q ? q[0] : 0;
    t.buf.quat[o + 1] = q ? q[1] : 0;
    t.buf.quat[o + 2] = q ? q[2] : 0;
    t.buf.quat[o + 3] = q ? q[3] : 0;

    const k = n * 2;
    if (m.lod === 2) {
      // The far mesh is authored to the eight `Coarse` silhouette groups, not the 36-piece
      // catalogue, so it takes a different mask in the same attribute.
      t.buf.kit[k] = kit.maskCoarse & m.maskFilterCoarse;
      t.buf.kit[k + 1] = 0;
    } else {
      t.buf.kit[k] = kit.maskLo & m.maskFilterLo;
      t.buf.kit[k + 1] = (m.melee ? kit.maskHiMelee : kit.maskHi) & m.maskFilterHi;
    }

    t.buf.col0[o] = kit.tunic[0];
    t.buf.col0[o + 1] = kit.tunic[1];
    t.buf.col0[o + 2] = kit.tunic[2];
    t.buf.col0[o + 3] = kit.emblem;
    t.buf.col1[o] = kit.leg[0];
    t.buf.col1[o + 1] = kit.leg[1];
    t.buf.col1[o + 2] = kit.leg[2];
    t.buf.col1[o + 3] = kit.metal;

    // The mask that just went into the buffer is the mask the rasteriser will honour, so this
    // is exact rather than an estimate.
    const per = this.pieceTriangles(m.def.faction, m.lod);
    const lo = t.buf.kit[k];
    const hi = t.buf.kit[k + 1];
    const bits = m.lod === 2 ? 8 : 48;
    for (let i = 0; i < bits; i++) {
      const set = i < 24 ? lo & (2 ** i) : hi & (2 ** (i - 24));
      if (set) this.drawn += per.get(i) ?? 0;
    }

    t.count = n + 1;
  }

  pushHorse(h: HorsePose): void {
    const t = this.horseTier(h.lod);
    const n = t.count;
    if (n >= CAP) return;

    const facts = this.horseFacts[h.clip] ?? this.horseFacts[0];
    this.writeAnim(t, n, facts, h.phase, h.variant);

    t.buf.pos[n * 3] = h.x;
    t.buf.pos[n * 3 + 1] = h.y + HORSE_GROUND_LIFT;
    t.buf.pos[n * 3 + 2] = h.z;

    const o = n * 4;
    t.buf.orient[o] = h.yaw;
    t.buf.orient[o + 1] = 1;
    t.buf.orient[o + 2] = 0;
    t.buf.orient[o + 3] = 0.08;
    t.buf.quat[o] = 0; t.buf.quat[o + 1] = 0; t.buf.quat[o + 2] = 0; t.buf.quat[o + 3] = 0;

    t.buf.kit[n * 2] = HORSE_MASK_LO;
    t.buf.kit[n * 2 + 1] = 0;

    // Coat bands from the render system: dark bay, bay, near-black, grey.
    const v = h.variant;
    const coat = v < 0.34 ? [0.28, 0.13, 0.06]
      : v < 0.62 ? [0.42, 0.2, 0.08]
        : v < 0.84 ? [0.11, 0.08, 0.07]
          : [0.55, 0.54, 0.52];
    t.buf.col0[o] = coat[0];
    t.buf.col0[o + 1] = coat[1];
    t.buf.col0[o + 2] = coat[2];
    t.buf.col0[o + 3] = 0;
    t.buf.col1[o] = coat[0] * 0.45;
    t.buf.col1[o + 1] = coat[1] * 0.45;
    t.buf.col1[o + 2] = coat[2] * 0.5;
    t.buf.col1[o + 3] = 0.5;

    // A horse wears its whole mesh; the mask is constant.
    this.drawn += t.tris;
    t.count = n + 1;
  }

  /**
   * Seat a rider on an animated horse.
   *
   * The offset is *not* a constant. The saddle is skinned to the barrel and loin, so where it
   * is on a given frame is only knowable by running the horse's forward kinematics — the back
   * rises and falls 15 cm through a gallop. Adding a rest-pose saddle height to a man whose
   * mesh origin is the ground is exactly the bug that once put a rider's boots on the seat and
   * left him a measured 0.95 m in the air; the fix is to place his *pelvis* on the animated
   * saddle by subtracting his own clip-mean pelvis height. Reproduced here rather than
   * approximated, because "is the rider sitting on the horse" is one of the things a viewer
   * exists to answer.
   *
   * Returns the world position and lean the rider should be pushed at.
   */
  seatRider(h: HorsePose, riderClip: number, scale: number): SeatSolution {
    const hf = this.horseFacts[h.clip] ?? this.horseFacts[HORSE_GAIT_LADDER[0]];
    const frame = Math.min(hf.frames - 1, Math.max(0, Math.floor(h.phase * hf.frames)));
    const seat = (hf.rowBase + frame) * 3;
    const saddleY = h.y + HORSE_GROUND_LIFT + this.saddleTrack[seat + 1];
    const saddleZ = this.saddleTrack[seat + 2];
    const y = saddleY + SEAT_RISE - this.riderSeatY[riderClip] * scale;
    const dz = saddleZ - this.riderSeatZ[riderClip] * scale;
    const x = h.x + Math.sin(h.yaw) * dz;
    const z = h.z + Math.cos(h.yaw) * dz;
    return {
      x, y, z,
      lean: 0.06,
      // Where the top of the saddle is this frame, and where the rider's own pelvis lands.
      // Drawing both is how you check the seating is right rather than merely plausible: the
      // gap between them should be one hip's clearance and stay constant through a gallop.
      saddle: [h.x + Math.sin(h.yaw) * saddleZ, saddleY, h.z + Math.cos(h.yaw) * saddleZ],
      pelvis: [
        x + Math.sin(h.yaw) * this.riderSeatZ[riderClip] * scale,
        y + this.riderSeatY[riderClip] * scale,
        z + Math.cos(h.yaw) * this.riderSeatZ[riderClip] * scale,
      ],
    };
  }

  // -------------------------------------------------------------------------
  // War elephant
  // -------------------------------------------------------------------------

  /**
   * The animal: one instance, one geometry, no LOD chain.
   *
   * A transcription of `UnitRenderSystem.pushElephant`, down to the caparison dye bands and
   * the polish on the chamfron dropping from 1.78 to 1.35 once it is going down. Two numbers
   * that look decorative and are not: the size draw is +/-10 % off the same stable hash, so a
   * line of animals is visibly not all one size; and the *dying* flag is the only appearance
   * difference between a live elephant and a carcass beyond the pose, so the carcass view
   * would flatter the model if it were dropped.
   */
  pushElephant(e: ElephantPose): void {
    const t = this.elephantTier();
    const n = t.count;
    if (n >= CAP) return;

    const facts = this.elephantFacts[e.clip] ?? this.elephantFacts[ELEPHANT_CLIP.idle];
    this.writeAnim(t, n, facts, e.phase, e.variant);

    t.buf.pos[n * 3] = e.x;
    t.buf.pos[n * 3 + 1] = e.y + ELEPHANT_GROUND_LIFT;
    t.buf.pos[n * 3 + 2] = e.z;

    const o = n * 4;
    t.buf.orient[o] = e.yaw;
    // Bulls and cows in one herd, a fifth either side of full size.
    t.buf.orient[o + 1] = this.elephantScale(e.variant);
    t.buf.orient[o + 2] = 0;
    t.buf.orient[o + 3] = 0;
    t.buf.quat[o] = 0; t.buf.quat[o + 1] = 0; t.buf.quat[o + 2] = 0; t.buf.quat[o + 3] = 0;

    t.buf.kit[n * 2] = ELEPHANT_MASK_LO & this.elephantMaskFilter;
    t.buf.kit[n * 2 + 1] = 0;

    // The caparison under the tower is the one dyed surface on the animal: Punic crimson and
    // purple, varied per animal because a mercenary army's cloth came from whatever lots the
    // quartermaster could buy.
    const v = e.variant;
    const cloth = v < 0.34 ? [0.20, 0.030, 0.055]
      : v < 0.68 ? [0.13, 0.022, 0.10] : [0.16, 0.055, 0.032];
    t.buf.col0[o] = cloth[0];
    t.buf.col0[o + 1] = cloth[1];
    t.buf.col0[o + 2] = cloth[2];
    t.buf.col0[o + 3] = 0;
    t.buf.col1[o] = 0.5; t.buf.col1[o + 1] = 0.5; t.buf.col1[o + 2] = 0.5;
    // A dead animal's kit stops being maintained.
    t.buf.col1[o + 3] = e.fall > 0 ? 1.35 : 1.78;

    // Only the three groups actually admitted rasterise; the rest collapse in the shader.
    const per = this.elephantPieceTriangles();
    for (let i = 0; i < 3; i++) if (t.buf.kit[n * 2] & (1 << i)) this.drawn += per.get(i) ?? 0;

    t.count = n + 1;
  }

  /** +/-10 % off the stable hash, exactly as the render system draws it. */
  elephantScale(variant: number): number {
    return 0.9 + variant * 0.2;
  }

  /**
   * The animal's own starting phase — salt 45, the same one `advanceElephant` uses.
   *
   * Sixteen four-tonne animals stepping in time was the single most-cited defect in the last
   * deck, named by three blind critics without prompting, and the fix in the render system is
   * this one hash. A rank view that started them all at zero would show a defect the game does
   * not have, which is the mirror image of the failure this viewer exists to prevent.
   */
  elephantPhaseOff(variant: number): number {
    return hash01(Math.floor(variant * 16777216), 45);
  }

  /** Triangles per `ElephantPiece`, counted off the index buffer like the man's. */
  elephantPieceTriangles(): Map<number, number> {
    let m = this.triCache.get('elephant');
    if (m) return m;
    m = new Map<number, number>();
    const geo = this.elephantTier().geometry;
    const idx = geo.getIndex();
    const pid = geo.getAttribute('aPieceTint');
    if (idx && pid) {
      for (let t = 0; t < idx.count; t += 3) {
        const id = Math.round(pid.getX(idx.getX(t)));
        m.set(id, (m.get(id) ?? 0) + 1);
      }
    }
    this.triCache.set('elephant', m);
    return m;
  }

  /** Bitwise AND on `ELEPHANT_MASK_LO`, so hide, barding and tower can be shown separately. */
  elephantMaskFilter = -1;

  /**
   * Mean Z of each authored group in the mesh's own bind frame — which way the animal faces.
   *
   * Not a curiosity. `framePlate`'s azimuth convention has been got wrong three times on the
   * man, every time by reasoning about it rather than photographing it, and the recorded
   * invariant is a *measurement*. This is the cheap half of it: the barding is the chamfron
   * over the forehead plus the bib across the chest, so if its centroid is at +Z the animal's
   * front is +Z, and a pixel sweep has to agree. An elephant's forward axis is not a man's by
   * assumption; it is only the same because this says so.
   */
  elephantGroupZ(): { hide: number; barding: number; tower: number } {
    const geo = this.elephantTier().geometry;
    const pos = geo.getAttribute('position');
    const pid = geo.getAttribute('aPieceTint');
    const sum = [0, 0, 0];
    const n = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const id = Math.round(pid.getX(i));
      if (id < 0 || id > 2) continue;
      sum[id] += pos.getZ(i);
      n[id]++;
    }
    return {
      hide: n[0] ? sum[0] / n[0] : 0,
      barding: n[1] ? sum[1] / n[1] : 0,
      tower: n[2] ? sum[2] / n[2] : 0,
    };
  }

  /**
   * Where the howdah floor and the mahout's seat are on a given frame, in the animal's own
   * frame and at its own size. The two numbers a crew placement is built from.
   */
  howdahAt(clip: number, phase: number, variant: number): {
    floorY: number; floorZ: number; seatY: number; seatZ: number; frame: number; frames: number;
  } {
    const facts = this.elephantFacts[clip] ?? this.elephantFacts[ELEPHANT_CLIP.idle];
    const frame = Math.min(facts.frames - 1, Math.max(0, Math.floor(phase * facts.frames)));
    const row = (facts.rowBase + frame) * 3;
    const scale = this.elephantScale(variant);
    return {
      floorY: this.howdahTrack[row + 1] * scale,
      floorZ: this.howdahTrack[row + 2] * scale,
      seatY: this.mahoutTrack[row + 1] * scale,
      seatZ: this.mahoutTrack[row + 2] * scale,
      frame,
      frames: facts.frames,
    };
  }

  /**
   * The mahout on the neck and the three men in the tower — where each one is this frame.
   *
   * Returned rather than pushed, because the crew are *not* elephant geometry: they are
   * written into the Carthaginian soldier tier that is already being drawn, which is why four
   * men on an animal cost no draw call. Splitting the solve from the emit is also what lets
   * the viewer hide them, or hide the animal and leave them, and see which of the two is
   * wrong.
   *
   * `state` picks the man clip the way the game does: a crewman throws when the unit is
   * shooting, braces once the animal is going down, and the mahout never fights — he is
   * holding a goad in both hands and steering four tonnes.
   */
  elephantCrew(
    e: ElephantPose, shooting: boolean, groundY = 0
  ): CrewPlacement[] {
    const scale = this.elephantScale(e.variant);
    const sinF = Math.sin(e.yaw);
    const cosF = Math.cos(e.yaw);
    const at = this.howdahAt(e.clip, e.phase, e.variant);
    const y = e.y + ELEPHANT_GROUND_LIFT;

    const crewClip = e.fall > 0
      ? Clip.IdleBrace : shooting ? Clip.ThrowPilum : Clip.IdleAlert;
    // 0 while they are still on the animal, rising to 1 as each is thrown clear.
    const throwT = e.fall <= CREW_THROW_START
      ? 0
      : Math.min(1, (e.fall - CREW_THROW_START) / CREW_THROW_LEN);

    const out: CrewPlacement[] = [];
    for (let k = 0; k < HOWDAH_STATIONS.length + 1; k++) {
      const mahout = k === HOWDAH_STATIONS.length;
      const st = mahout ? { x: 0, z: 0, turn: 0 } : HOWDAH_STATIONS[k];
      // Stable per man: the animal's own hash, salted by station.
      const seed = Math.floor(e.variant * 16777216) + k * 7919;
      const jx = (hash01(seed, 61) - 0.5) * 0.14;
      const jz = (hash01(seed, 62) - 0.5) * 0.12;
      const lx = (st.x + jx) * scale;
      const lz = (mahout ? at.seatZ : at.floorZ + st.z + jz) * scale;
      const my = y + (mahout ? at.seatY - 0.86 * scale : at.floorY);
      // The men are their own size, not the animal's: a big elephant is what makes the men on
      // it look small, and scaling them by their mount would undo exactly that.
      const manScale = (mahout ? 0.97 : 1.0) * (0.96 + hash01(seed, 63) * 0.09);
      const wx = e.x + lx * cosF + lz * sinF;
      const wz = e.z - lx * sinF + lz * cosF;
      const variant = hash01(seed, 3);

      if (throwT <= 0) {
        out.push({
          x: wx, y: my, z: wz, facing: e.yaw + st.turn, scale: manScale, variant,
          clip: FOOT_CLIP_MAP[mahout ? Clip.IdleRelaxed : crewClip],
          mahout, thrown: false,
        });
        continue;
      }
      out.push(this.throwCrewman(e, seed, variant, manScale, wx, my, wz, mahout, throwT, groundY));
    }
    return out;
  }

  /**
   * One crewman pitched off a falling elephant, mid-air or landed.
   *
   * The same recipe a man's corpse uses, because that combination is known to sit correctly
   * on the ground: a death clip held at its last frame, a full-body quaternion that tips him
   * out of the standing pose, and the ragdoll's own 0.15 m lift. Interpolating the clip phase
   * and the tip angle together over the throw turns three numbers into a man tumbling out of
   * a tower, with no second solver.
   */
  private throwCrewman(
    e: ElephantPose,
    seed: number, variant: number, manScale: number,
    fromX: number, fromY: number, fromZ: number,
    mahout: boolean, t: number, groundY: number
  ): CrewPlacement {
    const side = CREW_FALL_SIDE * (CREW_LAND_OUT + hash01(seed, 81) * 1.35);
    const along = mahout ? 1.5 + hash01(seed, 82) * 0.9 : -0.7 + hash01(seed, 82) * 2.4;
    const sinF = Math.sin(e.yaw);
    const cosF = Math.cos(e.yaw);
    const landX = fromX + side * cosF + along * sinF;
    const landZ = fromZ - side * sinF + along * cosF;
    const landY = groundY + CREW_GROUND_LIFT;

    // Out fast, down on gravity — the two-easing throw from `UnitRenderSystem.throwCrewman`.
    // One smoothstep on all three axes starts at zero lateral velocity and let the animal
    // roll into the man: 0.278 m inside the hide at 33.5 % of the fall, against 0.080 now.
    const sOut = t * (2 - t);
    const sDown = t * t;
    const s = sOut;
    const x = fromX + (landX - fromX) * sOut;
    const z = fromZ + (landZ - fromZ) * sOut;
    const y = fromY + (landY - fromY) * sDown + CREW_THROW_ARC * Math.sin(Math.PI * t);

    const outward = e.yaw + (CREW_FALL_SIDE > 0 ? Math.PI / 2 : -Math.PI / 2)
      + (hash01(seed, 83) - 0.5) * 1.1;
    qCrew.setFromAxisAngle(AXIS_UP, outward);
    vCrewAxis.set(Math.cos(outward), 0, -Math.sin(outward));
    // 96 degrees rolls his shoulder into the ground; a right angle lands him as a plank.
    qCrewTip.setFromAxisAngle(vCrewAxis, s * 1.676);
    qCrew.premultiply(qCrewTip);

    const variants = [Clip.DeathSide, Clip.DeathBack, Clip.DeathForward, Clip.DeathKneel];
    const clip = variants[Math.floor(hash01(seed, 84) * 4) & 3];
    return {
      x, y, z, facing: outward, scale: manScale, variant,
      clip: FOOT_CLIP_MAP[clip], phase: s,
      quat: [qCrew.x, qCrew.y, qCrew.z, qCrew.w],
      mahout, thrown: true,
    };
  }

  // -------------------------------------------------------------------------
  // Impostor tier
  // -------------------------------------------------------------------------

  /**
   * Capture the billboard atlas.
   *
   * This is the one part of the pipeline that needs a live renderer: the impostor *is* the
   * LOD1 mesh, pre-rasterised from eight yaws, which is what makes the transition invisible.
   * Captured per faction on demand rather than for all factions at boot, so a roster that
   * grows does not cost the viewer a render target it never shows.
   */
  private ensureImpostors(
    renderer: THREE.WebGLRenderer, faction: Faction, def: UnitTypeDef, light: CaptureLight
  ): void {
    // Keyed on the light as well as the faction: the atlas has the lighting baked into it, so
    // switching the studio probe for the battle's sun has to re-capture or the far tier keeps
    // the old exposure and reads as a lighting bug in the tier system.
    const key = `${faction}:${light.key}`;
    if (this.impostorKey === key && this.impostorTier) return;
    this.disposeImpostors();

    const march = this.manFacts.find((f) => f.name === 'march') ?? this.manFacts[0];
    const row = march.rowBase + Math.floor(march.frames * 0.22);
    const kit = resolveKit(def, 0.37, emptyKit());
    const geometry = buildSoldierGeometry(faction, 1);
    const one = (arr: number[], n: number): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(new Float32Array(arr), n);
    geometry.setAttribute('iPos', one([0, 0, 0], 3));
    geometry.setAttribute('iOrient', one([0, 1, 0, 0.05], 4));
    geometry.setAttribute('iAnimA', one([row, row, 0, 1], 4));
    geometry.setAttribute('iAnimB', one([row, row, 0, 0.37], 4));
    geometry.setAttribute('iKit', one([kit.maskLo, kit.maskHi], 2));
    geometry.setAttribute('iCol0', one([...kit.tunic, kit.emblem], 4));
    geometry.setAttribute('iCol1', one([...kit.leg, kit.metal], 4));
    geometry.setAttribute('iQuat', one([0, 0, 0, 0], 4));
    geometry.instanceCount = 1;

    // Capture with tone mapping off.
    //
    // The atlas is a *picture of a lit man*, and it gets tone mapped again when the billboard
    // is drawn. Leaving AgX on for the capture applies the curve twice and the far tier comes
    // out visibly darker than the LOD2 it replaces — which reads as a popping shadow at the
    // transition. The game never hits this because `PostFX` sets the renderer to
    // `NoToneMapping` at init and maps once, in post.
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    this.impostors = renderImpostorAtlas(
      renderer,
      [{
        geometry,
        material: this.manMat.material,
        setup: (g, yaw): void => {
          const o = g.getAttribute('iOrient') as THREE.InstancedBufferAttribute;
          o.array[0] = yaw;
          o.needsUpdate = true;
        },
      }],
      { direction: light.direction, colour: light.colour, ambient: light.ambient }
    );
    renderer.toneMapping = prevTone;
    geometry.dispose();

    this.impostorMat = makeImpostorMaterial(this.impostors);
    const quad = buildImpostorGeometry();
    const buf = {
      pos: new Float32Array(CAP * 3),
      orient: new Float32Array(CAP * 4),
      animA: new Float32Array(0),
      animB: new Float32Array(0),
      kit: new Float32Array(0),
      col0: new Float32Array(CAP * 4),
      col1: new Float32Array(0),
      quat: new Float32Array(0),
    };
    const attr = (a: Float32Array, n: number): THREE.InstancedBufferAttribute => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    const attrs = { iPos: attr(buf.pos, 3), iOrient: attr(buf.orient, 4), iCol0: attr(buf.col0, 4) };
    for (const [k, v] of Object.entries(attrs)) quad.setAttribute(k, v);
    quad.instanceCount = 0;
    const mesh = new THREE.Mesh(quad, this.impostorMat);
    mesh.name = 'viewer-impostor';
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    this.impostorTier = { mesh, geometry: quad, attrs, buf, count: 0, tris: 2 };
    this.impostorKey = key;
  }

  /** Must be called before `pushMan` with `lod === 3`. */
  prepareImpostors(renderer: THREE.WebGLRenderer, def: UnitTypeDef, light: CaptureLight): void {
    this.ensureImpostors(renderer, def.faction, def, light);
  }

  private pushImpostor(m: ManPose): void {
    const t = this.impostorTier;
    if (!t) return;
    const n = t.count;
    if (n >= CAP) return;
    t.buf.pos[n * 3] = m.x;
    t.buf.pos[n * 3 + 1] = m.y;
    t.buf.pos[n * 3 + 2] = m.z;
    const o = n * 4;
    t.buf.orient[o] = m.yaw;
    t.buf.orient[o + 1] = m.scale;
    t.buf.orient[o + 2] = 0;
    t.buf.orient[o + 3] = m.grime;
    t.buf.col0[o] = 1;
    t.buf.col0[o + 1] = 1;
    t.buf.col0[o + 2] = 1;
    // Row in the atlas. One faction captured at a time, so always row 0.
    t.buf.col0[o + 3] = 0;
    // Two triangles, and they were being counted as none: `pushMan` hands the impostor tier
    // off before it reaches the accounting, so the far tier reported "0 tris rasterised" with
    // a billboard filling the frame.
    this.drawn += 2;
    t.count = n + 1;
  }

  // -------------------------------------------------------------------------

  end(dt: number): void {
    this.elapsed += dt;
    this.manMat.uniforms.uTime.value = this.elapsed;
    this.horseMat.uniforms.uTime.value = this.elapsed;
    this.elephantMat.uniforms.uTime.value = this.elapsed;

    const push = (t: Tier): void => {
      t.geometry.instanceCount = t.count;
      t.mesh.visible = t.count > 0;
      if (t.count === 0) return;
      for (const a of Object.values(t.attrs)) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, t.count * a.itemSize);
        a.needsUpdate = true;
      }
    };
    for (const t of this.manTiers.values()) push(t);
    for (const t of this.horseTiers.values()) push(t);
    if (this.elephantTierCache) push(this.elephantTierCache);
    if (this.impostorTier) push(this.impostorTier);
  }

  /** Instances currently drawn, for the readout. */
  drawnMeshes(): { name: string; count: number; tris: number }[] {
    const out: { name: string; count: number; tris: number }[] = [];
    const add = (t: Tier): void => {
      if (t.count > 0) out.push({ name: t.mesh.name, count: t.count, tris: t.tris });
    };
    for (const t of this.manTiers.values()) add(t);
    for (const t of this.horseTiers.values()) add(t);
    if (this.elephantTierCache) add(this.elephantTierCache);
    if (this.impostorTier) add(this.impostorTier);
    return out;
  }

  private disposeImpostors(): void {
    if (this.impostorTier) {
      this.group.remove(this.impostorTier.mesh);
      this.impostorTier.geometry.dispose();
      this.impostorTier = undefined;
    }
    this.impostorMat?.dispose();
    this.impostorMat = undefined;
    this.impostors?.dispose();
    this.impostors = undefined;
    this.impostorKey = '';
  }

  dispose(): void {
    for (const t of this.manTiers.values()) t.geometry.dispose();
    for (const t of this.horseTiers.values()) t.geometry.dispose();
    this.manTiers.clear();
    this.horseTiers.clear();
    this.elephantTierCache?.geometry.dispose();
    this.elephantTierCache = undefined;
    this.disposeImpostors();
    this.manMat.dispose();
    this.horseMat.dispose();
    this.elephantMat.dispose();
    this.manAnim.dispose();
    this.horseAnim.dispose();
    this.elephantAnim.dispose();
    this.atlas.dispose();
    this.group.clear();
  }
}

/** Whether the roster entry is drawn on a horse. Re-exported so the UI need not import kit. */
export const isMounted = (def: UnitTypeDef): boolean => mounted(def);

/**
 * Whether the roster entry is drawn on an *elephant* rather than a horse.
 *
 * The distinction the viewer was missing. `war-elephants` is classed `heavy-cavalry` so the
 * simulation pushes and kills it like a mount, and every branch in the viewer keyed off
 * `isCavalry` — so it drew a Carthaginian on a bay gelding and reported "soldier mesh + horse
 * mesh" underneath him. `mountKind` is what actually decides the geometry.
 */
export const isElephantUnit = (def: UnitTypeDef): boolean => ridesElephant(def);
