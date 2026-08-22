/**
 * probe-map.mjs — what a battle map actually built.
 *
 * Every other tool here grades a rendered frame. This one reads the world behind it, because
 * a second map introduces a whole class of failure a screenshot describes badly: the wrong
 * map silently loading, the sun in the wrong quarter of the sky, ground below the datum, the
 * city of Rome standing on a Macedonian plain, or the vegetation and the ground shader
 * disagreeing about where a grove is. All of those produce a picture that merely looks
 * *wrong* rather than broken, and guessing from the picture wastes a render cycle each time.
 *
 *   node tools/probe-map.mjs --port=5253                     # the default battlefield
 *   node tools/probe-map.mjs --port=5253 --map=pydna         # a named map at its own hour
 *   node tools/probe-map.mjs --port=5253 --map=pydna --hour=17
 *   node tools/probe-map.mjs --port=5253 --map=pydna --json=/tmp/pydna.json
 *
 * Reports, in one pass:
 *   - which map the terrain system actually built, and at what hour
 *   - sun elevation and compass bearing, plus whether the sun is in front of the opening
 *     camera — the single check that catches a flat, shadowless battlefield before a
 *     screenshot does
 *   - a height transect across the field, the deployment-box gradients both armies stand on,
 *     and min/max ground
 *   - vegetation census by species, and how many trees stand inside a deployment box
 *   - draw calls and triangles attributed to the terrain stack
 *   - whether the city of Rome is present and visible
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const PORT = Number(args.get('port') ?? 5217);
const MAP = args.get('map') ?? null;
const HOUR = args.get('hour') ? Number(args.get('hour')) : null;
const JSON_OUT = args.get('json') ?? null;
const QUALITY = args.get('quality') ?? 'ultra';

/**
 * The historical order of battle, duplicated from `src/sim/battleConfig.ts`.
 *
 * It has to be a literal: the probe drives the page through `?battle=`, which is a base64url
 * `BattleConfig`, and a node script cannot import the TypeScript module that defines one.
 * Only `map` and `timeOfDay` are ever varied — the army is held fixed so two maps are
 * compared carrying the same weight.
 */
const BASE_CONFIG = {
  unitSize: 'ultra',
  rome: {
    'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2,
    sagittarii: 2, equites: 3, scorpio: 1,
  },
  juthungi: {
    'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3,
    'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3,
  },
  quality: QUALITY,
  difficulty: 'hard',
  seed: 4265438264,
};

const encodeConfig = (c) =>
  Buffer.from(JSON.stringify(c)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const waitForServer = async (base, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

let server = null;
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) {
    console.error('dev server did not come up');
    process.exit(1);
  }
} else {
  console.log(`• reusing dev server already on ${PORT}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push(`PAGEERROR ${e.message}`));
// A vite transform failure arrives as a 500 on a module URL and shows up in the page log
// only as "Failed to load resource", which names nothing. Capture the URL itself.
page.on('response', (r) => {
  if (r.status() >= 400) consoleLines.push(`HTTP ${r.status()} ${r.url()}`);
});

const cfg = { ...BASE_CONFIG };
if (MAP) cfg.map = MAP;
// Omitted entirely when not asked for, so `sanitiseConfig` supplies the map's own default
// hour rather than the probe silently pinning every map to one time of day.
if (HOUR !== null) cfg.timeOfDay = HOUR;

const url = `${base}/?harness=1&quality=${QUALITY}&w=1280&h=720&battle=${encodeConfig(cfg)}`;
console.log(`• loading ${url.slice(0, 110)}…`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
} catch (err) {
  // A boot failure is the single most likely thing this probe catches, and the exception
  // Playwright throws says nothing useful about it. The page's own log does.
  console.error(`\n!! the page never became ready: ${err.message}`);
  console.error('--- page console ---');
  for (const l of consoleLines.slice(-60)) console.error('  ' + l.slice(0, 300));
  await browser.close();
  if (server) server.kill('SIGTERM');
  process.exit(1);
}
// Let the camera settle and one full frame present, so LOD tiers and the clipmap centre are
// in the state a screenshot would capture.
await page.evaluate(() => {
  const g = window.__game;
  g.advance(1);
  for (let i = 0; i < 8; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
});

const report = await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const terrain = ctx.tryGet('terrain');
  const sky = ctx.tryGet('sky');
  const city = ctx.tryGet('city');
  const scene = ctx.scene;

  const d = sky.sunDirection;
  const elevation = (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI;
  // Compass bearing of the sun, with north = -Z to match the world axes.
  const bearing = ((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) % 360;

  // Is the sun in front of the opening camera? The camera looks along its own forward
  // vector; a positive dot with the sun direction means the sun is ahead of it, which is
  // what rakes light across the frame instead of over the player's shoulder.
  const cam = ctx.camera;
  const fwd = new (d.constructor)();
  cam.getWorldDirection(fwd);
  const sunDotForward = fwd.x * d.x + fwd.y * d.y + fwd.z * d.z;
  const camYawBearing = ((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI + 360) % 360;
  // Signed angle from the camera axis to the sun, in the horizontal plane. 0 = dead ahead,
  // ±90 = broadside, ±180 = directly behind.
  let sunOffAxis = bearing - camYawBearing;
  while (sunOffAxis > 180) sunOffAxis -= 360;
  while (sunOffAxis < -180) sunOffAxis += 360;

  // Height transect and deployment gradients.
  const hAt = (x, z) => terrain.heightAt(x, z);
  const transectX = [];
  for (let x = -1400; x <= 1400; x += 200) transectX.push([x, +hAt(x, 0).toFixed(1)]);
  const transectZ = [];
  for (let z = -1400; z <= 1400; z += 200) transectZ.push([z, +hAt(0, z).toFixed(1)]);

  const boxStats = (cx, cz, hx, hz) => {
    let min = Infinity;
    let max = -Infinity;
    let maxSlope = 0;
    let sumSlope = 0;
    let n = 0;
    for (let z = cz - hz; z <= cz + hz; z += 10) {
      for (let x = cx - hx; x <= cx + hx; x += 10) {
        const h = hAt(x, z);
        if (h < min) min = h;
        if (h > max) max = h;
        const s = terrain.slopeAt(x, z);
        if (s > maxSlope) maxSlope = s;
        sumSlope += s;
        n++;
      }
    }
    return {
      minH: +min.toFixed(2), maxH: +max.toFixed(2), fall: +(max - min).toFixed(2),
      meanSlopePct: +((sumSlope / n) * 100).toFixed(2),
      maxSlopePct: +(maxSlope * 100).toFixed(1),
    };
  };

  const field = terrain.heightField;
  let fMin = Infinity;
  let fMax = -Infinity;
  for (let i = 0; i < field.data.length; i += 7) {
    const v = field.data[i];
    if (v < fMin) fMin = v;
    if (v > fMax) fMax = v;
  }

  // Vegetation census, read straight off the scatter's placement lists.
  const veg = {};
  let inDeploy = 0;
  const scatter = terrain.scatter;
  if (scatter && scatter.groups) {
    for (const grp of scatter.groups) {
      veg[grp.species] = grp.items.length;
      for (const it of grp.items) {
        const inMac = Math.abs(it.x - 0) < 490 && Math.abs(it.z + 196) < 130;
        const inRom = Math.abs(it.x - 10) < 490 && Math.abs(it.z - 150) < 120;
        if (inMac || inRom) inDeploy++;
      }
    }
  }

  // Draw attribution for the ground stack.
  const buckets = {};
  scene.traverse((o) => {
    if (!o.visible || !o.geometry) return;
    let n = o;
    let hidden = false;
    while (n) {
      if (!n.visible) hidden = true;
      n = n.parent;
    }
    if (hidden) return;
    const name = o.name || o.type;
    const key = /^grass-/.test(name) ? 'grass'
      : /^veg-/.test(name) ? 'vegetation'
      : name === 'terrain' ? 'terrain'
      : /water/i.test(name) ? 'water'
      : null;
    if (!key) return;
    const idx = o.geometry.index;
    const pos = o.geometry.attributes.position;
    const tris = ((idx ? idx.count : pos ? pos.count : 0) / 3) * (o.isInstancedMesh ? o.count : 1);
    const b = (buckets[key] ??= { draws: 0, tris: 0 });
    if (!o.isInstancedMesh || o.count > 0) b.draws++;
    b.tris += Math.round(tris);
  });

  const info = g.engine.stats();

  return {
    map: terrain.map ? { id: terrain.map.id, label: terrain.map.label, hidesCity: terrain.map.hidesCity } : null,
    hour: sky.timeOfDay,
    sun: {
      elevationDeg: +elevation.toFixed(2),
      bearingDeg: +bearing.toFixed(1),
      cameraBearingDeg: +camYawBearing.toFixed(1),
      offAxisDeg: +sunOffAxis.toFixed(1),
      inFrontOfCamera: sunDotForward > 0,
      shadowLengthPerMetre: +(1 / Math.tan((elevation * Math.PI) / 180)).toFixed(2),
      intensity: +sky.sunIntensity.toFixed(3),
    },
    preset: {
      exposure: sky.preset.exposure, turbidity: sky.preset.turbidity,
      hazeDensity: sky.preset.hazeDensity, groundAlbedo: sky.preset.groundAlbedo,
      cloudCoverage: sky.preset.cloudCoverage,
    },
    ground: {
      waterLevel: terrain.waterLevel,
      fieldMin: +fMin.toFixed(2), fieldMax: +fMax.toFixed(2),
      transectEastWest: transectX,
      transectNorthSouth: transectZ,
      macedonianBox: boxStats(0, -196, 490, 130),
      romanBox: boxStats(10, 150, 490, 120),
    },
    vegetation: { bySpecies: veg, insideDeploymentBoxes: inDeploy },
    render: { draws: info.calls, tris: info.tris, programs: info.programs, groundStack: buckets },
    city: city ? { present: true, visible: city.root ? city.root.visible : 'unknown' } : { present: false },
  };
});

console.log(JSON.stringify(report, null, 2));

const noisy = consoleLines.filter((l) => /error|warn|shader|not compiled/i.test(l));
if (noisy.length) {
  console.log('\n--- console warnings/errors ---');
  for (const l of [...new Set(noisy)].slice(0, 20)) console.log('  ' + l.slice(0, 240));
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
  console.log(`\n→ ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
