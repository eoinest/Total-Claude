/**
 * Battle framing: the opening title card and the end-of-battle dispatch.
 *
 * Both are pure chrome, but they are what turns a running simulation into a battle with
 * a beginning and an end. The results screen reads the per-unit `kills` tally straight
 * off the unit groups, so the roll of honour is the sim's own bookkeeping.
 */

import type { EngineContext } from '../core/Engine';
import { Faction, getOpposingFaction } from '../sim/types';
import { el, fmtClock, fmtCount, html, icon, setClass } from './dom';
import { activeMap } from '../maps';
import type { MapId } from '../maps';
import { ICON, standardGlyph } from './icons';
import type { HudModel } from './model';
import { unitOutcome, type UnitOutcome, type WallCondition } from '../sim/BattleFlow';
import { readSiege, type SiegeRead } from './siege';
import { FACTION_UI, HARNESS, PLAYER_FACTION } from './theme';

/**
 * The closing dispatch, per battlefield.
 *
 * All three lists were one set of hard-coded Roman sentences naming the Juthungi, the Via
 * Flaminia and the Tiber bridges, so **Carthage ended every battle with Rome's story** —
 * "the eagles are down on the Campus Martius" printed over a burning Byrsa. It is the same
 * defect the title card had and it takes the same fix: the copy follows the map.
 *
 * Keyed by map rather than lifted onto `MapDefinition` because these are three or four
 * sentences of *battle* prose, and `src/maps/` describes ground, light and vegetation. The
 * card's `label`/`subtitle`/`blurb` genuinely belong to the map and are read from it; a
 * dispatch belongs beside the other dispatch.
 *
 * Per map **and** per victor, which is what "whichever reads better" comes out as here: at
 * Rome the player defends and at Carthage the player storms, so victory and defeat are not
 * the same event with the names swapped. Two victory and two defeat lines each, picked by
 * the clock exactly as before.
 *
 * `victory`/`defeat` are always written from the player's side (`PLAYER_FACTION`, Rome).
 *
 * ## Why a line is a function and not a string
 *
 * Pydna's victory card read *"The field under Olocrus is Rome's. **Macedon** put her whole
 * levy into one line"* and its defeat card said *"the **pikes** are still coming on in step"*.
 * There is no Macedonian roster in this game and no pike in it: the three armies are Rome,
 * the Juthungi and Carthage, so the card named an enemy that cannot be on the field. It is
 * the same defect as "JUTHUNGI advantage 25 %" printed over a Carthaginian army, which was
 * fixed once already, and Campus Martius' field battle carried it too — *"the eagles are
 * down… nothing between the Juthungi and the Tiber bridges"* over a Punic host.
 *
 * The cause is that **a field battle's opponent is chosen in the menu.** `opponentBlocked`
 * greys that row only for a storm, because a wall names both sides; on open ground either of
 * the other two armies can be picked, on any map. So a dispatch line is handed the enemy that
 * was actually fought and no line contains a faction literal. A line cannot name the wrong
 * army if it cannot reach one.
 */
interface DispatchWho {
  /** The enemy as prose names them: "the Juthungi", "the Carthaginians". */
  foe: string;
}
type DispatchLine = (w: DispatchWho) => string;

interface Dispatch {
  victory: readonly DispatchLine[];
  defeat: readonly DispatchLine[];
  draw: readonly DispatchLine[];
}

/**
 * The enemy in the middle of a sentence, which is neither `FACTION_UI.short` ("JUTHUNGI",
 * a plaque heading) nor `.long` ("Juthungi Confederation", a formal style).
 *
 * A `Record<Faction, …>`, so a fourth army cannot be added without prose for it.
 */
const FOE_PROSE: Record<Faction, string> = {
  [Faction.Rome]: 'the legions',
  [Faction.Germanic]: 'the Juthungi',
  [Faction.Carthage]: 'the Carthaginians',
};

const DISPATCH: Record<MapId, Dispatch> = {
  'campus-martius': {
    victory: [
      (w) => `The host is broken. What is left of ${w.foe} runs north up the Via Flaminia, and Rome keeps her walls unfinished a little longer.`,
      () => 'The line held. Aurelian will hear that the city stood without him, and the masons will go back to the wall in the morning.',
    ],
    defeat: [
      (w) => `The eagles are down on the Campus Martius. Behind the broken line there is nothing between ${w.foe} and the Tiber bridges.`,
      (w) => `The field belongs to ${w.foe}. Rome will remember this day every time she looks at the height of her new walls.`,
    ],
    draw: [
      () => 'Both hosts have bled themselves white. The dead lie in windrows where the lines met, and nobody holds the ground.',
    ],
  },
  /**
   * Spring 146, the fourth year of the war, and Rome is the attacker here — the one map on
   * which the player is storming rather than holding. Scipio Aemilianus took the harbour
   * quay, then the forum, then six days and nights up the three streets to the Byrsa; on the
   * seventh Hasdrubal's wife took the children into the temple of Eshmun and fired it.
   * `docs/CARTHAGE.md` §5.2, from Appian.
   */
  carthage: {
    victory: [
      () => 'The Byrsa is taken. The three streets are choked from the forum to the citadel gate, and the Senate&rsquo;s instruction was that nothing should be left standing.',
      () => 'Carthage is Rome&rsquo;s. The temple on the summit is burning with the last of them inside it, and the ploughs are ordered up for the spring.',
    ],
    defeat: [
      () => 'The storm is thrown back off the wall. The triple line holds as it held Manilius, and the legions will winter on the isthmus again.',
      () => 'The ditch is full of Roman dead and the ladders are burning where they fell. Whatever is written to the Senate, this is where the assault stopped.',
    ],
    draw: [
      () => 'Both hosts are spent. The killing ground between the middle wall and the main one is full of men from both armies, and neither can be pushed out of it.',
    ],
  },
  /**
   * 168 BC, and the map carries no city — so this is always a field battle on the Pierian
   * plain, and *whose* field battle is the player's choice in the menu.
   *
   * The historical Pydna was fought against a Macedonian phalanx, and this copy said so:
   * "Macedon put her whole levy into one line", "the pikes are still coming on in step". The
   * ground is Pydna's and the light is Pydna's, but the army opposite is one of the game's
   * three, so the prose names the swells, the stream bed and the legion — the things that are
   * there — and takes the enemy from the field. `src/maps/pydna.ts` keeps its historical
   * account of the *place*, which is a different claim and a true one.
   */
  pydna: {
    victory: [
      () => 'The enemy line is broken. Once it came apart on the swells there was nothing in front of the legion but men who could not turn, and the pursuit will run until dark.',
      (w) => `The field under Olocrus is Rome&rsquo;s: ${w.foe} put their whole strength into one line, and one line is what they have lost.`,
      () => 'The swells did it, as they have done before. What is left of the enemy is streaming back toward the shore, and the light will hold long enough.',
    ],
    defeat: [
      (w) => `The legion could not close. The line is back across the stream bed and ${w.foe} are still coming on in step.`,
      () => 'The maniples are shattered on the Pierian plain. Whatever Rome does next, she will not do it with this army.',
    ],
    draw: [
      () => 'Both armies have come apart on the broken ground and neither will close again. The dead lie along the swells that did it.',
    ],
  },
};

/**
 * The roll of honour's last column, one word per outcome the arbiter recognises.
 *
 * The *outcome* is `BattleFlowSystem`'s to decide and this only spells it, which is the whole
 * point: the card's own "Units lost N of M" is counted from the same function, so the headline
 * and the rows under it cannot disagree. They did — a unit reduced to a fifth of its strength
 * counted as lost in the total and read **HELD** in its row.
 */
const OUTCOME_WORD: Record<UnitOutcome, string> = {
  destroyed: 'Destroyed',
  routed: 'Routed',
  mauled: 'Mauled',
  held: 'Held',
};

/**
 * One sentence per way of taking a wall, and the compiler holds the list complete.
 *
 * Written as a `Record<WallCondition, …>` on purpose: this is the device that stops the card
 * and the arbiter drifting apart a fifth time. Add a condition to `WallCondition` and this
 * object fails to typecheck until it has a sentence, which is a stronger guarantee than any
 * amount of care at the one call site below.
 *
 * `breakIn` is deliberately *not* "the wall was carried". Sixty men through a gate or down an
 * inside stair while the parapet above them is still held by the garrison is the case that
 * happens, and the card has to be able to say so without contradicting the four numbers
 * printed immediately above it.
 */
const WALL_SENTENCE: Record<WallCondition, (s: SiegeRead) => string> = {
  parapet: () => 'The wall was carried.',
  breakIn: (s) =>
    `The wall itself was never carried &mdash; ${fmtCount(s.inside)} of them are inside it, `
    + 'and the fighting is in the streets.',
};

/**
 * What happened at the wall, on the card that closes a siege.
 *
 * The dispatch was excellent and silent about the one thing the battle was about: no gate,
 * no breach, no men over the parapet, no "the wall held". A player who had just spent
 * sixteen minutes storming Carthage was handed two headcount columns and a roll of honour,
 * and nothing on the card distinguished a storm that got in from one that was thrown off
 * the ladders with identical casualties.
 *
 * Nothing here on a field battle: `readSiege` returns null unless the arbiter found a
 * garrison on a wall, which is the same test it uses to decide the battle by ground.
 *
 * The counts are the last census the arbiter took, once a second, so they are what the wall
 * looked like when it was decided rather than a high-water mark. That is the honest number
 * to print under a verdict: "18 of 60 inside" beside "Defeat" says exactly how close it was.
 */
function wallBlock(s: SiegeRead | null, reason: string, condition: WallCondition | null): string {
  if (!s) return '';
  /*
   * The verdict is read off *which condition fired*, not off `reason` alone.
   *
   * `reason === 'objective'` covers two quite different events and this sentence used to name
   * only one of them — the one that has never fired in a completed battle. So a card reading
   * DEFEAT, gate held at 85%, breaches 0, 869 of my men on the parapet against 2 of theirs and
   * a roll of honour of HELD HELD HELD HELD HELD also said *"The wall was carried."*, forty
   * pixels below its own numbers. Fourth time this project has shipped that class of defect.
   *
   * `WALL_SENTENCE` is a total map over `WallCondition`, so a third way to take a wall does
   * not compile until somebody writes what the card should say about it. That is the part
   * that stops this recurring; the string is only the symptom.
   *
   * Everything below it is unchanged and still keyed on `reason`, because `repulsed` and "the
   * army broke" genuinely are properties of how the battle ended rather than of a condition.
   */
  const verdict = condition !== null
    ? WALL_SENTENCE[condition](s)
    : reason === 'repulsed'
      ? 'The storm was thrown off the wall.'
      : s.gate.breached
        ? 'The gate went down; the wall itself was never carried.'
        : 'The wall was never carried.';
  // A gate that went down to a single blow is a real reading and "1 blows" is not a sentence.
  const blows = `${s.gate.blows} ${s.gate.blows === 1 ? 'blow' : 'blows'}`;
  const gate = s.gate.breached
    ? `Broken &mdash; ${blows}`
    : s.gate.blows > 0
      ? `Held at ${Math.round(s.gate.hp * 100)}% &mdash; ${blows}`
      : 'Never struck';
  const row = (dt: string, dd: string, bad = false): string =>
    `<div${bad ? ' class="loss"' : ''}><dt>${dt}</dt><dd>${dd}</dd></div>`;
  return `<div class="rs-honours">
      <div class="sec-head">The wall</div>
      <dl class="rs-stats">
        ${row('The gate', gate, s.gate.breached)}
        ${row('Breaches in the curtain', String(s.breachedBays), s.breachedBays > 0)}
        ${row('On the parapet at the end',
    `${s.onWall} <span>storming</span> &middot; ${s.garrisonOnWall} <span>holding</span>`)}
        ${row('Inside the walls', `${s.inside} <span>of ${s.needInside} needed</span>`,
    s.role === 'garrison' && s.inside > 0)}
      </dl>
      <div class="rs-flavour" style="margin-top:0.8em">${verdict}</div>
    </div>`;
}

/**
 * The screenshot harness is a measurement rig, not a player: a cinematic title card and
 * a victory overlay sitting across the middle of a frame make every shot unusable for
 * judging the battlefield. Both are suppressed there. The test itself lives in `theme.ts`
 * so that every overlay in the HUD makes the same call from one place.
 */
const CINEMATIC = !HARNESS;

export class BattleFlow {
  private title!: HTMLElement;
  private results!: HTMLElement;
  /** The HUD root, so the dispatch can hide every other panel while it is up. */
  private hudRoot!: HTMLElement;
  private titleShownAt = -1;
  private titleGone = false;
  private resultsOpen = false;
  /**
   * Once dismissed, stays dismissed.
   *
   * `resultsOpen` used to be the only latch and the close button cleared it, so the 10 Hz
   * `checkOutcome` fallback was free to re-raise the screen on its next tick — the player
   * dismisses the dispatch and it comes straight back. It cannot fire today only because
   * `BattleFlowSystem` is registered and `checkOutcome` bails on that, which is a coincidence
   * of wiring rather than a rule.
   */
  private dismissed = false;
  private onKey: ((e: KeyboardEvent) => void) | null = null;
  private offs: Array<() => void> = [];

  constructor(private model: HudModel) {}

  attach(parent: HTMLElement, ctx: EngineContext): void {
    this.hudRoot = parent;
    this.title = el('div', 'title-card', parent);
    /*
     * The card is the map's copy, not Rome's.
     *
     * All three lines were hard-coded, so **every** map opened with "The Siege of Rome ·
     * 271 AD · Campus Martius" and a lede about the Via Flaminia. On Carthage that is simply
     * wrong, and it cost an agent a round of screenshot forensics before it realised the
     * frames it was studying were Carthage. `MapDefinition` has carried `label`, `subtitle`
     * and `blurb` the whole time; nothing needed inventing.
     *
     * `subtitle` is already written as "The Siege of X &middot; <year>", which is exactly the
     * main/sub split the card wants, so it is split on the separator rather than duplicating
     * the same words in a second field. A map whose subtitle carries no separator falls back
     * to using the whole string as the heading.
     *
     * The standard over the rule was `standardGlyph(Faction.Rome)` — an aquila on the card
     * for the siege *of* Carthage. It is the map's own defender now, which is exactly what
     * `CityPlan.garrison` says and the one place the card can learn it without naming a city:
     * Rome holds the Aurelian Wall, Carthage holds the triple wall. A map with no city has no
     * defender to read, so it keeps the player's own standard.
     */
    const map = activeMap();
    const cut = map.subtitle.indexOf('&middot;');
    const head = cut < 0 ? map.subtitle : map.subtitle.slice(0, cut).trim();
    const when = cut < 0 ? '' : `${map.subtitle.slice(cut + 8).trim()} &middot; `;
    const defender = map.city?.garrison ?? PLAYER_FACTION;
    html(
      this.title,
      `<div class="tc-rule"><span class="tc-eagle">${icon(standardGlyph(defender), 'tc-eagle-ic')}</span></div>
       <div class="tc-main">${head}</div>
       <div class="tc-sub">${when}${map.label}</div>
       <div class="tc-lede">${map.blurb}</div>
       <div class="tc-rule flip"></div>`
    );

    /*
     * The browser tab is the map's too, and for the same reason the card is.
     *
     * `index.html` hard-codes "TOTAL CLAUDE — Siege of Rome" and it is not this workstream's
     * file, so it is written here. Read back off the card rather than from `head` directly:
     * a subtitle is authored as markup ("&middot;"), and a tab title is plain text.
     */
    const heading = this.title.querySelector('.tc-main')?.textContent?.trim();
    if (heading) document.title = `TOTAL CLAUDE — ${heading}`;

    this.results = el('div', 'results interactive', parent);
    this.results.style.display = 'none';

    this.offs.push(
      ctx.events.on('battleStarted', () => {
        if (!CINEMATIC) return;
        this.titleShownAt = ctx.time.elapsed;
        this.titleGone = false;
        this.title.style.display = '';
      })
    );
    this.offs.push(
      ctx.events.on('battleEnded', (e) => {
        this.model.over = true;
        this.model.victor = (e.victor as Faction) ?? -1;
        this.showResults(ctx, e.victor, e.reason);
      })
    );
  }

  /** True while the opening title card owns the frame. */
  get titleVisible(): boolean {
    return this.titleShownAt >= 0 && !this.titleGone;
  }

  /**
   * Per-frame, but does nothing at all once the title has gone.
   *
   * The fade is driven from the clock rather than by a CSS transition: the screenshot
   * harness fast-forwards simulated time without letting real time pass, and a
   * transition-based fade would still be mid-flight in every frame it grabs.
   */
  tick(ctx: EngineContext): void {
    if (this.titleGone || this.titleShownAt < 0) return;
    const age = ctx.time.elapsed - this.titleShownAt;
    const IN = 0.7;
    const LIFE = 2.9;
    const OUT = 0.9;
    let a: number;
    if (age < IN) a = age / IN;
    else if (age < LIFE) a = 1;
    else a = 1 - (age - LIFE) / OUT;
    a = Math.max(0, Math.min(1, a));
    const lift = (1 - a) * 0.7;
    this.title.style.opacity = a.toFixed(3);
    this.title.style.transform = `translateX(-50%) translateY(${(-lift).toFixed(2)}em)`;
    if (age > LIFE + OUT) {
      this.titleGone = true;
      this.title.style.display = 'none';
    }
  }

  /**
   * Fallback outcome detection, for a HUD running without the sim's arbiter.
   *
   * **The comment this replaces said "nothing emits `battleEnded` yet". It does** —
   * `BattleFlowSystem.finish` in `sim/BattleFlow.ts` emits it and this panel opens on the
   * event with the sim's own tally, which is where the Committed/Surviving/Fallen figures
   * and the roll of honour come from. The line below has therefore been the operative one
   * for some time: `main.ts` always registers `battleFlow`, so this returns immediately in
   * every configuration the game ships. It is kept for an embed or a probe that builds the
   * HUD over a bare `BattleSystem`, which is the only way to reach the rest of it.
   */
  checkOutcome(ctx: EngineContext, model: HudModel): void {
    if (this.resultsOpen || this.dismissed || ctx.time.simTime < 20) return;
    // `BattleFlowSystem` owns the verdict when it is registered.
    if (ctx.tryGet('battleFlow')) return;
    // `getOpposingFaction()`, not `Faction.Germanic`: on Carthage the literal counts an army
    // that was never deployed, so the fallback would call the battle over on its first check
    // with the real opponent untouched. Same defect the sim's own flow system carried.
    //
    // Keyed on `PLAYER_FACTION` rather than on Rome, because Rome is not always the player's
    // side and will not be the moment a second playable faction lands.
    const foe = getOpposingFaction();
    const mine = model.unitsLeft[PLAYER_FACTION] - model.routing[PLAYER_FACTION];
    const theirs = model.unitsLeft[foe] - model.routing[foe];
    if (mine > 0 && theirs > 0) return;
    const victor = mine > 0 ? PLAYER_FACTION : theirs > 0 ? foe : -1;
    const wiped = model.strength[victor === PLAYER_FACTION ? foe : PLAYER_FACTION] === 0;
    this.model.over = true;
    this.model.victor = victor;
    this.showResults(ctx, victor, wiped ? 'annihilation' : 'rout');
  }

  private showResults(ctx: EngineContext, victor: number, reason: string): void {
    if (this.resultsOpen || this.dismissed || !CINEMATIC) return;
    this.resultsOpen = true;
    const m = this.model;

    // `BattleFlowSystem` keeps the authoritative tally; prefer it over anything the HUD
    // can reconstruct from the surviving unit groups.
    const flow = ctx.tryGet('battleFlow') as unknown as {
      result?: {
        victor: number;
        reason: string;
        /** Which objective condition fired. Absent on a HUD built over a bare `BattleSystem`. */
        condition?: WallCondition | null;
        casualties: Record<number, number>;
        survivors: Record<number, number>;
        /** Units destroyed, broken, or reduced below a quarter strength. */
        unitsLost?: Record<number, number>;
        unitsTotal?: Record<number, number>;
        at: number;
      } | null;
    } | undefined;
    const tally = flow?.result ?? null;

    const player = victor === PLAYER_FACTION;
    const verdict = victor < 0 ? 'Stalemate' : player ? 'Victory' : 'Defeat';
    /**
     * The two columns are the two armies that were actually on the field.
     *
     * The right-hand one was `Faction.Germanic` unconditionally, so a battle fought against
     * Carthage reported a Juthungi army of nobody next to a Roman one. The deployment
     * publishes who Rome is fighting through `setOpposingFaction`, and that is the same value
     * `enemyOf` gives the AI and the combat code, so reading it here adds no second source of
     * truth to drift from.
     *
     * Read *before* the dispatch now, because the dispatch is handed it: see `Dispatch`. The
     * columns and the closing sentence therefore name the same army by construction.
     */
    const foe = getOpposingFaction();

    const dispatch = DISPATCH[activeMap().id];
    const lines = victor < 0 ? dispatch.draw : player ? dispatch.victory : dispatch.defeat;
    const flavour = lines[Math.floor(ctx.time.simTime) % lines.length]({ foe: FOE_PROSE[foe] });

    /**
     * The reason, from the player's own side of the field.
     *
     * Every line here used to be written from the winner's mouth and printed under whichever
     * verdict came out, so a storm of Carthage that ended with fourteen of twenty Roman units
     * broken and the army streaming away read **"Defeat — by rout, the enemy has quit the
     * field"**. Four of the six reasons name a side; a draw names neither, so it takes the
     * neutral column whoever the player is.
     */
    const side = victor < 0 ? 2 : player ? 0 : 1;
    const reasonText: Record<string, readonly [string, string, string]> = {
      annihilation: [
        'By annihilation — no formed body of the enemy remains',
        'By annihilation — no formed body of ours remains',
        'By annihilation — neither army has a formed body left',
      ],
      rout: [
        'By rout — the enemy has quit the field',
        'By rout — our army has quit the field',
        'By rout — the field has emptied',
      ],
      timeout: [
        'The light has gone; both armies still stand',
        'The light has gone; both armies still stand',
        'The light has gone; both armies still stand',
      ],
      objective: [
        'By objective — the ground that mattered has been taken',
        'By objective — the ground that mattered has been lost',
        'By objective — the ground that mattered is still contested',
      ],
      stalemate: [
        'Neither army will close again; the field has gone quiet',
        'Neither army will close again; the field has gone quiet',
        'Neither army will close again; the field has gone quiet',
      ],
      repulsed: [
        'The storm is thrown back — the parapet is still held',
        'The storm is thrown back — the parapet held against us',
        'The storm is thrown back — the parapet is still held',
      ],
    };

    const column = (f: Faction): string => {
      const fui = FACTION_UI[f];
      const left = tally ? (tally.survivors[f] ?? m.strength[f]) : m.strength[f];
      const lost = tally ? (tally.casualties[f] ?? 0) : Math.max(0, m.initialStrength[f] - left);
      const init = tally ? left + lost : m.initialStrength[f];
      const pct = init ? Math.round((lost / init) * 100) : 0;
      const units = m.views.filter((v) => v.faction === f);
      const total = tally?.unitsTotal?.[f] ?? units.length;
      // A battle of this period is decided by cohesion, not corpses — `BattleFlowSystem`
      // calls the result on units that stopped being units. Reporting only the destroyed
      // count read "0 of 21" beside a roll of honour full of routed cohorts, which is true
      // and useless: broken is how an army is actually lost. `unitsLost` is the sim's own
      // count on that definition (gone, broken, or under a quarter strength); the local
      // tally is the fallback for a HUD running without `BattleFlowSystem`.
      const lostUnits = tally?.unitsLost?.[f]
        ?? units.filter((v) => v.destroyed || v.routing || v.strengthFrac < 0.25).length;
      const destroyed = units.filter((v) => v.destroyed).length;
      return `<div class="rs-col" data-f="${fui.key}">
          <div class="rs-std">${icon(standardGlyph(f), 'rs-std-ic')}</div>
          <div class="rs-army">${fui.short}</div>
          <div class="rs-long">${fui.long}</div>
          <dl class="rs-stats">
            <div><dt>Committed</dt><dd>${fmtCount(init)}</dd></div>
            <div><dt>Surviving</dt><dd>${fmtCount(left)}</dd></div>
            <div class="loss"><dt>Fallen</dt><dd>${fmtCount(lost)} <span>(${pct}%)</span></dd></div>
            <div class="${lostUnits ? 'loss' : ''}"><dt>Units lost</dt><dd>${lostUnits} <span>of ${total}</span></dd></div>
            <div><dt>Destroyed outright</dt><dd>${destroyed} <span>of ${total}</span></dd></div>
          </dl>
        </div>`;
    };

    /*
     * The roll of honour, **your army first**.
     *
     * One `sort` across every view on the field put the two armies in one league table, so a
     * defeat card led with the enemy's best cohorts: the player's own dead were pushed off
     * the bottom of a list headed "Roll of honour" by the units that had killed them. It is
     * two groups now, each headed by its own standard, yours above theirs whichever way the
     * battle went — five of yours and three of theirs, which is the same eight rows the panel
     * was already measured to fit.
     */
    const rows = (f: Faction, limit: number): string => m.views
      .filter((v) => v.faction === f)
      .sort((a, b) => b.kills - a.kills)
      .slice(0, limit)
      .map((v) => {
        const fui = FACTION_UI[v.faction];
        const pct = v.initial ? Math.round((v.alive / v.initial) * 100) : 0;
        return `<tr data-f="${fui.key}">
            <td class="h-std">${icon(standardGlyph(v.faction), 'h-std-ic')}</td>
            <td class="h-name">${v.title}<span>${v.def.nativeName}</span></td>
            <td class="h-kills">${v.kills}</td>
            <td class="h-left">${v.alive}/${v.initial}<i style="width:${pct}%"></i></td>
            <td class="h-state">${OUTCOME_WORD[unitOutcome(v.destroyed, v.routing, v.alive, v.initial)]}</td>
          </tr>`;
      })
      .join('');
    const group = (f: Faction, limit: number): string => {
      const body = rows(f, limit);
      if (!body) return '';
      return `<tr><td colspan="5" style="padding-top:0.7em">`
        + `<span class="sec-head">${FACTION_UI[f].short}</span></td></tr>${body}`;
    };
    const honours = group(PLAYER_FACTION, 5) + group(foe, 3);

    /*
     * Three structural rules, all of them from a playtest that could not read this screen.
     *
     * **The head and the foot are outside the scroll.** The panel was one block with
     * `overflow: auto` on the whole of it, so on a full order of battle the roll of honour ran
     * past the bottom and took the dismiss button with it — measured at 1920x1080 and the
     * shipped 1.35 HUD scale, content 968 px inside a 948 px box, i.e. the only control on the
     * screen was below the fold and there was no other way out. Only `.rs-body` scrolls now,
     * so `.rs-foot` is on screen whatever the army size.
     *
     * **`aria-modal` and `role="dialog"`**, because this genuinely is one: it is the last thing
     * the battle says and nothing behind it is reachable while it is up.
     *
     * **A corner dismiss as well as the button.** A player who has just lost looks for the way
     * out at the top right before they read to the bottom.
     */
    html(
      this.results,
      `<div class="rs-panel hud-panel" role="dialog" aria-modal="true" aria-label="Battle result">
         <button class="rs-x interactive" type="button" title="Dismiss (Esc)" aria-label="Dismiss">&times;</button>
         <div class="rs-head">
           <div class="rs-verdict ${verdict.toLowerCase()}">${verdict}</div>
           <div class="rs-reason">${reasonText[reason]?.[side] ?? reason}</div>
           <div class="rs-clock">${fmtClock(tally?.at ?? ctx.time.simTime)} on the field</div>
         </div>
         <div class="rs-body">
           <div class="rs-cols">${column(PLAYER_FACTION)}<div class="rs-vs">${icon(ICON.swords, 'rs-vs-ic')}</div>${column(foe)}</div>
           ${wallBlock(readSiege(ctx), reason, tally?.condition ?? null)}
           <div class="rs-honours">
             <div class="sec-head">Roll of honour</div>
             <table><tbody>${honours}</tbody></table>
           </div>
           <div class="rs-flavour">${flavour}</div>
         </div>
         <div class="rs-foot">
           <button class="rs-save ghost interactive" type="button" title="Download this battle as a .tcr file">Save replay</button>
           <button class="rs-share ghost interactive" type="button" title="A link that plays this battle back">Copy replay link</button>
           <button class="rs-close interactive" type="button">Dismiss</button>
           <span class="rs-esc">Esc</span>
         </div>
       </div>`
    );
    this.results.style.display = 'grid';
    // Every other panel goes dark. A dispatch that the top bar, the minimap, the banners and
    // twenty unit cards all show through is the state the playtest called illegible, and no
    // amount of opacity on this element fixes chrome that is drawn *over* it.
    setClass(this.hudRoot, 'results-up', true);
    // A frame's delay lets the transition run instead of snapping.
    requestAnimationFrame(() => setClass(this.results, 'open', true));

    const dismiss = (): void => this.dismissResults();
    for (const sel of ['.rs-close', '.rs-x']) {
      this.results.querySelector(sel)?.addEventListener('click', dismiss);
    }
    this.wireReplay(ctx);
    // The scrim itself, but not the panel: clicking the sheet around a modal closes it.
    this.results.addEventListener('click', (e) => {
      if (e.target === this.results) dismiss();
    });
    this.onKey = (e: KeyboardEvent) => {
      // Enter dismisses — but not while it is being used to press one of the other three
      // buttons, which would copy a link and then throw the panel away in one keystroke.
      if (e.key === 'Enter'
        && (document.activeElement as HTMLElement | null)?.closest('.rs-foot button:not(.rs-close)')) return;
      if (e.key === 'Escape' || e.key === 'Enter') dismiss();
    };
    window.addEventListener('keydown', this.onKey);
    // Focus so the keyboard reaches the dialog even if the canvas had it.
    (this.results.querySelector('.rs-close') as HTMLElement | null)?.focus();
  }

  /**
   * The two buttons that make a finished battle a thing you can keep.
   *
   * A record is the seed, the config and the order log with each order stamped with the
   * tick it executed on — a couple of kilobytes for a battle, which is small enough that
   * the link *is* the file. `Save replay` writes the same bytes to disk for the ones that
   * are not, and for anybody who would rather have a file than a URL.
   *
   * Both are inert with no `ReplaySystem` registered, which is the case in any harness that
   * builds a HUD over a bare battle.
   */
  private wireReplay(ctx: EngineContext): void {
    const rp = ctx.tryGet('replay') as unknown as { token(): Promise<string> } | undefined;
    const save = this.results.querySelector('.rs-save') as HTMLButtonElement | null;
    const share = this.results.querySelector('.rs-share') as HTMLButtonElement | null;
    if (!rp) {
      save?.remove();
      share?.remove();
      return;
    }
    const flash = (b: HTMLButtonElement | null, msg: string, back: string): void => {
      if (!b) return;
      b.textContent = msg;
      setTimeout(() => { b.textContent = back; }, 2200);
    };
    share?.addEventListener('click', async () => {
      const token = await rp.token();
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('replay', token);
      try {
        await navigator.clipboard.writeText(url.toString());
        flash(share, 'Link copied', 'Copy replay link');
      } catch {
        // Clipboard is permission-gated and unavailable over plain http on some browsers.
        history.replaceState(null, '', url);
        flash(share, 'Link in address bar', 'Copy replay link');
      }
    });
    save?.addEventListener('click', async () => {
      const token = await rp.token();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([token], { type: 'application/octet-stream' }));
      a.download = `battle-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.tcr`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash(save, 'Saved', 'Save replay');
    });
  }

  /** Close the dispatch and hand the HUD back. Idempotent. */
  private dismissResults(): void {
    if (!this.resultsOpen) return;
    this.resultsOpen = false;
    this.dismissed = true;
    if (this.onKey) {
      window.removeEventListener('keydown', this.onKey);
      this.onKey = null;
    }
    setClass(this.results, 'open', false);
    setClass(this.hudRoot, 'results-up', false);
    window.setTimeout(() => {
      if (!this.resultsOpen) this.results.style.display = 'none';
    }, 420);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    this.onKey = null;
    this.title.remove();
    this.results.remove();
  }
}
