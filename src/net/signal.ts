/**
 * The introduction: how two browsers that have never met exchange one offer and one answer.
 *
 * ## What this is for, and how small it is
 *
 * WebRTC cannot bootstrap itself. Two peers must swap an SDP offer, an SDP answer and a handful
 * of ICE candidates — about 4 kB in total, over two or three seconds, **once** — and after that
 * the data channel is direct and nothing here is ever used again. That last sentence is the
 * whole reason this file can be casual about its dependencies in a way `src/net/room.ts` could
 * not be: a broker outage means *new matches cannot be introduced*. It does not touch a match in
 * progress, and it never carries a single order.
 *
 * ## The decision, and the three things it was weighed against
 *
 * `docs/RELAY-OPTIONS.md` records the owner declining a Cloudflare Durable Object on 2 Sep 2026
 * — *"no account, no deploy and no dependency on a third party staying free"* — and the same
 * reasoning has to apply here or the choice is dishonest. So: nothing to deploy, nothing to pay
 * for, nothing to keep alive. Researched 2 Sep 2026, and the full working is in
 * `docs/MULTIPLAYER.md` §13.2.
 *
 * - **PeerJS's free cloud broker (`0.peerjs.com`), rejected.** MIT, still up, and genuinely
 *   easy. It fails on its ID namespace: the public broker runs one flat global ID space with no
 *   per-application key, so a five-character room code collides with every other PeerJS
 *   application's IDs — and `ID-TAKEN` calls `destroy()` on the client, which is fatal rather
 *   than retryable. Anyone can also hold a code open indefinitely with a five-second heartbeat.
 *   Add [peers/peerjs#1350](https://github.com/peers/peerjs/issues/1350), open since 14 Oct
 *   2025 — six-minute connection delays, reproduced by four people, with the status page green
 *   throughout because it only checks for an HTTP 200 — and the failure mode is a room that
 *   looks fine and never opens.
 * - **A signalling endpoint on the owner's own Vercel project, rejected — and this is a
 *   correction to `docs/MULTIPLAYER.md` §4.3.** Vercel now serves WebSockets natively (public
 *   beta, 22 Jun 2026) and a Hobby function may hold one for up to 300 s, which is ample for a
 *   handshake. §4.3's conclusion nevertheless stands, and now for a documented reason rather
 *   than an inferred one: Vercel's own docs say *"new WebSocket connections are not guaranteed
 *   to reach the same Vercel Function instance"* and direct you to external storage for rooms
 *   and presence. Two peers may therefore land on two instances with no way to introduce them.
 *   Fixing that means a store — Upstash Redis is the free one — which is an account to hold and
 *   a service to keep alive, i.e. exactly what was declined.
 * - **Trystero on public Nostr relays, seriously considered.** MIT, actively released, 28
 *   relays reachable of 28 tested, five used at once, and it encrypts the offer. It is the
 *   closest thing to right and it lost on two counts: it brings its own peer and room
 *   abstraction, so the `RTCPeerConnection` — and with it every diagnostic that says *why* a
 *   direct connection failed — stops being ours; and Nostr writes need secp256k1 Schnorr
 *   signatures, which is a real cryptography dependency to hold. `MqttSignal` below is 150 lines
 *   of packet encoding with no crypto in it beyond what the browser already ships.
 *
 * ## What was built: two brokers' worth of redundancy and no account anywhere
 *
 * `MqttSignal` speaks MQTT 3.1.1 over `wss://` to **three independent public brokers at once**
 * and treats them as one channel: publish to all, accept from whichever answers first,
 * de-duplicate. One broker down costs nothing and is not even reported. All three down is the
 * failure that gets a sentence, and the sentence names the alternative.
 *
 * The brokers are Eclipse Mosquitto's, EMQX's and HiveMQ's public test brokers. All three say
 * plainly that they are public and shared and that nothing sensitive should go over them —
 * Mosquitto's terms are *"please don't publish anything sensitive, anybody could be listening"*
 * — and that is taken at face value below.
 *
 * ## Privacy, stated rather than implied
 *
 * A public broker is a public square. Two things are done about it and one thing is not:
 *
 * - The topic is `tc/` + a hash of the room code, not the code. So the traffic is not indexed
 *   under anything a person typed, and it cannot collide with another application's topics.
 * - The payload is AES-GCM under a key derived from the room code with HKDF. A broker operator,
 *   or anyone subscribed to `#`, sees an opaque topic and ciphertext.
 * - **And it is not secret from someone who has the code.** Five characters out of a
 *   32-character alphabet is 33.5 million codes, which is minutes of offline work, so a
 *   determined eavesdropper who wants *your* room can find it. What they get is the IP addresses
 *   in your ICE candidates and the ability to join your game — both of which are already true
 *   of anyone you read the code out to. The game itself never touches the broker: orders go over
 *   DTLS-encrypted SCTP straight between the two peers.
 *
 * ## The other two strategies, and why the gate uses one of them
 *
 * `WsSignal` points at a `ws://…/signal/CODE` endpoint on `tools/relay.mjs`. It exists for two
 * reasons and both matter. On a LAN it is strictly better than a public broker — the two
 * machines are already talking to each other and nothing needs to leave the house. And it is
 * what `tools/qa-p2p.mjs` uses, because a gate whose green depends on `test.mosquitto.org` being
 * up is a gate that goes red for reasons that are not the product, which this repository has
 * written down twice as the thing that teaches people to ignore a check.
 *
 * The broker path is not therefore untested: `qa-p2p`'s `broker` arm exercises it against the
 * real public brokers, and is opt-in for the same reason `xengine` is.
 */

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

/** Everything two peers say to each other before they can talk directly. */
export type SignalMsg =
  /** "Is anybody hosting this code?" Repeated until answered; see `PeerLink`. */
  | { t: 'knock'; from: number }
  | { t: 'offer'; from: number; sdp: string }
  | { t: 'answer'; from: number; sdp: string }
  | { t: 'ice'; from: number; c: RTCIceCandidateInit }
  /** "I have a challenger already." The peer-to-peer spelling of `Room`'s `full` refusal. */
  | { t: 'full'; from: number };

/**
 * A two-way broadcast channel keyed by a room code. Carries opaque strings.
 *
 * Deliberately not "a signalling server client": the ICE dance is `PeerLink`'s and lives in one
 * place whichever channel carries it, so a bug in the handshake cannot be present in one
 * strategy and absent in another.
 */
export interface SignalChannel {
  /** For a message a player reads. `mqtt(3)`, `relay ws://…`. */
  readonly name: string;
  /** How many underlying connections are currently up. 0 means the channel is dead. */
  readonly live: number;
  open(timeoutMs?: number): Promise<void>;
  send(m: SignalMsg): void;
  /** Called for every message from the *other* peer. Own messages are filtered out. */
  onMessage: (m: SignalMsg) => void;
  /** Called once, when every underlying connection has gone. */
  onDead: (why: string) => void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Naming and sealing
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * `Uint8Array<ArrayBuffer>` spelled once.
 *
 * A bare `Uint8Array` in a type position now means `Uint8Array<ArrayBufferLike>`, which
 * `BufferSource` does not accept because a `SharedArrayBuffer` cannot be handed to
 * `crypto.subtle` or to `WebSocket.send`. Every buffer in this file is a plain one; saying so
 * once beats six casts.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** UTF-8 bytes in a plain buffer. `TextEncoder.encode` is not specific enough for `Bytes`. */
const utf8 = (s: string): Bytes => {
  const src = enc.encode(s);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
};

const b64 = (b: Bytes): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Bytes => {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/**
 * The topic, which is a hash and not the code.
 *
 * Eight bytes of SHA-256 over a namespaced string. Two properties are wanted and neither is
 * secrecy: a topic that cannot collide with another application's on a shared broker, and a
 * topic that is not the five characters somebody said out loud. `tc/` prefixed so an operator
 * looking at their own broker can see what it is.
 */
export async function topicFor(code: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256',
    utf8(`total-claude/v1/topic/${code.toUpperCase()}`)));
  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(2, '0');
  return `tc/${hex}`;
}

/**
 * Is `crypto.subtle` here at all? **On the LAN path it is not, and that is measured.**
 *
 * `crypto.subtle` is secure-context-only, and `npm run host` serves the game over plain `http`
 * on an address like `192.168.1.77:5938` — which is a *private* address, not loopback, so the
 * browser does not treat it as secure. Measured (`tools/scratch/securectx.mjs`), Chrome, same
 * server on two origins:
 *
 * | origin | `isSecureContext` | `crypto.subtle` | `getRandomValues` | `RTCPeerConnection` |
 * |---|---|---|---|---|
 * | `http://127.0.0.1:5948` | true | yes | yes | constructs, channel opens |
 * | `http://192.168.1.77:5948` | **false** | **undefined** | yes | constructs, channel opens |
 *
 * So the *transport* is fine on a LAN http origin and the *sealing* is not, and this shipped
 * broken until `qa-net`'s `lan` arm found it: `keyFor` threw
 * `Cannot read properties of undefined (reading 'importKey')`, `signal.open()` rejected, and the
 * host got *"The connection could not be made"* after pressing CHOOSE THE BATTLE. Loopback is a
 * secure context, so every earlier measurement of this pass was taken on the one origin where
 * the bug is invisible.
 *
 * What follows from it is in `seal` and in `MqttSignal.open`, and the split is not a compromise:
 * the origin that cannot seal is exactly the origin whose signalling never leaves the house.
 */
export const canSeal = (): boolean =>
  typeof crypto !== 'undefined' && !!(crypto as Crypto).subtle;

/**
 * The key, derived from the room code with HKDF-SHA256. AES-GCM 128. **Null where there is no
 * `crypto.subtle`** — see `canSeal`, and `seal` for what is done about it.
 *
 * **Exported for the gate, and that is not a convenience.** `qa-p2p`'s `seal` arm had its own
 * copy of this derivation inline, so `seal-round-trip` compared `seal` and `unseal` against a key
 * the *harness* had derived — and stayed green when this function was deliberately changed to
 * ignore the room code entirely. A check that duplicates the implementation it is checking cannot
 * fail; `tools/scratch/inject-p2p.mjs`'s `one-key-for-every-room` fault is what caught it.
 *
 * The salt and the info string are constants rather than random, because there is no channel to
 * carry a salt over that is not the channel being protected — the two peers share exactly one
 * secret and it is five characters long. That is a real and stated limit: this makes the traffic
 * opaque to a passive listener, and it is not proof against somebody who guesses the code. See
 * the privacy paragraph in the file docstring.
 */
export const keyFor = async (code: string): Promise<CryptoKey | null> => {
  if (!canSeal()) return null;
  const ikm = await crypto.subtle.importKey('raw',
    utf8(`total-claude/v1/${code.toUpperCase()}`), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: utf8('total-claude/v1/signal'),
      info: utf8('sdp'),
    },
    ikm, { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
};

/**
 * One envelope. `1` + base64(nonce ‖ ciphertext) when it is sealed, `0` + base64(JSON) when it
 * cannot be.
 *
 * **The prefix is not decoration.** Two peers can legitimately differ in whether they have
 * `crypto.subtle`: one on `https://total-claude.vercel.app`, the other on the same LAN relay's
 * plain-http page. Without a marker the second one's plaintext would be handed to
 * `crypto.subtle.decrypt` and returned as "an envelope that would not open" — which `unseal` is
 * deliberately quiet about, so a room would simply never form and nothing would say why.
 *
 * A `null` key means `canSeal()` was false. That happens on exactly one origin shape — a private
 * plain-http address, which is what `npm run host` serves — and on that origin the channel is a
 * relay on your own network, carrying an offer and an answer between two machines that are
 * already talking to each other. The relay transport carried *every order of every battle* over
 * that same wire until today. `MqttSignal` refuses rather than downgrading, because a public
 * broker is a different question entirely.
 */
export async function seal(key: CryptoKey | null, m: SignalMsg): Promise<string> {
  const json = JSON.stringify(m);
  if (!key) return `0${b64(utf8(json))}`;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    utf8(json)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return `1${b64(out)}`;
}

/**
 * Open an envelope, or return null.
 *
 * Null rather than throwing, and the reason is the shared broker: a topic collision, a retained
 * message from an older build, or somebody else's traffic will all arrive here, and none of them
 * is an error worth interrupting a handshake for. What *would* be an error is treating a failure
 * to decrypt as a failure of the room, so this is quiet on purpose and `PeerLink` counts them.
 */
export async function unseal(key: CryptoKey | null, s: string): Promise<SignalMsg | null> {
  try {
    const kind = s[0];
    const body = s.slice(1);
    // A plaintext envelope is readable whether or not *this* peer can seal, which is what makes
    // an https page and a LAN http page able to introduce each other.
    if (kind === '0') return shaped(JSON.parse(dec.decode(unb64(body))) as SignalMsg);
    if (kind !== '1' || !key) return null;
    const raw = unb64(body);
    if (raw.length < 29) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return shaped(JSON.parse(dec.decode(pt)) as SignalMsg);
  } catch {
    return null;
  }
}

const shaped = (m: SignalMsg): SignalMsg | null =>
  (typeof m?.t === 'string' && typeof m?.from === 'number' ? m : null);

// ---------------------------------------------------------------------------
// MQTT 3.1.1, the part of it two browsers need
// ---------------------------------------------------------------------------

/**
 * The three public brokers, all verified reachable over `wss` on 2 Sep 2026.
 *
 * Three operators rather than one, because the question the owner has to be able to ask is
 * "what happens when the third party disappears" and the answer should be "nothing, twice
 * over". All three are documented as public shared test brokers with no account and no
 * published rate limit; HiveMQ's is known to refuse connections with `RATE_EXCEEDED` under
 * load, at an undisclosed threshold, which is precisely the reason not to depend on one.
 */
export const PUBLIC_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

/** Varint length, as MQTT spells it: seven bits a byte, top bit continues. */
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
};

const str = (s: string): number[] => {
  const b = utf8(s);
  return [b.length >> 8, b.length & 0xff, ...b];
};

const packet = (type: number, flags: number, body: number[]): Bytes =>
  new Uint8Array([(type << 4) | flags, ...varint(body.length), ...body]);

/**
 * A minimal MQTT 3.1.1 client, vendored.
 *
 * Four packets out — CONNECT, SUBSCRIBE, PUBLISH at QoS 0, PINGREQ — and two in that matter,
 * CONNACK and PUBLISH. That is the whole of what a signalling rendezvous needs, and it is about
 * 90 lines. The alternative was `mqtt` from npm, which bundlephobia puts at 120 kB gzipped
 * inside Trystero's MQTT strategy; this project vendors rather than depends where it reasonably
 * can, and a fifth of a second of a player's bandwidth for a two-message handshake is not a
 * reasonable place to depend.
 *
 * QoS 0 throughout, deliberately. QoS 1 would add packet ids, PUBACK and a retransmit timer to
 * buy at-least-once delivery of a message that is **already** retried at a higher level: the
 * challenger re-knocks until it is answered, and ICE candidates are idempotent. Reliability
 * belongs to whichever layer can tell whether the thing actually happened, and that is
 * `PeerLink`.
 */
class MqttSocket {
  readonly url: string;
  private ws: WebSocket | null = null;
  private topic: string;
  private beat = 0;
  private onPub: (payload: string) => void;
  private onGone: () => void;
  connected = false;

  constructor(url: string, topic: string, onPub: (p: string) => void, onGone: () => void) {
    this.url = url;
    this.topic = topic;
    this.onPub = onPub;
    this.onGone = onGone;
  }

  open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail(`${this.url} did not answer in ${timeoutMs} ms`), timeoutMs);
      let ws: WebSocket;
      try {
        // The `mqtt` subprotocol is not optional: all three brokers reject the upgrade without
        // it, which presents as an immediate close with no error text anywhere.
        ws = new WebSocket(this.url, 'mqtt');
      } catch (e) {
        clearTimeout(timer);
        fail(`${this.url}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        // A random client id, because a broker disconnects the older of two clients that claim
        // one. Nothing about this identity persists or means anything.
        const id = `tc${Math.random().toString(36).slice(2, 12)}`;
        ws.send(packet(1, 0, [
          ...str('MQTT'), 0x04, /* clean session */ 0x02, /* keepalive 60 s */ 0x00, 0x3c,
          ...str(id),
        ]));
      };
      ws.onmessage = (ev) => {
        const data = ev.data as ArrayBuffer | string;
        const buf: Bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
        this.take(buf, () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          resolve();
        });
      };
      ws.onerror = () => { clearTimeout(timer); fail(`${this.url} refused the connection`); };
      ws.onclose = () => {
        clearTimeout(timer);
        const was = this.connected;
        this.connected = false;
        if (this.beat) { clearInterval(this.beat); this.beat = 0; }
        fail(`${this.url} closed the connection`);
        if (was) this.onGone();
      };
    });
  }

  /** One inbound frame, which may carry several packets. */
  private take(buf: Bytes, onConnack: () => void): void {
    let i = 0;
    while (i < buf.length) {
      const type = buf[i] >> 4;
      let mult = 1;
      let len = 0;
      let j = i + 1;
      let b = 0;
      do {
        if (j >= buf.length) return;
        b = buf[j++];
        len += (b & 0x7f) * mult;
        mult *= 128;
      } while (b & 0x80);
      const body = buf.subarray(j, j + len);
      i = j + len;
      if (type === 2) {
        // CONNACK. Byte 1 is the return code; anything but 0 is a refusal.
        if (body.length >= 2 && body[1] !== 0) { this.ws?.close(); return; }
        this.ws?.send(packet(8, 0x02, [0x00, 0x01, ...str(this.topic), 0x00]));
        this.beat = setInterval(() => {
          if (this.ws?.readyState === 1) this.ws.send(packet(12, 0, []));
        }, 30000) as unknown as number;
        onConnack();
        continue;
      }
      if (type !== 3) continue;
      // PUBLISH at QoS 0: a topic, then the payload. No packet id.
      if (body.length < 2) continue;
      const tlen = (body[0] << 8) | body[1];
      this.onPub(dec.decode(body.subarray(2 + tlen)));
    }
  }

  publish(payload: string): void {
    if (this.ws?.readyState !== 1 || !this.connected) return;
    this.ws.send(packet(3, 0, [...str(this.topic), ...enc.encode(payload)]));
  }

  close(): void {
    if (this.beat) { clearInterval(this.beat); this.beat = 0; }
    if (this.ws?.readyState === 1) {
      try { this.ws.send(packet(14, 0, [])); } catch { /* going away regardless */ }
    }
    this.connected = false;
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Several brokers, one channel.
 *
 * `open` resolves as soon as **one** broker has accepted and subscribed, and lets the others
 * keep trying in the background — a broker that takes four seconds to answer must not make the
 * player wait four seconds, and a broker that never answers must not make them wait at all.
 * `onDead` fires only when the last one has gone.
 */
export class MqttSignal implements SignalChannel {
  onMessage: (m: SignalMsg) => void = () => {};
  onDead: (why: string) => void = () => {};

  private code: string;
  private slot: number;
  private urls: string[];
  private socks: MqttSocket[] = [];
  private key: CryptoKey | null = null;
  private topic = '';
  private sealable: () => boolean;
  private seen = new Set<string>();
  private dead = false;
  /** Envelopes that arrived and would not open. Counted, never reported as a room failure. */
  foreign = 0;

  /**
   * `sealable` is the *capability*, injected rather than read, and it is not a test knob.
   *
   * "May this page encrypt?" is a fact about the origin, and a class that reads it out of a
   * global is a class whose refusal branch cannot be reached from anywhere but that origin — so
   * the one sentence this design owes a player who would otherwise get a plaintext offer on a
   * public broker would ship untested. The default is the real answer; a caller may state it.
   */
  constructor(
    code: string, slot: number, urls: string[] = PUBLIC_BROKERS,
    sealable: () => boolean = canSeal
  ) {
    this.code = code;
    this.slot = slot;
    this.urls = urls;
    this.sealable = sealable;
  }

  get name(): string {
    const up = this.socks.filter((s) => s.connected).length;
    return `${up} of ${this.urls.length} introduction service(s)`;
  }

  get live(): number { return this.socks.filter((s) => s.connected).length; }

  async open(timeoutMs = 8000): Promise<void> {
    /*
     * **Refused rather than downgraded.** A public broker is a public square, and publishing an
     * unsealed offer to one would put the addresses in your ICE candidates on somebody else's
     * shared test broker in the clear. `canSeal()` is false on exactly one origin shape — a
     * private plain-http address — and that origin has a better answer sitting in front of it:
     * the relay its own server started, which is what `chooseTransport` picks by default there.
     * So this is a sentence and not a fallback.
     */
    if (!this.sealable()) {
      throw new Error('this page cannot encrypt an introduction, so it will not send one '
        + 'through a public service. Browsers only allow encryption on a secure page, and this '
        + `one is at ${typeof location === 'undefined' ? 'an insecure address' : location.origin}`
        + '. Open the game over https, or over the address `npm run host` prints, which '
        + 'introduces the two of you on your own network instead.');
    }
    this.key = await keyFor(this.code);
    this.topic = await topicFor(this.code);
    const onPub = (payload: string): void => { void this.take(payload); };
    const onGone = (): void => {
      if (this.dead || this.live > 0) return;
      this.dead = true;
      this.onDead('every introduction service closed the connection');
    };
    this.socks = this.urls.map((u) => new MqttSocket(u, this.topic, onPub, onGone));
    const tries = this.socks.map((s) => s.open(timeoutMs));
    /*
     * `Promise.any`, not `all` and not `race`.
     *
     * `all` makes the slowest broker the handshake's latency and any single outage fatal.
     * `race` would settle on the first *rejection* as readily as the first success. `any`
     * resolves on the first success and only rejects when every one of them has failed, which
     * is exactly the availability claim this design is making.
     */
    try {
      await Promise.any(tries);
    } catch {
      const why = `none of the ${this.urls.length} introduction services answered `
        + `(${this.urls.map((u) => new URL(u).host).join(', ')})`;
      throw new Error(why);
    }
    // Late arrivals are welcome and their failures are not interesting.
    for (const t of tries) t.catch(() => {});
  }

  private async take(payload: string): Promise<void> {
    if (!this.key) return;
    if (this.seen.has(payload)) return;
    this.seen.add(payload);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value as string);
    const m = await unseal(this.key, payload);
    if (!m) { this.foreign++; return; }
    if (m.from === this.slot) return;
    this.onMessage(m);
  }

  /**
   * Guarded on having a *topic*, not on having a key. See `WsSignal.send` for what the second
   * one cost.
   *
   * It cannot bite here — `open` refuses outright on an origin that cannot seal, so a live
   * `MqttSignal` always has a key — and it is changed anyway, because the two channels reading
   * differently about the same thing is how the next person concludes the key is a readiness flag.
   */
  send(m: SignalMsg): void {
    if (!this.topic) return;
    void seal(this.key, m).then((payload) => {
      for (const s of this.socks) s.publish(payload);
    });
  }

  close(): void {
    for (const s of this.socks) s.close();
    this.socks = [];
  }
}

// ---------------------------------------------------------------------------
// The relay as a signaller
// ---------------------------------------------------------------------------

/**
 * `ws://host:port/signal/CODE` on `tools/relay.mjs`. A dumb broadcast, and that is all it is.
 *
 * Worth being precise about what this is *not*: it is not the relay. It carries an offer, an
 * answer and some candidates, and then the peers talk directly and it is closed. Nothing about a
 * match depends on it after the data channel opens — which is the property that makes the LAN
 * case and the internet case one code path rather than two.
 *
 * The payload is sealed exactly as the broker's is. There is no privacy argument for that on a
 * home network; the argument is that a gate which exercises an unencrypted path is not
 * exercising the path players use, and this repository has shipped that mistake before.
 */
export class WsSignal implements SignalChannel {
  onMessage: (m: SignalMsg) => void = () => {};
  onDead: (why: string) => void = () => {};

  readonly url: string;
  private code: string;
  private slot: number;
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  private up = false;
  foreign = 0;

  constructor(base: string, code: string, slot: number) {
    this.code = code;
    this.slot = slot;
    this.url = `${base.replace(/\/+$/, '')}/signal/${code}`;
  }

  get name(): string { return `the introduction service at ${this.url}`; }
  get live(): number { return this.up ? 1 : 0; }

  async open(timeoutMs = 8000): Promise<void> {
    this.key = await keyFor(this.code);
    /*
     * Said once, in the console, because a downgrade nobody is told about is the shape of
     * problem this whole project keeps writing down. Not on the screen: the player has no
     * decision to make — this is their own machine introducing them on their own network, and
     * `describe()` in the lobby deliberately says nothing at all about that case.
     */
    if (!this.key) {
      const where = typeof location === 'undefined' ? 'this page' : location.origin;
      console.warn(`[net] ${where} is not a secure page, so the browser gives it no `
        + 'encryption. The introduction through ' + this.url + ' will be sent as plain text. '
        + 'It stays on this network, and it carries an offer and an answer rather than any part '
        + 'of the battle.');
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`nothing answered at ${this.url} in ${timeoutMs} ms`));
      }, timeoutMs);
      let ws: WebSocket;
      try { ws = new WebSocket(this.url); } catch (e) {
        clearTimeout(timer);
        reject(new Error(`could not open ${this.url}: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.up = true;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(`nothing answered at ${this.url}`));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        const was = this.up;
        this.up = false;
        if (!settled) { settled = true; reject(new Error(`${this.url} closed the connection`)); }
        else if (was) this.onDead(`${this.url} closed the connection`);
      };
      ws.onmessage = (ev) => {
        if (!this.key) return;
        void unseal(this.key, String(ev.data)).then((m) => {
          if (!m) { this.foreign++; return; }
          if (m.from === this.slot) return;
          this.onMessage(m);
        });
      };
    });
  }

  /**
   * **`this.key` is not a readiness flag, and treating it as one silently unplugged the LAN
   * path.**
   *
   * This read `if (!this.key || this.ws?.readyState !== 1) return;`, which is correct on every
   * origin that can seal and drops **every message** on the one that cannot — because a null key
   * *is* the plaintext case. The symptom was as far from the cause as it could be: the host
   * published its standing offer every three seconds into nothing, the challenger knocked for its
   * whole budget, and the screen said *"nobody answered in room 95J57"* about a host that was
   * sitting on the same channel with an offer ready. `qa-net`'s `lan` arm is what found it, and
   * `tools/scratch/icepair.mjs --host=lan` is what cleared ICE of suspicion first: 3 of 3
   * connected from the non-secure origin in 90-161 ms.
   *
   * So the readiness question is asked of the socket, which is the thing that has an answer, and
   * whether there is a key is `seal`'s business and nobody else's.
   */
  send(m: SignalMsg): void {
    if (this.ws?.readyState !== 1) return;
    void seal(this.key, m).then((p) => {
      if (this.ws?.readyState === 1) this.ws.send(p);
    });
  }

  close(): void {
    this.up = false;
    this.ws?.close();
    this.ws = null;
  }
}
