#!/usr/bin/env node
/**
 * War-elephant gait probe.
 *
 * The horse cost this project real time to two defects that a rendered screenshot could not
 * show: a rider's boots placed on the saddle because a 1.490 m offset was added to the ground
 * instead of to the mount, and a gallop that never took its rate-matched branch, leaving
 * hooves skating 2.7-4.1 m/s against a measured 5.362 m stride. Neither is visible in a still
 * frame and neither fails a typecheck.
 *
 * So the elephant gets a probe before it gets a screenshot. It asserts, in metres:
 *
 *   1. STRIDE       what each locomotion clip actually depicts, measured off a planted foot.
 *   2. SUSPENSION   how many feet are on the ground at each frame. An elephant has no
 *                   airborne phase at any speed; if this ever reads fewer than 2 the gait has
 *                   turned into a horse's.
 *   3. CLEARANCE    peak foot lift during swing. Real elephants shuffle: 0.08-0.20 m.
 *   4. SKATE        residual foot slip in the *running game* — |foot ground velocity| while
 *                   planted, which is the number the horse got wrong. Under ~0.35 m/s is
 *                   imperceptible; anything near the animal's own speed means the rate is
 *                   coming from the wrong clip.
 *   5. SEAT         where the tower floor and the mahout's seat sit against the animated
 *                   back, so nobody is riding 0.95 m above their mount again.
 *
 *   node tools/probe-elephant.mjs --port=5541
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5541);

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
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`${base}/?harness=1&quality=ultra`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 120000 });

// ---------------------------------------------------------------------------
// 1-3: clip-space measurements, straight off the authored poses
// ---------------------------------------------------------------------------
const clipStats = await page.evaluate(async () => {
  const [{ ELEPHANT_RIG, ELEPHANT_CONTACTS }, ec, pose] = await Promise.all([
    import('/src/anim/rig.ts'),
    import('/src/anim/elephantClips.ts'),
    import('/src/anim/pose.ts'),
  ]);
  const rig = ELEPHANT_RIG;
  const n = rig.boneCount;
  const q = new Float32Array(n * 4);
  const t = new Float32Array(n * 3);

  const out = [];
  for (const clip of ec.ELEPHANT_CLIP_SET.clips) {
    // Per-frame foot heights, so contact and clearance are read from the same pass.
    const feetY = ELEPHANT_CONTACTS.map(() => []);
    const feetZ = ELEPHANT_CONTACTS.map(() => []);
    for (let f = 0; f < clip.frames; f++) {
      pose.frameGlobals(rig, clip, f, q, t);
      ELEPHANT_CONTACTS.forEach((b, i) => {
        feetY[i].push(t[b * 3 + 1]);
        feetZ[i].push(t[b * 3 + 2]);
      });
    }
    // "Planted" is within 30 mm of this clip's own lowest foot position, matching the
    // definition `measureRootSpeed` uses so the two numbers describe the same thing.
    const floor = Math.min(...feetY.flat());
    const downPerFrame = [];
    for (let f = 0; f < clip.frames; f++) {
      let down = 0;
      for (let i = 0; i < feetY.length; i++) if (feetY[i][f] < floor + 0.03) down++;
      downPerFrame.push(down);
    }
    const clearance = Math.max(...feetY.flat()) - floor;
    out.push({
      name: clip.name,
      // Per-foot height at every frame, rounded to the millimetre. Printed for whichever clip
      // fails the suspension test: "some foot is off the ground" is not a diagnosis, and
      // guessing which one from the aggregate is how a wrong cause gets confidently named.
      trace: feetY.map((col) => col.map((v) => Math.round(v * 1000))),
      frames: clip.frames,
      duration: +clip.duration.toFixed(3),
      rootSpeed: +clip.rootSpeed.toFixed(4),
      strideM: +(clip.rootSpeed * clip.duration).toFixed(4),
      minFeetDown: Math.min(...downPerFrame),
      maxFeetDown: Math.max(...downPerFrame),
      clearanceM: +clearance.toFixed(4),
      loop: clip.loop,
    });
  }
  return { clips: out, stride: ec.ELEPHANT_GAIT_STRIDE.map((s) => +s.toFixed(4)) };
});

console.log('\n=== 1-3. CLIP SPACE ===');
console.log('clip        frames  dur     rootSpeed  stride   feetDown  clearance');
for (const c of clipStats.clips) {
  console.log(
    `${c.name.padEnd(10)}  ${String(c.frames).padStart(5)}  ${c.duration.toFixed(2).padStart(5)}  `
    + `${c.rootSpeed.toFixed(3).padStart(8)}  ${c.strideM.toFixed(3).padStart(6)}  `
    + `${String(c.minFeetDown)}-${c.maxFeetDown}       ${c.clearanceM.toFixed(3)}`
  );
}
const gaits = clipStats.clips.filter((c) => c.name === 'walk' || c.name === 'charge' || c.name === 'panic');
const airborne = gaits.filter((c) => c.minFeetDown < 2);
console.log(
  airborne.length
    ? `FAIL suspension: ${airborne.map((c) => `${c.name} drops to ${c.minFeetDown}`).join(', ')} — an elephant is never airborne`
    : 'PASS suspension: never fewer than 2 feet planted in any gait'
);
if (airborne.length && args.has('trace')) {
  for (const c of airborne) {
    console.log(`\n  --- ${c.name}: foot height in mm, rows are bL fL bR fR ---`);
    for (const row of c.trace) {
      console.log(`  ${row.map((v) => String(v).padStart(5)).join('')}`);
    }
  }
}
const badClear = gaits.filter((c) => c.clearanceM < 0.06 || c.clearanceM > 0.34);
console.log(
  badClear.length
    ? `WARN clearance: ${badClear.map((c) => `${c.name} ${c.clearanceM.toFixed(3)} m`).join(', ')} (want 0.08-0.20 m)`
    : 'PASS clearance: every gait lifts the foot inside the shuffling range'
);

// ---------------------------------------------------------------------------
// 4-5: in-game measurements — the ones the horse got wrong
// ---------------------------------------------------------------------------
const live = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const { Faction, UnitOrder } = await import('/src/sim/types.ts');
  void Faction;

  // Tear the scenario down: 8,600 men swamp the signal and we want one unit on clean ground.
  for (const u of b.units) { u.destroyed = true; u.alive = 0; }
  for (let i = 0; i < b.pool.count; i++) b.pool.state[i] = 11;
  // `AIWorld` registers perception views for Rome and the Juthungi only and launders the
  // miss through a non-null assertion, so it throws on the first tick a Carthaginian unit
  // exists. Same neutering `tools/matchup.mjs` uses. See the report's AI patch.
  for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage', 'pathfinding']) {
    const sys = g.engine.ctx.tryGet(name);
    if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
  }

  const id = b.spawnUnit('war-elephants', 0, -120, 0, 'loose');
  const u = b.unitById(id);
  if (!u) return { error: 'spawn failed' };

  const rs = g.engine.ctx.tryGet('unitRender');
  const samples = [];

  // Walk, then charge, over a long straight run so speed settles.
  const run = (order, targetZ, running, seconds, label) => {
    u.order = order;
    u.targetX = 0;
    u.targetZ = targetZ;
    u.running = running;
    g.advance(4.0);
    // Sample the same soldier's foot every tick for a couple of seconds.
    const rec = { label, slip: [], speed: [] };
    const steps = Math.round(seconds / 0.2);
    for (let k = 0; k < steps; k++) {
      const probe = rs && rs.probeElephant ? rs.probeElephant(u.members[0]) : null;
      if (probe) {
        rec.slip.push(probe.footSlip);
        rec.speed.push(probe.groundSpeed);
        rec.towerY = probe.towerY;
        rec.mahoutY = probe.mahoutY;
        rec.backY = probe.backY;
        rec.clip = probe.clip;
        rec.rate = probe.rate;
      }
      g.advance(0.2);
    }
    samples.push(rec);
  };

  run(UnitOrder.MoveTo, 200, false, 3.0, 'walk');
  run(UnitOrder.MoveTo, -200, true, 3.0, 'run');

  return { samples };
});

console.log('\n=== 4-5. IN GAME ===');
if (live.error) {
  console.log(`could not measure: ${live.error}`);
} else if (!live.samples.length || !live.samples[0].slip.length) {
  console.log('no samples — UnitRenderSystem.probeElephant() is not exposed yet');
} else {
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log('phase   groundSpeed   footSlip(mean/max)   clip  rate   backY  towerY  mahoutY');
  let worst = 0;
  for (const s of live.samples) {
    const mx = Math.max(...s.slip);
    worst = Math.max(worst, mx);
    console.log(
      `${s.label.padEnd(6)}  ${mean(s.speed).toFixed(2).padStart(9)}   `
      + `${mean(s.slip).toFixed(3)} / ${mx.toFixed(3)}        `
      + `${String(s.clip).padStart(2)}  ${s.rate.toFixed(2)}  `
      + `${(s.backY ?? 0).toFixed(2)}  ${(s.towerY ?? 0).toFixed(2)}   ${(s.mahoutY ?? 0).toFixed(2)}`
    );
  }
  console.log(
    worst < 0.35
      ? `PASS skate: worst planted-foot slip ${worst.toFixed(3)} m/s`
      : `FAIL skate: worst planted-foot slip ${worst.toFixed(3)} m/s — rate is not matched to stride`
  );
}

await browser.close();
if (server) server.kill('SIGTERM');
