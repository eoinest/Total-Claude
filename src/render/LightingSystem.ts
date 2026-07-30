import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { EngineContext, Subsystem } from '../core/Engine';
import { CLOUD_FIELD_GLSL, CLOUD_SHADOW_GLSL } from '../shaders/clouds.glsl';
import { clamp } from '../util/math';
import type { SkySystem } from './SkySystem';

/**
 * Sun, cascaded shadows, sky fill and cloud shading.
 *
 * ## Cascades
 * `three/addons/csm/CSM.js` ships with three 0.185, so this extends the addon
 * rather than reimplementing it. What is added on top:
 *
 *  - **Custom split distribution.** The addon's `practical` mode derives its
 *    logarithmic term from `camera.near`, and `RTSCamera` swings near from 0.08 m
 *    to 4 m with zoom, which makes the split distances jump as the player zooms.
 *    `SPLIT_LAMBDA` blends uniform and logarithmic splits against a *fixed*
 *    nominal near instead, so the cascade boundaries are stable.
 *  - **Per-cascade bias.** The addon applies one `shadowBias` to every cascade.
 *    Depth bias has to scale with the cascade's texel footprint or the near
 *    cascade peter-pans while the far one still acnes. Both biases are recomputed
 *    from the fitted ortho extents every frame.
 *  - **Cloud shading.** `lights_fragment_begin` is re-patched so the directional
 *    term is multiplied by a cloud-transmittance lookup, which means a cloud
 *    dims only direct sun — never the ambient — exactly like the real thing.
 *  - **Material discovery.** The addon requires the application to call
 *    `setupMaterial` on every affected material. Since other subsystems create
 *    materials at their own init time (and use `onBeforeCompile` themselves for
 *    VAT skinning and terrain splatting), materials are discovered by scene
 *    traversal and their existing `onBeforeCompile` is *chained*, not replaced.
 *
 * Contract: `sun` is the primary `DirectionalLight` (cascade 0's light).
 */

/** Shadowed distance. Beyond this a man's shadow is under a pixel wide and the
 *  resolution is better spent close in. */
const SHADOW_DISTANCE = 620;
/** Nominal near plane for the split distribution — roughly a soldier's boot. */
const SPLIT_NEAR = 1.5;
/** 0 = uniform splits, 1 = logarithmic. 0.82 puts cascade 0 at ~32 m, which is
 *  where the camera sits for the close shots, so contact shadows get the texels. */
const SPLIT_LAMBDA = 0.82;
/** Blur radius in shadow texels. Constant in texels (not metres) so the
 *  penumbra automatically widens with distance as the cascades coarsen — that is
 *  the read that makes feet look planted and distant ranks look atmospheric. */
const PCF_RADIUS_NEAR = 2.4;
const PCF_RADIUS_FAR = 3.4;

export class LightingSystem implements Subsystem {
  readonly name = 'lighting';
  readonly order = -80;

  /** Sky fill. Ground colour carries the warm bounce off the dry plain. */
  readonly fill = new THREE.HemisphereLight(0x9dbcdc, 0x6b5a3e, 0.42);
  /** A weak, unshadowed sun-opposed light: the classic single-bounce cheat that
   *  keeps shadowed sides from collapsing into one flat ambient value. */
  readonly bounce = new THREE.DirectionalLight(0xffd9a8, 0.24);

  private csm?: CSM;
  private sky?: SkySystem;
  private cascades = 4;

  /** Shared by reference with every patched material, so one write updates all. */
  private readonly breaks: THREE.Vector2[] = [];
  private readonly csmDepth = new THREE.Vector2(SPLIT_NEAR, SHADOW_DISTANCE);
  private patched = new WeakSet<THREE.Material>();
  private readonly invView = new THREE.Matrix4();
  private cloudShadowsEnabled = true;
  private traverseTimer = 0;

  get sun(): THREE.DirectionalLight {
    return this.csm ? this.csm.lights[0] : this.bounce;
  }

  init(ctx: EngineContext): void {
    this.sky = ctx.tryGet<SkySystem>('sky');
    const q = ctx.quality;

    // three 0.185's PCF path is a 5-tap Vogel disc on a hardware-compared
    // sampler2DShadow — effectively 20 filtered taps, and it honours
    // `shadow.radius`. PCFSoftShadowMap is a fixed 3x3 that ignores the radius,
    // so it cannot give a distance-varying penumbra.
    ctx.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.cascades = clamp(Math.round(q.shadowCascades), 1, 4);
    // 4 cascades at 4096 would be 268 MB of shadow memory for no visible gain
    // once the splits are this tight; 2048 gives ~2.4 cm/texel in cascade 0.
    const mapSize = Math.min(q.shadowMapSize, 2048);

    this.csm = new CSM({
      camera: ctx.camera,
      parent: ctx.scene,
      cascades: this.cascades,
      maxFar: SHADOW_DISTANCE,
      mode: 'custom',
      shadowMapSize: mapSize,
      lightIntensity: 3,
      lightDirection: new THREE.Vector3(-0.61, -0.66, -0.44).normalize(),
      lightNear: 1,
      // Ortho depth is linear, so a generous range costs nothing in precision
      // and guarantees a 60 m wall never falls outside the shadow frustum.
      lightFar: 2200,
      lightMargin: 260,
      customSplitsCallback: (cascades, _near, far, target) => {
        this.computeSplits(cascades, far, target);
      },
    });
    this.csm.fade = true;
    this.csm.updateFrustums();

    for (const l of this.csm.lights) {
      l.shadow.radius = PCF_RADIUS_NEAR;
      l.shadow.intensity = 1;
    }

    // Added after CSM so the shadow-casting lights keep the low indices — the
    // shader pairs `directionalLights[i]` with `directionalLightShadows[i]`.
    this.bounce.castShadow = false;
    ctx.scene.add(this.bounce);
    ctx.scene.add(this.fill);

    this.installShaderChunks();
    this.syncBreakUniforms();
    this.discoverMaterials(ctx.scene);
  }

  // ---------------------------------------------------------------------------
  // Splits
  // ---------------------------------------------------------------------------

  /**
   * Practical split scheme (Zhang et al. 2006): a blend of a uniform and a
   * logarithmic distribution. Break values are the lerp factor CSMFrustum uses
   * between the near and far frustum planes, which is also what the shader
   * compares `viewZ / (shadowFar - cameraNear)` against.
   */
  private computeSplits(cascades: number, far: number, target: number[]): void {
    target.length = 0;
    const near = SPLIT_NEAR;
    for (let i = 1; i < cascades; i++) {
      const uni = near + ((far - near) * i) / cascades;
      const log = near * Math.pow(far / near, i / cascades);
      const d = uni + (log - uni) * SPLIT_LAMBDA;
      target.push((d - near) / (far - near));
    }
    target.push(1);
  }

  /** Keep the shared break array in step with CSM's own. */
  private syncBreakUniforms(): void {
    const csm = this.csm;
    if (!csm) return;
    while (this.breaks.length < csm.cascades) this.breaks.push(new THREE.Vector2());
    this.breaks.length = csm.cascades;
    for (let i = 0; i < csm.cascades; i++) {
      this.breaks[i].set(i === 0 ? 0 : csm.breaks[i - 1], csm.breaks[i]);
    }
  }

  // ---------------------------------------------------------------------------
  // Shader plumbing
  // ---------------------------------------------------------------------------

  /**
   * CSM's constructor overwrites `lights_fragment_begin` / `lights_pars_begin`
   * globally, so the freshly injected CSM versions are read straight back out of
   * `ShaderChunk` here and re-patched to add the cloud term. Reading them from
   * `ShaderChunk` rather than importing `CSMShader` keeps this idempotent across
   * rebuilds — the CSM constructor always restores the pristine text first.
   */
  private installShaderChunks(): void {
    const cloudTap = 'directLight.color *= tcCloudShadow( geometryPosition );';
    let frag = THREE.ShaderChunk.lights_fragment_begin;
    frag = frag.split('getDirectionalLightInfo( directionalLight, directLight );').join(
      `getDirectionalLightInfo( directionalLight, directLight );\n\t\t\t${cloudTap}`,
    );
    frag = frag.replace(
      'getDirectionalLightInfo( directionalLights[0], directLight );',
      `getDirectionalLightInfo( directionalLights[0], directLight );\n\t\t${cloudTap}`,
    );
    // `cameraNear`/`shadowFar` collapse into one shared vec2 so a single write
    // reaches every material. A plain float uniform is copied per material by
    // `UniformsUtils`, so it would go stale the moment the camera zoomed.
    frag = frag.replace(
      'float linearDepth = (vViewPosition.z) / (shadowFar - cameraNear);',
      'float linearDepth = vViewPosition.z / ( tcCsmDepth.y - tcCsmDepth.x );',
    );
    THREE.ShaderChunk.lights_fragment_begin = frag;

    const pars = THREE.ShaderChunk.lights_pars_begin.replace(
      'uniform float cameraNear;\nuniform float shadowFar;',
      'uniform vec2 tcCsmDepth;',
    );
    THREE.ShaderChunk.lights_pars_begin = pars + CLOUD_FIELD_GLSL + CLOUD_SHADOW_GLSL;
  }

  /**
   * Give a material CSM + cloud shading without destroying whatever it already
   * does in `onBeforeCompile`.
   */
  private setupMaterial(mat: THREE.Material): void {
    if (this.patched.has(mat)) return;
    this.patched.add(mat);

    mat.defines = mat.defines ?? {};
    mat.defines.USE_CSM = 1;
    mat.defines.CSM_CASCADES = this.cascades;
    mat.defines.CSM_FADE = '';
    if (this.cloudShadowsEnabled) mat.defines.TC_CLOUD_SHADOW = '';

    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      // Assigned by reference: `onBeforeCompile` writes straight into the
      // material's live uniform object, so no cloning happens and updating the
      // shared objects below updates every material at once.
      shader.uniforms.CSM_cascades = { value: this.breaks };
      shader.uniforms.tcCsmDepth = { value: this.csmDepth };
      const sky = this.sky;
      if (this.cloudShadowsEnabled && sky) {
        shader.uniforms.tcCloudNoise = { value: sky.cloudNoiseTexture };
        shader.uniforms.tcInvView = { value: this.invView };
        shader.uniforms.tcCloudA = { value: sky.cloudUniformA };
        shader.uniforms.tcCloudB = { value: sky.cloudUniformB };
        shader.uniforms.tcCloudSunDir = { value: sky.cloudSunDir };
      }
    };
    mat.needsUpdate = true;
  }

  /**
   * Every lit material in the scene must opt into CSM: the CSM shader's
   * non-CSM branch sums *all* directional lights, and there are `cascades` of
   * them, so an unpatched material renders four times too bright.
   */
  private discoverMaterials(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const sub of m) if (this.affectedByLights(sub)) this.setupMaterial(sub);
      } else if (this.affectedByLights(m)) {
        this.setupMaterial(m);
      }
    });
  }

  /** Only materials that run the lighting template need patching. */
  private affectedByLights(m: THREE.Material): boolean {
    switch (m.type) {
      case 'MeshStandardMaterial':
      case 'MeshPhysicalMaterial':
      case 'MeshPhongMaterial':
      case 'MeshLambertMaterial':
      case 'MeshToonMaterial':
        return true;
      default:
        break;
    }
    // A hand-written ShaderMaterial that pulls in the lighting template still
    // needs the cascade uniforms, and there is no flag for that any more.
    const fs = (m as THREE.ShaderMaterial).fragmentShader;
    return typeof fs === 'string' && fs.includes('lights_fragment_begin');
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  preRender(ctx: EngineContext): void {
    const csm = this.csm;
    if (!csm) return;
    const sky = this.sky;

    // Newly spawned meshes (vfx decals, siege engines, banners) show up here.
    // Sixteen frames apart is invisible to the eye and keeps the traversal off
    // the per-frame budget.
    this.traverseTimer++;
    if ((this.traverseTimer & 15) === 0) this.discoverMaterials(ctx.scene);

    if (sky) {
      csm.lightDirection.copy(sky.sunDirection).negate().normalize();
      // Below the horizon there is no sun at all; leaving the cascades running
      // would carve black shadows out of a night scene.
      const lit = sky.sunIntensity > 0.001;
      for (const l of csm.lights) {
        l.color.copy(sky.sunColour);
        l.intensity = sky.sunIntensity;
        l.castShadow = lit;
      }
      this.fill.color.copy(sky.skyFillColour);
      // Ground bounce: the plain's albedo lit by the sun, plus the sky it sees.
      const a = sky.preset.groundAlbedo * 2.2;
      this.fill.groundColor.setRGB(
        sky.sunColour.r * sky.sunIntensity * a * 0.35 + sky.skyFillColour.r * 0.4,
        sky.sunColour.g * sky.sunIntensity * a * 0.32 + sky.skyFillColour.g * 0.4,
        sky.sunColour.b * sky.sunIntensity * a * 0.26 + sky.skyFillColour.b * 0.4,
      );
      // Deliberately small. `scene.environment` already delivers the sky's
      // irradiance at the physically correct level, so this is only a top-up for
      // materials that ignore IBL — and every unit of extra ambient is a unit of
      // directional contrast lost.
      this.fill.intensity = 0.3;

      // Bounce comes from the ground on the far side of the sun, i.e. the sun
      // direction mirrored through the horizon plane.
      this.bounce.position.set(-sky.sunDirection.x, -0.45, -sky.sunDirection.z).multiplyScalar(300);
      this.bounce.color.copy(sky.sunColour);
      this.bounce.intensity = sky.sunIntensity * 0.075;
    }

    // The camera's projection changes every frame (RTSCamera couples fov, near
    // and far to zoom), so the frustum split has to be refitted every frame.
    csm.updateFrustums();
    csm.update();
    this.syncBreakUniforms();
    this.csmDepth.set(SPLIT_NEAR, SHADOW_DISTANCE);

    // Per-cascade bias from the *actual* fitted extents.
    const n = csm.lights.length;
    for (let i = 0; i < n; i++) {
      const l = csm.lights[i];
      const cam = l.shadow.camera;
      const texel = (cam.right - cam.left) / csm.shadowMapSize;
      // Depth slop of ~0.6 texel, expressed in the [0,1] range the shadow
      // comparison works in. Enough to kill self-shadow acne on a 45 deg slope
      // without lifting the contact shadow off the feet.
      l.shadow.bias = -(texel * 0.6) / (cam.far - cam.near);
      // Normal offset does the heavy lifting: pushing the sample 1.6 texels
      // along the surface normal removes acne independently of slope.
      l.shadow.normalBias = texel * 1.6;
      const t = n > 1 ? i / (n - 1) : 0;
      l.shadow.radius = PCF_RADIUS_NEAR + (PCF_RADIUS_FAR - PCF_RADIUS_NEAR) * t;
    }

    // Shared with every patched material for the cloud-shadow world lookup.
    this.invView.copy(ctx.camera.matrixWorld);
  }

  resize(_w: number, _h: number, ctx: EngineContext): void {
    const want = clamp(Math.round(ctx.quality.shadowCascades), 1, 4);
    if (want === this.cascades) return;
    // Cascade count is baked into every patched material's defines, so a change
    // means a full rebuild. Only happens on an explicit quality switch.
    this.rebuild(ctx);
  }

  private rebuild(ctx: EngineContext): void {
    this.csm?.dispose();
    this.csm = undefined;
    ctx.scene.remove(this.bounce);
    ctx.scene.remove(this.fill);
    // The cascade count lives in every material's defines, so they all have to
    // be re-patched with the new value.
    this.patched = new WeakSet<THREE.Material>();
    this.init(ctx);
  }

  dispose(): void {
    this.csm?.dispose();
    this.fill.dispose();
    this.bounce.dispose();
  }
}
