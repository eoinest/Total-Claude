#!/usr/bin/env node
/**
 * The shortest path to "does any of this work at all": two browsers, one peer connection, one
 * battle, no menu and no deployment phase.
 *
 * Not a gate. `tools/qa-p2p.mjs` is the gate; this is the thing to run while writing it, because
 * a failure here is one page load rather than a five-minute arm.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { INSTALL } from '../lib/net-drive.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const PORT = Number(arg('port', 5955));
const RELAY = Number(arg('relay', 5956));
const SECONDS = Number(arg('seconds', 30));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${RELAY}`,
  `--parent=${process.pid}`, '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
await sleep(600);
const health = await fetch(`http://127.0.0.1:${RELAY}/health`).then((r) => r.text());
console.log(`relay: ${health.trim()}`);

const vite = await startVite({ port: PORT, root: ROOT, label: 'p2psmoke' });
const base = vite.base;
console.log(`vite: ${base}`);

const args = ['--disable-features=WebRtcHideLocalIpsWithMdns'];
const a = await launchBrowser({ label: 'scratch/p2psmoke-host', port: PORT, channel: 'chrome', args });
const b = await launchBrowser({ label: 'scratch/p2psmoke-guest', channel: 'chrome', args });

const mk = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`    HTTP ${r.status()} ${r.url()}`); });
  page.on('console', (m) => {
    if (m.type() === 'error') page.__errs.push(`console.error: ${m.text()}`);
    if (String(m.text()).startsWith('[net]')) console.log(`    ${m.text()}`);
  });
  return page;
};

const room = 'SMOKE'.replace(/O/g, 'Q');
const sig = `ws://127.0.0.1:${RELAY}`;
const q = `room=${room}&sig=${encodeURIComponent(sig)}&menu=0&deploy=0&autoplay=1&quality=medium`;

const host = await mk(a);
const guest = await mk(b);
console.log(`\nhost  -> ${base}/?${q}&host=1`);
console.log(`guest -> ${base}/?${q}&host=0\n`);
await host.goto(`${base}/?${q}&host=1`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });

let ok = true;
try {
  for (const [tag, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
    console.log(`${tag}: ready`);
  }
  await host.evaluate(INSTALL);
  await guest.evaluate(INSTALL);
  for (const [tag, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(
      () => ['deploy', 'battle'].includes(window.__net()?.phase), null, { timeout: 120000 });
    console.log(`${tag}: phase ${(await p.evaluate(() => window.__net())).phase}`);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(4000);
    const ha = await host.evaluate(() => ({ ...window.__mark(), net: window.__net() }));
    const ga = await guest.evaluate(() => ({ ...window.__mark(), net: window.__net() }));
    console.log(`  t=${((Date.now() - t0) / 1000).toFixed(0)}s  `
      + `host tick ${ha.tick} turn ${ha.net.turn} behind ${ha.net.behindTicks} `
      + `got ${ha.net.got} stalls ${ha.net.stalls} | `
      + `guest tick ${ga.tick} turn ${ga.net.turn} behind ${ga.net.behindTicks} got ${ga.net.got}`
      + `${ha.net.ended ? `  ENDED ${ha.net.ended}: ${ha.net.message}` : ''}`);
    if (ha.net.ended || ga.net.ended) { ok = false; break; }
  }
  const hm = await host.evaluate(() => window.__mark());
  const gm = await guest.evaluate(() => window.__mark());
  const same = hm.tick === gm.tick && hm.uf64 === gm.uf64 && hm.hash === gm.hash;
  console.log(`\nhost  tick ${hm.tick} uf64 ${hm.uf64} pool ${hm.hash} alive ${hm.alive}`);
  console.log(`guest tick ${gm.tick} uf64 ${gm.uf64} pool ${gm.hash} alive ${gm.alive}`);
  console.log(`same tick and state: ${same}`);
  const hd = await host.evaluate(() => window.__peer());
  const gd = await guest.evaluate(() => window.__peer());
  console.log(`\nhost  transport: ${JSON.stringify(hd?.selected)} opened@${hd?.openedMs}ms `
    + `rtt ${hd?.rttMs}ms candidates ${JSON.stringify(hd?.candidateTypes)} `
    + `iceErrors ${JSON.stringify(hd?.iceErrors)} signal ${hd?.signal} live ${hd?.signalLive}`);
  console.log(`host  peerRoom: ${JSON.stringify(hd?.peerRoom?.committed)} `
    + `turn ${hd?.peerRoom?.turn} beats ${hd?.peerRoom?.beats} commits ${hd?.peerRoom?.commitsOut}`);
  console.log(`guest transport: ${JSON.stringify(gd?.selected)} opened@${gd?.openedMs}ms `
    + `rtt ${gd?.rttMs}ms candidates ${JSON.stringify(gd?.candidateTypes)}`);
  const errs = [...host.__errs, ...guest.__errs];
  console.log(`\nconsole errors: ${errs.length ? errs.join('\n  ') : '(none)'}`);
  ok = ok && same && errs.length === 0;
} catch (e) {
  ok = false;
  console.log(`\nFAILED: ${e.message}`);
  for (const [tag, p] of [['host', host], ['guest', guest]]) {
    const n = await p.evaluate(() => window.__net?.() ?? null).catch(() => null);
    const d = await p.evaluate(() => window.__peer?.() ?? null).catch(() => null);
    console.log(`  ${tag} net: ${JSON.stringify(n)}`);
    console.log(`  ${tag} peer: ${JSON.stringify(d)}`);
    console.log(`  ${tag} errs: ${p.__errs.join(' | ') || '(none)'}`);
  }
} finally {
  await a.close();
  await b.close();
  await vite.close();
  relay.kill('SIGTERM');
}
console.log(ok ? '\nok' : '\nNOT OK');
process.exit(ok ? 0 : 1);
