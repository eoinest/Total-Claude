#!/usr/bin/env node
/**
 * pn2-ditchshot — is Carthage's ditch there, and why does no frame of it show one?
 *
 * The owner, on a distant oblique frame of the curtain: *"the ground runs flat to the wall
 * footing"*. Three separate instruments say the cut is real — `assertDitchCut` 88/88 stations
 * at 6.00 m median, `dq-ditchscan` 153 of 175 stations inside the planned span at 5.5 m or
 * better, `dq-ditchlod` full 6 m relief in the clipmap ring that covers the near field — so
 * either the report is wrong or every camera that has looked at it is.
 *
 * This drives the game's own RTS rig, not `shoot.mjs`'s wall-relative table, because the
 * question is about *viewpoint*: at what eye and what range does a 20 x 6 m trench 19.5 m
 * off the footing stop being visible? One frame per station, all at the same focus.
 *
 *   node tools/scratch/pn2-ditchshot.mjs --port=5603 --out=screenshots/pn2-ditch
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5603);
const OUT = args.get('out') ?? 'screenshots/pn2-ditch';
const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'assault', opponent: 2, timeOfDay: 16.5 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1600&h=900&quality=ultra&scenario=assault&battle=${token}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600000 });
await page.evaluate(() => window.__game.advance(8));

// The postern the branch's two cameras are aimed at is at x -52.5; the ditch's inner lip is
// ~9.5 m off the wall and its bed ~19.5 m off, on the field side (smaller z).
const CAMS = [
  ['e-z45', -53, 508, 0.45, 0.0],
  ['f-z55', -53, 508, 0.55, 0.0],
  ['g-z65', -53, 508, 0.65, 0.0],
  ['h-z50-alongx', -53, 508, 0.50, 1.5708],
  ['a-oblique-close', -53, 505, 0.20, 0.0],
  ['b-oblique-mid', -53, 495, 0.34, 0.0],
  ['c-along-the-cut', -53, 508, 0.26, 1.5708],
  ['d-field-eye', -53, 470, 0.16, 0.0],
];
const rows = [];
for (const [name, x, z, zoom, yaw] of CAMS) {
  await page.evaluate(([cx, cz, cq, cy]) => window.__game.setCamera(cx, cz, cq, cy), [x, z, zoom, yaw]);
  await page.waitForTimeout(700);
  const cam = await page.evaluate(() => {
    const c = window.__game.engine.rig.camera;
    const t = window.__game.engine.context.tryGet('terrain');
    return { eyeY: +c.position.y.toFixed(2), x: +c.position.x.toFixed(1), z: +c.position.z.toFixed(1),
      fov: +c.fov.toFixed(1), groundUnderEye: +t.heightAt(c.position.x, c.position.z).toFixed(2) };
  });
  await page.screenshot({ path: `${OUT}/${name}.png` });
  rows.push({ name, x, z, zoom, yaw, ...cam, eyeAboveGround: +(cam.eyeY - cam.groundUnderEye).toFixed(2) });
  console.log(`${name.padEnd(18)} focus(${x},${z}) zoom ${zoom}  eye (${cam.x},${cam.eyeY},${cam.z}) ${(cam.eyeY - cam.groundUnderEye).toFixed(2)} m above ground, fov ${cam.fov}`);
}
await writeFile('tools/scratch/pn2-ditchcams.json', JSON.stringify({ url, rows, errors }, null, 1));
if (errors.length) { console.log('PAGE ERRORS:'); for (const e of errors) console.log('  ' + e); }
await browser.close();
