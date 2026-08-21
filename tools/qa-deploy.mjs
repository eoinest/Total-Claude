#!/usr/bin/env node
/**
 * QA: the pre-battle deployment phase, driven the way a player drives it.
 *
 * Every check below fires a real Playwright mouse or keyboard event at real screen
 * coordinates and then asserts on state read back out of `window.__game`. Nothing calls a
 * placement function directly — a test that did would pass while the feature was
 * unreachable, and that exact gap shipped a broken wall-descent feature on this project.
 *
 * Three arms:
 *   menu    the true player path — no `?harness`, click BEGIN BATTLE in the real menu,
 *           and check the phase is what you land in
 *   field   select, drag to place, facing, frontage, formation key, remove, add, commit
 *   wall    drop a ground unit on the parapet and measure where its men ended up against
 *           `CitySystem.getGarrisonBays()` — the city's own published numbers, not the
 *           siege system's internals
 *
 * Usage: node tools/qa-deploy.mjs [--port=5311] [--json=path] [--shots=dir] [--only=arm]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5311);
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const ONLY = args.get('only') ?? null;
const W = 1600, H = 900;

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

const results = [];
let failed = 0;
function record(name, pass, what, changed, note = '') {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(24)} ${what}`);
  console.log(`        → ${changed}${note ? `  [${note}]` : ''}`);
}

/** Instrumentation installed on every page: projection, and a read-only unit snapshot. */
const INSTALL = () => {
  const g = window.__game;
  window.__tape = [];
  for (const k of ['selectionChanged', 'orderIssued', 'deploymentBegan', 'deploymentEnded',
    'deploymentChanged']) {
    g.engine.events.on(k, (p) => window.__tape.push({ k, p: JSON.parse(JSON.stringify(p ?? {})) }));
  }
  window.__selection = () => {
    const t = window.__tape.filter((e) => e.k === 'selectionChanged').pop();
    return t ? t.p.unitIds : [];
  };
  const v = g.engine.context.camera.position.clone();
  window.__project = (x, y, z) => {
    v.set(x, y, z).project(g.engine.context.camera);
    if (v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * g.engine.context.viewW,
      y: (-v.y * 0.5 + 0.5) * g.engine.context.viewH,
    };
  };
  window.__unit = (id) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    const p = g.battle.pool;
    let n = 0, sx = 0, sz = 0, sy = 0;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; sx += p.x[i]; sz += p.z[i]; sy += p.y[i];
    }
    return {
      id: u.id, typeId: u.typeId, alive: u.alive, order: u.order,
      x: +u.x.toFixed(2), z: +u.z.toFixed(2), facing: +u.facing.toFixed(4),
      width: u.width, formationId: u.formationId, destroyed: u.destroyed,
      men: n,
      menX: n ? +(sx / n).toFixed(2) : 0,
      menZ: n ? +(sz / n).toFixed(2) : 0,
      menY: n ? +(sy / n).toFixed(2) : 0,
      garrisoned: g.battle.siege.isGarrisoned(u.id),
    };
  };
  window.__depState = () => {
    const d = g.deployment;
    if (!d) return null;
    return {
      active: d.active, committed: d.committed, zone: { ...d.zone },
      budget: d.budget(), paused: g.engine.time.paused,
      plaque: !!document.querySelector('.deploy'),
      refusal: d.lastRefusal,
    };
  };
  window.__cursor = () => {
    const hud = g.engine.context.tryGet('hud');
    return hud ? hud.cursorWorld : null;
  };
};

const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  page.__errs = errs;
  return page;
};
const settle = (page, ms = 320) => page.waitForTimeout(ms);
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

const measured = {};

/**
 * Park the camera so every one of `pts` projects well inside the frame, and hand back the
 * pixels. Widens the zoom until it fits rather than assuming one — a hardcoded camera
 * photographs empty grass as reliably as a hardcoded click box.
 */
async function frameAndProject(page, pts, yaw = Math.PI) {
  for (const zoom of [0.34, 0.44, 0.54, 0.64, 0.74, 0.84]) {
    const px = await page.evaluate(([list, z, y]) => {
      const g = window.__game;
      let cx = 0, cz = 0;
      for (const p of list) { cx += p.x; cz += p.z; }
      cx /= list.length; cz /= list.length;
      g.setCamera(cx, cz, z, y);
      return null;
    }, [pts, zoom, yaw]);
    void px;
    await settle(page, 380);
    const out = await page.evaluate((list) => list.map((p) => {
      const g = window.__game;
      return window.__project(p.x, g.battle.groundAt(p.x, p.z) + (p.lift ?? 1), p.z);
    }), pts);
    // y > 200 clears the top plaque (0..90) and the deployment banner (111..159), and
    // y < H-230 the card bar: a gesture aimed at a panel is captured by `input.uiCapture`
    // and never reaches the field, which is correct behaviour and useless to test against.
    const ok = out.every((p) => p && p.x > 60 && p.x < window_W - 60
      && p.y > 200 && p.y < window_H - 230);
    if (ok) return { px: out, zoom };
  }
  return { px: null, zoom: -1 };
}
const window_W = W, window_H = H;

// ---------------------------------------------------------------------------
// Arm 1 — the true player path: the menu, and what you land in
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'menu') {
  console.log('\n— front door → setup → deployment (no ?harness, the real player path)');
  const page = await newPage();
  await page.goto(`${base}/?quality=high`, { waitUntil: 'domcontentloaded' });
  /*
   * The menu opens on the front door, and the setup screen is one click in.
   *
   * No `?menu=battle` here, which is the escape hatch the wall probes use: this arm's whole
   * job is the path a player takes, and a player takes the door. `waitForSelector` defaults
   * to waiting for *visibility*, so if the front door ever failed to hand over, this would
   * time out on `.menu .begin` rather than silently clicking a hidden button.
   */
  await page.waitForSelector('.menu.at-home .dest-battle', { timeout: 60000 });
  await settle(page, 600);
  await shot(page, 'menu-front-door');

  // What is actually on the door, and where each plaque goes.
  const door = await page.evaluate(() => {
    const dest = [...document.querySelectorAll('.menu-home .dest')].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        id: e.dataset.dest,
        tag: e.tagName,
        href: e.getAttribute('href'),
        target: e.getAttribute('target'),
        rel: e.getAttribute('rel'),
        label: e.querySelector('.dest-txt b')?.textContent ?? '',
        sub: (e.querySelector('.dest-txt i')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    const setup = document.querySelector('.menu-setup');
    return {
      dest,
      asides: [...document.querySelectorAll('.menu-home .aside')].map((a) => ({
        id: a.dataset.aside, href: a.getAttribute('href'), target: a.getAttribute('target'),
      })),
      // `offsetParent` is null for a `display: none` subtree, which is how the step is hidden.
      setupHidden: !!setup && setup.offsetParent === null,
    };
  });
  const ids = door.dest.map((d) => d.id).join(',');
  record('front-door-destinations', ids === 'battle,docs,viewer' && door.setupHidden
    && door.dest.every((d) => d.w > 400 && d.h > 40 && d.sub.length > 40),
    'load with no flags at all and read the three plaques off the front door',
    `${ids || 'none'}  ·  setup screen hidden ${door.setupHidden}  ·  `
      + door.dest.map((d) => `${d.id} ${d.w}×${d.h}`).join(', '),
    door.dest.map((d) => d.label).join(' / '));

  /*
   * Battle stays in this tab; everything else leaves in a new one.
   *
   * That is the rule the front door is built on — a player two minutes into an order of
   * battle must not be able to lose it to one mis-aimed click — and it is a rule made of
   * three attributes, which is exactly the kind of thing that survives a refactor only if
   * something asserts it. `rel=noopener` on every `target=_blank` as well.
   */
  const battle = door.dest.find((d) => d.id === 'battle');
  const external = door.dest.filter((d) => d.id !== 'battle');
  const externalOk = external.length === 2 && external.every(
    (d) => d.tag === 'A' && d.target === '_blank' && (d.rel ?? '').includes('noopener') && !!d.href);
  const asidesOk = door.asides.length >= 2
    && door.asides.every((a) => a.target === '_blank' && /^https:\/\//.test(a.href));
  record('front-door-leaves-safely',
    !!battle && battle.tag === 'BUTTON' && !battle.href && externalOk && asidesOk,
    'every destination that is not Battle must be an anchor into a new tab',
    `battle is a <${(battle?.tag ?? '?').toLowerCase()}> with href ${battle?.href ?? 'none'};  `
      + external.map((d) => `${d.id} → ${d.href} target ${d.target} rel ${d.rel}`).join(';  '),
    door.asides.map((a) => `${a.id} → ${a.href}`).join('  '));

  // The two links that point at things this deployment is supposed to serve. The docs are a
  // separate deployment and are not fetched here — a network check on someone else's host is
  // a flake generator — but the viewer is the second Rollup entry of *this* build, so a 404
  // on it would mean the front door offers a page that is not there.
  const viewerHref = door.dest.find((d) => d.id === 'viewer')?.href ?? '';
  let viewerStatus = 0;
  try {
    viewerStatus = (await fetch(`${base}${viewerHref}`, { signal: AbortSignal.timeout(8000) })).status;
  } catch (e) { viewerStatus = `error ${e.message}`; }
  record('front-door-viewer-served', viewerHref === '/viewer.html' && viewerStatus === 200,
    'GET the model-viewer URL the front door links to',
    `${viewerHref} → ${viewerStatus}`);

  /*
   * The keyboard, which is half of how this game is played.
   *
   * Tab to the first plaque, arrow down and back up over the list, then Enter to go in. No
   * mouse touches the page until the next block, so a regression that left the front door
   * pointer-only would fail here rather than in a bug report.
   */
  await page.keyboard.press('Tab');
  const kbTab = await page.evaluate(() => document.activeElement?.dataset?.dest ?? '?');
  await page.keyboard.press('ArrowDown');
  const kbDown = await page.evaluate(() => document.activeElement?.dataset?.dest ?? '?');
  await page.keyboard.press('ArrowUp');
  const kbUp = await page.evaluate(() => document.activeElement?.dataset?.dest ?? '?');
  await page.keyboard.press('Enter');
  await settle(page, 400);
  const kbIn = await page.evaluate(() => ({
    cls: document.querySelector('.menu')?.className ?? '',
    beginVisible: !!document.querySelector('.menu .begin')?.offsetParent,
  }));
  record('front-door-keyboard',
    kbTab === 'battle' && kbDown === 'docs' && kbUp === 'battle'
    && kbIn.cls.includes('at-setup') && kbIn.beginVisible,
    'Tab, ArrowDown, ArrowUp and Enter on the front door, with no pointer at all',
    `Tab → ${kbTab}, Down → ${kbDown}, Up → ${kbUp}, Enter → "${kbIn.cls}" `
      + `with BEGIN BATTLE visible ${kbIn.beginVisible}`);

  /*
   * Back out of the setup and return: the army must still be there.
   *
   * This is the whole reason the two screens share one `MainMenu` and one DOM. A menu that
   * rebuilt the setup on each visit would pass every check above and quietly throw away two
   * minutes of work here — and worse, would leave the old rows in memory with live handlers,
   * which is the failure `buildArmies` is commented about.
   */
  const armyOf = () => page.evaluate(() => ({
    scen: [...document.querySelectorAll('.menu [data-scen]')]
      .filter((b) => b.classList.contains('on')).map((b) => b.dataset.scen).join(),
    counts: [...document.querySelectorAll('.menu .ucount')].map((c) => c.textContent).join(','),
    seed: document.querySelector('.menu .seed')?.value ?? '',
    hour: document.querySelector('.menu .tod')?.value ?? '',
  }));
  await page.click('.menu .army .plus');
  await page.click('.menu [data-size="large"]');
  await settle(page, 250);
  const armyBefore = await armyOf();
  await page.keyboard.press('Escape');
  await settle(page, 400);
  const wentHome = await page.evaluate(() => ({
    cls: document.querySelector('.menu')?.className ?? '',
    focus: document.activeElement?.dataset?.dest ?? '?',
  }));
  await shot(page, 'menu-back-at-door');
  await page.click('.menu-home .dest-battle');
  await settle(page, 400);
  const armyAfter = await armyOf();
  record('setup-back-keeps-army',
    wentHome.cls.includes('at-home') && wentHome.focus === 'battle'
    && JSON.stringify(armyBefore) === JSON.stringify(armyAfter),
    'edit the order of battle, press Escape, and click Battle again',
    `Escape → "${wentHome.cls}" with focus on ${wentHome.focus};  army `
      + (JSON.stringify(armyBefore) === JSON.stringify(armyAfter) ? 'identical' : 'CHANGED'),
    `${armyBefore.counts} @ seed ${armyBefore.seed}`);

  // Put the historical order of battle back, so the deployment this arm actually measures is
  // DEFAULT_CONFIG and not the two clicks above. `restore` keeps map, scenario and enemy.
  await page.click('.menu .restore');
  await page.click('.menu [data-size="ultra"]');
  await settle(page, 250);

  // The stored preference is empty in a fresh context, so this is DEFAULT_CONFIG: the
  // Campus Martius, field battle, ultra size, the historical order of battle.
  // `page.click` rather than a raw coordinate: the menu fades in over two frames and a
  // coordinate click lands during the transition and is swallowed.
  await page.click('.menu .begin');
  let ready = true;
  try {
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  } catch { ready = false; }
  if (!ready) {
    record('menu-boot', false, 'the page never became ready after BEGIN BATTLE',
      (await page.evaluate(() => document.getElementById('load-text')?.textContent ?? '?')),
      page.__errs.slice(0, 3).join(' | '));
  }
  if (ready) await page.evaluate(INSTALL);
  await settle(page, 600);
  const st = ready ? await page.evaluate(() => window.__depState()) : null;
  await shot(page, 'menu-deployment');
  record('menu-opens-phase', ready && !!st && st.active && st.paused && st.plaque,
    'clicked BEGIN BATTLE in the real menu with no ?harness and no ?deploy',
    st
      ? `ready ${ready}  deployment.active ${st.active}  clock paused ${st.paused}  `
        + `plaque in DOM ${st.plaque}  zone "${st.zone.label}"`
      : `ready ${ready}, no deployment on window.__game`);
  if (st) {
    measured.menuZone = st.zone;
    measured.menuBudget = st.budget;
  }

  // The plaque has to be legible, not merely present.
  const copy = await page.evaluate(() => {
    const d = document.querySelector('.deploy');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
      title: d.querySelector('.dep-title b')?.textContent ?? '',
      begin: d.querySelector('.dep-begin')?.textContent ?? '',
      help: (d.querySelector('.dep-help')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
  record('plaque-discoverable', !!copy && copy.w > 400 && copy.title === 'DEPLOYMENT'
    && copy.begin === 'BEGIN BATTLE' && copy.help.length > 40,
    'the deployment plaque is on screen before anything else is touched',
    copy ? `${copy.w}×${copy.h} px at y ${copy.top}, "${copy.title}", "${copy.begin}"` : 'absent',
    copy ? copy.help.slice(0, 110) : '');

  // Space must not release the clock behind the phase's back.
  await page.mouse.move(W / 2, H / 2);
  await page.keyboard.press('Space');
  await settle(page, 400);
  const afterSpace = await page.evaluate(() => window.__depState());
  record('clock-held', !!afterSpace && afterSpace.paused && afterSpace.active,
    'pressed Space during deployment',
    afterSpace ? `still paused ${afterSpace.paused}, phase still active ${afterSpace.active}`
      : 'no state');

  if (page.__errs.length) record('menu-console', false, 'page errors during the menu arm',
    page.__errs.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 2 — placement, formation, remove, add, commit
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'field') {
  console.log('\n— field deployment');
  const page = await newPage();
  await page.goto(`${base}/?harness=1&autoplay=0&deploy=1&quality=high&w=${W}&h=${H}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(INSTALL);
  await settle(page, 500);

  const st0 = await page.evaluate(() => window.__depState());
  record('phase-live', !!st0 && st0.active && st0.paused,
    'loaded with ?deploy=1',
    st0 ? `active ${st0.active}  paused ${st0.paused}  ${st0.budget.units} own units, `
      + `${st0.budget.men} men, ${st0.budget.free} pool places free` : 'no phase');
  if (st0) measured.fieldZone = st0.zone;

  // ---- pick a unit, and a place to stand it, and frame both ----
  const plan = await page.evaluate(() => {
    const g = window.__game;
    const d = g.deployment;
    const u = g.battle.units.find((v) => v.faction === 0 && !v.destroyed && v.alive > 100);
    // A line 70 m wide, 55 m in front of where the unit stands, well inside the zone.
    const zAhead = d.frontIsLowZ() ? u.z - 55 : u.z + 55;
    return {
      id: u.id, typeId: u.typeId,
      a: { x: u.x - 35, z: zAhead, lift: 0.4 },
      b: { x: u.x + 35, z: zAhead, lift: 0.4 },
      unitPt: { x: u.x, z: u.z, lift: 1 },
      inZone: d.contains(u.x - 35, zAhead) && d.contains(u.x + 35, zAhead),
    };
  });
  const target = { id: plan.id, typeId: plan.typeId };
  const framed = await frameAndProject(page, [plan.unitPt, plan.a, plan.b]);
  if (!framed.px) {
    record('frame', false, 'no camera framed the unit and its drop together', 'gave up');
  }
  const [posUnit, pa, pb] = framed.px ?? [null, null, null];

  const pos = posUnit;
  await page.mouse.move(pos.x, pos.y);
  await settle(page, 200);
  await page.mouse.click(pos.x, pos.y);
  await settle(page, 320);
  const selected = (await page.evaluate(() => window.__selection()))[0] ?? -1;
  const before = await page.evaluate((id) => window.__unit(id), target.id);
  record('select', selected === target.id,
    `left-click on unit ${target.id} (${target.typeId}) at (${Math.round(pos.x)},${Math.round(pos.y)})`,
    `selectionChanged → [${selected}], unit at (${before.x}, ${before.z}) width ${before.width}`);

  // ---- right-drag to place, which also sets facing and frontage ----
  const drag = { a: plan.a, b: plan.b, pa, pb, inZone: plan.inZone };
  await page.mouse.move(drag.pa.x, drag.pa.y);
  await settle(page, 150);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move((drag.pa.x + drag.pb.x) / 2, (drag.pa.y + drag.pb.y) / 2, { steps: 6 });
  await settle(page, 120);
  await page.mouse.move(drag.pb.x, drag.pb.y, { steps: 6 });
  await settle(page, 220);
  const hint = await page.evaluate(() => {
    const h = document.querySelector('.drag-hint');
    return h && h.style.display !== 'none' ? h.textContent : '';
  });
  await shot(page, 'field-drag');
  await page.mouse.up({ button: 'right' });
  await settle(page, 400);

  const after = await page.evaluate((id) => window.__unit(id), target.id);
  const dropX = (drag.a.x + drag.b.x) / 2;
  const dropZ = (drag.a.z + drag.b.z) / 2;
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  const atDrop = Math.hypot(after.x - dropX, after.z - dropZ);
  const menAtUnit = Math.hypot(after.menX - after.x, after.menZ - after.z);
  record('place-by-drag', drag.inZone && atDrop < 12 && moved > 20 && menAtUnit < 14,
    `right-drag ${Math.round(Math.hypot(drag.b.x - drag.a.x, drag.b.z - drag.a.z))} m across open ground`,
    `unit ${before.x},${before.z} → ${after.x},${after.z} (${moved.toFixed(1)} m), `
      + `${atDrop.toFixed(1)} m from the drag midpoint; men centroid `
      + `${menAtUnit.toFixed(1)} m from the anchor`,
    `hint read "${hint}"`);
  record('frontage-and-facing', after.width !== before.width || Math.abs(after.facing - before.facing) > 0.01,
    'the same drag sets men-per-rank and the bearing',
    `width ${before.width} → ${after.width}, facing ${before.facing} → ${after.facing}`);
  measured.place = { before, after, dropX: +dropX.toFixed(2), dropZ: +dropZ.toFixed(2) };

  // ---- the AI must not be steering anything ----
  const t0 = await page.evaluate(() => window.__game.simTime());
  await settle(page, 2500);
  const held = await page.evaluate((id) => ({ u: window.__unit(id), t: window.__game.simTime() }), target.id);
  const drift = Math.hypot(held.u.x - after.x, held.u.z - after.z);
  record('ai-cannot-touch-it', drift < 0.01 && held.t === t0,
    '2.5 s of wall clock with the phase live',
    `sim clock ${t0} → ${held.t} s, unit drifted ${drift.toFixed(4)} m`,
    'the AI re-plans in fixedUpdate, which a paused clock never calls');

  // ---- formation key ----
  await page.mouse.move(W / 2, H * 0.55);
  const formBefore = await page.evaluate((id) => window.__unit(id), target.id);
  const keys = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB'];
  let formAfter = formBefore;
  for (const k of keys) {
    await page.keyboard.press(k.replace('Key', ''));
    await settle(page, 260);
    formAfter = await page.evaluate((id) => window.__unit(id), target.id);
    if (formAfter.formationId !== formBefore.formationId) break;
  }
  const spread = await page.evaluate((id) => {
    const g = window.__game;
    const u = g.battle.unitById(id);
    const p = g.battle.pool;
    let lo = Infinity, hi = -Infinity;
    const c = Math.cos(u.facing), s = Math.sin(u.facing);
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      const t = (p.x[i] - u.x) * c - (p.z[i] - u.z) * s;
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    return +(hi - lo).toFixed(2);
  }, target.id);
  record('formation-key', formAfter.formationId !== formBefore.formationId,
    'pressed the formation keys with the unit selected',
    `formation ${formBefore.formationId} → ${formAfter.formationId}, `
      + `width ${formBefore.width} → ${formAfter.width}, men now span ${spread} m`);

  // ---- add a unit from the palette ----
  const budgetBefore = await page.evaluate(() => window.__depState().budget);
  await page.click('.dep-add');
  await settle(page, 300);
  const paletteRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dep-row')).map((r) => r.dataset.unit));
  const addRow = paletteRows[0];
  await page.click(`.dep-row[data-unit="${addRow}"] [data-d="1"]`);
  await settle(page, 450);
  const budgetAdd = await page.evaluate(() => window.__depState().budget);
  await shot(page, 'field-palette');
  record('add-unit', budgetAdd.units === budgetBefore.units + 1 && budgetAdd.men > budgetBefore.men,
    `clicked + on "${addRow}" in the deployment palette`,
    `units ${budgetBefore.units} → ${budgetAdd.units}, men ${budgetBefore.men} → ${budgetAdd.men}, `
      + `pool free ${budgetBefore.free} → ${budgetAdd.free}`);

  // ---- remove it again, and prove the bench gives the places back ----
  const addedId = await page.evaluate(() => {
    const own = window.__game.deployment.ownUnits();
    return own[own.length - 1].id;
  });
  await page.click(`.dep-row[data-unit="${addRow}"] [data-d="-1"]`);
  await settle(page, 400);
  const budgetRm = await page.evaluate(() => window.__depState().budget);
  const gone = await page.evaluate((id) => window.__unit(id), addedId);
  await page.click(`.dep-row[data-unit="${addRow}"] [data-d="1"]`);
  await settle(page, 450);
  const budgetRe = await page.evaluate(() => window.__depState().budget);
  record('remove-and-recycle',
    budgetRm.units === budgetBefore.units && (!gone || gone.destroyed)
      && budgetRe.units === budgetBefore.units + 1 && budgetRe.free === budgetAdd.free,
    'clicked − then + again on the same row',
    `units ${budgetAdd.units} → ${budgetRm.units} → ${budgetRe.units}; `
      + `pool free ${budgetAdd.free} → ${budgetRm.free} → ${budgetRe.free}`,
    'the second add is served off the bench, so it costs no pool places');
  measured.budget = { before: budgetBefore, add: budgetAdd, removed: budgetRm, readd: budgetRe };

  // ---- a drop outside the zone is refused, and says so ----
  {
    // Re-select the unit that was placed by hand and try to send it behind the enemy line.
    await page.evaluate((id) => {
      const g = window.__game;
      const hud = g.engine.context.tryGet('hud');
      void hud;
      return id;
    }, target.id);
    const cards2 = await page.$$('.cardbar .card:not(.foe)');
    const cb = await cards2[0].boundingBox();
    await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await settle(page, 300);
    const selNow = (await page.evaluate(() => window.__selection()))[0] ?? -1;
    const beforeOut = await page.evaluate((id) => window.__unit(id), selNow);
    const outPt = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.battle.unitById(id);
      const d = g.deployment;
      // 120 m past the forbidden edge, straight ahead into no-man's-land.
      const z = d.frontIsLowZ() ? d.zone.zMin - 120 : d.zone.zMax + 120;
      return { x: u.x, z, lift: 0.4, inZone: d.contains(u.x, z) };
    }, selNow);
    const f3 = await frameAndProject(page, [outPt]);
    let refused = null;
    if (f3.px) {
      await page.mouse.move(f3.px[0].x, f3.px[0].y);
      await settle(page, 200);
      const hint2 = await page.evaluate(() => {
        const h = document.querySelector('.drag-hint');
        return h && h.style.display !== 'none' ? h.textContent : '';
      });
      await page.mouse.down({ button: 'right' });
      await settle(page, 200);
      const hint3 = await page.evaluate(() => {
        const h = document.querySelector('.drag-hint');
        return h && h.style.display !== 'none' ? h.textContent : '';
      });
      await page.mouse.up({ button: 'right' });
      await settle(page, 350);
      const afterOut = await page.evaluate((id) => window.__unit(id), selNow);
      const st2 = await page.evaluate(() => window.__depState());
      refused = {
        moved: Math.hypot(afterOut.x - beforeOut.x, afterOut.z - beforeOut.z),
        reason: st2.refusal, hint: hint3 || hint2,
      };
    }
    record('zone-refusal', !!refused && !outPt.inZone && refused.moved < 0.01
      && /deployment zone/i.test(refused.reason),
      `right-click 120 m past the front edge of the zone with unit ${selNow} selected`,
      refused
        ? `unit moved ${refused.moved.toFixed(3)} m; refusal "${refused.reason}"; `
          + `cursor hint read "${refused.hint}"`
        : 'could not frame a point outside the zone');
  }

  // ---- the performance line warns rather than refusing ----
  {
    const perf = await page.evaluate(async () => {
      const g = window.__game;
      const d = g.deployment;
      const before = d.budget();
      // Click the palette's + until the battle is past the measured 60 fps line, or the
      // caps stop us. Real clicks, one row at a time.
      const rows = Array.from(document.querySelectorAll('.dep-row'));
      let clicks = 0;
      for (let guard = 0; guard < 12 && d.budget().men <= d.budget().perfLine; guard++) {
        const btn = rows.map((r) => r.querySelector('[data-d="1"]')).find((b) => !b.disabled);
        if (!btn) break;
        btn.click();
        clicks++;
        await new Promise((r) => setTimeout(r, 40));
      }
      return { before, after: d.budget(), clicks, warning: d.warning() };
    });
    await settle(page, 350);
    const noteOn = await page.evaluate(() => {
      const n = document.querySelector('.dep-note');
      return n ? { on: n.classList.contains('on'), text: n.textContent } : null;
    });
    record('perf-line-warns',
      perf.after.men > perf.before.men && perf.after.men > perf.after.perfLine
        && /60 fps/.test(perf.warning) && !!noteOn?.on,
      `added ${perf.clicks} units from the palette to cross PERF_VALIDATED_MEN`,
      `men ${perf.before.men} → ${perf.after.men} against a line of ${perf.after.perfLine}; `
        + `warning "${perf.warning}"; plaque note ${noteOn?.on ? 'shown' : 'absent'}`,
      'the pre-battle menu warns past this line rather than refusing, and so does this');
    // Put the army back where it was so the later checks measure what they think.
    await page.evaluate(async (n) => {
      const rows = Array.from(document.querySelectorAll('.dep-row'));
      for (let k = 0; k < n; k++) {
        const btn = rows.map((r) => r.querySelector('[data-d="-1"]')).find((b) => !b.disabled);
        if (!btn) break;
        btn.click();
        await new Promise((r) => setTimeout(r, 40));
      }
    }, perf.clicks);
    await settle(page, 350);
  }

  // ---- Delete removes the selection ----
  // Re-select off the card bar: the palette's own +/- moved the selection about, and a
  // Delete with nothing selected measures nothing.
  {
    const cs = await page.$$('.cardbar .card:not(.foe)');
    const cb = await cs[cs.length - 1].boundingBox();
    if (cb) {
      await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await settle(page, 300);
    }
  }
  const beforeDel = await page.evaluate(() => ({
    budget: window.__depState().budget, sel: window.__selection(),
  }));
  await page.mouse.move(W / 2, H * 0.55);
  await page.keyboard.press('Delete');
  await settle(page, 400);
  const afterDel = await page.evaluate(() => window.__depState().budget);
  record('delete-key',
    beforeDel.sel.length > 0 && afterDel.units === beforeDel.budget.units - beforeDel.sel.length,
    `pressed Delete with ${beforeDel.sel.length} unit(s) selected`,
    `units ${beforeDel.budget.units} → ${afterDel.units}`);

  // ---- commit ----
  const placedBefore = await page.evaluate((id) => window.__unit(id), target.id);
  await page.click('.dep-begin');
  await settle(page, 500);
  const stC = await page.evaluate(() => window.__depState());
  await page.evaluate(() => window.__game.advance(5));
  await settle(page, 400);
  const placedAfter = await page.evaluate((id) => window.__unit(id), target.id);
  const wander = Math.hypot(placedAfter.x - placedBefore.x, placedAfter.z - placedBefore.z);
  await shot(page, 'field-committed');
  record('begin-battle', !!stC && !stC.active && !stC.paused && stC.committed,
    'clicked BEGIN BATTLE on the deployment plaque',
    `active ${stC?.active}  paused ${stC?.paused}  committed ${stC?.committed}, `
      + `clock ran to t+${await page.evaluate(() => window.__game.simTime().toFixed(1))} s`);
  record('placement-survives', wander < 22,
    '5 s of battle after committing',
    `the unit placed by hand moved ${wander.toFixed(2)} m from where it was put`,
    'a placement the first tick overrides is not a placement');
  const plaqueGone = await page.evaluate(() => !document.querySelector('.deploy'));
  record('plaque-clears', plaqueGone, 'after commit', `plaque removed ${plaqueGone}`);

  if (page.__errs.length) record('field-console', false, 'page errors during the field arm',
    page.__errs.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 3 — the wall
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'wall') {
  console.log('\n— wall deployment');
  const page = await newPage();
  await page.goto(
    `${base}/?harness=1&autoplay=0&deploy=1&scenario=assault&quality=high&w=${W}&h=${H}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(INSTALL);
  await settle(page, 500);

  const setup = await page.evaluate(() => {
    const g = window.__game;
    const city = g.engine.context.tryGet('city');
    const bays = city.getGarrisonBays();
    const siege = g.battle.siege;
    // A ground unit of the player's that is not already on the wall — the reserve cohorts.
    const u = g.battle.units.find(
      (v) => v.faction === 0 && !v.destroyed && v.alive > 40 && !siege.isGarrisoned(v.id));
    // A garrisonable bay nobody is standing on, as far from the gate as the circuit allows,
    // so the measurement is not contaminated by another unit's claim.
    const busy = new Set();
    const p = g.battle.pool;
    for (const v of g.battle.units) {
      if (!siege.isGarrisoned(v.id)) continue;
      for (const i of v.members) {
        if (!p.aliveAt(i)) continue;
        const pm = siege.probeMan(i);
        if (pm.bay >= 0) busy.add(pm.bay);
      }
    }
    /*
     * A bay that is *in the deployment zone* and unoccupied, nearest the middle of the
     * zone. The circuit is 1.8 km long and the zone is the sector the army was drawn up in,
     * so "the middle free bay on the whole wall" is very often somewhere the player is not
     * allowed to deploy — which is a correct refusal and a useless thing to photograph.
     */
    const d = g.deployment;
    const zx = (d.zone.xMin + d.zone.xMax) * 0.5;
    const free = bays
      .filter((b) => b.garrisonable && !busy.has(b.index)
        && d.isWallPoint((b.x0 + b.x1) * 0.5, (b.z0 + b.z1) * 0.5))
      .sort((a, b) => Math.abs((a.x0 + a.x1) * 0.5 - zx) - Math.abs((b.x0 + b.x1) * 0.5 - zx));
    const bay = free[0] ?? bays.find((b) => b.garrisonable);
    const mid = {
      x: (bay.x0 + bay.x1) * 0.5, z: (bay.z0 + bay.z1) * 0.5,
      nx: bay.nx, nz: bay.nz,
    };
    g.setCamera(mid.x + mid.nx * 74, mid.z + mid.nz * 74, 0.30, 0);
    return {
      unitId: u ? u.id : -1, unitType: u ? u.typeId : '',
      bay: {
        index: bay.index, walkY: +bay.walkY.toFixed(3), groundY: +bay.groundY.toFixed(3),
        innerOff: +bay.innerOff.toFixed(3), outerOff: +bay.outerOff.toFixed(3),
        band: +(bay.outerOff - bay.innerOff).toFixed(3), stage: bay.stage,
        length: +bay.length.toFixed(2),
      },
      mid,
      bays: bays.length,
      garrisonable: bays.filter((b) => b.garrisonable).length,
      /*
       * The whole curtain's clear standing band, from the city's own published offsets.
       * This is the claim being checked — "2.21 to 4.06 m at the sim's 0.72 m rank pitch,
       * capped at MAX_WALL_RANKS 5" — measured across every bay a garrison can stand on,
       * rather than inferred from the single bay the click happened to land in.
       */
      bandSurvey: (() => {
        const g2 = bays.filter((b) => b.garrisonable);
        const bandsOf = g2.map((b) => +(b.outerOff - b.innerOff).toFixed(3));
        const ranksOf = bandsOf.map((w) => Math.min(5, Math.floor(w / 0.72) + 1));
        const hist = {};
        for (const r of ranksOf) hist[r] = (hist[r] ?? 0) + 1;
        return {
          n: g2.length,
          bandLo: Math.min(...bandsOf), bandHi: Math.max(...bandsOf),
          rankLo: Math.min(...ranksOf), rankHi: Math.max(...ranksOf),
          rankHistogram: hist,
          walkYLo: +Math.min(...g2.map((b) => b.walkY)).toFixed(2),
          walkYHi: +Math.max(...g2.map((b) => b.walkY)).toFixed(2),
        };
      })(),
      freeInZone: free.length,
      zone: { ...d.zone },
      unitPt: u ? { x: u.x, z: u.z, lift: 1 } : null,
    };
  });
  await settle(page, 400);

  /*
   * Select a reserve cohort off the unit-card bar.
   *
   * Not off the field: the reserves stand inside the walls among 1,136 building boxes, and
   * framing them for a world click is a camera problem this arm is not trying to test. The
   * card bar is a real player control — `UnitCards` binds `pointerdown` straight to
   * `SelectionController.selectOnly` — so this is still a click a player makes, and it is
   * the click they would actually make to pull a reserve out of the city.
   */
  let sel = -1;
  let unitId = -1;
  const cards = await page.$$('.cardbar .card:not(.foe)');
  for (const card of cards) {
    const box = await card.boundingBox();
    if (!box) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page, 220);
    const s = (await page.evaluate(() => window.__selection()))[0] ?? -1;
    if (s < 0) continue;
    const usable = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.battle.unitById(id);
      return !!u && u.alive > 40 && !g.battle.siege.isGarrisoned(u.id);
    }, s);
    if (usable) { sel = s; unitId = s; break; }
  }
  if (unitId >= 0) {
    const u = await page.evaluate((id) => window.__unit(id), unitId);
    setup.unitId = unitId;
    setup.unitType = u.typeId;
  }
  record('wall-select', sel >= 0 && sel === unitId,
    `clicked through the unit cards to a reserve that is not already on the wall`,
    `selected unit ${sel} (${setup.unitType}) from ${cards.length} own cards`,
    `${setup.garrisonable} garrisonable bays, ${setup.freeInZone} free inside the zone; `
      + `aiming at bay ${setup.bay.index} (${setup.bay.stage})`);

  /*
   * Hunt for a pixel that genuinely resolves to the parapet.
   *
   * Not a fixed camera and not a fixed pixel: whether the top face of the curtain is even
   * visible depends on the eye being above `crestY`, which depends on the zoom (the rig
   * couples pitch to zoom) and on which side you stand. Both sides and several zooms are
   * tried, and the *cursor's own answer* decides — `hud.cursorWorld.onWall` is what the click
   * will act on, so agreeing with it is the only test worth making.
   */
  let aim = null;
  const along = [0, 5, -5, 10, -10, 15, -15];
  const lift = [0.12, 0.5, 1.1, -0.4];
  /*
   * Focus *on* the bay, not on a stand-off point outside it. The rig's boom is short and
   * steep at low zoom — measured, a focus 66 m outside the curtain put the eye 12.8 m behind
   * it and 26.9 m up, and the bay itself projected to y −374, off the top of the screen.
   */
  const cams = [
    { d: 0, zoom: 0.42, yaw: 0 }, { d: 0, zoom: 0.55, yaw: 0 },
    { d: 0, zoom: 0.68, yaw: 0 }, { d: 0, zoom: 0.42, yaw: Math.PI },
    { d: 0, zoom: 0.55, yaw: Math.PI }, { d: -30, zoom: 0.55, yaw: Math.PI },
    { d: 30, zoom: 0.55, yaw: 0 },
  ];
  let camTried = [];
  /** The first pixel that hit *any* solid, so a miss can say what it hit instead. */
  let nearest = null;
  outer:
  for (const cam of cams) {
    const eye = await page.evaluate(([s, c]) => {
      const g = window.__game;
      g.setCamera(s.mid.x + s.mid.nx * c.d, s.mid.z + s.mid.nz * c.d, c.zoom, c.yaw);
      return null;
    }, [setup, cam]);
    void eye;
    await settle(page, 420);
    const eyeY = await page.evaluate(() =>
      +window.__game.engine.context.camera.position.y.toFixed(1));
    camTried.push(`${cam.d}m/${cam.zoom}/eye ${eyeY}m`);
    for (const dl of lift) {
      for (const da of along) {
        const px = await page.evaluate(([s, da2, dl2]) => {
          const ax = -s.mid.nz, az = s.mid.nx;
          return window.__project(
            s.mid.x + ax * da2, s.bay.walkY + dl2, s.mid.z + az * da2);
        }, [setup, da, dl]);
        // y > 180 clears the top plaque (0..90) and the deployment banner (111..159).
        if (!px || px.x < 30 || px.x > W - 30 || px.y < 180 || px.y > H - 210) continue;
        await page.mouse.move(px.x, px.y);
        await settle(page, 130);
        const c = await page.evaluate(() => window.__cursor());
        if (c && c.onSolid && !nearest) {
          nearest = await page.evaluate((cc) => ({
            solidX: +cc.solidX.toFixed(2), solidZ: +cc.solidZ.toFixed(2),
            station: window.__game.battle.siege.wallTargetAt(cc.solidX, cc.solidZ),
            inX: cc.solidX >= window.__game.deployment.zone.xMin
              && cc.solidX <= window.__game.deployment.zone.xMax,
          }), c);
        }
        if (c && c.onWall) { aim = { px, cursor: c, da, dl, cam, eyeY }; break outer; }
      }
    }
  }
  record('wall-cursor', !!aim,
    'moved the cursor over the parapet and asked what the click would act on',
    aim
      ? `pixel (${Math.round(aim.px.x)},${Math.round(aim.px.y)}) from an eye ${aim.eyeY} m up `
        + `resolves to the wall at (${aim.cursor.solidX.toFixed(1)}, ${aim.cursor.solidZ.toFixed(1)}) `
        + `y ${aim.cursor.solidY.toFixed(2)} m`
      : `no tested pixel resolved to the parapet; nearest solid hit ${JSON.stringify(nearest)}`,
    `cameras tried: ${camTried.join(', ')}; zone x `
      + `${Math.round(setup.zone.xMin)}..${Math.round(setup.zone.xMax)}, `
      + `bay mid x ${setup.mid.x.toFixed(1)}`);

  if (aim) {
    await shot(page, 'wall-aim');
    // Explicit down / hold / up. A zero-duration right-click can put the press and the
    // release edge in one frame, and `Input` reports one edge per frame.
    await page.mouse.down({ button: 'right' });
    await settle(page, 220);
    await page.mouse.up({ button: 'right' });
    await settle(page, 500);
    await shot(page, 'wall-placed');

    const proof = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.battle.unitById(id);
      const p = g.battle.pool;
      const siege = g.battle.siege;
      const city = g.engine.context.tryGet('city');
      const bays = city.getGarrisonBays();
      const byIndex = new Map(bays.map((b) => [b.index, b]));
      const RANK_PITCH = 0.72;

      let placed = 0, offWall = 0, inMasonry = 0, outOfBand = 0;
      let maxDy = 0, minOff = Infinity, maxOff = -Infinity;
      const rankBins = new Set();
      const baysUsed = new Set();
      let walkY = null, band = null, innerOff = null, outerOff = null;
      const heights = [];
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const pm = siege.probeMan(i);
        if (pm.station < 0) { offWall++; continue; }
        placed++;
        const bay = byIndex.get(pm.bay);
        baysUsed.add(pm.bay);
        if (!bay) continue;
        walkY = bay.walkY;
        innerOff = bay.innerOff;
        outerOff = bay.outerOff;
        band = bay.outerOff - bay.innerOff;
        const dy = Math.abs(p.y[i] - bay.walkY);
        maxDy = Math.max(maxDy, dy);
        heights.push(p.y[i]);
        if (pm.insideMasonry) inMasonry++;
        // Tolerance is the per-man normal jitter Siege applies, ±0.13 m.
        if (pm.lateralOffset < bay.innerOff - 0.14 || pm.lateralOffset > bay.outerOff + 0.14) {
          outOfBand++;
        }
        minOff = Math.min(minOff, pm.lateralOffset);
        maxOff = Math.max(maxOff, pm.lateralOffset);
        rankBins.add(Math.round((bay.outerOff - pm.lateralOffset) / RANK_PITCH));
      }
      heights.sort((a, b) => a - b);
      return {
        garrisoned: siege.isGarrisoned(u.id),
        order: u.order, alive: u.alive,
        placed, offWall, inMasonry, outOfBand,
        maxDy: +maxDy.toFixed(4),
        walkY: walkY === null ? null : +walkY.toFixed(3),
        terrainUnder: +g.battle.groundAt(u.x, u.z).toFixed(3),
        yLo: heights.length ? +heights[0].toFixed(3) : null,
        yHi: heights.length ? +heights[heights.length - 1].toFixed(3) : null,
        band: band === null ? null : +band.toFixed(3),
        innerOff: innerOff === null ? null : +innerOff.toFixed(3),
        outerOff: outerOff === null ? null : +outerOff.toFixed(3),
        offLo: Number.isFinite(minOff) ? +minOff.toFixed(3) : null,
        offHi: Number.isFinite(maxOff) ? +maxOff.toFixed(3) : null,
        ranks: rankBins.size,
        rankIds: [...rankBins].sort((a, b) => a - b),
        baysUsed: baysUsed.size,
        expectedRanks: band === null
          ? null : Math.min(5, Math.floor(band / RANK_PITCH) + 1),
      };
    }, setup.unitId);
    measured.wall = { setup, proof };

    record('wall-garrisoned', proof.garrisoned && proof.placed > 0,
      `right-click on the parapet of bay ${setup.bay.index} (${setup.bay.stage})`,
      `${proof.placed} of ${proof.alive} men on the walkway, ${proof.offWall} not, `
        + `order Garrison=${proof.order === 6}`);
    record('wall-height', proof.maxDy < 0.05 && proof.inMasonry === 0,
      "every man's feet against the bay's own published walkY",
      `walkY ${proof.walkY} m, men span y ${proof.yLo}..${proof.yHi}, `
        + `worst |Δy| ${proof.maxDy} m, ${proof.inMasonry} inside the masonry`,
      `the terrain under that point is ${proof.terrainUnder} m, so they are `
        + `${(proof.walkY - proof.terrainUnder).toFixed(2)} m up`);
    const sv = setup.bandSurvey;
    record('wall-ranks', proof.ranks >= 1 && proof.ranks <= 5 && proof.ranks === proof.expectedRanks,
      'rank count against the clear standing band at the sim 0.72 m pitch',
      `band ${proof.band} m (offsets ${proof.innerOff}..${proof.outerOff}) → `
        + `floor(${proof.band}/0.72)+1 = ${proof.expectedRanks} ranks, capped at MAX_WALL_RANKS 5; `
        + `measured ${proof.ranks} occupied ranks ${JSON.stringify(proof.rankIds)}`,
      `across all ${sv.n} garrisonable bays the band runs ${sv.bandLo}..${sv.bandHi} m → `
        + `${sv.rankLo}..${sv.rankHi} ranks ${JSON.stringify(sv.rankHistogram)}, `
        + `walkY ${sv.walkYLo}..${sv.walkYHi} m`);
    record('wall-band', proof.outOfBand === 0,
      'nobody standing off the edge of the walkway',
      `${proof.outOfBand} men outside [${proof.innerOff}, ${proof.outerOff}]; `
        + `measured offsets ${proof.offLo}..${proof.offHi} m`);

    /*
     * Take it back off the wall.
     *
     * This is the one edit that is not a move: `Siege` keeps its garrisons in private maps
     * and the only public way down — `sendToGround` — plans a descent by stair over many
     * ticks, which a paused clock will never run. So the phase retires the unit and stands
     * an identical one on the grass, and the thing worth measuring is that the wall is
     * genuinely released: no man of the new unit has a station, and the stone is free again.
     */
    {
      const before = await page.evaluate(() => window.__depState().budget);
      const gPt = await page.evaluate(() => {
        const g = window.__game;
        const d = g.deployment;
        return {
          x: (d.zone.xMin + d.zone.xMax) * 0.5,
          z: (d.zone.zMin + d.zone.zMax) * 0.5, lift: 0.4,
        };
      });
      const f4 = await frameAndProject(page, [gPt]);
      let off = null;
      if (f4.px) {
        await page.mouse.move(f4.px[0].x, f4.px[0].y);
        await settle(page, 200);
        await page.mouse.down({ button: 'right' });
        await settle(page, 200);
        await page.mouse.up({ button: 'right' });
        await settle(page, 500);
        off = await page.evaluate(([oldId, pt]) => {
          const g = window.__game;
          const d = g.deployment;
          const siege = g.battle.siege;
          const p = g.battle.pool;
          const own = d.ownUnits();
          const now = own[own.length - 1];
          let onStone = 0;
          if (now) {
            for (const i of now.members) {
              if (p.aliveAt(i) && siege.probeMan(i).station >= 0) onStone++;
            }
          }
          // Each man against the terrain *under him*, not under the drop point: a 160-man
          // block is 20 m across and the ground inside Rome is not flat.
          let worstY = 0;
          if (now) {
            for (const i of now.members) {
              if (!p.aliveAt(i)) continue;
              worstY = Math.max(worstY,
                Math.abs(p.y[i] - g.battle.groundAt(p.x[i], p.z[i])));
            }
          }
          return {
            gone: !g.battle.unitById(oldId),
            newId: now ? now.id : -1, newType: now ? now.typeId : '',
            onStone, alive: now ? now.alive : 0,
            dist: now ? +Math.hypot(now.x - pt.x, now.z - pt.z).toFixed(1) : -1,
            worstY: +worstY.toFixed(4),
            budget: d.budget(),
          };
        }, [setup.unitId, gPt]);
      }
      record('wall-to-ground',
        !!off && off.gone && off.newId >= 0 && off.onStone === 0
          && off.dist < 20 && off.worstY < 0.01,
        'right-click open ground with the garrison selected',
        off
          ? `unit ${setup.unitId} retired, ${off.newType} ${off.newId} stands `
            + `${off.dist} m from the drop with every man on the terrain `
            + `(worst |Δy| ${off.worstY} m); `
            + `${off.onStone} of ${off.alive} men still hold a wall station`
          : 'could not frame a ground point inside the zone',
        off
          ? `pool free ${before.free} → ${off.budget.free} — the wall bench cannot serve a `
            + 'ground add, so this one costs slots'
          : '');
      // The selection has to have followed the rebuild for the next click to mean anything.
      const kept = (await page.evaluate(() => window.__selection()))[0] ?? -1;
      record('selection-follows-rebuild', !!off && kept === off.newId,
        'the unit that was dragged off the wall was rebuilt, not moved',
        `selection ${setup.unitId} → ${kept}, the replacement is ${off ? off.newId : '?'}`);

      // Put it back up so the survives-the-start check measures a garrison. The ground
      // framing moved the camera, so the aim camera has to be restored before the pixel
      // that resolved to the parapet means the parapet again.
      if (off?.newId >= 0 && aim) {
        await page.evaluate(([s, c]) => {
          window.__game.setCamera(s.mid.x + s.mid.nx * c.d, s.mid.z + s.mid.nz * c.d, c.zoom, c.yaw);
        }, [setup, aim.cam]);
        await settle(page, 450);
        await page.mouse.move(aim.px.x, aim.px.y);
        await settle(page, 200);
        const back = await page.evaluate(() => window.__cursor());
        if (back?.onWall) {
          await page.mouse.down({ button: 'right' });
          await settle(page, 200);
          await page.mouse.up({ button: 'right' });
          await settle(page, 450);
        }
        setup.unitId = off.newId;
      }
    }

    // And it survives the battle starting.
    await page.click('.dep-begin');
    await settle(page, 400);
    await page.evaluate(() => window.__game.advance(4));
    await settle(page, 300);
    const kept = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.battle.unitById(id);
      const p = g.battle.pool;
      const siege = g.battle.siege;
      let on = 0, maxDy = 0;
      const city = g.engine.context.tryGet('city');
      const byIndex = new Map(city.getGarrisonBays().map((b) => [b.index, b]));
      for (const i of u.members) {
        if (!p.aliveAt(i)) continue;
        const pm = siege.probeMan(i);
        if (pm.station < 0) continue;
        on++;
        const bay = byIndex.get(pm.bay);
        if (bay) maxDy = Math.max(maxDy, Math.abs(p.y[i] - bay.walkY));
      }
      return { on, maxDy: +maxDy.toFixed(3), garrisoned: siege.isGarrisoned(u.id) };
    }, setup.unitId);
    record('wall-survives-start', kept.garrisoned && kept.on > 0 && kept.maxDy < 0.4,
      '4 s of battle after committing',
      `${kept.on} men still on the walkway, worst |Δy| ${kept.maxDy} m`);
    measured.wallAfter = kept;
  }

  if (page.__errs.length) record('wall-console', false, 'page errors during the wall arm',
    page.__errs.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------------------------------------------------------------------
// Arm 4 — a battle deployed by hand still replays identically
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'det') {
  console.log('\n— determinism through the phase');
  /**
   * Two independent page loads driven through the *same* deployment by the same real mouse
   * events, then advanced by the same schedule and hashed.
   *
   * `tools/qa-determinism.mjs` covers the battle that deploys itself; this covers the one a
   * player laid out, which is a different question. Nothing in the phase advances
   * `battle.rng` — `spawnUnit` forks a child stream and `Rng.fork` does not mutate its
   * parent — so the claim is that a hand-placed army is as replayable as a scripted one.
   */
  const HASH = `window.__poolHash = () => {
    const p = window.__game.battle.pool;
    const dv = new DataView(new ArrayBuffer(4));
    let h = 0x811c9dc5;
    const mix = (u) => {
      h ^= u & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 8) & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0;
    };
    const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
    let alive = 0;
    for (let i = 0; i < p.count; i++) {
      f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]);
      if (p.state[i] !== 10 && p.state[i] !== 11) alive++;
    }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: p.count, alive };
  };`;
  const marks = [];
  for (const label of ['A', 'B']) {
    const page = await newPage();
    await page.goto(`${base}/?harness=1&autoplay=0&deploy=1&quality=high&w=${W}&h=${H}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
    await page.evaluate(INSTALL);
    await page.evaluate(HASH);
    await settle(page, 500);

    // Identical edit both times: add a cohort, select the first card, place it on a line.
    await page.click('.dep-add');
    await settle(page, 250);
    const row = await page.evaluate(() =>
      document.querySelector('.dep-row').dataset.unit);
    await page.click(`.dep-row[data-unit="${row}"] [data-d="1"]`);
    await settle(page, 400);
    const cards = await page.$$('.cardbar .card:not(.foe)');
    const box = await cards[0].boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await settle(page, 300);
    const sel = (await page.evaluate(() => window.__selection()))[0] ?? -1;
    /*
     * A right-*click*, not a right-drag.
     *
     * A drag's frontage is the length of the line the pointer actually travelled, and the
     * number of `pointermove` events a browser delivers over a 260 px path is not a constant
     * — a busy machine coalesces them. Measured: two runs of this arm placed the same unit at
     * widths one apart, which is a different formation, which is a different t+0 hash, and
     * the arm then reported determinism broken when what had differed was the input. The
     * click branch of `buildGhosts` keeps the unit's own frontage and aims at one point, so
     * the gesture is reproducible. The drag is covered by the field arm, where the frontage
     * is the thing being measured rather than a nuisance parameter.
     */
    const pt = await page.evaluate((id) => {
      const g = window.__game;
      const u = g.battle.unitById(id);
      const d = g.deployment;
      const zA = d.frontIsLowZ() ? u.z - 40 : u.z + 40;
      return { x: u.x, z: zA, lift: 0.4 };
    }, sel);
    const f2 = await frameAndProject(page, [pt]);
    if (f2.px) {
      await page.mouse.move(f2.px[0].x, f2.px[0].y);
      await settle(page, 220);
      await page.mouse.down({ button: 'right' });
      await settle(page, 220);
      await page.mouse.up({ button: 'right' });
      await settle(page, 350);
    }
    const placed = await page.evaluate((id) => {
      const u = window.__unit(id);
      return u ? { x: u.x, z: u.z, facing: u.facing, width: u.width, f: u.formationId } : null;
    }, sel);
    /*
     * Stop the rAF loop *before* pressing BEGIN, then advance by hand.
     *
     * `tools/qa-determinism.mjs` stops it too, and the ordering matters here in a way it does
     * not there. Stopping it after the click leaves however many real frames happen between
     * the button and the `evaluate` — measured, run A reached sim 0.233 s and run B 0.200 s
     * before either had been advanced at all, and every hash differed from t+0. The button
     * itself is still a real DOM click; it just no longer has a live clock behind it.
     */
    await page.evaluate(() => window.__game.engine.stop());
    await settle(page, 150);
    await page.click('.dep-begin');
    await settle(page, 200);
    const at = [];
    for (const t of [0, 30, 90]) {
      if (t > 0) await page.evaluate(() => window.__game.advance(30));
      if (t === 90) await page.evaluate(() => window.__game.advance(30));
      at.push({
        t, sim: +(await page.evaluate(() => window.__game.simTime())).toFixed(3),
        ...(await page.evaluate(() => window.__poolHash())),
      });
    }
    marks.push({ label, framed: !!f2.px, placed, at, errs: page.__errs.slice(0, 2) });
    console.log(`  run ${label}: ${at.map((m) => `t+${m.t} sim ${m.sim} ${m.hash} (${m.alive}/${m.count})`).join('  ')}`);
    await page.close();
  }
  const [A, B] = marks;
  // Reported separately, because "the harness did not reproduce the input" and "the sim did
  // not reproduce the outcome" are different findings and only the second is a bug here.
  const sameInput = JSON.stringify(A.placed) === JSON.stringify(B.placed);
  record('deployment-reproduced', sameInput && A.framed && B.framed,
    'both runs put the unit in the same place with the same frontage',
    `A ${JSON.stringify(A.placed)}  B ${JSON.stringify(B.placed)}`);
  const same = A.at.every((m, i) =>
    m.hash === B.at[i].hash && m.count === B.at[i].count && m.sim === B.at[i].sim);
  record('deployed-battle-replays', same && sameInput && A.framed && B.framed,
    'two independent loads driven through the identical hand deployment, then advanced 60 s',
    A.at.map((m, i) => `t+${m.t} A ${m.hash} B ${B.at[i].hash} `
      + `${m.hash === B.at[i].hash ? 'IDENTICAL' : 'DIVERGED'}`).join('; '),
    `pool count ${A.at[0].count} both runs`);
  measured.determinism = marks;
}

await browser.close();
if (server) server.kill();

console.log(`\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} checks passed`);
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT),
    JSON.stringify({ results, measured }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed === 0 ? 0 : 1);
