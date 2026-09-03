import {
  agree, DEFAULT_FATAL, firstDisagreement, layerValue, probeDiff, probeNote,
  type Layer, type Mark,
} from './agree.ts';
import {
  DEFAULT_DELAY_TURNS, DEFAULT_PAIRS, HASH_EVERY, RELAY_V,
  TICKS_PER_TURN, turnTick,
  type BootPrint, type ClientMsg, type OpBlob, type PairTable, type RelayMsg, type TurnOp,
} from './protocol.ts';

/**
 * The room: one two-player match, as a pure state machine with no I/O in it.
 *
 * ## Why this file has no sockets in it
 *
 * There are two places this has to run — a Cloudflare Durable Object (`net/worker.ts`) and a
 * plain Node server (`tools/relay.mjs`) — and the design of `docs/MULTIPLAYER.md` §4.3 says
 * why the Durable Object is the target: `idFromName(roomCode)` gives a *globally unique*
 * object reachable from anywhere, which is the routing primitive Vercel Functions do not have
 * at any price. But a cloud account is not a testing strategy. So the room logic is a class
 * that takes messages and returns messages, and the two hosts are thin adapters over it:
 * about 90 lines of WebSocket framing in Node, about 60 lines of DO plumbing on Cloudflare.
 *
 * The alternative — two implementations of the same protocol — is the failure mode this
 * project keeps shipping, and here it would present as a desync in production and green
 * tests locally. One state machine, two adapters, and the adapters are too small to hide a
 * behaviour in.
 *
 * ## The three things this class exists to guarantee
 *
 * 1. **A total order over both players' orders.** Every op is stamped `(turn, slot, seq)` and
 *    the turn packet is sorted by `(slot, seq)`. `docs/MULTIPLAYER.md` §4.1: `applyOrder`
 *    iterates `o.unitIds` and mutates, and `deployment.add` → `spawnUnit` runs `nextUnitId++`
 *    before `rng.fork('unit' + id)`, so sequence *is* the battle. Peer-to-peer needs a
 *    distributed tiebreak for both of those; this is the tiebreak.
 * 2. **No input is ever dropped.** There is no per-slot deadline and no discard path. Turns
 *    close on the relay's own clock and a late op lands in the next open turn, so lateness
 *    costs latency and never a command. §3's review named the opposite behaviour — closing a
 *    turn on a deadline and dropping that peer's input after the UI has already acknowledged
 *    it — as a lie told several times a match on any jittery link.
 * 3. **A disagreement ends the match by name.** Both clients' checkpoints come here and are
 *    compared. A mismatch is attributed to a tick, a layer and a set of units, and then the
 *    session ends with a stated result. It never hangs, and it never continues.
 */

// ---------------------------------------------------------------------------
// What the adapter has to do with the answers
// ---------------------------------------------------------------------------

/** `to` is a slot index or every slot. */
export interface Outbound { to: number | 'all'; msg: RelayMsg }
/** A slot the adapter should close after flushing. Refusals close; ends do not. */
export interface Reply { out: Outbound[]; close: number[] }
/**
 * A socket that was offered and either got a slot or got a sentence.
 *
 * Separated from `Reply` because a refused socket has no slot, so it cannot be addressed by
 * one — and an `Outbound` addressed to slot -1 is the kind of sentinel that eventually gets
 * delivered to slot 0 by a tired adapter.
 */
export interface JoinResult { slot: number; refuse: RelayMsg | null; out: Outbound[] }

const only = (to: number, msg: RelayMsg): Reply => ({ out: [{ to, msg }], close: [] });
const none = (): Reply => ({ out: [], close: [] });

export interface RoomOptions {
  /** Turns of input delay in the battle phase. The client is never told and never needs to be. */
  delayTurns?: number;
  /** Milliseconds of wall clock per turn. `TICKS_PER_TURN / 30` seconds by construction. */
  turnMs?: number;
  /** Which engine pairings may play one battle. See `PairTable`; the answer is moving. */
  pairs?: PairTable;
  /**
   * Which of the four checkpoint layers ends a match when it disagrees.
   *
   * Configurable rather than baked in, because which layer is the *detector* has changed
   * twice in a day. This morning `uf64` forked at t+30 cross-engine and was arguably too
   * noisy to be fatal; this evening a `Math.fround` firewall on `UnitGroupState` made it
   * bit-stable across all three engines to t+200 and it became the best signal available. If
   * that firewall is reverted — it moves every pinned hash and 2.6% of the survivors, and
   * balance is the owner's call — then `--fatal=pool,uctl,alive` restores the previous
   * behaviour without touching a line of this file.
   *
   * Order matters: the first layer in this list that disagrees is the one named in the
   * report, so it reads as "which is the earliest and most specific thing that went wrong".
   */
  fatal?: Layer[];
  /**
   * How far behind the peer a client may fall before the match is abandoned.
   *
   * A backgrounded Chrome tab runs no `requestAnimationFrame` at all, so it stops simulating
   * while its socket stays open — `docs/MULTIPLAYER.md` §3 names this and observes that five
   * minutes hidden is 9,000 ticks of catch-up. At 3.4 ms a tick and a 4× catch-up ceiling
   * that is a hundred seconds of pegged CPU, which is not a recovery, it is a second failure.
   * 300 turns is 30 s of battle: long enough to ride out a shader link or a garbage
   * collection, short enough that the catch-up is under 8 s.
   */
  maxLagTurns?: number;
  /**
   * Test-only. Corrupts the outbound turn stream for one slot so a gate can prove the
   * detector works. Never set in production; `tools/relay.mjs` requires an explicit flag and
   * `net/worker.ts` does not pass it at all.
   */
  fault?: RoomFault | null;
}

/**
 * A deliberate corruption of one client's view of the canonical stream.
 *
 * Every one of these is a real failure mode of a real relay — a lost frame, a retransmit that
 * was not idempotent, a reordering across a coalescing proxy — and the point of being able to
 * inject them is `docs/MULTIPLAYER.md`'s standing rule restated for netcode: anything you
 * cannot make fail on purpose, you have not tested.
 */
export interface RoomFault {
  kind: 'drop' | 'dup' | 'swap' | 'ulp';
  /** Which slot receives the corrupted stream. The other slot's stream is untouched. */
  slot: number;
  /** Apply from this turn onward, in whichever phase `phase` names. */
  fromTurn: number;
  /**
   * Which phase to corrupt. `battle` unless a fault has a reason to want the other one.
   *
   * `dup` does. A duplicated *move* order turns out to be harmless: `applyOrder` writes
   * `targetX`/`targetZ`, clears the waypoints and re-plants the hold point, and doing that
   * twice with the same numbers leaves the same state — measured, not assumed. A duplicated
   * *deployment* operation is the opposite and is the sharpest hazard in the whole design:
   * `deployment.add` → `spawnUnit` runs `nextUnitId++` before `rng.fork('unit' + id)`, so one
   * extra `add` on one client mints a regiment the other does not have, shifts every later id,
   * and forks every RNG stream downstream of it (§4.1).
   */
  phase?: 'deploy' | 'battle';
  /** Fire once (default) or on every eligible turn. */
  once?: boolean;
}

interface SlotState {
  joined: boolean;
  print: BootPrint | null;
  cfg: unknown;
  factions: number[];
  seq: number;
  /** Checkpoints not yet matched against the peer's. Keyed by tick. */
  marks: Map<number, Mark>;
  lastHashTick: number;
  probe: Map<number, [number, string][]>;
}

const newSlot = (): SlotState => ({
  joined: false, print: null, cfg: null, factions: [], seq: 0,
  marks: new Map(), lastHashTick: -1, probe: new Map(),
});

/**
 * How often the lobby says "I am still here", in milliseconds.
 *
 * The client's only test for a dead relay that `onclose` cannot see — a half-open socket after
 * a sleep or a dropped wireless link — is *silence*, and `NetSession.linkFault` measures it
 * against `NetLink.gapMs`, the observed interval between inbound frames. Past the lobby the
 * turn packet supplies that interval for free, every `turnMs`, whether or not anybody has done
 * anything. In the lobby nothing did, and the consequence was not "the check is asleep": with
 * no gap ever observed, `gapMs` stayed 0, the threshold collapsed to its `LINK_SILENT_S` floor
 * and a host waiting alone in a perfectly healthy room was told the link was gone at exactly
 * 6.0 seconds — with the socket open and the relay running.
 *
 * So the lobby beats too, and the sentence in `linkFault` about the relay sending
 * unconditionally is now true in every phase rather than in three of the four.
 *
 * A second and not a `turnMs`, because the lobby is the one phase that legitimately lasts
 * minutes — somebody is reading a code to somebody else over the phone — and ten frames a
 * second for the whole of it is a Cloudflare bill (§3) for no information. At one second the
 * threshold is `max(LINK_SILENT_S, 8 × 1 s)` = 8 s, so a relay that dies while you wait is
 * named about eight seconds later, which is well inside the time it takes to wonder.
 */
const LOBBY_BEAT_MS = 1000;

export type Phase = 'lobby' | 'deploy' | 'battle' | 'over';

export class Room {
  readonly code: string;
  phase: Phase = 'lobby';
  /** Battle turns closed so far. -1 until the first one goes out. */
  turn = -1;
  /** Deploy turns closed so far. Numbered separately because they all execute at tick 0. */
  deployTurn = -1;
  /** The highest tick at which both clients agreed, bit for bit. The fallback result point. */
  lastAgreedTick = -1;
  endedWhy = '';

  private slots: SlotState[] = [newSlot(), newSlot()];
  private pending: Map<number, TurnOp[]> = new Map();
  private deployPending: TurnOp[] = [];
  private deployReady = [false, false];
  private opts: Required<Omit<RoomOptions, 'fault'>> & { fault: RoomFault | null };
  private pairNote = '';
  private willFork = false;
  private nextClose = 0;
  /** When the lobby's next keep-alive is due. See `LOBBY_BEAT_MS`. */
  private nextBeat = 0;
  /** The host's battle, published before either client has finished loading it. */
  private setup: { cfg: unknown; deployPhase: boolean } | null = null;
  private faultsFired = 0;
  /** Set when a desync has been declared and the per-unit digests are still outstanding. */
  private probeDeadline = 0;
  private probeTick = -1;

  constructor(code: string, opts: RoomOptions = {}) {
    this.code = code;
    this.opts = {
      delayTurns: opts.delayTurns ?? DEFAULT_DELAY_TURNS,
      turnMs: opts.turnMs ?? (TICKS_PER_TURN * 1000) / 30,
      pairs: opts.pairs ?? DEFAULT_PAIRS,
      fatal: opts.fatal ?? DEFAULT_FATAL,
      maxLagTurns: opts.maxLagTurns ?? 300,
      fault: opts.fault ?? null,
    };
  }

  get occupied(): number {
    return (this.slots[0].joined ? 1 : 0) + (this.slots[1].joined ? 1 : 0);
  }

  get over(): boolean { return this.phase === 'over'; }

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  /**
   * Take a socket. Returns the slot it got, or -1 with a refusal to send and then close.
   *
   * Two refusals, and they are deliberately different sentences because they mean different
   * things to whoever is reading them: a full room is somebody else's match, and a started
   * room is *your* match that you have already lost your place in. `docs/MULTIPLAYER.md` §4.5
   * refuses reconnection into a live battle and this is where that refusal lives — see
   * §9.6 for why it is still refused after this pass and what it would take.
   */
  join(nowMs: number, want: 'host' | 'join', v: number): JoinResult {
    if (v !== RELAY_V) {
      return {
        slot: -1,
        refuse: { k: 'refuse', why: 'protocol', detail: `relay speaks v${RELAY_V}, client speaks v${v}` },
        out: [],
      };
    }
    if (this.phase !== 'lobby') {
      return {
        slot: -1,
        refuse: {
          k: 'refuse', why: 'started',
          detail: `room ${this.code} is already in its ${this.phase} phase; a battle in `
            + 'progress cannot be rejoined',
        },
        out: [],
      };
    }
    /*
     * `want` decides the slot outright: host is 0, challenger is 1.
     *
     * Not "first come, first slot". A challenger whose page loads faster than the host's would
     * take slot 0, and slot 0 is not a queue position — it is the side of the battle you
     * command and the client whose battle setup is canonical. Whoever pressed CREATE A ROOM
     * gets it, whatever order the sockets arrive in.
     */
    const slot = want === 'host' ? 0 : 1;
    if (this.slots[slot].joined) {
      return {
        slot: -1,
        refuse: {
          k: 'refuse', why: 'full',
          detail: `room ${this.code} already has a ${want === 'host' ? 'host' : 'challenger'}`,
        },
        out: [],
      };
    }
    this.slots[slot] = newSlot();
    this.slots[slot].joined = true;
    const out: Outbound[] = [
      { to: slot, msg: { k: 'welcome', v: RELAY_V, slot, room: this.code, ticksPerTurn: TICKS_PER_TURN } },
    ];
    const other = slot ^ 1;
    if (this.slots[other].joined) {
      out.push({ to: other, msg: { k: 'peer', slot, state: 'joined' } });
      out.push({ to: slot, msg: { k: 'peer', slot: other, state: this.slots[other].print ? 'ready' : 'joined' } });
      // The joiner needs the host's battle before it can boot one and print a boot hash. It
      // arrives as `setup`, which the host sends when its menu closes — long before it has an
      // army to hash — so a challenger that joins late still gets it immediately.
      if (slot === 1 && this.setup) {
        out.push({ to: 1, msg: { k: 'config', cfg: this.setup.cfg, deployPhase: this.setup.deployPhase } });
      }
    }
    this.nextClose = nowMs + this.opts.turnMs;
    this.nextBeat = nowMs + LOBBY_BEAT_MS;
    return { slot, refuse: null, out };
  }

  /**
   * A socket went away.
   *
   * In the lobby that reopens the slot, which is the useful behaviour: a mistyped code or a
   * closed tab should not burn the room. Past the lobby it ends the match, because there is
   * nothing else honest to do — the peer has half a battle and no opponent, and §4.5 refuses
   * reconnection into a live one.
   */
  leave(slot: number): Reply {
    if (!this.slots[slot]?.joined) return none();
    this.slots[slot] = newSlot();
    const other = slot ^ 1;
    if (this.phase === 'lobby') {
      this.deployReady = [false, false];
      return this.slots[other].joined ? only(other, { k: 'peer', slot, state: 'left' }) : none();
    }
    if (this.phase === 'over') return none();
    this.phase = 'over';
    this.endedWhy = 'peerLeft';
    return {
      out: [
        { to: other, msg: { k: 'peer', slot, state: 'left' } },
        {
          to: other,
          msg: {
            k: 'end', why: 'peerLeft', atTick: this.lastAgreedTick,
            detail: `slot ${slot} disconnected; the last tick both clients agreed on was `
              + `${this.lastAgreedTick < 0 ? 'none' : this.lastAgreedTick}`,
          },
        },
      ],
      close: [],
    };
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  recv(nowMs: number, slot: number, m: ClientMsg): Reply {
    const s = this.slots[slot];
    if (!s?.joined) return none();
    switch (m.k) {
      case 'setup': return this.onSetup(slot, m.cfg, m.deployPhase);
      case 'ready': return this.onReady(nowMs, slot, m.print, m.cfg, m.factions ?? []);
      case 'ops': return this.onOps(slot, m.ev);
      case 'hash': return this.onHash(nowMs, slot, m.tick, { hash: m.hash, uf64: m.uf64, uctl: m.uctl, alive: m.alive });
      case 'probe': return this.onProbe(slot, m.tick, m.units);
      case 'deployReady': return this.onDeployReady(slot);
      case 'bye': return this.leave(slot);
      default: return none();
    }
  }

  /**
   * The host's chosen battle, forwarded to the challenger the moment either exists.
   *
   * Only slot 0's is kept. A challenger that sent one would be proposing a different battle,
   * and the honest place to refuse that is the handshake, where the refusal can say which of
   * the two setups differs and by what.
   */
  private onSetup(slot: number, cfg: unknown, deployPhase: boolean): Reply {
    if (slot !== 0) return none();
    this.setup = { cfg, deployPhase };
    return this.slots[1].joined
      ? only(1, { k: 'config', cfg, deployPhase })
      : none();
  }

  /**
   * The handshake, and the one place a mismatched pairing is refused.
   *
   * Order matters here. The *config* is checked first, then the *army* the config produced,
   * then the *state* that army starts in, then the *build*. Each is a strictly stronger claim
   * than the last and the earlier failures have much better error messages, so a player who
   * picked a different map is told that rather than being told their libm disagrees.
   */
  private onReady(nowMs: number, slot: number, print: BootPrint, cfg: unknown, factions: number[]): Reply {
    const s = this.slots[slot];
    s.print = print;
    s.cfg = cfg;
    s.factions = factions;
    const other = this.slots[slot ^ 1];
    const out: Outbound[] = [{ to: slot ^ 1, msg: { k: 'peer', slot, state: 'ready' } }];
    if (!other.joined || !other.print) return { out, close: [] };

    /*
     * The verdict comes from `src/net/agree.ts`, and it is the *same function* `PeerRoom` calls.
     *
     * It used to be a private method here. There are two schedulers now — this one, which closes
     * turns on a relay's wall clock, and the peer-to-peer one, which closes them on the two
     * peers' own commits — and they are genuinely different algorithms. What they must never be
     * is two opinions about whether these two clients may play one battle: that answer is
     * measured at length in `docs/MULTIPLAYER.md` §1.4 and §1.5, and a second copy of it would
     * present as one transport refusing a pairing the other allows. `agree()` carries the note
     * and the fork expectation out rather than writing them into a caller, because the caller
     * is two classes now.
     */
    const verdict = agree(this.opts.pairs, this.slots[0].print!, this.slots[1].print!);
    this.pairNote = verdict.pairNote;
    this.willFork = verdict.willFork;
    const bad = verdict.refuse;
    if (bad) {
      this.phase = 'over';
      this.endedWhy = 'refused';
      return {
        out: [
          { to: 'all', msg: { k: 'refuse', why: bad.why, detail: bad.detail } },
          { to: 'all', msg: { k: 'end', why: 'refused', atTick: -1, detail: bad.detail } },
        ],
        close: [0, 1],
      };
    }

    const fac = this.slots[0].factions.length === 2 ? this.slots[0].factions : [0, 1];
    this.phase = this.slots[0].print!.deployPhase ? 'deploy' : 'battle';
    this.nextClose = nowMs + this.opts.turnMs;
    out.push({
      to: 'all',
      msg: {
        k: 'start', factions: fac, phase: this.phase, delay: this.opts.delayTurns,
        pairNote: this.pairNote, willFork: this.willFork,
      },
    });
    return { out, close: [] };
  }

  private onOps(slot: number, ev: OpBlob[]): Reply {
    /*
     * `lobby` buffers rather than drops, and that is not fussiness.
     *
     * The host finishes loading before the challenger does, so its deployment plaque is up and
     * clickable for several seconds before the handshake completes. Dropping those operations
     * would lose real input — silently, and only for the faster machine, which is the worst
     * shape a bug can have. They go into the same bucket the first deploy turn empties, so
     * both clients receive them in the same order and apply them to the same starting state.
     */
    if (this.phase === 'deploy' || this.phase === 'lobby') {
      for (const e of ev) this.deployPending.push({ s: slot, i: this.slots[slot].seq++, e });
      return none();
    }
    if (this.phase !== 'battle') return none();
    /*
     * The scheduling rule, in one line, and the reason there is no `else`.
     *
     * `turn + 1` is the first turn that has not been closed; `turn + delay` is where the
     * policy wants it. An op that arrives late is not late for anything — it simply lands in
     * a later bucket, because the bucket is chosen when the op arrives and never revisited.
     * That is the whole of "a late input must be deferred to the next open turn, not
     * discarded", and it is one `Math.max`.
     */
    const at = Math.max(this.turn + 1, this.turn + this.opts.delayTurns);
    const bucket = this.pending.get(at) ?? [];
    for (const e of ev) bucket.push({ s: slot, i: this.slots[slot].seq++, e });
    this.pending.set(at, bucket);
    return none();
  }

  private onDeployReady(slot: number): Reply {
    this.deployReady[slot] = true;
    return none();
  }

  /**
   * A checkpoint from one client, and the comparison that is the whole safety net.
   *
   * **`uf64` is the detector and the pool hash is the confirmation, and that order is
   * measured, not stylistic.** Over one run on 21 August 2026 the float64 unit layer
   * diverged at t+30 in both Firefox and WebKit while the float32 pool hash held all the way
   * to t+200 — seven checkpoints and about 170 simulated seconds of warning. The mechanism is
   * in §1.4: every tick reads float32, computes in float64 and writes float32, and that
   * quantisation is a firewall with about 29 bits of headroom against 1–3 ULP of libm
   * disagreement. `UnitGroupState` has no such firewall. A session that watched the pool hash
   * would find its desync nearly two orders of magnitude later in simulated time, by which
   * point the battle it would have to name is long gone.
   */
  private onHash(nowMs: number, slot: number, tick: number, m: Mark): Reply {
    const s = this.slots[slot];
    s.lastHashTick = tick;
    const other = this.slots[slot ^ 1];
    const theirs = other.marks.get(tick);
    if (!theirs) {
      s.marks.set(tick, m);
      // Bounded: a peer that stopped hashing must not grow this without limit.
      if (s.marks.size > 4096) s.marks.delete(s.marks.keys().next().value as number);
      return this.checkLag(nowMs);
    }
    other.marks.delete(tick);
    // Which layers count, and in what order they are asked about, is `firstDisagreement` in
    // `src/net/agree.ts` — shared with `PeerRoom` so the two transports cannot come to
    // different verdicts about one fork.
    const layer = firstDisagreement(m, theirs, this.opts.fatal);
    if (!layer) {
      // Agreed on every layer that counts. A layer left out of `fatal` may still differ, and
      // recording the tick as agreed anyway is the point of leaving it out.
      if (tick > this.lastAgreedTick) this.lastAgreedTick = tick;
      return this.checkLag(nowMs);
    }
    if (this.phase === 'over') return none();
    this.phase = 'over';
    this.endedWhy = 'desync';
    this.probeTick = tick;
    this.probeDeadline = nowMs + 3000;
    const mine = layerValue(m, layer);
    const yours = layerValue(theirs, layer);
    return {
      out: [
        {
          to: 'all',
          msg: {
            k: 'desync', tick, layer, mine, theirs: yours, lastAgreedTick: this.lastAgreedTick,
          },
        },
        { to: 'all', msg: { k: 'wantProbe', tick } },
      ],
      close: [],
    };
  }

  /**
   * The per-unit digests, diffed. This is the attribution half of "detected and attributed".
   *
   * 35 units × one 32-bit hash is 300 bytes and it turns "the battle forked at tick 1,410"
   * into "unit 17 forked at tick 1,410", which is the difference between a bug report and a
   * shrug. Age of Empires debugged desyncs with 50 MB message traces and world dumps; this is
   * the same idea at a size that can be sent on the tick it happens.
   */
  private onProbe(slot: number, tick: number, units: [number, string][]): Reply {
    this.slots[slot].probe.set(tick, units);
    const other = this.slots[slot ^ 1];
    const theirs = other.probe.get(tick);
    if (!theirs) return none();
    /*
     * Disarm the deadline. Without this the timer in `tick()` fires three seconds later and
     * broadcasts a *second* attribution saying no digests came back — which is false, and which
     * the client dutifully writes over the true one. The gate caught exactly that: a correct
     * report of "unit 12 differs" replaced by "no per-unit digests came back before the
     * deadline" while the digests were sitting in the relay's own map.
     */
    this.probeTick = -1;
    const diff = probeDiff(units, theirs);
    return {
      out: [
        {
          to: 'all',
          msg: {
            k: 'attrib', tick, units: diff, note: probeNote(diff, units.length, tick),
          },
        },
        {
          to: 'all',
          msg: {
            k: 'end', why: 'desync', atTick: this.lastAgreedTick,
            detail: `forked at tick ${tick}; last agreed tick ${this.lastAgreedTick}`,
          },
        },
      ],
      close: [],
    };
  }

  // -------------------------------------------------------------------------
  // The clock
  // -------------------------------------------------------------------------

  /**
   * Close every turn whose wall-clock deadline has passed. Called by the adapter on a timer.
   *
   * This is the only wall clock in the whole design, and it decides *when* a turn closes and
   * nothing else. Which tick the ops in it execute at comes from `turnTick(n)`, computed
   * identically on both clients. So two clients whose machines disagree about what time it is
   * still run the identical battle; they merely receive it at different moments.
   */
  tick(nowMs: number): Reply {
    if (this.phase === 'over') {
      if (this.probeTick >= 0 && nowMs > this.probeDeadline) {
        const t = this.probeTick;
        this.probeTick = -1;
        return {
          out: [
            { to: 'all', msg: { k: 'attrib', tick: t, units: [], note: 'no per-unit digests came back before the deadline' } },
            { to: 'all', msg: { k: 'end', why: 'desync', atTick: this.lastAgreedTick, detail: `forked at tick ${t}` } },
          ],
          close: [],
        };
      }
      return none();
    }
    /*
     * The lobby beats too, and this line used to be `return none()`.
     *
     * A host alone in a room is the one state where nothing else was on the wire, and the
     * client's silence test read that as a dead relay at exactly 6.0 s — see `LOBBY_BEAT_MS`
     * for the arithmetic and `NetSession.linkFault` for the test. `ping` was declared in the
     * protocol from the first draft and never sent by anybody; this is what it is for.
     */
    if (this.phase === 'lobby') {
      if (nowMs < this.nextBeat) return none();
      this.nextBeat = nowMs + LOBBY_BEAT_MS;
      if (!this.slots[0].joined && !this.slots[1].joined) return none();
      return { out: [{ to: 'all', msg: { k: 'ping', t: Math.round(nowMs) } }], close: [] };
    }
    if (nowMs < this.nextClose) return none();

    const out: Outbound[] = [];
    let guard = 0;
    while (nowMs >= this.nextClose && guard++ < 64) {
      this.nextClose += this.opts.turnMs;
      if (this.phase === 'deploy') {
        this.deployTurn++;
        const ops = this.sorted(this.deployPending);
        this.deployPending = [];
        this.emit(out, 'deploy', this.deployTurn, 0, ops);
        /*
         * The phase flip, and it has to happen in the same packet that carries the last
         * commit rather than in the one after it.
         *
         * Between "the clock is running" and "battle turn 0 has arrived" a client has no
         * ceiling to hold it, and two clients that pass through that window at different
         * moments run a different number of ticks in it. Flipping here means the client's
         * ceiling is `turnTick(0) = 0` from the instant it unpauses until battle turn 0
         * lands, so it cannot run a tick nobody authorised.
         */
        if (this.deployReady[0] && this.deployReady[1]) this.phase = 'battle';
      } else {
        this.turn++;
        const ops = this.sorted(this.pending.get(this.turn) ?? []);
        this.pending.delete(this.turn);
        this.emit(out, 'battle', this.turn, turnTick(this.turn), ops);
      }
    }
    const lag = this.checkLag(nowMs);
    return { out: [...out, ...lag.out], close: lag.close };
  }

  /** `(slot, seq)`. The whole canonical-order claim, and it is checkable from the packet. */
  private sorted(ops: TurnOp[]): TurnOp[] {
    return ops.slice().sort((a, b) => (a.s - b.s) || (a.i - b.i));
  }

  private emit(out: Outbound[], ph: 'deploy' | 'battle', n: number, t: number, ops: TurnOp[]): void {
    const f = this.opts.fault;
    const eligible = f && ph === (f.phase ?? 'battle') && n >= f.fromTurn
      && (f.once === false || this.faultsFired === 0);
    const bent = eligible ? this.bend(f, ops) : ops;
    /*
     * A fault that changed nothing is not a fault, and must not be counted as one.
     *
     * `swap` needs two ops in one turn and `drop` needs one; a turn that has neither leaves the
     * array untouched. Consuming the single-shot budget on it would make the arm pass by
     * proving nothing, which is the exact failure mode `tools/qa-replay.mjs` was written to
     * avoid — so the budget is spent on the first turn where the corruption is real.
     */
    if (!eligible || bent === ops) {
      out.push({ to: 'all', msg: { k: 'turn', ph, n, t, ops } });
      return;
    }
    this.faultsFired++;
    for (const slot of [0, 1]) {
      out.push({ to: slot, msg: { k: 'turn', ph, n, t, ops: slot === f.slot ? bent : ops } });
    }
  }

  /**
   * The corruption itself, kept in one place so a reader can see exactly what each arm does.
   *
   * `ulp` is the odd one out and it is the one the coordinator asked for: rather than touching
   * the order stream it asks the *client* to perturb one `UnitGroupState` float64 field by a
   * single ULP. That cannot be done from here — the relay has no simulation — so it travels as
   * a marker op the client's test hook recognises. It is the only fault that reproduces the
   * failure real hardware will actually produce, which is why it is worth the special case.
   */
  private bend(f: RoomFault, ops: TurnOp[]): TurnOp[] {
    if (f.kind === 'drop') return ops.length ? ops.slice(1) : ops;
    if (f.kind === 'dup') return ops.length ? [ops[0], ...ops] : ops;
    if (f.kind === 'swap') {
      /*
       * The swap must exchange two orders **from the same slot**, and that is not fussiness.
       *
       * `applyOrder` iterates `o.unitIds` and mutates only those units, so two orders on
       * *disjoint* regiments commute and swapping them changes nothing — a swap arm that
       * picked any two ops would pass by proving the opposite of what it claims. §4.1's
       * assertion is precisely about two orders **touching one unit**, and the surest way to
       * get that is two consecutive orders from one player, which is what the gate fires.
       */
      /*
       * The **last** such pair, not the first, and that is a correction rather than a taste.
       *
       * The gate fires three move orders on one selection inside one turn. Every one of them
       * sets the same regiment's destination, so the sequence is last-write-wins and exchanging
       * the *first* pair changes the final state by nothing at all — `0,1,2` becomes `1,0,2`
       * and the regiment marches to `2` either way. The fault fired, the packet differed, and
       * the two clients ran identical battles; the arm then reported "NOT DETECTED &mdash; the
       * two clients diverged and the session said nothing", which was an accusation against the
       * product for a corruption that was semantically a no-op. Measured: `faultsFired: 1,
       * detected: false`, every run.
       *
       * Exchanging the last pair moves the *final* order, so `0,1,2` becomes `0,2,1` and the
       * regiment ends somewhere else on the client that was corrupted. Same slot, same units,
       * one packet — §4.1's claim exactly, and now a difference the hashes can see.
       */
      for (let i = ops.length - 2; i >= 0; i--) {
        if (ops[i].s !== ops[i + 1].s) continue;
        const o = ops.slice();
        const t = o[i]; o[i] = o[i + 1]; o[i + 1] = t;
        return o;
      }
      return ops;
    }
    // `ulp`: a marker the client's test hook turns into a one-ULP perturbation.
    return [...ops, { s: f.slot, i: -1, e: ['__ulp__'] }];
  }

  /**
   * Has one client fallen so far behind that catching up is worse than stopping?
   *
   * Measured from the hash stream rather than from a heartbeat, because the hash stream is
   * the only thing that reports *simulated* progress. A backgrounded tab keeps its socket
   * open and answers pings; what it stops doing is ticking.
   */
  private checkLag(nowMs: number): Reply {
    if (this.phase !== 'battle') return none();
    const a = this.slots[0];
    const b = this.slots[1];
    if (!a.joined || !b.joined || a.lastHashTick < 0 || b.lastHashTick < 0) return none();
    const gapTicks = Math.abs(a.lastHashTick - b.lastHashTick);
    if (gapTicks <= this.opts.maxLagTurns * TICKS_PER_TURN) return none();
    this.phase = 'over';
    this.endedWhy = 'abandoned';
    const behind = a.lastHashTick < b.lastHashTick ? 0 : 1;
    void nowMs;
    return {
      out: [{
        to: 'all',
        msg: {
          k: 'end', why: 'abandoned', atTick: this.lastAgreedTick,
          detail: `slot ${behind} is ${gapTicks} ticks (${(gapTicks / 30).toFixed(1)} s) behind `
            + `its peer, past the ${this.opts.maxLagTurns}-turn limit. Catching that up costs `
            + 'more than the match is worth.',
        },
      }],
      close: [],
    };
  }

  /** For the gate and for a status page. Nothing in the protocol depends on this shape. */
  status(): Record<string, unknown> {
    return {
      code: this.code, phase: this.phase, turn: this.turn, deployTurn: this.deployTurn,
      occupied: this.occupied, lastAgreedTick: this.lastAgreedTick,
      endedWhy: this.endedWhy, hashEvery: HASH_EVERY,
      delayTurns: this.opts.delayTurns, turnMs: this.opts.turnMs,
      fatal: this.opts.fatal, pairNote: this.pairNote, willFork: this.willFork,
      seq: [this.slots[0].seq, this.slots[1].seq],
      lastHashTick: [this.slots[0].lastHashTick, this.slots[1].lastHashTick],
      faultsFired: this.faultsFired,
    };
  }
}

/**
 * The refusal for a challenger who typed a code no host ever asked for.
 *
 * It lives here, next to `Room`'s own two refusals, because it is the same kind of sentence and
 * there must be exactly one of it — but the *test* cannot: only the adapter knows whether it
 * has ever heard of a code, and the two adapters know it differently. `tools/relay.mjs` has a
 * `Map` and can answer outright. `net/worker.ts` cannot: `idFromName(code)` conjures a Durable
 * Object for any string you hand it, which is precisely the hazard `CODE_ALPHABET`'s docstring
 * names, so there the question is a storage read.
 *
 * Without this a mistyped code was the worst failure in the product: the challenger joined an
 * empty room that the relay had just invented for them, waited on a host who was sitting in a
 * different room entirely, and nothing anywhere ever said so. No timeout, no message, no way
 * back — the one shape `docs/MULTIPLAYER.md` keeps calling out, an instrument that fails by
 * saying nothing.
 */
export const noSuchRoom = (code: string): RelayMsg => ({
  k: 'refuse',
  why: 'noRoom',
  detail: `there is no room ${code} on this relay. Nobody has opened one under that code — `
    + 'check it against the host\'s screen, or have them read it out again.',
});

/**
 * A room code from a source of randomness the caller supplies.
 *
 * The caller supplies it because this file is imported by a Durable Object, by Node and by
 * the browser, and `crypto.getRandomValues` is spelled three ways across those. Nothing about
 * a room code needs to be deterministic — it is the one value in this whole design that
 * deliberately is not.
 */
export function makeCode(rand: () => number, alphabet: string, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length) % alphabet.length];
  return s;
}
