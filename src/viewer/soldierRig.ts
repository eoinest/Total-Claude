import * as THREE from 'three';
import { Faction, type UnitTypeDef } from '../sim/types';
import { bakeAnimTexture, type AnimTexture } from '../anim/animTexture';
import {
  HORSE_CLIP_SET, HORSE_GAIT_LADDER, MAN_CLIP_SET, bakePointTrack, meanPointOverClip,
} from '../anim/clips';
import { MAN_RIG, MB, restPos } from '../anim/rig';
import { makeSoldierMaterial, type PoseVaryBones, type SoldierMaterialSet } from '../anim/skinShader';
import { EMBLEM_ORIGIN, EMBLEM_TILE, buildSoldierAtlas, type SoldierAtlas } from '../units/atlas';
import {
  HORSE_GROUND_LIFT, HORSE_MASK_LO, SADDLE_BONES, SADDLE_SEAT, buildHorseGeometry,
} from '../units/horseMesh';
import { Piece, emptyKit, mounted, resolveKit, type ResolvedKit } from '../units/kit';
import { buildSoldierGeometry, type Lod } from '../units/soldierMesh';
import {
  buildImpostorGeometry, makeImpostorMaterial, renderImpostorAtlas, type ImpostorAtlas,
} from '../units/impostor';
import { chainPartsDebug } from './partsDebug';

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

/**
 * Pose-variation bone chains, re-derived rather than imported.
 *
 * `MAN_POSE_VARY` in `UnitRenderSystem.ts:263` is module-private and `src/units` is owned by
 * another workstream, so this is the same expression evaluated here. It is derived entirely
 * from exported data (`MAN_RIG`, `MB`, `restPos`, `Piece`), so it cannot silently disagree
 * about bone *indices*; it could only drift if the original changed which chains it varies.
 * The report accompanying this work asks for it to be exported so this copy can go away.
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
  poleWeapons: [Piece.WeaponSpear, Piece.Pilum, Piece.JavelinBundle],
  bladeWeapons: [Piece.WeaponSword, Piece.WeaponAxe],
};

/** Rider clearance above the saddle, metres. Matches `SEAT_RISE` in the render system. */
const SEAT_RISE = 0.07;

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

  private readonly atlas: SoldierAtlas;
  private readonly manAnim: AnimTexture;
  private readonly horseAnim: AnimTexture;
  private readonly manMat: SoldierMaterialSet;
  private readonly horseMat: SoldierMaterialSet;
  private readonly baseParams: THREE.MeshStandardMaterialParameters;

  /** Lazily built, keyed `faction:lod` — so a faction added to the roster just works. */
  private readonly manTiers = new Map<string, Tier>();
  private readonly boundsCache = new Map<string, Map<number, { cx: number; cy: number; cz: number; r: number }>>();
  private readonly triCache = new Map<string, Map<number, number>>();
  private readonly headTrack = new Map<Faction, Float32Array>();
  private readonly horseTiers = new Map<number, Tier>();
  private impostorTier?: Tier;
  private impostors?: ImpostorAtlas;
  private impostorMat?: THREE.MeshBasicMaterial;
  private impostorKey = '';

  /** Where the saddle is on every frame of every gait, and each rider clip's own seat. */
  private readonly saddleTrack: Float32Array;
  private readonly riderSeatY: Float32Array;
  private readonly riderSeatZ: Float32Array;

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
    this.manFacts = factsOf(MAN_CLIP_SET);
    this.horseFacts = factsOf(HORSE_CLIP_SET);

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
      leanHeight: 1.5,
      poseVary: MAN_POSE_VARY,
    });
    this.horseMat = makeSoldierMaterial(this.baseParams, {
      anim: this.horseAnim,
      emblemOrigin: EMBLEM_ORIGIN,
      emblemTile: EMBLEM_TILE,
      leanHeight: 1.7,
    });
    // Distinct tags, because `makeSoldierMaterial` keys its program cache on the rig flag
    // alone and two chained materials sharing a key would get each other's shader.
    chainPartsDebug(this.manMat.material, 'man');
    chainPartsDebug(this.horseMat.material, 'horse');

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

    // A living man. Non-zero here would send the shader down the corpse branch and apply a
    // body-wide rotation plus a settle squash.
    t.buf.quat[o] = 0; t.buf.quat[o + 1] = 0; t.buf.quat[o + 2] = 0; t.buf.quat[o + 3] = 0;

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
    this.disposeImpostors();
    this.manMat.dispose();
    this.horseMat.dispose();
    this.manAnim.dispose();
    this.horseAnim.dispose();
    this.atlas.dispose();
    this.group.clear();
  }
}

/** Whether the roster entry is drawn on a horse. Re-exported so the UI need not import kit. */
export const isMounted = (def: UnitTypeDef): boolean => mounted(def);
