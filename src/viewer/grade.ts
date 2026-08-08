import * as THREE from 'three';
import { FS_VERT } from '../shaders/common.glsl';
import {
  MSAA_SAMPLES, TC_FINAL_FRAG, TC_TONE_GRADE_FRAG, tcFinalUniforms, tcToneGradeUniforms,
} from '../render/PostFX';

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
 * **This class used to carry a hand-copied mirror of `PostFX`'s two shader bodies, and the
 * copy drifted.** Of the five uniforms they shared, `uGrain` read 0.006 in `PostFX` and 0.016
 * here — the level measured to leave 0.00 % of a plate reading as a smooth region against a
 * Rome II reference of 7.09 %, so every isolated-model grade this project ever ran was shot
 * through a grain the product does not ship. `uSharpen` had the same class of error, mirroring
 * a default the original overwrites from the quality tier every frame. Both were corrected by
 * hand and the mirror was left in place; it is now gone. `TC_TONE_GRADE_FRAG`,
 * `TC_FINAL_FRAG` and the two uniform factories are the shipping renderer's own, imported.
 * The original argument for copying — that `src/render/` belongs to another workstream —
 * bought a divergence that cost three rounds of grading, which is the more expensive risk.
 *
 * Two deliberate departures remain and both are recorded rather than accidental. `uSharpen` is
 * pulled back to the tier value the game actually runs, and `uTime` is pinned at 0 so a plate
 * shot twice is the same file. A third is *unfixed and is the largest tonal divergence left*:
 * `uExposure` is 1 here and `PostFX` drives it from the sky preset, 1.42-5.1 in practice.
 * Closing it needs a sky, which is the same prerequisite as loading `LightingSystem`.
 *
 * What is deliberately **not** brought over: HBAO, contact shadows, aerial perspective, god rays,
 * bloom, depth of field, TAA and SMAA. Those are scene-scale effects with no meaning around
 * one man on an empty disc, and three of them need a depth buffer of a world that is not
 * there. The two that would matter — SMAA and MSAA — are handled by giving the scene target
 * real samples (see `Grade.resize`) rather than by porting a pass.
 */

/**
 * The deck must not be shot at one sample per pixel — aliasing is the leading separator
 * against the reference pool and one sample is its worst case. Read out of `PostFX`'s own
 * table rather than restated, for the same reason the shader bodies are now imported.
 */
const SAMPLES = MSAA_SAMPLES.ultra;

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
  /** 1x1 black, standing in for the bloom and god-ray inputs the viewer has none of. */
  private readonly black: THREE.DataTexture;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const make = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms, vertexShader: FS_VERT, fragmentShader: frag,
        depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
      });

    /**
     * The bloom and god-ray taps, wired to nothing.
     *
     * The shared tone body adds both before it tone maps, and neither has any meaning around
     * one man on an empty disc. A 1x1 black texture with the two strengths at zero makes the
     * two fetches an exact algebraic no-op, which is a smaller and far more checkable thing
     * than a second copy of the shader with the lines removed — the second copy is precisely
     * what this class used to be.
     */
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;

    this.mTone = make(TC_TONE_GRADE_FRAG, tcToneGradeUniforms());
    this.mTone.uniforms.tBloom.value = this.black;
    this.mTone.uniforms.tGod.value = this.black;
    this.mTone.uniforms.uBloom.value = 0;
    this.mTone.uniforms.uGodRays.value = 0;

    this.mFinal = make(TC_FINAL_FRAG, tcFinalUniforms());
    // 0.28, not the 0.32 the factory carries, because `PostFX` never runs its own default: it
    // sets `uSharpen` from the quality tier every frame, and ultra ships SMAA rather than TAA.
    // Running a default the original overwrites at runtime is the error that put the deck on
    // 0.016 of grain for three rounds, in a different uniform.
    this.mFinal.uniforms.uSharpen.value = 0.28;

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

  /**
   * Grain amplitude, for measuring what it costs.
   *
   * `PostFX` applies 0.016 of uniform hash noise to every pixel of the final image. On a
   * 32 px block that is enough on its own to put the block's Laplacian standard deviation
   * above 1.0 — which is the exact threshold the adversarial grader's strongest single
   * scalar uses. Worth being able to switch off and measure rather than argue about.
   */
  setGrain(v: number): void {
    (this.mFinal.uniforms.uGrain as { value: number }).value = v;
  }

  dispose(): void {
    this.black.dispose();
    this.sceneRT.dispose();
    this.ldrRT.dispose();
    this.mTone.dispose();
    this.mFinal.dispose();
    this.quad.geometry.dispose();
  }
}
