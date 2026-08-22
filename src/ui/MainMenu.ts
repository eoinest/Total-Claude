/**
 * Pre-battle menu — Total War's custom-battle setup, in this game's chrome.
 *
 * Shown before the engine is built, because two of the things it configures cannot be
 * changed afterwards: the quality tier fixes the soldier pool size and the shadow cascade
 * count at `init`, and the AI's `commanded` set is bound when `installAI` runs. Deferring
 * asset loading until Begin is pressed is the same order Total War uses — configure, then a
 * loading screen, then the battle — and it means a player who wants a small battle never
 * pays for a big one.
 *
 * The layout follows Rome II's army-setup screen: one global scale control at the top, the
 * two armies facing each other across the middle, and the battle's conditions underneath.
 * What it does not copy is the funds budget, which exists to price units against a campaign
 * economy that does not exist here.
 *
 * ---------------------------------------------------------------------------
 * Two steps, not one: the front door and the setup screen
 * ---------------------------------------------------------------------------
 *
 * This screen used to *be* the main menu, and it opened straight onto the army setup. It is
 * now the second of two steps. The first — `menu-home`, the front door — offers the three
 * places a visitor can go: the battle, the technical documentation, and the model viewer.
 * The last two were both already built, both already served, and both reachable only by
 * someone who knew the URL to type.
 *
 * Both steps live in one `.menu` root and one `MainMenu` instance, and the setup DOM is
 * built once at `show()` rather than on each visit. That is deliberate and it is the same
 * hazard `buildArmies` documents at length: a screen rebuilt on navigation leaves detached
 * rows carrying live click handlers, which is how a menu ends up silently editing an army
 * the player is no longer looking at. Nothing here rebuilds on Back — the step is a class on
 * the root, `this.cfg` is untouched, and returning to the setup finds the army exactly as it
 * was left, down to the seed.
 *
 * **Battle is the only destination that stays in this tab.** Everything else — the docs, the
 * viewer, the trailer, the changelog — opens in a new one. The rule is uniform so that it can
 * be stated in one sentence, and it exists because a player who has spent two minutes
 * building an order of battle must not be able to lose it to one mis-aimed click. The
 * in-progress config is held in memory and is only ever written to storage by `commit`, so
 * a navigation away really would take the army with it.
 */

import type { QualityTier } from '../core/Engine';
import {
  type BattleConfig, type Difficulty, type ScenarioId, DEFAULT_CONFIG, MAX_PER_TYPE,
  MAX_UNITS_PER_SIDE, SCENARIOS, UNIT_SIZES, type UnitSizeId, assaultCompositionKey,
  baseStrength, belligerents, compositionFor, siegeRoleOf,
  decodeConfig, encodeConfig, PERF_VALIDATED_MEN, fittedUnitScale, isScaleClamped,
  loadStoredConfig, rosterFor, sanitiseConfig, scaleAppliesTo, scenarioDef, scenarioFor,
  storeConfig,
  summarise, unitCount, unitSizePreset,
} from '../sim/battleConfig';
import { QUALITY_PRESETS } from '../core/Engine';
import { MAPS, getMap, isMapId, setActiveMap, type MapId } from '../maps';
import { Faction, setOpposingFaction, type UnitClass } from '../sim/types';

/** CSS class suffix per faction, so `menu.css` can theme each army panel. */
const FACTION_CLASS: Record<Faction, string> = {
  [Faction.Rome]: 'rome',
  [Faction.Germanic]: 'germanic',
  [Faction.Carthage]: 'carthage',
};
import { unitType } from '../units/roster';
import { el, html, icon, setClass, setText } from './dom';
import { ICON } from './icons';

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'legendary'];

const SIDE_LABEL: Record<number, string> = {
  [Faction.Rome]: 'ROME',
  [Faction.Germanic]: 'JUTHUNGI',
  [Faction.Carthage]: 'QART-HADASHT',
};

/** Which of the two screens the menu is showing. */
export type MenuStep = 'home' | 'setup';

/** The same mark as the loading screen, so every screen of this game reads as one game. */
const EAGLE = `<svg viewBox="0 0 64 64" class="menu-ic" aria-hidden="true">
  <path fill="currentColor" opacity=".85"
    d="M32 4l4 8 10-4-3 9 11 1-8 6 8 6-11 1 3 9-10-4-4 8-4-8-10 4 3-9-11-1 8-6-8-6 11-1-3-9 10 4z" />
</svg>`;

const REPO = 'https://github.com/eoinest/Total-Claude';
/** The published documentation site. Its own build, its own deployment — see `docs/site`. */
const DOCS_URL = 'https://total-claude-docs.vercel.app';
/**
 * Absolute, not relative. `viewer.html` is the second Rollup entry (see `vite.config.ts`)
 * and `base` is `/`, so it is served from the domain root on Vercel and from the dev
 * server's root locally. A relative href would resolve correctly today and silently stop
 * doing so the first time this page is served from anywhere but `/`.
 */
const VIEWER_URL = '/viewer.html';

interface Destination {
  id: string;
  label: string;
  sub: string;
  /** Inline SVG body from `ICON`. */
  ic: string;
  /** Absent means the destination is inside this app; present means a link. */
  href?: string;
  /**
   * A link that stays in this tab.
   *
   * The two external plaques open a new tab because leaving a battle you are configuring to
   * read a document is not what anyone meant by clicking it. The lobby is the opposite: it
   * *replaces* this page, because the next thing it does is navigate to a battle.
   */
  sameTab?: boolean;
}

/**
 * The front door, in the order it is offered.
 *
 * Three, and the owner named all three: *"The main menu should have a battle button but also
 * allow you to go to the docs or model viewer."* Battle first and visually loudest, because
 * it is the reason the page is open and every other destination is a detour from it.
 *
 * The two external ones are described by what is *in* them rather than by what they are
 * called. "Docs" is a word that tells a visitor nothing about whether it is worth a click;
 * "four volumes — simulation, rendering, siege, tooling" tells them exactly.
 */
const DESTINATIONS: readonly Destination[] = [
  {
    id: 'battle',
    label: 'Battle',
    ic: ICON.swords,
    sub: 'Choose the battlefield and the engagement, draw up both orders of battle, '
      + 'set the hour &mdash; then fight it.',
  },
  {
    id: 'multiplayer',
    label: 'Two commanders',
    ic: ICON.swords,
    href: '?mp=1',
    sameTab: true,
    sub: 'One battle on two machines, both armies under human command. The host chooses the '
      + 'ground; the challenger takes the other side.',
  },
  {
    id: 'docs',
    label: 'Technical documentation',
    ic: ICON.volumes,
    href: DOCS_URL,
    sub: 'Four volumes &mdash; simulation, rendering, siege and tooling &mdash; with the '
      + 'architecture, Carthage, the release procedure and the visual rubric.',
  },
  {
    id: 'viewer',
    label: 'Model viewer',
    ic: ICON.turntable,
    href: VIEWER_URL,
    sub: 'Every unit in the roster turned in the light, one mesh at a time, with its '
      + 'animation and its levels of detail.',
  },
];

/**
 * The second rank: things worth one line and not a plaque.
 *
 * **The trailer is here rather than beside Battle, and that is a judgement about hosting.**
 * The four cuts live as GitHub release assets on `r6`, and a release asset is a download and
 * not a stream: the good one — 1080p with sound — is 130 MB, and a button on the front door
 * reading TRAILER promises a play button it cannot deliver. Linked to the release page, with
 * the sizes stated, the click is at least an informed one. If the trailer is ever hosted
 * somewhere that streams it, it has earned a plaque; today it has not.
 *
 * The changelog is here for the returning player, who has exactly one question the front door
 * can answer: what changed. It is one line and it is honest about being a Markdown file.
 */
const ASIDES: readonly { id: string; label: string; sub: string; href: string }[] = [
  {
    id: 'trailer',
    label: 'Trailer',
    href: `${REPO}/releases/tag/r6`,
    sub: 'Four cuts on the r6 release &mdash; 1080p with sound at 130 MB, 720p at 4.7 MB',
  },
  {
    id: 'changelog',
    label: 'Changelog',
    href: `${REPO}/blob/main/CHANGELOG.md`,
    sub: 'Every release that reached production, newest first',
  },
];

/**
 * Whether a URL has already answered the front door's question.
 *
 * `?menu=battle` is the explicit form and the one the probes use: a sibling of the existing
 * `?menu=0`, which skips the menu altogether and which **nothing here changes**. The rest is
 * inference, and it covers the case the share button creates. `Copy link to this battle`
 * writes `?battle=<token>`, and a link that names an order of battle, a map, an engagement or
 * an enemy has already said where it wants to go; answering it with a screen that asks
 * "battle, docs or viewer?" is a worse answer than the question deserved.
 */
/** Announced, never drawn. Every link on the front door but Battle carries it. */
const NEW_TAB = ' <span class="sr-only">Opens in a new tab.</span>';

const OPENS_ON_SETUP = ['battle', 'map', 'scenario', 'enemy'] as const;

const startStep = (params?: URLSearchParams): MenuStep => {
  if (!params) return 'home';
  if (params.get('menu') === 'battle') return 'setup';
  return OPENS_ON_SETUP.some((k) => params.has(k)) ? 'setup' : 'home';
};

/**
 * Who Rome fights, and the row that was missing.
 *
 * `BattleConfig.opponent` has existed since Carthage was added and **nothing ever set it** —
 * not the menu, not a URL parameter, not a map. Its default is the Juthungi, so
 * `belligerents` always returned the Juthungi for a field battle, and the Punic *field* army
 * in `DEFAULT_CONFIG.carthage` — Sacred Band, Numidian horse, war elephants, seven bought
 * contingents to one of citizens — could only be reached by hand-building a base64 `?battle=`
 * token.
 *
 * `662b189` reached the Carthaginian faction from the other end, through the *storm* of
 * Carthage, where the map names both sides and no choice is needed. This is the half a
 * choice does apply to: Rome's 218 BC enemy on open ground, which is a different army from
 * the 146 BC levy that held the triple wall and is still the only one in the roster that
 * nothing can select.
 *
 * Two entries rather than a loop over `ALL_FACTIONS` because Rome is never her own opponent
 * and the copy is per army, not generic.
 */
const OPPONENTS: readonly { id: Faction; label: string; sub: string }[] = [
  { id: Faction.Germanic, label: 'Juthungi', sub: 'Alemannic confederation &middot; 271 AD' },
  { id: Faction.Carthage, label: 'Qart-Hadasht', sub: 'Punic host in Hannibal&rsquo;s proportions' },
];

/**
 * The strapline under each army's name, which is not the same sentence in the two battles:
 * in the field Rome's army stands in the open, in the assault it stands on the wall. A menu
 * that offered ballistarii under the heading "Aurelian's field army" would be describing the
 * wrong battle.
 */
const FIELD_SUB: Record<number, string> = {
  [Faction.Rome]: 'Aurelian&rsquo;s field army &middot; defending',
  [Faction.Germanic]: 'The host of the Juthungi &middot; attacking',
  [Faction.Carthage]: 'A citizen core and six bought contingents &middot; attacking',
};

/**
 * An assault's strapline is a *role* and not a faction, which is what the fixed table above
 * could not say.
 *
 * `[Faction.Rome]: 'The garrison of the Aurelian Wall'` was exact while Rome was the only
 * city; at Carthage, Rome is the besieger and the wall is Punic, so the same key had to give
 * two different answers. It reads the map's own city name for the same reason the title card
 * does — the words follow the battlefield, not the army.
 */
const assaultSub = (cfg: BattleConfig, f: Faction): string =>
  siegeRoleOf(f, cfg.map) === 'garrison'
    ? `The garrison of ${getMap(cfg.map).city?.name ?? 'the city'} &middot; holding`
    : 'The storming parties &middot; assaulting';

const sideSub = (cfg: BattleConfig, f: Faction): string =>
  (cfg.scenario === 'assault' ? assaultSub(cfg, f) : FIELD_SUB[f]);

/** What the third figure in an army's totals means, which the scenario decides. */
const FIELD_FRONTAGE: Record<number, { unit: string; title: string }> = {
  [Faction.Rome]: { unit: 'm of line', title: 'Combined width of the battle-line units — how much front this army can form. Excludes reserves, wings and artillery.' },
  [Faction.Germanic]: { unit: 'm of line', title: 'Combined width of the battle-line units — how much front this army can form. Excludes reserves, wings and artillery.' },
  [Faction.Carthage]: { unit: 'm of line', title: 'Combined width of the Libyan, Iberian and Gallic blocks. The Sacred Band is a reserve, the skirmishers a screen, and the elephants stand in front of the line rather than in it.' },
};

/** Keyed by role for the same reason `assaultSub` is: Rome plays both sides of a siege. */
const frontageLabel = (cfg: BattleConfig, f: Faction): { unit: string; title: string } => {
  if (cfg.scenario !== 'assault') return FIELD_FRONTAGE[f];
  return siegeRoleOf(f, cfg.map) === 'garrison'
    ? { unit: 'm of wall held', title: 'Combined width of the wall troops — how much curtain this garrison can line. Excludes the reserve and the engines behind the parapet, which hold no wall.' }
    : { unit: 'm of line', title: 'Combined width of whatever waits in the open. The towers, ladder parties, ram and batteries are the assault itself and form no line.' };
};

/**
 * Human labels for the roster's `unitClass`, covering every member of the `UnitClass` union.
 *
 * Typed as `Record<UnitClass, string>` rather than `Record<string, string>` on purpose: the
 * loose version silently fell through to the raw id, and the menu shipped rows reading
 * "spear-infantry &middot; 150 base" and "heavy-cavalry &middot; 60 base". With the union as
 * the key type, adding a class to the roster without labelling it here fails the typecheck.
 */
const CLASS_LABEL: Record<UnitClass, string> = {
  'heavy-infantry': 'Heavy infantry',
  'light-infantry': 'Light infantry',
  'spear-infantry': 'Spearmen',
  'missile-infantry': 'Missile infantry',
  'shock-infantry': 'Shock infantry',
  'heavy-cavalry': 'Heavy cavalry',
  'light-cavalry': 'Light cavalry',
  artillery: 'Artillery',
  general: 'General',
};

const fmt = (n: number): string => n.toLocaleString('en-GB');

export interface MenuResult {
  config: BattleConfig;
  /** True when the player pressed Begin rather than the menu being skipped. */
  interactive: boolean;
}

/**
 * Resolve the starting config without showing anything.
 *
 * Precedence is URL token, then stored preference, then the historical default. `?quality=`
 * and `?difficulty=` are applied over the top by the caller because the harness sets them
 * directly and must not be overridden by whatever a previous play session stored.
 *
 * `useStored` is false under the harness, and that is not a nicety: every graded screenshot
 * and the determinism check compare runs against each other, so a stored preference from an
 * interactive session on the same machine would silently change the battle being measured.
 * An explicit `?battle=` token is still honoured there, because that is someone deliberately
 * asking to measure a specific setup.
 */
export function resolveConfig(params: URLSearchParams, useStored = true): BattleConfig {
  const token = params.get('battle');
  const decoded = token ? decodeConfig(token) : null;
  let cfg = decoded ?? (useStored ? loadStoredConfig() : null) ?? DEFAULT_CONFIG;
  /*
   * `?map=` — the override that was missing, and its absence was not a small gap.
   *
   * There were overrides for quality, difficulty and scenario but none for the map, so the
   * only ways to reach a specific one were to click it in the menu or to carry a whole
   * `?battle=` token. That made a shareable link to a particular map impossible, and it
   * interacted badly with the stored preference: a player who had once selected a map with
   * no city kept it across every later visit, and the menu then correctly greyed out the
   * assault — leaving `?scenario=assault` in the URL doing nothing, with no clue as to why.
   *
   * Applied here rather than in `main.ts` alongside the other three, because `setActiveMap`
   * runs at the bottom of this function and the terrain reads that singleton before
   * `main.ts` gets another word in. `sanitiseConfig` still has the last word, so this cannot
   * select an assault on a map that has no city to storm.
   */
  const wantMap = params.get('map');
  if (wantMap && isMapId(wantMap) && wantMap !== cfg.map) {
    cfg = sanitiseConfig({ ...cfg, map: wantMap });
  }
  /*
   * `?enemy=juthungi|carthage`, on the same footing as `?map=` and for the same reason.
   *
   * There has never been a way to reach the Punic army short of hand-building a `?battle=`
   * token, so there has never been a shareable link to it either. Names rather than the enum
   * ordinal, because `?enemy=2` is not a URL anyone can write from memory.
   */
  const wantFoe = params.get('enemy');
  if (wantFoe) {
    const f = wantFoe === 'carthage' ? Faction.Carthage
      : wantFoe === 'juthungi' || wantFoe === 'germanic' ? Faction.Germanic
        : null;
    if (f !== null && f !== cfg.opponent) cfg = sanitiseConfig({ ...cfg, opponent: f });
  }
  // Publish the choice to `src/maps` here, and again in `commit`.
  //
  // `main.ts` constructs every subsystem with no arguments and `EngineContext` carries no
  // configuration field, so a module singleton is the only channel by which a map choice can
  // reach the terrain — and this function is the one point every non-interactive path goes
  // through (the harness, `?menu=0`, and a shared `?battle=` link). It runs before the engine
  // exists, let alone `TerrainSystem.init`. See `setActiveMap` for the full ordering argument.
  setActiveMap(cfg.map);
  publishBelligerents(cfg);
  return cfg;
}

/**
 * Tell `src/sim/types` who Rome is fighting, before anything is built.
 *
 * The same singleton-and-timing argument as `setActiveMap`, for the same reason: the HUD
 * builds its panels in `init`, which is *before* `deployBattle` runs, and until now the only
 * writer of `setOpposingFaction` was the deployment. So every panel that asked "who is the
 * enemy" during `init` — the unit-card bar's foe tab, the top plaque's second army — got the
 * default answer, the Juthungi, whatever battle the player had actually chosen. The
 * deployment still publishes it afterwards from the army it really laid out, which is the
 * authority; this only makes the answer right one phase earlier.
 */
function publishBelligerents(cfg: BattleConfig): void {
  setOpposingFaction(belligerents(cfg)[1]);
}

export class MainMenu {
  private root!: HTMLElement;
  private cfg: BattleConfig;
  private resolve!: (r: MenuResult) => void;
  private sizeBtns = new Map<UnitSizeId, HTMLElement>();
  private tierBtns = new Map<QualityTier, HTMLElement>();
  private diffBtns = new Map<Difficulty, HTMLElement>();
  private mapBtns = new Map<MapId, HTMLElement>();
  private scenBtns = new Map<ScenarioId, HTMLElement>();
  private oppBtns = new Map<Faction, HTMLElement>();
  private countCells = new Map<string, HTMLElement>();
  private stepBtns: Array<{ el: HTMLButtonElement; f: Faction; id: string; d: number }> = [];
  /** Set when picking a map without a wall has just taken the assault away from the player. */
  private droppedAssault = false;
  /**
   * Which of the two screens is up. Named `screen` rather than `step` because `step` is
   * already this class's unit-count stepper, and a field that shadows a method is the kind
   * of collision the compiler catches once and a reader trips over forever.
   */
  private screen: MenuStep;
  /** The front door's plaques, in DOM order, for the arrow-key roving focus. */
  private destEls: HTMLElement[] = [];

  constructor(initial: BattleConfig, params?: URLSearchParams) {
    this.cfg = sanitiseConfig(initial);
    this.screen = startStep(params);
  }

  /** Resolves once the player commits. */
  show(host: HTMLElement): Promise<MenuResult> {
    this.root = el('div', 'menu', host);
    this.build();
    this.applyStep();
    this.refresh();
    // Two frames, so the browser has laid the panel out before the transition starts and
        // the fade actually runs instead of being skipped as an initial style.
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.add('in')));
    return new Promise<MenuResult>((res) => {
      this.resolve = res;
    });
  }

  /**
   * The front door.
   *
   * One plaque per destination, each with a name and a sentence, laid out in the same
   * gradient-and-gold chrome the option buttons on the setup screen use — `.dest` is
   * `.menu-opts button` with a wider box and a sentence in it, deliberately, because the
   * two screens are one product and a front door in different clothes would say otherwise.
   *
   * A `<button>` for Battle and an `<a>` for everything else, which is not a styling
   * choice: the anchors are real links, so middle-click, cmd-click, "copy link address"
   * and a screen reader's list of links all work on them, and none of that is true of a
   * button with a click handler that calls `location.assign`.
   */
  private homeMarkup(): string {
    const dest = (d: Destination): string => {
      // The arrow-out-of-the-box glyph is the only thing on the plaque that says a click
      // will leave the game, and a glyph says nothing to a screen reader. `NEW_TAB` is the
      // same fact in words, clipped out of the visual layout — see `.sr-only` in `menu.css`.
      const newTab = !!d.href && !d.sameTab;
      const body = `${icon(d.ic, 'dest-ic')}
        <span class="dest-txt"><b>${d.label}</b><i>${d.sub}${newTab ? NEW_TAB : ''}</i></span>
        <span class="dest-go" aria-hidden="true">${newTab ? '&#8599;' : '&rsaquo;'}</span>`;
      return d.href
        ? `<a class="dest dest-${d.id}" data-dest="${d.id}" href="${d.href}"
             ${newTab ? 'target="_blank" rel="noopener"' : ''}>${body}</a>`
        : `<button type="button" class="dest dest-${d.id}" data-dest="${d.id}">${body}</button>`;
    };
    return `<div class="menu-sheet menu-home">
      <header class="home-head">
        <div class="home-eagle">${EAGLE}</div>
        <div>
          <h1>TOTAL CLAUDE</h1>
          <h2>The Siege of Rome &middot; 271 AD</h2>
        </div>
      </header>
      <nav class="home-dest" aria-label="Main menu">
        ${DESTINATIONS.map(dest).join('')}
      </nav>
      <footer class="home-foot">
        ${ASIDES.map((a) => `
          <a class="aside" data-aside="${a.id}" href="${a.href}" target="_blank" rel="noopener">
            <b>${a.label}</b><i>${a.sub}${NEW_TAB}</i>
          </a>`).join('')}
      </footer>
    </div>`;
  }

  private build(): void {
    html(
      this.root,
      `<div class="menu-bg"></div>
       ${this.homeMarkup()}
       <div class="menu-sheet menu-setup" tabindex="-1">
         <header class="menu-head">
           <!--
             Back to the front door. In the header rather than the footer because it is a
             navigation and not an action: the footer is where BEGIN BATTLE lives, and a
             control that abandons the screen does not belong beside the one that commits it.
           -->
           <button type="button" class="menu-back" title="Back to the main menu (Esc)">
             <span aria-hidden="true">&lsaquo;</span> MENU
           </button>
           <div class="menu-eagle">
             ${EAGLE}
           </div>
           <div>
             <h1>TOTAL CLAUDE</h1>
             <h2>The Siege of Rome &middot; 271 AD</h2>
           </div>
         </header>

         <section class="menu-row map-row">
           <div class="menu-lab">
             <span class="lab-main">Battlefield</span>
             <span class="lab-sub">Terrain, season and light</span>
           </div>
           <div class="menu-opts map-opts">
             ${MAPS.map((m) => `
               <button type="button" data-map="${m.id}">
                 <b>${m.label}</b>
                 <i>${m.subtitle}</i>
               </button>`).join('')}
           </div>
         </section>
         <p class="map-blurb" data-map-blurb></p>

         <section class="menu-row scen-row">
           <div class="menu-lab">
             <span class="lab-main">Battle</span>
             <span class="lab-sub">Which engagement is fought</span>
           </div>
           <div class="menu-opts scen-opts">
             ${SCENARIOS.map((s) => `
               <button type="button" data-scen="${s.id}">
                 <b>${s.label}</b>
                 <i data-scen-sub="${s.id}">${scenarioFor(s.id, this.cfg.map).subtitle}</i>
               </button>`).join('')}
           </div>
         </section>
         <p class="scen-blurb" data-scen-blurb></p>

         <section class="menu-row opp-row">
           <div class="menu-lab">
             <span class="lab-main">Enemy</span>
             <span class="lab-sub">Who Rome is fighting</span>
           </div>
           <div class="menu-opts opp-opts">
             ${OPPONENTS.map((o) => `
               <button type="button" data-opp="${o.id}">
                 <b>${o.label}</b>
                 <i>${o.sub}</i>
               </button>`).join('')}
           </div>
         </section>

         <section class="menu-row size-row">
           <div class="menu-lab">
             <span class="lab-main">Battle size</span>
             <span class="lab-sub">Multiplies every unit&rsquo;s establishment</span>
           </div>
           <div class="menu-opts size-opts">
             ${UNIT_SIZES.map((p) => `
               <button type="button" data-size="${p.id}">
                 <b>${p.label}</b>
                 <i>${Math.round(160 * p.scale)}-man cohort</i>
               </button>`).join('')}
           </div>
         </section>

         <div class="menu-armies"></div>

         <div class="menu-warn" data-warn hidden></div>

         <section class="menu-row cond-row">
           <div class="menu-lab">
             <span class="lab-main">Conditions</span>
             <span class="lab-sub">Time of day, difficulty and detail</span>
           </div>
           <div class="cond-grid">
             <label class="cond">
               <span>${icon(ICON.sun, 'cond-ic')} Time of day</span>
               <input class="tod" type="range" min="4" max="21" step="1" />
               <b class="tod-val"></b>
             </label>
             <div class="cond">
               <span>Difficulty</span>
               <span class="menu-opts small">
                 ${DIFFICULTIES.map((d) => `<button type="button" data-diff="${d}">${d}</button>`).join('')}
               </span>
             </div>
             <div class="cond">
               <span>Graphics</span>
               <span class="menu-opts small">
                 ${TIERS.map((t) => `<button type="button" data-tier="${t}">${t}</button>`).join('')}
               </span>
             </div>
             <label class="cond">
               <span>Seed</span>
               <input class="seed" type="number" min="0" max="4294967295" step="1" />
               <button type="button" class="reroll" title="New seed">&#8635;</button>
             </label>
           </div>
         </section>

         <footer class="menu-foot">
           <button type="button" class="ghost restore">Historical order of battle</button>
           <span class="foot-spacer"></span>
           <button type="button" class="ghost share">Copy link to this battle</button>
           <button type="button" class="begin">BEGIN BATTLE</button>
         </footer>
       </div>`
    );

    this.buildArmies();

    for (const b of this.qsa('[data-map]')) {
      const id = b.dataset.map as MapId;
      this.mapBtns.set(id, b);
      b.addEventListener('click', () => {
        if (this.cfg.map === id) return;
        // The hour moves with the map. Each battlefield's default is the light it was
        // designed around — 10:00 over the Campus Martius, 17:00 over Pydna, where a
        // broadside 26 deg sun is the whole point — and carrying one map's hour onto the
        // other reliably produces the flat, shadowless frame both were tuned to avoid.
        // A player who then moves the slider keeps their choice until they switch again.
        //
        // `sanitiseConfig` also drops the assault when the new map has no wall, which is why
        // it runs here and not only at Begin: the roster rows have to follow immediately, and
        // `refresh` puts the reason on screen. Switching *away* from the map does not restore
        // the assault, which is the honest behaviour — the player would not see it happen.
        const before = this.cfg.scenario;
        this.cfg = sanitiseConfig({ ...this.cfg, map: id, timeOfDay: getMap(id).sky.defaultHour });
        this.droppedAssault = before === 'assault' && this.cfg.scenario !== 'assault';
        this.buildArmies();
        this.refresh();
      });
    }
    for (const b of this.qsa('[data-scen]')) {
      const id = b.dataset.scen as ScenarioId;
      this.scenBtns.set(id, b);
      b.addEventListener('click', () => {
        if (this.cfg.scenario === id || this.scenarioBlocked(id)) return;
        this.cfg = { ...this.cfg, scenario: id };
        this.droppedAssault = false;
        // The two orders of battle are different lists of unit types, so the rows themselves
        // change, not just their numbers. Both compositions survive the switch — see
        // `siegeRome`/`siegeJuthungi` in `battleConfig` — so flipping back and forth costs
        // the player nothing.
        this.buildArmies();
        this.refresh();
      });
    }
    for (const b of this.qsa('[data-opp]')) {
      const f = Number(b.dataset.opp) as Faction;
      this.oppBtns.set(f, b);
      b.addEventListener('click', () => {
        if (this.cfg.opponent === f || this.opponentBlocked() !== null) return;
        this.cfg = { ...this.cfg, opponent: f };
        // The rows themselves change — the Punic roster is a different list of unit types
        // from the Juthungi one, and both compositions are carried side by side in the
        // config, so switching back and forth costs the player neither order of battle.
        this.buildArmies();
        this.refresh();
      });
    }
    for (const b of this.qsa('[data-size]')) {
      const id = b.dataset.size as UnitSizeId;
      this.sizeBtns.set(id, b);
      b.addEventListener('click', () => {
        this.cfg = { ...this.cfg, unitSize: id };
        this.refresh();
      });
    }
    for (const b of this.qsa('[data-tier]')) {
      const t = b.dataset.tier as QualityTier;
      this.tierBtns.set(t, b);
      b.addEventListener('click', () => {
        this.cfg = { ...this.cfg, quality: t };
        this.refresh();
      });
    }
    for (const b of this.qsa('[data-diff]')) {
      const d = b.dataset.diff as Difficulty;
      this.diffBtns.set(d, b);
      b.addEventListener('click', () => {
        this.cfg = { ...this.cfg, difficulty: d };
        this.refresh();
      });
    }
    const tod = this.q<HTMLInputElement>('.tod');
    tod.addEventListener('input', () => {
      this.cfg = { ...this.cfg, timeOfDay: Number(tod.value) };
      this.refresh();
    });
    const seed = this.q<HTMLInputElement>('.seed');
    seed.addEventListener('change', () => {
      this.cfg = sanitiseConfig({ ...this.cfg, seed: Number(seed.value) });
      this.refresh();
    });
    this.q('.reroll').addEventListener('click', () => {
      // Menu-time only, so a non-deterministic source is fine here — the seed it produces
      // is then fixed for the whole battle, which is what determinism actually requires.
      this.cfg = { ...this.cfg, seed: Math.floor(Math.random() * 0x100000000) };
      this.refresh();
    });
    this.q('.restore').addEventListener('click', () => {
      // Restores the historical order of battle *for the battle on screen*, not the whole
      // config: a player who has chosen the assault and then wants the shipped assault back
      // should not be silently returned to the field battle on a different map.
      // `opponent` is kept for the same reason `map` and `scenario` are: it selects *which*
      // battle, not how it is drawn up, and a player who has chosen Carthage and then asks
      // for the historical order of battle means the Punic one.
      this.cfg = { ...DEFAULT_CONFIG, map: this.cfg.map, scenario: this.cfg.scenario,
        opponent: this.cfg.opponent,
        quality: this.cfg.quality, difficulty: this.cfg.difficulty,
        timeOfDay: this.cfg.timeOfDay, seed: this.cfg.seed };
      this.buildArmies();
      this.refresh();
    });
    this.q('.share').addEventListener('click', () => this.share());
    this.q('.begin').addEventListener('click', () => this.commit());
    this.q('.menu-back').addEventListener('click', () => this.toHome());

    // Battle is the only destination handled in script. The other two are anchors and the
    // browser already knows what to do with them.
    this.q('[data-dest="battle"]').addEventListener('click', () => this.toSetup());

    /*
     * Roving arrow keys over the front door, on top of the Tab order the anchors and the
     * button already have for free.
     *
     * This game is played with a mouse in one hand and the keyboard under the other, and a
     * three-item vertical list is the one shape where Up and Down are what a hand reaches
     * for. `preventDefault` because the alternative is the sheet scrolling under the
     * selection, which on a short viewport moves the thing the player is aiming at.
     */
    this.destEls = this.qsa('.home-dest .dest');
    this.q('.home-dest').addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      const d = ke.key === 'ArrowDown' ? 1 : ke.key === 'ArrowUp' ? -1 : 0;
      if (d === 0 || this.destEls.length === 0) return;
      ke.preventDefault();
      const i = this.destEls.indexOf(document.activeElement as HTMLElement);
      this.destEls[(Math.max(i, 0) + d + this.destEls.length) % this.destEls.length].focus();
    });

    this.root.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        // Back out of the setup, keeping the army. Nothing to escape from on the front door.
        if (this.screen === 'setup') this.toHome();
        return;
      }
      if (ke.key !== 'Enter') return;
      /*
       * Enter is each screen's shortcut for its own obvious action — BEGIN BATTLE on the
       * setup, Battle on the front door — but only when no control owns the keystroke.
       *
       * A focused `<button>` or `<a>` turns Enter into a click, and this listener runs
       * *before* that default action. Without the guard, Enter with the focus ring on
       * "Historical order of battle" started the battle instead of restoring the order of
       * battle, and Enter on the back arrow started it instead of going back. That was
       * already true of the ghost buttons before this screen had a back arrow; it is fixed
       * here rather than left, because a second control with the same fault is a pattern.
       *
       * Inputs are deliberately not in the guard: Enter in the seed box has always meant
       * "done, fight it", there is no form for the browser to submit, and a number field
       * that swallowed Enter would be a regression.
       */
      const t = ke.target as HTMLElement | null;
      if (t && t.closest('button, a')) return;
      if (this.screen === 'setup') this.commit();
      else this.toSetup();
    });
  }

  /** Paint the current step onto the root. CSS hides the sheet that is not it. */
  private applyStep(): void {
    setClass(this.root, 'at-home', this.screen === 'home');
    setClass(this.root, 'at-setup', this.screen === 'setup');
  }

  /**
   * Into the setup flow, which from here on is exactly the screen that shipped.
   *
   * Focus lands on the sheet rather than on a control inside it. Putting it on BEGIN BATTLE
   * would mean the Enter that opened this screen was one keystroke away from starting the
   * battle without the player having chosen anything; putting it on the back arrow would
   * point the keyboard at the exit. The sheet is `tabindex="-1"` so it can take focus
   * without joining the Tab order, and Tab from there walks the screen in reading order.
   */
  private toSetup(): void {
    if (this.screen === 'setup') return;
    this.screen = 'setup';
    this.applyStep();
    this.q('.menu-setup').focus();
  }

  /**
   * Back to the front door, with the army intact.
   *
   * Nothing is rebuilt and nothing is written: `this.cfg` is the only state the setup screen
   * has, it is not touched here, and the DOM it drives is merely hidden. Come back and the
   * order of battle, the map, the hour and the seed are all as they were.
   *
   * It is deliberately *not* written to storage on the way out. `storeConfig` runs in
   * `commit` and only there, so what a later visit restores is the last battle actually
   * fought rather than the last one idly poked at — and `resolveConfig` reads that same
   * store on every `?menu=0` load, so widening who writes to it would quietly change which
   * battle a probe measures.
   */
  private toHome(): void {
    if (this.screen === 'home') return;
    this.screen = 'home';
    this.applyStep();
    (this.q('[data-dest="battle"]') as HTMLElement).focus();
  }

  /**
   * Render the two army panels for the current scenario and wire their steppers.
   *
   * Rebuilt rather than repainted when the scenario changes, because the rows are different
   * unit types and not different numbers: the field battle has cohorts and equites, the
   * assault has ram crews and onagers, and neither list is a subset of the other. Both
   * `countCells` and `stepBtns` index DOM nodes that this replaces, so both are cleared first
   * — leaving them would keep a live click handler on a detached row, which is how a menu
   * ends up silently editing an army the player is no longer looking at.
   */
  private buildArmies(): void {
    const sc = this.cfg.scenario;
    this.countCells.clear();
    this.stepBtns.length = 0;
    html(
      this.q('.menu-armies'),
      belligerents(this.cfg).map((f) => `
        <section class="army army-${FACTION_CLASS[f]}" data-side="${f}">
          <div class="army-head">
            <span class="army-name">${SIDE_LABEL[f]}</span>
            <span class="army-sub">${sideSub(this.cfg, f)}</span>
          </div>
          <div class="army-rows">
            ${rosterFor(f, sc, this.cfg.map).map((id) => {
              const d = unitType(id);
              return `
              <div class="urow" data-side="${f}" data-unit="${id}">
                <span class="uname">
                  <b>${d.name}</b>
                  <i>${CLASS_LABEL[d.unitClass]} &middot; ${d.strength} base</i>
                </span>
                <span class="ustep">
                  <button type="button" class="minus" data-side="${f}" data-unit="${id}" data-d="-1" aria-label="fewer">&minus;</button>
                  <b class="ucount" data-count="${f}:${id}">0</b>
                  <button type="button" class="plus" data-side="${f}" data-unit="${id}" data-d="1" aria-label="more">+</button>
                </span>
              </div>`;
            }).join('')}
          </div>
          <div class="army-tot" data-tot="${f}"></div>
        </section>`).join('')
    );
    for (const c of this.qsa('[data-count]')) {
      this.countCells.set(c.dataset.count as string, c);
    }
    for (const b of this.qsa('.ustep button')) {
      const f = Number(b.dataset.side) as Faction;
      const id = b.dataset.unit as string;
      const d = Number(b.dataset.d);
      this.stepBtns.push({ el: b as HTMLButtonElement, f, id, d });
      b.addEventListener('click', () => this.step(f, id, d));
    }
  }

  /**
   * Why the enemy cannot be chosen right now, or null when it can.
   *
   * A storm has no choice in it, because the wall already names both sides: `belligerents`
   * reads the defender out of `CityPlan.garrison` and the besieger is whoever that is not.
   * The Aurelian Wall is Rome's, so Rome holds it against the Juthungi; the triple wall is
   * Carthage's, so Rome storms it. Greyed with the reason rather than left live over a
   * choice that would be ignored — a disabled control that does not say why is the same bug
   * as no control at all.
   */
  private opponentBlocked(): string | null {
    if (this.cfg.scenario !== 'assault') return null;
    const map = getMap(this.cfg.map);
    return `A storm is fought by whoever holds the wall and whoever is outside it, so `
      + `${map.label} names both sides. Choose the field battle to pick an enemy.`;
  }

  /** Why this scenario cannot be chosen right now, or null when it can. */
  private scenarioBlocked(id: ScenarioId): string | null {
    const def = scenarioDef(id);
    const map = getMap(this.cfg.map);
    if (def.needsCity && !map.city) {
      return `${map.label} is open ground — there is no wall on it to storm. `
        + 'Choose the Campus Martius for the assault.';
    }
    return null;
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private qsa(sel: string): HTMLElement[] {
    return Array.from(this.root.querySelectorAll(sel)) as HTMLElement[];
  }

  private step(f: Faction, id: string, d: number): void {
    const comp = { ...compositionFor(this.cfg, f) };
    const cur = comp[id] ?? 0;
    const total = unitCount(comp);
    const next = cur + d;
    if (next < 0 || next > MAX_PER_TYPE) return;
    if (d > 0 && total >= MAX_UNITS_PER_SIDE) return;
    comp[id] = next;
    // Seven fields, not two: the stepper writes into whichever composition belongs to the
    // scenario, the side and — for an assault — the map, so editing a siege never touches the
    // field order of battle or the reverse. A Carthaginian row edited into `juthungi` would
    // silently rewrite the Juthungi order of battle and the player would see their change
    // vanish the moment they switched opponent back; a Roman siege-train row edited into
    // `siegeRome` would rewrite the Aurelian Wall's garrison from the far side of the
    // Mediterranean. `assaultCompositionKey` owns that last decision so this file and
    // `compositionFor` cannot disagree about it.
    const key = this.cfg.scenario === 'assault'
      ? assaultCompositionKey(f, this.cfg.map)
      : f === Faction.Rome ? 'rome'
        : f === Faction.Carthage ? 'carthage' : 'juthungi';
    this.cfg = { ...this.cfg, [key]: comp };
    this.refresh();
  }

  /**
   * Repaint every derived figure from `this.cfg`.
   *
   * Deliberately a full repaint rather than targeted updates: the numbers are all coupled —
   * changing one cohort count moves both armies' totals, the frontage, the pool clamp and
   * which steppers are still legal — and a partial update is how a menu ends up showing a
   * stale total next to a fresh one.
   */
  private refresh(): void {
    const sc = this.cfg.scenario;
    const scDef = scenarioFor(sc, this.cfg.map);
    for (const [id, b] of this.mapBtns) setClass(b, 'on', id === this.cfg.map);
    for (const [id, b] of this.sizeBtns) setClass(b, 'on', id === this.cfg.unitSize);
    const mapDef = getMap(this.cfg.map);
    setText(this.q('[data-map-blurb]'), `${mapDef.blurb} ${mapDef.site.season}.`);
    // The heading follows the battlefield and the battle, so the screen never claims to be
    // an engagement the player has just navigated away from.
    html(this.q('.menu-head h2'), `${mapDef.subtitle} &middot; ${scDef.label}`);

    // The scenario row, and the one pairing that cannot be had. A blocked option is disabled
    // and *says why* on the blurb line rather than being hidden or silently ignored — a
    // greyed button with no reason is the same bug as no button at all.
    let scenNote = scDef.blurb;
    // The sub-labels follow the map: "The Campus Martius" under Field Battle is a lie on
    // Pydna, and "Storming the Aurelian Wall" is one on any city that is not Rome.
    for (const el of this.qsa('[data-scen-sub]')) {
      const id = el.dataset.scenSub as ScenarioId;
      setText(el, scenarioFor(id, this.cfg.map).subtitle);
    }
    for (const [id, b] of this.scenBtns) {
      const why = this.scenarioBlocked(id);
      setClass(b, 'on', id === sc);
      setClass(b, 'off', why !== null);
      (b as HTMLButtonElement).disabled = why !== null;
      b.title = why ?? '';
      if (why) scenNote = why;
    }
    if (this.droppedAssault) {
      scenNote = `${mapDef.label} has no wall, so the battle has gone back to the field. ${scDef.blurb}`;
    }
    setText(this.q('[data-scen-blurb]'), scenNote);

    // The enemy row. `belligerents()` is what the battle will actually field, so the
    // highlight follows *it* rather than `cfg.opponent` — in a storm the config may still
    // say Carthage while the battle is against the Juthungi, and a lit button under an
    // army that is not going to be there is the worst kind of menu.
    const oppWhy = this.opponentBlocked();
    const foe = belligerents(this.cfg)[1];
    setClass(this.q('.opp-row'), 'inert', oppWhy !== null);
    for (const [f, b] of this.oppBtns) {
      setClass(b, 'on', f === foe);
      setClass(b, 'off', oppWhy !== null && f !== foe);
      (b as HTMLButtonElement).disabled = oppWhy !== null;
      b.title = oppWhy ?? '';
    }
    setText(this.q('.opp-row .lab-sub'), oppWhy ?? 'Who Rome is fighting');

    for (const [t, b] of this.tierBtns) setClass(b, 'on', t === this.cfg.quality);
    for (const [d, b] of this.diffBtns) setClass(b, 'on', d === this.cfg.difficulty);

    // Battle size is inert in a storm — see `scaleAppliesTo`. Greying the row is honest about
    // that; leaving it live would let a player set Ultra and get establishment anyway.
    const sizeLive = scaleAppliesTo(sc);
    setClass(this.q('.size-row'), 'inert', !sizeLive);
    for (const [, b] of this.sizeBtns) (b as HTMLButtonElement).disabled = !sizeLive;
    setText(this.q('.size-row .lab-sub'), sizeLive
      ? 'Multiplies every unit’s establishment'
      : 'Not used in a storm — the wall holds what it holds');

    const pool = QUALITY_PRESETS[this.cfg.quality].maxSoldiers;
    const tod = this.q<HTMLInputElement>('.tod');
    tod.value = String(this.cfg.timeOfDay);
    setText(this.q('.tod-val'), `${String(this.cfg.timeOfDay).padStart(2, '0')}:00`);
    this.q<HTMLInputElement>('.seed').value = String(this.cfg.seed);

    let grand = 0;
    for (const f of belligerents(this.cfg)) {
      const comp = compositionFor(this.cfg, f);
      const s = summarise(this.cfg, f, pool);
      grand += s.men;
      for (const id of rosterFor(f, sc, this.cfg.map)) {
        const cell = this.countCells.get(`${f}:${id}`);
        if (cell) {
          setText(cell, String(comp[id] ?? 0));
          setClass(cell, 'zero', (comp[id] ?? 0) === 0);
        }
      }
      const tot = this.root.querySelector(`[data-tot="${f}"]`) as HTMLElement;
      const full = s.units >= MAX_UNITS_PER_SIDE;
      const fr = frontageLabel(this.cfg, f);
      html(tot, `
        <span><b>${s.units}</b> units${full ? ' <i class="cap">(max)</i>' : ''}</span>
        <span><b>${fmt(s.men)}</b> men</span>
        <span title="${fr.title}"><b>${fmt(s.frontage)}</b> ${fr.unit}</span>`);
    }

    // Steppers grey out at their own limits so the caps are visible before they bite.
    for (const s of this.stepBtns) {
      const comp = compositionFor(this.cfg, s.f);
      const cur = comp[s.id] ?? 0;
      const total = unitCount(comp);
      s.el.disabled = s.d < 0
        ? cur <= 0
        : cur >= MAX_PER_TYPE || total >= MAX_UNITS_PER_SIDE;
    }

    // Two independent notes, either or both of which can apply: the pool forced a smaller
    // battle than asked for, and/or the battle is bigger than the frame budget was measured
    // to survive. They are different problems with different answers, so they are not merged.
    const notes: string[] = [];
    if (isScaleClamped(this.cfg, pool)) {
      const asked = unitSizePreset(this.cfg.unitSize);
      const got = fittedUnitScale(this.cfg, pool);
      const wanted = Math.round(asked.scale * baseStrength(this.cfg));
      notes.push(`<p class="note-clamp">
        <b>Battle size limited by the ${this.cfg.quality} detail tier.</b>
        ${asked.label} wants ${fmt(wanted)} men but the pool holds ${fmt(pool)}, so every unit
        is scaled to &times;${got.toFixed(2)} instead of &times;${asked.scale.toFixed(2)} —
        ${fmt(grand)} men, all units still present. Raise Graphics, or field fewer units, for
        the size you asked for.</p>`);
    }
    if (grand > PERF_VALIDATED_MEN) {
      notes.push(`<p class="note-perf">
        <b>${fmt(grand)} men is past the ${fmt(PERF_VALIDATED_MEN)} this runs at 60 fps.</b>
        Measured on an M4 Max at 1920&times;1080, a heavy frame costs 13.4 ms at 8,644 men,
        16.1 ms at 9,584 and 19.2 ms at 11,255 — so a big melee here will drop under 60 fps.
        The battle is correct either way; it just will not be smooth.</p>`);
    }
    const warn = this.q('.menu-warn');
    warn.hidden = notes.length === 0;
    html(warn, notes.join(''));
  }

  private async share(): Promise<void> {
    const url = new URL(location.href);
    url.searchParams.set('battle', encodeConfig(this.cfg));
    url.searchParams.delete('menu');
    const btn = this.q('.share');
    try {
      await navigator.clipboard.writeText(url.toString());
      setText(btn, 'Link copied');
    } catch {
      // Clipboard is permission-gated and unavailable over plain http on some browsers.
      // Falling back to putting it in the address bar still gets the player the link.
      history.replaceState(null, '', url);
      setText(btn, 'Link in address bar');
    }
    setTimeout(() => setText(btn, 'Copy link to this battle'), 2200);
  }

  private commit(): void {
    const cfg = sanitiseConfig(this.cfg);
    storeConfig(cfg);
    // The interactive counterpart of the calls in `resolveConfig`: this is the only path on
    // which the player can have changed the map or the enemy since that ran.
    setActiveMap(cfg.map);
    publishBelligerents(cfg);
    this.root.classList.remove('in');
    this.root.classList.add('out');
    // Let the fade finish before the DOM node goes, but resolve immediately so asset
    // loading overlaps the transition instead of waiting on it.
    setTimeout(() => this.root.remove(), 620);
    this.resolve({ config: cfg, interactive: true });
  }
}
