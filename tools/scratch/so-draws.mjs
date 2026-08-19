/**
 * What the siege-order HUD costs in draw calls, measured in one session on one paused world.
 *
 * Two arms, because there are two questions and one camera cannot answer both.
 *
 *   assault  the budget camera — the scenario's own boot framing, the one the 220 cap is
 *            argued at. Base, then a tower party selected so its standing berth marker and
 *            lead line are live, then base again as a drift check.
 *   hover    a camera that actually frames a bay, with the cursor on it, so the *hover*
 *            marker, the refusal box and the hint are all live and can be seen to be live
 *            before the number is believed. The first version of this file pointed the mouse
 *            at y = -21.9 — above the viewport — Playwright clamped it onto the minimap,
 *            `overUi` went true, the HUD correctly said nothing and the arm reported the
 *            feature free. An arm that never ran reports zero, which is this project's own
 *            signature for exactly that mistake.
 *
 * And the gate: `setGateDoorBroken` swaps intact leaves for wreckage, so the frame before the
 * breach and the frame after must cost the same. Measured across the breach on one page.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'carthage';
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`${base}/?quality=ultra&autoplay=0`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.menu .begin', { timeout: 60000 });
await p.click(`.menu [data-map="${MAP}"]`); await p.waitForTimeout(200);
await p.click('.menu [data-scen="assault"]'); await p.waitForTimeout(200);
await p.click('.menu .begin');
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.waitForTimeout(600);
if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) { await p.click('.dep-begin'); await p.waitForTimeout(700); }

const cam = await p.evaluate(() => { const r = window.__game.engine.rig;
  return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw }; });
const draws = async (settle = 300) => { await p.waitForTimeout(settle);
  return p.evaluate(() => window.__game.engine.renderer.info.render.calls); };
const setCam = (c) => p.evaluate((k) => window.__game.setCamera(k.x, k.z, k.zoom, k.yaw), c);
const select = (id) => p.evaluate((u) => {
  const h = window.__game.engine.context.tryGet('hud');
  const ctx = window.__game.engine.context;
  if (u < 0) h.controller.clear(ctx); else h.controller.selectOnly(u, ctx);
}, id);
const ui = () => p.evaluate(() => ({
  hint: document.querySelector('.siege-hint')?.textContent ?? '',
  shown: document.querySelector('.siege-hint')?.style.display === 'block',
  cur: document.body.dataset.siegecur ?? '',
  preview: window.__game.engine.context.tryGet('hud').siege.preview,
}));
const crew = await p.evaluate(() => window.__game.battle.siege.towers[0].unitId);

// Freeze the world: two arms taken across a moving battle differ by whatever the battle did.
await p.evaluate(() => { window.__game.engine.context.time.paused = true; });

console.log(`# ${MAP} at ultra, ${W}x${H}, world paused`);
console.log(`\n— assault camera (x ${cam.x.toFixed(0)} z ${cam.z.toFixed(0)} zoom ${cam.zoom.toFixed(2)}) — the budget framing`);
/*
 * The control that makes the number mean anything: a unit that crews **nothing**.
 *
 * `WorldOverlay` keeps two batched meshes and `flush` hides each when it is empty, so the
 * first selection of any kind takes the frame from 0 visible overlay meshes to 2 — and that
 * has been true since long before this branch. What has to be isolated is whether a *machine*
 * crew costs more than a cohort does, and the only way to see it is to select one of each at
 * the same camera. Without this arm the honest reading of "+2" is "I do not know".
 */
const plain = await p.evaluate((c) => {
  const g = window.__game, s = g.battle.siege;
  // Nearest to what the camera is looking at, so the control's own marker is *in frame*. A
  // control selected off-screen is frustum-culled and reports zero, which would make the
  // machine markers look like they cost two draws that any selection already costs.
  let best = -1, bd = Infinity;
  for (const k of g.battle.units) {
    if (k.destroyed || k.alive < 40 || s.ownsUnit(k.id) || s.isGarrisoned(k.id)) continue;
    const d = Math.hypot(k.x - c.x, k.z - c.z);
    if (d < bd) { bd = d; best = k.id; }
  }
  return best;
}, cam);
await setCam(cam); await p.mouse.move(20, 20);
const a0 = await draws();
await select(plain);
const ap = await draws();
await select(crew);
const a1 = await draws();
await select(-1);
const a2 = await draws();
console.log(`  ${a0} base   ${ap} a plain cohort selected (control)   `
  + `${a1} a tower party selected (berth marker + lead)   ${a2} base again`);
console.log(`  overlay costs ${ap - a0} draws for any selection; the machine markers add `
  + `${a1 - ap}; drift ${a2 - a0}`);

console.log('\n— a camera that frames a bay, with the cursor on it');
// Park side-on to the curtain so both the machine and a bay 30 stations along are in frame.
const spot = await p.evaluate(() => {
  const s = window.__game.battle.siege;
  const t = s.towers[0];
  const st = Math.min(s.nStations - 1, t.station + 30);
  return { st, wx: s.sx[st], wy: s.sy[st], wz: s.sz[st],
    yaw: Math.atan2(s.snx[st], s.snz[st]), tx: t.x, tz: t.z };
});
let px = null;
for (const zoom of [0.30, 0.38, 0.46, 0.56, 0.68]) {
  await setCam({ x: (spot.wx + spot.tx) / 2, z: (spot.wz + spot.tz) / 2, zoom, yaw: spot.yaw });
  await p.waitForTimeout(340);
  px = await p.evaluate((sp) => {
    const ctx = window.__game.engine.context;
    const v = new (ctx.camera.position.constructor)();
    v.set(sp.wx, sp.wy + 0.3, sp.wz).project(ctx.camera);
    if (v.z > 1) return null;
    const x = (v.x * 0.5 + 0.5) * ctx.viewW, y = (-v.y * 0.5 + 0.5) * ctx.viewH;
    return (x > 90 && x < ctx.viewW - 120 && y > 210 && y < ctx.viewH - 250) ? { x, y } : null;
  }, spot);
  if (px) break;
}
if (!px) { console.log('  could not frame a bay — arm skipped'); }
else {
  await p.mouse.move(20, 20); await p.waitForTimeout(200);
  await select(-1);
  const h0 = await draws();
  await select(plain);
  await p.mouse.move(px.x - 4, px.y - 4); await p.waitForTimeout(140);
  await p.mouse.move(px.x, px.y);
  const hp = await draws();
  await select(crew);
  await p.mouse.move(px.x - 4, px.y - 4); await p.waitForTimeout(140);
  await p.mouse.move(px.x, px.y);
  const hui = await ui();
  const h1 = await draws();
  await select(-1); await p.mouse.move(20, 20);
  const h2 = await draws();
  console.log(`  ${h0} base   ${hp} a plain cohort, same cursor (control)   `
    + `${h1} a tower party, same cursor   ${h2} base again`);
  console.log(`  overlay costs ${hp - h0} for any selection; the hover marker adds `
    + `${h1 - hp}; drift ${h2 - h0}`);
  console.log(`  LIVE CHECK — hint "${hui.hint}" shown=${hui.shown} data-siegecur=${hui.cur} `
    + `preview ${hui.preview ? `${hui.preview.kind} bay ${hui.preview.bay} ${hui.preview.refusal}` : 'null'}`);
}

console.log('\n— the leaves against their own wreckage, one paused frame, A/B/A');
await select(-1); await p.mouse.move(20, 20);
await p.evaluate(() => { window.__game.engine.context.time.paused = false; });
await p.evaluate(() => window.__game.engine.advance(250, 166));
await p.evaluate(() => { window.__game.engine.context.time.paused = true; });
/*
 * Park on the gate itself. The leaves are a 5 m chunk of a 3 km circuit and the assault
 * camera does not resolve them, so measuring the swap from there would compare two frames
 * neither of which contains the thing being swapped — and would report free whatever it cost.
 */
const gcam = await p.evaluate(() => {
  const g = window.__game.battle.siege.gateReport();
  const s = window.__game.battle.siege;
  const st = s.stationNear(g.x, g.z);
  return { x: g.x, z: g.z - 40, zoom: 0.22, yaw: st >= 0 ? Math.atan2(s.snx[st], s.snz[st]) : 0 };
});
/*
 * Toggle the chunk state on a **paused** frame rather than comparing t+215 against t+250.
 * Thirty-five seconds of battle is men dying, dust spawning and a ram withdrawing, and the
 * first version of this measured +6 draws across it and could not say which of those it was.
 * `setGateDoorBroken` is documented as visual-only and takes a `false`, so the swap can be
 * done and undone with nothing else moving — and undone last, as a drift check.
 */
await setCam(gcam);
const gid = await p.evaluate(() => window.__game.battle.siege.gateReport().id);
// Warm-up: the rig damps toward a jump and the first reading after a big camera move is the
// frame it was still travelling through. The first version of this arm read 171 / 135 / 135 —
// a "drift" of -36 on a toggle that had not happened yet.
await draws(1200);
await p.evaluate((id) => window.__game.engine.context.get('city').setGateDoorBroken(id, false), gid);
const g0 = await draws(700);
await p.evaluate((id) => window.__game.engine.context.get('city').setGateDoorBroken(id, true), gid);
const g1 = await draws(700);
await p.evaluate((id) => window.__game.engine.context.get('city').setGateDoorBroken(id, false), gid);
const g2 = await draws(700);
const gate = await p.evaluate(() => window.__game.battle.siege.gateReport());
console.log(`  ${g0} leaves hanging   ${g1} leaves wrecked   ${g2} hanging again (drift check)`);
console.log(`  delta ${g1 - g0} draws; drift ${g2 - g0}`);
/*
 * And with the gate *shut*, which is the other half of the state machine: `applyGateDoorState`
 * hangs the leaves only when the gate is neither open nor broken, so with an open gate the
 * intact leaves are hidden either way and only the wreck chunk moves. Shutting it first is
 * the case where both chunks change at once.
 */
await p.evaluate((id) => { const c = window.__game.engine.context.get('city');
  c.setGateDoorBroken(id, false); c.setGateOpen(id, false); }, gid);
const s0 = await draws(700);
await p.evaluate((id) => window.__game.engine.context.get('city').setGateDoorBroken(id, true), gid);
const s1 = await draws(700);
await p.evaluate((id) => window.__game.engine.context.get('city').setGateDoorBroken(id, false), gid);
const s2 = await draws(700);
console.log(`  shut: ${s0} leaves hanging   ${s1} leaves wrecked   ${s2} hanging again`);
console.log(`  delta ${s1 - s0} draws; drift ${s2 - s0}`);
console.log(`  gate ${gate.id} open=${gate.open} broken=${gate.gates.find(x => x.id === gate.id)?.broken} `
  + `blows=${gate.blows}`);
console.log('\nerrors:', errs.slice(0, 3));
await b.close();
