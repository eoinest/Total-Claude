#!/usr/bin/env node
/**
 * Banner alignment check.
 *
 * Verifies, numerically, that every DOM unit banner sits directly over the unit it
 * represents: horizontally centred on the unit's own centroid and above the tallest man
 * in the block. Projection is recomputed here from the camera's matrices rather than
 * borrowed from the HUD, so a bug in the HUD's projection cannot hide behind this test.
 *
 * Also exercises the banner as a hit target: hover, click-to-select and shift-click.
 *
 * Usage:
 *   node tools/banner-check.mjs --port=5363
 *   node tools/banner-check.mjs --dpr=2 --quality=high --w=1920 --h=1080
 *   node tools/banner-check.mjs --json=/tmp/before.json     # save for a before/after diff
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const W = Number(args.get('w') ?? 1600);
const H = Number(args.get('h') ?? 900);
const DPR = Number(args.get('dpr') ?? 1);
const QUALITY = args.get('quality') ?? 'ultra';
const PORT = Number(args.get('port') ?? 5199);
const JSON_OUT = args.get('json');
const AT = Number(args.get('at') ?? 3);

/** Camera stations: zoom 0..1 crossed with a few compass yaws. */
const STATIONS = [];
for (const zoom of [0.30, 0.45, 0.62, 0.78, 0.92]) {
  for (const yaw of [0, Math.PI * 0.37, Math.PI * 0.82, Math.PI * 1.4]) {
    STATIONS.push({ zoom, yaw });
  }
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

let server = null;
async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  if (await waitForServer(base, 1200)) return base;
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', TC_NO_HMR: '1' },
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });
  if (!(await waitForServer(base, 60000))) {
    console.error(log.slice(-3000));
    throw new Error('dev server did not come up');
  }
  return base;
}

// ---------------------------------------------------------------------------
// In-page: independent projection of a unit's own centroid
// ---------------------------------------------------------------------------

/**
 * Runs in the browser. Returns one record per unit whose banner is on screen, holding
 * the banner's measured DOM box and the independently projected anchor points.
 */
const MEASURE = ({ }) => {
  const g = window.__game;
  const cam = g.engine.context.camera;
  const canvas = g.engine.renderer.domElement;
  const cr = canvas.getBoundingClientRect();
  const battle = g.battle;
  const pool = battle.pool;

  // Column-major 4x4 apply, so this does not depend on three's Vector3.project.
  const apply = (e, x, y, z, w) => [
    e[0] * x + e[4] * y + e[8] * z + e[12] * w,
    e[1] * x + e[5] * y + e[9] * z + e[13] * w,
    e[2] * x + e[6] * y + e[10] * z + e[14] * w,
    e[3] * x + e[7] * y + e[11] * z + e[15] * w,
  ];
  const project = (x, y, z) => {
    const v = apply(cam.matrixWorldInverse.elements, x, y, z, 1);
    const c = apply(cam.projectionMatrix.elements, v[0], v[1], v[2], v[3]);
    if (Math.abs(c[3]) < 1e-9) return null;
    const nx = c[0] / c[3];
    const ny = c[1] / c[3];
    const nz = c[2] / c[3];
    return {
      // CSS pixels in viewport coordinates, matching getBoundingClientRect.
      px: cr.left + (nx * 0.5 + 0.5) * cr.width,
      py: cr.top + (-ny * 0.5 + 0.5) * cr.height,
      behind: nz < -1 || nz > 1,
    };
  };

  /** A man is 1.75 m tall. Riders sit about 1.1 m higher. */
  const MAN = 1.75, LIFT = 1.15;

  const out = [];
  for (const u of battle.units) {
    if (u.destroyed || u.alive === 0) continue;
    const bnr = document.querySelector(`.bnr[data-unit="${u.id}"]`);
    const cls = battle.typeOf(u).unitClass;
    const mounted = cls === 'heavy-cavalry' || cls === 'light-cavalry';
    const man = MAN + (mounted ? LIFT : 0);

    // Every living man in the unit is projected individually, and the banner is judged
    // against where the block actually lands on screen. Nothing here shares arithmetic
    // with the HUD — no world centroid, no formation rectangle, no terrain sample — so
    // the test cannot agree with the code by construction.
    let sumX = 0, n = 0, topHead = Infinity, sumZd = 0;
    let wx = 0, wz = 0, wy = -Infinity;
    const xs = [];
    const ys = [];
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (pool.state[i] === 11 || pool.state[i] === 10) continue; // dead / dying
      const head = project(pool.x[i], pool.y[i] + man, pool.z[i]);
      if (!head || head.behind) continue;
      sumX += head.px; n++;
      xs.push(head.px);
      ys.push(head.py);
      if (head.py < topHead) topHead = head.py;
      wx += pool.x[i]; wz += pool.z[i];
      if (pool.y[i] > wy) wy = pool.y[i];
      sumZd += Math.hypot(cam.position.x - pool.x[i], cam.position.y - pool.y[i],
                          cam.position.z - pool.z[i]);
    }
    if (n === 0) continue;
    // Projection of the *world* centroid, as distinct from the mean of the projected men.
    // Perspective is nonlinear, so on a 30 m frontage seen obliquely these two differ by
    // several pixels on their own. Reporting both separates a placement error from the
    // inherent gap between the two definitions of "the middle of the unit".
    const worldMid = project(wx / n, wy + 3.6 + (mounted ? LIFT : 0), wz / n);
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const pct = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
    const pctY = (q) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];

    const style = bnr ? getComputedStyle(bnr) : null;
    const visible = bnr
      ? !bnr.classList.contains('off') && style.visibility !== 'hidden' && Number(style.opacity) > 0.02
      : false;
    const r = bnr ? bnr.getBoundingClientRect() : null;
    out.push({
      id: u.id,
      typeId: u.typeId,
      faction: u.faction,
      alive: u.alive,
      men: n,
      hasEl: !!bnr,
      visible,
      opacity: style ? Number(style.opacity) : 0,
      // Independently measured truth, all in CSS pixels on screen.
      /** Mean screen x of the unit's men — where the block reads as being. */
      wantX: sumX / n,
      /** Screen x of the projected world centroid of the same men. */
      wantXworld: worldMid ? worldMid.px : null,
      /** Screen y of the topmost head in the block — the far rank at an oblique angle. */
      headY: topHead,
      /** Screen y of the median head: the middle of the block's silhouette. */
      headMedY: pctY(0.5),
      /** Middle 90% of the block's on-screen width. */
      spanLo: pct(0.05),
      spanHi: pct(0.95),
      /**
       * Fraction of the unit's men whose heads are lower on screen than the bottom of the
       * plaque. 1 means the plaque is clear above the whole block; 0.5 means it is sitting
       * halfway down the silhouette.
       */
      belowFrac: r ? ys.filter((y) => y > r.bottom).length / n : null,
      // Measured DOM box.
      gotCx: r ? r.left + r.width / 2 : null,
      gotBottom: r ? r.bottom : null,
      gotTop: r ? r.top : null,
      gotW: r ? r.width : null,
      gotH: r ? r.height : null,
      distance: sumZd / n,
      onScreen: sumX / n >= 0 && sumX / n <= cr.width && topHead >= 0 && topHead <= cr.height,
    });
  }

  // Diagnosis, not assertion: replay each of the HUD's own drop rules so that a hidden
  // banner can be attributed to a rule rather than left as "hidden, cause unknown" — which
  // is exactly where a mis-projection would go unnoticed.
  const terrain = g.engine.context.tryGet('terrain');
  const bar = document.querySelector('.hud-bottom');
  const barTop = bar ? bar.offsetTop : cr.height;
  const bottomReserve = Math.max(0, g.engine.context.viewH - barTop + 6);
  const zoom = g.engine.rig.zoom;
  const vw = g.engine.context.viewW;
  const vh = g.engine.context.viewH;
  for (const r of out) {
    if (r.visible) continue;
    const u = battle.units.find((q) => q.id === r.id);
    let sx = 0, sz = 0, sy = 0, n = 0;
    for (let k = 0; k < u.members.length; k++) {
      const i = u.members[k];
      if (pool.state[i] === 11 || pool.state[i] === 10) continue;
      sx += pool.x[i]; sz += pool.z[i]; if (pool.y[i] > sy || n === 0) sy = pool.y[i]; n++;
    }
    if (!n) continue;
    const cls2 = battle.typeOf(u).unitClass;
    const lift = cls2 === 'heavy-cavalry' || cls2 === 'light-cavalry' ? LIFT : 0;
    const tx = sx / n, tz = sz / n, ty = sy + 3.6 + lift;
    const a = project(tx, ty, tz);
    // Canvas-relative, which is the frame the HUD's own clamp works in.
    const px = a ? a.px - cr.left : 0;
    const py = a ? a.py - cr.top : 0;
    r.anchorPx = px;
    r.anchorPy = py;
    r.clampedOut = !a || a.behind || px < -80 || px > vw + 80 || py < -60 || py > vh - bottomReserve;
    r.underBar = !!a && py > vh - bottomReserve && py <= vh;
    r.occluded = false;
    if (terrain && typeof terrain.heightAt === 'function' && zoom > 0.45 && !r.clampedOut) {
      // Same eight-sample sight line the HUD uses, with the same range-scaled slack.
      const slack = 4 + r.distance * 0.06;
      for (let s = 1; s <= 8; s++) {
        const f = s / 9;
        const x = cam.position.x + (tx - cam.position.x) * f;
        const y = cam.position.y + (ty - cam.position.y) * f;
        const z = cam.position.z + (tz - cam.position.z) * f;
        if (terrain.heightAt(x, z) > y + slack) { r.occluded = true; break; }
      }
    }
  }

  return {
    out,
    barTop, bottomReserve,
    canvas: { left: cr.left, top: cr.top, width: cr.width, height: cr.height,
              bufW: canvas.width, bufH: canvas.height },
    dpr: window.devicePixelRatio,
    pixelRatio: g.engine.renderer.getPixelRatio(),
    viewW: g.engine.context.viewW,
    viewH: g.engine.context.viewH,
    zoom: g.engine.rig.zoom,
    yaw: g.engine.rig.yaw,
  };
};

// ---------------------------------------------------------------------------

const rows = [];
let browser = null;
let failed = 0;

try {
  const base = await startServer();
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage',
           '--hide-scrollbars'],
  });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: DPR,
  });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // autoplay=0 so the player still owns Rome and selection is meaningful.
  const url = `${base}/?harness=1&autoplay=0&quality=${QUALITY}&w=${W}&h=${H}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, { timeout: 120000 });
  await page.evaluate((at) => {
    const g = window.__game;
    while (g.simTime() < at - 1e-6) g.advance(Math.min(0.5, at - g.simTime()));
  }, AT);

  console.log(`banner-check  ${W}x${H}  dpr=${DPR}  quality=${QUALITY}`);

  for (const st of STATIONS) {
    await page.evaluate(({ zoom, yaw }) => {
      const g = window.__game;
      const b = g.battle;
      // Frame the player's own line so there is something to measure.
      let sx = 0, sz = 0, n = 0;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0 || u.faction !== 0) continue;
        sx += u.x * u.alive; sz += u.z * u.alive; n += u.alive;
      }
      g.setCamera(n ? sx / n : 0, n ? sz / n : 0, zoom, yaw);
      g.advance(0.3);
    }, st);
    // `.bnr` fades over 0.25 s of *wall* time, and `advance` moves the simulation clock
    // only. Without a real pause every banner that just came into view still reads as
    // transparent and would be scored as hidden.
    await page.waitForTimeout(450);

    const m = await page.evaluate(MEASURE, {});
    const absMax = (a) => (a.length ? Math.max(...a.map(Math.abs)) : 0);
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const stats = (set) => {
      // Horizontal: distance from the plaque's centre to the mean screen x of the men.
      const dxs = set.map((r) => r.gotCx - r.wantX);
      // Vertical: clearance between the plaque's lowest pixel and the *median* head, which
      // is the middle of the block's on-screen silhouette. Measuring against the topmost
      // head instead would be wrong — at an oblique angle the far rank's heads legitimately
      // project above a marker that is nearer the camera.
      const gaps = set.map((r) => r.headMedY - r.gotBottom);
      const above = set.filter((r) => r.headMedY - r.gotBottom >= -0.5).length;
      // Share of the block's men the plaque sits clear above.
      const below = set.map((r) => r.belowFrac);
      // And it must sit within the block's own on-screen width, not beside it.
      const inSpan = set.filter((r) => r.gotCx >= r.spanLo - 2 && r.gotCx <= r.spanHi + 2).length;
      // Against the projected world centroid, and the perspective gap between the two.
      const dxw = set.filter((r) => r.wantXworld !== null).map((r) => r.gotCx - r.wantXworld);
      const nonlin = set.filter((r) => r.wantXworld !== null).map((r) => r.wantX - r.wantXworld);
      return {
        n: set.length,
        dxMean: +mean(dxs).toFixed(1), dxMax: +absMax(dxs).toFixed(1),
        dxWorldMax: +absMax(dxw).toFixed(1), perspectiveMax: +absMax(nonlin).toFixed(1),
        gapMean: +mean(gaps).toFixed(1),
        gapMin: +(set.length ? Math.min(...gaps) : 0).toFixed(1),
        gapMax: +(set.length ? Math.max(...gaps) : 0).toFixed(1),
        belowMean: +mean(below).toFixed(2),
        belowMin: +(set.length ? Math.min(...below) : 0).toFixed(2),
        above, aboveHeads: `${above}/${set.length}`,
        inSpan, inSpanStr: `${inSpan}/${set.length}`,
        worst: set.length
          ? set.slice().sort((a, b) => Math.abs(b.gotCx - b.wantX) - Math.abs(a.gotCx - a.wantX))[0]
          : null,
      };
    };
    // Everything the HUD is drawing at all, and — separately — the ones a player can
    // actually see and click. A plaque at 6% opacity is on its way out of a close-up.
    const shown = m.out.filter((r) => r.visible && r.gotCx !== null);
    const solid = shown.filter((r) => r.opacity >= 0.25);
    // Why the rest are not drawn. The close-in fade is meant to be what hides a banner
    // during a melee; anything hidden while on screen and outside the fade band is a
    // projection or occlusion problem, not a design choice.
    const hidden = m.out.filter((r) => !r.visible);
    const why = { offScreen: 0, nearFade: 0, farFade: 0, occluded: 0, underBar: 0,
                  unexplained: 0, unexplainedIds: [] };
    for (const r of hidden) {
      if (r.underBar) why.underBar++;
      else if (r.clampedOut) why.offScreen++;
      else if ((r.distance - 28) / 42 < 0.05) why.nearFade++;
      else if (r.distance > 2000) why.farFade++;
      else if (r.occluded) why.occluded++;
      else {
        why.unexplained++;
        why.unexplainedIds.push(
          `${r.typeId}#${r.id}@${Math.round(r.distance)}m px=${Math.round(r.anchorPx)},${Math.round(r.anchorPy)}`);
      }
    }

    rows.push({
      zoom: st.zoom, yaw: +st.yaw.toFixed(2),
      liveZoom: +m.zoom.toFixed(3),
      units: m.out.length, shown: shown.length,
      all: stats(shown), solid: stats(solid), why,
      dxMax: stats(shown).dxMax, gapMin: stats(shown).gapMin,
      canvas: m.canvas, viewW: m.viewW, viewH: m.viewH,
      pixelRatio: m.pixelRatio, dpr: m.dpr,
    });
    const r = rows[rows.length - 1];
    const a = r.all;
    const s = r.solid;
    const w = a.worst;
    console.log(
      `  z${String(st.zoom).padEnd(4)} yaw ${String(r.yaw).padStart(5)} ` +
      `shown ${String(r.shown).padStart(2)}/${String(r.units).padStart(2)} | ` +
      `dx mean ${String(a.dxMean).padStart(6)} max ${String(a.dxMax).padStart(6)} ` +
      `(vs world ${String(a.dxWorldMax).padStart(5)}, persp ${String(a.perspectiveMax).padStart(5)})  ` +
      `medgap min ${String(a.gapMin).padStart(6)} mean ${String(a.gapMean).padStart(6)}  ` +
      `clearOf ${String(a.belowMean).padStart(4)}/${String(a.belowMin).padStart(4)}  ` +
      `above ${a.aboveHeads.padEnd(6)} inSpan ${a.inSpanStr.padEnd(6)} | ` +
      `solid dx ${String(s.dxMax).padStart(5)} above ${s.aboveHeads.padEnd(6)} | ` +
      `hid off=${why.offScreen} fade=${why.nearFade + why.farFade} occl=${why.occluded} ` +
      `bar=${why.underBar} ??=${why.unexplained}` +
      (w ? `  worstdx=${w.typeId}#${w.id} op=${w.opacity.toFixed(2)}` : '')
    );
  }

  // ---- Interaction: hover, click, shift-click on a banner --------------------
  const interaction = await (async () => {
    await page.evaluate(() => {
      const g = window.__game;
      const b = g.battle;
      let sx = 0, sz = 0, n = 0;
      for (const u of b.units) {
        if (u.destroyed || u.alive === 0 || u.faction !== 0) continue;
        sx += u.x * u.alive; sz += u.z * u.alive; n += u.alive;
      }
      g.setCamera(n ? sx / n : 0, n ? sz / n : 0, 0.62, Math.PI * 0.82);
      g.advance(0.5);
      // Start from an empty selection so the result is unambiguous.
      for (const u of b.units) u.selected = false;
    });

    // Own-faction banners well inside the frame, so a click cannot miss off an edge or
    // land on the card bar.
    const targets = await page.evaluate(() => {
      const g = window.__game;
      const picked = [];
      for (const u of g.battle.units) {
        if (u.destroyed || u.faction !== 0) continue;
        const e = document.querySelector(`.bnr[data-unit="${u.id}"]`);
        if (!e || e.classList.contains('off')) continue;
        if (Number(getComputedStyle(e).opacity) < 0.5) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        // Aim at the plate, which is the top of the column.
        const plate = e.querySelector('.bnr-plate');
        const pr = plate ? plate.getBoundingClientRect() : r;
        const x = pr.left + pr.width / 2;
        const y = pr.top + pr.height / 2;
        if (x < 90 || x > innerWidth - 90 || y < 90 || y > innerHeight - 220) continue;
        picked.push({ id: u.id, x, y });
      }
      return picked;
    });
    if (targets.length < 2) return { ok: false, note: 'fewer than two banners on screen' };

    // Two that are far apart, so a single stray hit cannot satisfy both steps.
    let a = targets[0], b = targets[1], sep = -1;
    for (const p of targets) {
      for (const q of targets) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > sep) { sep = d; a = p; b = q; }
      }
    }

    // Hover. The name fades in over 0.18 s of *wall* time, which `advance` does not
    // consume, so the pause is real rather than simulated.
    await page.mouse.move(a.x, a.y);
    await page.evaluate(() => window.__game.advance(0.2));
    await page.waitForTimeout(400);
    const hover = await page.evaluate(() => {
      const hud = window.__game.engine.context.tryGet('hud');
      const el = document.querySelector('.bnr.hov');
      return {
        hoveredUnitId: hud ? hud.hoveredUnitId : -1,
        hovClass: el ? Number(el.dataset.unit) : -1,
        cursor: document.body.dataset.cur,
        uiCapture: window.__game.engine.context.input.uiCapture,
        nameShown: el ? getComputedStyle(el.querySelector('.bnr-name')).opacity : null,
      };
    });

    // The wheel must still reach the camera with the cursor sitting on a plaque.
    const zoomBefore = await page.evaluate(() => window.__game.engine.rig.zoom);
    await page.mouse.wheel(0, -400);
    await page.evaluate(() => window.__game.advance(0.4));
    const zoomAfter = await page.evaluate(() => window.__game.engine.rig.zoom);
    // Put it back where it was.
    await page.evaluate(({ z }) => {
      const g = window.__game;
      g.setCamera(g.engine.rig.focus.x, g.engine.rig.focus.z, z, g.engine.rig.yaw);
      g.advance(0.4);
    }, { z: zoomBefore });
    await page.mouse.move(a.x, a.y);
    await page.evaluate(() => window.__game.advance(0.2));

    // Click to select
    await page.mouse.click(a.x, a.y);
    await page.evaluate(() => window.__game.advance(0.25));
    const afterClick = await page.evaluate(() =>
      window.__game.battle.units.filter((u) => u.selected).map((u) => u.id));

    // Shift-click a second banner to add
    await page.keyboard.down('Shift');
    await page.mouse.move(b.x, b.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up('Shift');
    await page.evaluate(() => window.__game.advance(0.25));
    const afterShift = await page.evaluate(() =>
      window.__game.battle.units.filter((u) => u.selected).map((u) => u.id));

    // A click on empty sky must still reach the world (and clear the selection),
    // proving the banner layer does not swallow clicks that miss a banner.
    await page.mouse.move(8, Math.round(H * 0.5));
    const overSky = await page.evaluate(() => window.__game.engine.context.input.uiCapture);
    await page.mouse.click(8, Math.round(H * 0.5));
    await page.evaluate(() => window.__game.advance(0.25));
    const afterSky = await page.evaluate(() =>
      window.__game.battle.units.filter((u) => u.selected).map((u) => u.id));

    return {
      ok: true,
      clickedBanner: a, secondBanner: b, separationPx: Math.round(sep),
      hover,
      wheelOverBanner: { zoomBefore: +zoomBefore.toFixed(3), zoomAfter: +zoomAfter.toFixed(3),
                         reachedCamera: Math.abs(zoomAfter - zoomBefore) > 0.01 },
      afterClick, selectedExpected: afterClick.length === 1 && afterClick[0] === a.id,
      afterShift, shiftAdded: afterShift.length === 2 && afterShift.includes(a.id) && afterShift.includes(b.id),
      afterSky, clearedBySkyClick: afterSky.length === 0,
      uiCaptureOverSky: overSky,
    };
  })();

  console.log('\ninteraction:', JSON.stringify(interaction, null, 2));

  // ---- HUD cost -------------------------------------------------------------
  // Measured with the banner layer on and then off, so the plaques' own share of the
  // HUD's frame cost is separated from the rest of the interface.
  let hudMs = null;
  let hudMsNoBanners = null;
  try {
    const cost = await page.evaluate(() => {
      const g = window.__game;
      const hud = g.engine.context.tryGet('hud');
      // The HUD's own figure is an exponential average, and this machine is shared with
      // other builds, so take the minimum over many samples: interference can only ever
      // push a sample up.
      const sample = () => {
        let best = Infinity;
        for (let s = 0; s < 40; s++) {
          for (let i = 0; i < 15; i++) g.engine.frame(g.engine.time.elapsed * 1000 + 16.7);
          if (hud && hud.hudMs < best) best = hud.hudMs;
        }
        return best === Infinity ? null : best;
      };
      sample();
      const on = sample();
      const b = hud && hud.banners;
      if (b) b.enabled = false;
      sample();
      const off = sample();
      if (b) b.enabled = true;
      sample();
      return { on, off };
    });
    hudMs = cost.on;
    hudMsNoBanners = cost.off;
  } catch (e) {
    console.error(`hud cost measurement failed: ${e.message}`);
  }
  console.log(
    `\nhud ${hudMs === null ? 'n/a' : hudMs.toFixed(3)} ms/frame` +
    (hudMsNoBanners !== null ? `  (${hudMsNoBanners.toFixed(3)} with the banner layer off)` : '')
  );

  if (errors.length) {
    failed++;
    console.error(`\n⚠ console errors:\n  ${[...new Set(errors)].slice(0, 10).join('\n  ')}`);
  }

  const withShown = rows.filter((r) => r.shown > 0);
  const summary = {
    at: new Date().toISOString(), W, H, DPR, QUALITY, hudMs, hudMsNoBanners,
    dxMaxOverall: Math.max(0, ...withShown.map((r) => r.all.dxMax)),
    dxMaxSolid: Math.max(0, ...withShown.map((r) => r.solid.dxMax)),
    gapMinOverall: Math.min(0, ...withShown.map((r) => r.all.gapMin)),
    belowHeads: withShown.reduce((s, r) => s + (r.all.n - r.all.above), 0),
    outOfSpan: withShown.reduce((s, r) => s + (r.all.n - r.all.inSpan), 0),
    totalMeasured: withShown.reduce((s, r) => s + r.all.n, 0),
    unexplainedHidden: rows.reduce((s, r) => s + r.why.unexplained, 0),
    rows, interaction, errors: [...new Set(errors)],
  };
  console.log(
    `\nover ${summary.totalMeasured} banner placements: worst |dx| ${summary.dxMaxOverall.toFixed(1)} px ` +
    `(${summary.dxMaxSolid.toFixed(1)} px among fully-opaque), ` +
    `worst head clearance ${summary.gapMinOverall.toFixed(1)} px, ` +
    `${summary.belowHeads} below the median head, ${summary.outOfSpan} outside the block's width, ` +
    `${summary.unexplainedHidden} hidden for no reason the fade/occlusion/bar rules explain`
  );
  if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(`FATAL: ${err.stack ?? err.message}`);
  failed++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}

process.exit(failed > 0 ? 1 : 0);
