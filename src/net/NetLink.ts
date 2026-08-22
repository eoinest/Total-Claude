import { RELAY_V, validCode, type ClientMsg, type RelayMsg } from './protocol';

/**
 * The socket, and the part of a session that has to exist before the engine does.
 *
 * ## Why this is separate from `NetSession`
 *
 * A challenger cannot boot the battle until it knows which battle it is. The graphics tier
 * fixes `quality.maxSoldiers` at `Engine` construction, `fittedUnitScale` fits the army to it,
 * and `docs/MULTIPLAYER.md` §7.7bis has the measurement that makes this non-negotiable: the
 * Campus Martius assault is 3,074 men at ultra and 3,009 at medium, and the ram crew dies 16 m
 * short of the door at one tier and opens the gate at the other. So the join flow is
 * *connect, receive the host's battle, then build the engine* — which means the socket has to
 * outlive nothing and predate everything.
 *
 * `NetSession` is the subsystem that drives a battle. This is the wire underneath it, usable
 * from `main.ts` before a single system has been registered.
 *
 * ## Reconnection is not implemented and the refusal is the relay's
 *
 * `docs/MULTIPLAYER.md` §4.5 refuses reconnection into a live battle, and this pass has not
 * revisited that. See §9.6 for what it would cost — it is the §1.8 snapshot serialiser, which
 * that section's own reviewer counted at 331 mutated instance fields across twelve systems.
 * What this file does instead is make the failure legible: a dropped socket ends the match by
 * name at a stated tick, on both sides, rather than freezing one of them.
 */
export class NetLink {
  readonly room: string;
  readonly want: 'host' | 'join';
  slot = -1;
  /** Set from `refuse`, or from a transport failure. A non-empty string is fatal. */
  refusal = '';
  peer: 'absent' | 'joined' | 'ready' | 'left' = 'absent';
  closed = false;

  /** Every message, in arrival order, for whoever attaches. Drained by `NetSession`. */
  private queue: RelayMsg[] = [];
  private waiters: { kinds: string[]; ok: (m: RelayMsg) => void; fail: (e: Error) => void }[] = [];
  private ws: WebSocket | null = null;
  private url: string;
  private sent = 0;
  private got = 0;

  constructor(base: string, room: string, want: 'host' | 'join') {
    if (!validCode(room)) throw new Error(`'${room}' is not a room code`);
    this.room = room;
    this.want = want;
    const q = `?want=${want}&v=${RELAY_V}`;
    this.url = `${base.replace(/\/+$/, '')}/room/${room}${q}`;
  }

  /**
   * Open, and resolve on `welcome`.
   *
   * Rejects on `refuse`, which is the whole reason this returns a promise: a client that
   * half-joined a full room and then sat waiting for a turn packet would present as a hang,
   * and `docs/MULTIPLAYER.md`'s standing complaint about this project's instruments is that
   * they fail by saying nothing.
   */
  connect(timeoutMs = 15000): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const die = (why: string): void => {
        if (settled) return;
        settled = true;
        this.refusal = why;
        reject(new Error(why));
      };
      const timer = setTimeout(() => die(`no answer from ${this.url} in ${timeoutMs} ms`), timeoutMs);
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) {
        clearTimeout(timer);
        die(`could not open ${this.url}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.ws = ws;
      ws.onerror = () => { clearTimeout(timer); die(`the relay at ${this.url} refused the connection`); };
      ws.onclose = () => {
        this.closed = true;
        clearTimeout(timer);
        die(`the relay closed the connection${this.refusal ? `: ${this.refusal}` : ''}`);
        for (const w of this.waiters.splice(0)) w.fail(new Error('socket closed'));
      };
      ws.onmessage = (ev) => {
        let m: RelayMsg;
        try { m = JSON.parse(String(ev.data)) as RelayMsg; } catch { return; }
        this.got++;
        if (m.k === 'welcome') {
          this.slot = m.slot;
          if (m.v !== RELAY_V) { clearTimeout(timer); die(`relay speaks v${m.v}, this build speaks v${RELAY_V}`); return; }
          if (!settled) { settled = true; clearTimeout(timer); resolve(m.slot); }
          return;
        }
        if (m.k === 'refuse') {
          this.refusal = `${m.why}: ${m.detail ?? ''}`.trim();
          clearTimeout(timer);
          die(this.refusal);
        }
        if (m.k === 'peer') this.peer = m.state;
        this.queue.push(m);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].kinds.includes(m.k)) this.waiters.splice(i, 1)[0].ok(m);
        }
      };
    });
  }

  /** Wait for one of these message kinds. Used by the lobby, never by the battle loop. */
  once(kinds: string[], timeoutMs = 120000): Promise<RelayMsg> {
    const already = this.queue.find((m) => kinds.includes(m.k));
    if (already) return Promise.resolve(already);
    return new Promise((ok, fail) => {
      const w = { kinds, ok, fail };
      this.waiters.push(w);
      setTimeout(() => {
        const at = this.waiters.indexOf(w);
        if (at >= 0) { this.waiters.splice(at, 1); fail(new Error(`no ${kinds.join('/')} in ${timeoutMs} ms`)); }
      }, timeoutMs);
    });
  }

  send(m: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.sent++;
    this.ws.send(JSON.stringify(m));
  }

  /** Everything received since the last call, in arrival order. */
  drain(): RelayMsg[] {
    if (!this.queue.length) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  close(why = 'closed'): void {
    if (this.ws && this.ws.readyState === 1) this.send({ k: 'bye', why });
    this.ws?.close();
    this.closed = true;
  }

  get counts(): { sent: number; got: number } { return { sent: this.sent, got: this.got }; }
}

/**
 * What `?net=…` says, parsed once.
 *
 * `net` is the relay's WebSocket origin — `ws://127.0.0.1:5901` locally, `wss://…workers.dev`
 * once the Worker in `net/` is deployed. It is a parameter rather than a constant because
 * `tools/deploy-vercel.mjs` uploads a static tree with no build step, so there is nowhere to
 * bake one in; the lobby writes it into the invite link it puts on the clipboard.
 */
export interface NetParams {
  base: string;
  room: string;
  want: 'host' | 'join';
}

export function netParams(params: URLSearchParams): NetParams | null {
  const base = params.get('net');
  const room = (params.get('room') ?? '').toUpperCase();
  if (!base || !room) return null;
  if (!validCode(room)) {
    console.error(`[net] '${room}' is not a room code`);
    return null;
  }
  /*
   * The pairing policy is deliberately *not* a client parameter.
   *
   * It is the relay's, because the relay is the only party that sees both fingerprints, and
   * because a policy either side could set is a policy either side could set to 'allow
   * anything'. `--pairs` and `--unknown` on `tools/relay.mjs`; see `PairTable`.
   */
  return { base, room, want: params.get('host') === '0' ? 'join' : 'host' };
}
