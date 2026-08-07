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

import type { EngineContext, QualityTier, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import type { DeploymentSystem } from '../sim/deployment';
import { Banners, type WallSegment } from './Banners';
import { BattleFlow } from './BattleFlow';
import { CommandPanel } from './CommandPanel';
import { DeploymentPanel } from './DeploymentPanel';
import { el, setText } from './dom';
import { EventFeed } from './EventFeed';
import { HudModel } from './model';
import { Minimap } from './Minimap';
import { PointerTracker } from './pointer';
import { SelectionController } from './SelectionController';
import { SettingsPanel } from './SettingsPanel';
import { DEFAULT_UI_SCALE } from './theme';
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
  private deployment: DeploymentSystem | null = null;
  private deployPanel: DeploymentPanel | null = null;
  private offs: Array<() => void> = [];

  private bottomPanel!: HTMLElement;
  private battle?: BattleSystem;
  private heightAt: (x: number, z: number) => number = () => 0;
  private tickAcc = TICK;
  private debugOn = true;
  private relayoutIn = 0;

  /** Smoothed main-thread cost of the HUD, in milliseconds. */
  hudMs = 0;

  /** Unit under the cursor, or -1. Exposed so a headless driver can verify picking. */
  get hoveredUnitId(): number {
    return this.model.hoveredId;
  }

  /**
   * What the cursor is resolving to this frame, for a headless driver.
   *
   * Read-only, and deliberately not a way to *issue* anything: a test that called a
   * placement function directly would pass while the feature was unreachable, which is a gap
   * this project has already shipped once. `tools/qa-deploy.mjs` still clicks with a real
   * mouse; this is how it picks the pixel to aim at and how it explains a miss.
   */
  get cursorWorld(): {
    x: number; z: number; valid: boolean;
    solidX: number; solidZ: number; solidY: number; onSolid: boolean;
    onWall: boolean;
  } {
    const c = this.controller;
    return {
      x: c.orderX, z: c.orderZ, valid: c.orderValid,
      solidX: c.solidX, solidZ: c.solidZ, solidY: c.solidY, onSolid: c.solidValid,
      onWall: !!(c.solidValid && this.deployment?.isWallPoint(c.solidX, c.solidZ)),
    };
  }

  /** Re-measure the card bar. Exposed so a driver can size-test an order of battle. */
  relayoutCards(): void {
    this.cards.relayout();
  }

  /**
   * Frame times measured here rather than read from `time.fps`. That mean is poisoned
   * for a full second by any single long frame — a load hitch, or the harness settling
   * its clock — and a wrong number in the corner of a screenshot misleads review. A
   * median over a short ring buffer ignores outliers entirely.
   *
   * Ignoring outliers entirely is exactly the problem. A median is the right lead number
   * for a screenshot and the wrong one for the question "why does this feel bad": a frame
   * distribution with a p50 of 9 ms and a p99 of 60 ms renders as "9.0 ms/f 111 fps", and
   * the player who is watching it stutter is told the game is running at 111 fps. The
   * median stays, and a p99 and a worst-frame now stand beside it.
   *
   * 240 frames, not 48. A p99 needs enough samples to have a 99th percentile at all: over
   * 48 the top centile is the single worst frame, a maximum wearing a percentile's name.
   * 240 is two to four seconds of play, which is about the window over which a player
   * integrates before calling something laggy.
   */
  private frameRing = new Float32Array(240);
  private frameRingAt = 0;
  private frameRingN = 0;
  private lastFrameAt = -1;
  private readonly ringSort = new Float32Array(240);
  /** Frames too long to be frame times: counted, not averaged away. See `update`. */
  private stalls = 0;

  constructor(private opts: HudOptions = {}) {}

  init(ctx: EngineContext): void {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('[hud] #hud-root is missing from the document');
    this.root = el('div', 'hud', host);
    // Applied before any panel attaches, so every canvas and hit box is measured at the
    // final scale once instead of being laid out at 1.0 and then relaid out.
    this.root.style.setProperty('--ui-scale', String(DEFAULT_UI_SCALE));

    const terrain = ctx.tryGet('terrain') as unknown as TerrainLike | undefined;
    if (terrain && typeof terrain.heightAt === 'function') {
      this.heightAt = (x, z) => terrain.heightAt(x, z);
    }

    this.battle = ctx.tryGet<BattleSystem>('battle');
    this.ptr = new PointerTracker(ctx.renderer.domElement);
    this.overlay = new WorldOverlay(this.heightAt);
    this.overlay.init(ctx.scene);

    this.controller = new SelectionController(this.model, this.overlay, this.ptr);
    // Deliberately NOT anchored to `VFXSystem.standardOf`, which returns the top of the
    // unit's physical cloth standard. That pole stands in rank two — 1.05 m behind the
    // front-rank midpoint, so roughly 3.5 m *in front of* the centre of a nine-rank-deep
    // cohort — and projecting it put the plaque off the leading edge of the block by up to
    // 49 px at zoom 0.62, in a direction that swung round with the camera yaw. `Banners`
    // averages the men's own screen positions instead; see the comment on `centre`.
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
    // Hit testing in screen space rather than through `pointer-events`: `core/Input`
    // listens on the canvas, so a DOM element that accepts the pointer also eats the
    // wheel and the right button, and three dozen plaques scattered over the field would
    // leave the player unable to zoom or rotate wherever the cursor happened to rest.
    this.controller.bannerAt = (x, y) => this.banners.unitAt(x, y);
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
    // A card's tooltip is anchored above that card, and the plaque is directly above the
    // card bar, so without this the stat block covers the plaque every time.
    this.tooltip.avoid = this.command.element;
    this.minimap.attach(this.root, ctx);
    this.settings.attach(this.topbar.toolSlot, ctx, {
      // Verified end to end: the button reaches `Engine.setQuality` and `ctx.quality.tier`
      // really changes.
      //
      // These buttons used to leave the world empty. The cause was never the HUD and never
      // the buttons: `LightingSystem.rebuild` disposed the cascaded-shadow rig without
      // detaching its lights, so a tier with a different cascade count ended up with both
      // sets in the scene and `NUM_DIR_LIGHT_SHADOWS` outran `CSM_CASCADES`, failing every
      // lit shader. The HUD survived because it is DOM, which is why the symptom reached
      // players as "the unit banners only work on ultra" — the plaques were the only thing
      // still drawn over the grey. Fixed in `LightingSystem`; see the note on `rebuild`.
      setQuality: this.opts.engine ? (t) => this.opts.engine!.setQuality(t) : undefined,
      onBannersChanged: (on) => {
        this.banners.enabled = on;
      },
      onDebugChanged: (on) => this.setDebug(on),
      onScaleChanged: (s) => {
        this.root.style.setProperty('--ui-scale', String(s));
        // Canvases are sized in CSS pixels, so a scale change needs a repaint.
        this.relayoutIn = 2;
        // Every plaque just changed size, so its hit box has to be re-measured.
        this.banners.remeasure();
      },
      bannersOn: () => this.banners.enabled,
      debugOn: () => this.debugOn,
    });
    this.flow.attach(this.root, ctx);
    this.controller.attachEvents(ctx);

    // The Aurelian Wall is geometry, not heightfield, so the banners' terrain sight line
    // cannot see it. Duck-typed like the rest: the HUD runs with no city.
    //
    // Snapshotted once, with the bay's ground folded into the height: the wall's build
    // stages are fixed at construction and 50 heightfield samples per unit per frame would
    // not be. Terrain (order -50) and the city (-20) have both initialised by the time this
    // system (700) does, so `this.heightAt` is already the real heightfield.
    const city = ctx.tryGet('city') as unknown as
      { getWallSegments?: () => { x1: number; z1: number; x2: number; z2: number; height: number }[] }
      | undefined;
    if (city && typeof city.getWallSegments === 'function') {
      this.banners.wallSegments = city.getWallSegments().map(
        (s): WallSegment => ({
          x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2,
          topY: this.heightAt((s.x1 + s.x2) * 0.5, (s.z1 + s.z2) * 0.5) + s.height,
        })
      );
    }

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
    // Real cooldowns rather than the HUD's own guesses, when the ability system is registered.
    const abilities = ctx.tryGet('abilities') as unknown as
      {
        cooldownFraction?: (unitId: number, ability: string) => number;
        activeOn?: (unitId: number) => string[];
      } | undefined;
    if (
      abilities &&
      typeof abilities.cooldownFraction === 'function' &&
      typeof abilities.activeOn === 'function'
    ) {
      this.controller.abilityProbe = {
        cooldownFraction: (u, a) => abilities.cooldownFraction!(u, a),
        activeOn: (u) => abilities.activeOn!(u),
      };
    }

    /*
     * The wall as somewhere the cursor can point.
     *
     * `Siege.wallTargetAt` is the same query the sim uses to decide a click meant the parapet,
     * and `DeploymentSystem` already asks it before the battle. Asking it here as well is what
     * lets the cursor, the drag hint, the hover marker and the order that is finally emitted
     * agree about which of ascend / traverse / descend is on offer — a UI that guesses at this
     * and a sim that decides it were bound to disagree, and did. Duck-typed like every other
     * optional integration: no siege system, no wall cursor, and every gesture is as it was.
     */
    const siege = (this.battle as unknown as {
      siege?: {
        wallTargetAt?: (x: number, z: number) => number;
        isGarrisoned?: (unitId: number) => boolean;
        wallSideAt?: (x: number, z: number) => -1 | 1;
      };
    } | undefined)?.siege;
    if (siege && typeof siege.wallTargetAt === 'function' && typeof siege.isGarrisoned === 'function'
      && typeof siege.wallSideAt === 'function') {
      this.controller.wallProbe = {
        targetAt: (x, z) => siege.wallTargetAt!(x, z),
        isGarrisoned: (u) => siege.isGarrisoned!(u),
        sideAt: (x, z) => siege.wallSideAt!(x, z),
      };
    }

    /*
     * The deployment phase, if this build has one and `main.ts` opened it.
     *
     * Attached last so the plaque sits above the rest of the chrome, and only when the
     * phase is actually live — a banner that says DEPLOYMENT over a running battle would be
     * worse than none. `deploymentBegan` is listened for as well as polled at init, because
     * the phase opens in `boot()` after `initAll`, which is after this runs.
     */
    this.deployment = (ctx.tryGet('deployment') as unknown as DeploymentSystem | undefined) ?? null;
    if (this.deployment) {
      const dep = this.deployment;
      this.controller.deployment = dep;
      this.topbar.clockHeld = () => dep.blocksClock;
      const open = (): void => {
        if (this.deployPanel || !dep.active) return;
        this.deployPanel = new DeploymentPanel(dep, this.model, this.controller);
        this.deployPanel.attach(this.root, ctx);
        this.root.classList.add('deploying');
      };
      this.offs.push(ctx.events.on('deploymentBegan', open));
      this.offs.push(ctx.events.on('deploymentEnded', () => {
        this.deployPanel?.dispose();
        this.deployPanel = null;
        this.controller.deployment = null;
        this.root.classList.remove('deploying');
      }));
      open();
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
  /**
   * Median, 99th percentile and worst frame time in ms over the ring, or zeros until it
   * has filled a little. One sort serves all three.
   */
  private frameStats(): { p50: number; p99: number; max: number } {
    const n = this.frameRingN;
    if (n < 4) return { p50: 0, p99: 0, max: 0 };
    const a = this.ringSort.subarray(0, n);
    a.set(this.frameRing.subarray(0, n));
    a.sort();
    // `ceil(0.99n) - 1` rather than `floor(0.99n)`: at n = 240 both give index 237, but at
    // small n the latter can land below the median, which would print a p99 under the p50.
    return { p50: a[n >> 1], p99: a[Math.max(0, Math.ceil(n * 0.99) - 1)], max: a[n - 1] };
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
    const f = this.frameStats();
    // Below ~1.6 ms per frame we are not in a display-driven loop at all — the
    // screenshot harness pumps `engine.frame()` back to back — so a frame *rate* would
    // be a fiction. The interval is always honest, so that is what leads.
    const fps = f.p50 >= 1.6 ? Math.round(1000 / f.p50).toString().padStart(4) : '   —';
    /*
     * `programs` is the count of linked shader programs. It belongs on a performance
     * readout because three.js links a program lazily, on the first frame a material is
     * actually drawn, and a link is tens of milliseconds of synchronous main thread. So a
     * program count that *climbs during a battle* is a mid-battle compile, and it is the
     * one stutter cause that leaves no other trace: draws, triangles and men are all
     * unchanged on the frame that pays for it. Watch it against `worst`.
     */
    // Packed into four short lines rather than six long ones: this sits over the sky in
    // every screenshot taken of the game, and a debug readout has no business occluding
    // more of the frame than it must.
    setText(
      this.perfLine,
      `${f.p50.toFixed(1)} ms/f ${fps} fps  hud ${this.hudMs.toFixed(2)}\n` +
        `p99 ${f.p99.toFixed(1)}  worst ${f.max.toFixed(1)}` +
        `${this.stalls > 0 ? `  stalls ${this.stalls}` : ''}\n` +
        `draws ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  ` +
        `prog ${info.programs?.length ?? 0}\n` +
        `men ${men}  units ${units}  sel ${this.model.selection.length}  ` +
        `${t.paused ? 'PAUSED' : `${t.gameSpeed}x`} t+${t.simTime.toFixed(0)}s`
    );
  }

  private setDebug(on: boolean): void {
    this.debugOn = on;
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
      /*
       * A third of a second is not a frame time, and it never was — but discarding it
       * silently was worse than including it. A tab restored from the background, a
       * shader link storm or a load stall all land here, and under the old guard they
       * left the readout claiming a steady 111 fps through a visible freeze. Count them
       * instead: `stalls` is a number the player can see, and it distinguishes "the frame
       * is uniformly slow" from "the frame is fine and something is periodically seizing".
       *
       * The ceiling stays, because a 4-second load stall in a 240-frame ring would own the
       * p99 for the next 240 frames and hide everything real behind it.
       */
      if (dt > 0.05 && dt < 333) {
        this.frameRing[this.frameRingAt] = dt;
        this.frameRingAt = (this.frameRingAt + 1) % this.frameRing.length;
        if (this.frameRingN < this.frameRing.length) this.frameRingN++;
      } else if (dt >= 333) {
        this.stalls++;
      }
    }
    this.lastFrameAt = t0;

    this.hotkeys(ctx);

    this.tickAcc += wall;
    if (this.tickAcc >= TICK) {
      this.tickAcc = 0;
      this.model.refresh(this.battle, ctx.time.simTime);
      // `derivePhase` reads the battle's own shape, and at t+0 with a garrison already on
      // the wall and missile troops in range it reports "Missile Exchange" — over a battle
      // that has not started. The phase the player is in is the one the plaque says.
      if (this.deployment?.active) this.model.phase = 'deployment';
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
      this.deployPanel?.sync(ctx);
      // The result screen must not fire on a paused, unfought battle: with no tick run,
      // `BattleFlowSystem` has no sides and every army reads as intact, but a scenario
      // whose second side is empty would still resolve. Deployment owns the outcome until
      // it commits.
      if (!this.deployment?.active) this.flow.checkOutcome(ctx, this.model);
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
    if (this.deployment?.active) {
      const z = this.deployment.zone;
      this.overlay.deployZone(z.xMin, z.zMin, z.xMax, z.zMax, this.deployment.frontIsLowZ());
    }
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
    this.banners.place(ctx, this.battle, this.heightAt, ctx.input.alt);
    this.hudMs += (performance.now() - t0) * 0.1;
  }

  private hotkeys(ctx: EngineContext): void {
    const input = ctx.input;
    if (input.keyPressed('KeyO')) this.settings.toggle();
    if (input.keyPressed('KeyL')) this.setDebug(!this.debugOn);
    if (input.keyPressed('KeyN')) this.banners.enabled = !this.banners.enabled;
    if (input.keyPressed('KeyJ')) this.cards.toggleFoes();
    if (input.keyPressed('KeyM')) this.minimap.cycleZoom();

    // Game speed, Total War style. The HUD owns these because it owns the buttons that
    // show their state; nothing else in the engine binds them.
    const t = ctx.time;
    /*
     * Deployment holds the clock, and that is not a nicety.
     *
     * A paused clock is what keeps `fixedUpdate` from running, and a paused `fixedUpdate` is
     * what keeps the AI's planner off the field — `installAI` binds its `commanded` set at
     * construction and re-plans every few ticks, and a player order it owns has been
     * measured drifting 46 m and being re-issued 23 times in ten seconds. So Space and the
     * speed keys are not merely ignored during deployment; if they were honoured the phase
     * would end up watching its own army walk away. Enter is the way out.
     */
    if (this.deployment?.blocksClock) {
      if (input.keyPressed('Enter') || input.keyPressed('NumpadEnter')) this.deployment.commit();
      return;
    }
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
    this.banners.remeasure();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.deployPanel?.dispose();
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
