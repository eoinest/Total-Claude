import { HALF_EXTENT } from '../terrain/TerrainSystem';
import { crestZAt, RIVER_HALF_WIDTH, riverCentreX, roadCentreX } from '../terrain/topography';
import { KeepOut } from './layout';
import {
  assertHillRing,
  assertNoFootprintOverlaps,
  assertOneAmphitheatre,
  assertTopology,
  AQUEDUCTS,
  DISTRICTS,
  GATE_X,
  LANDMARKS,
  STREETS,
  WALL_X_MAX,
  WALL_X_MIN,
} from './layout';
import { buildDistricts } from './insulae';
import { KX, KZ, ROME } from './rome';

/**
 * Plan-view diagnostic: the city from directly overhead, with every landmark footprint
 * drawn to scale and labelled.
 *
 * This exists because a three-quarter camera cannot answer "is the Circus Maximus in the
 * Vallis Murcia" or "does anything cross the Colosseum". Rendering the plan as SVG at a
 * known scale makes it directly comparable with Lanciani's *Forma Urbis Romae*, and it
 * reports the footprint-overlap assertion in the same frame, so a layout regression is
 * visible rather than inferred.
 *
 * Served by Vite at `/src/city/plan.html`; driven by `shoot-city.mjs --shots=plan`.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Metres of world per SVG unit. The whole heightfield is 2,800 m across. */
const VIEW_MIN_X = -1420;
const VIEW_MAX_X = 1420;
const VIEW_MIN_Z = 180;
const VIEW_MAX_Z = 1420;

const el = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const svg = el('svg', {
  width: 1600,
  height: Math.round((1600 * (VIEW_MAX_Z - VIEW_MIN_Z)) / (VIEW_MAX_X - VIEW_MIN_X)),
  viewBox: `${VIEW_MIN_X} ${VIEW_MIN_Z} ${VIEW_MAX_X - VIEW_MIN_X} ${VIEW_MAX_Z - VIEW_MIN_Z}`,
  style: 'background:#efe7d6',
});
document.getElementById('wrap')!.appendChild(svg);

const push = (n: SVGElement): void => {
  svg.appendChild(n);
};

// ---- water and roads ------------------------------------------------------
{
  const pts: string[] = [];
  for (let z = VIEW_MIN_Z; z <= VIEW_MAX_Z; z += 10) pts.push(`${riverCentreX(z) - RIVER_HALF_WIDTH},${z}`);
  for (let z = VIEW_MAX_Z; z >= VIEW_MIN_Z; z -= 10) pts.push(`${riverCentreX(z) + RIVER_HALF_WIDTH},${z}`);
  push(el('polygon', { points: pts.join(' '), fill: '#9fb6bd', stroke: '#7d979f', 'stroke-width': 2 }));
  const road: string[] = [];
  for (let z = VIEW_MIN_Z; z <= crestZAt(GATE_X) + 10; z += 10) road.push(`${roadCentreX(z)},${z}`);
  push(el('polyline', { points: road.join(' '), fill: 'none', stroke: '#8d7a5c', 'stroke-width': 5 }));
}

// ---- the buildable plateau and the wall ----------------------------------
{
  const crest: string[] = [];
  for (let x = -HALF_EXTENT; x <= HALF_EXTENT; x += 10) crest.push(`${x},${crestZAt(x)}`);
  push(el('polyline', { points: crest.join(' '), fill: 'none', stroke: '#a08f70', 'stroke-width': 2, 'stroke-dasharray': '12 8' }));
  const wall: string[] = [];
  for (let x = WALL_X_MIN; x <= WALL_X_MAX; x += 10) wall.push(`${x},${crestZAt(x)}`);
  push(el('polyline', { points: wall.join(' '), fill: 'none', stroke: '#7a2f24', 'stroke-width': 8 }));
  push(el('circle', { cx: GATE_X, cy: crestZAt(GATE_X), r: 14, fill: '#efe7d6', stroke: '#7a2f24', 'stroke-width': 5 }));
  push(el('line', { x1: -HALF_EXTENT, y1: HALF_EXTENT, x2: HALF_EXTENT, y2: HALF_EXTENT, stroke: '#555', 'stroke-width': 3, 'stroke-dasharray': '20 12' }));
}

// ---- streets and aqueducts ----------------------------------------------
for (const s of STREETS) {
  push(el('polyline', { points: s.path.map((p) => `${p.x},${p.z}`).join(' '), fill: 'none', stroke: '#6b5a42', 'stroke-width': s.width * 0.8 }));
}
for (const a of AQUEDUCTS) {
  push(el('polyline', { points: a.path.map((p) => `${p.x},${p.z}`).join(' '), fill: 'none', stroke: '#8a6a34', 'stroke-width': 4, 'stroke-dasharray': '6 5' }));
}

// ---- landmark footprints -------------------------------------------------
const overlaps = assertNoFootprintOverlaps();
const topoBase = assertTopology();
const ring = assertHillRing();
const amphi = assertOneAmphitheatre();
const topo = {
  ok: topoBase.ok && ring.ok,
  checks: topoBase.checks + ring.checks,
  failures: [...topoBase.failures, ...ring.failures],
};
const bad = new Set<string>();
for (const p of overlaps.pairs) {
  bad.add(p.a);
  bad.add(p.b);
}

const HILL_FILL: Record<string, string> = {
  capitoline: '#c8a97e',
  palatine: '#c8a97e',
  aventine: '#c8a97e',
  caelian: '#c8a97e',
  esquiline: '#cbb894',
  viminal: '#cbb894',
  quirinal: '#cbb894',
  pincian: '#cbb894',
  'campus-martius': '#d9cdae',
  'forum-valley': '#e0d3b0',
  'vallis-murcia': '#e0d3b0',
  'colosseum-valley': '#e0d3b0',
  velabrum: '#d9cdae',
  'trans-tiberim': '#cfc3a6',
};

for (const l of LANDMARKS) {
  if (l.mound) {
    push(el('circle', { cx: l.x, cy: l.z, r: l.moundRadius ?? l.clear, fill: 'rgba(120,150,90,0.22)', stroke: '#7d9455', 'stroke-width': 2 }));
  }
  push(
    el('rect', {
      x: -l.hw,
      y: -l.hd,
      width: l.hw * 2,
      height: l.hd * 2,
      transform: `translate(${l.x} ${l.z}) rotate(${(-l.rot * 180) / Math.PI})`,
      fill: bad.has(l.id) ? 'rgba(200,40,30,0.45)' : HILL_FILL[l.where] ?? '#d9cdae',
      stroke: bad.has(l.id) ? '#b02418' : '#4a3d29',
      'stroke-width': 2.5,
    })
  );
}
// Labels last, so nothing draws over them.
for (const l of LANDMARKS) {
  push(el('circle', { cx: l.x, cy: l.z, r: 3, fill: '#2a2318' }));
  const t = el('text', {
    x: l.x,
    y: l.z - Math.max(l.hd, 12) - 5,
    'text-anchor': 'middle',
    fill: '#241d12',
    'font-family': 'ui-monospace, monospace',
    'font-size': 17,
    stroke: '#f4eeddcc',
    'stroke-width': 4,
    'paint-order': 'stroke',
  });
  t.textContent = l.name;
  push(t);
}

// ---- districts, outlined on top so the landmark fills do not hide them ---
for (const d of DISTRICTS) {
  push(
    el('rect', {
      x: -d.hw,
      y: -d.hd,
      width: d.hw * 2,
      height: d.hd * 2,
      transform: `translate(${d.x} ${d.z}) rotate(${(-d.rot * 180) / Math.PI})`,
      fill: 'none',
      stroke: '#7a5f3a',
      'stroke-width': 2,
      'stroke-dasharray': '14 9',
      opacity: 0.75,
    })
  );
}

// ---- scale bar and north arrow ------------------------------------------
{
  const y = VIEW_MAX_Z - 40;
  push(el('line', { x1: -1360, y1: y, x2: -860, y2: y, stroke: '#241d12', 'stroke-width': 5 }));
  for (const x of [-1360, -1110, -860]) push(el('line', { x1: x, y1: y - 10, x2: x, y2: y + 10, stroke: '#241d12', 'stroke-width': 5 }));
  const t = el('text', { x: -1110, y: y - 18, 'text-anchor': 'middle', fill: '#241d12', 'font-family': 'ui-monospace, monospace', 'font-size': 22 });
  t.textContent = '500 m (world)';
  push(t);
  const n = el('text', { x: -1360, y: VIEW_MIN_Z + 46, fill: '#241d12', 'font-family': 'ui-monospace, monospace', 'font-size': 30 });
  n.textContent = '↑ N';
  push(n);
}

// ---- how much fabric the districts actually produce ----------------------
//
// A bald city is as wrong as an overlapping one, and the two are linked: enlarging the
// landmark footprints and then spreading them to separate them can leave the district
// rectangles sitting entirely inside a monument's keep-out, in which case every plot is
// rejected and the quarter simply does not exist. Counting the plots here catches that in
// the diagnostic instead of in a screenshot.
const keepOut = new KeepOut();
for (const l of LANDMARKS) {
  keepOut.addRect(l.x, l.z, l.hw, l.hd, l.rot);
  if (l.mound) keepOut.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
}
for (const st of STREETS) keepOut.addPath(st.path, st.width * 0.5 + 2.5);
for (const a of AQUEDUCTS) keepOut.addPath(a.path, 8);
const fabric = buildDistricts(() => 20, keepOut, 'rome-fabric', (x) => crestZAt(x));
const perDistrict = new Map<string, number>();
for (const f of fabric.footprints) {
  let best = '';
  let bestD = Infinity;
  for (const d of DISTRICTS) {
    const dd = Math.hypot(f.x - d.x, f.z - d.z);
    if (dd < bestD) {
      bestD = dd;
      best = d.id;
    }
  }
  perDistrict.set(best, (perDistrict.get(best) ?? 0) + 1);
}
for (const f of fabric.footprints) {
  push(el('rect', { x: f.x - f.hw, y: f.z - f.hd, width: f.hw * 2, height: f.hd * 2, transform: `rotate(${(-f.rot * 180) / Math.PI} ${f.x} ${f.z})`, fill: '#8a6b4a', opacity: 0.5 }));
}

// ---- the numeric report -------------------------------------------------
const byId = new Map(ROME.map((m) => [m.id, m]));
const rows = LANDMARKS.map((l) => {
  const m = byId.get(l.id)!;
  return {
    id: l.id,
    name: l.name,
    realE: m.e,
    realN: m.n,
    realLen: m.len,
    realWid: m.wid,
    bearing: m.bearing,
    where: m.where,
    x: +l.x.toFixed(1),
    z: +l.z.toFixed(1),
    rotDeg: +((l.rot * 180) / Math.PI).toFixed(1),
    hw: +l.hw.toFixed(1),
    hd: +l.hd.toFixed(1),
    /** How far the overlap resolver had to move it from the projected position. */
    drift: +Math.hypot(l.x - l.idealX, l.z - l.idealZ).toFixed(1),
  };
});

const lines: string[] = [];
lines.push(`PLAN OF ROME — projection KX=${KX} KZ=${KZ}`);
lines.push(`footprint overlaps: ${overlaps.count} (worst ${overlaps.worst} m)`);
for (const p of overlaps.pairs) lines.push(`  ! ${p.a} x ${p.b}  ${p.depth} m`);
lines.push(`amphitheatres (Colosseum form): ${amphi.count} — ${amphi.ok ? 'OK' : 'FAIL, expected 1'}`);
lines.push(`topology: ${topo.checks - topo.failures.length}/${topo.checks} adjacency + hill-ring checks pass`);
for (const f of topo.failures) lines.push(`  ! ${f}`);
lines.push(`insulae: ${fabric.footprints.length} plots, ${fabric.trees.length} trees`);
lines.push('districts: ' + DISTRICTS.map((d) => `${d.id} ${perDistrict.get(d.id) ?? 0}`).join('  '));
lines.push('');
lines.push('id                  worldx worldz  reale realn   size    drift  hill');
for (const r of rows) {
  lines.push(
    `${r.id.padEnd(19)} ${String(r.x).padStart(6)} ${String(r.z).padStart(6)} ` +
      `${String(r.realE).padStart(6)} ${String(r.realN).padStart(5)} ` +
      `${String(r.realLen).padStart(4)}x${String(r.realWid).padEnd(4)} ${String(r.drift).padStart(6)}  ${r.where}`
  );
}
document.getElementById('report')!.textContent = lines.join('\n');

declare global {
  interface Window {
    __plan?: {
      ready: boolean;
      overlaps: ReturnType<typeof assertNoFootprintOverlaps>;
      topology: { ok: boolean; checks: number; failures: string[] };
      amphitheatres: ReturnType<typeof assertOneAmphitheatre>;
      rows: typeof rows;
      insulae: number;
    };
  }
}
window.__plan = { ready: true, overlaps, topology: topo, amphitheatres: amphi, rows, insulae: fabric.footprints.length };
