#!/usr/bin/env node
/**
 * Which Chromium switches make a peer connection complete *on this machine*?
 *
 * `tools/scratch/icecheck.mjs` established that ICE gathering works here — host and
 * server-reflexive candidates on both a plain page and an https page the browser has been told
 * is public — and that the connectivity check then times out over host candidates. The machine
 * is the suspect: the macOS application firewall is enabled, `socketfilterfw --listapps` has an
 * entry for Homebrew's `node` and none for Playwright's Chromium, and `tools/scratch/udpself.mjs`
 * shows node receiving its own UDP on the LAN address perfectly well.
 *
 * So this is not a question about WebRTC, it is a question about which switch gets a browser
 * this machine will deliver UDP to. Loopback is the candidate: the application firewall does not
 * filter `lo0`, and Chromium can be asked to gather loopback candidates.
 *
 * Whatever comes out of this belongs in the harness and **not** in the product: a player's own
 * browser is a signed application their firewall has an opinion about, and their peer is on
 * another machine.
 */
import http from 'node:http';
import { launchBrowser } from '../lib/browser-budget.mjs';

const PORT = 5951;
const PAGE = '<!doctype html><meta charset=utf-8><title>ice</title><body>ice';

const plain = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const PAIR = async ({ urls, ms }) => {
  const cfg = { iceServers: urls.length ? [{ urls }] : [] };
  const a = new RTCPeerConnection(cfg);
  const b = new RTCPeerConnection(cfg);
  const log = [];
  const seen = [];
  const wire = (from, to, tag) => {
    const queue = [];
    let ready = false;
    from.onicecandidate = (e) => {
      if (!e.candidate) return;
      const m = e.candidate.candidate.match(/ typ (\w+)/);
      const parts = e.candidate.candidate.split(' ');
      seen.push(`${tag} ${m ? m[1] : '?'} ${parts[4]}:${parts[5]}`);
      if (!ready) { queue.push(e.candidate); return; }
      to.addIceCandidate(e.candidate).catch((err) => log.push(`${tag} add: ${err.message}`));
    };
    from.onicecandidateerror = (e) => log.push(`${tag} ice ${e.errorCode} ${e.errorText}`);
    return () => {
      ready = true;
      for (const c of queue.splice(0)) {
        to.addIceCandidate(c).catch((err) => log.push(`${tag} add(q): ${err.message}`));
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
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  flushB();
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  flushA();
  const t0 = performance.now();
  while (performance.now() - t0 < ms && echo !== 'pong') await new Promise((r) => setTimeout(r, 50));
  const took = Math.round(performance.now() - t0);
  const stats = await a.getStats();
  let pair = null;
  for (const [, s] of stats) if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s;
  let local = null;
  if (pair) for (const [id, s] of stats) if (id === pair.localCandidateId) local = s;
  const out = {
    echo, took, conn: a.connectionState, ice: a.iceConnectionState,
    used: local ? `${local.candidateType} ${local.address}` : null,
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1e4) / 10 : null,
    seen, log,
  };
  a.close(); b.close();
  return out;
};

const COMBOS = [
  {
    name: "channel:'chromium' — the same bundled binary in NEW headless mode",
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'], urls: [], channel: 'chromium',
  },
  {
    name: "channel:'chromium', with public STUN",
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'], channel: 'chromium',
    urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  },
  {
    name: "channel:'chromium', mDNS left ON (what a real browser does by default)",
    args: [], urls: [], channel: 'chromium',
  },
  {
    name: 'default headless (chrome-headless-shell) — the control',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'], urls: [],
  },
];

await new Promise((ok, no) => { plain.on('error', no); plain.listen(PORT, '127.0.0.1', ok); });

for (const combo of COMBOS) {
  const { name, args, urls, ...extra } = combo;
  void name; void urls;
  const browser = await launchBrowser({ label: 'scratch/iceflags', port: PORT, args, ...extra });
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const r = await page.evaluate(PAIR, { urls: combo.urls, ms: 12000 });
    console.log(`\n== ${combo.name} ==`);
    console.log(`  args: ${combo.args.join(' ') || '(none)'}`);
    console.log(`  ${r.echo === 'pong' ? 'CONNECTED' : 'FAILED'} in ${r.took} ms via ${r.used ?? '-'}`
      + ` (conn=${r.conn} ice=${r.ice} rtt=${r.rttMs ?? '-'} ms)`);
    console.log(`  candidates: ${r.seen.join(', ') || '(none)'}`);
    if (r.log.length) console.log(`  log: ${r.log.join(' | ')}`);
    if (errs.length) console.log(`  console: ${errs.join(' | ')}`);
    await page.close();
  } finally {
    await browser.close();
  }
}
plain.close();
