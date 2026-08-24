#!/usr/bin/env node
/**
 * The relay, locally: one WebSocket server, one `Room` per code, no dependencies.
 *
 * Usage:
 *   node tools/relay.mjs [--port=5959] [--host=127.0.0.1] [--delay=2] [--turn-ms=100] [--lag=0]
 *                        [--pairs=exact,chromium+webkit] [--unknown=refuse|allow]
 *                        [--fatal=uf64,uctl,pool,alive]
 *                        [--max-lag-turns=300] [--quiet]
 *                        [--fault=drop|dup|swap|ulp --fault-slot=0|1 --fault-from=N
 *                         --fault-phase=battle|deploy --fault-every]
 *
 *   ws://127.0.0.1:5959/room/<CODE>?want=host|join
 *   http://127.0.0.1:5959/status          — every room, as JSON
 *   http://127.0.0.1:5959/health          — one line, for a wait loop
 *   http://127.0.0.1:5959/new[?room=CODE] — open a room, or claim one by name. CORS-open.
 *
 * ## Why this exists as well as `net/worker.ts`
 *
 * `docs/MULTIPLAYER.md` §4.3 rules out Vercel Functions on instance affinity and recommends a
 * Cloudflare Worker with one Durable Object per room code, because `idFromName(roomCode)` is a
 * globally unique object reachable from anywhere. That is the right target and `net/worker.ts`
 * is it. It is also unrunnable and untestable without an account, and a thing that works
 * end-to-end on this machine is worth more today than a thing that would work in a datacentre.
 *
 * So both hosts drive the *same* `Room` — `src/net/room.ts`, imported here as TypeScript,
 * which Node 24 strips types from at load. The protocol cannot drift between them because
 * there is only one copy of it. What differs is 90 lines of framing here against about 60
 * lines of `state.acceptWebSocket()` there.
 *
 * ## The WebSocket implementation, and why it is hand-rolled
 *
 * `ws` would be nine lines instead of ninety. This repository has one runtime dependency and
 * generates its own textures, its own city and all 89 of its sounds, and `ASSETS.md` requires
 * a licence check for anything added; a server-side handshake is a SHA-1 and a header, and
 * frame parsing for text frames under 64 kB is a length byte and an XOR. The parts of RFC 6455
 * deliberately *not* implemented are named in `frameIn` below, and every one of them would be
 * a bug rather than a limitation if it mattered here.
 *
 * ## Never 5173
 *
 * Default 5959. The 5900s are this pass's band; 5173 belongs to whoever is playing the game.
 * 5901, 5911 and 5949 were held by other agents' dev servers on the day this was written, so
 * the default is deliberately at the top of the band rather than the bottom of it.
 *
 * ## `--host`, and why loopback stays the default
 *
 * `listen(PORT, '127.0.0.1')` is the only bind this had, which is correct for the twelve relays
 * `tools/qa-net.mjs` starts and kills over a run and wrong for the one thing a person wants to
 * do with it. A relay the machine next door cannot reach is not a relay; it is half of one.
 *
 * The default does not move, and the reason is not caution. Binding `0.0.0.0` on macOS raises
 * the *Allow incoming connections* dialog against the node binary, and it raises it again
 * whenever that binary's path changes — an `nvm` upgrade is a new path. A gate that runs a
 * dozen relays must never be able to put a modal in front of an unattended run. So the harness
 * keeps loopback and `tools/host-lan.mjs`, which is a thing a person types and watches, passes
 * `--host=0.0.0.0` and warns about the prompt before it happens.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { CODE_ALPHABET, CODE_LEN, DEFAULT_PAIRS, validCode } from '../src/net/protocol.ts';
import { makeCode, noSuchRoom, Room } from '../src/net/room.ts';

// ---------------------------------------------------------------------------
// Arguments. An unknown flag is fatal — see tools/qa-replay.mjs for the reason.
// ---------------------------------------------------------------------------

const FLAGS = ['port', 'host', 'pairs', 'unknown', 'fatal', 'delay', 'turn-ms', 'lag',
  'max-lag-turns', 'quiet', 'fault', 'fault-slot', 'fault-from', 'fault-every', 'fault-phase',
  'parent'];
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const bad = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (bad.length) {
  console.error(`unknown flag(s): ${bad.map((k) => `--${k}`).join(', ')}`);
  console.error(`known: ${FLAGS.map((k) => `--${k}`).join(' ')}`);
  process.exit(2);
}
const PORT = Number(args.get('port') ?? 5959);
/** See "`--host`, and why loopback stays the default" above. `0.0.0.0` is the LAN bind. */
const HOST = args.get('host') ?? '127.0.0.1';
/*
 * The pairing table, as a flag, because the measurement behind it moved twice on the day this
 * was written. `--pairs=exact,chromium+webkit` overrides the default list;
 * `--unknown=allow` plays an unlisted pairing anyway and says so in the lobby.
 */
let PAIRS = DEFAULT_PAIRS;
if (args.has('pairs')) {
  const want = args.get('pairs').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = [];
  for (const w of want) {
    const [a, b] = w.split('+');
    const known = DEFAULT_PAIRS.allow.find((r) => (r.a === a && (r.b ?? '') === (b ?? '')));
    allow.push(known ?? {
      a, b, willFork: true,
      note: `${w}, allowed on the command line. Nothing is known about whether it holds.`,
    });
  }
  PAIRS = { allow, unknown: DEFAULT_PAIRS.unknown };
}
if (args.has('unknown')) {
  const u = args.get('unknown');
  if (u !== 'refuse' && u !== 'allow') {
    console.error(`--unknown must be refuse or allow; got '${u}'`);
    process.exit(2);
  }
  PAIRS = { ...PAIRS, unknown: u };
}
const LAYERS = ['uf64', 'uctl', 'pool', 'alive'];
const FATAL = (args.get('fatal') ?? 'uf64,uctl,pool,alive').split(',').map((s) => s.trim());
for (const l of FATAL) {
  if (!LAYERS.includes(l)) {
    console.error(`--fatal names ${LAYERS.join(', ')}; got '${l}'`);
    process.exit(2);
  }
}
const DELAY = Number(args.get('delay') ?? 2);
const TURN_MS = Number(args.get('turn-ms') ?? 100);
/** Artificial one-way delay, in ms, on every relayed message. For measuring input lag. */
const LAG = Number(args.get('lag') ?? 0);
const MAX_LAG_TURNS = Number(args.get('max-lag-turns') ?? 300);
const QUIET = args.has('quiet');
const FAULT_KINDS = ['drop', 'dup', 'swap', 'ulp'];
let FAULT = null;
if (args.has('fault')) {
  const kind = args.get('fault');
  if (!FAULT_KINDS.includes(kind)) {
    console.error(`--fault must be one of ${FAULT_KINDS.join(', ')}; got '${kind}'`);
    process.exit(2);
  }
  const fphase = args.get('fault-phase') ?? 'battle';
  if (fphase !== 'battle' && fphase !== 'deploy') {
    console.error(`--fault-phase must be battle or deploy; got '${fphase}'`);
    process.exit(2);
  }
  FAULT = {
    kind,
    slot: Number(args.get('fault-slot') ?? 1),
    fromTurn: Number(args.get('fault-from') ?? 0),
    phase: fphase,
    once: !args.has('fault-every'),
  };
}
for (const [k, v] of [['delay', DELAY], ['turn-ms', TURN_MS], ['lag', LAG],
  ['max-lag-turns', MAX_LAG_TURNS], ['port', PORT]]) {
  if (!Number.isFinite(v)) { console.error(`--${k} must be a number`); process.exit(2); }
}

const log = (...a) => { if (!QUIET) console.log(...a); };

// ---------------------------------------------------------------------------
// RFC 6455, the parts this needs
// ---------------------------------------------------------------------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Encode one frame. Text or close, never fragmented, never masked (a server must not mask).
 *
 * Only the three length forms the spec defines are emitted, and the 8-byte form is written
 * through `writeBigUInt64BE` rather than as two 32-bit halves, because a JSON turn packet can
 * exceed 64 kB the moment somebody selects a whole army and the two-halves version of this is
 * where that would first be noticed.
 */
function frameOut(payload, opcode = 0x1) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const n = body.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, body]);
}

/**
 * Pull complete frames out of a buffer.
 *
 * Deliberately not implemented, because each would be a bug here rather than a limitation:
 * **fragmentation** (this relay's only writer is the browser's own `WebSocket.send`, which
 * never fragments a single `send`), **extensions** (none are negotiated, so RSV bits set means
 * a broken peer), and **binary frames** (the wire is JSON; a binary frame is a protocol
 * error). Each of those returns `{ err }` so the socket is closed rather than silently
 * misread — a relay that guesses at a frame it does not understand is a relay that can
 * fabricate an order.
 */
function frameIn(buf) {
  const frames = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const b0 = buf[at];
    const b1 = buf[at + 1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = at + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      if (big > 8_000_000n) return { frames, rest: buf, err: 'frame too large' };
      len = Number(big);
    }
    if (masked) { if (buf.length - p < 4) break; }
    const maskAt = p;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    if (rsv) return { frames, rest: buf, err: 'reserved bits set, no extension negotiated' };
    if (!fin) return { frames, rest: buf, err: 'fragmented frame' };
    if (!masked) return { frames, rest: buf, err: 'client frame was not masked' };
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = buf[p + i] ^ buf[maskAt + (i & 3)];
    p += len;
    at = p;
    if (op === 0x8) return { frames, rest: buf.subarray(at), close: true };
    if (op === 0x9) { frames.push({ ping: body }); continue; }
    if (op === 0xa) continue;                       // pong: nothing to do
    if (op !== 0x1) return { frames, rest: buf, err: `unexpected opcode 0x${op.toString(16)}` };
    frames.push({ text: body.toString('utf8') });
  }
  return { frames, rest: buf.subarray(at) };
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** `code -> { room, sockets: [sock|null, sock|null] }` */
const rooms = new Map();

const roomOpts = () => ({
  delayTurns: DELAY, turnMs: TURN_MS, pairs: PAIRS, fatal: FATAL,
  maxLagTurns: MAX_LAG_TURNS, fault: FAULT,
});

function roomFor(code) {
  let r = rooms.get(code);
  if (!r) {
    rooms.set(code, (r = { room: new Room(code, roomOpts()), sockets: [null, null], made: Date.now() }));
  }
  return r;
}

/**
 * How long a room nobody ever entered is kept, in milliseconds.
 *
 * `/new` mints the room *before* the host has it, because the host is about to spend thirty
 * seconds choosing a battle and a challenger with the link may well arrive first — the room
 * has to exist for that challenger to be let in. The cost of that is a room per press of
 * CREATE, and before CORS was fixed every press failed in the browser and left one behind:
 * the relay was doing its job and the answer was being thrown away by the same-origin policy.
 *
 * Ten minutes, which is longer than anyone spends choosing a battle and shorter than anyone
 * would keep a code they never used. An occupied room is never reaped however old it is;
 * the test is *empty and never entered*.
 */
const EMPTY_ROOM_TTL_MS = 600_000;

let sends = 0;
let recvs = 0;

function sendTo(entry, to, msg) {
  const text = JSON.stringify(msg);
  const targets = to === 'all' ? [0, 1] : [to];
  for (const i of targets) {
    const sock = entry.sockets[i];
    if (!sock || sock.destroyed) continue;
    sends++;
    if (LAG > 0) setTimeout(() => { if (!sock.destroyed) sock.write(frameOut(text)); }, LAG);
    else sock.write(frameOut(text));
  }
}

function flush(entry, reply) {
  for (const o of reply.out ?? []) sendTo(entry, o.to, o.msg);
  for (const i of reply.close ?? []) {
    const s = entry.sockets[i];
    if (s && !s.destroyed) setTimeout(() => s.end(frameOut('', 0x8)), LAG + 40);
  }
}

/*
 * One timer for every room, not one per room.
 *
 * A Durable Object gets an alarm and this gets a `setInterval`, and both are the same idea:
 * the turn clock is the relay's, not either client's. 10 ms is a tenth of a turn, so the
 * closing time of a turn is accurate to 10 ms — well inside the jitter of the link it is
 * scheduling against, and cheap enough to leave running.
 */
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of rooms) {
    flush(entry, entry.room.tick(now));
    if (entry.room.over && !entry.sockets[0] && !entry.sockets[1]) { rooms.delete(code); continue; }
    // A room `/new` minted that nobody ever walked into. See `EMPTY_ROOM_TTL_MS`.
    if (entry.room.phase === 'lobby' && entry.room.occupied === 0
      && now - entry.made > EMPTY_ROOM_TTL_MS) rooms.delete(code);
  }
}, 10).unref?.();

// ---------------------------------------------------------------------------
// HTTP: a status page, a health line, and the upgrade
// ---------------------------------------------------------------------------

/**
 * Cross-origin, unconditionally, on every HTTP answer this relay gives.
 *
 * **This one missing header is why "Create a room" had never once worked.** The page is served
 * by Vite on one port and the relay listens on another, so `fetch('http://…:5959/new')` from
 * the lobby is a cross-origin request. The relay answered it correctly — 200, a fresh code, a
 * room minted and waiting — and the browser then refused to hand the body to the script,
 * because no `Access-Control-Allow-Origin` came back with it. The `fetch` promise rejected with
 * a `TypeError`, the lobby's `.catch` printed *"No relay at ws://… — start one with node
 * tools/relay.mjs"* while that relay was running and had just done exactly what was asked, and
 * the room stayed on the relay for ever with nobody in it. Every press leaked one.
 *
 * `*` rather than an origin echo, and it is the honest answer here: the relay has no cookies,
 * no auth and no private state — `/status` is already a public page of every room — so there is
 * nothing for a third-party origin to steal by reading a reply it could have got itself. The
 * WebSocket upgrade is unaffected either way; sockets are not subject to the same-origin policy.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-max-age': '600',
};
const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // A simple GET needs no preflight, but a browser that decides to send one must not get a 404.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain', ...CORS });
    res.end(`relay ok rooms=${rooms.size} sends=${sends} recvs=${recvs}\n`);
    return;
  }
  if (url.pathname === '/status') {
    sendJson(res, 200, {
      port: PORT, host: HOST, pairs: PAIRS, fatal: FATAL, delayTurns: DELAY, turnMs: TURN_MS,
      lagMs: LAG, fault: FAULT, sends, recvs,
      rooms: [...rooms.values()].map((e) => e.room.status()),
    });
    return;
  }
  /*
   * `/new` — mint a room, or claim the one the host asked for by name.
   *
   * `?room=CODE` exists because the lobby lets a player type their own code, which is what
   * happens when two people are already on the phone to each other: one of them says a word
   * and they both type it. Claiming it here rather than discovering the clash at the WebSocket
   * is the difference between "that one is taken, try another" on the form and a refusal
   * screen after a page navigation.
   *
   * The room is created either way, before the host's socket exists, because the host is about
   * to spend a minute in the setup sheet and the challenger may well arrive first.
   */
  if (url.pathname === '/new') {
    const asked = (url.searchParams.get('room') ?? '').trim().toUpperCase();
    if (asked) {
      if (!validCode(asked)) {
        sendJson(res, 400, {
          error: 'code',
          detail: `'${asked}' is not a room code: ${CODE_LEN} characters from ${CODE_ALPHABET}`,
        });
        return;
      }
      const held = rooms.get(asked);
      if (held && (held.room.phase !== 'lobby' || held.room.occupied > 0)) {
        sendJson(res, 409, {
          error: 'taken',
          detail: `room ${asked} is in use on this relay${held.room.phase !== 'lobby'
            ? ` and is already in its ${held.room.phase} phase` : ''}`,
        });
        return;
      }
      roomFor(asked);
      sendJson(res, 200, { room: asked });
      return;
    }
    let code = '';
    do { code = makeCode(() => randomBytes(1)[0] / 256, CODE_ALPHABET, CODE_LEN); }
    while (rooms.has(code));
    roomFor(code);
    sendJson(res, 200, { room: code });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain', ...CORS });
  res.end('relay: /room/<CODE> over websocket, /status, /health, /new[?room=CODE]\n');
});

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
  const key = req.headers['sec-websocket-key'];
  const die = (why) => {
    sock.write(`HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n${why}`);
    sock.destroy();
  };
  if (!m || !key) return die('expected /room/<CODE> with a websocket key');
  const code = m[1].toUpperCase();
  if (!validCode(code)) return die(`'${code}' is not a room code`);

  sock.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'upgrade: websocket\r\nconnection: Upgrade\r\n'
    + `sec-websocket-accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
  sock.setNoDelay(true);

  const want = url.searchParams.get('want') === 'join' ? 'join' : 'host';
  /*
   * A challenger may only walk into a room somebody opened. See `noSuchRoom`.
   *
   * `roomFor` creates on demand, which is right for a host — `?net=…&room=…` with no `host=0`
   * *is* the request to open one — and was catastrophic for a challenger: a mistyped code
   * conjured a second, empty room and the joiner waited in it for ever.
   */
  if (want === 'join' && !rooms.has(code)) {
    log(`  refused ${code} (noRoom): nobody has opened one`);
    sock.write(frameOut(JSON.stringify(noSuchRoom(code))));
    setTimeout(() => sock.end(frameOut('', 0x8)), 60);
    return;
  }
  const entry = roomFor(code);
  const v = Number(url.searchParams.get('v') ?? 1);
  const res = entry.room.join(Date.now(), want, v);
  if (res.slot < 0) {
    log(`  refused ${code} (${res.refuse.why}): ${res.refuse.detail}`);
    sock.write(frameOut(JSON.stringify(res.refuse)));
    setTimeout(() => sock.end(frameOut('', 0x8)), 60);
    return;
  }
  const slot = res.slot;
  entry.sockets[slot] = sock;
  log(`  slot ${slot} joined ${code} (${entry.room.occupied}/2)`);
  flush(entry, { out: res.out, close: [] });

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest, err, close } = frameIn(buf);
    buf = rest;
    for (const f of frames) {
      if (f.ping) { sock.write(frameOut(f.ping, 0xa)); continue; }
      recvs++;
      let msg;
      try { msg = JSON.parse(f.text); } catch { continue; }
      flush(entry, entry.room.recv(Date.now(), slot, msg));
    }
    if (err) { log(`  slot ${slot} framing: ${err}`); sock.destroy(); }
    if (close) sock.end(frameOut('', 0x8));
  });
  const gone = () => {
    if (entry.sockets[slot] !== sock) return;
    entry.sockets[slot] = null;
    log(`  slot ${slot} left ${code} (phase ${entry.room.phase})`);
    flush(entry, entry.room.leave(slot));
  };
  sock.on('close', gone);
  sock.on('error', gone);
});

server.listen(PORT, HOST, () => {
  log(`relay on ws://${HOST === '0.0.0.0' ? '<this machine>' : HOST}:${PORT}/room/<CODE>  `
    + `pairs=${PAIRS.allow.map((r) => (r.a === 'exact' ? 'exact' : `${r.a}+${r.b}`)).join('/')}`
    + `(unknown=${PAIRS.unknown}) fatal=${FATAL.join('/')} `
    + `delay=${DELAY} turn=${TURN_MS}ms lag=${LAG}ms`
    + `${FAULT ? `  FAULT ${FAULT.kind} on slot ${FAULT.slot} from turn ${FAULT.fromTurn}` : ''}`);
});
server.on('error', (e) => { console.error(`relay: ${e.message}`); process.exit(1); });

/*
 * Die with the parent that started us.
 *
 * `tools/qa-net.mjs` starts a dozen of these over a full run and kills each one when its arm
 * ends. That is correct and it is not enough: SIGTERM only helps when there is somebody alive
 * to send it, and the event this repository has actually had is the machine going down under
 * load with every harness on it SIGKILLed. `tools/lib/vite-runner.mjs` learned this for dev
 * servers on 22 Aug; a relay is the same hazard at a smaller size — a listener on a port in the
 * band the next run wants, owned by nobody.
 *
 * macOS has no `PR_SET_PDEATHSIG`, so this polls. `kill(pid, 0)` sends no signal and only asks
 * whether the process exists: ESRCH is gone, EPERM is alive and someone else's. A parent of 1
 * means we were reparented to launchd before we got going, which is the orphan state itself.
 *
 * Bounded orphan lifetime: two seconds. Run by hand without `--parent` and nothing watches,
 * which is what you want when you are playing rather than testing.
 */
const PARENT = Number(args.get('parent') ?? 0);
if (Number.isFinite(PARENT) && PARENT > 1) {
  const watch = setInterval(() => {
    try {
      process.kill(PARENT, 0);
    } catch (err) {
      if (err?.code === 'ESRCH') {
        log(`relay: parent ${PARENT} is gone; closing`);
        clearInterval(watch);
        try { server.close(); } catch { /* already closing */ }
        process.exit(0);
      }
    }
  }, 2000);
  watch.unref();
}
