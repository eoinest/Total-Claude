import type { Link } from './link.ts';
import { PeerRoom, type PeerMsg, type PeerReply, type PeerRoomOptions } from './peerRoom.ts';
import type { ClientMsg, RelayMsg } from './protocol.ts';
import type { SignalChannel, SignalMsg } from './signal.ts';

/**
 * The wire, when there is no relay: an `RTCPeerConnection` straight to the other player.
 *
 * ## What this replaces, and what it does not
 *
 * `NetLink` is a `WebSocket` to a relay that runs `Room`. This is a data channel to the other
 * browser, with `PeerRoom` running on *both* ends. It implements the same `Link` interface, so
 * `NetSession` — the file that holds the lockstep guarantees — cannot tell the difference and
 * contains no branch on which one it is talking to.
 *
 * The relay is not deleted and should not be: it is a working, tested instrument and it is how
 * this transport gets A/B'd against known-good behaviour. See `docs/MULTIPLAYER.md` §13.7.
 *
 * ## The whole point, in one paragraph
 *
 * An `https` page may not open a `ws://` connection, and a page the browser believes came from
 * the public internet may not reach into a private network at all. Those two rules — mixed
 * content, and Chromium's Local Network Access — are the entire reason multiplayer does not work
 * on `total-claude.vercel.app`, and `docs/RELAY-OPTIONS.md` opens by saying so: *"the deployed
 * site can never talk to a LAN relay — not as a bug, as the rule."* A peer connection is subject
 * to **neither**. Measured on Chromium 151 from an https origin the browser had been told was
 * public (`tools/scratch/icecheck.mjs`, and `tools/qa-p2p.mjs`'s `https` arm keeps it measured):
 * ICE gathering completed, host candidates for the private address and server-reflexive
 * candidates for the public one, no console error, and a data channel that opened and carried a
 * battle. So two strangers can open the deployed site and play, which is the thing that was
 * asked for and has never once worked.
 *
 * ## The two hazards that are easy to get wrong and cost measurable time
 *
 * 1. **Candidates arrive before the remote description exists.** `addIceCandidate` rejects while
 *    `remoteDescription` is null. Host candidates are gathered in single-digit milliseconds, so
 *    on a fast machine *every candidate a peer produces* can land in the window between the
 *    offer going out and the answer coming back. `tools/scratch/icecheck.mjs` threw those
 *    rejections away with `void`, lost every candidate it gathered, sat in `ice: checking` for
 *    twenty seconds with no error anywhere, and reported "two pages on this machine cannot
 *    connect". They are queued here, and the queue is flushed by `setRemoteDescription` and by
 *    nothing else.
 * 2. **Signalling is not a channel you can trust the order of.** A knock may reach a host that
 *    has not subscribed yet; an offer may be lost; the same guest may knock three times. Every
 *    step here is idempotent and re-driven from the other side rather than sequenced: the
 *    challenger knocks until it is answered, a repeated knock re-sends the offer that already
 *    exists, and a candidate can be added twice with no consequence.
 *
 * ## And the honest limit
 *
 * There is no TURN, by decision. When two networks genuinely refuse a direct path this says so
 * in a sentence that names what to do, and stops. It never hangs. See `noDirectPath`.
 */

/**
 * Two independent operators, and that is the whole of the redundancy argument.
 *
 * Measured 2 Sep 2026: `stun.cloudflare.com:3478` answered in 10 ms and
 * `stun.l.google.com:19302` in 37 ms, both returning a usable `XOR-MAPPED-ADDRESS`.
 *
 * **`stun1` through `stun4.l.google.com` are deliberately absent, and that is a finding rather
 * than an omission.** All five of Google's names resolve to the same A record (74.125.250.129)
 * and the same AAAA, so listing them buys no redundancy at all — it is one anycast target under
 * five names, and if the node serving you is down they fail together. Ports 19303-19305 were
 * measured silent on every one of the four hostnames, consistently, on retry; no Google
 * announcement documents that, so it is recorded as a measurement and not as policy. Either way
 * a dead entry is not free: each one fires `icecandidateerror` 701 and costs a gathering timeout
 * per interface before ICE gives up on it.
 *
 * Neither operator publishes any terms for their STUN endpoint. Cloudflare documents the
 * hostname in its Realtime docs and states no limit; Google's has no policy page at all. So the
 * failure to plan for is one of them disappearing without notice, which is what having two is
 * for. If both are gone, ICE still gathers **host** candidates, so same-network play keeps
 * working with no server anywhere — and `diag()` reports the absence rather than guessing.
 */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/** How often the challenger asks whether anybody is hosting this code. */
const KNOCK_MS = 1000;
/**
 * How long a challenger knocks before "nobody answered in room ABCDE" is the honest answer.
 *
 * **Fifteen seconds, and it was forty-five, and the difference is a whole class of complaint.**
 * A correct code is answered on the *first* knock: the host creates its offer when the knock
 * arrives, so the reply is one round trip through the introduction service, and the measured
 * end-to-end open is 0.7-6 s including a full ICE exchange. A wrong code is never answered, ever.
 * So the only thing a longer wait buys is a longer silence for somebody who mistyped — and
 * `qa-net`'s `badcode` arm caught exactly that, reporting *"nothing said anything in 25.0 s —
 * this is the silent wait"*, which is the sentence this whole design keeps being written against.
 *
 * Fifteen rather than five because the *host* may legitimately not be there yet: two people on
 * the phone do not press their buttons in the same second. Past that, saying so and offering the
 * form again is more use than waiting, and the message names both possibilities rather than
 * accusing the typist.
 *
 * `signal.open()`'s own timeout is separate and comes first, so the worst case a player sees is
 * that plus this.
 */
const KNOCK_TIMEOUT_MS = 15000;
/**
 * How long ICE gets before "these two networks will not connect" is the honest answer.
 *
 * Measured on this machine, two browsers, real STUN: a connection that works opens in **57 to
 * 209 ms** over host candidates. Twenty seconds is two orders of magnitude of headroom, and it
 * is chosen against the *slow* case rather than the fast one — a mobile connection gathering
 * over a carrier NAT with a 4 s STUN timeout per interface can legitimately take several
 * seconds. Past that it is not slow, it is blocked, and saying so is more use than waiting.
 */
const ICE_DEADLINE_MS = 20000;
/** The idle pump. See `drive` for why there is a timer as well as a per-frame call. */
const PUMP_MS = 20;
/**
 * How long the host keeps the introduction service open after the channel is up.
 *
 * Not for the whole match. The public brokers ask not to be leaned on and holding three
 * WebSockets open for a twenty-minute battle is leaning on them for nothing — after the channel
 * opens, signalling has no job left. What it is kept for is the window in which a *second*
 * challenger might type the same code, so that they get `Room`'s "already has a challenger"
 * refusal by name instead of knocking into silence. Closed at the start of the battle in any
 * case, since by then the code has plainly been used.
 */
const SIGNAL_LINGER_MS = 120000;

export interface PeerLinkOptions {
  code: string;
  want: 'host' | 'join';
  signal: SignalChannel;
  iceServers?: RTCIceServer[];
  room?: PeerRoomOptions;
  /**
   * Test-only. Drops candidate types before they are offered, so a gate can measure what
   * happens when a class of path is unavailable.
   *
   * It is how "two strangers on two different networks" is approximated on one machine —
   * `['srflx']` forces the pair to go through the public address and back, which is the
   * hairpin a home router usually refuses, and is therefore also how the *failure* path gets
   * exercised on purpose rather than waited for.
   */
  onlyCandidates?: string[] | null;
  /**
   * Test-only. Holds every outbound wire frame for this long before sending it.
   *
   * The peer-to-peer twin of `tools/relay.mjs --lag=`, and it is honest in the same way: the
   * frame really is delayed, on the real data channel, so the whole path — commit, `dc.send`,
   * SCTP, `dc.onmessage`, `PeerRoom.fromPeer` — is exercised at latency rather than simulated at
   * it. What it cannot reproduce is packet loss or reordering, and it must not pretend to: a
   * reliable ordered channel does not reorder, and `tools/qa-p2p.mjs`'s `proto` arm covers the
   * refusal for a stream that somehow did.
   *
   * Ordered, deliberately. `setTimeout` with a constant delay preserves order for frames queued
   * from the same task, and the queue below preserves it across tasks — a "latency" model that
   * let a later frame overtake an earlier one would be testing a channel this product does not
   * use, which is a mistake `tools/scratch/peerdrive.mjs` made and had to be corrected for.
   *
   * Reachable only from `?p2plag=`, which nothing in the product writes.
   */
  sendDelayMs?: number;
  /** Test-only. Corrupts what this peer commits, so a gate can prove the detector works. */
  fault?: import('./peerRoom.ts').PeerFault | null;
}

export class PeerLink implements Link {
  readonly room: string;
  readonly want: 'host' | 'join';
  slot: number;
  refusal = '';
  refusedByRelay = '';
  peer: 'absent' | 'joined' | 'ready' | 'left' = 'absent';
  closed = false;
  dropped = '';
  lastMessageAt = 0;
  gapMs = 0;

  private peerRoom: PeerRoom;
  private signal: SignalChannel;
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private queue: RelayMsg[] = [];
  private waiters: { kinds: string[]; ok: (m: RelayMsg) => void; fail: (e: Error) => void }[] = [];
  private sent = 0;
  private got = 0;

  /** Candidates that arrived before there was a remote description to attach them to. */
  private iceQueue: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  /** The offer, kept so a repeated knock is answered rather than re-negotiated. */
  private offer: RTCSessionDescriptionInit | null = null;
  private claimed = false;
  private knockTimer = 0;
  private pumpTimer = 0;
  private lingerTimer = 0;
  private deadline = 0;
  private lastSimTick = 0;
  private openedAt = -1;
  private startedAt = 0;
  private onlyCandidates: string[] | null;

  /** Everything a report needs and nothing the simulation may read. See `diag`. */
  /**
   * Frames produced before the channel existed. Delivered in order the moment it does.
   *
   * The bug this exists for is the one hazard a relay cannot have, and it took a gate arm to
   * find. A host's `connect()` resolves as soon as its code is registered — it has a battle to
   * choose and cannot sit on a loading screen until somebody types five characters — so the host
   * publishes `setup` when its menu closes and `ready` when its army is on the field, both of
   * which can be **minutes** before a challenger arrives. Handed straight to `dc.send` those
   * frames go nowhere: there is no data channel yet. Measured in `qa-p2p`'s `lobby` arm as two
   * clients connected, both `ready`, and neither ever leaving `phase: lobby`.
   *
   * Queued rather than regenerated, because regenerating is a list somebody has to keep correct.
   * The first attempt at this republished `setup` from `PeerRoom.open` and left `ready` — which
   * is the same problem one message along — on the floor.
   *
   * Only *before* the channel has ever opened. A frame pushed after it closes is a frame for a
   * peer who has gone, and holding those would be a reconnection this design does not have.
   */
  private preOpen: PeerMsg[] = [];
  private sendDelayMs: number;
  /** Outbound frames waiting on `sendDelayMs`. Kept in order; see the option's docstring. */
  private outQueue: Promise<void> = Promise.resolve();
  private gathered: string[] = [];
  private iceErrors: string[] = [];
  private states: string[] = [];
  private signalName = '';

  constructor(o: PeerLinkOptions) {
    this.room = o.code;
    this.want = o.want;
    this.slot = o.want === 'host' ? 0 : 1;
    this.onlyCandidates = o.onlyCandidates ?? null;
    this.signal = o.signal;
    this.sendDelayMs = Math.max(0, o.sendDelayMs ?? 0);
    this.peerRoom = new PeerRoom(o.code, this.slot, {
      ...(o.room ?? {}),
      ...(o.fault ? { fault: o.fault } : {}),
    });
    this.pc = new RTCPeerConnection({ iceServers: o.iceServers ?? STUN_SERVERS });
    this.wirePeerConnection();
  }

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  /**
   * Open, and resolve with the slot. **The two roles resolve at different moments, on purpose.**
   *
   * The host resolves as soon as its code is registered with the introduction service, because
   * it has a battle to choose: `main.ts` awaits this before it shows the menu, and a host who
   * could not reach the setup screen until a challenger arrived would be staring at a loading
   * splash for as long as it takes somebody to type five characters. That is the same moment
   * `NetLink` resolves — the relay's `welcome` means "you have your slot in this room", and
   * "the code is registered and I am listening" is the same fact.
   *
   * The challenger waits for the connection itself, and that asymmetry buys the one error
   * message that matters most. A guest has nothing to do until the host is there — it skips the
   * menu entirely and waits for the host's battle — so blocking costs nothing, and it is the
   * only place a mistyped code can be *named*. Under a relay the refusal is
   * `Room.noSuchRoom`; there is no registry to ask here, so a wrong code is indistinguishable
   * from a host who has not opened their page yet, and both are "nobody answered in room ABCDE"
   * with the code in the sentence.
   */
  async connect(timeoutMs = KNOCK_TIMEOUT_MS): Promise<number> {
    this.startedAt = now();
    try {
      await this.signal.open(Math.min(timeoutMs, 10000));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.refusal = why;
      throw new Error(why);
    }
    this.signalName = this.signal.name;
    this.signal.onMessage = (m) => { void this.onSignal(m); };
    this.signal.onDead = (why) => {
      // Only fatal before the channel is up. After that this is a bystander going home.
      if (this.openedAt < 0 && !this.dropped) this.dropped = why;
    };
    this.pumpTimer = setInterval(() => this.drive(), PUMP_MS) as unknown as number;

    if (this.want === 'host') {
      this.deadline = 0;
      return this.slot;
    }

    // The challenger: knock until answered, then wait for the channel.
    this.knock();
    this.knockTimer = setInterval(() => this.knock(), KNOCK_MS) as unknown as number;
    await new Promise<void>((resolve, reject) => {
      const started = now();
      const poll = setInterval(() => {
        if (this.openedAt >= 0) { clearInterval(poll); resolve(); return; }
        if (this.refusal) {
          clearInterval(poll);
          reject(new Error(this.refusal));
          return;
        }
        if (this.dropped) { clearInterval(poll); reject(new Error(this.dropped)); return; }
        if (now() - started < timeoutMs) return;
        clearInterval(poll);
        this.refusal = `Nobody answered in room ${this.room}.`
          + ` Either that code is not the one on the other screen, or whoever opened it has not `
          + 'got their page up yet. Check the five characters and try again — nothing has been '
          + 'joined, so the room is still there if it exists.';
        this.refusedByRelay = this.refusal;
        reject(new Error(this.refusal));
      }, 100);
    });
    return this.slot;
  }

  private knock(): void {
    if (this.openedAt >= 0 || this.closed) {
      if (this.knockTimer) { clearInterval(this.knockTimer); this.knockTimer = 0; }
      return;
    }
    this.signal.send({ t: 'knock', from: this.slot });
  }

  // -------------------------------------------------------------------------
  // The peer connection
  // -------------------------------------------------------------------------

  private wirePeerConnection(): void {
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const kind = typeOf(e.candidate.candidate);
      this.gathered.push(`${kind}:${e.candidate.candidate.split(' ')[4] ?? '?'}`);
      if (this.onlyCandidates && !this.onlyCandidates.includes(kind)) return;
      this.signal.send({ t: 'ice', from: this.slot, c: e.candidate.toJSON() });
    };
    this.pc.onicecandidateerror = (e) => {
      /*
       * Recorded, never fatal, and never shown to a player on its own.
       *
       * A 701 means one STUN server did not answer. With two independent operators listed that
       * is a fact about one of them and not about this match — MDN is explicit that *"each
       * provided server is tried until a connection is established"* — and ICE also gathers
       * host candidates, which are what a same-network match connects over anyway. Reporting it
       * would put a red line on a session that is about to work perfectly.
       */
      const ev = e as RTCPeerConnectionIceErrorEvent;
      this.iceErrors.push(`${ev.errorCode} ${ev.url ?? ''} ${ev.errorText ?? ''}`.trim());
    };
    this.pc.onconnectionstatechange = () => {
      this.states.push(`conn:${this.pc.connectionState}`);
      if (this.pc.connectionState !== 'failed') return;
      this.fail(this.noDirectPath());
    };
    this.pc.oniceconnectionstatechange = () => {
      this.states.push(`ice:${this.pc.iceConnectionState}`);
    };
    if (this.want === 'host') {
      // `ordered: true` is the default and is stated anyway, because `PeerRoom` depends on it:
      // `hello` must be the first frame the other side sees, and a commit for an already-played
      // turn is a refusal rather than something to reorder around.
      this.attach(this.pc.createDataChannel('tc', { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => this.attach(e.channel);
    }
  }

  private attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => {
      this.openedAt = now();
      this.peer = 'joined';
      this.deadline = 0;
      if (this.knockTimer) { clearInterval(this.knockTimer); this.knockTimer = 0; }
      this.take(this.peerRoom.open(now()));
      // Everything the session said while there was nobody to say it to, in the order it said
      // it — and after the `hello` above, which the peer requires first.
      const held = this.preOpen.splice(0);
      for (const m of held) this.push(m);
      if (held.length) console.log(`[net] delivered ${held.length} frame(s) held before the peer arrived`);
      // Signalling has no job left except refusing a second challenger. See `SIGNAL_LINGER_MS`.
      this.lingerTimer = setTimeout(() => this.dropSignal(), SIGNAL_LINGER_MS) as unknown as number;
    };
    dc.onmessage = (ev) => {
      const at = now();
      this.got++;
      if (this.lastMessageAt) {
        const gap = at - this.lastMessageAt;
        this.gapMs = this.gapMs ? this.gapMs * 0.8 + gap * 0.2 : gap;
      }
      this.lastMessageAt = at;
      let m: PeerMsg;
      try { m = JSON.parse(String(ev.data)) as PeerMsg; } catch { return; }
      this.take(this.peerRoom.fromPeer(at, m));
    };
    dc.onclose = () => {
      if (this.closed) return;
      this.take(this.peerRoom.peerGone('the other commander\'s connection closed'));
      if (!this.dropped) this.dropped = 'the direct connection to the other player closed';
    };
    dc.onerror = () => {
      if (!this.dropped) this.dropped = 'the direct connection to the other player failed';
    };
  }

  // -------------------------------------------------------------------------
  // Signalling
  // -------------------------------------------------------------------------

  private async onSignal(m: SignalMsg): Promise<void> {
    if (this.closed) return;
    try {
      switch (m.t) {
        case 'knock': {
          if (this.want !== 'host') return;
          /*
           * A second challenger gets the refusal `Room` gives them, by name.
           *
           * Without it a mistyped code that happens to match a *busy* room is the worst failure
           * in the product all over again — `Room.noSuchRoom`'s docstring is about exactly this
           * shape: waiting on a host who is not coming, with nothing anywhere saying so.
           */
          if (this.claimed) { this.signal.send({ t: 'full', from: this.slot }); return; }
          if (!this.offer) {
            this.offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(this.offer);
            this.deadline = now() + ICE_DEADLINE_MS;
          }
          // Re-sent on every knock, not just the first. An offer that was lost on a shared
          // broker is otherwise a room that hangs, and re-sending one is free.
          this.signal.send({ t: 'offer', from: this.slot, sdp: this.pc.localDescription?.sdp ?? '' });
          return;
        }
        case 'offer': {
          if (this.want === 'host' || this.haveRemote) return;
          this.claimed = true;
          await this.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
          this.flushIce();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.deadline = now() + ICE_DEADLINE_MS;
          this.signal.send({ t: 'answer', from: this.slot, sdp: this.pc.localDescription?.sdp ?? '' });
          return;
        }
        case 'answer': {
          if (this.want !== 'host' || this.haveRemote) return;
          this.claimed = true;
          await this.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
          this.flushIce();
          return;
        }
        case 'ice': {
          // Queued rather than added when there is no remote description yet. See hazard 1 in
          // the file docstring; this is the line whose absence cost half a day of measurement.
          if (!this.haveRemote) { this.iceQueue.push(m.c); return; }
          await this.pc.addIceCandidate(m.c).catch(() => { /* duplicate or stale: harmless */ });
          return;
        }
        case 'full': {
          if (this.want === 'host' || this.openedAt >= 0) return;
          this.refusedByRelay = `room ${this.room} already has a challenger`;
          this.refusal = `${this.refusedByRelay}. Somebody else is already in that room — `
            + 'ask for a new code, or open one of your own.';
          if (this.knockTimer) { clearInterval(this.knockTimer); this.knockTimer = 0; }
          return;
        }
        default: return;
      }
    } catch (e) {
      /*
       * A negotiation that threw is fatal and says so. It is *not* swallowed.
       *
       * `setRemoteDescription` rejects on an SDP it cannot parse, which on a shared broker means
       * a topic collision or a different build of this file — and the symptom of ignoring it is a
       * room that never opens with nothing in the console. See `unseal`, which is quiet about
       * envelopes it cannot open precisely so that the ones it *can* open are trusted here.
       */
      this.fail(`the introduction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private flushIce(): void {
    this.haveRemote = true;
    for (const c of this.iceQueue.splice(0)) {
      void this.pc.addIceCandidate(c).catch(() => { /* duplicate or stale: harmless */ });
    }
  }

  private dropSignal(): void {
    if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = 0; }
    this.signal.onMessage = () => {};
    this.signal.onDead = () => {};
    this.signal.close();
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  /**
   * Called once a frame by `NetSession`, with the tick the simulation has reached.
   *
   * The tick is the pacer and `PeerRoom.pump` explains why at length: a commit is *earned* by
   * consuming a turn, which is what ties the commit rate to the tick rate and stops the two
   * peers running the battle as fast as the network can carry it.
   */
  pump(simTick: number): void {
    this.lastSimTick = simTick;
    this.drive();
  }

  /**
   * One turn of the state machine's clock. Idempotent, and driven from two places.
   *
   * `pump` is the one that matters during a battle, because it arrives with a fresh tick. The
   * `PUMP_MS` interval is for every other moment: the lobby, where there is no engine and
   * therefore no frame loop to hang a pump on, and a battle stalled at its ceiling, where
   * `requestAnimationFrame` is running but nothing is being consumed and the only thing due is a
   * beat. A backgrounded tab throttles this interval to about once a second rather than stopping
   * it, which is the honest behaviour: the peer's silence test then measures a page that is
   * barely running rather than one that is gone.
   */
  private drive(): void {
    if (this.closed) return;
    const t = now();
    this.take(this.peerRoom.pump(t, this.lastSimTick));
    if (this.deadline && t > this.deadline && this.openedAt < 0) {
      this.deadline = 0;
      this.fail(this.noDirectPath());
    }
    if (this.lingerTimer && this.peerRoom.phase === 'battle') this.dropSignal();
  }

  // -------------------------------------------------------------------------
  // The `Link` surface
  // -------------------------------------------------------------------------

  send(m: ClientMsg): void {
    this.sent++;
    this.take(this.peerRoom.fromClient(now(), m));
  }

  drain(): RelayMsg[] {
    if (!this.queue.length) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

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

  /** Our own hang-up. Marked, so the `onclose` it provokes is not reported as a link failure. */
  close(why = 'closed'): void {
    if (this.closed) return;
    this.dropped = this.dropped || `closed by this client: ${why}`;
    this.closed = true;
    this.take(this.peerRoom.fromClient(now(), { k: 'bye', why }));
    for (const id of [this.knockTimer, this.pumpTimer]) if (id) clearInterval(id);
    this.knockTimer = 0;
    this.pumpTimer = 0;
    this.dropSignal();
    try { this.dc?.close(); } catch { /* going away regardless */ }
    try { this.pc.close(); } catch { /* going away regardless */ }
  }

  get counts(): { sent: number; got: number } { return { sent: this.sent, got: this.got }; }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Local messages to the session's queue; wire messages down the channel. */
  private take(r: PeerReply): void {
    for (const m of r.wire) this.push(m);
    for (const m of r.local) {
      if (m.k === 'welcome') { this.slot = m.slot; continue; }
      if (m.k === 'peer') this.peer = m.state;
      if (m.k === 'refuse') {
        this.refusal = `${m.why}: ${m.detail ?? ''}`.trim();
        this.refusedByRelay = (m.detail ?? m.why).trim();
      }
      this.queue.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].kinds.includes(m.k)) this.waiters.splice(i, 1)[0].ok(m);
      }
    }
  }

  /**
   * One frame down the channel, in order, honouring the test-only delay.
   *
   * The zero-delay path is a straight `send` with no promise in it, because that is every real
   * session and a microtask per turn packet is a cost nobody asked for. The delayed path chains
   * on a single promise so the order a peer sees is the order `PeerRoom` produced — see
   * `sendDelayMs`.
   */
  private push(m: PeerMsg): void {
    if (this.dc?.readyState !== 'open' && this.openedAt < 0) { this.preOpen.push(m); return; }
    if (!this.sendDelayMs) {
      if (this.dc?.readyState !== 'open') return;
      try { this.dc.send(JSON.stringify(m)); } catch { /* the channel will report itself */ }
      return;
    }
    const text = JSON.stringify(m);
    this.outQueue = this.outQueue.then(async () => {
      await new Promise<void>((r) => setTimeout(r, this.sendDelayMs));
      if (this.dc?.readyState !== 'open' || this.closed) return;
      try { this.dc.send(text); } catch { /* the channel will report itself */ }
    });
  }

  private fail(why: string): void {
    if (this.dropped) return;
    this.dropped = why;
    if (this.openedAt < 0) this.refusal = this.refusal || why;
  }

  /**
   * The sentence for the one failure this design chose to accept.
   *
   * The owner picked peer-to-peer with no relay fallback, so a pair of networks that refuse a
   * direct path is a match that cannot be played. The whole of the obligation that creates is
   * discharged here: **say so, say why, and name what to try.** Never hang, and never blame the
   * game.
   *
   * The reported cause is a real distinction rather than a hedge. If this machine never got a
   * server-reflexive candidate, nothing here ever learned its own public address, which almost
   * always means UDP is being blocked outright on *this* side — a corporate or campus firewall,
   * or a VPN. If it did, then both ends found their public addresses and the block is on the path
   * between them, which is the symmetric-NAT case. The first is fixable by the person reading
   * the message; the second usually is not, and saying which is which is the difference between
   * an instruction and an apology.
   *
   * Expected frequency, honestly: the best-sourced public figure is callstats.io's, over
   * billions of minutes, **22% of sessions needed a relay of some kind and about 9% needed TCP**
   * (webrtcHacks, 8 Apr 2016); appear.in's production data put 17.7% on a relay in Aug 2017.
   * Both mix enterprise and mobile users in. Two players on ordinary home broadband should do
   * much better than that and two on one wifi always work, because they connect over host
   * candidates without asking anybody. The 9% is the part that no amount of cleverness recovers:
   * where UDP is blocked, this fails 100% of the time and there is no partial degradation.
   * `docs/MULTIPLAYER.md` §13.6 carries the full numbers with their sources.
   */
  private noDirectPath(): string {
    const kinds = new Set(this.gathered.map((g) => g.split(':')[0]));
    const sawPublic = kinds.has('srflx');
    return 'Your two networks would not let the game connect directly. '
      + `You were both in room ${this.room} and the introduction worked — this is the step `
      + 'after that, where the two computers try to open a path to each other. '
      + (sawPublic
        ? 'Both machines found their own public address, so what refused is the path between '
          + 'them. That is usually a network that only allows connections it started, and there '
          + 'is nothing this page can do about it from here.'
        : 'This machine never got an answer from either address-discovery server, which almost '
          + 'always means something on this network is blocking the kind of traffic a direct '
          + 'connection needs — an office or campus firewall, or a VPN.')
      + ' Every order in this game goes straight from one machine to the other, with nothing in '
      + 'between, so there is no relay to fall back on and the match stops here rather than '
      + 'pretending. What works: both of you on ordinary home internet, or both of you on the '
      + 'same wifi — which connects without asking anybody. If either of you is on a work or '
      + 'university network, or a VPN, that is the likeliest cause.';
  }

  /**
   * Everything a report or a gate needs about the connection, and nothing the simulation reads.
   *
   * `selected` is the pair ICE actually chose, which is the only way to know *what kind of
   * connection this is*: `host` means the two machines are on one network and never needed a
   * server; `srflx` means the traffic is crossing the internet directly. A measurement taken on
   * one machine will always say `host`, and a claim about two strangers made from it would be an
   * inference — so the field exists to stop that claim being made by accident.
   */
  async diag(): Promise<Record<string, unknown>> {
    /*
     * `RTCIceCandidateStats` is not in this TypeScript's DOM library, so the two fields actually
     * read are declared here. Narrow on purpose: a wider shape would be a guess about a spec
     * this file does not otherwise depend on.
     */
    interface CandStat { id: string; candidateType?: string; address?: string }
    let pair: RTCIceCandidatePairStats | null = null;
    let local: CandStat | null = null;
    let remote: CandStat | null = null;
    try {
      const stats = await this.pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'candidate-pair') {
          const p = s as RTCIceCandidatePairStats;
          if (p.state === 'succeeded' && p.nominated) pair = p;
        }
      });
      if (pair) {
        stats.forEach((s) => {
          if (s.id === (pair as RTCIceCandidatePairStats).localCandidateId) {
            local = s as CandStat;
          }
          if (s.id === (pair as RTCIceCandidatePairStats).remoteCandidateId) {
            remote = s as CandStat;
          }
        });
      }
    } catch { /* a closed connection has no stats; the rest of the report still stands */ }
    const p = pair as RTCIceCandidatePairStats | null;
    const l = local as CandStat | null;
    const r = remote as CandStat | null;
    return {
      slot: this.slot,
      want: this.want,
      signal: this.signalName,
      signalLive: this.signal.live,
      openedMs: this.openedAt >= 0 ? Math.round(this.openedAt - this.startedAt) : -1,
      connection: this.pc.connectionState,
      ice: this.pc.iceConnectionState,
      channel: this.dc?.readyState ?? 'none',
      candidateTypes: [...new Set(this.gathered.map((g) => g.split(':')[0]))],
      gathered: this.gathered.length,
      iceErrors: this.iceErrors,
      states: this.states,
      selected: p && l && r
        ? { local: l.candidateType, remote: r.candidateType, address: r.address ?? '' }
        : null,
      rttMs: p?.currentRoundTripTime != null ? Math.round(p.currentRoundTripTime * 1e4) / 10 : null,
      dropped: this.dropped,
      refusal: this.refusal,
      counts: this.counts,
      peerRoom: this.peerRoom.status(),
    };
  }

  /** The state machine, for a gate that wants to assert on turns and commits directly. */
  get machine(): PeerRoom { return this.peerRoom; }
}

const now = (): number => performance.now();

const typeOf = (candidate: string): string => {
  const m = candidate.match(/ typ (\w+)/);
  return m ? m[1] : 'unknown';
};
