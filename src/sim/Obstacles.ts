/**
 * Solid world geometry, and the query a moving man needs against it.
 *
 * Before this existed the simulation had no notion of a solid object at all. `integrate`
 * was a Euler step and nothing else, so a cohort ordered at the Aurelian Wall walked into
 * 3.5 m of brick and out the other side. Measured over 45 s of the assault scenario at
 * 1,600 men: **165,909 man-ticks inside the curtain** (98.5 per thousand) and 41,129
 * inside an insula, the deepest 19.2 m below the wall-walk.
 *
 * The city already knew all of it — `CitySystem` rasterises 2,907 insula footprints, 34
 * monuments and 47 wall blockers into a private 4 m occupancy grid — but the only readout
 * was a boolean line test, and nothing in `src/sim` ever called it. This module takes the
 * same rectangles as *oriented boxes* rather than a raster, so the collision surface is
 * the geometry rather than a 4 m staircase, and indexes them for O(1) point queries.
 *
 * Two design points worth stating, because both were bugs elsewhere in this project:
 *
 *  - **Obstacles have a top.** Every box carries an absolute `topY`, and a man whose feet
 *    are at or above it is standing *on* the thing, not inside it. Without that the first
 *    query would have pushed all 810 men of the garrison off their own wall. This is the
 *    same class of assumption as `SAME_LEVEL_DY` in `BattleSystem`, which exists because
 *    the soldier `SpatialHash` buckets on x/z and never reads y.
 *  - **Nothing here allocates.** `resolve` writes into a caller-supplied scratch object and
 *    the broadphase is two flat typed arrays built by counting sort, because this runs for
 *    every living man on every fixed step inside a 4 ms budget.
 */

/** An oriented, axis-aligned-in-its-own-frame solid box. */
export interface Obstacle {
  /** Centre of the footprint, world metres. */
  x: number;
  z: number;
  /** Half-extents along the box's own u (x-like) and v (z-like) axes. */
  hw: number;
  hd: number;
  /** Yaw of the box's u axis about +Y, radians. */
  rot: number;
  /**
   * Absolute Y of the top of the solid.
   *
   * A man at or above this is on the roof, the wall-walk or the rampart and is not
   * obstructed. For a curtain bay this is the wall-walk; for an insula, the eaves.
   */
  topY: number;
  kind: ObstacleKind;
}

export type ObstacleKind = 'wall' | 'tower' | 'gate' | 'building' | 'monument';

/**
 * Vertical slack on the "am I on top of this?" test, metres.
 *
 * A garrison stands with `support[i]` set to the wall-walk's own Y, so the difference is
 * nominally zero; this absorbs the float error between the height the geometry was built
 * at and the height the siege system placed a man at, and lets a man step up onto a low
 * footing course rather than being stopped by a 0.2 m kerb.
 */
const TOP_SLACK = 0.4;

/** Broadphase cell, metres. Roughly two insulae across; 3,000 boxes land ~1.5 per cell. */
const BIN = 16;

// ---------------------------------------------------------------------------
// Standing work that is crossed rather than stopped at
// ---------------------------------------------------------------------------

/**
 * A solid low enough to get over, published so it can be charged for rather than sealed.
 *
 * The case this exists for is the three bays of the Aurelian circuit at stage `footing`:
 * 6.8 m of travertine plinth and poured concrete standing 1.4–3.5 m above the ground beside
 * it. They are deliberately the only way into Rome that needs no ladder, so they must not
 * become `Obstacle`s — every consumer of that list treats what it finds as impassable. But
 * until this existed they were not in *any* list, and the consequence was measured: a
 * squadron of horse crossed one at a flat gallop in 3.4 seconds, and the nav raster charged
 * less for the cell on the wall's own centreline than for the open grass in front of it.
 */
export interface RoughBox {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Metres a body has to climb to get over it, worst case. */
  rise: number;
}

/**
 * Gradient above which a formed body cannot climb at all — about 32 degrees.
 *
 * **This is the definition, not a copy of one.** It lived in `src/ai/Pathfinding.ts` as
 * `SLOPE_IMPASSABLE` and now lives here, because two consumers need it and the dependency
 * only runs one way: `src/ai` imports `src/sim` in five files and the reverse would invert
 * it. `Pathfinding` aliases these rather than restating them, so there is no second number
 * to drift.
 */
export const ROUGH_SLOPE_IMPASSABLE = 0.62;
/** Cost multiplier per unit of gradient — a 1-in-3 slope roughly halves march speed. */
export const ROUGH_SLOPE_COST_K = 5.0;

/**
 * Does standing work slow a body that crosses it? **Off, and off is a measurement.**
 *
 * The nav raster's half of this is a correctness fix and is always on: charging nothing to
 * cross 6.8 m of concrete was simply wrong, and putting it right does not touch the balance
 * of the battle. Measured over twelve seeds it does not even reduce the traffic — 824
 * crossings become 928 — and the attacker's win rate goes from 1 of 12 to 2 of 12.
 *
 * The integrator's half is different, and the difference is the whole reason this flag
 * exists. There is exactly one magnitude available that is not invented — the grid's own
 * rule for sloping ground, which on bay 28 gives 4.41 — and applied to movement it takes
 * the assault to **0 of 12**:
 *
 *     arm                       Juthungi wins   crossings   rider s   warband s
 *     baseline                        1 / 12         824       9.8        8.4
 *     nav cost only                   2 / 12         928       5.6       16.9
 *     nav cost + drag 4.41x           0 / 12         719      11.3       24.1
 *
 * It is doing what it was asked to do — infantry crossings fall 61 % and take three times
 * as long — and the side effect is that the three bays stop being a way in. Those bays are
 * deliberate, they are historically right, and they are the attacker's only winning route,
 * so making the battle unlosable is not a call this module gets to make. The mechanism is
 * kept, tested and one word from working; the number is the owner's.
 *
 * Turning it on costs nothing while it is off: `BattleSystem` never publishes a rough set,
 * `ObstacleField.noRough` stays true, and the per-man multiplier array stays all ones.
 *
 * `tools/probe-footing.mjs --traverse=<cost>` sweeps it without a rebuild.
 */
export const ROUGH_SLOWS_MOVEMENT = false;

/**
 * What it costs to cross standing work, on the same scale `NavGrid.cost` uses.
 *
 * **One function, because the planner and the mover must not disagree.** The pathfinder
 * charges this into the raster so a route over a footing is no longer free, and the
 * integrator turns the same number into a speed multiplier so the body pays what the plan
 * was quoted. Two derivations of "how hard is this to cross" is the defect class this
 * repository keeps producing.
 *
 * The rule is the grid's own rule for terrain and introduces no constant of its own: a
 * body goes up `rise` over `run` metres, that is a gradient, and a gradient costs
 * `1 + g * ROUGH_SLOPE_COST_K`. Two things are worth saying plainly about it:
 *
 *  - **It is the lenient reading.** Bay 28's pour is 2.33 m over a 3.42 m half-depth, a
 *    gradient of 0.68, and `ROUGH_SLOPE_IMPASSABLE` is 0.62 — the same slope in *terrain*
 *    would be refused outright and no route would exist. It is charged instead, because
 *    the bay is deliberately a way in and sealing it is not this function's decision.
 *  - **It is not a balance constant.** Nothing here was chosen to make the battle come out
 *    a particular way; the numbers are the two the grid already used for sloping ground.
 */
export function roughTraverseCost(rise: number, run: number): number {
  if (!(rise > 0) || !(run > 0)) return 1;
  const gradient = Math.min(1, rise / run);
  return 1 + gradient * ROUGH_SLOPE_COST_K;
}

/** Hard cap on how far one tick may shove a man who begins inside a solid. */
const MAX_PUSH = 1.1;

export interface Resolved {
  x: number;
  z: number;
  /** True when the move was obstructed and the position is not where the caller asked. */
  hit: boolean;
  /** True when the x component was cancelled, so the caller can kill that velocity. */
  blockedX: boolean;
  blockedZ: boolean;
}

/** Neutral drag: firm level ground charges nothing. */
export const NO_DRAG = 1;

/**
 * A static set of solids with a uniform-grid broadphase.
 *
 * Rebuild (`set`) whenever the world's solids change — a gate opening, a wall breached.
 * Queries are read-only and safe to call from any system.
 */
export class ObstacleField {
  private items: Obstacle[] = [];
  private cos = new Float32Array(0);
  private sin = new Float32Array(0);
  /** Absolute Y of each box top, unpacked so the hot loop reads one flat array. */
  private topY = new Float32Array(0);
  /**
   * Standing work that is crossed, not stopped at. See `RoughBox`.
   *
   * Held as a plain list with no broadphase, deliberately. There are three of these on the
   * Aurelian circuit and none on the Punic one, so an index would cost more to build and
   * more to consult than the linear scan it replaces — and `dragAt` early-rejects on a
   * world AABB before it does any trigonometry, so the common case is three float compares.
   */
  private roughItems: RoughBox[] = [];
  private roughCos = new Float32Array(0);
  private roughSin = new Float32Array(0);
  /** Speed multiplier inside each box, precomputed from its rise. */
  private roughDrag = new Float32Array(0);
  private roughMinX = Infinity;
  private roughMaxX = -Infinity;
  private roughMinZ = Infinity;
  private roughMaxZ = -Infinity;

  private minX = 0;
  private minZ = 0;
  private nx = 0;
  private nz = 0;
  /** Counting-sort bucket offsets: bucket b owns refs[start[b] .. start[b+1]). */
  private start = new Int32Array(1);
  private refs = new Int32Array(0);

  get count(): number {
    return this.items.length;
  }

  /** True when there is nothing to collide with, so callers can skip the whole path. */
  get empty(): boolean {
    return this.items.length === 0;
  }

  /** Replace the contents. O(n) plus one pass over the cells each box touches. */
  set(list: readonly Obstacle[]): void {
    this.items = list.slice();
    const n = this.items.length;
    this.cos = new Float32Array(n);
    this.sin = new Float32Array(n);
    this.topY = new Float32Array(n);
    if (n === 0) {
      this.start = new Int32Array(1);
      this.refs = new Int32Array(0);
      return;
    }

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = this.items[i];
      const c = Math.cos(o.rot);
      const s = Math.sin(o.rot);
      this.cos[i] = c;
      this.sin[i] = s;
      this.topY[i] = o.topY;
      // World-space half-extent of a rotated box: the support function on each axis.
      const ex = Math.abs(c) * o.hw + Math.abs(s) * o.hd;
      const ez = Math.abs(s) * o.hw + Math.abs(c) * o.hd;
      if (o.x - ex < minX) minX = o.x - ex;
      if (o.x + ex > maxX) maxX = o.x + ex;
      if (o.z - ez < minZ) minZ = o.z - ez;
      if (o.z + ez > maxZ) maxZ = o.z + ez;
    }
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / BIN) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / BIN) + 1);

    const cells = this.nx * this.nz;
    const counts = new Int32Array(cells + 1);
    // Pass one: how many boxes touch each cell.
    for (let i = 0; i < n; i++) {
      const o = this.items[i];
      const ex = Math.abs(this.cos[i]) * o.hw + Math.abs(this.sin[i]) * o.hd;
      const ez = Math.abs(this.sin[i]) * o.hw + Math.abs(this.cos[i]) * o.hd;
      const x0 = this.binX(o.x - ex);
      const x1 = this.binX(o.x + ex);
      const z0 = this.binZ(o.z - ez);
      const z1 = this.binZ(o.z + ez);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) counts[cz * this.nx + cx + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.refs = new Int32Array(counts[cells]);
    // Pass two: fill, using a moving cursor per cell.
    const cursor = new Int32Array(cells);
    for (let i = 0; i < n; i++) {
      const o = this.items[i];
      const ex = Math.abs(this.cos[i]) * o.hw + Math.abs(this.sin[i]) * o.hd;
      const ez = Math.abs(this.sin[i]) * o.hw + Math.abs(this.cos[i]) * o.hd;
      const x0 = this.binX(o.x - ex);
      const x1 = this.binX(o.x + ex);
      const z0 = this.binZ(o.z - ez);
      const z1 = this.binZ(o.z + ez);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * this.nx + cx;
          this.refs[this.start[c] + cursor[c]++] = i;
        }
      }
    }
  }

  private binX(v: number): number {
    const c = Math.floor((v - this.minX) / BIN);
    return c < 0 ? 0 : c >= this.nx ? this.nx - 1 : c;
  }

  private binZ(v: number): number {
    const c = Math.floor((v - this.minZ) / BIN);
    return c < 0 ? 0 : c >= this.nz ? this.nz - 1 : c;
  }

  /**
   * Replace the standing-but-passable set. Called from the same place `set` is.
   *
   * The drag is precomputed here because it is a division and this is asked once per living
   * man per tick. It is `1 / roughTraverseCost`, so a body pays exactly what the pathfinder
   * charged for planning the same step: the two cannot drift, because there is one formula.
   */
  setRough(list: readonly RoughBox[]): void {
    this.roughItems = list.slice();
    const n = this.roughItems.length;
    this.roughCos = new Float32Array(n);
    this.roughSin = new Float32Array(n);
    this.roughDrag = new Float32Array(n);
    this.roughMinX = Infinity;
    this.roughMaxX = -Infinity;
    this.roughMinZ = Infinity;
    this.roughMaxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = this.roughItems[i];
      this.roughCos[i] = Math.cos(o.rot);
      this.roughSin[i] = Math.sin(o.rot);
      // `hd` is the half-depth across the work, which is the run a body climbs over.
      this.roughDrag[i] = 1 / roughTraverseCost(o.rise, o.hd);
      const ex = Math.abs(this.roughCos[i]) * o.hw + Math.abs(this.roughSin[i]) * o.hd;
      const ez = Math.abs(this.roughSin[i]) * o.hw + Math.abs(this.roughCos[i]) * o.hd;
      if (o.x - ex < this.roughMinX) this.roughMinX = o.x - ex;
      if (o.x + ex > this.roughMaxX) this.roughMaxX = o.x + ex;
      if (o.z - ez < this.roughMinZ) this.roughMinZ = o.z - ez;
      if (o.z + ez > this.roughMaxZ) this.roughMaxZ = o.z + ez;
    }
  }

  /** True when there is no rough ground at all, so callers can skip the whole path. */
  get noRough(): boolean {
    return this.roughItems.length === 0;
  }

  /**
   * Speed multiplier for a body standing at (x,z). 1 everywhere but on standing work.
   *
   * **Not applied to `y`.** A man scrambling over a rubble bank is modelled as slowed, not
   * as lifted: raising him to the crest would put him 2.35 m above the men beside him, and
   * `SAME_LEVEL_DY` is 1.9 — he would become unhittable for the whole crossing, which is
   * the exact opposite of what a body in the open on top of a half-built wall should be.
   * The cost is paid in time under fire, at ground level, where the garrison can reach it.
   */
  dragAt(x: number, z: number): number {
    const n = this.roughItems.length;
    if (n === 0) return NO_DRAG;
    if (x < this.roughMinX || x > this.roughMaxX || z < this.roughMinZ || z > this.roughMaxZ) {
      return NO_DRAG;
    }
    let worst = NO_DRAG;
    for (let i = 0; i < n; i++) {
      const o = this.roughItems[i];
      const dx = x - o.x;
      const dz = z - o.z;
      const u = dx * this.roughCos[i] + dz * this.roughSin[i];
      if (u < -o.hw || u > o.hw) continue;
      const v = -dx * this.roughSin[i] + dz * this.roughCos[i];
      if (v < -o.hd || v > o.hd) continue;
      if (this.roughDrag[i] < worst) worst = this.roughDrag[i];
    }
    return worst;
  }

  /**
   * Index of the solid containing (x,z) whose top is above `y`, or -1.
   *
   * `radius` inflates the box, so a man is stopped by his own body rather than by his
   * centre point reaching the masonry.
   */
  solidAt(x: number, z: number, y: number, radius = 0): number {
    if (this.items.length === 0) return -1;
    if (x < this.minX || z < this.minZ) return -1;
    const cx = Math.floor((x - this.minX) / BIN);
    const cz = Math.floor((z - this.minZ) / BIN);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return -1;
    const c = cz * this.nx + cx;
    const end = this.start[c + 1];
    for (let k = this.start[c]; k < end; k++) {
      const i = this.refs[k];
      if (this.topY[i] <= y + TOP_SLACK) continue;
      const o = this.items[i];
      const dx = x - o.x;
      const dz = z - o.z;
      const u = dx * this.cos[i] + dz * this.sin[i];
      if (u < -o.hw - radius || u > o.hw + radius) continue;
      const v = -dx * this.sin[i] + dz * this.cos[i];
      if (v < -o.hd - radius || v > o.hd + radius) continue;
      return i;
    }
    return -1;
  }

  /** Convenience predicate over `solidAt`. */
  blocked(x: number, z: number, y: number, radius = 0): boolean {
    return this.solidAt(x, z, y, radius) >= 0;
  }

  /**
   * Move from (ox,oz) toward (tx,tz), stopping at or sliding along any solid.
   *
   * Axis separation rather than a swept box: it is two extra point tests in the worst
   * case, it produces sliding for free — which is what makes a line that meets the
   * curtain flow along it toward a breach instead of piling up against one spot — and it
   * cannot tunnel at the speeds men move (a charge is 6 m/s, 0.2 m per tick, against a
   * 3.5 m wall).
   */
  resolve(ox: number, oz: number, tx: number, tz: number, y: number, radius: number, out: Resolved): void {
    out.blockedX = false;
    out.blockedZ = false;
    if (this.items.length === 0) {
      out.x = tx;
      out.z = tz;
      out.hit = false;
      return;
    }

    if (this.solidAt(tx, tz, y, radius) < 0) {
      out.x = tx;
      out.z = tz;
      out.hit = false;
      return;
    }

    // Already standing in it before the step: dig out first, then take no further step.
    const inside = this.solidAt(ox, oz, y, radius);
    if (inside >= 0) {
      this.escape(inside, ox, oz, out);
      out.hit = true;
      out.blockedX = true;
      out.blockedZ = true;
      return;
    }

    // Slide: keep whichever single axis is clear.
    if (this.solidAt(tx, oz, y, radius) < 0) {
      out.x = tx;
      out.z = oz;
      out.hit = true;
      out.blockedZ = true;
      return;
    }
    if (this.solidAt(ox, tz, y, radius) < 0) {
      out.x = ox;
      out.z = tz;
      out.hit = true;
      out.blockedX = true;
      return;
    }
    out.x = ox;
    out.z = oz;
    out.hit = true;
    out.blockedX = true;
    out.blockedZ = true;
  }

  /**
   * Shortest way out of box `i` from (x,z), capped at `MAX_PUSH` so a man who finds
   * himself deep inside a block walks out over a second rather than teleporting.
   */
  private escape(i: number, x: number, z: number, out: Resolved): void {
    const o = this.items[i];
    const c = this.cos[i];
    const s = this.sin[i];
    const dx = x - o.x;
    const dz = z - o.z;
    const u = dx * c + dz * s;
    const v = -dx * s + dz * c;
    // Distance to each of the four faces, in the box's own frame.
    const du = o.hw - Math.abs(u);
    const dv = o.hd - Math.abs(v);
    let pu = 0;
    let pv = 0;
    if (du < dv) pu = (u >= 0 ? 1 : -1) * Math.min(du + 0.05, MAX_PUSH);
    else pv = (v >= 0 ? 1 : -1) * Math.min(dv + 0.05, MAX_PUSH);
    out.x = x + pu * c - pv * s;
    out.z = z + pu * s + pv * c;
  }
}
