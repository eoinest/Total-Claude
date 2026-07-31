import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import type { EngineContext, Subsystem } from '../core/Engine';
import { ATMOSPHERE_GLSL } from '../shaders/atmosphere.glsl';
import { CLOUDS_GLSL, CLOUD_FIELD_GLSL } from '../shaders/clouds.glsl';
import { clamp, clamp01 } from '../util/math';
import {
  blendPresets,
  horizonRadiance,
  setSolarSite,
  skyFillRadiance,
  sunDirectionForHour,
  sunIrradiance,
  RADIANCE_SCALE,
  SKY_PRESETS,
  type AtmosParams,
  type SkyPreset,
} from './atmosphere';
import { activeMap } from '../maps';

/**
 * Physical sky, cloud layers and image-based lighting.
 *
 * Structure:
 *   1. A Rayleigh/Mie/ozone single-scattering integral (see
 *      `src/shaders/atmosphere.glsl.ts`) is baked into a 256^2 cube whenever the
 *      sun moves. The integral costs ~130 samples per texel, which is far too
 *      much per screen pixel but nothing at all six times per time-of-day change.
 *   2. The visible sky is a fullscreen background pass that samples that cube and
 *      adds the sun disc and two cloud shells at full resolution.
 *   3. The same cube feeds `PMREMGenerator`, so the IBL cannot disagree with the
 *      sky the player is looking at. A Poly Haven HDRI, when present, replaces
 *      the cube as the IBL source and is rotated so its sun lines up with ours.
 *   4. `PostFX` samples `skyCubeTexture` for aerial perspective, so distant hills
 *      converge on exactly the colour of the sky behind them.
 *
 * Contracts consumed elsewhere: `sunDirection`, `sunColour`, `ambientColour`,
 * `timeOfDay`, `setTimeOfDay`, `environmentTexture`.
 */

/** Where the cumulus deck sits. 1 700 m is a typical continental summer cloud base. */
const CLOUD_ALTITUDE = 1700;
/** Cirrus at 7 km, the low end of the real range, so the parallax stays visible. */
const CIRRUS_ALTITUDE = 7000;
/**
 * World metres -> cloud noise uv. A 7.7 km tile puts the base octave's features
 * at ~3.8 km and the second at ~1.5 km, which is the real size range of
 * continental cumulus — and it means the 2.8 km battlefield sees more than one
 * cloud shadow at a time instead of sitting under a single blanket.
 */
const CLOUD_UV_SCALE = 0.00013;
const CIRRUS_UV_SCALE = 0.00005;
/** Cube face resolution for the baked atmosphere. The sky gradient is smooth
 *  enough that 256 (0.35 deg/texel) interpolates without visible banding. */
const SKY_CUBE_SIZE = 256;

/**
 * Environment (IBL) intensity. Deliberately below the physically correct 1.0.
 *
 * A clear sky's diffuse irradiance really is about a quarter of the sun's, and
 * rendering it at that level is what produced the flat, milky frames this pass
 * exists to fix: it lifts every shadow to within 4:1 of full sun, which after a
 * filmic curve is barely a stop and a half. Rome II's shadows sit nearer 8:1.
 * Trimming the fill and paying for it with exposure buys that stop back, and
 * physically it is defensible — half the sky hemisphere is occluded by the man
 * in front of you and none of this pipeline knows that.
 */
const AMBIENT_TRIM = 0.6;

/**
 * Ground albedo the `AMBIENT_TRIM` above was calibrated against — the Campus Martius'
 * afternoon preset. A map whose ground is brighter genuinely does return more light to
 * everything in shadow, and the IBL has to carry its share of that or the trim silently
 * becomes a much deeper cut on a bright map than on a dark one. Bounded, because this is a
 * correction for a first-order effect and not a full interreflection solve.
 */
const TRIM_REFERENCE_ALBEDO = 0.13;
const ambientTrimFor = (groundAlbedo: number): number =>
  AMBIENT_TRIM * clamp(groundAlbedo / TRIM_REFERENCE_ALBEDO, 0.8, 1.55);

export class SkySystem implements Subsystem {
  readonly name = 'sky';
  readonly order = -90;

  readonly sunDirection = new THREE.Vector3(-0.55, 0.43, 0.71).normalize();
  readonly sunColour = new THREE.Color(1, 0.94, 0.82);
  readonly ambientColour = new THREE.Color(0.42, 0.5, 0.66);
  /** Perpendicular sun irradiance in render units — the directional intensity. */
  sunIntensity = 3;
  /** Cosine-weighted average sky radiance; the hemisphere fill colour. */
  readonly skyFillColour = new THREE.Color(0.42, 0.5, 0.66);
  /** Average horizon radiance. The aerial-perspective and fallback fog tint. */
  readonly horizonColour = new THREE.Color(0.7, 0.75, 0.8);

  /**
   * Hours past midnight, 0..24. 14:18 is the default because that is where the
   * autumn sun's azimuth (218 deg) crosses the battle camera's view axis: the
   * light rakes across the frame instead of over the player's shoulder, which is
   * the difference between shadows you can read and shadows hidden behind the men
   * casting them. See `SEASON_DECLINATION` in `atmosphere.ts`.
   */
  timeOfDay = 14.3;
  /** Active atmospheric parameters. PostFX reads `haze*` and `exposure`. */
  preset: SkyPreset = { ...SKY_PRESETS.afternoon };
  /**
   * The active map's daylight presets, in ascending hour order. `setTimeOfDay` blends
   * between adjacent entries, so a map states its own weather across the day rather than
   * borrowing another site's.
   */
  private dayCycle: readonly string[] = ['dawn', 'morning', 'noon', 'afternoon', 'goldenHour'];

  /** PMREM-processed environment for IBL. */
  environmentTexture: THREE.Texture | null = null;
  /** Raw radiance cube of the atmosphere, for aerial perspective. */
  get skyCubeTexture(): THREE.CubeTexture | null {
    return this.cubeRT ? this.cubeRT.texture : null;
  }

  /**
   * Packed 4-octave cloud noise. Sampled by the dome, by the cloud-shadow term
   * injected into scene materials, and available to anyone who wants the same
   * field (`cloudShadowAt` is the CPU equivalent).
   */
  cloudNoiseTexture: THREE.DataTexture | null = null;
  /** Uniforms shared *by reference* with every patched scene material. */
  readonly cloudUniformA = new THREE.Vector4(CLOUD_UV_SCALE, 0, 0, 0.53);
  readonly cloudUniformB = new THREE.Vector4(0.17, 0.55, CLOUD_ALTITUDE, 0);
  readonly cloudSunDir = new THREE.Vector3(-0.55, 0.43, 0.71);

  private atmos: AtmosParams = {
    sunDir: this.sunDirection,
    turbidity: 2.7,
    groundAlbedo: 0.13,
    msScale: 0.36,
    // 0.76 is the classic continental-aerosol Henyey-Greenstein asymmetry; it
    // puts the right amount of glare in the 20 deg around the sun.
    mieG: 0.76,
  };

  private cubeRT?: THREE.WebGLCubeRenderTarget;
  private cubeCam?: THREE.CubeCamera;
  private bakeScene?: THREE.Scene;
  private bakeMat?: THREE.ShaderMaterial;
  private pmrem?: THREE.PMREMGenerator;
  private pmremRT?: THREE.WebGLRenderTarget;
  private hdriEnv: THREE.Texture | null = null;
  private hdriAzimuth = 0;

  private background?: THREE.Mesh;
  private bgMat?: THREE.ShaderMaterial;
  private fog?: THREE.FogExp2;
  /** Set by PostFX when it takes over atmospheric fading in screen space. */
  private screenSpaceFog = false;

  private noiseData?: Float32Array;
  /** fBm sigma / 0.15 — converts preset coverage units into raw noise values. */
  private covScale = 1;
  private windTime = 0;
  private dirty = true;

  private readonly rayMatrix = new THREE.Matrix4();

  init(ctx: EngineContext): void {
    // The site has to be installed before the first applyTime, because every colour in
    // this system falls out of the sun's elevation and there is no later chance to correct
    // it: the PMREM IBL, the fog tint and PostFX's aerial perspective are all baked from it.
    const map = activeMap();
    setSolarSite(map.site.latitudeDeg, map.site.declinationDeg);
    this.dayCycle = map.sky.dayCycle;
    this.timeOfDay = map.sky.defaultHour;
    this.preset = { ...(SKY_PRESETS[this.dayCycle[0]] ?? SKY_PRESETS.afternoon) };

    this.makeCloudNoise();
    this.buildBakeScene(ctx);
    this.buildBackground(ctx);

    this.fog = new THREE.FogExp2(0xb9c2c9, 0.00055);
    ctx.scene.fog = this.fog;

    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
    this.pmrem.compileCubemapShader();

    this.applyTime();
    this.bake(ctx);
    this.dirty = false;

    // Non-fatal: the game must render with an empty public/assets.
    void this.loadHdri(ctx);
  }

  // ---------------------------------------------------------------------------
  // Cloud noise
  // ---------------------------------------------------------------------------

  /**
   * A 512^2 RGBA tiling noise where each channel holds a different octave of
   * value noise at the *same* uv. One texture fetch therefore yields a 4-octave
   * fBm, which is what makes the cloud shader cheap enough to run at full
   * resolution. Frequencies are coprime-ish (2/5/11/23) so the octaves never
   * line up into a visible grid, and 23 cycles across 512 px still leaves 22 px
   * per period — above the Nyquist limit for bilinear sampling.
   */
  private makeCloudNoise(): void {
    const N = 512;
    const data = new Uint8Array(N * N * 4);
    const freqs = [2, 5, 11, 23];
    const grids: Float32Array[] = freqs.map((f) => {
      const g = new Float32Array(f * f);
      // Deterministic hash so the cloudscape is identical every run — the
      // screenshot harness diffs frames between passes.
      for (let i = 0; i < g.length; i++) {
        const h = Math.sin(i * 12.9898 + f * 78.233) * 43758.5453;
        g[i] = h - Math.floor(h);
      }
      // Centre each octave on 0.5 and stretch it to fill [0,1]. The lowest
      // octave has only 4 grid values, so its raw mean can sit far from 0.5 —
      // and since it carries half the fBm's weight, that bias would shift the
      // whole coverage threshold and leave the sky either empty or solid.
      let mean = 0;
      for (let i = 0; i < g.length; i++) mean += g[i];
      mean /= g.length;
      let dev = 1e-6;
      for (let i = 0; i < g.length; i++) dev = Math.max(dev, Math.abs(g[i] - mean));
      const k = 0.5 / dev;
      for (let i = 0; i < g.length; i++) g[i] = 0.5 + (g[i] - mean) * k;
      return g;
    });

    const smooth = (t: number): number => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        for (let c = 0; c < 4; c++) {
          const f = freqs[c];
          const g = grids[c];
          const fx = (x / N) * f;
          const fy = (y / N) * f;
          const x0 = Math.floor(fx) % f;
          const y0 = Math.floor(fy) % f;
          const x1 = (x0 + 1) % f;
          const y1 = (y0 + 1) % f;
          const tx = smooth(fx - Math.floor(fx));
          const ty = smooth(fy - Math.floor(fy));
          const a = g[y0 * f + x0];
          const b = g[y0 * f + x1];
          const cc = g[y1 * f + x0];
          const d = g[y1 * f + x1];
          const top = a + (b - a) * tx;
          const bot = cc + (d - cc) * tx;
          data[(y * N + x) * 4 + c] = Math.round((top + (bot - top) * ty) * 255);
        }
      }
    }

    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.cloudNoiseTexture = tex;

    // Float copy so cloudShadowAt can answer CPU-side queries with the same field.
    this.noiseData = new Float32Array(N * N * 4);
    for (let i = 0; i < data.length; i++) this.noiseData[i] = data[i] / 255;

    // Measure the fBm's spread so cloudCoverage can be expressed in units of
    // standard deviation instead of raw noise values. Without this the preset
    // numbers only mean anything for one particular hash.
    const w = SkySystem.OCTAVE_W;
    let sum = 0;
    let sum2 = 0;
    const n = N * N;
    for (let i = 0; i < n; i++) {
      const b = i * 4;
      const v = (this.noiseData[b] * w[0] + this.noiseData[b + 1] * w[1]
        + this.noiseData[b + 2] * w[2] + this.noiseData[b + 3] * w[3]);
      sum += v;
      sum2 += v * v;
    }
    const mean = sum / n;
    // Include the detail term's contribution (weight 0.22, same distribution).
    const sigma = Math.sqrt(Math.max(1e-8, sum2 / n - mean * mean)) * 1.024;
    // COVERAGE_SIGMA units per 1.0 of preset cloudCoverage: a preset value of
    // 0.5 is the median (about half the sky), 0.65 is +1 sigma (~16 %).
    this.covScale = sigma / 0.15;
  }

  /** Preset coverage (in sigma units around the median) -> raw fBm threshold. */
  private rawCoverage(coverage: number): number {
    return 0.5 + (coverage - 0.5) * this.covScale;
  }

  /** Preset softness -> raw fBm ramp width. */
  private rawSoftness(softness: number): number {
    return Math.max(1e-3, softness * this.covScale);
  }

  /** Bilinear fetch of the packed noise, matching `texture2D` in the shader. */
  private sampleNoise(u: number, v: number, out: [number, number, number, number]): void {
    const N = 512;
    const d = this.noiseData;
    if (!d) {
      out[0] = out[1] = out[2] = out[3] = 0.5;
      return;
    }
    const fx = (((u % 1) + 1) % 1) * N - 0.5;
    const fy = (((v % 1) + 1) % 1) * N - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const wrap = (i: number): number => ((i % N) + N) % N;
    const i00 = (wrap(y0) * N + wrap(x0)) * 4;
    const i10 = (wrap(y0) * N + wrap(x0 + 1)) * 4;
    const i01 = (wrap(y0 + 1) * N + wrap(x0)) * 4;
    const i11 = (wrap(y0 + 1) * N + wrap(x0 + 1)) * 4;
    for (let c = 0; c < 4; c++) {
      const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * tx;
      const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * tx;
      out[c] = top + (bot - top) * ty;
    }
  }

  private static readonly OCTAVE_W = [0.5333, 0.2667, 0.1333, 0.0667];
  private readonly nTmp: [number, number, number, number] = [0, 0, 0, 0];
  private readonly nTmp2: [number, number, number, number] = [0, 0, 0, 0];

  private fbm(u: number, v: number): number {
    this.sampleNoise(u, v, this.nTmp);
    const w = SkySystem.OCTAVE_W;
    return this.nTmp[0] * w[0] + this.nTmp[1] * w[1] + this.nTmp[2] * w[2] + this.nTmp[3] * w[3];
  }

  /**
   * How much of the sun a cloud is blocking at a world ground position, 0..1
   * (1 = full sun). CPU equivalent of `tcCloudShadow`; the lighting system uses
   * it to dim the sun by the average over the visible field.
   */
  cloudShadowAt(x: number, z: number): number {
    const s = this.cloudUniformA.x;
    const lift = CLOUD_ALTITUDE / Math.max(this.sunDirection.y, 0.22);
    const u = (x + this.sunDirection.x * lift) * s + this.cloudUniformA.y;
    const v = (z + this.sunDirection.z * lift) * s + this.cloudUniformA.z;
    const base = this.fbm(u, v);
    this.sampleNoise(u * 0.37, v * 0.37, this.nTmp2);
    const detail = this.fbm(u * 3.7 + (this.nTmp2[1] - 0.5) * 0.06, v * 3.7 + (this.nTmp2[2] - 0.5) * 0.06);
    // Must match tcCloudCoverage exactly.
    const shape = base + (detail - 0.5) * 0.22;
    const c0 = this.cloudUniformA.w;
    const c1 = c0 + this.cloudUniformB.x;
    const cov = clamp01((shape - c0) / Math.max(1e-4, c1 - c0));
    return 1 - cov * cov * (3 - 2 * cov) * this.cloudUniformB.y;
  }

  // ---------------------------------------------------------------------------
  // Baked atmosphere cube + IBL
  // ---------------------------------------------------------------------------

  private atmosUniforms(): Record<string, THREE.IUniform> {
    return {
      uSunDir: { value: this.sunDirection },
      // Neutral chromaticity, luminance preserved — see SOLAR_IRRADIANCE in
      // atmosphere.ts for why three spectral samples must not be used as RGB.
      uSunIrradiance: { value: new THREE.Vector3(1.775, 1.775, 1.775) },
      uTurbidity: { value: this.atmos.turbidity },
      uGroundAlbedo: { value: this.atmos.groundAlbedo },
      uMsScale: { value: this.atmos.msScale },
      uMieG: { value: this.atmos.mieG },
      uRadianceScale: { value: RADIANCE_SCALE },
      uAltitude: { value: 40 },
    };
  }

  private static readonly ATMOS_PARAM_BLOCK = /* glsl */ `
    uniform vec3 uSunDir;
    uniform vec3 uSunIrradiance;
    uniform float uTurbidity;
    uniform float uGroundAlbedo;
    uniform float uMsScale;
    uniform float uMieG;
    uniform float uRadianceScale;
    uniform float uAltitude;

    TCAtmos tcParams() {
      TCAtmos a;
      a.sunDir = normalize( uSunDir );
      a.sunIrradiance = uSunIrradiance;
      a.turbidity = uTurbidity;
      a.groundAlbedo = uGroundAlbedo;
      a.msScale = uMsScale;
      a.mieG = uMieG;
      return a;
    }
  `;

  /** A sphere carrying the raw atmosphere, rendered by a CubeCamera. */
  private buildBakeScene(ctx: EngineContext): void {
    this.bakeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      // The bake must stay in linear radiance; tone mapping here would bake the
      // display transform into the IBL and into the aerial-perspective lookup.
      toneMapped: false,
      uniforms: this.atmosUniforms(),
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader:
        ATMOSPHERE_GLSL +
        SkySystem.ATMOS_PARAM_BLOCK +
        /* glsl */ `
        varying vec3 vDir;
        void main() {
          vec3 d = normalize( vDir );
          vec3 L = tcSkyRadiance( tcOrigin( uAltitude ), d, tcParams(), 20 );
          gl_FragColor = vec4( L * uRadianceScale, 1.0 );
        }
      `,
    });

    this.bakeScene = new THREE.Scene();
    this.bakeScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 24), this.bakeMat));

    this.cubeRT = new THREE.WebGLCubeRenderTarget(SKY_CUBE_SIZE, {
      // Half float: the sun-adjacent horizon is 30x brighter than the zenith and
      // 8-bit would band badly across that range.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    });
    this.cubeCam = new THREE.CubeCamera(1, 2000, this.cubeRT);
    void ctx;
  }

  /**
   * Fullscreen background rather than a dome mesh: `RTSCamera` pulls the far
   * plane in to 2 600 m when zoomed to eye level, which clips any dome big
   * enough to enclose the battlefield. A quad at clip z = 1 cannot clip, and it
   * leaves the depth buffer at 1.0 so PostFX can identify sky pixels.
   */
  private buildBackground(ctx: EngineContext): void {
    this.bgMat = new THREE.ShaderMaterial({
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      uniforms: {
        ...this.atmosUniforms(),
        uSkyCube: { value: null },
        uRayMatrix: { value: this.rayMatrix },
        uCamPos: { value: new THREE.Vector3() },
        uSunColour: { value: new THREE.Vector3(3, 2.8, 2.4) },
        uCloudNoise: { value: null },
        // x: coverage, y: softness, z: density, w: uv scale
        uCloud: { value: new THREE.Vector4(0.53, 0.17, 6.5, CLOUD_UV_SCALE) },
        uCloudWind: { value: new THREE.Vector2() },
        // x: coverage, y: softness, z: density, w: uv scale
        uCirrus: { value: new THREE.Vector4(0.58, 0.22, 2.2, CIRRUS_UV_SCALE) },
        uCirrusWind: { value: new THREE.Vector2() },
        uSunDiscScale: { value: 55 },
      },
      vertexShader: /* glsl */ `
        uniform mat4 uRayMatrix;
        uniform vec3 uCamPos;
        varying vec3 vRay;
        void main() {
          // Un-project the far clip-plane corner to a world point. All three
          // vertices sit at constant view-space z, so the world point is linear
          // in screen space and interpolating the direction is exact.
          vec4 r = uRayMatrix * vec4( position.xy, 1.0, 1.0 );
          vRay = r.xyz / r.w - uCamPos;
          gl_Position = vec4( position.xy, 1.0, 1.0 );
        }
      `,
      fragmentShader:
        ATMOSPHERE_GLSL +
        CLOUD_FIELD_GLSL +
        CLOUDS_GLSL +
        SkySystem.ATMOS_PARAM_BLOCK +
        /* glsl */ `
        uniform samplerCube uSkyCube;
        uniform vec3 uCamPos;
        uniform vec3 uSunColour;
        uniform sampler2D uCloudNoise;
        uniform vec4 uCloud;
        uniform vec2 uCloudWind;
        uniform vec4 uCirrus;
        uniform vec2 uCirrusWind;
        uniform float uSunDiscScale;
        varying vec3 vRay;

        void main() {
          vec3 d = normalize( vRay );
          vec3 sun = normalize( uSunDir );
          vec3 sky = textureCube( uSkyCube, d ).rgb;

          // --- clouds ---
          TCCloudLayer cum;
          cum.altitude = ${CLOUD_ALTITUDE}.0;
          cum.scale = uCloud.w;
          cum.wind = uCloudWind;
          cum.coverage = uCloud.x;
          cum.softness = uCloud.y;
          cum.density = uCloud.z;
          // Cumulus self-shadows hard: that is where its form comes from.
          cum.absorb = 0.14;
          cum.anisoY = 1.0;

          TCCloudLayer cir;
          cir.altitude = ${CIRRUS_ALTITUDE}.0;
          cir.scale = uCirrus.w;
          cir.wind = uCirrusWind;
          cir.coverage = uCirrus.x;
          cir.softness = uCirrus.y;
          cir.density = uCirrus.z;
          // Ice crystals a few km up barely shade each other, so cirrus stays
          // bright and translucent instead of banding the sky with grey stripes.
          cir.absorb = 0.05;
          cir.anisoY = 0.28;

          vec3 colour = sky;
          vec2 camXZ = uCamPos.xz;
          float camAlt = max( 2.0, uCamPos.y );
          vec4 c2 = tcCloudLayer( uCloudNoise, cir, d, camXZ, camAlt, sun, uSunColour, sky, uMieG );
          colour = mix( colour, c2.rgb, c2.a );
          vec4 c1 = tcCloudLayer( uCloudNoise, cum, d, camXZ, camAlt, sun, uSunColour, sky, uMieG );
          colour = mix( colour, c1.rgb, c1.a );

          // --- sun disc, behind the clouds ---
          float disc = tcSunDisc( dot( d, sun ) );
          if ( disc > 0.0 ) {
            // The true disc radiance is ~27 000x the zenith, which would blow the
            // bloom threshold into a white disc the size of the screen. Clamped to
            // a value that still reads as painfully bright after AgX.
            colour += uSunColour * disc * uSunDiscScale * ( 1.0 - clamp( c1.a + c2.a, 0.0, 1.0 ) );
          }

          gl_FragColor = vec4( colour, 1.0 );
        }
      `,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.background = new THREE.Mesh(geo, this.bgMat);
    this.background.frustumCulled = false;
    // Well before anything else so it acts as a background clear.
    this.background.renderOrder = -100000;
    this.background.name = 'sky';
    ctx.scene.add(this.background);
  }

  private bake(ctx: EngineContext): void {
    if (!this.cubeCam || !this.bakeScene || !this.cubeRT || !this.pmrem) return;
    const r = ctx.renderer;
    const prevTarget = r.getRenderTarget();
    this.cubeCam.update(r, this.bakeScene);
    r.setRenderTarget(prevTarget);

    if (this.bgMat) this.bgMat.uniforms.uSkyCube.value = this.cubeRT.texture;

    // Only regenerate the procedural IBL when no HDRI has taken over.
    if (!this.hdriEnv) {
      const next = this.pmrem.fromCubemap(this.cubeRT.texture);
      this.pmremRT?.dispose();
      this.pmremRT = next;
      this.environmentTexture = next.texture;
      ctx.scene.environment = next.texture;
      ctx.scene.environmentIntensity = ambientTrimFor(this.preset.groundAlbedo);
    }
  }

  // ---------------------------------------------------------------------------
  // HDRI
  // ---------------------------------------------------------------------------

  /**
   * Load the manifest HDRI whose `timeOfDay` best matches the current preset and
   * use it for IBL. Every failure path is silent-and-continue: with an empty
   * `public/assets` the procedural PMREM stays in place.
   */
  private async loadHdri(ctx: EngineContext): Promise<void> {
    interface HdriEntry { id: string; path: string; timeOfDay?: string; weather?: string }
    let entries: HdriEntry[] = [];
    try {
      const res = await fetch('/assets/manifest.json');
      if (!res.ok) return;
      const json = (await res.json()) as { hdris?: HdriEntry[] };
      entries = json.hdris ?? [];
    } catch {
      return;
    }
    if (entries.length === 0) return;

    // Match on the sun elevation we are actually rendering, not the hour, so a
    // preset change picks a sensible plate. The bands are deliberately biased
    // toward the blue-sky plate: this project's whole clear-weather range sits
    // between 8 and 34 deg, and the sunset plate's orange hemisphere would carry
    // straight into the shadows and kill the warm/cool split the grade depends on.
    const elev = Math.asin(clamp01(this.sunDirection.y)) * (180 / Math.PI);
    const overcast = this.preset.turbidity > 6;
    const want = overcast ? 'afternoon' : elev < 6 ? 'dawn' : elev < 12 ? 'sunset' : 'midday';
    const pick =
      entries.find((e) => e.timeOfDay === want && (overcast ? e.weather === 'overcast' : true)) ??
      entries.find((e) => e.timeOfDay === want) ??
      entries[0];

    let tex: THREE.DataTexture;
    try {
      const loader = new RGBELoader();
      // Float32 so the brightest-texel scan below can read the data directly.
      loader.setDataType(THREE.FloatType);
      tex = await loader.loadAsync(pick.path);
    } catch {
      return;
    }

    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.hdriAzimuth = this.conditionHdri(tex);

    try {
      const rt = this.pmrem!.fromEquirectangular(tex);
      this.pmremRT?.dispose();
      this.pmremRT = rt;
      this.hdriEnv = rt.texture;
      this.environmentTexture = rt.texture;
      ctx.scene.environment = rt.texture;
      // The plate has been normalised to our own sky's irradiance, so it takes
      // the same trim as the procedural cube.
      ctx.scene.environmentIntensity = ambientTrimFor(this.preset.groundAlbedo);
      this.applyEnvRotation(ctx);
    } catch {
      /* keep the procedural PMREM */
    } finally {
      tex.dispose();
    }
  }

  /**
   * Make a Poly Haven plate usable as IBL, in place. Returns the azimuth of its
   * sun so the plate can be rotated to agree with ours.
   *
   * Two things have to happen or the plate wrecks the lighting balance:
   *
   *  1. **Clip the solar disc.** These are absolute-luminance captures, so the
   *     sun is thousands of times the sky mean. Left in, it is counted twice —
   *     once by the environment and once by the directional light — and the
   *     environment's copy arrives as a soft, shadowless wash from roughly the
   *     right direction, which is precisely what destroys directional contrast.
   *  2. **Match our own sky's level *per channel*.** Measured, the raw plate
   *     delivered ~3.6x the sun's irradiance: the scene ended up lit almost
   *     entirely by flat ambient, giving milky mid-greys, no black point and
   *     invisible shadows. Matching only its luminance is not enough either —
   *     a plate's chromaticity is whatever the photographer's white balance was,
   *     and a warm one cancels the cool sky bounce that separates shadow from
   *     sun. Fitting all three channels to `skyFillColour` chromatically adapts
   *     the plate to our own atmosphere while keeping its directional structure,
   *     which is the only part we actually wanted from it.
   */
  private conditionHdri(tex: THREE.DataTexture): number {
    const img = tex.image as { width: number; height: number; data: Float32Array };
    const data = img.data;
    if (!data || !(data instanceof Float32Array)) return 0;
    const w = img.width;
    const h = img.height;
    const ch = data.length / (w * h);

    // Pass 1: cosine-weighted mean radiance of the upper hemisphere — that is
    // irradiance / pi, directly comparable to skyFillColour — plus the azimuth
    // of the brightest texel.
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let wsum = 0;
    let best = -1;
    let bestX = 0;
    for (let y = 0; y < h; y++) {
      // Equirect row 0 is +Y, so theta runs 0..pi down the image.
      const theta = ((y + 0.5) / h) * Math.PI;
      const ct = Math.cos(theta);
      if (ct <= 0) break; // the lower hemisphere adds no downward irradiance
      const weight = Math.sin(theta) * ct;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        wr += data[i] * weight;
        wg += data[i + 1] * weight;
        wb += data[i + 2] * weight;
        wsum += weight;
        const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
        if (l > best) {
          best = l;
          bestX = x;
        }
      }
    }
    if (wsum <= 0) return 0;
    const meanLum = (wr * 0.2126 + wg * 0.7152 + wb * 0.0722) / wsum;
    if (!(meanLum > 1e-6)) return 0;

    // Pass 2: clip, then rescale. 40x the hemisphere mean removes the solar disc
    // (thousands of times the mean) but keeps the aureole around it, which is the
    // only bright directional thing a polished helmet has to reflect — clip at 14x
    // and every piece of metal in the army goes matte. The renormalisation below
    // fixes the total irradiance either way, so a higher ceiling just moves energy
    // from the whole sky into the sun's quarter of it, where it belongs.
    const ceil = meanLum * 40;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    for (let y = 0; y < h; y++) {
      const theta = ((y + 0.5) / h) * Math.PI;
      const ct = Math.cos(theta);
      const weight = ct > 0 ? Math.sin(theta) * ct : 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        const l = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
        if (l > ceil) {
          const k = ceil / l;
          data[i] *= k;
          data[i + 1] *= k;
          data[i + 2] *= k;
        }
        if (weight > 0) {
          cr += data[i] * weight;
          cg += data[i + 1] * weight;
          cb += data[i + 2] * weight;
        }
      }
    }
    // Per-channel gain onto our own hemisphere mean. A von-Kries adaptation in
    // RGB: crude colorimetrically, exact for the thing that matters here, which
    // is that the plate's diffuse irradiance equals skyFillColour in all three
    // channels rather than only in luminance.
    const fit = (mean: number, want: number): number =>
      mean > 1e-6 ? clamp(want / mean, 0.02, 50) : 1;
    const kr = fit(cr / wsum, this.skyFillColour.r);
    const kg = fit(cg / wsum, this.skyFillColour.g);
    const kb = fit(cb / wsum, this.skyFillColour.b);
    for (let i = 0; i < data.length; i += ch) {
      data[i] *= kr;
      data[i + 1] *= kg;
      data[i + 2] *= kb;
    }
    tex.needsUpdate = true;

    // Three maps equirect u = 0 to -X and increases toward +Z.
    return (bestX / w) * Math.PI * 2;
  }

  private applyEnvRotation(ctx: EngineContext): void {
    if (!this.hdriEnv) return;
    const ourAz = Math.atan2(this.sunDirection.z, this.sunDirection.x);
    // Rotate the plate about Y so its bright spot lands on our sun azimuth.
    ctx.scene.environmentRotation.set(0, ourAz - (this.hdriAzimuth - Math.PI), 0);
  }

  // ---------------------------------------------------------------------------
  // Time of day
  // ---------------------------------------------------------------------------

  setTimeOfDay(hours: number): void {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    this.preset = this.presetForHour(this.timeOfDay);
    this.applyTime();
    this.dirty = true;
  }

  /** Jump to a named look. Presets carry weather as well as sun position. */
  setPreset(name: keyof typeof SKY_PRESETS): void {
    const p = SKY_PRESETS[name];
    if (!p) return;
    this.preset = { ...p };
    this.timeOfDay = p.hour;
    this.applyTime();
    this.dirty = true;
  }

  /** Blend the active map's daylight presets by hour so `setTimeOfDay` stays coherent. */
  private presetForHour(h: number): SkyPreset {
    const keys = this.dayCycle.filter((k) => SKY_PRESETS[k]);
    if (keys.length === 0) return { ...SKY_PRESETS.afternoon, hour: h };
    const hours = keys.map((k) => SKY_PRESETS[k].hour);
    if (h <= hours[0]) return { ...SKY_PRESETS[keys[0]], hour: h };
    for (let i = 0; i < keys.length - 1; i++) {
      if (h <= hours[i + 1]) {
        const t = (h - hours[i]) / (hours[i + 1] - hours[i]);
        return { ...blendPresets(SKY_PRESETS[keys[i]], SKY_PRESETS[keys[i + 1]], t), hour: h };
      }
    }
    return { ...SKY_PRESETS[keys[keys.length - 1]], hour: h };
  }

  private applyTime(): void {
    sunDirectionForHour(this.timeOfDay, this.sunDirection);
    this.cloudSunDir.copy(this.sunDirection);

    this.atmos.turbidity = this.preset.turbidity;
    this.atmos.groundAlbedo = this.preset.groundAlbedo;
    this.atmos.msScale = this.preset.msScale;

    // Sun colour and strength straight out of the transmittance integral.
    this.sunIntensity = sunIrradiance(this.atmos, 40, this.sunColour);
    skyFillRadiance(this.atmos, 40, this.skyFillColour);
    horizonRadiance(this.atmos, 40, this.horizonColour);
    // ambientColour is the historical contract name; it is the sky fill.
    this.ambientColour.copy(this.skyFillColour);

    // Clouds are lit by the sun's spectral colour at its full irradiance.
    const sc = this.sunColour;
    const i = this.sunIntensity;

    for (const mat of [this.bakeMat, this.bgMat]) {
      if (!mat) continue;
      mat.uniforms.uTurbidity.value = this.atmos.turbidity;
      mat.uniforms.uGroundAlbedo.value = this.atmos.groundAlbedo;
      mat.uniforms.uMsScale.value = this.atmos.msScale;
    }
    if (this.bgMat) {
      const u = this.bgMat.uniforms;
      (u.uSunColour.value as THREE.Vector3).set(sc.r * i, sc.g * i, sc.b * i);
      (u.uCloud.value as THREE.Vector4).set(
        this.rawCoverage(this.preset.cloudCoverage), this.rawSoftness(this.preset.cloudSoftness),
        this.preset.cloudDensity, CLOUD_UV_SCALE,
      );
      (u.uCirrus.value as THREE.Vector4).set(
        this.rawCoverage(this.preset.cirrusCoverage), this.rawSoftness(this.preset.cloudSoftness + 0.09),
        // Thin: a full-coverage cirrus veil should read as ~50 % opaque, not solid.
        0.8, CIRRUS_UV_SCALE,
      );
      u.uCloudNoise.value = this.cloudNoiseTexture;
    }

    this.cloudUniformA.set(CLOUD_UV_SCALE, this.cloudUniformA.y, this.cloudUniformA.z,
      this.rawCoverage(this.preset.cloudCoverage));
    this.cloudUniformB.set(
      this.rawSoftness(this.preset.cloudSoftness), this.preset.cloudShadowStrength,
      CLOUD_ALTITUDE, 0,
    );

    if (this.fog) {
      this.fog.color.copy(this.horizonColour);
      // A rough exponential match to the aerial-perspective pass, used only when
      // PostFX is not present. 1/1600 m puts the horizon at ~58 % haze.
      this.fog.density = this.screenSpaceFog ? 0 : this.preset.hazeDensity * 0.55;
    }
  }

  /** PostFX calls this so the cheap `FogExp2` does not double up on the real thing. */
  setScreenSpaceFog(on: boolean): void {
    this.screenSpaceFog = on;
    if (this.fog) this.fog.density = on ? 0 : this.preset.hazeDensity * 0.55;
  }

  update(dt: number, _ctx: EngineContext): void {
    // Wind. 8 m/s at the cumulus deck is a light breeze; the cirrus runs faster
    // and at a different bearing, which is what stops the sky looking like one
    // sliding texture.
    this.windTime += dt;
    const s = CLOUD_UV_SCALE;
    if (this.bgMat) {
      (this.bgMat.uniforms.uCloudWind.value as THREE.Vector2).set(
        this.windTime * 7.0 * s, this.windTime * 2.4 * s,
      );
      (this.bgMat.uniforms.uCirrusWind.value as THREE.Vector2).set(
        this.windTime * 17.0 * CIRRUS_UV_SCALE, this.windTime * -4.0 * CIRRUS_UV_SCALE * 0.28,
      );
    }
    this.cloudUniformA.y = this.windTime * 7.0 * s;
    this.cloudUniformA.z = this.windTime * 2.4 * s;
  }

  preRender(ctx: EngineContext): void {
    if (this.dirty) {
      this.dirty = false;
      this.bake(ctx);
      if (this.hdriEnv) this.applyEnvRotation(ctx);
    }

    this.syncCamera(ctx.camera);
  }

  /**
   * Rebuild the view-ray matrix. Called again by PostFX after it applies the TAA
   * projection jitter: the sky is a fullscreen pass, so if its rays are not
   * jittered too, silhouettes against the sky never resolve.
   */
  syncCamera(cam: THREE.PerspectiveCamera): void {
    if (this.bgMat) {
      // World ray direction = cameraWorld * inverseProjection applied to the far
      // clip corner. The vertex shader divides by w and subtracts the camera
      // position, so the interpolated value is a direction at every pixel.
      this.rayMatrix.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
      (this.bgMat.uniforms.uCamPos.value as THREE.Vector3).copy(cam.position);
    }
    if (this.bakeMat) this.bakeMat.uniforms.uAltitude.value = Math.max(2, cam.position.y);
  }

  dispose(): void {
    this.background?.geometry.dispose();
    this.bgMat?.dispose();
    this.bakeMat?.dispose();
    this.bakeScene?.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.cubeRT?.dispose();
    this.pmremRT?.dispose();
    this.pmrem?.dispose();
    this.cloudNoiseTexture?.dispose();
  }
}
