/**
 * gc-collapse-audio.mjs — record the game's own output across the gate collapse and measure it.
 *
 * The point of this file is that it does not read the code to decide whether the gate makes
 * a sound. It puts a tap on the node that feeds the speakers, runs the real simulation past
 * the real event at real time, and reports RMS and peak per quarter-second either side of it.
 * A silent capture that "should" have played is the failure this project keeps shipping, so
 * the AudioContext's state is asserted rather than assumed, the tap is the post-limiter node
 * the listener would actually hear, and every fast-forward happens with the context suspended
 * so a hundred seconds of battle cannot be stacked into two seconds of audio time.
 *
 * Structure is lifted from `tools/scratch/trailer-audio-pass.mjs`, which established all of
 * the above; what is new here is the per-frame siege telemetry, so the cue can be timestamped
 * against `gateReport()` rather than against the wall clock.
 *
 *   node tools/scratch/gc-collapse-audio.mjs --port=5344 --quality=low --windows=203:228
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5344);
const QUALITY = args.get('quality') ?? 'low';
const MAP = args.get('map') ?? 'campus-martius';
const WORK = args.get('work') ?? '/tmp/gc-audio';
/*
 * `--mute=gate_collapse` deletes the buffer from the bank before the run, which makes
 * `Mixer.play` hard-return at its `bank.get(id)` lookup — bit for bit the state of `main`,
 * where the recipe does not exist. The simulation is untouched, so the same window can be
 * captured twice and the difference is the sound and nothing else. Inferring the collapse's
 * contribution from one recording of a whole battle would be exactly the kind of reasoning
 * this file exists to avoid.
 */
/*
 * `--greatram` sends a great ram at a curtain bay, because nothing in `src/` ever does.
 * `spawnGreatRam` has no caller outside the player's own machine order (`ui/SiegeOrders.ts`
 * -> `requestMachineOrder('greatRam', ...)`), so the breach is reachable in play and never in
 * a default scenario — which is why it has to be driven here to be measured at all. Same call
 * `tools/probe-siege.mjs` uses.
 */
const GREATRAM = args.has('greatram');
const MUTE = args.get('mute') ? String(args.get('mute')).split(',') : [];
const WINDOWS = String(args.get('windows') ?? '203:228').split(',')
  .map((w) => w.split(':').map(Number));
const FPS = 30;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
await mkdir(WORK, { recursive: true });

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
registerProcessor('gc-tap', Tap);
`;

const PAGE = async (workletSrc) => {
  const g = window.__game;
  const audio = g.engine.context.tryGet('audio');
  if (!audio) throw new Error('no audio subsystem registered');
  const mixer = audio.audioMixer;
  if (!mixer) throw new Error('audio subsystem has no mixer — prepare() never ran');
  const ctx = mixer.ctx;
  const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);

  // Post-limiter, exactly what reaches the speakers. `master` would be 2x hot and would
  // miss the soft clip.
  const tail = mixer.masterClip ?? mixer.master;
  const T = { rate: ctx.sampleRate, blocks: [], rec: false,
    tail: tail === mixer.masterClip ? 'masterClip' : 'master' };
  const node = new AudioWorkletNode(ctx, 'gc-tap', {
    numberOfInputs: 1, numberOfOutputs: 0,
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
  });
  tail.connect(node);
  node.port.onmessage = (e) => { if (T.rec) T.blocks.push(e.data); };

  const siege = g.battle.siege;
  T.state = () => ({ state: ctx.state, rate: ctx.sampleRate, ready: audio.ready,
    running: mixer.running, tail: T.tail,
    bank: audio.soundBank ? audio.soundBank.ids.length : 0,
    hasGate: audio.soundBank ? audio.soundBank.has('gate_collapse') : false });

  T.suspend = async () => { if (ctx.state === 'running') await ctx.suspend(); return ctx.state; };
  T.resume = async () => { if (ctx.state !== 'running') await ctx.resume(); return ctx.state; };
  T.clear = () => { T.blocks.length = 0; };
  T.drain = () => {
    if (!T.blocks.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const b of T.blocks) { if (b.f < lo) lo = b.f; if (b.f + b.d.length / 2 > hi) hi = b.f + b.d.length / 2; }
    const buf = new Float32Array((hi - lo) * 2);
    for (const b of T.blocks) buf.set(b.d, (b.f - lo) * 2);
    const u8 = new Uint8Array(buf.buffer);
    let s = '';
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return { base: lo, n: hi - lo, b64: btoa(s) };
  };

  T.telemetry = () => {
    const r = siege.gateReport();
    const rams = siege.ramReport();
    const st = audio.battleLayers ? audio.battleLayers.stats() : null;
    return {
      t: +g.simTime().toFixed(4),
      open: r.open, breached: r.breached, blows: r.blows,
      broken: r.gates.filter((x) => x.broken).length,
      cues: st ? st.siegeCues : -1, last: st ? st.lastSiegeCue : '',
      culled: st ? st.siegeCulled : -1,
      wrecks: rams.filter((m) => m.wreck).length,
      bays: siege.breachReport().bays.length,
      towers: siege.towerReport().map((x) => x.state).join(','),
      voices: mixer.activeVoices,
    };
  };

  /** Park the listener. The camera is where the ear is; `preRender` reads its matrix. */
  T.look = (x, z, zoom, yaw) => {
    g.setCamera(x, z, zoom, yaw);
    g.engine.advance(1 / 60, 1000 / 60);
    const p = g.engine.rig.camera.position;
    return { eye: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
      dist: +Math.hypot(p.x - x, p.z - z).toFixed(1) };
  };

  /** Fast-forward with the context suspended, so not one voice is scheduled. */
  T.ff = async (to) => {
    await T.suspend();
    const t0 = performance.now();
    let n = 0;
    const marks = [];
    let last = null;
    while (g.simTime() < to - 1e-6) {
      g.engine.advance(1 / 30, 1000 / 30); n++;
      const tm = T.telemetry();
      const key = `${tm.open}|${tm.breached}|${tm.broken}|${tm.wrecks}|${tm.bays}|${tm.towers}`;
      if (key !== last) { marks.push(tm); last = key; }
    }
    return { steps: n, ms: Math.round(performance.now() - t0), sim: g.simTime(), marks };
  };

  /** Paced 1/30 s sim grid, one sim second per wall second, tap open. */
  T.run = async (seconds) => {
    await T.resume();
    if (ctx.state !== 'running') throw new Error(`context did not resume: ${ctx.state}`);
    const tick = () => new Promise((r) => {
      let done = false;
      const f = () => { if (!done) { done = true; r(); } };
      requestAnimationFrame(f); setTimeout(f, 6);
    });
    const n = Math.round(seconds * 30);
    const frames = [];
    const wall0 = performance.now();
    let maxLag = 0, behind = 0;
    T.rec = true;
    const mark0 = ctx.currentTime;
    const simAt0 = g.simTime();
    for (let k = 0; k < n; k++) {
      const due = wall0 + (k * 1000) / 30;
      let now = performance.now();
      while (now < due - 1.5) { await tick(); now = performance.now(); }
      const lag = now - due;
      if (lag > maxLag) maxLag = lag;
      if (lag > 8) behind++;
      const ct = ctx.currentTime;
      g.engine.advance(1 / 30, 1000 / 30);
      const tm = T.telemetry();
      tm.ct = +(ct - mark0).toFixed(5);
      tm.k = k;
      frames.push(tm);
    }
    const mark1 = ctx.currentTime;
    // Hold the tap open: a 4.8 s collapse fired on the last frame is still sounding.
    await new Promise((r) => setTimeout(r, 6000));
    T.rec = false;
    return { mark0, mark1, simAt0, rate: ctx.sampleRate, frames,
      wallMs: Math.round(performance.now() - wall0), maxLag: +maxLag.toFixed(1), behind,
      state: ctx.state, sim: +g.simTime().toFixed(4) };
  };

  /** Send a great ram at the first garrisonable bay well clear of the gate. */
  T.greatRam = () => {
    const b = g.battle;
    const city = g.engine.context.get('city');
    const bays = city.getGarrisonBays();
    const gi = bays.findIndex((q) => q.isGate);
    let bay = null;
    for (let k = (gi < 0 ? bays.length - 1 : gi) - 6; k >= 0; k--) {
      if (bays[k] && bays[k].garrisonable) { bay = bays[k]; break; }
    }
    if (!bay) return { ok: false, why: 'no garrisonable bay clear of the gate' };
    const tx = (bay.x0 + bay.x1) * 0.5, tz = (bay.z0 + bay.z1) * 0.5;
    let crew = null;
    for (const u of b.units) {
      if (u.destroyed || u.alive < 10 || u.faction !== 1) continue;
      if (siege.ownsUnit(u.id) || siege.isGarrisoned(u.id)) continue;
      if (!crew || u.alive > crew.alive) crew = u;
    }
    if (!crew) return { ok: false, why: 'no attacking unit free to crew a great ram' };
    const id = siege.spawnGreatRam(tx + bay.nx * 45, tz + bay.nz * 45, tx, tz, crew.id);
    return { ok: id >= 0, id, bay: bay.index, tx, tz, crewId: crew.id };
  };

  /** Fast-forward, suspended, until a bay is nearly down — then hand back for recording. */
  T.ffUntilBay = async (hpFloor, maxSim) => {
    await T.suspend();
    const t0 = performance.now();
    let n = 0, why = 'timeout';
    while (g.simTime() < maxSim) {
      g.engine.advance(1 / 30, 1000 / 30); n++;
      if (n % 10) continue;
      const br = siege.breachReport();
      if (br.bays.length) { why = 'already down'; break; }
      if (br.integrity.some((x) => x.hp <= hpFloor)) { why = 'nearly down'; break; }
    }
    const br = siege.breachReport();
    return { steps: n, why, ms: Math.round(performance.now() - t0), sim: g.simTime(),
      integrity: br.integrity, bays: br.bays,
      rams: siege.ramReport().map((r) => ({ kind: r.kind, state: r.state, bay: r.bay,
        bayBlows: r.bayBlows, crew: r.crewAlive, wreck: r.wreck })) };
  };

  T.mute = (ids) => ids.map((id) => {
    const b = audio.soundBank;
    const had = b.has(id);
    b.map.delete(id);
    return { id, had, now: b.has(id) };
  });

  window.__gc = T;
  return T.state();
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    // Without this the context is created suspended, `Mixer.running` stays false and every
    // play() returns early: a capture that succeeds and records silence.
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const url = `${base}/?harness=1&quality=${QUALITY}&w=960&h=540&map=${MAP}&scenario=assault`;
console.log(`• ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
await page.evaluate(() => {
  window.__game.engine.stop();
  window.__game.engine.renderOverride = () => {};
});
const st = await page.evaluate(PAGE, TAP_WORKLET);
console.log(`  audio: state=${st.state} rate=${st.rate} ready=${st.ready} running=${st.running} `
  + `tap=${st.tail} bank=${st.bank} gate_collapse in bank=${st.hasGate}`);
if (st.state !== 'running') throw new Error(`AudioContext is ${st.state} — the capture would be silent`);
if (!st.ready) throw new Error('AudioEngine.ready is false — prepare() never ran');
if (!st.hasGate) throw new Error('gate_collapse is not in the bank');

if (MUTE.length) {
  const m = await page.evaluate((ids) => window.__gc.mute(ids), MUTE);
  for (const r of m) {
    console.log(`  MUTED ${r.id}: was in bank=${r.had}, now=${r.now}`);
    if (!r.had) throw new Error(`${r.id} was not in the bank to begin with`);
    if (r.now) throw new Error(`${r.id} is still in the bank — the mute did nothing`);
  }
}

const gate = await page.evaluate(() => {
  const g = window.__game.battle.siege.gateReport();
  return { x: g.x, z: g.z, id: g.id };
});
const look = await page.evaluate((a) => window.__gc.look(a.x, a.z, 0.16, Math.PI), gate);
console.log(`  gate ${gate.id} at (${gate.x.toFixed(1)}, ${gate.z.toFixed(1)}); `
  + `listener at ${look.eye.join(', ')} — ${look.dist} m out`);

const rms = (a, i0, i1) => { let s = 0, n = 0; for (let i = i0; i < i1; i++) { s += a[i] * a[i]; n++; } return n ? Math.sqrt(s / n) : 0; };
const peak = (a, i0, i1) => { let m = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(a[i]); if (v > m) m = v; } return m; };
const db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -999);

const report = { at: new Date().toISOString(), quality: QUALITY, map: MAP, muted: MUTE, gate, listener: look, windows: [] };

if (GREATRAM) {
  const gr = await page.evaluate(() => window.__gc.greatRam());
  console.log(`  great ram: ${JSON.stringify(gr)}`);
  if (!gr.ok) throw new Error(`spawnGreatRam refused: ${gr.why ?? 'unknown'}`);
  const ff = await page.evaluate(() => window.__gc.ffUntilBay(0.045, 900));
  console.log(`  ff ${ff.steps} steps in ${(ff.ms / 1000).toFixed(1)} s → sim ${ff.sim.toFixed(1)} (${ff.why})`);
  console.log(`  integrity ${JSON.stringify(ff.integrity)}  rams ${JSON.stringify(ff.rams)}`);
  if (ff.why === 'timeout') throw new Error('the great ram never got the bay near collapse');
  WINDOWS.length = 0;
  WINDOWS.push([Math.round(ff.sim), Math.round(ff.sim) + 40]);
}

for (const [t0, t1] of WINDOWS) {
  const ff = await page.evaluate((t) => window.__gc.ff(t), t0);
  console.log(`\n▸ window t+${t0}..${t1}  (ff ${ff.steps} steps in ${(ff.ms / 1000).toFixed(1)} s → sim ${ff.sim.toFixed(2)})`);
  for (const m of ff.marks.slice(-6)) {
    console.log(`    ff mark t+${m.t}  open=${m.open ? 1 : 0} breached=${m.breached ? 1 : 0} blows=${m.blows} towers=[${m.towers}] wrecks=${m.wrecks}`);
  }
  await page.evaluate(() => window.__gc.clear());
  const run = await page.evaluate((s) => window.__gc.run(s), t1 - t0);
  const got = await page.evaluate(() => window.__gc.drain());
  await page.evaluate(() => window.__gc.clear());
  if (!got) throw new Error(`t+${t0}..${t1}: the tap produced no blocks at all`);

  const rate = run.rate;
  const all = new Float32Array(Buffer.from(got.b64, 'base64').buffer.slice(0));
  const off = Math.max(0, Math.round(run.mark0 * rate) - got.base);   // frame index of mark0
  const total = Math.floor(all.length / 2) - off;                     // frames available after it
  const at = (sec) => Math.max(0, Math.min(total, Math.round(sec * rate))) * 2 + off * 2;

  // Per-frame telemetry → the transitions, timestamped in both clocks.
  const f = run.frames;
  /*
   * A *transition*, not a state. A condition that was already true on the window's first
   * frame did not happen in this window — the gate is still broken three hundred seconds
   * after it fell, and reporting that as "gate broken -> true at tap 0.000" would put the
   * measurement mark in the wrong place, which it did on the first run of the breach capture.
   */
  const firstChange = (pred) => (f.length && pred(f[0]) ? null : f.find(pred) ?? null);
  const openAt = firstChange((r) => r.open);
  const brokenAt = firstChange((r) => r.broken > 0);
  const breachedAt = firstChange((r) => r.breached);
  const cue0 = f.length ? f[0].cues : 0;
  const cueAt = firstChange((r) => r.cues > cue0);
  const wreck0 = f.length ? f[0].wrecks : 0;
  const wreckAt = firstChange((r) => r.wrecks > wreck0);
  const bay0 = f.length ? f[0].bays : 0;
  const bayAt = firstChange((r) => r.bays > bay0);

  const line = (label, r) => console.log(`    ${label.padEnd(22)} ${r ? `sim t+${r.t}  tap ${r.ct.toFixed(3)} s  (cues=${r.cues} culled=${r.culled} last=${r.last || '—'})` : '— never in this window'}`);
  console.log(`  pacing: wall ${(run.wallMs / 1000).toFixed(1)} s for ${(t1 - t0).toFixed(0)} s  maxLag ${run.maxLag} ms  frames>8ms late ${run.behind}`);
  line('gate open -> true', openAt);
  line('gate broken -> true', brokenAt);
  line('gate breached -> true', breachedAt);
  line('siege cue fired', cueAt);
  line('ram wreck -> true', wreckAt);
  line('curtain bay -> down', bayAt);

  // Quarter-second bins across the whole window plus the tail.
  const bins = [];
  const span = (t1 - t0) + 6;
  for (let s = 0; s + 0.25 <= span; s += 0.25) {
    const i0 = at(s), i1 = at(s + 0.25);
    bins.push({ t: +(t0 + s).toFixed(2), rms: +rms(all, i0, i1).toFixed(6), peak: +peak(all, i0, i1).toFixed(4) });
  }

  const named = {};
  /*
   * The mark is the *transition*, not the cue, so a muted run reports the same windows as a
   * live one and the two are comparable. With the cue present they are the same frame anyway.
   */
  const mark = (cueAt ?? bayAt ?? brokenAt ?? breachedAt ?? wreckAt)?.ct ?? null;
  const win = (name, a, b) => {
    const i0 = at(a), i1 = at(b);
    named[name] = { from: +a.toFixed(2), to: +b.toFixed(2),
      rms: +rms(all, i0, i1).toFixed(6), rmsDb: db(rms(all, i0, i1)),
      peak: +peak(all, i0, i1).toFixed(4), peakDb: db(peak(all, i0, i1)) };
  };
  win('whole window', 0, span);
  if (mark !== null) {
    win('4 s before the mark', Math.max(0, mark - 4), mark);
    win('mark, first 0.5 s', mark, mark + 0.5);
    win('mark, first 2 s', mark, mark + 2);
    win('mark, 2..5 s', mark + 2, mark + 5);
    win('mark, 5..9 s', mark + 5, mark + 9);
  }

  for (const [k, v] of Object.entries(named)) {
    console.log(`    ${k.padEnd(22)} ${String(v.from).padStart(6)}..${String(v.to).padEnd(6)}  `
      + `rms ${v.rms.toFixed(5)} (${v.rmsDb} dBFS)   peak ${v.peak.toFixed(4)} (${v.peakDb} dBFS)`);
  }

  await writeFile(path.join(WORK, `w${t0}-${t1}.f32`), Buffer.from(all.buffer));
  report.windows.push({ t0, t1, rate, pacing: { wallMs: run.wallMs, maxLag: run.maxLag, behind: run.behind },
    transitions: {
      open: openAt && { t: openAt.t, ct: openAt.ct },
      broken: brokenAt && { t: brokenAt.t, ct: brokenAt.ct },
      breached: breachedAt && { t: breachedAt.t, ct: breachedAt.ct },
      cue: cueAt && { t: cueAt.t, ct: cueAt.ct, id: cueAt.last, cues: cueAt.cues },
      wreck: wreckAt && { t: wreckAt.t, ct: wreckAt.ct },
      bay: bayAt && { t: bayAt.t, ct: bayAt.ct },
    },
    named, bins, frames: f });
}

await writeFile(path.join(WORK, 'report.json'), JSON.stringify(report, null, 1));
console.log(`\n→ ${path.join(WORK, 'report.json')}`);
if (errs.length) {
  console.error(`\n⚠ ${errs.length} page error(s):`);
  for (const e of [...new Set(errs)].slice(0, 10)) console.error('   ' + e);
}
await browser.close();
process.exit(errs.length ? 1 : 0);
