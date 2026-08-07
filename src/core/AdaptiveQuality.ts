import type { Engine } from './Engine';
import type { EngineContext, QualityTier, RenderQualityPatch, Subsystem } from './Engine';

/**
 * Closed-loop quality control: measure the frame, spend a ladder of render levers, settle.
 *
 * ## Why this exists
 *
 * The quality system it replaces was open-loop and device-shaped. Four fixed presets, and the
 * only resolution lever was `min(window.devicePixelRatio, tier.maxPixelRatio)` — four discrete
 * values, clamped by the display. On a dpr-1 laptop every tier resolved to 1.0 and the lever was
 * completely inert; on a retina display it stepped 1 / 1.25 / 1.5 / 2 and nothing between. A
 * machine that could not hold 60 fps at its chosen tier simply did not hold 60 fps, forever.
 *
 * What replaces it is a controller: sample the render half of every frame, take a high
 * percentile of a rolling window, and move a single scalar `pressure` in [0,1] that a table of
 * ramps turns into render settings. `pressure = 0` is exactly the player's tier; `pressure = 1`
 * is that tier's *floor*. The tier is therefore a ceiling and a floor, not a fixed setting: a
 * player who picks `ultra` on a weak machine gets an honest low frame rate at ultra's floor
 * rather than a silent demotion to `low`.
 *
 * ## What it measures, and what it deliberately does not
 *
 * **The render half of the frame only** — `update` + camera + `preRender` + submit — clocked by
 * `Engine` into `renderMs`. Not the whole frame, and the distinction is load-bearing:
 *
 * `Time` runs the simulation at a fixed 30 Hz off an accumulator, so at a 60 Hz display
 * `ticksThisFrame` alternates 1, 0, 1, 0 and `fixedUpdate` costs 3.657 ms at 8,632 men. Total
 * frame time therefore carries a ±3.7 ms square wave at the display's Nyquist frequency, which
 * is larger than every render lever in this file put together. Feed that into a controller and
 * the sim-heavy frames read as a render problem: the loop drops resolution, the next frame runs
 * no tick and looks fine, the loop recovers, and the accumulator's beat has become an
 * oscillator. That failure would present as bad hysteresis and would in fact be a measurement
 * error. Game speed 2x/4x makes it worse (up to 5 ticks, ~18 ms), and none of it is something
 * resolution can fix.
 *
 * The cost of excluding the sim is that the controller is blind to 3.7 ms of real frame, so that
 * budget is paid back in the threshold instead — see `SIM_RESERVE_MS`.
 *
 * Wall clock, not `EXT_disjoint_timer_query_webgl2`: that extension is available here and it
 * reports 51.2 ms of GPU inside a drained 16.1 ms block. Its sign is usable; its milliseconds
 * are not. GPU backpressure still reaches the wall clock, one frame late, because the driver
 * blocks inside a draw call once the swap chain is full.
 *
 * ## What it must never touch
 *
 * `quality.maxSoldiers` is simulation state. `BattleSystem.init` sizes the soldier pool and
 * eight typed arrays from it, and `scenario.ts` scales unit size from it, so moving it under a
 * running battle changes the order of battle. It is not in `RenderQualityPatch`, so the mistake
 * does not typecheck, and `Engine.applyRenderQuality` re-pins it afterwards anyway.
 *
 * The tier itself is likewise excluded: the loop works *within* the player's choice.
 */

// ---------------------------------------------------------------------------
// Levers: the ladder, and why it is in this order
// ---------------------------------------------------------------------------

/**
 * A lever's ramp: over `p0..p1` of pressure it slides from its tier value to `to`.
 *
 * Ramps overlap on purpose. Spending two cheap-looking levers together at 40 % of their range
 * is less visible than spending one of them to its limit, and it keeps any single lever off the
 * part of its curve where it starts to read as a downgrade.
 */
interface Ramp {
  p0: number;
  p1: number;
}

/**
 * The tier envelope: where each lever is allowed to end up when the loop is at full pressure.
 *
 * These are *floors*, and they are what makes a tier mean something under adaptation. Ultra's
 * floor keeps every post pass and never softens past 0.70 of its own pixel ratio, so ultra on a
 * weak machine is a slow ultra. Low's floor is austere, because a player who asked for low asked
 * for frames.
 */
interface TierEnvelope {
  /** Resolution scale at full pressure. 1.0 is the tier's own `maxPixelRatio`. */
  renderScaleFloor: number;
  /** Grass density at full pressure, as a fraction of the tier's own `grassDensity`. */
  grassFloorFrac: number;
  /**
   * Pressure at which each optional post pass switches off. `Infinity` means the tier never
   * gives it up — that is what "ultra is a ceiling and a floor" buys.
   *
   * All four are read live by `PostFX.render` off `ctx.quality`, so flipping one costs nothing
   * and takes effect on the next frame with no reallocation.
   */
  dropDepthOfField: number;
  dropMotionBlur: number;
  dropVolumetricLight: number;
  dropSsao: number;
}

const ENVELOPES: Record<QualityTier, TierEnvelope> = {
  // Ultra gives up sharpness and grass and nothing else. It is the tier the game is tuned and
  // graded at, so its floor still has to look like the graded frames.
  ultra: {
    renderScaleFloor: 0.7, grassFloorFrac: 0.55,
    dropDepthOfField: 0.78, dropMotionBlur: 0.9,
    dropVolumetricLight: Infinity, dropSsao: Infinity,
  },
  high: {
    renderScaleFloor: 0.65, grassFloorFrac: 0.45,
    dropDepthOfField: 0.5, dropMotionBlur: 0.62,
    dropVolumetricLight: 0.82, dropSsao: Infinity,
  },
  medium: {
    renderScaleFloor: 0.55, grassFloorFrac: 0.35,
    dropDepthOfField: 0.3, dropMotionBlur: 0.36,
    dropVolumetricLight: 0.44, dropSsao: 0.7,
  },
  low: {
    renderScaleFloor: 0.5, grassFloorFrac: 0.25,
    dropDepthOfField: 0.2, dropMotionBlur: 0.24,
    dropVolumetricLight: 0.3, dropSsao: 0.42,
  },
};

/**
 * Resolution is spent in three segments with the other levers interleaved between them.
 *
 * It goes first because it is the only continuous lever in the set and the only one with no pop
 * at all — with SMAA downstream, 1.00 -> 0.90 is not visible in motion and is worth ~19 % of
 * fill. It is spent last as well, because at the bottom of the ladder there is nothing else
 * left that does not change what the game looks like.
 */
const RES_SEGMENTS: Array<Ramp & { from: number; to: number }> = [
  { p0: 0.0, p1: 0.3, from: 1.0, to: 0.9 },
  { p0: 0.3, p1: 0.62, from: 0.9, to: 0.8 },
  // The tail runs to the tier's own floor, so this segment's `to` is filled in per tier.
  { p0: 0.62, p1: 1.0, from: 0.8, to: NaN },
];

/**
 * Grass, the largest single measured knob: 100 % -> 50 % is worth 0.55-3.71 ms, biggest at the
 * wide and city cameras. It comes in second and early because thinning a sward is subtle in a
 * way that switching a post pass off is not.
 */
const GRASS_SEGMENTS: Array<Ramp & { from: number; to: number }> = [
  { p0: 0.15, p1: 0.45, from: 1.0, to: 0.6 },
  { p0: 0.45, p1: 0.8, from: 0.6, to: NaN },
];

/**
 * Levers deliberately left out of the loop.
 *
 * - **`shadowCascades`.** Worth ~39 draws each, and the single largest saving available. Also a
 *   change to `NUM_DIR_LIGHT_SHADOWS`, which is compiled into every lit material: several
 *   hundred milliseconds of recompile, and the code path that does it (`LightingSystem.rebuild`)
 *   is where the grey-world bug lived. A lever whose *adjustment* costs twenty frames cannot be
 *   in a loop that adjusts every few hundred milliseconds. It stays a settings-menu decision.
 * - **`shadowMapSize`.** `LightingSystem.resize` returns early unless the cascade count changed,
 *   so writing this field at runtime does nothing at all. Putting it in the ladder would be a
 *   lever that is wired and silently inert — this project's most common failure mode.
 * - **`antialias` / MSAA samples.** `MSAA_SAMPLES` is a binary 0-or-4 worth 1.18 ms, and moving
 *   it reallocates the scene target and invalidates TAA history. Coarse, visible, and owned by
 *   the render workstream.
 * - **`lodFarDistance`.** It sets where a man becomes a billboard. That is a *legibility*
 *   threshold, not a cost knob — this project already shipped the bug where 89 % of visible men
 *   were billboards and the player reported their army was invisible under its own banners.
 * - **`bloom`.** Signature look, and cheap.
 * - **`maxSoldiers`.** Simulation state. Not expressible in `RenderQualityPatch`.
 */
const EXCLUDED = ['shadowCascades', 'shadowMapSize', 'antialias', 'lodFarDistance', 'bloom', 'maxSoldiers'] as const;

// ---------------------------------------------------------------------------
// Controller constants. Every one of these is derived; none is a taste judgement.
// ---------------------------------------------------------------------------

/** The display's frame budget. 60 Hz is the project's stated target. */
const TARGET_MS = 1000 / 60;

/**
 * Simulation time the controller cannot see and must therefore reserve.
 *
 * `fixedUpdate` measures 3.657 ms at 8,632 men (3.964 ms routing across the wall) against its
 * own 4 ms budget. At a 60 Hz display the 30 Hz sim lands a tick on every other frame, so the
 * worst frame in any pair is `renderMs + 3.7`. Round up to the budget the sim is held to.
 */
const SIM_RESERVE_MS = 4.0;

/**
 * Drop when the render tail exceeds this. 16.67 - 4.0 = 12.67 ms: above it, the frames that
 * carry a sim tick miss vsync, which is exactly what "laggy" is.
 */
const DROP_MS = TARGET_MS - SIM_RESERVE_MS;

/**
 * Dead band. Below `DROP_MS - DEAD_BAND_MS` the loop may recover.
 *
 * Sized against noise rather than against the step, because the step is tiny: the steepest
 * lever segment is resolution at dScale/dp = -0.333, so one 0.05 raise moves scale by 0.0167 —
 * a 3.7 % fill increase, or ~0.4 ms of a 10 ms render half. Step safety alone would justify a
 * band of 0.5 ms. The measured spread does not: a healthy interactive session on this machine
 * runs p50 9.1 / p90 11.0 ms, a p90/p50 of 1.21, and that ratio wanders with machine load. 2.5 ms
 * is 20 % of `DROP_MS` — comfortably wider than the observed wander of the statistic itself, and
 * it parks the settled state around 11 ms of render, i.e. 15 ms whole-frame with a tick.
 */
const DEAD_BAND_MS = 2.5;

/** Each direction reversal at the same level widens the dead band by this much. */
const FLIP_WIDEN_MS = 1.0;
/** ...to at most this, after which the loop has decided the machine sits on the boundary. */
const FLIP_WIDEN_MAX_MS = 4.0;
/** A reversal only counts as flip-flopping if it happens within this of the previous one. */
const FLIP_WINDOW_MS = 8000;
/** Quiet for this long and the accumulated penalty decays one notch. */
const FLIP_DECAY_MS = 45000;

/**
 * Rolling window, in frames. 90 frames is 1.5 s at 60 Hz.
 *
 * The controlled statistic is p90 of this window — the ninth-worst frame. One hitch in ninety
 * does not move it; a sustained problem does. The owner's complaint is the tail, and a mean
 * cannot see a p50 of 9 with a p99 of 60, so a mean is the wrong statistic here. p99 over 90
 * samples is a single frame and pure noise, so it is reported but never controlled on.
 */
const WINDOW = 90;

/** Minimum wall time between two drops. 250 ms is 15 frames: a quarter-second to react. */
const DROP_DWELL_MS = 250;
/**
 * Minimum wall time between two raises, and it must exceed the window length.
 *
 * A raise interval shorter than the 1.5 s window is a guaranteed oscillator, because the second
 * decision is taken on samples the first change has not yet reached. 2 s clears the window with
 * 0.5 s to spare. A drop is allowed to violate this deliberately: a premature drop can only make
 * the frame faster, while a premature raise is how pumping starts.
 */
const RAISE_DWELL_MS = 2000;
/** Reversals lengthen the recovery interval as well as widening the band. */
const RAISE_DWELL_PER_FLIP_MS = 2000;
const RAISE_DWELL_MAX_MS = 10000;

/**
 * Drop step = `(overshoot - 1) * DROP_GAIN`, clamped.
 *
 * At 20 ms against 12.67 the overshoot is 1.58 and the step clamps to 0.20, so the ladder is
 * spent end to end in five steps — 1.25 s at the drop dwell. Fast enough to catch a camera cut
 * into a melee inside a second and a half; slow enough that no single spike can slam the image.
 * At 13.3 ms (5 % over) the step is 0.06, a nudge.
 */
const DROP_GAIN = 1.2;
const DROP_STEP_MIN = 0.04;
const DROP_STEP_MAX = 0.2;

/**
 * Raise step. Fixed and small: recovery is not a control problem, it is a not-being-noticed
 * problem. 0.05 per 2 s is 40 s from floor to ceiling, and near the floor 0.05 of pressure is
 * 0.013 of resolution scale, which is invisible.
 */
const RAISE_STEP = 0.05;

/**
 * Frames of boot to ignore before closing the loop.
 *
 * Shader compilation, texture upload and `PostFX.sweepAnisotropy` — which traverses the whole
 * scene every 64 frames up to 12 times, so 768 frames — all land in here. Adapting against them
 * would drive the resolution to the floor for reasons that resolve themselves. Bounded by wall
 * time as well, so a machine slow enough to make 800 frames take a minute still starts adapting.
 */
const WARMUP_FRAMES = 800;
const WARMUP_MS = 12000;

/** Frames to discard after a change that reallocates render targets. */
const REALLOC_SETTLE_FRAMES = 3;

/**
 * Resolution quantum.
 *
 * A resolution change reallocates PostFX's nineteen render targets, so the scale is snapped to a
 * grid rather than moved every frame. 0.02 gives 25 distinct steps between 0.5 and 1.0 — at
 * 1080p that is a drawing-buffer height step of ~22 px, far below the point where a step is
 * visible, while collapsing a continuous controller output onto a small set of allocations. The
 * change is additionally suppressed when the rounded drawing-buffer size does not move.
 */
const RES_QUANTUM = 0.02;

// ---------------------------------------------------------------------------

export interface AdaptiveState {
  enabled: boolean;
  warm: boolean;
  tier: QualityTier;
  pressure: number;
  renderScale: number;
  /** The scale actually in the renderer, after quantisation. */
  appliedScale: number;
  basePixelRatio: number;
  effectivePixelRatio: number;
  drawingBuffer: { w: number; h: number };
  grassDensity: number;
  post: { ssao: boolean; volumetricLight: boolean; depthOfField: boolean; motionBlur: boolean };
  p50: number;
  p90: number;
  p99: number;
  samples: number;
  reversals: number;
  deadBandMs: number;
  dropMs: number;
  raiseMs: number;
  changes: number;
  reallocs: number;
  /** Cost of the last resolution change, wall clock, in ms. */
  lastReallocMs: number;
  lastDirection: 'up' | 'down' | 'none';
}

export interface ScaleTracePoint {
  /** ms since the loop started. */
  t: number;
  p90: number;
  p50: number;
  pressure: number;
  scale: number;
  grass: number;
  dir: 'up' | 'down';
  reallocMs: number;
}

function percentile(sorted: Float64Array, n: number, q: number): number {
  if (n === 0) return 0;
  const i = Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))));
  return sorted[i];
}

export class AdaptiveQualitySystem implements Subsystem {
  readonly name = 'adaptive';
  /**
   * First of everything.
   *
   * A lever moved here is read this frame by the systems that consume it — `PostFX.render` reads
   * `ctx.quality` at order 900, `LightingSystem` at -100 — so a decision never straddles a frame
   * boundary and the sample that follows measures the settings that produced it.
   */
  readonly order = -200;

  /** Off during a screenshot pass; a resolution that moves mid-shot is not a measurement. */
  enabled: boolean;

  private engine: Engine;
  private ctx?: EngineContext;

  private ring = new Float64Array(WINDOW);
  private sorted = new Float64Array(WINDOW);
  private ringN = 0;
  private ringHead = 0;

  private framesSeen = 0;
  private startMs = 0;
  private skipFrames = 0;

  private pressure = 0;
  private appliedScale = 1;
  private lastChangeMs = -1e9;
  private lastRaiseMs = -1e9;
  private lastDirection: 'up' | 'down' | 'none' = 'none';
  private lastReversalMs = -1e9;
  private lastFlipDecayMs = 0;
  private reversals = 0;

  private changes = 0;
  private reallocs = 0;
  private lastReallocMs = 0;

  /** Ring of decisions, for the debug HUD and for proving the loop settles. */
  readonly trace: ScaleTracePoint[] = [];
  private static readonly TRACE_MAX = 800;

  private p50 = 0;
  private p90 = 0;
  private p99 = 0;

  constructor(engine: Engine, enabled: boolean) {
    this.engine = engine;
    this.enabled = enabled;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.startMs = performance.now();
    // A tier switch keeps the pressure — the machine has not changed, only what is being asked
    // of it — but the envelope, and therefore every lever's floor, is re-derived from scratch.
    ctx.events.on('qualityChanged', () => {
      if (this.applying) return;
      this.resetWindow();
      this.apply(true);
    });
    const w = globalThis as unknown as { __adaptive?: unknown };
    w.__adaptive = this;
  }

  /** Set while this system is writing quality, so its own event does not re-enter. */
  private applying = false;

  /** Called by `Engine.frame` with the render half of the frame just completed. */
  sample(renderMs: number): void {
    this.framesSeen++;
    if (this.skipFrames > 0) {
      this.skipFrames--;
      return;
    }
    this.ring[this.ringHead] = renderMs;
    this.ringHead = (this.ringHead + 1) % WINDOW;
    if (this.ringN < WINDOW) this.ringN++;
  }

  private resetWindow(): void {
    this.ringN = 0;
    this.ringHead = 0;
    this.skipFrames = REALLOC_SETTLE_FRAMES;
  }

  get warm(): boolean {
    return this.framesSeen >= WARMUP_FRAMES || performance.now() - this.startMs >= WARMUP_MS;
  }

  private get deadBandMs(): number {
    return DEAD_BAND_MS + Math.min(FLIP_WIDEN_MAX_MS, this.reversals * FLIP_WIDEN_MS);
  }

  private get raiseDwellMs(): number {
    return Math.min(RAISE_DWELL_MAX_MS, RAISE_DWELL_MS + this.reversals * RAISE_DWELL_PER_FLIP_MS);
  }

  update(): void {
    if (!this.enabled || !this.ctx) return;

    const now = performance.now();

    // Decay one notch of flip-flop penalty after a long quiet spell, so a machine that got
    // pinned by a transient (a load spike from another process) is not penalised forever.
    if (this.reversals > 0 && now - Math.max(this.lastReversalMs, this.lastFlipDecayMs) > FLIP_DECAY_MS) {
      this.reversals--;
      this.lastFlipDecayMs = now;
    }

    if (this.ringN < WINDOW) return;

    const n = this.ringN;
    this.sorted.set(this.ring.subarray(0, n));
    const view = this.sorted.subarray(0, n);
    view.sort();
    this.p50 = percentile(this.sorted, n, 0.5);
    this.p90 = percentile(this.sorted, n, 0.9);
    this.p99 = percentile(this.sorted, n, 0.99);

    if (!this.warm) return;

    const raiseMs = DROP_MS - this.deadBandMs;

    if (this.p90 > DROP_MS) {
      if (now - this.lastChangeMs < DROP_DWELL_MS) return;
      if (this.pressure >= 1) return;
      const over = this.p90 / DROP_MS;
      const step = Math.min(DROP_STEP_MAX, Math.max(DROP_STEP_MIN, (over - 1) * DROP_GAIN));
      this.move(Math.min(1, this.pressure + step), 'down', now);
      return;
    }

    if (this.p90 < raiseMs) {
      if (this.pressure <= 0) return;
      if (now - this.lastRaiseMs < this.raiseDwellMs) return;
      // A raise is only taken on a window that is entirely post-change. A drop is allowed to
      // act on a contaminated window; being early costs nothing but a little sharpness.
      if (now - this.lastChangeMs < this.raiseDwellMs) return;
      this.move(Math.max(0, this.pressure - RAISE_STEP), 'up', now);
    }
  }

  private move(next: number, dir: 'up' | 'down', now: number): void {
    if (next === this.pressure) return;

    if (this.lastDirection !== 'none' && this.lastDirection !== dir) {
      if (now - this.lastReversalMs < FLIP_WINDOW_MS || this.lastReversalMs < 0) {
        this.reversals = Math.min(8, this.reversals + 1);
      } else {
        this.reversals = 1;
      }
      this.lastReversalMs = now;
    }

    this.pressure = next;
    this.lastDirection = dir;
    this.lastChangeMs = now;
    if (dir === 'up') this.lastRaiseMs = now;
    this.changes++;

    const reallocMs = this.apply(false);

    this.trace.push({
      t: now - this.startMs,
      p90: this.p90,
      p50: this.p50,
      pressure: this.pressure,
      scale: this.appliedScale,
      grass: this.ctx ? this.ctx.quality.grassDensity : 0,
      dir,
      reallocMs,
    });
    if (this.trace.length > AdaptiveQualitySystem.TRACE_MAX) this.trace.shift();
  }

  /**
   * Turn the current pressure into settings and hand them to the engine.
   *
   * Returns the wall-clock cost of the resolution change, or 0 when resolution did not move.
   * That number is the whole reason this design snaps the scale to a grid: it is the price of
   * `PostFX.allocate` freeing and rebuilding nineteen render targets, and if it were large the
   * loop would be trading a smooth frame for a periodic hitch.
   */
  private apply(fromTierChange: boolean): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const tier = ctx.quality.tier;
    const env = ENVELOPES[tier] ?? ENVELOPES.high;
    const p = this.pressure;

    // --- resolution -------------------------------------------------------
    let scale = 1;
    for (const seg of RES_SEGMENTS) {
      const to = Number.isNaN(seg.to) ? env.renderScaleFloor : seg.to;
      if (p >= seg.p1) scale = to;
      else if (p > seg.p0) {
        const t = (p - seg.p0) / (seg.p1 - seg.p0);
        scale = seg.from + (to - seg.from) * t;
      }
    }
    scale = Math.max(env.renderScaleFloor, Math.min(1, scale));
    const quantised = Math.round(scale / RES_QUANTUM) * RES_QUANTUM;

    // --- grass ------------------------------------------------------------
    const base = this.engine.baseQuality;
    let grassFrac = 1;
    for (const seg of GRASS_SEGMENTS) {
      const to = Number.isNaN(seg.to) ? env.grassFloorFrac : seg.to;
      if (p >= seg.p1) grassFrac = to;
      else if (p > seg.p0) {
        const t = (p - seg.p0) / (seg.p1 - seg.p0);
        grassFrac = seg.from + (to - seg.from) * t;
      }
    }

    // --- post -------------------------------------------------------------
    const patch: RenderQualityPatch = {
      renderScale: quantised,
      grassDensity: base.grassDensity * grassFrac,
      depthOfField: base.depthOfField && p < env.dropDepthOfField,
      motionBlur: base.motionBlur && p < env.dropMotionBlur,
      volumetricLight: base.volumetricLight && p < env.dropVolumetricLight,
      ssao: base.ssao && p < env.dropSsao,
    };

    const resMoved = fromTierChange || Math.abs(quantised - this.appliedScale) > 1e-6;
    this.appliedScale = quantised;

    this.applying = true;
    const t0 = performance.now();
    const realloc = this.engine.applyRenderQuality(patch);
    const cost = performance.now() - t0;
    this.applying = false;

    if (realloc) {
      this.reallocs++;
      this.lastReallocMs = cost;
      this.skipFrames = REALLOC_SETTLE_FRAMES;
    }
    void resMoved;
    return realloc ? cost : 0;
  }

  /** Force a pressure, for probes and for the settings menu's "reset". */
  setPressure(p: number): void {
    this.pressure = Math.max(0, Math.min(1, p));
    this.apply(true);
    this.resetWindow();
  }

  /** Skip the warm-up. Probes only: the boot spike is real and adapting into it is wrong. */
  forceWarm(): void {
    this.framesSeen = Math.max(this.framesSeen, WARMUP_FRAMES);
  }

  state(): AdaptiveState {
    const ctx = this.ctx;
    const q = ctx?.quality;
    const dbw = this.engine.drawingBufferSize();
    return {
      enabled: this.enabled,
      warm: this.warm,
      tier: q?.tier ?? 'high',
      pressure: this.pressure,
      renderScale: q?.renderScale ?? 1,
      appliedScale: this.appliedScale,
      basePixelRatio: this.engine.basePixelRatio(),
      effectivePixelRatio: this.engine.renderer.getPixelRatio(),
      drawingBuffer: dbw,
      grassDensity: q?.grassDensity ?? 0,
      post: {
        ssao: !!q?.ssao,
        volumetricLight: !!q?.volumetricLight,
        depthOfField: !!q?.depthOfField,
        motionBlur: !!q?.motionBlur,
      },
      p50: this.p50,
      p90: this.p90,
      p99: this.p99,
      samples: this.ringN,
      reversals: this.reversals,
      deadBandMs: this.deadBandMs,
      dropMs: DROP_MS,
      raiseMs: DROP_MS - this.deadBandMs,
      changes: this.changes,
      reallocs: this.reallocs,
      lastReallocMs: this.lastReallocMs,
      lastDirection: this.lastDirection,
    };
  }

  /** One line for the debug overlay. */
  hudLine(): string {
    const s = this.state();
    if (!s.enabled) return 'adapt off';
    if (!s.warm) return `adapt warm ${this.framesSeen}/${WARMUP_FRAMES}`;
    return (
      `adapt p${(s.pressure * 100).toFixed(0)}%  res ${s.appliedScale.toFixed(2)}` +
      ` (${s.drawingBuffer.w}x${s.drawingBuffer.h})  grass ${s.grassDensity.toFixed(2)}\n` +
      `  rend p50 ${s.p50.toFixed(1)} p90 ${s.p90.toFixed(1)} p99 ${s.p99.toFixed(1)}` +
      ` band ${s.raiseMs.toFixed(1)}-${s.dropMs.toFixed(1)} x${s.reversals}`
    );
  }

  /** The lever names this loop refuses to move, and it is checked by a probe. */
  static get excludedLevers(): readonly string[] {
    return EXCLUDED;
  }
}
