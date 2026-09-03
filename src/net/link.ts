import type { ClientMsg, RelayMsg } from './protocol.ts';

/**
 * The wire, as the only thing `NetSession` is allowed to know about it.
 *
 * ## Why this interface exists
 *
 * There are two transports now. `NetLink` is a `WebSocket` to a relay; `PeerLink` is an
 * `RTCPeerConnection` straight to the other player with a `PeerRoom` behind it. They are
 * completely different mechanisms and `NetSession` — the file that holds the lockstep
 * guarantees, the ceiling, the stall accounting and the silence test — contains **not one line**
 * that distinguishes them. That is the point of extracting this: the netcode was already written
 * against a small surface, and naming the surface is what let the second transport be added
 * without editing the part that decides the battle.
 *
 * The one method that is not in `NetLink`'s original shape is `pump`, and it is optional
 * precisely so that reading this interface tells you which transport needs it and why.
 *
 * ## What every implementation owes the session
 *
 * Three facts, and they are the whole of `NetSession.linkFault`:
 *
 * 1. **`dropped`** — a non-empty string the moment the transport is gone, whether or not the
 *    handshake ever completed. `NetLink`'s docstring records what it cost to learn that: for a
 *    day, a socket that closed *after* `welcome` set a boolean nobody read, and the owner's
 *    battle froze with the animations running and nothing on screen saying why.
 * 2. **`counts.got` and `gapMs`** — inbound frames, and the interval between them. The backstop
 *    for the case `onclose` cannot cover, which is a half-open link after a sleeping laptop or a
 *    dropped wireless connection. This obliges an implementation to make its inbound traffic
 *    *unconditional*: `Room.tick` emits a turn packet every `turnMs` whatever the clients are
 *    doing, and `PeerRoom` beats on the same cadence when a commit was not due. A transport that
 *    goes quiet when the game is quiet turns the silence test into a false alarm.
 * 3. **`counts.got` must count frames that came from the other side.** A transport with a state
 *    machine on this side of the wire could satisfy the silence test out of its own output, and
 *    the test would then be a check that cannot fail. `PeerLink` counts data-channel frames and
 *    nothing else for exactly this reason.
 */
export interface Link {
  /** The room code. Shown to the player and printed in every refusal. */
  readonly room: string;
  /** Which side of the battle this page asked for. Fixes the slot in a peer session. */
  readonly want: 'host' | 'join';
  /** 0 for the host, 1 for the challenger. -1 until the session has one. */
  slot: number;
  /** Set from a refusal, or from a transport failure. A non-empty string is fatal. */
  refusal: string;
  /**
   * The *other side's* own words, set only from a refusal and never from a transport error.
   *
   * "Nothing answered at this address" and "you were read your code and refused" are different
   * problems with different fixes, and the screen a player gets has to pick one.
   */
  refusedByRelay: string;
  peer: 'absent' | 'joined' | 'ready' | 'left';
  closed: boolean;
  /** Why the transport went away, or `''`. Set once. Distinct from `refusal`. */
  dropped: string;
  /** `performance.now()` of the last inbound frame, or 0 before the first. */
  lastMessageAt: number;
  /** Smoothed gap between inbound frames, in ms. 0 until the second one arrives. */
  gapMs: number;

  /** Open, and resolve with the slot. Rejects with a sentence a player can read. */
  connect(timeoutMs?: number): Promise<number>;
  /** Wait for one of these message kinds. Used by the lobby, never by the battle loop. */
  once(kinds: string[], timeoutMs?: number): Promise<RelayMsg>;
  send(m: ClientMsg): void;
  /** Everything received since the last call, in arrival order. */
  drain(): RelayMsg[];
  close(why?: string): void;
  readonly counts: { sent: number; got: number };

  /**
   * Drive a transport that has to be told how far the simulation has got. A relay does not.
   *
   * Called once a frame from `NetSession.update`, after the ceiling has been set. `NetLink`
   * does not implement it: the relay closes turns on its own wall clock and a client's progress
   * is none of its business.
   *
   * `PeerLink` needs it, and the reason is the single most load-bearing line in the
   * peer-to-peer design. A peer earns the right to commit turn `k` by having *consumed* turn
   * `k - delay`, which is what ties the commit rate to the tick rate. Without that tie, turn
   * emission needs both commits, a commit follows immediately on an emission, the ceiling races
   * away from the simulation, and `pace` reads a large `behindTicks` and sets `gameSpeed` to 8 —
   * two peers playing a ten-minute battle in seventy seconds, consistently, identically, and
   * completely wrong. See `PeerRoom.pump`.
   */
  pump?(simTick: number): void;
  /**
   * How many seconds of silence this transport wants before it is called a fault, or undefined
   * for `NetSession`'s default.
   *
   * On the `Link` rather than in `NetSession` because the two transports are asking genuinely
   * different questions. Under a relay the thing that has gone quiet is a dedicated process that
   * does nothing but send; if *it* stops for six seconds something is really wrong. Between two
   * peers the thing that has gone quiet is the other player's browser, which hitches exactly the
   * way yours does — and `NetSession` cannot tell those apart from where it sits.
   */
  readonly silentFloorS?: number;

  /**
   * What the connection actually did, for a gate and for a bug report. Never for the simulation.
   *
   * Optional because a relay session has nothing interesting to say — the address is in the URL
   * and the socket either opened or did not. A peer session has a great deal: which candidate
   * types were gathered, which pair ICE selected, what the round trip is, and whether either
   * STUN server answered. That last set is what lets a *measurement* say what kind of connection
   * it was measuring, instead of asserting that something connected and calling it peer to peer.
   */
  diag?(): Promise<Record<string, unknown>>;
}
