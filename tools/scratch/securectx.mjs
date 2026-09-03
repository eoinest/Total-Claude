#!/usr/bin/env node
/**
 * Is a plain-http **LAN** origin a secure context, and if not, what is missing?
 *
 * `npm run host` serves the game over plain `http` on an address like `192.168.1.77:5938`, which
 * is the whole of the same-network story. Loopback is always a secure context; a private IPv4
 * address is **not**, unless the browser has been told otherwise. Two APIs this pass depends on
 * are secure-context-gated by specification:
 *
 *   - `crypto.subtle`, which `src/net/signal.ts` uses to seal an offer.
 *   - `RTCPeerConnection` — MDN lists it as available in secure contexts only.
 *
 * If the second is genuinely gone there, the peer transport cannot be the LAN path at all and
 * `npm run host` has to keep using the relay transport. That is a product decision and it needs a
 * measurement under it rather than a guess, which is what this is.
 */
import http from 'node:http';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { lanAddress } from '../lib/lan-address.mjs';

const PORT = 5948;
const PAGE = '<!doctype html><meta charset=utf-8><title>ctx</title><body>ctx';
const srv = http.createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(PAGE);
});

const READ = () => ({
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  hasSubtle: typeof crypto !== 'undefined' && !!crypto.subtle,
  hasRandom: typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function',
  hasRTC: typeof RTCPeerConnection !== 'undefined',
  rtcConstructs: (() => {
    try { const p = new RTCPeerConnection(); p.close(); return 'yes'; } catch (e) { return `threw ${e.name}: ${e.message}`; }
  })(),
  dataChannel: (() => {
    try {
      const p = new RTCPeerConnection();
      const d = p.createDataChannel('x');
      const ok = !!d;
      p.close();
      return ok ? 'yes' : 'no';
    } catch (e) { return `threw ${e.name}`; }
  })(),
  subtleWorks: 'pending',
});

const lan = lanAddress();
await new Promise((ok, no) => { srv.on('error', no); srv.listen(PORT, '0.0.0.0', ok); });
const browser = await launchBrowser({ label: 'scratch/securectx', port: PORT, channel: 'chrome' });
try {
  for (const origin of [`http://127.0.0.1:${PORT}`, lan.ip ? `http://${lan.ip}:${PORT}` : null]) {
    if (!origin) continue;
    const page = await browser.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(READ);
    r.subtleWorks = await page.evaluate(async () => {
      try {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('x'), 'HKDF',
          false, ['deriveKey']);
        return k ? 'yes' : 'no';
      } catch (e) { return `threw ${e.name}: ${String(e.message).slice(0, 80)}`; }
    });
    console.log(`\n== ${origin} ==`);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(18)} ${v}`);
    if (errs.length) console.log(`  console           ${errs.slice(0, 2).join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  srv.close();
}
process.exit(0);
