#!/usr/bin/env node
/**
 * Does a page served over real HTTPS reach a plain `ws://` relay on the LAN?
 *
 * Not a hypothetical and not a self-signed approximation: the origin is the deployed site with
 * its real certificate, and the relay is `tools/relay.mjs` already bound to this machine's en0
 * address by `tools/host-lan.mjs`. Three attempts, because the answer differs between them.
 *
 *   node tools/scratch/https-ws-probe.mjs <lan-ip> <relay-port> [site]
 *
 * One browser slot.
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LAN = process.argv[2] ?? '192.168.0.238';
const PORT = Number(process.argv[3] ?? 5959);
const SITE = process.argv[4] ?? 'https://total-claude.vercel.app/';

const health = await fetch(`http://${LAN}:${PORT}/health`).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
console.log(`node says http://${LAN}:${PORT}/health -> ${health.trim()}`);

/*
 * `--no-lna` switches off Chrome's Local Network Access check, which is the *first* thing to
 * refuse these requests. With it off, whatever is left is the mixed-content rule on its own —
 * which is the question worth asking, because LNA is a permission a user could in principle
 * grant and mixed content is not.
 */
const NO_LNA = process.argv.includes('--no-lna');
const browser = await launchBrowser({
  label: 'https-ws-probe',
  root: ROOT,
  args: NO_LNA ? ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'] : [],
});
const page = await browser.newPage();
const lines = [];
page.on('console', (m) => lines.push(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));
await page.goto(SITE, { waitUntil: 'domcontentloaded' });

const res = await page.evaluate(async ({ lan, port }) => {
  const tryWs = (url) => new Promise((resolve) => {
    let ws;
    const t = setTimeout(() => {
      resolve({ url, outcome: 'no event in 6 s' });
      try { ws?.close(); } catch { /* gone */ }
    }, 6000);
    const t0 = performance.now();
    const done = (outcome) => { clearTimeout(t); resolve({ url, outcome, ms: Math.round(performance.now() - t0) }); };
    try { ws = new WebSocket(url); } catch (e) { done(`threw synchronously: ${e?.name}: ${e?.message}`); return; }
    ws.onopen = () => { done('OPEN'); ws.close(); };
    ws.onerror = () => done(`error event, readyState ${ws.readyState}`);
    ws.onclose = (ev) => done(`close code=${ev.code} clean=${ev.wasClean} reason='${ev.reason}'`);
  });
  const tryFetch = async (url) => {
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      return { url, outcome: `${r.status} ${(await r.text()).trim()}`, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { url, outcome: `${e?.name}: ${e?.message}`, ms: Math.round(performance.now() - t0) };
    }
  };
  return {
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    lanWs: await tryWs(`ws://${lan}:${port}/room/QAQQQ`),
    loopWs: await tryWs(`ws://127.0.0.1:${port}/room/QAQQQ`),
    lanFetch: await tryFetch(`http://${lan}:${port}/health`),
  };
}, { lan: LAN, port: PORT });

console.log(JSON.stringify(res, null, 2));
console.log('--- what the browser wrote ---');
for (const l of lines) console.log(l);
await browser.close();
