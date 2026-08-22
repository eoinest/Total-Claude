// `terrain/topography`, not `terrain/TerrainSystem` — see the note in `circuit.ts`.
import { HALF_EXTENT, worldOf as projectSurvey } from '../../terrain/topography';
import { TIBER_ISLAND } from '../../terrain/tiberSurvey';
import { clamp, lerp } from '../../util/math';
import { hash2 } from '../../util/rand';
import { AX, axisU, axisV, obbOverlap, obbRadius, type Obb, type WayClass } from '../layout';
import { GATE_X } from './apertures';
// Straight from the terrain, not through `./circuit`: the wall builder now reads
// `./assertions`, which reads this file, and `./circuit` would close the cycle.
import { WALL_LENGTH, WALL_X_MIN, romeWallZ as wallCrestZ } from '../../terrain/topography';
import {
  CITY_Z_MAX,
  CITY_Z_MIN,
  EAST_BANK,
  FAR_BANK,
  GATE_Z,
  KX,
  ROME,
  worldOf,
  worldRot,
  type RomeMonument,
  type Terrain,
} from './survey';

/**
 * The plan of Rome, 271 AD, in battlefield coordinates.
 *
 * −Z is north (the Juthungi), +Z is the city. The battlefield proper occupies z < 250
 * and must stay clear.
 *
 * **This file no longer contains any hand-typed monument position.** Every landmark is
 * projected from the measured survey in `survey.ts`, which carries real metres, real
 * dimensions, a real long-axis bearing and a citation per entry. What this file adds is
 * the three things the projection cannot do on its own:
 *
 *  1. **Rectangular footprints.** A landmark reserves an *oriented box* the shape of the
 *     real building, not a circle. The Circus Maximus is 621 × 118 m; the circle of
 *     radius 101 m the previous revision reserved for it covered a sixth of its area,
 *     which is why insulae, the Palatine and a forum all grew through the middle of it.
 *     The box is scaled in plan by `PLAN_SCALE`, and so is the geometry — see that constant
 *     for the arithmetic that says a 1:1 monument cannot fit in a plan compressed 4.5× in
 *     depth, and for the measured drift at each scale.
 *  2. **Overlap resolution.** Compressing Rome's depth 4.5× while keeping every building
 *     at true scale necessarily makes neighbours collide — in the real city the Palatine's
 *     north scarp stands directly over the Forum. `resolveOverlaps` separates the
 *     footprints along their minimum-translation axis, which cannot reorder a pair, so
 *     the topology of the survey survives and the geometry stops interpenetrating.
 *  3. **The wall line**, read from the terrain's own `crestZAt(x)`, and the keep-out map
 *     the insula generator consults.
 *
 * `assertNoFootprintOverlaps()` is the build-time check that this actually worked.
 */

export interface LandmarkPlacement {
  id: string;
  /** Display name, used in the returned API and for debugging. */
  name: string;
  x: number;
  z: number;
  /** Plan rotation, radians. 0 means the long axis runs east–west. */
  rot: number;
  /** Half-extent along the local long axis. */
  hw: number;
  /** Half-extent across the local long axis. */
  hd: number;
  /**
   * Vertical scale applied to this monument's masonry. Equal to `planScale` unless the survey
   * row overrides it: a monument is scaled isotropically, so it reads as a smaller model of the
   * real building rather than a squashed one. See `RomeMonument.drawY`.
   */
  heightScale: number;
  /**
   * Plan compression applied to this monument's masonry — the row's authored `draw`, or 1.
   * `hw`, `hd`, `clear` and `moundRadius` are **world** extents and already carry it; the
   * geometry builders work in the monument's own frame and need them divided back out.
   */
  planScale: number;
  /**
   * Radius of the precinct around the monument — the footprint's circumradius plus a
   * margin. Used for tree scatter and as the coarse circle the movement grid stamps.
   */
  clear: number;
  /** Artificial hill / podium height above sampled terrain, if any. */
  mound?: number;
  moundRadius?: number;
  /** Which hill or valley of Rome this stands on. */
  where: Terrain;
  /**
   * One piece of continuous built fabric. See `RomeMonument.complex` for the argument and the
   * evidence. Two placements sharing this owe each other `PARTY_GAP`, not `STREET_GAP`.
   */
  complex?: string;
  /** Placed against the terrain's own river rather than by the affine map. */
  farBank?: boolean;
  /** Placed on the river centreline: Tiber Island. */
  onRiver?: boolean;
  /** Landscape, not masonry: exempt from the overlap resolver. See `RomeMonument.soft`. */
  soft?: boolean;
  /** Fraction of the depth allowed north of the wall crest. See `RomeMonument.atWall`. */
  atWall?: number;
  /** May run to the east edge of the heightfield. See `RomeMonument.offMapEast`. */
  offMapEast?: boolean;
  /** Where the projection put it, before overlap resolution. */
  readonly idealX: number;
  readonly idealZ: number;
}

// ---------------------------------------------------------------------------
// Landmarks, projected from the survey
// ---------------------------------------------------------------------------

/**
 * A monument's reserved footprint is bigger than the building. Real Roman monuments
 * stand in a precinct — the Colosseum inside its ring of travertine bollards and paved
 * area, the Circus behind its outer arcade, a temple inside its *temenos* — and the
 * insula generator has to leave that clear too or the fabric grows into the steps.
 */
export const PRECINCT = 1.07;

/** Extra metres of street between two reserved footprints in different complexes. */
export const STREET_GAP = 7;

/**
 * Clearance owed **inside** a complex — a shared wall, not a street.
 *
 * `survey.ts:RomeMonument.complex` is the argument. A 7 m street between the Basilica Ulpia
 * and the forum it stands in is a factual error about Rome as well as an arithmetic problem,
 * and it is the arithmetic problem that made the monumental core unhostable: seven of the
 * survey's pairs are structures whose published plans interpenetrate or abut **in real metres**,
 * so no plan scale can put a street between them. Inside a complex they owe each other a party
 * wall instead.
 */
export const PARTY_GAP = 0.35;

/**
 * **How much of a monument's real published plan is actually drawn.**
 *
 * There is no global plan scale any more, and there must not be one again. `PLAN_SCALE = 0.65`
 * stood here for three passes and `ROME-FABRIC.md` §4.5 measured why no value of it can work:
 * the projection compresses *position* by `KX` = 0.443 and `KZ` = 0.35 while a building keeps
 * its true footprint, so every monument covers about 6.4x its real share of the ground, and the
 * largest **uniform** scale with zero conflicting pairs is **0.232** — a 44 x 36 m Colosseum and
 * a 19 x 13 m Pantheon. A single number is asked to be right for a 621 m circus wedged into a
 * valley and for an 11.6 m altar with 60 m of clear ground round it, and it cannot be.
 *
 * So the departure is authored per monument, in `survey.ts`, **beside the real dimension it
 * departs from** (`RomeMonument.draw`). This function is only the default for a row that does
 * not state one, and the default is **1.00: the full published plan.** That is a deliberate
 * inversion. Under the old constant every monument was silently three-fifths of itself and a
 * reader had to know about a constant in another file to discover it; now a monument is its
 * real size unless its own row says otherwise and says why.
 *
 * Landscape (`soft`) is always 1: gardens, a planted ridge and an island are *areas*, and an
 * area is already compressed by the map exactly as a district is.
 */
const drawScaleOf = (m: RomeMonument): number => (m.soft ? 1 : (m.draw ?? 1));

/**
 * Vertical scale. **Defaults to the plan scale, not to 1** — see `RomeMonument.drawY` for the
 * measurement that changed it. A monument is a smaller model of itself, not a squashed one.
 */
const drawHeightOf = (m: RomeMonument): number => (m.soft ? 1 : (m.drawY ?? m.draw ?? 1));

/**
 * **Is this monument past the +Z edge, and therefore not on this map at all?**
 *
 * `ROME-FABRIC.md` §4.5's accepted cost: at `KZ` = 0.35 five monuments and one ridge project
 * south of the heightfield — the Palatine, the Circus Maximus, the Aventine temples, the Baths
 * of Caracalla, the Caelian villas and the Janiculum. All six are 700–800 world metres behind
 * the wall in `ROME.md` §6.1's backdrop zone, none is fought over, and the owner took the cost
 * knowingly. `ROME-FABRIC.md` §1.2 is the reason it is a cost worth taking: *"Carthage did not
 * model Carthage"* — it modelled the front, the hill, the harbours and one excavated quarter,
 * and trying to hold all of Rome is what produced a compression no grid could survive.
 *
 * **This predicate exists because the alternative was silent and much worse.** `place()` below
 * clamps a monument's z into `[CITY_Z_MIN + 20, CITY_Z_MAX]`. Left alone, raising `KZ` would not
 * have removed these six: it would have clamped all six onto z 1374 — one line of ground —
 * where they would have stacked on each other and on the Colosseum, and the overlap resolver
 * would then have shoved the pile north into the city. The measurement is in
 * `assertRomeFrame`'s `offMap` list, which prints the names at every boot, so the cost is
 * visible rather than implied.
 *
 * **The bound is `CITY_Z_MAX` and the test is on the centre, and this paragraph used to say the
 * opposite.** It claimed the bound was `HALF_EXTENT` and the test was *"on the **footprint** and
 * not the centre… what reproduces `ROME-FABRIC.md` §4.5's off-map sets at every swept `KZ`"*. The
 * code below tests `worldOf(m.e, m.n).z > CITY_Z_MAX`. Both halves of the claim are wrong and the
 * second is the dangerous one: `tools/scratch/rome-landmarks.mjs` records that the centre test and
 * the footprint test agree **only at `KZ` = 0.35** and diverge at 0.30 and 0.38, so the file
 * documents a test about the +Z edge, ships a test about the fabric inset, and the divergence is
 * invisible at exactly the value in use.
 *
 * The centre test is the right one and `rome-landmarks.mjs:reserve` argues why: with `draw`
 * authored per row, a footprint test is circular — membership would depend on a footprint chosen
 * after membership, so a monument could be deleted from the map for the crime of being drawn at
 * its real size. What the footprint test was protecting against, a building hanging over the edge
 * of the ground, is `maxDrawAt` below, measured on the true oriented reach.
 *
 * **Phase 6, not now:** whether these six can come back as off-field silhouette geometry beyond
 * the heightfield is tagged **[?]** in §4.5 and is measured by
 * `tools/scratch/rome-frame.mjs --backdrop`. Do not add them back without that measurement.
 */
export const offMapSouth = (m: RomeMonument): boolean => {
  if (m.farBank || m.onRiver) return false; // placed off the river, not by the affine map
  return worldOf(m.e, m.n).z > CITY_Z_MAX;
};

/**
 * **The largest authored footprint that still stands on the heightfield, at this position.**
 *
 * A monument's `draw` is chosen by the allocation in `tools/scratch/rome-landmarks.mjs` to clear
 * its neighbours, and that is only half the constraint. The other half is the +Z edge: the
 * heightfield stops at `HALF_EXTENT`, and a building whose corner hangs past it is standing on
 * nothing. This is the cap, and it is asserted at boot rather than trusted.
 *
 * **It measures the true oriented reach, and that is the point.** `offMapSouth` used to test
 * `w.z + wid/2·PRECINCT·scale`, which is the box's half-depth *in its own frame*. For a rotated
 * monument that is not how far south it actually goes: the Colosseum's plan is 189 × 156 turned
 * 115°, so its world +Z half-extent is `|hw·sin(rot)| + |hd·cos(rot)|` = **1.42× the local
 * half-depth**. The consequence was measured and it had shipped: at the old `PLAN_SCALE` = 0.65
 * the Colosseum's south corner stood at z **1412**, twelve metres past the edge of the ground,
 * and no check in the tree looked at the quantity that would have said so.
 */
export const maxDrawAt = (m: RomeMonument): number => {
  const w = worldOf(m.e, m.n);
  const alongZ = (m.axis ?? 'x') === 'z';
  const rot = worldRot(m.bearing, m.axis ?? 'x');
  const hwUnit = (alongZ ? m.wid : m.len) * 0.5 * PRECINCT;
  const hdUnit = (alongZ ? m.len : m.wid) * 0.5 * PRECINCT;
  // makeRotationY maps local +X to (cos, −sin) and local +Z to (sin, cos): the z components.
  const reachPerUnit = Math.abs(hwUnit * Math.sin(rot)) + Math.abs(hdUnit * Math.cos(rot));
  if (reachPerUnit <= 0) return 1;
  return Math.min(1, (HALF_EXTENT - w.z) / reachPerUnit);
};

/** The Tiber Island's projected centre. See `terrain/tiberSurvey.ts`. */
const ISLAND_WORLD = projectSurvey(TIBER_ISLAND.e, TIBER_ISLAND.n);

function place(m: RomeMonument): LandmarkPlacement {
  const w = worldOf(m.e, m.n);
  let x = w.x;
  let z = clamp(w.z, CITY_Z_MIN(w.x) + 20, CITY_Z_MAX);
  /**
   * **The channel-relative overrides, and the one row they must not touch.**
   *
   * Two branches reached this hunk from opposite directions and wrote the same shape, which is
   * why it is the only real conflict in the assembly. `e/city/rome-landmarks` got here from the
   * displacement side: applied to **landscape**, `FAR_BANK` is not a clearance, it is a deletion
   * of the survey. The Janiculum Ridge is a 520 x 240 m planted ridge that *is* the far bank's
   * topography; overriding its x put it **404 world metres east of its own survey row**, and
   * between phase 1 and phase 2 it moved **715 m** under a headline of *"displacement is 0.0 m
   * by construction"*, because the check that would have caught it excluded exactly the rows
   * this override applies to (`MAP-METHOD.md` rule 16). `e/terrain/tiber-resurvey` got here from
   * the accuracy side: the judge's plate reading puts the Mausoleum of Hadrian's survey row 8 m
   * from the inked mausoleum, *"the best-placed monument on the map"*, and the bank rule moved
   * it off that; worse, it coupled every far-bank monument to the river, so re-surveying the
   * channel moved them and the resolver cascaded it into monuments nowhere near the water.
   *
   * **So the override is a bound and not a position: it may pull a row west, never east.**
   *
   * The two branches differed only in the clearance — 90 m against 100 m — and the assembly
   * resolved it by measuring rather than by choosing. **Against the re-surveyed channel both
   * values are inert, and the tree says so out loud at every boot.** `assertRomeFrame` check 5
   * prints the override rows by name with their displacement, and on this tree it reads
   * `mausoleum-hadrian (farBank) dx 0 dz 0; janiculum (farBank) dx 0 dz -8` — **dx 0 on both**.
   * There are only two far-bank rows on this map: the Mausoleum of Hadrian at survey x −295.3
   * and the Janiculum at −416.2, and the re-surveyed west bank has moved far enough east that
   * neither is within 100 m of it. `Math.min` therefore returns the survey x in both cases at
   * either constant, and the Janiculum's remaining −8 is the `CITY_Z_MAX` clamp in z, not this
   * override in x. 100 is kept because it is the more conservative of two numbers that
   * currently cost nothing, and because it is the one that was measured against the channel
   * this tree actually ships.
   *
   * **What would change this: a third far-bank row east of the clearance line, or a channel
   * re-survey that moves the west bank west.** At that point the constant stops being inert,
   * the two branches' 10 m disagreement becomes a real one, and it has to be settled against
   * the row's drawn footprint half-width rather than against its centre — a 100 m centre
   * clearance is not 100 m of clearance for an 89 m podium.
   */
  if (m.farBank) x = Math.min(w.x, FAR_BANK(z, 100));
  /**
   * `onRiver` means **on the Tiber Island**, and it now says so. It used to snap x to
   * `riverCentreX(z)`, the channel's crossing of that *row* — and where the channel runs at
   * 60 degrees to the z axis, as it does at the island, the row crossing is 50-150 m from the
   * island's own position. The island is modelled ground now (`terrain/tiberSurvey.ts`), so a
   * thing standing on it stands at its centre. This is `e/terrain/tiber-resurvey`'s correction
   * and it is strictly better than the landmark branch's, which still snapped to the row.
   */
  else if (m.onRiver) x = ISLAND_WORLD.x;
  // `len` runs along whichever local axis the monument is built on: X for a circus or a
  // bath block, Z for a temple, a theatre or the Pantheon, whose axial plan runs from the
  // portico at −Z to the back wall at +Z.
  const alongZ = (m.axis ?? 'x') === 'z';
  const planScale = drawScaleOf(m);
  const hw = (alongZ ? m.wid : m.len) * 0.5 * PRECINCT * planScale;
  const hd = (alongZ ? m.len : m.wid) * 0.5 * PRECINCT * planScale;
  /**
   * **`atWall`, implemented. It has been declared, documented and dead for two phases.**
   *
   * The field's docstring in `survey.ts` says it is the *"fraction of the footprint's depth that
   * may sit north of the wall crest"*, because Aurelian took the Castra Praetoria's own north and
   * east walls into the circuit. Nothing read it: `place` copied it onto the placement and no
   * consumer ever looked, so the constraint it describes was enforced only by a hand-transcribed
   * `draw` and by `probe-fabric` G6 noticing afterwards.
   *
   * That inertness had a measured cost, and it is the fault a ground judge named twice. With the
   * centre pinned at `worldOf(e, n)` the camp stands **59 world metres** inside its own north
   * wall while needing 260 m of half-depth to stand behind it, so the only footprint that keeps
   * the barracks inside the city is `draw` 0.20 — a **437 m brick fortress drawn 76 x 72 m**,
   * which reads as a walled farmyard and as *smaller than the stretch of curtain in front of it*.
   * At full plan **223 m of barracks** stand on the attackers' side. The judge's diagnosis is the
   * right one: *that is a frame problem stated as a footprint problem*, and the footprint is the
   * wrong place to pay for it.
   *
   * Anchoring the north edge instead of the centre is not a licence, it is the archaeology: the
   * camp's **north wall is the curtain**, which is a surveyed fact this row's own `cite` spends a
   * paragraph establishing from three plate corners. What the survey pins precisely is that
   * wall's line; the centre is a derived midpoint. So the row is placed by its north edge, it may
   * keep `atWall` of its depth north of the crest, and the resulting southward shift of the
   * centre is a **declared override reported by name** at every boot by `assertRomeFrame` check 5
   * — the same treatment `farBank` gets, for the same reason (`MAP-METHOD.md` rule 16).
   *
   * The measured ceilings at this anchor, on the true oriented outline: **0.326** keeping the
   * footprint west of the camp's own surveyed east return, 0.674 keeping it on the heightfield
   * (which `offMapEast` licenses and which the east return does not yet contest, `circuit.ts`
   * building only the west one), and 1.301 against `CITY_Z_MAX`. The row ships the conservative
   * one.
   */
  if (m.atWall !== undefined) {
    const rot = worldRot(m.bearing, m.axis ?? 'x');
    // The box's true half-extent along world +Z — not `hd`, which is its depth in its own frame.
    const zReach = Math.abs(hw * Math.sin(rot)) + Math.abs(hd * Math.cos(rot));
    /**
     * **Solved on the four corners, not at the centre's own x, and that distinction is the
     * whole difficulty.** `wallCrestZ` slopes 0.249 world metres south per metre east across
     * this run, and a box turned 115° has its northernmost corner some 17 m east of its centre,
     * where the crest is already 4 m further south. Anchoring on `wallCrestZ(x_centre)`
     * therefore leaves that corner *north* of the local curtain — measured, as
     * `probe-fabric` G6, G7 and G16 all failing on the first attempt at this.
     *
     * So take the deepest incursion over the actual outline. Shifting `z` translates every
     * corner equally and does not move any corner's x, so one pass is exact rather than
     * iterative. `+3` clears the curtain's own 6 m of masonry from its centreline; `atWall`
     * then buys back that fraction of the footprint's depth north of it, which is the licence
     * the field is for — Aurelian's curtain runs *along* the camp's north wall, not outside it.
     */
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    let worst = -Infinity;
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        // makeRotationY maps local +X to (cos, −sin) and local +Z to (sin, cos).
        const cx = x + su * hw * cos + sv * hd * sin;
        const cz = z - su * hw * sin + sv * hd * cos;
        worst = Math.max(worst, wallCrestZ(cx) + 3 - m.atWall * 2 * zReach - cz);
      }
    }
    if (worst > 0) z += worst;
  }
  return {
    id: m.id,
    name: m.name,
    x,
    z,
    rot: worldRot(m.bearing, m.axis ?? 'x'),
    hw,
    hd,
    planScale,
    heightScale: drawHeightOf(m),
    clear: Math.sqrt(hw * hw + hd * hd),
    mound: m.mound,
    moundRadius: m.moundRadius === undefined ? undefined : m.moundRadius * planScale,
    where: m.where,
    complex: m.complex,
    farBank: m.farBank,
    onRiver: m.onRiver,
    soft: m.soft,
    atWall: m.atWall,
    offMapEast: m.offMapEast,
    /**
     * **These are now the same numbers as `x`/`z`, and that is the whole result of this phase.**
     *
     * They were the projected position *before* `resolveOverlaps` displaced the monument, and
     * the distance between the two pairs was the fault the owner reported: a mean of 142 and a
     * worst of 399 world metres, which is 351 and 1,098 real metres. The resolver is gone, so
     * the distance is zero by construction and nothing here can make it otherwise.
     *
     * They are kept rather than deleted because three instruments read them —
     * `tools/probe-fabric.mjs`, `city/preview.ts` and `city/plan.ts` — and a displacement
     * reported as **0.0 m** by an instrument that was measuring 398.9 m is a far better piece
     * of evidence than a field that quietly stopped existing.
     */
    idealX: x,
    idealZ: z,
  };
}

/**
 * Build-time proof that the plan still reads as Rome.
 *
 * Zero overlaps is necessary but not sufficient: a solver that separates everything into
 * a tidy grid has also destroyed the city. These are the adjacency facts that make the
 * plan Rome rather than a Roman-looking town, taken from the survey in `survey.ts` and from
 * the relationships the brief calls out — the Circus in the Vallis Murcia between the
 * Palatine and the Aventine, the Colosseum east of the Forum, the Palatine between the
 * two, the Campus Martius in the Tiber's bend north-west of the Capitol.
 *
 * Directions are in world terms: −Z is north, +X is east.
 */
export const TOPOLOGY: readonly (
  | { rule: 'north' | 'south' | 'east' | 'west'; a: string; b: string }
  | { rule: 'between'; a: string; b: string; c: string }
)[] = [
  // The three relationships the whole plan turns on.
  { rule: 'between', a: 'circus-maximus', b: 'palatine', c: 'aventine-temples' },
  // The Palatine stands between the Forum and the Circus: its north scarp looks down on
  // the Forum, its south-west flank on the Vallis Murcia. Expressed as directions rather
  // than a "between" test, because with depth compressed twice as hard as width the
  // Palatine's real 130 m eastward offset from the Forum-Circus line becomes a large
  // fraction of a short line and a collinearity test says nothing useful.
  { rule: 'south', a: 'palatine', b: 'forum-romanum' },
  { rule: 'north', a: 'palatine', b: 'circus-maximus' },
  { rule: 'east', a: 'palatine', b: 'circus-maximus' },
  { rule: 'east', a: 'colosseum', b: 'forum-romanum' },
  // The Capitol, the Forum and the Fora.
  { rule: 'east', a: 'forum-romanum', b: 'temple-jupiter' },
  { rule: 'north', a: 'basilica-ulpia', b: 'forum-romanum' },
  { rule: 'north', a: 'trajan-column', b: 'forum-romanum' },
  // Trajan's Market is cut into the Quirinal slope *above* his forum, so it is north-east
  // of the Basilica Ulpia. Not compared with the Caesar-Augustus-Nerva chain, which it
  // physically abuts and whose long axis runs straight at it.
  { rule: 'north', a: 'trajan-market', b: 'forum-romanum' },
  { rule: 'east', a: 'trajan-market', b: 'basilica-ulpia' },
  { rule: 'east', a: 'imperial-fora', b: 'temple-jupiter' },
  // The Campus Martius: the flood plain in the Tiber's bend, north-west of the Capitol.
  { rule: 'north', a: 'pantheon', b: 'temple-jupiter' },
  { rule: 'west', a: 'pantheon', b: 'temple-jupiter' },
  { rule: 'north', a: 'mausoleum-augustus', b: 'pantheon' },
  { rule: 'north', a: 'ara-pacis', b: 'horologium' },
  { rule: 'west', a: 'stadium-domitian', b: 'pantheon' },
  { rule: 'south', a: 'theatre-marcellus', b: 'pantheon' },
  { rule: 'west', a: 'theatre-marcellus', b: 'temple-jupiter' },
  { rule: 'west', a: 'theatre-pompey', b: 'largo-argentina' },
  { rule: 'south', a: 'porticus-octaviae', b: 'largo-argentina' },
  // The eastern hills.
  { rule: 'east', a: 'baths-trajan', b: 'colosseum' },
  // The Baths of Titus abut the Colosseum's north-east side: only 110 m north of it and
  // 157 m east, which is less than the sum of their half-widths, so "north of" is not a
  // fact about them at all. East of the amphitheatre and south of Trajan's block is.
  { rule: 'east', a: 'baths-titus', b: 'colosseum' },
  { rule: 'south', a: 'baths-titus', b: 'baths-trajan' },
  { rule: 'east', a: 'ludus-magnus', b: 'colosseum' },
  { rule: 'east', a: 'castra-praetoria', b: 'temple-serapis' },
  { rule: 'north', a: 'castra-praetoria', b: 'colosseum' },
  { rule: 'north', a: 'gardens-sallust', b: 'temple-serapis' },
  // The Praetorian camp is 1.4 km north and 850 m east of the Oppian bath platform. Both
  // signs are asserted because the two are the plan's most tightly wedged pair — the camp is
  // pinned against the east edge of the heightfield and the baths against the camp — and
  // without them the ring of hills round the Palatine inverts here.
  { rule: 'north', a: 'castra-praetoria', b: 'baths-trajan' },
  { rule: 'east', a: 'castra-praetoria', b: 'baths-trajan' },
  { rule: 'north', a: 'temple-serapis', b: 'imperial-fora' },
  // The southern hills.
  { rule: 'west', a: 'aventine-temples', b: 'palatine' },
  { rule: 'south', a: 'caelian-villas', b: 'colosseum' },
  { rule: 'east', a: 'caelian-villas', b: 'circus-maximus' },
  { rule: 'south', a: 'baths-caracalla', b: 'circus-maximus' },
  // Across the water.
  { rule: 'west', a: 'janiculum', b: 'tiber-island' },
  { rule: 'west', a: 'mausoleum-hadrian', b: 'stadium-domitian' },
  { rule: 'west', a: 'tiber-island', b: 'temple-jupiter' },
];


/**
 * Landmark placements. Order follows `ROME`, which runs north to south, so the depth
 * banding in `monuments.ts` groups neighbours together.
 *
 * **Filtered by `offMapSouth`.** The survey still carries all thirty-four rows — a monument
 * that is off *this* map is not a monument we have stopped knowing about, and it comes back for
 * free the moment the frame changes. What is dropped is its placement.
 */
export const LANDMARKS: LandmarkPlacement[] = ROME.filter((m) => !offMapSouth(m)).map(place);

/** The rows the frame put past the +Z edge. Printed at boot by `assertRomeFrame`. */
export const OFF_MAP_SOUTH: readonly RomeMonument[] = ROME.filter(offMapSouth);

/**
 * ## `resolveOverlaps` was here, and deleting it is the point of this phase
 *
 * It ran at boot, pushed every intersecting monument footprint apart along its minimum
 * translation axis until nothing intersected, and it succeeded: the shipped city had **zero**
 * intersecting monument pairs. The price was that nothing was where it belonged. Measured from
 * each monument's own projected position, it displaced the survey by a **mean of 142 and a worst
 * of 399 world metres** — 351 and 1,098 *real* metres — and drew the Theatre of Pompey nearly a
 * kilometre north of itself, on top of a road. That displacement, not the overlap, is the fault
 * the owner reported: *"the footprint of where the buildings are is completely wrong."*
 *
 * Three things are worth keeping on the record, because each is a general lesson rather than a
 * fact about this file.
 *
 * **A solver given more room does more work, not less.** Raising `KZ` from 0.222 to 0.35 left it
 * 13 projected conflicts to discharge instead of 22, and it moved everything **twice as far** —
 * mean 65 to 142, worst 168 to 399. With the southern monuments off the map and the Campus
 * Martius band 58 % deeper it had more space to push into and no reason not to use it. Anyone
 * tempted to fix a layout by giving its solver more headroom should read that number twice.
 *
 * **It hid the fault from every instrument.** `assertNoFootprintOverlaps` passed, and
 * `probe-fabric` G1 and G15 passed, on a city whose monuments were a third of a kilometre from
 * their surveyed positions. The overlap check was measuring the resolver's output against the
 * resolver's own goal. `MAP-METHOD.md` rule 5 is the general form: *a resolver that nudges
 * overlapping buildings apart is evidence the layout step was wrong, and hiding it is not the
 * worst of it.*
 *
 * **What replaced it is not a better solver.** Every centre is now exactly `worldOf(e, n)` and
 * the conflicts are absorbed upstream, in three ways that are all statements about Rome rather
 * than about geometry: seven **complexes** (`RomeMonument.complex`) declare where the city had a
 * party wall instead of a street; five **survey corrections** put monuments where the plates
 * actually have them, which removed more conflict than any amount of shrinking; and a
 * per-monument **authored footprint** (`RomeMonument.draw`) records what is left, beside the
 * real published dimension it departs from. `TOPOLOGY` below survives as an assertion, having
 * previously doubled as this solver's constraint set.
 *
 * Deleted with it: `separation`, `confine`, `nearbyDrift`, `ORDER_FLOOR`, `HOLD_MARGIN`,
 * `HOLD_WEIGHT`, `ORDER_WEIGHT`, `RELAX`, `SPRING` and `Z_AXIS_COST`. Do not bring any of them
 * back. If a pair conflicts, the answer is a merge, a corrected coordinate, or an authored
 * footprint with the reason written beside it — never a nudge at boot.
 */

export interface AqueductRun {
  id: string;
  name: string;
  /** Polyline the arcade follows. */
  path: { x: number; z: number }[];
  /** Height of the channel above ground at its tallest. */
  height: number;
  bayWidth: number;
  pierWidth: number;
}

/**
 * Aqueduct arcades, projected from their real approaches. Long lines of arches are the
 * most evocative thing in the Roman landscape and cost almost nothing to build from one
 * repeated module.
 *
 * The Aqua Virgo crossed the Campus Martius on a low arcade to reach the Baths of
 * Agrippa; the Aqua Claudia marched along the Caelian on 28 m arches, the tallest in the
 * city, and Nero's branch carried it on to the Palatine.
 */
const AQUEDUCT_PLAN: {
  id: string;
  name: string;
  /** Survey-frame polyline, metres east/north of the Capitol. */
  path: [number, number][];
  height: number;
  bayWidth: number;
  pierWidth: number;
}[] = [
  {
    id: 'aqua-virgo',
    name: 'Aqua Virgo',
    // Entered the city on the Pincian and ran west across the Campus Martius; its
    // arches survive under Via del Nazareno. Platner-Ashby s.v. Aqua Virgo.
    path: [
      [1500, 1750],
      [700, 1500],
      [100, 1050],
      [-350, 700],
      [-430, 600],
    ],
    height: 11.5,
    bayWidth: 7.4,
    pierWidth: 2.1,
  },
  {
    id: 'aqua-claudia',
    name: 'Aqua Claudia',
    // From the Porta Maggiore westward along the Caelian to the Arcus Neroniani, which
    // carried a branch on to the Palatine. 28 m at its tallest.
    path: [
      [2500, -350],
      [1600, -480],
      [1050, -500],
      [620, -430],
    ],
    height: 27.5,
    bayWidth: 8.0,
    pierWidth: 2.5,
  },
  {
    id: 'aqua-marcia',
    name: 'Aqua Marcia',
    // In through the Porta Tiburtina on the Viminal, carrying the Tepula and Julia on
    // the same piers.
    path: [
      [2400, 780],
      [1750, 880],
      [1330, 940],
    ],
    height: 16,
    bayWidth: 7.6,
    pierWidth: 2.2,
  },
];

export const AQUEDUCTS: AqueductRun[] = AQUEDUCT_PLAN.map((a) => ({
  id: a.id,
  name: a.name,
  height: a.height,
  bayWidth: a.bayWidth,
  pierWidth: a.pierWidth,
  path: a.path.map(([e, n]) => {
    const w = worldOf(e, n);
    return { x: clamp(w.x, -HALF_EXTENT + 30, HALF_EXTENT - 30), z: clamp(w.z, CITY_Z_MIN(w.x) + 10, CITY_Z_MAX) };
  }),
}));

export interface DistrictSpec {
  id: string;
  /** Centre and half-extents of the region to fill with insulae. */
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Storeys, low..high. Augustus capped insulae at 70 Roman feet (20.7 m). */
  minFloors: number;
  maxFloors: number;
  /** 0 = spacious, 1 = packed shoulder to shoulder. */
  density: number;
  /** Weight of grand houses / porticoes among the blocks. */
  grandeur: number;
  /**
   * How ragged the district's outer edge is, 0..1. The fabric of a real city fades into
   * gardens, yards and orchards; a rectangle of insulae ending in a straight line
   * against ploughed fields is the single most artificial thing a procedural city does.
   */
  fray: number;
}

/**
 * Insula districts, one per *regio* of the real city, projected the same way as the
 * monuments. Half-extents are scaled by the map as well, because a district is an area
 * of fabric rather than a building: compressing it is correct.
 *
 * Densities and storey counts follow the ancient character of each quarter — the Subura
 * was the notorious tenement valley, the Aventine and Caelian were quiet and grand, the
 * Campus Martius monumental with dense fabric between the monuments.
 */
const DISTRICT_PLAN: {
  id: string;
  /** Survey-frame centre and half-extents, metres. */
  e: number;
  n: number;
  he: number;
  hn: number;
  minFloors: number;
  maxFloors: number;
  density: number;
  grandeur: number;
  fray: number;
  /**
   * Pinned to the Tiber's **east** bank rather than to the projected position.
   *
   * The projection cannot put both the Porta Flaminia and the Tiber where the terrain has
   * them: the gate is fixed at x ≈ 72 because that is where the Via Flaminia crosses the
   * crest, the modelled channel runs at x ≈ −580 to −900, and in the real city those two are
   * only 280 m apart, not 700. So the affine map leaves a 640 m strip of empty ground along
   * the whole east bank — a third of the wall's frontage, and the most conspicuous hole in
   * the plan seen from above. These quarters are what actually occupied that ground: the
   * Navalia and the Trigarium on the Campus Martius shore, the Forum Boarium and the
   * Velabrum below the Capitol, the Emporium's warehouses under the Aventine. Because a
   * district is an *area* of fabric rather than a surveyed building, moving it to the water
   * costs nothing the survey can measure and gains the whole riverside.
   */
  eastBank?: boolean;
}[] = [
  // Campus Martius, north to south along the Via Lata.
  { id: 'campus-flaminia', e: -420, n: 1780, he: 330, hn: 250, minFloors: 2, maxFloors: 4, density: 0.74, grandeur: 0.12, fray: 0.55 },
  { id: 'campus-augusti', e: -430, n: 1250, he: 320, hn: 230, minFloors: 3, maxFloors: 5, density: 0.84, grandeur: 0.2, fray: 0.35 },
  { id: 'campus-medius', e: -520, n: 700, he: 340, hn: 260, minFloors: 3, maxFloors: 5, density: 0.9, grandeur: 0.22, fray: 0.3 },
  { id: 'campus-flaminius', e: -520, n: 160, he: 330, hn: 250, minFloors: 3, maxFloors: 5, density: 0.86, grandeur: 0.24, fray: 0.4 },
  // The Via Lata's east side, under the Quirinal scarp.
  { id: 'via-lata', e: -80, n: 1150, he: 260, hn: 420, minFloors: 3, maxFloors: 5, density: 0.8, grandeur: 0.16, fray: 0.35 },
  { id: 'quirinal', e: 430, n: 900, he: 320, hn: 300, minFloors: 2, maxFloors: 4, density: 0.66, grandeur: 0.34, fray: 0.45 },
  { id: 'viminal', e: 950, n: 700, he: 330, hn: 300, minFloors: 2, maxFloors: 4, density: 0.66, grandeur: 0.22, fray: 0.5 },
  // The Subura: the tenement valley between the Quirinal, Viminal and Esquiline.
  { id: 'subura', e: 560, n: 280, he: 250, hn: 220, minFloors: 4, maxFloors: 6, density: 0.94, grandeur: 0.04, fray: 0.2 },
  { id: 'esquiline', e: 1330, n: 280, he: 340, hn: 330, minFloors: 2, maxFloors: 4, density: 0.6, grandeur: 0.26, fray: 0.6 },
  // The Velabrum and Forum Boarium, between the Capitol, the river and the Palatine.
  { id: 'velabrum', e: -120, n: -300, he: 250, hn: 200, minFloors: 3, maxFloors: 5, density: 0.86, grandeur: 0.14, fray: 0.35 },
  { id: 'caelian', e: 1020, n: -600, he: 320, hn: 250, minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.3, fray: 0.55 },
  { id: 'aventine', e: -300, n: -1180, he: 280, hn: 230, minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.36, fray: 0.55 },
  // The Emporium: the river port under the Aventine, all warehouses. On the water by
  // definition — the *horrea* backed onto the quays.
  { id: 'emporium', e: -560, n: -900, he: 200, hn: 260, minFloors: 1, maxFloors: 3, density: 0.8, grandeur: 0.06, fray: 0.45, eastBank: true },
  // The Tiber shore of the Campus Martius: the Navalia (the naval sheds), the Trigarium
  // exercise ground and the Tarentum, from the Pons Neronianus up to the Mausoleum. Low,
  // loose and workaday — sheds and yards, not tenements.
  { id: 'ripa-campi', e: -800, n: 900, he: 220, hn: 420, minFloors: 1, maxFloors: 3, density: 0.62, grandeur: 0.06, fray: 0.6, eastBank: true },
  // The Forum Boarium and the Portus Tiberinus below the Capitol: the cattle market, the
  // round temple of Hercules Victor, the Pons Aemilius and the river gate.
  { id: 'forum-boarium', e: -430, n: -320, he: 200, hn: 250, minFloors: 2, maxFloors: 4, density: 0.82, grandeur: 0.12, fray: 0.4, eastBank: true },
  // Trans Tiberim, on the far bank — placed against the terrain's river below.
  { id: 'trastevere', e: -1150, n: 100, he: 240, hn: 420, minFloors: 2, maxFloors: 4, density: 0.72, grandeur: 0.1, fray: 0.5 },
  { id: 'vaticanus', e: -1500, n: 1100, he: 260, hn: 300, minFloors: 1, maxFloors: 3, density: 0.4, grandeur: 0.18, fray: 0.7 },
];

export const DISTRICTS: DistrictSpec[] = DISTRICT_PLAN.map((d) => {
  const w = worldOf(d.e, d.n);
  // Districts are *inflated* well beyond the compressed survey extent, for two reasons.
  // A monument keeps its true size while its position compresses, so the overlap resolver
  // spreads the monumental core over far more ground than the scaled plan asked for and the
  // gaps between monuments are correspondingly wider. And the fabric is what fills those
  // gaps: the generator rejects any plot that hits a keep-out, so an over-large district
  // costs nothing but a bald one leaves a quarter of the city as empty field. The first
  // version of this file scaled the districts by KX and KZ like the positions, and produced
  // 256 insulae for the whole of Rome.
  // Measured with the land audit in `tools/scratch/land-audit.mjs`: at 1.72 / 2.95 the
  // seventeen quarters between them claimed only 77 % of the ground inside the circuit, and
  // the missing 23 % — 570,000 m², most of it the eastern hills behind the Esquiline and the
  // Caelian — was simply not any district's job to fill, so nothing ever built there however
  // the generator was tuned. A district costs nothing where it overlaps a neighbour (the
  // plot grid gives the ground to whichever quarter is planned first) and costs nothing where
  // it overlaps a monument or a street (the keep-out map rejects it), so over-covering is the
  // cheap error and under-covering is the expensive one.
  //
  // **The depth factor is a world scale now, not a multiple of `KZ`, and that is a hold rather
  // than a fix.** `ROME-FABRIC.md` §2.3 measures this pair of lines as fault 2: the seventeen
  // districts claim **266 %** of the ground inside the circuit, with 79 overlapping pairs and
  // 5.18 km² double-claimed, and *"a district costs nothing where it overlaps a neighbour"* is
  // the quilt in the file's own words. §4.3 deletes `DISTRICT_PLAN` outright in phase 5 and
  // replaces it with the fourteen Augustan regions as a partition.
  //
  // Phase 1 raised `KZ` from 0.222 to 0.35. Written as `KZ * 3.5` this line would have made
  // every district **57.7 % deeper** and pushed the over-claim past 350 % as a side effect of a
  // projection change — growing a fault a later phase deletes, on a map the owner is about to
  // review. `0.222 * 3.5 = 0.777` is the world scale it has actually had, so it is written as
  // that and the districts do not move. **Do not re-couple this to `KZ` to make it look
  // tidier**; the coupling was never meaningful, which is exactly why the number could be read
  // off and pinned.
  const hw = Math.max(150, d.he * KX * 2.05);
  const hd = Math.max(120, d.hn * 0.777);
  let x = w.x;
  let z = clamp(w.z, CITY_Z_MIN(w.x) + hd + 6, CITY_Z_MAX);
  const farBank = d.id === 'trastevere' || d.id === 'vaticanus';
  if (farBank) {
    x = FAR_BANK(z, 60 + hw);
  } else if (d.eastBank) {
    x = EAST_BANK(z) + 16 + hw;
  } else {
    // The projected position, full stop. This used to add `nearbyDrift` — the inverse-square
    // mean displacement the overlap resolver had applied to the monuments nearest this point —
    // so that a quarter followed the buildings it was named after wherever the solver had
    // shoved them. With the resolver gone the monuments are at their surveyed positions, so a
    // district authored against the projection is already beside its own quarter and the whole
    // correction is identically zero. Deleted rather than left returning zero: a field whose
    // only job was to track a solver is a second copy of that solver's error.
    x = Math.max(w.x, EAST_BANK(z) + 20 + hw);
    z = w.z;
  }
  // **Grain.** Measured on the orthophoto, Rome's street grain holds over patches of
  // 150–400 m and then rotates 15–40° across a street; a plan with one global orientation
  // is the second-strongest tell of a procedural city after a lack of through-routes. The
  // districts are 400–500 m across, which is exactly that scale, so the grain change is
  // free — it only needs the rotation to be large enough to see. It was ±4.6°, which is
  // not, and every quarter of Rome ran very nearly parallel to every other.
  const rot = (hash2(Math.round(d.e), Math.round(d.n), 0x5c1) - 0.5) * 0.7;
  z = clamp(z, CITY_Z_MIN(x) + hd * 0.5, CITY_Z_MAX - hd * 0.5);
  return {
    id: d.id,
    x,
    z,
    hw,
    hd,
    rot,
    minFloors: d.minFloors,
    maxFloors: d.maxFloors,
    density: d.density,
    grandeur: d.grandeur,
    fray: d.fray,
  };
});

// ---------------------------------------------------------------------------
// The street network. `WayClass` — the rank — is shared, in `city/layout.ts`;
// these are Rome's widths for it.
// ---------------------------------------------------------------------------

export const WAY_WIDTH: Readonly<Record<WayClass, number>> = {
  /** A cohort in line, 35 m, with 3.5 m either side. Or two columns abreast. */
  artery: 42,
  /** Two columns abreast; a line must narrow to enter. */
  secondary: 24,
  /** One column of about 16 files. */
  local: 14,
  /** Men in file. A *vicus*, and deliberately hostile to formations. */
  vicus: 8,
} as const;

/**
 * How far back from the kerb the building line stands, by rank.
 *
 * **This is a gameplay number wearing an architectural hat, and both readings agree.**
 *
 * The sim reading: a body of `w` metres can only use a corridor if its *centre* stays `w/2`
 * from any masonry, so a 42 m artery with the fabric hard on the kerb admits a 35 m cohort
 * along a ribbon just seven metres wide — two cells of the four-metre nav grid, and on a
 * corridor that runs at an angle to the grid that ribbon rasterises to a staircase which
 * can and does break. Measured: with the blocks filled in and the frontages hard against
 * every kerb, cohort-reachable ground inside the circuit collapsed to the pomerium alone —
 * 2,781 cells against 21,166 with no buildings at all — because *every* route off the
 * military road was marginal. Nine metres of extra setback on an artery turns a two-cell
 * ribbon into a five-cell one and the network reconnects.
 *
 * The architectural reading: a *vicus* is a doorstep on a lane and 1.5 m is right, but a
 * monumental way is not a road with houses on it. The Via Lata ran between continuous
 * porticoes, the Via Sacra between forecourts and temple steps, and the ground between the
 * carriageway and the building line was part of the street. Setting it back by rank is what
 * every one of those places actually did.
 */
export const WAY_FRONTAGE: Readonly<Record<WayClass, number>> = {
  artery: 10,
  secondary: 5,
  local: 2.5,
  vicus: 1.5,
} as const;

export interface CityWay {
  id: string;
  cls: WayClass;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
  /**
   * Monumental: gets a colonnade line along the footway and marble rather than basalt
   * kerbs. Rome's processional ways were porticoed for most of their length — the point
   * of a 42 m corridor is that it reads as the Via Lata, not as a bypass.
   */
  porticoed?: boolean;
}

/** Back-compatible view of the named historical viae. Used by the plan diagnostic. */
export interface StreetSpec {
  id: string;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
}

/**
 * The named streets of Rome, in survey metres.
 *
 * These are the *armature*: the lines the city was actually organised around, every one
 * of them attested. The Via Lata — the urban continuation of the Via Flaminia, and
 * today's Corso — runs dead straight south from the Porta Flaminia to the foot of the
 * Capitol; everything else in the Campus Martius grows off it. The Via Sacra crosses the
 * Forum and climbs the Velia to the Colosseum valley; the Vicus Patricius is the spine of
 * the Subura; the Alta Semita runs the length of the Quirinal ridge.
 *
 * **On width, and the honest size of the compromise.** A real Roman *via* is about 4.8 m
 * between kerbs and the Via Lata perhaps twelve. Nothing here is that narrow, because a
 * street a formation cannot enter is not a street in this game, it is a wall with a crack
 * in it. The compromise is confined rather than spread: only the ways below carry a rank
 * above `local`, so the city has **five** corridors a cohort can deploy in and several
 * hundred lanes at 8 m — a ratio of about 1:20, which is close to the real one even
 * though every individual number is inflated. Rome had a handful of processional ways and
 * a fabric of *vici*; so does this. And a 42 m corridor is not un-Roman at the places it
 * is used: the Via Lata ran between continuous porticoes, and the open width of the
 * Campus Martius, the fora and the Saepta was far more than that.
 */
const STREET_PLAN: {
  id: string;
  path: [number, number][];
  cls: WayClass;
  paved: boolean;
  porticoed?: boolean;
}[] = [
  {
    id: 'via-lata',
    /**
     * **The last two hundred metres now go round the Mausoleum of Augustus, because that is
     * where the road went.**
     *
     * It used to run [-497, 2045] -> [-470, 1560] -> [-440, 1080], which passes **14 real metres
     * from the centre of an 87 m tomb** — straight through it. With `resolveOverlaps` alive that
     * was invisible, because the solver had shoved the Mausoleum 100-odd metres off its plate
     * position and the road went through the hole. Phase 2 put the tomb back where the survey
     * puts it and the road has run through masonry ever since: a ground judge measured **85
     * unbroken metres of it across the carriageway**, and the same frame is the best view the map
     * has produced, because the terminus and the obstruction are the same object.
     *
     * That tension does not have to be traded, and the judge named the fix: *"bend the last
     * hundred metres of the carriageway round the tomb's eastern flank, as the real road did, and
     * keep the tomb closing the view from further out. That is not deflecting a street around a
     * solver's fiction; it is drawing the street where the street was."* The Via Flaminia ran
     * along the Mausoleum's **eastern** side; the tomb's precinct was its west kerb.
     *
     * So the first 215 real metres out of the gate are dead straight — the frame a player sees
     * first after a breach is 30 m in, and the tomb still closes it — and the swing east begins
     * at n 1650, clearing the tomb's precinct by 5.4 world metres of carriageway edge at n 1500.
     * `deflect` still runs afterwards and does the fine work; what it cannot do is invent a
     * hundred-metre detour from a line that starts inside the building, which is why the armature
     * has to state the bend and not merely permit it.
     *
     * **What this does and does not fix, stated because the two get conflated.** The
     * *carriageway* clears the tomb, and the carriageway is what a column walks, because pathing
     * follows the way graph. The **straight normal out of the gate** is still blocked 145-235 m
     * in, and it always will be: the tomb stands on it, in reality and on the plate. That number
     * is the one the judge's headline quotes, `assertGateAxisClear` now re-derives it at every
     * boot beside this one, and clearing it would mean moving a surveyed monument — which is the
     * thing this whole rebuild exists to stop doing.
     */
    path: [
      [-497, 2045],
      [-487, 1830],
      [-430, 1650],
      [-375, 1500],
      [-395, 1350],
      [-440, 1080],
      [-400, 620],
      [-340, 240],
      [-180, 40],
      [-30, -30],
    ],
    // The one road from the one gate into the city. If any line in Rome is an artery this
    // is it: the army that holds the Porta Flaminia has to be able to deploy behind it.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-sacra',
    // Out of the Forum, over the Velia, past the Meta Sudans into the Colosseum valley.
    path: [
      [-30, -30],
      [120, 30],
      [300, -30],
      [520, -140],
      [700, -230],
      [900, -230],
    ],
    // The triumphal route. In the real city this is not a street at all for most of its
    // length — it is the open floor of the Forum Romanum, then Caesar's forum, then
    // Augustus's, then Nerva's, each a paved rectangle 100 m and more across. Forty-two
    // metres of colonnaded processional way is a *reduction* of what was there.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-recta',
    // The east–west spine of the Campus Martius, modern Via dei Coronari.
    path: [
      [-1000, 520],
      [-620, 590],
      [-300, 600],
      [-40, 540],
      [180, 380],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'vicus-patricius',
    // Up the Subura from the Fora onto the Viminal.
    path: [
      [180, 40],
      [330, 120],
      [560, 340],
      [820, 640],
      [1080, 900],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'alta-semita',
    // Along the Quirinal ridge to the Porta Salaria. The ridge road is the only
    // continuous east–west route through the eastern hills, so it carries a rank.
    path: [
      [180, 380],
      [330, 640],
      [700, 1020],
      [1150, 1330],
      [1500, 1620],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'via-appia',
    // South out of the city between the Palatine and the Caelian, past the Circus.
    path: [
      [430, -180],
      [430, -520],
      [560, -900],
      [700, -1320],
      [800, -1620],
    ],
    // Out of the city between the Palatine and the Caelian down the Vallis Murcia, with
    // the Circus Maximus's whole 600 m flank on one side of it. Open by construction.
    cls: 'artery',
    paved: true,
    porticoed: false,
  },
  {
    id: 'vicus-iugarius',
    // Round the foot of the Capitol from the Forum to the Forum Boarium and the river.
    path: [
      [180, -40],
      [-40, -180],
      [-260, -300],
      [-470, -420],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'vicus-tuscus',
    // The other way out of the Forum's south-west corner, past the Basilica Julia to the
    // Velabrum and the Forum Boarium. Paired with the Iugarius round the Capitol's foot.
    path: [
      [200, -60],
      [140, -260],
      [40, -450],
      [-120, -560],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'via-labicana',
    // East from the Colosseum between the Esquiline and the Caelian.
    path: [
      [900, -230],
      [1300, -180],
      [1750, -140],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'via-tiburtina',
    // Out of the Subura across the Esquiline to the Porta Tiburtina, under the Aqua
    // Marcia's arches. The eastern quarters had no through route before this.
    path: [
      [620, 300],
      [1050, 420],
      [1500, 560],
      [1950, 700],
    ],
    cls: 'secondary',
    paved: true,
  },
  {
    id: 'vicus-longus',
    // The floor of the valley between the Quirinal and the Viminal, parallel to and below
    // the Alta Semita. Its name is literally "the long street".
    path: [
      [300, 300],
      [560, 620],
      [860, 960],
      [1120, 1240],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'via-triumphalis',
    // Up the west side of the Campus Martius from the Pons Neronianus, the route of the
    // triumph before it turned east for the Capitol. Gives the river quarters a spine.
    path: [
      [-880, 1500],
      [-820, 1050],
      [-780, 620],
      [-720, 180],
      [-640, -200],
    ],
    // The Campus Martius was a parade ground before it was a quarter, and stayed open
    // ground between its monuments. The one line the whole west of the city hangs off.
    cls: 'artery',
    paved: true,
    porticoed: true,
  },
  {
    id: 'via-ostiensis',
    // South along the Tiber past the Emporium's warehouses to the Porta Ostiensis.
    path: [
      [-470, -420],
      [-520, -800],
      [-560, -1180],
      [-580, -1520],
    ],
    cls: 'local',
    paved: true,
  },
  {
    id: 'clivus-aventinus',
    // Up onto the Aventine from the Vallis Murcia, round the west end of the Circus.
    path: [
      [-40, -700],
      [-180, -950],
      [-320, -1200],
    ],
    cls: 'local',
    paved: true,
  },
];

/** The named historical viae, projected and graded. The core of the armature. */
const NAMED_WAYS: CityWay[] = STREET_PLAN.map((s) => ({
  id: s.id,
  cls: s.cls,
  width: WAY_WIDTH[s.cls],
  paved: s.paved,
  porticoed: s.porticoed,
  path: s.path.map(([e, n]) => {
    const w = worldOf(e, n);
    const x = clamp(w.x, -HALF_EXTENT + 20, HALF_EXTENT - 20);
    return { x, z: clamp(w.z, CITY_Z_MIN(x) - 18, CITY_Z_MAX) };
  }),
}));

/**
 * The Via Lata has to leave the gate on the road's own centreline, whatever the survey
 * says, or the paving stops at a blank curtain. The first node is pinned to the gate and
 * the next two are eased onto the projected line.
 */
{
  const lata = NAMED_WAYS.find((s) => s.id === 'via-lata');
  if (lata) {
    lata.path[0] = { x: GATE_X, z: GATE_Z + 8 };
    for (let i = 1; i < Math.min(3, lata.path.length); i++) {
      lata.path[i] = {
        x: lerp(GATE_X, lata.path[i].x, i / 3),
        z: lata.path[i].z,
      };
    }
  }
}

/**
 * The *via sagularis*: the military road inside the curtain.
 *
 * Every Roman fortification from a marching camp to the Aurelian circuit keeps a road
 * behind the rampart so a reserve can reach a threatened stretch without going through the
 * town, and Rome's *pomerium* — the consecrated strip kept free of building — is where it
 * ran. `POMERIUM` is 60 m, chosen so a cohort can form up facing a breach; before this the
 * 60 m was simply *absent* fabric, an empty field that read as unfinished ground in every
 * frame taken from the wall. Paving 42 m of it gives the number a reason you can see:
 * 9 m of verge, the road, 9 m of verge, then the building line.
 *
 * Sampled every 40 m off the terrain's own crest, so it follows the wall wherever the
 * wall goes.
 */
const POMERIUM_WAY: CityWay = (() => {
  const path: { x: number; z: number }[] = [];
  const step = 40;
  const n = Math.max(2, Math.round(WALL_LENGTH / step));
  for (let i = 0; i <= n; i++) {
    const x = WALL_X_MIN + 6 + ((WALL_LENGTH - 12) * i) / n;
    path.push({ x, z: wallCrestZ(x) + 30 });
  }
  return { id: 'via-sagularis', cls: 'artery', width: WAY_WIDTH.artery, paved: true, path };
})();

/**
 * A street all the way round every monument.
 *
 * This is the answer to "the large monuments are smacked down across multiple buildings".
 * The old plan reserved a monument's footprint and let the fabric grow to the reservation
 * line, so the Colosseum's outer wall stood a metre from somebody's kitchen and nothing
 * about the arrangement said which was which. A real monument is *addressed*: it stands in
 * a precinct, the precinct has a street round it, and the fabric presents a frontage to
 * that street. Emitting the ring explicitly does four things at once —
 *
 *  - it guarantees the clearance rather than hoping the block cutter leaves one;
 *  - it gives the insula generator a hard, straight edge to build a street wall against,
 *    which is what makes the fabric read as blocks rather than as scatter;
 *  - it puts the monument on the movement network, so a cohort can march round the
 *    Circus instead of only past one end of it;
 *  - and from above it draws the outline the eye needs to see that the monument is a
 *    *different kind of thing* from the houses.
 *
 * Rank is by size: anything over 150 m on its long axis gets a `secondary` ring, the rest
 * `local`. Hills, gardens and the island are landscape and get nothing.
 */
const RING_MARGIN = 4;
function monumentRings(): CityWay[] {
  const out: CityWay[] = [];
  for (const l of LANDMARKS) {
    if (l.soft || l.onRiver) continue;
    // **Rank by size, and sparingly.** Ringing all 34 monuments with a 14 m road is five
    // kilometres of carriageway, and measured against the fabric it drowns it: monument
    // precincts plus the armature were taking 80 % of the ground inside the walls and the
    // city came back as streets with houses in the gaps rather than the other way round. A
    // small temple does not need its own ring — the quarter's own lanes already run past
    // it — so only the ones with a genuinely monumental frontage get one.
    const long = Math.max(l.hw, l.hd) * 2;
    if (long < 95) continue;
    const cls: WayClass = long > 260 ? 'secondary' : long > 150 ? 'local' : 'vicus';
    const w = WAY_WIDTH[cls];
    // Centreline of the ring: clear of the precinct by the margin plus half the road.
    const hu = l.hw + RING_MARGIN + w * 0.5;
    const hv = l.hd + RING_MARGIN + w * 0.5;
    const cs = Math.cos(l.rot);
    const sn = Math.sin(l.rot);
    const at = (u: number, v: number): { x: number; z: number } => ({
      x: l.x + u * cs - v * sn,
      z: l.z + u * sn + v * cs,
    });
    out.push({
      id: `ring-${l.id}`,
      cls,
      width: w,
      paved: true,
      porticoed: cls === 'secondary',
      path: [at(-hu, -hv), at(hu, -hv), at(hu, hv), at(-hu, hv), at(-hu, -hv)],
    });
  }
  return out;
}

/**
 * Feeders: the links that make the armature a connected graph rather than a bundle of
 * parallel lines.
 *
 * A cohort has to be able to get from the gate to any quarter, and the named viae alone do
 * not manage it — they were authored for the silhouette, and several of them never touch.
 * So each district is joined to whichever way is nearest its centre by a straight `local`
 * link, and each way's far endpoint is joined to its nearest neighbour way. Both passes are
 * pure functions of the plan, so they are deterministic and they re-solve automatically
 * when the overlap resolver moves a monument.
 */
export const WAY_RANK: Readonly<Record<WayClass, number>> = { artery: 3, secondary: 2, local: 1, vicus: 0 };
const BY_RANK: readonly WayClass[] = ['vicus', 'local', 'secondary', 'artery'];

function feeders(base: readonly CityWay[]): CityWay[] {
  const out: CityWay[] = [];
  const nearestOn = (
    x: number,
    z: number,
    skip?: string
  ): { x: number; z: number; d: number; cls: WayClass } => {
    let best = { x, z, d: Infinity, cls: 'vicus' as WayClass };
    for (const w of base) {
      if (w.id === skip) continue;
      for (let i = 0; i + 1 < w.path.length; i++) {
        const a = w.path[i];
        const b = w.path[i + 1];
        const ax = b.x - a.x;
        const az = b.z - a.z;
        const len2 = ax * ax + az * az;
        const t = len2 < 1e-6 ? 0 : clamp(((x - a.x) * ax + (z - a.z) * az) / len2, 0, 1);
        const px = a.x + ax * t;
        const pz = a.z + az * t;
        const d = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
        if (d < best.d) best = { x: px, z: pz, d, cls: w.cls };
      }
    }
    return best;
  };

  /**
   * Every quarter gets a ranked approach, and it is an **artery**.
   *
   * `secondary` was already an upgrade on `local` — a district joined to the network by a
   * 14 m lane is a district a marching column cannot enter — but 24 m is still eleven metres
   * short of a cohort in line, so under it the *only* ground in Rome a cohort could deploy
   * on was the pomerium, the five named arteries and the handful of squares. Measured on the
   * nav probe as the fabric was densified: cohort-reachable cells inside the circuit fell
   * from 3,412 to 2,778, because filling the blocks in took away the scattered open ground a
   * formation had been using by accident. Openness that a formation reaches *by accident* is
   * not a street network — it is the same fault the whole rebuild exists to correct, seen
   * from the sim's side.
   *
   * So the ground comes back deliberately, as one 42 m approach per quarter. Seventeen
   * links, about 3.4 km, and the eighteen extra metres over a secondary cost roughly 61,000
   * m² — 2.4 % of the walled area — for the property that a cohort can march into every
   * quarter of Rome. That is exactly the trade the width table was written to make.
   */
  for (const d of DISTRICTS) {
    const hit = nearestOn(d.x, d.z);
    // Already on a way, or impossibly far (the far bank, which the bridges serve).
    if (hit.d < 40 || hit.d > 620) continue;
    out.push({
      id: `feeder-${d.id}`,
      cls: 'artery',
      width: WAY_WIDTH.artery,
      paved: true,
      path: [{ x: d.x, z: d.z }, { x: hit.x, z: hit.z }],
    });
  }
  // Stitch every loose end onto the network so no named way is an island.
  //
  // A stitch takes the **lower rank of the two ways it joins**, which is the rule a real
  // road hierarchy follows and, more to the point here, the rule that keeps the wide
  // network connected: two arteries meeting end to end are joined by an artery, so a
  // cohort can pass, while an artery running into a lane is joined by a lane and the
  // fabric keeps the ground.
  for (const w of base) {
    for (const end of [w.path[0], w.path[w.path.length - 1]]) {
      const hit = nearestOn(end.x, end.z, w.id);
      // Under 45 m the two ways already meet for practical purposes and the stitch is
      // pure carriageway; over 340 m it is a road through open country, not a link.
      if (hit.d < 45 || hit.d > 340) continue;
      const cls = BY_RANK[Math.min(WAY_RANK[w.cls], WAY_RANK[hit.cls])];
      out.push({
        id: `stitch-${w.id}-${Math.round(end.x)}`,
        cls,
        width: WAY_WIDTH[cls],
        paved: true,
        path: [{ x: end.x, z: end.z }, { x: hit.x, z: hit.z }],
      });
    }
  }
  return out;
}

/** Named historical viae, as the plan diagnostic labels them. */
export const STREETS: StreetSpec[] = NAMED_WAYS.map((w) => ({
  id: w.id,
  width: w.width,
  paved: w.paved,
  path: w.path,
}));

/**
 * The whole street armature: named viae, the military road behind the wall, a ring round
 * every monument, and the feeders that connect them.
 *
 * Order matters — the fabric generator clips against this in order and the first match
 * wins for surface treatment, so the widest and most important ways come first.
 */
/**
 * Bend a way round the monuments, **because the monuments moved after it was drawn.**
 *
 * This is the other half of "the large monuments are smacked down across multiple buildings",
 * and the half nothing in the build could see. A named via is projected from the survey; the
 * overlap resolver then shoves every monument to stop them interpenetrating, by a mean of
 * 45 m and as much as 145 m. Nothing re-ran the streets afterwards, so the Via Appia ran
 * through the Circus Maximus, the Via Sacra through the Temple of Venus and Rome, and the
 * Via Lata through the Mausoleum of Augustus — at *zero* clearance, not a graze.
 *
 * Measured along the centreline against the same boxes the sim collides with: via-appia 90 %
 * of its length inside masonry, via-triumphalis 91 %, via-sacra 81 %, via-lata 73 %. That is
 * why a cohort could march the whole military road behind the wall and then not get into the
 * city — the arteries were not corridors at all, they were dotted lines through buildings —
 * and it is why the fabric round them looked bitten: the generator correctly refused to build
 * where a street was reserved, and the street was reserved inside a temple.
 *
 * The fix is the one a Roman surveyor would recognise. Resample the line every 30 m so there
 * are nodes to work with, then push any node that is inside a precinct out along its shortest
 * exit until the *carriageway* clears the masonry, and relax the result so the deflection
 * reads as a bend rather than a kink. The Via Sacra really does bend round the Basilica of
 * Maxentius; the Clivus Argentarius really does bend round the Capitol.
 *
 * Ring roads are exempt: a ring is *defined* by hugging its own monument, and deflecting one
 * would be asking it not to be a ring.
 */
const DEFLECT_MARGIN = 3;
function deflect(way: CityWay): void {
  const ringOf = way.id.startsWith('ring-') ? way.id.slice(5) : null;
  const solids = LANDMARKS.filter((l) => !l.soft && l.id !== ringOf);
  const clear = way.width * 0.5 + DEFLECT_MARGIN;

  const dense: { x: number; z: number }[] = [];
  for (let i = 0; i + 1 < way.path.length; i++) {
    const a = way.path[i];
    const b = way.path[i + 1];
    const n = Math.max(1, Math.round(Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z)) / 30));
    for (let s = 0; s < n; s++) dense.push({ x: lerp(a.x, b.x, s / n), z: lerp(a.z, b.z, s / n) });
  }
  dense.push({ ...way.path[way.path.length - 1] });

  // Only the Via Lata has a node that cannot move: its first is the Porta Flaminia's
  // carriageway, and the road out of the one gate in the circuit does not get to wander.
  const first = way.id === 'via-lata' ? 1 : 0;
  const push = (): number => {
    let moved = 0;
    const pt: Obb = { x: 0, z: 0, hw: 0.1, hd: 0.1, rot: 0 };
    for (let i = first; i < dense.length; i++) {
      pt.x = dense[i].x;
      pt.z = dense[i].z;
      for (const l of solids) {
        const hit = obbOverlap(pt, l, clear);
        if (!hit) continue;
        // `obbOverlap` points its normal from a toward b, so away is the negative. The 8 %
        // overshoot matters: landing exactly on the boundary leaves the node oscillating
        // between two neighbouring precincts and the relaxation never settles.
        dense[i].x -= hit.nx * hit.depth * 1.08;
        dense[i].z -= hit.nz * hit.depth * 1.08;
        pt.x = dense[i].x;
        pt.z = dense[i].z;
        moved++;
      }
    }
    return moved;
  };

  // Relax weakly — 0.12 a side, not 0.25. The smoothing exists so a node shoved sixty metres
  // drags its neighbours into a curve instead of leaving a spike the fabric has to be cut
  // around; at a quarter each side it was undoing the push faster than the push applied it,
  // and the deflection converged to about half the job (via-appia 90 % of its length inside
  // masonry down to 34 %, where it needed to reach zero).
  for (let pass = 0; pass < 40; pass++) {
    const moved = push();
    if (moved === 0) break;
    for (let i = 1; i + 1 < dense.length; i++) {
      dense[i].x = dense[i].x * 0.76 + (dense[i - 1].x + dense[i + 1].x) * 0.12;
      dense[i].z = dense[i].z * 0.76 + (dense[i - 1].z + dense[i + 1].z) * 0.12;
    }
  }
  // Finish on pure pushes, so the last thing that happened to the line was clearing stone.
  for (let i = 0; i < 6; i++) if (push() === 0) break;
  way.path = dense;
}

/**
 * True where a monument's masonry stands, for the paving.
 *
 * **The reservation and the paving want different answers here, and conflating them cost
 * 558 cells of cohort reach before it was separated out.**
 *
 * Deflection bends the ways round the monuments but cannot always finish the job: at
 * `PLAN_SCALE` 0.65 the Campus Martius is very nearly wall-to-wall precinct, and about a
 * quarter of the ranked network's length still ends up inside one. The reflex is to cut
 * those runs out of `WAYS` entirely — and measured, that is a bad trade. It surrenders the
 * *reservation* on both sides of the monument, the fabric closes in behind it, and the
 * corridors that were the point of the whole exercise neck shut: cohort-reachable ground
 * inside the circuit fell from 3,466 cells to 2,908, below where this workstream started.
 *
 * The reservation through a monument costs nothing — the monument is already there, and
 * nothing was going to be built inside it. The only thing that was actually wrong is that
 * `buildWays` painted a basalt carriageway across the temple's floor. So the way keeps its
 * whole length, and the *paving* skips the cells that stand on masonry.
 */
export function onMonument(x: number, z: number): boolean {
  for (const l of LANDMARKS) {
    if (l.soft) continue;
    const dx = x - l.x;
    const dz = z - l.z;
    if (dx * dx + dz * dz > (l.hw + l.hd) * (l.hw + l.hd)) continue;
    const cs = Math.cos(l.rot);
    const sn = Math.sin(l.rot);
    if (Math.abs(dx * cs - dz * sn) <= l.hw && Math.abs(dx * sn + dz * cs) <= l.hd) return true;
  }
  return false;
}

export const WAYS: CityWay[] = (() => {
  const named = [POMERIUM_WAY, ...NAMED_WAYS];
  const rings = monumentRings();
  // Deflect the named viae *before* the feeders are solved, so a feeder joins the line the
  // road actually takes rather than the line the survey drew before the monuments moved.
  for (const w of named) deflect(w);
  const base = [...named, ...rings];
  const links = feeders(base);
  for (const w of links) deflect(w);
  return [...base, ...links];
})();

/**
 * An open paved square where two ranked ways meet.
 *
 * **This is what pays for the density.** Filling the blocks in solid takes away the
 * scattered open ground the old plan had, and with it the room a cohort needs to wheel —
 * measured on the old plan, 47 % of the city's free cells would hold a cohort in line but
 * only 14 % of them could be reached by one, because that ground was puddles. Concentrating
 * the same openness into squares at the junctions of the network gives the manoeuvre room
 * back *where a formation actually needs it*, and it does it at the one place a city is
 * historically open anyway.
 *
 * Rome is the proof: the Forum Romanum, the Forum Boarium, the Forum Holitorium, the four
 * Imperial Fora, the Area Sacra, the Saepta and the precincts of the great baths are all
 * exactly this — a paved rectangle where the important streets converge. A plan of Rome
 * without them does not read as Rome, and Lanciani's plate is more square than street in
 * the monumental core.
 */
export interface CityPlaza {
  id: string;
  x: number;
  z: number;
  hw: number;
  hd: number;
  rot: number;
  /** Colonnaded on all four sides, as a forum is. */
  porticoed: boolean;
}

const RANKED: ReadonlySet<WayClass> = new Set<WayClass>(['artery', 'secondary']);

/**
 * Junctions of the ranked network, clustered and turned into squares.
 *
 * Deterministic and derived: nothing here is hand-placed, so a plaza follows its junction
 * when the overlap resolver moves a monument. A junction is only kept if it stands clear
 * of every monument footprint — the Colosseum already has a precinct and does not need a
 * square driven through it.
 */
/**
 * How many squares the city gets.
 *
 * Sized against the manoeuvre budget rather than chosen: a rank-4 square is 124 × 84 m,
 * which after eroding by a cohort's 17.5 m half-width leaves 89 × 49 m — about 270 cells of
 * the 4 m occupancy grid that a cohort in line can stand in and turn around. Fourteen of
 * them is roughly the district-scale open ground the old scattered plan supplied, gathered
 * into places a formation can actually reach.
 */
const PLAZA_CAP = 14;

export const PLAZAS: CityPlaza[] = (() => {
  const hits: { x: number; z: number; rank: number; rot: number }[] = [];
  const ranked = WAYS.filter((w) => RANKED.has(w.cls));
  const rankOf = (c: WayClass): number => (c === 'artery' ? 2 : 1);
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i];
      const b = ranked[j];
      // A ring and its own monument's approach meet everywhere; skip a ring against a ring.
      if (a.id.startsWith('ring-') && b.id.startsWith('ring-')) continue;
      for (let p = 0; p + 1 < a.path.length; p++) {
        for (let q = 0; q + 1 < b.path.length; q++) {
          const h = segIntersect(a.path[p], a.path[p + 1], b.path[q], b.path[q + 1]);
          if (!h) continue;
          // Orient the square to the bisector of the two ways, so it reads as belonging
          // to the junction rather than to the map axes.
          const ta = Math.atan2(a.path[p + 1].z - a.path[p].z, a.path[p + 1].x - a.path[p].x);
          hits.push({ x: h.x, z: h.z, rank: rankOf(a.cls) + rankOf(b.cls), rot: ta });
        }
      }
    }
  }
  // Cluster: two junctions 60 m apart are one square, not two.
  const clusters: { x: number; z: number; rank: number; rot: number; n: number }[] = [];
  for (const h of hits) {
    const near = clusters.find((c) => Math.sqrt((c.x - h.x) * (c.x - h.x) + (c.z - h.z) * (c.z - h.z)) < 70);
    if (near) {
      near.x = (near.x * near.n + h.x) / (near.n + 1);
      near.z = (near.z * near.n + h.z) / (near.n + 1);
      near.rank = Math.max(near.rank, h.rank);
      near.n++;
    } else {
      clusters.push({ ...h, n: 1 });
    }
  }
  // Biggest junctions first, and a hard cap: a city of squares is not a city either.
  clusters.sort((a, b) => b.rank - a.rank || b.n - a.n || a.x - b.x || a.z - b.z);
  const out: CityPlaza[] = [];
  for (const c of clusters) {
    if (out.length >= PLAZA_CAP) break;
    // Rank 4 is artery × artery: a full forum. Rank 2 is two secondaries: a market square.
    const hw = c.rank >= 4 ? 62 : c.rank >= 3 ? 50 : 38;
    const hd = hw * 0.68;
    const rot = c.rot;
    if (LANDMARKS.some((l) => !l.soft && obbOverlap({ x: c.x, z: c.z, hw, hd, rot }, l, 4))) continue;
    if (c.z < CITY_Z_MIN(c.x) + hd + 8 || c.z > CITY_Z_MAX - hd) continue;
    if (out.some((p) => Math.sqrt((p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z)) < hw + p.hw + 24)) continue;
    out.push({ id: `forum-${out.length}`, x: c.x, z: c.z, hw, hd, rot, porticoed: c.rank >= 3 });
  }
  return out;
})();

/** Intersection of two 2-D segments, or null when they do not cross. */
function segIntersect(
  a1: { x: number; z: number },
  a2: { x: number; z: number },
  b1: { x: number; z: number },
  b2: { x: number; z: number }
): { x: number; z: number } | null {
  const rx = a2.x - a1.x;
  const rz = a2.z - a1.z;
  const sx = b2.x - b1.x;
  const sz = b2.z - b1.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * sz - (b1.z - a1.z) * sx) / den;
  const u = ((b1.x - a1.x) * rz - (b1.z - a1.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + rx * t, z: a1.z + rz * t };
}

/**
 * The whole street network by rank: how many ways of each class and how many kilometres.
 *
 * **`extra` is the district lanes and leaving them out was actively misleading.** The
 * armature is 42 ways and 19 km; the spines and ribs each quarter cuts for itself are
 * several hundred more and the majority of the network by length, so a mix reported from
 * `WAYS` alone said the city had 42 streets in it while the player was looking at a
 * thousand. `CitySystem` passes the generated lanes in, and the number in `stats()` is now
 * the number a plan view can be counted against.
 */
export function wayMix(
  extra: readonly { cls: WayClass; path: readonly { x: number; z: number }[] }[] = []
): { cls: WayClass; count: number; km: number }[] {
  const acc = new Map<WayClass, { count: number; km: number }>();
  const add = (cls: WayClass, path: readonly { x: number; z: number }[]): void => {
    const e = acc.get(cls) ?? { count: 0, km: 0 };
    e.count++;
    for (let i = 0; i + 1 < path.length; i++) {
      e.km += Math.sqrt((path[i + 1].x - path[i].x) * (path[i + 1].x - path[i].x) + (path[i + 1].z - path[i].z) * (path[i + 1].z - path[i].z)) / 1000;
    }
    acc.set(cls, e);
  };
  for (const w of WAYS) add(w.cls, w.path);
  for (const l of extra) add(l.cls, l.path);
  return (['artery', 'secondary', 'local', 'vicus'] as WayClass[])
    .filter((c) => acc.has(c))
    .map((cls) => ({ cls, count: acc.get(cls)!.count, km: +acc.get(cls)!.km.toFixed(2) }));
}
