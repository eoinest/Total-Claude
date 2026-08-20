/** Mean |Δluma| between two JPEGs, 0..255. Decoded in a browser because nothing here has a
 *  JPEG decoder in Node. `node tools/scratch/trailer-framediff.mjs a.jpg b.jpg [...]` */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const pairs = [];
for (let i = 2; i < process.argv.length; i += 2) pairs.push([process.argv[i], process.argv[i + 1]]);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
for (const [a, b] of pairs) {
  const [ab, bb] = [await readFile(a), await readFile(b)];
  const d = await page.evaluate(async ({ x, y }) => {
    const dec = async (s) => createImageBitmap(await (await fetch('data:image/jpeg;base64,' + s)).blob());
    const [ia, ib] = [await dec(x), await dec(y)];
    const px = (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
    };
    const pa = px(ia), pb = px(ib);
    let s = 0, mx = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const la = 0.2126 * pa[i] + 0.7152 * pa[i + 1] + 0.0722 * pa[i + 2];
      const lb = 0.2126 * pb[i] + 0.7152 * pb[i + 1] + 0.0722 * pb[i + 2];
      const q = Math.abs(la - lb); s += q; if (q > mx) mx = q;
    }
    return { mean: s / (pa.length / 4), max: mx, w: ia.width, h: ia.height };
  }, { x: ab.toString('base64'), y: bb.toString('base64') });
  console.log(`${a}\n${b}\n  mean |dluma| ${d.mean.toFixed(3)}  max ${d.max.toFixed(0)}  ${d.w}x${d.h}`);
}
await browser.close();
