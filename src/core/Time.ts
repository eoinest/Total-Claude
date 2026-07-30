import { clamp } from '../util/math';

/**
 * Fixed-timestep clock with an accumulator.
 *
 * Simulation runs at a fixed 30 Hz so combat is deterministic and framerate-independent;
 * rendering runs as fast as the display allows and interpolates using `alpha`.
 * Game speed (pause / 1x / 2x / 4x, as in Total War) scales the accumulator input,
 * never the step size, so determinism holds at every speed.
 */
export class Time {
  /** Seconds per simulation tick. 30 Hz. */
  readonly fixedDt = 1 / 30;

  /** Wall-clock seconds since start (unscaled). */
  elapsed = 0;
  /** Simulated seconds since start (scaled by gameSpeed, frozen while paused). */
  simTime = 0;
  /** Real seconds since the previous frame, clamped to avoid tunnelling after a stall. */
  frameDt = 0;
  /** Scaled seconds since the previous frame — what visual-only systems should use. */
  scaledDt = 0;
  /** Interpolation factor in [0,1) between the last two sim ticks. */
  alpha = 0;
  /** Sim ticks executed this frame (0..maxStepsPerFrame). */
  ticksThisFrame = 0;
  /** Total sim ticks since start — a stable integer for tick-rate-derived effects. */
  tick = 0;

  gameSpeed = 1;
  paused = false;

  /** Guard against the death spiral: if we fall behind, drop simulation time. */
  private maxStepsPerFrame = 5;
  private accumulator = 0;
  private lastNow = -1;

  private fpsAccum = 0;
  private fpsFrames = 0;
  /** Smoothed frames per second, updated ~4x/second. */
  fps = 0;
  /** Smoothed frame time in milliseconds. */
  frameMs = 0;

  /**
   * Advance the clock. Returns the number of fixed steps the caller should run.
   * @param nowMs high-resolution timestamp, typically from requestAnimationFrame
   */
  beginFrame(nowMs: number): number {
    const now = nowMs / 1000;
    if (this.lastNow < 0) this.lastNow = now;

    // Clamp: a long GC pause or a backgrounded tab must not teleport the battle.
    const raw = now - this.lastNow;
    this.lastNow = now;
    this.frameDt = clamp(raw, 0, 0.25);
    this.elapsed += this.frameDt;

    const speed = this.paused ? 0 : this.gameSpeed;
    this.scaledDt = this.frameDt * speed;
    this.accumulator += this.scaledDt;

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.fixedDt;
      steps++;
    }
    // Shed the backlog rather than accumulating an ever-growing debt.
    if (this.accumulator > this.fixedDt * this.maxStepsPerFrame) {
      this.accumulator = this.fixedDt * this.maxStepsPerFrame;
    }

    this.ticksThisFrame = steps;
    this.tick += steps;
    this.simTime += steps * this.fixedDt;
    this.alpha = this.accumulator / this.fixedDt;

    // FPS smoothing.
    this.fpsAccum += this.frameDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.25) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.frameMs = (this.fpsAccum / this.fpsFrames) * 1000;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    return steps;
  }

  setSpeed(s: number): void {
    this.gameSpeed = clamp(s, 0, 8);
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  /** Drop accumulated debt — call after a long load so the sim doesn't fast-forward. */
  resync(): void {
    this.accumulator = 0;
    this.lastNow = -1;
  }
}
