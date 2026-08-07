#!/usr/bin/env node
/**
 * What multisampling actually costs, interleaved in one session.
 *
 * MSAA landed on the scene target claiming +1.1 ms from a single quiet round, with the
 * author's other rounds spanning -3.6 to +11.4 ms. That spread is machine load, not the
 * change, and the only way through it is to rotate the arms inside one browser session so
 * contention taxes every arm equally, then report every block rather than a median alone.
 *
 * Three things make the number real:
 *  - `PostFX.setSamplesOverride` reallocates the scene target live, so no page reload
 *    separates the arms.
 *  - A 1x1 `readPixels` either side of each block forces a GPU round trip. `gl.finish()`
 *    does not: under ANGLE-on-Metal it returns before the queue drains and once reported
 *    0.25 ms/frame for a 1.3 M-triangle scene.
 *  - The clock is pinned to a real 1/60 s frame. Driven the way `shoot.mjs` drives it, the
 *    frame delta is a fixed point that pins at the 0.25 s clamp and fires five sim ticks per
 *    rendered frame, which measures the simulation and calls it render cost.
 *
 *   node tools/probe-msaa.mjs --port=5477 --arms=0,2,4 --cams=melee,assault --blocks=4
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const TIER = args.get('tier') ?? 'ultra';
const SCENARIO = args.get('scenario') ?? 'assault';
const AT = Number(args.get('at') ?? 70);
const FRAMES = Number(args.get('frames') ?? 40);
const BLOCKS = Number(args.get('blocks') ?? 4);
/** `--arms` is a sample-count list; `null` means "whatever the tier asks for". */
const ARMS = String(args.get('arms') ?? '0,2,4').split(',').map((s) => (s === 'tier' ? null : Number(s)));

const CAMS = {
  assault: null,
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4 },
  city: { x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
};
const cams = args.get('cams') ? String(args.get('cams')).split(',') : ['melee', 'assault'];

const base = `http://127.0.0.1:${PORT}`;
const ping = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!ping?.ok) throw new Error(`no dev server on ${base} — start your own`);
console.log(`source: ${base} (my server; confirmed 200)`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
await page.goto(`${base}/?harness=1&quality=${TIER}&w=${W}&h=${H}&scenario=${SCENARIO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
if (AT > 0) await page.evaluate((t) => window.__game.advance(t), AT);

const caps = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  return {
    maxSamples: ctx.renderer.capabilities.maxSamples,
    tier: ctx.quality.tier,
    live: ctx.tryGet('postfx')?.msaaSamples,
  };
});
console.log(`driver maxSamples ${caps.maxSamples}, tier ${caps.tier}, scene target currently ${caps.live}x`);

const setArm = (n) => page.evaluate((s) => {
  const p = window.__game.engine.context.tryGet('postfx');
  p.setSamplesOverride(s);
  return p.msaaSamples;
}, n);

/**
 * Time `n` frames at a true 1/60 s clock with a GPU round trip on both sides. Two warm
 * frames first, because a reallocated target and a recompiled program must not be timed.
 */
const timeBlock = (n) => page.evaluate(async (frames) => {
  const g = window.__game;
  const time = g.engine.time;
  const gl = g.engine.renderer.getContext();
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const wasPaused = time.paused;
  time.paused = false;
  time.lastNow = time.elapsed;
  const step = () => g.engine.frame((time.elapsed + 1 / 60) * 1000);
  step(); step(); step();
  sync();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) step();
  sync();
  const ms = (performance.now() - t0) / frames;
  time.paused = wasPaused;
  return { ms, frameDt: time.frameDt, ticks: time.ticksThisFrame, draws: g.engine.renderer.info.render.calls };
}, n);

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
/**
 * Best of N, and the headline estimator here rather than the median.
 *
 * Contention is one-sided: another process can only ever *add* time to a block, never
 * remove it. So under load the median drifts with whatever else the machine is doing while
 * the minimum converges on the uncontended cost from above. The median is still printed,
 * because if the two disagree by much the run was too noisy to quote at all.
 */
const best = (a) => Math.min(...a);

console.log(`# ${W}x${H} ${TIER}, ${SCENARIO} t+${AT}s, ${FRAMES} frames x ${BLOCKS} blocks,`
  + ` arms ${ARMS.map((a) => (a === null ? 'tier' : `${a}x`)).join(' ')}`);

for (const name of cams) {
  const c = CAMS[name];
  if (c) await page.evaluate((s) => window.__game.setCamera(s.x, s.z, s.zoom, s.yaw), c);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__game.engine.advance(1 / 60); });

  const samples = ARMS.map(() => []);
  let resolved = ARMS.map(() => 0);
  for (let b = 0; b < BLOCKS; b++) {
    // Reverse on alternate blocks: the frame is reliably faster late in a run (driver
    // warm-up, not code), so a fixed arm order taxes whichever arm always goes first.
    const order = b % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
    for (const i of order) {
      resolved[i] = await setArm(ARMS[i]);
      samples[i].push(await timeBlock(FRAMES));
    }
  }
  await setArm(null);

  const meds = samples.map((a) => median(a.map((r) => r.ms)));
  const mins = samples.map((a) => best(a.map((r) => r.ms)));
  const b0 = samples[0][0];
  console.log(`\n=== ${name}  (${b0.draws} draws, frameDt ${b0.frameDt.toFixed(4)}s, ${b0.ticks} sim ticks/frame) ===`);
  for (const [i, a] of ARMS.entries()) {
    const d = mins[i] - mins[0];
    const dm = meds[i] - meds[0];
    const lbl = a === null ? 'tier default' : `${a}x MSAA`;
    console.log(`  ${lbl.padEnd(14)} resolved ${resolved[i]}x  best ${mins[i].toFixed(2)} median ${meds[i].toFixed(2)} ms`
      + `  blocks [${samples[i].map((r) => r.ms.toFixed(2)).join(', ')}]`
      + (i === 0 ? '  (reference)' : `   ${d >= 0 ? '+' : ''}${d.toFixed(2)} ms on best, ${dm >= 0 ? '+' : ''}${dm.toFixed(2)} on median`));
  }
  const spread = Math.max(...meds.map((m, i) => Math.abs((m - meds[0]) - (mins[i] - mins[0]))));
  if (spread > 0.8) console.log(`  !! best and median disagree by up to ${spread.toFixed(2)} ms — too noisy to quote`);
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
}
await browser.close();
