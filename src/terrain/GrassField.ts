import * as THREE from 'three';
import type { EngineContext } from '../core/Engine';
import { coveragePreservingMipmaps, generateGrassCards } from './proctex';
import { HALF_EXTENT } from './topography';
import type { TerrainSystem } from './TerrainSystem';

/**
 * Alpha cutoff for the sward. Shared between the material and the mip builder: the mip
 * chain preserves coverage *at this threshold*, so the two must not drift apart.
 *
 * 0.22 rather than the 0.34 this used to be, because alpha-to-coverage changes what the
 * number means. A binary test paints every texel at or above the threshold at full
 * strength; three's alpha-to-coverage path replaces it with
 * `smoothstep(alphaTest, alphaTest + fwidth(a), a)`, whose half-coverage point sits at
 * `alphaTest + fwidth/2`. On a minified card fwidth is large, so keeping 0.34 moved the
 * effective cutoff most of the way to 0.5 and took roughly a fifth of the sward's mass
 * with it — measured as a visibly browner, thinner field. Dropping the threshold puts the
 * ramp's midpoint back where the hard cutoff used to be.
 */
const GRASS_ALPHA_TEST = 0.22;

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

const grassGlsl = (roadGlsl: string): string => /* glsl */ `
attribute vec2 aBlade;
uniform sampler2D uHeightMap;
uniform sampler2D uControl;
uniform sampler2D uMacro;
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
uniform float uDryness;
uniform vec3 uGroundColour;
varying float vBladeT;

${roadGlsl}

float grassHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * Smooth value noise on the same hash.
 *
 * The clustering that decides where the sward is thick used 'grassHash(floor(gpos / 6.5))'
 * and 'grassHash(floor(gpos / 19.0))', i.e. a *constant per square*. That is not "patches of
 * pasture": it is a chequerboard of hard-edged 6.5 m and 19 m squares of grass density with
 * an infinite gradient at every square's edge, and it is the kind of thing that reads as a
 * lattice from any camera low enough to see two squares at once. Interpolating the same
 * hashes costs three extra taps per instance in the *vertex* stage — no fragment cost at
 * all — and turns the squares into drifting patches.
 */
float grassNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(grassHash(i), grassHash(i + vec2(1.0, 0.0)), f.x),
    mix(grassHash(i + vec2(0.0, 1.0)), grassHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
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
float grassFieldHash(vec2 c) {
  return fract(sin(dot(c, vec2(41.317, 78.233))) * 43758.5453);
}

// Mirrors fieldParcel() in TerrainMaterial.ts exactly.
vec2 grassParcel(vec2 fu) {
  vec2 cell = floor(fu);
  vec2 f = fu - cell;
  float century = grassFieldHash(cell);
  float strips = 2.0 + floor(grassFieldHash(cell + 17.0) * 2.5);
  float sub = floor(f.y * strips);
  float use = fract(century + sub * 0.3719 + grassFieldHash(cell + 41.0) * 0.21);
  return vec2(use, fract(use * 3.71 + century * 0.613));
}

vec3 grassField(vec2 wxz) {
  vec2 fu = vec2(wxz.x * 0.97740 - wxz.y * 0.21140, wxz.x * 0.21140 + wxz.y * 0.97740) / 94.0;
  vec2 cell = floor(fu);
  vec2 f = fu - cell;
  float strips = 2.0 + floor(grassFieldHash(cell + 17.0) * 2.5);
  vec2 e = abs(f - 0.5);
  float es = abs(fract(f.y * strips) - 0.5);
  float edge = max(max(e.x, e.y), es);
  // The ground shader now averages land use across the nearest parcel line over a 5.2 m
  // margin. The sward has to average it the same way or the two systems disagree about
  // where a field ends, and the disagreement shows up as a green sward standing on ploughed
  // earth exactly where the boundary used to be hard.
  vec2 dir;
  if (edge == e.x) dir = vec2(sign(f.x - 0.5), 0.0);
  else if (edge == e.y) dir = vec2(0.0, sign(f.y - 0.5));
  else dir = vec2(0.0, sign(fract(f.y * strips) - 0.5) / strips);
  vec2 here = grassParcel(fu);
  vec2 there = grassParcel(fu + dir * 0.12);
  // The margin over which one parcel's land use gives way to its neighbour's. The ground
  // shader uses 0.055 of a 94 m cell — 5.2 m — which is right for a colour boundary and
  // badly wrong for the sward, because the sward's fallow threshold (see cover, below)
  // re-hardens it: crossing a 0.13-wide smoothstep inside a 5.2 m ramp puts the whole
  // transition into about 1.7 m of ground. At 150 m under a low camera 1.7 m is a pixel and
  // a half, and a line of constant parcel boundary is straight, so the sward ends at a hard
  // straight line across the frame. 0.106 is 10 m either side of the boundary — a headland
  // and its encroaching margin, which is what actually stands between a ploughed strip and
  // its neighbour.
  vec2 uses = here + smoothstep(0.394, 0.5, edge) * 0.5 * (there - here);
  return vec3(uses.x, smoothstep(0.34, 0.496, edge), uses.y);
}
`;

export class GrassField {
  private rings: Ring[] = [];
  private time = 0;
  private cardTex?: THREE.DataTexture;

  constructor(
    private readonly terrain: TerrainSystem,
    /**
     * Per-map sward character: how tall it stands, how thickly, and how far toward straw
     * the whole field is pushed. Latian pasture in November and Pierian grass on the
     * solstice are the same plant in two completely different states.
     */
    private readonly profile: {
      heightScale: number;
      densityScale: number;
      dryness: number;
      /** GLSL defining `float grassRoadCentreX(float z)` — the road the sward keeps off. */
      roadGlsl: string;
    },
    private readonly waterLevel: number,
  ) {}

  init(
    ctx: EngineContext,
    heightMap: THREE.Texture,
    controlMap: THREE.Texture,
    /** The ground material's macro-variation texture, so the sward reads the same noise. */
    macroMap: THREE.Texture,
  ): void {
    const density = Math.max(0, ctx.quality.grassDensity) * this.profile.densityScale;
    if (density <= 0.001) return;

    const cards = generateGrassCards(256, 3);
    const tex = new THREE.DataTexture(cards.data, cards.width, cards.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // A driver-generated chain box-filters alpha, which walks the mean below GRASS_ALPHA_TEST
    // and deletes the sward at whichever distance that mip level lands on — the hard line
    // across the frame. This chain holds coverage constant instead. See
    // coveragePreservingMipmaps.
    tex.mipmaps = coveragePreservingMipmaps(
      cards.data, cards.width, cards.height, GRASS_ALPHA_TEST,
    );
    tex.generateMipmaps = false;
    // Grass is seen at a grazing angle in every ground-level frame, which is precisely the
    // case isotropic mip selection handles worst: it picks the blur radius from the long
    // axis and smears the short one. Device max rather than a constant — this is a sampler
    // setting, not a memory cost.
    tex.anisotropy = ctx.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    this.cardTex = tex;

    this.rings.push(
      this.makeRing(ctx, heightMap, controlMap, macroMap, tex, {
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
        // Exactly 2.0, and the exactness is the whole point.
        //
        // Displacing a lattice by a uniform random offset does not destroy the lattice; it
        // attenuates each Bragg peak by sinc²(k·A), where A is the half-width of the offset
        // and k = 2π/spacing. That factor is zero only when A is an exact multiple of the
        // spacing — jitter 1.0, 2.0, 3.0 — and merely small in between. Measured on the real
        // placement arithmetic (tools/probe-terrain.mjs --place), with the cover test thinning
        // to 40 %:
        //
        //     jitter 1.00   S(1,0) 1.33   S(0,1) 0.45      (Poisson control 1.00)
        //     jitter 1.90   S(1,0) 11.82  S(0,1) 8.63      (control 0.43)  <- was here
        //     jitter 2.00   S(1,0) 0.22   S(0,1) 0.07      (control 0.57)
        //
        // So 1.9 left the first-order peak twenty-seven times the non-lattice background,
        // which is what "you can count the rows" is measuring. 2.0 puts it *below* the
        // background: the offset then covers exactly one period, so the clump positions are
        // uniform modulo the lattice and every order vanishes at once. Same instance count,
        // same cost, one character.
        jitter: 2.0,
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
      this.makeRing(ctx, heightMap, controlMap, macroMap, tex, {
        geo: crossedCards(2, 1, 1.7, 0.50),
        grid: FAR_GRID,
        spacing: FAR_SPACING,
        // On the null for the same reason as the near ring. 1.05 sat just off it and left
        // S(0,1) at 11.78 against a control of 1.05 — the far ring was the more visible
        // lattice of the two, because at 136-195 m its 1.35 m cells subtend a few pixels and
        // land straight in the eye's most sensitive band for periodic structure.
        jitter: 2.0,
        // Fades in where the near ring fades out, so neither ring is ever the only
        // cover and the hand-off leaves no ring of density on the ground.
        fadeIn: 12,
        // A 59 m fade-out band starting at 136 m sounds gradual and is not. Under a
        // ground-level camera the band is compressed into a few dozen rows of pixels, so the
        // sward's whole dissolve happens across about a finger's width of screen and reads
        // as a line. A blind critic ranked exactly this - a hard, distance-based cutoff
        // where the instanced ground-detail layer stops - as the most jarring defect in a
        // twenty-frame deck. The band has to be sized in screen space, not world space, and
        // starting at 96 m gives roughly three times the rows to dissolve across. 195 m
        // still sits inside the ring's own lattice extent of +/-202 m, which is the hard
        // constraint; see the ring extents note at the top of this file.
        fadeStart: 96,
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
    macroMap: THREE.Texture,
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
      uMacro: { value: macroMap },
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
      uHeightScale: { value: opt.heightScale * this.profile.heightScale },
      uWeeds: { value: opt.weeds ? 1 : 0 },
      uCards: { value: opt.cards },
      uTime: { value: 0 },
      uWaterLevel: { value: this.waterLevel },
      // These are *tints* multiplied into the card texture, not colours: the card is
      // already painted green, so a colour here would darken it twice over. The dry end
      // pulls toward straw and the wet end toward chlorophyll; the card's own mean sits
      // between them.
      // dryness slides the whole sward toward the straw end. At 0 the map gets the
      // Campus Martius' November pasture; at 0.72 it gets Pieria on the solstice, where
      // even the damp ground is only half green and the rest is standing hay.
      uDryColour: { value: new THREE.Color(1.24, 1.06, 0.62) },
      // The tints above are only half the story: which of them a blade actually gets is
      // decided by the mix factor in the vertex shader, and that factor carried a hard
      // +0.62 bias toward the wet end. So a map could ask for straw, get its `uWetColour`
      // nudged a little warmer, and still render a green sward — measured on Pydna, whose
      // frames came back 20-26 % yellow-green where all three Rome II reference plates
      // carry 0 %. Passing dryness through lets it move the *distribution*, not just the
      // endpoint. At 0 the bias is exactly the 0.62 the Campus Martius has always had.
      uDryness: { value: this.profile.dryness },
      uWetColour: {
        value: new THREE.Color(0.78, 1.1, 0.56).lerp(
          new THREE.Color(1.1, 1.02, 0.66),
          this.profile.dryness,
        ),
      },
      uGroundColour: { value: new THREE.Color(0.98, 0.98, 0.86) },
    };

    const mat = new THREE.MeshStandardMaterial({
      map: cardTex,
      alphaTest: GRASS_ALPHA_TEST,
      roughness: 0.88,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
      // The single largest source of pixel-scale energy in any ground-level frame. A binary
      // alpha test gives a blade one bit of coverage, so a blade narrower than a pixel
      // either paints the whole pixel or none of it, and it flips between the two as the
      // camera moves — the shimmer that reads as "aliased" rather than "detailed".
      // Alpha-to-coverage spends the scene target's MSAA samples on partial coverage
      // instead, and three's alphatest chunk switches to an fwidth-scaled smoothstep under
      // this flag, so the transition lands in one pixel rather than in one texel.
      // Does nothing unless PostFX gave the scene target samples; harmless when it did not.
      alphaToCoverage: true,
    });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${grassGlsl(this.profile.roadGlsl)}`)
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
  float roadD = abs(gpos.x - grassRoadCentreX(gpos.y));
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
  // between. Two scales of clustering noise, and damp ground grows thicker. Interpolated,
  // not quantised per square — see grassNoise.
  float clumpBig = grassNoise(gpos / 19.0) * 0.5 + grassNoise(gpos / 6.5) * 0.5;
  cover *= 0.72 + 0.95 * clumpBig + gctl.r * 0.4;
  // Ploughed and fallow strips carry no sward, and the headland the carts turned on is
  // beaten down to half. Matches the ground shader's own field pattern.
  // Matches the ground shader, including its campus suppression: the fighting ground is
  // pasture, so a fallow strip there must not strip the sward off it either.
  vec3 gfld = grassField(gpos);
  float gCampus = 1.0 - smoothstep(420.0, 800.0, length(vec2(gpos.x * 0.86, (gpos.y + 40.0) * 1.9)));
  // Break the parcel boundary with a few metres of noise before thresholding it. A field
  // edge in the Campus Martius is a headland cut by carts and colonised from both sides,
  // not a surveyor's line, and a straight geometric edge is the single most artificial
  // thing a landscape can do. This also means the remaining transition is ragged rather
  // than coherent, so what is left of it does not read as one line.
  float gFallow = gfld.z + (grassNoise(gpos / 7.3) - 0.5) * 0.11;
  cover *= 1.0 - smoothstep(0.62, 0.83, gFallow) * 0.88 * (1.0 - gCampus * 0.88);
  cover *= 1.0 - gfld.y * 0.55 * (1.0 - gCampus * 0.55);
  // The ground shader's own straw / pasture threshold, so a clump standing on a straw strip
  // is straw and one standing on pasture is green. Without this the two systems disagree
  // about the same field and green tufts sprout out of dry stubble.
  //
  // The two macro-noise taps are the ground's own, sampled at the ground's own scales and
  // offsets, rather than replaced by the constant 0.19 that used to stand in for their mean.
  // A constant makes the sward agree with the ground *on average* and disagree by up to
  // ±0.19 of the mix anywhere in particular — enough to flip a whole parcel, which is why
  // the raking camera photographed a green sward standing on ground measuring 90 % orange
  // and 0 % green. These are vertex-stage taps, one per clump, not per pixel.
  float gNzBig = texture2D(uMacro, gpos * (1.0 / 620.0) + vec2(0.71, 0.29)).a;
  float gNzMid = texture2D(uMacro, gpos * (1.0 / 96.0) + vec2(0.37, 0.61)).a;
  float gStraw = smoothstep(0.42, 0.64, gfld.x * 0.62 + gNzBig * 0.22 + gNzMid * 0.16);

  float dist = length(gpos - uCamXZ);
  float fadeNear = uFadeIn < 0.5 ? 1.0 : smoothstep(uFadeIn, uFadeIn + 30.0, dist);
  float fade = (1.0 - smoothstep(uFadeStart, uFadeEnd, dist)) * fadeNear;
  float keep = step(h3, cover * uDensity);
  // How far this clump has passed beyond the point where it is still a clump.
  //
  // The far ring plants on a 1.35 m lattice, so at 140 m one clump occupies about three
  // pixels. Every per-clump random — its colour draw, its height population, its width —
  // then varies at a three-pixel period, which is noise at very nearly the pixel scale. No
  // amount of texture filtering touches it, because the variation is per-instance
  // geometry, not texels: it is the largest single contributor to pixel-scale energy in
  // any ground-level frame, and it is what makes a sward read as static and aliased rather
  // than as grass. Converging the *variation* on its own mean with distance is what
  // atmosphere and the eye's own acuity do to a real field, and it leaves the mean — and
  // so the parcel structure, which is real detail — untouched.
  float vMerge = smoothstep(42.0, 155.0, dist);
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
  // 0.752 is this distribution's own mean (0.8 x 0.67 + 0.2 x 1.08), so the sward keeps its
  // height as it recedes and only loses the clump-to-clump scatter that was aliasing.
  hVar = mix(hVar, 0.752, vMerge);
  // Trampling shortens the sward far harder than it thins it. Ground five thousand men have
  // been standing on is beaten flat — which is both what actually happens and what lets the
  // men read against it.
  float trodden = 1.0 - smoothstep(0.05, 0.32, gctl.b) * 0.45;
  float wScale = keep * fade * mix(0.88 + 0.30 * h1, 1.03, vMerge);
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
  // uDryness slides the whole distribution toward straw, and it also damps the wetness
  // channel's authority: on a plain in midsummer drought a damp hollow is *less* green than
  // the same hollow in November, not equally green. Both terms vanish at dryness 0.
  // (h2 - 0.5) is the per-clump colour draw and weed the per-clump thistle: both are
  // per-instance randoms, so both turn into pixel-scale noise once a clump is a few pixels
  // across. They fade out with vMerge; every other term here is driven by the control map
  // or the parcel and so is genuine structure that must survive to the horizon.
  vec3 gcol = mix(uDryColour, uWetColour,
    clamp(0.62 - uDryness * 1.15 + gctl.r * 1.1 * (1.0 - uDryness * 0.72)
        + (h2 - 0.5) * 0.8 * (1.0 - vMerge) - gStraw * 0.85, 0.0, 1.0));
  gcol = mix(gcol, uDryColour * 1.2, weed * (1.0 - vMerge));
  gcol *= 0.74 + 0.34 * bt;
  // Converge on the ground colour across the whole fade-out band rather than only its last
  // third. The fade term also carries the far ring's fade-IN, and a clump at 30 m must not
  // be painted as bare earth just because the far ring is still ramping up there, so this
  // keys off the distance term alone. By the time a clump's geometry disappears its colour
  // has been the ground's for some way already, which is what makes the hand-off invisible
  // rather than a ring: the sward dissolves into the ground instead of stopping on it.
  float farMerge = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
  gcol = mix(uGroundColour, gcol, clamp(farMerge * 1.05, 0.0, 1.0));
  vColor = vec4(gcol, 1.0);

  // Pick one of the card variants per clump so the field is not one image stamped
  // everywhere. Overrides the UV that <uv_vertex> set a few lines earlier.
  vMapUv = vec2((uv.x + floor(h2 * uCards)) / uCards, uv.y);
`
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gWorld;')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(normal);');

      // Whether this map wants the straw conversion at all. It has to be a compile-time
      // decision, not a uniform the shader multiplies by zero: grass fill is the largest
      // single fragment cost in any ground-level frame, and adding three unconditional
      // instructions to it cost the Campus Martius — which asks for none of this — 26 % of
      // its frame time on the four grass-heavy shots (melee 62 -> 46 fps, measured, and
      // reproduced). Draw calls and triangles were unchanged, which is the signature of a
      // per-pixel regression rather than a geometric one.
      const dryGrass = this.profile.dryness > 0.001;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vBladeT;${dryGrass ? '\nuniform float uDryness;' : ''}`)
        // Straw has almost no chroma left, and the tint uniforms cannot get there on their
        // own. They are multiplied into a card texture that is painted green, and green times
        // a warm tint is olive, not hay — so a map could set dryness to 0.72 and still render
        // an olive sward standing on straw-coloured ground, each disagreeing with the other
        // about what season it was. Desaturating the *product* and re-warming it is the only
        // place in the chain where a green blade can actually become a dead one. Vanishes at
        // dryness 0, so the Campus Martius sward is untouched.
        .replace(
          '#include <color_fragment>',
          dryGrass
            ? `#include <color_fragment>
  float gDsat = uDryness * 0.62;
  float gLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(gLum) * vec3(1.16, 1.02, 0.72), gDsat);`
            : '#include <color_fragment>'
        )
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
    // v2, and the dry variant is a *separate program*, because the desaturation is compiled
    // in rather than branched on. Without the suffix three would hand the second map the
    // first map's program and the straw conversion would silently not happen.
    const dryKey = this.profile.dryness > 0.001 ? '-dry' : '';
    mat.customProgramCacheKey = () => `terrain-grass-cards-v3${dryKey}`;

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
