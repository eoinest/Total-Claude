import * as THREE from 'three';
import { AdaptiveQualitySystem } from './AdaptiveQuality';
import { EventBus } from './EventBus';
import { Input } from './Input';
import { RTSCamera } from './RTSCamera';
import { SimWatchdog } from './SimWatchdog';
import { Time } from './Time';
import type { GameEvents } from './events';

/**
 * Engine shell: owns the renderer, scene, camera, clock and input, and drives an
 * ordered list of subsystems. Subsystems never reference each other directly —
 * they resolve dependencies through `ctx.get()` and communicate over `ctx.events`.
 */

export interface EngineContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly rig: RTSCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly time: Time;
  readonly input: Input;
  readonly events: EventBus<GameEvents>;
  readonly quality: QualitySettings;
  /** Canvas size in CSS pixels. */
  readonly viewW: number;
  readonly viewH: number;
  /** Resolve another subsystem by name. Throws if absent. */
  get<T extends Subsystem>(name: string): T;
  /** Resolve another subsystem, or undefined if not registered. */
  tryGet<T extends Subsystem>(name: string): T | undefined;
}

export interface Subsystem {
  readonly name: string;
  /** Higher numbers update later. Rendering-adjacent systems should sit above 100. */
  readonly order?: number;
  init?(ctx: EngineContext): void | Promise<void>;
  /** Deterministic simulation step. `dt` is always `time.fixedDt`. */
  fixedUpdate?(dt: number, ctx: EngineContext): void;
  /** Per-frame visual update. Use `time.scaledDt`. Interpolate with `time.alpha`. */
  update?(dt: number, ctx: EngineContext): void;
  /** After the camera is final: culling, LOD, impostor swaps, shader uniforms. */
  preRender?(ctx: EngineContext): void;
  resize?(w: number, h: number, ctx: EngineContext): void;
  dispose?(): void;
}

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

/**
 * The quality settings, and **every one of them is a rendering setting**.
 *
 * There was a `SimQuality` half, with exactly one member: `maxSoldiers`. `BattleSystem.init`
 * sized `SoldierPool` and eight parallel typed arrays from it and `scenario.ts` derived
 * `unitSizeScale` from it through `fittedUnitScale`, so the graphics tier decided how many men
 * fought — measured on one seeded Campus Martius assault as `ultra` 3,074 men with the ram crew
 * dead 16 m short of the door and `medium` 3,009 men with the Porta Flaminia open by t+240. Two
 * different battles from a dropdown. The owner ruled that graphics settings must not change the
 * outcome of a battle, so the field is gone: the pool is `SOLDIER_POOL_CAPACITY` in
 * `src/sim/types.ts`, one number at every tier, and the interface that used to carry the
 * exception no longer exists.
 *
 * The guard that came with it is gone too and does not need replacing. `Engine` froze
 * `simQuality` at construction and re-asserted `q.maxSoldiers` after every patch so that a
 * mid-battle tier press could not resize a deployed army; with nothing simulation-side left in
 * here, `setQuality` may replace the whole object and `AdaptiveQuality` may write any field on
 * any frame, and the strongest statement about the settings path is now structural: **there is
 * no simulation half to protect.** The only field `src/sim`, `src/ai` or `src/units` reads at
 * all is `lodFarDistance`, in `UnitRenderSystem.preRender`, which is the impostor swap distance.
 *
 * Everything here is safe for the adaptive loop to write on any frame — but only where a
 * consumer actually re-reads it after boot, which is not true of all of them; see
 * `AdaptiveQuality.EXCLUDED` for the ones that are wired and inert.
 */
export interface RenderQuality {
  tier: QualityTier;
  /** Device pixel ratio cap for this tier — the ceiling `renderScale` is a fraction of. */
  maxPixelRatio: number;
  /**
   * Continuous resolution scale in (0,1], multiplied into the pixel ratio.
   *
   * This is the lever the old design did not have. `maxPixelRatio` alone gave four discrete
   * values clamped by `window.devicePixelRatio`, so on a dpr-1 display every tier rendered at
   * 1.0 and there was no resolution lever at all, while on a retina display it stepped
   * 1 / 1.25 / 1.5 / 2 with nothing in between. `renderScale` is decoupled from the display: at
   * dpr 1 the engine can render at 0.7 and let the compositor upscale, which is exactly the
   * case a weak laptop needs and the old code could not express.
   */
  renderScale: number;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  ssao: boolean;
  bloom: boolean;
  motionBlur: boolean;
  volumetricLight: boolean;
  depthOfField: boolean;
  /** World-space distance at which soldiers drop to the cheapest LOD. */
  lodFarDistance: number;
  grassDensity: number;
  /** Screen-space AA mode. */
  antialias: 'none' | 'fxaa' | 'smaa' | 'taa';
}

/**
 * Kept as an alias rather than deleted: it is named in about forty places, it reads better at a
 * consumer than `RenderQuality` does, and the equality is the claim. If a simulation-side
 * setting is ever genuinely needed it must arrive as a `BattleConfig` field — something the
 * player chooses, that travels in the `?battle=` token and in a replay record — and not by
 * widening this back into an intersection.
 */
export type QualitySettings = RenderQuality;

/**
 * What the adaptive loop is allowed to write.
 *
 * `tier` is excluded because the loop works *within* the player's choice rather than overriding
 * it. There is nothing else to exclude: every field of `RenderQuality` is a rendering field.
 */
export type RenderQualityPatch = Partial<Omit<RenderQuality, 'tier'>>;

/** Scratch for `drawingBufferSize`, which the debug overlay calls every frame. */
const DB_SCRATCH = new THREE.Vector2();

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low', maxPixelRatio: 1, renderScale: 1, shadowMapSize: 1024, shadowCascades: 2,
    ssao: false, bloom: true, motionBlur: false, volumetricLight: false,
    depthOfField: false, lodFarDistance: 90,
    grassDensity: 0.15, antialias: 'fxaa',
  },
  medium: {
    tier: 'medium', maxPixelRatio: 1.25, renderScale: 1, shadowMapSize: 2048, shadowCascades: 3,
    ssao: true, bloom: true, motionBlur: false, volumetricLight: false,
    depthOfField: false, lodFarDistance: 140,
    grassDensity: 0.45, antialias: 'smaa',
  },
  high: {
    tier: 'high', maxPixelRatio: 1.5, renderScale: 1, shadowMapSize: 2048, shadowCascades: 4,
    ssao: true, bloom: true, motionBlur: true, volumetricLight: true,
    depthOfField: true, lodFarDistance: 220,
    grassDensity: 1, antialias: 'smaa',
  },
  ultra: {
    tier: 'ultra', maxPixelRatio: 2, renderScale: 1, shadowMapSize: 4096, shadowCascades: 4,
    ssao: true, bloom: true, motionBlur: true, volumetricLight: true,
    depthOfField: true, lodFarDistance: 320,
    // SMAA rather than TAA. Soldiers are GPU-skinned instances animated entirely in
    // the vertex shader, so there are no per-object motion vectors to reproject with;
    // TAA's history clamp cannot distinguish a moving man from a disoccluded background
    // and smears a dense melee into mush. TAA can come back once the unit renderer
    // emits a velocity buffer.
    grassDensity: 1.5, antialias: 'smaa',
  },
};

/** Options for a synthetic fast-forward. See `Engine.advance`. */
export interface AdvanceOptions {
  /**
   * Rasterise each synthetic frame. Default `true`, which is what the screenshot harness
   * needs and what makes a long fast-forward cost minutes instead of seconds. Pass `false`
   * when only the simulation state at the far end matters; the canvas is then stale until
   * something draws again.
   */
  render?: boolean;
}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityTier;
  /** Render at a fixed size instead of tracking the window — used by the screenshot harness. */
  fixedSize?: { w: number; h: number };
  /**
   * Close the adaptive-quality loop. Defaults to on for an interactive session and off under
   * `fixedSize`, because a resolution that moves mid-shot is not a measurement — the screenshot
   * harness must render every frame at the settings it was asked for. Probes turn it back on
   * through `window.__adaptive.enabled`.
   */
  adaptive?: boolean;
}

export class Engine {
  readonly scene = new THREE.Scene();
  readonly rig: RTSCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly time = new Time();
  readonly input: Input;
  readonly events = new EventBus<GameEvents>();
  quality: QualitySettings;

  viewW = 1;
  viewH = 1;

  private systems: Subsystem[] = [];
  private byName = new Map<string, Subsystem>();
  private ctx: EngineContext;
  private rafId = 0;
  private running = false;
  private canvas: HTMLCanvasElement;
  private fixedSize?: { w: number; h: number };
  private resizeObserver?: ResizeObserver;

  /**
   * The player's chosen tier, unmodified. The adaptive loop derives every lever's ceiling from
   * this, so `pressure = 0` is exactly what the player asked for.
   */
  private readonly tierQuality: Readonly<QualitySettings>;

  private adaptive: AdaptiveQualitySystem | null = null;
  /** Wall clock, last frame: the fixed-step half, the render half, and the total. */
  lastSimMs = 0;
  lastRenderMs = 0;
  lastFrameMs = 0;
  private advancing = false;
  private skipSubmit = false;

  /**
   * Whether a synthetic fast-forward is in progress.
   *
   * Published because a subsystem cannot otherwise tell a frame the player will see from one
   * of the thousands `advance` fires at whatever rate the CPU manages. Anything that reasons
   * about *wall clock* — the adaptive controller above all — has to sit those frames out.
   */
  get isAdvancing(): boolean {
    return this.advancing;
  }

  /**
   * The thing that notices the battle has stopped, and the thing a thrown `fixedUpdate` is
   * reported to. Owned by the engine rather than registered as a subsystem, on purpose:
   * a watchdog that is one of the systems it watches is a watchdog with a hole in it, and
   * this one has to survive `HudSystem` throwing. See `SimWatchdog`.
   */
  readonly watchdog = new SimWatchdog(this.time);

  /**
   * Installed by the post-processing subsystem. When present the engine calls this
   * instead of `renderer.render`, so the composer owns the final image.
   */
  renderOverride: ((ctx: EngineContext) => void) | null = null;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.fixedSize = opts.fixedSize;
    this.quality = { ...QUALITY_PRESETS[opts.quality ?? 'high'] };
    this.tierQuality = Object.freeze({ ...this.quality });

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // handled in the post chain
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      /*
       * Only for the harness, which is the only thing that reads the viewport back.
       *
       * `preserveDrawingBuffer` makes the compositor *copy* the drawing buffer every frame
       * rather than swap it — at ultra on a Retina panel, a 3840x2160 copy per frame, and it
       * scales with exactly the resolution lever this engine now moves. It was shipped
       * unconditionally to serve `probe-artillery.mjs`, which calls
       * `renderer.domElement.toDataURL()`, and that probe loads with `?harness=1&w=640&h=400`,
       * so gating on `fixedSize` keeps it working and takes the copy off every real player.
       * Nothing in `src/` reads pixels back, and `shoot.mjs` goes through `page.screenshot()`,
       * which is the compositor path and never needed the flag.
       *
       * The cost lands after `frame()` returns and before pixels appear, so no instrument in
       * this project can see it: the measured session has `frame()` at p50 9.1 ms against an
       * rAF interval of 25 ms, and this flag lives in that gap.
       */
      preserveDrawingBuffer: opts.fixedSize !== undefined,
      logarithmicDepthBuffer: false,
    });

    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX holds highlight colour far better than ACES on bright skies and fire.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene.matrixWorldAutoUpdate = true;

    this.input = new Input(opts.canvas);
    this.rig = new RTSCamera(1);

    const self = this;
    this.ctx = {
      get scene() { return self.scene; },
      get camera() { return self.rig.camera; },
      get rig() { return self.rig; },
      get renderer() { return self.renderer; },
      get time() { return self.time; },
      get input() { return self.input; },
      get events() { return self.events; },
      get quality() { return self.quality; },
      get viewW() { return self.viewW; },
      get viewH() { return self.viewH; },
      get: (name) => {
        const s = self.byName.get(name);
        if (!s) throw new Error(`[Engine] required subsystem "${name}" is not registered`);
        return s as never;
      },
      tryGet: (name) => self.byName.get(name) as never,
    };

    this.applyResize();
    this.attachResize();

    // Registered by the engine rather than by `main.ts` on purpose: the loop's only lever that
    // needs privileged access is the pixel ratio, which the engine owns, and a subsystem that
    // has to be remembered in a wiring file is a subsystem that gets forgotten on the next map.
    this.adaptive = new AdaptiveQualitySystem(this, opts.adaptive ?? !opts.fixedSize);
    this.add(this.adaptive);
  }

  /** The adaptive-quality controller. Always present; may be disabled. */
  get adaptiveQuality(): AdaptiveQualitySystem {
    return this.adaptive!;
  }

  /** The player's chosen tier at full quality — the ceiling every lever is a fraction of. */
  get baseQuality(): Readonly<QualitySettings> {
    return this.tierQuality;
  }

  /**
   * The pixel ratio at `renderScale = 1`: the display's own ratio, capped by the tier.
   *
   * On a 1x display this is 1 at every tier, which is why `maxPixelRatio` alone was never a
   * usable lever there.
   */
  basePixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
  }

  /** Backing-store size in device pixels, for the debug overlay and the probes. */
  drawingBufferSize(): { w: number; h: number } {
    this.renderer.getDrawingBufferSize(DB_SCRATCH);
    return { w: Math.round(DB_SCRATCH.x), h: Math.round(DB_SCRATCH.y) };
  }

  get context(): EngineContext {
    return this.ctx;
  }

  add<T extends Subsystem>(sys: T): T {
    if (this.byName.has(sys.name)) {
      throw new Error(`[Engine] duplicate subsystem name "${sys.name}"`);
    }
    this.byName.set(sys.name, sys);
    this.systems.push(sys);
    this.systems.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return sys;
  }

  async initAll(onProgress?: (frac: number, label: string) => void): Promise<void> {
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      onProgress?.(i / this.systems.length, s.name);
      // Sequential on purpose: later systems commonly read state built by earlier ones.
      await s.init?.(this.ctx);
    }

    /*
     * Link the shader programs now, on the loading screen, rather than during play.
     *
     * three.js links a program the first frame a material is actually *drawn*, and on
     * ANGLE-over-Metal that link is a synchronous 40-290 ms on the main thread. Measured
     * over nine interactive sessions: in eight of them the single worst frame of the
     * session was a frame that linked a program. Frames that linked ran at p50 49.2 ms;
     * frames that did not ran at p50 6.2 ms. It is triggered by the *camera* bringing
     * something into view for the first time, not by the fighting getting heavy, and the
     * program count is still climbing at t+88 s of battle — so it never stops happening.
     * It is also amplified: a 151 ms stall fills the fixed-timestep accumulator, so the
     * next frame fires all five `maxStepsPerFrame` ticks and costs another 30-38 ms. One
     * link is felt as two bad frames.
     *
     * Measured on Carthage, 24 s of hard panning per arm: programs linked during play
     * 22 -> 5, and the worst frame of the session 583.7 ms -> 73.0 ms.
     *
     * Two honest caveats, both measured rather than assumed:
     *
     * - **It does much less on Rome** (22 -> 23 links, worst 588 -> 553 ms) because far
     *   less of that scene is compilable at this instant — it links 27 programs here
     *   against Carthage's 44. The mechanism for the difference is not established.
     * - **Do not wrap this in a force-visible traverse.** `compileAsync` walks the scene
     *   with `traverseVisible`, so the obvious improvement is to make everything visible
     *   first and catch the hidden LOD and pool meshes. Measured, that is *worse than
     *   doing nothing*: it compiles fewer programs (27 against 44) and leaves all 22
     *   links in play. Excluding lights from the forcing changes nothing either.
     *
     * The residue is materials that do not exist yet at this point — VFX, decals,
     * ragdolls — plus `LightingSystem.preRender`, which re-links anything
     * `discoverMaterials` has not seen. `UnitRenderSystem.prewarm` is the house pattern
     * for the harder version: force a *draw*, which is the only thing that reliably links
     * the exact variant that will be used.
     */
    onProgress?.(this.systems.length / (this.systems.length + 1), 'shaders');
    await this.renderer.compileAsync(this.scene, this.rig.camera);

    onProgress?.(1, 'ready');
    this.time.resync();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (nowMs: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(nowMs);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** One full frame. Exposed so the screenshot harness can step deterministically. */
  frame(nowMs: number): void {
    const t0 = performance.now();
    const steps = this.time.beginFrame(nowMs);
    this.input.beginFrame(this.time.frameDt, this.viewW, this.viewH);

    const fdt = this.time.fixedDt;
    /*
     * One `try` per system per tick, and the decision it encodes.
     *
     * Unguarded, a throw here propagated out of `frame()` — past every `update`, past
     * `preRender`, past the submit — so the picture froze on the last frame that completed.
     * `start`'s loop reschedules before it calls `frame`, so the loop survived and the page
     * repainted nothing, for ever, with an exception per frame going to a console nobody had
     * open. That is a second flavour of the same silent freeze this pass exists to end.
     *
     * The behaviour is **report loudly once and keep the frame alive**, and the three
     * alternatives were each worse:
     *
     * - *Let it propagate.* The player gets a frozen picture and no explanation. This is what
     *   shipped.
     * - *Catch and swallow.* The battle keeps drawing and keeps being wrong and nobody is ever
     *   told, which is the failure mode this whole pass is about. `SimWatchdog.fault` reports
     *   the first occurrence of each distinct (phase, system, message) to the console *and to
     *   the screen*, counts the rest, and re-throws once asynchronously so `window.onerror`
     *   still fires and every `pageerror` collector in `tools/` still sees it exactly once.
     * - *Disable the offending system.* Tempting and wrong. Dropping `BattleSystem` out of the
     *   loop converts a crash into a battle that is quietly not the battle — the exact trade
     *   that produced this bug report. A system that throws is called again next tick; if the
     *   fault was transient it recovers on its own, and if it is not the counter on the banner
     *   says so.
     *
     * Per system rather than per tick so one bad system cannot take the other twenty-four
     * with it, which is the difference between a broken feature and a broken battle.
     */
    for (let n = 0; n < steps; n++) {
      for (const s of this.systems) {
        if (!s.fixedUpdate) continue;
        try {
          s.fixedUpdate(fdt, this.ctx);
        } catch (err) {
          this.reportFault('fixedUpdate', s.name, err);
        }
      }
    }

    /*
     * The boundary between the two halves of the frame, and the whole reason it is measured.
     *
     * The sim runs at a fixed 30 Hz off an accumulator, so at a 60 Hz display `ticksThisFrame`
     * alternates 1, 0, 1, 0 while `fixedUpdate` costs 3.657 ms at 8,632 men. Whole-frame time
     * therefore carries a ±3.7 ms square wave at the display's Nyquist frequency — larger than
     * every render lever put together, and larger still at game speed 2x/4x, where five ticks
     * can land in one frame. Feeding that to the adaptive controller would make the sim-heavy
     * frames read as a render problem and turn the accumulator's beat into an oscillator. So
     * the controller sees `lastRenderMs` and nothing else, and pays the sim back as a fixed
     * reserve in its threshold instead.
     */
    const tRenderStart = performance.now();

    const sdt = this.time.scaledDt;
    for (const s of this.systems) s.update?.(sdt, this.ctx);

    // Camera last among updates so it can follow anything the sim moved this frame.
    this.rig.update(this.time.frameDt, this.input, this.viewW, this.viewH);
    this.rig.camera.updateMatrixWorld();

    for (const s of this.systems) s.preRender?.(this.ctx);

    this.renderer.info.reset();
    /*
     * The submit, and the one case that skips it.
     *
     * `skipSubmit` is only ever set by `advance({ render: false })`. Everything above this
     * line still runs — every `fixedUpdate`, every `update`, every `preRender` — so the sim
     * and every subsystem's visual state are exactly what a rendered frame would have left
     * behind. What is dropped is the rasterisation of a frame nobody will look at, and on a
     * fast-forward that is essentially the whole cost. See `advance` for the measurement.
     */
    if (!this.skipSubmit) {
      if (this.renderOverride) this.renderOverride(this.ctx);
      else this.renderer.render(this.scene, this.rig.camera);
    }

    this.input.endFrame();

    if (this.drainAfterFrame) {
      const gl = this.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.drainPx);
    }

    const tEnd = performance.now();
    this.lastSimMs = tRenderStart - t0;
    this.lastRenderMs = tEnd - tRenderStart;
    this.lastFrameMs = tEnd - t0;

    /*
     * Whether this frame linked a shader program, which is the discriminator the adaptive loop
     * needs more than any other.
     *
     * Measured over a 1,079-frame interactive session on Carthage: the two worst frames were
     * the only two that linked a program — 151.0 ms and 65.1 ms, of which 140.8 and 62.0 were
     * render — while frames that linked nothing ran at p50 10.8 ms. So the frame-time
     * distribution is a healthy ~11 ms body with a tail made almost entirely of
     * `glLinkProgram`, three.js linking lazily on the first frame a material is actually drawn.
     *
     * A 151 ms frame is not evidence that the renderer is over budget. It is a one-off that
     * will never recur for that material, and no amount of resolution reduction prevents it or
     * makes it cheaper. A controller that reacted to it would drop quality for a cause it
     * cannot address and then recover — a visible oscillation with a measured trigger. A
     * percentile over a multi-second window helps but is not enough, because a p99 over a
     * few hundred frames is still dominated by exactly these frames. Naming the reason is.
     */
    const progs = this.renderer.info.programs?.length ?? 0;
    const linked = progs > this.lastProgramCount;
    this.lastProgramCount = progs;

    // `advance` runs synthetic frames flat out with no display to pace them, so its wall clock
    // says nothing about whether a player would see a dropped frame.
    if (!this.advancing) {
      this.adaptive?.sample(this.lastRenderMs, linked, this.time.frameDt * 1000, this.lastSimMs);
    }

    // Last, and after the submit, so it is measuring a frame that actually reached the screen.
    this.watchdog.observe({ advancing: this.advancing, running: this.running });
  }

  /**
   * Report a subsystem fault, and make sure it still reaches every instrument that was
   * watching for it.
   *
   * The asynchronous re-throw is the part worth explaining. Swallowing the exception would
   * make `page.on('pageerror')` — which every gate in `tools/` collects, and several fail on —
   * blind to a class of failure it used to catch, so a change made to stop a silent freeze
   * would have introduced a silent regression detector. Re-throwing out of a `setTimeout`
   * reaches `window.onerror` on its own stack, once per distinct fault rather than thirty
   * times a second, and cannot take the frame with it.
   */
  private reportFault(where: string, system: string, err: unknown): void {
    const rep = this.watchdog.fault(where, system, err);
    if (rep.count !== 1) return;
    setTimeout(() => { throw err; }, 0);
  }

  private lastProgramCount = 0;

  /**
   * Force a GPU round trip at the end of every frame, so `lastRenderMs` includes GPU time.
   *
   * **A probe instrument, never shipped on.** A 1x1 `readPixels` is the only real barrier on
   * this stack — `gl.finish()` returns before the GPU drains under ANGLE-on-Metal — and it costs
   * the entire benefit of pipelining, so turning it on makes the game slower in order to measure
   * it honestly. It exists because the CPU-side clock cannot see the resolution lever at all:
   * scale 1.00 -> 0.50 at dpr 2 takes the drained frame from 41 ms to 29 ms while `lastRenderMs`
   * sits flat at 4-5 ms. Any headless measurement of a fill-rate lever needs this or it will
   * report the lever as free.
   */
  drainAfterFrame = false;
  private drainPx = new Uint8Array(4);

  /**
   * Advance the simulation by a wall-clock duration without waiting for real time.
   * The screenshot harness uses this to reach a specific battle state fast.
   *
   * ## `{ render: false }`, and why a fast-forward was the slowest thing in the project
   *
   * Every synthetic frame here rasterises a frame nobody will ever look at, and at the
   * default `stepMs` there are sixty of them per simulated second. That is the entire reason
   * a full-scale siege was believed to be unwatchable: `tools/probe-siegehud.mjs` records
   * "3,440 men … about a tenth of real time … 35 minutes of wall clock to reach t+451", and
   * every one of those minutes was spent drawing. The same battle on a real `requestAnimation-
   * Frame` loop — a player's page, nothing skipped — reaches **t+466 in 465.8 s, 0.999x real
   * time**, at a median per-sample p50 of 4.5 ms and p90 of 7.9 ms over 31 samples, and the
   * frame time does not move when two hundred men reach the parapet. The simulation was never
   * the problem; the fast-forward was, and it is a harness, so its cost had been read as the
   * game's.
   *
   * With `render: false` the submit is skipped and nothing else is: every `fixedUpdate`,
   * `update` and `preRender` runs in the same order with the same arguments, so the sim is
   * bit-identical (asserted by `tools/qa-determinism.mjs`, and by `--ffnorender` in
   * `tools/probe-siegescale.mjs`, which prints the pool hash at every checkpoint).
   *
   * **Do not also coarsen `stepMs` to buy more.** Three independent loads of the Carthage
   * assault, advanced by one schedule and hashed at t+30/90/150/200: `advance(dt, 1000/60)`
   * and `advance(dt, 1000/60, { render: false })` agree on every bit at every checkpoint,
   * while `advance(dt, 166)` and an exactly-five-tick `advance(dt, 1000/6)` both diverge from
   * them at t+30 and stay diverged. Equal tick counts are not enough; how many ticks share a
   * frame reaches the simulation. Several siege probes use the 166 ms idiom for speed and are
   * therefore not fast-forwarding the same battle `qa-determinism.mjs` measures. The submit is
   * the free saving; the step size is not.
   *
   * **Annotated 21 August 2026 — the advice above is right and its stated reason is wrong.**
   * Coarsening `stepMs` *does* change the battle at a given elapsed time, but not because
   * frame grouping reaches the simulation. It is a tick count: at t+30, a 1000/60 step runs
   * 900 ticks, a 166 ms step runs 901 and an exactly-five-tick 1000/6 step runs 899, because
   * `double(1/6)` is about 7e-18 short of five times `double(1/30)` so the fifth subtraction
   * fails once and `maxStepsPerFrame = 5` means the tick is never made up. The arms were never
   * comparing equal tick counts. Held to an *equal tick count* — which `advanceTicks` below
   * exists to do — a 6,783-tick battle carrying real recorded player input is bit-identical at
   * 1000/6 and at 1000/60 on the pool hash, both unit hashes and `BattleFlow.result`, measured
   * by `tools/qa-replay.mjs`. So the simulation is a pure function of (config, seed, tick
   * index), and a probe that wants a cheap fast-forward should ask for ticks, not for seconds.
   *
   * **It leaves the canvas stale.** Anything that screenshots after an advance must render a
   * frame first, which the live rAF loop does on its own and a stopped one does not. That is
   * why it is opt-in rather than the default.
   */
  advance(seconds: number, stepMs = 1000 / 60, opts: AdvanceOptions = {}): void {
    const n = Math.max(1, Math.round((seconds * 1000) / stepMs));
    let t = this.time.elapsed * 1000;
    /*
     * Re-baseline before feeding synthetic timestamps, or this advances far more than asked.
     *
     * `t` is seeded from `time.elapsed`, a cumulative sum of *clamped* deltas. `beginFrame`
     * differences its argument against `lastNow`, which holds the previous *raw* timestamp.
     * Those are two different clocks and they diverge the moment anything clamps — so the
     * first synthetic frame produces a delta with no relation to `stepMs`, and whichever way
     * it diverged the result is wrong: ahead of the wall clock it pins at the 0.25 s clamp
     * and fires all five `maxStepsPerFrame` ticks, behind it goes negative and clamps to 0.
     *
     * Measured: `advance(1e-6, 1e-3)` moved the battle ~0.13 s, not one microsecond, while
     * `probe-shadow.mjs` carried a comment asserting the opposite. Any probe that used a
     * tiny advance to hold the world still was differencing two frames five sim ticks apart
     * and calling it a noise floor. This is the same five-ticks-per-rendered-frame error that
     * made every fps figure in this project's history roughly double the truth; it was fixed
     * in `tools/shoot.mjs` and left live everywhere else, which is why it is fixed here now
     * rather than in each caller.
     *
     * `rebase` rather than `resync`: the latter also zeroes the accumulator, which would stop
     * N short advances being equivalent to one long one — exactly what determinism tests compare.
     */
    this.time.rebase(t);
    // Synthetic frames must not reach the adaptive controller: they run as fast as the CPU
    // allows with nothing pacing them, so their wall clock has no relation to a dropped frame,
    // and a resolution change part-way through an `advance` would make the harness's shots
    // depend on how loaded the machine was.
    const wasAdvancing = this.advancing;
    const wasSkipping = this.skipSubmit;
    this.advancing = true;
    this.skipSubmit = opts.render === false;
    try {
      for (let i = 0; i < n; i++) {
        t += stepMs;
        this.frame(t);
      }
    } finally {
      // `finally`, because a subsystem that throws mid-fast-forward must not leave the engine
      // permanently unable to draw. The old code left `advancing` true on the same path and
      // the page went quietly blind.
      this.advancing = wasAdvancing;
      this.skipSubmit = wasSkipping;
    }
    // Hand the clock back to real time; the next rAF timestamp must not be differenced
    // against a synthetic one.
    this.time.rebase();
  }

  /**
   * Advance until the simulation has executed **exactly** `ticks` more fixed steps.
   *
   * `advance(seconds, stepMs)` cannot do this. A frame runs up to `maxStepsPerFrame` ticks,
   * so the last one overshoots by up to four — and four ticks of lateness is already a
   * different battle. `Time.tickCeiling` closes that: the clock stops handing out steps at
   * the target and the accumulator holds whatever it is owed.
   *
   * This is what lets a replay be compared with its recording across *different frame
   * schedules*. The record is keyed to the tick index, so the only fair comparison is at an
   * equal tick count, and equal elapsed seconds is not the same thing — measured, `t+30`
   * comes out as 900 ticks at a 1000/60 step, 901 at 166 ms and 899 at an exactly-five-tick
   * 1000/6, because `double(1/6)` is about 7e-18 short of five times `double(1/30)` and the
   * fifth subtraction fails once. Three "identical" arms were never comparing equal tick
   * counts.
   *
   * Returns the number of frames it took, which is the arm's own description of its schedule.
   */
  advanceTicks(ticks: number, stepMs = 1000 / 60, opts: AdvanceOptions = {}): number {
    const target = this.time.tick + Math.max(0, Math.round(ticks));
    const prevCeiling = this.time.tickCeiling;
    const prevOwner = this.time.ceilingOwner;
    this.time.setCeiling(target, 'engine.advanceTicks');
    let t = this.time.elapsed * 1000;
    this.time.rebase(t);
    const wasAdvancing = this.advancing;
    const wasSkipping = this.skipSubmit;
    this.advancing = true;
    this.skipSubmit = opts.render === false;
    // Bounded, because a paused clock never reaches the target and a spin is worse than a
    // short run: at 30 Hz a tick needs 33.3 ms of scaled time, so this is generous by 4x.
    const need = Math.max(0, target - this.time.tick);
    const maxFrames = 256 + Math.ceil((need * (1000 / 30)) / Math.max(0.001, stepMs)) * 4;
    let frames = 0;
    try {
      while (this.time.tick < target && frames < maxFrames) {
        t += stepMs;
        this.frame(t);
        frames++;
      }
    } finally {
      this.advancing = wasAdvancing;
      this.skipSubmit = wasSkipping;
      // Hand the ceiling back to whoever had it, name and all. A nested `advanceTicks` inside
      // a lockstep battle must not leave `net`'s ceiling attributed to the harness.
      this.time.setCeiling(prevCeiling, prevOwner);
    }
    this.time.rebase();
    return frames;
  }

  private attachResize(): void {
    if (this.fixedSize) return;
    const onResize = () => this.applyResize();
    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(onResize);
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    }
  }

  private applyResize(): void {
    const w = this.fixedSize?.w ?? Math.max(1, window.innerWidth);
    const h = this.fixedSize?.h ?? Math.max(1, window.innerHeight);
    if (w === this.viewW && h === this.viewH) return;
    this.viewW = w;
    this.viewH = h;

    this.renderer.setPixelRatio(this.basePixelRatio() * this.quality.renderScale);
    this.renderer.setSize(w, h, !this.fixedSize);
    if (this.fixedSize) {
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.rig.resize(w, h);
    for (const s of this.systems) s.resize?.(w, h, this.ctx);
    this.events.emit('resize', { w, h });
  }

  /**
   * Write render-only quality settings and propagate them. Returns whether the drawing buffer
   * was reallocated, which is the expensive case and the one a caller may want to rate-limit.
   *
   * Two propagation paths, and the difference between them is the point:
   *
   * - **Resolution changed.** `renderer.setPixelRatio` resizes the drawing buffer, but on its
   *   own that only changes the final present blit. `PostFX` rasterises the world into
   *   `sceneRT`, a fixed-size FBO sized from `getDrawingBufferSize()` **at allocation time**, so
   *   without a `resize` fan-out the 98-draw colour pass with 9,000 men in it keeps running at
   *   the old resolution and the lever buys exactly nothing. Every symptom of working, zero
   *   milliseconds. So a resolution change must reach `PostFX.resize` -> `allocate`, and it
   *   costs a full rebuild of nineteen render targets plus an `SMAAPass.setSize`.
   * - **Anything else.** `PostFX.render` reads `ssao`, `volumetricLight`, `depthOfField`,
   *   `motionBlur` and `bloom` off `ctx.quality` every frame, so those need no fan-out at all —
   *   they are free and take effect next frame. Reallocating for them would be nineteen render
   *   targets rebuilt to change a boolean.
   */
  applyRenderQuality(patch: RenderQualityPatch): boolean {
    const q = this.quality;
    let resolutionMoved = false;
    let changed = false;

    if (patch.renderScale !== undefined) {
      // 0.2 is a floor on absurdity, not a quality decision — the tiers set the real floors.
      const s = Math.max(0.2, Math.min(1, patch.renderScale));
      if (Math.abs(s - q.renderScale) > 1e-6) {
        q.renderScale = s;
        resolutionMoved = true;
      }
    }
    if (patch.maxPixelRatio !== undefined && patch.maxPixelRatio !== q.maxPixelRatio) {
      q.maxPixelRatio = patch.maxPixelRatio;
      resolutionMoved = true;
    }
    // A no-op alias since `QualitySettings` *is* `RenderQuality`; kept because it is what names
    // the key type for `set` below, and because the day a simulation-side setting is proposed
    // again this line is where the intersection would have to reappear.
    const rq: RenderQuality = q;
    const set = <K extends keyof RenderQuality>(k: K, v: RenderQuality[K] | undefined): void => {
      if (v === undefined || rq[k] === v) return;
      rq[k] = v;
      changed = true;
    };
    set('shadowMapSize', patch.shadowMapSize);
    set('shadowCascades', patch.shadowCascades);
    set('ssao', patch.ssao);
    set('bloom', patch.bloom);
    set('motionBlur', patch.motionBlur);
    set('volumetricLight', patch.volumetricLight);
    set('depthOfField', patch.depthOfField);
    set('lodFarDistance', patch.lodFarDistance);
    set('grassDensity', patch.grassDensity === undefined ? undefined : Math.max(0, patch.grassDensity));
    set('antialias', patch.antialias);

    if (resolutionMoved) {
      const drawn = this.basePixelRatio() * q.renderScale;
      this.renderer.setPixelRatio(drawn);
      // `setPixelRatio` already re-ran `setSize` internally, so the buffer is the new size by
      // the time the subsystems are asked to follow it.
      for (const s of this.systems) s.resize?.(this.viewW, this.viewH, this.ctx);
    }

    /*
     * Emit only on a real change, and the "only" is load-bearing rather than tidy.
     *
     * `EventBus.emit` defers a re-entrant emit and then drains the queue synchronously in its
     * own `finally`, where the drained call finds `dispatching === 0` and dispatches for real.
     * So a handler that responds to `qualityChanged` by writing quality does not recurse
     * *through* the emit — it recurses through the drain, one stack frame deeper each time, and
     * no re-entrancy flag on the handler's side can see it: the flag is already cleared by the
     * time the deferred call runs. `Maximum call stack size exceeded`, on the first tier switch.
     *
     * The fix belongs here rather than in the handler, because an event that announces a change
     * when nothing changed is the actual defect. With this guard the loop's response to a tier
     * switch reaches a fixed point in two rounds: the first re-derives its levers from the new
     * envelope and emits, the second finds them already correct and stops.
     */
    if (changed || resolutionMoved) this.events.emit('qualityChanged', { quality: this.quality });
    return resolutionMoved;
  }

  setQuality(tier: QualityTier): void {
    const before = this.quality;
    /*
     * The whole preset, with nothing carried over but the adaptive loop's own lever.
     *
     * This used to have to re-pin `maxSoldiers`, because a settings-menu press from ultra to low
     * took it from 12,000 to 1,600 while `BattleSystem` held 12,000 men in its arrays. There is
     * no such field any longer: the soldier pool is `SOLDIER_POOL_CAPACITY` and a tier press
     * cannot reach the battle at all. `renderScale` is carried because the adaptive loop's
     * verdict about this machine survives a tier change; only the envelope it works inside
     * moves, and it re-derives the exact scale from its own pressure when it sees
     * `qualityChanged`.
     */
    this.quality = { ...QUALITY_PRESETS[tier], renderScale: before.renderScale };
    this.renderer.setPixelRatio(this.basePixelRatio() * this.quality.renderScale);

    // Changing the cascade count changes `NUM_DIR_LIGHT_SHADOWS`, which is compiled into
    // every lit shader, so they all have to be recompiled against the new light count.
    //
    // This traversal was added to cure a grey world after a tier switch and did not,
    // because a stale program cache was never the cause. `LightingSystem.rebuild` disposed
    // the cascade rig without detaching its lights, so the old and the new set both stayed
    // in the scene and the recompile forced here ran against 7 shadow lights for a
    // 3-cascade define — measured, not inferred. Fixed at the source in `LightingSystem`.
    // Kept as belt and braces for any lit material the lighting system does not reach: a
    // recompile costs a visible hitch of a few hundred ms, but this is a deliberate press
    // of a settings button and a hitch beats a wrong frame.
    if (before.shadowCascades !== this.quality.shadowCascades) {
      const seen = new Set<THREE.Material>();
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) {
          if (seen.has(mat)) continue;
          seen.add(mat);
          mat.needsUpdate = true;
        }
      });
    }

    this.events.emit('qualityChanged', { quality: this.quality });
    for (const s of this.systems) s.resize?.(this.viewW, this.viewH, this.ctx);
  }

  dispose(): void {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.byName.clear();
    this.input.dispose();
    this.resizeObserver?.disconnect();
    this.events.clear();
    this.renderer.dispose();
  }

  /** Renderer statistics for the debug overlay. */
  stats(): { calls: number; tris: number; programs: number; textures: number; geometries: number } {
    const i = this.renderer.info;
    return {
      calls: i.render.calls,
      tris: i.render.triangles,
      programs: i.programs?.length ?? 0,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
    };
  }
}
