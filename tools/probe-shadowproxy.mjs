#!/usr/bin/env node
/**
 * Does the merged shadow caster draw the same shadow?
 *
 * `CitySystem.buildShadowProxy` replaces a chunk's per-material casting meshes with one
 * merged depth mesh and claims the silhouette is identical because it is the same triangles.
 * This checks the claim against pixels, both arms in one browser session with the sim clock
 * paused — cross-session comparison is not a measurement on this project, because dust and
 * particle VFX reseed per session and two identical runs differ on 50-70 % of pixels.
 *
 * The base arm is re-shot last as a drift check. Without it, "my change did nothing" and "my
 * arms did not restore" produce the same answer.
 *
 *   node tools/probe-shadowproxy.mjs --port=5477 --cams=assault,city,wall
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const SCENARIO = args.get('scenario') ?? 'assault';
const AT = Number(args.get('at') ?? 72);
const OUT = args.get('out') ?? null;

const CAMS = {
  assault: null,
  city: { x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72 },
  skyline: { x: -180, z: 780, zoom: 0.80, yaw: Math.PI * 0.05 },
};
const cams = args.get('cams') ? String(args.get('cams')).split(',') : ['assault', 'city', 'wall'];

const base = `http://127.0.0.1:${PORT}`;
const ping = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!ping?.ok) throw new Error(`no dev server on ${base}`);
console.log(`source: ${base} (my server; confirmed 200)`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&scenario=${SCENARIO}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
CAMS.assault = await page.evaluate(() => {
  const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
});
if (AT > 0) await page.evaluate((t) => window.__game.advance(t), AT);
// Paused, so the only thing that can differ between two shots of one camera is the change.
await page.evaluate(() => { window.__game.engine.time.paused = true; });

const arm = (on) => page.evaluate((v) => {
  const city = window.__game.engine.context.tryGet('city');
  city.setShadowProxies(v);
  let n = 0;
  window.__game.engine.context.scene.traverse((o) => { if (o.isMesh && o.castShadow) n++; });
  window.__game.engine.advance(1 / 60);
  window.__game.engine.advance(1 / 60);
  return { casters: n, draws: window.__game.engine.renderer.info.render.calls };
}, on);

/** Raw RGB, so the comparison never runs through a second encode. */
const shot = async () => {
  const buf = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, png: buf };
};

const diff = (a, b) => {
  let n = 0;
  let sum = 0;
  let worst = 0;
  const px = a.w * a.h;
  for (let i = 0; i < px; i++) {
    const d = Math.max(
      Math.abs(a.data[i * 3] - b.data[i * 3]),
      Math.abs(a.data[i * 3 + 1] - b.data[i * 3 + 1]),
      Math.abs(a.data[i * 3 + 2] - b.data[i * 3 + 2]),
    );
    if (d > 0) { n++; sum += d; }
    if (d > worst) worst = d;
  }
  return { pct: (100 * n) / px, mean: n ? sum / n : 0, worst };
};

if (OUT) fs.mkdirSync(OUT, { recursive: true });
console.log(`# ${W}x${H} ultra, ${SCENARIO} t+${AT}s, clock paused`);
for (const name of cams) {
  const c = CAMS[name];
  await page.evaluate((s) => window.__game.setCamera(s.x, s.z, s.zoom, s.yaw), c);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.__game.engine.advance(1 / 60); });

  const aInfo = await arm(false);          // per-mesh casters, the old behaviour
  const a = await shot();
  const bInfo = await arm(true);           // merged proxies
  const b = await shot();
  const a2Info = await arm(false);         // base again — the drift check
  const a2 = await shot();

  const d = diff(a, b);
  const drift = diff(a, a2);
  if (OUT) {
    fs.writeFileSync(`${OUT}/${name}-permesh.png`, a.png);
    fs.writeFileSync(`${OUT}/${name}-proxy.png`, b.png);
  }
  console.log(`\n=== ${name} ===`);
  console.log(`  per-mesh casters ${aInfo.casters} -> ${aInfo.draws} draws`);
  console.log(`  merged proxies   ${bInfo.casters} -> ${bInfo.draws} draws   (${bInfo.draws - aInfo.draws})`);
  console.log(`  difference: ${d.pct.toFixed(3)}% of pixels, mean ${d.mean.toFixed(2)}/255, worst ${d.worst}`);
  console.log(`  drift check (base re-shot last): ${drift.pct.toFixed(3)}% of pixels, mean ${drift.mean.toFixed(2)}/255`
    + `, worst ${drift.worst}${a2Info.draws !== aInfo.draws ? `  !! draws did not restore (${a2Info.draws})` : ''}`);
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
}
await browser.close();
