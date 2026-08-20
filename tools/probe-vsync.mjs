#!/usr/bin/env node
/**
 * Is this rAF loop paced by a display, and what is the quality controller doing about it?
 *
 * ## Why this instrument exists
 *
 * `AdaptiveQuality` has two arms. The CPU arm times the render half of the frame; the
 * presented arm watches the rAF interval and is the only one that can see a GPU-bound frame.
 * The presented arm is only meaningful on a loop a display is pacing, so it gates itself on a
 * detector — and the detector is the single most consequential line in the file, because it
 * can only ever cause a *drop*. When it is wrong, the game runs at a resolution the player did
 * not choose and no measurement justified, and it does it silently.
 *
 * It has been wrong twice, both measured on the Carthage assault at 3,440 men:
 *
 *  - **It latched on a loop that was not paced at all.** The old test asked for a median
 *    within 15 % of a refresh period and an interquartile spread under half of one. Headless
 *    Chromium under machine load measured p50 15.3-16.8 ms and IQR 8.3-8.9 against a threshold
 *    of 8.33 — on the boundary, flickering across it. Each latch read ivP90 23-25 ms as missed
 *    frames and dropped, while the CPU arm read p50 2.8 / p90 3.2 ms against a 7.2-12.7 ms
 *    band. Five pressure steps, four drawing-buffer reallocations, four reversals, settled at
 *    the tier floor.
 *  - **It held a 120 Hz loop to 120 fps on a 60 Hz target.** When the loop *is* cleanly
 *    quantised (p50 8.33, IQR 0.2-1.5) the detector is right, but the threshold it fed was
 *    `refreshMs * MISS_FACTOR` — 10.0 ms — while `targetMs` in the same function says the
 *    controller never asks for better than 60 Hz. Two targets a factor of two apart.
 *
 * Both are fixed. This tool is what keeps them fixed: it prints the discriminator and both
 * arms side by side, so "the controller dropped" and "the controller had a reason" are two
 * columns rather than one assumption.
 *
 * ## The discriminator
 *
 * Vsync **quantises**: a frame is presented after one scanout, or two, or three, never
 * between. So the honest test is the mean distance from each interval to the nearest whole
 * multiple of the candidate period, as a fraction of that period — near zero for a paced loop,
 * near 0.25 for a loop running flat out. `--selftest` proves the arithmetic on inputs whose
 * answer is known by hand, because a detector that silently returns "no display" costs
 * nothing visible and would never be noticed.
 *
 *   node tools/probe-vsync.mjs --selftest
 *   node tools/probe-vsync.mjs --port=5788 --secs=30 --map=carthage --scenario=assault
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

/** Refresh periods a display-paced loop can legitimately sit on. Mirrors `AdaptiveQuality`. */
export const REFRESH_MS = [1000 / 60, 1000 / 90, 1000 / 120, 1000 / 144];
/** Mirrors `REFRESH_QUANTISATION_MAX`. */
export const QUANT_MAX = 0.12;

/**
 * Mean distance from each interval to the nearest whole multiple of `period`, as a fraction of
 * the period. The nearest multiple is floored at one, so an interval shorter than the period
 * counts fully against the hypothesis instead of rounding to zero.
 *
 * This is a copy of the method in `src/core/AdaptiveQuality.ts` and it is a copy on purpose:
 * a probe that imports the thing it is checking cannot catch the thing being deleted. If the
 * two ever disagree, `--selftest` here is the one with the hand-worked answers.
 */
export function quantisation(intervals, period) {
  let acc = 0, m = 0;
  for (const iv of intervals) {
    if (iv <= 0) continue;
    const k = iv / period;
    acc += Math.abs(k - Math.max(1, Math.round(k)));
    m++;
  }
  return m ? acc / m : 1;
}

/** The period this series is paced by, or 0. Mirrors the detector's loop and its order. */
export function detect(intervals) {
  const s = [...intervals].filter((v) => v > 0).sort((a, b) => a - b);
  if (!s.length) return { refreshMs: 0, quant: 1, p50: 0 };
  const p50 = s[Math.floor(s.length * 0.5)];
  let best = 1;
  for (const r of REFRESH_MS) {
    const q = quantisation(intervals, r);
    if (q < best) best = q;
    if (p50 >= r * 0.75 && q < QUANT_MAX) return { refreshMs: r, quant: q, p50 };
  }
  return { refreshMs: 0, quant: best, p50 };
}

if (args.get('selftest') === 'true') {
  const fails = [];
  const near = (name, got, want, tol) => {
    if (!(Math.abs(got - want) <= tol)) fails.push(`${name}: got ${got.toFixed(4)}, want ${want}±${tol}`);
  };
  const eq = (name, got, want) => { if (got !== want) fails.push(`${name}: got ${got}, want ${want}`); };
  const P60 = 1000 / 60, P120 = 1000 / 120;

  // A perfect 60 Hz loop: every interval is exactly one period, distance 0.
  near('perfect 60Hz quant', quantisation(Array(90).fill(P60), P60), 0, 1e-9);
  // A 60 Hz loop dropping every other frame: every interval is two periods, still distance 0.
  near('60Hz dropping half', quantisation(Array(90).fill(2 * P60), P60), 0, 1e-9);
  // Worked by hand: intervals of 16.67 and 25.0 against a 16.67 period are k = 1 and k = 1.5,
  // distances 0 and 0.5, mean 0.25.
  near('half-period offset', quantisation([P60, 1.5 * P60], P60), 0.25, 1e-9);
  // An interval *below* one period counts fully: k = 0.5, nearest allowed multiple 1, distance 0.5.
  near('sub-period interval', quantisation([0.5 * P60], P60), 0.5, 1e-9);
  // Uniform noise across a period averages a quarter of it.
  const uniform = Array.from({ length: 4000 }, (_, i) => P60 * (1 + i / 4000));
  near('uniform across a period', quantisation(uniform, P60), 0.25, 0.01);
  // Empty and all-zero series must say "no display" rather than "perfect display".
  near('empty series', quantisation([], P60), 1, 1e-9);
  near('all zero', quantisation([0, 0, 0], P60), 1, 1e-9);

  // Detection, end to end.
  eq('detect perfect 60Hz', detect(Array(90).fill(P60)).refreshMs, P60);
  eq('detect 120Hz', detect(Array(90).fill(P120)).refreshMs, P120);
  // A 120 Hz loop is not 60 Hz: k = 0.5 against a 60 Hz period, so 60 Hz must be rejected
  // and the p50 gate must reject it too.
  eq('120Hz is not 60Hz', detect(Array(90).fill(P120)).refreshMs === P60, false);
  // A 60 Hz display missing one frame in ten still reads as 60 Hz — the case the old
  // median test threw away, and the exact case the arm exists for.
  const missing = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 2 * P60 : P60));
  eq('60Hz missing 1 in 10', detect(missing).refreshMs, P60);
  // The measured free-running headless loop: p50 ~16 ms with an IQR of ~8.4. Reconstructed as
  // a spread around 16 ms, it must be rejected.
  const free = Array.from({ length: 200 }, (_, i) => 12 + (i * 7.3) % 9);
  eq('free-running rejected', detect(free).refreshMs, 0);
  if (detect(free).quant <= QUANT_MAX) fails.push(`free-running quant ${detect(free).quant.toFixed(3)} should exceed ${QUANT_MAX}`);

  if (fails.length) { console.log('selftest FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('selftest: 13 checks passed');
  if (args.get('port') === undefined) process.exit(0);
}

// ---------------------------------------------------------------------------
// Live: what the loop is doing and what the controller makes of it.
// ---------------------------------------------------------------------------
const { chromium } = await import('playwright');
const PORT = Number(args.get('port') ?? 5788);
const SECS = Number(args.get('secs') ?? 30);
const MAP = args.get('map') ?? 'carthage';
const SCEN = args.get('scenario') ?? 'assault';
const Q = args.get('quality') ?? 'high';
const W = Number(args.get('w') ?? 1600), H = Number(args.get('h') ?? 900);
const loadNow = () => { try { const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/); return m ? +m[1] : null; } catch { return null; } };

// `?menu=0`, not `?harness=1`: the harness pins `fixedSize`, which turns the adaptive loop off
// entirely (`Engine`: `opts.adaptive ?? !opts.fixedSize`). A probe that booted the harness would
// be measuring a controller that is not running.
const url = `http://127.0.0.1:${PORT}/?menu=0&map=${MAP}&scenario=${SCEN}&autoplay=1&quality=${Q}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
console.log(`url: ${url}   load ${loadNow()}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
console.log('men: ' + await page.evaluate(() => window.__game.battle.units.reduce((a, u) => a + u.alive, 0)));
// The interval is taken from `frame`'s own argument, which *is* the rAF timestamp. A second
// rAF callback would perturb the schedule it is trying to measure.
await page.evaluate(() => {
  const e = window.__game.engine, orig = e.frame.bind(e);
  let last = 0; window.__iv = [];
  e.frame = (n) => { if (last) window.__iv.push(n - last); last = n; orig(n); };
});
console.log('  s | press scale | refresh  quant  ivP50 ivP90 |  rend p50/p90   band   | chg realloc rev');
const rows = [];
for (let i = 0; i < SECS; i++) {
  await page.waitForTimeout(1000);
  const iv = await page.evaluate(() => window.__iv.splice(0));
  const st = await page.evaluate(() => window.__game.engine.adaptiveQuality.state());
  const d = detect(iv);
  const s = [...iv].sort((a, b) => a - b);
  const q = (f) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
  rows.push({ i, ...d, ivP90: q(0.9), n: iv.length, pressure: st.pressure, scale: st.appliedScale, p50: st.p50, p90: st.p90, changes: st.changes, reallocs: st.reallocs });
  console.log(`${String(i).padStart(3)} | ${st.pressure.toFixed(2)}  ${st.appliedScale.toFixed(2)} |`
    + ` ${d.refreshMs ? d.refreshMs.toFixed(2) : '  none'}  ${d.quant.toFixed(3)}  ${d.p50.toFixed(1).padStart(5)} ${q(0.9).toFixed(1).padStart(5)} |`
    + ` ${st.p50.toFixed(1).padStart(5)}/${st.p90.toFixed(1).padStart(5)}  ${st.raiseMs.toFixed(1)}-${st.dropMs.toFixed(1)} |`
    + ` ${String(st.changes).padStart(3)} ${String(st.reallocs).padStart(7)} ${String(st.reversals).padStart(3)}`);
}
const last = rows.at(-1);
console.log(`\nsettled: pressure ${last.pressure.toFixed(2)}  scale ${last.scale.toFixed(2)}`
  + `  changes ${last.changes}  reallocations ${last.reallocs}  reversals ${rows.at(-1).reversals ?? 0}`);
// The check worth failing on: the controller must not be spending the resolution ladder while
// its own CPU arm reports the frame is comfortably inside the band.
const idle = rows.filter((r) => r.p90 > 0 && r.p90 < 5);
if (idle.length > 5 && last.pressure > 0.5) {
  console.log(`!! pressure ${last.pressure.toFixed(2)} with render p90 under 5 ms for ${idle.length} s — a drop with no cause the levers can address`);
}
if (errors.length) console.log('ERRORS: ' + errors.slice(0, 6).join(' | '));
await browser.close();
