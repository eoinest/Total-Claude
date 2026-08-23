#!/usr/bin/env node
/** Scratch: decompose Rome's baseHeight into its terms over the Campus Martius. Not a gate. */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5952);
const base = `http://127.0.0.1:${PORT}`;
const browser = await launchBrowser({ label: 'relief-terms', port: PORT, root: path.resolve(import.meta.dirname, '../..') });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(`${base}/?harness=1&map=campus-martius&scenario=assault&quality=ultra&w=640&h=480`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  const out = await page.evaluate(async () => {
    const topo = await import('/src/terrain/topography.ts');
    const noise = await import('/src/terrain/noise.ts');
    const { sstep, fbm, ridged, warpedFbm } = noise;
    const eng = window.__game.engine;
    const RISE_RUN = topo.RISE_RUN;
    const rows = [];
    const probe = (x, z) => {
      const plain = topo.regionalPlain(x, z);
      const toe = topo.riseToeZ(x);
      const amp = topo.riseAmplitude(x);
      const onHill = sstep(toe - 40, toe + RISE_RUN, z);
      const front = amp * sstep(toe, toe + RISE_RUN, z);
      const behind = sstep(toe + RISE_RUN, toe + RISE_RUN + 640, z) * 13;
      const north = sstep(-620, -1180, z) * sstep(-150, 520, x) * 21;
      const crestBand = sstep(toe + RISE_RUN - 30, toe + RISE_RUN + 420, z);
      const ridgeAmp = 6.5 + 21 * crestBand;
      const d = topo.riverOffset(x, z);
      return {
        x, z,
        built: +eng.rig.heightAt(x, z).toFixed(2),
        plain: +plain.toFixed(2),
        toe: +toe.toFixed(0),
        amp: +amp.toFixed(2),
        onHill: +onHill.toFixed(3),
        front: +front.toFixed(2),
        behind: +behind.toFixed(2),
        north: +north.toFixed(2),
        crestBand: +crestBand.toFixed(3),
        ridgeAmp: +ridgeAmp.toFixed(1),
        upland: +(onHill * (ridged(x, z, 4, 1 / 560, 0, 0.42) - 0.40) * ridgeAmp).toFixed(2),
        riverOffset: +d.toFixed(0),
      };
    };
    for (const z of [600, 700, 800, 900, 1000, 1100, 1200]) {
      for (const x of [-150, -50, 50, 100, 150, 250, 350]) rows.push(probe(x, z));
    }
    // the seed the terrain was built with is not exposed; upland is indicative only
    return rows;
  });
  const cols = ['x', 'z', 'built', 'plain', 'toe', 'amp', 'onHill', 'front', 'behind', 'north', 'crestBand', 'ridgeAmp', 'riverOffset'];
  console.log(cols.join('\t'));
  for (const r of out) console.log(cols.map((c) => r[c]).join('\t'));
} finally { await browser.close(); }
