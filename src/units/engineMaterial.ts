import * as THREE from 'three';
import {
  EnginePart, SPRING_X, SPRING_Y, SPRING_Z, ARM_R, ARM_RAKE, ARM_REST,
  CLAW_Y, DRUM_Y, DRUM_Z, DRUM_R, PIVOT_Y, PIVOT_Z, CLAW_REST_Z,
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
const float E_ARM_DY   = ${f(ARM_R * Math.sin(ARM_RAKE))};
const float E_ARM_REST = ${f(ARM_REST)};
const float E_CLAW_Y   = ${f(CLAW_Y)};
const float E_DRUM_Y   = ${f(DRUM_Y)};
const float E_DRUM_Z   = ${f(DRUM_Z)};
const float E_DRUM_R   = ${f(DRUM_R)};
const float E_PIVOT_Y  = ${f(PIVOT_Y)};
const float E_PIVOT_Z  = ${f(PIVOT_Z)};
const float E_CLAW_REST = ${f(CLAW_REST_Z)};
const float E_DRUM_TURNS = ${f(DRUM_TURNS)};
const float E_RECOIL_PITCH = ${f(RECOIL_PITCH)};
const float E_RECOIL_BACK = ${f(RECOIL_BACK)};

varying vec3 vEngTint;
varying float vEngGrime;

// Rotate (a,b) by the angle whose sine and cosine are s and c. Full trig, not the
// small-angle form the soldier shader uses: these arms sweep 78 degrees.
void engRot( inout float a, inout float b, float s, float c ) {
  float t = a;
  a = t * c - b * s;
  b = t * s + b * c;
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
  } else if ( part == ${EnginePart.String}.0 || part == ${EnginePart.Rope}.0 ) {
    // A cord carries only its cross-section offset in position.xy; it is placed on the live
    // line between two moving points, in a frame built from that line so it stays round
    // whichever way the run happens to lie.
    float span = aPart.w;
    vec3 a, b;
    if ( part == ${EnginePart.Rope}.0 ) {
      a = vec3( 0.0, E_DRUM_Y + E_DRUM_R, E_DRUM_Z );
      b = vec3( 0.0, E_CLAW_Y - 0.02, slider - 0.02 );
    } else {
      a = engArmTip( span, phi );
      b = vec3( 0.0, E_CLAW_Y, slider + 0.03 );
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

  if ( part != ${EnginePart.Ground}.0 ) {
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
  vec3 tint;
  if ( slot < 0.5 ) {
    tint = vec3( 1.0 );
  } else if ( slot < 1.5 ) {
    // Structural oak: from a fresh-cut warm tan through to a grey, rain-beaten frame. Field
    // artillery lived outdoors and the reference for that is any surviving cart timber.
    // Seasoned oak, from a warm mid-tan through to the grey a beam goes after a season in
    // the rain. Held well off full saturation: the first pass ran to (1.18, 0.90, 0.58) and
    // in direct sun that came back as an orange plastic, which is what a saturated warm
    // albedo under a warm key always does.
    tint = mix( vec3( 0.98, 0.83, 0.62 ), vec3( 0.56, 0.53, 0.50 ), wear )
         * ( 0.84 + grain * 0.34 );
  } else if ( slot < 2.5 ) {
    // Iron: warm F0 for the same reason the soldier shader gives — a neutral grey metal
    // reflecting a blue sky comes back blue, and a field of blue ironwork is worse than
    // a field of grey.
    tint = vec3( 1.10, 1.00, 0.88 ) * ( 0.72 + fract( v * 29.13 ) * 0.46 );
  } else if ( slot < 3.5 ) {
    // Bronze washers, gone dark and a little green where the rain sits.
    tint = mix( vec3( 1.42, 1.02, 0.44 ), vec3( 0.70, 0.74, 0.50 ), fract( v * 53.9 ) * 0.6 );
  } else if ( slot < 4.5 ) {
    // Sinew springs: pale, greasy, faintly amber. This is the one surface a viewer has no
    // reference for, so it has to look like nothing else on the machine or it reads as more
    // timber and the torsion disappears.
    // Bone-pale, only faintly warm. Sinew under grease is not gold, and at (1.28, 1.08, 0.70)
    // the springs and the bowstring were the most saturated thing in the frame.
    tint = vec3( 1.02, 0.94, 0.76 ) * ( 0.88 + fract( v * 61.3 ) * 0.24 );
  } else {
    // Hemp cord and greased leather.
    tint = vec3( 0.90, 0.76, 0.54 ) * ( 0.82 + fract( v * 71.7 ) * 0.34 );
  }
  vEngTint = tint;
  vEngGrime = iOrient.w * 0.0 + clamp( wear * 0.35, 0.0, 1.0 );
}
`;

const FRAG_DECLS = /* glsl */ `
varying vec3 vEngTint;
varying float vEngGrime;
`;

const FRAG_BODY = /* glsl */ `
diffuseColor.rgb *= vEngTint;
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
  dispose(): void;
}

function patch(material: THREE.Material, variant: 'colour' | 'depth'): void {
  const withNormal = variant === 'colour';
  material.onBeforeCompile = (shader) => {
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
      shader.fragmentShader = fr;
    }
  };
  // Must not collide with the soldier skinner's key or one of them gets the other's program.
  material.customProgramCacheKey = () => `siege-engine-v1-${variant}`;
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
    dispose(): void {
      material.dispose();
      depth.dispose();
      distance.dispose();
    },
  };
}
