import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { SkySystem } from './SkySystem';

/**
 * Sun, sky fill and shadows.
 *
 * PROVISIONAL — the rendering agent replaces the single directional shadow with
 * proper cascaded shadow maps (4 splits, stabilised texel snapping, slope-scaled
 * bias) plus a bounce-light rig. Contract: `sun` is the scene's primary
 * `DirectionalLight` and its shadow camera must cover the visible battlefield.
 */
export class LightingSystem implements Subsystem {
  readonly name = 'lighting';
  readonly order = -80;

  readonly sun = new THREE.DirectionalLight(0xfff2dc, 3.1);
  readonly fill = new THREE.HemisphereLight(0x9dbcdc, 0x54503c, 0.85);
  private sky?: SkySystem;
  private target = new THREE.Object3D();

  init(ctx: EngineContext): void {
    this.sky = ctx.tryGet<SkySystem>('sky');

    const q = ctx.quality;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    // A single tight cascade around the camera focus reads far better than one huge
    // map spanning the whole 2.8 km field.
    const extent = 190;
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 1200;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.2;

    ctx.scene.add(this.target);
    this.sun.target = this.target;
    ctx.scene.add(this.sun);
    ctx.scene.add(this.fill);
  }

  preRender(ctx: EngineContext): void {
    const dir = this.sky?.sunDirection ?? new THREE.Vector3(0.4, 0.7, -0.6);
    if (this.sky) {
      this.sun.color.copy(this.sky.sunColour);
      this.fill.color.copy(this.sky.ambientColour);
    }
    // Follow the camera focus so shadow resolution is always spent where the player looks.
    const f = ctx.rig.focus;
    this.target.position.set(f.x, f.y, f.z);
    this.sun.position.set(f.x + dir.x * 420, f.y + dir.y * 420, f.z + dir.z * 420);

    // Snap to shadow-map texel grid to stop shimmer while panning.
    const cam = this.sun.shadow.camera;
    const texel = ((cam.right - cam.left) / ctx.quality.shadowMapSize) * 2;
    this.sun.position.x = Math.round(this.sun.position.x / texel) * texel;
    this.sun.position.z = Math.round(this.sun.position.z / texel) * texel;
  }

  dispose(): void {
    this.sun.dispose();
    this.fill.dispose();
  }
}
