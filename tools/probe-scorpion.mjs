#!/usr/bin/env node
/**
 * Scorpion battery probe.
 *
 * `tools/shoot.mjs` has no camera anywhere near the artillery — the Roman line shots frame
 * the front rank and the establishing shot is 130 m in front of the battery, so nothing in
 * the standard pass ever photographs it. This parks the camera on the scorpion battery at
 * several ranges and yaws and writes PNGs, and prints the numbers a still cannot answer:
 * where the crew actually stand relative to their engine, what the engine mesh's world
 * bounding box is, and how the battery's draw phases are distributed (a battery that
 * winches in lockstep is the artillery version of the marching-lockstep bug).
 *
 *   node tools/probe-scorpion.mjs --port=5251 --out=screenshots/scorp
 *   node tools/probe-scorpion.mjs --port=5251 --at=40 --only=battery
 *
 * Shots, all framed on the live battery centroid so they cannot go stale if the scenario
 * moves the guns:
 *
 *   battery    behind the line at a shallow angle — the whole battery in one frame
 *   engine     close on one engine, three-quarter front — the silhouette test
 *   crewwork   low and close behind a gun, crew serving it
 *   overwatch  high oblique with the battery in the foreground and the battle beyond
 *   downrange  from in front of the battery looking back at the muzzles
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5251);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/scorp');
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const AT = Number(args.get('at') ?? 26);
const ONLY = args.get('only') ? String(args.get('only')).split(',') : null;
const NO_HUD = args.get('hud') !== 'true';

/**
 * Camera offsets relative to the live battery centroid, in the battery's own frame.
 *
 * `dz` is *downrange positive*: the battery faces -Z, so a positive `dz` puts the focus in
 * front of the muzzles and a negative one behind the winches.
 *
 * The focus is pushed downrange rather than sat on the guns, because `RTSCamera.place` holds
 * the eye at least `lerp(1.7, 22, smoothstep(zoom))` metres above the ground: at any zoom
 * loose enough to frame the whole battery the eye is dragged 8 m up, and a focus on the guns
 * then photographs them from above. Focusing past them puts the eye *behind* the battery at
 * the same height, which is the Rome II artillery composition — guns in the near third, the
 * field beyond.
 */
const SHOTS = {
  // Tightened after three blind critics said the same thing about the loose framings: "four of
  // your six frames have no subject at all", "the actual subject is jammed against the right
  // edge and cropped", "a flat green rectangle terminated by a hard LOD density seam". A wide
  // camera on a twelve-man battery in an empty meadow photographs the meadow. Every shot below
  // now has the guns filling the near third with something legible behind them.
  battery:   { dx: 1.2,  dz: 7,   zoom: 0.27, yaw: Math.PI * 0.90, at: AT },
  engine:    { dx: -5.4, dz: 1.6, zoom: 0.14, yaw: Math.PI * 0.30, at: AT },
  crewwork:  { dx: 1.7,  dz: 1.1, zoom: 0.12, yaw: Math.PI * 0.86, at: AT },
  overwatch: { dx: 0,    dz: 22,  zoom: 0.40, yaw: Math.PI * 0.97, at: AT },
  downrange: { dx: -1.6, dz: -5,  zoom: 0.16, yaw: Math.PI * 0.06, at: AT },
};

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
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
if (NO_HUD) {
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
}
await mkdir(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Where the battery is, and what its crew are doing
// ---------------------------------------------------------------------------

const advanceTo = async (t) => {
  await page.evaluate(async (target) => {
    const g = window.__game;
    while (g.simTime() < target - 1e-6) g.advance(Math.min(0.5, target - g.simTime()));
  }, t);
};

// `--onager=N` spawns a stone-thrower battery beside the scorpions before the clock runs.
//
// `scenario.ts` and `battleConfig.ts` are the integrator's files and do not deploy onagers, so
// without this there is no way to photograph one. Spawning through `battle.spawnUnit` is the
// real code path — same formation placement, same volley machine, same renderer — so what this
// shoots is what a scenario would get.
if (args.has('onager')) {
  const n = Number(args.get('onager')) || 1;
  const info = await page.evaluate(({ n }) => {
    const g = window.__game;
    const ids = [];
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * 46 - 150;
      ids.push(g.battle.spawnUnit('onager', x, 282, Math.PI, 'line'));
    }
    return ids;
  }, { n });
  console.log(`spawned ${info.length} onager battery/batteries: unit ids ${info.join(', ')}`);
}

await advanceTo(AT);

const report = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const out = { units: [], engines: null, note: null };
  for (const u of b.units) {
    if (b.typeOf(u).unitClass !== 'artillery') continue;
    const men = [];
    for (const i of u.members) {
      men.push({
        i, slot: p.slot[i], rank: p.rank[i], file: p.file[i],
        x: +p.x[i].toFixed(2), z: +p.z[i].toFixed(2), y: +p.y[i].toFixed(2),
        state: p.state[i], clip: p.animClip[i], t: +p.animTime[i].toFixed(3),
        ammo: p.ammo[i],
      });
    }
    out.units.push({
      id: u.id, type: u.typeId, alive: u.alive, x: +u.x.toFixed(2), z: +u.z.toFixed(2),
      facing: +u.facing.toFixed(3), width: u.width,
      spacingX: u.spacingX, spacingZ: u.spacingZ, ammo: u.ammo, men,
    });
  }
  // Engine renderer internals, if it exists yet.
  const ur = g.engine.context.tryGet('unitRender');
  if (ur && ur.debugEngines) out.engines = ur.debugEngines();
  return out;
});

console.log('\n=== artillery units ===');
for (const u of report.units) {
  console.log(`unit ${u.id} ${u.type}: ${u.alive} men at (${u.x}, ${u.z}) facing ${u.facing}` +
    `  width=${u.width} spacing=${u.spacingX}x${u.spacingZ} ammo=${u.ammo}`);
  const xs = u.men.map((m) => m.x);
  const zs = u.men.map((m) => m.z);
  console.log(`  men span x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}` +
    `  z ${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)}`);
  for (const m of u.men) {
    console.log(`   slot ${String(m.slot).padStart(2)} r${m.rank}f${m.file}` +
      ` (${m.x.toFixed(2)}, ${m.z.toFixed(2)})  state=${m.state} clip=${m.clip} t=${m.t} ammo=${m.ammo}`);
  }
}
if (report.engines) {
  console.log('\n=== engines ===');
  console.log(JSON.stringify(report.engines, null, 2));
}
if (!report.units.length) console.log('  (none — no artillery unit alive at this time)');

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

// `--focus=<typeId>` frames one artillery type rather than the centroid of all of them, which
// with two kinds on the field lands in the gap between them.
const FOCUS = args.get('focus');
const focused = FOCUS ? report.units.filter((u) => u.type === FOCUS) : report.units;
const centre = focused.length
  ? {
    x: focused.reduce((a, u) => a + u.x, 0) / focused.length,
    z: focused.reduce((a, u) => a + u.z, 0) / focused.length,
  }
  : { x: 0, z: 262 };
console.log(`\nbattery centroid (${centre.x.toFixed(1)}, ${centre.z.toFixed(1)})`);

const names = (ONLY ?? Object.keys(SHOTS)).filter((n) => SHOTS[n]);
names.sort((a, b) => SHOTS[a].at - SHOTS[b].at);

for (const name of names) {
  const s = SHOTS[name];
  await advanceTo(s.at);
  const info = await page.evaluate(async ({ s, c }) => {
    const g = window.__game;
    // The battery faces -Z, so downrange is -Z: a positive dz is in front of the muzzles.
    g.setCamera(c.x + s.dx, c.z - s.dz, s.zoom, s.yaw);
    // Two settle frames so the rig's damping lands and the LOD pass sees the final camera.
    g.advance(1 / 30);
    g.advance(1 / 30);
    const r = g.engine.context.renderer;
    const cam = g.engine.context.camera;
    return {
      draws: r.info.render.calls,
      tris: r.info.render.triangles,
      cam: { x: +cam.position.x.toFixed(1), y: +cam.position.y.toFixed(1), z: +cam.position.z.toFixed(1) },
      fps: g.engine.time.fps ?? 0,
    };
  }, { s, c: centre });
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, await page.screenshot({ type: 'png' }));
  console.log(`  ✓ ${name.padEnd(10)} eye(${info.cam.x}, ${info.cam.y}, ${info.cam.z})` +
    `  draws=${info.draws} tris=${(info.tris / 1e6).toFixed(2)}M  → ${path.relative(ROOT, file)}`);
}

// ---------------------------------------------------------------------------
// Bench: one machine, isolated, through its whole cycle.
//
// A shot of the battery in the grass cannot answer "is the mechanism right?" — the stand is
// a metre tall and the meadow is two thirds of that, and at any framing loose enough to see
// four guns a bow-arm is six pixels. This hides the vegetation and the rest of the army,
// parks the camera a few metres off one engine, and forces its cycle to a series of fixed
// draw fractions so the arms, the string, the slider and the winch can be read frame by
// frame against a diagram.
// ---------------------------------------------------------------------------
if (args.has('bench')) {
  const dir = path.join(OUT, 'bench');
  await mkdir(dir, { recursive: true });
  const setup = await page.evaluate(() => {
    const g = window.__game;
    const hidden = [];
    g.engine.context.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isPoints) return;
      const n = o.name || '';
      // Everything except the engines, the terrain and the soldiers standing at them.
      if (/grass|veg|scatter|tree|foliage|litter|banner|standard/i.test(n) && o.visible) {
        o.visible = false;
        hidden.push(n);
      }
    });
    return hidden.length;
  });
  console.log(`\n=== bench === (hid ${setup} vegetation/prop meshes)`);

  // Draw fractions to photograph, plus the instant of the shot.
  const FRAMES = [
    { name: 'a-released', since: 0.35 },
    { name: 'b-wind-25', since: 0.9 + 13.5 * 0.25 },
    { name: 'c-wind-60', since: 0.9 + 13.5 * 0.60 },
    { name: 'd-loading', since: 0.9 + 13.5 + 0.5 },
    { name: 'e-ready', since: 0.9 + 13.5 + 2.2 },
    { name: 'f-recoil', since: 0.06 },
  ];
  // An onager is a 3.8 m chassis with a 2 m arm over it against a scorpio's 1.4 m stock, so
  // the bench has to stand off further and wider for one or it photographs a corner of it.
  const big = FOCUS === 'onager';
  const K = big ? 2.6 : 1;
  const Z = big ? 0.235 : 0.135;
  const views = [
    { tag: 'q', dx: -1.6 * K, dz: 1.0 * K, zoom: Z, yaw: Math.PI * 0.24 },
    { tag: 'side', dx: -2.2 * K, dz: 0.3 * K, zoom: Z, yaw: Math.PI * 0.5 },
    { tag: 'rear', dx: 0.05, dz: 0.9 * K, zoom: Z, yaw: Math.PI * 1.0 },
    // Downrange of the muzzle looking back. `dz` is downrange-positive and the camera sits
    // `r` behind its focus along the yaw, so a negative dz here put the focus *behind* the eye
    // and the shot photographed empty pasture — a critic correctly reported "e-ready-front.png
    // is a wasted frame, no machine in shot at all". The focus has to be short of the muzzle
    // with the eye beyond it.
    { tag: 'front', dx: 0.05, dz: -0.6 * K, zoom: Z, yaw: Math.PI * 0.02 },
  ];
  // The right-hand engine of the battery, so the camera offsets are relative to a known
  // machine. The unit faces -Z, so its local +X maps to world -X: engine 3's local
  // +1.5 * ENGINE_PITCH lands at world x = centre.x - 5.4.
  const eng0 = big
    ? { x: centre.x - 6.2 * 0.5, z: centre.z - 1.35 }
    : { x: centre.x - 3.6 * 1.5, z: centre.z - 0.55 };

  for (const fr of FRAMES) {
    await page.evaluate((since) => {
      const g = window.__game;
      const ur = g.engine.context.get('unitRender');
      for (const bat of ur.batteries.values()) bat.sinceShot.fill(since);
    }, fr.since);
    for (const v of views) {
      await page.evaluate(({ v, e }) => {
        const g = window.__game;
        g.setCamera(e.x + v.dx, e.z - v.dz, v.zoom, v.yaw);
        // Half a second, not a frame: `RTSCamera` damps its focus *height* toward the
        // terrain, so a camera aimed one frame after a jump is still looking at y = 0 and
        // photographs the ground in front of its subject.
        g.advance(0.5);
      }, { v, e: eng0 });
      const file = path.join(dir, `${fr.name}-${v.tag}.png`);
      await writeFile(file, await page.screenshot({ type: 'png' }));
    }
    console.log(`  ✓ ${fr.name}`);
  }
}

if (errors.length) {
  console.log('\n=== console errors ===');
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(errors.length ? 1 : 0);
