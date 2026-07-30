import { Engine, type QualityTier } from './core/Engine';

// --- world ---
import { SkySystem } from './render/SkySystem';
import { LightingSystem } from './render/LightingSystem';
import { TerrainSystem } from './terrain/TerrainSystem';
import { CitySystem } from './city/CitySystem';

// --- simulation ---
import { BattleSystem } from './sim/BattleSystem';
import { CombatSystem } from './sim/Combat';
import { ProjectileSystem } from './sim/Projectiles';
import { MoraleSystem } from './sim/Morale';
import { AbilitySystem } from './sim/Abilities';
import { RagdollSystem } from './sim/Ragdoll';
import { BattleFlowSystem } from './sim/BattleFlow';

// --- AI ---
import { installAI } from './ai';

// --- presentation ---
import { VFXSystem } from './vfx/VFXSystem';
import { UnitRenderSystem } from './units/UnitRenderSystem';
import { AudioEngine } from './audio/AudioEngine';
import { HudSystem } from './ui/HudSystem';
import { PostFXSystem } from './render/PostFX';

import { deploySiegeOfRome } from './sim/scenario';
import { Faction } from './sim/types';

/**
 * Entry point. Builds the engine, registers every subsystem, deploys the scenario
 * and starts the loop.
 *
 * Registration order is *init* order, which matters wherever one system reads state
 * another builds during `init`. Per-frame update order is independent of this and is
 * driven by each subsystem's `order` field (see docs/ARCHITECTURE.md for the bands).
 *
 * The screenshot harness loads the same path with `?harness=1`, which pins the canvas
 * size, skips the intro fade and exposes `window.__game` so a headless browser can
 * fast-forward the battle deterministically and grab frames.
 */

const params = new URLSearchParams(location.search);
const harness = params.get('harness') === '1';
const qualityParam = (params.get('quality') as QualityTier | null) ?? (harness ? 'ultra' : 'high');
const difficulty = (params.get('difficulty') as 'easy' | 'normal' | 'hard' | 'legendary' | null) ?? 'hard';
/**
 * Which side the player commands. The other is left to the AI.
 *
 * `?autoplay=1` hands both armies to the AI, which is what the screenshot harness wants:
 * its shots need a battle that fights itself. Interactive play must never do this, or the
 * AI will fight the player for control of their own units.
 */
// Explicit `?autoplay=0` wins over the harness default, so an interaction test can load
// the harness (for `window.__game`) while still leaving Rome under player control.
const autoplay = params.has('autoplay') ? params.get('autoplay') === '1' : harness;
const playerFaction = Faction.Rome;
const aiFaction = Faction.Germanic;

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLElement | null;
const loadBar = document.getElementById('load-bar') as HTMLElement | null;
const loadText = document.getElementById('load-text') as HTMLElement | null;

const engine = new Engine({
  canvas,
  quality: qualityParam,
  fixedSize: harness
    ? { w: Number(params.get('w') ?? 1920), h: Number(params.get('h') ?? 1080) }
    : undefined,
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Sky first: lighting derives sun colour and intensity from its scattering integral,
// and PostFX samples its radiance cube for aerial perspective.
engine.add(new SkySystem());
// Lighting before any geometry exists: its constructor patches the global lighting
// shader chunks for cascaded shadows, and materials must not compile before that.
engine.add(new LightingSystem());
// Terrain installs `rig.heightAt`, which the city and the sim both sample during init.
engine.add(new TerrainSystem());
engine.add(new CitySystem());

const battle = engine.add(new BattleSystem());
engine.add(new CombatSystem());
engine.add(new ProjectileSystem());
engine.add(new MoraleSystem());
engine.add(new AbilitySystem());
engine.add(new RagdollSystem());
engine.add(new BattleFlowSystem());

// Four AI subsystems sharing one blackboard: nav grid, per-unit utility selector,
// per-faction plan, debug overlay. Registered as a bundle so their relative update
// order stays owned by the AI module rather than by this file.
//
// `commanded` is the important argument and it is not optional in practice. Left to
// its default the AI takes BOTH factions, and since it re-plans every few ticks it
// overwrites the player's orders within half a second — a move order drifted 46 m off
// target and was re-issued 23 times in ten seconds, an attack order reverted to MoveTo
// after 500 ms, and a formation change was undone as soon as the clock was unpaused.
// The player's army must be commanded by the player.
// In autoplay/harness mode the AI takes both sides so the battle fights itself.
await installAI(engine, {
  difficulty,
  commanded: autoplay ? [playerFaction, aiFaction] : [aiFaction],
});

const vfx = engine.add(new VFXSystem());
// VFX cannot write the soldier pool (not its file), so blood only dirties men once
// this sink is wired. `grime` drives a detail-texture blend in the unit renderer.
vfx.grimeSink = (i, amt) => {
  const g = battle.pool.grime;
  g[i] = Math.min(1, g[i] + amt);
};
// `cameraShake` is deliberately NOT handled here. VFXSystem already forwards it to
// `rig.shake()` internally and does not expose a switch to turn that off, so adding a
// second listener would double every impact.
engine.add(new UnitRenderSystem());
engine.add(new AudioEngine());
// The HUD needs the engine itself, not just the context: `setQuality` lives on
// Engine, so the quality-tier buttons are inert without this.
engine.add(new HudSystem({ engine }));

// Post-processing last: it takes over the final present, so everything it composites
// must already exist.
const postfx = engine.add(new PostFXSystem());
engine.renderOverride = (ctx) => postfx.render(ctx);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  await engine.initAll((frac, label) => {
    if (loadBar) loadBar.style.width = `${Math.round(frac * 100)}%`;
    if (loadText) loadText.textContent = label === 'ready' ? 'Ready' : `Preparing ${label}…`;
    engine.events.emit('loadProgress', { frac, label });
  });

  const result = deploySiegeOfRome(battle, engine.context);
  const f = result.cameraFocus;
  engine.rig.jumpTo(f.x, f.z, f.zoom, f.yaw);

  if (harness) {
    loading?.remove();
  } else {
    loading?.classList.add('done');
    setTimeout(() => loading?.remove(), 1400);
  }

  engine.start();
  engine.events.emit('loadComplete', {});
}

// The harness contract: everything a headless driver needs, and nothing more.
declare global {
  interface Window {
    __game?: {
      engine: Engine;
      battle: BattleSystem;
      ready: boolean;
      /** Run the sim forward `seconds` without waiting on real time. */
      advance(seconds: number): void;
      /** Park the camera for a repeatable screenshot. */
      setCamera(x: number, z: number, zoom: number, yaw: number): void;
      /** Sim seconds elapsed. */
      simTime(): number;
    };
  }
}

window.__game = {
  engine,
  battle,
  ready: false,
  advance: (seconds: number) => engine.advance(seconds),
  setCamera: (x, z, zoom, yaw) => engine.rig.jumpTo(x, z, zoom, yaw),
  simTime: () => engine.time.simTime,
};

boot()
  .then(() => {
    window.__game!.ready = true;
  })
  .catch((err) => {
    console.error('[boot] failed:', err);
    if (loadText) {
      loadText.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      loadText.style.color = '#e2564b';
    }
  });
