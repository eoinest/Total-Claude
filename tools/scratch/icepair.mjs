#!/usr/bin/env node
/**
 * The shape the gate will actually use: **two browsers**, one peer connection each.
 *
 * `tools/scratch/icestun.mjs` measured two `RTCPeerConnection`s *in one page* connecting 1 time
 * in 12 across four configurations, with `ice=disconnected` and an empty candidate-pair list
 * — no `addIceCandidate` error, no `icecandidateerror`, nothing to attribute it to. That is a
 * bad instrument, not necessarily a bad transport: two peer connections in one renderer share a
 * port allocator and a network thread, and nothing a player will ever do looks like it.
 *
 * So this measures the real shape and nothing else: two browser processes, one peer connection
 * in each, signalling through a mailbox on plain HTTP so that no part of the measurement
 * depends on code this pass has not written yet.
 *
 * Trials are the point. One run of a connection test is an anecdote, and this repository has a
 * documented history of publishing anecdotes as rates.
 */
import http from 'node:http';
import { launchBrowser } from '../lib/browser-budget.mjs';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const PORT = Number(arg('port', 5953));
const TRIALS = Number(arg('trials', 5));
const MODE = arg('mode', 'stun');
const CHANNEL = arg('channel', 'chromium');
/*
 * `--host=lan` serves and loads from the LAN address instead of loopback, which is the one
 * question `tools/scratch/securectx.mjs` left open: it showed `RTCPeerConnection` *constructs* on
 * a non-secure origin and never asked whether a connection *completes* there. `npm run host`
 * serves exactly that origin, so the answer decides whether the LAN path can be peer to peer at
 * all.
 */
const HOSTMODE = arg('host', 'loopback');

/** A mailbox per (room, slot). `GET` drains, `POST` appends. Nothing clever. */
const boxes = new Map();
const key = (room, slot) => `${room}/${slot}`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset=utf-8><title>ice</title><body>ice');
    return;
  }
  const room = u.searchParams.get('room') ?? '';
  const slot = u.searchParams.get('slot') ?? '';
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const k = key(room, slot);
      if (!boxes.has(k)) boxes.set(k, []);
      boxes.get(k).push(body);
      res.writeHead(204); res.end();
    });
    return;
  }
  const k = key(room, slot);
  const out = boxes.get(k) ?? [];
  boxes.set(k, []);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
});

/**
 * One peer, in one page. Polls its own mailbox, posts to the other slot's.
 *
 * The candidate queue is not optional: `addIceCandidate` rejects while `remoteDescription` is
 * null, and on this machine host candidates are gathered inside the window between the offer
 * being posted and the answer coming back. `tools/scratch/icecheck.mjs` lost every candidate it
 * gathered to exactly that, silently, and reported it as "two pages cannot connect".
 */
const PEER = async ({ base, room, slot, urls, ms }) => {
  const other = slot === 0 ? 1 : 0;
  const post = (m) => fetch(`${base}/box?room=${room}&slot=${other}`,
    { method: 'POST', body: JSON.stringify(m) }).catch(() => {});
  const poll = async () => {
    const r = await fetch(`${base}/box?room=${room}&slot=${slot}`).catch(() => null);
    if (!r) return [];
    return (await r.json()).map((s) => JSON.parse(s));
  };
  const pc = new RTCPeerConnection({ iceServers: urls.length ? [{ urls }] : [] });
  const log = [];
  const cands = [];
  const queue = [];
  let haveRemote = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const m = e.candidate.candidate.match(/ typ (\w+)/);
    cands.push(`${m ? m[1] : '?'}:${e.candidate.candidate.split(' ')[4]}`);
    void post({ t: 'ice', c: e.candidate.toJSON() });
  };
  pc.onicecandidateerror = (e) => log.push(`ice${e.errorCode} ${e.url ?? ''}`);
  pc.oniceconnectionstatechange = () => log.push(`ice:${pc.iceConnectionState}`);
  let echo = '';
  let opened = -1;
  const t0 = performance.now();
  if (slot === 0) {
    const dc = pc.createDataChannel('tc');
    dc.onopen = () => { opened = Math.round(performance.now() - t0); dc.send('ping'); };
    dc.onmessage = (m) => { echo = String(m.data); };
    await pc.setLocalDescription(await pc.createOffer());
    await post({ t: 'offer', sdp: pc.localDescription.sdp });
  } else {
    pc.ondatachannel = (e) => {
      e.channel.onopen = () => { opened = Math.round(performance.now() - t0); };
      e.channel.onmessage = (m) => { if (m.data === 'ping') { echo = 'ping'; e.channel.send('pong'); } };
    };
  }
  const take = async (m) => {
    if (m.t === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      haveRemote = true;
      for (const c of queue.splice(0)) await pc.addIceCandidate(c).catch((e) => log.push(`addq ${e.message}`));
      await pc.setLocalDescription(await pc.createAnswer());
      await post({ t: 'answer', sdp: pc.localDescription.sdp });
      return;
    }
    if (m.t === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      haveRemote = true;
      for (const c of queue.splice(0)) await pc.addIceCandidate(c).catch((e) => log.push(`addq ${e.message}`));
      return;
    }
    if (m.t !== 'ice') return;
    if (!haveRemote) { queue.push(m.c); return; }
    await pc.addIceCandidate(m.c).catch((e) => log.push(`add ${e.message}`));
  };
  while (performance.now() - t0 < ms && echo === '') {
    for (const m of await poll()) await take(m);
    await new Promise((r) => setTimeout(r, 40));
  }
  const took = Math.round(performance.now() - t0);
  const stats = await pc.getStats();
  let pair = null;
  const pairs = [];
  for (const [, s] of stats) {
    if (s.type !== 'candidate-pair') continue;
    pairs.push(`${s.state}${s.nominated ? '*' : ''}`);
    if (s.state === 'succeeded' && s.nominated) pair = s;
  }
  let local = null; let remote = null;
  if (pair) for (const [id, s] of stats) {
    if (id === pair.localCandidateId) local = s;
    if (id === pair.remoteCandidateId) remote = s;
  }
  const out = {
    ok: echo !== '', echo, took, opened,
    conn: pc.connectionState, ice: pc.iceConnectionState,
    used: local && remote ? `${local.candidateType}->${remote.candidateType} ${remote.address}` : null,
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1e4) / 10 : null,
    pairs: pairs.join(','), cands: [...new Set(cands)].join(' '),
    log: [...new Set(log)].join(' | '),
  };
  pc.close();
  return out;
};

const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const urls = MODE === 'none' ? [] : STUN;

const { lanAddress } = await import('../lib/lan-address.mjs');
const bind = HOSTMODE === 'lan' ? '0.0.0.0' : '127.0.0.1';
const hostName = HOSTMODE === 'lan' ? (lanAddress().ip || '127.0.0.1') : '127.0.0.1';
await new Promise((ok, no) => { server.on('error', no); server.listen(PORT, bind, ok); });
const base = `http://${hostName}:${PORT}`;
const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const a = await launchBrowser({ label: 'scratch/icepair-a', port: PORT, channel: CHANNEL, args });
const b = await launchBrowser({ label: 'scratch/icepair-b', channel: CHANNEL, args });
console.log(`mode=${MODE} channel=${CHANNEL} trials=${TRIALS} origin=${base}`);
let good = 0;
const times = [];
try {
  for (let i = 0; i < TRIALS; i++) {
    const room = `R${i}`;
    const pa = await a.newPage();
    const pb = await b.newPage();
    await pa.goto(`${base}/`);
    await pb.goto(`${base}/`);
    const [ra, rb] = await Promise.all([
      pa.evaluate(PEER, { base, room, slot: 0, urls, ms: 25000 }),
      pb.evaluate(PEER, { base, room, slot: 1, urls, ms: 25000 }),
    ]);
    const ok = ra.ok && rb.ok;
    if (ok) { good++; times.push(ra.opened); }
    console.log(`\ntrial ${i}: ${ok ? 'CONNECTED' : 'FAILED'}`);
    for (const [tag, r] of [['host ', ra], ['guest', rb]]) {
      console.log(`  ${tag} echo=${r.echo || '-'} open@${r.opened} took=${r.took} `
        + `conn=${r.conn} ice=${r.ice} via ${r.used ?? '-'} rtt=${r.rttMs ?? '-'} pairs=[${r.pairs}]`);
      console.log(`         cands: ${r.cands}`);
      if (r.log) console.log(`         log: ${r.log}`);
    }
    await pa.close(); await pb.close();
  }
} finally {
  await a.close(); await b.close(); server.close();
}
times.sort((x, y) => x - y);
console.log(`\n== ${good}/${TRIALS} connected; open times ${times.join(', ')} ms `
  + `(median ${times.length ? times[times.length >> 1] : '-'} ms) ==`);
