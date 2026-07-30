#!/usr/bin/env node
/**
 * Headless screenshot harness.
 *
 * Boots the game in Chromium with a real WebGL context, fast-forwards the simulation
 * to a chosen moment, parks the camera at a named viewpoint and writes a PNG. This is
 * the ground truth the critic agents judge — nobody grades this project from source.
 *
 * Usage:
 *   node tools/shoot.mjs                          # every shot in the default set
 *   node tools/shoot.mjs --shots=wide,closeup     # a subset
 *   node tools/shoot.mjs --out=screenshots/pass3  # alternate output directory
 *   node tools/shoot.mjs --w=2560 --h=1440        # resolution
 *   node tools/shoot.mjs --list                   # list available shots
 *
 * Exit code is non-zero if the page logged an uncaught error or any shot failed, so
 * agents can use it as a build gate.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Shot definitions. Each is a repeatable camera + time so successive passes are
// directly comparable — the whole point is diffing "before" against "after".
//   x, z    world focus in metres
//   zoom    0 = eye level among the troops, 1 = strategic overview
//   yaw     radians; Math.PI looks north (toward the attackers)
//   at      simulated seconds to fast-forward before shooting
// ---------------------------------------------------------------------------
const SHOTS = {
  establishing: {
    // Auto-framed from behind the player's own line, looking at the enemy — the classic
    // Total War establishing composition, with your own men large in the foreground and
    // the opposing host beyond. A fixed focus cannot do this: at zoom 0.82 a man is 5 px,
    // and at 0.55 the 320 m gap between the armies does not fit, so the camera ended up
    // photographing the empty ground between them.
    desc: 'From behind the Roman line, looking north at the Juthungi host',
    follow: 'ownLine', zoom: 0.70, at: 1,
  },
  wide: {
    // 0.95 is very nearly full zoom-out: an almost top-down strategic view in which the
    // armies are a few pixels tall and the ground's field patchwork is the only thing
    // legible. 0.72 keeps the whole line of battle in frame while men still read as men,
    // which is what this shot is for.
    desc: 'High three-quarter view of the whole battlefield and the city behind',
    x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82, at: 2,
  },
  romanline: {
    // Auto-framed on the actual front rank. A hand-placed focus goes stale the moment the
    // order of battle, the terrain or the deployment changes, and it did: the line ended
    // up in the top-left corner with 90% of the frame full of grass.
    desc: 'Low telephoto along the Roman front rank — reads armour, shields, ranks',
    follow: 'romanFront', zoom: 0.36, at: 2,
  },
  germanhorde: {
    // Auto-framed on the frontmost warband, like romanline. Every hand-placed value this
    // shot has had photographed empty grass: formations put rank N at
    // z = anchor - N*spacing, so a coordinate that looks like it is "at" the mass is
    // usually just outside it, facing the wrong way.
    desc: 'Into the Juthungi mass at eye level — reads variety and disorder',
    follow: 'germanFront', zoom: 0.36, at: 2,
  },
  clash: {
    // Auto-framed: hand-picked coordinates kept missing, because where the lines
    // actually meet is an emergent property of the AI's chosen ground and shifts by
    // tens of metres between passes. `follow` resolves the focus at shoot time.
    desc: 'The moment the lines meet, mid-height, oblique',
    follow: 'contact', zoom: 0.30, at: 72,
  },
  melee: {
    desc: 'Ground level inside the melee — the hardest test of animation and gore',
    follow: 'contact', zoom: 0.30, at: 88,
  },
  cavalry: {
    // The old camera (210, 60) at yaw 1.6pi looked north-west into the Roman rear, with
    // every cavalry action 25-40 m behind it. This framing was verified by the AI agent
    // to put the wedge on the wing with the battle line receding into the dust behind.
    // `follow: 'cavalry'` averages every mounted unit, and with three Roman wings plus
    // four Juthungi raider bands spread across a 900 m front that centroid lands in the
    // infantry between them. Framed on the single largest surviving mounted unit instead.
    desc: 'The cavalry wing sweeping the flank',
    follow: 'cavalryUnit', zoom: 0.30, at: 70,
  },
  city: {
    // Was (60, 400) zoom 0.62, which put the camera *inside* the Via Flaminia tomb field
    // rather than on the city. Pulled back and lifted so the wall reads as the foreground
    // and the districts behind it fill the frame.
    desc: 'The Aurelian Wall with the city behind it',
    x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06, at: 2,
  },
  wall: {
    // Looking *along* the curtain rather than square at it. The wall's outer face points
    // north (-Z, toward the battlefield) and Rome is at 41.9N, so that face is in shade at
    // every hour of the day - brick courses cannot read on a permanently shadowed
    // surface. An oblique view down the wall line puts the sun raking across the
    // brickwork and shows the tower spacing at the same time.
    desc: 'Along the Aurelian Wall - raking light on brick courses, towers, scaffolding',
    follow: 'wall', zoom: 0.62, at: 2,
  },
  skyline: {
    desc: 'Rome behind the wall - Mausoleum, Pantheon, theatres',
    x: -180, z: 780, zoom: 0.80, yaw: Math.PI * 0.05, at: 2,
  },
  deepcity: {
    desc: 'Deep into the city - insulae density and landmark silhouettes',
    x: -20, z: 1050, zoom: 0.86, yaw: Math.PI * 0.1, at: 2,
  },
  terrain: {
    desc: 'Empty countryside — judges terrain material, vegetation and lighting alone',
    x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, at: 2,
  },
  // Both river shots are auto-framed on the live water, for the same reason the combat
  // shots are auto-framed on the live engagement. The hardcoded focus points these two
  // shipped with were ~110 m east of the channel — `riverCentreX(z)` in
  // src/terrain/topography.ts is a two-term meander, so the Tiber sits at x ≈ -868 at
  // z = -300 and x ≈ -930 at the ford, not at the -760/-820 these shots asked for. The
  // result was two photographs of dry fields with the water in a corner, which is how a
  // hand-built Tiber went un-inspected. `follow` probes `heightAt` against `waterLevel`
  // and cannot go stale when the meander is retuned.
  river: {
    desc: 'The Tiber, its cut bank, flood terrace and sand bars',
    // `z` is the line the water probe walks; `yawOffset` swings off the channel bearing so
    // the shot is oblique to the water rather than straight down it.
    follow: 'water', x: -760, z: -300, zoom: 0.72, yaw: Math.PI * 0.15, yawOffset: 0.55, at: 2,
  },
  ford: {
    desc: 'The gravel ford across the Tiber',
    follow: 'water', x: -820, z: -520, zoom: 0.42, yaw: Math.PI * 0.9, yawOffset: 1.35, at: 2,
  },
  aftermath: {
    desc: 'Late battle: corpses, routs, dust and blood on the ground',
    follow: 'corpses', zoom: 0.34, at: 190,
  },
};

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

if (args.has('list')) {
  for (const [k, v] of Object.entries(SHOTS)) {
    console.log(`${k.padEnd(14)} t+${String(v.at).padStart(3)}s  ${v.desc}`);
  }
  process.exit(0);
}

const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots');
const QUALITY = args.get('quality') ?? 'ultra';
const requested = args.get('shots')
  ? String(args.get('shots')).split(',').map((s) => s.trim()).filter(Boolean)
  : Object.keys(SHOTS);
const PORT = Number(args.get('port') ?? 5199);
// Hide the DOM HUD. Terrain, city, lighting and VFX criteria are all judged on the world,
// and a HUD panel across the frame makes them ungradeable — one critic had to write its
// own DOM-stripping harness to get around it. This is that, built in.
const NO_HUD = args.has('nohud');
// Parallel agents each pass their own --port so they never fight over one server.
// Leaving it running is opt-in, because an orphaned vite holds the port for everyone.
const KEEP_SERVER = args.has('keep');

for (const s of requested) {
  if (!SHOTS[s]) {
    console.error(`Unknown shot "${s}". Available: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

let server = null;
async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  if (await waitForServer(base, 1200)) {
    console.log(`• reusing dev server already on ${PORT}`);
    return base;
  }
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', TC_NO_HMR: '1' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  if (!(await waitForServer(base, 60000))) {
    console.error('vite failed to start:\n' + serverLog.slice(-4000));
    throw new Error('dev server did not come up');
  }
  return base;
}

function stopServer() {
  if (server && !KEEP_SERVER) {
    server.kill('SIGTERM');
    server = null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = [];
let failed = 0;
let browser = null;

try {
  const base = await startServer();
  await mkdir(OUT, { recursive: true });

  browser = await chromium.launch({
    args: [
      // Software rasterisation still gives a real GL context; SwiftShader is
      // deterministic across machines, which matters for A/B comparison.
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  const url = `${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}`;
  console.log(`• loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the engine to finish async init.
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 120000 });

  // Confirm we actually got a hardware-ish GL context, not a stub.
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    if (!g) return { ok: false };
    const dbg = g.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
    };
  });
  console.log(`• webgl2: ${gl.ok ? `${gl.vendor} / ${gl.renderer}` : 'UNAVAILABLE'}`);
  if (!gl.ok) throw new Error('WebGL2 unavailable in the harness browser');

  if (NO_HUD) {
    // Belt and braces: hide the HUD root outright, and re-hide it before every shot in
    // case a subsystem re-creates or unhides its own nodes.
    await page.addStyleTag({
      content: '#hud-root, #loading { display: none !important; visibility: hidden !important; }',
    });
    console.log('• --nohud: DOM HUD hidden, grading the world only');
  }

  // Shoot in ascending sim time so we only ever fast-forward.
  const ordered = [...requested].sort((a, b) => SHOTS[a].at - SHOTS[b].at);

  for (const name of ordered) {
    const shot = SHOTS[name];
    const t0 = Date.now();
    try {
      const info = await page.evaluate(
        async ({ s }) => {
          const g = window.__game;
          // Advance in fixed 0.5 s steps rather than one variable jump to the target.
          // `advance(n)` divides n into frames, so the number and size of steps depended
          // on how far the previous shot had already got — which meant the same shot
          // reached a *different* battle state depending on which other shots were
          // requested alongside it. Two runs of `aftermath` reached 6,329 and 6,892 men.
          // A fixed grid makes any subset of shots follow the same path.
          const STEP = 0.5;
          while (g.simTime() < s.at - 1e-6) {
            g.advance(Math.min(STEP, s.at - g.simTime()));
          }

          // Resolve an auto-framed shot against the live battle. Hand-picked focus
          // points drift out of date every time the AI or the terrain changes where the
          // armies choose to meet, which repeatedly produced beautiful photographs of
          // empty grass.
          let fx = s.x, fz = s.z, fyaw = s.yaw;
          let waterDebug = null;
          if (s.follow) {
            const b = g.battle;
            const p = b.pool;
            let sx = 0, sz = 0, n = 0;
            const cells = new Map();
            // Faction centroids, used to look along the axis between the two armies.
            const cx = [0, 0], cz = [0, 0], cn = [0, 0];

            for (let i = 0; i < p.count; i++) {
              const st = p.state[i];
              const f = p.faction[i];
              if (st !== 11 && st !== 10) { cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++; }
              let take = false;
              if (s.follow === 'contact') take = st === 4;            // Fighting
              else if (s.follow === 'corpses') take = st === 11 || st === 10;
              if (take) {
                sx += p.x[i]; sz += p.z[i]; n++;
                // Also bucket into a coarse grid, because a battle usually has more than
                // one contact: the cavalry meet on a flank well before the main lines do,
                // and the centroid of two separate fights lands in the empty ground
                // between them. The densest cell is the fight worth photographing.
                const gx = Math.floor((p.x[i] + 1400) / 40);
                const gz = Math.floor((p.z[i] + 1400) / 40);
                const key = gz * 128 + gx;
                const cell = cells.get(key);
                if (cell) { cell.x += p.x[i]; cell.z += p.z[i]; cell.n++; }
                else cells.set(key, { x: p.x[i], z: p.z[i], n: 1 });
              }
            }

            if (s.follow === 'ownLine') {
              // Centroid of the player faction's living men, and of the enemy's, so the
              // camera can sit behind one and aim along the axis at the other.
              const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
              const bx = cn[1] ? cx[1] / cn[1] : 0, bz = cn[1] ? cz[1] / cn[1] : 0;
              // Focus on our own line. The orbit then puts the eye behind it, so the whole
              // enemy host falls beyond the focus instead of behind the camera.
              fx = ax; fz = az;
              fyaw = Math.atan2(bx - ax, bz - az);
              n = -1;
            }

            if (n === 0 && (s.follow === 'romanFront' || s.follow === 'germanFront')) {
              // Frame ONE front-line infantry unit, not the army's centroid. Averaging
              // rank 0 across a 660 m frontage plus the second line and the archers put
              // the focus in open ground between the lines, with the nearest cohort in a
              // corner. A single block fills the frame and is what the shot is for.
              const want = s.follow === 'romanFront' ? 0 : 1;
              let best = null;
              for (const u of b.units) {
                if (u.destroyed || u.faction !== want || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                // Heavy infantry only. The rule "nearest the enemy" otherwise picks the
                // urban cohorts refusing the flanks, since they sit a few metres forward
                // of the main line — and the legionary cohort is the unit whose kit this
                // shot exists to show.
                if (want === 0 ? cls !== 'heavy-infantry' : cls !== 'light-infantry') continue;
                // "Frontmost" = nearest the enemy. Rome faces -Z, the Juthungi face +Z.
                if (!best || (want === 0 ? u.z < best.z : u.z > best.z)) best = u;
              }
              if (best) {
                fx = best.x;
                fz = best.z;
                // A unit's front faces along `facing`, so put the camera on that side and
                // look back at it, swung 0.6 rad off square for an oblique read of the
                // ranks rather than a flat elevation.
                fyaw = best.facing + Math.PI + 0.6;
                n = -1;
              }
            }

            if (s.follow === 'water') {
              // Walk the terrain across the map at this z and find the open water: the span
              // where the ground sits below the river's surface. Derived from the live
              // heightfield, so retuning the meander cannot leave this shot photographing
              // a dry field again.
              const terrain = g.engine.context.tryGet('terrain');
              const level = terrain?.waterLevel;
              if (terrain && typeof level === 'number' && typeof terrain.heightAt === 'function') {
                // Widest span of x at this z where the ground sits below the water surface.
                // `start` is null when no run is open: a numeric sentinel like -1 is wrong
                // here because world x is itself negative on this side of the map.
                const widestWetSpan = (z) => {
                  let bestA = null, bestB = null, start = null;
                  const close = (end) => {
                    if (start === null) return;
                    if (bestA === null || end - start > bestB - bestA) { bestA = start; bestB = end; }
                    start = null;
                  };
                  for (let x = -1380; x <= 1380; x += 4) {
                    if (terrain.heightAt(x, z) < level) { if (start === null) start = x; }
                    else close(x);
                  }
                  close(1380);
                  return bestA === null ? null : { a: bestA, b: bestB, centre: (bestA + bestB) / 2 };
                };
                const here = widestWetSpan(s.z);
                if (here) {
                  // Channel bearing from the wet centre 60 m up- and downstream, so the yaw
                  // is oblique to the water rather than square to the map axes.
                  const up = widestWetSpan(s.z + 60)?.centre ?? here.centre;
                  const down = widestWetSpan(s.z - 60)?.centre ?? here.centre;
                  fx = here.centre;
                  fz = s.z;
                  fyaw = Math.atan2(up - down, 120) + (s.yawOffset ?? 0.6);
                  waterDebug = { z: s.z, span: [here.a, here.b], width: here.b - here.a, centre: here.centre };
                  n = -1;
                } else {
                  waterDebug = { z: s.z, span: null, note: 'no ground below waterLevel on this line' };
                }
              } else {
                waterDebug = { note: 'terrain subsystem or waterLevel unavailable' };
              }
            }

            if (n === 0 && s.follow === 'wall') {
              // Frame a real wall bay rather than a guessed coordinate. The curtain
              // follows the hill crest, so its z varies by 130 m across the map and a
              // hardcoded point lands on open ground as easily as on masonry.
              const city = g.engine.context.tryGet('city');
              const segs = city?.getWallSegments?.() ?? [];
              if (segs.length) {
                // Pick a bay left of the gate: far enough along the curtain that several
                // towers recede into the distance behind it.
                const seg = segs[Math.max(0, Math.floor(segs.length * 0.3))];
                // Focus on the masonry itself, lifted to mid-height so the camera is not
                // pitched into the grass, and look at the curtain obliquely rather than
                // along it: a pure end-on view is mostly foreshortened tower, while ~35
                // degrees off the wall axis shows the face, the courses and the towers
                // receding at once.
                fx = (seg.x1 + seg.x2) / 2;
                fz = (seg.z1 + seg.z2) / 2 - 6;
                fyaw = Math.atan2(seg.x2 - seg.x1, seg.z2 - seg.z1) + 0.62;
                n = -1; // signal: focus already resolved, skip the centroid paths
              }
            }

            if (s.follow === 'cavalryUnit') {
              // Biggest living mounted unit, and look at its front obliquely.
              let best = null;
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
                if (!best || u.alive > best.alive) best = u;
              }
              if (best) {
                fx = best.x;
                fz = best.z;
                fyaw = best.facing + Math.PI + 0.7;
                n = -1;
              }
            }

            if (n === 0 && s.follow === 'cavalry') {
              // Centroid of the mounted units still in the fight.
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
                sx += u.x * u.alive; sz += u.z * u.alive; n += u.alive;
              }
            }

            if (n === -1) { /* already resolved above */ }
            else if (cells.size > 0) {
              // Take the densest 40 m cell and use ITS OWN centroid. Averaging it with its
              // neighbours was fine when the battle was one short clash, but now that it
              // lasts minutes and spreads along a 600 m front there are several contact
              // clusters, and blending the best cell with its neighbours pulled the focus
              // into the empty ground between two of them.
              let bestKey = -1, bestN = 0;
              for (const [k, c] of cells) if (c.n > bestN) { bestN = c.n; bestKey = k; }
              const best = cells.get(bestKey);
              fx = best.x / best.n; fz = best.z / best.n;
            }
            else if (n > 0) { fx = sx / n; fz = sz / n; }
            else {
              // Nothing matched (too early, or everyone already dead): fall back to the
              // midpoint between the two armies rather than to a stale constant.
              const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
              const bx = cn[1] ? cx[1] / cn[1] : 0, bz = cn[1] ? cz[1] / cn[1] : 0;
              fx = (ax + bx) / 2; fz = (az + bz) / 2;
            }

            // Look along the axis between the armies, swung 55 degrees off so the shot is
            // oblique to the line of battle rather than straight down it.
            if (n !== -1 && cn[0] && cn[1]) {
              const ax = cx[0] / cn[0], az = cz[0] / cn[0];
              const bx = cx[1] / cn[1], bz = cz[1] / cn[1];
              fyaw = Math.atan2(bx - ax, bz - az) + 0.96;
            }
          }
          g.setCamera(fx, fz, s.zoom, fyaw);

          // Settle on the *synthetic* clock. Feeding `performance.now()` here would
          // jump Time's accumulator forward by however long the fast-forward took,
          // producing one clamped 250 ms frame that poisons the rolling fps average
          // for every subsequent measurement. `advance` keeps the clock continuous.
          // 0.25 s ≈ 15 frames, enough for camera smoothing, LOD hysteresis and TAA
          // history to converge.
          g.advance(0.25);

          // Measure real cost rather than trusting the in-engine average. Frame inputs
          // stay on the synthetic clock so Time's accumulator is never jumped.
          //
          // `gl.finish()` is not a reliable barrier here: under ANGLE-on-Metal it
          // returns before the GPU has drained, which reported 0.25 ms/frame for a
          // 1.3 M-triangle scene. A 1x1 `readPixels` forces a genuine round trip,
          // because the result cannot be produced until the pipeline has flushed.
          const N = 30;
          const gl = g.engine.renderer.getContext();
          const px = new Uint8Array(4);
          const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

          g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
          sync();
          const t0 = performance.now();
          for (let i = 0; i < N; i++) {
            g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
          }
          sync();
          const msPerFrame = (performance.now() - t0) / N;

          let men = 0;
          let units = 0;
          let corpses = 0;
          for (const u of g.battle.units) {
            if (!u.destroyed) { units++; men += u.alive; }
          }
          const pool = g.battle.pool;
          for (let i = 0; i < pool.count; i++) if (pool.state[i] === 11) corpses++;

          const st = g.engine.stats();
          return {
            simTime: g.simTime(), men, units, corpses, waterDebug,
            focusX: Math.round(fx), focusZ: Math.round(fz), yaw: +fyaw.toFixed(2),
            draws: st.calls, tris: st.tris, programs: st.programs,
            msPerFrame, fps: 1000 / msPerFrame,
          };
        },
        { s: shot }
      );

      if (NO_HUD) {
        await page.evaluate(() => {
          const r = document.getElementById('hud-root');
          if (r) r.style.setProperty('display', 'none', 'important');
        });
      }
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, type: 'png' });
      results.push({ name, file, ...info, ms: Date.now() - t0, desc: shot.desc });
      console.log(
        `  ✓ ${name.padEnd(14)} t+${String(Math.round(info.simTime)).padStart(3)}s  ` +
        `${String(info.men).padStart(5)} men  ${String(info.units).padStart(2)} units  ` +
        `${String(info.draws).padStart(4)} draws  ${(info.tris / 1e6).toFixed(2)}M tris  ` +
        `${info.msPerFrame.toFixed(2)}ms/f  @(${info.focusX},${info.focusZ})`
      );
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}: ${err.message}`);
      results.push({ name, error: err.message, desc: shot.desc });
    }
  }

  if (consoleErrors.length) {
    failed++;
    console.error(`\n⚠ ${consoleErrors.length} console error(s):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.error(`   ${e}`);
  }

  await writeFile(
    path.join(OUT, 'report.json'),
    JSON.stringify(
      { at: new Date().toISOString(), width: W, height: H, quality: QUALITY, gl, shots: results, consoleErrors: [...new Set(consoleErrors)] },
      null,
      2
    )
  );
  console.log(`\n→ ${results.filter((r) => !r.error).length}/${requested.length} shots written to ${path.relative(ROOT, OUT)}/`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  stopServer();
}

process.exit(failed > 0 ? 1 : 0);
