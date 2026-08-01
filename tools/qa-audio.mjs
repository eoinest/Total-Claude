#!/usr/bin/env node
/**
 * QA: audio in the *integrated* build.
 *
 * `src/audio/audio-selftest.mjs`'s live pass cannot run — it does
 * `engine.add(new AudioEngine())` against an engine where `src/main.ts` already
 * registered one, and `Engine.add` throws on a duplicate name. So the live half of the
 * audio system had never executed. This driver instead resolves the *already registered*
 * subsystem through `engine.context.tryGet('audio')` and drives that.
 *
 * Three passes:
 *   1. no-AudioContext — `AudioContext` deleted before any module loads. The game must
 *      boot and run with zero console errors.
 *   2. suspended — a normal headless boot with no user gesture. No voices may be
 *      scheduled, nothing may throw, and a long fast-forward through heavy combat must
 *      stay silent and clean.
 *   3. resumed — a real synthetic click resumes the context, then concurrent voices are
 *      sampled with the synthetic clock paced to wall clock (the mixer retires voices on
 *      `ctx.currentTime`, so a burst fast-forward would inflate the count).
 *
 * Usage: node tools/qa-audio.mjs [--port=5223] [--json=path]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5223);
const JSON_OUT = args.get('json') ?? null;

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

// Headless Chromium autoplays by default, which silently skips the entire
// suspended-context path — the one the real harness and every first page load hit. Force
// the policy a real browser applies so "no gesture yet" is genuinely exercised.
const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=user-gesture-required',
  ],
});

let failed = 0;
const report = { noContext: null, suspended: null, resumed: null, failures: [], warnings: [] };
const fail = (m) => { failed++; report.failures.push(m); console.error(`  ✗ ${m}`); };
const warn = (m) => { report.warnings.push(m); console.log(`  ~ ${m}`); };

/** A page with console/pageerror capture. */
async function newPage(initScript) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning' && /\[audio\]/.test(m.text())) errors.push(`WARN ${m.text()}`);
  });
  if (initScript) await page.addInitScript(initScript);
  return { page, errors };
}

// ---------------------------------------------------------------------------
// Pass 1: no AudioContext at all
// ---------------------------------------------------------------------------
console.log('• pass 1: AudioContext unavailable');
{
  const { page, errors } = await newPage(() => {
    // Remove Web Audio entirely before any module evaluates.
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
    Object.defineProperty(globalThis, 'AudioContext', { get() { return undefined; }, configurable: true });
  });
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
  const booted = await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 120000 })
    .then(() => true).catch(() => false);
  if (!booted) fail('game did not boot with AudioContext removed');
  else {
    const s = await page.evaluate(() => {
      const a = window.__game.engine.context.tryGet('audio');
      window.__game.advance(20);      // drive real frames with audio unavailable
      return a ? a.stats() : null;
    });
    report.noContext = { stats: s, errors: [...new Set(errors)] };
    console.log(`  available=${s?.available} ready=${s?.ready} state=${s?.state} voices=${s?.voices}`);
    if (s?.available !== false) fail(`audio reported available=${s?.available} with no AudioContext`);
    if (errors.length) fail(`${errors.length} console error(s) with AudioContext removed: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
    else console.log('  ✓ booted and ran 20 s of sim with zero console errors');
  }
  await page.close();
}

// ---------------------------------------------------------------------------
// Pass 2 + 3: suspended, then resumed
// ---------------------------------------------------------------------------
console.log('\n• pass 2: suspended context, no user gesture');
const { page, errors } = await newPage(null);
await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
if (!await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 120000 }).then(() => true).catch(() => false)) {
  fail('game did not boot');
} else {
  const pre = await page.evaluate(() => {
    const a = window.__game.engine.context.tryGet('audio');
    // Take the rAF loop out of the picture: otherwise wall-clock time spent in Playwright
    // round-trips advances the sim behind our back and every checkpoint drifts (a t+2
    // request landed at t+77 before this).
    window.__game.engine.stop();
    // 60 s of heavy combat with the context suspended: nothing may schedule or throw.
    window.__game.advance(60);
    return { stats: a.stats(), hasProbe: typeof globalThis.__audio !== 'undefined' };
  });
  report.suspended = { stats: pre.stats, errors: [...new Set(errors)] };
  console.log(`  available=${pre.stats.available} ready=${pre.stats.ready} state="${pre.stats.state}" ` +
    `started=${pre.stats.started} voices=${pre.stats.voices} sampleRate=${pre.stats.sampleRate}`);
  if (pre.stats.started !== 0) fail(`${pre.stats.started} voices scheduled before any user gesture`);
  if (pre.stats.ready !== false) warn(`ready=true before a gesture (state="${pre.stats.state}") — headless Chromium allowed autoplay`);
  if (errors.length) fail(`${errors.length} console error(s) while suspended: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
  else console.log('  ✓ 60 s of combat with a suspended context: zero errors, zero voices');

  // ---- resume with a real gesture ----
  // Fresh load so the sim clock starts at 0 and the t+2 checkpoint is really t+2.
  console.log('\n• pass 3: real click gesture, then resume (fresh load)');
  const before = errors.length;
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 120000 });
  await page.evaluate(() => window.__game.engine.stop());
  await page.mouse.click(480, 500);
  const resumed = await page.waitForFunction(
    () => window.__game.engine.context.tryGet('audio').stats().state === 'running', { timeout: 20000 }
  ).then(() => true).catch(() => false);
  if (!resumed) {
    const s = await page.evaluate(() => window.__game.engine.context.tryGet('audio').stats());
    fail(`context did not resume after a click (state="${s.state}" ready=${s.ready})`);
  }
  const s0 = await page.evaluate(() => window.__game.engine.context.tryGet('audio').stats());
  console.log(`  state="${s0.state}" ready=${s0.ready} sampleRate=${s0.sampleRate} ` +
    `buffers=${s0.buffers} ${(s0.bufferBytes / 1048576).toFixed(1)} MB built in ${s0.buildMs.toFixed(0)} ms`);
  if (s0.buffers === 0) fail('no sound buffers were synthesised after resume');

  // ---- concurrent voices at the three checkpoints ----
  // The mixer retires voices on `ctx.currentTime`, so the synthetic clock has to be paced
  // to wall clock or the count is meaningless.
  const checkpoints = [2, 90, 196];
  const measured = [];
  for (const at of checkpoints) {
    const m = await page.evaluate(async (target) => {
      const g = window.__game;
      const a = g.engine.context.tryGet('audio');
      const need = target - g.simTime();
      if (need > 0.05) g.advance(need);
      g.setCamera(0, 0, 0.3, Math.PI * 1.2);

      // Paced loop: step the engine by the real elapsed time so audio scheduling and
      // voice retirement happen at 1:1 with the AudioContext clock.
      let t = g.engine.time.elapsed * 1000;
      let wall = performance.now();
      const v = [];
      const deadline = performance.now() + 1800;
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 8));
        const now = performance.now();
        t += Math.min(50, now - wall);
        wall = now;
        g.engine.frame(t);
        const s = a.stats();
        v.push(s.voices + s.musicNotes);
      }
      const s = a.stats();
      // `__audio` is the DEV probe the mixer publishes; it is the only way to see how the
      // 40-voice spatial pool is split between persistent loops and one-shots.
      const mx = globalThis.__audio?.mixer ?? null;
      return {
        at: g.simTime(),
        samples: v.length,
        avg: v.reduce((x, y) => x + y, 0) / Math.max(1, v.length),
        max: Math.max(...v),
        min: Math.min(...v),
        voices: s.voices, musicNotes: s.musicNotes, beds: s.beds, emitters: s.emitters,
        loops: mx ? mx.loopCount : -1,
        oneShots: mx ? mx.activeVoices - mx.loopCount : -1,
        peakVoices: s.peakVoices, voiceCap: s.voiceCap,
        started: s.started, culled: s.culled, stolen: s.stolen,
        hitsPerSecond: s.hitsPerSecond, meleeIntensity: s.meleeIntensity,
        intensity: s.intensity, cue: s.cue, cpuMs: s.cpuMs,
      };
    }, at);
    measured.push({ requested: at, ...m });
    console.log(`  t+${String(Math.round(m.at)).padStart(3)}s  voices avg ${m.avg.toFixed(1)} ` +
      `min ${m.min} max ${m.max} (cap ${m.voiceCap})  [${m.oneShots} one-shot + ${m.loops} loop + ${m.musicNotes} music]  ` +
      `beds ${m.beds}  emitters ${m.emitters}`);
    console.log(`          hits/s ${m.hitsPerSecond.toFixed(0)}  melee ${m.meleeIntensity.toFixed(3)}  ` +
      `intensity ${m.intensity.toFixed(3)}  cue=${m.cue}  started ${m.started} culled ${m.culled} stolen ${m.stolen}  ` +
      `cpu ${m.cpuMs.toFixed(3)} ms`);
    if (m.max > m.voiceCap) fail(`voice cap breached at t+${at}: ${m.max} > ${m.voiceCap}`);
  }

  // ---- 200 meleeHit per frame: clustering ----
  const storm = await page.evaluate(async () => {
    const g = window.__game;
    const a = g.engine.context.tryGet('audio');
    const ev = g.engine.events;
    const kinds = ['shield', 'armour', 'flesh', 'parry', 'miss'];
    const s0 = a.stats();
    let t = g.engine.time.elapsed * 1000;
    let wall = performance.now();
    const v = [];
    let handlerMs = 0;
    let frames = 0;
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 8));
      const h0 = performance.now();
      for (let i = 0; i < 200; i++) {
        const ang = (i / 200) * Math.PI * 2;
        ev.emit('meleeHit', {
          x: Math.cos(ang) * 40 + Math.sin(frames * 0.3) * 8, y: 1.4, z: Math.sin(ang) * 40,
          kind: kinds[i % kinds.length], lethal: i % 9 === 0, attackerFaction: i & 1,
        });
      }
      handlerMs += performance.now() - h0;
      const now = performance.now();
      t += Math.min(50, now - wall);
      wall = now;
      g.engine.frame(t);
      frames++;
      const s = a.stats();
      v.push(s.voices + s.musicNotes);
    }
    const s1 = a.stats();
    return {
      frames, events: frames * 200,
      avgVoices: v.reduce((x, y) => x + y, 0) / Math.max(1, v.length),
      maxVoices: Math.max(...v), voiceCap: s1.voiceCap,
      startedDelta: s1.started - s0.started,
      culledDelta: s1.culled - s0.culled,
      stolenDelta: s1.stolen - s0.stolen,
      beds: s1.beds, emitters: s1.emitters,
      handlerMsPerFrame: handlerMs / Math.max(1, frames),
      cpuMs: s1.cpuMs,
    };
  });
  console.log(`\n  clustering storm: ${storm.events} meleeHit over ${storm.frames} frames`);
  console.log(`    voices avg ${storm.avgVoices.toFixed(1)} max ${storm.maxVoices} (cap ${storm.voiceCap})  beds ${storm.beds}`);
  console.log(`    one-shots started ${storm.startedDelta} = ${(storm.startedDelta / storm.events * 100).toFixed(2)}% of events` +
    `  (${(storm.startedDelta / storm.frames).toFixed(2)}/frame)  culled ${storm.culledDelta}  stolen ${storm.stolenDelta}`);
  console.log(`    handler cost ${storm.handlerMsPerFrame.toFixed(3)} ms/frame for 200 hits, audio EMA ${storm.cpuMs.toFixed(3)} ms`);
  if (storm.maxVoices > storm.voiceCap) fail(`voice cap breached under storm: ${storm.maxVoices} > ${storm.voiceCap}`);
  if (storm.startedDelta / storm.frames > 20) fail(`clustering ineffective: ${(storm.startedDelta / storm.frames).toFixed(1)} voices/frame from 200 events`);
  if (storm.handlerMsPerFrame + storm.cpuMs > 1.5) fail(`audio main-thread budget breached: ${(storm.handlerMsPerFrame + storm.cpuMs).toFixed(3)} ms > 1.5 ms`);

  const after = errors.slice(before);
  report.resumed = { stats: s0, checkpoints: measured, storm, errors: [...new Set(after)] };
  if (after.length) fail(`${after.length} console error(s) after resume: ${[...new Set(after)].slice(0, 6).join(' | ')}`);
  else console.log('\n  ✓ zero console errors across the whole resumed run');
}

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
console.log(failed ? `\n✗ audio QA: ${failed} failure(s)` : '\n✓ audio QA clean');
process.exit(failed ? 1 : 0);
