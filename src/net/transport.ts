import type { Link } from './link.ts';
import { NetLink } from './NetLink.ts';
import { PeerLink, STUN_SERVERS } from './PeerLink.ts';
import type { PeerFault } from './peerRoom.ts';
import { validCode } from './protocol.ts';
import { MqttSignal, PUBLIC_BROKERS, WsSignal, type SignalChannel } from './signal.ts';

/**
 * Which wire does this URL want, and who introduces the two peers?
 *
 * ## Why this is a file and not four lines in `main.ts`
 *
 * There are two transports and three ways to be introduced, and the *rules* about which
 * combination a given URL means are the part a reader needs and the part that goes wrong. Left
 * inline they would be four nested ternaries next to a loading screen; here they are one
 * function with the reasoning attached, and `tools/qa-p2p.mjs`'s `params` arm asserts the table
 * without a browser.
 *
 * ## The table, and the one rule that decides it
 *
 * > **An explicit `?net=` is the only thing that asks for a relay.**
 *
 * | URL | Wire | Introduced by |
 * |---|---|---|
 * | `?net=ws://host:port&room=CODE` | the relay, exactly as before | n/a |
 * | `?room=CODE` on a page whose server declares a relay | peer to peer | that relay's `/signal` |
 * | `?room=CODE` anywhere else — including the deployed site | peer to peer | public brokers |
 * | `?room=CODE&sig=ws://host:port` | peer to peer | that address's `/signal` |
 * | `?room=CODE&sig=broker` | peer to peer | public brokers, whatever the page says |
 *
 * Three things about that table are decisions rather than defaults:
 *
 * - **`?net=` still means what it always meant.** Every invite link that exists today keeps
 *   working, and the relay stays reachable as a transport rather than only as a signaller. It is
 *   the A/B instrument for this whole pass — `docs/MULTIPLAYER.md` §13.7 — and an instrument you
 *   have to rebuild to use is an instrument nobody uses.
 * - **A bare `?room=` now means peer to peer, on `npm run host` as well as on the deployed
 *   site.** That is the change, and on a LAN it is not a downgrade: ICE connects two machines on
 *   one network over *host* candidates, so the orders go switch-to-switch instead of taking a
 *   hop through a process on one of the two laptops. Measured on this machine, two browsers:
 *   the channel opens in 57-209 ms and the candidate pair reports a round trip of about 1 ms.
 * - **The page's own relay outranks the public brokers when there is one.** Nothing needs to
 *   leave the house to introduce two machines that are already on one switch, and the owner
 *   declining a cloud service on 2 Sep 2026 (`docs/RELAY-OPTIONS.md`) reads as a preference
 *   about that in general and not only about that one service.
 */
export type Transport =
  | { kind: 'relay'; base: string; room: string; want: 'host' | 'join' }
  | {
    kind: 'peer'; room: string; want: 'host' | 'join';
    /** `null` means the public brokers. A string is a relay origin to signal through. */
    signalWs: string | null;
  };

/**
 * Read the URL. `serverRelayUrl` is what this document's own server said about itself.
 *
 * Takes the server's answer rather than reading the document, so the table can be asserted from
 * Node with no DOM — which is what `tools/qa-p2p.mjs`'s `params` arm does. `NetLobby.serverRelay`
 * is the caller's source for it, and its docstring is emphatic that it is **never a guess**: a
 * `null` there means no relay, not "probably the usual port".
 */
export function chooseTransport(
  params: URLSearchParams,
  serverRelayUrl: string | null
): Transport | null {
  const room = (params.get('room') ?? '').toUpperCase();
  if (!room) return null;
  if (!validCode(room)) {
    console.error(`[net] '${room}' is not a room code`);
    return null;
  }
  /*
   * `want` is read the same way for both transports, and the asymmetry in the default is
   * `NetLink.netParams`' and is kept exactly: host unless `&host=0`.
   *
   * A bare `?room=` with nothing else is the one case that reads the other way, and `main.ts`
   * handles it before this is called — an invitation is by definition to the other side.
   */
  const want = params.get('host') === '0' ? 'join' : 'host';
  const base = (params.get('net') ?? '').trim();
  if (base) return { kind: 'relay', base, room, want };
  const sig = (params.get('sig') ?? '').trim();
  if (sig === 'broker') return { kind: 'peer', room, want, signalWs: null };
  if (sig) return { kind: 'peer', room, want, signalWs: sig };
  return { kind: 'peer', room, want, signalWs: serverRelayUrl };
}

export interface BuildOptions {
  /** Override the STUN list. The gate uses it to measure what happens with none. */
  iceServers?: RTCIceServer[];
  /** Test-only. See `PeerLinkOptions.onlyCandidates`. */
  onlyCandidates?: string[] | null;
  /** Override the public broker list. The gate points this at its own to stay offline. */
  brokers?: string[];
  /** Test-only. Milliseconds of one-way delay on the data channel. See `sendDelayMs`. */
  sendDelayMs?: number;
  /** Test-only. Corrupts what this peer commits. See `PeerFault`. */
  fault?: PeerFault | null;
}

/**
 * The test-only knobs, read from the URL in one place so there is one place to audit.
 *
 * Every one of these has an equivalent on `tools/relay.mjs` as a command-line flag, and the
 * reason they are URL parameters here is that the thing being configured lives in the *page*.
 * A relay is a process a gate starts with arguments; a peer is a browser tab, and a tab's
 * arguments are its query string.
 *
 * The audit that matters: **nothing in `src/` writes any of these.** `NetLobby` builds
 * `?room=`, `?host=`, `?sig=`, `?net=` and `?menu=` and no more, `main.ts` adds nothing, and a
 * player who does not type one gets `null` from every branch below. They are exactly as
 * reachable as `--fault=ulp` is on the relay, which is to say only by somebody who meant it.
 */
export function testKnobs(params: URLSearchParams): BuildOptions {
  const out: BuildOptions = {};
  const lag = Number(params.get('p2plag') ?? '');
  if (Number.isFinite(lag) && lag > 0) out.sendDelayMs = lag;
  const only = (params.get('p2pcand') ?? '').trim();
  if (only) out.onlyCandidates = only.split(',').map((x) => x.trim()).filter(Boolean);
  if (params.get('p2pstun') === '0') out.iceServers = [];
  const kind = (params.get('p2pfault') ?? '').trim();
  if (kind === 'drop' || kind === 'dup' || kind === 'swap' || kind === 'ulp') {
    out.fault = {
      kind,
      fromTurn: Number(params.get('p2pfault-from') ?? 20) || 20,
      phase: params.get('p2pfault-phase') === 'deploy' ? 'deploy' : 'battle',
      once: params.get('p2pfault-every') !== '1',
    };
  }
  const brokers = (params.get('p2pbrokers') ?? '').trim();
  if (brokers) out.brokers = brokers.split(',').map((x) => x.trim()).filter(Boolean);
  return out;
}

/** The channel a peer session will be introduced over, as a sentence a player could read. */
export function signalFor(t: Transport, o: BuildOptions = {}): SignalChannel {
  if (t.kind !== 'peer') throw new Error('signalFor: not a peer transport');
  const slot = t.want === 'host' ? 0 : 1;
  return t.signalWs
    ? new WsSignal(t.signalWs, t.room, slot)
    : new MqttSignal(t.room, slot, o.brokers ?? PUBLIC_BROKERS);
}

/**
 * The wire itself. One line each, which is the point of `Link`.
 *
 * `main.ts` calls this and then never asks again which one it got: the loading screen, the
 * handshake, the deployment phase, the battle loop, the desync report and the session-over sheet
 * are all written against `Link` and `NetSession`. The only place in `src/` that branches on the
 * transport after this line is the *wording* of two sentences, because "the relay closed the
 * connection" and "the other player's connection closed" are different accusations about
 * different parties.
 */
export function makeLink(t: Transport, o: BuildOptions = {}): Link {
  if (t.kind === 'relay') return new NetLink(t.base, t.room, t.want);
  return new PeerLink({
    code: t.room,
    want: t.want,
    signal: signalFor(t, o),
    iceServers: o.iceServers ?? STUN_SERVERS,
    onlyCandidates: o.onlyCandidates ?? null,
    sendDelayMs: o.sendDelayMs ?? 0,
    fault: o.fault ?? null,
  });
}

/** How this session is described on screen and in a report. Never read by the simulation. */
export const transportLabel = (t: Transport): string =>
  t.kind === 'relay'
    ? `a relay at ${t.base}`
    : t.signalWs
      ? `a direct connection, introduced by ${t.signalWs}`
      : 'a direct connection, introduced over the internet';
