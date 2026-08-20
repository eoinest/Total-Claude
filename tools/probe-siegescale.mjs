#!/usr/bin/env node
/**
 * Where a full-scale siege's time goes, as a function of how far the escalade has got.
 *
 * The symptom this exists for: the 3,440-man Carthage storm advances at a fraction of real
 * time once men are on the parapet, and it is *not* slow at t+0. A single pooled
 * distribution over a whole run therefore cannot see it — the run is two different animals
 * at its two ends. So this measures at a list of sim-time checkpoints and reports each one
 * separately.
 *
 * At each checkpoint it runs a *real* rAF window (never `advance`, whose wall clock says
 * nothing about pacing) and records, per frame:
 *   total / fixed / update / preRender / render, the step count, and per-subsystem splits.
 * The headline is `simRate` — sim seconds gained per wall second — which is the number the
 * owner actually experiences.
 *
 * Between checkpoints it fast-forwards with `advance`. `--ffnorender` suppresses the GPU
 * submit during the fast-forward only; `fixedUpdate` is untouched, so the sim state at the
 * checkpoint is identical (asserted by `--hash`, which prints the pool hash at each mark and
 * can be diffed against a run without the flag).
 *
 *   node tools/probe-siegescale.mjs --port=5788 --at=0,60,120,180 --window=8
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5788);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const TIER = args.get('quality') ?? 'ultra';
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'assault';
const AT = (args.get('at') ?? '0,60,120,180,240,300').split(',').map(Number);
const WINDOW = Number(args.get('window') ?? 8);
const FF_NORENDER = args.get('ffnorender') !== 'false';
const DEEP = args.get('shallow') !== 'true';
const ADAPTIVE = args.get('adaptive') ?? null;    // 'off' to disable the controller
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? `${MAP}/${SCENARIO}/${TIER}`;
const CAMERA = args.get('camera') ?? null;        // "x,z,zoom,yaw"
const BOOT = args.get('boot') ?? 'harness';       // harness | menu0 (menu0 = a real player's page)
const HIDE_HUD = args.get('hidehud') === 'true';

const load = () => {
  try {
    const s = execFileSync('uptime', { encoding: 'utf8' });
    const m = s.match(/load averages?:\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
    return m ? { m1: +m[1], m5: +m[2], m15: +m[3] } : null;
  } catch { return null; }
};
const TREE = (() => {
  const dir = new URL('..', import.meta.url).pathname;
  const g = (a) => { try { return execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim(); } catch { return '?'; } };
  return { dir, head: g(['rev-parse', '--short', 'HEAD']), branch: g(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtySrc: g(['diff', 'HEAD', '--shortstat', '--', 'src/']) || 'clean' };
})();

const l0 = load();
console.log(`tree ${TREE.branch}@${TREE.head} (${TREE.dirtySrc})   load ${l0 ? l0.m1.toFixed(2) : '?'}`);

const base = `http://127.0.0.1:${PORT}`;
const url = BOOT === 'menu0'
  ? `${base}/?menu=0&map=${MAP}&scenario=${SCENARIO}&autoplay=1&quality=${TIER}`
  : `${base}/?harness=1&autoplay=1&w=${W}&h=${H}&map=${MAP}&scenario=${SCENARIO}&quality=${TIER}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
console.log('url:', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });

if (HIDE_HUD) await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
if (ADAPTIVE === 'off') await page.evaluate(() => { window.__game.engine.adaptiveQuality.enabled = false; });
if (CAMERA) {
  const [x, z, zoom, yaw] = CAMERA.split(',').map(Number);
  await page.evaluate(([a, b, c, d]) => window.__game.setCamera(a, b, c, d), [x, z, zoom, yaw]);
}

// ---------------------------------------------------------------------------
// Instrumentation. `Engine.frame` is wrapped, never reimplemented.
// ---------------------------------------------------------------------------
const setup = await page.evaluate((deep) => {
  const e = window.__game.engine;
  const systems = e.systems;
  const names = systems.map((s) => s.name);
  const nS = names.length;
  const p = {
    deep, on: false, frames: [],
    sumFix: new Float64Array(nS), sumUpd: new Float64Array(nS), sumPre: new Float64Array(nS),
    names,
  };
  window.__ss = p;
  let accFix = 0, accUpd = 0, accPre = 0, accRnd = 0;
  const now = () => performance.now();
  if (deep) {
    systems.forEach((s, i) => {
      if (s.fixedUpdate) { const f = s.fixedUpdate.bind(s);
        s.fixedUpdate = (dt, ctx) => { if (!p.on) return f(dt, ctx); const t = now(); f(dt, ctx); const d = now() - t; accFix += d; p.sumFix[i] += d; }; }
      if (s.update) { const f = s.update.bind(s);
        s.update = (dt, ctx) => { if (!p.on) return f(dt, ctx); const t = now(); f(dt, ctx); const d = now() - t; accUpd += d; p.sumUpd[i] += d; }; }
      if (s.preRender) { const f = s.preRender.bind(s);
        s.preRender = (ctx) => { if (!p.on) return f(ctx); const t = now(); f(ctx); const d = now() - t; accPre += d; p.sumPre[i] += d; }; }
    });
  }
  // The real submit, saved so the fast-forward can be run without it and put back after.
  p.realRender = e.renderOverride ?? null;
  if (e.renderOverride) { const ro = e.renderOverride;
    e.renderOverride = (ctx) => { if (!p.on) return ro(ctx); const t = now(); ro(ctx); accRnd += now() - t; }; }
  else { const rr = e.renderer.render.bind(e.renderer);
    e.renderer.render = (sc, cam) => { if (!p.on) return rr(sc, cam); const t = now(); rr(sc, cam); accRnd += now() - t; }; }
  p.wrappedRender = e.renderOverride;

  const orig = e.frame.bind(e);
  p.origFrame = orig;
  e.frame = (nowMs) => {
    if (!p.on) { orig(nowMs); return; }
    accFix = accUpd = accPre = accRnd = 0;
    const t0 = now(); orig(nowMs); const t1 = now();
    const info = e.renderer.info;
    p.frames.push([t1 - t0, accFix, accUpd, accPre, accRnd, e.time.ticksThisFrame,
      e.time.simTime, info.render.calls, info.programs ? info.programs.length : -1, nowMs]);
  };

  window.__poolHash = () => {
    const pool = window.__game.battle.pool;
    const dv = new DataView(new ArrayBuffer(4));
    let h = 0x811c9dc5;
    const mix = (u) => { h ^= u & 0xff; h = (h * 0x01000193) >>> 0; h ^= (u >>> 8) & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0; h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0; };
    const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
    let alive = 0;
    for (let i = 0; i < pool.count; i++) { f(pool.x[i]); f(pool.z[i]); mix(pool.state[i]); f(pool.hp[i]);
      if (pool.state[i] !== 10 && pool.state[i] !== 11) alive++; }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: pool.count, alive };
  };

  window.__census = () => {
    const b = window.__game.battle, pool = b.pool;
    const byFac = {}, elevByFac = {};
    let alive = 0, elevated = 0, melee = 0;
    for (let i = 0; i < pool.count; i++) {
      if (!pool.aliveAt(i)) continue;
      alive++;
      const f = pool.faction[i];
      byFac[f] = (byFac[f] ?? 0) + 1;
      if (b.elevated[i]) { elevated++; elevByFac[f] = (elevByFac[f] ?? 0) + 1; }
      if (pool.target && pool.target[i] >= 0) melee++;
    }
    const proj = window.__game.engine.context.tryGet('projectiles');
    return { alive, elevated, byFac, elevByFac, melee, count: pool.count,
      strength: { ...b.strength },
      live: proj && proj.liveCount !== undefined ? proj.liveCount : null };
  };

  return { systems: names, tier: e.quality.tier, maxSoldiers: e.quality.maxSoldiers,
    dpr: e.renderer.getPixelRatio(), postfx: !!p.realRender };
}, DEEP);
console.log(`boot: tier=${setup.tier} maxSoldiers=${setup.maxSoldiers} dpr=${setup.dpr} postfx=${setup.postfx} systems=${setup.systems.length}`);

const st = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

/** One real-time measurement window at the current sim state. */
async function measure(seconds) {
  const raw = await page.evaluate(async (secs) => {
    const e = window.__game.engine, p = window.__ss;
    p.frames.length = 0; p.sumFix.fill(0); p.sumUpd.fill(0); p.sumPre.fill(0);
    const simA = e.time.simTime, wallA = performance.now();
    p.on = true;
    await new Promise((r) => setTimeout(r, secs * 1000));
    p.on = false;
    const simB = e.time.simTime, wallB = performance.now();
    return { frames: p.frames.slice(), sumFix: Array.from(p.sumFix), sumUpd: Array.from(p.sumUpd),
      sumPre: Array.from(p.sumPre), simA, simB, wallA, wallB,
      adaptive: e.adaptiveQuality.state ? e.adaptiveQuality.state() : null,
      renderScale: e.quality.renderScale, calls: e.renderer.info.render.calls };
  }, seconds);
  const f = raw.frames;
  const col = (k) => f.map((r) => r[k]);
  const ticks = col(5).reduce((a, b) => a + b, 0);
  const wallS = (raw.wallB - raw.wallA) / 1000;
  const sumOf = (k) => col(k).reduce((a, b) => a + b, 0);
  const per = setup.systems.map((n, i) => ({ name: n, fix: +raw.sumFix[i].toFixed(1), upd: +raw.sumUpd[i].toFixed(1), pre: +raw.sumPre[i].toFixed(1),
    fixPerTick: +(raw.sumFix[i] / Math.max(1, ticks)).toFixed(3) }))
    .filter((r) => r.fix + r.upd + r.pre > 0.5)
    .sort((a, b) => (b.fix + b.upd + b.pre) - (a.fix + a.upd + a.pre));
  return {
    simRate: +((raw.simB - raw.simA) / wallS).toFixed(3),
    wallS: +wallS.toFixed(2), simAdv: +(raw.simB - raw.simA).toFixed(2),
    frames: f.length, fps: +(f.length / wallS).toFixed(1), ticks,
    total: st(col(0)), fixed: st(col(1)), update: st(col(2)), pre: st(col(3)), render: st(col(4)),
    msPerTick: +(sumOf(1) / Math.max(1, ticks)).toFixed(2),
    share: { fixed: +(sumOf(1) / (raw.wallB - raw.wallA) * 100).toFixed(1),
      update: +(sumOf(2) / (raw.wallB - raw.wallA) * 100).toFixed(1),
      pre: +(sumOf(3) / (raw.wallB - raw.wallA) * 100).toFixed(1),
      render: +(sumOf(4) / (raw.wallB - raw.wallA) * 100).toFixed(1) },
    stepsHist: col(5).reduce((m, s) => (m[s] = (m[s] ?? 0) + 1, m), {}),
    calls: raw.calls, renderScale: +raw.renderScale.toFixed(3),
    adaptivePressure: raw.adaptive?.pressure ?? null,
    adaptiveP90: raw.adaptive?.p90 ?? null,
    per: per.slice(0, 12),
  };
}

const marks = [];
let prev = 0;
for (const at of AT) {
  if (at > prev) {
    const t0 = Date.now();
    // `{ render: false }` is the engine's own flag now, not this tool stubbing `renderOverride`
    // behind its back. Same effect, but the skip is inside `Engine.frame` where it is
    // documented and hash-tested, rather than a monkey-patch a future refactor would silently
    // defeat — leaving the fast-forward rendering again and this probe merely slow.
    await page.evaluate(
      ([secs, noRender]) => window.__game.engine.advance(secs, 1000 / 60, { render: !noRender }),
      [at - prev, FF_NORENDER]
    );
    console.log(`  ff ${prev} -> ${at}  (${((Date.now() - t0) / 1000).toFixed(1)}s wall${FF_NORENDER ? ', no submit' : ''})`);
    prev = at;
  }
  const census = await page.evaluate(() => window.__census());
  const hash = await page.evaluate(() => window.__poolHash());
  const m = await measure(WINDOW);
  const c2 = await page.evaluate(() => window.__census());
  marks.push({ at, census, hash, ...m });
  console.log(`t+${String(at).padStart(4)}  alive ${String(census.alive).padStart(5)}  onWall ${String(census.elevated).padStart(4)}`
    + `  simRate ${m.simRate.toFixed(3)}x  fps ${m.fps.toFixed(1)}`
    + `  total p50 ${m.total.p50} p90 ${m.total.p90}`
    + `  | fixed p50 ${m.fixed.p50} (${m.msPerTick} ms/tick, ${m.share.fixed}% of wall)`
    + `  render p50 ${m.render.p50} (${m.share.render}%)  upd ${m.update.p50}  pre ${m.pre.p50}`
    + `  calls ${m.calls}  scale ${m.renderScale}  press ${m.adaptivePressure}`);
  console.log('        top: ' + m.per.slice(0, 6).map((r) => `${r.name} fix ${r.fix}/upd ${r.upd}/pre ${r.pre}`).join('  '));
  console.log(`        hash ${hash.hash} count ${hash.count} steps ${JSON.stringify(m.stepsHist)}`);
}

const out = { label: LABEL, tree: TREE, load: { before: l0, after: load() }, url, setup, window: WINDOW, ffNoRender: FF_NORENDER, marks, errors };
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify(out, null, 1)); console.log('wrote ' + JSON_OUT); }
if (errors.length) console.log('ERRORS:\n' + errors.slice(0, 12).join('\n'));
await browser.close();
