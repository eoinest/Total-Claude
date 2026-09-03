#!/usr/bin/env node
/**
 * Adding a STUN server made two peers on one machine stop connecting. Is that real?
 *
 * `tools/scratch/iceflags.mjs` measured, once each: `channel:'chromium'` with no STUN
 * connected in 110 ms over a host candidate, and the same browser *with* two public STUN
 * servers sat in `checking` for the whole 12 s budget. If that reproduces it is a product
 * problem and not a harness one — two players in one house are behind one NAT, they are the
 * case the LAN path exists for, and host candidates are supposed to win it outright.
 *
 * Three arms, several trials each, because one run of anything is an anecdote:
 *
 *   - `none`     — no STUN. The control.
 *   - `stun`     — the two servers the product would ship with.
 *   - `stun+v4`  — the same, with IPv6 candidates filtered out, to test whether the culprit
 *                  is the IPv6 srflx candidate that shares its address with the IPv6 *host*
 *                  candidate (this machine has a routable IPv6 address, so the two are the
 *                  same address and differ only in `typ`).
 *   - `pool`     — STUN with `iceCandidatePoolSize: 2`, which pre-gathers before the offer.
 */
import http from 'node:http';
import { launchBrowser } from '../lib/browser-budget.mjs';

const PORT = 5952;
const TRIALS = Number((process.argv.find((a) => a.startsWith('--trials=')) ?? '').split('=')[1] || 3);
const PAGE = '<!doctype html><meta charset=utf-8><title>ice</title><body>ice';

const plain = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const RUN = async ({ urls, ms, v4only, pool }) => {
  const cfg = {
    iceServers: urls.length ? [{ urls }] : [],
    ...(pool ? { iceCandidatePoolSize: pool } : {}),
  };
  const a = new RTCPeerConnection(cfg);
  const b = new RTCPeerConnection(cfg);
  const log = [];
  const seen = [];
  const isV6 = (c) => c.candidate.split(' ')[4].includes(':');
  const wire = (from, to, tag) => {
    const queue = [];
    let ready = false;
    from.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (v4only && isV6(e.candidate)) return;
      const m = e.candidate.candidate.match(/ typ (\w+)/);
      const p = e.candidate.candidate.split(' ');
      seen.push(`${tag}:${m ? m[1] : '?'}:${p[4]}`);
      if (!ready) { queue.push(e.candidate); return; }
      to.addIceCandidate(e.candidate).catch((err) => log.push(`${tag} add ${err.message}`));
    };
    from.onicecandidateerror = (e) => log.push(`${tag} ice${e.errorCode} ${e.url ?? ''}`);
    return () => {
      ready = true;
      for (const c of queue.splice(0)) {
        to.addIceCandidate(c).catch((err) => log.push(`${tag} addq ${err.message}`));
      }
    };
  };
  const flushB = wire(a, b, 'a');
  const flushA = wire(b, a, 'b');
  const dc = a.createDataChannel('tc');
  let echo = '';
  dc.onopen = () => dc.send('ping');
  b.ondatachannel = (e) => { e.channel.onmessage = (m) => { if (m.data === 'ping') e.channel.send('pong'); }; };
  dc.onmessage = (m) => { echo = String(m.data); };
  const t0 = performance.now();
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  flushB();
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  flushA();
  while (performance.now() - t0 < ms && echo !== 'pong') await new Promise((r) => setTimeout(r, 25));
  const took = Math.round(performance.now() - t0);
  const stats = await a.getStats();
  let pair = null;
  const pairs = [];
  for (const [, s] of stats) {
    if (s.type !== 'candidate-pair') continue;
    pairs.push(`${s.state}${s.nominated ? '*' : ''}`);
    if (s.state === 'succeeded' && s.nominated) pair = s;
  }
  let local = null;
  if (pair) for (const [id, s] of stats) if (id === pair.localCandidateId) local = s;
  const out = {
    ok: echo === 'pong', took, conn: a.connectionState, ice: a.iceConnectionState,
    used: local ? `${local.candidateType} ${local.address}` : null,
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1e4) / 10 : null,
    pairs: pairs.join(','), seen: [...new Set(seen)].join(' '), log: [...new Set(log)].join(' | '),
  };
  a.close(); b.close();
  return out;
};

const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const ARMS = [
  { name: 'none', urls: [] },
  { name: 'stun', urls: STUN },
  { name: 'stun+v4only', urls: STUN, v4only: true },
  { name: 'stun+pool2', urls: STUN, pool: 2 },
];

await new Promise((ok, no) => { plain.on('error', no); plain.listen(PORT, '127.0.0.1', ok); });
const browser = await launchBrowser({
  label: 'scratch/icestun', port: PORT, channel: 'chromium',
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
try {
  for (const arm of ARMS) {
    const rows = [];
    for (let i = 0; i < TRIALS; i++) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`);
      rows.push(await page.evaluate(RUN, { urls: arm.urls, ms: 20000, v4only: arm.v4only, pool: arm.pool }));
      await page.close();
    }
    const ok = rows.filter((r) => r.ok).length;
    console.log(`\n== ${arm.name}: ${ok}/${rows.length} connected ==`);
    for (const r of rows) {
      console.log(`  ${r.ok ? 'ok ' : 'NO '} ${String(r.took).padStart(6)} ms  via ${r.used ?? '-'}`
        + `  rtt=${r.rttMs ?? '-'}  ice=${r.ice}  pairs=[${r.pairs}]`);
      console.log(`       cands: ${r.seen}`);
      if (r.log) console.log(`       log: ${r.log}`);
    }
  }
} finally {
  await browser.close();
  plain.close();
}
