/**
 * Unit banners: the thing that lets a player read a Total War battlefield at a glance.
 *
 * One small plaque per unit, projected from the centre of its block and floated above
 * the men — faction standard, unit-class device, a strength bar and a morale strip,
 * with the unit's name appearing on hover, selection or while Alt is held.
 *
 * Projection is DOM rather than sprites so the type stays vector-crisp at any zoom.
 * Only a `transform` is written per frame, which the compositor absorbs; content is
 * refreshed at 10 Hz alongside the rest of the HUD.
 *
 * Banners fade out as the camera comes down among the troops — at charge distance the
 * player wants the battle, not the interface — and dim again at extreme range.
 *
 * They are also hit targets: the banner is the thing a player aims at to pick a unit
 * out of a melee, so `unitAt` publishes each plaque's screen box and
 * `SelectionController` tests it before it tests the ground footprint. That test is done
 * here in screen space rather than with `pointer-events: auto`, because the engine's
 * `Input` listens on the canvas: a DOM element that swallows the pointer also swallows
 * the wheel and the right button, which would kill zoom and camera rotation over every
 * one of the three dozen plaques on screen.
 */

import type { EngineContext } from '../core/Engine';
import { el, html, icon, setClass, setFill } from './dom';
import { standardGlyph, UNIT_CLASS_ICON } from './icons';
import type { HudModel, UnitView } from './model';
import { projectPoint, terrainOccludes, type Projected } from './picking';
import { FACTION_UI, MORALE_UI, type MoraleState } from './theme';

interface BannerEls {
  view: UnitView;
  root: HTMLElement;
  strFill: HTMLElement;
  morStrip: HTMLElement;
  name: HTMLElement;
  transform: string;
  off: boolean;
  /** Screen box in CSS pixels, meaningful only while `hit` is true. */
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
  hit: boolean;
  /** Camera distance, so overlapping plaques resolve to the nearest unit. */
  dist: number;
  last: { str: number; morale: MoraleState; selected: boolean; hovered: boolean; routing: boolean };
}

const PROJECTED: Projected = { x: 0, y: 0, distance: 0, visible: false };

/**
 * A man is 1.75 m and the standard he carries tops out at ~3.4 m (a 3.1 m staff plus
 * its finial), so this clears both: the plaque's spike starts just above the tallest
 * thing in the block and the men are never behind it.
 */
const CLEAR_M = 3.6;
/** Riders sit ~1.1 m higher, and so do their standards. */
const MOUNTED_LIFT_M = 1.15;
/** Pixels of slack around a plaque's box, so a 25 px target is not a pixel hunt. */
const HIT_PAD_PX = 3;
/** Below this opacity a plaque is fading out of a close-up and stops being clickable. */
const HIT_MIN_ALPHA = 0.25;

export class Banners {
  private layer!: HTMLElement;
  private items: BannerEls[] = [];
  private generation = -1;
  /** Unscaled layout box of one plaque, measured out of the frame loop. */
  private baseW = 25;
  private baseH = 43;
  private needMeasure = true;
  enabled = true;
  /** Dimmed while the opening title card owns the screen. */
  hushed = false;
  /**
   * Pixels at the bottom of the viewport occupied by the card bar. Banners projecting
   * into it are dropped rather than left half-buried under the panel.
   */
  bottomReserve = 0;

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement): void {
    this.layer = el('div', 'bnr-layer', parent);
  }

  /** Re-read the plaque box. Called on resize and on a UI-scale change, never per frame. */
  remeasure(): void {
    this.needMeasure = true;
  }

  private build(): void {
    this.layer.textContent = '';
    this.items.length = 0;
    for (const v of this.model.views) {
      const fui = FACTION_UI[v.faction];
      const root = el('div', 'bnr', this.layer);
      root.dataset.f = fui.key;
      root.dataset.unit = String(v.id);
      html(
        root,
        `<span class="bnr-plate">
           <span class="bnr-std">${icon(standardGlyph(v.faction), 'bnr-std-ic')}</span>
           <span class="bnr-ic">${icon(UNIT_CLASS_ICON[v.def.unitClass], 'bnr-cls')}</span>
         </span>
         <span class="bnr-bar"><i></i></span>
         <span class="bnr-mor"></span>
         <span class="bnr-pole"></span>
         <span class="bnr-name">${v.title}</span>`
      );
      this.items.push({
        view: v,
        root,
        strFill: root.querySelector('.bnr-bar > i') as HTMLElement,
        morStrip: root.querySelector('.bnr-mor') as HTMLElement,
        name: root.querySelector('.bnr-name') as HTMLElement,
        transform: '',
        off: false,
        hx0: 0, hy0: 0, hx1: 0, hy1: 0,
        hit: false,
        dist: 0,
        last: { str: -1, morale: 'steady', selected: false, hovered: false, routing: false },
      });
    }
    this.needMeasure = true;
  }

  /**
   * One layout read, on build or after a resize. The hit box has to be derived from the
   * real box because `--ui-scale` is a player setting, and reading it per frame would
   * put a forced reflow in the render path.
   */
  private measure(): void {
    this.needMeasure = false;
    const first = this.items[0];
    if (!first) return;
    const w = first.root.offsetWidth;
    const h = first.root.offsetHeight;
    if (w > 0) this.baseW = w;
    if (h > 0) this.baseH = h;
  }

  /** 10 Hz content refresh. */
  sync(): void {
    if (this.generation !== this.model.generation) {
      this.generation = this.model.generation;
      this.build();
    }
    if (this.needMeasure) this.measure();
    for (const b of this.items) {
      const v = b.view;
      const L = b.last;
      if (Math.abs(v.strengthFrac - L.str) > 0.004) {
        L.str = v.strengthFrac;
        setFill(b.strFill, v.strengthFrac);
      }
      if (v.morale !== L.morale) {
        L.morale = v.morale;
        b.morStrip.style.background = MORALE_UI[v.morale].colour;
        setClass(b.root, 'wobble', v.morale === 'wavering' || v.morale === 'breaking');
      }
      const sel = this.model.isSelected(v.id);
      if (sel !== L.selected) {
        L.selected = sel;
        setClass(b.root, 'sel', sel);
      }
      if (v.routing !== L.routing) {
        L.routing = v.routing;
        setClass(b.root, 'routing', v.routing);
      }
    }
  }

  /**
   * Unit whose plaque covers this point, or -1. Nearest to the camera wins where two
   * overlap, which is the one drawn on top of the pile.
   */
  unitAt(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    for (const b of this.items) {
      if (!b.hit) continue;
      if (x < b.hx0 || x > b.hx1 || y < b.hy0 || y > b.hy1) continue;
      if (b.dist < bestD) {
        bestD = b.dist;
        best = b.view.id;
      }
    }
    return best;
  }

  /**
   * Per-frame projection. `showNames` comes from the Alt key.
   *
   * Called from `preRender`, after `Engine.frame` has finalised the camera and called
   * `updateMatrixWorld` — projecting in `update` leaves every plaque one frame stale,
   * which reads as the whole HUD sliding behind the world while the camera pans.
   */
  place(ctx: EngineContext, heightAt: (x: number, z: number) => number, showNames: boolean): void {
    if (!this.enabled) {
      if (this.layer.style.display !== 'none') this.layer.style.display = 'none';
      for (const b of this.items) b.hit = false;
      return;
    }
    if (this.layer.style.display === 'none') this.layer.style.display = '';
    setClass(this.layer, 'names', showNames);
    setClass(this.layer, 'hushed', this.hushed);

    // CSS pixels, not drawing-buffer pixels: `.bnr-layer` is laid out in CSS pixels and
    // the renderer's backing store is up to 2x that under `quality.maxPixelRatio`.
    const w = ctx.viewW;
    const h = ctx.viewH;
    const hovered = this.model.hoveredId;
    // Terrain occlusion is only trustworthy from a raised camera. Down among the men the
    // sight line grazes the ground and every hillock reads as a blocker, so the test is
    // skipped there — the distance fade already keeps close-quarters views clear.
    const testOcclusion = ctx.rig.zoom > 0.45;
    for (const b of this.items) {
      const v = b.view;
      b.hit = false;
      let hide = v.destroyed;

      // The anchor is the centroid of the unit's own mass, at the height of the top of the
      // standard it carries, above the highest ground any of its men stands on.
      //
      // The formation anchor is read from `unit` rather than from the 10 Hz view digest so
      // the plaque tracks a charging cohort at the sim's own 30 Hz instead of stepping
      // after it; `massDx/massDz` corrects the plan to where the men actually are.
      const u = v.unit;
      const sf = Math.sin(u.facing);
      const cf = Math.cos(u.facing);
      // `u.x/u.z` is the midpoint of the front rank; the ranks extend backwards.
      const ax = u.x - sf * v.depth * 0.5 + v.massDx;
      const az = u.z - cf * v.depth * 0.5 + v.massDz;
      let ay = 0;
      if (!hide) {
        // The ground under the centroid, floored by the highest man's feet: the map rises
        // 25-40 m across the battlefield, so a cohort drawn up across a slope has its
        // tallest man metres above its own centre and a single sample would bury the
        // plaque in the uphill ranks.
        let g = heightAt(ax, az);
        if (v.massTopY > g) g = v.massTopY;
        const mounted = v.def.unitClass === 'heavy-cavalry' || v.def.unitClass === 'light-cavalry';
        ay = g + CLEAR_M + (mounted ? MOUNTED_LIFT_M : 0);

        projectPoint(ctx.camera, ax, ay, az, w, h, PROJECTED);
        hide =
          !PROJECTED.visible ||
          PROJECTED.x < -80 || PROJECTED.x > w + 80 ||
          PROJECTED.y < -60 || PROJECTED.y > h - this.bottomReserve;
      }

      if (!hide) {
        const d = PROJECTED.distance;
        // Nothing inside 28 m: down at eye level the player wants men, not markers, and
        // a plaque sitting on the contact line is the worst thing the HUD can do.
        const near = Math.min(1, Math.max(0, (d - 28) / 42));
        const far = 1 - Math.min(0.62, Math.max(0, (d - 900) / 900));
        const alpha = near * far;
        if (alpha < 0.02) hide = true;
        else {
          // Slack grows fast with range. At a grazing angle the eight-sample line
          // clips every hillock between here and there, and a battlefield where the
          // banners vanish whenever the camera drops is worse than one where a banner
          // occasionally shows through a rise.
          if (testOcclusion && terrainOccludes(ctx.camera, ax, ay, az, heightAt, 4 + d * 0.06)) {
            hide = true;
          } else {
            // Near-constant screen size, easing down at long range so a distant wing
            // reads as distant, and growing in with the fade so the last thing to leave
            // a close-up is a small mark rather than a full-size icon.
            const s = Math.max(0.62, Math.min(1.12, 1.12 - d / 2400)) * (0.6 + 0.4 * near);
            const t = `translate3d(${PROJECTED.x.toFixed(1)}px, ${PROJECTED.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
            if (t !== b.transform) {
              b.transform = t;
              b.root.style.transform = t;
            }
            const a = alpha.toFixed(2);
            if (b.root.style.opacity !== a) b.root.style.opacity = a;

            // `transform-origin` is the box's bottom centre and the two translates put
            // that point on the anchor, so the scaled box is symmetric about it. No
            // layout read: the unscaled box was measured once.
            if (alpha >= HIT_MIN_ALPHA) {
              const bw = this.baseW * s * 0.5 + HIT_PAD_PX;
              const bh = this.baseH * s + HIT_PAD_PX;
              b.hx0 = PROJECTED.x - bw;
              b.hx1 = PROJECTED.x + bw;
              b.hy0 = PROJECTED.y - bh;
              b.hy1 = PROJECTED.y + HIT_PAD_PX;
              b.dist = d;
              b.hit = true;
            }
          }
        }
      }

      if (hide !== b.off) {
        b.off = hide;
        setClass(b.root, 'off', hide);
      }
      // Hover is applied here rather than in the 10 Hz tick: a highlight that answers
      // up to 100 ms after the cursor arrives feels broken, and a class toggle costs
      // nothing when it only fires on a change.
      const hov = !hide && hovered === v.id;
      if (hov !== b.last.hovered) {
        b.last.hovered = hov;
        setClass(b.root, 'hov', hov);
      }
    }
  }

  dispose(): void {
    this.layer.remove();
  }
}
