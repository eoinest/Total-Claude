/**
 * The HUD subsystem.
 *
 * Owns every piece of interface: unit cards, the command plaque, world-space banners and
 * ground markers, the minimap, the top plaque, the event feed, the battle framing and
 * the settings popover. It also owns selection and order issuing, which is why it reads
 * raw input directly rather than being handed events.
 *
 * Timing discipline, because a HUD is the easiest place in a game to lose a millisecond:
 *   - text, bars, cards, minimap and feed refresh on a 10 Hz tick
 *   - only banner transforms and the world-overlay geometry run per frame
 *   - nothing reads layout in a frame path (`getBoundingClientRect` is confined to
 *     construction, resize and tooltip placement)
 *   - the tick runs off unscaled wall-clock time so the HUD stays alive while paused
 */

import type * as THREE from 'three';
import type { EngineContext, QualityTier, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import { Banners } from './Banners';
import { BattleFlow } from './BattleFlow';
import { CommandPanel } from './CommandPanel';
import { el, setText } from './dom';
import { EventFeed } from './EventFeed';
import { HudModel } from './model';
import { Minimap } from './Minimap';
import { PointerTracker } from './pointer';
import { SelectionController } from './SelectionController';
import { SettingsPanel } from './SettingsPanel';
import { Tooltip } from './Tooltip';
import { TopBar } from './TopBar';
import { UnitCards } from './UnitCards';
import { WorldOverlay } from './WorldOverlay';

interface TerrainLike {
  heightAt(x: number, z: number): number;
  readonly heightField: { data: Float32Array; res: number; spacing: number; halfExtent: number };
}

export interface HudOptions {
  /**
   * The engine, so the settings panel can switch quality tiers. `EngineContext` does
   * not expose `setQuality`, and the HUD is the only place a player can reach it.
   */
  engine?: { setQuality(tier: QualityTier): void };
}

/** 10 Hz. Fast enough that a dying unit's card feels live, slow enough to be free. */
const TICK = 0.1;

export class HudSystem implements Subsystem {
  readonly name = 'hud';
  readonly order = 700;

  private root!: HTMLElement;
  private model = new HudModel();
  private ptr!: PointerTracker;
  private overlay!: WorldOverlay;
  private controller!: SelectionController;
  private cards!: UnitCards;
  private command!: CommandPanel;
  private banners!: Banners;
  private minimap!: Minimap;
  private topbar!: TopBar;
  private feed!: EventFeed;
  private flow!: BattleFlow;
  private settings!: SettingsPanel;
  private tooltip!: Tooltip;
  private perfLine!: HTMLElement;

  private bottomPanel!: HTMLElement;
  private battle?: BattleSystem;
  private heightAt: (x: number, z: number) => number = () => 0;
  private tickAcc = TICK;
  private debugOn = true;
  private relayoutIn = 0;

  /** Smoothed main-thread cost of the HUD, in milliseconds. */
  hudMs = 0;

  /**
   * Frame times measured here rather than read from `time.fps`. That mean is poisoned
   * for a full second by any single long frame — a load hitch, or the harness settling
   * its clock — and a wrong number in the corner of a screenshot misleads review. A
   * median over a short ring buffer ignores outliers entirely.
   */
  private frameRing = new Float32Array(48);
  private frameRingAt = 0;
  private frameRingN = 0;
  private lastFrameAt = -1;
  private readonly ringSort = new Float32Array(48);

  constructor(private opts: HudOptions = {}) {}

  init(ctx: EngineContext): void {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('[hud] #hud-root is missing from the document');
    this.root = el('div', 'hud', host);

    const terrain = ctx.tryGet('terrain') as unknown as TerrainLike | undefined;
    if (terrain && typeof terrain.heightAt === 'function') {
      this.heightAt = (x, z) => terrain.heightAt(x, z);
    }

    this.battle = ctx.tryGet<BattleSystem>('battle');
    this.ptr = new PointerTracker(ctx.renderer.domElement);
    this.overlay = new WorldOverlay(this.heightAt);
    this.overlay.init(ctx.scene);

    this.controller = new SelectionController(this.model, this.overlay, this.ptr);
    this.tooltip = new Tooltip(this.root);
    this.cards = new UnitCards(this.model, this.controller, this.tooltip);
    this.command = new CommandPanel(this.model, this.controller);
    this.banners = new Banners(this.model);
    this.minimap = new Minimap(this.model);
    this.topbar = new TopBar(this.model);
    this.feed = new EventFeed(this.model);
    this.flow = new BattleFlow(this.model);
    this.settings = new SettingsPanel();

    // Banners sit behind the panels but in front of the canvas.
    this.banners.attach(this.root);
    this.controller.attach(this.root);
    this.topbar.attach(this.root, ctx);
    this.feed.attach(this.root, ctx);
    // The command plaque is anchored to the top edge of the card bar rather than to a
    // fixed offset, so the bar can wrap to a second row at large HUD scales without the
    // two panels colliding.
    const bottom = el('div', 'hud-bottom', this.root);
    this.bottomPanel = bottom;
    this.command.attach(bottom, ctx);
    this.cards.attach(bottom);
    this.minimap.attach(this.root, ctx);
    this.settings.attach(this.topbar.toolSlot, ctx, {
      setQuality: this.opts.engine ? (t) => this.opts.engine!.setQuality(t) : undefined,
      onBannersChanged: (on) => {
        this.banners.enabled = on;
      },
      onDebugChanged: (on) => this.setDebug(on),
      onScaleChanged: (s) => {
        this.root.style.setProperty('--ui-scale', String(s));
        // Canvases are sized in CSS pixels, so a scale change needs a repaint.
        this.relayoutIn = 2;
      },
      bannersOn: () => this.banners.enabled,
      debugOn: () => this.debugOn,
    });
    this.flow.attach(this.root, ctx);
    this.controller.attachEvents(ctx);

    // Optional integrations: both are duck-typed so the HUD still works on its own.
    const morale = ctx.tryGet('morale') as unknown as
      { moraleTerms?: (id: number) => Record<string, number> } | undefined;
    if (morale && typeof morale.moraleTerms === 'function') {
      this.tooltip.moraleProbe = (id) => {
        try {
          return morale.moraleTerms!(id);
        } catch {
          return null;
        }
      };
    }
    const vfx = ctx.tryGet('vfx') as unknown as
      { standardOf?: (id: number, out: THREE.Vector3) => boolean } | undefined;
    if (vfx && typeof vfx.standardOf === 'function') {
      this.banners.standardOf = (id, out) => vfx.standardOf!(id, out);
    }


    this.perfLine = el('div', 'hud-perf', this.root);
    setText(this.perfLine, 'hud —');

    if (terrain?.heightField) this.minimap.buildRelief(terrain.heightField);

    this.cards.relayout();
    this.minimap.relayout();
  }

  /**
   * Frame diagnostics. This used to live in `main.ts`; the HUD owns it now because it is
   * the only system that already has a toggle, a place to put it and the HUD's own cost.
   * Everything comes off `EngineContext`, so no engine reference is needed.
   */
  /** Median frame time in ms over the ring buffer, or 0 until it fills a little. */
  private medianFrameMs(): number {
    const n = this.frameRingN;
    if (n < 4) return 0;
    const a = this.ringSort.subarray(0, n);
    a.set(this.frameRing.subarray(0, n));
    a.sort();
    return a[n >> 1];
  }

  private writeDebug(ctx: EngineContext): void {
    const t = ctx.time;
    const info = ctx.renderer.info;
    let men = 0;
    let units = 0;
    for (const v of this.model.views) {
      if (v.destroyed) continue;
      units++;
      men += v.alive;
    }
    const med = this.medianFrameMs();
    // Below ~1.6 ms per frame we are not in a display-driven loop at all — the
    // screenshot harness pumps `engine.frame()` back to back — so a frame *rate* would
    // be a fiction. The interval is always honest, so that is what leads.
    const fps = med >= 1.6 ? Math.round(1000 / med).toString().padStart(4) : '   —';
    setText(
      this.perfLine,
      `${med.toFixed(1)} ms/f  ${fps} fps   hud ${this.hudMs.toFixed(2)} ms\n` +
        `draws ${info.render.calls}   tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
        `men ${men}   units ${units}   sel ${this.model.selection.length}\n` +
        `${t.paused ? 'PAUSED' : `${t.gameSpeed}x`}   t+${t.simTime.toFixed(0)}s`
    );
  }

  private setDebug(on: boolean): void {
    this.debugOn = on;
    const perf = document.getElementById('perf');
    if (perf) perf.style.display = on ? '' : 'none';
    this.perfLine.style.display = on ? '' : 'none';
  }

  update(dt: number, ctx: EngineContext): void {
    void dt;
    if (!this.battle) return;
    const t0 = performance.now();
    // Wall-clock, not scaled: the HUD must keep working while the battle is paused.
    const wall = ctx.time.frameDt;

    if (this.lastFrameAt >= 0) {
      const dt = t0 - this.lastFrameAt;
      // Anything over a third of a second is a hitch, not a frame rate.
      if (dt > 0.05 && dt < 333) {
        this.frameRing[this.frameRingAt] = dt;
        this.frameRingAt = (this.frameRingAt + 1) % this.frameRing.length;
        if (this.frameRingN < this.frameRing.length) this.frameRingN++;
      }
    }
    this.lastFrameAt = t0;

    this.hotkeys(ctx);

    this.tickAcc += wall;
    if (this.tickAcc >= TICK) {
      this.tickAcc = 0;
      this.model.refresh(this.battle, ctx.time.simTime);
      if (this.model.pruneSelection()) {
        ctx.events.emit('selectionChanged', { unitIds: this.model.selection.slice() });
      }
      this.cards.sync(ctx);
      this.command.sync(ctx);
      this.banners.sync();
      this.topbar.sync(ctx);
      this.minimap.draw(ctx);
      this.feed.observe(ctx.time.elapsed);
      this.feed.sync(ctx.time.elapsed);
      this.flow.checkOutcome(ctx, this.model);
      this.settings.reflect(this.banners.enabled, this.debugOn);
      // One layout read per tick, so world banners never end up buried under the bar.
      this.banners.bottomReserve = Math.max(0, ctx.viewH - this.bottomPanel.offsetTop + 6);
      if (this.debugOn) this.writeDebug(ctx);
    }

    if (this.relayoutIn > 0 && --this.relayoutIn === 0) {
      this.cards.relayout();
      this.minimap.relayout();
    }

    this.cards.tick(wall, ctx);
    this.flow.tick(ctx);
    this.banners.hushed = this.flow.titleVisible;

    // World overlay: rebuilt every frame so the order ghost tracks the cursor exactly.
    this.overlay.metresPerPixel = ctx.rig.metresPerPixel(ctx.viewH);
    this.overlay.begin();
    this.controller.update(ctx, this.heightAt);
    const hovered = this.model.hoveredId;
    for (const v of this.model.selectedViews) this.overlay.selectionMarker(v);
    if (hovered >= 0 && !this.model.isSelected(hovered)) {
      const hv = this.model.view(hovered);
      if (hv && !hv.destroyed) this.overlay.hoverMarker(hv, !hv.own);
    }
    this.controller.drawOrderPaths();
    this.overlay.end();

    this.hudMs = this.hudMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  preRender(ctx: EngineContext): void {
    if (!this.battle) return;
    const t0 = performance.now();
    // Placed after the camera is final, or banners lag the view by a frame.
    this.banners.place(ctx, this.heightAt, ctx.input.alt);
    this.hudMs += (performance.now() - t0) * 0.1;
  }

  private hotkeys(ctx: EngineContext): void {
    const input = ctx.input;
    if (input.keyPressed('KeyO')) this.settings.toggle();
    if (input.keyPressed('KeyL')) this.setDebug(!this.debugOn);
    if (input.keyPressed('KeyN')) this.banners.enabled = !this.banners.enabled;

    // Game speed, Total War style. The HUD owns these because it owns the buttons that
    // show their state; nothing else in the engine binds them.
    const t = ctx.time;
    if (input.keyPressed('Space')) t.togglePause();
    if (input.keyPressed('Digit1')) {
      if (t.paused) t.togglePause();
      t.setSpeed(1);
    }
    if (input.keyPressed('Digit2')) {
      if (t.paused) t.togglePause();
      t.setSpeed(2);
    }
    if (input.keyPressed('Digit3')) {
      if (t.paused) t.togglePause();
      t.setSpeed(4);
    }
  }

  resize(w: number, h: number): void {
    void w;
    void h;
    this.ptr.measure();
    this.tooltip.hide();
    this.relayoutIn = 2;
  }

  dispose(): void {
    this.controller.dispose();
    this.ptr.dispose();
    this.overlay.dispose();
    this.cards.dispose();
    this.command.dispose();
    this.banners.dispose();
    this.minimap.dispose();
    this.topbar.dispose();
    this.feed.dispose();
    this.flow.dispose();
    this.settings.dispose();
    this.root.remove();
  }
}
