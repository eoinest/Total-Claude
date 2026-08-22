#!/usr/bin/env node
/**
 * **The survey, drawn on the plate it was surveyed from.**
 *
 * `tools/probe-fabric.mjs`'s stated blind spot is the one that matters for Rome:
 * `ROME-FABRIC.md` §4.4's check 3, plate containment, could not be built, because the only
 * machine-readable plate carries no monument names. So the gate can prove a footprint is the
 * wrong *size* and cannot prove it is in the wrong *place* — and wrong place is precisely the
 * fault the owner reported: *"the footprint of where the buildings are is completely wrong."*
 *
 * This closes it by eye rather than by assertion, which is the right instrument for a question
 * whose answer is a picture. It draws each monument's **real published plan**, at its **real
 * bearing**, at its **surveyed position**, onto the georeferenced Lanciani raster — the same
 * raster `src/city/overlay.ts` is fitted to, at 1.71 m/px with a worst georeference residual of
 * 1.26 m over 7 km. Everything is in **survey metres**. No projection is involved, so nothing
 * here can be wrong because of `KX` or `KZ`: if a rectangle does not sit on its own inked plan,
 * the survey row is wrong.
 *
 * Two layers, and the difference between them is the whole argument:
 *
 *   **survey**  the row as authored — real plan, real bearing, `worldOf`'s input.
 *   **built**   where the engine actually put it, un-projected back through `worldOf` into the
 *               same survey frame. The gap between the two rectangles is `resolveOverlaps`'s
 *               displacement, drawn at the same scale as the city it displaced things in.
 *
 * Plus the map's own edges in survey metres, so what falls off the +Z edge is visible as
 * geometry rather than as a list.
 *
 *   node tools/scratch/rome-plate-overlay.mjs --port=5917 --out=screenshots/rome-fabric-p1
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5917));
const OUT = path.resolve(ROOT, arg('out', 'screenshots/rome-fabric-p1'));
const TAG = arg('tag', 'after');
const WANT_BUILT = !process.argv.includes('--no-built');

/**
 * `src/city/overlay.ts:LANCIANI_1901`, restated here rather than imported.
 *
 * Restated because this is an instrument and `overlay.ts` is one of the things it grades: if
 * the affine in the source drifts, this file measures it as wrong instead of measuring it as
 * itself. `docs/HANDOFF.md`'s standing rule. Any disagreement between the two is a fault in
 * whichever moved, and the numbers below are the ones fitted against a full inverse of
 * EPSG:3004 over a 13 x 13 grid, to a worst residual of 1.26 m over 7 km.
 */
const LANCIANI = {
  file: 'reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png',
  widthPx: 4096,
  heightPx: 2734,
  ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
  nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
  credit: 'Lanciani, Forma Urbis Romae (1893-1901), georectified by SITAR / SSABAP-RM (CC BY-SA 4.0)',
};

/** Invert the pixel -> survey affine, once. */
const INV = (() => {
  const { ex, ey, nx, ny, e0, n0 } = LANCIANI;
  const det = ex * ny - ey * nx;
  return (e, n) => {
    const de = e - e0;
    const dn = n - n0;
    return { px: (de * ny - ey * dn) / det, py: (ex * dn - de * nx) / det };
  };
})();

// The projection, re-derived, as in `rome-frame.mjs`.
const roadCentreX = (z) => 20 + 34 * Math.sin((z + 300) * 0.0018519) - 18 * Math.sin((z + 900) * 0.0033333);
const riseToeZ = (x) => 330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);
const crestZAt = (x) => riseToeZ(x) + 175;
const GATE_X = (() => { let x = 20; for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x)); return Math.round(x * 10) / 10; })();
const GATE_Z = crestZAt(GATE_X);
const KX = 0.443;
const KZ = Number(arg('kz', '0.35'));
const X0 = GATE_X - KX * -497;
const Z0 = GATE_Z + KZ * 2045;
/** World metres back into survey metres — how a built position is compared with its own row. */
const surveyOf = (x, z) => ({ e: (x - X0) / KX, n: (Z0 - z) / KZ });
const HALF_EXTENT = 1400;

// ---------------------------------------------------------------------------
// Read the survey and the built placements out of the running page
// ---------------------------------------------------------------------------
const url = `http://127.0.0.1:${PORT}/src/city/plan.html`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(3000);

const data = await page.evaluate(async () => {
  const survey = await import('/src/city/rome/survey.ts');
  const layout = await import('/src/city/rome/layout.ts');
  const topo = await import('/src/terrain/topography.ts');
  return {
    kz: survey.KZ,
    kx: survey.KX,
    rome: survey.ROME.map((m) => ({
      id: m.id, name: m.name, e: m.e, n: m.n, len: m.len, wid: m.wid,
      bearing: m.bearing, axis: m.axis ?? 'x', soft: !!m.soft,
      farBank: !!m.farBank, onRiver: !!m.onRiver,
    })),
    placed: layout.LANDMARKS.map((l) => ({ id: l.id, x: l.x, z: l.z, hw: l.hw, hd: l.hd, rot: l.rot })),
    circuit: topo.ROME_CIRCUIT_SURVEY.map((p) => ({ id: p.id, e: p.e, n: p.n })),
  };
});
await browser.close();
if (errs.length) console.warn('page errors:', errs.slice(0, 3));
if (Math.abs(data.kz - KZ) > 1e-9) {
  console.warn(`!! the page is running KZ ${data.kz} and this run was told ${KZ}. Using the page's.`);
}
const kz = data.kz;

// ---------------------------------------------------------------------------
// Frame the crop: everything the survey touches, plus a margin
// ---------------------------------------------------------------------------
const pts = data.rome.map((m) => INV(m.e, m.n)).concat(data.circuit.map((p) => INV(p.e, p.n)));
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const p of pts) { x0 = Math.min(x0, p.px); y0 = Math.min(y0, p.py); x1 = Math.max(x1, p.px); y1 = Math.max(y1, p.py); }
const PAD = 220;
x0 = Math.max(0, Math.floor(x0 - PAD));
y0 = Math.max(0, Math.floor(y0 - PAD));
x1 = Math.min(LANCIANI.widthPx, Math.ceil(x1 + PAD));
y1 = Math.min(LANCIANI.heightPx, Math.ceil(y1 + PAD));
const cw = x1 - x0;
const ch = y1 - y0;
/** Metres of survey per pixel of the crop, on the plate's own long axis. */
const M_PER_PX = Math.hypot(LANCIANI.ex, LANCIANI.nx);

const P = (e, n) => { const p = INV(e, n); return { x: p.px - x0, y: p.py - y0 }; };

/** Corners of a monument's real plan at its real bearing, in survey metres. */
function corners(m) {
  const th = (m.bearing * Math.PI) / 180;
  // `len` runs along the long axis; `axis: 'z'` means the long axis is the entrance axis.
  const halfAlong = m.len / 2;
  const halfAcross = m.wid / 2;
  // Bearing is clockwise from north in the survey's own east/north frame.
  const ax = { e: Math.sin(th), n: Math.cos(th) };
  const bx = { e: Math.cos(th), n: -Math.sin(th) };
  const out = [];
  for (const [sa, sb] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    out.push({
      e: m.e + ax.e * halfAlong * sa + bx.e * halfAcross * sb,
      n: m.n + ax.n * halfAlong * sa + bx.n * halfAcross * sb,
    });
  }
  return out;
}

/** Corners of a *built* oriented box, taken back into survey metres. */
function builtCorners(b) {
  const cx = Math.cos(b.rot), sx = -Math.sin(b.rot);
  const cz = Math.sin(b.rot), sz = Math.cos(b.rot);
  const out = [];
  for (const [su, sv] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const x = b.x + cx * b.hw * su + cz * b.hd * sv;
    const z = b.z + sx * b.hw * su + sz * b.hd * sv;
    out.push(surveyOf(x, z));
  }
  return out;
}

const poly = (cs) => cs.map((c) => { const p = P(c.e, c.n); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');

// ---------------------------------------------------------------------------
// The map's own edges, in survey metres
// ---------------------------------------------------------------------------
const edgeN = (Z0 - HALF_EXTENT) / kz;      // the +Z edge: everything south of this is off the map
const edgeE = (HALF_EXTENT - X0) / KX;
const edgeW = (-HALF_EXTENT - X0) / KX;

const placedById = new Map(data.placed.map((p) => [p.id, p]));
const off = data.rome.filter((m) => !placedById.has(m.id));

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
const FONT = 'font-family="Helvetica,Arial,sans-serif"';
const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}">`);

// the map's south edge and side edges
{
  const a = P(edgeW, edgeN), b = P(edgeE, edgeN);
  parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#c0392b" stroke-width="4" stroke-dasharray="18 10"/>`);
  parts.push(`<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 14}" ${FONT} font-size="30" font-weight="bold" fill="#c0392b" text-anchor="middle">the +Z edge of the map at KZ ${kz} — nothing south of this line is drawn</text>`);
  for (const e of [edgeW, edgeE]) {
    const p0 = P(e, edgeN), p1 = P(e, 2600);
    parts.push(`<line x1="${p0.x}" y1="${p0.y}" x2="${p1.x}" y2="${p1.y}" stroke="#c0392b" stroke-width="3" stroke-dasharray="10 10" opacity="0.7"/>`);
  }
}

// the Aurelian circuit as surveyed
{
  const d = data.circuit.map((p, i) => { const q = P(p.e, p.n); return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
  parts.push(`<path d="${d}" fill="none" stroke="#1a5276" stroke-width="6" opacity="0.9"/>`);
  for (const p of data.circuit) {
    const q = P(p.e, p.n);
    parts.push(`<circle cx="${q.x}" cy="${q.y}" r="7" fill="#1a5276"/>`);
  }
}

// the built positions, un-projected — the displacement, drawn
if (WANT_BUILT) {
  for (const b of data.placed) {
    const m = data.rome.find((r) => r.id === b.id);
    if (!m || m.soft) continue;
    parts.push(`<polygon points="${poly(builtCorners(b))}" fill="#e67e22" fill-opacity="0.20" stroke="#e67e22" stroke-width="3"/>`);
    const s = surveyOf(b.x, b.z);
    const a = P(m.e, m.n), c = P(s.e, s.n);
    const moved = Math.hypot(s.e - m.e, s.n - m.n);
    if (moved > 20) {
      parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" stroke="#e67e22" stroke-width="4"/>`);
      parts.push(`<circle cx="${c.x}" cy="${c.y}" r="6" fill="#e67e22"/>`);
    }
  }
}

// the survey, at real plan and real bearing
for (const m of data.rome) {
  const isOff = !placedById.has(m.id);
  const stroke = isOff ? '#c0392b' : m.soft ? '#27865a' : '#111';
  const fill = isOff ? '#c0392b' : m.soft ? '#27865a' : '#1a1a1a';
  parts.push(
    `<polygon points="${poly(corners(m))}" fill="${fill}" fill-opacity="${isOff ? 0.18 : 0.12}" ` +
      `stroke="${stroke}" stroke-width="${isOff ? 4 : 3}" ${isOff ? 'stroke-dasharray="12 8"' : ''}/>`
  );
  const p = P(m.e, m.n);
  parts.push(`<circle cx="${p.x}" cy="${p.y}" r="5" fill="${stroke}"/>`);
  parts.push(
    `<text x="${p.x + 10}" y="${p.y - 10}" ${FONT} font-size="26" font-weight="bold" ` +
      `fill="${stroke}" stroke="#fff" stroke-width="5" paint-order="stroke">${m.name}${isOff ? ' (OFF MAP)' : ''}</text>`
  );
}

// scale bar, 500 survey metres
{
  const len = 500 / M_PER_PX;
  const bx = 60, by = ch - 80;
  parts.push(`<rect x="${bx - 20}" y="${by - 52}" width="${len + 300}" height="96" fill="#fff" fill-opacity="0.82"/>`);
  parts.push(`<line x1="${bx}" y1="${by}" x2="${bx + len}" y2="${by}" stroke="#111" stroke-width="6"/>`);
  parts.push(`<line x1="${bx}" y1="${by - 12}" x2="${bx}" y2="${by + 12}" stroke="#111" stroke-width="6"/>`);
  parts.push(`<line x1="${bx + len}" y1="${by - 12}" x2="${bx + len}" y2="${by + 12}" stroke="#111" stroke-width="6"/>`);
  parts.push(`<text x="${bx}" y="${by - 22}" ${FONT} font-size="30" font-weight="bold" fill="#111">500 real metres  (plate ${M_PER_PX.toFixed(2)} m/px)</text>`);
  parts.push(`<text x="${bx}" y="${by + 34}" ${FONT} font-size="22" fill="#333">${LANCIANI.credit}</text>`);
}

// legend
{
  const lx = cw - 900, ly = 60;
  parts.push(`<rect x="${lx - 20}" y="${ly - 40}" width="900" height="${WANT_BUILT ? 250 : 190}" fill="#fff" fill-opacity="0.86"/>`);
  const row = (i, colour, dash, label) => {
    const y = ly + i * 44;
    parts.push(`<rect x="${lx}" y="${y - 20}" width="54" height="30" fill="${colour}" fill-opacity="0.18" stroke="${colour}" stroke-width="4" ${dash}/>`);
    parts.push(`<text x="${lx + 70}" y="${y + 4}" ${FONT} font-size="27" fill="#111">${label}</text>`);
  };
  parts.push(`<text x="${lx}" y="${ly - 8}" ${FONT} font-size="30" font-weight="bold" fill="#111">Rome 271 AD — survey vs Lanciani, KZ ${kz}</text>`);
  row(1, '#111', '', 'survey row: real published plan at its real bearing');
  row(2, '#c0392b', 'stroke-dasharray="12 8"', 'past the +Z edge — not drawn on this map');
  row(3, '#27865a', '', 'landscape (gardens, ridge, island)');
  if (WANT_BUILT) row(4, '#e67e22', '', "as the engine draws it — resolveOverlaps' displacement");
}

parts.push('</svg>');

const plate = path.resolve(ROOT, LANCIANI.file);
if (!existsSync(plate)) {
  console.error(`no plate at ${plate}. reference/ is gitignored; symlink it into the worktree.`);
  process.exit(2);
}
await mkdir(OUT, { recursive: true });
const outFile = path.join(OUT, `01-survey-on-lanciani-${TAG}.png`);
await sharp(plate)
  .extract({ left: x0, top: y0, width: cw, height: ch })
  .composite([{ input: Buffer.from(parts.join('\n')), top: 0, left: 0 }])
  .png()
  .toFile(outFile);

const displaced = data.placed
  .map((b) => {
    const m = data.rome.find((r) => r.id === b.id);
    if (!m || m.soft) return null;
    const s = surveyOf(b.x, b.z);
    return { id: b.id, realM: Math.hypot(s.e - m.e, s.n - m.n) };
  })
  .filter(Boolean)
  .sort((a, b) => b.realM - a.realM);

console.log(`wrote ${outFile}  (${cw} x ${ch} px, ${M_PER_PX.toFixed(3)} m/px, crop of the 4096 px plate)`);
console.log(`KZ ${kz}; +Z edge at survey n ${edgeN.toFixed(0)}; ${off.length} row(s) off the map: ${off.map((m) => m.id).join(', ') || 'none'}`);
console.log(`resolveOverlaps displacement in REAL metres: mean ${(displaced.reduce((s, d) => s + d.realM, 0) / displaced.length).toFixed(0)} m, worst ${displaced[0].realM.toFixed(0)} m (${displaced[0].id})`);
for (const d of displaced.slice(0, 8)) console.log(`   ${d.id.padEnd(22)} ${d.realM.toFixed(0)} real m`);
await writeFile(path.join(OUT, `01-survey-on-lanciani-${TAG}.json`), JSON.stringify({ kz, edgeN, off: off.map((m) => m.id), displaced }, null, 2));
