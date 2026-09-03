import {
  agree, DEFAULT_FATAL, firstDisagreement, layerValue, probeDiff, probeNote,
  type Layer, type Mark,
} from './agree.ts';
import {
  DEFAULT_DELAY_TURNS, DEFAULT_PAIRS, RELAY_V, TICKS_PER_TURN, turnTick,
  type BootPrint, type ClientMsg, type OpBlob, type PairTable, type RelayMsg, type TurnOp,
} from './protocol.ts';

/**
 * The room, with no room in it: two peers, one battle, and no third party anywhere.
 *
 * ## What this is
 *
 * `src/net/room.ts` is the same idea with a relay in the middle. Read that first; its docstring
 * names the three guarantees, and this file's whole job is to carry them across to a topology
 * where **there is no coordinator to hold them**. It is a pure state machine with no I/O in it
 * for the same reason `Room` is: `PeerLink` is the adapter that owns the `RTCPeerConnection`,
 * and everything that decides the battle is here where it can be driven from Node with no
 * browser at all (`tools/qa-p2p.mjs`'s `proto` arm does exactly that, two `PeerRoom`s in one
 * process, and it is the only instrument in this pass that can be run a thousand times).
 *
 * **Both peers run one of these.** They are fed the same messages and they produce the same
 * turn packets, in the same order, with the same ops in them. That is the claim, and it is
 * asserted rather than believed: the `proto` arm diffs the two peers' emitted turn streams
 * byte for byte.
 *
 * ## The total order, which is the thing peer-to-peer is supposed to be unable to do
 *
 * `docs/MULTIPLAYER.md` §4.1 rejected peer-to-peer in the first place — *"there is no canonical
 * order for two players' orders arriving in different sequences on two machines"* — and it was
 * right about the hazard and wrong that a relay is the only cure. `protocol.ts` spells out why
 * the hazard is real: `BattleSystem.applyOrder` iterates `o.unitIds` and mutates as it goes, and
 * `deployment.add` → `spawnUnit` runs `nextUnitId++` *before* `rng.fork('unit' + id)`. Sequence
 * *is* the battle.
 *
 * The relay solves it by being the single party that sees both streams and stamping
 * `(turn, slot, seq)` itself. With exactly two players there is a second solution that needs no
 * such party, and it is one sentence:
 *
 * > **Every op is stamped by the peer that owns it, and no receiver ever restamps one.**
 *
 * A peer decides which turn its own ops execute in, numbers them with its own monotonic `seq`,
 * and publishes that decision in a `commit`. Both peers then place that op in that turn, and
 * both sort each turn by `(slot, seq)` — a total order, because `slot` is fixed by role (host 0,
 * challenger 1) and `seq` is unique within a slot. No clock is consulted, no arrival order is
 * consulted, and there is nothing left for the two peers to disagree about. The tiebreak that
 * §4.1 says peer-to-peer needs is *the slot number*, and it is free.
 *
 * What this costs, and it is worth stating because it is the whole difference from the relay:
 * **which** turn an op lands in now depends on the sending peer's own wall clock, so the two
 * players may see slightly different input delays. That is a latency asymmetry, not a
 * determinism hazard — the decision is made once, by the owner, and carried in the message.
 *
 * ## No input is ever dropped, and here that has teeth
 *
 * A turn is emitted **only when both peers have committed it**. There is no deadline anywhere in
 * this file. A peer that is slow does not lose its orders; it makes its opponent wait, which is
 * what lockstep means and is the honest behaviour.
 *
 * The reason an op can never arrive too late for its turn is a small invariant worth reading
 * twice. A peer commits turn `k` only once its own simulation has consumed turn `k - delay`;
 * consuming turn `k - delay` required *the other peer's* commit for `k - delay`, which that peer
 * sent when it consumed `k - 2·delay`. Run that forward and the peer cannot have consumed turn
 * `k` yet, because consuming `k` needs the commit we are only now sending. So the turn we stamp
 * an op into is always still open on both sides, by construction rather than by timing.
 *
 * ## A disagreement ends the match by name
 *
 * Checkpoints go peer to peer. Both peers compare the same two marks with the same shared
 * comparator (`src/net/agree.ts`), so both reach the identical verdict — same tick, same layer,
 * same regiments — with nobody adjudicating. Then both stop. It never hangs and never continues.
 *
 * ## Erasable-only TypeScript, on purpose
 *
 * Node 24 strips types from a `.ts` import at load time, which it can only do for syntax that
 * erases — so no `enum`, no `namespace`, no parameter properties and no `declare` here, and
 * `.ts` extensions on the imports. That constraint is what lets `tools/qa-p2p.mjs` run this
 * state machine directly, and a state machine that can only be tested through a browser is a
 * state machine that will be tested rarely.
 */

// ---------------------------------------------------------------------------
// The wire between the two peers
// ---------------------------------------------------------------------------

/**
 * The first frame each way. Nothing else is accepted before it.
 *
 * It exists for one failure that a relay cannot have and a peer-to-peer session can: **two
 * hosts**. A relay assigns slots, so "both of you are slot 0" is unreachable there. Here the
 * slot comes from which button somebody pressed, and two people who both pressed CREATE and
 * then exchanged the same code would otherwise play a battle in which every op is attributed to
 * slot 0 and the tiebreak is meaningless. This refuses it in the first frame, by name.
 */
export interface PeerHello { k: 'hello'; v: number; slot: number; code: string }
/** The host's battle. Only slot 0 may send one; see `Room.onSetup` for why. */
export interface PeerSetup { k: 'setup'; cfg: unknown; deployPhase: boolean }
/** The handshake. Compared with `agree()`, which is the relay's comparison exactly. */
export interface PeerReady {
  k: 'ready'; print: BootPrint; cfg: unknown; factions: number[];
}
/**
 * One peer's decision about one turn. **This is the only message that reaches the simulation.**
 *
 * `i0` is the `seq` of the first op in `ops`; op `j` is `i0 + j`. Carried rather than implied so
 * that a captured log can be checked for a gap — a missing commit is a bug that must be loud,
 * and `(slot, seq)` with a hole in it is the shape it would take.
 *
 * `ready` is the deployment phase's *commit* flag, and it rides here rather than travelling as
 * its own message for a reason that is about determinism and not tidiness. `Room` flips the
 * phase inside its own `tick()`, "in the same packet that carries the last commit". Two peers
 * with no shared clock cannot both do that on a timer. Carried on the commit, the flip is a
 * function of the commit stream — both peers flip after emitting the same deploy turn, because
 * both are reading the same two flags off the same two messages.
 */
export interface PeerCommit {
  k: 'commit'; ph: 'deploy' | 'battle'; n: number; i0: number; ops: OpBlob[]; ready: boolean;
}
/** A checkpoint. `uf64` is the detector; see `agree.firstDisagreement`. */
export interface PeerHash {
  k: 'hash'; tick: number; hash: string; uf64: string; uctl: string; alive: number;
}
/** Per-unit digests at a tick, so a fork can be attributed to a regiment. */
export interface PeerProbe { k: 'probe'; tick: number; units: [number, string][] }
/**
 * "I am still here", when nothing else was due.
 *
 * The relay's equivalent is `MsgPing`, and it existed for one phase. This one matters in **all**
 * of them, and the reason is the shape of a peer-to-peer stall. `NetSession.linkFault` decides a
 * wire is dead from silence measured against the observed inter-frame gap. Under a relay,
 * inbound traffic is unconditional: `Room.tick` emits a packet every `turnMs` whatever the
 * clients are doing. Between two peers it is *not*, and the failure is circular — a peer whose
 * tab is backgrounded runs no `requestAnimationFrame`, so it commits nothing; its opponent then
 * sits on its ceiling, stops consuming turns, and by the commit rule stops committing too. Both
 * peers fall silent, each waiting for the other, and neither has anything to measure.
 *
 * So a beat goes out on the wall clock whenever a commit did not. Silence then means what
 * `linkFault` thinks it means: the other page is not running, or the wire is gone.
 */
export interface PeerBeat { k: 'beat'; t: number }
export interface PeerBye { k: 'bye'; why: string }

export type PeerMsg =
  | PeerHello | PeerSetup | PeerReady | PeerCommit | PeerHash | PeerProbe | PeerBeat | PeerBye;

// ---------------------------------------------------------------------------
// What the adapter does with the answers
// ---------------------------------------------------------------------------

/**
 * `local` goes to this peer's own `NetSession`; `wire` goes down the data channel.
 *
 * Two lists rather than `Outbound`'s `{to}` because there is no "other slot" to address: the
 * peer is not a socket this state machine holds, it is a machine running its own copy of this
 * file. Addressing it by slot number would be a fiction, and `Room`'s `{ to: 'all' }` would have
 * to mean "me and a thing I cannot reach", which is the sort of sentinel that eventually gets
 * delivered to the wrong place.
 */
export interface PeerReply { local: RelayMsg[]; wire: PeerMsg[] }

const nothing = (): PeerReply => ({ local: [], wire: [] });

export interface PeerRoomOptions {
  /** Turns of input delay this peer schedules its **own** ops into. See `PeerCommit`. */
  delayTurns?: number;
  /** Milliseconds of wall clock per turn. The commit cadence, and nothing else. */
  turnMs?: number;
  /** Which engine pairings may play one battle. Identical to the relay's; see `PairTable`. */
  pairs?: PairTable;
  /** Which checkpoint layer ends a match when it disagrees. See `RoomOptions.fatal`. */
  fatal?: Layer[];
  /**
   * How long the peer may stop making progress, in turns, before the match is abandoned.
   *
   * Measured differently from the relay's `maxLagTurns` and it has to be. `Room.checkLag`
   * compares the two clients' hash ticks, which works because the relay lets a client run
   * ahead. Here it cannot: a peer that stops committing stops its opponent dead at the ceiling,
   * so the two hash streams can never drift apart by more than `delayTurns` and the relay's test
   * would be a check that cannot fail. What is measurable instead is *time*: the peer is beating
   * — its page is alive, its wire is fine — and its committed turn has not moved. 300 turns at
   * 100 ms is 30 s of a battle standing still, which is long enough to ride out a shader link or
   * a garbage collection and short enough that nobody is left staring.
   */
  maxLagTurns?: number;
  /**
   * Test-only. Corrupts what **this** peer commits, so a gate can prove the detector works.
   *
   * The relay's `RoomFault` corrupts one client's *view* of a canonical stream, which is the
   * right model for a relay: there is a truth and one client is given something else. Between
   * two peers there is no canonical stream to diverge from — there are two commit streams, and
   * the only way to make the battles differ is to make one peer *commit* something the other
   * does not. So the fault is applied at the source and travels honestly down the wire, which is
   * a stronger test: the corruption is in the record both peers keep.
   */
  fault?: PeerFault | null;
}

/**
 * A deliberate corruption of what this peer commits.
 *
 * `drop`, `dup` and `swap` are the relay's three, moved to the sending side. `ulp` is the one
 * that reproduces the failure real hardware produces — one `UnitGroupState` float64 field moved
 * by a single unit in the last place — and it travels as a marker op the client's test hook
 * recognises, exactly as it does under the relay (`NetSession.testMarker`).
 */
export interface PeerFault {
  kind: 'drop' | 'dup' | 'swap' | 'ulp';
  fromTurn: number;
  phase?: 'deploy' | 'battle';
  once?: boolean;
}

/** How often "I am still here" goes out in the lobby. A second; see `Room.LOBBY_BEAT_MS`. */
const LOBBY_BEAT_MS = 1000;

export type PeerPhase = 'lobby' | 'deploy' | 'battle' | 'over';

interface Side {
  /** Highest turn this side has committed, per phase. -1 before the first. */
  committedBattle: number;
  committedDeploy: number;
  /** Commits not yet emitted, keyed by turn. */
  battle: Map<number, TurnOp[]>;
  deploy: Map<number, TurnOp[]>;
  /** Whether this side's latest deploy commit said "I have finished laying out". */
  ready: boolean;
  print: BootPrint | null;
  factions: number[];
  marks: Map<number, Mark>;
  probe: Map<number, [number, string][]>;
  lastHashTick: number;
}

const newSide = (): Side => ({
  committedBattle: -1, committedDeploy: -1,
  battle: new Map(), deploy: new Map(),
  ready: false, print: null, factions: [],
  marks: new Map(), probe: new Map(), lastHashTick: -1,
});

export class PeerRoom {
  readonly code: string;
  /** 0 for the host, 1 for the challenger. Fixed by which button was pressed. */
  readonly slot: number;
  phase: PeerPhase = 'lobby';
  /** Battle turns emitted so far. -1 until the first one goes out. */
  turn = -1;
  /** Deploy turns emitted so far. Numbered separately; they all execute at tick 0. */
  deployTurn = -1;
  lastAgreedTick = -1;
  endedWhy = '';

  private sides: Side[] = [newSide(), newSide()];
  private opts: Required<Omit<PeerRoomOptions, 'fault'>> & { fault: PeerFault | null };
  /** Ops issued locally and not yet published in a commit. Never dropped, only deferred. */
  private pending: OpBlob[] = [];
  /** This peer's own monotonic op counter. The `seq` half of `(turn, slot, seq)`. */
  private seq = 0;
  /** The next turn number this peer will commit, per phase. */
  private nextBattle = 0;
  private nextDeploy = 0;
  /** Set once the local player has pressed BEGIN BATTLE. Rides on every later deploy commit. */
  private iAmReady = false;
  private helloSent = false;
  private helloGot = false;
  private opened = false;
  private setup: { cfg: unknown; deployPhase: boolean } | null = null;
  private started = false;
  private pairNote = '';
  private willFork = false;
  /** When the next deploy turn may be committed, and when the next beat is due. */
  private nextDeployClose = 0;
  private nextBeat = 0;
  private lastWireAt = 0;
  /** Wall clock at which the peer's committed turn last moved. The abandonment test. */
  private peerMovedAt = 0;
  private faultsFired = 0;
  private probeTick = -1;
  private probeDeadline = 0;
  private beats = 0;
  private commitsOut = 0;

  constructor(code: string, slot: number, opts: PeerRoomOptions = {}) {
    this.code = code;
    this.slot = slot === 1 ? 1 : 0;
    this.opts = {
      delayTurns: opts.delayTurns ?? DEFAULT_DELAY_TURNS,
      turnMs: opts.turnMs ?? (TICKS_PER_TURN * 1000) / 30,
      pairs: opts.pairs ?? DEFAULT_PAIRS,
      fatal: opts.fatal ?? DEFAULT_FATAL,
      maxLagTurns: opts.maxLagTurns ?? 300,
      fault: opts.fault ?? null,
    };
  }

  private get me(): Side { return this.sides[this.slot]; }
  private get them(): Side { return this.sides[this.slot ^ 1]; }

  get over(): boolean { return this.phase === 'over'; }

  // -------------------------------------------------------------------------
  // Opening and closing
  // -------------------------------------------------------------------------

  /**
   * The data channel is up. Say `welcome` to our own session and `hello` to the peer.
   *
   * `welcome` is synthesised rather than received, and that is the honest reading of it: it is
   * the answer to "which slot am I and what room is this", and in a peer-to-peer session this
   * peer already knows both. Nothing is being taken on trust that was not taken on trust the
   * moment somebody pressed CREATE.
   */
  open(nowMs: number): PeerReply {
    if (this.opened) return nothing();
    this.opened = true;
    this.nextBeat = nowMs + LOBBY_BEAT_MS;
    this.lastWireAt = nowMs;
    this.peerMovedAt = nowMs;
    const local: RelayMsg[] = [
      { k: 'welcome', v: RELAY_V, slot: this.slot, room: this.code, ticksPerTurn: TICKS_PER_TURN },
      { k: 'peer', slot: this.slot ^ 1, state: 'joined' },
    ];
    const wire: PeerMsg[] = [{ k: 'hello', v: RELAY_V, slot: this.slot, code: this.code }];
    this.helloSent = true;
    /*
     * `hello` and nothing else, and the *nothing else* is a correction.
     *
     * This used to republish the host's `setup` here, on the reasoning that a host whose menu
     * closed before the channel opened has a battle to publish. That was half the problem and
     * fixing half of it hid the other half: **`ready` is in exactly the same position and was not
     * republished at all.** The host's `announce` fires when its army is on the field, which on a
     * full-scale siege is a minute before a challenger who is still typing the code has arrived,
     * so its `BootPrint` was handed to a data channel that did not exist yet and dropped on the
     * floor. Both pages then sat in the lobby phase for ever: measured in `qa-p2p`'s `lobby` arm
     * as two clients `ready`, both connected, and neither ever leaving `phase: lobby`.
     *
     * A relay cannot have this failure — its socket is open from before the menu — which is why
     * nothing in `Room` looks like this.
     *
     * The general fix belongs one layer down, in the thing that owns the channel: `PeerLink`
     * queues every frame produced before the channel opens and flushes it on `onopen`, after this
     * `hello`. So this emits the greeting and the state machine stops having an opinion about the
     * adapter's buffering.
     */
    return { local, wire };
  }

  /**
   * The peer's channel went away.
   *
   * In the lobby that is a peer who never arrived or thought better of it, and the room stays
   * open. Past the lobby it ends the match, because there is nothing else honest to do — this
   * peer has half a battle and no opponent, and §4.5 refuses reconnection into a live one.
   */
  peerGone(why: string): PeerReply {
    if (this.phase === 'over') return nothing();
    const local: RelayMsg[] = [{ k: 'peer', slot: this.slot ^ 1, state: 'left' }];
    if (this.phase === 'lobby') {
      this.sides[this.slot ^ 1] = newSide();
      this.started = false;
      return { local, wire: [] };
    }
    this.phase = 'over';
    this.endedWhy = 'peerLeft';
    local.push({
      k: 'end',
      why: 'peerLeft',
      atTick: this.lastAgreedTick,
      detail: `${why}. The last tick both battles agreed on was `
        + `${this.lastAgreedTick < 0 ? 'none' : this.lastAgreedTick}.`,
    });
    return { local, wire: [] };
  }

  // -------------------------------------------------------------------------
  // Messages from our own session
  // -------------------------------------------------------------------------

  /**
   * A `ClientMsg` from this peer's own `NetSession`, unchanged from the relay protocol.
   *
   * `NetSession` does not know which transport it is on and must not: it sends the same
   * `ClientMsg`s it always did, and this decides what a peer-to-peer session does with each.
   * The one that is not a straight forward is `ops`, which is *buffered* rather than sent —
   * because in this topology the sender is the party that decides which turn an op executes in,
   * and that decision belongs to the commit.
   */
  fromClient(nowMs: number, m: ClientMsg): PeerReply {
    /*
     * `probe` is accepted after the match is over, and everything else is not.
     *
     * The exception is the whole of the attribution half of guarantee 3. A desync sets the phase
     * to `over` *and then* asks both sessions for their per-unit digests, so the answer arrives
     * when the match has already ended by construction. Without this clause the digests were
     * refused by the same message that had just requested them: the driver measured a desync
     * correctly declared at tick 120 on both peers, the same layer named on both, and then no
     * attribution and no `end` at all — the session stopped, silently, at the one point where
     * `docs/MULTIPLAYER.md` §9.4 promises a named regiment. `fromPeer` had the exception from the
     * first draft and this did not, which is why it looked like a wire problem.
     */
    if (this.phase === 'over' && m.k !== 'probe') return nothing();
    switch (m.k) {
      case 'setup': {
        if (this.slot !== 0) return nothing();
        // Always emitted, whether or not the channel is up. See `open` for what dropping it — and
        // dropping `ready` beside it — cost. The adapter queues; this does not guess.
        this.setup = { cfg: m.cfg, deployPhase: m.deployPhase };
        return { local: [], wire: [{ k: 'setup', cfg: m.cfg, deployPhase: m.deployPhase }] };
      }
      case 'ready': {
        this.me.print = m.print;
        this.me.factions = m.factions;
        const started = this.maybeStart(nowMs);
        return {
          local: started.local,
          wire: [{ k: 'ready', print: m.print, cfg: m.cfg, factions: m.factions },
            ...started.wire],
        };
      }
      case 'ops': {
        /*
         * Buffered, and the buffer is the whole of "no input is ever dropped".
         *
         * There is no bucket to choose here and no `Math.max` to get wrong: an op joins the queue
         * and leaves it in the next commit this peer publishes, whenever that is. The turn it
         * lands in is therefore always a turn this peer has not yet committed, which by
         * `PeerCommit`'s invariant is always a turn the *other* peer has not yet executed.
         */
        for (const e of m.ev) this.pending.push(e);
        return nothing();
      }
      case 'hash': {
        this.me.lastHashTick = m.tick;
        const wire: PeerMsg[] = [{
          k: 'hash', tick: m.tick, hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive,
        }];
        this.lastWireAt = nowMs;
        const r = this.mark(nowMs, this.slot, m.tick,
          { hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive });
        return { local: r.local, wire: [...wire, ...r.wire] };
      }
      case 'probe': {
        this.lastWireAt = nowMs;
        const r = this.probe(this.slot, m.tick, m.units);
        return {
          local: r.local,
          wire: [{ k: 'probe', tick: m.tick, units: m.units }, ...r.wire],
        };
      }
      case 'deployReady': {
        // Not its own message. It rides on the next deploy commit, so the phase flip is a
        // function of the commit stream on both peers rather than of two wall clocks.
        this.iAmReady = true;
        return nothing();
      }
      case 'bye': {
        this.phase = 'over';
        this.endedWhy = 'left';
        return { local: [], wire: [{ k: 'bye', why: m.why }] };
      }
      default: return nothing();
    }
  }

  // -------------------------------------------------------------------------
  // Messages from the peer
  // -------------------------------------------------------------------------

  fromPeer(nowMs: number, m: PeerMsg): PeerReply {
    this.lastWireAt = nowMs;
    if (this.phase === 'over' && m.k !== 'probe') return nothing();
    if (!this.helloGot && m.k !== 'hello') {
      /*
       * Anything before `hello` is buffered nowhere and refused loudly.
       *
       * Not dropped quietly: a peer whose first frame is a commit is a peer running a different
       * build of this file, and the symptom of tolerating it is a battle that starts and then
       * disagrees. `RELAY_V` exists to be checked before a slot means anything.
       */
      return this.refuse('protocol',
        `the other side sent a '${m.k}' before saying hello. One of these two pages is a `
        + 'different build of the game.');
    }
    switch (m.k) {
      case 'hello': return this.onHello(m);
      case 'setup': {
        if (this.slot === 0) return nothing();
        return { local: [{ k: 'config', cfg: m.cfg, deployPhase: m.deployPhase }], wire: [] };
      }
      case 'ready': {
        this.them.print = m.print;
        this.them.factions = m.factions;
        const started = this.maybeStart(nowMs);
        return {
          local: [{ k: 'peer', slot: this.slot ^ 1, state: 'ready' }, ...started.local],
          wire: started.wire,
        };
      }
      case 'commit': return this.onCommit(nowMs, m);
      case 'hash': {
        this.them.lastHashTick = m.tick;
        return this.mark(nowMs, this.slot ^ 1, m.tick,
          { hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive });
      }
      case 'probe': return this.probe(this.slot ^ 1, m.tick, m.units);
      case 'beat': return nothing();
      case 'bye': return this.peerGone(`the other commander left: ${m.why}`);
      default: return nothing();
    }
  }

  private onHello(m: PeerHello): PeerReply {
    if (m.v !== RELAY_V) {
      return this.refuse('protocol',
        `this build speaks v${RELAY_V} and the other side speaks v${m.v}. One of you is on an `
        + 'older copy of the game.');
    }
    if (m.slot === this.slot) {
      /*
       * Both peers think they are the host. A relay cannot produce this and a code can.
       *
       * If it were tolerated, every op in the match would be attributed to one slot and
       * `(slot, seq)` would stop being a total order over two players — two independent `seq`
       * counters both starting at 0, colliding on every op. The battle would not desync at some
       * later tick; it would be a different battle from the first order.
       */
      return this.refuse('slot',
        `you have both opened room ${this.code} as the host. One of you should press JOIN `
        + 'instead — the host chooses the ground and the challenger takes the other side.');
    }
    if (m.code !== this.code) {
      return this.refuse('room',
        `the other side thinks this is room ${m.code} and this page thinks it is ${this.code}.`);
    }
    this.helloGot = true;
    const wire: PeerMsg[] = this.helloSent
      ? []
      : [{ k: 'hello', v: RELAY_V, slot: this.slot, code: this.code }];
    this.helloSent = true;
    return { local: [], wire };
  }

  /**
   * Both handshakes are in. Refuse the pairing, or start the battle.
   *
   * `agree()` is the relay's comparison, imported rather than reimplemented — see
   * `src/net/agree.ts` for why that is not a tidiness preference. Both peers call it with the
   * same two `BootPrint`s and therefore reach the same verdict without consulting each other,
   * which is the property that makes a coordinator unnecessary here.
   */
  private maybeStart(nowMs: number): PeerReply {
    const local: RelayMsg[] = [];
    const wire: PeerMsg[] = [];
    if (this.started || !this.sides[0].print || !this.sides[1].print) return { local, wire };
    const verdict = agree(this.opts.pairs, this.sides[0].print, this.sides[1].print);
    if (verdict.refuse) {
      this.phase = 'over';
      this.endedWhy = 'refused';
      local.push({ k: 'refuse', why: verdict.refuse.why, detail: verdict.refuse.detail });
      local.push({ k: 'end', why: 'refused', atTick: -1, detail: verdict.refuse.detail });
      return { local, wire };
    }
    this.started = true;
    this.pairNote = verdict.pairNote;
    this.willFork = verdict.willFork;
    const fac = this.sides[0].factions.length === 2 ? this.sides[0].factions : [0, 1];
    this.phase = this.sides[0].print.deployPhase ? 'deploy' : 'battle';
    this.nextDeployClose = nowMs;
    this.nextBeat = nowMs + this.opts.turnMs;
    local.push({
      k: 'start', factions: fac, phase: this.phase, delay: this.opts.delayTurns,
      pairNote: this.pairNote, willFork: this.willFork,
    });
    return { local, wire };
  }

  /**
   * One turn's worth of the peer's decisions, filed under the turn *they* chose for it.
   *
   * Nothing here restamps anything. `i0` becomes the `seq` of the first op and the rest count up
   * from it, so `(slot, seq)` is reconstructed identically on both peers from a message neither
   * of them can reinterpret.
   */
  private onCommit(nowMs: number, m: PeerCommit): PeerReply {
    const them = this.them;
    const bag = m.ph === 'battle' ? them.battle : them.deploy;
    const emitted = m.ph === 'battle' ? this.turn : this.deployTurn;
    if (m.n <= emitted) {
      /*
       * A commit for a turn that has already executed. **This must never be silently dropped.**
       *
       * Dropping it would be dropping input — the one thing the three guarantees forbid outright
       * — and it would do it invisibly, on one side only, producing a battle that forks with no
       * account of why. `PeerCommit`'s invariant says this is unreachable, so reaching it means
       * the invariant is wrong, and the honest response to that is to stop and say so rather
       * than to paper over the first symptom.
       */
      return this.refuse('protocol',
        `the other side committed ${m.ph} turn ${m.n}, which has already been played `
        + `(this page is at ${emitted}). ${m.ops.length} order(s) would have been lost, so the `
        + 'match has stopped instead.');
    }
    if (bag.has(m.n)) {
      return this.refuse('protocol',
        `the other side committed ${m.ph} turn ${m.n} twice. Their two versions of one turn `
        + 'cannot both be the battle.');
    }
    const ops: TurnOp[] = m.ops.map((e, j) => ({ s: this.slot ^ 1, i: m.i0 + j, e }));
    bag.set(m.n, ops);
    if (m.ph === 'battle') them.committedBattle = Math.max(them.committedBattle, m.n);
    else them.committedDeploy = Math.max(them.committedDeploy, m.n);
    them.ready = m.ready;
    this.peerMovedAt = nowMs;
    return this.flush(nowMs);
  }

  // -------------------------------------------------------------------------
  // The clock, and the two rules that use it
  // -------------------------------------------------------------------------

  /**
   * Called every frame. Commits what may be committed, emits what both peers have, and beats.
   *
   * `simTick` is how far this peer's simulation has actually got, and it is the only reason this
   * takes an argument the relay's `tick()` does not. It is the pacer: **a commit is earned by
   * consuming a turn**, not granted by a clock. That single dependency is what stops the two
   * peers running the battle as fast as the network can carry it.
   *
   * Without it the loop is a runaway. Turn emission needs both commits; a commit paced by
   * nothing would follow immediately on an emission; and the ceiling would then race ahead of the
   * simulation, `NetSession.pace` would read a large `behindTicks`, set `gameSpeed` to 8, and two
   * peers would play a ten-minute battle in seventy seconds — consistently, identically, and
   * completely wrong. With it, the commit rate is the tick rate, `behindTicks` sits at about one
   * turn exactly as it does under a relay, and the catch-up lever means what it says.
   */
  pump(nowMs: number, simTick: number): PeerReply {
    if (!this.opened || this.phase === 'over') return this.overTick(nowMs);
    const local: RelayMsg[] = [];
    const wire: PeerMsg[] = [];
    if (this.phase !== 'lobby') {
      /*
       * The commit rules, one per phase, and they are different because only one phase has a
       * simulation in it.
       *
       * **Battle**: commit turn `k` once the simulation has consumed turn `k - delay`.
       * `simTick / TICKS_PER_TURN - 1` is the last turn whose ticks have all run — at tick 0
       * that is -1, so the opening commits are turns `0 .. delay-1`, which is the priming the
       * grid needs to start at all.
       *
       * **Deploy**: the clock is stopped at tick 0 for the whole phase, so there is nothing to
       * earn a commit with and the wall clock paces it instead — bounded by `emitted + delay`, so
       * a peer whose clock runs fast cannot get further than `delay` turns ahead of a peer whose
       * page is slow to load. Deploy ops all execute at tick 0 whatever turn carries them, so
       * what has to be canonical here is the *sequence*, and the sequence is the commit stream.
       */
      if (this.phase === 'battle') {
        const consumed = Math.floor(simTick / TICKS_PER_TURN) - 1;
        while (this.nextBattle <= consumed + this.opts.delayTurns) {
          wire.push(this.commit('battle', this.nextBattle++));
        }
      } else {
        let guard = 0;
        while (this.nextDeploy <= this.deployTurn + this.opts.delayTurns
          && nowMs >= this.nextDeployClose && guard++ < 64) {
          this.nextDeployClose += this.opts.turnMs;
          wire.push(this.commit('deploy', this.nextDeploy++));
        }
      }
    }
    const flushed = this.flush(nowMs);
    local.push(...flushed.local);
    wire.push(...flushed.wire);
    /*
     * The beat, and it is deliberately suppressed by anything else we just said.
     *
     * A commit *is* an "I am still here" — it is a dated frame on the wire — so beating as well
     * would double the frame rate for no information. What the beat covers is the case where no
     * commit was due: the lobby, and a battle in which this peer is stalled at its ceiling
     * waiting on the other one. See `PeerBeat` for why silence in that state is otherwise
     * circular and unmeasurable.
     */
    const period = this.phase === 'lobby' ? LOBBY_BEAT_MS : this.opts.turnMs;
    if (wire.length) { this.lastWireAt = nowMs; this.nextBeat = nowMs + period; }
    else if (nowMs >= this.nextBeat) {
      this.nextBeat = nowMs + period;
      this.lastWireAt = nowMs;
      this.beats++;
      wire.push({ k: 'beat', t: Math.round(nowMs) });
    }
    const lag = this.checkStalled(nowMs);
    return { local: [...local, ...lag.local], wire: [...wire, ...lag.wire] };
  }

  /** One commit: everything buffered, stamped by this peer, and never restamped by anybody. */
  private commit(ph: 'deploy' | 'battle', n: number): PeerCommit {
    const raw = this.pending;
    this.pending = [];
    const i0 = this.seq;
    this.seq += raw.length;
    const ready = ph === 'deploy' && this.iAmReady;
    const msg: PeerCommit = { k: 'commit', ph, n, i0, ops: raw, ready };
    const bent = this.bend(msg);
    const side = this.me;
    const bag = ph === 'battle' ? side.battle : side.deploy;
    // Filed under the same turn, with the same `(slot, seq)` arithmetic the receiver will use —
    // so this peer plays exactly the packet it published, corruption included.
    bag.set(n, bent.ops.map((e, j) => ({ s: this.slot, i: bent.i0 + j, e })));
    if (ph === 'battle') side.committedBattle = n;
    else side.committedDeploy = n;
    side.ready = bent.ready;
    this.commitsOut++;
    return bent;
  }

  /**
   * Emit every turn both peers have now committed. This is the lockstep gate and there is no
   * deadline in it.
   */
  private flush(nowMs: number): PeerReply {
    const local: RelayMsg[] = [];
    let guard = 0;
    while (guard++ < 4096) {
      if (this.phase === 'deploy') {
        const next = this.deployTurn + 1;
        const a = this.sides[0].deploy.get(next);
        const b = this.sides[1].deploy.get(next);
        if (!a || !b) break;
        this.sides[0].deploy.delete(next);
        this.sides[1].deploy.delete(next);
        this.deployTurn = next;
        local.push({ k: 'turn', ph: 'deploy', n: next, t: 0, ops: this.sorted([...a, ...b]) });
        /*
         * The phase flip, from the commit stream and from nothing else.
         *
         * Both peers are reading the same two `ready` flags off the same two commits for the same
         * turn, so both flip after emitting this turn or neither does. `Room` does the equivalent
         * inside its own `tick()` and explains why it must happen in the packet that carries the
         * last commit rather than the one after it: between "the clock is running" and "battle
         * turn 0 has arrived" a client has no ceiling to hold it.
         */
        if (this.sides[0].ready && this.sides[1].ready) {
          this.phase = 'battle';
          this.nextBeat = nowMs + this.opts.turnMs;
        }
        continue;
      }
      if (this.phase !== 'battle') break;
      const next = this.turn + 1;
      const a = this.sides[0].battle.get(next);
      const b = this.sides[1].battle.get(next);
      if (!a || !b) break;
      this.sides[0].battle.delete(next);
      this.sides[1].battle.delete(next);
      this.turn = next;
      local.push({
        k: 'turn', ph: 'battle', n: next, t: turnTick(next), ops: this.sorted([...a, ...b]),
      });
    }
    return { local, wire: [] };
  }

  /**
   * `(slot, seq)`. The whole canonical-order claim, and it is checkable from the packet.
   *
   * Identical to `Room.sorted` on purpose. The difference between the two designs is *who
   * assigned the numbers*, not what is done with them — which is why the emitted packet has the
   * same shape, `NetSession` needs no changes to consume it, and `tools/qa-p2p.mjs` can diff a
   * peer-to-peer turn stream against a relayed one for the same inputs.
   */
  private sorted(ops: TurnOp[]): TurnOp[] {
    return ops.slice().sort((a, b) => (a.s - b.s) || (a.i - b.i));
  }

  /** The corruption, applied to what this peer publishes. See `PeerFault`. */
  private bend(m: PeerCommit): PeerCommit {
    const f = this.opts.fault;
    if (!f || m.ph !== (f.phase ?? 'battle') || m.n < f.fromTurn) return m;
    if (f.once !== false && this.faultsFired > 0) return m;
    if (f.kind === 'ulp') {
      this.faultsFired++;
      return { ...m, ops: [...m.ops, ['__ulp__']] };
    }
    // A fault that changed nothing is not a fault and must not spend the single-shot budget —
    // `Room.emit` has the same guard and the same reason: an arm that passes by proving nothing.
    if (f.kind === 'drop') {
      if (!m.ops.length) return m;
      this.faultsFired++;
      return { ...m, ops: m.ops.slice(1), i0: m.i0 + 1 };
    }
    if (f.kind === 'dup') {
      if (!m.ops.length) return m;
      this.faultsFired++;
      return { ...m, ops: [m.ops[0], ...m.ops] };
    }
    /*
     * `swap` exchanges the **last** adjacent pair, and both halves of that matter.
     *
     * Same slot is automatic here — a commit is one slot's ops by construction, which is one
     * hazard the relay's version had to be careful about. The *last* pair is the correction
     * `Room.bend` records: the gate fires three move orders on one selection, every one of them
     * sets the same regiment's destination, so exchanging the first pair is last-write-wins and
     * changes nothing at all. Exchanging the last pair moves the final order, and the regiment
     * ends somewhere else.
     */
    if (m.ops.length < 2) return m;
    this.faultsFired++;
    const ops = m.ops.slice();
    const i = ops.length - 2;
    const t = ops[i]; ops[i] = ops[i + 1]; ops[i + 1] = t;
    return { ...m, ops };
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * One checkpoint from one side, and the comparison that is the whole safety net.
   *
   * Both peers run this over the identical pair of marks and therefore declare the identical
   * desync, at the identical tick, naming the identical layer — with nobody adjudicating. That
   * symmetry is the reason a relay is not needed for the third guarantee either: the comparison
   * is a pure function of two values both peers hold.
   */
  private mark(nowMs: number, slot: number, tick: number, m: Mark): PeerReply {
    const side = this.sides[slot];
    const other = this.sides[slot ^ 1];
    const theirs = other.marks.get(tick);
    if (!theirs) {
      side.marks.set(tick, m);
      // Bounded: a peer that stopped hashing must not grow this without limit.
      if (side.marks.size > 4096) side.marks.delete(side.marks.keys().next().value as number);
      return nothing();
    }
    other.marks.delete(tick);
    const layer = firstDisagreement(m, theirs, this.opts.fatal);
    if (!layer) {
      if (tick > this.lastAgreedTick) this.lastAgreedTick = tick;
      return nothing();
    }
    if (this.phase === 'over') return nothing();
    this.phase = 'over';
    this.endedWhy = 'desync';
    this.probeTick = tick;
    this.probeDeadline = nowMs + 3000;
    /*
     * `mine` and `theirs` from *this peer's* point of view, not from the argument order.
     *
     * The marks arrive here in whichever order the wire produced them, so `m` is sometimes ours
     * and sometimes the peer's. A report that got that backwards would print the two hashes the
     * right way round on one screen and the wrong way round on the other, for the same fork —
     * which is exactly the kind of detail that makes two people compare notes and conclude the
     * instrument is broken.
     */
    const ourMark = slot === this.slot ? m : theirs;
    const theirMark = slot === this.slot ? theirs : m;
    return {
      local: [
        {
          k: 'desync', tick, layer,
          mine: layerValue(ourMark, layer), theirs: layerValue(theirMark, layer),
          lastAgreedTick: this.lastAgreedTick,
        },
        { k: 'wantProbe', tick },
      ],
      wire: [],
    };
  }

  /** The per-unit digests, diffed. The attribution half of "detected and attributed". */
  private probe(slot: number, tick: number, units: [number, string][]): PeerReply {
    this.sides[slot].probe.set(tick, units);
    const other = this.sides[slot ^ 1];
    const theirs = other.probe.get(tick);
    if (!theirs) return nothing();
    // Disarm the deadline, or the timer in `pump` broadcasts a *second* attribution three
    // seconds later saying no digests came back — which is false, and which the client
    // dutifully writes over the true one. `Room.onProbe` records the gate catching exactly that.
    this.probeTick = -1;
    const mine = slot === this.slot ? units : theirs;
    const yours = slot === this.slot ? theirs : units;
    const diff = probeDiff(mine, yours);
    return {
      local: [
        { k: 'attrib', tick, units: diff, note: probeNote(diff, mine.length, tick) },
        {
          k: 'end', why: 'desync', atTick: this.lastAgreedTick,
          detail: `forked at tick ${tick}; last agreed tick ${this.lastAgreedTick}`,
        },
      ],
      wire: [],
    };
  }

  // -------------------------------------------------------------------------
  // Endings
  // -------------------------------------------------------------------------

  private refuse(why: string, detail: string): PeerReply {
    if (this.phase === 'over') return nothing();
    this.phase = 'over';
    this.endedWhy = why;
    return {
      local: [
        { k: 'refuse', why, detail },
        { k: 'end', why: 'refused', atTick: this.lastAgreedTick, detail },
      ],
      wire: [{ k: 'bye', why }],
    };
  }

  /** The desync probe deadline, and nothing else once a match is over. */
  private overTick(nowMs: number): PeerReply {
    if (this.probeTick < 0 || nowMs <= this.probeDeadline) return nothing();
    const t = this.probeTick;
    this.probeTick = -1;
    return {
      local: [
        {
          k: 'attrib', tick: t, units: [],
          note: 'no per-unit digests came back before the deadline',
        },
        {
          k: 'end', why: 'desync', atTick: this.lastAgreedTick,
          detail: `forked at tick ${t}`,
        },
      ],
      wire: [],
    };
  }

  /**
   * Has the other page stopped simulating while its wire stayed up?
   *
   * The measurement is *time since the peer's committed turn last moved*, and it is not the
   * relay's. `Room.checkLag` differences the two clients' hash ticks, which is meaningful there
   * because a relay lets one client run ahead. Here it cannot: a peer that stops committing
   * stops its opponent at the ceiling within `delayTurns`, so the two hash streams are pinned
   * together and the relay's test could never fire. See `PeerRoomOptions.maxLagTurns`.
   *
   * A dead *wire* is not this test's business — `PeerLink` sees the channel close, and silence is
   * `NetSession.linkFault`'s job. This is the other case: the page is answering and the battle is
   * not moving.
   */
  private checkStalled(nowMs: number): PeerReply {
    if (this.phase !== 'battle' || !this.started) return nothing();
    const limit = this.opts.maxLagTurns * this.opts.turnMs;
    if (nowMs - this.peerMovedAt <= limit) return nothing();
    this.phase = 'over';
    this.endedWhy = 'abandoned';
    const secs = ((nowMs - this.peerMovedAt) / 1000).toFixed(1);
    return {
      local: [{
        k: 'end', why: 'abandoned', atTick: this.lastAgreedTick,
        detail: `the other commander's game has not advanced for ${secs} s — their page is `
          + `answering but their battle has stopped, and it is past the `
          + `${this.opts.maxLagTurns}-turn limit. Catching that up costs more than the match `
          + 'is worth.',
      }],
      wire: [],
    };
  }

  /** For the gate and for a status readout. Nothing in the protocol depends on this shape. */
  status(): Record<string, unknown> {
    return {
      code: this.code, slot: this.slot, phase: this.phase,
      turn: this.turn, deployTurn: this.deployTurn,
      lastAgreedTick: this.lastAgreedTick, endedWhy: this.endedWhy,
      delayTurns: this.opts.delayTurns, turnMs: this.opts.turnMs, fatal: this.opts.fatal,
      pairNote: this.pairNote, willFork: this.willFork,
      committed: [
        [this.sides[0].committedDeploy, this.sides[0].committedBattle],
        [this.sides[1].committedDeploy, this.sides[1].committedBattle],
      ],
      seq: this.seq, pending: this.pending.length,
      lastHashTick: [this.sides[0].lastHashTick, this.sides[1].lastHashTick],
      beats: this.beats, commitsOut: this.commitsOut, faultsFired: this.faultsFired,
      helloGot: this.helloGot,
    };
  }
}
