import * as THREE from 'three';
import { CLIP_BASE_SPACING, CLIP_CELLS, CLIP_MORPH_BAND } from './clipmap';
import { GROUND_LAYERS, LAYER_COUNT, type GroundTextures } from './groundTextures';
import { HALF_EXTENT, TOPO_GLSL, WATER_LEVEL } from './topography';

/**
 * The ground material.
 *
 * A patched `MeshStandardMaterial`, not a raw `ShaderMaterial`, so it inherits the
 * scene's lights, cascaded shadows, `scene.environment` IBL, fog and tone mapping for
 * free — a hand-written shader that ignores all of that is the fastest way to make a
 * terrain look pasted into the frame.
 *
 * What the shader does per pixel:
 *
 *  - Reads the heightfield texture four times to build a *filtered* surface normal and
 *    the local curvature. The finite-difference offset tracks the pixel footprint, so
 *    distant ground is smoothed instead of aliased, and near ground gets the full
 *    1.37 m detail regardless of how coarse the geometry at that distance is.
 *
 *  - Scores eight material layers from height, slope, curvature, the baked control map
 *    (wetness, bedrock, trampling, silt) and analytic road/river masks, then keeps the
 *    three strongest. Sampling all eight would need 24 fetches; three needs nine.
 *
 *  - Blends those three by *height* rather than by linear interpolation: each layer's
 *    displacement is compared, so gravel sits in the hollows of grass and paving cuts
 *    through dirt with a ragged edge, instead of cross-fading like a slide dissolve.
 *
 *  - Projects triplanar on steep ground so cliffs are not smeared vertically.
 *
 *  - Combines two UV scales per layer, a two-band macro colour variation and a 0.5 m
 *    detail normal. Tiling is the single most visible failure of a game terrain and
 *    none of these three measures is sufficient on its own.
 */

export interface TerrainMaterialSet {
  material: THREE.MeshStandardMaterial;
  /** Same displacement, used for the shadow pass — otherwise the terrain self-shadows wrongly. */
  depthMaterial: THREE.MeshDepthMaterial;
  uniforms: Record<string, THREE.IUniform>;
  dispose(): void;
}

/** Height sampling + clipmap vertex placement. Shared by the colour and depth passes. */
const CLIPMAP_GLSL = /* glsl */ `
uniform sampler2D uHeightMap;
uniform float uHeightSpacing;
uniform float uHalfExtent;
uniform float uFarHeight;
uniform vec2 uClipCentre;
uniform float uBaseSpacing;
uniform float uHalfCells;
uniform float uMorphBand;

float terrainHeightLod(vec2 wxz, float lod) {
  vec2 uv = (wxz + uHalfExtent) / (2.0 * uHalfExtent);
  float h = textureLod(uHeightMap, clamp(uv, 0.0, 1.0), lod).r;
  // Outside the battlefield the heightfield is undefined and clamping would smear the
  // last row of samples — including the Tiber's trench — out to the horizon. Drift to a
  // flat distant plain instead; the fog swallows it long before the edge shows.
  float outward = max(abs(wxz.x), abs(wxz.y));
  return mix(h, uFarHeight, smoothstep(uHalfExtent * 0.97, uHalfExtent * 1.6, outward));
}

vec3 clipmapVertex(vec3 gridLevel) {
  float lvl = gridLevel.y;
  float s = uBaseSpacing * exp2(lvl);
  vec2 grid = vec2(gridLevel.x, gridLevel.z);
  vec2 origin = uClipCentre - vec2(uHalfCells * s);
  vec2 wxz = origin + grid * s;
  // Morph the outermost band of each level onto the coarser grid it abuts. Odd vertices
  // slide onto their even neighbours, degenerating the boundary triangles, so the seam
  // is watertight and nothing pops when the clipmap recentres.
  vec2 dn = abs(wxz - uClipCentre) / (uHalfCells * s);
  float a = clamp((max(dn.x, dn.y) - (1.0 - uMorphBand)) / uMorphBand, 0.0, 1.0);
  wxz = origin + mix(grid, floor(grid * 0.5) * 2.0, a) * s;
  float lod = max(0.0, log2(s / uHeightSpacing));
  return vec3(wxz.x, terrainHeightLod(wxz, lod), wxz.y);
}
`;

const SPLAT_GLSL = /* glsl */ `
uniform sampler2DArray uAlbedoArray;
uniform sampler2DArray uNrmArray;
uniform sampler2D uControl;
uniform sampler2D uMacro;
uniform sampler2D uDetailNormal;
uniform float uFarScale[${LAYER_COUNT}];
uniform float uDetailScale[${LAYER_COUNT}];
uniform float uDetailMix[${LAYER_COUNT}];
uniform float uHeightBias[${LAYER_COUNT}];
uniform float uWaterLevel;
uniform float uDetailStrength;
uniform float uBlendDepth;

${TOPO_GLSL}

/**
 * Surface normal and curvature from the heightfield.
 *
 * The finite-difference offset is the larger of the pixel footprint and the clipmap
 * level's own vertex spacing. Tracking the footprint filters distant ground instead of
 * aliasing it; tracking the level spacing keeps the shading normal consistent with the
 * geometry the depth buffer was written from — without that, a fine normal on a coarse
 * triangle makes the shadow bias fail in a triangular pattern and the whole middle
 * distance breaks out in a diamond lattice of self-shadowing acne.
 */
vec3 terrainSurface(vec2 wxz, out float curv) {
  float fw = max(length(vec2(dFdx(wxz.x), dFdy(wxz.x))), length(vec2(dFdx(wxz.y), dFdy(wxz.y))));
  // The level-spacing term is weighted down to 0.6. It exists so the shading normal stays
  // consistent with the geometry the depth buffer was written from — but this mesh has
  // castShadow disabled, so it cannot self-shadow and the acne that motivated a full
  // weight cannot occur. At full weight the term steps by a factor of two across every
  // clipmap ring boundary, and since those boundaries are axis-aligned squares centred on
  // the camera the result is a visible straight seam across the middle distance, which the
  // stronger detail normals made obvious.
  float e = max(uHeightSpacing, max(fw * 1.35, vLevelSpacing * 0.6));
  float lod = log2(max(e / uHeightSpacing, 1.0));
  float hc = terrainHeightLod(wxz, lod);
  float hl = terrainHeightLod(wxz - vec2(e, 0.0), lod);
  float hr = terrainHeightLod(wxz + vec2(e, 0.0), lod);
  float hd = terrainHeightLod(wxz - vec2(0.0, e), lod);
  float hu = terrainHeightLod(wxz + vec2(0.0, e), lod);
  // Positive curvature is a hollow (collects water and silt), negative is a nose or
  // crest (sheds water, exposes bedrock). Free, because the taps are already loaded.
  curv = clamp(((hl + hr + hd + hu) * 0.25 - hc) * 2.0 / e, -1.0, 1.0);
  return normalize(vec3(hl - hr, 2.0 * e, hd - hu));
}

/**
 * The centuriated field lattice: exact 94 m squares on a bearing of 12.2°, the same grid
 * the heightfield banks its field edges on and the vegetation scatter hangs its hedgerows
 * from.
 *
 * Returns:
 *   x  land-use hash of this strip, constant across the whole strip
 *   y  boundary proximity: 1 on a field line, falling to 0 a few metres inside
 *   z  hash of the whole century, for anything that should not change at a strip line
 *
 * **Cells are not displaced by noise.** An earlier revision added the macro noise to the
 * lattice coordinate, which moved whole cells by up to 7.5 m and left every region outline
 * organic. Combined with a narrow threshold on a high-contrast noise field, that produced
 * hard-edged irregular blotches at 40–80 m — the visual language of DPM camouflage, not of
 * farmland, and from a strategic camera it was the dominant read of the whole frame. The
 * gromatici's whole point was the rectangle: the lattice is now exact and the noise bows
 * only the *boundary*, by a metre and a half, which is the scale a real hedge or drainage
 * ditch actually wanders by.
 *
 * The boundary channel was also inverted: it returned 1 over the entire field interior and
 * 0 only in a thin band at the edge, so everything keyed to the headland was in fact
 * painted across 94 % of every field.
 */
const float FIELD_COS = 0.97740;
const float FIELD_SIN = 0.21140;
const float FIELD_PERIOD = 94.0;

float fieldHash(vec2 c) {
  return fract(sin(dot(c, vec2(41.317, 78.233))) * 43758.5453);
}

vec3 fieldPattern(vec2 wxz, float edgeNoise) {
  vec2 fu = vec2(wxz.x * FIELD_COS - wxz.y * FIELD_SIN, wxz.x * FIELD_SIN + wxz.y * FIELD_COS)
          / FIELD_PERIOD;
  vec2 cell = floor(fu);
  vec2 f = fract(fu);
  float century = fieldHash(cell);
  // Fields are subdivided into two or three strips along their long axis, as the
  // gromatici actually laid them out.
  float strips = 2.0 + floor(fieldHash(cell + 17.0) * 2.5);
  float sub = floor(f.y * strips);
  float use = fract(century + sub * 0.3719 + fieldHash(cell + 41.0) * 0.21);
  // Proximity to the nearest boundary, on a common 0 (strip centre) .. 0.5 (on the line)
  // scale for the century edges and the strip divisions alike.
  vec2 e = abs(f - 0.5);
  float edge = max(max(e.x, e.y), abs(fract(f.y * strips) - 0.5));
  // ±1.6 m of wander on the line itself.
  edge += (edgeNoise - 0.5) * 0.034;
  return vec3(use, smoothstep(0.40, 0.496, edge), century);
}

vec3 triWeights(vec3 n) {
  vec3 bw = abs(n);
  bw = bw * bw;
  bw = bw * bw;
  return bw / (bw.x + bw.y + bw.z + 1e-5);
}

vec4 sampleAlbedo(int idx, float scale, vec3 wp, vec3 bw, float tri) {
  float fi = float(idx);
  vec4 c = texture(uAlbedoArray, vec3(wp.xz / scale, fi));
  if (tri > 0.01) {
    vec4 cx = texture(uAlbedoArray, vec3(wp.zy / scale, fi));
    vec4 cz = texture(uAlbedoArray, vec3(wp.xy / scale, fi));
    c = mix(c, cx * bw.x + c * bw.y + cz * bw.z, tri);
  }
  return c;
}

vec4 sampleNrm(int idx, float scale, vec3 wp, vec3 bw, float tri) {
  float fi = float(idx);
  vec4 c = texture(uNrmArray, vec3(wp.xz / scale, fi));
  if (tri > 0.01) {
    vec4 cx = texture(uNrmArray, vec3(wp.zy / scale, fi));
    vec4 cz = texture(uNrmArray, vec3(wp.xy / scale, fi));
    c = mix(c, cx * bw.x + c * bw.y + cz * bw.z, tri);
  }
  return c;
}

/**
 * Perturb a world normal by a tangent-space offset. Ground UVs are the world XZ plane,
 * so the tangent frame is +X / +Z Gram-Schmidted against the surface normal.
 */
vec3 perturbNormal(vec3 n, vec2 dxy, float strength) {
  vec3 t = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
  vec3 b = cross(n, t);
  return normalize(t * dxy.x * strength + b * dxy.y * strength + n);
}
`;

export function createTerrainMaterial(
  tex: GroundTextures,
  heightMap: THREE.Texture,
  controlMap: THREE.Texture,
  heightSpacing: number,
  farHeight: number
): TerrainMaterialSet {
  const farScale = new Float32Array(LAYER_COUNT);
  const detailScale = new Float32Array(LAYER_COUNT);
  const detailMix = new Float32Array(LAYER_COUNT);
  const heightBias = new Float32Array(LAYER_COUNT);
  for (let i = 0; i < LAYER_COUNT; i++) {
    farScale[i] = GROUND_LAYERS[i].farScale;
    detailScale[i] = GROUND_LAYERS[i].detailScale;
    detailMix[i] = GROUND_LAYERS[i].detailMix;
    heightBias[i] = GROUND_LAYERS[i].heightBias;
  }

  const uniforms: Record<string, THREE.IUniform> = {
    uHeightMap: { value: heightMap },
    uHeightSpacing: { value: heightSpacing },
    uHalfExtent: { value: HALF_EXTENT },
    uFarHeight: { value: farHeight },
    uClipCentre: { value: new THREE.Vector2(0, 0) },
    uBaseSpacing: { value: CLIP_BASE_SPACING },
    uHalfCells: { value: CLIP_CELLS / 2 },
    uMorphBand: { value: CLIP_MORPH_BAND },
    uAlbedoArray: { value: tex.albedo },
    uNrmArray: { value: tex.nrm },
    uControl: { value: controlMap },
    uMacro: { value: tex.macro },
    uDetailNormal: { value: tex.detailNormal },
    uFarScale: { value: farScale },
    uDetailScale: { value: detailScale },
    uDetailMix: { value: detailMix },
    uHeightBias: { value: heightBias },
    uWaterLevel: { value: WATER_LEVEL },
    uDetailStrength: { value: 0.78 },
    // Height-blend depth in surface-height units. Small values interlock hard; too
    // small and the transition aliases into single-texel noise.
    uBlendDepth: { value: 0.2 },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    // Terrain is opaque and single-sided; back faces would only ever be seen through a
    // hill, and rendering them doubles the fill cost of the clipmap.
    side: THREE.FrontSide,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTerrain;
varying float vLevelSpacing;
${CLIPMAP_GLSL}`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `vTerrain = clipmapVertex(position);
  vLevelSpacing = uBaseSpacing * exp2(position.y);
  // A cheap vertex normal at the level's own scale. The fragment shader recomputes a
  // filtered one; this exists so shadow normal-bias and any flat-shaded fallback have
  // something sane to work with.
  float vnE = uBaseSpacing * exp2(position.y);
  float vnLod = max(0.0, log2(vnE / uHeightSpacing));
  vec3 objectNormal = normalize(vec3(
    terrainHeightLod(vTerrain.xz - vec2(vnE, 0.0), vnLod) - terrainHeightLod(vTerrain.xz + vec2(vnE, 0.0), vnLod),
    2.0 * vnE,
    terrainHeightLod(vTerrain.xz - vec2(0.0, vnE), vnLod) - terrainHeightLod(vTerrain.xz + vec2(0.0, vnE), vnLod)
  ));`
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = vTerrain;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTerrain;
varying float vLevelSpacing;
${CLIPMAP_GLSL}
${SPLAT_GLSL}`
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
  vec3 wp = vTerrain;
  float tCurv;
  vec3 tGeoN = terrainSurface(wp.xz, tCurv);
  float tSlope = clamp(1.0 - tGeoN.y, 0.0, 1.0);
  float tAbove = wp.y - uWaterLevel;

  vec4 ctl = texture2D(uControl, (wp.xz + uHalfExtent) / (2.0 * uHalfExtent));
  float cWet = ctl.r;
  float cBare = ctl.g;
  float cTramp = ctl.b;
  float cSilt = ctl.a;

  // Macro variation, sampled at three scales. The alpha channel is an independent mask
  // used to break up the layer weights; RGB is the colour swing.
  vec3 macroFar = texture2D(uMacro, wp.xz * (1.0 / 430.0)).rgb;
  vec4 macroMid = texture2D(uMacro, wp.xz * (1.0 / 96.0) + vec2(0.37, 0.61));
  float nzSmall = texture2D(uMacro, wp.xz * (1.0 / 23.0) + vec2(0.13, 0.77)).a;
  float nzBig = texture2D(uMacro, wp.xz * (1.0 / 620.0) + vec2(0.71, 0.29)).a;

  // The Via Flaminia, evaluated analytically so the paving edge stays crisp at any zoom.
  float roadD = abs(wp.x - topoRoadCentreX(wp.z));
  // Kerb line broken up along its length: after two centuries of carts the edge of a
  // consular road is ragged, and a mathematically straight one looks printed on.
  float kerb = 2.75 + 0.28 * (nzSmall - 0.5) * 2.0;
  float paved = 1.0 - smoothstep(kerb, kerb + 0.7, roadD);
  float verge = 1.0 - smoothstep(3.2, 8.0, roadD);

  float grassKill = smoothstep(0.30, 0.60, tSlope);
  float hollow = max(tCurv, 0.0);
  float nose = max(-tCurv, 0.0);

  // Worked land: fld.x is what this strip is doing, fld.y its boundary line.
  // Suppressed on the hills and in the river valley, where nobody ploughed.
  vec3 fld = fieldPattern(wp.xz, macroMid.a);
  float farmed = (1.0 - smoothstep(0.22, 0.48, tSlope)) * smoothstep(3.0, 9.0, tAbove);
  // The Campus Martius itself was *ager publicus* — pasture, parade ground and monuments,
  // never ploughed; the centuriated arable begins beyond it. So the bare-earth half of the
  // patchwork is suppressed over the fighting ground, which is both correct and what stops
  // the eye-level camera in the Roman line from standing in a ploughed field. The straw /
  // green / stubble half of the pattern stays, so the plain keeps its blocky variety.
  // Weighted hard along z: the ager publicus is the flood plain inside the Tiber bend, so
  // the exemption has to stop short of the necropolis and the hill approach at z > 300,
  // which are trodden, dusty, tomb-lined ground and not pasture. It also has to let the
  // outer flanks of the frontage keep some arable, or a high camera sees one green wash.
  float campus = 1.0 - smoothstep(420.0, 800.0, length(vec2(wp.x * 0.86, (wp.z + 40.0) * 1.9)));
  // Aerial convergence. A real aerial photograph *converges*: haze and sub-pixel mixing
  // pull everything toward a common tone as distance grows. This shader diverged instead,
  // which is half of why the strategic view read as camouflage — and the same variance is
  // what aliases when a 94 m cell shrinks toward a few pixels. Roads and rock are exempt,
  // because a basalt carriageway really is a dark line from two kilometres up.
  float aerial = smoothstep(300.0, 1150.0, length(vViewPosition))
               * (1.0 - paved) * (1.0 - smoothstep(0.18, 0.42, tSlope));
  // Land use is decided per strip, and only *two* states are allowed to be strong: green
  // pasture and burnt-off straw. Bare earth and stone are accents keyed to the fallow
  // strips, the boundary lines and real slope. Four equally-loud states across one plain
  // is what turns worked land into DPM.
  float useDecorr = fract(fld.x * 3.71 + fld.z * 0.613);
  float fieldGain = 1.0 - aerial * 0.78;
  float fallow = smoothstep(0.66, 0.79, useDecorr) * farmed * (1.0 - campus * 0.88) * fieldGain;
  float stubble = smoothstep(0.30, 0.44, fld.x) * (1.0 - smoothstep(0.56, 0.68, fld.x)) * farmed;
  // The headland: a beaten track a few metres wide *on* the field line, where the carts
  // turned and the plough could not reach. It straddles the boundary, so the change of
  // land use either side of it passes through a third material instead of being a hard
  // albedo step — which is what lets the lattice be rectilinear without aliasing.
  //
  // Deliberately *not* subject to the aerial field gain. Boundary lines are the one part of a
  // patchwork that a real aerial view resolves more sharply, not less: hedges, ditches and
  // farm tracks are the first thing you read off an air photograph. Converging them away
  // with distance left the fields as flat colour rectangles butting directly together.
  float headland = fld.y * farmed * (1.0 - campus * 0.55);

  float w[${LAYER_COUNT}];
  // 0 dry grass and 1 meadow grass share the plain in opposition, so the ground breaks
  // into readable blocks of straw and green rather than averaging into one tone.
  //
  // **Dominated by the strip hash, not by noise.** The regions have to *be* the fields:
  // when the mix was 82 % macro noise and 18 % field hash the outlines were fractal and
  // the result was camouflage. Noise now supplies only a gentle drift within each strip,
  // so a field is not a flat colour but its identity and its edges come from the lattice.
  //
  // Biased so green pasture is the ground state and burnt-off straw the exception, which
  // is how real Rome II ground looks — green with dry patches through it, not the reverse.
  // The straw share is pulled toward the mean with distance along with everything else.
  float useMix = fld.x * 0.62 + nzBig * 0.22 + macroMid.a * 0.16;
  float grassMix = mix(smoothstep(0.42, 0.64, useMix), 0.34, aerial * 0.78);
  w[0] = (0.3 + 2.7 * grassMix + stubble * 1.6) * (1.0 - grassKill) * (1.0 - paved);
  w[1] = (0.3 + 2.5 * (1.0 - grassMix) + cWet * 1.8 + hollow * 0.5)
       * (1.0 - grassKill) * (1.0 - paved) * (1.0 - fallow * 0.75);
  // 2 trampled earth: army grounds, road verges, the tracks on the field lines and the
  // ploughed and fallow strips. An accent, not a fourth co-equal state.
  w[2] = cTramp * 1.7 + verge * 1.0
       + fallow * 2.6 + headland * 1.9;
  // 3 mud: where drainage really concentrates and the ground never dries.
  w[3] = smoothstep(0.68, 0.98, cWet) * 2.1 + hollow * 0.45
       + cSilt * 0.6 * (1.0 - smoothstep(0.8, 4.5, tAbove));
  // 4 gravel and scree: eroded ground, real slope, road margins, quarry spoil, and the
  // stony rises the plough turned up.
  //
  // Every term here is tied to something *structural* — slope, curvature, the erosion
  // control map, the road. The free-floating macro-noise patches this used to carry were
  // soft ~60 m blobs of pale grey-tan, and on a green plain they were half of the
  // camouflage read; they survive only as a weak, high-threshold accent on ground the
  // plough has actually turned over.
  w[4] = cBare * 1.2 + smoothstep(0.13, 0.40, tSlope) * 1.75 + verge * 1.35 + nose * 0.7
       + smoothstep(0.78, 0.95, macroMid.b) * 0.6 * fallow * (1.0 - paved)
       + fallow * nose * 1.4 + headland * 0.5
       // Traffic wears the fines out of a track and leaves the stones standing. Without
       // this, trodden ground — army camps, the glacis, the ford approach — is a sheet of
       // featureless chocolate mud wherever it is not grass.
       + smoothstep(0.12, 0.55, cTramp) * 1.3;
  // 5 exposed limestone: steep faces, quarry cuts, the noses of ridges.
  w[5] = smoothstep(0.32, 0.60, tSlope) * 2.9
       + cBare * smoothstep(0.18, 0.45, tSlope) * 2.2 + nose * 0.5;
  // 6 river sand and gravel: the bed, the bars and the water's edge.
  w[6] = (1.0 - smoothstep(0.3, 3.2, tAbove)) * 2.5
       + cSilt * (1.0 - smoothstep(0.0, 4.0, tAbove)) * 1.7;
  // 7 basalt paving.
  w[7] = paved * 9.0;

  int bi0 = 0; int bi1 = 0; int bi2 = 0;
  float bm0 = -1.0; float bm1 = -1.0; float bm2 = -1.0;
  for (int i = 0; i < ${LAYER_COUNT}; i++) {
    float v = w[i];
    if (v > bm0) { bm2 = bm1; bi2 = bi1; bm1 = bm0; bi1 = bi0; bm0 = v; bi0 = i; }
    else if (v > bm1) { bm2 = bm1; bi2 = bi1; bm1 = v; bi1 = i; }
    else if (v > bm2) { bm2 = v; bi2 = i; }
  }
  float inv0 = 1.0 / max(bm0, 1e-4);
  bm0 *= inv0; bm1 *= inv0; bm2 *= inv0;

  float tri = smoothstep(0.10, 0.32, tSlope);
  vec3 triBw = triWeights(tGeoN);

  int lidx[3]; lidx[0] = bi0; lidx[1] = bi1; lidx[2] = bi2;
  float lw[3]; lw[0] = bm0; lw[1] = bm1; lw[2] = bm2;
  vec4 lfar[3];
  float ls[3];
  for (int k = 0; k < 3; k++) {
    lfar[k] = sampleAlbedo(lidx[k], uFarScale[lidx[k]], wp, triBw, tri);
    ls[k] = lw[k] + lfar[k].a + uHeightBias[lidx[k]];
  }
  // Height blending: the layer whose surface stands proudest wins the pixel, so the
  // boundary follows the texture's own relief instead of dissolving.
  float peak = max(max(ls[0], ls[1]), ls[2]) - uBlendDepth;
  float bsum = 0.0;
  for (int k = 0; k < 3; k++) { ls[k] = max(ls[k] - peak, 0.0); bsum += ls[k]; }
  bsum = 1.0 / max(bsum, 1e-4);

  vec3 tCol = vec3(0.0);
  vec2 tNxy = vec2(0.0);
  float tRoughAcc = 0.0;
  float tAOAcc = 0.0;
  for (int k = 0; k < 3; k++) {
    float bw = ls[k] * bsum;
    if (bw < 0.004) continue;
    int idx = lidx[k];
    vec3 c = lfar[k].rgb;
    float dm = uDetailMix[idx];
    if (dm > 0.001) {
      // Second UV scale of the same texture. Two very different repeats beat against
      // each other and destroy the visible period of both.
      c = mix(c, sampleAlbedo(idx, uDetailScale[idx], wp, triBw, tri).rgb, dm);
    }
    vec4 nr = sampleNrm(idx, uDetailScale[idx], wp, triBw, tri);
    tCol += c * bw;
    tNxy += (nr.xy * 2.0 - 1.0) * bw;
    tRoughAcc += nr.z * bw;
    tAOAcc += nr.w * bw;
  }

  // Detail relief at two scales, faded with distance so neither aliases into sparkle.
  // The coarse band survives to 130 m because at that range it is the only thing keeping
  // the middle distance from going smooth; the 0.5 m band would shimmer long before.
  float camDist = length(vViewPosition);
  float detFade = 1.0 - smoothstep(22.0, 74.0, camDist);
  // The 2.4 m band is *not* faded in from the near field: at that wavelength it is clods
  // and hollows, not grain, and a boot-level camera needs them as much as a mid-distance
  // one. Only its far cut-off matters, where it would start to alias.
  float midFade = 1.0 - smoothstep(150.0, 340.0, camDist);
  vec4 det = texture2D(uDetailNormal, wp.xz * 2.0);
  // The coarse band is sampled on a *rotated* frame, at 37°, and at an irrational-ish
  // 2.19 m rather than a neat fraction of the fine band's 0.5 m. Sampling one texture at two
  // axis-aligned scales makes both repeats land on the same lattice, and at eye level that
  // showed up as a visible grid of ring-shaped clods every couple of metres.
  vec2 detRot = vec2(wp.x * 0.7986 - wp.z * 0.6018, wp.x * 0.6018 + wp.z * 0.7986);
  vec4 detMid = texture2D(uDetailNormal, detRot * 0.4566 + vec2(0.31, 0.67));
  tNxy += (det.xy * 2.0 - 1.0) * 1.25 * detFade;
  tNxy += (detMid.xy * 2.0 - 1.0) * 0.55 * midFade;

  vec3 tNormal = perturbNormal(tGeoN, tNxy, uDetailStrength);
  float tRough = clamp(tRoughAcc, 0.25, 1.0);
  float tAO = clamp(tAOAcc, 0.0, 1.0);

  // Large-scale colour drift. Centred on 1.0 so it tints rather than darkens. This is
  // doing most of the work of hiding the repeat at the scales a high camera sees.
  tCol *= mix(vec3(1.0), macroFar * 2.0, 0.85);
  // Only R and G of the mid band are colour; B is reserved as a splat mask and has far
  // too much contrast to tint with.
  tCol *= mix(vec3(1.0), vec3(macroMid.r, macroMid.g, macroMid.g) * 2.0, 0.3);
  // Near-field shading from the detail height, and a scatter of small stones. A normal
  // perturbation alone leaves the ground looking sanded smooth under a low sun, because
  // half the clods face away from it; this is the light-and-shade half of the same relief.
  tCol *= mix(1.0, 0.70 + 0.66 * det.z, detFade * 0.85);
  tCol *= mix(1.0, 0.90 + 0.20 * detMid.z, midFade * 0.55);
  // A third band at ~11 m from the macro texture. It sits in the octave between the 2.2 m
  // clods and the 23 m mottle, and its job is to carry a structure larger than either so
  // neither repeat has a clean period to be read off.
  tCol *= mix(1.0, 0.84 + 0.34 * texture2D(uMacro, wp.xz * (1.0 / 11.3) + vec2(0.53, 0.19)).a,
              (1.0 - smoothstep(90.0, 260.0, camDist)) * 0.55);
  // Stones read as pale, cool flecks sitting on top of whatever the ground is.
  tCol = mix(tCol, mix(tCol, vec3(0.30, 0.29, 0.265), 0.72), det.w * detFade * 0.55);

  // The last stage of aerial convergence. Suppressing the *drivers* above stops the
  // patchwork from being decided so strongly at distance; this pulls the residual toward
  // the plain's own area-weighted mean, which is what a real aerial view of mixed
  // sub-pixel ground actually resolves to. Luminance is left alone and only the deviation
  // from the mean *hue* is compressed, so distant ground still reads light where it is
  // straw and dark where it is turned earth — it simply stops reading as two paints.
  //
  // AERIAL_MEAN is 55 % pasture, 30 % straw, 10 % turned earth, 5 % stone, in linear.
  const vec3 AERIAL_MEAN = vec3(0.199, 0.207, 0.070);
  float tLum = dot(tCol, vec3(0.2126, 0.7152, 0.0722));
  vec3 tMean = AERIAL_MEAN * (tLum / max(dot(AERIAL_MEAN, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
  tCol = mix(tCol, tMean, aerial * 0.62);
  diffuseColor.rgb *= tCol;
`
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
  // At this point in three's fragment stage, "normal" is in VIEW space: the vertex
  // stage writes vNormal = normalize(normalMatrix * objectNormal). tGeoN and tNormal
  // are built from world-space height differences, so they must be rotated into view
  // space before being written back. Assigning the world-space vector directly leaves
  // every dotNL comparing mismatched bases, which costs the terrain essentially all of
  // its direct sunlight - measured as 17x darker than a plain MeshStandardMaterial,
  // and darker than that same material lit by ambient alone.
  normal = normalize((viewMatrix * vec4(tNormal, 0.0)).xyz);
  nonPerturbedNormal = normalize((viewMatrix * vec4(tGeoN, 0.0)).xyz);`
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
  reflectedLight.indirectDiffuse *= tAO;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(
      saturate(dot(geometryNormal, geometryViewDir)), tAO, material.roughness);
  #endif
`
      );
  };
  // Distinguishes this program from any other patched MeshStandardMaterial in the scene.
  material.customProgramCacheKey = () => 'terrain-clipmap-splat-v1';

  // ---------------------------------------------------------------------
  // Shadow pass. The clipmap's displacement lives in the vertex shader, so the default
  // depth material would render a flat plane and the hills would cast no shadow.
  // ---------------------------------------------------------------------
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CLIPMAP_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = clipmapVertex(position);');
  };
  depthMaterial.customProgramCacheKey = () => 'terrain-clipmap-depth-v1';

  return {
    material,
    depthMaterial,
    uniforms,
    dispose() {
      material.dispose();
      depthMaterial.dispose();
    },
  };
}
