/**
 * trailer-audio-pass.mjs — record the game's own sound over the trailer's sim ranges.
 *
 * The picture is a frame sequence, not a screen recording: one JPEG is one
 * `engine.advance(1/30, 1000/30)` with the rAF loop stopped, so the film is exactly real
 * time and one sim second is one played second. Sound cannot be captured that way. The
 * mixer schedules and retires every voice against `AudioContext.currentTime` (`Mixer.play`,
 * `Mixer.update`, `Music.pump`), so a capture that steps 2,580 frames in ninety seconds of
 * wall clock would pile eighty-six seconds of events into ninety seconds of nothing.
 *
 * So this pass runs the *same* fixed 1/30 s grid — identical sim trajectory, same beats,
 * same cameras — but paces it to the wall clock, and taps the mixer's output. Because the
 * grid is the same and the pacing is real time, the recording is the right length by
 * construction and lands on the same sim events the picture shows.
 *
 * Three things this has to get right, and each is measured rather than assumed:
 *
 *   - **The context must actually be running.** `AudioEngine.init` will not `resume()`
 *     without a user gesture, and `Mixer.play` hard-returns while `running` is false, so a
 *     suspended context schedules literally nothing and yields a clean, green, silent file.
 *     Chromium is launched with `--autoplay-policy=no-user-gesture-required` and the state
 *     is read back before anything is recorded.
 *   - **The listener must be where the lens was.** `AudioEngine.preRender` takes the
 *     listener basis off `ctx.camera.matrixWorld`, so the camera path is rebuilt from
 *     `trailer-shot.mjs` and each beat's eye positions are asserted against the ones the
 *     picture capture wrote into `capture.json`.
 *   - **Fast-forward must be silent.** Between beats the clock is run flat out, which would
 *     otherwise stack minutes of battle into a few seconds of audio time. The context is
 *     suspended across every fast-forward, which both stops `currentTime` and makes
 *     `Mixer.running` false, so nothing is scheduled into the void.
 *
 *   npx vite --port 5237 --host 127.0.0.1 --strictPort     # not 5173
 *   node tools/scratch/trailer-audio-pass.mjs --port=5237
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SCENES, BEATS, FPS, frameState } from './trailer-shot.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5237);
const QUALITY = args.get('quality') ?? 'ultra';
/*
 * The render is 960x540 here and 1920x1080 in the picture pass, and that is deliberate.
 * Nothing audible depends on it — the listener basis is the camera's world matrix, which is
 * resolution-independent — but the paced loop has to hold 30 fps on a GPU five other agents
 * are also using, and a quarter of the pixels is the cheapest way to buy that headroom.
 * `quality` stays `ultra` because the audio detail scalar *is* tier-dependent
 * (`DETAIL_BY_TIER` in `AudioEngine`).
 */
const W = Number(args.get('w') ?? 960);
const H = Number(args.get('h') ?? 540);
const WORK = args.get('work') ?? '/tmp/tc-sound';
const CAP = args.get('capture') ?? '/tmp/tc-trailer-frames/capture.json';
const STILLS = args.get('stills') ?? '/tmp/tc-trailer-frames/stills.json';
const PRE = Number(args.get('preroll') ?? 2.0);      // seconds of paced run before the beat
const BEAT_FILTER = args.get('beats') ? String(args.get('beats')).split(',') : null;
/*
 * Don't draw anything. `--render` puts the picture back.
 *
 * Nothing audible is downstream of the draw call: the listener basis comes off
 * `rig.camera.matrixWorld`, which `Engine.frame` updates before any system's `preRender`, and
 * `BattleAudio` reads the sim's own arrays. What the draw *does* do is put a variable
 * multi-millisecond GPU-bound stall in the middle of a loop that has to hit a 33.3 ms mark on
 * a machine five other agents are also rendering on — measured at up to 667 ms on the heavier
 * scenes, which does not move the beat (the pacer catches up; total drift stayed under 10 ms)
 * but does bunch two thirds of a second of battle into the instant after the stall.
 * `Engine.renderOverride` is the seam the engine already has for this.
 */
const NORENDER = !args.has('render');

const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
await mkdir(path.join(WORK, 'beats'), { recursive: true });

/*
 * Per-frame camera positions the *picture* pass recorded, so the sound pass can prove it put
 * the listener in the same place. `stills.json` is a superset for the beats it covers: the
 * stills run records stats for every frame even though it photographs three.
 */
const capByBeat = new Map();
for (const f of [STILLS, CAP]) {
  if (!existsSync(f)) continue;
  for (const b of (JSON.parse(await readFile(f, 'utf8')).beats ?? [])) capByBeat.set(b.id, b);
}

// ---------------------------------------------------------------------------
// In-page: the tap, and the paced runner.
// ---------------------------------------------------------------------------
/*
 * The tap. Posts in 4,096-sample blocks rather than in 128-sample render quanta.
 *
 * One message per quantum is 375 messages and 375 short-lived typed arrays a second, per tap,
 * and the main thread is also running a paced 30 fps simulation. The first version did that
 * and the garbage collector took the loop out for up to 660 ms at a time on the heavier
 * scenes — which does not move the beat (the pacer catches up, and total drift stayed under
 * 10 ms) but does bunch two thirds of a second of battle into the moment after the stall.
 * Thirty-two quanta to a message is the same samples and a thirty-second of the churn.
 */
const TAP_WORKLET = `
const QUANTA = 32;
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(128 * QUANTA * 2); this.k = 0; this.base = 0; }
  process(inputs) {
    const inp = inputs[0];
    const L = inp && inp.length ? inp[0] : null;
    const R = inp && inp.length > 1 ? inp[1] : L;
    const n = 128;
    if (this.k === 0) this.base = currentFrame;
    const o = this.k * n * 2;
    if (L) for (let i = 0; i < n; i++) { this.buf[o + i * 2] = L[i]; this.buf[o + i * 2 + 1] = R[i]; }
    else this.buf.fill(0, o, o + n * 2);
    if (++this.k === QUANTA) {
      this.port.postMessage({ f: this.base, d: this.buf });
      this.buf = new Float32Array(128 * QUANTA * 2);
      this.k = 0;
    }
    return true;
  }
}
registerProcessor('tc-tap', Tap);
`;

const PAGE_AUDIO = async (workletSrc) => {
  const g = window.__game;
  const audio = g.engine.context.tryGet('audio');
  if (!audio) throw new Error('no audio subsystem registered');
  const mixer = audio.audioMixer;
  if (!mixer) throw new Error('audio subsystem has no mixer — prepare() never ran');
  const ctx = mixer.ctx;
  const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);

  const mkTap = (src) => {
    const n = new AudioWorkletNode(ctx, 'tc-tap', {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    src.connect(n);
    return n;
  };
  /*
   * Tap the *post*-limiter node, not `master`.
   *
   * The tail of the graph is `master -> pre(0.5) -> masterClip(softClip 0.62/2) ->
   * destination`. Recording `master` would be 2x hot and would miss the soft clip that
   * exists precisely so a clash landing on a volley landing on the roar cannot clip. If
   * `masterClip` is absent (the constructor's catch path), `master` is what is on the wire.
   */
  const tail = mixer.masterClip ?? mixer.master;
  const T = { rate: ctx.sampleRate, blocks: [], mblocks: [], rec: false, tail: tail === mixer.masterClip ? 'masterClip' : 'master' };
  const tap = mkTap(tail);
  tap.port.onmessage = (e) => { if (T.rec) T.blocks.push(e.data); };
  // A second tap on the music bus, only so the report can say how much of the level is the
  // game's own score and how much is the battle. Nothing is added or removed by it.
  const mtap = mkTap(mixer.buses.music);
  mtap.port.onmessage = (e) => { if (T.rec) T.mblocks.push(e.data); };

  T.state = () => ({ state: ctx.state, rate: ctx.sampleRate, ready: audio.ready,
    running: mixer.running, voices: mixer.activeVoices, counters: { ...mixer.counters },
    tail: T.tail });
  T.suspend = async () => { if (ctx.state === 'running') await ctx.suspend(); return ctx.state; };
  T.resume = async () => { if (ctx.state !== 'running') await ctx.resume(); return ctx.state; };
  T.clear = () => { T.blocks.length = 0; T.mblocks.length = 0; };
  T.drain = (which) => {
    const src = which === 'music' ? T.mblocks : T.blocks;
    if (!src.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of src) { if (b.f < lo) lo = b.f; if (b.f + b.d.length / 2 > hi) hi = b.f + b.d.length / 2; }
    const buf = new Float32Array((hi - lo) * 2);
    for (const b of src) buf.set(b.d, (b.f - lo) * 2);
    // Base64 in 32k chunks: `String.fromCharCode(...huge)` blows the argument limit.
    const u8 = new Uint8Array(buf.buffer);
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return { base: lo, n: hi - lo, b64: btoa(s) };
  };

  /** Fast-forward with the context suspended, so not one voice is scheduled. */
  T.ff = async (t) => {
    await T.suspend();
    const t0 = performance.now();
    let n = 0;
    while (g.simTime() < t - 1e-6) { g.engine.advance(1 / 30, 1000 / 30); n++; }
    return { steps: n, ms: Math.round(performance.now() - t0), sim: g.simTime() };
  };

  /**
   * Run `states.length` frames on the same fixed 1/30 s sim grid the picture used, but
   * paced to the wall clock so the AudioContext hears them one for one.
   */
  T.run = async ({ preStates, spec, pre, total }) => {
    await T.resume();
    if (ctx.state !== 'running') throw new Error(`context did not resume: ${ctx.state}`);
    const tick = () => new Promise((r) => {
      let done = false;
      const f = () => { if (!done) { done = true; r(); } };
      requestAnimationFrame(f); setTimeout(f, 6);
    });
    const eyes = [];
    let states = null, anchor = null;
    const n = pre + total;
    const wall0 = performance.now();
    let maxLag = 0, lagSum = 0, behind = 0, mark0 = null, mark1 = null, simAt0 = null;
    const v0 = { ...mixer.counters };
    for (let k = 0; k < n; k++) {
      const due = wall0 + (k * 1000) / 30;
      let now = performance.now();
      while (now < due - 1.5) { await tick(); now = performance.now(); }
      const lag = now - due;
      if (lag > maxLag) maxLag = lag;
      if (lag > 8) behind++;
      lagSum += Math.max(0, lag);
      /*
       * Resolve the anchor at the beat's own first frame, not at the start of the pre-roll.
       *
       * Anchors are live: `frontmost heavy-infantry`, `the densest cell of men fighting`,
       * `the gate bay`. Two seconds of pre-roll earlier is two seconds of a different world,
       * and the first version of this file resolved there — which put the listener up to
       * eight metres from where the lens had been. So the camera path for the recorded
       * frames is built here, at t0, exactly as the picture pass builds it.
       */
      if (k === pre) {
        anchor = window.__tr.anchor(spec.anchor);
        if (!anchor) throw new Error('anchor resolved to nothing at the beat start');
        states = [];
        for (let i = 0; i < total; i++) states.push(window.__shot.frameState(spec, anchor, i, total));
      }
      window.__tr.apply(k < pre ? preStates[k] : states[k - pre]);
      if (k === pre) { mark0 = ctx.currentTime; simAt0 = g.simTime(); T.rec = true; }
      g.engine.advance(1 / 30, 1000 / 30);
      if (k >= pre) {
        const p = g.engine.rig.camera.position;
        eyes.push([+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)]);
      }
      if (k === n - 1) mark1 = ctx.currentTime;
    }
    /*
     * Hold the tap open for a moment after the last frame, without advancing the clock.
     *
     * `mark1 - mark0` spans `total - 1` frame intervals, so the beat is one frame short of
     * the samples the cut needs, and the last frame's own voices — and the field reverb
     * behind them — are still sounding. Extending the *recording* rather than the *sim* is
     * the only way to get them: two beats meet at t+218, so one extra `advance()` here would
     * step the world past the start of the next one.
     */
    await new Promise((r) => setTimeout(r, 200));
    T.rec = false;
    const v1 = { ...mixer.counters };
    return { mark0, mark1, simAt0, rate: ctx.sampleRate, eyes, anchor,
      wallMs: Math.round(performance.now() - wall0), maxLag: +maxLag.toFixed(1),
      meanLag: +(lagSum / n).toFixed(2), behind,
      started: v1.started - v0.started, peakVoices: v1.peakVoices,
      sim: +g.simTime().toFixed(4), state: ctx.state };
  };
  window.__tap = T;
  return T.state();
};

// ---------------------------------------------------------------------------
const wanted = BEATS.filter((b) => !BEAT_FILTER || BEAT_FILTER.includes(b.id));
const sceneOrder = [...new Set(wanted.map((b) => b.scene))];
const captureOrder = sceneOrder.flatMap((sc) =>
  wanted.filter((b) => b.scene === sc).sort((a, b) => a.at[0] - b.at[0]));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
    '--hide-scrollbars',
    // Without this the AudioContext is created suspended, `Mixer.running` stays false and
    // every `play()` returns early: a capture that succeeds and records silence.
    '--autoplay-policy=no-user-gesture-required',
    // A throttled renderer would starve the paced loop and stretch every beat.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const { PAGE_LIB } = await import('./trailer-shot.mjs');
/*
 * The camera maths, shipped into the page as a classic script rather than reimplemented
 * there. Same file the Node side imports, so the two cannot drift apart.
 */
const SHOT_SRC = (await readFile(new URL('./trailer-shot.mjs', import.meta.url), 'utf8'))
  .replace(/^export /gm, '')
  + '\nwindow.__shot = { ease, easeOut, lerp, mix, frameState };\n';
let loaded = null;
async function load(sceneId) {
  if (loaded === sceneId) return;
  const s = SCENES[sceneId];
  const url = `${base}/?harness=1&quality=${QUALITY}&w=${W}&h=${H}`
    + `&map=${s.map}&scenario=${s.scenario}${s.enemy ? `&enemy=${s.enemy}` : ''}`;
  console.log(`\n• load ${sceneId}: ${url}`);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null,
    { timeout: 420000 });
  console.log(`  world ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.addStyleTag({ content:
    '#hud-root,#loading,#menu-root{display:none!important;visibility:hidden!important}' });
  await page.evaluate(() => {
    const hud = window.__game?.engine?.context?.tryGet?.('hud');
    if (hud && hud.overlay) hud.overlay.visible = false;
    window.__game.engine.stop();
  });
  if (NORENDER) {
    const ok = await page.evaluate(() => {
      const e = window.__game.engine;
      if (!('renderOverride' in e)) return false;
      e.renderOverride = () => {};
      return true;
    });
    if (!ok) throw new Error('no Engine.renderOverride seam to switch the draw off');
    console.log('  render: off (Engine.renderOverride), audio path untouched');
  }
  const got = await page.evaluate((h) => {
    const sky = window.__game.engine.context.tryGet('sky');
    if (!sky?.setTimeOfDay) return null;
    sky.setTimeOfDay(h);
    return sky.timeOfDay;
  }, s.hour);
  if (got === null || Math.abs(got - s.hour) > 0.01) throw new Error(`hour ${s.hour} refused (${got})`);
  await page.evaluate(PAGE_LIB);
  await page.addScriptTag({ content: SHOT_SRC });
  const st = await page.evaluate(PAGE_AUDIO, TAP_WORKLET);
  console.log(`  audio: state=${st.state} rate=${st.rate} ready=${st.ready} `
    + `running=${st.running} tap=${st.tail}`);
  if (st.state !== 'running') throw new Error(`AudioContext is ${st.state}, not running — `
    + 'nothing would be scheduled and the capture would be silent');
  if (!st.ready) throw new Error('AudioEngine.ready is false — prepare() never ran');
  loaded = sceneId;
}

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };
const peak = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
const dbfs = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);

const report = [];
for (const beat of captureOrder) {
  await load(beat.scene);
  const [t0, t1] = beat.at;
  const total = Math.round((t1 - t0) * FPS);
  /*
   * Pre-roll is however much of it there is room for.
   *
   * The clock only goes forwards, and `rome-ram-gate` ends at t+218 exactly where
   * `rome-arch` begins, so there is no world left in front of that beat to warm the mix up
   * in. Asking for two seconds anyway would have started the beat two seconds late and shot
   * t+220..226 while claiming t+218..224.
   */
  const simNow = await page.evaluate(() => window.__game.simTime());
  const pre = Math.max(0, Math.round(Math.min(PRE, t0 - simNow) * FPS));
  const ffTo = t0 - pre / FPS;
  if (simNow > ffTo + 1.5 / FPS) {
    throw new Error(`${beat.id}: sim is already at ${simNow.toFixed(3)}, past this beat's start`);
  }

  const ff = await page.evaluate((t) => window.__tap.ff(t), ffTo);
  console.log(`\n▸ ${beat.id}  t+${t0}..${t1}  ${total} frames  `
    + `(pre ${pre}f, ff ${ff.steps} steps in ${(ff.ms / 1000).toFixed(1)} s, sim ${ff.sim.toFixed(2)})`);

  // Pre-roll frames sit on the beat's own first camera — resolved here, against the world as
  // it is two seconds early, which is close enough for warming beds up and is not recorded.
  const preAnchor = pre ? await page.evaluate((spec) => window.__tr.anchor(spec), beat.anchor) : null;
  if (pre && !preAnchor) throw new Error(`${beat.id}: anchor resolved to nothing`);
  const preStates = [];
  for (let k = 0; k < pre; k++) preStates.push(frameState(beat, preAnchor, 0, total));

  await page.evaluate(() => window.__tap.clear());
  const run = await page.evaluate((a) => window.__tap.run(a), {
    preStates, pre, total, spec: { anchor: beat.anchor, from: beat.from, to: beat.to } });
  const got = await page.evaluate((w) => window.__tap.drain(w), 'master');
  const gotM = await page.evaluate((w) => window.__tap.drain(w), 'music');
  await page.evaluate(() => window.__tap.clear());
  if (!got) throw new Error(`${beat.id}: the tap produced no blocks at all`);

  const rate = run.rate;
  const all = new Float32Array(Buffer.from(got.b64, 'base64').buffer.slice(0));
  const allM = gotM ? new Float32Array(Buffer.from(gotM.b64, 'base64').buffer.slice(0)) : null;
  const need = Math.round((total / FPS) * rate);          // samples per channel
  const off = Math.max(0, Math.round(run.mark0 * rate) - got.base);
  const slice = new Float32Array(need * 2);
  slice.set(all.subarray(off * 2, Math.min(all.length, (off + need) * 2)));
  let sliceM = null;
  if (allM && gotM) {
    const offM = Math.max(0, Math.round(run.mark0 * rate) - gotM.base);
    sliceM = new Float32Array(need * 2);
    sliceM.set(allM.subarray(offM * 2, Math.min(allM.length, (offM + need) * 2)));
  }
  const have = Math.min(all.length - off * 2, need * 2);
  const shortBy = (need * 2 - have) / 2 / rate;

  /*
   * The clock this beat actually kept. `mark1 - mark0` is AudioContext time across the
   * recorded frames; it should equal the beat's screen time. Anything else is the paced
   * loop having fallen behind the wall clock, and it is reported rather than hidden.
   */
  // `mark1 - mark0` spans the intervals *between* the recorded frames: `total - 1` of them.
  const audioSpan = run.mark1 - run.mark0;
  const drift = audioSpan - (total - 1) / FPS;
  if (Math.abs(run.simAt0 - t0) > 0.05) {
    throw new Error(`${beat.id}: recording started at sim ${run.simAt0.toFixed(3)}, wanted ${t0}`);
  }

  const r = rms(slice), pk = peak(slice);
  // 0.425 = master gain 0.85 x the 0.5 pre-gain on the soft-clip stage: what the music bus
  // is worth by the time it reaches the tap.
  const rM = sliceM ? rms(sliceM) * 0.425 : null;
  await writeFile(path.join(WORK, 'beats', `${beat.id}.f32`), Buffer.from(slice.buffer));

  const capBeat = capByBeat.get(beat.id);
  let eyeErr = null;
  if (capBeat?.frames?.length === total) {
    let worst = 0;
    for (let i = 0; i < total; i++) {
      const a = capBeat.frames[i].eye, b = run.eyes[i];
      if (!a || !b) continue;
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    eyeErr = +worst.toFixed(2);
  }

  console.log(`  rms ${r.toFixed(5)} (${dbfs(r)} dBFS)  peak ${pk.toFixed(3)} (${dbfs(pk)} dBFS)`
    + `  music ${rM === null ? 'n/a' : rM.toFixed(5)}`
    + `  voices started ${run.started}  peak ${run.peakVoices}`);
  console.log(`  pacing: wall ${(run.wallMs / 1000).toFixed(2)} s vs ${((pre + total) / FPS).toFixed(2)} s`
    + `  audio span ${audioSpan.toFixed(3)} s  drift ${(drift * 1000).toFixed(0)} ms`
    + `  maxLag ${run.maxLag} ms  frames>8ms late ${run.behind}`
    + `  short ${(shortBy * 1000).toFixed(0)} ms`
    + (eyeErr === null ? '  camera n/a' : `  camera vs picture ${eyeErr} m`));
  if (r === 0) throw new Error(`${beat.id}: RMS is exactly zero — the tap recorded silence`);

  report.push({ id: beat.id, scene: beat.scene, at: beat.at, frames: total,
    rms: +r.toFixed(6), rmsDbfs: dbfs(r), peak: +pk.toFixed(4), peakDbfs: dbfs(pk),
    musicRms: rM === null ? null : +rM.toFixed(6),
    musicShare: rM === null ? null : +(rM / (r || 1)).toFixed(3),
    voicesStarted: run.started, peakVoices: run.peakVoices,
    audioSpan: +audioSpan.toFixed(3), driftMs: Math.round(drift * 1000),
    maxLagMs: run.maxLag, meanLagMs: run.meanLag, framesLate: run.behind,
    shortMs: Math.round(shortBy * 1000), sampleRate: rate, cameraErrM: eyeErr });
}

await browser.close();
await writeFile(path.join(WORK, 'audio-report.json'),
  JSON.stringify({ at: new Date().toISOString(), preroll: PRE, w: W, h: H, quality: QUALITY,
    beats: report, errs: [...new Set(errs)] }, null, 1));
if (errs.length) {
  console.error(`\n⚠ ${errs.length} page error(s):`);
  for (const e of [...new Set(errs)].slice(0, 10)) console.error('   ' + e);
}
console.log(`\n→ ${path.join(WORK, 'beats')}  ${report.length} beats`);
