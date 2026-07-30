import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import { HALF_EXTENT, type TerrainSystem } from '../terrain/TerrainSystem';
import { clamp } from '../util/math';
import { Batch } from './build';
import { buildDistricts } from './insulae';
import { buildLandmarks } from './landmarks';
import {
  AQUEDUCTS,
  assertHillRing,
  assertNoFootprintOverlaps,
  assertOneAmphitheatre,
  assertTopology,
  KeepOut,
  LANDMARKS,
  STREETS,
  WALL,
} from './layout';
import { CITY_MAT_KEYS, CityMaterials } from './materials';
import { buildTreeChunks } from './props';
import { buildWall, type CityChunkSpec, type GateOut, type TreeRequest, type WallSegmentOut } from './wall';

/**
 * Rome, 271 AD: the Aurelian Wall under construction and the city behind it.
 *
 * Structure: every part of the city is authored as a `CityChunkSpec` — a centre, a
 * radius and a build function that takes a detail level. `init` bakes each chunk into
 * one merged mesh per material per detail level, and `preRender` swaps whole levels
 * by camera distance. That is what keeps 5 million triangles of city inside a
 * hundred draw calls: a district of two hundred insulae is two meshes, not four
 * hundred objects.
 *
 * The system also maintains a coarse masonry occupancy grid so pathfinding and siege
 * logic can ask whether a line of movement is blocked without knowing anything about
 * the geometry.
 */

interface LodLevel {
  group: THREE.Group;
  triangles: number;
}

interface Chunk {
  name: string;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  levels: LodLevel[];
  /** Distance at which level i+1 takes over from level i. */
  switchAt: number[];
  current: number;
  /** Which of this chunk's meshes may cast, and whether they currently do. */
  casters: THREE.Mesh[];
  casting: boolean;
}

/**
 * Beyond this distance a chunk stops casting.
 *
 * Every shadow-casting mesh is re-rendered once per cascade, so the shadow passes, not the
 * colour pass, are where a city of this size spends its draw calls. At three quarters of a
 * kilometre an insula's shadow is a couple of texels of the outermost cascade and its
 * contribution is a slightly darker smudge; the four extra draw calls buy nothing. Near
 * geometry — the curtain, its towers, the scaffolding — keeps casting, which is where
 * shadow actually carries the mass of the masonry.
 */
const SHADOW_CUTOFF = 700;

/** Cell size of the masonry occupancy grid, in metres. */
const OCC_CELL = 4;
const OCC_RES = Math.ceil((HALF_EXTENT * 2) / OCC_CELL);

export class CitySystem implements Subsystem {
  readonly name = 'city';
  // Static world: after terrain (−50), before anything that reads the city.
  readonly order = -20;

  private mats = new CityMaterials();

  /**
   * Skip the asset manifest and build every material procedurally. The city has to run
   * with an empty `public/assets/`, and this is how that gets tested in a frame rather
   * than asserted in a comment.
   */
  useProceduralTexturesOnly(on: boolean): void {
    this.mats.proceduralOnly = on;
  }
  private root = new THREE.Group();
  private chunks: Chunk[] = [];
  private segments: WallSegmentOut[] = [];
  private gateList: GateOut[] = [];
  private occ = new Uint8Array(OCC_RES * OCC_RES);
  private totalTris = 0;
  private meshCount = 0;
  private overlaps: ReturnType<typeof assertNoFootprintOverlaps> = { ok: true, count: 0, worst: 0, pairs: [] };
  private topology: ReturnType<typeof assertTopology> = { ok: true, checks: 0, failures: [] };
  private amphitheatres: ReturnType<typeof assertOneAmphitheatre> = { ok: true, count: 1, ids: ['colosseum'] };

  async init(ctx: EngineContext): Promise<void> {
    const terrain = ctx.get<TerrainSystem>('terrain');
    const heightAt = (x: number, z: number): number =>
      terrain.heightAt(clamp(x, -HALF_EXTENT, HALF_EXTENT), clamp(z, -HALF_EXTENT, HALF_EXTENT));

    await this.mats.load();

    this.root.name = 'city';
    ctx.scene.add(this.root);

    // ---- plan ---------------------------------------------------------------
    const wall = buildWall(heightAt, 'aurelian-271');
    this.segments = wall.segments;
    this.gateList = wall.gates;

    // Reserve every landmark's *oriented rectangular* footprint before a single insula
    // is generated. A circle is not good enough: the Circus Maximus is 621 × 118 m, and
    // the circle that used to stand in for it left five sixths of its footprint free for
    // the fabric to grow through — which is precisely what happened.
    const keepOut = new KeepOut();
    for (const l of LANDMARKS) {
      keepOut.addRect(l.x, l.z, l.hw, l.hd, l.rot);
      // A mound is bigger in plan than the building on it.
      if (l.mound) keepOut.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
    }
    for (const s of STREETS) keepOut.addPath(s.path, s.width * 0.5 + 2.5);
    for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);

    // Build-time assertion: no two monuments interpenetrate. Reported in `stats()` and
    // logged once, because a layout regression is otherwise invisible until someone
    // notices a temple inside a racetrack.
    this.overlaps = assertNoFootprintOverlaps();
    if (!this.overlaps.ok) {
      console.warn(
        `[city] ${this.overlaps.count} landmark footprint overlap(s), worst ${this.overlaps.worst} m: ` +
          this.overlaps.pairs.map((p) => `${p.a}/${p.b}`).join(', ')
      );
    }
    // ...and that separating them did not destroy the plan.
    this.topology = assertTopology();
    const ring = assertHillRing();
    this.topology = {
      ok: this.topology.ok && ring.ok,
      checks: this.topology.checks + ring.checks,
      failures: [...this.topology.failures, ...ring.failures],
    };
    if (!this.topology.ok) {
      console.warn(`[city] topology check failed: ${this.topology.failures.join('; ')}`);
    }
    // Exactly one Flavian Amphitheatre. See `assertOneAmphitheatre`.
    this.amphitheatres = assertOneAmphitheatre();
    if (!this.amphitheatres.ok) {
      console.warn(`[city] expected 1 amphitheatre, found ${this.amphitheatres.count}: ${this.amphitheatres.ids.join(', ')}`);
    }

    const landmarks = buildLandmarks(heightAt, 'rome-monuments');
    const districts = buildDistricts(heightAt, keepOut, 'rome-fabric', wall.wallZAt);

    const trees: TreeRequest[] = [...wall.trees, ...landmarks.trees, ...districts.trees];
    const specs: CityChunkSpec[] = [
      ...wall.chunks,
      ...landmarks.chunks,
      ...districts.chunks,
      ...buildTreeChunks(trees, heightAt),
    ];

    // ---- bake ---------------------------------------------------------------
    for (const spec of specs) this.bakeChunk(spec, heightAt);

    // ---- movement blocking --------------------------------------------------
    for (const b of wall.blockers) this.markSegment(b.x1, b.z1, b.x2, b.z2, b.halfW);
    // Tower footprints project beyond the curtain.
    for (const seg of this.segments) {
      this.markCircle(seg.x1, seg.z1, WALL.towerWidth * 0.5);
    }
    for (const f of landmarks.footprints) this.markRect(f.x, f.z, f.hw, f.hd, f.rot);
    for (const f of districts.footprints) this.markRect(f.x, f.z, f.hw, f.hd, f.rot);
    // The gate passage is open: clear it again so units can march through.
    for (const gate of this.gateList) {
      this.clearSegment(gate.x, gate.z - 20, gate.x, gate.z + 20, 2.4);
    }
  }

  /** Build every detail level of one chunk and register it for LOD swapping. */
  private bakeChunk(spec: CityChunkSpec, heightAt: (x: number, z: number) => number): void {
    const levels: LodLevel[] = [];
    const switchAt: number[] = [];
    const casters: THREE.Mesh[] = [];
    // Only build the levels the switch distances actually reach.
    const wanted: number[] = [2];
    if (spec.lodSwitch[0] < 1e8) wanted.push(1);
    if (spec.lodSwitch[1] < 1e8) wanted.push(0);
    wanted.sort((a, b) => b - a); // 2 (full) first

    for (let i = 0; i < wanted.length; i++) {
      const detail = wanted[i];
      // The cheapest level collapses into one material, so a whole district or a whole
      // stretch of wall becomes one mesh at long range. The middle level folds the trim
      // materials away, which halves its mesh count for no visible loss — see
      // `TRIM_MERGE` in build.ts.
      const batch = new Batch(
        this.mats,
        detail === 0 ? (spec.farMaterial ?? 'stone') : undefined,
        detail === 1
      );
      spec.build(batch, detail);
      const group = new THREE.Group();
      group.name = `${spec.name}-lod${i}`;
      group.visible = i === 0;
      // Only the nearest level casts. A chunk at its mid level is beyond its own
      // `lodSwitch[0]` — several hundred metres — where its shadow is already inside the
      // outer cascades' texel footprint, and re-rendering it four times to blur it away
      // was costing more calls than the whole city's main pass.
      const meshes = batch.toMeshes(spec.name, spec.castShadow && detail >= 2);
      for (const mesh of meshes) {
        group.add(mesh);
        if (mesh.castShadow) casters.push(mesh);
      }
      this.meshCount += meshes.length;
      levels.push({ group, triangles: batch.triangleCount });
      this.totalTris += batch.triangleCount;
      this.root.add(group);
      if (i < wanted.length - 1) switchAt.push(spec.lodSwitch[i]);
    }

    this.chunks.push({
      name: spec.name,
      cx: spec.cx,
      cy: heightAt(spec.cx, spec.cz) + 8,
      cz: spec.cz,
      radius: spec.radius,
      levels,
      switchAt,
      current: 0,
      casters,
      casting: true,
    });
  }

  /**
   * Swap detail levels by camera distance. Hysteresis of 12 % stops a chunk flipping
   * back and forth while the camera hovers on a threshold.
   */
  preRender(ctx: EngineContext): void {
    const cam = ctx.camera.position;
    for (const c of this.chunks) {
      const dx = cam.x - c.cx;
      const dy = cam.y - c.cy;
      const dz = cam.z - c.cz;
      // Distance to the chunk's surface, not its centre: a 1 km-wide district should
      // not drop to silhouette just because its midpoint is far away.
      const d = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - c.radius * 0.55);

      // Shadow casting by distance, with 15 % hysteresis so a hovering camera does not
      // flip a district's shadow on and off.
      if (c.casters.length > 0) {
        const want = d < SHADOW_CUTOFF * (c.casting ? 1.15 : 1.0);
        if (want !== c.casting) {
          c.casting = want;
          for (const m of c.casters) m.castShadow = want;
        }
      }

      if (c.levels.length < 2) continue;
      let want = c.levels.length - 1;
      for (let i = 0; i < c.switchAt.length; i++) {
        const t = c.switchAt[i] * (want === i ? 1 : 1);
        if (d < t * (c.current > i ? 0.88 : 1.0)) {
          want = i;
          break;
        }
      }
      if (want !== c.current) {
        c.levels[c.current].group.visible = false;
        c.levels[want].group.visible = true;
        c.current = want;
      }
    }
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  /** Wall segments as world-space line segments, for pathfinding and siege logic. */
  getWallSegments(): { x1: number; z1: number; x2: number; z2: number; height: number }[] {
    return this.segments;
  }

  /** Gate positions and whether they are open. `facing` points out of the city. */
  getGates(): { id: string; x: number; z: number; facing: number; open: boolean }[] {
    return this.gateList;
  }

  /** Open or close a gate. Closing it fills the passage in the movement grid. */
  setGateOpen(id: string, open: boolean): void {
    const gate = this.gateList.find((g) => g.id === id);
    if (!gate || gate.open === open) return;
    gate.open = open;
    if (open) this.clearSegment(gate.x, gate.z - 20, gate.x, gate.z + 20, 2.4);
    else this.markSegment(gate.x, gate.z - 6, gate.x, gate.z + 6, 2.6);
  }

  /**
   * True if a straight line between two points crosses masonry. Walks the occupancy
   * grid with a DDA, so cost is proportional to length, not to the number of
   * buildings — a unit can ask this every tick.
   */
  blocksMovement(x1: number, z1: number, x2: number, z2: number): boolean {
    let ix = this.cellOf(x1);
    let iz = this.cellOf(z1);
    const ex = this.cellOf(x2);
    const ez = this.cellOf(z2);
    if (this.occAt(ix, iz)) return true;
    if (ix === ex && iz === ez) return false;

    const dx = x2 - x1;
    const dz = z2 - z1;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    // Parametric length of the segment spent crossing one cell on each axis.
    const tPerX = dx !== 0 ? OCC_CELL / Math.abs(dx) : Infinity;
    const tPerZ = dz !== 0 ? OCC_CELL / Math.abs(dz) : Infinity;
    const fx = (x1 + HALF_EXTENT) / OCC_CELL - ix;
    const fz = (z1 + HALF_EXTENT) / OCC_CELL - iz;
    // Parameter at which the ray first crosses a cell boundary on each axis.
    let tx = dx !== 0 ? (dx > 0 ? 1 - fx : fx) * tPerX : Infinity;
    let tz = dz !== 0 ? (dz > 0 ? 1 - fz : fz) * tPerZ : Infinity;

    // `tx` and `tz` increase strictly, so the walk terminates once both pass 1.
    for (let guard = 0; guard < 4096; guard++) {
      if (tx < tz) {
        if (tx > 1) return false;
        ix += stepX;
        tx += tPerX;
      } else {
        if (tz > 1) return false;
        iz += stepZ;
        tz += tPerZ;
      }
      if (this.occAt(ix, iz)) return true;
      if (ix === ex && iz === ez) return false;
    }
    return false;
  }

  /** Height of the wall-walk above the datum nearest a point, or 0 outside the wall. */
  wallHeightNear(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (const s of this.segments) {
      const ax = s.x2 - s.x1;
      const az = s.z2 - s.z1;
      const len2 = ax * ax + az * az;
      const t = len2 < 1e-6 ? 0 : clamp(((x - s.x1) * ax + (z - s.z1) * az) / len2, 0, 1);
      const px = s.x1 + ax * t;
      const pz = s.z1 + az * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bestD) {
        bestD = d;
        best = s.height;
      }
    }
    return bestD < 400 ? best : 0;
  }

  /** Named monument positions, for the camera, the minimap and objective markers. */
  getLandmarks(): { id: string; name: string; x: number; z: number }[] {
    return LANDMARKS.map((l) => ({ id: l.id, name: l.name, x: l.x, z: l.z }));
  }

  /**
   * Build statistics for the debug overlay. `visibleMeshes` is the city's own upper
   * bound on draw calls this frame (before frustum culling), which is the number the
   * performance budget actually cares about.
   */
  stats(): {
    chunks: number;
    meshes: number;
    visibleMeshes: number;
    visibleTriangles: number;
    triangles: number;
    materials: number;
    usedManifest: boolean;
    /** Result of the build-time landmark footprint-overlap assertion. */
    footprintOverlaps: number;
    footprintOverlapWorst: number;
    /** Adjacency checks passed / total, from `assertTopology`. */
    topologyPass: number;
    topologyChecks: number;
    /** Count of Flavian-Amphitheatre-form buildings. Must be 1. */
    amphitheatres: number;
  } {
    let visibleMeshes = 0;
    let visibleTriangles = 0;
    for (const c of this.chunks) {
      const lvl = c.levels[c.current];
      visibleMeshes += lvl.group.children.length;
      visibleTriangles += lvl.triangles;
    }
    return {
      chunks: this.chunks.length,
      meshes: this.meshCount,
      visibleMeshes,
      visibleTriangles,
      triangles: this.totalTris,
      materials: CITY_MAT_KEYS.length,
      usedManifest: this.mats.usedManifest,
      footprintOverlaps: this.overlaps.count,
      footprintOverlapWorst: this.overlaps.worst,
      topologyPass: this.topology.checks - this.topology.failures.length,
      topologyChecks: this.topology.checks,
      amphitheatres: this.amphitheatres.count,
    };
  }

  /** Texture attribution gathered from the asset manifest, for ASSETS.md. */
  get credits(): readonly string[] {
    return this.mats.credits;
  }

  // ------------------------------------------------------------------------
  // Occupancy grid
  // ------------------------------------------------------------------------

  private cellOf(v: number): number {
    return clamp(Math.floor((v + HALF_EXTENT) / OCC_CELL), 0, OCC_RES - 1);
  }

  private occAt(ix: number, iz: number): boolean {
    if (ix < 0 || iz < 0 || ix >= OCC_RES || iz >= OCC_RES) return false;
    return this.occ[iz * OCC_RES + ix] !== 0;
  }

  private paint(ix: number, iz: number, value: number): void {
    if (ix < 0 || iz < 0 || ix >= OCC_RES || iz >= OCC_RES) return;
    this.occ[iz * OCC_RES + ix] = value;
  }

  private markSegment(x1: number, z1: number, x2: number, z2: number, halfW: number, value = 1): void {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const steps = Math.max(1, Math.ceil(len / (OCC_CELL * 0.5)));
    const r = Math.ceil((halfW + OCC_CELL) / OCC_CELL);
    // Distance-tested rather than a square stamp: a square would clear or block a
    // corridor two cells wider than asked, and the gate passage is only 4.3 m across.
    const lim = halfW + OCC_CELL * 0.5;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = x1 + (x2 - x1) * t;
      const pz = z1 + (z2 - z1) * t;
      const cx = this.cellOf(px);
      const cz = this.cellOf(pz);
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const wx = (cx + i) * OCC_CELL - HALF_EXTENT + OCC_CELL * 0.5;
          const wz = (cz + j) * OCC_CELL - HALF_EXTENT + OCC_CELL * 0.5;
          if (Math.hypot(wx - px, wz - pz) > lim) continue;
          this.paint(cx + i, cz + j, value);
        }
      }
    }
  }

  private clearSegment(x1: number, z1: number, x2: number, z2: number, halfW: number): void {
    this.markSegment(x1, z1, x2, z2, halfW, 0);
  }

  private markCircle(x: number, z: number, radius: number): void {
    const cx = this.cellOf(x);
    const cz = this.cellOf(z);
    const r = Math.ceil(radius / OCC_CELL);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        this.paint(cx + i, cz + j, 1);
      }
    }
  }

  private markRect(x: number, z: number, hw: number, hd: number, rot: number): void {
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const nu = Math.max(1, Math.ceil((hw * 2) / (OCC_CELL * 0.6)));
    const nv = Math.max(1, Math.ceil((hd * 2) / (OCC_CELL * 0.6)));
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = -hw + (hw * 2 * i) / nu;
        const v = -hd + (hd * 2 * j) / nv;
        this.paint(this.cellOf(x + u * cs - v * sn), this.cellOf(z + u * sn + v * cs), 1);
      }
    }
  }

  dispose(): void {
    for (const c of this.chunks) {
      for (const lvl of c.levels) {
        lvl.group.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) mesh.geometry.dispose();
        });
        lvl.group.removeFromParent();
      }
    }
    this.chunks.length = 0;
    this.root.removeFromParent();
    this.mats.dispose();
  }
}
