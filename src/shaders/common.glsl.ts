/**
 * Shared GLSL for the hand-rolled post chain: depth reconstruction, AgX tone
 * mapping, output transfer functions and cheap hashes.
 *
 * Kept separate from the passes so there is exactly one definition of each — a
 * second, subtly different depth linearisation is the classic source of AO that
 * halos at one distance and vanishes at another.
 */

/** Depth-buffer -> view space -> world space. */
export const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 tcCamera;     // x: near, y: far, z: 1/near, w: 1/far
uniform mat4 tcInvProj;    // camera.projectionMatrixInverse
uniform mat4 tcCamWorld;   // camera.matrixWorld

// Positive distance along -Z. Non-linear depth in, metres out.
float tcViewZ( float d ) {
  // Standard perspective un-projection; matches three's <packing> chunk.
  return ( tcCamera.x * tcCamera.y ) / ( ( tcCamera.y - tcCamera.x ) * d - tcCamera.y );
}

float tcLinear01( float d ) {
  return -tcViewZ( d ) * tcCamera.w;
}

vec3 tcViewPos( vec2 uv, float d ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = tcInvProj * clip;
  return v.xyz / v.w;
}

vec3 tcWorldPos( vec2 uv, float d ) {
  return ( tcCamWorld * vec4( tcViewPos( uv, d ), 1.0 ) ).xyz;
}

/**
 * View-space normal reconstructed from depth. Uses the "best of 4 taps" trick
 * (Wicked Engine / Sousa): picking the closest horizontal and vertical neighbour
 * avoids the smeared normals a naive central difference produces on silhouettes,
 * which is exactly where AO artefacts are most visible.
 */
vec3 tcNormalFromDepth( vec2 uv, vec2 texel, float d, vec3 vp ) {
  float dl = texture2D( tDepth, uv - vec2( texel.x, 0.0 ) ).x;
  float dr = texture2D( tDepth, uv + vec2( texel.x, 0.0 ) ).x;
  float dd = texture2D( tDepth, uv - vec2( 0.0, texel.y ) ).x;
  float du = texture2D( tDepth, uv + vec2( 0.0, texel.y ) ).x;

  vec3 h = abs( dl - d ) < abs( dr - d )
    ? vp - tcViewPos( uv - vec2( texel.x, 0.0 ), dl )
    : tcViewPos( uv + vec2( texel.x, 0.0 ), dr ) - vp;
  vec3 v = abs( dd - d ) < abs( du - d )
    ? vp - tcViewPos( uv - vec2( 0.0, texel.y ), dd )
    : tcViewPos( uv + vec2( 0.0, texel.y ), du ) - vp;

  return normalize( cross( h, v ) );
}
`;

/** AgX tone mapping, lifted from three's `tonemapping_pars_fragment` so taking
 *  over the present does not change the look of the curve. */
export const AGX_GLSL = /* glsl */ `
const mat3 TC_REC2020_TO_SRGB = mat3(
  vec3(  1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876,  1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083,  1.1187 )
);
const mat3 TC_SRGB_TO_REC2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 )
);

vec3 tcAgxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2
    - 40.14 * x4 * x
    + 31.96 * x4
    - 6.868 * x2 * x
    + 0.4298 * x2
    + 0.1191 * x
    - 0.00232;
}

vec3 tcAgX( vec3 color, float exposure ) {
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
  );
  const mat3 outset = mat3(
    vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 )
  );
  const float minEv = -12.47393;
  const float maxEv = 4.026069;

  color *= exposure;
  color = TC_SRGB_TO_REC2020 * color;
  color = inset * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - minEv ) / ( maxEv - minEv );
  color = clamp( color, 0.0, 1.0 );
  color = tcAgxContrast( color );
  color = outset * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  color = TC_REC2020_TO_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}
`;

/** sRGB OETF. Needed because a raw ShaderMaterial gets no `<colorspace_fragment>`. */
export const SRGB_GLSL = /* glsl */ `
vec3 tcLinearToSRGB( vec3 c ) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow( max( c, vec3( 0.0031308 ) ), vec3( 0.41666667 ) ) - 0.055;
  return mix( lo, hi, step( vec3( 0.0031308 ), c ) );
}
`;

/** Hashes / dither. */
export const HASH_GLSL = /* glsl */ `
float tcHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// Interleaved gradient noise (Jimenez 2014) — the right dither for temporally
// accumulated sampling because its spectrum is flat under a TAA box filter.
float tcIGN( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

float tcLuma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;

/** Vertex shader every fullscreen pass shares. */
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;
