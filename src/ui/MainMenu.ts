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
 */

import type { QualityTier } from '../core/Engine';
import {
  type BattleConfig, type Difficulty, DEFAULT_CONFIG, MAX_PER_TYPE, MAX_UNITS_PER_SIDE,
  UNIT_SIZES, type UnitSizeId, baseStrength, compositionFor, decodeConfig, encodeConfig,
  PERF_VALIDATED_MEN, fittedUnitScale, isScaleClamped, loadStoredConfig, rosterFor,
  sanitiseConfig, storeConfig,
  summarise, unitCount, unitSizePreset,
} from '../sim/battleConfig';
import { QUALITY_PRESETS } from '../core/Engine';
import { MAPS, getMap, setActiveMap, type MapId } from '../maps';
import { Faction, type UnitClass } from '../sim/types';
import { unitType } from '../units/roster';
import { el, html, icon, setClass, setText } from './dom';
import { ICON } from './icons';

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'legendary'];

const SIDE_LABEL: Record<number, string> = {
  [Faction.Rome]: 'ROME',
  [Faction.Germanic]: 'JUTHUNGI',
};

const SIDE_SUB: Record<number, string> = {
  [Faction.Rome]: 'Aurelian&rsquo;s field army &middot; defending',
  [Faction.Germanic]: 'The host of the Juthungi &middot; attacking',
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
  const cfg = decoded ?? (useStored ? loadStoredConfig() : null) ?? DEFAULT_CONFIG;
  // Publish the choice to `src/maps` here, and again in `commit`.
  //
  // `main.ts` constructs every subsystem with no arguments and `EngineContext` carries no
  // configuration field, so a module singleton is the only channel by which a map choice can
  // reach the terrain — and this function is the one point every non-interactive path goes
  // through (the harness, `?menu=0`, and a shared `?battle=` link). It runs before the engine
  // exists, let alone `TerrainSystem.init`. See `setActiveMap` for the full ordering argument.
  setActiveMap(cfg.map);
  return cfg;
}

export class MainMenu {
  private root!: HTMLElement;
  private cfg: BattleConfig;
  private resolve!: (r: MenuResult) => void;
  private sizeBtns = new Map<UnitSizeId, HTMLElement>();
  private tierBtns = new Map<QualityTier, HTMLElement>();
  private diffBtns = new Map<Difficulty, HTMLElement>();
  private mapBtns = new Map<MapId, HTMLElement>();
  private countCells = new Map<string, HTMLElement>();
  private stepBtns: Array<{ el: HTMLButtonElement; f: Faction; id: string; d: number }> = [];

  constructor(initial: BattleConfig) {
    this.cfg = sanitiseConfig(initial);
  }

  /** Resolves once the player commits. */
  show(host: HTMLElement): Promise<MenuResult> {
    this.root = el('div', 'menu', host);
    this.build();
    this.refresh();
    // Two frames, so the browser has laid the panel out before the transition starts and
        // the fade actually runs instead of being skipped as an initial style.
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.add('in')));
    return new Promise<MenuResult>((res) => {
      this.resolve = res;
    });
  }

  private build(): void {
    html(
      this.root,
      `<div class="menu-bg"></div>
       <div class="menu-sheet">
         <header class="menu-head">
           <div class="menu-eagle">
             <!-- The same mark as the loading screen, so the two screens read as one game. -->
             <svg viewBox="0 0 64 64" class="menu-ic" aria-hidden="true">
               <path fill="currentColor" opacity=".85"
                 d="M32 4l4 8 10-4-3 9 11 1-8 6 8 6-11 1 3 9-10-4-4 8-4-8-10 4 3-9-11-1 8-6-8-6 11-1-3-9 10 4z" />
             </svg>
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

         <div class="menu-armies">
           ${[Faction.Rome, Faction.Germanic].map((f) => `
             <section class="army army-${f === Faction.Rome ? 'rome' : 'germanic'}" data-side="${f}">
               <div class="army-head">
                 <span class="army-name">${SIDE_LABEL[f]}</span>
                 <span class="army-sub">${SIDE_SUB[f]}</span>
               </div>
               <div class="army-rows">
                 ${rosterFor(f).map((id) => {
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
             </section>`).join('')}
         </div>

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

    for (const b of this.qsa('[data-map]')) {
      const id = b.dataset.map as MapId;
      this.mapBtns.set(id, b);
      b.addEventListener('click', () => {
        if (this.cfg.map === id) return;
        // The hour moves with the map. Each battlefield's default is the light it was
        // designed around — 10:00 over the Campus Martius, 16:00 over Pydna, where a
        // broadside 37 deg sun is the whole point — and carrying one map's hour onto the
        // other reliably produces the flat, shadowless frame both were tuned to avoid.
        // A player who then moves the slider keeps their choice until they switch again.
        this.cfg = { ...this.cfg, map: id, timeOfDay: getMap(id).sky.defaultHour };
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
      this.cfg = DEFAULT_CONFIG;
      this.refresh();
    });
    this.q('.share').addEventListener('click', () => this.share());
    this.q('.begin').addEventListener('click', () => this.commit());

    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.commit();
    });
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
    this.cfg = f === Faction.Rome ? { ...this.cfg, rome: comp } : { ...this.cfg, juthungi: comp };
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
    for (const [id, b] of this.mapBtns) setClass(b, 'on', id === this.cfg.map);
    for (const [id, b] of this.sizeBtns) setClass(b, 'on', id === this.cfg.unitSize);
    const mapDef = getMap(this.cfg.map);
    setText(this.q('[data-map-blurb]'), `${mapDef.blurb} ${mapDef.site.season}.`);
    // The heading follows the battlefield, so the screen never claims to be a battle the
    // player has just navigated away from.
    html(this.q('.menu-head h2'), mapDef.subtitle);
    for (const [t, b] of this.tierBtns) setClass(b, 'on', t === this.cfg.quality);
    for (const [d, b] of this.diffBtns) setClass(b, 'on', d === this.cfg.difficulty);

    const pool = QUALITY_PRESETS[this.cfg.quality].maxSoldiers;
    const tod = this.q<HTMLInputElement>('.tod');
    tod.value = String(this.cfg.timeOfDay);
    setText(this.q('.tod-val'), `${String(this.cfg.timeOfDay).padStart(2, '0')}:00`);
    this.q<HTMLInputElement>('.seed').value = String(this.cfg.seed);

    let grand = 0;
    for (const f of [Faction.Rome, Faction.Germanic]) {
      const comp = compositionFor(this.cfg, f);
      const s = summarise(this.cfg, f, pool);
      grand += s.men;
      for (const id of rosterFor(f)) {
        const cell = this.countCells.get(`${f}:${id}`);
        if (cell) {
          setText(cell, String(comp[id] ?? 0));
          setClass(cell, 'zero', (comp[id] ?? 0) === 0);
        }
      }
      const tot = this.root.querySelector(`[data-tot="${f}"]`) as HTMLElement;
      const full = s.units >= MAX_UNITS_PER_SIDE;
      html(tot, `
        <span><b>${s.units}</b> units${full ? ' <i class="cap">(max)</i>' : ''}</span>
        <span><b>${fmt(s.men)}</b> men</span>
        <span title="Combined width of the battle-line units — how much front this army can form. Excludes reserves, wings and artillery."><b>${fmt(s.frontage)}</b> m of line</span>`);
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
    // The interactive counterpart of the call in `resolveConfig`: this is the only path on
    // which the player can have changed the map since that ran.
    setActiveMap(cfg.map);
    this.root.classList.remove('in');
    this.root.classList.add('out');
    // Let the fade finish before the DOM node goes, but resolve immediately so asset
    // loading overlaps the transition instead of waiting on it.
    setTimeout(() => this.root.remove(), 620);
    this.resolve({ config: cfg, interactive: true });
  }
}
