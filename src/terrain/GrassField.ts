import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import { generateGrassCards } from './proctex';
import { HALF_EXTENT, WATER_LEVEL, TOPO_GLSL } from './topography';
import type { TerrainSystem } from './TerrainSystem';

/**
 * Ground cover.
 *
 * Two instanced rings, each one draw call, each with its instance positions generated
 * entirely in the vertex shader from `gl_InstanceID`. There are no per-instance buffers
 * and nothing is uploaded when the camera moves: instance *i* maps to a cell of a
 * jittered lattice in world space, and the lattice is addressed relative to a
 * camera-snapped origin, so the ring recycles around the camera for the cost of a
 * two-float uniform.
 *
 * Each instance is a pair of crossed alpha cards carrying about a dozen painted blades.
 * Strip geometry per blade cannot reach pasture density — a real sward is hundreds of
 * blades per square metre — so a card buys twelve blades for two triangles, and the
 * cross gives it a silhouette from any bearing.
 *
 * Whether an instance exists at all is decided in the vertex shader from the same inputs
 * the ground material splats with — slope, wetness, trampling, the road mask, height
 * above the river — so grass only grows where the splat map says grass. Rejected clumps
 * are scaled to zero, which costs a degenerate triangle and no fill.
 *
 * Clumps fade by shrinking rather than by popping, and their colour converges on the
 * ground colour as they shrink, so there is no ring of density at the cut-off.
 */

/**
 * Ring extents. A ring's fade-out distance must sit *inside* half its lattice extent, or
 * the lattice runs out before the fade does and the grass stops at a hard circular edge.
 *   near: 280 × 0.335 m = 94 m across, so ±47 m — fade out by 46 m.
 *   far:  300 × 1.35 m  = 405 m across, so ±202 m — fade out by 195 m.
 *
 * The near lattice was 0.55 m, which gave at most three clumps per square metre before
 * the cover test thinned it, and at eye level that reads as a scatter of individual
 * tussocks standing in bare earth rather than as ground cover. 0.335 m is 8.9 candidate
 * clumps per m², which with a 0.58 m card is enough overlap that neighbouring clumps
 * merge into a continuous mass — the state real Rome II frames are in, where a man's
 * shins disappear into the sward.
 */
const NEAR_GRID = 280;
const NEAR_SPACING = 0.335;
const FAR_GRID = 300;
const FAR_SPACING = 1.35;

interface Ring {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  uniforms: Record<string, THREE.IUniform>;
  spacing: number;
}

/**
 * One card: a vertical strip of `segments` quads so the wind can curve it. `aBlade`
 * carries (t along the card, side) for the bend and the root shading.
 */
function cardGeometry(segments: number, width: number, height: number): THREE.BufferGeometry {
  const rows = segments + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const nor = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const blade = new Float32Array(rows * 2 * 2);
  for (let r = 0; r < rows; r++) {
    const t = r / segments;
    for (let s = 0; s < 2; s++) {
      const i = r * 2 + s;
      pos[i * 3] = (s === 0 ? -0.5 : 0.5) * width;
      pos[i * 3 + 1] = t * height;
      pos[i * 3 + 2] = 0;
      // Normals point up and slightly outward. A true face normal makes a field of cards
      // flicker between lit and unlit as the camera turns; a soft upward normal lights
      // the mass the way a sward actually behaves.
      nor[i * 3] = (s === 0 ? -0.24 : 0.24);
      nor[i * 3 + 1] = 0.95;
      nor[i * 3 + 2] = 0.19;
      uv[i * 2] = s;
      uv[i * 2 + 1] = t;
      blade[i * 2] = t;
      blade[i * 2 + 1] = s === 0 ? -1 : 1;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < segments; r++) {
    const a = r * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aBlade', new THREE.BufferAttribute(blade, 2));
  geo.setIndex(idx);
  return geo;
}

/** `count` cards crossed about the vertical axis. */
function crossedCards(count: number, segments: number, width: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < count; k++) {
    const g = cardGeometry(segments, width, height);
    g.rotateY((k / count) * Math.PI);
    parts.push(g);
  }
  return mergeCards(parts);
}

/** Minimal geometry merge for the two static pieces this module builds. */
function mergeCards(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    vCount += p.attributes.position.count;
    iCount += p.index ? p.index.count : 0;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const blade = new Float32Array(vCount * 2);
  const idx = new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.attributes.normal.array as Float32Array, vo * 3);
    uv.set(p.attributes.uv.array as Float32Array, vo * 2);
    blade.set(p.attributes.aBlade.array as Float32Array, vo * 2);
    const pi = p.index!.array;
    for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
    vo += p.attributes.position.count;
    io += pi.length;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aBlade', new THREE.BufferAttribute(blade, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

const GRASS_GLSL = /* glsl */ `
attribute vec2 aBlade;
uniform sampler2D uHeightMap;
uniform sampler2D uControl;
uniform float uHalfExtent;
uniform float uHeightSpacing;
uniform vec2 uCentre;
uniform vec2 uCamXZ;
uniform float uSpacing;
uniform float uGrid;
uniform float uJitter;
uniform float uDensity;
uniform float uFadeIn;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uHeightScale;
uniform float uWeeds;
uniform float uCards;
uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uDryColour;
uniform vec3 uWetColour;
uniform vec3 uGroundColour;
varying float vBladeT;

${TOPO_GLSL}

float grassHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float grassHeightAt(vec2 wxz) {
  vec2 uv = (wxz + uHalfExtent) / (2.0 * uHalfExtent);
  return texture2D(uHeightMap, clamp(uv, 0.0, 1.0)).r;
}

// The centuriated field lattice, kept numerically identical to fieldPattern() in
// TerrainMaterial.ts — including its exact, undisplaced 94 m cells and its boundary
// convention (1 *on* a field line, 0 in the middle of a strip). The ground shader paints
// the fallow strips as bare earth and the field lines as beaten track; grass has to agree
// about where those are, or it grows a lush sward straight out of a ploughed field, which
// is the fastest way to break the illusion that the two systems are looking at the same
// landscape.
//
// Returns:
//   x  the raw strip use hash — the same value the ground shader feeds into its straw /
//      pasture mix, so a clump growing on a straw strip can be tinted straw
//   y  boundary proximity, 1 on a field line
//   z  the decorrelated fallow hash — which strips are ploughed to bare earth
vec3 grassField(vec2 wxz) {
  vec2 fu = vec2(wxz.x * 0.97740 - wxz.y * 0.21140, wxz.x * 0.21140 + wxz.y * 0.97740) / 94.0;
  vec2 cell = floor(fu);
  vec2 f = fract(fu);
  float h = fract(sin(dot(cell, vec2(41.317, 78.233))) * 43758.5453);
  float strips = 2.0 + floor(fract(sin(dot(cell + 17.0, vec2(41.317, 78.233))) * 43758.5453) * 2.5);
  float sub = floor(f.y * strips);
  float use = fract(h + sub * 0.3719 + fract(sin(dot(cell + 41.0, vec2(41.317, 78.233))) * 43758.5453) * 0.21);
  vec2 e = abs(f - 0.5);
  float edge = max(max(e.x, e.y), abs(fract(f.y * strips) - 0.5));
  return vec3(use, smoothstep(0.40, 0.496, edge), fract(use * 3.71 + h * 0.613));
}
`;

export class GrassField {
  private rings: Ring[] = [];
  private time = 0;
  private cardTex?: THREE.DataTexture;

  constructor(private readonly terrain: TerrainSystem) {}

  init(ctx: EngineContext, heightMap: THREE.Texture, controlMap: THREE.Texture): void {
    const density = Math.max(0, ctx.quality.grassDensity);
    if (density <= 0.001) return;

    const cards = generateGrassCards(256, 3);
    const tex = new THREE.DataTexture(cards.data, cards.width, cards.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.cardTex = tex;

    this.rings.push(
      this.makeRing(ctx, heightMap, controlMap, tex, {
        // Three cards at 60° rather than two at 90°: a two-card cross has a bearing from
        // which it reads as a single flat plane, and at this density that shows up as
        // corduroy banding across the sward.
        // 0.54 m is the *tallest* a clump can be, not the height of the sward: the two
        // height populations in the vertex shader put the general mat at 0.32–0.40 m and
        // only a fifth of clumps near this bound. Rome II's pasture reaches a man's
        // mid-calf and in places swallows his shins, which is where the mat sits; running
        // every clump at that height made the grass the subject of the frame.
        geo: crossedCards(3, 2, 0.58, 0.54),
        grid: NEAR_GRID,
        spacing: NEAR_SPACING,
        // Jitter over 1 means a clump can leave its own cell. Below that the lattice stays
        // readable as rows and files across the sward, which at this density was the
        // clearest remaining tell that the ground cover is a shader and not a field.
        jitter: 1.9,
        fadeIn: 0,
        fadeStart: 32,
        fadeEnd: 46,
        heightScale: 1,
        weeds: true,
        cards: 3,
        density,
        name: 'grass-near',
      })
    );
    this.rings.push(
      this.makeRing(ctx, heightMap, controlMap, tex, {
        geo: crossedCards(2, 1, 1.7, 0.50),
        grid: FAR_GRID,
        spacing: FAR_SPACING,
        jitter: 1.05,
        // Fades in where the near ring fades out, so neither ring is ever the only
        // cover and the hand-off leaves no ring of density on the ground.
        fadeIn: 12,
        fadeStart: 136,
        fadeEnd: 195,
        heightScale: 1.2,
        weeds: false,
        cards: 3,
        density: Math.min(1.1, density),
        name: 'grass-far',
      })
    );
  }

  private makeRing(
    ctx: EngineContext,
    heightMap: THREE.Texture,
    controlMap: THREE.Texture,
    cardTex: THREE.Texture,
    opt: {
      geo: THREE.BufferGeometry;
      grid: number;
      spacing: number;
      jitter: number;
      fadeIn: number;
      fadeStart: number;
      fadeEnd: number;
      heightScale: number;
      weeds: boolean;
      cards: number;
      density: number;
      name: string;
    }
  ): Ring {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = opt.geo.index;
    for (const key of Object.keys(opt.geo.attributes)) {
      geo.setAttribute(key, opt.geo.attributes[key]);
    }
    geo.instanceCount = opt.grid * opt.grid;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const uniforms: Record<string, THREE.IUniform> = {
      uHeightMap: { value: heightMap },
      uControl: { value: controlMap },
      uHalfExtent: { value: HALF_EXTENT },
      uHeightSpacing: { value: this.terrain.heightField.spacing },
      uCentre: { value: new THREE.Vector2() },
      uCamXZ: { value: new THREE.Vector2() },
      uSpacing: { value: opt.spacing },
      uGrid: { value: opt.grid },
      uJitter: { value: opt.jitter },
      uDensity: { value: opt.density },
      uFadeIn: { value: opt.fadeIn },
      uFadeStart: { value: opt.fadeStart },
      uFadeEnd: { value: opt.fadeEnd },
      uHeightScale: { value: opt.heightScale },
      uWeeds: { value: opt.weeds ? 1 : 0 },
      uCards: { value: opt.cards },
      uTime: { value: 0 },
      uWaterLevel: { value: WATER_LEVEL },
      // These are *tints* multiplied into the card texture, not colours: the card is
      // already painted green, so a colour here would darken it twice over. The dry end
      // pulls toward straw and the wet end toward chlorophyll; the card's own mean sits
      // between them.
      uDryColour: { value: new THREE.Color(1.24, 1.06, 0.62) },
      uWetColour: { value: new THREE.Color(0.78, 1.1, 0.56) },
      uGroundColour: { value: new THREE.Color(0.98, 0.98, 0.86) },
    };

    const mat = new THREE.MeshStandardMaterial({
      map: cardTex,
      alphaTest: 0.34,
      roughness: 0.88,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GRASS_GLSL}`)
        .replace(
          '#include <color_vertex>',
          /* glsl */ `
  // --- instance placement ------------------------------------------------
  float gi = float(gl_InstanceID);
  float gx = mod(gi, uGrid);
  float gz = floor(gi / uGrid);
  vec2 cell = uCentre + (vec2(gx, gz) - uGrid * 0.5) * uSpacing;
  // Hash from the world cell index, so the jitter is fixed to the ground and the field
  // does not crawl when the ring recentres.
  vec2 ci = floor(cell / uSpacing + 0.5);
  float h1 = grassHash(ci);
  float h2 = grassHash(ci + vec2(37.1, 11.7));
  float h3 = grassHash(ci + vec2(5.3, 91.2));
  vec2 gpos = cell + (vec2(h1, h2) - 0.5) * uSpacing * uJitter;

  float gh = grassHeightAt(gpos);
  float e = uHeightSpacing;
  float sl = length(vec2(
    grassHeightAt(gpos + vec2(e, 0.0)) - grassHeightAt(gpos - vec2(e, 0.0)),
    grassHeightAt(gpos + vec2(0.0, e)) - grassHeightAt(gpos - vec2(0.0, e))
  )) / (2.0 * e);

  vec4 gctl = texture2D(uControl, clamp((gpos + uHalfExtent) / (2.0 * uHalfExtent), 0.0, 1.0));
  float roadD = abs(gpos.x - topoRoadCentreX(gpos.y));
  float paved = 1.0 - smoothstep(3.0, 7.5, roadD);

  // Grass grows on gentle, untrampled, unpaved ground above the water line, and thins
  // out where the splat map is turning to mud or bare rock.
  float cover = (1.0 - smoothstep(0.26, 0.52, sl))
              * (1.0 - paved * 0.95)
              // Trampling *shortens* the sward — see trodden, below — far more than it
              // thins it. Men standing in ranks beat grass down and wear scrapes between
              // the files; they do not shave it. 0.9 here left the whole parade ground bald,
              // and even 0.55 opened the mat into sparse stubble once height came down too.
              * (1.0 - gctl.b * 0.34)
              * (1.0 - gctl.g * 0.85)
              * (1.0 - smoothstep(0.74, 0.99, gctl.r) * 0.7)
              * step(uWaterLevel + 0.35, gh);
  // Real pasture grows in patches: bare scrapes, thick tussocky ground, and everything
  // between. Two scales of clustering noise, and damp ground grows thicker.
  float clumpBig = grassHash(floor(gpos / 19.0)) * 0.5 + grassHash(floor(gpos / 6.5)) * 0.5;
  cover *= 0.72 + 0.95 * clumpBig + gctl.r * 0.4;
  // Ploughed and fallow strips carry no sward, and the headland the carts turned on is
  // beaten down to half. Matches the ground shader's own field pattern.
  // Matches the ground shader, including its campus suppression: the fighting ground is
  // pasture, so a fallow strip there must not strip the sward off it either.
  vec3 gfld = grassField(gpos);
  float gCampus = 1.0 - smoothstep(420.0, 800.0, length(vec2(gpos.x * 0.86, (gpos.y + 40.0) * 1.9)));
  cover *= 1.0 - smoothstep(0.66, 0.79, gfld.z) * 0.88 * (1.0 - gCampus * 0.88);
  cover *= 1.0 - gfld.y * 0.55 * (1.0 - gCampus * 0.55);
  // The ground shader's own straw / pasture threshold, so a clump standing on a straw strip
  // is straw and one standing on pasture is green. Without this the two systems disagree
  // about the same field and green tufts sprout out of dry stubble.
  float gStraw = smoothstep(0.42, 0.64, gfld.x * 0.62 + 0.19);

  float dist = length(gpos - uCamXZ);
  float fadeNear = uFadeIn < 0.5 ? 1.0 : smoothstep(uFadeIn, uFadeIn + 30.0, dist);
  float fade = (1.0 - smoothstep(uFadeStart, uFadeEnd, dist)) * fadeNear;
  float keep = step(h3, cover * uDensity);
  // One clump in twelve is a thistle or a stand of dead grass: taller and straw
  // coloured. Ground cover that is all one plant is the giveaway of a shader field.
  float weed = uWeeds * step(0.918, h2);

  // Height and width are scaled *separately*, and height has two populations.
  //
  // Grazed pasture is short — ankle deep — with a scatter of taller tussocks the sheep
  // missed. One uniform height reads as a wheat field, and at a four-metre camera half a
  // metre of card occludes everything behind it for tens of metres: it buried the Roman
  // front rank in its own grass and made the ground the subject of the frame instead of the
  // army. Width stays nearly constant so a short clump still spreads into its neighbours
  // and the mat does not open up into gaps as the sward gets shorter.
  float hPop = step(0.80, fract(h1 * 7.31 + h3 * 3.17));
  float hVar = mix(0.60 + h1 * 0.14, 0.98 + h1 * 0.20, hPop);
  // Trampling shortens the sward far harder than it thins it. Ground five thousand men have
  // been standing on is beaten flat — which is both what actually happens and what lets the
  // men read against it.
  float trodden = 1.0 - smoothstep(0.05, 0.32, gctl.b) * 0.45;
  float wScale = keep * fade * (0.88 + 0.30 * h1);
  float hScale = keep * fade * hVar * trodden * uHeightScale * (1.0 + weed * 0.8);

  // --- card shape and wind ----------------------------------------------
  float bt = aBlade.x;
  vec3 local = position;
  float yaw = h1 * 6.2831853;
  float cs = cos(yaw); float sn = sin(yaw);
  local = vec3(local.x * cs - local.z * sn, local.y, local.x * sn + local.z * cs);

  // Two frequencies: a slow gust field travelling across the map, and a faster
  // per-clump flutter phased by the instance hash so no two move together.
  float gust = sin(uTime * 0.42 + gpos.x * 0.031 + gpos.y * 0.021) * 0.5 + 0.5;
  float phase = h1 * 6.2831853;
  float flutter = sin(uTime * 1.9 + phase) * 0.6 + sin(uTime * 3.4 + phase * 1.7) * 0.3;
  float bend = (0.35 + 0.9 * gust) * flutter * bt * bt;
  vec2 windDir = normalize(vec2(0.82, 0.57));
  local.xz += windDir * bend * 0.16;
  local.y -= abs(bend) * 0.04;

  vec3 gWorld = vec3(gpos.x, gh, gpos.y) + local * vec3(wScale, hScale, wScale);
  vBladeT = bt;

  // Darker at the root, and converging on the ground colour as the clump shrinks away,
  // so the cut-off leaves no visible ring of density. Biased toward the green end: the
  // straw tint is the minority state, matching the ground shader's own grass mix.
  vec3 gcol = mix(uDryColour, uWetColour,
    clamp(0.62 + gctl.r * 1.1 + (h2 - 0.5) * 0.8 - gStraw * 0.85, 0.0, 1.0));
  gcol = mix(gcol, uDryColour * 1.2, weed);
  gcol *= 0.74 + 0.34 * bt;
  gcol = mix(uGroundColour, gcol, clamp(fade * 1.6, 0.0, 1.0));
  vColor = vec4(gcol, 1.0);

  // Pick one of the card variants per clump so the field is not one image stamped
  // everywhere. Overrides the UV that <uv_vertex> set a few lines earlier.
  vMapUv = vec2((uv.x + floor(h2 * uCards)) / uCards, uv.y);
`
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gWorld;')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBladeT;')
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
  // Cards are double-sided so a clump reads from any bearing, but the default
  // DOUBLE_SIDED handling flips the normal on back faces, which points half of every
  // clump at the ground and renders it black. Grass is a translucent mass, not a solid
  // surface: keep the upward normal on both faces.
  normal = normalize(vNormal);
  nonPerturbedNormal = normal;`
        )
        // A little translucency: grass lit from behind glows rather than going black.
        .replace(
          '#include <emissivemap_fragment>',
          'totalEmissiveRadiance += diffuseColor.rgb * 0.2 * vBladeT;'
        );
    };
    mat.customProgramCacheKey = () => 'terrain-grass-cards-v1';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = opt.name;
    // Always centred on the camera, so culling it would be wrong as well as pointless.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    ctx.scene.add(mesh);

    return { mesh, geo, uniforms, spacing: opt.spacing };
  }

  update(dt: number): void {
    this.time += dt;
    for (const r of this.rings) r.uniforms.uTime.value = this.time;
  }

  preRender(ctx: EngineContext): void {
    const cam = ctx.camera.position;
    for (const r of this.rings) {
      // Snap the lattice origin to its own spacing so clumps stay welded to the ground.
      const cx = Math.round(cam.x / r.spacing) * r.spacing;
      const cz = Math.round(cam.z / r.spacing) * r.spacing;
      (r.uniforms.uCentre.value as THREE.Vector2).set(cx, cz);
      (r.uniforms.uCamXZ.value as THREE.Vector2).set(cam.x, cam.z);
    }
  }

  dispose(): void {
    for (const r of this.rings) {
      r.mesh.parent?.remove(r.mesh);
      (r.mesh.material as THREE.Material).dispose();
      r.geo.dispose();
    }
    this.rings.length = 0;
    this.cardTex?.dispose();
  }
}
