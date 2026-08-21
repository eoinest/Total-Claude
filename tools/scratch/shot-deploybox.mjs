#!/usr/bin/env node
/**
 * Four frames over the ground §15 task 14 widened, framed on the army rather than on the
 * cameras that were surveyed against x 0.
 *
 *   node tools/scratch/shot-deploybox.mjs --port=5932 --out=screenshots/deploy-boxes
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5932);
const OUT = path.resolve(args.get('out') ?? 'screenshots/deploy-boxes');
await mkdir(OUT, { recursive: true });

const VIEWS = {
  line: { x: 351, z: 128, zoom: 0.16, yaw: Math.PI * 1.42, desc: 'the Roman line, eye level' },
  wing: { x: 690, z: 60, zoom: 0.30, yaw: Math.PI * 1.0, desc: 'the far right wing, new ground' },
  wide: { x: 351, z: 90, zoom: 0.95, yaw: Math.PI * 0.82, desc: 'both lines, strategic' },
  east: { x: 700, z: -190, zoom: 0.55, yaw: Math.PI * 0.5, desc: "the host's right, along the box" },
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&w=1600&h=900`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(() => {
  window.__game.engine.stop();
  const canvas = window.__game.engine.ctx.renderer.domElement;
  for (const el of document.querySelectorAll('body > *')) {
    if (el !== canvas && !el.contains(canvas)) el.style.display = 'none';
  }
});
for (const [name, v] of Object.entries(VIEWS)) {
  await page.evaluate(async (vv) => {
    const g = window.__game;
    g.setCamera(vv.x, vv.z, vv.zoom, vv.yaw);
    g.advance(0.4);
    for (let i = 0; i < 20; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
  }, v);
  await writeFile(path.join(OUT, `${name}.png`), await page.screenshot({ type: 'png' }));
  console.log(`  ✓ ${name.padEnd(6)} ${v.desc}`);
}
await browser.close();
