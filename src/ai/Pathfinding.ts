import type { EngineContext, Subsystem } from '../core/Engine';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { formation, FORMATIONS } from '../sim/formations';
import type { UnitGroupState, UnitTypeDef } from '../sim/types';
import { isCavalry } from '../units/roster';
import { profileBegin, profileEnd } from './profile';

/**
 * Navigation for formed bodies of men.
 *
 * Two grids, because an army needs two different things:
 *
 *  - A **fine grid** (7 m cells, 401x401) carrying movement cost, a passability mask
 *    and a *clearance* field (metres to the nearest obstacle). 7 m is a little under
 *    the depth of a four-rank cohort, the smallest feature a formation can actually
 *    react to; finer than that buys detail the units cannot use.
 *  - A **coarse grid** (28 m cells, 101x101) carrying Dijkstra **flow fields**. When
 *    a dozen units are ordered onto the same objective, one field answers every
 *    query — exactly the many-to-one case A* handles badly.
 *
 * On top of them: budgeted incremental A* (hard cap on node expansions per fixed
 * step, searches resumed across ticks), string-pulling that tests the *formation
 * footprint* rather than a point, and a per-unit path cache with distance, age and
 * obstacle-generation invalidation.
 *
 * Nothing here mutates the simulation. It answers questions; the tactical layer turns
 * the answers into `orderIssued` events.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Fine cell size in metres. */
const CELL = 7;
/** Coarse cell = COARSE_MUL fine cells. */
const COARSE_MUL = 4;

/**
 * Above this gradient a formed unit cannot climb at all (about 32 degrees). Men can
 * scramble up worse than this, but not in ranks and not carrying a scutum.
 */
const SLOPE_IMPASSABLE = 0.62;
/** Cost multiplier per unit of gradient — a 1-in-3 slope roughly halves march speed. */
const SLOPE_COST_K = 5.0;
/** Extra metres-equivalent charged per metre climbed, on top of the slope cost. */
const CLIMB_COST_K = 1.4;
/**
 * The Tiber channel bottoms out well below the flood plain. Anything under this
 * height above datum is water deep enough to drown a man in mail.
 */
const WATER_LEVEL = 1.5;
/** Soft ground either side of the water: passable, but nobody wants to fight in it. */
const MARSH_LEVEL = 3.0;

/** A* node expansions allowed across all searches per fixed step. */
const NODE_BUDGET = 2400;
/** Coarse cells relaxed per fixed step while a flow field is building. */
const FLOW_BUDGET = 2600;
/** Requests waiting longer than this are dropped — the situation has moved on. */
const REQUEST_TTL_TICKS = 90;
/** Hard cap on the request queue so a bug cannot make it grow without bound. */
const MAX_QUEUE = 48;

// ---------------------------------------------------------------------------
// Scratch — hoisted to module scope so the hot paths never allocate
// ---------------------------------------------------------------------------

const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1];
const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const SQRT2 = Math.SQRT2;

/** Raw grid path in cell indices. */
const RAW_CELLS: number[] = [];
/** Un-smoothed world polyline. */
const RAW_PTS: number[] = [];
/** Smoothed output polyline. */
const SMOOTH_PTS: number[] = [];
/** Two-point polyline for the straight-line fast path. */
const DIRECT_PTS: number[] = [0, 0, 0, 0];
/** Flow-field descent polyline. */
const FLOW_PTS: number[] = [];
const FOOTPRINT_CACHE = new Map<string, Footprint>();

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface NavPath {
  unitId: number;
  /** Flat x,z pairs. Point 0 is the start, the last point is the goal. */
  pts: number[];
  n: number;
  goalX: number;
  goalZ: number;
  /** Footprint radius the route was actually cleared for, in metres. */
  radius: number;
  /** True when the route only fits if the unit narrows its frontage first. */
  narrow: boolean;
  /** Ground length in metres. */
  length: number;
  /** Tick the path was produced. */
  tick: number;
  /** Obstacle generation it was computed against. */
  generation: number;
  /** False when even a partial route could not be found. */
  ok: boolean;
}

export interface Footprint {
  /** Half-frontage in the unit's current formation, metres. */
  max: number;
  /** Half-frontage in the narrowest formation it knows, metres. */
  min: number;
}

/**
 * What the AI needs from the city subsystem, duck-typed. The CITY agent owns the real
 * interface; we probe for these two methods and degrade to terrain-only if either the
 * system or the method is absent, so the AI never depends on another agent landing.
 */
interface CityNavProvider {
  getWallSegments?: () => unknown;
  blocksMovement?: (x1: number, z1: number, x2: number, z2: number) => boolean;
}

interface PathRequest {
  unitId: number;
  sx: number;
  sz: number;
  gx: number;
  gz: number;
  /** Footprint this attempt is searching for. */
  radius: number;
  /** The footprint the unit would like — used to flag `narrow` results. */
  wantRadius: number;
  /** The narrowest footprint it can adopt. */
  minRadius: number;
  priority: number;
  tick: number;
}

// ---------------------------------------------------------------------------
// Binary min-heap over cell indices, keyed by an external score array
// ---------------------------------------------------------------------------

class CellHeap {
  private items: Int32Array;
  private size = 0;
  private readonly keys: Float32Array;

  constructor(capacity: number, keys: Float32Array) {
    this.items = new Int32Array(capacity);
    this.keys = keys;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.size = 0;
  }

  push(cell: number): void {
    if (this.size >= this.items.length) {
      const bigger = new Int32Array(this.items.length * 2);
      bigger.set(this.items);
      this.items = bigger;
    }
    let i = this.size++;
    const k = this.keys[cell];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[this.items[parent]] <= k) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = cell;
  }

  pop(): number {
    if (this.size === 0) return -1;
    const top = this.items[0];
    const last = this.items[--this.size];
    if (this.size > 0) {
      let i = 0;
      const k = this.keys[last];
      for (;;) {
        const l = i * 2 + 1;
        if (l >= this.size) break;
        const r = l + 1;
        const child = r < this.size && this.keys[this.items[r]] < this.keys[this.items[l]] ? r : l;
        if (this.keys[this.items[child]] >= k) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// The fine navigation grid
// ---------------------------------------------------------------------------

export class NavGrid {
  readonly cell = CELL;
  readonly res: number;
  readonly origin = -HALF_EXTENT;

  /** Ground height at the cell centre. */
  readonly height: Float32Array;
  /** Movement cost multiplier, >= 1. */
  readonly cost: Float32Array;
  /** 0 = passable, 1 = blocked by terrain, 2 = blocked by a structure. */
  readonly blocked: Uint8Array;
  /** Metres from the cell centre to the nearest blocked cell, capped at 400. */
  readonly clearance: Float32Array;

  /** Bumped whenever obstacles change, so cached paths can be invalidated. */
  generation = 1;

  constructor() {
    this.res = Math.ceil((HALF_EXTENT * 2) / CELL) + 1;
    const n = this.res * this.res;
    this.height = new Float32Array(n);
    this.cost = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    this.clearance = new Float32Array(n);
  }

  get cellCount(): number {
    return this.res * this.res;
  }

  /** World coordinate to grid index along one axis, clamped. */
  toCell(v: number): number {
    const c = Math.round((v - this.origin) / CELL);
    return c < 0 ? 0 : c >= this.res ? this.res - 1 : c;
  }

  /** Grid index to the world coordinate of the cell centre. */
  toWorld(c: number): number {
    return this.origin + c * CELL;
  }

  idx(cx: number, cz: number): number {
    return cz * this.res + cx;
  }

  cellAt(x: number, z: number): number {
    return this.idx(this.toCell(x), this.toCell(z));
  }

  inBounds(x: number, z: number): boolean {
    return x > this.origin && x < -this.origin && z > this.origin && z < -this.origin;
  }

  /** Sample terrain into the grid and derive cost from gradient and water depth. */
  build(terrain: TerrainSystem | undefined): void {
    const { res, height } = this;
    for (let cz = 0; cz < res; cz++) {
      const wz = this.toWorld(cz);
      const row = cz * res;
      for (let cx = 0; cx < res; cx++) {
        height[row + cx] = terrain ? terrain.heightAt(this.toWorld(cx), wz) : 0;
      }
    }
    this.deriveCost();
    this.rebuildClearance();
  }

  /**
   * Gradient is taken over the 7 m cell baseline rather than the terrain system's
   * finer sample spacing: what matters is whether a *rank* can hold its dressing
   * across the slope, not whether one man can find a foothold.
   */
  private deriveCost(): void {
    const { res, height, cost, blocked } = this;
    for (let cz = 0; cz < res; cz++) {
      for (let cx = 0; cx < res; cx++) {
        const i = cz * res + cx;
        const xm = cx > 0 ? i - 1 : i;
        const xp = cx < res - 1 ? i + 1 : i;
        const zm = cz > 0 ? i - res : i;
        const zp = cz < res - 1 ? i + res : i;
        const dhx = (height[xp] - height[xm]) / (CELL * (xp === xm ? 1 : 2));
        const dhz = (height[zp] - height[zm]) / (CELL * (zp === zm ? 1 : 2));
        const slope = Math.min(1, Math.hypot(dhx, dhz));
        const h = height[i];

        let c = 1 + slope * SLOPE_COST_K;
        let block = 0;
        if (slope > SLOPE_IMPASSABLE) block = 1;
        if (h < WATER_LEVEL) block = 1;
        else if (h < MARSH_LEVEL) c *= 2.6; // river margin: mud, reeds, broken ground
        // The outermost ring is off the playable field.
        if (cx === 0 || cz === 0 || cx === res - 1 || cz === res - 1) block = 1;

        cost[i] = c;
        blocked[i] = block;
      }
    }
  }

  /**
   * Two-pass chamfer distance transform: each free cell gets the distance in metres
   * to the nearest blocked cell. A* then rejects any cell whose clearance is below the
   * unit's footprint radius, which is what stops a 22 m frontage trying to squeeze
   * through an 8 m gate.
   */
  rebuildClearance(): void {
    const { res, blocked, clearance } = this;
    const INF = 1e9;
    const D1 = CELL;
    const D2 = CELL * SQRT2;

    for (let i = 0; i < clearance.length; i++) clearance[i] = blocked[i] ? 0 : INF;

    for (let cz = 0; cz < res; cz++) {
      for (let cx = 0; cx < res; cx++) {
        const i = cz * res + cx;
        if (clearance[i] === 0) continue;
        let best = clearance[i];
        if (cx > 0) best = Math.min(best, clearance[i - 1] + D1);
        if (cz > 0) best = Math.min(best, clearance[i - res] + D1);
        if (cx > 0 && cz > 0) best = Math.min(best, clearance[i - res - 1] + D2);
        if (cx < res - 1 && cz > 0) best = Math.min(best, clearance[i - res + 1] + D2);
        clearance[i] = best;
      }
    }
    for (let cz = res - 1; cz >= 0; cz--) {
      for (let cx = res - 1; cx >= 0; cx--) {
        const i = cz * res + cx;
        if (clearance[i] === 0) continue;
        let best = clearance[i];
        if (cx < res - 1) best = Math.min(best, clearance[i + 1] + D1);
        if (cz < res - 1) best = Math.min(best, clearance[i + res] + D1);
        if (cx < res - 1 && cz < res - 1) best = Math.min(best, clearance[i + res + 1] + D2);
        if (cx > 0 && cz < res - 1) best = Math.min(best, clearance[i + res - 1] + D2);
        clearance[i] = best;
      }
    }
    // Cap so the open plain does not carry nine-digit values into the comparisons.
    for (let i = 0; i < clearance.length; i++) if (clearance[i] > 400) clearance[i] = 400;
  }

  /** Stamp a wall segment of the given thickness as impassable. */
  blockSegment(x1: number, z1: number, x2: number, z2: number, thickness: number): void {
    const r = Math.max(CELL * 0.5, thickness * 0.5);
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / (CELL * 0.5)));
    const pad = Math.ceil(r / CELL);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x1 + (x2 - x1) * t;
      const z = z1 + (z2 - z1) * t;
      const bx = this.toCell(x);
      const bz = this.toCell(z);
      for (let dz = -pad; dz <= pad; dz++) {
        const cz = bz + dz;
        if (cz < 0 || cz >= this.res) continue;
        for (let dx = -pad; dx <= pad; dx++) {
          const cx = bx + dx;
          if (cx < 0 || cx >= this.res) continue;
          if (Math.hypot(this.toWorld(cx) - x, this.toWorld(cz) - z) <= r) {
            this.blocked[cz * this.res + cx] = 2;
          }
        }
      }
    }
  }

  costAt(x: number, z: number): number {
    return this.cost[this.cellAt(x, z)];
  }

  heightAtCell(x: number, z: number): number {
    return this.height[this.cellAt(x, z)];
  }

  blockedAt(x: number, z: number): boolean {
    return this.blocked[this.cellAt(x, z)] !== 0;
  }

  clearanceAt(x: number, z: number): number {
    return this.clearance[this.cellAt(x, z)];
  }

  /**
   * Is the corridor from (x1,z1) to (x2,z2) traversable by a body `radius` metres wide
   * either side of the centre line?
   *
   * The test is "every point on the centre line is at least `radius` from an obstacle",
   * evaluated against the clearance field. Sampling lateral offsets instead would be
   * both slower and *stricter than A\* itself* — A\* admits a cell on the clearance
   * field, so a smoother that used a different rule would refuse to straighten the very
   * routes A\* had just approved, and every path would come out as a grid staircase.
   */
  corridorClear(x1: number, z1: number, x2: number, z2: number, radius: number): boolean {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const c = this.cellAt(x1 + dx * t, z1 + dz * t);
      if (this.blocked[c]) return false;
      if (this.clearance[c] < radius) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Incremental A*
// ---------------------------------------------------------------------------

class AStarSearch {
  private readonly grid: NavGrid;
  private readonly g: Float32Array;
  private readonly f: Float32Array;
  private readonly from: Int32Array;
  /** Search generation in which this cell was first opened. */
  private readonly seen: Int32Array;
  /** Search generation in which this cell was expanded. */
  private readonly done: Int32Array;
  private readonly open: CellHeap;
  private searchId = 0;

  start = -1;
  goal = -1;
  radius = 0;
  active = false;
  expansions = 0;
  /** Node closest to the goal seen so far, so a failed search still yields progress. */
  private bestCell = -1;
  private bestH = Infinity;

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.cellCount;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Int32Array(n);
    this.done = new Int32Array(n);
    // 8k slots covers a battlefield-crossing search; the heap grows if it must.
    this.open = new CellHeap(8192, this.f);
  }

  /** Octile distance in metres — admissible because the minimum cell cost is 1. */
  private heuristic(cell: number): number {
    const res = this.grid.res;
    const ax = cell % res;
    const az = (cell - ax) / res;
    const bx = this.goal % res;
    const bz = (this.goal - bx) / res;
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * CELL;
  }

  begin(start: number, goal: number, radius: number): void {
    this.searchId++;
    this.start = start;
    this.goal = goal;
    this.radius = radius;
    this.active = true;
    this.expansions = 0;
    this.open.clear();
    this.seen[start] = this.searchId;
    this.g[start] = 0;
    this.f[start] = this.heuristic(start);
    this.from[start] = -1;
    this.bestCell = start;
    this.bestH = this.f[start];
    this.open.push(start);
  }

  /** Expand up to `budget` nodes. Returns the search state. */
  step(budget: number): 'running' | 'found' | 'failed' {
    const { grid } = this;
    const res = grid.res;
    const { cost, blocked, clearance, height } = grid;
    const id = this.searchId;
    let used = 0;
    // Stale heap entries are cheap to skip but must not spin forever.
    let pops = 0;
    const popLimit = budget * 6 + 64;

    while (used < budget && pops < popLimit) {
      const current = this.open.pop();
      pops++;
      if (current < 0) {
        this.active = false;
        return 'failed';
      }
      if (this.done[current] === id) continue;
      this.done[current] = id;
      used++;
      this.expansions++;

      if (current === this.goal) {
        this.active = false;
        return 'found';
      }

      const h = this.heuristic(current);
      if (h < this.bestH) {
        this.bestH = h;
        this.bestCell = current;
      }

      const cx = current % res;
      const cz = (current - cx) / res;
      const gc = this.g[current];
      const hc = height[current];
      const cc = cost[current];

      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOUR_DX[k];
        const nz = cz + NEIGHBOUR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
        const n = nz * res + nx;
        if (blocked[n]) continue;
        if (clearance[n] < this.radius) continue;

        const diagonal = k >= 4;
        // Never cut a corner between two obstacles — a formation cannot.
        if (diagonal && (blocked[cz * res + nx] || blocked[nz * res + cx])) continue;

        const stepLen = diagonal ? CELL * SQRT2 : CELL;
        const climb = height[n] - hc;
        const tentative = gc + stepLen * (cc + cost[n]) * 0.5 + (climb > 0 ? climb * CLIMB_COST_K : 0);

        if (this.seen[n] !== id) {
          this.seen[n] = id;
          this.g[n] = tentative;
          this.from[n] = current;
          this.f[n] = tentative + this.heuristic(n);
          this.open.push(n);
        } else if (tentative < this.g[n] - 1e-4) {
          this.g[n] = tentative;
          this.from[n] = current;
          this.f[n] = tentative + this.heuristic(n);
          this.open.push(n);
        }
      }
    }
    if (pops >= popLimit && this.open.length === 0) {
      this.active = false;
      return 'failed';
    }
    return 'running';
  }

  /** Walk the parent chain into `out`, start-first. Returns the cell count. */
  extract(out: number[], fromCell: number): number {
    out.length = 0;
    let c = fromCell;
    let guard = 0;
    while (c >= 0 && guard++ < 4096) {
      out.push(c);
      if (c === this.start) break;
      c = this.from[c];
    }
    out.reverse();
    return out.length;
  }

  /** The node closest to the goal that this search reached. */
  get best(): number {
    return this.bestCell;
  }
}

// ---------------------------------------------------------------------------
// Coarse Dijkstra flow field
// ---------------------------------------------------------------------------

export class FlowField {
  readonly res: number;
  readonly cell = CELL * COARSE_MUL;
  readonly origin = -HALF_EXTENT;

  private readonly dist: Float32Array;
  private readonly cost: Float32Array;
  private readonly blocked: Uint8Array;
  private readonly visited: Int32Array;
  private readonly heap: CellHeap;
  private pass = 0;

  goalX = 0;
  goalZ = 0;
  ready = false;
  building = false;

  constructor(fine: NavGrid) {
    this.res = Math.ceil((HALF_EXTENT * 2) / this.cell) + 1;
    const n = this.res * this.res;
    this.dist = new Float32Array(n);
    this.cost = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    this.visited = new Int32Array(n);
    this.heap = new CellHeap(4096, this.dist);
    this.downsample(fine);
  }

  /** Fold the fine grid into coarse cells: mean cost, blocked if a third is blocked. */
  downsample(fine: NavGrid): void {
    const { res } = this;
    const half = COARSE_MUL >> 1;
    for (let cz = 0; cz < res; cz++) {
      for (let cx = 0; cx < res; cx++) {
        let sum = 0;
        let count = 0;
        let blockedCount = 0;
        for (let dz = -half; dz < COARSE_MUL - half; dz++) {
          const fz = cz * COARSE_MUL + dz;
          if (fz < 0 || fz >= fine.res) continue;
          for (let dx = -half; dx < COARSE_MUL - half; dx++) {
            const fx = cx * COARSE_MUL + dx;
            if (fx < 0 || fx >= fine.res) continue;
            const fi = fz * fine.res + fx;
            count++;
            sum += fine.cost[fi];
            if (fine.blocked[fi]) blockedCount++;
          }
        }
        const i = cz * res + cx;
        this.cost[i] = count > 0 ? sum / count : 1;
        this.blocked[i] = count === 0 || blockedCount * 3 >= count ? 1 : 0;
      }
    }
    this.ready = false;
    this.building = false;
  }

  private toCell(v: number): number {
    const c = Math.round((v - this.origin) / this.cell);
    return c < 0 ? 0 : c >= this.res ? this.res - 1 : c;
  }

  private toWorld(c: number): number {
    return this.origin + c * this.cell;
  }

  begin(goalX: number, goalZ: number): void {
    this.goalX = goalX;
    this.goalZ = goalZ;
    this.pass++;
    this.ready = false;
    this.building = true;
    this.heap.clear();
    const g = this.toCell(goalX) + this.toCell(goalZ) * this.res;
    this.visited[g] = this.pass;
    this.dist[g] = 0;
    this.heap.push(g);
  }

  /** Relax up to `budget` cells. Returns true when the field is complete. */
  step(budget: number): boolean {
    if (!this.building) return this.ready;
    const { res, dist, cost, blocked, visited } = this;
    const pass = this.pass;
    let used = 0;
    while (used < budget) {
      const current = this.heap.pop();
      if (current < 0) {
        this.building = false;
        this.ready = true;
        return true;
      }
      used++;
      const cx = current % res;
      const cz = (current - cx) / res;
      const dc = dist[current];
      const cc = cost[current];

      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOUR_DX[k];
        const nz = cz + NEIGHBOUR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
        const n = nz * res + nx;
        if (blocked[n]) continue;
        const stepLen = k >= 4 ? this.cell * SQRT2 : this.cell;
        const nd = dc + stepLen * (cc + cost[n]) * 0.5;
        if (visited[n] !== pass) {
          visited[n] = pass;
          dist[n] = nd;
          this.heap.push(n);
        } else if (nd < dist[n] - 1e-4) {
          dist[n] = nd;
          this.heap.push(n);
        }
      }
    }
    return false;
  }

  /** Cost-to-goal at a world point, or -1 if the field never reached it. */
  distanceAt(x: number, z: number): number {
    const i = this.toCell(x) + this.toCell(z) * this.res;
    return this.visited[i] === this.pass ? this.dist[i] : -1;
  }

  /**
   * Walk downhill on the field from (x,z) toward the goal, writing world-space x,z
   * pairs into `out`. This is the many-to-one route: every unit reads the same field.
   */
  descend(x: number, z: number, out: number[], maxPoints = 48): number {
    out.length = 0;
    if (!this.ready) return 0;
    const res = this.res;
    let cx = this.toCell(x);
    let cz = this.toCell(z);
    let i = cz * res + cx;
    if (this.visited[i] !== this.pass) return 0;

    out.push(x, z);
    let arrived = this.dist[i] <= this.cell;
    let guard = 0;
    while (!arrived && guard++ < maxPoints) {
      let bestCell = -1;
      let bestD = this.dist[i];
      let bx = cx;
      let bz = cz;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOUR_DX[k];
        const nz = cz + NEIGHBOUR_DZ[k];
        if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
        const n = nz * res + nx;
        if (this.visited[n] !== this.pass || this.blocked[n]) continue;
        if (this.dist[n] < bestD) {
          bestD = this.dist[n];
          bestCell = n;
          bx = nx;
          bz = nz;
        }
      }
      if (bestCell < 0) break;
      cx = bx;
      cz = bz;
      i = bestCell;
      out.push(this.toWorld(cx), this.toWorld(cz));
      if (bestD <= this.cell) arrived = true;
    }
    // Only close onto the exact objective when the descent actually got there;
    // otherwise the last leg would be a straight line through whatever stopped it.
    if (arrived) out.push(this.goalX, this.goalZ);
    return out.length >> 1;
  }
}

// ---------------------------------------------------------------------------
// Footprint helpers
// ---------------------------------------------------------------------------

/**
 * Half-frontage in metres for a unit in its current formation, and the narrowest
 * half-frontage any formation it knows can give it. A 160-man cohort in line is
 * 26 files at 0.86 m — about 22 m wide, so 11 m of footprint radius; the same cohort
 * in testudo is 16 files at 0.52 m, under 5 m. That difference is what lets it thread
 * a gap it could not otherwise enter.
 */
export const footprintOf = (u: UnitGroupState, def: UnitTypeDef): Footprint => {
  const strength = u.alive || u.initialStrength;
  // Bucket the strength so attrition does not blow the cache out.
  const key = `${u.typeId}|${u.formationId}|${Math.ceil(strength / 20)}`;
  const hit = FOOTPRINT_CACHE.get(key);
  if (hit) return hit;

  const baseX = isCavalry(def) ? 1.95 : 0.86;
  const cur = formation(u.formationId);
  const max = cur.width(strength) * baseX * cur.spacingXMul * 0.5;
  let min = max;
  for (const id of def.formations) {
    const f = FORMATIONS[id];
    if (!f) continue;
    const w = f.width(strength) * baseX * f.spacingXMul * 0.5;
    if (w < min) min = w;
  }
  const out: Footprint = { max, min };
  FOOTPRINT_CACHE.set(key, out);
  return out;
};

/** The formation from `def.formations` with the narrowest frontage. */
export const narrowestFormation = (def: UnitTypeDef, strength: number): string => {
  let best = def.formations[0];
  let bestW = Infinity;
  const baseX = isCavalry(def) ? 1.95 : 0.86;
  for (const id of def.formations) {
    const f = FORMATIONS[id];
    if (!f) continue;
    const w = f.width(strength) * baseX * f.spacingXMul;
    if (w < bestW) {
      bestW = w;
      best = id;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// The subsystem
// ---------------------------------------------------------------------------

export class PathfindingSystem implements Subsystem {
  readonly name = 'pathfinding';
  readonly order = 40;

  grid!: NavGrid;
  private search!: AStarSearch;
  private flows = new Map<string, FlowField>();
  private queue: PathRequest[] = [];
  private results = new Map<number, NavPath>();
  private activeRequest: PathRequest | null = null;
  private tick = 0;
  private city: CityNavProvider | null = null;
  private terrain?: TerrainSystem;

  /** Counters for the debug overlay and the verification harness. */
  readonly stats = {
    requests: 0,
    straightLine: 0,
    searches: 0,
    failures: 0,
    narrowRetries: 0,
    nodesLastTick: 0,
    queueDepth: 0,
    flowRebuilds: 0,
    cityObstacles: 0,
  };

  init(ctx: EngineContext): void {
    this.terrain = ctx.tryGet<TerrainSystem>('terrain');
    this.grid = new NavGrid();
    this.grid.build(this.terrain);
    this.applyCityObstacles(ctx);
    this.search = new AStarSearch(this.grid);
  }

  /**
   * Pull structures out of the city subsystem if it is registered. Everything is
   * probed and wrapped, because the city agent owns that API and the AI must not fall
   * over if its shape differs or it is absent entirely.
   */
  private applyCityObstacles(ctx: EngineContext): void {
    const city = ctx.tryGet('city') as unknown as CityNavProvider | undefined;
    this.city = city ?? null;
    if (!city?.getWallSegments) return;

    let stamped = 0;
    try {
      const raw = city.getWallSegments();
      if (Array.isArray(raw)) {
        for (const seg of raw) {
          const s = seg as Record<string, unknown>;
          // Accept {x1,z1,x2,z2}, {ax,az,bx,bz} or {start:{x,z}, end:{x,z}}.
          const start = (s.start ?? s.a) as Record<string, number> | undefined;
          const end = (s.end ?? s.b) as Record<string, number> | undefined;
          const x1 = Number(s.x1 ?? s.ax ?? start?.x);
          const z1 = Number(s.z1 ?? s.az ?? start?.z);
          const x2 = Number(s.x2 ?? s.bx ?? end?.x);
          const z2 = Number(s.z2 ?? s.bz ?? end?.z);
          if (!Number.isFinite(x1) || !Number.isFinite(z1) || !Number.isFinite(x2) || !Number.isFinite(z2)) continue;
          // A gate is a hole in the wall, not a wall.
          if (s.gate === true || s.isGate === true || s.passable === true) continue;
          const thickness = Number(s.thickness ?? s.width ?? 8);
          this.grid.blockSegment(x1, z1, x2, z2, Number.isFinite(thickness) ? thickness : 8);
          stamped++;
        }
      }
    } catch (err) {
      // A foreign API that throws must not take the AI down with it.
      console.warn('[ai/pathfinding] city wall query failed, using terrain only:', err);
    }

    if (stamped > 0) {
      this.grid.rebuildClearance();
      this.grid.generation++;
      for (const f of this.flows.values()) f.downsample(this.grid);
    }
    this.stats.cityObstacles = stamped;
  }

  /** Ask the city whether a straight move is blocked, if it offers that service. */
  private cityBlocks(x1: number, z1: number, x2: number, z2: number): boolean {
    const fn = this.city?.blocksMovement;
    if (!fn) return false;
    try {
      return fn.call(this.city, x1, z1, x2, z2) === true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Terrain queries
  // -------------------------------------------------------------------------

  groundHeight(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? this.grid.heightAtCell(x, z);
  }

  slopeAt(x: number, z: number): number {
    return this.terrain?.slopeAt(x, z) ?? 0;
  }

  /**
   * Height advantage of (x,z) over the ground `ahead` metres along `facing`. Positive
   * means fighting downhill, which is worth real morale and real reach.
   */
  heightAdvantage(x: number, z: number, facing: number, ahead = 26): number {
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);
    return this.groundHeight(x, z) - this.groundHeight(x + fx * ahead, z + fz * ahead);
  }

  isWater(x: number, z: number): boolean {
    return this.groundHeight(x, z) < WATER_LEVEL;
  }

  /** Passable, and clear enough for a body of the given radius. */
  isStandable(x: number, z: number, radius: number): boolean {
    if (!this.grid.inBounds(x, z)) return false;
    if (this.grid.blockedAt(x, z)) return false;
    return this.grid.clearanceAt(x, z) >= radius;
  }

  /** Straight-line footprint test, including the city's own opinion. */
  directRouteClear(x1: number, z1: number, x2: number, z2: number, radius: number): boolean {
    if (!this.grid.corridorClear(x1, z1, x2, z2, radius)) return false;
    return !this.cityBlocks(x1, z1, x2, z2);
  }

  /**
   * Nudge a desired stand position to the nearest spot a formation of `radius` can
   * actually occupy, spiralling outward. Returns false if nothing within 84 m works.
   */
  findStandable(x: number, z: number, radius: number, out: { x: number; z: number }): boolean {
    out.x = x;
    out.z = z;
    if (this.isStandable(x, z, radius)) return true;
    for (let ring = 1; ring <= 6; ring++) {
      const r = ring * CELL * 2;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const px = x + Math.cos(ang) * r;
        const pz = z + Math.sin(ang) * r;
        if (this.isStandable(px, pz, radius)) {
          out.x = px;
          out.z = pz;
          return true;
        }
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Path requests
  // -------------------------------------------------------------------------

  /**
   * Queue a path. One request per unit at a time — a new request for the same unit
   * replaces the old one, because the unit has changed its mind.
   *
   * `radius` is the footprint the unit needs now; `minRadius` the narrowest it can
   * make itself. If only the narrow route exists the result is flagged `narrow`, and
   * the tactical layer changes formation before entering it.
   */
  requestPath(
    unitId: number,
    sx: number,
    sz: number,
    gx: number,
    gz: number,
    radius: number,
    minRadius: number,
    priority = 1
  ): void {
    this.stats.requests++;

    // The overwhelmingly common case on open ground: no search needed at all.
    if (this.directRouteClear(sx, sz, gx, gz, radius)) {
      this.stats.straightLine++;
      DIRECT_PTS[0] = sx;
      DIRECT_PTS[1] = sz;
      DIRECT_PTS[2] = gx;
      DIRECT_PTS[3] = gz;
      this.store(unitId, gx, gz, radius, false, DIRECT_PTS, 2, true);
      return;
    }

    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].unitId === unitId) {
        this.queue.splice(i, 1);
        break;
      }
    }
    if (this.activeRequest && this.activeRequest.unitId === unitId) {
      this.activeRequest = null;
      this.search.active = false;
    }
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({
      unitId, sx, sz, gx, gz,
      radius, wantRadius: radius, minRadius,
      priority, tick: this.tick,
    });
  }

  /** The most recent completed path for a unit, or null. */
  pathFor(unitId: number): NavPath | null {
    return this.results.get(unitId) ?? null;
  }

  pending(unitId: number): boolean {
    if (this.activeRequest?.unitId === unitId) return true;
    for (const r of this.queue) if (r.unitId === unitId) return true;
    return false;
  }

  clearPath(unitId: number): void {
    this.results.delete(unitId);
  }

  /**
   * Is a cached path still worth following? Invalidated by obstacle changes, by the
   * goal having moved, or by simple age — the battlefield moves.
   */
  pathStale(p: NavPath, gx: number, gz: number, maxAgeTicks = 150): boolean {
    if (!p.ok) return true;
    if (p.generation !== this.grid.generation) return true;
    if (this.tick - p.tick > maxAgeTicks) return true;
    return Math.hypot(gx - p.goalX, gz - p.goalZ) > 14;
  }

  // -------------------------------------------------------------------------
  // Flow fields
  // -------------------------------------------------------------------------

  /**
   * Get (building if needed) the shared flow field for `key`, aimed at (gx,gz).
   * Rebuilt when the objective moves more than 45 m — under that the field is close
   * enough, and rebuilding every tick would be pure waste.
   */
  flowField(key: string, gx: number, gz: number): FlowField {
    let f = this.flows.get(key);
    if (!f) {
      f = new FlowField(this.grid);
      this.flows.set(key, f);
    }
    const moved = Math.hypot(gx - f.goalX, gz - f.goalZ) > 45;
    if (!f.building && (!f.ready || moved)) {
      f.begin(gx, gz);
      this.stats.flowRebuilds++;
    }
    return f;
  }

  /**
   * Route from (sx,sz) toward the field's objective, string-pulled for a formation of
   * `radius`. Returns the number of points written to `out` (flat x,z pairs), or 0 if
   * the field is not ready yet.
   */
  flowRoute(
    key: string,
    gx: number,
    gz: number,
    sx: number,
    sz: number,
    radius: number,
    out: number[]
  ): number {
    const f = this.flowField(key, gx, gz);
    if (!f.ready) return 0;
    const n = f.descend(sx, sz, FLOW_PTS);
    if (n < 2) return 0;
    return this.smooth(FLOW_PTS, n, radius, out);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(): void {
    const t0 = profileBegin();
    this.tick++;
    this.stats.nodesLastTick = 0;

    // Finish any flow field that is still building before spending time on A*:
    // a field serves every unit, an A* path serves one.
    let flowBudget = FLOW_BUDGET;
    for (const f of this.flows.values()) {
      if (f.building && flowBudget > 0) {
        f.step(flowBudget);
        flowBudget = 0;
      }
    }

    let budget = NODE_BUDGET;
    let guard = 0;
    while (budget > 0 && guard++ < 8) {
      if (!this.activeRequest) {
        const next = this.nextRequest();
        if (!next) break;
        this.activeRequest = next;
        this.stats.searches++;
        this.search.begin(
          this.grid.cellAt(next.sx, next.sz),
          this.grid.cellAt(next.gx, next.gz),
          next.radius
        );
      }
      const before = this.search.expansions;
      const state = this.search.step(budget);
      const used = this.search.expansions - before;
      budget -= Math.max(1, used);
      this.stats.nodesLastTick += used;

      if (state === 'running') break;
      this.finishSearch(state === 'found');
    }

    this.stats.queueDepth = this.queue.length;
    profileEnd('pathfinding', t0);
  }

  private nextRequest(): PathRequest | null {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const r = this.queue[i];
      if (this.tick - r.tick > REQUEST_TTL_TICKS) {
        this.queue.splice(i, 1);
        continue;
      }
      // Priority first, age second, so nothing starves.
      const score = r.priority * 100 + (this.tick - r.tick);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return null;
    return this.queue.splice(best, 1)[0];
  }

  private finishSearch(found: boolean): void {
    const r = this.activeRequest;
    this.activeRequest = null;
    if (!r) return;

    if (!found && r.radius > r.minRadius + 0.5) {
      // Retry once at the narrowest footprint the unit can adopt: a gap a line
      // cannot enter is often a gap a column can.
      this.stats.narrowRetries++;
      r.radius = r.minRadius;
      r.priority += 1;
      r.tick = this.tick;
      this.queue.push(r);
      return;
    }

    const endCell = found ? this.search.goal : this.search.best;
    const cells = this.search.extract(RAW_CELLS, endCell);
    if (cells < 2) {
      this.stats.failures++;
      DIRECT_PTS[0] = r.sx;
      DIRECT_PTS[1] = r.sz;
      this.store(r.unitId, r.gx, r.gz, r.radius, false, DIRECT_PTS, 1, false);
      return;
    }
    if (!found) this.stats.failures++;

    const raw = this.cellsToPoints(RAW_CELLS, cells, r.sx, r.sz, r.gx, r.gz, found);
    const n = this.smooth(RAW_PTS, raw, r.radius, SMOOTH_PTS);
    this.store(r.unitId, r.gx, r.gz, r.radius, r.radius < r.wantRadius - 0.5, SMOOTH_PTS, n, found);
  }

  /** Convert grid cells to world points in RAW_PTS, snapping the ends. */
  private cellsToPoints(
    cells: number[],
    n: number,
    sx: number,
    sz: number,
    gx: number,
    gz: number,
    exactGoal: boolean
  ): number {
    const res = this.grid.res;
    RAW_PTS.length = 0;
    RAW_PTS.push(sx, sz);
    const last = exactGoal ? n - 1 : n;
    for (let i = 1; i < last; i++) {
      const c = cells[i];
      const cx = c % res;
      const cz = (c - cx) / res;
      RAW_PTS.push(this.grid.toWorld(cx), this.grid.toWorld(cz));
    }
    if (exactGoal) RAW_PTS.push(gx, gz);
    return RAW_PTS.length >> 1;
  }

  /**
   * String-pulling: from each anchor, push a probe as far along the raw polyline as
   * the *corridor* stays clear for the unit's footprint, then keep only that point.
   * A grid staircase collapses into the two or three straight legs a column would
   * actually march.
   */
  private smooth(src: number[], n: number, radius: number, out: number[]): number {
    out.length = 0;
    if (n <= 0) return 0;
    out.push(src[0], src[1]);
    if (n === 1) return 1;

    let anchor = 0;
    while (anchor < n - 1) {
      const ax = src[anchor * 2];
      const az = src[anchor * 2 + 1];
      let last = anchor + 1;
      let probe = anchor + 1;
      while (probe + 1 < n) {
        const nx = src[(probe + 1) * 2];
        const nz = src[(probe + 1) * 2 + 1];
        if (!this.grid.corridorClear(ax, az, nx, nz, radius)) break;
        probe++;
        last = probe;
      }
      out.push(src[last * 2], src[last * 2 + 1]);
      anchor = last;
    }
    return out.length >> 1;
  }

  private store(
    unitId: number,
    gx: number,
    gz: number,
    radius: number,
    narrow: boolean,
    pts: number[],
    n: number,
    ok: boolean
  ): void {
    let p = this.results.get(unitId);
    if (!p) {
      p = {
        unitId, pts: [], n: 0, goalX: gx, goalZ: gz,
        radius, narrow, length: 0, tick: this.tick,
        generation: this.grid.generation, ok,
      };
      this.results.set(unitId, p);
    }
    p.pts.length = 0;
    for (let i = 0; i < n * 2; i++) p.pts.push(pts[i]);
    p.n = n;
    p.goalX = gx;
    p.goalZ = gz;
    p.radius = radius;
    p.narrow = narrow;
    p.ok = ok;
    p.tick = this.tick;
    p.generation = this.grid.generation;
    let len = 0;
    for (let i = 1; i < n; i++) {
      len += Math.hypot(p.pts[i * 2] - p.pts[(i - 1) * 2], p.pts[i * 2 + 1] - p.pts[(i - 1) * 2 + 1]);
    }
    p.length = len;
  }
}
