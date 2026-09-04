/**
 * Throwaway: inside `terrain.init`'s 2.2 s block — which part is it?
 *
 * The block, not the duration, is what decides whether a live backdrop is possible, and
 * `terrain.init` is the only phase whose block is measured in seconds. If it is the
 * heightfield it is a resolution knob; if it is grass and scatter it is a content knob;
 * if it is texture upload it is neither.
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5615);
const vite = await startVite({ port: PORT, root: ROOT, label: 'terrain-split' });
const browser = await launchBrowser({ label: 'terrain-split', port: PORT, root: ROOT });
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).split('\n')[0]));
  await page.goto(`${vite.base}/?menu=0&autoplay=0&harness=1&w=320&h=200`, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const maps = await import('/src/maps/index.ts');
    const clip = await import('/src/terrain/clipmap.ts').catch(() => null);
    const rows = [];
    for (const id of ['campus-martius', 'carthage', 'pydna']) {
      const m = maps.getMap(id);
      const a = performance.now();
      const d = m.terrain.build(m.terrain.seedLabel);
      const buildMs = performance.now() - a;
      const b = performance.now();
      const d2 = m.terrain.build(m.terrain.seedLabel);
      const rebuildMs = performance.now() - b;
      rows.push({ id, buildMs: Math.round(buildMs), rebuildMs: Math.round(rebuildMs),
        res: d.res, spacing: d.spacing, controlRes: d.controlRes, cells: d.res * d.res });
    }
    let clipMs = null;
    if (clip && clip.buildClipmapGeometry) {
      const c = performance.now(); clip.buildClipmapGeometry(); clipMs = Math.round(performance.now() - c);
    }
    return { rows, clipMs };
  });
  console.log(JSON.stringify(out, null, 2));
  await page.close();
} finally {
  await browser.close();
  await vite.close();
}
