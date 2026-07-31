import * as THREE from 'three';
import { EventBus } from './EventBus';
import { Input } from './Input';
import { RTSCamera } from './RTSCamera';
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

export interface QualitySettings {
  tier: QualityTier;
  /** Device pixel ratio cap. */
  maxPixelRatio: number;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  ssao: boolean;
  bloom: boolean;
  motionBlur: boolean;
  volumetricLight: boolean;
  depthOfField: boolean;
  /** Max simultaneously simulated soldiers. */
  maxSoldiers: number;
  /** World-space distance at which soldiers drop to the cheapest LOD. */
  lodFarDistance: number;
  grassDensity: number;
  /** Screen-space AA mode. */
  antialias: 'none' | 'fxaa' | 'smaa' | 'taa';
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low', maxPixelRatio: 1, shadowMapSize: 1024, shadowCascades: 2,
    ssao: false, bloom: true, motionBlur: false, volumetricLight: false,
    depthOfField: false, maxSoldiers: 1600, lodFarDistance: 90,
    grassDensity: 0.15, antialias: 'fxaa',
  },
  medium: {
    tier: 'medium', maxPixelRatio: 1.25, shadowMapSize: 2048, shadowCascades: 3,
    ssao: true, bloom: true, motionBlur: false, volumetricLight: false,
    depthOfField: false, maxSoldiers: 3200, lodFarDistance: 140,
    grassDensity: 0.45, antialias: 'smaa',
  },
  high: {
    tier: 'high', maxPixelRatio: 1.5, shadowMapSize: 2048, shadowCascades: 4,
    ssao: true, bloom: true, motionBlur: true, volumetricLight: true,
    depthOfField: true, maxSoldiers: 10000, lodFarDistance: 220,
    grassDensity: 1, antialias: 'smaa',
  },
  ultra: {
    tier: 'ultra', maxPixelRatio: 2, shadowMapSize: 4096, shadowCascades: 4,
    ssao: true, bloom: true, motionBlur: true, volumetricLight: true,
    depthOfField: true, maxSoldiers: 12000, lodFarDistance: 320,
    // SMAA rather than TAA. Soldiers are GPU-skinned instances animated entirely in
    // the vertex shader, so there are no per-object motion vectors to reproject with;
    // TAA's history clamp cannot distinguish a moving man from a disoccluded background
    // and smears a dense melee into mush. TAA can come back once the unit renderer
    // emits a velocity buffer.
    grassDensity: 1.5, antialias: 'smaa',
  },
};

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityTier;
  /** Render at a fixed size instead of tracking the window — used by the screenshot harness. */
  fixedSize?: { w: number; h: number };
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
   * Installed by the post-processing subsystem. When present the engine calls this
   * instead of `renderer.render`, so the composer owns the final image.
   */
  renderOverride: ((ctx: EngineContext) => void) | null = null;

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.fixedSize = opts.fixedSize;
    this.quality = { ...QUALITY_PRESETS[opts.quality ?? 'high'] };

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // handled in the post chain
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // screenshot harness reads pixels back
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
    const steps = this.time.beginFrame(nowMs);
    this.input.beginFrame(this.time.frameDt, this.viewW, this.viewH);

    const fdt = this.time.fixedDt;
    for (let n = 0; n < steps; n++) {
      for (const s of this.systems) s.fixedUpdate?.(fdt, this.ctx);
    }

    const sdt = this.time.scaledDt;
    for (const s of this.systems) s.update?.(sdt, this.ctx);

    // Camera last among updates so it can follow anything the sim moved this frame.
    this.rig.update(this.time.frameDt, this.input, this.viewW, this.viewH);
    this.rig.camera.updateMatrixWorld();

    for (const s of this.systems) s.preRender?.(this.ctx);

    this.renderer.info.reset();
    if (this.renderOverride) this.renderOverride(this.ctx);
    else this.renderer.render(this.scene, this.rig.camera);

    this.input.endFrame();
  }

  /**
   * Advance the simulation by a wall-clock duration without waiting for real time.
   * The screenshot harness uses this to reach a specific battle state fast.
   */
  advance(seconds: number, stepMs = 1000 / 60): void {
    const n = Math.max(1, Math.round((seconds * 1000) / stepMs));
    let t = this.time.elapsed * 1000;
    for (let i = 0; i < n; i++) {
      t += stepMs;
      this.frame(t);
    }
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

    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, !this.fixedSize);
    if (this.fixedSize) {
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.rig.resize(w, h);
    for (const s of this.systems) s.resize?.(w, h, this.ctx);
    this.events.emit('resize', { w, h });
  }

  setQuality(tier: QualityTier): void {
    const before = this.quality;
    this.quality = { ...QUALITY_PRESETS[tier] };
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);

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
