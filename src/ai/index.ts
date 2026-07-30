import type { Engine, Subsystem } from '../core/Engine';
import { Faction } from '../sim/types';
import { AIWorld } from './AIWorld';
import { AIDebugSystem } from './AIDebug';
import { GeneralAISystem } from './GeneralAI';
import { PathfindingSystem } from './Pathfinding';
import { TacticalAISystem } from './TacticalAI';
import type { Difficulty } from './types';

/**
 * AI assembly.
 *
 * Four subsystems sharing one blackboard:
 *
 *   pathfinding  40   nav grid, budgeted A*, flow fields — answers "can I get there"
 *   tactical-ai  42   per-unit utility selector          — answers "what do I do now"
 *   general-ai   45   per-faction phase machine          — answers "what is the plan"
 *   ai-debug     46   F3 overlay, off by default
 *
 * The tactical layer deliberately runs *before* the general, so it executes the plan
 * the general made on the previous tick. One tick of command latency (33 ms) is both
 * harmless and slightly more honest than an army that reacts within the same instant
 * its commander thinks.
 */

export interface AIOptions {
  difficulty?: Difficulty;
  /** Factions the AI commands. Omit one to leave it to a human. */
  commanded?: Faction[];
  /** Start with the F3 overlay on. */
  debug?: boolean;
}

export interface AIBundle {
  world: AIWorld;
  pathfinding: PathfindingSystem;
  tactical: TacticalAISystem;
  general: GeneralAISystem;
  debug: AIDebugSystem;
  all: Subsystem[];
}

export function createAI(opts: AIOptions = {}): AIBundle {
  const difficulty = opts.difficulty ?? 'hard';
  const commanded = opts.commanded ?? [Faction.Rome, Faction.Germanic];
  const world = new AIWorld();
  const pathfinding = new PathfindingSystem();
  const tactical = new TacticalAISystem(world, difficulty);
  const general = new GeneralAISystem(world, difficulty, commanded);
  const debug = new AIDebugSystem(world, tactical, general);
  return { world, pathfinding, tactical, general, debug, all: [pathfinding, tactical, general, debug] };
}

/**
 * Register the AI with an engine. Call before `initAll()` in the normal boot path;
 * pass `initNow` when attaching to an engine that is already running (the verification
 * harness does this so it can drive the AI without editing `main.ts`).
 */
export async function installAI(
  engine: Engine,
  opts: AIOptions & { initNow?: boolean } = {}
): Promise<AIBundle> {
  const bundle = createAI(opts);
  for (const s of bundle.all) engine.add(s);
  if (opts.initNow) {
    for (const s of bundle.all) await s.init?.(engine.context);
    if (opts.debug) bundle.debug.setEnabled(true, engine.context);
  }
  return bundle;
}

export { AIWorld } from './AIWorld';
export { AIDebugSystem } from './AIDebug';
export { GeneralAISystem } from './GeneralAI';
export { PathfindingSystem, NavGrid, FlowField, footprintOf, narrowestFormation } from './Pathfinding';
export { TacticalAISystem } from './TacticalAI';
export { OrderBook } from './Orders';
export { AIProfile, setAIProfiling } from './profile';
export { DIFFICULTY, combatPower, defensivePower, matchup, missileValue } from './types';
export type { Difficulty, DifficultyProfile, AIRole, BattlePhase, UnitCommand } from './types';
export type { NavPath, Footprint } from './Pathfinding';
export type { PerceivedEnemy, UnitInfo, FactionView } from './AIWorld';
export type { FactionPlan } from './GeneralAI';
