/** BY HAND: can a human break a gate and walk a cohort through it? Real menu, real mouse. */
import { argsOf, boot, shot, dump, fast, hover, rightClick, leftClick, cam, proj, aim,
  selectHard, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const OUT = path.join(ROOT, 'screenshots/gate-hand', MAP);
const L = 'hand';
const log = []; let page, browser, errs, cerrs;
const say = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const flush = () => dump(OUT, `${L}-log`, { log, errs, cerrs });
const T = async () => page.evaluate(() => +window.__game.simTime().toFixed(1));

({ browser, page, errs, cerrs } = await boot({ port: Number(A.get('port') ?? 5411), map: MAP, out: OUT, label: L }));
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);

await page.evaluate(() => {
  const g = window.__game, b = g.battle, ctx = g.engine.context;
  const city = ctx.get('city');
  window.__gates = () => city.getGates().map(gg => ({ id: gg.id, x: gg.x, z: gg.z, open: gg.open,
    facing: gg.facing, nx: Math.sin(gg.facing), nz: Math.cos(gg.facing) }));
  window.__rep = () => { const r = window.__siege().gateReport();
    return { open: r.open, blows: r.blows, hp: r.hp, id: r.id, gates: r.gates }; };
  window.__inside = (gid, unitId) => {
    const gg = window.__gates().find(x => x.id === gid); if (!gg) return null;
    const nx = gg.nx, nz = gg.nz, dx = nz, dz = -nx;
    const p = b.pool; const u = unitId != null ? b.unitById(unitId) : null;
    let all = 0, mine = 0, mineAlive = 0, near = 0;
    for (let i = 0; i < p.count; i++) {
      const st = p.state[i];
      if (st === 10 || st === 11) continue;
      if (p.faction[i] !== 0) continue;
      const ax = p.x[i] - gg.x, az = p.z[i] - gg.z;
      const along = ax * nx + az * nz;
      const lat = Math.abs(ax * dx + az * dz);
      const street = b.elevated[i] === 0;
      const isMine = u && u.members.includes(i);
      if (isMine) mineAlive++;
      if (along < -14 && street) { all++; if (isMine) mine++; }
      if (lat <= 16 && along >= 0 && along < 40) near++;
    }
    return { all, mine, mineAlive, near };
  };
});

const gates0 = await page.evaluate(() => window.__gates());
say('gates at deployment:', JSON.stringify(gates0.map(g => ({ id: g.id, open: g.open }))));
await page.click('.dep-begin'); await page.waitForTimeout(700);
await fast(page, 3);

// --- 1. drive the ram at a shut gate, by hand
const units = await page.evaluate(() => window.__units(0));
say('player cohorts:', JSON.stringify(units.filter(u => u.alive > 0).map(u => `${u.id}:${u.type}:${u.alive}`)));
const ram = units.find(u => /ram-crew/.test(u.type) && u.alive > 0);
const shutGates = gates0.filter(g => !g.open);
say('shut gates:', JSON.stringify(shutGates.map(g => g.id)));
const targetGate = shutGates[0] ?? gates0[0];
const GID = targetGate.id;
say('target gate:', GID, JSON.stringify({ x: +targetGate.x.toFixed(1), z: +targetGate.z.toFixed(1), nx: +targetGate.nx.toFixed(3), nz: +targetGate.nz.toFixed(3) }));
if (ram) {
  const s = await selectHard(page, ram.id, { zoom: 0.5 });
  say(`select ram #${ram.id} (${ram.alive} men):`, s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`);
  if (s.ok) {
    const p = await aim(page, targetGate.x, 20, targetGate.z - 4, { zoom: 0.6 });
    if (p) { const d = await rightClick(page, p, { hold: 400 });
      say(`right-click gate ${GID}: hint=${JSON.stringify(d.hint)} cursor=${d.cursor}`); }
    else say('gate would not frame');
  }
} else say('no ram crew for the player');
await flush();

// --- 2. wait for the leaves to give way
let open = false, t = 0;
for (let i = 0; i < 44 && !open; i++) {
  t = await fast(page, 15);
  const gs = await page.evaluate(() => window.__gates());
  const r = await page.evaluate(() => window.__rep());
  open = !!gs.find(g => g.id === GID && g.open);
  if (i % 3 === 0 || open) say(`  t+${t}  blows=${r.blows} hp=${r.hp.toFixed(2)} focus=${r.id} open=${r.open} ${GID}open=${open}`);
}
say(`\n>>> gate ${GID} open at t+${t}: ${open}`);
if (!open) { say('ABORT: the gate never broke'); await flush(); await browser.close(); process.exit(0); }
const tOpen = t;
await shot(page, OUT, `${L}-01-gate-open`);

// --- 3. select a healthy foot cohort and order it through, by hand
const now = await page.evaluate(() => window.__units(0));
const g1 = (await page.evaluate(() => window.__gates())).find(x => x.id === GID);
const cand = now.filter(u => u.alive >= 40 && u.morale > 25 && !/onager|ram-|tower-|scorpi|balli/.test(u.type))
  .map(u => ({ ...u, d: Math.hypot(u.x - g1.x, u.z - g1.z) })).sort((a, b) => a.d - b.d);
say('candidates (nearest first):', JSON.stringify(cand.slice(0, 5).map(u => `${u.id}:${u.type}:${u.alive}:mor${u.morale}:${u.d.toFixed(0)}m`)));
let picked = null, sel = null;
for (const c of cand.slice(0, 4)) {
  const s = await selectHard(page, c.id, { zoom: 0.5 });
  say(`select #${c.id} ${c.type}:`, s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes} px`})` : `FAILED ${s.why}`);
  if (s.ok) { picked = c; sel = s; break; }
}
if (!picked) { say('ABORT: could not select any cohort by hand'); await flush(); await browser.close(); process.exit(0); }

const DEPTH = 45;
const aimX = g1.x - g1.nx * DEPTH, aimZ = g1.z - g1.nz * DEPTH;
say(`aim point: ${DEPTH} m cityward of ${GID} = (${aimX.toFixed(1)}, ${aimZ.toFixed(1)})`);
const gy = await page.evaluate(([x, z]) => {
  const tr = window.__game.engine.context.tryGet('terrain');
  return tr && tr.heightAt ? tr.heightAt(x, z) : 0;
}, [aimX, aimZ]);
const ap = await aim(page, aimX, gy + 0.3, aimZ, { zoom: 0.55 });
if (!ap) { say('ABORT: the point inside the gate will not frame'); await flush(); await browser.close(); process.exit(0); }
const hv = await hover(page, ap);
say('cursor over the point inside:', JSON.stringify({ cursor: hv.cursor, groundValid: hv.groundValid, orderX: hv.orderX, orderZ: hv.orderZ }));
const d = await rightClick(page, ap, { hold: 300 });
say('right-click inside the city: hint=', JSON.stringify(d.hint), 'cursor=', d.cursor);
const after = await page.evaluate((i) => { const u = window.__game.battle.unitById(i);
  return u ? { order: u.order, tx: +u.targetX.toFixed(1), tz: +u.targetZ.toFixed(1), wp: u.waypoints.length } : null; }, picked.id);
say(`unit #${picked.id} after the click:`, JSON.stringify(after), ` (asked for ${aimX.toFixed(1)},${aimZ.toFixed(1)})`);
await shot(page, OUT, `${L}-02-ordered`);
await flush();

// --- 4. does it get through?
say('\nt      unitXZ         ord  wp  aliveOfCohort  cohortInside  allPlayerInside  nearGateOutside');
for (let i = 0; i < 14; i++) {
  const tt = await fast(page, 10);
  const u = await page.evaluate((id) => { const q = window.__game.battle.unitById(id);
    return q ? { x: +q.x.toFixed(0), z: +q.z.toFixed(0), o: q.order, wp: q.waypoints.length, n: q.alive, m: Math.round(q.morale) } : null; }, picked.id);
  const c = await page.evaluate(([gid, id]) => window.__inside(gid, id), [GID, picked.id]);
  say(`${String(Math.round(tt)).padStart(4)}  (${String(u.x).padStart(5)},${String(u.z).padStart(5)})  ${u.o}   ${String(u.wp).padStart(2)}  ${String(u.n).padStart(4)} (mor ${String(u.m).padStart(3)})  ${String(c.mine).padStart(6)}        ${String(c.all).padStart(6)}          ${String(c.near).padStart(6)}`);
  if (Math.round(tt) >= tOpen + 30 && i === 2) await shot(page, OUT, `${L}-03-gate-mouth-plus30`);
}
say('\npageerrors:', errs.length, JSON.stringify(errs.slice(0, 3)));
await flush();
await browser.close();
