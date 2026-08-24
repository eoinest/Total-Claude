import type { EngineContext } from '../core/Engine';
import type { NetSession } from '../net/NetSession';
import { readSiege } from './siege';
import { FACTION_UI } from './theme';

/**
 * The session strip: who you are, who they are, and what the link is doing — and, when the
 * link stops, the sheet that says so and gives you somewhere to go.
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
 * ## Point 4 was a line of red text over a battle nobody could still play
 *
 * The strip is the right place for a desync, which is a forensic event with five numbers in
 * it and a reader who wants them all at once. It is the wrong place for *the other player
 * walked away*, which is not forensic at all: the battle has stopped, nothing on screen will
 * ever move again, and the only useful things left are what state it stopped in and how to
 * leave. Those were an eleven-point line above the top bar, and the player's next move was to
 * find out whether the browser's back button lost anything.
 *
 * So an ending that strands somebody gets a sheet — `peerLeft`, `linkLost`, `abandoned` — and
 * it obeys three rules the owner set:
 *
 * - **Halt and say where.** The tick, the turn and the clock, and what the two armies looked
 *   like at that moment. His words for the shape: *"The battle stood at t+337, turn 101."*
 * - **No result.** A battle nobody finished does not have one, and this will not manufacture
 *   one out of a headcount. `BattleFlowSystem`'s dispatch is deliberately not reused here:
 *   that card exists to print a verdict.
 * - **A way out, and only one that works.** Back to the menu always; *Save the replay* only
 *   when there is a record to save, because a button that fails when pressed is worse than an
 *   absent one.
 *
 * A desync keeps the strip. §9.4's answer there — tick, layer, both hashes, the regiments —
 * is a paragraph of evidence and the strip already prints all of it.
 *
 * ## Where the strip sits, and why it is measured rather than written down
 *
 * `top: 8px` put it exactly on top of `.topbar`, which is `top: 0.8em` in a HUD whose em is
 * `10px * var(--ui-scale)` — the same strip, centred the same way, with the session line drawn
 * over the turn clock and both armies' strength. It now parks under the bar, from the bar's own
 * measured bottom, because that bar's height depends on the UI scale, the viewport and what is
 * in it, and a constant would be wrong at every setting but the one it was written at.
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
.tc-over{position:fixed;inset:0;z-index:130;overflow:auto;pointer-events:auto;
  background:radial-gradient(120% 90% at 50% 0%,#241a12dd 0%,#0a0806f2 70%);
  font:400 15px/1.55 ui-serif,Georgia,serif;color:#e8dcc6}
.tc-over .tc-over-fit{box-sizing:border-box;min-height:100%;display:flex;align-items:center;
  justify-content:center;padding:32px 16px}
.tc-over .tc-over-sheet{position:relative;box-sizing:border-box;width:min(640px,92vw);
  padding:30px 34px 26px;border:1px solid #6b5735;border-radius:3px;
  background:linear-gradient(#1d1610,#14100c);box-shadow:0 18px 60px #000c}
.tc-over h2{margin:0 0 10px;font:600 25px/1.15 ui-serif,Georgia,serif;letter-spacing:.05em;
  color:#e9c877;text-transform:uppercase}
.tc-over p{margin:0 0 14px;color:#c3b494;font-size:14px}
.tc-over p.tc-over-quiet{color:#8e7f63;font-size:12.5px}
.tc-over .tc-over-row{display:flex;gap:12px;margin-top:22px;align-items:center;flex-wrap:wrap}
.tc-over button,.tc-over a.tc-over-go{padding:11px 18px;border:1px solid #7a6238;
  border-radius:2px;background:linear-gradient(#3a2c1a,#241a10);color:#f0dfb4;
  font:600 13px/1 ui-serif,Georgia,serif;letter-spacing:.13em;text-transform:uppercase;
  cursor:pointer;text-decoration:none}
.tc-over button:hover,.tc-over a.tc-over-go:hover{border-color:#c9a24a;color:#fff3d4}
.tc-over button.tc-over-ghost{background:#1a140e;color:#cdbb95;font-weight:500}
.tc-over .tc-over-x{position:absolute;top:8px;right:10px;padding:4px 9px;border:0;
  background:none;color:#8e7d5f;font-size:19px;line-height:1;letter-spacing:0}
.tc-over .tc-over-x:hover{color:#e9c877;background:none;border:0}
.tc-over .tc-over-esc{color:#7c6d52;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
.tc-over a:focus,.tc-over button:focus{outline:2px solid #c9a24a;outline-offset:3px}
`;

/** Endings that leave a player with a stopped battle and nowhere to go. See the docstring. */
const STRANDING = new Set(['peerLeft', 'linkLost', 'abandoned']);

const HEADLINE: Record<string, string> = {
  peerLeft: 'The other commander left',
  linkLost: 'The link to the relay is gone',
  abandoned: 'The other client fell too far behind',
};

const OPENING: Record<string, string> = {
  peerLeft: 'Their end of the link closed. The battle stopped where it stood rather than '
    + 'playing on without them.',
  linkLost: 'There is no reconnecting into a battle in progress &mdash; the two simulations '
    + 'would have to agree about every tick they had missed, and nothing here can make them.',
  abandoned: 'The relay stopped waiting. One of the two clients had fallen further behind '
    + 'than the match is allowed to stretch.',
};

const fmt = (n: number): string => n.toLocaleString('en-GB');

const clock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class NetPanel {
  private root: HTMLElement;
  private session: NetSession;
  private ctx: EngineContext | null;
  private lastKey = '';
  private topAt = -1;
  private sheet: HTMLElement | null = null;
  private sheetShown = false;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(host: HTMLElement, session: NetSession, ctx: EngineContext | null = null) {
    this.session = session;
    this.ctx = ctx;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'tc-net';
    host.append(this.root);
    addEventListener('resize', () => { this.topAt = -1; });
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
    /*
     * Re-measure the bar we are parking under, but only here.
     *
     * `getBoundingClientRect` forces a layout, and this runs inside a render loop that is
     * already writing to the HUD's DOM every frame — doing it per frame would be a flush per
     * frame for a number that changes when the phase changes, the window resizes or somebody
     * moves the UI-scale slider. All three of those either change `key` or fire `resize`.
     */
    if (this.topAt < 0) {
      const bar = document.querySelector('.topbar') as HTMLElement | null;
      const r = bar?.getBoundingClientRect();
      this.topAt = r && r.height > 0 ? Math.round(r.bottom + 8) : 8;
      this.root.style.top = `${this.topAt}px`;
    }

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

    if (!d && s.ended && STRANDING.has(s.ended) && !this.sheetShown) this.raise(s.ended, s.message);
  }

  /**
   * Where the battle stood when it stopped, as a sentence.
   *
   * Every number in it is read at the moment the sheet goes up, from the simulation that has
   * just been halted, so it describes the last state both clients were authorised to reach —
   * not a high-water mark and not an estimate.
   */
  private stood(): string {
    const t = this.ctx?.time;
    if (!t) return '';
    const s = this.session.status();
    const turn = s.readyTurn >= 0 ? `, turn ${s.readyTurn}` : '';
    const b = this.ctx?.tryGet?.('battle') as unknown as
      { strength?: number[]; initialStrength?: number[] } | undefined;
    const mine = b?.strength?.[s.myFaction];
    const theirs = (b?.strength ?? []).reduce(
      (a, n, f) => (f === s.myFaction ? a : a + (n ?? 0)), 0);
    const men = mine !== undefined && (mine > 0 || theirs > 0)
      ? `, with ${fmt(mine)} of your men still on the field against ${fmt(theirs)}`
      : '';
    return `The battle stood at t+${t.tick}${turn} &mdash; ${clock(t.simTime)} on the field`
      + `${men}.`;
  }

  /** The wall, when there is one, in the words the siege plaque already uses for it. */
  private wall(): string {
    if (!this.ctx) return '';
    const sg = readSiege(this.ctx);
    if (!sg) return '';
    return `At the wall: ${sg.objective}`;
  }

  private raise(why: string, detail: string): void {
    this.sheetShown = true;
    const sheet = document.createElement('div');
    sheet.className = 'tc-over';
    const token = this.session.token();
    sheet.innerHTML = `<div class="tc-over-fit"><div class="tc-over-sheet" role="dialog"
        aria-modal="true" aria-label="${HEADLINE[why] ?? 'The session ended'}">
        <button class="tc-over-x" type="button" title="Dismiss (Esc)" aria-label="Dismiss">&times;</button>
        <h2>${HEADLINE[why] ?? 'The session ended'}</h2>
        <p>${OPENING[why] ?? detail}</p>
        <p>${this.stood()}</p>
        ${this.wall() ? `<p>${this.wall()}</p>` : ''}
        <p class="tc-over-quiet">No result has been recorded. A battle nobody finished does not
           have one, and this will not invent one out of a headcount.</p>
        <div class="tc-over-row">
          <a class="tc-over-go" id="tc-over-menu" href="?">Back to the menu</a>
          ${token ? '<button class="tc-over-ghost" type="button" id="tc-over-save">Save the replay</button>' : ''}
          <span class="tc-over-esc">Esc</span>
        </div>
      </div></div>`;
    document.body.append(sheet);
    this.sheet = sheet;

    const save = sheet.querySelector('#tc-over-save') as HTMLButtonElement | null;
    save?.addEventListener('click', () => {
      void (async () => {
        const text = await token;
        if (!text) { save.textContent = 'No record to save'; return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
        a.download = `battle-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.tcr`;
        a.click();
        URL.revokeObjectURL(a.href);
        save.textContent = 'Saved';
        setTimeout(() => { save.textContent = 'Save the replay'; }, 2200);
      })();
    });
    // Dismissible, like the battle's own dispatch, and for the same reason: a player who has
    // read it may want to look at the field it stopped on. The strip still says what happened.
    const close = (): void => {
      this.sheet?.remove();
      this.sheet = null;
      if (this.onKey) window.removeEventListener('keydown', this.onKey);
      this.onKey = null;
    };
    (sheet.querySelector('.tc-over-x') as HTMLElement | null)?.addEventListener('click', close);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    this.onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', this.onKey);
    (sheet.querySelector('#tc-over-menu') as HTMLElement | null)?.focus();
  }
}
