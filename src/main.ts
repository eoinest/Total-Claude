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

import { DeploymentSystem } from './sim/deployment';
import { MenuBackdrop } from './ui/MenuBackdrop';
import { loreFor } from './ui/lore';
import { getMap, type MapId } from './maps';
import { deployBattle } from './sim/scenario';
import { type Difficulty, type ScenarioId, sanitiseConfig } from './sim/battleConfig';
import { MainMenu, resolveConfig } from './ui/MainMenu';
import { ALL_FACTIONS, Faction } from './sim/types';
import { installSeamCheck } from './core/seams';
import { decodeReplay, type ReplayRecord, ReplaySystem } from './sim/replay';
import { stateHashes, UNIT_CTL_FIELDS, UNIT_F64_FIELDS } from './sim/stateHash';

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
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLElement | null;
const loadBar = document.getElementById('load-bar') as HTMLElement | null;
const loadText = document.getElementById('load-text') as HTMLElement | null;

/**
 * The historical card's rotation handle, so it can be stopped when the panel goes.
 *
 * An interval on a removed element is not a leak the profiler will ever show you and it is
 * still a timer firing forever behind a running battle.
 */
let loreTimer: number | null = null;

/**
 * Turn the loading panel into the cinematic one, now that the battlefield is known.
 *
 * Called on exactly one path — a player who came through the menu — for two reasons. The
 * plate is already in the browser's cache, because the menu has been showing it, so this
 * costs no request. And the pre-boot splash and every harness path keep the opaque centred
 * sheet they have always had, which is what makes this change invisible to `qa-deploy`,
 * `probe-*` and the determinism arms.
 */
function dressLoadingScreen(panel: HTMLElement, map: MapId): void {
  panel.classList.add('with-plate');
  const sub = document.getElementById('load-sub');
  // `innerHTML`: `MapDefinition.subtitle` carries a literal `&middot;`, the way the menu
  // header and the title card both consume it.
  if (sub) sub.innerHTML = getMap(map).subtitle;

  const card = document.getElementById('load-lore');
  const title = document.getElementById('load-lore-title');
  const body = document.getElementById('load-lore-text');
  const cite = document.getElementById('load-lore-cite');
  if (!card || !title || !body || !cite) return;

  const cards = loreFor(map);
  let i = 0;
  const paint = (): void => {
    const c = cards[i % cards.length];
    title.textContent = c.title;
    body.textContent = c.text;
    cite.textContent = c.cite ?? '';
  };
  paint();
  card.hidden = false;
  requestAnimationFrame(() => card.classList.add('in'));

  /*
   * Seven seconds a card, and the number is a measurement rather than a guess: a boot is
   * 3.7-5.4 s on this machine (`tools/scratch/menu-boot-cost.mjs`) and several times that on
   * weaker hardware. One card would be a half-read sentence for the fast case and a wasted
   * twenty seconds for the slow one. 360 ms is the fade-out in `hud.css`; keeping the two in
   * step is why the swap is written as two steps rather than as one text assignment.
   */
  loreTimer = window.setInterval(() => {
    card.classList.remove('in');
    window.setTimeout(() => {
      i++;
      paint();
      card.classList.add('in');
    }, 360);
  }, 7000);
}

/**
 * Pre-battle menu, before anything is built.
 *
 * Two of the things it configures cannot be changed afterwards: the quality tier fixes the
 * soldier pool and the shadow cascade count at `init`, and the AI's `commanded` set is bound
 * when `installAI` runs. So the menu resolves first and the engine is constructed from its
 * answer — the same order Total War uses, configure then load then fight, which also means a
 * player who wants a small battle never waits for a big one's assets.
 *
 * Two screens, not one: it opens on the front door — battle, documentation, model viewer —
 * and Battle leads into the setup flow this comment describes. `?menu=battle` opens straight
 * on the setup, which is what the probes that drive it use.
 *
 * Skipped entirely under `?harness=1`, `?menu=0`, or `?replay=` — a record carries its own
 * battle and there is nothing left to choose. Ultra is the default tier for players as
 * well as the harness: the 16-shot pass measures every graded camera at ultra and the
 * slowest is 61-64 fps, so the tier the game is tuned and judged at is the one it opens on.
 * `?quality=` and `?difficulty=` still override, which is what the harness uses and the
 * escape hatch for weaker hardware.
 */
/*
 * `?replay=` carries the battle inside it — config, seed, tier and the order log — so there is
 * no menu to show and nothing for a stored preference to say. It is decoded below, after the
 * `?quality=`/`?difficulty=` overlay, because the record's own answers win over all of them.
 * `?from=<seconds>` plays that much of it and then hands the army over, which is "take command
 * from here" and costs one comparison in `ReplaySystem.pump`.
 */
const replayToken = params.get('replay');
const skipMenu = harness || params.get('menu') === '0' || replayToken !== null;
let config = resolveConfig(params, !harness);
{
  const q = params.get('quality') as QualityTier | null;
  const d = params.get('difficulty') as Difficulty | null;
  // `?scenario=assault` alongside `?quality=` and `?difficulty=`: an override the harness
  // and the siege probe can set without carrying a whole `?battle=` token, on the same
  // footing as the other two. `sanitiseConfig` still has the last word, so it cannot select
  // an assault on a map with no wall.
  const sc = params.get('scenario') as ScenarioId | null;
  if (q) config = { ...config, quality: q };
  if (d) config = { ...config, difficulty: d };
  if (sc) config = { ...config, scenario: sc };
  config = sanitiseConfig(config);
}
let replayRecord: ReplayRecord | null = null;
if (replayToken !== null) {
  replayRecord = await decodeReplay(replayToken);
  if (replayRecord) {
    // The record's own config wins outright, including the tier: the army size is fitted to
    // the tier and a record played at another one is a different battle, not a smaller one.
    config = sanitiseConfig({ ...replayRecord.cfg, quality: replayRecord.quality });
  } else {
    console.error('[replay] ?replay= did not decode; falling back to the ordinary battle');
  }
}
/**
 * Drop a `.tcr` on the window to watch it.
 *
 * The file *is* the token — the same base64url string `Copy replay link` puts on the
 * clipboard — so a record can travel as a file or as a URL and there is only one thing to
 * read either way. Installed before the menu so it works on the front door, and left
 * installed so it works mid-battle: dropping a record is a request to watch that one instead.
 */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.name.endsWith('.tcr')) return;
  e.preventDefault();
  void file.text().then((text) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('replay', text.trim());
    location.href = url.toString();
  });
});
/**
 * The cinematic plate behind the menu and the loading screen.
 *
 * Built here rather than inside `MainMenu` because it outlives the menu by exactly one
 * screen: BEGIN BATTLE fades the menu out and fades the loading panel in over the *same*
 * photograph of the battlefield that was just chosen, and a backdrop owned by the screen
 * that goes away could not do that.
 *
 * `null` on every path that skips the menu — `?harness=1`, `?menu=0`, `?replay=`. Those are
 * the paths the screenshot deck, `qa-determinism`, `qa-deploy` and every `probe-*` take, and
 * not one of them may acquire a new network request or a new element in the layer stack
 * because the front door got a picture. See the comment in `index.html`.
 */
let backdrop: MenuBackdrop | null = null;
if (!skipMenu) {
  const menuHost = document.getElementById('menu-root') as HTMLElement;
  // The loading panel sits at z-index 100, above the menu, so it has to leave the layer
  // rather than merely fade — otherwise the menu is built underneath an opaque sheet.
  if (loading) loading.hidden = true;
  const bdHost = document.getElementById('backdrop-root');
  if (bdHost) backdrop = new MenuBackdrop(bdHost);
  // `params` so the menu can tell a visit from a link: `?menu=battle`, or any URL that
  // already names a battle, opens straight on the setup screen instead of the front door.
  // See `startStep` in `MainMenu.ts`. `?menu=0` and `?harness=1` are unaffected — they are
  // handled above and never build a menu at all.
  const chosen = await new MainMenu(config, params, {
    onMap: (id) => backdrop?.setMap(id),
    onMapPeek: (id) => backdrop?.prefetch(id),
  }).show(menuHost);
  config = chosen.config;
  if (loading) loading.hidden = false;
  // The loading screen goes cinematic: the plate the menu has been showing stays up, the
  // title block drops to the lower left, and a cited historical card comes in beside it.
  // Only on this path — the pre-boot splash and the harness keep the opaque centred sheet
  // they have always had.
  if (loading && backdrop) dressLoadingScreen(loading, config.map);
}
const difficulty = config.difficulty;
/**
 * Which side the player commands. The other is left to the AI.
 *
 * `?autoplay=1` hands both armies to the AI, which is what the screenshot harness wants:
 * its shots need a battle that fights itself. Interactive play must never do this, or the
 * AI will fight the player for control of their own units.
 */
// Explicit `?autoplay=0` wins over the harness default, so an interaction test can load
// the harness (for `window.__game`) while still leaving Rome under player control.
// A replay is never autoplay: the log commands Rome, and handing Rome to the AI as well
// would have two commanders fighting over one army — the same failure `installAI`'s
// `commanded` argument exists to prevent.
const autoplay = replayRecord ? false
  : params.has('autoplay') ? params.get('autoplay') === '1' : harness;
const playerFaction = Faction.Rome;

/**
 * Whether the player lays their army out before the clock starts.
 *
 * On by default for anyone who came through the menu, which is every real player: pressing
 * BEGIN BATTLE hands you your army on the field with the clock stopped, exactly as Total War
 * does, and the deployment plaque is the first thing on screen. Off by default everywhere the
 * menu was skipped — the screenshot deck, `tools/probe-*`, `qa-determinism`, `qa-interact`
 * and every `?battle=` link all expect a battle that is already running, and a phase they
 * did not ask for would stop all of them dead at t+0.
 *
 * `?deploy=1` forces it on so a headless driver can exercise the phase, and `?deploy=0`
 * forces it off so a player can skip straight to the fight. It is refused outright under
 * autoplay: with both armies handed to the AI there is no player to deploy for.
 */
const deployPhase = replayRecord ? replayRecord.deployPhase
  : params.has('deploy') ? params.get('deploy') === '1' && !autoplay
    : !skipMenu && !autoplay;

const engine = new Engine({
  canvas,
  quality: config.quality,
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
/*
 * Build the city this map carries, and nothing if it carries none.
 *
 * This was unconditional, and on any map without a city it was not merely wasted work — it
 * was a live gameplay bug. `CitySystem` planned the Aurelian circuit against the Tiber, built
 * it onto whatever heightfield was loaded, and was then simply made invisible. The geometry
 * stayed in the world: `Pathfinding` stamps `city.getWallSegments()` with no map guard, so
 * **Rome's wall blocked movement across the plain of Pydna** while being nowhere on screen.
 * Skipping registration closes it at the source rather than adding a second guard downstream
 * — `Pathfinding` already tests `if (!city?.getWallSegments) return`, so an absent city is a
 * case it handles cleanly.
 *
 * The guard was `!getMap(config.map).hidesCity`, and a flag is something the next map can
 * forget. It is now the plan itself: a map hands over a `CityPlan` or it hands over nothing,
 * and this line builds exactly what it was handed. See `src/city/cityPlan.ts`.
 */
const cityPlan = getMap(config.map).city;
if (cityPlan) engine.add(new CitySystem(cityPlan));

const battle = engine.add(new BattleSystem());
// Seed the battle's root stream here, before `initAll`, and not in the scenario.
// GeneralAI, TacticalAI and Projectiles each fork a private stream off this one during their
// own `init`, and a fork is derived from the parent's state at the moment it is taken — so a
// seed applied at deploy time (which runs after `initAll`) would leave all three on the
// default stream and the menu's seed field would quietly do almost nothing. Mutated in place
// rather than replaced for the same reason: the forks hold no reference to this object, but
// anything that later captures `battle.rng` would be left pointing at the discarded instance.
battle.rng.setState(config.seed === 0 ? 0x9e3779b9 : config.seed >>> 0);
/*
 * The order log, at order 5 — ahead of every `fixedUpdate` in the tree.
 *
 * Registered here rather than with the UI because it is simulation, not interface: it owns
 * the queue that turns "the player clicked" into "an order was applied at tick N", and the
 * whole point of the tick number is that it does not depend on which frame the click landed
 * in. `main.ts` binds its three non-bus outlets in `boot()`, once they exist.
 */
const replay = engine.add(new ReplaySystem());
engine.add(new CombatSystem());
engine.add(new ProjectileSystem());
engine.add(new MoraleSystem());
engine.add(new AbilitySystem());
engine.add(new RagdollSystem());
engine.add(new BattleFlowSystem());

/*
 * The pre-battle deployment phase.
 *
 * Registered here but *opened* after `deployBattle`, in `boot()`: its deployment zone is
 * measured off where the scenario actually stood the two armies, so it cannot be computed
 * before they exist. Its `order` of 690 puts its `init` just ahead of the HUD's, which is
 * what lets `HudSystem` find it with `tryGet` and build the plaque. Registered at all only
 * when the phase will be used, so that same `tryGet` is the HUD's test for whether to.
 *
 * It holds `time.paused`, and that is the whole answer to the AI problem. `installAI` binds
 * its `commanded` set at construction, three lines below, and re-plans every few ticks — but
 * `Engine.frame` runs `fixedUpdate` exactly as many times as `Time.beginFrame` returns, and
 * a paused clock returns zero. So during deployment the planner is not merely out-voted, it
 * is never called.
 */
const deployment = deployPhase ? engine.add(new DeploymentSystem()) : null;

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
/*
 * Every faction the player is not commanding, derived rather than named.
 *
 * This was `[playerFaction, aiFaction]` against a single `aiFaction = Faction.Germanic`, and a
 * third faction therefore arrived uncommanded — Carthage spawned with a full perception view,
 * 828 strength and `plan NONE`, sitting on the field doing nothing but whatever explicit orders
 * its scenario issued. `installAI` and both AI subsystems now default to all factions, but this
 * call passes an explicit list and an explicit list wins, so the fix has to be here.
 */
await installAI(engine, {
  difficulty,
  commanded: autoplay ? [...ALL_FACTIONS] : ALL_FACTIONS.filter((f) => f !== playerFaction),
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

  // Time of day before deployment, so the first frame the player sees is already lit for the
  // hour they chose. SkySystem rebuilds its scattering cube and the PMREM environment from
  // this, and LightingSystem reads the sun colour back out of it, so setting it later would
  // show one frame of 10:00 light whatever the menu said.
  const sky = engine.context.tryGet('sky') as { setTimeOfDay?: (h: number) => void } | undefined;
  sky?.setTimeOfDay?.(config.timeOfDay);

  // The scenario is passed explicitly rather than left to `scenario.ts` to read out of
  // `location.search`, which is what it did while that file could not be edited from here.
  const result = deployBattle(battle, engine.context, config, config.scenario);
  const f = result.cameraFocus;
  engine.rig.jumpTo(f.x, f.z, f.zoom, f.yaw);

  // After the armies are on the field, because the deployment zone is measured off them.
  deployment?.begin(config, playerFaction);

  /*
   * The record's header and its three outlets, in the one place all four exist.
   *
   * `unitSizeScale` and the pool count are only final once the scenario has run, and the
   * deployment phase is only open one line above. `Siege` serves two of the outlets: the
   * machine orders that have no `orderIssued` shape, and the two wall countermands `H` has
   * to fire before the halt reaches `BattleSystem`.
   */
  replay.begin(config, config.quality, deployPhase);
  if (deployment) replay.bindDeployment(deployment);
  replay.bindMachines(battle.siege);
  replay.bindWall(battle.siege);
  if (replayRecord) {
    const from = params.get('from');
    const fromTick = from === null ? undefined : Math.max(0, Math.round(Number(from) * 30));
    if (!replay.play(replayRecord, { fromTick })) {
      if (loadText) loadText.textContent = replay.refusal;
    }
  }

  /**
   * Compare every cross-subsystem seam against the objects on the other side of it.
   *
   * Here and not in `initAll` because this is the first line at which every provider is
   * bound: `Siege` finds the projectile system lazily, the HUD finds the deployment phase
   * through `tryGet`, and the city's rasters are only final once the scenario has run. It
   * reads already-built state, costs under a millisecond and shouts on the console with both
   * field-name lists when two sides disagree. See `src/core/seams.ts` for why a check that
   * runs at runtime is the one that catches this — every one of these seams typechecks.
   */
  installSeamCheck(engine.context);

  if (loreTimer !== null) {
    clearInterval(loreTimer);
    loreTimer = null;
  }
  if (harness) {
    loading?.remove();
  } else {
    loading?.classList.add('done');
    // The plate dissolves on the panel's own curve, then both leave together. `#backdrop-root`
    // sits at z-index 5, between the canvas and the HUD, so a plate left behind would be a
    // still photograph over a running battle.
    backdrop?.fadeOut();
    setTimeout(() => {
      loading?.remove();
      backdrop?.dispose();
      backdrop = null;
    }, 1400);
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
      /**
       * The same fast-forward with the rasterisation left out, which is the whole of its cost.
       *
       * `advance` draws every synthetic frame — sixty per simulated second at its default step
       * — and on the full-scale Carthage storm that is minutes of wall clock per minute of
       * battle, which is why no probe had ever reached the end of one. This skips the submit
       * and nothing else, so the simulation is bit-identical and roughly twenty times faster.
       * It leaves the canvas showing the frame before the call, so screenshot after a real
       * frame has run, not straight after this.
       */
      fastForward(seconds: number, stepMs?: number): void;
      /**
       * Run **exactly** `ticks` more fixed steps, at whatever frame schedule `stepMs` asks
       * for. The one entry point a replay comparison can use: equal elapsed seconds is not
       * equal tick counts (see `Engine.advanceTicks`), and the record is keyed to ticks.
       */
      advanceTicks(ticks: number, stepMs?: number): number;
      /** Park the camera for a repeatable screenshot. */
      setCamera(x: number, z: number, zoom: number, yaw: number): void;
      /** Sim seconds elapsed. */
      simTime(): number;
      /**
       * The pre-battle deployment phase, or null when this run has none.
       *
       * Published so a headless driver can *observe* the phase — is it live, what does it
       * think its zone is, how much pool is left. Driving it from here would be testing the
       * API rather than the feature, which is a gap this project has shipped before, so the
       * checks in `tools/qa-deploy.mjs` go through real mouse and keyboard events and only
       * read through this.
       */
      deployment: DeploymentSystem | null;
      /**
       * The determinism marks, computed by the product.
       *
       * `tools/qa-determinism.mjs` used to inject the whole of this arithmetic as a template
       * string, so the project's canonical state hash lived only in a test tool and a second
       * consumer had to copy it. `tools/qa-replay.mjs` is that second consumer. See
       * `src/sim/stateHash.ts`; the arithmetic is unchanged to the bit, because twenty-one
       * pinned hashes are keyed to it.
       */
      hashes(): ReturnType<typeof stateHashes>;
      /** The exact field lists the two unit hashes cover, so a localiser reads the same set. */
      hashFields(): { f64: readonly string[]; ctl: readonly string[] };
      /** The order log. Save, share, watch, and take command from here. */
      replay: ReplaySystem;
    };
  }
}

window.__game = {
  engine,
  battle,
  ready: false,
  advance: (seconds: number) => engine.advance(seconds),
  /*
   * The step stays at `advance`'s own default, and that is not a detail to tune away.
   *
   * Measured on the Carthage assault, three independent loads advanced by one schedule and
   * hashed at t+30/90/150/200: `advance(dt, 1000/60)` and `advance(dt, 1000/60, {render:
   * false})` agree on every bit at every checkpoint, so skipping the submit is free. But
   * `advance(dt, 166)` — the "five ticks a frame, four times cheaper" idiom several siege
   * probes use — produces *different hashes*, and so does an exactly-five-tick 1000/6 step
   * that lands on the same total elapsed time. The tick count is not the whole of it; how
   * many ticks share a frame reaches the simulation somehow. Same survivor count, different
   * battle.
   *
   * So a coarse step is not a free speed-up, it is a different run, and a fast-forward that
   * took one would quietly stop being comparable with `qa-determinism`. This one is only ever
   * the same battle, sooner.
   *
   * **Annotated 21 August 2026 — right conclusion, wrong reason, and there is now a third
   * option.** A coarse step at the same elapsed time runs a different *number of ticks* — 900
   * at 1000/60, 901 at 166 ms, 899 at an exactly-five-tick 1000/6, because `double(1/6)` is
   * about 7e-18 short of five times `double(1/30)` and `maxStepsPerFrame = 5` means the lost
   * tick is never made up. Frame grouping itself does not reach the simulation: held to an
   * equal tick count, five ticks a frame and one tick every two frames are bit-identical on
   * the pool hash, both unit hashes and `BattleFlow.result` across a 6,783-tick battle with
   * real recorded player orders in it (`tools/qa-replay.mjs`). If what you want is the same
   * battle *cheaper*, ask for ticks: `advanceTicks` below does exactly n of them at whatever
   * frame schedule you like.
   */
  fastForward: (seconds: number, stepMs = 1000 / 60) =>
    engine.advance(seconds, stepMs, { render: false }),
  setCamera: (x, z, zoom, yaw) => engine.rig.jumpTo(x, z, zoom, yaw),
  advanceTicks: (ticks: number, stepMs = 1000 / 60) =>
    engine.advanceTicks(ticks, stepMs, { render: false }),
  simTime: () => engine.time.simTime,
  deployment,
  hashes: () => stateHashes(battle.pool, battle.units),
  hashFields: () => ({ f64: UNIT_F64_FIELDS, ctl: UNIT_CTL_FIELDS }),
  replay,
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
