import * as THREE from 'three';
import { QUALITY_PRESETS, type EngineContext, type QualityTier, type Subsystem } from '../core/Engine';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { LightingSystem } from '../render/LightingSystem';
import { SkySystem } from '../render/SkySystem';
import { setActiveMap } from '../maps';

/**
 * The game's actual lighting rig, standing in the model viewer's room.
 *
 * ## What this closes
 * **`viewer.html` never loaded `LightingSystem`, and every model plate this project has ever
 * graded was lit by something the product does not ship.** `tcShadowGeom` and `tcSoftShadow`
 * appear as text in none of the viewer's 24 fragment programs. `Stage` hand-rolls a
 * directional key, a hemisphere and a warm bounce, and sets `PCFSoftShadowMap` — a *third*
 * shadow mode, used neither by `Engine` (which sets `PCFShadowMap`) nor by anything else, and
 * one three has since deprecated. So the deck graded soldiers under a fixed 3x3 PCF filter
 * from one non-cascaded sun while the battle graded them under a blocker-search soft shadow
 * across four cascades, and the difference is exactly the kind of thing that decides whether
 * a helmet reads.
 *
 * ## Why a shim and not an `Engine`
 * `src/city/preview.ts` boots a real `Engine` for the same reason, and it needs a
 * `TerrainSystem` to satisfy `rig.heightAt` and hands the render loop to the engine. The
 * viewer already owns its loop, its camera and its orbit controls, and giving those up to
 * borrow two subsystems is a much larger change than borrowing them directly.
 *
 * Read against the two systems' source rather than guessed: between them they touch
 * `ctx.scene`, `ctx.camera`, `ctx.renderer`, `ctx.quality`, `ctx.rig.orbitRadius` and
 * `ctx.tryGet('sky')` and nothing else, so those are the only fields with real values here.
 * The rest exist to satisfy the interface and will throw or no-op loudly rather than quietly
 * return something wrong.
 *
 * ## The four hazards, and what each cost
 * 1. **`TC_CLOUD_SHADOW` is defined unconditionally, but its uniforms are bound only when a
 *    sky exists** — with no sky, `directLight.color` is multiplied by an unbound sampler and
 *    `cloudShadowsEnabled` is private with no setter. Fixed by registering a *real*
 *    `SkySystem`, which is also what supplies `sunColour`, `skyFillColour` and the ground
 *    bounce that the whole ambient calibration is written against. A viewer with the lighting
 *    and no sky would have been worse than the studio probe, not better.
 * 2. **`installShaderChunks` mutates `THREE.ShaderChunk` process-wide and throws if the CSM
 *    call text does not match.** It runs once, in `LightingSystem.init`, exactly as in the
 *    game — but process-wide means it cannot be undone, so leaving this preset does not try
 *    to. See `detach`.
 * 3. **Every lit material must be patched or it renders four times too bright**, and
 *    `discoverMaterials` only re-traverses on a 16-frame timer. The viewer builds its tiers
 *    *lazily* — a faction's LOD1 mesh does not exist until someone asks for it — so a tier
 *    created while this preset is on is unpatched for up to sixteen frames and flares. That
 *    is a quarter of a second and it self-corrects; a screenshot harness must settle past it,
 *    which is why `eleview-shot.mjs` waits on the readout rather than on a frame count.
 * 4. **`Stage`'s own sun, fill and bounce must leave the scene**, or the man is double-lit and
 *    — worse — the CSM light indices shift. `LightingSystem.init` adds its bounce and fill
 *    *after* the cascade lights precisely so the shadow-casting lights keep the low indices,
 *    because the shader pairs `directionalLights[i]` with `directionalLightShadows[i]`. A
 *    stray `DirectionalLight` already in the scene takes index 0 and every cascade reads the
 *    wrong shadow map.
 */

/** The tier the whole deck is shot at, and the one the game boots on. */
const DECK_TIER: QualityTier = 'ultra';

/**
 * The map whose sky and solar site the rig is calibrated against.
 *
 * Not arbitrary and not a preference. `SkySystem.init` reads `activeMap()` for the latitude,
 * the solar declination, the day cycle and the default hour, and `LightingSystem`'s entire
 * fill calibration is written against a ground albedo of 0.13 — the Campus Martius' damp
 * November plain. Pydna's bleached straw is 0.20 and would light a model plate half again as
 * brightly for a reason that has nothing to do with the model.
 */
const DECK_MAP = 'campus-martius';

export class BattleRig {
  private readonly ctx: EngineContext;
  private readonly systems: Subsystem[] = [];
  private sky?: SkySystem;
  private lighting?: LightingSystem;
  private started = false;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    /**
     * Orbit distance in metres, read live.
     *
     * `LightingSystem` sizes the outermost cascade as `220 + orbitRadius * 1.5`. On the
     * battlefield that is hundreds of metres; around one man it is a few, and handing it a
     * stale or invented number would put the whole model inside cascade 0 or outside all
     * four. It is a callback rather than a value because the viewer orbits.
     */
    private readonly orbitRadius: () => number
  ) {
    const quality = { ...QUALITY_PRESETS[DECK_TIER] };
    const rig = { get orbitRadius(): number { return orbitRadius(); } };
    // Loudly, not quietly. If either system ever starts reading one of these, the viewer must
    // stop rather than grade a model under a rig that has silently lost a term.
    const absent = (what: string): never => {
      throw new Error(`[viewer/battleRig] the rig asked for ctx.${what}, which this shim does not have`);
    };
    const systems = this.systems;
    this.ctx = {
      scene,
      camera,
      renderer,
      quality,
      events: new EventBus<GameEvents>(),
      rig: rig as unknown as EngineContext['rig'],
      get time(): never { return absent('time'); },
      get input(): never { return absent('input'); },
      get viewW(): number { return renderer.domElement.clientWidth; },
      get viewH(): number { return renderer.domElement.clientHeight; },
      get: (name: string): never => absent(`get('${name}')`),
      tryGet: (name: string): Subsystem | undefined => systems.find((s) => s.name === name),
    } as unknown as EngineContext;
  }

  /**
   * Stand the rig up. Idempotent, and the first call is the expensive one — `SkySystem.init`
   * bakes a PMREM environment and `LightingSystem.init` patches every material in the scene.
   */
  attach(): void {
    if (this.started) return;
    this.started = true;
    setActiveMap(DECK_MAP);
    this.sky = new SkySystem();
    this.lighting = new LightingSystem();
    // Order matters and it is the engine's own: sky at -100, lighting at -80. The lighting
    // resolves the sky through `tryGet` during its own `init`, so the sky has to be both
    // registered and initialised first or the cloud-shadow uniforms never bind.
    this.systems.push(this.sky, this.lighting);
    this.sky.init(this.ctx);
    this.lighting.init(this.ctx);
  }

  /** Per-frame, in engine order. Called from the viewer's own loop. */
  update(dt: number): void {
    if (!this.started) return;
    this.sky?.update(dt, this.ctx);
    this.sky?.preRender(this.ctx);
    this.lighting?.preRender(this.ctx);
  }

  /** The sun, for the impostor capture and for aiming a plate's key. */
  get sunDirection(): THREE.Vector3 | undefined {
    return this.sky?.sunDirection;
  }

  get sunColour(): THREE.Color | undefined {
    return this.sky?.sunColour;
  }

  /** Hours, 0..24. The single most useful knob a lighting review has. */
  setTimeOfDay(h: number): void {
    this.sky?.setTimeOfDay(h);
  }

  get timeOfDay(): number {
    return this.sky?.timeOfDay ?? 12;
  }

  /**
   * Take the rig down, as far as it can be taken down.
   *
   * `installShaderChunks` is process-wide and permanent, and the `TC_*` defines it added to
   * every material stay on them — which is *correct*, because the chunks it installed still
   * behave as stock three when the cascade uniforms are absent. What must go is the CSM
   * lights and the fill, or switching back to the studio probe leaves a four-cascade sun in
   * the room. Said out loud because "dispose" here is not symmetrical with "attach", and a
   * reader who assumed it was would look for a bug that is not there.
   */
  detach(): void {
    if (!this.started) return;
    this.lighting?.dispose();
    /**
     * **`SkySystem.dispose` disposes the sky dome's geometry and never removes it from the
     * scene.** In the game that is harmless because dispose runs once at teardown; here the
     * preset is switchable, and the second time through the viewer was drawing a mesh whose
     * index buffer had already been deleted — visible as one extra draw call surviving a
     * return to the studio probe (28 -> 35 -> 29). Taken out by name here rather than fixed
     * in `src/render/`, and reported.
     */
    const dome = this.ctx.scene.getObjectByName('sky');
    if (dome) this.ctx.scene.remove(dome);
    this.sky?.dispose?.();
    this.systems.length = 0;
    this.lighting = undefined;
    this.sky = undefined;
    this.started = false;
  }

  get attached(): boolean {
    return this.started;
  }
}
