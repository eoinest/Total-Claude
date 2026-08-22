#!/usr/bin/env node
/**
 * judge: dump the Rome plan out of a running page, as JSON, and nothing else.
 *
 * This file makes no judgement. It is a *reader*: it starts a dev server in a named
 * checkout, loads `src/city/plan.html`, and returns the plan objects verbatim —
 * landmarks, districts, streets, insula footprints, the circuit, the river, and a dense
 * sample of the river centreline and the wall line. The grading is done offline in
 * `grade.mjs` against plate-digitised control points, so the ruler is never in the same
 * file as the defendant.
 *
 *   node tools/judge/dump-plan.mjs --root=/abs/path/to/checkout --port=5943 --out=/tmp/x.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const ROOT = arg('root', process.cwd());
const PORT = Number(arg('port', 5943));
const OUT = arg('out', '/tmp/judge/plan.json');
if (PORT === 5173) { console.error("5173 is the owner's port"); process.exit(2); }

const cache = path.join(ROOT, '.vite-judge');
mkdirSync(cache, { recursive: true });
const vite = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, TC_VITE_CACHE_DIR: cache, TC_NO_HMR: '1' },
});
let log = '';
vite.stdout.on('data', (d) => { log += d; });
vite.stderr.on('data', (d) => { log += d; });
const die = (code) => { try { vite.kill('SIGKILL'); } catch {} process.exit(code); };
process.on('SIGINT', () => die(130));
process.on('uncaughtException', (e) => { console.error(e); die(1); });

const t0 = Date.now();
while (!/localhost:\d+|127\.0\.0\.1:\d+/.test(log)) {
  if (Date.now() - t0 > 90000) { console.error('vite did not start:\n' + log); die(3); }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/src/city/plan.html`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__plan && window.__plan.ready === true, null, { timeout: 300000 });

  const data = await page.evaluate(async () => {
    const survey = await import('/src/city/rome/survey.ts');
    const layout = await import('/src/city/rome/layout.ts');
    const topo = await import('/src/terrain/topography.ts');
    const fabricMod = await import('/src/city/rome/fabric.ts');
    const circuit = await import('/src/city/rome/circuit.ts');
    const out = {
      constants: {
        KX: survey.KX, KZ: survey.KZ, GATE_X: topo.GATE_X, GATE_Z: topo.GATE_Z,
        PLAN_SCALE: layout.PLAN_SCALE, PRECINCT: layout.PRECINCT,
        ROT_RATIO: survey.ROT_RATIO ?? null,
        RIVER_HALF_WIDTH: topo.RIVER_HALF_WIDTH, WATER_LEVEL: topo.WATER_LEVEL ?? null,
        HALF_EXTENT: 1400,
      },
      rome: survey.ROME.map((m) => ({ id: m.id, name: m.name, e: m.e, n: m.n, len: m.len, wid: m.wid,
        bearing: m.bearing, axis: m.axis ?? 'x', soft: !!m.soft, farBank: !!m.farBank,
        onRiver: !!m.onRiver, where: m.where, cite: m.cite })),
      landmarks: layout.LANDMARKS.map((l) => ({ id: l.id, x: l.x, z: l.z, hw: l.hw, hd: l.hd, rot: l.rot, soft: !!l.soft })),
      offMapSouth: (layout.OFF_MAP_SOUTH ?? []).map((m) => m.id),
      circuit: topo.ROME_CIRCUIT_SURVEY.map((p) => ({ id: p.id, e: p.e, n: p.n })),
      tiberPath: Array.from(topo.TIBER_PATH),
      districts: layout.DISTRICTS.map((d) => ({ id: d.id, x: d.x, z: d.z, hw: d.hw, hd: d.hd, rot: d.rot ?? 0 })),
      streets: layout.STREETS.map((s) => ({ id: s.id, cls: s.cls, width: s.width, path: s.path })),
      ways: layout.WAYS.map((w) => ({ id: w.id, cls: w.cls, width: w.width, path: w.path })),
      wayFrontage: layout.WAY_FRONTAGE,
      plazas: (layout.PLAZAS ?? []).map((p) => ({ x: p.x, z: p.z, r: p.r ?? p.hw ?? 0 })),
      river: [], wall: [], crest: [],
    };
    for (let z = -1400; z <= 1400; z += 5) out.river.push([z, topo.riverCentreX(z)]);
    for (let x = -1400; x <= 1400; x += 5) { out.wall.push([x, topo.romeWallZ(x)]); out.crest.push([x, topo.crestZAt(x)]); }
    // Rebuilt exactly as src/city/plan.ts:195-202 does it, so the insula list is the one
    // the plan view draws rather than a variant of it.
    try {
      const cityLayout = await import('/src/city/layout.ts');
      // Two keep-outs, because the two differ and the difference matters. `game` is what
      // src/city/rome/plan.ts:196-205 builds (WAYS + WAY_FRONTAGE), i.e. the city the
      // player gets. `diag` is what src/city/plan.ts:195-201 builds (STREETS only, at
      // width/2 + 2.5), i.e. the city the plan-view screenshots show. A judge that graded
      // the second would be grading a picture nobody ships.
      const mk = (which) => {
        const k = new cityLayout.KeepOut();
        for (const l of layout.LANDMARKS) {
          k.addRect(l.x, l.z, l.hw, l.hd, l.rot);
          if (l.mound) k.addCircle(l.x, l.z, (l.moundRadius ?? l.clear) * 1.02);
        }
        if (which === 'game') {
          for (const w of layout.WAYS) k.addPath(w.path, w.width * 0.5 + layout.WAY_FRONTAGE[w.cls]);
        } else {
          for (const st of layout.STREETS) k.addPath(st.path, st.width * 0.5 + 2.5);
        }
        for (const a of layout.AQUEDUCTS) k.addPath(a.path, 8);
        return k;
      };
      const fg = fabricMod.buildDistricts(() => 20, mk('game'), 'rome-fabric', (x) => topo.crestZAt(x));
      out.insulae = fg.footprints.map((b) => ({ x: b.x, z: b.z, hw: b.hw, hd: b.hd, rot: b.rot ?? 0 }));
      out.lanes = (fg.lanes ?? []).map((l) => ({ cls: l.cls ?? 'vicus', width: l.width ?? 8, path: l.path ?? null }));
      const fd = fabricMod.buildDistricts(() => 20, mk('diag'), 'rome-fabric', (x) => topo.crestZAt(x));
      out.insulaeDiag = fd.footprints.length;
    } catch (e) { out.fabricNote = String(e && e.stack || e); }
    try { out.wallXRange = [circuit.WALL_X_MIN, circuit.WALL_X_MAX]; } catch {}
    return out;
  });
  data.pageErrors = errs.slice(0, 10);
  writeFileSync(OUT, JSON.stringify(data));
  console.log(`wrote ${OUT}  landmarks=${data.landmarks.length} insulae=${(data.insulae||[]).length} ways=${data.ways.length} KZ=${data.constants.KZ}`);
  if (errs.length) console.warn('page errors:', errs.slice(0, 3));
} finally {
  await browser.close();
  vite.kill('SIGKILL');
}
