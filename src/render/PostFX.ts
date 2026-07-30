import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';

/**
 * Post-processing chain.
 *
 * PROVISIONAL — currently a straight pass-through so the engine renders correctly
 * before the render agent installs the real chain: depth prepass, HBAO, screen-space
 * shadows, bloom with lens dirt, volumetric god rays, DOF, motion blur, TAA, sharpen,
 * filmic grade + LUT, vignette and grain.
 *
 * Contract: when active, this system sets `engine.renderOverride` so it owns the
 * final present. Systems that need the depth buffer read `depthTexture`.
 */
export class PostFXSystem implements Subsystem {
  readonly name = 'postfx';
  readonly order = 900;

  /** Populated once a real chain with a depth prepass exists. */
  depthTexture: THREE.DepthTexture | null = null;
  enabled = false;

  init(ctx: EngineContext): void {
    // Pass-through: the engine's default render path is already correct.
    // Kept as a registered subsystem so the render agent has a stable slot to fill.
    void ctx;
  }

  resize(_w: number, _h: number, _ctx: EngineContext): void {}

  dispose(): void {
    this.depthTexture?.dispose();
  }
}
