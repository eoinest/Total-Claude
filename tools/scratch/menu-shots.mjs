/**
 * Throwaway: what the menu screens look like and how many words are on them.
 *
 * One run gives the before/after evidence this pass has to report — a PNG per screen per
 * viewport, and a word count taken off the rendered DOM rather than off the source, so
 * `&middot;` and `&mdash;` are counted as the characters a reader sees.
 *
 *   node tools/scratch/menu-shots.mjs --out=screenshots/menu-before --port=5611
 */
import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5611);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/menu-before');
const LABEL = args.get('label') ?? path.basename(OUT);
/** Long enough for a deferred backdrop to have arrived, so the shot is the settled screen. */
const SETTLE = Number(args.get('settle') ?? 6000);

/** Visible words in a subtree, as a reader meets them. `.sr-only` is not on screen. */
const COUNT = `(sel) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let words = 0; const bits = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!el.closest(sel)) continue;
    const t = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    const w = t.split(' ').filter((s) => /[A-Za-z0-9]/.test(s));
    words += w.length;
    if (w.length) bits.push(t);
  }
  return { words, text: bits.join(' | ') };
}`;

const VIEWS = [
  { id: 'wide', width: 1600, height: 1000 },
  { id: 'narrow', width: 1024, height: 800 },
];

await mkdir(OUT, { recursive: true });
const vite = await startVite({ port: PORT, root: ROOT, label: 'menu-shots' });
const browser = await launchBrowser({ label: 'menu-shots', port: PORT, root: ROOT });
const report = { label: LABEL, base: vite.base, shots: [] };
try {
  for (const v of VIEWS) {
    const page = await browser.newPage({ viewport: { width: v.width, height: v.height } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

    await page.goto(`${vite.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .menu-home', { timeout: 60000 });
    await page.waitForTimeout(SETTLE);
    const home = await page.evaluate(new Function(`return (${COUNT})`)(), '.menu-home');
    await page.screenshot({ path: path.join(OUT, `home-${v.id}.png`) });
    report.shots.push({ screen: 'home', view: v.id, ...home });

    await page.click('.menu-home .dest-battle');
    await page.waitForSelector('.menu.at-setup .begin', { timeout: 60000 });
    await page.waitForTimeout(SETTLE);
    const setup = await page.evaluate(new Function(`return (${COUNT})`)(), '.menu-setup');
    await page.screenshot({ path: path.join(OUT, `setup-${v.id}.png`) });
    report.shots.push({ screen: 'setup', view: v.id, ...setup });

    // The assault on Carthage: the one that changes the most copy on the screen.
    await page.click('.menu [data-map="carthage"]');
    await page.click('.menu [data-scen="assault"]');
    await page.waitForTimeout(SETTLE);
    const storm = await page.evaluate(new Function(`return (${COUNT})`)(), '.menu-setup');
    await page.screenshot({ path: path.join(OUT, `setup-carthage-assault-${v.id}.png`) });
    report.shots.push({ screen: 'setup-carthage-assault', view: v.id, ...storm });

    report.shots.at(-1).errors = errs.slice(0, 8);
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}

const total = (screen) => report.shots.filter((s) => s.view === 'wide' && s.screen === screen)[0];
report.summary = {
  homeWords: total('home')?.words ?? null,
  setupWords: total('setup')?.words ?? null,
  stormWords: total('setup-carthage-assault')?.words ?? null,
};
await writeFile(path.join(OUT, 'words.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`shots + words.json -> ${OUT}`);
