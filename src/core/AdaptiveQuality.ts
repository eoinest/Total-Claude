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
 * The ladder is ordered by **what a lever costs to operate**, not by what it looks like.
 *
 * That inverts the obvious design and it is the main thing this engine's measurements teach.
 * Grass is one uniform write; the four post flags are booleans `PostFX.render` reads off
 * `ctx.quality` every frame. All five are free to move, instant, and reversible.
 *
 * Resolution is not. A resolution change is the only lever here that must reallocate: `PostFX`
 * rasterises the world into `sceneRT`, sized from `getDrawingBufferSize()` at allocation time,
 * so the scale cannot move without freeing and rebuilding nineteen render targets plus an
 * `SMAAPass.setSize`. Measured at **~4.1 ms best-of-blocks with an observed worst case of
 * 668 ms** (Rome assault, ultra, 1080p, 16 interleaved blocks at machine load 28). A lever whose
 * worst case is two-thirds of a second can produce, in the act of trying to fix the lag, exactly
 * the freeze it was reaching for.
 *
 * So the free levers go first and absorb small overloads with no allocation at all, and
 * resolution is coarse-rung and dwell-gated underneath them. The ramps still overlap: resolution
 * opens at pressure 0.30 rather than waiting for grass to bottom out, because on a Retina panel
 * at ultra it is four times the pixels and by far the biggest lever there is.
 *
 * A methodological note worth keeping, because it nearly cost a wrong number: `new
 * THREE.WebGLRenderTarget` allocates no GPU memory. Three creates the texture and framebuffer
 * lazily in `textures.setupRenderTarget`, the first time the target is bound. Timing the
 * allocation call alone measures JS object churn and reports 0.3 ms for nineteen 1080p targets —
 * a figure that cannot be true. The frame that materialises the targets has to be inside the
 * timed block.
 */
const GRASS_SEGMENTS: Array<Ramp & { from: number; to: number }> = [
  { p0: 0.0, p1: 0.3, from: 1.0, to: 0.65 },
  { p0: 0.3, p1: 0.7, from: 0.65, to: NaN },
];

const RES_SEGMENTS: Array<Ramp & { from: number; to: number }> = [
  { p0: 0.3, p1: 0.6, from: 1.0, to: 0.85 },
  // The tail runs to the tier's own floor, so this segment's `to` is filled in per tier.
  { p0: 0.6, p1: 1.0, from: 0.85, to: NaN },
];

/**
 * The resolution rungs, and why they are geometric-ish rather than evenly spaced.
 *
 * Nine values between 1.0 and 0.5, spaced so each step is a roughly equal *fraction* of the
 * remaining pixel count — fill cost goes as scale², so evenly spaced scales would buy wildly
 * unequal amounts of time and the controller's gain would change as it descended. Coarse rungs
 * also mean two consecutive pressure nudges frequently land on the same rung and skip the
 * reallocation entirely, which is the cheapest possible way to rate-limit an expensive lever.
 */
const RES_RUNGS = [1.0, 0.92, 0.85, 0.78, 0.71, 0.65, 0.59, 0.54, 0.5];

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
 * Reversals within `FLIP_WINDOW_MS` of each other before the loop gives up and holds.
 *
 * drei's `PerformanceMonitor` ships `flipflops: Infinity` and the community configuration
 * everyone copies sets a finite one, because a controller that has reversed six times has
 * demonstrated that the machine sits exactly on its own threshold and no further movement will
 * fix that — it will only be visible. Latching is the direct answer to "must not oscillate
 * visibly", and it is the part of that algorithm most implementations leave out.
 *
 * Six, not drei's suggested two or three, because a reversal here is separated by at least the
 * 2 s raise dwell: six of them is a minimum of twelve seconds of hunting, which is long enough
 * that a genuine scene change (a city camera cutting to a melee and back) is not mistaken for
 * it. Unlike drei's, the latch is releasable — see `LATCH_RELEASE_MS`.
 */
const LATCH_REVERSALS = 6;
/**
 * Hold the latch until the frame has stayed inside the dead band this long.
 *
 * drei stops adapting permanently. That is wrong for a game where the scene's cost changes by
 * more than the whole lever range over a battle: the frame at the deployment camera and the
 * frame in the middle of a rout are different problems, and a loop that latched during the
 * first must be able to work during the second. A minute of quiet is far longer than any
 * hunting episode and much shorter than a battle.
 */
const LATCH_RELEASE_MS = 60000;

/**
 * Camera-motion regression, after R3F's `AdaptiveDpr` + `regress()`.
 *
 * Two things make this worth having on top of the measured loop. Motion masks softness — a
 * panning image at 0.85 of full resolution is not distinguishable from full, while a still one
 * is — and panning is measurably this project's worst case, the only camera that touches 226
 * draws against a 220 budget. So the cheap frames are exactly the ones nobody can see.
 *
 * It is deliberately *not* a pressure change. Pressure is the controller's belief about the
 * machine, and the camera moving is not evidence about the machine; folding it in would corrupt
 * the state that has to survive between scenes. It multiplies a lever instead.
 *
 * **It regresses grass rather than resolution, and that is a departure from R3F worth stating.**
 * `AdaptiveDpr` moves the pixel ratio because in a typical R3F scene that is free. Here it is
 * the one lever that costs ~4.1 ms to operate with a 668 ms tail, and a player who pans in
 * bursts would pay that twice per burst — a feature that manufactures the hitch it exists to
 * prevent. Grass is a uniform write, costs nothing to move, and is *more* valuable during a pan
 * than resolution is: the sward is at its most expensive at exactly the wide and city cameras a
 * pan sweeps through (0.55-3.71 ms, largest there), and thinning it under motion is even harder
 * to see than softening pixels. Same idea, right lever for this engine.
 */
const REGRESS_GRASS = 0.6;
/** Camera world-space movement per frame above which the camera counts as moving. */
const REGRESS_SPEED_M = 0.05;
/** drei's debounce. Long enough that a burst-delivered mouse wheel does not flicker. */
const REGRESS_HOLD_MS = 200;

/**
 * Minimum wall time between two reallocations, which is a dwell on the *lever*, not the loop.
 *
 * One second, against a measured ~4.1 ms per reallocation with a 668 ms worst case. At that
 * rate the amortised cost is 0.07 ms/frame at 60 Hz — under half a percent of the budget — while
 * a controller stepping resolution every 250 ms would pay 0.27 ms/frame, and would pay it
 * precisely when the machine is already struggling. It also sits naturally inside drei's 2.5 s
 * decision window, which is the shipped precedent for how long a quality controller should look
 * before it moves.
 */
const RES_DWELL_MS = 1000;

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
  /** Median of every reallocation this session — the number the design turns on. */
  medianReallocMs: number;
  lastDirection: 'up' | 'down' | 'none';
  /** True once the loop has decided the machine sits on its threshold and stopped moving. */
  latched: boolean;
  regressing: boolean;
  /** Frames excluded from the window because they linked a shader program. */
  discardedLinks: number;
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

/** Evaluate a lever's piecewise ramp at pressure `p`; `NaN` in a segment's `to` means `floor`. */
function ramp(segments: Array<Ramp & { from: number; to: number }>, p: number, floor: number): number {
  let v = segments[0].from;
  for (const seg of segments) {
    const to = Number.isNaN(seg.to) ? floor : seg.to;
    if (p >= seg.p1) v = to;
    else if (p > seg.p0) v = seg.from + (to - seg.from) * ((p - seg.p0) / (seg.p1 - seg.p0));
  }
  return v;
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
  private reallocCosts: number[] = [];
  /** Frames dropped from the window because they linked a shader program. */
  private discardedLinks = 0;

  private latched = false;
  private lastInBandMs = 0;

  /** Camera-motion regression. */
  regressOnMotion = true;
  private regressing = false;
  private lastResMs = -1e9;
  private lastCamX = NaN;
  private lastCamY = 0;
  private lastCamZ = 0;
  private lastMotionMs = -1e9;

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
    /*
     * A tier switch keeps the pressure — the machine has not changed, only what is being asked
     * of it — but the envelope, and therefore every lever's floor, is re-derived from scratch.
     *
     * This reaches a fixed point rather than recursing because `applyRenderQuality` emits only
     * on a real change: the first pass re-derives the levers for the new tier and emits, the
     * second finds them already correct and emits nothing. `reentry` is a second line of
     * defence only, because a flag cannot see the recursion this used to have — `EventBus`
     * defers a re-entrant emit and drains it *after* the handler has returned and cleared any
     * flag it set. It is reset every frame in `sample`.
     */
    ctx.events.on('qualityChanged', () => {
      // A disabled loop must not write anything. Without this it kept re-deriving the scale
      // from its own `pressure` of 0 and overwriting whatever else had set it, so the harness
      // and every probe measured a resolution lever that snapped straight back to 1.0 — and the
      // giveaway was `sceneRT` reading the same width at 0.70 as at 1.00.
      if (!this.enabled) return;
      if (this.reentry++ > 4) return;
      this.resetWindow();
      this.apply(true);
    });
    const w = globalThis as unknown as { __adaptive?: unknown };
    w.__adaptive = this;
  }

  private reentry = 0;

  /** Called by `Engine.frame` with the render half of the frame just completed. */
  sample(renderMs: number, linkedProgram = false): void {
    this.framesSeen++;
    this.reentry = 0;
    if (linkedProgram) {
      // A frame that linked a shader program is not evidence about the renderer's steady-state
      // cost. See the note in `Engine.frame`: the two worst frames of a 1,079-frame session were
      // the only two that linked, at 151 and 65 ms against a p50 of 10.8, and nothing this loop
      // can do makes a `glLinkProgram` cheaper.
      this.discardedLinks++;
      return;
    }
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
    this.trackCamera(now);

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
    const inBand = this.p90 <= DROP_MS && this.p90 >= raiseMs;
    if (inBand) {
      if (this.lastInBandMs === 0) this.lastInBandMs = now;
    } else {
      this.lastInBandMs = 0;
    }

    // Release the latch once the frame has been quiet for a minute. A battle's cost changes by
    // more than the whole lever range between the deployment camera and a rout, so a loop that
    // latched during the first has to be able to work during the second.
    if (this.latched) {
      if (inBand && now - this.lastInBandMs > LATCH_RELEASE_MS) {
        this.latched = false;
        this.reversals = 0;
      }
      return;
    }

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

  /**
   * Enter and leave motion regression.
   *
   * Camera displacement rather than any flag on the rig: it covers pan, edge scroll, rotation
   * about the focus, zoom and a scripted jump with one test, and it couples to nothing.
   */
  private trackCamera(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = ctx.camera.position;
    if (Number.isNaN(this.lastCamX)) {
      this.lastCamX = p.x; this.lastCamY = p.y; this.lastCamZ = p.z;
      return;
    }
    const dx = p.x - this.lastCamX, dy = p.y - this.lastCamY, dz = p.z - this.lastCamZ;
    this.lastCamX = p.x; this.lastCamY = p.y; this.lastCamZ = p.z;
    if (dx * dx + dy * dy + dz * dz > REGRESS_SPEED_M * REGRESS_SPEED_M) this.lastMotionMs = now;

    if (!this.regressOnMotion) {
      if (this.regressing) { this.regressing = false; this.apply(false); }
      return;
    }
    const want = now - this.lastMotionMs < REGRESS_HOLD_MS;
    if (want === this.regressing) return;
    this.regressing = want;
    this.apply(false);
  }

  private move(next: number, dir: 'up' | 'down', now: number): void {
    if (next === this.pressure) return;

    if (this.lastDirection !== 'none' && this.lastDirection !== dir) {
      if (now - this.lastReversalMs < FLIP_WINDOW_MS || this.lastReversalMs < 0) {
        this.reversals = Math.min(LATCH_REVERSALS, this.reversals + 1);
      } else {
        this.reversals = 1;
      }
      this.lastReversalMs = now;
      if (this.reversals >= LATCH_REVERSALS) {
        this.latched = true;
        this.lastInBandMs = 0;
      }
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
    const wanted = Math.max(env.renderScaleFloor, Math.min(1, ramp(RES_SEGMENTS, p, env.renderScaleFloor)));
    // Snap to a rung at or above the tier floor. Coarse rungs are the rate limiter: two
    // consecutive pressure nudges usually land on the same one and skip the reallocation.
    let rung = RES_RUNGS[0];
    for (const r of RES_RUNGS) {
      if (r < env.renderScaleFloor - 1e-9) continue;
      if (Math.abs(r - wanted) < Math.abs(rung - wanted)) rung = r;
    }
    /*
     * Dwell on the expensive lever specifically, not on the loop.
     *
     * The free levers may move every 250 ms; a reallocation may not. Holding the previous rung
     * when the dwell has not elapsed is not a lost step — pressure has already moved, so grass
     * and the post flags have already responded, and the resolution catches up on the next
     * decision. That is what "rate-limit the expensive lever, not the controller" means.
     */
    const now = performance.now();
    if (!fromTierChange && rung !== this.appliedScale && now - this.lastResMs < RES_DWELL_MS) {
      rung = this.appliedScale;
    }

    // --- grass ------------------------------------------------------------
    const bq = this.engine.baseQuality;
    let grassFrac = ramp(GRASS_SEGMENTS, p, env.grassFloorFrac);
    if (this.regressing) grassFrac = Math.max(env.grassFloorFrac, grassFrac * REGRESS_GRASS);

    // --- post -------------------------------------------------------------
    const patch: RenderQualityPatch = {
      renderScale: rung,
      grassDensity: bq.grassDensity * grassFrac,
      depthOfField: bq.depthOfField && p < env.dropDepthOfField,
      motionBlur: bq.motionBlur && p < env.dropMotionBlur,
      volumetricLight: bq.volumetricLight && p < env.dropVolumetricLight,
      ssao: bq.ssao && p < env.dropSsao,
    };

    if (rung !== this.appliedScale) this.lastResMs = now;
    this.appliedScale = rung;


    const t0 = performance.now();
    const realloc = this.engine.applyRenderQuality(patch);
    const cost = performance.now() - t0;


    if (realloc) {
      this.reallocs++;
      this.lastReallocMs = cost;
      this.reallocCosts.push(cost);
      if (this.reallocCosts.length > 64) this.reallocCosts.shift();
      this.skipFrames = REALLOC_SETTLE_FRAMES;
    }
    return realloc ? cost : 0;
  }

  /** Median reallocation cost this session. The number the whole design turns on. */
  medianReallocMs(): number {
    if (!this.reallocCosts.length) return 0;
    const a = [...this.reallocCosts].sort((x, y) => x - y);
    return a[a.length >> 1];
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
      medianReallocMs: this.medianReallocMs(),
      lastDirection: this.lastDirection,
      latched: this.latched,
      regressing: this.regressing,
      discardedLinks: this.discardedLinks,
    };
  }

  /** One line for the debug overlay. */
  hudLine(): string {
    const s = this.state();
    if (!s.enabled) return 'adapt off';
    if (!s.warm) return `adapt warm ${this.framesSeen}/${WARMUP_FRAMES}`;
    const flag = s.latched ? ' LATCH' : s.regressing ? ' pan' : '';
    return (
      `adapt p${(s.pressure * 100).toFixed(0)}%  res ${s.appliedScale.toFixed(2)}` +
      ` (${s.drawingBuffer.w}x${s.drawingBuffer.h})  grass ${s.grassDensity.toFixed(2)}${flag}\n` +
      `  rend p50 ${s.p50.toFixed(1)} p90 ${s.p90.toFixed(1)} p99 ${s.p99.toFixed(1)}` +
      ` band ${s.raiseMs.toFixed(1)}-${s.dropMs.toFixed(1)} x${s.reversals}`
    );
  }

  /** The lever names this loop refuses to move, and it is checked by a probe. */
  static get excludedLevers(): readonly string[] {
    return EXCLUDED;
  }
}
