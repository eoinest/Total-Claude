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
 * So an ending that strands somebody gets a sheet — which is *every* ending bar two; see
 * `KEEPS_THE_STRIP` — and it obeys three rules the owner set:
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
 * is a paragraph of evidence and the strip already prints all of it. So does a completed
 * battle, which has `BattleFlowSystem`'s dispatch up already.
 *
 * ## Where the strip sits, and why it is measured rather than written down
 *
 * `top: 8px` put it exactly on top of `.topbar`, which is `top: 0.8em` in a HUD whose em is
 * `10px * var(--ui-scale)` — the same strip, centred the same way, with the session line drawn
 * over the turn clock and both armies' strength. It now parks under the lowest of `OVERHEAD`,
 * measured, because those bars' heights depend on the UI scale, the viewport and what is in
 * them, and a constant would be wrong at every setting but the one it was written at.
 *
 * Centred with `left: 0; right: 0; margin-inline: auto` rather than a translate, because a
 * shrink-to-fit fixed element positioned at `left: 50%` has the viewport *minus that offset*
 * for a containing width — 640 px on a 1280 px page — so three short phrases wrapped into six
 * lines and the strip was twice as tall as it needed to be.
 *
 * ## Measured once is not measured
 *
 * That measurement used to live inside `update`, after the early return that skips a frame
 * whose `key` has not changed. `key` is `phase|peer|ended|stalls|desync|rtt|turn >> 3`, and in
 * the **deployment phase every one of those is constant**: the turn clock is held while either
 * player is still laying an army out, so `turn >> 3` — the term the old comment relied on for
 * "a rebuild is roughly once a second at worst" — never advances. The strip was therefore
 * placed exactly once, on the frame the phase became `deploy`, and then held that number for
 * as long as the two players took to deploy.
 *
 * Measured on 3 Sep 2026 at 1280×800, host slot 0, HUD scale at its 1.35 default: the strip
 * parked at 166–194 under a closed plaque of 111–158, and stayed at 166–194 while
 *
 * - ADD UNITS grew the plaque to 111–**239**, putting the strip across the roster's first row —
 *   `+`/`−` and the count for Legionary Cohort, Praetorian Guard and Urban Cohort all drawn
 *   under an 85%-opaque background;
 * - the HUD scale slider moved to 1.0 and then 0.8, shrinking the plaque to 82–118 and 66–95
 *   while the strip stayed at 166, seventy-one pixels below the bottom of anything.
 *
 * That is the owner's report in two sentences: *"the You are Rome Slot zero banner is covers the
 * deployment banner and i cannot customize my troops"*. The controls under it still took a
 * click — the strip is `pointer-events: none` — but a stepper you cannot see is a stepper you
 * do not have.
 *
 * So placement is now `place()`, separate from the rebuild, and it is driven by the things that
 * actually move a bar rather than by a string that describes the session:
 *
 * - a `ResizeObserver` on whichever of `OVERHEAD` is on screen, rebound as they come and go —
 *   this is what catches the palette opening and the scale slider, neither of which changes
 *   anything `key` can see. Its callback runs after layout and before paint, so the strip is
 *   already out of the way in the frame that grew the plaque;
 * - `animationstart` and `animationend`, delegated at the document, filtered to `OVERHEAD` —
 *   this is what catches the plaque *arriving*, which is the case a `ResizeObserver` cannot be
 *   bound in time for;
 * - a `requestAnimationFrame` chase while any of them is still animating, because `drop-in` and
 *   `dep-in` animate `transform`, `getBoundingClientRect` includes transforms, and a bar
 *   half-way through its entrance is not where it will be. This is the bounded version of the
 *   fault the original docstring records: measured once, the strip landed at 84 under a bar
 *   whose settled bottom is 89;
 * - `resize`, and the rebuild in `update`, as belts.
 *
 * Its own styles, like `NetLobby`, and for the same reason: `hud.css` has several agents live
 * in it and this is nine rules.
 */

const CSS = `
.tc-net{position:fixed;left:0;right:0;top:8px;margin-inline:auto;width:max-content;
  max-width:min(880px,94vw);z-index:60;
  display:flex;gap:14px;align-items:center;padding:5px 14px;pointer-events:none;
  border:1px solid #6b5735aa;border-radius:2px;background:#100c08d9;
  font:500 11.5px/1.35 ui-serif,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;
  color:#bfae8c}
.tc-net b{color:#e9c877;font-weight:600}
.tc-net .warn{color:#e0a03c;text-transform:none;letter-spacing:.02em}
.tc-net .bad{color:#e2564b;text-transform:none;letter-spacing:.02em}
/* Wrapped, and still transparent to the pointer. This rule used to add pointer-events:auto,
   which put an 880-px-wide box that looks like a caption in front of whatever is beneath it.
   The two endings that keep the strip are desync and complete, and both leave a battlefield,
   a card bar and a dispatch under it that the player is still entitled to click on --
   .dep-palette in hud.css records the identical fault eating every right-drag aimed at the
   ground. Nothing in this strip is interactive: it is spans of text, and the sheet raise()
   builds is where the buttons live, so there is nothing to let the pointer in for. */
.tc-net.wide{flex-wrap:wrap;justify-content:center}
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

/**
 * Everything that owns the top of the screen, in the order it is stacked there.
 *
 * The strip parks under the lowest of whichever of these is on screen. It is a list and not
 * just `.topbar` because the deployment plaque is a second full-width bar directly beneath it,
 * and parking under the top bar alone put the room code straight across ADD UNITS / REMOVE /
 * BEGIN BATTLE for the whole of a phase that lasts as long as two people take to lay out two
 * armies. `.replay-bar` is here for completeness: it is already positioned to clear the top bar
 * and a relayed battle has no reason to show one, but if one ever appears this does not have to
 * be rediscovered.
 */
const OVERHEAD = ['.topbar', '.deploy', '.replay-bar'];

/** The same list as one selector, for the delegated animation listener's `matches`. */
const OVERHEAD_SEL = OVERHEAD.join(',');

/** Clear space between the lowest of `OVERHEAD` and the top of the strip. */
const GAP = 8;

/**
 * How many consecutive frames `place` will chase a bar that is still animating.
 *
 * Two seconds at 60 Hz, against a `drop-in` of 0.7 s and a `dep-in` of 0.42 s, so it is loose
 * enough never to stop early and tight enough to be a bound. It exists because the chase's
 * exit condition is "no `OVERHEAD` element has a running animation", and an element that one
 * day grows `animation-iteration-count: infinite` would otherwise pin a `requestAnimationFrame`
 * loop to the frame rate for the life of the page. A ceiling turns that from a leak into a
 * misplacement, which is the failure a gate can see.
 */
const CHASE_FRAMES = 120;

/**
 * The two endings that keep the strip and get no sheet. Everything else gets one.
 *
 * A deny-list rather than an allow-list, and that is the second version of this. The first
 * named `peerLeft`, `linkLost` and `abandoned` — the three the owner asked about — and quietly
 * left a *pairing* refusal stranded exactly as before: `libm` and `tick` are refused after
 * `announce`, on a page that has already built a whole battle, so the player got a red line
 * above the top bar and no way off the screen. Whatever ends a relayed session, the player is
 * owed the same three things, so a sheet is the default and the exceptions are argued for:
 *
 * - `desync` keeps the strip, because §9.4's answer is a paragraph of evidence — tick, layer,
 *   both hashes, the named regiments — that wants to be read together and already is.
 * - `complete` keeps the strip, because `BattleFlowSystem`'s dispatch is already up with the
 *   verdict, the roll of honour and the record. Two closing screens is one too many.
 */
const KEEPS_THE_STRIP = new Set(['desync', 'complete']);

/**
 * The headline per ending, and every one of them is now **transport-neutral**.
 *
 * They named the relay, because there was only one wire. There are two — a relay, and a direct
 * connection between the two browsers — and a peer session whose channel closes must not tell
 * the player that "the link to the relay is gone" about a relay that was never in it. The
 * specifics are the transport's to write and they arrive in `detail`; see `raise`.
 */
const HEADLINE: Record<string, string> = {
  peerLeft: 'The other commander left',
  linkLost: 'The connection is gone',
  abandoned: 'The other commander\'s battle stopped moving',
};

const OPENING: Record<string, string> = {
  peerLeft: 'Their end of the connection closed. The battle stopped where it stood rather than '
    + 'playing on without them.',
  linkLost: 'There is no reconnecting into a battle in progress &mdash; the two simulations '
    + 'would have to agree about every tick they had missed, and nothing here can make them.',
  abandoned: 'One of the two sides had fallen further behind than the match is allowed to '
    + 'stretch, and waiting longer costs more than the match is worth.',
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
  /** Whichever of `OVERHEAD` is currently on screen, and being watched for a resize. */
  private watched = new Map<string, HTMLElement>();
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private chased = 0;

  constructor(host: HTMLElement, session: NetSession, ctx: EngineContext | null = null) {
    this.session = session;
    this.ctx = ctx;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.className = 'tc-net';
    host.append(this.root);

    /*
     * Three ways of hearing that a bar moved, and none of them is a poll.
     *
     * The `ResizeObserver` is the one that matters: `.deploy` changes height when the roster
     * palette opens and when the HUD scale slider moves, and neither of those changes anything
     * the session knows about, so nothing in `update`'s `key` can ever notice them. Its
     * callback runs after layout and before paint, which means the strip has already moved in
     * the same frame that grew the plaque rather than a frame later.
     *
     * It cannot, however, be bound to an element that does not exist yet, and `.deploy` is
     * attached on `deploymentBegan` — after this constructor runs. The delegated
     * `animationstart` is what covers that: `dep-in` starts on the frame the plaque is
     * appended, the event bubbles to the document, `place` finds the new element and observes
     * it from then on. `animationend` closes the same loop for `drop-in`.
     *
     * Nothing here is removed, because nothing removes the panel: `main.ts` builds one per
     * page and the page ends when the battle does. If that ever changes, these three and the
     * observer are what a `dispose` has to undo.
     */
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.place());
    }
    window.addEventListener('resize', () => this.place());
    const onAnim = (e: AnimationEvent): void => {
      const t = e.target as Element | null;
      if (t?.matches?.(OVERHEAD_SEL)) this.place();
    };
    document.addEventListener('animationstart', onAnim);
    document.addEventListener('animationend', onAnim);
    this.place();
  }

  /**
   * Park the strip under the lowest of `OVERHEAD`, and bind to whatever it found.
   *
   * `chasing` is true only when this call came from the `requestAnimationFrame` below, and it
   * exists so the frame budget resets whenever a real event asks for a placement.
   */
  private place(chasing = false): void {
    this.chased = chasing ? this.chased + 1 : 0;
    let want = GAP;
    let moving = false;
    for (const sel of OVERHEAD) {
      const el = document.querySelector(sel) as HTMLElement | null;
      const was = this.watched.get(sel);
      if (el !== was) {
        if (was) this.ro?.unobserve(was);
        if (el) {
          this.ro?.observe(el);
          this.watched.set(sel, el);
        } else {
          this.watched.delete(sel);
        }
      }
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) want = Math.max(want, Math.round(r.bottom + GAP));
      /*
       * `drop-in` and `dep-in` animate `transform`, and `getBoundingClientRect` includes it.
       * A bar read half-way through its entrance is a bar 0.9em above where it will settle, so
       * a placement made from that reading overlaps by exactly that much for the rest of the
       * phase. Chase it to the end rather than measuring it once on the way past.
       */
      if (el.getAnimations().some((a) => a.playState === 'running')) moving = true;
    }
    if (want !== this.topAt) {
      this.topAt = want;
      this.root.style.top = `${want}px`;
    }
    if (moving && this.chased < CHASE_FRAMES && this.raf === 0) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.place(true);
      });
    }
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
     * A belt to `place`'s three braces, and cheap because it is gated by the early return
     * above: a rebuild happens when the session changes, not every frame. The observers do the
     * real work — see the constructor — but a phase change is exactly the moment a bar appears
     * or disappears, and asking here costs one `querySelector` per bar on a frame that was
     * already going to rewrite the strip's innerHTML.
     */
    this.place();

    const bits: string[] = [
      `<span>Room <b>${s.room}</b></span>`,
      `<span>You are <b>${side}</b> (slot ${s.slot})</span>`,
    ];
    if (s.phase === 'lobby') {
      bits.push(`<span class="warn">${s.peer === 'absent'
        ? 'waiting for the other player to join' : s.message}</span>`);
    } else if (s.phase === 'deploy') {
      // Short, because the deployment plaque is directly above this and says the rest of it.
      // What the plaque cannot say is whether the other commander is here yet.
      bits.push(s.peer === 'absent'
        ? '<span class="warn">the other player has not arrived</span>'
        : '<span>Deployment &mdash; the clock starts when both are laid out</span>');
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

    /*
     * Guarded, because `Engine`'s frame loop has no `try` around `update`.
     *
     * `fixedUpdate` does — it reports once and keeps the frame alive, and its docstring says
     * why at length — but `for (const s of this.systems) s.update?.(…)` does not, so a throw
     * here takes the whole rAF loop down with it. That is a bad trade for any UI, and an
     * indefensible one for *this* UI: the sheet exists because a stranded player had a frozen
     * picture and no explanation, and a sheet that crashed on the way up would hand them the
     * identical frozen picture with the message it was carrying. The first draft did exactly
     * that — `BattleSystem.strength` is a record and not an array, `.reduce` is not a function,
     * and the survivor got nothing.
     */
    if (!d && s.ended && !KEEPS_THE_STRIP.has(s.ended) && !this.sheetShown) {
      this.sheetShown = true;
      try {
        this.raise(s.ended, s.message);
      } catch (e) {
        console.warn(`[net] the session-over sheet could not be drawn: ${String(e)}`);
      }
    }
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
    /*
     * `BattleSystem.strength` is a `Record<Faction, number>` and not an array — see its own
     * docstring, which exists because a missing faction key made every `+=` produce NaN. So
     * this reads it through `Object.entries`, and treats an unreadable one as no sentence at
     * all rather than printing "NaN of your men".
     */
    const b = this.ctx?.tryGet?.('battle') as unknown as
      { strength?: Record<string, number> } | undefined;
    const rows = Object.entries(b?.strength ?? {});
    const mine = b?.strength?.[String(s.myFaction)];
    const theirs = rows.reduce(
      (a, [f, n]) => (Number(f) === s.myFaction ? a : a + (Number(n) || 0)), 0);
    const men = Number.isFinite(mine) && ((mine ?? 0) > 0 || theirs > 0)
      ? `, with ${fmt(mine ?? 0)} of your men still on the field against ${fmt(theirs)}`
      : '';
    return `The battle stood at t+${t.tick}${turn} &mdash; ${clock(t.simTime)} on the field`
      + `${men}.`;
  }

  /** The wall, when there is one, in the words the siege plaque already uses for it. */
  private wall(): string {
    if (!this.ctx) return '';
    // Null on any field battle, and `readSiege` reaches into three systems to decide that.
    // A clause is worth having and is not worth a thrown frame.
    try {
      const sg = readSiege(this.ctx);
      return sg ? `At the wall: ${sg.objective}` : '';
    } catch {
      return '';
    }
  }

  /**
   * The sheet. `why` picks the headline; `detail` is what the transport actually said.
   *
   * **Both are printed when both exist**, and that is a correction rather than a flourish. The
   * general sentence for an ending and the specific account of *this* ending are different
   * things, and the first version showed only the general one when it had one — so
   * `PeerLink.noDirectPath`, which is four sentences naming what happened and what to try
   * instead, was thrown away in favour of "there is no reconnecting into a battle in progress"
   * on the one failure this design chose to accept and therefore owes an explanation for.
   */
  private raise(why: string, detail: string): void {
    const sheet = document.createElement('div');
    sheet.className = 'tc-over';
    /*
     * Ask whether there *is* a record; do not encode it yet.
     *
     * `token()` gzips the whole order log and base64s it, which is work worth doing when
     * somebody presses the button and not on the frame a battle collapses on. `record()` is
     * the same question with no cost, and it is the one that decides whether the button
     * appears at all.
     */
    const haveRecord = !!this.session.record();
    sheet.innerHTML = `<div class="tc-over-fit"><div class="tc-over-sheet" role="dialog"
        aria-modal="true" aria-label="${HEADLINE[why] ?? 'The battle stopped'}">
        <button class="tc-over-x" type="button" title="Dismiss (Esc)" aria-label="Dismiss">&times;</button>
        <h2>${HEADLINE[why] ?? 'The battle stopped'}</h2>
        <p>${OPENING[why] ?? detail}</p>
        ${OPENING[why] && detail && detail !== OPENING[why] ? `<p>${detail}</p>` : ''}
        <p>${this.stood()}</p>
        ${this.wall() ? `<p>${this.wall()}</p>` : ''}
        <p class="tc-over-quiet">No result has been recorded. A battle nobody finished does not
           have one, and this will not invent one out of a headcount.</p>
        <div class="tc-over-row">
          <a class="tc-over-go" id="tc-over-menu" href="?">Back to the menu</a>
          ${haveRecord
    ? '<button class="tc-over-ghost" type="button" id="tc-over-save">Save the replay</button>'
    : ''}
          <span class="tc-over-esc">Esc</span>
        </div>
      </div></div>`;
    document.body.append(sheet);
    this.sheet = sheet;

    const save = sheet.querySelector('#tc-over-save') as HTMLButtonElement | null;
    save?.addEventListener('click', () => {
      void (async () => {
        const text = await this.session.token();
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
