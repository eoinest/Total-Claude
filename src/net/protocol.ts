/**
 * The wire, for a two-player relayed battle.
 *
 * ## What this is and what it deliberately is not
 *
 * This is not a second serialisation format. `src/sim/replay.ts` already has one — the order
 * log, tuple-encoded, with `x`/`z` snapped to int16 over ±1400 m at the moment an order
 * enters the queue and a tick index rather than a timestamp on every entry. A relayed order
 * **is** a replay event: the identical tuple `encEvent` produces, carried opaquely.
 *
 * The relay never decodes one. It orders them and hands them back, and the client stamps the
 * execution tick from the turn number. That split is the whole point:
 *
 *   - **The relay orders.** It is the single place both clients agree on, so `(turn, slot,
 *     seq)` is a total order by construction. `docs/MULTIPLAYER.md` §4.1 is emphatic about
 *     why this matters and it is not latency: `BattleSystem.applyOrder` iterates `o.unitIds`
 *     and mutates as it goes, and `deployment.add` → `spawnUnit` runs `nextUnitId++` *before*
 *     `rng.fork('unit' + id)`. Two orders touching one unit in a different sequence, or two
 *     deployment operations interleaved differently, are a different battle. Peer-to-peer
 *     needs a distributed tiebreak for both. A relay *is* the tiebreak.
 *   - **The client stamps.** The execution tick is `turn * TICKS_PER_TURN`, computed on both
 *     clients from the same turn number, so no wall clock anywhere touches the simulation.
 *     A relay that stamped ticks itself would have to know the tuple layout, and the day the
 *     layout changed the relay would be a second thing to migrate.
 *
 * The consequence worth stating plainly: **`src/net/` contains the only wall-clock reads in
 * the session, and none of them reaches the simulation.** Wall clock decides *when* the relay
 * closes a turn and how fast a client is allowed to catch up. The turn packet decides *what*
 * the simulation does and *at which tick*. Those two facts are what make a lockstep session
 * on top of this codebase deterministic in spite of running on two machines' clocks.
 *
 * ## Erasable-only TypeScript, on purpose
 *
 * `tools/relay.mjs` (Node) and `net/worker.ts` (Cloudflare) both import this file and
 * `./room.ts`. Node 24 strips types from a `.ts` import at load time, which it can only do
 * for syntax that erases — so no `enum`, no `namespace`, no parameter properties and no
 * `declare` in this file or in `room.ts`. That constraint buys something worth more than the
 * convenience it costs: the relay, the Worker and the browser client read *one* copy of the
 * protocol, so it cannot drift between them. A duplicated protocol constant is the failure
 * this project has shipped repeatedly (`stateHash.ts` exists because the pool hash had been
 * copied into a tool), and here it would present as a desync rather than as a wrong number.
 */

// ---------------------------------------------------------------------------
// Versions and the turn grid
// ---------------------------------------------------------------------------

/**
 * Bumped on any incompatible wire change. Checked in `hello`, and a mismatch is refused
 * before a slot is assigned — an older client that silently half-joined would desync at the
 * first turn, which is a much worse error message than "the relay speaks 2 and you speak 1".
 */
export const RELAY_V = 1;

/**
 * Simulation ticks per network turn. 3 ticks at 30 Hz is a 100 ms turn.
 *
 * Chosen rather than inherited. The turn length trades message rate against the granularity
 * of input delay: at 1 tick a turn the relay sends 30 messages a second per direction and
 * §3's Cloudflare budget falls by 3×, and at 6 ticks a turn the smallest expressible delay
 * is 200 ms. 3 is the value `docs/MULTIPLAYER.md` §3 arrived at from Age of Empires'
 * playtesting and it also happens to divide 30, so a turn boundary is always a tick boundary
 * and `turn * TICKS_PER_TURN` is exact.
 */
export const TICKS_PER_TURN = 3;

/**
 * Turns of input delay the relay schedules by default. 2 turns is 200 ms.
 *
 * The client never reads this — the relay stamps the execution turn and the client obeys, so
 * the delay is a relay-side scheduling policy and **cannot cause a desync**. That is the
 * single most useful property of putting the schedule on the relay: latency policy and
 * determinism are decoupled, and the relay may widen the delay mid-match without either
 * client needing to be told.
 *
 * The arithmetic behind 2: an op the relay receives during turn `n` is placed no earlier than
 * `n + delay`, and the packet for `n + delay` must reach both clients before either needs to
 * execute it. That gives `owd(a) + owd(b) ≤ delay * 100 ms` in the worst case, i.e. roughly
 * "worst round trip through the relay ≤ 200 ms" — comfortable within a continent, tight
 * across an ocean. Measured costs are in `docs/MULTIPLAYER.md` §9.3.
 */
export const DEFAULT_DELAY_TURNS = 2;

/** Ticks between the hashes the two clients exchange. 30 ticks is one simulated second. */
export const HASH_EVERY = 30;

/** Execution tick of the first tick of a turn. The only arithmetic that turns turns to ticks. */
export const turnTick = (turn: number): number => turn * TICKS_PER_TURN;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * What a client must prove about itself before the battle starts.
 *
 * Every field here is a thing measured to change the battle, and each has a citation:
 *
 * - `cfgKey` — the sanitised battle setup, JSON-stringified. Two clients on different
 *   configs are not playing one battle.
 * - `unitScale` and `count0` — **not the tier name.** `docs/MULTIPLAYER.md` §7.7bis: the
 *   graphics tier fixes `quality.maxSoldiers`, `fittedUnitScale` fits the army to it, and the
 *   field battle boots 8,632 men at `high` and 1,515 at `low`. `high` and `ultra` are
 *   bit-identical because `Math.min` binds on the asked scale first, so the tier name is
 *   neither necessary nor sufficient. The *effective* scale and the pool count are.
 * - `hash` / `uf64` / `uctl` — the product's own t+0 checkpoint, from `src/sim/stateHash.ts`.
 *   As of 21 August 2026 the `Math.hypot` sweep closed every cross-engine t+0 split on all
 *   three battles, so this comparison now *succeeds* across Chromium, Firefox and WebKit and
 *   is therefore a real check on the build rather than a proxy that always fails.
 * - `libm` — a hash of ~2,000 implementation-approximated `Math` results over
 *   integer-generated inputs. This is the one field that measures the risk directly instead
 *   of by proxy. §1.5: Chrome 149 → 151 changed eleven of twelve tested functions, and the
 *   field battle ended 42% apart on that change alone. A user-agent string is a guess about
 *   libm; this is libm.
 * - `ua` — kept for the error message, never for the decision.
 */
export interface BootPrint {
  cfgKey: string;
  quality: string;
  unitScale: number;
  count0: number;
  hash: string;
  uf64: string;
  uctl: string;
  libm: string;
  ua: string;
  deployPhase: boolean;
}

/**
 * Which browser this is, as a label a human can write a rule about. Never the decision.
 *
 * The *decision* is the `libm` fingerprint, which measures the thing that actually breaks a
 * battle. This is how the measurement gets written down: "Chromium against WebKit is exact at
 * t+400" is a sentence about engines, and a table indexed by fingerprint would have to be
 * re-recorded on every Chrome release.
 */
export type EngineTag = 'chromium' | 'firefox' | 'webkit' | 'other';

/** Read off the user agent. Spoofable, and it is not a security control — see `PairTable`. */
export function engineTag(ua: string): EngineTag {
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'webkit';
  if (/AppleWebKit\//.test(ua) && !/Chrome\//.test(ua)) return 'webkit';
  return 'other';
}

/**
 * Which pairs of engines are allowed to play one battle, and what is known about each.
 *
 * **A table rather than a flag, because the answer moved three times in one day.** The morning
 * of 21 August 2026 this was going to be "same build only", on the strength of all three
 * engines diverging by t+250 and Chromium and Firefox ending 289 men apart. By the evening a
 * `Math.fround` firewall on `UnitGroupState`'s integrated fields had made Chromium and WebKit
 * bit-identical to t+400. By the end of the night the firewall had been measured across **all
 * three engines, all three battles, seven checkpoints t+0 to t+400, five seeds** — with a
 * control: switch the firewall off and change nothing else, and two of the five seeds go red.
 * So the property is real, it is attributable to one change, and it is asserted by a gate
 * rather than believed.
 *
 * A binary policy would have been wrong twice before it was right once. The table is a list,
 * it is dated, every row carries its evidence, and changing it is a relay flag not a deploy.
 *
 * Three things the table is careful about:
 *
 * - **`exact` is a fingerprint, never a version string, and the distinction is measured.**
 *   Across eight Chromium builds the fourteen approximated functions fall into *generations*
 *   rather than tracking the version number: `{130}`, `{143, 147, 149}`, `{151, 152}`. 143 to
 *   149 spans six major versions and is bit-identical on all fourteen; 149 to 151 changes
 *   twelve of them; 151 to 152 changes none. A version check would refuse pairings that work
 *   perfectly and accept the one that does not. A generation *is* a fingerprint equivalence
 *   class, so `exact` — an identical `libm` hash — already means "same generation", with no
 *   table of build numbers to maintain and no way for it to go stale. An unknown build is not
 *   refused; it is fingerprinted, and if it lands in a known generation it plays.
 * - **An allowed pairing is a pairing with a stated desync policy, not a promise.** With the
 *   firewall a desync is *unexpected* rather than routine, which is why it is now loud when it
 *   happens. Without one it is still legible: named tick, named layer, named regiments.
 * - **A tag is a label, not a credential.** Nothing here resists a spoofed user agent, and
 *   nothing needs to: §4.5 refuses anti-cheat outright, and lockstep already hands both
 *   clients the whole world.
 */
export interface PairRule {
  /** `exact` matches identical `libm` fingerprints whatever the engines say they are. */
  a: EngineTag | 'exact';
  b?: EngineTag;
  /** What is known, with its date. Printed in the lobby and in any refusal. */
  note: string;
  /** True when this pairing is expected to fork inside a battle. */
  willFork: boolean;
}

export interface PairTable {
  allow: PairRule[];
  /**
   * A pairing not in the list.
   *
   * `allow`, and that flipped on the evening of 21 August. It was `refuse`, on the reasoning
   * that an unlisted pairing was one nobody had measured. Once the firewall made every
   * measured pairing hold for a whole battle, the balance of errors inverted: **refusing a
   * pairing that would have worked became the likelier and the worse mistake**, and the cost
   * of being wrong the other way is a match that ends inside a second with the tick, the layer
   * and the regiments named. `--unknown=refuse` restores the strict posture for anyone who
   * would rather not start than not finish.
   */
  unknown: 'refuse' | 'allow';
}

/**
 * The default table, measured on **one machine, one architecture, one OS**.
 *
 * §7.1 remains the open premise and nothing here touches it: every row is one laptop running
 * several engines. Chrome-on-Alice against Chrome-on-Bob — two *machines*, same build — has
 * still never been compared, and it is the pairing the product actually rests on.
 *
 * **§7.1's suggested shortcut does not exist.** It says a `chrome130-x64` build is sitting in
 * the Playwright cache for a same-day cross-architecture read. It is not: `chromium-1140`'s
 * binary is Mach-O arm64 and every Chromium in that cache is arm64. The cross-architecture
 * question cannot be answered on this machine at all, and the eight-build sweep that *can* be
 * run here is a sweep over libm generations, not over architectures.
 */
export const DEFAULT_PAIRS: PairTable = {
  unknown: 'allow',
  allow: [
    {
      a: 'exact',
      willFork: false,
      note: 'identical libm fingerprint — the same generation, which is not the same as the '
        + 'same version: Chromium 143, 147 and 149 are bit-identical on all fourteen '
        + 'approximated functions while 149 to 151 changes twelve of them. Still argued '
        + 'rather than measured across two *machines* (docs/MULTIPLAYER.md §7.1).',
    },
    {
      a: 'chromium', b: 'webkit',
      willFork: false,
      note: 'measured 21 Aug 2026 with the UnitGroupState quantisation firewall: all three '
        + 'engines, all three battles, seven checkpoints t+0 to t+400, five seeds, '
        + 'bit-identical on hash, uf64 and uctl. Controlled — with the firewall off and '
        + 'nothing else changed, two of the five seeds go red.',
    },
    {
      a: 'chromium', b: 'firefox',
      willFork: false,
      note: 'the same five-seed, three-battle, t+400 result as chromium+webkit. Note what it '
        + 'depends on: **without** the firewall this pairing parts company on uf64 at tick 30 '
        + '(t+1.0 s), measured by tools/qa-net.mjs on the 8,632-man field battle. A build '
        + 'without the firewall is a different pairing wearing the same engine names.',
    },
    {
      a: 'firefox', b: 'webkit',
      willFork: false,
      note: 'the same five-seed, three-battle, t+400 result. Never played through a relay, '
        + 'only compared by the determinism gate.',
    },
  ],
};

/** Is this pairing allowed? Returns the rule, or null with the reason in `refusePair`. */
export function pairRule(t: PairTable, a: { libm: string; tag: EngineTag },
  b: { libm: string; tag: EngineTag }): PairRule | null {
  if (a.libm === b.libm) return t.allow.find((r) => r.a === 'exact') ?? null;
  for (const r of t.allow) {
    if (r.a === 'exact' || !r.b) continue;
    if ((r.a === a.tag && r.b === b.tag) || (r.a === b.tag && r.b === a.tag)) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client → relay
// ---------------------------------------------------------------------------

/** An opaque order tuple. The relay orders these and never looks inside one. */
export type OpBlob = unknown[];

export interface MsgHello { k: 'hello'; v: number; want: 'host' | 'join' }
/**
 * `factions[slot]` is worked out by the *client* from the config — who garrisons and who
 * storms is game content, and the relay is deliberately ignorant of game content. It is
 * carried here so the packet is self-describing and a gate can assert on it; the relay echoes
 * slot 0's answer and never computes one.
 */
export interface MsgReady { k: 'ready'; print: BootPrint; cfg: unknown; factions: number[] }
/**
 * The host's battle, published the instant the menu closes and before anything is loaded.
 *
 * Separate from `ready` so the two clients load in parallel. Folding it in would make the
 * challenger wait for the host to finish building a full-scale siege before it could start
 * building its own, which on this machine roughly doubles the time to the first turn.
 */
export interface MsgSetup { k: 'setup'; cfg: unknown; deployPhase: boolean }
/** Ops this client wants applied. `seq` is per-slot and monotonic; it is the tiebreak. */
export interface MsgOps { k: 'ops'; ev: OpBlob[] }
/** A checkpoint. `uf64` is the detector; the others are confirmation and attribution. */
export interface MsgHash {
  k: 'hash'; tick: number; hash: string; uf64: string; uctl: string; alive: number;
}
/** Per-unit digests at a tick, sent on request so a desync can be attributed to a unit. */
export interface MsgProbe { k: 'probe'; tick: number; units: [number, string][] }
/** This slot has finished laying out its army. The relay emits one canonical commit. */
export interface MsgDeployReady { k: 'deployReady' }
export interface MsgPong { k: 'pong'; t: number }
export interface MsgBye { k: 'bye'; why: string }

export type ClientMsg =
  | MsgHello | MsgSetup | MsgReady | MsgOps | MsgHash | MsgProbe | MsgDeployReady
  | MsgPong | MsgBye;

// ---------------------------------------------------------------------------
// Relay → client
// ---------------------------------------------------------------------------

export interface MsgWelcome {
  k: 'welcome'; v: number; slot: number; room: string; ticksPerTurn: number;
}
/** The other slot arrived or left. `slot` is theirs, not yours. */
export interface MsgPeer { k: 'peer'; slot: number; state: 'joined' | 'ready' | 'left' }
/** The challenger's copy of the host's battle. Sent before `ready` is expected of them. */
export interface MsgConfig { k: 'config'; cfg: unknown; deployPhase: boolean }
/**
 * The battle is on. `factions[slot]` is the faction that slot commands; everything else on
 * the field is AI on **both** clients, which is what makes the two simulations one battle.
 */
export interface MsgStart {
  k: 'start'; factions: number[]; phase: 'deploy' | 'battle'; delay: number;
  /**
   * What the lobby knows about this pairing, in the words of the rule that allowed it.
   *
   * Carried to the client because a match that is *expected* to fork should say so before it
   * starts rather than after. A player who has been told "Firefox against Chromium parts
   * company somewhere after three and a half minutes" and plays anyway has agreed to
   * something; one who finds out at t+230 has been ambushed by their own browser.
   */
  pairNote: string;
  willFork: boolean;
}
/** A refusal, by name. Nothing half-joins: a refused client is closed. */
export interface MsgRefuse { k: 'refuse'; why: string; detail?: string }
/**
 * One turn, closed. `ops` is in canonical order — sorted by `(slot, seq)` — and every one of
 * them executes at tick `t`.
 *
 * Sorted rather than left in arrival order deliberately. Arrival order at a single-threaded
 * Durable Object *is* a total order, so it would be correct; but then the packet's contents
 * would depend on the relay's event-loop interleaving, and a bug there would be invisible.
 * `(slot, seq)` is checkable from the packet alone.
 *
 * `t` is `turnTick(n)` in the battle phase and 0 in the deployment phase, where the clock is
 * stopped and there is no next tick to defer to — what has to be canonical there is the
 * *sequence*, and the sequence is this array. `ph` is carried because the two phases number
 * their turns separately: renumbering one counter at the phase flip would make `n` ambiguous
 * in exactly the packet where a reader most wants to be certain.
 */
export interface MsgTurn {
  k: 'turn'; ph: 'deploy' | 'battle'; n: number; t: number; ops: TurnOp[];
}
export interface TurnOp { s: number; i: number; e: OpBlob }
/** The clients' checkpoints disagreed. `layer` names which of the three hashes moved first. */
export interface MsgDesync {
  k: 'desync'; tick: number; layer: 'uf64' | 'uctl' | 'pool' | 'alive';
  mine: string; theirs: string; lastAgreedTick: number;
}
/** Which units differ, from the per-unit digests. Empty when the digests could not be had. */
export interface MsgAttrib { k: 'attrib'; tick: number; units: number[]; note: string }
/** Send me `probe` for this tick. */
export interface MsgWantProbe { k: 'wantProbe'; tick: number }
/** The session is over, for a stated reason, at a stated tick. Never a silent hang. */
export interface MsgEnd { k: 'end'; why: EndReason; atTick: number; detail: string }
export type EndReason = 'desync' | 'peerLeft' | 'complete' | 'refused' | 'abandoned';
export interface MsgPing { k: 'ping'; t: number }

export type RelayMsg =
  | MsgWelcome | MsgPeer | MsgConfig | MsgStart | MsgRefuse | MsgTurn
  | MsgDesync | MsgAttrib | MsgWantProbe | MsgEnd | MsgPing;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/**
 * Room-code alphabet: no `I`, `O`, `0`, `1`. A code is read aloud or typed from a screenshot,
 * and `idFromName(roomCode)` on the Durable Object side means a mistyped code silently opens
 * an empty room rather than failing — so the cheapest fix is an alphabet without the pairs
 * people confuse.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 5;

/** True for a well-formed room code. Case is normalised by the caller, not here. */
export const validCode = (s: string): boolean =>
  s.length === CODE_LEN && [...s].every((c) => CODE_ALPHABET.includes(c));

/**
 * The libm fingerprint: FNV-1a over the exact float64 bits of every approximated `Math`
 * result this simulation can reach, over inputs generated by integer-only arithmetic.
 *
 * Integer-generated inputs matter and are the reason five separate passes trusted their own
 * numbers: the input bit vector is *asserted* identical in every engine rather than hoped to
 * be, so a difference in the output is a difference in the implementation and not in the
 * input. `sqrt` and `a * b + c` are carried as controls for the same reason — IEEE-754
 * requires both to be correctly rounded, so a fingerprint whose controls differ is measuring
 * something other than libm and must be disbelieved.
 *
 * Lives here rather than in `src/sim` because it is a *lobby* instrument: nothing in the
 * simulation may call it, and `tools/check-determinism.mjs` scans `src/sim`, `src/ai` and
 * `src/units` for exactly these calls. Costs about 0.5 ms.
 */
export function libmPrint(samples = 512): string {
  const dv = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const byte = (u: number): void => { h = Math.imul(h ^ (u & 0xff), 0x01000193) >>> 0; };
  const u32 = (u: number): void => { byte(u); byte(u >>> 8); byte(u >>> 16); byte(u >>> 24); };
  const f64 = (v: number): void => {
    dv.setFloat64(0, v); u32(dv.getUint32(0)); u32(dv.getUint32(4));
  };
  // A 32-bit LCG over integers only, so every engine feeds the same bits in.
  let s = 0x9e3779b9 >>> 0;
  const nextInt = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < samples; i++) {
    const a = nextInt();
    const b = nextInt();
    // Ratios of integers: exactly representable numerators and denominators, so the argument
    // is a float64 with an identical bit pattern everywhere.
    const x = (a >>> 8) / 8388608;             // [0, 512)
    const y = (b >>> 8) / 8388608;
    const u = (a % 2000001) / 1000000 - 1;     // [-1, 1]
    f64(Math.sin(x)); f64(Math.cos(x)); f64(Math.tan(x));
    f64(Math.exp(x % 16)); f64(Math.log(x + 1));
    f64(Math.atan2(y - 256, x - 256)); f64(Math.atan(u));
    f64(Math.asin(u)); f64(Math.acos(u));
    f64(Math.pow(x + 1, 1.5)); f64(Math.cbrt(x)); f64(Math.hypot(x, y));
    // Controls. IEEE-754 requires both correctly rounded, and JS has no fused multiply-add.
    f64(Math.sqrt(x)); f64(x * y + u);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
