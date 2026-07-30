import * as THREE from 'three';
import { PARTICLE_ATLAS_DIM } from './atlas';
import { HEIGHT_GLSL, type HeightTexture } from './heightField';

/**
 * GPU particle engine.
 *
 * Every particle is a spawn *record*, never a simulated object. The CPU writes 20
 * floats once, at birth, into a ring buffer of instance attributes; from then on the
 * vertex shader evaluates the particle's whole trajectory analytically from its birth
 * state. There is no per-frame CPU loop over live particles and no scene-graph object
 * per puff, which is what makes 25k particles cost ~0 ms of CPU.
 *
 * The motion model is the closed-form solution of `dv/dt = g - k·v`, i.e. ballistic
 * flight with linear air drag toward a terminal velocity that includes the wind:
 *
 *     v(t) = (v0 - vt)·e^(-kt) + vt          vt = wind·windFactor + (0, -g/k, 0)
 *     p(t) = p0 + (v0 - vt)·(1 - e^(-kt))/k + vt·t
 *
 * That single expression covers everything: a spark that arcs and stops, a blood
 * droplet that falls fast, a dust puff that decelerates and then drifts downwind, and
 * smoke that rises (negative gravity) and is carried away.
 *
 * Two layers → two draw calls for all particles in the game:
 *   Soft      premultiplied-alpha, sun-lit, ground-aware — dust, smoke, blood, debris
 *   Additive  self-illuminated — sparks, embers, flame, shock rings
 *
 * Premultiplied alpha is deliberate: it makes the blend operator associative in the
 * colour channel, so overlapping same-coloured particles composite correctly whatever
 * order they arrive in. That removes the need to depth-sort 25k particles per frame.
 */

export enum PLayer {
  Soft = 0,
  Additive = 1,
}

/** Ground handling for a particle. Packed into the tile index. */
export enum PGround {
  /** Ride the terrain surface — the particle never sinks into a hill. */
  Ride = 0,
  /** Ignore terrain entirely — rain, smoke columns, anything airborne. */
  Free = 1,
}

/**
 * The spawn record. Callers mutate the shared instance returned by `reset()` and then
 * call `push()`, which keeps emission allocation-free on the hot path.
 */
export interface SpawnRecord {
  layer: PLayer;
  tile: number;
  ground: PGround;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds the particle lives. */
  life: number;
  /** World-space diameter at birth and at death. */
  size0: number;
  size1: number;
  /** Radians per second of billboard spin. */
  spin: number;
  r: number;
  g: number;
  b: number;
  /** Peak opacity; the shader applies the fade-in/fade-out envelope on top. */
  a: number;
  /** Downward acceleration in m/s². Negative rises (buoyant smoke, flame). */
  gravity: number;
  /** Linear drag coefficient, 1/s. Higher = stops sooner. */
  drag: number;
  /** Amplitude in metres of the curl-like wander applied over the lifetime. */
  turb: number;
  /** How strongly the wind carries this particle. Dust ~1, debris ~0.05. */
  windFactor: number;
}

interface Layer {
  cap: number;
  head: number;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  aP: THREE.InstancedBufferAttribute;
  aV: THREE.InstancedBufferAttribute;
  aS: THREE.InstancedBufferAttribute;
  aC: THREE.InstancedBufferAttribute;
  aM: THREE.InstancedBufferAttribute;
  /** Expiry time per slot, so we can report a live count without a GPU readback. */
  expiry: Float32Array;
  dirtyLo: number;
  dirtyHi: number;
  spawned: number;
}

const VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uWind;
uniform float uSizeScale;

attribute vec4 aP;   // xyz = spawn position, w = spawn time
attribute vec4 aV;   // xyz = spawn velocity, w = lifetime
attribute vec4 aS;   // size0, size1, spin, tile + 16*ground + 32*seed
attribute vec4 aC;   // rgb = tint, a = peak opacity
attribute vec4 aM;   // gravity, drag, turbulence, windFactor

varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vCol;
varying float vTile;
varying float vViewZ;
varying float vAgeN;

#include <fog_pars_vertex>

${HEIGHT_GLSL}

void main() {
  float t = uTime - aP.w;
  float life = max(aV.w, 1e-3);
  float age = t / life;

  if (t < 0.0 || age >= 1.0) {
    // Collapse dead slots behind the far plane; the rasteriser never sees them.
    vUv = vec2(0.0);
    vQuad = vec2(0.0);
    vCol = vec4(0.0);
    vTile = 0.0;
    vViewZ = -1.0;
    vAgeN = 0.0;
#ifdef USE_FOG
    vFogDepth = 0.0;
#endif
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float k = max(aM.y, 0.05);
  vec3 vt = uWind * aM.w + vec3(0.0, -aM.x / k, 0.0);
  vec3 wp = aP.xyz + (aV.xyz - vt) * ((1.0 - exp(-k * t)) / k) + vt * t;

  // Unpack: tile, ground mode and a per-particle seed all ride in one float. The seed
  // matters more than it looks — without it, every particle emitted in the same frame
  // shares a rotation and a turbulence phase, and a hundred identically-oriented
  // puffs is the single most recognisable "particle demo" artefact there is.
  float packed = aS.w;
  float tile = mod(packed, 16.0);
  float groundMode = mod(floor(packed / 16.0), 2.0);
  float seed = floor(packed / 32.0);
  // Golden-ratio stride: successive seeds land maximally far apart in phase.
  float ph = fract(seed * 0.6180339887 + aP.w * 0.017) * 6.28318;

  float ts = pow(t, 1.15) * aM.z;
  wp += vec3(sin(t * 1.31 + ph), sin(t * 0.83 + ph * 1.7) * 0.55, cos(t * 1.07 + ph * 0.6)) * ts;

  // Ease-out growth: puffs expand fast on release, then coast.
  float grow = 1.0 - pow(1.0 - age, 1.7);
  float size = mix(aS.x, aS.y, grow) * uSizeScale;

  if (groundMode < 0.5) {
    // Sit the puff on the surface instead of letting it sink through a slope.
    float ground = terrainHeight(wp.xz);
    wp.y = max(wp.y, ground + size * 0.33);
  }

  float fadeIn = smoothstep(0.0, 0.10, age);
  float fadeOut = pow(1.0 - age, 1.35);

  vec4 mv = viewMatrix * vec4(wp, 1.0);

  // Near fade. Without a depth prepass to soften against, the worst artefact a large
  // soft billboard can produce is filling the screen when the camera walks into the
  // cloud — one puff, one flat disc, whole frame. Fading out anything closer than a
  // couple of its own radii removes that entirely and costs one smoothstep.
  float nearFade = smoothstep(0.6, 2.2 + mix(aS.x, aS.y, grow) * 1.1, -mv.z);
  float rot = ph + aS.z * t;
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 q = position.xy * size;
  mv.xy += vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);

  vUv = uv;
  vQuad = position.xy * 2.0;
  vCol = vec4(aC.rgb, aC.a * fadeIn * fadeOut * nearFade);
  vTile = tile;
  vViewZ = mv.z;
  vAgeN = age;
#ifdef USE_FOG
  vFogDepth = -mv.z;
#endif

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform float uAtlasDim;
uniform vec3 uSunView;
uniform vec3 uSunColour;
uniform vec3 uAmbient;
uniform float uOpacity;
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uPlanes;
uniform float uHasDepth;
uniform float uSoftness;

varying vec2 vUv;
varying vec2 vQuad;
varying vec4 vCol;
varying float vTile;
varying float vViewZ;
varying float vAgeN;

#include <common>
#include <fog_pars_fragment>

void main() {
  if (vCol.a <= 0.002) discard;

  float col = mod(vTile, uAtlasDim);
  float row = floor(vTile / uAtlasDim);
  vec2 uvA = (vec2(col, row) + vUv) / uAtlasDim;
  vec4 tex = texture2D(uAtlas, uvA);

  float a = tex.a * vCol.a * uOpacity;
  if (a < 0.003) discard;

  vec3 base = vCol.rgb;

#ifdef LIT
  // Light the billboard as a sphere: the fake normal is what stops dust reading as a
  // flat decal stuck to the screen.
  //
  // The z term must stay strictly positive and the normal must be normalised. An
  // unnormalised vec3(vQuad, sqrt(1 - rr)) has a first-derivative discontinuity exactly
  // on the quad's inscribed circle, where the clamp bites — and that shows up in the
  // frame as a hard bright ring, i.e. every puff reads as a shaded ball with a visible
  // outline. Which is the precise artefact the fake normal exists to avoid.
  float rr = min(dot(vQuad, vQuad), 1.0);
  vec3 n = normalize(vec3(vQuad, 0.55 + 0.8 * sqrt(1.0 - rr)));

  // Heavy wrap-around: dust and smoke are strongly forward-scattering media, so the
  // terminator is soft and the shadow side is never black.
  float ndl = dot(n, uSunView);
  const float wrap = 0.62;
  float diff = clamp((ndl + wrap) / (1.0 + wrap), 0.0, 1.0);

  // Sun behind the puff, seen from the camera: the bright silver-lining pass that
  // makes a dust cloud glow when you look toward the sun.
  float fwd = pow(clamp(-uSunView.z, 0.0, 1.0), 3.0) * (0.35 + 0.65 * (1.0 - rr));

  // Sky light arrives from above, so the crown of the puff is cooler and brighter.
  float skyW = 0.40 + 0.60 * vUv.y;

  // Gains above unity, and this is the whole ballgame. Airborne mineral dust has a
  // single-scatter albedo near 0.9 and is illuminated from every side by multiple
  // scattering, so *sunlit dust is brighter than the ground that produced it*. Tuned
  // below unity it lands at the same luminance as dry grass and disappears into the
  // field — which is exactly how a technically-correct dust system scores zero.
  vec3 lit = uAmbient * skyW * 0.85 + uSunColour * (diff * 0.90 + fwd * 0.22);
  // Atlas RGB carries internal density; darker cores read as depth in the cloud. Kept
  // shallow: too much and the puff turns into a lumpy grey rock.
  base *= lit * (0.66 + 0.40 * tex.r);
#else
  base *= tex.rgb;
  // Additive sprites cool as they age — a spark is white-hot then dull orange.
  base *= mix(1.35, 0.55, vAgeN);
#endif

  // Soft particles: fade where the billboard would visibly cut into scene geometry.
  // Guarded against a depth attachment that has been cleared but not yet written —
  // an all-zero buffer would otherwise erase every particle in the frame.
  if (uHasDepth > 0.5) {
    float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
    if (d > 0.0 && d < 1.0) {
      float n0 = uPlanes.x;
      float f0 = uPlanes.y;
      float sceneZ = -(2.0 * n0 * f0) / ((f0 + n0) - (2.0 * d - 1.0) * (f0 - n0));
      a *= clamp((vViewZ - sceneZ) / uSoftness, 0.0, 1.0);
      if (a < 0.003) discard;
    }
  }

  gl_FragColor = vec4(base, 1.0);
  #ifdef LIT
    #include <fog_fragment>
  #else
    // Additive emission must be attenuated toward nothing by haze, never tinted
    // toward the fog colour, or distant fires would brighten the murk.
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      gl_FragColor.rgb *= 1.0 - fogF;
    #endif
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a);
}
`;

const DEFAULTS: SpawnRecord = {
  layer: PLayer.Soft,
  tile: 0,
  ground: PGround.Ride,
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1,
  size0: 1, size1: 1,
  spin: 0,
  r: 1, g: 1, b: 1, a: 1,
  gravity: 9.81,
  drag: 1,
  turb: 0,
  windFactor: 1,
};

export interface ParticleSystemOptions {
  softCapacity: number;
  additiveCapacity: number;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  /** The shared spawn scratch. Fill it via `reset()`, then call `push()`. */
  readonly rec: SpawnRecord = { ...DEFAULTS };

  private layers: Layer[] = [];
  private atlas: THREE.Texture;
  private time = 0;
  private spawnsThisFrame = 0;
  /** Rolling per-particle seed, packed into the tile field. 0..1023. */
  private seed = 0;

  constructor(atlas: THREE.Texture, height: HeightTexture, opts: ParticleSystemOptions) {
    this.atlas = atlas;
    this.group.name = 'vfx-particles';
    this.group.frustumCulled = false;

    this.layers[PLayer.Soft] = this.buildLayer(opts.softCapacity, height, true, 5);
    this.layers[PLayer.Additive] = this.buildLayer(opts.additiveCapacity, height, false, 6);
    for (const l of this.layers) this.group.add(l.mesh);
  }

  private buildLayer(cap: number, height: HeightTexture, lit: boolean, renderOrder: number): Layer {
    const geo = new THREE.InstancedBufferGeometry();
    // One camera-facing quad, instanced. 4 verts, 2 tris.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const mk = (): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const aP = mk();
    const aV = mk();
    const aS = mk();
    const aC = mk();
    const aM = mk();
    geo.setAttribute('aP', aP);
    geo.setAttribute('aV', aV);
    geo.setAttribute('aS', aS);
    geo.setAttribute('aC', aC);
    geo.setAttribute('aM', aM);
    geo.instanceCount = cap;
    // Bounding volume is meaningless for a world-space particle field.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: lit ? { LIT: '' } : {},
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uSizeScale: { value: 1 },
        uAtlas: { value: this.atlas },
        uAtlasDim: { value: PARTICLE_ATLAS_DIM },
        uSunView: { value: new THREE.Vector3(0, 0, 1) },
        uSunColour: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0.2, 0.25, 0.33) },
        uOpacity: { value: 1 },
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uPlanes: { value: new THREE.Vector2(0.35, 8000) },
        uHasDepth: { value: 0 },
        uSoftness: { value: 1.4 },
        uHeightTex: { value: height.texture },
        uHeightInfo: { value: new THREE.Vector3(height.min, height.range, height.res) },
        uHeightHalf: { value: height.halfExtent },
        // Populated by the renderer when `scene.fog` is set; declared here because a
        // custom ShaderMaterial does not inherit `UniformsLib.fog` automatically.
        fogColor: { value: new THREE.Color(0xb9c2c9) },
        fogDensity: { value: 0 },
        fogNear: { value: 1 },
        fogFar: { value: 3000 },
      },
      fog: true,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: lit ? THREE.CustomBlending : THREE.AdditiveBlending,
    });
    if (lit) {
      // Premultiplied-alpha "over": src is already multiplied by alpha in the shader.
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      mat.blendEquation = THREE.AddEquation;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.name = lit ? 'particles-soft' : 'particles-additive';
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    return {
      cap, head: 0, mesh, mat, aP, aV, aS, aC, aM,
      expiry: new Float32Array(cap),
      dirtyLo: cap, dirtyHi: -1, spawned: 0,
    };
  }

  /** Reset the shared spawn record to defaults for `layer`/`tile` and return it. */
  reset(layer: PLayer, tile: number): SpawnRecord {
    const r = this.rec;
    r.layer = layer;
    r.tile = tile;
    r.ground = PGround.Ride;
    r.x = 0; r.y = 0; r.z = 0;
    r.vx = 0; r.vy = 0; r.vz = 0;
    r.life = 1;
    r.size0 = 1; r.size1 = 1;
    r.spin = 0;
    r.r = 1; r.g = 1; r.b = 1; r.a = 1;
    r.gravity = 9.81;
    r.drag = 1;
    r.turb = 0;
    r.windFactor = 1;
    return r;
  }

  /** Commit the current spawn record. Cheap: 20 float writes and a cursor bump. */
  push(): void {
    const r = this.rec;
    const l = this.layers[r.layer];
    const i = l.head;
    l.head = (l.head + 1) % l.cap;
    l.spawned++;
    this.spawnsThisFrame++;

    const o = i * 4;
    l.aP.array[o] = r.x;
    l.aP.array[o + 1] = r.y;
    l.aP.array[o + 2] = r.z;
    l.aP.array[o + 3] = this.time;

    l.aV.array[o] = r.vx;
    l.aV.array[o + 1] = r.vy;
    l.aV.array[o + 2] = r.vz;
    l.aV.array[o + 3] = r.life;

    // 397 is coprime with 1024, so consecutive spawns get far-apart seeds and a burst
    // emitted in one frame is decorrelated in rotation and turbulence.
    this.seed = (this.seed + 397) & 1023;
    l.aS.array[o] = r.size0;
    l.aS.array[o + 1] = r.size1;
    l.aS.array[o + 2] = r.spin;
    l.aS.array[o + 3] = r.tile + r.ground * 16 + this.seed * 32;

    l.aC.array[o] = r.r;
    l.aC.array[o + 1] = r.g;
    l.aC.array[o + 2] = r.b;
    l.aC.array[o + 3] = r.a;

    l.aM.array[o] = r.gravity;
    l.aM.array[o + 1] = r.drag;
    l.aM.array[o + 2] = r.turb;
    l.aM.array[o + 3] = r.windFactor;

    l.expiry[i] = this.time + r.life;
    if (i < l.dirtyLo) l.dirtyLo = i;
    if (i > l.dirtyHi) l.dirtyHi = i;
  }

  /** Advance the shader clock. `dt` should be scaled game time so particles pause. */
  advance(dt: number): void {
    this.time += dt;
  }

  get clock(): number {
    return this.time;
  }

  /** Per-frame uniform refresh and attribute upload. Call from `preRender`. */
  flush(
    wind: THREE.Vector3,
    sunView: THREE.Vector3,
    sunColour: THREE.Color,
    ambient: THREE.Color,
    depth: THREE.Texture | null,
    viewW: number,
    viewH: number,
    near: number,
    far: number
  ): void {
    for (const l of this.layers) {
      const u = l.mat.uniforms;
      u.uTime.value = this.time;
      (u.uWind.value as THREE.Vector3).copy(wind);
      (u.uSunView.value as THREE.Vector3).copy(sunView);
      (u.uSunColour.value as THREE.Color).copy(sunColour);
      (u.uAmbient.value as THREE.Color).copy(ambient);
      u.uDepth.value = depth;
      u.uHasDepth.value = depth ? 1 : 0;
      (u.uInvRes.value as THREE.Vector2).set(1 / Math.max(1, viewW), 1 / Math.max(1, viewH));
      (u.uPlanes.value as THREE.Vector2).set(near, far);

      if (l.dirtyHi >= l.dirtyLo) {
        const lo = l.dirtyLo;
        const n = l.dirtyHi - lo + 1;
        // A wrapped write region is cheaper to upload whole than as two ranges.
        const partial = n < l.cap * 0.6;
        for (const a of [l.aP, l.aV, l.aS, l.aC, l.aM]) {
          a.clearUpdateRanges();
          if (partial) a.addUpdateRange(lo * 4, n * 4);
          a.needsUpdate = true;
        }
        l.dirtyLo = l.cap;
        l.dirtyHi = -1;
      }
    }
    this.spawnsThisFrame = 0;
  }

  /** Global opacity, used to dial particles back when quality drops. */
  setOpacity(soft: number, additive: number): void {
    this.layers[PLayer.Soft].mat.uniforms.uOpacity.value = soft;
    this.layers[PLayer.Additive].mat.uniforms.uOpacity.value = additive;
  }

  /** Live particle count, computed from stored expiry times (no GPU readback). */
  liveCount(): number {
    let n = 0;
    for (const l of this.layers) {
      const e = l.expiry;
      for (let i = 0; i < l.cap; i++) if (e[i] > this.time) n++;
    }
    return n;
  }

  totalSpawned(): number {
    let n = 0;
    for (const l of this.layers) n += l.spawned;
    return n;
  }

  get capacity(): number {
    let n = 0;
    for (const l of this.layers) n += l.cap;
    return n;
  }

  dispose(): void {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      l.mat.dispose();
    }
    this.layers.length = 0;
  }
}
