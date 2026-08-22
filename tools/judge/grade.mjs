#!/usr/bin/env node
/**
 * judge/grade — grade a dumped Rome plan against `control.mjs`, per `docs/ROME-PLAN-RUBRIC.md`.
 *
 * The defendant is the JSON `dump-plan.mjs` produced. The rulers are all outside it:
 * plate-digitised control points, WGS84 bridge midpoints, published dimensions, and the
 * projection re-derived here from its published closed form rather than imported.
 *
 *   node tools/judge/grade.mjs --in=/tmp/judge/plan-p1.json [--json=/tmp/judge/grade.json]
 */
import fs from 'node:fs';
import { CONTROL, TIBER_CONTROL, TIBER_PLATE, CIRCUIT_PLATE, PUBLISHED } from './control.mjs';
import { enOfLatLon } from './plate.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const D = JSON.parse(fs.readFileSync(arg('in', '/tmp/judge/plan-p1.json'), 'utf8'));

// ---------------------------------------------------------------------------
// The projection, re-derived. NOT imported: `docs/MAP-METHOD.md` §3 records that
// re-deriving instead of importing is the only reason the fabric diagnosis was evidence.
// ---------------------------------------------------------------------------
const roadCentreX = (z) => 20 + 34 * Math.sin((z + 300) * 0.0018519) - 18 * Math.sin((z + 900) * 0.0033333);
const riseToeZ = (x) => 330 + 52 * Math.sin(x * 0.00476) + 26 * Math.sin(x * 0.01053 + 2.1);
const crestZAt = (x) => riseToeZ(x) + 175;
const GATE_X = (() => { let x = 20; for (let i = 0; i < 6; i++) x = roadCentreX(crestZAt(x)); return Math.round(x * 10) / 10; })();
const GATE_Z = crestZAt(GATE_X);
const KX = D.constants.KX, KZ = D.constants.KZ;
const X0 = GATE_X - KX * -497, Z0 = GATE_Z + KZ * 2045;
const worldOf = (e, n) => ({ x: X0 + KX * e, z: Z0 - KZ * n });
const surveyOf = (x, z) => ({ e: (x - X0) / KX, n: (Z0 - z) / KZ });
const HALF = 1400;

const frameNotes = [];
if (Math.abs(GATE_X - D.constants.GATE_X) > 0.05) frameNotes.push(`GATE_X re-derived ${GATE_X} vs page ${D.constants.GATE_X}`);
if (Math.abs(GATE_Z - D.constants.GATE_Z) > 0.05) frameNotes.push(`GATE_Z re-derived ${GATE_Z.toFixed(3)} vs page ${D.constants.GATE_Z.toFixed(3)}`);

// ---------------------------------------------------------------------------
// Control -> survey metres
// ---------------------------------------------------------------------------
const ctlById = new Map();
for (const c of CONTROL) {
  if (c.how === 'survey') { ctlById.set(c.id, { ...c }); continue; }
  const en = c.lat !== undefined ? enOfLatLon(c.lat, c.lon) : { e: c.e, n: c.n };
  ctlById.set(c.id, { ...c, ...en });
}
const romeById = new Map(D.rome.map((m) => [m.id, m]));
const lmById = new Map(D.landmarks.map((l) => [l.id, l]));

// ---------------------------------------------------------------------------
// C1 / C2  position: survey row vs control, and built box vs control
// ---------------------------------------------------------------------------
const pos = [];
for (const m of D.rome) {
  const c = ctlById.get(m.id);
  // 'restated' rows carry a position but are NOT evidence: they read back survey.ts's own
  // cite. They are kept for the topology reference and excluded from every position score.
  const graded = c && c.how !== 'survey' && c.how !== 'restated';
  const lm = lmById.get(m.id);
  const ideal = worldOf(m.e, m.n);
  const row = { id: m.id, name: m.name, how: c ? c.how : 'none', graded: !!graded, placed: !!lm };
  if (graded) {
    row.surveyErr = Math.hypot(m.e - c.e, m.n - c.n);
    row.surveyErrE = m.e - c.e; row.surveyErrN = m.n - c.n;
    row.ctlErr = c.err;
  }
  if (lm) {
    const built = surveyOf(lm.x, lm.z);
    row.resolverWorld = Math.hypot(lm.x - ideal.x, lm.z - ideal.z);
    row.resolverReal = Math.hypot(built.e - m.e, built.n - m.n);
    row.builtE = built.e; row.builtN = built.n;
    if (c && c.e !== undefined) {
      row.builtErr = Math.hypot(built.e - c.e, built.n - c.n);
      row.builtWorldErr = Math.hypot(lm.x - worldOf(c.e, c.n).x, lm.z - worldOf(c.e, c.n).z);
      row.refIsEvidence = !!graded;
    }
  }
  pos.push(row);
}

// ---------------------------------------------------------------------------
// C3  bearing: the drawn long axis vs the plate bearing put through the projection
// ---------------------------------------------------------------------------
// worldRot's own intent, with the anisotropy the frame actually has (KX/KZ) rather than
// the tuned ROT_RATIO. A bearing correction whose constant is justified by the overlap
// resolver is justified by a thing the plan says it is deleting.
const trueRot = (bearingDeg, axis) => {
  const th = (bearingDeg * Math.PI) / 180;
  const dx = KX * Math.sin(th), dz = -KZ * Math.cos(th);
  return axis === 'x' ? -Math.atan2(dz, dx) : Math.atan2(dx, dz);
};
const wrap = (a) => { let d = a; while (d > 90) d -= 180; while (d < -90) d += 180; return d; };
const bear = [];
for (const l of D.landmarks) {
  const m = romeById.get(l.id);
  if (!m) continue;
  const want = trueRot(m.bearing, m.axis);
  const deg = (r) => (r * 180) / Math.PI;
  bear.push({ id: l.id, bearing: m.bearing, axis: m.axis,
    builtRotDeg: +deg(l.rot).toFixed(2), wantRotDeg: +deg(want).toFixed(2),
    err: +Math.abs(wrap(deg(l.rot) - deg(want))).toFixed(2) });
}

// ---------------------------------------------------------------------------
// C4  footprint size and aspect against PUBLISHED
// ---------------------------------------------------------------------------
const foot = [];
for (const [id, [pl, pw, src]] of Object.entries(PUBLISHED)) {
  const l = lmById.get(id), m = romeById.get(id);
  if (!l) { foot.push({ id, note: 'not placed', src }); continue; }
  const a = Math.max(l.hw, l.hd) * 2, b = Math.min(l.hw, l.hd) * 2;
  foot.push({ id, published: [pl, pw], modelled: [+a.toFixed(1), +b.toFixed(1)],
    ratio: +(a / pl).toFixed(3), aspectPub: +(pl / pw).toFixed(3), aspectMod: +(a / b).toFixed(3),
    surveyLen: m ? m.len : null, surveyWid: m ? m.wid : null, src });
}

// ---------------------------------------------------------------------------
// C5  the river: centreline departure and the SIGN of curvature
// ---------------------------------------------------------------------------
const ctlR = TIBER_CONTROL.map(([nm, la, lo]) => ({ nm, ...enOfLatLon(la, lo) })).sort((a, b) => a.n - b.n);
const ctlE = (n) => { for (let i = 0; i < ctlR.length - 1; i++) if (n >= ctlR[i].n && n <= ctlR[i + 1].n) { const t = (n - ctlR[i].n) / (ctlR[i + 1].n - ctlR[i].n); return ctlR[i].e + t * (ctlR[i + 1].e - ctlR[i].e); } return NaN; };
const engPts = D.river.map(([z, x]) => surveyOf(x, z)).sort((a, b) => a.n - b.n);
const engE = (n) => { for (let i = 0; i < engPts.length - 1; i++) if (n >= engPts[i].n && n <= engPts[i + 1].n) { const t = (n - engPts[i].n) / (engPts[i + 1].n - engPts[i].n); return engPts[i].e + t * (engPts[i + 1].e - engPts[i].e); } return NaN; };
const river = { samples: [], worst: null, signFlips: 0, spanN: [ctlR[0].n, ctlR[ctlR.length - 1].n] };
const H = 100;
for (let n = Math.ceil(ctlR[0].n / 50) * 50 + H; n <= ctlR[ctlR.length - 1].n - H; n += 50) {
  const a = engE(n), b = ctlE(n);
  if (!isFinite(a) || !isFinite(b)) continue;
  const c1 = (engE(n + H) - 2 * a + engE(n - H)) / (H * H);
  const c2 = (ctlE(n + H) - 2 * b + ctlE(n - H)) / (H * H);
  const flat = (v) => Math.abs(v) < 5e-4 / 100; // 5e-6: below this the line is straight
  const flip = !flat(c1) && !flat(c2) && Math.sign(c1) !== Math.sign(c2);
  if (flip) river.signFlips++;
  const s = { n, eng: +a.toFixed(0), ctl: +b.toFixed(0), dev: +(a - b).toFixed(0),
    devWorld: +((a - b) * KX).toFixed(0), c1: +(c1 * 1e4).toFixed(2), c2: +(c2 * 1e4).toFixed(2), flip };
  river.samples.push(s);
  if (!river.worst || Math.abs(s.dev) > Math.abs(river.worst.dev)) river.worst = s;
}
// the reach the battle happens in: the Aurelian front and the Campus Martius
river.fought = river.samples.filter((s) => s.n >= 900 && s.n <= 2100);
river.foughtWorst = river.fought.reduce((a, b) => (Math.abs(b.dev) > Math.abs(a?.dev ?? 0) ? b : a), null);

// ---------------------------------------------------------------------------
// C6  the circuit's fourteen waypoints, and the front they produce
// ---------------------------------------------------------------------------
const circuit = D.circuit.map((p) => ({ ...p, ...worldOf(p.e, p.n) }));
const front = { west: circuit[0], gate: circuit.find((c) => c.id === 'porta-flaminia'), east: circuit.find((c) => c.id === 'castra-ne') };
// the wall's own west end against the modelled river's east bank at the same z
const wallByX = new Map(D.wall.map(([x, z]) => [x, z]));
const riverAtZ = (z) => { let best = null; for (const [zz, xx] of D.river) if (!best || Math.abs(zz - z) < Math.abs(best[0] - z)) best = [zz, xx]; return best ? best[1] : NaN; };

// ---------------------------------------------------------------------------
// C7  nothing stands in water
// ---------------------------------------------------------------------------
const RHW = D.constants.RIVER_HALF_WIDTH;
const inWater = (x, z, hw, hd, rot) => {
  // sample the oriented box; count a solid wet if its centre or >= 2 corners are in channel
  const c = Math.cos(rot), s = Math.sin(rot);
  const pts = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [x + c * hw * a + s * hd * b, z - s * hw * a + c * hd * b]);
  let wet = 0;
  for (const [px, pz] of pts) if (Math.abs(px - riverAtZ(pz)) < RHW) wet++;
  return { wet, centreWet: Math.abs(pts[0][0] - riverAtZ(pts[0][1])) < RHW };
};
let wetInsulae = 0, wetInsulaeFull = 0;
for (const b of D.insulae) { const r = inWater(b.x, b.z, b.hw, b.hd, b.rot); if (r.centreWet) wetInsulae++; if (r.wet === 5) wetInsulaeFull++; }
const wetLandmarks = D.landmarks.filter((l) => inWater(l.x, l.z, l.hw, l.hd, l.rot).centreWet).map((l) => l.id);

// ---------------------------------------------------------------------------
// C8  nothing stands in a carriageway  (own polygon clip, never the repo's)
// ---------------------------------------------------------------------------
const box = (x, z, hw, hd, rot) => { const c = Math.cos(rot), s = Math.sin(rot); return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [x + c * hw * a + s * hd * b, z - s * hw * a + c * hd * b]); };
const clip = (sub, cl) => { // Sutherland-Hodgman, convex clipper
  let out = sub;
  for (let i = 0; i < cl.length && out.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const next = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length], sp = side(p), sq = side(q);
      if (sp <= 0) next.push(p);
      if ((sp <= 0) !== (sq <= 0)) { const t = sp / (sp - sq); next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
    out = next;
  }
  return out;
};
const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; };
const segQuad = (a, b, halfW) => { const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1; const nx = (-dz / L) * halfW, nz = (dx / L) * halfW; return [[a.x + nx, a.z + nz], [b.x + nx, b.z + nz], [b.x - nx, b.z - nz], [a.x - nx, a.z - nz]]; };
// The carriageway population is `WAYS` where the dump has it — that is the road set the
// game reserves and draws (src/city/rome/plan.ts:204, fabric.ts:1464). `STREETS` alone is
// what the plan-view diagnostic uses and is a strictly smaller set.
const roadSrc = (D.ways && D.ways[0] && D.ways[0].path) ? D.ways : D.streets;
const carriage = [];
for (const st of roadSrc) for (let i = 0; i < st.path.length - 1; i++) carriage.push({ id: st.id, cls: st.cls, q: segQuad(st.path[i], st.path[i + 1], st.width / 2) });
let carriageArea = 0; for (const c of carriage) carriageArea += area(c.q);
let roadAreaLm = 0; const roadLm = new Map();
for (const l of D.landmarks) { const bx = box(l.x, l.z, l.hw, l.hd, l.rot); for (const c of carriage) { const A = area(clip(bx, c.q)); if (A > 1) { roadAreaLm += A; roadLm.set(l.id, (roadLm.get(l.id) ?? 0) + A); } } }
let roadAreaIns = 0, roadInsCount = 0;
for (const b of D.insulae) { const bx = box(b.x, b.z, b.hw, b.hd, b.rot); let A = 0; for (const c of carriage) A += area(clip(bx, c.q)); if (A > 1) { roadAreaIns += A; roadInsCount++; } }

// ---------------------------------------------------------------------------
// C9  nothing stands inside the curtain / off the north edge of the city
// ---------------------------------------------------------------------------
const wallZAt = (x) => { let best = null; for (const [xx, zz] of D.wall) if (!best || Math.abs(xx - x) < Math.abs(best[0] - x)) best = [xx, zz]; return best ? best[1] : NaN; };
const northOfWall = [];
for (const l of D.landmarks) { const bx = box(l.x, l.z, l.hw, l.hd, l.rot); let worst = 0; for (const [px, pz] of bx) { const d = wallZAt(px) - pz; if (d > worst) worst = d; } if (worst > 1) northOfWall.push({ id: l.id, m: +worst.toFixed(1) }); }
let insNorth = 0; for (const b of D.insulae) { const bx = box(b.x, b.z, b.hw, b.hd, b.rot); for (const [px, pz] of bx) if (wallZAt(px) - pz > 1) { insNorth++; break; } }

// ---------------------------------------------------------------------------
// C10 regions partition
// ---------------------------------------------------------------------------
let claimed = 0; for (const d of D.districts) claimed += 4 * d.hw * d.hd;
let overlapPairs = 0, doubleClaimed = 0;
for (let i = 0; i < D.districts.length; i++) for (let j = i + 1; j < D.districts.length; j++) {
  const A = box(D.districts[i].x, D.districts[i].z, D.districts[i].hw, D.districts[i].hd, D.districts[i].rot);
  const B = box(D.districts[j].x, D.districts[j].z, D.districts[j].hw, D.districts[j].hd, D.districts[j].rot);
  const a = area(clip(A, B)); if (a > 25) { overlapPairs++; doubleClaimed += a; }
}

// ---------------------------------------------------------------------------
// C11 grain: block orientation against the nearest ranked way
// ---------------------------------------------------------------------------
const wayDirs = [];
for (const st of roadSrc) for (let i = 0; i < st.path.length - 1; i++) { const a = st.path[i], b = st.path[i + 1]; wayDirs.push({ mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2, ang: Math.atan2(b.z - a.z, b.x - a.x) }); }
const grainErr = [];
for (const b of D.insulae) {
  let best = null, bd = Infinity;
  for (const w of wayDirs) { const d = Math.hypot(b.x - w.mx, b.z - w.mz); if (d < bd) { bd = d; best = w; } }
  if (!best || bd > 200) continue;
  // Fold to 0..45: a rectangle aligned with a street may have either of its two sides
  // along the street, so 90 deg is alignment, not error.
  let dd = Math.abs(wrap(((-b.rot - best.ang) * 180) / Math.PI));
  if (dd > 45) dd = 90 - dd;
  grainErr.push(dd);
}
grainErr.sort((a, b) => a - b);
const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const f = (v, w = 7, d = 0) => (v === undefined || v === null || Number.isNaN(v) ? '—' : Number(v).toFixed(d)).padStart(w);
console.log(`\n=== JUDGE: Rome plan fidelity ===  KZ ${KZ}  KX ${KX}  landmarks ${D.landmarks.length}  insulae ${D.insulae.length}`);
if (frameNotes.length) console.log('FRAME DISAGREEMENT:', frameNotes.join('; ')); else console.log('frame: GATE_X/GATE_Z re-derived independently and agree.');

console.log('\n-- C1/C2 position, real metres. surveyErr = the table vs the plate. builtErr = what the player gets vs the plate.');
console.log('id                       how        surveyErr  resolver  builtErr  builtWorld');
const sorted = pos.slice().sort((a, b) => (b.builtErr ?? b.resolverReal ?? 0) - (a.builtErr ?? a.resolverReal ?? 0));
for (const r of sorted) console.log(`${r.id.padEnd(24)} ${(r.how + (r.placed ? '' : ' OFFMAP')).padEnd(12)}${f(r.surveyErr, 8)}  ${f(r.resolverReal, 8)}  ${f(r.builtErr, 8)}  ${f(r.builtWorldErr, 8)}`);
const gradedRows = pos.filter((r) => r.graded && r.placed);
const refRows = pos.filter((r) => r.builtErr !== undefined && r.placed);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log(`\ngraded rows ${gradedRows.length}/${D.landmarks.length} placed.  survey-vs-plate: median ${med(gradedRows.map(r=>r.surveyErr)).toFixed(0)} m, worst ${Math.max(...gradedRows.map(r=>r.surveyErr)).toFixed(0)} m`);
console.log(`built-vs-plate (evidence rows only, n=${gradedRows.length}): median ${med(gradedRows.map(r=>r.builtErr)).toFixed(0)} m, worst ${Math.max(...gradedRows.map(r=>r.builtErr)).toFixed(0)} m`);
console.log(`built-vs-reference (incl. restated survey cites, n=${refRows.length}): median ${med(refRows.map(r=>r.builtErr)).toFixed(0)} m, worst ${Math.max(...refRows.map(r=>r.builtErr)).toFixed(0)} m`);
const allRes = pos.filter(r=>r.placed).map(r=>r.resolverReal);
console.log(`resolver displacement, all ${allRes.length} placed: mean ${(allRes.reduce((a,b)=>a+b,0)/allRes.length).toFixed(0)} m, median ${med(allRes).toFixed(0)} m, worst ${Math.max(...allRes).toFixed(0)} m real  (${Math.max(...pos.filter(r=>r.placed).map(r=>r.resolverWorld)).toFixed(0)} m world)`);

console.log('\n-- C3 bearing: drawn plan rotation vs the survey bearing projected at the frame\'s own KX/KZ');
bear.sort((a, b) => b.err - a.err);
for (const b of bear.slice(0, 12)) console.log(`  ${b.id.padEnd(22)} bearing ${String(b.bearing).padStart(6)} axis ${b.axis}  drawn ${f(b.builtRotDeg,8,1)}  want ${f(b.wantRotDeg,8,1)}  err ${f(b.err,6,1)} deg`);
console.log(`  bearing error: median ${med(bear.map(b=>b.err)).toFixed(1)} deg, worst ${Math.max(...bear.map(b=>b.err)).toFixed(1)} deg over ${bear.length} monuments`);

console.log('\n-- C4 footprint against published plan');
console.log('id                       published      modelled     mod/pub  aspect pub/mod');
for (const r of foot) if (r.modelled) console.log(`${r.id.padEnd(24)} ${String(r.published[0]).padStart(5)}x${String(r.published[1]).padEnd(6)} ${String(r.modelled[0]).padStart(6)}x${String(r.modelled[1]).padEnd(6)} ${f(r.ratio,8,3)}   ${f(r.aspectPub,5,2)} / ${f(r.aspectMod,5,2)}`); else console.log(`${r.id.padEnd(24)} ${r.note}`);

console.log('\n-- C5 the Tiber against sixteen bridge midpoints');
console.log(`  span graded: survey n ${river.spanN[0].toFixed(0)} .. ${river.spanN[1].toFixed(0)}  (${river.samples.length} samples at 50 m)`);
console.log(`  worst departure overall : ${river.worst.dev} real m (${river.worst.devWorld} world m) at n ${river.worst.n}`);
console.log(`  worst in the fought reach (n 900..2100): ${river.foughtWorst.dev} real m (${river.foughtWorst.devWorld} world m) at n ${river.foughtWorst.n}`);
console.log(`  curvature-sign disagreements: ${river.signFlips} of ${river.samples.length} samples`);
for (const s of river.samples) if (Math.abs(s.dev) > 90 || s.flip) console.log(`    n ${String(s.n).padStart(5)}  eng ${f(s.eng,6)}  ctl ${f(s.ctl,6)}  dev ${f(s.dev,5)} real / ${f(s.devWorld,4)} world   d2e/dn2 eng ${f(s.c1,8,2)} ctl ${f(s.c2,8,2)} ${s.flip ? '<< SIGN INVERTED' : ''}`);

console.log('\n-- C5b the Tiber against the plate itself (supersedes the bridge control where they disagree)');
{
  let sumEng = 0, sumPl = 0;
  const first = TIBER_PLATE[0], last = TIBER_PLATE[TIBER_PLATE.length - 1];
  for (const st of TIBER_PLATE) {
    const a = engE(st.n), b = ctlE(st.n);
    console.log(`  n ${String(st.n).padStart(5)}  plate e ${f(st.e,6)} +-${st.err}   engine e ${f(a,6)}   dev ${f(a - st.e,5)} real / ${f((a - st.e) * KX,4)} world      (bridge control ${f(b,6)}, off the plate by ${f(b - st.e,4)})`);
  }
  const engSwing = engE(last.n) - engE(first.n), plSwing = last.e - first.e;
  console.log(`  over n ${first.n} -> ${last.n} (${first.n - last.n} real m of northing) the PLATE's channel swings ${plSwing.toFixed(0)} m east; the ENGINE's swings ${engSwing.toFixed(0)} m.`);
  console.log(`  the engine reproduces ${(100 * engSwing / plSwing).toFixed(0)}% of the real bend on the reach the assault is fought beside.`);
}

console.log('\n-- C6b the circuit gates against the plate own inked, labelled wall');
{
  const byId = new Map(D.circuit.map((c) => [c.id, c]));
  for (const p of CIRCUIT_PLATE) {
    const c = byId.get(p.id); if (!c) continue;
    const de = c.e - p.e, dn = c.n - p.n;
    console.log(`  ${p.id.padEnd(20)} survey (${String(c.e).padStart(5)},${String(c.n).padStart(5)})  plate (${String(p.e).padStart(5)},${String(p.n).padStart(5)}) +-${p.err}   err ${f(Math.hypot(de,dn),5)} real m  (dE ${f(de,5)}, dN ${f(dn,5)})  = ${f(Math.hypot(de*KX,dn*KZ),4)} world m`);
  }
}

console.log('\n-- C6 the circuit');
console.log(`  west end (tiber-angle)  x ${front.west.x.toFixed(2)}  z ${front.west.z.toFixed(2)}`);
console.log(`  Porta Flaminia          x ${front.gate.x.toFixed(2)}  z ${front.gate.z.toFixed(2)}`);
console.log(`  east end (castra-ne)    x ${front.east.x.toFixed(2)}  z ${front.east.z.toFixed(2)}   front ${(front.east.x - front.west.x).toFixed(1)} world m`);
{
  const zW = front.west.z, rx = riverAtZ(zW);
  console.log(`  modelled river centre at the west end's z: x ${rx.toFixed(1)}; east bank x ${(rx + RHW).toFixed(1)}; wall angle x ${front.west.x.toFixed(1)} -> ${(front.west.x - rx - RHW).toFixed(1)} world m of dry ground`);
  const ctlAtN = ctlE(2006);
  console.log(`  control river at n 2006: e ${ctlAtN.toFixed(0)}; circuit's tiber-angle e -655 -> ${(-655 - ctlAtN).toFixed(0)} real m east of the real channel centre (${((-655 - ctlAtN) * KX).toFixed(0)} world m)`);
}

// ---------------------------------------------------------------------------
// C6c topology: does the built city preserve the plate's own left/right, near/far?
// A metric error a player cannot name is survivable; an inverted relation is not.
// ---------------------------------------------------------------------------
{
  // Topology uses every row that has a position, plate or restated: the survey reads within
  // 8 m of the plate at the median of the rows that could be checked, so it is a sound
  // reference for left/right and near/far even where it is not evidence of its own accuracy.
  const rows = pos.filter((r) => r.placed && ctlById.get(r.id) && ctlById.get(r.id).e !== undefined);
  let tested = 0, brokenE = 0, brokenN = 0; const named = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const A = rows[i], B = rows[j];
    const cA = ctlById.get(A.id), cB = ctlById.get(B.id);
    if (Math.abs(cA.e - cB.e) > 100) { tested++; if (Math.sign(A.builtE - B.builtE) !== Math.sign(cA.e - cB.e)) { brokenE++; named.push(`${A.id} is no longer ${cA.e > cB.e ? 'east' : 'west'} of ${B.id}`); } }
    if (Math.abs(cA.n - cB.n) > 100) { tested++; if (Math.sign(A.builtN - B.builtN) !== Math.sign(cA.n - cB.n)) { brokenN++; named.push(`${A.id} is no longer ${cA.n > cB.n ? 'north' : 'south'} of ${B.id}`); } }
  }
  console.log('\n-- C6c topology against the plate: relations that the build inverts');
  console.log(`  ${brokenE + brokenN} of ${tested} plate relations inverted (${brokenE} east/west, ${brokenN} north/south) over ${rows.length} graded monuments`);
  for (const t of named) console.log(`     ${t}`);
}

console.log('\n-- C7 nothing stands in water');
console.log(`  insulae with their centre inside the channel: ${wetInsulae} of ${D.insulae.length} (${(100*wetInsulae/D.insulae.length).toFixed(1)}%)`);
console.log(`  insulae wholly inside the channel:           ${wetInsulaeFull}`);
console.log(`  landmarks with their centre in the channel:  ${wetLandmarks.length} ${wetLandmarks.length ? '[' + wetLandmarks.join(', ') + ']' : ''}`);

console.log('\n-- C8 nothing stands in a carriageway');
console.log(`  monument footprint area inside a ranked carriageway: ${roadAreaLm.toFixed(0)} m^2 over ${roadLm.size} of ${D.landmarks.length} monuments`);
for (const [id, a] of [...roadLm].sort((x, y) => y[1] - x[1]).slice(0, 8)) console.log(`     ${id.padEnd(22)} ${a.toFixed(0)} m^2`);
console.log(`  insula footprint area inside a ranked carriageway:   ${roadAreaIns.toFixed(0)} m^2 over ${roadInsCount} of ${D.insulae.length} insulae`);
console.log(`  road population: ${roadSrc.length} ways, ${carriage.length} segments, ${(carriageArea/1e4).toFixed(1)} ha of carriageway  (${(100*(roadAreaLm+roadAreaIns)/carriageArea).toFixed(2)}% of it covered by a solid)`);
if (D.insulaeDiag !== undefined) console.log(`  NOTE: the game's keep-out (WAYS + WAY_FRONTAGE) builds ${D.insulae.length} insulae; the plan-view diagnostic's (STREETS at width/2+2.5) builds ${D.insulaeDiag}. The review screenshots show the second.`);

console.log('\n-- C9 nothing stands inside the curtain');
console.log(`  monuments with stone north of the wall line: ${northOfWall.length} ${northOfWall.length ? JSON.stringify(northOfWall) : ''}`);
console.log(`  insulae with a corner north of the wall line: ${insNorth}`);

console.log('\n-- C10 the regions must partition');
const availableGround = 1781 * 814;
console.log(`  ${D.districts.length} districts claim ${(claimed/1e6).toFixed(2)} km^2; ${overlapPairs} overlapping pairs; ${(doubleClaimed/1e6).toFixed(2)} km^2 claimed twice or more`);
console.log(`  claimed / walled world ground (1781x814 = ${(availableGround/1e6).toFixed(2)} km^2) = ${(claimed/availableGround).toFixed(2)}x   (a partition is 1.00)`);

// ---------------------------------------------------------------------------
// C12 does every quarter build?  insulae per district, by nearest district centre
// ---------------------------------------------------------------------------
const perDistrict = new Map(D.districts.map((d) => [d.id, 0]));
for (const b of D.insulae) {
  let best = null, bd = Infinity;
  for (const d of D.districts) { const dd = Math.hypot(b.x - d.x, b.z - d.z); if (dd < bd) { bd = dd; best = d; } }
  if (best) perDistrict.set(best.id, perDistrict.get(best.id) + 1);
}
console.log('\n-- C12 insulae attributed to each district (nearest centre) and its claimed area');
for (const d of D.districts) {
  const n = perDistrict.get(d.id), a = 4 * d.hw * d.hd;
  console.log(`  ${d.id.padEnd(18)} ${String(n).padStart(5)} insulae  claim ${(a/1e4).toFixed(1)} ha  ${n ? (a/n/1e2).toFixed(0)+' m2/insula' : 'BURIED'}`);
}

console.log('\n-- C11 grain: block orientation vs its nearest ranked way');
console.log(`  ${grainErr.length} blocks within 200 m of a ranked way: median ${q(grainErr,0.5).toFixed(2)} deg, p90 ${q(grainErr,0.9).toFixed(2)} deg, max ${grainErr[grainErr.length-1].toFixed(2)} deg`);
console.log(`  blocks more than 5 deg off their nearest way: ${grainErr.filter(v=>v>5).length} of ${grainErr.length}`);

if (arg('json', '')) fs.writeFileSync(arg('json'), JSON.stringify({ pos, bear, foot, river, wetInsulae, wetInsulaeFull, wetLandmarks, roadAreaLm, roadAreaIns, roadInsCount, northOfWall, insNorth, claimed, overlapPairs, doubleClaimed, grain: { n: grainErr.length, p50: q(grainErr,0.5), p90: q(grainErr,0.9) } }, null, 1));
