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
 */

import * as THREE from 'three';
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
  last: { str: number; morale: MoraleState; selected: boolean; hovered: boolean; routing: boolean };
}

const PROJECTED: Projected = { x: 0, y: 0, distance: 0, visible: false };
const ANCHOR = new THREE.Vector3();

export class Banners {
  private layer!: HTMLElement;
  private items: BannerEls[] = [];
  private generation = -1;
  enabled = true;
  /** Dimmed while the opening title card owns the screen. */
  hushed = false;
  /**
   * Pixels at the bottom of the viewport occupied by the card bar. Banners projecting
   * into it are dropped rather than left half-buried under the panel.
   */
  bottomReserve = 0;
  /**
   * World position of the top of a unit's standard, when the VFX system is registered.
   * Hanging the plaque off the actual pole beats hanging it off a computed centroid: it
   * moves with the standard bearer and sits at the height the art already establishes.
   */
  standardOf: ((unitId: number, out: THREE.Vector3) => boolean) | null = null;

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement): void {
    this.layer = el('div', 'bnr-layer', parent);
  }

  private build(): void {
    this.layer.textContent = '';
    this.items.length = 0;
    for (const v of this.model.views) {
      const fui = FACTION_UI[v.faction];
      const root = el('div', 'bnr', this.layer);
      root.dataset.f = fui.key;
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
        last: { str: -1, morale: 'steady', selected: false, hovered: false, routing: false },
      });
    }
  }

  /** 10 Hz content refresh. */
  sync(): void {
    if (this.generation !== this.model.generation) {
      this.generation = this.model.generation;
      this.build();
    }
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
      const hov = this.model.hoveredId === v.id;
      if (hov !== L.hovered) {
        L.hovered = hov;
        setClass(b.root, 'hov', hov);
      }
      if (v.routing !== L.routing) {
        L.routing = v.routing;
        setClass(b.root, 'routing', v.routing);
      }
    }
  }

  /**
   * Per-frame projection. `showNames` comes from the Alt key.
   */
  place(ctx: EngineContext, heightAt: (x: number, z: number) => number, showNames: boolean): void {
    if (!this.enabled) {
      if (this.layer.style.display !== 'none') this.layer.style.display = 'none';
      return;
    }
    if (this.layer.style.display === 'none') this.layer.style.display = '';
    setClass(this.layer, 'names', showNames);
    setClass(this.layer, 'hushed', this.hushed);

    const w = ctx.viewW;
    const h = ctx.viewH;
    // Terrain occlusion is only trustworthy from a raised camera. Down among the men the
    // sight line grazes the ground and every hillock reads as a blocker, so the test is
    // skipped there — the distance fade already keeps close-quarters views clear.
    const testOcclusion = ctx.rig.zoom > 0.45;
    for (const b of this.items) {
      const v = b.view;
      let hide = v.destroyed;

      // Hang the plaque off the real standard when the VFX system offers one; otherwise
      // 2.4 m above the block's centre, which clears a raised standard anyway.
      let ax = v.cx;
      let ay = v.cy + 2.4;
      let az = v.cz;
      if (!hide && this.standardOf && this.standardOf(v.id, ANCHOR)) {
        ax = ANCHOR.x;
        ay = ANCHOR.y + 0.6;
        az = ANCHOR.z;
      }

      if (!hide) {
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
          }
        }
      }

      if (hide !== b.off) {
        b.off = hide;
        setClass(b.root, 'off', hide);
      }
    }
  }

  dispose(): void {
    this.layer.remove();
  }
}
