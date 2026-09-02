// `terrain/topography`, not `terrain/TerrainSystem` — see the note in `circuit.ts`.
import { HALF_EXTENT, worldOf as projectSurvey } from '../../terrain/topography';
import { TIBER_ISLAND } from '../../terrain/tiberSurvey';
import { clamp } from '../../util/math';
import {
  AX, axisU, axisV, KeepOut, obbOverlap, obbRadius,
  type Obb, type OverWaterDeclaration, type WayClass,
} from '../layout';
import { GATE_X } from './apertures';
import { ROME_WAYS, wayBearingAt } from './ways';
// Straight from the terrain, not through `./circuit`: the wall builder now reads
// `./assertions`, which reads this file, and `./circuit` would close the cycle.
import {
  WALL_LENGTH, WALL_X_MIN, riverBankX, romeWallZ as wallCrestZ,
} from '../../terrain/topography';
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
  /**
   * **The largest `draw` this row is ALLOWED, where something outside the conflict solve caps
   * it — and it is published because a check has to be able to tell the two apart.**
   *
   * `survey.ts:RomeMonument.drawMax` is the field and its docstring is the argument; only
   * `castra-praetoria` carries one today. It matters outside the layout because
   * `probe-fabric` G13a grades a monument's drawn plan against the literature and cannot
   * otherwise distinguish *"the author drew it too small"* from *"no footprint this size fits
   * on the ground here"*. `MAP-METHOD.md`'s rule about `probe-eye` E1d is the form: the
   * exclusion has to arrive AFTER a check that justifies it, so the cap is published, the gate
   * checks the row is drawn at the cap, and only then is the band failure licensed.
   */
  drawMax?: number;
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
  /**
   * Declared to stand over the water, with the reason. See `RomeMonument.overWater`, and
   * `OVER_WATER_DECLARED` below for what reads it.
   */
  overWater?: string;
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
    drawMax: m.drawMax,
    heightScale: drawHeightOf(m),
    clear: Math.sqrt(hw * hw + hd * hd),
    mound: m.mound,
    moundRadius: m.moundRadius === undefined ? undefined : m.moundRadius * planScale,
    where: m.where,
    complex: m.complex,
    farBank: m.farBank,
    onRiver: m.onRiver,
    overWater: m.overWater,
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
 * **Rome's masonry over the Tiber, declared. Two rows, both with a source.**
 *
 * See `OverWaterDeclaration` in `../layout` for what a declaration is and is not. In short:
 * `probe-fabric` G22 fails every solid whose footprint stands in the water, licenses only the
 * rows in this list, gates the list's MEMBERSHIP against a copy of its own, and refuses the
 * licence anyway unless the solid is still founded on the bank. Declaring something here is
 * how a fact about Rome gets past the gate; it is not how a fault does.
 *
 *  - **The Theatre of Marcellus.** Authored on the survey row itself (`RomeMonument.overWater`)
 *    and lifted from `LANDMARKS`, so the envelope is derived from the placement the game is
 *    built from and cannot drift from it. Its `cite` carries the measurement: no plan scale
 *    takes the cavea out of the channel, moving west makes it five times worse, and the
 *    theatre stands on the Ripa with its stage flank toward the Tiber, and carrying that
 *    flank on piles is this map's decision rather than a citation. `buildRipaPiles` draws it.
 *  - **The river-wall return.** `works.ts:riverWallPlan` places the west return's foot at
 *    `riverBankX(z, 1) - 3` — *into* the channel by three metres, deliberately, because "a
 *    wall that stops at the waterline leaves a cell of dry bank the raster can round" at the
 *    one place the Aurelian circuit meets the Tiber. `buildRiverWall` foots it 3.4 m below the
 *    local ground for the same reason. It is 1.2 m thick, so 14 m² of it is wet.
 *
 * **The return is declared as an envelope rather than as its exact rectangle, and the envelope
 * is drawn loosely on purpose.** `riverWallPlan` takes the *built* first bay, which does not
 * exist until `buildWall` has run, so this list — which is static plan data — cannot call it.
 * The envelope is computed from the same two functions the plan is (`romeWallZ` at the
 * circuit's west anchor, and `riverBankX` at that latitude) and padded out generously in both
 * axes. That is safe because **G22 licenses a solid only when the declaration CONTAINS it**,
 * every corner: it stops 4 m past `WALL_X_MIN` and the first curtain bay runs 37 m east of
 * there, so no part of the land wall is inside it — and nothing bigger than the envelope could
 * be licensed by it in any case. Shaving it to the masonry would buy nothing and would make
 * the licence go stale the first time the anchor moved a metre. If the return does move out
 * from under it, the licence goes **stale** and G22 fails on both counts at once: the
 * unlicensed masonry and the dead licence.
 */
export const OVER_WATER_DECLARED: readonly OverWaterDeclaration[] = (() => {
  const out: OverWaterDeclaration[] = [];
  for (const l of LANDMARKS) {
    if (!l.overWater) continue;
    /*
     * **Axis-aligned, and that is not laziness — it is the one convention both sides agree
     * on.** `CitySystem:occRot` negates plan rotation at the sim boundary, because
     * `Obstacles.ts` measures yaw the other way round and the fix was a negation there rather
     * than a change to everyone's axes. So the rectangle this file calls the Theatre and the
     * rectangle the collision surface calls the Theatre are **mirror images** at any non-zero
     * bearing, and a containment test between them fails on a monument that is in exactly the
     * right place. It did: the first draft published `rot: l.rot` and G22 reported the
     * declaration STALE while faulting the row it was written for.
     *
     * The axis-aligned bounding box of an oriented rectangle is **invariant under that
     * mirroring** — flipping the sign of `rot` leaves `|cos|` and `|sin|` alone — so an AABB
     * is the same envelope in both conventions and cannot go wrong the day someone changes
     * one of them. It is bigger than the plan rectangle, and that costs nothing here: the
     * containment test means an envelope can only ever license something *smaller* than
     * itself, and the only solids tested against it are ones already standing in the water.
     */
    const c = Math.abs(Math.cos(l.rot));
    const s = Math.abs(Math.sin(l.rot));
    out.push({
      id: l.id, why: l.overWater, x: l.x, z: l.z,
      hw: l.hw * c + l.hd * s, hd: l.hw * s + l.hd * c, rot: 0,
    });
  }
  const crestZ = wallCrestZ(WALL_X_MIN);
  const bankX = riverBankX(crestZ, 1);
  const x0 = bankX - 8;
  const x1 = WALL_X_MIN + 4;
  out.push({
    id: 'river-wall-return',
    why: 'works.ts:riverWallPlan runs the west return 3 m PAST the east bank on purpose — a '
      + 'wall that stops at the waterline leaves a cell of dry bank the occupancy raster can '
      + 'round, and the surviving fragment at Testaccio stands in the embankment rather than '
      + 'beside it. ROME.md 4.6, 1.20 m thick and 5-6 m high',
    x: (x0 + x1) * 0.5, z: crestZ, hw: (x1 - x0) * 0.5, hd: 10, rot: 0,
  });
  return out;
})();

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

/**
 * **`DistrictSpec`, `DISTRICT_PLAN` and `DISTRICTS` are deleted here, and the deletion is the
 * phase.** `docs/ROME-FABRIC.md` §5 phase 4; `src/city/rome/regions.ts` is what replaces them.
 *
 * Seventeen inflated rectangles, each with its own rotation, its own superellipse mask and its
 * own spine-and-rib lattice. `probe-fabric` measured what they cost, and none of it is
 * recoverable by tuning:
 *
 *  - **G18: 82 overlapping pairs, 4.71 km² of double-claimed ground.** This file's own comment
 *    argued for it — *"a district costs nothing where it overlaps a neighbour (the plot grid
 *    gives the ground to whichever quarter is planned first)"*. Ground allocated by planning
 *    order is `MAP-METHOD.md` rule 8's definition of a quilt.
 *  - **G19: 1.46× the available ground claimed and only 0.60× of it covered.** Two fifths of
 *    the land inside the Aurelian circuit was no district's job, so nothing was ever built
 *    there however the generator was tuned.
 *  - **G20: a floor of 6.86°** on block-to-street orientation even with the per-row correction
 *    at zero, because a block in one quarter was routinely nearest a *different* quarter's
 *    lane (§10.5's sweep).
 *  - **G17: two quarters buried**, `emporium` and `forum-boarium`, both `eastBank` rows whose
 *    `x` was overridden 300 m from their surveyed position and whose `z` was clamped to the +Z
 *    edge, so half of each lay off the map whatever angle it took.
 *
 * What replaces them is not a better set of rectangles. A *regio* carries `density`,
 * `minFloors`, `maxFloors`, `grandeur`, `fray` and a terrain class and **no extent at all**;
 * the extent of a block is a face of the road planar graph in `src/city/rome/graph.ts`. The
 * two `eastBank`/`farBank` overrides go with them: the ground along the modelled channel is
 * claimed by Regio IX and Regio XIV because the river is their shared boundary, not because a
 * rectangle was dragged onto the water.
 */


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
 * The named streets of Rome — **the table moved out of this file in phase 3.**
 *
 * `src/city/rome/ways.ts` now carries the armature, in survey metres, with a plate citation
 * per row. It moved for a reason and not for tidiness: while the table lived here it lived
 * *below* the monument placement, and everything below the monument placement had access to
 * the resolved monument positions — which is how `deflect()` came to exist and how 24 % of
 * ranked street length came to be inside a monument. A way authored in a module that cannot
 * see a monument cannot be bent round one.
 *
 * On width, and the honest size of the compromise, which has not changed. A real Roman *via*
 * is about 4.8 m between kerbs and the Via Lata perhaps twelve. Nothing here is that narrow,
 * because a street a formation cannot enter is not a street in this game, it is a wall with a
 * crack in it. The compromise is confined rather than spread: **one** way carries `artery`
 * rank besides the military road, eleven carry `secondary`, and the several hundred lanes each
 * quarter cuts for itself are 8 m. Rome had a handful of processional ways and a fabric of
 * *vici*; so does this.
 */
/**
 * The named historical viae, **projected once and never touched again.**
 *
 * The clamp is the only thing that happens to a node between `ways.ts` and the scene, and it
 * is a frame clamp, not a plan correction: `x` into the heightfield, `z` into the city side of
 * the curtain — unless the row declares `outside`, in which case it is the four consular roads
 * the assault forms up on and they are clamped to the map instead. Before this pass that
 * `CITY_Z_MIN(x) − 18` bound applied to every row, which meant **no way could leave the city**
 * and the Via Flaminia outside the Porta Flaminia could not be drawn at all.
 */
const NAMED_WAYS: CityWay[] = ROME_WAYS.map((s) => ({
  id: s.id,
  cls: s.cls,
  width: WAY_WIDTH[s.cls],
  paved: s.paved,
  porticoed: s.porticoed,
  path: s.path.map(([e, n]) => {
    const w = worldOf(e, n);
    const x = clamp(w.x, -HALF_EXTENT + 20, HALF_EXTENT - 20);
    const zLo = s.outside ? -HALF_EXTENT + 20 : CITY_Z_MIN(x) - 18;
    return { x, z: clamp(w.z, zLo, CITY_Z_MAX) };
  }),
}));

/**
 * **The gate pin, generalised from the Via Lata's hand-written one to all four apertures.**
 *
 * A gate's `x` is surveyed and its `z` is the terrain's — `romeWallZ(x)`, the crest the wall is
 * actually drawn on. The two agree to the digit at the Porta Flaminia, because the projection
 * is anchored there, and nowhere else: at the Porta Salaria the surveyed northing projects to
 * `z 621` against a crest of `469`. So each way that declares a `gate` has the node nearest
 * that gate's `x` moved onto `(gateX, crest + 8)` — 8 metres inside the mouth, so the paving
 * starts under the arch rather than under the curtain.
 *
 * This is a **pin**, in `ways.ts`'s sense: the plate gives the line, and the engine's own
 * feature gives the endpoint. It is the only place a monument-free correction is applied to a
 * way, it applies to one node per way, and the rows that take it say so in the table.
 */
{
  const APERTURE_X: Record<string, number> = {
    'porta-flaminia': GATE_X,
    'posterula-pinciana': worldOf(530, 1789).x,
    'porta-salaria': worldOf(1036, 1784).x,
    'porta-nomentana': worldOf(1831, 1784).x,
  };
  for (const spec of ROME_WAYS) {
    if (!spec.gate) continue;
    const built = NAMED_WAYS.find((w) => w.id === spec.id);
    if (!built) continue;
    const gx = APERTURE_X[spec.gate];
    const gz = (spec.gate === 'porta-flaminia' ? GATE_Z : wallCrestZ(gx)) + 8;
    let best = 0;
    for (let i = 1; i < built.path.length; i++) {
      if (Math.abs(built.path[i].x - gx) < Math.abs(built.path[best].x - gx)) best = i;
    }
    built.path[best] = { x: gx, z: gz };
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
 * **`monumentRings`, `feeders` and `deflect` are deleted here, and the deletion is the phase.**
 *
 * `docs/ROME-FABRIC.md` §5's phase 3 names all three, and each was a different way of letting
 * something downstream of the survey decide where a street goes:
 *
 *  - **`deflect`** resampled every way every 30 m and pushed its nodes out of the monuments the
 *    overlap resolver had just moved, with a 1.08 overshoot and 40 relax passes. The resolver
 *    is gone (phase 2) and the monuments now stand where the plate puts them, so the only
 *    thing left for `deflect` to do was bend a correctly-surveyed street round a
 *    correctly-surveyed building — which is `ROME-FABRIC.md` §4.2's rule read backwards. Its
 *    largest single act was a **360 real metre bow in the Via Lata** round a tomb that stands
 *    140 m to the west of it; see `ways.ts`'s `via-lata`.
 *  - **`monumentRings`** put a 14–24 m carriageway all the way round every monument over 95 m,
 *    at the monument's own bearing. Five kilometres of road nobody authored, and — measured
 *    this pass — the largest single contributor to `probe-fabric` G20: a block beside the
 *    Colosseum took its "nearest street" from the Colosseum's own ring, so the grain of the
 *    quarter came from the amphitheatre's rotation rather than from the street network. The
 *    clearance the rings were bought for is now `MON_AMBITUS` in `plan.ts`, which buys it by
 *    construction and costs no carriageway (`ROME-FABRIC.md` §9.7).
 *  - **`feeders`** joined every district centre to the nearest way with a straight **42 m**
 *    link and stitched every loose end to its nearest neighbour. Seventeen arteries and about
 *    3.4 km of them, at arbitrary bearings, produced by a nearest-point search over a plan.
 *    Connectivity is now a property of the authored table — junctions are shared nodes, and
 *    `assertWayGraph` fails the boot if the ranked armature stops being one piece.
 *
 * What replaced them, in one sentence: **the ways are right, so nothing has to correct them.**
 */
export const WAY_RANK: Readonly<Record<WayClass, number>> = { artery: 3, secondary: 2, local: 1, vicus: 0 };

/** Named historical viae, as the plan diagnostic labels them. */
export const STREETS: StreetSpec[] = NAMED_WAYS.map((w) => ({
  id: w.id,
  width: w.width,
  paved: w.paved,
  path: w.path,
}));

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

/**
 * The whole street armature: the military road behind the curtain, then the named viae.
 *
 * Twenty-four ways and no derived ones. Order matters — the fabric generator clips against
 * this list in order and the first match wins for surface treatment — so the military road,
 * which every other way crosses, comes first.
 *
 * **There is no step between the authored table and this array.** That is the whole of phase 3
 * in one line: `ROME_WAYS` → `worldOf` → a frame clamp → here. Nothing reads a monument.
 */
export const WAYS: CityWay[] = [POMERIUM_WAY, ...NAMED_WAYS];

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
 * armature is 23 ways and 11.6 km — it was 41 and 14.2 before phase 3 deleted the monument
 * rings and the feeders, and this comment said "42 and 19", which nothing had ever measured; the
 * figure is `probe-fabric`'s `armatureWays`/`armatureKm` off the built scene. The spines and ribs
 * each quarter cuts for itself are
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

/**
 * **The reservation map, in one place, because two callers were building different ones.**
 *
 * `plan.ts` assembled this inline and `tools/scratch/rome-blockcheck.mjs` assembled its own
 * copy beside a comment claiming it was "the same `KeepOut` `src/city/plan.ts` assembles".
 * It was not: the copy reserved `l.hw`/`l.hd` with no ambitus, and reserved `STREETS` at a
 * flat 2.5 m margin instead of `WAYS` at `WAY_FRONTAGE` by rank. So the fast instrument
 * measured a city with **20 more buildings in it** than the one the engine builds, which is
 * `MAP-METHOD.md` rule 29's failure mode exactly — the fast tool and the slow tool disagree,
 * and the fast one is the one people run. One function, both callers.
 *
 * `MON_AMBITUS` is 4 m and the number is earned in `plan.ts`'s own note: `probe-fabric` G9
 * wants the XII Tables' 1.5 m *ambitus* between a monument and a house, and G14 measures a
 * smallest oversail of 2.52 m on the Tabularium, so anything under 1.5 + 2.52 is provably too
 * small for every monument that oversails its own box.
 */
export const MON_AMBITUS = 4;

export function romeKeepOut(): KeepOut {
  const keepOut = new KeepOut();
  for (const l of LANDMARKS) {
    keepOut.addRect(l.x, l.z, l.hw + MON_AMBITUS, l.hd + MON_AMBITUS, l.rot);
    // A mound is bigger in plan than the building on it.
    /**
     * **A mound is bigger in plan than the building on it — and it is the shape of the
     * building, not a circle.** `monuments.ts` already *draws* the mound elliptical, so the
     * Janiculum's drawn ridge is 418 x 193 world metres on its own bearing while the ground
     * reserved for it was a 469 m circle: 6.9 hectares of Transtiberim, and measured on the
     * far bank it was the whole of the quarter's non-horti ground.
     *
     * A rectangle rather than an ellipse because `KeepOut` has `addRect` and `addCircle` and
     * no third thing, and circumscribing is the conservative direction -- it reserves 4/pi
     * more ground than the mound covers and so can never put a house on the hillside. The
     * four other mounded rows are all within 15% of round, so this moves them by metres and
     * moves the Janiculum by a quarter of a kilometre.
     *
     * Recovered during the merge of e/city/rome-transtiberim and e/city/rome-fill: the second
     * branch extracted this function without the first branch's fix, so taking its refactor
     * whole would have silently restored the circle.
     */
    if (l.mound) {
      const k = (l.moundRadius ?? l.clear) / l.clear;
      keepOut.addRect(l.x, l.z, l.hw * k * 1.02, l.hd * k * 1.02, l.rot);
    }
  }
  for (const w of WAYS) keepOut.addPath(w.path, w.width * 0.5 + WAY_FRONTAGE[w.cls]);
  for (const p of PLAZAS) keepOut.addRect(p.x, p.z, p.hw + 2, p.hd + 2, p.rot);
  for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);
  return keepOut;
}
