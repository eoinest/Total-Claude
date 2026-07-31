#!/usr/bin/env node
/**
 * Controlled A/B frame timing, in one session.
 *
 * Absolute frame time is not measurable on this machine while other agents are working:
 * two workstreams measured the `clash` camera at 21.78 ms and 9.14 ms on identical code in
 * consecutive runs, a 2.4x spread. So this never reports a lone number. It parks one camera
 * at one sim time, then rotates configurations A/B/C/A/B/C inside a single browser session
 * and reports each configuration's median together with its delta from the first, so
 * contention that drifts over the run hits every arm equally.
 *
 *   node tools/probe-perf-ab.mjs --port=5394 --shots=clash,melee --configs=base,nocontact
 *
 * `--dt` chooses the clock policy, and it matters more than anything else this probe does.
 * shoot.mjs drives `engine.frame(elapsed*1000 + 16.7)`, which recomputes the timestamp from
 * the clock it just advanced, making `frameDt` a fixed point: every frame reproduces the
 * previous frame's delta. Whichever value the loop is entered with is held for all thirty
 * frames, and that is decided by whether synthetic `elapsed` has outrun `performance.now()`.
 * Reaching t+78s costs 78 s of `elapsed` but far less wall clock on an idle machine, so
 * `elapsed` wins, the delta is large and positive, and it pins at the 0.25 s clamp — five
 * fixed sim steps per rendered frame. Under contention the wall clock wins and it pins at 0
 * instead. Measured at `melee`: 22.68 ms with the five steps, 8.64 ms with the same clock and
 * the steps suppressed, 9.37 ms at a true 1/60 s frame. The harness therefore reports a worse
 * number the *faster* the machine is, and its figure is not render cost. Use `--dt=play`.
 *
 * A `readPixels` on either side of the block drains the queue so it cannot degenerate into a
 * measurement of command submission.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Cameras. The combat shots are `follow:`-framed in shoot.mjs, so their focus is an
 * emergent property of where the AI chose to fight; these are the points that harness
 * actually resolved at 1920x1080, read back out of its own report.json. Pinning them keeps
 * an A/B on the identical frame instead of re-resolving it per run.
 */
const SHOTS = {
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92, at: 78 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79, at: 94 },
  rout: { x: 0, z: 60, zoom: 0.60, yaw: 2.58, at: 177 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72, at: 2 },
  cavalry: { x: 306, z: -15, zoom: 0.30, yaw: 7.44, at: 70 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42, at: 2 },
  aftermath: { x: 153, z: 12, zoom: 0.34, yaw: -1.52, at: 196 },
};

/**
 * Each arm sets *every* knob it knows about, never a delta, so rotating through them in any
 * order lands in the same state every time. `tc` is a small accessor installed on the page.
 */
const CONFIGS = {
  base: 'tc.post(1); tc.contact(1); tc.soft(1); tc.shadowRender(1);',
  nocontact: 'tc.post(1); tc.contact(0); tc.soft(1); tc.shadowRender(1);',
  nosoft: 'tc.post(1); tc.contact(1); tc.soft(0); tc.shadowRender(1);',
  neither: 'tc.post(1); tc.contact(0); tc.soft(0); tc.shadowRender(1);',
  nopost: 'tc.post(0); tc.contact(1); tc.soft(1); tc.shadowRender(1);',
  // Kept, but read with care and never mixed into a shading A/B: dropping `castShadow`
  // collapses UnitRenderSystem's shadow instance set, and it does not repopulate within one
  // frame, so an arm that follows this one measures a frame with 6 M fewer triangles in it.
  noshadowrender: 'tc.post(1); tc.contact(1); tc.soft(1); tc.shadowRender(0);',
};

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5394);
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
/** Frames per measurement block. */
const FRAMES = Number(args.get('frames') ?? 40);
/** Rotations through the whole configuration list. Median over blocks. */
const BLOCKS = Number(args.get('blocks') ?? 3);
const requested = args.get('shots') ? String(args.get('shots')).split(',') : ['clash', 'melee'];
const LIST_GROUPS = args.has('list-groups');
const arms = args.get('configs') ? String(args.get('configs')).split(',') : ['base', 'nocontact'];

/**
 * `hide:<regex>` is an arm that switches off every top-level scene child whose name matches,
 * which attributes frame time to a subsystem's geometry without editing that subsystem.
 */
const armSource = (a) => (a.startsWith('hide:')
  ? `tc.post(1); tc.contact(1); tc.soft(1); tc.shadowRender(1); tc.show(); tc.hide(${JSON.stringify(a.slice(5))});`
  : `${CONFIGS[a]} tc.show();`);
for (const a of arms) if (!a.startsWith('hide:') && !CONFIGS[a]) throw new Error(`unknown config ${a}`);

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

/** The knobs the arms above drive, installed once. */
await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const postfx = ctx.tryGet('postfx');
  const lighting = ctx.tryGet('lighting');
  window.tc = {
    post: (on) => { postfx.enabled = !!on; },
    contact: (on) => { postfx.contactShadows = !!on; },
    // `softShadows` is a real quality switch on LightingSystem, not test scaffolding: it
    // flips a define on every patched material, so the arm measures the compiled cost of the
    // blocker search rather than a branch the compiler still has to allocate registers for.
    soft: (on) => { if (lighting && 'softShadows' in lighting) lighting.softShadows = !!on; },
    // Suppresses the shadow-map *render* (the cascade re-draws) while leaving every
    // material still sampling the map, which separates geometry cost from filter cost.
    shadowRender: (on) => {
      ctx.scene.traverse((o) => {
        if (o.isDirectionalLight && o.shadow) o.castShadow = !!on && o.userData.tcWasCaster !== false;
      });
    },
  };
  // Remember which lights were casters to begin with, so restoring cannot promote one.
  ctx.scene.traverse((o) => {
    if (o.isDirectionalLight) o.userData.tcWasCaster = o.castShadow;
  });
  // Same for visibility: `show()` must restore what was there, never reveal something the
  // subsystem itself had hidden (culled LOD tiers, off-screen chunks, the debug overlays).
  for (const c of ctx.scene.children) c.userData.tcWasVisible = c.visible;
  window.tc.hide = (pattern) => {
    const re = new RegExp(pattern, 'i');
    for (const c of ctx.scene.children) {
      if (re.test(c.name || c.type)) c.visible = false;
    }
  };
  window.tc.show = () => {
    for (const c of ctx.scene.children) c.visible = c.userData.tcWasVisible !== false;
  };
  window.tc.groups = () => ctx.scene.children.map((c) => {
    let tris = 0;
    let meshes = 0;
    c.traverse((o) => {
      const g = o.geometry;
      if (!g || !o.visible) return;
      meshes += 1;
      const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
      // Instancing arrives two ways here — `InstancedMesh.count` for soldiers and city, and
      // `InstancedBufferGeometry.instanceCount` for the grass and vegetation fields. Reading
      // only the first reported every grass field as zero triangles.
      const inst = o.isInstancedMesh ? o.count : (g.instanceCount ?? 1);
      tris += (n / 3) * (Number.isFinite(inst) ? inst : 1);
    });
    return { name: c.name || `<${c.type}>`, type: c.type, visible: c.visible, meshes, tris };
  });
});

if (LIST_GROUPS) {
  const gs = await page.evaluate(() => window.tc.groups());
  gs.sort((a, b) => b.tris - a.tris);
  console.log('top-level scene children, by unique triangles:');
  for (const g of gs) {
    console.log(`  ${String(g.name).padEnd(26)} ${g.type.padEnd(16)} vis=${g.visible ? 1 : 0}`
      + ` meshes=${String(g.meshes).padStart(5)}  ${(g.tris / 1e6).toFixed(3)}M`);
  }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/**
 * Time `n` frames under an explicit clock policy.
 *
 * `Time.beginFrame` derives `frameDt` from `nowMs - lastNow` and clamps it to [0, 0.25].
 * shoot.mjs drives it with `frame(time.elapsed * 1000 + 16.7)`, which recomputes `nowMs`
 * from the clock it just advanced — so `frameDt` is a *fixed point*: each frame reproduces
 * the previous frame's delta exactly. Whatever value the loop is entered with is the value
 * it holds for all thirty frames, and that entry value is decided by whether the synthetic
 * `elapsed` is ahead of or behind `performance.now()` when the loop starts. Advancing to
 * t+78s takes far less than 78 s of wall clock on an idle machine, so `elapsed` runs ahead,
 * the delta is large and positive, and it pins at the 0.25 clamp — five fixed sim steps per
 * rendered frame, the `maxStepsPerFrame` cap. On a loaded machine the wall clock catches up,
 * the delta goes negative, and it pins at 0 instead: no sim at all. Same code, same camera,
 * two entirely different measurements.
 *
 *   frozen  — paused, so `scaledDt` is 0 and no fixed step runs. Render cost, honestly.
 *   play    — 1/60 s per frame unpaused: what the machine actually has to do at 60 fps.
 *   harness — reproduce shoot.mjs, including whichever fixed point it lands on.
 */
const MODE = args.get('dt') ?? 'frozen';
const timeBlock = (n) => page.evaluate(async ({ frames, mode }) => {
  const g = window.__game;
  const time = g.engine.time;
  const gl = g.engine.renderer.getContext();
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const wasPaused = time.paused;
  const wasMaxSteps = time.maxStepsPerFrame;
  // `harness-nosim` holds everything about the harness clock except the fixed step, which
  // splits its inflated figure into "simulation ticks" and "a quarter second of visual
  // update per rendered frame".
  if (mode === 'harness-nosim') time.maxStepsPerFrame = 0;
  // Exactly the sequence proposed as the shoot.mjs fix, so it is verified rather than
  // asserted: `resync()` is the public way to drop `lastNow`, after which an explicit
  // 1/60 s clock of our own settles the fixed point at a real 60 fps frame.
  if (mode === 'play-resync') time.resync();
  if (mode !== 'harness' && mode !== 'harness-nosim' && mode !== 'play-resync') {
    time.paused = mode === 'frozen';
    // `lastNow` is private only to TypeScript. Seeding it puts the fixed point at 1/60 s
    // instead of leaving it to whichever way the two clocks happen to be leaning.
    time.lastNow = time.elapsed;
  }

  let clock = time.elapsed * 1000;
  const step = () => {
    if (mode.startsWith('harness')) g.engine.frame(time.elapsed * 1000 + 16.7);
    else if (mode === 'play-resync') { clock += 1000 / 60; g.engine.frame(clock); }
    else g.engine.frame((time.elapsed + 1 / 60) * 1000);
  };

  // Two warm frames: a define flip recompiles on first use, and that must not be timed.
  step();
  step();
  sync();
  const t0 = performance.now();
  let ticks = 0;
  for (let i = 0; i < frames; i++) { step(); ticks += time.ticksThisFrame; }
  sync();
  const ms = (performance.now() - t0) / frames;
  const out = { ms, frameDt: time.frameDt, ticksPerFrame: ticks / frames };
  time.paused = wasPaused;
  time.maxStepsPerFrame = wasMaxSteps;
  return out;
}, { frames: n, mode: MODE });

/**
 * `--drift`: hold one camera and one frozen frame and report cost and geometry as a function
 * of how long it has been held. Written because an A/B at this camera kept moving under the
 * probe — the same nominal frame reported 21.46 M triangles in one run and 14.15 M in the
 * next, and frame time tracked it — so before any arm can be believed the frame itself has
 * to be shown to be stationary.
 */
async function drift(name) {
  const s = SHOTS[name];
  await page.evaluate(async (c) => { window.__game.advance(c.at); }, s);
  await page.evaluate((c) => { window.__game.setCamera(c.x, c.z, c.zoom, c.yaw); }, s);
  console.log(`\n=== drift at ${name} (t+${s.at}s) — one frozen frame, held ===`);
  console.log('  frames    ms/f  draws     tris   elapsed   simT  orbitR   instanced counts');
  let total = 0;
  for (let chunk = 0; chunk < 20; chunk++) {
    const r = await page.evaluate(async (frames) => {
      const g = window.__game;
      const gl = g.engine.renderer.getContext();
      const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      sync();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
      sync();
      const ms = (performance.now() - t0) / frames;
      const ctx = g.engine.context;
      const info = ctx.renderer.info;
      // Every InstancedMesh that is currently drawing something, so a collapse can be
      // pinned on a specific tier rather than inferred from the total.
      const counts = [];
      ctx.scene.traverse((o) => {
        if (o.isInstancedMesh && o.visible && o.count > 0) counts.push(`${o.name || o.parent?.name || '?'}:${o.count}`);
      });
      return {
        ms,
        draws: info.render.calls,
        tris: info.render.triangles,
        elapsed: g.engine.time.elapsed,
        simT: g.simTime(),
        orbitR: ctx.rig.orbitRadius,
        counts: counts.join(' '),
      };
    }, 40);
    total += 40;
    console.log(`  ${String(total).padStart(6)}  ${r.ms.toFixed(2).padStart(6)}  ${String(r.draws).padStart(5)}`
      + `  ${(r.tris / 1e6).toFixed(2).padStart(6)}M  ${r.elapsed.toFixed(2).padStart(7)}`
      + `  ${r.simT.toFixed(1).padStart(6)}  ${r.orbitR.toFixed(1).padStart(6)}  ${r.counts}`);
  }
}

if (args.has('drift')) {
  for (const n of requested) await drift(n);
  await browser.close();
  if (server) server.kill('SIGTERM');
  process.exit(0);
}

console.log(`# ${W}x${H} ultra, ${FRAMES} frames x ${BLOCKS} blocks, arms: ${arms.join(' ')}`);

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
  // Let camera smoothing, LOD hysteresis and TAA settle on the synthetic clock.
  await page.evaluate(() => { window.__game.engine.advance(0.25); });

  const samples = arms.map(() => []);
  for (let b = 0; b < BLOCKS; b++) {
    // Reverse on alternate blocks. The frame is reliably fastest late in a run — driver
    // warm-up, not code — so a fixed arm order silently taxes whichever arm always goes
    // first, which in the first version of this probe was the shipping configuration.
    const order = b % 2 ? [...arms.keys()].reverse() : [...arms.keys()];
    for (const i of order) {
      await page.evaluate((src) => { new Function('tc', src)(window.tc); }, armSource(arms[i]));
      samples[i].push(await timeBlock(FRAMES));
    }
  }
  await page.evaluate((src) => { new Function('tc', src)(window.tc); }, armSource('base'));
  const info = await page.evaluate(() => {
    const r = window.__game.engine.context.renderer;
    window.__game.engine.frame(window.__game.engine.time.elapsed * 1000 + 16.7);
    return { draws: r.info.render.calls, tris: r.info.render.triangles };
  });

  const meds = samples.map((a) => median(a.map((r) => r.ms)));
  const last = samples[0][samples[0].length - 1];
  console.log(`\n=== ${name} (t+${s.at}s, ${info.draws} draws, ${(info.tris / 1e6).toFixed(2)}M tris,`
    + ` dt=${MODE} frameDt=${last.frameDt.toFixed(4)}s ticks/frame=${last.ticksPerFrame.toFixed(2)}) ===`);
  for (const [i, arm] of arms.entries()) {
    const d = meds[i] - meds[0];
    const tag = i === 0 ? '' : `   ${d >= 0 ? '+' : ''}${d.toFixed(2)} ms vs ${arms[0]}`;
    console.log(`  ${arm.padEnd(15)} median ${meds[i].toFixed(2)} ms  (${(1000 / meds[i]).toFixed(0)} fps)`
      + `  blocks [${samples[i].map((r) => r.ms.toFixed(2)).join(', ')}]${tag}`);
  }
}

await browser.close();
if (server) server.kill('SIGTERM');
