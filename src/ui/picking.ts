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
 * Intersect the camera ray through (ndcX, ndcY) with the heightfield.
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
  maxDistance = 4200
): boolean {
  RAY_TMP.set(ndcX, ndcY, 0.5).unproject(camera);
  RAY_ORIGIN.copy(camera.position);
  RAY_DIR.copy(RAY_TMP).sub(RAY_ORIGIN);
  const len = RAY_DIR.length();
  if (len < 1e-6) return false;
  RAY_DIR.multiplyScalar(1 / len);

  // Looking at or above the horizon: no ground under the cursor.
  if (RAY_DIR.y > -0.012) return false;

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
  return t < maxDistance;
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
