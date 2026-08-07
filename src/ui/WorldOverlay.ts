/**
 * World-space HUD geometry: selection footprints, facing arrows, order paths and the
 * live formation ghost that follows a right-click drag.
 *
 * Everything is packed into two dynamic triangle batches — one depth-tested so ground
 * decals disappear behind hills, one not, so order lines stay readable over the men —
 * which keeps the entire overlay at two draw calls no matter how much is selected.
 *
 * Vertices carry RGBA directly, so a single unlit material covers glowing rings,
 * translucent plates and dashed lines without any per-object state changes.
 */

import * as THREE from 'three';
import { formation, ranksFor } from '../sim/formations';
import type { UnitGroupState } from '../sim/types';
import type { UnitView } from './model';

const VERT = `
attribute vec4 acolor;
varying vec4 vColor;
void main() {
  vColor = acolor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}
`;

type Height = (x: number, z: number) => number;

class Batch {
  readonly geometry = new THREE.BufferGeometry();
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private n = 0;
  private readonly capacity: number;

  /**
   * Absolute Y for the next vertices, or null to sample the heightfield.
   *
   * A marker for a cohort on the wall walk drawn against `heightAt` is painted on the paving
   * eight metres beneath its own unit, where the masonry hides it — so selecting the parapet
   * garrison looked like selecting nothing. Set it, draw, clear it; nothing keeps it across a
   * frame, so a caller that forgets cannot poison the batch.
   */
  levelY: number | null = null;

  constructor(maxTris: number, material: THREE.Material, private heightAt: Height, private lift: number) {
    this.capacity = maxTris * 3;
    this.pos = new Float32Array(this.capacity * 3);
    this.col = new Float32Array(this.capacity * 4);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('acolor', this.colAttr);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.matrixAutoUpdate = false;
  }

  reset(): void {
    this.n = 0;
    this.levelY = null;
  }

  private vertex(x: number, z: number, r: number, g: number, b: number, a: number): void {
    const i = this.n;
    if (i >= this.capacity) return;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = (this.levelY ?? this.heightAt(x, z)) + this.lift;
    this.pos[p + 2] = z;
    const c = i * 4;
    this.col[c] = r;
    this.col[c + 1] = g;
    this.col[c + 2] = b;
    this.col[c + 3] = a;
    this.n = i + 1;
  }

  /** Quad given in winding order a-b-c-d. */
  quad(
    ax: number, az: number, bx: number, bz: number,
    cx: number, cz: number, dx: number, dz: number,
    r: number, g: number, b: number, a: number
  ): void {
    if (this.n + 6 > this.capacity) return;
    this.vertex(ax, az, r, g, b, a);
    this.vertex(bx, bz, r, g, b, a);
    this.vertex(cx, cz, r, g, b, a);
    this.vertex(ax, az, r, g, b, a);
    this.vertex(cx, cz, r, g, b, a);
    this.vertex(dx, dz, r, g, b, a);
  }

  tri(
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
    r: number, g: number, b: number, a: number
  ): void {
    if (this.n + 3 > this.capacity) return;
    this.vertex(ax, az, r, g, b, a);
    this.vertex(bx, bz, r, g, b, a);
    this.vertex(cx, cz, r, g, b, a);
  }

  /** Thick line segment as a quad, with square ends so joints do not gap. */
  segment(
    x1: number, z1: number, x2: number, z2: number, w: number,
    r: number, g: number, b: number, a: number
  ): void {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) return;
    const nx = (-dz / l) * w * 0.5;
    const nz = (dx / l) * w * 0.5;
    this.quad(
      x1 + nx, z1 + nz, x2 + nx, z2 + nz,
      x2 - nx, z2 - nz, x1 - nx, z1 - nz,
      r, g, b, a
    );
  }

  dashed(
    x1: number, z1: number, x2: number, z2: number, w: number, dash: number,
    r: number, g: number, b: number, a: number
  ): void {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return;
    const ux = dx / l;
    const uz = dz / l;
    const step = dash * 2;
    for (let t = 0; t < l; t += step) {
      const e = Math.min(l, t + dash);
      this.segment(x1 + ux * t, z1 + uz * t, x1 + ux * e, z1 + uz * e, w, r, g, b, a);
    }
  }

  commit(): void {
    if (this.n === 0) {
      this.geometry.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.posAttr.addUpdateRange(0, this.n * 3);
    this.colAttr.addUpdateRange(0, this.n * 4);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.n);
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

const GOLD = [1.0, 0.66, 0.11] as const;
const GREEN = [0.44, 0.94, 0.36] as const;
const RED = [0.94, 0.35, 0.28] as const;
const PALE = [0.94, 0.92, 0.82] as const;

export interface GhostSpec {
  unit: UnitGroupState;
  /** Front-rank centre of the ghost formation. */
  x: number;
  z: number;
  facing: number;
  /** Men per rank the drag implies. */
  width: number;
  hostile: boolean;
  /** Draw individual men, not just the outline. */
  detail: boolean;
}

const SCRATCH = { x: 0, z: 0 };

export class WorldOverlay {
  private group = new THREE.Group();
  private ground!: Batch;
  private air!: Batch;
  private matGround!: THREE.ShaderMaterial;
  private matAir!: THREE.ShaderMaterial;

  /**
   * World metres per screen pixel at the focus plane. Marker outlines are sized from
   * this so a footprint reads as a crisp two-pixel line whether the camera is among
   * the men or looking down at the whole field.
   */
  metresPerPixel = 0.1;

  constructor(private heightAt: Height) {}

  /**
   * Line width in metres for a target thickness in screen pixels, with a world-space
   * ceiling. Without the ceiling a strategic-zoom camera turns every marker into a slab
   * wide enough to bury the men it is marking — and the bloom pass then blows it out.
   */
  private px(pixels: number, maxMetres = 1.1): number {
    return Math.min(maxMetres, Math.max(0.12, this.metresPerPixel * pixels));
  }

  init(scene: THREE.Scene): void {
    this.matGround = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      // Ground decals sit within centimetres of the terrain; the offset keeps them
      // from stitching in and out of it on slopes.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    this.matAir = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });

    this.ground = new Batch(3600, this.matGround, this.heightAt, 0.25);
    this.air = new Batch(1600, this.matAir, this.heightAt, 1.15);
    this.group.name = 'hud-overlay';
    this.group.renderOrder = 30;
    this.group.add(this.ground.mesh, this.air.mesh);
    scene.add(this.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }
  set visible(v: boolean) {
    this.group.visible = v;
  }

  begin(): void {
    this.ground.reset();
    this.air.reset();
  }

  end(): void {
    this.ground.commit();
    this.air.commit();
  }

  // -------------------------------------------------------------------------
  // Primitives in unit space
  // -------------------------------------------------------------------------

  /** Outline of a formation block, with a facing chevron off the front rank. */
  private block(
    b: Batch,
    x: number, z: number, facing: number, frontage: number, depth: number,
    w: number, col: readonly number[], alpha: number, fillAlpha: number
  ): void {
    const s = Math.sin(facing);
    const c = Math.cos(facing);
    // Unit-local axes: right = (c, -s), forward = (s, c).
    const rx = c;
    const rz = -s;
    const fx = s;
    const fz = c;
    const hw = frontage * 0.5;

    // Corners: front-left, front-right, back-right, back-left.
    const flx = x - rx * hw;
    const flz = z - rz * hw;
    const frx = x + rx * hw;
    const frz = z + rz * hw;
    const blx = flx - fx * depth;
    const blz = flz - fz * depth;
    const brx = frx - fx * depth;
    const brz = frz - fz * depth;

    if (fillAlpha > 0) {
      b.quad(flx, flz, frx, frz, brx, brz, blx, blz, col[0], col[1], col[2], fillAlpha);
    }

    // Corner brackets rather than a closed box: reads as a military marker and lets
    // the men inside stay visible.
    const cut = Math.min(hw * 0.62, Math.max(2.2, frontage * 0.16));
    const dcut = Math.min(depth * 0.62, Math.max(2.2, depth * 0.3));
    const seg = (x1: number, z1: number, x2: number, z2: number): void =>
      b.segment(x1, z1, x2, z2, w, col[0], col[1], col[2], alpha);

    // Front edge is drawn whole — it is the line the player is aiming.
    seg(flx, flz, frx, frz);
    seg(flx, flz, flx - fx * dcut, flz - fz * dcut);
    seg(frx, frz, frx - fx * dcut, frz - fz * dcut);
    seg(blx, blz, blx + rx * cut, blz + rz * cut);
    seg(brx, brz, brx - rx * cut, brz - rz * cut);
    seg(blx, blz, blx + fx * dcut, blz + fz * dcut);
    seg(brx, brz, brx + fx * dcut, brz + fz * dcut);

    // Facing chevron ahead of the centre of the front rank.
    const tip = Math.max(Math.min(2.6, frontage * 0.2), Math.min(7, frontage * 0.1));
    const halfSpan = tip * 0.95;
    const ax = x + fx * (tip * 1.9);
    const az = z + fz * (tip * 1.9);
    b.tri(
      ax, az,
      x - rx * halfSpan + fx * tip * 0.45, z - rz * halfSpan + fz * tip * 0.45,
      x + rx * halfSpan + fx * tip * 0.45, z + rz * halfSpan + fz * tip * 0.45,
      col[0], col[1], col[2], alpha
    );
  }

  // -------------------------------------------------------------------------
  // Public markers
  // -------------------------------------------------------------------------

  /**
   * The level to draw a unit's marker at: its men's own feet when they are standing on
   * something, and the heightfield otherwise. Same 2.5 m test `SelectionController` uses to
   * decide where the cursor is aimed, so the marker cannot end up on a different level from
   * the hit box that put it there.
   */
  private levelOf(v: UnitView): number | null {
    return v.standY - v.cy > 2.5 ? v.standY : null;
  }

  selectionMarker(v: UnitView): void {
    const u = v.unit;
    this.ground.levelY = this.levelOf(v);
    this.block(this.ground, u.x, u.z, u.facing, v.frontage, v.depth, this.px(2.6, 1), GOLD, 1, 0.07);
    this.ground.levelY = null;
  }

  hoverMarker(v: UnitView, hostile: boolean): void {
    const u = v.unit;
    const col = hostile ? RED : PALE;
    this.ground.levelY = this.levelOf(v);
    this.block(this.ground, u.x, u.z, u.facing, v.frontage, v.depth, this.px(1.8, 0.7), col, 0.7, 0.05);
    this.ground.levelY = null;
  }

  /** Dashed path from the unit to its objective, plus any queued waypoints. */
  orderPath(v: UnitView, hostileTarget: { x: number; z: number } | null): void {
    const u = v.unit;
    let px = u.x;
    let pz = u.z;
    const col = hostileTarget ? RED : GOLD;
    const target = hostileTarget ?? { x: u.targetX, z: u.targetZ };
    if (Math.hypot(target.x - px, target.z - pz) < 1.2 && u.waypoints.length === 0) return;

    const lw = this.px(2.2, 0.8);
    const dash = this.px(9, 6);
    this.air.dashed(px, pz, target.x, target.z, lw, dash, col[0], col[1], col[2], 0.75);
    px = target.x;
    pz = target.z;
    for (let i = 0; i + 2 < u.waypoints.length; i += 3) {
      const wx = u.waypoints[i];
      const wz = u.waypoints[i + 1];
      this.air.dashed(px, pz, wx, wz, lw, dash, GOLD[0], GOLD[1], GOLD[2], 0.55);
      this.node(wx, wz, this.px(5, 1.6), GOLD, 0.8);
      px = wx;
      pz = wz;
    }
    this.node(px, pz, this.px(7, 2.1), col, 0.9);
  }

  /** A small diamond marker on the ground. */
  private node(x: number, z: number, r: number, col: readonly number[], a: number): void {
    this.air.quad(x - r, z, x, z - r, x + r, z, x, z + r, col[0], col[1], col[2], a);
  }

  /**
   * The stretch of parapet a right-click would send the selection to, drawn *on the parapet*.
   *
   * The owner's report was that hovering the wall tells the player nothing. It cannot be drawn
   * against `heightAt`, which here is paving twelve metres beneath the walk and inside the
   * masonry; `levelY` puts it on the stone the men will actually stand on. Two rails along the
   * run rather than a filled patch, because what is being marked is a length of walkway and
   * the men are what should fill it.
   *
   * The rails run along x and are inset in z, which is not a guess: "the wall runs broadly
   * along x and the city is at +Z" is a stated constraint on every city plan
   * (`docs/ARCHITECTURE.md`), load-bearing in `bayAt`, `scenario.ts` and `Siege`.
   */
  wallTarget(x: number, z: number, y: number, halfLength: number): void {
    const w = this.px(2.2, 0.8);
    const inset = 1.1;
    // The `air` batch, not `ground`: `matAir` is `depthTest: false`, and a marker on top of a
    // wall is exactly the case where the merlons in front of it would otherwise eat it. The
    // `ground` batch's polygon offset is tuned for terrain decals and does not help here.
    this.air.levelY = y;
    for (const side of [-1, 1]) {
      this.air.segment(
        x - halfLength, z + side * inset, x + halfLength, z + side * inset,
        w, GOLD[0], GOLD[1], GOLD[2], 0.9
      );
    }
    this.node(x, z, this.px(6, 1.9), GOLD, 0.95);
    this.air.levelY = null;
  }

  /**
   * The deployment zone, as a dashed boundary with the front edge drawn solid.
   *
   * Into the *existing* ground batch, so this costs triangles and **no draw call** — the
   * whole-frame cap is 220 and Rome's assault camera already reports 268, so a new mesh for
   * a phase-only marker would be the wrong way to spend it. The front edge is solid and the
   * other three dashed, because the front edge is the one the player has to respect and the
   * rest are there to say how much room there is.
   */
  deployZone(
    xMin: number, zMin: number, xMax: number, zMax: number, frontIsLowZ: boolean
  ): void {
    const w = this.px(2.2, 1.4);
    const dash = this.px(16, 11);
    const a = 0.5;
    const [r, g, b] = GOLD;
    const front = frontIsLowZ ? zMin : zMax;
    const back = frontIsLowZ ? zMax : zMin;
    // Subdivided because the batch samples the heightfield once per vertex: a single 900 m
    // quad has only its two ends on the ground and buries its middle in any rise between.
    const steps = Math.max(2, Math.min(72, Math.round((xMax - xMin) / 24)));
    for (let i = 0; i < steps; i++) {
      const x1 = xMin + ((xMax - xMin) * i) / steps;
      const x2 = xMin + ((xMax - xMin) * (i + 1)) / steps;
      this.ground.segment(x1, front, x2, front, w * 1.6, r, g, b, a + 0.25);
      this.ground.dashed(x1, back, x2, back, w, dash, r, g, b, a);
    }
    const stepsZ = Math.max(2, Math.min(72, Math.round((zMax - zMin) / 24)));
    for (let i = 0; i < stepsZ; i++) {
      const z1 = zMin + ((zMax - zMin) * i) / stepsZ;
      const z2 = zMin + ((zMax - zMin) * (i + 1)) / stepsZ;
      this.ground.dashed(xMin, z1, xMin, z2, w, dash, r, g, b, a);
      this.ground.dashed(xMax, z1, xMax, z2, w, dash, r, g, b, a);
    }
  }

  /** The live formation preview under a right-click drag. */
  ghost(spec: GhostSpec): void {
    const u = spec.unit;
    const col = spec.hostile ? RED : GREEN;
    const alive = Math.max(1, u.alive);
    const width = Math.max(1, Math.min(alive, spec.width));
    const ranks = ranksFor(alive, width);
    const frontage = width * u.spacingX;
    const depth = Math.max(1.4, (ranks - 1) * u.spacingZ + 1.3);

    this.block(this.ground, spec.x, spec.z, spec.facing, frontage, depth, this.px(2.4, 1), col, 0.95, 0.12);

    // Dashed lead-in from where the unit is now.
    this.air.dashed(u.x, u.z, spec.x, spec.z, this.px(2, 0.8), this.px(9, 6), col[0], col[1], col[2], 0.6);

    if (!spec.detail) return;

    const f = formation(u.formationId);
    const s = Math.sin(spec.facing);
    const c = Math.cos(spec.facing);
    // Cap the drawn men: past a couple of hundred dots the shape is already legible
    // and the vertex budget is better spent elsewhere.
    const n = Math.min(alive, 220);
    const r = this.px(1.6, 0.6);
    for (let slot = 0; slot < n; slot++) {
      f.offset(SCRATCH, slot, width, ranks, u.spacingX, u.spacingZ);
      const wx = spec.x + SCRATCH.x * c + SCRATCH.z * s;
      const wz = spec.z - SCRATCH.x * s + SCRATCH.z * c;
      this.ground.quad(wx - r, wz, wx, wz - r, wx + r, wz, wx, wz + r, col[0], col[1], col[2], 0.72);
    }
  }

  dispose(): void {
    this.ground.dispose();
    this.air.dispose();
    this.matGround.dispose();
    this.matAir.dispose();
    this.group.removeFromParent();
  }
}
