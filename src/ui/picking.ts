/**
 * Screen-to-world picking for order issuing and selection.
 *
 * Soldiers are GPU-instanced, so there is nothing in the scene graph to raycast
 * against. Everything here works from the unit groups' own formation geometry instead:
 * an oriented rectangle per unit whose width is the frontage and whose depth is the
 * ranks. That is exactly the footprint the sim lays men out into, so hit tests agree
 * with what the player sees.
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
 * An upright box the cursor can land on: a wall bay, a tower, an insula, a siege engine.
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
 * Intersect the camera ray through (ndcX, ndcY) with the heightfield, and optionally with a
 * set of solids.
 *
 * Without `solids` this only ever hits terrain, which is what made right-clicking a 20 m siege
 * tower issue a move order to the grass behind it — measured at 90.8 m from the tower before
 * the crew anchor was also fixed, and still 13.6 m out afterwards purely from this. A player
 * pointing at a tower means the tower.
 *
 * Rather than marching, this iterates the fixed point `t = (eyeY - h(p)) / -dir.y`.
 * On terrain this gentle it converges in three or four steps, and it costs four
 * `heightAt` samples instead of the fifty a march would need.
 */
export function screenToGround(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  heightAt: (x: number, z: number) => number,
  out: { x: number; y: number; z: number },
  maxDistance = 4200,
  solids?: readonly PickSolid[]
): boolean {
  RAY_TMP.set(ndcX, ndcY, 0.5).unproject(camera);
  RAY_ORIGIN.copy(camera.position);
  RAY_DIR.copy(RAY_TMP).sub(RAY_ORIGIN);
  const len = RAY_DIR.length();
  if (len < 1e-6) return false;
  RAY_DIR.multiplyScalar(1 / len);

  /*
   * Solids are tested BEFORE the horizon bail-out, and that ordering is the whole point.
   *
   * A player clicking the upper half of a 20 m siege tower or a wall-walk produces a ray that
   * rises — it never meets the heightfield at all. Testing solids after the bail-out meant
   * such a click returned false and issued no order whatsoever, which is worse than the
   * original bug. Found by aiming at a point two metres below a tower's roof and getting
   * `ok: false` from both arms of an A/B.
   */
  const tSolid = solids && solids.length
    ? raySolid(RAY_ORIGIN, RAY_DIR, solids, maxDistance)
    : -1;

  // Looking at or above the horizon: no ground under the cursor, but a solid may still be.
  if (RAY_DIR.y > -0.012) {
    if (tSolid < 0) return false;
    out.x = RAY_ORIGIN.x + RAY_DIR.x * tSolid;
    out.y = RAY_ORIGIN.y + RAY_DIR.y * tSolid;
    out.z = RAY_ORIGIN.z + RAY_DIR.z * tSolid;
    return true;
  }

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

  out.x = RAY_ORIGIN.x + RAY_DIR.x * t;
  out.z = RAY_ORIGIN.z + RAY_DIR.z * t;
  out.y = heightAt(out.x, out.z);

  // If a solid stands between the eye and that ground point, the player meant the solid.
  if (tSolid >= 0 && tSolid < t) {
    out.x = RAY_ORIGIN.x + RAY_DIR.x * tSolid;
    out.y = RAY_ORIGIN.y + RAY_DIR.y * tSolid;
    out.z = RAY_ORIGIN.z + RAY_DIR.z * tSolid;
    return true;
  }
  return t < maxDistance;
}

/**
 * Nearest ray hit against a set of upright oriented boxes, or -1.
 *
 * A standard slab test done in each box's own frame: rotate the ray by -rot about Y so the
 * box becomes axis-aligned, then intersect three slabs. The boxes are upright, so only the
 * horizontal pair needs rotating and the vertical slab runs from the terrain up to `topY`.
 *
 * There is no broadphase here on purpose. This runs once per pointer event, not per frame,
 * and 3,000 boxes at a handful of flops each is far below the cost of the `heightAt` samples
 * the caller has already paid. Adding a grid would be a second copy of the city's own
 * broadphase to keep in step with it.
 */
function raySolid(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  solids: readonly PickSolid[],
  maxT: number
): number {
  let best = -1;
  for (const s of solids) {
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

    // Vertical slab: base to top. `baseY` defaults generously low because an obstacle only
    // publishes its top — the city knows where the ground is and the box is upright.
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

    if (tmin >= 0 && tmin <= maxT && (best < 0 || tmin < best)) best = tmin;
  }
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
