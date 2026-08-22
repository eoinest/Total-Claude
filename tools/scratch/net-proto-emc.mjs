#!/usr/bin/env node
/**
 * Scratch: drive `Room` over a real socket with two synthetic clients.
 *
 * Not a gate — `tools/qa-net.mjs` is. This is the thing that told me whether the state machine
 * was worth pointing two browsers at, and it is kept because it runs in two seconds and the
 * gate takes minutes. Delete it if it stops earning that.
 */
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 5902);
const base = `ws://127.0.0.1:${PORT}`;

const open = (room, want) => new Promise((ok, no) => {
  const ws = new WebSocket(`${base}/room/${room}?want=${want}&v=1`);
  const got = [];
  ws.log = got;
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  ws.onopen = () => ok(ws);
  ws.onerror = () => no(new Error('socket error'));
  setTimeout(() => no(new Error('open timeout')), 4000);
});
const wait = (ws, k, ms = 4000) => new Promise((ok, no) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const m = ws.log.find((x) => x.k === k);
    if (m) { clearInterval(iv); ok(m); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error(`no ${k}`)); }
  }, 10);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const print = (over = {}) => ({
  cfgKey: '{"map":"pydna"}', quality: 'high', unitScale: 1, count0: 100,
  hash: 'aaaa1111', uf64: 'bbbb2222', uctl: 'cccc3333',
  libm: 'deadbeef', ua: 'Mozilla/5.0 Chrome/151.0.0.0', deployPhase: false, ...over,
});

let bad = 0;
const check = (name, cond, saw) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}  ${saw}`);
  if (!cond) bad++;
};

// --- a normal two-player start ---
const A = await open('AAAAA', 'host');
const wa = await wait(A, 'welcome');
send(A, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
const B = await open('AAAAA', 'join');
const wb = await wait(B, 'welcome');
check('slots', wa.slot === 0 && wb.slot === 1, `${wa.slot}/${wb.slot}`);
const cfgMsg = await wait(B, 'config');
check('config forwarded before boot', !!cfgMsg.cfg, JSON.stringify(cfgMsg.cfg));
send(A, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
send(B, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
const st = await wait(A, 'start');
check('start', st.phase === 'battle' && st.factions.length === 2, JSON.stringify(st.factions));
check('pair note', st.pairNote.includes('identical libm'), st.pairNote.slice(0, 40));

// --- canonical order: two ops from two slots in one turn, sorted by (slot, seq) ---
send(B, { k: 'ops', ev: [['B1']] });
send(A, { k: 'ops', ev: [['A1']] });
send(A, { k: 'ops', ev: [['A2']] });
await sleep(700);
const turns = A.log.filter((m) => m.k === 'turn' && m.ops.length);
const flat = turns.flatMap((t) => t.ops.map((o) => `${o.s}:${o.e[0]}`));
check('canonical (slot, seq) order', flat.join(',') === '0:A1,0:A2,1:B1', flat.join(','));
const tp = turns[0];
check('turn carries its execution tick', tp.t === tp.n * 3, `n=${tp.n} t=${tp.t}`);
const bTurns = B.log.filter((m) => m.k === 'turn' && m.ops.length);
check('both slots got the identical packet',
  JSON.stringify(bTurns.map((t) => [t.n, t.ops])) === JSON.stringify(turns.map((t) => [t.n, t.ops])),
  `${turns.length} vs ${bTurns.length} non-empty turns`);

// --- a third client is refused, and a late one is refused differently ---
const C = await open('AAAAA', 'join').catch(() => null);
if (C) {
  const r = await wait(C, 'refuse').catch(() => null);
  check('third client refused', !!r && r.why === 'started', r ? r.detail.slice(0, 60) : 'no refusal');
  C.close();
}

// --- the hash comparison ---
send(A, { k: 'hash', tick: 30, hash: 'h1', uf64: 'u1', uctl: 'c1', alive: 10 });
send(B, { k: 'hash', tick: 30, hash: 'h1', uf64: 'u1', uctl: 'c1', alive: 10 });
await sleep(120);
send(A, { k: 'hash', tick: 60, hash: 'h2', uf64: 'u2', uctl: 'c2', alive: 10 });
send(B, { k: 'hash', tick: 60, hash: 'h2', uf64: 'uX', uctl: 'c2', alive: 10 });
const ds = await wait(A, 'desync');
check('desync detected on uf64', ds.layer === 'uf64' && ds.tick === 60, `${ds.layer}@${ds.tick}`);
check('last agreed tick reported', ds.lastAgreedTick === 30, String(ds.lastAgreedTick));
await wait(A, 'wantProbe');
send(A, { k: 'probe', tick: 60, units: [[1, 'x'], [2, 'y']] });
send(B, { k: 'probe', tick: 60, units: [[1, 'x'], [2, 'z']] });
const at = await wait(A, 'attrib');
check('attributed to a unit', JSON.stringify(at.units) === '[2]', JSON.stringify(at.units));
const en = await wait(A, 'end');
check('ends with a stated tick', en.why === 'desync' && en.atTick === 30, `${en.why}@${en.atTick}`);
A.close(); B.close();

// --- a mismatched pairing ---
const D = await open('BBBBB', 'host');
await wait(D, 'welcome');
send(D, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
const E = await open('BBBBB', 'join');
await wait(E, 'welcome');
send(D, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
send(E, {
  k: 'ready',
  print: print({ libm: 'feedface', ua: 'Mozilla/5.0 Firefox/153.0' }),
  cfg: { map: 'pydna' },
  factions: [0, 1],
});
const ref = await wait(D, 'refuse').catch(() => null);
check('chromium+firefox is an allowed pairing, so this is NOT refused', ref === null,
  ref ? ref.detail.slice(0, 60) : 'started');
const st2 = await wait(D, 'start');
check('and it is announced as one that will fork', st2.willFork === true, st2.pairNote.slice(0, 50));
D.close(); E.close();

// --- a same-engine different-build pairing, which is not allowed ---
const F = await open('CCCCC', 'host');
await wait(F, 'welcome');
send(F, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
const G = await open('CCCCC', 'join');
await wait(G, 'welcome');
send(F, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
send(G, { k: 'ready', print: print({ libm: '0badf00d' }), cfg: { map: 'pydna' }, factions: [0, 1] });
const ref2 = await wait(F, 'refuse');
check('chromium+chromium at different builds is refused', ref2.why === 'libm',
  ref2.detail.slice(0, 80));
F.close(); G.close();

// --- a disconnect ends the match rather than hanging ---
const H = await open('DDDDD', 'host');
await wait(H, 'welcome');
send(H, { k: 'setup', cfg: { map: 'pydna' }, deployPhase: false });
const I = await open('DDDDD', 'join');
await wait(I, 'welcome');
send(H, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
send(I, { k: 'ready', print: print(), cfg: { map: 'pydna' }, factions: [0, 1] });
await wait(H, 'start');
I.close();
const end2 = await wait(H, 'end');
check('a disconnect ends the match by name', end2.why === 'peerLeft', end2.detail.slice(0, 60));
H.close();

console.log(bad === 0 ? '\nall protocol checks passed' : `\n${bad} protocol check(s) FAILED`);
process.exit(bad ? 1 : 0);
