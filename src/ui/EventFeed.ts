/**
 * Transient battle notices, styled as struck bronze plates that tarnish and fade.
 *
 * Every message is a dispatch from the field, so the wording is a report rather than a
 * log line. Bursts are coalesced: twenty men dying in one melee is one notice, not
 * twenty, and repeated clashes at the same moment collapse into a single line.
 */

import type { EngineContext } from '../core/Engine';
import { Faction } from '../sim/types';
import { el, html, icon } from './dom';
import { ICON } from './icons';
import type { HudModel } from './model';
import { FACTION_UI } from './theme';
import { WALL_REFUSAL } from './siege';

/** Remembered per-unit condition, so the feed can notice changes without events. */
interface UnitMemory {
  routing: boolean;
  destroyed: boolean;
  /** Strength at the last casualty notice, so one notice covers a whole bad minute. */
  reportedFrac: number;
}

type Tone = 'good' | 'bad' | 'neutral' | 'alarm';

interface Notice {
  node: HTMLElement;
  bornAt: number;
  key: string;
  count: number;
  countEl: HTMLElement | null;
}

const LIFETIME = 6.5;
/**
 * Three, not five.
 *
 * A rout cascades: half a dozen warbands break inside ten seconds and the feed filled with
 * five simultaneous dispatches down the right edge — measured at 275 x 166 px, three per cent
 * of the frame, and nobody reads five at once anyway. Three is what Rome II shows, and the
 * fourth dispatch has been superseded by the time it would have been read.
 */
const MAX_VISIBLE = 3;

export class EventFeed {
  private root!: HTMLElement;
  private notices: Notice[] = [];
  private lastClashAt = -99;
  private offs: Array<() => void> = [];
  private memory = new Map<number, UnitMemory>();
  private wasEngaged = false;

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.root = el('div', 'feed', parent);

    const title = (id: number): string => this.model.view(id)?.title ?? 'A unit';
    const sideOf = (f: number): Tone => (f === Faction.Rome ? 'bad' : 'good');

    this.offs.push(
      ctx.events.on('unitRouted', (e) => {
        this.push(
          `rout${e.unitId}`,
          ICON.rout,
          `${title(e.unitId)} has broken`,
          `${FACTION_UI[e.faction as Faction].short} · the line is giving way`,
          sideOf(e.faction),
          ctx.time.elapsed
        );
      })
    );
    this.offs.push(
      ctx.events.on('unitDestroyed', (e) => {
        this.push(
          `dead${e.unitId}`,
          ICON.skull,
          `${title(e.unitId)} destroyed`,
          `${FACTION_UI[e.faction as Faction].short} · wiped from the field`,
          sideOf(e.faction),
          ctx.time.elapsed
        );
      })
    );
    this.offs.push(
      ctx.events.on('linesClashed', (e) => {
        // One clash notice every few seconds; the sound and the shake carry the rest.
        if (ctx.time.elapsed - this.lastClashAt < 5) return;
        this.lastClashAt = ctx.time.elapsed;
        this.push(
          'clash',
          ICON.swords,
          'The lines have met',
          e.intensity > 1.4 ? 'A heavy collision — shields are splitting' : 'Contact along the front',
          'alarm',
          ctx.time.elapsed
        );
      })
    );
    this.offs.push(
      ctx.events.on('objectiveChanged', (e) => {
        this.push(
          `obj${e.id}`,
          ICON.flag,
          `${e.id.replace(/[-_]/g, ' ')} — ${Math.round(e.progress * 100)}%`,
          `Held by ${FACTION_UI[(e.holder as Faction) ?? Faction.Rome]?.short ?? 'nobody'}`,
          e.holder === Faction.Rome ? 'good' : 'bad',
          ctx.time.elapsed
        );
      })
    );
    this.offs.push(
      ctx.events.on('unitRallied', (e) => {
        this.push(
          `rally${e.unitId}`,
          ICON.brace,
          `${title(e.unitId)} has rallied`,
          'Standards raised, ranks re-formed',
          e.faction === Faction.Rome ? 'good' : 'bad',
          ctx.time.elapsed
        );
      })
    );
    /**
     * An order the wall would not take, said out loud.
     *
     * The one notice here that is not a report of something that happened to an army — it is
     * an answer to the player. It is in the feed rather than in the drag hint because the
     * simulation decides a wall verb a tick *after* the button comes up, by which time the
     * hint is gone: the cursor refuses what it can see coming (`refreshWallOffer`) and this
     * catches the rest. Before it, a refused wall order was a unit that stood still and said
     * nothing — four orders, 0 m of four, including one to the bay next door.
     *
     * Keyed on the unit so a player leaning on the button gets one plate with a count rather
     * than three, and toned `bad` because it is a thing that did not happen.
     */
    this.offs.push(
      ctx.events.on('orderRefused', (e) => {
        this.push(
          `refuse${e.unitId}`,
          ICON.rout,
          `${title(e.unitId)} cannot`,
          WALL_REFUSAL[e.refusal](e.bay, e.verb),
          'bad',
          ctx.time.elapsed
        );
      })
    );
  }

  /** Announce something the HUD itself decided, e.g. the opening banner. */
  announce(headline: string, detail: string, tone: Tone, now: number): void {
    this.push(`say:${headline}`, ICON.flag, headline, detail, tone, now);
  }

  private push(key: string, glyph: string, headline: string, detail: string, tone: Tone, now: number): void {
    const existing = this.notices.find((n) => n.key === key);
    if (existing) {
      existing.count++;
      existing.bornAt = now;
      if (existing.countEl) existing.countEl.textContent = `×${existing.count}`;
      // Resetting `bornAt` is enough: `sync` recomputes the fade from it every tick.
      return;
    }

    const node = el('div', `note ${tone}`, this.root);
    html(
      node,
      `<span class="note-ic">${icon(glyph)}</span>
       <span class="note-txt">
         <span class="note-head">${headline}</span>
         <span class="note-sub">${detail}</span>
       </span>
       <span class="note-n"></span>`
    );
    this.notices.push({ node, bornAt: now, key, count: 1, countEl: node.querySelector('.note-n') });

    while (this.notices.length > MAX_VISIBLE) {
      const old = this.notices.shift();
      old?.node.remove();
    }
  }

  /**
   * Derive notices from unit state as well as from events.
   *
   * The combat, morale and objective systems are not all wired up yet, so `unitRouted`,
   * `unitDestroyed` and `linesClashed` may never fire. Watching the unit groups directly
   * means the feed reports the battle either way, and because both paths use the same
   * notice key, whichever notices a rout first wins and the other is a no-op.
   */
  observe(now: number): void {
    let engaged = false;
    for (const v of this.model.views) {
      let m = this.memory.get(v.id);
      if (!m) {
        m = { routing: v.routing, destroyed: v.destroyed, reportedFrac: v.strengthFrac };
        this.memory.set(v.id, m);
      }
      if (v.engaged) engaged = true;

      if (v.destroyed && !m.destroyed) {
        this.push(`dead${v.id}`, ICON.skull, `${v.title} destroyed`,
          `${FACTION_UI[v.faction].short} · wiped from the field`,
          v.faction === Faction.Rome ? 'bad' : 'good', now);
      } else if (v.routing && !m.routing) {
        this.push(`rout${v.id}`, ICON.rout, `${v.title} has broken`,
          `${FACTION_UI[v.faction].short} · the line is giving way`,
          v.faction === Faction.Rome ? 'bad' : 'good', now);
      } else if (m.reportedFrac - v.strengthFrac > 0.25) {
        // A quarter of the unit gone since the last report is worth a dispatch.
        const lost = Math.max(1, Math.round((m.reportedFrac - v.strengthFrac) * v.initial));
        this.push(`hurt${v.id}`, ICON.quiver, `${v.title} — heavy losses`,
          `${lost} men lost · ${v.alive} still standing`,
          v.faction === Faction.Rome ? 'bad' : 'good', now);
        m.reportedFrac = v.strengthFrac;
      }
      if (v.strengthFrac > m.reportedFrac) m.reportedFrac = v.strengthFrac;
      m.routing = v.routing;
      m.destroyed = v.destroyed;
    }

    if (engaged && !this.wasEngaged) {
      this.push('clash', ICON.swords, 'The lines have met', 'Contact along the front', 'alarm', now);
      this.lastClashAt = now;
    }
    this.wasEngaged = engaged;
  }

  /**
   * Runs at the slow tick; retiring a notice is not time-critical.
   *
   * The rise and the fade are both driven from the clock rather than by a CSS animation and
   * transition, for the same reason `BattleFlow` drives its title card that way: the
   * screenshot harness fast-forwards simulated time without letting real time pass, so a
   * 0.42 s keyframe animation is caught a few milliseconds in and every notice was
   * photographed as a half-transparent ghost sliding in from the right.
   */
  sync(now: number): void {
    for (let i = this.notices.length - 1; i >= 0; i--) {
      const n = this.notices[i];
      const age = now - n.bornAt;
      if (age > LIFETIME) {
        this.notices.splice(i, 1);
        n.node.remove();
        continue;
      }
      const rise = Math.max(0, Math.min(1, age / 0.42));
      const fall = Math.max(0, Math.min(1, (LIFETIME - age) / 1.1));
      const a = Math.min(rise, fall);
      // Slides in from the right and leaves the same way.
      const slide = (1 - rise) * 1.6 + (1 - fall) * 1.4;
      const op = a.toFixed(3);
      if (n.node.style.opacity !== op) n.node.style.opacity = op;
      const tf = `translateX(${slide.toFixed(2)}em)`;
      if (n.node.style.transform !== tf) n.node.style.transform = tf;
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.root.remove();
  }
}
