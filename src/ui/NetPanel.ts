import type { NetSession } from '../net/NetSession';
import { FACTION_UI } from './theme';

/**
 * The session strip: who you are, who they are, and what the link is doing.
 *
 * Small on purpose, and it says four things a relayed battle has to say and single player
 * never does:
 *
 * 1. **Which army is yours.** `PLAYER_FACTION` is no longer a constant and the challenger
 *    commands the storm, so the interface has to state which side it belongs to. Getting this
 *    wrong is not cosmetic — every selection gesture in the game keys off it.
 * 2. **Whether the battle is waiting for the other player.** A lockstep client that is sitting
 *    on its ceiling looks exactly like a game that has frozen, and there is nothing on screen
 *    to distinguish the two unless something puts it there. The stall counter and the "waiting"
 *    state are that something.
 * 3. **Whether the pairing is expected to fork.** A Chromium-against-Firefox match is allowed
 *    and is expected to part company after about three and a half minutes. A player who has
 *    been told that before the first order has agreed to something; one who finds out at t+230
 *    has been ambushed by their own browser.
 * 4. **What happened when it ended.** A desync names the tick, the layer and the regiments,
 *    and offers the record. That last part is the difference between a bug report and a shrug.
 *
 * Its own styles, like `NetLobby`, and for the same reason: `hud.css` has several agents live
 * in it and this is nine rules.
 */

const CSS = `
.tc-net{position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:60;
  display:flex;gap:14px;align-items:center;padding:5px 14px;pointer-events:none;
  border:1px solid #6b5735aa;border-radius:2px;background:#100c08d9;
  font:500 11.5px/1.35 ui-serif,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;
  color:#bfae8c}
.tc-net b{color:#e9c877;font-weight:600}
.tc-net .warn{color:#e0a03c;text-transform:none;letter-spacing:.02em}
.tc-net .bad{color:#e2564b;text-transform:none;letter-spacing:.02em}
.tc-net.wide{max-width:min(880px,94vw);flex-wrap:wrap;justify-content:center;
  pointer-events:auto}
`;

export class NetPanel {
  private root: HTMLElement;
  private session: NetSession;
  private lastKey = '';

  constructor(host: HTMLElement, session: NetSession) {
    this.session = session;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'tc-net';
    host.append(this.root);
  }

  /** Called from the render loop. Rebuilds only when something a reader would notice moved. */
  update(): void {
    const s = this.session.status();
    const d = this.session.desync;
    const side = FACTION_UI[s.myFaction as keyof typeof FACTION_UI]?.short ?? `faction ${s.myFaction}`;
    const key = `${s.phase}|${s.peer}|${s.ended}|${s.stalls}|${d ? d.units.length : -1}`
      + `|${Math.round(s.rttMs)}|${s.turn >> 3}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const bits: string[] = [
      `<span>Room <b>${s.room}</b></span>`,
      `<span>You are <b>${side}</b> (slot ${s.slot})</span>`,
    ];
    if (s.phase === 'lobby') {
      bits.push(`<span class="warn">${s.peer === 'absent'
        ? 'waiting for the other player to join' : s.message}</span>`);
    } else if (s.phase === 'deploy') {
      bits.push('<span>Deployment &mdash; the clock starts when both armies are laid out</span>');
    } else if (s.phase === 'battle') {
      bits.push(`<span>Turn <b>${s.turn}</b></span>`);
      if (s.rttMs) bits.push(`<span>${s.rttMs} ms round trip, ${s.delayTicks} ticks of delay</span>`);
      if (s.behindTicks <= 0) bits.push('<span class="warn">waiting for the other player…</span>');
      if (s.stalls > 0) bits.push(`<span>${s.stalls} stall(s), ${(s.stalledMs / 1000).toFixed(1)} s</span>`);
    }
    if (d) {
      bits.push(`<span class="bad">The two battles parted at tick ${d.tick} on `
        + `<b>${d.layer}</b> (${d.mine} against ${d.theirs}). Last agreed tick `
        + `${d.lastAgreedTick}. ${d.note}${d.units.length
          ? ` Regiment${d.units.length > 1 ? 's' : ''} ${d.units.join(', ')}.` : ''}</span>`);
    } else if (s.ended) {
      bits.push(`<span class="bad">${s.ended}: ${s.message}</span>`);
    }
    this.root.classList.toggle('wide', !!d || !!s.ended);
    this.root.innerHTML = bits.join('');
  }
}
