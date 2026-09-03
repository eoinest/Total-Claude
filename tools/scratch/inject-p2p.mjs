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
  gate: 'tools/qa-p2p.mjs',
};

/** `name: [file, from, to, arm, the check it should turn red]` */
const FAULTS = {
  // ---- proto: the state machine, no browser -------------------------------
  'guest-drops-an-op': [F.room,
    "      local.push({\n        k: 'turn', ph: 'battle', n: next, t: turnTick(next), ops: this.sorted([...a, ...b]),\n      });",
    "      const both = this.sorted([...a, ...b]);\n      local.push({\n        k: 'turn', ph: 'battle', n: next, t: turnTick(next),\n        ops: this.slot === 1 ? both.slice(1) : both,\n      });",
    'proto', 'proto-one-order-stream, and every battle bit-identity check'],
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
    'proto', 'proto-nothing-dropped, proto-one-order-stream, proto-deploy-in-one-order'],
  'flip-on-my-own-flag': [F.room,
    '        if (this.sides[0].ready && this.sides[1].ready) {',
    '        if (this.iAmReady) {',
    'proto', 'proto-phase-flip-agrees'],
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
  'one-broker': [F.sig,
    "export const PUBLIC_BROKERS = [\n  'wss://broker.emqx.io:8084/mqtt',",
    "export const PUBLIC_BROKERS = [",
    'seal', 'seal-brokers-listed'],

  // ---- browser arms -------------------------------------------------------
  'no-candidates': [F.peer,
    '      this.signal.send({ t: \'ice\', from: this.slot, c: e.candidate.toJSON() });',
    '      void e;',
    'battle', 'battle-*-connected-directly and battle-*-bit-identical'],
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
  'relay-again-compulsory': [F.lobby,
    "    hostBtn.disabled = throughRelay() && relay.value.trim() === '';",
    "    hostBtn.disabled = relay.value.trim() === '';",
    'lobby', 'lobby-opens-without-an-address'],
  'refuse-again': [F.lobby,
    "    : '<b>The game runs straight between the two browsers, with nothing in between.</b> To set '",
    "    : '<b>There is no relay behind this page, so a battle cannot be played from it.</b> '\n      + 'x '",
    'lobby', 'lobby-says-how-you-are-introduced'],
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
  // The channel closing is the *specific* path `leave-ends-by-name` is about: without it the
  // survivor waits for the silence test and is told `linkLost`, which blames the wire for
  // somebody shutting a tab.
  'close-is-not-a-departure': [F.peer,
    "      this.take(this.peerRoom.peerGone('the other commander\\'s connection closed'));",
    '      // deliberately not reported',
    'leave', 'leave-ends-by-name (it decays to linkLost about eight seconds later)'],
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
    'broker', 'broker-carries-an-introduction'],
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
