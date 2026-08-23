import { clamp } from '../util/math';

/**
 * What a subsystem says when it is asked why the battle is not running.
 *
 * Returned by a `ClockOwner`, which is whatever registered the hold or set the ceiling. Three
 * fields, and each of them answers a question the watchdog cannot answer for itself:
 *
 * - `held` — *are you still there?* A hold whose owner answers `false` is an **orphan**: the
 *   thing that stopped the clock no longer exists, no longer believes it stopped anything, or
 *   died part-way through releasing it. That is the bug class this whole mechanism is for, and
 *   `SimWatchdog` releases the hold and reports it rather than leaving the battle stopped.
 * - `expected` — *is this a normal state a player can see?* Deployment holds the clock and puts
 *   a plaque on screen saying so; a lockstep client waiting on its peer is *supposed* to stop
 *   ticking and the session strip says "waiting for the other player". Neither is a fault and
 *   neither may raise an alarm. `expected` is the owner's own answer because the owner is the
 *   only party that knows: `NetSession` can see whether the socket is open and whether packets
 *   are still arriving, and that is the difference between a peer who is thinking and a relay
 *   that is gone.
 * - `why` — one sentence, shown to the player and printed to the console.
 */
export interface ClockClaim {
  held: boolean;
  expected: boolean;
  why: string;
}

/** Asked once per second or so while the clock is stopped. Must not throw; must be cheap. */
export type ClockOwner = () => ClockClaim;

/**
 * The owner recorded for a bare `time.tickCeiling = n`.
 *
 * The plain assignment is kept working on purpose — `tools/qa-replay.mjs` and several probes
 * use it and there is no reason to make them worse — but a ceiling nobody signed is precisely
 * the shape of the fault, so it is named rather than left blank, and `SimWatchdog` treats it as
 * unexplained the moment it stops the battle for longer than a hitch.
 */
export const UNATTRIBUTED = '(unattributed)';

/**
 * Fixed-timestep clock with an accumulator.
 *
 * Simulation runs at a fixed 30 Hz so combat is deterministic and framerate-independent;
 * rendering runs as fast as the display allows and interpolates using `alpha`.
 * Game speed (pause / 1x / 2x / 4x, as in Total War) scales the accumulator input,
 * never the step size, so determinism holds at every speed.
 *
 * ## Every way of stopping this clock is owned, and the reason is a bug report
 *
 * "i was in middle of game and all the soldiers have frozen. idk why this happened", followed
 * by "now all animations are running but no characters are moving". The second sentence is the
 * diagnosis: animation playheads advance on `scaledDt` and positions come from the fixed step,
 * so a world that animates and does not move is a render loop in perfect health handing
 * `beginFrame` a frame and getting **zero steps** back. There are exactly three ways to make
 * that happen — the pause, a hold, and the tick ceiling — and until this pass two of them were
 * anonymous writes to a public field. A clock stopped by something that no longer exists looks
 * from the outside precisely like a clock stopped on purpose, and the game said nothing at all.
 *
 * So: `paused` stays the *player's* pause, a plain boolean the speed buttons and half the
 * probes in `tools/` write directly. Everything else has to say who it is — `hold(name, claim)`
 * for a subsystem that needs the battle stopped, `setCeiling(tick, owner)` for a driver or a
 * lockstep session that needs it bounded. `SimWatchdog` reads the ownership back out and is the
 * thing that finally makes a silent freeze impossible to ship.
 *
 * The arithmetic in `beginFrame` is untouched: `stopped` is `paused` when nothing is holding,
 * which is every frame of every battle the twenty-one pinned hashes were recorded from.
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
  /**
   * The **player's** pause, and nothing else's.
   *
   * Space, the pause button, and the dozen probes in `tools/` that stand the world still for a
   * screenshot. It stays a plain writable boolean for exactly those callers. A subsystem that
   * needs the battle stopped uses `hold` instead, because a subsystem can go away and the
   * player cannot.
   */
  paused = false;

  /**
   * Named holds on the clock. Empty in ordinary play; one entry during deployment.
   *
   * The value is the owner's own answer to "are you still holding, and is this normal" — see
   * `ClockClaim`. Held in a map rather than a counter so the *name* survives into the message
   * the player is shown, which is the whole difference between "the game has frozen" and
   * "deployment stopped the clock and never started it again".
   */
  private holds = new Map<string, ClockOwner>();

  /**
   * True when `beginFrame` will hand out no steps because somebody stopped the clock.
   *
   * The single expression the rest of the tree should ask. `paused` alone was the test in
   * `HudSystem`, `TopBar` and three places in `ReplaySystem`, and every one of them meant "is
   * the clock running" rather than "did the player press Space".
   */
  get stopped(): boolean {
    return this.paused || this.holds.size > 0;
  }

  /** True when a *subsystem* is holding the clock, whatever the player's pause is doing. */
  get held(): boolean {
    return this.holds.size > 0;
  }

  /**
   * Stop the clock, in this subsystem's name, until it says otherwise.
   *
   * Idempotent — a second hold under the same name replaces the claim rather than nesting.
   * Nesting was considered and refused: a depth counter turns "who is holding this" into a
   * number, and a number is exactly what the owner could not see when his battle froze.
   */
  hold(owner: string, claim: ClockOwner): void {
    this.holds.set(owner, claim);
  }

  /** Release a hold. Returns whether there was one. Safe to call twice; safe in a `finally`. */
  release(owner: string): boolean {
    return this.holds.delete(owner);
  }

  /** Who is holding the clock, for a message. */
  holders(): string[] {
    return [...this.holds.keys()];
  }

  /** Ask a holder whether it is still there and whether this is normal. */
  askHold(owner: string): ClockClaim | null {
    const c = this.holds.get(owner);
    if (!c) return null;
    // A claim that throws is a claim that cannot be trusted to say it has let go, so it is
    // reported as an unexplained hold rather than allowed to abort the watchdog.
    try { return c(); } catch (e) {
      return { held: true, expected: false, why: `its claim threw: ${String(e)}` };
    }
  }

  /**
   * Hard ceiling on `tick`. Negative disables it, and it is negative in normal play.
   *
   * This is the one lever a replay driver needs that the accumulator does not give it. A
   * frame can run up to `maxStepsPerFrame` ticks, so "advance until the sim has done exactly
   * N more ticks" is otherwise unanswerable — the last frame overshoots by up to four, and
   * four ticks of lateness is already a different battle. With a ceiling set, `beginFrame`
   * simply stops returning steps at that tick and the accumulator holds; clear it and the
   * battle carries on from precisely where it stopped.
   *
   * It also underwrites the gate's second arm. Driving a replay to an exact tick count means
   * the record and the replay can be run on deliberately different frame schedules and still
   * be compared bit for bit, which is what proves the record is keyed to the tick index and
   * not to the frame boundary it happened to be issued near.
   *
   * **And it is the thing that actually froze the owner's battle.** `NetSession` pins it at
   * join and re-pins it every frame at the last turn the relay authorised, which is correct and
   * is what makes two machines run one battle — right up until the relay goes away, at which
   * point the last value stands for ever with `paused` false and `gameSpeed` 1. Animations run,
   * nothing moves, and nothing on screen changes. So it is an accessor now: the plain field is
   * kept because `tools/qa-replay.mjs` and half a dozen probes assign to it, and every
   * assignment records **who** and **when** so `SimWatchdog` can name the holder or say that
   * there isn't one. See `setCeiling`.
   */
  get tickCeiling(): number { return this.ceiling; }
  set tickCeiling(v: number) { this.setCeiling(v, UNATTRIBUTED); }

  private ceiling = -1;
  private ceilingBy = '';
  /** `elapsed` when the ceiling last took a new value, so a message can say how long. */
  private ceilingAt = 0;
  private ceilingClaims = new Map<string, ClockOwner>();

  /**
   * Set the ceiling and say who set it.
   *
   * Writing the same value again is not a new ceiling: `NetSession.pace` re-asserts it on every
   * frame, and treating that as a fresh event would reset the age of a stall that has been
   * going on for a minute and hide exactly the case worth reporting.
   */
  setCeiling(v: number, owner: string): void {
    if (this.ceiling !== v) {
      this.ceiling = v;
      this.ceilingAt = this.elapsed;
    }
    this.ceilingBy = v < 0 ? '' : owner;
  }

  /**
   * Register, once, how an owner answers for a ceiling it sets.
   *
   * Separate from `setCeiling` because the ceiling is re-asserted every frame and a closure per
   * frame for a question asked once a second is a lot of garbage for nothing.
   */
  explainCeiling(owner: string, claim: ClockOwner): void {
    this.ceilingClaims.set(owner, claim);
  }

  /** Who set the current ceiling; `''` when there is none. */
  get ceilingOwner(): string { return this.ceilingBy; }
  /** Wall-clock seconds the current ceiling value has stood for. */
  get ceilingAge(): number { return this.elapsed - this.ceilingAt; }

  /** Ask the ceiling's owner whether this stop is normal. Null when nobody has said. */
  askCeiling(): ClockClaim | null {
    const c = this.ceilingClaims.get(this.ceilingBy);
    if (!c) return null;
    try { return c(); } catch (e) {
      return { held: true, expected: false, why: `its claim threw: ${String(e)}` };
    }
  }

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

    // `stopped`, not `paused`: a subsystem hold stops the clock exactly as the player's pause
    // does, and the two used to be the same boolean. The value is identical whenever nothing
    // is holding, which is every frame of every battle the pinned hashes were recorded from.
    const speed = this.stopped ? 0 : this.gameSpeed;
    this.scaledDt = this.frameDt * speed;
    this.accumulator += this.scaledDt;

    let steps = 0;
    // The ceiling is tested before the accumulator is spent, so time held back here is
    // still owed and is paid the moment the ceiling lifts.
    const room = this.tickCeiling < 0 ? Infinity : this.tickCeiling - this.tick;
    while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame && steps < room) {
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

  /**
   * Re-baseline the frame clock, keeping sub-tick accumulator debt.
   *
   * `resync` cannot be used for this: it also zeroes the accumulator, so calling it around
   * each synthetic run would make N short advances stop being equivalent to one long one,
   * and determinism checks compare exactly that.
   *
   * Pass a timestamp to continue the clock from it. Pass nothing to make the next frame a
   * zero-delta baseline, which is what the live rAF loop needs after synthetic timestamps
   * have been fed in — otherwise its first real `performance.now()` differences against a
   * synthetic value and lands on the 0.25 s clamp.
   */
  rebase(nowMs?: number): void {
    this.lastNow = nowMs === undefined ? -1 : nowMs / 1000;
  }
}
