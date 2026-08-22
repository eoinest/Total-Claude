#!/usr/bin/env node
/**
 * Screenshot `src/city/plan.html` — the engine's own plan view, from directly overhead.
 *
 * `src/city/plan.ts`'s docstring says why the view exists: *"a three-quarter camera cannot
 * answer 'is the Circus Maximus in the Vallis Murcia'… Rendering the plan as SVG at a known
 * scale makes it directly comparable with Lanciani's Forma Urbis Romae."* It was driven by
 * `shoot-city.mjs --shots=plan`, and that tool no longer exists, so the harness went with it
 * and the view has had no way to be looked at. This is the replacement, and it is four lines.
 *
 *   node tools/scratch/rome-planshot.mjs --port=5917 --out=screenshots/rome-fabric-p1
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5917));
const OUT = path.resolve(ROOT, arg('out', 'screenshots/rome-fabric-p1'));
const TAG = arg('tag', 'after');

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/src/city/plan.html`, { waitUntil: 'load', timeout: 180000 });
await page.waitForSelector('#wrap svg', { timeout: 180000 });
await page.waitForTimeout(4000);
const file = path.join(OUT, `02-engine-plan-${TAG}.png`);
await page.locator('#wrap').screenshot({ path: file });
console.log(`wrote ${file}`);
if (errs.length) console.warn('page errors:', errs.slice(0, 3));
await browser.close();
