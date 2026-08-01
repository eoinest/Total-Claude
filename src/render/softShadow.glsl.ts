/**
 * Sun shadows with a penumbra that grows with throw distance.
 *
 * ## Why this exists
 *
 * three's PCF filter takes one `shadowRadius` **in shadow-map texels**. `LightingSystem`
 * ramped that radius from 2.2 texels in the near cascade to 4.0 in the far one, on the
 * reasoning that a constant texel count widens the penumbra automatically as the cascades
 * coarsen. Measured, that reasoning inverts: the texel footprint grows about 20x from
 * cascade 0 to cascade 3, so the *blur in metres* grew with it. At the `wide` camera —
 *
 *     cascade 0  ->33m    texel 0.026 m   radius 2.2  =  0.058 m of blur
 *     cascade 1  ->76m    texel 0.065 m   radius 2.8  =  0.182 m
 *     cascade 2  ->182m   texel 0.160 m   radius 3.4  =  0.544 m
 *     cascade 3  ->560m   texel 0.503 m   radius 4.0  =  2.012 m
 *
 * — a man is about 0.45 m across, so past ~60 m his shadow was being blurred wider than
 * his own body and past ~150 m smeared over four times it. That is why every blind critic
 * reported that soldiers cast no shadow and "flatten into a sheet of decals": at the
 * distances a battle line is actually photographed from, they genuinely did not.
 *
 * Meanwhile the *near* shadows had the opposite problem. 0.058 m of blur is under two
 * pixels at any close camera, so a tower throwing its shadow 30 m across the ground had an
 * edge as hard as one thrown 30 cm — "no penumbra growth over 30 metres of throw", in a
 * critic's words. Both faults are the same mistake: the filter width was a function of how
 * far the *camera* is, when it is physically a function of how far the *occluder* is.
 *
 * ## What this does instead
 *
 * The sun is not a point. Its angular diameter is 0.53 degrees, so an occluder at distance
 * `d` from the surface it shadows casts a penumbra of `d * tan(0.265 deg) * 2 = d * 0.00925`
 * — 0.3 mm at a boot sole, 28 cm at 30 m, and that ratio is what the eye reads as "this
 * object is touching the ground" versus "this object is 30 m above it".
 *
 * So the filter radius is derived per pixel from an estimate of the blocker's distance:
 *
 *   1. **One 5-tap probe at the widest radius the cascade allows.** Over most of a frame
 *      this returns fully lit or fully occluded and the function returns immediately, at
 *      exactly the cost of three's own filter. Only pixels genuinely inside a penumbra pay
 *      for the rest.
 *   2. **A bounded binary search for the blocker depth.** Orthographic light depth is
 *      linear, so `shadowCoord.z` is a plain fraction of the light's near..far range and a
 *      search over the first `TC_THROW_MAX` metres of it converges in four steps. The
 *      hardware comparison sampler cannot return a depth, but it can answer "is anything
 *      in front of this plane", which is all a binary search needs. The search runs on a
 *      *narrow* disc rather than on the centre tap: a disc keeps the lit side of a penumbra
 *      from collapsing to a hard edge, because both sides of the boundary see the same
 *      neighbourhood and therefore agree on the radius. Whether that disc is *too* wide inside
 *      a crowd was the leading theory for the merged-wedge defect; it was tested in-session and
 *      ruled out. See `SEARCH_TEXELS`.
 *   3. **An 8-tap Vogel filter at the radius that implies.**
 *
 * Bounds. `TC_PEN_MIN` keeps a contact shadow from aliasing into stair-steps; `TC_PEN_MAX`
 * stops a distant hillside's shadow from becoming a smear. The texel clamp on top is a cost
 * bound: a wide disc in the near cascade would otherwise mean sampling 26 texels out.
 *
 * Patched into `ShaderChunk.shadowmap_pars_fragment` rather than written as a
 * `ShaderMaterial`, so every material keeps three's lighting, IBL, fog and tone mapping.
 */

/** Sun angular diameter, 0.53 deg, as penumbra metres per metre of throw. */
const SUN_PENUMBRA_RATIO = 0.00925;
/** Longest throw the blocker search resolves. Beyond it the penumbra is already capped. */
const THROW_MAX = 45;
/** Softest penumbra allowed, metres. A 45 m throw would physically give 0.42 m. */
const PEN_MAX = 0.42;
/**
 * Tightest penumbra allowed, metres. Not zero: a single-tap shadow test stair-steps along
 * the shadow-map grid, and 25 mm is under a bootprint so it cannot lift a contact shadow.
 */
const PEN_MIN = 0.025;
/** Cost bound on the wide probe, in texels. */
const RADIUS_MAX_TEXELS = 9.0;
/**
 * Radius of the *blocker search* disc, in texels. Currently equal to the cost bound, so
 * `min( rMax, TC_SEARCH_TEXELS )` is `rMax` and this changes no behaviour — it exists as a
 * separate, overridable knob because it was the leading suspect for a real defect and had to
 * be ruled out by measurement rather than by argument.
 *
 * The hypothesis, which was wrong. A blind critic found that a formation drops one merged grey
 * wedge in which you cannot count men, while grass a metre away casts crisp shadows. The search
 * probes at `rMax` — up to 9 texels, and at cascade 1's 4.2 cm texel a 38 cm disc, about the
 * gap between two men in a rank. So inside a formation the disc should straddle a neighbour at
 * every depth tested, `tcDiscLit` should never return "all lit", the binary search should never
 * narrow, `hi` should stay 1, and `throwM` should saturate at `TC_THROW_MAX` — giving every
 * pixel of a crowd's cast shadow the widest filter in the shader, a 38 cm blur across a 45 cm
 * man. It fits the symptom exactly, including why an isolated grass tuft with open sky around
 * it stays sharp.
 *
 * Measured in-session, narrowing this to 3 texels across all 231 materials moves the frame by
 * **0.009/255 at romanline and 0.017/255 at raking, over 0.00 % of the frame**, against a
 * measured noise floor of 0.000 and a crowd-shadow signal of 9.8/255. The search is not
 * saturating, or if it is, the saturation is not what is softening the shadow. Hypothesis dead.
 *
 * It had to be measured in-session because it cannot be measured any other way: two runs of
 * `probe-shadow.mjs` at identical configuration differ on 50-70 % of pixels with a mean of
 * 17-27/255, since the dust and particle VFX reseed per session even with the sim clock paused.
 * A cross-session before/after of a shadow filter is pure noise, and an eye comparison across
 * two runs is worse — one such comparison of a `THROW_MAX` change looked convincing and was
 * entirely session reseeding. The `#ifndef` guard below exists so the probe can override this
 * from a material define and keep the comparison inside one session.
 */
const SEARCH_TEXELS = 9.0;
/**
 * Radius, in texels, for the fixed-width fallback compiled in under `TC_SOFT_OFF`.
 * This is three's own PCF filter — the one this file replaced — kept as a compiled arm so
 * the throw-dependent path's cost can be measured against it rather than estimated.
 */
const PCF_FALLBACK_TEXELS = 2.0;

/**
 * `tcSoftShadow` — drop-in replacement for three's directional `getShadow`, plus the
 * per-cascade geometry it needs.
 *
 * `tcShadowGeom[i]` is `(metres per shadow texel, metres per unit shadowCoord.z)`, both
 * derived on the CPU from the cascade's fitted orthographic camera.
 */
export const SOFT_SHADOW_GLSL = /* glsl */ `
#if defined( SHADOWMAP_TYPE_PCF ) && defined( USE_SHADOWMAP ) && defined( USE_CSM ) && defined( CSM_CASCADES )

uniform vec2 tcShadowGeom[ CSM_CASCADES ];

#define TC_SUN_PENUMBRA ${SUN_PENUMBRA_RATIO}
#define TC_THROW_MAX ${THROW_MAX.toFixed(1)}
#define TC_PEN_MAX ${PEN_MAX}
#define TC_PEN_MIN ${PEN_MIN}
#define TC_RADIUS_MAX_TEXELS ${RADIUS_MAX_TEXELS.toFixed(1)}
// Overridable from a material define so the probe can A/B it in one session. Cross-session
// frame comparison cannot resolve this: two runs of identical configuration differ on ~60 % of
// pixels because the dust and particle VFX reseed per session even with the sim clock paused.
#ifndef TC_SEARCH_TEXELS
#define TC_SEARCH_TEXELS ${SEARCH_TEXELS.toFixed(1)}
#endif
#define TC_PCF_FALLBACK ${PCF_FALLBACK_TEXELS.toFixed(1)}

// Three taps of the five-tap disc, reused at each binary-search depth. Three is enough to
// tell "the whole neighbourhood is clear of this plane" from "some of it is not", and the
// search only needs that predicate.
float tcDiscLit( sampler2DShadow shadowMap, vec2 uv, float z, float radius, float phi ) {
  return (
    texture( shadowMap, vec3( uv + vogelDiskSample( 0, 5, phi ) * radius, z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 2, 5, phi ) * radius, z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 4, 5, phi ) * radius, z ) )
  ) * ( 1.0 / 3.0 );
}

float tcSoftShadow(
  sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity,
  float shadowBias, vec4 shadowCoord, vec2 geom
) {
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;

  bool inFrustum = all( greaterThanEqual( shadowCoord.xy, vec2( 0.0 ) ) )
                && all( lessThanEqual( shadowCoord.xy, vec2( 1.0 ) ) );
  if ( ! inFrustum || shadowCoord.z > 1.0 ) return 1.0;

  float texel = 1.0 / shadowMapSize.x;

#ifdef TC_SOFT_OFF

  // Fixed-texel PCF: the filter this file replaced, compiled in as a reference arm.
  float phiF = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
  float sumF = 0.0;
  for ( int k = 0; k < 5; k ++ ) {
    sumF += texture( shadowMap, vec3(
      shadowCoord.xy + vogelDiskSample( k, 5, phiF ) * TC_PCF_FALLBACK * texel, shadowCoord.z
    ) );
  }
  return mix( 1.0, sumF * 0.2, shadowIntensity );

#else

  // Guarded: a material that reached here without tcShadowGeom ever being written would
  // divide by zero and blow the radius bounds out to infinity.
  float mPerTexel = max( geom.x, 1e-4 );
  float mPerZ = max( geom.y, 1.0 );

  // Radius bounds, in texels.
  float rMin = max( TC_PEN_MIN / mPerTexel, 0.85 );
  float rMax = clamp( TC_PEN_MAX / mPerTexel, rMin, TC_RADIUS_MAX_TEXELS );

  float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
  vec2 uv = shadowCoord.xy;

  // 1 --- widest probe. Fully lit or fully dark is the common case; both return here.
  float wide = (
    texture( shadowMap, vec3( uv + vogelDiskSample( 0, 5, phi ) * rMax * texel, shadowCoord.z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 1, 5, phi ) * rMax * texel, shadowCoord.z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 2, 5, phi ) * rMax * texel, shadowCoord.z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 3, 5, phi ) * rMax * texel, shadowCoord.z ) ) +
    texture( shadowMap, vec3( uv + vogelDiskSample( 4, 5, phi ) * rMax * texel, shadowCoord.z ) )
  ) * 0.2;
  if ( wide > 0.999 ) return 1.0;
  if ( wide < 0.001 ) return mix( 1.0, 0.0, shadowIntensity );

  // 2 --- bounded binary search for the farthest blocker in that neighbourhood.
  //
  // zWin is TC_THROW_MAX metres expressed in shadowCoord.z. Sampling at z - o asks whether
  // anything lies between the receiver and a plane o nearer the light; the smallest o for
  // which the answer is no is the throw distance.
  //
  // Overridable search radius so the probe can A/B it in one session; equal to rMax by
  // default, so this is the original behaviour. See TC_SEARCH_TEXELS for what was ruled out.
  float rSearch = min( rMax, TC_SEARCH_TEXELS );
  float zWin = min( TC_THROW_MAX / mPerZ, shadowCoord.z );
  float lo = 0.0;
  float hi = 1.0;
  for ( int s = 0; s < 4; s ++ ) {
    float mid = ( lo + hi ) * 0.5;
    float lit = tcDiscLit( shadowMap, uv, shadowCoord.z - zWin * mid, rSearch * texel, phi );
    if ( lit > 0.99 ) hi = mid; else lo = mid;
  }
  float throwM = hi * zWin * mPerZ;

  // 3 --- filter at the radius the sun's angular size implies for that throw.
  float radius = clamp( throwM * TC_SUN_PENUMBRA / mPerTexel, rMin, rMax );
  if ( radius > rMax * 0.94 ) return mix( 1.0, wide, shadowIntensity );

  float shadow = 0.0;
  for ( int k = 0; k < 8; k ++ ) {
    shadow += texture( shadowMap, vec3( uv + vogelDiskSample( k, 8, phi ) * radius * texel, shadowCoord.z ) );
  }
  return mix( 1.0, shadow * 0.125, shadowIntensity );

#endif
}

#endif
`;

/**
 * The exact `getShadow(...)` call CSM's `lights_fragment_begin` makes for a directional
 * cascade. It appears twice — once in the `CSM_FADE` branch and once without — so a
 * split/join over this string reaches both.
 */
export const CSM_GET_SHADOW_CALL =
  'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, '
  + 'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, '
  + 'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';

/** Its replacement. `[ i ]` survives three's `unroll_loop` rewrite as a literal index. */
export const CSM_SOFT_SHADOW_CALL =
  'tcSoftShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, '
  + 'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, '
  + 'vDirectionalShadowCoord[ i ], tcShadowGeom[ i ] )';
