#!/usr/bin/env node
/**
 * Audio verification driver.
 *
 * Screenshots prove nothing about sound, so this is the audio system's build gate. It runs
 * two passes in a real Chromium:
 *
 *   1. **Offline** — loads `src/audio/selftest.ts` on a blank page and renders every
 *      synthesised sound, the mixer's distance model, an overloaded combat bus and eight
 *      seconds of score into `OfflineAudioContext`s, reporting measured peak/RMS/duration.
 *      No user gesture is needed for offline rendering.
 *   2. **Live** — boots the actual game with `?harness=1`, injects the audio subsystem into
 *      the running engine, resumes the context with a real synthetic click, fast-forwards
 *      into the melee and storms the event bus with 200 melee hits per frame, so the voice
 *      clustering and the per-frame main-thread cost are measured against the real sim.
 *
 * Usage:
 *   node src/audio/audio-selftest.mjs [--port=5230] [--json=path] [--offline-only]
 *
 * Exits non-zero if any assertion fails or the page logs a console error.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5230);
const OFFLINE_ONLY = args.has('offline-only');
const JSON_OUT = args.get('json') ?? null;

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let server = null;
async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  if (await waitForServer(base, 1200)) {
    console.log(`• reusing dev server on ${PORT}`);
    return base;
  }
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  if (!(await waitForServer(base, 60000))) {
    console.error(log.slice(-3000));
    throw new Error('dev server did not come up');
  }
  return base;
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(n) : '—');

let failed = 0;
let browser = null;
const consoleErrors = [];
let report = null;
let live = null;

try {
  const base = await startServer();
  browser = await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      // Deliberately NOT relaxing the autoplay policy: the point is to prove the audio
      // system behaves when the browser refuses to start it.
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ---- Pass 1: offline synthesis and graph measurement --------------------
  // A blank document served from the vite origin, so the dynamic import below is
  // same-origin and gets transformed by the dev server.
  await page.route(`${base}/__audio_selftest`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>audio selftest</title><body>' })
  );
  console.log('• offline pass');
  await page.goto(`${base}/__audio_selftest`, { waitUntil: 'domcontentloaded' });
  report = await page.evaluate(async () => {
    const m = await import('/src/audio/selftest.ts');
    return await m.runAudioSelfTest();
  });

  console.log(`\n  bank: ${report.bank.count}/${report.bank.expected} sounds, ` +
    `${report.bank.buildMs.toFixed(1)} ms to synthesise, ` +
    `${report.bank.totalSamples.toLocaleString()} samples (${report.bank.megabytes.toFixed(1)} MB)\n`);

  console.log(`  ${pad('sound', 22)}${pad('ch', 3)}${pad('sr', 7)}${pad('ms', 9)}${pad('peak', 8)}${pad('rms', 8)}dc`);
  for (const s of report.sounds) {
    console.log(
      `  ${s.ok ? ' ' : '!'}${pad(s.id, 21)}${pad(s.channels, 3)}${pad(s.sampleRate, 7)}` +
      `${pad(s.durationMs.toFixed(0), 9)}${pad(num(s.peak), 8)}${pad(num(s.rms, 4), 8)}${num(s.dc, 5)}` +
      (s.problems.length ? `   ${s.problems.join('; ')}` : '')
    );
  }

  console.log('\n  through the mixer graph:');
  for (const g of report.graph) {
    console.log(`    ${pad(g.name, 26)} peak ${num(g.peak)}  rms ${num(g.rms, 4)}  hf ${num(g.hfRms, 4)}  ${g.durationMs.toFixed(0)} ms`);
  }
  console.log(`\n  distance model: ${num(report.distance.attenuationDb, 1)} dB from 12 m to 400 m; ` +
    `HF share ${num(report.distance.nearHfRatio)} → ${num(report.distance.farHfRatio)}`);
  console.log(`  headroom: ${report.headroom.requested} requested → ${report.headroom.started} started, ` +
    `${report.headroom.concurrent} concurrent (cap ${report.headroom.voiceCap}), ` +
    `${report.headroom.stolen} stolen, ${report.headroom.culled} culled, rendered peak ${num(report.headroom.renderedPeak)}`);
  console.log(`  clustering: ${report.clustering.events} events → ${report.clustering.discreteVoices} discrete voices ` +
    `(${(report.clustering.ratio * 100).toFixed(1)}%), intensity ${num(report.clustering.meleeIntensity)}, ${report.clustering.beds} beds`);
  console.log(`  music: ${report.music.cue}, ${report.music.bars} bars, peak ${num(report.music.peak)}, ` +
    `rms ${num(report.music.rms, 4)}, max polyphony ${report.music.notesPeak}`);
  console.log(`  headless safety: no-context threw ${report.headless.noContextThrew}, ` +
    `suspended (state="${report.headless.observedState}") threw ${report.headless.suspendedThrew}, ` +
    `ready=${report.headless.suspendedReady}, voices scheduled while suspended ${report.headless.suspendedScheduled}`);

  if (report.warnings.length) {
    console.log(`\n  ${report.warnings.length} warning(s):`);
    for (const w of report.warnings.slice(0, 24)) console.log(`    ~ ${w}`);
  }
  if (report.failures.length) {
    failed++;
    console.error(`\n  ${report.failures.length} FAILURE(S):`);
    for (const f of report.failures) console.error(`    ✗ ${f}`);
  }

  // ---- Pass 2: the live game ---------------------------------------------
  if (!OFFLINE_ONLY) {
    console.log('\n• live pass (real sim, real clock, real gesture)');
    await page.goto(`${base}/?harness=1&quality=high&w=900&h=520`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const booted = await page
      .waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 90000 })
      .then(() => true)
      .catch(() => false);

    if (!booted) {
      console.error('  ✗ game did not boot — cannot run the live pass (see console errors)');
      failed++;
    } else {
      await page.evaluate(async () => {
        const m = await import('/src/audio/AudioEngine.ts');
        const a = new m.AudioEngine();
        window.__game.engine.add(a);
        await a.init(window.__game.engine.context);
        window.__audioProbe = a;
      });
      const before = await page.evaluate(() => window.__audioProbe.stats());
      console.log(`  before gesture: state=${before.state} ready=${before.ready} voices=${before.voices} started=${before.started}`);
      if (before.started !== 0) {
        failed++;
        console.error('  ✗ voices were scheduled before any user gesture');
      }

      // A real gesture. Keyboard, so the click does not fight the RTS camera.
      await page.keyboard.press('KeyM');
      const resumed = await page
        .waitForFunction(() => window.__audioProbe.stats().state === 'running', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      console.log(`  after gesture:  running=${resumed}`);
      if (!resumed) {
        failed++;
        console.error('  ✗ context did not resume after a user gesture');
      }

      live = await page.evaluate(async () => {
        const g = window.__game;
        const probe = window.__audioProbe;
        const ev = g.engine.events;

        // Fast-forward into the melee.
        g.advance(62);
        g.setCamera(0, 0, 0.36, Math.PI * 1.2);

        // First, whatever the combat system is actually producing on its own — that is what
        // calibrates the "how loud should the roar be" normalisation.
        let t0 = performance.now();
        const natural = [];
        for (let f = 0; f < 90; f++) {
          t0 += 16.7;
          g.engine.frame(t0);
          const s = probe.stats();
          natural.push({ v: s.voices + s.musicNotes, hits: s.hitsPerSecond, mi: s.meleeIntensity, cpu: s.cpuMs });
        }
        const nat = {
          maxVoices: Math.max(...natural.map((s) => s.v)),
          avgVoices: natural.reduce((a, s) => a + s.v, 0) / natural.length,
          hitsPerSecond: natural[natural.length - 1].hits,
          meleeIntensity: natural[natural.length - 1].mi,
          cpuMs: Math.max(...natural.map((s) => s.cpu)),
          started: probe.stats().started,
        };

        const samples = [];
        let handlerMs = 0;
        const kinds = ['shield', 'armour', 'flesh', 'parry', 'miss'];
        let t = t0;
        for (let f = 0; f < 120; f++) {
          // 200 blows a frame is the worst case the combat system can produce.
          const h0 = performance.now();
          for (let i = 0; i < 200; i++) {
            const a = (i / 200) * Math.PI * 2;
            ev.emit('meleeHit', {
              x: Math.cos(a) * 40 + Math.sin(f * 0.3) * 8,
              y: 1.4,
              z: Math.sin(a) * 40,
              kind: kinds[i % kinds.length],
              lethal: i % 9 === 0,
              attackerFaction: i & 1,
            });
          }
          if (f % 20 === 0) ev.emit('linesClashed', { x: 0, z: 0, intensity: 1, attackerFaction: 0 });
          handlerMs += performance.now() - h0;
          t += 16.7;
          g.engine.frame(t);
          const s = probe.stats();
          samples.push({ voices: s.voices, notes: s.musicNotes, cpuMs: s.cpuMs });
        }
        const st = probe.stats();
        let vSum = 0;
        let vMax = 0;
        let cpuMax = 0;
        for (const s of samples) {
          vSum += s.voices + s.notes;
          vMax = Math.max(vMax, s.voices + s.notes);
          cpuMax = Math.max(cpuMax, s.cpuMs);
        }
        // Camera to the strategic view and back to eye level, to exercise both extremes.
        g.setCamera(0, 0, 0.95, Math.PI);
        for (let i = 0; i < 30; i++) { t += 16.7; g.engine.frame(t); }
        const strategic = probe.stats();
        g.setCamera(0, 0, 0.05, Math.PI * 1.15);
        for (let i = 0; i < 30; i++) { t += 16.7; g.engine.frame(t); }
        const eyeLevel = probe.stats();

        return {
          natural: nat,
          frames: samples.length,
          eventsEmitted: samples.length * 200,
          avgVoices: vSum / samples.length,
          maxVoices: vMax,
          maxCpuMs: cpuMax,
          cpuMs: st.cpuMs,
          handlerMsPerFrame: handlerMs / samples.length,
          started: st.started,
          culled: st.culled,
          stolen: st.stolen,
          voiceCap: st.voiceCap,
          buildMs: st.buildMs,
          buffers: st.buffers,
          bufferMB: st.bufferBytes / (1024 * 1024),
          cue: st.cue,
          intensity: st.intensity,
          meleeIntensity: st.meleeIntensity,
          hitsPerSecond: st.hitsPerSecond,
          emitters: st.emitters,
          beds: st.beds,
          strategic: { voices: strategic.voices, beds: strategic.beds, cpuMs: strategic.cpuMs },
          eyeLevel: { voices: eyeLevel.voices, beds: eyeLevel.beds, cpuMs: eyeLevel.cpuMs },
        };
      });

      console.log(`  synthesis: ${live.buildMs.toFixed(1)} ms, ${live.buffers} buffers, ${live.bufferMB.toFixed(1)} MB`);
      console.log(`  unmodified combat at t+62..64s (whatever the sim emits by itself):`);
      console.log(`    voices avg ${live.natural.avgVoices.toFixed(1)} max ${live.natural.maxVoices}, ` +
        `${live.natural.started} one-shots started, hits/s ${live.natural.hitsPerSecond.toFixed(0)}, ` +
        `melee ${num(live.natural.meleeIntensity)}, cpu ${live.natural.cpuMs.toFixed(3)} ms`);
      console.log(`  ${live.eventsEmitted} melee events over ${live.frames} frames:`);
      console.log(`    voices  avg ${live.avgVoices.toFixed(1)}  max ${live.maxVoices} (cap ${live.voiceCap})`);
      console.log(`    started ${live.started}  culled ${live.culled}  stolen ${live.stolen}`);
      console.log(`    audio main-thread cost ${live.cpuMs.toFixed(3)} ms/frame (peak EMA ${live.maxCpuMs.toFixed(3)} ms)`);
      console.log(`    event-handler cost ${live.handlerMsPerFrame.toFixed(3)} ms/frame for 200 hits`);
      console.log(`    cue=${live.cue} intensity=${num(live.intensity)} melee=${num(live.meleeIntensity)} ` +
        `hits/s=${live.hitsPerSecond.toFixed(0)} emitters=${live.emitters} beds=${live.beds}`);
      console.log(`    strategic zoom: ${live.strategic.voices} voices, ${live.strategic.beds} beds, ${live.strategic.cpuMs.toFixed(3)} ms`);
      console.log(`    eye level:      ${live.eyeLevel.voices} voices, ${live.eyeLevel.beds} beds, ${live.eyeLevel.cpuMs.toFixed(3)} ms`);

      if (live.maxVoices > live.voiceCap) {
        failed++;
        console.error(`  ✗ voice cap breached: ${live.maxVoices} > ${live.voiceCap}`);
      }
      if (live.cpuMs + live.handlerMsPerFrame > 1.5) {
        failed++;
        console.error(`  ✗ audio main-thread budget breached: ${(live.cpuMs + live.handlerMsPerFrame).toFixed(3)} ms > 1.5 ms`);
      }
    }
  }

  if (consoleErrors.length) {
    failed++;
    console.error(`\n⚠ ${consoleErrors.length} console error(s):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.error(`   ${e}`);
  }
} catch (err) {
  failed++;
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ report, live, consoleErrors }, null, 2));
}
console.log(failed ? `\n✗ audio self-test failed (${failed})` : '\n✓ audio self-test passed');
process.exit(failed > 0 ? 1 : 0);
