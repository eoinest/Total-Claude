/**
 * Offline verification for the audio subsystem.
 *
 * Screenshots cannot show sound, so this is the actual proof that the synthesis works:
 * every recipe is rendered into an `OfflineAudioContext` and its peak, RMS, DC offset and
 * duration are checked against sane bounds; the mixer's distance model is rendered at two
 * distances and the near/far levels and high-frequency content compared; the combat
 * bus is deliberately overloaded to confirm the compressor and limiter hold the output
 * under full scale; the score is rendered for eight seconds; and the whole subsystem is
 * driven with no audio available at all to confirm it stays silent instead of throwing.
 *
 * Run it with `node src/audio/audio-selftest.mjs` (Playwright driver), or from the console
 * of a running dev server:
 *   `(await import('/src/audio/selftest.ts')).runAudioSelfTest().then(console.log)`
 */

import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import { QUALITY_PRESETS, type EngineContext, type Subsystem } from '../core/Engine';
import { Time } from '../core/Time';
import type { GameEvents } from '../core/events';
import { UnitOrder, type UnitGroupState } from '../sim/types';
import { AudioEngine } from './AudioEngine';
import { BattleAudio, type BattleView } from './BattleAudio';
import { MAX_MUSIC_VOICES, MAX_SPATIAL_VOICES, Mixer } from './Mixer';
import { Music } from './Music';
import { buildSoundBank, recipeIds, type SoundBank } from './Synth';

const SR = 44100;

export interface SoundMeasurement {
  id: string;
  channels: number;
  sampleRate: number;
  durationMs: number;
  peak: number;
  rms: number;
  dc: number;
  ok: boolean;
  problems: string[];
}

export interface GraphMeasurement {
  name: string;
  peak: number;
  rms: number;
  hfRms: number;
  durationMs: number;
}

export interface AudioSelfTestReport {
  pass: boolean;
  failures: string[];
  warnings: string[];
  bank: {
    buildMs: number;
    count: number;
    expected: number;
    totalSamples: number;
    megabytes: number;
  };
  sounds: SoundMeasurement[];
  /** Rendered through the real mixer graph. */
  graph: GraphMeasurement[];
  distance: {
    /** Level ratio far/near, and cutoff-driven HF loss. */
    nearPeak: number;
    farPeak: number;
    attenuationDb: number;
    nearHfRatio: number;
    farHfRatio: number;
  };
  headroom: {
    requested: number;
    /** Cumulative starts, including voices that immediately replaced a weaker one. */
    started: number;
    /** Simultaneously sounding voices — this is the number the cap governs. */
    concurrent: number;
    stolen: number;
    culled: number;
    voiceCap: number;
    renderedPeak: number;
  };
  clustering: {
    events: number;
    discreteVoices: number;
    ratio: number;
    meleeIntensity: number;
    beds: number;
  };
  music: { cue: string; peak: number; rms: number; bars: number; notesPeak: number };
  headless: {
    noContextThrew: boolean;
    suspendedThrew: boolean;
    /** Context state as the subsystem saw it. Must be 'suspended' for the test to mean anything. */
    observedState: string;
    suspendedScheduled: number;
    suspendedReady: boolean;
  };
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function measureBuffer(buf: AudioBuffer): { peak: number; rms: number; dc: number } {
  let peak = 0;
  let sum2 = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum2 += v * v;
      sum += v;
    }
    n += d.length;
  }
  return { peak, rms: n ? Math.sqrt(sum2 / n) : 0, dc: n ? sum / n : 0 };
}

/** RMS of the signal above ~4 kHz — the band air absorption is supposed to eat. */
function highBandRms(buf: AudioBuffer): number {
  const a = Math.exp((-2 * Math.PI * 4000) / buf.sampleRate);
  let sum2 = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < d.length; i++) {
      const y = a * y1 + 0.5 * (1 + a) * (d[i] - x1);
      x1 = d[i];
      y1 = y;
      sum2 += y * y;
    }
    n += d.length;
  }
  return n ? Math.sqrt(sum2 / n) : 0;
}

function offline(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.max(128, Math.round(SR * seconds)), SR);
}

/** Sounds whose whole point is a long quiet tail, so a low RMS is correct. */
const LOW_RMS_OK = new Set(['ir_field', 'ir_hall', 'metal_tam', 'arrow_flight', 'insects', 'city_distant']);

// ---------------------------------------------------------------------------
// Test 1 — every recipe's levels and duration
// ---------------------------------------------------------------------------

function testSounds(bank: SoundBank, failures: string[], warnings: string[]): SoundMeasurement[] {
  const out: SoundMeasurement[] = [];
  for (const id of bank.ids) {
    const buf = bank.get(id);
    if (!buf) {
      failures.push(`sound "${id}" is missing from the bank`);
      continue;
    }
    const m = measureBuffer(buf);
    const problems: string[] = [];
    if (buf.duration < 0.02) problems.push(`duration ${(buf.duration * 1000).toFixed(1)} ms too short`);
    if (buf.duration > 8) problems.push(`duration ${buf.duration.toFixed(2)} s suspiciously long`);
    if (m.peak > 1.0001) problems.push(`peak ${m.peak.toFixed(3)} clips`);
    if (m.peak < 0.2) problems.push(`peak ${m.peak.toFixed(3)} too quiet — normalisation failed`);
    if (m.rms < (LOW_RMS_OK.has(id) ? 0.002 : 0.012)) problems.push(`rms ${m.rms.toFixed(4)} near silent`);
    if (Math.abs(m.dc) > 0.02) problems.push(`dc offset ${m.dc.toFixed(4)}`);
    if (!Number.isFinite(m.peak) || !Number.isFinite(m.rms)) problems.push('non-finite samples');
    out.push({
      id,
      channels: buf.numberOfChannels,
      sampleRate: buf.sampleRate,
      durationMs: buf.duration * 1000,
      peak: m.peak,
      rms: m.rms,
      dc: m.dc,
      ok: problems.length === 0,
      problems,
    });
    for (const p of problems) {
      // A clipped or silent buffer is a real failure; a marginal one is a warning.
      if (p.includes('clips') || p.includes('non-finite') || p.includes('near silent')) {
        failures.push(`${id}: ${p}`);
      } else {
        warnings.push(`${id}: ${p}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test 2 — the mixer's distance model, rendered
// ---------------------------------------------------------------------------

async function renderOneShot(bank: SoundBank, id: string, distance: number, seconds: number): Promise<AudioBuffer> {
  const ctx = offline(seconds);
  const mixer = new Mixer(ctx, bank, { reverb: true, masterGain: 1 });
  mixer.running = true;
  mixer.setListener(0, 1.7, 0, 1, 0, 0, -1);
  // Straight ahead (−Z) so panning is centred and the level reading is unambiguous.
  mixer.play(id, { x: 0, y: 1.7, z: -distance, gain: 1, bus: 'combat', priority: 5 });
  const buf = await ctx.startRendering();
  mixer.dispose();
  return buf;
}

// ---------------------------------------------------------------------------
// Test 3 — voice cap and bus headroom under a deliberate overload
// ---------------------------------------------------------------------------

async function testHeadroom(bank: SoundBank): Promise<AudioSelfTestReport['headroom']> {
  const ctx = offline(3.2);
  const mixer = new Mixer(ctx, bank, { reverb: true, masterGain: 0.85 });
  mixer.running = true;
  mixer.setListener(0, 2, 0, 1, 0, 0, -1);
  const ids = ['clash_shieldwall', 'hit_shield_0', 'hit_armour_1', 'hit_flesh_2', 'parry_0',
    'cavalry_impact', 'volley_arrow', 'scream_1', 'cry_germanic', 'shield_bash'];
  const requested = 90;
  for (let i = 0; i < requested; i++) {
    mixer.play(ids[i % ids.length], {
      x: (i % 9) * 2 - 8,
      y: 1.6,
      z: -6 - (i % 5),
      gain: 1,
      bus: 'combat',
      priority: 1,
    });
  }
  // Nothing retires during an offline render (no clock advance, no `onended`), so the live
  // voice count at this point is the peak concurrency the graph ever reached.
  const started = mixer.counters.started;
  const concurrent = mixer.activeVoices;
  const stolen = mixer.counters.stolen;
  const culled = mixer.counters.culled;
  const buf = await ctx.startRendering();
  mixer.dispose();
  const m = measureBuffer(buf);
  return { requested, started, concurrent, stolen, culled, voiceCap: MAX_SPATIAL_VOICES, renderedPeak: m.peak };
}

// ---------------------------------------------------------------------------
// Test 4 — clustering
// ---------------------------------------------------------------------------

/** A synthetic battle: two lines in contact 40 m from the listener. */
function stubBattle(): BattleView {
  const units: UnitGroupState[] = [];
  const mkUnit = (id: number, faction: number, x: number, z: number, typeId: string, alive: number): UnitGroupState =>
    ({
      id, typeId, faction, members: [], alive, initialStrength: alive,
      x, z, facing: 0, targetX: x, targetZ: z + 4, targetFacing: 0,
      order: UnitOrder.AttackMove, targetUnitId: -1, waypoints: [], running: false,
      formationId: 'line', width: 20, spacingX: 0.86, spacingZ: 1.02,
      morale: 60, maxMorale: 70, fatigue: 0.2, ammo: 0, engaged: true,
      chargeTimer: 0, contactLock: false, charging: false,
      routTimer: 0, kills: 0, destroyed: false, selected: false, concealed: false,
    } as UnitGroupState);
  units.push(mkUnit(0, 0, -8, 40, 'legio-cohort', 160));
  units.push(mkUnit(1, 1, 8, 44, 'juthungi-warband', 180));
  units.push(mkUnit(2, 0, 120, 60, 'equites', 60));
  return {
    units,
    pool: { count: 0, x: new Float32Array(1), y: new Float32Array(1), z: new Float32Array(1), state: new Uint8Array(1) },
    groundAt: () => 0,
  };
}

async function testClustering(bank: SoundBank): Promise<AudioSelfTestReport['clustering']> {
  const ctx = offline(1.0);
  const mixer = new Mixer(ctx, bank, { reverb: false, masterGain: 0.85 });
  mixer.running = true;
  mixer.setListener(0, 2, 0, 1, 0, 0, -1);
  const ba = new BattleAudio(mixer, { detail: 1 });
  ba.attach(stubBattle(), null);

  // 200 blows in one frame, spread across the frontage, exactly as a big melee reports.
  const EVENTS = 200;
  const kinds = ['shield', 'armour', 'flesh', 'parry', 'miss'];
  for (let i = 0; i < EVENTS; i++) {
    const t = i / EVENTS;
    ba.meleeHit(-30 + t * 60 + Math.sin(i) * 2, 1.4, 38 + Math.cos(i * 3) * 6, kinds[i % kinds.length], i % 9 === 0);
  }
  // One frame at 60 Hz, then a flush.
  ba.update(1 / 60);
  ba.update(FLUSH_STEP);
  const discrete = mixer.counters.started;
  const st = ba.stats();
  ba.dispose();
  mixer.dispose();
  await ctx.startRendering();
  return {
    events: EVENTS,
    discreteVoices: discrete,
    ratio: discrete / EVENTS,
    meleeIntensity: st.meleeIntensity,
    beds: st.beds,
  };
}

/** One cluster flush window plus a hair, so `update` is guaranteed to flush. */
const FLUSH_STEP = 1 / 15;

// ---------------------------------------------------------------------------
// Test 5 — the score
// ---------------------------------------------------------------------------

async function testMusic(bank: SoundBank, cue: 'battle' | 'calm', seconds: number): Promise<AudioSelfTestReport['music']> {
  const ctx = offline(seconds);
  const mixer = new Mixer(ctx, bank, { reverb: false, masterGain: 1 });
  mixer.running = true;
  mixer.setBusGain('music', 1, 0);
  const music = new Music(mixer);
  music.start(0);
  music.setCue(cue);
  music.setIntensity(cue === 'battle' ? 0.85 : 0.1);
  let notesPeak = 0;
  for (let t = 0; t <= seconds; t += 0.05) {
    music.update(0.05);
    music.pump(t);
    notesPeak = Math.max(notesPeak, music.noteCount);
  }
  const bars = Math.round(music.stats().beat / 4);
  const buf = await ctx.startRendering();
  music.dispose();
  mixer.dispose();
  const m = measureBuffer(buf);
  return { cue, peak: m.peak, rms: m.rms, bars, notesPeak };
}

// ---------------------------------------------------------------------------
// Test 6 — the harness case: no audio, or audio not yet permitted
// ---------------------------------------------------------------------------

function stubEngineContext(events: EventBus<GameEvents>, systems: Map<string, Subsystem>): EngineContext {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 4000);
  camera.position.set(0, 40, 120);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // Cast: the audio subsystem only reads camera, events, time, quality and tryGet, so
  // standing up a renderer and a scene to test it would be pure ceremony.
  return {
    camera,
    events,
    time: new Time(),
    quality: QUALITY_PRESETS.high,
    viewW: 1280,
    viewH: 720,
    get: (name: string) => {
      const s = systems.get(name);
      if (!s) throw new Error(name);
      return s;
    },
    tryGet: (name: string) => systems.get(name),
  } as unknown as EngineContext;
}

/** Fire one of every event the audio system subscribes to. */
function stormEvents(events: EventBus<GameEvents>): void {
  events.emit('battleStarted', { seed: 1, scenario: 'test' });
  events.emit('meleeHit', { x: 1, y: 1, z: 2, kind: 'shield', lethal: false, attackerFaction: 0 });
  events.emit('meleeHit', { x: 1, y: 1, z: 2, kind: 'armour', lethal: true, attackerFaction: 1 });
  events.emit('volleyFired', { x: 0, y: 2, z: 30, count: 80, kind: 'pilum' });
  events.emit('projectileImpact', { x: 0, y: 1, z: 5, kind: 'arrow', hitTarget: true, material: 'shield' });
  events.emit('linesClashed', { x: 0, z: 0, intensity: 1, attackerFaction: 0 });
  events.emit('cavalryCharge', { x: 40, z: 10, intensity: 0.8, unitId: 2 });
  events.emit('soldierDied', { x: 2, y: 1, z: 3, unitId: 0, faction: 0, index: 41 });
  events.emit('unitRouted', { unitId: 1, faction: 1 });
  events.emit('unitDestroyed', { unitId: 1, faction: 1 });
  events.emit('unitMoraleChanged', { unitId: 0, morale: 20, previous: 60 });
  events.emit('playSound', { id: 'cornu_call', x: 0, y: 2, z: 10, volume: 0.8, pitch: 1 });
  events.emit('playSound', { id: 'not_a_real_sound' });
  events.emit('musicCue', { id: 'battle' });
  events.emit('battleEnded', { victor: 0, reason: 'rout' });
}

async function testHeadless(): Promise<AudioSelfTestReport['headless']> {
  const result: AudioSelfTestReport['headless'] = {
    noContextThrew: false,
    suspendedThrew: false,
    observedState: 'unknown',
    suspendedScheduled: 0,
    suspendedReady: true,
  };

  // (a) No Web Audio at all.
  try {
    const events = new EventBus<GameEvents>();
    const sys = new Map<string, Subsystem>();
    const ctx = stubEngineContext(events, sys);
    const audio = new AudioEngine({ contextFactory: () => null });
    audio.init(ctx);
    stormEvents(events);
    for (let i = 0; i < 120; i++) audio.preRender(ctx);
    audio.setMuted(true);
    audio.setMusicCue('battle');
    await audio.resume();
    audio.dispose();
  } catch (err) {
    result.noContextThrew = true;
    console.warn('[selftest] no-context path threw:', err);
  }

  // (b) A genuinely suspended context — exactly what a browser hands you before the user
  //     has interacted. Nothing may be built, nothing may be scheduled, nothing may throw.
  //     Headless Chromium sometimes reports a fresh context as already running, so the
  //     state is forced rather than assumed.
  let live: AudioContext | null = null;
  try {
    live = new AudioContext();
    await live.suspend();
    result.observedState = live.state;
    const events = new EventBus<GameEvents>();
    const ctx = stubEngineContext(events, new Map());
    const audio = new AudioEngine({ contextFactory: () => live as AudioContext });
    audio.init(ctx);
    stormEvents(events);
    for (let i = 0; i < 120; i++) audio.preRender(ctx);
    const st = audio.stats();
    result.suspendedScheduled = st.started;
    result.suspendedReady = st.ready;
    audio.dispose();
  } catch (err) {
    result.suspendedThrew = true;
    console.warn('[selftest] suspended-context path threw:', err);
  } finally {
    try {
      await live?.close();
    } catch {
      /* already closed */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAudioSelfTest(): Promise<AudioSelfTestReport> {
  const failures: string[] = [];
  const warnings: string[] = [];

  // One bank, reused by every render. AudioBuffers are not bound to a context, so this is
  // legal — the only constraint is that convolution impulse responses match the rate.
  const factory = offline(0.01);
  const bank = buildSoundBank(factory);
  const expected = recipeIds().length;
  if (bank.stats.count !== expected) {
    failures.push(`bank built ${bank.stats.count} of ${expected} recipes`);
  }

  const sounds = testSounds(bank, failures, warnings);

  // Distance model: the same blow at 12 m and at 400 m.
  const near = await renderOneShot(bank, 'hit_armour_0', 12, 1.6);
  const far = await renderOneShot(bank, 'hit_armour_0', 400, 1.6);
  const nm = measureBuffer(near);
  const fm = measureBuffer(far);
  const nearHf = highBandRms(near);
  const farHf = highBandRms(far);
  const attenuationDb = 20 * Math.log10(Math.max(1e-9, fm.peak / Math.max(1e-9, nm.peak)));
  const nearHfRatio = nearHf / Math.max(1e-9, nm.rms);
  const farHfRatio = farHf / Math.max(1e-9, fm.rms);
  if (!(fm.peak < nm.peak * 0.25)) failures.push('distance attenuation is not reducing level');
  // The metric is a crude 4 kHz one-pole, so a third of the treble share is a decisive
  // reading rather than a marginal one.
  if (!(farHfRatio < nearHfRatio * 0.67)) {
    failures.push(`air absorption not removing treble (near ${nearHfRatio.toFixed(3)} vs far ${farHfRatio.toFixed(3)})`);
  }

  const graph: GraphMeasurement[] = [
    { name: 'hit_armour_0 @ 12 m', peak: nm.peak, rms: nm.rms, hfRms: nearHf, durationMs: near.duration * 1000 },
    { name: 'hit_armour_0 @ 400 m', peak: fm.peak, rms: fm.rms, hfRms: farHf, durationMs: far.duration * 1000 },
  ];
  for (const [id, d, secs] of [
    ['clash_shieldwall', 25, 3.4],
    ['cry_germanic', 60, 4.6],
    ['volley_arrow', 40, 2.0],
    ['march_mass_0', 18, 1.2],
  ] as Array<[string, number, number]>) {
    const b = await renderOneShot(bank, id, d, secs);
    const m = measureBuffer(b);
    graph.push({ name: `${id} @ ${d} m`, peak: m.peak, rms: m.rms, hfRms: highBandRms(b), durationMs: b.duration * 1000 });
    if (m.peak < 0.01) failures.push(`${id} rendered silent through the mixer`);
  }

  const headroom = await testHeadroom(bank);
  if (headroom.concurrent > MAX_SPATIAL_VOICES) {
    failures.push(`voice cap breached: ${headroom.concurrent} concurrent > ${MAX_SPATIAL_VOICES}`);
  }
  if (headroom.renderedPeak > 1.0) {
    failures.push(`combat overload clipped at ${headroom.renderedPeak.toFixed(3)}`);
  }

  const clustering = await testClustering(bank);
  if (clustering.discreteVoices > 16) {
    failures.push(`clustering let ${clustering.discreteVoices} voices through for 200 events`);
  }
  if (clustering.meleeIntensity <= 0) failures.push('melee intensity did not rise with 200 hits');

  const music = await testMusic(bank, 'battle', 8);
  if (music.peak < 0.02) failures.push('battle music rendered silent');
  if (music.peak > 1.0) failures.push(`music clipped at ${music.peak.toFixed(3)}`);
  if (music.notesPeak > MAX_MUSIC_VOICES) {
    failures.push(`music polyphony breached: ${music.notesPeak} > ${MAX_MUSIC_VOICES}`);
  }

  const headless = await testHeadless();
  if (headless.noContextThrew) failures.push('audio threw with no AudioContext available');
  if (headless.suspendedThrew) failures.push('audio threw with a suspended AudioContext');
  if (headless.observedState !== 'suspended') {
    warnings.push(`could not force a suspended context (state was "${headless.observedState}")`);
  } else if (headless.suspendedScheduled > 0) {
    failures.push(`${headless.suspendedScheduled} voices scheduled into a suspended context`);
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings,
    bank: {
      buildMs: bank.stats.buildMs,
      count: bank.stats.count,
      expected,
      totalSamples: bank.stats.totalSamples,
      megabytes: bank.stats.totalBytes / (1024 * 1024),
    },
    sounds,
    graph,
    distance: { nearPeak: nm.peak, farPeak: fm.peak, attenuationDb, nearHfRatio, farHfRatio },
    headroom,
    clustering,
    music,
    headless,
  };
}
