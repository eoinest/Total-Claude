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
  /** Height in metres over which body lean ramps in from the feet. */
  leanHeight: number;
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

// Kit pieces this man does not wear collapse to a point. All three corners of such a
// triangle land on the same vertex, so it has zero area and never reaches the rasteriser.
bool soldierPieceVisible() {
  float pid = aPieceTint.x;
  float bits = pid < 24.0 ? iKit.x : iKit.y;
  float bit = pid < 24.0 ? pid : pid - 24.0;
  return mod( floor( bits / exp2( bit ) ), 2.0 ) >= 0.5;
}
`;

/**
 * The transform body. `SOLDIER_LEAN_H` and the emblem constants are injected as defines.
 * Writes `gSoldierPos`; also rotates `objectNormal` when `withNormal`.
 */
const body = (withNormal: boolean): string => /* glsl */ `
{
  vec3 sp, sn;
  soldierSkin( position, ${withNormal ? 'objectNormal' : 'vec3( 0.0, 1.0, 0.0 )'}, sp, sn );

  if ( !soldierPieceVisible() ) {
    sp = vec3( 0.0 );
  }

  sp *= iOrient.y;

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

  gSoldierPos = sp + iPos;
  ${withNormal ? 'objectNormal = normalize( sn );' : ''}
}
`;

const TINT_BODY = /* glsl */ `
{
  float slot = aPieceTint.y;
  float v = iAnimB.w;
  // Skin: a spread from Mediterranean to northern, since this army is Italian, Syrian
  // and Gallic in the same battle line.
  vec3 skin = mix( vec3( 0.66, 0.48, 0.35 ), vec3( 0.36, 0.24, 0.17 ), fract( v * 7.13 ) );
  // Hair and beards: black through to the reddish blond Tacitus keeps remarking on.
  vec3 hair = mix( vec3( 0.13, 0.09, 0.07 ), vec3( 0.52, 0.34, 0.15 ), fract( v * 13.7 ) );
  vec3 tint;
  if ( slot < 0.5 )       tint = vec3( 1.0 );
  else if ( slot < 1.5 )  tint = iCol0.rgb;
  else if ( slot < 2.5 )  tint = iCol1.rgb;
  else if ( slot < 3.5 )  tint = skin;
  else if ( slot < 4.5 )  tint = hair;
  else if ( slot < 5.5 )  tint = iCol0.rgb * 0.78 + vec3( 0.05, 0.045, 0.04 );
  else if ( slot < 6.5 )  tint = vec3( 1.0 );
  else                    tint = vec3( 0.72 + iCol1.w * 0.36 );
  // Cloth was dyed in small batches and faded in the sun; a few percent of per-man value
  // variation is the single cheapest thing that stops a rank reading as one repeated man.
  tint *= 0.88 + fract( v * 31.1 ) * 0.24;
  vSoldierTint = tint;
  vSoldierGrime = iOrient.w;

  vSoldierEmblem = vec3( 0.0 );
  if ( slot > 5.5 && slot < 6.5 ) {
    float e = iCol0.w;
    vec2 tile = vec2( mod( e, 4.0 ), floor( e * 0.25 ) );
    vSoldierEmblem = vec3(
      SOLDIER_EMBLEM_ORIGIN + vec2( tile.x + aPieceTint.z, aPieceTint.w - tile.y ) * SOLDIER_EMBLEM_TILE,
      1.0 );
  }
}
`;

const FRAG_DECLS = /* glsl */ `
varying vec3 vSoldierTint;
varying float vSoldierGrime;
varying vec3 vSoldierEmblem;
`;

const FRAG_BODY = /* glsl */ `
diffuseColor.rgb *= vSoldierTint;
#ifdef USE_MAP
  if ( vSoldierEmblem.z > 0.5 ) {
    vec4 emblem = texture2D( map, vSoldierEmblem.xy );
    diffuseColor.rgb = mix( diffuseColor.rgb, emblem.rgb, emblem.a );
  }
#endif
// Blood and dust: pull value and saturation down toward a dry earth colour rather than
// simply darkening, which would read as shadow instead of filth.
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  diffuseColor.rgb * 0.5 + vec3( 0.19, 0.15, 0.12 ) * 0.5,
  clamp( vSoldierGrime, 0.0, 1.0 ) );
`;

function defines(o: SoldierShaderOptions): string {
  return [
    `#define SOLDIER_LEAN_H ${o.leanHeight.toFixed(3)}`,
    `#define SOLDIER_EMBLEM_ORIGIN vec2(${o.emblemOrigin[0].toFixed(6)}, ${o.emblemOrigin[1].toFixed(6)})`,
    `#define SOLDIER_EMBLEM_TILE vec2(${o.emblemTile[0].toFixed(6)}, ${o.emblemTile[1].toFixed(6)})`,
  ].join('\n');
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

    let v = shader.vertexShader;
    v = `${defines(o)}\n${DECLS}\nvec3 gSoldierPos;\n${
      withNormal ? 'varying vec3 vSoldierTint;\nvarying float vSoldierGrime;\nvarying vec3 vSoldierEmblem;\n' : ''
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
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp( roughnessFactor + vSoldierGrime * 0.22, 0.04, 1.0 );'
      );
      shader.fragmentShader = f;
    }
  };
  // Two soldier materials must not share a compiled program with anything else, and the
  // two variants must not share with each other.
  material.customProgramCacheKey = () => `soldier-skin-v2-${variant}`;
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
