/**
 * rome-roads — the Rome road survey's own instrument.
 *
 * `docs/ROME-FABRIC.md` §4.2 says every ranked way must be **authored in survey metres from
 * the plates and never deflected**. That needs two things this repo did not have:
 *
 *  1. **A georeference for the only plate that names the streets.** The Lanciani raster in
 *     `src/city/overlay.ts` is georectified to 1.26 m over 7 km and carries no street names;
 *     Shepherd 1923 names every consular road, every gate, the Alta Semita, the Vicus Longus,
 *     the Vicus Patricius, the Clivus Suburanus, the Argiletum, the Via Tecta and the Via Lata
 *     ("Broad Way") — and is not georeferenced at all. `SHEP` below is a plain 6-parameter
 *     affine from Shepherd pixels to the survey frame, **fitted here by least squares on eight
 *     monuments whose survey coordinates are published in `src/city/rome/survey.ts`**, with the
 *     per-point residual printed on every run. It is not imported from anywhere and it does not
 *     read the road table: the fit's reference is the monument survey, which is upstream of
 *     every road and does not know the roads exist.
 *
 *  2. **A way to see a candidate line on the plate it came off.** `--plate` draws the authored
 *     `WAYS_SURVEY` table onto Shepherd (or, with `--lanciani`, onto the georectified raster)
 *     under a survey-metre grid, so a line can be corrected against the ink rather than against
 *     a previous version of itself.
 *
 * **What this instrument cannot do, stated so nobody quotes it as better than it is.** The fit's
 * RMS is ~28 real metres and its worst point ~57 m, on a plate that resolves 2.1 m/px and
 * generalises a 12 m street to a 3 px line. So a centreline read off Shepherd is good to about
 * 30 m, and `docs/ROME-PLAN-RUBRIC.md`'s ordering is the reason that is acceptable: a road on
 * the wrong side of a monument is worse than one 20 m off its line. Where a way's position
 * matters to a metre — the Via Lata's mouth at the Porta Flaminia, the swing past the Mausoleum
 * of Augustus — the reading is taken off Lanciani instead and the row says so.
 *
 *   node tools/scratch/rome-roads.mjs --fit             the affine and its residuals
 *   node tools/scratch/rome-roads.mjs --plate           Shepherd + survey grid + the authored ways
 *   node tools/scratch/rome-roads.mjs --plate --lanciani
 *   node tools/scratch/rome-roads.mjs --plate --e0=-900 --e1=200 --n0=200 --n1=2200 --zoom=2
 */
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const h = argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};
const ROOT = resolve(import.meta.dirname, '../..');
const say = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// The Shepherd georeference, fitted here rather than declared
// ---------------------------------------------------------------------------

/**
 * Control points: Shepherd pixel (on the 2826 x 2158 file) against the survey's own `e`/`n`.
 *
 * Pixels were read by eye off `tools/scratch/shep-grid.mjs` crops at 3x with a 25 px grid;
 * the survey column is copied from `src/city/rome/survey.ts` and is **not** re-derived here,
 * because the survey is the external reference this fit is against. Eight points, spread from
 * the Mausoleum of Hadrian on the far bank to the Castra Praetoria in the north-east and the
 * Baths of Caracalla in the south, so the fit is constrained over the whole plate rather than
 * over the Campus Martius.
 */
const CONTROL = [
  ['mausoleum-augustus', 1141, 425, -481, 1500],
  ['mausoleum-hadrian', 767, 567, -1326, 1178],
  ['stadium-domitian', 1027, 773, -762, 745],
  ['pantheon', 1175, 803, -447, 678],
  ['colosseum', 1791, 1247, 839, -249],
  ['circus-maximus', 1530, 1440, 249, -733],
  ['castra-praetoria', 2357, 378, 2113, 1484],
  ['baths-caracalla', 1815, 1805, 845, -1500],
];

function fitAxis(idx) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const V = [0, 0, 0];
  for (const p of CONTROL) {
    const a = [p[1], p[2], 1];
    const b = p[idx];
    for (let i = 0; i < 3; i++) {
      V[i] += a[i] * b;
      for (let j = 0; j < 3; j++) M[i][j] += a[i] * a[j];
    }
  }
  for (let i = 0; i < 3; i++) {
    let q = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[q][i])) q = r;
    [M[i], M[q]] = [M[q], M[i]];
    [V[i], V[q]] = [V[q], V[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c < 3; c++) M[r][c] -= f * M[i][c];
      V[r] -= f * V[i];
    }
  }
  return [V[0] / M[0][0], V[1] / M[1][1], V[2] / M[2][2]];
}

const SHEP_E = fitAxis(3);
const SHEP_N = fitAxis(4);
/** Shepherd pixel -> survey metres. */
const shepEN = (px, py) => ({
  e: SHEP_E[0] * px + SHEP_E[1] * py + SHEP_E[2],
  n: SHEP_N[0] * px + SHEP_N[1] * py + SHEP_N[2],
});
/** Survey metres -> Shepherd pixel. */
const shepPX = (e, n) => {
  const det = SHEP_E[0] * SHEP_N[1] - SHEP_E[1] * SHEP_N[0];
  const de = e - SHEP_E[2];
  const dn = n - SHEP_N[2];
  return { px: (de * SHEP_N[1] - SHEP_E[1] * dn) / det, py: (SHEP_E[0] * dn - de * SHEP_N[0]) / det };
};

/** The georectified Lanciani raster, restated from `src/city/overlay.ts` for the same reason
 *  `rome-landmarks.mjs` restates it: this is an instrument and `overlay.ts` is graded by it. */
const LANC = {
  file: 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
  widthPx: 4096, heightPx: 2734,
  ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
  nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
};
const lancPX = (e, n) => {
  const det = LANC.ex * LANC.ny - LANC.ey * LANC.nx;
  const de = e - LANC.e0;
  const dn = n - LANC.n0;
  return { px: (de * LANC.ny - LANC.ey * dn) / det, py: (LANC.ex * dn - de * LANC.nx) / det };
};

const SHEP_FILE = 'reference/rome-plans/shepherd-1923-plan-of-imperial-rome-350ad-2826px.jpg';

/**
 * Read the authored survey-metre way table straight out of `src/city/rome/ways.ts`.
 *
 * **Parsed, not restated.** `MAP-METHOD.md` rule 6 is about an instrument agreeing with itself;
 * a hand-copied table in a scratch file is the same fault one step removed, and this project has
 * already shipped it once (`tools/scratch/free-land.mjs` re-implements `districtMask` by hand and
 * can therefore agree with a stale copy of the thing it grades). The table is pure data — an
 * array of `{ id, cls, path: [[e, n], ...] }` — so a tolerant regex over the literal is enough,
 * and it fails loudly rather than silently if the shape changes.
 */
function readWaysTable() {
  const src = readFileSync(resolve(ROOT, 'src/city/rome/ways.ts'), 'utf8');
  const body = src.slice(src.indexOf('export const ROME_WAYS'));
  const starts = [...body.matchAll(/\n\s*id:\s*'([a-z0-9-]+)'/g)];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : body.length;
    const block = body.slice(from, to);
    const cls = block.match(/\n\s*cls:\s*'([a-z]+)'/);
    const path = block.match(/\n\s*path:\s*\[([\s\S]*?)\n\s*\]/);
    if (!cls || !path) continue;
    const pairs = [...path[1].matchAll(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/g)].map((p) => [+p[1], +p[2]]);
    if (pairs.length >= 2) out.push({ id: starts[i][1], cls: cls[1], path: pairs });
  }
  if (out.length === 0) throw new Error('rome-roads: parsed no ways out of src/city/rome/ways.ts');
  return out;
}

function fitReport() {
  let s2 = 0;
  let worst = 0;
  let wid = '';
  const rows = [];
  for (const p of CONTROL) {
    const q = shepEN(p[1], p[2]);
    const d = Math.hypot(q.e - p[3], q.n - p[4]);
    s2 += d * d;
    if (d > worst) { worst = d; wid = p[0]; }
    rows.push({ id: p[0], resid: +d.toFixed(1), de: +(q.e - p[3]).toFixed(0), dn: +(q.n - p[4]).toFixed(0) });
  }
  return {
    rows,
    rms: +Math.sqrt(s2 / CONTROL.length).toFixed(1),
    worst: +worst.toFixed(1),
    worstId: wid,
    mPerPxE: +Math.hypot(SHEP_E[0], SHEP_N[0]).toFixed(4),
    mPerPxN: +Math.hypot(SHEP_E[1], SHEP_N[1]).toFixed(4),
    rotDeg: +((Math.atan2(SHEP_N[0], SHEP_E[0]) * 180) / Math.PI).toFixed(2),
  };
}

if (argv.includes('--fit') || argv.length === 0) {
  const f = fitReport();
  say('=== Shepherd 1923 -> survey frame, fitted on the monument survey ===');
  say(`  e = ${SHEP_E[0].toFixed(6)}*px ${SHEP_E[1] >= 0 ? '+' : '-'} ${Math.abs(SHEP_E[1]).toFixed(6)}*py ${SHEP_E[2] >= 0 ? '+' : '-'} ${Math.abs(SHEP_E[2]).toFixed(3)}`);
  say(`  n = ${SHEP_N[0].toFixed(6)}*px ${SHEP_N[1] >= 0 ? '+' : '-'} ${Math.abs(SHEP_N[1]).toFixed(6)}*py ${SHEP_N[2] >= 0 ? '+' : '-'} ${Math.abs(SHEP_N[2]).toFixed(3)}`);
  say(`  scale ${f.mPerPxE} / ${f.mPerPxN} m per pixel   plate rotation ${f.rotDeg} deg off survey north`);
  say('  (ASSETS.md item 9 measures the plate\'s own bars at 2.100 / 2.094 m/px; this fit is 2 % over, which is inside the pick error)');
  say('');
  for (const r of f.rows) say(`  ${r.id.padEnd(20)} residual ${String(r.resid).padStart(5)} m   de ${String(r.de).padStart(5)}  dn ${String(r.dn).padStart(5)}`);
  say(`  RMS ${f.rms} m over ${CONTROL.length} points; worst ${f.worst} m (${f.worstId})`);
  say('');
  say('  A centreline read off this plate is therefore good to about 30 real metres and no better.');
}

// ---------------------------------------------------------------------------
// --plate: draw the authored ways onto a plate, under a survey grid
// ---------------------------------------------------------------------------

if (argv.includes('--plate')) {
  const useLanc = argv.includes('--lanciani');
  const file = resolve(ROOT, useLanc ? LANC.file : SHEP_FILE);
  if (!existsSync(file)) {
    console.error(`no plate at ${file}. reference/ is gitignored; symlink it into the worktree.`);
    process.exit(2);
  }
  const PX = useLanc ? lancPX : shepPX;
  const meta = await sharp(file, { limitInputPixels: false }).metadata();
  const bx = {
    e0: +arg('e0', '-1700'), e1: +arg('e1', '2400'),
    n0: +arg('n0', '-1700'), n1: +arg('n1', '2100'),
  };
  const zoom = +arg('zoom', '1');
  const cs = [PX(bx.e0, bx.n0), PX(bx.e0, bx.n1), PX(bx.e1, bx.n0), PX(bx.e1, bx.n1)];
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.px))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c.py))));
  const x1 = Math.min(meta.width, Math.ceil(Math.max(...cs.map((c) => c.px))));
  const y1 = Math.min(meta.height, Math.ceil(Math.max(...cs.map((c) => c.py))));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const P = (e, n) => {
    const p = PX(e, n);
    return { x: (p.px - x0) * zoom, y: (p.py - y0) * zoom };
  };
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(cw * zoom)}" height="${Math.round(ch * zoom)}">`];
  const line = (a, b, stroke, w, dash) =>
    parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/>`);
  const text = (p, s, fill, size) =>
    parts.push(`<text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" fill="${fill}" font-family="Helvetica,Arial" font-size="${size.toFixed(1)}" font-weight="bold" paint-order="stroke" stroke="#fff" stroke-width="${(size / 4).toFixed(1)}">${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
  const G = +arg('grid', '200');
  for (let e = Math.ceil(bx.e0 / G) * G; e <= bx.e1; e += G) {
    line(P(e, bx.n0), P(e, bx.n1), '#0aa', 0.7, '5 8');
    text(P(e, bx.n1 - 18), `e${e}`, '#066', 11 * zoom);
  }
  for (let n = Math.ceil(bx.n0 / G) * G; n <= bx.n1; n += G) {
    line(P(bx.e0, n), P(bx.e1, n), '#0aa', 0.7, '5 8');
    text(P(bx.e0 + 8, n), `n${n}`, '#066', 11 * zoom);
  }
  // The control points, so the reader can see the fit rather than take it on trust.
  for (const c of CONTROL) {
    const p = P(c[3], c[4]);
    const arm = 8 * zoom;
    line({ x: p.x - arm, y: p.y }, { x: p.x + arm, y: p.y }, '#080', 2 * zoom);
    line({ x: p.x, y: p.y - arm }, { x: p.x, y: p.y + arm }, '#080', 2 * zoom);
  }
  // The authored ways, parsed out of `src/city/rome/ways.ts` rather than restated here, so
  // the picture can never be of a table the tree no longer carries.
  const WAYS_SURVEY = argv.includes('--nolines') ? [] : readWaysTable();
  const RANK_COLOUR = {
    processional: '#c0007a', consular: '#d00000', local: '#e07000', vicus: '#8a6a00', clivus: '#0060c0',
  };
  const only = arg('only', '');
  const ids = only ? new Set(only.split(',')) : null;
  for (const w of WAYS_SURVEY) {
    if (ids && !ids.has(w.id)) continue;
    const col = RANK_COLOUR[w.cls] ?? '#d00';
    for (let i = 0; i + 1 < w.path.length; i++) {
      line(P(w.path[i][0], w.path[i][1]), P(w.path[i + 1][0], w.path[i + 1][1]), col, Math.max(1.4, 2.4 * zoom), null);
    }
    if (!argv.includes('--bare')) {
      const mid = w.path[Math.floor(w.path.length / 2)];
      text(P(mid[0], mid[1]), w.id, col, 12 * zoom);
    }
  }
  const mpp = useLanc ? Math.hypot(LANC.ex, LANC.nx) : Math.hypot(SHEP_E[0], SHEP_N[0]);
  const sb = (500 / mpp) * zoom;
  parts.push(`<rect x="8" y="${(ch * zoom - 36).toFixed(0)}" width="${(sb + 14).toFixed(0)}" height="28" fill="#fff" fill-opacity="0.85"/>`);
  parts.push(`<line x1="14" y1="${(ch * zoom - 14).toFixed(0)}" x2="${(14 + sb).toFixed(0)}" y2="${(ch * zoom - 14).toFixed(0)}" stroke="#000" stroke-width="3"/>`);
  text({ x: 16, y: ch * zoom - 21 }, `500 real m  (${mpp.toFixed(3)} m/px, ${useLanc ? 'Lanciani georef' : 'Shepherd fit'})`, '#000', 11);
  parts.push('</svg>');
  const out = resolve(ROOT, arg('out', 'screenshots/rome-roads/ways-on-plate.png'));
  mkdirSync(dirname(out), { recursive: true });
  let img = sharp(file, { limitInputPixels: false }).extract({ left: x0, top: y0, width: cw, height: ch });
  if (zoom !== 1) img = img.resize(Math.round(cw * zoom), Math.round(ch * zoom), { kernel: 'lanczos3' });
  await img.composite([{ input: Buffer.from(parts.join('\n')) }]).png().toFile(out);
  say(`wrote ${out}  ${Math.round(cw * zoom)} x ${Math.round(ch * zoom)}  window e ${bx.e0}..${bx.e1} n ${bx.n0}..${bx.n1}`);
}

export { shepEN, shepPX, fitReport, CONTROL };
