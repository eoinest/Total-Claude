#!/usr/bin/env node
/**
 * Film one catapult stone arriving at one wall tower.
 *
 * The owner reported "catapult projectiles pass through walls" by eye, so the fix has to be
 * answerable by eye. Catching a stone in a running battle is not the way to do that: a boulder
 * is a 0.34 m ball crossing the frame at 40 m/s, and which tick it is over the masonry on is
 * emergent. So this stands the field down, puts the camera broadside to a single tower, throws
 * exactly **one** stone at that tower's upper storey through the same `launchBallistic` a real
 * onager fires through, and captures every tick of the approach and the arrival.
 *
 * `spread: 0` and a named rng fork make the shot repeatable to the metre, which is what lets
 * the before and the after be the same stone on the same tick from the same camera — the only
 * difference being the collision model. Run it once on each tree and lay the two strips side
 * by side:
 *
 *   node tools/film-towershot.mjs --port=5741 --out=screenshots/towershot/before
 *   node tools/film-towershot.mjs --port=5741 --out=screenshots/towershot/after
 *
 * `--frames=N`      how many ticks either side of the arrival to keep (default 9).
 * `--sheet-at=a,b,…` pin the contact-sheet tiles to explicit ticks, so two arms match.
 */

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5741);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/towershot');
const ZOOM = Number(args.get('zoom') ?? 0.52);
const KEEP = Number(args.get('frames') ?? 9);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
const base = `http://127.0.0.1:${PORT}`;

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

console.log(`film-towershot -> ${OUT}`);
await page.goto(`${base}/?harness=1&quality=ultra&autoplay=0&scenario=assault&w=${W}&h=${H}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
// Same policy as `tools/shoot.mjs`: a graded frame carries no interface.
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});

// Stand the battle down. Nothing else may be in the air or the frame cannot be attributed.
await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const p = b.pool;
  for (const u of b.units) {
    if (u.destroyed) continue;
    for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11 /* Dead */);
    u.alive = 0;
    u.destroyed = true;
  }
  const shared = await import('/src/sim/combatShared.ts');
  shared.resetCombatShared();
  for (const n of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage', 'siege']) {
    const s = ctx.tryGet(n);
    if (s?.fixedUpdate) s.fixedUpdate = () => {};
  }
});

/*
 * Freeze the simulation clock, and unfreeze it only inside a stepping call.
 *
 * Without this the film is not a film of anything. The page's own rAF loop keeps running
 * between `page.evaluate` calls, and a `page.screenshot()` costs 100-300 ms of wall clock, so
 * the battle advanced on its own while each frame was being captured: the "one tick" between
 * two frames measured 26.5 m of stone flight instead of 1.37 m, and the shot died between
 * captures at a position no frame shows. `time.paused` stops `fixedUpdate` while leaving the
 * renderer free to draw, which is exactly the pair of properties a frame-by-frame film needs.
 */
await page.evaluate(() => { window.__game.engine.time.paused = true; });

/** Step the simulation by exactly `n` fixed ticks, with the clock frozen either side. */
const step = async (n = 1) => page.evaluate((k) => {
  const g = window.__game;
  g.engine.time.paused = false;
  for (let i = 0; i < k; i++) g.advance(1 / 30);
  g.engine.time.paused = true;
}, n);

/** The tower to shoot at, and the camera that sees it broadside. */
const setup = await page.evaluate((zoom) => {
  const g = window.__game;
  const b = g.battle;
  const city = g.engine.context.tryGet('city');
  const towers = (city.getObstacles ? city.getObstacles() : []).filter((o) => o.kind === 'tower');
  if (!towers.length) return null;
  const o = towers[towers.length >> 1];
  const bay = city.bayAt(o.x);
  if (!bay) return null;
  /*
   * Focus on the tower; the eye is placed by yaw and zoom, not by coordinates.
   *
   * `setCamera` is `RTSCamera.jumpTo`, whose first two arguments are the **focus point on the
   * ground**, not the eye — passing an eye position here put the camera face-down in the grass
   * 60 m from anything. The eye is derived from focus, zoom and yaw, so the framing was solved
   * by measuring that mapping instead of guessing at it: at zoom 0.52 the eye sits 46.6 m out
   * and 23 m up, and yaw 13/16 of a turn puts it three-quarters along the wall's own run on
   * the **besieger's** side of it.
   *
   * That obliqueness is the whole point. Standing behind the machine puts the tower dead
   * centre and the stone a dot growing on the axis of view, where a pass-through and a hit
   * look identical. From here the stone crosses the frame right to left and either stops at
   * the stone face or comes out the far side, which is the distinction being judged.
   */
  const yaw = Math.PI * 2 * 13 / 16;
  g.setCamera(o.x, o.z, zoom, yaw);
  return {
    x: o.x, z: o.z, topY: o.topY, hw: o.hw,
    nx: bay.nx, nz: bay.nz,
    crestY: bay.crestY, walkY: bay.walkY,
    masonryTopAtCentre: city.masonryTopAt(o.x, o.z),
    ground: b.groundAt(o.x, o.z),
    cam: { yaw, zoom },
  };
}, ZOOM);

if (!setup) {
  console.error('no tower to film');
  await browser.close();
  process.exit(3);
}
console.log(`  tower (${setup.x.toFixed(1)}, ${setup.z.toFixed(1)}) rising to ` +
  `${setup.topY.toFixed(2)}; crest ${setup.crestY.toFixed(2)}; ` +
  `masonryTopAt says ${Number.isFinite(setup.masonryTopAtCentre)
    ? setup.masonryTopAtCentre.toFixed(2) : String(setup.masonryTopAtCentre)}`);

// Let the renderer settle on the new camera before the first frame.
await step(6);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, '00-camera.png') });

/*
 * A magnified crop around the tower's upper storey, saved beside every full frame.
 *
 * A boulder is 0.34 m across and the eye is 46 m away, so the stone is about twelve pixels in
 * a 1280-wide frame — present, correctly drawn, and far too small to answer a question by eye.
 * (It was verified as drawn rather than assumed: mid-flight the `projectiles-flight-stone`
 * instanced mesh carries `count: 1, visible: true`, and the stone's world position projects to
 * a pixel inside the viewport.) The crop is centred on the tower top and sized so the arrival
 * fills it, which is the frame the report is actually judged on.
 */
const clip = await page.evaluate(({ s, W, H }) => {
  const c = window.__game.engine.context.camera;
  c.updateMatrixWorld();
  const m = c.projectionMatrix.clone().multiply(c.matrixWorldInverse);
  const e = m.elements;
  const project = (X, Y, Z) => {
    const w = e[3] * X + e[7] * Y + e[11] * Z + e[15];
    return {
      x: ((e[0] * X + e[4] * Y + e[8] * Z + e[12]) / w * 0.5 + 0.5) * W,
      y: (1 - ((e[1] * X + e[5] * Y + e[9] * Z + e[13]) / w * 0.5 + 0.5)) * H,
    };
  };
  const top = project(s.x, s.topY, s.z);
  const half = { w: 300, h: 170 };
  return {
    x: Math.max(0, Math.min(W - half.w * 2, Math.round(top.x - half.w))),
    y: Math.max(0, Math.min(H - half.h * 2, Math.round(top.y - half.h))),
    width: half.w * 2, height: half.h * 2,
    towerTopPx: { x: Math.round(top.x), y: Math.round(top.y) },
  };
}, { s: setup, W, H });
console.log(`  tower top projects to pixel (${clip.towerTopPx.x}, ${clip.towerTopPx.y});` +
  ` crop ${clip.width}x${clip.height} at (${clip.x}, ${clip.y})`);
fs.mkdirSync(path.join(OUT, 'crop'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'track'), { recursive: true });
/** Where the stone projected on each captured frame, for the contact sheet and the record. */
const trackPx = [];

/** Throw the stone, then hand back the tick on which it will be nearest the tower. */
const fired = await page.evaluate((s) => {
  const g = window.__game;
  const b = g.battle;
  const pr = g.engine.context.get('projectiles');
  const standoff = 150;
  const fx = s.x + s.nx * standoff;
  const fz = s.z + s.nz * standoff;
  const before = new Set();
  for (let i = 0; i < pr.highWater; i++) if (pr.alive[i] === 1) before.add(i);
  const ok = pr.launchBallistic({
    kind: 'boulder',
    fromX: fx, fromY: b.groundAt(fx, fz) + 3.7, fromZ: fz,
    toX: s.x, toY: (s.crestY + s.topY) * 0.5, toZ: s.z,
    damage: 150, apDamage: 120, spread: 0,
    ownerUnit: -1, rng: b.rng.fork('film-towershot'), lofted: true,
  });
  if (!ok) return null;
  let idx = -1;
  for (let i = 0; i < pr.highWater; i++) {
    if (pr.alive[i] === 1 && !before.has(i)) { idx = i; break; }
  }
  return idx < 0 ? null : { idx };
}, setup);

if (!fired) {
  console.error('the stone would not launch');
  await browser.close();
  process.exit(3);
}

/*
 * Run to the arrival, capturing the last `KEEP` ticks of the approach and everything after.
 *
 * The tick to start filming on is found by flying the shot rather than guessed: step until the
 * stone is within 34 m of the tower, then capture every tick until it dies plus a short tail,
 * so a stone that came out of the far side is on film going away.
 */
let n = 0;
let shots = 0;
let ended = null;
const log = [];
for (; n < 400; n++) {
  const st = await page.evaluate(({ idx, s }) => {
    const g = window.__game;
    const pr = g.engine.context.get('projectiles');
    const city = g.engine.context.tryGet('city');
    const m0 = pr.masonryHits;
    g.engine.time.paused = false;
    g.advance(1 / 30);
    g.engine.time.paused = true;
    const alive = pr.alive[idx] === 1;
    const x = alive ? pr.px[idx] : pr.ox[idx];
    const y = alive ? pr.py[idx] : pr.oy[idx];
    const z = alive ? pr.pz[idx] : pr.oz[idx];
    return {
      alive, x, y, z,
      // Distance covered by this one tick. If this is not ~1.4 m the clock got away again.
      stepM: Math.hypot(x - pr.ox[idx], y - pr.oy[idx], z - pr.oz[idx]),
      d: Math.hypot(x - s.x, z - s.z),
      top: city ? city.masonryTopAt(x, z) : -Infinity,
      hitMasonry: pr.masonryHits > m0,
    };
  }, { idx: fired.idx, s: setup });

  // A fixed window, not "until it dies": the two arms must cover the *same ticks* or the
  // diptych compares different moments. Filming starts when the stone is 34 m out and runs
  // for a fixed count, so frame N of `before` and frame N of `after` are the same tick.
  if (shots > 0 || st.d < 34) {
    const tag = String(shots).padStart(2, '0');
    const name = `${tag}-t${String(n).padStart(3, '0')}.png`;
    const full = path.join(OUT, name);
    await page.screenshot({ path: full });
    await page.screenshot({ path: path.join(OUT, 'crop', name),
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
    /*
     * A tight crop centred on where the stone itself projects, magnified 3x nearest-neighbour.
     *
     * A 0.34 m ball at 46 m is about twelve pixels. It is genuinely drawn — mid-flight the
     * `projectiles-flight-stone` instanced mesh reports `count: 1, visible: true` — but twelve
     * pixels of grey against brick is not something to ask anyone to adjudicate. Tracking the
     * stone's own projected pixel keeps it dead centre of every tile, which is what makes the
     * contact sheet readable as a sequence.
     */
    const sp = await page.evaluate(({ x, y, z, W2, H2 }) => {
      const c = window.__game.engine.context.camera;
      c.updateMatrixWorld();
      const e = c.projectionMatrix.clone().multiply(c.matrixWorldInverse).elements;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      return {
        px: Math.round(((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * W2),
        py: Math.round((1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5)) * H2),
      };
    }, { x: st.x, y: st.y, z: st.z, W2: W, H2: H });
    const tw = 260;
    const th = 170;
    const tx = Math.max(0, Math.min(W - tw, sp.px - tw / 2));
    const ty = Math.max(0, Math.min(H - th, sp.py - th / 2));
    await sharp(full)
      .extract({ left: Math.round(tx), top: Math.round(ty), width: tw, height: th })
      .resize(tw * 3, th * 3, { kernel: 'nearest' })
      .toFile(path.join(OUT, 'track', name));
    trackPx.push({ tick: n, px: sp.px, py: sp.py, name });
    log.push({ frame: shots, tick: n, x: +st.x.toFixed(2), y: +st.y.toFixed(2),
      z: +st.z.toFixed(2), d: +st.d.toFixed(1), stepM: +st.stepM.toFixed(2),
      top: Number.isFinite(st.top) ? +st.top.toFixed(2) : null, alive: st.alive });
    shots++;
  }
  if (!st.alive && ended === null) {
    ended = st.hitMasonry ? 'MASONRY' : 'ground/other';
    console.log(`  the stone ended on ${ended} at tick ${n},` +
      ` ${st.d.toFixed(1)} m from the tower centre, y ${st.y.toFixed(2)}`);
  }
  if (shots >= KEEP * 4) break;
}

fs.writeFileSync(path.join(OUT, 'trace.json'),
  JSON.stringify({ setup, ended, clip, frames: log, trackPx, pageErrors: errors }, null, 2));

/*
 * A one-image contact sheet of the arrival, six ticks across.
 *
 * Written per arm; `--sheet=before,after` on a later run lays two arms into one plate. The
 * pass-through itself is *occluded* — from tick 108 the stone is inside the tower's own
 * volume, behind its near face — and that is not a defect of the camera, it is the reason the
 * fault reads as "passes through walls" to a player: the stone flies at the tower, disappears,
 * and turns up on the turf inside the city. What the sheet shows is the approach, identical in
 * both arms to the metre, and then the divergence at the stone face.
 */
// Centred on the ARRIVAL, not the start of the window: the last tick the stone was alive is
// where the two arms part company, and six even ticks ending just past it is the sequence
// worth looking at. The first frames of the window are 30 m of open approach and identical.
const lastAlive = log.filter((f) => f.alive).slice(-1)[0]?.tick ?? log[0].tick;
let sheetTicks = [];
for (let k = 10; k >= 0; k -= 2) sheetTicks.push(lastAlive - k + 2);
/*
 * `--sheet-at=102,104,...` pins the tiles to explicit ticks.
 *
 * Needed because the default centres on the last live tick, and the two arms do not share
 * one: `after` dies at 107 and `before` flies on, so each picked its own six and the diptych
 * compared different moments. For a before/after plate both arms must be given the same list.
 */
if (args.has('sheet-at')) {
  sheetTicks = String(args.get('sheet-at')).split(',').map(Number).filter(Number.isFinite);
}
const tiles = [];
const TW = Math.round(260 * 3 * 0.42);
const TH = Math.round(170 * 3 * 0.42);
for (let i = 0; i < sheetTicks.length; i++) {
  const rec = trackPx.find((t) => t.tick === sheetTicks[i]);
  if (!rec) continue;
  tiles.push({
    input: await sharp(path.join(OUT, 'track', rec.name)).resize(TW, TH).png().toBuffer(),
    left: i * (TW + 6), top: 0,
  });
}
if (tiles.length) {
  await sharp({ create: { width: tiles.length * (TW + 6), height: TH, channels: 3,
    background: { r: 20, g: 20, b: 24 } } })
    .composite(tiles).toFile(path.join(OUT, 'contact-sheet.png'));
  console.log(`  contact sheet: ticks ${sheetTicks.join(', ')}`);
}
console.log(`  ${shots} frames -> ${OUT}`);
console.log(`  verdict: ${ended === 'MASONRY'
  ? 'the stone stopped on the tower'
  : 'THE STONE PASSED THROUGH THE TOWER'}` +
  (ended === null ? ' (it was still flying when the window closed)' : ''));
if (errors.length) {
  console.log('  page errors:');
  for (const e of errors.slice(0, 10)) console.log(`    ${e}`);
}
await browser.close();
