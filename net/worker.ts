/**
 * The relay on Cloudflare: one Worker, one Durable Object per room code.
 *
 * ## Status: written, typechecked by nothing, deployed nowhere
 *
 * Say that plainly before anything else. This file has never run. There is no Cloudflare
 * account in this project, `wrangler` is not a dependency and adding one would need a licence
 * entry in `ASSETS.md` for a tool used once. What has run, end to end, hundreds of times, is
 * `tools/relay.mjs` — and the thing that makes this file worth having anyway is that both of
 * them drive the *same* `Room` from `../src/net/room.ts`. The protocol, the turn scheduling,
 * the pairing table, the desync detection and the attribution are all in that file and are all
 * already tested. What is here is sixty lines of plumbing.
 *
 * Deliberately outside `tsconfig.json`'s `include: ["src", "tools"]`, so `npx tsc --noEmit`
 * does not try to typecheck Cloudflare's ambient types, which are not installed. The `any`s
 * below are that decision showing through and they are the reason this is `net/` and not
 * `src/net/`.
 *
 * ## Why a Durable Object and not a plain Worker
 *
 * `docs/MULTIPLAYER.md` §4.3, and the reason is routing rather than state.
 * `env.ROOMS.idFromName(code)` is a *globally unique* object reachable from any edge location,
 * so two players who hit two different data centres reach the same instance by construction.
 * That is the primitive Vercel Functions do not have at any price — its own answer to "how do
 * two WebSockets reach the same instance" is Redis pub/sub from the Marketplace, which is
 * another service and another bill for a problem `idFromName` does not have.
 *
 * ## The two things not to get wrong here
 *
 * 1. **`state.acceptWebSocket()`, not `ws.accept()`.** The Hibernation API lets the object be
 *    evicted between messages and bills only for the time it is awake. `ws.accept()` bills
 *    duration for the whole connection, which for a ten-minute battle is the difference
 *    between §3's 76.8 GB-s and something like fifty times that.
 * 2. **The alarm is the turn clock.** `Room.tick(now)` has to be called about ten times a
 *    second whether or not a message arrives, because empty turns are what let a client
 *    advance. A hibernating object with no alarm set is an object whose battle has stopped.
 *    `setAlarm` is scheduled on every wake and re-armed here.
 *
 * ## Deploying it, when there is an account
 *
 *     npm i -D wrangler        # record the licence in ASSETS.md first
 *     npx wrangler deploy      # reads net/wrangler.toml
 *
 * then paste the `wss://…workers.dev` origin into the lobby's relay field. The static site does
 * not change and `tools/deploy-vercel.mjs` is untouched, exactly as §3 says.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { CODE_ALPHABET, CODE_LEN, validCode } from '../src/net/protocol.ts';
import { makeCode, Room } from '../src/net/room.ts';

/** How often the turn clock runs. A tenth of a turn, matching `tools/relay.mjs`. */
const ALARM_MS = 100;

export class RoomObject {
  private state: any;
  private room: Room | null = null;

  constructor(state: any) {
    this.state = state;
  }

  private get(code: string): Room {
    if (!this.room) this.room = new Room(code);
    return this.room;
  }

  /** Which slot a hibernated socket belongs to. Survives eviction; a closure would not. */
  private slotOf(ws: any): number {
    const tag = this.state.getTags?.(ws) ?? [];
    for (const t of tag) if (t.startsWith('slot:')) return Number(t.slice(5));
    return -1;
  }

  private socket(slot: number): any {
    for (const ws of this.state.getWebSockets(`slot:${slot}`)) return ws;
    return null;
  }

  private flush(reply: { out: any[]; close: number[] }): void {
    for (const o of reply.out ?? []) {
      const text = JSON.stringify(o.msg);
      for (const s of o.to === 'all' ? [0, 1] : [o.to]) {
        try { this.socket(s)?.send(text); } catch { /* the socket is gone; `leave` follows */ }
      }
    }
    for (const s of reply.close ?? []) {
      try { this.socket(s)?.close(1000, 'refused'); } catch { /* already closed */ }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = (url.pathname.split('/').pop() ?? '').toUpperCase();
    if (!validCode(code)) return new Response('bad room code', { status: 400 });
    if (req.headers.get('Upgrade') !== 'websocket') {
      return Response.json(this.get(code).status());
    }
    const pair = new (globalThis as any).WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const room = this.get(code);
    const want = url.searchParams.get('want') === 'join' ? 'join' : 'host';
    const v = Number(url.searchParams.get('v') ?? 1);
    const res = room.join(Date.now(), want, v);
    if (res.slot < 0) {
      // Accepted and then closed rather than rejected at the handshake, so the browser reads a
      // sentence instead of "connection failed". A refusal nobody can read is a hang.
      server.accept();
      server.send(JSON.stringify(res.refuse));
      server.close(1008, String((res.refuse as any)?.why ?? 'refused'));
      return new Response(null, { status: 101, webSocket: client } as any);
    }
    this.state.acceptWebSocket(server, [`slot:${res.slot}`]);
    this.flush({ out: res.out, close: [] });
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  webSocketMessage(ws: any, data: string): void {
    const slot = this.slotOf(ws);
    if (slot < 0 || !this.room) return;
    let msg: any;
    try { msg = JSON.parse(data); } catch { return; }
    this.flush(this.room.recv(Date.now(), slot, msg));
  }

  webSocketClose(ws: any): void {
    const slot = this.slotOf(ws);
    if (slot < 0 || !this.room) return;
    this.flush(this.room.leave(slot));
  }

  webSocketError(ws: any): void { this.webSocketClose(ws); }

  async alarm(): Promise<void> {
    if (this.room) this.flush(this.room.tick(Date.now()));
    const live = this.state.getWebSockets().length > 0;
    // Re-arm only while somebody is here. An object with no sockets and no alarm hibernates
    // and costs nothing, which is the whole reason for the Hibernation API.
    if (live) await this.state.storage.setAlarm(Date.now() + ALARM_MS);
  }
}

export default {
  async fetch(req: Request, env: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('relay ok\n');
    if (url.pathname === '/new') {
      const code = makeCode(() => Math.random(), CODE_ALPHABET, CODE_LEN);
      return Response.json({ room: code });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!m) return new Response('relay: /room/<CODE>, /new, /health\n', { status: 404 });
    /*
     * The line the whole transport decision rests on.
     *
     * `idFromName` hashes the room code to a stable object id, so every request naming the same
     * code reaches the same object from anywhere on earth. Cloudflare places it near whoever
     * first opened it. There is no lookup table, no Redis and no affinity to lose.
     */
    const id = env.ROOMS.idFromName(m[1].toUpperCase());
    return env.ROOMS.get(id).fetch(req);
  },
};
