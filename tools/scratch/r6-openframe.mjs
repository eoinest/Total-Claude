#!/usr/bin/env node
/**
 * The opening frame of the deployment phase, as a player sees it — one arm of a pair.
 *
 * `tools/probe-openshot.mjs` is the measuring instrument for this frame and it is the one
 * that found the fault (`443b292`). It cannot shoot the *before* arm, because its `MEASURE`
 * step runs before its screenshot and reads APIs the r5 tree does not have, so a run against
 * `850843a` dies before it takes a picture. This is the same page, the same URL and the same
 * settle, with nothing in it that can fail on an old tree — so both arms of the r6 changelog
 * pair are produced by one script rather than by two different ones.
 *
 * No camera is placed here, deliberately. The whole claim is about where the *scenario*
 * points the camera when a siege opens, so a hand-placed or table-placed camera would
 * photograph something other than the thing under test.
 *
 * Two things are hidden and both are hidden in both arms:
 *   - `.hud-perf`, the frame-time readout. It is a developer overlay, not the interface.
 *   - `.title-card`, which fades over the first seconds and sits exactly where the wall is.
 *     Left in, the two arms would differ by how long each page happened to take to boot.
 *
 * Usage:
 *   node tools/scratch/r6-openframe.mjs --port=5393 --out=/tmp/x --tag=after
 *                                       [--maps=carthage,campus-martius] [--settle=9000]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5393);
const MAPS = (args.get('maps') ?? 'carthage,campus-martius').split(',');
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/r6-openframe');
const TAG = args.get('tag') ?? 'shot';
const SETTLE = Number(args.get('settle') ?? 9000);
const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}  root ${ROOT}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(OUT, { recursive: true });

/**
 * Where the nearest bays' crests land, in screen pixels, off the render matrix.
 *
 * Guarded end to end: on the r5 tree `getGarrisonBays` exists but `crestY` and the bay
 * record's shape are not guaranteed, and an instrument that throws here would take the
 * screenshot with it. A null reading is reported as null.
 */
const CREST = ([w, h]) => {
  try {
    const g = window.__game;
    const cam = g.engine.rig.camera;
    cam.updateMatrixWorld(true);
    const city = g.engine.context.tryGet('city');
    const bays = city?.getGarrisonBays?.();
    if (!bays || !bays.length) return null;
    const V = g.engine.rig.camera.position.constructor;
    const project = (x, y, z) => {
      const p = new V(x, y, z).project(cam);
      return { x: +(((p.x + 1) / 2) * w).toFixed(1), y: +(((1 - p.y) / 2) * h).toFixed(1), z: +p.z.toFixed(3) };
    };
    const gi = bays.findIndex((b) => b.isGate);
    const rows = [];
    for (let k = -4; k <= 4; k++) {
      const b = bays[(gi < 0 ? bays.length >> 1 : gi) + k];
      if (!b) continue;
      const mx = (b.x0 + b.x1) * 0.5;
      const mz = (b.z0 + b.z1) * 0.5;
      rows.push({ k, index: b.index, isGate: !!b.isGate, crest: project(mx, b.crestY, mz) });
    }
    const on = rows.filter((r) => r.crest.z < 1 && r.crest.x > 0 && r.crest.x < w && r.crest.y > 0 && r.crest.y < h);
    return {
      gateCrest: rows.find((r) => r.isGate)?.crest ?? null,
      nearestCrestY: rows.length ? Math.min(...rows.map((r) => r.crest.y)) : null,
      baysOnScreen: on.length,
      rows,
    };
  } catch (e) { return { error: String(e && e.message) }; }
};

const out = {};
for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&deploy=1&autoplay=0&quality=high`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 420000 });
  await page.addStyleTag({ content: '.hud-perf, .title-card { display: none !important; }' });
  await page.waitForTimeout(SETTLE);
  const m = await page.evaluate(CREST, [W, H]);
  const file = path.join(OUT, `${TAG}-${map}.png`);
  await page.screenshot({ path: file });
  out[map] = { crest: m, errors: errs.slice(0, 4) };
  console.log(`${map}: gate crest ${JSON.stringify(m?.gateCrest)}  nearest crest y ${m?.nearestCrestY}`
    + `  bays on screen ${m?.baysOnScreen}  -> ${file}`);
  if (errs.length) console.log(`  errors: ${errs.slice(0, 2).join(' | ')}`);
  await page.close();
}

await writeFile(path.join(OUT, `${TAG}.json`), JSON.stringify(out, null, 2));
await browser.close();
if (server) server.kill();
