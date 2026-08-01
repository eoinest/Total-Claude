import * as THREE from 'three';
import type { UvRect } from './atlas';

/**
 * Billboard impostors for the far tier.
 *
 * Beyond `quality.lodFarDistance` a man is a handful of pixels tall, and even a 250
 * triangle LOD2 is paying for silhouette detail that cannot resolve. So at load the real
 * mesh is rendered from eight yaw angles into an atlas, and past that distance each man
 * becomes two triangles sampling the nearest view.
 *
 * Rendering the atlas from the mesh — rather than drawing a silhouette by hand — is what
 * keeps the transition invisible: the impostor is literally the same shape, the same kit
 * and the same shading as the LOD it replaces, just pre-rasterised.
 */

export const IMPOSTOR_YAWS = 8;
const TILE_W = 128;
const TILE_H = 256;
const ATLAS_W = TILE_W * IMPOSTOR_YAWS;

export interface ImpostorAtlas {
  readonly texture: THREE.Texture;
  /** Height in metres that one tile represents, so the quad can be sized to match. */
  readonly worldHeight: number;
  readonly rows: number;
  dispose(): void;
}

/**
 * Render `groups` (one per faction) into a yaw x faction atlas.
 *
 * The source mesh is drawn with its own skinned material, so the pose, the kit mask and
 * the lighting are all identical to the live mesh; the only difference is that the result
 * is a texture. A tight orthographic frustum 2.0 m tall covers the tallest man plus his
 * crest and his raised spear tip is allowed to clip, because a spear one pixel wide is not
 * what the eye is reading at 250 m.
 */
export function renderImpostorAtlas(
  renderer: THREE.WebGLRenderer,
  groups: { geometry: THREE.InstancedBufferGeometry; material: THREE.Material; setup: (g: THREE.InstancedBufferGeometry, yaw: number) => void }[],
  light: { direction: THREE.Vector3; colour: THREE.Color; ambient: THREE.Color }
): ImpostorAtlas {
  const rows = groups.length;
  const target = new THREE.WebGLRenderTarget(ATLAS_W, TILE_H * rows, {
    depthBuffer: true,
    stencilBuffer: false,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
  });

  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(light.colour.getHex(), 3.1);
  sun.position.copy(light.direction).multiplyScalar(50);
  const fill = new THREE.HemisphereLight(0x9dbcdc, 0x54503c, 0.85);
  fill.color.copy(light.ambient);
  scene.add(sun, fill);

  const worldHeight = 2.1;
  const camera = new THREE.OrthographicCamera(
    -(worldHeight * TILE_W) / TILE_H / 2, (worldHeight * TILE_W) / TILE_H / 2,
    worldHeight, 0, -12, 12
  );
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);

  const prevTarget = renderer.getRenderTarget();
  /**
   * The viewport has to be *restored*, not reset to the canvas.
   *
   * What was here — `setViewport(0, 0, domElement.width, domElement.height)` — mixes two
   * coordinate systems. `domElement.width/height` are **drawing-buffer** pixels, already
   * multiplied by the device pixel ratio; `WebGLRenderer.setViewport` takes **CSS** pixels
   * and multiplies by `_pixelRatio` itself. So the viewport came out `pixelRatio` times too
   * large, anchored at the GL origin, and since this bake runs during `init` the entire
   * scene was rasterised that much too big from cold boot: 1.25x at medium, 1.5x at high,
   * 2.0x at ultra, and 1.0x at low only because its `maxPixelRatio` cap of 1 lets it escape.
   *
   * It hid because any runtime quality change repairs it — `setQuality` calls `setPixelRatio`
   * then `setSize`, which sets the viewport correctly — so it was only ever visible on a
   * first load, and only on a display with `devicePixelRatio > 1`.
   */
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);
  renderer.autoClear = false;

  for (let r = 0; r < rows; r++) {
    const { geometry, material, setup } = groups[r];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    for (let y = 0; y < IMPOSTOR_YAWS; y++) {
      // The captured yaw is the angle between the man's facing and the camera; the runtime
      // shader picks the tile from that same relative angle.
      setup(geometry, (y / IMPOSTOR_YAWS) * Math.PI * 2);
      renderer.setViewport(y * TILE_W, r * TILE_H, TILE_W, TILE_H);
      renderer.setScissor(y * TILE_W, r * TILE_H, TILE_W, TILE_H);
      renderer.setScissorTest(true);
      renderer.render(scene, camera);
    }
    scene.remove(mesh);
  }

  renderer.setScissorTest(false);
  renderer.setViewport(prevViewport);
  renderer.autoClear = prevAutoClear;
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.setRenderTarget(prevTarget);

  sun.dispose();
  fill.dispose();

  const texture = target.texture;
  texture.name = 'soldier-impostors';
  // Mipmaps matter more here than anywhere: an impostor is used at four pixels tall, and
  // point-sampling a 128x256 tile at that size makes most fragments miss the man entirely
  // and fail the alpha test, so a whole army fades to nothing. The cost is that high mip
  // levels blur the eight yaw views together, which at four pixels is invisible.
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;

  return {
    texture,
    worldHeight,
    rows,
    dispose(): void {
      target.dispose();
    },
  };
}

/** UV rect of one impostor tile. */
export const impostorUv = (yawIndex: number, row: number, rows: number): UvRect => ({
  u0: yawIndex / IMPOSTOR_YAWS,
  u1: (yawIndex + 1) / IMPOSTOR_YAWS,
  v0: row / rows,
  v1: (row + 1) / rows,
});

/**
 * The impostor quad: a single 2-triangle billboard, built 1 x 1 in the XY plane with the
 * origin at the feet. The vertex shader turns it to face the camera and scales it to the
 * atlas' world height.
 */
export function buildImpostorGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
  ]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.5);
  g.name = 'soldier-impostor-quad';
  return g;
}

const IMPOSTOR_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iOrient;   // yaw, scale, lean, grime
attribute vec4 iCol0;     // tint rgb, atlas row
varying vec2 vImpUv;
varying vec3 vImpTint;
varying float vImpGrime;
`;

const IMPOSTOR_BODY = /* glsl */ `
{
  // Face the camera about the world Y axis only; a man never leans toward the lens.
  vec3 camRight = normalize( vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] ) );
  float h = IMPOSTOR_H * iOrient.y;
  vec3 world = iPos + camRight * position.x * h * IMPOSTOR_ASPECT + vec3( 0.0, position.y * h, 0.0 );
  transformed = world;

  // Which of the eight captured yaws is closest to the angle this man presents to the
  // camera. atan2 of the view-space direction, not the world one, so panning the camera
  // rotates the impostor exactly as it would rotate the mesh.
  vec3 toCam = cameraPosition - iPos;
  float camAngle = atan( toCam.x, toCam.z );
  float rel = iOrient.x - camAngle;
  float tile = floor( mod( rel / 6.2831853 + 0.5 / IMPOSTOR_YAWS, 1.0 ) * IMPOSTOR_YAWS );
  vImpUv = vec2( ( tile + uv.x ) / IMPOSTOR_YAWS, ( iCol0.w + uv.y ) / IMPOSTOR_ROWS );
  vImpTint = iCol0.rgb;
  vImpGrime = iOrient.w;
}
`;

const IMPOSTOR_FRAG_DECL = /* glsl */ `
varying vec2 vImpUv;
varying vec3 vImpTint;
varying float vImpGrime;
uniform sampler2D uImpostor;
`;

const IMPOSTOR_FRAG_BODY = /* glsl */ `
vec4 imp = texture2D( uImpostor, vImpUv );
// A low threshold, because a mipmapped silhouette at four pixels has soft alpha
// everywhere and a high cut-off erases the man.
if ( imp.a < 0.18 ) discard;
imp.rgb /= max( 0.18, imp.a );
diffuseColor.rgb = imp.rgb * mix( vec3( 1.0 ), vImpTint, 0.35 );
diffuseColor.rgb *= 1.0 - vImpGrime * 0.35;
diffuseColor.a = 1.0;
`;

/**
 * Impostor material.
 *
 * `MeshBasicMaterial` on purpose: the atlas already carries baked sun and sky shading from
 * the capture, so re-lighting it would double the light. Fog still applies, which matters —
 * the far tier is exactly where aerial perspective does the work.
 */
export function makeImpostorMaterial(atlas: ImpostorAtlas): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
  material.alphaTest = 0.01;
  const uniforms = { uImpostor: { value: atlas.texture } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = [
      `#define IMPOSTOR_H ${atlas.worldHeight.toFixed(4)}`,
      `#define IMPOSTOR_ASPECT ${(TILE_W / TILE_H).toFixed(6)}`,
      `#define IMPOSTOR_YAWS ${IMPOSTOR_YAWS.toFixed(1)}`,
      `#define IMPOSTOR_ROWS ${atlas.rows.toFixed(1)}`,
      IMPOSTOR_VERT,
      shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${IMPOSTOR_BODY}`),
    ].join('\n');
    shader.fragmentShader = [
      IMPOSTOR_FRAG_DECL,
      shader.fragmentShader.replace('#include <map_fragment>', IMPOSTOR_FRAG_BODY),
    ].join('\n');
  };
  material.customProgramCacheKey = () => 'soldier-impostor-v1';
  return material;
}
