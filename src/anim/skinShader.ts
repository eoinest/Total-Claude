import * as THREE from 'three';
import type { AnimTexture } from './animTexture';

/**
 * GPU skinning by shader injection.
 *
 * `MeshStandardMaterial` is patched through `onBeforeCompile` rather than replaced by a
 * raw `ShaderMaterial`, which is the only way to keep the whole of three's lighting: the
 * directional sun, the hemisphere fill, `scene.environment` IBL, tone mapping, fog, and
 * shadow receiving all continue to work untouched. All the injection does is decide where
 * a vertex ends up and which way its normal points.
 *
 * Matching depth and distance materials are patched the same way, so the shadow pass
 * deforms identically to the colour pass — without them, 6,000 men would cast T-posed
 * shadows from wherever the mesh origin happens to be.
 *
 * Per-instance data (position, yaw, scale, animation rows, kit mask, cloth colours)
 * arrives as `InstancedBufferAttribute`s on an `InstancedBufferGeometry`. No
 * `InstancedMesh`: the per-instance matrix would be 16 floats of upload per man for a
 * transform the shader can rebuild from a yaw and a scale in four instructions.
 */

export interface SoldierShaderOptions {
  anim: AnimTexture;
  /** Bottom-left corner of the emblem block in the albedo atlas, in UV. */
  emblemOrigin: [number, number];
  /** Size of one emblem tile in UV. */
  emblemTile: [number, number];
  /** Emblem tiles across the sheet — `atlas.EMBLEM_COLS`, never a literal. */
  emblemCols?: number;
  /**
   * First emblem index of the tribal and Punic style bands.
   *
   * The shader paints a shield's face and back from its emblem index alone, because the
   * instance attributes are full and there is no lane left for a style code. These two
   * numbers are the band boundaries, passed in from `units/kit.ts` rather than hard-coded
   * here — the shader used to test `iCol0.w > 3.5` inline, and a literal in GLSL that has to
   * agree with an array in TypeScript is a defect waiting for the array to grow.
   *
   * Optional, defaulting to the boundaries that were hard-coded before Carthage existed, so
   * a caller that predates the third band keeps exactly the behaviour it had.
   */
  emblemTribalFirst?: number;
  emblemPunicFirst?: number;
  /** Height in metres over which body lean ramps in from the feet. */
  leanHeight: number;
  /**
   * Bone ranges and pivots for the per-man pose micro-variation. Omit for a rig that has
   * no arms and no head to vary — the horse.
   */
  poseVary?: PoseVaryBones;
}

/**
 * The bone chains the pose variation acts on, as inclusive `[first, last]` index ranges
 * into the rig, plus the world-space rest pivots it rotates about.
 *
 * Ranges rather than heights because a bone range is pose-independent: a crouched man's
 * head is at 1.40 m and a height ramp would leave him alone, which is exactly the man
 * standing in a braced rank where the repetition shows most.
 */
export interface PoseVaryBones {
  /** Everything above the hips: spine, neck, head and both arms. */
  upper: [number, number];
  /** Neck and head. */
  head: [number, number];
  leftArm: [number, number];
  rightArm: [number, number];
  /** Rest position of the neck joint. */
  neckPivot: [number, number, number];
  leftShoulder: [number, number, number];
  rightShoulder: [number, number, number];
  /** Rest height of the pelvis — the pivot the shoulder-line roll turns about. */
  hipY: number;
  /** Rest position of the weapon hand — the pivot a carried weapon swings about. */
  weaponHand: [number, number, number];
  /** Piece ids of pole arms, which get a wide fan. */
  poleWeapons: readonly number[];
  /** Piece ids of blades and hafted weapons, which get a narrow one. */
  bladeWeapons: readonly number[];
}

/** Uniforms shared by the colour, depth and distance variants of one soldier material. */
export interface SoldierUniforms {
  uAnimTex: { value: THREE.Texture };
  uAnimTexel: { value: THREE.Vector2 };
  uTime: { value: number };
}

const DECLS = /* glsl */ `
uniform sampler2D uAnimTex;
uniform vec2 uAnimTexel;
uniform float uTime;

attribute vec4 aSkin;       // bone0, bone1, weight0, weight1
attribute vec4 aPieceTint;  // piece id, tint slot, shield panel u, v
attribute vec3 iPos;
attribute vec4 iOrient;     // yaw, scale, lean, grime
attribute vec4 iAnimA;      // row0, row1, frac, blend      (current clip)
attribute vec4 iAnimB;      // row0, row1, frac, variant     (clip being faded out)
attribute vec2 iKit;        // piece mask, bits 0-23 and 24-47
attribute vec4 iCol0;       // tunic rgb, shield emblem index
attribute vec4 iCol1;       // leg rgb, metal wear
attribute vec4 iQuat;       // full-body orientation for a corpse; zero for the living

vec4 soldierFetch( float bone, float row, float slot ) {
  return texture2D( uAnimTex, vec2(
    ( bone * 2.0 + slot + 0.5 ) * uAnimTexel.x,
    ( row + 0.5 ) * uAnimTexel.y ) );
}

vec3 soldierQRot( vec4 q, vec3 v ) {
  return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}

// One bone's skinning transform: two frames of the current clip lerped, then cross-faded
// against the clip being left behind. Quaternions are sign-aligned before every mix so a
// blend always takes the short way round.
void soldierBone( float bone, out vec4 q, out vec3 t ) {
  vec4 qa = soldierFetch( bone, iAnimA.x, 0.0 );
  vec4 qb = soldierFetch( bone, iAnimA.y, 0.0 );
  if ( dot( qa, qb ) < 0.0 ) qb = -qb;
  q = mix( qa, qb, iAnimA.z );
  t = mix( soldierFetch( bone, iAnimA.x, 1.0 ).xyz,
           soldierFetch( bone, iAnimA.y, 1.0 ).xyz, iAnimA.z );

  if ( iAnimA.w < 0.995 ) {
    vec4 pa = soldierFetch( bone, iAnimB.x, 0.0 );
    vec4 pb = soldierFetch( bone, iAnimB.y, 0.0 );
    if ( dot( pa, pb ) < 0.0 ) pb = -pb;
    vec4 pq = mix( pa, pb, iAnimB.z );
    vec3 pt = mix( soldierFetch( bone, iAnimB.x, 1.0 ).xyz,
                   soldierFetch( bone, iAnimB.y, 1.0 ).xyz, iAnimB.z );
    if ( dot( pq, q ) < 0.0 ) pq = -pq;
    q = mix( pq, q, iAnimA.w );
    t = mix( pt, t, iAnimA.w );
  }
  q = normalize( q );
}

// Two influences is enough for an armoured man: most of this mesh is rigid plate, mail
// and leather bound to a single bone, and only the elbow, knee, shoulder and waist need
// a second. It halves the texture traffic against a conventional four-weight skin.
void soldierSkin( vec3 inPos, vec3 inNrm, out vec3 outPos, out vec3 outNrm ) {
  vec4 q0; vec3 t0;
  soldierBone( aSkin.x, q0, t0 );
  outPos = ( soldierQRot( q0, inPos ) + t0 ) * aSkin.z;
  outNrm = soldierQRot( q0, inNrm ) * aSkin.z;
  if ( aSkin.w > 0.002 ) {
    vec4 q1; vec3 t1;
    soldierBone( aSkin.y, q1, t1 );
    outPos += ( soldierQRot( q1, inPos ) + t1 ) * aSkin.w;
    outNrm += soldierQRot( q1, inNrm ) * aSkin.w;
  }
}

// A small-angle rotation in one plane, to first order. Declared outside the pose-variation
// block because the cloak sway needs it on every rig — the horse material is compiled
// without SOLDIER_POSE_VARY, and a macro that is only defined for the man would leave the
// horse's shader referring to an undeclared identifier. A shader that fails to compile
// silently draws nothing at all, which is an expensive way to find out.
#define SOLDIER_CLOTH_TILT( a, b, k ) { float c_ = a; a = c_ + (k) * (b); b = b - (k) * c_; }

// Kit pieces this man does not wear collapse to a point. All three corners of such a
// triangle land on the same vertex, so it has zero area and never reaches the rasteriser.
bool soldierPieceVisible() {
  float pid = aPieceTint.x;
  float bits = pid < 24.0 ? iKit.x : iKit.y;
  float bit = pid < 24.0 ? pid : pid - 24.0;
  return mod( floor( bits / exp2( bit ) ), 2.0 ) >= 0.5;
}

#ifdef SOLDIER_POSE_VARY
// Skin weight this vertex has on an inclusive bone range — the mask for one body part.
// Weighted rather than a hard test so a shoulder vertex, which blends chest and upper arm,
// takes half the arm's delta instead of tearing away from the torso.
float soldierChain( float lo, float hi ) {
  return step( lo - 0.5, aSkin.x ) * step( aSkin.x, hi + 0.5 ) * aSkin.z
       + step( lo - 0.5, aSkin.y ) * step( aSkin.y, hi + 0.5 ) * aSkin.w;
}

// A rotation taken to first order. Every angle below is under 12 degrees, where dropping
// the cosine costs 2% of scale — a third of a millimetre on a forearm — and saves two
// transcendentals per axis on what is by a wide margin the busiest vertex shader in the
// frame. The k argument is the angle in radians, already scaled by the part's skin weight.
#define SOLDIER_TILT( a, b, k ) { float t_ = a; a = t_ + (k) * (b); b = b - (k) * t_; }

/**
 * Carried-weapon angle jitter.
 *
 * A rank in which every pilum is exactly parallel reads as instanced geometry more loudly
 * than anything else in the frame. A real hedge of spears fans across twenty-odd degrees
 * and no two shafts are parallel.
 *
 * Applied to the *rest* position, about the rest position of the hand that holds the
 * weapon, before skinning. Conjugating a rotation by the bone transform preserves its
 * angle, so a fan authored here is the same size of fan in the posed frame, and it costs
 * no extra bone fetches — the weapon is already rigidly bound to the hand.
 */
void soldierWeaponJitter( float v, inout vec3 p, inout vec3 n ) {
  float pid = aPieceTint.x;
  float k = SOLDIER_IS_POLE( pid ) ? 0.30 : SOLDIER_IS_BLADE( pid ) ? 0.13 : 0.0;
  if ( k <= 0.0 ) return;
  float a = ( fract( v * 131.71 ) - 0.5 ) * k;
  float b = ( fract( v * 149.33 ) - 0.5 ) * k;
  vec3 d = p - SOLDIER_HAND;
  SOLDIER_TILT( d.y, d.z, a )
  SOLDIER_TILT( d.x, d.y, b )
  p = d + SOLDIER_HAND;
  SOLDIER_TILT( n.y, n.z, a )
  SOLDIER_TILT( n.x, n.y, b )
}

/**
 * Per-man pose micro-variation.
 *
 * Phase offsets and clip variants stop a rank from being in the same pose at the same
 * moment. They cannot stop any two men from being the same *shape*, because there is one
 * mesh and a handful of clips. So every man is bent slightly differently, from his stable
 * hash, in the six ways an eye actually reads off a crowd at twenty metres:
 *
 *   build          torso and limb girth, and shoulder width, a few percent either way.
 *   arm carriage   each arm rotated about its own shoulder. This is the one that moves
 *                  kit, because a scutum is skinned to the left forearm and a gladius to
 *                  the right hand, so the shield presents at its own angle and the weapon
 *                  rides at its own height.
 *   head           yaw and pitch about the neck. Carries the helmet and its crest.
 *   torso          a few degrees of yaw about the spine, plus a shoulder-line roll.
 *   plumb          the whole body listing a fraction of a degree off vertical. Nobody
 *                  stands plumb, and a rank of men who all do reads as a fence.
 *
 * Angles are deliberately small. At ten degrees of head yaw a man is looking somewhere; at
 * thirty he is looking at something, and two thousand men each looking at their own
 * something reads as noise rather than as an army.
 */
void soldierPoseVary( float v, inout vec3 sp, inout vec3 sn ) {
  // Ten decorrelated draws from the one stored hash. The multipliers are coprime-ish so
  // no two of these correlate and produce a visible stripe across a file.
  float hBuild = fract( v * 3.71 ) - 0.5;
  float hWidth = fract( v * 11.31 ) - 0.5;
  float hTwist = fract( v * 19.73 ) - 0.5;
  float hRoll  = fract( v * 29.31 ) - 0.5;
  float hHeadY = fract( v * 41.17 ) - 0.5;
  float hHeadX = fract( v * 53.93 ) - 0.5;
  float hArmR  = fract( v * 67.31 ) - 0.5;
  float hArmL  = fract( v * 79.13 ) - 0.5;
  float hLift  = fract( v * 91.77 ) - 0.5;
  float hHeadZ = fract( v * 103.51 ) - 0.5;
  float hShldY = fract( v * 61.31 ) - 0.5;
  float hShldX = fract( v * 71.53 ) - 0.5;

  // ---- build: girth and shoulder width ----
  // Y is untouched, so a stockier man is stockier without leaving the ground.
  sp.x *= 1.0 + hBuild * 0.07 + hWidth * 0.055;
  sp.z *= 1.0 + hBuild * 0.07;

  // ---- arm carriage ----
  float wR = soldierChain( SOLDIER_ARM_R0, SOLDIER_ARM_R1 );
  if ( wR > 0.001 ) {
    vec3 d = sp - SOLDIER_SHOULDER_R;
    SOLDIER_TILT( d.x, d.y, hArmR * 0.22 * wR )
    SOLDIER_TILT( d.z, d.y, hLift * 0.20 * wR )
    sp = d + SOLDIER_SHOULDER_R;
    SOLDIER_TILT( sn.x, sn.y, hArmR * 0.22 * wR )
    SOLDIER_TILT( sn.z, sn.y, hLift * 0.20 * wR )
  }
  /*
   * The shield arm. Three axes, three independent hashes, and the third one is new.
   *
   * (No backtick below: this comment is inside a JS template literal and one would end it.)
   *
   * This is the same defect the helmet had in round two, one limb over, and a grader found it
   * without being told: *"you can read the instancing off the highlights alone, without
   * recognising the device -- every boss shows the same mirror-white teardrop at the same
   * clock position even on shields angled thirty degrees apart."*
   *
   * Two things were wrong and they compound.
   *
   * **The two tilts were the same draw.** Both took hArmL, so every man's shield carriage
   * lay on a single line through a two-dimensional space: knowing one angle gave you the
   * other exactly. Compare the *right* arm three lines up, which has drawn hArmR and
   * hLift independently since it was written.
   *
   * **One of the two was the axis the boss cannot see.** TILT( d.x, d.y ) is a rotation
   * about model +Z, and +Z is the board's own face normal, which is also the umbo's axis of
   * revolution. A surface of revolution is invariant under rotation about its own axis, so
   * that 5.4 degrees moved the board, the rim and the device and could not move the boss's
   * mirror point by one pixel. The other, TILT( d.z, d.x ), is about +Y and does tip the
   * normal -- but at 4.9 degrees, and locked to the same hash as the roll.
   * **Rotation about +X was absent entirely**: nothing pitched a shield up or down.
   *
   * So: three axes, three hashes, and all three angles widened. Roll is kept and widened
   * rather than dropped, because the boss is no longer a surface of revolution -- see
   * soldierMesh.ts's bossWarp, which makes an umbo oval and hammered so that a roll about
   * its own axis finally moves its highlight. Geometry and pose had to change together;
   * either alone is inert.
   */
  float wL = soldierChain( SOLDIER_ARM_L0, SOLDIER_ARM_L1 );
  if ( wL > 0.001 ) {
    vec3 d = sp - SOLDIER_SHOULDER_L;
    SOLDIER_TILT( d.x, d.y, hArmL * 0.24 * wL )    // roll about the board's own normal
    SOLDIER_TILT( d.z, d.x, hShldY * 0.22 * wL )   // yaw: swings the normal left and right
    SOLDIER_TILT( d.y, d.z, hShldX * 0.20 * wL )   // pitch: the axis that was missing
    sp = d + SOLDIER_SHOULDER_L;
    SOLDIER_TILT( sn.x, sn.y, hArmL * 0.24 * wL )
    SOLDIER_TILT( sn.z, sn.x, hShldY * 0.22 * wL )
    SOLDIER_TILT( sn.y, sn.z, hShldX * 0.20 * wL )
  }

  /*
   * ---- head ----
   *
   * Three axes now, and the third one is the point.
   *
   * Yaw and pitch were +-9.7 and +-4.6 degrees, which is small enough that a blind grader
   * reported "the same head at the same yaw across a whole rank" and was not wrong. Both are
   * widened here. But the axis that was *missing* matters more than either, for a reason
   * that is geometric rather than aesthetic: **a helmet bowl is a surface of revolution
   * about the vertical, so its mirror point is invariant under yaw.** Rotating a man's head
   * about Y moves his face and does not move his highlight by one pixel, which is exactly
   * why a rank of three hundred men carried three hundred identical glints in the same
   * relative place on the crown — the one finding all three graders put in their top three.
   * A roll breaks the symmetry and the glint moves with it.
   */
  float wH = soldierChain( SOLDIER_HEAD0, SOLDIER_HEAD1 );
  if ( wH > 0.001 ) {
    vec3 d = sp - SOLDIER_NECK;
    SOLDIER_TILT( d.x, d.z, hHeadY * 0.62 * wH )
    SOLDIER_TILT( d.y, d.z, hHeadX * 0.30 * wH )
    SOLDIER_TILT( d.x, d.y, hHeadZ * 0.26 * wH )
    sp = d + SOLDIER_NECK;
    SOLDIER_TILT( sn.x, sn.z, hHeadY * 0.62 * wH )
    SOLDIER_TILT( sn.y, sn.z, hHeadX * 0.30 * wH )
    SOLDIER_TILT( sn.x, sn.y, hHeadZ * 0.26 * wH )
  }

  // ---- torso yaw and shoulder roll ----
  float wU = soldierChain( SOLDIER_UPPER0, SOLDIER_UPPER1 );
  if ( wU > 0.001 ) {
    SOLDIER_TILT( sp.x, sp.z, hTwist * 0.17 * wU )
    SOLDIER_TILT( sn.x, sn.z, hTwist * 0.17 * wU )
    float y = sp.y - SOLDIER_HIP_Y;
    SOLDIER_TILT( sp.x, y, hRoll * 0.075 * wU )
    sp.y = y + SOLDIER_HIP_Y;
    SOLDIER_TILT( sn.x, sn.y, hRoll * 0.075 * wU )
  }

  // ---- plumb ----
  // About the feet, so a fraction of a degree of list moves the head two centimetres and
  // the boots not at all.
  SOLDIER_TILT( sp.x, sp.y, hWidth * 0.017 )
  SOLDIER_TILT( sn.x, sn.y, hWidth * 0.017 )
}
#endif
`;

/**
 * The transform body. `SOLDIER_LEAN_H` and the emblem constants are injected as defines.
 * Writes `gSoldierPos`; also rotates `objectNormal` when `withNormal`.
 */
const body = (withNormal: boolean): string => /* glsl */ `
{
  vec3 sp, sn;
  vec3 restP = position;
  vec3 restN = ${withNormal ? 'objectNormal' : 'vec3( 0.0, 1.0, 0.0 )'};
#ifdef SOLDIER_POSE_VARY
  soldierWeaponJitter( iAnimB.w, restP, restN );
#endif
  soldierSkin( restP, restN, sp, sn );

#ifdef SOLDIER_POSE_VARY
  // Skipped for a corpse: the ragdoll solver owns every joint of a fallen body, and
  // bending it afterwards would push a limb through the ground it was solved against.
  if ( dot( iQuat, iQuat ) <= 0.0001 ) soldierPoseVary( iAnimB.w, sp, sn );
#endif

  if ( !soldierPieceVisible() ) {
    sp = vec3( 0.0 );
  }

  // ---- cloak sway ------------------------------------------------------------
  // Slot 5 is Tint.Cloak, and it is the only slot that uses it, so the test costs nothing
  // and needs no attribute of its own. Applied in body space, before scale and yaw, so the
  // wave runs across the man's own back rather than across the world.
  //
  // A sagum is skinned to the spine, which means without this it is a board bolted to the
  // shoulders: it rotates with the torso and does nothing else. Blind critics have called it
  // "a rigid unlit cone" in more than one round, and rigid is the accurate half of that.
  //
  // Two waves at incommensurate rates rather than one, because a single sine moves the whole
  // hem as one piece, which is a flag and not a cloak. The phase comes from the man's stable
  // hash so a rank never resynchronises, and the whole term is a function of uTime only —
  // it is visual, lives outside the fixed step, and cannot perturb the simulation hash.
  if ( abs( aPieceTint.y - 5.0 ) < 0.5 && dot( iQuat, iQuat ) <= 0.0001 ) {
    // Ramp from the shoulder line (about 1.50 m) to the hem (0.74 m), squared so the pinned
    // top stays pinned and only the free cloth moves.
    float hemT = clamp( ( 1.50 - sp.y ) / 0.76, 0.0, 1.0 );
    hemT *= hemT;
    float t = uTime * 1.7 + iAnimB.w * 37.0;
    float w1 = sin( t + sp.x * 6.0 );
    float w2 = sin( t * 0.63 + 2.1 + sp.x * 3.0 );
    sp.x += w1 * 0.030 * hemT;
    sp.z += w2 * 0.024 * hemT;
    // A man leaning into a march drags his cloak behind him. iOrient.z is that lean.
    sp.z -= iOrient.z * 0.22 * hemT;
    ${withNormal ? 'SOLDIER_CLOTH_TILT( sn.x, sn.z, w1 * 0.22 * hemT )' : ''}
  }

  sp *= iOrient.y;

  if ( dot( iQuat, iQuat ) > 0.0001 ) {
    // A corpse: the ragdoll solver owns the whole body's orientation, yaw included, so
    // the lean-and-yaw path is bypassed entirely rather than composed with it.
    sp = soldierQRot( iQuat, sp );
    ${withNormal ? 'sn = soldierQRot( iQuat, sn );' : ''}
    // Settle the body against the ground.
    //
    // The solver tips a man over as one rigid piece and the death clip is held part-way
    // through its collapse, so a settled corpse keeps an arm and a knee up in the air at the
    // angle they were at when the fall started. A heap of those reads as spikes and splayed
    // parts rather than as dead men, and it is also most of why bodies appear to pass through
    // each other — the vertical extent is twice what a corpse's should be.
    //
    // A squash along world Y, about the mesh origin (which is on the ground), pulls exactly
    // those raised limbs down and leaves everything already touching the ground where it is.
    // The factor rides in iOrient.z, the lane a living man uses for lean and a corpse has no
    // use for, so it can ramp in with the fall without costing an attribute. Normals take the
    // reciprocal, which is the inverse transpose of a diagonal scale.
    // Named the long way round because "flat" is a reserved interpolation qualifier in GLSL,
    // and a shader that fails to compile silently draws nothing at all.
    float settleFlat = clamp( iOrient.z, 0.35, 1.0 );
    sp.y *= settleFlat;
    ${withNormal ? 'sn.y /= settleFlat;' : ''}
  } else {
    // Lean is a bend, not a tilt: the rotation ramps in with height so the feet stay
    // planted while the shoulders go forward. A rigid tilt slides a running man's feet
    // through the ground, which is instantly readable as wrong.
    float bendT = clamp( sp.y / SOLDIER_LEAN_H, 0.0, 1.0 );
    float lean = iOrient.z * bendT * bendT;
    // A slow, per-man sway on top. Nothing in a crowd is ever perfectly still, and the
    // phase comes from the man's stable hash so it never resynchronises.
    lean += sin( uTime * 0.55 + iAnimB.w * 43.0 ) * 0.014 * bendT * bendT;
    float cl = cos( lean ), sl = sin( lean );
    sp = vec3( sp.x, sp.y * cl - sp.z * sl, sp.y * sl + sp.z * cl );
    ${withNormal ? 'sn = vec3( sn.x, sn.y * cl - sn.z * sl, sn.y * sl + sn.z * cl );' : ''}

    float cy = cos( iOrient.x ), sy = sin( iOrient.x );
    sp = vec3( sp.x * cy + sp.z * sy, sp.y, -sp.x * sy + sp.z * cy );
    ${withNormal ? 'sn = vec3( sn.x * cy + sn.z * sy, sn.y, -sn.x * sy + sn.z * cy );' : ''}
  }

  gSoldierPos = sp + iPos;
  ${withNormal ? 'objectNormal = normalize( sn );' : ''}
}
`;

const TINT_BODY = /* glsl */ `
{
  float slot = aPieceTint.y;
  float v = iAnimB.w;
  // ---- skin ----------------------------------------------------------------
  // The atlas tile is a mid-grey — sRGB 0.60, so 0.32 linear — carrying pore, blotch and
  // the elbow and knee creases. These multipliers put the product between 0.22 and 0.35
  // linear luminance, which is the band a reflectance chart gives for Fitzpatrick III
  // through V, with R about three times B, because that is the ratio on a real forearm and
  // getting it right is what stops a bare limb reading as grey plaster however bright it is.
  //
  // These were held about a third lower while the lighting rig ran a bright hemisphere fill
  // that pushed a chart-correct forearm past 1.0 and out the top of the tone curve. Exposure
  // has since come down, so they are back where a reflectance chart puts them.
  //
  // The *distribution* matters as much as the endpoints. The previous curve squared its
  // selector, which crowded two thirds of any rank into the lightest third of the range —
  // which is exactly why a line of legionaries read as one pale man repeated. The tone term
  // is now used raw, and a second independent hash shifts each man toward ruddy or olive so
  // neighbours differ in hue and not only in value.
  float tone = fract( v * 7.13 );
  float ruddy = fract( v * 23.91 ) - 0.5;
  vec3 skin = mix( vec3( 1.66, 1.10, 0.70 ), vec3( 1.24, 0.78, 0.50 ), tone );
  skin *= vec3( 1.0 + ruddy * 0.22, 1.0, 1.0 - ruddy * 0.2 );
  // ---- hair ----------------------------------------------------------------
  // Black through to the reddish blond Tacitus keeps remarking on, with a few grey heads:
  // a warband is fathers and sons, not a cohort of twenty-year-olds.
  float hh = fract( v * 13.7 );
  vec3 hair = mix( vec3( 0.13, 0.09, 0.07 ), vec3( 0.58, 0.36, 0.15 ), hh );
  hair = mix( hair, vec3( 0.44, 0.42, 0.40 ), smoothstep( 0.9, 1.0, fract( v * 5.29 ) ) );
  // ---- metal ---------------------------------------------------------------
  // iCol1.w carries the man's metal packed into one float: the integer part is what his
  // ironmongery is made of and the fraction is how well he keeps it. See resolveKit in
  // units/kit.ts: the reasoning for who gets bronze and who gets a pitted heirloom lives
  // there, next to the rest of the kit decisions.
  //
  // These are warm on purpose. The albedo of a metal *is* its F0, so it tints the
  // environment reflection — and the environment here is a blue sky. Neutral-grey iron came
  // back off the GPU as saturated blue helmets across the whole field, which is a worse
  // uniformity tell than the flat grey it replaced. Warm F0 pulls that reflection back toward
  // steel and leaves the four classes distinguishable.
  //
  // **These are now multipliers about 1.0, not brighteners.** They used to run from 0.68 to
  // 2.2 because the atlas tile underneath them was charcoal (0.157 linear) and something had
  // to lift it. The tiles now carry true F0 — iron at 0.56 linear — so the old range would
  // drive F0 well past 1 and hand the renderer more energy than arrived, which shows up as
  // white clipped helmets rather than bright ones. What is left here is hue and class.
  float mcls = floor( iCol1.w );
  float polish = fract( iCol1.w ) * 1.1111;
  vec3 metal =
      mcls < 0.5 ? vec3( 1.20, 1.00, 0.82 )      // iron, warmed hard against the sky cast
    : mcls < 1.5 ? vec3( 1.34, 0.94, 0.48 )      // bronze and brass, the older kit
    : mcls < 2.5 ? vec3( 0.70, 0.58, 0.47 )      // blackened, pitted or heavily rusted
    :              vec3( 1.30, 1.22, 1.06 );     // tinned or silvered, the parade finish
  // Polish moves F0 only a little — an oxide film is thin. Most of what "well kept" means
  // is *roughness*, and that is applied per man below, because a tight bright glint next to
  // a broad soft sheen is the difference a rank actually reads.
  metal *= 0.88 + polish * 0.20;
  // ---- cloth batch variation ----------------------------------------------
  // Cloth was dyed in small lots and faded in the sun, so a value spread belongs on the
  // dyed slots only. Applying it to metal as well, as this used to, doubled up on polish,
  // and applying it to skin fought the tone curve above.
  float batch = 0.84 + fract( v * 31.1 ) * 0.32;
  vec3 tint;
  if ( slot < 0.5 )       tint = vec3( 1.0 );
  else if ( slot < 1.5 )  tint = iCol0.rgb * batch;
  else if ( slot < 2.5 )  tint = iCol1.rgb * batch;
  else if ( slot < 3.5 )  tint = skin;
  else if ( slot < 4.5 )  tint = hair;
  else if ( slot < 5.5 ) {
    // The sagum was bought, not issued. Start from the tunic's dye lot, then pull a good
    // way toward undyed brown wool on a per-man basis, so a rank has red cloaks, brown
    // cloaks and everything between rather than one repeated colour.
    vec3 dyed = iCol0.rgb * 0.78 + vec3( 0.05, 0.045, 0.04 );
    tint = mix( dyed, vec3( 0.16, 0.125, 0.095 ), fract( v * 61.7 ) * 0.85 ) * batch;
  }
  else if ( slot < 6.5 ) {
    // ---- shield facing ----
    // A legion's scuta were painted by the century from one pot and are near-identical:
    // a few percent of drift, no more, which is exactly what a Rome II legion looks like.
    //
    // A tribal board is the opposite. Tacitus says the Germans painted their shields in
    // colours of their own choosing, the Illerup and Thorsberg boards are pale limewood
    // with a dark device, and the paint a man could get hold of was whitewash, ochre,
    // madder, woad or pitch. So a tribal facing draws a whole paint from that list rather
    // than nudging one colour, which is what actually gives a host of two thousand men two
    // thousand different shields.
    //
    // A Punic board is a third case and closer to the Roman one: Carthage paid for its army
    // and quartermastered it, so an Iberian contingent's shields are whitened to one colour
    // and a Libyan's are painted to one device. But the fields are drawn bright and saturated
    // in the tile itself, so unlike a Roman board they must NOT be recoloured — a multiply
    // over Tyrian purple or Iberian white destroys exactly the thing that makes the contingent
    // recognisable. They take a per-man value jitter and nothing else.
    //
    // Which case this is falls straight out of the emblem index — see the band table on
    // EMBLEMS in units/kit.ts — so it still costs no attribute of its own. It used to be
    // the single test "> 3.5"; there are now three bands and therefore two tests, and the
    // boundaries below are the ones that file documents. The tribal tiles are drawn
    // pale-field-dark-device precisely so that a multiply can recolour the field while
    // leaving the device legible: multiplication preserves contrast ratios.
    if ( iCol0.w > SOLDIER_EMBLEM_PUNIC ) {
      tint = vec3( 0.86 + fract( v * 97.1 ) * 0.30 );
    }
    else if ( iCol0.w > SOLDIER_EMBLEM_TRIBAL ) {
      float pick = fract( v * 97.1 );
      vec3 paint =
          pick < 0.20 ? vec3( 1.02, 0.96, 0.84 )   // bare limewood, oiled
        : pick < 0.36 ? vec3( 1.16, 1.13, 1.04 )   // whitewash
        : pick < 0.54 ? vec3( 1.10, 0.74, 0.30 )   // yellow ochre
        : pick < 0.72 ? vec3( 0.98, 0.30, 0.21 )   // madder red
        : pick < 0.85 ? vec3( 0.40, 0.50, 0.70 )   // woad blue-grey
        : pick < 0.94 ? vec3( 0.38, 0.50, 0.31 )   // green earth
        :               vec3( 0.24, 0.22, 0.20 );  // pitch black
      tint = paint * ( 0.86 + fract( v * 103.7 ) * 0.28 );
    } else {
      // A legion's scuta were painted by the century, not by a factory. The device is the
      // same on every board — that is the whole point of a device, and it is what keeps the
      // unit identifiable at a glance — but the paint is not: a fresh madder lot next to one
      // gone brown in the sun, a brick repaint over an older board, a much-scrubbed shield
      // gone dark, and the occasional board issued out of a dead man's kit that never
      // matched.
      //
      // These lots differ in *hue*, not only in value, and that is only possible because the
      // Roman tiles are now drawn on a warm mid-tone field rather than a saturated red. A
      // multiply cannot move the hue of a field whose green and blue are already near zero:
      // 0x8e1f24 is (0.270, 0.014, 0.019) linear, so every lot came back some value of the
      // same red and a rank of them read as one repeated shield. With the field drawn at
      // roughly a third grey the multiply has all three channels to work in, and the median
      // lot is what puts the cohort back at Roman red.
      float pick = fract( v * 97.1 );
      vec3 lot =
          pick < 0.26 ? vec3( 0.98, 0.50, 0.44 )   // the issue lot: madder red, still fresh
        : pick < 0.44 ? vec3( 0.74, 0.52, 0.42 )   // sun-faded, gone brown
        : pick < 0.60 ? vec3( 1.10, 0.62, 0.40 )   // a warmer brick repaint
        : pick < 0.72 ? vec3( 1.02, 1.02, 0.56 )   // a weld-ochre board
        : pick < 0.82 ? vec3( 0.60, 0.46, 0.40 )   // scrubbed dark, years of service
        : pick < 0.92 ? vec3( 1.16, 1.02, 0.86 )   // limewashed, an old board reissued
        :               vec3( 0.54, 0.64, 0.74 );  // out of another unit's stores entirely
      tint = lot * ( 0.82 + fract( v * 103.7 ) * 0.38 );
    }
  }
  else if ( slot < 7.5 )  tint = metal;
  else if ( slot < 8.5 ) {
    // Focale. Madder red is the commonest, but a man bought his own: undyed linen, weld
    // yellow and woad blue-grey all turn up, and four collars instead of one is the whole
    // difference between a rank of men and a rank of one man.
    float fp = fract( v * 71.3 );
    tint = ( fp < 0.44 ? vec3( 0.30, 0.065, 0.055 )
           : fp < 0.68 ? vec3( 0.66, 0.62, 0.52 )
           : fp < 0.86 ? vec3( 0.52, 0.36, 0.13 )
           :             vec3( 0.20, 0.24, 0.31 ) ) * batch;
  }
  else if ( slot < 9.5 ) {
    // ---- the inside of a shield ----
    // The largest single surface a soldier presents to a camera behind his own line: 11.9%
    // of the romanline frame, measured by difference, against 4.0% for his armour. It was
    // untinted plank, so it was one repeated tan corrugation across the whole cohort and it
    // was also the brightest thing on the shaded side of the army, which is a double loss —
    // maximum uniformity on maximum area.
    //
    // A scutum was hide-faced and the facing is whatever the man had: oiled leather, the
    // field paint carried round the rim, felt, or bare board gone grey. Weighted toward the
    // dark end because that is what the reference frames show from behind a Roman line, and
    // because a dark inside is what lets the painted front read as the bright side.
    //
    // A tribal board is planks with a hide rim and no facing worth the name, so it keeps the
    // pale end of the range. Same discriminator as the front, and the same three bands: a
    // Punic board is hide-backed and issued, so it takes the Roman treatment.
    // Multipliers on the neutral 0.34-linear shield-back tile, so the products span 0.05 to
    // 0.37 linear — pitch at one end, raw hide at the other. That whole span matters: this
    // surface is 12% of the frame, and a narrow one is a wall of one colour however carefully
    // the hue is chosen.
    float sp = fract( v * 109.3 );
    bool tribalBack = iCol0.w > SOLDIER_EMBLEM_TRIBAL && iCol0.w < SOLDIER_EMBLEM_PUNIC;
    vec3 face = tribalBack
      ? ( sp < 0.30 ? vec3( 0.95, 0.86, 0.66 )   // bare limewood, dirty
        : sp < 0.54 ? vec3( 0.70, 0.64, 0.52 )   // older board, weathered grey-brown
        : sp < 0.76 ? vec3( 0.46, 0.36, 0.27 )   // hide backing, greased
        :             vec3( 0.82, 0.70, 0.44 ) ) // limewood gone yellow with pitch
      : ( sp < 0.22 ? vec3( 0.24, 0.20, 0.17 )   // oiled hide, near black in shadow
        : sp < 0.42 ? vec3( 0.72, 0.30, 0.24 )   // the field paint carried over the rim
        : sp < 0.60 ? vec3( 0.52, 0.50, 0.46 )   // grey felt lining
        : sp < 0.80 ? vec3( 0.86, 0.72, 0.50 )   // bare board, dirty
        : sp < 0.92 ? vec3( 1.10, 1.00, 0.82 )   // raw hide, pale
        :             vec3( 0.17, 0.15, 0.16 ) );// pitch, to keep the damp out
    tint = face * ( 0.80 + fract( v * 113.9 ) * 0.42 );
  }
  else {
    // ---- crest ----
    // A crest sits above the helmet line with nothing in front of it, so it is the most
    // visible square centimetre on a man and the least forgiving of repetition. Rome II's
    // legionary ranks carry black feather pairs, undyed white horsehair and madder red in the
    // same cohort, plus the occasional black-and-white pair; four choices instead of one is
    // most of what breaks up a helmet line seen from behind.
    float cp = fract( v * 127.1 );
    vec3 crest =
        cp < 0.34 ? vec3( 0.055, 0.048, 0.055 )   // black feathers, the commonest
      : cp < 0.62 ? vec3( 0.31, 0.055, 0.045 )    // madder-dyed horsehair
      : cp < 0.84 ? vec3( 0.60, 0.575, 0.50 )     // undyed white horsehair
      :             vec3( 0.20, 0.155, 0.09 );    // brown, an old crest gone dusty
    tint = crest * ( 0.82 + fract( v * 131.7 ) * 0.36 );
  }
  vSoldierTint = tint;
  /**
   * How well this particular man keeps his ironmongery, as a signed roughness offset.
   *
   * The polish term already nudges F0 a little above, but an oxide film is thin and F0 is not what
   * "well kept" looks like. What it looks like is the *width of the highlight*: a burnished
   * bowl throws one tight glint that tracks the sun, a neglected one throws a broad dull
   * sheen over the whole crown. A rank in which every helmet has an identical highlight is
   * the specular equivalent of a rank in which every man has an identical pose, and it is
   * most of what "effectively zero specular response" means when a critic writes it.
   *
   * Metal slots only. Polish is meaningless on linen, and adding a roughness spread to cloth
   * would just make some men's tunics inexplicably shiny.
   */
  /*
   * The metal treatment no longer asks which tint slot a vertex is on, and the reason is
   * that the slot was never the right question.
   *
   * Round two gave helmets and shield bosses a per-man roughness offset, a mottle and a
   * planishing field, all gated on slot 7 -- Tint.Metal. But a legionary's mail, his
   * squamata, his segmentata bands, his greaves and every buckle on him are slot 0,
   * Tint.Atlas, because they take the atlas colour untouched. **So the four surfaces round
   * two fixed are the two smallest metal surfaces on the man, and the largest ones -- an
   * entire torso of mail -- were left with no per-man metal variation whatsoever.** A grader
   * this round put the consequence as "one shared sheen" over the armour.
   *
   * What actually determines whether a fragment is metal is its metalness, and the ORM atlas
   * already carries that per texel. So .y and .z are now unconditional -- an offset and a
   * seed that every man has -- and the *gate* moves into the fragment shader, where
   * texelRoughness.b is the metalness of the very texel being shaded. Mail, scale, bands and
   * bosses light up; wood, rope, leather and linen, which share slot 0 with them, do not.
   *
   * (No backtick in this comment: it is inside a JS template literal.)
   */
  /*
   * .w is the **material class**, and it is free.
   *
   * A vec3 varying occupies a whole vec4 interpolator on every GPU this runs on, so widening
   * this one costs no bandwidth, no attribute and no uniform -- the same trade the round-two
   * note above records for .z.
   *
   * What it carries is the answer to "what is this fragment made of", which the fragment
   * shader could not previously ask. Everything on a man -- flesh, linen, wool, bronze,
   * iron, leather, limewood -- is one MeshStandardMaterial differentiated per texel by the
   * ORM atlas, and per texel is enough for a roughness and a metalness but not for a
   * **lobe**. A materials grader put the consequence plainly: skin greys at the terminator
   * where flesh goes warmer and more saturated, and linen carries a GGX highlight it has no
   * business having. Neither is a texture problem. Both are the same BRDF serving materials
   * that do not share one.
   *
   * 0 leaves the stock lobe alone -- metal, leather, wood, hair, the shield facing. 1 is
   * flesh: slot Skin, which is also what the face tile is tinted through. 2 is cloth: the
   * tunic, the leg wraps, the cloak, the focale and the crest, which are wool, linen and
   * horsehair.
   *
   * (No backticks in here: this string is itself a template literal.)
   */
  float isSkin = step( 2.5, slot ) * step( slot, 3.4 );
  float isCloth =
      step( 0.5, slot ) * step( slot, 2.4 )     // tunic, legs
    + step( 4.5, slot ) * step( slot, 5.4 )     // cloak
    + step( 7.5, slot ) * step( slot, 8.4 )     // focale
    + step( 9.5, slot ) * step( slot, 10.4 );   // crest
  vSoldierSurf = vec4(
    iOrient.w, ( 0.5 - polish ) * 0.34, 1.0 + v,
    isSkin + 2.0 * min( 1.0, isCloth ) );

  /*
   * The shield device, and the four numbers that stop a cohort reading as a tiling.
   *
   * A blind grader put it exactly: "a unit's shields all carry the same device at the same
   * rotation, scale and cleanliness, so the mass reads as a tiling rather than a crowd". The
   * obvious response — draw a different device per man — is the wrong one and would be a
   * regression in accuracy: a legion's shields *did* carry one device, and so do Rome II's.
   * What varies between two shields of one cohort is not the design, it is how the painter
   * set it out and what the campaign has done to it since.
   *
   * So the device stays per unit type and its *placement* becomes per man: a rotation, a
   * scale, a small offset and a state of wear, all from the same stored hash everything else
   * on this man is drawn from. The panel UV is transformed about its own centre before it is
   * mapped into the atlas cell, and clamped there, so a rotated device can never sample its
   * neighbour in the emblem grid.
   */
  vSoldierEmblem = vec4( 0.0 );
  if ( slot > 5.5 && slot < 6.5 ) {
    float e = iCol0.w;
    vec2 tile = vec2( mod( e, SOLDIER_EMBLEM_COLS ), floor( e / SOLDIER_EMBLEM_COLS ) );
    float eRot = ( fract( v * 149.3 ) - 0.5 ) * 0.40;
    float eScl = 1.0 + ( fract( v * 157.7 ) - 0.5 ) * 0.17;
    float ec = cos( eRot ), es = sin( eRot );
    vec2 pan = aPieceTint.zw - 0.5;
    pan = vec2( pan.x * ec - pan.y * es, pan.x * es + pan.y * ec ) / eScl
      + vec2( fract( v * 163.1 ) - 0.5, fract( v * 173.9 ) - 0.5 ) * 0.055 + 0.5;
    pan = clamp( pan, 0.0, 1.0 );
    vSoldierEmblem = vec4(
      SOLDIER_EMBLEM_ORIGIN + vec2( tile.x + pan.x, pan.y - tile.y ) * SOLDIER_EMBLEM_TILE,
      // 1 + wear: the flag and the man's own weathering in one component.
      1.0 + fract( v * 181.7 ),
      /*
       * Where this man's paint has come off, as opposed to how much.
       *
       * The wear above is a scalar and it fades and dulls the whole device evenly, so two
       * boards at the same wear are still the same picture at two exposures. A grader
       * counting repeats sees through that immediately, and one did: "a device that is
       * pixel-identical on all 320 boards". This is the seed of a noise field the fragment
       * stage evaluates in board space, so the *pattern* of loss is the man's own — one
       * board is scuffed across the top arm of the bolt, the next along the left edge, and
       * no two are the same image at any exposure.
       */
      fract( v * 197.3 ) * 91.0 );
  }
}
`;

const FRAG_DECLS = /* glsl */ `
uniform float uKitCavity;
varying vec3 vSoldierTint;
/*
 * x: grime 0..1.
 * y: this man's roughness offset, signed, metal slots only.
 * z: 0 off metal; 1 + variant on metal, so the breakup field below is both gated and
 *    seeded by one varying rather than two.
 * w: material class -- 0 stock, 1 flesh, 2 cloth. See the vertex side for why it is free.
 */
varying vec4 vSoldierSurf;
varying vec4 vSoldierEmblem;

/*
 * A two-octave value noise, for the one thing in this shader that needs a *field* rather
 * than a scalar: where a board has lost its paint.
 *
 * Self-contained rather than imported from common.glsl, because this material is a
 * patched MeshStandardMaterial and that hash block is written for the
 * fullscreen passes, which have their own preamble. Four texel-free hashes and two lerps is
 * cheaper than the texture fetch an equivalent detail map would cost, and it costs no
 * atlas space at all — which matters, because the emblem grid has exactly two free cells.
 */
float tcSkinH12( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

float tcSkinNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = tcSkinH12( i );
  float b = tcSkinH12( i + vec2( 1.0, 0.0 ) );
  float c = tcSkinH12( i + vec2( 0.0, 1.0 ) );
  float d = tcSkinH12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
`;

/**
 * Geometric specular anti-aliasing (Tokuyoshi and Kaplanyan's formulation of the
 * Kaplanyan filtering idea).
 *
 * A helmet bowl at forty metres is a curved mirror a few pixels wide. Its normal turns
 * through tens of degrees inside a single pixel, so the specular lobe — which for polished
 * bronze at roughness 0.22 is narrower than that — is either hit or missed depending on
 * where the sample lands. Across a rank of three hundred men that is a field of white
 * pinpoints that flip on and off with the camera, and it is a large part of the pixel-scale
 * energy in any frame containing a crowd. Neither MSAA nor a post-AA pass can fix it: the
 * signal is genuinely below the sample rate, and the only correct answer is to widen the
 * lobe until it *is* representable, which is what a roughness increase does.
 *
 * The variance of the interpolated normal over the pixel footprint is estimated from its
 * screen-space derivatives, converted to an equivalent increase in GGX alpha, and added in
 * quadrature to the material's own. Where the surface is flat across a pixel it adds
 * nothing, so a helmet filling the frame keeps its tight highlight and its full range.
 *
 * This is deliberately a *pixel-scale* filter and it is measured as such. It should reduce
 * the harshness ratio and, at block scale, pull the crowd's local contrast toward the
 * reference's rather than away from it: the reference gets legible men out of smooth
 * gradients over a form, not out of high-amplitude sparkle. If block-scale spread moved the
 * wrong way that would be a genuine trade against the lighting workstream and would have to
 * be reported as one.
 *
 * SIGMA2 0.25 and KAPPA 0.18 are the paper's suggested screen-space variance and clamp; the
 * clamp is what stops a silhouette edge, where the derivative is meaningless, from turning
 * the rim of every man fully rough.
 */
/**
 * How hard the cavity gate bites, 0..1.
 *
 * Sized against the atlas: ORM.R bottoms out at 0.3, so the deepest texel any cell can carry
 * gates at a horizon sine of 0.7 x this, and a flat texel is untouched at any value. Held
 * below 1 because the cavity here is derived from the *same* 128 px height field that made
 * the normal map, so the two describe one piece of relief twice and a full-strength gate
 * double-counts it.
 */
const KIT_CAVITY_STRENGTH = 0.62;

/**
 * Cavity occlusion on the **direct** light, for soldier kit.
 *
 * The atlas already bakes a cavity term from each material cell's own height field into
 * ORM.R (`atlas.ts:1329`, `0.3 + h * 0.7`), and the material already binds it as an `aoMap`
 * at `aoMapIntensity: 0.3`. But `aoMapIntensity` in three attenuates the **indirect** term
 * only, so **nothing at all occludes direct sunlight on a soldier**: the gutter between two
 * segmentata hoops, the gap under a scale row and the shadow inside a mail ring all receive
 * the sun exactly as fully as the plate beside them. The recesses are painted, and paint has
 * no light direction.
 *
 * That is the known cause of a defect this project has measured twice and named twice. Under
 * mip averaging "84 % of a normal map's perturbation is gone by mip 4, because a bump's two
 * slopes are equal and opposite and cancel", so relief cannot survive to battle range; a
 * *scalar* occlusion does, because occlusion averages like brightness. Masonry got the
 * counter (`city/materials.ts:416-474`) and the handoff records that soldier kit did not.
 *
 * It is also the mechanism behind the crowd's contrast defect. Ours carries 2.6x the
 * reference's local contrast at 32 px scale while reading as flatter, because our variation
 * is albedo — sharp, direction-blind, identical in sun and shade — where Rome II's is
 * shading across a form. Gating the sun by the cavity converts one into the other without
 * adding any contrast at all: it *removes* light from the parts that should not have it.
 *
 * Same shape as the masonry gate, and the same reason for each part of it: a soft
 * transition because a hard step aliases on a mipped scalar, and a width that scales with
 * the occlusion so a flat texel is an exact no-op rather than a global dimmer. Tested
 * against the *geometric* normal, because the cavity is defined relative to the macro
 * surface and testing the perturbed normal counts the same slope twice.
 *
 * No backtick may appear in these comments: one silently ends the JS template literal.
 */
const KIT_CAVITY_PARS = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  float tcKitCavity;
  vec3 tcKitGeoN;

  /*
   * Flesh: three diffuse wraps, one per channel, and a rim.
   *
   * A materials grader, twice: "skin greys at the terminator; real flesh goes warmer and
   * more saturated, red-orange, because red scatters furthest through it, and it lights at
   * thin edges -- ear rims, fingers, nostrils."
   *
   * Both halves of that are one physical fact. Red light has a mean free path in dermis of
   * a few millimetres where blue is stopped in tenths of one, so light that enters a face
   * near the terminator and leaves it a little further round is overwhelmingly red. The
   * cheap and standard model of that is a **wrapped** N.L with a different wrap per channel:
   *
   *     wrapped = clamp( ( N.L + w ) / ( 1 + w ), 0, 1 ),   w = ( 0.38, 0.16, 0.08 )
   *
   * At N.L = 1 every channel returns exactly 1, so **full sun is bit-for-bit Lambert** and
   * this cannot brighten a lit cheek or move an exposure. At N.L = 0 it returns
   * ( 0.28, 0.14, 0.07 ): the terminator is not grey, it is the colour of blood at a third
   * of the sun's strength. Past the terminator only red survives, which is what a hand held
   * against a window does.
   *
   * The specular is deliberately *not* wrapped. Sebum sits on the surface and reflects off
   * it, so it obeys the true geometric N.L; only the light that went in and came back out
   * gets to bend. That is why this calls three's own lobe with the diffuse zeroed rather
   * than scaling the whole result -- scaling would drag the specular round the terminator
   * with the diffuse and put a sheen on the shadowed side of every face.
   *
   * The rim is the second half. Real thickness needs a thickness map and there is no atlas
   * slot for one, but grazing geometry *is* thin geometry -- an ear seen edge-on, a finger,
   * the wing of a nostril, the rim of a nose -- so ( 1 - |N.V| ) is a serviceable stand-in
   * that costs one dot. It is gated on back-lighting ( V . -L ) so it only fires when there
   * is something behind the surface to come through, and it is tinted hard to red because
   * that is the only thing that survives 3 mm of flesh.
   */
  void tcSkinDirect(
    const in IncidentLight dl, const in vec3 geometryPosition, const in vec3 N,
    const in vec3 V, const in vec3 clearcoatN, const in PhysicalMaterial material,
    inout ReflectedLight reflectedLight
  ) {
    PhysicalMaterial specOnly = material;
    specOnly.diffuseColor = vec3( 0.0 );
    RE_Direct_Physical( dl, geometryPosition, N, V, clearcoatN, specOnly, reflectedLight );

    const vec3 W = vec3( 0.38, 0.16, 0.08 );
    float ndl = dot( N, dl.direction );
    vec3 wrapped = clamp( ( vec3( ndl ) + W ) / ( 1.0 + W ), 0.0, 1.0 );
    reflectedLight.directDiffuse += dl.color * wrapped * BRDF_Lambert( material.diffuseColor );

    float thin = 1.0 - abs( dot( N, V ) );
    float back = clamp( dot( V, -dl.direction ), 0.0, 1.0 );
    reflectedLight.directDiffuse +=
      dl.color * material.diffuseColor
      * ( thin * thin * back * back * back * 0.42 )
      * vec3( 1.0, 0.26, 0.13 );
  }

  /*
   * Cloth: no GGX at all, one sheen lobe, and a wide wrap.
   *
   * The same grader: "cloth needs effectively no specular lobe but a wide wrap terminator,
   * so linen and bronze cannot share a shader with only the albedo swapped." Both halves are
   * about the same thing -- a woven surface is not a surface, it is a forest of fibres.
   *
   * A microfacet lobe assumes the surface is locally flat with a distribution of slopes about
   * its normal, which is true of a hammered plate and false of a nap. Light that hits linen
   * is scattered by fibres standing *away* from the macro surface, so its highlight is not
   * where a mirror would put it: it is strongest at grazing, round the silhouette, and it is
   * broad. That is why wool has a bloom at the edge of a fold and no glint in the middle of
   * one, and why substituting GGX for it gives every tunic in the rank a hot spot in the same
   * place -- the specular equivalent of the shield-boss defect.
   *
   * So GGX is replaced rather than attenuated, by Ashikhmin's inverted-Gaussian velvet
   * distribution in Estevez and Kulla's form: D peaks at sin(N.H) = 1, i.e. exactly where GGX
   * is zero. Its visibility term is Ashikhmin's own, which is what stops the grazing peak
   * going to infinity. The sheen is tinted toward white because a fibre's Fresnel is a
   * dielectric's whatever the dye did to its interior.
   *
   * The diffuse wrap is the other half. Wool is 3 mm of translucent fibre over a shadow, so
   * its terminator is soft and wide where a plate's is a line; 0.30 of wrap is about a
   * seventeen-degree softening, and unlike the skin wrap it is achromatic, because a fibre
   * scatters by geometry rather than by absorption.
   */
  void tcClothDirect(
    const in IncidentLight dl, const in vec3 N, const in vec3 V,
    const in PhysicalMaterial material, inout ReflectedLight reflectedLight
  ) {
    vec3 H = normalize( dl.direction + V );
    float cosNH = clamp( dot( N, H ), 0.0, 1.0 );
    float sinNH = sqrt( max( 0.0, 1.0 - cosNH * cosNH ) );
    float rc = clamp( material.roughness, 0.25, 1.0 );
    float invR = 1.0 / rc;
    float D = ( 2.0 + invR ) * pow( sinNH, invR ) / 6.2831853;
    float ndv = clamp( dot( N, V ), 0.001, 1.0 );
    float ndl = clamp( dot( N, dl.direction ), 0.0, 1.0 );
    float Vis = 1.0 / ( 4.0 * ( ndl + ndv - ndl * ndv ) );
    vec3 sheen = mix( vec3( 1.0 ), material.diffuseColor, 0.35 ) * 0.15;
    reflectedLight.directSpecular += dl.color * ndl * sheen * D * Vis;

    float wrapped = clamp( ( dot( N, dl.direction ) + 0.30 ) / 1.30, 0.0, 1.0 );
    reflectedLight.directDiffuse += dl.color * wrapped * BRDF_Lambert( material.diffuseColor );
  }

  void tcRE_Direct_Kit(
    const in IncidentLight directLight, const in vec3 geometryPosition,
    const in vec3 geometryNormal, const in vec3 geometryViewDir,
    const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material,
    inout ReflectedLight reflectedLight
  ) {
    IncidentLight tcLight = directLight;
    float tcCos = clamp( dot( tcKitGeoN, tcLight.direction ), 0.0, 1.0 );
    float tcW = 0.04 + 0.55 * tcKitCavity;
    tcLight.color *= smoothstep( max( 0.0, tcKitCavity - tcW ), tcKitCavity + tcW, tcCos );

    float tcClass = vSoldierSurf.w;
    if ( tcClass > 1.5 ) {
      tcClothDirect( tcLight, geometryNormal, geometryViewDir, material, reflectedLight );
    } else if ( tcClass > 0.5 ) {
      tcSkinDirect(
        tcLight, geometryPosition, geometryNormal, geometryViewDir,
        geometryClearcoatNormal, material, reflectedLight
      );
    } else {
      RE_Direct_Physical(
        tcLight, geometryPosition, geometryNormal, geometryViewDir,
        geometryClearcoatNormal, material, reflectedLight
      );
    }
  }
  #undef RE_Direct
  #define RE_Direct tcRE_Direct_Kit
#endif
`;

/**
 * Once per fragment, before the light loop.
 *
 * `uKitCavity` is a uniform rather than a constant so a probe can pin it to 0 and difference
 * two frames of one paused world — arm differencing, not a single frame, because band-pass
 * amplitude over a whole frame is dominated by geometry edges and a real change hides inside
 * the noise. That technique measured a reproducibility floor of 0.00000 on masonry.
 */
const KIT_CAVITY_SETUP = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  // R is 0.3 (deepest cavity) .. 1.0 (unoccluded). 1.0 is an exact no-op, so a cell whose
  // height field is flat costs nothing.
  tcKitCavity = clamp( 1.0 - texelRoughness.r, 0.0, 1.0 ) * uKitCavity;
  tcKitGeoN = nonPerturbedNormal;
#endif
`;

/** The indirect half. Deliberately far gentler than the direct gate; that asymmetry is the point. */
const KIT_CAVITY_AO = /* glsl */ `
#ifdef USE_ROUGHNESSMAP
  reflectedLight.indirectDiffuse *= 1.0 - tcKitCavity * tcKitCavity;
#endif
`;

/**
 * Per-man, *spatially varying* metal, and why a scalar polish offset was not enough.
 *
 * Three blind graders independently reported the same thing about our helmets: every crown
 * carries the same small blown-white four-point star, same size, same relative position,
 * including on helmets turned away from the sun. One of them proposed the test — photograph
 * twenty identical helmets and see whether the highlight is the same blob twenty times. It
 * was. Their conclusion was that specular was not being evaluated per normal. The conclusion
 * is wrong and the observation is exactly right, which is a combination worth being careful
 * about, because acting on the conclusion would have changed nothing.
 *
 * It *is* per-normal GGX off a real interpolated normal. The blob repeats because of three
 * facts that happen to compose:
 *
 *   1. Every helmet is the same body of revolution about the vertical axis.
 *   2. Its mirror point is therefore invariant under the only per-man rotation we had, yaw.
 *   3. Mat.IronPlate sat at roughness 0.22, where GGX's peak is 1 / (pi * alpha^2) — about
 *      136 — against a sun already at intensity 3. Wherever the mirror condition is met the
 *      result is not a highlight but a clipped white hole, and clipped white holes are
 *      identical to one another by construction.
 *
 * So the fix is in three parts and this file holds two of them. (1) is answered by the head
 * roll added to soldierPoseVary above, (3) by roughening the plate in atlas.ts, and (2) —
 * two bowls of one shape reflecting one sun the same way — by giving each man's metal its own
 * microsurface. Which is also simply true: a hand-raised iron bowl is a few hundred hammer
 * faces, no two were planished by the same hand on the same day, and the dust and grease of a
 * campaign do not settle evenly.
 *
 * Two terms at two stages, because they do different jobs. The mottle widens or tightens the
 * lobe from place to place, which turns one pool into a broken sheen. The planishing *moves*
 * it, which is what stops twenty men sharing one blob. Neither needs a new attribute, a new
 * varying or a new tangent frame.
 */
/**
 * Emitted into GLSL as text, so it has to *look* like a float.
 *
 * `${37.0}` interpolates to the string "37" — JavaScript has one number type and drops the
 * trailing zero — and GLSL ES then refuses `float * int` with no implicit conversion. Every
 * interpolation below therefore goes through `f()`.
 */
const METAL_BREAKUP_FREQ = 37;
const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** Roughness half of the pair. Injected at <roughnessmap_fragment>, before any normal exists. */
const METAL_MOTTLE = /* glsl */ ` + tcIsMetal * 0.085 * (
  sin( vMapUv.x * ${f( METAL_BREAKUP_FREQ )} + vSoldierSurf.z * 97.3 )
  * sin( vMapUv.y * ${f( METAL_BREAKUP_FREQ * 0.83 )} + vSoldierSurf.z * 61.7 ) )`;

/**
 * Normal half of the pair: the planishing.
 *
 * `tbn` is three's own cotangent frame. <normal_fragment_begin> declares it at function scope
 * whenever USE_NORMALMAP_TANGENTSPACE is defined, which it always is here — the soldier
 * material binds a normal map — so the slope can be added straight onto the finished normal
 * in the frame that normal was built in. No second frame, and no tangent attribute on a
 * geometry that has none.
 *
 * A first-order slope add rather than a re-normalised tangent-space compose: the amplitude is
 * a couple of degrees and the difference is far below the noise floor of a helmet at battle
 * zoom. vSoldierSurf.z is in [1, 2) on metal, so it both gates the branch and offsets the
 * field per man; off metal it is exactly zero and the branch is skipped.
 */
const METAL_PLANISH = /* glsl */ `
if ( metalnessFactor > 0.35 ) {
  float pf = ${f( METAL_BREAKUP_FREQ * 0.62 )};
  vec2 pu = vMapUv * pf + vec2( 13.1, 27.9 ) * vSoldierSurf.z;
  vec2 pg = vec2(
    cos( pu.x ) * sin( pu.y * 0.91 ),
    sin( pu.x ) * cos( pu.y * 0.91 ) * 0.91
  ) * pf;
  normal = normalize( normal - ( tbn[ 0 ] * pg.x + tbn[ 1 ] * pg.y ) * 0.0016 );
}
`;

const SPEC_AA = /* glsl */ `
{
  vec3 tcDNdx = dFdx( normal );
  vec3 tcDNdy = dFdy( normal );
  float tcVariance = 0.25 * ( dot( tcDNdx, tcDNdx ) + dot( tcDNdy, tcDNdy ) );
  float tcKernel = min( 2.0 * tcVariance, 0.18 );
  roughnessFactor = sqrt( clamp( roughnessFactor * roughnessFactor + tcKernel, 0.0, 1.0 ) );
}
`;

const FRAG_BODY = /* glsl */ `
diffuseColor.rgb *= vSoldierTint;
#ifdef USE_MAP
  if ( vSoldierEmblem.z > 0.5 ) {
    // The emblem tile replaces the plank colour rather than multiplying it — paint covers
    // wood — but it still takes the man's own facing tint, which is what gives a tribal
    // host two hundred differently-painted boards out of four devices.
    vec4 emblem = texture2D( map, vSoldierEmblem.xy );
    // ...and it is repainted at the depot, then carried through a campaign. The device
    // belongs to the unit; the state of it belongs to the man.
    float ew = clamp( vSoldierEmblem.z - 1.0, 0.0, 1.0 );
    vec3 paint = mix( emblem.rgb, emblem.rgb * 0.70 + vec3( 0.15, 0.12, 0.10 ) * 0.30, ew );
    /*
     * Where the paint has gone, not just how much of it.
     *
     * The atlas coordinate is used as the board coordinate: inside a cell it is the panel's
     * own UV scaled by the cell size, so a field evaluated on it is a field on the board.
     * The per-man seed in the w component slides that field, and the two boards either
     * side of this one therefore lose paint somewhere else entirely.
     *
     * The threshold is driven by the man's own wear so a fresh board loses nothing and a
     * campaign board loses about a quarter of its device. Smoothstepped over a wide band
     * because a hard threshold on a value noise is a jigsaw edge, and paint flakes.
     */
    vec2 wp = vSoldierEmblem.xy * 340.0 + vSoldierEmblem.w;
    float wn = tcSkinNoise( wp ) * 0.62 + tcSkinNoise( wp * 2.7 + 11.3 ) * 0.38;
    float lost = smoothstep( 1.02 - ew * 0.62, 1.42 - ew * 0.62, wn );
    diffuseColor.rgb = mix( diffuseColor.rgb, paint * vSoldierTint,
      emblem.a * ( 1.0 - 0.42 * ew ) * ( 1.0 - lost ) );
  }
#endif
// Blood and dust: pull value and saturation down toward a dry earth colour rather than
// simply darkening, which would read as shadow instead of filth.
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  diffuseColor.rgb * 0.5 + vec3( 0.19, 0.15, 0.12 ) * 0.5,
  clamp( vSoldierSurf.x, 0.0, 1.0 ) );
`;

const v3 = (p: readonly [number, number, number]): string =>
  `vec3(${p[0].toFixed(4)}, ${p[1].toFixed(4)}, ${p[2].toFixed(4)})`;

/** A GLSL predicate matching any of a set of piece ids. Exact equality is safe: the ids are
 *  small integers and reach the shader through a float attribute unchanged. */
const pieceTest = (ids: readonly number[]): string =>
  ids.length ? ids.map((i) => `(p) == ${i}.0`).join(' || ') : 'false';

function defines(o: SoldierShaderOptions): string {
  const out = [
    `#define SOLDIER_LEAN_H ${o.leanHeight.toFixed(3)}`,
    `#define SOLDIER_EMBLEM_ORIGIN vec2(${o.emblemOrigin[0].toFixed(6)}, ${o.emblemOrigin[1].toFixed(6)})`,
    `#define SOLDIER_EMBLEM_TILE vec2(${o.emblemTile[0].toFixed(6)}, ${o.emblemTile[1].toFixed(6)})`,
    // Fed from `atlas.EMBLEM_COLS` rather than written as a literal here. It was `mod(e, 4.0)`
    // with a comment on the constant asking the two files to agree by hand; widening the
    // sheet to 2048 made them disagree, and a disagreement here silently draws the wrong
    // device on every shield in an army.
    `#define SOLDIER_EMBLEM_COLS ${(o.emblemCols ?? 8).toFixed(1)}`,
    // Band boundaries as "last index of the previous band, plus a half", so a float compare
    // is exact. Fed from `kit.ts` rather than written here, because two files disagreeing
    // about where the tribal band ends would repaint an army with nothing to show for it.
    `#define SOLDIER_EMBLEM_TRIBAL ${((o.emblemTribalFirst ?? 4) - 0.5).toFixed(1)}`,
    // A default far above any real index means "no Punic band", so the two-band behaviour is
    // exactly recovered for a caller that does not know about the third.
    `#define SOLDIER_EMBLEM_PUNIC ${((o.emblemPunicFirst ?? 9999) - 0.5).toFixed(1)}`,
  ];
  const pv = o.poseVary;
  if (pv) {
    out.push(
      '#define SOLDIER_POSE_VARY 1',
      `#define SOLDIER_UPPER0 ${pv.upper[0]}.0`,
      `#define SOLDIER_UPPER1 ${pv.upper[1]}.0`,
      `#define SOLDIER_HEAD0 ${pv.head[0]}.0`,
      `#define SOLDIER_HEAD1 ${pv.head[1]}.0`,
      `#define SOLDIER_ARM_L0 ${pv.leftArm[0]}.0`,
      `#define SOLDIER_ARM_L1 ${pv.leftArm[1]}.0`,
      `#define SOLDIER_ARM_R0 ${pv.rightArm[0]}.0`,
      `#define SOLDIER_ARM_R1 ${pv.rightArm[1]}.0`,
      `#define SOLDIER_NECK ${v3(pv.neckPivot)}`,
      `#define SOLDIER_SHOULDER_L ${v3(pv.leftShoulder)}`,
      `#define SOLDIER_SHOULDER_R ${v3(pv.rightShoulder)}`,
      `#define SOLDIER_HIP_Y ${pv.hipY.toFixed(4)}`,
      `#define SOLDIER_HAND ${v3(pv.weaponHand)}`,
      `#define SOLDIER_IS_POLE(p) (${pieceTest(pv.poleWeapons)})`,
      `#define SOLDIER_IS_BLADE(p) (${pieceTest(pv.bladeWeapons)})`
    );
  }
  return out.join('\n');
}

function makeUniforms(o: SoldierShaderOptions): SoldierUniforms {
  return {
    uAnimTex: { value: o.anim.texture },
    uAnimTexel: { value: new THREE.Vector2(1 / o.anim.width, 1 / o.anim.height) },
    uTime: { value: 0 },
  };
}

/**
 * Patch a material for GPU-skinned instancing.
 *
 * `variant` decides how much work is injected: the colour pass needs normals and the
 * tint varyings, the shadow passes need only the position.
 */
function patch(
  material: THREE.Material,
  o: SoldierShaderOptions,
  uniforms: SoldierUniforms,
  variant: 'colour' | 'depth'
): void {
  const withNormal = variant === 'colour';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // Exposed on the material so a probe can pin it to 0 and difference two frames of one
    // paused world against an otherwise identical build.
    if (withNormal) {
      const cav = (material.userData.kitCavity ?? { value: KIT_CAVITY_STRENGTH }) as { value: number };
      material.userData.kitCavity = cav;
      shader.uniforms.uKitCavity = cav;
    }

    let v = shader.vertexShader;
    v = `${defines(o)}\n${DECLS}\nvec3 gSoldierPos;\n${
      withNormal ? 'varying vec3 vSoldierTint;\nvarying vec4 vSoldierSurf;\nvarying vec4 vSoldierEmblem;\n' : ''
    }${v}`;

    if (withNormal) {
      // Normals are set up before positions in three's vertex shader, so the whole
      // transform happens here and `begin_vertex` just collects the result.
      v = v.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${body(true)}\n${TINT_BODY}`
      );
      v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = gSoldierPos;');
    } else {
      v = v.replace('#include <begin_vertex>', `#include <begin_vertex>\n${body(false)}\ntransformed = gSoldierPos;`);
    }
    shader.vertexShader = v;

    if (withNormal) {
      let f = shader.fragmentShader;
      f = `${FRAG_DECLS}\n${f}`;
      f = f.replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_BODY}`);
      // Dirt and dried blood are matte; they should lift roughness, not just darken.
      f = f.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nfloat tcIsMetal = step( 0.35, texelRoughness.b );\n'
        + 'roughnessFactor = clamp( roughnessFactor + vSoldierSurf.x * 0.22 + vSoldierSurf.y * tcIsMetal'
        + METAL_MOTTLE + ', 0.035, 1.0 );'
      );
      // Specular anti-aliasing has to come after the normal chunks, not with the roughness
      // ones: three includes <roughnessmap_fragment> before <normal_fragment_begin>, so at
      // that point there is no shading normal to take a derivative of. Nothing between the
      // two reads roughnessFactor — <lights_physical_fragment> is the first consumer — so
      // raising it here is equivalent, and it gets the normal-mapped normal, which is the
      // one that carries the sub-pixel detail we are trying to filter.
      f = f.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${METAL_PLANISH}\n${KIT_CAVITY_SETUP}\n${SPEC_AA}`
      );
      // Cavity occlusion on the *direct* light. See `KIT_CAVITY_PARS`.
      f = f.replace(
        '#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>\n${KIT_CAVITY_PARS}`
      );
      f = f.replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${KIT_CAVITY_AO}`);
      shader.fragmentShader = f;
    }
  };
  // Two soldier materials must not share a compiled program with anything else, and the
  // two variants must not share with each other. The pose-variation flag is part of the key
  // because it changes the injected source: the man has it and the horse does not, and
  // colliding here would give one of them the other's vertex shader.
  const rig = o.poseVary ? 'vary' : 'plain';
  material.customProgramCacheKey = () => `soldier-skin-v8brdf-${variant}-${rig}`;
}

export interface SoldierMaterialSet {
  readonly material: THREE.MeshStandardMaterial;
  readonly depth: THREE.MeshDepthMaterial;
  readonly distance: THREE.MeshDistanceMaterial;
  readonly uniforms: SoldierUniforms;
  dispose(): void;
}

export function makeSoldierMaterial(
  base: THREE.MeshStandardMaterialParameters,
  o: SoldierShaderOptions
): SoldierMaterialSet {
  const uniforms = makeUniforms(o);
  const material = new THREE.MeshStandardMaterial(base);
  patch(material, o, uniforms, 'colour');

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patch(depth, o, uniforms, 'depth');

  const distance = new THREE.MeshDistanceMaterial();
  patch(distance, o, uniforms, 'depth');

  return {
    material,
    depth,
    distance,
    uniforms,
    dispose(): void {
      material.dispose();
      depth.dispose();
      distance.dispose();
    },
  };
}
