/**
 * City layout machinery that is not any one city's.
 *
 * Everything Rome-specific that used to live here — the survey projection, the landmark
 * placements, the aqueducts, the districts, the street network, the Aurelian circuit's line
 * and section, the Porta Flaminia's two numbers and the six build-time assertions over Rome's
 * own plan — now lives in `src/city/rome/`, as `src/city/carthage/` has always done. What is
 * left is the part a **third** city would import unchanged:
 *
 *  - **oriented-box geometry**, the reservation and overlap primitives every city plan needs.
 *    Carthage wrote a second, weaker copy of `obbOverlap` in its own `assertions.ts` rather
 *    than import this one; that duplication is the argument for keeping these here.
 *  - **`WayClass`**, the four street ranks. Each city gives them its own widths (Rome's
 *    `WAY_WIDTH`, Carthage's `PUNIC_WAY_WIDTH`); the *ranking* is shared.
 *  - **`KeepOut`**, the reservation map both fabric generators consult.
 *  - **`assertNoFabricOverlaps`**, which takes two arrays and knows nothing about which city
 *    filled them.
 *  - **`WallNode` / `wallZAt` / `BayStage`**, the wall-line vocabulary `wall.ts`,
 *    `carthageWall.ts` and `rome/circuit.ts` all speak.
 *
 * See `docs/ROME.md` §14.6 for why the split had to happen before the redesign could start.
 */

// ---------------------------------------------------------------------------
// Oriented-box geometry, used for reservation and for the overlap check
// ---------------------------------------------------------------------------

export interface Obb {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
}

/**
 * **Masonry a city plan declares as standing over its own water, and why.**
 *
 * Some structures belong in the water and no amount of moving them fixes that: the Theatre of
 * Marcellus stood on the Ripa, Rome's river-wall return runs *into* the channel so the raster
 * cannot round a cell of dry bank at the end of the Aurelian circuit, and Carthage's south
 * anchor dies in the Lake of Tunis on purpose, because a wall that ends in a lagoon is a wall
 * with no flank march round it. Each of those is authored beside the thing it describes and
 * every one of them has a source.
 *
 * **This is a declaration, not an exemption, and the difference is where it is graded.**
 * `probe-fabric` G22 reads the list as a *claim about intent* and grades it against
 * `OVER_WATER_AGREED`, which is typed into the probe with a reason per row. Three things
 * follow, and they are the reason the type exists rather than a boolean on the obstacle:
 *
 *  1. A plan that declares something the probe has not agreed to **fails**, by name. Adding a
 *     row here does not buy silence; it buys an argument with a human.
 *  2. A declaration that licenses nothing — because the masonry moved out from under it — is a
 *     STALE licence and also fails. Rule 13: a list that describes a city that is no longer
 *     here is a check gone dark.
 *  3. The licence is **bounded by an envelope**, not open. A licensed solid must still be
 *     founded on the bank: dry centre, under half its plan wet, and no deeper than the
 *     substructure is drawn. A building standing in the channel fails all three.
 *
 * The declaration **is** a rectangle in world metres — it extends `Obb` — rather than naming an
 * obstacle, because the things that need declaring are not all monuments: two of the three are
 * *curtain bays*, whose ids in every consumer are positional (`wall#33`) and change when a gate
 * opens or a ram takes a bay down. A rectangle on the ground does not.
 *
 * The external check licenses a solid only when the declaration **contains** it, every corner,
 * so a rectangle can never absolve anything bigger than itself. Two consequences worth knowing
 * before authoring one. Draw it **loosely**: a tight envelope buys nothing and goes stale the
 * first time a bay pitch moves by a metre. And prefer `rot: 0`, because `CitySystem:occRot`
 * negates plan rotation at the sim boundary — the plan's rectangle and the collision set's
 * rectangle are mirror images at any non-zero bearing, and an axis-aligned envelope is the one
 * shape that is the same in both conventions.
 */
export interface OverWaterDeclaration extends Obb {
  /** Stable name for the declaration, gated on membership by the external check. */
  id: string;
  /** Why this masonry is allowed to stand in the water. One sentence, with its source. */
  why: string;
}

/**
 * `makeRotationY(r)` sends local +X to world (cos r, −sin r) and local +Z to
 * (sin r, cos r), so these are the box's two axes in world space.
 */
export const axisU = (rot: number, out: { x: number; z: number }): void => {
  out.x = Math.cos(rot);
  out.z = -Math.sin(rot);
};
export const axisV = (rot: number, out: { x: number; z: number }): void => {
  out.x = Math.sin(rot);
  out.z = Math.cos(rot);
};

export const AX = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

/** Extent of `o` projected onto a unit axis. */
export const obbRadius = (o: Obb, ax: number, az: number): number => {
  const cs = Math.cos(o.rot);
  const sn = Math.sin(o.rot);
  return o.hw * Math.abs(cs * ax - sn * az) + o.hd * Math.abs(sn * ax + cs * az);
};

/**
 * Separating-axis test. Returns the minimum translation needed to pull `a` off `b`,
 * or null when they are already clear. `pad` inflates both boxes, so a positive value
 * asks for a street between them rather than a shared party wall.
 */
export function obbOverlap(
  a: Obb,
  b: Obb,
  pad = 0,
  /** Relative cost of separating along world Z. See `Z_AXIS_COST`. */
  zCost = 1
): { nx: number; nz: number; depth: number } | null {
  axisU(a.rot, AX[0]);
  axisV(a.rot, AX[1]);
  axisU(b.rot, AX[2]);
  axisV(b.rot, AX[3]);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let bestCost = Infinity;
  let bestDepth = 0;
  let bnx = 0;
  let bnz = 0;
  for (let i = 0; i < 4; i++) {
    const ax = AX[i].x;
    const az = AX[i].z;
    const sep = Math.abs(dx * ax + dz * az);
    const reach = obbRadius(a, ax, az) + obbRadius(b, ax, az) + pad;
    const depth = reach - sep;
    // Any axis with no overlap separates the pair; there is nothing to do.
    if (depth <= 0) return null;
    // Any separating axis is a valid translation, so pick the *cheapest* rather than the
    // shortest: sliding sideways is nearly free in this plan, pushing in depth is not.
    const cost = depth * (1 + (zCost - 1) * Math.abs(az));
    if (cost < bestCost) {
      bestCost = cost;
      bestDepth = depth;
      // Point the normal from a toward b so callers can push them apart directly.
      const s = dx * ax + dz * az >= 0 ? 1 : -1;
      bnx = ax * s;
      bnz = az * s;
    }
  }
  return { nx: bnx, nz: bnz, depth: bestDepth };
}

/** True when a disc of radius `r` at (x, z) touches the oriented box. */
export function obbHitsCircle(o: Obb, x: number, z: number, r: number): boolean {
  const dx = x - o.x;
  const dz = z - o.z;
  const cs = Math.cos(o.rot);
  const sn = Math.sin(o.rot);
  // Into the box's own frame: u along the long axis, v across it.
  const u = dx * cs - dz * sn;
  const v = dx * sn + dz * cs;
  const cu = Math.max(-o.hw, Math.min(o.hw, u));
  const cv = Math.max(-o.hd, Math.min(o.hd, v));
  const eu = u - cu;
  const ev = v - cv;
  return eu * eu + ev * ev < r * r;
}

// ---------------------------------------------------------------------------
// The street network — the rank only. Each city sets its own widths against it:
// Rome's WAY_WIDTH in rome/layout.ts, Carthage's PUNIC_WAY_WIDTH in carthage/layout.ts.
// ---------------------------------------------------------------------------

/**
 * Rank in the street network, and the width that goes with it.
 *
 * **These four numbers are gameplay numbers and they are not negotiable** — they were
 * solved by the collision workstream against what has to fit down a street: a cohort in
 * line is 35 m across, a marching column 16 m, a file 4.4 m. What *is* negotiable, and
 * what this revision changes, is **where each rank goes**.
 *
 * The previous system chose a width from the size of the rectangle being cut, so a 42 m
 * artery appeared wherever a district happened to be large. That put wide open ground
 * everywhere and a *route* nowhere: measured, 47.5 % of the city's free cells would admit
 * a cohort while only 14 % of them could actually be reached by one, because the wide
 * ground was scattered puddles rather than a connected network. It is also why the city
 * read as a quilt — every gap was the same kind of nothing.
 *
 * Rank is now a property of the *way*, not of the block beside it, and a way is a
 * continuous named line across the city. That is what a street is.
 */
export type WayClass = 'artery' | 'secondary' | 'local' | 'vicus';

// ---------------------------------------------------------------------------
// Reservation: the map both cities' fabric generators consult before they build
// ---------------------------------------------------------------------------

/** Rectangular keep-out, used for landmarks and street corridors. */
export interface KeepOutCircle {
  x: number;
  z: number;
  r: number;
}

/**
 * Collision map so procedural insulae never grow through a monument or a street.
 *
 * Landmarks reserve **oriented boxes**, not circles. That is the whole point: a circle
 * of radius 101 m nominally covered the Circus Maximus while leaving five sixths of its
 * 621 × 118 m footprint free for insulae to grow through, which is exactly what
 * happened.
 */
export class KeepOut {
  /**
   * One flat list of everything reserved: a monument's oriented box, a mound's circle, or
   * **a corridor segment as an oriented box**.
   *
   * That last one is the difference between a city and an empty field. `blockedRect` first
   * tried to reuse the disc test by standing the plot's circumradius in for the plot, which
   * for a 26 × 24 m insula is a 17.7 m disc. Against 25 km of street network that rejects a
   * band 17.7 m wider than the road on both sides of every way in Rome — 1.47 M m² of
   * exclusion against 1.7 M m² of buildable ground. The city came back with 439 buildings
   * where the BSP it replaced had 2,907, which is how a conservative approximation turns
   * into a missing city. A road is a rectangle; test it as one.
   */
  private shapes: { obb: Obb | null; circle: KeepOutCircle | null }[] = [];

  /**
   * Broad phase, and it is load-bearing rather than an optimisation.
   *
   * Every reserved shape lands in a uniform grid keyed on its axis-aligned bounds. The
   * reason is the fabric generator: filling a block that a street crosses means *trying
   * the block, then its halves, then their halves* until the mass fits beside the road
   * instead of abandoning the whole block, and that turns roughly 4,700 candidate
   * frontages into tens of thousands of rectangle queries. Linear scans over 34 monuments,
   * 14 squares and ~500 corridor segments made that tens of millions of separating-axis
   * tests; the grid tests four cells' worth of neighbours instead of the city.
   *
   * Built lazily on first query — every `add*` happens in `CitySystem.init` before the
   * generator runs — and invalidated by any later addition, so the order cannot rot.
   */
  private static readonly CELL = 48;
  private grid: Map<number, number[]> | null = null;
  /** Per-query visit stamps, so a shape spanning several cells is tested once. */
  private seen: Int32Array = new Int32Array(0);
  private stamp = 0;

  private static key(x: number, z: number): number {
    return ((Math.floor(x / KeepOut.CELL) + 4096) << 13) | (Math.floor(z / KeepOut.CELL) + 4096);
  }

  private insert(i: number, s: { obb: Obb | null; circle: KeepOutCircle | null }): void {
    let minX: number;
    let minZ: number;
    let maxX: number;
    let maxZ: number;
    if (s.obb) {
      // Half-extent of the oriented box projected onto each world axis.
      const cs = Math.abs(Math.cos(s.obb.rot));
      const sn = Math.abs(Math.sin(s.obb.rot));
      const ex = s.obb.hw * cs + s.obb.hd * sn;
      const ez = s.obb.hw * sn + s.obb.hd * cs;
      minX = s.obb.x - ex;
      maxX = s.obb.x + ex;
      minZ = s.obb.z - ez;
      maxZ = s.obb.z + ez;
    } else {
      const c = s.circle!;
      minX = c.x - c.r;
      maxX = c.x + c.r;
      minZ = c.z - c.r;
      maxZ = c.z + c.r;
    }
    const g = this.grid!;
    for (let z = minZ; z <= maxZ + KeepOut.CELL; z += KeepOut.CELL) {
      for (let x = minX; x <= maxX + KeepOut.CELL; x += KeepOut.CELL) {
        const k = KeepOut.key(x, z);
        const list = g.get(k);
        if (list) list.push(i);
        else g.set(k, [i]);
      }
    }
  }

  private ensureGrid(): void {
    if (this.grid) return;
    this.grid = new Map();
    for (let i = 0; i < this.shapes.length; i++) this.insert(i, this.shapes[i]);
    this.seen = new Int32Array(this.shapes.length);
    this.stamp = 0;
  }

  addCircle(x: number, z: number, r: number): void {
    this.grid = null;
    this.shapes.push({ obb: null, circle: { x, z, r } });
  }

  addRect(x: number, z: number, hw: number, hd: number, rot: number): void {
    this.grid = null;
    this.shapes.push({ obb: { x, z, hw, hd, rot }, circle: null });
  }

  addPath(path: { x: number; z: number }[], halfW: number): void {
    /**
     * **Round every joint, because the corner is where the corridor breaks.**
     *
     * A polyline reserved as a chain of rectangles covers the inside of each bend twice and
     * leaves a wedge of the *outside* uncovered — up to `halfW·tan(θ/2)` deep on a θ bend.
     * On a 42 m artery with a 10 m setback that wedge is a 31 m-radius bite, and a building
     * grows straight into it, so the corridor necks from 62 m to under 35 and a cohort
     * cannot turn the corner. Mapped on the nav grid, the arteries showed as wide channels
     * *interrupted at every vertex*: plenty of cohort-width ground inside the walls, almost
     * none of it connected to the military road behind the wall. A disc at each joint is the
     * standard capsule-chain fix and costs one shape per vertex.
     */
    for (let i = 1; i + 1 < path.length; i++) {
      this.grid = null;
      this.shapes.push({ obb: null, circle: { x: path[i].x, z: path[i].z, r: halfW } });
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-4) continue;
      this.grid = null;
      this.shapes.push({
        // `Obb` follows three.js: local +X maps to world (cos r, −sin r). Pointing u along
        // the segment therefore needs `atan2(−dz, dx)`, not `atan2(dz, dx)`.
        obb: {
          x: (a.x + b.x) * 0.5,
          z: (a.z + b.z) * 0.5,
          hw: len * 0.5,
          hd: halfW,
          rot: Math.atan2(-dz, dx),
        },
        circle: null,
      });
    }
  }

  /**
   * Candidate shapes whose bounds could reach a query centred at (x, z) with world-axis
   * half-extents (ex, ez). Deduplicated by stamp; the callback returns true to stop.
   */
  private near(x: number, z: number, ex: number, ez: number, hit: (i: number) => boolean): boolean {
    this.ensureGrid();
    const g = this.grid!;
    this.stamp++;
    const seen = this.seen;
    for (let cz = z - ez; cz <= z + ez + KeepOut.CELL; cz += KeepOut.CELL) {
      for (let cx = x - ex; cx <= x + ex + KeepOut.CELL; cx += KeepOut.CELL) {
        const list = g.get(KeepOut.key(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (seen[i] === this.stamp) continue;
          seen[i] = this.stamp;
          if (hit(i)) return true;
        }
      }
    }
    return false;
  }

  /**
   * True when the **oriented rectangle** at (x, z) intersects anything reserved.
   *
   * This is the test the insula generator should always have used, and its absence is
   * why the user could see monuments standing across houses. The old code approximated a
   * plot by a disc of radius `0.82 × max(hw, hd)` — for a 30 × 30 m plot that is a 12.3 m
   * circle standing in for a shape that reaches 15 m to an edge and 21 m to a corner, so a
   * plot whose *centre* cleared a monument by twelve metres could still bury nine metres of
   * its corner inside it. Long thin plots were worse: the disc is sized off the long axis
   * but centred, so it under-covers both ends.
   *
   * A rectangle against a rectangle is a four-axis separating-axis test and costs about
   * the same as the circle did.
   */
  blockedRect(x: number, z: number, hw: number, hd: number, rot: number): boolean {
    const a: Obb = { x, z, hw, hd, rot };
    const cs = Math.abs(Math.cos(rot));
    const sn = Math.abs(Math.sin(rot));
    return this.near(x, z, hw * cs + hd * sn, hw * sn + hd * cs, (i) => {
      const s = this.shapes[i];
      // Exact rectangle-versus-circle, not circumradius-versus-circle. The conservative
      // version is tempting and it is what the first draft did for both this and the
      // corridors; see `segBoxes` for what that cost.
      return s.obb ? obbOverlap(a, s.obb, 0) !== null : obbHitsCircle(a, s.circle!.x, s.circle!.z, s.circle!.r);
    });
  }

  /** True when a disc of radius `r` at (x,z) intersects anything reserved. */
  blocked(x: number, z: number, r: number): boolean {
    return this.near(x, z, r, r, (i) => {
      const s = this.shapes[i];
      if (s.obb) return obbHitsCircle(s.obb, x, z, r);
      const c = s.circle!;
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + r;
      return dx * dx + dz * dz < rr * rr;
    });
  }
}

/**
 * Build-time proof that no building stands inside a monument.
 *
 * **This is the check whose absence the user's report exposed.**
 * `assertNoFootprintOverlaps` compares *monuments with monuments* and skips anything
 * `soft`, so it has never once looked at an insula. It was reporting zero, correctly and
 * uselessly, while the fabric grew into the Circus Maximus: the two facts are about
 * different sets. A monument standing across a row of houses is a monument-versus-fabric
 * collision, and nothing in the build measured that.
 *
 * Both footprint lists come straight out of the generators and are the same rectangles
 * `getObstacles()` publishes, so this grades what the game actually collides against
 * rather than what the plan intended.
 */
export function assertNoFabricOverlaps(
  monuments: readonly { x: number; z: number; hw: number; hd: number; rot: number }[],
  buildings: readonly { x: number; z: number; hw: number; hd: number; rot: number }[]
): { ok: boolean; count: number; worst: number; buildingsHit: number } {
  let count = 0;
  let worst = 0;
  const hit = new Set<number>();
  for (const m of monuments) {
    const reach = Math.sqrt(m.hw * m.hw + m.hd * m.hd);
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      // Cheap circumradius reject first: 34 monuments against a few thousand plots is
      // 100k pairs and the full SAT on all of them is wasted work.
      const rr = reach + Math.sqrt(b.hw * b.hw + b.hd * b.hd);
      const dx = b.x - m.x;
      const dz = b.z - m.z;
      if (dx * dx + dz * dz > rr * rr) continue;
      const o = obbOverlap(m, b, 0);
      if (!o) continue;
      count++;
      hit.add(i);
      worst = Math.max(worst, o.depth);
    }
  }
  return { ok: count === 0, count, worst: +worst.toFixed(2), buildingsHit: hit.size };
}

// ---------------------------------------------------------------------------
// The wall line, as a vocabulary. Where it *runs* is each city's own business:
// rome/circuit.ts's fitWallPath, carthageWall.ts's WallLine.
// ---------------------------------------------------------------------------

export interface WallNode {
  x: number;
  z: number;
  /** Terrain height at the node. */
  ground: number;
}

/** Linear interpolation of the fitted wall line at an arbitrary x. */
export function wallZAt(path: WallNode[], x: number): number {
  if (x <= path[0].x) return path[0].z;
  const last = path[path.length - 1];
  if (x >= last.x) return last.z;
  const span = path[1].x - path[0].x;
  const i = Math.min(path.length - 2, Math.floor((x - path[0].x) / span));
  const t = (x - path[i].x) / (path[i + 1].x - path[i].x);
  return path[i].z + (path[i + 1].z - path[i].z) * t;
}

/**
 * Construction state of each tower-to-tower bay, keyed by bay index from the west
 * end. Aurelian's circuit was raised by the *collegia* of the city working many
 * stretches at once, so a snapshot in 271 shows every stage side by side.
 */
export type BayStage = 'finished' | 'no-parapet' | 'half-built' | 'footing' | 'gap';
