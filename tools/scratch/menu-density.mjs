/**
 * Throwaway: how many device pixels the backdrop is actually painted across, and how many
 * it has.
 *
 * The question this answers is the one the CSS comment in `src/ui/menu.css` got half right.
 * That comment computes the backdrop's total over-scale — `object-fit: cover`, then
 * `.bd-travel`'s vantage, then `.bd-drift`'s wander — and concludes the frame is soft by
 * about 1.55x. It does the whole sum in CSS pixels. On a 2x display every one of those CSS
 * pixels is two device pixels, and the browser's `srcset` picker knows it even if the
 * comment does not.
 *
 * So this measures, per (viewport, devicePixelRatio) arm:
 *   - `devicePixelRatio` as the page sees it
 *   - the `.bd-img` layout box, and the size `object-fit: cover` paints the frame at inside it
 *   - the live transform scales on `.bd-travel` and `.bd-drift`
 *   - `img.currentSrc` and `naturalWidth` — which rendition the browser actually chose
 *   - the upscale: painted device pixels / natural pixels
 *
 *   node tools/scratch/menu-density.mjs --port=5623
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5623);
const SCREENS = (args.get('screens') ?? 'home,setup').split(',');

/** Real machines, named by what they are rather than by their numbers. */
const ARMS = [
  { id: '1366x768 @1  budget laptop', w: 1366, h: 768, dpr: 1 },
  { id: '1600x1000 @1 the old measurement', w: 1600, h: 1000, dpr: 1 },
  { id: '1920x1080 @1 external 1080p', w: 1920, h: 1080, dpr: 1 },
  { id: '1512x982 @2  14-inch MacBook Pro', w: 1512, h: 982, dpr: 2 },
  { id: '1728x1117 @2 16-inch MacBook Pro', w: 1728, h: 1117, dpr: 2 },
  { id: '1440x900 @2  MacBook Air, default', w: 1440, h: 900, dpr: 2 },
  { id: '1920x1080 @2 external 4K, Retina', w: 1920, h: 1080, dpr: 2 },
];

const vite = await startVite({ port: PORT, root: ROOT, label: 'menu-density' });
const browser = await launchBrowser({ label: 'menu-density', port: PORT, root: ROOT });
const byScreen = new Map();
try {
 for (const SCREEN of SCREENS) {
  const rows = [];
  byScreen.set(SCREEN, rows);
  for (const a of ARMS) {
    const page = await browser.newPage({
      viewport: { width: a.w, height: a.h },
      deviceScaleFactor: a.dpr,
    });
    await page.goto(`${vite.base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.menu.at-home .dest-battle');
    if (SCREEN === 'setup') {
      await page.click('.menu-home .dest-battle');
      await page.waitForSelector('.menu.at-setup .begin');
    }
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => {
      const img = document.querySelector('.bd-slot.on .bd-img');
      const src = document.querySelector('.bd-slot.on source[type="image/avif"]');
      if (!img) return null;
      /*
       * `getBoundingClientRect` on the `<img>` is the **painted** box: it already has
       * `.bd-travel`'s vantage scale and `.bd-drift`'s wander folded in, because both are
       * transforms on ancestors. So the two scales are read out separately only to name
       * where the box came from — multiplying by them again is the double count this
       * probe made on its first run.
       */
      const box = img.getBoundingClientRect();
      const scaleOf = (el) => {
        if (!el) return 1;
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return Math.hypot(m.a, m.b) || 1;
      };
      const travel = scaleOf(document.querySelector('.bd-slot.on .bd-travel'));
      const drift = scaleOf(document.querySelector('.bd-slot.on .bd-drift'));
      // `object-fit: cover`: the frame is scaled up until it covers the box on both axes,
      // so the frame is drawn wider than the box whenever the box is taller than 16:9.
      const nat = { w: img.naturalWidth, h: img.naturalHeight };
      const cover = nat.w && nat.h ? Math.max(box.width / nat.w, box.height / nat.h) : 0;
      return {
        dpr: window.devicePixelRatio,
        boxW: +box.width.toFixed(1),
        boxH: +box.height.toFixed(1),
        // The CSS width the frame itself is drawn at, transforms and `cover` included.
        drawnW: +(nat.w * cover).toFixed(1),
        travel: +travel.toFixed(3),
        drift: +drift.toFixed(3),
        stillOnly: !!document.querySelector('.menu-bg')?.classList.contains('bd-still-only'),
        src: (img.currentSrc || img.getAttribute('src') || '').split('/').pop(),
        natW: nat.w,
        natH: nat.h,
        /*
         * Off the `<source>`, not the `<img>`. The backdrop is a `<picture>` now — the AVIF
         * ladder and its `sizes` live on the source and the `<img>` carries only the single
         * WebP fallback, so reading them off the `<img>` reports `null` and an empty ladder
         * while the browser is in fact resolving both correctly.
         */
        sizes: (src && src.getAttribute('sizes')) || img.getAttribute('sizes'),
        srcsetWidths: ((src && src.getAttribute('srcset')) || img.getAttribute('srcset') || '')
          .split(',').map((s) => s.trim().split(/\s+/)[1]).filter(Boolean).join('/'),
      };
    });
    await page.close();
    if (!r) { console.log(`${a.id}: no plate`); continue; }
    // Device pixels the frame is painted across, at the vantage this screen sits at.
    const paintedW = r.drawnW * r.dpr;
    /*
     * **`naturalWidth` is not the file's width.** For a `srcset` with `w` descriptors the
     * browser gives the `<img>` an intrinsic *density* of `candidateWidth / sizesWidth` and
     * reports `naturalWidth` already divided by it — so a 1,440 px file chosen for a 1,366 px
     * `sizes` reports 1,366, and a 1,920 px file chosen for a 1,440 px `sizes` reports 1,440.
     * Reading the real width off the filename is the only honest source here, and mistaking
     * the two is what made this probe's second run quote 3.37x for the hero when the hero was
     * in fact at 2.53x and the number belonged to every *other* frame in the set.
     */
    const realW = Number(/-(\d+)\.(?:webp|avif|jpg|png)$/.exec(r.src)?.[1]) || r.natW;
    const upscale = realW ? paintedW / realW : 0;
    // The `cover` factor on its own, i.e. before the vantage and the wander.
    const coverOnly = r.drawnW / (r.travel * r.drift) / a.w;
    rows.push({
      ...a, ...r, coverOnly: +coverOnly.toFixed(3), realW,
      paintedW: Math.round(paintedW), upscale: +upscale.toFixed(2),
    });
  }
 }
} finally {
  await browser.close();
  await vite.close();
}

const cell = (s, n) => String(s).padEnd(n);
/**
 * The widest rendition **every** frame has, which is the ceiling the rest of the set lives
 * under while only the hero reaches higher. Read off the manifest rather than off the one
 * plate the front door happens to be showing.
 */
const mf = JSON.parse(await readFile(path.join(ROOT, 'public/press/manifest.json'), 'utf8'));
const commonTop = Math.min(...mf.frames.map((f) => Math.max(...f.renditions.map((r) => r.w))));

for (const [screen, rows] of byScreen) {
  if (!rows.length) continue;
  console.log(`\n  screen=${screen}   sizes="${rows[0].sizes}"   renditions=${rows[0].srcsetWidths}`);
  console.log(`  motion: ${rows.every((r) => r.stillOnly) ? 'refused on every arm (drift = 1.000)'
    : rows.some((r) => r.stillOnly) ? 'refused on some arms' : 'granted'}\n`);
  console.log(`  ${cell('arm', 32)}|${cell(' cover', 8)}|${cell(' travel', 8)}|${cell(' drift', 8)}`
    + `|${cell(' drawn css', 11)}|${cell(' painted dev px', 16)}|${cell(' chosen', 28)}`
    + `|${cell(' real px', 9)}| upscale`);
  for (const r of rows) {
    console.log(`  ${cell(r.id, 32)}|${cell(` ${r.coverOnly.toFixed(3)}`, 8)}`
      + `|${cell(` ${r.travel.toFixed(3)}`, 8)}|${cell(` ${r.drift.toFixed(3)}`, 8)}`
      + `|${cell(` ${Math.round(r.drawnW)}`, 11)}|${cell(` ${r.paintedW}`, 16)}`
      + `|${cell(` ${r.src}`, 28)}|${cell(` ${r.realW}`, 9)}| ${r.upscale.toFixed(2)}x`);
  }
  const worst = rows.reduce((a, b) => (b.upscale > a.upscale ? b : a), rows[0]);
  console.log(`  worst rendition-as-shipped: ${worst.id.trim()} — ${worst.paintedW} device px `
    + `across a ${worst.realW} px frame, ${worst.upscale.toFixed(2)}x`);
  /*
   * Only the hero has a 1,920 rendition. Every other frame in the set stops at the width all
   * nine share, so on any arm that reached past it the rest of the set is worse than the row
   * above by exactly the ratio of the two — stated rather than measured a second time,
   * because `srcset` picking is not a per-frame taste.
   */
  const capped = rows.filter((r) => r.realW > commonTop);
  if (capped.length && commonTop) {
    const w = capped.reduce((a, b) => (b.paintedW > a.paintedW ? b : a), capped[0]);
    console.log(`  worst for the OTHER eight, which stop at ${commonTop}: ${w.id.trim()} — `
      + `${(w.paintedW / commonTop).toFixed(2)}x`);
  }
}
console.log('');

