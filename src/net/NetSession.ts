import type { EngineContext, QualityTier, Subsystem } from '../core/Engine';
import type { BattleConfig } from '../sim/battleConfig';
import type { BattleSystem } from '../sim/BattleSystem';
import type { NetSink, ReplayMark, ReplayRecord, ReplaySystem } from '../sim/replay';
import { stateHashes, unitDigests } from '../sim/stateHash';
import type { Link } from './link';
import {
  HASH_EVERY, libmPrint, TICKS_PER_TURN, turnTick,
  type BootPrint, type MsgTurn, type RelayMsg,
} from './protocol';

/**
 * Deterministic lockstep over a relay, on the client.
 *
 * ## The shape, and why it is lockstep rather than rollback
 *
 * `docs/MULTIPLAYER.md` §4.4 rules out rollback and gives the right reason: not the tick cost
 * (3.4 ms, not the 11.06 ms one pass published — that figure is a whole frame) but that
 * rollback needs a snapshot *and* a restore every frame, and §1.8 measured those at 9–14 ms
 * and 4–7 ms. That is a 33 ms budget gone twice over before any re-simulation. It is also the
 * reason that would not change if the simulation got faster, which is the test of a good one.
 *
 * What is left is lockstep with an input delay, and this codebase is unusually ready for it:
 * the simulation is a pure function of `(config, seed, tick index)` — proved four separate
 * ways and most strongly by `tools/qa-replay.mjs`, which replays a 6,783-tick battle carrying
 * real recorded player input bit-identically at five ticks a frame and at one tick every two
 * frames — and `src/sim/replay.ts` already stamps every player order with an execution tick
 * and quantises its coordinates at the moment it is issued.
 *
 * So the netcode is small. It is three rules:
 *
 * 1. **Nothing this client does reaches the simulation until it has been round-tripped.**
 *    `ReplaySystem` in `net` mode diverts every order, every siege-machine command and every
 *    deployment verb to the relay, and applies only what comes back in a turn packet.
 * 2. **The client may not simulate past the last turn it has.** `Time.tickCeiling` — which
 *    exists for the replay gate — is set to `turnTick(readyTurn + 1)` every frame. A missing
 *    packet stalls the battle; it never lets it guess. **And a stall has to end.** Rule 2 is
 *    correct and it is also the thing that froze the owner's battle: with the relay gone the
 *    last authorised ceiling stood for ever, `paused` false and `gameSpeed` 1, so the world
 *    animated and nothing moved and nothing said why. `linkFault` is the missing half — the
 *    socket having closed, or the relay's own ten-a-second turn packets having stopped — and it
 *    ends the match through `onEnd` exactly as a relay-sent `end` does. `Time.explainCeiling`
 *    is the other half: this session tells `SimWatchdog`, in its own words, whether the stop it
 *    is imposing right now is a lockstep wait or a fault, so the watchdog can be loud about the
 *    second without ever being loud about the first.
 * 3. **Wall clock is a pacing device and nothing else.** It decides how fast this client is
 *    allowed to *catch up*, through `time.gameSpeed`, which scales the accumulator and never
 *    the step. `docs/MULTIPLAYER.md` §1.10 lists "pause and speed are raw writes to the clock"
 *    as a defect because two machines pressing 2× at different moments run different tick
 *    counts for the same wall clock — which is exactly true, and exactly harmless here,
 *    because the tick count is not this client's to decide.
 *
 * ## What this file does *not* do, deliberately
 *
 * There is no client-side prediction of any kind, not even cosmetic. A move order does not
 * show a marker until the relay has stamped it. The reason is §3's warning about the
 * commonest form of dishonest netcode: an acknowledgement that the input has been accepted,
 * followed by a battle in which it was not. At 200 ms of delay a marker that appears when the
 * order actually lands is a truthful interface; one that appears instantly is a lie about
 * three frames in five. If that turns out to feel bad in play, the honest fix is a distinct
 * "sent" state on the marker, not a predicted one — see §9.4.
 */

/** What the UI needs to draw a status line. Nothing in the protocol depends on this shape. */
export interface NetStatus {
  phase: 'connecting' | 'lobby' | 'deploy' | 'battle' | 'over';
  slot: number;
  room: string;
  peer: string;
  myFaction: number;
  turn: number;
  behindTicks: number;
  stalls: number;
  stalledMs: number;
  rttMs: number;
  delayTicks: number;
  message: string;
  ended: string;
  /**
   * The tick the match stopped at, or -1 while it is still running.
   *
   * The field has existed since the relay pass and was **not in this readout**, which is how
   * `qa-p2p`'s `leave-halts-at-a-stated-tick` came to assert `ended.endedAtTick >= 0` against
   * `undefined`: a check that could never go green, printing *"the session reports its last
   * agreed tick as undefined"* beside a screen that says *"The last tick both battles agreed on
   * was 180"*. The number was in the sentence and nowhere a program could read it. The third
   * guarantee is that a match ends **attributed to a tick**, so the tick belongs here.
   */
  endedAtTick: number;
  /**
   * Frames in and out on this client's socket.
   *
   * In the readout because a lockstep client that has stopped can have stopped for two very
   * different reasons — nothing arriving, or something arriving that it has not got round to —
   * and nothing else on screen distinguishes them. It earned its place: a cross-engine arm
   * reported a correctly-detected divergence as a failure, and the question that resolved it
   * was "did the slow client receive the message at all".
   */
  got: number;
  sent: number;
  /** The highest tick this client is authorised to reach, and the turn that authorised it. */
  ceiling: number;
  readyTurn: number;
  /**
   * The tick this client announced itself from. Must be 0; see `BootPrint.tick0`.
   *
   * Published so a gate can assert the invariant instead of trusting it. "Both clients are
   * ready" does not mean "both clients are at the same tick", and the difference is invisible
   * from outside the page.
   */
  tick0: number;
}

/** A desync, as this client saw it. Every field is in the panel and in the gate's JSON. */
export interface DesyncReport {
  tick: number;
  layer: string;
  mine: string;
  theirs: string;
  lastAgreedTick: number;
  units: number[];
  note: string;
}

/**
 * The fastest this client may run to close a gap. `Time.setSpeed` clamps at 8 and so does this.
 *
 * It is a *rate*, not a step: `Time.beginFrame` scales the accumulator and still hands out
 * whole 1/30 s ticks capped at `maxStepsPerFrame = 5` a frame, so 8× is the same ticks sooner.
 * The real ceiling is that cap — five ticks a frame at 60 fps is 300 ticks a second, ten times
 * real time — and at 3.4 ms a tick that is already the whole main thread. Anything past this
 * is not catching up, it is a second stall wearing a hat, which is why `maxLagTurns` exists.
 */
const MAX_CATCHUP_SPEED = 8;
/** Rolling window of per-unit digests, so a desync at tick T can still be answered for. */
const DIGEST_HISTORY = 12;
/**
 * How many checkpoints are kept for a gate to read back. 4,096 is about 68 simulated minutes.
 *
 * They exist because of what a gate can otherwise *not* do in a peer-to-peer session. Under a
 * relay a harness brings two clients to a common tick by stopping the relay process, and then
 * compares `stateHashes` on both pages. There is no process to stop between two peers, and two
 * pages read a fifth of a second apart are two pages several ticks apart — measured while
 * writing this: host at tick 853 and guest at 854, every exchanged checkpoint agreeing, and a
 * naive comparison calling that a divergence.
 *
 * The right comparison is *at a tick*, and this is the record of them: each client's own hashes,
 * computed locally at ticks 30, 60, 90 …, which a harness can intersect and compare bit for bit.
 * It is a stronger claim than a settled tick rather than a weaker one — twenty-eight agreements
 * across a battle instead of one — and it cannot be satisfied by the instrument getting lucky.
 *
 * Four numbers each, so 4,096 of them is about 150 kB. Read-only, and nothing in the simulation
 * may touch it; it is the same category of thing as `latencies()`.
 */
const MARK_HISTORY = 4096;
/**
 * How long the simulation must be held at its ceiling before that counts as a stall.
 *
 * One and a half turns of *simulated* time. Derived from `TICKS_PER_TURN` and not from the
 * relay's wall-clock turn length, so it means the same thing when a gate runs the relay at five
 * times speed to reach t+300 inside a minute.
 */
const STALL_MS = (TICKS_PER_TURN / 30) * 1000 * 1.5;
/**
 * Silence from the relay that stops being a hitch and starts being a dead link.
 *
 * The relay's turn scheduler is a wall clock: `Room.tick` closes every turn whose deadline has
 * passed and emits a packet to both slots, `turnMs` apart — 100 ms by default — regardless of
 * what either client is doing. Ten packets a second, unconditionally. So six seconds of total
 * silence is roughly **sixty consecutive missed turns**, which is not a slow peer and is not
 * jitter; the peer's speed does not enter into it, because the peer is not what sends this.
 *
 * **"Unconditionally" was false in one phase, and that is the bug this constant caused.** The
 * lobby closes no turns, so a host waiting alone for a challenger received nothing after
 * `welcome`, `NetLink.gapMs` stayed at 0, the threshold below collapsed to this floor and the
 * match ended with `linkLost` at exactly 6.0 s — socket open, relay running, nothing wrong.
 * `Room.LOBBY_BEAT_MS` sends a `ping` a second in that phase, so the sentence above is now true
 * in every phase rather than in three of the four, and this floor measures what it says.
 *
 * It exists at all because `onclose` is not guaranteed. A laptop that sleeps and a wireless
 * link that drops both leave a half-open TCP connection whose browser-side `WebSocket` sits in
 * `readyState 1` until something times out, and that is exactly the shape of "I was in the
 * middle of a game and everything froze".
 *
 * **In rendered seconds, not in `performance.now()`, and that distinction cost `qa-net` an arm.**
 * The first version differenced wall clock against the last inbound frame, and on a machine
 * running three determinism gates at once it ended a perfectly healthy match with `linkLost`
 * mid-desync-test. Nothing was wrong with the socket: `onmessage` runs on the page's main
 * thread, so a main thread that is blocked cannot *receive* a packet that has already arrived,
 * and six seconds of blocked thread read identically to six seconds of dead relay.
 *
 * `Time.frameDt` cannot tell that lie. It is clamped at 0.25 s and it only advances on a frame
 * that ran, so a stalled page contributes a quarter of a second to this total however long it
 * was stalled, and a page that is drawing normally contributes real time. The same reasoning
 * `SimWatchdog` uses for the same reason.
 */
const LINK_SILENT_S = 6;

export class NetSession implements Subsystem {
  readonly name = 'net';
  /**
   * Ahead of `ReplaySystem` (5), which is ahead of `BattleSystem` (10).
   *
   * `order` decides `update` order and `init` order, and this only needs the second: it must
   * resolve `replay` and attach to it before anything else has a chance to issue an order.
   */
  readonly order = 4;

  phase: NetStatus['phase'] = 'connecting';
  /** Faction this client's player commands. The other slot's is the other one. */
  myFaction = 0;
  factions: number[] = [];
  desync: DesyncReport | null = null;
  ended = '';
  endedAtTick = -1;
  message = '';

  private ctx!: EngineContext;
  private battle!: BattleSystem;
  private replay!: ReplaySystem;
  private link: Link;
  private cfg: BattleConfig;
  private quality: QualityTier;
  private deployPhase: boolean;

  /** Highest battle turn whose packet has arrived. -1 until the first one. */
  private readyTurn = -1;
  private lastMarkTick = -1;
  private digests: { tick: number; d: [number, string][] }[] = [];
  /** Every checkpoint this client computed, for a gate to compare tick by tick. */
  private marks: { tick: number; hash: string; uf64: string; uctl: string; alive: number }[] = [];
  /** Sent ops awaiting their turn packet, for the input-delay measurement. */
  private inFlight = new Map<string, { at: number; tick: number }>();
  private lat: { rttMs: number; delayTicks: number }[] = [];
  private stalls = 0;
  private stalledMs = 0;
  private stallSince = 0;
  /** When this client first ran out of authorised ticks. Not yet a stall; see `STALL_MS`. */
  private waitingSince = 0;
  /** Rendered seconds since an inbound frame last arrived. See `LINK_SILENT_S`. */
  private quietFor = 0;
  private lastGot = -1;
  private perturbed = -1;
  /** The tick this client was on when it announced. -1 until `announce` runs. */
  private tick0 = -1;
  /**
   * Whether the verdict in `ended` was inferred here or sent by the relay. See `onEnd`.
   *
   * Only two things can end a match locally — `linkLost`, and nothing else — and a local
   * verdict is a guess about a wire that has stopped answering. The relay's is a fact: it can
   * see both sockets. So a relay verdict is allowed to replace a local one, and never the
   * other way round.
   */
  private endedLocally = false;

  constructor(link: Link, cfg: BattleConfig, quality: QualityTier, deployPhase: boolean) {
    this.link = link;
    this.cfg = cfg;
    this.quality = quality;
    this.deployPhase = deployPhase;
  }

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    /*
     * Nail the clock to tick 0 here, in `init`, and not when the relay says the battle has
     * started. **This is a protocol requirement, not a tidiness one.**
     *
     * `main.ts` calls `engine.start()` and *then* sets `ready = true`, so the frame loop is
     * running before anything downstream knows the page exists. With a deployment phase the
     * clock is paused and nothing happens; **without one** — `?deploy=0` — the accumulator is
     * live, and a client left free between `engine.start()` and the relay's `start` runs ticks
     * for as long as its opponent takes to load. On a full-scale siege in a second browser
     * that is tens of seconds, so the host would be thousands of ticks in before the battle
     * began, and every checkpoint the two exchanged afterwards would be comparing different
     * points in the same battle. Two clients would not be desynced; they would never have been
     * synced.
     *
     * `init` runs inside `engine.initAll()`, which is before `engine.start()`, so from the
     * first frame of this client's life the ceiling is 0 and the tick index at join is 0 by
     * construction rather than by hope. `BootPrint.tick0` then *asserts* it, so a future change
     * that reintroduces the window is refused in the lobby instead of desyncing at t+30.
     */
    ctx.time.setCeiling(0, 'net');
    /*
     * And say, once, how this session answers for the ceiling it holds.
     *
     * `SimWatchdog` asks whenever the simulation has been still for more than a moment, and
     * this is the answer that keeps a safety net from becoming a false alarm in every match.
     * The judgement is deliberately *not* a duration: a lockstep client is supposed to sit on
     * its ceiling, and how long is a question about the other player, which nothing here is
     * entitled to have an opinion about. It is a fact about the transport instead — see
     * `linkFault`. A client waiting on a live relay is quiet; a client whose relay is gone is
     * not, and by the time the watchdog asks, `pace` has usually already ended the match.
     */
    ctx.time.explainCeiling('net', () => {
      /*
       * `over` first, and the order is a check this gate caught.
       *
       * A match that has ended has a result on screen: `NetPanel` prints "linkLost: the relay
       * closed the connection" the moment `pace` names it. Asking about the link before asking
       * about the phase reported the *same event twice* — a red banner over a session strip that
       * had already explained itself — and two notices for one event is how a player learns to
       * ignore both. The watchdog is for the case where nothing else speaks.
       */
      if (this.phase === 'over') {
        return {
          held: true, expected: true,
          why: `the match is over (${this.ended || 'ended'}): ${this.message}`,
        };
      }
      // Belt as well as braces: `pace` ends the match on a link fault within a frame of it
      // happening, so reaching this means something stopped that from working.
      const fault = this.linkFault();
      if (fault) return { held: true, expected: false, why: fault };
      if (this.phase !== 'battle') {
        return {
          held: true, expected: true,
          why: this.phase === 'deploy'
            ? 'both armies are still being laid out'
            : 'waiting for the other player to join',
        };
      }
      return {
        held: true, expected: true,
        why: `waiting for turn ${this.readyTurn + 1} from the relay`,
      };
    });
    this.battle = ctx.get<Subsystem>('battle') as unknown as BattleSystem;
    this.replay = ctx.get<Subsystem>('replay') as unknown as ReplaySystem;
    const sink: NetSink = {
      relayOps: (blobs) => {
        for (const b of blobs) {
          this.inFlight.set(JSON.stringify(b), {
            at: performance.now(), tick: this.ctx.time.tick,
          });
        }
        this.link.send({ k: 'ops', ev: blobs });
      },
    };
    this.replay.attachNet(sink, HASH_EVERY, (m) => this.onMark(m));
  }

  /**
   * Announce this client to the relay, once the army is on the field.
   *
   * Called from `main.ts` after `deployBattle`, because `unitSizeScale` and `pool.count` are
   * only final then and both are in the handshake. Everything in `BootPrint` is a thing
   * measured to change the battle; the citations are on the interface.
   */
  announce(factions: number[]): BootPrint {
    this.factions = factions;
    this.myFaction = factions[this.link.slot] ?? 0;
    const h = stateHashes(this.battle.pool, this.battle.units);
    const print: BootPrint = {
      cfgKey: JSON.stringify(this.cfg),
      quality: this.quality,
      unitScale: this.battle.unitSizeScale,
      count0: h.count,
      tick0: (this.tick0 = this.ctx.time.tick),
      hash: h.hash,
      uf64: h.uf64,
      uctl: h.uctl,
      libm: libmPrint(),
      ua: navigator.userAgent.slice(0, 120),
      deployPhase: this.deployPhase,
    };
    this.phase = 'lobby';
    this.message = 'waiting for the other player';
    this.link.send({ k: 'ready', print, cfg: this.cfg, factions });
    return print;
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  update(): void {
    for (const m of this.link.drain()) this.onMessage(m);
    this.pace();
    /*
     * And tell the transport how far the simulation has got. **A relay does not need to know
     * and a peer does.**
     *
     * The only line in this file that exists for the peer-to-peer transport, and it is here
     * rather than inside `pace` because it is not pacing — it is the *report* the other
     * scheduler is paced by. `NetLink` does not implement `pump` at all; `PeerLink` earns the
     * right to commit turn `k` by having consumed turn `k - delay`, and that single dependency
     * is what stops two peers playing the battle as fast as the wire can carry it. `Link.pump`
     * and `PeerRoom.pump` both carry the arithmetic.
     *
     * After `pace`, so the tick reported is the one this frame actually reached and the ceiling
     * for the next frame is already set.
     */
    this.link.pump?.(this.ctx.time.tick);
  }

  /**
   * The ceiling, and the catch-up.
   *
   * Two levers and no third. `tickCeiling` stops this client running a tick the relay has not
   * authorised — that is what makes two machines run one battle. `gameSpeed` lets a client
   * that has fallen behind close the gap, and it is safe because it scales the accumulator
   * rather than the step: `Time.beginFrame` still hands out whole 1/30 s ticks and
   * `maxStepsPerFrame` still caps them at five a frame, so a 4× speed is 4× the *rate* and
   * bit-for-bit the same ticks.
   *
   * The asymmetry is deliberate: there is no lever that slows a client down, because there is
   * nothing to slow down *to*. A client that is ahead is simply a client sitting on its
   * ceiling, which costs nothing and is the normal state between turn packets.
   */
  private pace(): void {
    const t = this.ctx.time;
    /*
     * How long the relay has been silent, counted in frames that actually ran.
     *
     * `link.counts.got` rather than a timestamp taken in `onmessage`, and `time.frameDt` rather
     * than `performance.now()`, because both halves of the measurement have to be blind to a
     * blocked main thread — see `LINK_SILENT_S`. Synthetic frames are excluded outright: a
     * fast-forward runs thousands of frames with no event loop in between, and every one of
     * them is a frame during which nothing could possibly have arrived.
     */
    if (!this.ctx.advancing) {
      const got = this.link.counts.got;
      if (got !== this.lastGot) { this.lastGot = got; this.quietFor = 0; }
      else this.quietFor += t.frameDt;
    }
    /*
     * The link, before anything else, because a client with no link has no business waiting.
     *
     * This is the fix for the freeze the pass was opened on. There is no reconnection —
     * §4.5 refuses it and §9.6 prices it — so the honest behaviour when the wire fails is
     * exactly the one a relay-sent `end` already produces: halt at a stated tick, name the
     * reason, and leave the record. What was missing was anybody noticing.
     */
    const fault = this.linkFault();
    if (fault && this.phase !== 'over') this.onEnd('linkLost', this.ctx.time.tick, fault, 'here');
    if (this.phase === 'over') {
      t.setCeiling(t.tick, 'net');
      t.gameSpeed = 1;
      return;
    }
    /*
     * No early return for `connecting` and `lobby`. `readyTurn` is -1 until the first battle
     * turn arrives, so the expression below evaluates to 0 in those phases and holding it is
     * the whole point — see `init`.
     */
    const ceiling = turnTick(this.readyTurn + 1);
    t.setCeiling(ceiling, 'net');
    /*
     * The deployment phase is not a stall and must not be counted as one.
     *
     * `readyTurn` is -1 until battle turn 0 arrives, so the ceiling is 0 and the simulation
     * is held at tick 0 for the whole of deployment — which is correct, deliberate and has
     * nothing to do with the network. Counting it reported a single 4.75-second stall in every
     * run at every latency, which is a measurement of how long somebody took to press BEGIN
     * BATTLE dressed up as a link quality figure.
     */
    if (this.phase !== 'battle') { this.waitingSince = 0; return; }
    const behind = ceiling - t.tick;
    /*
     * A stall is *waiting longer than a turn*, not merely sitting on the ceiling.
     *
     * The first version of this counted every frame at the ceiling and reported 93 stalls
     * totalling 12.6 seconds of a 13-second battle on a zero-latency localhost link — which is
     * true and useless. Lockstep at real-time pacing spends most of its wall clock at the
     * ceiling by construction: three ticks take about ten milliseconds and the next packet is a
     * hundred away. Counting that as a stall makes the number a measure of how fast the machine
     * is, and the thing worth knowing is how often the *network* made the battle wait.
     *
     * So the clock only starts once the wait has exceeded one and a half turns. `STALL_MS` is
     * derived from `TICKS_PER_TURN` rather than from the relay's `turnMs`, deliberately: a turn
     * is three ticks of *simulated* time whatever wall clock the relay schedules it on, so this
     * threshold means the same thing when the gate runs a relay at five times speed.
     */
    const now = performance.now();
    if (behind <= 0) {
      if (this.waitingSince === 0) this.waitingSince = now;
      else if (!this.stallSince && now - this.waitingSince > STALL_MS) {
        this.stallSince = this.waitingSince + STALL_MS;
        this.stalls++;
      }
      t.gameSpeed = 1;
      return;
    }
    this.waitingSince = 0;
    if (this.stallSince) { this.stalledMs += now - this.stallSince; this.stallSince = 0; }
    /*
     * Three steps rather than a continuous controller, because the thing being controlled is
     * already quantised: `Time` hands out whole ticks and `maxStepsPerFrame` caps them at five,
     * so any speed above about 10 is inexpressible and any fine-grained gain would be spent
     * hunting between two integers. One turn behind is normal and gets 1×; a few turns behind
     * is a hitch and gets 2×; anything more is a stall being recovered from.
     */
    t.gameSpeed = behind > TICKS_PER_TURN * 4 ? MAX_CATCHUP_SPEED
      : behind > TICKS_PER_TURN * 2 ? 2 : 1;
  }

  /**
   * Is the wire broken? The one question that separates a correct lockstep stall from a freeze.
   *
   * This is the discriminator the whole safety net rests on, so it is worth being exact about
   * what it is *not*. It is not "how long has this client been at its ceiling" — a client at
   * its ceiling is a client doing lockstep properly, and at a 100 ms turn it is there for most
   * of every second of every match. It is not "how long since the peer did anything" — the
   * peer is allowed to think, and a deployment phase legitimately lasts minutes. Timing out on
   * either of those would put a red banner on a healthy game, which is worse than no banner at
   * all because the next real one would be ignored.
   *
   * It is two facts about the transport, and nothing else:
   *
   * 1. **The socket said it was gone.** `NetLink.dropped`, set from `onclose` or `onerror`
   *    whether or not the handshake had settled. Instant, unambiguous, and until this pass it
   *    was set and never read.
   * 2. **The relay has stopped sending.** `Room.tick` emits a turn packet to both slots every
   *    `turnMs` off its own wall clock, unconditionally, so inbound traffic is a heartbeat
   *    nobody has to arrange — and in the lobby, where there are no turns to close, a `ping` a
   *    second instead (`Room.LOBBY_BEAT_MS`). This is the case `onclose` cannot cover: a
   *    half-open socket after a sleep or a dropped wireless link, where the browser still
   *    believes it is connected.
   *
   *    The threshold is **eight observed gaps or `LINK_SILENT_S`, whichever is longer**, and
   *    the multiple matters more than the floor. `turnMs` belongs to the relay —
   *    `tools/relay.mjs --turn-ms=` sets it — so a constant tuned against the 100 ms default
   *    would report a deliberately slow relay as a dead one, which is the false alarm this
   *    whole design is trying not to be. `NetLink.gapMs` is what the link is actually doing.
   *
   * Both are only asked once the handshake is behind us — before `announce` there is nothing
   * to be silent about.
   */
  private linkFault(): string {
    if (this.link.dropped) return this.link.dropped;
    if (this.tick0 < 0 || !this.link.lastMessageAt) return '';
    const limit = Math.max(LINK_SILENT_S, (this.link.gapMs * 8) / 1000);
    if (this.quietFor < limit) return '';
    /*
     * "the other side", not "the relay", because there may not be one.
     *
     * The sentence reaches the player through `NetPanel`'s session-over sheet, and on a peer
     * session it was an accusation against a process that was never in the match. What the
     * measurement actually says is the same either way: nothing has arrived, for this long, on a
     * wire that sends unconditionally.
     */
    return `nothing has arrived from the other side in ${this.quietFor.toFixed(1)} s of `
      + `drawing, against a ${Math.round(this.link.gapMs)} ms turn — the connection is gone`;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  private onMessage(m: RelayMsg): void {
    switch (m.k) {
      case 'peer':
        this.message = m.state === 'left' ? 'the other player left'
          : m.state === 'ready' ? 'the other player is ready'
            : 'the other player joined';
        break;
      case 'start':
        this.factions = m.factions;
        this.myFaction = m.factions[this.link.slot] ?? this.myFaction;
        this.phase = m.phase;
        this.message = m.phase === 'deploy' ? 'lay out your army' : 'battle';
        break;
      case 'turn': this.onTurn(m); break;
      case 'desync': this.onDesync(m); break;
      case 'wantProbe': this.onWantProbe(m.tick); break;
      case 'attrib':
        if (this.desync) {
          this.desync.units = m.units;
          this.desync.note = m.note;
        }
        break;
      case 'refuse':
        this.phase = 'over';
        this.ended = m.why;
        this.endedLocally = false;
        this.message = m.detail ?? m.why;
        break;
      case 'end': this.onEnd(m.why, m.atTick, m.detail); break;
      default: break;
    }
  }

  /**
   * One canonical turn, handed to the order log.
   *
   * The client stamps the execution tick from the packet's own `t` and never from a clock.
   * That is the sentence that makes this deterministic across two machines, and it is one
   * line long because `src/sim/replay.ts` already had the hard part: an order log keyed to a
   * tick index, drained at the top of that tick, from a system registered ahead of every
   * `fixedUpdate` in the tree.
   */
  private onTurn(m: MsgTurn): void {
    if (m.ph === 'battle') {
      // Turn 0 of the battle phase is also the signal that the deployment phase is over
      // everywhere, including on a client whose own player committed some seconds ago.
      if (this.phase === 'deploy') this.phase = 'battle';
      this.readyTurn = Math.max(this.readyTurn, m.n);
    }
    const ops: { slot: number; blob: unknown[] }[] = [];
    for (const o of m.ops) {
      if (this.testMarker(o.e)) continue;
      ops.push({ slot: o.s, blob: o.e });
      if (o.s !== this.link.slot) continue;
      const key = JSON.stringify(o.e);
      const sentAt = this.inFlight.get(key);
      if (!sentAt) continue;
      this.inFlight.delete(key);
      /*
       * Deployment operations are excluded from the latency figure, and not because they are
       * fast — because they have no tick to be late by. The clock is stopped throughout the
       * phase, so every deploy op is issued at tick 0 and executes at tick 0, and averaging
       * those zeroes in with the battle's would report an input delay a third of the real one.
       * They still cost a round trip; that shows in `rttMs`, which this keeps for them.
       */
      if (m.ph !== 'battle') continue;
      this.lat.push({ rttMs: performance.now() - sentAt.at, delayTicks: m.t - sentAt.tick });
      if (this.lat.length > 64) this.lat.shift();
    }
    if (ops.length) this.replay.feedNet(m.t, ops);
  }

  /**
   * The smallest perturbation this simulation can actually hold, and the reason it arrives as
   * an order.
   *
   * A relay has no simulation, so it cannot perturb one. `tools/relay.mjs --fault=ulp` sends a
   * marker to one slot instead and this turns it into a one-unit-in-the-last-place move of one
   * `UnitGroupState` position field. A detector that has never been shown that fault is a
   * detector nobody has tested.
   *
   * **One float32 ULP, and the change from float64 is a measurement rather than a preference.**
   * Every one of the fourteen `UNIT_F64_FIELDS` turns out to be a *float32 value in a float64
   * box*: sampled across twelve units over three frames of the shipped battle, 36 of 36 readings
   * had their low 29 mantissa bits zero — `...80000000`, `...a0000000`, `...e0000000` — and a
   * one-float64-ULP nudge to any of the fourteen was back to a clean float32 value within one
   * tick. Measured 3 Sep 2026, `tools/scratch/ulpfields.mjs`.
   *
   * That corrects §1.4. The claim there is that the float32 round trip is a firewall with ~29
   * bits of headroom and that *"`UnitGroupState` has no such firewall"*. It has the same one:
   * the unit layer is derived from the soldier pool and re-quantised on the way in. `uf64` is
   * not a float64 layer, it is a float64 *hash of float32 values*, and it is sensitive for a
   * different reason — it is per-unit and aggregated, so one man's disagreement is not averaged
   * away — rather than because it carries more bits.
   *
   * The consequence for this fault is direct: **a one-float64-ULP disagreement is not
   * representable in this simulation's state**, so injecting one models something that cannot
   * happen and tests nothing. It was surviving less than a tick, and whether the detector saw
   * it was a race between the checkpoint and the next step — a race the relay path won often
   * enough to keep `qa-net --only=ulp` green while the peer path, which drains its turns inside
   * `update()` immediately before the step, lost it every time and reported sixty-two
   * bit-identical checkpoints after a fault that had definitely fired.
   *
   * One float32 ULP is the right magnitude for the same reason: it is what a libm disagreement
   * of 1-3 float64 ULP leaves behind **when it lands near a rounding boundary and gets through**
   * the firewall, which is the only case that reaches this state at all. At the shipped battle's
   * scale that is about 15 micrometres, and it persists and grows — measured, same file.
   *
   * It is reachable only from a relay started with an explicit test flag, or from a peer with
   * `?p2pfault=ulp`. Nothing the product builds emits this marker.
   */
  private testMarker(blob: unknown[]): boolean {
    if (blob[0] !== '__ulp__') return false;
    const u = this.battle.units.find((x) => !x.destroyed && x.alive > 0);
    if (!u) return true;
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    f32[0] = u.x;
    u32[0] = (u32[0] + 1) >>> 0;
    u.x = f32[0];
    this.perturbed = u.id;
    console.warn(`[net] test perturbation: unit ${u.id} x moved by one float32 ULP`);
    return true;
  }

  /**
   * The checkpoint, every `HASH_EVERY` ticks, and the rolling per-unit history behind it.
   *
   * `uf64` is the detector. Measured 21 August 2026: the float64 unit layer diverges at t+30
   * in both Firefox and WebKit while the float32 pool hash holds all the way to t+200. The
   * mechanism is §1.4 — every tick reads float32, computes in float64 and writes float32, and
   * that quantisation is a firewall with about 29 bits of headroom; `UnitGroupState` has no
   * firewall at all. All three hashes are sent because the pool hash and `uctl` are how a
   * report says *what kind* of disagreement this is, and `uctl` moving is a much more serious
   * finding than `uf64` moving.
   *
   * The digests are kept for twelve checkpoints — about twelve seconds — because a desync is
   * declared roughly one round trip after the tick it happened at, and the relay then asks
   * both clients about that tick. Without a history the honest answer would be "I have moved
   * on", and the attribution half of this design would not exist.
   */
  private onMark(m: ReplayMark): void {
    this.lastMarkTick = m.tick;
    this.marks.push({
      tick: m.tick, hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive,
    });
    if (this.marks.length > MARK_HISTORY) this.marks.shift();
    this.digests.push({ tick: m.tick, d: unitDigests(this.battle.units) });
    if (this.digests.length > DIGEST_HISTORY) this.digests.shift();
    this.link.send({
      k: 'hash', tick: m.tick, hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive,
    });
  }

  private onWantProbe(tick: number): void {
    const found = this.digests.find((d) => d.tick === tick);
    this.link.send({ k: 'probe', tick, units: found ? found.d : [] });
  }

  /**
   * The policy: **halt, attribute, and end with a stated result.** Not resync.
   *
   * §1.8 found the simulation can be snapshotted, so resync-from-snapshot was genuinely on the
   * table. Two things took it off, and the second is the decisive one.
   *
   * The first is cost. The shipping serialiser is not the reflective probe that proved the
   * result: that pass's own reviewer counted 331 distinct mutated instance-field names across
   * `src/sim` and `src/ai`, twelve systems needing `capture`/`restore`, 162 `private`
   * declarations in `Siege.ts` alone, and a permanent tax on a 6,192-line file under active
   * change. It is a larger piece of work than the whole of this session layer.
   *
   * The second is that it would not help. §4's review says it plainly: in same-engine lockstep
   * there is no mechanism for a *transient* disagreement, so any mismatch is a fork. And a
   * fork here has exactly one cause — two libms that do not agree — which is a *systematic*
   * property of the pairing, not an event. Resyncing from a snapshot would hand both clients
   * the same state and they would fork again on the next contested tick, for the same reason,
   * for as long as anyone kept pressing the button. A resync repairs a lost packet. There are
   * no lost packets here: the transport is TCP under a WebSocket and every op is
   * acknowledged by being echoed back in a numbered turn.
   *
   * So the honest behaviour is to stop at the fork, say where it was, say which regiments
   * differ, and report the result at the last tick both clients agreed on. Both sides keep a
   * complete `.tcr` record of the match, which is the forensic artefact that makes the *next*
   * desync cheaper to find.
   *
   * **What would change my mind:** a measured transient — two clients that disagree at one
   * checkpoint and agree at the next without intervention. That cannot happen under this
   * architecture as described, so observing one would mean the architecture is not what this
   * comment says it is, and finding out which part is wrong would matter more than the policy.
   */
  private onDesync(m: Extract<RelayMsg, { k: 'desync' }>): void {
    if (this.desync) return;
    this.desync = {
      tick: m.tick, layer: m.layer, mine: m.mine, theirs: m.theirs,
      lastAgreedTick: m.lastAgreedTick, units: [], note: 'attributing…',
    };
    this.phase = 'over';
    this.ended = 'desync';
    this.endedLocally = false;
    this.endedAtTick = m.lastAgreedTick;
    this.ctx.time.setCeiling(this.ctx.time.tick, 'net');
    this.message = `the two battles parted at tick ${m.tick} (${m.layer})`;
    console.error(`[net] desync at tick ${m.tick}: ${m.layer} ${m.mine} vs ${m.theirs}; `
      + `last agreed tick ${m.lastAgreedTick}`);
  }

  /**
   * The match is over, for a stated reason, at a stated tick.
   *
   * **First verdict wins — except that the relay outranks this client.** The guard used to be
   * "first wins" outright, and that is right for the case it was written for: a relay `end`
   * followed by the `onclose` it provokes should stay `peerLeft` rather than decay into
   * `linkLost` a frame later. It was wrong in the case that actually shipped. A false
   * `linkLost` in the lobby (`Room.LOBBY_BEAT_MS`) got in first, and then *swallowed the
   * relay's real verdict* — so a survivor whose opponent had walked away was told the link
   * had died, which is a different accusation about a different party.
   *
   * The heartbeat means the false verdict no longer happens. This is the second lock: a
   * verdict this client inferred is never allowed to outrank one the relay observed, whatever
   * order they arrive in.
   */
  private onEnd(why: string, atTick: number, detail: string, from: 'relay' | 'here' = 'relay'): void {
    if (this.ended && this.ended !== why && !(from === 'relay' && this.endedLocally)) return;
    this.endedLocally = from === 'here';
    this.ended = why;
    this.endedAtTick = atTick;
    this.phase = 'over';
    this.message = detail;
    this.ctx.time.setCeiling(this.ctx.time.tick, 'net');
    console.warn(`[net] session ended (${why}) at tick ${atTick}: ${detail}`);
  }

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  /** Everything the UI and the gate read. Never anything the simulation reads. */
  status(): NetStatus {
    const t = this.ctx?.time;
    const n = this.lat.length;
    const rtt = n ? this.lat.reduce((a, b) => a + b.rttMs, 0) / n : 0;
    const dly = n ? this.lat.reduce((a, b) => a + b.delayTicks, 0) / n : 0;
    return {
      phase: this.phase,
      slot: this.link.slot,
      room: this.link.room,
      peer: this.link.peer,
      myFaction: this.myFaction,
      turn: this.readyTurn,
      behindTicks: t ? turnTick(this.readyTurn + 1) - t.tick : 0,
      stalls: this.stalls,
      stalledMs: Math.round(this.stalledMs),
      rttMs: Math.round(rtt * 10) / 10,
      delayTicks: Math.round(dly * 100) / 100,
      message: this.message,
      ended: this.ended,
      endedAtTick: this.endedAtTick,
      got: this.link.counts.got,
      sent: this.link.counts.sent,
      ceiling: t ? t.tickCeiling : -1,
      readyTurn: this.readyTurn,
      tick0: this.tick0,
    };
  }

  /** Every measured order round trip, for the gate's latency table. */
  latencies(): { rttMs: number; delayTicks: number }[] { return this.lat.slice(); }
  /**
   * The transport, so a gate can ask it what it did. Read-only by convention, like `deployment`.
   *
   * Named for what it is for. A method called `link` would be read as part of the session's
   * interface and reached for; this one says in its own name that the only caller should be a
   * harness, and `tools/lib/net-drive.mjs`'s `window.__peer()` is that caller.
   */
  get linkForTests(): Link { return this.link; }
  /**
   * Every checkpoint this client computed, keyed by tick. For a gate; see `MARK_HISTORY`.
   *
   * A copy, because the caller is a harness reaching in through `page.evaluate` and a live array
   * handed out of a running simulation is the shape of a bug that only appears under load.
   */
  checkpoints(): { tick: number; hash: string; uf64: string; uctl: string; alive: number }[] {
    return this.marks.slice();
  }
  /** The unit the test perturbation hit, or -1. */
  get perturbedUnit(): number { return this.perturbed; }
  get lastCheckpoint(): number { return this.lastMarkTick; }

  /** The match, as a record. The same `.tcr` a single-player battle produces. */
  record(): ReplayRecord | null { return this.replay.record(); }

  /**
   * The record as the `.tcr` bytes, or `null` when there is nothing to give.
   *
   * Null rather than a rejecting promise, because the caller is a button: the session-over
   * sheet offers `Save the replay` only when this returns something, and a button that fails
   * when a stranded player presses it is worse than a button that was never there.
   */
  token(): Promise<string> | null {
    return this.replay?.record() ? this.replay.token() : null;
  }

  /** Tell the relay we are going, so the peer gets `peerLeft` rather than a timeout. */
  dispose(): void { this.link.close('page closed'); }
}
