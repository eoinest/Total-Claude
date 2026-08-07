#!/usr/bin/env node
/**
 * Which commit put the assault camera over 220 draw calls.
 *
 * Draw calls are the right metric for a bisect on this machine and frame time is not: the
 * count is deterministic and load-independent, so a run under contention gives the same
 * answer as a quiet one. Frame time on this project has measured an *unchanged* tree slower
 * than a changed one.
 *
 * Each commit is checked out into a scratch worktree, served by its own vite on its own
 * port, and booted headless. The camera is the scenario's own boot framing at t=0, which is
 * what "the assault camera" has always meant, and the tier is walked so a tier-only
 * regression cannot hide behind ultra.
 *
 *   node tools/bisect-draws.mjs --port=5478 --tree=/private/tmp/tc-bisect --shas=a,b,c
 */

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5478);
const TREE = args.get('tree') ?? '/private/tmp/tc-bisect';
const SHAS = String(args.get('shas') ?? '').split(',').filter(Boolean);
const TIERS = String(args.get('tiers') ?? 'ultra').split(',');
const SCENARIO = args.get('scenario') ?? 'assault';
const W = 1280;
const H = 720;
if (!SHAS.length) throw new Error('--shas is required');

const base = `http://127.0.0.1:${PORT}`;
const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
if (await up(800)) throw new Error(`port ${PORT} is already serving something — pick another`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

console.log(`# assault boot camera, ${W}x${H}, scenario=${SCENARIO}, tiers ${TIERS.join('/')}`);
console.log(`sha       ${TIERS.map((t) => t.padStart(7)).join('')}   subject`);

for (const sha of SHAS) {
  execFileSync('git', ['-C', TREE, 'checkout', '--detach', '--force', sha], { stdio: 'ignore' });
  const subject = execFileSync('git', ['-C', TREE, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  // A fresh vite per commit. Reusing one risks serving a stale module graph, and this
  // project has already lost a day to a probe that measured someone else's checkout.
  const server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: TREE, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  const cells = [];
  let note = '';
  try {
    if (!(await up(90000))) throw new Error('vite did not start');
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${base}/?harness=1&quality=${TIERS[0]}&w=${W}&h=${H}&scenario=${SCENARIO}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 200000 });
    for (const t of TIERS) {
      const n = await page.evaluate((tier) => {
        const g = window.__game;
        g.engine.setQuality(tier);
        g.engine.time.paused = true;
        for (let i = 0; i < 8; i++) g.engine.advance(1 / 60);
        return g.engine.renderer.info.render.calls;
      }, t);
      cells.push(n);
    }
    if (errs.length) note = `  !! ${errs[0].slice(0, 60)}`;
    await page.close();
  } catch (e) {
    note = `  !! ${String(e.message).slice(0, 70)}`;
  } finally {
    server.kill('SIGTERM');
    // Wait for the port to actually free, or the next commit's vite hits strictPort.
    for (let i = 0; i < 40 && (await up(150)); i++) { /* draining */ }
  }
  const cellStr = TIERS.map((_, i) => String(cells[i] ?? '-').padStart(7)).join('');
  const worst = Math.max(...cells.filter(Number.isFinite), 0);
  console.log(`${sha.slice(0, 8)}${cellStr}  ${worst > 220 ? 'OVER ' : '     '}${subject.slice(0, 66)}${note}`);
}

await browser.close();
