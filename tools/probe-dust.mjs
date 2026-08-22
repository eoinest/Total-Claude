#!/usr/bin/env node
/**
 * Dust obscuration probe.
 *
 * The owner's complaint is "reduce the amount of dust kicked up, it is like making things
 * just plain hard to see". "Hard to see" is not a measurement, so this answers it with
 * three numbers per camera, all of them computed by ablating the particle layers at a
 * **paused instant** so the two arms are the identical world:
 *
 *   cover    % of frame pixels the dust changes by more than 2/255. Literally "how much
 *            of the picture has dust over it".
 *   veil     % of frame pixels the dust changes by more than 12/255 — the share that is
 *            not merely tinted but actually veiled.
 *   crowdLift  mean luminance change, in /255, over *soldier pixels only*. Positive means
 *            the dust is washing the crowd out toward the sky. The soldier mask is itself
 *            derived by ablation (crowd meshes hidden), so it is exact rather than a
 *            colour heuristic.
 *   crowdSd  standard deviation of luminance over the same mask, on and off. A veil
 *            compresses the crowd's contrast; this is the number that says by how much.
 *
 * Nothing here is a cross-session comparison. Every figure is a difference between two
 * renders of one frozen frame, and the A/B of a *tuning* change is driven by setting the
 * live emitter's public budget in the same page (`--ab`), never by shooting twice.
 *
 *   node tools/probe-dust.mjs --port=5417 --cams=assault,melee,rout
 *   node tools/probe-dust.mjs --port=5417 --curve          # accumulation over time
 *   node tools/probe-dust.mjs --port=5417 --attrib         # which emitter dominates
 *   node tools/probe-dust.mjs --port=5417 --ab             # interleaved before/after
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5417);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/dust');
const TAG = args.get('tag') ?? '';
const QUALITY = args.get('quality') ?? 'ultra';
const SCENARIO = args.get('scenario') ?? 'field';
const KEEP = args.has('keep');

/**
 * `assault: null` means the assault scenario's own boot framing, captured before anything
 * moves the rig — the same convention `probe-budget.mjs` uses, and the camera the 219-draw
 * figure was measured at.
 */
const CAMS = {
  assault: null,
  melee: { follow: 'contact', zoom: 0.30 },
  clash: { follow: 'contact', zoom: 0.30 },
  rout: { x: 0, z: 60, zoom: 0.60, yaw: Math.PI * 0.82 },
  aftermath: { follow: 'corpses', zoom: 0.34 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 },
};

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`source: ${base} (started by me, pid ${server.pid})`);
} else {
  console.log(`source: ${base} (already up)`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}&scenario=${SCENARIO}&nohud=1`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; visibility: hidden !important; }' });
console.log(`booted: ready=true, ${errors.length} error(s)`);

await mkdir(OUT, { recursive: true });

/*
 * Stop the rAF loop. `Time` scales the *sim* by `paused`, but `Engine.frame` drives the
 * camera rig from the unscaled `frameDt`, so a live rAF loop keeps damping the rig toward
 * its target through every wall-clock millisecond a screenshot takes. Measured with the
 * loop running: an A-vs-A "no change at all" pair differed by 35.0/255 at the clash camera,
 * which is larger than the dust signal this probe exists to find. With rAF stopped, every
 * frame is one explicit `advance` call and nothing at all happens between them.
 */
await page.evaluate(() => { window.__game.engine.stop(); });

CAMS.assault = await page.evaluate(() => {
  const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
});

// ---------------------------------------------------------------------------
// Page-side helpers
// ---------------------------------------------------------------------------

/** Re-render the frozen world. Paused, so `scaledDt` is 0 and nothing moves at all. */
const redraw = (n = 2) => page.evaluate((k) => {
  for (let i = 0; i < k; i++) window.__game.engine.advance(1e-6, 1e-3);
}, n);

const setPaused = (v) => page.evaluate((p) => { window.__game.engine.time.paused = p; }, v);

/** Run the sim forward. `advance(s, 166)` is exact and 4x cheaper than the 60 Hz default. */
const run = (secs) => page.evaluate(async (s) => {
  window.__game.engine.time.paused = false;
  if (s > 0.01) window.__game.engine.advance(s, 166);
}, secs);

/**
 * Run the last stretch at the real frame rate before measuring.
 *
 * `advance(s, 166)` is exact for the *simulation* and four times faster, but it is not
 * exact for the dust: `DustEmitter.budget.maxSpawnsPerFrame` is a cap per **frame**, so at
 * 166 ms steps it throttles emission to a sixth of what the same battle emits at 60 Hz.
 * Fast-forwarding to the shot therefore photographs a thinner cloud than a player sees.
 * SETTLE seconds at 16.7 ms is longer than every dust lifetime bar the clash billow, so the
 * field has re-equilibrated at the rate the game really runs at.
 */
const settle = (secs) => page.evaluate((s) => {
  window.__game.engine.time.paused = false;
  window.__game.engine.advance(s, 1000 / 60);
}, secs);

/**
 * Force a node's visibility, against a system that rewrites it.
 *
 * `UnitRenderSystem` assigns `mesh.visible` per LOD tier on *every* frame, so plain
 * `o.visible = false` is undone by the very redraw that is supposed to photograph it —
 * measured: hiding all thirteen crowd meshes moved the frame by 0.000/255 and produced an
 * empty soldier mask. Redefining the property makes the assignment a no-op.
 */
const forceHidden = (pattern, hidden) => page.evaluate(([re, hide]) => {
  const rx = new RegExp(re);
  const apply = (o) => {
    if (hide) {
      if (o.__forced) return;
      o.__forced = o.visible;
      Object.defineProperty(o, 'visible', { get: () => false, set: () => {}, configurable: true });
    } else if (o.__forced !== undefined) {
      Object.defineProperty(o, 'visible', { value: o.__forced, writable: true, configurable: true, enumerable: true });
      delete o.__forced;
    }
  };
  window.__game.engine.context.scene.traverse((o) => {
    if (rx.test(o.name || '')) apply(o);
  });
}, [pattern, hidden]);

/**
 * Kill every live particle.
 *
 * Between two arms of a tuning A/B the cloud has to be entirely the new arm's, and waiting
 * for the old one to age out costs a full maximum lifetime of extra battle drift — which is
 * the dominant error term here. Expiring the ring outright means the settle only has to
 * *build* the new field, not also drain the old one.
 */
const flushParticles = () => page.evaluate(() => {
  const ps = window.__game.engine.context.get('vfx').particles;
  for (const l of ps.layers) {
    l.expiry.fill(-1);
    for (let i = 0; i < l.cap; i++) l.aV.array[i * 4 + 3] = 1e-4;
    l.dirtyLo = 0; l.dirtyHi = l.cap - 1;
  }
});

const setParticles = (on) => forceHidden('^vfx-particles$', !on);
const setCrowd = (on) => forceHidden('^(soldiers|horses|engine)', !on);

const shot = (name) => page.screenshot({ path: path.join(OUT, `${TAG}${name}.png`) });

/** What the particle field actually contains, read straight off the instance buffers. */
const inventory = () => page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const vfx = ctx.get('vfx');
  const ps = vfx.particles;
  const L = ps.layers[0]; // soft layer
  const t = ps.time;
  const out = { live: 0, cap: L.cap, byTile: {}, alphaSum: 0, sizeSum: 0, areaSum: 0, lifeLeft: 0 };
  for (let i = 0; i < L.cap; i++) {
    if (L.expiry[i] <= t) continue;
    const o = i * 4;
    out.live++;
    const tile = L.aS.array[o + 3] % 16;
    const born = L.aP.array[o + 3];
    const life = L.aV.array[o + 3];
    const age = Math.max(0, Math.min(1, (t - born) / Math.max(life, 1e-3)));
    const grow = 1 - Math.pow(1 - age, 1.7);
    const size = L.aS.array[o] + (L.aS.array[o + 1] - L.aS.array[o]) * grow;
    const a = L.aC.array[o + 3] * Math.min(1, age / 0.1) * Math.pow(1 - age, 1.35);
    out.byTile[tile] = (out.byTile[tile] ?? 0) + 1;
    out.alphaSum += a;
    out.sizeSum += size;
    // Optical depth proxy: alpha x cross-section, in alpha.m^2. This is the quantity that
    // sets how much of the world a dust field hides, and it is the one to compare arms on.
    out.areaSum += a * Math.PI * (size * 0.5) * (size * 0.5);
    out.lifeLeft += life * (1 - age);
  }
  return {
    live: out.live, cap: out.cap, occupancy: +(out.live / out.cap).toFixed(3),
    meanAlpha: out.live ? +(out.alphaSum / out.live).toFixed(4) : 0,
    meanSize: out.live ? +(out.sizeSum / out.live).toFixed(2) : 0,
    opticalArea: +(out.areaSum).toFixed(0),
    byTile: out.byTile,
    spawnsPerFrame: vfx.stats().dustPerFrame,
  };
});

const drawCalls = () => page.evaluate(() => {
  const g = window.__game;
  const r = g.engine.context.renderer;
  g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  return r.info.render.calls;
});

// ---------------------------------------------------------------------------
// Image maths
// ---------------------------------------------------------------------------

const raw = (p) => sharp(p).raw().toBuffer({ resolveWithObject: true });
const lum = (b, c, i) => 0.2126 * b[i * c] + 0.7152 * b[i * c + 1] + 0.0722 * b[i * c + 2];

/**
 * `on` dust over `off` dust, with `crowdOff` supplying the soldier mask.
 *
 * Thresholds are applied at full resolution because the world is paused: the measured
 * A-vs-A noise floor is printed alongside every result and it is ~0, so a 2/255 threshold
 * is signal, not jitter.
 */
async function occlusion(onPng, offPng, crowdOffPng) {
  const [A, B, C] = await Promise.all([raw(onPng), raw(offPng), crowdOffPng ? raw(crowdOffPng) : null]);
  const n = A.info.width * A.info.height;
  const ca = A.info.channels, cb = B.info.channels;
  let cover = 0, veil = 0, sumA = 0, sumB = 0, darkA = 0, darkB = 0;
  let mask = 0, mA = 0, mB = 0, mA2 = 0, mB2 = 0, maskCover = 0;
  for (let i = 0; i < n; i++) {
    const a = lum(A.data, ca, i);
    const b = lum(B.data, cb, i);
    const d = Math.abs(a - b);
    sumA += a; sumB += b;
    // Share of the frame below 15 % luminance. Rome II's ten press plates measure 16-21 %;
    // the note that set the contact-dust rate used exactly this statistic, and a dust bank
    // that collapses it toward zero is a milky sheet rather than dust.
    if (a < 38.25) darkA++;
    if (b < 38.25) darkB++;
    if (d > 2) cover++;
    if (d > 12) veil++;
    if (C) {
      const c = lum(C.data, C.info.channels, i);
      if (Math.abs(b - c) > 3) {
        mask++; mA += a; mB += b; mA2 += a * a; mB2 += b * b;
        if (d > 2) maskCover++;
      }
    }
  }
  const sd = (s1, s2, k) => Math.sqrt(Math.max(0, s2 / k - (s1 / k) * (s1 / k)));
  return {
    cover: +((100 * cover) / n).toFixed(2),
    veil: +((100 * veil) / n).toFixed(2),
    dLum: +((sumA - sumB) / n).toFixed(2),
    dark15: +((100 * darkA) / n).toFixed(2),
    dark15Off: +((100 * darkB) / n).toFixed(2),
    crowdPx: +((100 * mask) / n).toFixed(2),
    crowdCover: mask ? +((100 * maskCover) / mask).toFixed(1) : 0,
    crowdLift: mask ? +((mA - mB) / mask).toFixed(2) : 0,
    crowdSdOn: mask ? +sd(mA, mA2, mask).toFixed(2) : 0,
    crowdSdOff: mask ? +sd(mB, mB2, mask).toFixed(2) : 0,
  };
}

/** Whole-frame mean absolute difference, for the noise floor and the restore check. */
async function mad(p, q) {
  const [A, B] = await Promise.all([raw(p), raw(q)]);
  const n = A.info.width * A.info.height;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(lum(A.data, A.info.channels, i) - lum(B.data, B.info.channels, i));
  return +(s / n).toFixed(3);
}

// ---------------------------------------------------------------------------
// One measurement point: four renders of one frozen instant
// ---------------------------------------------------------------------------

async function measure(label) {
  await setPaused(true);
  await redraw(2);
  const A = await shot(`${label}-dust`);
  await redraw(1);
  const A1 = await shot(`${label}-dust2`);
  await setParticles(false);
  await redraw(2);
  const B = await shot(`${label}-nodust`);
  await setCrowd(false);
  await redraw(2);
  const C = await shot(`${label}-bare`);
  await setCrowd(true);
  await setParticles(true);
  await redraw(2);
  const A2 = await shot(`${label}-restore`);

  const o = await occlusion(A, B, C);
  o.noise = await mad(A, A1);
  o.restore = await mad(A, A2);
  o.inv = await inventory();
  return o;
}

const fmt = (label, o) => `${label.padEnd(22)} cover ${String(o.cover).padStart(6)}%  veil ${String(o.veil).padStart(5)}%`
  + `  dLum ${String(o.dLum).padStart(6)}  crowdLift ${String(o.crowdLift).padStart(6)}`
  + `  crowdSd ${o.crowdSdOff}->${o.crowdSdOn}  dark15 ${o.dark15Off}->${o.dark15}%`
  + `  live ${o.inv.live} opt ${o.inv.opticalArea}`
  + `  [noise ${o.noise} restore ${o.restore}]`;

const results = {};
/** Seconds of 60 Hz running before a measurement, so the cloud is at its real density. */
const SETTLE60 = Number(args.get('settle60') ?? 7);
let simT = 0;
/** Fast-forward to `t` sim seconds, with the last SETTLE60 of it at the real frame rate. */
async function seek(t) {
  const fast = t - SETTLE60 - simT;
  if (fast > 0.01) await run(fast);
  await settle(Math.max(0.5, Math.min(SETTLE60, t - simT)));
  simT = Math.max(simT, t);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Park the camera. `follow` resolves against the live battle exactly as `shoot.mjs` does —
 * the densest 40 m cell of men in the state asked for, looking 55 deg off the axis between
 * the two armies. A hand-placed focus goes stale the moment the AI picks different ground,
 * and this probe must photograph the fight rather than the field beside it.
 */
const jump = (c) => page.evaluate(async (cam) => {
  const g = window.__game;
  let fx = cam.x ?? 0, fz = cam.z ?? 0, fyaw = cam.yaw ?? 0;
  if (cam.follow) {
    const p = g.battle.pool;
    const cells = new Map();
    const cx = [0, 0], cz = [0, 0], cn = [0, 0];
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      const f = p.faction[i];
      if (st !== 11 && st !== 10) { cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++; }
      const take = cam.follow === 'contact' ? st === 4 : (st === 11 || st === 10);
      if (!take) continue;
      const key = Math.floor((p.z[i] + 1400) / 40) * 128 + Math.floor((p.x[i] + 1400) / 40);
      const cell = cells.get(key);
      if (cell) { cell.x += p.x[i]; cell.z += p.z[i]; cell.n++; }
      else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
    }
    let best = null;
    for (const c of cells.values()) if (!best || c.n > best.n) best = c;
    if (best) { fx = best.x / best.n; fz = best.z / best.n; }
    if (cn[0] && cn[1]) {
      fyaw = Math.atan2(cx[1] / cn[1] - cx[0] / cn[0], cz[1] / cn[1] - cz[0] / cn[0]) + 0.96;
    }
  }
  g.setCamera(fx, fz, cam.zoom, fyaw);
  // 0.6 s at 60 Hz: the rig damps at rate 9, so a shorter settle photographs a camera
  // still travelling, and a travelling camera makes the A-vs-A noise floor larger than
  // the signal.
  g.engine.advance(0.6, 1000 / 60);
  return { x: +fx.toFixed(2), z: +fz.toFixed(2), yaw: +fyaw.toFixed(4), zoom: cam.zoom };
}, c);

/**
 * Pin a `follow` camera to the coordinates it first resolved to.
 *
 * An A/B whose arms are minutes of battle apart must not also re-aim between them: the
 * densest contact cell moves, and a camera that re-aims photographs a different fight of a
 * different size each arm. Measured unpinned, two *identical* legacy arms 84 s apart read
 * 49.8 % and 86.4 % cover — drift far larger than the change under test.
 */
const pinned = new Map();
async function aim(name, cam) {
  if (pinned.has(name)) return page.evaluate((c) => {
    window.__game.setCamera(c.x, c.z, c.zoom, c.yaw);
    window.__game.engine.advance(0.6, 1000 / 60);
    return c;
  }, pinned.get(name));
  const got = await jump(cam);
  if (cam.follow && args.has('pin')) pinned.set(name, got);
  return got;
}

if (args.has('curve')) {
  // How far into the battle the worst case is. One camera, the same frozen-instant
  // ablation at each sample, so every point is internally exact.
  const cam = CAMS[args.get('cam') ?? 'melee'] ?? CAMS.melee;
  const stops = String(args.get('stops') ?? '20,45,72,90,120,150,175').split(',').map(Number);
  console.log('\n=== accumulation curve ===');
  results.curve = [];
  for (const s of stops) {
    await seek(s);
    await aim('curve', cam);
    const o = await measure(`curve-t${s}`);
    console.log(fmt(`t+${s}s`, o));
    results.curve.push({ t: s, ...o });
  }
} else if (args.has('attrib')) {
  // Which emitter dominates. Each arm silences one source at runtime and lets the field
  // re-equilibrate for `settle` seconds — longer than the longest dust lifetime — then
  // measures the same frozen-instant ablation. Restores between arms and re-measures the
  // base arm last, as a drift check.
  const cam = CAMS[args.get('cam') ?? 'melee'] ?? CAMS.melee;
  const SETTLE = Number(args.get('settle') ?? 12);
  const AT = Number(args.get('at') ?? 90);
  await run(Math.max(0, AT - SETTLE));
  const silence = (which) => page.evaluate((w) => {
    const vfx = window.__game.engine.context.get('vfx');
    const dust = vfx.dust;
    const combat = vfx.combat;
    // Own properties shadow the prototype methods; deleting them restores the originals.
    delete dust.emitContactDust; delete dust.emitForUnit; delete combat.clash;
    if (w === 'contact') dust.emitContactDust = () => {};
    if (w === 'locomotion') dust.emitForUnit = () => {};
    if (w === 'clash') combat.clash = () => {};
    if (w === 'all') { dust.emitContactDust = () => {}; dust.emitForUnit = () => {}; combat.clash = () => {}; }
  }, which);
  console.log(`\n=== attribution at t+${AT}s, ${SETTLE}s settle per arm ===`);
  results.attrib = [];
  for (const arm of ['base', 'contact', 'locomotion', 'clash', 'all', 'base2']) {
    await silence(arm === 'base' || arm === 'base2' ? 'none' : arm);
    await settle(SETTLE);
    await aim('attrib', cam);
    const o = await measure(`attrib-${arm}`);
    console.log(fmt(arm === 'base2' ? 'base (drift check)' : `silence ${arm}`, o));
    results.attrib.push({ arm, ...o });
  }
} else if (args.has('ab') || args.has('sweep')) {
  /*
   * The tuning A/B, interleaved inside one page.
   *
   * Arm A restores the tree's previous behaviour exactly — a ring-relative optical ceiling
   * (0.78 x the soft ring), no opacity multiplier and the self-shadow term zeroed by
   * patching the fragment shader's two coefficients — so both arms are the same seed, the
   * same battle and the same session. A cross-session before/after is not a measurement on
   * this project: two runs at identical configuration differ on 50-70 % of pixels because
   * the VFX reseed, and dust is the reason.
   */
  const cams = String(args.get('cams') ?? 'melee,clash,rout').split(',');
  const SETTLE = Number(args.get('settle') ?? 12);
  const AT = Number(args.get('at') ?? 88);
  const setArm = (a) => page.evaluate(([legacy, ceil, opac]) => {
    const vfx = window.__game.engine.context.get('vfx');
    const ps = vfx.particles;
    if (window.__shipped === undefined) {
      window.__shipped = { ...vfx.dust.budget };
      window.__frag = ps.layers[0].mat.fragmentShader;
    }
    vfx.dust.budget.liveCeiling = ceil ?? (legacy ? ps.softCapacity * 0.78 : window.__shipped.liveCeiling);
    vfx.dust.budget.opacity = opac ?? (legacy ? 1 : window.__shipped.opacity);
    const mat = ps.layers[0].mat;
    const want = legacy
      ? window.__frag.replace('0.30 * buried', '0.0 * buried').replace('0.62 * buried', '0.0 * buried')
      : window.__frag;
    if (mat.fragmentShader !== want) { mat.fragmentShader = want; mat.needsUpdate = true; }
    return { ceiling: Math.round(vfx.dust.budget.liveCeiling), opacity: vfx.dust.budget.opacity, selfShadow: !legacy };
  }, a);
  await run(Math.max(0, AT - SETTLE));
  const arms = args.has('sweep')
    ? String(args.get('sweep') === 'true' ? 'legacy,17160/0.72,8000/0.72,5200/0.72,5200/0.55,3600/0.72,legacy' : args.get('sweep')).split(',')
    : ['A', 'B', 'A2', 'B2'];
  console.log(`\n=== interleaved arms at t+${AT}s, ${SETTLE}s settle each ===`);
  results.ab = [];
  let armIx = 0;
  for (const arm of arms) {
    armIx++;
    const legacy = arm === 'legacy' || arm[0] === 'A';
    const m = arm.match(/^(\d+)\/([\d.]+)$/);
    const cfg = await setArm([legacy, m ? Number(m[1]) : null, m ? Number(m[2]) : null]);
    await flushParticles();
    await settle(SETTLE);
    for (const name of cams) {
      const c = CAMS[name];
      if (!c) continue;
      await aim(name, c);
      const o = await measure(`ab${armIx}-${arm.replace('/', '_')}-${name}`);
      o.draws = await drawCalls();
      console.log(fmt(`${arm} ${name}`, o) + `  draws ${o.draws}`);
      results.ab.push({ arm, cam: name, cfg, ...o });
    }
  }
} else if (args.has('selfshadow')) {
  /*
   * The self-shadow term on its own, at a *frozen instant*.
   *
   * It changes only how the existing billboards are shaded, so unlike an emission change it
   * needs no settle and no re-equilibration: patch the fragment shader, recompile, re-render
   * the identical world. That makes this the one arm in this probe with no drift term at all.
   */
  const cams = String(args.get('cams') ?? 'melee,rout').split(',');
  const setShade = (on) => page.evaluate((v) => {
    const mat = window.__game.engine.context.get('vfx').particles.layers[0].mat;
    if (window.__frag === undefined) window.__frag = mat.fragmentShader;
    const want = v ? window.__frag
      : window.__frag.replace('0.30 * buried', '0.0 * buried').replace('0.62 * buried', '0.0 * buried');
    if (mat.fragmentShader !== want) { mat.fragmentShader = want; mat.needsUpdate = true; }
  }, on);
  console.log('\n=== self-shadow term, same frozen instant ===');
  results.selfShadow = [];
  for (const name of cams) {
    const c = CAMS[name];
    if (!c) continue;
    await seek(name === 'rout' ? 171 : 88);
    await aim(name, c);
    await setShade(false);
    const off = await measure(`ss-${name}-flat`);
    await setShade(true);
    const on = await measure(`ss-${name}-shaded`);
    const d = await mad(path.join(OUT, `${TAG}ss-${name}-flat-dust.png`), path.join(OUT, `${TAG}ss-${name}-shaded-dust.png`));
    console.log(fmt(`${name} flat  `, off));
    console.log(fmt(`${name} shaded`, on));
    console.log(`  whole-frame |delta| between the two shadings: ${d}/255`);
    results.selfShadow.push({ cam: name, off, on, mad: d });
  }
} else {
  const cams = String(args.get('cams') ?? 'assault,melee,rout').split(',');
  const AT = Number(args.get('at') ?? 0);
  console.log('\n=== obscuration by camera ===');
  results.cams = [];
  for (const name of cams) {
    const c = CAMS[name];
    if (!c) { console.error(`unknown camera ${name}`); continue; }
    const at = AT || (name === 'rout' ? 171 : name === 'melee' ? 88 : name === 'aftermath' ? 190 : 72);
    await seek(at);
    await aim(name, c);
    const o = await measure(name);
    o.draws = await drawCalls();
    console.log(fmt(name, o) + `  draws ${o.draws}`);
    console.log(`    tiles ${JSON.stringify(o.inv.byTile)} meanAlpha ${o.inv.meanAlpha} meanSize ${o.inv.meanSize}m spawns/frame ${o.inv.spawnsPerFrame}`);
    results.cams.push({ cam: name, at, ...o });
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 8)) console.log('   ' + e);
}

await writeFile(path.join(OUT, `${TAG || 'dust'}-report.json`), JSON.stringify(results, null, 2));
await browser.close();
if (server && !KEEP) server.kill('SIGTERM');
console.log(`\nwrote ${path.join(OUT, `${TAG || 'dust'}-report.json`)}`);
