import * as THREE from 'three';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import { DECAL_ATLAS_DIM } from './atlas';

/**
 * Persistent ground damage as a virtual texture.
 *
 * A pooled decal list can never express what a two-hour battle does to a field: the
 * churned strip where two lines ground against each other, the wide fan of trampled
 * earth behind a cavalry charge, blood soaked into a hundred square metres. Those are
 * *accumulations*, not objects, so they live in an accumulation buffer instead.
 *
 * One RGBA8 render target covers the fighting ground. Splats are additively rendered
 * into it — one instanced draw per frame, offscreen, before the frame's draw counter is
 * reset, so it costs nothing against the visible draw budget. Channels:
 *
 *   R  blood soaked into the soil
 *   G  trampled / churned earth
 *   B  scorch and soot
 *   A  total coverage, used as the composite opacity
 *
 * The buffer is never cleared, so damage is permanent for the whole battle: the
 * aftermath read comes for free, and the cost is a fixed 4 MB and one draw call.
 *
 * It is displayed by a single ground-conforming overlay mesh. At ~1 m per texel the
 * buffer alone would look like a blurry stain, so the overlay shader breaks it up with
 * tiling detail noise and warps the lookup slightly — the same trick a virtual-texture
 * terrain uses to make a low-resolution splat map read at close range.
 */

export enum DamageChannel {
  Blood = 0,
  Trample = 1,
  Scorch = 2,
}

const SPLAT_VERT = /* glsl */ `
precision highp float;
attribute vec2 aXY;
attribute vec2 aSize;
attribute vec2 aRotTile;
attribute vec4 aAmt;
varying vec2 vUv;
varying vec4 vAmt;
varying float vTile;
void main() {
  float c = cos(aRotTile.x);
  float s = sin(aRotTile.x);
  vec2 q = position.xy * aSize;
  vec2 p = aXY + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  vUv = uv;
  vAmt = aAmt;
  vTile = aRotTile.y;
  gl_Position = projectionMatrix * vec4(p, 0.0, 1.0);
}
`;

const SPLAT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform float uAtlasDim;
varying vec2 vUv;
varying vec4 vAmt;
varying float vTile;
void main() {
  float col = mod(vTile, uAtlasDim);
  float row = floor(vTile / uAtlasDim);
  vec2 uvA = (vec2(col, row) + vUv) / uAtlasDim;
  float m = texture2D(uAtlas, uvA).a;
  gl_FragColor = vAmt * m;
}
`;

const SHOW_VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vNormal = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHOW_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uDamage;
uniform sampler2D uNoise;
uniform vec3 uSun;
uniform vec3 uSunColour;
uniform vec3 uAmbient;
uniform float uFade;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  // Cheap conservative reject first. This layer spans the whole fighting ground, so on
  // most frames the majority of its fragments are over untouched turf; paying for four
  // texture fetches before finding that out is the difference between 0.2 ms and 2 ms.
  vec4 d0 = texture2D(uDamage, vUv);
  if (d0.r + d0.g + d0.b < 0.004) discard;

  // Three decorrelated noise lookups on incommensurate, rotated bases. Axis-aligned
  // lookups at a single scale make the tiling read as a lattice, which is exactly what
  // a virtual-texture ground layer must never do.
  vec2 rot = vec2(vWorld.x * 0.8763 - vWorld.z * 0.4817, vWorld.x * 0.4817 + vWorld.z * 0.8763);
  vec4 nBig = texture2D(uNoise, vWorld.xz * 0.0137);
  vec4 nMid = texture2D(uNoise, rot * 0.0731);
  vec4 nFine = texture2D(uNoise, rot.yx * 0.317);

  vec2 warp = (vec2(nBig.r, nMid.g) - 0.5) * 0.0026;
  vec4 d = texture2D(uDamage, vUv + warp);

  // Gentle modulation only: heavy grain turns broad staining into leopard spots.
  float grain = 0.74 + 0.52 * (nFine.r * 0.5 + nMid.g * 0.3 + nBig.g * 0.2);

  // Blood gets a much harder break-up than trample does, and needs it. Hundreds of men
  // dying inside twenty metres saturate the channel across the whole area, and a
  // saturated flat channel composites as one continuous 40 m amoeba of solid red —
  // legible from the strategic camera as a paint spill, not as a killing ground. The
  // extra octaves at low weight put back the mottling that makes it read as soaked soil.
  float bloodGrain = 0.30 + 1.28 * (nFine.g * 0.42 + nMid.b * 0.34 + nBig.r * 0.24);
  float blood = d.r * bloodGrain;
  float tramp = d.g * (0.78 + 0.42 * nMid.r);
  float scorch = d.b * grain;

  float wB = blood * 2.3;
  float wT = tramp * 1.6;
  float wS = scorch * 2.0;
  float total = wB + wT + wS;
  if (total < 0.010) discard;

  // Oxidised blood on soil: dark maroon-brown, deepening where it has pooled. It must
  // *stay red* at saturation — taken all the way to near-black it stops reading as blood
  // and reads as a hole in the terrain, which is worse than not being there.
  vec3 bloodCol = mix(vec3(0.105, 0.041, 0.031), vec3(0.052, 0.023, 0.019), clamp(blood * 1.1, 0.0, 1.0));
  // Churned earth, not soot: a dry brown that reads as exposed subsoil.
  vec3 trampCol = vec3(0.215, 0.168, 0.116) * (0.82 + 0.36 * nFine.g);
  vec3 scorchCol = vec3(0.026, 0.022, 0.020);

  vec3 c = (bloodCol * wB + trampCol * wT + scorchCol * wS) / max(total, 1e-4);
  float a = clamp(1.0 - exp(-total * 1.15), 0.0, 0.94) * uFade;

  // Sit inside the scene lighting; an unlit decal floats off the ground instantly.
  vec3 nrm = normalize(vNormal);
  float ndl = clamp(dot(nrm, uSun), 0.0, 1.0);
  vec3 lit = uAmbient * 0.55 + uSunColour * ndl * 0.95;
  c *= lit;

  // A wet sheen on fresh, heavy blood — the one specular note on the ground.
  float wet = clamp(blood * 1.7 - 0.35, 0.0, 1.0);
  c += uSunColour * pow(ndl, 8.0) * wet * 0.10;

  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = a;
}
`;

export class GroundDamageLayer {
  /** Side length in metres of the square the buffer covers. */
  readonly extent: number;
  readonly centreX: number;
  readonly centreZ: number;

  readonly mesh: THREE.Mesh;

  private rt: THREE.WebGLRenderTarget;
  private splatScene = new THREE.Scene();
  private splatCam: THREE.OrthographicCamera;
  private splatMesh: THREE.Mesh;
  private splatGeo: THREE.InstancedBufferGeometry;
  private aXY: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aRotTile: THREE.InstancedBufferAttribute;
  private aAmt: THREE.InstancedBufferAttribute;
  private showMat: THREE.ShaderMaterial;
  private pending = 0;
  /**
   * One frame's splat budget. A mass rout drains hundreds of queued corpse pools in a
   * single frame — four splats each — so a small cap silently throws away exactly the
   * blood that the aftermath shot is supposed to show. 1024 instances of 10 floats is
   * 40 KB and still one draw call.
   */
  private readonly maxSplats = 1024;
  private cleared = false;
  private totalSplats = 0;

  constructor(
    decalAtlas: THREE.Texture,
    noise: THREE.Texture,
    terrain: TerrainSystem | undefined,
    opts: { extent: number; centreX: number; centreZ: number; resolution: number; segments: number }
  ) {
    this.extent = opts.extent;
    this.centreX = opts.centreX;
    this.centreZ = opts.centreZ;

    this.rt = new THREE.WebGLRenderTarget(opts.resolution, opts.resolution, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;

    // ---- Splat pass ----
    const h = this.extent * 0.5;
    this.splatCam = new THREE.OrthographicCamera(-h, h, h, -h, -1, 1);
    this.splatCam.position.set(0, 0, 0);
    this.splatCam.updateProjectionMatrix();

    this.splatGeo = new THREE.InstancedBufferGeometry();
    this.splatGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    this.splatGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    this.splatGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const inst = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.maxSplats * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aXY = inst(2);
    this.aSize = inst(2);
    this.aRotTile = inst(2);
    this.aAmt = inst(4);
    this.splatGeo.setAttribute('aXY', this.aXY);
    this.splatGeo.setAttribute('aSize', this.aSize);
    this.splatGeo.setAttribute('aRotTile', this.aRotTile);
    this.splatGeo.setAttribute('aAmt', this.aAmt);
    this.splatGeo.instanceCount = 0;
    this.splatGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const splatMat = new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      uniforms: {
        uAtlas: { value: decalAtlas },
        uAtlasDim: { value: DECAL_ATLAS_DIM },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.splatMesh = new THREE.Mesh(this.splatGeo, splatMat);
    this.splatMesh.frustumCulled = false;
    this.splatScene.add(this.splatMesh);

    // ---- Display overlay ----
    const seg = opts.segments;
    const geo = new THREE.PlaneGeometry(this.extent, this.extent, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    // Bake terrain height and normal. 12 cm of lift clears the terrain mesh's own
    // triangle sag (< 3 cm on this heightfield) without reading as a floating sheet.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + this.centreX;
      const z = pos.getZ(i) + this.centreZ;
      pos.setX(i, x);
      pos.setZ(i, z);
      pos.setY(i, (terrain?.heightAt(x, z) ?? 0) + 0.12);
      if (terrain) {
        terrain.normalAt(x, z, tmp);
        nrm.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    geo.computeBoundingSphere();

    this.showMat = new THREE.ShaderMaterial({
      vertexShader: SHOW_VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        uDamage: { value: this.rt.texture },
        uNoise: { value: noise },
        uSun: { value: new THREE.Vector3(0.4, 0.7, -0.6) },
        uSunColour: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0.2, 0.25, 0.33) },
        uFade: { value: 1 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geo, this.showMat);
    this.mesh.name = 'vfx-ground-damage';
    this.mesh.renderOrder = 1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /**
   * Queue a splat. `strength` is the amount added to the channel in 0..1, before the
   * brush texture's own falloff.
   */
  splat(
    x: number,
    z: number,
    radius: number,
    tile: number,
    rotation: number,
    blood: number,
    trample: number,
    scorch: number,
    aspect = 1
  ): void {
    if (this.pending >= this.maxSplats) return;
    const dx = x - this.centreX;
    const dz = z - this.centreZ;
    const h = this.extent * 0.5;
    if (dx < -h || dx > h || dz < -h || dz > h) return;

    const i = this.pending++;
    this.totalSplats++;
    this.aXY.array[i * 2] = dx;
    this.aXY.array[i * 2 + 1] = dz;
    this.aSize.array[i * 2] = radius * 2 * aspect;
    this.aSize.array[i * 2 + 1] = radius * 2;
    this.aRotTile.array[i * 2] = rotation;
    this.aRotTile.array[i * 2 + 1] = tile;
    const o = i * 4;
    this.aAmt.array[o] = blood;
    this.aAmt.array[o + 1] = trample;
    this.aAmt.array[o + 2] = scorch;
    // Coverage grows with whatever was added; used as the composite opacity.
    this.aAmt.array[o + 3] = Math.max(blood, Math.max(trample, scorch));
  }

  /**
   * Render queued splats into the accumulation buffer. Must be called from
   * `preRender`, before the engine resets its draw counters, so the offscreen pass is
   * not charged against the frame's visible draw budget.
   */
  commit(renderer: THREE.WebGLRenderer): void {
    if (!this.cleared) {
      const prevTarget = renderer.getRenderTarget();
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(0x000000, 1);
      this.cleared = true;
    }
    if (this.pending === 0) return;

    this.splatGeo.instanceCount = this.pending;
    for (const a of [this.aXY, this.aSize, this.aRotTile, this.aAmt]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.pending * a.itemSize);
      a.needsUpdate = true;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.splatScene, this.splatCam);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;

    this.pending = 0;
  }

  /** Refresh the lighting uniforms so the layer tracks the sun. */
  setLighting(sun: THREE.Vector3, sunColour: THREE.Color, ambient: THREE.Color): void {
    (this.showMat.uniforms.uSun.value as THREE.Vector3).copy(sun);
    (this.showMat.uniforms.uSunColour.value as THREE.Color).copy(sunColour);
    (this.showMat.uniforms.uAmbient.value as THREE.Color).copy(ambient);
  }

  setFade(f: number): void {
    this.showMat.uniforms.uFade.value = f;
  }

  get splatCount(): number {
    return this.totalSplats;
  }

  dispose(): void {
    this.rt.dispose();
    this.splatGeo.dispose();
    (this.splatMesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
    this.showMat.dispose();
  }
}
