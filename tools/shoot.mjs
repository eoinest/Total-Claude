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
    desc: 'Opening wide shot from behind the Roman line, both armies in frame',
    // zoom 0.82 is a ~395 m orbit, which puts a man at ~5 px and reduces both armies to
    // dust-coloured bands no amount of model detail can rescue. 0.55 gives ~12 px.
    x: 0, z: -20, zoom: 0.55, yaw: Math.PI, at: 1,
  },
  wide: {
    desc: 'High three-quarter view of the whole battlefield and the city behind',
    x: 0, z: 90, zoom: 0.95, yaw: Math.PI * 0.82, at: 2,
  },
  romanline: {
    desc: 'Low telephoto along the Roman front rank — reads armour, shields, ranks',
    x: -20, z: 128, zoom: 0.16, yaw: Math.PI * 1.42, at: 2,
  },
  germanhorde: {
    desc: 'Into the Juthungi mass at eye level — reads variety and disorder',
    // The Juthungi face +Z and formations put rank N at z = anchor - N*spacing, so the
    // mass occupies z <= -190. The old camera sat at z ~ -190 looking +Z, i.e. out of the
    // front of the formation with every man behind it, and showed nothing at all.
    x: -34, z: -188, zoom: 0.14, yaw: Math.PI, at: 2,
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
    follow: 'contact', zoom: 0.09, at: 88,
  },
  cavalry: {
    // The old camera (210, 60) at yaw 1.6pi looked north-west into the Roman rear, with
    // every cavalry action 25-40 m behind it. This framing was verified by the AI agent
    // to put the wedge on the wing with the battle line receding into the dust behind.
    desc: 'The cavalry wing sweeping the flank',
    follow: 'cavalry', zoom: 0.42, at: 62,
  },
  city: {
    desc: 'Necropolis, road, Aurelian Wall and the city beyond',
    x: 60, z: 400, zoom: 0.62, yaw: 0.0, at: 2,
  },
  wall: {
    desc: 'Close along the Aurelian Wall - brick courses, towers, scaffolding',
    x: -120, z: 470, zoom: 0.58, yaw: 0.0, at: 2,
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
  river: {
    desc: 'The Tiber, its cut bank, flood terrace and sand bars',
    x: -760, z: -300, zoom: 0.72, yaw: Math.PI * 0.15, at: 2,
  },
  ford: {
    desc: 'The gravel ford across the Tiber',
    x: -820, z: -520, zoom: 0.42, yaw: Math.PI * 0.9, at: 2,
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

  // Shoot in ascending sim time so we only ever fast-forward.
  const ordered = [...requested].sort((a, b) => SHOTS[a].at - SHOTS[b].at);

  for (const name of ordered) {
    const shot = SHOTS[name];
    const t0 = Date.now();
    try {
      const info = await page.evaluate(
        async ({ s }) => {
          const g = window.__game;
          const need = s.at - g.simTime();
          if (need > 0) g.advance(need);

          // Resolve an auto-framed shot against the live battle. Hand-picked focus
          // points drift out of date every time the AI or the terrain changes where the
          // armies choose to meet, which repeatedly produced beautiful photographs of
          // empty grass.
          let fx = s.x, fz = s.z, fyaw = s.yaw;
          if (s.follow) {
            const b = g.battle;
            const p = b.pool;
            let sx = 0, sz = 0, n = 0;
            // Faction centroids, used to look along the axis between the two armies.
            const cx = [0, 0], cz = [0, 0], cn = [0, 0];

            for (let i = 0; i < p.count; i++) {
              const st = p.state[i];
              const f = p.faction[i];
              if (st !== 11 && st !== 10) { cx[f] += p.x[i]; cz[f] += p.z[i]; cn[f]++; }
              let take = false;
              if (s.follow === 'contact') take = st === 4;            // Fighting
              else if (s.follow === 'corpses') take = st === 11 || st === 10;
              if (take) { sx += p.x[i]; sz += p.z[i]; n++; }
            }

            if (s.follow === 'cavalry') {
              // Centroid of the mounted units still in the fight.
              for (const u of b.units) {
                if (u.destroyed || u.alive === 0) continue;
                const cls = b.typeOf(u).unitClass;
                if (cls !== 'heavy-cavalry' && cls !== 'light-cavalry') continue;
                sx += u.x * u.alive; sz += u.z * u.alive; n += u.alive;
              }
            }

            if (n > 0) { fx = sx / n; fz = sz / n; }
            else {
              // Nothing matched (too early, or everyone already dead): fall back to the
              // midpoint between the two armies rather than to a stale constant.
              const ax = cn[0] ? cx[0] / cn[0] : 0, az = cn[0] ? cz[0] / cn[0] : 0;
              const bx = cn[1] ? cx[1] / cn[1] : 0, bz = cn[1] ? cz[1] / cn[1] : 0;
              fx = (ax + bx) / 2; fz = (az + bz) / 2;
            }

            // Look along the axis between the armies, swung 55 degrees off so the shot is
            // oblique to the line of battle rather than straight down it.
            if (cn[0] && cn[1]) {
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
            simTime: g.simTime(), men, units, corpses,
            focusX: Math.round(fx), focusZ: Math.round(fz), yaw: +fyaw.toFixed(2),
            draws: st.calls, tris: st.tris, programs: st.programs,
            msPerFrame, fps: 1000 / msPerFrame,
          };
        },
        { s: shot }
      );

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
