/**
 * The bottom bar: one card per unit of the player's own army.
 *
 * Total War never lines the enemy's twenty cards along the bottom edge, and neither do we:
 * the card bar is the player's order of battle, the enemy lives on the field, on the
 * minimap and in the top plaque's balance. The enemy roster is still one keypress away in
 * a collapsed strip above the bar (J), because reading a warband's morale before you
 * commit is genuinely useful — it just is not worth a third of the viewport by default.
 *
 * Each card carries a procedurally drawn bust, a strength bar, a morale pennant that
 * changes state and pulses when it does, fatigue and ammunition meters, the unit ordinal
 * and status flags for charging, melee, braced, shooting and routed. Past ~14 units the
 * bar drops the written name — the row would otherwise have to wrap — and the name moves
 * to the hover tooltip and to the command plaque, which is where Rome II keeps it too.
 *
 * Performance shape: the DOM is built once, then `sync()` runs at 10 Hz and writes only
 * the leaves whose value actually changed. Bars are `scaleX` transforms with a CSS
 * transition, so values tween on the compositor and cost the main thread nothing.
 */

import type { EngineContext } from '../core/Engine';
import { Faction, type UnitClass } from '../sim/types';
import { el, html, icon, pulse, setClass, setFill, setText, sizeCanvas } from './dom';
import { ICON, standardGlyph, UNIT_CLASS_ICON } from './icons';
import type { HudModel, UnitView } from './model';
import { drawPortrait } from './portrait';
import { FACTION_UI, HARNESS, MORALE_UI, PLAYER_FACTION, type MoraleState } from './theme';
import type { SelectionController } from './SelectionController';
import type { Tooltip } from './Tooltip';

interface CardEls {
  view: UnitView;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  count: HTMLElement;
  pennant: HTMLElement;
  strFill: HTMLElement;
  fatFill: HTMLElement | null;
  ammoFill: HTMLElement | null;
  ammoWrap: HTMLElement | null;
  flags: Record<string, HTMLElement>;
  last: {
    alive: number;
    str: number;
    morale: MoraleState;
    fatigue: number;
    ammo: number;
    charging: boolean;
    melee: boolean;
    braced: boolean;
    routing: boolean;
    shooting: boolean;
    selected: boolean;
    hovered: boolean;
    dead: boolean;
  };
}

const FLAG_KEYS = ['charging', 'melee', 'braced', 'shooting', 'routing'] as const;

/**
 * Above this many cards the bar goes compact: the written name is dropped so the row
 * still fits on one line at a legible card width. A late-Roman field army of 21 units is
 * comfortably past it; a small scenario of a dozen keeps its names.
 */
const COMPACT_ABOVE = 14;

/**
 * Cards are grouped by arm, the way an order of battle is actually written out, with a
 * labelled hairline between bands. It costs three columns of width and makes a
 * twenty-card row scannable instead of a wall of identical busts.
 */
const CLASS_BAND: Record<UnitClass, number> = {
  general: 0,
  'heavy-infantry': 0,
  'spear-infantry': 0,
  'light-infantry': 0,
  'shock-infantry': 0,
  'missile-infantry': 1,
  'heavy-cavalry': 2,
  'light-cavalry': 2,
  artillery: 3,
};
const BAND_NAME = ['Foot', 'Missile', 'Horse', 'Engines'];

export class UnitCards {
  private root!: HTMLElement;
  private inner!: HTMLElement;
  private cards: CardEls[] = [];

  /** The enemy order of battle: collapsed to a tab until asked for. */
  private foeBar!: HTMLElement;
  private foeHolder!: HTMLElement;
  private foeCount!: HTMLElement;
  private foeCards: CardEls[] = [];
  private foeOpen = false;

  private generation = -1;
  private hoverTimer = 0;
  private hoverCard: CardEls | null = null;

  constructor(
    private model: HudModel,
    private controller: SelectionController,
    private tooltip: Tooltip
  ) {}

  attach(parent: HTMLElement): void {
    const foeFui = FACTION_UI[PLAYER_FACTION === Faction.Rome ? Faction.Germanic : Faction.Rome];
    this.foeBar = el('div', 'obat', parent);
    html(
      this.foeBar,
      `<button class="obat-tab interactive" type="button" title="Enemy order of battle (J)">
         ${icon(standardGlyph(foeFui.id), 'obat-std')}
         <span class="obat-lab">${foeFui.short}</span>
         <span class="obat-n">0</span>
         <span class="obat-u">units</span>
         ${icon(ICON.chevronUp, 'obat-chev')}
       </button>
       <div class="obat-cards hud-panel interactive"></div>`
    );
    this.foeHolder = this.foeBar.querySelector('.obat-cards') as HTMLElement;
    this.foeCount = this.foeBar.querySelector('.obat-n') as HTMLElement;
    (this.foeBar.querySelector('.obat-tab') as HTMLElement).addEventListener('click', () =>
      this.toggleFoes()
    );

    const own = FACTION_UI[PLAYER_FACTION];
    this.root = el('div', 'cardbar hud-panel interactive', parent);
    html(
      this.root,
      `<div class="cb-tab">${icon(standardGlyph(own.id), 'cb-std')}<span class="cb-name">${own.short}</span></div>
       <div class="cardbar-inner"></div>`
    );
    this.inner = this.root.querySelector('.cardbar-inner') as HTMLElement;
  }

  /** Show or hide the enemy strip. Bound to J and to the tab itself. */
  toggleFoes(): void {
    // Locked shut in the harness: it is an overlay on the battlefield, and the battlefield
    // is what those frames exist to show.
    if (HARNESS) return;
    this.foeOpen = !this.foeOpen;
    setClass(this.foeBar, 'open', this.foeOpen);
    // Portraits in a `display:none` strip measured zero and never painted.
    if (this.foeOpen) this.relayout();
  }

  /** Rebuild the card DOM. Called once the scenario has deployed, and never per frame. */
  private build(ctx: EngineContext): void {
    this.inner.textContent = '';
    this.foeHolder.textContent = '';
    this.cards.length = 0;
    this.foeCards.length = 0;

    // Stable sort into bands so each divider separates one arm from the next.
    const own = this.model.views
      .filter((v) => v.own)
      .map((v, i) => ({ v, i }))
      .sort((a, b) => CLASS_BAND[a.v.def.unitClass] - CLASS_BAND[b.v.def.unitClass] || a.i - b.i);

    let band = -1;
    let bands = 0;
    for (const { v } of own) {
      const b = CLASS_BAND[v.def.unitClass];
      if (band >= 0 && b !== band) {
        const d = el('div', 'band-div', this.inner);
        el('span', 'band-lab', d).textContent = BAND_NAME[b];
        bands++;
      }
      band = b;
      this.cards.push(this.makeCard(v, this.inner, ctx, false));
    }
    this.inner.dataset.bands = String(bands);

    const foes = this.model.views.filter((v) => !v.own);
    for (const v of foes) this.foeCards.push(this.makeCard(v, this.foeHolder, ctx, true));
    setText(this.foeCount, String(foes.length));
    setClass(this.foeBar, 'none', foes.length === 0);

    this.relayout();
  }

  private makeCard(v: UnitView, parent: HTMLElement, ctx: EngineContext, foe: boolean): CardEls {
    const root = el('div', foe ? 'card mini' : 'card', parent);
    root.dataset.f = FACTION_UI[v.faction].key;
    if (!v.own) root.classList.add('foe');
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', `${v.title}, ${v.def.nativeName}`);

    // The mini card is portrait, pennant, ordinal, count and strength only: it exists to
    // be scanned, and the tooltip carries the detail.
    html(
      root,
      `<div class="card-por">
         <canvas></canvas>
         <span class="card-pen">${icon(ICON.flag, 'pen-ic')}</span>
         ${v.ordinal ? `<span class="card-ord">${v.ordinal}</span>` : ''}
         <span class="card-foot">
           <span class="card-cls">${icon(UNIT_CLASS_ICON[v.def.unitClass], 'cls-ic')}</span>
           <span class="card-flags">
             <i class="cf charging">${icon(ICON.charge)}</i>
             <i class="cf melee">${icon(ICON.swords)}</i>
             <i class="cf braced">${icon(ICON.brace)}</i>
             <i class="cf shooting">${icon(ICON.volley)}</i>
             <i class="cf routing">${icon(ICON.rout)}</i>
           </span>
           <span class="card-count">${v.alive}</span>
         </span>
         <span class="card-x">${icon(ICON.skull)}</span>
       </div>
       ${foe ? '' : `<div class="card-name">${v.title}</div>
       <div class="card-native">${v.def.nativeName}</div>`}
       <div class="card-bar str"><i></i></div>
       ${foe ? '' : `<div class="card-meters">
         <span class="card-meter fat" title="Fatigue"><i></i></span>
         <span class="card-meter ammo" title="Ammunition"><i></i></span>
       </div>`}`
    );

    const flags: Record<string, HTMLElement> = {};
    for (const k of FLAG_KEYS) flags[k] = root.querySelector(`.cf.${k}`) as HTMLElement;

    const c: CardEls = {
      view: v,
      root,
      canvas: root.querySelector('canvas') as HTMLCanvasElement,
      count: root.querySelector('.card-count') as HTMLElement,
      pennant: root.querySelector('.card-pen') as HTMLElement,
      strFill: root.querySelector('.card-bar.str > i') as HTMLElement,
      fatFill: root.querySelector('.card-meter.fat > i'),
      ammoFill: root.querySelector('.card-meter.ammo > i'),
      ammoWrap: root.querySelector('.card-meter.ammo'),
      flags,
      last: {
        alive: -1, str: -1, morale: 'steady', fatigue: -1, ammo: -1,
        charging: false, melee: false, braced: false, routing: false, shooting: false,
        selected: false, hovered: false, dead: false,
      },
    };
    if (!v.hasMissiles) c.ammoWrap?.classList.add('none');

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!v.own || v.destroyed) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.controller.toggle(v.id, ctx);
      else this.controller.selectOnly(v.id, ctx);
    });
    // Total War's convention: double-clicking a card takes the camera to the unit. It
    // works on an enemy card too — inspecting the far wing is the point of the strip.
    root.addEventListener('dblclick', () => {
      ctx.rig.jumpTo(v.cx, v.cz, Math.min(0.34, ctx.rig.zoom));
    });
    root.addEventListener('pointerenter', () => {
      this.model.hoveredId = v.id;
      this.hoverCard = c;
      this.hoverTimer = 0;
    });
    root.addEventListener('pointerleave', () => {
      if (this.model.hoveredId === v.id) this.model.hoveredId = -1;
      if (this.hoverCard === c) {
        this.hoverCard = null;
        this.tooltip.hide();
      }
    });

    return c;
  }

  /**
   * Decide the card width and repaint every portrait. Resize and UI-scale changes only.
   *
   * Flexbox cannot express "shrink the cards, and only wrap once they would be too small
   * to read" — it breaks lines at the flex basis, before shrinking — so the width is
   * computed here. One row is the design: a 21-unit army lands near 6em a card, and even
   * 30 stays above the floor. Wrapping is the last resort for an army no Total War title
   * would field, not the normal case it used to be.
   */
  relayout(): void {
    const em = parseFloat(getComputedStyle(this.root).fontSize) || 10;
    const GAP = 0.28 * em;
    const FLOOR = 3.4 * em;

    const n = this.cards.length;
    if (n > 0) {
      // A compact card's height is set by its width — the portrait is square — so the cap
      // is what actually decides how much of the frame the bar eats. 5em is close to Rome
      // II's own card at this resolution and keeps the whole bar under 7% of the viewport;
      // a full-size named card is allowed to be wider because there are fewer of them.
      const compactByCount = n > COMPACT_ABOVE;
      const max = (compactByCount ? 5 : 7.4) * em;
      const bands = Number(this.inner.dataset.bands ?? 0);
      // Band dividers are 1.15em columns with 0.28em of flex gap on each side.
      const avail = this.inner.clientWidth - bands * (1.15 * em + GAP);
      let per = (avail - GAP * (n - 1)) / n;
      let rows = 1;
      // The floor is only reached past ~37 cards — larger than any Total War order of
      // battle — and a second short row is a far better failure than illegible cards.
      while (per < FLOOR && rows < 3) {
        rows++;
        const rowCards = Math.ceil(n / rows);
        per = (avail - GAP * (rowCards - 1)) / rowCards;
      }
      per = Math.max(FLOOR, Math.min(max, per));
      this.inner.style.setProperty('--cw', `${per.toFixed(1)}px`);
      // Names need roughly 5.2em of card to set on two lines without hyphen soup, so a
      // narrow row drops to the compact card even below the count threshold.
      this.root.dataset.mode = compactByCount || per < 5.2 * em ? 'compact' : 'full';
    }

    const fn = this.foeCards.length;
    if (fn > 0) {
      // Slimmer still: the enemy strip is an overlay on the battle, so twenty of these
      // must cost less than the player's own row does.
      const per = Math.max(3 * em, Math.min(3.9 * em, (this.foeHolder.clientWidth - 1.2 * em - GAP * (fn - 1)) / fn));
      this.foeHolder.style.setProperty('--cw', `${per.toFixed(1)}px`);
    }

    for (const c of this.cards) this.paint(c);
    for (const c of this.foeCards) this.paint(c);
  }

  private paint(c: CardEls): void {
    const r = c.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const dpr = sizeCanvas(c.canvas, r.width, r.height);
    const g = c.canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPortrait(g, r.width, r.height, c.view.def);
  }

  /** Per-frame, cheap: only advances the tooltip hover delay. */
  tick(dt: number, ctx: EngineContext): void {
    if (!this.hoverCard) return;
    if (this.tooltip.visibleFor === this.hoverCard.view.id) return;
    this.hoverTimer += dt;
    // A short dwell keeps tooltips from strobing as the cursor crosses the bar.
    if (this.hoverTimer > 0.16) {
      const c = this.hoverCard;
      this.tooltip.show(c.view, c.root.getBoundingClientRect(), ctx.viewW, ctx.viewH);
    }
  }

  /** 10 Hz: diff the model against what is on screen. */
  sync(ctx: EngineContext): void {
    if (this.generation !== this.model.generation) {
      this.generation = this.model.generation;
      this.build(ctx);
    }
    const hoveredId = this.model.hoveredId;
    for (const c of this.cards) this.syncCard(c, hoveredId);
    // A collapsed strip is `display:none`; writing to it would be work nobody sees.
    if (this.foeOpen) for (const c of this.foeCards) this.syncCard(c, hoveredId);
  }

  private syncCard(c: CardEls, hoveredId: number): void {
    const v = c.view;
    const L = c.last;

    if (v.alive !== L.alive) {
      L.alive = v.alive;
      setText(c.count, String(v.alive));
    }
    if (Math.abs(v.strengthFrac - L.str) > 0.002) {
      L.str = v.strengthFrac;
      setFill(c.strFill, v.strengthFrac);
      // Below half strength the bar shifts warm, so a spent unit is obvious.
      setClass(c.root, 'weak', v.strengthFrac < 0.5);
      setClass(c.root, 'spent', v.strengthFrac < 0.25);
    }
    if (v.morale !== L.morale) {
      L.morale = v.morale;
      c.pennant.dataset.m = v.morale;
      c.pennant.style.setProperty('--mor', MORALE_UI[v.morale].colour);
      pulse(c.pennant);
    }
    if (c.fatFill && Math.abs(v.fatigue - L.fatigue) > 0.01) {
      L.fatigue = v.fatigue;
      setFill(c.fatFill, v.fatigue);
      setClass(c.fatFill.parentElement as HTMLElement, 'hot', v.fatigue > 0.66);
    }
    if (c.ammoFill && c.ammoWrap && v.hasMissiles && Math.abs(v.ammoFrac - L.ammo) > 0.01) {
      L.ammo = v.ammoFrac;
      setFill(c.ammoFill, v.ammoFrac);
      setClass(c.ammoWrap, 'hot', v.ammoFrac <= 0.001);
    }

    const melee = v.fighting > 0;
    if (v.charging !== L.charging) { L.charging = v.charging; setClass(c.flags.charging, 'on', v.charging); }
    if (melee !== L.melee) { L.melee = melee; setClass(c.flags.melee, 'on', melee); }
    if (v.braced !== L.braced) { L.braced = v.braced; setClass(c.flags.braced, 'on', v.braced); }
    if (v.shooting !== L.shooting) { L.shooting = v.shooting; setClass(c.flags.shooting, 'on', v.shooting); }
    if (v.routing !== L.routing) { L.routing = v.routing; setClass(c.flags.routing, 'on', v.routing); setClass(c.root, 'routing', v.routing); }

    const sel = this.model.isSelected(v.id);
    if (sel !== L.selected) { L.selected = sel; setClass(c.root, 'sel', sel); }
    const hov = hoveredId === v.id;
    if (hov !== L.hovered) { L.hovered = hov; setClass(c.root, 'hov', hov); }
    if (v.destroyed !== L.dead) { L.dead = v.destroyed; setClass(c.root, 'dead', v.destroyed); }
  }

  dispose(): void {
    this.root.remove();
    this.foeBar.remove();
  }
}
