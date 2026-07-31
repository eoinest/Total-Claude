#!/usr/bin/env node
/**
 * Controlled A/B frame timing, in one session.
 *
 * Absolute frame time is not measurable on this machine while other agents are working:
 * two workstreams measured the `clash` camera at 21.78 ms and 9.14 ms on identical code in
 * consecutive runs, a 2.4x spread. So this never reports a lone number. It parks one camera
 * at one sim time, then alternates configurations A/B/A/B inside a single browser session
 * and reports each configuration's median together with its pair, so contention that drifts
 * over the run hits both sides equally.
 *
 *   node tools/probe-perf-ab.mjs --port=5394 --shots=clash,romanline
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const SHOTS = {
  clash: { x: 15, z: -17, zoom: 0.3, yaw: Math.PI * 1.15, at: 72 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42, at: 2 },
  midcrowd: { x: -20, z: 128, zoom: 0.46, yaw: Math.PI * 1.42, at: 2 },
  wall: { x: -81, z: 503, zoom: 0.62, yaw: Math.PI * 0.06, at: 3 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2 },
};

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5394);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
/** Frames per measurement block. Two blocks per configuration, interleaved. */
const FRAMES = Number(args.get('frames') ?? 90);
const BLOCKS = Number(args.get('blocks') ?? 3);
const requested = args.get('shots') ? String(args.get('shots')).split(',') : ['romanline', 'clash'];

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('  ! page error:', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 180000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Time `n` real frames. `advance` runs `frame()` synchronously in a tight loop, so wall
 * clock across the loop divided by the count is the frame cost including the GPU work the
 * driver has to flush — the same figure `shoot.mjs` prints.
 */
const timeBlock = (n) => page.evaluate(async (frames) => {
  const g = window.__game;
  // A `readPixels` on the default framebuffer forces the queue to drain, so the timing
  // cannot be a measurement of how fast JavaScript can enqueue commands.
  const gl = g.engine.context.renderer.getContext();
  const px = new Uint8Array(4);
  g.engine.advance(0.2);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) g.engine.advance(1 / 60);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return (performance.now() - t0) / frames;
}, n);

const CONFIGS = [
  ['contact ON ', () => { window.__game.engine.context.tryGet('postfx').contactShadows = true; }],
  ['contact OFF', () => { window.__game.engine.context.tryGet('postfx').contactShadows = false; }],
];

let simTime = 0;
for (const name of requested) {
  const s = SHOTS[name];
  if (!s) { console.error(`unknown shot ${name}`); continue; }
  const need = s.at - simTime;
  if (need > 0.05) {
    await page.evaluate(async (dt) => { window.__game.advance(dt); }, need);
    simTime = s.at;
  }
  await page.evaluate((c) => { window.__game.setCamera(c.x, c.z, c.zoom, c.yaw); }, s);

  const samples = CONFIGS.map(() => []);
  // Interleaved so drift in machine load lands on both configurations, not one.
  for (let b = 0; b < BLOCKS; b++) {
    for (const [i, [, apply]] of CONFIGS.entries()) {
      await page.evaluate(apply);
      samples[i].push(await timeBlock(FRAMES));
    }
  }
  const info = await page.evaluate(() => {
    const r = window.__game.engine.context.renderer;
    return { draws: r.info.render.calls, tris: r.info.render.triangles };
  });
  const meds = samples.map(median);
  console.log(`\n=== ${name} (t+${s.at}s, ${W}x${H}, ultra, ${info.draws} draws, ${(info.tris / 1e6).toFixed(2)}M tris) ===`);
  for (const [i, [label]] of CONFIGS.entries()) {
    console.log(`  ${label}  median ${meds[i].toFixed(2)} ms   blocks [${samples[i].map((v) => v.toFixed(2)).join(', ')}]`);
  }
  const delta = meds[0] - meds[1];
  console.log(`  pair: ${meds[0].toFixed(2)} ms with, ${meds[1].toFixed(2)} ms without`
    + `  ->  ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms (${((delta / meds[1]) * 100).toFixed(1)}%)`);
  // Restore, so the next camera is measured from the shipping configuration.
  await page.evaluate(CONFIGS[0][1]);
}

await browser.close();
if (server) server.kill('SIGTERM');
