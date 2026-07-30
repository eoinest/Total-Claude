/**
 * The command plaque above the card bar: who is selected, what condition they are in,
 * and every order available to them.
 *
 * Formation and ability buttons are driven by `UnitTypeDef.formations` / `.abilities`
 * intersected across the selection, so a mixed selection only ever offers orders every
 * unit in it can actually obey. Buttons are rebuilt when the selection signature
 * changes — never per frame.
 */

import type { EngineContext } from '../core/Engine';
import { formation } from '../sim/formations';
import { el, html, icon, setClass, setFill, setText, sizeCanvas } from './dom';
import { abilityIcon, formationGlyph, ICON } from './icons';
import type { HudModel, UnitView } from './model';
import { drawPortrait } from './portrait';
import { abilityUI, FACTION_UI, MORALE_UI, ORDER_LABEL, UNIT_CLASS_LABEL } from './theme';
import type { SelectionController } from './SelectionController';

const FORM_KEYS = ['Z', 'X', 'C', 'V', 'B'];
const ABIL_KEYS = ['G', 'T', 'Y'];

export class CommandPanel {
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private nameEl!: HTMLElement;
  private nativeEl!: HTMLElement;
  private stateEl!: HTMLElement;
  private moraleEl!: HTMLElement;
  private countBadge!: HTMLElement;
  private statMen!: HTMLElement;
  private statMor!: HTMLElement;
  private statFat!: HTMLElement;
  private statKills!: HTMLElement;
  private statFront!: HTMLElement;
  private barMen!: HTMLElement;
  private barMor!: HTMLElement;
  private barFat!: HTMLElement;
  private formRow!: HTMLElement;
  private abilRow!: HTMLElement;
  private runBtn!: HTMLElement;

  private signature = '';
  private portraitFor = '';
  private formButtons = new Map<string, HTMLElement>();
  private abilButtons = new Map<string, HTMLElement>();
  private shown = false;

  constructor(
    private model: HudModel,
    private controller: SelectionController
  ) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.root = el('div', 'cmd hud-panel interactive', parent);
    html(
      this.root,
      `<div class="cmd-id">
         <div class="cmd-por"><canvas></canvas><span class="cmd-badge"></span></div>
         <div class="cmd-txt">
           <div class="cmd-name">—</div>
           <div class="cmd-native"></div>
           <div class="cmd-state"><span class="cmd-order">Holding</span><span class="cmd-sep">·</span><span class="cmd-mor">Steady</span></div>
           <div class="cmd-grid">
             <div class="cg-row"><em>Strength</em><span class="cbar men"><i></i></span><b class="s-men">0</b></div>
             <div class="cg-row"><em>Morale</em><span class="cbar mor"><i></i></span><b class="s-mor">0</b></div>
             <div class="cg-row"><em>Fatigue</em><span class="cbar fat"><i></i></span><b class="s-fat">0</b></div>
           </div>
           <div class="cmd-nums">
             <span>Kills <b class="s-kills">0</b></span>
             <span>Frontage <b class="s-front">0 m</b></span>
           </div>
         </div>
       </div>
       <div class="cmd-sec">
         <div class="sec-head">Formation</div>
         <div class="btnrow forms"></div>
       </div>
       <div class="cmd-sec">
         <div class="sec-head">Abilities</div>
         <div class="btnrow abils"></div>
       </div>
       <div class="cmd-sec last">
         <div class="sec-head">Orders</div>
         <div class="btnrow ords">
           <button class="ob halt" type="button" title="Halt where you stand (H)">${icon(ICON.halt)}<span class="kc">H</span></button>
           <button class="ob run" type="button" title="March or run to new orders (R)">${icon(ICON.run)}<span class="kc">R</span></button>
         </div>
       </div>`
    );

    this.canvas = this.root.querySelector('.cmd-por canvas') as HTMLCanvasElement;
    this.nameEl = this.root.querySelector('.cmd-name') as HTMLElement;
    this.nativeEl = this.root.querySelector('.cmd-native') as HTMLElement;
    this.stateEl = this.root.querySelector('.cmd-order') as HTMLElement;
    this.moraleEl = this.root.querySelector('.cmd-mor') as HTMLElement;
    this.countBadge = this.root.querySelector('.cmd-badge') as HTMLElement;
    this.statMen = this.root.querySelector('.s-men') as HTMLElement;
    this.statMor = this.root.querySelector('.s-mor') as HTMLElement;
    this.statFat = this.root.querySelector('.s-fat') as HTMLElement;
    this.statKills = this.root.querySelector('.s-kills') as HTMLElement;
    this.statFront = this.root.querySelector('.s-front') as HTMLElement;
    this.barMen = this.root.querySelector('.cbar.men > i') as HTMLElement;
    this.barMor = this.root.querySelector('.cbar.mor > i') as HTMLElement;
    this.barFat = this.root.querySelector('.cbar.fat > i') as HTMLElement;
    this.formRow = this.root.querySelector('.btnrow.forms') as HTMLElement;
    this.abilRow = this.root.querySelector('.btnrow.abils') as HTMLElement;
    this.runBtn = this.root.querySelector('.ob.run') as HTMLElement;

    (this.root.querySelector('.ob.halt') as HTMLElement).addEventListener('click', () =>
      this.controller.issueHalt(ctx)
    );
    this.runBtn.addEventListener('click', () => {
      this.controller.runByDefault = !this.controller.runByDefault;
      setClass(this.runBtn, 'on', this.controller.runByDefault);
    });
  }

  private buildButtons(sel: UnitView[], ctx: EngineContext): void {
    const forms = this.controller.commonFormations(sel);
    const abils = this.controller.commonAbilities(sel);

    this.formRow.textContent = '';
    this.formButtons.clear();
    forms.forEach((id, i) => {
      const fd = formation(id);
      const b = el('button', 'ob fb', this.formRow);
      b.type = 'button';
      b.title = `${fd.name} — ${fd.description}`;
      html(b, `${icon(formationGlyph(id), 'fb-ic')}<span class="kc">${FORM_KEYS[i] ?? ''}</span><span class="ob-lab">${fd.name}</span>`);
      b.addEventListener('click', () => this.controller.issueFormation(id, ctx));
      this.formButtons.set(id, b);
    });

    this.abilRow.textContent = '';
    this.abilButtons.clear();
    abils.forEach((id, i) => {
      const au = abilityUI(id);
      const b = el('button', 'ob ab', this.abilRow);
      b.type = 'button';
      b.title = `${au.name} — ${au.desc}`;
      html(b, `${icon(abilityIcon(id), 'ab-ic')}<span class="kc">${ABIL_KEYS[i] ?? ''}</span><span class="ob-lab">${au.name}</span>`);
      b.addEventListener('click', () => this.controller.issueAbility(id, ctx));
      this.abilButtons.set(id, b);
    });
    setClass(this.abilRow.parentElement as HTMLElement, 'empty', abils.length === 0);
  }

  sync(ctx: EngineContext): void {
    const sel = this.model.selectedViews;
    const show = sel.length > 0;
    if (show !== this.shown) {
      this.shown = show;
      setClass(this.root, 'open', show);
    }
    if (!show) {
      this.signature = '';
      return;
    }

    const sig = sel.map((v) => v.def.id).join('|') + `#${sel.length}`;
    if (sig !== this.signature) {
      this.signature = sig;
      this.buildButtons(sel, ctx);
    }

    const lead = sel[0];
    const multi = sel.length > 1;
    const fui = FACTION_UI[lead.faction];
    this.root.dataset.f = fui.key;

    if (this.portraitFor !== lead.def.id) {
      this.portraitFor = lead.def.id;
      const r = this.canvas.getBoundingClientRect();
      if (r.width > 2) {
        const dpr = sizeCanvas(this.canvas, r.width, r.height);
        const g = this.canvas.getContext('2d');
        if (g) {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawPortrait(g, r.width, r.height, lead.def);
        }
      }
    }

    let men = 0;
    let initial = 0;
    let kills = 0;
    let frontage = 0;
    let morale = 0;
    let fatigue = 0;
    for (const v of sel) {
      men += v.alive;
      initial += v.initial;
      kills += v.kills;
      frontage += v.frontage;
      morale += v.moraleFrac;
      fatigue += v.fatigue;
    }
    morale /= sel.length;
    fatigue /= sel.length;

    setText(this.nameEl, multi ? `${sel.length} Units Selected` : lead.title);
    setText(this.nativeEl, multi ? sel.map((v) => v.def.name).filter((n, i, a) => a.indexOf(n) === i).join(' · ') : lead.def.nativeName);
    setText(this.stateEl, multi ? UNIT_CLASS_LABEL[lead.def.unitClass] : ORDER_LABEL[lead.order]);
    const worst = sel.reduce((a, v) => (v.moraleFrac < a.moraleFrac ? v : a), sel[0]);
    const mu = MORALE_UI[worst.morale];
    setText(this.moraleEl, mu.label);
    this.moraleEl.style.color = mu.colour;

    setText(this.countBadge, multi ? `×${sel.length}` : '');
    setClass(this.countBadge, 'on', multi);

    setText(this.statMen, `${men} / ${initial}`);
    setText(this.statMor, `${Math.round(morale * 100)}%`);
    setText(this.statFat, `${Math.round(fatigue * 100)}%`);
    setText(this.statKills, String(kills));
    setText(this.statFront, `${Math.round(frontage)} m`);
    setFill(this.barMen, initial ? men / initial : 0);
    setFill(this.barMor, morale);
    setFill(this.barFat, fatigue);
    setClass(this.barFat.parentElement as HTMLElement, 'hot', fatigue > 0.66);

    // Current formation and live cooldowns.
    const cur = sel.every((v) => v.unit.formationId === lead.unit.formationId) ? lead.unit.formationId : '';
    for (const [id, b] of this.formButtons) setClass(b, 'cur', id === cur);

    const now = ctx.time.simTime;
    for (const [id, b] of this.abilButtons) {
      let frac = 0;
      for (const v of sel) {
        if (!v.def.abilities.includes(id)) continue;
        frac = Math.max(frac, this.controller.cooldownFrac(v.id, id, now));
      }
      const q = frac.toFixed(2);
      if (b.style.getPropertyValue('--cd') !== q) b.style.setProperty('--cd', q);
      setClass(b, 'cooling', frac > 0);
    }

    setClass(this.runBtn, 'on', this.controller.runByDefault);
  }

  dispose(): void {
    this.root.remove();
  }
}
