#!/usr/bin/env node
/** Throwaway: at what viewport width does BEGIN BATTLE stop fitting on screen? */
import path from 'node:path';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 5952;
const vite = await startVite({ port: PORT,
  root: ROOT,
  label: 'hud-width',
  cacheDir: '/tmp/tc-vite-hudwidth' });
const url = `${vite.base}/?menu=0&deploy=1&battle=map%3Dcampus-martius%26scenario%3Dfield&quality=low`;

for (const engine of ['chromium']) {
  const b = await launchBrowser({ label: `hud-width/${engine}`, engine, port: PORT, root: ROOT });
  for (const [w, h] of [[1040, 800], [1060, 800], [1070, 800], [1080, 800], [1100, 800], [1120, 800], [1160, 800]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 90)); });
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('.dep-begin', { timeout: 120000 });
      const r = await p.evaluate(() => {
        const el = document.querySelector('.dep-begin');
        const q = el.getBoundingClientRect();
        return {
          right: Math.round(q.right),
          vw: innerWidth,
          fits: q.right <= innerWidth && q.x >= 0,
          scrollW: document.documentElement.scrollWidth,
          coarse: matchMedia('(pointer: coarse)').matches,
        };
      });
      console.log(`${engine} ${String(w).padStart(4)}x${h}  begin.right=${String(r.right).padStart(5)}`
        + ` vw=${r.vw} fits=${r.fits} scrollW=${r.scrollW} coarse=${r.coarse}`
        + ` errs=${errs.length}${errs[0] ? ` | ${errs[0]}` : ''}`);
    } catch (e) {
      console.log(`${engine} ${w}x${h}  FAILED ${String(e).slice(0, 110)}`);
    }
    await p.close();
  }
  await b.close();
}
await vite.close();
