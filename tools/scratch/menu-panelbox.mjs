/**
 * Throwaway: where the menu sheet actually falls **on the frame**, which is not where the
 * legibility measurement has been assuming it falls.
 *
 * `PANEL_BOX` in `tools/make-brand.mjs` is `{ x: 0.25, y: 0.14, w: 0.50, h: 0.72 }` — a box
 * centred on the middle of the frame — and `type.scrimForGold` in
 * `public/press/manifest.json` is the 95th-percentile luminance inside it. That box was
 * derived before `MenuBackdrop` existed, when a plate was going to be laid flat behind the
 * sheet.
 *
 * `MenuBackdrop` does not lay it flat. It scales the frame past the viewport and translates
 * it so that a chosen point of the *frame* sits at the centre of the *viewport* — `(0.5, 0.42)`
 * on the front door and `(0.46, 0.62)` on the setup screen — and then `object-fit: cover`
 * crops it again, by an amount that depends on the window's aspect. So the region of the frame
 * the sheet covers is centred on the vantage, is smaller than half the frame's width on a wide
 * window, and moves when the player goes deeper.
 *
 * A scrim measured over the wrong region is a scrim measured over the wrong pixels, and the
 * manifest already carries one warning about prose that disagreed with its own instrument.
 * This inverts the real transform chain in the live page and reports the box in frame
 * coordinates, per screen and per viewport, plus the union that a single number has to cover.
 *
 *   node tools/scratch/menu-panelbox.mjs --port=5624
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5624);

const ARMS = [
  { id: '1366x768 @1', w: 1366, h: 768, dpr: 1 },
  { id: '1512x982 @2', w: 1512, h: 982, dpr: 2 },
  { id: '1728x1117 @2', w: 1728, h: 1117, dpr: 2 },
  { id: '1920x1080 @1', w: 1920, h: 1080, dpr: 1 },
  { id: '1280x1024 @1', w: 1280, h: 1024, dpr: 1 },
  { id: '1100x900 @1', w: 1100, h: 900, dpr: 1 },
];

const vite = await startVite({ port: PORT, root: ROOT, label: 'menu-panelbox' });
const browser = await launchBrowser({ label: 'menu-panelbox', port: PORT, root: ROOT });
const rows = [];
try {
  for (const screen of ['home', 'setup']) {
    for (const a of ARMS) {
      const page = await browser.newPage({
        viewport: { width: a.w, height: a.h },
        deviceScaleFactor: a.dpr,
      });
      await page.goto(`${vite.base}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.menu.at-home .dest-battle');
      if (screen === 'setup') {
        await page.click('.menu-home .dest-battle');
        await page.waitForSelector('.menu.at-setup .begin');
      }
      await page.waitForTimeout(2600);
      const r = await page.evaluate((which) => {
        const img = document.querySelector('.bd-slot.on .bd-img');
        const sheet = document.querySelector(
          which === 'home' ? '.menu-home' : '.menu-setup');
        if (!img || !sheet || !img.naturalWidth) return null;
        /*
         * `getBoundingClientRect` on the `<img>` is the painted box — every ancestor
         * transform is already in it. Inside that box `object-fit: cover` scales the frame
         * up until it covers both axes and centres it, which is the last step to undo.
         */
        const box = img.getBoundingClientRect();
        const aspect = img.naturalWidth / img.naturalHeight;
        const contentW = Math.max(box.width, box.height * aspect);
        const contentH = contentW / aspect;
        const left = box.left + (box.width - contentW) / 2;
        const top = box.top + (box.height - contentH) / 2;
        const s = sheet.getBoundingClientRect();
        return {
          // The sheet, in fractions of the frame. Not clamped: a negative x means the sheet
          // runs off the side of the frame, which is a fact worth seeing rather than hiding.
          x: (s.left - left) / contentW,
          y: (s.top - top) / contentH,
          w: s.width / contentW,
          h: s.height / contentH,
          sheetPx: `${Math.round(s.width)}x${Math.round(s.height)}`,
        };
      }, screen);
      await page.close();
      if (!r) { console.log(`${screen} ${a.id}: no plate or no sheet`); continue; }
      rows.push({ screen, arm: a.id, ...r });
    }
  }
} finally {
  await browser.close();
  await vite.close();
}

const f = (n) => n.toFixed(3).padStart(7);
console.log(`\n  the sheet, in frame coordinates\n`);
console.log(`  ${'screen'.padEnd(7)}${'arm'.padEnd(15)}${'sheet px'.padEnd(11)}`
  + `${'x'.padStart(7)}${'y'.padStart(7)}${'w'.padStart(7)}${'h'.padStart(7)}`
  + `${'x2'.padStart(8)}${'y2'.padStart(8)}`);
for (const r of rows) {
  console.log(`  ${r.screen.padEnd(7)}${r.arm.padEnd(15)}${r.sheetPx.padEnd(11)}`
    + `${f(r.x)}${f(r.y)}${f(r.w)}${f(r.h)}${f(r.x + r.w)}${f(r.y + r.h)}`);
}
/*
 * The union is what one number has to cover, because `scrimForGold` is one number per frame
 * and the same frame is shown on every one of these machines and on both screens.
 */
const x0 = Math.max(0, Math.min(...rows.map((r) => r.x)));
const y0 = Math.max(0, Math.min(...rows.map((r) => r.y)));
const x1 = Math.min(1, Math.max(...rows.map((r) => r.x + r.w)));
const y1 = Math.min(1, Math.max(...rows.map((r) => r.y + r.h)));
console.log(`\n  union, clamped to the frame: `
  + `{ x: ${x0.toFixed(3)}, y: ${y0.toFixed(3)}, `
  + `w: ${(x1 - x0).toFixed(3)}, h: ${(y1 - y0).toFixed(3)} }`);
console.log(`  make-brand's PANEL_BOX today:  `
  + `{ x: 0.250, y: 0.140, w: 0.500, h: 0.720 }\n`);
