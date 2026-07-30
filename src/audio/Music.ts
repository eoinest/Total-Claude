/**
 * Adaptive procedural score.
 *
 * No recordings, no MIDI files, no loops: a lookahead scheduler walks a beat grid and
 * builds each note out of oscillators, and a set of layer gains fades stems in and out as
 * the battle heats up. Because it is generated rather than sequenced, it never loops back
 * to bar one, and because layers only ever crossfade on bar boundaries there is no hard
 * cut when the cue changes.
 *
 * Musical choices, and why:
 *  - **D Phrygian** (D Eb F G A Bb C). The flattened second is the single strongest "this
 *    is not the modern major/minor system" signal available; it reads as ancient without
 *    anyone needing to identify it. Victory switches to Dorian, which is the same trick
 *    with the darkness taken out.
 *  - **Drone plus percussion, not harmony.** Roman and Germanic music alike were far more
 *    about a sustained pitch and a rhythm than chord progressions. The score moves the
 *    drone root by step (i → bII → bVII) rather than by functional cadence.
 *  - **Cornu, tibia, frame drum, male voices.** The instruments actually on a
 *    third-century battlefield. Synthesised, so they suggest rather than reconstruct.
 */

import { clamp, clamp01, lerp } from '../util/math';
import { Rng } from '../util/rand';
import { MAX_MUSIC_VOICES, type Mixer } from './Mixer';

export type MusicCue = 'calm' | 'tension' | 'battle' | 'victory' | 'defeat';

/** Scheduling horizon. Long enough to survive a dropped frame, short enough to react. */
const LOOKAHEAD = 0.4;
const BEATS_PER_BAR = 4;

/** Semitone offsets of the modes used. */
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];

/** D2 — low enough for the drone to be felt, high enough to keep the mid clear. */
const ROOT_HZ = 73.416;

interface LayerTargets {
  drone: number;
  drum: number;
  cornu: number;
  choir: number;
  tibia: number;
  accent: number;
}

interface CueDef {
  bpm: number;
  mode: readonly number[];
  /** Root movement across a four-bar phrase, as scale-degree indices. */
  progression: readonly number[];
  /** Layer levels as a function of 0..1 intensity. */
  layers(intensity: number): LayerTargets;
  /** Brightness of the whole mix, in Hz. Distance and dread both read as "dark". */
  tone(intensity: number): number;
}

const CUES: Record<MusicCue, CueDef> = {
  calm: {
    bpm: 54, mode: PHRYGIAN, progression: [0, 0, 5, 0],
    layers: (i) => ({ drone: 0.5, drum: 0.1 + i * 0.15, cornu: 0, choir: 0.14, tibia: 0.4, accent: 0.1 }),
    tone: (i) => lerp(2400, 4200, i),
  },
  tension: {
    bpm: 66, mode: PHRYGIAN, progression: [0, 1, 0, 1],
    layers: (i) => ({ drone: 0.62, drum: 0.3 + i * 0.3, cornu: i * 0.25, choir: 0.24 + i * 0.3, tibia: 0.12, accent: 0.35 }),
    tone: (i) => lerp(2800, 6000, i),
  },
  battle: {
    bpm: 92, mode: PHRYGIAN, progression: [0, 1, 5, 0],
    layers: (i) => ({
      drone: 0.6, drum: 0.55 + i * 0.45, cornu: 0.3 + i * 0.55,
      choir: 0.3 + i * 0.5, tibia: 0, accent: 0.4 + i * 0.4,
    }),
    tone: (i) => lerp(5200, 12000, i),
  },
  victory: {
    bpm: 84, mode: DORIAN, progression: [0, 4, 5, 0],
    layers: () => ({ drone: 0.45, drum: 0.7, cornu: 0.9, choir: 0.65, tibia: 0.45, accent: 0.5 }),
    tone: () => 11000,
  },
  defeat: {
    bpm: 46, mode: PHRYGIAN, progression: [0, 6, 5, 1],
    layers: () => ({ drone: 0.7, drum: 0.2, cornu: 0.12, choir: 0.6, tibia: 0.18, accent: 0.15 }),
    tone: () => 2600,
  },
};

const LAYER_NAMES = ['drone', 'drum', 'cornu', 'choir', 'tibia', 'accent'] as const;
type LayerName = (typeof LAYER_NAMES)[number];

export class Music {
  private out: GainNode;
  private sum: GainNode;
  private tone: BiquadFilterNode;
  private send: GainNode | null = null;
  private hall: ConvolverNode | null = null;
  private hallReturn: GainNode | null = null;
  private layers: Record<LayerName, GainNode>;

  /** Persistent drone and choir voices — cheaper and smoother than retriggering. */
  private droneOsc: OscillatorNode[] = [];
  private choirOsc: OscillatorNode[] = [];
  private choirFormants: BiquadFilterNode[] = [];

  private cue: MusicCue = 'calm';
  private pendingCue: MusicCue | null = null;
  private intensity = 0;
  private smoothIntensity = 0;
  private beat = 0;
  private nextBeatTime = -1;
  private beatDur = 60 / CUES.calm.bpm;
  private rng = new Rng('cornu-et-tibia');
  /**
   * End times of scheduled notes. Polyphony is capped against the *scheduling* clock
   * rather than against `onended` callbacks, because during an offline render those
   * callbacks do not fire until the whole render is finished.
   */
  private noteEnds: number[] = [];
  private started = false;
  private lastTargets: LayerTargets | null = null;
  /** Current drone root, in semitones above `ROOT_HZ`. */
  private rootSemi = 0;
  private melodyDegree = 4;

  constructor(private readonly mixer: Mixer) {
    const ctx = mixer.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(mixer.musicBus);

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.Q.value = 0.5;
    this.tone.frequency.value = 3000;
    this.tone.connect(this.out);

    this.sum = ctx.createGain();
    // Six layers each reaching ~1.0 sum hot; 0.55 keeps the score below full scale even
    // with the music bus pushed to unity, which the offline headroom test asserts.
    this.sum.gain.value = 0.55;
    this.sum.connect(this.tone);

    const hallIr = mixer.bank.get('ir_hall');
    if (hallIr) {
      try {
        this.hall = ctx.createConvolver();
        this.hall.normalize = true;
        this.hall.buffer = hallIr;
        this.send = ctx.createGain();
        this.send.gain.value = 0.34;
        this.hallReturn = ctx.createGain();
        this.hallReturn.gain.value = 0.9;
        this.sum.connect(this.send);
        this.send.connect(this.hall);
        this.hall.connect(this.hallReturn);
        this.hallReturn.connect(this.out);
      } catch (err) {
        console.warn('[audio] music reverb unavailable:', err);
        this.hall = null;
      }
    }

    const mk = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.sum);
      return g;
    };
    this.layers = {
      drone: mk(), drum: mk(), cornu: mk(), choir: mk(), tibia: mk(), accent: mk(),
    };
  }

  get currentCue(): MusicCue {
    return this.cue;
  }

  get noteCount(): number {
    return this.noteEnds.length;
  }

  /** Build the persistent voices and arm the scheduler. Idempotent. */
  start(at = this.mixer.ctx.currentTime): void {
    if (this.started) return;
    this.started = true;
    const ctx = this.mixer.ctx;

    // Drone: two detuned saws plus a sine an octave down. The beating between the saws
    // is what stops a sustained pitch sounding like a test tone.
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 520;
    droneFilter.Q.value = 0.9;
    droneFilter.connect(this.layers.drone);
    for (const [type, detune, gain] of [
      ['sawtooth', -7, 0.5],
      ['sawtooth', 6, 0.45],
      ['sine', 0, 0.7],
    ] as Array<[OscillatorType, number, number]>) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      o.frequency.value = ROOT_HZ * (type === 'sine' ? 0.5 : 1);
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(droneFilter);
      try {
        o.start(at);
      } catch {
        /* an already-started oscillator is harmless */
      }
      this.droneOsc.push(o);
    }

    // Choir: three saws through a fixed /o/ formant bank. Retuning them is the chord change.
    const choirMix = ctx.createGain();
    choirMix.gain.value = 0.5;
    for (const [f, bw, g] of [[440, 90, 1], [820, 120, 0.5], [2600, 260, 0.16]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = f / bw;
      const vg = ctx.createGain();
      vg.gain.value = g;
      bp.connect(vg);
      vg.connect(this.layers.choir);
      choirMix.connect(bp);
      this.choirFormants.push(bp);
    }
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = (i - 1) * 9;
      o.frequency.value = ROOT_HZ * 2;
      const g = ctx.createGain();
      g.gain.value = 0.33;
      o.connect(g);
      g.connect(choirMix);
      try {
        o.start(at);
      } catch {
        /* ignore */
      }
      this.choirOsc.push(o);
    }

    this.nextBeatTime = at + 0.2;
    this.applyLayers(at, 3);
  }

  setCue(cue: MusicCue): void {
    if (cue === this.cue || cue === this.pendingCue) return;
    // Victory and defeat are punctuation, not a mood — they take effect immediately so the
    // stinger lands with the event. Everything else waits for the bar line.
    if (cue === 'victory' || cue === 'defeat') {
      this.cue = cue;
      this.beatDur = 60 / CUES[cue].bpm;
      this.beat = 0;
      this.applyLayers(this.mixer.ctx.currentTime, 1.4);
    } else {
      this.pendingCue = cue;
    }
  }

  /** 0..1 battle intensity from the sim. Heavily smoothed inside. */
  setIntensity(v: number): void {
    this.intensity = clamp01(v);
  }

  update(dt: number): void {
    // Slow: the score should follow the shape of the battle, not every exchange of blows.
    const rate = this.intensity > this.smoothIntensity ? 0.32 : 0.12;
    this.smoothIntensity += (this.intensity - this.smoothIntensity) * clamp01(dt * rate);
    this.pump();
  }

  /**
   * Schedule everything inside the lookahead window. Takes `now` explicitly so the offline
   * self-test can render a fixed stretch of music without a real clock.
   */
  pump(now = this.mixer.ctx.currentTime): void {
    if (!this.started) return;
    if (this.nextBeatTime < 0) this.nextBeatTime = now + 0.1;
    // A suspended context, a long stall or a tab in the background all leave the grid far
    // in the past. Resync rather than scheduling ten thousand beats at once.
    if (now - this.nextBeatTime > 2) this.nextBeatTime = now + 0.05;

    let guard = 0;
    while (this.nextBeatTime < now + LOOKAHEAD && guard++ < 64) {
      this.scheduleBeat(this.beat, this.nextBeatTime);
      this.nextBeatTime += this.beatDur;
      this.beat++;
    }
  }

  private cueDef(): CueDef {
    return CUES[this.cue];
  }

  private applyLayers(t: number, tau: number): void {
    const targets = this.cueDef().layers(this.smoothIntensity);
    this.lastTargets = targets;
    for (const name of LAYER_NAMES) {
      this.layers[name].gain.setTargetAtTime(clamp(targets[name], 0, 2), t, tau);
    }
    this.tone.frequency.setTargetAtTime(this.cueDef().tone(this.smoothIntensity), t, tau * 0.8);
  }

  private scheduleBeat(beat: number, t: number): void {
    const beatInBar = beat % BEATS_PER_BAR;
    const bar = Math.floor(beat / BEATS_PER_BAR);
    const def = this.cueDef();
    const i = this.smoothIntensity;

    if (beatInBar === 0) {
      // Bar line: this is the only place the cue, the tempo or the harmony may change.
      if (this.pendingCue) {
        this.cue = this.pendingCue;
        this.pendingCue = null;
        this.beatDur = 60 / this.cueDef().bpm;
      }
      this.applyLayers(t, 2.2);
      const prog = this.cueDef().progression;
      const degree = prog[bar % prog.length];
      this.setRoot(this.cueDef().mode[degree % this.cueDef().mode.length], t);
      if (bar % 4 === 0 && (this.lastTargets?.accent ?? 0) > 0.2) {
        this.hit('metal_tam', t, 0.6 + i * 0.3, 'accent', 0.9 + this.rng.jitter(0.05));
      }
    }

    this.scheduleDrums(beat, beatInBar, bar, t, i);

    // Cornu calls: at most one every two bars, on the bar, and only when the brass layer
    // is actually up. A horn signal that repeats every bar stops being a signal.
    if (beatInBar === 0 && bar % 2 === 0 && (this.lastTargets?.cornu ?? 0) > 0.12) {
      const semi = this.cueDef().mode[this.rng.pick([0, 4, 4, 3])];
      this.cornuNote(t, this.beatDur * lerp(3.2, 1.9, i), this.rootSemi + semi + 12, 0.5 + i * 0.4);
    }

    // Tibia melody: the double pipe carries the tune when the drums are not.
    if ((this.lastTargets?.tibia ?? 0) > 0.08 && (beatInBar === 0 || beatInBar === 2 || this.rng.bool(0.25))) {
      const mode = this.cueDef().mode;
      // Random walk of at most a third, so phrases wander rather than jump.
      this.melodyDegree = clamp(this.melodyDegree + this.rng.int(-2, 2), 0, mode.length - 1);
      const semi = mode[this.melodyDegree];
      this.tibiaNote(t, this.beatDur * this.rng.pick([1, 1.5, 2]), this.rootSemi + semi + 24, 0.35);
    }
  }

  private scheduleDrums(beat: number, beatInBar: number, bar: number, t: number, i: number): void {
    const level = this.lastTargets?.drum ?? 0;
    if (level < 0.05) return;
    const cue = this.cue;

    if (cue === 'defeat') {
      if (beatInBar === 0 && bar % 2 === 0) this.hit('drum_bass', t, 0.8, 'drum', 0.86);
      return;
    }
    if (cue === 'calm') {
      if (beatInBar === 0) this.hit('drum_frame_1', t, 0.45, 'drum', 1);
      if (beatInBar === 2 && i > 0.25) this.hit('drum_frame_0', t, 0.3, 'drum', 1.06);
      return;
    }
    if (cue === 'tension') {
      // A heartbeat: two hits close together, the second weaker.
      if (beatInBar === 0 || beatInBar === 2) {
        this.hit('drum_frame_0', t, 0.6, 'drum', 0.94);
        this.hit('drum_frame_2', t + this.beatDur * 0.24, 0.34, 'drum', 1.02);
      }
      if (i > 0.5 && beatInBar === 3) this.hit('drum_frame_1', t + this.beatDur * 0.5, 0.28, 'drum', 1.1);
      return;
    }

    // battle / victory: a driving pattern that densifies with intensity.
    if (beatInBar === 0 || beatInBar === 2) this.hit('drum_bass', t, 0.9, 'drum', 1);
    this.hit(`drum_frame_${beat % 3}`, t, beatInBar === 0 ? 0.75 : 0.5, 'drum', 0.98 + (beat % 3) * 0.03);
    if (i > 0.32) {
      this.hit(`drum_frame_${(beat + 1) % 3}`, t + this.beatDur * 0.5, 0.34 + i * 0.2, 'drum', 1.08);
    }
    if (i > 0.66 && (beat & 1) === 1) {
      this.hit(`drum_frame_${(beat + 2) % 3}`, t + this.beatDur * 0.75, 0.26, 'drum', 1.16);
    }
  }

  /** Move the drone and choir to a new root. A glide, never a jump. */
  private setRoot(semi: number, t: number): void {
    if (semi === this.rootSemi) return;
    this.rootSemi = semi;
    const f = ROOT_HZ * Math.pow(2, semi / 12);
    for (let k = 0; k < this.droneOsc.length; k++) {
      const target = k === 2 ? f * 0.5 : f;
      this.droneOsc[k].frequency.setTargetAtTime(target, t, 0.35);
    }
    // Choir sings root, fifth, octave — open intervals, no thirds. Thirds sound Baroque.
    const chord = [2, 3, 4];
    for (let k = 0; k < this.choirOsc.length; k++) {
      const mult = chord[k] === 2 ? 2 : chord[k] === 3 ? 3 : 4;
      this.choirOsc[k].frequency.setTargetAtTime(f * mult * 0.5, t, 0.5);
    }
  }

  /** Retire notes that have finished by time `t` and report whether there is room. */
  private canSchedule(t: number): boolean {
    for (let i = this.noteEnds.length - 1; i >= 0; i--) {
      if (this.noteEnds[i] <= t) this.noteEnds.splice(i, 1);
    }
    return this.noteEnds.length < MAX_MUSIC_VOICES;
  }

  /** A percussion hit from the pre-synthesised bank. */
  private hit(id: string, t: number, vel: number, layer: LayerName, rate: number): void {
    if (!this.canSchedule(t)) return;
    const buf = this.mixer.bank.get(id);
    if (!buf) return;
    const ctx = this.mixer.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vel;
    src.connect(g);
    g.connect(this.layers[layer]);
    const t0 = Math.max(ctx.currentTime, t);
    try {
      src.start(t0);
    } catch {
      return;
    }
    this.noteEnds.push(t0 + buf.duration / Math.max(0.1, rate));
    src.onended = () => {
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  /**
   * Cornu. Four partials with the odd ones emphasised (a conical bore favours them), a
   * slow bloom as the bore fills, and a lowpass that opens with the envelope so it
   * brightens as it gets louder — the defining behaviour of brass.
   */
  private cornuNote(t: number, dur: number, semi: number, vel: number): void {
    if (!this.canSchedule(t)) return;
    const ctx = this.mixer.ctx;
    const f = ROOT_HZ * Math.pow(2, semi / 12);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    g.connect(lp);
    lp.connect(this.layers.cornu);

    const t0 = Math.max(ctx.currentTime, t);
    const atk = Math.min(0.14, dur * 0.2);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vel * 0.5, t0 + atk);
    g.gain.setTargetAtTime(vel * 0.34, t0 + atk, dur * 0.4);
    g.gain.setTargetAtTime(0.0001, t0 + dur * 0.82, dur * 0.12);
    lp.frequency.setValueAtTime(600, t0);
    lp.frequency.linearRampToValueAtTime(lerp(1800, 4200, vel), t0 + atk);
    lp.frequency.setTargetAtTime(1400, t0 + dur * 0.5, dur * 0.4);

    const oscs: OscillatorNode[] = [];
    for (const [mult, amp, type] of [
      [1, 0.55, 'sine'], [2, 0.3, 'sine'], [3, 0.34, 'sine'], [5, 0.16, 'triangle'],
    ] as Array<[number, number, OscillatorType]>) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      // A brass player's pitch creeps up as the note settles.
      o.frequency.setValueAtTime(f * mult * 0.985, t0);
      o.frequency.linearRampToValueAtTime(f * mult, t0 + atk * 1.6);
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og);
      og.connect(g);
      try {
        o.start(t0);
        o.stop(t0 + dur + 0.4);
      } catch {
        continue;
      }
      oscs.push(o);
    }
    if (oscs.length === 0) return;
    this.noteEnds.push(t0 + dur + 0.4);
    oscs[0].onended = () => {
      try {
        for (const o of oscs) o.disconnect();
        g.disconnect();
        lp.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  /** Tibia: two reed pipes, one holding, one moving, with breathy vibrato. */
  private tibiaNote(t: number, dur: number, semi: number, vel: number): void {
    if (!this.canSchedule(t)) return;
    const ctx = this.mixer.ctx;
    const f = ROOT_HZ * Math.pow(2, semi / 12);
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2.2;
    bp.Q.value = 1.1;
    g.connect(bp);
    bp.connect(this.layers.tibia);

    const t0 = Math.max(ctx.currentTime, t);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vel, t0 + 0.05);
    g.gain.setTargetAtTime(0.0001, t0 + dur * 0.75, dur * 0.16);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = f * 0.012;
    lfo.connect(lfoGain);

    const oscs: OscillatorNode[] = [];
    for (const [mult, amp, type] of [
      [1, 0.6, 'square'], [1.5, 0.28, 'triangle'],
    ] as Array<[number, number, OscillatorType]>) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      lfoGain.connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og);
      og.connect(g);
      try {
        o.start(t0);
        o.stop(t0 + dur + 0.3);
      } catch {
        continue;
      }
      oscs.push(o);
    }
    try {
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.3);
    } catch {
      /* ignore */
    }
    if (oscs.length === 0) return;
    this.noteEnds.push(t0 + dur + 0.3);
    oscs[0].onended = () => {
      try {
        for (const o of oscs) o.disconnect();
        lfo.disconnect();
        lfoGain.disconnect();
        g.disconnect();
        bp.disconnect();
      } catch {
        /* ignore */
      }
    };
  }

  stats(): { cue: MusicCue; intensity: number; notes: number; beat: number; bpm: number } {
    return {
      cue: this.cue,
      intensity: this.smoothIntensity,
      notes: this.noteEnds.length,
      beat: this.beat,
      bpm: Math.round(60 / this.beatDur),
    };
  }

  dispose(): void {
    const t = this.mixer.ctx.currentTime;
    for (const o of [...this.droneOsc, ...this.choirOsc]) {
      try {
        o.stop(t + 0.05);
        o.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.droneOsc.length = 0;
    this.choirOsc.length = 0;
    try {
      for (const name of LAYER_NAMES) this.layers[name].disconnect();
      for (const f of this.choirFormants) f.disconnect();
      this.sum.disconnect();
      this.tone.disconnect();
      this.send?.disconnect();
      this.hall?.disconnect();
      this.hallReturn?.disconnect();
      this.out.disconnect();
    } catch {
      /* ignore */
    }
    this.started = false;
  }
}
