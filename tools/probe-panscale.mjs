#!/usr/bin/env node
/**
 * Probe: does a middle-button drag pan by cursor travel, or by elapsed time?
 *
 * The defect this measures is *variance*, so a single before/after number proves nothing.
 * The same 300 px gesture is driven many times at deliberately different frame rates and
 * the spread is reported. Frame time is controlled honestly: the rAF loop is stopped and
 * `engine.frame(t)` is fed explicit timestamps, so the "frame rate" is an input rather than
 * whatever the machine happened to give us. A second grid re-runs the gesture on the live
 * rAF loop under CDP CPU throttling, which changes the frame rate without touching a clock.
 *
 * Every gesture is a real Playwright pointer event at real screen coordinates. Nothing
 * calls a camera method.
 *
 * Two metrics per trial:
 *   dist  — metres the focus moved. Across a frame-rate sweep this should be *constant*.
 *   slip  — pixels between the cursor and the world point that was under it when the drag
 *           began, re-projected through the settled camera. This is the direct-manipulation
 *           criterion: 0 means the ground stayed under the cursor.
 *
 * Usage: node tools/probe-panscale.mjs [--port=5271] [--json=path] [--arm=before|after]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5271);
const JSON_OUT = args.get('json') ?? null;
const ARM = args.get('arm') ?? 'arm';
const W = 1600, H = 900;
const CX = 800, CY = 405;
const TRAVEL = 300;

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
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`${base}/?harness=1&autoplay=0&quality=high&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
console.log(`arm=${ARM}  ready`);

await page.evaluate(() => {
  const g = window.__game;
  // Borrowed rather than constructed: `import('three')` does not resolve inside evaluate.
  const v = g.engine.context.camera.position.clone();

  window.__project = (x, y, z) => {
    const cam = g.engine.context.camera;
    v.set(x, y, z).project(cam);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * g.engine.context.viewW, y: (-v.y * 0.5 + 0.5) * g.engine.context.viewH };
  };

  /** Where the ray through a screen pixel meets the horizontal plane through the focus. */
  window.__ground = (px, py) => {
    const cam = g.engine.context.camera;
    const vw = g.engine.context.viewW, vh = g.engine.context.viewH;
    v.set((px / vw) * 2 - 1, -(py / vh) * 2 + 1, 0.5).unproject(cam);
    const o = cam.position;
    const dy = v.y - o.y;
    if (dy > -1e-5) return null;
    const t = (g.engine.rig.focus.y - o.y) / dy;
    if (t < 0 || t > 1e5) return null;
    return { x: o.x + (v.x - o.x) * t, y: g.engine.rig.focus.y, z: o.z + (v.z - o.z) * t };
  };

  window.__pan = {
    t: 0,
    /** Take the clock off rAF so frame duration is an input, and freeze the sim. */
    begin() {
      g.engine.stop();
      g.engine.time.paused = true;
      this.t = 1e6;
      g.engine.time.rebase(this.t);
    },
    step(ms) { this.t += ms; g.engine.frame(this.t); },
    settle(n = 60) { for (let i = 0; i < n; i++) this.step(1000 / 60); },
    reset(zoom) {
      g.setCamera(0, 0, zoom, Math.PI);
      this.settle(30);
    },
    live() {
      g.engine.time.paused = true;
      g.engine.time.rebase();
      g.engine.start();
    },
    state() {
      const r = g.engine.rig;
      const cam = g.engine.context.camera;
      const dir = cam.getWorldDirection(cam.position.clone().set(0, 0, 0));
      return {
        x: +r.focus.x.toFixed(4), z: +r.focus.z.toFixed(4), y: +r.focus.y.toFixed(3),
        zoom: +r.zoom.toFixed(4), yaw: +r.yaw.toFixed(4),
        radius: +r.orbitRadius.toFixed(3), fov: +cam.fov.toFixed(3),
        sinPitch: +(-dir.y).toFixed(5),
        eyeY: +cam.position.y.toFixed(3),
      };
    },
  };
});

const state = () => page.evaluate(() => window.__pan.state());
const stepBy = (ms) => page.evaluate((d) => window.__pan.step(d), ms);

await page.evaluate(() => window.__pan.begin());

const rows = [];

/**
 * One scripted drag on a hand-driven clock.
 * `frames` frames of `dtMs` each, delivering `dx`,`dy` pixels of cursor travel in total.
 */
async function trial(tag, { dx = TRAVEL, dy = 0, frames, dtMs, zoom = 0.55, button = 'middle' }) {
  await page.evaluate((z) => window.__pan.reset(z), zoom);
  // Park the cursor and give it a frame with no button down, so the press frame's delta is
  // measured from here and not from wherever the cursor happened to be.
  await page.mouse.move(CX, CY);
  await stepBy(dtMs);
  const s0 = await state();
  const w0 = await page.evaluate((p) => window.__ground(p.x, p.y), { x: CX, y: CY });

  await page.mouse.down({ button });
  await stepBy(dtMs);
  for (let i = 1; i <= frames; i++) {
    await page.mouse.move(CX + (dx * i) / frames, CY + (dy * i) / frames);
    await stepBy(dtMs);
  }
  const mid = await state();
  const midSlip = w0 ? await page.evaluate((a) => {
    const p = window.__project(a.w.x, a.w.y, a.w.z);
    return p ? Math.hypot(p.x - a.c.x, p.y - a.c.y) : null;
  }, { w: w0, c: { x: CX + dx, y: CY + dy } }) : null;

  await page.mouse.up({ button });
  await page.evaluate(() => window.__pan.settle(90));
  const s1 = await state();
  const slip = w0 ? await page.evaluate((a) => {
    const p = window.__project(a.w.x, a.w.y, a.w.z);
    return p ? Math.hypot(p.x - a.c.x, p.y - a.c.y) : null;
  }, { w: w0, c: { x: CX + dx, y: CY + dy } }) : null;

  const dist = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  const row = {
    tag, frames, dtMs: +dtMs.toFixed(3), fps: +(1000 / dtMs).toFixed(1),
    dragMs: +(frames * dtMs).toFixed(1), px: Math.hypot(dx, dy), dx, dy, zoom,
    dist: +dist.toFixed(2),
    mPerPx: +(dist / Math.hypot(dx, dy)).toFixed(4),
    slip: slip === null ? null : +slip.toFixed(1),
    midSlip: midSlip === null ? null : +midSlip.toFixed(1),
    from: [s0.x, s0.z], to: [s1.x, s1.z],
    sinPitch: s0.sinPitch, radius: s0.radius, fov: s0.fov, eyeY: s0.eyeY,
    yaw0: s0.yaw, yaw1: s1.yaw, midX: mid.x, midZ: mid.z,
  };
  rows.push(row);
  console.log(`  ${tag.padEnd(22)} ${String(row.fps).padStart(6)} fps  ${String(frames).padStart(3)}f x ` +
    `${row.dtMs.toFixed(2)}ms  drag ${String(row.dragMs).padStart(6)}ms  ` +
    `dist ${row.dist.toFixed(2).padStart(8)} m  (${row.mPerPx.toFixed(4)} m/px)  ` +
    `slip ${slip === null ? ' n/a' : slip.toFixed(1).padStart(7)} px  mid ${midSlip === null ? 'n/a' : midSlip.toFixed(1).padStart(7)} px`);
  return row;
}

const stats = (v) => {
  const n = v.length;
  if (!n) return { n: 0, mean: 0, sd: 0, min: 0, max: 0, cv: 0, ratio: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean: +mean.toFixed(3), sd: +sd.toFixed(4), min: +Math.min(...v).toFixed(3),
    max: +Math.max(...v).toFixed(3), cv: +(sd / mean).toFixed(5), ratio: +(Math.max(...v) / Math.min(...v)).toFixed(3) };
};

// ---------------------------------------------------------------------------
// Grid A — identical gesture, identical frame count, different frame duration.
// The only thing that changes between these rows is how long a frame takes.
// ---------------------------------------------------------------------------
console.log('\nA. 300 px right, 12 frames, frame duration swept');
for (const fps of [144, 120, 90, 60, 45, 30, 20, 15]) {
  await trial(`A ${fps}fps`, { frames: 12, dtMs: 1000 / fps });
}

// ---------------------------------------------------------------------------
// Grid B — identical gesture over the same wall-clock duration, different frame
// rate. This is the shape of the real complaint: the hand takes 400 ms either way.
// ---------------------------------------------------------------------------
console.log('\nB. 300 px right in 400 ms, frame rate swept');
for (const fps of [120, 60, 40, 30, 20, 15]) {
  const frames = Math.round(0.4 * fps);
  await trial(`B ${fps}fps`, { frames, dtMs: 400 / frames });
}

// ---------------------------------------------------------------------------
// C — the vertical axis, and a diagonal. Same sweep, fewer rows.
// ---------------------------------------------------------------------------
console.log('\nC. 300 px down, frame duration swept');
for (const fps of [120, 60, 30, 15]) {
  await trial(`C down ${fps}fps`, { dx: 0, dy: TRAVEL, frames: 12, dtMs: 1000 / fps });
}
console.log('\nD. 212x212 px diagonal, frame duration swept');
for (const fps of [120, 60, 30, 15]) {
  await trial(`D diag ${fps}fps`, { dx: 212, dy: 212, frames: 12, dtMs: 1000 / fps });
}

// ---------------------------------------------------------------------------
// E — zoom sweep at one frame rate, to see the gain the drag actually applies.
// ---------------------------------------------------------------------------
console.log('\nE. 300 px right at 60 fps across the zoom range');
for (const z of [0.15, 0.3, 0.45, 0.62, 0.8, 1.0]) {
  await trial(`E zoom ${z}`, { frames: 12, dtMs: 1000 / 60, zoom: z });
}

// ---------------------------------------------------------------------------
// F — keyboard and edge pan must stay rate-based: the same *duration* of held
// input must travel the same distance whatever the frame rate.
// ---------------------------------------------------------------------------
console.log('\nF. keyboard W held for 500 ms, frame rate swept (must stay constant)');
const keyRows = [];
for (const fps of [120, 60, 30, 15]) {
  await page.evaluate(() => window.__pan.reset(0.55));
  await page.mouse.move(CX, CY);
  const s0 = await state();
  const frames = Math.round(0.5 * fps);
  const dt = 500 / frames;
  await page.keyboard.down('KeyW');
  for (let i = 0; i < frames; i++) await stepBy(dt);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => window.__pan.settle(90));
  const s1 = await state();
  const d = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  keyRows.push({ tag: `F key ${fps}fps`, fps, frames, dtMs: +dt.toFixed(3), dist: +d.toFixed(2) });
  console.log(`  F key ${String(fps).padStart(3)}fps  ${String(frames).padStart(3)}f x ${dt.toFixed(2)}ms  dist ${d.toFixed(2)} m`);
}

// A HUD panel under the cursor takes the canvas hover away, and then edge-pan is correctly
// silent — so the point has to clear every interactive rect or the arm measures nothing.
const edgePt = await page.evaluate(() => {
  const rects = Array.from(document.querySelectorAll('#hud-root .interactive'))
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  const clear = (p) => !rects.some((r) => p.x >= r.left - 6 && p.x <= r.right + 6 && p.y >= r.top - 6 && p.y <= r.bottom + 6);
  for (const f of [0.5, 0.4, 0.6, 0.32, 0.68]) {
    for (const x of [3, innerWidth - 4]) {
      const p = { x, y: Math.round(innerHeight * f) };
      if (clear(p) && document.elementFromPoint(p.x, p.y)?.id === 'viewport') return p;
    }
  }
  return null;
});
console.log(`\nG. cursor held at the screen edge ${edgePt ? `(${edgePt.x},${edgePt.y})` : '(none clear!)'} for 500 ms, frame rate swept`);
const edgeRows = [];
for (const fps of edgePt ? [120, 60, 30, 15] : []) {
  await page.evaluate(() => window.__pan.reset(0.55));
  await page.mouse.move(CX, CY);
  await stepBy(16.667);
  const s0 = await state();
  const frames = Math.round(0.5 * fps);
  const dt = 500 / frames;
  await page.mouse.move(edgePt.x, edgePt.y);
  for (let i = 0; i < frames; i++) await stepBy(dt);
  await page.mouse.move(CX, CY);
  await page.evaluate(() => window.__pan.settle(90));
  const s1 = await state();
  const d = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  edgeRows.push({ tag: `G edge ${fps}fps`, fps, frames, dtMs: +dt.toFixed(3), dist: +d.toFixed(2) });
  console.log(`  G edge ${String(fps).padStart(3)}fps  ${String(frames).padStart(3)}f x ${dt.toFixed(2)}ms  dist ${d.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// H — the live rAF loop under CPU throttling. No synthetic clock at all: the
// frame rate is changed by making the machine slower, which is what happens.
// ---------------------------------------------------------------------------
console.log('\nH. live rAF, 300 px right in 12 moves x 30 ms, CDP CPU throttling');
const liveRows = [];
const cdp = await page.context().newCDPSession(page);
await page.evaluate(() => window.__pan.live());
for (const rate of [1, 2, 4, 6]) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.evaluate(() => window.__game.setCamera(0, 0, 0.55, Math.PI));
  await page.waitForTimeout(700);
  const s0 = await state();
  const f0 = await page.evaluate(() => window.__game.engine.time.frameMs);
  await page.mouse.move(CX, CY);
  await page.waitForTimeout(150);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 12; i++) { await page.mouse.move(CX + i * 25, CY); await page.waitForTimeout(30); }
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(800);
  const s1 = await state();
  const f1 = await page.evaluate(() => window.__game.engine.time.frameMs);
  const d = Math.hypot(s1.x - s0.x, s1.z - s0.z);
  liveRows.push({ tag: `H throttle ${rate}x`, rate, frameMs: +((f0 + f1) / 2).toFixed(2), dist: +d.toFixed(2) });
  console.log(`  H throttle ${rate}x   frameMs ~${((f0 + f1) / 2).toFixed(1)}   dist ${d.toFixed(2)} m`);
}
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

// ---------------------------------------------------------------------------
// I — right-drag must still turn the view, and must not pan. `suppressDrag` is
// exercised by qa-interact; this only proves the rotate path is untouched.
// ---------------------------------------------------------------------------
await page.evaluate(() => { window.__game.engine.stop(); window.__pan.begin(); });
console.log('\nI. right drag 300 px (nothing selected) must turn, not pan');
const rd = await trial('I rmb 60fps', { frames: 12, dtMs: 1000 / 60, button: 'right' });
console.log(`     yaw ${rd.yaw0} -> ${rd.yaw1} (${(rd.yaw1 - rd.yaw0).toFixed(4)} rad), focus moved ${rd.dist.toFixed(2)} m`);

const group = (p) => stats(rows.filter((r) => r.tag.startsWith(p)).map((r) => r.dist));
const summary = {
  arm: ARM,
  A: group('A '), B: group('B '), AB: stats(rows.filter((r) => /^[AB] /.test(r.tag)).map((r) => r.dist)),
  Cdown: group('C '), Ddiag: group('D '),
  keyboard: stats(keyRows.map((r) => r.dist)),
  edge: stats(edgeRows.map((r) => r.dist)),
  live: stats(liveRows.map((r) => r.dist)),
  slipA: stats(rows.filter((r) => /^[AB] /.test(r.tag) && r.slip !== null).map((r) => r.slip)),
  slipDown: stats(rows.filter((r) => r.tag.startsWith('C ') && r.slip !== null).map((r) => r.slip)),
  rmb: { yaw: +(rd.yaw1 - rd.yaw0).toFixed(4), pan: rd.dist },
};

console.log(`\n==== ${ARM} ====`);
for (const [k, v] of Object.entries(summary)) {
  if (k === 'arm' || k === 'rmb') continue;
  console.log(`  ${k.padEnd(10)} n=${v.n}  mean ${String(v.mean).padStart(9)}  sd ${String(v.sd).padStart(9)}  ` +
    `min ${String(v.min).padStart(9)}  max ${String(v.max).padStart(9)}  max/min ${v.ratio}`);
}
console.log(`  rmb        yaw ${summary.rmb.yaw} rad, focus pan ${summary.rmb.pan} m`);
if (errs.length) { console.log(`\n${errs.length} console error(s):`); for (const e of [...new Set(errs)].slice(0, 10)) console.log(`  ${e}`); }

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ summary, rows, keyRows, edgeRows, liveRows, errs: [...new Set(errs)] }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
process.exit(errs.length ? 1 : 0);
