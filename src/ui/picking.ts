/**
 * Screen-to-world picking for order issuing and selection.
 *
 * Soldiers are GPU-instanced, so there is nothing in the scene graph to raycast
 * against. Everything here works from the unit groups' own formation geometry instead:
 * an oriented rectangle per unit whose width is the frontage and whose depth is the
 * ranks. That is exactly the footprint the sim lays men out into, so hit tests agree
 * with what the player sees.
 *
 * The screen ray comes in three forms — `screenToGround`, `screenToSolid` and `screenPick`
 * — because it is asked two different questions and some callers want one answer, not both.
 * `SelectionController` wants both and uses `screenPick`; the single-question forms are the
 * ones `tools/probe-nav.mjs --only=pick` grades separately, which is how the regression that
 * produced them is kept from coming back.
 */

import * as THREE from 'three';
import { ranksFor } from '../sim/formations';
import type { UnitGroupState, UnitTypeDef } from '../sim/types';

export interface Footprint {
  /** Centre of the block, not the front-rank anchor. */
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  cos: number;
  sin: number;
}

/**
 * The unit's block in world space. `u.x/u.z` is the midpoint of the front rank and
 * the formation extends backwards along -facing, so the centre sits half a depth back.
 */
export function footprintOf(u: UnitGroupState, def: UnitTypeDef, out: Footprint): Footprint {
  const ranks = ranksFor(Math.max(1, u.alive), u.width);
  const frontage = Math.max(2, u.width * u.spacingX);
  const depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);
  const s = Math.sin(u.facing);
  const c = Math.cos(u.facing);
  out.cos = c;
  out.sin = s;
  out.halfW = frontage * 0.5;
  out.halfD = depth * 0.5;
  out.cx = u.x - s * out.halfD;
  out.cz = u.z - c * out.halfD;
  return out;
}

/** Local-space coordinates of a world point inside a footprint's frame. */
export function toLocal(f: Footprint, x: number, z: number, out: { x: number; z: number }): void {
  const dx = x - f.cx;
  const dz = z - f.cz;
  out.x = dx * f.cos - dz * f.sin;
  out.z = dx * f.sin + dz * f.cos;
}

/** Zero inside the rectangle, otherwise metres to its edge. */
export function distanceToFootprint(f: Footprint, x: number, z: number): number {
  const dx = x - f.cx;
  const dz = z - f.cz;
  const lx = Math.abs(dx * f.cos - dz * f.sin) - f.halfW;
  const lz = Math.abs(dx * f.sin + dz * f.cos) - f.halfD;
  const ox = lx > 0 ? lx : 0;
  const oz = lz > 0 ? lz : 0;
  return Math.hypot(ox, oz);
}

/** World position of one of the footprint's four corners (i = 0..3). */
export function footprintCorner(f: Footprint, i: number, out: { x: number; z: number }): void {
  const sx = i === 0 || i === 3 ? -1 : 1;
  const sz = i < 2 ? 1 : -1;
  const lx = sx * f.halfW;
  const lz = sz * f.halfD;
  out.x = f.cx + lx * f.cos + lz * f.sin;
  out.z = f.cz - lx * f.sin + lz * f.cos;
}

// ---------------------------------------------------------------------------
// Ground ray
// ---------------------------------------------------------------------------

const RAY_ORIGIN = new THREE.Vector3();
const RAY_DIR = new THREE.Vector3();
const RAY_TMP = new THREE.Vector3();

/**
 * An upright box the cursor can land on: a wall bay, a tower, a siege engine.
 *
 * Structurally a subset of `sim/Obstacles.Obstacle`, redeclared rather than imported so the
 * UI layer does not take a dependency on the simulation's types for four numbers, and so a
 * caller can hand over siege engines that are not city obstacles at all.
 */
export interface PickSolid {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  topY: number;
  /** Absolute Y of the underside. Defaults to "far below" — these are upright and grounded. */
  baseY?: number;
}

/**
 * Above this, `topY` is a sentinel rather than a roof, and the box is skipped for picking.
 *
 * `CitySystem` publishes `topY: 1e4` for every insula and monument — 1,730 of its 1,827
 * boxes — because it does not model their heights. That is fine for collision, where the
 * only question is "is a man's head above this", and fatal for a ray, where it makes each
 * one an infinitely tall pillar. The tallest modelled top on this map is a wall tower at
 * 63.7 m, so 400 clears anything genuine six times over and excludes every sentinel.
 */
const SENTINEL_TOP_Y = 400;

/**
 * A hit nearer than this is the eye standing inside the box, not something the player aimed
 * at. Half a metre: closer than the near clip plane at any zoom.
 */
const MIN_PICK_DISTANCE = 0.5;

/** Metres a solid-derived order point is pushed clear of the solid's own face. */
const SOLID_STANDOFF = 1.6;

/**
 * What one screen ray means. Two answers, because it is being asked two questions.
 *
 * "What ground did I click" and "what object did I click" are different questions with
 * different right answers — a rally point in a street wants the paving, an order against a
 * siege tower wants the tower — and merging them inside one function is what made every
 * ground click in the city land on the same spot. Measured: with the city's 1,827 solids
 * folded into the ground ray, six spread-out clicks from one camera all resolved within
 * two metres of the camera's own position, 42 to 92 m from where the player pointed,
 * because the eye stood inside an insula's footprint and that insula's `topY` was 1e4.
 *
 * So the ray is shared — it is one unproject and one set of `heightAt` samples — and the
 * interpretation is not. The caller decides which answer its gesture wants.
 */
export interface ScreenPick {
  /** Ground under the cursor. Only meaningful when `groundHit`. */
  groundX: number;
  groundY: number;
  groundZ: number;
  /** False when the ray never meets the heightfield: the cursor is on or above the horizon. */
  groundHit: boolean;
  /** Index into the caller's `solids`, or -1 when the ray met none of them. */
  solid: number;
  /** Point on that solid's surface. Only meaningful when `solid >= 0`. */
  solidX: number;
  solidY: number;
  solidZ: number;
  /** Metres from the eye to the solid hit, or -1. */
  solidDistance: number;
}

export function makeScreenPick(): ScreenPick {
  return {
    groundX: 0, groundY: 0, groundZ: 0, groundHit: false,
    solid: -1, solidX: 0, solidY: 0, solidZ: 0, solidDistance: -1,
  };
}

/** Set up RAY_ORIGIN / RAY_DIR for a screen position. False if the ray is degenerate. */
function makeRay(camera: THREE.PerspectiveCamera, ndcX: number, ndcY: number): boolean {
  RAY_TMP.set(ndcX, ndcY, 0.5).unproject(camera);
  RAY_ORIGIN.copy(camera.position);
  RAY_DIR.copy(RAY_TMP).sub(RAY_ORIGIN);
  const len = RAY_DIR.length();
  if (len < 1e-6) return false;
  RAY_DIR.multiplyScalar(1 / len);
  return true;
}

/**
 * Distance along the current ray to the heightfield, or -1.
 *
 * Rather than marching, this iterates the fixed point `t = (eyeY - h(p)) / -dir.y`.
 * On terrain this gentle it converges in three or four steps, and it costs four
 * `heightAt` samples instead of the fifty a march would need.
 */
function rayGroundT(heightAt: (x: number, z: number) => number, maxDistance: number): number {
  // Looking at or above the horizon: the ray never comes down inside the world.
  if (RAY_DIR.y > -0.012) return -1;
  let t = (RAY_ORIGIN.y - heightAt(RAY_ORIGIN.x, RAY_ORIGIN.z)) / -RAY_DIR.y;
  t = Math.min(t, maxDistance);
  for (let i = 0; i < 4; i++) {
    const x = RAY_ORIGIN.x + RAY_DIR.x * t;
    const z = RAY_ORIGIN.z + RAY_DIR.z * t;
    const h = heightAt(x, z);
    const nt = (RAY_ORIGIN.y - h) / -RAY_DIR.y;
    if (!Number.isFinite(nt)) break;
    t = Math.min(Math.max(nt, 0.1), maxDistance);
  }
  return t < maxDistance ? t : -1;
}

/**
 * Intersect the camera ray through (ndcX, ndcY) with the heightfield.
 *
 * Terrain only, and deliberately so — see `ScreenPick`. Use `screenToSolid` when the
 * question is what object is under the cursor, or `screenPick` when both answers are
 * wanted from one ray.
 */
export function screenToGround(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  heightAt: (x: number, z: number) => number,
  out: { x: number; y: number; z: number },
  maxDistance = 4200
): boolean {
  if (!makeRay(camera, ndcX, ndcY)) return false;
  const t = rayGroundT(heightAt, maxDistance);
  if (t < 0) return false;
  out.x = RAY_ORIGIN.x + RAY_DIR.x * t;
  out.z = RAY_ORIGIN.z + RAY_DIR.z * t;
  out.y = heightAt(out.x, out.z);
  return true;
}

/**
 * Nearest solid under the cursor: its index in `solids`, or -1.
 *
 * Deliberately independent of the terrain. A player clicking the upper half of a 20 m
 * siege tower produces a ray that rises and never meets the heightfield at all, so a
 * solid test gated behind a successful ground hit answers `false` for exactly the clicks
 * that most need an answer.
 */
export function screenToSolid(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  solids: readonly PickSolid[],
  out: { x: number; y: number; z: number },
  maxDistance = 4200
): number {
  if (!solids.length || !makeRay(camera, ndcX, ndcY)) return -1;
  const i = raySolid(RAY_ORIGIN, RAY_DIR, solids, maxDistance);
  if (i < 0) return -1;
  out.x = RAY_ORIGIN.x + RAY_DIR.x * RAY_HIT_T;
  out.y = RAY_ORIGIN.y + RAY_DIR.y * RAY_HIT_T;
  out.z = RAY_ORIGIN.z + RAY_DIR.z * RAY_HIT_T;
  return i;
}

/** Both answers from one ray. */
export function screenPick(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  heightAt: (x: number, z: number) => number,
  solids: readonly PickSolid[],
  out: ScreenPick,
  maxDistance = 4200
): void {
  out.groundHit = false;
  out.solid = -1;
  out.solidDistance = -1;
  if (!makeRay(camera, ndcX, ndcY)) return;

  const tGround = rayGroundT(heightAt, maxDistance);
  if (tGround >= 0) {
    out.groundX = RAY_ORIGIN.x + RAY_DIR.x * tGround;
    out.groundZ = RAY_ORIGIN.z + RAY_DIR.z * tGround;
    out.groundY = heightAt(out.groundX, out.groundZ);
    out.groundHit = true;
  }

  if (!solids.length) return;
  // A solid behind the ground point is hidden by the hill in front of it.
  const limit = tGround >= 0 ? tGround : maxDistance;
  const i = raySolid(RAY_ORIGIN, RAY_DIR, solids, limit);
  if (i < 0) return;
  out.solid = i;
  out.solidDistance = RAY_HIT_T;
  out.solidX = RAY_ORIGIN.x + RAY_DIR.x * RAY_HIT_T;
  out.solidY = RAY_ORIGIN.y + RAY_DIR.y * RAY_HIT_T;
  out.solidZ = RAY_ORIGIN.z + RAY_DIR.z * RAY_HIT_T;
}

/**
 * The camera ray for a screen position, kept so callers can ask more than one question of it.
 *
 * `screenPick` answers the two questions the *ground* needs. A unit standing on a wall walk
 * needs a third — "where does this ray cross the level the men are standing on" — and that
 * cannot be folded into either of the other two without repeating the mistake `ScreenPick`
 * documents. So the ray itself is published and each question stays its own function.
 */
export interface ScreenRay {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  valid: boolean;
}

export const makeScreenRay = (): ScreenRay =>
  ({ ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1, valid: false });

/** One unproject, kept for the frame. */
export function screenRay(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  out: ScreenRay
): boolean {
  out.valid = makeRay(camera, ndcX, ndcY);
  if (!out.valid) return false;
  out.ox = RAY_ORIGIN.x; out.oy = RAY_ORIGIN.y; out.oz = RAY_ORIGIN.z;
  out.dx = RAY_DIR.x; out.dy = RAY_DIR.y; out.dz = RAY_DIR.z;
  return true;
}

/**
 * Where the ray crosses the horizontal plane `y = planeY`, in front of the eye.
 *
 * Deliberately trivial and allocation-free: it runs once per elevated unit per frame, and the
 * whole point of hoisting `screenRay` out is that this costs three multiplies rather than a
 * second unproject.
 */
export function rayPlaneY(
  r: ScreenRay,
  planeY: number,
  out: { x: number; z: number },
  maxDistance = 4200
): boolean {
  if (!r.valid || Math.abs(r.dy) < 1e-6) return false;
  const t = (planeY - r.oy) / r.dy;
  if (t <= 0 || t > maxDistance) return false;
  out.x = r.ox + r.dx * t;
  out.z = r.oz + r.dz * t;
  return true;
}

/**
 * Where a formation ordered at a solid should actually be sent: the ground just outside
 * its nearest face, on the side the player was looking from.
 *
 * Not the hit point itself, and not the ground under it. A click on a siege tower's flank
 * lands on the box surface, and a click on its roof lands above the footprint — both are
 * places a cohort cannot stand. Pushing out of the footprint in plan is the one rule that
 * handles both, and it is the same escape vector `ObstacleField.escape` uses, so the point
 * this produces is one the collision system also considers free.
 */
export function orderPointForSolid(
  solids: readonly PickSolid[],
  index: number,
  blockers: readonly PickSolid[],
  hitX: number,
  hitZ: number,
  heightAt: (x: number, z: number) => number,
  out: { x: number; y: number; z: number }
): void {
  let x = hitX;
  let z = hitZ;
  /*
   * Pushing clear of the box that was hit is not the same as being clear of everything.
   * The curtain's bays abut end to end and a tower stands at every bay start, so a click
   * near a joint pushes out of one bay and straight into its neighbour: measured over 808
   * synthetic hits across the whole pick set, **153 landed inside another solid**. Four
   * passes, because the geometry is convex and abutting rather than interlocking — two is
   * enough in every case observed and the fourth is there so a pathological arrangement
   * degrades to "not quite clear" instead of looping.
   *
   * `blockers` is what the point must end up outside of and is a wider set than `solids`:
   * a man cannot stand inside an insula either, and insulae are not targetable so they are
   * not in the pick set. Escaping only the pick set left 23 of the 808 inside a building.
   */
  for (let pass = 0; pass < 4; pass++) {
    const s = pass === 0 ? solids[index] : containingSolid(blockers, x, z);
    if (!s) break;
    pushOutOfSolid(s, x, z, SCRATCH_XZ);
    x = SCRATCH_XZ.x;
    z = SCRATCH_XZ.z;
  }
  /*
   * The iteration can still end inside something where two boxes overlap and each pushes
   * back into the other — 25 of the same 808 hits, down from 153 but not zero. Fall back to
   * the nearest free point on an outward spiral, which cannot oscillate. Only this 3% pays
   * for it, and it runs once per pointer event, not per frame.
   */
  if (containingSolid(blockers, x, z)) {
    outer:
    for (let ring = 1; ring <= 12; ring++) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const px = hitX + Math.cos(ang) * ring * SOLID_STANDOFF;
        const pz = hitZ + Math.sin(ang) * ring * SOLID_STANDOFF;
        if (!containingSolid(blockers, px, pz)) {
          x = px;
          z = pz;
          break outer;
        }
      }
    }
  }
  out.x = x;
  out.z = z;
  out.y = heightAt(x, z);
}

const SCRATCH_XZ = { x: 0, z: 0 };

/** The first solid whose footprint contains (x,z), or undefined. */
function containingSolid(solids: readonly PickSolid[], x: number, z: number): PickSolid | undefined {
  for (const s of solids) {
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    const dx = x - s.x;
    const dz = z - s.z;
    if (Math.abs(dx * c + dz * sn) > s.hw) continue;
    if (Math.abs(-dx * sn + dz * c) > s.hd) continue;
    return s;
  }
  return undefined;
}

/** One step of the escape: out through the nearest face, with the tangent clamped. */
function pushOutOfSolid(s: PickSolid, px: number, pz: number, out: { x: number; z: number }): void {
  const c = Math.cos(s.rot);
  const sn = Math.sin(s.rot);
  const dx = px - s.x;
  const dz = pz - s.z;
  const u = dx * c + dz * sn;
  const v = -dx * sn + dz * c;
  /*
   * Two decisions, and getting either wrong reproduces the original bug.
   *
   * *Where* on the box: the point the ray actually struck, not the box's centre. Pushing out
   * from the centre gives one destination for the whole box however wide it is, which on a
   * 35.5 m curtain bay is bug (a) again in a new costume — measured at the default camera,
   * five pixels spanning 9 m of the wall all resolved to the same point, the furthest 36.1 m
   * from where the player pointed.
   *
   * *Which* face: the nearest one, by distance out through it. This is the same rule as
   * `ObstacleField.escape`, so the point it produces is one the collision system also
   * considers free. A hit on a side face is already on that face, so the distance out is
   * zero and it wins; a hit on the *top* of a wall-walk is inside the footprint in plan, and
   * the nearest way out is across the 3.5 m thickness rather than along the 35.5 m run. The
   * alternative — comparing offsets scaled by their half-extents — sends a click in the
   * middle of a bay to the far *end* of it, up to 19 m along the wall, which showed up as a
   * 24.79 m p95 against a 0.29 m ground answer.
   */
  const outU = s.hw - Math.abs(u);
  const outV = s.hd - Math.abs(v);
  let pu: number;
  let pv: number;
  if (outU <= outV) {
    pu = (u >= 0 ? 1 : -1) * (s.hw + SOLID_STANDOFF);
    pv = Math.min(s.hd, Math.max(-s.hd, v));
  } else {
    pu = Math.min(s.hw, Math.max(-s.hw, u));
    pv = (v >= 0 ? 1 : -1) * (s.hd + SOLID_STANDOFF);
  }
  out.x = s.x + pu * c - pv * sn;
  out.z = s.z + pu * sn + pv * c;
}

/** Distance along the ray to the last hit returned by `raySolid`. */
let RAY_HIT_T = -1;

/**
 * Nearest ray hit against a set of upright oriented boxes: the box's index, or -1. The
 * distance is left in `RAY_HIT_T`.
 *
 * A standard slab test done in each box's own frame: rotate the ray by -rot about Y so the
 * box becomes axis-aligned, then intersect three slabs. The boxes are upright, so only the
 * horizontal pair needs rotating and the vertical slab runs from `baseY` up to `topY`.
 *
 * Two rules here are not decoration. Boxes taller than `SENTINEL_TOP_Y` are skipped, and a
 * hit nearer than `MIN_PICK_DISTANCE` is discarded. Together they are the whole of the
 * regression that made every ground click in Rome land in the same place: the eye stood
 * inside an insula's footprint, the insula's `topY` was the 1e4 sentinel so the ray was
 * inside it vertically too, the slab test therefore returned `tmin = 0`, and the "hit"
 * was the camera's own position. Six clicks, one answer.
 *
 * There is no broadphase on purpose. This runs once per pointer event, not per frame, and
 * a few hundred boxes at a handful of flops each is far below the cost of the `heightAt`
 * samples the caller has already paid. Adding a grid would be a second copy of the city's
 * own broadphase to keep in step with it.
 */
function raySolid(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  solids: readonly PickSolid[],
  maxT: number
): number {
  let best = -1;
  let bestT = -1;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    // Not a roof, a sentinel. Picking against it is picking against a pillar to the sky.
    if (s.topY >= SENTINEL_TOP_Y) continue;
    const c = Math.cos(-s.rot);
    const sn = Math.sin(-s.rot);
    const ox = origin.x - s.x;
    const oz = origin.z - s.z;
    // Ray into the box's frame.
    const lox = ox * c - oz * sn;
    const loz = ox * sn + oz * c;
    const ldx = dir.x * c - dir.z * sn;
    const ldz = dir.x * sn + dir.z * c;

    let tmin = 0;
    let tmax = maxT;
    // Horizontal slabs. A ray parallel to a slab either misses entirely or is unconstrained
    // by it, which is what the `Math.abs(d) < 1e-9` branch decides.
    for (const [o, d, h] of [[lox, ldx, s.hw], [loz, ldz, s.hd]] as const) {
      if (Math.abs(d) < 1e-9) {
        if (o < -h || o > h) { tmin = Infinity; break; }
        continue;
      }
      const inv = 1 / d;
      let t1 = (-h - o) * inv;
      let t2 = (h - o) * inv;
      if (t1 > t2) { const sw = t1; t1 = t2; t2 = sw; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { tmin = Infinity; break; }
    }
    if (!Number.isFinite(tmin)) continue;

    // Vertical slab: base to top. `baseY` defaults generously low because a city obstacle
    // only publishes its top — the ground under it is the terrain, and the box is upright.
    const b = s.baseY ?? -1e4;
    if (Math.abs(dir.y) < 1e-9) {
      if (origin.y < b || origin.y > s.topY) continue;
    } else {
      const inv = 1 / dir.y;
      let t1 = (b - origin.y) * inv;
      let t2 = (s.topY - origin.y) * inv;
      if (t1 > t2) { const sw = t1; t1 = t2; t2 = sw; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }

    if (tmin < MIN_PICK_DISTANCE || tmin > maxT) continue;
    if (best < 0 || tmin < bestT) {
      best = i;
      bestT = tmin;
    }
  }
  RAY_HIT_T = bestT;
  return best;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const PROJ = new THREE.Vector3();

export interface Projected {
  /** CSS pixels from the canvas top-left. */
  x: number;
  y: number;
  /** Distance from the camera in metres. */
  distance: number;
  /** False when the point is behind the camera. */
  visible: boolean;
}

export function projectPoint(
  camera: THREE.PerspectiveCamera,
  x: number,
  y: number,
  z: number,
  viewW: number,
  viewH: number,
  out: Projected
): Projected {
  PROJ.set(x, y, z);
  out.distance = PROJ.distanceTo(camera.position);
  PROJ.project(camera);
  out.x = (PROJ.x * 0.5 + 0.5) * viewW;
  out.y = (-PROJ.y * 0.5 + 0.5) * viewH;
  out.visible = PROJ.z > -1 && PROJ.z < 1;
  return out;
}

export interface ScreenPoint {
  /** CSS pixels from the canvas top-left. */
  x: number;
  y: number;
  /** True when the point lies between the near and far clip planes. */
  inRange: boolean;
}

/**
 * Batched screen projection.
 *
 * `projectPoint` forms the view-projection product inside `Vector3.project` on every call,
 * which is fine for one point per unit and wasteful for the thousands per frame that
 * finding a block's *visual* centre needs: the projection of a formation's centroid is not
 * the centroid of its projections — the two are 20 px apart on a wide block seen obliquely
 * — so the centre has to be averaged over the men themselves. Forming the product once per
 * frame turns each man into a single matrix-vector multiply.
 *
 * `begin` must be called after the camera's `matrixWorldInverse` is final, i.e. from
 * `preRender`.
 */
export class ScreenProjector {
  private readonly vp = new THREE.Matrix4();
  private halfW = 0;
  private halfH = 0;

  begin(camera: THREE.PerspectiveCamera, viewW: number, viewH: number): void {
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.halfW = viewW * 0.5;
    this.halfH = viewH * 0.5;
  }

  /**
   * Two points on one vertical line — `(x, y, z)` and `(x, y + dy, z)` — in a single pass.
   * Returns false when either is at or behind the eye, leaving the outputs untouched.
   *
   * Clip coordinates are linear in world y, so the raised point costs three multiplies and
   * a divide instead of a second full transform. That is the difference between one and
   * two matrix products per man, and the banners do this for every man in the army every
   * frame. `inRange` is decided by the lower point; the upper one sits a few metres above
   * it and cannot cross a clip plane on its own at any battle distance.
   */
  projectPair(
    x: number, y: number, z: number, dy: number,
    lower: ScreenPoint, upper: ScreenPoint
  ): boolean {
    const e = this.vp.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (!(w > 1e-6)) return false;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const inv = 1 / w;
    lower.x = this.halfW + cx * inv * this.halfW;
    lower.y = this.halfH - cy * inv * this.halfH;
    const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * inv;
    lower.inRange = nz > -1 && nz < 1;
    const w2 = w + e[7] * dy;
    if (!(w2 > 1e-6)) return false;
    const inv2 = 1 / w2;
    upper.x = this.halfW + (cx + e[4] * dy) * inv2 * this.halfW;
    upper.y = this.halfH - (cy + e[5] * dy) * inv2 * this.halfH;
    upper.inRange = lower.inRange;
    return true;
  }
}

/**
 * Rough terrain occlusion: sample the ground along the eye-to-target segment and see
 * whether a ridge rises above the line of sight. Eight samples is enough to catch a
 * hill between the camera and a unit without costing anything measurable.
 */
export function terrainOccludes(
  camera: THREE.PerspectiveCamera,
  tx: number,
  ty: number,
  tz: number,
  heightAt: (x: number, z: number) => number,
  slack = 1.2
): boolean {
  const ex = camera.position.x;
  const ey = camera.position.y;
  const ez = camera.position.z;
  for (let i = 1; i <= 8; i++) {
    const s = i / 9;
    const x = ex + (tx - ex) * s;
    const y = ey + (ty - ey) * s;
    const z = ez + (tz - ez) * s;
    if (heightAt(x, z) > y + slack) return true;
  }
  return false;
}
