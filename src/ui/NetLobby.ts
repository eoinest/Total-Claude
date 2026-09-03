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
 * ## 2 September 2026 — there is no address to ask about, and the deployed site works
 *
 * The four paragraphs above are about a field that named a *relay*, and a relay was compulsory:
 * without one there was no battle, so an origin with no relay behind it got a screen with no
 * controls on it. The deployed site was that origin permanently and by rule — an `https` page
 * may not open a plain connection into a private network — and §12.6 records the measurement
 * both ways round.
 *
 * The transport is now a connection straight between the two browsers, which is subject to
 * neither mixed content nor Local Network Access. So:
 *
 *   - **Every origin can open a room.** The refusal screen is gone, and with it
 *     `secureOriginNotice`, `noRelayHere` and `relayWentQuiet` — three functions whose whole
 *     subject was a battle that could not start.
 *   - **The field is still there and it is no longer a relay address**, it is an *introduction
 *     service*: the thing that passes one offer each way and is then closed. Empty is a complete
 *     answer and the default, because the public services need nothing typed.
 *   - **The relay is one checkbox further in**, and it still carries a whole battle exactly as
 *     it did. It is the known-good behaviour this build is A/B'd against, and demoting a
 *     capability is still not the same as deleting it.
 *   - **A named service that is not answering is now a note, not a refusal.** It used to grey
 *     out both buttons; there is a fallback now, so the honest thing is to say what is being
 *     used instead and leave the buttons alone.
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

import { CODE_ALPHABET, CODE_LEN, DEFAULT_RELAY_PORT, validCode } from '../net/protocol';
import { makeCode } from '../net/room';
import { makeSecret } from '../net/signal';
import { qrEncode, qrSvg } from '../net/qr';

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
/* The only inline link this panel has ever had. Left to the browser it renders default blue
   with a default underline in the middle of a gold-on-brown sheet, which reads as a defect. */
.tc-lobby .tc-blocked a{color:#f0bd85;text-decoration:underline;text-underline-offset:2px;
  text-decoration-color:#8a6238}
.tc-lobby .tc-blocked a:hover{color:#ffe0bd;text-decoration-color:#c9a24a}
.tc-lobby details.tc-adv{margin-top:26px;padding-top:16px;border-top:1px solid #3a2e1e}
.tc-lobby details.tc-adv > summary{cursor:pointer;list-style:none;font-size:11.5px;
  letter-spacing:.14em;text-transform:uppercase;color:#8e7f63}
.tc-lobby details.tc-adv > summary::-webkit-details-marker{display:none}
.tc-lobby details.tc-adv > summary::before{content:'\\25B8\\00a0'}
.tc-lobby details.tc-adv[open] > summary::before{content:'\\25BE\\00a0'}
.tc-lobby details.tc-adv > summary:hover{color:#e9c877}
.tc-lobby details.tc-adv label{margin-top:14px}
.tc-lobby label.tc-check{display:flex;gap:9px;align-items:flex-start;text-transform:none;
  letter-spacing:normal;font-size:13.5px;color:#cdbb95;cursor:pointer;margin-top:16px}
.tc-lobby label.tc-check input{width:auto;flex:0 0 auto;margin:2px 0 0;accent-color:#c9a24a}
.tc-lobby .tc-code{margin:4px 0 10px;padding:18px 10px;border:1px solid #6b5735;
  border-radius:3px;background:#0e0b08;color:#f4e7c6;text-align:center;
  font:600 40px/1.1 ui-monospace,monospace;letter-spacing:.34em;text-indent:.34em;
  user-select:all;-webkit-user-select:all}
.tc-lobby .tc-back{margin-top:20px;display:inline-block;color:#8e7d5f;font-size:12.5px;
  text-decoration:none;letter-spacing:.1em;text-transform:uppercase}
.tc-lobby .tc-back:hover{color:#e9c877}
.tc-lobby .tc-scan{display:flex;gap:20px;align-items:center;margin:4px 0 14px;flex-wrap:wrap}
.tc-lobby .tc-qr{flex:0 0 auto;width:200px;height:200px;padding:0;background:#fff;
  border-radius:3px;line-height:0}
.tc-lobby .tc-qr svg{display:block;width:100%;height:100%}
.tc-lobby .tc-scan-said{flex:1 1 14em;min-width:12em}
.tc-lobby .tc-scan-said p{margin:0 0 8px}
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

/**
 * The URL that boots a networked battle. One builder, so the invite and the host agree.
 *
 * `relay` is the *transport* address and is now optional: an empty string means peer to peer,
 * which is the default and the only thing the deployed site can do. See
 * `src/net/transport.ts` for the table this is the other half of — `?net=` is the one and only
 * thing that asks for a relay, so omitting it is not a fallback, it is the request.
 *
 * `from` is the page the link should open — `location.href` for the host's own navigation, and
 * the LAN address for an invite when this origin is loopback and the plaque names one. The
 * *path* is taken from `from` too, so a build served under a sub-path keeps it.
 */
const battleUrl = (
  relay: string, code: string, asHost: boolean, from = location.href, sig = '', secret = ''
): URL => {
  const u = new URL(from);
  u.search = '';
  if (relay) u.searchParams.set('net', relay);
  /*
   * `?sig=` is written only when it would not be worked out anyway.
   *
   * A host signalling through the relay their own server declared needs nothing in the URL: the
   * guest's page reads the same `<meta name="tc-relay">` and reaches the same answer. Writing it
   * anyway is the hazard `inviteUrl`'s docstring spends a paragraph on — two copies of one fact,
   * of which the one in the query string is the one that goes stale.
   */
  if (sig && sig !== serverRelay()) u.searchParams.set('sig', sig);
  u.searchParams.set('room', code);
  /*
   * The side, stated on both links rather than inferred from one of them.
   *
   * `&host=1` is new and it is not redundant with `&menu=battle`. `main.ts` reads a bare `?room=`
   * as an *invitation* and therefore as a join, which was safe while a host's own navigation
   * always carried `?net=` — peer to peer it does not, so without this the host's own URL is
   * indistinguishable from the one it just put on the clipboard. Measured before the fix: both
   * pages announced themselves as the challenger and both timed out knocking at a room neither
   * was hosting.
   *
   * `&menu=battle` stays for what it actually does: `startStep` opens on the setup sheet for any
   * URL that names a battle. The challenger has nothing to choose and waits for the host's config.
   */
  if (asHost) {
    u.searchParams.set('host', '1');
    u.searchParams.set('menu', 'battle');
  } else {
    u.searchParams.set('host', '0');
  }
  // The link key, in the one part of a URL no server ever sees. See `inviteUrl`.
  u.hash = secret ? `k=${secret}` : '';
  return u;
};

/**
 * The invitation: this page, and a room code. Nothing else, and the omission is the design.
 *
 * The link used to carry the relay address as well — `?net=ws%3A%2F%2F192.168.0.238%3A5959&
 * room=ABCDE&host=0`, 78 characters of percent-encoding. That was necessary while the page a
 * guest loaded might have come from anywhere. It is not, and has not been since
 * `<meta name="tc-relay">` existed: **the only server that can serve this link is the one that
 * started the relay**, so the address is already in the document the link fetches, stated by
 * the server rather than copied through a query string. Carrying it twice means the two can
 * disagree, and the copy in the URL is the one that goes stale — a host who restarts with
 * `--relay-port=` invalidates every link they sent, and the failure lands on the guest.
 *
 * What the short form buys, in order of how much it matters:
 *
 *   - **It fits in a small QR.** 36 bytes is a version-4 symbol at level Q, 33 modules square;
 *     the long form is 79 bytes and version 7, 45 modules. On a terminal at half a character
 *     cell per module that is the difference between a symbol that scans across a desk and one
 *     that needs a phone held against the screen.
 *   - **It can be read out.** `192.168.1.77, colon, 5958, slash, question mark, room equals
 *     ABCDE` is a sentence. The long form is not.
 *   - **It survives the host restarting the relay on another port.**
 *
 * `?net=…&room=…&host=0` is still understood everywhere it was — `main.ts`'s `netFailed`
 * builds one, and any link already sent still works. Nothing was removed; one thing stopped
 * being generated.
 */
export const inviteUrl = (code: string, from = location.href, secret = ''): URL => {
  const u = new URL(from);
  u.search = '';
  u.searchParams.set('room', code);
  /*
   * **The secret goes in the fragment, and the fragment is the reason this works at all.**
   *
   * A URL fragment is never put on the wire: no server sees it, including the one serving this
   * page and the introduction service the two peers meet on. So it is the only part of a link
   * that can carry an AES key across a public broker without entering it. `src/net/signal.ts`'s
   * privacy section is the argument; this is the one line that implements it.
   *
   * A link is therefore *materially* more private than the five characters, which is a thing the
   * screen now says out loud instead of implying the opposite.
   */
  u.hash = secret ? `k=${secret}` : '';
  return u;
};

/**
 * The relay this document's own server started, or `null`. **Never a guess, on any path.**
 *
 * Split out of `resolveRelay` because `main.ts` needs exactly this and none of the rest: a
 * guest arriving on `?room=ABCDE` has no `?net=` to obey and must not be given this browser's
 * remembered address from some other evening's session, which would silently take them to a
 * different machine's relay under the host's room code.
 *
 * The scheme follows the page. On https it composes `wss`, which is correct and which nothing
 * currently answers, and nothing has to: an https page is now served by the peer transport,
 * which needs no address at all. Composing `wss` there rather than `ws` is still right for the
 * one case it is used in — a relay somebody explicitly asked for — because `ws` from an https
 * page arrives as a `SecurityError` in the console rather than as a sentence on the screen.
 */
export function serverRelay(doc: Document = document): string | null {
  const plaque = readLanPlaque(doc);
  if (plaque?.relayUrl) return plaque.relayUrl;
  const port = readRelayPort(doc);
  if (port === null) return null;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.hostname || '127.0.0.1'}:${port}`;
}

/**
 * What somebody typed into the relay field, completed to an address a `WebSocket` accepts.
 *
 * Three forms in, one out. `ws://192.168.1.77:5959` passes through; `192.168.1.77:5959` gets
 * the scheme; `192.168.1.77` gets the scheme and `DEFAULT_RELAY_PORT`. The completed value is
 * **written back into the field** by the caller, so what is added is on screen before anything
 * is done with it — which is the difference between completing what a person typed and the
 * page guessing on their behalf, and this file has a long docstring about the second.
 *
 * It exists because of the one case the QR and the link cannot serve: two people who each have
 * a checkout, each running their own copy, one of whom wants to join the other's relay. The
 * thing they have to get across is an address, and four dotted numbers is the smallest honest
 * spelling of one. See `docs/MULTIPLAYER.md` §12.5 for why an address packed into a longer
 * *room code* was considered for that case and rejected.
 */
export function normaliseRelay(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (/^wss?:\/\//i.test(s)) return s;
  if (/:\/\//.test(s)) return s; // some other scheme: leave it alone and let it fail by name
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return /:\d+$/.test(s) ? `${scheme}://${s}` : `${scheme}://${s}:${DEFAULT_RELAY_PORT}`;
}

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
  /** Something to take to another machine: shown big, selectable, with a copy button. */
  carry?: { code?: string; link?: string };
}): void {
  const sheet = mount(host);
  const back = o.back ?? { label: 'Back to the lobby', href: '?mp=1' };
  const carry = o.carry;
  sheet.innerHTML = `<h1>${esc(o.title)}</h1>`
    + o.lines.map((l) => `<p>${l}</p>`).join('')
    + (carry?.code ? `<div class="tc-code" id="tc-notice-code">${esc(carry.code)}</div>` : '')
    + (carry?.link
      ? `<p class="tc-hint">The link, in full: <code id="tc-notice-link">${esc(carry.link)}</code></p>`
        + '<div class="tc-row"><button type="button" id="tc-notice-copy">Copy the link</button></div>'
      : '')
    + `<div class="tc-row"><a class="tc-back" id="tc-notice-back" href="${esc(back.href)}"
         style="margin-top:6px">&lsaquo; ${esc(back.label)}</a></div>`;
  const copyBtn = sheet.querySelector('#tc-notice-copy') as HTMLButtonElement | null;
  copyBtn?.addEventListener('click', () => {
    void navigator.clipboard.writeText(carry?.link ?? '')
      .then(() => { copyBtn.textContent = 'Copied'; })
      // Clipboard is permission-gated and this screen is most often reached on a phone, where
      // it is least likely to be granted. The link is on screen and selectable; say so.
      .catch(() => { copyBtn.textContent = 'Select it and copy'; });
    setTimeout(() => { copyBtn.textContent = 'Copy the link'; }, 2000);
  });
  (copyBtn ?? sheet.querySelector('#tc-notice-back') as HTMLElement | null)?.focus();
}

/**
 * The narrowest viewport the battle HUD can be finished in. **Measured, not chosen.**
 *
 * `tools/scratch/hud-width.mjs` booted the deployment phase at fourteen viewport widths in
 * Chromium and WebKit and read `.dep-begin`'s own rectangle back. The result is not a curve:
 * `.dep-head` is a flex row of `flex: 0 0 auto` items, so the plaque has a **fixed content
 * width of about 1,062 px** and simply overflows anything narrower. BEGIN BATTLE's right edge
 * sat at 1,061-1,063 px at every viewport from 390 to 1,100, and `documentElement.scrollWidth`
 * equalled `innerWidth` at every one of them — so the button is not merely below the fold, it
 * is **unreachable**, exactly as `.tc-lobby`'s own fault 2 was.
 *
 *     390  begin.right 1042   fits false      1024  begin.right 1061   fits false
 *     640  begin.right 1049   fits false      1060  begin.right 1062   fits false
 *     768  begin.right 1053   fits false      1070  begin.right 1062   fits TRUE
 *     900  begin.right 1057   fits false      1280  begin.right 1231   fits true
 *
 * So this is not "phones cannot play". It is "anything under about 1,065 px cannot **finish
 * deploying**", which is every iPad in portrait, every phone, and a laptop with the window at
 * half width. 1,100 rather than 1,065 because the plaque's width depends on the tally string
 * and the army it is counting, and the cost of the two errors is not symmetric: refusing a
 * window that would have worked is a sentence and a link, and accepting one that does not is a
 * room nobody can play and nobody else can join.
 *
 * There is no `@media` rule anywhere in `hud.css`, and adding a phone layout for the whole HUD
 * is a pass of its own. This constant is the honest interim: it does not claim the HUD is
 * responsive, it declines to start a session that cannot be finished.
 */
export const HUD_MIN_WIDTH = 1100;

/** Is this viewport wide enough to finish a deployment in? */
export const hudFits = (w: number = window.innerWidth): boolean => w >= HUD_MIN_WIDTH;

/**
 * Refuse a relayed session this device could not finish — **before the socket is opened**.
 *
 * The order is the whole point and it is the P0 this function exists for. A guest who scans the
 * square on a phone used to connect, take slot 1, and land on a deployment plaque whose BEGIN
 * BATTLE was 434 px off the right edge of an unscrollable page. Two things were then true at
 * once: that player could never start the battle, and **the room was spent** — the real second
 * laptop arriving afterwards was refused with "already has a challenger". A dead end for one
 * person had become a dead end for both.
 *
 * So this runs in `main.ts` before `new NetLink()` exists. Nothing is connected, no slot is
 * claimed, the room stays open, and what the phone gets is the code and the link, big, with a
 * copy button — which is the most useful thing a phone can do here: carry the invitation to a
 * machine that can play it.
 *
 * `?narrow=ok` overrides, and it is deliberately a URL to be typed rather than a button to be
 * pressed. A button is one thumb away on the device that must not press it; an address-bar edit
 * is easy on the machine where the override is plausible and awkward on the one where it is
 * not. The sentence naming it is addressed to somebody at a keyboard.
 */
export function showTooNarrow(host: HTMLElement, o: {
  code: string; link: string; width: number; coarse: boolean;
}): void {
  showNetNotice(host, {
    title: 'This screen is too narrow to play on',
    lines: [
      `<b>Nothing has been joined, and the room is still open.</b> The deployment plaque needs `
      + `about ${HUD_MIN_WIDTH} pixels of width and this window has ${o.width}, so BEGIN BATTLE `
      + 'would sit off the edge of the screen with no way to scroll to it &mdash; the battle '
      + 'could never be started.',
      o.coarse
        ? 'Open this link on a laptop or a desktop. Nothing else has to be typed: it carries the '
          + 'room. Taking the room on this device would have held the second place in it and '
          + 'locked the other commander out, so it was not taken.'
        : 'Widen this window, or open the link on a larger screen, and it will go straight in. '
          + 'Nothing else has to be typed. If you are certain, add <code>&amp;narrow=ok</code> to '
          + 'the address to go in anyway &mdash; you will hold the second place in the room '
          + 'whether or not you can finish deploying.',
    ],
    back: { label: 'Back to the front door', href: '?' },
    carry: { code: o.code, link: o.link },
  });
}

/**
 * How the two of you will be introduced — said **only when there is something to know**.
 *
 * This block used to be `noRelayHere`, a refusal, because a battle could not start without a
 * relay process and most origins had none. Nothing is refused now. So the question became what
 * to put here instead, and the first answer was wrong in a way the gate caught: it explained the
 * introduction on *every* origin, including the one where the page's own server does it
 * automatically and nothing leaves the network.
 *
 * That is exactly what §11 removed. The owner read a RELAY ADDRESS field on this screen and
 * asked what it was for, and the answer was that it is a transport detail at the player's eye
 * level on a screen that is otherwise about two people and a code. A paragraph explaining the
 * transport is the same mistake in prose, and `qa-net`'s `lan-lobby-says-nothing-about-transport`
 * went red on it — correctly.
 *
 * So the rule is the one §11 arrived at, applied consistently: **the panel speaks when a player
 * would want to know, and is silent otherwise.**
 *
 *   - The page's own server will introduce you → **nothing**. There is no decision to make,
 *     nothing leaves the network, and the QR and the code say everything else.
 *   - Free public services will introduce you → **one sentence**, because a third party
 *     briefly touching your traffic is a fact a player is owed whether or not they asked.
 *     It used to end *"They see an unreadable code and encrypted text, never your orders"*, and
 *     a review on 3 Sep 2026 showed the first half of that was false: the topic is an unsalted
 *     hash of the room code, so the whole 33.5-million-entry table builds in 26 seconds and any
 *     topic reverses in constant time. Telling somebody their introduction is unreadable, when
 *     it carries their home IP address and is not, is the worst sentence on this screen. What is
 *     true and is kept is the second half — the orders never go there — and the privacy of the
 *     introduction itself is now stated per room by `privacyNote`, because it depends on whether
 *     the other player used the link or typed the code.
 *   - A named service is not answering → **one sentence**, because what is being used has
 *     changed from what the page said.
 *   - The relay is carrying the whole battle → **one sentence**, because somebody ticked a box
 *     and the screen should confirm what it did.
 */
const introNote = (addr: string): string =>
  '<b>The game runs straight between the two browsers, with nothing in between.</b> To set '
  + 'that up, one short message has to pass each way, and that goes through free public '
  + 'introduction services &mdash; three of them at once, so one being down costs nothing. '
  + '<b>Your orders never go near them</b>, and once the battle starts they are not used '
  + `again.${addr ? '' : ''}`;

/**
 * **Which of the two kinds of privacy this room has, said on the screen where the code is.**
 *
 * This exists because the sentence it replaces was false. `introNote` used to promise that the
 * public introduction services *"see an unreadable code and encrypted text"*. The topic is an
 * unsalted SHA-256 of the room code, so the full table of all 33.5 million codes builds in 26
 * seconds and any topic reverses in constant time — and the payload was encrypted under a key
 * derived from that same code. The introduction carries both players' ICE candidates, which
 * carry their home IP addresses. Telling somebody that is unreadable is the worst thing this
 * screen could say, because it is exactly the thing they would rely on.
 *
 * The fix is `#k=`: 16 random bytes in the invite link's fragment, which no server ever receives,
 * used to derive the key. So a room genuinely has two modes and **the difference belongs to the
 * player, not to the implementation**:
 *
 * - They open your **link or your square** → the key is in it, nobody else has it.
 * - They **type the five characters** → you can still meet, and the introduction is not private.
 *
 * The host cannot know in advance which will happen, so this states both. It is deliberately
 * three lines and no more: §11's rule is that the screen speaks when a player would want to know
 * and is silent otherwise, and *"is what I am about to send private"* is squarely inside that.
 *
 * Silent in the two cases where there is no public square at all — the relay carrying the whole
 * battle, and an introduction service on your own network — for exactly that reason.
 */
const privacyNote = (
  viaRelay: boolean, addr: string, declared: string, noLink: boolean
): string => {
  if (viaRelay || (addr && addr === declared) || (addr && addr !== '')) return '';
  return '<p class="tc-hint" id="tc-privacy">'
    + `<b>${noLink ? 'Read the code out' : 'Send the link or the square'} and the introduction is `
    + (noLink
      ? 'not private.</b> The two of you can still meet — that is what the code is for — but the '
        + 'public introduction services carry the addresses your two computers use to find each '
        + 'other, and a code short enough to read aloud is not enough to keep them from being '
        + 'read. '
      : 'private:</b> the key is inside the link, in the part no server is ever sent. If they '
        + '<i>type the five characters</i> instead, the two of you still meet, but that '
        + 'introduction is not private &mdash; the addresses your computers use to find each '
        + 'other could be read by somebody watching those public services. ')
    + '<b>Either way your orders never go through them, and the battle itself does not.</b></p>';
};

/**
 * A named introduction service that is not answering, and what happens next.
 *
 * **This is a note and not a refusal, which is the whole difference from the screen this
 * replaces.** `relayWentQuiet` disabled both buttons, because without a relay there was no
 * battle. An introduction service that has died costs nothing but a fallback: the public brokers
 * are there, they need no address, and the match plays identically. So the honest thing is to
 * say what happened, say what is being used instead, and leave the buttons alone.
 */
const introFellBack = (addr: string, source: RelaySource): string =>
  `<b>Nothing is listening at ${esc(addr)}, so you will be introduced over the internet `
  + 'instead.</b> '
  + (source === 'server'
    ? 'This server said it had started a relay there and nothing is on it now. '
    : source === 'remembered'
      ? 'That is the address this browser used last time. '
      : 'That address arrived with the link that opened this page. ')
  + 'The battle is unaffected &mdash; it never went through that address anyway, and it will '
  + 'still run straight between the two machines.';

export function showLobby(host: HTMLElement): void {
  const sheet = mount(host);
  const params = new URLSearchParams(location.search);
  const plaque = readLanPlaque();
  const declaredPort = readRelayPort();
  const ours = servedByUs(plaque, declaredPort);
  /*
   * `?sig=` outranks everything, because it is the *link's* answer to "who introduces you".
   *
   * `resolveRelay` is about a **relay**, and its four sources are ordered for that question. An
   * introduction service is a different question with one extra answer -- `broker`, meaning "the
   * public services whatever this page's server says" -- and it arrives in exactly one way: a
   * host who overrode the default put it in the invite link (`battleUrl`). Folding it into
   * `resolveRelay` would give that function two subjects; reading it here keeps the ranking there
   * intact for the case it was written for.
   */
  const sigParam = (params.get('sig') ?? '').trim();
  const chosen: RelayChoice = sigParam
    ? { value: sigParam === 'broker' ? '' : sigParam, source: 'url' }
    : resolveRelay(params, plaque, declaredPort, localStorage.getItem(KEY));

  /*
   * There is no early return for the deployed site any more, and its removal is the point of
   * this pass.
   *
   * What stood here was a page with **no controls on it at all** and four sentences explaining
   * that multiplayer runs on your own network and cannot be played from the internet, with a
   * link to the repository. It was the right screen for a true fact: an `https` page may not
   * open a `ws://` connection, and a page the browser believes came from the public internet may
   * not reach into a private network — Chromium refuses it as an address-space violation and
   * WebKit as plain mixed content (§12.6 has both transcripts).
   *
   * A peer connection is subject to neither rule. Measured on Chromium 151 from an https origin
   * the browser had been told was public: ICE gathered host *and* server-reflexive candidates,
   * no console error, and a data channel opened and carried a battle. So the sentence that
   * screen was built around — "nothing typed on this screen can start a battle here" — stopped
   * being true. `secureOrigin()` and `secureOriginNotice()` had no caller left and are deleted:
   * a predicate that exists to identify the one origin that cannot play, in a build where every
   * origin can, is a comment claiming something false with syntax highlighting on it.
   *
   * `tools/qa-net.mjs`'s `https` arm asserted the old screen and has been rewritten to assert
   * this one. It still asserts the `ws://` refusal, because that is still exactly true and is
   * the reason the relay cannot be the answer here.
   */

  /*
   * Two fields behind the disclosure now, and the second one is the relay.
   *
   * The ordering is the product decision this pass makes and it is worth stating plainly.
   * **Peer to peer is the default and the only thing on the front of the screen.** The relay is
   * not deleted, is not deprecated, and is one disclosure click away — it is a working, tested
   * instrument, it is how this transport is A/B'd against known-good behaviour, and there is a
   * real case for it: two people who would rather one of their own machines carried the traffic
   * than have the two browsers find each other. What it is no longer is the thing a player has
   * to understand before they can press a button.
   */
  sheet.innerHTML = `
    <h1>Multiplayer</h1>
    <p>One battle, both armies, on two machines. One of you opens a room and reads the code
       out; the other types it in. The host chooses the ground and the orders of battle; the
       challenger takes the other side.</p>
    <div class="tc-blocked" id="tc-no-relay" role="status"></div>
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
      <summary id="tc-adv-summary">How you are introduced, and the relay</summary>
      <label for="tc-relay">Introduction service</label>
      <input id="tc-relay" spellcheck="false" autocomplete="off"
        aria-describedby="tc-relay-hint" placeholder="ws://host:port — or leave empty">
      <p class="tc-hint" id="tc-relay-hint">Leave it empty and free public services introduce
         you. <code>npm run host</code> fills this in with a relay on your own network instead.
         Either way the battle runs straight between the two machines.</p>
      <label class="tc-check" for="tc-via-relay"><input type="checkbox" id="tc-via-relay">
        Send every order through the relay instead of connecting directly</label>
      <p class="tc-hint" id="tc-relay-mode">The older way. Needs an address above, and cannot
         work from the deployed site.</p>
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
  const viaRelay = sheet.querySelector('#tc-via-relay') as HTMLInputElement;
  const relayMode = sheet.querySelector('#tc-relay-mode') as HTMLElement;

  relay.value = chosen.value;
  room.value = (params.get('room') ?? '').toUpperCase();
  /*
   * **Only `?net=` ticks the box, and nothing opens the panel.** Both halves were bugs.
   *
   * `?net=` is somebody having explicitly asked for the relay to carry the whole battle, so the
   * checkbox starts ticked. `?sig=` is a different request with the same provenance — it names
   * who *introduces* the two peers — and reading both as `source: 'url'` made an invite link
   * that stated an introduction service arrive with the relay transport selected: the screen said
   * "every order will go through the relay" about a link whose whole point was that they would
   * not. Nothing else pre-ticks it either; an address the *server* declared is an offer to
   * introduce you, not a request to carry your orders.
   *
   * And the panel stays **closed**, which is the second fix. Opening it added about 250 px to a
   * sheet that `qa-net`'s own comment already measured at ~765 px in an 800 px viewport, and the
   * back link left the fold — which is fault 2 in this file's docstring, arriving for the third
   * time. There is nothing behind the disclosure a player needs to *see* to understand the
   * state: `#tc-no-relay` says what the relay is about to do, where they are already looking.
   */
  viaRelay.checked = (params.get('net') ?? '').trim() !== '';

  /** Whether the relay is being asked to carry the battle, as opposed to just the introduction. */
  const throughRelay = (): boolean => viaRelay.checked && relay.value.trim() !== '';
  /** The address that will introduce the two peers, or `''` for the public services. */
  const introAddr = (): string => (viaRelay.checked ? '' : relay.value.trim());

  let quiet = false;
  /** The panel's four states, and the fourth is silence. See `introNote`. */
  const describe = (): void => {
    if (throughRelay()) {
      blocked.hidden = false;
      blocked.innerHTML = `<b>Every order will go through the relay at `
        + `${esc(relay.value.trim())}.</b> That is the older arrangement and it works as it `
        + 'always did. Untick the box under <b>How you are introduced</b> to let the two '
        + 'machines talk directly instead.';
      return;
    }
    const addr = introAddr();
    if (quiet && addr) {
      blocked.hidden = false;
      blocked.innerHTML = introFellBack(addr, chosen.source);
      return;
    }
    if (addr) {
      // This page's own server will do it. Nothing leaves the network and there is nothing to
      // decide, so the screen is a room code, a Create and a Join and says nothing else.
      blocked.hidden = true;
      blocked.innerHTML = '';
      return;
    }
    blocked.hidden = false;
    blocked.innerHTML = introNote(addr);
  };

  /*
   * One gate for both buttons, and what it can refuse has shrunk to almost nothing.
   *
   * Peer to peer needs no address, so `Create` is always available and `Join` waits only on a
   * well-formed code. The relay transport is the one case that still needs something typed, and
   * it is behind a checkbox somebody had to tick.
   */
  const gate = (): void => {
    hostBtn.disabled = throughRelay() && relay.value.trim() === '';
    joinBtn.disabled = hostBtn.disabled || !validCode(room.value);
    relayMode.style.opacity = viaRelay.checked ? '1' : '0.55';
    describe();
  };

  /*
   * The probe, and what it now decides.
   *
   * It still runs only when something has *named* an address, so a page with no relay behind it
   * makes no request at all — no console line on the deployed site, none under `npm run dev`,
   * and `qa-net`'s two console arms stay green for the reason they were written.
   *
   * What changed is the consequence. It used to disable the form, because without a relay there
   * was no battle. Now a dead address costs a fallback and nothing else: the public services need
   * no address and the match plays identically, so the answer is a sentence rather than a closed
   * door. The one case where it still bites is the relay *transport*, where `create()` reports
   * the failure by name from `/new`'s own answer.
   */
  if (chosen.value) {
    void relayAnswers(chosen.value).then((alive) => {
      if (alive || relay.value.trim() !== chosen.value) return;
      quiet = true;
      gate();
      if (chosen.source === 'url') adv.open = true;
    });
  }

  if (chosen.source === 'server' && plaque?.relayUrl) {
    relayHint.innerHTML = `This machine is serving the game and a relay on <b>${esc(plaque.lan)}</b> `
      + `(${esc(plaque.iface)}), which is the address the other commander can reach, and that is `
      + 'what this field has been set to. It will introduce the two of you and then step out of '
      + 'the way. Anything you type here wins; empty means the public services.';
  } else if (chosen.source === 'server') {
    relayHint.innerHTML = 'The server that sent you this page started a relay beside itself on '
      + `port <b>${declaredPort}</b>, and that is what this field has been set to. It will `
      + 'introduce the two of you and then step out of the way. Anything you type here wins; '
      + 'empty means the public services.';
  } else if (chosen.source === 'remembered') {
    relayHint.innerHTML = 'This is the address this browser used last time. Nothing on this page '
      + 'chose it &mdash; clear the field to forget it and be introduced over the internet.';
  }

  relay.addEventListener('input', gate);
  viaRelay.addEventListener('change', gate);
  /*
   * Completed when the field is left, never while it is being typed in.
   *
   * `change` and not `input`, because completing on every keystroke would turn `192.` into
   * `ws://192.:5959` under the cursor and then fight the next character. On `change` the person
   * has finished, the completion is written back where they can read it, and the address that
   * gets used is the address on the screen.
   */
  relay.addEventListener('change', () => {
    const done = normaliseRelay(relay.value);
    if (done !== relay.value.trim()) relay.value = done;
    quiet = false;
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
    const list = [...refused].map((c) => `“${c}”`);
    hint.classList.add('tc-bad');
    hint.textContent = `${list.join(', ')} ${refused.size > 1 ? 'are' : 'is'} not in a room `
      + 'code — I, O, 0 and 1 are left out on purpose, because a code gets read aloud. '
      + progress;
  };
  room.addEventListener('input', clean);
  clean();

  /**
   * The link key for the room this screen is opening. Minted by `create`, '' until then.
   *
   * Scope-local rather than a field, because it has exactly one lifetime: a room. It is the
   * 16 bytes that go in the invite link's `#k=` fragment and nowhere else — not in the query
   * string, not in `localStorage`, not on any wire. See `src/net/signal.ts`'s privacy section
   * for what it buys and `inviteUrl` for why the fragment is the only place it can live.
   */
  let secret = '';

  const go = (code: string, asHost: boolean): void => {
    localStorage.setItem(KEY, relay.value.trim());
    location.href = battleUrl(throughRelay() ? relay.value.trim() : '', code, asHost,
      location.href, introAddr(), secret).toString();
  };

  /** What to say when the relay does not answer — and it depends on where the page came from. */
  const noRelay = (addr: string, why: string): void => {
    say(`No answer from <b>${esc(addr)}</b> &mdash; ${esc(why)}. `
      + 'Untick <b>Send every order through the relay</b> and the two machines will connect '
      + 'directly, which needs no address and no process. '
      + (ours
        ? 'Or start one with <code>node tools/relay.mjs</code> and press Create again.'
        : 'Or put the address of a relay you can both reach under <b>How you are '
          + 'introduced</b>.'), true);
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
    const viaR = throughRelay();
    /*
     * Which page the invite should open. The URL bar's answer, unless it is a loopback origin
     * and this server has told us it is *also* reachable at a LAN address — in which case the
     * URL bar is describing the host's own convenience and not the other machine's route.
     */
    const from = plaque && isLoopback(location.hostname) ? plaque.gameUrl : location.href;
    /*
     * Short link or long link, and the test is not a preference — it is whether the two would
     * agree.
     *
     * `inviteUrl` carries only the room code, and everything else about the guest's session is
     * worked out by the document the link fetches: the transport, and the introduction service if
     * this page's own server declared one. That is exactly right in the two ordinary cases —
     * peer to peer from anywhere, and peer to peer introduced by the machine that served the
     * page — and **wrong the moment the host has overridden something**. A host who typed
     * another machine's address, or ticked the relay box, would otherwise send a link whose page
     * reaches a different answer, and the two would sit in identically-named rooms on different
     * arrangements, each waiting for somebody who is not coming.
     *
     * So an override falls back to `battleUrl`, which states the choice in the query string and
     * cannot be second-guessed by the page at the far end.
     */
    const declared = serverRelay();
    const shortLink = !viaR && (addr === '' || addr === declared);
    const invite = (shortLink
      ? inviteUrl(code, from, secret)
      : battleUrl(viaR ? addr : '', code, false, from, viaR ? '' : addr, secret)).toString();
    /*
     * When a link would be a dead end, and this is a shorter list than it used to be.
     *
     * A link naming *this* machine, mailed to somebody else, opens *their* machine and finds
     * nothing there — so a loopback page origin still withholds it. What no longer withholds it
     * is a loopback *relay* address in peer mode, because in peer mode there is no relay in the
     * link at all: the address is an introduction service the guest's own page will not use, and
     * a peer session introduced over the public services works from anywhere. That case now
     * produces a perfectly good link, and it produces the one the deployed site sends.
     */
    const deadLink = isLoopback(hostOf(from)) ? 'page'
      : viaR && isLoopback(hostOf(addr)) ? 'relay' : '';
    /*
     * A link built out of an address that is not in the host's URL bar has to say so. Otherwise
     * the screen shows a code, a link naming a machine the host has never typed, and no account
     * of where it came from — and the first thing anyone would do with that is not trust it.
     */
    const rehomed = !deadLink && plaque && from !== location.href;
    /*
     * The square, and why it is the first thing on the screen when there is one.
     *
     * A camera pointed at this square puts the other commander in this room having typed nothing
     * at all, which is a shorter path than any number of characters, and the code stays
     * underneath it for the phone call, the photograph and the second laptop that has no camera.
     *
     * `qrSvg` at level Q, which is the level that survives a hand and a reflection; see
     * `src/net/qr.ts`. It is inert markup, so it goes in with the rest of the sheet.
     */
    const square = deadLink ? '' : qrSvg(qrEncode(invite));
    sheet.innerHTML = `
      <h1>Room open</h1>
      <p>${deadLink
    ? 'Read this out to the other commander, or have them type it into their own lobby.'
    : 'Point the other machine&rsquo;s camera at this, or read the code out. Either one puts '
      + 'them in this room.'}</p>
      ${square
    ? `<div class="tc-scan">
           <div class="tc-qr" id="tc-qr" role="img"
                aria-label="Join code for room ${esc(code)}">${square}</div>
           <div class="tc-scan-said">
             <div class="tc-code" id="tc-code">${esc(code)}</div>
             <p class="tc-hint">Both of you are in room <b>${esc(code)}</b>.</p>
           </div>
         </div>`
    : `<div class="tc-code" id="tc-code">${esc(code)}</div>`}
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
            + 'untick <b>Send every order through the relay</b> and the two machines will connect '
            + `directly from anywhere. ${LAN_REPAIR}`
          : `${rehomed ? 'This page is open at <b>' + esc(location.hostname) + '</b>, which only '
            + `this machine can reach &mdash; so the link is built from <b>${esc(plaque.lan)}</b>, `
            + `which is ${esc(plaque.iface)} on the network you are both on. `
            + `<b>${esc(plaque.mdns)}</b> reaches this machine too, Mac to Mac. ` : ''}`
            + (shortLink
              ? 'The square and the link are the same address, and it is short enough to say '
                + 'out loud: '
              : 'You have changed how this session connects, so the link states that rather than '
                + 'letting their page work it out: ')
            + `<code id="tc-invite">${esc(invite)}</code>`}</p>
      <p class="tc-hint" id="tc-how">${viaR
        ? `Every order will go through the relay at <b>${esc(addr)}</b>.`
        : addr
          ? `${addr === declared
            ? 'This machine will introduce the two of you, and then the battle runs straight '
              + 'between the two machines. Nothing leaves your network.'
            : `You will be introduced by <b>${esc(addr)}</b>, and then the battle runs straight `
              + 'between the two machines.'}`
          : 'You will be introduced over the internet, and then the battle runs straight between '
            + 'the two machines with nothing in between.'}</p>
      ${privacyNote(viaR, addr, declared ?? '', deadLink !== '')}
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
   * Open a room. **Peer to peer this needs no round trip and no server, so it is instant.**
   *
   * The two paths are genuinely different and the difference is the point of the whole pass.
   * Through a relay, a room is a thing that has to be *claimed*: `/new` mints it or refuses the
   * code, and until that answer comes back nobody knows whether the room exists. Peer to peer
   * there is nothing to claim — a code is a rendezvous name, the host starts listening under it,
   * and a collision resolves itself because the only way a second host matters is if a
   * challenger reaches both, at which point `PeerRoom`'s `hello` refuses the pairing by name
   * (two peers that both pressed CREATE).
   *
   * `makeCode` is `src/net/room.ts`'s, which is the same function the relay uses and takes its
   * randomness from the caller — `crypto.getRandomValues` is spelled three ways across the three
   * places that file is imported into, and this is the browser's.
   */
  const create = (fromLink = false): void => {
    const asked = room.value.trim().toUpperCase();
    if (asked && !validCode(asked)) {
      say(`A room code is ${CODE_LEN} characters. Finish it, or clear the field and let one be `
        + 'picked for you.', true);
      room.focus();
      return;
    }
    if (!throughRelay()) {
      const code = asked || makeCode(
        () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
        CODE_ALPHABET, CODE_LEN);
      /*
       * **The room's actual secret, and it is not the code.**
       *
       * The five characters are a rendezvous name and are meant to be said out loud, which is
       * 25 bits over an alphabet chosen for the telephone. This is 128 bits, it rides in the
       * fragment of the invite link, and it is what the introduction is encrypted with. A room
       * opened here always has one; whether it gets *used* depends on whether the other player
       * follows the link or types the code, which is what `privacyNote` tells the player.
       */
      secret = makeSecret();
      localStorage.setItem(KEY, relay.value.trim());
      const intro = introAddr();
      /*
       * **Claim the code on the introduction service, when there is one.** Peer to peer there is
       * nothing to *reserve* — a code is a rendezvous name — but a relay that is going to
       * introduce the two of you is also a thing that knows which names are in use, and asking
       * costs one round trip on your own network.
       *
       * It buys back a refusal that the relay transport gave for free and that a registry-free
       * design cannot have: a host who presses Back, or reopens a `?create=1` URL out of history,
       * is told *"this code has already introduced two players"* instead of being handed a Room
       * open screen with a code, a link and a square for a code somebody else is mid-battle on.
       * §12.3's reviewer found that hole in the relay path; this is the same hole in this one.
       *
       * **Never fatal.** A `started` refusal is the whole point and is shown; anything else — a
       * dead relay, a 404 from something that is not one, a network error — falls through and
       * opens the room, because peer to peer the code needs no permission from anybody and a
       * lobby that refused to open a room because a *signalling* service was down would be
       * refusing something it does not need.
       */
      if (!intro) { opened(code); return; }
      hostBtn.disabled = true;
      fetch(`${httpOf(intro)}/new?room=${encodeURIComponent(code)}`)
        .then(async (r) => {
          const j = await r.json().catch(() => null) as { error?: string; detail?: string } | null;
          hostBtn.disabled = false;
          if (r.status === 409 && j?.error === 'started') {
            say(esc(j.detail ?? `room ${code} is already in use`), true);
            return;
          }
          opened(code);
        })
        .catch(() => { hostBtn.disabled = false; opened(code); });
      return;
    }
    const addr = relay.value.trim();
    hostBtn.disabled = true;
    say('Asking the relay for a room&hellip;');
    const q = asked ? `?room=${encodeURIComponent(asked)}` : '';
    fetch(`${httpOf(addr)}/new${q}`)
      .then(async (r) => {
        const j = await r.json().catch(() => null) as { room?: string; detail?: string; error?: string } | null;
        /*
         * `taken` on a room the *command* opened is the other commander arriving first.
         *
         * A real race, and it is the good outcome wearing an error's clothes: `npm run host`
         * mints the room, prints the square, and the guest may scan it before the host's own
         * browser has finished loading. Once a socket is in the room the relay refuses to hand
         * it out again — correctly, for a code somebody typed — and the host would be told
         * "room X is in use on this relay" about their own room, with no way forward.
         *
         * Narrow on purpose, and narrow on **two** axes. Provenance alone was not enough: the
         * relay answers 409 for two different conditions, and gating on `fromLink` swallowed
         * both. A host who pressed Back, or reopened the `create=1` link out of history or a
         * restored tab, got a Room open screen — code, link and a square — for a room that was
         * already *playing* and could never be entered again. So the reason is read off the
         * payload (`error`), not off the sentence and not off where the code came from; a code
         * the *player* typed still gets the refusal either way, because there it means what it
         * says.
         */
        if (r.status === 409 && fromLink && asked && j?.error === 'taken') {
          localStorage.setItem(KEY, addr);
          opened(asked);
          return;
        }
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
  };
  hostBtn.addEventListener('click', () => create());

  joinBtn.addEventListener('click', () => {
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

  gate();
  room.focus();

  /*
   * `?create=1` — the host's side of "nothing is typed", and the mirror of the guest's `?room=`.
   *
   * `npm run host` asks for a room before it prints anything, because the code has to exist for
   * the QR in the terminal to encode it. Having minted it, the browser it opens must land on
   * *that* room and not on an empty form the host is expected to fill in with a code they can
   * see two inches away in their own terminal — which was the shape of the first version of
   * this, and it left the terminal's square pointing at a room the screen had quietly replaced
   * with another one.
   *
   * So the tool passes `?mp=1&room=CODE&create=1` and this presses CREATE. It goes through the
   * ordinary `create()` and not a private path.
   */
  if (params.get('create') === '1' && validCode(room.value.trim().toUpperCase())) create(true);
}
