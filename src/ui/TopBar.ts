/**
 * Top plaque: battle clock, both armies' strength as a balance that shifts as men die,
 * the current phase of the battle, and the game speed controls.
 *
 * The balance bar is the single most useful number on the screen — it is how a player
 * knows whether the line is winning before the casualty list tells them.
 */

import type { EngineContext } from '../core/Engine';
import { Faction, getOpposingFaction } from '../sim/types';
import { el, fmtClock, fmtCount, html, icon, setClass, setFill, setText } from './dom';
import { ICON, standardGlyph } from './icons';
import type { HudModel } from './model';
import { FACTION_UI, PHASE_UI, PLAYER_FACTION } from './theme';

export class TopBar {
  private root!: HTMLElement;
  private clock!: HTMLElement;
  private phase!: HTMLElement;
  private note!: HTMLElement;
  private balR!: HTMLElement;
  private balG!: HTMLElement;
  private mark!: HTMLElement;
  private advantage!: HTMLElement;
  private menR!: HTMLElement;
  private menG!: HTMLElement;
  private lossR!: HTMLElement;
  private lossG!: HTMLElement;
  private unitsR!: HTMLElement;
  private unitsG!: HTMLElement;
  private speedBtns = new Map<string, HTMLElement>();
  private lastPhase = '';
  /**
   * The opponent this plaque is currently *showing*, which is not the same as the opponent.
   *
   * `attach` runs inside `engine.initAll`, and `setOpposingFaction` is not called until
   * `deployBattle`, which runs after it — so reading `getOpposingFaction()` while building the
   * markup bakes in the default and Carthage's plaque reads "JUTHUNGI · 0 units" under a horned
   * standard for the whole battle. The side is therefore built from the default and re-labelled
   * on the first `sync` that disagrees, which costs one comparison a tick and cannot be wrong
   * whatever order the systems initialise in.
   */
  private foeShown: Faction | -1 = -1;
  private foeSide!: HTMLElement;
  private foeName!: HTMLElement;
  private foeStd!: HTMLElement;
  /** Where the settings stud lives, so it reads as part of the plaque rather than as a
   *  lone button floating in the corner. */
  toolSlot!: HTMLElement;

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.root = el('div', 'topbar hud-panel interactive', parent);
    const side = (f: Faction, cls: string): string => {
      const fui = FACTION_UI[f];
      return `<div class="tb-side ${cls}" data-f="${fui.key}">
          <span class="tb-std">${icon(standardGlyph(f), 'tb-std-ic')}</span>
          <span class="tb-block">
            <span class="tb-name">${fui.short}</span>
            <span class="tb-line">
              <b class="tb-men">0</b>
              <span class="tb-loss">−0</span>
              <span class="tb-units">0 units</span>
            </span>
          </span>
        </div>`;
    };

    html(
      this.root,
      `${side(PLAYER_FACTION, 'rome')}
       <div class="tb-mid">
         <div class="tb-head">
           <span class="tb-clock">00:00</span>
           <span class="tb-phase">Deployment</span>
           <span class="tb-speed">
             <button type="button" data-s="0" title="Pause (Space)">${icon(ICON.pause)}</button>
             <button type="button" data-s="1" title="Normal speed (1)">${icon(ICON.play)}</button>
             <button type="button" data-s="2" title="Double speed (2)">${icon(ICON.ffwd)}</button>
             <button type="button" data-s="4" title="Quadruple speed (3)">${icon(ICON.ffwd4)}</button>
           </span>
         </div>
         <div class="tb-bal">
           <i class="bal-r"></i>
           <i class="bal-g"></i>
           <span class="bal-mark"></span>
         </div>
         <div class="tb-foot">
           <span class="tb-note">The lines are dressing</span>
           <span class="tb-adv">Even</span>
         </div>
       </div>
       ${side(getOpposingFaction(), 'jut')}
       <div class="tb-tools"></div>`
    );

    this.toolSlot = this.root.querySelector('.tb-tools') as HTMLElement;
    this.clock = this.root.querySelector('.tb-clock') as HTMLElement;
    this.phase = this.root.querySelector('.tb-phase') as HTMLElement;
    this.note = this.root.querySelector('.tb-note') as HTMLElement;
    this.balR = this.root.querySelector('.bal-r') as HTMLElement;
    this.balG = this.root.querySelector('.bal-g') as HTMLElement;
    this.mark = this.root.querySelector('.bal-mark') as HTMLElement;
    this.advantage = this.root.querySelector('.tb-adv') as HTMLElement;

    const rome = this.root.querySelector('.tb-side.rome') as HTMLElement;
    const jut = this.root.querySelector('.tb-side.jut') as HTMLElement;
    this.menR = rome.querySelector('.tb-men') as HTMLElement;
    this.menG = jut.querySelector('.tb-men') as HTMLElement;
    this.lossR = rome.querySelector('.tb-loss') as HTMLElement;
    this.lossG = jut.querySelector('.tb-loss') as HTMLElement;
    this.unitsR = rome.querySelector('.tb-units') as HTMLElement;
    this.unitsG = jut.querySelector('.tb-units') as HTMLElement;
    this.foeSide = jut;
    this.foeName = jut.querySelector('.tb-name') as HTMLElement;
    this.foeStd = jut.querySelector('.tb-std') as HTMLElement;
    this.foeShown = getOpposingFaction();

    for (const b of Array.from(this.root.querySelectorAll('.tb-speed button')) as HTMLElement[]) {
      const s = b.dataset.s ?? '1';
      this.speedBtns.set(s, b);
      b.addEventListener('click', () => {
        // The deployment phase holds the clock, and releasing it from here would let the
        // AI re-plan over a half-finished deployment. See the note in `HudSystem.hotkeys`.
        if (this.clockHeld?.()) return;
        if (s === '0') {
          if (!ctx.time.paused) ctx.time.togglePause();
        } else {
          if (ctx.time.paused) ctx.time.togglePause();
          ctx.time.setSpeed(Number(s));
        }
      });
    }
  }

  /**
   * Installed by `HudSystem` when a phase owns the clock. Left null in play, so the speed
   * controls behave exactly as they always have on every path that has no such phase.
   */
  clockHeld: (() => boolean) | null = null;

  sync(ctx: EngineContext): void {
    const m = this.model;
    setText(this.clock, fmtClock(ctx.time.simTime));

    const p = PHASE_UI[m.phase];
    if (m.phase !== this.lastPhase) {
      this.lastPhase = m.phase;
      setText(this.phase, p.label);
      setText(this.note, p.note);
      this.root.dataset.phase = m.phase;
    }

    const foe = getOpposingFaction();
    if (foe !== this.foeShown) {
      this.foeShown = foe;
      const fui = FACTION_UI[foe];
      this.foeSide.dataset.f = fui.key;
      setText(this.foeName, fui.short);
      html(this.foeStd, icon(standardGlyph(foe), 'tb-std-ic'));
    }

    const r = m.strength[PLAYER_FACTION];
    const g = m.strength[foe];
    const total = Math.max(1, r + g);
    const rf = r / total;
    setFill(this.balR, rf);
    setFill(this.balG, 1 - rf);
    const markPct = (rf * 100).toFixed(2);
    if (this.mark.style.left !== `${markPct}%`) this.mark.style.left = `${markPct}%`;

    setText(this.menR, fmtCount(r));
    setText(this.menG, fmtCount(g));
    const lr = Math.max(0, m.initialStrength[PLAYER_FACTION] - r);
    const lg = Math.max(0, m.initialStrength[foe] - g);
    setText(this.lossR, `−${fmtCount(lr)}`);
    setText(this.lossG, `−${fmtCount(lg)}`);
    setText(this.unitsR, `${m.unitsLeft[PLAYER_FACTION]} units`);
    setText(this.unitsG, `${m.unitsLeft[foe]} units`);

    // Victory progress: how far the balance of surviving men has swung from parity.
    const swing = (rf - 0.5) * 2;
    const pct = Math.round(Math.abs(swing) * 100);
    if (pct < 4) setText(this.advantage, 'Evenly matched');
    // Named from the faction table, not from a literal: "Juthungi advantage 25%" over a
    // Carthaginian army is the same defect as the plaque heading, one line further down.
    else {
      const who = FACTION_UI[swing > 0 ? PLAYER_FACTION : foe].short;
      setText(this.advantage, `${who} advantage ${pct}%`);
    }
    setClass(this.advantage, 'good', swing > 0.04);
    setClass(this.advantage, 'bad', swing < -0.04);

    const speed = ctx.time.paused ? '0' : String(ctx.time.gameSpeed);
    for (const [k, b] of this.speedBtns) setClass(b, 'on', k === speed);
  }

  dispose(): void {
    this.root.remove();
  }
}
