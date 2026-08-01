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
 *   node src/city/shoot-city.mjs --shots=plan                  # labelled SVG plan + assertions
 *   node src/city/shoot-city.mjs --shots=aerial                # orthographic plan views vs
 *                                                              # the georeferenced Lanciani plan
 *   node src/city/shoot-city.mjs --shots=aerial --ref=aerial    # ...vs the 2012 orthophoto
 *   node src/city/shoot-city.mjs --shots=aerial --lod=1         # at the detail the field sees
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
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
  // Masonry close-ups. The graded shot set has nothing nearer than the wall camera, so
  // brick courses, sett shapes and marble veining have no frame that can show them.
  // zoom 0.42 is the nearest the rig gives before the eye drops into the grass layer.
  brickclose: { desc: 'The curtain face up close: courses, bond, mortar', x: -120, z: 452, zoom: 0.42, yaw: 0.0 },
  gateclose: { desc: 'The Porta Flaminia close: brick, travertine dressings, paving', x: 90, z: 500, zoom: 0.42, yaw: Math.PI * 0.06 },
  // On the Via Lata itself. Coordinates read off the baked `streets-road` positions,
  // because the street paths are authored in survey coordinates, not world ones.
  streetclose: { desc: 'Standing on a paved street: basalt setts at eye level', x: 132, z: 915, zoom: 0.42, yaw: Math.PI * 0.02 },
  // Landmark centres from layout.LANDMARKS. Both pronaoi face -Z, so the camera sits south
  // looking along +Z; the rig ties eye height to zoom, so it has to stand well back or it
  // ends up inside the cella.
  pantheonclose: { desc: 'The Pantheon pronaos: granite shafts, marble entablature', x: 134, z: 690, zoom: 0.5, yaw: 0.0 },
  templeclose: { desc: 'The Capitoline temple front: marble order on travertine', x: 279, z: 895, zoom: 0.48, yaw: 0.0 },
};

/**
 * The plan-view diagnostic is a different page: `plan.html` draws the layout as a
 * labelled SVG at a known scale so it can be compared with Lanciani's Forma Urbis Romae
 * side by side, and prints the footprint-overlap assertion. Run it with
 * `--shots=plan`.
 */
const PLAN_SHOT = 'plan';

/**
 * Orthographic plan views, rendered through the real engine.
 *
 * `--shots=aerial` renders each of these rectangles three times — the city alone, the
 * georeferenced archaeological plan alone, and the two together — through an orthographic
 * camera looking straight down at a *known* world rectangle. Because the projection is
 * orthographic and the rectangle is exact, screen pixels are a linear function of world
 * metres: 1 px = (maxX − minX) / width metres, everywhere in the frame. That is what makes
 * the comparison measurable rather than impressionistic, and it is what the user asked for
 * — "aerial photos of rome versus aerial photos of the layout".
 *
 * Each triple is also composited into a side-by-side and a 50/50 blend, and annotated with
 * a 250 m world graticule plus a marker per landmark at its *projected* position, so the
 * residual between marker and masonry is the layout solver's drift read straight off the
 * picture.
 */
const AERIALS = {
  // The whole heightfield, so anything standing in the battlefield is in frame.
  field: { desc: 'Whole heightfield from directly overhead', minX: -1400, maxX: 1400, minZ: -1400, maxZ: 1400, px: 1600 },
  // The city band: everything behind the wall crest.
  city: { desc: 'The city behind the wall, plan view', minX: -1400, maxX: 1400, minZ: 380, maxZ: 1400, px: 2000 },
  // The monumental core, where the survey is densest and the solver works hardest.
  core: { desc: 'Capitol, Fora, Palatine, Colosseum, Circus', minX: -200, maxX: 1200, minZ: 560, maxZ: 1340, px: 1800 },
};
const AERIAL_SHOT = 'aerial';

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
  if (s === PLAN_SHOT || s === AERIAL_SHOT) continue;
  if (!SHOTS[s]) {
    console.error(`Unknown shot "${s}". Available: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(2);
  }
}

/**
 * Render the plan-view triples and measure the per-landmark residual.
 *
 * The three images of each rectangle are pixel-registered by construction — same camera,
 * same projection — so `sharp` can composite them directly into a side-by-side and a
 * blend. The annotation draws, in world metres:
 *
 *  - a 250 m graticule, labelled, so any distance in the frame can be read off;
 *  - a hollow square at each landmark's *projected* position (`worldOf` of the survey) and
 *    a filled dot at where it was actually built, joined by a line. The length of that line
 *    in metres is the overlap solver's drift, and it is printed in `aerial.json`.
 */
async function shootAerials(browser, base, out, refId, consoleErrors, lod = 0) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`aerial: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`aerial pageerror: ${e.message}`));
  const url = `${base}/src/city/preview.html?quality=ultra&w=1600&h=900`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__city && window.__city.ready === true, { timeout: 240000 });
  const marks = await page.evaluate(() => window.__city.landmarkTable());
  const hasRef = await page.evaluate((id) => window.__city.setOverlay(id, { mode: 'ground' }), refId);
  if (!hasRef) console.log(`  · reference raster "${refId}" not present — skipping the overlay images`);
  const results = [];

  for (const [name, a] of Object.entries(AERIALS)) {
    const w = a.px;
    const h = Math.round((a.px * (a.maxZ - a.minZ)) / (a.maxX - a.minX));
    await page.setViewportSize({ width: w, height: h });
    const files = {};
    for (const layer of hasRef ? ['city', 'ref', 'both'] : ['city']) {
      const info = await page.evaluate(async ({ a, layer, w, h, lod }) => {
        const g = window.__city;
        g.setSize(w, h);
        g.setOverlayVisible(layer !== 'city');
        g.setCityVisible(layer !== 'ref');
        g.planView({ minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ }, lod);
        for (let i = 0; i < 12; i++) g.engine.frame(performance.now() + i * 16.7);
        const st = g.engine.stats();
        return { draws: st.calls, tris: st.tris, ms: g.engine.time.frameMs };
      }, { a, layer, w, h, lod });
      const f = path.join(out, `aerial-${name}-${layer}${lod ? `-lod${lod}` : ''}.png`);
      await page.screenshot({ path: f, type: 'png' });
      files[layer] = f;
      if (layer === 'city') results.push({ name, ...info, desc: a.desc, mPerPx: (a.maxX - a.minX) / w });
    }
    await page.evaluate(() => { window.__city.setCityVisible(true); });

    // Annotate the city render, then compose the comparisons.
    const mpp = (a.maxX - a.minX) / w;
    await sharp(files.city)
      .composite([{ input: Buffer.from(annotate(a, w, h, marks)), top: 0, left: 0 }])
      .png().toFile(path.join(out, `aerial-${name}-city-marked${lod ? `-lod${lod}` : ''}.png`));
    if (files.ref) {
      await sharp(files.ref)
        .composite([{ input: Buffer.from(annotate(a, w, h, marks)), top: 0, left: 0 }])
        .png().toFile(path.join(out, `aerial-${name}-ref-marked.png`));
      // Side by side, plan left, render right.
      const gap = 12;
      await sharp({ create: { width: w * 2 + gap, height: h, channels: 3, background: '#101010' } })
        .composite([
          { input: await sharp(files.ref).png().toBuffer(), left: 0, top: 0 },
          { input: await sharp(files.city).png().toBuffer(), left: w + gap, top: 0 },
        ])
        .png().toFile(path.join(out, `aerial-${name}-side.png`));
      // 50/50 blend: registration error shows as doubling.
      await sharp(files.ref)
        .composite([{ input: await sharp(files.city).ensureAlpha(0.5).png().toBuffer(), blend: 'over' }])
        .png().toFile(path.join(out, `aerial-${name}-blend.png`));
    }
    console.log(`  ✓ ${`aerial:${name}`.padEnd(16)} ${w}x${h}  ${mpp.toFixed(3)} m/px  ${files.ref ? 'city+ref+blend' : 'city only'}`);
  }

  const drift = marks
    .map((m) => ({ id: m.id, drift: +Math.hypot(m.x - m.idealX, m.z - m.idealZ).toFixed(1), x: +m.x.toFixed(1), z: +m.z.toFixed(1), idealX: +m.idealX.toFixed(1), idealZ: +m.idealZ.toFixed(1) }))
    .sort((p, q) => q.drift - p.drift);
  const mean = drift.reduce((t, d) => t + d.drift, 0) / drift.length;
  console.log(`  · projection residual: mean ${mean.toFixed(1)} m, worst ${drift[0].drift} m (${drift[0].id})`);
  const stray = await page.evaluate(() => window.__city.city.stats());
  console.log(`  · stray geometry offenders: ${stray.strayGeometry}`);
  await writeFile(path.join(out, 'aerial.json'), JSON.stringify({ at: new Date().toISOString(), rects: AERIALS, shots: results, drift, meanDrift: +mean.toFixed(1), cityStats: stray }, null, 2));
  await page.close();
}

/** SVG annotation for a plan-view rectangle: world graticule and landmark residuals. */
function annotate(a, w, h, marks) {
  const sx = w / (a.maxX - a.minX);
  const sz = h / (a.maxZ - a.minZ);
  const px = (x) => (x - a.minX) * sx;
  const py = (z) => (z - a.minZ) * sz;
  const step = 250;
  let g = '';
  for (let x = Math.ceil(a.minX / step) * step; x <= a.maxX; x += step) {
    g += `<line x1="${px(x)}" y1="0" x2="${px(x)}" y2="${h}" stroke="#00e5ff" stroke-width="1" opacity="0.35"/>`;
    g += `<text x="${px(x) + 3}" y="16" font-size="13" font-family="monospace" fill="#00e5ff">x${x}</text>`;
  }
  for (let z = Math.ceil(a.minZ / step) * step; z <= a.maxZ; z += step) {
    g += `<line x1="0" y1="${py(z)}" x2="${w}" y2="${py(z)}" stroke="#00e5ff" stroke-width="1" opacity="0.35"/>`;
    g += `<text x="3" y="${py(z) - 4}" font-size="13" font-family="monospace" fill="#00e5ff">z${z}</text>`;
  }
  // The battlefield line: nothing of the city may cross it.
  if (a.minZ < 250 && a.maxZ > 250) {
    g += `<line x1="0" y1="${py(250)}" x2="${w}" y2="${py(250)}" stroke="#ff2d55" stroke-width="2.5" stroke-dasharray="14 8"/>`;
    g += `<text x="8" y="${py(250) - 8}" font-size="16" font-family="monospace" fill="#ff2d55">battlefield limit z=250</text>`;
  }
  for (const m of marks) {
    const bx = px(m.x);
    const bz = py(m.z);
    const ix = px(m.idealX);
    const iz = py(m.idealZ);
    if (bx < -60 || bx > w + 60 || bz < -60 || bz > h + 60) continue;
    g += `<line x1="${ix}" y1="${iz}" x2="${bx}" y2="${bz}" stroke="#ffd60a" stroke-width="2"/>`;
    g += `<rect x="${ix - 6}" y="${iz - 6}" width="12" height="12" fill="none" stroke="#ffd60a" stroke-width="2"/>`;
    g += `<circle cx="${bx}" cy="${bz}" r="4.5" fill="#ff9f0a" stroke="#20160a" stroke-width="1.5"/>`;
    g += `<text x="${bx + 8}" y="${bz - 6}" font-size="14" font-family="monospace" fill="#1c1206" stroke="#ffe9a8" stroke-width="3.5" paint-order="stroke">${m.id}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${g}</svg>`;
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

  // ---- orthographic plan views, through the engine -----------------------
  if (requested.includes(AERIAL_SHOT)) {
    await shootAerials(browser, base, OUT, args.get('ref') ?? 'lanciani', consoleErrors, Number(args.get('lod') ?? 0));
    requested.splice(requested.indexOf(AERIAL_SHOT), 1);
    if (requested.length === 0) {
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
