/**
 * Proof of life, not a typecheck.
 *
 * Loads the real page against a dev server whose port you pass, waits for
 * `window.__game.ready`, and prints every `pageerror` and every console line it saw on the
 * way. Three commits have shipped on this project that typechecked clean and white-screened:
 * a missing runtime method behind `?.`, an ESM binding error at import, and a temporal dead
 * zone. `tsc` cannot see any of them and neither can a screenshot that times out.
 *
 * Usage:
 *   node tools/probe-boot-carthage.mjs --port=5847 [--map=carthage] [--scenario=field]
 *
 * The first line it prints is the URL it actually loaded. Read it. Probes on this project
 * have silently graded a stale `dist/` served by nobody, and one was fooled by another
 * agent's dev server in a different checkout.
 */
import { chromium } from 'playwright';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);

const PORT = Number(args.get('port') ?? 5847);
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'field';
const QUALITY = args.get('quality') ?? 'high';
const TIMEOUT = Number(args.get('timeout') ?? 180000);

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const url =
  `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=${QUALITY}` +
  `&scenario=${SCENARIO}&battle=${token}`;

console.log(`[boot] ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  const t = m.type();
  logs.push(`${t}: ${m.text()}`);
  if (t === 'error') errors.push(`CONSOLE ${m.text()}`);
});
page.on('requestfailed', (r) => errors.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));

let ready = false;
let readyMs = 0;
const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, {
    timeout: TIMEOUT,
    polling: 250,
  });
  ready = true;
  readyMs = Date.now() - t0;
} catch (e) {
  errors.push(`WAIT ${e.message}`);
}

const state = ready
  ? await page.evaluate(() => {
      const g = window.__game;
      const ctx = g.engine.context;
      const terrain = ctx.tryGet('terrain');
      const city = ctx.tryGet('city');
      const hf = terrain?.heightField;
      // Sample the field on a coarse lattice so a NaN or an under-datum hole shows up.
      let min = Infinity;
      let max = -Infinity;
      let nan = 0;
      for (let j = -1350; j <= 1350; j += 30) {
        for (let i = -1350; i <= 1350; i += 30) {
          const h = terrain.heightAt(i, j);
          if (!Number.isFinite(h)) nan++;
          else {
            if (h < min) min = h;
            if (h > max) max = h;
          }
        }
      }
      const r = g.engine.renderer.info.render;
      const units = g.battle.units.length;
      let men = 0;
      for (const u of g.battle.units) men += u.alive;
      return {
        map: terrain?.map?.id ?? null,
        buildMs: Math.round(terrain?.stats?.buildMs ?? 0),
        clipTris: terrain?.stats?.triangles ?? 0,
        hf: hf ? { res: hf.res, spacing: +hf.spacing.toFixed(4), half: hf.halfExtent } : null,
        heightMin: +min.toFixed(2),
        heightMax: +max.toFixed(2),
        nan,
        city: city ? 'registered' : 'absent',
        wallSegments: city?.getWallSegments?.().length ?? 0,
        stairs: city?.getWallStairs?.().length ?? 0,
        gateDoor: city?.getGateDoor?.() ? 'present' : 'none',
        units,
        men,
        draws: r.calls,
        tris: r.triangles,
      };
    })
  : null;

// Two seconds of frames after ready: a boot that dies on the first update is still a dead
// boot, and `ready` is set before the loop has run.
if (ready) {
  await page.evaluate(() => window.__game.advance(2));
  await page.waitForTimeout(600);
}

/**
 * Optional frames, into one directory that its owner deletes.
 *
 * Deliberately *not* a `tools/shoot.mjs` shot table entry: these are working frames for
 * eyeballing a heightfield, they are shot with the HUD up and at whatever tier is handy, and
 * a frame like that must never end up in a graded deck. `blind-compare` would refuse them
 * anyway — `shoot.mjs` writes the provenance record and this does not — but the cheapest way
 * to keep a working frame out of a deck is for it never to look like a deck frame.
 */
/**
 * Quality-tier switch, which is its own bug class on this project.
 *
 * A CSM `rebuild()` without a matching `remove()` once rendered the whole world grey after a
 * tier change, and a tier change is one click in the HUD. It cannot be caught by booting at a
 * tier — the fault is in the *transition* — so this drives every tier in turn and reads the
 * mean luminance of the frame back out of the canvas each time. Grey is not an error, it is a
 * picture, so the check has to be photometric.
 */
if (ready && args.get('tiers')) {
  const tiers = ['low', 'medium', 'high', 'ultra'];
  const seen = [];
  for (const t of tiers) {
    await page.evaluate((q) => window.__game.engine.setQuality(q), t);
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const cv = document.getElementById('viewport');
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      const g = c.getContext('2d');
      g.drawImage(cv, 0, 0, 160, 90);
      const d = g.getImageData(0, 0, 160, 90).data;
      let sum = 0;
      let sq = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        sum += l;
        sq += l * l;
      }
      const mean = sum / n;
      return { mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)),
               draws: window.__game.engine.renderer.info.render.calls };
    });
    seen.push(`${t} mean ${m.mean.toFixed(3)} sd ${m.sd.toFixed(3)} draws ${m.draws}`);
    // A flat frame is the signature: the grey-world bug left the picture uniform, not dark.
    if (m.sd < 0.02) errors.push(`TIER ${t} rendered flat (sd ${m.sd.toFixed(4)}) — grey world?`);
  }
  console.log(`[boot] tiers: ${seen.join(' | ')}`);
}

const outDir = args.get('shots');
if (ready && outDir) {
  const fs = await import('node:fs/promises');
  await fs.mkdir(outDir, { recursive: true });
  // x, z, zoom, yaw. Yaw 0 looks toward +Z, which on this map is the city.
  const CAMS = [
    // The siege line looking east up the isthmus at the wall, which is the map's main axis.
    ['siegeline', 0, -60, 0.72, 0],
    // On the wall line, looking at the Byrsa behind it.
    ['byrsa', 0, 700, 0.62, 0],
    // The Taenia and the head of the lake, from the south-west.
    ['taenia', -1150, 400, 0.6, 0],
    // The Sebkhet Ariana at the wall's north anchor.
    ['ariana', 1050, 380, 0.6, 0],
    // The east coast behind the city.
    ['coast', 200, 1020, 0.62, 0],
    ['strategic', 0, 320, 1.0, 0],
  ];
  for (const [name, x, z, zoom, yaw] of CAMS) {
    await page.evaluate(
      ([cx, cz, cq, cy]) => window.__game.setCamera(cx, cz, cq, cy),
      [x, z, zoom, yaw],
    );
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${outDir}/${name}.png` });
  }
  console.log(`[boot] ${CAMS.length} working frames -> ${outDir}`);
}

await browser.close();

console.log(`[boot] ready=${ready}${ready ? ` in ${readyMs} ms` : ''}`);
if (state) {
  for (const [k, v] of Object.entries(state)) console.log(`  ${k}: ${v}`);
}
if (errors.length) {
  console.log(`\n[boot] ${errors.length} error(s):`);
  for (const e of errors.slice(0, 25)) console.log(`  ${e}`);
}
const interesting = logs.filter((l) => /\[terrain|\[city|\[carthage|\[boot|warn/i.test(l));
if (interesting.length) {
  console.log(`\n[boot] notable console:`);
  for (const l of interesting.slice(0, 25)) console.log(`  ${l}`);
}
process.exit(ready && errors.length === 0 ? 0 : 1);
