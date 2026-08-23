/**
 * **The fourteen Augustan *regiones*, as a partition, carrying attributes and not extents.**
 *
 * This file replaces `DISTRICT_PLAN`'s seventeen rectangles. `MAP-METHOD.md` rule 8 states why
 * in one line — *"a layout region must be a partition, not a set of rectangles"* — and
 * `probe-fabric` measured the cost of the rectangles at **82 overlapping pairs, 4.71 km² of
 * double-claimed ground, 1.46× the available land claimed and only 0.60× of it covered at
 * all.** Two fifths of the ground inside the Aurelian circuit was nobody's job to fill, and
 * the rest was allocated by *planning order*, which is invisible in the output.
 *
 * ## The two halves of the fix, and which half is here
 *
 * `docs/ROME-FABRIC.md` §4.3: *"the regions carry **attributes, not extents**… Extents come
 * from the road graph's faces. A block's character is looked up from the region it falls in;
 * its geometry comes from the streets. That separation is the whole fix."*
 *
 *  - **A block's geometry** is a face of the planar road graph. `graph.ts`, and nothing in
 *    this file touches it.
 *  - **A block's character** — how many storeys, how packed, how grand, whether it is fabric
 *    at all or a garden — is looked up here, from the *regio* its centroid falls in.
 *
 * So a region is a lookup table with an outline attached, and the outline exists for exactly
 * one reason: an administrative division of a city **tiles it**, which is the property rule 8
 * asks for and the property a rectangle cannot have.
 *
 * ## How the tiling is guaranteed rather than hoped for
 *
 * The ten on-frame regions are authored over a **shared node table**: where two regions abut,
 * both rings list the *same* vertices, in opposite order. That makes the partition exact
 * rather than approximate — no clipping, no tolerance, no tie-break — and it makes an
 * authoring mistake findable: `assertRegionPartition` walks every ring's edges and fails if an
 * undirected edge appears once (a hole), three times (a fold), or twice in the *same*
 * direction (a region wound the wrong way). That check can go red, and it did four times while
 * this table was being written.
 *
 * The union of the ten rings contains the whole map frame with room to spare, so every point
 * the probe can sample belongs to exactly one region. Nothing is clipped and nothing is
 * extended at run time.
 *
 * ## Four regions the frame cannot carry, named and counted
 *
 * `MAP-METHOD.md` rule 16: an exclusion is a claim, so it needs a count, a list of names
 * printed every run, and a gate on the count. At `KZ` = 0.35 the map's +Z edge is survey
 * northing **−441**, so **I Porta Capena, II Caelimontium, XII Piscina Publica and XIII
 * Aventinus** have no ground on this map at all — their centres are 667 to 1,500 metres south
 * of the edge. They are rows in `REGIONES` with `outline: null`, they are checked to be off
 * the frame rather than assumed to be, and a fifth off-frame region is a failure and not a
 * category. This is the same decision `offMapSouth` already makes for monuments and
 * `ROME-FABRIC.md` §1.2 makes for Carthage: *"Carthage did not model Carthage."*
 *
 * ## Where the boundaries come from
 *
 * Real regional boundaries ran along streets, so most of the internal chains below are the
 * armature's own lines, taken from `ways.ts` node for node: the **Via Lata** (VII | IX), the
 * **Subura** and **Clivus Suburanus** (VI | IV, VI | V), the **Argiletum** (VIII | IV), the
 * **Vicus Iugarius** (VIII | IX / XI). Where a boundary is a landform rather than a street it
 * is named in the row's `bound` field.
 *
 * The one boundary that is neither is **the Tiber**, and it is not authored by hand: `RIVER`
 * below is the eastern-most crossing of `src/terrain/tiberSurvey.ts`'s 451-station course at
 * each 200 m of northing, so Regio XIV's edge is the channel the terrain actually draws rather
 * than a remembered line beside it. The numbers are printed here rather than computed at
 * import so that a change to the survey shows up as a diff in this file — reproduce them with
 * `node tools/scratch/rome-riverchain.mjs`.
 */
import { HALF_EXTENT, worldOf } from '../../terrain/topography';

/** What a *regio* tells a block about itself. Nothing here is geometry. */
export interface RegioSpec {
  /** Stable id, used by the reports and by `probe-fabric`. */
  id: string;
  /** The Augustan numeral, I–XIV. */
  numeral: string;
  name: string;
  /** The regio's own centre in survey metres — used only to prove an off-frame row is off. */
  e: number;
  n: number;
  /** Storeys, low..high. Augustus capped insulae at 70 Roman feet (20.7 m). */
  minFloors: number;
  maxFloors: number;
  /** 0 = spacious, 1 = packed shoulder to shoulder. */
  density: number;
  /** Weight of grand houses and porticoes among the blocks. */
  grandeur: number;
  /**
   * How ragged the fabric's outer edge is, 0..1. Under the rectangles this faded a district's
   * own boundary, which is why the city stopped at a rectangular seam. It now weights the
   * fringe fade that `fabric.ts` takes from *distance to the nearest ranked way* — a real
   * cause, so the fade follows the streets instead of a box.
   */
  fray: number;
  /**
   * North of this survey northing the *regio* is **horti**, not fabric: terraces, planted
   * avenues, boundary walls, about 6 % building coverage. `ROME-FABRIC.md` §4.3 and `ROME.md`
   * §6.5 — the imperial gardens are Rome's Megara, and an attacker over the wall at the Porta
   * Pinciana arrives in somebody's garden. `null` where the regio has none.
   *
   * Phase 4 builds the *classification* and the sparsity. The dry-stone boundary walls and the
   * terracing are phase 6 and are not here; a flag nothing reads would be worse than no flag
   * (`ROME-FABRIC.md` §9.9 on `maxDrawAt`), so this one is read by `blockCharacter`.
   */
  hortiNorthOf: number | null;
  /** What the boundary is made of, for the reader. Not consumed by code. */
  bound: string;
  /**
   * The ring, in **survey metres**, or `null` where the frame carries no part of the regio.
   * Adjacent rings share their vertices exactly; see `assertRegionPartition`.
   */
  outline: readonly (readonly [number, number])[] | null;
}

/**
 * **The Tiber, as a boundary chain.** Eastern-most crossing of the modelled channel at each
 * 200 m of northing, from `src/terrain/tiberSurvey.ts`, ordered north to south, with the two
 * ends run out to the authoring frame. The channel makes a 1.3 km westward excursion between
 * northings 0 and 1000 — the Ansa — and Regio IX therefore reaches the water there, which is
 * the ground the deleted `ripa-campi` rectangle was invented to fill.
 */
const RIVER: readonly (readonly [number, number])[] = [
  [-1000, 3100],
  [-957, 2400],
  [-899, 2200],
  [-844, 2000],
  [-756, 1800],
  [-660, 1600],
  [-646, 1400],
  [-782, 1200],
  [-1424, 1000],
  [-1537, 800],
  [-1469, 600],
  [-1323, 400],
  [-1151, 200],
  [-975, 0],
  [-288, -200],
  [-201, -400],
  [-230, -900],
];
/** Where Regio IX hands the left bank over to Regio XI: the Forum Boarium reach. */
const RIVER_XI = 14;

/** The Via Lata, from `ways.ts` node for node, run north to the authoring frame. */
const VIA_LATA: readonly (readonly [number, number])[] = [
  [-560, 3100],
  [-497, 2045],
  [-395, 1700],
  [-291, 1350],
  [-187, 1000],
  [-84, 650],
  [0, 367],
];

/** The Quirinal and Pincian foot: VII | VI. */
const PINCIAN_FOOT: readonly (readonly [number, number])[] = [
  [0, 367],
  [140, 430],
  [300, 640],
  [420, 1000],
  [500, 1400],
  [530, 1789],
  [600, 3100],
];

/** The agger and the Castra's glacis: VI | V. */
const AGGER: readonly (readonly [number, number])[] = [
  [1290, 280],
  [1560, 315],
  [1780, 345],
  [2000, 700],
  [2200, 1100],
  [2350, 1500],
  [2500, 2200],
  [2600, 3100],
];

const rev = <T>(a: readonly T[]): T[] => a.slice().reverse();

export const REGIONES: readonly RegioSpec[] = [
  {
    id: 'regio-vii-via-lata',
    numeral: 'VII',
    name: 'Via Lata',
    e: -150, n: 1150,
    minFloors: 3, maxFloors: 5, density: 0.84, grandeur: 0.18, fray: 0.30,
    hortiNorthOf: 1650,
    bound: 'the Via Lata on the west, the Pincian and Quirinal foot on the east; the Pincian '
      + 'gardens north of n 1650 are horti (the collis hortulorum).',
    outline: [...rev(VIA_LATA), ...rev(PINCIAN_FOOT).slice(0, -1)],
  },
  {
    id: 'regio-ix-circus-flaminius',
    numeral: 'IX',
    name: 'Circus Flaminius',
    e: -520, n: 700,
    minFloors: 3, maxFloors: 5, density: 0.80, grandeur: 0.24, fray: 0.35,
    hortiNorthOf: null,
    bound: 'the Tiber on the west, the Via Lata on the east, the Capitol and the Forum '
      + 'Holitorium on the south. The Campus Martius proper.',
    outline: [
      ...RIVER.slice(0, RIVER_XI + 1),
      [-200, -120],
      [-60, 120],
      ...rev(VIA_LATA),
    ],
  },
  {
    id: 'regio-vi-alta-semita',
    numeral: 'VI',
    name: 'Alta Semita',
    e: 900, n: 900,
    minFloors: 2, maxFloors: 4, density: 0.55, grandeur: 0.34, fray: 0.45,
    hortiNorthOf: 1450,
    bound: 'the Quirinal and the Viminal, from the Forum of Trajan to the Castra Praetoria. '
      + 'The Horti Sallustiani and the ground behind the Porta Salaria are horti.',
    outline: [
      [0, 367],
      [200, 340],
      [420, 300],
      [700, 290],
      [880, 250],
      ...AGGER,
      ...rev(PINCIAN_FOOT).slice(0, -1),
    ],
  },
  {
    id: 'regio-iv-templum-pacis',
    numeral: 'IV',
    name: 'Templum Pacis',
    e: 780, n: 90,
    minFloors: 4, maxFloors: 6, density: 0.94, grandeur: 0.05, fray: 0.20,
    hortiNorthOf: null,
    bound: 'the Subura street on the north, the Argiletum on the west, the Via Labicana on '
      + 'the south. The tenement valley.',
    outline: [
      [420, 300],
      [700, 290],
      [880, 250],
      [1030, 245],
      [1150, 100],
      [1000, -60],
      [800, -120],
      [610, -240],
      [500, 120],
    ],
  },
  {
    id: 'regio-v-esquiliae',
    numeral: 'V',
    name: 'Esquiliae',
    e: 1700, n: 300,
    minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.26, fray: 0.55,
    hortiNorthOf: null,
    bound: 'east of the agger, out to the Porta Praenestina. Gardens and villa ranges.',
    outline: [
      [880, 250],
      ...AGGER,
      [3600, 3100],
      [3600, -900],
      [1500, -900],
      [1500, -200],
      [1150, 100],
      [1030, 245],
    ],
  },
  {
    id: 'regio-viii-forum-romanum',
    numeral: 'VIII',
    name: 'Forum Romanum',
    e: 200, n: 40,
    minFloors: 2, maxFloors: 4, density: 0.70, grandeur: 0.55, fray: 0.20,
    hortiNorthOf: null,
    bound: 'the Capitol, the Forum valley and the imperial fora, between the Quirinal foot, '
      + 'the Velia and the Vicus Iugarius.',
    outline: [
      [0, 367],
      [200, 340],
      [420, 300],
      [500, 120],
      [610, -240],
      [250, -420],
      [0, -300],
      [-200, -120],
      [-60, 120],
    ],
  },
  {
    id: 'regio-iii-isis-et-serapis',
    numeral: 'III',
    name: 'Isis et Serapis',
    e: 1000, n: -220,
    minFloors: 3, maxFloors: 5, density: 0.78, grandeur: 0.22, fray: 0.35,
    hortiNorthOf: null,
    bound: 'the Colosseum valley and the Oppian, south of the Via Labicana.',
    outline: [
      [610, -240],
      [800, -120],
      [1000, -60],
      [1150, 100],
      [1500, -200],
      [1500, -900],
      [700, -900],
    ],
  },
  {
    id: 'regio-x-palatium',
    numeral: 'X',
    name: 'Palatium',
    e: 400, n: -450,
    minFloors: 1, maxFloors: 3, density: 0.40, grandeur: 0.70, fray: 0.40,
    hortiNorthOf: null,
    bound: 'the Palatine. Almost entirely past the +Z edge; the frame carries its north slope.',
    outline: [
      [250, -420],
      [610, -240],
      [700, -900],
      [250, -900],
    ],
  },
  {
    id: 'regio-xi-circus-maximus',
    numeral: 'XI',
    name: 'Circus Maximus',
    e: -50, n: -450,
    minFloors: 2, maxFloors: 4, density: 0.82, grandeur: 0.14, fray: 0.35,
    hortiNorthOf: null,
    bound: 'the Velabrum and the Forum Boarium between the Capitol, the river and the '
      + 'Palatine. The frame carries its northern third.',
    outline: [
      [-200, -120],
      [0, -300],
      [250, -420],
      [250, -900],
      [-230, -900],
      ...rev(RIVER.slice(RIVER_XI, RIVER.length - 1)),
    ],
  },
  {
    id: 'regio-xiv-transtiberim',
    numeral: 'XIV',
    name: 'Transtiberim',
    e: -1400, n: 200,
    minFloors: 2, maxFloors: 4, density: 0.60, grandeur: 0.10, fray: 0.60,
    /**
     * **North of the Porta Septimiana the right bank is gardens, and that is three quarters of
     * it.**
     *
     * This row carried `null` while the far bank had no way across it, which cost nothing: the
     * only ground Regio XIV built was a 230 m ribbon off the channel and the flag would have
     * had almost nothing to classify. With `ways.ts`'s five Trans Tiberim rows authored it
     * decides the character of most of the region, so it needs a number and a reason.
     *
     * The number is the **Porta Septimiana's own northing.** Shepherd puts the gate at
     * `e −1272 / n −21` and 41.8925 N 12.4670 E puts it at `n 0`; 120 is that, rounded north
     * past the plate's own error so the quarter keeps its last block. South of it is
     * Transtiberim — the *Ripa*, the wharves, the insulae of the *Pagus Ianiculensis*. North of
     * it, in order up the bank: the **Horti Agrippinae**, the **Prata Quinctia** (Shepherd
     * labels it, and it is meadow), the **Gardens of Domitia** round the Mausoleum of Hadrian,
     * and the **Ager Vaticanus** with the Circus of Nero and its necropolis. Measured on the
     * built city, that is **20.8 of the region's 26.6 hectares of ground between street
     * lines — 78 %** — so the flag is not a fringe treatment here, it is the majority verdict
     * on the ground, and `probe-fabric` G17's burial floor had to learn to say so.
     *
     * `blockCharacter` reads it and `fabric.ts` builds those blocks at `HORTI_COVERAGE` — 8 %
     * of the ground under a roof against 60–72 % in the core — with the perimeter courtyard
     * range refused and about three times the trees. That is the difference between a garden
     * suburb and a second Campus Martius, and it is the one number in this file that decides
     * which of the two the far bank reads as.
     */
    hortiNorthOf: 120,
    bound: 'the whole right bank: Trastevere, the Janiculum and the ager Vaticanus. Its east '
      + 'edge is the modelled channel, station for station. Everything north of the Porta '
      + 'Septimiana is horti — the Horti Agrippinae, the Prata Quinctia, the Gardens of '
      + 'Domitia and the Ager Vaticanus.',
    outline: [
      ...RIVER,
      [-5200, -900],
      [-5200, 3100],
    ],
  },

  // ---- the four the frame cannot carry ------------------------------------
  {
    id: 'regio-i-porta-capena', numeral: 'I', name: 'Porta Capena',
    e: 600, n: -1200,
    minFloors: 2, maxFloors: 4, density: 0.6, grandeur: 0.3, fray: 0.4,
    hortiNorthOf: null, bound: 'off the +Z edge by 759 m.', outline: null,
  },
  {
    id: 'regio-ii-caelimontium', numeral: 'II', name: 'Caelimontium',
    e: 887, n: -667,
    minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.30, fray: 0.55,
    hortiNorthOf: null, bound: 'off the +Z edge by 226 m.', outline: null,
  },
  {
    id: 'regio-xii-piscina-publica', numeral: 'XII', name: 'Piscina Publica',
    e: 845, n: -1500,
    minFloors: 2, maxFloors: 4, density: 0.5, grandeur: 0.35, fray: 0.45,
    hortiNorthOf: null, bound: 'off the +Z edge by 1,059 m.', outline: null,
  },
  {
    id: 'regio-xiii-aventinus', numeral: 'XIII', name: 'Aventinus',
    e: -274, n: -944,
    minFloors: 2, maxFloors: 4, density: 0.56, grandeur: 0.36, fray: 0.55,
    hortiNorthOf: null, bound: 'off the +Z edge by 503 m.', outline: null,
  },
];

export interface RegionPoly {
  id: string;
  numeral: string;
  name: string;
  density: number;
  minFloors: number;
  maxFloors: number;
  grandeur: number;
  fray: number;
  hortiNorthOf: number | null;
  bound: string;
  /** The ring in **world** metres, wound so the shoelace area is positive. */
  poly: { x: number; z: number }[];
  areaM2: number;
  bb: { x0: number; x1: number; z0: number; z1: number };
}

const project = (ring: readonly (readonly [number, number])[]): { x: number; z: number }[] =>
  ring.map(([e, n]) => worldOf(e, n));

const shoelace = (p: readonly { x: number; z: number }[]): number => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const r = p[(i + 1) % p.length];
    a += q.x * r.z - r.x * q.z;
  }
  return a * 0.5;
};

/**
 * The regions with ground on this map, in world metres.
 *
 * `worldOf` is affine, so it takes a shared survey-metre vertex to a shared world-metre vertex
 * and a straight boundary to a straight boundary: the partition survives the projection
 * exactly. That is worth saying out loud because it is the reason this can be authored in the
 * frame the sources are in rather than in the frame the engine is in.
 */
export const REGIONS: readonly RegionPoly[] = REGIONES.filter((r) => r.outline !== null).map((r) => {
  const raw = project(r.outline as readonly (readonly [number, number])[]);
  const poly = shoelace(raw) < 0 ? raw.slice().reverse() : raw;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return {
    id: r.id,
    numeral: r.numeral,
    name: r.name,
    density: r.density,
    minFloors: r.minFloors,
    maxFloors: r.maxFloors,
    grandeur: r.grandeur,
    fray: r.fray,
    hortiNorthOf: r.hortiNorthOf,
    bound: r.bound,
    poly,
    areaM2: Math.abs(shoelace(poly)),
    bb: { x0, x1, z0, z1 },
  };
});

/** Rows with no ground on this map, by name, for the report and for `assertRegionPartition`. */
export const OFF_FRAME_REGIONES: readonly RegioSpec[] = REGIONES.filter((r) => r.outline === null);

const inRing = (p: readonly { x: number; z: number }[], x: number, z: number): boolean => {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i];
    const b = p[j];
    if (a.z > z !== b.z > z) {
      const t = (z - a.z) / (b.z - a.z);
      if (x < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
};

let fallbacks = 0;

/**
 * Which *regio* a point is in. Total: every point of the frame is in exactly one.
 *
 * The fallback is the nearest ring by squared distance to its vertices, and it exists only for
 * a point that lands exactly on a shared edge where both crossing tests round the same way.
 * `regionFallbacks()` counts them so that a fallback firing thousands of times — which would
 * mean the tiling has a hole — is a number somebody can see rather than a silent default.
 */
export function regionAt(x: number, z: number): RegionPoly {
  for (const r of REGIONS) {
    if (x < r.bb.x0 || x > r.bb.x1 || z < r.bb.z0 || z > r.bb.z1) continue;
    if (inRing(r.poly, x, z)) return r;
  }
  fallbacks++;
  let best = REGIONS[0];
  let bd = Infinity;
  for (const r of REGIONS) {
    for (const p of r.poly) {
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
  }
  return best;
}

export const regionFallbacks = (): number => fallbacks;

/**
 * World `z` back to survey northing. `worldOf` is `z = Z0 − KZ·n`, so this is its inverse on
 * one axis, derived from two calls to `worldOf` rather than from a second copy of `Z0` and
 * `KZ` — `MAP-METHOD.md` rule 11 is about two producers each holding their own copy of the
 * same constant.
 */
const Z_AT_0 = worldOf(0, 0).z;
const Z_PER_N = worldOf(0, 1).z - Z_AT_0;
export const surveyNorthingOf = (z: number): number => (z - Z_AT_0) / Z_PER_N;

/**
 * **Does the authored table actually tile?** The check the rectangles could never have passed.
 *
 * Every undirected edge of the ten rings must appear exactly twice and in opposite directions
 * (an internal boundary) or exactly once (the outer frame). Once is a hole between two
 * regions; three times is a fold; twice in the same direction means one of the two rings is
 * wound backwards and the "shared" edge is not shared at all. All three are authoring
 * mistakes that a coverage statistic would report as a small number rather than as a fault.
 *
 * It also asserts the four off-frame rows really are off the frame, so the exclusion is a
 * measurement and not a category — `MAP-METHOD.md` rule 16.
 */
export function assertRegionPartition(): {
  ok: boolean;
  regions: number;
  offFrame: string[];
  danglingEdges: number;
  foldedEdges: number;
  sameDirectionEdges: number;
  offFrameOnFrame: string[];
  frameCovered: boolean;
} {
  const seen = new Map<string, number[]>();
  for (let i = 0; i < REGIONS.length; i++) {
    const ring = REGIONS[i].poly;
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % ring.length];
      const ka = `${Math.round(a.x * 100)},${Math.round(a.z * 100)}`;
      const kb = `${Math.round(b.x * 100)},${Math.round(b.z * 100)}`;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const dir = ka < kb ? 1 : -1;
      const list = seen.get(k);
      if (list) list.push(dir);
      else seen.set(k, [dir]);
    }
  }
  let dangling = 0;
  let folded = 0;
  let sameDir = 0;
  for (const list of seen.values()) {
    if (list.length === 1) dangling++;
    else if (list.length > 2) folded++;
    else if (list[0] === list[1]) sameDir++;
  }
  // A dangling edge on the authoring frame is correct: the frame has one side. Count only the
  // ones that are not on it, in world metres.
  const frame = REGIONS.reduce(
    (b, r) => ({
      x0: Math.min(b.x0, r.bb.x0), x1: Math.max(b.x1, r.bb.x1),
      z0: Math.min(b.z0, r.bb.z0), z1: Math.max(b.z1, r.bb.z1),
    }),
    { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  );
  let interiorDangling = 0;
  for (const [k, list] of seen) {
    if (list.length !== 1) continue;
    const [ka, kb] = k.split('|');
    const [axs, azs] = ka.split(',');
    const [bxs, bzs] = kb.split(',');
    const ax = Number(axs) / 100;
    const az = Number(azs) / 100;
    const bx = Number(bxs) / 100;
    const bz = Number(bzs) / 100;
    const onFrame =
      (Math.abs(ax - frame.x0) < 1 && Math.abs(bx - frame.x0) < 1) ||
      (Math.abs(ax - frame.x1) < 1 && Math.abs(bx - frame.x1) < 1) ||
      (Math.abs(az - frame.z0) < 1 && Math.abs(bz - frame.z0) < 1) ||
      (Math.abs(az - frame.z1) < 1 && Math.abs(bz - frame.z1) < 1);
    if (!onFrame) interiorDangling++;
  }
  const offFrameOnFrame = OFF_FRAME_REGIONES.filter((r) => {
    const w = worldOf(r.e, r.n);
    return Math.abs(w.x) <= HALF_EXTENT && Math.abs(w.z) <= HALF_EXTENT;
  }).map((r) => `${r.numeral} ${r.name}`);
  /*
   * The union has to contain every point a region could be held responsible for, or that
   * point belongs to nobody and `probe-fabric` G19's coverage falls below 1.00. That is the
   * battlefield's full width and everything from well north of the wall crest to the +Z edge:
   * the glacis outside the curtain is not a region's job, and 300 is 170 m north of the
   * lowest crest on the circuit, so the bound is stated in world metres rather than assumed.
   */
  const frameCovered =
    frame.x0 <= -HALF_EXTENT && frame.x1 >= HALF_EXTENT &&
    frame.z0 <= 300 && frame.z1 >= HALF_EXTENT;
  return {
    ok: interiorDangling === 0 && folded === 0 && sameDir === 0
      && offFrameOnFrame.length === 0 && frameCovered,
    regions: REGIONS.length,
    offFrame: OFF_FRAME_REGIONES.map((r) => `${r.numeral} ${r.name}`),
    danglingEdges: interiorDangling,
    foldedEdges: folded,
    sameDirectionEdges: sameDir,
    offFrameOnFrame,
    frameCovered,
  };
}
