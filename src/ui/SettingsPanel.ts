/**
 * Settings popover: quality tier, time of day, HUD scale and overlay toggles, plus the
 * control reference. Lives behind a single bronze stud beside the minimap so it costs
 * no screen space until it is wanted.
 */

import type { EngineContext, QualityTier } from '../core/Engine';
import { el, html, icon, setClass, setText } from './dom';
import { ICON } from './icons';
import { DEFAULT_UI_SCALE, HARNESS } from './theme';

interface SkyLike {
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

/** Mouse first: the keys are accelerators for the same jobs, not the primary binding. */
const CONTROLS: Array<[string, string]> = [
  ['Left click', 'Select · bare ground clears'],
  ['Left drag', 'Turn the view, from bare ground or sky'],
  ['Shift + left drag', 'Box select · ctrl too adds to it'],
  ['Left ×2', 'Select all of that type'],
  ['Right click', 'Move here, or attack an enemy'],
  ['Right drag', 'Frontage and facing'],
  ['Middle drag', 'Turn the view, anywhere'],
  ['Wheel', 'Zoom'],
  ['Screen edge', 'Pan'],
  ['Compass', 'Drag to turn · click for north'],
  ['Minimap', 'Click or drag to move the camera'],
  ['Army standard', 'Select the whole army'],
  ['Shift / Ctrl + click', 'Add to or drop from the selection'],
  ['Shift + right', 'Queue behind the current order'],
  ['Alt + right', 'Run instead of march'],
  ['Ctrl + right', 'Attack move'],
  ['Keys · camera', 'WASD or arrows pan · Q E turn'],
  ['Keys · orders', 'Z X C V B formations · G T Y abilities · H halt · R run'],
  ['Keys · other', 'Space 1 2 3 speed · F army · Tab next · Esc clear'],
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

         <div class="set-title sub">Controls</div>
         <div class="set-keys">
           ${CONTROLS.map(([k, d]) =>
             `<div class="${k.startsWith('Keys') ? 'wide' : ''}"><kbd>${k}</kbd><span>${d}</span></div>`
           ).join('')}
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
