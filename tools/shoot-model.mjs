#!/usr/bin/env node
/**
 * Isolated-model capture harness — one soldier, large, on a neutral ground.
 *
 * Every blind round this project has run graded a *battle* screenshot, in which a man is a
 * few hundred pixels among nine thousand and the grader ends up sorting on grass seams,
 * terrain and aliasing rather than on the soldier. This shoots the other instrument: a
 * single figure at high magnification, deterministically posed and lit, so the thing being
 * graded is the model.
 *
 * It drives `/viewer.html` — the inspector that already shares the game's build, atlases and
 * shaders — through `window.__viewer.plate()`. Nothing here reimplements the renderer, which
 * is the point: what this photographs is what the battle draws.
 *
 * Usage:
 *   node tools/shoot-model.mjs --port=5199 --out=screenshots/mdl
 *   node tools/shoot-model.mjs --set=turntable --unit=legio-cohort
 *   node tools/shoot-model.mjs --list
 *
 * Every run writes `report.json` recording the commit, the argv, the dpr, the output size and
 * the full plate spec of every frame, so a deck can be traced to the tree that produced it.
 * `tools/blind-compare.mjs` refuses a deck without that record.
 */

import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const COMMIT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
})();

// ---------------------------------------------------------------------------
// Plate definitions.
//
// A plate is a man plus a camera. `fill` is the fraction of frame height his bounding box
// takes, so magnification is dialled rather than inherited from a box fit — matching the
// reference crops' magnification is the whole reason this harness exists.
//
// **Azimuth is where the camera stands, and 0 is in front of the man's face.** The viewer's
// own default is -0.85, which its comment calls "the man's own right-front", so PI is behind
// him. The first version of this table had the convention backwards and shot ten plates of a
// legionary's back; the framing bug beside it (`fill` clamped to 1) turned every close-up back
// into a full figure. Both are why the harness prints the spec into `report.json`.
// ---------------------------------------------------------------------------

const F = { front: 0, rightQ: -0.85, leftQ: 0.85, sideR: -Math.PI / 2, backQ: Math.PI * 0.8 };

/** Where a head plate aims, metres. The eye line, not the navel. */
const HEAD_Y = 1.62;

/** Poses that hold still and read: a plate is a still, so a mid-swing blur is wasted. */
const PLATES = {
  // --- The core deck: one man per kit family, three-quarter front, chest-up magnification.
  'legio-front': {
    unit: 'legio-cohort', hash: 0.37, clip: 'idleAlertReady', phase: 0.32,
    az: F.rightQ, el: 0.05, fill: 0.88, desc: 'Legionary, three-quarter front, at the ready',
  },
  'legio-shield': {
    unit: 'legio-cohort', hash: 0.37, clip: 'idleBrace', phase: 0.5,
    az: 0.95, el: 0.03, fill: 0.86, desc: 'Legionary behind the scutum — the shield face',
  },
  // Aimed at 1.585 rather than the eye line and pulled back from 4.2 to 3.3.
  //
  // A galea's rim sits at the brow, so a head plate aimed at the eyes and magnified 4.2x
  // frames the *bowl* and nothing else — which is what the blind critic saw when it wrote
  // "full-frame head and there is no face". The face opening, the cheek pieces, the chin and
  // the focale are all below the eye line on a helmeted man, and they are what a Rome II
  // head crop actually contains.
  'legio-head': {
    unit: 'legio-cohort', hash: 0.62, clip: 'idleAlertReady', phase: 0.32,
    az: -0.6, el: 0.06, fill: 3.3, aimY: 1.585, desc: 'Legionary head and helmet, close',
  },
  'legio-back': {
    unit: 'legio-cohort', hash: 0.11, clip: 'idleAlertReady', phase: 0.32,
    az: F.backQ, el: 0.10, fill: 0.88, desc: 'Legionary from behind — segmentata girth hoops',
  },
  'praet-front': {
    unit: 'praetorian-cohort', hash: 0.51, clip: 'idleAlertReady', phase: 0.32,
    az: -0.7, el: 0.05, fill: 0.88, desc: 'Praetorian, three-quarter front',
  },
  'praet-torso': {
    unit: 'praetorian-cohort', hash: 0.29, clip: 'attackOverhead', phase: 0.18,
    az: -0.5, el: 0.02, fill: 1.9, aimY: 1.25, desc: 'Praetorian torso mid-blow — armour close',
  },
  'auxarch-side': {
    unit: 'sagittarii', hash: 0.44, clip: 'idleAlertReady', phase: 0.32,
    az: F.sideR, el: 0.05, fill: 0.88, desc: 'Auxiliary archer in profile',
  },
  'juth-front': {
    unit: 'juthungi-warband', hash: 0.73, clip: 'idleAlertReady', phase: 0.32,
    az: -0.6, el: 0.05, fill: 0.88, desc: 'Juthungi warrior, three-quarter front',
  },
  // Hash 0.51 rather than 0.19: 0.19 draws a fur cap, and with the camera looking at the
  // back of his head that was indistinguishable from a bare one. Now that azimuth 0 is
  // genuinely in front of the man (see `framePlate`), the one plate in the deck whose job is
  // to photograph a head has to photograph one that is not inside a hat.
  'juth-head': {
    unit: 'juthungi-warband', hash: 0.51, clip: 'idleAlertReady', phase: 0.32,
    az: -0.45, el: 0.05, fill: 4.0, aimY: HEAD_Y, desc: 'Juthungi head — hair, beard, face',
  },
  'urban-front': {
    unit: 'urban-cohort', hash: 0.83, clip: 'idleAlertReady', phase: 0.32,
    az: -0.7, el: 0.05, fill: 0.88, desc: 'Urban cohort, three-quarter front',
  },
};

/** A turntable of one man: eight azimuths at one elevation. Silhouette and material both. */
function turntable(unit, hash, fill = 0.88, aimY) {
  const out = {};
  for (let i = 0; i < 8; i++) {
    const az = (i / 8) * Math.PI * 2;
    out[`tt-${String(i).padStart(2, '0')}`] = {
      unit, hash, clip: 'idleAlertReady', phase: 0.32, aimY,
      az, el: 0.06, fill, desc: `Turntable ${Math.round((az * 180) / Math.PI)}°`,
    };
  }
  return out;
}

const SETS = {
  deck: Object.keys(PLATES),
  quick: ['legio-front', 'legio-shield', 'legio-head', 'juth-front'],
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

if (args.has('list')) {
  for (const [k, v] of Object.entries(PLATES)) {
    console.log(`${k.padEnd(16)} ${v.unit.padEnd(20)} fill ${String(v.fill).padStart(5)}  ${v.desc}`);
  }
  console.log(`\nsets: ${Object.entries(SETS).map(([k, v]) => `${k} (${v.length})`).join(', ')}`);
  console.log('turntable: --set=turntable --unit=<id> --hash=<0..1>');
  process.exit(0);
}

const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/model');
const PORT = Number(args.get('port') ?? 5199);
const DPR = Number(args.get('dpr') ?? 2);
const W = Number(args.get('w') ?? 900);
const H = Number(args.get('h') ?? 1200);
const KEEP_SERVER = args.has('port');

let plates;
if (args.get('set') === 'turntable') {
  plates = turntable(args.get('unit') ?? 'legio-cohort', Number(args.get('hash') ?? 0.37), Number(args.get('fill') ?? 0.88));
} else if (args.has('set')) {
  const names = SETS[args.get('set')];
  if (!names) {
    console.error(`Unknown set "${args.get('set')}". Available: ${Object.keys(SETS).join(', ')}`);
    process.exit(1);
  }
  plates = Object.fromEntries(names.map((n) => [n, PLATES[n]]));
} else if (args.has('shots')) {
  plates = {};
  for (const n of args.get('shots').split(',')) {
    if (!PLATES[n]) { console.error(`Unknown plate "${n}"`); process.exit(1); }
    plates[n] = PLATES[n];
  }
} else {
  plates = PLATES;
}

// ---------------------------------------------------------------------------
// Dev server. Reused if one is already on the port, because parallel agents each own one
// and starting a second on the same port is how the player's server has been killed before.
// ---------------------------------------------------------------------------

let server = null;

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  const alive = await fetch(`${base}/viewer.html`).then((r) => r.ok).catch(() => false);
  if (alive) {
    console.log(`• reusing dev server already on ${PORT}`);
    return base;
  }
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TC_NO_HMR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/viewer.html`).then((r) => r.ok).catch(() => false)) return base;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`vite failed to start:\n${log.slice(-4000)}`);
  throw new Error('dev server did not come up');
}

function stopServer() {
  if (server && !KEEP_SERVER) { server.kill('SIGTERM'); server = null; }
}

// ---------------------------------------------------------------------------

let failed = 0;
let browser = null;

try {
  const base = await startServer();
  await mkdir(OUT, { recursive: true });

  browser = await chromium.launch({
    args: [
      '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-dev-shm-usage', '--hide-scrollbars',
    ],
  });

  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });

  // A typecheck is not proof of life on this project and a dead page is indistinguishable
  // from a slow boot without these.
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const url = `${base}/viewer.html`;
  console.log(`• loading ${url}  ${W}x${H} @dpr ${DPR}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__viewer && window.__viewer.ready === true, null, { timeout: 180000 });

  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    if (!g) return { ok: false };
    const d = g.getExtension('WEBGL_debug_renderer_info');
    return { ok: true, renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  });
  console.log(`• webgl2: ${gl.ok ? gl.renderer : 'UNAVAILABLE'}`);

  // Strip the inspector's own furniture. The panel is a 320 px column of controls and the
  // readout a stats block — either one sorts a deck in a glance, and "missing is refused as
  // firmly as true" applies here exactly as it does to the battle harness's HUD.
  const chrome = await page.evaluate(() => {
    const kill = ['#viewer-panel', '#viewer-readout', '#viewer-boot'];
    let n = 0;
    for (const sel of kill) {
      const el = document.querySelector(sel);
      if (el) { el.remove(); n++; }
    }
    for (const t of document.querySelectorAll('.vw-tag')) { t.remove(); n++; }
    const c = document.getElementById('viewer-canvas');
    if (c) { c.style.position = 'absolute'; c.style.inset = '0'; c.style.width = '100%'; c.style.height = '100%'; }
    window.dispatchEvent(new Event('resize'));
    return n;
  });
  console.log(`• chrome removed: ${chrome} node(s)`);

  const results = [];
  for (const [name, p] of Object.entries(plates)) {
    try {
      await page.evaluate((spec) => {
        window.__viewer.plate({
          unit: spec.unit, hash: spec.hash, lod: 0,
          clip: spec.clip, phase: spec.phase,
          azimuth: spec.az, elevation: spec.el, fill: spec.fill, aimY: spec.aimY,
          light: spec.light,
        });
      }, p);
      // Two animation frames: one to apply the state, one to draw it. The controls damp, so
      // a single frame photographs the camera on its way to where it was told to go.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      const stats = await page.evaluate(() => window.__viewer.stats());
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, type: 'png' });
      results.push({ name, ...p, ...stats });
      console.log(`  ✓ ${name.padEnd(16)} ${String(stats.triangles).padStart(8)} tris  ${String(stats.draws).padStart(3)} draws  ${p.desc}`);
    } catch (err) {
      failed++;
      results.push({ name, error: String(err.message) });
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  if (errors.length) {
    failed++;
    console.error(`\n⚠ ${errors.length} console error(s):`);
    for (const e of [...new Set(errors)].slice(0, 20)) console.error(`   ${e}`);
  }

  await writeFile(
    path.join(OUT, 'report.json'),
    `${JSON.stringify({
      tool: 'shoot-model.mjs',
      argv: process.argv.slice(2),
      commit: COMMIT,
      when: new Date().toISOString(),
      // The provenance gate reads these three. `hud: false` is a statement of fact here —
      // the viewer's panel and readout are removed from the DOM above and the count is logged.
      hud: false,
      dpr: DPR,
      size: { w: W, h: H },
      isolated: true,
      plates: results,
    }, null, 2)}\n`
  );

  console.log(`\n→ ${results.filter((r) => !r.error).length}/${Object.keys(plates).length} plates written to ${path.relative(ROOT, OUT)}/`);
} catch (err) {
  console.error(`\nFATAL: ${err.message}`);
  failed++;
} finally {
  if (browser) await browser.close();
  stopServer();
}

process.exit(failed ? 1 : 0);
