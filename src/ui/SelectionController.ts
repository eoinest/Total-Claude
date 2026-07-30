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
 *   ctrl + right          attack-move
 *
 * The camera also wants the right button for yaw, so the rule is: with something
 * selected the right button belongs to the order system (`rig.suppressDrag` holds the
 * camera off); with an empty selection, or with alt held, it belongs to the camera.
 */

import type { EngineContext } from '../core/Engine';
import { Faction, UnitOrder } from '../sim/types';
import { el } from './dom';
import type { HudModel, UnitView } from './model';
import {
  distanceToFootprint, footprintCorner, footprintOf, projectPoint, screenToGround,
  type Footprint, type Projected,
} from './picking';
import type { PointerTracker } from './pointer';
import { PLAYER_FACTION } from './theme';
import type { GhostSpec, WorldOverlay } from './WorldOverlay';

export type CursorKind = 'default' | 'move' | 'attack' | 'friend' | 'select';

/** Pixels of pointer travel before a click becomes a drag. */
const DRAG_PX = 7;
/** Seconds between two clicks that still count as a double-click. */
const DOUBLE_S = 0.34;
/** Minimum world metres of right-drag before it is read as a frontage command. */
const FRONTAGE_MIN_M = 6;

const FOOT: Footprint = { cx: 0, cz: 0, halfW: 1, halfD: 1, cos: 1, sin: 0 };
const PROJECTED: Projected = { x: 0, y: 0, distance: 0, visible: false };
const GROUND = { x: 0, y: 0, z: 0 };
const CORNER = { x: 0, z: 0 };

export class SelectionController {
  cursor: CursorKind = 'default';
  /** Move orders run by default while this is on (toggled with R). */
  runByDefault = false;
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

  /** World point under the cursor this frame, valid when `groundValid`. */
  groundX = 0;
  groundZ = 0;
  groundValid = false;

  constructor(
    private model: HudModel,
    private overlay: WorldOverlay,
    private ptr: PointerTracker
  ) {}

  /**
   * The ability system owns activation and duration; the HUD only mirrors it. Cooldowns
   * are still timed here because nothing publishes them yet.
   */
  attachEvents(ctx: EngineContext): void {
    this.offs.push(
      ctx.events.on('abilityActivated', (e) => {
        const key = `${e.unitId}:${e.ability}`;
        if (e.active) this.active.add(key);
        else this.active.delete(key);
        this.cooldowns.set(key, ctx.time.simTime + this.abilityCooldown(e.ability));
      })
    );
    this.offs.push(
      ctx.events.on('abilityExpired', (e) => {
        this.active.delete(`${e.unitId}:${e.ability}`);
      })
    );
  }

  isAbilityActive(unitId: number, ability: string): boolean {
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

  issueHalt(ctx: EngineContext): void {
    const ids = this.orderIds();
    if (ids.length) ctx.events.emit('orderIssued', { unitIds: ids, kind: 'halt' });
  }

  issueFormation(id: string, ctx: EngineContext): void {
    const ids = this.model.selectedViews
      .filter((v) => !v.routing && v.def.formations.includes(id))
      .map((v) => v.id);
    if (ids.length) ctx.events.emit('orderIssued', { unitIds: ids, kind: 'formation', formation: id });
  }

  issueAbility(id: string, ctx: EngineContext): void {
    const now = ctx.time.simTime;
    const ids: number[] = [];
    for (const v of this.model.selectedViews) {
      if (!v.def.abilities.includes(id)) continue;
      if (this.cooldownLeft(v.id, id, now) > 0) continue;
      ids.push(v.id);
    }
    if (!ids.length) return;
    ctx.events.emit('orderIssued', { unitIds: ids, kind: 'ability', ability: id });
    for (const uid of ids) this.cooldowns.set(`${uid}:${id}`, now + this.abilityCooldown(id));
  }

  private abilityCooldown(id: string): number {
    // Kept here rather than in the roster: cooldowns are a UI affordance until the
    // ability system lands and can own them.
    switch (id) {
      case 'inspire': return 70;
      case 'arrow-storm': return 90;
      case 'frenzy': return 80;
      case 'warcry': return 54;
      case 'charge': return 46;
      case 'pilum-volley':
      case 'framea-volley': return 32;
      case 'testudo': return 26;
      default: return 14;
    }
  }

  cooldownLeft(unitId: number, ability: string, now: number): number {
    const t = this.cooldowns.get(`${unitId}:${ability}`);
    return t === undefined ? 0 : Math.max(0, t - now);
  }

  cooldownFrac(unitId: number, ability: string, now: number): number {
    const left = this.cooldownLeft(unitId, ability, now);
    if (left <= 0) return 0;
    return Math.min(1, left / this.abilityCooldown(ability));
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(ctx: EngineContext, heightAt: (x: number, z: number) => number): void {
    const input = ctx.input;
    input.uiCapture = this.ptr.overUi;

    this.updateGround(ctx, heightAt);
    const hovered = this.pickUnit(ctx);
    if (!this.ptr.overUi) this.model.hoveredId = hovered;

    this.handleLeft(ctx);
    this.handleRight(ctx, hovered);
    this.handleKeys(ctx);
    this.updateCursor(hovered);
  }

  private updateGround(ctx: EngineContext, heightAt: (x: number, z: number) => number): void {
    const nx = (this.ptr.x / Math.max(1, ctx.viewW)) * 2 - 1;
    const ny = -(this.ptr.y / Math.max(1, ctx.viewH)) * 2 + 1;
    this.groundValid = screenToGround(ctx.camera, nx, ny, heightAt, GROUND);
    if (this.groundValid) {
      this.groundX = GROUND.x;
      this.groundZ = GROUND.z;
    }
  }

  /** Nearest unit whose formation footprint contains the cursor, or -1. */
  private pickUnit(ctx: EngineContext): number {
    if (!this.groundValid || this.ptr.overUi) return -1;
    // A few pixels of slack in world units keeps thin skirmish lines pickable when
    // zoomed out, without making close-up picking sloppy.
    const slack = Math.min(9, ctx.rig.metresPerPixel(ctx.viewH) * 7);
    let best = -1;
    let bestD = Infinity;
    for (const v of this.model.views) {
      if (v.destroyed) continue;
      footprintOf(v.unit, v.def, FOOT);
      const d = distanceToFootprint(FOOT, this.groundX, this.groundZ);
      if (d > slack) continue;
      // Inside two footprints at once: prefer the nearer centre.
      const score = d + Math.hypot(v.cx - this.groundX, v.cz - this.groundZ) * 0.01;
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
      // Centre first — the common case for a box thrown over a whole wing.
      projectPoint(ctx.camera, v.cx, v.cy + 1, v.cz, ctx.viewW, ctx.viewH, PROJECTED);
      if (PROJECTED.visible && PROJECTED.x >= l && PROJECTED.x <= r && PROJECTED.y >= t && PROJECTED.y <= b) {
        inside = true;
      }
      for (let c = 0; c < 4 && !inside; c++) {
        footprintCorner(FOOT, c, CORNER);
        projectPoint(ctx.camera, CORNER.x, v.cy + 1, CORNER.z, ctx.viewW, ctx.viewH, PROJECTED);
        if (PROJECTED.visible && PROJECTED.x >= l && PROJECTED.x <= r && PROJECTED.y >= t && PROJECTED.y <= b) {
          inside = true;
        }
      }
      if (inside && !hits.includes(v.id)) hits.push(v.id);
    }
    this.commit(hits, ctx);
  }

  // ---- Right button: orders ----

  private handleRight(ctx: EngineContext, hovered: number): void {
    const p = ctx.input.pointer[2];
    const haveSelection = this.model.selection.length > 0;

    if (p.pressed && !this.ptr.overUi && haveSelection && !this.ptr.downAlt) {
      if (this.groundValid) {
        this.dragging = true;
        this.dragStartX = this.groundX;
        this.dragStartZ = this.groundZ;
        this.dragEndX = this.groundX;
        this.dragEndZ = this.groundZ;
        this.dragHostileId = this.hostileUnder(hovered);
      }
    }

    if (this.dragging) {
      // Hold the camera off the right button for the whole gesture.
      ctx.rig.suppressDrag = true;
      if (this.groundValid) {
        this.dragEndX = this.groundX;
        this.dragEndZ = this.groundZ;
      }
      this.dragHostileId = this.hostileUnder(hovered);
      this.buildGhosts(ctx, p.dragDist);
      for (const g of this.ghosts) this.overlay.ghost(g);

      if (this.dragHostileId >= 0) {
        const t = this.model.view(this.dragHostileId);
        this.showHint(`Attack ${t ? t.title : 'enemy'}`, 'attack');
      } else {
        const len = this.dragFrontage;
        const wide = this.ghosts.length ? this.ghosts[0].width : 0;
        this.showHint(
          len >= FRONTAGE_MIN_M
            ? `${Math.round(len)} m frontage · ${wide} per rank`
            : this.ptr.shift ? 'Queue move order' : 'Move here',
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
      this.hideHint();
    }
  }

  private hostileUnder(hovered: number): number {
    if (hovered < 0) return -1;
    const v = this.model.view(hovered);
    return v && !v.own && !v.destroyed ? hovered : -1;
  }

  /**
   * Lay the selection out along the dragged line. Units keep their relative order so
   * nothing has to cross another unit's path, and each takes a share of the frontage
   * proportional to its natural width.
   */
  private buildGhosts(ctx: EngineContext, dragPx: number): void {
    this.ghosts.length = 0;
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
    for (const v of ordered) {
      const seg = Math.max(v.unit.spacingX * 2, v.frontage * scale);
      const centreT = t + seg * 0.5;
      t += seg + gap;
      const width = Math.max(1, Math.min(v.alive, Math.round(seg / v.unit.spacingX)));
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

  private issueDragOrder(ctx: EngineContext, dragPx: number): void {
    const sel = this.model.selectedViews.filter((v) => !v.routing);
    if (sel.length === 0) return;
    const queued = this.ptr.shift;
    const running = this.ptr.alt || this.runByDefault;
    const attackMove = this.ptr.ctrl;

    // Attacking a specific unit overrides any frontage the drag implied.
    if (this.dragHostileId >= 0 && dragPx < DRAG_PX * 3) {
      ctx.events.emit('orderIssued', {
        unitIds: sel.map((v) => v.id),
        kind: 'attack',
        targetUnitId: this.dragHostileId,
      });
      return;
    }

    this.buildGhosts(ctx, dragPx);
    for (const g of this.ghosts) {
      const u = g.unit;
      // The sim has no frontage field on `orderIssued` yet, so the width the drag
      // implied is written straight onto the unit. `width` is only read by the
      // formation slot layout, so this cannot desynchronise anything.
      if (g.width !== u.width) u.width = g.width;
      ctx.events.emit('orderIssued', {
        unitIds: [u.id],
        kind: attackMove ? 'attackMove' : 'move',
        x: g.x,
        z: g.z,
        facing: g.facing,
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
    if (input.keyPressed('KeyR')) this.runByDefault = !this.runByDefault;
    if (input.keyPressed('Tab')) this.cycle(ctx);

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

  /** Formations every selected unit can adopt, in roster order. */
  commonFormations(sel: UnitView[]): string[] {
    if (sel.length === 0) return [];
    const out: string[] = [];
    for (const id of sel[0].def.formations) {
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
      if (v && !v.own) c = this.model.selection.length > 0 ? 'attack' : 'default';
      else if (v && v.own) c = 'friend';
      else if (this.model.selection.length > 0 && this.groundValid) c = 'move';
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
