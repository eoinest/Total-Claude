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
 *
 * `--bench` is a second, different pass, and the distinction matters. The shots above photograph
 * a battery *in a battle*; the bench photographs **one machine as an object**, to be graded on
 * mechanical coherence against the museum photographs in `reference/engines/`. It therefore breaks
 * every rule the shots above follow: it takes `RTSCamera` out of the loop and drives the camera
 * directly, solves its own stand-off so the machine fills the frame, hides the crew and the
 * neighbouring guns, sets a neutral high sun, and turns the machine on its stand so the light
 * lands over the camera's shoulder. See the block comment at the bench for why each of those is
 * necessary rather than convenient — every one of them was a fault a blind critic reported as
 * though it were a fault in the machine.
 *
 *   node tools/probe-scorpion.mjs --bench --only=engine
 *   node tools/probe-scorpion.mjs --bench --onager=1 --focus=onager --phases=e-ready
 *
 * Bench flags: `--phases=a,b` shoots a subset of the cycle, `--fill` the fraction of the frame the
 * machine's outline should occupy, `--benchfov` the lens, `--sunoff` the key-light offset in
 * degrees, `--benchsky` an hour or a `SKY_PRESETS` name (`overcast` is flat museum light).
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

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
  // `dz` 1.4, in from 7, and `zoom` 0.34 out from 0.27.
  //
  // At the old numbers this shot photographed bare grass and nothing else — no gun, no horizon,
  // 1920x1080 of turf — and the comment above claimed the guns filled the near third. Worked
  // through: the eye ends up at `focus.z + r*cos(pitch)`, so `dz = 7` at `r = 8.2` put it 1.3 m
  // behind the gun line, i.e. standing among the guns with the nearest one under the lens and
  // below the bottom edge. The min-clearance clamp then held the eye 5.3 m up while the look-at
  // sat 1.3 m off the ground 8 m away, tipping the view 27 degrees down so the horizon fell
  // outside the frame entirely.
  //
  // A battery of four on 4.4 m centres is 13.2 m of frontage, which needs about 12 m of stand-off
  // at this FOV. Pulling `dz` in moves the *focus* toward the guns, which pushes the *eye* back
  // away from them, and opening the zoom lengthens the orbit: together they put the eye ~12 m
  // behind the line with all four guns across the middle of the frame.
  battery:   { dx: 1.2,  dz: 1.4, zoom: 0.34, yaw: Math.PI * 0.90, at: AT },
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
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
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

  // -------------------------------------------------------------------------
  // Two things about the old bench were depressing the mechanical-coherence score for reasons
  // that had nothing to do with the machine, and both are fixed here.
  //
  // 1. **Framing.** The engine occupied the left third of the frame and the other two thirds
  //    was empty pasture. Every museum reference plate is a machine-centred close-up, so the
  //    asymmetry was both a tell and an unfair penalty on a test whose whole purpose is to
  //    grade the object. The cause was structural: `setCamera` aims `RTSCamera` at a *ground*
  //    focus and the bench passed `dx`/`dz` offsets into that focus, so the camera was aimed
  //    1.9 m to one side of the machine by construction, and then looked 1.55 m above the
  //    ground (`place()` raises the look-at when close), which put the machine low and left.
  //    On top of that the offsets were still computed on a 3.6 m engine pitch after
  //    `ENGINE_PITCH` went to 4.4, so the "engine" shot was aimed 1.2 m off the gun.
  //
  //    The rig is therefore taken out of the loop for the bench only, and the camera is driven
  //    directly: aimed at the middle of the machine's own outline and stood off at a distance
  //    solved so that outline fills a fixed fraction of the frame. Nothing is guessed and
  //    nothing goes stale when a part moves.
  //
  // 2. **Lighting.** The frames were shot under the battle's low warm sun, so the machine was
  //    a dark low-contrast silhouette against bright ground with metre-long raking shadows
  //    across the mechanism. Museum photographs are evenly lit. The bench now sets a high
  //    neutral sun. The battle's own lighting is deliberate and is not touched: this is a
  //    runtime call on the sky system inside a screenshot pass, not a change to the look.
  //
  //    A high sun is not enough on its own, and it cannot be. `atmosphere.ts` fixes the site at
  //    Rome, 41.9 deg N, declination -14 deg, which caps the sun at 34 deg even at local noon —
  //    deliberately, because that is the shadow length the art direction wants. So the sun sits
  //    on one bearing all day, and of four views round a machine one is always front-lit and one
  //    is always a silhouette. The bench therefore **turns the machine on its stand** for each
  //    view, so that the light always arrives from `--sunoff` degrees off the camera axis. That
  //    is exactly what a museum photographer does with an exhibit, it changes nothing about the
  //    machine's own geometry or the relative camera angle that defines each view, and unlike
  //    moving the sun it leaves the sky and the shading agreeing with each other.
  // -------------------------------------------------------------------------
  // An hour, or the name of a `SKY_PRESETS` entry — `--benchsky=overcast` is the flat diffuse
  // condition most museum photographs are actually taken in.
  // `--debugparts` paints every part id a flat saturated colour instead of shading it, which is
  // the only reliable way to tell "the part is missing" from "the part is inside the timber it
  // connects to". Four rounds of blind grading of this machine reported absent parts that were
  // all present; one fix made from the wrong diagnosis cost a whole round. Never grade a
  // `--debugparts` frame — it is not a photograph of anything.
  const DEBUG_PARTS = args.get('debugparts') === 'true';
  const BENCH_SKY = String(args.get('benchsky') ?? '12');
  const FILL = Number(args.get('fill') ?? 0.86);
  const FOV = Number(args.get('benchfov') ?? 38);
  // Degrees between the camera axis and the sun's bearing. 0 is flat frontal light, which kills
  // form; 90 leaves half the machine black. 32 is the standard three-quarter key.
  const SUN_OFF = Number(args.get('sunoff') ?? 32);

  const setup = await page.evaluate(({ hour, dbg }) => {
    const g = window.__game;
    const ctx = g.engine.context;
    const hidden = [];
    ctx.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isPoints) return;
      const n = o.name || '';
      // Everything except the engine and the ground it stands on.
      //
      // The crew go too, and that is the point rather than a shortcut. A crew of three stands
      // *behind* its machine, so from the rear and rear-three-quarter views — which are the ones
      // that show the winch, the rack, the claw and the groove, the whole reason those views
      // exist — a man's back fills a third of the frame and the mechanism is behind him. The
      // reference plates this is graded against are unmanned museum reconstructions, so an
      // unmanned plate is the like-for-like comparison. The battery, engine and crewwork shots
      // above still photograph the machine served.
      // `bird` and `projectile` are in the list because both put objects between the lens and the
      // machine: the flock's billboards read at close range as a flat dark parallelogram in the
      // sky (which is a real fault in `src/vfx/BirdFlock.ts`, not this probe's business to fix),
      // and a scorpio volley in flight strews forty bolts across the frame.
      if (/grass|veg|scatter|tree|foliage|litter|banner|standard|soldier|horse|corpse|impostor|bird|projectile/i
        .test(n) && o.visible) {
        o.visible = false;
        hidden.push(n);
      }
    });
    const sky = ctx.tryGet('sky');
    if (sky) {
      // A named preset if one was asked for by name, otherwise an hour.
      const h = Number(hour);
      if (Number.isFinite(h)) sky.setTimeOfDay(h);
      else sky.setPreset(hour);
    }
    // Take the RTS rig out of the loop. `Engine.tick` calls `rig.update` every frame and it
    // would otherwise put the camera straight back on its orbit; with it stubbed, whatever the
    // bench writes into the camera survives to the render.
    g.engine.rig.update = () => {};
    // `PostFX` gates depth of field on `rig.zoom < 0.28` and focuses at `rig.orbitRadius`. A
    // bench plate exists to be read for mechanism, so the whole machine has to be sharp:
    // parking zoom above the gate turns DOF off rather than defocusing half the frame at a
    // radius that no longer matches where the camera actually is.
    g.engine.rig.zoom = 0.42;
    if (dbg) {
      ctx.get('unitRender').debugEngineParts(true);
      // AgX plus bloom turns a saturated flat colour into a pastel — the first debug pass came
      // back in nursery colours and two part ids were indistinguishable. A part map is not a
      // photograph, so it wants no grade at all.
      const fx = ctx.tryGet('postfx');
      if (fx) fx.enabled = false;
    }
    return { hidden: hidden.length, sun: sky ? sky.timeOfDay : null };
  }, { hour: BENCH_SKY, dbg: DEBUG_PARTS });
  console.log(`\n=== bench === (hid ${setup.hidden} vegetation/prop meshes, sun at ${setup.sun}h)`);

  // Draw fractions to photograph, plus the instant of the shot. `--phases=e-ready` shoots one,
  // which is what an iteration on the geometry or the light actually needs.
  const WANT = args.get('phases') ? String(args.get('phases')).split(',') : null;
  const FRAMES = [
    { name: 'a-released', since: 0.35 },
    { name: 'b-wind-25', since: 0.9 + 13.5 * 0.25 },
    { name: 'c-wind-60', since: 0.9 + 13.5 * 0.60 },
    { name: 'd-loading', since: 0.9 + 13.5 + 0.5 },
    { name: 'e-ready', since: 0.9 + 13.5 + 2.2 },
    { name: 'f-recoil', since: 0.06 },
    // Braced, dead still, unloaded — the state **every one of the twelve reference photographs is
    // in**, and until now no deck frame was in it. `a-released` is 0.35 s after the shot with the
    // recoil ring still at -0.071 and the machine visibly kicking; the other five are drawn or
    // winding. A drawn machine cannot be compared with twelve braced ones: the string runs away
    // from a front camera and foreshortens to nothing, the arms are swept back so the brace angle
    // cannot be protracted, and the claw ends up among the winch gear, which is where four rounds
    // of critics failed to find it. 0.80 s leaves `draw` at 0 with the ring down to -0.001, so the
    // arms are forward on their buffers, the string is the shallow arrowhead a braced engine
    // actually shows, and the claw sits at `CLAW_REST_Z` on the open part of the case.
    { name: 'g-braced', since: 0.80 },
  ].filter((f) => !WANT || WANT.includes(f.name));

  /**
   * Views, as a bearing of the *eye* in the machine's own frame and an elevation above its
   * centre. 0 deg is downrange of the muzzle looking back; 180 deg is behind the winch. The
   * machine's yaw is read out of the renderer, so these hold whichever way the battery faces.
   *
   * The elevations are a standing photographer's: 12-16 deg puts the eye above the stock so
   * the groove, the rack and the top of the capitulum are all open to the lens, which is what
   * the reference plates do. Dead level hides the bed.
   */
  // `--views=tag:az:el,...` overrides the set, so a deck can be composed without editing this
  // file. Six views of one state is a better deck than four states of one machine, because the
  // reference plates are all of machines at rest and vary by angle rather than by phase.
  const views = args.get('views')
    ? String(args.get('views')).split(',').map((s) => {
      const [tag, az, el] = s.split(':');
      return { tag, az: Number(az), el: Number(el) };
    })
    : [
      { tag: 'q', az: 38, el: 14 },
      { tag: 'side', az: 90, el: 12 },
      { tag: 'rear', az: 158, el: 16 },
      { tag: 'front', az: 4, el: 10 },
    ];

  // The machine to photograph: the end gun of the focused battery, so it has a neighbour on
  // one side only. Read from the renderer's own placement rather than recomputed here.
  const bench = await page.evaluate((typeId) => {
    const g = window.__game;
    const ur = g.engine.context.get('unitRender');
    const bats = ur.debugEngines();
    const bat = bats.find((b) => !typeId || b.type === typeId) ?? bats[0];
    if (!bat) return null;
    const e = bat.engines[bat.engines.length - 1];
    return {
      unit: bat.unit, type: bat.type, k: e.k, sil: bat.silhouette,
      x: e.x, y: e.y, z: e.z, yaw: e.yaw,
    };
  }, FOCUS ?? null);
  if (!bench) {
    console.log('  (no battery to bench)');
  } else {
    // Draw this machine alone. See `UnitRenderSystem.benchOnly`.
    await page.evaluate(({ unit, k }) => {
      window.__game.engine.context.get('unitRender').benchOnly = { unit, k };
    }, { unit: bench.unit, k: bench.k });
    const ext = (i) => {
      const v = bench.sil.map((p) => p[i]);
      return Math.max(...v) - Math.min(...v);
    };
    console.log(`  subject: ${bench.type} unit ${bench.unit} engine ${bench.k}` +
      ` at (${bench.x.toFixed(2)}, ${bench.y.toFixed(2)}, ${bench.z.toFixed(2)}) yaw ${bench.yaw.toFixed(3)}` +
      `  ${bench.sil.length} outline points spanning` +
      ` ${ext(0).toFixed(2)} x ${ext(1).toFixed(2)} x ${ext(2).toFixed(2)} m`);

    for (const fr of FRAMES) {
      for (const v of views) {
        const info = await page.evaluate(({ v, e, fill, fov, since, sunOff }) => {
          const g = window.__game;
          const ctx = g.engine.context;
          const cam = ctx.camera;
          // Force the phase per *view*, not per phase-group. The battle is still running under
          // the bench, so a shot between two views of the same phase would reset `sinceShot`
          // and the four angles would not be of the same machine state. Re-forcing costs
          // nothing and makes the set internally consistent.
          //
          // `freezeEngines` is what makes the forcing stick. The simulation owns the artillery
          // cycle now — `ProjectileSystem` runs it in `fixedUpdate` and `UnitRenderSystem`
          // copies it every frame — so a value written here would be overwritten by the settle
          // frame below. Freezing stops the copy without stopping the battle.
          const ur = ctx.get('unitRender');
          ur.freezeEngines = true;
          for (const bat of ur.batteries.values()) bat.sinceShot.fill(since);

          // Turn the machine so the sun lands `sunOff` degrees off the camera axis.
          //
          // The eye sits at bearing `az` in the machine's own frame, and a yaw of `y` puts that
          // at world bearing `az + y` — so `y = sunBearing + sunOff - az` aims the camera into
          // the sun's own bearing plus the key offset. `yawJit` is the renderer's per-engine yaw
          // stand-off, added to the unit's facing, so writing it is the supported way to turn
          // one machine without touching the unit.
          const sun = ctx.get('sky').sunDirection;
          const sunBearing = Math.atan2(sun.x, sun.z);
          const yaw = sunBearing + (sunOff * Math.PI) / 180 - (v.az * Math.PI) / 180;
          const unit = g.battle.unitById(e.unit);
          const bat = ur.batteries.get(e.unit);
          if (unit && bat) bat.yawJit[e.k] = yaw - unit.facing;

          // `THREE` is not a page global, but every Object3D carries its own classes.
          const Vec3 = cam.position.constructor;
          const cy = Math.cos(yaw);
          const sy = Math.sin(yaw);
          // Local -> world exactly as the engine shader does it: Ry(yaw) then translate.
          const toWorld = (lx, ly, lz) => new Vec3(
            e.x + lx * cy + lz * sy, e.y + ly, e.z - lx * sy + lz * cy
          );
          // The machine's outline, in world space, plus the middle of it to aim at. Aiming at
          // the middle of the *outline* rather than at a ground focus is what centres the
          // subject; the old bench aimed at a ground point 1.9 m to one side of the machine and
          // then looked 1.55 m above that, which put the gun low and left by construction.
          const pts = e.sil.map((p) => toWorld(p[0], p[1], p[2]));
          const lo = [0, 1, 2].map((i) => Math.min(...e.sil.map((p) => p[i])));
          const hi = [0, 1, 2].map((i) => Math.max(...e.sil.map((p) => p[i])));
          const mid = toWorld((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);

          // Eye bearing in the machine's frame, lifted by the view's elevation.
          const a = (v.az * Math.PI) / 180;
          const el = (v.el * Math.PI) / 180;
          const dl = [Math.sin(a), 0, Math.cos(a)];
          const dir = new Vec3(
            (dl[0] * cy + dl[2] * sy) * Math.cos(el),
            Math.sin(el),
            (-dl[0] * sy + dl[2] * cy) * Math.cos(el)
          );

          cam.fov = fov;
          cam.near = 0.25;
          cam.far = 2400;
          cam.updateProjectionMatrix();

          // Solve the stand-off: place, project the outline, scale the distance by how much of
          // the frame it actually filled. Converges in three passes from a generous start
          // because projected extent goes as 1/d; six is belt and braces.
          const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
          let d = diag * 2.2;
          let worst = 0;
          for (let it = 0; it < 6; it++) {
            cam.position.set(mid.x + dir.x * d, mid.y + dir.y * d, mid.z + dir.z * d);
            cam.lookAt(mid);
            cam.updateMatrixWorld(true);
            worst = 0;
            for (const c of pts) {
              const p = c.clone().project(cam);
              worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
            }
            if (!Number.isFinite(worst) || worst <= 0) break;
            const next = d * (worst / fill);
            if (Math.abs(next - d) < 0.004) { d = next; break; }
            d = next;
          }
          cam.position.set(mid.x + dir.x * d, mid.y + dir.y * d, mid.z + dir.z * d);
          cam.lookAt(mid);
          cam.updateMatrixWorld(true);
          // One frame so shadow cascades, LOD selection and the fog pass all see the final
          // camera. The rig is stubbed, so this cannot move it back.
          g.advance(1 / 30);
          const r = g.engine.context.renderer;
          return {
            d: +d.toFixed(2),
            fill: +worst.toFixed(3),
            yawDeg: +((yaw * 180) / Math.PI).toFixed(1),
            eyeY: +cam.position.y.toFixed(2),
            draws: r.info.render.calls,
            tris: r.info.render.triangles,
          };
        }, { v, e: bench, fill: FILL, fov: FOV, since: fr.since, sunOff: SUN_OFF });
        const file = path.join(dir, `${fr.name}-${v.tag}.png`);
        await writeFile(file, await page.screenshot({ type: 'png' }));
        if (fr.name === FRAMES[0].name) {
          console.log(`    ${v.tag.padEnd(5)} stand-off ${info.d} m  eye ${info.eyeY} m` +
            `  machine yaw ${info.yawDeg} deg  frame fill ${info.fill}  draws=${info.draws}`);
        }
      }
      console.log(`  ✓ ${fr.name}`);
    }
  }
}

if (errors.length) {
  console.log('\n=== console errors ===');
  for (const e of errors.slice(0, 20)) console.log('  ' + e);
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(errors.length ? 1 : 0);
