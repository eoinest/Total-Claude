/**
 * The bottom bar: one card per unit, grouped by army.
 *
 * Each card carries a procedurally drawn bust, the roster name and native name, a
 * strength bar, a morale pennant that changes state and pulses when it does, fatigue
 * and ammunition meters, and status flags for charging, melee, braced and routed.
 *
 * Performance shape: the DOM is built once, then `sync()` runs at 10 Hz and writes only
 * the leaves whose value actually changed. Bars are `scaleX` transforms with a CSS
 * transition, so values tween on the compositor and cost the main thread nothing.
 */

import type { EngineContext } from '../core/Engine';
import { Faction } from '../sim/types';
import { el, html, icon, pulse, setClass, setFill, setText, sizeCanvas } from './dom';
import { ICON, standardGlyph, UNIT_CLASS_ICON } from './icons';
import type { HudModel, UnitView } from './model';
import { drawPortrait } from './portrait';
import { FACTION_UI, MORALE_UI, type MoraleState } from './theme';
import type { SelectionController } from './SelectionController';
import type { Tooltip } from './Tooltip';

interface CardEls {
  view: UnitView;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  name: HTMLElement;
  count: HTMLElement;
  pennant: HTMLElement;
  strFill: HTMLElement;
  fatFill: HTMLElement;
  ammoFill: HTMLElement;
  ammoWrap: HTMLElement;
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
  drawnAt: number;
}

const FLAG_KEYS = ['charging', 'melee', 'braced', 'shooting', 'routing'] as const;

export class UnitCards {
  private root!: HTMLElement;
  private groups = new Map<Faction, HTMLElement>();
  private cards: CardEls[] = [];
  private generation = -1;
  private hoverTimer = 0;
  private hoverCard: CardEls | null = null;

  constructor(
    private model: HudModel,
    private controller: SelectionController,
    private tooltip: Tooltip
  ) {}

  attach(parent: HTMLElement): void {
    this.root = el('div', 'cardbar hud-panel interactive', parent);
    html(
      this.root,
      `<div class="cardbar-inner"></div>
       <div class="cardbar-rule"></div>`
    );
  }

  /** Rebuild the card DOM. Called once the scenario has deployed, and never per frame. */
  private build(ctx: EngineContext): void {
    const inner = this.root.querySelector('.cardbar-inner') as HTMLElement;
    inner.textContent = '';
    this.groups.clear();
    this.cards.length = 0;

    const order: Faction[] = [Faction.Rome, Faction.Germanic];
    for (let gi = 0; gi < order.length; gi++) {
      const f = order[gi];
      const views = this.model.views.filter((v) => v.faction === f);
      if (views.length === 0) continue;
      if (gi > 0) el('div', 'grp-div', inner);

      const fui = FACTION_UI[f];
      const grp = el('div', 'cgrp', inner);
      grp.dataset.f = fui.key;
      // Share the bar by unit count, so cards are the same width in both armies.
      grp.style.flexGrow = String(views.length);
      html(
        grp,
        `<div class="cgrp-tab">${icon(standardGlyph(f), 'cgrp-std')}<span class="cgrp-name">${fui.short}</span></div>
         <div class="cgrp-cards"></div>`
      );
      const holder = grp.querySelector('.cgrp-cards') as HTMLElement;
      this.groups.set(f, holder);
      for (const v of views) this.cards.push(this.makeCard(v, holder, ctx));
    }
    this.relayout();
  }

  private makeCard(v: UnitView, parent: HTMLElement, ctx: EngineContext): CardEls {
    const root = el('div', 'card', parent);
    root.dataset.f = FACTION_UI[v.faction].key;
    if (!v.own) root.classList.add('foe');
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', `${v.title}, ${v.def.nativeName}`);

    html(
      root,
      `<div class="card-por">
         <canvas></canvas>
         <span class="card-pen">${icon(ICON.flag, 'pen-ic')}</span>
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
       <div class="card-name">${v.title}</div>
       <div class="card-native">${v.def.nativeName}</div>
       <div class="card-bar str"><i></i></div>
       <div class="card-meters">
         <span class="card-meter fat" title="Fatigue"><i></i></span>
         <span class="card-meter ammo" title="Ammunition"><i></i></span>
       </div>`
    );

    const flags: Record<string, HTMLElement> = {};
    for (const k of FLAG_KEYS) flags[k] = root.querySelector(`.cf.${k}`) as HTMLElement;

    const c: CardEls = {
      view: v,
      root,
      canvas: root.querySelector('canvas') as HTMLCanvasElement,
      name: root.querySelector('.card-name') as HTMLElement,
      count: root.querySelector('.card-count') as HTMLElement,
      pennant: root.querySelector('.card-pen') as HTMLElement,
      strFill: root.querySelector('.card-bar.str > i') as HTMLElement,
      fatFill: root.querySelector('.card-meter.fat > i') as HTMLElement,
      ammoFill: root.querySelector('.card-meter.ammo > i') as HTMLElement,
      ammoWrap: root.querySelector('.card-meter.ammo') as HTMLElement,
      flags,
      last: {
        alive: -1, str: -1, morale: 'steady', fatigue: -1, ammo: -1,
        charging: false, melee: false, braced: false, routing: false, shooting: false,
        selected: false, hovered: false, dead: false,
      },
      drawnAt: 0,
    };
    if (!v.hasMissiles) c.ammoWrap.classList.add('none');

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!v.own || v.destroyed) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.controller.toggle(v.id, ctx);
      else this.controller.selectOnly(v.id, ctx);
    });
    // Total War's convention: double-clicking a card takes the camera to the unit.
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
   * Flexbox cannot express "shrink the cards, and only wrap to a second row once they
   * would be too small to read" — it breaks lines at the flex basis, before shrinking.
   * So the width is computed here: each army's strip already gets a share of the bar
   * proportional to its unit count, so dividing that share by the number of cards gives
   * the same card width in both armies, and a second row is used only when one row would
   * force cards below the legibility floor.
   */
  relayout(): void {
    const inner = this.root.querySelector('.cardbar-inner') as HTMLElement | null;
    if (inner && this.cards.length > 0) {
      const em = parseFloat(getComputedStyle(this.root).fontSize) || 10;
      const gap = 0.3 * em;
      const min = 4.7 * em;
      const max = 7.8 * em;
      const groups = this.groups.size;

      // Everything in the bar that is not a card: the vertical army tabs, the divider
      // between armies, and the gaps around them.
      let overhead = 0;
      for (const tab of Array.from(inner.querySelectorAll('.cgrp-tab'))) {
        overhead += (tab as HTMLElement).offsetWidth + 0.4 * em;
      }
      const div = inner.querySelector('.grp-div') as HTMLElement | null;
      if (div) overhead += div.offsetWidth + 0.3 * em * 2;
      overhead += 0.5 * em * Math.max(0, groups + (div ? 1 : 0) - 1);

      const n = this.cards.length;
      const avail = inner.clientWidth - overhead;
      let per = (avail - gap * (n - groups)) / n;
      if (per < min) {
        // Two rows: size the cards so half the army fits across the bar.
        const rowCards = Math.ceil(n / 2);
        per = (avail - gap * (rowCards - groups)) / rowCards;
      }
      per = Math.max(3.6 * em, Math.min(max, per));
      inner.style.setProperty('--cw', `${per.toFixed(1)}px`);
    }

    for (const c of this.cards) {
      const r = c.canvas.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const dpr = sizeCanvas(c.canvas, r.width, r.height);
      const g = c.canvas.getContext('2d');
      if (!g) continue;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPortrait(g, r.width, r.height, c.view.def);
    }
  }

  /** Per-frame, cheap: only advances the tooltip hover delay. */
  tick(dt: number, ctx: EngineContext): void {
    if (!this.hoverCard) return;
    if (this.tooltip.visibleFor === this.hoverCard.view.id) return;
    this.hoverTimer += dt;
    // A short dwell keeps tooltips from strobing as the cursor crosses the bar.
    if (this.hoverTimer > 0.18) {
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
    for (const c of this.cards) {
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
      if (Math.abs(v.fatigue - L.fatigue) > 0.01) {
        L.fatigue = v.fatigue;
        setFill(c.fatFill, v.fatigue);
        setClass(c.fatFill.parentElement as HTMLElement, 'hot', v.fatigue > 0.66);
      }
      if (v.hasMissiles && Math.abs(v.ammoFrac - L.ammo) > 0.01) {
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
  }

  dispose(): void {
    this.root.remove();
  }
}
