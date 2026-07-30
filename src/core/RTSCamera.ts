import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep, wrapAngle } from '../util/math';
import type { Input } from './Input';

/**
 * Total War-style battle camera.
 *
 * Orbits a ground focus point. Zoom is not a simple radius change: as you pull in,
 * the pitch flattens and the FOV narrows, so close-ups sit at eye level among the
 * troops while the strategic view looks down from high above. That coupling is what
 * makes Total War's camera feel like a camera rather than a spreadsheet viewport.
 */

export interface CameraLimits {
  minZoom: number;
  maxZoom: number;
  minPitch: number;
  maxPitch: number;
  /** Half-extent of the playable area on X/Z; focus is clamped inside. */
  boundsX: number;
  boundsZ: number;
}

export class RTSCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Ground point the camera looks at. */
  readonly focus = new THREE.Vector3(0, 0, 0);
  /** Smoothed focus actually used for the view matrix. */
  private smoothFocus = new THREE.Vector3(0, 0, 0);

  /** 0 = fully zoomed in (eye level), 1 = fully out (strategic). */
  zoom = 0.62;
  private zoomTarget = 0.62;
  /** Compass yaw in radians. */
  yaw = Math.PI * 0.25;
  private yawTarget = Math.PI * 0.25;
  private pitch = 0.9;

  limits: CameraLimits = {
    minZoom: 3.2,
    maxZoom: 620,
    minPitch: 0.05,
    // ~59 degrees. Steeper than this stops reading as a camera and starts reading
    // as a map — Total War's battle cam tops out around here for the same reason.
    maxPitch: 1.03,
    boundsX: 1400,
    boundsZ: 1400,
  };

  /** Ground-height sampler installed by the terrain system so the camera never clips. */
  heightAt: ((x: number, z: number) => number) | null = null;

  /** Multiplier on pan speed; raised while shift is held. */
  panSpeed = 1;
  edgePanEnabled = true;
  private shakeAmp = 0;
  private shakeDecay = 3.2;
  private shakeTime = 0;
  private cinematic = false;

  /** Set true while an order is being dragged so the camera ignores LMB. */
  suppressDrag = false;

  private tmpV = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.35, 8000);
    this.camera.rotation.order = 'YXZ';
    this.smoothFocus.copy(this.focus);
    this.applyImmediate();
  }

  /** Distance from focus to eye for the current zoom, on an eased curve. */
  private get radius(): number {
    const t = smoothstep(this.zoom);
    // Exponential feel: fine control up close, sweeping movement far out.
    const { minZoom, maxZoom } = this.limits;
    return minZoom * Math.pow(maxZoom / minZoom, t);
  }

  private pitchForZoom(z: number): number {
    const { minPitch, maxPitch } = this.limits;
    // Flat and cinematic when close; steep and map-like when far. The >1 exponent
    // keeps the view low through the middle of the zoom range, which is where most
    // of the fighting is watched from, and only tips over near full zoom-out.
    return lerp(minPitch, maxPitch, Math.pow(smoothstep(z), 1.35));
  }

  private fovForZoom(z: number): number {
    // Narrower FOV up close reads as a telephoto "battle cam"; wide FOV far out
    // keeps the whole line of battle in frame.
    return lerp(32, 52, smoothstep(z));
  }

  /** Metres of pan per second of input at the current zoom. */
  private get panRate(): number {
    return lerp(11, 340, smoothstep(this.zoom)) * this.panSpeed;
  }

  setBounds(halfX: number, halfZ: number): void {
    this.limits.boundsX = halfX;
    this.limits.boundsZ = halfZ;
  }

  jumpTo(x: number, z: number, zoom = this.zoomTarget, yaw = this.yawTarget): void {
    this.focus.set(x, 0, z);
    this.smoothFocus.copy(this.focus);
    this.zoom = this.zoomTarget = clamp(zoom, 0, 1);
    this.yaw = this.yawTarget = yaw;
    this.applyImmediate();
  }

  /** Ease toward a viewpoint over the next few seconds (used for intro flythroughs). */
  flyTo(x: number, z: number, zoom: number, yaw: number): void {
    this.focus.set(x, 0, z);
    this.zoomTarget = clamp(zoom, 0, 1);
    this.yawTarget = yaw;
  }

  shake(amplitude: number, decay = 3.2): void {
    this.shakeAmp = Math.max(this.shakeAmp, amplitude);
    this.shakeDecay = decay;
  }

  setCinematic(on: boolean): void {
    this.cinematic = on;
  }

  update(dt: number, input: Input, viewW: number, viewH: number): void {
    if (!this.cinematic) this.handleInput(dt, input, viewW, viewH);

    // Clamp focus to the battlefield.
    const { boundsX, boundsZ } = this.limits;
    this.focus.x = clamp(this.focus.x, -boundsX, boundsX);
    this.focus.z = clamp(this.focus.z, -boundsZ, boundsZ);
    if (this.heightAt) this.focus.y = this.heightAt(this.focus.x, this.focus.z);

    // Critically-damped smoothing on everything the player drives.
    this.zoom = damp(this.zoom, this.zoomTarget, 11, dt);
    this.yaw = wrapAngle(this.yaw + wrapAngle(this.yawTarget - this.yaw) * (1 - Math.exp(-13 * dt)));
    this.smoothFocus.x = damp(this.smoothFocus.x, this.focus.x, 16, dt);
    this.smoothFocus.y = damp(this.smoothFocus.y, this.focus.y, 9, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, this.focus.z, 16, dt);

    this.pitch = this.pitchForZoom(this.zoom);
    this.camera.fov = this.fovForZoom(this.zoom);

    // Near/far track zoom to keep depth precision usable at both extremes.
    const r = this.radius;
    this.camera.near = clamp(r * 0.02, 0.08, 4);
    this.camera.far = clamp(r * 24 + 2600, 2600, 9000);
    this.camera.updateProjectionMatrix();

    this.place(r);

    if (this.shakeAmp > 0.0001) {
      this.shakeTime += dt;
      this.shakeAmp *= Math.exp(-this.shakeDecay * dt);
      const t = this.shakeTime;
      // Two incommensurate frequencies per axis so it never looks like a sine wave.
      const a = this.shakeAmp;
      this.camera.position.x += (Math.sin(t * 61.3) * 0.6 + Math.sin(t * 23.1) * 0.4) * a;
      this.camera.position.y += (Math.sin(t * 47.7) * 0.6 + Math.sin(t * 19.7) * 0.4) * a;
      this.camera.position.z += (Math.sin(t * 53.9) * 0.6 + Math.sin(t * 29.3) * 0.4) * a;
      this.camera.rotateZ(Math.sin(t * 37.1) * a * 0.012);
    }
  }

  private handleInput(dt: number, input: Input, viewW: number, viewH: number): void {
    this.panSpeed = input.shift ? 2.4 : 1;

    // ---- Zoom (wheel) ----
    if (input.wheel !== 0) {
      this.zoomTarget = clamp(this.zoomTarget + input.wheel * 0.075, 0, 1);
    }

    // ---- Rotate (RMB drag, or Q/E) ----
    const rmb = input.rmb;
    if (rmb.down && !this.suppressDrag) {
      this.yawTarget -= rmb.dx * 0.0055;
      // Vertical RMB drag nudges zoom, matching Total War's free-look feel.
      this.zoomTarget = clamp(this.zoomTarget + rmb.dy * 0.0016, 0, 1);
    }
    if (input.key('KeyQ')) this.yawTarget += dt * 1.35;
    if (input.key('KeyE')) this.yawTarget -= dt * 1.35;

    // ---- Pan (WASD / arrows / MMB drag / screen edge) ----
    let fx = 0;
    let fy = 0;
    if (input.key('KeyW') || input.key('ArrowUp')) fy += 1;
    if (input.key('KeyS') || input.key('ArrowDown')) fy -= 1;
    if (input.key('KeyA') || input.key('ArrowLeft')) fx -= 1;
    if (input.key('KeyD') || input.key('ArrowRight')) fx += 1;

    if (this.edgePanEnabled && input.hovering && !input.lmb.down) {
      const margin = 14;
      if (input.mouseX < margin) fx -= 1 - input.mouseX / margin;
      else if (input.mouseX > viewW - margin) fx += 1 - (viewW - input.mouseX) / margin;
      if (input.mouseY < margin) fy += 1 - input.mouseY / margin;
      else if (input.mouseY > viewH - margin) fy -= 1 - (viewH - input.mouseY) / margin;
    }

    const mmb = input.mmb;
    if (mmb.down) {
      const k = this.panRate * 0.0042;
      fx -= mmb.dx * k;
      fy -= mmb.dy * k;
    }

    if (fx !== 0 || fy !== 0) {
      const len = Math.hypot(fx, fy);
      if (len > 1) {
        fx /= len;
        fy /= len;
      }
      // Pan in the camera's ground plane, not world axes.
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      const rate = this.panRate * dt;
      this.focus.x += (fx * c - fy * s) * rate;
      this.focus.z += (fx * s + fy * c) * rate;
    }
  }

  /** Position the camera on its orbit and aim it at the focus. */
  private place(r: number): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const eyeX = this.smoothFocus.x - Math.sin(this.yaw) * cp * r;
    const eyeZ = this.smoothFocus.z - Math.cos(this.yaw) * cp * r;
    let eyeY = this.smoothFocus.y + sp * r;

    // Never let the eye sink into a hill.
    if (this.heightAt) {
      const ground = this.heightAt(eyeX, eyeZ);
      const minClear = lerp(1.7, 22, smoothstep(this.zoom));
      if (eyeY < ground + minClear) eyeY = ground + minClear;
    }

    this.camera.position.set(eyeX, eyeY, eyeZ);
    // Look slightly above the focus when close, so the horizon sits high in frame.
    this.tmpV.copy(this.smoothFocus);
    this.tmpV.y += lerp(1.55, 0, smoothstep(this.zoom));
    this.camera.lookAt(this.tmpV);
  }

  private applyImmediate(): void {
    this.pitch = this.pitchForZoom(this.zoom);
    this.camera.fov = this.fovForZoom(this.zoom);
    this.camera.updateProjectionMatrix();
    this.place(this.radius);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Metres of world per screen pixel at the focus plane — for LOD and picking radii. */
  metresPerPixel(viewH: number): number {
    const r = this.radius;
    return (2 * r * Math.tan((this.camera.fov * Math.PI) / 360)) / viewH;
  }

  get eyeHeightAboveFocus(): number {
    return this.camera.position.y - this.smoothFocus.y;
  }

  /** Current orbit distance — exposed for LOD decisions. */
  get orbitRadius(): number {
    return this.radius;
  }
}
