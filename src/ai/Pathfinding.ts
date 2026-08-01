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
/**
 * A player's own order waits far longer before it is given up on.
 *
 * Fifteen seconds against the AI's three. An AI request that ages out is a plan the
 * commander has already replaced; a player request that ages out is a click that did
 * nothing, and the unit is meanwhile walking the straight line the order came in on. This
 * is priority-gated rather than a blanket rise so a busy AI still sheds work.
 */
const PLAYER_TTL_TICKS = 450;
/** Requests at or above this priority are the player's own and get the longer TTL. */
const PLAYER_PRIORITY = 3;
/** Hard cap on the request queue so a bug cannot make it grow without bound. */
const MAX_QUEUE = 48;

/**
 * Cost ceiling on a route: a multiple of the straight-line estimate, plus a flat allowance.
 *
 * Branch and bound, not a heuristic tweak — a cell whose `f` already exceeds what any
 * acceptable route may cost cannot lie on one, so it is never opened. Without it, eight
 * units ordered 140 m inside the city queued eight searches, the pathfinder ran flat out at
 * 2,400 expansions a tick for 100 ticks and spent **240,000 expansions on three searches**
 * — roughly 80,000 each — and the request TTL then binned the other twenty-one queued
 * requests in a single tick. Six of the eight player orders were never searched at all and
 * kept the straight line through the Aurelian Wall they were issued with. The cost is
 * inherent to an admissible heuristic: it aims every expansion at the curtain, so the whole
 * Campus Martius is expanded before the gate 200 m to the side is ever considered.
 *
 * Both constants are larger than the obvious values, and both were wrong smaller:
 *
 *  - **The multiplier is on a cost, not a length.** `g` accumulates `cost[i]`, which is 1 on
 *    firm level ground, up to 2.6 in the river margin and more on a slope, so a route only
 *    1.9x longer than the straight line can cost 4x it. At `MAX_DETOUR = 4` a *longer* order
 *    succeeded while a shorter one over the same ground failed.
 *  - **A multiplicative bound alone is nonsense for a short order.** A unit 53 m from a spot
 *    on the far side of the curtain must still walk to the Porta Flaminia and back, several
 *    hundred metres, and 4x53 does not reach it. Measured: that order returned no route at
 *    all and the unit stood against the wall — the player's original complaint, still live,
 *    for every order inside about 80 m of the curtain. The flat allowance is what carries a
 *    short order to an opening and back; 700 covers the Aurelian circuit's widest span
 *    between two legal openings, about 630 m.
 *
 * Both were tuned against cost, not taste. At 6x + 1400 the bound is so loose that the
 * queue never empties: 44% of searches hit `MAX_SEARCH_NODES`, and `pathfinding.fixedUpdate`
 * went from 0.22 ms to **1.45 ms** with `battle.fixedUpdate` following it from 0.89 to 2.04,
 * for no gain in route legality. At 4x + 700 both short and long orders route legally and
 * the pathfinder costs 0.265 ms with both commanders live.
 */
const MAX_DETOUR = 4;
const DETOUR_ALLOWANCE = 700;

/**
 * Expansions one search may spend before it settles for the best route it has found.
 *
 * A backstop under `MAX_DETOUR` for the case where the ellipse is still large — a
 * battlefield-crossing order. Five ticks of the whole budget is already a long time to hold
 * the queue against every other unit; beyond that the partial route is worth more than the
 * wait, and `BattleSystem.resumeRoute` will ask again from wherever the unit gets to.
 * Measured with both commanders live: 16 searches of 1,670 reach it.
 */
const MAX_SEARCH_NODES = 12000;

/**
 * How near a route must pass a gate before it is treated as using it, metres.
 *
 * Three fine cells. Closer than that and a route that merely skirts the gatehouse on the
 * outside would be dragged through the passage; further and a route that genuinely uses
 * the gate could be missed because A* approached it diagonally.
 */
const PORTAL_REACH = 24;
/**
 * How far outside the masonry the two locked axis points sit, metres.
 *
 * The Aurelian curtain is 3.5 m thick and the gatehouse block is 11 m deep, so 9 m either
 * side of the gate's own centre puts both points on open ground with the whole passage
 * between them, and the leg that joins them is perpendicular to the wall by construction.
 */
const PORTAL_STANDOFF = 9;

/**
 * Skirt on the straightening mask, metres.
 *
 * A string-pulled leg is walked as a straight line by a body about 2 m across, so 2.6 m of
 * margin is what it needs — not the half cell the expansion mask uses to guarantee an
 * unbroken barrier. Measured on eight routes across the city: straightening on the exact
 * mask left 16.2 m of path inside insulae (one route 14.5 m of it), a full half-cell skirt
 * cut that to 3.0 m but shattered the routes into 9 to 25 legs and cost an arrival.
 */
const TIGHT_PAD = 2.6;

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
/** Points the string-puller may not skip; parallel to RAW_PTS. See `routeThroughPortals`. */
const LOCKED: boolean[] = [];
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
  /** Oriented solid boxes: the curtain, the towers, the monuments and the insulae. */
  getObstacles?: () => unknown;
  getGates?: () => unknown;
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
  /**
   * Monotonic arrival number, so equal-priority requests are served oldest first.
   *
   * Without it `nextRequest` was last-in-first-out among requests queued on the same tick,
   * which is what a batch of orders always is: it scanned the queue backwards taking any
   * *strictly* better score, and eight requests with identical priority and identical age
   * all scored the same, so the newest won every time and the oldest never ran. The
   * comment on that loop claimed "so nothing starves". It starved everything but the last.
   */
  seq: number;
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
  /**
   * The same mask stamped conservatively: every solid grown by half a cell.
   *
   * Two masks, because expansion and straightening want opposite errors. A\* must expand on
   * the *exact* footprints or it cannot enter a street narrower than the skirt, and a
   * player destination in one of those streets is then unreachable — measured, the flat
   * half-cell skirt called 15.0% of the free ground inside the walls impassable and six of
   * eight units ordered into it stopped between 14 and 190 m short. The string-puller must
   * straighten on the *conservative* mask, because a leg it approves is walked in a
   * straight line by a body 2 m wide, and a cell centre outside a box says nothing about
   * whether the line between two of them clips its corner — with the exact mask alone,
   * routes picked up 12 to 47 m inside insulae apiece.
   */
  readonly tight: Uint8Array;
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
    this.tight = new Uint8Array(n);
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
        // Terrain impassability is exact — it is a heightfield sample, not a footprint —
        // so both masks agree on it and only structures differ.
        this.tight[i] = block;
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

  /**
   * Stamp an oriented solid box as impassable.
   *
   * Conservative by half a cell: a cell counts as blocked if its *centre* falls inside the
   * box grown by `CELL * 0.5`, so a 3.5 m wall lying between two rows of cell centres
   * still produces a continuous barrier. Under-stamping is the failure that matters here —
   * a one-cell hole in a curtain is a hole an A\* search will happily route a cohort
   * through, and the men will then walk into stone.
   *
   * The price is real and is worth stating: the grid calls 15.0% of the free ground inside
   * the walls impassable, because a half-cell skirt round a 14 m insula closes the narrower
   * streets. Two cheaper skirts were tried and measured, and both cost holes in the
   * curtain — padding each axis only to `CELL * 0.5 - h` opened **78 passable samples along
   * 1,812 m of solid wall** (the per-axis argument is sound for an axis-aligned slab and
   * every bay of the Aurelian curtain is rotated, because it follows the terrain crest),
   * and padding to `CELL / sqrt(2) - min(hw, hd)` opened 6 against a baseline of 3 while
   * dropping wall coverage from 95.0% to 89.8%. A destination in a street the grid has
   * closed is recovered instead by `BattleSystem.resumeRoute`, which costs nothing here.
   * `probe-nav --only=stamp` counts holes directly; do not change this without reading it.
   */
  blockBox(cx: number, cz: number, hw: number, hd: number, rot: number): void {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    /*
     * Two skirts. The conservative one is a flat half cell and always applies, to `tight`.
     * The one applied to `blocked` is dropped entirely for a box whose inscribed disc is at
     * least CELL/sqrt(2) across: such a box always covers a lattice point at any offset and
     * any rotation, so padding it cannot prevent a hole it was never going to have.
     *
     * The rotation clause is not decoration. Padding each axis only to `CELL * 0.5 - h` is
     * sound for an axis-aligned slab and unsound for a rotated one, and every bay of the
     * Aurelian curtain is rotated because it follows the terrain crest: that rule opened 78
     * passable samples along 1,812 m of solid wall. This one leaves the count at 3, all of
     * them inside the gate's own bay, while freeing 6.1% of the city's ground.
     */
    const exactPad = Math.min(hw, hd) >= CELL * Math.SQRT1_2 ? 0 : CELL * 0.5;
    // The straightening skirt only has to hold a formation's centre line clear of the box,
    // so it is a body's width, not a cell's. Never less than the expansion skirt, which is
    // what keeps the curtain continuous in both masks.
    const pad = Math.max(exactPad, TIGHT_PAD);
    const ehw = hw + pad;
    const ehd = hd + pad;
    // World-space AABB of the grown box.
    const ex = Math.abs(c) * ehw + Math.abs(s) * ehd;
    const ez = Math.abs(s) * ehw + Math.abs(c) * ehd;
    const x0 = this.toCell(cx - ex);
    const x1 = this.toCell(cx + ex);
    const z0 = this.toCell(cz - ez);
    const z1 = this.toCell(cz + ez);
    for (let gz = z0; gz <= z1; gz++) {
      const wz = this.toWorld(gz);
      const row = gz * this.res;
      for (let gx = x0; gx <= x1; gx++) {
        const dx = this.toWorld(gx) - cx;
        const dz = wz - cz;
        const u = dx * c + dz * s;
        if (u < -ehw || u > ehw) continue;
        const v = -dx * s + dz * c;
        if (v < -ehd || v > ehd) continue;
        this.tight[row + gx] = 2;
        if (u >= -hw - exactPad && u <= hw + exactPad && v >= -hd - exactPad && v <= hd + exactPad) {
          this.blocked[row + gx] = 2;
        }
      }
    }
  }

  /**
   * Re-open a disc of cells a structure closed — a gate's carriageway.
   *
   * Only clears cells the *structure* pass blocked (value 2). Terrain impassability is not
   * something a gate can undo, and clearing it would open a route across the Tiber.
   */
  clearStructure(x: number, z: number, radius: number): void {
    const pad = Math.ceil(radius / CELL);
    const bx = this.toCell(x);
    const bz = this.toCell(z);
    for (let dz = -pad; dz <= pad; dz++) {
      const gz = bz + dz;
      if (gz < 0 || gz >= this.res) continue;
      for (let dx = -pad; dx <= pad; dx++) {
        const gx = bx + dx;
        if (gx < 0 || gx >= this.res) continue;
        if (Math.hypot(this.toWorld(gx) - x, this.toWorld(gz) - z) > radius) continue;
        const i = gz * this.res + gx;
        if (this.blocked[i] === 2) this.blocked[i] = 0;
        if (this.tight[i] === 2) this.tight[i] = 0;
      }
    }
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
            this.tight[cz * this.res + cx] = 2;
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
      // `tight`, not `blocked`: see the field's own comment. A straightened leg is walked
      // as a straight line, so it must keep the conservative margin the expansion does not.
      if (this.tight[c]) return false;
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
  /**
   * Deepest node reached, kept only so a failed search can report how far it explored.
   *
   * It is deliberately **not** used as a route. It was, briefly: the idea was that a route
   * which must first walk *away* from its goal never improves on `h(start)`, so `bestCell`
   * stays at the start and the caller gets a one-point path it cannot install. Falling back
   * to the deepest node fixes that and introduces something worse — the deepest node is the
   * furthest thing explored, which is in whatever direction the frontier happened to run.
   * Measured: a 63 m order produced a 332 m route ending **215 m from where the player
   * clicked**, which is bug (a) wearing bug (b)'s clothes.
   *
   * The case it was reaching for is now handled where it belongs, by `MAX_DETOUR` and
   * `DETOUR_ALLOWANCE` being large enough for a real gate detour, so the search reaches the
   * goal instead of needing a consolation prize. Orders 30 m and 60 m inside the wall route
   * legally with this fallback gone.
   */
  private deepCell = -1;
  private deepG = -1;

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

  /** Nothing with an `f` above this is opened; see `MAX_DETOUR`. */
  private limit = Infinity;

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
    this.deepCell = start;
    this.deepG = 0;
    this.limit = this.f[start] * MAX_DETOUR + DETOUR_ALLOWANCE;
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
      if (this.g[current] > this.deepG) {
        this.deepG = this.g[current];
        this.deepCell = current;
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
        // Branch and bound. `f` is a lower bound on any route through this cell, so a cell
        // over the limit cannot lie on an acceptable one. Pruning here rather than at pop
        // keeps it out of the heap entirely, which is where the saving is.
        const fn = tentative + this.heuristic(n);
        if (fn > this.limit) continue;

        if (this.seen[n] !== id) {
          this.seen[n] = id;
          this.g[n] = tentative;
          this.from[n] = current;
          this.f[n] = fn;
          this.open.push(n);
        } else if (tentative < this.g[n] - 1e-4) {
          this.g[n] = tentative;
          this.from[n] = current;
          this.f[n] = fn;
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

  /**
   * The node closest to the goal that this search reached.
   *
   * When that is the start itself, the honest answer is "no progress" and the caller gets a
   * one-point path flagged `ok: false`. `BattleSystem` re-asks on that, which is a better
   * outcome than a confidently wrong route in the wrong direction; see `deepCell`.
   */
  get best(): number {
    return this.bestCell;
  }

  /** How far the frontier got, for diagnostics only. */
  get deepest(): number {
    return this.deepG;
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

  /**
   * Fold the fine grid into coarse cells: mean cost, blocked if a quarter is blocked.
   *
   * A quarter, not a third. A 3.5 m curtain stamps one or two of the 7 m fine cells in a
   * line, and a 28 m coarse cell is 4x4 of them — so a wall crossing it blocks 4 to 8 of
   * 16, which is 25% to 50%. At the old one-third threshold a single-cell-wide barrier
   * came out *passable* in the coarse field, and since the flow field is what every unit
   * heading for the same objective actually follows, the whole army was routed straight
   * through the Aurelian Wall by the one structure nobody was looking at.
   */
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
        this.blocked[i] = count === 0 || blockedCount * 4 >= count ? 1 : 0;
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
  /** Legal crossings the grid is too coarse to represent, read from `city.getGates()`. */
  private portals: { x: number; z: number; nx: number; nz: number }[] = [];
  /** The terrain-only mask, kept so a re-stamp does not have to resample the heightfield. */
  private terrainMask: Uint8Array | null = null;
  /** `obstacleGeneration` the grid was last stamped against. */
  private cityGeneration = -1;
  private queue: PathRequest[] = [];
  private results = new Map<number, NavPath>();
  private activeRequest: PathRequest | null = null;
  private tick = 0;
  /** Monotonic request counter; see `PathRequest.seq`. */
  private seq = 0;
  /** Set while finishing a search that hit `MAX_SEARCH_NODES`, to suppress the narrow retry. */
  private cappedOut = false;
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
    /**
     * Requests shed without ever being searched, by TTL or by queue overflow.
     *
     * NOT expected to be zero, and an earlier version of this comment claimed it should be.
     * Shedding is what a bounded queue does under load: measured at 3,074 men with both
     * commanders live, 112 requests were shed across 362 searches. It was happening before
     * this counter existed too — the old code spliced them out silently — so the number is
     * newly visible rather than newly true. What *must* stay at zero is `droppedPlayer`.
     */
    dropped: 0,
    /**
     * Of those, requests at player priority.
     *
     * The whole point of `PLAYER_PRIORITY`, `PLAYER_TTL_TICKS` and the priority ordering in
     * `evictOne` is that a human's click is never the thing thrown away. That is a claim,
     * so it is counted.
     */
    droppedPlayer: 0,
    /** Searches stopped at MAX_SEARCH_NODES and settled with a partial route. */
    capped: 0,
    /** Times the grid was re-stamped because the city changed under it. */
    restamps: 0,
    /** Tick of the most recent re-stamp, for the determinism probe. */
    lastRestampTick: -1,
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
    if (!city) return;
    this.restamp(city);
  }

  /**
   * Re-read the city's solids into the grid.
   *
   * Run again whenever the city bumps `obstacleGeneration`, because it does that at
   * runtime: `Siege` rams the Porta Flaminia open mid-battle (`Siege.setGateOpen`), and
   * `BattleSystem` already re-indexes its collision field on the same signal. Stamping only
   * at `init` left the pathfinder routing against the world as it was at deployment while
   * everything else moved on.
   *
   * The terrain mask is snapshotted before any structure is stamped, so a re-stamp restores
   * it rather than rebuilding it from the heightfield.
   */
  private restamp(city: CityNavProvider): void {
    if (this.terrainMask) {
      this.grid.blocked.set(this.terrainMask);
      this.grid.tight.set(this.terrainMask);
    } else {
      this.terrainMask = this.grid.blocked.slice();
    }

    let stamped = 0;
    try {
      stamped = city.getObstacles ? this.stampObstacles(city) : this.stampWallSegments(city);
      this.openGates(city);
    } catch (err) {
      // A foreign API that throws must not take the AI down with it.
      console.warn('[ai/pathfinding] city obstacle query failed, using terrain only:', err);
    }

    if (stamped > 0) {
      this.grid.rebuildClearance();
      this.grid.generation++;
      for (const f of this.flows.values()) f.downsample(this.grid);
    }
    this.stats.cityObstacles = stamped;
    this.cityGeneration = Number(
      (city as unknown as { obstacleGeneration?: number }).obstacleGeneration ?? 0
    );
  }

  /**
   * One integer compare per tick, which is every tick but the one where a gate gives way.
   *
   * A re-stamp costs a memcpy of two masks, 1,827 box stamps and a two-pass distance
   * transform: **measured at 20.5 ms**, which is one dropped frame. It is deliberately not
   * amortised. It happens at most once or twice in a battle — the moment the ram breaks the
   * gate, with the camera already shaking — and a pathfinder that is half-updated for
   * several frames is a worse thing to own than one frame that runs long.
   */
  private watchCity(): void {
    const city = this.city;
    if (!city) return;
    const gen = Number((city as unknown as { obstacleGeneration?: number }).obstacleGeneration ?? 0);
    if (gen === this.cityGeneration) return;
    try {
      this.stats.restamps++;
      this.stats.lastRestampTick = this.tick;
      this.restamp(city);
    } catch (err) {
      console.warn('[ai/pathfinding] city re-stamp failed, keeping the old grid:', err);
      this.cityGeneration = gen;
    }
  }

  /**
   * Stamp every solid the city publishes: the curtain, the towers, the monuments and all
   * two thousand nine hundred insulae.
   *
   * Until this existed the grid knew about the wall and nothing else. Measured: 72.6% of
   * the wall's masonry had a blocked nav cell under it, and **1.7% of the buildings' did** —
   * which is to say the pathfinder believed Rome was an open field with a fence across the
   * north side, and every route it produced through the city ran through houses.
   */
  private stampObstacles(city: CityNavProvider): number {
    const raw = city.getObstacles?.();
    if (!Array.isArray(raw)) return 0;
    let stamped = 0;
    for (const o of raw) {
      const b = o as Record<string, unknown>;
      const x = Number(b.x);
      const z = Number(b.z);
      const hw = Number(b.hw);
      const hd = Number(b.hd);
      const rot = Number(b.rot ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(hw) || !Number.isFinite(hd)) continue;
      this.grid.blockBox(x, z, hw, hd, Number.isFinite(rot) ? rot : 0);
      stamped++;
    }
    return stamped;
  }

  /**
   * Fallback for a city that publishes only wall segments.
   *
   * Kept because the AI must not depend on another agent's API landing, but note the
   * field name: the city publishes `halfThickness`, and this used to read
   * `thickness ?? width ?? 8` — so every bay was stamped at the 8 m fallback rather than
   * its true 3.5 m, a curtain 2.3x too thick in the grid.
   */
  private stampWallSegments(city: CityNavProvider): number {
    const raw = city.getWallSegments?.();
    if (!Array.isArray(raw)) return 0;
    let stamped = 0;
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
      const half = Number(s.halfThickness);
      const thickness = Number.isFinite(half) ? half * 2 : Number(s.thickness ?? s.width ?? 3.5);
      this.grid.blockSegment(x1, z1, x2, z2, Number.isFinite(thickness) ? thickness : 3.5);
      stamped++;
    }
    return stamped;
  }

  /**
   * Punch every open gate back out of the grid.
   *
   * The carriageway is 4.3 m and a fine cell is 7 m, so a conservative stamp closes it.
   * One cell of clearance is the honest answer anyway: `clearance` there comes out near
   * 3.5 m, so A\* admits only a unit whose footprint radius is under that — a column, not
   * a line. That is what a gate *is*, and `narrowestFormation` already exists to let a
   * cohort make itself thin enough to use one.
   */
  private openGates(city: CityNavProvider): void {
    this.portals.length = 0;
    const gates = city.getGates?.();
    if (!Array.isArray(gates)) return;
    for (const g of gates) {
      const gg = g as Record<string, unknown>;
      if (gg.open === false) continue;
      const x = Number(gg.x);
      const z = Number(gg.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      // Along the gate's own outward normal, so the passage is opened front to back
      // rather than as a blob that also eats the curtain either side of the gatehouse.
      const facing = Number(gg.facing ?? 0);
      const nx = Number.isFinite(facing) ? Math.sin(facing) : 0;
      const nz = Number.isFinite(facing) ? Math.cos(facing) : -1;
      for (let t = -14; t <= 14; t += CELL * 0.5) {
        this.grid.clearStructure(x + nx * t, z + nz * t, CELL * 0.5);
      }
      this.portals.push({ x, z, nx, nz });
    }
  }

  /**
   * Force a route that uses a gate onto the gate's own axis.
   *
   * The nav grid cannot express this passage. A cell is 7 m and the Porta Flaminia's
   * carriageway is 4.3 m, so `clearStructure` opens whichever cells have a centre within
   * 3.5 m of the axis, `rebuildClearance` then reports 7 m of clearance in them because
   * that is one cell step to the nearest blocked neighbour, and the string-puller straightens
   * the route through a corner of the gatehouse in good faith. Measured: four of eight
   * routes crossed the curtain 4.1 m west of the gate's centreline, and three cohorts then
   * parked their anchors against the masonry there for the rest of the run — 0.0, 0.2 and
   * 0.8 m of movement over five seconds while still holding a valid route.
   *
   * So the two points either side of the passage are inserted into the raw path and locked
   * against the smoother. They come from `getGates()`, so a gate that closes, opens, moves
   * or is joined by a second one changes this without an edit here.
   *
   * Returns the number of points written to `RAW_PTS`, and fills `LOCKED` for `smooth`.
   */
  private routeThroughPortals(n: number): number {
    LOCKED.length = 0;
    for (let i = 0; i < n; i++) LOCKED.push(false);
    if (this.portals.length === 0 || n < 2) return n;
    // Locks are spliced alongside the points rather than rebuilt, so a second gate cannot
    // unlock the first one's axis. Rebuilding the whole mask inside this loop did exactly
    // that: with two gates, the earlier portal's points were freed and the smoother
    // straightened the route 20 m along the curtain, through solid masonry.
    let shifted = false;

    for (const p of this.portals) {
      // Where does the path come closest to the gate? Only a path that actually uses it
      // is worth rewriting, and 24 m is three cells either side of the passage.
      let at = -1;
      let bestD = PORTAL_REACH;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(RAW_PTS[i * 2] - p.x, RAW_PTS[i * 2 + 1] - p.z);
        if (d < bestD) { bestD = d; at = i; }
      }
      if (at < 0) continue;
      // The path must genuinely pass through, not merely walk past the gatehouse outside.
      const sideStart = (RAW_PTS[0] - p.x) * p.nx + (RAW_PTS[1] - p.z) * p.nz;
      const sideEnd = (RAW_PTS[(n - 1) * 2] - p.x) * p.nx + (RAW_PTS[(n - 1) * 2 + 1] - p.z) * p.nz;
      if (sideStart * sideEnd > 0) continue;

      // Two points on the axis, outside and inside, ordered to match the direction of travel.
      const outer = sideStart > 0 ? PORTAL_STANDOFF : -PORTAL_STANDOFF;
      const ax = p.x + p.nx * outer;
      const az = p.z + p.nz * outer;
      const bx = p.x - p.nx * outer;
      const bz = p.z - p.nz * outer;

      // Replace the run of points nearest the gate. One point either side of `at` as well,
      // because those are the cell centres that were off-axis in the first place.
      const lo = Math.max(1, at - 1);
      const hi = Math.min(n - 2, at + 1);
      const tail: number[] = RAW_PTS.slice((hi + 1) * 2);
      RAW_PTS.length = lo * 2;
      RAW_PTS.push(ax, az, bx, bz);
      for (const v of tail) RAW_PTS.push(v);
      LOCKED.splice(lo, hi - lo + 1, true, true);
      n = RAW_PTS.length >> 1;
      shifted = true;
    }
    // Splices can leave the mask a point short or long if two portals overlapped; the
    // smoother keys off an exact length match, so make it exact.
    if (shifted) {
      while (LOCKED.length < n) LOCKED.push(false);
      LOCKED.length = n;
    }
    return n;
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
   * How far along a straight line a body of `radius` gets before it meets something, as a
   * fraction of the whole. 1 when the line is clear, 0 when it is blocked from the start.
   *
   * This is what lets an order that cannot be walked in a straight line still be *issued*
   * legally while its route is searched for. The alternative — leave the destination on the
   * far side of the wall and let per-man collision sort it out — is what the player was
   * seeing: measured, an attacking cohort spent 970 of 1,800 ticks with its anchor inside
   * masonry, grinding against the curtain because the order it held pointed through it.
   */
  clearLineFraction(x1: number, z1: number, x2: number, z2: number, radius: number): number {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return 1;
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
    let last = 0;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x1 + dx * t;
      const z = z1 + dz * t;
      if (!this.grid.inBounds(x, z)) break;
      const c = this.grid.cellAt(x, z);
      if (this.grid.tight[c]) break;
      if (this.grid.clearance[c] < radius) break;
      if (this.cityBlocks(x1, z1, x, z)) break;
      last = t;
    }
    return last;
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
    if (this.queue.length >= MAX_QUEUE) this.evictOne();
    this.queue.push({
      unitId, sx, sz, gx, gz,
      radius, wantRadius: radius, minRadius,
      priority, tick: this.tick, seq: this.seq++,
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
    // FLOW_PTS, not RAW_PTS, so `smooth` sees no lock mask — which is right: a flow route
    // never crosses a gate, because a 28 m coarse cell containing one is always blocked.
    return this.smooth(FLOW_PTS, n, radius, out);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(): void {
    const t0 = profileBegin();
    this.tick++;
    this.stats.nodesLastTick = 0;
    this.watchCity();

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

      if (state === 'running') {
        // A search that has spent this much and still not arrived is holding the queue
        // against every other unit. Settle for its best partial and move on.
        if (this.search.expansions >= MAX_SEARCH_NODES) {
          this.stats.capped++;
          this.search.active = false;
          // Settle, do not retry. `finishSearch` would otherwise re-queue this at the
          // narrowest footprint with `priority + 1`, so a capped search costs twice the cap
          // and an AI request is promoted into the player's priority band and TTL.
          this.cappedOut = true;
          this.finishSearch(false);
          this.cappedOut = false;
          continue;
        }
        break;
      }
      this.finishSearch(state === 'found');
    }

    this.stats.queueDepth = this.queue.length;
    profileEnd('pathfinding', t0);
  }

  /**
   * Make room in a full queue by dropping the least important request, with a marker.
   *
   * `shift()` dropped the *oldest*, which is the one the sequence ordering exists to
   * protect, and did it silently — so a player order evicted by an AI burst simply never
   * happened, with nothing for `BattleSystem` to re-ask on. Lowest priority first, newest
   * within a priority, and the same failure marker the TTL path writes.
   */
  private evictOne(): void {
    let worst = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i];
      const b = this.queue[worst];
      if (a.priority < b.priority || (a.priority === b.priority && a.seq > b.seq)) worst = i;
    }
    const r = this.queue.splice(worst, 1)[0];
    this.stats.dropped++;
    if (r.priority >= PLAYER_PRIORITY) this.stats.droppedPlayer++;
    DIRECT_PTS[0] = r.sx;
    DIRECT_PTS[1] = r.sz;
    this.store(r.unitId, r.gx, r.gz, r.radius, false, DIRECT_PTS, 1, false);
  }

  private nextRequest(): PathRequest | null {
    let best = -1;
    let bestPriority = -Infinity;
    let bestSeq = Infinity;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const r = this.queue[i];
      const ttl = r.priority >= PLAYER_PRIORITY ? PLAYER_TTL_TICKS : REQUEST_TTL_TICKS;
      if (this.tick - r.tick > ttl) {
        // Leave a mark. A caller that asked and never heard back cannot tell the
        // difference between "still thinking" and "given up", and `BattleSystem` needs
        // to know so it can re-ask rather than leave the unit on its straight line.
        this.stats.dropped++;
        if (r.priority >= PLAYER_PRIORITY) this.stats.droppedPlayer++;
        DIRECT_PTS[0] = r.sx;
        DIRECT_PTS[1] = r.sz;
        this.store(r.unitId, r.gx, r.gz, r.radius, false, DIRECT_PTS, 1, false);
        this.queue.splice(i, 1);
        continue;
      }
      // Priority first, then strictly oldest-first within a priority. The sequence number
      // is what makes the second half true: ages tie for every request queued on the same
      // tick, and a batch of orders is exactly that.
      if (r.priority > bestPriority || (r.priority === bestPriority && r.seq < bestSeq)) {
        bestPriority = r.priority;
        bestSeq = r.seq;
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

    if (!found && !this.cappedOut && r.radius > r.minRadius + 0.5) {
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

    let raw = this.cellsToPoints(RAW_CELLS, cells, r.sx, r.sz, r.gx, r.gz, found);
    raw = this.routeThroughPortals(raw);
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

    const locked = src === RAW_PTS && LOCKED.length === n ? LOCKED : null;
    let anchor = 0;
    while (anchor < n - 1) {
      const ax = src[anchor * 2];
      const az = src[anchor * 2 + 1];
      let last = anchor + 1;
      let probe = anchor + 1;
      while (probe + 1 < n) {
        // A locked point is a passage the grid cannot see; skipping it straightens the
        // route through the masonry either side of it.
        if (locked && locked[probe]) break;
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
