#!/usr/bin/env node
/**
 * pn2-doorcolour — what colour is the postern leaf actually baked with?
 *
 * `d497628` claims it inverted the leaf: light `PAL.timber` boards with dark
 * `PAL.timberDark` ledges, the reverse of the great gate. The two frames shot either side of
 * that commit are pixel-identical across the whole leaf, which cannot be true if the swap
 * landed. This reads the baked vertex colours straight off the chunk.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5603);
const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'assault', opponent: 2 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=960&h=540&quality=high&scenario=assault&battle=${token}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600000 });
const out = await page.evaluate(() => {
  const g = window.__game;
  const city = g.engine.context.tryGet('city');
  const res = [];
  city.root.traverse((n) => {
    if (!n.isMesh || !n.parent) return;
    const p = n.parent.name || '';
    if (!/^(postern-door-30|gate-door)-lod0$/.test(p)) return;
    const col = n.geometry.getAttribute('color');
    const counts = new Map();
    if (col) {
      for (let i = 0; i < col.count; i++) {
        const k = [col.getX(i), col.getY(i), col.getZ(i)].map((v) => v.toFixed(4)).join(',');
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    res.push({
      chunk: p, mesh: n.name, verts: col ? col.count : 0,
      hasColour: !!col,
      swatches: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      material: n.material?.name || n.material?.type,
      vertexColors: n.material?.vertexColors ?? null,
    });
  });
  return res;
});
for (const r of out) {
  console.log(`${r.chunk} / ${r.mesh}  verts ${r.verts}  vertexColors=${r.vertexColors}  mat=${r.material}`);
  for (const [k, n] of r.swatches) console.log(`    ${k}   x${n}`);
}
await browser.close();
