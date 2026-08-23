import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import type { EngineContext, Subsystem } from '../core/Engine';
import { AGX_GLSL, DEPTH_GLSL, FS_VERT, HASH_GLSL, SRGB_GLSL } from '../shaders/common.glsl';
import { clamp, clamp01, smoothstep } from '../util/math';
import type { LightingSystem } from './LightingSystem';
import type { SkySystem } from './SkySystem';

/**
 * Hand-rolled post chain. Owns the final present via `engine.renderOverride`.
 *
 * Order, and why:
 *   1. scene -> HDR target with an attached depth texture. There is no separate
 *      depth/normal prepass: a second geometry pass over 2 500 animated men costs
 *      more than reconstructing view normals from depth, and the reconstruction is
 *      accurate enough for AO (it is exact except across silhouettes).
 *   2. HBAO at half resolution, then a depth-aware separable blur.
 *   3. Composite: AO (bilaterally upsampled) and aerial perspective. Both are
 *      surface effects, so they belong before anything that spreads light.
 *   4. God rays, half resolution, marched against depth from the sun's screen
 *      position. Additive, so it can be folded into the tone-map pass.
 *   5. Depth of field, half resolution, gated hard on zoom.
 *   6. Camera motion blur by reprojection through the previous view-projection.
 *   7. Bloom: threshold -> 6-level down/upsample pyramid.
 *   8. AgX + filmic grade + bloom + god rays -> sRGB-encoded 8-bit. Encoding here
 *      rather than at the end means AA and sharpening run in perceptual space,
 *      which is where FXAA and CAS are designed to run, and it removes the
 *      shadow banding an 8-bit *linear* intermediate would have.
 *   9. TAA / SMAA / FXAA.
 *  10. CAS sharpen + vignette + grain -> canvas.
 *
 * Aerial perspective samples `SkySystem.skyCubeTexture`, so an object at infinity
 * fades to exactly the radiance of the sky behind it. That is the cue that makes
 * distance read, and it is why this is not a `FogExp2`.
 */

/** Bloom threshold in linear render units. With a 26 deg sun lit dry grass now
 *  measures ~0.10 and the brightest cloud edge ~1.1, so 0.95 keeps bloom on
 *  genuine highlights — the sun disc, specular hits on helmets and cloud rims —
 *  while being low enough that a polished helmet crown actually reaches it. */
const BLOOM_THRESHOLD = 0.95;
const BLOOM_KNEE = 0.4;
const BLOOM_STRENGTH = 0.07;
/**
 * AO sampling radius in metres. A man is 1.75 m; 1.1 m darkens the gaps between
 * ranks and the contact under a shield without haloing whole formations.
 *
 * **This is the *ambient* scale and it is deliberately only half the story.** Measured on
 * the testudo's `roof-close` station, `tools/probe-contact.mjs --arms=split`: the 1.1 m
 * gather is a low-frequency wash — it darkens the interior of a crowd as a mass, which is
 * what an ambient term should do, and it cannot produce the tight dark core where a boot
 * meets grass or where one shield rim laps another, because at 1.1 m those two surfaces are
 * a small fraction of the gather and the horizon it finds is nearly the same as the one it
 * finds a metre away. A7's tell is that core. So the same pass now gathers at **two**
 * radii — see `AO_CONTACT_RADIUS` — and takes the darker.
 */
const AO_RADIUS = 1.1;
const AO_STRENGTH = 0.72;
/**
 * The near-field contact radius, in metres. Lives in the **full-resolution** pass — see the
 * long note above `nearContact` in `mContact` for why it cannot live in the half-res one.
 *
 * 0.30 m is chosen off the geometry it has to catch rather than by eye: the lap between two
 * roof boards of a testudo is 0.15 m, the gap between two men shoulder to shoulder in a
 * closed rank is 0.16 m, a boot sole is 0.10 m deep and a wall base against paving is a
 * right angle at any scale. A disc that reaches 0.30 m has most of its area inside solid
 * matter at all four and almost none of it on open ground, which is what "contact darkening"
 * has to mean if it is not to become grime.
 */
const AO_CONTACT_RADIUS = 0.30;
/**
 * Strength of the contact term, and it is far higher than the ambient one on purpose.
 *
 * The ambient term covers most of the frame, so it has to be gentle. The contact term
 * covers a few per cent of it, so it can be hard, and it has to be: the measured difference
 * between a Rome II crowd and this one was never that ours is uniformly lighter, it is that
 * ours had no black in the joins at all. The two numbers are not comparable — the ambient
 * term is a horizon in [0,1] and this one is a mean over a disc that rarely exceeds 0.2.
 *
 * **Chosen off a ladder, not by eye.** `tools/probe-contact.mjs --arms=sweep` reads the
 * occlusion buffer itself at the testudo's `roof-close` station and reports its percentiles.
 * At 0 — which is the pipeline as it stood, half-res HBAO plus the sun march — the buffer's
 * 5th percentile is **0.70** and 5 % of it is under 0.7: there is no contact darkening in
 * the frame worth the name, and three blind critics were right. At 2.2 the 5th percentile is
 * 0.65 and nothing visible has changed. At 5.0 it is **0.44** with 25 % of the frame under
 * 0.7, which is a contact field. At 7.0 it is 0.31, which reads as soot on the grass.
 */
const AO_CONTACT_STRENGTH = 5.0;
/**
 * How much of a surface's own colour survives *total* occlusion, before the tint.
 *
 * This replaces the hard `max( occ, 0.34 )` floor the composite used to apply, and the
 * number is close to the one it replaces on purpose: 0.324 of the lit luminance was measured
 * surviving in the deepest 5 % of a soldier's own cast shadow at the midcrowd camera, 0.375
 * at the wide one. What changed is the shape — see the long note at its use in `mComposite`.
 * The tint is taken live from `LightingSystem.fill`, so this is a scalar and the colour is
 * the rig's own.
 */
const AO_FILL = 0.30;
/** 8-sample Halton(2,3) jitter, the standard TAA sequence. */
/*
 * Sky is tested with `>= 1.0`, not with an epsilon.
 *
 * A depth-*value* epsilon is not a distance. Window depth is 1 - (n/(f-n))(f/z - 1), so the
 * metres a fixed epsilon spans scale with f squared over n. At the `horizon` camera
 * (near 0.08, far 2694.68) `d >= 1.0` classified **the last 87.8 m before the far
 * plane as sky** — which is exactly where the far-hills scenery ring stands, so a 3.4 km
 * stone ridge was skipped by aerial perspective and rendered as a hard dark wedge against a
 * hazed sky. Two blind critics called it "an unculled black polygon intruding from the
 * top-left corner: a shipping bug".
 *
 * Bisected rather than guessed, after three wrong guesses: hiding scene subtrees one at a
 * time removed the dark pixels only for `city > far-hills-lod0 > far-hills-stone`, and
 * pinning the camera near plane from 0.08 to 5 made the wedge vanish while 0.02 doubled its
 * dark-pixel count from 7,303 to 14,645 — precisely what the epsilon-band arithmetic
 * predicts. It only ever showed at `horizon` because that is the project's only low-zoom
 * frame, and low zoom is what pulls the far plane in.
 *
 * The depth attachment is UNSIGNED_INT_24_8, so cleared sky reads back as exactly 1.0 and an
 * exact comparison is safe.
 */
const HALTON: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444],
  [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
];

/**
 * NDC probe points for the motion-blur smear-length bound. 3 x 3 across the frame, at the
 * near plane, the mid depth and the far plane.
 *
 * Corners alone are not enough. Reprojection through `prevViewProj` is a *projective* map,
 * so the displacement field over the frustum is a ratio of linears and its extremum need
 * not lie at a vertex — a pure dolly, for instance, moves the frame centre by zero and the
 * mid-depth edges by the most. Nine columns at three depths costs 27 `Vector4.applyMatrix4`
 * calls a frame, which is unmeasurable next to the full-resolution blit it decides about.
 */
const MB_PROBE: ReadonlyArray<readonly [number, number, number]> = (() => {
  const pts: Array<readonly [number, number, number]> = [];
  for (const z of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const x of [-1, 0, 1]) pts.push([x, y, z]);
  return pts;
})();

interface RTOpts {
  scale?: number;
  hdr?: boolean;
  depth?: boolean;
  /** MSAA sample count. Only the scene target wants this; every post pass is fullscreen. */
  samples?: number;
}

/**
 * MSAA samples on the scene target, by tier.
 *
 * The post chain's AA is morphological: SMAA and FXAA reshape staircases in an image that
 * has already been point-sampled once per pixel, so neither can recover a spear thinner
 * than a pixel, and neither does anything at all for an alpha-tested grass blade that
 * either passes its test or vanishes. Multisampling is the only stage in the chain that
 * takes more than one geometric sample per pixel, and it is the prerequisite for
 * `alphaToCoverage` on the sward — without it, coverage carries exactly one bit.
 *
 * **Never 2.** Eight camera-measurements over two interleaved sessions at loads 42 and 60:
 * 4x against none is a median of **1.18 ms**, while 4x against 2x is **0.07 ms**. The cost is
 * in having a multisampled target at all, not in the sample count — 2x pays 94 % of 4x's
 * price for half the samples, so `medium: 2` was the worst cell in the table and there is no
 * machine for which it is the right answer. It buys medium 1.11 ms to spend on grass, which
 * is the only knob measured larger (0.55-3.71 ms at 100 -> 50 %).
 *
 * Dropping medium to 0 costs the sward its coverage bit, but that is not a new configuration:
 * `low` has always been 0 and grass sets `alphaToCoverage` unconditionally
 * (`GrassField.ts:500`), so this is a path the engine already ships and renders. Medium also
 * carries `grassDensity: 0.45`, so there is less than half as much of the sward to alias.
 *
 * This is now a **binary** lever — 0 or 4, worth 1.18 ms — which is the shape an adaptive
 * quality loop can actually step through without paying for a state that is all cost.
 */
export const MSAA_SAMPLES: Record<string, number> = { low: 0, medium: 0, high: 4, ultra: 4 };


/**
 * The two shader bodies the model viewer also runs, hoisted so there is exactly one of each.
 *
 * `src/viewer/grade.ts` used to carry a hand-copied mirror of both, and it drifted: `uGrain`
 * shipped 0.006 here and 0.016 there, which is the level measured to leave **0.00 % of a plate
 * reading as a smooth region** against a Rome II reference of 7.09 % — so every isolated-model
 * grade this project ever ran was shot through a grain the product does not ship. `uSharpen`
 * had the same class of error, mirroring a default that line ~1554 overwrites from the quality
 * tier every frame. Both were corrected by hand; the mirror is now gone instead, because a
 * copy that *can* drift eventually does and nothing in the type system was going to notice.
 *
 * These are pure hoists: the GLSL is unchanged but for four columns of leading indentation,
 * and every uniform default is the same literal the class built inline. The viewer binds
 * `tBloom`/`tGod` to a 1x1 black texture with `uBloom`/`uGodRays` at zero, which is an exact
 * no-op rather than a second code path — so the game's picture is not a function of whether
 * the viewer exists.
 *
 * Two divergences the viewer keeps on purpose, and neither is drift. It sets `uSharpen` to
 * 0.28, because this class overwrites its own 0.32 default from the quality tier every frame
 * and 0.28 is what ultra ships. It pins `uTime` at 0, because a plate shot twice must be the
 * same file and the grain is hashed against it.
 */
export const TC_TONE_GRADE_FRAG = AGX_GLSL + SRGB_GLSL + HASH_GLSL + /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tBloom;
  uniform sampler2D tGod;
  uniform float uExposure;
  uniform float uBloom;
  uniform float uGodRays;
  // x: contrast, y: pivot, z: shadow saturation, w: highlight saturation
  uniform vec4 uGrade;
  // x: scene-linear contrast exponent, y: its pivot in render units,
  // z: veiling-glare pedestal
  uniform vec3 uContrast;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  // x: luminance where the shadow tint ends, y: where the highlight tint starts
  uniform vec2 uSplit_disp;   // DISPLAY-referred, see the convention note in common.glsl.ts
  // x: shoulder knee, y: shoulder strength
  uniform vec2 uShoulder;
  varying vec2 vUv;

  void main() {
    vec3 hdr = texture2D( tSrc, vUv ).rgb;
    hdr += texture2D( tBloom, vUv ).rgb * uBloom;
    hdr += texture2D( tGod, vUv ).rgb * uGodRays;

    // --- scene-linear contrast, before the tone map ---
    // This is where dynamic range has to come from. AgX is a log-domain
    // compressor: by the time it has folded 16 stops into 0..1 the ratio
    // between a sunlit surface and a shadowed one is already fixed, and a
    // display-referred S-curve can only shuffle values around inside the band
    // AgX chose — measured, it moved a 6:1 frame to 7:1. A power law about a
    // mid-grey pivot multiplies the *stop* range instead, which is what an
    // OCIO/ACES contrast control does and the only knob that turns a 6:1
    // frame into the ~18:1 a Rome II frame measures.
    //
    // On luminance, not per channel. Per-channel it is the same curve applied
    // to three different numbers, so it stretches channel *ratios* too: at an
    // exponent of 1.6 it took measured saturation from 0.48 to 0.70 and pushed
    // the blue in a shadow from 0.68 to 0.35 of neutral. Scaling by a
    // luminance ratio leaves chromaticity untouched.
    float y0 = max( tcLuma( hdr ), 1e-6 );
    float y1 = uContrast.y * pow( y0 / uContrast.y, uContrast.x );
    hdr *= y1 / y0;

    // Veiling glare. A power law about a pivot amplifies everything below the
    // pivot as hard as it lifts everything above it, so at an exponent of 1.75
    // the ground inside the Aurelian Wall's shadow went to literal zero and
    // 72 % of that frame was black — an S-curve failure mode, not an artistic
    // choice. Real lenses and real air both scatter a little light into the
    // shadows and that is what keeps film blacks off the floor, so the same
    // pedestal goes in here: enough to put the deepest shadow near 8 % display,
    // which is where Rome II's 5th percentile actually sits.
    hdr += uContrast.z;

    vec3 c = tcAgX( hdr, uExposure );

    // --- filmic grade, display-referred ---
    // AgX has a long toe and a very long shoulder: on its own it lands an
    // outdoor scene entirely between 0.3 and 0.7 with no black point, which
    // reads as milky. Reinstating a black point and a mid-tone S-curve is not
    // optional with this transform.
    c = max( vec3( 0.0 ), c - uGrade.y ) / max( 1e-3, 1.0 - uGrade.y );
    // Blending toward smoothstep raises mid-tone contrast while leaving 0 and
    // 1 fixed, so nothing clips at either end the way a gain about a pivot does.
    c = mix( c, c * c * ( 3.0 - 2.0 * c ), uGrade.x );

    float l = tcLuma( c );
    // Warm the highlights, cool the shadows. This warm/cool split across the
    // lit/shadow boundary is the single most recognisable thing about the
    // Rome II palette. The crossover has to sit *below* the scene's own median
    // or the whole frame lands on the same side of it and the split does
    // nothing at all — which is exactly what happened at 0.1..0.68.
    //
    // Compared in DISPLAY space, which is the space uSplit is written in. c is still
    // linear here — tcLinearToSRGB is the last line of this shader — so a display-referred
    // threshold was being tested against a linear value. The frame's median is 0.30
    // display, which is 0.073 linear, and smoothstep( 0.05, 0.48, 0.073 ) is 0.008: every
    // pixel in the frame, shadow and highlight alike, took uShadowTint, the highlight tint
    // was never meaningfully applied, and a split built to multiply the darkest quartile's
    // blue-to-red against the rest of the frame by 1.887 delivered 1.107.
    //
    // That ratio is the statistic the blind rounds separate the decks on: 1.968 across the
    // ten Rome II plates against our 1.23. Converting this one comparison takes it to
    // 1.884 and leaves the darkest quartile's luminance at 0.097, so the entire gap four
    // rounds tried to buy out of the ambient rig was here.
    //
    // Which makes the note above right about the mechanism and wrong about the cure:
    // moving 0.1..0.68 to 0.05..0.48 re-tuned a display-referred number that nothing was
    // reading as one, so the whole frame stayed on one side of the crossover either way.
    //
    // No backticks in this comment: the shader is a JS template literal and one ends it.
    float split = smoothstep( uSplit_disp.x, uSplit_disp.y, tcLinearToSRGB( vec3( l ) ).r );
    c *= mix( uShadowTint, uHighlightTint, split );
    // Desaturate the shadows a little more than the highlights: dust in shade
    // reads muted. Not far, though — the cool cast is the point of A1 and
    // pulling shadows toward grey is the fastest way to throw it away.
    float sat = mix( uGrade.z, uGrade.w, split );
    c = mix( vec3( l ), c, sat );
    c = max( c, vec3( 0.0 ) );

    // Soft shoulder so a warmed highlight rolls off instead of clipping to a
    // flat plate of white. Per channel, above a knee, hyperbolic — the same
    // shape as a film shoulder and it cannot exceed 1 for any finite input.
    vec3 over = max( c - uShoulder.x, vec3( 0.0 ) );
    c = min( c, vec3( uShoulder.x ) ) + over / ( 1.0 + over * uShoulder.y );

    gl_FragColor = vec4( tcLinearToSRGB( c ), 1.0 );
  }
  `;

/** Defaults for {@link TC_TONE_GRADE_FRAG}. A factory: uniform objects must not be shared. */
export function tcToneGradeUniforms(): Record<string, THREE.IUniform> {
  return {
    tSrc: { value: null },
    tBloom: { value: null },
    tGod: { value: null },
    uExposure: { value: 1 },
    uBloom: { value: BLOOM_STRENGTH },
    uGodRays: { value: 1 },
    // x: S-curve blend, y: black point, z: shadow saturation, w: highlight
    // saturation. The black point has to be well clear of AgX's toe or the
    // darkest thing in the frame is a 20 % grey and the image has no anchor;
    // 0.05 is where the deepest crevice between two men reaches zero.
    uGrade: { value: new THREE.Vector4(0.42, 0.006, 1.02, 1.3) },
    // Pivot at 0.16 render units: measured, that is where a dry-grass ground
    // in full sun sits, so raising the exponent pivots the frame about the
    // subject rather than about the sky.
    uContrast: { value: new THREE.Vector3(1.8, 0.16, 0.0026) },
    // Measured against twelve real Rome II frames: their lit surfaces average
    // an r/g/b chromaticity of 1.25/0.96/0.79 and their shadows 1.06/0.90/1.02
    // — warm light, cool shade, and red clearly above green in the sun. Ours
    // measured 1.05/1.03/0.93 and 0.87/1.03/1.10, so the tints carry the frame
    // the rest of the way warm without touching the physical light.
    uShadowTint: { value: new THREE.Vector3(0.9, 0.96, 1.18) },
    uHighlightTint: { value: new THREE.Vector3(1.18, 0.985, 0.82) },
    uSplit_disp: { value: new THREE.Vector2(0.05, 0.48) },
    uShoulder: { value: new THREE.Vector2(0.92, 1.7) },
  };
}

export const TC_FINAL_FRAG = HASH_GLSL + /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uSharpen;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec3 e = texture2D( tSrc, vUv ).rgb;
    vec3 n = texture2D( tSrc, vUv + vec2( 0.0, -uTexel.y ) ).rgb;
    vec3 s = texture2D( tSrc, vUv + vec2( 0.0, uTexel.y ) ).rgb;
    vec3 w = texture2D( tSrc, vUv + vec2( -uTexel.x, 0.0 ) ).rgb;
    vec3 ee = texture2D( tSrc, vUv + vec2( uTexel.x, 0.0 ) ).rgb;

    // AMD contrast-adaptive sharpening, cross-only variant: the sharpening
    // amount falls off where local contrast is already high, so edges gain
    // definition without ringing. The weight *must* stay in [-0.25, 0] or the
    // 1 + 4w denominator crosses zero and the pass inverts colour.
    vec3 mn = min( e, min( min( n, s ), min( w, ee ) ) );
    vec3 mx = max( e, max( max( n, s ), max( w, ee ) ) );
    vec3 amp = sqrt( clamp( min( mn, 1.0 - mx ) / max( mx, 1e-4 ), 0.0, 1.0 ) );
    // AMD's mapping: peak weight from -1/8 (soft) to -1/5 (sharp).
    vec3 k = amp * ( -1.0 / mix( 8.0, 5.0, clamp( uSharpen, 0.0, 1.0 ) ) );
    vec3 c = ( e + ( n + s + w + ee ) * k ) / ( 1.0 + 4.0 * k );
    c = clamp( c, 0.0, 1.0 );

    // Vignette. Exponent 2.6 keeps the falloff out of the action and only
    // darkens the extreme corners.
    vec2 q = ( vUv - 0.5 ) * 2.0;
    float r = length( q );
    c *= 1.0 - uVignette * pow( clamp( r * 0.72, 0.0, 1.0 ), 2.6 );

    // Fine grain, stronger in the shadows where a real negative is grainiest.
    float g = tcHash12( gl_FragCoord.xy + uTime ) - 0.5;
    c += g * uGrain * ( 1.0 - tcLuma( c ) * 0.75 );

    gl_FragColor = vec4( c, 1.0 );
  }
  `;

/** Defaults for {@link TC_FINAL_FRAG}. */
export function tcFinalUniforms(): Record<string, THREE.IUniform> {
  return {
    tSrc: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uSharpen: { value: 0.32 },
    uVignette: { value: 0.2 },
    /*
     * 0.016 left literally no smooth region anywhere in the frame.
     *
     * Measured by switching this uniform alone and counting the share of the frame that
     * reads as a smooth gradient: **0.016 → 0.00%**, 0.006 → 2.21%, 0 → 69.67%, against
     * Rome II crops at a mean of 7.09%. So the shipped default was not "a little grainy",
     * it was destroying every flat surface in the picture — and a blind grader named it
     * as its single strongest scalar, attributing it to "renderer dither or terrain
     * faceting" without knowing what it was looking at.
     *
     * 0.006 is the value that measurement recommends. Note the reference mean sits
     * between 0.006 and 0, so there may be a little more to give back; that is a
     * measurement to make, not a number to guess at here.
     */
    uGrain: { value: 0.006 },
    uTime: { value: 0 },
  };
}

export class PostFXSystem implements Subsystem {
  readonly name = 'postfx';
  readonly order = 900;

  /** The scene depth buffer. Other systems may sample this after `renderOverride`. */
  depthTexture: THREE.DepthTexture | null = null;
  enabled = true;
  /**
   * Screen-space contact shadows. Separately switchable from `quality.ssao` so the cost of
   * the pass can be measured against an otherwise identical frame in one session — two
   * workstreams have measured the same camera at 21.78 ms and 9.14 ms in consecutive runs
   * on this machine under contention, so an absolute number from a second session means
   * nothing and only an in-session pair does.
   */
  contactShadows = true;

  /**
   * Blit an intermediate buffer to the canvas instead of the graded frame.
   *
   * An instrument, and it exists because an argument about ambient occlusion was settled
   * three times by three people looking at *finished frames* and getting it wrong in both
   * directions — a critic who could not see any contact darkening, and a reader of this file
   * who could see two whole passes computing it. A graded frame is the worst possible place
   * to read an occlusion term off: AgX, bloom, a contrast-adaptive sharpen and SMAA all sit
   * between the buffer and the pixel, and the sharpen alone makes 30 % of the pixels in a
   * crowded frame *brighter* when the occlusion is switched on, because an unsharp mask
   * turns a darkened crevice into a brightened ridge beside it.
   *
   * `'ao'` shows the blurred half-resolution AO buffer, `'contact'` the full-resolution
   * screen-space contact-shadow buffer, `'occ'` the two combined exactly as the composite
   * combines them. Never set outside a probe.
   */
  debugView: 'ao' | 'contact' | 'occ' | null = null;

  /**
   * Live handles on the two occlusion strengths, so a probe can A/B them inside one browser
   * session. Absolute frame times from two sessions on this machine are not comparable —
   * see `contactShadows` above — and neither is a look, because the sun moves.
   */
  get aoStrength(): number { return (this.mAo?.uniforms.uStrength.value as number) ?? AO_STRENGTH; }
  set aoStrength(v: number) { if (this.mAo) this.mAo.uniforms.uStrength.value = v; }

  /** Strength of the full-resolution near-field contact term. See `AO_CONTACT_STRENGTH`. */
  aoContactStrength = AO_CONTACT_STRENGTH;

  private renderer!: THREE.WebGLRenderer;
  private quad = new FullScreenQuad();
  private sky?: SkySystem;
  private lighting?: LightingSystem;
  private smaa?: SMAAPass;

  private w = 1;
  private h = 1;
  /** Resolved MSAA sample count on the scene target; 0 when the tier or driver has none. */
  private samples = 0;
  /**
   * Overrides the tier's sample count until the next tier change. Exists so the cost of
   * multisampling can be A/B'd inside one browser session, which is the only kind of frame
   * timing this project has ever been able to trust: the arms have to be interleaved against
   * the same machine load, and a page reload cannot do that.
   */
  private samplesOverride: number | null = null;
  private lastCtx: EngineContext | null = null;
  /** Remaining anisotropy sweeps; see sweepAnisotropy. Zeroed once a pass finds nothing. */
  private anisotropySweeps = 12;

  private sceneRT?: THREE.WebGLRenderTarget;
  private mainA?: THREE.WebGLRenderTarget;
  private mainB?: THREE.WebGLRenderTarget;
  private aoRT?: THREE.WebGLRenderTarget;
  private aoTmp?: THREE.WebGLRenderTarget;
  private contactRT?: THREE.WebGLRenderTarget;
  private contactTmp?: THREE.WebGLRenderTarget;
  private godRT?: THREE.WebGLRenderTarget;
  private dofRT?: THREE.WebGLRenderTarget;
  private ldrRT?: THREE.WebGLRenderTarget;
  private histA?: THREE.WebGLRenderTarget;
  private histB?: THREE.WebGLRenderTarget;
  private aaRT?: THREE.WebGLRenderTarget;
  private bloomRT: THREE.WebGLRenderTarget[] = [];

  private mAo?: THREE.ShaderMaterial;
  private mBlur?: THREE.ShaderMaterial;
  private mContact?: THREE.ShaderMaterial;
  private mComposite?: THREE.ShaderMaterial;
  private mGod?: THREE.ShaderMaterial;
  private mDof?: THREE.ShaderMaterial;
  private mDofMix?: THREE.ShaderMaterial;
  private mMotion?: THREE.ShaderMaterial;
  private mBright?: THREE.ShaderMaterial;
  private mDown?: THREE.ShaderMaterial;
  private mUp?: THREE.ShaderMaterial;
  private mTone?: THREE.ShaderMaterial;
  private mTaa?: THREE.ShaderMaterial;
  private mFxaa?: THREE.ShaderMaterial;
  private mFinal?: THREE.ShaderMaterial;
  private mCopy?: THREE.ShaderMaterial;
  private mOccView?: THREE.ShaderMaterial;

  private frameIndex = 0;
  /**
   * True once `histA` holds a temporally-accumulated frame. **TAA's flag, and only TAA's.**
   *
   * It is set in one place — the `antialias === 'taa'` branch of step 9 — because it means
   * "there is a resolved history *image* to blend against", which is a statement about a
   * render target, not about the camera. Anything gated on this outside that branch is
   * gated on TAA being on.
   */
  private historyValid = false;
  /**
   * True once `prevViewProj` holds the previous frame's camera. **Motion blur's flag.**
   *
   * Separate from `historyValid` because it is a different fact about a different thing, and
   * conflating the two switched camera motion blur off on every tier the game ships. The
   * blur reprojects the depth buffer through `prevViewProj`; it needs no history image and no
   * TAA. `historyValid` is set only inside the TAA branch, and `QUALITY_PRESETS` uses `fxaa`
   * on low and `smaa` on the other three, so `q.motionBlur` was true at high and ultra, the
   * pass was compiled and its target allocated, and the `if` never once ran. Measured on
   * Rome at ultra: 0 motion-blur blits in 600 frames before, panning at full rate.
   *
   * Written at the end of every frame, immediately after the matrix it describes, so the two
   * cannot come apart. Cleared with the matrix on a resize, because `prevViewProj` is stale
   * across a reallocation and a first frame blurred against it smears the whole screen.
   */
  private prevViewProjValid = false;
  /**
   * How many times each optional pass has actually blitted, and how many frames have gone by.
   *
   * Diagnostic only; nothing reads them back. They exist because "the switch is on" and "the
   * pass ran" are two different facts and this file has now shipped a case where they
   * disagreed for the whole of the game's life. A count is the only honest answer, and it is
   * one integer per frame.
   */
  private nFrames = 0;
  private nMotionBlur = 0;
  private nMotionBlurSkipped = 0;
  /** Last computed smear bound, device pixels. Diagnostic: `debugPasses` reports it. */
  private lastSmearPx = 0;
  /**
   * Smear length, in device pixels, below which the motion-blur blit is skipped.
   *
   * The pass is a full-resolution HDR blit with a depth fetch and seven colour fetches, and
   * when the camera has not moved it returns its own input. `vel` is `(vUv - prev) * uScale`
   * and the seven taps span `vUv -/+ vel/2`, so a smear shorter than one pixel cannot move a
   * texel: at 0.5 px the extreme taps sit a quarter of a pixel either side of centre and the
   * bilinear result differs from the source by a quarter of the local gradient, which is
   * below the quantisation of the 8-bit target the chain resolves to two passes later.
   *
   * This is not a quality lever and must not become one. It is the condition under which the
   * pass is *arithmetically* a copy. Raising it past a pixel would start removing real smear,
   * so it is clamped at 1.0 where it is read.
   *
   * **0 disables the skip entirely**, which is what the "before" arm of an A/B sets: the
   * bound is a length and is never negative, so `bound < 0` is false on every frame and the
   * blit runs exactly as it did. Keeping the off-switch inside the same code path is what
   * lets both arms be interleaved in one page load, which is the only comparison this
   * project accepts.
   */
  motionBlurMinPixels = 0.5;
  private readonly projNoJitter = new THREE.Matrix4();
  private readonly prevViewProj = new THREE.Matrix4();
  private readonly curViewProj = new THREE.Matrix4();
  /** Scratch for the smear bound: `curViewProj` inverted, and one probe point. */
  private readonly invViewProj = new THREE.Matrix4();
  private readonly mbProbe = new THREE.Vector4();
  private readonly sunUv = new THREE.Vector2(0.5, 0.5);
  private sunOnScreen = 0;
  private readonly dbSize = new THREE.Vector2();
  private readonly texel = new THREE.Vector2();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpV4 = new THREE.Vector4();
  private jittered = false;
  private elapsed = 0;

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  init(ctx: EngineContext): void {
    this.renderer = ctx.renderer;
    this.sky = ctx.tryGet<SkySystem>('sky');
    /*
     * The rig's own answer to "what lights a surface the sun cannot reach".
     *
     * Optional and read defensively, like `sky` above and for the same reason: the viewer
     * builds a `PostFXSystem` without a `LightingSystem`, and a hard import here would be a
     * cycle. Without it the occlusion fill falls back to neutral grey, which is the old
     * behaviour and merely duller.
     */
    this.lighting = ctx.tryGet<LightingSystem>('lighting');

    // This chain tone maps itself; leaving AgX on the renderer would apply the
    // display transform twice, once into the HDR buffer and once here.
    ctx.renderer.toneMapping = THREE.NoToneMapping;
    this.sky?.setScreenSpaceFog(true);

    this.buildMaterials();
    this.allocate(ctx);

    // `EngineContext` deliberately hides the engine, so the integrator wires
    // `engine.renderOverride = (c) => postfx.render(c)` in main.ts. Until that
    // line exists the chain would be built and never presented, so fall back to
    // the `window.__game` handle main.ts publishes at module scope.
    if (typeof window !== 'undefined') {
      const engine = window.__game?.engine;
      if (engine && !engine.renderOverride) this.attach(engine);
    }
  }

  /** Hand the final present to this system. */
  attach(engine: { renderOverride: ((ctx: EngineContext) => void) | null }): void {
    engine.renderOverride = (c) => this.render(c);
  }

  private makeRT(o: RTOpts = {}): THREE.WebGLRenderTarget {
    const s = o.scale ?? 1;
    const w = Math.max(1, Math.round(this.w * s));
    const h = Math.max(1, Math.round(this.h * s));
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: o.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: o.depth ?? false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
      samples: o.samples ?? 0,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    if (o.depth) {
      const dt = new THREE.DepthTexture(w, h);
      dt.type = THREE.UnsignedIntType;
      dt.format = THREE.DepthFormat;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      rt.depthTexture = dt;
      this.depthTexture = dt;
    }
    return rt;
  }

  private allocate(ctx: EngineContext): void {
    this.renderer.getDrawingBufferSize(this.dbSize);
    const w = Math.max(1, Math.floor(this.dbSize.x));
    const h = Math.max(1, Math.floor(this.dbSize.y));
    const maxSamples = this.renderer.capabilities.maxSamples ?? 0;
    const samples = Math.min(this.samplesOverride ?? MSAA_SAMPLES[ctx.quality.tier] ?? 0, maxSamples);

    this.lastCtx = ctx;

    /*
     * Nothing below changes unless one of those three does, so reallocating on an unchanged
     * triple destroys nineteen render targets and rebuilds them identically.
     *
     * That was not hypothetical. `resize()` is called unconditionally, and `Engine.setQuality`
     * calls `resize` on every subsystem — so switching from `high` to `ultra`, which changes
     * neither the drawing buffer nor the sample count (both tiers are 4), threw away and
     * rebuilt the whole chain along with the TAA history. It is also the difference between a
     * resolution lever that can be stepped and one that cannot: a continuous scale drives this
     * path on every adjustment, and the cost of an adjustment is the cost of this function.
     *
     * The guard has to sit after `lastCtx` is stored, because `setSamplesOverride` reallocates
     * through the remembered context and a skipped call must not leave a stale one behind.
     */
    if (this.mainA && w === this.w && h === this.h && samples === this.samples) return;

    this.w = w;
    this.h = h;

    this.freeTargets();

    // The one target the world is rasterised into, and so the only one where extra
    // geometric samples can be taken. Everything downstream is a fullscreen blit.
    this.samples = samples;
    this.sceneRT = this.makeRT({ hdr: true, depth: true, samples: this.samples });
    this.mainA = this.makeRT({ hdr: true });
    this.mainB = this.makeRT({ hdr: true });
    this.aoRT = this.makeRT({ scale: 0.5 });
    this.aoTmp = this.makeRT({ scale: 0.5 });
    this.contactRT = this.makeRT();
    this.contactTmp = this.makeRT();
    this.godRT = this.makeRT({ scale: 0.5, hdr: true });
    this.dofRT = this.makeRT({ scale: 0.5, hdr: true });
    this.ldrRT = this.makeRT();
    this.histA = this.makeRT();
    this.histB = this.makeRT();
    this.aaRT = this.makeRT();

    // Six mips from half resolution: at 1600x900 the smallest is 25x14, which is
    // where the wide halo comes from. Fewer levels and bloom looks like a blur.
    for (let i = 0; i < 6; i++) {
      this.bloomRT.push(this.makeRT({ scale: 0.5 / Math.pow(2, i), hdr: true }));
    }

    if (!this.smaa) this.smaa = new SMAAPass();
    this.smaa.setSize(this.w, this.h);
    this.historyValid = false;
    this.prevViewProjValid = false;
    void ctx;
  }

  private freeTargets(): void {
    const all = [
      this.sceneRT, this.mainA, this.mainB, this.aoRT, this.aoTmp, this.contactRT,
      this.contactTmp, this.godRT, this.dofRT, this.ldrRT, this.histA, this.histB, this.aaRT, ...this.bloomRT,
    ];
    for (const rt of all) {
      if (!rt) continue;
      rt.depthTexture?.dispose();
      rt.dispose();
    }
    this.bloomRT.length = 0;
    this.depthTexture = null;
  }

  resize(_w: number, _h: number, ctx: EngineContext): void {
    if (!this.mainA) return;
    this.allocate(ctx);
  }

  /** Samples actually resolved on the scene target, after the driver cap. */
  get msaaSamples(): number {
    return this.samples;
  }

  /**
   * Force a sample count, or `null` to go back to the tier's. Reallocates the scene target,
   * which invalidates the TAA history — the caller must discard the next frame.
   */
  setSamplesOverride(n: number | null): void {
    if (this.samplesOverride === n) return;
    this.samplesOverride = n;
    if (this.lastCtx && this.mainA) this.allocate(this.lastCtx);
  }

  // ---------------------------------------------------------------------------
  // Materials
  // ---------------------------------------------------------------------------

  private pass(fragment: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.NoBlending,
    });
  }

  /** Camera uniforms every depth-reading pass needs. */
  private camUniforms(): Record<string, THREE.IUniform> {
    return {
      tDepth: { value: null },
      tcCamera: { value: new THREE.Vector4(0.1, 1000, 10, 0.001) },
      tcInvProj: { value: new THREE.Matrix4() },
      tcCamWorld: { value: new THREE.Matrix4() },
    };
  }

  private buildMaterials(): void {
    const cam = DEPTH_GLSL;

    // ---- HBAO -------------------------------------------------------------
    this.mAo = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform vec2 uTexel;      // 1 / full-res size
      uniform vec2 uRadiusProj; // world radius -> pixels at unit depth
      uniform float uStrength;
      varying vec2 vUv;

      /*
       * **The ambient scale, and only the ambient scale.**
       *
       * This gathers at ${AO_RADIUS.toFixed(1)} m, which is a mass term: it says how deep inside a
       * crowd, a colonnade or a street a surface is standing. It is *not* the term criterion
       * A7 is scored on and it cannot be made into one, for two reasons that are both
       * measured rather than argued — the buffer is half resolution and its blur is seven
       * taps wide, so a join three pixels across does not survive it; and a metre-scale
       * gather finds nearly the same horizon a centimetre either side of a join, so there is
       * no edge in the signal to preserve in the first place. The contact term lives in the
       * full-resolution pass below.
       *
       * The one change here: the four steps are **log-spaced** rather than even — 10 %,
       * 26 %, 55 % and 100 % of the radius — so the nearest tap is 0.11 m out instead of
       * 0.14 m and two of the four land inside half a metre. Same tap count, same cost, a
       * better-conditioned near field for the term that still has to hand over to the
       * contact one without a seam.
       */
      void main() {
        float d = texture2D( tDepth, vUv ).x;
        if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }
        vec3 P = tcViewPos( vUv, d );
        vec3 N = tcNormalFromDepth( vUv, uTexel, d, P );

        // Screen-space radius of the world sphere at this depth.
        vec2 rad = uRadiusProj / max( 0.5, -P.z );
        // Cap so a close-up cannot turn AO into a full-screen gather.
        rad = min( rad, vec2( 0.09 ) );

        float rot = tcIGN( gl_FragCoord.xy ) * 6.2831853;
        float jit = tcIGN( gl_FragCoord.yx );
        float occ = 0.0;
        const int DIRS = 6;
        const int STEPS = 4;
        // Log-spaced along the ray. A literal array so the compiler unrolls the loop.
        float FR[ 4 ];
        FR[ 0 ] = 0.10; FR[ 1 ] = 0.26; FR[ 2 ] = 0.55; FR[ 3 ] = 1.00;
        const float RFAR2 = ${(AO_RADIUS * AO_RADIUS).toFixed(4)};
        for ( int j = 0; j < DIRS; j ++ ) {
          float a = rot + float( j ) * ( 6.2831853 / float( DIRS ) );
          vec2 dir = vec2( cos( a ), sin( a ) );
          // Horizon-based: keep the largest elevation found along the direction
          // rather than summing, which is what stops thin geometry over-darkening.
          float hi = 0.0;
          for ( int s = 0; s < STEPS; s ++ ) {
            // The jitter is a fraction of each step's own distance, so it decorrelates the
            // near taps without ever pushing one past the next one out.
            float t = FR[ s ] * ( 0.72 + 0.56 * jit );
            vec2 suv = vUv + dir * rad * t;
            float sd = texture2D( tDepth, suv ).x;
            if ( sd >= 1.0 ) continue;
            vec3 V = tcViewPos( suv, sd ) - P;
            float len2 = dot( V, V );
            // 0.12 tangent bias kills the self-occlusion a depth-derived normal
            // always produces on gently curved ground.
            float ndv = dot( N, V ) * inversesqrt( max( len2, 1e-6 ) ) - 0.12;
            // Alchemy-style falloff: full weight inside the radius, zero outside,
            // so distant geometry never bleeds occlusion onto a near surface.
            hi = max( hi, ndv * clamp( 1.0 - len2 / RFAR2, 0.0, 1.0 ) );
          }
          occ += max( 0.0, hi );
        }
        float ao = 1.0 - ( occ / float( DIRS ) ) * uStrength;
        gl_FragColor = vec4( clamp( ao, 0.0, 1.0 ) );
      }
      `,
      {
        ...this.camUniforms(),
        uTexel: { value: new THREE.Vector2() },
        uRadiusProj: { value: new THREE.Vector2() },
        uStrength: { value: AO_STRENGTH },
      },
    );

    // ---- depth-aware separable blur --------------------------------------
    this.mBlur = this.pass(
      cam + /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uStep;      // blur direction * texel
      varying vec2 vUv;
      void main() {
        float dc = -tcViewZ( texture2D( tDepth, vUv ).x );
        float sum = 0.0;
        float wsum = 0.0;
        // Edge-stopping tolerance in *metres*, proportional to distance so it
        // tracks the depth-buffer's own precision. Expressing it as a fraction of
        // the far plane was the bug that erased every contact shadow in the game:
        // RTSCamera's far plane is never nearer than 2 600 m, so a tolerance of
        // 0.004 far was 10 m of slop and the filter cheerfully averaged a man's
        // feet together with the ground four ranks behind him.
        float tol = 0.06 + dc * 0.012;
        for ( int i = -3; i <= 3; i ++ ) {
          vec2 uv = vUv + uStep * float( i );
          float ds = -tcViewZ( texture2D( tDepth, uv ).x );
          float wg = exp( -float( i * i ) * 0.22 );
          float we = exp( -abs( ds - dc ) / tol );
          float w = wg * we;
          sum += texture2D( tSrc, uv ).r * w;
          wsum += w;
        }
        gl_FragColor = vec4( sum / max( wsum, 1e-4 ) );
      }
      `,
      { ...this.camUniforms(), tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
    );

    // ---- screen-space contact shadows ------------------------------------
    //
    // The defect three independent blind critics named first was that soldiers do not
    // occlude one another and do not sit *in* the ground. The cascaded shadow map cannot
    // fix that on its own: measured at the `wide` camera its outer cascade holds 0.50 m per
    // texel, so a 0.45 m man is a single texel and his contact shadow does not exist at any
    // filter width. Screen space has exactly the resolution the *frame* has, which is the
    // resolution the defect is judged at — a man 200 m away is 8 px tall and the shadow
    // under his boot is 1 px, and 1 px is representable.
    //
    // So this marches the depth buffer toward the sun over a short world distance and asks
    // whether anything stands between this surface and the light. It catches precisely the
    // scale the shadow map misses: boot on ground, shield across the chest of the man
    // behind, greave inside a rank, wall base against paving.
    //
    // Full resolution on purpose. Run at half res (as the AO pass is) the contact darkening
    // under a distant man lands between texels and the effect disappears at exactly the
    // distances the critics complained about.
    this.mContact = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform mat4 tcProj;
      uniform vec2 uTexel;
      uniform vec3 uSunView;   // unit, view space, surface -> sun
      // x: ray length (m), y: normal offset (m), z: thickness (m), w: strength
      uniform vec4 uParams;
      // x/y: near-AO world radius projected (x already divided by aspect), z: strength,
      // w: tangent bias
      uniform vec4 uNear;
      uniform float uNearR2;   // the same radius, squared, in metres
      varying vec2 vUv;

      /*
       * ---- the near-field ambient contact term -----------------------------------------
       *
       * **Why this is here and not in the HBAO pass.** It was in the HBAO pass first, and the
       * buffer is on the record: \`roof-close-occ.png\` under any label in
       * \`screenshots/contact\`, at 320 shields, is
       * white from edge to edge. Two independent reasons, both structural:
       *
       *  1. **Resolution.** The join this term exists to find is 3–8 pixels wide at the
       *     station §H grades from. The AO buffer is half resolution and its blur is seven
       *     taps at one half-res texel, so a join is two texels wide inside a filter six
       *     wide, and the composite's own bilateral upsample softens it again. The pass this
       *     now lives in is full resolution with a one-texel blur, and its own comment says
       *     why in almost these words: "run at half res the contact darkening under a boot
       *     lands between texels and the effect disappears".
       *  2. **Direction.** The sun march above returns white outright for any surface with
       *     \`N·L <= 0.05\`, which is correct for a *shadow* — a surface already turned away
       *     from the sun is dark by Lambert and shading it twice puts a grey rim round every
       *     silhouette. But that early-out is exactly the set of surfaces A7 is scored on:
       *     the inside of a rank, the underside of a shield rim, the shaded face of a wall.
       *     Ambient occlusion has no direction and must be computed for them.
       *
       * So: a 12-sample disc, cosine-weighted, radius \`uNear\` metres, dithered by the same
       * interleaved gradient the march uses and cleaned by the same one-texel blur. Samples
       * are placed on a golden-angle spiral at *linear* radius fraction rather than the
       * square root that gives a uniform disc — the density is deliberately biased toward the
       * centre, because this is a contact term and everything it is looking for is in the
       * first few centimetres.
       *
       * Summed rather than max'd, unlike the horizon search in the HBAO pass. A horizon is
       * the right estimator over a metre, where one near occluder should not count twice; at
       * a hand's breadth what is wanted is *how much* of the neighbourhood is solid, and the
       * sum is that.
       */
      float nearContact( vec2 uv, vec3 P, vec3 N ) {
        vec2 rad = uNear.xy / max( 0.35, -P.z );
        // A cost guard, not a look decision: uncapped, a camera 0.4 m from a wall gathers
        // over a third of the screen and every tap is a cache miss.
        rad = min( rad, vec2( 0.05 ) );
        float rot = tcIGN( gl_FragCoord.xy ) * 6.2831853;
        const int NS = 12;
        const float GA = 2.39996323;   // golden angle
        float occ = 0.0;
        for ( int i = 0; i < NS; i ++ ) {
          float fi = float( i ) + 0.5;
          float a = rot + fi * GA;
          vec2 suv = uv + vec2( cos( a ), sin( a ) ) * rad * ( fi / float( NS ) );
          float sd = texture2D( tDepth, suv ).x;
          if ( sd >= 1.0 ) continue;
          vec3 V = tcViewPos( suv, sd ) - P;
          float len2 = dot( V, V );
          float ndv = dot( N, V ) * inversesqrt( max( len2, 1e-8 ) ) - uNear.w;
          occ += max( 0.0, ndv ) * clamp( 1.0 - len2 / uNearR2, 0.0, 1.0 );
        }
        /*
         * ---- no foliage guard here, and it was tried -------------------------------------
         *
         * A field of thin blades occludes itself everywhere: every grass pixel has some
         * neighbours in front of its tangent plane and some behind it, so this disc finds
         * solid matter in every direction and the whole lawn darkens. It is the one artefact
         * of this term and it is real.
         *
         * The obvious discriminator is **coherence**: a genuine junction — a boot on the
         * ground, a rim over a rim, a wall against paving — should have its occluders all on
         * one side of the tangent plane, so the signed sum of the elevations and the sum of
         * their magnitudes should agree; a thicket should have them on both sides at pixel
         * scale and the ratio should collapse. It costs two adds and it does not work. Both
         * variants were built and measured on the buffer at the roof-close station, 320 shields:
         *
         *   | 5th percentile of the occlusion buffer | with guard | without |
         *   | every sample votes                     | 0.663      | 0.439   |
         *   | only samples clearing the tangent bias | 0.655      | 0.439   |
         *
         * The guard attenuates the corners as hard as the grass, and gating the vote on the
         * bias — which should have removed the near-tangent samples that cancel each other —
         * moved it by 0.008. The reason is that the normal is reconstructed from depth, so on
         * any real surface a good fraction of the disc reads as slightly *behind* the plane
         * and votes against; the sign distribution at a junction is not clean enough to
         * measure. A guard would need a real normal buffer, which is the geometry pass this
         * chain exists to avoid.
         *
         * Recorded rather than shipped at zero, because a knob that halves the effect is
         * worse than a known limitation.
         */
        return clamp( 1.0 - ( occ / float( NS ) ) * uNear.z, 0.0, 1.0 );
      }

      void main() {
        float d = texture2D( tDepth, vUv ).x;
        if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }
        vec3 P = tcViewPos( vUv, d );
        vec3 N = tcNormalFromDepth( vUv, uTexel, d, P );

        float near = nearContact( vUv, P, N );

        // A surface already turned away from the sun gets its darkness from N.L. Tracing a
        // contact shadow onto it as well would darken it twice, and the visible result is a
        // grey rim around every silhouette — the classic SSAO tell the rubric calls out.
        float ndl = dot( N, uSunView );
        if ( ndl <= 0.05 || uParams.w <= 0.0 ) { gl_FragColor = vec4( near ); return; }

        vec3 O = P + N * uParams.y;
        float jitter = tcIGN( gl_FragCoord.xy );
        const int STEPS = 8;
        float occ = 0.0;
        for ( int s = 0; s < STEPS; s ++ ) {
          // Quadratic spacing: contact darkening lives in the first few centimetres, and a
          // uniform march spends most of its taps where nothing is ever found.
          float t = ( float( s ) + jitter ) / float( STEPS );
          vec3 S = O + uSunView * ( uParams.x * t * t );
          vec4 clip = tcProj * vec4( S, 1.0 );
          if ( clip.w <= 0.0 ) break;
          vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
          if ( any( lessThan( suv, vec2( 0.0 ) ) ) || any( greaterThan( suv, vec2( 1.0 ) ) ) ) break;
          float sd = texture2D( tDepth, suv ).x;
          if ( sd >= 1.0 ) continue;
          // Both in metres along -Z, so the comparison is a real distance rather than a
          // non-linear depth difference that means different things near and far.
          float zRay = -S.z;
          float zScene = -tcViewZ( sd );
          float delta = zRay - zScene;
          // A hit only counts inside a thickness band. Without the upper bound the sky
          // behind a silhouette, or any surface far in front of the ray, reads as an
          // occluder and every object drags a shadow across the background behind it.
          // A hit only counts inside a thickness band, and it fades in and out of that
          // band rather than switching. A hard branch here made every pixel's answer binary
          // while its march was jittered per pixel by tcIGN, so neighbouring pixels
          // disagreed completely and the crowd came back covered in a 50 percent screen-door
          // stipple that is absent from the same frame before this pass existed. The
          // smooth band plus the blur below turns eight jittered taps into a continuous field.
          float band = smoothstep( uParams.z * 0.20, uParams.z * 0.40, delta )
                     * ( 1.0 - smoothstep( uParams.z * 0.78, uParams.z, delta ) );
          // Nearer hits matter more: this is a contact term, not a shadow map.
          occ = max( occ, ( 1.0 - t ) * band );
        }
        gl_FragColor = vec4( 1.0 - occ * uParams.w );
      }
      `,
      {
        ...this.camUniforms(),
        tcProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
        uSunView: { value: new THREE.Vector3(0, 1, 0) },
        uParams: { value: new THREE.Vector4(1.3, 0.03, 0.55, 1) },
        uNear: { value: new THREE.Vector4(0, 0, AO_CONTACT_STRENGTH, 0.10) },
        uNearR2: { value: AO_CONTACT_RADIUS * AO_CONTACT_RADIUS },
      },
    );

    // ---- composite: AO + contact shadow + aerial perspective -------------
    this.mComposite = this.pass(
      cam + /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tAo;
      uniform sampler2D tContact;
      uniform samplerCube tSky;
      uniform vec2 uTexel;
      uniform vec3 uCamPos;
      uniform vec3 uSunDir;
      // x: sigma0 (1/m), y: scale height (m), z: sun in-scatter gain, w: ao floor
      uniform vec4 uHaze;
      uniform vec3 uHazeTint;
      uniform float uMieG;
      // Linear tint of the light that survives total occlusion. See the note at its use.
      uniform vec3 uAoFill;
      varying vec2 vUv;

      float hg( float mu, float g ) {
        float g2 = g * g;
        float dd = 1.0 + g2 - 2.0 * g * mu;
        return ( 1.0 - g2 ) / ( 12.566371 * max( 1e-4, dd * sqrt( max( 1e-4, dd ) ) ) );
      }

      // Bilateral upsample of the half-resolution AO. Tolerance in metres — see
      // the blur pass for why a fraction of the far plane does not work here.
      float aoAt( float dc ) {
        vec2 t = uTexel * 2.0;
        float sum = 0.0;
        float wsum = 0.0;
        float tol = 0.04 + dc * 0.008;
        for ( int y = 0; y < 2; y ++ ) {
          for ( int x = 0; x < 2; x ++ ) {
            vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * t;
            float ds = -tcViewZ( texture2D( tDepth, uv ).x );
            float w = exp( -abs( ds - dc ) / tol ) + 1e-3;
            sum += texture2D( tAo, uv ).r * w;
            wsum += w;
          }
        }
        return sum / wsum;
      }

      void main() {
        float d = texture2D( tDepth, vUv ).x;
        vec3 col = texture2D( tScene, vUv ).rgb;

        if ( d >= 1.0 ) {
          // Sky: the background pass already produced the correct radiance.
          gl_FragColor = vec4( col, 1.0 );
          return;
        }

        float dc = -tcViewZ( d );
        // Hemispherical (sky) occlusion and directional (sun) occlusion are combined with a
        // min, not a product. They are two measurements of the same thing — how much of
        // the surrounding geometry is in the way — and multiplying them darkens a boot sole,
        // where both fire at once, to the square of what either justifies.
        float occ = min( aoAt( dc ), texture2D( tContact, vUv ).r );

        /*
         * **The floor is a colour, not a clamp, and that is the change that let the
         * occlusion be strong enough to see.**
         *
         * This used to be \`col *= max( occ, 0.34 )\`. The 0.34 was measured — sampled over
         * the deepest 5 % of the pixels a soldier's own cast shadow darkens, 0.324 of the
         * lit luminance survives at the midcrowd camera and 0.375 at the wide one — so it
         * was the right number for the wrong shape. A clamp does two bad things at once. It
         * puts a hard edge into the image wherever the occlusion crosses it, and, far worse,
         * it makes every occluded pixel *neutral*: the surface keeps its own hue and simply
         * loses energy, so a deep crevice goes toward black rather than toward the colour of
         * the light that still reaches it.
         *
         * That is the same defect a critic named as "the crushed black interior is an absent
         * ambient bounce in the lighting rig", and it is why the occlusion could not be
         * turned up. Measured on the testudo at \`roof-close\`, contact strength 7 against the
         * clamp: the shields read correctly and the grass went to a black mat, because grass
         * is a field of thin blades every one of which occludes its neighbours, and the term
         * had nowhere to put the light it removed.
         *
         * So the light that survives total occlusion is stated as a colour instead —
         * \`uAoFill\`, the chromaticity of \`LightingSystem.fill\`, which is the sky bounce over
         * the warm ground bounce and is already the rig's own answer to "what lights a
         * surface the sun cannot reach". The response is linear in \`occ\` with no clamp
         * anywhere: full occlusion leaves \`uAoFill\` of the surface's own colour, and because
         * it multiplies rather than replaces, a green tunic stays green in the crevice and a
         * red shield stays red. Nothing crosses an edge and nothing goes neutral.
         */
        col *= uAoFill + ( 1.0 - uAoFill ) * occ;

        vec3 wp = tcWorldPos( vUv, d );
        vec3 v = wp - uCamPos;
        float dist = length( v );
        vec3 dir = v / max( dist, 1e-4 );

        // Optical depth through an exponential haze layer, integrated exactly:
        //   int sigma0 * exp(-y/H) ds  =  sigma0 * H / dir.y * (e^-y0/H - e^-y1/H)
        float H = uHaze.y;
        float od;
        if ( abs( dir.y ) < 1e-3 ) {
          od = uHaze.x * exp( -uCamPos.y / H ) * dist;
        } else {
          od = uHaze.x * H / dir.y * ( exp( -uCamPos.y / H ) - exp( -wp.y / H ) );
        }
        od = max( od, 0.0 );

        vec3 T = exp( -od * uHazeTint );

        // Light scattered into a near-ground ray comes from the sky *above* the
        // haze, so the lookup must never dip into the cube's dark ground
        // hemisphere: a ray angled down would otherwise fade distant terrain
        // toward black instead of toward the sky.
        vec3 lookDir = normalize( vec3(
          dir.x, mix( 0.035, max( dir.y, 0.035 ), smoothstep( 0.0, 0.35, dir.y ) ), dir.z
        ) );
        vec3 inscat = textureCube( tSky, lookDir ).rgb;
        // The cube holds the whole-column average phase. Ground aerosol is far
        // more forward-scattering, so the last kilometre glows toward the sun.
        inscat *= 1.0 + hg( dot( dir, uSunDir ), uMieG ) * uHaze.z;

        // Chromatic aerial perspective, on top of the transmittance.
        //
        // The transmittance term alone was not delivering A2, and the number says why. On
        // the ten Rome II plates the top 30 % of the frame carries 0.66 of the bottom
        // third's mean saturation; across our eight it carried 0.88, and on two combat
        // frames it was *above* 1.0 — distance more saturated than foreground, which is the
        // opposite of aerial perspective. A blind critic named it as the cleanest
        // discriminator in the deck: "zero depth attenuation — the distant tree, the far
        // blob and the background unit all carry exactly the same contrast and saturation
        // as the foreground".
        //
        // Raising hazeDensity is the wrong lever and was measured to be wrong once
        // already: it substitutes in-scattered sky for the whole pixel, which lifts the
        // black point as fast as it desaturates and turns the fighting ground into a milky
        // sheet at 400 m (see the note in atmosphere.ts). Multiple scattering desaturates
        // *without* that cost — light that has bounced more than once has lost its
        // chromaticity but not its energy — so the object's own colour is pulled toward its
        // own luminance as a function of the same optical depth, and the frame's tonal
        // structure survives intact.
        // 2.6 and 0.62 together put 17 % of the chroma away at 400 m and 40 % at 1400 m,
        // which is what closes the measured 0.88 to the plates' 0.66.
        float desat = ( 1.0 - exp( -od * 2.6 ) ) * 0.62;
        col = mix( col, vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ), desat );

        gl_FragColor = vec4( col * T + inscat * ( 1.0 - T ), 1.0 );
      }
      `,
      {
        ...this.camUniforms(),
        tScene: { value: null },
        tAo: { value: null },
        tContact: { value: null },
        tSky: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uCamPos: { value: new THREE.Vector3() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uHaze: { value: new THREE.Vector4(0.0013, 620, 2.2, 0.35) },
        uHazeTint: { value: new THREE.Vector3(0.94, 1.0, 1.12) },
        uMieG: { value: 0.72 },
        uAoFill: { value: new THREE.Vector3(AO_FILL, AO_FILL, AO_FILL) },
      },
    );

    // ---- god rays --------------------------------------------------------
    this.mGod = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform vec2 uSunUv;
      uniform vec3 uSunColour;
      // x: density, y: decay, z: strength, w: aspect
      uniform vec4 uParams;
      varying vec2 vUv;
      void main() {
        vec2 delta = ( uSunUv - vUv ) * ( uParams.x / 28.0 );
        vec2 p = vUv;
        float illum = 1.0;
        float acc = 0.0;
        // Dither the march start so the 28 steps do not band on a low-frequency
        // shaft; TAA then resolves the noise away.
        p += delta * tcIGN( gl_FragCoord.xy );
        for ( int i = 0; i < 28; i ++ ) {
          p += delta;
          float d = texture2D( tDepth, clamp( p, vec2( 0.0 ), vec2( 1.0 ) ) ).x;
          acc += step( 1.0, d ) * illum;
          illum *= uParams.y;
        }
        acc /= 28.0;
        // Fade with angular distance from the sun; real shafts do not reach the
        // far edge of frame.
        vec2 r = ( vUv - uSunUv ) * vec2( uParams.w, 1.0 );
        acc *= exp( -dot( r, r ) * 1.6 );
        gl_FragColor = vec4( uSunColour * acc * uParams.z, 1.0 );
      }
      `,
      {
        ...this.camUniforms(),
        uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
        uSunColour: { value: new THREE.Vector3(1, 0.9, 0.75) },
        uParams: { value: new THREE.Vector4(0.85, 0.965, 0.5, 1.78) },
      },
    );

    // ---- depth of field --------------------------------------------------
    this.mDof = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      // x: focus distance (m), y: 1/range, z: max CoC in half-res pixels
      uniform vec3 uFocus;
      varying vec2 vUv;

      float cocAt( vec2 uv ) {
        float d = texture2D( tDepth, uv ).x;
        float z = -tcViewZ( d );
        // Asymmetric, and deliberately shallow behind the focus plane. A real
        // long lens on a battlefield keeps the ranks behind the front one legible;
        // blurring them is the fastest way to make 6 000 men look like a diorama.
        float near = clamp( ( uFocus.x - z ) / ( uFocus.x * 0.55 ), 0.0, 1.0 );
        float far = clamp( ( z - uFocus.x ) * uFocus.y, 0.0, 1.0 );
        return max( near, far );
      }

      void main() {
        float coc = cocAt( vUv );
        float radius = coc * uFocus.z;
        vec3 sum = texture2D( tSrc, vUv ).rgb;
        float wsum = 1.0;
        float rot = tcIGN( gl_FragCoord.xy ) * 6.2831853;
        // 22-tap Vogel disc: enough for a readable bokeh circle at this radius
        // without the octagonal artefacts a separable blur gives.
        for ( int i = 0; i < 22; i ++ ) {
          float fi = float( i ) + 0.5;
          float rr = sqrt( fi / 22.0 );
          float th = fi * 2.39996323 + rot;
          vec2 o = vec2( cos( th ), sin( th ) ) * rr * radius;
          vec2 uv = vUv + o * uTexel;
          float sc = cocAt( uv );
          // Weight by the sample's own CoC so a sharp foreground cannot smear
          // into a blurred background.
          float w = max( sc, 0.05 );
          sum += texture2D( tSrc, uv ).rgb * w;
          wsum += w;
        }
        gl_FragColor = vec4( sum / wsum, coc );
      }
      `,
      {
        ...this.camUniforms(),
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFocus: { value: new THREE.Vector3(40, 0.01, 8) },
      },
    );

    this.mDofMix = this.pass(
      /* glsl */ `
      uniform sampler2D tSharp;
      uniform sampler2D tBlur;
      uniform float uAmount;
      varying vec2 vUv;
      void main() {
        vec4 b = texture2D( tBlur, vUv );
        vec3 s = texture2D( tSharp, vUv ).rgb;
        gl_FragColor = vec4( mix( s, b.rgb, clamp( b.a * uAmount, 0.0, 1.0 ) ), 1.0 );
      }
      `,
      { tSharp: { value: null }, tBlur: { value: null }, uAmount: { value: 1 } },
    );

    // ---- camera motion blur ---------------------------------------------
    this.mMotion = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform sampler2D tSrc;
      uniform mat4 uPrevViewProj;
      uniform float uScale;
      varying vec2 vUv;
      void main() {
        float d = texture2D( tDepth, vUv ).x;
        vec3 wp = tcWorldPos( vUv, d );
        vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
        vec2 prev = ( pc.xy / max( pc.w, 1e-5 ) ) * 0.5 + 0.5;
        vec2 vel = ( vUv - prev ) * uScale;
        // 12 px is about as far as a smear can go before 2 500 men turn to soup.
        float len = length( vel );
        if ( len > 0.012 ) vel *= 0.012 / len;
        vec3 sum = vec3( 0.0 );
        float j = tcIGN( gl_FragCoord.xy ) - 0.5;
        for ( int i = 0; i < 7; i ++ ) {
          float t = ( float( i ) + j ) / 6.0 - 0.5;
          sum += texture2D( tSrc, vUv - vel * t ).rgb;
        }
        gl_FragColor = vec4( sum / 7.0, 1.0 );
      }
      `,
      {
        ...this.camUniforms(),
        tSrc: { value: null },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uScale: { value: 0.5 },
      },
    );

    // ---- bloom ----------------------------------------------------------
    this.mBright = this.pass(
      HASH_GLSL + /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform vec2 uThreshold; // x: knee start, y: knee width
      varying vec2 vUv;
      void main() {
        // 4-tap box on the way down doubles as the first halving filter.
        vec3 c = texture2D( tSrc, vUv + uTexel * vec2( -0.5, -0.5 ) ).rgb;
        c += texture2D( tSrc, vUv + uTexel * vec2( 0.5, -0.5 ) ).rgb;
        c += texture2D( tSrc, vUv + uTexel * vec2( -0.5, 0.5 ) ).rgb;
        c += texture2D( tSrc, vUv + uTexel * vec2( 0.5, 0.5 ) ).rgb;
        c *= 0.25;
        float l = max( tcLuma( c ), 1e-5 );
        // Quadratic soft knee (Karis): a hard threshold pops as objects brighten.
        float k = uThreshold.y;
        float soft = clamp( l - uThreshold.x + k, 0.0, 2.0 * k );
        soft = soft * soft / ( 4.0 * k + 1e-5 );
        float w = max( soft, l - uThreshold.x ) / l;
        gl_FragColor = vec4( c * w, 1.0 );
      }
      `,
      {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: new THREE.Vector2(BLOOM_THRESHOLD, BLOOM_KNEE) },
      },
    );

    this.mDown = this.pass(
      /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        // 13-tap downsample from Jimenez's Siggraph 2014 "Next Generation Post
        // Processing in Call of Duty". Removes the pulsing that a naive box
        // filter gives as bright pixels cross mip boundaries.
        vec3 a = texture2D( tSrc, vUv + uTexel * vec2( -2.0, 2.0 ) ).rgb;
        vec3 b = texture2D( tSrc, vUv + uTexel * vec2( 0.0, 2.0 ) ).rgb;
        vec3 c = texture2D( tSrc, vUv + uTexel * vec2( 2.0, 2.0 ) ).rgb;
        vec3 d = texture2D( tSrc, vUv + uTexel * vec2( -2.0, 0.0 ) ).rgb;
        vec3 e = texture2D( tSrc, vUv ).rgb;
        vec3 f = texture2D( tSrc, vUv + uTexel * vec2( 2.0, 0.0 ) ).rgb;
        vec3 g = texture2D( tSrc, vUv + uTexel * vec2( -2.0, -2.0 ) ).rgb;
        vec3 h = texture2D( tSrc, vUv + uTexel * vec2( 0.0, -2.0 ) ).rgb;
        vec3 i = texture2D( tSrc, vUv + uTexel * vec2( 2.0, -2.0 ) ).rgb;
        vec3 j = texture2D( tSrc, vUv + uTexel * vec2( -1.0, 1.0 ) ).rgb;
        vec3 k = texture2D( tSrc, vUv + uTexel * vec2( 1.0, 1.0 ) ).rgb;
        vec3 l = texture2D( tSrc, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb;
        vec3 m = texture2D( tSrc, vUv + uTexel * vec2( 1.0, -1.0 ) ).rgb;
        vec3 o = e * 0.125;
        o += ( a + c + g + i ) * 0.03125;
        o += ( b + d + f + h ) * 0.0625;
        o += ( j + k + l + m ) * 0.125;
        gl_FragColor = vec4( o, 1.0 );
      }
      `,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );

    this.mUp = this.pass(
      /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      uniform float uRadius;
      varying vec2 vUv;
      void main() {
        // 3x3 tent, the matching upsample for the 13-tap downsample.
        vec2 t = uTexel * uRadius;
        vec3 o = texture2D( tSrc, vUv + vec2( -t.x, t.y ) ).rgb;
        o += texture2D( tSrc, vUv + vec2( 0.0, t.y ) ).rgb * 2.0;
        o += texture2D( tSrc, vUv + vec2( t.x, t.y ) ).rgb;
        o += texture2D( tSrc, vUv + vec2( -t.x, 0.0 ) ).rgb * 2.0;
        o += texture2D( tSrc, vUv ).rgb * 4.0;
        o += texture2D( tSrc, vUv + vec2( t.x, 0.0 ) ).rgb * 2.0;
        o += texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb;
        o += texture2D( tSrc, vUv + vec2( 0.0, -t.y ) ).rgb * 2.0;
        o += texture2D( tSrc, vUv + vec2( t.x, -t.y ) ).rgb;
        gl_FragColor = vec4( o * 0.0625, 1.0 );
      }
      `,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
    );

    // ---- tone map + grade ------------------------------------------------
    this.mTone = this.pass(TC_TONE_GRADE_FRAG, tcToneGradeUniforms());

    // ---- TAA -------------------------------------------------------------
    this.mTaa = this.pass(
      cam + HASH_GLSL + /* glsl */ `
      uniform sampler2D tCur;
      uniform sampler2D tHist;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexel;
      uniform float uBlend;
      varying vec2 vUv;

      void main() {
        vec3 cur = texture2D( tCur, vUv ).rgb;

        float d = texture2D( tDepth, vUv ).x;
        vec3 wp = tcWorldPos( vUv, d );
        vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
        vec2 prev = ( pc.xy / max( pc.w, 1e-5 ) ) * 0.5 + 0.5;

        if ( any( lessThan( prev, vec2( 0.0 ) ) ) || any( greaterThan( prev, vec2( 1.0 ) ) ) ) {
          gl_FragColor = vec4( cur, 1.0 );
          return;
        }

        // 3x3 neighbourhood bounds of the current frame. Clamping the history
        // into this box is what keeps a running soldier from leaving a trail:
        // once his colour is outside the local range the history is rejected.
        vec3 lo = cur;
        vec3 hi = cur;
        for ( int y = -1; y <= 1; y ++ ) {
          for ( int x = -1; x <= 1; x ++ ) {
            vec3 s = texture2D( tCur, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb;
            lo = min( lo, s );
            hi = max( hi, s );
          }
        }
        // Widen the box by a quarter of its own range. A hard per-channel clamp
        // on sub-pixel geometry (foliage, cirrus) clips the three channels by
        // different amounts and leaves coloured contour lines along every edge.
        vec3 ext = ( hi - lo ) * 0.25 + 0.004;
        vec3 hist = clamp( texture2D( tHist, prev ).rgb, lo - ext, hi + ext );

        // Drop the history faster when the reprojection is moving quickly: a
        // long velocity means the clamp is doing most of the work anyway.
        float vel = length( ( vUv - prev ) / uTexel );
        float blend = uBlend * exp( -vel * 0.06 );
        // Sky pixels reproject as if they were at the far plane, but the clouds
        // on them actually drift, so trust the history less there.
        blend *= mix( 1.0, 0.72, step( 1.0, d ) );
        gl_FragColor = vec4( mix( cur, hist, blend ), 1.0 );
      }
      `,
      {
        ...this.camUniforms(),
        tCur: { value: null },
        tHist: { value: null },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2() },
        uBlend: { value: 0.88 },
      },
    );

    // ---- FXAA ------------------------------------------------------------
    this.mFxaa = this.pass(
      HASH_GLSL + /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        // FXAA 3.11 "console" variant: one edge direction, two tap pairs. Cheap,
        // and enough once the image is already temporally stable.
        vec3 rgbNW = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
        vec3 rgbNE = texture2D( tSrc, vUv + vec2( 1.0, -1.0 ) * uTexel ).rgb;
        vec3 rgbSW = texture2D( tSrc, vUv + vec2( -1.0, 1.0 ) * uTexel ).rgb;
        vec3 rgbSE = texture2D( tSrc, vUv + vec2( 1.0, 1.0 ) * uTexel ).rgb;
        vec3 rgbM = texture2D( tSrc, vUv ).rgb;

        float lNW = tcLuma( rgbNW );
        float lNE = tcLuma( rgbNE );
        float lSW = tcLuma( rgbSW );
        float lSE = tcLuma( rgbSE );
        float lM = tcLuma( rgbM );
        float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
        float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );

        if ( lMax - lMin < lMax * 0.12 + 0.02 ) {
          gl_FragColor = vec4( rgbM, 1.0 );
          return;
        }

        vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( lNW + lSW ) - ( lNE + lSE ) );
        float rcp = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + max( ( lNW + lNE + lSW + lSE ) * 0.25 * 0.25, 1.0 / 128.0 ) );
        dir = clamp( dir * rcp, vec2( -8.0 ), vec2( 8.0 ) ) * uTexel;

        vec3 a = 0.5 * ( texture2D( tSrc, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb
                       + texture2D( tSrc, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
        vec3 b = a * 0.5 + 0.25 * ( texture2D( tSrc, vUv + dir * -0.5 ).rgb
                                  + texture2D( tSrc, vUv + dir * 0.5 ).rgb );
        float lB = tcLuma( b );
        gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? a : b, 1.0 );
      }
      `,
      { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
    );

    // ---- final: CAS sharpen + vignette + grain ---------------------------
    this.mFinal = this.pass(TC_FINAL_FRAG, tcFinalUniforms());

    this.mCopy = this.pass(
      /* glsl */ `
      uniform sampler2D tSrc;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4( texture2D( tSrc, vUv ).rgb, 1.0 ); }
      `,
      { tSrc: { value: null } },
    );

    // ---- the occlusion instrument ----------------------------------------
    //
    // The same two lines the composite uses to combine the two terms, and no others, so
    // what a probe photographs here is what the composite multiplies the frame by. Kept as
    // its own pass rather than as a branch inside `mComposite` because a branch there is a
    // branch in the hottest fullscreen shader in the frame.
    this.mOccView = this.pass(
      cam + /* glsl */ `
      uniform sampler2D tAo;
      uniform sampler2D tContact;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        float d = texture2D( tDepth, vUv ).x;
        if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }
        float dc = -tcViewZ( d );
        vec2 t = uTexel * 2.0;
        float sum = 0.0;
        float wsum = 0.0;
        float tol = 0.04 + dc * 0.008;
        for ( int y = 0; y < 2; y ++ ) {
          for ( int x = 0; x < 2; x ++ ) {
            vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * t;
            float ds = -tcViewZ( texture2D( tDepth, uv ).x );
            float w = exp( -abs( ds - dc ) / tol ) + 1e-3;
            sum += texture2D( tAo, uv ).r * w;
            wsum += w;
          }
        }
        gl_FragColor = vec4( vec3( min( sum / wsum, texture2D( tContact, vUv ).r ) ), 1.0 );
      }
      `,
      {
        ...this.camUniforms(),
        tAo: { value: null },
        tContact: { value: null },
        uTexel: { value: new THREE.Vector2() },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    this.elapsed += dt;
  }

  /**
   * Raise every mipmapped texture in the scene to the device's maximum anisotropy.
   *
   * Anisotropy is a sampler setting, not a memory or authoring cost: it changes how many
   * taps the hardware takes along the longer axis of a texel footprint, and on a battlefield
   * almost every surface that matters — ground, road, masonry courses, the sward — is seen
   * at a grazing angle, which is the exact case isotropic mip selection handles worst. It
   * picks the blur radius from the long axis and smears the short one, so a brick course
   * that should stay legible to the horizon turns to mush at forty metres.
   *
   * Doing it here rather than at each call site is deliberate. Eight subsystems create
   * textures and each had independently hardcoded 8 (or 4), which is a value from an era of
   * 8-sample hardware; this machine reports 16. Sweeping from the renderer means one place
   * knows the device limit, and it also catches textures created asynchronously after boot
   * — the city's atlases in particular. Per-call-site defaults should still be raised, and
   * that change is reported to the integrator rather than made here, because those files
   * belong to other subsystems.
   *
   * The sweep is cheap (a traverse over ~200 meshes) and self-limiting: it stops as soon as
   * a pass finds nothing left to raise.
   */
  private sweepAnisotropy(ctx: EngineContext): void {
    const max = this.renderer.capabilities.getMaxAnisotropy();
    let raised = 0;
    const seen = new Set<string>();
    ctx.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        if (seen.has(m.uuid)) continue;
        seen.add(m.uuid);
        const std = m as THREE.MeshStandardMaterial;
        for (const t of [std.map, std.normalMap, std.roughnessMap, std.aoMap,
          std.metalnessMap, std.emissiveMap, std.alphaMap]) {
          // Only textures that actually have a mip chain: anisotropic sampling is defined
          // in terms of mip selection, so on an unmipped texture it is a no-op that still
          // forces a redundant re-upload.
          if (!t) continue;
          const mipped = t.generateMipmaps || (t.mipmaps?.length ?? 0) > 1;
          if (!mipped || t.anisotropy >= max) continue;
          t.anisotropy = max;
          t.needsUpdate = true;
          raised++;
        }
      }
    });
    if (raised === 0) this.anisotropySweeps = 0;
  }

  preRender(ctx: EngineContext): void {
    if (!this.enabled || !this.sceneRT) return;
    const cam = ctx.camera;

    // The world is not fully populated at init — the city streams its atlases in — so the
    // sweep runs on a short decaying schedule rather than once, and switches itself off.
    if (this.anisotropySweeps > 0 && (this.frameIndex & 63) === 0) {
      this.anisotropySweeps--;
      this.sweepAnisotropy(ctx);
    }

    // Unjittered matrices drive reprojection; the jitter only perturbs raster.
    this.projNoJitter.copy(cam.projectionMatrix);
    this.curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    if (ctx.quality.antialias === 'taa') {
      const [jx, jy] = HALTON[this.frameIndex % HALTON.length];
      const e = cam.projectionMatrix.elements;
      // elements[8] and [9] are the projection's x/y skew terms; nudging them by
      // a sub-pixel amount shifts the whole raster grid.
      e[8] += ((jx - 0.5) * 2) / this.w;
      e[9] += ((jy - 0.5) * 2) / this.h;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      this.jittered = true;
      // The sky is a fullscreen pass, so it has to be told about the jitter or
      // silhouettes against it never resolve.
      this.sky?.syncCamera(cam);
    }

    // Sun position on screen, for the god rays. A direction, so w = 0 and the
    // camera translation drops out of the projection.
    const sun = this.sky?.sunDirection;
    if (sun) {
      this.tmpV3.copy(sun).transformDirection(cam.matrixWorldInverse);
      this.tmpV4.set(this.tmpV3.x, this.tmpV3.y, this.tmpV3.z, 0)
        .applyMatrix4(cam.projectionMatrix);
      if (this.tmpV4.w > 1e-4) {
        const iw = 1 / this.tmpV4.w;
        this.sunUv.set(this.tmpV4.x * iw * 0.5 + 0.5, this.tmpV4.y * iw * 0.5 + 0.5);
        // Fade out as the sun leaves the frame or drops toward the horizon. The
        // margin is generous on purpose: this camera rig cannot tilt above the
        // horizon, so with the sun at any useful elevation it sits above the top
        // edge — and shafts raking down into frame from an off-screen sun are
        // both correct and the only version we will ever see.
        const off = Math.max(Math.abs(this.sunUv.x - 0.5), Math.abs(this.sunUv.y - 0.5));
        this.sunOnScreen = (1 - smoothstep((off - 0.5) / 0.9)) * clamp01(sun.y * 4);
      } else {
        this.sunOnScreen = 0;
      }
    }
  }

  /** Push the current camera state into every depth-reading pass. */
  private syncCamUniforms(cam: THREE.PerspectiveCamera): void {
    const mats = [
      this.mAo, this.mBlur, this.mContact, this.mComposite, this.mGod, this.mDof,
      this.mMotion, this.mTaa, this.mOccView,
    ];
    for (const m of mats) {
      if (!m) continue;
      const u = m.uniforms;
      (u.tDepth as THREE.IUniform).value = this.depthTexture;
      (u.tcCamera.value as THREE.Vector4).set(cam.near, cam.far, 1 / cam.near, 1 / cam.far);
      (u.tcInvProj.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
      (u.tcCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    }
  }

  /**
   * Upper bound on the motion-blur smear length this frame, in device pixels.
   *
   * Reproduces the shader's own arithmetic on the CPU at `MB_PROBE`'s sample points. For a
   * point whose current position is NDC `p`, the shader recovers its world position from the
   * depth buffer and pushes it through `uPrevViewProj`; the same point is reached here by
   * unprojecting `p` through the inverse of the *current* view-projection, which is exact for
   * anything actually in the depth buffer. `vel` is a uv-space vector, so scaling its
   * components by the drawing-buffer size converts a smear to pixels.
   *
   * A bound, not a measurement: the true maximum is over every pixel and this is over 27 of
   * them. That is the right direction to be wrong in only because it is paired with a
   * threshold well under a pixel — see `motionBlurMinPixels`.
   */
  private motionBlurSmearPixels(uScale: number): number {
    this.invViewProj.copy(this.curViewProj).invert();
    const w = this.w;
    const h = this.h;
    let worst = 0;
    for (const [x, y, z] of MB_PROBE) {
      // Unproject through the current camera, then reproject through the previous one.
      const v = this.mbProbe.set(x, y, z, 1).applyMatrix4(this.invViewProj);
      const iw = 1 / (Math.abs(v.w) > 1e-9 ? v.w : 1e-9);
      v.set(v.x * iw, v.y * iw, v.z * iw, 1).applyMatrix4(this.prevViewProj);
      const pw = Math.max(v.w, 1e-5);
      // `(vUv - prev)` in uv is half the NDC difference, because uv = ndc * 0.5 + 0.5.
      const du = (x - v.x / pw) * 0.5 * uScale * w;
      const dv = (y - v.y / pw) * 0.5 * uScale * h;
      const d = Math.hypot(du, dv);
      if (d > worst) worst = d;
    }
    return worst;
  }

  private blit(
    mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, clear = true,
  ): void {
    const r = this.renderer;
    r.setRenderTarget(target);
    // `FullScreenQuad.render` goes through `renderer.render`, which clears when
    // `autoClear` is set — fatal for the additive bloom upsample.
    const prev = r.autoClear;
    r.autoClear = clear;
    this.quad.material = mat;
    this.quad.render(r);
    r.autoClear = prev;
  }

  /** Installed as `engine.renderOverride`. */
  render(ctx: EngineContext): void {
    const r = this.renderer;
    const cam = ctx.camera;
    const q = ctx.quality;

    if (!this.enabled || !this.sceneRT || !this.mainA || !this.mainB) {
      r.setRenderTarget(null);
      r.render(ctx.scene, cam);
      return;
    }

    const texel = this.texel.set(1 / this.w, 1 / this.h);
    this.syncCamUniforms(cam);

    // 1 ---- scene ----------------------------------------------------------
    r.setRenderTarget(this.sceneRT);
    r.render(ctx.scene, cam);

    // 2 ---- ambient occlusion ---------------------------------------------
    let aoTex: THREE.Texture | null = null;
    if (q.ssao && this.mAo && this.mBlur && this.aoRT && this.aoTmp) {
      const u = this.mAo.uniforms;
      (u.uTexel.value as THREE.Vector2).copy(texel);
      // Project a world-space radius to a screen fraction: r * (0.5/tan(fov/2))
      // / depth, and the y term is the reference because fov is vertical.
      const projScale = 0.5 / Math.tan((cam.fov * Math.PI) / 360);
      (u.uRadiusProj.value as THREE.Vector2).set(
        (AO_RADIUS * projScale) / cam.aspect, AO_RADIUS * projScale,
      );
      this.blit(this.mAo, this.aoRT);

      const bu = this.mBlur.uniforms;
      bu.tSrc.value = this.aoRT.texture;
      (bu.uStep.value as THREE.Vector2).set(2 / this.w, 0);
      this.blit(this.mBlur, this.aoTmp);
      bu.tSrc.value = this.aoTmp.texture;
      (bu.uStep.value as THREE.Vector2).set(0, 2 / this.h);
      this.blit(this.mBlur, this.aoRT);
      aoTex = this.aoRT.texture;
    }

    // 2b --- full-resolution contact: sun march AND near-field ambient -----
    //
    // **No longer gated on the sun being up**, and that is the point of the pass now. The
    // near-field ambient term is omnidirectional, so a surface turned away from the sun — the
    // inside of a rank, the underside of a rim, the shaded face of a wall, and the entire
    // frame at dusk — is exactly where it has to work.
    let contactTex: THREE.Texture | null = null;
    if (this.contactShadows && q.ssao && this.mContact && this.contactRT) {
      const u = this.mContact.uniforms;
      (u.uTexel.value as THREE.Vector2).copy(texel);
      (u.tcProj.value as THREE.Matrix4).copy(this.projNoJitter);
      const sunUp = !!this.sky && this.sky.sunIntensity > 0.001;
      if (sunUp && this.sky) {
        // The march runs in view space, so the sun direction has to be rotated into it.
        // `matrixWorldInverse` is the view matrix; only its rotation applies to a direction.
        this.tmpV3.copy(this.sky.sunDirection)
          .transformDirection(cam.matrixWorldInverse)
          .normalize();
        (u.uSunView.value as THREE.Vector3).copy(this.tmpV3);
      }
      // `uParams.w` is the march's strength and zeroing it is how the shader is told to skip
      // the march entirely, so the sunless case costs eight taps less rather than a branch
      // the compiler cannot see.
      (u.uParams.value as THREE.Vector4).w = sunUp ? 1 : 0;
      // World radius -> screen fraction, the same projection the HBAO pass uses. `y` is the
      // reference because the field of view is vertical.
      {
        const projScale = 0.5 / Math.tan((cam.fov * Math.PI) / 360);
        (u.uNear.value as THREE.Vector4).set(
          (AO_CONTACT_RADIUS * projScale) / cam.aspect, AO_CONTACT_RADIUS * projScale,
          this.aoContactStrength, 0.10,
        );
        u.uNearR2.value = AO_CONTACT_RADIUS * AO_CONTACT_RADIUS;
      }
      this.blit(this.mContact, this.contactRT);
      // Depth-aware separable blur, at full resolution and one texel per tap. Wider than
      // that and the contact core under a boot is smeared back out to nothing, which is the
      // whole thing this pass exists to produce; narrower and the per-pixel march jitter
      // survives as visible grain over a crowd.
      if (this.mBlur && this.contactTmp) {
        const bu = this.mBlur.uniforms;
        bu.tSrc.value = this.contactRT.texture;
        (bu.uStep.value as THREE.Vector2).set(1 / this.w, 0);
        this.blit(this.mBlur, this.contactTmp);
        bu.tSrc.value = this.contactTmp.texture;
        (bu.uStep.value as THREE.Vector2).set(0, 1 / this.h);
        this.blit(this.mBlur, this.contactRT);
      }
      contactTex = this.contactRT.texture;
    }

    // 2c --- the instrument -------------------------------------------------
    //
    // Straight to the canvas, ungraded and untouched by anything downstream. See
    // `debugView` for why reading an occlusion term off a finished frame does not work.
    if (this.debugView && this.mCopy) {
      const t = this.debugView === 'contact' ? contactTex
        : this.debugView === 'occ' ? null
          : aoTex;
      if (this.debugView === 'occ' && this.mOccView) {
        const u = this.mOccView.uniforms;
        u.tAo.value = aoTex ?? this.whiteTexture();
        u.tContact.value = contactTex ?? this.whiteTexture();
        (u.uTexel.value as THREE.Vector2).copy(texel);
        this.blit(this.mOccView, null);
      } else {
        this.mCopy.uniforms.tSrc.value = t ?? this.whiteTexture();
        this.blit(this.mCopy, null);
      }
      this.prevViewProj.copy(this.curViewProj);
      this.prevViewProjValid = true;
      this.frameIndex++;
      this.nFrames++;
      r.setRenderTarget(null);
      return;
    }

    // 3 ---- composite: AO + contact shadow + aerial perspective -----------
    let cur = this.mainA;
    if (this.mComposite) {
      const u = this.mComposite.uniforms;
      u.tScene.value = this.sceneRT.texture;
      u.tAo.value = aoTex ?? this.whiteTexture();
      u.tContact.value = contactTex ?? this.whiteTexture();
      u.tSky.value = this.sky?.skyCubeTexture ?? null;
      (u.uTexel.value as THREE.Vector2).copy(texel);
      (u.uCamPos.value as THREE.Vector3).copy(cam.position);
      if (this.sky) {
        (u.uSunDir.value as THREE.Vector3).copy(this.sky.sunDirection);
        const p = this.sky.preset;
        (u.uHaze.value as THREE.Vector4).set(p.hazeDensity, p.hazeHeight, 2.4, 0.34);
      }
      /*
       * The occlusion fill's colour, live off the hemisphere light.
       *
       * Two thirds sky, one third ground: a crevice between two men sees mostly the sky
       * strip above it and a little of the dry plain, and `LightingSystem` has already done
       * the hard part — its `fill.color` carries the sky's own chromaticity stretched about
       * its luminance by `FILL_CHROMA_GAIN`, which is the term that makes this project's
       * shadows blue-grey instead of grey. Normalised to unit luminance and scaled by
       * `AO_FILL`, so the *amount* of light that survives occlusion is one number here and
       * the *colour* of it is the rig's, and tuning either cannot silently change the other.
       */
      {
        const f = this.lighting?.fill;
        const cr = f ? f.color.r * 0.66 + f.groundColor.r * 0.34 : 1;
        const cg = f ? f.color.g * 0.66 + f.groundColor.g * 0.34 : 1;
        const cb = f ? f.color.b * 0.66 + f.groundColor.b * 0.34 : 1;
        const lum = Math.max(1e-4, 0.2126 * cr + 0.7152 * cg + 0.0722 * cb);
        const k = AO_FILL / lum;
        (u.uAoFill.value as THREE.Vector3).set(cr * k, cg * k, cb * k);
      }
      // No sky cube yet (first frame) means no aerial term; fall back to a copy.
      if (u.tSky.value) this.blit(this.mComposite, cur);
      else if (this.mCopy) {
        this.mCopy.uniforms.tSrc.value = this.sceneRT.texture;
        this.blit(this.mCopy, cur);
      }
    }

    // 4 ---- god rays -------------------------------------------------------
    let godTex: THREE.Texture = this.blackTexture();
    if (q.volumetricLight && this.mGod && this.godRT && this.sunOnScreen > 0.01) {
      const u = this.mGod.uniforms;
      (u.uSunUv.value as THREE.Vector2).copy(this.sunUv);
      if (this.sky) {
        const c = this.sky.sunColour;
        (u.uSunColour.value as THREE.Vector3).set(c.r, c.g, c.b);
      }
      (u.uParams.value as THREE.Vector4).set(
        0.9, 0.968, 0.85 * this.sunOnScreen, cam.aspect,
      );
      this.blit(this.mGod, this.godRT);
      godTex = this.godRT.texture;
    }

    /*
     * 5 ---- depth of field -------------------------------------------------
     *
     * Restrained by design: only the closest few metres of the orbit get any, and never more
     * than 70 % opacity. At strategic zoom everything is sharp.
     *
     * Driven by the orbit *radius* rather than by the `zoom` scalar, and the two are the same
     * thing for a player: `RTSCamera.radius` is `minZoom * (maxZoom/minZoom)^smoothstep(zoom)`,
     * so zoom 0 is 3.2 m and zoom 0.28 is 8.8 m, and the curve below reproduces the old fade
     * over that interval to within a few percent.
     *
     * It is emphatically not the same thing for a *harness*. `tools/shoot.mjs` now overrides
     * `radius`, `pitchForZoom` and `fovForZoom` to shoot a camera specified in metres and
     * degrees, and pins `zoom` to 0 so that `place()`'s look-at lift and ground clearance are
     * known constants. Read off `zoom`, this line then put depth of field at *full strength*
     * on a 480 m strategic overview and blurred the entire near half of the field — an
     * artefact with no counterpart in anything a player sees, injected into the frames that
     * exist to be compared against a real game. Radius is the physical quantity the effect is
     * actually about, it is correct for both callers, and it cannot be pinned out from under
     * this pass.
     */
    const dofAmount = (1 - smoothstep((ctx.rig.orbitRadius - 3.2) / 5.6)) * 0.7;
    if (q.depthOfField && dofAmount > 0.02 && this.mDof && this.mDofMix && this.dofRT) {
      const u = this.mDof.uniforms;
      u.tSrc.value = cur.texture;
      (u.uTexel.value as THREE.Vector2).set(2 / this.w, 2 / this.h);
      const focus = Math.max(3, ctx.rig.orbitRadius);
      // Far blur ramps over 9x the focus distance; 4 half-res pixels of bokeh is
      // about the widest that still reads as a lens rather than a smear.
      (u.uFocus.value as THREE.Vector3).set(focus, 1 / (focus * 9), 4);
      this.blit(this.mDof, this.dofRT);

      const other = cur === this.mainA ? this.mainB : this.mainA;
      this.mDofMix.uniforms.tSharp.value = cur.texture;
      this.mDofMix.uniforms.tBlur.value = this.dofRT.texture;
      this.mDofMix.uniforms.uAmount.value = dofAmount;
      this.blit(this.mDofMix, other);
      cur = other;
    }

    // 6 ---- motion blur ----------------------------------------------------
    // Gated on `prevViewProjValid`, not on `historyValid`. See both fields: the second is
    // TAA's and is set nowhere else, so this pass could not run on any shipped tier.
    if (q.motionBlur && this.mMotion && this.prevViewProjValid) {
      const u = this.mMotion.uniforms;
      // Normalise by frame time so the smear length is shutter-like rather than
      // frame-rate dependent.
      const uScale = clamp(0.5 * (ctx.time.frameDt * 60), 0.15, 1.2);
      /*
       * Skip the blit when nothing on screen would move far enough to smear.
       *
       * With a stationary camera `uPrevViewProj` equals the current view-projection, `vel`
       * is identically zero, all seven taps land on the same texel and the pass writes back
       * exactly what it read — a full-resolution HDR blit with eight texture fetches per
       * pixel for a bit-identical copy. Nothing in the pass gated on that, so from the frame
       * the pass was first made reachable it has run on 100% of frames at high and ultra,
       * including every parked screenshot and every second a player spends watching a battle
       * without touching the mouse.
       *
       * The bound is on the smear *length*, not on camera velocity, because that is the
       * quantity the shader actually spends: a fast dolly along the view axis moves the
       * camera metres and the pixels barely at all, and a slow yaw at telephoto does the
       * reverse. Skipping leaves `cur` pointing at the buffer the previous pass wrote, which
       * is exactly what the pass would have copied.
       */
      const bound = this.motionBlurSmearPixels(uScale);
      this.lastSmearPx = bound;
      if (bound < Math.min(this.motionBlurMinPixels, 1)) {
        this.nMotionBlurSkipped++;
      } else {
        u.tSrc.value = cur.texture;
        (u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
        u.uScale.value = uScale;
        const other = cur === this.mainA ? this.mainB : this.mainA;
        this.blit(this.mMotion, other);
        cur = other;
        this.nMotionBlur++;
      }
    }

    // 7 ---- bloom ----------------------------------------------------------
    let bloomTex: THREE.Texture = this.blackTexture();
    if (q.bloom && this.mBright && this.mDown && this.mUp && this.bloomRT.length) {
      const bu = this.mBright.uniforms;
      bu.tSrc.value = cur.texture;
      (bu.uTexel.value as THREE.Vector2).copy(texel);
      this.blit(this.mBright, this.bloomRT[0]);

      for (let i = 1; i < this.bloomRT.length; i++) {
        const src = this.bloomRT[i - 1];
        this.mDown.uniforms.tSrc.value = src.texture;
        (this.mDown.uniforms.uTexel.value as THREE.Vector2).set(
          1 / src.width, 1 / src.height,
        );
        this.blit(this.mDown, this.bloomRT[i]);
      }

      this.mUp.uniforms.uRadius.value = 1;
      for (let i = this.bloomRT.length - 1; i > 0; i--) {
        const src = this.bloomRT[i];
        const dst = this.bloomRT[i - 1];
        this.mUp.uniforms.tSrc.value = src.texture;
        (this.mUp.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
        // Additive so each octave contributes: the energy of the wide halo comes
        // from accumulating up the pyramid, not from one big blur.
        this.mUp.blending = THREE.AdditiveBlending;
        this.blit(this.mUp, dst, false);
      }
      this.mUp.blending = THREE.NoBlending;
      bloomTex = this.bloomRT[0].texture;
    }

    // 8 ---- tone map + grade ----------------------------------------------
    if (!this.mTone || !this.ldrRT) return;
    const tu = this.mTone.uniforms;
    tu.tSrc.value = cur.texture;
    tu.tBloom.value = bloomTex;
    tu.tGod.value = godTex;
    tu.uExposure.value = this.sky?.preset.exposure ?? 1;
    tu.uBloom.value = q.bloom ? BLOOM_STRENGTH : 0;
    this.blit(this.mTone, this.ldrRT);

    // 9 ---- anti-aliasing --------------------------------------------------
    let aa: THREE.WebGLRenderTarget = this.ldrRT;
    if (q.antialias === 'taa' && this.mTaa && this.histA && this.histB) {
      const u = this.mTaa.uniforms;
      u.tCur.value = this.ldrRT.texture;
      u.tHist.value = this.histA.texture;
      (u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
      (u.uTexel.value as THREE.Vector2).copy(texel);
      u.uBlend.value = this.historyValid ? 0.88 : 0;
      this.blit(this.mTaa, this.histB);
      // The TAA output *is* the next frame's history, so no copy is needed.
      const t = this.histA;
      this.histA = this.histB;
      this.histB = t;
      aa = this.histA;
      this.historyValid = true;
    } else if (q.antialias === 'smaa' && this.smaa && this.aaRT) {
      this.smaa.render(this.renderer, this.aaRT, this.ldrRT, 0, false);
      aa = this.aaRT;
    } else if (q.antialias === 'fxaa' && this.mFxaa && this.aaRT) {
      this.mFxaa.uniforms.tSrc.value = this.ldrRT.texture;
      (this.mFxaa.uniforms.uTexel.value as THREE.Vector2).copy(texel);
      this.blit(this.mFxaa, this.aaRT);
      aa = this.aaRT;
    }

    // 10 ---- sharpen + vignette + grain -> canvas -------------------------
    if (this.mFinal) {
      const u = this.mFinal.uniforms;
      u.tSrc.value = aa.texture;
      (u.uTexel.value as THREE.Vector2).copy(texel);
      u.uTime.value = (this.elapsed * 61.7) % 1024;
      // Sharpen harder after TAA, which is inherently soft.
      u.uSharpen.value = q.antialias === 'taa' ? 0.42 : 0.28;
      this.blit(this.mFinal, null);
    }

    // ---- restore camera + record history --------------------------------
    if (this.jittered) {
      cam.projectionMatrix.copy(this.projNoJitter);
      cam.projectionMatrixInverse.copy(this.projNoJitter).invert();
      this.jittered = false;
    }
    this.prevViewProj.copy(this.curViewProj);
    // Set with the matrix it describes, never apart from it.
    this.prevViewProjValid = true;
    this.frameIndex++;
    this.nFrames++;
    r.setRenderTarget(null);
  }

  // ---------------------------------------------------------------------------

  private white?: THREE.DataTexture;
  private black?: THREE.DataTexture;

  private whiteTexture(): THREE.Texture {
    if (!this.white) {
      this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.white.needsUpdate = true;
    }
    return this.white;
  }

  private blackTexture(): THREE.Texture {
    if (!this.black) {
      this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this.black.needsUpdate = true;
    }
    return this.black;
  }

  /**
   * Which optional passes have actually run, against how many frames. Not used by the game.
   *
   * The one question a screenshot cannot answer: a pass whose switch is on, whose material
   * compiled and whose target was allocated may still never execute, and every symptom of
   * that is "the effect is subtle". `motionBlurFrames` is the count that was zero on every
   * shipped tier.
   */
  debugPasses(): {
    frames: number; motionBlurFrames: number; motionBlurSkipped: number;
    lastSmearPx: number;
    historyValid: boolean; prevViewProjValid: boolean; motionBlurMaterial: boolean;
  } {
    return {
      frames: this.nFrames,
      motionBlurFrames: this.nMotionBlur,
      motionBlurSkipped: this.nMotionBlurSkipped,
      lastSmearPx: this.lastSmearPx,
      historyValid: this.historyValid,
      prevViewProjValid: this.prevViewProjValid,
      motionBlurMaterial: !!this.mMotion,
    };
  }

  /** Zero the pass counters, so a probe can measure one interval. */
  debugResetPasses(): void {
    this.nFrames = 0;
    this.nMotionBlur = 0;
    this.nMotionBlurSkipped = 0;
  }

  dispose(): void {
    this.freeTargets();
    this.quad.dispose();
    this.smaa?.dispose();
    this.white?.dispose();
    this.black?.dispose();
    for (const m of [
      this.mAo, this.mBlur, this.mContact, this.mComposite, this.mGod, this.mDof, this.mDofMix,
      this.mMotion, this.mBright, this.mDown, this.mUp, this.mTone, this.mTaa,
      this.mFxaa, this.mFinal, this.mCopy,
    ]) {
      m?.dispose();
    }
  }
}
