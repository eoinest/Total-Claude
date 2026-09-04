/**
 * Throwaway: the backdrop's degrade matrix, asserted rather than asserted-to.
 *
 * Four devices, one browser, one page each. Every arm checks the same three things — a plate
 * arrived, motion is on or off as it should be, and nothing was logged — because "it degrades"
 * is the kind of claim that is true in the source and false in the browser.
 *
 *   node tools/scratch/menu-degrade.mjs --port=5621
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5621);

const ARMS = [
  { id: 'desktop', w: 1600, h: 1000, reduced: 'no-preference', wantMotion: true, wantPlate: true },
  { id: 'reduced-motion', w: 1600, h: 1000, reduced: 'reduce', wantMotion: false, wantPlate: true },
  { id: 'narrow-1000', w: 1000, h: 800, reduced: 'no-preference', wantMotion: false, wantPlate: true },
  { id: 'narrow-1099', w: 1099, h: 800, reduced: 'no-preference', wantMotion: false, wantPlate: true },
];

const vite = await startVite({ port: PORT, root: ROOT, label: 'menu-degrade' });
const browser = await launchBrowser({ label: 'menu-degrade', port: PORT, root: ROOT });
let bad = 0;
try {
  for (const a of ARMS) {
    const page = await browser.newPage({ viewport: { width: a.w, height: a.h } });
    await page.emulateMedia({ reducedMotion: a.reduced });
    const logs = [];
    page.on('pageerror', (e) => logs.push(`pageerror: ${String(e.message).split('\n')[0]}`));
    page.on('console', (m) => { if (m.type() === 'error') logs.push(`console: ${m.text()}`); });
    await page.goto(`${vite.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .dest-battle');
    await page.waitForTimeout(2800);
    const r = await page.evaluate(() => {
      const bg = document.querySelector('.menu-bg');
      const on = document.querySelector('.bd-slot.on .bd-img');
      const drift = document.querySelector('.bd-slot.on .bd-drift');
      const travel = document.querySelector('.bd-slot.on .bd-travel');
      const sheet = document.querySelector('.menu-home');
      return {
        stillOnly: !!bg?.classList.contains('bd-still-only'),
        plate: on ? (on.currentSrc || on.getAttribute('src') || '') : '',
        complete: on ? on.complete && on.naturalWidth > 0 : false,
        naturalW: on ? on.naturalWidth : 0,
        drift: drift ? getComputedStyle(drift).animationName : 'n/a',
        travelTransition: travel ? getComputedStyle(travel).transitionDuration : 'n/a',
        scrim: getComputedStyle(document.querySelector('.bd-scrim')).getPropertyValue('--bd-scrim').trim(),
        sheetBlur: sheet ? getComputedStyle(sheet).backdropFilter : 'n/a',
      };
    });
    const motionOn = r.drift !== 'none' && r.drift !== 'n/a';
    const okPlate = a.wantPlate === (r.complete && r.naturalW > 0);
    const okMotion = a.wantMotion === motionOn;
    const okQuiet = logs.length === 0;
    if (!okPlate || !okMotion || !okQuiet) bad += 1;
    console.log(`${okPlate && okMotion && okQuiet ? 'PASS' : 'FAIL'}  ${a.id.padEnd(15)} `
      + `plate=${path.basename(r.plate) || 'none'} ${r.naturalW}px  drift=${r.drift}  `
      + `travel=${r.travelTransition}  scrim=${r.scrim}  stillOnly=${r.stillOnly}  `
      + `blur=${r.sheetBlur === 'none' ? 'none' : 'on'}`);
    for (const l of logs) console.log(`      ${l}`);
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(bad === 0 ? '\nall arms green' : `\n${bad} arm(s) red`);
process.exit(bad === 0 ? 0 : 1);
