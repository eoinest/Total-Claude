import * as THREE from 'three';
import { AGX_GLSL, FS_VERT, HASH_GLSL, SRGB_GLSL } from '../shaders/common.glsl';

/**
 * The game's output chain, brought into the viewer.
 *
 * **The viewer was not showing the game's picture, and this is the largest single error the
 * isolated-model harness has turned up.** `Engine.ts:155` sets `AgXToneMapping` on the
 * renderer, and the viewer copied that line — but the moment `PostFXSystem` is registered it
 * sets `renderer.toneMapping = NoToneMapping` (`PostFX.ts:179`) and does the transform itself
 * with three stages the bare renderer path has none of:
 *
 *   1. a **scene-linear contrast power law** about a 0.16 pivot at exponent 1.8, which
 *      `PostFX.ts:877-891` documents as the only knob that turns a 6:1 frame into the ~18:1
 *      a Rome II frame measures — AgX alone cannot, because it has already fixed the ratio;
 *   2. a **black point and a mid-tone S-curve**, because AgX on its own "lands an outdoor
 *      scene entirely between 0.3 and 0.7 with no black point, which reads as milky";
 *   3. a **warm/cool split** across a display-referred luminance crossover, which is the
 *      statistic the blind rounds actually separate the decks on.
 *
 * So every model screenshot taken from `/viewer.html` before this existed was a model graded
 * under a tone curve the product does not ship, in the direction that makes it look worst:
 * milky, low contrast, desaturated. A grader shown one of those frames would have reported a
 * flat, plasticky soldier and been right about the frame and wrong about the model.
 *
 * The transform below is a **mirror of `PostFX.ts:850-985` (tone + grade) and
 * `PostFX.ts:1093-1140` (CAS sharpen + vignette + grain)**, with the same uniform defaults.
 * Mirroring rather than importing is deliberate: `src/render/` belongs to another workstream
 * and this is a dev tool, so a copy that can go stale is a smaller risk than an edit to the
 * shipping renderer. It is worth exporting the two shader bodies from `PostFX` and deleting
 * this duplicate — that is a recommendation in the report, not something done here.
 *
 * What is deliberately **not** mirrored: HBAO, contact shadows, aerial perspective, god rays,
 * bloom, depth of field, TAA and SMAA. Those are scene-scale effects with no meaning around
 * one man on an empty disc, and three of them need a depth buffer of a world that is not
 * there. The two that would matter — SMAA and MSAA — are handled by giving the scene target
 * real samples (see `Grade.resize`) rather than by porting a pass.
 */

/** Matches `MSAA_SAMPLES.ultra` in `PostFX.ts:84`. The deck must not be shot at 1 sample. */
const SAMPLES = 4;

const TONE_FRAG = AGX_GLSL + SRGB_GLSL + HASH_GLSL + /* glsl */ `
uniform sampler2D tSrc;
uniform float uExposure;
uniform vec4 uGrade;        // x S-curve blend, y black point, z shadow sat, w highlight sat
uniform vec3 uContrast;     // x exponent, y pivot (render units), z veiling pedestal
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec2 uSplit_disp;   // DISPLAY-referred; see the convention note beside tcLuma
uniform vec2 uShoulder;     // x knee, y strength
varying vec2 vUv;

void main() {
  vec3 hdr = texture2D( tSrc, vUv ).rgb;

  float y0 = max( tcLuma( hdr ), 1e-6 );
  float y1 = uContrast.y * pow( y0 / uContrast.y, uContrast.x );
  hdr *= y1 / y0;
  hdr += uContrast.z;

  vec3 c = tcAgX( hdr, uExposure );

  c = max( vec3( 0.0 ), c - uGrade.y ) / max( 1e-3, 1.0 - uGrade.y );
  c = mix( c, c * c * ( 3.0 - 2.0 * c ), uGrade.x );

  float l = tcLuma( c );
  float split = smoothstep( uSplit_disp.x, uSplit_disp.y, tcLinearToSRGB( vec3( l ) ).r );
  c *= mix( uShadowTint, uHighlightTint, split );
  float sat = mix( uGrade.z, uGrade.w, split );
  c = mix( vec3( l ), c, sat );
  c = max( c, vec3( 0.0 ) );

  vec3 over = max( c - uShoulder.x, vec3( 0.0 ) );
  c = min( c, vec3( uShoulder.x ) ) + over / ( 1.0 + over * uShoulder.y );

  gl_FragColor = vec4( tcLinearToSRGB( c ), 1.0 );
}
`;

const FINAL_FRAG = HASH_GLSL + /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uSharpen;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec3 e  = texture2D( tSrc, vUv ).rgb;
  vec3 n  = texture2D( tSrc, vUv + vec2( 0.0, -uTexel.y ) ).rgb;
  vec3 s  = texture2D( tSrc, vUv + vec2( 0.0, uTexel.y ) ).rgb;
  vec3 w  = texture2D( tSrc, vUv + vec2( -uTexel.x, 0.0 ) ).rgb;
  vec3 ee = texture2D( tSrc, vUv + vec2( uTexel.x, 0.0 ) ).rgb;

  vec3 mn = min( e, min( min( n, s ), min( w, ee ) ) );
  vec3 mx = max( e, max( max( n, s ), max( w, ee ) ) );
  vec3 amp = sqrt( clamp( min( mn, 1.0 - mx ) / max( mx, 1e-4 ), 0.0, 1.0 ) );
  vec3 k = amp * ( -1.0 / mix( 8.0, 5.0, clamp( uSharpen, 0.0, 1.0 ) ) );
  vec3 c = ( e + ( n + s + w + ee ) * k ) / ( 1.0 + 4.0 * k );
  c = clamp( c, 0.0, 1.0 );

  vec2 q = ( vUv - 0.5 ) * 2.0;
  c *= 1.0 - uVignette * pow( clamp( length( q ) * 0.72, 0.0, 1.0 ), 2.6 );

  float g = tcHash12( gl_FragCoord.xy + uTime ) - 0.5;
  c += g * uGrain * ( 1.0 - tcLuma( c ) * 0.75 );

  gl_FragColor = vec4( c, 1.0 );
}
`;

export class Grade {
  /** Off by default: inspection wants the raw material, a comparison plate wants the game. */
  enabled = false;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly quad: THREE.Mesh;
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();
  private readonly mTone: THREE.ShaderMaterial;
  private readonly mFinal: THREE.ShaderMaterial;
  private sceneRT: THREE.WebGLRenderTarget;
  private ldrRT: THREE.WebGLRenderTarget;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const make = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms, vertexShader: FS_VERT, fragmentShader: frag,
        depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
      });

    this.mTone = make(TONE_FRAG, {
      tSrc: { value: null },
      uExposure: { value: 1 },
      uGrade: { value: new THREE.Vector4(0.42, 0.006, 1.02, 1.3) },
      uContrast: { value: new THREE.Vector3(1.8, 0.16, 0.0026) },
      uShadowTint: { value: new THREE.Vector3(0.9, 0.96, 1.18) },
      uHighlightTint: { value: new THREE.Vector3(1.18, 0.985, 0.82) },
      uSplit_disp: { value: new THREE.Vector2(0.05, 0.48) },
      uShoulder: { value: new THREE.Vector2(0.92, 1.7) },
    });
    this.mFinal = make(FINAL_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uSharpen: { value: 0.32 },
      uVignette: { value: 0.2 },
      uGrain: { value: 0.016 },
      uTime: { value: 0 },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mTone);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.sceneRT = this.makeRT(2, 2, true);
    this.ldrRT = this.makeRT(2, 2, false);
  }

  private makeRT(w: number, h: number, hdr: boolean): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: hdr,
      stencilBuffer: false,
      // Only the HDR scene target can carry samples: everything after it is a fullscreen
      // blit, and multisampling a blit costs four times the bandwidth for an identical image.
      samples: hdr ? SAMPLES : 0,
    });
    rt.texture.generateMipmaps = false;
    return rt;
  }

  resize(w: number, h: number, dpr: number): void {
    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));
    this.sceneRT.setSize(pw, ph);
    this.ldrRT.setSize(pw, ph);
    (this.mFinal.uniforms.uTexel.value as THREE.Vector2).set(1 / pw, 1 / ph);
  }

  /**
   * Render the scene through the game's transform.
   *
   * The renderer's own tone mapping is turned **off** for the scene pass and back on
   * afterwards, exactly as `PostFX` does, because AgX applied twice is not AgX.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    const prevTone = r.toneMapping;
    const prevTarget = r.getRenderTarget();
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    this.mTone.uniforms.tSrc.value = this.sceneRT.texture;
    this.quad.material = this.mTone;
    r.setRenderTarget(this.ldrRT);
    r.clear();
    r.render(this.scene, this.cam);

    this.mFinal.uniforms.tSrc.value = this.ldrRT.texture;
    // Deterministic grain: a plate shot twice must be the same file, and the battle harness
    // has already been caught comparing two runs that differed on 50-70% of pixels from
    // per-session reseeding.
    this.mFinal.uniforms.uTime.value = 0;
    this.quad.material = this.mFinal;
    r.setRenderTarget(prevTarget);
    r.clear();
    r.render(this.scene, this.cam);

    r.toneMapping = prevTone;
  }

  dispose(): void {
    this.sceneRT.dispose();
    this.ldrRT.dispose();
    this.mTone.dispose();
    this.mFinal.dispose();
    this.quad.geometry.dispose();
  }
}
