import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { crestZAt, RIVER_HALF_WIDTH, riverCentreX, roadCentreX } from '../terrain/topography';
import { clamp, lerp } from '../util/math';

/**
 * The plan of Rome, 271 AD, expressed in battlefield coordinates.
 *
 * −Z is north (the Juthungi), +Z is the city. The battlefield proper occupies
 * z < 250 and must stay clear.
 *
 * **The wall line is not a constant.** It is read from the terrain's own
 * `crestZAt(x)`, which wanders between z ≈ 427 and z ≈ 583 as the Pincian and
 * Quirinal shoulders come and go, and dips into a saddle where the Via Flaminia
 * climbs through. Everything else in the plan is authored against a nominal
 * reference line and then mapped behind the real crest by `applyTopography()`, so a
 * change to the heightfield moves the whole city rather than breaking it.
 *
 * **Compression.** Real Rome from the Porta Flaminia to the Colosseum is about 3 km
 * and the terrain only reaches z = 1400, so positions are compressed by roughly 3.9×
 * in depth and 2× across while every *building* stays at true scale. That is the trick
 * a Total War campaign map plays, and it preserves the thing that matters: the relative
 * arrangement of the landmarks and the silhouette they make from the north.
 */

/**
 * West end of the circuit. The Tiber crosses the crest line near x = −687, and the
 * historical wall terminated at the river with a tower rather than running masonry
 * into water, so the westernmost bay sits just clear of the bank.
 */
export const WALL_X_MIN = Math.round(riverCentreX(crestZAt(-660)) + RIVER_HALF_WIDTH + 8);
/** East end: far enough to carry the eye off the frame, inside the heightfield. */
export const WALL_X_MAX = 1150;
export const WALL_LENGTH = WALL_X_MAX - WALL_X_MIN;

/** Wall-line helper, straight from the terrain contract. */
export const wallCrestZ = (x: number): number => crestZAt(clamp(x, -HALF_EXTENT, HALF_EXTENT));

/**
 * Aurelian Wall dimensions, first phase (AD 271–275).
 *
 * Height 6.5 m to the wall-walk and 3.5 m thick: Richmond, *The City Wall of
 * Imperial Rome* (1930), measuring the surviving Aurelianic core before Maxentius
 * doubled the height. Tower spacing is one *actus* — 120 Roman *pedes* of 0.296 m,
 * so 35.5 m (parts of the circuit run at 100 pedes, 29.6 m).
 */
export const WALL = {
  height: 6.5,
  thickness: 3.5,
  /** Travertine/tufa footing course below the brick face. */
  plinthHeight: 1.35,
  plinthProject: 0.42,
  /** Crenellated parapet on the outer lip of the walkway. */
  parapetHeight: 2.05,
  parapetThickness: 0.9,
  /** Face batter: Roman curtains lean back about 1 in 30. */
  batter: 0.032,
  towerSpacing: 35.5,
  /** Blind arched recesses in the inner face, an Aurelianic economy measure. */
  innerArchSpacing: 6.4,
  /** Towers are square, project 3.5 m beyond the outer face, and stand 7.5 m wide. */
  towerWidth: 7.6,
  towerProject: 3.5,
  /** Ballista chamber rises one storey above the walkway. */
  towerChamberHeight: 5.0,
  towerRoofHeight: 2.3,
  /** Height of one *opus testaceum* band between tile string courses. */
  courseBand: 1.1,
} as const;

/**
 * The gate sits where the Via Flaminia crosses the crest — which is also the saddle
 * the terrain cuts for it. Solved by fixed-point iteration on
 * `x = roadCentreX(crestZAt(x))`; three passes converge to a tenth of a metre.
 */
export const GATE_X = (() => {
  let x = 20;
  for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x));
  return Math.round(x * 10) / 10;
})();
/** Clear width of the Porta Flaminia carriageway. */
export const GATE_OPEN_WIDTH = 4.3;

export interface LandmarkPlacement {
  id: string;
  /** Display name, used in the returned API and for debugging. */
  name: string;
  x: number;
  z: number;
  /** Plan rotation, radians. 0 means the long axis runs east–west. */
  rot: number;
  /** Keep-out radius so insulae never grow inside a monument. */
  clear: number;
  /** Artificial hill / podium height above sampled terrain, if any. */
  mound?: number;
  moundRadius?: number;
}

/**
 * Landmark positions. Depth ordering follows the real city walking south from the
 * Porta Flaminia: Campus Martius, then the Capitol and Forum, then the Colosseum
 * valley and the Circus Maximus.
 */
export const LANDMARKS: LandmarkPlacement[] = [
  // Northern Campus Martius: the first thing you see over the wall.
  { id: 'mausoleum-augustus', name: 'Mausoleum of Augustus', x: -196, z: 470, rot: 0, clear: 66 },
  { id: 'ara-pacis', name: 'Ara Pacis Augustae', x: -118, z: 498, rot: 0.06, clear: 20 },
  { id: 'horologium', name: 'Horologium of Augustus', x: -74, z: 528, rot: 0, clear: 16 },
  { id: 'stadium-domitian', name: 'Stadium of Domitian', x: -286, z: 648, rot: Math.PI / 2, clear: 74 },
  { id: 'pantheon', name: 'Pantheon', x: -176, z: 742, rot: 0, clear: 52 },
  { id: 'baths-agrippa', name: 'Baths of Agrippa', x: -104, z: 786, rot: 0, clear: 46 },
  { id: 'theatre-pompey', name: 'Theatre of Pompey', x: -408, z: 800, rot: 0.08, clear: 84 },
  { id: 'temple-isis', name: 'Temple of Isis Campensis', x: -46, z: 760, rot: 0, clear: 26 },
  { id: 'theatre-marcellus', name: 'Theatre of Marcellus', x: -352, z: 948, rot: -0.2, clear: 62 },
  // The Capitol: raised on its own podium mound because the terrain is smooth here.
  {
    id: 'temple-jupiter',
    name: 'Temple of Jupiter Optimus Maximus',
    x: -196,
    z: 1002,
    rot: 0.04,
    clear: 76,
    mound: 22,
    moundRadius: 118,
  },
  { id: 'trajan-column', name: "Trajan's Column", x: -66, z: 968, rot: 0, clear: 14 },
  { id: 'basilica-ulpia', name: 'Basilica Ulpia', x: -48, z: 1002, rot: 0, clear: 54 },
  { id: 'forum-romanum', name: 'Forum Romanum', x: -132, z: 1076, rot: 0.1, clear: 62 },
  { id: 'colosseum', name: 'Flavian Amphitheatre', x: 176, z: 1178, rot: 0.18, clear: 118 },
  { id: 'palatine', name: 'Palatine Palaces', x: -74, z: 1170, rot: 0, clear: 96, mound: 26, moundRadius: 138 },
  { id: 'circus-maximus', name: 'Circus Maximus', x: -302, z: 1216, rot: 0.14, clear: 130 },
  { id: 'baths-trajan', name: 'Baths of Trajan', x: 388, z: 1114, rot: 0.05, clear: 96 },
  // Eastern hills.
  { id: 'castra-praetoria', name: 'Castra Praetoria', x: 726, z: 452, rot: 0.04, clear: 138 },
  { id: 'gardens-sallust', name: 'Horti Sallustiani', x: 296, z: 430, rot: 0, clear: 60 },
  { id: 'temple-serapis', name: 'Temple of Serapis (Quirinal)', x: 128, z: 690, rot: 0.05, clear: 40 },
  // Across the Tiber: the Janiculum ridge closes the western view.
  { id: 'janiculum', name: 'Janiculum Ridge', x: -1010, z: 900, rot: 0, clear: 150, mound: 44, moundRadius: 240 },
];

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
 * Aqueduct arcades. Long lines of arches are the most evocative thing in the Roman
 * landscape and cost almost nothing to build from one repeated module.
 *
 * The Aqua Virgo crossed the Campus Martius on a low arcade to reach the Baths of
 * Agrippa; the Aqua Claudia marched in on 28 m arches, the tallest in the city.
 */
export const AQUEDUCTS: AqueductRun[] = [
  {
    id: 'aqua-virgo',
    name: 'Aqua Virgo',
    path: [
      { x: 940, z: 560 },
      { x: 520, z: 586 },
      { x: 120, z: 606 },
      { x: -110, z: 640 },
    ],
    height: 11.5,
    bayWidth: 7.4,
    pierWidth: 2.1,
  },
  {
    id: 'aqua-claudia',
    name: 'Aqua Claudia',
    path: [
      { x: 1340, z: 1042 },
      { x: 900, z: 1016 },
      { x: 560, z: 1030 },
      { x: 402, z: 1064 },
    ],
    // 28 m at its tallest, on piers about 2.4 m wide with 5.5 m spans.
    height: 27.5,
    bayWidth: 8.0,
    pierWidth: 2.5,
  },
  {
    id: 'aqua-marcia',
    name: 'Aqua Marcia',
    path: [
      { x: 1330, z: 690 },
      { x: 1020, z: 660 },
      { x: 830, z: 636 },
    ],
    height: 16,
    bayWidth: 7.6,
    pierWidth: 2.2,
  },
];

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
}

/**
 * Insula districts. The Campus Martius blocks are the densest and tallest; the
 * Quirinal and the far bank are lower and looser. Districts overlap landmark
 * keep-outs freely — the generator rejects footprints that collide.
 */
export const DISTRICTS: DistrictSpec[] = [
  { id: 'porta-flaminia', x: -30, z: 392, hw: 290, hd: 60, rot: 0.02, minFloors: 2, maxFloors: 4, density: 0.8, grandeur: 0.1 },
  { id: 'campus-nw', x: -470, z: 424, hw: 210, hd: 72, rot: 0.03, minFloors: 2, maxFloors: 4, density: 0.78, grandeur: 0.12 },
  { id: 'campus-north', x: -230, z: 556, hw: 270, hd: 104, rot: 0.03, minFloors: 3, maxFloors: 5, density: 0.88, grandeur: 0.18 },
  { id: 'campus-mid', x: -190, z: 720, hw: 270, hd: 106, rot: -0.02, minFloors: 3, maxFloors: 5, density: 0.9, grandeur: 0.22 },
  { id: 'campus-south', x: -250, z: 880, hw: 250, hd: 90, rot: 0.05, minFloors: 3, maxFloors: 5, density: 0.88, grandeur: 0.2 },
  { id: 'via-lata', x: 60, z: 548, hw: 170, hd: 130, rot: 0, minFloors: 3, maxFloors: 5, density: 0.82, grandeur: 0.14 },
  { id: 'quirinal', x: 300, z: 590, hw: 220, hd: 130, rot: 0.04, minFloors: 2, maxFloors: 4, density: 0.7, grandeur: 0.3 },
  { id: 'viminal', x: 520, z: 780, hw: 230, hd: 140, rot: -0.03, minFloors: 2, maxFloors: 4, density: 0.68, grandeur: 0.2 },
  { id: 'esquiline', x: 600, z: 1010, hw: 250, hd: 130, rot: 0.02, minFloors: 2, maxFloors: 4, density: 0.62, grandeur: 0.26 },
  { id: 'subura', x: 90, z: 880, hw: 170, hd: 110, rot: 0.03, minFloors: 4, maxFloors: 5, density: 0.94, grandeur: 0.05 },
  { id: 'forum-east', x: 60, z: 1090, hw: 150, hd: 90, rot: 0, minFloors: 3, maxFloors: 4, density: 0.78, grandeur: 0.34 },
  { id: 'caelian', x: 210, z: 1310, hw: 240, hd: 80, rot: 0.02, minFloors: 2, maxFloors: 4, density: 0.6, grandeur: 0.24 },
  { id: 'aventine', x: -430, z: 1300, hw: 200, hd: 80, rot: 0.03, minFloors: 2, maxFloors: 4, density: 0.58, grandeur: 0.32 },
  { id: 'trastevere', x: -930, z: 640, hw: 150, hd: 190, rot: 0.02, minFloors: 2, maxFloors: 4, density: 0.72, grandeur: 0.08 },
  { id: 'vaticanus', x: -1050, z: 340, hw: 190, hd: 90, rot: 0.02, minFloors: 1, maxFloors: 3, density: 0.42, grandeur: 0.2 },
  { id: 'east-suburb', x: 960, z: 700, hw: 200, hd: 180, rot: 0.02, minFloors: 1, maxFloors: 3, density: 0.5, grandeur: 0.12 },
];

export interface StreetSpec {
  id: string;
  path: { x: number; z: number }[];
  width: number;
  /** Paved with polygonal basalt (true) or beaten earth (false). */
  paved: boolean;
}

/**
 * The streets that matter to the silhouette and to the keep-out map. The Via Lata
 * (the urban continuation of the Via Flaminia, today's Corso) runs dead straight
 * south from the gate; everything else grows off it.
 */
export const STREETS: StreetSpec[] = [
  {
    id: 'via-lata',
    path: [
      { x: GATE_X, z: 336 },
      { x: GATE_X - 4, z: 520 },
      { x: GATE_X - 14, z: 780 },
      { x: -40, z: 980 },
      { x: -96, z: 1080 },
    ],
    width: 9,
    paved: true,
  },
  {
    id: 'via-recta',
    path: [
      { x: -620, z: 700 },
      { x: -300, z: 690 },
      { x: -40, z: 700 },
      { x: 260, z: 686 },
      { x: 700, z: 660 },
    ],
    width: 8,
    paved: true,
  },
  {
    id: 'vicus-salutis',
    path: [
      { x: 210, z: 340 },
      { x: 250, z: 560 },
      { x: 300, z: 820 },
      { x: 330, z: 1060 },
    ],
    width: 7,
    paved: true,
  },
  {
    id: 'via-sacra',
    path: [
      { x: -150, z: 1064 },
      { x: -20, z: 1120 },
      { x: 120, z: 1160 },
    ],
    width: 8,
    paved: true,
  },
  {
    id: 'via-tecta',
    path: [
      { x: -430, z: 470 },
      { x: -300, z: 600 },
      { x: -230, z: 800 },
      { x: -280, z: 1010 },
    ],
    width: 7,
    paved: true,
  },
  {
    id: 'vicus-portae',
    path: [
      { x: -520, z: 380 },
      { x: -180, z: 372 },
      { x: 180, z: 366 },
      { x: 560, z: 380 },
    ],
    width: 8,
    paved: true,
  },
];

/**
 * Map the nominal plan onto the real hill.
 *
 * Everything above is authored against a reference wall at z = 322 and a gate on the
 * x = 0 axis, which is how the plan was laid out. The terrain then put the crest 200 m
 * further south, gave it a 150 m wobble and moved the road saddle to x ≈ 72. Rather
 * than re-typing two hundred coordinates, remap them once at module load:
 *
 *  - shift and gently compress z so the deepest monument still fits inside the
 *    heightfield,
 *  - slide x with the gate so the Via Flaminia axis stays the spine of the city,
 *  - and push anything that would end up on the *slope* back onto the plateau behind
 *    the local crest.
 *
 * Deterministic, runs once, and the whole city follows the next heightfield rewrite.
 */
const PLAN_REF_WALL_Z = 322;
const PLAN_REF_DEEPEST_Z = 1320;

function applyTopography(): void {
  // Compress so the deepest thing in the plan lands just inside the heightfield, using
  // the *highest* the crest gets as the worst case.
  let crestMax = 0;
  for (let x = WALL_X_MIN; x <= WALL_X_MAX; x += 25) crestMax = Math.max(crestMax, crestZAt(x));
  const scale = clamp((HALF_EXTENT - 60 - crestMax - 40) / (PLAN_REF_DEEPEST_Z - PLAN_REF_WALL_Z), 0.4, 1.0);
  const mapX = (x: number): number => x + GATE_X * 0.6;
  // Depth is measured from the local crest, so the fabric hugs the wall along its whole
  // length instead of leaving a field wherever the hill front runs further north.
  const mapZ = (x: number, z: number, clearR: number): number =>
    wallCrestZ(x) + 30 + clearR * 0.45 + (z - PLAN_REF_WALL_Z) * scale;

  for (const l of LANDMARKS) {
    l.x = mapX(l.x);
    l.z = mapZ(l.x, l.z, l.clear);
  }
  for (const d of DISTRICTS) {
    d.x = mapX(d.x);
    d.hd = Math.max(30, d.hd * Math.max(scale, 0.72));
    d.z = mapZ(d.x, d.z, d.hd);
  }
  for (const st of STREETS) {
    for (const p of st.path) {
      p.x = mapX(p.x);
      p.z = Math.max(mapZ(p.x, p.z, 0), wallCrestZ(p.x) + 6);
    }
  }
  for (const aq of AQUEDUCTS) {
    for (const p of aq.path) {
      p.x = mapX(p.x);
      p.z = mapZ(p.x, p.z, 30);
    }
  }
  // The Via Lata leaves the gate on the road's own centreline.
  const lata = STREETS.find((s) => s.id === 'via-lata');
  if (lata) {
    lata.path[0] = { x: GATE_X, z: crestZAt(GATE_X) + 10 };
    for (let i = 1; i < lata.path.length; i++) {
      lata.path[i].x = lerp(GATE_X, lata.path[i].x, Math.min(1, i / 2));
    }
  }
}
applyTopography();

/** Rectangular keep-out, used for landmarks and street corridors. */
export interface KeepOutCircle {
  x: number;
  z: number;
  r: number;
}

/** Collision map so procedural insulae never grow through a monument or a street. */
export class KeepOut {
  private circles: KeepOutCircle[] = [];
  private segs: { x1: number; z1: number; x2: number; z2: number; halfW: number }[] = [];

  addCircle(x: number, z: number, r: number): void {
    this.circles.push({ x, z, r });
  }

  addPath(path: { x: number; z: number }[], halfW: number): void {
    for (let i = 0; i + 1 < path.length; i++) {
      this.segs.push({ x1: path[i].x, z1: path[i].z, x2: path[i + 1].x, z2: path[i + 1].z, halfW });
    }
  }

  /** True when a disc of radius `r` at (x,z) intersects anything reserved. */
  blocked(x: number, z: number, r: number): boolean {
    for (const c of this.circles) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = c.r + r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    for (const s of this.segs) {
      const ax = s.x2 - s.x1;
      const az = s.z2 - s.z1;
      const len2 = ax * ax + az * az;
      const t = len2 < 1e-6 ? 0 : clamp(((x - s.x1) * ax + (z - s.z1) * az) / len2, 0, 1);
      const px = s.x1 + ax * t;
      const pz = s.z1 + az * t;
      const dx = x - px;
      const dz = z - pz;
      const rr = s.halfW + r;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }
}

export interface WallNode {
  x: number;
  z: number;
  /** Terrain height at the node. */
  ground: number;
}

/**
 * Sample the wall line. Real fortification practice puts the curtain on the crest, and
 * the terrain publishes exactly that line, so there is nothing to search for: follow
 * `crestZAt` and let the wall wander the 150 m in plan that it wants to.
 */
export function fitWallPath(heightAt: (x: number, z: number) => number, spacing = 55): WallNode[] {
  const n = Math.round(WALL_LENGTH / spacing) + 1;
  const out: WallNode[] = [];
  for (let i = 0; i < n; i++) {
    const x = WALL_X_MIN + (i * WALL_LENGTH) / (n - 1);
    const z = wallCrestZ(x);
    out.push({ x, z, ground: heightAt(x, z) });
  }
  return out;
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

export function bayStage(bayIndex: number, bayCount: number, gateBay: number): BayStage {
  // Only the gate itself and its immediate flanks were finished first; everything else
  // in 271 is somewhere between a trench and a parapet. The stages are placed close to
  // the gate on purpose, so the construction story lands in the frames that matter.
  const k = bayIndex - gateBay;
  if (k === 0 || k === 1 || k === -1) return 'finished';
  if (k === 3 || k === 4) return 'half-built';
  if (k === -3 || k === -4 || k === -5) return 'no-parapet';
  if (k === 7) return 'gap';
  if (k === 8 || k === 9) return 'footing';
  if (k === -9 || k === -10) return 'half-built';
  if (k === 13 || k === -14) return 'no-parapet';
  if (k === 17 || k === 18) return 'half-built';
  if (k === -18) return 'footing';
  void bayCount;
  return 'finished';
}
