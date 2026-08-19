/**
 * Player command of the siege train — the half of the mechanic the player could reach.
 *
 * The owner asked for two things: *"selecting where siege towers go"* and *"making the
 * battering ram go wherever you want"*. The tower half already existed in `Siege` and was
 * measured working; what did not exist was any way for somebody who has not read the code to
 * find it. Hovering the bay you are about to send fifteen tonnes of green timber at produced
 * the same "storm the wall" cursor a cohort of the line gets, a refused order produced
 * nothing whatsoever, and the machine's own destination was drawn nowhere. An order you
 * cannot see the result of is indistinguishable from an order that was not obeyed.
 *
 * ## Why this is its own file and not a patch to `SelectionController`
 *
 * Two reasons, one of them structural. `SelectionController` is a thousand-line file owned by
 * another workstream this session, and a machine order is not a variation on a move order —
 * it is a different verb with different refusals, a different marker and a different unit of
 * commitment. Folding it into `wallIntent()` would put "roll the tower to bay 1066" into an
 * enum whose other members are all things a man does with his legs.
 *
 * Nothing here duplicates the gesture. The right button is read straight off
 * `ctx.input.pointer[2].released`, the cursor's world point is read off the fields
 * `SelectionController` already publishes for exactly this purpose (`wallX/wallZ`,
 * `solidX/solidZ`, `orderX/orderZ`), and the marker goes into the same two batched meshes as
 * every other overlay — so this costs **no draw call**, no second unproject and no second
 * pick.
 *
 * ## Why the sim is asked rather than told
 *
 * `Siege.machineOrderAt` is pure and `Siege.requestMachineOrder` queues. The first is what
 * this file draws; the second is what the click does; and both go through
 * `Siege.resolveMachineOrder` and nothing else. **One predicate, shared** — the trap this
 * project has now paid for three times is a preview computed one way and an action computed
 * another, and each time it shipped as a control that looked like it worked.
 *
 * The queue matters too. A mouse event arrives in `update`, at whatever rate the frame is
 * running; every mutation of the battle has to happen inside `fixedUpdate` or it stops
 * replaying identically. And it is deliberately *not* wired to `orderIssued`: `src/ai/Orders.ts`
 * emits that event through the same channel the mouse does, so a machine verb hung off it is
 * a verb the AI fires as well, and an AI that drags the ram off the gate every few seconds is
 * worse than no order at all.
 */

import type { EngineContext } from '../core/Engine';
import { el } from './dom';
import type { HudModel } from './model';
import type { PointerTracker } from './pointer';
import type { WorldOverlay } from './WorldOverlay';

/**
 * What `Siege` has to publish for any of this to run.
 *
 * Duck-typed and installed by `HudSystem`, like `wallProbe` and `abilityProbe`. A field
 * battle registers no siege system, this stays null, and the whole file is inert.
 */
export interface SiegeCommandProbe {
  machineOrderAt(unitId: number, x: number, z: number): MachineOrderView | null;
  machineDestinationOf(unitId: number): MachineOrderView | null;
  requestMachineOrder(unitId: number, x: number, z: number): void;
  /** Whether a storm order here would be obeyed, for a unit that crews nothing. */
  escaladeOfferAt(unitId: number, x: number, z: number): EscaladeOfferView;
}

/** The structural view of what `Siege.escaladeOfferAt` answers. */
export interface EscaladeOfferView {
  ok: boolean;
  refusal: string;
  kind: 'tower' | 'ladder' | null;
  bay: number;
}

/** The structural view of `Siege.SiegeMachineOrder` this file needs. */
export interface MachineOrderView {
  kind: 'tower' | 'ram' | 'greatRam';
  machineId: number;
  unitId: number;
  ok: boolean;
  refusal: string;
  x: number;
  z: number;
  y: number;
  station: number;
  bay: number;
  gateId: string;
  distance: number;
  /** Seconds the machine will take to get there, heave included. */
  seconds: number;
}

/** What the machine is called in a sentence addressed to the player. */
const MACHINE_NAME: Record<MachineOrderView['kind'], string> = {
  tower: 'siege tower',
  ram: 'ram',
  greatRam: 'great ram',
};

/**
 * Half-frontage of each machine, metres, for sizing the berth marker.
 *
 * Named constants rather than an import of `sim/siegeGeometry`: the UI taking a build
 * dependency on the simulation's geometry module for three numbers is worse than three
 * numbers checked by a probe, and `SelectionController.SIEGE_TOWER_HALF` already makes
 * exactly this trade for the same reason.
 */
const BERTH_HALF: Record<MachineOrderView['kind'], number> = {
  tower: 2.1,
  ram: 2.0,
  greatRam: 3.4,
};

/**
 * Seconds the confirmation of a click stays on screen after the click.
 *
 * The hover hint answers "what will this do"; this answers "what did that do", and they are
 * different questions with different lifetimes. Two and a half seconds is long enough to
 * read a nine-word sentence and short enough that it is gone before the machine has moved
 * far enough to make it stale.
 */
const FLASH_S = 2.5;

/**
 * Pixels of travel with the right button down before the gesture is a drag, not a click.
 *
 * The same seven `SelectionController.DRAG_PX` uses. Duplicated rather than exported for the
 * same reason `SIEGE_TOWER_HALF` is duplicated there: one number is cheaper than a build
 * dependency between two files two workstreams are editing at once, and the arm above
 * measures the resulting behaviour rather than the constant.
 */
const DRAG_PX = 7;

export class SiegeOrders {
  /** Installed by `HudSystem` when the battle has a siege system. Null otherwise. */
  probe: SiegeCommandProbe | null = null;

  private hint!: HTMLElement;
  /** The sentence shown after a click, and when it expires. */
  private flash = '';
  private flashOk = true;
  private flashUntil = -1;
  /** Set on the frame an order is sent, so the probe can assert a click did something. */
  lastOrder: MachineOrderView | null = null;
  /** What the cursor is currently offering, for the probe and for the hint. */
  preview: MachineOrderView | null = null;
  /** Cursor position when the right button went down. See the drag guard in `update`. */
  private downX = 0;
  private downY = 0;

  constructor(
    private model: HudModel,
    private overlay: WorldOverlay,
    private ptr: PointerTracker
  ) {}

  attach(root: HTMLElement): void {
    this.hint = el('div', 'siege-hint', root);
    this.hint.style.display = 'none';
  }

  /**
   * Every selected unit that is working a machine, with what that machine is doing.
   *
   * Ordered by unit id, because two towers under one selection must produce the same hint
   * on every frame and on every replay.
   */
  private crews(): { unitId: number; dest: MachineOrderView }[] {
    const probe = this.probe;
    const out: { unitId: number; dest: MachineOrderView }[] = [];
    if (!probe) return out;
    for (const v of this.model.selectedViews) {
      if (!v.own || v.destroyed) continue;
      const dest = probe.machineDestinationOf(v.id);
      if (dest) out.push({ unitId: v.id, dest });
    }
    out.sort((a, b) => a.unitId - b.unitId);
    return out;
  }

  /**
   * The point the cursor is aiming at, in the order the questions have to be asked.
   *
   * The parapet first, because a tower is aimed at a *bay* and `wallX/wallZ` is the only one
   * of the three that survives the trip: `orderX/orderZ` is pushed a body radius clear of
   * whatever solid it lands on, which for a wall is the grass beside it and for a gate is the
   * road in front of it. The raw solid hit second, because a gate is a lump of masonry the
   * ray lands on and there is no parapet over a gatehouse. The ground last.
   */
  private aim(c: CursorPoints): { x: number; z: number } | null {
    if (c.wallValid) return { x: c.wallX, z: c.wallZ };
    if (c.solidValid) return { x: c.solidX, z: c.solidZ };
    if (c.orderValid) return { x: c.orderX, z: c.orderZ };
    return null;
  }

  /**
   * One frame of hover, marker and — on the release of the right button — order.
   *
   * Called from `HudSystem.update` between `overlay.begin()` and `overlay.end()`, after
   * `SelectionController.update` has resolved the cursor for this frame. Order matters: the
   * points read below are written by that call.
   */
  update(ctx: EngineContext, cursor: CursorPoints): void {
    this.lastOrder = null;
    this.preview = null;
    this.stormRefusal = '';
    const probe = this.probe;
    const crews = this.crews();
    if (!probe || crews.length === 0) {
      this.stormWarning(ctx, cursor);
      return;
    }

    /*
     * Where each machine is already bound, drawn whether or not the cursor is over anything.
     *
     * This is the "can you tell you have" half of the ask. A player who sends a tower down
     * the wall and then looks at something else has to be able to look back and still see
     * where it is going — the machine takes four minutes to get there and moves 0.42 m/s, so
     * for most of that time it does not visibly appear to be doing anything at all.
     */
    for (const c of crews) {
      const d = c.dest;
      const from = this.machineAt(d);
      if (!from) continue;
      if (Math.hypot(d.x - from.x, d.z - from.z) < 0.6) continue;
      this.overlay.machineTarget(from.x, from.z, d.x, d.z, d.y,
        BERTH_HALF[d.kind], true, false);
    }

    const at = this.ptr.overUi ? null : this.aim(cursor);
    // The first crew in the selection decides the sentence. A mixed selection still issues
    // to every machine in it — the loop below — but two hints stacked on one cursor is worse
    // than one hint that names the majority verb, which is the rule `wallIntent` uses.
    const lead = at ? probe.machineOrderAt(crews[0].unitId, at.x, at.z) : null;
    this.preview = lead;

    if (lead && at) {
      const from = this.machineAt(lead);
      if (from) {
        this.overlay.machineTarget(from.x, from.z, lead.x, lead.z, lead.y,
          BERTH_HALF[lead.kind], lead.ok, lead.station >= 0);
      }
    }

    // ---- the click ----
    /*
     * A right *drag* is a frontage command, not a machine order.
     *
     * `ctx.input.pointer[2].released` fires at the end of a drag as well as after a click,
     * and `SelectionController` has always drawn the line at seven pixels of travel: under
     * that it is a click that means "go here", over it the drag length is a frontage and the
     * direction is a facing. A tower party is still a body of men and a player is entitled to
     * dress it, so the same threshold is applied here rather than a second rule — and it is
     * latched from this file's own pointer samples so no state is read out of a class another
     * workstream owns.
     */
    const btn = ctx.input.pointer[2];
    if (btn.pressed) { this.downX = this.ptr.x; this.downY = this.ptr.y; }
    const travelled = Math.hypot(this.ptr.x - this.downX, this.ptr.y - this.downY);
    const released = btn.released && travelled <= DRAG_PX;
    if (released && at && !this.ptr.overUi) {
      let sent = 0;
      let refused: MachineOrderView | null = null;
      for (const c of crews) {
        const o = probe.machineOrderAt(c.unitId, at.x, at.z);
        if (!o) continue;
        if (o.ok) {
          probe.requestMachineOrder(c.unitId, at.x, at.z);
          this.lastOrder = o;
          sent++;
        } else if (!refused) {
          refused = o;
        }
      }
      if (sent > 0 && this.lastOrder) {
        this.flash = this.sentence(this.lastOrder, sent > 1 ? sent : 0);
        this.flashOk = true;
        this.flashUntil = ctx.time.elapsed + FLASH_S;
      } else if (refused) {
        this.flash = this.sentence(refused, 0);
        this.flashOk = false;
        this.flashUntil = ctx.time.elapsed + FLASH_S;
      }
    }

    // ---- the hint ----
    if (ctx.time.elapsed < this.flashUntil) this.showHint(this.flash, this.flashOk);
    else if (lead) this.showHint(this.sentence(lead, 0), lead.ok);
    else this.hideHint(ctx);
    this.setCursor(lead && lead.ok ? 'machine' : lead ? 'refuse' : '');
  }

  /** Why a storm order here would be dropped, when it would be. */
  private stormRefusal = '';

  /**
   * The other half of the promise: a cohort offered a storm at a bay with nothing to climb.
   *
   * `SelectionController` puts "Storm the wall here" under the cursor for any unit standing
   * outside somebody else's curtain, and `Siege.escalade` then drops the order without a word
   * when there is no ladder and no ramp within `ESCALADE_REACH` of that bay. A playtest found
   * it exactly that way: the order was accepted, nothing happened, and the cohort read
   * "Garrison · Steady" standing in an open field with 160 men.
   *
   * Only the **negative** is drawn here, deliberately. The positive is already said by the
   * wall cursor and its parapet marker, and two labels saying the same thing at one cursor is
   * how a HUD gets ignored. This file adds the sentence that was missing and nothing else,
   * which is also why it needs no edit to a file another workstream owns.
   */
  private stormWarning(ctx: EngineContext, cursor: CursorPoints): void {
    const probe = this.probe;
    if (!probe || this.ptr.overUi || !cursor.wallValid) { this.done(ctx); return; }
    const sel = this.model.selectedViews.filter((v) => v.own && !v.destroyed);
    if (sel.length === 0) { this.done(ctx); return; }
    const offer = probe.escaladeOfferAt(sel[0].id, cursor.wallX, cursor.wallZ);
    if (offer.ok || offer.refusal === 'crew' || offer.refusal === 'noWall') {
      this.done(ctx);
      return;
    }
    this.stormRefusal = offer.refusal;
    const bay = offer.bay >= 0 ? `bay ${offer.bay}` : 'that stretch';
    this.showHint(offer.refusal === 'full'
      ? `Every ladder and ramp at ${bay} already has a full file`
      : `Nothing to climb at ${bay} — bring a ladder or a tower`, false);
    this.setCursor('refuse');
  }

  /** Nothing on offer: fall back to the flash, then to nothing. */
  private done(ctx: EngineContext): void {
    this.hideHint(ctx);
    this.setCursor('');
  }

  /**
   * A cursor of our own, on our own attribute.
   *
   * `SelectionController.updateCursor` owns `document.body.dataset.cur` and is edited by
   * another workstream this session, so this writes `data-siegecur` instead and the CSS wins
   * on specificity (`html body[...]`). Two files writing one attribute is a race; two files
   * writing two attributes with a stated precedence is a rule.
   */
  private cur = '';
  private setCursor(kind: '' | 'machine' | 'refuse'): void {
    if (kind === this.cur) return;
    this.cur = kind;
    if (kind) document.body.dataset.siegecur = kind;
    else delete document.body.dataset.siegecur;
  }

  /**
   * Where the machine physically is, so the lead line starts on the machine.
   *
   * Taken from the crew's own anchor rather than from the machine's coordinates, because the
   * gang musters on the machine and `Siege` does not publish a position for every machine
   * kind through one accessor. The two are within a shed's length of each other, which is
   * inside the width of the dashed line at any zoom this is legible at.
   */
  private machineAt(o: MachineOrderView): { x: number; z: number } | null {
    const v = this.model.view(o.unitId);
    if (!v) return null;
    return { x: v.cx, z: v.cz };
  }

  /**
   * One sentence per outcome, and every refusal says *why*.
   *
   * The refusals are the part the owner explicitly asked to be made legible: a tower "refuses
   * redirection past `Approach` and inside 12 m; that is correct, but the refusal should be
   * legible rather than silent." So every branch here that starts "It will not" also says
   * what would have to be different.
   *
   * A bay is named by its own index rather than by a station, because a station is a
   * seventy-centimetre slot on a spine the player has never heard of and a bay is a length of
   * wall between two towers, which is a thing you can see.
   */
  private sentence(o: MachineOrderView, count: number): string {
    const name = MACHINE_NAME[o.kind];
    const many = count > 1 ? `${count} machines` : `the ${name}`;
    const where = o.gateId ? gateName(o.gateId) : `bay ${o.bay}`;
    switch (o.refusal) {
      case 'none':
        return o.gateId
          ? `Break the ${where} — ${Math.round(o.distance)} m, ${clock(o.seconds)}`
          : `Roll ${many} to ${where} — ${Math.round(o.distance)} m, ${clock(o.seconds)}`;
      case 'already':
        return o.gateId
          ? `Already at the ${where}`
          : `The ${name} is already going to ${where}`;
      case 'committed':
        return `Committed — the ${name} is squaring up and will not be turned`;
      case 'landed':
        return `Too late — the ramp is down on ${where}`;
      case 'taken':
        return `${where[0].toUpperCase()}${where.slice(1)} is taken by another machine`;
      case 'noWall':
        return `No wall there for the ${name}`;
      case 'noGate':
        return `No gate there — a ram breaks gates`;
      case 'wrongTarget':
        return o.kind === 'ram'
          ? 'A ram cannot break masonry — send it at a gate'
          : 'The great ram is for the curtain, not the gate';
      case 'spent':
        return `The ${name} has finished its work`;
      case 'unmanned':
        return `Nobody is pushing the ${name}`;
      default:
        return `The ${name} will not go there`;
    }
  }

  private showHint(text: string, ok: boolean): void {
    const s = this.hint.style;
    if (s.display !== 'block') s.display = 'block';
    if (this.hint.textContent !== text) this.hint.textContent = text;
    const tone = ok ? 'move' : 'refuse';
    if (this.hint.dataset.tone !== tone) this.hint.dataset.tone = tone;
    const t = `translate3d(${Math.round(this.ptr.x + 18)}px, ${Math.round(this.ptr.y + 38)}px, 0)`;
    if (s.transform !== t) s.transform = t;
  }

  private hideHint(ctx: EngineContext): void {
    if (ctx.time.elapsed < this.flashUntil && this.flash) {
      this.showHint(this.flash, this.flashOk);
      return;
    }
    if (this.hint && this.hint.style.display !== 'none') this.hint.style.display = 'none';
  }
}

/**
 * The cursor's three answers, as `SelectionController` publishes them.
 *
 * Declared structurally rather than imported so this file does not take a build dependency on
 * a class another workstream is editing in the same session, and so a probe can drive it with
 * a plain object.
 */
export interface CursorPoints {
  wallX: number; wallZ: number; wallValid: boolean;
  solidX: number; solidZ: number; solidValid: boolean;
  orderX: number; orderZ: number; orderValid: boolean;
}

/**
 * A gate's id turned into the name on the map.
 *
 * Derived from the id rather than tabled, because a table is a place for `'porta-flaminia'`
 * to be written down again — and a literal gate id is the exact mistake that made the breach
 * a no-op on Carthage for a whole workstream. `porta-byrsae` becomes "Porta Byrsae" and
 * anything a future city publishes comes out readable without this file being edited.
 */
/**
 * Seconds as something a commander reads, not as a number of seconds.
 *
 * "590 s" is data; "9 min 50 s" is a decision. The threshold matters more than the format:
 * the whole reason this is on the cursor is that a re-aimed tower can cost ten minutes of a
 * battle and nothing said so until it had happened.
 */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

function gateName(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
