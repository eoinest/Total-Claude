#!/usr/bin/env node
/**
 * Throwaway: apply one named fault, run one `qa-p2p` arm, print the verdict, put it back.
 *
 * `node tools/scratch/inject-p2p.mjs <name>` — the list is below, and `--list` prints it with
 * the check each one is supposed to turn red. `--all-fast` runs every fault whose arm needs no
 * browser, which is about forty seconds for thirty-odd checks.
 *
 * Every check on this branch has an entry, because a check nobody has seen fail is a check
 * nobody has tested — and `docs/MULTIPLAYER.md` has a list of the ones this repository shipped
 * that could not fail: a span test tangent to its own bounding box, fifty-four checks connecting
 * to loopback while testing a LAN product, and an arm whose injection only mutated the harness.
 *
 * **Two checks deliberately have no entry here, and both are bail-outs.** `https-arm-can-run`
 * and `p2p-browser-can-run` are the arms saying *"the fixture could not be built"* — no LAN
 * address, no `openssl`, no Google Chrome — and they are already the red. A fault that removed
 * the LAN address would be arranging the very condition they exist to report, which proves
 * nothing about the product. Every other check in `tools/qa-p2p.mjs` is named by a fault below.
 *
 * **Two of these deliberately mutate the harness rather than the product, and both are marked.**
 * `no-space-override` removes the flag that declares an origin public to the browser, which is
 * the control that separates "the browser refused" from "nothing was listening" — the previous
 * branch documented the same injection for the same reason. Everything else changes `src/`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const F = {
  room: 'src/net/peerRoom.ts',
  agree: 'src/net/agree.ts',
  peer: 'src/net/PeerLink.ts',
  sig: 'src/net/signal.ts',
  tr: 'src/net/transport.ts',
  lobby: 'src/ui/NetLobby.ts',
  sess: 'src/net/NetSession.ts',
  main: 'src/main.ts',
  gate: 'tools/qa-p2p.mjs',
};

/** `name: [file, from, to, arm, the check it should turn red]` */
const FAULTS = {
  // ---- proto: the state machine, no browser -------------------------------
  'guest-drops-an-op': [F.room,
    "      local.push({\n        k: 'turn', ph: 'battle', n: next, t: turnTick(next), ops: this.sorted([...a, ...b]),\n      });",
    "      const both = this.sorted([...a, ...b]);\n      local.push({\n        k: 'turn', ph: 'battle', n: next, t: turnTick(next),\n        ops: this.slot === 1 ? both.slice(1) : both,\n      });",
    'proto', 'proto-one-order-stream, every battle-*-bit-identical, every battle-*-one-order-log, and ab-both-transports-agree-internally'],
  // `guest-drops-an-op` changes the *ops* and leaves the turn list identical, so the claim that
  // both peers emit the same packets at the same execution ticks needed its own fault.
  'guest-shifts-its-ticks': [F.room,
    "        k: 'turn', ph: 'battle', n: next, t: turnTick(next), ops: this.sorted([...a, ...b]),",
    "        k: 'turn', ph: 'battle', n: next,\n        t: this.slot === 1 ? turnTick(next) + 1 : turnTick(next),\n        ops: this.sorted([...a, ...b]),",
    'proto', 'proto-one-turn-stream'],
  'unsorted-turn': [F.room,
    '    return ops.slice().sort((a, b) => (a.s - b.s) || (a.i - b.i));',
    '    return ops.slice().sort((a, b) => a.i - b.i);',
    'proto', 'proto-sorted-by-slot-seq'],
  // The plausible mistake, not a crude one: clear the queue and *then* read it, which aliases
  // the new empty array. `this.pending = [...m.ev]` was tried first and did not bite, because
  // orders eleven frames apart are committed before the next one arrives.
  'clear-then-read': [F.room,
    '    const raw = this.pending;\n    this.pending = [];',
    '    this.pending = [];\n    const raw = this.pending;',
    'proto', 'proto-nothing-dropped, proto-one-order-stream, proto-deploy-in-one-order, lag-nothing-dropped'],
  'flip-on-my-own-flag': [F.room,
    '        if (this.sides[0].ready && this.sides[1].ready) {',
    '        if (this.iAmReady) {',
    'proto', 'proto-phase-flip-agrees'],
  // The extraction's whole point: if either scheduler grows its own opinion, this goes red.
  'peer-has-its-own-handshake': [F.room,
    '    const verdict = agree(this.opts.pairs, this.sides[0].print, this.sides[1].print);',
    "    void agree;\n    const verdict = { refuse: null, pairNote: 'x', willFork: false };",
    'proto', 'proto-both-transports-agree'],
  'never-disagree': [F.agree,
    '  return fatal.find((l) => differs[l]) ?? null;',
    '  void fatal; void differs; return null;',
    'proto', 'proto-fork-detected, and every desync check'],
  'mine-and-theirs-swapped': [F.room,
    '    const ourMark = slot === this.slot ? m : theirs;\n    const theirMark = slot === this.slot ? theirs : m;',
    '    const ourMark = slot === this.slot ? theirs : m;\n    const theirMark = slot === this.slot ? m : theirs;',
    'proto', 'proto-fork-mine-is-mine'],
  'no-attribution': [F.agree,
    '  diff.sort((x, y) => x - y);\n  return diff;',
    '  diff.sort((x, y) => x - y);\n  return [];',
    'proto', 'proto-fork-attributed, desync-*-attributed'],
  'fork-without-an-end': [F.room,
    "        {\n          k: 'end', why: 'desync', atTick: this.lastAgreedTick,\n          detail: `forked at tick ${tick}; last agreed tick ${this.lastAgreedTick}`,\n        },",
    '',
    'proto', 'proto-fork-ends-both, desync-*-ends-both'],
  'faults-do-nothing': [F.room,
    "    if (!f || m.ph !== (f.phase ?? 'battle') || m.n < f.fromTurn) return clean;",
    '    return clean;',
    'proto', 'proto-fault-drop/dup/swap/ulp and the two -local rows'],
  // The distinction the browser desync arm rests on: a fault that travels forks nothing.
  'local-faults-travel': [F.room,
    '    return f.localOnly ? { mine: bent, wire: m } : { mine: bent, wire: bent };',
    '    return { mine: bent, wire: bent };',
    'proto', 'proto-fault-drop-local, proto-fault-swap-local, and both desync rows'],
  'ulp-travels': [F.room,
    "      return { mine: { ...m, ops: [...m.ops, ['__ulp__']] }, wire: m };",
    "      const u = { ...m, ops: [...m.ops, ['__ulp__']] };\n      return { mine: u, wire: u };",
    'proto', 'proto-fault-ulp'],
  'late-commit-dropped': [F.room,
    "      return this.refuse('protocol',\n        `the other side committed ${m.ph} turn ${m.n}, which has already been played `",
    "      return nothing();\n      return this.refuse('protocol',\n        `the other side committed ${m.ph} turn ${m.n}, which has already been played `",
    'proto', 'proto-late-commit-refused'],
  'two-hosts-allowed': [F.room,
    '    if (m.slot === this.slot) {',
    '    if (false && m.slot === this.slot) {',
    'proto', 'proto-two-hosts-refused'],
  'commit-without-consuming': [F.room,
    '        const consumed = Math.floor(simTick / TICKS_PER_TURN) - 1;\n        while (this.nextBattle <= consumed + this.opts.delayTurns) {',
    '        const consumed = Math.floor(simTick / TICKS_PER_TURN) - 1;\n        void consumed;\n        while (this.nextBattle <= this.turn + this.opts.delayTurns) {',
    'proto', 'proto-runs-at-real-time, battle-no-fast-forward'],
  'silent-before-the-peer': [F.room,
    "        this.setup = { cfg: m.cfg, deployPhase: m.deployPhase };\n        return { local: [], wire: [{ k: 'setup', cfg: m.cfg, deployPhase: m.deployPhase }] };",
    "        this.setup = { cfg: m.cfg, deployPhase: m.deployPhase };\n        return this.opened\n          ? { local: [], wire: [{ k: 'setup', cfg: m.cfg, deployPhase: m.deployPhase }] }\n          : nothing();",
    'proto', 'proto-speaks-before-the-peer-arrives'],

  // ---- params: what a URL means -------------------------------------------
  'sig-outranks-net': [F.tr,
    "  const base = (params.get('net') ?? '').trim();\n  if (base) return { kind: 'relay', base, room, want };\n  const sig = (params.get('sig') ?? '').trim();",
    "  const sig = (params.get('sig') ?? '').trim();\n  const base = (params.get('net') ?? '').trim();\n  if (base && !sig) return { kind: 'relay', base, room, want };",
    'params', 'params-transport-table'],
  'any-code-goes': [F.tr,
    '  if (!validCode(room)) {\n    console.error(`[net] \'${room}\' is not a room code`);\n    return null;\n  }',
    '',
    'params', 'params-bad-code-refused'],
  'lag-always-on': [F.tr,
    "  const lag = Number(params.get('p2plag') ?? '');\n  if (Number.isFinite(lag) && lag > 0) out.sendDelayMs = lag;",
    "  const lag = Number(params.get('p2plag') ?? '');\n  out.sendDelayMs = Number.isFinite(lag) && lag > 0 ? lag : 1;",
    'params', 'params-no-knobs-by-default'],
  'knobs-ignored': [F.tr,
    'export function testKnobs(params: URLSearchParams): BuildOptions {\n  const out: BuildOptions = {};',
    'export function testKnobs(params: URLSearchParams): BuildOptions {\n  const out: BuildOptions = {};\n  if (params) return out;',
    'params', 'params-knobs-when-asked'],

  // ---- seal: the introduction ---------------------------------------------
  'one-key-for-every-room': [F.sig,
    '    utf8(`total-claude/v1/${code.toUpperCase()}`), \'HKDF\', false, [\'deriveKey\']);',
    "    utf8('total-claude/v1/'), 'HKDF', false, ['deriveKey']);",
    'seal', 'seal-round-trip'],
  'plaintext-offer': [F.sig,
    '  const iv = crypto.getRandomValues(new Uint8Array(12));',
    '  return btoa(JSON.stringify(m));\n  const iv = crypto.getRandomValues(new Uint8Array(12));',
    'seal', 'seal-hides-the-sdp'],
  'topic-is-the-code': [F.sig,
    '  return `tc/${hex}`;',
    '  void hex; return `tc/${code.toUpperCase()}`;',
    'seal', 'seal-topic-is-a-hash'],
  'fixed-nonce': [F.sig,
    '  const iv = crypto.getRandomValues(new Uint8Array(12));',
    '  const iv = new Uint8Array(12);',
    'seal', 'seal-nonce-moves'],
  'broker-downgrades': [F.sig,
    '    if (!this.sealable()) {',
    '    if (false) {',
    'seal', 'seal-refuses-a-public-broker-unsealed'],
  /*
   * The two halves of the same bug, and both are now reachable from a browser-free arm.
   *
   * A null key **is** the plaintext case, so guarding on it drops every message on exactly the
   * origin that needs the plaintext path. It shipped that way outbound, was fixed, and then the
   * identical guard in `onmessage` was found doing it inbound minutes later — by an expensive
   * browser arm driving `npm run host`, because nothing cheaper could reach the branch.
   */
  'key-as-readiness-flag-out': [F.sig,
    "    if (this.ws?.readyState !== 1) return;\n    void seal(this.key, m)",
    "    if (!this.key || this.ws?.readyState !== 1) return;\n    void seal(this.key, m)",
    'seal', 'seal-plaintext-crosses-a-real-socket (outbound)'],
  'key-as-readiness-flag-in': [F.sig,
    '        void unseal(this.key, String(ev.data)).then((m) => {',
    '        if (!this.key) return;\n        void unseal(this.key, String(ev.data)).then((m) => {',
    'seal', 'seal-plaintext-crosses-a-real-socket (inbound)'],
  'plaintext-unmarked': [F.sig,
    "  if (!key) return `0${b64(utf8(json))}`;",
    '  if (!key) return b64(utf8(json));',
    'seal', 'seal-plaintext-is-marked-and-readable'],
  'one-broker': [F.sig,
    "export const PUBLIC_BROKERS = [\n  'wss://broker.emqx.io:8084/mqtt',",
    "export const PUBLIC_BROKERS = [",
    'seal', 'seal-brokers-listed'],

  // ---- browser arms -------------------------------------------------------
  'no-candidates': [F.peer,
    '      this.signal.send({ t: \'ice\', from: this.slot, c: e.candidate.toJSON() });',
    '      void e;',
    'battle', 'battle-*-connected-directly, battle-*-bit-identical, https-peers-connect-and-play'],
  'setup-never-crosses': [F.peer,
    "        if (this.slot === 0) return nothing();\n        return { local: [{ k: 'config', cfg: m.cfg, deployPhase: m.deployPhase }], wire: [] };",
    '        return nothing();',
    'battle', 'battle-config-crossed-the-wire', F.room],
  'console-noise': [F.peer,
    '  private drive(): void {\n    if (this.closed) return;',
    "  private drive(): void {\n    if (this.closed) return;\n    if (this.peerRoom.phase === 'battle') console.error('deliberate noise');",
    'battle', 'battle-console-clean'],
  'delay-ignored': [F.peer,
    '    if (this.dc?.readyState !== \'open\' && this.openedAt < 0) { this.preOpen.push(m); return; }\n    if (!this.sendDelayMs) {',
    '    if (this.dc?.readyState !== \'open\' && this.openedAt < 0) { this.preOpen.push(m); return; }\n    if (true) {',
    'lag', 'lag-costs-latency-not-orders'],
  'drop-the-held-frames': [F.peer,
    '      const held = this.preOpen.splice(0);\n      for (const m of held) this.push(m);',
    '      const held = this.preOpen.splice(0);\n      void held;',
    'lobby', 'lobby-two-people-and-a-code — the bug this arm actually found'],
  // Peer to peer a code needs no permission from anybody, so Create must not be able to fail on
  // a service that is only going to introduce you.
  'create-needs-permission': [F.lobby,
    "          if (r.status === 409 && j?.error === 'started') {",
    "          if (r.status !== 200) {",
    'lobby', 'lobby-mints-a-code-with-no-round-trip'],
  'relay-again-compulsory': [F.lobby,
    "    hostBtn.disabled = throughRelay() && relay.value.trim() === '';",
    "    hostBtn.disabled = relay.value.trim() === '';",
    'lobby', 'lobby-opens-without-an-address'],
  // The rule is "speak when a player would want to know". This makes the panel speak always,
  // which is the mistake the first draft made and qa-net's lan arm caught.
  'always-explains': [F.lobby,
    '      blocked.hidden = true;\n      blocked.innerHTML = \'\';\n      return;',
    '      blocked.innerHTML = introNote(addr);\n      blocked.hidden = false;\n      return;',
    'lobby', 'lobby-says-how-you-are-introduced (the silent half)'],
  'never-explains': [F.lobby,
    "    blocked.innerHTML = introNote(addr);",
    "    blocked.innerHTML = '';",
    'lobby', 'lobby-says-how-you-are-introduced (the explaining half)'],
  'no-relay-checkbox': [F.lobby,
    '      <label class="tc-check" for="tc-via-relay"><input type="checkbox" id="tc-via-relay">',
    '      <label class="tc-check" for="tc-via-relay-gone"><input type="checkbox" id="tc-via-relay-gone">',
    'lobby', 'lobby-relay-still-reachable'],
  'no-how-line': [F.lobby,
    '      <p class="tc-hint" id="tc-how">${viaR',
    '      <p class="tc-hint" id="tc-how-gone">${viaR',
    'lobby', 'lobby-says-how-this-one-connects'],
  'https-form-removed': [F.lobby,
    "  sheet.innerHTML = `\n    <h1>Multiplayer</h1>\n    <p>One battle, both armies, on two machines.",
    "  if (location.protocol === 'https:') {\n    sheet.innerHTML = '<h1>Multiplayer</h1><p>Not from here.</p>';\n    return;\n  }\n  sheet.innerHTML = `\n    <h1>Multiplayer</h1>\n    <p>One battle, both armies, on two machines.",
    'https', 'https-lobby-offers-a-room'],
  // HARNESS, and marked: the control that separates a refusing browser from an absent listener.
  'no-space-override': [F.gate,
    '`--ip-address-space-overrides=${lan.ip}:${HTTPS_PORT}=public`',
    "'--hide-scrollbars'",
    'https', 'https-plain-socket-still-refused (HARNESS fault, deliberately)'],
  /*
   * The first two faults written for the `leave` arm did not bite, and both failed for the same
   * reason: **the survivor has two independent ways of learning the same thing.** Sending `bye`
   * into a void still leaves `dc.onclose`, and `dc.onclose` not calling `peerGone` still leaves
   * the silence test. Redundancy is the right design and it makes a fault have to remove the
   * *specific* path a check is about.
   *
   *   - `bye` handled as `nothing()`  -> `dc.onclose` still reports `peerLeft`. Green.
   *   - `peerGone` without `phase = 'over'` -> the `end` message still ends the session
   *     through `NetSession.onEnd`, which pins the ceiling itself. Green.
   */
  /*
   * `close-is-not-a-departure` used to live here and has been **retired**, because it stopped
   * having teeth the moment the `pagehide` listener landed.
   *
   * It removed `dc.onclose`'s call to `peerGone`. That was the only path a closed tab had until
   * 3 Sep 2026; now the leaver sends `bye` on the way out and the survivor learns from the
   * message rather than from the socket, so cutting the socket path leaves the check green. The
   * fault below removes the path the check is *now* about. The old one is not kept beside it,
   * because a fault that cannot fail is exactly what this file exists to find.
   */
  // Nothing says goodbye, so the survivor waits for the silence test and is told `linkLost` --
  // which blames the wire for somebody shutting a tab. Measured before the fix: 6,019 ms and
  // the wrong word.
  'no-goodbye-on-the-way-out': [F.main,
    "if (session) window.addEventListener('pagehide', () => session.dispose());",
    '// deliberately silent on the way out',
    'leave', 'leave-ends-by-name (it decays to linkLost about six seconds later)'],
  // The tick the match stopped at, in the readout rather than only in the sentence.
  'tick-not-in-the-readout': [F.sess,
    '      endedAtTick: this.endedAtTick,\n',
    '',
    'leave', 'leave-halts-at-a-stated-tick'],
  // What the survivor is told about *where* the battle stood. `lastAgreedTick` is the only
  // number in the sentence that is not this client's own guess.
  'forget-the-agreed-tick': [F.room,
    '      if (tick > this.lastAgreedTick) this.lastAgreedTick = tick;',
    '      void tick;',
    'leave', 'leave-halts-at-a-stated-tick'],
  'no-sheet-for-a-departure': ['src/ui/NetPanel.ts',
    "const KEEPS_THE_STRIP = new Set(['desync', 'complete']);",
    "const KEEPS_THE_STRIP = new Set(['desync', 'complete', 'peerLeft']);",
    'leave', 'leave-puts-a-sheet-up'],
  /*
   * The knock race. Put the challenger's knock timer back and `nodirect` is told the room is
   * full instead of that the two networks would not connect -- which is the wrong accusation
   * against the wrong party, and is how the bug was found.
   */
  'knock-forever': [F.peer,
    '    if (this.knockTimer) { clearInterval(this.knockTimer); this.knockTimer = 0; }\n    for (const c of this.mine.splice(0))',
    '    for (const c of this.mine.splice(0))',
    'nodirect', 'nodirect-says-so-and-stops and nodirect-names-the-right-cause'],
  /*
   * One float64 ULP instead of one float32 ULP -- the magnitude this simulation's state cannot
   * hold. It is gone within a tick, and the peer path's checkpoints never see it.
   */
  'float64-ulp': [F.sess,
    '    const f32 = new Float32Array(1);\n    const u32 = new Uint32Array(f32.buffer);\n    f32[0] = u.x;\n    u32[0] = (u32[0] + 1) >>> 0;\n    u.x = f32[0];',
    '    const dv = new DataView(new ArrayBuffer(8));\n    dv.setFloat64(0, u.x);\n    dv.setUint32(4, (dv.getUint32(4) + 1) >>> 0);\n    u.x = dv.getFloat64(0);',
    'desync', 'desync-ulp-caught, desync-ulp-attributed and desync-ulp-ends-both'],
  'no-explanation': [F.peer,
    "    return 'Your two networks would not let the game connect directly. '",
    "    return '';\n    return 'Your two networks would not let the game connect directly. '",
    'nodirect', 'nodirect-says-so-and-stops'],
  // The arm's second row exists because the two causes are different sentences. Collapse them
  // and the "with STUN off" page is told the block is on the path, which is the opposite.
  'one-cause-fits-all': [F.peer,
    '      + (sawPublic',
    '      + (true || sawPublic',
    'nodirect', 'nodirect-names-the-right-cause (the diagnosis half)'],
  'no-advice': [F.peer,
    "      + 'pretending. What works: both of you on ordinary home internet, or both of you on the '\n      + 'same wifi — which connects without asking anybody. If either of you is on a work or '\n      + 'university network, or a VPN, that is the likeliest cause.';",
    "      + 'pretending.';",
    'nodirect', 'nodirect-names-the-right-cause (the advice half)'],
  'shifted-turn-tick': [F.room,
    "        k: 'turn', ph: 'battle', n: next, t: turnTick(next), ops: this.sorted([...a, ...b]),",
    "        k: 'turn', ph: 'battle', n: next, t: turnTick(next) + 1, ops: this.sorted([...a, ...b]),",
    'ab', 'ab-transport-is-not-in-the-simulation'],
  'dead-brokers': [F.sig,
    "export const PUBLIC_BROKERS = [\n  'wss://broker.emqx.io:8084/mqtt',\n  'wss://test.mosquitto.org:8081/mqtt',\n  'wss://broker.hivemq.com:8884/mqtt',\n];",
    "export const PUBLIC_BROKERS = ['wss://nothing.invalid:8084/mqtt'];",
    'broker', 'broker-carries-an-introduction and (in brokerplay) broker-introduces-two-strangers'],
};

/*
 * Arms that need no browser. `broker` is in the list even though it uses the internet: it is
 * four seconds and no browser slot, so it belongs with the cheap ones when it is asked for.
 */
const FAST = ['proto', 'params', 'seal'];
const argv = process.argv.slice(2);

if (argv.includes('--list') || argv.length === 0) {
  const w = Math.max(...Object.keys(FAULTS).map((k) => k.length));
  for (const [name, [file, , , arm, claim]] of Object.entries(FAULTS)) {
    console.log(`${name.padEnd(w)}  ${arm.padEnd(8)} ${path.basename(file).padEnd(14)} ${claim}`);
  }
  console.log(`\n${Object.keys(FAULTS).length} faults. `
    + `--all-fast runs the ${Object.values(FAULTS).filter((f) => FAST.includes(f[3])).length} `
    + 'whose arm needs no browser.');
  process.exit(0);
}

/*
 * Empty, and worth keeping empty on purpose.
 *
 * It held one entry, for a fault whose only check lived in `qa-net`'s `lan` arm — the plain-http
 * LAN origin, which nothing cheaper could reach. That was a smell rather than a design: the fix
 * was to make the branch reachable (`WsSignal` takes its capability as an argument), so the
 * fault now names a `qa-p2p` arm that runs in two seconds with no browser. If a fault ever
 * genuinely belongs to another gate, this is how to say so instead of mislabelling it.
 */
const CROSS_GATE = {};

const run = async (name) => {
  const fault = FAULTS[name];
  if (!fault) {
    console.error(`unknown fault '${name}'; --list names them all`);
    return 2;
  }
  const [rel, from, to, arm, claim] = fault;
  const file = path.join(ROOT, rel);
  const orig = readFileSync(file, 'utf8');
  if (!orig.includes(from)) {
    console.error(`\n!! fault '${name}': anchor not found in ${rel}\n   ${from.slice(0, 110)}`);
    return 2;
  }
  writeFileSync(file, orig.replace(from, to));
  console.log(`\n=== ${name} -> ${rel}, expecting ${claim} to go red ===`);
  if (CROSS_GATE[arm]) {
    console.log(`this fault belongs to another gate. Run it now, then press Ctrl-C:\n  ${
      CROSS_GATE[arm]}\nthe file will be restored on exit.`);
    process.on('SIGINT', () => { writeFileSync(file, orig); process.exit(1); });
    await new Promise(() => {});
  }
  const code = await new Promise((r) => {
    const p = spawn('node', [path.join(ROOT, 'tools/qa-p2p.mjs'), `--only=${arm}`],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { out += String(d); });
    p.on('exit', (c) => {
      const lines = out.split('\n').filter((l) => /^\s+FAIL|checks passed|uncaught/.test(l));
      console.log(lines.join('\n') || out.split('\n').slice(-4).join('\n'));
      r(c);
    });
  });
  writeFileSync(file, orig);
  console.log(`reverted ${rel}; exit ${code} ${code === 0 ? '<<< STILL GREEN — the check cannot fail' : '(non-zero is the point)'}`);
  return code;
};

if (argv.includes('--all-fast')) {
  const names = Object.entries(FAULTS)
    .filter(([, f]) => FAST.includes(f[3])).map(([n]) => n);
  const green = [];
  for (const n of names) {
    const code = await run(n);
    if (code === 0) green.push(n);
  }
  console.log(`\n${names.length} fast faults run; ${green.length} left the gate green`
    + `${green.length ? `: ${green.join(', ')}` : ' — every one of them was caught'}`);
  process.exit(green.length ? 1 : 0);
}

process.exit(await run(argv[0]));
