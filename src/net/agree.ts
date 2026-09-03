import {
  engineTag, pairRule,
  type BootPrint, type PairTable,
} from './protocol.ts';

/**
 * The two judgements a session has to make about the other side, in one place.
 *
 * ## Why this file was carved out of `room.ts`
 *
 * There are now **two** schedulers — `Room`, which closes turns on a relay's wall clock, and
 * `PeerRoom`, which closes them on the two peers' own commits — and they are genuinely
 * different algorithms. What they are not is two different opinions about whether these two
 * clients may play one battle, or about which checkpoint layer ended it. Those two questions
 * have exactly one right answer and it is measured, at length, in `docs/MULTIPLAYER.md` §1.4
 * and §1.5; a second copy of either would be the failure `protocol.ts`'s own docstring opens by
 * refusing, and here it would present as *one transport refusing a pairing the other allows*,
 * which is the worst possible shape for a rule about determinism.
 *
 * So: one handshake, one comparator, two schedulers. `Room` calls both of these and so does
 * `PeerRoom`, and `tools/qa-p2p.mjs`'s `proto-both-transports-agree` check drives both over their
 * own message interfaces and requires the identical verdict on five pairings — because "they call
 * the same function" is a claim about today's source and not about the behaviour.
 *
 * ## Erasable-only TypeScript, inherited
 *
 * `room.ts` is imported by `tools/relay.mjs` (Node 24, which strips types at load) and by
 * `net/worker.ts`. Anything `room.ts` imports inherits that constraint: no `enum`, no
 * `namespace`, no parameter properties, no `declare`. Nothing here needs any of them.
 */

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

/** A refusal, by name, with a sentence a player can act on. */
export interface Refusal { why: string; detail: string }

/**
 * What the handshake decided: a refusal, or a note about a pairing that was allowed.
 *
 * `pairNote` and `willFork` are carried out rather than written into the caller, because the
 * caller is two different classes and a function that mutates `this.pairNote` cannot be shared
 * by both of them without one of them growing a field it does not otherwise want.
 */
export interface Verdict {
  refuse: Refusal | null;
  pairNote: string;
  willFork: boolean;
}

/**
 * May these two clients play one battle? The verdict, and the same one on both transports.
 *
 * Order matters here and it is the reason this reads as a ladder rather than a set of
 * predicates. The *config* is checked first, then the *army* the config produced, then the
 * *state* that army starts in, then the *build*. Each is a strictly stronger claim than the
 * last and the earlier failures have much better error messages, so a player who picked a
 * different map is told that rather than being told their libm disagrees.
 *
 * Lifted verbatim out of `Room.mismatch` on 2 September 2026. Every clause is a measurement
 * from `docs/MULTIPLAYER.md`, cited on `BootPrint`; nothing about the reasoning changed in the
 * move, and `tools/qa-p2p.mjs`'s `proto-both-transports-agree` is what keeps it from drifting.
 */
export function agree(pairs: PairTable, a: BootPrint, b: BootPrint): Verdict {
  const no = (why: string, detail: string): Verdict =>
    ({ refuse: { why, detail }, pairNote: '', willFork: false });
  /*
   * The tick index, first, because it is the one clause that makes every clause after it
   * mean anything.
   *
   * Two clients that announce from different ticks are not desynced — they were never
   * synced, and every checkpoint they exchange afterwards compares different points in the
   * same battle. The failure has a specific shape that looks like a determinism bug and is
   * not one: a `uctl` difference at t+0, which is a *control-flow* disagreement before a
   * tick was supposed to have run, and rounding cannot take that shape. `NetSession.init`
   * pins the tick ceiling to 0 so this cannot happen; this refuses the day it does.
   */
  if (a.tick0 !== 0 || b.tick0 !== 0) {
    return no('tick',
      `a client announced from tick ${a.tick0} and the other from ${b.tick0}; both `
      + 'must be 0. The frame loop starts before the page reports itself ready, so a '
      + 'client whose clock is not held runs ticks while its opponent loads.');
  }
  if (a.cfgKey !== b.cfgKey) {
    return no('config', 'the two clients are set up for different battles');
  }
  if (a.unitScale !== b.unitScale || a.count0 !== b.count0) {
    return no('army',
      `different armies: ${a.count0} men at unit scale ${a.unitScale} (tier `
      + `'${a.quality}') against ${b.count0} at ${b.unitScale} ('${b.quality}'). `
      + 'The graphics tier fixes quality.maxSoldiers and fittedUnitScale fits the army '
      + 'to it, so this is a simulation difference and not a rendering one.');
  }
  if (a.hash !== b.hash || a.uf64 !== b.uf64 || a.uctl !== b.uctl) {
    const which = a.hash !== b.hash ? 'pool' : a.uctl !== b.uctl ? 'uctl' : 'uf64';
    return no('build',
      `the armies differ before a tick has run (${which}: `
      + `${a.hash}/${a.uf64}/${a.uctl} against ${b.hash}/${b.uf64}/${b.uctl}). `
      + 'One of these is a different build of the game.');
  }
  const ta = engineTag(a.ua);
  const tb = engineTag(b.ua);
  const rule = pairRule(pairs, { libm: a.libm, tag: ta }, { libm: b.libm, tag: tb });
  if (rule) return { refuse: null, pairNote: rule.note, willFork: rule.willFork };
  if (pairs.unknown === 'allow') {
    return {
      refuse: null,
      willFork: true,
      pairNote: `unlisted pairing ${ta}+${tb} (${a.libm} against ${b.libm}), allowed `
        + 'by --unknown=allow. Nothing is known about whether it holds.',
    };
  }
  const same = ta === tb;
  return no('libm',
    `these two browsers compute Math differently (${a.libm} against ${b.libm}) `
    + `and ${ta}+${tb} is not an allowed pairing. `
    + (same
      ? 'Same engine, different libm generation, which is not the same as a different '
        + 'version: Chromium 143, 147 and 149 are bit-identical on all fourteen '
        + 'approximated functions, and 149 to 151 changes twelve of them and ended a '
        + 'ten-minute field battle 42% apart (docs/MULTIPLAYER.md §1.5, §9.5). '
      : '')
    + `'${a.ua}' against '${b.ua}'. `
    + 'Allowed pairings: '
    + pairs.allow.map((r) => (r.a === 'exact' ? 'exact' : `${r.a}+${r.b}`)).join(', ')
    + '. Start the relay with --unknown=allow to play anyway.');
}

// ---------------------------------------------------------------------------
// The checkpoint comparator
// ---------------------------------------------------------------------------

/** One checkpoint from one client. Four layers, and which of them is fatal is an option. */
export interface Mark { hash: string; uf64: string; uctl: string; alive: number }

export type Layer = 'uf64' | 'uctl' | 'pool' | 'alive';

/** The default, and the order is the report's order. See `firstDisagreement`. */
export const DEFAULT_FATAL: Layer[] = ['uf64', 'uctl', 'pool', 'alive'];

/**
 * Which layer parted company first, or null if every layer that counts agreed.
 *
 * **`uf64` is the detector and the pool hash is the confirmation, and that order is measured,
 * not stylistic.** Over one run on 21 August 2026 the float64 unit layer diverged at t+30 in
 * both Firefox and WebKit while the float32 pool hash held all the way to t+200 — seven
 * checkpoints and about 170 simulated seconds of warning. The mechanism is §1.4: every tick
 * reads float32, computes in float64 and writes float32, and that quantisation is a firewall
 * with about 29 bits of headroom against 1–3 ULP of libm disagreement. `UnitGroupState` has no
 * such firewall. A session that watched the pool hash would find its desync nearly two orders
 * of magnitude later in simulated time, by which point the battle it would have to name is
 * long gone.
 *
 * `uctl` sits second because a *discrete* disagreement is a much more serious finding than a
 * continuous one: it means the two battles took different decisions rather than computing the
 * same one to different last bits. The list is a parameter rather than a constant because
 * which layer deserves to be fatal changed twice in one day; see `RoomOptions.fatal`.
 */
export function firstDisagreement(mine: Mark, theirs: Mark, fatal: Layer[]): Layer | null {
  const differs: Record<Layer, boolean> = {
    uf64: mine.uf64 !== theirs.uf64,
    uctl: mine.uctl !== theirs.uctl,
    pool: mine.hash !== theirs.hash,
    alive: mine.alive !== theirs.alive,
  };
  return fatal.find((l) => differs[l]) ?? null;
}

/** One layer's value out of a mark, as the string a report prints. */
export function layerValue(m: Mark, layer: Layer): string {
  return layer === 'uf64' ? m.uf64
    : layer === 'uctl' ? m.uctl
      : layer === 'pool' ? m.hash
        : String(m.alive);
}

/**
 * Which units differ, from the two sets of per-unit digests. The attribution half.
 *
 * 35 units × one 32-bit hash is 300 bytes and it turns "the battle forked at tick 1,410" into
 * "unit 17 forked at tick 1,410", which is the difference between a bug report and a shrug.
 * Age of Empires debugged desyncs with 50 MB message traces and world dumps; this is the same
 * idea at a size that can be sent on the tick it happens.
 *
 * A unit present on one side and absent on the other counts as differing — that is the
 * `deployment.add` hazard of §4.1, where one extra `add` mints a regiment the other client does
 * not have, and it is the one case a digest-by-digest comparison would miss entirely.
 */
export function probeDiff(mine: [number, string][], theirs: [number, string][]): number[] {
  const mineMap = new Map(mine);
  const theirIds = new Set(theirs.map((t) => t[0]));
  const diff: number[] = [];
  for (const [id, h] of theirs) if (mineMap.get(id) !== h) diff.push(id);
  for (const [id] of mine) if (!theirIds.has(id)) diff.push(id);
  diff.sort((x, y) => x - y);
  return diff;
}

/** The sentence that goes with a diff, including the one that says "look lower down". */
export function probeNote(diff: number[], total: number, tick: number): string {
  return diff.length
    ? `${diff.length} of ${total} units differ at tick ${tick}`
    : `all ${total} unit digests agree at tick ${tick}; the difference is `
      + 'below the unit layer — look in the soldier pool';
}
