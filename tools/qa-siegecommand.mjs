#!/usr/bin/env node
/**
 * QA: the siege train under the player's hand, from the player's seat.
 *
 * Two arms, both driven with a real mouse through the real menu — no `?harness=1`, no siege
 * verb called directly. An API-level test passed while wall descent was entirely broken and
 * the owner found it in play; this file exists so that cannot happen to escalade.
 *
 *   climb   select a legionary cohort of the line, right-click the bay a bank of ladders is
 *           leaning on, and count how many of *its* men reach the parapet. Reports the
 *           per-unit-type crossing ledger before and after, which is the "who can climb
 *           what" question stated as a number.
 *   tower   select a tower party, right-click a *different* bay, and follow the machine to
 *           its new dock. Asserts the two numbers docking is measured by — 0.32 m of
 *           daylight and a ramp lip level with the walk — and the **signed** orientation of
 *           the drawn ramp, read off the InstancedMesh matrix. A ladder once passed 24
 *           assertions while rendered 180 degrees wrong, so a magnitude is not evidence.
 *
 * Usage: node tools/qa-siegecommand.mjs --port=5412 [--only=climb|tower] [--shots=dir]
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5412);
const ONLY = args.get('only') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const JSON_OUT = args.get('json') ?? null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;

const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• dev server ${base}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

const results = [];
let failed = 0;
const record = (name, pass, what, changed, note = '') => {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(24)} ${what}`);
  console.log(`        -> ${changed}${note ? `  [${note}]` : ''}`);
};

const INSTALL = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  window.__ctl = () => { const h = ctx.tryGet('hud'); return h ? h.controller : null; };
  const v = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => {
    v.set(x, y, z).project(ctx.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * ctx.viewW, y: (-v.y * 0.5 + 0.5) * ctx.viewH };
  };
  window.__hovered = () => { const c = window.__ctl(); return c ? c.model.hoveredId : -2; };
  window.__selected = () => { const c = window.__ctl(); return c ? c.model.selection.slice() : []; };
  window.__cursor = () => {
    const c = window.__ctl();
    return c ? { wallValid: c.wallValid, wallX: +c.wallX.toFixed(2), wallZ: +c.wallZ.toFixed(2),
      wallY: +c.wallY.toFixed(2), solidY: +c.solidY.toFixed(2), hovered: c.model.hoveredId,
      hint: document.querySelector('.drag-hint')?.textContent ?? '' } : null;
  };
  /** Every man of `id` standing above `y`, and the unit's own vertical spread. */
  window.__up = (id, y) => {
    const u = g.battle.unitById(id);
    if (!u) return null;
    const p = g.battle.pool;
    let n = 0, up = 0, sy = 0, hi = -1e9;
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      n++; sy += p.y[i];
      if (p.y[i] > y) up++;
      if (p.y[i] > hi) hi = p.y[i];
    }
    /*
     * Why he is not moving, if he is not moving. `owned` says the siege system has him,
     * `slotted` says it actually wrote him a destination — those are two different failures
     * and the whole of the descent bug was the second one wearing the first one's face.
     */
    const s = g.battle.siege;
    let slotted = 0, nearFoot = Infinity, onPath = 0, dx = 0, dz = 0;
    const feet = (s.ladders ?? []).filter((l) => (l.boarders ?? []).includes(id));
    for (const i of u.members) {
      if (!p.aliveAt(i)) continue;
      if (s.crossOf[i] !== -1) onPath++;
      if (g.battle.slotX[i] !== 0 || g.battle.slotZ[i] !== 0) slotted++;
      for (const l of feet) {
        const d = Math.hypot(p.x[i] - l.x, p.z[i] - l.z);
        if (d < nearFoot) { nearFoot = d; dx = +(g.battle.slotX[i] - p.x[i]).toFixed(1);
          dz = +(g.battle.slotZ[i] - p.z[i]).toFixed(1); }
      }
    }
    return { alive: n, above: up, meanY: n ? +(sy / n).toFixed(2) : 0, maxY: n ? +hi.toFixed(2) : 0,
      garrisoned: s.isGarrisoned(u.id), order: u.order,
      owned: s.owned.has(u.id), slotted, onPath, banks: feet.length,
      nearFoot: Number.isFinite(nearFoot) ? +nearFoot.toFixed(1) : null,
      slotOff: `${dx},${dz}` };
  };
  /** Who is enrolled on which machine, by unit type. The "who can climb what" ledger. */
  window.__ledger = () => {
    const s = g.battle.siege;
    const name = (uid) => { const u = g.battle.unitById(uid); return u ? u.typeId : `#${uid}`; };
    return {
      towers: (s.towers ?? []).map((t) => ({
        id: t.id, station: t.station, state: t.state, crossed: t.crossed,
        boarders: (t.boarders ?? [t.unitId]).map(name),
        queue: t.crossing ? t.crossing.queue.length : 0,
      })),
      ladderBanks: [...new Map((s.ladders ?? []).map((l) => [l.unitId, l])).values()].map((l) => ({
        crew: name(l.unitId), station: l.station,
        boarders: (l.boarders ?? [l.unitId]).map(name),
        crossed: (s.ladders ?? []).filter((k) => k.unitId === l.unitId)
          .reduce((a, k) => a + k.crossed, 0),
      })),
    };
  };
  window.__towers = () => g.battle.siege.towerReport().map((t, i) => ({
    ...t,
    station: g.battle.siege.towers[i].station,
    heave: +(g.battle.siege.towers[i].heave ?? 0).toFixed(1),
    facing: +g.battle.siege.towers[i].facing.toFixed(3),
    wantFacing: +(g.battle.siege.towers[i].wantFacing ?? 0).toFixed(3),
    dockX: +g.battle.siege.towers[i].dockX.toFixed(2),
    dockZ: +g.battle.siege.towers[i].dockZ.toFixed(2),
    unitId: g.battle.siege.towers[i].unitId,
  }));
};

/**
 * A fresh battle per arm.
 *
 * The two arms cannot share one. Every tower is docked and boarding by t+120, so a tower
 * arm that runs after a climb arm has nothing left to re-aim — measured exactly that way
 * on the first run of this file. `probe-walltraffic` learned the same lesson and says so.
 */
let page, errs, settle, shot, run;
async function boot(label) {
  if (page) await page.close();
  page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  settle = (ms = 300) => page.waitForTimeout(ms);
  shot = async (n) => { if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${n}.png`) }); };
  // `engine.advance(s, 166)` is exact and four times faster than the default step.
  run = (s) => page.evaluate((n) => window.__game.engine.advance(n, 166), s);

  console.log(`\n— ${label}: Carthage, assault, the real menu, ?autoplay=0`);
  await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu .begin', { timeout: 60000 });
  await page.click('.menu [data-map="carthage"]');
  await settle(220);
  await page.click('.menu [data-scen="assault"]');
  await settle(220);
  await page.click('.menu .begin');
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.evaluate(INSTALL);
  await settle(500);
  if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) {
    await page.click('.dep-begin');
    await settle(700);
  }
  record(`boot-${label}`, true, 'BEGIN BATTLE, then BEGIN BATTLE again out of the deployment plaque',
    `${await page.evaluate(() => window.__game.battle.units.length)} units, clock running`);
}

/** Park a camera that shows every point, and hand back the pixels. */
async function frame(pts, yaw) {
  for (const zoom of [0.34, 0.46, 0.58, 0.70, 0.82, 0.94]) {
    await page.evaluate(([list, z, y]) => {
      let cx = 0, cz = 0;
      for (const p of list) { cx += p.x; cz += p.z; }
      window.__game.setCamera(cx / list.length, cz / list.length, z, y);
    }, [pts, zoom, yaw]);
    await settle(340);
    const out = await page.evaluate((l) => l.map((p) => window.__project(p.x, p.y, p.z)), pts);
    if (out.every((p) => p && p.x > 70 && p.x < 1530 && p.y > 210 && p.y < 660)) return { out, zoom };
  }
  return { out: null, zoom: -1 };
}

/** Hover until the cursor really is over `id`, then left-click. Returns the pixel or null. */
async function selectUnit(id, px) {
  let at = null;
  outer: for (const r of [0, 12, 26, 44, 68, 96]) {
    for (const a of r === 0 ? [0] : [0, 1, 2, 3, 4, 5, 6, 7]) {
      const x = px.x + Math.cos((a * Math.PI) / 4) * r;
      const y = px.y + Math.sin((a * Math.PI) / 4) * r;
      await page.mouse.move(x, y);
      await settle(110);
      if ((await page.evaluate(() => window.__hovered())) === id) { at = { x, y }; break outer; }
    }
  }
  if (at) { await page.mouse.click(at.x, at.y); await settle(300); }
  return at;
}

// ---------------------------------------------------------------------------
// Arm 1 — a cohort of the line, up somebody else's ladders
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'climb') {
  await boot('climb');
  console.log('\n— climb: a legionary cohort ordered onto a bank of ladders');
  // Let the escalade parties get their ladders up and start climbing, so the "before"
  // ledger is the shipped behaviour rather than an empty field.
  await run(120);
  const before = await page.evaluate(() => window.__ledger());
  console.log('  before — who is enrolled on what:');
  for (const b of before.ladderBanks) {
    console.log(`    ladders of ${b.crew} @ station ${b.station}: boarders [${b.boarders.join(', ')}], `
      + `${b.crossed} men across`);
  }
  for (const t of before.towers) {
    console.log(`    tower ${t.id} @ station ${t.station}: boarders [${t.boarders.join(', ')}], `
      + `${t.crossed} across`);
  }

  const pick = await page.evaluate(() => {
    const g = window.__game;
    const s = g.battle.siege;
    const bank = (s.ladders ?? [])[0];
    if (!bank) return { fail: 'no ladders' };
    // A cohort of the line: not a crew, not a garrison, on the field side.
    const cands = g.battle.units.filter((u) => u.faction === 0 && !u.destroyed && u.alive > 60
      && !s.owned.has(u.id) && !s.isGarrisoned(u.id));
    if (cands.length === 0) return { fail: 'no free cohort' };
    let best = cands[0], bd = Infinity;
    for (const u of cands) {
      const d = Math.hypot(u.x - bank.x, u.z - bank.z);
      if (d < bd) { bd = d; best = u; }
    }
    const st = bank.station;
    return {
      unit: { id: best.id, typeId: best.typeId, x: best.x, z: best.z, alive: best.alive },
      dist: Math.round(bd),
      // The masonry the ladders are against, at walk height: the stone the owner would click.
      wall: { x: s.sx[st], y: s.sy[st], z: s.sz[st] },
      walkY: s.sy[st],
      station: st,
    };
  });
  if (pick.fail) record('climb-setup', false, 'find a cohort and a bank of ladders', pick.fail);
  else {
    console.log(`  cohort ${pick.unit.id} (${pick.unit.typeId}, ${pick.unit.alive} men), `
      + `${pick.dist} m from the ladders at station ${pick.station}`);
    const unitPt = await page.evaluate((p) => ({ x: p.x, y: window.__game.battle.groundAt(p.x, p.z), z: p.z }),
      { x: pick.unit.x, z: pick.unit.z });
    // Look at the wall from the field, which is where the storming player's camera is.
    const yaw = await page.evaluate((st) => {
      const s = window.__game.battle.siege;
      return Math.atan2(s.snx[st], s.snz[st]);
    }, pick.station);
    const framed = await frame([unitPt, { x: pick.wall.x, y: pick.wall.y + 0.2, z: pick.wall.z }], yaw);
    if (!framed.out) record('climb-frame', false, 'frame the cohort and the wall together', 'gave up');
    else {
      const [pxUnit, pxWall] = framed.out;
      const at = await selectUnit(pick.unit.id, pxUnit);
      record('climb-select', (await page.evaluate(() => window.__selected()))[0] === pick.unit.id,
        `left-click cohort ${pick.unit.id}`,
        `selection [${(await page.evaluate(() => window.__selected())).join(',')}]`);
      await page.mouse.move(pxWall.x, pxWall.y);
      await settle(340);
      const cur = await page.evaluate(() => window.__cursor());
      await shot('climb-hover');
      record('climb-cursor', cur.wallValid,
        'the cursor over an enemy curtain, with a storming cohort selected',
        `wallValid ${cur.wallValid} at (${cur.wallX}, ${cur.wallZ}) y ${cur.wallY} `
        + `(solid y ${cur.solidY}), hint "${cur.hint}"`);
      const b4 = await page.evaluate(([id, y]) => window.__up(id, y), [pick.unit.id, pick.walkY - 3]);
      await page.mouse.click(pxWall.x, pxWall.y, { button: 'right' });
      await settle(300);
      await run(30);
      const enrolled = await page.evaluate(() => window.__ledger());
      const mine = pick.unit.typeId;
      const onBank = enrolled.ladderBanks.some((b) => b.boarders.includes(mine))
        || enrolled.towers.some((t) => t.boarders.includes(mine));
      record('climb-enrolled', onBank,
        `right-click the curtain with cohort ${pick.unit.id} selected`,
        `ladder banks now carry ${JSON.stringify(enrolled.ladderBanks.map((b) => b.boarders))}, `
        + `towers ${JSON.stringify(enrolled.towers.map((t) => t.boarders))}`);
      const marks = [];
      for (const s of [60, 120, 180, 240, 300]) {
        await run(60);
        marks.push({ t: s, ...(await page.evaluate(([id, y]) => window.__up(id, y),
          [pick.unit.id, pick.walkY - 3])) });
      }
      await shot('climb-after');
      console.log('  cohort trace:');
      for (const m of marks) {
        console.log(`    t+${String(m.t).padStart(3)}  alive ${m.alive}  on the wall ${m.above}  `
          + `maxY ${m.maxY}  owned ${m.owned}  slotted ${m.slotted}  onPath ${m.onPath}  `
          + `banks ${m.banks}  nearestFoot ${m.nearFoot}  slotOffset ${m.slotOff}  order ${m.order}`);
      }
      const peak = marks.reduce((a, m) => (m.above > a.above ? m : a), marks[0]);
      const after = await page.evaluate(() => window.__ledger());
      /*
       * Peak, not endpoint. The cohort that went up this bank was down to 26 men by t+300 —
       * it climbed into a Punic garrison and was destroyed on the walk, which is the battle
       * working, not the order failing. The question is whether the player's men got up,
       * and the honest answers to that are the high-water mark on the parapet and the bank's
       * own crossing count.
       */
      const crossedBefore = before.ladderBanks.reduce((a, x) => a + x.crossed, 0);
      const crossedAfter = after.ladderBanks.reduce((a, x) => a + x.crossed, 0);
      record('climb-men-up', peak.above > 0,
        `men of ${pick.unit.typeId} standing above ${(pick.walkY - 3).toFixed(1)} m — the walk`,
        `${b4.above} -> peak ${peak.above} at t+${peak.t} (maxY ${peak.maxY}), `
        + `ladder crossings ${crossedBefore} -> ${crossedAfter} (+${crossedAfter - crossedBefore})`);
      console.log('  after — the ledger:');
      for (const b of after.ladderBanks) {
        console.log(`    ladders of ${b.crew}: boarders [${b.boarders.join(', ')}], ${b.crossed} across`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Arm 2 — a tower sent to a bay of the player's choosing
// ---------------------------------------------------------------------------
if (!ONLY || ONLY === 'tower') {
  await boot('tower');
  console.log('\n— tower: a machine re-aimed by the player, and measured where it docks');
  // Only far enough for the crews to form up on their machines. A tower is docked and
  // boarding by t+120, and a docked tower is not a tower you can send anywhere.
  await run(25);
  const t0 = await page.evaluate(() => window.__towers());
  console.log(`  towers: ${t0.map((t) => `#${t.id} ${t.state} station ${t.station} dist ${t.dist.toFixed(0)}`).join(' | ')}`);
  const pick = await page.evaluate(() => {
    const g = window.__game;
    const s = g.battle.siege;
    // The machine with the furthest to run, so there is room for the order to mean anything.
    let t = null;
    for (const k of s.towers) if (k.state === 0 && (!t || k.dist > t.dist)) t = k;
    if (!t) return { fail: 'no tower still approaching' };
    // A bay well clear of its own and of every other tower's — the player choosing.
    const taken = new Set(s.towers.map((k) => k.station));
    let want = -1;
    for (let d = 24; d <= 160; d += 8) {
      for (const sgn of [1, -1]) {
        const cand = t.station + sgn * d;
        if (cand < 0 || cand >= s.nStations) continue;
        if ([...taken].some((k) => Math.abs(k - cand) < 16)) continue;
        if (s.dead && s.dead(cand)) continue;
        want = cand;
        break;
      }
      if (want >= 0) break;
    }
    if (want < 0) return { fail: 'no free bay' };
    return {
      towerId: t.id, unitId: t.unitId, from: t.station, to: want,
      crew: g.battle.unitById(t.unitId)?.typeId ?? '?',
      crewAt: { x: g.battle.unitById(t.unitId).x, z: g.battle.unitById(t.unitId).z },
      wall: { x: s.sx[want], y: s.sy[want], z: s.sz[want] },
      oldDock: { x: t.dockX, z: t.dockZ },
    };
  });
  if (pick.fail) record('tower-setup', false, 'find a tower and a free bay', pick.fail);
  else {
    console.log(`  tower ${pick.towerId} crewed by ${pick.crew}: station ${pick.from} -> ${pick.to}`);
    const crewPt = await page.evaluate((p) => ({ x: p.x, y: window.__game.battle.groundAt(p.x, p.z), z: p.z }),
      pick.crewAt);
    const yaw = await page.evaluate((st) => {
      const s = window.__game.battle.siege;
      return Math.atan2(s.snx[st], s.snz[st]);
    }, pick.to);
    const framed = await frame([crewPt, { x: pick.wall.x, y: pick.wall.y + 0.2, z: pick.wall.z }], yaw);
    if (!framed.out) record('tower-frame', false, 'frame the tower party and the target bay', 'gave up');
    else {
      const [pxCrew, pxWall] = framed.out;
      await selectUnit(pick.unitId, pxCrew);
      const sel = await page.evaluate(() => window.__selected());
      record('tower-select', sel[0] === pick.unitId, `left-click the ${pick.crew}`,
        `selection [${sel.join(',')}]`);
      await page.mouse.move(pxWall.x, pxWall.y);
      await settle(340);
      const cur = await page.evaluate(() => window.__cursor());
      await shot('tower-hover');
      record('tower-cursor', cur.wallValid, 'the cursor over the bay the player has chosen',
        `wallValid ${cur.wallValid} at (${cur.wallX}, ${cur.wallZ}), hint "${cur.hint}"`);
      await page.mouse.click(pxWall.x, pxWall.y, { button: 'right' });
      await settle(300);
      await page.evaluate(() => window.__game.engine.advance(0.4));
      const t1 = (await page.evaluate(() => window.__towers()))[pick.towerId];
      record('tower-reaimed', t1.station === pick.to,
        `right-click bay ${pick.to} with the tower party selected`,
        `station ${pick.from} -> ${t1.station}, dock (${t1.dockX}, ${t1.dockZ}) `
        + `was (${pick.oldDock.x.toFixed(2)}, ${pick.oldDock.z.toFixed(2)}), heave ${t1.heave}s`);
      // Committed: it must not move while the gang is shifting rollers.
      const xz0 = { x: t1.x, z: t1.z };
      await run(6);
      const t2 = (await page.evaluate(() => window.__towers()))[pick.towerId];
      record('tower-heaves-before-it-rolls', Math.hypot(t2.x - xz0.x, t2.z - xz0.z) < 0.05,
        'six seconds after the order, while the gang shifts the rollers',
        `moved ${Math.hypot(t2.x - xz0.x, t2.z - xz0.z).toFixed(3)} m, heave ${t2.heave}s left, `
        + `facing ${t2.facing} -> want ${t2.wantFacing}`);

      const trace = [];
      let docked = null;
      for (let k = 0; k < 14 && !docked; k++) {
        await run(40);
        const t = (await page.evaluate(() => window.__towers()))[pick.towerId];
        trace.push({ t: (k + 1) * 40, state: t.state, dist: +t.dist.toFixed(1), station: t.station });
        if (t.state !== 'approach') docked = t;
      }
      console.log('  approach:');
      for (const m of trace) console.log(`    t+${String(m.t).padStart(3)}  ${m.state}  ${m.dist} m to run`);
      // Let the ramp fall and the first men across.
      await run(40);
      const t3 = (await page.evaluate(() => window.__towers()))[pick.towerId];
      await shot('tower-docked');
      record('tower-docks-where-sent', t3.station === pick.to && t3.docked,
        `the machine arrives at the bay the player picked`,
        `station ${t3.station}, state ${t3.state}, ${t3.dist.toFixed(2)} m to run`);
      record('tower-clearance', Math.abs(t3.faceGap - 0.32) < 0.06,
        'daylight between the front face and the masonry',
        `faceGap ${t3.faceGap.toFixed(3)} m against the 0.32 m the docking contract is measured at`);
      record('tower-ramp-level', Number.isFinite(t3.rampY) && Math.abs(t3.rampY - t3.walkY) < 0.02,
        'the drawn ramp lip against the wall-walk it bridges to',
        `ramp head y ${Number.isFinite(t3.rampY) ? t3.rampY.toFixed(3) : 'not drawn'} `
        + `vs walk ${t3.walkY.toFixed(3)} — ${Number.isFinite(t3.rampY)
          ? ((t3.rampY - t3.walkY) * 100).toFixed(1) : '?'} cm`);
      /*
       * The signed one. `rampReach = hingeOff - headOff` is positive only when the lip is
       * *closer* to the wall than its own hinge, i.e. the drawbridge opens toward the
       * parapet. Every magnitude in this arm is satisfied by a ramp yawed 180 degrees.
       */
      record('tower-ramp-opens-forward', t3.rampDrawn && t3.rampReach > 0.3,
        'the drawn ramp reaches toward the wall, read off the InstancedMesh matrix',
        `signed reach ${t3.rampDrawn ? t3.rampReach.toFixed(3) : 'not drawn'} m `
        + `(hinge ${t3.rampHingeOff.toFixed(2)}, head ${t3.rampHeadOff.toFixed(2)}, `
        + `want head ${t3.wantHeadOff.toFixed(2)})`,
        t3.rampReach <= 0 ? 'NEGATIVE: the drawbridge is drawn backwards' : '');
      await run(80);
      const t4 = (await page.evaluate(() => window.__towers()))[pick.towerId];
      record('tower-delivers', t4.crossed > 0,
        'men come over the ramp at the new bay',
        `${t4.crossed} across, ${t4.queued} on the path`);
    }
  }
}

if (errs.length) record('console-clean', false, 'page errors', errs.slice(0, 3).join(' | '));
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}  (${results.length} checks)`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results }, null, 2));
await browser.close();
process.exit(failed === 0 ? 0 : 1);
