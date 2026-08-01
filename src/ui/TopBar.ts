/**
 * Top plaque: battle clock, both armies' strength as a balance that shifts as men die,
 * the current phase of the battle, and the game speed controls.
 *
 * The balance bar is the single most useful number on the screen — it is how a player
 * knows whether the line is winning before the casualty list tells them.
 */

import type { EngineContext } from '../core/Engine';
import { Faction } from '../sim/types';
import { el, fmtClock, fmtCount, html, icon, setClass, setFill, setText } from './dom';
import { ICON, standardGlyph } from './icons';
import type { HudModel } from './model';
import { FACTION_UI, PHASE_UI } from './theme';

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
      `${side(Faction.Rome, 'rome')}
       <div class="tb-mid">
         <div class="tb-head">
           <span class="tb-clock">00:00</span>
           <span class="tb-phase">Deployment</span>
           <span class="tb-speed">
             <button type="button" data-s="0" title="Pause (Space)">${icon(ICON.pause)}</button>
             <button type="button" data-s="1" title="Normal speed (1)"><b>1&times;</b></button>
             <button type="button" data-s="2" title="Double speed (2)"><b>2&times;</b></button>
             <button type="button" data-s="4" title="Quadruple speed (3)"><b>4&times;</b></button>
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
       ${side(Faction.Germanic, 'jut')}
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

    for (const b of Array.from(this.root.querySelectorAll('.tb-speed button')) as HTMLElement[]) {
      const s = b.dataset.s ?? '1';
      this.speedBtns.set(s, b);
      b.addEventListener('click', () => {
        if (s === '0') {
          if (!ctx.time.paused) ctx.time.togglePause();
        } else {
          if (ctx.time.paused) ctx.time.togglePause();
          ctx.time.setSpeed(Number(s));
        }
      });
    }
  }

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

    const r = m.strength[Faction.Rome];
    const g = m.strength[Faction.Germanic];
    const total = Math.max(1, r + g);
    const rf = r / total;
    setFill(this.balR, rf);
    setFill(this.balG, 1 - rf);
    const markPct = (rf * 100).toFixed(2);
    if (this.mark.style.left !== `${markPct}%`) this.mark.style.left = `${markPct}%`;

    setText(this.menR, fmtCount(r));
    setText(this.menG, fmtCount(g));
    const lr = Math.max(0, m.initialStrength[Faction.Rome] - r);
    const lg = Math.max(0, m.initialStrength[Faction.Germanic] - g);
    setText(this.lossR, `−${fmtCount(lr)}`);
    setText(this.lossG, `−${fmtCount(lg)}`);
    setText(this.unitsR, `${m.unitsLeft[Faction.Rome]} units`);
    setText(this.unitsG, `${m.unitsLeft[Faction.Germanic]} units`);

    // Victory progress: how far the balance of surviving men has swung from parity.
    const swing = (rf - 0.5) * 2;
    const pct = Math.round(Math.abs(swing) * 100);
    if (pct < 4) setText(this.advantage, 'Evenly matched');
    else setText(this.advantage, `${swing > 0 ? 'Roman' : 'Juthungi'} advantage ${pct}%`);
    setClass(this.advantage, 'good', swing > 0.04);
    setClass(this.advantage, 'bad', swing < -0.04);

    const speed = ctx.time.paused ? '0' : String(ctx.time.gameSpeed);
    for (const [k, b] of this.speedBtns) setClass(b, 'on', k === speed);
  }

  dispose(): void {
    this.root.remove();
  }
}
