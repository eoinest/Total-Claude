#!/usr/bin/env node
/**
 * Does the vendored MQTT client actually talk to the three public brokers?
 *
 * `src/net/signal.ts` is 90 lines of packet encoding written from the MQTT 3.1.1 specification,
 * and the only interesting question about it is whether a real broker accepts it. Node 24 has a
 * global `WebSocket` that takes a subprotocol, `crypto.subtle`, `btoa` and `atob`, so the whole
 * file runs here — which means the answer can be had in two seconds with no browser at all.
 *
 * Two `MqttSignal`s, one code, one message each way. Nothing is faked.
 */
import process from 'node:process';
import { MqttSignal, PUBLIC_BROKERS } from '../../src/net/signal.ts';

const only = process.argv.find((a) => a.startsWith('--broker='));
const urls = only ? [only.split('=')[1]] : PUBLIC_BROKERS;
const code = `Q${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[IOL01]/g, 'X')}`;
console.log(`room ${code} over ${urls.length} broker(s): ${urls.map((u) => new URL(u).host).join(', ')}`);

const a = new MqttSignal(code, 0, urls);
const b = new MqttSignal(code, 1, urls);
const got = { a: [], b: [] };
a.onMessage = (m) => got.a.push(m);
b.onMessage = (m) => got.b.push(m);

const t0 = Date.now();
try {
  await Promise.all([a.open(10000), b.open(10000)]);
} catch (e) {
  console.log(`FAILED to open: ${e.message}`);
  process.exit(1);
}
console.log(`open after ${Date.now() - t0} ms — ${a.name} / ${b.name}`);

// The guest knocks; the host answers with an offer; the guest answers back.
b.send({ t: 'knock', from: 1 });
await new Promise((r) => setTimeout(r, 1500));
a.send({ t: 'offer', from: 0, sdp: 'v=0\r\no=- 1 1 IN IP4 192.168.1.77\r\na=candidate:x\r\n' });
await new Promise((r) => setTimeout(r, 1500));
b.send({ t: 'answer', from: 1, sdp: 'v=0\r\nanswer\r\n' });
await new Promise((r) => setTimeout(r, 1500));

console.log(`host heard   : ${JSON.stringify(got.a)}`);
console.log(`guest heard  : ${JSON.stringify(got.b.map((m) => ({ ...m, sdp: m.sdp?.slice(0, 20) })))}`);
console.log(`unopenable envelopes seen: host ${a.foreign}, guest ${b.foreign}`);
const hostOk = got.a.some((m) => m.t === 'knock') && got.a.some((m) => m.t === 'answer');
const guestOk = got.b.some((m) => m.t === 'offer');
const noEcho = !got.a.some((m) => m.from === 0) && !got.b.some((m) => m.from === 1);
console.log(`\nhost got the knock and the answer: ${hostOk}`);
console.log(`guest got the offer:               ${guestOk}`);
console.log(`neither heard its own messages:    ${noEcho}`);
a.close();
b.close();
const ok = hostOk && guestOk && noEcho;
console.log(ok ? '\nok' : '\nNOT OK');
process.exit(ok ? 0 : 1);
