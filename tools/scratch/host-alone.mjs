#!/usr/bin/env node
/** One host, alone in a room, watched for 40 s. Does anything call the link dead? */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { ensureServer, bootThroughMenu } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 5941; const RELAY = 5977;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relays = []; const browsers = []; let server = null;
const cleanup = () => {
  for (const p of relays.splice(0)) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  for (const b of browsers.splice(0)) { void b.close().catch(() => {}); }
  if (server) server.kill('SIGTERM');
};
const die = (e) => { console.error(e); cleanup(); process.exit(1); };
process.on('uncaughtException', die); process.on('unhandledRejection', die);

const s = await ensureServer({ port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `play-${PORT}`) });
server = s.server;
const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${RELAY}`, `--parent=${process.pid}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
relays.push(p);
for (let i = 0; i < 60; i++) { const b = await fetch(`http://127.0.0.1:${RELAY}/health`).then((r) => r.text()).catch(() => ''); if (b.startsWith('relay ok')) break; await sleep(200); }
const ROOM = await fetch(`http://127.0.0.1:${RELAY}/new`).then((r) => r.json()).then((j) => j.room);

const A = await launchBrowser({ label: 'host-alone', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
browsers.push(A);
const ctx = await A.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); if (m.type() === 'warning' && /net/.test(m.text())) errs.push(`warn: ${m.text()}`); });

await bootThroughMenu(page, {
  base: s.base, map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small',
  query: `net=${encodeURIComponent(`ws://127.0.0.1:${RELAY}`)}&room=${ROOM}&autoplay=0&deploy=1`,
});
console.log(`host ready, alone in room ${ROOM}`);
for (let i = 0; i <= 20; i++) {
  const n = await page.evaluate(() => {
    const st = window.__game?.net?.status() ?? null;
    return st && { phase: st.phase, peer: st.peer, ended: st.ended, message: st.message, got: st.got, ceiling: st.ceiling };
  });
  const strip = await page.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)');
  console.log(`  t+${(i * 2).toString().padStart(2)}s ${JSON.stringify(n)}`);
  if (n?.ended) { console.log(`        STRIP: ${strip}`); }
  if (i === 20 || (n?.ended && i > 6)) {
    await page.screenshot({ path: path.join(ROOT, 'screenshots', 'two-commanders', '40-host-alone-linklost.png') });
    break;
  }
  await sleep(2000);
}
console.log('  page errors:', errs.slice(0, 6));
cleanup();
process.exit(0);
