#!/usr/bin/env node
/**
 * Reconnaissance, before a line of transport is written: what does ICE actually do here?
 *
 * Three questions, and the whole design rests on the answers rather than on the brief:
 *
 *  1. Does this machine get a **server-reflexive** candidate from a public STUN server? If it
 *     does not, peer-to-peer across the internet is not merely unreliable here, it is
 *     impossible, and the honest thing is to say so before building on it.
 *  2. Does an **https page the browser believes is public** still gather host candidates for a
 *     private address, and does a peer connection over them complete? This is the claim the
 *     whole choice of WebRTC rests on — that a peer connection is blocked by neither mixed
 *     content nor Local Network Access — and it is a claim about a browser, so it gets
 *     measured with the same `--ip-address-space-overrides` the `https` arm of
 *     `tools/qa-net.mjs` uses.
 *  3. Which candidate pair does a real connection between two pages on this machine select?
 *     If the answer is `host`, then every measurement made on one machine is a measurement of
 *     the LAN case and says nothing about two strangers, and every claim about the second has
 *     to be labelled as inference.
 *
 * Reads nothing, writes nothing, decides nothing. `node tools/scratch/icecheck.mjs`.
 */
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { lanAddress } from '../lib/lan-address.mjs';

const PORT = 5949;
const TLS_PORT = 5950;
const CERT_DIR = '/tmp/tc-icecheck';

const PAGE = `<!doctype html><meta charset=utf-8><title>ice</title><body>ice</body>`;

const plain = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

/** Gather candidates for `ms`, then report every one with its type and address. */
const GATHER = async ({ urls, ms }) => {
  const pc = new RTCPeerConnection({ iceServers: urls.length ? [{ urls }] : [] });
  const cands = [];
  const errs = [];
  pc.onicecandidateerror = (e) => errs.push({ url: e.url, code: e.errorCode, text: e.errorText });
  pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, ms));
  const state = pc.iceGatheringState;
  pc.close();
  const parse = (c) => {
    const p = c.split(' ');
    const t = c.match(/ typ (\w+)/);
    return { type: t ? t[1] : '?', addr: p[4], port: p[5], proto: p[2] };
  };
  return { state, errs, cands: cands.map(parse) };
};

/**
 * Two peer connections in one page, connected to each other. Reports the selected pair.
 *
 * **Candidates are queued until the remote description exists**, and the first version of this
 * function did not do that — which is why the first run reported `ice: checking` for ever with
 * no error anywhere. `addIceCandidate` rejects while `remoteDescription` is null, `void` threw
 * the rejection away, and host candidates on this machine are gathered fast enough that *every*
 * one of them landed in that window. The measurement said "two pages on one machine cannot
 * connect"; what was true is "this test discarded every candidate it gathered".
 *
 * The production transport has the identical hazard and it is the reason this is written down
 * here: a signalling channel delivers an offer and a candidate in whatever order the wire
 * produces them, and a peer that trusts the order loses candidates silently.
 */
const PAIR = async ({ urls, ms, only }) => {
  const cfg = { iceServers: urls.length ? [{ urls }] : [] };
  const a = new RTCPeerConnection(cfg);
  const b = new RTCPeerConnection(cfg);
  const log = [];
  const typeOf = (c) => (c.candidate.match(/ typ (\w+)/) || [])[1];
  const wire = (from, to, tag) => {
    const queue = [];
    let ready = false;
    from.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (only && !only.includes(typeOf(e.candidate))) return;
      if (!ready) { queue.push(e.candidate); return; }
      to.addIceCandidate(e.candidate).catch((err) => log.push(tag + ' add: ' + err.message));
    };
    from.onicecandidateerror = (e) => log.push(tag + ' ice ' + e.errorCode + ' ' + e.errorText);
    return () => {
      ready = true;
      for (const c of queue.splice(0)) {
        to.addIceCandidate(c).catch((err) => log.push(tag + ' add(queued): ' + err.message));
      }
    };
  };
  const flushToB = wire(a, b, 'a->b');
  const flushToA = wire(b, a, 'b->a');
  const dc = a.createDataChannel('tc');
  let open = false;
  let echo = '';
  dc.onopen = () => { open = true; dc.send('ping'); };
  b.ondatachannel = (e) => { e.channel.onmessage = (m) => { if (m.data === 'ping') e.channel.send('pong'); }; };
  dc.onmessage = (m) => { echo = String(m.data); };
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  flushToB();
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  flushToA();
  const t0 = performance.now();
  while (performance.now() - t0 < ms && echo !== 'pong') await new Promise((r) => setTimeout(r, 50));
  const took = Math.round(performance.now() - t0);
  let pair = null;
  const stats = await a.getStats();
  for (const [, s] of stats) {
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
  }
  let local = null; let remote = null;
  if (pair) for (const [id, s] of stats) {
    if (id === pair.localCandidateId) local = s;
    if (id === pair.remoteCandidateId) remote = s;
  }
  const out = {
    open, echo, took, log,
    conn: a.connectionState, ice: a.iceConnectionState,
    local: local && { type: local.candidateType, ip: local.address, proto: local.protocol },
    remote: remote && { type: remote.candidateType, ip: remote.address, proto: remote.protocol },
    rttMs: pair && pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
  };
  a.close(); b.close();
  return out;
};

const STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

const say = (o) => console.log(JSON.stringify(o, null, 2));

const main = async () => {
  const lan = lanAddress();
  console.log(`LAN address: ${lan.ip || '(none)'} on ${lan.iface || '?'}`);
  await new Promise((ok, no) => { plain.on('error', no); plain.listen(PORT, '0.0.0.0', ok); });
  console.log(`plain http on 0.0.0.0:${PORT}`);

  // A TLS front end on the LAN address, so the second question has a real https origin.
  let tls = null;
  if (lan.ip) {
    mkdirSync(CERT_DIR, { recursive: true });
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', `${CERT_DIR}/key.pem`, '-out', `${CERT_DIR}/cert.pem`, '-days', '2',
        '-subj', `/CN=${lan.ip}`, '-addext', `subjectAltName=IP:${lan.ip}`],
      { stdio: 'ignore' });
      tls = https.createServer({
        key: readFileSync(`${CERT_DIR}/key.pem`), cert: readFileSync(`${CERT_DIR}/cert.pem`),
      }, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      });
      await new Promise((ok, no) => { tls.on('error', no); tls.listen(TLS_PORT, '0.0.0.0', ok); });
      console.log(`https on 0.0.0.0:${TLS_PORT} (self-signed, CN=${lan.ip})`);
    } catch (e) {
      console.log(`no https origin: ${e.message}`);
      tls = null;
    }
  }

  const browser = await launchBrowser({
    label: 'scratch/icecheck', port: PORT,
    args: [
      ...(lan.ip ? [`--ip-address-space-overrides=${lan.ip}:${TLS_PORT}=public`] : []),
      ...(process.argv.includes('--mdns') ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns']),
    ],
  });

  try {
    // ---- 1. a plain-http loopback page, real STUN --------------------------
    {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`);
      console.log('\n== 1. loopback http page, public STUN ==');
      say(await page.evaluate(GATHER, { urls: STUN, ms: 5000 }));
      await page.close();
    }
    // ---- 2. the https page the browser believes is public ------------------
    if (tls) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      const errs = [];
      page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      page.on('pageerror', (e) => errs.push(String(e)));
      await page.goto(`https://${lan.ip}:${TLS_PORT}/`);
      console.log('\n== 2. https page DECLARED PUBLIC, public STUN ==');
      console.log(`origin: ${await page.evaluate(() => location.origin)}`);
      say(await page.evaluate(GATHER, { urls: STUN, ms: 5000 }));
      console.log('\n== 2b. and a peer connection between two pcs on that page ==');
      say(await page.evaluate(PAIR, { urls: STUN, ms: 15000 }));
      console.log(`console errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
      await page.close();
    } else {
      console.log('\n== 2 skipped: no https origin ==');
    }
    // ---- 3. which pair wins, and what happens with host candidates gone ---
    {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`);
      console.log('\n== 3. selected pair, all candidate types allowed ==');
      say(await page.evaluate(PAIR, { urls: STUN, ms: 15000 }));
      console.log('\n== 3b. srflx only — the hairpin test, i.e. "two strangers" on one NAT ==');
      say(await page.evaluate(PAIR, { urls: STUN, ms: 20000, only: ['srflx'] }));
      await page.close();
    }
  } finally {
    await browser.close();
    plain.close();
    tls?.close();
  }
};

await main();
