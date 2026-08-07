#!/usr/bin/env node
/**
 * Frame-time distribution, with the frame taken apart.
 *
 * `tools/probe-interactive.mjs` established that the honest clock is a real
 * `requestAnimationFrame` loop with real input, not a driver calling `engine.frame()` in a
 * tight loop. This is that, plus the two things a mean cannot tell you:
 *
 *  1. **The tail.** p50/p90/p95/p99/max and the count of frames over 16.7 and 33 ms, for
 *     both clocks, kept apart. The rAF delta is bounded below by the display interval and is
 *     contaminated by headless compositing and by whatever else is on the box; `engine.frame()`
 *     is the part this codebase controls. A stutter lives in p99 and in nothing else.
 *
 *  2. **Where the time went.** `Engine.frame` is not reimplemented here — it is left alone and
 *     its *parts* are wrapped, so the split is measured on the real frame:
 *       total     the whole of `engine.frame(now)`
 *       fixed     the sum of every subsystem's `fixedUpdate`, across all steps this frame
 *       steps     how many fixed steps ran (`Time.ticksThisFrame`) — a 3-step frame is a
 *                 different animal from a 1-step frame and the two must never be pooled
 *       update    the sum of every subsystem's `update`
 *       preRender the sum of every subsystem's `preRender` (culling, LOD, impostors)
 *       render    `renderOverride` (the PostFX composer) or `renderer.render`
 *       other     total minus the above: input, the camera rig, `info.reset`, loop overhead
 *     Per-subsystem totals are kept too, so "sim is slow" can be answered with a name.
 *
 * Spike frames (over `--spike`, default 20 ms) are recorded whole: step count, draw calls,
 * triangles, sim time, phase, and the three worst subsystems in that frame. A single 60 ms
 * frame with a shader compile in it and a run of twenty 20 ms frames are different bugs and
 * a percentile cannot tell them apart.
 *
 * Two arms, interleaved, in one page load
 * ---------------------------------------
 * Cross-session comparison is invalid on this project: VFX reseed per session and two
 * identical runs differ over most of the frame. So `--ab` alternates two arms inside one
 * page load, driving the *same* short interaction cycle in each, and reports both. Best-block
 * is printed alongside the median because contention on this box is one-sided — it can only
 * ever add time, so the cheapest block is the closest thing to a clean read.
 *
 *   node tools/probe-frametime.mjs --port=5733 --map=carthage --seconds=30
 *   node tools/probe-frametime.mjs --port=5733 --map=carthage --dpr=2
 *   node tools/probe-frametime.mjs --port=5733 --ab \
 *        --nameA=off --armA="window.__game.engine.quality.ssao=false" \
 *        --nameB=on  --armB="window.__game.engine.quality.ssao=true"
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5733);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const DPR = Number(args.get('dpr') ?? 1);
const TIER = args.get('quality') ?? null;          // null = the game's own default tier
const MAP = args.get('map') ?? 'campus-martius';
const SCENARIO = args.get('scenario') ?? null;
/*
 * `--enemy=carthage` is not optional for a heaviest-case run, and its absence is a trap.
 *
 * `sanitiseConfig` keeps `opponent: Germanic` unless it is asked for Carthage explicitly, so
 * `?map=carthage` on its own is Rome against the Juthungi *on* the Carthage map: no Punic
 * army and no war elephants. Measured — the first Carthage run reported strength
 * `{0:3772, 1:4860, 2:0}`, and a faction-2 count of exactly zero beside two real ones is
 * what gave it away.
 */
const ENEMY = args.get('enemy') ?? null;
const SECONDS = Number(args.get('seconds') ?? 30);
const AT = Number(args.get('at') ?? 60);
const SPIKE = Number(args.get('spike') ?? 20);
const DEEP = args.get('shallow') !== 'true';       // --shallow drops the inner wrappers
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? `${MAP}/${TIER ?? 'default'}/dpr${DPR}`;

const AB = args.get('ab') === 'true';
const ARM_A = args.get('armA') ?? '';
const ARM_B = args.get('armB') ?? '';
const NAME_A = args.get('nameA') ?? 'A';
const NAME_B = args.get('nameB') ?? 'B';
const CYCLES = Number(args.get('cycles') ?? 4);    // per arm

/**
 * Provenance of the tree being measured, not of the tree the tool lives in.
 *
 * A number here is a number about whatever the dev server is serving. On this project the
 * shared checkout is routinely dirty with a dozen agents' in-flight edits, so a frame time
 * with no tree recorded beside it is unreproducible — and worse, another agent's save can
 * land between two arms of an A/B. `--tree=` names the directory the dev server was started
 * in; it defaults to this tool's own repo, which is right when both are the same checkout.
 */
const TREE_DIR = args.get('tree') ?? new URL('..', import.meta.url).pathname;
const TREE = (() => {
  const g = (a) => { try { return execFileSync('git', a, { cwd: TREE_DIR, encoding: 'utf8' }).trim(); } catch { return '?'; } };
  const dirty = g(['diff', 'HEAD', '--shortstat', '--', 'src/']);
  return {
    dir: TREE_DIR, head: g(['rev-parse', '--short', 'HEAD']),
    branch: g(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtySrc: dirty || 'clean',
  };
})();

/** Load average, read fresh. Every number below is meaningless without it. */
const load = () => {
  try {
    const s = execFileSync('uptime', { encoding: 'utf8' });
    const m = s.match(/load averages?:\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
    return m ? { m1: Number(m[1]), m5: Number(m[2]), m15: Number(m[3]) } : null;
  } catch { return null; }
};
const loadStr = (l) => (l ? `${l.m1.toFixed(2)} ${l.m5.toFixed(2)} ${l.m15.toFixed(2)}` : '?');

// ---------------------------------------------------------------------------
// Statistics. The tail is the deliverable, so nothing here reports a mean alone.
// Defined before anything opens a browser so `--selftest` can check it for free.
// ---------------------------------------------------------------------------
const stat = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (fr) => s[Math.min(s.length - 1, Math.floor(s.length * fr))];
  return {
    n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99),
    max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length,
    o167: a.filter((v) => v > 16.7).length, o33: a.filter((v) => v > 33).length,
  };
};

/**
 * `--selftest`: prove the percentile code on input whose answer is known by hand.
 *
 * A percentile function is exactly the kind of thing that is off by one and still looks
 * plausible, and a wrong p99 on this project would be worse than no p99 — it is the number
 * the whole workstream turns on.
 */
if (args.get('selftest') === 'true') {
  const fails = [];
  const chk = (name, got, want) => { if (got !== want) fails.push(`${name}: got ${got}, want ${want}`); };
  // 1..100, so the k-th percentile is simply the (k+1)-th value under floor indexing.
  const a = Array.from({ length: 100 }, (_, i) => i + 1);
  let s = stat(a);
  chk('n', s.n, 100); chk('min', s.min, 1); chk('max', s.max, 100);
  chk('p50', s.p50, 51); chk('p90', s.p90, 91); chk('p95', s.p95, 96); chk('p99', s.p99, 100);
  chk('mean', s.mean, 50.5);
  // A flat series with one spike: the mean barely moves, p99 must catch it. This is the
  // whole reason the tool exists, so it is the case that gets an explicit test.
  const flat = Array.from({ length: 999 }, () => 10).concat([250]);
  s = stat(flat);
  chk('spike max', s.max, 250);
  chk('spike p50', s.p50, 10);
  chk('spike mean rounded', Math.round(s.mean * 100) / 100, 10.24);
  chk('spike >33', s.o33, 1);
  chk('spike >16.7', s.o167, 1);
  // Threshold counts are strict, and 16.7 must not catch a frame that is exactly 16.7.
  s = stat([16.7, 16.71, 33, 33.01]);
  chk('strict >16.7', s.o167, 3); chk('strict >33', s.o33, 1);
  chk('empty', stat([]), null);
  // Single sample: every percentile is that sample, nothing indexes off the end.
  s = stat([7]);
  chk('single p99', s.p99, 7); chk('single max', s.max, 7);
  console.log(fails.length ? `selftest FAILED:\n  ${fails.join('\n  ')}` : 'selftest: 10 checks passed');
  process.exit(fails.length ? 1 : 0);
}

const base = `http://127.0.0.1:${PORT}`;
const ping = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
// A probe with no server on its port silently serves a stale `dist/`, and has reported a
// score from a tree that no longer existed. Confirm and print, every time.
if (!ping?.ok) throw new Error(`no dev server on ${base} (status ${ping?.status ?? 'no answer'}) — start your own; do not borrow 5173`);
console.log(`source: ${base} — HTTP ${ping.status}, confirmed live`);

/**
 * Refuse to measure a machine that is too busy to be measured.
 *
 * Frame timing on a box under contention is not a measurement, it is noise, and a fabricated
 * baseline is worse than no baseline: an *unchanged* tree has measured slower than a changed
 * one here. `--maxload=0` opts out for the load-independent numbers (draw calls, the program
 * curve), which are safe to take under any contention.
 */
const MAXLOAD = Number(args.get('maxload') ?? 45);
const WAITLOAD = Number(args.get('waitload') ?? 0);   // seconds to wait for the load to drop
if (MAXLOAD > 0) {
  const deadline = Date.now() + WAITLOAD * 1000;
  let l = load();
  while (l && l.m1 > MAXLOAD && Date.now() < deadline) {
    console.log(`waiting for load: ${loadStr(l)} > ${MAXLOAD}, ${Math.round((deadline - Date.now()) / 1000)}s left`);
    await new Promise((r) => setTimeout(r, 20000));
    l = load();
  }
  if (l && l.m1 > MAXLOAD) {
    console.log(`REFUSING to measure: 1-minute load ${l.m1.toFixed(2)} exceeds --maxload=${MAXLOAD}.`);
    console.log(`Frame times taken here would be noise. Re-run when quieter, or pass --maxload=0`);
    console.log(`if you only want the load-independent numbers (draws, program curve).`);
    process.exit(3);
  }
}

const LOAD_BEFORE = load();
console.log(`load before: ${loadStr(LOAD_BEFORE)}`);

// `--use-gl=angle --use-angle=metal` or Chromium software-rasterises and a 35 s job becomes
// half an hour at 700% CPU, looking exactly like a hang.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  // The harness renders at dpr 1 even at ultra, because `maxPixelRatio: 2` is capped by
  // `window.devicePixelRatio`, which is 1 headless. `deviceScaleFactor` is the only way to
  // see the cost of a resolution lever at all from here.
  deviceScaleFactor: DPR,
});
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 240)}`); });

const url = `${base}/?harness=1&autoplay=0&w=${W}&h=${H}&map=${MAP}`
  + (TIER ? `&quality=${TIER}` : '')
  + (SCENARIO ? `&scenario=${SCENARIO}` : '')
  + (ENEMY ? `&enemy=${ENEMY}` : '');
console.log(`url: ${url}   viewport ${W}x${H} @ dpr ${DPR}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
// Program count at three moments, because `advance()` renders thousands of frames and links
// most of the cache before the session starts. Without the first two, the session's residual
// linking looks like the whole story; with them, "linked at boot / linked during the
// fast-forward / linked while the player was playing" are three separate numbers.
const progsAtBoot = await page.evaluate(() => window.__game.engine.renderer.info.programs?.length ?? -1);
if (AT > 0) await page.evaluate((t) => window.__game.advance(t), AT);
const progsAfterAdvance = await page.evaluate(() => window.__game.engine.renderer.info.programs?.length ?? -1);

// ---------------------------------------------------------------------------
// Instrumentation. `Engine.frame` is wrapped, and so are the parts it calls — the frame
// itself is never reimplemented, so the split cannot drift from what actually runs.
// ---------------------------------------------------------------------------
const setup = await page.evaluate((deep) => {
  const g = window.__game;
  const e = g.engine;
  const N = 60000;
  const p = {
    n: 0, deep, arm: -1, phase: 0, phaseNames: [], armNames: [],
    rafDt: new Float64Array(N), total: new Float64Array(N),
    fixed: new Float64Array(N), upd: new Float64Array(N), pre: new Float64Array(N),
    rnd: new Float64Array(N),
    steps: new Int32Array(N), calls: new Int32Array(N), tris: new Float64Array(N),
    simT: new Float64Array(N), phaseOf: new Int32Array(N), armOf: new Int32Array(N),
    // Three.js links a shader program lazily, on the first frame a material is actually
    // drawn, and there is no `renderer.compile()` anywhere in this codebase. A synchronous
    // `glLinkProgram` on ANGLE-on-Metal is tens of milliseconds and lands on one frame: a
    // p99 spike that leaves p50 untouched, which is exactly what "laggy" feels like when the
    // averages look fine. Texture and geometry counts are here for the same reason — a jump
    // means an upload or an allocation landed in that frame.
    progs: new Int32Array(N), tex: new Int32Array(N), geo: new Int32Array(N),
    spikes: [],
  };
  window.__probe = p;

  // The systems array is private in TypeScript and an ordinary property at runtime.
  const systems = e.systems;
  const names = systems.map((s) => s.name);
  p.sysNames = names;
  const nS = names.length;
  // Per-frame scratch, and session totals. Session totals answer "which subsystem", the
  // scratch answers "which subsystem in *that* frame".
  const scratchFix = new Float64Array(nS);
  const scratchUpd = new Float64Array(nS);
  const scratchPre = new Float64Array(nS);
  p.sumFix = new Float64Array(nS);
  p.sumUpd = new Float64Array(nS);
  p.sumPre = new Float64Array(nS);
  p.maxFix = new Float64Array(nS);

  let accFix = 0, accUpd = 0, accPre = 0, accRnd = 0;
  const now = () => performance.now();

  // Every inner timer is gated on `p.deep` read at call time, not on the closure constant,
  // so an A/B arm can switch the attribution off and the tool can measure its own overhead
  // inside one page load — the only kind of comparison that is valid on this project.
  if (deep) {
    systems.forEach((s, i) => {
      if (s.fixedUpdate) {
        const f = s.fixedUpdate.bind(s);
        s.fixedUpdate = (dt, ctx) => {
          if (!p.deep) return f(dt, ctx);
          const t = now(); f(dt, ctx); const d = now() - t;
          accFix += d; scratchFix[i] += d;
        };
      }
      if (s.update) {
        const f = s.update.bind(s);
        s.update = (dt, ctx) => {
          if (!p.deep) return f(dt, ctx);
          const t = now(); f(dt, ctx); const d = now() - t;
          accUpd += d; scratchUpd[i] += d;
        };
      }
      if (s.preRender) {
        const f = s.preRender.bind(s);
        s.preRender = (ctx) => {
          if (!p.deep) return f(ctx);
          const t = now(); f(ctx); const d = now() - t;
          accPre += d; scratchPre[i] += d;
        };
      }
    });
    // PostFX installs `renderOverride` during init, so by now it is the real composer.
    if (e.renderOverride) {
      const ro = e.renderOverride;
      e.renderOverride = (ctx) => {
        if (!p.deep) return ro(ctx);
        const t = now(); ro(ctx); accRnd += now() - t;
      };
    } else {
      const rr = e.renderer.render.bind(e.renderer);
      e.renderer.render = (sc, cam) => {
        if (!p.deep) return rr(sc, cam);
        const t = now(); rr(sc, cam); accRnd += now() - t;
      };
    }
  }

  // The rAF delta is taken from `frame`'s own argument, which *is* the rAF timestamp. That
  // aligns it exactly with the frame index and costs nothing — a second rAF callback would
  // perturb the schedule it is trying to measure.
  let lastNow = 0;
  const orig = e.frame.bind(e);
  e.frame = (nowMs) => {
    accFix = accUpd = accPre = accRnd = 0;
    if (deep) { scratchFix.fill(0); scratchUpd.fill(0); scratchPre.fill(0); }
    const t0 = now();
    orig(nowMs);
    const t1 = now();
    const i = p.n;
    if (i >= N) return;
    p.rafDt[i] = lastNow ? nowMs - lastNow : 0;
    lastNow = nowMs;
    p.total[i] = t1 - t0;
    p.fixed[i] = accFix; p.upd[i] = accUpd; p.pre[i] = accPre; p.rnd[i] = accRnd;
    p.steps[i] = e.time.ticksThisFrame;
    const info = e.renderer.info;
    p.calls[i] = info.render.calls;
    p.tris[i] = info.render.triangles;
    // `info.programs` is the program cache, not a per-frame counter, so `info.reset()`
    // leaves it alone. `Engine.stats` reads it through an optional chain, so confirm it is
    // populated at all before believing a flat curve.
    p.progs[i] = info.programs ? info.programs.length : -1;
    p.tex[i] = info.memory.textures;
    p.geo[i] = info.memory.geometries;
    p.simT[i] = e.time.simTime;
    p.phaseOf[i] = p.phase; p.armOf[i] = p.arm;
    if (deep) {
      for (let k = 0; k < nS; k++) {
        p.sumFix[k] += scratchFix[k]; p.sumUpd[k] += scratchUpd[k]; p.sumPre[k] += scratchPre[k];
        if (scratchFix[k] > p.maxFix[k]) p.maxFix[k] = scratchFix[k];
      }
    }
    if (t1 - t0 > p.spikeMs) {
      const top = [];
      if (deep) {
        for (let k = 0; k < nS; k++) {
          const v = scratchFix[k] + scratchUpd[k] + scratchPre[k];
          if (v > 0.4) top.push([names[k], +v.toFixed(2)]);
        }
        top.sort((a, b) => b[1] - a[1]);
      }
      p.spikes.push({
        i, total: +(t1 - t0).toFixed(2), raf: +p.rafDt[i].toFixed(1), steps: p.steps[i],
        fixed: +accFix.toFixed(2), upd: +accUpd.toFixed(2), pre: +accPre.toFixed(2),
        rnd: +accRnd.toFixed(2), calls: p.calls[i], tris: p.tris[i],
        // The deltas, not the levels: a spike that coincides with a program link, a texture
        // upload or a geometry allocation has named its own cause. A spike where all three
        // deltas are zero has ruled those three out, which is worth just as much.
        progs: p.progs[i], dProg: i ? p.progs[i] - p.progs[i - 1] : 0,
        dTex: i ? p.tex[i] - p.tex[i - 1] : 0, dGeo: i ? p.geo[i] - p.geo[i - 1] : 0,
        simT: +p.simT[i].toFixed(1), phase: p.phase, arm: p.arm, top: top.slice(0, 3),
      });
    }
    p.n = i + 1;
  };
  p.spikeMs = 1e9; // armed by the driver once the session starts

  const strength = e.context.tryGet('battle')?.strength ?? {};
  return {
    systems: names.length,
    men: Object.values(strength).reduce((a, b) => a + b, 0),
    strength,
    dpr: e.renderer.getPixelRatio(),
    drawing: [e.renderer.domElement.width, e.renderer.domElement.height],
    tier: e.quality.tier,
    maxSoldiers: e.quality.maxSoldiers,
    override: !!e.renderOverride,
  };
}, DEEP);

console.log(`boot: map=${MAP} tier=${setup.tier} men=${setup.men} systems=${setup.systems}`
  + ` renderer dpr=${setup.dpr} drawing=${setup.drawing[0]}x${setup.drawing[1]}`
  + ` postfx=${setup.override} deep=${DEEP}`);
// Shape check before value check: an arm that never ran reports exactly zero.
if (!setup.men) console.log('!! zero men on the field — the scenario did not deploy');
if (setup.systems < 5) console.log('!! implausibly few subsystems — the wrapper found the wrong object');

await page.evaluate((s) => { window.__probe.spikeMs = s; }, SPIKE);

const canvas = await page.$('#viewport') ?? await page.$('canvas');
if (!canvas) throw new Error('no canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const wait = (ms) => page.waitForTimeout(ms);
const phase = (name) => page.evaluate((n) => {
  window.__probe.phaseNames.push(n);
  window.__probe.phase = window.__probe.phaseNames.length - 1;
}, name);

// ---------------------------------------------------------------------------
// The session. Not a shot list: what a player does with their hands.
// ---------------------------------------------------------------------------
const panKeys = async (ms = 420) => {
  for (const k of ['KeyW', 'KeyD', 'KeyS', 'KeyA']) {
    await page.keyboard.down(k); await wait(ms); await page.keyboard.up(k);
  }
};
const rotate = async () => {
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  for (let i = 0; i < 14; i++) { await page.mouse.move(cx + i * 22, cy + i * 3); await wait(40); }
  await page.mouse.up({ button: 'middle' });
};
const zoom = async () => {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -180); await wait(70); }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await wait(70); }
};

/**
 * Put the camera back where the battle is.
 *
 * A session that only pans and zooms drifts off the fight and then spends most of its frames
 * photographing grass: the first run of this tool put 66% of its frames in a settle phase at
 * 3.4M triangles when the opening view was 15.7M. That is a real thing players do, but it
 * silently reweights the whole distribution towards the cheap case, so the heavy case gets
 * sampled deliberately at the end rather than left to chance.
 */
const openingCam = await page.evaluate(() => {
  const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
});
const refocus = (zoom) => page.evaluate(
  (c) => window.__game.setCamera(c.x, c.z, c.zoom, c.yaw),
  { ...openingCam, zoom: zoom ?? openingCam.zoom },
);

const FULL = [
  ['idle', async () => { await wait(2000); }],
  ['pan-keys', panKeys],
  ['rotate-drag', rotate],
  ['zoom-wheel', zoom],
  ['drag-select', async () => {
    await page.mouse.move(cx - 420, cy - 200);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) { await page.mouse.move(cx - 420 + i * 84, cy - 200 + i * 40); await wait(35); }
    await page.mouse.up();
    await wait(500);
  }],
  ['order-move', async () => {
    await page.mouse.click(cx + 180, cy - 90, { button: 'right' });
    await wait(1400);
    await page.mouse.click(cx - 220, cy + 60, { button: 'right' });
    await wait(1400);
  }],
  ['order-run', async () => {
    await page.keyboard.press('KeyR');
    await wait(500);
    await page.mouse.click(cx + 60, cy - 200, { button: 'right' });
    await wait(1600);
  }],
  ['pan-while-fighting', async () => {
    await page.keyboard.down('KeyA'); await wait(800); await page.keyboard.up('KeyA');
    await page.keyboard.down('KeyE'); await wait(700); await page.keyboard.up('KeyE');
    await wait(1000);
  }],
  // The heaviest thing a player can do: stand in the melee and turn round.
  ['melee-close', async () => {
    await refocus(0.34);
    await wait(1200);
    await page.keyboard.down('KeyE'); await wait(1200); await page.keyboard.up('KeyE');
    await wait(800);
  }],
  ['melee-orbit-wide', async () => {
    await refocus(0.62);
    await wait(600);
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -140); await wait(80); }
    await page.keyboard.down('KeyQ'); await wait(1200); await page.keyboard.up('KeyQ');
    await wait(900);
  }],
];

/** One arm-comparable cycle: identical motion every time, so A and B see the same work. */
const CYCLE = async () => {
  await wait(700);
  await panKeys(320);
  await rotate();
  await zoom();
  await wait(500);
};

const t0 = Date.now();
if (AB) {
  console.log(`# A/B interleaved in one page load: ${CYCLES} cycles per arm, alternating`);
  const setArm = async (idx, name, js) => {
    await page.evaluate(({ idx, name, js }) => {
      const p = window.__probe;
      if (!p.armNames[idx]) p.armNames[idx] = name;
      p.arm = idx;
      if (js) (0, eval)(js);
    }, { idx, name, js });
  };
  for (let c = 0; c < CYCLES; c++) {
    for (const [idx, name, js] of [[0, NAME_A, ARM_A], [1, NAME_B, ARM_B]]) {
      await setArm(idx, name, js);
      await phase(`cycle${c}-${name}`);
      // Discard the first 300 ms after a switch: a lever that recompiles a shader charges
      // the frame it lands on, not the arm.
      await wait(300);
      await page.evaluate(() => { window.__probe.settled = window.__probe.n; });
      await CYCLE();
    }
  }
} else {
  console.log(`# ${W}x${H} dpr${DPR} ${setup.tier}, map ${MAP}, from t+${AT}s, ~${SECONDS}s of real interaction`);
  for (const [name, fn] of FULL) { await phase(name); await fn(); }
  const spent = (Date.now() - t0) / 1000;
  // Capped: idle frames are the cheapest in the session and an unbounded settle silently
  // reweights the whole distribution towards them.
  const settle = Math.min(4, SECONDS - spent);
  if (settle > 0) { await phase('settle'); await wait(settle * 1000); }
}

const out = await page.evaluate(() => {
  const p = window.__probe;
  const n = p.n;
  const cut = (a) => Array.from(a.slice(0, n));
  return {
    n,
    rafDt: cut(p.rafDt), total: cut(p.total), fixed: cut(p.fixed), upd: cut(p.upd),
    pre: cut(p.pre), rnd: cut(p.rnd), steps: cut(p.steps), calls: cut(p.calls),
    tris: cut(p.tris), simT: cut(p.simT), phaseOf: cut(p.phaseOf), armOf: cut(p.armOf),
    progs: cut(p.progs), tex: cut(p.tex), geo: cut(p.geo),
    phaseNames: p.phaseNames, armNames: p.armNames, spikes: p.spikes, sysNames: p.sysNames,
    sumFix: p.sumFix ? Array.from(p.sumFix) : null,
    sumUpd: p.sumUpd ? Array.from(p.sumUpd) : null,
    sumPre: p.sumPre ? Array.from(p.sumPre) : null,
    maxFix: p.maxFix ? Array.from(p.maxFix) : null,
    simTime: window.__game.simTime(),
    strength: window.__game.engine.context.tryGet('battle')?.strength,
  };
});

const LOAD_AFTER = load();

/**
 * Drop the first few frames after `advance()`.
 *
 * `Engine.advance` ends with `time.rebase()`, which resets the frame clock but deliberately
 * keeps the accumulator's sub-tick debt so that N short advances equal one long one. After
 * 3,600 synthetic frames that debt is at the `maxStepsPerFrame` ceiling, so the first live
 * frames each fire all five ticks and cost 38-43 ms. Measured: frames 1-3 of a Carthage run
 * were 5-step frames with an rAF delta of 1141 ms, which cannot be a live rAF interval —
 * that is the synthetic-to-real clock boundary, not the game. Real players never see it
 * because they never call `advance`. Left in, it owns the p99.
 */
const WARMUP = Number(args.get('warmup') ?? 6);
if (WARMUP > 0 && out.n > WARMUP * 4) {
  for (const k of ['rafDt', 'total', 'fixed', 'upd', 'pre', 'rnd', 'steps', 'calls', 'tris',
    'simT', 'phaseOf', 'armOf', 'progs', 'tex', 'geo']) out[k] = out[k].slice(WARMUP);
  out.spikes = out.spikes.filter((s) => s.i >= WARMUP);
  out.n -= WARMUP;
  console.log(`\n(dropped the first ${WARMUP} frames: the advance() clock rebase leaves the`
    + ` accumulator full, so they all fire ${5} sim ticks. Pass --warmup=0 to keep them.)`);
}

const f = (v, w = 6, d = 2) => (v === undefined || v === null ? '-'.padStart(w) : v.toFixed(d).padStart(w));
const row = (label, s) => `  ${label.padEnd(16)} ${String(s.n).padStart(5)} ${f(s.p50)} ${f(s.p90)} ${f(s.p95)} `
  + `${f(s.p99)} ${f(s.max, 7)} ${f(s.mean)} ${String(s.o167).padStart(6)} ${String(s.o33).padStart(5)}`;
const HEAD = `  ${'series'.padEnd(16)} ${'n'.padStart(5)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} `
  + `${'p95'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(7)} ${'mean'.padStart(6)} ${'>16.7'.padStart(6)} ${'>33'.padStart(5)}`;

console.log(`\n================ ${LABEL} ================`);
console.log(`sim reached t+${out.simTime.toFixed(0)}s  strength ${JSON.stringify(out.strength)}  frames ${out.n}`);
console.log(`tree ${TREE.head} (${TREE.branch}) src/: ${TREE.dirtySrc}   @ ${TREE.dir}`);
console.log(`load before ${loadStr(LOAD_BEFORE)}   load after ${loadStr(LOAD_AFTER)}`);

console.log(`\n-- distribution, ms --`);
console.log(HEAD);
console.log(row('rAF delta', stat(out.rafDt.slice(1))));
console.log(row('engine.frame()', stat(out.total)));
console.log(row('  fixedUpdate', stat(out.fixed)));
console.log(row('  update', stat(out.upd)));
console.log(row('  preRender', stat(out.pre)));
console.log(row('  render/present', stat(out.rnd)));
const other = out.total.map((t, i) => t - out.fixed[i] - out.upd[i] - out.pre[i] - out.rnd[i]);
console.log(row('  other', stat(other)));

// Fixed steps per frame: a frame running 3 sim ticks is a different animal from one
// running 1, and pooling them hides both.
const byStep = new Map();
out.steps.forEach((s, i) => {
  if (!byStep.has(s)) byStep.set(s, []);
  byStep.get(s).push(i);
});
console.log(`\n-- by fixed-step count (the sim ticks that frame ran) --`);
console.log(`  ${'steps'.padEnd(7)} ${'frames'.padStart(6)} ${'%'.padStart(5)} ${'frame p50'.padStart(9)} `
  + `${'p99'.padStart(7)} ${'fixed p50'.padStart(9)} ${'fixed/step'.padStart(10)} ${'rAF p50'.padStart(8)}`);
for (const s of [...byStep.keys()].sort((a, b) => a - b)) {
  const idx = byStep.get(s);
  const t = stat(idx.map((i) => out.total[i]));
  const fx = stat(idx.map((i) => out.fixed[i]));
  const r = stat(idx.map((i) => out.rafDt[i]).filter((_, k) => idx[k] > 0));
  console.log(`  ${String(s).padEnd(7)} ${String(idx.length).padStart(6)} ${f(100 * idx.length / out.n, 5, 1)} `
    + `${f(t.p50, 9)} ${f(t.p99, 7)} ${f(fx.p50, 9)} ${f(s ? fx.p50 / s : 0, 10)} ${f(r ? r.p50 : 0, 8)}`);
}

console.log(`\n-- draw calls / triangles over the session --`);
const dc = stat(out.calls); const tr = stat(out.tris);
console.log(`  draws   min ${dc.min}  p50 ${Math.round(dc.p50)}  p90 ${Math.round(dc.p90)}  max ${dc.max}`
  + `   (cap 220; over cap on ${out.calls.filter((c) => c > 220).length} frames)`);
console.log(`  tris    min ${(tr.min / 1e6).toFixed(2)}M  p50 ${(tr.p50 / 1e6).toFixed(2)}M  max ${(tr.max / 1e6).toFixed(2)}M`);

// ---------------------------------------------------------------------------
// The shader-link curve. There is no `renderer.compile()` in this codebase, so every
// program is linked on the first frame its material is drawn. If the curve is still
// climbing deep into the battle, players are paying for links mid-fight.
// ---------------------------------------------------------------------------
console.log(`\n-- shader programs / GPU resources --`);
if (out.progs[0] < 0) {
  console.log(`  renderer.info.programs is NOT populated in this build (undefined) — the`
    + ` shader-link hypothesis cannot be tested from here.`);
} else {
  const links = [];
  for (let i = 1; i < out.n; i++) {
    const d = out.progs[i] - out.progs[i - 1];
    if (d !== 0) links.push({ i, d, simT: out.simT[i], ms: out.total[i], rnd: out.rnd[i], phase: out.phaseOf[i] });
  }
  console.log(`  programs: ${progsAtBoot} at boot -> ${progsAfterAdvance} after the t+${AT}s fast-forward`
    + ` -> ${out.progs[out.n - 1]} at the end of the session`);
  console.log(`  of those, ${links.length} frame(s) of the ${out.n} measured linked or dropped a program`
    + ` (${out.progs[out.n - 1] - out.progs[0]} net during play)`);
  if (links.length) {
    const last = links[links.length - 1];
    console.log(`  last link at frame ${last.i}/${out.n} (sim t+${last.simT.toFixed(1)}s) — `
      + `${last.i / out.n > 0.5 ? 'STILL CLIMBING past the halfway mark of the session' : 'plateaus early'}`);
    console.log(`  ${'frame'.padStart(6)} ${'dProg'.padStart(6)} ${'simT'.padStart(7)} ${'frame ms'.padStart(9)} ${'render ms'.padStart(10)}  phase`);
    for (const l of links.slice(0, 25)) {
      console.log(`  ${String(l.i).padStart(6)} ${String(l.d > 0 ? `+${l.d}` : l.d).padStart(6)} `
        + `${f(l.simT, 7, 1)} ${f(l.ms, 9)} ${f(l.rnd, 10)}  ${out.phaseNames[l.phase] ?? '?'}`);
    }
    // The decisive comparison: how expensive is a linking frame against a non-linking one.
    const linkIdx = new Set(links.map((l) => l.i));
    const withLink = stat(links.map((l) => out.total[l.i]));
    const without = stat(out.total.filter((_, i) => !linkIdx.has(i)));
    console.log(`  frames that linked a program: p50 ${f(withLink.p50).trim()} ms, max ${f(withLink.max).trim()} ms`
      + `   |   frames that did not: p50 ${f(without.p50).trim()} ms, p99 ${f(without.p99).trim()} ms`);
  }
  const txd = []; const ged = [];
  for (let i = 1; i < out.n; i++) {
    if (out.tex[i] !== out.tex[i - 1]) txd.push(i);
    if (out.geo[i] !== out.geo[i - 1]) ged.push(i);
  }
  console.log(`  textures ${out.tex[0]} -> ${out.tex[out.n - 1]} (changed on ${txd.length} frames)`
    + `;  geometries ${out.geo[0]} -> ${out.geo[out.n - 1]} (changed on ${ged.length} frames)`);
}

// Per phase, or per arm.
const groups = AB
  ? out.armNames.map((n, i) => [n, out.armOf.map((a, k) => (a === i ? k : -1)).filter((k) => k >= 0)])
  : out.phaseNames.map((n, i) => [n, out.phaseOf.map((p, k) => (p === i ? k : -1)).filter((k) => k >= 0)]);
console.log(`\n-- by ${AB ? 'arm (interleaved in this one page load)' : 'phase'} --`);
console.log(`  ${'name'.padEnd(20)} ${'n'.padStart(5)} ${'rAF p50'.padStart(8)} ${'p99'.padStart(7)} `
  + `${'frame p50'.padStart(9)} ${'p90'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)} `
  + `${'fixed'.padStart(7)} ${'rnd'.padStart(7)} ${'draws'.padStart(6)}`);
for (const [name, idx] of groups) {
  if (!idx.length) continue;
  const r = stat(idx.filter((i) => i > 0).map((i) => out.rafDt[i]));
  const t = stat(idx.map((i) => out.total[i]));
  const fx = stat(idx.map((i) => out.fixed[i]));
  const rn = stat(idx.map((i) => out.rnd[i]));
  const d = stat(idx.map((i) => out.calls[i]));
  console.log(`  ${name.padEnd(20)} ${String(t.n).padStart(5)} ${f(r?.p50, 8)} ${f(r?.p99, 7)} `
    + `${f(t.p50, 9)} ${f(t.p90, 7)} ${f(t.p99, 7)} ${f(t.max, 7)} ${f(fx.p50, 7)} ${f(rn.p50, 7)} `
    + `${String(Math.round(d.p50)).padStart(6)}`);
}

/**
 * Best block: the cheapest 60 consecutive frames in the run.
 *
 * Contention on this box is one-sided — another process can only ever *add* time to a frame,
 * never remove it — so the cheapest comparable window is the closest thing to a clean read
 * that a loaded machine can give. The full distribution above is the deliverable and its tail
 * is real; but under load the tail is partly the box and partly the game, and the best block
 * is the part that is only the game. Reported as a floor, not as the answer.
 */
{
  const win = Math.min(60, Math.max(10, Math.floor(out.n / 8)));
  let best = Infinity; let bestAt = 0;
  for (let s = 0; s + win <= out.n; s++) {
    let m = 0;
    for (let k = s; k < s + win; k++) m += out.total[k];
    if (m < best) { best = m; bestAt = s; }
  }
  const blk = Array.from({ length: win }, (_, k) => bestAt + k);
  const t = stat(blk.map((i) => out.total[i]));
  const fx = stat(blk.map((i) => out.fixed[i]));
  const rn = stat(blk.map((i) => out.rnd[i]));
  const st = blk.map((i) => out.steps[i]);
  console.log(`\n-- best block: the cheapest ${win} consecutive frames (frames ${bestAt}-${bestAt + win - 1}, `
    + `phase ${out.phaseNames[out.phaseOf[bestAt]] ?? '?'}) --`);
  console.log(`  frame() mean ${f(best / win).trim()}  p50 ${f(t.p50).trim()}  p90 ${f(t.p90).trim()}  max ${f(t.max).trim()}`
    + `   fixed p50 ${f(fx.p50).trim()}  render p50 ${f(rn.p50).trim()}`
    + `   mean steps/frame ${(st.reduce((a, b) => a + b, 0) / win).toFixed(2)}`);
  console.log(`  absolute cheapest single frame in the run: ${f(stat(out.total).min).trim()} ms`
    + `   (a 0-step frame costs ${f(stat(out.total.filter((_, i) => out.steps[i] === 0)).p50 ?? 0).trim()} ms at p50)`);
}

if (AB) {
  // Same logic, per arm: the cheapest window each arm managed.
  console.log(`\n-- best block per arm (60 consecutive frames, lowest mean frame()) --`);
  for (const [name, idx] of groups) {
    let best = Infinity; let bestAt = -1;
    for (let s = 0; s + 60 <= idx.length; s += 10) {
      const m = idx.slice(s, s + 60).reduce((a, i) => a + out.total[i], 0) / 60;
      if (m < best) { best = m; bestAt = s; }
    }
    if (bestAt < 0) { console.log(`  ${name.padEnd(20)} too few frames`); continue; }
    const blk = idx.slice(bestAt, bestAt + 60);
    const t = stat(blk.map((i) => out.total[i]));
    console.log(`  ${name.padEnd(20)} mean ${f(best)}  p50 ${f(t.p50)}  p90 ${f(t.p90)}  max ${f(t.max)}`);
  }
}

if (DEEP && out.sumFix) {
  const per = out.sysNames.map((nm, i) => ({
    nm, fix: out.sumFix[i] / out.n, upd: out.sumUpd[i] / out.n, pre: out.sumPre[i] / out.n,
    maxFix: out.maxFix[i],
  }));
  per.sort((a, b) => (b.fix + b.upd + b.pre) - (a.fix + a.upd + a.pre));
  console.log(`\n-- per subsystem, mean ms per frame (top 14) --`);
  console.log(`  ${'subsystem'.padEnd(22)} ${'fixed'.padStart(7)} ${'update'.padStart(7)} ${'preRnd'.padStart(7)} ${'total'.padStart(7)} ${'worstFix'.padStart(8)}`);
  for (const s of per.slice(0, 14)) {
    if (s.fix + s.upd + s.pre < 0.005) break;
    console.log(`  ${s.nm.padEnd(22)} ${f(s.fix, 7, 3)} ${f(s.upd, 7, 3)} ${f(s.pre, 7, 3)} `
      + `${f(s.fix + s.upd + s.pre, 7, 3)} ${f(s.maxFix, 8, 2)}`);
  }
}

console.log(`\n-- worst 15 frames (over ${SPIKE} ms), with what distinguished them --`);
const worst = [...out.spikes].sort((a, b) => b.total - a.total).slice(0, 15);
if (!worst.length) console.log(`  none — no frame exceeded ${SPIKE} ms`);
console.log(`  ${'#'.padStart(5)} ${'total'.padStart(7)} ${'rAF'.padStart(7)} ${'st'.padStart(3)} `
  + `${'fixed'.padStart(6)} ${'upd'.padStart(6)} ${'pre'.padStart(6)} ${'rnd'.padStart(6)} `
  + `${'draws'.padStart(5)} ${'tris'.padStart(6)} ${'prog'.padStart(5)} ${'dP'.padStart(3)} `
  + `${'dTx'.padStart(4)} ${'dGeo'.padStart(4)} ${'simT'.padStart(6)}  phase / top subsystems`);
for (const s of worst) {
  const ph = AB ? (out.armNames[s.arm] ?? '?') : (out.phaseNames[s.phase] ?? '?');
  console.log(`  ${String(s.i).padStart(5)} ${f(s.total, 7)} ${f(s.raf, 7, 1)} ${String(s.steps).padStart(3)} `
    + `${f(s.fixed, 6)} ${f(s.upd, 6)} ${f(s.pre, 6)} ${f(s.rnd, 6)} ${String(s.calls).padStart(5)} `
    + `${(s.tris / 1e6).toFixed(2).padStart(6)} ${String(s.progs).padStart(5)} ${String(s.dProg).padStart(3)} `
    + `${String(s.dTex).padStart(4)} ${String(s.dGeo).padStart(4)} `
    + `${f(s.simT, 6, 1)}  ${ph} ${s.top.map(([n, v]) => `${n}:${v}`).join(' ')}`);
}
{
  const linked = out.spikes.filter((s) => s.dProg !== 0).length;
  const texd = out.spikes.filter((s) => s.dTex !== 0).length;
  const geod = out.spikes.filter((s) => s.dGeo !== 0).length;
  console.log(`  of ${out.spikes.length} spike frames: ${linked} linked a shader program, `
    + `${texd} changed the texture count, ${geod} changed the geometry count`);
}
console.log(`  ${out.spikes.length} of ${out.n} frames were over ${SPIKE} ms `
  + `(${(100 * out.spikes.length / out.n).toFixed(1)}%)`);

// Runs of consecutive slow frames: one 60 ms hitch and twenty 20 ms frames feel different.
let run = 0; const runs = [];
for (let i = 0; i < out.n; i++) {
  if (out.total[i] > SPIKE) run++;
  else { if (run >= 2) runs.push(run); run = 0; }
}
if (run >= 2) runs.push(run);
console.log(`  runs of >=2 consecutive slow frames: ${runs.length}`
  + (runs.length ? `, longest ${Math.max(...runs)} frames` : ''));

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 12)) console.log(`   ${e}`);
} else {
  console.log(`\nno page errors and no console errors across the session.`);
}

if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({
    label: LABEL, url, dpr: DPR, deep: DEEP, spikeMs: SPIKE, tree: TREE,
    loadBefore: LOAD_BEFORE, loadAfter: LOAD_AFTER, setup, errors,
    progs: {
      boot: progsAtBoot, afterAdvance: progsAfterAdvance,
      first: out.progs[0], last: out.progs[out.n - 1],
    },
    tex: { first: out.tex[0], last: out.tex[out.n - 1] },
    geo: { first: out.geo[0], last: out.geo[out.n - 1] },
    n: out.n, simTime: out.simTime, strength: out.strength,
    stats: {
      raf: stat(out.rafDt.slice(1)), frame: stat(out.total), fixed: stat(out.fixed),
      update: stat(out.upd), preRender: stat(out.pre), render: stat(out.rnd),
      other: stat(other), calls: dc, tris: tr,
    },
    spikes: out.spikes, phaseNames: out.phaseNames, armNames: out.armNames,
    perSystem: DEEP && out.sumFix ? out.sysNames.map((nm, i) => ({
      nm, fix: out.sumFix[i] / out.n, upd: out.sumUpd[i] / out.n, pre: out.sumPre[i] / out.n,
    })) : null,
  }, null, 1));
  console.log(`json -> ${JSON_OUT}`);
}

await browser.close();
