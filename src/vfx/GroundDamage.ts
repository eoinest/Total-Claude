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

/**
 * Damage overlay: injected into a `MeshStandardMaterial` rather than shipped as a
 * `ShaderMaterial`.
 *
 * **This layer used to be the reason half the army had no shadow.** It was a raw
 * `ShaderMaterial` with its own hand-rolled lambert — `uAmbient * 0.55 + uSunColour * ndl` —
 * which has no shadow term in it at all, drawn *over* a terrain that receives shadows
 * correctly, at up to 0.96 alpha. So wherever men had churned the ground, the overlay painted
 * the terrain's shadow back out, and a blind critic reading `romanline` found a hard vertical
 * boundary running through the crowd with long crisp shadows on one side and none on the
 * other, exactly on the edge of the damage. It was called the most damning artefact in the set.
 *
 * A raw `ShaderMaterial` cannot receive a shadow without re-implementing the shadow pipeline by
 * hand, and here that pipeline is not the stock one: `LightingSystem` runs four cascades with a
 * custom soft-shadow tap and a cloud-transmittance term, patched into
 * `ShaderChunk.lights_fragment_begin`. Re-deriving all of that in a private shader would be
 * both a large amount of duplicated GLSL and a second thing to keep in step.
 *
 * `LightingSystem.discoverMaterials` traverses the scene every sixteen frames and calls
 * `setupMaterial` on every material whose *type* is one of the lit templates, chaining its
 * existing `onBeforeCompile` rather than replacing it. So the whole fix is to be a
 * `MeshStandardMaterial`: cascades, soft shadows, cloud shading, fog and tone mapping all
 * arrive by themselves, and the damage field below only has to supply albedo and coverage.
 *
 * The sun uniforms this used to carry are gone with the hand-rolled lighting — see
 * `setLighting`, which is now deliberately a no-op.
 */
const DAMAGE_PARS = /* glsl */ `
uniform sampler2D uDamage;
uniform sampler2D uNoise;
uniform float uFade;
/** (centreX, centreZ, extent) — must match the splat camera exactly. See uv below. */
uniform vec3 uFrame;
varying vec3 tcWorld;
`;

/**
 * Albedo and coverage for one fragment of churned, bloodied, scorched ground.
 *
 * Everything that was in the old fragment shader except the lighting, which is now the
 * template's job. Injected after `<color_fragment>`, so `diffuseColor` is the surface colour
 * the lighting model will go on to shade — which is precisely the change: the damage is now an
 * *albedo*, not a finished pixel.
 */
const DAMAGE_BODY = /* glsl */ `
  // Buffer lookup derived from world position, never from the mesh's own uv attribute.
  //
  // The splat pass writes through an orthographic camera at the buffer centre, so a splat
  // at world (x,z) lands at texture (0.5 + (x-cx)/extent, 0.5 + (z-cz)/extent). A
  // PlaneGeometry rotated -90 degrees about X has v = 0.5 - (z-cz)/extent instead, because
  // rotateX maps the plane's +Y to world -Z. Sampling with that attribute therefore
  // displayed the whole buffer mirrored about the z axis: every stain appeared 2|z| metres
  // away on the wrong side of the field, which is why a buffer holding two hundred thousand
  // splats composited as clean grass wherever anyone had actually fought. Deriving the
  // coordinate from the world position makes the two passes agree by construction.
  vec2 dUv = (tcWorld.xz - uFrame.xy) / uFrame.z + 0.5;

  // Cheap conservative reject first. This layer spans the whole fighting ground, so on
  // most frames the majority of its fragments are over untouched turf; paying for four
  // texture fetches before finding that out is the difference between 0.2 ms and 2 ms.
  vec4 d0 = texture2D(uDamage, dUv);
  if (d0.r + d0.g + d0.b < 0.004) discard;

  // Three decorrelated noise lookups on incommensurate, rotated bases. Axis-aligned
  // lookups at a single scale make the tiling read as a lattice, which is exactly what
  // a virtual-texture ground layer must never do.
  vec2 tcRot = vec2(tcWorld.x * 0.8763 - tcWorld.z * 0.4817, tcWorld.x * 0.4817 + tcWorld.z * 0.8763);
  vec4 nBig = texture2D(uNoise, tcWorld.xz * 0.0137);
  vec4 nMid = texture2D(uNoise, tcRot * 0.0731);
  vec4 nFine = texture2D(uNoise, tcRot.yx * 0.317);

  vec2 warp = (vec2(nBig.r, nMid.g) - 0.5) * 0.0026;
  vec4 d = texture2D(uDamage, dUv + warp);

  // Gentle modulation only: heavy grain turns broad staining into leopard spots.
  float grain = 0.74 + 0.52 * (nFine.r * 0.5 + nMid.g * 0.3 + nBig.g * 0.2);

  // Multi-octave field used to break the blood up. Mean ~0.5, and it has to be applied to
  // *coverage* rather than to the channel, for the reason below.
  float bMott = nFine.g * 0.42 + nMid.b * 0.34 + nBig.r * 0.24;
  float blood = d.r;
  float tramp = d.g * (0.78 + 0.42 * nMid.r);
  float scorch = d.b * grain;

  float wT = tramp * 2.4;
  float wS = scorch * 2.0;
  // Coverage, not weight: blood *soaks over* soil rather than averaging with it.
  //
  // A three-way weighted mean was the reason blood was invisible even once the buffer was
  // being read from the right place. Where hundreds of men have died the trample channel is
  // saturated too — the ground under a corpse heap has been fought over for minutes — so a
  // mean of a 0.05-luminance oxblood and a 0.21-luminance churned brown, at comparable
  // weights, lands on plain dark brown every time. Physically the blood is *on top of*
  // the churned earth and opaque where it has pooled, and compositing it that way is what
  // makes a killing ground read as a killing ground rather than as mud.
  float bCov = clamp(1.0 - exp(-blood * 2.9), 0.0, 1.0);
  // Break the *fringe* up hard and leave the pools solid.
  //
  // Modulating the channel instead would have been wrong in a way worth recording: over a
  // heap of a thousand dead the buffer is pinned at 1.0 across forty metres, so any
  // monotonic function of it is a constant and the area composites dead flat however much
  // noise is folded into the amount. The structure has to come from noise applied *after*
  // the coverage curve, weighted toward the low-accumulation fringe — which is also where
  // it belongs physically: a pool is a pool, but its margins are spatter and soaked soil
  // with churned earth still showing through.
  bCov *= mix(0.22 + 1.10 * bMott, 1.0, clamp(blood * 1.5 - 0.42, 0.0, 1.0));
  bCov = clamp(bCov, 0.0, 1.0);
  float total = wT + wS + blood * 2.4;
  if (total < 0.010) discard;

  // Oxidised blood on soil: dark maroon, deepening where it has pooled. It must *stay red*
  // at saturation — taken all the way to near-black it stops reading as blood and reads as
  // a hole in the terrain, which is worse than not being there.
  vec3 bloodCol = mix(vec3(0.118, 0.038, 0.030), vec3(0.055, 0.014, 0.013), clamp(blood * 1.1, 0.0, 1.0));
  // Churned earth, not soot: a dry brown that reads as exposed subsoil.
  vec3 trampCol = vec3(0.215, 0.168, 0.116) * (0.82 + 0.36 * nFine.g);
  vec3 scorchCol = vec3(0.026, 0.022, 0.020);

  float wSoil = wT + wS;
  vec3 soil = wSoil > 1e-4 ? (trampCol * wT + scorchCol * wS) / wSoil : trampCol;

  // These are *albedos* now, and they were authored as finished pixels under a hand-rolled
  // lambert that multiplied by roughly 0.75 in full sun. Handing the same numbers to the real
  // lighting model would render the damage about a third too dark, so they are divided back
  // out: the layer's brightness in sunlight is preserved and its brightness in shadow becomes
  // correct for the first time.
  diffuseColor.rgb = mix(soil, bloodCol, bCov) * 1.34;
  diffuseColor.a = clamp(1.0 - exp(-total * 1.15), 0.0, 0.96) * uFade;

  // Fresh blood is wet, and wet ground is smoother. The old shader faked this with an
  // explicit specular lobe; expressing it as roughness lets the standard model produce the
  // sheen, including its response to a shadow falling across the pool.
  float tcWet = clamp(blood * 1.7 - 0.35, 0.0, 1.0);
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
  private showMat: THREE.MeshStandardMaterial;
  private showUniforms!: {
    uDamage: { value: THREE.Texture };
    uNoise: { value: THREE.Texture };
    uFade: { value: number };
    uFrame: { value: THREE.Vector3 };
  };
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
    // Bake terrain height and normal.
    //
    // The lift has to beat this mesh's *own* chord sag, not the terrain mesh's. A
    // ground-conforming plane samples the heightfield only at its vertices and then
    // interpolates linearly, so across a segment of length d over ground of curvature
    // radius R it sags by roughly d²/8R below the true surface — and wherever that sag
    // exceeds the lift, the overlay is behind the terrain in depth and simply vanishes.
    // At 6.5 m segments this measured 4.7 m of sag against a 12 cm lift, which is why a
    // buffer holding two hundred thousand splats composited as nothing at all. Short
    // segments do the real work; the lift is only there for the residual.
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + this.centreX;
      const z = pos.getZ(i) + this.centreZ;
      pos.setX(i, x);
      pos.setZ(i, z);
      pos.setY(i, (terrain?.heightAt(x, z) ?? 0) + 0.24);
      if (terrain) {
        terrain.normalAt(x, z, tmp);
        nrm.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    geo.computeBoundingSphere();

    // Held on the instance because `onBeforeCompile` assigns them into the material's live
    // uniform object by reference; writing through these updates the shader without a recompile.
    this.showUniforms = {
      uDamage: { value: this.rt.texture },
      uNoise: { value: noise },
      uFade: { value: 1 },
      uFrame: { value: new THREE.Vector3(this.centreX, this.centreZ, this.extent) },
    };
    const showMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.FrontSide,
    });
    showMat.name = 'ground-damage';
    showMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.showUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 tcWorld;`)
        // `<begin_vertex>` rather than `<worldpos_vertex>`: the latter is compiled in only
        // when an envmap, a shadow map or a spot light happens to need it, so anchoring to it
        // makes the damage layer's world position depend on lighting state.
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  tcWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${DAMAGE_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${DAMAGE_BODY}`)
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.34, tcWet );'
        );
    };
    this.showMat = showMat;

    this.mesh = new THREE.Mesh(geo, this.showMat);
    this.mesh.name = 'vfx-ground-damage';
    this.mesh.renderOrder = 1;
    this.mesh.castShadow = false;
    // The whole point. A layer drawn over shadowed terrain, at up to 0.96 alpha, with no
    // shadow of its own, deletes every shadow that falls on churned ground.
    this.mesh.receiveShadow = true;
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

  /**
   * Deliberately a no-op, kept so callers do not have to care.
   *
   * The layer used to light itself from these three, which is exactly why it had no shadow:
   * a private lambert cannot know that a soldier is standing between this fragment and the
   * sun. It is a `MeshStandardMaterial` now, so the sun direction, its colour, the ambient
   * term, the four shadow cascades and the cloud transmittance all reach it through the
   * normal lighting path and none of them are this class's business any more.
   */
  setLighting(sun: THREE.Vector3, sunColour: THREE.Color, ambient: THREE.Color): void {
    void sun; void sunColour; void ambient;
  }

  setFade(f: number): void {
    this.showUniforms.uFade.value = f;
  }

  get splatCount(): number {
    return this.totalSplats;
  }

  /**
   * The accumulation buffer itself, for any system that should *react* to battle damage
   * rather than merely be overlaid by it.
   *
   * The obvious consumer is vegetation: grass that has had a cohort standing on it for two
   * minutes should be flattened and brown, and grass in a blood pool should be dark. An
   * overlay drawn on the soil can never express that, because the blades are drawn in
   * front of it. Sample as
   *
   *     vec2 uv = (worldXZ - damageCentre) / damageExtent + 0.5;
   *
   * and read `.r` for blood, `.g` for trample, `.b` for scorch, each 0..1.
   */
  get texture(): THREE.Texture {
    return this.rt.texture;
  }

  dispose(): void {
    this.rt.dispose();
    this.splatGeo.dispose();
    (this.splatMesh.material as THREE.Material).dispose();
    this.mesh.geometry.dispose();
    this.showMat.dispose();
  }
}
