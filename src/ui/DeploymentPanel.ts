/**
 * The deployment plaque — the interface for the pre-battle phase.
 *
 * Discoverability was the explicit brief and it is the reason this is a banner across the
 * top of the field rather than a mode you have to know about. Three things are on screen
 * from the first frame and none of them can be missed: the phase is named, the gestures are
 * spelled out in the words the player will use them in, and the only way out of the phase is
 * a button the same size and shape as the menu's BEGIN BATTLE, in the same place a player
 * just pressed one.
 *
 * The roster palette reuses the pre-battle menu's stepper language deliberately — a row per
 * type, a count, a minus and a plus, greying at its own limit — because those limits are the
 * *same numbers* (`MAX_UNITS_PER_SIDE`, `MAX_PER_TYPE`) and a second control that looked
 * different while enforcing the same rule would read as a second rule.
 */

import type { EngineContext } from '../core/Engine';
import type { DeploymentSystem } from '../sim/deployment';
import { activeMap } from '../maps';
import { unitType } from '../units/roster';
import { el, html, setClass, setText } from './dom';
import type { HudModel } from './model';
import type { SelectionController } from './SelectionController';
import { objectiveBrief, siegeRole } from './siege';
import { UNIT_CLASS_LABEL } from './theme';

const fmt = (n: number): string => n.toLocaleString('en-GB');

export class DeploymentPanel {
  private root!: HTMLElement;
  private palette!: HTMLElement;
  private tally!: HTMLElement;
  private note!: HTMLElement;
  private removeBtn!: HTMLButtonElement;
  private beginBtn!: HTMLButtonElement;
  private rows = new Map<string, { count: HTMLElement; add: HTMLButtonElement; sub: HTMLButtonElement }>();
  private paletteOpen = false;
  private lastNote = '';
  private noteUntil = 0;

  constructor(
    private dep: DeploymentSystem,
    private model: HudModel,
    private sel: SelectionController
  ) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.root = el('div', 'deploy hud-panel interactive', parent);
    const roster = this.dep.roster();
    html(
      this.root,
      `<div class="dep-head">
         <span class="dep-eagle">
           <svg viewBox="0 0 64 64" class="dep-ic" aria-hidden="true">
             <path fill="currentColor" opacity=".85"
               d="M32 4l4 8 10-4-3 9 11 1-8 6 8 6-11 1 3 9-10-4-4 8-4-8-10 4 3-9-11-1 8-6-8-6 11-1-3-9 10 4z" />
           </svg>
         </span>
         <span class="dep-title">
           <b>DEPLOYMENT</b>
           <i class="dep-zone"></i>
         </span>
         <span class="dep-help">
           <span><em>Left-click</em> a unit, <em>right-drag</em> to stand it there &mdash; the drag
             sets the facing and the frontage</span>
           <span><em>Z X C V B</em> formation &middot; <em>Delete</em> removes${
             this.dep.zone.wall ? ' &middot; drop on the parapet to man the wall' : ''}</span>
         </span>
         <span class="dep-tally"></span>
         <button type="button" class="dep-add">ADD UNITS</button>
         <button type="button" class="dep-remove" disabled>REMOVE</button>
         <button type="button" class="dep-begin">BEGIN BATTLE</button>
       </div>
       ${this.brief()}
       <div class="dep-note"></div>
       <div class="dep-palette" hidden>
         ${roster.map((id) => {
           const d = unitType(id);
           return `<div class="dep-row" data-unit="${id}">
             <span class="dep-uname"><b>${d.name}</b><i>${UNIT_CLASS_LABEL[d.unitClass]} &middot; ${d.strength}</i></span>
             <span class="dep-step">
               <button type="button" data-d="-1" aria-label="Remove one">&minus;</button>
               <b class="dep-count">0</b>
               <button type="button" data-d="1" aria-label="Add one">+</button>
             </span>
           </div>`;
         }).join('')}
       </div>`
    );

    this.palette = this.root.querySelector('.dep-palette') as HTMLElement;
    this.tally = this.root.querySelector('.dep-tally') as HTMLElement;
    this.note = this.root.querySelector('.dep-note') as HTMLElement;
    this.removeBtn = this.root.querySelector('.dep-remove') as HTMLButtonElement;
    this.beginBtn = this.root.querySelector('.dep-begin') as HTMLButtonElement;
    setText(this.root.querySelector('.dep-zone') as HTMLElement, this.dep.zone.label);

    for (const row of Array.from(this.root.querySelectorAll('.dep-row')) as HTMLElement[]) {
      const id = row.dataset.unit as string;
      this.rows.set(id, {
        count: row.querySelector('.dep-count') as HTMLElement,
        add: row.querySelector('[data-d="1"]') as HTMLButtonElement,
        sub: row.querySelector('[data-d="-1"]') as HTMLButtonElement,
      });
      for (const b of Array.from(row.querySelectorAll('button')) as HTMLButtonElement[]) {
        const d = Number(b.dataset.d);
        b.addEventListener('click', () => {
          if (d > 0) this.addOne(id);
          else this.removeOne(id);
          this.sync(ctx);
        });
      }
    }

    (this.root.querySelector('.dep-add') as HTMLButtonElement).addEventListener('click', () => {
      this.paletteOpen = !this.paletteOpen;
      this.palette.hidden = !this.paletteOpen;
      this.sync(ctx);
    });
    this.removeBtn.addEventListener('click', () => {
      const n = this.sel.removeSelected(ctx);
      this.say(ctx, n > 0 ? `${n} unit${n > 1 ? 's' : ''} taken off the field.` : '');
      this.sync(ctx);
    });
    this.beginBtn.addEventListener('click', () => this.dep.commit());

    this.sync(ctx);
  }

  /**
   * What wins this battle, on the plaque, before a shot is fired.
   *
   * A storm is not decided by casualties and the interface never said so. Measured on
   * Carthage: a hands-off assault that put roughly 350 men on the parapet **lost** at t+286
   * having taken 41% casualties, while one cohort walked through the broken gate and won at
   * t+336 — and every order the interface encouraged was the first of those. The rule is
   * sixty men fourteen metres past the curtain, it has been enforced since the objective
   * landed, and there was nowhere on screen a player could read it.
   *
   * Only on a storm, and worded from the player's own side of the wall. The role comes from
   * the map's `CityPlan.garrison` rather than from the deployment zone's `wall` flag: the
   * flag is also true for a scenario that merely happens to have put the player's men on
   * stone, and the sentence has to be right about who is trying to get in.
   */
  private brief(): string {
    if (this.dep.scenario !== 'assault') return '';
    /*
     * Its own row, on its own class, styled inline.
     *
     * Not a third line inside `.dep-help`: those are clipped at one line each and this
     * sentence is twice their length, so it would arrive as an ellipsis. Not wrapped either
     * — the comment over `.dep-help` in `hud.css` records what free-wrapping text did to this
     * banner once already (346 px of mostly empty panel which, being `interactive`, ate every
     * right-drag aimed at the ground beneath it). One line, full plaque width, a height that
     * cannot depend on the text.
     *
     * And **not** `class="dep-note"`, which is what this was first written as and is the
     * mistake worth recording: `sync` binds the refusal line with
     * `this.root.querySelector('.dep-note')`, which takes the *first* match — so the brief
     * became the refusal element, and the first tick after attach cleared its text and
     * stripped its `on` class. It rendered for one frame and then vanished, which looked
     * exactly like markup that had never been emitted.
     *
     * `hud.css` belongs to another workstream this pass, so the six declarations are inline
     * rather than a rule; `.dep-brief` is there for the stylesheet to take over.
     */
    return '<div class="dep-brief" style="margin: 0.45em 0.2em 0.1em;'
      + ' font-family: var(--num); font-size: 0.82em; color: rgba(230, 219, 197, 0.86);'
      + ' white-space: nowrap; overflow: hidden; text-overflow: ellipsis">'
      + `${objectiveBrief(siegeRole(activeMap().city?.garrison))}</div>`;
  }

  /**
   * Add one of a type and select it, so the very next right-drag places the thing that was
   * just added. Without the selection the player has to go and find a unit they cannot see,
   * which is how an "add" button ends up feeling like it did nothing.
   */
  private addOne(typeId: string): void {
    const why = this.dep.headroom(typeId);
    if (why) {
      this.flash(why);
      return;
    }
    const id = this.dep.add(typeId);
    if (id < 0) {
      // A relayed deployment returns -1 with nothing to say: the operation has gone to the
      // relay and the unit appears when it comes back. Flashing an empty string would put an
      // empty note strip on screen for five seconds every time somebody pressed plus.
      if (this.dep.lastRefusal) this.flash(this.dep.lastRefusal);
      return;
    }
    this.pendingSelect = id;
  }

  /** Remove the most recently added unit of a type — the undo the plus button implies. */
  private removeOne(typeId: string): void {
    const own = this.dep.ownUnits().filter((u) => u.typeId === typeId);
    const last = own[own.length - 1];
    if (!last) return;
    this.dep.remove(last.id);
  }

  private pendingSelect = -1;

  private flash(text: string): void {
    this.lastNote = text;
    this.noteUntil = performance.now() + 5200;
  }

  private say(ctx: EngineContext, text: string): void {
    void ctx;
    if (text) this.flash(text);
  }

  /** 10 Hz, from `HudSystem`'s own tick. Nothing here reads layout. */
  sync(ctx: EngineContext): void {
    // A unit added by the palette can only be selected once the model has a view for it,
    // which is the next HUD tick. Held rather than forced, because forcing a refresh here
    // would run the whole model rebuild twice on the frame a button was pressed.
    if (this.pendingSelect >= 0 && this.model.view(this.pendingSelect)) {
      this.sel.selectOnly(this.pendingSelect, ctx);
      this.pendingSelect = -1;
    }
    const b = this.dep.budget();
    html(
      this.tally,
      `<span><b>${b.units}</b>/20 units</span>
       <span><b>${fmt(b.men)}</b> men</span>
       <span title="Slots the soldier pool has never handed out. Removing a unit does not give its places back — see the deployment notes.">
         <b>${fmt(b.free)}</b> free</span>`
    );

    const warn = this.dep.warning();
    const refusal = performance.now() < this.noteUntil ? this.lastNote : '';
    const text = refusal || warn;
    setText(this.note, text);
    setClass(this.note, 'on', text.length > 0);
    setClass(this.note, 'bad', refusal.length > 0);

    for (const [id, r] of this.rows) {
      const n = this.dep.countOf(id);
      setText(r.count, String(n));
      setClass(r.count, 'zero', n === 0);
      r.add.disabled = this.dep.headroom(id) !== null;
      r.sub.disabled = n === 0;
    }

    this.removeBtn.disabled = this.model.selection.length === 0;
    setText(this.removeBtn, this.model.selection.length > 1
      ? `REMOVE ${this.model.selection.length}` : 'REMOVE');
    this.beginBtn.disabled = b.units === 0;
  }

  set visible(v: boolean) {
    this.root.hidden = !v;
  }

  dispose(): void {
    this.root.remove();
  }
}
