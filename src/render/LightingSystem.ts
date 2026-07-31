import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { EngineContext, Subsystem } from '../core/Engine';
import { CLOUD_FIELD_GLSL, CLOUD_SHADOW_GLSL } from '../shaders/clouds.glsl';
import { clamp } from '../util/math';
import { CSM_GET_SHADOW_CALL, CSM_SOFT_SHADOW_CALL, SOFT_SHADOW_GLSL } from './softShadow.glsl';
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

/**
 * Shadowed distance, at the close end of the zoom range. Beyond this a man's
 * shadow is under a pixel wide and the resolution is better spent close in;
 * 460 m puts the fourth cascade's texel at ~0.22 m, which is still narrower than
 * a man.
 *
 * It cannot be a constant, though. `RTSCamera` lifts the eye past 1 km at
 * strategic zoom, where a fixed 460 m put *every* pixel in the frame outside the
 * cascades and the whole battlefield went shadowless — the one view where a
 * raking sun should be at its most legible, because from above a long shadow is
 * the only thing that gives the ground relief. So the far end is driven off the
 * orbit radius instead: `SHADOW_FAR_MIN` close in, `SHADOW_FAR_MAX` at full
 * zoom-out, where men's shadows are sub-pixel anyway and the readable shadows are
 * the ones cast by hills, walls and buildings.
 */
const SHADOW_FAR_MIN = 460;
const SHADOW_FAR_MAX = 2100;
/** Nominal near plane for the split distribution — roughly a soldier's boot. */
const SPLIT_NEAR = 1.5;
/** 0 = uniform splits, 1 = logarithmic. 0.82 puts cascade 0 at ~24 m, which is
 *  where the camera sits for the close shots, so contact shadows get the texels. */
const SPLIT_LAMBDA = 0.82;
/**
 * Fallback blur radius, in shadow texels, for the non-CSM `getShadow` path.
 *
 * The cascaded path no longer uses it: `tcSoftShadow` in `softShadow.glsl.ts` derives its
 * own radius per pixel from the blocker's distance, because a radius in *texels* means a
 * blur in *metres* that scales with the cascade's footprint. Measured at the `wide` camera
 * the old ramp put 2.01 m of blur on cascade 3 against a man 0.45 m across, which is why a
 * battle line photographed from any useful distance cast nothing at all. See that file.
 */
const PCF_RADIUS_FALLBACK = 2.0;
/**
 * Ceiling on the normal-offset bias, in metres.
 *
 * Normal offset has to scale with the cascade's texel footprint to kill acne, but
 * the outer cascade's texel is a quarter of a metre and 1.6 of them is 0.4 m —
 * comfortably wider than a man. Every shadow past ~140 m was being pushed off
 * its caster and vanishing, which is most of the crowd in any shot wide enough
 * to see a battle line. 0.09 m is under a boot length, so it still cannot lift a
 * contact shadow visibly, and the depth bias plus PCF absorbs the acne the
 * shortfall would otherwise let through.
 */
const MAX_NORMAL_BIAS = 0.09;

export class LightingSystem implements Subsystem {
  readonly name = 'lighting';
  readonly order = -80;

  /** Sky fill. Ground colour carries the warm bounce off the dry plain. */
  readonly fill = new THREE.HemisphereLight(0x9dbcdc, 0x6b5a3e, 0.42);
  /** A weak, unshadowed sun-opposed light: the classic single-bounce cheat that
   *  keeps shadowed sides from collapsing into one flat ambient value. */
  readonly bounce = new THREE.DirectionalLight(0xffd9a8, 0.24);
  /**
   * Extra saturation applied to the sky fill's chromaticity, at constant
   * luminance.
   *
   * The Rayleigh integral's cosine-weighted hemisphere mean is genuinely a
   * desaturated pale blue — it averages the deep zenith with the near-white
   * horizon — and used raw it puts almost no blue into a shadow. Rome II's
   * shadows are unmistakably blue-grey, so the fill's chroma is stretched about
   * its own luminance. Luminance-preserving, so it costs no contrast: it moves
   * colour only.
   *
   * Raised from 1.20 on a measurement, not a preference. Twelve real Rome II frames
   * average a shadow chromaticity of 1.06/0.90/1.02, i.e. blue at 0.96 of red. Sampled
   * over the deepest 5 % of the pixels a soldier's own cast shadow darkens, ours measured
   * blue at 0.79 of red at the midcrowd camera — cool, but not as cool as the target, and
   * the fill is the only term that reaches those surfaces.
   */
  private static readonly FILL_CHROMA_GAIN = 1.35;

  private csm?: CSM;
  private sky?: SkySystem;
  private cascades = 4;

  /** Shared by reference with every patched material, so one write updates all. */
  private readonly breaks: THREE.Vector2[] = [];
  /** Per cascade: (metres per shadow texel, metres per unit shadowCoord.z). Feeds
   *  `tcSoftShadow`, which needs both to turn a blocker distance into a filter radius. */
  private readonly shadowGeom: THREE.Vector2[] = [];
  private readonly csmDepth = new THREE.Vector2(SPLIT_NEAR, SHADOW_FAR_MIN);
  private shadowFar = SHADOW_FAR_MIN;
  private patched = new WeakSet<THREE.Material>();
  /** Same membership as `patched`, kept iterable so a define can be re-flipped on all of
   *  them at once. Cleared wholesale by `rebuild`, so it cannot outlive its materials. */
  private patchedList: THREE.Material[] = [];
  private softOn = true;
  private readonly invView = new THREE.Matrix4();
  private cloudShadowsEnabled = true;
  private traverseTimer = 0;

  get sun(): THREE.DirectionalLight {
    return this.csm ? this.csm.lights[0] : this.bounce;
  }

  /**
   * Throw-dependent penumbra on or off. Off compiles the fixed-texel PCF this replaced,
   * which is what the lower quality tiers want and what an A/B measures against.
   */
  get softShadows(): boolean {
    return this.softOn;
  }

  set softShadows(on: boolean) {
    if (on === this.softOn) return;
    this.softOn = on;
    for (const m of this.patchedList) {
      if (on) delete m.defines?.TC_SOFT_OFF;
      else if (m.defines) m.defines.TC_SOFT_OFF = '';
      m.needsUpdate = true;
    }
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
    // The blocker search buys a penumbra that widens with throw distance. That is worth
    // paying for where there are texels to resolve it — measured at 0.46 ms of an 8.22 ms
    // frame at the `clash` camera on ultra — and not worth it on the tiers that ship 2
    // cascades into a 1024 map, where the near cascade's texel is already wider than the
    // penumbra being searched for.
    this.softOn = q.tier === 'high' || q.tier === 'ultra';
    // 4 cascades at 4096 would be 268 MB of shadow memory for no visible gain
    // once the splits are this tight; 2048 gives ~2.4 cm/texel in cascade 0.
    const mapSize = Math.min(q.shadowMapSize, 2048);

    this.csm = new CSM({
      camera: ctx.camera,
      parent: ctx.scene,
      cascades: this.cascades,
      maxFar: SHADOW_FAR_MIN,
      mode: 'custom',
      shadowMapSize: mapSize,
      lightIntensity: 3,
      lightDirection: new THREE.Vector3(0.55, -0.43, -0.71).normalize(),
      lightNear: 1,
      // Ortho depth is linear, so a generous range costs nothing in precision and
      // guarantees neither a 60 m wall nor a 2 km outer cascade under a 26 deg sun
      // falls outside the shadow frustum.
      lightFar: 6000,
      lightMargin: 400,
      customSplitsCallback: (cascades, _near, far, target) => {
        this.computeSplits(cascades, far, target);
      },
    });
    this.csm.fade = true;
    this.csm.updateFrustums();

    for (const l of this.csm.lights) {
      l.shadow.radius = PCF_RADIUS_FALLBACK;
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

  /** Stretch a colour's chroma about its own luminance by `FILL_CHROMA_GAIN`. */
  private saturate(src: THREE.Color, out: THREE.Color): void {
    const l = src.r * 0.2126 + src.g * 0.7152 + src.b * 0.0722;
    const k = LightingSystem.FILL_CHROMA_GAIN;
    out.setRGB(
      Math.max(0, l + (src.r - l) * k),
      Math.max(0, l + (src.g - l) * k),
      Math.max(0, l + (src.b - l) * k),
    );
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
    // `shadowmap_pars_fragment` is not one of the chunks CSM rewrites, so unlike the two
    // below it is not restored to pristine text on a rebuild — appending unconditionally
    // would stack a second copy of the function on every quality switch.
    if (!THREE.ShaderChunk.shadowmap_pars_fragment.includes('tcSoftShadow')) {
      THREE.ShaderChunk.shadowmap_pars_fragment += SOFT_SHADOW_GLSL;
    }

    const cloudTap = 'directLight.color *= tcCloudShadow( geometryPosition );';
    let frag = THREE.ShaderChunk.lights_fragment_begin;
    // Swap CSM's directional shadow lookup for the throw-dependent one. The call text is
    // identical in the CSM_FADE and non-fade branches, so one split/join reaches both.
    //
    // It must NOT reach the third copy. CSMShader's chunk ends with a
    // `!defined( USE_CSM )` fallback loop for materials that never opted in, and
    // `tcSoftShadow` is declared only under `USE_CSM` — replacing it there took out every
    // such material with `'tcSoftShadow' : no matching overloaded function found`. So the
    // rewrite is confined to the text before that guard.
    const FALLBACK_GUARD = '!defined( USE_CSM ) && !defined( CSM_CASCADES )';
    const cut = frag.indexOf(FALLBACK_GUARD);
    const head = cut < 0 ? frag : frag.slice(0, cut);
    const softened = head.split(CSM_GET_SHADOW_CALL).join(CSM_SOFT_SHADOW_CALL);
    if (softened === head) {
      throw new Error('[lighting] CSM getShadow call not found — softShadow.glsl.ts is stale');
    }
    frag = softened + (cut < 0 ? '' : frag.slice(cut));
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
    this.patchedList.push(mat);

    mat.defines = mat.defines ?? {};
    mat.defines.USE_CSM = 1;
    mat.defines.CSM_CASCADES = this.cascades;
    mat.defines.CSM_FADE = '';
    if (!this.softOn) mat.defines.TC_SOFT_OFF = '';
    if (this.cloudShadowsEnabled) mat.defines.TC_CLOUD_SHADOW = '';

    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      // Assigned by reference: `onBeforeCompile` writes straight into the
      // material's live uniform object, so no cloning happens and updating the
      // shared objects below updates every material at once.
      shader.uniforms.CSM_cascades = { value: this.breaks };
      shader.uniforms.tcCsmDepth = { value: this.csmDepth };
      shader.uniforms.tcShadowGeom = { value: this.shadowGeom };
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
      this.saturate(sky.skyFillColour, this.fill.color);

      // How much light this map's ground throws back up, relative to the Campus Martius'
      // damp November plain.
      //
      // This is the one term that must not be a constant across maps. Every fill level in
      // this file was calibrated against a ground of albedo 0.13; the plain of Pydna is
      // bleached straw and pale karst at 0.20, so a real scene there has roughly half again
      // as much bounce lifting everything the sun cannot reach. Holding the fill constant and
      // dropping exposure to suit the brighter ground is what crushed the shadowed half of a
      // melee to pure black — measured at 70 % of the clash frame below 0.15 display and a
      // 5th percentile of exactly 0.000, which is a hard clip and a rubric failure outright.
      //
      // Scaling it here rather than raising exposure is the difference between lifting the
      // shadows and lifting the whole image: exposure would re-blow the ground that the
      // palette was just calibrated to.
      const bounceGain = clamp(sky.preset.groundAlbedo / 0.13, 0.7, 1.9);
      // Ground bounce: the plain's albedo lit by the sun, plus the sky it sees.
      // Held down hard on purpose — this term is the enemy of A1. It is the only
      // warm light reaching a shadowed surface, and at its old weight it
      // neutralised the sky bounce completely, which is how 2 500 men in shadow
      // ended up exactly the same hue as the same men in sun.
      const a = sky.preset.groundAlbedo * 0.9;
      this.fill.groundColor.setRGB(
        sky.sunColour.r * sky.sunIntensity * a * 0.26 + this.fill.color.r * 0.5,
        sky.sunColour.g * sky.sunIntensity * a * 0.24 + this.fill.color.g * 0.5,
        sky.sunColour.b * sky.sunIntensity * a * 0.19 + this.fill.color.b * 0.5,
      );
      // Raised from 0.22, and the warm ground term above cut by a quarter to pay for it, so
      // the *added* light is the cool sky half rather than the warm bounce half.
      //
      // The reason is a blind critic's verbatim first finding on this build: "the entire
      // unit renders as near-black silhouettes while the grass 40 cm away is fully lit —
      // there is no ambient/indirect term at all, so shadow sides crush to zero". Measured,
      // the frame as a whole is not the problem: 15.9 % of our pixels sit below 15 %
      // display against 20.9 % across the ten Rome II plates, so we are if anything less
      // crushed overall. What is wrong is the *ratio between a man and the ground he stands
      // on*, and a man in a rank is a wall of anti-sun normals that only this term reaches.
      //
      // Spending it on the sky half rather than raising exposure or the bounce is what
      // keeps A1: it lifts the shadow while making it bluer, which is the direction the
      // measurement above says our shadows need to move anyway.
      this.fill.intensity = 0.34 * bounceGain;

      // Bounce comes from the ground on the far side of the sun, i.e. the sun
      // direction mirrored through the horizon plane — so it lands on exactly the
      // surfaces the sun cannot reach.
      //
      // Nearly horizontal (-0.2, not the -0.45 that reads as a physical mirror)
      // because the surfaces that need it are *vertical*: a cohort seen from the
      // shaded side is a wall of anti-sun normals, and with a 26 deg sun and the
      // ambient trimmed it was landing near 0.12 display and reading as a navy
      // silhouette. A low, warm, unshadowed fill lifts precisely that and barely
      // touches level ground, where cos falls away — which is what lets the
      // ground's own lit:shadow ratio stay at 8:1 while the men come back.
      this.bounce.position.set(-sky.sunDirection.x, -0.2, -sky.sunDirection.z).multiplyScalar(300);
      this.bounce.color.copy(sky.sunColour);
      this.bounce.intensity = sky.sunIntensity * 0.11 * bounceGain;
    }

    // The camera's projection changes every frame (RTSCamera couples fov, near
    // and far to zoom), so the frustum split has to be refitted every frame.
    // Refit the cascade range to the camera's height before the frustum split, so
    // a zoomed-out view still gets shadows and a zoomed-in one still gets texels.
    const want = clamp(220 + ctx.rig.orbitRadius * 1.5, SHADOW_FAR_MIN, SHADOW_FAR_MAX);
    if (Math.abs(want - this.shadowFar) > 4) {
      this.shadowFar = want;
      csm.maxFar = want;
    }

    csm.updateFrustums();
    csm.update();
    this.syncBreakUniforms();
    this.csmDepth.set(SPLIT_NEAR, this.shadowFar);

    // Per-cascade bias and filter geometry from the *actual* fitted extents.
    const n = csm.lights.length;
    while (this.shadowGeom.length < n) this.shadowGeom.push(new THREE.Vector2());
    this.shadowGeom.length = n;
    for (let i = 0; i < n; i++) {
      const l = csm.lights[i];
      const cam = l.shadow.camera;
      const texel = (cam.right - cam.left) / csm.shadowMapSize;
      // Depth slop of ~0.6 texel, expressed in the [0,1] range the shadow
      // comparison works in. Enough to kill self-shadow acne on a 45 deg slope
      // without lifting the contact shadow off the feet.
      l.shadow.bias = -(texel * 0.6) / (cam.far - cam.near);
      // Normal offset does the heavy lifting: pushing the sample 1.6 texels
      // along the surface normal removes acne independently of slope — but see
      // MAX_NORMAL_BIAS for why it cannot be allowed to scale freely.
      l.shadow.normalBias = Math.min(texel * 1.6, MAX_NORMAL_BIAS);
      // The light camera is orthographic, so its depth is linear and one unit of
      // `shadowCoord.z` is exactly the whole near..far range in metres. That is what lets
      // `tcSoftShadow` turn a depth difference straight into a throw distance.
      this.shadowGeom[i].set(texel, cam.far - cam.near);
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
    this.patchedList = [];
    this.init(ctx);
  }

  dispose(): void {
    this.csm?.dispose();
    this.fill.dispose();
    this.bounce.dispose();
  }
}
