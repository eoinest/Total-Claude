/**
 * Single-scattering atmospheric radiance, GLSL side.
 *
 * A spherical-shell Rayleigh + Mie + ozone model with the coefficient set from
 * Bruneton & Neyret's precomputed-scattering paper (2008) as re-tabulated by
 * Hillaire (2020, "A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique"). Chosen over Hosek–Wilkie because:
 *   - it stays valid with the sun below the horizon (dawn/dusk/night presets),
 *   - the same integral run over a *finite* segment gives aerial perspective, so
 *     the sky and the distance haze cannot drift out of agreement,
 *   - it needs no 3 kB fitted coefficient table.
 *
 * Everything is in kilometres / per-kilometre. A float32 mantissa has ~7 digits,
 * and the planet radius is 6.36e3 km, so metres would burn all the precision on
 * the offset and leave visible banding in the horizon gradient.
 *
 * The TypeScript mirror in `src/render/atmosphere.ts` must stay structurally
 * identical — the sun colour, ambient colour and fog tint are computed there and
 * would visibly disagree with the dome otherwise.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#define TC_PI 3.141592653589793

// Earth radius and a 100 km modelled shell. Bruneton's values.
#define TC_PLANET_R 6360.0
#define TC_ATMOS_R  6460.0

// Scattering / absorption at sea level, 1/km, for the sRGB primaries
// (680 / 550 / 440 nm). Rayleigh is ~1/lambda^4, hence the strong blue bias.
const vec3  TC_BETA_R  = vec3( 5.802e-3, 13.558e-3, 33.100e-3 );
// Mie is close to grey; scattering and absorption are split because aerosol soot
// absorption is what turns a high-turbidity sky milky-grey rather than bright white.
const float TC_BETA_M  = 3.996e-3;
const float TC_BETA_MA = 4.400e-3;
// Ozone absorbs in the Chappuis band and is the reason a clear zenith reads as a
// deep, slightly violet blue instead of cyan. Without it the sky looks like a
// swimming pool.
const vec3  TC_BETA_O  = vec3( 0.650e-3, 1.881e-3, 0.085e-3 );

// Scale heights: air 8 km (barometric), aerosol 1.2 km (haze hugs the ground).
#define TC_H_R 8.0
#define TC_H_M 1.2

struct TCAtmos {
  vec3  sunDir;       // unit, ground -> sun, world space (y up)
  vec3  sunIrradiance;// top-of-atmosphere solar irradiance, arbitrary but consistent units
  float turbidity;    // 1 pristine, 2.2 clear, 4 hazy summer, 9 storm
  float groundAlbedo; // broadband albedo of the sphere under the atmosphere
  float msScale;      // isotropic multiple-scattering gain (see below)
  float mieG;         // Henyey-Greenstein asymmetry; 0.76 = continental aerosol
};

// (rayleigh, mie, ozone) density relative to sea level at altitude h km.
vec3 tcDensity( float h ) {
  // Ozone is a *layer*, not an exponential: a tent peaking at 25 km with a
  // 15 km half-width matches the standard mid-latitude profile closely enough.
  return vec3(
    exp( -h / TC_H_R ),
    exp( -h / TC_H_M ),
    max( 0.0, 1.0 - abs( h - 25.0 ) / 15.0 )
  );
}

// Total extinction (1/km) at altitude h.
vec3 tcExtinction( float h, float turbidity ) {
  vec3 d = tcDensity( h );
  return TC_BETA_R * d.x
       + vec3( ( TC_BETA_M + TC_BETA_MA ) * turbidity * d.y )
       + TC_BETA_O * d.z;
}

// Distance from p (planet-centred) along dir to the top of the atmosphere.
// Returns -1 when the ray never enters the shell.
float tcAtmosTop( vec3 p, vec3 dir ) {
  float b = dot( p, dir );
  float c = dot( p, p ) - TC_ATMOS_R * TC_ATMOS_R;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  return -b + sqrt( disc );
}

// Nearest positive intersection with the planet, or -1.
float tcGroundHit( vec3 p, vec3 dir ) {
  float b = dot( p, dir );
  float c = dot( p, p ) - TC_PLANET_R * TC_PLANET_R;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  float t = -b - sqrt( disc );
  return t > 0.0 ? t : -1.0;
}

// Transmittance from p to the sun. 6 steps is enough because the integrand is a
// smooth exponential; the error shows up only as a sub-percent shift in horizon hue.
vec3 tcSunTransmittance( vec3 p, TCAtmos a ) {
  if ( tcGroundHit( p, a.sunDir ) > 0.0 ) return vec3( 0.0 );
  float tTop = tcAtmosTop( p, a.sunDir );
  if ( tTop <= 0.0 ) return vec3( 1.0 );
  float ds = tTop / 6.0;
  vec3 od = vec3( 0.0 );
  for ( int i = 0; i < 6; i ++ ) {
    vec3 q = p + a.sunDir * ( ds * ( float( i ) + 0.5 ) );
    od += tcExtinction( length( q ) - TC_PLANET_R, a.turbidity ) * ds;
  }
  return exp( -od );
}

float tcPhaseR( float mu ) {
  return ( 3.0 / ( 16.0 * TC_PI ) ) * ( 1.0 + mu * mu );
}

float tcPhaseM( float mu, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return ( 1.0 - g2 ) / ( 4.0 * TC_PI * max( 1e-4, d * sqrt( max( 1e-4, d ) ) ) );
}

/**
 * In-scattered radiance along [0, tMax] plus the surviving background.
 * 'bg' is what lies at tMax (scene colour for aerial perspective, ground albedo
 * bounce or black for a sky ray). 'outT' receives the segment transmittance.
 */
vec3 tcScatter( vec3 ro, vec3 rd, float tMax, TCAtmos a, vec3 bg, int steps, out vec3 outT ) {
  float mu = dot( rd, a.sunDir );
  float phR = tcPhaseR( mu );
  float phM = tcPhaseM( mu, a.mieG );

  vec3 L = vec3( 0.0 );
  vec3 T = vec3( 1.0 );
  float ds = tMax / float( steps );

  for ( int i = 0; i < 64; i ++ ) {
    if ( i >= steps ) break;
    vec3 p = ro + rd * ( ds * ( float( i ) + 0.5 ) );
    float h = length( p ) - TC_PLANET_R;
    vec3 d = tcDensity( h );

    vec3  sR = TC_BETA_R * d.x;
    float sM = TC_BETA_M * a.turbidity * d.y;
    vec3  ext = sR + vec3( ( TC_BETA_M + TC_BETA_MA ) * a.turbidity * d.y ) + TC_BETA_O * d.z;

    vec3 tr = tcSunTransmittance( p, a );
    vec3 src = ( sR * phR + vec3( sM ) * phM ) * tr;

    // Isotropic multiple-scattering approximation. Single scattering alone leaves
    // the shadowed side of the sky and the deep blue zenith far too dark, and
    // makes an overcast sky impossible. Tying it to 'tr' keeps night dark.
    src += ( sR + vec3( sM ) ) * tr * a.msScale * ( 1.0 / ( 4.0 * TC_PI ) ) * 4.0;

    // Analytic integration of a constant source across the step, so 20 steps
    // behave like several hundred midpoint samples.
    vec3 stepT = exp( -ext * ds );
    L += T * ( src - src * stepT ) / max( ext, vec3( 1e-7 ) );
    T *= stepT;
  }

  outT = T;
  return L * a.sunIrradiance + bg * T;
}

/** Radiance of the sky (and the ground beneath it) looking along 'rd'. */
vec3 tcSkyRadiance( vec3 ro, vec3 rd, TCAtmos a, int steps ) {
  float tTop = tcAtmosTop( ro, rd );
  if ( tTop <= 0.0 ) return vec3( 0.0 );
  float tGround = tcGroundHit( ro, rd );
  bool hitGround = tGround > 0.0;
  float tMax = hitGround ? tGround : tTop;

  vec3 bg = vec3( 0.0 );
  if ( hitGround ) {
    // Lambertian ground bounce. This is what puts warm up-light into the
    // environment map — without it every shadowed underside reads dead grey.
    vec3 p = ro + rd * tGround;
    vec3 n = normalize( p );
    float ndl = max( 0.0, dot( n, a.sunDir ) );
    vec3 gt = tcSunTransmittance( p, a );
    bg = a.groundAlbedo * a.sunIrradiance * ( ndl * gt / TC_PI + vec3( 0.02 ) );
  }

  vec3 T;
  return tcScatter( ro, rd, tMax, a, bg, steps, T );
}

/** Position to feed the model, from a camera altitude in metres. */
vec3 tcOrigin( float altitudeMetres ) {
  return vec3( 0.0, TC_PLANET_R + max( 0.0, altitudeMetres ) * 0.001, 0.0 );
}

/**
 * The solar disc. Angular radius 0.2665 deg (mean, 1 AU). Linear limb darkening
 * with u = 0.6, the visible-band value — the edge of the disc is ~40 % dimmer
 * than the centre, which is what stops it reading as a flat white sticker.
 */
float tcSunDisc( float mu ) {
  float cosR = 0.99998917; // cos(0.2665 deg)
  if ( mu < cosR ) return 0.0;
  // Normalised radius across the disc.
  float r = sqrt( max( 0.0, 1.0 - mu * mu ) ) / 0.004652;
  return 1.0 - 0.6 * ( 1.0 - sqrt( max( 0.0, 1.0 - min( 1.0, r * r ) ) ) );
}
`;
