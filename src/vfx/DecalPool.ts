import * as THREE from 'three';
import { DECAL_ATLAS_DIM } from './atlas';
import { HEIGHT_GLSL, type HeightTexture } from './heightField';

/**
 * Crisp, ground-conforming decals — the sharp tier above the accumulation buffer.
 *
 * The damage layer handles broad staining at ~1 m per texel; this handles the things
 * a player's eye lands on up close: the pool under a body, the cast-off arc from a
 * killing blow, a hoof gouge. Each decal is an instanced 4×4 patch whose vertices
 * sample the terrain heightfield in the vertex shader, so it drapes over slopes for
 * free with no CPU-side projection and no geometry clipping.
 *
 * Pooled and capped. When the pool is full, the oldest decal is reused — and because
 * the accumulation buffer has already recorded a soft version of every splat, recycling
 * removes only the sharp detail, never the fact that blood was spilt there.
 */

const VERT = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uAtlasDim;

attribute vec3 aPos;
attribute vec4 aSizeRotTile;  // sizeX, sizeZ, rotation, tile
attribute vec4 aCol;
attribute vec2 aAge;          // birth time, lifetime

varying vec2 vUv;
varying vec4 vCol;
varying vec3 vNormal;

${HEIGHT_GLSL}

void main() {
  float t = uTime - aAge.x;
  if (t < 0.0 || t >= aAge.y) {
    vUv = vec2(0.0);
    vCol = vec4(0.0);
    vNormal = vec3(0.0, 1.0, 0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float c = cos(aSizeRotTile.z);
  float s = sin(aSizeRotTile.z);
  vec2 q = vec2(position.x * aSizeRotTile.x, position.z * aSizeRotTile.y);
  vec2 xz = aPos.xz + vec2(q.x * c - q.y * s, q.x * s + q.y * c);

  float h = terrainHeight(xz);
  // Central differences on the height texture give a normal for free, so the decal is
  // shaded by the slope it lies on rather than being flat-lit.
  float e = 2.0;
  vec3 n = normalize(vec3(
    terrainHeight(xz - vec2(e, 0.0)) - terrainHeight(xz + vec2(e, 0.0)),
    2.0 * e,
    terrainHeight(xz - vec2(0.0, e)) - terrainHeight(xz + vec2(0.0, e))
  ));

  float fadeIn = smoothstep(0.0, 0.45, t);
  float fadeOut = 1.0 - smoothstep(aAge.y * 0.82, aAge.y, t);

  // Atlas tile is resolved per instance here, so all decal kinds share one draw call.
  float acol = mod(aSizeRotTile.w, uAtlasDim);
  float arow = floor(aSizeRotTile.w / uAtlasDim);
  vUv = (vec2(acol, arow) + uv) / uAtlasDim;
  vCol = vec4(aCol.rgb, aCol.a * fadeIn * fadeOut);
  vNormal = n;

  // 9 cm of lift: enough to clear the terrain mesh's triangle sag, small enough that
  // it never separates visibly even at eye level.
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, h + 0.09, xz.y, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform vec3 uSun;
uniform vec3 uSunColour;
uniform vec3 uAmbient;

varying vec2 vUv;
varying vec4 vCol;
varying vec3 vNormal;

void main() {
  if (vCol.a <= 0.003) discard;
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vCol.a;
  if (a < 0.006) discard;

  // Atlas .r modulates darkness within the shape: pool centres go nearly black,
  // thin edges stay rust-brown. That gradient is most of what sells wetness.
  vec3 base = vCol.rgb * (0.22 + 1.05 * tex.r);

  float ndl = clamp(dot(normalize(vNormal), uSun), 0.0, 1.0);
  vec3 lit = uAmbient * 0.6 + uSunColour * ndl * 0.95;
  base *= lit;
  base += uSunColour * pow(ndl, 10.0) * vCol.a * 0.06;

  gl_FragColor = vec4(base, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = a;
}
`;

export class DecalPool {
  readonly mesh: THREE.Mesh;

  private cap: number;
  private head = 0;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aSRT: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aAge: THREE.InstancedBufferAttribute;
  private expiry: Float32Array;
  private time = 0;
  private dirtyLo: number;
  private dirtyHi = -1;
  /** UV rects per tile are folded into the geometry UVs at draw time by the shader. */
  private atlasDim = DECAL_ATLAS_DIM;

  constructor(atlas: THREE.Texture, height: HeightTexture, capacity: number) {
    this.cap = capacity;
    this.dirtyLo = capacity;
    this.expiry = new Float32Array(capacity);

    // 4×4 patch: enough to drape over a 3 m slope without faceting.
    const src = new THREE.PlaneGeometry(1, 1, 3, 3);
    src.rotateX(-Math.PI / 2);

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', (src.attributes.position as THREE.BufferAttribute).clone());
    this.geo.setAttribute('uv', (src.attributes.uv as THREE.BufferAttribute).clone());
    this.geo.setIndex((src.index as THREE.BufferAttribute).clone());

    const inst = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = inst(3);
    this.aSRT = inst(4);
    this.aCol = inst(4);
    this.aAge = inst(2);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aSizeRotTile', this.aSRT);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aAge', this.aAge);
    this.geo.instanceCount = capacity;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: atlas },
        uAtlasDim: { value: this.atlasDim },
        uSun: { value: new THREE.Vector3(0.4, 0.7, -0.6) },
        uSunColour: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0.2, 0.25, 0.33) },
        uHeightTex: { value: height.texture },
        uHeightInfo: { value: new THREE.Vector3(height.min, height.range, height.res) },
        uHeightHalf: { value: height.halfExtent },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vfx-decals';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    src.dispose();
  }

  /**
   * Place a decal. `sizeX`/`sizeZ` are metres, `rotation` radians about the vertical.
   * The tile index rides in `aSizeRotTile.w` and is resolved to an atlas UV window in
   * the vertex shader, so every decal kind shares one draw call.
   */
  add(
    x: number,
    z: number,
    sizeX: number,
    sizeZ: number,
    rotation: number,
    tile: number,
    r: number,
    g: number,
    b: number,
    a: number,
    life: number
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;

    this.aPos.array[i * 3] = x;
    this.aPos.array[i * 3 + 1] = 0;
    this.aPos.array[i * 3 + 2] = z;

    const o = i * 4;
    this.aSRT.array[o] = sizeX;
    this.aSRT.array[o + 1] = sizeZ;
    this.aSRT.array[o + 2] = rotation;
    this.aSRT.array[o + 3] = tile;

    this.aCol.array[o] = r;
    this.aCol.array[o + 1] = g;
    this.aCol.array[o + 2] = b;
    this.aCol.array[o + 3] = a;

    this.aAge.array[i * 2] = this.time;
    this.aAge.array[i * 2 + 1] = life;
    this.expiry[i] = this.time + life;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  advance(dt: number): void {
    this.time += dt;
  }

  flush(sun: THREE.Vector3, sunColour: THREE.Color, ambient: THREE.Color): void {
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    (u.uSun.value as THREE.Vector3).copy(sun);
    (u.uSunColour.value as THREE.Color).copy(sunColour);
    (u.uAmbient.value as THREE.Color).copy(ambient);

    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo;
      const n = this.dirtyHi - lo + 1;
      const partial = n < this.cap * 0.6;
      const attrs: THREE.InstancedBufferAttribute[] = [this.aPos, this.aSRT, this.aCol, this.aAge];
      for (const a of attrs) {
        a.clearUpdateRanges();
        if (partial) a.addUpdateRange(lo * a.itemSize, n * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirtyLo = this.cap;
      this.dirtyHi = -1;
    }
  }

  liveCount(): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.expiry[i] > this.time) n++;
    return n;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
