import { Engine, type QualityTier } from './core/Engine';

// --- world ---
import { SkySystem } from './render/SkySystem';
import { LightingSystem } from './render/LightingSystem';
import { TerrainSystem } from './terrain/TerrainSystem';
import { CitySystem } from './city/CitySystem';

// --- simulation ---
import { BattleSystem } from './sim/BattleSystem';
import { CombatSystem } from './sim/Combat';
import { ProjectileSystem } from './sim/Projectiles';
import { MoraleSystem } from './sim/Morale';
import { AbilitySystem } from './sim/Abilities';
import { RagdollSystem } from './sim/Ragdoll';
import { BattleFlowSystem } from './sim/BattleFlow';
import { UnitQuantiseSystem } from './sim/quantise';

// --- AI ---
import { installAI } from './ai';

// --- presentation ---
import { VFXSystem } from './vfx/VFXSystem';
import { UnitRenderSystem } from './units/UnitRenderSystem';
import { AudioEngine } from './audio/AudioEngine';
import { HudSystem } from './ui/HudSystem';
import { PostFXSystem } from './render/PostFX';

import { DeploymentSystem } from './sim/deployment';
import { getMap } from './maps';
import { deployBattle } from './sim/scenario';
import { garrisonOf, type Difficulty, type ScenarioId, sanitiseConfig } from './sim/battleConfig';
import { MainMenu, publishConfig, resolveConfig } from './ui/MainMenu';
import { ALL_FACTIONS, Faction } from './sim/types';
import { installSeamCheck } from './core/seams';
import { decodeReplay, type ReplayRecord, ReplaySystem } from './sim/replay';
import type { Link } from './net/link';
import { validCode } from './net/protocol';
import { chooseTransport, makeLink, testKnobs, transportLabel } from './net/transport';
import { NetSession } from './net/NetSession';
import { setPlayerFaction } from './ui/theme';
import {
  esc, HUD_MIN_WIDTH, hudFits, serverRelay, showLobby, showNetNotice, showTooNarrow,
} from './ui/NetLobby';
import { NetPanel } from './ui/NetPanel';
import { stateHashes, UNIT_CTL_FIELDS, UNIT_F64_FIELDS } from './sim/stateHash';

/**
 * Entry point. Builds the engine, registers every subsystem, deploys the scenario
 * and starts the loop.
 *
 * Registration order is *init* order, which matters wherever one system reads state
 * another builds during `init`. Per-frame update order is independent of this and is
 * driven by each subsystem's `order` field (see docs/ARCHITECTURE.md for the bands).
 *
 * The screenshot harness loads the same path with `?harness=1`, which pins the canvas
 * size, skips the intro fade and exposes `window.__game` so a headless browser can
 * fast-forward the battle deterministically and grab frames.
 */

const params = new URLSearchParams(location.search);
const harness = params.get('harness') === '1';
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLElement | null;
const loadBar = document.getElementById('load-bar') as HTMLElement | null;
const loadText = document.getElementById('load-text') as HTMLElement | null;

/**
 * Pre-battle menu, before anything is built.
 *
 * Two of the things it configures cannot be changed afterwards: the quality tier fixes the
 * shadow cascade count at `init`, and the AI's `commanded` set is bound when `installAI` runs.
 * So the menu resolves first and the engine is constructed from its answer — the same order
 * Total War uses, configure then load then fight, which also means a player who wants a small
 * battle never waits for a big one's assets.
 *
 * The quality tier used to fix the soldier pool too, and through it the size of both armies.
 * It does not: the pool is `SOLDIER_POOL_CAPACITY`, one number at every tier, because a
 * graphics setting must not change the outcome of a battle. **How large the battle is** is the
 * menu's own battle-size row, which is a `BattleConfig` field.
 *
 * Two screens, not one: it opens on the front door — battle, documentation, model viewer —
 * and Battle leads into the setup flow this comment describes. `?menu=battle` opens straight
 * on the setup, which is what the probes that drive it use.
 *
 * Skipped entirely under `?harness=1`, `?menu=0`, or `?replay=` — a record carries its own
 * battle and there is nothing left to choose. Ultra is the default tier for players as
 * well as the harness: the 16-shot pass measures every graded camera at ultra and the
 * slowest is 61-64 fps, so the tier the game is tuned and judged at is the one it opens on.
 * `?quality=` and `?difficulty=` still override, which is what the harness uses. `?quality=`
 * is no longer an escape hatch for weaker hardware in the sense of a smaller battle — it buys
 * resolution, shadows, post-effects and LOD distance and nothing else. The escape hatch for a
 * machine that cannot run eight thousand men is the battle-size row, which is a deliberate,
 * visible choice that travels in the `?battle=` token.
 */
/*
 * `?replay=` carries the battle inside it — config, seed, tier and the order log — so there is
 * no menu to show and nothing for a stored preference to say. It is decoded below, after the
 * `?quality=`/`?difficulty=` overlay, because the record's own answers win over all of them.
 * `?from=<seconds>` plays that much of it and then hands the army over, which is "take command
 * from here" and costs one comparison in `ReplaySystem.pump`.
 */
/*
 * `?mp=1` is the lobby, and it returns nothing: it navigates.
 *
 * Placed above every other decision because it is not a battle at all — there is no config to
 * resolve, no engine to build and nothing to load. It writes `?net=…&room=…` and reloads, and
 * the code below is what runs on the far side of that.
 */
if (params.get('mp') === '1') {
  if (loading) loading.hidden = true;
  showLobby(document.getElementById('menu-root') as HTMLElement);
  /*
   * A promise that never settles, rather than a `throw`.
   *
   * Both stop module evaluation, and only one of them does it silently. A top-level throw is an
   * unhandled rejection: it reaches `window.onerror`, every harness in `tools/` collects
   * `pageerror`, and a lobby that logs an error on every visit would make three gates report a
   * console failure for a page behaving exactly as intended.
   */
  await new Promise(() => { /* the lobby navigates; nothing below this line ever runs */ });
}
/*
 * `?room=ABCDE`, with no relay address beside it, is an invitation — and it joins.
 *
 * This is the whole of "a code and that's it". A guest who scans the square on the host's
 * screen, or types the line the host reads out, arrives here with five characters and no
 * transport in the URL at all.
 *
 * **Until 2 Sep 2026 that needed an address out of the document and now it does not**, and that
 * is the change this whole pass exists for. The old rule was that the only server which could
 * have served this page is the one that started the relay, so `<meta name="tc-relay">` supplied
 * the transport — and on the deployed site, where there is no such tag and never can be, five
 * characters fell through to a screen explaining why they could not work. A peer connection
 * needs no address at all: `chooseTransport` reads a bare `?room=` as *peer to peer*, and how
 * the two are introduced is decided there — this document's own relay if it declares one,
 * public brokers otherwise. The one line left here is the invitation's asymmetry.
 *
 * *Joins*, rather than hosts, and the asymmetry is deliberate rather than convenient. A URL
 * carrying a room code and nothing else is not a URL anybody writes for themselves: the lobby
 * writes the host's own navigation with `&host=1&menu=battle` and `npm run host` writes
 * `?mp=1&room=…&create=1`. A bare code is a thing that was *sent*, and an invitation is by
 * definition to the other side.
 *
 * **`params.get('host') === null` is the whole of the fix for the bug this caused**, and it is
 * worth naming because the symptom was baffling. Under the relay, a host's own navigation always
 * carried `?net=`, so this branch could not see it and the unconditional `host=0` was safe. Peer
 * to peer there is no address to carry, so the host's URL is a bare code too — and both pages
 * announced themselves as the challenger, both sat knocking at a room nobody was hosting, and
 * both timed out with *"nobody answered in room SMQKE"* about each other. Read the side off the
 * URL when the URL states it, and only fall back to "an invitation is to the other side" when it
 * does not. `?net=…&room=…` keeps its old meaning exactly — host unless
 * `&host=0` — so every link that already exists still means what it meant.
 *
 * The fallback is now only for a code that is *malformed*. There is no longer an origin that
 * cannot join a room, so the screen that used to explain why has nothing to explain.
 */
if (!params.get('net') && params.get('room') && params.get('host') === null) {
  const asked = (params.get('room') ?? '').toUpperCase();
  if (validCode(asked)) {
    params.set('host', '0');
  } else {
    if (loading) loading.hidden = true;
    showLobby(document.getElementById('menu-root') as HTMLElement);
    await new Promise(() => { /* as `?mp=1` above: the lobby is the end of this page's life */ });
  }
}
/*
 * The relay, and why it is opened before anything else exists.
 *
 * A challenger cannot build the engine until it knows which battle it is in: the quality tier
 * fixes `quality.maxSoldiers` at construction, `fittedUnitScale` fits the army to it, and
 * docs/MULTIPLAYER.md §7.7bis measured the Campus Martius assault at 3,074 men on ultra and
 * 3,009 on medium — with the ram crew dying 16 m short of the door at one tier and opening the
 * gate at the other. So a joiner connects, waits for the host's setup, and only then boots.
 *
 * `?net=ws://host:port&room=CODE` hosts through a relay; a bare `?room=CODE` goes peer to peer;
 * `&host=0` joins either way. The whole table, with the reasoning, is in
 * `src/net/transport.ts` — and the reason it is a table rather than a branch here is that there
 * are two transports now and only one of them existed when this comment was written.
 */
const net = chooseTransport(params, serverRelay());
const replayToken = params.get('replay');
const skipMenu = harness || params.get('menu') === '0' || replayToken !== null
  || (net !== null && net.want === 'join');
let config = resolveConfig(params, !harness);
let link: Link | null = null;
let netDeployPhase = false;
/**
 * A relay that will not have us, and the two rules it has to obey.
 *
 * **It never throws.** A top-level throw here is an unhandled rejection, which reaches
 * `window.onerror`, which every harness in `tools/` collects as a `pageerror` — the same thing
 * the `?mp=1` branch above spends a paragraph avoiding, and it was doing it on the one path
 * where something had genuinely gone wrong and the player most needed a readable screen.
 *
 * **It offers a way onward.** What used to happen was the loading splash shouting the failure
 * in red capitals across the middle of the title card, with no control anywhere on the page:
 * the only exit was the browser's back button. The lobby is one navigation away and it can be
 * handed back the address and the code that just failed, so a mistyped character is one
 * correction rather than a restart.
 */
const netFailed = (title: string, lines: string[]): Promise<never> => {
  loading?.remove();
  const back = new URL(location.href);
  back.search = '';
  back.searchParams.set('mp', '1');
  if (net) {
    // Only a relay session carries an address back to the lobby, because only a relay session
    // has one to correct. A peer session's way back is the code, and the code is already here.
    if (net.kind === 'relay') back.searchParams.set('net', net.base);
    back.searchParams.set('room', net.room);
  }
  showNetNotice(document.getElementById('menu-root') as HTMLElement, {
    title, lines, back: { label: 'Back to the lobby', href: `?${back.searchParams.toString()}` },
  });
  // `warn`, not `error`: this is a stated outcome with a screen behind it, and a gate that
  // treats every `console.error` as a failure is right to, which makes shouting here a lie.
  console.warn(`[net] ${title}: ${lines.join(' ')}`);
  // A promise that never settles, exactly as `?mp=1` does. Nothing below this line runs.
  return new Promise<never>(() => { /* the notice is the end of this page's life */ });
};
/*
 * A device that could not finish the battle is turned away **before a socket exists**.
 *
 * Placed here, above `makeLink`, and the position is the fix rather than an implementation
 * detail. Below it, the client has already claimed a slot: a phone that scanned the square took
 * the room's second place, could not reach BEGIN BATTLE — 434 px off the right edge of a page
 * `scrollWidth` says cannot scroll — and the laptop that arrived afterwards was refused with
 * "already has a challenger". One person's dead end had become both people's.
 *
 * `hudFits` is a measured number, not a device sniff; see `HUD_MIN_WIDTH`. The QR is the reason
 * this matters now: before it, nobody arrived here on a phone by accident.
 */
if (net && !hudFits() && params.get('narrow') !== 'ok') {
  loading?.remove();
  const invite = new URL(location.href);
  invite.search = '';
  invite.searchParams.set('room', net.room);
  showTooNarrow(document.getElementById('menu-root') as HTMLElement, {
    code: net.room,
    link: invite.toString(),
    width: window.innerWidth,
    coarse: window.matchMedia('(pointer: coarse)').matches,
  });
  console.warn(`[net] refusing to join ${net.room}: viewport ${window.innerWidth}px is under `
    + `the ${HUD_MIN_WIDTH}px the deployment HUD needs. No slot taken; the room is still open.`);
  await new Promise(() => { /* nothing below this line runs, and no socket was opened */ });
}
if (net) {
  /*
   * `testKnobs` reads `?p2plag=`, `?p2pfault=` and friends, and every one of them is empty on
   * every URL the product itself builds. See its docstring for the audit; the relay's equivalents
   * are command-line flags on a process, and a browser tab's flags are its query string.
   */
  link = makeLink(net, testKnobs(params));
  console.log(`[net] room ${net.room} as ${net.want} over ${transportLabel(net)}`);
  try {
    await link.connect();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // `refusedByRelay` and not `refusal`: the second is also set by a socket that never
    // opened, and "nothing is listening" is a different problem with a different fix from
    // "the other side read your code and said no".
    const refused = link.refusedByRelay;
    /*
     * The two transports fail differently and the screen has to say which.
     *
     * A relay session that cannot connect has an address that did not answer, and the useful
     * sentence names a process to start. A peer session has no address: what failed is either
     * the introduction — nobody is hosting that code — or the direct connection itself, and
     * `PeerLink` has already written the specific sentence for both (`noDirectPath`, and the
     * `connect` timeout). Reusing the relay's wording here would tell somebody on the deployed
     * site to run a shell command, which is the exact dead end §12.6 spent a section removing.
     */
    if (net.kind === 'peer') {
      await netFailed(
        refused ? 'That room would not have you' : 'The connection could not be made',
        [`${esc(why.charAt(0).toUpperCase() + why.slice(1))}`,
          'Nothing has been joined and nothing is waiting, so you can try another code or '
          + 'open a room of your own.'],
      );
    }
    await netFailed(
      refused ? 'The relay would not let you in' : 'No relay answered',
      refused
        ? [esc(refused.charAt(0).toUpperCase() + refused.slice(1)),
          `Room <b>${esc(net.room)}</b> on <b>${esc(net.kind === 'relay' ? net.base : '')}</b>.`]
        : [`${esc(why.charAt(0).toUpperCase() + why.slice(1))}.`,
          'A relay is a separate process. The battle cannot start without one, and there is '
          + 'nothing to reconnect to, so this stops here rather than pretending.',
          /*
           * This page loaded, and that is a diagnosis rather than a consolation.
           *
           * Somebody who followed an invite link got this document from the host's machine
           * before the socket was tried — so the machine is reachable, the network is fine,
           * and it is specifically the relay's port that did not answer. Saying "start a
           * relay on a machine you can both reach" to a person who has just been sent a link
           * blames the wrong party, which is the mistake §9.12 spent a section on.
           */
          'You reached this page, so the machine serving it is reachable and it is that relay '
          + 'specifically that did not answer. If you were sent a link, tell whoever sent it: '
          + 'one command, <code>npm run host</code>, serves the game and the relay together on '
          + 'an address you can both reach.'],
    );
  }
}
{
  const q = params.get('quality') as QualityTier | null;
  const d = params.get('difficulty') as Difficulty | null;
  // `?scenario=assault` alongside `?quality=` and `?difficulty=`: an override the harness
  // and the siege probe can set without carrying a whole `?battle=` token, on the same
  // footing as the other two. `sanitiseConfig` still has the last word, so it cannot select
  // an assault on a map with no wall.
  const sc = params.get('scenario') as ScenarioId | null;
  if (q) config = { ...config, quality: q };
  if (d) config = { ...config, difficulty: d };
  if (sc) config = { ...config, scenario: sc };
  config = sanitiseConfig(config);
}
let replayRecord: ReplayRecord | null = null;
if (replayToken !== null) {
  replayRecord = await decodeReplay(replayToken);
  if (replayRecord) {
    // The record's own config wins outright, including the tier. The tier is now provenance
    // rather than a simulation input — the army no longer depends on it — but the config it
    // travels with is the whole battle, and a record is watched as it was recorded.
    config = sanitiseConfig({ ...replayRecord.cfg, quality: replayRecord.quality });
  } else {
    console.error('[replay] ?replay= did not decode; falling back to the ordinary battle');
  }
}
/**
 * Drop a `.tcr` on the window to watch it.
 *
 * The file *is* the token — the same base64url string `Copy replay link` puts on the
 * clipboard — so a record can travel as a file or as a URL and there is only one thing to
 * read either way. Installed before the menu so it works on the front door, and left
 * installed so it works mid-battle: dropping a record is a request to watch that one instead.
 */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.name.endsWith('.tcr')) return;
  e.preventDefault();
  void file.text().then((text) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('replay', text.trim());
    location.href = url.toString();
  });
});
if (!skipMenu) {
  const menuHost = document.getElementById('menu-root') as HTMLElement;
  // The loading panel sits at z-index 100, above the menu, so it has to leave the layer
  // rather than merely fade — otherwise the menu is built underneath an opaque sheet.
  if (loading) loading.hidden = true;
  // `params` so the menu can tell a visit from a link: `?menu=battle`, or any URL that
  // already names a battle, opens straight on the setup screen instead of the front door.
  // See `startStep` in `MainMenu.ts`. `?menu=0` and `?harness=1` are unaffected — they are
  // handled above and never build a menu at all.
  const chosen = await new MainMenu(config, params).show(menuHost);
  config = chosen.config;
  if (loading) loading.hidden = false;
}
/*
 * The setup exchange, and it happens between the menu and the engine on purpose.
 *
 * The host publishes what it chose the instant it has chosen; the joiner has been sitting on
 * an open socket waiting for exactly that. Sending it here rather than folding it into the
 * `ready` handshake means the joiner starts loading in parallel with the host instead of after
 * it — two full-scale sieges load in about the time one does, which on this machine is the
 * difference between a lobby that feels alive and ninety seconds of nothing.
 */
if (link) {
  if (link.want === 'host') {
    netDeployPhase = params.get('deploy') !== '0';
    link.send({ k: 'setup', cfg: config, deployPhase: netDeployPhase });
  } else {
    if (loadText) {
      loadText.textContent = `Room ${link.room} — waiting for the host to choose the battle…`;
    }
    /*
     * And if they never do, say so. This used to reject into the top level.
     *
     * Two ways it ends badly and they are different sentences: the host closes their tab, which
     * closes this socket and rejects immediately, or the host walks away and the two-minute
     * timeout expires. Neither is an exception in the sense the word usually carries — the
     * challenger did nothing wrong and has somewhere to go — but both reached `window.onerror`
     * as one, over a loading screen with no way off it.
     */
    const cm = await link.once(['config']).catch(() => netFailed(
      link!.dropped ? 'The host left before choosing a battle' : 'The host never chose a battle',
      [`You were in room <b>${esc(link!.room)}</b> and nothing came back from the other side.`,
        link!.dropped
          ? 'Their end of the link closed. Open a new room, or join theirs again when they '
            + 'are ready.'
          : 'The room is still open on the relay. You can wait longer by joining again, or '
            + 'give them a different code.'],
    )) as { cfg: unknown; deployPhase: boolean };
    config = sanitiseConfig(cm.cfg as Parameters<typeof sanitiseConfig>[0]);
    netDeployPhase = cm.deployPhase;
  }
}
/*
 * The config is final here, and only here — so this is where it gets published.
 *
 * `resolveConfig` writes `setActiveMap` and `setOpposingFaction` on the way past, on the
 * assumption that it is the last word for every path that does not go through the menu. Three
 * paths falsify that, because each *replaces* `config` afterwards: `?replay=` takes the battle
 * out of the record, `?net=…&host=0` takes it off the relay, and the `?quality=`/`?scenario=`
 * overlay a hundred lines above rewrites it in place. On any of those, `activeMap()` kept
 * whatever `resolveConfig` had inferred from a URL that did not name a map.
 *
 * Measured before the fix: a `?replay=` boot of `map=carthage&scenario=assault` built the Punic
 * circuit on the **Campus Martius heightfield** and stood 1,340 men — the whole Punic garrison —
 * about 3.96 m along the curtain from where an ordinary boot puts them, with `uf64`, `uctl`,
 * `count` and `alive` all identical. Every siege replay was refused by its own checkpoint.
 *
 * Idempotent, and cheap: two assignments to two module singletons. Called unconditionally
 * rather than only on the paths that need it, because "which paths need it" is exactly the
 * judgement that was wrong the first time.
 */
publishConfig(config);
const difficulty = config.difficulty;
/**
 * Which side the player commands. The other is left to the AI.
 *
 * `?autoplay=1` hands both armies to the AI, which is what the screenshot harness wants:
 * its shots need a battle that fights itself. Interactive play must never do this, or the
 * AI will fight the player for control of their own units.
 */
// Explicit `?autoplay=0` wins over the harness default, so an interaction test can load
// the harness (for `window.__game`) while still leaving Rome under player control.
// A replay is never autoplay: the log commands Rome, and handing Rome to the AI as well
// would have two commanders fighting over one army — the same failure `installAI`'s
// `commanded` argument exists to prevent.
/*
 * A relayed battle defaults to autoplay off, and for a stronger reason than a replay: both
 * player factions must be left uncommanded on *both* clients, or one machine's AI issues
 * orders the other machine's AI does not and the two simulations part company on tick one.
 *
 * An **explicit** `?autoplay=1` still wins, and is deterministic under a relay for the same
 * reason the default is: `commanded` is derived from the config, so both clients hand the
 * planner the identical list. What it produces is a relayed battle nobody is commanding — two
 * machines watching one AI battle in lockstep. `tools/qa-net.mjs`'s cross-engine arm uses it,
 * because a melee is what makes two libms disagree and a battle with no orders in it is two
 * armies standing still.
 */
const autoplay = replayRecord ? false
  : params.has('autoplay') ? params.get('autoplay') === '1'
    : link ? false : harness;

/**
 * Who commands what, in a relayed battle. Derived from the config, identically on both clients.
 *
 * Slot 0 hosts and holds the ground; slot 1 comes at it. On an assault that is the wall's owner
 * against everyone else, which is what `CityPlan.garrison` already says and what
 * `siegeRoleOf` already reads. On a field battle it is Rome against whoever the setup named as
 * the opponent. `?netside=storm` swaps the host to the attacking side, because "the host
 * defends" is a convention rather than a fact and somebody will want the other one.
 *
 * Computed here, before `installAI`, because `installAI` binds its `commanded` set at
 * construction and both player factions have to be outside it on both machines.
 */
const netFactions: number[] = (() => {
  if (!link) return [];
  const defender = config.scenario === 'assault' ? garrisonOf(config.map) : Faction.Rome;
  const attacker = defender === Faction.Rome ? config.opponent : Faction.Rome;
  const pair = [defender, attacker];
  return params.get('netside') === 'storm' ? [attacker, defender] : pair;
})();
/**
 * The side this client's *interface* belongs to.
 *
 * This is the value `src/ui/theme.ts` publishes as `PLAYER_FACTION` — the selection model, the
 * card bar, the minimap and the results panel all key off it. Nothing in `src/sim` reads it,
 * which is what lets the two clients of one battle hold different values and still run the
 * identical simulation.
 */
const playerFaction: Faction = link ? (netFactions[link.slot] ?? Faction.Rome) : Faction.Rome;
if (link) {
  setPlayerFaction(playerFaction);
  console.log(`[net] room ${link.room}, slot ${link.slot}, commanding faction ${playerFaction}`);
}

/**
 * Whether the player lays their army out before the clock starts.
 *
 * On by default for anyone who came through the menu, which is every real player: pressing
 * BEGIN BATTLE hands you your army on the field with the clock stopped, exactly as Total War
 * does, and the deployment plaque is the first thing on screen. Off by default everywhere the
 * menu was skipped — the screenshot deck, `tools/probe-*`, `qa-determinism`, `qa-interact`
 * and every `?battle=` link all expect a battle that is already running, and a phase they
 * did not ask for would stop all of them dead at t+0.
 *
 * `?deploy=1` forces it on so a headless driver can exercise the phase, and `?deploy=0`
 * forces it off so a player can skip straight to the fight. It is refused outright under
 * autoplay: with both armies handed to the AI there is no player to deploy for.
 */
// In a relayed battle the host's answer is the only one that counts, on both machines: a
// deployment phase on one client and not the other is two different games from tick zero.
const deployPhase = link ? netDeployPhase
  : replayRecord ? replayRecord.deployPhase
    : params.has('deploy') ? params.get('deploy') === '1' && !autoplay
      : !skipMenu && !autoplay;

const engine = new Engine({
  canvas,
  quality: config.quality,
  fixedSize: harness
    ? { w: Number(params.get('w') ?? 1920), h: Number(params.get('h') ?? 1080) }
    : undefined,
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Sky first: lighting derives sun colour and intensity from its scattering integral,
// and PostFX samples its radiance cube for aerial perspective.
engine.add(new SkySystem());
// Lighting before any geometry exists: its constructor patches the global lighting
// shader chunks for cascaded shadows, and materials must not compile before that.
engine.add(new LightingSystem());
// Terrain installs `rig.heightAt`, which the city and the sim both sample during init.
engine.add(new TerrainSystem());
/*
 * Build the city this map carries, and nothing if it carries none.
 *
 * This was unconditional, and on any map without a city it was not merely wasted work — it
 * was a live gameplay bug. `CitySystem` planned the Aurelian circuit against the Tiber, built
 * it onto whatever heightfield was loaded, and was then simply made invisible. The geometry
 * stayed in the world: `Pathfinding` stamps `city.getWallSegments()` with no map guard, so
 * **Rome's wall blocked movement across the plain of Pydna** while being nowhere on screen.
 * Skipping registration closes it at the source rather than adding a second guard downstream
 * — `Pathfinding` already tests `if (!city?.getWallSegments) return`, so an absent city is a
 * case it handles cleanly.
 *
 * The guard was `!getMap(config.map).hidesCity`, and a flag is something the next map can
 * forget. It is now the plan itself: a map hands over a `CityPlan` or it hands over nothing,
 * and this line builds exactly what it was handed. See `src/city/cityPlan.ts`.
 */
const cityPlan = getMap(config.map).city;
if (cityPlan) engine.add(new CitySystem(cityPlan));

const battle = engine.add(new BattleSystem());
// Seed the battle's root stream here, before `initAll`, and not in the scenario.
// GeneralAI, TacticalAI and Projectiles each fork a private stream off this one during their
// own `init`, and a fork is derived from the parent's state at the moment it is taken — so a
// seed applied at deploy time (which runs after `initAll`) would leave all three on the
// default stream and the menu's seed field would quietly do almost nothing. Mutated in place
// rather than replaced for the same reason: the forks hold no reference to this object, but
// anything that later captures `battle.rng` would be left pointing at the discarded instance.
battle.rng.setState(config.seed === 0 ? 0x9e3779b9 : config.seed >>> 0);
/*
 * The order log, at order 5 — ahead of every `fixedUpdate` in the tree.
 *
 * Registered here rather than with the UI because it is simulation, not interface: it owns
 * the queue that turns "the player clicked" into "an order was applied at tick N", and the
 * whole point of the tick number is that it does not depend on which frame the click landed
 * in. `main.ts` binds its three non-bus outlets in `boot()`, once they exist.
 */
const replay = engine.add(new ReplaySystem());
engine.add(new CombatSystem());
engine.add(new ProjectileSystem());
engine.add(new MoraleSystem());
engine.add(new AbilitySystem());
engine.add(new RagdollSystem());
engine.add(new BattleFlowSystem());
/*
 * The unit layer's quantisation firewall, at order 60 — after every system that writes a
 * `UnitGroupState` inside a tick (including the two AIs, whose `orderIssued` emits land
 * synchronously through `BattleSystem`'s handler at 42 and 45) and before anything render-side.
 * See `src/sim/quantise.ts` for what it is for and what it measured.
 */
engine.add(new UnitQuantiseSystem(battle));

/*
 * The pre-battle deployment phase.
 *
 * Registered here but *opened* after `deployBattle`, in `boot()`: its deployment zone is
 * measured off where the scenario actually stood the two armies, so it cannot be computed
 * before they exist. Its `order` of 690 puts its `init` just ahead of the HUD's, which is
 * what lets `HudSystem` find it with `tryGet` and build the plaque. Registered at all only
 * when the phase will be used, so that same `tryGet` is the HUD's test for whether to.
 *
 * It holds `time.paused`, and that is the whole answer to the AI problem. `installAI` binds
 * its `commanded` set at construction, three lines below, and re-plans every few ticks — but
 * `Engine.frame` runs `fixedUpdate` exactly as many times as `Time.beginFrame` returns, and
 * a paused clock returns zero. So during deployment the planner is not merely out-voted, it
 * is never called.
 */
const deployment = deployPhase ? engine.add(new DeploymentSystem()) : null;
/*
 * The opponent's deployment phase, on this machine.
 *
 * Both clients simulate both armies, so both clients have to be able to *perform* both
 * players' deployment operations — the ones that come back from the relay in canonical order.
 * A second instance rather than a faction argument, because everything in `DeploymentSystem`
 * is bound to `playerFaction`: the zone is measured off where the other army stands, the
 * roster comes from `rosterFor(playerFaction, …)`, and the bench is per side.
 *
 * Registered under a second name so `ctx.tryGet('deployment')` still finds the local player's
 * — the HUD builds its plaque from that and must not be handed the opponent's.
 */
const deploymentB = link && deployPhase
  ? engine.add(new DeploymentSystem('deployment-peer')) : null;
if (deployment && deploymentB) {
  deployment.peer = deploymentB;
  deploymentB.peer = deployment;
}

// Four AI subsystems sharing one blackboard: nav grid, per-unit utility selector,
// per-faction plan, debug overlay. Registered as a bundle so their relative update
// order stays owned by the AI module rather than by this file.
//
// `commanded` is the important argument and it is not optional in practice. Left to
// its default the AI takes BOTH factions, and since it re-plans every few ticks it
// overwrites the player's orders within half a second — a move order drifted 46 m off
// target and was re-issued 23 times in ten seconds, an attack order reverted to MoveTo
// after 500 ms, and a formation change was undone as soon as the clock was unpaused.
// The player's army must be commanded by the player.
// In autoplay/harness mode the AI takes both sides so the battle fights itself.
/*
 * Every faction the player is not commanding, derived rather than named.
 *
 * This was `[playerFaction, aiFaction]` against a single `aiFaction = Faction.Germanic`, and a
 * third faction therefore arrived uncommanded — Carthage spawned with a full perception view,
 * 828 strength and `plan NONE`, sitting on the field doing nothing but whatever explicit orders
 * its scenario issued. `installAI` and both AI subsystems now default to all factions, but this
 * call passes an explicit list and an explicit list wins, so the fix has to be here.
 */
await installAI(engine, {
  difficulty,
  /*
   * In a relayed battle *neither* player's faction is the AI's, on both machines.
   *
   * `netFactions` is derived from the config, so the two clients compute the identical list
   * and hand the identical set to the planner. Getting this wrong in the obvious way — each
   * client excluding only its own faction — would leave each machine's AI commanding the
   * *other* player's army, and since the AI re-plans every few ticks the two simulations
   * would part company inside half a second.
   */
  commanded: autoplay ? [...ALL_FACTIONS]
    : link ? ALL_FACTIONS.filter((f) => !netFactions.includes(f))
      : ALL_FACTIONS.filter((f) => f !== playerFaction),
});

/*
 * The session, at order 4 — ahead of the order log at 5, which is ahead of every
 * `fixedUpdate` in the tree.
 *
 * Registered here rather than with the UI because it is the thing that decides which ticks
 * this machine is allowed to run. Its `init` attaches to `ReplaySystem`, and from that moment
 * nothing this client does reaches the simulation until it has been through the relay.
 */
const session = link
  ? engine.add(new NetSession(link, config, config.quality, deployPhase))
  : null;

/*
 * Say goodbye on the way out, because peer to peer there is nobody else to say it for you.
 *
 * Under a relay this line was not needed: the relay holds both sockets, sees one of them go,
 * and tells the survivor `peerLeft` by name. Between two peers the survivor has only its own
 * data channel, and closing a tab does not politely shut an SCTP association down — the
 * renderer is torn down and the far end simply stops hearing anything. `qa-p2p --only=leave`
 * measured exactly that: a peer closed its tab at tick 191 and the survivor sat until the
 * silence detector fired six seconds later and reported **`linkLost`** — *"the connection is
 * gone"*. Honest, and the wrong accusation: nothing was wrong with the connection, and the
 * player was told their network had failed when their opponent had walked away.
 *
 * `NetSession.dispose` sends `bye` and then closes the channel, so the survivor gets the
 * reason on the wire and the close behind it. `pagehide` rather than `unload`: `unload` is
 * deprecated, is not fired at all in some conditions, and disqualifies the page from the
 * back/forward cache. Leaving the page ends the match either way — §4.5 refuses reconnection —
 * so there is nothing to preserve for a page that comes back.
 */
if (session) window.addEventListener('pagehide', () => session.dispose());

const vfx = engine.add(new VFXSystem());
// VFX cannot write the soldier pool (not its file), so blood only dirties men once
// this sink is wired. `grime` drives a detail-texture blend in the unit renderer.
vfx.grimeSink = (i, amt) => {
  const g = battle.pool.grime;
  g[i] = Math.min(1, g[i] + amt);
};
// `cameraShake` is deliberately NOT handled here. VFXSystem already forwards it to
// `rig.shake()` internally and does not expose a switch to turn that off, so adding a
// second listener would double every impact.
engine.add(new UnitRenderSystem());
engine.add(new AudioEngine());
// The HUD needs the engine itself, not just the context: `setQuality` lives on
// Engine, so the quality-tier buttons are inert without this.
engine.add(new HudSystem({ engine }));

// Post-processing last: it takes over the final present, so everything it composites
// must already exist.
const postfx = engine.add(new PostFXSystem());
engine.renderOverride = (ctx) => postfx.render(ctx);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  await engine.initAll((frac, label) => {
    if (loadBar) loadBar.style.width = `${Math.round(frac * 100)}%`;
    if (loadText) loadText.textContent = label === 'ready' ? 'Ready' : `Preparing ${label}…`;
    engine.events.emit('loadProgress', { frac, label });
  });

  // Time of day before deployment, so the first frame the player sees is already lit for the
  // hour they chose. SkySystem rebuilds its scattering cube and the PMREM environment from
  // this, and LightingSystem reads the sun colour back out of it, so setting it later would
  // show one frame of 10:00 light whatever the menu said.
  const sky = engine.context.tryGet('sky') as { setTimeOfDay?: (h: number) => void } | undefined;
  sky?.setTimeOfDay?.(config.timeOfDay);

  // The scenario is passed explicitly rather than left to `scenario.ts` to read out of
  // `location.search`, which is what it did while that file could not be edited from here.
  const result = deployBattle(battle, engine.context, config, config.scenario);
  const f = result.cameraFocus;
  engine.rig.jumpTo(f.x, f.z, f.zoom, f.yaw);

  // After the armies are on the field, because the deployment zone is measured off them.
  deployment?.begin(config, playerFaction);
  // The opponent's phase, on this machine, so relayed operations for their army have
  // somewhere to land. Same call, other faction; the zone it measures is theirs.
  deploymentB?.begin(config, (netFactions[(link!.slot) ^ 1] ?? Faction.Germanic) as Faction);

  /*
   * The record's header and its three outlets, in the one place all four exist.
   *
   * `unitSizeScale` and the pool count are only final once the scenario has run, and the
   * deployment phase is only open one line above. `Siege` serves two of the outlets: the
   * machine orders that have no `orderIssued` shape, and the two wall countermands `H` has
   * to fire before the halt reaches `BattleSystem`.
   */
  replay.begin(config, config.quality, deployPhase);
  if (link) {
    /*
     * Both phases, indexed by the slot that owns them, so a relayed operation goes to the
     * instance bound to the faction that issued it. `bindDeployment(d)` alone would put the
     * challenger's regiments in the host's army.
     */
    if (deployment) replay.bindDeployment(deployment, link.slot);
    if (deploymentB) replay.bindDeployment(deploymentB, link.slot ^ 1);
    // And both hand their verbs to the relay rather than performing them. `nextUnitId++`
    // runs before `rng.fork('unit' + id)`, so a different interleaving of two players'
    // deployment operations mints different ids and forks different RNG streams.
    if (deployment) {
      deployment.relay = (ev) => {
        replay.relayDeploy(ev);
        // The relay needs to know both armies are laid out before it starts the clock, and a
        // commit op alone cannot tell it: it arrives in a turn packet that has to be emitted
        // to both clients *before* the phase flips, so the flag has to travel separately and
        // ahead of the flip. Same socket, so it can never overtake the op it belongs to.
        if (ev.verb === 'commit') link!.send({ k: 'deployReady' });
      };
    }
    if (deploymentB) deploymentB.relay = (ev) => replay.relayDeploy(ev);
  } else if (deployment) {
    replay.bindDeployment(deployment);
  }
  replay.bindMachines(battle.siege);
  replay.bindWall(battle.siege);
  /*
   * The handshake, here and not a line earlier.
   *
   * `unitSizeScale` and `pool.count` are only final once `deployBattle` has run, and both are
   * in the boot print — docs/MULTIPLAYER.md §7.7bis: the *effective* scale and the pool count
   * are what have to match, not the tier name, because `high` and `ultra` are bit-identical
   * while `high` and `low` are 8,632 men against 1,515.
   */
  if (session) {
    const print = session.announce(netFactions);
    console.log(`[net] boot print ${print.hash}/${print.uf64}/${print.uctl}, `
      + `${print.count0} men at scale ${print.unitScale}, libm ${print.libm}`);
  }
  if (replayRecord) {
    const from = params.get('from');
    const fromTick = from === null ? undefined : Math.max(0, Math.round(Number(from) * 30));
    if (!replay.play(replayRecord, { fromTick })) {
      if (loadText) loadText.textContent = replay.refusal;
    }
  }

  /**
   * Compare every cross-subsystem seam against the objects on the other side of it.
   *
   * Here and not in `initAll` because this is the first line at which every provider is
   * bound: `Siege` finds the projectile system lazily, the HUD finds the deployment phase
   * through `tryGet`, and the city's rasters are only final once the scenario has run. It
   * reads already-built state, costs under a millisecond and shouts on the console with both
   * field-name lists when two sides disagree. See `src/core/seams.ts` for why a check that
   * runs at runtime is the one that catches this — every one of these seams typechecks.
   */
  installSeamCheck(engine.context);

  /*
   * The session strip, outside the HUD's DOM and outside its update loop.
   *
   * `HudSystem` is a shared file with other agents live in it, and this needs nothing from it —
   * it reads `NetSession.status()` and writes one element. Driven off `loadProgress`' sibling,
   * the render loop, through a subsystem with only an `update`, so it is one registration
   * rather than an edit to somebody else's file.
   */
  if (session) {
    const panel = new NetPanel(document.body, session, engine.context);
    engine.add({ name: 'net-panel', order: 900, update: () => panel.update() });
  }

  if (harness) {
    loading?.remove();
  } else {
    loading?.classList.add('done');
    setTimeout(() => loading?.remove(), 1400);
  }

  engine.start();
  engine.events.emit('loadComplete', {});
}

// The harness contract: everything a headless driver needs, and nothing more.
declare global {
  interface Window {
    __game?: {
      engine: Engine;
      battle: BattleSystem;
      ready: boolean;
      /** Run the sim forward `seconds` without waiting on real time. */
      advance(seconds: number): void;
      /**
       * The same fast-forward with the rasterisation left out, which is the whole of its cost.
       *
       * `advance` draws every synthetic frame — sixty per simulated second at its default step
       * — and on the full-scale Carthage storm that is minutes of wall clock per minute of
       * battle, which is why no probe had ever reached the end of one. This skips the submit
       * and nothing else, so the simulation is bit-identical and roughly twenty times faster.
       * It leaves the canvas showing the frame before the call, so screenshot after a real
       * frame has run, not straight after this.
       */
      fastForward(seconds: number, stepMs?: number): void;
      /**
       * Run **exactly** `ticks` more fixed steps, at whatever frame schedule `stepMs` asks
       * for. The one entry point a replay comparison can use: equal elapsed seconds is not
       * equal tick counts (see `Engine.advanceTicks`), and the record is keyed to ticks.
       */
      advanceTicks(ticks: number, stepMs?: number): number;
      /** Park the camera for a repeatable screenshot. */
      setCamera(x: number, z: number, zoom: number, yaw: number): void;
      /** Sim seconds elapsed. */
      simTime(): number;
      /**
       * The pre-battle deployment phase, or null when this run has none.
       *
       * Published so a headless driver can *observe* the phase — is it live, what does it
       * think its zone is, how much pool is left. Driving it from here would be testing the
       * API rather than the feature, which is a gap this project has shipped before, so the
       * checks in `tools/qa-deploy.mjs` go through real mouse and keyboard events and only
       * read through this.
       */
      deployment: DeploymentSystem | null;
      /**
       * The determinism marks, computed by the product.
       *
       * `tools/qa-determinism.mjs` used to inject the whole of this arithmetic as a template
       * string, so the project's canonical state hash lived only in a test tool and a second
       * consumer had to copy it. `tools/qa-replay.mjs` is that second consumer. See
       * `src/sim/stateHash.ts`; the arithmetic is unchanged to the bit, because twenty-one
       * pinned hashes are keyed to it.
       */
      hashes(): ReturnType<typeof stateHashes>;
      /** The exact field lists the two unit hashes cover, so a localiser reads the same set. */
      hashFields(): { f64: readonly string[]; ctl: readonly string[] };
      /** The order log. Save, share, watch, and take command from here. */
      replay: ReplaySystem;
      /**
       * The relayed session, or null in single player.
       *
       * Published for `tools/qa-net.mjs`, which drives two of these at once and reads the
       * status, the latency samples and the desync report off both. Read-only by convention
       * for the same reason `deployment` is: every order the gate issues goes through real
       * mouse and keyboard events, because a gate that drives the API is testing the API.
       */
      net: NetSession | null;
    };
  }
}

window.__game = {
  engine,
  battle,
  ready: false,
  advance: (seconds: number) => engine.advance(seconds),
  /*
   * The step stays at `advance`'s own default, and that is not a detail to tune away.
   *
   * Measured on the Carthage assault, three independent loads advanced by one schedule and
   * hashed at t+30/90/150/200: `advance(dt, 1000/60)` and `advance(dt, 1000/60, {render:
   * false})` agree on every bit at every checkpoint, so skipping the submit is free. But
   * `advance(dt, 166)` — the "five ticks a frame, four times cheaper" idiom several siege
   * probes use — produces *different hashes*, and so does an exactly-five-tick 1000/6 step
   * that lands on the same total elapsed time. The tick count is not the whole of it; how
   * many ticks share a frame reaches the simulation somehow. Same survivor count, different
   * battle.
   *
   * So a coarse step is not a free speed-up, it is a different run, and a fast-forward that
   * took one would quietly stop being comparable with `qa-determinism`. This one is only ever
   * the same battle, sooner.
   *
   * **Annotated 21 August 2026 — right conclusion, wrong reason, and there is now a third
   * option.** A coarse step at the same elapsed time runs a different *number of ticks* — 900
   * at 1000/60, 901 at 166 ms, 899 at an exactly-five-tick 1000/6, because `double(1/6)` is
   * about 7e-18 short of five times `double(1/30)` and `maxStepsPerFrame = 5` means the lost
   * tick is never made up. Frame grouping itself does not reach the simulation: held to an
   * equal tick count, five ticks a frame and one tick every two frames are bit-identical on
   * the pool hash, both unit hashes and `BattleFlow.result` across a 6,783-tick battle with
   * real recorded player orders in it (`tools/qa-replay.mjs`). If what you want is the same
   * battle *cheaper*, ask for ticks: `advanceTicks` below does exactly n of them at whatever
   * frame schedule you like.
   */
  fastForward: (seconds: number, stepMs = 1000 / 60) =>
    engine.advance(seconds, stepMs, { render: false }),
  setCamera: (x, z, zoom, yaw) => engine.rig.jumpTo(x, z, zoom, yaw),
  advanceTicks: (ticks: number, stepMs = 1000 / 60) =>
    engine.advanceTicks(ticks, stepMs, { render: false }),
  simTime: () => engine.time.simTime,
  deployment,
  hashes: () => stateHashes(battle.pool, battle.units),
  hashFields: () => ({ f64: UNIT_F64_FIELDS, ctl: UNIT_CTL_FIELDS }),
  replay,
  net: session,
};

boot()
  .then(() => {
    window.__game!.ready = true;
  })
  .catch((err) => {
    console.error('[boot] failed:', err);
    if (loadText) {
      loadText.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      loadText.style.color = '#e2564b';
    }
  });
