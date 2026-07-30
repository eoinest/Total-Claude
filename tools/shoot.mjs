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
    x: 0, z: -20, zoom: 0.82, yaw: Math.PI, at: 1,
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
    x: -20, z: -186, zoom: 0.18, yaw: Math.PI * 0.1, at: 2,
  },
  clash: {
    desc: 'The moment the lines meet, mid-height, oblique',
    x: 0, z: 0, zoom: 0.36, yaw: Math.PI * 1.2, at: 62,
  },
  melee: {
    desc: 'Ground level inside the melee — the hardest test of animation and gore',
    x: 0, z: 0, zoom: 0.06, yaw: Math.PI * 1.15, at: 78,
  },
  cavalry: {
    desc: 'The cavalry wing sweeping the flank',
    x: 210, z: 60, zoom: 0.3, yaw: Math.PI * 1.6, at: 55,
  },
  city: {
    desc: 'The Aurelian Wall and the city skyline behind the Roman line',
    x: 0, z: 320, zoom: 0.5, yaw: 0.0, at: 2,
  },
  skyline: {
    desc: 'Rome from the north-west with the hills and landmarks silhouetted',
    x: -300, z: 420, zoom: 0.72, yaw: Math.PI * 1.75, at: 2,
  },
  terrain: {
    desc: 'Empty countryside — judges terrain material, vegetation and lighting alone',
    x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4, at: 2,
  },
  aftermath: {
    desc: 'Late battle: corpses, routs, dust and blood on the ground',
    x: 0, z: 40, zoom: 0.4, yaw: Math.PI * 1.3, at: 190,
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
const KEEP_SERVER = args.has('port');

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
    env: { ...process.env, FORCE_COLOR: '0' },
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
        ({ s }) => {
          const g = window.__game;
          const need = s.at - g.simTime();
          if (need > 0) g.advance(need);
          g.setCamera(s.x, s.z, s.zoom, s.yaw);
          // A handful of extra frames lets smoothing, LOD and any temporal
          // accumulation (TAA, motion vectors) settle before we grab the frame.
          for (let i = 0; i < 12; i++) g.engine.frame(performance.now() + i * 16.7);
          let men = 0;
          let units = 0;
          for (const u of g.battle.units) {
            if (!u.destroyed) { units++; men += u.alive; }
          }
          const st = g.engine.stats();
          return { simTime: g.simTime(), men, units, draws: st.calls, tris: st.tris, fps: g.engine.time.fps };
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
        `${(Date.now() - t0)}ms`
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
