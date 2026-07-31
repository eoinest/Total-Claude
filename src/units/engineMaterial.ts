import * as THREE from 'three';
import {
  EnginePart, SPRING_X, SPRING_Y, SPRING_Z, ARM_R, ARM_RAKE, ARM_REST, NOCK_RISE,
  CLAW_Y, STRING_Y, DRUM_Y, DRUM_Z, DRUM_R, PIVOT_Y, PIVOT_Z, CLAW_REST_Z,
  OnagerPart, ON_SKEIN_Y, ON_SKEIN_Z, ON_ARM_COCKED, ON_ARM_R, ON_HOOK_F,
  ON_DRUM_Y, ON_DRUM_Z, ON_DRUM_R, ON_PIVOT_Z, ON_SKEIN_HALF,
} from './engineMesh';

/**
 * Material for the instanced siege engines: a `MeshStandardMaterial` patched through
 * `onBeforeCompile`, exactly as the soldier skinner is, so the sun, the hemisphere fill,
 * `scene.environment`, the cascaded shadows, the cloud shading and the fog all keep working.
 *
 * ## Why this exists rather than reusing the soldier skinner
 * The soldier shader fetches bone transforms out of an animation texture. An engine has no
 * bones and no clips: every moving part of it moves along exactly one axis, driven by two
 * scalars (arm sweep and slider position) that the mechanism itself relates. Writing those
 * two into an instance attribute and doing four rotations in the vertex shader is cheaper
 * than baking a rig, and — more importantly — it means the string and the winch rope can be
 * *derived* rather than skinned. A string skinned to the arm tips would stretch and shear;
 * this one is a straight line between two points that are recomputed per vertex, which is
 * what a bowstring actually is.
 *
 * ## Instance attributes
 *   iPos    vec3   world position of the tripod's foot
 *   iOrient vec4   yaw, uniform scale, barrel pitch (radians), stable variant hash 0..1
 *   iState  vec4   arm sweep (radians), slider z (local metres), recoil 0..1, bolt loaded 0/1
 *
 * ## Vertex attribute
 *   aPart   vec4   part id, tint slot, cord parameter t, cord span / arm side
 */

/** Extra pitch the whole upper works takes at the top of the recoil, radians. */
const RECOIL_PITCH = 0.085;
/** How far the upper works slides back on the pintle at the top of the recoil, metres. */
const RECOIL_BACK = 0.055;
/**
 * Windlass turns per metre of rope drawn in.
 *
 * A drum of radius DRUM_R takes 2*pi*DRUM_R metres of rope per revolution, so the drum's
 * angle is the rope length over the radius. That is the honest number and it means the
 * handspikes turn at exactly the rate the slider comes back — the tell that a winch is
 * decorative is that its handles spin at some invented speed.
 */
const DRUM_TURNS = 1 / DRUM_R;

/**
 * Extra pitch the whole onager takes as it rears, radians.
 *
 * Bigger than the scorpio's, and about a pivot on the ground rather than on a pintle: Ammianus
 * says the machine is called the wild ass because it kicks, and a two-tonne chassis that stops
 * its own arm dead is exactly a thing that lifts off its front sleeper.
 */
const ON_RECOIL_PITCH = 0.055;

const f = (n: number): string => n.toFixed(5);

const DECLS = /* glsl */ `
attribute vec4 aPart;   // part id, tint slot, cord t, cord span / arm side
attribute vec3 iPos;
attribute vec4 iOrient; // yaw, scale, pitch, variant
attribute vec4 iState;  // arm sweep, slider z, recoil, loaded

const float E_SPRING_X = ${f(SPRING_X)};
const float E_SPRING_Y = ${f(SPRING_Y)};
const float E_SPRING_Z = ${f(SPRING_Z)};
const float E_ARM_RH   = ${f(ARM_R * Math.cos(ARM_RAKE))};
const float E_ARM_DY   = ${f(ARM_R * Math.sin(ARM_RAKE) + NOCK_RISE)};
const float E_ARM_REST = ${f(ARM_REST)};
const float E_CLAW_Y   = ${f(CLAW_Y)};
const float E_STRING_Y = ${f(STRING_Y)};
const float E_DRUM_Y   = ${f(DRUM_Y)};
const float E_DRUM_Z   = ${f(DRUM_Z)};
const float E_DRUM_R   = ${f(DRUM_R)};
const float E_PIVOT_Y  = ${f(PIVOT_Y)};
const float E_PIVOT_Z  = ${f(PIVOT_Z)};
const float E_CLAW_REST = ${f(CLAW_REST_Z)};
const float E_DRUM_TURNS = ${f(DRUM_TURNS)};
const float E_RECOIL_PITCH = ${f(RECOIL_PITCH)};
const float E_RECOIL_BACK = ${f(RECOIL_BACK)};
const float O_SKEIN_Y = ${f(ON_SKEIN_Y)};
const float O_SKEIN_Z = ${f(ON_SKEIN_Z)};
const float O_COCKED  = ${f(ON_ARM_COCKED)};
const float O_ARM_R   = ${f(ON_ARM_R)};
const float O_HOOK_D  = ${f(ON_ARM_R * ON_HOOK_F)};
const float O_DRUM_Y  = ${f(ON_DRUM_Y)};
const float O_DRUM_Z  = ${f(ON_DRUM_Z)};
const float O_DRUM_R  = ${f(ON_DRUM_R)};
const float O_PIVOT_Z = ${f(ON_PIVOT_Z)};
const float O_RECOIL_PITCH = ${f(ON_RECOIL_PITCH)};
const float O_SKEIN_HALF = ${f(ON_SKEIN_HALF)};

varying vec3 vEngTint;
varying float vEngGrime;
varying float vEngContact;
varying float vEngPart;

// Rotate (a,b) by the angle whose sine and cosine are s and c. Full trig, not the
// small-angle form the soldier shader uses: these arms sweep 78 degrees.
void engRot( inout float a, inout float b, float s, float c ) {
  float t = a;
  a = t * c - b * s;
  b = t * s + b * c;
}

// A point at distance d along an onager's throwing arm, for a given sweep off vertical.
vec3 engOnArm( float d, float th ) {
  return vec3( 0.0, O_SKEIN_Y + d * cos( th ), O_SKEIN_Z - d * sin( th ) );
}

// Where the arm nock for this side of the machine sits, given the live sweep.
vec3 engArmTip( float sideSign, float phi ) {
  return vec3(
    sideSign * ( E_SPRING_X + E_ARM_RH * cos( phi ) ),
    E_SPRING_Y + E_ARM_DY,
    E_SPRING_Z + E_ARM_RH * sin( phi ) );
}
`;

/**
 * The transform. Writes `gEngPos`, and `objectNormal` when `withNormal`.
 *
 * Order matters: articulate in the machine's own frame, then pitch and recoil the upper
 * works about the pintle, then scale, then yaw, then translate. Doing the pitch before the
 * articulation would swing the arms out of the frame's plane.
 */
const body = (withNormal: boolean): string => /* glsl */ `
{
  vec3 p = position;
  // Height above the machine's own base, kept before any transform, for the contact term.
  float contactY = position.y;
  vec3 n = ${withNormal ? 'objectNormal' : 'vec3( 0.0, 1.0, 0.0 )'};
  float part = aPart.x;
  float phi = iState.x;
  float slider = iState.y;

  if ( part == ${EnginePart.Arm}.0 ) {
    // Rotate about this arm's own spring centre. The left arm is the mirror of the right,
    // so its sweep runs the other way round the circle — hence the side factor on the angle.
    float side = aPart.w;
    float d = side * ( phi - E_ARM_REST );
    float s = sin( d ), c = cos( d );
    float ax = p.x - side * E_SPRING_X;
    float az = p.z - E_SPRING_Z;
    engRot( ax, az, s, c );
    p.x = side * E_SPRING_X + ax;
    p.z = E_SPRING_Z + az;
    ${withNormal ? 'engRot( n.x, n.z, s, c );' : ''}
  } else if ( part == ${EnginePart.Slider}.0 ) {
    p.z += slider;
  } else if ( part == ${EnginePart.Bolt}.0 ) {
    // The bolt is built lying along +Y so the tube helper could taper it; stand it up along
    // the stock here, nock at the claw, head downrange.
    p = vec3( p.x, E_CLAW_Y + 0.02 + p.z, slider + 0.06 + p.y );
    ${withNormal ? 'n = vec3( n.x, n.z, n.y );' : ''}
    // Nothing in the groove between the shot and the next bolt being laid in.
    if ( iState.w < 0.5 ) p = vec3( 0.0 );
  } else if ( part == ${EnginePart.Winch}.0 ) {
    // The drum turns by the rope it has taken in, so the handspikes keep step with the
    // slider instead of spinning at an invented rate.
    float turn = ( E_CLAW_REST - slider ) * E_DRUM_TURNS;
    float s = sin( turn ), c = cos( turn );
    float dy = p.y - E_DRUM_Y;
    float dz = p.z - E_DRUM_Z;
    engRot( dy, dz, s, c );
    p.y = E_DRUM_Y + dy;
    p.z = E_DRUM_Z + dz;
    ${withNormal ? 'engRot( n.y, n.z, s, c );' : ''}
  } else if ( part == ${OnagerPart.Arm}.0 || part == ${OnagerPart.Shot}.0 ) {
    // The throwing arm, its sling and the stone in the pouch, all rotating as one about the
    // skein. The sling is rigid to the arm; see engineMesh.ts for why that is the right
    // approximation and not a shortcut.
    float d = O_COCKED - phi;
    float s = sin( d ), c = cos( d );
    float dy = p.y - O_SKEIN_Y;
    float dz = p.z - O_SKEIN_Z;
    engRot( dy, dz, s, c );
    p.y = O_SKEIN_Y + dy;
    p.z = O_SKEIN_Z + dz;
    ${withNormal ? 'engRot( n.y, n.z, s, c );' : ''}
    // A shot that has been thrown is not still in the pouch.
    if ( part == ${OnagerPart.Shot}.0 && iState.w < 0.5 ) p = vec3( 0.0 );
  } else if ( part == ${OnagerPart.Skein}.0 ) {
    // The skein twists. Every other moving part on either machine is a rigid body on one hinge;
    // a torsion spring is the exception, because it is tied to the arm at one end and trapped in
    // a washer at the other, so it has to shear along its own length.
    //
    // The gradient comes out of the vertex's own position along the skein axis rather than out of
    // an authored weight: 1 at the arm's butt, 0 at the washer. And the scale needs no tuning
    // either — the cord where it grips the arm turns *exactly* as much as the arm does, because
    // it is fastened to it. So winding the gun down puts visible turns into the spring and
    // letting go takes them out, and the number that does it is the arm angle itself.
    float w = clamp( 1.0 - abs( p.x ) / O_SKEIN_HALF, 0.0, 1.0 );
    float a = ( O_COCKED - phi ) * w;
    float s = sin( a ), c = cos( a );
    float dy = p.y - O_SKEIN_Y;
    float dz = p.z - O_SKEIN_Z;
    engRot( dy, dz, s, c );
    p.y = O_SKEIN_Y + dy;
    p.z = O_SKEIN_Z + dz;
    ${withNormal ? 'engRot( n.y, n.z, s, c );' : ''}
  } else if ( part == ${OnagerPart.Winch}.0 ) {
    // The onager's drum takes in rope as the arm comes down, so its angle follows the arm.
    float turn = ( O_COCKED - phi ) * O_HOOK_D / O_DRUM_R;
    float s = sin( turn ), c = cos( turn );
    float dy = p.y - O_DRUM_Y;
    float dz = p.z - O_DRUM_Z;
    engRot( dy, dz, s, c );
    p.y = O_DRUM_Y + dy;
    p.z = O_DRUM_Z + dz;
    ${withNormal ? 'engRot( n.y, n.z, s, c );' : ''}
  } else if ( part == ${EnginePart.String}.0 || part == ${EnginePart.Rope}.0
           || part == ${OnagerPart.Rope}.0 ) {
    // A cord carries only its cross-section offset in position.xy; it is placed on the live
    // line between two moving points, in a frame built from that line so it stays round
    // whichever way the run happens to lie.
    float span = aPart.w;
    vec3 a, b;
    if ( part == ${OnagerPart.Rope}.0 ) {
      a = vec3( 0.0, O_DRUM_Y + O_DRUM_R, O_DRUM_Z );
      b = engOnArm( O_HOOK_D, phi ) + vec3( 0.0, -0.06, 0.0 );
    } else if ( part == ${EnginePart.Rope}.0 ) {
      a = vec3( 0.0, E_DRUM_Y + E_DRUM_R, E_DRUM_Z );
      b = vec3( 0.0, E_CLAW_Y - 0.02, slider - 0.02 );
    } else {
      a = engArmTip( span, phi );
      // The claw grips the cord above the groove, not inside it — see STRING_Y in engineMesh.ts.
      b = vec3( 0.0, E_STRING_Y, slider + 0.03 );
    }
    vec3 d = b - a;
    float len = length( d );
    d = len > 1e-4 ? d / len : vec3( 1.0, 0.0, 0.0 );
    vec3 sx = cross( vec3( 0.0, 1.0, 0.0 ), d );
    float sl = length( sx );
    sx = sl > 1e-3 ? sx / sl : vec3( 1.0, 0.0, 0.0 );
    vec3 sy = cross( d, sx );
    vec3 off = sx * p.x + sy * p.y;
    p = mix( a, b, aPart.z ) + off;
    ${withNormal ? 'n = normalize( off + d * 1e-4 );' : ''}
  }

  if ( part >= ${OnagerPart.Base}.0 ) {
    // The onager rears about its front sleeper, on the ground, and takes no elevation of its
    // own: a stone-thrower is ranged by the twist in the skein and by how far the arm is wound
    // down, not by tipping the chassis.
    float a = iState.z * O_RECOIL_PITCH;
    float s = sin( a ), c = cos( a );
    float dy = p.y;
    float dz = p.z - O_PIVOT_Z;
    engRot( dz, dy, s, c );
    p.y = dy;
    p.z = O_PIVOT_Z + dz;
    ${withNormal ? 'engRot( n.z, n.y, s, c );' : ''}
  } else if ( part != ${EnginePart.Ground}.0 ) {
    // Elevation and recoil, both about the pintle. Recoil is a muzzle-up kick plus a slide
    // back along the stock, which is what a torsion engine does when three hundred joules
    // leave it in a tenth of a second.
    float a = iOrient.z + iState.z * E_RECOIL_PITCH;
    float s = sin( a ), c = cos( a );
    float dy = p.y - E_PIVOT_Y;
    float dz = p.z - E_PIVOT_Z;
    engRot( dz, dy, s, c );
    p.y = E_PIVOT_Y + dy;
    p.z = E_PIVOT_Z + dz - iState.z * E_RECOIL_BACK;
    ${withNormal ? 'engRot( n.z, n.y, s, c );' : ''}
  }

  p *= iOrient.y;

  float cy = cos( iOrient.x ), sy2 = sin( iOrient.x );
  p = vec3( p.x * cy + p.z * sy2, p.y, -p.x * sy2 + p.z * cy );
  ${withNormal ? 'n = vec3( n.x * cy + n.z * sy2, n.y, -n.x * sy2 + n.z * cy );' : ''}

  // Baked contact occlusion.
  //
  // All three blind critics used the word "hover": "the tripod legs intersect the grass with no
  // contact shadow or AO", "not one contact shadow between any figure and the ground". They are
  // reading a real absence — there is no SSAO pass in this renderer and the atlas AO map is
  // per-texel cavity, which says nothing about proximity to the ground. This is the honest
  // cheap answer: darken the lowest third of a metre of the machine, which is exactly the band
  // a real ambient-occlusion solve would darken where a foot meets turf. It costs one varying
  // and it is the difference between a machine standing on the field and a decal in front of it.
  vEngContact = smoothstep( 0.0, 0.34, contactY );

  gEngPos = p + iPos;
  ${withNormal ? 'objectNormal = normalize( n );' : ''}
}
`;

/**
 * Per-part colour.
 *
 * The engines share the soldier atlas, so the tiles arrive with a soldier's palette baked in
 * and every surface has to be pulled to where seasoned oak, cold iron and greased sinew
 * actually sit. The variant hash then moves each machine a few percent: four engines cut from
 * one billet of geometry read as four props unless their timber differs, and timber is most
 * of what you see.
 */
const TINT_BODY = /* glsl */ `
{
  float slot = aPart.y;
  float v = iOrient.w;
  // Weathering per engine, and a slow drift along the stock so one beam is not one colour.
  float wear = fract( v * 17.31 );
  float grain = fract( v * 43.77 );
  // Onager parts carry ids 8 and up. The two machines are given different timber, and the reason
  // is measurement rather than variety — see the pale-scorpio note below.
  bool heavy = aPart.x >= 8.0;
  vec3 tint;
  if ( slot < 0.5 ) {
    tint = vec3( 1.0 );
  } else if ( slot < 1.5 && heavy ) {
    // Structural oak: from a fresh-cut warm tan through to a grey, rain-beaten frame. Field
    // artillery lived outdoors and the reference for that is any surviving cart timber.
    // Seasoned oak, from a warm mid-tan through to the grey a beam goes after a season in
    // the rain. Held well off full saturation: the first pass ran to (1.18, 0.90, 0.58) and
    // in direct sun that came back as an orange plastic, which is what a saturated warm
    // albedo under a warm key always does.
    tint = mix( vec3( 0.98, 0.83, 0.62 ), vec3( 0.56, 0.53, 0.50 ), wear )
         * ( 0.84 + grain * 0.34 );
  } else if ( slot < 1.5 ) {
    // **Pale bleached timber, and this is the largest single legibility change made to the
    // scorpio.** Measured rather than judged: masking a bench plate to the machine's own pixels
    // with a part-id frame and taking a histogram, 70 % of the scorpio was below sRGB luminance 40
    // in the side view and 68 % in the rear, at a median of 22 and 25 — a black silhouette. The
    // reference photographs run a median of 105 to 177, and the single most legible plate in the
    // set (scorpio-auerberg-pfeilgeschutz.jpg, flat museum light on pale timber) is 177 with
    // 0.5 % below 40.
    //
    // The cause is albedo, not light. The oak tile is 0.27 to 0.49 and the old tint averaged 0.70,
    // so the machine's effective albedo was 0.27 — dark walnut. A 0.27 surface in its own shadow
    // is black under any sky, which is why --benchsky=overcast made it *worse* (median 22 to 16)
    // rather than better: there was nothing there to light.
    //
    // This lands at about 0.41, which is seasoned oak weathered pale, and it is deliberately far
    // *less* saturated than the old warm tan — 0.18 against 0.37. Raising value and saturation
    // together is what produced the orange plastic the first pass was criticised for; raising value
    // while dropping saturation gives sun-bleached timber, which is both the reference and the
    // Rome II palette.
    //
    // The onager keeps the dark timber above. It was graded at 6.5 out of 10 with it and is not
    // mine to disturb — and it is a different problem anyway: a stone-thrower is a solid chassis
    // whose broad top faces catch the sun, where a scorpio is a skeleton that shades itself from
    // three of four directions. The same albedo is not the same legibility.
    tint = mix( vec3( 1.30, 1.22, 1.06 ), vec3( 0.92, 0.90, 0.86 ), wear )
         * ( 0.88 + grain * 0.26 );
  } else if ( slot < 2.5 ) {
    // Iron: warm F0 for the same reason the soldier shader gives — a neutral grey metal
    // reflecting a blue sky comes back blue, and a field of blue ironwork is worse than
    // a field of grey.
    //
    // Brighter and warmer still on the scorpio, and it is the same argument taken further. Iron is
    // metal, so this value is not an albedo but the colour of what it reflects; in the machine's own
    // shadow it reflects a dim cool sky and comes back navy. That did not matter while the timber
    // was dark walnut, because everything was dark together. With the frame lightened, the corner
    // plates, the arm-port straps and the epizygides became the darkest objects on the machine and
    // sat exactly over the parts a judge is trying to read.
    tint = vec3( 1.10, 1.00, 0.88 ) * ( heavy ? 1.0 : 1.42 )
         * ( 0.72 + fract( v * 29.13 ) * 0.46 );
  } else if ( slot < 3.5 ) {
    // Bronze washers, gone dark and a little green where the rain sits.
    //
    // Lifted and warmed for the scorpio. The washers are the most distinctive fitting on a torsion
    // frame and they were coming back as dark navy glass: bronze is metal, envMapIntensity is
    // 2.4, and a metal in shadow renders mostly what it reflects — which is sky. The old tint drifted
    // toward a greenish grey that had nothing to push back with. The onager's skein housings keep
    // the old value for the same reason its timber does.
    tint = heavy
      ? mix( vec3( 1.42, 1.02, 0.44 ), vec3( 0.70, 0.74, 0.50 ), fract( v * 53.9 ) * 0.6 )
      : mix( vec3( 1.62, 1.20, 0.58 ), vec3( 1.05, 0.98, 0.66 ), fract( v * 53.9 ) * 0.55 );
  } else if ( slot < 4.5 ) {
    // Sinew springs: pale, greasy, faintly amber. This is the one surface a viewer has no
    // reference for, so it has to look like nothing else on the machine or it reads as more
    // timber and the torsion disappears.
    // Bone-pale, only faintly warm. Sinew under grease is not gold, and at (1.28, 1.08, 0.70)
    // the springs and the bowstring were the most saturated thing in the frame.
    //
    // Brightened with the timber, and it has to be: what makes a spring read is not its own value
    // but the *split* between pale cord and darker frame, which is the one thing every reference
    // plate has in common. Lifting the scorpio's timber from 0.27 to 0.41 without touching this
    // would have cut that ratio from 2.0 to 1.4 and quietly undone the single change that has
    // moved this machine's score so far. At 1.36x it holds near 1.9.
    tint = vec3( 1.02, 0.94, 0.76 )
         * ( heavy ? 1.0 : 1.36 )
         * ( 0.88 + fract( v * 61.3 ) * 0.24 );
  } else {
    // Hemp cord and greased leather.
    tint = vec3( 0.90, 0.76, 0.54 ) * ( 0.82 + fract( v * 71.7 ) * 0.34 );
  }
  vEngTint = tint;
  vEngGrime = iOrient.w * 0.0 + clamp( wear * 0.35, 0.0, 1.0 );
  vEngPart = aPart.x;
}
`;

const FRAG_DECLS = /* glsl */ `
varying vec3 vEngTint;
varying float vEngGrime;
varying float vEngContact;
varying float vEngPart;
uniform float uEngDebug;
`;

/**
 * Part-identity view: every part id as a flat saturated colour, unlit and unfogged.
 *
 * This is a diagnostic and it earns its place. Four rounds of blind grading of this machine
 * produced faults of the form "there is no bowstring", "there is no rope on the drum", "the
 * washers are lids sitting on nothing" — and in every single case the part was modelled,
 * correctly placed, and either optically inside the timber it connects to or lost in the
 * machine's own shadow. Reasoning about a shaded frame cannot tell those two cases apart, and
 * guessing wrong costs a whole round: one such guess added a stop bar that dropped the score.
 *
 * Flat colour after tone mapping answers it in one frame. If the part is on screen it is a
 * poster-paint patch; if it is not on screen it is genuinely occluded or genuinely absent, and
 * the difference between "absent" and "hidden" is the difference between two opposite fixes.
 *
 * Costs one varying and one branch on engine pixels only, and engines are a fraction of a
 * percent of the frame. `uEngDebug` is 0 in the game and is only ever written by
 * `tools/probe-scorpion.mjs --debugparts`.
 */
const FRAG_DEBUG = /* glsl */ `
if ( uEngDebug > 0.5 ) {
  int pid = int( vEngPart + 0.5 );
  vec3 dc = vec3( 1.0, 0.0, 1.0 );
  if ( pid == 0 ) dc = vec3( 0.28, 0.28, 0.32 );       // Ground: stand, quiver — grey
  else if ( pid == 1 ) dc = vec3( 0.10, 0.42, 0.95 );  // Body: case, capitulum, springs — blue
  else if ( pid == 2 ) dc = vec3( 1.00, 0.25, 0.05 );  // Arm — orange
  else if ( pid == 3 ) dc = vec3( 0.10, 0.95, 0.35 );  // Slider, claw, trigger — green
  else if ( pid == 4 ) dc = vec3( 1.00, 0.95, 0.10 );  // Bowstring — yellow
  else if ( pid == 5 ) dc = vec3( 1.00, 0.10, 0.55 );  // Bolt — magenta
  else if ( pid == 6 ) dc = vec3( 0.55, 0.15, 0.95 );  // Winch drum, wheel, handspikes — violet
  else if ( pid == 7 ) dc = vec3( 0.10, 0.90, 0.95 );  // Winch rope — cyan
  else if ( pid == 8 ) dc = vec3( 0.10, 0.42, 0.95 );
  else if ( pid == 9 ) dc = vec3( 1.00, 0.25, 0.05 );
  else if ( pid == 10 ) dc = vec3( 1.00, 0.10, 0.55 );
  else if ( pid == 11 ) dc = vec3( 0.55, 0.15, 0.95 );
  else if ( pid == 12 ) dc = vec3( 0.10, 0.90, 0.95 );
  else if ( pid == 13 ) dc = vec3( 1.00, 0.95, 0.10 );
  gl_FragColor = vec4( dc, 1.0 );
}
`;

const FRAG_BODY = /* glsl */ `
// Tint, then the contact term. 0.38 at the very foot: deep enough to read as ground contact
// under a bright sky, not so deep that a leg goes to black and the machine loses its footprint.
diffuseColor.rgb *= vEngTint * mix( 0.38, 1.0, vEngContact );
// Field dirt at the same strength the soldiers take it, so a machine parked among them does
// not read as freshly delivered.
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  diffuseColor.rgb * 0.55 + vec3( 0.19, 0.15, 0.12 ) * 0.45,
  vEngGrime );
`;

export interface EngineMaterialSet {
  readonly material: THREE.MeshStandardMaterial;
  readonly depth: THREE.MeshDepthMaterial;
  readonly distance: THREE.MeshDistanceMaterial;
  /** Flat per-part-id colour instead of shading. Diagnostic only — see `FRAG_DEBUG`. */
  setDebugParts(on: boolean): void;
  dispose(): void;
}

/**
 * The part-view switch, shared by every program the set compiles so one write flips all of them.
 * 0 in the game; see `FRAG_DEBUG`.
 */
const debugUniform = { value: 0 };

function patch(material: THREE.Material, variant: 'colour' | 'depth'): void {
  const withNormal = variant === 'colour';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEngDebug = debugUniform;
    let v = shader.vertexShader;
    v = `${DECLS}\nvec3 gEngPos;\n${v}`;
    if (withNormal) {
      v = v.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${body(true)}\n${TINT_BODY}`
      );
      v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = gEngPos;');
    } else {
      // The shadow passes still need the tint varyings declared, because DECLS declares them
      // and an unused varying is free; what they must not do is the normal work.
      v = v.replace('#include <begin_vertex>', `#include <begin_vertex>\n${body(false)}\ntransformed = gEngPos;`);
      v = v.replace('vEngTint = tint;', '');
      // The shadow passes have no fragment stage of ours to consume it.
      v = v.replace(/vEngContact = [^;]*;/, '');
    }
    shader.vertexShader = v;

    if (withNormal) {
      let fr = shader.fragmentShader;
      fr = `${FRAG_DECLS}\n${fr}`;
      fr = fr.replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_BODY}`);
      fr = fr.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp( roughnessFactor + vEngGrime * 0.2, 0.06, 1.0 );'
      );
      // Last, so nothing downstream — tone map, colour space, fog — touches the diagnostic.
      fr = fr.replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${FRAG_DEBUG}`);
      shader.fragmentShader = fr;
    }
  };
  // Must not collide with the soldier skinner's key or one of them gets the other's program.
  material.customProgramCacheKey = () => `siege-engine-v3-${variant}`;
}

export function makeEngineMaterial(
  base: THREE.MeshStandardMaterialParameters
): EngineMaterialSet {
  const material = new THREE.MeshStandardMaterial(base);
  patch(material, 'colour');

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patch(depth, 'depth');

  const distance = new THREE.MeshDistanceMaterial();
  patch(distance, 'depth');

  return {
    material,
    depth,
    distance,
    setDebugParts(on: boolean): void {
      debugUniform.value = on ? 1 : 0;
    },
    dispose(): void {
      material.dispose();
      depth.dispose();
      distance.dispose();
    },
  };
}
