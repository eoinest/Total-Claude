#!/usr/bin/env node
/**
 * Screenshot driver for the city preview page.
 *
 * `tools/shoot.mjs` is the project's ground truth, but it loads `/` — which means it
 * only shows the city once the integrator has registered `CitySystem` in
 * `src/main.ts`. The city agent owns only `src/city/**`, so this driver points the
 * same camera set-ups at `/src/city/preview.html` instead. Shot names, positions,
 * zooms and yaws are copied verbatim from `tools/shoot.mjs` so the frames are directly
 * comparable with the graded ones.
 *
 *   node src/city/shoot-city.mjs --shots=city,skyline --out=screenshots/city
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');

// Copied from tools/SHOTS, plus a few close-ups that only make sense for masonry.
const SHOTS = {
  city: { desc: 'The Aurelian Wall and the city skyline behind the Roman line', x: 0, z: 320, zoom: 0.5, yaw: 0.0 },
  skyline: { desc: 'Rome from the north-west with the hills and landmarks silhouetted', x: -300, z: 420, zoom: 0.72, yaw: Math.PI * 1.75 },
  wide: { desc: 'High three-quarter view of the whole battlefield and the city behind', x: 0, z: 90, zoom: 0.95, yaw: Math.PI * 0.82 },
  establishing: { desc: 'Opening wide shot from behind the Roman line', x: 0, z: -20, zoom: 0.82, yaw: Math.PI },
  // City-only diagnostics. The camera rig couples zoom to pitch and to eye height, so
  // anything below zoom ~0.4 sits inside the terrain's grass layer and sees nothing;
  // these are all chosen to clear it.
  // Positions are keyed to the terrain's crest line (crestZAt), so they track the wall
  // rather than a hardcoded z. See src/terrain/topography.ts.
  wallhigh: { desc: 'Curtain, towers and courses from 30 m up, 55 m out', x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
  gate: { desc: 'The Porta Flaminia three-quarter, from the plain', x: 90, z: 520, zoom: 0.5, yaw: Math.PI * 0.06 },
  worksite: { desc: 'A half-built stretch with scaffolding and a treadwheel crane', x: 210, z: 528, zoom: 0.54, yaw: 0.0 },
  gapshot: { desc: 'The gap blocked with palisade and rubble, and the footings beyond', x: 340, z: 560, zoom: 0.58, yaw: 0.0 },
  overwall: { desc: 'Looking west along the wall-walk', x: 0, z: 545, zoom: 0.5, yaw: Math.PI * 1.5 },
  romanview: { desc: 'From the Roman line, the wall and the city behind it', x: 40, z: 330, zoom: 0.74, yaw: 0.0 },
  necropolis: { desc: 'The Via Flaminia necropolis with the wall beyond', x: 60, z: 400, zoom: 0.62, yaw: 0.0 },
  deep: { desc: 'Deep city: Capitol, Forum, Colosseum, Circus', x: -20, z: 1050, zoom: 0.86, yaw: Math.PI * 0.1 },
  campus: { desc: 'The Campus Martius: Mausoleum, Pantheon, theatres', x: -180, z: 780, zoom: 0.8, yaw: Math.PI * 0.05 },
  // Low obliques on the three monuments the user's report named. Coordinates come from the
  // plan diagnostic's own output (screenshots/*/plan.json), so they track the layout solver
  // rather than going stale the moment a footprint moves.
  colosseum: { desc: 'The Flavian Amphitheatre, low oblique — arena floor and cavea', x: 681, z: 1032, zoom: 0.68, yaw: Math.PI * 1.15 },
  circus: { desc: 'The Circus Maximus along its length — arcaded façade and banks', x: 286, z: 1153, zoom: 0.8, yaw: Math.PI * 1.35 },
  circusflank: { desc: 'The Circus Maximus from outside its south flank — three arcaded storeys', x: 250, z: 1256, zoom: 0.52, yaw: Math.PI * 0.55 },
  baths: { desc: 'The Baths of Trajan — precinct, vaulted block, palaestrae', x: 728, z: 741, zoom: 0.7, yaw: Math.PI * 0.15 },
};

/**
 * The plan-view diagnostic is a different page: `plan.html` draws the layout as a
 * labelled SVG at a known scale so it can be compared with Lanciani's Forma Urbis Romae
 * side by side, and prints the footprint-overlap assertion. Run it with
 * `--shots=plan`.
 */
const PLAN_SHOT = 'plan';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

if (args.has('list')) {
  for (const [k, v] of Object.entries(SHOTS)) console.log(`${k.padEnd(14)} ${v.desc}`);
  process.exit(0);
}

const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/city');
const PORT = Number(args.get('port') ?? 5214);
const QUALITY = args.get('quality') ?? 'ultra';
const requested = args.get('shots')
  ? String(args.get('shots')).split(',').map((s) => s.trim()).filter(Boolean)
  : Object.keys(SHOTS);

for (const s of requested) {
  if (s === PLAN_SHOT) continue;
  if (!SHOTS[s]) {
    console.error(`Unknown shot "${s}". Available: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(2);
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

let server = null;
let browser = null;
let failed = 0;
const results = [];

try {
  const base = `http://127.0.0.1:${PORT}`;
  if (!(await waitForServer(base, 1200))) {
    console.log(`• starting vite on ${PORT}`);
    server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let log = '';
    server.stdout.on('data', (d) => { log += d.toString(); });
    server.stderr.on('data', (d) => { log += d.toString(); });
    if (!(await waitForServer(base, 60000))) {
      console.error('vite failed to start:\n' + log.slice(-3000));
      throw new Error('dev server did not come up');
    }
  } else {
    console.log(`• reusing dev server on ${PORT}`);
  }

  await mkdir(OUT, { recursive: true });
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const consoleErrors = [];
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ---- the plan-view diagnostic, on its own page ------------------------
  if (requested.includes(PLAN_SHOT)) {
    const planPage = await browser.newPage({ viewport: { width: 1620, height: 1600 }, deviceScaleFactor: 1 });
    planPage.on('pageerror', (e) => consoleErrors.push(`plan pageerror: ${e.message}`));
    await planPage.goto(`${base}/src/city/plan.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await planPage.waitForFunction(() => window.__plan && window.__plan.ready === true, { timeout: 60000 });
    const plan = await planPage.evaluate(() => window.__plan);
    const wrap = await planPage.$('#wrap');
    await planPage.screenshot({ path: path.join(OUT, 'plan.png'), type: 'png', fullPage: true });
    if (wrap) await wrap.screenshot({ path: path.join(OUT, 'plan-map.png'), type: 'png' });
    await writeFile(path.join(OUT, 'plan.json'), JSON.stringify(plan, null, 2));
    console.log(
      `  ✓ ${'plan'.padEnd(13)} ${plan.rows.length} landmarks  ` +
      `overlaps ${plan.overlaps.count} (worst ${plan.overlaps.worst} m)  ` +
      `amphitheatres ${plan.amphitheatres.count}  ` +
      `topology ${plan.topology.checks - plan.topology.failures.length}/${plan.topology.checks}`
    );
    for (const pr of plan.overlaps.pairs) console.log(`      ! ${pr.a} x ${pr.b}  ${pr.depth} m`);
    for (const f of plan.topology.failures) console.log(`      ! ${f}`);
    await planPage.close();
    requested.splice(requested.indexOf(PLAN_SHOT), 1);
    if (requested.length === 0) {
      await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), plan, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
      if (consoleErrors.length) {
        failed++;
        console.error(`\n⚠ ${consoleErrors.length} console error(s):`);
        for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.error(`   ${e}`);
      }
      throw { __done: true };
    }
  }

  const procedural = args.has('procedural') ? '&procedural=1' : '';
  const url = `${base}/src/city/preview.html?quality=${QUALITY}&w=${W}&h=${H}${procedural}`;
  console.log(`• loading ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__city && window.__city.ready === true, { timeout: 180000 });
  console.log(`• ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const name of requested) {
    const shot = SHOTS[name];
    const started = Date.now();
    try {
      // Vite's HMR reloads the page whenever any agent saves a file, which destroys
      // the execution context mid-run. Re-wait for readiness before every shot.
      await page.waitForFunction(() => window.__city && window.__city.ready === true, { timeout: 180000 });
      const info = await page.evaluate(({ s }) => {
        const g = window.__city;
        g.setCamera(s.x, s.z, s.zoom, s.yaw);
        for (let i = 0; i < 20; i++) g.engine.frame(performance.now() + i * 16.7);
        const st = g.engine.stats();
        return { draws: st.calls, tris: st.tris, fps: g.engine.time.fps, ms: g.engine.time.frameMs };
      }, { s: shot });
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, type: 'png' });
      results.push({ name, ...info, desc: shot.desc });
      console.log(
        `  ✓ ${name.padEnd(13)} ${String(info.draws).padStart(4)} draws  ` +
        `${(info.tris / 1e6).toFixed(2)}M tris  ${info.fps.toFixed(0)} fps  ${info.ms.toFixed(1)} ms  ${Date.now() - started}ms`
      );
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  if (consoleErrors.length) {
    failed++;
    console.error(`\n⚠ ${consoleErrors.length} console error(s):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.error(`   ${e}`);
  }
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), width: W, height: H, shots: results, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
  console.log(`\n→ ${results.length}/${requested.length} shots in ${path.relative(ROOT, OUT)}/`);
} catch (err) {
  if (!err || !err.__done) {
    console.error(`FATAL: ${err.stack ?? err.message}`);
    failed++;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && !args.has('keep')) server.kill('SIGTERM');
}

process.exit(failed > 0 ? 1 : 0);
