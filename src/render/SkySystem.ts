import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';

/**
 * Sky dome, atmospheric scattering and image-based lighting.
 *
 * PROVISIONAL — the rendering agent replaces this with a Hosek–Wilkie / Preetham
 * physical sky, aerial-perspective fog matched to the sun, volumetric cloud layer and
 * a Poly Haven HDRI driving the IBL. Contracts other systems rely on:
 *   - `sunDirection` unit vector pointing from the ground toward the sun
 *   - `sunColour` / `ambientColour` linear-space light colours
 *   - `setTimeOfDay(hours)`
 */
export class SkySystem implements Subsystem {
  readonly name = 'sky';
  readonly order = -90;

  readonly sunDirection = new THREE.Vector3(0.42, 0.62, -0.66).normalize();
  readonly sunColour = new THREE.Color(1.0, 0.94, 0.82);
  readonly ambientColour = new THREE.Color(0.42, 0.5, 0.66);
  /** Hours past midnight, 0..24. */
  timeOfDay = 9.5;

  private dome?: THREE.Mesh;

  init(ctx: EngineContext): void {
    const geo = new THREE.SphereGeometry(4200, 48, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSun: { value: this.sunDirection },
        uHorizon: { value: new THREE.Color(0.72, 0.76, 0.80) },
        uZenith: { value: new THREE.Color(0.20, 0.38, 0.68) },
        uGround: { value: new THREE.Color(0.32, 0.30, 0.26) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun, uHorizon, uZenith, uGround;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          // Gradient from horizon haze to zenith blue, with a ground bounce below.
          vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
          sky = mix(uGround, sky, smoothstep(-0.06, 0.06, h));
          // Sun disc plus forward-scattered halo.
          float mu = clamp(dot(d, normalize(uSun)), 0.0, 1.0);
          sky += vec3(1.0, 0.86, 0.62) * pow(mu, 900.0) * 12.0;
          sky += vec3(1.0, 0.82, 0.60) * pow(mu, 8.0) * 0.28;
          gl_FragColor = vec4(sky, 1.0);
        }
      `,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.name = 'sky';
    ctx.scene.add(this.dome);

    ctx.scene.fog = new THREE.FogExp2(0xb9c2c9, 0.00055);
    this.setTimeOfDay(this.timeOfDay);
  }

  setTimeOfDay(hours: number): void {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    // Sun tracks an east-to-west arc; elevation peaks at local noon.
    const t = (this.timeOfDay - 6) / 12; // 0 at sunrise, 1 at sunset
    const elev = Math.sin(Math.max(0, Math.min(1, t)) * Math.PI) * 1.15;
    const azim = -Math.PI * 0.5 + t * Math.PI;
    this.sunDirection
      .set(Math.cos(elev) * Math.sin(azim), Math.sin(elev), Math.cos(elev) * Math.cos(azim))
      .normalize();
  }

  update(_dt: number, ctx: EngineContext): void {
    // Keep the dome centred on the camera so it never clips the far plane.
    if (this.dome) this.dome.position.copy(ctx.camera.position);
  }

  dispose(): void {
    this.dome?.geometry.dispose();
    (this.dome?.material as THREE.Material | undefined)?.dispose();
  }
}
