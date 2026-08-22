#!/usr/bin/env node
/**
 * What the shadow pass actually costs, and what each cascade is worth in the picture.
 *
 * 81 of 204 draws being shadow is a submission statistic; it says nothing about time. This
 * puts a ceiling on every possible shadow optimisation by measuring the frame with the
 * cascade re-draws switched off, and then prices each cascade individually.
 *
 * The switch is three's own early-out at `WebGLShadowMap.js:170` —
 * `shadow.autoUpdate === false && shadow.needsUpdate === false` -> `continue`. That skips a
 * light's shadow *render* while every material still samples its map, so it separates the
 * cost of drawing the cascades from the cost of filtering them, and it touches no material
 * define, so there is no recompile and `NUM_DIR_LIGHT_SHADOWS` never moves. The map keeps
 * its last contents, which is why the picture for these arms is only meaningful as
 * "which pixels does this cascade own" — not as a shippable image.
 *
 * Arms are interleaved in one page load and the base arm is re-shot last, per
 * `docs/RELEASING.md` §4a. Frozen sim: the same frame timestamp is re-issued, so `frameDt`
 * is 0 and no emitter advances between arms.
 *
 *   node tools/scratch/gpucost-shadow.mjs --port=5921 --scene=rome
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { spawnVite } from '../lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5921);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const QUALITY = args.get('quality') ?? 'ultra';
const FRAMES = Number(args.get('frames') ?? 40);
const BLOCKS = Number(args.get('blocks') ?? 4);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/gpucost-shadow');
const REPORT = path.resolve(ROOT, args.get('report') ?? 'screenshots/gpucost-base/report.json');
const SCENE_ID = args.get('scene') ?? 'rome';

const SCENES = {
  rome: { shot: 'ab-rome-wall', cfg: { scenario: 'assault', timeOfDay: 14.3 }, zoom: 0.46 },
  carthage: {
    shot: 'ab-carth-wall',
    cfg: { map: 'carthage', opponent: 2, scenario: 'assault', timeOfDay: 15.2 }, zoom: 0.46,
  },
};

/** `mask` is which cascade indices re-render this frame. */
const ARMS = [
  ['base', 'all'],
  ['no-c3', '0,1,2'],
  ['no-c23', '0,1'],
  ['c0-only', '0'],
  ['none', ''],
];

const tree = (() => {
  const g = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return '?'; } };
  return { head: g(['rev-parse', '--short', 'HEAD']), branch: g(['rev-parse', '--abbrev-ref', 'HEAD']) };
})();
const loadAvg = () => {
  try { const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/); return m ? Number(m[1]) : null; } catch { return null; }
};
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

await mkdir(OUT, { recursive: true });
const rep = JSON.parse(await readFile(REPORT, 'utf8'));
const rec = new Map((rep.shots ?? []).map((s) => [s.name, s])).get(SCENES[SCENE_ID].shot);
if (!rec) throw new Error('no report entry');
const scene = SCENES[SCENE_ID];

const base = `http://127.0.0.1:${PORT}`;
const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok || r.status === 304) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
}
const battleToken = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

console.log(`# ${tree.branch}@${tree.head} ${W}x${H} ${QUALITY} scene=${SCENE_ID} camera=${scene.shot} load ${loadAvg()}`);
await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&battle=${battleToken(scene.cfg)}`,
  { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context ?? g.engine.ctx;
  const renderer = ctx.renderer;
  const info = renderer.info;
  /*
   * Stop the engine's own rAF loop.
   *
   * Without this the game keeps rendering in real time between `page.evaluate` and
   * `page.screenshot`, so the "frozen" frame is whatever the loop last drew and two shots of
   * the same arm differ on most of the screen. That is not the VFX-reseed problem
   * `RELEASING.md` §4a describes — it is a second, simpler one on top of it, and it makes the
   * drift check fail for a reason that has nothing to do with the arms.
   */
  g.engine.stop();
  const acc = { shadow: 0, scene: 0, quad: 0 };
  const sm = renderer.shadowMap;
  const os = sm.render.bind(sm);
  sm.render = (...z) => { const b = info.render.calls; os(...z); acc.shadow += info.render.calls - b; };
  /*
   * `FullScreenQuad.render` goes through `renderer.render` too, so a single wrapper cannot
   * tell the colour pass from a post blit — which is why the first cut of this probe reported
   * post = 0 and a colour pass 25 calls too large. The scene render is the one whose first
   * argument is the world scene; everything else is a fullscreen quad.
   */
  const orr = renderer.render.bind(renderer);
  renderer.render = (...z) => {
    const b = info.render.calls;
    orr(...z);
    const d = info.render.calls - b;
    if (z[0] === ctx.scene) acc.scene += d; else acc.quad += d;
  };
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const csm = ctx.tryGet('lighting').csm;
  window.tc = {
    acc, csm,
    sync: () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px),
    freeze: () => { window.__f = g.engine.time.elapsed * 1000; },
    still: (n) => { for (let i = 0; i < n; i++) g.engine.frame(window.__f); },
    live: (n) => { for (let i = 0; i < n; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7); },
    /** Which cascades re-render. 'all' restores three's default. */
    mask: (spec) => {
      const on = spec === 'all' ? null : new Set(String(spec).split(',').filter((s) => s !== '').map(Number));
      csm.lights.forEach((l, i) => {
        const want = on === null ? true : on.has(i);
        l.shadow.autoUpdate = want;
        l.shadow.needsUpdate = want;
      });
    },
    split: () => {
      acc.shadow = 0; acc.scene = 0; acc.quad = 0;
      g.engine.frame(window.__f);
      window.tc.sync();
      const total = info.render.calls;
      return {
        total, tris: info.render.triangles,
        shadow: acc.shadow, colour: acc.scene - acc.shadow, post: acc.quad,
        unattributed: total - acc.scene - acc.quad,
      };
    },
  };
});

await page.evaluate(async (c) => {
  const g = window.__game;
  g.advance(c.at);
  g.setCamera(c.x, c.z, c.zoom, c.yaw);
  for (let i = 0; i < 90; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  window.tc.freeze();
  window.tc.still(4);
}, { at: rec.simTime, x: rec.focusX, z: rec.focusZ, zoom: scene.zoom, yaw: rec.yaw });

const meta = await page.evaluate(() => {
  const csm = window.tc.csm;
  let men = 0, units = 0;
  for (const u of window.__game.battle.units) if (!u.destroyed) { units++; men += u.alive; }
  return {
    men, units, mapSize: csm.shadowMapSize, n: csm.lights.length,
    extents: csm.lights.map((l) => +(l.shadow.camera.right - l.shadow.camera.left).toFixed(1)),
    texel: csm.lights.map((l) => +((l.shadow.camera.right - l.shadow.camera.left) / csm.shadowMapSize).toFixed(3)),
  };
});
console.log(`# ${meta.men} men / ${meta.units} units; ${meta.n} cascades @${meta.mapSize}`);
console.log(`#   cascade extents m: ${meta.extents.join(' / ')}`);
console.log(`#   metres per texel : ${meta.texel.join(' / ')}`);

// ---- picture + split, base first and base last ---------------------------
const order = [['base-1', 'all'], ...ARMS.slice(1), ['base-2', 'all']];
const shots = [];
for (const [name, mask] of order) {
  const split = await page.evaluate(({ mask }) => {
    window.tc.mask(mask);
    window.tc.still(3);
    return window.tc.split();
  }, { mask });
  const file = path.join(OUT, `${SCENE_ID}-${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  shots.push({ name, file, split });
  console.log(`  ${name.padEnd(8)} draws ${String(split.total).padStart(4)} = shadow ${String(split.shadow).padStart(3)}`
    + ` + colour ${String(split.colour).padStart(3)} + post ${String(split.post).padStart(3)}`
    + `${split.unattributed ? ' + ?' + split.unattributed : ''}  tris ${(split.tris / 1e6).toFixed(2)}M`);
}

// ---- frame time ----------------------------------------------------------
const times = new Map(ARMS.map(([n]) => [n, []]));
for (let b = 0; b < BLOCKS; b++) {
  const idx = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
  for (const i of idx) {
    const [name, mask] = ARMS[i];
    const ms = await page.evaluate(({ mask, frames }) => {
      window.tc.mask(mask);
      const g = window.__game;
      window.tc.still(2);
      window.tc.sync();
      const t0 = performance.now();
      // `needsUpdate` is consumed by each shadow render, so it must be re-armed every frame
      // for an arm that is meant to keep re-rendering a subset.
      for (let k = 0; k < frames; k++) { window.tc.mask(mask); g.engine.frame(window.__f); }
      window.tc.sync();
      return (performance.now() - t0) / frames;
    }, { mask, frames: FRAMES });
    times.get(name).push(ms);
  }
}

async function raw(f) { const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true }); return { data, info }; }
async function diff(a, b) {
  const A = await raw(a); const B = await raw(b);
  let n = 0, sum = 0, max = 0;
  const ch = A.info.channels;
  for (let i = 0; i < A.data.length; i += ch) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
    if (d > 0) { n++; sum += d; if (d > max) max = d; }
  }
  return { changedFrac: +(n / (A.data.length / ch)).toFixed(4), meanOverChanged: +(n ? sum / n : 0).toFixed(2), max };
}

const b1 = shots.find((s) => s.name === 'base-1');
const b2 = shots.find((s) => s.name === 'base-2');
console.log(`\n  DRIFT base-1 vs base-2: ${JSON.stringify(await diff(b1.file, b2.file))}`);
console.log(`\n  ${'arm'.padEnd(9)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'best'.padStart(7)}  ${'d(p50)'.padStart(7)}  ${'d(best)'.padStart(7)}   picture vs base`);
const bp = times.get('base');
for (const [name] of ARMS) {
  const t = times.get(name);
  const s = shots.find((x) => x.name === name) ?? b1;
  const d = name === 'base' ? { changedFrac: 0, meanOverChanged: 0, max: 0 } : await diff(b1.file, s.file);
  console.log(`  ${name.padEnd(9)} ${q(t, 0.5).toFixed(2).padStart(7)} ${q(t, 0.9).toFixed(2).padStart(7)} ${Math.min(...t).toFixed(2).padStart(7)}`
    + `  ${(q(t, 0.5) - q(bp, 0.5)).toFixed(2).padStart(7)}  ${(Math.min(...t) - Math.min(...bp)).toFixed(2).padStart(7)}   ${JSON.stringify(d)}`);
}

if (pageErrors.length) { console.error(`\npageerror x${pageErrors.length}`); for (const e of [...new Set(pageErrors)].slice(0, 8)) console.error('  ' + e); }
else console.log('\nno pageerror.');
console.log(`# load at end ${loadAvg()}`);
await browser.close();
if (server) server.kill('SIGTERM');
