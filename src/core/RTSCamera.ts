import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep, wrapAngle } from '../util/math';
import type { Input, PointerState } from './Input';

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

/**
 * The city, as the camera rig uses it: one query, and it returns a number.
 *
 * Declared here so `src/core/seamTypes.ts` can assert that `CitySystem` really satisfies it
 * and `src/core/seams.ts` can call it at boot. Both halves are needed and neither replaces
 * the other — a name that drifts is a compile error in the first, and a query that is present
 * and answers `-Infinity` over its own wall-walk is a boot-time fault in the second. That
 * second failure is the one this project keeps shipping: present, called, `?.`-guarded, inert.
 */
export interface CameraSurfaceView {
  /**
   * Absolute Y of the topmost surface a body could stand on, or `-Infinity` where none.
   *
   * `fromY` is the level the caller is currently standing at, and it decides which surface a
   * footprint with two of them answers with — a gatehouse crown over its own carriageway is
   * the one on both circuits. Omit it and the highest wins.
   */
  walkableTopAt(x: number, z: number, fromY?: number): number;
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

  /**
   * The top of the *walkable* masonry at a point, or `-Infinity` where there is none.
   * Installed by `CitySystem.init`; null on a map with no city, and on every headless rig.
   *
   * This is the whole of the wall-walk fix. `heightAt` is the heightfield — bare earth — so
   * standing on Carthage's wall-walk 13.8 m up, `place()` read the ground at the *foot* of the
   * wall and put the eye 1.7 m above that: 12.1 m under the walkway, inside the stone, aimed
   * at a look-at point twelve metres over its own head. Measured at 7dd9616 on both circuits.
   *
   * Deliberately **not** `CitySystem.masonryTopAt`, which is the missile-collision surface: in
   * the battlement band that answers merlon crest or crenel sill, two metres over the walk and
   * alternating every 2.7 m along the run, and over the gatehouse it answers the merlon line's
   * crown rather than the roof behind it. A camera that stood on those would ride a 2 m square
   * wave along every parapet on the map. See `CitySystem.walkableTopAt`.
   */
  walkableTopAt: ((x: number, z: number, fromY?: number) => number) | null = null;

  /**
   * How far the surface the focus is standing on rises above the bare earth under it.
   *
   * **Zero everywhere on open ground, and that is the whole of the safety argument.** At
   * `standLift === 0` every expression that reads it below is character-for-character the one
   * that shipped, evaluated against `heightAt` alone — so the field cases, the graded deck and
   * the opening camera cannot move. It leaves zero only where the city says there is a walkable
   * surface over the earth: a wall-walk, a stair rake, a tower's internal flight, a gatehouse
   * crown, the pour on a bare footing.
   *
   * It is the *lift* rather than the absolute surface because the lift is the only part that
   * steps. The earth is continuous in x and z and needs no help; a parapet line is a cliff, and
   * 27 m of it crossed in one frame is not a camera move. So the bound lives here and nowhere
   * else, and `smoothFocus.y`'s own damp — which has to track terrain at 340 m/s of pan — is
   * left exactly as it was.
   */
  private standLift = 0;

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
  private tmpDir = new THREE.Vector3();

  /**
   * Cap on how much further one vertical drag pixel may travel than a horizontal one.
   *
   * A screen-vertical pixel covers `1 / sin(pitch)` times as much ground as a horizontal
   * one, because the ray is oblique to the ground: 1.17 looking down at the 59-degree
   * limit, 2.07 at the zoom most of a battle is watched from, and 21 at the eye-level end,
   * where the view is 2.7 degrees off horizontal and the ground under the cursor is 34 m
   * away. Honouring that exactly is what "the ground stays under the cursor" means, and it
   * is unusable at the flat end — the factor is unbounded as the view nears the horizon, so
   * a twitch would throw the focus across the map. Three keeps the gesture faithful across
   * the zooms where the correction is small and stops short of the singularity.
   */
  private readonly dragForwardGain = 3;

  /**
   * Bound on how fast `standLift` may move, as a multiple of the orbit radius per second.
   *
   * A screen-space statement rather than a world one, because "this is a cut, not a move" is a
   * statement about the frame and not about metres: the 13.77 m Carthage's wall-walk stands
   * over its own footing is four times the eye-level orbit of 3.2 m and a sixteenth of the
   * strategic 226 m. A fixed metres-per-second that reads as a controlled descent at the near
   * end reads as a stall at the far end, where the same step is a few pixels.
   *
   * At the eye-level orbit these work out at 16 m/s down and 29 m/s up: Carthage's wall in
   * 0.86 s and 0.48 s, Rome's tallest curtain in twice that. Faster up than down on purpose —
   * the eye is *inside masonry* while it climbs, and only over open air while it falls.
   *
   * Neither binds on anything continuous, which is the test that matters. Walking a stair at
   * the eye-level pan rate of 11 m/s changes the lift at 6.3 m/s on Carthage's 23.9 m flight;
   * crossing a tower changes it at 2.4 m/s; walking into the new ditch is the earth moving and
   * not the lift at all, so it is not bounded here and reads exactly as it did before.
   */
  private readonly liftFallGain = 5;
  private readonly liftRiseGain = 9;

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
    /*
     * Sample the ground here rather than parking the focus at y=0.
     *
     * This set `y` to 0 — sea level — and then copied that into `smoothFocus`, so a "jump"
     * landed the focus *under* the terrain and `update` spent the next second floating it
     * back up: line ~153 re-reads `heightAt` every frame and `smoothFocus.y` damps toward it
     * at rate 9. On a 40 m ridge the eye is still 4 m low a quarter-second after the jump
     * (1 - e^-2.25 = 89.5% converged) and only settles after ~0.8 s.
     *
     * Two things that cost real time trace back to this. The screenshot harness treats
     * `setCamera` as instant and then measures frame cost across 31 frames — which were
     * being rendered through a still-climbing camera, moving the framing between plates
     * that are supposed to be identical and polluting the TAA history it waits on. And the
     * player sees it on every load: `main.ts` calls `jumpTo` once at boot, so the battle
     * opens with an unrequested upward swoop.
     *
     * `heightAt` is installed by TerrainSystem during `initAll`, before any caller reaches
     * here; the fallback keeps a headless or terrain-less rig working.
     */
    const ground = this.heightAt ? this.heightAt(x, z) : 0;
    /*
     * Adopted rather than eased, and both halves of that matter.
     *
     * A jump onto the wall — the minimap, a garrison unit card, the shot harness's
     * `setCamera` — has to land *on* the walkway in the frame it is asked for. Letting
     * `update` ramp the lift into place instead would restore this method's own defect one
     * storey up: an unrequested climb over the second after every jump, and a screenshot
     * harness that treats `setCamera` as instant measuring 31 frames through a still-moving
     * camera.
     */
    this.standLift = this.liftAt(x, z, ground);
    this.focus.set(x, ground + this.standLift, z);
    this.smoothFocus.copy(this.focus);
    this.zoom = this.zoomTarget = clamp(zoom, 0, 1);
    this.yaw = this.yawTarget = yaw;
    this.applyImmediate();
  }

  /** Turn the view. The HUD compass drives this; Q/E are the keyboard equivalent. */
  rotateBy(radians: number): void {
    this.yawTarget = wrapAngle(this.yawTarget + radians);
  }

  /** Look north, keeping focus and zoom. North is -Z, and `place` puts that at yaw = pi. */
  faceNorth(): void {
    this.yawTarget = Math.PI;
  }

  /**
   * Ease toward a viewpoint over the next few seconds (used for intro flythroughs).
   *
   * Samples the ground for the same reason `jumpTo` does, though against a smaller fault:
   * this one leaves `smoothFocus` alone deliberately — the ease *is* the damp — so it never
   * produced `jumpTo`'s swoop, and `update` re-derives `focus.y` from `heightAt` on the very
   * next frame anyway. What it did leave is a window between the call and that frame in
   * which `focus.y` reads as sea level, which is the sort of thing only the first caller
   * ever finds. There is no caller today; that is why it is worth closing now.
   */
  flyTo(x: number, z: number, zoom: number, yaw: number): void {
    const ground = this.heightAt ? this.heightAt(x, z) : 0;
    this.standLift = this.liftAt(x, z, ground);
    this.focus.set(x, ground + this.standLift, z);
    this.zoomTarget = clamp(zoom, 0, 1);
    this.yawTarget = yaw;
  }

  /**
   * Global scale on every incoming shake request.
   *
   * The effects system asks for amplitudes calibrated to a single dramatic impact, but a
   * battle fires `cameraShake` continuously — every cavalry charge and every line clash —
   * and `Math.max` means they never cancel, they only ever raise. The result reads as a
   * permanently unsteady camera rather than as impacts. Scaling here rather than at each
   * call site keeps one place to tune, and leaves the relative weight of a cavalry charge
   * against a shield crash intact.
   */
  shakeScale = 0.35;
  /** Ceiling on accumulated amplitude, in metres of eye displacement. */
  private readonly shakeMax = 0.34;

  shake(amplitude: number, decay = 3.2): void {
    this.shakeAmp = Math.min(this.shakeMax, Math.max(this.shakeAmp, amplitude * this.shakeScale));
    // Decay faster than requested as well: a shake that lingers past the impact that
    // caused it stops reading as cause and effect.
    this.shakeDecay = Math.max(decay, 4.5);
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
    /*
     * The surface under the focus: the earth, plus whatever the city has standing on it.
     *
     * `this.radius` is read here off *last* frame's zoom, a few frames' worth of the wheel out
     * of date, which is immaterial to a rate bound and saves reordering the damps below around
     * a term that is zero on open ground.
     */
    if (this.heightAt) {
      const ground = this.heightAt(this.focus.x, this.focus.z);
      // The storey the focus is on, so a gatehouse answers with its crown to a camera
      // walking the wall and with its road to one marching through the arch.
      const lift = this.liftAt(this.focus.x, this.focus.z, ground, ground + this.standLift);
      const r0 = this.radius;
      const step = lift - this.standLift;
      const cap = (step > 0 ? this.liftRiseGain : this.liftFallGain) * r0 * dt;
      this.standLift += clamp(step, -cap, cap);
      this.focus.y = ground + this.standLift;
    }

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

    // ---- Rate pan (WASD / arrows / screen edge) ----
    //
    // These say "keep going that way", so the distance covered is speed x time and `dt`
    // belongs in it. The diagonal normalisation below belongs to them too: without it
    // W+D would cover panRate * sqrt(2) and a diagonal would outrun a cardinal.
    let fx = 0;
    let fy = 0;
    if (input.key('KeyW') || input.key('ArrowUp')) fy += 1;
    if (input.key('KeyS') || input.key('ArrowDown')) fy -= 1;
    if (input.key('KeyA') || input.key('ArrowLeft')) fx -= 1;
    if (input.key('KeyD') || input.key('ArrowRight')) fx += 1;

    // `pointerSeen` as well as `hovering`: see the note on `pointerenter` in Input.ts. Without
    // it the camera edge-pans from a default cursor position of 0,0 — the top-left corner —
    // the instant the canvas reports a hover, which the pre-battle menu closing does.
    if (this.edgePanEnabled && input.hovering && input.pointerSeen && !input.lmb.down) {
      const margin = 14;
      if (input.mouseX < margin) fx -= 1 - input.mouseX / margin;
      else if (input.mouseX > viewW - margin) fx += 1 - (viewW - input.mouseX) / margin;
      if (input.mouseY < margin) fy += 1 - input.mouseY / margin;
      else if (input.mouseY > viewH - margin) fy -= 1 - (viewH - input.mouseY) / margin;
    }

    if (fx !== 0 || fy !== 0) {
      const len = Math.hypot(fx, fy);
      if (len > 1) {
        fx /= len;
        fy /= len;
      }
      const rate = this.panRate * dt;
      this.panGround(fx * rate, fy * rate);
    }

    // ---- Drag pan (middle button) ----
    //
    // A drag is a *displacement* gesture, not a rate one. The player has already said how
    // far by moving the cursor that far, so neither `dt` nor `panRate` may appear in the
    // answer: the ground under the cursor should stay under the cursor however the frame
    // rate happens to fall. That matters more since the adaptive-quality controller landed,
    // because it deliberately varies frame time.
    //
    // This used to be folded into the rate accumulator above as `mmb.dx * panRate * 0.0042`,
    // which at the default zoom reaches the length clamp at 1.2 px of travel per frame — so
    // every real drag saturated at length 1, the cursor delta was thrown away, and the pan
    // came out as `panRate * dt`. Measured on one fixed 300 px scripted drag with the frame
    // duration swept and nothing else changed: **16.7 m at 144 fps against 160.1 m at 15
    // fps**, a constant 200.1 m/s in every row. Held instead at a constant *elapsed time*
    // the answer was 80.04 m at every frame rate from 15 to 120 — which is the proof that it
    // was integrating the clock and had stopped reading the cursor at all.
    //
    // The vertical axis was inverted against the horizontal one as well: `fy -= mmb.dy * k`
    // pushed the camera backwards as the cursor came down, so a world point ran away from
    // the hand on one axis while following it on the other.
    //
    // Shift no longer speeds this up. `panSpeed` scales a rate; there is no rate here, and
    // a 1:1 gesture that moves 2.4x the cursor is not a 1:1 gesture.
    const mmb = input.mmb;
    if (mmb.down && (mmb.dx !== 0 || mmb.dy !== 0)) this.dragPan(mmb, viewW, viewH);
  }

  /**
   * Slide the focus `right` metres across the view and `fwd` metres into it.
   *
   * Panning happens in the camera's ground plane, not on world axes. `place()` puts the eye
   * at focus - (sin yaw, cos yaw) * r, so the view direction — screen "up" projected onto
   * the ground — is forward = +(sin yaw, cos yaw).
   *
   * Screen-right is NOT the naive perpendicular (cos yaw, -sin yaw). Three's camera basis is
   * right-handed with x = right, y = up, z = -forward, so it must satisfy right x up =
   * -forward, which gives right = (-cos yaw, sin yaw) — the negation of the naive form.
   * Getting this wrong inverts A and D at every heading while leaving W and S correct, which
   * is exactly how it was reported.
   *
   * `direct` carries the same step straight into the smoothed focus. A rate gesture wants
   * the 16/s damp; a drag must not have it. The damp is a fixed ~60 ms of *time* lag, so it
   * would leave the ground trailing the cursor by however far the hand moved in 60 ms —
   * frame-rate independent, but still not direct manipulation. It stays on for everything
   * else, and the difference between the two focuses is untouched, so `update`'s damp keeps
   * converging exactly as before.
   */
  private panGround(right: number, fwd: number, direct = false): void {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const dx = fwd * s - right * c;
    const dz = fwd * c + right * s;
    this.focus.x += dx;
    this.focus.z += dz;
    if (direct) {
      this.smoothFocus.x += dx;
      this.smoothFocus.z += dz;
    }
  }

  /**
   * Slide the focus so the ground under the cursor stays under the cursor.
   *
   * A closed form rather than a raycast, and a *difference of two ground points* rather
   * than a per-pixel rate. The difference is what makes it frame-count independent: the
   * steps telescope, so twelve frames of 25 px and sixty frames of 5 px land in the same
   * place. A rate — even one evaluated at the cursor's own position, which is the exact
   * derivative — is a first-order integrator, and its error would grow as the frame rate
   * fell. That is the same class of defect this replaces, only smaller.
   *
   * With the eye `h` above the plane through the focus, the camera's own pitch P, and a
   * screen offset (u, v) from the centre in tangent units (u right, v up), the ray
   * `f + u R + v U` meets that plane at
   *
   *     t = h / (sinP - v cosP)
   *     ground = t * ((cosP + v sinP) * forward + u * right)      [horizontal, from the eye]
   *
   * R is horizontal because the camera carries no roll, which is why `u` never enters the
   * denominator and why a horizontal drag is *exactly* linear in pixels at any screen row.
   *
   * P is read off the placed camera, not off `pitch`: `place` lifts the eye to clear the
   * ground and aims a little above the focus when close, so at the near end of the zoom the
   * orbit's nominal 0.05 rad and the camera's real angle differ tenfold.
   *
   * Two clamps, both against the horizon, where `t` and its v-derivative are unbounded: the
   * range under the cursor may not exceed `dragForwardGain` times the range on the view
   * axis, and one vertical pixel may not outrun one horizontal pixel by more than the same
   * factor. Neither binds at the zooms a battle is watched from — over a full-height drag at
   * zoom 0.55 the true forward gain runs 1.3 to 2.0 against a cap of 3.
   */
  private dragPan(mmb: PointerState, viewW: number, viewH: number): void {
    const h = this.camera.position.y - this.smoothFocus.y;
    const sinP = -this.camera.getWorldDirection(this.tmpDir).y;
    if (h <= 0.05 || sinP <= 1e-3) return;
    const cosP = Math.hypot(this.tmpDir.x, this.tmpDir.z);
    // Pixels to tangent units. Both axes divide by viewH: NDC x is scaled by the aspect
    // ratio on the way out, and aspect = viewW / viewH cancels the viewW.
    const k = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / viewH;
    // `x - dx` is where this button was last frame. It is only that because `Input` tracks
    // dx per button; while one shared cursor fed all three, this would have been wherever
    // the mouse was before the press.
    const u0 = (mmb.x - mmb.dx - viewW * 0.5) * k;
    const u1 = (mmb.x - viewW * 0.5) * k;
    const v0 = (viewH * 0.5 - (mmb.y - mmb.dy)) * k;
    const v1 = (viewH * 0.5 - mmb.y) * k;
    const denMin = sinP / this.dragForwardGain;
    const t0 = h / Math.max(sinP - v0 * cosP, denMin);
    const t1 = h / Math.max(sinP - v1 * cosP, denMin);
    const maxFwd = this.dragForwardGain * Math.max(t0, t1) * Math.abs(v0 - v1);
    const fwd = t0 * (cosP + v0 * sinP) - t1 * (cosP + v1 * sinP);
    this.panGround(t0 * u0 - t1 * u1, clamp(fwd, -maxFwd, maxFwd), true);
  }

  /**
   * How far the walkable surface at a point stands above the earth there, or 0.
   *
   * `-Infinity` is the city's answer for "no masonry here", so the comparison and not a
   * subtraction is what keeps `NaN` out of the camera. There is one other thing this guards:
   * a `footing` bay's pour stands a hand's breadth over the turf at its low end, and calling
   * that a wall would switch the eye's floor on for nothing — but it is honestly a step up
   * onto concrete, so it is left in rather than filtered by a threshold that would then have
   * to be defended against the ditch, the glacis and the berm.
   */
  private liftAt(x: number, z: number, ground: number, fromY?: number): number {
    if (!this.walkableTopAt) return 0;
    const top = this.walkableTopAt(x, z, fromY);
    return top > ground ? top - ground : 0;
  }

  /** Position the camera on its orbit and aim it at the focus. */
  private place(r: number): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const eyeX = this.smoothFocus.x - Math.sin(this.yaw) * cp * r;
    const eyeZ = this.smoothFocus.z - Math.cos(this.yaw) * cp * r;
    let eyeY = this.smoothFocus.y + sp * r;

    /*
     * Never let the eye sink into a hill — and, since the city started answering for its own
     * masonry, never let it sink into a wall either.
     *
     * At the eye-level end this clamp is not a safety net, it *is* the mechanism: the orbit
     * puts the eye 0.16 m above the focus at zoom 0 and the clamp raises it to 1.7 m, which is
     * the soldier's eye line the whole feature is named after. So a walk resolved from bare
     * earth does not merely clip — it pins the eye 12 m *below* the walkway the focus is
     * standing on and aims it at a look-at point over its own head, which is exactly what
     * standing on Carthage's parapet used to look like.
     *
     * `standLift` is the lift under the *focus*, not under the eye, and that is deliberate
     * twice over. It keeps the view level: the eye ends up `minClear` over the surface the
     * camera is looking at, so walking a stair reads as walking a stair rather than as the
     * horizon sawing up and down. And it takes the step out of the eye's own term: the eye
     * trails the focus by 3.19 m at this zoom, so a floor sampled at the eye would cross the
     * parapet line a third of a second before or after the focus did and cut twice.
     *
     * On open ground `standLift` is 0 and this is the clamp that shipped.
     */
    if (this.heightAt) {
      const ground = this.heightAt(eyeX, eyeZ);
      const minClear = lerp(1.7, 22, smoothstep(this.zoom));
      const floor = ground + this.standLift + minClear;
      if (eyeY < floor) eyeY = floor;
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
