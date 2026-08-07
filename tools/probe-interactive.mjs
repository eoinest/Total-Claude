#!/usr/bin/env node
/**
 * The frame as a player actually gets it: real `requestAnimationFrame`, real input.
 *
 * Every frame-time figure this project has on record came from a driver calling
 * `engine.frame()` in a tight loop. That measures render plus simulation and nothing else —
 * no browser compositing, no event dispatch, no input handling, no HUD layout, and no
 * rAF pacing. It has flattered the project before, so this closes the loop: it loads the
 * page, lets `engine.start()` drive itself, and drives the camera and the orders through
 * synthesised pointer and keyboard events on the canvas.
 *
 * The clock is `requestAnimationFrame`'s own timestamp, sampled inside the page. That
 * includes everything between one presented frame and the next, which is the number a
 * player feels. It is bounded below by the display's refresh interval, so a frame cheaper
 * than 16.7 ms reads as 16.7 ms and the useful signal is the *tail*: how often, and by how
 * much, the frame misses.
 *
 * `engine.frame` is also timed from the inside, so the two can be compared: rAF delta is
 * what the player waits, `frame()` is what this codebase controls.
 *
 *   node tools/probe-interactive.mjs --port=5477 --scenario=assault --seconds=25
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
const TIER = args.get('quality') ?? 'ultra';
const SCENARIO = args.get('scenario') ?? 'assault';
const SECONDS = Number(args.get('seconds') ?? 25);
const AT = Number(args.get('at') ?? 60);
const SHOTS = args.get('shots') ?? null;

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

// `autoplay=0` keeps Rome under player control, so the orders below actually do something.
// The HUD stays up: it is part of the frame a player pays for.
await page.goto(`${base}/?harness=1&autoplay=0&quality=${TIER}&w=${W}&h=${H}&scenario=${SCENARIO}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
if (AT > 0) await page.evaluate((t) => window.__game.advance(t), AT);

/** Sample rAF deltas and the engine's own frame cost from inside the page. */
await page.evaluate(() => {
  const g = window.__game;
  window.__probe = { raf: [], frame: [], draws: [], tris: [], marks: [] };
  let last = 0;
  const tick = (t) => {
    if (last) window.__probe.raf.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Wrap the engine's own frame so the two clocks can be compared on the same frames.
  const orig = g.engine.frame.bind(g.engine);
  g.engine.frame = (nowMs) => {
    const t0 = performance.now();
    orig(nowMs);
    const p = window.__probe;
    p.frame.push(performance.now() - t0);
    p.draws.push(g.engine.renderer.info.render.calls);
    p.tris.push(g.engine.renderer.info.render.triangles);
  };
  window.__mark = (s) => window.__probe.marks.push([performance.now(), s]);
});

const canvas = await page.$('#viewport') ?? await page.$('canvas');
if (!canvas) throw new Error('no canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

const mark = (s) => page.evaluate((m) => window.__mark(m), s);
const wait = (ms) => page.waitForTimeout(ms);

/**
 * A session, not a shot list: pan, rotate, zoom, drag-select a body of men, order them
 * somewhere, change formation, and do it again while the battle runs.
 */
console.log(`# ${W}x${H} ${TIER}, ${SCENARIO}, from t+${AT}s, ~${SECONDS}s of real interaction`);
const script = [
  ['idle', async () => { await wait(1500); }],
  ['pan-keys', async () => {
    for (const k of ['KeyW', 'KeyD', 'KeyS', 'KeyA']) {
      await page.keyboard.down(k); await wait(420); await page.keyboard.up(k);
    }
  }],
  ['rotate-drag', async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'middle' });
    for (let i = 0; i < 14; i++) { await page.mouse.move(cx + i * 22, cy + i * 3); await wait(40); }
    await page.mouse.up({ button: 'middle' });
  }],
  ['zoom-wheel', async () => {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -180); await wait(70); }
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await wait(70); }
  }],
  ['drag-select', async () => {
    await page.mouse.move(cx - 420, cy - 200);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) { await page.mouse.move(cx - 420 + i * 84, cy - 200 + i * 40); await wait(35); }
    await page.mouse.up();
    await wait(400);
  }],
  ['order-move', async () => {
    await page.mouse.click(cx + 180, cy - 90, { button: 'right' });
    await wait(1200);
    await page.mouse.click(cx - 220, cy + 60, { button: 'right' });
    await wait(1200);
  }],
  ['order-run+formation', async () => {
    await page.keyboard.press('KeyR');
    await wait(500);
    await page.mouse.click(cx + 60, cy - 200, { button: 'right' });
    await wait(1500);
  }],
  ['pan-while-fighting', async () => {
    await page.keyboard.down('KeyA'); await wait(700); await page.keyboard.up('KeyA');
    await page.keyboard.down('KeyE'); await wait(600); await page.keyboard.up('KeyE');
    await wait(900);
  }],
];

const perPhase = [];
for (const [name, fn] of script) {
  await mark(`start:${name}`);
  const before = await page.evaluate(() => window.__probe.raf.length);
  await fn();
  const after = await page.evaluate(() => window.__probe.raf.length);
  perPhase.push({ name, from: before, to: after });
}
// Let the tail of the last order play out.
await wait(Math.max(0, SECONDS * 1000 - 14000));
const endIdx = await page.evaluate(() => window.__probe.raf.length);
perPhase.push({ name: 'settle', from: perPhase[perPhase.length - 1].to, to: endIdx });

const out = await page.evaluate(() => {
  const p = window.__probe;
  const g = window.__game;
  return {
    raf: p.raf, frame: p.frame, draws: p.draws, tris: p.tris,
    strength: g.engine.context.tryGet('battle')?.strength,
    simT: g.simTime(),
  };
});

const stat = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length };
};
const f2 = (v) => (v === undefined ? '   -  ' : v.toFixed(2).padStart(6));

console.log(`\nsim reached t+${out.simT.toFixed(0)}s, strength ${JSON.stringify(out.strength)}`);
console.log(`\nphase                 frames   rAF p50   p90    p99    max |  frame() p50   p90    max | draws p50  max`);
for (const ph of perPhase) {
  const r = stat(out.raf.slice(ph.from, ph.to));
  // `frame()` and rAF are sampled by different counters; slice the engine series by the same
  // fraction of its own length so the phases line up.
  const scale = out.frame.length / Math.max(1, out.raf.length);
  const e = stat(out.frame.slice(Math.floor(ph.from * scale), Math.floor(ph.to * scale)));
  const d = stat(out.draws.slice(Math.floor(ph.from * scale), Math.floor(ph.to * scale)));
  if (!r || !e) continue;
  console.log(`  ${ph.name.padEnd(20)} ${String(r.n).padStart(5)}  ${f2(r.p50)} ${f2(r.p90)} ${f2(r.p99)} ${f2(r.max)} | `
    + `${f2(e.p50)} ${f2(e.p90)} ${f2(e.max)} | ${String(Math.round(d.p50)).padStart(5)} ${String(Math.round(d.max)).padStart(5)}`);
}
const all = stat(out.raf);
const allE = stat(out.frame);
const over = out.raf.filter((v) => v > 20).length;
console.log(`  ${'WHOLE SESSION'.padEnd(20)} ${String(all.n).padStart(5)}  ${f2(all.p50)} ${f2(all.p90)} ${f2(all.p99)} ${f2(all.max)} | `
  + `${f2(allE.p50)} ${f2(allE.p90)} ${f2(allE.max)} |`);
console.log(`\n  rAF frames over 20 ms: ${over} of ${all.n} (${(100 * over / all.n).toFixed(1)}%)`);
console.log(`  engine.frame() mean ${allE.mean.toFixed(2)} ms — this is the part the codebase controls;`
  + ` the rAF figure includes compositing, input and HUD layout.`);

if (SHOTS) {
  await page.screenshot({ path: SHOTS });
  console.log(`  end-of-session frame -> ${SHOTS}`);
}
if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
} else {
  console.log(`  no page errors and no console errors across the session.`);
}
await browser.close();
