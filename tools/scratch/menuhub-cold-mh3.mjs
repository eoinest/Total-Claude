import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 5396;
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', TC_NO_HMR: '1' } });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const wait = async () => { for (let i = 0; i < 200; i++) { try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 300)); } return false; };
console.log('server up:', await wait());
const browser = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--hide-scrollbars'] });
const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type() !== 'log') console.log('CONSOLE.' + m.type(), m.text().slice(0, 300)); });
const t0 = Date.now();
await p.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
console.log('dcl in', Date.now() - t0, 'ms');
try {
  await p.waitForSelector('.menu.at-home .dest-battle', { timeout: 90000 });
  console.log('menu visible in', Date.now() - t0, 'ms');
} catch (e) {
  console.log('TIMEOUT', Date.now() - t0, 'ms');
  console.log(await p.evaluate(() => ({ kids: document.getElementById('menu-root')?.children.length, html: document.body.innerHTML.slice(0, 400) })));
}
console.log('--- server log ---\n' + log.slice(0, 1500));
await browser.close(); srv.kill('SIGTERM');
