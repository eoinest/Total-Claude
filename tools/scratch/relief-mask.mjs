#!/usr/bin/env node
/** Scratch: print the floodplain mask and the built height on a grid. Not a gate. */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5968);
const ROOT = path.resolve(import.meta.dirname, '../..');
const { base, server } = await startVite({ port: PORT, root: ROOT, label: 'relief-mask' });
const browser = await launchBrowser({ label: 'relief-mask', port: PORT, root: ROOT });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(`${base}/?harness=1&map=campus-martius&scenario=assault&quality=ultra&w=640&h=480`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  const out = await page.evaluate(async () => {
    const topo = await import('/src/terrain/topography.ts');
    const eng = window.__game.engine;
    const rows = [];
    for (const z of [600, 700, 800, 900, 1000, 1100, 1200, 1300]) {
      const line = [];
      for (const x of [-300, -150, 0, 100, 200, 300, 400, 500]) {
        const n = (1245.496 - z) / 0.35;
        const toe = topo.plainToeAt(n);
        line.push({
          x, z,
          n: +n.toFixed(0),
          toeE: +toe.e.toFixed(0),
          run: +toe.run.toFixed(0),
          toeX: +(292.171 + 0.443 * toe.e).toFixed(0),
          mask: +topo.floodplainMask(x, z).toFixed(3),
          y: +eng.rig.heightAt(x, z).toFixed(2),
          riv: +Math.abs(topo.riverOffset(x, z)).toFixed(0),
        });
      }
      rows.push(line);
    }
    return rows;
  });
  const cols = ['x', 'z', 'n', 'toeE', 'run', 'toeX', 'mask', 'y', 'riv'];
  console.log(cols.join('\t'));
  for (const line of out) for (const r of line) console.log(cols.map((c) => r[c]).join('\t'));
} finally { await browser.close(); await server?.close?.(); }
