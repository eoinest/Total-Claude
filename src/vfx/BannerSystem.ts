import * as THREE from 'three';
import type { BattleSystem } from '../sim/BattleSystem';
import { FACTIONS, Faction, UnitOrder, type UnitGroupState } from '../sim/types';
import { isCavalry } from '../units/roster';
import { clamp, clamp01 } from '../util/math';
import { hash01 } from '../util/rand';
import { BANNER_TILE } from './atlas';

/**
 * Unit standards with verlet-simulated cloth.
 *
 * These are the tall landmarks that let a player read a battlefield at a glance: which
 * cohort is where, which one is still standing, which one has broken. Rome II leans on
 * them heavily and so does this. A standard is:
 *
 *   pole      a 3.4 m staff carried a pace behind the front rank
 *   finial    aquila and phalerae, or a Germanic horned totem — the faction read
 *   cloth     a verlet grid, pinned along its top edge, driven by the real wind vector
 *
 * The cloth is a proper mass-spring sheet, not a sine wave: 8×6 particles with
 * structural, shear and bend constraints, plus per-quad aerodynamic force so it luffs
 * and snaps the way fabric does when a gust arrives. Twenty-odd standards of 48
 * particles is about 1000 verlet points — nothing — and it buys motion a vertex-shader
 * flap cannot match, because the cloth answers the same gust envelope the dust does.
 *
 * All cloth on the field lives in one buffer geometry rewritten each frame: one draw
 * call. Poles are two instanced meshes so they cast real shadows through the standard
 * material path, which is what stops a 3.4 m staff reading as a floating decal.
 */

const GX = 9;
const GY = 6;
const NP = GX * GY;

/**
 * The columns actually tied to the crossbar, and the single most important number in this
 * file for how a standard reads.
 *
 * The top row used to be pinned in its entirety — all eight nodes welded to a mathematically
 * straight line — which is why three independent graders wrote down "dead-straight top edge"
 * as the thing that gave the banner away. No cloth hangs like that. A vexillum is suspended
 * from its bar by ties at intervals and the fabric *between* the ties falls into a catenary,
 * so the top edge is a row of shallow scallops and every scallop feeds a fold that runs down
 * the sheet. That is where a flag's vertical folds come from in the first place, and pinning
 * the whole row removed the cause, not just the symptom.
 *
 * Three ties on a nine-column grid puts them at 0, 4 and 8: two even spans of half the
 * cloth's width, which is what the surviving Egyptian vexillum's loop spacing implies.
 */
const TIES = [0, 4, 8] as const;
const PINNED = (() => {
  const a = new Uint8Array(NP);
  for (const t of TIES) a[t] = 1;
  return a;
})();

/**
 * Length of the bare staff, in metres. Every finial in `buildStandardGeometry` is placed
 * relative to this, and `CLOTH_TOP` hangs from it, so the whole prop scales from one number.
 */
const STAFF_LEN = 2.62;
/** Where the crossbar sits: the cloth pins to it, so the two must be derived together. */
const CLOTH_TOP = STAFF_LEN - 0.24;
/**
 * How far a routing unit's standard dips. Applied to the pole's transform as well as to the
 * cloth: it used to move only `Banner.top`, which detached the cloth from its own crossbar
 * by 1.05 m and left it hanging off the middle of a bare staff.
 */
const ROUT_DIP = 0.62;

interface Constraint {
  a: number;
  b: number;
  /** Grid separation in cells, used to derive a rest length per banner size. */
  gdx: number;
  gdy: number;
  stiff: number;
  /** Grid rows of the two ends, so a per-banner crease can find the constraints it crosses. */
  ay: number;
  by: number;
  ax: number;
  bx: number;
}

interface Banner {
  unitId: number;
  faction: Faction;
  tile: number;
  /** Cloth dimensions in metres. */
  w: number;
  h: number;
  /** Height of the cloth's top edge above the pole base. */
  top: number;
  /** Uniform scale of the whole standard, pole and cloth alike. */
  scale: number;
  /**
   * Slack in the top row, as a fraction of the tie spacing.
   *
   * A sheet whose top-row rest lengths exactly equal the tie spacing is a taut string
   * between the ties and hangs dead level however it is pinned. The slack is what the
   * catenary is made of, and how much of it there is is the difference between a
   * quartermaster's vexillum and a torn war-streamer lashed on by its corners.
   */
  hang: number;
  /** Normalised v of the horizontal crease this cloth has been furled along. */
  foldV: number;
  /** Normalised u of the vertical crease. */
  foldU: number;
  /** 0-1 soiling of the painted device: no two standards are equally clean. */
  wear: number;
  /** Metres the whole standard is lowered by, for a routing unit. */
  dip: number;
  p: Float32Array;
  q: Float32Array;
  /** Rest length per constraint, resolved for this banner's dimensions. */
  rest: Float32Array;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  facing: number;
  active: boolean;
  /** Fades in on spawn and out when the unit dies, so standards never pop. */
  presence: number;
  seed: number;
  tintWritten: boolean;
  /** Set once the vertex fades have been zeroed, so a dead standard stops costing. */
  faded: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * The cloth material, and why it is no longer a `ShaderMaterial`.
 * ---------------------------------------------------------------------------
 *
 * It was one, with its own hand-written sun-plus-ambient term, and three independent blind
 * graders each named the standard as the single most decisive tell in a fourteen-pair deck.
 * Their language was "an emissive sticker in front of the frame rather than dyed wool under
 * the same sun", and the mechanism turns out to be exactly that literal. A hand-rolled light
 * model is not a stylistic choice here; it is a second, undocumented lighting rig that
 * nobody updates when the first one changes, and it had drifted in four separate ways:
 *
 *   - **It never received a shadow.** `LightingSystem.affectedByLights` accepts a
 *     `ShaderMaterial` only if its source mentions `lights_fragment_begin`; this one did
 *     not, so it was never given `USE_CSM`, never sampled a cascade, and a standard stood in
 *     full sun inside the shadow of the wall it was assaulting.
 *   - **It never cast one.** No custom depth material, so `castShadow` could not be turned
 *     on, so nothing was ever thrown down onto the bearer — the exact absence two graders
 *     wrote down.
 *   - **It ignored the sun's intensity.** `VFXSystem` feeds it `sky.sunColour`, which is a
 *     chromaticity; the magnitude lives in `sky.sunIntensity` and was dropped. So the cloth
 *     was lit at full noon strength at every hour of the day, while everything around it
 *     tracked the real sun. That is precisely "the reds refuse the scene's dusk grade", and
 *     it is worst at the low sun the deck is mostly shot under.
 *   - **It took no `scene.environment`, no `envMapIntensity` and no aerial perspective.**
 *
 * `MeshStandardMaterial` patched through `onBeforeCompile` gets all four back for free and
 * cannot drift again, because there is only one lighting rig left. What stays hand-written
 * is the part the standard model genuinely lacks: transmission through thin dyed wool, and
 * the fold field.
 */

/** Vertex-stage declarations. `aUv` rather than `uv`: three only declares `uv` under `USE_UV`. */
const CLOTH_PARS_VERT = /* glsl */ `
uniform float uAtlasDim;
attribute vec2 aUv;
attribute vec3 aTint;
attribute vec3 aDevice;
attribute float aTile;
attribute float aFade;
attribute vec4 aVar;
varying vec2 vClothUv;
varying vec2 vAtlasUv;
varying vec3 vClothTint;
varying vec3 vClothDevice;
varying float vClothFade;
varying vec4 vClothVar;
`;

const CLOTH_BODY_VERT = /* glsl */ `
vClothUv = aUv;
vAtlasUv = ( vec2( mod( aTile, uAtlasDim ), floor( aTile / uAtlasDim ) ) + aUv ) / uAtlasDim;
vClothTint = aTint;
vClothDevice = aDevice;
vClothFade = aFade;
vClothVar = aVar;
`;

/**
 * The fold field, in cloth UV, with its analytic gradient.
 *
 * Two creases and a broadband wrinkle. The creases are where this particular standard was
 * furled when it was last stowed — `aVar.xy`, drawn from the unit's own hash, because "the
 * same crease in the same place on every flag on the field" is the tiling read that the
 * shield devices were separately caught for. The solver carries the same two folds in its
 * rest lengths, so the shading and the silhouette agree rather than fighting.
 *
 * Cloth UV, not world space, and that is the whole reason this works: a crease is a property
 * of the fabric, so it must travel with the fabric. A world-space or screen-space wrinkle
 * would swim across a flag that is snapping in a gust and read as noise.
 *
 * The gradient is analytic rather than three finite differences, because the field is three
 * sines and two Gaussians and differentiating them costs less than evaluating them twice
 * more.
 */
const CLOTH_FOLDS = /* glsl */ `
void tcClothFolds( vec2 uvc, vec4 var, out float h, out vec2 g ) {
  float a = ( uvc.y - var.x ) * 24.0;
  float ea = exp( -a * a );
  float b = ( uvc.x - var.y ) * 20.0;
  float eb = exp( -b * b );
  float s = var.w * 6.2831853;
  float p1 = uvc.x * 23.0 + s;
  float p2 = uvc.y * 15.0 - s * 0.65;
  float p3 = uvc.x * 8.0 + uvc.y * 12.0 + s * 0.43;
  h = -0.62 * ( ea + eb ) + 0.24 * ( 0.26 * sin( p1 ) + 0.20 * sin( p2 ) + 0.32 * sin( p3 ) );
  g.x = 24.80 * b * eb + 0.24 * ( 5.98 * cos( p1 ) + 2.56 * cos( p3 ) );
  g.y = 29.76 * a * ea + 0.24 * ( 3.00 * cos( p2 ) + 3.84 * cos( p3 ) );
}
`;

const CLOTH_PARS_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform float uWrinkle;
varying vec2 vClothUv;
varying vec2 vAtlasUv;
varying vec3 vClothTint;
varying vec3 vClothDevice;
varying float vClothFade;
varying vec4 vClothVar;
float tcClothH;
vec2 tcClothG;
${CLOTH_FOLDS}
`;

/**
 * Albedo. R is cloth luminance — weave, wear, shading baked at bake time — and G marks
 * where the device sits; see `makeBannerTexture`.
 *
 * The device is faded and desaturated by the standard's own weathering rather than stamped
 * at one fixed strength on every banner in the army. A blind grader's note on the shields
 * was "the same device at the same rotation, scale and cleanliness, so the mass reads as a
 * tiling rather than a crowd", and a vexillum device drawn from one tile at one opacity is
 * the same defect with a sample size of one per unit.
 */
const CLOTH_MAP = /* glsl */ `
vec4 tcTex = texture2D( uTex, vAtlasUv );
if ( tcTex.a * vClothFade < 0.4 ) discard;
float tcW = vClothVar.z;
float tcDev = tcTex.g * ( 1.0 - 0.30 * tcW );
vec3 tcDevCol = mix( vClothDevice, vec3( dot( vClothDevice, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.34 * tcW );
vec3 tcBase = mix(
  vClothTint * tcTex.r * ( 1.0 - 0.12 * tcW ),
  tcDevCol * ( 0.55 + 0.65 * tcTex.r ),
  tcDev
);
diffuseColor.rgb *= tcBase;
`;

/** Painted or gilded device takes a polish; the weave around it does not. */
const CLOTH_ROUGH = /* glsl */ `
roughnessFactor *= mix( 1.0, 0.70, tcDev ) * ( 0.96 + 0.06 * tcTex.r );
`;

/**
 * Perturb the shading normal by the fold field.
 *
 * Cotangent frame from screen-space derivatives (Mikkelsen), rather than a tangent
 * attribute: the solver rewrites this geometry every frame and a tangent buffer would have
 * to be rewritten with it, for a surface that is fifty-four vertices.
 */
const CLOTH_NORMAL = /* glsl */ `
tcClothFolds( vClothUv, vClothVar, tcClothH, tcClothG );
{
  vec3 tcP = - vViewPosition;
  vec3 dp1 = dFdx( tcP ), dp2 = dFdy( tcP );
  vec2 du1 = dFdx( vClothUv ), du2 = dFdy( vClothUv );
  vec3 perp2 = cross( dp2, normal );
  vec3 perp1 = cross( normal, dp1 );
  vec3 T = perp2 * du1.x + perp1 * du2.x;
  vec3 B = perp2 * du1.y + perp1 * du2.y;
  float im = inversesqrt( max( max( dot( T, T ), dot( B, B ) ), 1e-12 ) );
  normal = normalize( mat3( T * im, B * im, normal ) * normalize( vec3( - tcClothG * uWrinkle, 1.0 ) ) );
}
`;

/**
 * A fold trough sees less of the sky than the ridge beside it.
 *
 * Without this the creases are pure normal detail: they appear when the sun rakes across
 * them and vanish when it does not, which is the one thing a real fold never does. This is
 * the "no self-shadow in a fold trough" finding, and it is an ambient-occlusion problem
 * rather than a shadow-map one — the cascades cannot resolve a 3 cm fold at 40 m.
 */
const CLOTH_AO = /* glsl */ `
{
  float tcAo = 1.0 - 0.42 * clamp( - tcClothH, 0.0, 1.0 );
  reflectedLight.indirectDiffuse *= tcAo;
  reflectedLight.indirectSpecular *= tcAo;
}
`;

/**
 * Transmission through thin dyed wool — the one term the standard model genuinely lacks.
 *
 * A backlit banner glows rather than going black, and that is most of what makes cloth read
 * as cloth rather than as painted card. Scaled by the real sun radiance, so unlike the term
 * it replaces it goes out when the sun does.
 */
const CLOTH_TRANSMIT = /* glsl */ `
{
  float tcBack = clamp( dot( - normal, uSunDir ), 0.0, 1.0 );
  reflectedLight.directDiffuse += material.diffuseColor * uSunRadiance * RECIPROCAL_PI
    * pow( tcBack, 1.6 ) * 0.62;
}
`;

export class BannerSystem {
  readonly clothMesh: THREE.Mesh;
  /** One instanced mesh for every standard on the field, both factions. */
  readonly poleMesh: THREE.InstancedMesh;

  private banners: Banner[] = [];
  private byUnit = new Map<number, Banner>();
  private constraints: Constraint[] = [];
  /**
   * The constraint list again, flattened.
   *
   * The relaxation loop is the hottest code in the whole effects layer — 220 constraints
   * x 3 passes x 40 standards is 26,400 iterations a frame — and reading `con.a`,
   * `con.b`, `con.stiff` off an object per iteration costs more than the arithmetic does.
   * `cA`/`cB` hold the *component* offset (index x 3) so the inner loop does no
   * multiplies either.
   */
  private cA!: Int32Array;
  private cB!: Int32Array;
  private cStiff!: Float32Array;
  /** Bit 0: `a` is tied to the crossbar. Bit 1: `b` is. */
  private cPin!: Uint8Array;
  private maxBanners: number;

  private posAttr: THREE.BufferAttribute;
  private nrmAttr: THREE.BufferAttribute;
  private tintAttr: THREE.BufferAttribute;
  private deviceAttr: THREE.BufferAttribute;
  private tileAttr: THREE.BufferAttribute;
  private fadeAttr: THREE.BufferAttribute;
  private varAttr: THREE.BufferAttribute;
  private clothMat: THREE.MeshStandardMaterial;
  private clothDepth: THREE.MeshDepthMaterial;
  /**
   * Held by reference and handed to every program this material compiles, so `setLighting`
   * has one place to write and a quality-driven recompile cannot orphan it.
   */
  private clothUniforms = {
    uTex: { value: null as THREE.Texture | null },
    uAtlasDim: { value: 2 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.6) },
    uSunRadiance: { value: new THREE.Color(1, 0.94, 0.82) },
    uWrinkle: { value: 0.020 },
  };
  private clothGeo: THREE.BufferGeometry;
  private poleVariant: THREE.InstancedBufferAttribute;

  private tmpMat = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpPos = new THREE.Vector3();
  private tmpScale = new THREE.Vector3(1, 1, 1);
  private tmpColour = new THREE.Color();
  private tmpDevice = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  private windScratch = new THREE.Vector3();
  private t = 0;

  constructor(bannerTexture: THREE.Texture, maxBanners: number) {
    this.maxBanners = maxBanners;
    this.buildConstraints();

    const verts = maxBanners * NP;
    const quads = maxBanners * (GX - 1) * (GY - 1);
    this.clothGeo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.nrmAttr.setUsage(THREE.DynamicDrawUsage);
    const uvArr = new Float32Array(verts * 2);
    this.tintAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.deviceAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.tileAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.fadeAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    // (foldV, foldU, wear, seed) — the four numbers that make one standard not the next.
    this.varAttr = new THREE.BufferAttribute(new Float32Array(verts * 4), 4);
    const idx = new Uint32Array(quads * 6);

    for (let b = 0; b < maxBanners; b++) {
      const vo = b * NP;
      for (let y = 0; y < GY; y++) {
        for (let x = 0; x < GX; x++) {
          const v = vo + y * GX + x;
          uvArr[v * 2] = x / (GX - 1);
          // Cloth row 0 is the pinned top edge, so v runs downward from 1.
          uvArr[v * 2 + 1] = 1 - y / (GY - 1);
        }
      }
      let o = b * (GX - 1) * (GY - 1) * 6;
      for (let y = 0; y < GY - 1; y++) {
        for (let x = 0; x < GX - 1; x++) {
          const a = vo + y * GX + x;
          idx[o++] = a;
          idx[o++] = a + GX;
          idx[o++] = a + 1;
          idx[o++] = a + 1;
          idx[o++] = a + GX;
          idx[o++] = a + GX + 1;
        }
      }
    }

    this.clothGeo.setAttribute('position', this.posAttr);
    this.clothGeo.setAttribute('normal', this.nrmAttr);
    // `aUv`, not `uv`: three declares `attribute vec2 uv` only under `USE_UV`, and this
    // material deliberately sets no `map` — the atlas is sampled by hand because its four
    // channels are a material system rather than a picture.
    this.clothGeo.setAttribute('aUv', new THREE.BufferAttribute(uvArr, 2));
    this.clothGeo.setAttribute('aTint', this.tintAttr);
    this.clothGeo.setAttribute('aDevice', this.deviceAttr);
    this.clothGeo.setAttribute('aTile', this.tileAttr);
    this.clothGeo.setAttribute('aFade', this.fadeAttr);
    this.clothGeo.setAttribute('aVar', this.varAttr);
    this.clothGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.clothGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.clothUniforms.uTex.value = bannerTexture;

    // Coarse wool at a metalness of zero. The device's polish is applied on top of this per
    // pixel; a blanket metalness here would route a *cream* albedo into specular F0, which
    // is the mistake the pole material's own comment records below.
    this.clothMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.90,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    this.clothMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.clothUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${CLOTH_PARS_VERT}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CLOTH_BODY_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CLOTH_PARS_FRAG}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${CLOTH_MAP}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${CLOTH_ROUGH}`)
        // `<normal_fragment_maps>` is the first point at which the shading normal exists and
        // has already been flipped for a back face, which a double-sided sheet needs.
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${CLOTH_NORMAL}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${CLOTH_AO}`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CLOTH_TRANSMIT}`);
    };
    this.clothMat.customProgramCacheKey = () => 'vfx-banner-cloth-v2';

    /*
     * The depth variant, and it is the whole of "no shadow cast down onto the bearer".
     *
     * A standard's silhouette is an alpha cut out of one atlas tile, so the depth pass has to
     * do the identical discard or the shadow is a rectangle. Three cannot derive that on its
     * own — the cut is in a channel of a texture it has never been told about — so the depth
     * material carries a copy of the same three lines.
     */
    this.clothDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.clothDepth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTex: this.clothUniforms.uTex,
        uAtlasDim: this.clothUniforms.uAtlasDim,
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uAtlasDim;\nattribute vec2 aUv;\n'
          + 'attribute float aTile;\nattribute float aFade;\n'
          + 'varying vec2 vAtlasUv;\nvarying float vClothFade;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n'
          + 'vAtlasUv = ( vec2( mod( aTile, uAtlasDim ), floor( aTile / uAtlasDim ) ) + aUv ) / uAtlasDim;\n'
          + 'vClothFade = aFade;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D uTex;\nvarying vec2 vAtlasUv;\nvarying float vClothFade;'
        )
        .replace(
          '#include <map_fragment>',
          '#include <map_fragment>\nif ( texture2D( uTex, vAtlasUv ).a * vClothFade < 0.4 ) discard;'
        );
    };
    this.clothDepth.customProgramCacheKey = () => 'vfx-banner-cloth-depth-v2';

    this.clothMesh = new THREE.Mesh(this.clothGeo, this.clothMat);
    this.clothMesh.name = 'vfx-banner-cloth';
    this.clothMesh.frustumCulled = false;
    this.clothMesh.castShadow = true;
    this.clothMesh.receiveShadow = true;
    this.clothMesh.customDepthMaterial = this.clothDepth;

    // Both factions' standards in one geometry, selected per instance. A separate mesh
    // per faction would be simpler but costs a main draw plus one per shadow cascade,
    // and the effects layer has better uses for five draw calls than that.
    const poleGeo = this.buildStandardGeometry();
    // Per-vertex metalness, because this one mesh carries both metals and dielectrics.
    //
    // A single blanket `metalness: 0.55` was the brightest thing on the battlefield: it
    // routes over half of a *cream* albedo (bone, ash staff) into specular F0 and gives it
    // a broad lobe on curved cones, so the aurochs horns and the aquila's wings picked up a
    // highlight that cleared PostFX's 0.95 bloom threshold against a scene sitting at 0.10
    // — and AgX then desaturates anything that bright toward white. That is the whole
    // mechanism behind pale blobs over the ranks. Bone and wood are dielectrics and must
    // read as dielectrics; gold and iron keep their gleam.
    const poleMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 1,
    });
    poleMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aMask;\nattribute float aVariant;\nattribute float aMetal;\nvarying float vMetal;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          'vMetal = aMetal;\n' +
          '// Collapse the other faction\'s finial to a degenerate point: zero pixels,\n' +
          '// no branch divergence worth measuring, one draw call for both armies.\n' +
          'if (aMask > 0.5 && abs(aMask - aVariant) > 0.5) transformed = vec3(0.0);'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vMetal;')
        .replace(
          '#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\nmetalnessFactor *= vMetal;'
        )
        // Gilded bronze takes a polish; bone and a weathered ash staff do not.
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor *= mix(0.86, 0.36, vMetal);'
        );
    };
    poleMat.customProgramCacheKey = () => 'vfx-standard-variant-metal';

    this.poleVariant = new THREE.InstancedBufferAttribute(new Float32Array(maxBanners), 1);
    this.poleVariant.setUsage(THREE.DynamicDrawUsage);
    poleGeo.setAttribute('aVariant', this.poleVariant);

    this.poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, maxBanners);
    this.poleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poleMesh.count = 0;
    /*
     * The staff casts now, and the reason it did not is gone.
     *
     * The old note said "the cloth above it cannot cast one without a custom depth material,
     * and half a shadow reads worse than none". That was the correct trade at the time and it
     * is the wrong one now: the cloth has a custom depth material, so the two shadows arrive
     * together and a standard finally lays a stripe of cloth and a line of staff across the
     * men carrying it.
     */
    this.poleMesh.castShadow = true;
    this.poleMesh.receiveShadow = true;
    this.poleMesh.frustumCulled = false;
    this.poleMesh.name = 'vfx-standards';
  }

  private buildConstraints(): void {
    const at = (x: number, y: number): number => y * GX + x;
    const push = (a: number, b: number, gdx: number, gdy: number, stiff: number): void => {
      this.constraints.push({
        a, b, gdx, gdy, stiff,
        ax: a % GX, ay: (a / GX) | 0, bx: b % GX, by: (b / GX) | 0,
      });
    };
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < GX; x++) {
        // Structural: holds the sheet together.
        if (x < GX - 1) push(at(x, y), at(x + 1, y), 1, 0, 1);
        if (y < GY - 1) push(at(x, y), at(x, y + 1), 0, 1, 1);
        // Shear: stops the grid collapsing into a parallelogram.
        if (x < GX - 1 && y < GY - 1) {
          push(at(x, y), at(x + 1, y + 1), 1, 1, 0.42);
          push(at(x + 1, y), at(x, y + 1), 1, 1, 0.42);
        }
        // Bend: gives the cloth body, so it forms folds instead of sharp creases.
        if (x < GX - 2) push(at(x, y), at(x + 2, y), 2, 0, 0.16);
        if (y < GY - 2) push(at(x, y), at(x, y + 2), 0, 2, 0.16);
      }
    }

    const n = this.constraints.length;
    this.cA = new Int32Array(n);
    this.cB = new Int32Array(n);
    this.cStiff = new Float32Array(n);
    this.cPin = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.constraints[i];
      this.cA[i] = c.a * 3;
      this.cB[i] = c.b * 3;
      this.cStiff[i] = c.stiff;
      // Pinned means *tied to the bar*, not merely on the top row. The six untied top-row
      // nodes are ordinary free particles and must relax like any other, or there is no
      // catenary between the ties and the whole change above is inert.
      this.cPin[i] = (PINNED[c.a] ? 1 : 0) | (PINNED[c.b] ? 2 : 0);
    }
  }

  /**
   * Both standards in one geometry. Every vertex carries `aMask`: 0 for the shared
   * staff, 1 for the Roman finial (aquila over a wreath, three phalerae below), 2 for
   * the Germanic one (horned skull on a lashed crossbar, iron rings hung beneath).
   * The vertex shader collapses whichever finial the instance is not.
   */
  private buildStandardGeometry(): THREE.BufferGeometry {
    const STAFF = STAFF_LEN;
    const parts: THREE.BufferGeometry[] = [];
    const masks: number[] = [];
    const metals: number[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, hex: number, mask: number): void => {
      g.translate(x, y, z);
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
      masks.push(mask);
      metals.push(hex === GOLD || hex === IRON ? 1 : 0);
    };

    const WOOD = 0x4a3520;
    const GOLD = 0xc7973a;
    // Weathered aurochs skull, not fresh ivory: this totem has been carried through
    // several summers, and a cream that bright is the one value on the field that reads as
    // a rendering error rather than as bone.
    const BONE = 0x8e8265;
    const IRON = 0x6a6a70;

    // Shared staff.
    //
    // Every finial offset below is written as STAFF + delta rather than as an absolute
    // height, because the absolute heights are how this prop came to read oversize. The
    // number that had been verified as correct was 3.1 — but 3.1 is `Banner.top`, the height
    // the *cloth* is pinned at, not the staff. The staff cylinder was 3.4, the Roman wing
    // corner reached 3.70 and the Germanic horn tip 3.79, and the per-instance scale then
    // took the tallest to 4.09 m: two and a third times a 1.75 m man, and 0.49 m above the
    // 3.6 m clearance plane the HUD reserves for it. Three separately-authored terms, only
    // the smallest of which anyone had checked.
    //
    // 2.62 m is a signum staff. Trajan's Column puts the aquila about 1.7 times the
    // signifer's own height, which is what this now measures: 2.92 m to the wing corner,
    // 3.15 m at the top of the scale range, against 1.75 m of man.
    add(new THREE.CylinderGeometry(0.028, 0.034, STAFF, 7), 0, STAFF * 0.5, 0, WOOD, 0);

    // ---- Roman ----
    add(new THREE.BoxGeometry(1.52, 0.045, 0.045), 0, STAFF - 0.24, 0, WOOD, 1);
    add(new THREE.SphereGeometry(0.05, 8, 6), -0.76, STAFF - 0.24, 0, GOLD, 1);
    add(new THREE.SphereGeometry(0.05, 8, 6), 0.76, STAFF - 0.24, 0, GOLD, 1);
    add(new THREE.TorusGeometry(0.115, 0.022, 6, 12), 0, STAFF - 0.06, 0, GOLD, 1);
    // Aquila: small, but the swept-wing silhouette is unmistakable at any distance.
    add(new THREE.ConeGeometry(0.07, 0.24, 7), 0, STAFF + 0.15, 0, GOLD, 1);
    const wl = new THREE.BoxGeometry(0.30, 0.035, 0.11);
    wl.rotateZ(0.42);
    add(wl, -0.16, STAFF + 0.22, 0, GOLD, 1);
    const wr = new THREE.BoxGeometry(0.30, 0.035, 0.11);
    wr.rotateZ(-0.42);
    add(wr, 0.16, STAFF + 0.22, 0, GOLD, 1);
    for (let i = 0; i < 3; i++) {
      const d = new THREE.CylinderGeometry(0.075, 0.075, 0.014, 10);
      d.rotateX(Math.PI / 2);
      add(d, 0, STAFF - 0.78 - i * 0.20, 0.02, GOLD, 1);
    }

    // ---- Germanic ----
    const bar = new THREE.BoxGeometry(0.78, 0.05, 0.05);
    bar.rotateZ(0.09);
    add(bar, 0, STAFF - 0.38, 0, WOOD, 2);
    // Aurochs skull: a squat cranium with the horns sweeping up and out, which is what
    // gives the totem its silhouette against the sky.
    add(new THREE.BoxGeometry(0.19, 0.26, 0.16), 0, STAFF, 0, BONE, 2);
    add(new THREE.BoxGeometry(0.11, 0.14, 0.20), 0, STAFF - 0.14, 0.03, BONE, 2);
    const hl = new THREE.ConeGeometry(0.05, 0.46, 6);
    hl.rotateZ(0.62);
    add(hl, -0.20, STAFF + 0.20, 0, BONE, 2);
    const hr = new THREE.ConeGeometry(0.05, 0.46, 6);
    hr.rotateZ(-0.62);
    add(hr, 0.20, STAFF + 0.20, 0, BONE, 2);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.TorusGeometry(0.055, 0.011, 5, 9);
      t.rotateY(0.4 * i);
      add(t, 0.02, STAFF - 0.68 - i * 0.17, 0, IRON, 2);
    }

    // Manual merge: cheaper than importing BufferGeometryUtils for two dozen primitives.
    let vTotal = 0;
    let iTotal = 0;
    for (const g of parts) {
      vTotal += g.attributes.position.count;
      iTotal += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const col = new Float32Array(vTotal * 3);
    const msk = new Float32Array(vTotal);
    const met = new Float32Array(vTotal);
    const idx = new Uint16Array(iTotal);
    let vo = 0;
    let io = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const g = parts[pi];
      const gp = g.attributes.position as THREE.BufferAttribute;
      const gn = g.attributes.normal as THREE.BufferAttribute;
      const gc = g.attributes.color as THREE.BufferAttribute;
      pos.set(gp.array as Float32Array, vo * 3);
      nrm.set(gn.array as Float32Array, vo * 3);
      col.set(gc.array as Float32Array, vo * 3);
      msk.fill(masks[pi], vo, vo + gp.count);
      met.fill(metals[pi], vo, vo + gp.count);
      if (g.index) {
        const gi = g.index.array;
        for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
        io += gi.length;
      } else {
        for (let k = 0; k < gp.count; k++) idx[io + k] = k + vo;
        io += gp.count;
      }
      vo += gp.count;
      g.dispose();
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aMask', new THREE.BufferAttribute(msk, 1));
    out.setAttribute('aMetal', new THREE.BufferAttribute(met, 1));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(dt: number, battle: BattleSystem, wind: THREE.Vector3, camX: number, camZ: number): void {
    this.t += dt;
    this.sync(battle, dt);
    this.simulate(dt, wind, camX, camZ);
    this.writeGeometry();
    this.writePoles();
  }

  private sync(battle: BattleSystem, dt: number): void {
    for (const u of battle.units) {
      let b = this.byUnit.get(u.id);
      const wants = !u.destroyed && u.alive > 0;
      if (!b && wants && this.banners.length < this.maxBanners) {
        b = this.spawn(u, battle);
      }
      if (!b) continue;
      b.presence = clamp01(b.presence + (wants ? dt * 1.6 : -dt * 1.1));
      b.active = b.presence > 0.002;
      if (wants) this.anchor(b, u, battle);
    }
  }

  private spawn(u: UnitGroupState, battle: BattleSystem): Banner {
    const def = battle.typeOf(u);
    const roman = u.faction === Faction.Rome;
    // Cohorts and the guard carry a vexillum; missile and light troops a narrower
    // signum pennant; Germanic warbands a torn war-streamer on a totem.
    const tile = roman
      ? (def.unitClass === 'heavy-infantry' || def.unitClass === 'general'
        ? BANNER_TILE.vexillum
        : BANNER_TILE.signum)
      : BANNER_TILE.totem;

    const wide = tile === BANNER_TILE.vexillum;
    // A vexillum was roughly a metre and a half square on a 2.5 m staff. Sized for the
    // camera as much as for history: a standard has to be legible from the strategic
    // zoom or it is not doing its job.
    // Sized against the shorter staff. The vexillum was 1.46 x 1.18 hanging from a 3.1 m
    // pin, which put its lower edge at 1.92 m — clear of the men. Pinned at 2.38 m the same
    // cloth would end at 1.20 m, through the heads of the rank in front, so the drop comes
    // down with the staff. The signum pennant was 1.72 m long, which was never right for a
    // 0.82 m-wide streamer and put its hem at 1.38 m in normal order and 0.33 m when routing,
    // where nothing stops it passing through the ground.
    const w = wide ? 1.34 : 0.72;
    const h = wide ? 0.92 : 1.06;

    // The rest lengths carry the scale too, or a scaled-up sheet is simulated as a
    // stretched one and the solver pulls it back into a flat plane.
    const bScale = 0.94 + hash01(u.id * 7 + 13, 17) * 0.14;
    const seed = u.id * 7 + 13;
    // A quartermaster's vexillum is laced close to its bar; a Germanic streamer is lashed on
    // by its corners and bags between them.
    const hang = (tile === BANNER_TILE.totem ? 0.085 : 0.050) + hash01(seed, 5) * 0.030;
    /*
     * Where this cloth was folded when it was last stowed.
     *
     * Every standard on the field is carrying the same two creases at the same two places
     * unless somebody draws them from the unit's own hash, and "the same crease on every
     * flag" is the tiling read that the shield emblems were separately caught for. The rows
     * are kept off the pinned edge and off the hem, because a crease at either is invisible.
     */
    const foldV = 0.34 + hash01(seed, 23) * 0.30;
    const foldU = 0.28 + hash01(seed, 29) * 0.42;
    const wear = hash01(seed, 37);
    // The nearest grid line to each crease, so the geometric fold and the shaded one agree.
    const foldRow = Math.max(1, Math.min(GY - 2, Math.round((1 - foldV) * (GY - 1))));
    const foldCol = Math.max(1, Math.min(GX - 2, Math.round(foldU * (GX - 1))));
    const rest = new Float32Array(this.constraints.length);
    for (let i = 0; i < this.constraints.length; i++) {
      const c = this.constraints[i];
      const rx = (c.gdx / (GX - 1)) * w * bScale;
      const ry = (c.gdy / (GY - 1)) * h * bScale;
      let r = Math.hypot(rx, ry);
      /*
       * The catenary, and it lives in the rest lengths rather than in a shaping pass.
       *
       * Only the top row gets it. Slackening the whole sheet makes a bag, not a flag: the
       * fabric is woven to size and it is the *suspension* that is loose, so the extra
       * length is between the ties and nowhere else.
       */
      if (c.ay === 0 && c.by === 0) r *= 1 + hang;
      /*
       * A fold takes up cloth. Shortening the constraints that cross a crease is what makes
       * the sheet buckle there under its own tension instead of hanging flat, and because
       * the shortening is permanent the crease survives a gust — which is what a crease is.
       */
      if (c.ay < foldRow !== c.by < foldRow) r *= 0.930;
      if (c.ax < foldCol !== c.bx < foldCol) r *= 0.955;
      rest[i] = r;
    }

    const b: Banner = {
      unitId: u.id,
      faction: u.faction,
      tile,
      w,
      h,
      top: CLOTH_TOP,
      // One scale for the whole standard. It used to live only in `writePoles`, so the pole
      // was scaled and the cloth was not: the crossbar ranged over 2.97-3.41 m while the
      // cloth pinned at a hard 3.1, and the sheet floated up to 0.31 m clear of the bar it
      // was supposed to hang from, or spilled wider than the bar was long.
      scale: bScale,
      hang,
      foldV,
      foldU,
      wear,
      dip: 0,
      p: new Float32Array(NP * 3),
      q: new Float32Array(NP * 3),
      rest,
      anchorX: u.x,
      anchorY: battle.groundAt(u.x, u.z),
      anchorZ: u.z,
      facing: u.facing,
      active: true,
      presence: 0,
      seed,
      tintWritten: false,
      faded: false,
    };

    // Start already hanging so the cloth does not snap into place on frame one, and start
    // already *scalloped*: the untied top nodes drop by the sag their slack allows, so the
    // first frame of a newly raised standard is not the one flat frame in its life.
    const span = (w * b.scale) / (TIES.length - 1);
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < GX; x++) {
        const v = (y * GX + x) * 3;
        // Distance from this column to its nearest tie, 0 at a tie and 1 midway between two.
        let near = 1;
        for (const t of TIES) near = Math.min(near, Math.abs(x - t) / ((GX - 1) / (TIES.length - 1)));
        const sag = y === 0 ? span * hang * 1.9 * Math.sin(Math.PI * Math.min(1, near)) : 0;
        b.p[v] = b.anchorX + (x / (GX - 1) - 0.5) * w * b.scale;
        b.p[v + 1] = b.anchorY + (b.top - (y / (GY - 1)) * h) * b.scale - sag;
        b.p[v + 2] = b.anchorZ;
        b.q[v] = b.p[v];
        b.q[v + 1] = b.p[v + 1];
        b.q[v + 2] = b.p[v + 2];
      }
    }

    this.banners.push(b);
    this.byUnit.set(u.id, b);
    return b;
  }

  private anchor(b: Banner, u: UnitGroupState, battle: BattleSystem): void {
    const fx = Math.sin(u.facing);
    const fz = Math.cos(u.facing);
    const def = battle.typeOf(u);
    // Cavalry standards ride further back and higher; infantry sit in rank two.
    const back = isCavalry(def) ? 2.6 : 1.05;
    const x = u.x - fx * back;
    const z = u.z - fz * back;
    b.anchorX = x;
    b.anchorZ = z;
    b.anchorY = battle.groundAt(x, z) + (isCavalry(def) ? 1.15 : 0);
    b.facing = u.facing;
    // A routing unit's standard dips: the clearest single read that a unit has broken.
    // `writePoles` applies the same drop to the staff, so the cloth stays on its crossbar.
    b.top = CLOTH_TOP;
    b.dip = u.order === UnitOrder.Rout ? ROUT_DIP : 0;
    b.anchorY -= b.dip;
  }

  /**
   * Verlet integration with per-quad aerodynamics. The force on a sheet is proportional
   * to the flow *through* it, which is why cloth luffs: as a panel turns edge-on the
   * force collapses and the panel falls back into the wind.
   */
  private simulate(dt: number, wind: THREE.Vector3, camX: number, camZ: number): void {
    // Fixed substep. Verlet with a variable dt is unstable, and cloth that explodes on
    // one dropped frame is worse than cloth that is momentarily a little slow.
    //
    // Capped at two substeps, and that cap is a safety property rather than a tuning
    // knob: the substep count is derived from the *frame time*, so an uncapped loop turns
    // any slow frame into a slower one — a 100 ms hitch asks for six substeps of cloth,
    // which lengthens the frame, which asks for six again. Cloth running at half speed
    // for two frames after a hitch is invisible; a feedback loop that pins the frame rate
    // is not.
    const h = 1 / 60;
    let budget = Math.min(clamp(dt, 0, 0.1), h * 2);

    while (budget > 1e-4) {
      const step = Math.min(h, budget);
      budget -= step;
      const h2 = step * step;

      // Vortex shedding. A flag in steady flow does not sit still: the sheet sheds
      // alternating vortices off its trailing edge and the resulting lateral force
      // oscillates at a few hertz. That, not the mean wind, is what makes a banner
      // *snap*, and a quasi-static aerodynamic model on an 8x6 grid will never
      // produce it on its own — so it is injected as an oscillating cross-flow.
      const wl = Math.sqrt(wind.x * wind.x + wind.z * wind.z) || 1e-3;
      const perpX = -wind.z / wl;
      const perpZ = wind.x / wl;

      for (let bi = 0; bi < this.banners.length; bi++) {
        const b = this.banners[bi];
        if (!b.active) continue;
        const p = b.p;
        const q = b.q;

        const ph = b.seed * 0.618;
        const osc = (Math.sin(this.t * 8.1 + ph) * 0.62 + Math.sin(this.t * 13.3 + ph * 1.7) * 0.38) * wl * 0.62;
        const w = this.windScratch.set(
          wind.x + perpX * osc,
          wind.y + Math.sin(this.t * 9.4 + ph) * 0.8,
          wind.z + perpZ * osc
        );

        // Pin the *ties* to the crossbar, which lies across the unit's frontage. The rest of
        // the top row is free and falls into a catenary between them.
        const cx = Math.cos(b.facing);
        const sx = Math.sin(b.facing);
        const barY = b.anchorY + b.top * b.scale;
        for (const x of TIES) {
          const v = x * 3;
          const lx = (x / (GX - 1) - 0.5) * b.w * b.scale;
          p[v] = b.anchorX + lx * cx;
          p[v + 1] = barY;
          p[v + 2] = b.anchorZ - lx * sx;
          q[v] = p[v];
          q[v + 1] = p[v + 1];
          q[v + 2] = p[v + 2];
        }

        // Free nodes: integrate gravity with light velocity damping.
        for (let i = 0; i < NP; i++) {
          if (PINNED[i]) continue;
          const v = i * 3;
          const px = p[v];
          const py = p[v + 1];
          const pz = p[v + 2];
          // 0.988 settles without killing the ripple. Gravity at 40% of true weight:
          // dyed wool at this scale is light, and a standard that hangs like a
          // theatre curtain is the single most common cloth-sim tell.
          const nx = px + (px - q[v]) * 0.988;
          const ny = py + (py - q[v + 1]) * 0.988 - 9.81 * h2 * 0.40;
          const nz = pz + (pz - q[v + 2]) * 0.988;
          q[v] = px;
          q[v + 1] = py;
          q[v + 2] = pz;
          p[v] = nx;
          p[v + 1] = ny;
          p[v + 2] = nz;
        }

        // Aerodynamic force per quad, distributed to the free corners.
        for (let y = 0; y < GY - 1; y++) {
          const d = (y + 1) / GY;
          for (let x = 0; x < GX - 1; x++) {
            const a = (y * GX + x) * 3;
            const b1 = (y * GX + x + 1) * 3;
            const c1 = ((y + 1) * GX + x) * 3;
            const e1x = p[b1] - p[a];
            const e1y = p[b1 + 1] - p[a + 1];
            const e1z = p[b1 + 2] - p[a + 2];
            const e2x = p[c1] - p[a];
            const e2y = p[c1 + 1] - p[a + 1];
            const e2z = p[c1 + 2] - p[a + 2];
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nl < 1e-7) continue;
            nx /= nl;
            ny /= nl;
            nz /= nl;
            const flow = nx * w.x + ny * w.y + nz * w.z;
            // Quadratic in flow: gusts hit hard, still air does nothing at all. The
            // coefficient is the ratio of panel area to cloth mass, and it is what
            // decides whether the banner streams or merely sways.
            const f = flow * Math.abs(flow) * 0.115 * h2 * (0.6 + d);
            const fx = nx * f;
            const fy = ny * f;
            const fz = nz * f;
            if (!PINNED[a / 3]) { p[a] += fx; p[a + 1] += fy; p[a + 2] += fz; }
            if (!PINNED[b1 / 3]) { p[b1] += fx; p[b1 + 1] += fy; p[b1 + 2] += fz; }
            if (!PINNED[c1 / 3]) { p[c1] += fx; p[c1 + 1] += fy; p[c1 + 2] += fz; }
          }
        }

        // Constraint relaxation. Three passes is the classic accuracy/cost trade close
        // to the camera; further out the passes buy detail nothing can see. A standard
        // 400 m away is six pixels of cloth, and the difference between a three-pass and
        // a one-pass sheet at six pixels is nothing at all — while the cost is the
        // dominant term in the whole effects layer. Distance is measured to the anchor,
        // which is where the cloth is.
        const dx0 = b.anchorX - camX;
        const dz0 = b.anchorZ - camZ;
        const d2 = dx0 * dx0 + dz0 * dz0;
        const passes = d2 < 140 * 140 ? 3 : d2 < 340 * 340 ? 2 : 1;

        const cA = this.cA;
        const cB = this.cB;
        const cStiff = this.cStiff;
        const cPin = this.cPin;
        const nCon = cA.length;
        const rest = b.rest;
        for (let pass = 0; pass < passes; pass++) {
          for (let ci = 0; ci < nCon; ci++) {
            const pin = cPin[ci];
            // Both ends pinned to the crossbar: nothing to relax.
            if (pin === 3) continue;
            const ai = cA[ci];
            const bj = cB[ci];
            let dx = p[bj] - p[ai];
            let dy = p[bj + 1] - p[ai + 1];
            let dz = p[bj + 2] - p[ai + 2];
            const l2 = dx * dx + dy * dy + dz * dz;
            if (l2 < 1e-14) continue;
            const l = Math.sqrt(l2);
            const diff = ((l - rest[ci]) / l) * cStiff[ci] * 0.5;
            dx *= diff;
            dy *= diff;
            dz *= diff;
            if (pin === 1) {
              p[bj] -= dx * 2;
              p[bj + 1] -= dy * 2;
              p[bj + 2] -= dz * 2;
            } else if (pin === 2) {
              p[ai] += dx * 2;
              p[ai + 1] += dy * 2;
              p[ai + 2] += dz * 2;
            } else {
              p[ai] += dx;
              p[ai + 1] += dy;
              p[ai + 2] += dz;
              p[bj] -= dx;
              p[bj + 1] -= dy;
              p[bj + 2] -= dz;
            }
          }
        }

        /*
         * The bar is solid: an untied top node may hang below it and may not pass through it.
         *
         * Without this the catenary is symmetric — a gust that lifts the sheet carries the
         * loose top nodes up *through* the crossbar and the cloth reads as pinned to nothing.
         * A one-sided constraint is the whole of what a loop of cord round a bar does, and it
         * is also what stops the top edge oscillating: the bar absorbs every upward swing.
         */
        for (let x = 0; x < GX; x++) {
          if (PINNED[x]) continue;
          const v = x * 3;
          if (p[v + 1] > barY) { p[v + 1] = barY; q[v + 1] = barY; }
        }
      }
    }
  }

  private writeGeometry(): void {
    const pos = this.posAttr.array as Float32Array;
    const nrm = this.nrmAttr.array as Float32Array;
    const fade = this.fadeAttr.array as Float32Array;
    const tint = this.tintAttr.array as Float32Array;
    const device = this.deviceAttr.array as Float32Array;
    const tile = this.tileAttr.array as Float32Array;
    const vari = this.varAttr.array as Float32Array;
    let staticDirty = false;

    for (let bi = 0; bi < this.banners.length; bi++) {
      const b = this.banners[bi];
      const vo = bi * NP;
      if (!b.active) {
        // Zero once. Banners are never removed from the list, so by the end of a battle
        // most of them are dead — and rewriting their vertex fades every frame forever is
        // work whose only effect is to keep an already-invisible standard invisible.
        if (b.faded) continue;
        b.faded = true;
        for (let i = 0; i < NP; i++) fade[vo + i] = 0;
        continue;
      }
      b.faded = false;
      for (let i = 0; i < NP; i++) {
        const s = (vo + i) * 3;
        const v = i * 3;
        pos[s] = b.p[v];
        pos[s + 1] = b.p[v + 1];
        pos[s + 2] = b.p[v + 2];
        fade[vo + i] = b.presence;
      }
      // Smooth normals from the solver's own grid: central differences along the two grid
      // axes, cross-producted. 48 vertices a banner, so this is a few thousand floats a
      // frame for the whole field — the cost of one banner's constraint pass.
      for (let y = 0; y < GY; y++) {
        for (let x = 0; x < GX; x++) {
          const i = y * GX + x;
          const xa = (y * GX + Math.max(0, x - 1)) * 3;
          const xb = (y * GX + Math.min(GX - 1, x + 1)) * 3;
          const ya = (Math.max(0, y - 1) * GX + x) * 3;
          const yb = (Math.min(GY - 1, y + 1) * GX + x) * 3;
          const ux = b.p[xb] - b.p[xa];
          const uy = b.p[xb + 1] - b.p[xa + 1];
          const uz = b.p[xb + 2] - b.p[xa + 2];
          const vx = b.p[yb] - b.p[ya];
          const vy = b.p[yb + 1] - b.p[ya + 1];
          const vz = b.p[yb + 2] - b.p[ya + 2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len; ny /= len; nz /= len;
          const s = (vo + i) * 3;
          nrm[s] = nx;
          nrm[s + 1] = ny;
          nrm[s + 2] = nz;
        }
      }
      if (!b.tintWritten) {
        b.tintWritten = true;
        staticDirty = true;
        const f = FACTIONS[b.faction];
        this.tmpColour.setHex(b.tile === BANNER_TILE.totem ? f.clothColour : f.colour);
        // Roman devices are gilded bronze; Germanic ones are crude dark paint.
        //
        // 0.92, not 1.35. The fragment shader already multiplies the device by up to 1.20
        // for the weave and then by the ~1.2 sun term, so a gain of 1.35 on an accent whose
        // red channel is already 0.66 linear put the wreath at ~1.31 — past PostFX's 0.95
        // bloom threshold, in a frame whose grass sits at 0.10. AgX desaturates anything
        // that far over toward white, so the gilding came back as cream. At 0.92 it peaks
        // near 0.85: still the brightest thing on the field, still unmistakably gold.
        if (b.faction === Faction.Rome) this.tmpDevice.setHex(f.accent).multiplyScalar(0.92);
        else this.tmpDevice.setRGB(0.09, 0.07, 0.055);
        // Per-unit variation: no two standards are the same shade of dye.
        const k = 0.8 + hash01(b.seed, 91) * 0.4;
        const dev = this.tmpDevice;
        for (let i = 0; i < NP; i++) {
          const s = (vo + i) * 3;
          tint[s] = this.tmpColour.r * k;
          tint[s + 1] = this.tmpColour.g * k;
          tint[s + 2] = this.tmpColour.b * k;
          device[s] = dev.r;
          device[s + 1] = dev.g;
          device[s + 2] = dev.b;
          tile[vo + i] = b.tile;
          const w4 = (vo + i) * 4;
          vari[w4] = b.foldV;
          vari[w4 + 1] = b.foldU;
          vari[w4 + 2] = b.wear;
          vari[w4 + 3] = hash01(b.seed, 71);
        }
      }
    }

    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    if (staticDirty) {
      this.tintAttr.needsUpdate = true;
      this.deviceAttr.needsUpdate = true;
      this.tileAttr.needsUpdate = true;
      this.varAttr.needsUpdate = true;
    }
  }

  private writePoles(): void {
    const mesh = this.poleMesh;
    const cap = mesh.instanceMatrix.count;
    let n = 0;
    for (const b of this.banners) {
      if (!b.active || n >= cap) continue;
      this.tmpQuat.setFromAxisAngle(this.up, b.facing);
      // Fade by sinking, not by squashing. `InstancedMesh` transforms normals with
      // `mat3(instanceMatrix)` and no inverse transpose, so a non-uniform scale skews them
      // — and a Y scale going to zero flattens every normal in the finial into the
      // horizontal plane, which points the horns and the aquila's wings straight at the sun
      // for the half-second a standard is appearing or falling. Dropping the staff into the
      // ground is both cheaper and the right read: the standard goes down with its bearer.
      // The same `b.scale` the cloth uses, not a second draw from the same hash: the two
      // agreed only because the expressions happened to match, and the cloth did not use it
      // at all. `anchorY` already carries the rout dip, applied in `anchor`.
      const s = b.scale;
      // 3.2 m of sink buries a 3.15 m finial. It was 3.7 against a 4.09 m prop, which left
      // up to 0.39 m of aurochs horn standing in the grass after the standard had gone.
      this.tmpPos.set(b.anchorX, b.anchorY - (1 - b.presence) * 3.2, b.anchorZ);
      this.tmpScale.set(s, s, s);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(n, this.tmpMat);
      this.poleVariant.array[n] = b.faction === Faction.Rome ? 1 : 2;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.poleVariant.needsUpdate = true;
  }

  /**
   * Only the transmission term is fed from here now; everything else comes from the scene's
   * own lights, `scene.environment` and the cascades, exactly as it does for a soldier.
   *
   * `sunIntensity` is separate from `sunColour` and is the parameter this system used to
   * drop on the floor — `sky.sunColour` is a chromaticity and the magnitude lives in
   * `sky.sunIntensity`, so a banner lit from the colour alone stays at noon brightness at
   * every hour of the day. That is the whole of the "emissive sticker" reading, and it is
   * why the argument is not optional.
   */
  setLighting(sun: THREE.Vector3, sunColour: THREE.Color, sunIntensity: number): void {
    this.clothUniforms.uSunDir.value.copy(sun);
    this.clothUniforms.uSunRadiance.value.copy(sunColour).multiplyScalar(sunIntensity);
  }

  get count(): number {
    let n = 0;
    for (const b of this.banners) if (b.active) n++;
    return n;
  }

  /** Top of a unit's standard, for anyone who wants to hang a marker off it. */
  anchorOf(unitId: number, out: THREE.Vector3): boolean {
    const b = this.byUnit.get(unitId);
    if (!b || !b.active) return false;
    out.set(b.anchorX, b.anchorY + b.top, b.anchorZ);
    return true;
  }

  dispose(): void {
    this.clothGeo.dispose();
    this.clothMat.dispose();
    this.clothDepth.dispose();
    this.poleMesh.geometry.dispose();
    (this.poleMesh.material as THREE.Material).dispose();
    this.poleMesh.dispose();
    this.banners.length = 0;
    this.byUnit.clear();
  }
}
