/**
 * What the storm is doing, in the words a plaque can print.
 *
 * The playtest that produced this file could win the siege of Carthage and could not say
 * why: at t+982, with the gate broken and two towers docked against the parapet, the top
 * plaque read **"MISSILE EXCHANGE · Arrows and pila in the air · Evenly matched"**. Every
 * phase the HUD knew was a field-battle phase, the objective was stated nowhere at all, and
 * the end-of-battle dispatch never mentioned the wall. So the one thing that decides a storm
 * was the one thing the interface never showed.
 *
 * This module is the single reader. Three panels print from it — the deployment plaque, the
 * top plaque and the dispatch — and none of them re-derives a threshold or a phase, because
 * three panels each deciding for itself what "the breach" means is how they come to disagree.
 *
 * **Nothing here is a constant of the rules.** `BattleFlowSystem.objective` publishes the
 * thresholds it enforces and `Siege`'s own reports publish the machines; this file only turns
 * them into sentences. A number typed here would be a second copy of a rule.
 */

import type { EngineContext } from '../core/Engine';
import type { WallRefusal, WallVerb } from '../core/events';
import type { BattleSystem } from '../sim/BattleSystem';
import {
  BREAK_IN, INSIDE_MARGIN, STORM_STALL_SECONDS, WALL_FOOTHOLD, WALL_HOLD_SECONDS,
} from '../sim/BattleFlow';
import { Faction } from '../sim/types';
import { PLAYER_FACTION } from './theme';

/**
 * The five things that happen at a wall, in the order they happen.
 *
 * The order is `derivePhase`'s own, read backwards: it returns the *furthest* thing that has
 * happened, so its first test is the last phase. `wall` outranks `ram` because men on the
 * parapet is further on than the ram having struck, and a storm is usually doing both.
 * This union listed them `approach | wall | ram | …` under a comment claiming they were in
 * order, which is the one place a reader would look to find out which of the two comes first.
 */
export type SiegePhase = 'approach' | 'ram' | 'wall' | 'breach' | 'streets';

export interface SiegeRead {
  /** Which side of it the player is on. */
  role: 'storm' | 'garrison';
  phase: SiegePhase;
  /** Plaque heading and its one-line gloss, both written from the player's side. */
  label: string;
  note: string;
  /** The objective, as a sentence and as a bar. */
  objective: string;
  progress: number;
  /** True when the progress is the player's to make, false when it is theirs to stop. */
  mine: boolean;

  inside: number;
  needInside: number;
  insideMargin: number;
  onWall: number;
  /** Of `onWall`, the men on parapet the garrison has stopped contesting — the number the
   *  wall half of the objective is actually decided on. */
  holding: number;
  garrisonOnWall: number;
  needFoothold: number;
  heldFor: number;
  holdSeconds: number;
  stalledFor: number;
  stallSeconds: number;

  gate: { breached: boolean; open: boolean; blows: number; hp: number };
  /** Bays the great ram has brought down. Always empty today — see `readSiege`. */
  breachedBays: number;
  machines: { towers: number; rams: number; ladders: number; crossing: number };
}

export interface FlowView {
  objective?: {
    stormOnWall: number;
    stormHolding: number;
    garrisonOnWall: number;
    stormInside: number;
    heldFor: number;
    storm: Faction;
    garrison: Faction;
    needInside: number;
    insideMargin: number;
    needFoothold: number;
    holdSeconds: number;
    stallSeconds: number;
    stalledFor: number;
  } | null;
}

const pct = (n: number, of: number): number => (of > 0 ? Math.max(0, Math.min(1, n / of)) : 0);

/**
 * Why the wall will not take this order, in the words the player reads.
 *
 * The best writing in this product is its refusals — *"No way along the wall to bay 5 — the
 * walk is broken in between"* teaches a player the map in one sentence — and until now there
 * was exactly one of them, wired to one of `traverseOfferAt`'s four answers. Every other
 * refused wall order was dropped in silence: a judge issued four the cursor had offered and
 * closed 0 m of all four, `goal` never leaving `none`.
 *
 * Two callers, and that is the point of putting it here. `SelectionController` reads it on
 * hover, where a refusal can still stop the player committing; `EventFeed` reads it on
 * `orderRefused`, for the refusals only the simulation can see, a tick after the click. One
 * vocabulary, one set of words, so the two answers cannot contradict each other.
 *
 * A `Record<WallRefusal, …>`: a new reason does not compile until it has a sentence.
 */
export const WALL_REFUSAL: Record<WallRefusal, (bay: number, verb: WallVerb) => string> = {
  notOnWall: () => 'These men are not on the wall — send them up it first',
  noWall: () => 'There is no walk there to send them along',
  noRoute: (bay) =>
    `No way along the wall to ${where(bay)} — the walk is broken in between`,
  noStair: (bay, verb) => NO_STAIR[verb](where(bay)),
  busy: () => 'They are already on their way — let them finish it',
};

/**
 * `noStair` reads two ways and the verb decides which.
 *
 * The first cut of this printed the *descent* sentence — "no steps join bay 1 to the ground" —
 * over three cohorts standing in the street who had been told to climb onto it. True of the
 * masonry, wrong about the order, which is precisely the fault this pass exists to remove.
 * A `Record<WallVerb, …>`, so a fourth verb cannot skip its wording.
 */
const NO_STAIR: Record<WallVerb, (w: string) => string> = {
  ascend: (w) => `No steps reach ${w} from the ground — there is no way up here`,
  descend: (w) => `No steps join ${w} to the ground — they cannot get down here`,
  traverse: (w) => `No steps reach ${w} — the walk cannot be joined here`,
};

/** "bay 5", or "that stretch" when the order did not land on one. */
const where = (bay: number): string => (bay >= 0 ? `bay ${bay}` : 'that stretch');

/**
 * Agreement for the counts these lines are built from, which start at one and pass through it
 * in both directions.
 *
 * "1 of ours are past the curtain" and "the gate is standing — 1 blows in" both reached a
 * screenshot. A siege spends real time at exactly one of most of these — one man through the
 * breach, the first blow on the gate — so it is the reading a player is most likely to be
 * staring at when they are trying to work out what the plaque means.
 */
const be = (n: number): string => (n === 1 ? 'is' : 'are');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Read the storm off the running battle, or null if this is not one.
 *
 * `BattleFlowSystem.objective` is the test as well as the source: it is non-null exactly when
 * the arbiter has found a garrison on a wall, which is the same condition under which the
 * battle can be won by taking it. Asking the map, the scenario id or the presence of a city
 * would each answer a slightly different question and one of them would eventually be wrong.
 *
 * `breachedBays` is reported and is always zero in a shipped battle: `Siege.breachReport()`
 * counts what the **great** ram has brought down, `spawnGreatRam` has no caller in `src/`,
 * and the gate ram sets `gateBreached` without ever touching a bay. The two are different
 * events and the gate is the one that happens; see the report.
 */
export function readSiege(ctx: EngineContext): SiegeRead | null {
  const flow = ctx.tryGet('battleFlow') as unknown as FlowView | undefined;
  const o = flow?.objective;
  if (!o) return null;
  const battle = ctx.tryGet<BattleSystem>('battle');
  if (!battle) return null;

  const gate = battle.siege.gateReport();
  const breach = battle.siege.breachReport();
  const st = battle.siege.stats();
  const role: 'storm' | 'garrison' = PLAYER_FACTION === o.garrison ? 'garrison' : 'storm';

  const phase = derivePhase(o, gate, breach.bays.length, st.crossing);
  const copy = PHASE_COPY[phase][role];

  return {
    role,
    phase,
    label: copy.label,
    note: copy.note(o, gate),
    objective: objectiveLine(role, o),
    progress: objectiveProgress(o),
    mine: role === 'storm',
    inside: o.stormInside,
    needInside: o.needInside,
    insideMargin: o.insideMargin,
    onWall: o.stormOnWall,
    holding: o.stormHolding,
    garrisonOnWall: o.garrisonOnWall,
    needFoothold: o.needFoothold,
    heldFor: o.heldFor,
    holdSeconds: o.holdSeconds,
    stalledFor: o.stalledFor,
    stallSeconds: o.stallSeconds,
    gate: { breached: gate.breached, open: gate.open, blows: gate.blows, hp: gate.hp },
    breachedBays: breach.bays.length,
    machines: { towers: st.towers, rams: st.rams, ladders: st.ladders, crossing: st.crossing },
  };
}

type Obj = NonNullable<FlowView['objective']>;
type Gate = ReturnType<BattleSystem['siege']['gateReport']>;

/**
 * Which of the five it is, taking the furthest thing that **is** happening.
 *
 * Not the furthest thing that *has* happened: this reads the wall's current state, so a phase
 * can go backwards, and does. Measured on a defence of Rome — t+206 "In the Streets, 1 of them
 * is past the curtain", t+227 "The Approach, their engines are coming on" — because the last
 * man inside had been killed and the storm was re-forming for another run at it. That is the
 * true reading and the useful one for a garrison, but a reader who took "has happened" at face
 * value would expect a ratchet and write code against one.
 *
 * Read off events at the wall rather than off the clock or the distance between two armies,
 * which is what the field-battle phases do and why they were useless here: two hosts three
 * hundred metres apart with a wall between them are not "closing the ground", and men
 * shooting at each other across a parapet for twelve minutes are not a missile exchange that
 * is about to become a clash.
 */
function derivePhase(o: Obj, gate: Gate, breachedBays: number, crossing: number): SiegePhase {
  if (o.stormInside > 0) return 'streets';
  if (gate.breached || breachedBays > 0) return 'breach';
  if (o.stormOnWall > 0 || crossing > 0) return 'wall';
  if (gate.blows > 0) return 'ram';
  return 'approach';
}

/**
 * The plaque's words, per phase and per side.
 *
 * Both sides, because a storm and a defence are not the same battle with the names swapped:
 * "the ladders are on the parapet" is a milestone to one army and an emergency to the other,
 * and a plaque that says the first to a defender is telling them nothing they can act on.
 */
const PHASE_COPY: Record<
  SiegePhase,
  Record<'storm' | 'garrison', { label: string; note: (o: Obj, g: Gate) => string }>
> = {
  approach: {
    storm: {
      label: 'The Approach',
      note: () => 'The train is coming up under their shot',
    },
    garrison: {
      label: 'The Approach',
      note: () => 'Their engines are coming on; shoot them off the field',
    },
  },
  ram: {
    storm: {
      label: 'The Ram at the Gate',
      note: (_o, g) => `The gate is standing — ${plural(g.blows, 'blow')} in, `
        + `${Math.round(g.hp * 100)}% left`,
    },
    garrison: {
      label: 'The Ram at the Gate',
      note: (_o, g) => `The gate is holding at ${Math.round(g.hp * 100)}% — kill the crew`,
    },
  },
  /*
   * The one line here that is not a headcount is `stormHolding`, and it is the line that
   * matters. `garrisonOnWall` is a sum over the whole circuit — 810 men over 1.78 km of
   * Aurelian Wall — so "42 of ours on the parapet against 655 of theirs" is true, useless and
   * quietly discouraging: it names a number the storm can do nothing about and says nothing
   * about the bay the fight is actually in. The arbiter decides the wall on the men holding a
   * stretch the garrison has stopped contesting, so that is what the plaque leads with the
   * moment there are any, and the circuit-wide pair is what it falls back to.
   */
  wall: {
    storm: {
      label: 'The Wall Reached',
      note: (o) => (o.stormHolding > 0
        ? `${o.stormHolding} of ours hold a stretch of it — ${o.needFoothold} for `
          + `${o.holdSeconds} s takes the wall`
        : o.stormOnWall > 0
          ? `${o.stormOnWall} of ours on the parapet against ${o.garrisonOnWall} of theirs`
          : 'The ramps are down; get men onto the walk'),
    },
    garrison: {
      label: 'The Wall Reached',
      note: (o) => (o.stormHolding > 0
        ? `${o.stormHolding} of them hold a stretch of it — get back onto that bay`
        : o.stormOnWall > 0
          ? `${o.stormOnWall} of them on the parapet against ${o.garrisonOnWall} of ours`
          : 'They are at the stone; keep the walk clear'),
    },
  },
  breach: {
    storm: {
      label: 'The Breach',
      note: () => 'The way in is open — put a column through it',
    },
    garrison: {
      label: 'The Breach',
      note: () => 'The way in is open — plug it with the reserve',
    },
  },
  streets: {
    storm: {
      label: 'In the Streets',
      note: (o) => `${o.stormInside} of ours ${be(o.stormInside)} past the curtain`,
    },
    garrison: {
      label: 'In the Streets',
      note: (o) => `${o.stormInside} of them ${be(o.stormInside)} past the curtain`,
    },
  },
};

/**
 * The live objective, in the fewest words that still name both numbers.
 *
 * **Two conditions decide a storm and this line only ever named one of them.** It read
 * `${o.stormInside} of ${o.needInside} inside` unconditionally. Measured over 24 seeds of
 * Rome's assault at `cc72ea6`, **9 of the 24 are decided by the other one** — the lodgement:
 * `needFoothold` men holding a stretch of parapet the garrison has stopped standing on, for
 * `holdSeconds` — and on every one of those seeds the break-in count this line prints is at
 * or near zero while it happens. Played from the defending chair the top plaque therefore
 * read *"0 of 60 inside — hold"* right up to the moment the city fell, with six hundred
 * Romans still on the wall and nine hundred alive. There is no other channel: the deployment
 * plaque states the rule once, before a shot is fired, and then nothing on screen ever
 * mentions it again.
 *
 * The lodgement outranks the break-in whenever it exists, because it is a **countdown** — a
 * number that reaches its threshold in a fixed number of seconds unless somebody does
 * something about it — where a break-in count is not. Below the foothold it is still named,
 * because "17 of 24 on a stretch of ours" is the warning and there is no other.
 *
 * No threshold is typed here. All four numbers come off `BattleFlowSystem.objective`, which
 * is the thing that enforces them, for the reason this module's header gives.
 */
function objectiveLine(role: 'storm' | 'garrison', o: Obj): string {
  if (o.stormHolding >= o.needFoothold) {
    const left = Math.max(0, Math.ceil(o.holdSeconds - o.heldFor));
    return role === 'storm'
      ? `${plural(o.stormHolding, 'man', 'men')} hold a stretch — ${left} s to take the wall`
      : `${plural(o.stormHolding, 'man', 'men')} hold a stretch of ours — ${left} s to clear it`;
  }
  if (o.stormHolding > 0) {
    return role === 'storm'
      ? `${o.stormHolding} of ${o.needFoothold} on a cleared stretch`
      : `${o.stormHolding} of ${o.needFoothold} on a stretch of ours`;
  }
  return role === 'storm'
    ? `${o.stormInside} of ${o.needInside} inside`
    : `${o.stormInside} of ${o.needInside} inside — hold`;
}

/**
 * The bar under the line, following whichever condition the line is naming.
 *
 * It followed the break-in alone, so on the nine seeds in twenty-four that end on a lodgement
 * the bar was at zero when the city fell. The lodgement is two halves — gather
 * `needFoothold` men on a cleared stretch, then keep them there for `holdSeconds` — so it
 * fills the bar in two halves, and the bar is the nearer of the two conditions rather than a
 * blend of them, because a blend would move when neither is moving.
 */
function objectiveProgress(o: Obj): number {
  const lodgement = o.stormHolding >= o.needFoothold
    ? 0.5 + 0.5 * pct(o.heldFor, o.holdSeconds)
    : 0.5 * pct(o.stormHolding, o.needFoothold);
  return Math.max(pct(o.stormInside, o.needInside), lodgement);
}

/**
 * The objective, spelled out before a shot is fired. Printed on the deployment plaque.
 *
 * Static, because during deployment the clock is held and `BattleFlowSystem` has not run a
 * tick — it has no sides, no wall and no census, so `readSiege` cannot answer. The constants
 * are imported from the arbiter rather than retyped, so this sentence cannot promise a rule
 * the sim does not enforce.
 */
export function objectiveBrief(role: 'storm' | 'garrison'): string {
  const n = (v: string | number): string => `<b style="color:var(--gold-bright)">${v}</b>`;
  return role === 'storm'
    ? `${n('To take the city')}: get ${n(BREAK_IN)} men ${n(`${INSIDE_MARGIN} m`)} past the `
      + 'curtain &mdash; through the gate or down off the parapet &mdash; or take a stretch of '
      + `parapet and hold ${n(WALL_FOOTHOLD)} men on it for ${n(`${WALL_HOLD_SECONDS} s`)} with `
      + 'no defender left standing on that stretch. Killing the garrison alone will not do it.'
    : `${n('To hold the city')}: keep them under ${n(BREAK_IN)} men ${n(`${INSIDE_MARGIN} m`)} `
      + 'past the curtain, and never leave them a bay: '
      + `${n(WALL_FOOTHOLD)} of them holding a stretch with nobody of ours standing on it for `
      + `${n(`${WALL_HOLD_SECONDS} s`)} is the wall gone. A storm that makes no ground for `
      + `${n(`${Math.round(STORM_STALL_SECONDS / 60)} minutes`)} is thrown back.`;
}

/** Which side of the wall the player is on before the battle has run a tick. */
export function siegeRole(garrison: Faction | undefined): 'storm' | 'garrison' {
  return garrison === PLAYER_FACTION ? 'garrison' : 'storm';
}
