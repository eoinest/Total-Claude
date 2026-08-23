#!/usr/bin/env node
/**
 * Reproduce the freeze the owner hit: a lockstep client whose socket goes away mid-battle.
 *
 * `tools/qa-net.mjs`'s `leave` arm covers the *peer* closing its page — the relay tells the
 * survivor and the survivor halts by name. This is the other half and nothing covers it:
 * **this** client's transport fails. A relay restart, a wifi blip, a laptop waking up. The
 * relay sends nothing because the relay is what is gone.
 *
 * Two clients, one room, into the battle, then kill the relay. Watch the clock.
 */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { bootThroughMenu } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = Number(arg('port', 5943));
const RELAY = Number(arg('relay', 5993));
const MODE = arg('mode', 'kill-relay');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startRelay = async () => {
  const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${RELAY}`,
    `--parent=${process.pid}`, '--quiet'], { stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${RELAY}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return p;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('relay never came up');
};

const INSTALL = () => {
  window.__probe = () => {
    const t = window.__game?.engine?.time;
    const n = window.__game?.net;
    return {
      tick: t.tick, ceiling: t.tickCeiling, paused: t.paused, speed: t.gameSpeed,
      scaledDt: +t.scaledDt.toFixed(4), elapsed: +t.elapsed.toFixed(2),
      net: n ? { phase: n.status().phase, ended: n.status().ended, msg: n.status().message,
        got: n.status().got, turn: n.status().turn } : null,
      onScreen: Array.from(document.querySelectorAll('.hud, .hud *'))
        .map((e) => (e.textContent ?? '').trim())
        .filter((s) => /froz|stall|lost|discon|link|relay|no longer/i.test(s)).slice(0, 3),
    };
  };
};

const deployIfAsked = async (page, tag) => {
  const has = await page.evaluate(() => !!document.querySelector('.dep-begin'));
  if (!has) return;
  await page.click('.dep-begin');
  console.log(`  ${tag}: committed`);
};

const main = async () => {
  const { base, close } = await startVite({ port: PORT, root: ROOT, label: 'freeze-net' });
  const relay = await startRelay();
  const browser = await launchBrowser({ label: 'freeze-net', port: PORT, root: ROOT });
  const room = 'FRZAB';
  const q = `net=${encodeURIComponent(`ws://127.0.0.1:${RELAY}`)}&room=${room}`
    + '&autoplay=1&deploy=0';

  const host = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [];
  host.on('pageerror', (e) => errs.push(String(e.message ?? e)));
  await bootThroughMenu(host, {
    base, map: 'campus-martius', scenario: 'field', tier: 'low', size: 'small', query: q,
  });
  const guest = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
  await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await host.evaluate(INSTALL);
  await guest.evaluate(INSTALL);
  await deployIfAsked(host, 'host');
  await deployIfAsked(guest, 'guest');

  for (const [n, p] of [['host', host], ['guest', guest]]) {
    await p.waitForFunction(() => window.__game.net.status().phase === 'battle',
      null, { timeout: 90000 }).catch(() => console.log(`  ${n}: never reached battle`));
  }
  await sleep(3000);
  console.log('in battle   host', JSON.stringify(await host.evaluate(() => window.__probe())));

  if (MODE === 'kill-relay') {
    console.log('--- killing the relay ---');
    relay.kill('SIGKILL');
  } else if (MODE === 'close-socket') {
    // The purest transport failure: this client's own socket goes, nobody else's.
    console.log('--- closing the host socket from inside the page ---');
    await host.evaluate(() => {
      const l = window.__game.net.link ?? null;
      // No public handle; reach the one live socket the page holds.
      const ws = window.__tcws;
      if (ws) ws.close();
      void l;
    });
  }
  await sleep(1500);
  const a = await host.evaluate(() => window.__probe());
  await sleep(4000);
  const b = await host.evaluate(() => window.__probe());
  console.log('after +1.5s host', JSON.stringify(a));
  console.log('after +5.5s host', JSON.stringify(b));
  console.log(`VERDICT: sim ${b.tick - a.tick > 0 ? 'RUNNING' : 'FROZEN'} `
    + `(+${b.tick - a.tick} ticks over ${(b.elapsed - a.elapsed).toFixed(2)}s wall, `
    + `paused=${b.paused} ceiling=${b.ceiling} tick=${b.tick} scaledDt=${b.scaledDt})`);
  console.log(`  told the player: ended=${JSON.stringify(b.net?.ended)} `
    + `msg=${JSON.stringify(b.net?.msg)} onScreen=${JSON.stringify(b.onScreen)}`);
  if (errs.length) console.log('  pageerrors:', errs.slice(0, 4));

  await browser.close();
  try { relay.kill('SIGKILL'); } catch { /* gone */ }
  await close();
};

main().catch((e) => { console.error(e); process.exit(1); });
