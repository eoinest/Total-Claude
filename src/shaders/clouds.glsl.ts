/**
 * Volumetric-looking cloud layers.
 *
 * Two spherical shells (cumulus at ~1.7 km, cirrus at ~7 km) intersected by the
 * view ray, with density from a packed multi-octave noise texture and a 3-tap
 * Beer–Lambert march toward the sun for the silver lining. A true 3D raymarch is
 * not affordable next to 2 500 animated men; the shell trick keeps the two cues
 * that actually sell clouds — perspective convergence toward the horizon and
 * parallax as the camera pans — while costing ~6 texture fetches per sky pixel.
 *
 * The noise texture packs four octaves into RGBA at the *same* uv, so one fetch
 * yields a 4-octave fBm. See `makeCloudNoise` in SkySystem.
 */

/** Coverage field shared by the sky dome and the cloud-shadow term in materials. */
export const CLOUD_FIELD_GLSL = /* glsl */ `
// uv is world metres * scale, already wind-offset.
float tcCloudFbm( sampler2D tex, vec2 uv ) {
  vec4 n = texture2D( tex, uv );
  // Weights halve per octave (classic 1/f fBm) and sum to 1.
  return dot( n, vec4( 0.5333, 0.2667, 0.1333, 0.0667 ) );
}

/**
 * 0 = clear sky, 1 = solid cloud.
 * 'coverage' is the fBm level that becomes cloud edge; raising it clears the sky.
 */
float tcCloudCoverage( sampler2D tex, vec2 uv, float coverage, float softness ) {
  float base = tcCloudFbm( tex, uv );
  // Domain-warped second fetch erodes the blobby base into billows. The warp
  // amplitude is small (6 % of a tile) so the silhouette stays readable.
  vec4 w = texture2D( tex, uv * 0.37 );
  float detail = tcCloudFbm( tex, uv * 3.7 + ( w.gb - 0.5 ) * 0.06 );
  // 'coverage' and 'softness' arrive pre-scaled into raw fBm units by
  // SkySystem.rawCoverage, which measures the noise's actual standard deviation.
  // A four-octave value-noise fBm only spans ~0.12 either side of 0.5, so a
  // threshold expressed in raw values is hypersensitive and hash-dependent.
  float shape = base + ( detail - 0.5 ) * 0.22;
  return smoothstep( coverage, coverage + softness, shape );
}
`;

/** Sky-dome side: shade and composite the two layers over the atmosphere. */
export const CLOUDS_GLSL = /* glsl */ `
// Far intersection with a planet-centred shell, in km. -1 if the ray misses.
float tcShellHit( vec3 p, vec3 dir, float radius ) {
  float b = dot( p, dir );
  float c = dot( p, p ) - radius * radius;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  float t = -b + sqrt( disc );
  return t > 0.0 ? t : -1.0;
}

struct TCCloudLayer {
  float altitude;   // metres above the datum
  float scale;      // world metres -> uv
  vec2  wind;       // uv offset
  float coverage;
  float softness;
  float density;    // optical depth at full coverage
  float absorb;     // how strongly the layer shadows itself
  float anisoY;     // uv stretch on Z, for wind-sheared cirrus
};

/**
 * Returns rgb = cloud radiance, a = coverage alpha.
 * 'camAlt' is camera altitude in metres, 'camXZ' its world ground position.
 */
vec4 tcCloudLayer(
  sampler2D tex, TCCloudLayer L, vec3 rd, vec2 camXZ, float camAlt,
  vec3 sunDir, vec3 sunColour, vec3 skyColour, float mieG
) {
  if ( rd.y <= 0.004 ) return vec4( 0.0 );

  vec3 ro = vec3( 0.0, TC_PLANET_R + camAlt * 0.001, 0.0 );
  float t = tcShellHit( ro, rd, TC_PLANET_R + L.altitude * 0.001 );
  if ( t <= 0.0 ) return vec4( 0.0 );

  vec2 world = camXZ + rd.xz * ( t * 1000.0 );
  vec2 uv = vec2( world.x, world.y * L.anisoY ) * L.scale + L.wind;

  float cov = tcCloudCoverage( tex, uv, L.coverage, L.softness );
  if ( cov <= 0.001 ) return vec4( 0.0 );

  float tau = cov * L.density;

  // --- light march toward the sun, inside the layer ---
  // Quadratic step growth gives a long reach for 3 taps: 260 m, 1.05 km, 2.3 km.
  vec2 sunStep = normalize( sunDir.xz + vec2( 1e-4, 0.0 ) ) * ( 260.0 * L.scale );
  float shade = 0.0;
  shade += tcCloudCoverage( tex, uv + sunStep * 1.0, L.coverage, L.softness );
  shade += tcCloudCoverage( tex, uv + sunStep * 4.0, L.coverage, L.softness ) * 0.6;
  shade += tcCloudCoverage( tex, uv + sunStep * 9.0, L.coverage, L.softness ) * 0.3;
  // Beer's law with a multiple-scattering floor. A cumulus is optically thick
  // enough that single scattering leaves its base at 5e-4 of its top — black.
  // In reality multiply-scattered light holds the base near a fifth of the top,
  // and that floor is the difference between a cloud and a hole in the sky.
  float sunT = mix( 0.2, 1.0, exp( -shade * L.density * L.absorb ) );

  // Dual-lobe phase: a broad back-lobe for the body plus a tight forward lobe
  // that is the silver lining. Real cumuli have a strong forward peak from
  // droplets 10-20 um across. Expressed relative to isotropic (hence 4*pi) and
  // capped, because the un-capped forward lobe peaks near 100x and would turn
  // every cloud within 15 deg of the sun into a white hole.
  float mu = dot( rd, sunDir );
  float phase = mix( tcPhaseM( mu, -0.2 ), tcPhaseM( mu, 0.9 ), 0.5 ) * 4.0 * TC_PI;
  phase = min( phase, 9.0 );

  // Powder term (Bouthors et al.): thin edges scatter more than Beer's law says,
  // which is what keeps cloud rims from looking like cut paper.
  float powder = 1.0 - exp( -tau * 2.4 );

  // 1/pi turns the sun's irradiance into the radiance of a Lambertian cloud
  // face; the 0.55 + 0.42*phase split keeps a diffuse floor under the phase
  // function so the anti-sun side of a cloud is grey, not black.
  vec3 direct = sunColour * ( 1.0 / TC_PI ) * sunT * ( 0.8 + 0.5 * phase )
    * mix( 0.35, 1.0, powder );
  // Ambient from the sky above. Deep interiors see less of it, which gives the
  // deck a shaded base — but only a little, or a thin layer reads as a dark band.
  vec3 ambient = skyColour * mix( 0.95, 0.45, cov );

  float alpha = 1.0 - exp( -tau );
  // Fade the layer out at the horizon: a shell seen edge-on would otherwise be a
  // hard band, and at 150 km the haze has eaten it anyway.
  alpha *= smoothstep( 0.004, 0.055, rd.y );

  return vec4( direct + ambient, alpha );
}
`;

/**
 * Material side: how much of the sun a cloud is blocking at a world position.
 * Injected into `lights_pars_begin` so the CSM shadow term can be multiplied by
 * it — cloud shading then affects only direct sun, exactly like a real cloud.
 */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
#ifdef TC_CLOUD_SHADOW
uniform sampler2D tcCloudNoise;
uniform mat4 tcInvView;
// x: uv scale, yz: wind offset, w: coverage
uniform vec4 tcCloudA;
// x: softness, y: strength, z: layer altitude (m), w: unused
uniform vec4 tcCloudB;
uniform vec3 tcCloudSunDir;

float tcCloudShadow( in vec3 viewPos ) {
  vec3 wp = ( tcInvView * vec4( viewPos, 1.0 ) ).xyz;
  // Project up the sun ray to where it pierces the cloud deck. Clamping the
  // divisor keeps the projection finite as the sun approaches the horizon,
  // where a correct projection would smear to infinity.
  float lift = ( tcCloudB.z - wp.y ) / max( tcCloudSunDir.y, 0.22 );
  vec2 uv = ( wp.xz + tcCloudSunDir.xz * lift ) * tcCloudA.x + tcCloudA.yz;
  float cov = tcCloudCoverage( tcCloudNoise, uv, tcCloudA.w, tcCloudB.x );
  return 1.0 - cov * tcCloudB.y;
}
#else
float tcCloudShadow( in vec3 viewPos ) { return 1.0; }
#endif
`;
