/**
 * Selection and order issuing — the interaction core of the HUD.
 *
 * Reads raw state off `ctx.input` and turns it into Total War's grammar:
 *   left click            select a unit under the cursor
 *   left drag             marquee select
 *   left double-click     select every unit of that type
 *   shift / ctrl + click  add to or remove from the selection
 *   right click           move here; on an enemy, attack it
 *   right click + drag    the drag length sets the frontage, the drag direction sets
 *                         the facing, and a ghost formation previews the result
 *   shift + right         queue the order behind the current one
 *   alt + right           run instead of march
 *   ctrl + right          attack-move; on a man standing on a wall, attack *him* rather
 *                         than storming the stone he is standing on
 *
 * The camera also wants the right button for yaw, so the rule is: with something selected the
 * right button belongs to the order system (`rig.suppressDrag` holds the camera off); with an
 * empty selection it belongs to the camera. Alt used to be a third case — it handed the button
 * back to the camera — and that is why `alt + right` could never issue the run order the legend
 * promised. Q/E and the middle button rotate and pan under every selection, so nothing is lost.
 */

import type { EngineContext } from '../core/Engine';
import { Faction, UnitOrder } from '../sim/types';
import { el } from './dom';
import type { HudModel, UnitView } from './model';
import {
  distanceToFootprint, footprintCorner, footprintOf, makeScreenPick, makeScreenRay,
  orderPointForSolid, type PickSolid, projectPoint, rayPlaneY, screenPick, screenRay,
  type ScreenPick, type ScreenRay, type Footprint, type Projected,
} from './picking';
import type { PointerTracker } from './pointer';
import { abilityUI, PLAYER_FACTION } from './theme';
import type { GhostSpec, WorldOverlay } from './WorldOverlay';

export type CursorKind = 'default' | 'move' | 'attack' | 'friend' | 'select' | 'wall';

/** One phrase per wall order, so the hint and the cursor cannot describe different things. */
const WALL_HINT: Record<'ascend' | 'traverse' | 'descend' | 'storm', string> = {
  ascend: 'Up onto the wall',
  traverse: 'Along the wall',
  descend: 'Down off the wall',
  // Named differently on purpose: from outside there are no stairs, and what the order
  // actually buys is a place in the file at whatever ramp or ladder is against that bay.
  storm: 'Storm the wall here',
};

/** Pixels of pointer travel before a click becomes a drag. */
const DRAG_PX = 7;
/** Seconds between two clicks that still count as a double-click. */
const DOUBLE_S = 0.34;
/** Minimum world metres of right-drag before it is read as a frontage command. */
const FRONTAGE_MIN_M = 6;
/**
 * Fewest ranks a frontage drag may flatten a unit to.
 *
 * Three, because two is not a formation: the front rank has nobody to step into its place and
 * the block has no depth to absorb a charge. It is also roughly where the drawing stops making
 * sense — at 320 men and 0.86 m of lateral spacing, the unclamped 180 m drag that prompted this
 * produced 210 files, 1.5 ranks, and rendered as a 181 m thread. Three ranks caps the same
 * cohort at 107 files, about 92 m, which is still two and a half times its natural frontage.
 */
const MIN_RANKS = 3;
/**
 * Floor under the pick slack, in world metres.
 *
 * The slack is seven pixels converted to metres so a thin skirmish line stays pickable when
 * zoomed out, and it is capped at nine metres so it does not get sloppy. It had no floor, and
 * at close zoom seven pixels is **13 cm** — well inside the men's own footprint slack, so
 * every click on a cohort had to be dead on the block.
 */
const PICK_SLACK_M = 1.1;

const FOOT: Footprint = { cx: 0, cz: 0, halfW: 1, halfD: 1, cos: 1, sin: 0 };
const PROJECTED: Projected = { x: 0, y: 0, distance: 0, visible: false };
const PICK: ScreenPick = makeScreenPick();
const RAY: ScreenRay = makeScreenRay();
const ORDER_AT = { x: 0, y: 0, z: 0 };
const CORNER = { x: 0, z: 0 };
const PLANE_AT = { x: 0, z: 0 };

/**
 * Metres a unit's men must stand above the terrain under them before the cursor is aimed at
 * the men rather than at that terrain.
 *
 * 2.5 m is comfortably above the worst disagreement a slope can produce inside one footprint —
 * `cy` is sampled at the block's centre while `standY` is a mean over every man in it — and
 * comfortably below anything a man can actually be standing on: the Aurelian walk is 8 m up
 * and a siege tower's deck is 20. So the ground path is entered by exactly the units that were
 * always on the ground, and their picking is unchanged by construction.
 */
const ELEVATED_MIN_DY = 2.5;

/**
 * Where on a standing man the cursor is deemed to be aiming, metres above his feet.
 *
 * A player clicks the middle of a soldier, not his boots, and an RTS camera looks *down*: a
 * ray through a man's chest crosses the plane of his feet several metres beyond him. Testing
 * against a plane at mid-body splits that error instead of always landing long.
 */
const MAN_MID_Y = 0.9;

/**
 * Half-extents of a siege tower's footprint, metres.
 *
 * Duplicated from `sim/siegeGeometry.TOWER_HALF_W/D` rather than imported: `Siege` does not
 * publish a footprint with `towerReport()`, only a centre and a deck height, and the UI
 * taking a build dependency on the siege module's geometry constants for two numbers is
 * worse than a named constant that is checked by the probe. `probe-nav --only=pick`
 * measures the resulting hit against the tower's own reported centre.
 */
const SIEGE_TOWER_HALF = 2.1;

/**
 * How far forward along the cursor's ray a hit on a siege engine may look for the wall it
 * is leaning on, in metres.
 *
 * A docked tower's front face stands 0.32 m off the masonry and the machine is 4.2 m deep,
 * so a ray that entered its near face has at most about five metres of engine in front of
 * it. Sixteen leaves room for one still trundling up the glacis without ever reaching past
 * the curtain into the city behind it.
 */
const SIEGE_REACH_M = 16;

/** What the HUD needs from `AbilitySystem`. Duck-typed so the HUD runs without it. */
export interface AbilityProbe {
  /** 0 = ready, 1 = just used. */
  cooldownFraction(unitId: number, ability: string): number;
  activeOn(unitId: number): string[];
}

/**
 * What the pre-battle deployment phase needs from the order gestures.
 *
 * Duck-typed rather than imported so the HUD still runs against a build with no deployment
 * phase registered. While `active` is true the right-drag stops issuing orders and starts
 * *placing* units instead — same gesture, same ghosts, same frontage readout, different
 * verb. That reuse is deliberate: a player who has learned to draw a line with the right
 * button in play should not have to learn a second gesture to draw the same line before it.
 */
export interface DeploymentHooks {
  readonly active: boolean;
  readonly lastRefusal: string;
  /** Non-null when the last `place` rebuilt the unit instead of moving it. */
  readonly lastReplacement: { from: number; to: number } | null;
  place(unitId: number, x: number, z: number, facing: number, width?: number): boolean;
  setFormation(unitId: number, formationId: string): boolean;
  remove(unitId: number): boolean;
  contains(x: number, z: number): boolean;
  isWallPoint(x: number, z: number): boolean;
}

export class SelectionController {
  cursor: CursorKind = 'default';
  /** Move orders run by default while this is on (toggled with R). */
  runByDefault = false;
  /**
   * The sim's own cooldown and duration bookkeeping, installed by `HudSystem` when
   * `AbilitySystem` is registered. When it is present the two maps below go unread — they
   * are the fallback for a HUD running against a sim that has no ability system at all.
   */
  abilityProbe: AbilityProbe | null = null;
  /**
   * Unit whose banner covers a screen point, installed by `HudSystem`. A banner is the
   * thing a player aims at to pull one cohort out of a melee, so it is a first-class hit
   * target: hovering one highlights the unit and names it, clicking selects it, and
   * shift- or ctrl-clicking adds to or removes from the selection. Right-clicking an
   * enemy's banner attacks it, which falls out of the existing order path for free.
   */
  bannerAt: ((x: number, y: number) => number) | null = null;
  /**
   * The deployment phase, installed by `HudSystem` when it is registered. Null in play.
   */
  deployment: DeploymentHooks | null = null;
  /** Unit under the cursor's banner this frame, or -1. */
  private overBanner = -1;
  /**
   * Ctrl as it is *right now*, not as it was when a button went down.
   *
   * `dragCtrl` is the gesture's own snapshot and is deliberately sticky, which is right for
   * deciding what an order was — and useless for the cursor, which has to answer "what would
   * happen if I clicked here" before any button is pressed. Sampled once a frame in `update`
   * so `hostileUnder` and `updateCursor` read the same value and cannot disagree.
   */
  private ctrlHeld = false;
  /** Ability cooldown expiry times, keyed `unitId:abilityId`, in sim seconds. */
  private cooldowns = new Map<string, number>();
  /** Abilities the sim reports as currently running, keyed `unitId:abilityId`. */
  private active = new Set<string>();
  private offs: Array<() => void> = [];

  private marquee!: HTMLElement;
  private hint!: HTMLElement;
  private boxing = false;
  private boxValid = false;
  private lastClickAt = -10;
  private lastClickId = -1;

  private dragging = false;
  private dragStartX = 0;
  private dragStartZ = 0;
  private dragEndX = 0;
  private dragEndZ = 0;
  private dragHostileId = -1;
  private ghosts: GhostSpec[] = [];
  /**
   * Modifiers held at any point during the right-button gesture.
   *
   * `issueDragOrder` read `ctx.input.ctrl` at *release*, which is a one-frame race with the
   * hand: let go of ctrl a moment before the button and the attack-move silently became a
   * move. Seeded from the pointerdown snapshot — the rule `PointerTracker` documents — and
   * then held true if the modifier appears later in the gesture, so neither "pressed ctrl
   * first" nor "pressed ctrl after aiming" can miss.
   */
  private dragCtrl = false;
  private dragAlt = false;
  private dragShift = false;
  /** Frontage the ghosts actually occupy, which is not the drag length once it is clamped. */
  private ghostSpan = 0;

  /**
   * The *ground* under the cursor this frame, valid when `groundValid`.
   *
   * Terrain only. This is what hit-tests a formation's footprint and what the marquee
   * reads; it is deliberately not affected by anything standing on that ground.
   */
  groundX = 0;
  groundZ = 0;
  groundValid = false;
  /**
   * Where an *order* aimed at the cursor should send men, valid when `orderValid`.
   *
   * Equal to the ground point except when the cursor is over a solid, and true in cases
   * where `groundValid` is false — a click high on a siege tower produces a ray that never
   * meets the heightfield at all, and used to issue no order whatsoever.
   */
  orderX = 0;
  orderZ = 0;
  orderValid = false;
  /**
   * Where the ray actually met a solid, **before** the push-out, valid when `solidValid`.
   *
   * `orderX/orderZ` is deliberately pushed clear of masonry, because an order aimed at a
   * wall means the ground beside it — a man cannot stand inside stone. A *deployment* aimed
   * at the same pixel means the opposite: the top of the wall is exactly where the player
   * wants the unit, and `Siege.wallTargetAt` has to be asked about the point on the parapet
   * rather than about the grass 4 m away from it, which is not on the wall at all.
   */
  solidX = 0;
  solidZ = 0;
  solidY = 0;
  solidValid = false;
  /**
   * The point on the parapet the cursor is aiming at *in play*, valid when `wallValid`.
   *
   * The owner's report was that the wall "just doesn't really do a good job of … letting you
   * select that elevated point as the location that you want your troops to go to". The order
   * did not survive the trip: `orderX/orderZ` is pushed a body radius clear of whatever solid
   * it lands on, because for a siege tower or an insula the ground *beside* the thing is the
   * only place a cohort can stand — and `Siege.wallTargetAt` is then asked about that grass
   * rather than about the parapet, so the sim never sees a wall order at all.
   *
   * `Siege` already owns the whole of the destination half: `interceptOrders` subscribes to
   * `orderIssued` for exactly this, and turns the point into `sendToWall`, `moveAlongWall` or
   * `sendToGround` depending on where the unit is standing. It only has to be handed the point
   * the player pointed at, which is `solidX/solidZ`, not the one pushed out of it. Same
   * distinction `DeploymentSystem.isWallPoint` draws before the battle, asked with a different
   * verb: there it means "stand here now", here it means "walk up there".
   */
  wallX = 0;
  wallZ = 0;
  wallY = 0;
  wallValid = false;

  /**
   * What the HUD needs from `Siege` to know a parapet when the cursor is over one.
   *
   * Duck-typed and installed by `HudSystem`, like `bannerAt` and `abilityProbe`: with no siege
   * system registered — a field battle, or a map with no city — this stays null and every
   * gesture behaves exactly as it did.
   */
  wallProbe: {
    targetAt(x: number, z: number): number;
    isGarrisoned(unitId: number): boolean;
    /**
     * Which side of the curtain a point is on: -1 inside the city, +1 out in the field.
     *
     * Asked because the two sides of a wall are two different orders, and the pick cannot
     * tell them apart on its own. See `updateGround`.
     */
    sideAt(x: number, z: number): -1 | 1;
    /**
     * Countermand a wall plan, and take a unit out of a machine's boarding file.
     *
     * Optional, because the whole probe is duck-typed and a build with an older `Siege` must
     * still run. Both verbs are public on `Siege` and neither had a caller, which is why an
     * order about the wall was the one order in this game that could not be taken back.
     */
    cancelWallPlan?(unitId: number): boolean;
    releaseEscalade?(unitId: number): boolean;
  } | null = null;

  constructor(
    private model: HudModel,
    private overlay: WorldOverlay,
    private ptr: PointerTracker
  ) {}

  /**
   * Mirror of ability state for the fallback path. `AbilitySystem` publishes the real
   * numbers through `abilityProbe`; these events keep the plaque honest without it.
   */
  attachEvents(ctx: EngineContext): void {
    this.offs.push(
      ctx.events.on('abilityActivated', (e) => {
        const key = `${e.unitId}:${e.ability}`;
        if (e.active) this.active.add(key);
        else this.active.delete(key);
        this.cooldowns.set(key, ctx.time.simTime + abilityUI(e.ability).cooldown);
      })
    );
    this.offs.push(
      ctx.events.on('abilityExpired', (e) => {
        this.active.delete(`${e.unitId}:${e.ability}`);
      })
    );
  }

  isAbilityActive(unitId: number, ability: string): boolean {
    if (this.abilityProbe) return this.abilityProbe.activeOn(unitId).includes(ability);
    return this.active.has(`${unitId}:${ability}`);
  }

  attach(root: HTMLElement): void {
    this.marquee = el('div', 'marquee', root);
    this.marquee.style.display = 'none';
    this.hint = el('div', 'drag-hint', root);
    this.hint.style.display = 'none';
  }

  /** Frontage readout that follows the cursor while an order is being drawn. */
  private showHint(text: string, tone: 'move' | 'attack'): void {
    if (this.hint.style.display !== 'block') this.hint.style.display = 'block';
    if (this.hint.textContent !== text) this.hint.textContent = text;
    if (this.hint.dataset.tone !== tone) this.hint.dataset.tone = tone;
    const t = `translate3d(${Math.round(this.ptr.x + 18)}px, ${Math.round(this.ptr.y + 14)}px, 0)`;
    if (this.hint.style.transform !== t) this.hint.style.transform = t;
  }

  private hideHint(): void {
    if (this.hint.style.display !== 'none') this.hint.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // Selection API — also used by the unit cards and the minimap
  // -------------------------------------------------------------------------

  private commit(ids: number[], ctx: EngineContext): void {
    const same =
      ids.length === this.model.selection.length && ids.every((v, i) => this.model.selection[i] === v);
    for (const v of this.model.views) v.unit.selected = false;
    this.model.selection = ids;
    for (const id of ids) {
      const v = this.model.view(id);
      if (v) v.unit.selected = true;
    }
    if (!same) ctx.events.emit('selectionChanged', { unitIds: ids.slice() });
  }

  selectOnly(id: number, ctx: EngineContext): void {
    const v = this.model.view(id);
    if (!v || v.destroyed || !v.own) return;
    this.commit([id], ctx);
  }

  toggle(id: number, ctx: EngineContext): void {
    const v = this.model.view(id);
    if (!v || v.destroyed || !v.own) return;
    const next = this.model.selection.slice();
    const at = next.indexOf(id);
    if (at >= 0) next.splice(at, 1);
    else next.push(id);
    this.commit(next, ctx);
  }

  selectSameType(id: number, ctx: EngineContext): void {
    const v = this.model.view(id);
    if (!v || !v.own) return;
    const ids = this.model.views
      .filter((o) => o.own && !o.destroyed && o.def.id === v.def.id)
      .map((o) => o.id);
    this.commit(ids, ctx);
  }

  selectArmy(ctx: EngineContext): void {
    this.commit(
      this.model.views.filter((v) => v.own && !v.destroyed).map((v) => v.id),
      ctx
    );
  }

  clear(ctx: EngineContext): void {
    this.commit([], ctx);
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private orderIds(): number[] {
    return this.model.selectedViews.filter((v) => !v.routing).map((v) => v.id);
  }

  /**
   * Stop. Including whatever the wall was told to do with these men.
   *
   * A `halt` event reaches `BattleSystem` and nothing else, so a unit halfway through a wall
   * order kept executing it: measured on the Aurelian Wall, a traverse aimed two runs along
   * — across a construction gap no link bridges — left the cursor promising "Along the wall",
   * the order accepted, and **156 of 158 men stuck with the plan still open at age 3,657
   * ticks**. `Siege.advancePlans` will not abandon it until `PLAN_TIMEOUT`, ten minutes, and
   * `updateGarrisons` defers to a live plan, so the cohort could not even re-form where it
   * stood. The verbs to undo both halves are public on `Siege` and had no callers.
   *
   * Not silent: `Siege` owns these men's positions, so the countermand happens before the
   * halt event rather than after it, and the men are left standing on whatever they are
   * standing on — which is always a legal place to be, because they were there a tick ago.
   */
  issueHalt(ctx: EngineContext): void {
    const ids = this.orderIds();
    if (!ids.length) return;
    const probe = this.wallProbe;
    if (probe) {
      for (const id of ids) {
        probe.cancelWallPlan?.(id);
        probe.releaseEscalade?.(id);
      }
    }
    ctx.events.emit('orderIssued', { unitIds: ids, kind: 'halt' });
  }

  /**
   * Note when testing this under the screenshot harness: the harness defaults to
   * `?autoplay=1`, which hands both armies to the AI so a shot has a battle in it, and the
   * AI will re-issue its own formation over the player's within a second. Load with an
   * explicit `?autoplay=0` to drive Rome yourself and see the order hold.
   */
  issueFormation(id: string, ctx: EngineContext): void {
    const ids = this.model.selectedViews
      .filter((v) => !v.routing && v.def.formations.includes(id))
      .map((v) => v.id);
    if (!ids.length) return;
    // During deployment a formation change has to re-stand the men there and then. Left to
    // the ordinary path it would set `formationId` and `width` and nothing would move,
    // because the steering that dresses a unit into its new shape runs in `fixedUpdate` and
    // the clock is stopped.
    const dep = this.deployment;
    if (dep?.active) {
      for (const uid of ids) dep.setFormation(uid, id);
      return;
    }
    ctx.events.emit('orderIssued', { unitIds: ids, kind: 'formation', formation: id });
  }

  /** Take the selection off the field. Deployment only; in play a unit is lost, not removed. */
  removeSelected(ctx: EngineContext): number {
    const dep = this.deployment;
    if (!dep?.active) return 0;
    let n = 0;
    for (const id of this.model.selection.slice()) if (dep.remove(id)) n++;
    if (n > 0) this.clear(ctx);
    return n;
  }

  issueAbility(id: string, ctx: EngineContext): void {
    const now = ctx.time.simTime;
    const ids: number[] = [];
    for (const v of this.model.selectedViews) {
      if (!v.def.abilities.includes(id)) continue;
      if (this.cooldownFrac(v.id, id, now) > 0) continue;
      ids.push(v.id);
    }
    if (!ids.length) return;
    ctx.events.emit('orderIssued', { unitIds: ids, kind: 'ability', ability: id });
    // Optimistic only on the fallback path; with the probe installed the sim's next tick
    // reports the real cooldown and this map is never read.
    if (!this.abilityProbe) {
      for (const uid of ids) this.cooldowns.set(`${uid}:${id}`, now + abilityUI(id).cooldown);
    }
  }

  cooldownFrac(unitId: number, ability: string, now: number): number {
    if (this.abilityProbe) return this.abilityProbe.cooldownFraction(unitId, ability);
    const t = this.cooldowns.get(`${unitId}:${ability}`);
    if (t === undefined) return 0;
    const total = Math.max(1, abilityUI(ability).cooldown);
    return Math.min(1, Math.max(0, t - now) / total);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(ctx: EngineContext, heightAt: (x: number, z: number) => number): void {
    const input = ctx.input;
    this.ctrlHeld = input.ctrl;
    this.overBanner = this.bannerAt ? this.bannerAt(this.ptr.x, this.ptr.y) : -1;
    // Published so no other system treats a click aimed at a plaque as a click on the
    // ground behind it. It is only ever true while the cursor is genuinely inside a
    // plaque's box, so the field stays clickable everywhere else.
    input.uiCapture = this.ptr.overUi || this.overBanner >= 0;

    this.refreshStorming();
    this.updateGround(ctx, heightAt);
    const hovered = this.pickUnit(ctx);
    if (!this.ptr.overUi) this.model.hoveredId = hovered;

    this.handleLeft(ctx);
    this.handleRight(ctx, hovered);
    this.handleKeys(ctx);
    this.updateCursor(hovered);
    this.drawWallTarget();
  }

  /**
   * Mark the stretch of parapet the cursor is offering, on the parapet.
   *
   * The whole of the hover half of the owner's report: a wall is the one destination in the
   * game whose marker cannot be drawn on the heightfield, because the heightfield there is
   * inside the masonry and under it. Suppressed during deployment, which draws its own.
   */
  private drawWallTarget(): void {
    if (!this.wallValid || this.deployment?.active) return;
    const intent = this.wallIntent();
    if (intent !== 'ascend' && intent !== 'traverse' && intent !== 'storm') return;
    let men = 0;
    for (const v of this.model.selectedViews) men += v.alive;
    // `Siege` packs a garrison four to five ranks deep at the walk's own spacing; four is the
    // conservative end, so the marker is never longer than the stretch that will be filled.
    const halfLength = Math.max(3, (men / 4) * 0.86 * 0.5);
    this.overlay.wallTarget(this.wallX, this.wallZ, this.wallY, halfLength);
  }

  /**
   * Solids the cursor can be aimed at, rebuilt when the world's structures change.
   *
   * Note what is *not* in here: the city's insulae and monuments. `CitySystem` publishes
   * `topY: 1e4` for all 1,730 of them because it does not model their heights, and a box
   * ten kilometres tall is a pillar the cursor cannot help but hit. `picking.raySolid`
   * rejects them anyway, but building the set from the things a player can actually issue
   * an order against — the curtain, its towers, and the siege train — says so out loud and
   * keeps the array small enough that the per-pointer-event linear scan stays free.
   *
   * The siege towers move, so the cache is rebuilt whenever their count changes as well as
   * when `obstacleGeneration` does; their positions are refreshed every frame below.
   */
  private solids: PickSolid[] = [];
  /**
   * Everything a man cannot stand in, which is a wider set than the pick set: the insulae
   * and monuments are not targetable but a formation cannot be sent into one either.
   */
  private blockers: PickSolid[] = [];
  private solidsRev = -1;
  private siegeCount = -1;
  /** Where in `solids` the siege engines begin, so only they are re-read per frame. */
  private siegeAt = 0;

  /** The set the cursor is tested against, for the overlay and for `tools/probe-nav.mjs`. */
  get pickSolids(): readonly PickSolid[] {
    return this.solids;
  }

  private refreshSolids(ctx: EngineContext): void {
    const city = ctx.tryGet('city') as unknown as {
      obstacleGeneration?: number;
      getObstacles?: () => readonly (PickSolid & { kind?: string })[];
    } | undefined;
    const siege = (ctx.tryGet('battle') as unknown as {
      siege?: { towerReport?: () => { x: number; z: number; baseY: number; deckY: number }[] };
    } | undefined)?.siege;
    const towers = siege?.towerReport ? siege.towerReport() : [];

    const rev = city?.obstacleGeneration ?? 0;
    if (rev !== this.solidsRev || towers.length !== this.siegeCount) {
      this.solidsRev = rev;
      this.siegeCount = towers.length;
      this.solids = [];
      this.blockers = [];
      if (city?.getObstacles) {
        for (const o of city.getObstacles()) {
          this.blockers.push(o);
          // `CitySystem.buildObstacles` emits only these two of the five declared kinds as
          // things with a modelled top; monuments and insulae carry the 1e4 sentinel.
          if (o.kind === 'wall' || o.kind === 'tower') this.solids.push(o);
        }
      }
      this.siegeAt = this.solids.length;
      for (const t of towers) {
        const box: PickSolid = {
          x: t.x, z: t.z, hw: SIEGE_TOWER_HALF, hd: SIEGE_TOWER_HALF, rot: 0,
          topY: t.deckY, baseY: t.baseY,
        };
        this.solids.push(box);
        this.blockers.push(box);
      }
    } else {
      for (let i = 0; i < towers.length; i++) {
        const s = this.solids[this.siegeAt + i];
        const t = towers[i];
        s.x = t.x;
        s.z = t.z;
        s.topY = t.deckY;
        s.baseY = t.baseY;
      }
    }
  }

  /**
   * Resolve the cursor into the two answers the gestures need, and no fewer.
   *
   * `groundX/groundZ` is the paving under the pointer and nothing else. `orderX/orderZ` is
   * where an order aimed here should send men, which is the same point except when a solid
   * stands in front of it, in which case it is the ground beside that solid.
   *
   * They were once the same number, produced by folding the solids into the ground ray, and
   * that is the bug the player reported as "the location they choose to walk to is not at
   * all the location i desire, its some random place in the city". Measured at one camera
   * over six spread-out clicks, all six collapsed to within 2 m of one point, 42 to 92 m
   * from where the pointer was — the camera stood inside an insula's footprint, that
   * insula's `topY` was the 1e4 sentinel, so the slab test found the eye already inside the
   * box and returned the camera's own position as the hit. One ray, one answer, wrong
   * question.
   */
  private updateGround(ctx: EngineContext, heightAt: (x: number, z: number) => number): void {
    const nx = (this.ptr.x / Math.max(1, ctx.viewW)) * 2 - 1;
    const ny = -(this.ptr.y / Math.max(1, ctx.viewH)) * 2 + 1;
    this.refreshSolids(ctx);
    // One unproject, kept for the frame: `pickUnit` asks the same ray where it crosses each
    // elevated unit's own standing level, and doing that per unit would be a second unproject
    // per unit per frame.
    screenRay(ctx.camera, nx, ny, RAY);
    screenPick(ctx.camera, nx, ny, heightAt, this.solids, PICK);

    this.groundValid = PICK.groundHit;
    if (PICK.groundHit) {
      this.groundX = PICK.groundX;
      this.groundZ = PICK.groundZ;
    }

    this.solidValid = PICK.solid >= 0;
    this.wallValid = false;
    if (PICK.solid >= 0) {
      this.solidX = PICK.solidX;
      this.solidZ = PICK.solidZ;
      this.solidY = PICK.solidY;
      /*
       * Is this the top of a wall the player can put men on?
       *
       * Two tests, and the second is not decoration. `Siege.wallTargetAt` is a *plan* query —
       * it answers about x and z and knows nothing about height — so on its own it says yes to
       * a click on the outer face four metres down, which is not "get on the wall", it is "go
       * to the foot of it". The slab test lands exactly on `topY` when the ray came down onto
       * the walk and strictly below it on any side face, so comparing the two separates the
       * two orders cleanly. Half a metre of tolerance rather than an epsilon so a click on a
       * merlon still counts.
       */
      /*
       * ...and the slab test is the *defender's* question, not the attacker's.
       *
       * Standing in the field you cannot see the walk at all: the outer face and the merlons
       * are between the camera and it, so the ray meets the stone metres below `topY` and the
       * test above says "the foot of the wall" for every pixel of an enemy curtain. Measured
       * on the storm of Carthage from the player's own camera — solid hit at y 22.9 against a
       * walk at 26.5, `wallValid` false everywhere on the wall. There is nothing else to
       * *mean* at the foot of a wall you are besieging, so on that side any hit on the
       * masonry is a wall order and `Siege.escalade` decides whether there is a way up.
       */
      if (this.wallProbe && this.wallProbe.targetAt(PICK.solidX, PICK.solidZ) >= 0
        && (PICK.solidY > this.solids[PICK.solid].topY - 0.5 || this.selectionIsStorming())) {
        this.wallX = PICK.solidX;
        this.wallZ = PICK.solidZ;
        this.wallY = PICK.solidY;
        this.wallValid = true;
      } else if (this.wallProbe && this.selectionIsStorming()) {
        /*
         * From outside, the thing standing between the cursor and the wall *is* the wall.
         *
         * The rule above already says that on the storming side any hit on the masonry is a
         * wall order, because the walk cannot be seen from there at all. What it could not
         * say was which masonry: `Siege.wallTargetAt` measures against the curtain's own
         * standing band widened by `WALL_CLICK_BAND` (1.7 m), and two of the three things a
         * besieger actually points at stick out well past it —
         *
         *  - a **siege tower**, whose front face docks 0.32 m off the stone and which is
         *    4.2 m deep, so its near face is about 4.5 m out. Measured on the storm of
         *    Carthage: aiming at the bay a tower is working, *no* camera on the field side
         *    reaches the masonry, `wallValid` is false at every zoom and both bearings, and
         *    the order goes out as a plain move to the grass beside the machine. The route
         *    the whole machine exists to provide could not be commanded by clicking it.
         *  - a **tower of the wall**, whose mass projects several metres in front of the
         *    curtain. Same reading: `wallValid false`, `solid true y 25.16`, and a move order
         *    1.8 m from the parapet the player pointed at.
         *
         * Walked forward along the cursor's own ray rather than guessed at, so it is the
         * geometry that decides and not a table of half-extents: the first point within
         * `SIEGE_REACH_M` that the sim itself calls a wall station is the bay this thing is
         * standing against. Confined to the storming side, where every hit on masonry
         * already means the wall, so nothing about picking from inside the city changes.
         */
        const probe = this.wallProbe;
        const inv = Math.hypot(RAY.dx, RAY.dz);
        if (inv > 1e-6) {
          const ux = RAY.dx / inv;
          const uz = RAY.dz / inv;
          for (let m = 1; m <= SIEGE_REACH_M; m++) {
            const x = PICK.solidX + ux * m;
            const z = PICK.solidZ + uz * m;
            if (probe.targetAt(x, z) < 0) continue;
            this.wallX = x;
            this.wallZ = z;
            // The deck of a docked tower is cut level with the walk, so its own top is the
            // right height for the marker; the order itself only carries x and z.
            this.wallY = this.solids[PICK.solid].topY;
            this.wallValid = true;
            break;
          }
        }
      }
      // A click on a 20 m siege tower means the tower. Without this the ray only ever met
      // the heightfield, so the order went to the grass behind it — 13.6 m past, and 138.8 m
      // past from a low camera, or nothing at all when the ray rose clear of the ground.
      orderPointForSolid(this.solids, PICK.solid, this.blockers, PICK.solidX, PICK.solidZ, heightAt, ORDER_AT);
      this.orderX = ORDER_AT.x;
      this.orderZ = ORDER_AT.z;
      this.orderValid = true;
    } else if (PICK.groundHit) {
      this.orderX = PICK.groundX;
      this.orderZ = PICK.groundZ;
      this.orderValid = true;
    } else {
      this.orderValid = false;
    }
  }

  /**
   * What a right-click here would do to the selection, as a verb the player can read.
   *
   * One function so the cursor, the hover marker, the drag hint and the order that is finally
   * emitted cannot disagree about which of the four wall orders is on offer — which is the
   * other half of the owner's complaint, that the cursor tells you nothing before you commit.
   */
  /**
   * True when the selection is standing outside the curtain, looking at somebody else's wall.
   *
   * Majority rather than unanimity, for the same reason `wallIntent` is: one order goes out
   * and `Siege` decides per unit what it means. Nothing is asked of the sim unless a wall
   * probe exists, so a field battle answers false without a call.
   */
  private selectionIsStorming(): boolean {
    return this.storming;
  }

  /**
   * Recompute `storming` — once a frame, and not on every question that wants it.
   *
   * `Siege.wallSideAt` is a linear scan over every station on the circuit, and its own
   * comment promises it is "only ever called on an order". The cursor asks this question up
   * to four times a frame (the pick, the hover marker, the hit test and the cursor glyph), so
   * asking the sim each time would put fifteen hundred distance tests per selected unit into
   * the frame path to answer a question whose answer cannot change inside one frame.
   */
  private storming = false;
  private refreshStorming(): void {
    this.storming = false;
    const probe = this.wallProbe;
    if (!probe) return;
    const sel = this.model.selectedViews;
    if (sel.length === 0) return;
    let out = 0;
    for (const v of sel) {
      if (this.onTheWall(v)) continue;
      if (probe.sideAt(v.cx, v.cz) > 0) out++;
    }
    this.storming = out > sel.length * 0.5;
  }

  /**
   * Are this unit's **men** on the wall — not merely its record.
   *
   * `Siege.isGarrisoned` is a flag on the unit, and it survives states in which almost
   * nobody is up there. A descent measured from the seat left 91 of 99 archers in the street
   * with the flag still set and the plan still open, so the next click read as a *traverse*
   * and the hint said "Along the wall" over a cohort standing in a city square. A ladder
   * party in the field with a handful of men over the parapet reads "Down off the wall" for
   * the same reason.
   *
   * So the flag is necessary and not sufficient: the men have to be up there too, which
   * `standY` now answers from the men themselves (see `model.ts`). One predicate, read by
   * both `wallIntent` and `refreshStorming`, because the last three bugs of this shape in
   * this project were two functions asking the same question two ways.
   */
  private onTheWall(v: UnitView): boolean {
    return !!this.wallProbe?.isGarrisoned(v.id) && v.standY - v.cy > ELEVATED_MIN_DY;
  }

  private wallIntent(): 'ascend' | 'traverse' | 'descend' | 'storm' | null {
    const probe = this.wallProbe;
    if (!probe) return null;
    const sel = this.model.selectedViews;
    if (sel.length === 0) return null;
    // From outside, "up" means over a ramp or a ladder, and it is worth saying so before the
    // player commits: an escalade is a different thing from walking up your own stairs.
    if (this.wallValid && this.selectionIsStorming()) return 'storm';
    // A mixed selection is named by the majority; every unit still gets the same order and
    // `Siege` decides per unit what that means for it.
    let onWall = 0;
    for (const v of sel) if (this.onTheWall(v)) onWall++;
    if (this.wallValid) return onWall > sel.length * 0.5 ? 'traverse' : 'ascend';
    return onWall > 0 ? 'descend' : null;
  }

  /**
   * Nearest unit whose banner or formation footprint contains the cursor, or -1.
   *
   * A unit is hit-tested on the level its men are standing on, which for everybody on the
   * ground is the ground and is the test this has always applied. For a cohort on a wall walk
   * it is not: the men are drawn eight metres above the paving under them, so testing the
   * cursor's *ground* point against the footprint meant clicking the parapet crowd selected
   * nothing while clicking the grass below the wall — or the masonry itself — selected them
   * instantly. With the curtain garrisoned and about to become traversable that is a whole
   * tactical layer the player cannot reach.
   *
   * **One plane, and it is the same plane for everybody.** The two paths used to be kept
   * apart, on the reasoning that leaving the ground path on `groundX/groundZ` made ordinary
   * picking unchanged by construction. It did — including unchanged in the way it was
   * already wrong. The camera looks down at about 18 degrees at battle zoom, so a ray aimed
   * at a man's chest crosses the *terrain* 1.75/tan 18 = **5.4 m behind him**, which is
   * deeper than several units are: measured in the hand at zoom 0.42, the fraction of a
   * unit's own drawn crowd that selects it was **0 of 77 pixels** for a tower party, 22/77
   * for a ram crew, 22/66 for a ladder party and 39/77 for a line cohort. The unit card was
   * the only reliable handle, which is why every probe that clicked a card saw nothing wrong.
   *
   * `MAN_MID_Y` already existed to split exactly this error for elevated units; applying it
   * to everybody removes the special case rather than adding one, and `groundX/groundZ` —
   * which the marquee and the order point read — is not touched, so **where an order goes is
   * unchanged**. That is the half `01db41e` had to revert, and it is not what this moves.
   */
  private pickUnit(ctx: EngineContext): number {
    if (this.ptr.overUi) return -1;
    // Banners are tested first, and before `groundValid`: a plaque floats above the block
    // and is very often over sky or over a hillside behind the unit, where the cursor ray
    // never lands on the ground the unit is standing on.
    if (this.overBanner >= 0) return this.overBanner;
    // A few pixels of slack in world units keeps thin skirmish lines pickable when
    // zoomed out, without making close-up picking sloppy. The floor matters at close
    // zoom, where seven pixels is 13 cm and every click had to be dead on the block.
    const slack = Math.max(PICK_SLACK_M, Math.min(9, ctx.rig.metresPerPixel(ctx.viewH) * 7));
    let best = -1;
    let bestD = Infinity;
    for (const v of this.model.views) {
      if (v.destroyed) continue;
      // The level the men are standing on, mid-body. One expression, both cases — a unit on a
      // wall walk and a unit on grass differ only in which number goes into it.
      const standing = (v.standY - v.cy > ELEVATED_MIN_DY ? v.standY : v.cy) + MAN_MID_Y;
      if (!rayPlaneY(RAY, standing, PLANE_AT)) continue;
      const px = PLANE_AT.x;
      const pz = PLANE_AT.z;
      footprintOf(v.unit, v.def, FOOT);
      const d = distanceToFootprint(FOOT, px, pz);
      if (d > slack) continue;
      // Inside two footprints at once: prefer the nearer centre.
      const score = d + Math.hypot(v.cx - px, v.cz - pz) * 0.01;
      if (score < bestD) {
        bestD = score;
        best = v.id;
      }
    }
    return best;
  }

  // ---- Left button: selection ----

  private handleLeft(ctx: EngineContext): void {
    const p = ctx.input.pointer[0];

    if (p.pressed && !this.ptr.overUi) {
      this.boxValid = true;
      this.boxing = false;
    }

    if (this.boxValid && p.down) {
      if (!this.boxing && p.dragDist > DRAG_PX) this.boxing = true;
      if (this.boxing) this.drawMarquee(p.downX, p.downY, p.x, p.y);
    }

    if (p.released && this.boxValid) {
      if (this.boxing) {
        this.marquee.style.display = 'none';
        this.boxSelect(ctx, p.downX, p.downY, p.x, p.y);
      } else {
        this.clickSelect(ctx);
      }
      this.boxValid = false;
      this.boxing = false;
    }

    if (!p.down && this.boxing) {
      this.boxing = false;
      this.marquee.style.display = 'none';
    }
  }

  private drawMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const l = Math.min(x0, x1);
    const t = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    const s = this.marquee.style;
    if (s.display !== 'block') s.display = 'block';
    s.transform = `translate3d(${Math.round(l)}px, ${Math.round(t)}px, 0)`;
    s.width = `${Math.round(w)}px`;
    s.height = `${Math.round(h)}px`;
  }

  private clickSelect(ctx: EngineContext): void {
    const id = this.model.hoveredId;
    const now = ctx.time.elapsed;
    const additive = this.ptr.downShift || this.ptr.downCtrl;

    if (id < 0) {
      if (!additive) this.clear(ctx);
      return;
    }
    const v = this.model.view(id);
    if (!v || !v.own) {
      // Clicking the enemy inspects rather than selects; the selection is preserved
      // because losing your army to a stray click is the worst kind of surprise.
      return;
    }

    const isDouble = now - this.lastClickAt < DOUBLE_S && this.lastClickId === id;
    this.lastClickAt = now;
    this.lastClickId = id;

    if (isDouble) this.selectSameType(id, ctx);
    else if (additive) this.toggle(id, ctx);
    else this.selectOnly(id, ctx);
  }

  private boxSelect(ctx: EngineContext, x0: number, y0: number, x1: number, y1: number): void {
    const l = Math.min(x0, x1);
    const r = Math.max(x0, x1);
    const t = Math.min(y0, y1);
    const b = Math.max(y0, y1);
    const additive = this.ptr.downShift || this.ptr.downCtrl;
    const hits: number[] = additive ? this.model.selection.slice() : [];

    for (const v of this.model.views) {
      if (!v.own || v.destroyed) continue;
      footprintOf(v.unit, v.def, FOOT);
      let inside = false;
      // The men's own level, for the same reason `pickUnit` uses it: projecting the terrain
      // under a wall garrison puts its box eight metres below the crowd being dragged over.
      const y = (v.standY - v.cy > ELEVATED_MIN_DY ? v.standY : v.cy) + 1;
      // Centre first — the common case for a box thrown over a whole wing.
      projectPoint(ctx.camera, v.cx, y, v.cz, ctx.viewW, ctx.viewH, PROJECTED);
      if (PROJECTED.visible && PROJECTED.x >= l && PROJECTED.x <= r && PROJECTED.y >= t && PROJECTED.y <= b) {
        inside = true;
      }
      for (let c = 0; c < 4 && !inside; c++) {
        footprintCorner(FOOT, c, CORNER);
        projectPoint(ctx.camera, CORNER.x, y, CORNER.z, ctx.viewW, ctx.viewH, PROJECTED);
        if (PROJECTED.visible && PROJECTED.x >= l && PROJECTED.x <= r && PROJECTED.y >= t && PROJECTED.y <= b) {
          inside = true;
        }
      }
      if (inside && !hits.includes(v.id)) hits.push(v.id);
    }
    this.commit(hits, ctx);
  }

  // ---- Right button: orders ----

  /**
   * The right button belongs to the order system whenever something is selected.
   *
   * It used to refuse the gesture outright while alt was held, so that `issueDragOrder`'s
   * `running = ctx.input.alt || …` was unreachable on this path: the legend promised
   * "Alt + RMB — Run · free the camera" and only the camera half ever happened. Alt now means
   * run, which is the half the legend can actually keep, and the camera keeps the right button
   * whenever nothing is selected plus Q/E and the middle button at all times — so no view is
   * unreachable. The legend says exactly that now.
   */
  private handleRight(ctx: EngineContext, hovered: number): void {
    const p = ctx.input.pointer[2];
    const haveSelection = this.model.selection.length > 0;

    // The order point, not the ground point: a right-click on a siege tower must send men
    // to the tower, and it resolves even when the ray misses the heightfield entirely.
    if (p.pressed && !this.ptr.overUi && haveSelection) {
      if (this.orderValid) {
        this.dragging = true;
        this.dragStartX = this.orderX;
        this.dragStartZ = this.orderZ;
        this.dragEndX = this.orderX;
        this.dragEndZ = this.orderZ;
        /*
         * Modifiers first, then the target. `hostileUnder` reads `dragCtrl` — ctrl is what
         * turns a wall order over an enemy garrison into an attack on him — and reading it
         * before it has been seeded from the pointerdown snapshot answers the first frame of
         * every gesture with the *previous* gesture's value, which is `false`. Measured: the
         * order went out as `attackMove` (so `issueDragOrder` saw ctrl) while `dragTarget`
         * was −1 (so `hostileUnder` had not), on the same click.
         */
        this.dragCtrl = this.ptr.downCtrl;
        this.dragAlt = this.ptr.downAlt;
        this.dragShift = this.ptr.downShift;
        this.dragHostileId = this.hostileUnder(hovered);
      }
    }

    if (this.dragging) {
      // Hold the camera off the right button for the whole gesture.
      ctx.rig.suppressDrag = true;
      if (this.orderValid) {
        this.dragEndX = this.orderX;
        this.dragEndZ = this.orderZ;
      }
      this.dragCtrl = this.dragCtrl || ctx.input.ctrl;
      this.dragAlt = this.dragAlt || ctx.input.alt;
      this.dragShift = this.dragShift || ctx.input.shift;
      this.dragHostileId = this.hostileUnder(hovered);
      const wall = this.wallPoint();
      if (wall || (!this.deployment?.active && this.wallValid)) {
        // No ground ghost over the parapet: `Siege.garrison` packs a unit along the walkway
        // and the formation block a ghost draws is not what will be there. True of an order
        // in play for the same reason it is true of a deployment.
        this.ghosts.length = 0;
      } else {
        this.buildGhosts(ctx, p.dragDist);
        for (const g of this.ghosts) this.overlay.ghost(g);
      }

      const dep = this.deployment;
      if (dep?.active) {
        if (wall) this.showHint('Place on the wall', 'move');
        else if (!dep.contains(this.dragEndX, this.dragEndZ)) {
          this.showHint('Outside the deployment zone', 'attack');
        } else {
          const len = this.dragFrontage;
          const wide = this.ghosts.length ? this.ghosts[0].width : 0;
          this.showHint(
            len >= FRONTAGE_MIN_M
              ? `${Math.round(len)} m frontage · ${wide} per rank`
              : 'Place here',
            'move'
          );
        }
      } else if (this.dragHostileId >= 0) {
        const t = this.model.view(this.dragHostileId);
        this.showHint(`Attack ${t ? t.title : 'enemy'}`, 'attack');
      } else if (this.wallIntent()) {
        const over = this.garrisonPassedOver(hovered);
        const t = over >= 0 ? this.model.view(over) : null;
        // DOM text, so it costs no draw call — see the budget note in ARCHITECTURE §4.
        this.showHint(
          t ? `${WALL_HINT[this.wallIntent()!]} · Ctrl: attack ${t.title}`
            : WALL_HINT[this.wallIntent()!],
          'move'
        );
      } else {
        const len = this.dragFrontage;
        const wide = this.ghosts.length ? this.ghosts[0].width : 0;
        // The *achieved* span, not the drag length: past the depth clamp they part company,
        // and a readout that keeps counting up while the ghosts stop widening is a lie the
        // player can see. Prefixes tell them which order they are about to give.
        const verb = this.dragCtrl ? 'Attack move' : this.dragAlt || this.runByDefault ? 'Run' : 'Move';
        this.showHint(
          len >= FRONTAGE_MIN_M
            ? `${verb} · ${Math.round(this.ghostSpan)} m frontage · ${wide} per rank`
            : this.dragShift ? `Queue ${verb.toLowerCase()} order` : `${verb} here`,
          'move'
        );
      }
    } else {
      ctx.rig.suppressDrag = false;
      this.hideHint();
    }

    if (p.released && this.dragging) {
      this.dragging = false;
      ctx.rig.suppressDrag = false;
      this.issueDragOrder(ctx, p.dragDist);
      this.ghosts.length = 0;
      this.dragCtrl = false;
      this.dragAlt = false;
      this.dragShift = false;
      this.hideHint();
    }
  }

  /**
   * The enemy the cursor is on, or -1 — with one exception, and the exception is the wall.
   *
   * A garrison covers its own parapet, so from the field almost every pixel of an enemy
   * curtain has a defender behind it and almost every right-click on the wall was read as
   * "attack that unit". Measured on the storm of Carthage from the player's camera: the
   * cursor resolved the masonry correctly, `wallValid` was true, and the order that went out
   * was `attack` at unit 3. The intent is not in doubt — you cannot melee a man eight metres
   * above you — and it is the same intent the wall order carries, so the wall order wins.
   *
   * Only when the wall order is genuinely on offer (`wallIntent`), so nothing else about
   * attacking changes: an enemy in the open, in a gateway or on a siege tower is unaffected.
   *
   * **And that rule, left alone, made a garrison the one thing in the game a player could
   * not attack.** Measured on the storm of Carthage with a real mouse: the cursor over the
   * levy's own men read `attack`, `dragTarget` was −1, and the order that went out was
   * `move` to the parapet. The cursor promised one order and the product issued another,
   * which is worse than either answer on its own. Three ways out, and each is a case where
   * "the wall order" and "attack him" are not the same wish:
   *
   *  - **His banner.** A plaque floats clear of the masonry — the ray at that pixel never
   *    meets stone, so `wallValid` is already false there and the attack already went
   *    through. It is named here rather than left to fall out of the geometry, because a
   *    change to how banners are placed must not silently take the one working route away.
   *  - **Ctrl.** The deliberate override, and the modifier that already means *engage* on
   *    this button. Nothing is lost: `Siege.interceptOrders` treats `MoveTo` and
   *    `AttackMove` identically at a wall point, so ctrl+right-click on the parapet had no
   *    distinct meaning to take away.
   *  - **Both parties already on the same wall.** There is no "get up there" left to do, and
   *    the traverse the player would otherwise be given is still one click away on the stone
   *    beside him. `wallIntent() === 'traverse'` is exactly that state, so the two answers
   *    are decided by one predicate rather than by two that can drift apart.
   */
  private hostileUnder(hovered: number): number {
    if (hovered < 0) return -1;
    const v = this.model.view(hovered);
    if (!v || v.own || v.destroyed) return -1;
    if (!this.wallValid) return hovered;
    if (!this.wallProbe?.isGarrisoned(v.id)) return hovered;
    const intent = this.wallIntent();
    if (!intent) return hovered;
    if (this.overBanner === hovered) return hovered;
    if (this.ctrlHeld || this.dragCtrl) return hovered;
    if (intent === 'traverse') return hovered;
    return -1;
  }

  /**
   * The enemy a wall order is about to be given *over the top of*, or -1.
   *
   * Only for the readout. When this is non-negative the player is pointing at men and is
   * going to get an order about stone, so the hint says so and names the key that changes
   * it — which is the whole of the discoverability of the ctrl override.
   */
  private garrisonPassedOver(hovered: number): number {
    if (hovered < 0 || this.hostileUnder(hovered) >= 0) return -1;
    const v = this.model.view(hovered);
    return v && !v.own && !v.destroyed ? hovered : -1;
  }

  /**
   * The point on the player's own parapet the cursor is over, or null.
   *
   * Read off the *raw* solid hit rather than the order point — see `solidX`. Only ever
   * non-null during deployment, because in play a click on the wall already has a meaning
   * (`Siege.interceptOrders` turns a move order aimed at the parapet into a wall order, and
   * it wants the pushed-out point, not this one).
   */
  private wallPoint(): { x: number; z: number } | null {
    const dep = this.deployment;
    if (!dep?.active || !this.solidValid) return null;
    return dep.isWallPoint(this.solidX, this.solidZ)
      ? { x: this.solidX, z: this.solidZ }
      : null;
  }

  /**
   * Lay the selection out along the dragged line. Units keep their relative order so
   * nothing has to cross another unit's path, and each takes a share of the frontage
   * proportional to its natural width.
   */
  private buildGhosts(ctx: EngineContext, dragPx: number): void {
    this.ghosts.length = 0;
    this.ghostSpan = 0;
    const sel = this.model.selectedViews.filter((v) => !v.routing);
    if (sel.length === 0) return;

    const dx = this.dragEndX - this.dragStartX;
    const dz = this.dragEndZ - this.dragStartZ;
    const lineLen = Math.hypot(dx, dz);
    const hostile = this.dragHostileId >= 0;
    const detail = sel.length <= 3;

    if (dragPx < DRAG_PX || lineLen < FRONTAGE_MIN_M) {
      // Simple point order: keep each unit's current frontage, aim at the cursor.
      const cx = this.dragEndX;
      const cz = this.dragEndZ;
      // Spread several units into a shallow arc around the point rather than stacking.
      const gap = 2.5;
      let total = 0;
      for (const v of sel) total += v.frontage + gap;
      let t = -total * 0.5;
      const centroid = this.selectionCentroid(sel);
      const facing = Math.atan2(cx - centroid.x, cz - centroid.z);
      const rx = Math.cos(facing);
      const rz = -Math.sin(facing);
      for (const v of sel) {
        const seg = v.frontage + gap;
        const off = t + seg * 0.5;
        t += seg;
        this.ghosts.push({
          unit: v.unit,
          x: cx + rx * off,
          z: cz + rz * off,
          facing,
          width: v.unit.width,
          hostile,
          detail,
        });
      }
      this.ghostSpan = Math.max(0, total - gap);
      return;
    }

    const ux = dx / lineLen;
    const uz = dz / lineLen;
    // Facing is perpendicular to the line, pointing away from where the units stand.
    const centroid = this.selectionCentroid(sel);
    const midX = (this.dragStartX + this.dragEndX) * 0.5;
    const midZ = (this.dragStartZ + this.dragEndZ) * 0.5;
    let nx = uz;
    let nz = -ux;
    if (nx * (midX - centroid.x) + nz * (midZ - centroid.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const facing = Math.atan2(nx, nz);

    // Order the units along the line by their present position so ranks do not cross.
    const ordered = sel.slice().sort((a, b) => {
      const ta = (a.cx - this.dragStartX) * ux + (a.cz - this.dragStartZ) * uz;
      const tb = (b.cx - this.dragStartX) * ux + (b.cz - this.dragStartZ) * uz;
      return ta - tb;
    });

    const gap = 2.2;
    let natural = 0;
    for (const v of ordered) natural += v.frontage;
    const usable = Math.max(4, lineLen - gap * (ordered.length - 1));
    const scale = usable / Math.max(1, natural);

    let t = 0;
    let span = 0;
    for (const v of ordered) {
      const seg = Math.max(v.unit.spacingX * 2, v.frontage * scale);
      const centreT = t + seg * 0.5;
      t += seg + gap;
      /*
       * A frontage drag has a floor on depth, and it did not have one.
       *
       * A 180 m drag on a 320-man cohort set `width = 210` — one and a half ranks — and drew a
       * 181 m white thread that no formation of this period could stand in, let alone fight
       * from: a line two deep has no relief for the front rank and nothing to give when it is
       * charged. `MIN_RANKS` is the same number the roster's own `line` reaches at roughly
       * three times a cohort's natural frontage, so it clamps only the drags that were already
       * past anything a player could have meant.
       */
      const maxFiles = Math.max(1, Math.ceil(v.alive / MIN_RANKS));
      const width = Math.max(1, Math.min(v.alive, maxFiles, Math.round(seg / v.unit.spacingX)));
      span += width * v.unit.spacingX + gap;
      this.ghosts.push({
        unit: v.unit,
        x: this.dragStartX + ux * centreT,
        z: this.dragStartZ + uz * centreT,
        facing,
        width,
        hostile,
        detail,
      });
    }
    this.ghostSpan = Math.max(0, span - gap);
  }

  private selectionCentroid(sel: UnitView[]): { x: number; z: number } {
    let x = 0;
    let z = 0;
    for (const v of sel) {
      x += v.cx;
      z += v.cz;
    }
    return { x: x / sel.length, z: z / sel.length };
  }

  /**
   * Stand the selection where the drag says, instead of ordering it to march there.
   *
   * The gesture is the one the player already knows and the geometry is the one
   * `buildGhosts` already computed, so what the ghost previewed is exactly what appears —
   * position, facing and men per rank. A drop on the parapet skips the ghost geometry
   * entirely and hands the point to the garrison layout, which owns rank count and height.
   */
  private placeSelection(ctx: EngineContext, dragPx: number): void {
    const dep = this.deployment;
    if (!dep) return;
    const sel = this.model.selectedViews.filter((v) => !v.destroyed);
    if (sel.length === 0) return;

    /**
     * Keep hold of anything the placement rebuilt.
     *
     * Taking a garrison off the wall retires the unit and stands a new one on the grass —
     * there is no public way to un-garrison in place — and without this the player's
     * selection would simply empty as the unit they were dragging ceased to exist.
     */
    const rebuilt = new Map<number, number>();
    const note = (): void => {
      const r = dep.lastReplacement;
      if (r) rebuilt.set(r.from, r.to);
    };

    const wall = this.wallPoint();
    if (wall) {
      // Every unit is offered the same station; `Siege.freeWindow` gives each the next free
      // stretch of walkway rather than stacking them, so a whole wing can be dropped at once.
      for (const v of sel) {
        dep.place(v.id, wall.x, wall.z, 0);
        note();
      }
    } else {
      this.buildGhosts(ctx, dragPx);
      for (const g of this.ghosts) {
        dep.place(g.unit.id, g.x, g.z, g.facing, g.width);
        note();
      }
    }
    if (rebuilt.size > 0) {
      this.commit(this.model.selection.map((id) => rebuilt.get(id) ?? id), ctx);
    }
  }

  private issueDragOrder(ctx: EngineContext, dragPx: number): void {
    if (this.deployment?.active) {
      this.placeSelection(ctx, dragPx);
      return;
    }
    const sel = this.model.selectedViews.filter((v) => !v.routing);
    if (sel.length === 0) return;
    // `dragShift`/`dragAlt`/`dragCtrl`, not `ctx.input.*`: see the note on those fields. The
    // live state is folded in there every frame of the gesture, so this is strictly a
    // superset of what reading the input here would have seen.
    const queued = this.dragShift || ctx.input.shift;
    const running = this.dragAlt || ctx.input.alt || this.runByDefault;
    const attackMove = this.dragCtrl || ctx.input.ctrl;

    // Attacking a specific unit overrides any frontage the drag implied.
    if (this.dragHostileId >= 0 && dragPx < DRAG_PX * 3) {
      ctx.events.emit('orderIssued', {
        unitIds: sel.map((v) => v.id),
        kind: 'attack',
        targetUnitId: this.dragHostileId,
      });
      return;
    }

    /*
     * A click on the parapet carries the parapet, not the ground beside it.
     *
     * This is the whole of the destination half. `Siege.interceptOrders` subscribes to
     * `orderIssued` precisely because the event "is the only place the clicked point survives
     * intact", and then asks `wallTargetAt(o.x, o.z)` — so an order that has already been
     * pushed `SOLID_STANDOFF` clear of the curtain's face answers about grass and the wall
     * order is never recognised. Sending the raw hit is the one change that closes it; every
     * decision after this point is the sim's, including the rule that a besieger at the foot
     * of the outer face does not get to walk up the defenders' stairs.
     *
     * No frontage and no facing: `Siege` packs a garrison along the walkway itself, four or
     * five ranks deep at the bay's own `walkY`, and a width from a ground drag would be
     * overwritten by that layout anyway. `queued` is dropped for the same reason `Siege`
     * ignores queued orders — a waypoint appended to a march is not a decision about the wall.
     */
    if (this.wallValid && !queued) {
      ctx.events.emit('orderIssued', {
        unitIds: sel.map((v) => v.id),
        kind: attackMove ? 'attackMove' : 'move',
        x: this.wallX,
        z: this.wallZ,
        running,
      });
      return;
    }

    this.buildGhosts(ctx, dragPx);
    for (const g of this.ghosts) {
      // `orderIssued.width` is the contract for a frontage order, but
      // `BattleSystem.applyOrder` does not read it yet, so the width is also written
      // through until it does. `width` is only consumed by the formation slot layout, so
      // the duplicate cannot desynchronise anything; delete the assignment, not the
      // event field, once the sim honours it.
      if (g.width !== g.unit.width) g.unit.width = g.width;
      ctx.events.emit('orderIssued', {
        unitIds: [g.unit.id],
        kind: attackMove ? 'attackMove' : 'move',
        x: g.x,
        z: g.z,
        facing: g.facing,
        width: g.width,
        queued,
        running,
      });
    }
  }

  // ---- Keyboard ----

  private handleKeys(ctx: EngineContext): void {
    const input = ctx.input;
    if (input.keyPressed('Escape')) this.clear(ctx);
    if (input.keyPressed('KeyF')) this.selectArmy(ctx);
    if (input.keyPressed('KeyH')) this.issueHalt(ctx);
    /*
     * R has to reach units that are already marching, not just arm the next order.
     *
     * This flipped `runByDefault` and stopped, and that latch is only read when a move
     * order is built — so pressing R while a unit walked across the field changed nothing
     * the player could see, which is exactly the complaint. Measured sim-side, a marching
     * unit went 1.55 -> 3.383 m/s once the order was actually issued.
     *
     * Routing units are excluded: a rout already runs, and overriding its gait would let
     * the player countermand a morale state through a movement key.
     */
    if (input.keyPressed('KeyR')) {
      this.runByDefault = !this.runByDefault;
      const ids = this.model.selectedViews.filter((v) => !v.routing).map((v) => v.id);
      if (ids.length) {
        ctx.events.emit('orderIssued', { unitIds: ids, kind: 'gait', running: this.runByDefault });
      }
    }
    if (input.keyPressed('Tab')) this.cycle(ctx);
    if (this.deployment?.active
      && (input.keyPressed('Delete') || input.keyPressed('Backspace'))) {
      this.removeSelected(ctx);
    }

    const sel = this.model.selectedViews;
    if (sel.length === 0) return;

    const formations = this.commonFormations(sel);
    const fKeys = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'];
    for (let i = 0; i < formations.length && i < fKeys.length; i++) {
      if (input.keyPressed(fKeys[i])) this.issueFormation(formations[i], ctx);
    }
    const abilities = this.commonAbilities(sel);
    const aKeys = ['KeyG', 'KeyT', 'KeyY'];
    for (let i = 0; i < abilities.length && i < aKeys.length; i++) {
      if (input.keyPressed(aKeys[i])) this.issueAbility(abilities[i], ctx);
    }
  }

  /**
   * Formations every selected unit can adopt, in roster order.
   *
   * Ids that are also one of the unit's *abilities* are excluded. `testudo` is listed in
   * both lists in the roster, and `AbilitySystem` owns it: it sets the formation on
   * activation, holds it for the ability's duration and restores the previous one on
   * expiry, along with the missile resistance and melee penalty that make the tortoise
   * mean anything. A formation button for the same id issued the change without any of
   * that and was silently undone — two controls for one thing, one of them a lie.
   */
  commonFormations(sel: UnitView[]): string[] {
    if (sel.length === 0) return [];
    const out: string[] = [];
    for (const id of sel[0].def.formations) {
      if (sel.some((v) => v.def.abilities.includes(id))) continue;
      if (sel.every((v) => v.def.formations.includes(id))) out.push(id);
    }
    return out;
  }

  /** Union of the selection's abilities — a mixed selection still shows every option. */
  commonAbilities(sel: UnitView[]): string[] {
    const out: string[] = [];
    for (const v of sel) {
      for (const a of v.def.abilities) if (!out.includes(a)) out.push(a);
    }
    return out;
  }

  private cycle(ctx: EngineContext): void {
    const own = this.model.views.filter((v) => v.own && !v.destroyed);
    if (own.length === 0) return;
    const cur = this.model.selection.length === 1 ? this.model.selection[0] : -1;
    const at = own.findIndex((v) => v.id === cur);
    const next = own[(at + 1) % own.length];
    this.commit([next.id], ctx);
  }

  // ---- Cursor ----

  private updateCursor(hovered: number): void {
    let c: CursorKind = 'default';
    if (this.boxing) c = 'select';
    else if (this.ptr.overUi) c = 'default';
    else {
      const v = hovered >= 0 ? this.model.view(hovered) : undefined;
      const haveSel = this.model.selection.length > 0;
      /*
       * Asked of the order path itself, not re-derived from `v.own`.
       *
       * The glyph used to read `attack` for any enemy under the cursor while `hostileUnder`
       * was quietly refusing the same unit because a wall order outranked it, so the cursor
       * advertised an attack and a move went out. One function decides, both read it.
       */
      const hostile = haveSel ? this.hostileUnder(hovered) : -1;
      /*
       * A parapet under the cursor outranks "friend", and that ordering is deliberate.
       *
       * Measured over a column of screen samples down a bay: seven of the eight rows that are
       * genuinely on the walk also have the garrison's own footprint under them — now that the
       * garrison is pickable at all — so "friend" would win on almost every pixel of the wall
       * and the player would never see the wall cursor. Selecting a friendly unit is already
       * announced by its own hover box and by its banner lighting up; whether a right-click
       * will send men *up* or leave them at the foot is announced by nothing else, and it is
       * the thing the owner said the cursor fails to tell them. A hostile unit still wins
       * outright: attacking is never the surprising reading.
       */
      if (hostile >= 0) c = 'attack';
      else if (haveSel && this.wallValid && this.wallIntent()) c = 'wall';
      else if (v && !v.own) c = haveSel ? 'attack' : 'default';
      else if (v && v.own) c = 'friend';
      else if (haveSel && this.orderValid) c = 'move';
    }
    if (c !== this.cursor) {
      this.cursor = c;
      document.body.dataset.cur = c;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /** True while a right-drag order is in progress; the HUD dims to keep the field clear. */
  get ordering(): boolean {
    return this.dragging;
  }

  /** Frontage in metres the current drag would produce, for the readout. */
  get dragFrontage(): number {
    if (!this.dragging) return 0;
    return Math.hypot(this.dragEndX - this.dragStartX, this.dragEndZ - this.dragStartZ);
  }

  /** Enemy unit the current drag would attack, or -1. */
  get dragTarget(): number {
    return this.dragging ? this.dragHostileId : -1;
  }

  /** Order-path overlay for everything with somewhere to be. */
  drawOrderPaths(): void {
    for (const v of this.model.selectedViews) {
      if (v.destroyed) continue;
      let hostile: { x: number; z: number } | null = null;
      if (v.unit.order === UnitOrder.AttackUnit) {
        const t = this.model.view(v.unit.targetUnitId);
        if (t && !t.destroyed) hostile = { x: t.cx, z: t.cz };
      }
      if (v.unit.order === UnitOrder.Hold && v.unit.waypoints.length === 0 && !hostile) continue;
      this.overlay.orderPath(v, hostile);
    }
  }

  /** True when the player faction still has anything left to command. */
  get playerAlive(): boolean {
    return this.model.unitsLeft[PLAYER_FACTION] > 0;
  }

  static readonly playerFaction: Faction = PLAYER_FACTION;
}
