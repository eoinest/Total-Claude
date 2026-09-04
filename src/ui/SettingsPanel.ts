/**
 * Settings popover: quality tier, time of day, HUD scale and overlay toggles, plus the
 * keyboard reference. Lives behind a single bronze stud beside the minimap so it costs
 * no screen space until it is wanted.
 */

import type { EngineContext, QualityTier } from '../core/Engine';
import { el, html, icon, setClass, setText } from './dom';
import { ICON } from './icons';
import { DEFAULT_UI_SCALE, HARNESS } from './theme';

export interface SkyLike {
  setTimeOfDay?: (h: number) => void;
  timeOfDay?: number;
}

export interface SettingsHooks {
  setQuality?: (tier: QualityTier) => void;
  onBannersChanged: (on: boolean) => void;
  onDebugChanged: (on: boolean) => void;
  onScaleChanged: (scale: number) => void;
  bannersOn: () => boolean;
  debugOn: () => boolean;
}

const TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

const KEYS: Array<[string, string]> = [
  ['LMB', 'Select unit'],
  ['LMB drag', 'Box select'],
  ['LMB ×2', 'Select all of type'],
  ['Shift / Ctrl', 'Add or remove'],
  ['RMB', 'Move · attack'],
  ['RMB drag', 'Frontage and facing'],
  ['Shift + RMB', 'Queue order'],
  // Was "Run · free the camera", and the camera half was the only half that happened: the
  // order gesture refused to start while alt was down, so the run order could never be issued.
  // Alt is the run modifier now and the camera keeps Q/E, the middle button, and the right
  // button whenever nothing is selected.
  ['Alt + RMB', 'Move at a run'],
  ['Ctrl + RMB', 'Attack move · attack men on a wall'],
  ['Q · E', 'Rotate camera'],
  ['Z X C V B', 'Formations'],
  ['G T Y', 'Abilities'],
  ['H · R', 'Halt · run toggle'],
  // The U-turn. Until this existed there was no way to set a facing without also setting a
  // destination — every facing the HUD produced rode on a move order — so a player who
  // wanted his men to turn round had to send them somewhere. See
  // `SelectionController.issueAboutFace`.
  ['U', 'About face'],
  ['F · Tab · Esc', 'Army · next · clear'],
  ['Alt (hold)', 'Show all unit names'],
  ['Space 1 2 3', 'Pause · 1× · 2× · 4×'],
  ['O · L · N', 'Settings · debug · banners'],
];

export class SettingsPanel {
  private root!: HTMLElement;
  private panel!: HTMLElement;
  private open = false;
  private todLabel!: HTMLElement;
  private tierBtns = new Map<string, HTMLElement>();

  attach(parent: HTMLElement, ctx: EngineContext, hooks: SettingsHooks): void {
    this.root = el('div', 'settings interactive', parent);
    html(
      this.root,
      `<button class="set-stud" type="button" title="Settings (O)">${icon(ICON.cog)}</button>
       <div class="set-panel hud-panel">
         <div class="set-title">Field Settings</div>

         <div class="set-row">
           <span class="set-lab">Quality</span>
           <span class="set-tiers">${TIERS.map((t) => `<button type="button" data-t="${t}">${t}</button>`).join('')}</span>
         </div>

         <div class="set-row">
           <span class="set-lab">${icon(ICON.sun, 'set-ic')} Time of day</span>
           <input class="set-tod" type="range" min="4" max="21" step="0.25" value="10" />
           <span class="set-val tod-val">10:00</span>
         </div>

         <div class="set-row">
           <span class="set-lab">HUD scale</span>
           <input class="set-scale" type="range" min="0.8" max="1.35" step="0.05" value="${DEFAULT_UI_SCALE}" />
           <span class="set-val scale-val">${Math.round(DEFAULT_UI_SCALE * 100)}%</span>
         </div>

         <div class="set-row toggles">
           <label><input type="checkbox" class="t-banners" checked /><span>Unit banners</span></label>
           <label><input type="checkbox" class="t-debug" checked /><span>Debug readout</span></label>
         </div>

         <div class="set-title sub">Commands</div>
         <div class="set-keys">
           ${KEYS.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
         </div>
       </div>`
    );

    this.panel = this.root.querySelector('.set-panel') as HTMLElement;
    this.todLabel = this.root.querySelector('.tod-val') as HTMLElement;

    (this.root.querySelector('.set-stud') as HTMLElement).addEventListener('click', () => this.toggle());

    // `EngineContext` has no `setQuality`, so switching tiers needs the engine handed in
    // via `HudOptions`. Without it the row still reports the active tier but says so.
    const canSetQuality = typeof hooks.setQuality === 'function';
    for (const b of Array.from(this.root.querySelectorAll('.set-tiers button')) as HTMLElement[]) {
      const t = (b.dataset.t ?? 'high') as QualityTier;
      this.tierBtns.set(t, b);
      setClass(b, 'on', t === ctx.quality.tier);
      if (!canSetQuality) {
        (b as HTMLButtonElement).disabled = true;
        b.title = 'Register the HUD as new HudSystem({ engine }) to switch tiers at runtime';
        continue;
      }
      b.addEventListener('click', () => {
        hooks.setQuality?.(t);
        for (const [k, other] of this.tierBtns) setClass(other, 'on', k === t);
      });
    }
    if (!canSetQuality) {
      (this.root.querySelector('.set-tiers') as HTMLElement).parentElement?.classList.add('disabled');
    }

    const sky = ctx.tryGet('sky') as unknown as SkyLike | undefined;
    const tod = this.root.querySelector('.set-tod') as HTMLInputElement;
    if (typeof sky?.timeOfDay === 'number') tod.value = String(sky.timeOfDay);
    this.setTodLabel(Number(tod.value));
    tod.addEventListener('input', () => {
      const h = Number(tod.value);
      this.setTodLabel(h);
      sky?.setTimeOfDay?.(h);
    });
    if (!sky || typeof sky.setTimeOfDay !== 'function') {
      tod.disabled = true;
      tod.parentElement?.classList.add('disabled');
    }

    const scale = this.root.querySelector('.set-scale') as HTMLInputElement;
    const scaleVal = this.root.querySelector('.scale-val') as HTMLElement;
    scale.addEventListener('input', () => {
      const s = Number(scale.value);
      setText(scaleVal, `${Math.round(s * 100)}%`);
      hooks.onScaleChanged(s);
    });

    const banners = this.root.querySelector('.t-banners') as HTMLInputElement;
    banners.checked = hooks.bannersOn();
    banners.addEventListener('change', () => hooks.onBannersChanged(banners.checked));

    const debug = this.root.querySelector('.t-debug') as HTMLInputElement;
    debug.checked = hooks.debugOn();
    debug.addEventListener('change', () => hooks.onDebugChanged(debug.checked));

    this.banners = banners;
    this.debug = debug;
  }

  private banners: HTMLInputElement | null = null;
  private debug: HTMLInputElement | null = null;

  private setTodLabel(h: number): void {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    setText(this.todLabel, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }

  toggle(): void {
    // Another overlay that must never be able to open across a measurement frame.
    if (HARNESS) return;
    this.open = !this.open;
    setClass(this.panel, 'open', this.open);
  }

  /** Keep the checkboxes honest when the shortcuts are used instead. */
  reflect(bannersOn: boolean, debugOn: boolean): void {
    if (this.banners && this.banners.checked !== bannersOn) this.banners.checked = bannersOn;
    if (this.debug && this.debug.checked !== debugOn) this.debug.checked = debugOn;
  }

  dispose(): void {
    this.root.remove();
  }
}
