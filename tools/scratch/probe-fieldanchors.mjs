#!/usr/bin/env node
/**
 * Every map's field deployment, unit by unit, with page errors captured.
 *
 * The control for a change to `sim/scenario.ts`: two trees, three maps, and a diff. It boots
 * each map's field battle, stops the loop at t+0 so nothing has settled, and prints each
 * unit's anchor, facing, formation, width and spacing.
 *
 *   node tools/scratch/probe-fieldanchors.mjs --port=5341 --json=/tmp/anchors.json
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const base = `http://127.0.0.1:${Number(args.get('port') ?? 5341)}`;
const MAPS = (args.get('maps') ?? 'campus-martius,carthage,pydna').split(',');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const out = {};
for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('requestfailed', (r) => errs.push(`http: ${r.url().slice(-60)}`));
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540&map=${map}&scenario=field`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__game.engine.stop());
  out[map] = await page.evaluate(() => {
    const g = window.__game;
    const p = g.battle.pool;
    let men = 0, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < p.count; i++) {
      if (p.hp[i] <= 0) continue;
      men++;
      if (p.x[i] < minX) minX = p.x[i];
      if (p.x[i] > maxX) maxX = p.x[i];
    }
    return {
      men, xSpan: [+minX.toFixed(3), +maxX.toFixed(3)],
      units: g.battle.units.map((u) => ({
        id: u.id, type: u.typeId, faction: u.faction,
        x: +u.x.toFixed(4), z: +u.z.toFixed(4), facing: +u.facing.toFixed(6),
        targetX: +u.targetX.toFixed(4), order: u.order,
        formation: u.formationId, width: u.width,
        spacingX: +u.spacingX.toFixed(4), spacingZ: +u.spacingZ.toFixed(4), alive: u.alive,
      })),
    };
  });
  out[map].errors = errs;
  console.log(`${map.padEnd(16)} ${out[map].men} men, ${out[map].units.length} units, `
    + `x ${out[map].xSpan[0]}..${out[map].xSpan[1]}, ${errs.length} page error(s)`);
  for (const e of errs) console.log(`    ${e}`);
  await page.close();
}
if (args.get('json')) await writeFile(args.get('json'), JSON.stringify(out, null, 2));
await browser.close();
