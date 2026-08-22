#!/usr/bin/env node
/**
 * Numerical acceptance tests for siege mechanics.
 *
 * A screenshot cannot show whether a man is standing *on* a wall-walk or hovering ten
 * centimetres above it, sunk into the masonry, or standing on the terrain 8 m below with
 * the wall drawn in front of him. That is what this measures. Every assertion here is a
 * number with a tolerance, taken from the live simulation through `window.__game`.
 *
 * It also captures the frames the siege is graded on, because the camera positions worth
 * shooting are the ones defined relative to the wall — a bay offset from the gate and a
 * standoff — and the wall's geometry is generated, so a hardcoded world position would be
 * wrong the moment anything upstream moved. `tools/shoot.mjs` owns the graded field-battle
 * cameras and belongs to the integrator; this owns the siege ones.
 *
 * Usage:
 *   node tools/probe-siege.mjs --port=5353              # assertions
 *   node tools/probe-siege.mjs --port=5353 --json
 *   node tools/probe-siege.mjs --port=5353 --shots      # capture frames
 *   node tools/probe-siege.mjs --port=5353 --shots=walkway,tower --out=screenshots/x
 */

import { launchBrowser } from './lib/browser-budget.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  })
);

const PORT = Number(args.get('port') ?? 5252);
const QUALITY = args.get('quality') ?? 'ultra';
const AS_JSON = args.has('json');
const ROOT = resolve(process.cwd());
const SHOT_MODE = args.has('shots');
const SHOT_FILTER = args.get('shots') === '1' ? null : String(args.get('shots') ?? '').split(',');
const OUT_DIR = resolve(ROOT, args.get('out') ?? 'screenshots/siege');
const SHOT_W = Number(args.get('w') ?? 1920);
const SHOT_H = Number(args.get('h') ?? 1080);

/**
 * The siege cameras.
 *
 * `bay` is an offset in bays from the gate, `stand` a distance out from the wall along that
 * bay's own outward normal (negative is inside the city). Both are resolved against the
 * live wall, so these survive the curtain being regenerated on different terrain.
 *
 * `onWall` overrides the camera rig's ground sampler with the wall-walk height for the
 * duration of the shot, which is the only way to get the eye up on the parapet: the rig
 * rides `heightAt` and there is no elevation control. It is restored afterwards.
 */
const SHOTS = [
  {
    id: 'walkway', at: 300, bay: 2, stand: 0.2, lift: 'walk+1.3', zoom: 0.17, yaw: 'along',
    // Bay offset +2, not +1. Every fifth finished bay carries a covered gallery over the
    // walk (`bay.index % 5 === 1` in `wall.ts`), and the gate bay is 20, so offset +1 is
    // bay 21 — a galleried one. The camera stood under its roof and the frame was a
    // 1920x1080 photograph of roof tiles.
    note: 'Along the wall-walk over the heads of the garrison, tower chamber closing the run.',
  },
  {
    id: 'crenels', at: 60, bay: 2, stand: 13, lift: 'crest', zoom: 0.15, yaw: 'in',
    note: 'Close on the battlement from outside: men standing in the embrasures, shooting down.',
  },
  {
    id: 'garrison', at: 44, bay: 1, stand: 22, lift: 'crest', zoom: 0.28, yaw: 'in',
    note: 'The manned parapet with the ground below it, from outside.',
  },
  {
    id: 'escalade', at: 150, bay: -3, stand: 6, lift: 6, zoom: 0.22, yaw: 'in', yawAdd: 0.5,
    note: 'Ladders against the unfinished stretch, men on the rungs. Framed close and '
      + 'oblique: the wider view was dominated by the curtain\'s own construction '
      + 'scaffolding, which a critic read as the ladders and called sticks joining nothing.',
  },
  {
    id: 'ram', at: 170, bay: 0, subject: 'gate', stand: 16, lift: 2.5, zoom: 0.26,
    yaw: 'in', yawAdd: -0.8,
    // Aimed at the gate, not at the midpoint of the gate's bay. The two are 25 m apart —
    // the Porta Flaminia sits where the Via Flaminia crosses the crest, which is nowhere
    // near the centre of the bay it happens to fall in — and the first version of this shot
    // was 1920x1080 of grass because of it.
    note: 'The ram under its shed at the Porta Flaminia, three-quarter on so the trunk, '
      + 'slings and wheels are all readable.',
  },
  {
    id: 'towerside', at: 268, bay: 1, stand: 15, lift: 'walk', zoom: 0.40, yaw: 'in', yawAdd: 0.7,
    note: 'The tower in three-quarter view, to be judged as a machine.',
  },
  {
    id: 'tower', at: 300, bay: 1, stand: 10, lift: 'walk', zoom: 0.40, yaw: 'in',
    note: 'A docked tower with its ramp down and men crossing onto the wall.',
  },
  {
    id: 'assault', at: 300, bay: 0, stand: 170, lift: 25, zoom: 0.55, yaw: 'in',
    note: 'The whole assault: towers, ladders, ram and the host behind.',
  },
  {
    id: 'ramphead', at: 302, bay: 1, stand: 9, lift: 'walk+2.2', zoom: 0.10, yaw: 'in', yawAdd: 1.15,
    note: 'Close on where a tower\'s boarding ramp meets the parapet, from the flank. This is '
      + 'the frame the reported bug lived in: the ramp was drawn raked backwards over the '
      + 'machine with its hoisting ropes pointing at the wall. It must read as a bridge from '
      + 'the deck DOWN ONTO the walkway, ropes running back from its far lip to the roof.',
  },
  {
    id: 'stair', at: 40, bay: 2, stand: -26, lift: 'walk-3', zoom: 0.16, yaw: 'out', yawAdd: 0.45,
    // From inside the city, looking back at the curtain, so the flight and the men on it are
    // both in frame against the masonry.
    setup: 'stair',
    note: 'A cohort ordered from inside the city up onto the wall, on the stair, seen from '
      + 'the street below. Men must be ON the treads, not beside them or in the air.',
  },
  {
    id: 'greatram', at: 150, bay: -6, stand: 26, lift: 3.0, zoom: 0.30, yaw: 'in', yawAdd: -0.7,
    setup: 'greatram',
    note: 'The great ram against a curtain bay, three-quarter on. It must read as a much '
      + 'larger machine than the gate ram: longer, lower, more heavily framed, eight wheels.',
  },
];

/**
 * Per-shot staging, run in the page before the camera is placed.
 *
 * The capture pass walks one simulation forward in time and cannot rewind, so anything a
 * frame needs that the scenario does not itself produce — a great ram, a cohort ordered up a
 * stair — has to be set going here, early enough that it has happened by `at`.
 */
const SETUPS = {
  stair: () => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    const bays = g.engine.context.get('city').getGarrisonBays();
    const gi = bays.findIndex((x) => x.isGate);
    const bay = bays[gi + 2] ?? bays[gi];
    for (const u of b.units) {
      if (u.destroyed || u.faction !== 0 || u.alive < 8) continue;
      if (s.isGarrisoned(u.id) || s.ownsUnit(u.id)) continue;
      s.sendToWall(u, (bay.x0 + bay.x1) * 0.5, (bay.z0 + bay.z1) * 0.5);
      break;
    }
  },
  greatram: () => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    const bays = g.engine.context.get('city').getGarrisonBays();
    const gi = bays.findIndex((x) => x.isGate);
    let bay = null;
    for (let k = gi - 6; k >= 0; k--) if (bays[k] && bays[k].garrisonable) { bay = bays[k]; break; }
    if (!bay) return;
    const tx = (bay.x0 + bay.x1) * 0.5;
    const tz = (bay.z0 + bay.z1) * 0.5;
    for (const u of b.units) {
      if (u.destroyed || u.faction !== 1 || u.alive < 10) continue;
      if (s.ownsUnit(u.id) || s.isGarrisoned(u.id)) continue;
      s.spawnGreatRam(tx + bay.nx * 34, tz + bay.nz * 34, tx, tz, u.id);
      break;
    }
  },
};

// The dusk frame that was composed against r2-08 has been dropped rather than fixed.
//
// A blind critic ranked it last of eighteen — "a lighting failure rather than a night scene:
// unrecoverable black mud plus a flat white mist card pasted on top" — and it was right. The
// reference frame it was composed against is lit by siege fires, and this workstream owns no
// light sources: `src/render/` belongs to another agent and there is nothing in the scene to
// light a wall at 20:00. Shipping a frame whose single worst quality is the absence of
// something I cannot add is not a measurement of anything.

/** The sky hour every shot that does not ask for another one is taken at. */
const DAY_HOUR = 14.3;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.ts': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream',
  '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

/**
 * Reuse a running dev server if one answers, otherwise serve `dist/`.
 *
 * The dev server is detected by asking for a source module, not for `/`. A vite server
 * that is mid-recompile still answers `/` with an index page while returning 500 for every
 * module behind it, and the first version of this probe took that as "no dev server", fell
 * through to `dist/`, and silently measured a build several hours old — reporting that the
 * garrison API did not exist and that the assault scenario had not deployed, both of which
 * were true of that build and of nothing else. A stale pass is worse than a failure.
 */
async function ensureServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const r = await fetch(`${base}/src/main.ts`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      console.log(`• using the dev server at ${base}`);
      return { base, close: () => {}, live: true };
    }
    console.error(`! dev server at ${base} answered ${r.status} for /src/main.ts — it is ` +
      'mid-compile or another workstream has broken a module. Refusing to fall back to a ' +
      'stale dist/; fix the server and re-run.');
    process.exit(2);
  } catch {
    /* fall through to the static server */
  }
  console.log('• no dev server; serving dist/ (which may be stale)');
  const dist = join(ROOT, 'dist');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') p = join(dist, 'index.html');
    try {
      const body = await readFile(p);
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((ok) => server.listen(PORT + 1, ok));
  return { base: `http://127.0.0.1:${PORT + 1}`, close: () => server.close(), live: false };
}

// ---------------------------------------------------------------------------

const checks = [];
/** Record one assertion. `ok` decides pass/fail; `detail` is printed either way. */
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}

/**
 * Record an assertion that could not be run, as its own state.
 *
 * Not a pass. A review of this file found a check calling `check(..., true, 'not exercised')`
 * — a green tick for a measurement that never happened — and `report()` gating on
 * `pass === checks.length`, so the skip was indistinguishable from a success. That is the
 * same family of defect as an assertion computed from the code it is testing: the number at
 * the bottom stops meaning what it says. Skips are now counted and printed separately, and
 * the headline reads "N/M passed, K skipped" so a suite that quietly stops testing things is
 * visible rather than reassuring.
 */
function skip(name, why) {
  checks.push({ name, ok: true, skipped: true, detail: `NOT EXERCISED — ${why}` });
}

function report() {
  const skipped = checks.filter((c) => c.skipped).length;
  const real = checks.filter((c) => !c.skipped);
  const pass = real.filter((c) => c.ok).length;
  if (AS_JSON) {
    console.log(JSON.stringify({ pass, total: real.length, skipped, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.skipped ? '  SKIP' : c.ok ? '  PASS' : '  FAIL'}  ${c.name}\n          ${c.detail}`);
    }
    console.log(`\n${pass}/${real.length} assertions passed`
      + (skipped > 0 ? `, ${skipped} skipped` : ''));
  }
  return pass === real.length;
}

// ---------------------------------------------------------------------------

let browser = null;
let srv = null;
try {
  srv = await ensureServer();
  /*
   * `launchBrowser` — 22 Aug 2026. This file's own `ensureServer` is a `node:http` static
   * server, which dies with the process and never orphaned anything; the browser is the part
   * that needed counting. The GPU flags are `GPU_ARGS` now and are supplied by default.
   */
  browser = await launchBrowser({
    label: 'probe-siege', port: PORT, root: ROOT,
    args: ['--disable-dev-shm-usage'],
  });
  const VW = SHOT_MODE ? SHOT_W : 1280;
  const VH = SHOT_MODE ? SHOT_H : 720;
  const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const url = `${srv.base}/?harness=1&quality=${QUALITY}&w=${VW}&h=${VH}&scenario=assault`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  /**
   * Boot deadline, and why it is not 180 s any more.
   *
   * The curtain rework widened the wall and pushed city generation past three minutes on
   * this machine, at which point this probe stopped reporting siege failures and started
   * reporting `page.waitForFunction: Timeout 180000ms exceeded` — 0/1, with no indication
   * that the thing it had actually hit was the clock. Verified against a tree with the siege
   * files reverted to HEAD, so it was demonstrably not the code under test.
   *
   * A timeout that fires before the subject exists is indistinguishable from the subject
   * being broken, which is the same failure mode as the stale-`dist/` fallback this file
   * already guards against. So it is generous, and it prints what it actually waited.
   */
  const bootT0 = Date.now();
  await page.waitForFunction(() => window.__game && window.__game.ready === true, {}, { timeout: 420000 });
  console.log(`• world ready in ${((Date.now() - bootT0) / 1000).toFixed(1)} s`);

  // -----------------------------------------------------------------------
  // Capture mode: render the siege cameras and stop.
  // -----------------------------------------------------------------------
  if (SHOT_MODE) {
    await mkdir(OUT_DIR, { recursive: true });
    const wanted = SHOTS.filter((s) => !SHOT_FILTER || SHOT_FILTER.includes(s.id));
    // Chronological, so one run of the simulation serves every frame: rewinding is not
    // possible and re-booting for each shot costs a minute of asset loading apiece.
    wanted.sort((a, b) => a.at - b.at);
    // Stage everything at t=0, before the first advance. A cohort takes half a minute to
    // walk to a stair and climb it and a great ram over a minute to roll into contact, so a
    // setup fired at its own shot's timestamp would photograph an empty field.
    for (const id of new Set(wanted.map((s) => s.setup).filter(Boolean))) {
      await page.evaluate(`(${SETUPS[id].toString()})()`);
      console.log(`  staged ${id}`);
    }
    const report = [];
    for (const shot of wanted) {
      const t = await page.evaluate(() => window.__game.simTime());
      if (shot.at > t) await page.evaluate((d) => window.__game.advance(d), shot.at - t);

      const placed = await page.evaluate((sh) => {
        const g = window.__game;
        const city = g.engine.context.get('city');
        const bays = city.getGarrisonBays();
        const gateIdx = bays.findIndex((b) => b.isGate);
        const bay = bays[Math.max(0, Math.min(bays.length - 1, gateIdx + sh.bay))];
        // The gate is not at the centre of its own bay, so a shot of anything at the gate
        // has to ask the city where the gate is.
        const gate = sh.subject === 'gate' ? city.getGates()[0] : null;
        const mx = gate ? gate.x : (bay.x0 + bay.x1) * 0.5;
        const mz = gate ? gate.z : (bay.z0 + bay.z1) * 0.5;
        const fx = mx + bay.nx * sh.stand;
        const fz = mz + bay.nz * sh.stand;

        // Focus height, via the rig's ground sampler.
        //
        // The rig has no elevation control: it puts the focus on `heightAt(focus)` and booms
        // the eye up and back from there, so every camera looks *down* at a point on the
        // ground. That is fine for a field battle and useless for a wall — the first pass of
        // these shots aimed at a ground point 26 m out from the curtain and produced two
        // frames of grass with the masonry at the top edge. Replacing the sampler with a
        // constant puts the focus wherever the subject actually is.
        const rig = g.engine.rig;
        if (!rig.__savedHeightAt) rig.__savedHeightAt = rig.heightAt;
        let liftY = null;
        if (sh.lift === 'walk') liftY = bay.walkY;
        else if (sh.lift === 'crest') liftY = bay.crestY;
        else if (typeof sh.lift === 'string' && sh.lift.startsWith('walk+')) {
          liftY = bay.walkY + Number(sh.lift.slice(5));
        } else if (typeof sh.lift === 'string' && sh.lift.startsWith('walk-')) {
          liftY = bay.walkY - Number(sh.lift.slice(5));
        } else if (typeof sh.lift === 'number') {
          liftY = rig.__savedHeightAt(fx, fz) + sh.lift;
        }
        rig.heightAt = liftY === null ? rig.__savedHeightAt : () => liftY;

        // Always set the hour, never only when the shot asks for one: the shots run in
        // chronological order so one pass of the simulation serves all of them, which meant
        // the night shot at t+34 left every later frame lit at 20:00.
        const sky = g.engine.context.tryGet('sky');
        if (sky && typeof sky.setTimeOfDay === 'function') sky.setTimeOfDay(sh.hour ?? sh.dayHour);

        // Yaw resolved from the wall rather than written down: 'in' looks at the city across
        // the curtain, 'out' away from it, 'along' down the length of the walk.
        let yaw = sh.yaw;
        if (yaw === 'in') yaw = Math.atan2(-bay.nx, -bay.nz);
        else if (yaw === 'out') yaw = Math.atan2(bay.nx, bay.nz);
        else if (yaw === 'along') yaw = Math.atan2(bay.dx, bay.dz);
        yaw += sh.yawAdd ?? 0;
        g.setCamera(fx, fz, sh.zoom, yaw);

        // The HUD comes off for every captured frame.
        //
        // The Rome II press plates carry no interface at all — r2-08 is a clean render with
        // only the wordmark, which the deck crops. Leaving ours on would let a critic sort
        // the deck by the presence of a unit card without looking at a pixel of the scene,
        // and the scene is the thing under test.
        const hud = document.getElementById('hud-root');
        if (hud) hud.style.display = 'none';
        return {
          fx, fz, walkY: bay.walkY, crestY: bay.crestY,
          stage: bay.stage, bayIndex: bay.index, yaw, focusY: liftY,
        };
      }, { ...shot, dayHour: DAY_HOUR });

      // Let the sky relight, the camera settle and the LOD levels swap before the grab.
      await page.evaluate(() => window.__game.advance(0.5));
      const stats = await page.evaluate(() => {
        const r = window.__game.engine.context.renderer;
        return { draws: r.info.render.calls, tris: r.info.render.triangles };
      });
      const file = join(OUT_DIR, `${shot.id}.png`);
      await page.screenshot({ path: file, type: 'png' });
      report.push({ ...shot, ...placed, ...stats });
      console.log(`  ${shot.id.padEnd(11)} t+${String(shot.at).padStart(3)}s  ` +
        `bay ${placed.bayIndex} (${placed.stage})  walkY ${placed.walkY.toFixed(1)}  ` +
        `${stats.draws} draws  ${(stats.tris / 1e6).toFixed(2)} M tris`);
    }
    await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify({ shots: report }, null, 2));
    console.log(`\n${report.length} frame(s) -> ${OUT_DIR}`);
    await browser.close();
    srv.close();
    process.exit(0);
  }

  // Fail fast and loudly on a build that predates this work, rather than reporting eight
  // confusing failures that all mean "you measured the wrong bytes".
  /**
   * Refuse to measure a bundle that does not contain the code under test.
   *
   * The old version of this checked for `getGarrisonBays` and `battle.siege` — both of which
   * have existed for months — so it waved through a page that predated everything this suite
   * was extended to measure. That happened: a vite server died mid-session, the browser had
   * already loaded an older transform, and the run reported **24/28 with the ramp
   * "unmeasurable", `gateReport` missing and `unitWallState is not a function`** — four
   * confusing failures that all meant "you measured the wrong bytes". Indistinguishable, at a
   * glance, from a real regression.
   *
   * So the gate is now the *newest* API each section depends on. A missing method is exit 3,
   * loudly, and never a FAIL line that someone might try to debug.
   */
  const fresh = await page.evaluate(() => {
    const c = window.__game.engine.context.tryGet('city');
    const s = window.__game.battle.siege;
    const need = ['wallReport', 'unitWallState', 'gateReport', 'ramReport', 'breachReport',
      'wallTargetAt', 'sendToWall', 'moveAlongWall', 'sendToGround', 'stormBreach',
      'spawnGreatRam', 'stationWorld', 'stationOverlap'];
    return {
      city: !!(c && typeof c.getGarrisonBays === 'function'),
      siege: !!s,
      missing: s ? need.filter((k) => typeof s[k] !== 'function') : need,
      scenario: new URLSearchParams(location.search).get('scenario'),
    };
  });
  if (!fresh.city || !fresh.siege) {
    console.error(`! the page is running a build without the siege systems ` +
      `(city API ${fresh.city}, battle.siege ${fresh.siege}). Stale bundle — not a test failure.`);
    process.exit(3);
  }
  if (fresh.missing.length > 0) {
    console.error(`! the page is running an OLD build of src/sim/Siege.ts — missing ` +
      `${fresh.missing.length} method(s): ${fresh.missing.join(', ')}.\n` +
      `  This is a stale bundle, not a test failure. The dev server was probably restarted, ` +
      `died mid-run, or is serving a cached transform. Restart it and re-run.`);
    process.exit(3);
  }

  // -----------------------------------------------------------------------
  // 0. The gate, before anything has touched it.
  //
  // Read-only and first, because every other section advances the simulation and the ram
  // eventually breaks the thing this is asserting about. `open` is the flag; `blocked` is
  // whether the city's own occupancy raster agrees — and those two came apart once, which
  // is the entire reason both are measured. A gate that reports itself shut while a column
  // can walk through it is worse than one that is honestly open.
  // -----------------------------------------------------------------------
  const gate0 = await page.evaluate(() => {
    const g = window.__game;
    const city = g.engine.context.get('city');
    const gt = city.getGates()[0];
    const s = g.battle.siege;
    return {
      report: s.gateReport ? s.gateReport() : null,
      open: gt.open,
      // Straight through the carriageway, perpendicular to the curtain.
      blockedThrough: city.blocksMovement(gt.x, gt.z - 10, gt.x, gt.z + 10),
      // A control: open ground 60 m along the wall from the gate must NOT be blocked, so a
      // "blocked" result above cannot be the raster simply saying yes to everything.
      controlClear: city.blocksMovement(gt.x + 300, gt.z - 40, gt.x + 300, gt.z - 20),
      x: gt.x, z: gt.z,
    };
  });
  check('the main gate starts shut',
    !!gate0.report && gate0.report.shutAtStart && gate0.open === false,
    `getGates()[0].open = ${gate0.open}, shutAtStart = ${gate0.report?.shutAtStart}, ` +
    `integrity ${((gate0.report?.hp ?? 0) * 100).toFixed(0)}%`);
  check('a shut gate actually blocks movement through the carriageway',
    gate0.blockedThrough === true && gate0.controlClear === false,
    `blocksMovement across the threshold = ${gate0.blockedThrough} (must be true); ` +
    `control sample 300 m along the wall in open ground = ${gate0.controlClear} (must be false, ` +
    `or "blocked" means nothing)`);

  // -----------------------------------------------------------------------
  // 1. Wall geometry: what does the city actually report?
  // -----------------------------------------------------------------------
  const geo = await page.evaluate(() => {
    const city = window.__game.engine.context.get('city');
    const bays = city.getGarrisonBays ? city.getGarrisonBays() : null;
    return {
      hasApi: !!bays,
      segments: city.getWallSegments().length,
      // Read from the masonry rather than written down; see the walkway-edge assertion.
      halfThickness: bays && bays.length ? (bays[0].halfThickness ?? 3.0) : 3.0,
      bays: bays ? bays.map((b) => ({
        index: b.index, stage: b.stage, walkY: b.walkY, isGate: b.isGate,
        x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1,
        groundY: b.groundY, innerOff: b.innerOff, outerOff: b.outerOff,
        garrisonable: b.garrisonable,
      })) : [],
    };
  });

  check('city exposes a garrison-bay API',
    geo.hasApi,
    geo.hasApi ? `${geo.bays.length} bays, ${geo.segments} wall segments`
      : 'CitySystem.getGarrisonBays() is missing');

  if (geo.hasApi) {
    const g = geo.bays.filter((b) => b.garrisonable);
    const rises = g.map((b) => b.walkY - b.groundY);
    // The bays that actually matter: the ones either side of the gate, which is where the
    // assault goes and the only place a siege tower has to be able to reach. The circuit as
    // a whole crosses forty metres of hillside and some bays are legitimately enormous.
    const gateIdx = geo.bays.findIndex((b) => b.isGate);
    const near = g.filter((b) => Math.abs(b.index - gateIdx) <= 5);
    const nearRise = near.map((b) => b.walkY - b.groundY);
    check('the assaulted bays stand a storm-able height above their own ground',
      near.length > 0 && Math.min(...nearRise) > 4 && Math.max(...nearRise) < 14,
      `${near.length} bays within 5 of the gate rise ${Math.min(...nearRise).toFixed(2)}..` +
      `${Math.max(...nearRise).toFixed(2)} m; whole circuit ` +
      `${Math.min(...rises).toFixed(2)}..${Math.max(...rises).toFixed(2)} m over ${g.length}/${geo.bays.length} garrisonable bays`);

    // Clear standing band: outer is toward the enemy and is the larger offset.
    const widths = near.map((b) => b.outerOff - b.innerOff);
    check('the assaulted bays have a walkway wide enough for two ranks',
      widths.length > 0 && Math.min(...widths) >= 0.75,
      `clear band ${Math.min(...widths).toFixed(2)}..${Math.max(...widths).toFixed(2)} m ` +
      `(a rank pitch is 0.72 m; ${widths.filter((w) => w >= 1.44).length}/${widths.length} bays take three ranks)`);
  }

  // -----------------------------------------------------------------------
  // 2. Garrison: put men on the wall and measure where their feet are.
  // -----------------------------------------------------------------------
  await page.evaluate(() => window.__game.advance(6));

  const stand = await page.evaluate(() => {
    const b = window.__game.battle;
    const s = b.siege;
    if (!s) return { ok: false };
    const p = b.pool;
    const rows = [];
    for (const u of b.units) {
      if (!s.isGarrisoned(u.id)) continue;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const d = s.probeMan(i);
        rows.push({
          i, unit: u.id, y: p.y[i], surf: d.surfaceY, terr: d.terrainY,
          off: d.lateralOffset, inside: d.insideMasonry, bay: d.bay,
        });
      }
    }
    return { ok: true, rows, count: rows.length };
  });

  if (!stand.ok) {
    check('battle exposes the siege system', false, 'battle.siege is undefined');
  } else {
    const rows = stand.rows;
    check('men are garrisoned on the wall', rows.length > 0, `${rows.length} men reported garrisoned`);

    if (rows.length) {
      const err = rows.map((r) => Math.abs(r.y - r.surf));
      const worst = Math.max(...err);
      const mean = err.reduce((a, v) => a + v, 0) / err.length;
      check('every garrisoned man\'s feet are within 5 cm of the walkway surface',
        worst <= 0.05,
        `worst |y - walkY| = ${(worst * 100).toFixed(2)} cm, mean ${(mean * 100).toFixed(2)} cm over ${rows.length} men`);

      const floating = rows.filter((r) => r.y - r.surf > 0.05).length;
      const sunk = rows.filter((r) => r.surf - r.y > 0.05).length;
      check('nobody floats above or sinks into the masonry',
        floating === 0 && sunk === 0,
        `${floating} floating, ${sunk} sunk`);

      const onGround = rows.filter((r) => Math.abs(r.y - r.terr) < 0.2).length;
      check('no garrisoned man is standing on the terrain instead of the wall',
        onGround === 0,
        `${onGround} men at terrain height; wall stands ${(rows[0].surf - rows[0].terr).toFixed(2)} m above it`);

      /**
       * The limit is the wall's own half-thickness, read from the city, not a constant.
       *
       * This was `1.9`, which is `WALL.thickness * 0.5 + 0.15` for the **3.5 m** curtain —
       * the assertion's own message said "walkway half-width 1.75 m" out loud. The curtain is
       * 6.0 m now. The stale number survived only because rank depth was separately capped at
       * three, so nobody ever stood far enough back to trip it; deepening the garrison to the
       * five ranks the new band actually takes puts the rear rank at about −2.45 m, which is
       * legal stone, and this would have failed a correct change and invited the obvious
       * wrong conclusion.
       *
       * Taken from the live bay so it moves with the masonry the next time somebody widens it.
       */
      const halfT = geo.halfThickness;
      const offWorst = Math.max(...rows.map((r) => Math.abs(r.off)));
      check('nobody has walked off the edge of the walkway',
        rows.every((r) => !r.inside) && offWorst <= halfT + 0.15,
        `worst lateral offset from the wall centreline ${offWorst.toFixed(2)} m ` +
        `(the city reports a half-thickness of ${halfT.toFixed(2)} m; limit ${(halfT + 0.15).toFixed(2)})`);
    }
  }

  // -----------------------------------------------------------------------
  // 3. Shooting down: do wall archers kill attackers below?
  // -----------------------------------------------------------------------
  const before = await page.evaluate(() => {
    const b = window.__game.battle;
    return { germ: b.strength[1], rome: b.strength[0], kills: b.siege ? b.siege.wallKills : -1 };
  });
  await page.evaluate(() => window.__game.advance(50));
  const after = await page.evaluate(() => {
    const b = window.__game.battle;
    const s = b.siege;
    return {
      germ: b.strength[1], rome: b.strength[0],
      kills: s ? s.wallKills : -1,
      shots: s ? s.wallShots : -1,
      stats: s ? s.stats() : null,
    };
  });

  check('men on the wall shoot at the enemy below',
    after.shots > 0,
    `${after.shots} missiles released from the wall-walk`);
  check('those shots kill attackers',
    after.kills > 0,
    `${after.kills} attackers killed by wall-top fire; Juthungi ${before.germ} -> ${after.germ}`);

  // -----------------------------------------------------------------------
  // 4. Continuity: nobody teleports or falls.
  // -----------------------------------------------------------------------
  const motion = await page.evaluate(async () => {
    const b = window.__game.battle;
    const p = b.pool;
    const s = b.siege;
    const watch = [];
    for (const u of b.units) {
      if (!s || !s.isGarrisoned(u.id)) continue;
      for (const i of u.members) if (p.aliveAt(i)) watch.push(i);
    }
    let worstSpeed = 0;
    let worstFall = 0;
    let steps = 0;
    const prev = new Map();
    for (const i of watch) prev.set(i, [p.x[i], p.y[i], p.z[i]]);
    // Measured as speed, not as displacement per call.
    //
    // `Engine.advance(s)` runs `round(s / 16.667 ms)` render frames and the fixed-step
    // accumulator decides how many 33 ms simulation steps fall inside them, so one call to
    // `advance(1/30)` is sometimes one step and sometimes two. Asserting on displacement per
    // call therefore compared a one-step move against a two-step budget and reported a clean
    // 63 cm as a 127 cm teleport. Dividing by the sim time actually elapsed removes the
    // ambiguity, and metres per second is the quantity the claim is really about.
    for (let step = 0; step < 90; step++) {
      const t0 = window.__game.simTime();
      window.__game.advance(1 / 30);
      const dt = Math.max(1e-4, window.__game.simTime() - t0);
      steps++;
      for (const i of watch) {
        if (!p.aliveAt(i)) continue;
        const q = prev.get(i);
        const v = Math.hypot(p.x[i] - q[0], p.z[i] - q[2]) / dt;
        const fall = (q[1] - p.y[i]) / dt;
        if (v > worstSpeed) worstSpeed = v;
        if (fall > worstFall) worstFall = fall;
        prev.set(i, [p.x[i], p.y[i], p.z[i]]);
      }
    }
    return { watched: watch.length, worstSpeed, worstFall, steps };
  });

  // Fastest anything legitimate can move a man: his own locomotion (a charge is 4.7 m/s,
  // and on a walkway he only ever walks at 1.5) plus the crowd-separation budget, which is
  // capped at 0.22 m per 33 ms step = 6.6 m/s. So 8.1 m/s is the worst honest case and
  // 10 m/s is the line. A genuine teleport — the 3.6 m bay-step this probe found earlier —
  // is 108 m/s, so the two are not close.
  check('no garrisoned man teleports',
    motion.worstSpeed < 10,
    `fastest garrisoned man ${motion.worstSpeed.toFixed(2)} m/s over ` +
    `${motion.watched} men x ${motion.steps} steps (limit 10 m/s; a man walks at 1.5, ` +
    `separation is capped at 6.6)`);
  check('no garrisoned man falls off the wall',
    motion.worstFall < 3,
    `fastest descent ${motion.worstFall.toFixed(2)} m/s (free fall off this wall reaches 13)`);

  // -----------------------------------------------------------------------
  // 5. Siege towers: ramp lands on the walkway, men cross it.
  // -----------------------------------------------------------------------
  // A tower rolls at 0.42 m/s and starts 74-101 m out, so it needs three to four minutes
  // to arrive. That is the pace the sources give and it is not going to be shortened to
  // suit a test; the test waits instead.
  await page.evaluate(() => window.__game.advance(210));

  const towers = await page.evaluate(() => {
    const s = window.__game.battle.siege;
    return s ? s.towerReport() : null;
  });
  if (!towers) {
    check('siege towers exist', false, 'battle.siege.towerReport() unavailable');
  } else {
    check('siege towers are on the field',
      towers.length > 0,
      towers.map((t) => `#${t.id} ${t.state} at ${t.dist.toFixed(1)} m from the wall`).join('; '));
    const docked = towers.filter((t) => t.docked);
    check('at least one tower has docked against the wall',
      docked.length > 0,
      `${docked.length}/${towers.length} docked`);
    if (docked.length) {
      // A machine of this mass does not hover. Its wheels are on the ground it rolled over.
      const lift = Math.max(...docked.map((t) => Math.abs(t.baseY - t.groundY)));
      check('a docked tower stands on the ground rather than floating above it',
        lift <= 0.3,
        `worst |baseY - terrain| = ${(lift * 100).toFixed(1)} cm across ${docked.length} tower(s); ` +
        docked.map((t) => `#${t.id} base ${t.baseY.toFixed(2)} terrain ${t.groundY.toFixed(2)} ` +
          `deck ${t.deckY.toFixed(2)} walk ${t.walkY.toFixed(2)} gap ${t.faceGap.toFixed(2)}`).join('; '));

      const gap = Math.max(...docked.map((t) => t.faceGap));
      const minGap = Math.min(...docked.map((t) => t.faceGap));
      check('a docked tower is against the wall, not inside it',
        minGap > 0 && gap < 1.2,
        `front face stands ${minGap.toFixed(2)}..${gap.toFixed(2)} m clear of the wall's outer ` +
        `face (must be positive, and under the 3.4 m the ramp can bridge)`);

      const worst = Math.max(...docked.map((t) => Math.abs(t.rampY - t.walkY)));
      check('a docked tower\'s ramp lands level with the walkway',
        worst <= 0.35,
        `worst |rampY - walkY| = ${(worst * 100).toFixed(1)} cm across ${docked.length} docked tower(s)`);

      /**
       * The signed one, and the reason the assertion above cannot be trusted alone.
       *
       * This suite passed 25/25 while all four boarding ramps were drawn pointing the wrong
       * way — head 3.36 m *further from the wall* than its own hinge, raked backwards over
       * the machine's own roof — for exactly the reason the ladders passed 24/24 while raked
       * into the open field: `rampY` was computed analytically as
       * `deckY + sin(pitch) * RAMP_LEN`, from the same inputs as the transform, so it agreed
       * with the renderer's mistake to the centimetre. The player saw it immediately: "the
       * draw bridge is a bit backwards on their top — the ropes are pointed forward and the
       * door opens backwards".
       *
       * `rampHeadOff` and `rampHingeOff` are taken from the `InstancedMesh` matrix that
       * reaches the GPU, so this fails if the drawn ramp disagrees with the intended one for
       * any reason at all — a flipped yaw, a flipped pitch, a swapped hinge and head, a
       * changed Euler order, or a per-instance scale that overshoots. A head that could not
       * be measured is a failure, not a pass.
       *
       * Three independent claims, because a single one is what let the last two through:
       *   reach > 0        the lip is nearer the wall than the hinge — the direction bug
       *   |head - want|    it lands on the standing band, not past the cityward lip
       *   head not inboard of the walkway's inner edge — it is a bridge, not a cantilever
       */
      const undrawn = docked.filter((t) => !t.rampDrawn).length;
      const reaches = docked.map((t) => t.rampReach);
      const landErr = docked.map((t) => Math.abs(t.rampHeadOff - t.wantHeadOff));
      const overhang = docked.map((t) => t.innerOff - t.rampHeadOff);
      check('every boarding ramp reaches toward the wall, not backwards over the tower',
        undrawn === 0 && Math.min(...reaches) > 0 && Math.max(...landErr) <= 0.20
          && Math.max(...overhang) < 0,
        `${undrawn} of ${docked.length} heads unmeasurable; drawn reach ` +
        `${Math.min(...reaches).toFixed(2)}..${Math.max(...reaches).toFixed(2)} m toward the wall ` +
        `(must be positive — it measured -3.36 m when the ramp was yawed 180 deg); lip lands ` +
        `${Math.max(...landErr).toFixed(2)} m from the ` +
        `outward standing limit; clears the walkway's cityward lip by ` +
        `${Math.min(...overhang.map((v) => -v)).toFixed(2)}..${Math.max(...overhang.map((v) => -v)).toFixed(2)} m`);

      // Boarding takes as long as it takes: one man at a time up an internal stair.
      await page.evaluate(() => window.__game.advance(90));
      const after2 = await page.evaluate(() => window.__game.battle.siege.towerReport());
      const crossed = after2.reduce((a, t) => a + t.crossed, 0);
      const queued = after2.reduce((a, t) => a + t.queued, 0);
      check('infantry cross the ramp onto the wall',
        crossed > 0,
        `${crossed} men across a boarding ramp onto the wall-walk, ${queued} still on the paths`);

      // And once they are up there, they must be on the stonework like anybody else.
      const boarders = await page.evaluate(() => {
        const b = window.__game.battle;
        const s = b.siege;
        const p = b.pool;
        const rows = [];
        for (const u of b.units) {
          if (u.faction !== 1 || !s.isGarrisoned(u.id)) continue;
          for (const i of u.members) {
            if (!p.aliveAt(i)) continue;
            const d = s.probeMan(i);
            if (d.station < 0) continue;
            rows.push({ dy: p.y[i] - d.surfaceY, off: d.lateralOffset });
          }
        }
        return rows;
      });
      if (boarders.length) {
        const worstDy = Math.max(...boarders.map((r) => Math.abs(r.dy)));
        check('men who boarded stand on the walkway as correctly as the garrison does',
          worstDy <= 0.05,
          `${boarders.length} attackers now on the wall, worst |y - walkY| = ${(worstDy * 100).toFixed(2)} cm`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. Artillery and the ram.
  // -----------------------------------------------------------------------
  const engines = await page.evaluate(() => {
    const s = window.__game.battle.siege;
    return s ? { ...s.engineReport(), stats: s.stats() } : null;
  });
  if (engines) {
    check('artillery has fired',
      engines.shots > 0,
      `${engines.shots} artillery shots, ${engines.hits} impacts, ${engines.kills} kills`);
    check('the ram has reached and struck the gate',
      engines.ramBlows > 0,
      `${engines.ramBlows} blows on the gate, gate integrity ${(engines.gateHp * 100).toFixed(0)}%`);
    check('ladders are pitched and men are going up them',
      engines.laddersCrossed > 0,
      `${engines.ladders} ladders, ${engines.laddersCrossed} men over the parapet by escalade`);
    if (engines.ladderHeadMiss?.length) {
      const L = engines.ladderHeadMiss;
      const face = L.map((l) => l.face);
      const crest = L.map((l) => Math.abs(l.crest));
      const lean = L.map((l) => l.leanDeg);

      /**
       * The signed check, and the reason the rest of this file cannot be trusted on its own.
       *
       * A ladder leans **into** the wall: its foot stands further out along the bay's outward
       * normal than its head does, by `rise · tan(lean)`. Every other assertion here is an
       * unsigned distance or a magnitude, and a ladder pitched the wrong way satisfies all of
       * them — the head is at the right height, the lean is a plausible 21 degrees, men still
       * cross, because the climbing path is built from the wall and not from the mesh. That is
       * exactly the state this suite passed 24/24 in while a player was looking at twelve
       * ladders raked backwards into the open field, heads 4 to 9 m clear of the masonry.
       *
       * `footOff` and `headOff` are measured from the instance matrix the renderer wrote, so
       * this fails if the drawn ladder disagrees with the intended one for any reason — a
       * flipped yaw, a flipped pitch, a swapped foot and head, or a change of Euler order.
       * A head that could not be measured at all fails too.
       */
      const unmeasured = L.filter((l) => !l.drawn).length;
      const worstRake = Math.max(...L.map((l) => Math.abs((l.footOff - l.headOff) - l.rake)));
      const minDrop = Math.min(...L.map((l) => l.footOff - l.headOff));
      check('every ladder leans into the wall, foot further out than head',
        unmeasured === 0 && minDrop > 0 && worstRake <= 0.05,
        `${unmeasured} of ${L.length} heads unmeasurable; foot stands ` +
        `${minDrop.toFixed(2)}..${Math.max(...L.map((l) => l.footOff - l.headOff)).toFixed(2)} m ` +
        `further out than the head (must be positive), against the ` +
        `${Math.min(...L.map((l) => l.rake)).toFixed(2)}..${Math.max(...L.map((l) => l.rake)).toFixed(2)} m ` +
        `that rise x tan(lean) demands — worst disagreement ${(worstRake * 100).toFixed(1)} cm`);

      check('every ladder head actually reaches the wall',
        Math.max(...face) <= 0.05 && Math.min(...face) > -0.7,
        `head lands ${Math.min(...face).toFixed(2)}..${Math.max(...face).toFixed(2)} m from the ` +
        `outer face (0 = touching, negative = biting over the merlon), within ` +
        `${Math.max(...crest).toFixed(2)} m of the parapet, leaning ` +
        `${Math.min(...lean).toFixed(1)}-${Math.max(...lean).toFixed(1)} deg off vertical`);
    }
  }

  // -----------------------------------------------------------------------
  // 7. The wall as traversable terrain.
  //
  // Everything from here on is *interventional* — it issues orders and spawns machines —
  // so it runs last, after the twenty-five assertions above have measured the untouched
  // trajectory of the assault.
  //
  // The great ram is deliberately NOT started here.
  //
  // Overlapping its battering with the traversal tests halved the probe's wall-clock cost and
  // was wrong: `breachBay` calls `recut()` and `buildLinks()`, which **renumber every run**
  // and clear every plan. The traversal assertions capture run indices before their loops, so
  // a breach landing mid-loop could fail them spuriously (plan silently cancelled) or pass
  // them spuriously (the unit's run index shifts onto the target without it moving a metre).
  // A test that races the thing it is testing is not a test. Section 9 runs after.
  // -----------------------------------------------------------------------
  // ---- ordering a unit from inside the city up onto the wall ----
  const ascent = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    // Aim at a stretch of wall near the gate. `wallTargetAt` is the same query the UI would
    // use to decide the click meant the parapet.
    const bays = g.engine.context.get('city').getGarrisonBays();
    const gi = bays.findIndex((x) => x.isGate);
    const bay = bays[gi + 3] ?? bays[gi];
    const tx = (bay.x0 + bay.x1) * 0.5;
    const tz = (bay.z0 + bay.z1) * 0.5;

    /**
     * The free Roman unit *nearest that stretch of wall*, not merely the first in the list.
     *
     * The first version took whichever reserve cohort happened to be lowest-numbered, which
     * was most of the way across the city — so the test spent its whole budget watching men
     * walk and reported "0 men climbed a stair". That was true, and it measured nothing about
     * stairs. A player ordering a cohort onto the wall picks one that is near it.
     */
    let pick = null;
    let pickD = Infinity;
    for (const u of b.units) {
      if (u.destroyed || u.alive < 8) continue;
      if (u.faction !== 0) continue;
      if (s.isGarrisoned(u.id) || s.ownsUnit(u.id)) continue;
      const d = Math.hypot(u.x - tx, u.z - tz);
      if (d < pickD) { pickD = d; pick = u; }
    }
    if (!pick) return { ok: false, why: 'no free Roman unit on the ground' };
    const before = s.unitWallState(pick.id);
    const station = s.wallTargetAt(tx, tz);
    const sent = s.sendToWall(pick, tx, tz);
    return { ok: true, unitId: pick.id, alive: pick.alive, before, sent, station, tx, tz,
      startDist: pickD };
  });

  if (!ascent.ok) {
    check('a unit inside the city can be ordered onto the wall', false, ascent.why);
  } else {
    check('a click on the parapet resolves to a wall station',
      ascent.station >= 0 && ascent.sent,
      `wallTargetAt() -> station ${ascent.station}; sendToWall() -> ${ascent.sent} ` +
      `for unit ${ascent.unitId} (${ascent.alive} men, ${ascent.startDist.toFixed(0)} m from that bay)`);

    // Watch them go up, sampling speed so the ascent cannot be a teleport.
    const climb = await page.evaluate(async (uid) => {
      const g = window.__game;
      const b = g.battle;
      const p = b.pool;
      const s = b.siege;
      const u = b.unitById(uid);
      const watch = u.members.filter((i) => p.aliveAt(i));
      const prev = new Map();
      for (const i of watch) prev.set(i, [p.x[i], p.y[i], p.z[i]]);
      let worstSpeed = 0;
      let worstRise = 0;
      let everOnLink = 0;
      for (let step = 0; step < 12000; step++) {
        const t0 = g.simTime();
        g.advance(1 / 30);
        const dt = Math.max(1e-4, g.simTime() - t0);
        for (const i of watch) {
          if (!p.aliveAt(i)) continue;
          const q = prev.get(i);
          const v = Math.hypot(p.x[i] - q[0], p.z[i] - q[2]) / dt;
          const rise = Math.abs(p.y[i] - q[1]) / dt;
          if (v > worstSpeed) worstSpeed = v;
          if (rise > worstRise) worstRise = rise;
          prev.set(i, [p.x[i], p.y[i], p.z[i]]);
        }
        const st = s.unitWallState(uid);
        if (st.onLink > 0) everOnLink++;
        if (st.onWall >= Math.max(4, Math.floor(watch.length * 0.5))) break;
      }
      return { after: s.unitWallState(uid), worstSpeed, worstRise, everOnLink, watched: watch.length };
    }, ascent.unitId);

    check('men ordered onto the wall climb a stair and arrive on the walkway',
      climb.after.onWall > 0 && climb.everOnLink > 0,
      `${climb.after.onWall}/${climb.watched} men now standing on the wall ` +
      `(${climb.after.onGround} still below, ${climb.after.onLink} on the flight); ` +
      `men were observed on a stair path on ${climb.everOnLink} ticks; ` +
      `unit is on run(s) [${climb.after.runs.join(',')}]`);

    check('nobody teleports or is flung while using a stair',
      climb.worstSpeed < 10 && climb.worstRise < 3.5 && climb.after.worstFeetError <= 0.05,
      `fastest ${climb.worstSpeed.toFixed(2)} m/s horizontally (limit 10), ` +
      `${climb.worstRise.toFixed(2)} m/s vertically (a stair climb is 0.78, free fall reaches 13); ` +
      `worst |y - walkY| once up = ${(climb.after.worstFeetError * 100).toFixed(2)} cm`);

    // ---- laterally, across a run boundary, through a tower ----
    const lateral = await page.evaluate(async (uid) => {
      const g = window.__game;
      const b = g.battle;
      const s = b.siege;
      const u = b.unitById(uid);
      const start = s.unitWallState(uid);
      const startRun = start.runs.length ? start.runs[0] : -1;
      const w = s.wallReport();
      // A station on a *different* run that is reachable along the wall. Walk the chain
      // outward from where the unit is until the run index changes.
      const link = w.linkUse.find((l) => (l.kind === 'towerPass' || l.kind === 'step')
        && (l.runA === startRun || l.runB === startRun));
      if (!link || startRun < 0) return { ok: false, why: `no link off run ${startRun}`, start };
      const wantRun = link.runA === startRun ? link.runB : link.runA;
      // Ask the siege system for a point on that run: use its own station geometry.
      const target = s.stationWorld ? s.stationWorld(wantRun) : null;
      const moved = target ? s.moveAlongWall(u, target.x, target.z) : false;
      if (!moved) return { ok: false, why: 'moveAlongWall refused', start, wantRun };
      const p = g.battle.pool;
      const usedBefore = s.wallReport().linkUse.find((l) => l.id === link.id).used;
      let ticks = 0;
      let worstSpeed = 0;
      let worstRise = 0;
      const prev = new Map();
      for (const i of u.members) if (p.aliveAt(i)) prev.set(i, [p.x[i], p.y[i], p.z[i]]);
      for (let step = 0; step < 5400; step++) {
        const t0 = g.simTime();
        g.advance(1 / 30);
        const dt = Math.max(1e-4, g.simTime() - t0);
        ticks++;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          const q = prev.get(i);
          if (q) {
            const v = Math.hypot(p.x[i] - q[0], p.z[i] - q[2]) / dt;
            const rise = Math.abs(p.y[i] - q[1]) / dt;
            if (v > worstSpeed) worstSpeed = v;
            if (rise > worstRise) worstRise = rise;
          }
          prev.set(i, [p.x[i], p.y[i], p.z[i]]);
        }
        const st = s.unitWallState(uid);
        // The unit has moved when the *bulk* of it is on the far run and none of it is left
        // on the run it started from — not when one man has strayed across.
        if (!st.runs.includes(startRun) && st.runs.includes(wantRun) && st.onLink === 0) break;
      }
      const after = s.unitWallState(uid);
      const usedAfter = s.wallReport().linkUse.find((l) => l.id === link.id).used;
      return { ok: true, start, wantRun, startRun, after, ticks, worstSpeed, worstRise,
        crossings: usedAfter - usedBefore, linkId: link.id, linkKind: link.kind };
    }, ascent.unitId);

    if (!lateral.ok) {
      check('a garrison can move laterally along the wall between sections', false,
        `${lateral.why}; unit was on run(s) [${(lateral.start?.runs ?? []).join(',')}]`);
    } else {
      /**
       * Counted crossings of the *specific* link, not "somebody is somewhere".
       *
       * The first version passed if any one man of ~160 appeared on the target run and if
       * `onLink > 0` on any tick — and `onLink` also counts men still finishing the earlier
       * stair climb, which the ascent loop deliberately leaves half-done. So it could go
       * green with nobody having gone through a tower at all. Now: the unit must have left
       * the run it started on, be on the one it was sent to, and the tower pass itself must
       * record a crossing for a real share of the unit.
       */
      const wantCrossings = Math.max(4, Math.floor(lateral.after.onWall * 0.4));
      const onTarget = lateral.after.runCounts[lateral.wantRun] ?? 0;
      const leftBehind = lateral.after.runCounts[lateral.startRun] ?? 0;
      /**
       * The *bulk* of the unit, not every last man.
       *
       * Requiring the start run to be empty was too strict and failed a redeployment that
       * plainly worked: 20 men through the tower, the unit on the target run, and a handful
       * still filing through behind them. Demanding zero stragglers tests the tail of a
       * queue, not whether a garrison can change position. Requiring the target run to hold
       * the majority does test that, and still fails outright if the unit never moves.
       */
      check('a garrison can move laterally along the wall between sections',
        onTarget > leftBehind && onTarget > 0 && lateral.crossings >= wantCrossings,
        `unit walked from run ${lateral.startRun} to [${lateral.after.runs.join(',')}] ` +
        `(target ${lateral.wantRun}) in ${(lateral.ticks / 30).toFixed(1)} s; ` +
        `${onTarget} men now on the target run against ${leftBehind} still on the one it left; ` +
        `link #${lateral.linkId} (${lateral.linkKind}) carried ${lateral.crossings} men ` +
        `through it, needed ${wantCrossings}`);
      check('men crossing between sections stay on the stonework and are not flung',
        lateral.after.worstFeetError <= 0.05 && lateral.worstSpeed < 10 && lateral.worstRise < 3.5,
        `worst |y - walkY| after the traverse = ${(lateral.after.worstFeetError * 100).toFixed(2)} cm ` +
        `over ${lateral.after.onWall} men; fastest ${lateral.worstSpeed.toFixed(2)} m/s horizontally ` +
        `(limit 10), ${lateral.worstRise.toFixed(2)} m/s vertically (limit 3.5)`);
    }

    // ---- and down the other side, into the city ----
    const descent = await page.evaluate(async (uid) => {
      const g = window.__game;
      const b = g.battle;
      const p = b.pool;
      const s = b.siege;
      const u = b.unitById(uid);
      const start = s.unitWallState(uid);
      // A rally point well inside the city, on the cityward side of the curtain.
      const bays = g.engine.context.get('city').getGarrisonBays();
      const gi = bays.findIndex((x) => x.isGate);
      const bay = bays[gi + 3] ?? bays[gi];
      const rx = (bay.x0 + bay.x1) * 0.5 - bay.nx * 45;
      const rz = (bay.z0 + bay.z1) * 0.5 - bay.nz * 45;
      const sent = s.sendToGround(u, rx, rz);
      let worstDrop = 0;
      const prev = new Map();
      for (const i of u.members) if (p.aliveAt(i)) prev.set(i, p.y[i]);
      /**
       * Long enough to drain a stair that is still carrying traffic the other way.
       *
       * The ascent test deliberately stops once a share of the cohort is up, so when the
       * descent order is given the same single flight is still carrying men *upward* — and
       * every one of them lands on the walk and then has to come back down it. A stair
       * passes about one man a second in each direction, so a cohort caught mid-climb needs
       * minutes, not the 120 s the first version allowed. Measured: 25 men down, 156 of 157
       * inside the walls, and the plan still live when the loop gave up.
       */
      for (let step = 0; step < 12000; step++) {
        const t0 = g.simTime();
        g.advance(1 / 30);
        const dt = Math.max(1e-4, g.simTime() - t0);
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          const q = prev.get(i);
          if (q !== undefined) {
            const drop = (q - p.y[i]) / dt;
            if (drop > worstDrop) worstDrop = drop;
          }
          prev.set(i, p.y[i]);
        }
        /**
         * Wait for the *contract*, not for a snapshot that happens to look finished.
         *
         * Breaking on `onWall === 0 && onLink === 0` looked equivalent and is not. The
         * ascent test deliberately stops once a share of the cohort is up, so the rest of it
         * is still filing up the same stair when the descent order is given — and men keep
         * arriving on the walkway behind the ones coming down. The instant between one
         * arrival and the next satisfies "nobody is on the wall", so the loop exited early
         * and read ownership while the plan was still live: measured as `6 men came off the
         * wall … still owns the unit: true`, with 138 men still climbing.
         *
         * Releasing the unit is the thing being asserted, so wait for exactly that.
         */
        if (!s.ownsUnit(uid)) break;
      }
      // Where did they end up, and are they on the terrain?
      let onTerrain = 0;
      let inside = 0;
      let total = 0;
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        total++;
        if (Math.abs(p.y[i] - b.groundAt(p.x[i], p.z[i])) < 0.3) onTerrain++;
        // Cityward of the curtain.
        const dx = p.x[i] - (bay.x0 + bay.x1) * 0.5;
        const dz = p.z[i] - (bay.z0 + bay.z1) * 0.5;
        if (dx * bay.nx + dz * bay.nz < 0) inside++;
      }
      return { sent, start, after: s.unitWallState(uid), worstDrop, onTerrain, inside, total,
        stillOwned: s.ownsUnit(uid), stillGarrisoned: s.isGarrisoned(uid) };
    }, ascent.unitId);

    // `stillOwned` is in the predicate, not only in the sentence. It was named in the detail
    // string as "must be false" while being absent from the test — so the check would have
    // printed its own failure condition and passed.
    check('a unit on the wall can be ordered down into the city',
      descent.sent && descent.after.onWall === 0 && descent.onTerrain > 0
        && descent.stillOwned === false && descent.inside > 0,
      `${descent.start.onWall} men came off the wall; ${descent.onTerrain}/${descent.total} are now ` +
      `standing on the terrain and ${descent.inside} are cityward of the curtain; ` +
      `sendToGround accepted: ${descent.sent}; siege system still owns the unit: ` +
      `${descent.stillOwned} (must be false — it is a field formation again)`);
    check('nobody falls coming down off the wall',
      descent.worstDrop < 3.5,
      `fastest descent ${descent.worstDrop.toFixed(2)} m/s (a stair is 0.78; free fall off this ` +
      `wall reaches 13)`);
  }

  // ---- two units, one run: the occupancy rule ----
  const occupancy = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    const w = s.wallReport();
    // Find a run that a garrison already holds, and send a second unit to the same place.
    let host = null;
    for (const u of b.units) {
      if (u.destroyed || !s.isGarrisoned(u.id)) continue;
      const st = s.unitWallState(u.id);
      if (st.onWall > 10) { host = { u, st }; break; }
    }
    if (!host) return { ok: false, why: 'no garrison holding a run' };
    let guest = null;
    for (const u of b.units) {
      if (u.destroyed || u.alive < 8 || u.id === host.u.id) continue;
      if (u.faction !== host.u.faction) continue;
      if (!s.isGarrisoned(u.id)) continue;
      const st = s.unitWallState(u.id);
      if (st.onWall > 0 && !st.runs.includes(host.st.runs[0])) { guest = u; break; }
    }
    if (!guest) return { ok: false, why: 'no second garrison to move in' };
    const target = s.stationWorld(host.st.runs[0]);
    const moved = s.moveAlongWall(guest, target.x, target.z);
    return { ok: true, hostId: host.u.id, guestId: guest.id, run: host.st.runs[0], moved,
      hostBefore: host.st.onWall };
  });

  if (!occupancy.ok) {
    skip('a run that is already occupied is shared, not overwritten',
      `${occupancy.why} (the assault had consumed the spare garrisons by this point)`);
  } else {
    const shared = await page.evaluate(async (o) => {
      const g = window.__game;
      const s = g.battle.siege;
      for (let step = 0; step < 3600; step++) {
        g.advance(1 / 30);
        const st = s.unitWallState(o.guestId);
        if (st.runs.includes(o.run) && st.onLink === 0) break;
      }
      const h = s.unitWallState(o.hostId);
      const q = s.unitWallState(o.guestId);
      return { h, q, overlap: s.stationOverlap ? s.stationOverlap(o.hostId, o.guestId) : -1 };
    }, occupancy);
    check('a run that is already occupied is shared, not overwritten',
      shared.overlap === 0 && shared.h.onWall > 0,
      `host unit ${occupancy.hostId} still holds ${shared.h.onWall} men on run(s) ` +
      `[${shared.h.runs.join(',')}]; the unit sent in behind it holds ${shared.q.onWall} on ` +
      `[${shared.q.runs.join(',')}]; stations claimed by both = ${shared.overlap} (must be 0)`);
  }

  // -----------------------------------------------------------------------
  // 8. The ram must not cork the hole it has just made.
  // -----------------------------------------------------------------------
  const jam = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    const city = g.engine.context.get('city');
    const gt = city.getGates()[0];
    const p = b.pool;
    // Bodies of the attacking side that are inside the city through the gate corridor:
    // within 6 m of the gate axis, past the threshold, and on the ground rather than up on
    // the wall (which is a different way in and would confound the count).
    const through = () => {
      let n = 0;
      for (let i = 0; i < p.count; i++) {
        if (!p.aliveAt(i) || p.faction[i] !== 1) continue;
        if (b.elevated[i] !== 0) continue;
        if (Math.abs(p.x[i] - gt.x) > 6) continue;
        const d = (p.z[i] - gt.z) * -Math.cos(gt.facing) - (p.x[i] - gt.x) * Math.sin(gt.facing);
        if (d > 2 && d < 30) n++;
      }
      return n;
    };
    return {
      rams: s.ramReport(),
      gate: s.gateReport(),
      open: gt.open,
      blocked: city.blocksMovement(gt.x, gt.z - 10, gt.x, gt.z + 10),
      through: through(),
      gx: gt.x, gz: gt.z,
    };
  });

  check('the ram breaks the gate open and the passage clears',
    jam.gate.breached && jam.open === true && jam.blocked === false,
    `${jam.gate.blows} blows, integrity ${(jam.gate.hp * 100).toFixed(0)}%, breached ` +
    `${jam.gate.breached}; gate.open now ${jam.open}; blocksMovement through the carriageway ` +
    `${jam.blocked} (was ${gate0.blockedThrough} at t=0)`);

  const gateRams = jam.rams.filter((r) => r.kind === 'gate');
  check('no ram is left standing in the passage it opened',
    gateRams.every((r) => !jam.gate.breached || r.state === 'withdrawing' || r.state === 'spent'
      || r.state === 'wreck'),
    gateRams.map((r) => `#${r.id} ${r.state}, ${r.distFromTarget.toFixed(1)} m off its ` +
      `battering position, crew ${r.crewAlive}`).join('; ') || 'no gate ram');

  check('no crew is pinned to a machine it has broken from',
    jam.rams.every((r) => !r.crewPinned),
    jam.rams.map((r) => `#${r.id} ${r.kind}: crew ${r.crewAlive} alive, routing ` +
      `${r.crewRouting}, still siege-owned ${r.owned} -> pinned ${r.crewPinned}`).join('; '));

  // Throughput: bodies past the threshold, sampled over a minute now the gate is down.
  const flow = await page.evaluate(async (g0) => {
    const g = window.__game;
    const b = g.battle;
    const p = b.pool;
    const city = g.engine.context.get('city');
    const gt = city.getGates()[0];
    const through = () => {
      let n = 0;
      for (let i = 0; i < p.count; i++) {
        if (!p.aliveAt(i) || p.faction[i] !== 1) continue;
        if (b.elevated[i] !== 0) continue;
        if (Math.abs(p.x[i] - gt.x) > 6) continue;
        const d = (p.z[i] - gt.z) * -Math.cos(gt.facing) - (p.x[i] - gt.x) * Math.sin(gt.facing);
        if (d > 2 && d < 30) n++;
      }
      return n;
    };
    /**
     * Somebody has to *want* to go in.
     *
     * The first version counted bodies in the gate corridor and advanced a minute, and
     * measured 0 — correctly, because by the time the leaves come down the warbands that
     * were massed at the gate are dead or broken and nothing left alive has a destination
     * inside the city. That measures the state of the assault, not the gate. The claim under
     * test is "an assault that breaches the gate can get men through it", so the test issues
     * the order the assault would have issued and counts what arrives.
     *
     * A real `orderIssued` event, not a poke at `u.order`: it goes through
     * `BattleSystem.applyOrder`, which is what asks the pathfinder for a route — and a route
     * through the carriageway is precisely the thing that was impossible while the gate was
     * shut and must be possible now.
     */
    const inX = gt.x - Math.sin(gt.facing) * 45;
    const inZ = gt.z - Math.cos(gt.facing) * 45;
    const cands = b.units
      .filter((u) => !u.destroyed && u.alive >= 5 && u.faction === 1
        && !b.siege.ownsUnit(u.id) && !b.siege.isGarrisoned(u.id))
      .map((u) => ({ u, d: Math.hypot(u.x - gt.x, u.z - gt.z) }))
      .sort((m, n) => m.d - n.d)
      .slice(0, 4);
    for (const c2 of cands) {
      g.engine.context.events.emit('orderIssued', {
        unitIds: [c2.u.id], kind: 'move', x: inX, z: inZ, running: true,
      });
    }
    const a = through();
    let peak = a;
    for (let k = 0; k < 24; k++) {
      g.advance(10);
      const n = through();
      if (n > peak) peak = n;
      if (peak >= 5) break;
    }
    const c = through();
    void g0;
    return { a, c, peak, ordered: cands.length,
      nearest: cands.length ? cands[0].d : -1 };
  }, jam.through);

  check('men can actually get through the gate the ram opened',
    flow.peak > 0,
    `${flow.ordered} unit(s) ordered into the city through the carriageway, nearest ` +
    `${flow.nearest < 0 ? 'n/a' : flow.nearest.toFixed(0) + ' m'} from the gate; attackers ` +
    `standing in the corridor inside the walls: ${flow.a} at the moment of the breach, peak ` +
    `${flow.peak}, ${flow.c} at the end. Zero was structurally guaranteed while it was shut — ` +
    `the occupancy raster was solid across the threshold, which the t=0 assertion measured.`);

  // -----------------------------------------------------------------------
  // 9. The great ram, and a practicable breach in a curtain.
  // -----------------------------------------------------------------------
  const great = await page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const s = b.siege;
    // A bay well away from the gate, so a breach cannot be confused with the gateway.
    const bays = g.engine.context.get('city').getGarrisonBays();
    const gi = bays.findIndex((x) => x.isGate);
    let bay = null;
    for (let k = gi - 6; k >= 0; k--) {
      if (bays[k] && bays[k].garrisonable) { bay = bays[k]; break; }
    }
    if (!bay) return { ok: false, why: 'no garrisonable bay clear of the gate' };
    const tx = (bay.x0 + bay.x1) * 0.5;
    const tz = (bay.z0 + bay.z1) * 0.5;
    // The *strongest* free attacking unit, not the first one in the list. By this point in
    // the assault most of the host is spent, and a ram crewed by the twelve survivors of a
    // warband loses them to wall fire on the approach and the machine stands derelict —
    // which measures the roster, not the ram.
    let crew = null;
    for (const u of b.units) {
      if (u.destroyed || u.alive < 10 || u.faction !== 1) continue;
      if (s.ownsUnit(u.id) || s.isGarrisoned(u.id)) continue;
      if (!crew || u.alive > crew.alive) crew = u;
    }
    if (!crew) return { ok: false, why: 'no attacking unit free to crew a great ram' };
    const id = s.spawnGreatRam(tx + bay.nx * 45, tz + bay.nz * 45, tx, tz, crew.id);
    return { ok: id >= 0, id, bay: bay.index, tx, tz, crewId: crew.id,
      before: s.wallReport() };
  });
  check('a great ram can be sent against a curtain bay',
    great.ok,
    great.ok
      ? `great ram #${great.id} rolling at bay ${great.bay} from 45 m out, crewed by unit ${great.crewId}`
      : (great.why ?? 'spawnGreatRam refused'));


  const wall = await page.evaluate(() => {
    const s = window.__game.battle.siege;
    return s.wallReport ? s.wallReport() : null;
  });
  if (!wall) {
    check('the siege system publishes a wall graph', false, 'battle.siege.wallReport() unavailable');
  } else {
    /**
     * Provenance first, and it is printed whether it passes or not.
     *
     * `published` means `CitySystem.getWallStairs()` exists and this is measuring the real
     * flights. `synthesised` means it does not, and the siege system has assumed the cadence
     * `wall.ts buildTower` currently uses — which is a standing invitation for men to walk up
     * stone that is not there the moment the curtain workstream moves the stairs. The
     * mechanic is correct either way; only the *registration* with the visible geometry is
     * at risk, and that risk should be legible in the output rather than buried.
     */
    check('the wall publishes stairs between the ground and the walkway',
      wall.stairs > 0,
      `${wall.stairs} flights, source = ${wall.source.toUpperCase()}` +
      (wall.source === 'synthesised'
        ? ' — the city exposes no getWallStairs(); these are assumed at the cadence wall.ts '
          + 'uses (index % 4 === 2). See the report for the patch that makes this "published".'
        : ' — read from CitySystem.getWallStairs()'));

    const sd = wall.stairDetail;
    const footErr = sd.map((s) => Math.abs(s.footY - s.terrainAtFoot));
    const headErr = sd.map((s) => Math.abs(s.topY - s.walkYAtHead));
    const rises = sd.map((s) => s.rise);
    check('every stair stands on the ground and reaches the walkway',
      sd.length > 0 && Math.max(...footErr) <= 0.25 && Math.max(...headErr) <= 0.05
        && Math.min(...rises) > 3,
      `${sd.length} flights: worst foot-above-terrain ${(Math.max(...footErr) * 100).toFixed(1)} cm, ` +
      `worst head-off-walkway ${(Math.max(...headErr) * 100).toFixed(1)} cm, ` +
      `rise ${Math.min(...rises).toFixed(1)}..${Math.max(...rises).toFixed(1)} m`);

    check('the runs of walkway are joined into one traversable graph',
      wall.links.towerPass + wall.links.step > 0 && wall.reachable > 1,
      `${wall.runs} runs over ${wall.stations} stations; ` +
      `${wall.links.towerPass} tower passes, ${wall.links.step} steps, ${wall.links.stair} stairs; ` +
      `${wall.reachable}/${wall.runs} runs reachable from the ground without leaving the wall`);

    /**
     * And no link is steeper than a flight the stone can be built for.
     *
     * `ROME.md` §15 task 3 asks for this assertion and proposes it as a *height* cap of
     * `STAIR_STEP_OVER = 1.2 m`. It is written as a rake instead, for the reason
     * `docs/tech/SIEGE.md` §2.4a gives: Carthage bridges 2.00 m across a 7.32 m tower, which
     * is a 15 degree ramp and entirely walkable, and 1.50 m across 1.30 m of plan, which is
     * 49 degrees and runs a man through the masonry. One number cannot tell those apart and
     * `Siege.stepAcross` does not try to. `FLIGHT_PITCH` is 0.31 / 0.34 — the tread module
     * `wall.ts` lays the tower stair out from.
     *
     * Before `stepAcross` this failed on both circuits: Rome's worst bridged rake was 56.8
     * degrees over a 7.70 m step and Carthage's 49.2 over 1.50 m.
     */
    const FLIGHT_PITCH = 0.31 / 0.34;
    const steep = wall.linkUse.filter((l) => (l.kind === 'towerPass' || l.kind === 'step')
      && l.pitch > FLIGHT_PITCH + 1e-6);
    const deg = (p2) => ((Math.atan(p2) * 180) / Math.PI).toFixed(1);
    check('no walk-to-walk link is steeper than a flight the stone can carry',
      steep.length === 0,
      `worst bridged step ${wall.worstStep.toFixed(2)} m at ${deg(wall.worstPitch)} degrees ` +
      `(the tread module allows ${deg(FLIGHT_PITCH)}); ${wall.unbridged} unbridged boundaries, ` +
      `${wall.refusedSteps} of them refused on the step` +
      (steep.length
        ? ` — OVER: ${steep.slice(0, 4).map((l) => `${l.runA}→${l.runB} ` +
          `${Math.abs(l.rise).toFixed(2)} m over ${l.gap.toFixed(2)} m (${deg(l.pitch)}°)`).join(', ')}`
        : ''));
  }

  if (great.ok) {
    // Top up whatever the traversal tests did not already advance. 74 blows at 7 s is over
    // eight minutes of battering and the test waits rather than shortening the machine.
    const broke = await page.evaluate(async () => {
      const g = window.__game;
      const s = g.battle.siege;
      for (let k = 0; k < 40; k++) {
        g.advance(20);
        if (s.breachReport().bays.length > 0) break;
      }
      return { wall: s.wallReport(), breach: s.breachReport(), rams: s.ramReport() };
    });

    const gr = broke.rams.find((r) => r.kind === 'great');
    const lr = broke.rams.find((r) => r.kind === 'gate');
    // Measured off the machines' own dimensions, not typed into the detail string. The first
    // version of this asserted `!!gr` and then printed the sizes as prose, so shrinking the
    // great ram to a shoebox would have printed "11.6 x 3.4" and passed.
    check('the great ram is a much larger machine than the gate ram',
      !!gr && !!lr && gr.dims.footprint > lr.dims.footprint * 1.4
        && gr.dims.reach > lr.dims.reach * 1.4 && gr.dims.shedH > lr.dims.shedH * 1.2,
      gr && lr
        ? `footprint ${gr.dims.footprint.toFixed(1)} m2 against ${lr.dims.footprint.toFixed(1)} ` +
          `(x${(gr.dims.footprint / lr.dims.footprint).toFixed(2)}), trunk reach ` +
          `${gr.dims.reach.toFixed(2)} m against ${lr.dims.reach.toFixed(2)} ` +
          `(x${(gr.dims.reach / lr.dims.reach).toFixed(2)}), eaves ${gr.dims.shedH.toFixed(1)} m ` +
          `against ${lr.dims.shedH.toFixed(1)}; ${gr.blows} blows on bay ${gr.bay}, state ${gr.state}`
        : `great ram present: ${!!gr}, gate ram present: ${!!lr}`);

    check('the great ram brings a curtain bay down',
      broke.breach.bays.length > 0 && broke.wall.deadStations > 0,
      `bays breached [${broke.breach.bays.join(',')}]; ${broke.wall.deadStations} standing ` +
      `stations destroyed; runs ${great.before.runs} -> ${broke.wall.runs} ` +
      `(a breach must split the run it is in)`);

    /**
     * Men through the hole, not lanes constructed.
     *
     * The first version asserted `lanes > 0` — which counts `WallLink` objects the breach
     * created — while nothing in the sim could admit a man to one of them, so five paths
     * existed, were counted, and led nowhere. `through` is the number that says a breach is
     * a way into the city rather than a decoration.
     */
    const stormed = await page.evaluate(async () => {
      const g = window.__game;
      const b = g.battle;
      const s = b.siege;
      const br = s.breachReport();
      const before = br.through;
      // The rally point is inside the city, straight in through the hole.
      const bays = g.engine.context.get('city').getGarrisonBays();
      const bay = bays.find((x) => x.index === br.bays[0]) ?? bays[0];
      const rx = (bay.x0 + bay.x1) * 0.5 - bay.nx * 40;
      const rz = (bay.z0 + bay.z1) * 0.5 - bay.nz * 40;
      // The units *nearest the hole*, not whichever remnants come first in the list. By this
      // point the host is scattered over the whole Campus Martius and a warband 400 m away
      // cannot walk to a breach inside the test's budget — which measures the roster, not
      // the breach.
      const bx = (bay.x0 + bay.x1) * 0.5;
      const bz = (bay.z0 + bay.z1) * 0.5;
      const cands = b.units
        .filter((u) => !u.destroyed && u.alive >= 5 && u.faction === 1
          && !s.ownsUnit(u.id) && !s.isGarrisoned(u.id))
        .map((u) => ({ u, d: Math.hypot(u.x - bx, u.z - bz) }))
        .sort((p, q) => p.d - q.d);
      let sent = 0;
      let nearest = -1;
      for (const c of cands) {
        if (s.stormBreach(c.u, rx, rz)) { if (nearest < 0) nearest = c.d; sent++; }
        if (sent >= 3) break;
      }
      for (let k = 0; k < 90 && sent > 0; k++) {
        g.advance(5);
        if (s.breachReport().through - before >= 8) break;
      }
      const after = s.breachReport();
      // If nobody got through, say how close they got — a lane nobody can reach and a lane
      // nobody was sent to are different failures.
      let closest = 1e9;
      const p = b.pool;
      for (const u of b.units) {
        if (u.destroyed || !s.ownsUnit(u.id)) continue;
        for (const i of u.members) {
          if (!p.aliveAt(i) || s.wantLink[i] < 0) continue;
          const l = s.links[s.wantLink[i]];
          if (!l) continue;
          const d = Math.hypot(p.x[i] - l.ax, p.z[i] - l.az);
          if (d < closest) closest = d;
        }
      }
      return { sent, before, through: after.through - before, lanes: after.lanes,
        nearestSent: nearest, closestToMouth: closest };
    });
    check('a breach is a way into the city, not just a hole in the report',
      stormed.sent > 0 && stormed.through > 0,
      `${stormed.sent} unit(s) ordered to storm it, nearest ${stormed.nearestSent < 0 ? 'n/a'
        : stormed.nearestSent.toFixed(0) + ' m'} away; ${stormed.through} men climbed the rubble ` +
      `and came down inside, across ${stormed.lanes} lanes; closest waiting man got to ` +
      `${stormed.closestToMouth > 1e8 ? 'n/a' : stormed.closestToMouth.toFixed(2) + ' m'} of a ` +
      `lane mouth (admission is ${2.0} m). A breach is climbed over its own debris rather than ` +
      `walked through, so each lane is an arc-length path like a ramp.`);

    const survivors = await page.evaluate(() => {
      const g = window.__game;
      const b = g.battle;
      const p = b.pool;
      const s = b.siege;
      let hovering = 0;
      let checked = 0;
      for (const u of b.units) {
        if (u.destroyed || !s.isGarrisoned(u.id)) continue;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          const d = s.probeMan(i);
          if (d.station < 0) continue;
          checked++;
          if (Math.abs(p.y[i] - d.surfaceY) > 0.05) hovering++;
        }
      }
      return { hovering, checked };
    });
    check('nobody is left hovering where the wall used to be',
      survivors.hovering === 0,
      `${survivors.hovering} of ${survivors.checked} men on the wall are off their surface ` +
      `after the collapse (the garrison standing on the breached stretch is rehoused, not killed ` +
      `— only BattleSystem.damage may kill a man)`);
  }

  check('no runtime errors', errors.length === 0, errors.slice(0, 4).join(' | ') || 'clean');
} catch (err) {
  check('probe ran to completion', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser?.close();
  srv?.close();
}

process.exit(report() ? 0 : 1);
