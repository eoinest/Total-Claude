/**
 * Battle framing: the opening title card and the end-of-battle dispatch.
 *
 * Both are pure chrome, but they are what turns a running simulation into a battle with
 * a beginning and an end. The results screen reads the per-unit `kills` tally straight
 * off the unit groups, so the roll of honour is the sim's own bookkeeping.
 */

import type { EngineContext } from '../core/Engine';
import { Faction } from '../sim/types';
import { el, fmtClock, fmtCount, html, icon, setClass } from './dom';
import { ICON, standardGlyph } from './icons';
import type { HudModel } from './model';
import { FACTION_UI, PLAYER_FACTION } from './theme';

const FLAVOUR_VICTORY = [
  'The Juthungi host is broken. What is left of it runs north up the Via Flaminia, and Rome keeps her walls unfinished a little longer.',
  'The line held. Aurelian will hear that the city stood without him, and the masons will go back to the wall in the morning.',
];
const FLAVOUR_DEFEAT = [
  'The eagles are down on the Campus Martius. Behind the broken line there is nothing between the Juthungi and the Tiber bridges.',
  'The field belongs to the tribes. Rome will remember this day every time she looks at the height of her new walls.',
];
const FLAVOUR_DRAW = [
  'Both hosts have bled themselves white. The dead lie in windrows where the lines met, and nobody holds the ground.',
];

export class BattleFlow {
  private title!: HTMLElement;
  private results!: HTMLElement;
  private titleShownAt = -1;
  private titleGone = false;
  private resultsOpen = false;
  private offs: Array<() => void> = [];

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.title = el('div', 'title-card', parent);
    html(
      this.title,
      `<div class="tc-rule"><span class="tc-eagle">${icon(standardGlyph(Faction.Rome), 'tc-eagle-ic')}</span></div>
       <div class="tc-main">The Siege of Rome</div>
       <div class="tc-sub">271 AD &middot; Campus Martius</div>
       <div class="tc-lede">A Juthungi host stands between the city and the Via Flaminia. Rome's field army is drawn up before the unfinished Aurelian Wall.</div>
       <div class="tc-rule flip"></div>`
    );

    this.results = el('div', 'results interactive', parent);
    this.results.style.display = 'none';

    this.offs.push(
      ctx.events.on('battleStarted', () => {
        this.titleShownAt = ctx.time.elapsed;
        this.titleGone = false;
        this.title.style.display = '';
      })
    );
    this.offs.push(
      ctx.events.on('battleEnded', (e) => {
        this.model.over = true;
        this.model.victor = (e.victor as Faction) ?? -1;
        this.showResults(ctx, e.victor, e.reason);
      })
    );
  }

  /** True while the opening title card owns the frame. */
  get titleVisible(): boolean {
    return this.titleShownAt >= 0 && !this.titleGone;
  }

  /**
   * Per-frame, but does nothing at all once the title has gone.
   *
   * The fade is driven from the clock rather than by a CSS transition: the screenshot
   * harness fast-forwards simulated time without letting real time pass, and a
   * transition-based fade would still be mid-flight in every frame it grabs.
   */
  tick(ctx: EngineContext): void {
    if (this.titleGone || this.titleShownAt < 0) return;
    const age = ctx.time.elapsed - this.titleShownAt;
    const IN = 0.9;
    const LIFE = 4.2;
    const OUT = 0.8;
    let a: number;
    if (age < IN) a = age / IN;
    else if (age < LIFE) a = 1;
    else a = 1 - (age - LIFE) / OUT;
    a = Math.max(0, Math.min(1, a));
    const lift = (1 - a) * 0.7;
    this.title.style.opacity = a.toFixed(3);
    this.title.style.transform = `translateX(-50%) translateY(${(-lift).toFixed(2)}em)`;
    if (age > LIFE + OUT) {
      this.titleGone = true;
      this.title.style.display = 'none';
    }
  }

  /**
   * Fallback outcome detection.
   *
   * Nothing emits `battleEnded` yet — `checkVictory` in `sim/scenario.ts` exists but is
   * unused — so without this the results screen would never appear in normal play. The
   * rule is the same one `checkVictory` applies, and `showResults` is idempotent, so when
   * the sim does start emitting the event this simply loses the race and does nothing.
   */
  checkOutcome(ctx: EngineContext, model: HudModel): void {
    if (this.resultsOpen || ctx.time.simTime < 20) return;
    const rome = model.unitsLeft[Faction.Rome] - model.routing[Faction.Rome];
    const germ = model.unitsLeft[Faction.Germanic] - model.routing[Faction.Germanic];
    if (rome > 0 && germ > 0) return;
    const victor = rome > 0 ? Faction.Rome : germ > 0 ? Faction.Germanic : -1;
    const wiped =
      model.strength[victor === Faction.Rome ? Faction.Germanic : Faction.Rome] === 0;
    this.model.over = true;
    this.model.victor = victor;
    this.showResults(ctx, victor, wiped ? 'annihilation' : 'rout');
  }

  private showResults(ctx: EngineContext, victor: number, reason: string): void {
    if (this.resultsOpen) return;
    this.resultsOpen = true;
    const m = this.model;

    const player = victor === PLAYER_FACTION;
    const verdict = victor < 0 ? 'Stalemate' : player ? 'Victory' : 'Defeat';
    const flavour = victor < 0
      ? FLAVOUR_DRAW[0]
      : player
        ? FLAVOUR_VICTORY[Math.floor(ctx.time.simTime) % FLAVOUR_VICTORY.length]
        : FLAVOUR_DEFEAT[Math.floor(ctx.time.simTime) % FLAVOUR_DEFEAT.length];

    const reasonText: Record<string, string> = {
      annihilation: 'By annihilation — no formed body of the enemy remains',
      rout: 'By rout — the enemy has quit the field',
      timeout: 'The light has gone; both armies still stand',
      objective: 'By objective — the ground that mattered has been taken',
    };

    const column = (f: Faction): string => {
      const fui = FACTION_UI[f];
      const init = m.initialStrength[f];
      const left = m.strength[f];
      const lost = Math.max(0, init - left);
      const pct = init ? Math.round((lost / init) * 100) : 0;
      const units = m.views.filter((v) => v.faction === f);
      const destroyed = units.filter((v) => v.destroyed).length;
      return `<div class="rs-col" data-f="${fui.key}">
          <div class="rs-std">${icon(standardGlyph(f), 'rs-std-ic')}</div>
          <div class="rs-army">${fui.short}</div>
          <div class="rs-long">${fui.long}</div>
          <dl class="rs-stats">
            <div><dt>Committed</dt><dd>${fmtCount(init)}</dd></div>
            <div><dt>Surviving</dt><dd>${fmtCount(left)}</dd></div>
            <div class="loss"><dt>Fallen</dt><dd>${fmtCount(lost)} <span>(${pct}%)</span></dd></div>
            <div><dt>Units lost</dt><dd>${destroyed} of ${units.length}</dd></div>
          </dl>
        </div>`;
    };

    const honours = m.views
      .slice()
      .sort((a, b) => b.kills - a.kills)
      .slice(0, 8)
      .map((v) => {
        const fui = FACTION_UI[v.faction];
        const pct = v.initial ? Math.round((v.alive / v.initial) * 100) : 0;
        return `<tr data-f="${fui.key}">
            <td class="h-std">${icon(standardGlyph(v.faction), 'h-std-ic')}</td>
            <td class="h-name">${v.title}<span>${v.def.nativeName}</span></td>
            <td class="h-kills">${v.kills}</td>
            <td class="h-left">${v.alive}/${v.initial}<i style="width:${pct}%"></i></td>
            <td class="h-state">${v.destroyed ? 'Destroyed' : v.routing ? 'Routed' : 'Held'}</td>
          </tr>`;
      })
      .join('');

    html(
      this.results,
      `<div class="rs-panel hud-panel">
         <div class="rs-verdict ${verdict.toLowerCase()}">${verdict}</div>
         <div class="rs-reason">${reasonText[reason] ?? reason}</div>
         <div class="rs-clock">${fmtClock(ctx.time.simTime)} on the field</div>
         <div class="rs-cols">${column(Faction.Rome)}<div class="rs-vs">${icon(ICON.swords, 'rs-vs-ic')}</div>${column(Faction.Germanic)}</div>
         <div class="rs-honours">
           <div class="sec-head">Roll of honour</div>
           <table><tbody>${honours}</tbody></table>
         </div>
         <div class="rs-flavour">${flavour}</div>
         <button class="rs-close" type="button">Dismiss</button>
       </div>`
    );
    this.results.style.display = 'grid';
    // A frame's delay lets the transition run instead of snapping.
    requestAnimationFrame(() => setClass(this.results, 'open', true));
    (this.results.querySelector('.rs-close') as HTMLElement).addEventListener('click', () => {
      setClass(this.results, 'open', false);
      window.setTimeout(() => {
        this.results.style.display = 'none';
        this.resultsOpen = false;
      }, 420);
    });
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.title.remove();
    this.results.remove();
  }
}
