import type { EngineContext } from '../core/Engine';

/**
 * What an army does with a wall once it is standing on one.
 *
 * The player's complaint, verbatim: "The enemy AI when on the wall kinda hangs out. It
 * should either like start going down the stairs into the city to fight more, or target
 * other forces."
 *
 * `Siege` publishes the verbs — a unit can be sent up a stair, along the parapet, or down
 * into the streets, and a right-click already does all three. Nothing was *asking*. Worse,
 * something was asking by accident and getting it wrong: `Siege.interceptOrders` reads a
 * garrison's ordinary move order as "come down off the wall", and the tactical layer issues
 * ordinary move orders at every unit it commands. Measured on the storm of Carthage at
 * `965e12b` with both armies on the AI:
 *
 * ```
 * t+87   garrison 448 on the parapet, eight of ten wall units carrying goal=descend
 * t+250  garrison  69 on the parapet — u0 2/55, u2 1/50, u5 1/57, u8 1/47 (wall/ground)
 * ```
 *
 * The Carthaginian garrison walked off its own wall, one bay at a time, because
 * `MarchToStation` told it to dress on a station behind the curtain and the siege system
 * read that as "come down". That is the whole of "the entire wall garrison dies": it did not
 * die on the walk, it left.
 *
 * So this module does two things. It **stops** the field mover steering a unit the stonework
 * owns, and it **starts** a deliberate wall doctrine in its place. The doctrine is four
 * rules and it is written to be side-agnostic, because a defender rolling up a lodgement and
 * an attacker rolling up a garrison are the same manoeuvre:
 *
 *   1. an enemy on the parapet within `FIGHT_R` — hold and fight where you stand
 *   2. an enemy on the ground **inside** the curtain — go down the stairs at him
 *   3. an enemy on the parapet within `REACH_R` — walk the wall to him
 *   4. otherwise hold: a garrison with the enemy still outside is doing its job
 *
 * Rule 2 sits above rule 3 on purpose. Clearing the last defender off a mile of curtain is
 * about four minutes a bay and it is not what the player asked for; going down into the city
 * and fighting is.
 */

/** A descent aimed further than this is a march, not an exploitation of a lodgement. */
export const DESCEND_R = 260;
/** An enemy on the parapet this close is a melee; nobody walks anywhere. */
export const FIGHT_R = 30;
/** And one this far along the wall is worth walking to. Six bays, about four minutes. */
export const REACH_R = 150;
/** Form up this far short of the enemy rather than trickling into him off a stair. */
export const STANDOFF = 22;
/** Snap a rally point to a street if one is this close. */
const LANE_SNAP = 34;
/** Every nth lane vertex is kept. See `attach`. */
const LANE_STRIDE = 3;
/**
 * Ticks between two wall orders for one unit, whatever changes.
 *
 * The de-duplication in `OrderBook` cannot help here, and it is worth writing down why.
 * `reconcile` drops a remembered move whenever the unit's own order disagrees with it — and
 * `Siege.interceptOrders` *always* puts a wall unit back on `UnitOrder.Garrison` the instant
 * it has read the order. So the book forgets on the next tick, the behaviour re-issues, and
 * `sendToGround` builds a fresh plan with `age = 0` six ticks later, for ever: the plan
 * timeout can never fire, the stair is re-chosen from a moving centroid, and the descent
 * never completes. Two seconds is far longer than that round trip and far shorter than any
 * real order.
 */
export const ORDER_COOLDOWN = 60;

/**
 * The four questions the AI asks the siege system. `Siege` satisfies this structurally, so
 * the assignment in `TacticalAI.init` is the compile-time check that it still does — this
 * layer never imports `Siege` and never reaches past these four.
 */
export interface WallView {
  /** True while this unit's men are placed by the stonework rather than by a formation. */
  ownsUnit(unitId: number): boolean;
  /** True while the unit holds a stretch of wall — a garrison, or an attacker's lodgement. */
  isGarrisoned(unitId: number): boolean;
  /** Whether an order is already running, and where the unit's men actually are. */
  unitWallState(unitId: number): { onWall: number; onGround: number; onLink: number; goal: string };
  /** The station a click at this point means, or -1 if the point is not the parapet. */
  wallTargetAt(x: number, z: number): number;
}

/** The two published city accessors this needs. Duck-typed: a field battle has no city. */
interface CityShape {
  getWallStairs(): readonly {
    footX: number; footZ: number; topX: number; topZ: number; nx: number; nz: number;
  }[];
  getLanes(): readonly { path: { x: number; z: number }[]; width: number }[];
}

/** A flight's head and foot, and the outward normal of the curtain it is built against. */
interface Flight {
  topX: number;
  topZ: number;
  footX: number;
  footZ: number;
  nx: number;
  nz: number;
}

export class WallDoctrine {
  private flights: Flight[] = [];
  /** Lane vertices inside the walls, thinned. Empty on a map with no city. */
  private laneX = new Float32Array(0);
  private laneZ = new Float32Array(0);

  /** True once a city with stairs has been found. Everything here no-ops without one. */
  get ready(): boolean {
    return this.flights.length > 0;
  }

  /** How many flights and lane vertices are on file, for the debug overlay and the probe. */
  get flightCount(): number {
    return this.flights.length;
  }

  get laneCount(): number {
    return this.laneX.length;
  }

  /**
   * Read the city's own record of its stairs and streets, once.
   *
   * `getWallStairs` is the accessor the siege system's traversal is built on and it carries
   * exactly what is wanted and nothing else: `foot` is a point on the ground in the
   * pomerium, `top` is where the landing meets the walk, and `nx/nz` is the **outward**
   * normal of the curtain the flight stands against. Deriving an inside/outside test from
   * anything else — a city centroid, a bounding box, the sign of a cross product against a
   * segment list — needs a winding convention that nothing publishes and that a partial
   * curtain like Rome's does not have.
   *
   * The lanes are the other half of "verify the AI can path where you send it". A lane is a
   * carriageway the district generator cut and the occupancy raster was punched for, so a
   * point on one is navigable ground by construction — 374 of them and 38 km at Rome.
   * Aiming a descent at a perceived enemy's anchor aims it at whatever that man happens to
   * be standing in, which in a built quarter is as likely to be an insula as a street.
   * Thinned to every third vertex because a cohort is 30 m wide and the vertices are metres
   * apart.
   */
  attach(ctx: EngineContext): void {
    const raw = ctx.tryGet('city') as unknown as Partial<CityShape> | undefined;
    if (!raw || typeof raw.getWallStairs !== 'function') return;
    const city = raw as CityShape;
    this.flights = city.getWallStairs().map((s) => ({
      topX: s.topX, topZ: s.topZ, footX: s.footX, footZ: s.footZ, nx: s.nx, nz: s.nz,
    }));
    if (typeof city.getLanes !== 'function') return;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const lane of city.getLanes()) {
      for (let i = 0; i < lane.path.length; i += LANE_STRIDE) {
        xs.push(lane.path[i].x);
        zs.push(lane.path[i].z);
      }
    }
    this.laneX = Float32Array.from(xs);
    this.laneZ = Float32Array.from(zs);
  }

  /**
   * Is this point on the city side of the curtain?
   *
   * Answered against the nearest flight's own head and normal, so a circuit that turns —
   * Carthage's does, a great deal — is read locally rather than against one global axis.
   * With no city, or before `attach` has found one, everything reads outside. That makes
   * rule 2 unreachable and leaves the doctrine holding, which is the right failure: an AI
   * that cannot tell inside from outside must not order a descent.
   */
  inside(x: number, z: number): boolean {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.flights.length; i++) {
      const f = this.flights[i];
      const d = (f.topX - x) * (f.topX - x) + (f.topZ - z) * (f.topZ - z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return false;
    const f = this.flights[best];
    return (x - f.topX) * f.nx + (z - f.topZ) * f.nz < 0;
  }

  /**
   * A rally point in the streets, aimed at something worth fighting.
   *
   * Held short of the target by `STANDOFF` so a cohort coming off a stair forms up before it
   * arrives rather than trickling into contact a man at a time — the men come down a flight
   * in file and the last of them is a long way behind the first. Then snapped to the nearest
   * lane vertex, and finally refused outright if the result is back on the parapet, which
   * would turn `sendToGround` into `moveAlongWall` and walk the unit sideways along the very
   * wall it was told to leave.
   */
  descentPoint(
    fromX: number, fromZ: number, toX: number, toZ: number,
    wall: WallView, out: { x: number; z: number }
  ): boolean {
    const dx = toX - fromX;
    const dz = toZ - fromZ;
    const d = Math.hypot(dx, dz);
    let px = toX;
    let pz = toZ;
    if (d > STANDOFF + 1) {
      px = fromX + (dx / d) * (d - STANDOFF);
      pz = fromZ + (dz / d) * (d - STANDOFF);
    }
    let best = -1;
    let bestD = LANE_SNAP * LANE_SNAP;
    for (let i = 0; i < this.laneX.length; i++) {
      const q = (this.laneX[i] - px) * (this.laneX[i] - px) + (this.laneZ[i] - pz) * (this.laneZ[i] - pz);
      if (q < bestD) { bestD = q; best = i; }
    }
    if (best >= 0) { px = this.laneX[best]; pz = this.laneZ[best]; }
    if (!this.inside(px, pz)) return false;
    if (wall.wallTargetAt(px, pz) >= 0) return false;
    out.x = px;
    out.z = pz;
    return true;
  }
}
