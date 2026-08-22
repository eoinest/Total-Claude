#!/usr/bin/env node
/**
 * probe-plan — **does the city stand where the plate says it stands?**
 *
 * `tools/probe-fabric.mjs` states its own blind spot in its header and `docs/MAP-METHOD.md` §3
 * records it: *"it can prove a footprint is the wrong SIZE and it cannot prove it is in the wrong
 * PLACE."* This file is the instrument for place. It reads the built city back out of a running
 * page, puts it in the **georeferenced plate's own pixel frame**, emits an aligned pair and an
 * overlay, and prints a **ranked list of divergences in metres**. A vision model is optional and
 * never decides anything.
 *
 * The owner found four faults in `02-engine-plan-after.png` by eye in under a minute, after a
 * 21-check gate had passed the map:
 *
 *   1. the Tiber's bend around the Campus Martius looks inverted;
 *   2. buildings standing in the river (60 of 1,259 measured, and nothing checked for it);
 *   3. buildings in the middle of roads (measured by `probe-fabric`, invisible in its table);
 *   4. the plan diverging from the real thing (`resolveOverlaps`).
 *
 * All four are gated here and all four come out as numbers.
 *
 * ============================================================================
 * 1. THE FRAME, WHICH IS THE WHOLE ARGUMENT
 * ============================================================================
 *
 * **A plan drawn in world coordinates cannot be compared with a plan of Rome, and the engine's
 * own plan view is drawn in world coordinates.** Rome's projection is *anisotropic*: east/west is
 * compressed by `KX` = 0.443 and north/south by `KZ` = 0.222, so `KX / KZ` = 1.995. The engine's
 * overhead view is therefore Rome squashed twice as hard along one axis as the other, and a
 * bearing in it can be wrong by up to 26.6°. Judging "the river bends the wrong way" off that
 * picture is judging the projection, not the city — which is why the first thing this file does
 * is leave that frame.
 *
 * Everything here is in **survey metres**: real metres east/north of the Temple of Jupiter
 * Optimus Maximus, 41.8925 N 12.4823 E. That is the frame `src/city/rome/survey.ts` is authored
 * in and the frame the plate is georeferenced into. Two consequences, stated up front because
 * they bound what the instrument may claim:
 *
 *  - **Position is comparable.** Un-projecting a built centre through `worldOf⁻¹` puts it back in
 *    real metres, where the plate grades it. Every gated quantity below is a position, a bearing,
 *    a count, or an area.
 *  - **Shape is NOT comparable in this frame, and no care fixes that.** Footprints are scaled
 *    *isotropically* by `PLAN_SCALE` while positions compress *anisotropically*, so un-projecting
 *    a footprint stretches it by `KX / KZ` ≈ 2.00 north-south. A perfectly built Rome would still
 *    fail a shape comparison against the plate in this frame. Size and aspect belong to
 *    `probe-fabric`'s G12/G13, which measure them in world metres against published dimensions.
 *    **That file measures size; this one measures place.** Between them the blind spot is closed.
 *
 * Intersection tests — a block in the river, a block in a carriageway — are computed in **world**
 * metres where they are exact, because an affine map preserves intersection, and then *drawn* in
 * survey metres so the picture and the number agree.
 *
 * ============================================================================
 * 2. WHAT IT COMPARES AGAINST, AND WHY THAT IS OUTSIDE THE THING BEING CHECKED
 * ============================================================================
 *
 * `docs/MAP-METHOD.md` rule 6. Five rulers, none of them the layout's own intentions:
 *
 *  1. **The georeferenced Lanciani raster**, EPSG:3004, 4096 × 2734 px over a stated ground
 *     extent, read as pixels and segmented by colour. The Tiber on that plate is drawn as a pair
 *     of blue-green bank lines with paper-coloured water between them; this file finds them,
 *     tracks the channel down the sheet and produces a **plate-derived Tiber centreline in survey
 *     metres** without consulting one engine value. `MAP-METHOD.md` §3 recorded that the plates
 *     could not be a machine ruler because the vector plate carries no monument names. That is
 *     true of *names*. It is not true of *water*, and nobody had tried.
 *  2. **The plate's own filename and `ASSETS.md`**, which carry the ground extent in EPSG:3004
 *     metres. That gives a scale and a rotation computed from the projection's definition,
 *     against which `src/city/overlay.ts`'s fitted affine is *checked* rather than trusted. §3.
 *  3. **Geometry read back from the live scene.** The city's drawn `BufferGeometry` is rasterised
 *     *in the page* straight into the plate's pixel grid, so the render this file compares against
 *     the plate is made of the vertices the player sees and not of the plan that produced them.
 *  4. **The terrain**, asked for the ground height under every footprint corner, plus the
 *     channel's own offset function — two independent water tests, because either alone can be
 *     fooled (a dry ledge inside the channel; a flooded hollow outside it).
 *  5. **A vision model**, for the one thing it is better at than code: *locating* a named thing on
 *     an inked plate and reading the sense of a curve. Its answers are never the verdict. §4.
 *
 * ============================================================================
 * 3. THE ALIGNMENT, AND ITS RESIDUAL
 * ============================================================================
 *
 * `src/city/overlay.ts:LANCIANI_1901` carries a 6-parameter affine from plate pixels to survey
 * metres, fitted against a full inverse of EPSG:3004 over a 13 × 13 grid to a worst residual of
 * 1.26 m over 7 km (`ASSETS.md` §8). It is **restated** in `PLATES` below rather than imported,
 * because this is an instrument and that constant is one of the things it grades. A disagreement
 * between the two is a fault in whichever moved.
 *
 * The quoted 1.26 m is the affine's residual *against its own EPSG inverse*. That is not an
 * end-to-end residual, and `ALIGN` below computes the end-to-end one analytically: the plate's
 * ground extent gives grid metres per pixel; the point scale factor of EPSG:3004 at the plate
 * centre converts that to ground metres; the grid convergence γ = atan(tan Δλ · sin φ) gives the
 * angle from grid north to true north. Both are compared with the affine's own scale and rotation
 * and the disagreement is reported **in metres at the plate edge**. It is not zero, and the reason
 * is worth knowing: an ENU "metre" depends on which earth radius the survey used, and 0.15 % there
 * is 5 m at 3.5 km. Every threshold in this file is an order of magnitude above that. Stating it
 * is the point — a tool with a known resolution limit is useful and one that pretends to a
 * precision it lacks is worse than none.
 *
 * ============================================================================
 * 4. HOW THE VISION MODEL IS USED, AND WHY IT CANNOT PASS THE GATE
 * ============================================================================
 *
 * **A vision model saying "looks close" is not a measurement.** The verdict is computed by the
 * deterministic battery in §5 and by nothing else: the same commit and the same plate give the
 * same `n/N` whether `--vlm` is on or off. The model's job is to *nominate* and to *corroborate*,
 * and every question put to it has a machine-checkable answer:
 *
 *   V1  at five named survey latitudes, is the render's river east or west of the plate's?
 *   V2  over the Campus Martius reach, which side is the river's convex side, on each image?
 *   V3  how many building blocks in the render overlap the water? give the three clearest.
 *   V4  how many building blocks in the render overlap a carriageway? give the three clearest.
 *   V5  on the plate alone, where is <named monument>? (one call per monument, on a crop)
 *   V6  how many distinct roads leave the marked gate, on each image?
 *   V7  one deliberately open question, filed UNQUANTIFIED and never gated.
 *
 * Each answer is printed beside the measured value with `agree` / `disagree`. **A disagreement is
 * a finding about the instrument, not about the city.** V1/V2/V6 are ordinal or nominal on
 * purpose: a model that cannot tell 20 m of offset from 40 m can still tell east from west, and
 * `--ladder` measures where even that breaks.
 *
 * ============================================================================
 * 5. THE GATE
 * ============================================================================
 *
 *   P1  no solid stands in the river                          (the check probe-fabric lacks)
 *   P2  no solid stands in a carriageway                      (area, and drawn)
 *   P3  monument displacement off its surveyed position       (mean and worst, real metres)
 *   P4  the river's centreline agrees with the plate's        (band by band, real metres)
 *   P5  the river's curvature has the plate's SIGN            (over the Campus Martius reach)
 *   P6  the road network leaves each gate the plate's way count
 *   P7  gross registration: the built city's centroid and extent sit on the plate's city
 *
 * P7 exists so that a 200 m shove or a mirror cannot pass by breaking every other check into
 * silence. `docs/MAP-METHOD.md` §3 carries the measured ladder.
 *
 * ============================================================================
 * 6. PROVING IT CAN FAIL
 * ============================================================================
 *
 * `--offset=E,N` shoves the whole built city by that many **real** metres after read-back and
 * `--mirror` reflects it about the survey meridian. Neither touches the simulation: the shove is
 * applied to numbers this file has already read out of the page, which is the only way to perturb
 * a render without moving a determinism pin. `--ladder` reads the page once and then re-measures
 * at a series of offsets, reporting the smallest one each check notices. That is this instrument's
 * resolution, measured rather than asserted.
 *
 * ---------------------------------------------------------------------------
 *   node tools/probe-plan.mjs --port=5931                     # measure, no model
 *   node tools/probe-plan.mjs --port=5931 --vlm=claude        # measure and interrogate
 *   node tools/probe-plan.mjs --port=5931 --offset=200,0      # the negative control
 *   node tools/probe-plan.mjs --port=5931 --ladder            # the resolution ladder
 *   node tools/probe-plan.mjs --only=plate                    # plate side only, no boot
 * ---------------------------------------------------------------------------
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), '1'] : [a.slice(2, i), a.slice(i + 1)];
  })
);
const arg = (k, d) => (args.has(k) ? args.get(k) : d);
const PORT = Number(arg('port', 5931));
const MAP = arg('map', 'campus-martius');
const TIER = arg('quality', 'high');
const PLATE_ID = arg('plate', 'lanciani');
const OUT = path.resolve(ROOT, arg('out', 'screenshots/probe-plan'));
const ONLY = arg('only', 'all');
const VLM = arg('vlm', 'none');
const VLM_MODEL = arg('model', '');
const LADDER = args.has('ladder');
const MIRROR = args.has('mirror');
const TAG = arg('tag', MIRROR ? 'mirror' : args.has('offset') ? `off${arg('offset', '')}` : 'now');
const OFFSET = (() => {
  const s = arg('offset', null);
  if (!s) return { e: 0, n: 0 };
  const p = s.split(',').map(Number);
  return { e: p[0] || 0, n: p[1] || 0 };
})();

if (PORT === 5173) {
  console.error("[probe-plan] 5173 is the owner's dev server. Pass a port in the 5900s.");
  process.exit(2);
}

// ===========================================================================
// Where the plates live.
//
// `reference/` is gitignored local-only material, so it exists in the main
// checkout and in NO worktree — `git worktree add` does not copy untracked
// files. Two agents have now looked, found nothing, and written "the plates do
// not exist" into a header comment. This resolves it from the git COMMON dir
// instead of asking anyone to symlink it, because a symlink named `reference`
// is NOT matched by the `reference/` line in .gitignore — a trailing slash
// matches a directory and not a symlink to one — and `git add -A` would sweep
// it into a commit. That is the exact trap the .gitignore's own node_modules
// comment documents, sprung twice already by two different agents.
// ===========================================================================
const referenceRoot = () => {
  if (process.env.TC_REFERENCE_DIR) return process.env.TC_REFERENCE_DIR;
  const here = path.join(ROOT, 'reference');
  if (existsSync(here)) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8',
    }).trim();
    const cand = path.join(path.dirname(common), 'reference');
    if (existsSync(cand)) return cand;
  } catch { /* not a repo, or no git on PATH */ }
  return null;
};
const REF = referenceRoot();

// ===========================================================================
// The plates. The affine is RESTATED from `src/city/overlay.ts:LANCIANI_1901`,
// not imported: that constant is one of the things this file grades, and an
// instrument that borrows the defendant's ruler restates the defendant's answer.
//
// `extent3004` is the WMS `GetMap` bbox recorded in `ASSETS.md` §5 / §8 — the
// second, independent description of the same geometry, used by `ALIGN` below.
// ===========================================================================
const PLATES = {
  lanciani: {
    id: 'lanciani',
    file: 'rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
    name: 'Lanciani, Forma Urbis Romae (1893-1901), georectified by SITAR/SSABAP-RM',
    widthPx: 4096, heightPx: 2734,
    extent3004: { e0: 2307658.1627, n0: 4638582.868607, e1: 2314671.3719, n1: 4643263.3909 },
    ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
    nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
    /**
     * The Tiber on this plate is NOT a filled blue band, which is the thing that
     * makes a naive colour segmentation return nothing and conclude the plate is
     * unusable. It is a pair of thin blue-green bank lines with paper-coloured
     * water between them. Measured off plate row 850: the paper runs
     * (248, 242, 228) — warm, r > g > b; the two bank lines run (164, 180, 177)
     * and (200, 210, 202) — cool, g > r and b ≳ r; the 1901 modern overprint runs
     * (245, 202, 193) — red, g − r = −44; and the neutral ancient plan runs
     * (118, 111, 103), g − r = −7. So a "cooler than the paper" cut separates
     * water from every other population on the sheet with 9 units of margin.
     */
    water: 'bankline',
    credit: 'Lanciani / SITAR SSABAP-RM, CC-BY-SA 4.0 (georectification). Local reference only.',
  },
  aerial: {
    id: 'aerial',
    file: 'rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg',
    name: 'AGEA 2012 orthophoto, central Rome',
    widthPx: 4096, heightPx: 2734,
    extent3004: { e0: 2307658.1627, n0: 4638582.868607, e1: 2314671.3719, n1: 4643263.3909 },
    ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
    nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
    // The modern river is embanked and 19th-century straightened; its centreline is
    // still within a few tens of metres of the ancient one through the Campus
    // Martius, but it is a photograph and not a plan, so it is a corroborator and
    // never the ruler. `--plate=aerial` disables the river check for that reason.
    water: 'photo',
    credit: 'AGEA / Geoportale Nazionale (MATTM), no access constraints. Local reference only.',
  },
};
const PLATE = PLATES[PLATE_ID];
if (!PLATE) {
  console.error(`[probe-plan] unknown --plate=${PLATE_ID}. Known: ${Object.keys(PLATES).join(', ')}`);
  process.exit(2);
}

/** EPSG:3004 — Monte Mario / Italy zone 2. Used ONLY for the analytic check in `ALIGN`. */
const EPSG3004 = { lon0: 15, k0: 0.9996, falseE: 2520000 };
/** The survey's origin: the Temple of Jupiter Optimus Maximus. `src/city/rome/survey.ts`. */
const ORIGIN = { lat: 41.8925, lon: 12.4823 };

// ---------------------------------------------------------------------------
// pixel <-> survey metres
// ---------------------------------------------------------------------------
const enOfPx = (px, py) => ({
  e: PLATE.ex * px + PLATE.ey * py + PLATE.e0,
  n: PLATE.nx * px + PLATE.ny * py + PLATE.n0,
});
const DET = PLATE.ex * PLATE.ny - PLATE.ey * PLATE.nx;
const pxOfEn = (e, n) => {
  const de = e - PLATE.e0;
  const dn = n - PLATE.n0;
  return { px: (de * PLATE.ny - PLATE.ey * dn) / DET, py: (PLATE.ex * dn - de * PLATE.nx) / DET };
};
/** Metres of real ground per plate pixel, on the plate's long axis. */
const M_PER_PX = Math.hypot(PLATE.ex, PLATE.nx);

// ---------------------------------------------------------------------------
// The alignment self-check. Analytic, from the plate's own recorded extent and
// the definition of EPSG:3004. Nothing in this repository is consulted for it.
// ---------------------------------------------------------------------------
const ALIGN = (() => {
  const { e0, n0, e1, n1 } = PLATE.extent3004;
  const gridPerPxE = (e1 - e0) / PLATE.widthPx;
  const gridPerPxN = (n1 - n0) / PLATE.heightPx;
  // Hayford 1909 (International 1924), the ellipsoid Roma40 uses.
  const A = 6378388, E2 = 0.00672267;
  const phi = (ORIGIN.lat * Math.PI) / 180;
  const s2 = Math.sin(phi) ** 2;
  const rho = (A * (1 - E2)) / (1 - E2 * s2) ** 1.5;      // meridian radius
  const nu = A / Math.sqrt(1 - E2 * s2);                   // prime-vertical radius
  const R = Math.sqrt(rho * nu);                           // geometric mean
  const xFromCM = (e0 + e1) / 2 - EPSG3004.falseE;
  const k = EPSG3004.k0 * (1 + (xFromCM * xFromCM) / (2 * R * R));
  const groundPerPxE = gridPerPxE / k;
  const groundPerPxN = gridPerPxN / k;
  const dLon = ((ORIGIN.lon - EPSG3004.lon0) * Math.PI) / 180;
  const gammaDeg = (Math.atan(Math.tan(dLon) * Math.sin(phi)) * 180) / Math.PI;
  const affScaleX = Math.hypot(PLATE.ex, PLATE.nx);
  const affScaleY = Math.hypot(PLATE.ey, PLATE.ny);
  const affGammaDeg = -(Math.atan2(PLATE.nx, PLATE.ex) * 180) / Math.PI;
  const half = Math.max(PLATE.widthPx, PLATE.heightPx) / 2;
  const r = (v, d = 4) => +v.toFixed(d);
  return {
    gridPerPxE: r(gridPerPxE, 6), gridPerPxN: r(gridPerPxN, 6),
    pointScaleFactor: r(k, 8),
    groundPerPxE: r(groundPerPxE, 6), groundPerPxN: r(groundPerPxN, 6),
    affineScaleX: r(affScaleX, 6), affineScaleY: r(affScaleY, 6),
    scaleDiffPctX: r((affScaleX / groundPerPxE - 1) * 100),
    scaleDiffPctY: r((affScaleY / groundPerPxN - 1) * 100),
    convergenceDeg: r(gammaDeg, 5), affineRotationDeg: r(affGammaDeg, 5),
    rotationDiffDeg: r(affGammaDeg - gammaDeg, 5),
    edgeResidualMx: r(Math.abs(affScaleX - groundPerPxE) * half, 2),
    edgeResidualMy: r(Math.abs(affScaleY - groundPerPxN) * half, 2),
    edgeResidualRotM: r(Math.abs(((affGammaDeg - gammaDeg) * Math.PI) / 180) * half * affScaleX, 2),
    quotedFitResidualM: 1.26,
  };
})();
ALIGN.endToEndResidualM = +Math.hypot(
  Math.max(ALIGN.edgeResidualMx, ALIGN.edgeResidualMy), ALIGN.edgeResidualRotM
).toFixed(2);

// ===========================================================================
// The plate's own Tiber: colour segmentation, a channel tracker, a centreline.
// ===========================================================================
/**
 * "Cooler than the paper". See the measured populations in `PLATES.lanciani.water`.
 * `maxLum` throws away the blank margin between the mosaic's sheets, which is pure
 * white and whose channels are equal, so it would otherwise sit on the boundary.
 */
const WATER_INK = { gMinusR: 3, bMinusR: -2, maxLum: 245 };

const isWaterInk = (raw, px, py) => {
  if (px < 0 || py < 0 || px >= raw.w || py >= raw.h) return false;
  const i = (py * raw.w + px) * raw.ch;
  const r = raw.data[i], g = raw.data[i + 1], b = raw.data[i + 2];
  if ((r + g + b) / 3 > WATER_INK.maxLum) return false;
  return g - r >= WATER_INK.gMinusR && b - r >= WATER_INK.bMinusR;
};

/** Every run of water ink on one plate row, inside [lo, hi]. */
const inkRuns = (raw, py, lo, hi) => {
  const runs = [];
  let start = -1;
  for (let px = lo; px <= hi; px++) {
    const w = isWaterInk(raw, px, py);
    if (w && start < 0) start = px;
    else if (!w && start >= 0) { runs.push([start, px - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, hi]);
  return runs;
};

/** How much water ink lies between two columns on one row. A bank pair is hachured; two
 *  unrelated cool marks are not. */
const inkBetween = (raw, py, L, R) => {
  let n = 0;
  for (let px = Math.round(L); px <= Math.round(R); px++) if (isWaterInk(raw, px, py)) n++;
  return n;
};

/**
 * Track the Tiber down the plate. The prior is stated rather than tuned: *the Tiber is one
 * continuous channel, between 60 and 130 real metres wide, entering the sheet from the north
 * and never doubling back in latitude within this reach.* A global colour threshold picks up
 * the Petronia, the aqueduct channels and the hachured slopes as well; a tracker with that
 * prior does not. Returns one row per plate row, `mid === null` where the channel was lost.
 */
const trackChannel = (raw, y0, y1, seedX, halfWindow, minW, maxW) => {
  const rows = [];
  let centre = seedX;
  let width = (minW + maxW) / 2;
  let lost = 0;
  for (let py = y0; py <= y1; py++) {
    const lo = Math.max(0, Math.round(centre - halfWindow));
    const hi = Math.min(raw.w - 1, Math.round(centre + halfWindow));
    const runs = inkRuns(raw, py, lo, hi);
    let best = null;
    for (let a = 0; a < runs.length; a++) {
      for (let b = a + 1; b < runs.length; b++) {
        const L = (runs[a][0] + runs[a][1]) / 2;
        const R = (runs[b][0] + runs[b][1]) / 2;
        const w = R - L;
        if (w < minW || w > maxW) continue;
        const mid = (L + R) / 2;
        // Cost: stay near the running centre, near the running width, and prefer the
        // pair with ink between its banks.
        const cost = Math.abs(mid - centre) / 8 + Math.abs(w - width) / 12
          - inkBetween(raw, py, L, R) / Math.max(6, w);
        if (!best || cost < best.cost) best = { cost, L, R, mid, w };
      }
    }
    if (!best) { rows.push({ py, mid: null }); lost++; continue; }
    rows.push({ py, left: best.L, right: best.R, mid: best.mid, widthPx: best.w });
    centre = centre * 0.30 + best.mid * 0.70;
    width = width * 0.75 + best.w * 0.25;
    lost = 0;
  }
  return rows;
};

/** Where the channel enters: the row's bank pair with the most ink between it. Scanned over
 *  the full plate width, so the seed is measured rather than typed in. */
const seedChannel = (raw, py, minW, maxW) => {
  const runs = inkRuns(raw, py, 0, raw.w - 1);
  let best = null;
  for (let a = 0; a < runs.length; a++) {
    for (let b = a + 1; b < runs.length; b++) {
      const L = (runs[a][0] + runs[a][1]) / 2;
      const R = (runs[b][0] + runs[b][1]) / 2;
      const w = R - L;
      if (w < minW || w > maxW) continue;
      const ink = inkBetween(raw, py, L, R);
      if (!best || ink > best.ink) best = { L, R, mid: (L + R) / 2, w, ink };
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// small geometry, written here rather than imported. `probe-fabric`'s reason
// applies verbatim: an instrument that calls `obbOverlap` restates the answer
// of the code whose "no overlaps" verdict is in question.
// ---------------------------------------------------------------------------
const shoelace = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q.x * r.z - r.x * q.z;
  }
  return a / 2;
};
const ccw = (p) => (shoelace(p) < 0 ? [...p].reverse() : p);
/** Sutherland-Hodgman: the area of the intersection of two convex polygons. */
const clipArea = (subject, clipper) => {
  let out = ccw(subject);
  const cl = ccw(clipper);
  for (let i = 0; i < cl.length && out.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length];
    const side = (p) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
    const next = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
      }
    }
    out = next;
  }
  return out.length < 3 ? 0 : Math.abs(shoelace(out));
};
/**
 * Corners of a sim obstacle box. `src/sim/Obstacles.ts` `escape()` uses u = (cos, sin),
 * v = (−sin, cos), and `CitySystem.occRot` negates the plan yaw to reach this frame. The
 * plan convention is the other one and the two must stay distinct — the Circus Maximus was
 * 68° off for months because they were confused. This file only ever consumes obstacles.
 */
const obPoly = (o) => {
  const c = Math.cos(o.rot), s = Math.sin(o.rot);
  const ux = c * o.hw, uz = s * o.hw, vx = -s * o.hd, vz = c * o.hd;
  return [
    { x: o.x - ux - vx, z: o.z - uz - vz },
    { x: o.x + ux - vx, z: o.z + uz - vz },
    { x: o.x + ux + vx, z: o.z + uz + vz },
    { x: o.x - ux + vx, z: o.z - uz + vz },
  ];
};
/** A lane segment as a rectangle. No yaw convention at all: straight off its endpoints. */
const segRect = (a, b, halfWidth) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1;
  const nx = (-dz / L) * halfWidth, nz = (dx / L) * halfWidth;
  return [
    { x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz },
    { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz },
  ];
};
const bbox = (p) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of p) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
  return { x0, x1, z0, z1 };
};
/** A uniform bucket grid over world x/z. 1,259 blocks against 5,000 lane quads needs one. */
const makeGrid = (items, cell = 60) => {
  const g = new Map();
  items.forEach((it, i) => {
    for (let cx = Math.floor(it.bb.x0 / cell); cx <= Math.floor(it.bb.x1 / cell); cx++) {
      for (let cz = Math.floor(it.bb.z0 / cell); cz <= Math.floor(it.bb.z1 / cell); cz++) {
        const k = `${cx},${cz}`;
        let a = g.get(k);
        if (!a) g.set(k, (a = []));
        a.push(i);
      }
    }
  });
  return { g, cell };
};
const gridQuery = (grid, bb, fn) => {
  const seen = new Set();
  for (let cx = Math.floor(bb.x0 / grid.cell); cx <= Math.floor(bb.x1 / grid.cell); cx++) {
    for (let cz = Math.floor(bb.z0 / grid.cell); cz <= Math.floor(bb.z1 / grid.cell); cz++) {
      const a = grid.g.get(`${cx},${cz}`);
      if (!a) continue;
      for (const i of a) { if (!seen.has(i)) { seen.add(i); fn(i); } }
    }
  }
};
const median = (a) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : null);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r1 = (v) => (Number.isFinite(v) ? +v.toFixed(1) : null);
const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);

// ===========================================================================
// THRESHOLDS. Each one with the reason it is that number, and never a number
// chosen so that today's tree passes.
// ===========================================================================
const TH = {
  /** A block standing in the river is a fault at any count. Zero is the only defensible
   *  threshold and the shipped tree is at 60, so this fails loudly and correctly. */
  IN_WATER_MAX: 0,
  /** Likewise a block in a carriageway. `probe-fabric` G4/G5 already gate the monument
   *  half of this; the insula half has never been measured. Zero, same reason. */
  IN_ROAD_MAX: 0,
  /**
   * Displacement off the surveyed position, in REAL metres. 60 m is one insula block of
   * the real city (`ROME-FABRIC.md` §4.3's module is 35-70 m), so a monument more than a
   * block away from its plate position is in the wrong street. Worst-case gets 3x that,
   * because one displaced monument is a bug and thirty is a broken layout step.
   */
  DISPLACE_MEAN_M: 60,
  DISPLACE_WORST_M: 180,
  /**
   * River centreline departure from the plate, in REAL metres. The channel is 94 m wide,
   * so a departure of half a channel width means the engine's water and the plate's water
   * do not overlap at all. That is the smallest departure with a physical meaning, and it
   * is 27x the instrument's own end-to-end residual, so it is comfortably measurable.
   */
  RIVER_DEPART_M: 47,
  /** Fraction of compared latitude bands allowed to exceed it. One band can be a tracker
   *  slip on a sheet join; a tenth of them cannot. */
  RIVER_DEPART_FRAC: 0.10,
  /**
   * The reach the river is GATED over: survey north -400 to +1600, which is the Colosseum
   * (n -256) to the Mausoleum of Augustus (n 1500) with a margin — the ground the battle is
   * fought on and the city the player sees. The whole comparison is still reported, but the
   * verdict is not allowed to hinge on the last 200 m of the engine's z extent, where the
   * channel runs out on its mean slope and there is no city either side of it.
   */
  CITY_REACH: [-400, 1600],
  /**
   * The channel's width, engine against plate, as a ratio. The plate's own tracked width varies
   * from 67 to 124 m across the reach — hand-drawn banks on a compiled sheet — so +-25 % is
   * inside the ruler's own spread and anything beyond it is the engine's.
   */
  WIDTH_RATIO_TOL: 0.25,
  /**
   * How far the bow's apex — the westernmost point of the great Campus Martius bend — may
   * sit from the plate's, in survey north. 150 m is two insula blocks: an apex that far
   * south puts the bend under a different district.
   */
  APEX_SHIFT_M: 150,
  /**
   * How much of the built city may be on **land in the engine and in the river on the plate**,
   * or the reverse — the fraction of built footprint area whose side of the channel changes
   * between the plate's centreline and the engine's. Every square metre of it is either a
   * building the real city could not have had, or a piece of the real Tiber that the engine has
   * built over, and the correct answer is zero.
   *
   * 1 % is the allowance, and it is the instrument's own resolution rather than a taste: a
   * solid can only change sides if it lies in the strip between the two centrelines, this
   * probe's end-to-end alignment residual is 11 m against a channel 100 m wide, and the
   * channel's own width is about 4 % of the city's east-west extent, so the area the residual
   * alone can explain is of order 0.5 %. Rounded up once.
   *
   * **A wrong version of this check shipped first and is worth recording.** It gated on
   * "essentially none of the built footprint may lie west of the plate's channel, because Rome
   * in 271 is an east-bank city and Trastevere is off this map." Trastevere is NOT off this map
   * and was not off Aurelian's: *Regio XIV Transtiberim* is inside the circuit, the wall crosses
   * the river twice, and the engine builds west-bank fabric on purpose. The check reported 33 %
   * and was measuring history it had got wrong. The disambiguator below — the same fraction
   * against the engine's OWN channel, which came out at 32 % — is what caught it, and it is why
   * a check that can only be read one way is worth less than a pair that can be read against
   * each other.
   */
  CROSS_CHANNEL_FRAC: 0.01,
  /** Ways leaving a gate. The plate and the engine may disagree by one — a lane that dies
   *  in a yard is a way to a generator and not to Lanciani — but not by more. */
  GATE_WAYS_TOL: 1,
};

// ===========================================================================
// Stage 1 — the plate
// ===========================================================================
const plateStage = async () => {
  if (!REF) {
    console.error('[probe-plan] no reference/ directory found.\n'
      + '  It is gitignored local-only material: it lives in the MAIN checkout and in no worktree.\n'
      + '  Set TC_REFERENCE_DIR, or run from a checkout that has it.');
    process.exit(2);
  }
  const file = path.join(REF, PLATE.file);
  if (!existsSync(file)) {
    console.error(`[probe-plan] plate not found: ${file}`);
    process.exit(2);
  }
  const t0 = Date.now();
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { data, w: info.width, h: info.height, ch: info.channels };
  if (raw.w !== PLATE.widthPx || raw.h !== PLATE.heightPx) {
    console.error(`[probe-plan] plate is ${raw.w}x${raw.h}, affine expects ${PLATE.widthPx}x${PLATE.heightPx}.`);
    process.exit(2);
  }

  let channel = null;
  if (PLATE.water === 'bankline') {
    // 60-130 real metres of channel, in plate pixels.
    const minW = 60 / M_PER_PX;
    const maxW = 130 / M_PER_PX;
    // Seed from the first row, scanning down, where a plausible bank pair exists with ink
    // between it. The Tiber enters this sheet from the north.
    let seed = null, seedY = 0;
    for (let py = 40; py < raw.h - 40 && !seed; py += 4) {
      const s = seedChannel(raw, py, minW, maxW);
      if (s && s.ink > 0.35 * s.w) { seed = s; seedY = py; }
    }
    if (seed) {
      channel = trackChannel(raw, seedY, raw.h - 2, seed.mid, 140, minW, maxW);
    }
  }
  console.log(`[probe-plan] plate read in ${((Date.now() - t0) / 1000).toFixed(1)} s`
    + (channel ? `; channel tracked over ${channel.filter((r) => r.mid !== null).length} of ${channel.length} rows` : '; no channel extraction for this plate'));
  return { file, raw, channel };
};

// ===========================================================================
// Stage 2 — the built city, read out of a running page
// ===========================================================================
const bootAndRead = async () => {
  const base = `http://127.0.0.1:${PORT}`;
  const up = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  /*
   * Never reuse a server this process did not start. `qa-determinism` silently reuses any
   * listener on its port and can therefore measure another agent's tree and report
   * confidently; the same hazard applies here, and worse, because a foreign vite serves
   * another BRANCH's modules and this probe would grade a city it is not standing in.
   */
  if (await up(1200)) {
    console.error(`[probe-plan] something is ALREADY serving ${base}. Refusing to use it.\n`
      + '  Pass a free --port in the 5900s. Attribute a server by `lsof -a -p <pid> -d cwd` before killing it.');
    process.exit(2);
  }
  const server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore',
    env: {
      ...process.env,
      TC_NO_HMR: '1',
      // Worktrees symlink node_modules at the shared checkout, so vite's default
      // `node_modules/.vite` is one dependency cache written by as many vites as
      // there are agents. `vite.config.ts` reads this.
      TC_VITE_CACHE_DIR: process.env.TC_VITE_CACHE_DIR ?? path.join(ROOT, '.vite', 'probe-plan'),
    },
  });
  /*
   * An agent that starts a server owns killing it, and a `finally` does not discharge that:
   * nineteen orphaned vites were swept off this box in one pass, several over a day old, and
   * the accumulated load broke a gate run. Registered three ways — `unref` so a forgotten
   * handle cannot hold node open, an `exit` hook for the normal and the throwing paths, and
   * explicit signal handlers because the default SIGINT/SIGTERM disposition terminates
   * without running `exit` hooks.
   */
  let killed = false;
  const killServer = () => { if (killed) return; killed = true; try { server.kill('SIGTERM'); } catch { /* gone */ } };
  server.unref();
  process.once('exit', killServer);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { killServer(); process.exit(130); });
  if (!(await up(180000))) { console.error('[probe-plan] vite did not start on', PORT); killServer(); process.exit(2); }
  console.log(`[probe-plan] own vite on ${base} (pid ${server.pid})`);

  /*
   * `--use-angle=metal`, and it is not a nicety. A bare `chromium.launch()` on this box
   * comes up `--use-angle=swiftshader-webgl` — the whole scene in software — and boots take
   * four to six minutes while every screenshot times out, which reads as a hung page and is
   * a missing flag. Check with `ps -A -o command | grep 'type=gpu-process'`.
   */
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
      '--hide-scrollbars'],
  });
  const t0 = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)));
    await page.goto(`${base}/?harness=1&map=${MAP}&scenario=assault&quality=${TIER}&w=1280&h=720`,
      { waitUntil: 'domcontentloaded', timeout: 240000 });
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
    console.log(`[probe-plan] page ready in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

    const built = await page.evaluate(async (P) => {
      const eng = window.__game.engine;
      const ctx = eng.context ?? eng.ctx;
      const city = ctx.get('city');
      const terrain = ctx.get('terrain');
      const topo = await import('/src/terrain/topography.ts');
      const layout = await import('/src/city/rome/layout.ts');
      const survey = await import('/src/city/rome/survey.ts');

      // The projection, and its inverse. `X0`/`Z0` are module-private in
      // `topography.ts`, so they are recovered from `worldOf` itself rather than
      // re-typed — one fewer constant to rot.
      const o = topo.worldOf(0, 0);
      const KX = topo.KX, KZ = topo.KZ, X0 = o.x, Z0 = o.z;

      const obst = city.getObstacles();
      const WATER = topo.WATER_LEVEL;
      const HALF = topo.RIVER_HALF_WIDTH;

      // --- solids, with both water tests done here where the terrain lives -------
      const solids = [];
      for (const b of obst) {
        if (b.kind !== 'building' && b.kind !== 'monument') continue;
        const hw = b.hw, hd = b.hd, rot = b.rot;
        let wet = 0, inCh = 0, n = 0, lowest = Infinity;
        for (const su of [-1, 0, 1]) {
          for (const sv of [-1, 0, 1]) {
            // Obstacle convention: u = (cos, sin), v = (-sin, cos).
            const x = b.x + Math.cos(rot) * hw * su - Math.sin(rot) * hd * sv;
            const z = b.z + Math.sin(rot) * hw * su + Math.cos(rot) * hd * sv;
            const y = terrain.heightAt(x, z);
            n++;
            if (y <= WATER) wet++;
            if (y < lowest) lowest = y;
            // `riverOffset` is the PERPENDICULAR distance to the channel. Using
            // `riverBankX(z, ±1)` on an arbitrary point pinches the great bend to a
            // fifth of its width, because the surveyed course runs at up to 78 deg to
            // the z axis. `src/city/plan.ts:56` uses the bank form deliberately and
            // only because it draws along constant-z rows.
            if (Math.abs(topo.riverOffset(x, z)) < HALF) inCh++;
          }
        }
        solids.push({
          kind: b.kind, x: +b.x.toFixed(2), z: +b.z.toFixed(2),
          hw: +hw.toFixed(2), hd: +hd.toFixed(2), rot: +rot.toFixed(5),
          wet, inCh, n, lowest: +lowest.toFixed(2),
        });
      }

      // --- the built river, in world metres, at 4 m of z ----------------------
      const river = [];
      for (let z = -1400; z <= 1400; z += 4) {
        river.push([z, +topo.riverCentreX(z).toFixed(2), +topo.riverCurvature(z).toFixed(5)]);
      }

      // --- landmarks: built, ideal, and the survey row -------------------------
      const byId = new Map(survey.ROME.map((m) => [m.id, m]));
      const landmarks = layout.LANDMARKS.map((l) => {
        const s = byId.get(l.id);
        return {
          id: l.id, name: l.name, soft: !!l.soft, onRiver: !!l.onRiver, farBank: !!l.farBank,
          x: +l.x.toFixed(2), z: +l.z.toFixed(2),
          idealX: +l.idealX.toFixed(2), idealZ: +l.idealZ.toFixed(2),
          hw: +l.hw.toFixed(2), hd: +l.hd.toFixed(2), rot: +l.rot.toFixed(5),
          e: s ? s.e : null, n: s ? s.n : null,
          len: s ? s.len : null, wid: s ? s.wid : null, bearing: s ? s.bearing : null,
          axis: s ? (s.axis || 'x') : null,
        };
      });

      // --- roads: the armature and the district lanes --------------------------
      const ways = layout.WAYS.map((w) => ({
        id: w.id, cls: w.cls, width: w.width,
        path: w.path.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]),
      }));
      const lanes = city.getLanes().map((l) => ({
        cls: l.cls, width: l.width, path: l.path.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]),
      }));

      const gates = city.getGates().map((g) => ({ id: g.id, x: +g.x.toFixed(2), z: +g.z.toFixed(2) }));
      const circuit = city.getCircuitSamples(20).map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]);

      /*
       * A water mask, packed one bit per cell, so Node can re-run the wet test after a
       * perturbation. Taken from the heightfield itself rather than from `heightAt` —
       * 2049^2 is the field's own resolution and half a million `heightAt` calls in a
       * `page.evaluate` is slow enough to matter in a loop that will run many times
       * this afternoon. Downsampled 3:1 by MIN, so a cell is wet if any of its nine
       * source samples is: a conservative mask errs toward reporting a fault, which
       * is the correct direction for a gate.
       */
      const water = (() => {
        const hf = terrain.heightField;
        const src = hf.data, res = hf.res, sp = hf.spacing, halfE = hf.halfExtent;
        const DS = 3;
        const out = Math.floor(res / DS);
        const bits = new Uint8Array(Math.ceil((out * out) / 8));
        for (let j = 0; j < out; j++) {
          for (let i = 0; i < out; i++) {
            let lo = Infinity;
            for (let b = 0; b < DS; b++) {
              for (let a = 0; a < DS; a++) {
                const v = src[(j * DS + b) * res + (i * DS + a)];
                if (v < lo) lo = v;
              }
            }
            if (lo <= WATER) { const k = j * out + i; bits[k >> 3] |= 1 << (k & 7); }
          }
        }
        let s = '';
        for (let i = 0; i < bits.length; i += 8192) s += String.fromCharCode(...bits.subarray(i, i + 8192));
        return { res: out, step: sp * DS, min: -halfE, bits: btoa(s) };
      })();

      // --- the drawn city, rasterised into the plate's own pixel grid ----------
      /*
       * This is the strongest read available and the reason it is done in the page:
       * the vertices are here. Every `-lod0` mesh under the city root is walked and
       * every position vertex is plotted straight into a canvas whose pixel grid IS
       * the plate's, via the composed world -> survey -> pixel affine. No orthographic
       * camera, no `toDataURL` of an 9-megapixel framebuffer, no fog or shadow to
       * suppress, and no chance of the game's own RAF loop drawing its perspective
       * view over the top before the read lands — which is the failure
       * `tools/scratch/figure-ground.mjs` documents.
       */
      const A = (P.ny / P.det) / KX;
      const B = P.ey / (P.det * KZ);
      const C = ((0 - P.e0) * P.ny - P.ey * (0 - P.n0)) / P.det;
      const D = (-P.nx / P.det) / KX;
      const E = -P.ex / (P.det * KZ);
      const F = (P.ex * (0 - P.n0) - (0 - P.e0) * P.nx) / P.det;
      // px = A*x + B*z + (C - A*X0 - B*Z0) etc: fold the origin in.
      const CX = C - A * X0 - B * Z0;
      const FZ = F - D * X0 - E * Z0;
      const toPx = (x, z) => [A * x + B * z + CX, D * x + E * z + FZ];

      const cw = P.crop.w, chh = P.crop.h, ox = P.crop.x, oy = P.crop.y;
      const cvs = document.createElement('canvas');
      cvs.width = cw; cvs.height = chh;
      const g2 = cvs.getContext('2d');
      g2.fillStyle = '#ffffff';
      g2.fillRect(0, 0, cw, chh);
      const families = {};
      const COLOUR = { monuments: '#8e44ad', streets: '#2c3e50', wall: '#922b21', gate: '#922b21', postern: '#922b21', other: '#7f8c8d' };
      const root = ctx.scene.getObjectByName('city');
      let verts = 0;
      if (root) {
        if (city.debugForceLod) city.debugForceLod(0);
        root.traverse((nd) => {
          if (!nd.isMesh) return;
          const gname = nd.parent ? nd.parent.name : '';
          if (!/-lod0$/.test(gname)) return;
          if (/-shadow$/.test(nd.name || '')) return;
          const pos = nd.geometry && nd.geometry.attributes && nd.geometry.attributes.position;
          if (!pos) return;
          const fam = gname.replace(/-lod0$/, '').split('-')[0];
          families[fam] = (families[fam] || 0) + pos.count;
          g2.fillStyle = COLOUR[fam] || COLOUR.other;
          const arr = pos.array;
          // Every 3rd vertex. A footprint carries hundreds; the mask is a region.
          for (let k = 0; k + 2 < arr.length; k += 9) {
            const p = toPx(arr[k], arr[k + 2]);
            const px = p[0] - ox, py = p[1] - oy;
            if (px < 0 || py < 0 || px >= cw || py >= chh) continue;
            g2.fillRect(px | 0, py | 0, 1, 1);
            verts++;
          }
        });
        if (city.debugForceLod) city.debugForceLod(null);
      }
      const drawnPng = cvs.toDataURL('image/png');

      return {
        KX, KZ, X0, Z0,
        planScale: layout.PLAN_SCALE, precinct: layout.PRECINCT,
        wayFrontage: { ...layout.WAY_FRONTAGE },
        wayWidth: { ...layout.WAY_WIDTH },
        waterLevel: WATER, riverHalf: HALF,
        stats: city.stats(),
        solids, river, landmarks, ways, lanes, gates, circuit, water,
        drawnPng, drawnFamilies: families, drawnVerts: verts,
      };
    }, {
      ex: PLATE.ex, ey: PLATE.ey, e0: PLATE.e0, nx: PLATE.nx, ny: PLATE.ny, n0: PLATE.n0,
      det: DET, crop: CROP,
    });
    built.pageErrors = errs.slice(0, 5);
    console.log(`[probe-plan] read back in ${((Date.now() - t0) / 1000).toFixed(0)} s:`
      + ` ${built.solids.length} solids, ${built.landmarks.length} landmarks,`
      + ` ${built.ways.length} ways + ${built.lanes.length} lanes, ${built.drawnVerts} drawn vertices plotted`);
    return built;
  } finally {
    await browser.close();
    killServer();
  }
};

// ===========================================================================
// The crop: the rectangle of the plate that the map can reach. Computed before
// the boot because the page needs it to size its canvas.
//
// The engine's z extent un-projects to 12.6 km of real north (KZ = 0.222 over
// 2,800 world metres), which is 2.7x the plate's height, so only the overlap can
// be compared and framing it any other way puts the city off the sheet.
// ===========================================================================
const CROP = (() => {
  const KX = 0.443, KZ = 0.222, X0 = 292.171, Z0 = 983.7355852901810;   // §1; checked against the page
  const corners = [];
  for (const x of [-1400, 1400]) {
    for (const z of [-1400, 1400]) {
      corners.push(pxOfEn((x - X0) / KX, (Z0 - z) / KZ));
    }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of corners) { x0 = Math.min(x0, c.px); y0 = Math.min(y0, c.py); x1 = Math.max(x1, c.px); y1 = Math.max(y1, c.py); }
  const PAD = 40;
  x0 = Math.max(0, Math.floor(x0 - PAD));
  y0 = Math.max(0, Math.floor(y0 - PAD));
  x1 = Math.min(PLATE.widthPx, Math.ceil(x1 + PAD));
  y1 = Math.min(PLATE.heightPx, Math.ceil(y1 + PAD));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
})();

// ===========================================================================
// Stage 3 — the frame, and the perturbation that proves the gate can fail
// ===========================================================================
/**
 * The projection's inverse, built from the values the page reported rather than
 * from constants typed here, so a `KZ` change on another branch is picked up
 * instead of silently mismeasured.
 */
const makeFrame = (built) => ({
  KX: built.KX, KZ: built.KZ, X0: built.X0, Z0: built.Z0,
  aniso: built.KX / built.KZ,
  surveyOf: (x, z) => ({ e: (x - built.X0) / built.KX, n: (built.Z0 - z) / built.KZ }),
  worldOf: (e, n) => ({ x: built.X0 + built.KX * e, z: built.Z0 - built.KZ * n }),
});

/**
 * Shove or mirror the built city, in REAL metres, after read-back.
 *
 * Nothing in `src/` is touched: the perturbation is applied to numbers already
 * read out of the page, which is the only way to feed the harness a deliberately
 * wrong render without moving a determinism pin. A comparison harness that has
 * never gone red is worth nothing, and this project has shipped several.
 */
const perturb = (built, frame, off, mirror) => {
  if (!off.e && !off.n && !mirror) return built;
  const move = (x, z) => {
    const s = frame.surveyOf(x, z);
    const e = (mirror ? -s.e : s.e) + off.e;
    const n = s.n + off.n;
    const w = frame.worldOf(e, n);
    return [w.x, w.z];
  };
  // `drawnPng` is several megabytes of base64 and nothing downstream of a shove reads it.
  const { drawnPng, ...rest } = built;
  const c = structuredClone(rest);
  c.drawnPng = drawnPng;
  for (const s of c.solids) { const [x, z] = move(s.x, s.z); s.x = x; s.z = z; if (mirror) s.rot = -s.rot; }
  for (const l of c.landmarks) {
    const [x, z] = move(l.x, l.z); l.x = x; l.z = z;
    if (mirror) l.rot = -l.rot;
    // `idealX/idealZ` are NOT moved: they are the surveyed position, which is what
    // the shove is being measured against.
  }
  for (const w of c.ways) w.path = w.path.map(([x, z]) => move(x, z));
  for (const w of c.lanes) w.path = w.path.map(([x, z]) => move(x, z));
  c.gates = c.gates.map((g) => { const [x, z] = move(g.x, g.z); return { ...g, x, z }; });
  c.circuit = c.circuit.map(([x, z]) => move(x, z));
  // The river is a curve x = f(z); shoving it means shoving its sampled points.
  c.river = c.river.map(([z, x, s]) => { const [nx, nz] = move(x, z); return [nz, nx, mirror ? -s : s]; });
  c.perturbed = { offset: off, mirror };
  return c;
};

// ===========================================================================
// Stage 4 — the measurements
// ===========================================================================

/** `riverOffset`, recomputed in Node from the sampled LUT the page returned.
 *  Perpendicular, signed, negative = west. `riverPerpScale = 1/hypot(1, dx/dz)`. */
const makeRiver = (river) => {
  const zs = river.map((r) => r[0]);
  const z0 = zs[0], step = zs[1] - zs[0];
  const at = (z) => {
    const t = (z - z0) / step;
    const i = Math.max(0, Math.min(river.length - 2, Math.floor(t)));
    const f = Math.max(0, Math.min(1, t - i));
    return {
      x: river[i][1] + (river[i + 1][1] - river[i][1]) * f,
      s: river[i][2] + (river[i + 1][2] - river[i][2]) * f,
    };
  };
  return { at, offset: (x, z) => { const r = at(z); return (x - r.x) / Math.hypot(1, r.s); } };
};

/** Water lookup from the packed mask the page returned. */
const makeWater = (mask) => {
  const bytes = Buffer.from(mask.bits, 'base64');
  const { res, step, min } = mask;
  return (x, z) => {
    const i = Math.round((x - min) / step);
    const j = Math.round((z - min) / step);
    if (i < 0 || j < 0 || i >= res || j >= res) return false;
    const k = j * res + i;
    return (bytes[k >> 3] & (1 << (k & 7))) !== 0;
  };
};

const measure = (built, frame, plate) => {
  const river = makeRiver(built.river);
  const wet = makeWater(built.water);
  const HALF = built.riverHalf;

  // ---- M1  solids in the river -------------------------------------------
  // Two independent tests, because either alone can be fooled: a dry ledge inside
  // the channel, a flooded hollow outside it. Recomputed here (not taken from the
  // page's own per-solid answer) so that a perturbed city is measured, and the two
  // are cross-checked at zero offset — `waterAgreement` below.
  const inWater = [];
  let pageWet = 0, nodeWet = 0;
  for (const s of built.solids) {
    let w = 0, ch = 0, n = 0;
    for (const su of [-1, 0, 1]) {
      for (const sv of [-1, 0, 1]) {
        const x = s.x + Math.cos(s.rot) * s.hw * su - Math.sin(s.rot) * s.hd * sv;
        const z = s.z + Math.sin(s.rot) * s.hw * su + Math.cos(s.rot) * s.hd * sv;
        n++;
        if (wet(x, z)) w++;
        if (Math.abs(river.offset(x, z)) < HALF) ch++;
      }
    }
    if (s.wet > 0) pageWet++;
    if (w > 0) nodeWet++;
    if (w > 0 || ch > 0) {
      const en = frame.surveyOf(s.x, s.z);
      inWater.push({
        kind: s.kind, x: s.x, z: s.z, e: r1(en.e), n: r1(en.n),
        wet: w, inChannel: ch, of: n, fully: w === n,
        areaM2: r1(4 * s.hw * s.hd * (w / n)),
      });
    }
  }
  inWater.sort((a, b) => b.wet - a.wet || b.inChannel - a.inChannel);

  // ---- M2  solids in a carriageway ---------------------------------------
  /*
   * The carriageway, not the reserved corridor. `WAY_WIDTH.artery` is 42 m and
   * `layout.ts` concedes in its own comment that a real *via* is about 4.8 m; a
   * building 15 m off the centreline of a 42 m artery is fronting it, not standing
   * in it. So the paved width is taken as `width - 2 * WAY_FRONTAGE[cls]`, which is
   * the corridor the generator itself keeps clear, and both constants come out of
   * the page. This is a DEFINITION of what counts as a road; it is not a ruler for
   * whether the city is right, and the drawn-geometry check below is the ruler.
   */
  const quads = [];
  const addWay = (w) => {
    const front = built.wayFrontage[w.cls] ?? 0;
    const half = Math.max(1.5, (w.width - 2 * front) / 2);
    for (let i = 0; i + 1 < w.path.length; i++) {
      const a = { x: w.path[i][0], z: w.path[i][1] };
      const b = { x: w.path[i + 1][0], z: w.path[i + 1][1] };
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.5) continue;
      const poly = segRect(a, b, half);
      quads.push({ poly, bb: bbox(poly), cls: w.cls, id: w.id ?? `lane-${w.cls}`, armature: !!w.id });
    }
  };
  built.ways.forEach(addWay);
  built.lanes.forEach(addWay);
  const qGrid = makeGrid(quads, 80);
  const inRoad = [];
  let roadAreaTotal = 0;
  // Which layer of the network is being stood in matters to whoever fixes it: the named
  // armature (`WAYS`, which the fabric's KeepOut is supposed to respect) is a different bug
  // from a district's own lanes (`getLanes`, cut between its own blocks).
  const roadByClass = {};
  const roadByKind = {};
  let armatureCount = 0, laneOnlyCount = 0;
  for (const s of built.solids) {
    const poly = obPoly(s);
    const bb = bbox(poly);
    let area = 0;
    const hits = new Set();
    const clsHit = new Set();
    let armatureHit = false;
    gridQuery(qGrid, bb, (qi) => {
      const q = quads[qi];
      if (q.bb.x1 < bb.x0 || q.bb.x0 > bb.x1 || q.bb.z1 < bb.z0 || q.bb.z0 > bb.z1) return;
      const a = clipArea(poly, q.poly);
      if (a > 1) { area += a; hits.add(q.id); clsHit.add(q.cls); if (q.armature) armatureHit = true; }
    });
    if (area > 1) {
      const en = frame.surveyOf(s.x, s.z);
      const own = 4 * s.hw * s.hd;
      roadAreaTotal += Math.min(area, own);
      inRoad.push({
        kind: s.kind, x: s.x, z: s.z, e: r1(en.e), n: r1(en.n),
        areaM2: r1(Math.min(area, own)), fracOfFootprint: r2(Math.min(1, area / own)),
        ways: hits.size, classes: [...clsHit].sort(),
      });
      for (const c of clsHit) roadByClass[c] = (roadByClass[c] || 0) + 1;
      roadByKind[s.kind] = (roadByKind[s.kind] || 0) + 1;
      if (armatureHit) armatureCount++; else laneOnlyCount++;
    }
  }
  inRoad.sort((a, b) => b.fracOfFootprint - a.fracOfFootprint || b.areaM2 - a.areaM2);

  // ---- M3  monument displacement, in REAL metres --------------------------
  /*
   * `idealX/idealZ` are set in `place()` before `resolveOverlaps` runs and are
   * `readonly`, so the surveyed position survives at runtime and the displacement
   * needs no re-projection. Reported in REAL metres, because 130 world metres of
   * north-south shove is 586 real metres of Rome and the world figure understates
   * the fault by 4.5x. Both are printed.
   */
  const disp = [];
  for (const l of built.landmarks) {
    if (l.soft) continue;                       // landscape is placed against terrain, not the affine
    if (l.onRiver) continue;                    // pinned to the channel by design
    const b = frame.surveyOf(l.x, l.z);
    const i = frame.surveyOf(l.idealX, l.idealZ);
    const de = b.e - i.e, dn = b.n - i.n;
    disp.push({
      id: l.id, name: l.name,
      realM: r1(Math.hypot(de, dn)),
      worldM: r1(Math.hypot(l.x - l.idealX, l.z - l.idealZ)),
      dE: r1(de), dN: r1(dn),
      bearing: r1((((Math.atan2(de, dn) * 180) / Math.PI) + 360) % 360),
      e: r1(i.e), n: r1(i.n),
    });
  }
  disp.sort((a, b) => b.realM - a.realM);

  // ---- M4/M5  the river, against the plate --------------------------------
  let riverCmp = null;
  if (plate.channel) {
    // The plate's centreline, in survey metres.
    /*
     * Median-filtered over 21 plate rows (~36 real metres) before anything is measured off it.
     *
     * The tracker is good to a few metres along most of the sheet and it cuts the corner where
     * the Tiber turns sharply at the top of the bow, and at the joins between the mosaic's
     * sheets. Those are single-row slips of tens of metres. A median is the right filter for
     * them because it removes an outlier without moving the run of good rows either side, and
     * 36 m is a third of a channel width, so it cannot move the measured centreline by
     * anything the thresholds here care about. It matters most for CURVATURE, which is a second
     * difference and therefore amplifies exactly this kind of noise: the unfiltered plate
     * curvature spiked to 431 m at one band and 419 at another, both at tracker slips.
     */
    const rawRows = plate.channel.filter((r) => r.mid !== null);
    const MED = 21;
    const pl = [];
    for (let i = 0; i < rawRows.length; i++) {
      const lo = Math.max(0, i - (MED >> 1));
      const hi = Math.min(rawRows.length - 1, i + (MED >> 1));
      const win = [];
      for (let k = lo; k <= hi; k++) win.push(rawRows[k].mid);
      win.sort((a, b) => a - b);
      const en = enOfPx(win[win.length >> 1], rawRows[i].py);
      pl.push({ n: en.n, e: en.e, widthM: rawRows[i].widthPx * M_PER_PX });
    }
    pl.sort((a, b) => a.n - b.n);
    // The engine's centreline, in survey metres.
    const en2 = built.river.map(([z, x]) => {
      const s = frame.surveyOf(x, z);
      return { n: s.n, e: s.e };
    }).sort((a, b) => a.n - b.n);
    const interp = (arr, n) => {
      if (n < arr[0].n || n > arr[arr.length - 1].n) return null;
      let lo = 0, hi = arr.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].n <= n) lo = m; else hi = m; }
      const t = (n - arr[lo].n) / ((arr[hi].n - arr[lo].n) || 1);
      return arr[lo].e + (arr[hi].e - arr[lo].e) * t;
    };
    const nMin = Math.max(pl[0].n, en2[0].n);
    const nMax = Math.min(pl[pl.length - 1].n, en2[en2.length - 1].n);
    const bands = [];
    for (let n = Math.ceil(nMin / 100) * 100; n <= nMax; n += 100) {
      const ep = interp(pl, n), ee = interp(en2, n);
      if (ep === null || ee === null) continue;
      bands.push({ n, plateE: r1(ep), engineE: r1(ee), departM: r1(ee - ep), side: ee > ep ? 'east' : 'west' });
    }
    /*
     * The bow. `ROME-FABRIC.md` calls the Campus Martius fault "the great western bow
     * … bowing into the district instead of around it", and the checkable form of that
     * is the sign of the mid-chord departure: take the reach's two ends, draw the
     * chord, and measure how far the centreline sits from it at the middle. Negative
     * is west of the chord, which is the real Tiber's sense. A sign disagreement is
     * an inverted bend, in one number, with no curve fitting to argue about.
     */
    const bow = (arr, a, b) => {
      const ea = interp(arr, a), eb = interp(arr, b), em = interp(arr, (a + b) / 2);
      if (ea === null || eb === null || em === null) return null;
      return em - (ea + eb) / 2;
    };
    const reach = { a: Math.max(nMin, 0), b: Math.min(nMax, 1500) };
    const bowPlate = bow(pl, reach.a, reach.b);
    const bowEngine = bow(en2, reach.a, reach.b);
    /*
     * The apex: where the great bend actually turns. The mid-chord bow says the bend goes
     * the right WAY; the apex says it goes the right way in the right PLACE, and those are
     * different faults. Rome's bow apex is what wraps the Campus Martius, so an apex 300 m
     * south of the plate's puts the district on the wrong part of the curve even when the
     * sign is right.
     */
    const apexOf = (arr) => {
      let best = null;
      for (let n = reach.a; n <= reach.b; n += 10) {
        const e = interp(arr, n);
        if (e === null) continue;
        if (!best || e < best.e) best = { n, e };
      }
      return best;
    };
    const apexP = apexOf(pl), apexE = apexOf(en2);
    /*
     * Local curvature sign, band by band, over the gated reach. This is the literal form of
     * "the sign of its curvature is reversed over that span": the second difference of e(n)
     * at three consecutive bands, on each curve, and the longest run of bands where the two
     * disagree. A single flipped band is noise on a hand-drawn plate; a run of five is an
     * inverted bend.
     */
    /*
     * Second difference over +-300 m, not +-100 m. Three reasons, and they are physical rather
     * than convenient. A river bend at Rome has a radius of order 500-1500 m, so 300 m is the
     * scale the curvature of this channel actually lives at; a 100 m stencil measures the
     * tracker's own jitter as often as the river's shape; and `CURV_FLAT_M` below then has a
     * meaning — 25 m of sagitta over a 600 m chord is a radius of 1.8 km, which is straighter
     * than any reach of the Tiber in the city, so calling it "flat" costs nothing real.
     */
    const SPAN = 3;
    const CURV_FLAT_M = 25;
    const cityBands = bands.filter((b) => b.n >= TH.CITY_REACH[0] && b.n <= TH.CITY_REACH[1]);
    const signRuns = [];
    let run = 0;
    for (let i = SPAN; i + SPAN < cityBands.length; i++) {
      const cp = cityBands[i - SPAN].plateE - 2 * cityBands[i].plateE + cityBands[i + SPAN].plateE;
      const ce = cityBands[i - SPAN].engineE - 2 * cityBands[i].engineE + cityBands[i + SPAN].engineE;
      cityBands[i].curvPlate = r2(cp);
      cityBands[i].curvEngine = r2(ce);
      const flat = Math.abs(cp) < CURV_FLAT_M || Math.abs(ce) < CURV_FLAT_M;
      cityBands[i].curvAgrees = flat ? null : Math.sign(cp) === Math.sign(ce);
      if (cityBands[i].curvAgrees === false) { run++; } else { if (run) signRuns.push(run); run = 0; }
    }
    if (run) signRuns.push(run);
    const cityOver = cityBands.filter((b) => Math.abs(b.departM) > TH.RIVER_DEPART_M);
    const over = bands.filter((b) => Math.abs(b.departM) > TH.RIVER_DEPART_M);
    riverCmp = {
      bands,
      nRange: [r1(nMin), r1(nMax)],
      worstDepartM: bands.length ? r1(Math.max(...bands.map((b) => Math.abs(b.departM)))) : null,
      worstAtN: bands.length ? bands.reduce((p, c) => (Math.abs(c.departM) > Math.abs(p.departM) ? c : p)).n : null,
      meanAbsDepartM: r1(mean(bands.map((b) => Math.abs(b.departM)))),
      medianSignedDepartM: r1(median(bands.map((b) => b.departM))),
      bandsOverThreshold: over.length,
      bandsCompared: bands.length,
      fracOver: bands.length ? r2(over.length / bands.length) : null,
      reach: [r1(reach.a), r1(reach.b)],
      bowPlateM: r1(bowPlate),
      bowEngineM: r1(bowEngine),
      bowConvexPlate: bowPlate === null ? null : bowPlate < 0 ? 'west' : 'east',
      bowConvexEngine: bowEngine === null ? null : bowEngine < 0 ? 'west' : 'east',
      curvatureSignAgrees: bowPlate === null || bowEngine === null ? null : Math.sign(bowPlate) === Math.sign(bowEngine),
      plateWidthMedianM: r1(median(pl.map((p) => p.widthM))),
      /*
       * The engine's channel width **in real metres, perpendicular to the channel** — and the
       * first version of this line was wrong in a way worth keeping on the record. It reported
       * `2 * RIVER_HALF_WIDTH` = 94 m against the plate's 101 and called them equal. They are
       * not comparable: 47 m is a half-width in WORLD metres, and un-projecting it stretches it
       * by 1/KX = 2.26 across and 1/KZ = 4.50 along, by an amount that depends on which way the
       * channel is running. A constant world half-width is therefore a VARIABLE real width, and
       * at the bow, where the course runs at 66 deg to the z axis, 94 world metres of channel is
       * over 300 real metres of river.
       *
       * The error was found by the vision model's one deliberately open question, which is the
       * argument for keeping that question in the list: the numeric battery was comparing two
       * quantities in different units and reporting agreement, and the model said "the Tiber
       * balloons to several times its true width" while looking at the same picture.
       *
       * v is the world-space half-offset to a bank; t is the channel's direction in the survey
       * frame. Both are un-projected before the perpendicular component is taken.
       */
      engineWidthM: (() => {
        const ws = [];
        for (const [z, , sl] of built.river) {
          const sv = frame.surveyOf(0, z);
          if (sv.n < TH.CITY_REACH[0] || sv.n > TH.CITY_REACH[1]) continue;
          const h = Math.hypot(1, sl);
          // world half-offset to a bank, perpendicular to the channel in WORLD space
          const vwx = HALF / h, vwz = (-HALF * sl) / h;
          // the same vector in survey metres
          const ve = vwx / frame.KX, vn = -vwz / frame.KZ;
          // the channel's direction in survey metres
          const te = sl / frame.KX, tn = -1 / frame.KZ;
          const tl = Math.hypot(te, tn) || 1;
          const dot = (ve * te + vn * tn) / tl;
          ws.push(2 * Math.sqrt(Math.max(0, ve * ve + vn * vn - dot * dot)));
        }
        return r1(median(ws));
      })(),
      engineWidthWorldM: r1(2 * HALF),
      plateCentreline: pl.filter((_, i) => i % 12 === 0).map((p) => [r1(p.n), r1(p.e)]),
      engineCentreline: en2.filter((_, i) => i % 12 === 0).map((p) => [r1(p.n), r1(p.e)]),
      // the gated reach, which is where the city is
      cityReach: TH.CITY_REACH,
      cityBandsCompared: cityBands.length,
      cityBandsOver: cityOver.length,
      cityFracOver: cityBands.length ? r2(cityOver.length / cityBands.length) : null,
      cityWorstDepartM: cityBands.length ? r1(Math.max(...cityBands.map((b) => Math.abs(b.departM)))) : null,
      cityWorstAtN: cityBands.length ? cityBands.reduce((p, c) => (Math.abs(c.departM) > Math.abs(p.departM) ? c : p)).n : null,
      cityMeanAbsDepartM: r1(mean(cityBands.map((b) => Math.abs(b.departM)))),
      apexPlateN: apexP ? apexP.n : null, apexPlateE: apexP ? r1(apexP.e) : null,
      apexEngineN: apexE ? apexE.n : null, apexEngineE: apexE ? r1(apexE.e) : null,
      apexShiftN: apexP && apexE ? r1(apexE.n - apexP.n) : null,
      apexShiftE: apexP && apexE ? r1(apexE.e - apexP.e) : null,
      curvatureDisagreeBands: cityBands.filter((b) => b.curvAgrees === false).length,
      curvatureJudgedBands: cityBands.filter((b) => b.curvAgrees !== null && b.curvAgrees !== undefined).length,
      curvatureLongestDisagreeRun: signRuns.length ? Math.max(...signRuns) : 0,
      widthRatio: null,   // filled in below, once both widths exist
      curvatureDisagreeSpans: (() => {
        const out = [];
        let a = null;
        for (const b of cityBands) {
          if (b.curvAgrees === false) { if (a === null) a = b.n; }
          else if (a !== null) { out.push([a, b.n]); a = null; }
        }
        return out;
      })(),
    };
    riverCmp.widthRatio = riverCmp.plateWidthMedianM
      ? r2(riverCmp.engineWidthM / riverCmp.plateWidthMedianM) : null;
  }

  // ---- M6  gate topology, engine side ------------------------------------
  const gateWays = built.gates.map((g) => {
    const near = new Set();
    for (const w of built.ways) {
      for (const [x, z] of w.path) {
        if (Math.hypot(x - g.x, z - g.z) < 120) { near.add(w.id); break; }
      }
    }
    return { id: g.id, x: g.x, z: g.z, engineWays: near.size, ids: [...near] };
  });

  // ---- M7  gross registration, against the plate's own extracted channel ---
  /*
   * The ruler is history, not a tuned constant: **Rome in 271 AD is on the east bank.**
   * Trastevere is off this map — the Janiculum is `soft` and `farBank`, and `survey.ts`
   * records the Mausoleum of Hadrian as outside the circuit — so essentially none of the
   * built footprint may lie west of the plate's channel. This is the check a mirror cannot
   * survive, and it needs no threshold anybody chose.
   */
  let sw = 0, se = 0, sn = 0, westArea = 0, totArea = 0;
  const plateE = riverCmp ? (() => {
    const arr = riverCmp.plateCentreline.map(([n, e]) => ({ n, e })).sort((a, b) => a.n - b.n);
    return (n) => {
      if (!arr.length || n < arr[0].n || n > arr[arr.length - 1].n) return null;
      let lo = 0, hi = arr.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].n <= n) lo = m; else hi = m; }
      const t = (n - arr[lo].n) / ((arr[hi].n - arr[lo].n) || 1);
      return arr[lo].e + (arr[hi].e - arr[lo].e) * t;
    };
  })() : null;
  let westOwnArea = 0, crossArea = 0;
  let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
  const hullPts = [];
  for (const s of built.solids) {
    const a = 4 * s.hw * s.hd;
    const en = frame.surveyOf(s.x, s.z);
    sw += a; se += a * en.e; sn += a * en.n;
    for (const q of obPoly(s)) {
      const p = frame.surveyOf(q.x, q.z);
      if (p.e < e0) e0 = p.e; if (p.e > e1) e1 = p.e;
      if (p.n < n0) n0 = p.n; if (p.n > n1) n1 = p.n;
      hullPts.push([p.e, p.n]);
    }
    if (plateE) {
      const pe = plateE(en.n);
      if (pe !== null) {
        totArea += a;
        const westOfPlate = en.e < pe;
        // The same question against the engine's OWN channel. This is the disambiguator and
        // the reason the pair is worth more than either: if a third of the city is west of the
        // PLATE's river and none of it is west of the ENGINE's, the city is built correctly
        // around a river that is misplaced, and the fix is TIBER_PATH and not the fabric.
        const westOfOwn = river.offset(s.x, s.z) < 0;
        if (westOfPlate) westArea += a;
        if (westOfOwn) westOwnArea += a;
        // The gated quantity: dry here and wet there, or the reverse.
        if (westOfPlate !== westOfOwn) crossArea += a;
      }
    }
  }
  /** Monotone-chain convex hull, so the built fabric's real ground area is a number. */
  const hullArea = (() => {
    if (hullPts.length < 3) return 0;
    const pts = [...hullPts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a2, b2) => (a2[0] - o[0]) * (b2[1] - o[1]) - (a2[1] - o[1]) * (b2[0] - o[0]);
    const build = (arr) => {
      const st = [];
      for (const q of arr) {
        while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], q) <= 0) st.pop();
        st.push(q);
      }
      return st;
    };
    const lower = build(pts);
    const upper = build([...pts].reverse());
    const h = lower.slice(0, -1).concat(upper.slice(0, -1));
    let A = 0;
    for (let i = 0; i < h.length; i++) {
      const q = h[i], r = h[(i + 1) % h.length];
      A += q[0] * r[1] - r[0] * q[1];
    }
    return Math.abs(A) / 2;
  })();
  /*
   * The defended line, measured in real metres. REPORTED, NEVER GATED: `docs/ROME.md` says in as
   * many words that this map models the northern front only, so a circuit that does not close is
   * the design and not a fault. It is reported because a judge looking at the overlay will see
   * one red line across the top and needs the number beside it — Aurelian's circuit is **19 km**
   * and encloses 1,373 ha, and what is built is a small arc of that.
   */
  const circuitRealM = (() => {
    let L = 0;
    for (let i = 0; i + 1 < built.circuit.length; i++) {
      const a = frame.surveyOf(built.circuit[i][0], built.circuit[i][1]);
      const b = frame.surveyOf(built.circuit[i + 1][0], built.circuit[i + 1][1]);
      L += Math.hypot(b.e - a.e, b.n - a.n);
    }
    return L;
  })();
  const circuitClosed = built.circuit.length > 2
    && Math.hypot(built.circuit[0][0] - built.circuit[built.circuit.length - 1][0],
      built.circuit[0][1] - built.circuit[built.circuit.length - 1][1]) < 100;
  const builtCentroid = { e: se / sw, n: sn / sw };
  const reg = {
    builtCentroidE: r1(builtCentroid.e), builtCentroidN: r1(builtCentroid.n),
    // Reported, NOT gated. The neutral-dark ink on a 3.7 x 2.5 km Lanciani sheet includes
    // the Janiculum's and the Vatican's hill hachure, which pulls this west by an amount
    // this instrument cannot separate out. It is context, not a verdict.
    plateCentroidE: r1(plate.ink.e), plateCentroidN: r1(plate.ink.n),
    centroidOffsetM: r1(Math.hypot(builtCentroid.e - plate.ink.e, builtCentroid.n - plate.ink.n)),
    plateInkPixels: plate.ink.count,
    westOfChannelFrac: totArea ? r2(westArea / totArea) : null,
    westOfChannelM2: r1(westArea),
    westOfOwnChannelFrac: totArea ? r2(westOwnArea / totArea) : null,
    crossChannelFrac: totArea ? +(crossArea / totArea).toFixed(4) : null,
    crossChannelM2: r1(crossArea),
    comparedAreaM2: r1(totArea),
    /*
     * The built fabric's real ground footprint. REPORTED, NEVER GATED, and the reason is
     * honest: this map deliberately carries off-circuit backdrop — the Janiculum, the horti,
     * the far bank — and this instrument cannot tell backdrop from sprawl. The comparison is
     * given so a human can: **Aurelian's circuit is 19 km long and encloses 1,373 hectares**
     * (13.73 km2), the standard figure, and that is the whole city including Trastevere.
     */
    circuitRealKm: r2(circuitRealM / 1000), circuitClosed,
    aurelianCircuitKm: 19,
    extentE: [r1(e0), r1(e1)], extentN: [r1(n0), r1(n1)],
    extentKmE: r2((e1 - e0) / 1000), extentKmN: r2((n1 - n0) / 1000),
    hullAreaKm2: r2(hullArea / 1e6),
    aurelianAreaKm2: 13.73,
    hullOverAurelian: r2(hullArea / 1e6 / 13.73),
  };

  return {
    aniso: r2(frame.aniso),
    solids: built.solids.length,
    buildings: built.solids.filter((s) => s.kind === 'building').length,
    monuments: built.solids.filter((s) => s.kind === 'monument').length,
    inWater, inWaterCount: inWater.filter((r) => r.wet > 0).length,
    inWaterFully: inWater.filter((r) => r.fully).length,
    inChannelCount: inWater.filter((r) => r.inChannel > 0).length,
    inWaterAreaM2: r1(inWater.reduce((s, r) => s + (r.areaM2 || 0), 0)),
    /*
     * Two water tests on the same city, and the expected relation between them is stated
     * rather than assumed. The page's figure comes from `terrain.heightAt` at the field's own
     * resolution; this file's comes from the heightfield downsampled 3:1 by MIN, so it is
     * conservative BY CONSTRUCTION and `node >= page` is correct. `node < page` would mean
     * the mask is losing water, which is the direction that hides a fault, and that is the
     * only asymmetry worth failing on.
     */
    waterAgreement: { pageWet, nodeWet, conservativeAsExpected: nodeWet >= pageWet, excess: nodeWet - pageWet },
    inRoad, inRoadCount: inRoad.length,
    inRoadAreaM2: r1(roadAreaTotal),
    inRoadFrac: r2(inRoad.length / Math.max(1, built.solids.length)),
    inRoadByClass: roadByClass, inRoadByKind: roadByKind,
    inRoadOnArmature: armatureCount, inRoadOnDistrictLanesOnly: laneOnlyCount,
    disp,
    dispMeanRealM: r1(mean(disp.map((d) => d.realM))),
    dispWorstRealM: disp.length ? disp[0].realM : null,
    dispMeanWorldM: r1(mean(disp.map((d) => d.worldM))),
    dispWorstWorldM: disp.length ? r1(Math.max(...disp.map((d) => d.worldM))) : null,
    river: riverCmp, gateWays, reg,
  };
};

// ===========================================================================
// Stage 5 — the pictures. Everything at the plate's own scale and extent, so a
// pair can be laid on top of another pair without any resampling.
// ===========================================================================
const FONT = 'font-family="Helvetica,Arial,sans-serif"';
/** Survey latitudes the vision model is asked about. Five, spaced through the
 *  Campus Martius, drawn and labelled identically on both images so a question
 *  about "tick N3" cannot be misread. */
const TICKS = [1400, 1050, 700, 350, 0];

const renderStage = async (built, frame, plate, M, tag) => {
  const P = (e, n) => { const p = pxOfEn(e, n); return { x: p.px - CROP.x, y: p.py - CROP.y }; };
  const W = (x, z) => { const s = frame.surveyOf(x, z); return P(s.e, s.n); };
  const pt = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const cw = CROP.w, ch = CROP.h;

  const graticule = (label) => {
    const out = [];
    for (let i = 0; i < TICKS.length; i++) {
      const n = TICKS[i];
      const a = P(-3400, n), b = P(3400, n);
      out.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#e67e22" stroke-width="2" stroke-dasharray="14 10" opacity="0.8"/>`);
      out.push(`<text x="18" y="${(a.y - 8).toFixed(1)}" ${FONT} font-size="30" font-weight="bold" fill="#e67e22" stroke="#fff" stroke-width="5" paint-order="stroke">T${i + 1}  n=${n} m</text>`);
    }
    const len = 500 / M_PER_PX;
    out.push(`<rect x="${cw - len - 300}" y="${ch - 116}" width="${len + 280}" height="96" fill="#fff" fill-opacity="0.85"/>`);
    out.push(`<line x1="${cw - len - 280}" y1="${ch - 52}" x2="${cw - 280}" y2="${ch - 52}" stroke="#111" stroke-width="6"/>`);
    out.push(`<text x="${cw - len - 280}" y="${ch - 68}" ${FONT} font-size="28" font-weight="bold" fill="#111">500 real metres  (${M_PER_PX.toFixed(3)} m/px)</text>`);
    out.push(`<text x="${cw - len - 280}" y="${ch - 26}" ${FONT} font-size="22" fill="#333">${label}  |  north up  |  survey frame, real metres</text>`);
    return out;
  };

  // ------------------------------------------------------------------ B: the render
  const b = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`];
  b.push(`<rect width="${cw}" height="${ch}" fill="#f4efe2"/>`);
  // the channel, as a band between its two banks
  {
    const R = makeRiver(built.river);
    const left = [], right = [];
    for (const [z] of built.river) {
      const r = R.at(z);
      const perp = Math.hypot(1, r.s);
      // Perpendicular offset in world metres: bank = centre +- HALF * perp along x.
      left.push(W(r.x - built.riverHalf * perp, z));
      right.push(W(r.x + built.riverHalf * perp, z));
    }
    b.push(`<polygon points="${[...left, ...right.reverse()].map(pt).join(' ')}" fill="#5b8fb9" fill-opacity="0.55" stroke="#2c6b9b" stroke-width="2"/>`);
  }
  // roads
  for (const w of [...built.ways, ...built.lanes]) {
    const d = w.path.map(([x, z], i) => `${i ? 'L' : 'M'}${pt(W(x, z))}`).join(' ');
    const front = built.wayFrontage[w.cls] ?? 0;
    const half = Math.max(1.5, (w.width - 2 * front) / 2);
    // Stroke width in pixels: a road is drawn at its own carriageway width in the
    // survey frame's EAST direction, which is the frame's uncompressed axis.
    b.push(`<path d="${d}" fill="none" stroke="#6d6152" stroke-opacity="0.75" stroke-width="${Math.max(1.5, (2 * half) / built.KX / M_PER_PX).toFixed(2)}"/>`);
  }
  // insulae and monuments
  for (const s of built.solids) {
    const poly = obPoly(s).map((q) => pt(W(q.x, q.z))).join(' ');
    const mon = s.kind === 'monument';
    b.push(`<polygon points="${poly}" fill="${mon ? '#c9a227' : '#b9a58b'}" fill-opacity="${mon ? 0.55 : 0.7}" stroke="${mon ? '#8a6d0b' : '#8b7c66'}" stroke-width="${mon ? 2 : 1}"/>`);
  }
  // the built circuit
  b.push(`<path d="${built.circuit.map(([x, z], i) => `${i ? 'L' : 'M'}${pt(W(x, z))}`).join(' ')}" fill="none" stroke="#922b21" stroke-width="7" opacity="0.95"/>`);
  b.push(...graticule('B — the built city, read back from the live scene'));
  b.push('</svg>');

  // ------------------------------------------------------------------ A: the plate
  const a = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`];
  a.push(...graticule(`A — ${PLATE.name}`));
  a.push('</svg>');

  // ------------------------------------------------------------------ D: the faults
  const d = [`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`];
  if (M.river) {
    d.push(`<path d="${M.river.plateCentreline.map(([n, e], i) => `${i ? 'L' : 'M'}${pt(P(e, n))}`).join(' ')}" fill="none" stroke="#1a5276" stroke-width="8" opacity="0.95"/>`);
    d.push(`<path d="${M.river.engineCentreline.map(([n, e], i) => `${i ? 'L' : 'M'}${pt(P(e, n))}`).join(' ')}" fill="none" stroke="#c0392b" stroke-width="8" stroke-dasharray="22 14" opacity="0.95"/>`);
    for (const bd of M.river.bands) {
      const p0 = P(bd.plateE, bd.n), p1 = P(bd.engineE, bd.n);
      d.push(`<line x1="${pt(p0).split(',')[0]}" y1="${pt(p0).split(',')[1]}" x2="${pt(p1).split(',')[0]}" y2="${pt(p1).split(',')[1]}" stroke="#8e44ad" stroke-width="4"/>`);
      d.push(`<text x="${((p0.x + p1.x) / 2).toFixed(1)}" y="${(p0.y - 8).toFixed(1)}" ${FONT} font-size="26" font-weight="bold" fill="#8e44ad" stroke="#fff" stroke-width="5" paint-order="stroke" text-anchor="middle">${bd.departM > 0 ? '+' : ''}${bd.departM} m</text>`);
    }
  }
  for (const r of M.inWater) {
    const p = P(r.e, r.n);
    d.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.fully ? 11 : 7}" fill="#c0392b" fill-opacity="0.85" stroke="#fff" stroke-width="2"/>`);
  }
  for (const r of M.inRoad.slice(0, 400)) {
    const p = P(r.e, r.n);
    d.push(`<rect x="${(p.x - 6).toFixed(1)}" y="${(p.y - 6).toFixed(1)}" width="12" height="12" fill="#e67e22" fill-opacity="0.9" stroke="#fff" stroke-width="1.5"/>`);
  }
  for (const dd of M.disp) {
    const p0 = P(dd.e, dd.n), p1 = P(dd.e + dd.dE, dd.n + dd.dN);
    if (dd.realM < 20) continue;
    d.push(`<line x1="${p0.x.toFixed(1)}" y1="${p0.y.toFixed(1)}" x2="${p1.x.toFixed(1)}" y2="${p1.y.toFixed(1)}" stroke="#16a085" stroke-width="5"/>`);
    d.push(`<circle cx="${p1.x.toFixed(1)}" cy="${p1.y.toFixed(1)}" r="6" fill="#16a085"/>`);
    d.push(`<text x="${(p1.x + 10).toFixed(1)}" y="${(p1.y - 10).toFixed(1)}" ${FONT} font-size="26" font-weight="bold" fill="#0e6655" stroke="#fff" stroke-width="5" paint-order="stroke">${dd.name} ${dd.realM} m</text>`);
  }
  // legend
  {
    const lx = 30, ly = ch - 470;
    d.push(`<rect x="${lx - 12}" y="${ly - 40}" width="1080" height="400" fill="#fff" fill-opacity="0.88"/>`);
    const row = (i, colour, dash, label) => {
      const y = ly + i * 46;
      d.push(`<line x1="${lx}" y1="${y}" x2="${lx + 70}" y2="${y}" stroke="${colour}" stroke-width="8" ${dash}/>`);
      d.push(`<text x="${lx + 86}" y="${y + 9}" ${FONT} font-size="28" fill="#111">${label}</text>`);
    };
    d.push(`<text x="${lx}" y="${ly - 8}" ${FONT} font-size="32" font-weight="bold" fill="#111">D — the divergences, on the plate</text>`);
    row(1, '#1a5276', '', "the plate's Tiber centreline, extracted by colour");
    row(2, '#c0392b', 'stroke-dasharray="22 14"', "the engine's Tiber centreline, un-projected");
    row(3, '#8e44ad', '', `departure per 100 m band (worst ${M.river ? M.river.worstDepartM : 'n/a'} m)`);
    row(4, '#c0392b', '', `a solid standing in the water (${M.inWaterCount}, ${M.inWaterFully} fully)`);
    row(5, '#e67e22', '', `a solid standing in a carriageway (${M.inRoadCount})`);
    row(6, '#16a085', '', `resolveOverlaps displacement, surveyed -> built (worst ${M.dispWorstRealM} real m)`);
  }
  d.push(...graticule('D — faults'));
  d.push('</svg>');

  const crop = () => sharp(plate.file).extract({ left: CROP.x, top: CROP.y, width: cw, height: ch });
  mkdirSync(OUT, { recursive: true });
  const files = {};
  const write = async (name, img) => {
    const f = path.join(OUT, `${name}-${tag}.png`);
    await img.png({ compressionLevel: 6 }).toFile(f);
    files[name] = f;
    return f;
  };
  await write('A-plate', crop().composite([{ input: Buffer.from(a.join('\n')), top: 0, left: 0 }]));
  await write('B-render', sharp(Buffer.from(b.join('\n'))));
  await write('C-overlay', crop().composite([
    { input: Buffer.from(b.join('\n').replace('fill="#f4efe2"', 'fill="none"')), top: 0, left: 0 },
  ]));
  await write('D-faults', crop().composite([{ input: Buffer.from(d.join('\n')), top: 0, left: 0 }]));
  // E: the drawn geometry, straight out of the page, over the plate.
  if (built.drawnPng) {
    const raw = Buffer.from(built.drawnPng.split(',')[1], 'base64');
    // white -> transparent, so the plate shows through
    const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) data[i + 3] = 0;
    }
    const drawn = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
    await write('E-drawn-on-plate', crop().composite([
      { input: await drawn.png().toBuffer(), top: 0, left: 0 },
      { input: Buffer.from([`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`,
        ...graticule('E — the DRAWN city (every lod0 vertex), plotted straight into the plate grid'), '</svg>'].join('\n')), top: 0, left: 0 },
    ]));
  }
  return files;
};

// ===========================================================================
// Stage 6 — the vision model. Narrow questions, checkable answers.
// ===========================================================================
/**
 * The adapter, and it is deliberately one function so it can be replaced.
 *
 * `claude -p` is used because it needs no API key on this machine, and it is the WRONG shape for
 * this job in two measured ways, both of which cost an hour before they were understood.
 *
 *  1. **`--permission-mode bypassPermissions` is load-bearing, not a convenience.** Without it the
 *     child needs permission for its `Read` of the image, asks on stdin, and this process has
 *     already closed stdin — so it hangs *forever* rather than failing. Six questions ran for
 *     twenty-five minutes and were killed before anyone worked out that a hung VLM call and a slow
 *     one look identical from outside. Hence `TIMEOUT_MS` as well: an adapter that can hang has to
 *     be able to give up, or the gate it feeds can never be trusted to finish.
 *  2. **Every call boots a whole agent session.** It reloads the project's context and re-reads the
 *     image from disk, so a question costs seconds of overhead it should not. The images are
 *     downscaled before they are shown for the same reason. A direct Messages API call with the
 *     image inline is the right adapter and is a drop-in replacement for this function.
 *
 * The questions are asked CONCURRENTLY, which turns six serial calls into one wait.
 */
const VLM_TIMEOUT_MS = Number(arg('vlm-timeout', 300000));
/**
 * Two at a time. Six concurrent `claude -p` sessions on this box contend badly enough that three
 * of six questions returned nothing in 180 s while the other three answered in under 60; two at a
 * time answers all six. Measured, not guessed, and the flakiness is why `askVlm` has a timeout at
 * all rather than trusting the child to finish.
 */
const VLM_CONCURRENCY = Number(arg('vlm-concurrency', 2));
const askVlm = async (prompt, files) => {
  const body = `${prompt}\n\nImages to read, in order: ${files.join(' , ')}\n`
    + 'Reply with ONE JSON object and nothing else. No prose, no code fence.';
  /*
   * **`--disallowed-tools` is the load-bearing flag, and leaving it off invalidated a whole run.**
   *
   * `--allowed-tools Read` does NOT restrict anything once `--permission-mode bypassPermissions`
   * is set, and bypass is itself required or the child hangs on a permission prompt with stdin
   * closed. Given a shell, the model **stopped looking at the picture and started measuring it**:
   * it wrote `tools/scratch/pp-cross-tmp.mjs` into this repository, colour-thresholded the plate's
   * water ink along each tick line, found the channel crossings by peak detection — which is this
   * file's own algorithm, re-derived — and reported the result as what it saw.
   *
   * That is worse than a wrong answer. The model is in this design because it is an **outside**
   * reader of the picture, and a model that reimplements the inside is not a second opinion, it is
   * the same opinion with a longer latency. Every "the model agreed with the measurement" in a run
   * without this flag is unfalsifiable.
   *
   * So: Read only, everything else denied by name, and the run cleans up after itself below.
   */
  const cliArgs = ['-p', '--output-format', 'json',
    '--allowed-tools', 'Read',
    '--disallowed-tools', 'Bash,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,Task,Agent,WebFetch,WebSearch,TodoWrite,Skill',
    '--permission-mode', 'bypassPermissions'];
  if (VLM_MODEL) cliArgs.push('--model', VLM_MODEL);
  return await new Promise((resolve) => {
    const child = spawn('claude', cliArgs, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ error: `no answer in ${(VLM_TIMEOUT_MS / 1000).toFixed(0)} s — killed` });
    }, VLM_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ error: `claude CLI not runnable: ${e.message}` }));
    child.on('close', () => {
      try {
        const env = JSON.parse(out);
        const txt = String(env.result ?? '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
        const i = txt.indexOf('{');
        const j = txt.lastIndexOf('}');
        if (i < 0 || j < i) return finish({ error: 'no JSON in reply', raw: txt.slice(0, 400) });
        finish({
          answer: JSON.parse(txt.slice(i, j + 1)),
          model: Object.keys(env.modelUsage || {})[0] ?? null,
          costUsd: env.total_cost_usd ?? null,
        });
      } catch (e) {
        finish({ error: `unparseable CLI output: ${e.message}`, raw: out.slice(0, 400) });
      }
    });
    child.stdin.end(body);
  });
};

const interrogate = async (files, M) => {
  const qs = [];
  const push = (id, question, prompt, imgs, adjudicate) => qs.push({ id, question, prompt, imgs, adjudicate });

  /*
   * V1 asks about ONE tick, not five, and the reason is measured. The first version asked for a
   * five-part ordinal answer in a single call and returned nothing at all inside 180 s and again
   * inside 300 s, twice, while V2 — the same two images, one binary answer — came back in 37 s
   * both times. **The failure was the shape of the answer, not the images.** So V1 is now the
   * same shape as the question the model demonstrably can do: one place, two choices. The tick
   * chosen is the one the arithmetic says is worst, so the model is asked about the divergence
   * that matters rather than about an average.
   */
  const worstTick = (() => {
    if (!M.river || !M.river.bands.length) return { i: 2, n: TICKS[2] };
    let best = { i: 0, n: TICKS[0], d: -1 };
    TICKS.forEach((n, i) => {
      const band = M.river.bands.reduce((p, c) => (Math.abs(c.n - n) < Math.abs(p.n - n) ? c : p), M.river.bands[0]);
      if (Math.abs(band.n - n) <= 120 && Math.abs(band.departM) > best.d) best = { i, n, d: Math.abs(band.departM) };
    });
    return best;
  })();
  push('V1', `is the render's river east or west of the plate's, at tick T${worstTick.i + 1}?`,
    'Two maps of the same ground at the same scale and orientation, north up. Image A is a historical '
    + "archaeological plan; image B is a game engine's rendering of the same city. Both carry five orange "
    + `dashed horizontal lines labelled T1..T5, in the same places on both. Look ONLY at the line labelled `
    + `T${worstTick.i + 1}. On that line, find where the river crosses it — the pale blue-green channel in A, `
    + 'the solid blue band in B. Is the crossing in B further EAST (right) or further WEST (left) than the '
    + 'crossing in A? Answer "same" only if they are within one channel width. Schema: '
    + '{"answer":"east|west|same","confident":true|false}',
    [files['A-plate'], files['B-render']],
    (ans) => {
      if (!M.river || !M.river.bands.length) return { note: 'no plate channel extracted' };
      const n = worstTick.n;
      const band = M.river.bands.reduce((p, c) => (Math.abs(c.n - n) < Math.abs(p.n - n) ? c : p), M.river.bands[0]);
      const measured = Math.abs(band.n - n) > 120 ? 'off-plate'
        : Math.abs(band.departM) < TH.RIVER_DEPART_M ? 'same' : band.departM > 0 ? 'east' : 'west';
      const said = String(ans.answer ?? '').toLowerCase();
      return { tick: `T${worstTick.i + 1}`, n, said, measured, departM: band.departM, agree: said === measured };
    });

  push('V2', 'which side is the river\'s convex side, on each image?',
    'Two maps of the same ground, same scale, north up. A is a historical archaeological plan; B is a game '
    + 'engine render. Look only at the river between the lines labelled T5 and T1. A river that bulges out '
    + 'towards the left of the image is convex WEST; one that bulges towards the right is convex EAST. Report '
    + 'the convex side of the river\'s main bend in each image separately. Schema: '
    + '{"A":"west|east|straight","B":"west|east|straight","confident":true|false}',
    [files['A-plate'], files['B-render']],
    (ans) => {
      if (!M.river) return { note: 'no plate channel extracted' };
      return {
        saidA: String(ans.A ?? '').toLowerCase(), measuredA: M.river.bowConvexPlate, agreeA: String(ans.A ?? '').toLowerCase() === M.river.bowConvexPlate,
        saidB: String(ans.B ?? '').toLowerCase(), measuredB: M.river.bowConvexEngine, agreeB: String(ans.B ?? '').toLowerCase() === M.river.bowConvexEngine,
        bowPlateM: M.river.bowPlateM, bowEngineM: M.river.bowEngineM,
        signAgreesMeasured: M.river.curvatureSignAgrees,
      };
    });

  push('V3', 'how many building blocks overlap the water?',
    'One image: a game engine\'s plan of a Roman city. The wide blue band is a river. The tan and gold '
    + 'rectangles are buildings. Count the building rectangles that visibly OVERLAP the blue band — any part '
    + 'of the rectangle inside the water counts. Give your best count as an integer and pixel coordinates for '
    + 'the three clearest cases. Schema: {"count": <int>, "clearest": [{"x":<int>,"y":<int>}, ...]}',
    [files['B-render']],
    (ans) => ({ said: ans.count, measured: M.inWaterCount, measuredFully: M.inWaterFully,
      measuredInChannel: M.inChannelCount,
      agreeOrderOfMagnitude: Number.isFinite(+ans.count) && M.inWaterCount > 0
        && +ans.count >= M.inWaterCount / 3 && +ans.count <= M.inWaterCount * 3 }));

  push('V4', 'how many building blocks stand in a carriageway?',
    'One image: a game engine\'s plan of a Roman city. The grey-brown ribbons are streets. The tan and gold '
    + 'rectangles are buildings. Count the building rectangles that sit ON a street ribbon rather than beside '
    + 'it — the street visibly passes underneath the building. Give an integer count and pixel coordinates for '
    + 'the three clearest cases. Schema: {"count": <int>, "clearest": [{"x":<int>,"y":<int>}, ...]}',
    [files['B-render']],
    (ans) => ({ said: ans.count, measured: M.inRoadCount, measuredAreaM2: M.inRoadAreaM2,
      agreeOrderOfMagnitude: Number.isFinite(+ans.count) && M.inRoadCount > 0
        && +ans.count >= M.inRoadCount / 3 && +ans.count <= M.inRoadCount * 3 }));

  push('V6', "how many roads leave the render's main gate?",
    'One image: a game engine\'s plan of Roman roads and buildings, north up. The heavy dark red line across '
    + 'the top is the city wall. Find the one gate on it — the point where a road crosses the wall — and count '
    + 'the distinct grey-brown road ribbons that radiate from it southward, inside the walls. One integer. '
    + 'Schema: {"count": <int>, "confident": true|false}',
    [files['B-render']],
    (ans) => {
      const g = M.gateWays.reduce((p, c) => (c.engineWays > (p ? p.engineWays : -1) ? c : p), null);
      return { said: ans.count, measuredEngine: g ? g.engineWays : null, gate: g ? g.id : null,
        agree: Number.isFinite(+ans.count) && g && Math.abs(+ans.count - g.engineWays) <= TH.GATE_WAYS_TOL,
        note: 'This is the one question asked ONLY of the render, and it is a calibration rather than a '
          + 'finding: the engine\'s way count is known exactly, so the answer measures the MODEL. The plate '
          + 'side needs a way count off an inked plan and there is no machine ruler for it, so gate topology '
          + 'against the plate remains open.' };
    });

  push('V7', 'anything else, unquantified on purpose',
    'Two maps of the same ground, same scale, north up. A is Lanciani\'s archaeological plan of ancient Rome; '
    + 'B is a game engine\'s rendering of the same city in 271 AD. Name up to four ways in which B diverges '
    + 'from A that a numeric check comparing centrelines, footprint overlaps and monument positions would MISS. '
    + 'Be concrete about where. Schema: {"findings":[{"what":"...","where":"...","why_a_number_would_miss_it":"..."}]}',
    [files['A-plate'], files['B-render']],
    () => ({ note: 'UNQUANTIFIED BY DESIGN. Never gated. Read as a list of candidates for the next check.' }));

  let cursor = 0;
  const out = new Array(qs.length);
  const worker = async () => {
    for (;;) {
      const k = cursor++;
      if (k >= qs.length) return;
      out[k] = await run(qs[k]);
    }
  };
  const run = async (q) => {
    const t = Date.now();
    const res = await askVlm(q.prompt, q.imgs.filter(Boolean));
    const rec = { id: q.id, question: q.question, ms: Date.now() - t, model: res.model ?? null, costUsd: res.costUsd ?? null };
    if (res.error) { rec.error = res.error; if (res.raw) rec.raw = res.raw; }
    else {
      rec.answer = res.answer;
      // The adjudicator is the point of the whole stage and it must not be able to take the
      // run down: a model that answers in a shape nobody expected is a finding about the
      // question, not a crash.
      try { rec.adjudication = q.adjudicate(res.answer); }
      catch (e) { rec.adjudication = { error: `unadjudicable answer: ${e.message}` }; }
    }
    console.log(`[probe-plan] ${q.id} ${res.error ? `ERROR ${res.error}` : 'ok'} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    return rec;
  };
  await Promise.all(Array.from({ length: Math.max(1, VLM_CONCURRENCY) }, worker));
  return out;
};

// ===========================================================================
// Stage 7 — the verdict and the ranked list
// ===========================================================================
const grade = (M) => {
  const checks = [];
  const g = (id, name, ok, detail, rule) => checks.push({ id, name, pass: !!ok, skipped: ok === null, detail, rule });
  const R = M.river;
  g('P1', 'no solid stands in the river', M.inWaterCount <= TH.IN_WATER_MAX,
    `${M.inWaterCount} of ${M.solids} solids have wet ground under them (${M.inWaterFully} fully submerged, `
    + `${M.inChannelCount} inside the channel); ${M.inWaterAreaM2} m2 of footprint under water`,
    `<= ${TH.IN_WATER_MAX}`);
  g('P2', 'no solid stands in a carriageway', M.inRoadCount <= TH.IN_ROAD_MAX,
    `${M.inRoadCount} of ${M.solids} solids overlap a carriageway, ${M.inRoadAreaM2} m2 total; `
    + `${M.inRoadOnArmature} of them on the named armature and ${M.inRoadOnDistrictLanesOnly} on district `
    + `lanes only; by class ${JSON.stringify(M.inRoadByClass)}; by kind ${JSON.stringify(M.inRoadByKind)}`,
    `<= ${TH.IN_ROAD_MAX}`);
  g('P3', 'monuments stand where the survey put them', M.dispMeanRealM !== null
    && M.dispMeanRealM <= TH.DISPLACE_MEAN_M && M.dispWorstRealM <= TH.DISPLACE_WORST_M,
    `mean ${M.dispMeanRealM} real m / worst ${M.dispWorstRealM} real m (${M.disp[0] ? M.disp[0].name : '-'}); `
    + `in world metres that is mean ${M.dispMeanWorldM} / worst ${M.dispWorstWorldM}`,
    `mean <= ${TH.DISPLACE_MEAN_M} m, worst <= ${TH.DISPLACE_WORST_M} m`);
  if (R) {
    g('P4', "the river's centreline agrees with the plate's, over the city",
      R.cityFracOver !== null && R.cityFracOver <= TH.RIVER_DEPART_FRAC,
      `${R.cityBandsOver} of ${R.cityBandsCompared} 100 m bands in n ${R.cityReach[0]}..${R.cityReach[1]} `
      + `depart by more than ${TH.RIVER_DEPART_M} m; worst ${R.cityWorstDepartM} m at n=${R.cityWorstAtN}; `
      + `mean |departure| ${R.cityMeanAbsDepartM} m. Over the whole compared span `
      + `(n ${R.nRange[0]}..${R.nRange[1]}): ${R.bandsOverThreshold} of ${R.bandsCompared}, worst `
      + `${R.worstDepartM} m at n=${R.worstAtN}`,
      `<= ${(TH.RIVER_DEPART_FRAC * 100).toFixed(0)} % of city bands over ${TH.RIVER_DEPART_M} m`);
    g('P5', "the great bend goes the same WAY as the plate's", R.curvatureSignAgrees,
      `over n ${R.reach[0]}..${R.reach[1]}: the plate bows ${R.bowPlateM} m (convex ${R.bowConvexPlate}), `
      + `the engine ${R.bowEngineM} m (convex ${R.bowConvexEngine})`,
      'same sign of mid-chord departure');
    g('P6', "the great bend turns in the same PLACE as the plate's",
      R.apexShiftN !== null && Math.abs(R.apexShiftN) <= TH.APEX_SHIFT_M,
      `the plate's westernmost point is at n ${R.apexPlateN} (e ${R.apexPlateE}); the engine's at `
      + `n ${R.apexEngineN} (e ${R.apexEngineE}) — ${R.apexShiftN} m of latitude, ${R.apexShiftE} m of easting`,
      `|apex shift| <= ${TH.APEX_SHIFT_M} m of survey north`);
    g('P7', "the river's LOCAL curvature has the plate's sign everywhere in the city",
      R.curvatureLongestDisagreeRun <= 1,
      `${R.curvatureDisagreeBands} of ${R.curvatureJudgedBands} judged bands disagree in the sign of `
      + `d2e/dn2; longest run ${R.curvatureLongestDisagreeRun} bands`
      + (R.curvatureDisagreeSpans.length ? `; spans n ${R.curvatureDisagreeSpans.map((x) => `${x[0]}..${x[1]}`).join(', ')}` : ''),
      'no run of 2 or more consecutive 100 m bands with opposite curvature');
  } else {
    for (const id of ['P4', 'P5', 'P6', 'P7']) g(id, 'river checks', null, 'no channel extracted from this plate', '-');
  }
  g('P8', 'no solid is dry on the engine and in the water on the plate',
    M.reg.crossChannelFrac !== null && M.reg.crossChannelFrac <= TH.CROSS_CHANNEL_FRAC,
    `${((M.reg.crossChannelFrac ?? 0) * 100).toFixed(2)} % of built footprint area `
    + `(${M.reg.crossChannelM2} of ${M.reg.comparedAreaM2} m2) changes which side of the river it is on `
    + `between the plate's centreline and the engine's. Context: `
    + `${((M.reg.westOfChannelFrac ?? 0) * 100).toFixed(0)} % of the city is west of the plate's channel and `
    + `${((M.reg.westOfOwnChannelFrac ?? 0) * 100).toFixed(0)} % west of the engine's — both large and nearly `
    + 'equal, because *Regio XIV Transtiberim* is inside Aurelian\'s circuit and the engine builds it.',
    `<= ${(TH.CROSS_CHANNEL_FRAC * 100).toFixed(0)} % of built footprint area`);
  if (R) {
    g('P10', "the channel is the plate's width, in real metres",
      R.widthRatio !== null && Math.abs(R.widthRatio - 1) <= TH.WIDTH_RATIO_TOL,
      `the engine's channel is ${R.engineWidthM} real m wide perpendicular to its own course (median over `
      + `the city reach), against the plate's ${R.plateWidthMedianM} m — a ratio of ${R.widthRatio}. `
      + `RIVER_HALF_WIDTH is ${R.engineWidthWorldM / 2} WORLD metres, which is right, and a constant world `
      + 'half-width is a variable real width under an anisotropic projection.',
      `|ratio - 1| <= ${TH.WIDTH_RATIO_TOL}`);
  } else {
    g('P10', 'channel width', null, 'no channel extracted from this plate', '-');
  }
  g('P9', "the road network leaves each gate the plate's way count", null,
    `engine: ${M.gateWays.map((x) => `${x.id} ${x.engineWays}`).join(', ')}. The plate side has no machine `
    + 'ruler, so this is only estimable with --vlm, and is reported unadjudicated either way.', '-');
  return checks;
};

/**
 * The ranked list, which is the output a judging loop actually uses: *a ranked, specific
 * divergence list beats a score.* Each row is one finding, in metres, with where it is and
 * which file to open, so a builder can fix that thing rather than a number out of ten.
 *
 * `sev` is a sort key and deliberately NOT a score: the finding's own magnitude in metres with
 * a class offset, so a whole-city registration fault outranks a 300 m river departure which
 * outranks a count of blocks. It is never printed.
 */
const rank = (M) => {
  const rows = [];
  const R = M.river;
  if (M.reg.crossChannelFrac !== null && M.reg.crossChannelFrac > TH.CROSS_CHANNEL_FRAC) {
    rows.push({
      sev: 5000 + M.reg.crossChannelFrac * 1000,
      what: 'buildings that are dry in the engine and in the Tiber on the plate',
      number: `${(M.reg.crossChannelFrac * 100).toFixed(2)} % of built footprint area `
        + `(${M.reg.crossChannelM2} m2) changes which bank it is on between the two centrelines. Each square `
        + 'metre is either a building the real city could not have had, or real river the engine has built over.',
      where: 'the strip between the two centrelines; worst where the departure is worst',
      fix: 'src/terrain/topography.ts TIBER_PATH',
    });
  }
  /*
   * Ranked but never gated. This is the largest single divergence in the pictures and the one
   * a builder should look at first, and it is also the one this instrument is least entitled
   * to fail: the map deliberately carries off-circuit backdrop and nothing here can tell
   * backdrop from sprawl. So it is stated with its comparison and left to a human.
   */
  rows.push({
    sev: 400 + (M.reg.hullOverAurelian ?? 0) * 10,
    what: 'the built fabric covers more real ground than the whole Aurelian city [UNGATED]',
    number: `the convex hull of every built footprint is ${M.reg.hullAreaKm2} km2 of real ground, `
      + `${M.reg.hullOverAurelian}x Aurelian's enclosed 13.73 km2 (1,373 ha over a 19 km circuit); `
      + `extent ${M.reg.extentKmE} km east-west by ${M.reg.extentKmN} km north-south, against about `
      + '4.5 x 4.0 km for the real circuit',
    where: `survey e ${M.reg.extentE[0]}..${M.reg.extentE[1]}, n ${M.reg.extentN[0]}..${M.reg.extentN[1]}`,
    fix: 'src/city/rome/layout.ts DISTRICT_PLAN — the quarters are sized in survey metres and then '
      + 'inflated by 2.05x east-west and 3.5x north-south at line 723',
  });
  if (R && R.curvatureSignAgrees === false) {
    rows.push({
      sev: 3000,
      what: "the Tiber's great bend goes the wrong WAY",
      number: `the plate bows ${R.bowPlateM} m convex ${R.bowConvexPlate}; the engine bows ${R.bowEngineM} m `
        + `convex ${R.bowConvexEngine}`,
      where: `survey n ${R.reach[0]} to ${R.reach[1]}`,
      fix: 'src/terrain/topography.ts TIBER_PATH',
    });
  }
  if (R && R.curvatureLongestDisagreeRun > 1) {
    rows.push({
      sev: 2000 + R.curvatureLongestDisagreeRun * 10,
      what: "the Tiber's curvature is inverted over part of the city reach",
      number: `${R.curvatureDisagreeBands} of ${R.curvatureJudgedBands} judged 100 m bands have the opposite `
        + `sign of d2e/dn2; the longest run is ${R.curvatureLongestDisagreeRun} bands`,
      where: R.curvatureDisagreeSpans.map((x) => `survey n ${x[0]}..${x[1]}`).join('; ') || 'scattered',
      fix: 'src/terrain/topography.ts TIBER_PATH',
    });
  }
  if (R && R.apexShiftN !== null && Math.abs(R.apexShiftN) > TH.APEX_SHIFT_M) {
    rows.push({
      sev: 800 + Math.abs(R.apexShiftN),
      what: "the Tiber's great bend turns in the wrong PLACE",
      number: `the plate's westernmost point is at survey n ${R.apexPlateN}, the engine's at n ${R.apexEngineN} `
        + `— the apex is ${Math.abs(R.apexShiftN)} m too far ${R.apexShiftN < 0 ? 'south' : 'north'} and `
        + `${Math.abs(R.apexShiftE)} m too far ${R.apexShiftE < 0 ? 'west' : 'east'}`,
      where: `survey n ${R.reach[0]}..${R.reach[1]} — the Campus Martius bow`,
      fix: 'src/terrain/topography.ts TIBER_PATH',
    });
  }
  if (R && R.cityWorstDepartM !== null) {
    rows.push({
      sev: R.cityWorstDepartM,
      what: "the Tiber's centreline departs from the plate through the city",
      number: `up to ${R.cityWorstDepartM} m; ${R.cityBandsOver} of ${R.cityBandsCompared} 100 m bands over `
        + `${TH.RIVER_DEPART_M} m; mean |departure| ${R.cityMeanAbsDepartM} m. Channel width: plate median `
        + `${R.plateWidthMedianM} m, engine ${R.engineWidthM} m.`,
      where: `worst at survey n ${R.cityWorstAtN}; gated over n ${R.cityReach[0]}..${R.cityReach[1]}`,
      fix: 'src/terrain/topography.ts TIBER_PATH',
    });
  }
  if (R && R.widthRatio !== null && Math.abs(R.widthRatio - 1) > TH.WIDTH_RATIO_TOL) {
    rows.push({
      sev: 600 + Math.abs(R.engineWidthM - R.plateWidthMedianM),
      what: `the Tiber is ${R.widthRatio}x the plate's width in real metres`,
      number: `${R.engineWidthM} real m perpendicular, median over the city reach, against the plate's `
        + `${R.plateWidthMedianM} m. RIVER_HALF_WIDTH = ${R.engineWidthWorldM / 2} world m is the right `
        + 'number for a 94 m river and it is applied in the compressed frame, so the real width swings '
        + 'with the channel\'s bearing: widest exactly at the bow, where the course is steepest.',
      where: `survey n ${R.cityReach[0]}..${R.cityReach[1]}`,
      fix: 'src/terrain/topography.ts RIVER_HALF_WIDTH — a constant world half-width cannot hold a '
        + 'constant real width under KX != KZ; it has to vary with riverCurvature(z)',
    });
  }
  rows.push({
    sev: 300,
    what: 'the defended circuit is an arc, not a circuit [UNGATED — this is the design]',
    number: `${M.reg.circuitRealKm} km of defended line in real metres, ${M.reg.circuitClosed ? 'closed' : 'NOT closed'}, `
      + `against Aurelian's ${M.reg.aurelianCircuitKm} km enclosing 1,373 ha`,
    where: 'the northern front only',
    fix: 'nothing — docs/ROME.md models the assaulted front by design. Stated so a judge reading the '
      + 'overlay has the number beside the one red line across the top.',
  });
  if (M.dispWorstRealM) {
    rows.push({
      sev: M.dispWorstRealM,
      what: 'monuments displaced off their surveyed position by resolveOverlaps',
      number: `mean ${M.dispMeanRealM} real m, worst ${M.dispWorstRealM} real m over ${M.disp.length} monuments `
        + `(in world metres, mean ${M.dispMeanWorldM} / worst ${M.dispWorstWorldM} — the real figure is the one `
        + `the plate can see, and it is ${(M.dispMeanRealM / Math.max(1e-9, M.dispMeanWorldM)).toFixed(1)}x larger `
        + 'because north-south is the axis compressed hardest)',
      where: M.disp.slice(0, 5).map((d) => `${d.name} ${d.realM} m bearing ${d.bearing}`).join('; '),
      fix: 'src/city/rome/layout.ts resolveOverlaps',
    });
  }
  if (M.inWaterCount) {
    rows.push({
      sev: 200 + M.inWaterCount,
      what: 'solids standing in the river',
      number: `${M.inWaterCount} of ${M.solids} (${M.inWaterFully} fully submerged, ${M.inChannelCount} inside `
        + `the channel), ${M.inWaterAreaM2} m2 of footprint under water`,
      where: M.inWater.slice(0, 5).map((r) => `${r.kind} (e ${r.e}, n ${r.n})`).join('; '),
      fix: 'src/city/rome/fabric.ts districtMask, and the KeepOut built in src/city/rome/plan.ts — neither takes the channel as an exclusion',
    });
  }
  if (M.inRoadCount) {
    rows.push({
      sev: 150 + M.inRoadCount / 5,
      what: 'solids standing in a carriageway',
      number: `${M.inRoadCount} of ${M.solids}, ${M.inRoadAreaM2} m2; ${M.inRoadOnArmature} on the named `
        + `armature and ${M.inRoadOnDistrictLanesOnly} on district lanes only; by kind `
        + `${JSON.stringify(M.inRoadByKind)}, by class ${JSON.stringify(M.inRoadByClass)}`,
      where: M.inRoad.slice(0, 5).map((r) => `${r.kind} (e ${r.e}, n ${r.n}) ${(r.fracOfFootprint * 100).toFixed(0)} % covered`).join('; '),
      fix: 'src/city/rome/layout.ts deflect(), and resolveOverlaps which pushes monuments onto roads after the roads are laid',
    });
  }
  rows.push({
    sev: 0.1,
    what: 'the frame itself cannot match a plan (not a bug; a bound on this instrument)',
    number: `KX/KZ = ${M.aniso}, so every footprint un-projects ${M.aniso}x too long north-south, and a bearing `
      + "in the engine's own plan view can be wrong by up to 26.6 degrees",
    where: 'the whole map',
    fix: 'nothing here. Shape and size are probe-fabric G12/G13, in world metres.',
  });
  return rows.sort((a, b) => b.sev - a.sev);
};

// ===========================================================================
// main
// ===========================================================================
const plate = await plateStage();

// The plate's inked ancient city, for the gross-registration check. Lanciani draws
// the ancient plan in neutral grey/black and the 1901 modern city in red, so a
// "neutral and dark" cut isolates the ancient fabric. Restricted to the crop.
plate.ink = (() => {
  let n = 0, se = 0, sn = 0;
  for (let py = CROP.y; py < CROP.y + CROP.h; py += 3) {
    for (let px = CROP.x; px < CROP.x + CROP.w; px += 3) {
      const i = (py * plate.raw.w + px) * plate.raw.ch;
      const r = plate.raw.data[i], g = plate.raw.data[i + 1], b = plate.raw.data[i + 2];
      if (Math.abs(r - g) > 14 || Math.abs(g - b) > 14) continue;   // not neutral
      if ((r + g + b) / 3 > 165) continue;                          // not dark
      const en = enOfPx(px, py);
      n++; se += en.e; sn += en.n;
    }
  }
  return { count: n, e: n ? se / n : 0, n: n ? sn / n : 0 };
})();
console.log(`[probe-plan] plate inked-city centroid: e ${plate.ink.e.toFixed(0)}, n ${plate.ink.n.toFixed(0)} `
  + `(${plate.ink.count} sampled neutral-dark pixels)`);
console.log(`[probe-plan] alignment: affine scale ${ALIGN.affineScaleX}/${ALIGN.affineScaleY} m/px vs `
  + `${ALIGN.groundPerPxE}/${ALIGN.groundPerPxN} from the recorded extent `
  + `(${ALIGN.scaleDiffPctX} %/${ALIGN.scaleDiffPctY} %); rotation ${ALIGN.affineRotationDeg} deg vs `
  + `${ALIGN.convergenceDeg} deg convergence; end-to-end residual ${ALIGN.endToEndResidualM} m at the plate edge`);

if (ONLY === 'plate') {
  mkdirSync(OUT, { recursive: true });
  const centreline = (plate.channel ?? []).filter((r) => r.mid !== null)
    .filter((_, i) => i % 8 === 0)
    .map((r) => { const en = enOfPx(r.mid, r.py); return [r1(en.n), r1(en.e), r1(r.widthPx * M_PER_PX)]; });
  writeFileSync(path.join(OUT, 'plate.json'), JSON.stringify({
    ALIGN, CROP, mPerPx: M_PER_PX, ink: plate.ink,
    channelRows: plate.channel ? plate.channel.filter((r) => r.mid !== null).length : 0,
    centreline_n_e_widthM: centreline,
  }, null, 2));
  console.log(`[probe-plan] --only=plate: wrote ${path.relative(ROOT, path.join(OUT, 'plate.json'))} and stopped before the boot.`);
  process.exit(0);
}

const built = await bootAndRead();
const frame = makeFrame(built);
console.log(`[probe-plan] frame from the page: KX ${frame.KX} KZ ${frame.KZ} X0 ${frame.X0.toFixed(3)} `
  + `Z0 ${frame.Z0.toFixed(3)}; anisotropy KX/KZ ${(frame.aniso).toFixed(3)}`);

const runs = [];
const ladder = LADDER ? [0, 25, 50, 100, 200, 400] : [null];
for (const step of ladder) {
  const off = step === null ? OFFSET : { e: step, n: 0 };
  const mir = step === null ? MIRROR : false;
  const b2 = perturb(built, frame, off, mir);
  const M = measure(b2, frame, plate);
  const checks = grade(M);
  runs.push({ offset: off, mirror: mir, M, checks, ranked: rank(M) });
}
if (LADDER && MIRROR) {
  const b2 = perturb(built, frame, { e: 0, n: 0 }, true);
  const M = measure(b2, frame, plate);
  runs.push({ offset: { e: 0, n: 0 }, mirror: true, M, checks: grade(M), ranked: rank(M) });
}

const primary = runs[0];
const files = await renderStage(perturb(built, frame, primary.offset, primary.mirror), frame, plate, primary.M, TAG);
console.log(`[probe-plan] wrote ${Object.keys(files).length} plates to ${OUT}`);

let vlm = null;
let vlmImages = null;
let vlmWroteFiles = null;
if (VLM !== 'none') {
  /*
   * Downscaled copies for the model, and the reason is measured: at the plate's own
   * 3718 x 2549 the six questions took over ten minutes, because every call re-reads a
   * multi-megabyte PNG. At 1500 px the ground sampling is 4.2 real metres per pixel, which is
   * far finer than any distinction the model is being asked to make — east or west of a 100 m
   * channel, a count of blocks, which side a bend is convex on — so nothing is lost that is
   * being used. It would be lost if the model were being asked WHERE something is to the metre,
   * and it never is: that is what the arithmetic is for.
   */
  const VW = Number(arg('vlm-width', 1500));
  const dir = path.join(OUT, 'vlm');
  mkdirSync(dir, { recursive: true });
  const small = {};
  for (const [k, f] of Object.entries(files)) {
    const out = path.join(dir, `${k}-${TAG}-${VW}.png`);
    await sharp(f).resize(VW).png({ compressionLevel: 9 }).toFile(out);
    small[k] = out;
  }
  console.log(`[probe-plan] interrogating (${VLM}) at ${VW} px `
    + `(${(CROP.w * M_PER_PX / VW).toFixed(1)} real m per pixel) — six questions, each with a checkable answer`);
  /*
   * Belt and braces on the paragraph above: list what is in the repo before the model is asked
   * anything and again afterwards, and print the difference. A model that finds a way to write is
   * a finding about this adapter, and the run should say so out loud rather than leave files for
   * somebody to trip over in `git status`.
   */
  const snapshot = () => {
    try {
      return new Set(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean));
    } catch { return null; }
  };
  const before = snapshot();
  vlm = await interrogate(small, primary.M);
  vlmImages = small;
  const after = snapshot();
  if (before && after) {
    const nw = [...after].filter((x) => !before.has(x));
    vlmWroteFiles = nw;
    if (nw.length) {
      console.error(`[probe-plan] !! the VLM stage changed ${nw.length} path(s) in the repo despite `
        + '--disallowed-tools. Every answer in this run is suspect: a model with a shell measures '
        + 'instead of looking.\n  ' + nw.slice(0, 12).join('\n  '));
    }
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const sha = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '?'; } })();
const L = console.log;
L('');
L('='.repeat(100));
L(`probe-plan  map=${MAP}  plate=${PLATE.id}  commit=${sha}`
  + (primary.mirror ? '  [MIRRORED — negative control]' : '')
  + (primary.offset.e || primary.offset.n ? `  [OFFSET ${primary.offset.e},${primary.offset.n} real m — negative control]` : ''));
L('='.repeat(100));
L('');
L('ALIGNMENT');
L(`  plate                ${PLATE.name}`);
L(`  frame                survey metres east/north of the Temple of Jupiter OM, 41.8925 N 12.4823 E`);
L(`  scale                ${M_PER_PX.toFixed(4)} real m per plate pixel; crop ${CROP.w} x ${CROP.h} px `
  + `= ${(CROP.w * M_PER_PX / 1000).toFixed(2)} x ${(CROP.h * M_PER_PX / 1000).toFixed(2)} km`);
L(`  affine vs extent     scale ${ALIGN.scaleDiffPctX} % / ${ALIGN.scaleDiffPctY} %; rotation `
  + `${ALIGN.rotationDiffDeg} deg (${ALIGN.affineRotationDeg} measured vs ${ALIGN.convergenceDeg} predicted)`);
L(`  residual             ${ALIGN.endToEndResidualM} m at the plate edge, end to end. The quoted `
  + `${ALIGN.quotedFitResidualM} m is the affine's fit against its own EPSG inverse, not this.`);
L(`  RESOLUTION LIMIT     nothing below ${Math.ceil(ALIGN.endToEndResidualM * 2)} m should be read as a `
  + 'divergence. Every threshold here is at least 8x that.');
L('');
L(`RANKED DIVERGENCES  (${primary.ranked.length})`);
primary.ranked.forEach((r, i) => {
  L(`  ${String(i + 1).padStart(2)}. ${r.what}`);
  L(`      ${r.number}`);
  L(`      where: ${r.where}`);
  L(`      look at: ${r.fix}`);
});
L('');
L('THE GATE');
for (const c of primary.checks) {
  L(`  ${c.id}  ${c.skipped ? 'SKIP' : c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  L(`        ${c.detail}`);
  L(`        threshold: ${c.rule}`);
}
const gated = primary.checks.filter((c) => !c.skipped);
const passed = gated.filter((c) => c.pass).length;
L('');
L(`  VERDICT  ${passed}/${gated.length}` + (primary.checks.length - gated.length ? `  (${primary.checks.length - gated.length} skipped)` : ''));
L('');
if (primary.M.river) {
  const R = primary.M.river;
  L('THE RIVER, BAND BY BAND  (survey north, real metres; + = the engine is EAST of the plate)');
  L('  the gated reach is n ' + R.cityReach[0] + '..' + R.cityReach[1] + ', marked *; d2e/dn2 is the local curvature');
  L('      n     plate e   engine e    depart   side    curv plate  curv engine  sign');
  for (const b of R.bands) {
    const inCity = b.n >= R.cityReach[0] && b.n <= R.cityReach[1];
    L(`  ${inCity ? '*' : ' '}${String(b.n).padStart(6)}   ${String(b.plateE).padStart(9)}  ${String(b.engineE).padStart(9)}  `
      + `${String(b.departM).padStart(8)}   ${b.side.padEnd(5)}  ${String(b.curvPlate ?? '-').padStart(10)}  `
      + `${String(b.curvEngine ?? '-').padStart(11)}  ${b.curvAgrees === false ? 'OPPOSITE' : b.curvAgrees === true ? 'same' : '-'}`
      + `${Math.abs(b.departM) > TH.RIVER_DEPART_M ? '  <<' : ''}`);
  }
  L(`  channel width, real metres perpendicular: plate median ${R.plateWidthMedianM} m, engine `
    + `${R.engineWidthM} m (ratio ${R.widthRatio}). The engine's RIVER_HALF_WIDTH is `
    + `${R.engineWidthWorldM / 2} WORLD m, which is a different unit and not comparable with the plate.`);
  L(`  bow, n ${R.reach[0]}..${R.reach[1]}: plate ${R.bowPlateM} m convex ${R.bowConvexPlate}; `
    + `engine ${R.bowEngineM} m convex ${R.bowConvexEngine}`);
  L(`  apex (westernmost point of the bow): plate n ${R.apexPlateN} e ${R.apexPlateE}; `
    + `engine n ${R.apexEngineN} e ${R.apexEngineE}; shift ${R.apexShiftN} m north, ${R.apexShiftE} m east`);
  L('');
}
L(`MONUMENT DISPLACEMENT  (real metres off the surveyed position; ${primary.M.disp.length} hard monuments)`);
for (const d of primary.M.disp.slice(0, 12)) {
  L(`  ${d.name.padEnd(34)} ${String(d.realM).padStart(7)} real m  (${String(d.worldM).padStart(6)} world m)  `
    + `bearing ${String(d.bearing).padStart(5)}  dE ${String(d.dE).padStart(7)}  dN ${String(d.dN).padStart(7)}`);
}
L('');
L('CROSS-CHECKS ON THE INSTRUMENT ITSELF');
L(`  water test, page vs node        ${primary.M.waterAgreement.pageWet} (terrain.heightAt) vs `
  + `${primary.M.waterAgreement.nodeWet} (heightfield min-downsampled 3:1) solids wet — `
  + `${primary.M.waterAgreement.conservativeAsExpected
    ? `node is conservative by +${primary.M.waterAgreement.excess}, which is the correct direction`
    : 'NODE IS LOSING WATER, and that direction hides a fault: instrument bug'}`);
L(`  registration, reported not gated  built centroid (e ${primary.M.reg.builtCentroidE}, `
  + `n ${primary.M.reg.builtCentroidN}) is ${primary.M.reg.centroidOffsetM} m from the plate's neutral-ink `
  + `centroid (e ${primary.M.reg.plateCentroidE}, n ${primary.M.reg.plateCentroidN}). Soft ruler: the ink `
  + "includes the Janiculum's and the Vatican's hill hachure. P8 is the gated form.");
L(`  drawn vertices plotted         ${built.drawnVerts} from families ${Object.keys(built.drawnFamilies).join(', ')}`);
L(`  page errors                    ${built.pageErrors.length ? built.pageErrors.join(' | ') : 'none'}`);
if (built.stats) {
  L(`  city stats                     ${built.stats.chunks} chunks, ${built.stats.triangles} triangles, `
    + `footprintOverlaps ${built.stats.footprintOverlaps}, fabricOverlaps ${built.stats.fabricOverlaps}`);
}
L('');
if (LADDER) {
  L('THE RESOLUTION LADDER  (one boot, the city shoved east by N real metres afterwards)');
  L('   shove    P1 wet  P2 road  P3 disp  P4 river  P5 way  P6 apex  P7 curv  P8 cross | '
    + 'worst river depart | mean displacement | % crossing the channel');
  for (const r of runs) {
    const c = Object.fromEntries(r.checks.map((x) => [x.id, x.skipped ? '-' : x.pass ? 'pass' : 'FAIL']));
    const label = r.mirror ? 'mirror' : `${r.offset.e} m`;
    const rr = r.M.river;
    L(`  ${label.padStart(7)}  ${String(c.P1).padStart(6)}  ${String(c.P2).padStart(7)}  `
      + `${String(c.P3).padStart(7)}  ${String(c.P4).padStart(8)}  ${String(c.P5).padStart(6)}  `
      + `${String(c.P6).padStart(7)}  ${String(c.P7).padStart(7)}  ${String(c.P8).padStart(7)} | `
      + `${String(rr ? rr.cityWorstDepartM : '-').padStart(7)} m  ${String(r.M.dispMeanRealM).padStart(7)} m  `
      + `${((r.M.reg.crossChannelFrac ?? 0) * 100).toFixed(2)} %`);
  }
  L('');
  L('  SENSITIVITY, which is what the ladder is actually for. The baseline is already failing every');
  L('  gate, so pass/fail cannot show resolution; the measured QUANTITIES can. Delta from the 0 m run:');
  const base = runs[0];
  L('   shove   d(mean displacement)   d(worst river depart)   d(% crossing channel)     moved?');
  for (const r of runs.slice(1)) {
    if (r.mirror) continue;
    const dD = r.M.dispMeanRealM - base.M.dispMeanRealM;
    const dR = (r.M.river && base.M.river) ? r.M.river.cityWorstDepartM - base.M.river.cityWorstDepartM : NaN;
    const dW = ((r.M.reg.crossChannelFrac ?? 0) - (base.M.reg.crossChannelFrac ?? 0)) * 100;
    const lim = ALIGN.endToEndResidualM * 2;
    const moved = [Math.abs(dD) > lim ? 'displacement' : null, Math.abs(dR) > lim ? 'river' : null]
      .filter(Boolean).join(' + ') || 'nothing above the alignment residual';
    L(`  ${String(r.offset.e + ' m').padStart(6)}   ${dD.toFixed(1).padStart(20)}   ${dR.toFixed(1).padStart(21)}   `
      + `${dW.toFixed(1).padStart(26)}   ${moved}`);
  }
  L(`  The instrument's own resolution is ${(ALIGN.endToEndResidualM * 2).toFixed(1)} m (twice the alignment`);
  L('  residual). Anything above that line is a real shove; anything below it is the frame breathing.');
  L('');
}
if (vlm) {
  L('THE VISION MODEL  (locates; never grades)');
  L('  Measured competence, with the model restricted to Read and NOTHING else. That restriction is');
  L('  the whole measurement: given a shell it wrote pixel-analysis scripts into this repo and');
  L('  computed the answers instead of looking, and the numbers below are visibly different from the');
  L('  ones it produced that way. Read this table as "what a pair of eyes can do", which is the only');
  L('  thing worth knowing about a model in an instrument that already has arithmetic.');
  L('');
  L('    RELIABLE   which side of the plate the render\'s river is on at a named tick (V1) and which side');
  L('               a bend is convex on (V2). Right every run, both images, 27-54 s. A 212 m departure');
  L('               reads as "west". This is the shape to ask in: one place, two choices, one call.');
  L('    RELIABLE   the open question (V7), the highest-value call in the list and the only one that has');
  L('               found anything the battery missed. It said the channel "balloons to roughly three');
  L('               times Lanciani\'s width" — measured 2.9x — while the battery underneath was comparing');
  L('               world metres with real metres and reporting agreement. P10 exists because of it.');
  L('    ROUGH      a small count of large distinct features. V6 said 2 roads leaving the gate against a');
  L('               measured 3, and reported itself not confident. Off by one, inside the +-1 tolerance,');
  L('               and note that the run WITH a shell said exactly 3 — which is how the shell was found.');
  L('    UNRELIABLE counting many small repeated objects (V3, V4). Blocks in the water: 11, 12, 12, 12');
  L('               against a measured 71. Blocks in a carriageway: 6, 7, 6 against 361. A 6x and a 60x');
  L('               undercount, stable across runs, so a bias and not noise. Never read a VLM count as a');
  L('               quantity — it points at a region and the arithmetic supplies the number.');
  L('    FRAGILE    multi-part answers. V1 first asked about five ticks in one call and returned nothing');
  L('               inside 180 s and again inside 300 s, twice, while V2 — the same two images, one');
  L('               binary answer — came back in 37 s. The shape of the ANSWER costs, not the images.');
  L('               Six concurrent calls contend badly here; two at a time answers all six in ~3 min.');
  if (vlmWroteFiles && vlmWroteFiles.length) {
    L(`    !! THIS RUN IS SUSPECT: the model changed ${vlmWroteFiles.length} path(s) in the repo, so its`);
    L('       answers may be computed rather than seen. Treat every "agree" above as unproven.');
  }
  for (const q of vlm) {
    L(`  ${q.id}  ${q.question}`);
    if (q.error) { L(`      ERROR ${q.error}`); continue; }
    L(`      said     ${JSON.stringify(q.answer).slice(0, 600)}`);
    L(`      measured ${JSON.stringify(q.adjudication).slice(0, 900)}`);
  }
  L('');
  const un = vlm.find((q) => q.id === 'V7');
  if (un && un.answer && Array.isArray(un.answer.findings)) {
    L('UNQUANTIFIED (V7) — candidates for the next check, never gated');
    for (const f of un.answer.findings) L(`  - ${f.what} [${f.where}]  (a number would miss it because: ${f.why_a_number_would_miss_it})`);
    L('');
  }
}
L('WHAT THIS CANNOT DO');
L('  - it cannot grade a footprint\'s SIZE or SHAPE. KX/KZ = ' + primary.M.aniso + ', so un-projecting a');
L('    footprint stretches it by that factor. probe-fabric G12/G13 own size, in world metres.');
L('  - it cannot separate the alignment residual from a vision model\'s localisation error in V5.');
L('  - it has no machine ruler for a NAMED monument on the plate. The plate\'s only machine-readable');
L('    layer is water and neutral ink. Names still need a hand-digitised outline per monument.');
L('  - the plate is Lanciani\'s 1901 compilation of every period at once. It cannot date a building,');
L('    so "is this in the city in 271 AD" is not a question this instrument answers.');
L('');
L(`  images: ${Object.values(files).map((f) => path.relative(ROOT, f)).join('  ')}`);

mkdirSync(OUT, { recursive: true });
const reportFile = path.join(OUT, `report-${TAG}.json`);
writeFileSync(reportFile, JSON.stringify({
  tool: 'probe-plan', commit: sha, map: MAP, plate: PLATE.id, tag: TAG,
  align: ALIGN, crop: CROP, mPerPx: M_PER_PX, ticks: TICKS,
  frame: { KX: frame.KX, KZ: frame.KZ, X0: frame.X0, Z0: frame.Z0, aniso: frame.aniso },
  plateInk: plate.ink,
  runs: runs.map((r) => ({
    offset: r.offset, mirror: r.mirror, checks: r.checks, ranked: r.ranked,
    // The full offender lists are hundreds of rows and a ladder run has seven of them.
    // Top 60 each, sorted worst first, which is what a builder reads.
    M: { ...r.M, inWater: r.M.inWater.slice(0, 60), inRoad: r.M.inRoad.slice(0, 60) },
  })),
  vlm, vlmImages, vlmWroteFiles, files, drawnFamilies: built.drawnFamilies, cityStats: built.stats,
}, null, 2));
L(`  report: ${path.relative(ROOT, reportFile)}`);

process.exit(gated.length && passed === gated.length ? 0 : 1);
