/**
 * Bus graph, spatialisation and voice management.
 *
 * The graph is
 *
 *   voice ─ gain ─ air-absorption LP ─ stereo pan ─┬─ bus ─ [combat saturator] ──┐
 *                                                 └─ send ─ convolver ─ return ──┤
 *                                                                     master ────┴─ soft clip ─ out
 *
 * Dynamics are handled by `WaveShaperNode` soft clipping plus voice-count-driven ducking
 * on the combat bus, *not* by `DynamicsCompressorNode`. That is a deliberate choice made
 * on measurement: Chromium's compressor costs about 16 dB of level even when configured
 * for unity (threshold 0 dB, ratio 1:1) — verified in `selftest`'s companion probe — which
 * makes it unusable as a transparent limiter. A static soft-clip curve measures
 * bit-transparent below its knee, guarantees the output never leaves ±1, and adds exactly
 * the harmonic density that makes a wall of impacts read as mass rather than as clipping.
 * The gain-riding a bus compressor would have given comes from counting live combat voices
 * on the main thread and ducking the bus, which is standard game-audio practice and is
 * driven by information the audio thread does not have anyway.
 *
 * Spatialisation is done by hand rather than with an HRTF `PannerNode`. Two reasons:
 * an HRTF panner is a per-voice convolution and forty of them is real audio-thread cost,
 * and — more importantly — the distance behaviour has to be art-directed. A battle seen
 * from 600 m up must collapse into one distant roar, and seen from eye level must resolve
 * into individual blows, and that transition is a curve somebody has to choose.
 *
 * Nothing here allocates or synthesises per frame beyond one `AudioBufferSourceNode` per
 * one-shot (unavoidable: they are single-use by spec). Filter/gain/pan chains are pooled.
 */

import { clamp, clamp01, lerp } from '../util/math';
import type { SoundBank } from './Synth';

export type BusName = 'music' | 'ambience' | 'combat' | 'ui' | 'voice';

/**
 * Hard cap on simultaneous spatial voices, one-shots and looping beds together. With the
 * music reservation below this is the project's 48-voice ceiling.
 */
export const MAX_SPATIAL_VOICES = 40;
/** Simultaneous scheduled music notes. Together with the above this is the 48-voice cap. */
export const MAX_MUSIC_VOICES = 8;
/**
 * Slots inside the spatial budget that one-shots may not touch. The continuous layers are
 * what make a battle sound like a battle, so a storm of individual blows must never be able
 * to starve the melee roar, the marching or the wind.
 */
const BED_RESERVE = 8;

/**
 * Distance at which a point source is at full level, and the rate it falls off after.
 * `REF_DIST` is deliberately large for a game whose camera routinely sits 500 m away:
 * a single sword blow at 9 m is "right here".
 */
const REF_DIST = 9;
const POINT_ROLLOFF = 0.85;
/**
 * Aggregate sources (the melee roar, a marching cohort, the city) are extended, not
 * point-like, so they obey a much shallower law. This is the single most important
 * constant for making the strategic view sound like a battlefield instead of silence.
 */
const BED_ROLLOFF = 0.16;
/** Beyond this a sound is simply not scheduled. */
const CULL_DIST = 1100;

/** A voice whose computed gain falls below this is not worth a node. */
const AUDIBLE_FLOOR = 0.0022;

export interface PlayOptions {
  x?: number;
  y?: number;
  z?: number;
  /** Linear gain before distance attenuation. */
  gain?: number;
  /** Playback rate multiplier. */
  rate?: number;
  bus?: BusName;
  /** Higher survives voice stealing. */
  priority?: number;
  /** Treat as an extended source: shallow rolloff, narrower panning, more reverb. */
  aggregate?: boolean;
  /** Schedule at this context time instead of now. */
  when?: number;
  /** Non-positional: centred, no distance attenuation (UI, music, listener-locked beds). */
  ambient?: boolean;
  /** Stereo width multiplier, 0..1. */
  width?: number;
}

interface Chain {
  gain: GainNode;
  lp: BiquadFilterNode;
  pan: StereoPannerNode;
  send: GainNode;
  busName: BusName;
  inUse: boolean;
}

interface Voice {
  chain: Chain;
  src: AudioBufferSourceNode;
  startedAt: number;
  endsAt: number;
  score: number;
  id: string;
}

/**
 * A voice younger than this is never stolen. Cutting a transient 5 ms after it started is
 * an audible click, and in a heavy frame the stealing logic would otherwise churn through
 * dozens of them.
 */
const MIN_AGE_TO_STEAL = 0.025;

/**
 * Soft-clip transfer curve for a `WaveShaperNode`.
 *
 * The node clamps its input to ±1 before indexing, so the curve is authored over a wider
 * signal range and paired with a `1/range` pre-gain: input up to ±`range` is mapped, and
 * anything beyond that lands on the end of the curve, i.e. hard-limited. Below `knee` the
 * curve is the identity, so normal material passes untouched.
 */
function softClipCurve(knee: number, range: number, points = 8193) {
  const c = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const u = (i / (points - 1)) * 2 - 1;
    const x = u * range;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/** Voices above this on the combat bus start ducking it, one voice at a time. */
const DUCK_FREE_VOICES = 6;
const DUCK_PER_VOICE = 0.055;

/** Handle on a looping bed, so the owner can keep moving it and fade it out. */
export class LoopHandle {
  private lastGain = -1;
  private lastRate = -1;
  private stopped = false;

  constructor(
    private readonly mixer: Mixer,
    private readonly chain: Chain,
    private readonly src: AudioBufferSourceNode,
    readonly id: string,
    private opts: PlayOptions
  ) {}

  get alive(): boolean {
    return !this.stopped;
  }

  /** Target gain before distance attenuation; smoothed over `tau` seconds. */
  setGain(gain: number, tau = 0.25): void {
    if (this.stopped) return;
    this.opts.gain = gain;
    this.mixer.applySpatial(this.chain, this.opts, tau);
    this.lastGain = gain;
  }

  setPosition(x: number, y: number, z: number, tau = 0.25): void {
    if (this.stopped) return;
    this.opts.x = x;
    this.opts.y = y;
    this.opts.z = z;
    this.mixer.applySpatial(this.chain, this.opts, tau);
  }

  /** Re-evaluate distance attenuation against the current listener. */
  refresh(tau = 0.25): void {
    if (this.stopped) return;
    this.mixer.applySpatial(this.chain, this.opts, tau);
  }

  setRate(rate: number): void {
    if (this.stopped) return;
    if (Math.abs(rate - this.lastRate) < 0.002) return;
    this.lastRate = rate;
    try {
      this.src.playbackRate.setTargetAtTime(rate, this.mixer.time, 0.08);
    } catch {
      /* rate automation is cosmetic; never let it break the frame */
    }
  }

  get gain(): number {
    return this.lastGain;
  }

  stop(fade = 0.35): void {
    if (this.stopped) return;
    this.stopped = true;
    this.mixer.releaseLoop(this.chain, this.src, fade);
  }
}

export class Mixer {
  readonly master: GainNode;
  readonly buses: Record<BusName, GainNode>;
  private masterClip: WaveShaperNode | null = null;
  private combatSat: WaveShaperNode | null = null;
  private convolver: ConvolverNode | null = null;
  private verbReturn: GainNode | null = null;
  /** Bus gains as requested, before combat ducking is applied on top. */
  private busBase: Record<BusName, number>;
  private combatDuck = 1;

  private chains: Chain[] = [];
  private voices: Voice[] = [];
  private loops = new Set<LoopHandle>();

  /** Per-id rate limiter: last start time, so identical hits cannot machine-gun. */
  private lastStart = new Map<string, number>();

  /** Listener basis, refreshed once per frame from the camera. */
  private lx = 0; private ly = 0; private lz = 0;
  private rx = 1; private ry = 0; private rz = 0;
  private fx = 0; private fy = 0; private fz = -1;

  /** Set false while the context is suspended so nothing is scheduled into the void. */
  running = false;

  /** Counters for the debug overlay and the self-test. */
  readonly counters = { started: 0, culled: 0, stolen: 0, peakVoices: 0 };

  constructor(
    readonly ctx: BaseAudioContext,
    readonly bank: SoundBank,
    opts: { reverb?: boolean; masterGain?: number } = {}
  ) {
    this.master = ctx.createGain();
    this.master.gain.value = opts.masterGain ?? 0.85;

    // Final safety stage: transparent below 0.62, folds smoothly to ±1 for anything up to
    // ±2, hard-limits beyond. A clash landing on a volley landing on the roar cannot clip.
    try {
      const pre = ctx.createGain();
      pre.gain.value = 0.5;
      this.masterClip = ctx.createWaveShaper();
      this.masterClip.curve = softClipCurve(0.62, 2);
      // No oversampling on the final stage: the resampling filter overshoots the curve's
      // ceiling by about half a decibel, which measured as a 1.055 peak — precisely the
      // clipping this node exists to prevent. Aliasing on extreme peaks is the cheaper sin.
      this.masterClip.oversample = 'none';
      this.master.connect(pre);
      pre.connect(this.masterClip);
      this.masterClip.connect(ctx.destination);
    } catch {
      this.master.connect(ctx.destination);
    }

    const mk = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.busBase = { music: 0.5, ambience: 0.55, combat: 1.0, ui: 0.7, voice: 0.8 };
    this.buses = {
      music: mk(this.busBase.music),
      ambience: mk(this.busBase.ambience),
      combat: mk(this.busBase.combat),
      ui: mk(this.busBase.ui),
      voice: mk(this.busBase.voice),
    };

    // Combat saturator: a lower knee than the master stage, so dozens of impacts fold into
    // one another and gain density instead of stacking arithmetically into the ceiling.
    try {
      const pre = ctx.createGain();
      pre.gain.value = 0.5;
      this.combatSat = ctx.createWaveShaper();
      this.combatSat.curve = softClipCurve(0.45, 2);
      this.combatSat.oversample = '2x';
      this.buses.combat.connect(pre);
      pre.connect(this.combatSat);
      this.combatSat.connect(this.master);
    } catch {
      this.buses.combat.connect(this.master);
    }
    this.buses.music.connect(this.master);
    this.buses.ambience.connect(this.master);
    this.buses.ui.connect(this.master);
    this.buses.voice.connect(this.master);

    if (opts.reverb !== false) {
      const ir = bank.get('ir_field');
      if (ir) {
        try {
          this.convolver = ctx.createConvolver();
          this.convolver.normalize = true;
          this.convolver.buffer = ir;
          this.verbReturn = ctx.createGain();
          this.verbReturn.gain.value = 0.9;
          this.convolver.connect(this.verbReturn);
          this.verbReturn.connect(this.master);
        } catch (err) {
          // A refused impulse response (sample-rate mismatch) is not fatal — dry is fine.
          console.warn('[audio] field reverb unavailable:', err);
          this.convolver = null;
          this.verbReturn = null;
        }
      }
    }
  }

  get time(): number {
    return this.ctx.currentTime;
  }

  get activeVoices(): number {
    return this.voices.length + this.loops.size;
  }

  get loopCount(): number {
    return this.loops.size;
  }

  /** Music routes here so its reverb is the hall, not the battlefield. */
  get musicBus(): GainNode {
    return this.buses.music;
  }

  get reverbInput(): AudioNode | null {
    return this.convolver;
  }

  // -------------------------------------------------------------------------
  // Listener
  // -------------------------------------------------------------------------

  /**
   * Install the listener basis. `right` and `forward` are the camera's world axes; both
   * are projected onto the ground plane, because a battle heard from a camera pitched
   * 60° down should still pan left and right by compass bearing, not by screen space.
   */
  setListener(
    px: number, py: number, pz: number,
    rx: number, rz: number,
    fx: number, fz: number
  ): void {
    this.lx = px; this.ly = py; this.lz = pz;
    const rl = Math.hypot(rx, rz) || 1;
    this.rx = rx / rl; this.rz = rz / rl; this.ry = 0;
    const fl = Math.hypot(fx, fz) || 1;
    this.fx = fx / fl; this.fz = fz / fl; this.fy = 0;
  }

  get listenerX(): number { return this.lx; }
  get listenerY(): number { return this.ly; }
  get listenerZ(): number { return this.lz; }
  /** Ground-plane forward axis of the listener, for placing sounds relative to the view. */
  get forwardX(): number { return this.fx; }
  get forwardZ(): number { return this.fz; }

  /** Distance from the listener to a world point. */
  distanceTo(x: number, y: number, z: number): number {
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Attenuation for a point at distance `d`. Inverse-distance for point sources, a much
   * shallower curve for extended ones.
   */
  distanceGain(d: number, aggregate: boolean): number {
    if (d >= CULL_DIST) return 0;
    const roll = aggregate ? BED_ROLLOFF : POINT_ROLLOFF;
    const g = REF_DIST / (REF_DIST + roll * Math.max(0, d - REF_DIST));
    // Fade the last 15% of the cull radius so nothing pops out of existence.
    const edge = clamp01((CULL_DIST - d) / (CULL_DIST * 0.15));
    return g * edge;
  }

  /**
   * Air absorption. High frequencies are lost to the atmosphere at roughly 1 dB per
   * 100 m at 4 kHz and far more above that; an exponential cutoff sells "distance" more
   * convincingly than any amount of level reduction, which is why it is not optional.
   */
  absorptionCutoff(d: number): number {
    // Physically 400 m of air only costs about 4 dB at 4 kHz; this curve is roughly three
    // times that, which is the exaggeration every game of this kind makes. Without it the
    // strategic view sounds like a quiet melee rather than a distant one.
    return clamp(19000 * Math.exp(-d / 170), 320, 19000);
  }

  // -------------------------------------------------------------------------
  // Chain pool
  // -------------------------------------------------------------------------

  private takeChain(bus: BusName): Chain | null {
    for (const c of this.chains) {
      if (!c.inUse) {
        c.inUse = true;
        this.rewire(c, bus);
        return c;
      }
    }
    if (this.chains.length >= MAX_SPATIAL_VOICES + 8) return null;
    const ctx = this.ctx;
    const chain: Chain = {
      gain: ctx.createGain(),
      lp: ctx.createBiquadFilter(),
      pan: ctx.createStereoPanner(),
      send: ctx.createGain(),
      busName: bus,
      inUse: true,
    };
    chain.lp.type = 'lowpass';
    chain.lp.Q.value = 0.4;
    chain.gain.connect(chain.lp);
    chain.lp.connect(chain.pan);
    chain.send.gain.value = 0;
    if (this.convolver) {
      chain.pan.connect(chain.send);
      chain.send.connect(this.convolver);
    }
    chain.pan.connect(this.buses[bus]);
    this.chains.push(chain);
    return chain;
  }

  private rewire(c: Chain, bus: BusName): void {
    if (c.busName === bus) return;
    try {
      c.pan.disconnect(this.buses[c.busName]);
    } catch {
      /* already disconnected */
    }
    c.pan.connect(this.buses[bus]);
    c.busName = bus;
  }

  /** Write gain / filter / pan / send for a chain from its spatial options. */
  applySpatial(c: Chain, o: PlayOptions, tau = 0): void {
    const t = this.ctx.currentTime;
    const base = o.gain ?? 1;
    let g = base;
    let cutoff = 19000;
    let pan = 0;
    let send = 0.04;

    if (!o.ambient) {
      const x = o.x ?? 0, y = o.y ?? 0, z = o.z ?? 0;
      const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const agg = o.aggregate === true;
      g = base * this.distanceGain(d, agg);
      cutoff = this.absorptionCutoff(d);
      if (d > 0.001) {
        const ix = dx / d, iz = dz / d;
        // Distant sources collapse toward the centre: at 400 m the whole battle is in
        // front of you, not on one side of your head.
        const width = (o.width ?? 1) * lerp(1, 0.35, clamp01(d / 420)) * (agg ? 0.7 : 1);
        pan = clamp((ix * this.rx + iz * this.rz) * width, -1, 1);
        // Behind the listener: a little darker and a little quieter.
        const front = ix * this.fx + iz * this.fz;
        if (front < 0) {
          g *= lerp(1, 0.8, -front);
          cutoff = Math.min(cutoff, lerp(19000, 5200, -front));
        }
      }
      // Wetter with distance, which is how the ear reads "far" even indoors-free.
      send = g * lerp(0.05, 0.85, clamp01(d / 380));
    }

    if (tau > 0) {
      c.gain.gain.setTargetAtTime(g, t, tau);
      c.lp.frequency.setTargetAtTime(cutoff, t, tau);
      c.pan.pan.setTargetAtTime(pan, t, tau);
      if (this.convolver) c.send.gain.setTargetAtTime(send, t, tau);
    } else {
      c.gain.gain.value = g;
      c.lp.frequency.value = cutoff;
      c.pan.pan.value = pan;
      if (this.convolver) c.send.gain.value = send;
    }
  }

  /** Audible gain a sound would get, without allocating anything. Used for culling. */
  audibility(o: PlayOptions): number {
    if (o.ambient) return o.gain ?? 1;
    const d = this.distanceTo(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    return (o.gain ?? 1) * this.distanceGain(d, o.aggregate === true);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  /**
   * Fire a one-shot. Returns false when the sound was culled (inaudible, rate-limited or
   * out-scored by every live voice), which callers use to decide whether to fall back to
   * a cluster layer instead.
   */
  play(id: string, o: PlayOptions = {}, minInterval = 0): boolean {
    if (!this.running) return false;
    const buf = this.bank.get(id);
    if (!buf) return false;

    const t = this.ctx.currentTime;
    if (minInterval > 0) {
      const last = this.lastStart.get(id) ?? -1e9;
      if (t - last < minInterval) {
        this.counters.culled++;
        return false;
      }
    }

    const heard = this.audibility(o);
    if (heard < AUDIBLE_FLOOR) {
      this.counters.culled++;
      return false;
    }

    const score = heard * (1 + (o.priority ?? 0));
    this.reap(t);
    // Beds hold their reservation whether or not they are currently using it.
    const oneShotBudget = MAX_SPATIAL_VOICES - Math.max(this.loops.size, BED_RESERVE);
    if (this.voices.length >= oneShotBudget && !this.steal(score, t)) {
      this.counters.culled++;
      return false;
    }

    const bus = o.bus ?? 'combat';
    const chain = this.takeChain(bus);
    if (!chain) {
      this.counters.culled++;
      return false;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const rate = o.rate ?? 1;
    src.playbackRate.value = rate;
    src.connect(chain.gain);
    this.applySpatial(chain, o, 0);

    const when = Math.max(t, o.when ?? t);
    try {
      src.start(when);
    } catch {
      chain.inUse = false;
      return false;
    }
    // Buffers generated at 22.05 kHz play back resampled, so duration must account for
    // the context's rate as well as the requested pitch.
    const dur = buf.duration / Math.max(0.05, rate);
    const voice: Voice = { chain, src, startedAt: when, endsAt: when + dur + 0.05, score, id };
    this.voices.push(voice);
    this.lastStart.set(id, when);
    this.counters.started++;
    if (this.activeVoices > this.counters.peakVoices) this.counters.peakVoices = this.activeVoices;

    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      chain.inUse = false;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    };
    return true;
  }

  /** Drop voices whose scheduled end has passed (belt and braces around `onended`). */
  private reap(t: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].endsAt <= t) {
        this.voices[i].chain.inUse = false;
        this.voices.splice(i, 1);
      }
    }
  }

  /**
   * Replace the least important live voice, but only if the newcomer is clearly more
   * important (0.75×) and the victim has been sounding long enough that cutting it will not
   * click. Otherwise the newcomer is simply dropped — the cluster bed covers for it.
   */
  private steal(score: number, t: number): boolean {
    let worst = -1;
    let worstScore = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (t - v.startedAt < MIN_AGE_TO_STEAL) continue;
      if (v.score < worstScore) {
        worstScore = v.score;
        worst = i;
      }
    }
    if (worst < 0 || worstScore >= score * 0.75) return false;
    const v = this.voices[worst];
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
    v.chain.inUse = false;
    this.voices.splice(worst, 1);
    this.counters.stolen++;
    return true;
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  startLoop(id: string, o: PlayOptions = {}): LoopHandle | null {
    if (!this.running) return null;
    const buf = this.bank.get(id);
    if (!buf) return null;
    // A bed that cannot get a voice simply does not start; `Bed.set` retries next frame.
    if (this.activeVoices >= MAX_SPATIAL_VOICES) return null;
    const chain = this.takeChain(o.bus ?? 'ambience');
    if (!chain) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    src.connect(chain.gain);
    // Start silent and let the owner fade in; a bed snapping on is instantly noticeable.
    this.applySpatial(chain, { ...o, gain: 0 }, 0);
    try {
      src.start(this.ctx.currentTime);
    } catch {
      chain.inUse = false;
      return null;
    }
    const h = new LoopHandle(this, chain, src, id, { ...o });
    this.loops.add(h);
    if (this.activeVoices > this.counters.peakVoices) this.counters.peakVoices = this.activeVoices;
    return h;
  }

  /** Called by `LoopHandle.stop`. */
  releaseLoop(chain: Chain, src: AudioBufferSourceNode, fade: number): void {
    const t = this.ctx.currentTime;
    try {
      chain.gain.gain.cancelScheduledValues(t);
      chain.gain.gain.setTargetAtTime(0, t, Math.max(0.02, fade / 3));
      src.stop(t + fade + 0.05);
    } catch {
      /* context may be closing */
    }
    src.onended = () => {
      chain.inUse = false;
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
    };
    for (const h of this.loops) if (!h.alive) this.loops.delete(h);
  }

  setBusGain(bus: BusName, v: number, tau = 0.3): void {
    const target = clamp(v, 0, 4);
    this.busBase[bus] = target;
    const applied = bus === 'combat' ? target * this.combatDuck : target;
    const g = this.buses[bus];
    if (tau > 0) g.gain.setTargetAtTime(applied, this.ctx.currentTime, tau);
    else g.gain.value = applied;
  }

  /** Current combat-bus ducking factor, for the debug overlay. */
  get duck(): number {
    return this.combatDuck;
  }

  setMasterGain(v: number, tau = 0.2): void {
    if (tau > 0) this.master.gain.setTargetAtTime(clamp(v, 0, 2), this.ctx.currentTime, tau);
    else this.master.gain.value = clamp(v, 0, 2);
  }

  /**
   * Housekeeping plus the combat bus's gain riding. One pass over at most forty voices, so
   * this stays flat as the battle gets louder.
   */
  update(): void {
    const t = this.ctx.currentTime;
    this.reap(t);
    // Counting chains rather than voices so the melee-clatter and hooves beds — which are
    // loops, not one-shots — pull their weight in the ducking too.
    let combat = 0;
    for (const c of this.chains) if (c.inUse && c.busName === 'combat') combat++;
    const duck = 1 / (1 + DUCK_PER_VOICE * Math.max(0, combat - DUCK_FREE_VOICES));
    if (Math.abs(duck - this.combatDuck) > 0.008) {
      this.combatDuck = duck;
      this.buses.combat.gain.setTargetAtTime(this.busBase.combat * duck, t, 0.12);
    }
  }

  /** Immediately silence and forget every loop (used when the battle ends or resets). */
  stopAllLoops(fade = 0.4): void {
    for (const h of [...this.loops]) h.stop(fade);
    this.loops.clear();
  }

  dispose(): void {
    for (const v of this.voices) {
      try {
        v.src.stop();
        v.src.disconnect();
      } catch {
        /* ignore */
      }
      v.chain.inUse = false;
    }
    this.voices.length = 0;
    for (const h of [...this.loops]) h.stop(0.02);
    this.loops.clear();
    for (const c of this.chains) {
      try {
        c.gain.disconnect();
        c.lp.disconnect();
        c.pan.disconnect();
        c.send.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.chains.length = 0;
    try {
      this.master.disconnect();
      this.masterClip?.disconnect();
      this.combatSat?.disconnect();
      this.convolver?.disconnect();
      this.verbReturn?.disconnect();
      for (const b of Object.values(this.buses)) b.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * A continuous layer whose level is driven from simulation state — the melee roar, wind,
 * a marching cohort's hooves. The underlying looping voice only exists while the layer is
 * audible, so a quiet battlefield does not spend voices on silence.
 */
export class Bed {
  private handle: LoopHandle | null = null;
  private silentFor = 0;
  private target = 0;

  constructor(
    private readonly mixer: Mixer,
    readonly id: string,
    private readonly opts: { bus: BusName; aggregate?: boolean; ambient?: boolean; width?: number; tau?: number }
  ) {}

  get gain(): number {
    return this.target;
  }

  get live(): boolean {
    return this.handle !== null;
  }

  /**
   * Drive the layer. `gain` below the audibility floor for two seconds releases the voice.
   * Position is ignored for `ambient` beds (wind, which is everywhere).
   */
  set(dt: number, gain: number, x = 0, y = 0, z = 0, rate = 1): void {
    this.target = gain;
    if (gain > 0.006) {
      this.silentFor = 0;
      if (!this.handle) {
        this.handle = this.mixer.startLoop(this.id, {
          bus: this.opts.bus,
          aggregate: this.opts.aggregate,
          ambient: this.opts.ambient,
          width: this.opts.width,
          x, y, z,
          gain: 0,
          priority: 0.5,
        });
      }
      if (this.handle) {
        this.handle.setPosition(x, y, z, 0.001);
        this.handle.setGain(gain, this.opts.tau ?? 0.45);
        this.handle.setRate(rate);
      }
    } else {
      this.silentFor += dt;
      if (this.handle) {
        this.handle.setGain(0, this.opts.tau ?? 0.45);
        if (this.silentFor > 2) {
          this.handle.stop(0.4);
          this.handle = null;
        }
      }
    }
  }

  stop(fade = 0.4): void {
    this.handle?.stop(fade);
    this.handle = null;
    this.target = 0;
  }
}
