import type { ClockClaim, Time } from './Time';
import { UNATTRIBUTED } from './Time';

/**
 * The thing that notices the battle has stopped and says so.
 *
 * ## The report this exists because of
 *
 * > "i was in middle of game and all the soldiers have frozen. idk why this happened"
 * >
 * > "now all animations are running but no characters are moving"
 *
 * Both sentences are true at once and together they name the failure exactly. Animation
 * playheads advance on `time.scaledDt` in `UnitRenderSystem.advancePlayheads`; positions come
 * out of `fixedUpdate`. A world that animates and does not move is therefore a **render loop in
 * perfect health** handing `Time.beginFrame` a frame and getting zero steps back, for as long
 * as anyone cares to watch.
 *
 * The game produced no error, no message and no indication of any kind. The top bar showed
 * `1x`. The debug line — which is hidden unless you press L — showed `1x t+4s` and went on
 * showing it. The owner had to be *told* what to press. Reproduced deliberately
 * (`tools/scratch/freeze-net.mjs`, and the `frozen-*` arms of `tools/qa-freeze.mjs`): a
 * lockstep client whose relay disappears sits at `tick 105, ceiling 105, paused false,
 * scaledDt 0.0083` until the tab is closed.
 *
 * A watchdog is the part of this that generalises. The specific cause was fixed in
 * `NetLink`/`NetSession`; the *class* — a clock stopped by something that is no longer there —
 * cannot be fixed once, so instead it is made impossible to ship silently.
 *
 * ## What it watches
 *
 * `time.tick` against wall clock, and nothing else. Wall clock is summed from `time.frameDt`
 * rather than read from `performance.now()`, which matters twice: `frameDt` is clamped at
 * 0.25 s, so a backgrounded tab cannot accumulate an hour of "stall" while no frame runs, and
 * it is zero when no frame runs at all, so a stopped rAF loop is silent instead of screaming.
 *
 * ## What it deliberately ignores, and how it tells them apart
 *
 * A stopped simulation is not the same thing as a broken one. Three legitimate stops:
 *
 * 1. **The player paused.** `time.paused`, the pause button lit, and Space undoes it.
 * 2. **A subsystem is holding the clock on purpose.** Deployment does, for as long as the
 *    player takes to lay out an army, and there is a plaque on screen saying so.
 * 3. **A lockstep client is waiting for its peer.** This is the sharp one, and getting it
 *    wrong turns a safety net into a false alarm in every match: a client sitting on its
 *    `tickCeiling` between turn packets is *doing lockstep correctly*, and at a 100 ms turn on
 *    a real link it spends most of its wall clock there.
 *
 * The watchdog does not try to judge any of these itself. It asks the owner, through
 * `ClockClaim`, and the owner answers with a fact rather than a timer. `NetSession` says
 * `expected` while the socket is open **and** frames are still arriving from the relay, and
 * `stuck` the moment either stops being true — which is a statement about the transport, not
 * about how long somebody has been thinking. That is why a peer who takes thirty seconds over
 * a move raises nothing and a relay that died two seconds ago raises everything.
 *
 * The three cases it *does* report:
 *
 * - **Orphaned.** A hold whose owner answers `held: false`. The thing that stopped the clock
 *   is gone, or threw part-way through letting go. This is the only case that is *repaired* as
 *   well as reported: the hold is released and the battle carries on, because a hold nobody
 *   claims has no authority to stop anything. Everything else is reported and left alone.
 * - **Unexplained.** A ceiling or a hold with no registered owner, or an owner that says
 *   `expected: false`. Named, with the owner's own sentence.
 * - **Nothing at all.** The clock is not stopped, no ceiling is in the way, and the sim is
 *   still not moving — `gameSpeed` at zero, or an accumulator that never fills. Reported with
 *   the raw numbers, because at that point the honest thing is to hand over the readings.
 *
 * A fourth thing it reports and does not detect: a subsystem whose `fixedUpdate` throws. That
 * arrives through `fault()` from `Engine.frame`, because `tick` keeps advancing in that case
 * and no clock-watcher can see it. Same banner, same console line, same reason for existing.
 *
 * ## Why it owns its own DOM
 *
 * Nine lines of inline style on an element appended to `document.body`, not a HUD panel. The
 * failures worth announcing include "a subsystem threw", and `HudSystem` is a subsystem. A
 * warning that needs the rest of the interface to be healthy is a warning that will be missing
 * on the day it is needed.
 */

/** How long the sim may be still, in *rendered* wall-clock seconds, before this looks. */
const GRACE_S = 1.5;
/**
 * And how long it may be still **with nobody accounting for it** before that is said out loud.
 *
 * A second timer rather than a second threshold on the first one, and it is the fix for the
 * only false positive this watchdog has ever produced. Measured on its first run: coming *out*
 * of a legitimate stop fires it. Deployment holds the clock for four seconds, `commitInner`
 * releases the hold, and for the thirty milliseconds it takes the accumulator to fill there is
 * a battle that has not ticked for four seconds with nothing holding it — which is exactly the
 * shape of the fault, and is not the fault. The same thing happens on the frame after Space.
 *
 * So the clock that decides whether to shout only runs while the stop is *unexplained*, and it
 * is reset the moment anybody accounts for it. A stop that is owned throughout costs nothing;
 * one that becomes unowned has to stay that way for a second and a half to be worth saying.
 */
const UNEXPLAINED_S = 1.5;
/** Diagnose at 4 Hz rather than per frame. A headless page runs this loop at ~1,000 fps. */
const CHECK_S = 0.25;
/**
 * How long a stop the owner calls normal may last before the console gets a note.
 *
 * Not the screen. A legitimate wait is legitimate however long it runs — a player can leave a
 * deployment plaque up over lunch — so putting it on screen would be the false alarm this file
 * spends four paragraphs avoiding. But a lockstep client that has been waiting thirty seconds
 * is worth a line in the log for whoever reads it afterwards, and that costs nobody anything.
 */
const LONG_WAIT_S = 30;
/** Re-state a live complaint at this interval, so a log opened later still shows it. */
const RESTATE_S = 20;
/** How long a notice for a fault that has already repaired itself stays on screen. */
const STICKY_S = 12;

export type StallKind = 'orphaned' | 'unexplained' | 'unowned' | 'fault';

export interface StallReport {
  kind: StallKind;
  /** Who, in as much detail as is available. */
  owner: string;
  /** The sentence a player reads. */
  why: string;
  /** Seconds the simulation has been still. Zero for a fault, which does not stop the clock. */
  stillFor: number;
  tick: number;
  /**
   * Occurrences. For a `fault` this is how many times the system threw, which is the number
   * that says whether it was a one-off or the battle's permanent condition. For a stall it is
   * how many times the complaint has been printed — once, plus a restatement every 20 s.
   */
  count: number;
}

interface FrameSource {
  /** True while the engine is running synthetic frames; nothing here applies to those. */
  advancing: boolean;
  /** True while the rAF loop is live. A stopped loop is not a frozen game. */
  running: boolean;
}

export class SimWatchdog {
  /** Every distinct thing it has complained about, newest last. Read by the gates. */
  readonly reports: StallReport[] = [];
  /** Turn the banner off without turning the detection off. `tools/shoot.mjs` may want this. */
  showBanner = true;

  private time: Time;
  /** Rendered wall-clock seconds since `tick` last moved. */
  private stillFor = 0;
  /** …of which this many with nobody accounting for it. See `UNEXPLAINED_S`. */
  private unexplainedFor = 0;
  private sinceCheck = 0;
  private lastTick = -1;
  /** Key of the complaint currently on screen, so it is stated once and then updated. */
  private liveKey = '';
  private liveKind: StallKind | '' = '';
  private lastRestate = 0;
  /** `elapsed` before which the banner may not be taken down. See `STICKY_S`. */
  private stickyUntil = 0;
  private longNoted = false;
  private banner: HTMLElement | null = null;
  private faults = new Map<string, StallReport>();

  constructor(time: Time) {
    this.time = time;
  }

  /**
   * One frame's worth of watching. Called at the end of `Engine.frame`.
   *
   * Cheap on the overwhelmingly common path: one integer compare and two adds.
   */
  observe(src: FrameSource): void {
    // Synthetic frames have no wall clock worth the name and `advanceTicks` parks the sim on a
    // ceiling *by design*. A watchdog that fired there would fire in every gate in `tools/`.
    if (src.advancing || !src.running) { this.settle(); return; }
    const t = this.time;
    if (t.tick !== this.lastTick) {
      this.lastTick = t.tick;
      this.settle();
      return;
    }
    this.stillFor += t.frameDt;
    this.sinceCheck += t.frameDt;
    if (this.stillFor < GRACE_S || this.sinceCheck < CHECK_S) return;
    const dt = this.sinceCheck;
    this.sinceCheck = 0;
    this.diagnose(dt);
  }

  /** The battle is moving again (or was never being watched). Forget the stall, keep faults. */
  private settle(): void {
    this.stillFor = 0;
    this.unexplainedFor = 0;
    this.sinceCheck = 0;
    this.longNoted = false;
    // A fault banner is not a stall banner: the sim ticking again does not mean a system that
    // threw has stopped throwing, and taking that notice down would be the silence all over.
    if (this.liveKey && this.liveKind !== 'fault') this.clear();
  }

  /**
   * A subsystem threw. Reported once by (where, system, message) and counted thereafter.
   *
   * Counted rather than re-reported because a `fixedUpdate` that throws throws thirty times a
   * second, and a console with nine hundred identical stacks in it is a console with the
   * signal buried in it. The count is on the banner, which is the number that says whether
   * this is a one-off or the battle's permanent condition.
   */
  fault(where: string, system: string, err: unknown): StallReport {
    const message = err instanceof Error ? err.message : String(err);
    const key = `${where}|${system}|${message}`;
    const seen = this.faults.get(key);
    if (seen) {
      seen.count++;
      // Keep the banner's number current without re-rendering it thirty times a second.
      if (seen.count % 30 === 0 && this.liveKey === key) this.paint(seen);
      return seen;
    }
    const rep: StallReport = {
      kind: 'fault', owner: system, stillFor: 0, tick: this.time.tick, count: 1,
      why: `${system}.${where} threw: ${message}`,
    };
    this.faults.set(key, rep);
    this.reports.push(rep);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[watchdog] ${rep.why}`, stack ?? '');
    this.liveKey = key;
    this.liveKind = 'fault';
    this.lastRestate = this.time.elapsed;
    this.paint(rep);
    return rep;
  }

  // -------------------------------------------------------------------------

  private diagnose(dt: number): void {
    const t = this.time;

    /*
     * Holds first, because a hold is the one case that can be *repaired*.
     *
     * `commitInner` used to set `active = false` before `paused = false` with a live recorder
     * wrapper in between; a throw anywhere in the middle left the clock stopped by a phase that
     * reported itself over. That specific hole is now closed with a `finally`, but the class is
     * not closeable by inspection — the next hold will be written by somebody who has not read
     * this file — so an owner that no longer claims its hold loses it.
     */
    for (const name of t.holders()) {
      const claim = t.askHold(name);
      if (claim && claim.held) continue;
      t.release(name);
      this.raise(`orphaned|${name}`, {
        kind: 'orphaned', owner: name, stillFor: this.stillFor, tick: t.tick, count: 1,
        why: claim
          ? `'${name}' stopped the clock and no longer claims it (${claim.why}) — released`
          : `'${name}' stopped the clock and vanished without releasing it — released`,
      });
      // The clock is free again; the next frame will tick and clear this on its own.
      return;
    }

    const reasons: { owner: string; claim: ClockClaim }[] = [];
    if (t.paused) {
      reasons.push({
        owner: 'player',
        claim: { held: true, expected: true, why: 'the game is paused — press Space' },
      });
    }
    for (const name of t.holders()) {
      const claim = t.askHold(name);
      if (claim) reasons.push({ owner: name, claim });
    }
    // A ceiling only stops anything once the sim has reached it.
    if (t.tickCeiling >= 0 && t.tick >= t.tickCeiling) {
      const owner = t.ceilingOwner || UNATTRIBUTED;
      const claim = t.askCeiling() ?? {
        held: true,
        expected: false,
        why: `a tick ceiling of ${t.tickCeiling} was set by ${owner} `
          + `${t.ceilingAge.toFixed(0)} s ago and never cleared`,
      };
      reasons.push({ owner: `ceiling:${owner}`, claim });
    }

    const bad = reasons.filter((r) => !r.claim.expected);
    if (reasons.length && !bad.length) {
      /*
       * Every stop is one somebody has taken responsibility for and can point at on screen.
       * The unexplained clock goes back to zero, which is what stops the *end* of a legitimate
       * stop from looking like the start of a fault — see `UNEXPLAINED_S`.
       */
      this.unexplainedFor = 0;
      if (this.liveKey && this.liveKind !== 'fault') this.clear();
      if (this.stillFor > LONG_WAIT_S && !this.longNoted) {
        this.longNoted = true;
        console.info(`[watchdog] the simulation has been stopped for `
          + `${this.stillFor.toFixed(0)} s, and that is expected: `
          + reasons.map((r) => `${r.owner} — ${r.claim.why}`).join('; '));
      }
      return;
    }

    this.unexplainedFor += dt;
    if (this.unexplainedFor < UNEXPLAINED_S) return;

    if (!reasons.length) {
      /*
       * Nothing is holding, nothing is paused, no ceiling is in the way, and the sim is still
       * not moving. There is no diagnosis left to offer, so the readings are the report:
       * `gameSpeed` at zero and a `scaledDt` that never fills the accumulator are the two
       * shapes this takes, and both are unreachable through the interface.
       */
      this.raise('unowned', {
        kind: 'unowned', owner: '(nobody)', stillFor: this.stillFor, tick: t.tick, count: 1,
        why: `the simulation has not run a tick in ${this.stillFor.toFixed(1)} s and nothing `
          + `is holding the clock (speed ${t.gameSpeed}, scaledDt ${t.scaledDt.toFixed(4)}, `
          + `tick ${t.tick})`,
      });
      return;
    }

    this.raise(`unexplained|${bad.map((r) => r.owner).join(',')}`, {
      kind: 'unexplained',
      owner: bad.map((r) => r.owner).join(', '),
      stillFor: this.stillFor,
      tick: t.tick,
      count: 1,
      why: bad.map((r) => r.claim.why).join('; '),
    });
  }

  /**
   * State a complaint once, then keep its numbers current.
   *
   * `key` is supplied by the caller and deliberately carries **no measurement in it**. The
   * first version keyed on the whole sentence, and the sentence has a duration and a `scaledDt`
   * in it, so every frame minted a "new" complaint: one stuck ceiling produced four console
   * errors and four entries in `reports` in as many seconds. A stall is one event however long
   * it lasts.
   */
  private raise(key: string, rep: StallReport): void {
    const now = this.time.elapsed;
    if (this.liveKey === key) {
      const live = this.reports[this.reports.length - 1];
      if (live) { live.stillFor = rep.stillFor; live.why = rep.why; }
      if (now - this.lastRestate > RESTATE_S) {
        this.lastRestate = now;
        if (live) live.count++;
        console.error(`[watchdog] still stopped after ${rep.stillFor.toFixed(0)} s: ${rep.why}`);
      }
      if (live) this.paint(live);
      return;
    }
    this.liveKey = key;
    this.liveKind = rep.kind;
    this.lastRestate = now;
    this.reports.push(rep);
    /*
     * An orphaned hold repairs itself, so its notice has to outlive the repair.
     *
     * Without this the battle resumes on the next frame, `settle` takes the banner down, and
     * the only person who ever learns that the game froze and un-froze itself is whoever had
     * the console open — which is the failure this whole file is about, in miniature.
     */
    if (rep.kind === 'orphaned') this.stickyUntil = now + STICKY_S;
    console.error(rep.kind === 'orphaned'
      ? `[watchdog] the clock was being held by nothing: ${rep.why}`
      : `[watchdog] the simulation has stopped and nothing owns the stop: ${rep.why}`);
    this.paint(rep);
  }

  private clear(): void {
    if (this.time.elapsed < this.stickyUntil) return;
    this.liveKey = '';
    this.liveKind = '';
    if (this.banner) this.banner.style.display = 'none';
  }

  private paint(rep: StallReport): void {
    if (!this.showBanner || typeof document === 'undefined') return;
    const el = this.ensureBanner();
    if (!el) return;
    const head = rep.kind === 'fault'
      ? 'A SUBSYSTEM FAILED'
      : rep.kind === 'orphaned' ? 'THE CLOCK WAS STOPPED BY NOTHING — RELEASED'
        : 'THE SIMULATION HAS STOPPED';
    const tail = rep.kind === 'fault'
      ? (rep.count > 1
        ? `${rep.count} times since tick ${rep.tick}. The battle is still drawing; it is no `
          + 'longer being simulated correctly.'
        : `at tick ${rep.tick}. The battle is still drawing; it is no longer being simulated `
          + 'correctly.')
      : rep.kind === 'orphaned'
        ? 'The battle should now carry on. This is a bug — please say what you were doing.'
        : `Nothing has moved for ${rep.stillFor.toFixed(0)} s (tick ${rep.tick}). `
          + 'The picture is alive; the battle is not.';
    el.innerHTML = `<b>${head}</b><span>${escapeHtml(rep.why)}</span><i>${tail}</i>`;
    el.style.display = '';
  }

  private ensureBanner(): HTMLElement | null {
    if (this.banner) return this.banner;
    if (typeof document === 'undefined' || !document.body) return null;
    const el = document.createElement('div');
    el.dataset.tcWatchdog = '1';
    el.setAttribute('role', 'alert');
    // Inline, because this has to work on a page whose stylesheet-owning subsystem is the
    // thing that broke, and it has to sit above every panel in the HUD.
    el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);'
      + 'z-index:9999;max-width:min(760px,92vw);padding:10px 16px;pointer-events:none;'
      + 'display:flex;flex-direction:column;gap:3px;text-align:center;'
      + 'border:1px solid #e2564b;border-radius:2px;background:#1a0b08f2;color:#f0d9c8;'
      + 'font:500 12.5px/1.45 ui-serif,Georgia,serif;'
      + 'box-shadow:0 6px 28px #000a';
    document.body.append(el);
    this.banner = el;
    return el;
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
