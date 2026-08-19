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
import type { BattleSystem } from '../sim/BattleSystem';
import { BREAK_IN, INSIDE_MARGIN, STORM_STALL_SECONDS } from '../sim/BattleFlow';
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

interface FlowView {
  objective?: {
    stormOnWall: number;
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
    progress: pct(o.stormInside, o.needInside),
    mine: role === 'storm',
    inside: o.stormInside,
    needInside: o.needInside,
    insideMargin: o.insideMargin,
    onWall: o.stormOnWall,
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
 * Which of the five it is, taking the furthest thing that has happened.
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
  wall: {
    storm: {
      label: 'The Wall Reached',
      note: (o) => (o.stormOnWall > 0
        ? `${o.stormOnWall} of ours on the parapet against ${o.garrisonOnWall} of theirs`
        : 'The ramps are down; get men onto the walk'),
    },
    garrison: {
      label: 'The Wall Reached',
      note: (o) => (o.stormOnWall > 0
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

/** The live objective, in the fewest words that still name both numbers. */
function objectiveLine(role: 'storm' | 'garrison', o: Obj): string {
  return role === 'storm'
    ? `${o.stormInside} of ${o.needInside} inside`
    : `${o.stormInside} of ${o.needInside} inside — hold`;
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
      + 'curtain &mdash; through the gate or down off the parapet. Killing the garrison alone '
      + 'will not do it, and neither will standing on the wall.'
    : `${n('To hold the city')}: keep them under ${n(BREAK_IN)} men ${n(`${INSIDE_MARGIN} m`)} `
      + 'past the curtain, and keep the walk manned. A storm that makes no ground for '
      + `${n(`${Math.round(STORM_STALL_SECONDS / 60)} minutes`)} is thrown back.`;
}

/** Which side of the wall the player is on before the battle has run a tick. */
export function siegeRole(garrison: Faction | undefined): 'storm' | 'garrison' {
  return garrison === PLAYER_FACTION ? 'garrison' : 'storm';
}
