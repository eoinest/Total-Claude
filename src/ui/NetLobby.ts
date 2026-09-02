/**
 * The lobby: make a room, or join one.
 *
 * Reached from the front door, or directly at `?mp=1`. It turns a relay address and a room
 * code into the URL that boots a relayed battle — because everything else about the pairing is
 * settled by the handshake, which is the only party that can see both clients.
 *
 * ## Three faults stacked, and none of them was in this file's logic
 *
 * This form was measured, with a real mouse, and it had never been usable by one. The three
 * are worth naming because each is a different lesson and only the third is a bug in the
 * ordinary sense:
 *
 * 1. **The panel was called `card`.** `hud.css`'s `.card` is the unit card, it is loaded on
 *    every page, and it contributes `max-width: 9em`, `max-height: 14em` and a column flex.
 *    `max-width` clamps regardless of specificity, so the lobby's `width: min(620px, 92vw)`
 *    computed to 620 and rendered at **135**. Every control landed below y=1059. That rule
 *    carries the comment *"A card is a card. Nothing about a broken parent may let one become
 *    a panel"* — and the reverse is what happened. Every class in here is `tc-`-prefixed now:
 *    a global stylesheet is a shared namespace and this file does not get to pick common nouns
 *    out of it.
 * 2. **The page could not scroll to what was pushed off it.** `scrollHeight` 800 against an
 *    `innerHeight` of 800: the controls were not below the fold, they were *unreachable*, and
 *    a full-page screenshot could not show them either. A fixed, centred overlay must be a
 *    scroll container and must centre in a way that does not clip its own top when the content
 *    outgrows the viewport — hence `.tc-fit` with `min-height: 100%` rather than
 *    `place-items: center`, which clips.
 * 3. **`#menu-root` is `pointer-events: none` and this never opted back in.** `.menu` does;
 *    `menu.css`'s own comment explains why the container must not hit-test. The lobby inherited
 *    the container and not the opt-in, so `elementFromPoint` over the middle of the panel
 *    returned `canvas#viewport` and a real click on any control timed out.
 *
 * ## Why this carries its own styles
 *
 * `menu.css` and `hud.css` are shared files with several agents live in them, and a lobby that
 * needed a stylesheet edit would be a merge conflict on somebody else's afternoon. The overlay
 * is self-contained and borrows the menu's palette by eye.
 *
 * ## The relay address is not a question to ask a player
 *
 * It used to be the second field on this panel, under its own heading, filled in for you. The
 * owner read it and asked *"i am a bit confused about the relay address? we should be able to
 * run things on lan directly from browser."* — and he was right to, because the field was never
 * broken and that is exactly the problem with it. Under `npm run host` it fills itself in
 * correctly and nobody ever has to touch it, so what it contributes is a transport detail at
 * the player's eye level in a screen that is otherwise about two people and a code.
 *
 * Worse than useless in one case and misleading in another:
 *
 *   - Under **`npm run dev`** it auto-filled `ws://localhost:5959` — a plausible, well-formed,
 *     correct-looking address with **no process behind it**, because `npm run dev` starts a
 *     Vite and nothing else. A guess that looks like an answer is worse than an empty field.
 *   - On the **deployed site** it was correctly empty with a sentence saying why. Right, and
 *     still presented as a form field the player was expected to fill in.
 *
 * So the address is now a **fact the server states**, never a guess, and the panel shows it to
 * nobody who does not go looking:
 *
 *   1. `?net=` in the URL — somebody's explicit decision, usually an invite link.
 *   2. `<meta name="tc-lan">` / `<meta name="tc-relay">`, written by `tools/lib/vite-runner.mjs`
 *      when — and only when — a relay was started beside this server. See `readRelayPort`.
 *   3. `localStorage`, which is this browser's own earlier decision.
 *   4. Nothing. **There is no fourth source and there is no guess.**
 *
 * And a stated fact is still checked: `relayAnswers` asks the relay's own `/health` before the
 * lobby believes any of the four, because `npm run host` spawns two processes and either can
 * die on its own. A tag that says a relay was asked for is not a relay.
 *
 * With an address that answers, the panel is a room code, a Create and a Join, and says nothing
 * about transport at all. With no address it says so where the player is looking, names
 * `npm run host`, and does **not** offer an empty field as though filling it were the fix. The
 * field itself survives, one disclosure click away, because pointing at a relay on another
 * machine or another port is a real thing this design cares about — `npm run host --
 * --relay-port=` exists — and demoting a capability is not the same as deleting it.
 *
 * ## The invite link, and the one thing the page cannot work out for itself
 *
 * The previous pass established that an invite built from `location.href` on a loopback origin
 * is a link to the *recipient's* machine, and withheld it. That was right and it is kept. What
 * it could not do is tell the difference between two loopback origins that are not alike:
 *
 *   - `npm run dev`, bound to `127.0.0.1` and nothing else. There is no invite to build and
 *     there is no address to build one from. Withhold, and say so.
 *   - `npm run host`, bound to `0.0.0.0`, serving this same page at `192.168.0.238:5958` as
 *     well — where a host who typed `localhost` into their own bar sees a loopback origin and
 *     the machine next door has a perfectly good address to be sent. Withholding here is
 *     honest about the URL bar and wrong about the world.
 *
 * `<meta name="tc-lan">` is how the second case identifies itself: a plaque
 * `tools/lib/vite-runner.mjs` writes into the document **only** on a non-loopback bind (see
 * `lanPlaque` there). Present, it names the address and the relay port and the invite is built
 * out of those. Absent — deployed site, plain dev server, anything else — nothing changes and
 * the refusal is the one the previous pass wrote. The default is still to withhold; what moved
 * is the set of cases in which a link genuinely exists, not the willingness to claim one that
 * does not.
 */

import { CODE_ALPHABET, CODE_LEN, validCode } from '../net/protocol';

const KEY = 'tc.net.relay';

/**
 * Styles, `tc-`-prefixed without exception. See fault 1 in the file docstring.
 *
 * `.tc-lobby` is the scroll container and `.tc-fit` is the thing that centres inside it. The
 * pair, rather than `place-items: center` on the container, because a centred grid or flex item
 * taller than its box overflows *equally in both directions* and the top half becomes
 * unreachable — which is the shape of fault 2, and it would come back the first time somebody
 * opened this at 700 px with a long error in it.
 */
const CSS = `
.tc-lobby{position:fixed;inset:0;z-index:120;overflow:auto;pointer-events:auto;
  background:radial-gradient(120% 90% at 50% 0%,#241a12 0%,#0d0a08 70%);
  font:400 15px/1.5 ui-serif,Georgia,serif;color:#e8dcc6}
.tc-lobby .tc-fit{box-sizing:border-box;min-height:100%;display:flex;align-items:center;
  justify-content:center;padding:32px 16px}
.tc-lobby .tc-sheet{box-sizing:border-box;width:min(620px,92vw);padding:30px 34px 26px;
  border:1px solid #6b5735;border-radius:3px;background:linear-gradient(#1d1610,#14100c);
  box-shadow:0 18px 60px #000a}
.tc-lobby h1{margin:0 0 6px;font:600 26px/1.1 ui-serif,Georgia,serif;letter-spacing:.06em;
  color:#e9c877;text-transform:uppercase}
.tc-lobby p{margin:0 0 18px;color:#a89a7d;font-size:13.5px}
.tc-lobby label{display:block;margin:14px 0 5px;font-size:11.5px;letter-spacing:.14em;
  text-transform:uppercase;color:#a3906a}
.tc-lobby input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #5c4a2d;
  border-radius:2px;background:#0e0b08;color:#f0e6d2;font:400 15px/1.3 ui-monospace,monospace;
  letter-spacing:.08em}
.tc-lobby input:focus{outline:none;border-color:#c9a24a;box-shadow:0 0 0 2px #c9a24a33}
.tc-lobby input#tc-room{padding:12px 14px;font-size:27px;letter-spacing:.42em;
  text-align:center;text-indent:.42em;color:#f4e7c6}
.tc-lobby .tc-hint{margin:6px 0 0;font-size:12px;color:#8e7f63;min-height:1.4em}
.tc-lobby .tc-hint.tc-bad{color:#e2564b}
.tc-lobby .tc-row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
.tc-lobby button{flex:1 1 12em;padding:11px 14px;border:1px solid #7a6238;border-radius:2px;
  background:linear-gradient(#3a2c1a,#241a10);color:#f0dfb4;font:600 13px/1 ui-serif,Georgia,serif;
  letter-spacing:.13em;text-transform:uppercase;cursor:pointer}
.tc-lobby button:hover:not(:disabled){border-color:#c9a24a;color:#fff3d4}
.tc-lobby button:disabled{opacity:.45;cursor:default}
.tc-lobby button.tc-ghost{flex:0 1 auto;background:#1a140e;color:#cdbb95;font-weight:500}
.tc-lobby .tc-note{margin-top:16px;font-size:13px;color:#bfae8c;overflow-wrap:anywhere}
.tc-lobby .tc-note:empty{margin-top:0}
.tc-lobby .tc-note b{color:#e9c877}
.tc-lobby .tc-note.tc-bad{color:#e2564b}
.tc-lobby .tc-blocked{margin:2px 0 20px;padding:14px 16px;border:1px solid #7d5236;
  border-radius:3px;background:#20140d;color:#e6cdaf;font-size:13.5px;line-height:1.6}
.tc-lobby .tc-blocked b{color:#f0bd85}
.tc-lobby .tc-blocked[hidden]{display:none}
.tc-lobby details.tc-adv{margin-top:26px;padding-top:16px;border-top:1px solid #3a2e1e}
.tc-lobby details.tc-adv > summary{cursor:pointer;list-style:none;font-size:11.5px;
  letter-spacing:.14em;text-transform:uppercase;color:#8e7f63}
.tc-lobby details.tc-adv > summary::-webkit-details-marker{display:none}
.tc-lobby details.tc-adv > summary::before{content:'\\25B8\\00a0'}
.tc-lobby details.tc-adv[open] > summary::before{content:'\\25BE\\00a0'}
.tc-lobby details.tc-adv > summary:hover{color:#e9c877}
.tc-lobby details.tc-adv label{margin-top:14px}
.tc-lobby .tc-code{margin:4px 0 10px;padding:18px 10px;border:1px solid #6b5735;
  border-radius:3px;background:#0e0b08;color:#f4e7c6;text-align:center;
  font:600 40px/1.1 ui-monospace,monospace;letter-spacing:.34em;text-indent:.34em;
  user-select:all;-webkit-user-select:all}
.tc-lobby .tc-back{margin-top:20px;display:inline-block;color:#8e7d5f;font-size:12.5px;
  text-decoration:none;letter-spacing:.1em;text-transform:uppercase}
.tc-lobby .tc-back:hover{color:#e9c877}
.tc-lobby a:focus-visible,.tc-lobby button:focus-visible,.tc-lobby summary:focus-visible,
.tc-lobby a:focus,.tc-lobby button:focus,.tc-lobby summary:focus{outline:2px solid #c9a24a;
  outline-offset:3px;border-radius:2px}
`;

const httpOf = (ws: string): string => ws.replace(/^ws/, 'http');

/**
 * Escaped for `innerHTML`. Relay addresses and refusal text both reach the page this way.
 *
 * Exported because `main.ts` builds the lines for `showNetNotice` and every one of them
 * contains a value out of the query string.
 */
export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

/**
 * A hostname only this machine can reach.
 *
 * Used twice and for the same judgement in both places: an invite link built out of one of
 * these is a link to *the recipient's own computer*, which is the single most confusing thing
 * this form could hand somebody. Better to withhold the link and say why than to produce a
 * dead one that looks alive.
 */
const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  || host.endsWith('.localhost');

const hostOf = (addr: string): string => {
  try { return new URL(addr).hostname; } catch { return ''; }
};

/**
 * What `tools/lib/vite-runner.mjs` serves at `/__tc/lan` when — and only when — it is bound to
 * an address other than loopback. See the file docstring.
 */
export interface LanPlaque {
  tc: 'host-lan';
  /** The IPv4 address the machine next door reaches this server at. */
  lan: string;
  iface: string;
  /** `<hostname>.local`. Mac to Mac it outlives a DHCP lease and the number does not. */
  mdns: string;
  gamePort: number;
  gameUrl: string;
  /** `null` when the host started a server without a relay beside it. Do not guess a port. */
  relayPort: number | null;
  relayUrl: string | null;
}

const looksLikePlaque = (j: unknown): j is LanPlaque => {
  const p = j as Partial<LanPlaque> | null;
  return !!p && p.tc === 'host-lan' && typeof p.lan === 'string' && !!p.lan
    && !isLoopback(p.lan) && typeof p.gameUrl === 'string' && !!p.gameUrl;
};

/**
 * Whether this origin is also being served on a LAN address, read out of the document.
 *
 * `<meta name="tc-lan">`, written by `tools/lib/vite-runner.mjs` on a non-loopback bind and by
 * nothing else. Absent almost everywhere — the deployed site, `npm run dev`,
 * `npm run host -- --loopback` — and absent is the answer that keeps the honest refusal.
 *
 * **Not a `fetch`, and that is not a preference.** The first version asked `/__tc/lan` and got
 * a 404 on every origin without one, and Chromium writes *"Failed to load resource: the server
 * responded with a status of 404"* into the console for a failed `fetch` whatever the caller
 * does with the promise. `qa-net`'s `lobby-console` arm went red on it, which was the correct
 * verdict: the lobby would have started logging an error on the deployed site to ask a question
 * it already knew the answer to. A fact the server knows while it is writing the document
 * belongs in the document.
 *
 * Exported, and takes its `Document`, so the parse can be exercised without a lobby around it.
 * `tools/qa-net.mjs`'s `lan` arm asserts the *behaviour* — the link that comes out the other
 * end, and its absence — rather than this function, because the behaviour is the claim.
 */
export function readLanPlaque(doc: Document = document): LanPlaque | null {
  const raw = doc.querySelector('meta[name="tc-lan"]')?.getAttribute('content');
  if (!raw) return null;
  try {
    const j: unknown = JSON.parse(raw);
    return looksLikePlaque(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * The sentence that turns a refusal into an instruction.
 *
 * It is appended to both withheld-link cases and to the relay field's own hint, because both
 * are the same situation seen from different ends: something on this machine is bound to
 * `127.0.0.1` and the machine next door cannot reach it. One command fixes both, and a screen
 * that explains why it cannot help without naming the thing that can is only half honest.
 */
const LAN_REPAIR = 'To play across two machines on the same network, stop this server and run '
  + '<code>npm run host</code> instead &mdash; it serves the game and the relay on an address '
  + 'the other machine can reach, and prints the URL to hand over.';

/**
 * `<meta name="tc-relay">` — the port of the relay this page's server started beside itself.
 *
 * The companion to `readLanPlaque`, and the smaller of the two facts: the plaque says *what
 * address the other machine uses* and only exists on a LAN bind, while this says *a relay was
 * started here* and is written on any bind that started one. `npm run host -- --loopback` has
 * no plaque and does have this.
 *
 * A port and not a URL, because the host part is `location.hostname` and that is right in two
 * browser tabs at once: the same `npm run host` serves this document at `127.0.0.1:5958` and at
 * `192.168.0.238:5958`, and each of them composes the relay address that works for it. A single
 * absolute URL in the tag would have to pick one and be wrong in the other tab.
 *
 * Absent under `npm run dev`, on the deployed site, and on any origin that is not one of ours —
 * and **that absence is the product**. It is the difference `defaultRelay()` could not see when
 * it guessed `ws://<this host>:5959` into the field and handed a `npm run dev` player an
 * address with nothing behind it.
 *
 * Exported and takes its `Document` for the same reason `readLanPlaque` does.
 */
export function readRelayPort(doc: Document = document): number | null {
  const raw = doc.querySelector('meta[name="tc-relay"]')?.getAttribute('content');
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Where an address came from, which decides what to say when it does not answer.
 *
 * `'server'` and `'none'` are the two that matter. Everything the player sees on a fresh visit
 * is one of them, and they are the two the old code could not tell apart.
 */
export type RelaySource = 'url' | 'server' | 'remembered' | 'none';

export interface RelayChoice {
  value: string;
  source: RelaySource;
}

/**
 * The relay address, from the highest-ranked source that has one. **Never a guess.**
 *
 * Four sources, in this order, and the ordering is the whole design:
 *
 *   1. **`?net=`** — an explicit decision, and usually somebody else's: it is what an invite
 *      link carries and what `netFailed`'s way back to the lobby carries. Nothing outranks a
 *      link the player just followed.
 *   2. **The server**, through the plaque or `<meta name="tc-relay">`. `plaque.relayUrl` is
 *      preferred over composing one from the port because the plaque names the *LAN* address,
 *      which is the one that has to survive being pasted into an invite — a host reading this
 *      page at `localhost` can reach their own relay either way, and the machine next door
 *      cannot.
 *   3. **`localStorage`** — this browser's own earlier decision, so nobody types an address
 *      twice. It ranks *below* the server on purpose: a remembered `ws://localhost:5959` from
 *      some previous session must not shadow the relay this very command just started.
 *   4. **Nothing**, and this is a real answer rather than a failure to find one.
 *
 * `relayWasGuessed`, which the previous pass needed to decide when the plaque was allowed to
 * overrule the field, has no successor here: there is no longer anything for the plaque to
 * overrule, because the guess it existed to catch does not get made.
 */
export function resolveRelay(
  params: URLSearchParams,
  plaque: LanPlaque | null,
  port: number | null,
  stored: string | null
): RelayChoice {
  const fromUrl = (params.get('net') ?? '').trim();
  if (fromUrl) return { value: fromUrl, source: 'url' };
  if (plaque?.relayUrl) return { value: plaque.relayUrl, source: 'server' };
  if (port !== null) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return { value: `${scheme}://${location.hostname || '127.0.0.1'}:${port}`, source: 'server' };
  }
  const remembered = (stored ?? '').trim();
  if (remembered) return { value: remembered, source: 'remembered' };
  return { value: '', source: 'none' };
}

/**
 * Is a relay actually listening there? Asked of the relay's own `/health`, once, on mount.
 *
 * **A stated fact is still checked.** `npm run host` spawns the game server and the relay as
 * two processes; the tag that says a relay was started is written by the first of them and
 * knows nothing about whether the second is still alive. Believing the tag would reintroduce
 * the failure this whole change is about, one level up: a lobby that looks ready and is not.
 *
 * `/health` and not `/new`, because a probe must not mint a room. `tools/relay.mjs` answers it
 * with `relay ok rooms=…` and `access-control-allow-origin: *`, so this is one round trip and
 * about a millisecond on a LAN.
 *
 * It costs the browser's network log one line when it fails, and that is accepted here where it
 * was not for `/__tc/lan`: this fires only when *something already named an address*, which is
 * exactly the situation in which the player needs to be told nothing is there. A page with no
 * address makes no request at all, which is why the deployed site and `npm run dev` stay silent
 * and `qa-net`'s `lobby-console` and `lan-console` arms stay green.
 */
const relayAnswers = async (ws: string, ms = 3000): Promise<boolean> => {
  try {
    const r = await fetch(`${httpOf(ws)}/health`, { signal: AbortSignal.timeout(ms) });
    return r.ok && (await r.text()).startsWith('relay ok');
  } catch {
    return false;
  }
};

/**
 * Whether the thing that served this page is one of ours, which changes the repair sentence.
 *
 * A loopback origin is by definition this machine, and either meta tag is `vite-runner.mjs`
 * signing its own work. Neither — an origin somewhere else that has told us nothing about
 * itself — is the deployed site's shape, and the honest thing to say there is that this page
 * cannot be a relay because it is a static upload with no server in it.
 */
const servedByUs = (plaque: LanPlaque | null, port: number | null): boolean =>
  !!plaque || port !== null || isLoopback(location.hostname);

/** The command, and where to run it. Two endings because the two situations differ. */
const RUN_HOST_HERE = 'Stop this server and run <code>npm run host</code> instead: one command '
  + 'serves the game <i>and</i> a relay together, on an address the other machine can reach, '
  + 'and prints the URL to hand over.';
const RUN_HOST_THERE = 'Run <code>npm run host</code> on either of your two machines, from a '
  + 'checkout of this project, and open the URL it prints on both of them.';

/**
 * Why no match can start from here — said where the player is looking, not in a field label.
 *
 * The second branch keeps the sentence the deployed site already had, because it is the right
 * one: naming what this page *is* explains why no amount of typing into it will help.
 */
const noRelayHere = (ours: boolean): string =>
  '<b>There is no relay behind this page, so a battle cannot start from it.</b> Every order '
  + 'goes through a relay &mdash; that is what makes the two simulations one battle rather than '
  + 'two &mdash; and a relay is a separate process. '
  + (ours
    ? `This server is serving the game and nothing else. ${RUN_HOST_HERE}`
    : `This page cannot be one, because it is a static upload with no server in it. ${RUN_HOST_THERE}`);

/** An address that was named by something and is not answering. Who named it matters. */
const relayWentQuiet = (addr: string, source: RelaySource, ours: boolean): string =>
  `<b>No answer from ${esc(addr)}.</b> `
  + (source === 'server'
    ? 'This server said it had started a relay there, and nothing is listening on it now &mdash; '
      + 'so the relay stopped, or never came up. '
    : source === 'remembered'
      ? 'That is the relay this browser used last time, and nothing is listening on it now. '
      : 'That address arrived with the link that opened this page, and nothing is listening on '
        + 'it. ')
  + (ours ? RUN_HOST_HERE : RUN_HOST_THERE);

/**
 * The URL that boots a relayed battle. One builder, so the invite and the host agree.
 *
 * `from` is the page the link should open — `location.href` for the host's own navigation, and
 * the LAN address for an invite when this origin is loopback and the plaque names one. The
 * *path* is taken from `from` too, so a build served under a sub-path keeps it.
 */
const battleUrl = (relay: string, code: string, asHost: boolean, from = location.href): URL => {
  const u = new URL(from);
  u.search = '';
  u.searchParams.set('net', relay);
  u.searchParams.set('room', code);
  // The host still has a battle to choose, and `startStep` opens on the setup sheet for any
  // URL that names one. The challenger has nothing to choose and waits for the host's config.
  if (asHost) u.searchParams.set('menu', 'battle');
  else u.searchParams.set('host', '0');
  return u;
};

/** The shell every lobby screen is drawn into. Returns the sheet to fill. */
function mount(host: HTMLElement): HTMLElement {
  if (!document.getElementById('tc-lobby-css')) {
    const style = document.createElement('style');
    style.id = 'tc-lobby-css';
    style.textContent = CSS;
    document.head.append(style);
  }
  const existing = host.querySelector('.tc-lobby');
  if (existing) existing.remove();
  const root = document.createElement('div');
  root.className = 'tc-lobby';
  root.innerHTML = '<div class="tc-fit"><div class="tc-sheet"></div></div>';
  host.append(root);
  return root.querySelector('.tc-sheet') as HTMLElement;
}

/**
 * A refusal, in the register of the rest of them: what happened, why, and a way onward.
 *
 * Exported because `main.ts` needs it. Before this, a relay that did not answer produced a
 * `throw` at the top level of the module — which is an unhandled rejection, which every
 * harness in `tools/` collects as a `pageerror`, and which `main.ts`'s own comment fourteen
 * lines above it forbids for exactly this reason. What the player saw was the loading splash
 * shouting a stack-adjacent sentence in red capitals at them with no button on the screen.
 *
 * It never returns: the caller is expected to stop, and stopping by resolving nothing is the
 * pattern `?mp=1` already uses.
 */
export function showNetNotice(host: HTMLElement, o: {
  title: string;
  lines: string[];
  /** Offered as the primary way out. Defaults to the lobby, carrying what was typed. */
  back?: { label: string; href: string };
}): void {
  const sheet = mount(host);
  const back = o.back ?? { label: 'Back to the lobby', href: '?mp=1' };
  sheet.innerHTML = `<h1>${esc(o.title)}</h1>`
    + o.lines.map((l) => `<p>${l}</p>`).join('')
    + `<div class="tc-row"><a class="tc-back" id="tc-notice-back" href="${esc(back.href)}"
         style="margin-top:6px">&lsaquo; ${esc(back.label)}</a></div>`;
  (sheet.querySelector('#tc-notice-back') as HTMLElement | null)?.focus();
}

export function showLobby(host: HTMLElement): void {
  const sheet = mount(host);
  const params = new URLSearchParams(location.search);
  const plaque = readLanPlaque();
  const declaredPort = readRelayPort();
  const ours = servedByUs(plaque, declaredPort);
  const chosen = resolveRelay(params, plaque, declaredPort, localStorage.getItem(KEY));

  /*
   * The transport lives in a `<details>`, and the summary is the only part of it on screen.
   *
   * Not `hidden`, and not a second screen: a closed disclosure is one click and no navigation,
   * it keeps the field in the accessibility tree and in the DOM, and a host who genuinely needs
   * to point at another machine's relay finds it exactly where "advanced" always is. What it
   * stops being is the second thing a player reads on a screen about two people and a code.
   */
  sheet.innerHTML = `
    <h1>Two commanders</h1>
    <p>One battle, both armies, on two machines. One of you opens a room and reads the code
       out; the other types it in. The host chooses the ground and the orders of battle; the
       challenger takes the other side.</p>
    <div class="tc-blocked" id="tc-no-relay" role="status" hidden></div>
    <label for="tc-room">Room code</label>
    <input id="tc-room" spellcheck="false" autocomplete="off" autocapitalize="characters"
      inputmode="latin" maxlength="${CODE_LEN}" placeholder="${'—'.repeat(CODE_LEN)}"
      aria-describedby="tc-room-hint">
    <p class="tc-hint" id="tc-room-hint"></p>
    <div class="tc-row">
      <button type="button" id="tc-host">Create a room</button>
      <button type="button" id="tc-join">Join that room</button>
    </div>
    <div class="tc-note" id="tc-note"></div>
    <details class="tc-adv" id="tc-adv">
      <summary id="tc-adv-summary">Relay on another machine or port</summary>
      <label for="tc-relay">Relay address</label>
      <input id="tc-relay" spellcheck="false" autocomplete="off"
        aria-describedby="tc-relay-hint" placeholder="ws://host:port">
      <p class="tc-hint" id="tc-relay-hint">Every order goes through a relay, which is what
         makes the two simulations one battle rather than two. <code>npm run host</code> starts
         one beside the game and fills this in for you, so you should not normally need it.
         <code>node tools/relay.mjs</code> starts a relay on its own &mdash; on another port,
         or on a third machine you can both reach &mdash; and its address goes here.</p>
    </details>
    <a class="tc-back" href="?">&lsaquo; Back to the front door</a>`;

  const relay = sheet.querySelector('#tc-relay') as HTMLInputElement;
  const room = sheet.querySelector('#tc-room') as HTMLInputElement;
  const hint = sheet.querySelector('#tc-room-hint') as HTMLElement;
  const note = sheet.querySelector('#tc-note') as HTMLElement;
  const hostBtn = sheet.querySelector('#tc-host') as HTMLButtonElement;
  const joinBtn = sheet.querySelector('#tc-join') as HTMLButtonElement;
  const blocked = sheet.querySelector('#tc-no-relay') as HTMLElement;
  const relayHint = sheet.querySelector('#tc-relay-hint') as HTMLElement;
  const adv = sheet.querySelector('#tc-adv') as HTMLDetailsElement;

  relay.value = chosen.value;
  room.value = (params.get('room') ?? '').toUpperCase();

  /*
   * Where the address came from, said inside the disclosure and nowhere else.
   *
   * The previous pass wrote this sentence into a hint under a field everybody could see, which
   * was the right sentence in the wrong place: it is an answer to "why does this say what it
   * says", and only somebody who has opened the panel has asked.
   */
  if (chosen.source === 'server' && plaque?.relayUrl) {
    relayHint.innerHTML = `This machine is serving the game and a relay on <b>${esc(plaque.lan)}</b> `
      + `(${esc(plaque.iface)}), which is the address the other commander can reach, and that is `
      + 'what this field has been set to. Anything you type here wins.';
  } else if (chosen.source === 'server') {
    relayHint.innerHTML = 'The server that sent you this page started a relay beside itself on '
      + `port <b>${declaredPort}</b>, and that is what this field has been set to. Anything you `
      + 'type here wins.';
  } else if (chosen.source === 'remembered') {
    relayHint.innerHTML = 'This is the relay address this browser used last time. Nothing on '
      + 'this page chose it &mdash; clear the field to forget it.';
  }

  /*
   * One gate for both buttons, and one place that decides whether this lobby can do anything.
   *
   * `usable` starts optimistic when an address exists, because the probe below is a round trip
   * and a panel that greys itself out for 3 ms and then comes back is worse than one that never
   * did. It only ever moves *downwards* from a fact: `relayAnswers` came back empty, or the
   * player emptied the field themselves.
   */
  let usable = chosen.value !== '';
  blocked.innerHTML = noRelayHere(ours);
  const gate = (): void => {
    hostBtn.disabled = !usable;
    joinBtn.disabled = !usable || !validCode(room.value);
    blocked.hidden = usable;
  };

  /*
   * The probe, and the two reasons it does not run on every visit.
   *
   * It runs when something named an address and not otherwise, so a page with no relay behind
   * it makes no request at all — no console line on the deployed site, none under
   * `npm run dev`, and `qa-net`'s two console arms stay green for the reason they were written.
   *
   * The guard on `relay.value` is for the host who opened the disclosure and typed their own
   * address inside the three seconds: the answer to a question about the old address must not
   * land on the new one.
   */
  if (chosen.value) {
    void relayAnswers(chosen.value).then((alive) => {
      if (alive || relay.value.trim() !== chosen.value) return;
      blocked.innerHTML = relayWentQuiet(chosen.value, chosen.source, ours);
      usable = false;
      gate();
    });
  }

  /*
   * An address typed into the disclosure is a decision, and it re-arms the form immediately.
   *
   * Not probed: CREATE is one keystroke away and already reports an unreachable relay by name,
   * with the address in the sentence, from `/new`'s own failure. A second probe here would say
   * the same thing twice and write a console line per keystroke.
   */
  relay.addEventListener('input', () => {
    usable = relay.value.trim() !== '';
    gate();
  });

  const say = (html: string, bad = false): void => {
    note.innerHTML = html;
    note.classList.toggle('tc-bad', bad);
  };

  /*
   * The field used to eat characters and say nothing about it.
   *
   * `ROMEX` became `RMEX`, because `O` is not in `CODE_ALPHABET` — and the alphabet exists
   * *because* codes get read aloud, so `O` for `0` is the single likeliest thing a person will
   * type. Silently deleting it turns a five-character code into a four-character one and hands
   * the blame to the typist. The filter stays, so the field always holds something valid and no
   * submission can fail on shape; what is new is that it says what it took and why.
   */
  const refused = new Set<string>();
  const clean = (): void => {
    const raw = room.value.toUpperCase();
    const kept = [...raw].filter((c) => CODE_ALPHABET.includes(c)).join('');
    for (const c of raw) if (!CODE_ALPHABET.includes(c)) refused.add(c);
    if (!kept) refused.clear();
    if (kept !== room.value) room.value = kept;
    gate();
    const left = CODE_LEN - kept.length;
    const progress = kept.length === 0
      ? `${CODE_LEN} characters. Leave it empty and Create will pick one for you.`
      : left > 0
        ? `${left} more character${left > 1 ? 's' : ''}.`
        : 'Both of you need this exact code.';
    /*
     * The complaint outlives the keystroke that caused it, and that is the whole point.
     *
     * `input` fires per character, so the first version wrote the explanation on the press of
     * `O` and overwrote it with "3 more characters" on the press of `M` a fifth of a second
     * later. Nobody reads a sentence that is on screen for 200 ms — measured: typing ROMEX at
     * 30 ms a key left the field reading RMEX with a hint that said nothing had gone wrong.
     * The set holds until the field is cleared.
     */
    if (!refused.size) {
      hint.classList.remove('tc-bad');
      hint.textContent = progress;
      return;
    }
    const list = [...refused].map((c) => `\u201c${c}\u201d`);
    hint.classList.add('tc-bad');
    hint.textContent = `${list.join(', ')} ${refused.size > 1 ? 'are' : 'is'} not in a room `
      + 'code \u2014 I, O, 0 and 1 are left out on purpose, because a code gets read aloud. '
      + progress;
  };
  room.addEventListener('input', clean);
  clean();

  const go = (code: string, asHost: boolean): void => {
    localStorage.setItem(KEY, relay.value.trim());
    location.href = battleUrl(relay.value.trim(), code, asHost).toString();
  };

  /** What to say when the relay does not answer — and it depends on where the page came from. */
  const noRelay = (addr: string, why: string): void => {
    say(`No answer from <b>${esc(addr)}</b> &mdash; ${esc(why)}. `
      + (ours
        ? 'Start one with <code>node tools/relay.mjs</code> and press Create again &mdash; or '
          + 'stop this server and run <code>npm run host</code>, which starts both halves on an '
          + 'address the other machine can reach as well.'
        : 'This site does not host a relay and cannot: it is a static upload with no server '
          + 'in it. A relay is a separate process &mdash; <code>node tools/relay.mjs</code> on '
          + 'a machine you can both reach, or the Cloudflare Worker in <code>net/worker.ts</code> '
          + '&mdash; and its address goes under <b>Relay on another machine or port</b>.'), true);
  };

  /**
   * The room is open. The code is the object on this screen; the link is a convenience.
   *
   * That order is deliberate and it is the owner's call. The code is what survives a phone
   * call, a photograph of a screen and a different network; the link is faster when it works.
   * The old screen showed both for 900 ms and then navigated away, which is not long enough to
   * read five characters, let alone say them to somebody.
   */
  const opened = (code: string): void => {
    const addr = relay.value.trim();
    /*
     * Which page the invite should open. The URL bar's answer, unless it is a loopback origin
     * and this server has told us it is *also* reachable at a LAN address — in which case the
     * URL bar is describing the host's own convenience and not the other machine's route.
     */
    const from = plaque && isLoopback(location.hostname) ? plaque.gameUrl : location.href;
    const invite = battleUrl(addr, code, false, from).toString();
    // Honest about when it cannot work. See `isLoopback`: a link naming this machine, mailed
    // to somebody else, opens *their* machine and finds nothing there. Both halves are judged
    // on the addresses that are actually going into the link, not on `location` alone.
    const deadLink = isLoopback(hostOf(from)) ? 'page' : isLoopback(hostOf(addr)) ? 'relay' : '';
    /*
     * A link built out of an address that is not in the host's URL bar has to say so. Otherwise
     * the screen shows a code, a link naming a machine the host has never typed, and no account
     * of where it came from — and the first thing anyone would do with that is not trust it.
     */
    const rehomed = !deadLink && plaque && from !== location.href;
    sheet.innerHTML = `
      <h1>Room open</h1>
      <p>Read this out to the other commander, or have them type it into their own lobby.</p>
      <div class="tc-code" id="tc-code">${esc(code)}</div>
      <div class="tc-row">
        <button type="button" id="tc-copy-code">Copy the code</button>
        ${deadLink ? ''
    : '<button type="button" class="tc-ghost" id="tc-copy-link">Copy the invite link</button>'}
      </div>
      <p class="tc-hint" id="tc-link-hint">${deadLink === 'page'
        ? 'There is no invite link, because this page is served from '
          + `<b>${esc(location.hostname)}</b> &mdash; a link built from it would open the other `
          + 'commander&rsquo;s own machine and find nothing there. The code is the thing to send. '
          + `${LAN_REPAIR}`
        : deadLink === 'relay'
          ? `There is no invite link, because the relay is at <b>${esc(hostOf(addr))}</b>, which `
            + 'names this machine and not theirs. Send the code and let them set their own, or '
            + 'go back and put an address you can both reach under <b>Relay on another machine '
            + `or port</b>. ${LAN_REPAIR}`
          : `${rehomed ? 'This page is open at <b>' + esc(location.hostname) + '</b>, which only '
            + `this machine can reach &mdash; so the link is built from <b>${esc(plaque.lan)}</b>, `
            + `which is ${esc(plaque.iface)} on the network you are both on. `
            + `<b>${esc(plaque.mdns)}</b> reaches this machine too, Mac to Mac. ` : ''}`
            + 'The link carries the relay address and this code: '
            + `<code id="tc-invite">${esc(invite)}</code>`}</p>
      <div class="tc-row">
        <button type="button" id="tc-begin">Choose the battle &rarr;</button>
      </div>
      <div class="tc-note" id="tc-note2">The other commander can join at any point until the
        battle starts. Nothing is waiting on them yet.</div>
      <a class="tc-back" href="?mp=1">&lsaquo; Back to the lobby</a>`;

    const flash = (b: HTMLButtonElement | null, msg: string, back: string): void => {
      if (!b) return;
      b.textContent = msg;
      setTimeout(() => { b.textContent = back; }, 2000);
    };
    const copy = async (text: string, b: HTMLButtonElement | null, back: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        flash(b, 'Copied', back);
      } catch {
        // Clipboard is permission-gated and unavailable over plain http in some browsers. The
        // code is on screen at 40 px and selectable; saying so beats a button that lies.
        flash(b, 'Select it and copy', back);
      }
    };
    const codeBtn = sheet.querySelector('#tc-copy-code') as HTMLButtonElement | null;
    const linkBtn = sheet.querySelector('#tc-copy-link') as HTMLButtonElement | null;
    codeBtn?.addEventListener('click', () => { void copy(code, codeBtn, 'Copy the code'); });
    linkBtn?.addEventListener('click', () => { void copy(invite, linkBtn, 'Copy the invite link'); });
    const begin = sheet.querySelector('#tc-begin') as HTMLButtonElement;
    begin.addEventListener('click', () => go(code, true));
    begin.focus();
  };

  /**
   * A last guard on a path the gate has already closed.
   *
   * With no address both buttons are `disabled`, so this is not reachable by a mouse. It is
   * kept because "not reachable" is a property of two other functions agreeing, and the cost of
   * being wrong about that is a `fetch` to `http:///new` — so instead the refusal that is
   * already on screen gets the focus, and the panel that would fix it is opened *because the
   * player asked for it by pressing the button*, which is not the same as offering it unasked.
   */
  const noAddress = (): boolean => {
    if (relay.value.trim()) return false;
    blocked.hidden = false;
    blocked.scrollIntoView({ block: 'nearest' });
    adv.open = true;
    relay.focus();
    return true;
  };

  hostBtn.addEventListener('click', () => {
    if (noAddress()) return;
    const addr = relay.value.trim();
    const asked = room.value.trim().toUpperCase();
    if (asked && !validCode(asked)) {
      say(`A room code is ${CODE_LEN} characters. Finish it, or clear the field and let the `
        + 'relay choose one.', true);
      room.focus();
      return;
    }
    hostBtn.disabled = true;
    say('Asking the relay for a room&hellip;');
    const q = asked ? `?room=${encodeURIComponent(asked)}` : '';
    fetch(`${httpOf(addr)}/new${q}`)
      .then(async (r) => {
        const j = await r.json().catch(() => null) as { room?: string; detail?: string } | null;
        if (!r.ok || !j?.room) throw new Error(j?.detail ?? `the relay answered ${r.status}`);
        localStorage.setItem(KEY, addr);
        opened(j.room);
      })
      .catch((e: unknown) => {
        hostBtn.disabled = false;
        const why = e instanceof Error ? e.message : String(e);
        // A rejected `fetch` is the relay being unreachable; a rejection carrying the relay's
        // own sentence is the relay refusing, and those deserve different answers.
        if (/^(Failed to fetch|NetworkError|Load failed|.*fetch failed.*)$/i.test(why)) {
          noRelay(addr, 'the browser could not reach it');
        } else {
          say(esc(why), true);
        }
      });
  });

  joinBtn.addEventListener('click', () => {
    if (noAddress()) return;
    const code = room.value.trim().toUpperCase();
    if (!validCode(code)) {
      say(`A room code is ${CODE_LEN} characters from ${CODE_ALPHABET}. `
        + 'The confusable pairs are left out on purpose.', true);
      return;
    }
    go(code, false);
  });

  room.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (validCode(room.value.trim().toUpperCase()) ? joinBtn : hostBtn).click();
  });

  room.focus();
}
