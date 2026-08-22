/**
 * RUN B — hold the Aurelian Wall as Rome. Menu to verdict, every order a real click.
 *
 * Asserts, now. See `pl-lib-emc.mjs`: the five selectors this used to poll for the end of a
 * battle match nothing the product renders, so it could not have found one.
 */
import { argsOf, boot, shot, dump, fast, hover, rightClick, rightDrag, leftClick, cam, proj, aim,
  selectHard, wallPixel, installDiag, ledger, mustEnd, ended, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/playability');
const L_ = 'runB';
const L = ledger('run B — the Aurelian Wall held');
const log = L.log; let page, browser, errs, cerrs;
const say = L.say;
const flush = () => dump(OUT, `${L_}-log`, { log, errs, cerrs, rows: L.rows });
const T = async () => page.evaluate(() => +window.__game.simTime().toFixed(1));
const step = async (n, w) => { say(`\n=== ${n}  t+${await T()}s  ${w}`); await flush(); };
const rep = () => page.evaluate(() => window.__reports());
const brief = (r) => `R=${r.strength[0]} G=${r.strength[1]} gateHp=${r.engines?.gateHp?.toFixed?.(2)} blows=${r.engines?.ramBlows} ladders=${r.engines?.laddersCrossed} towers=${(r.towers ?? []).map(t => `${t.state}:${t.crossed}`).join(',')}`;

({ browser, page, errs, cerrs } = await boot({ port: Number(A.get('port') ?? 5431), map: 'campus-martius', out: OUT, label: L_ }));
await installDiag(page);
await page.mouse.move(800, 700); await page.waitForTimeout(300);
let bays;
try {
bays = await page.evaluate(() => window.__bays());
await step('1', 'deployment on the defending side');
const dep = await page.evaluate(() => { const d = window.__game.deployment; return { active: d.active, zone: JSON.parse(JSON.stringify(d.zone)), budget: d.budget(), roster: d.roster() }; });
say('zone', dep.zone); say('budget', dep.budget); say('roster', dep.roster);
say('camera', await page.evaluate(() => { const r = window.__game.engine.rig; return { x: +r.focus.x.toFixed(0), z: +r.focus.z.toFixed(0), zoom: +r.zoom.toFixed(2), yaw: +r.yaw.toFixed(2) }; }));
await shot(page, OUT, `${L_}-1a-open`);
await page.click('.dep-add'); await page.waitForTimeout(350);
say('palette', await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row')).map(r => `${r.dataset.unit}=${r.querySelector('.dep-count').textContent}${r.querySelector('[data-d="1"]').disabled ? '[+off]' : '[+on]'}`)));
await shot(page, OUT, `${L_}-1b-palette`);
await page.click('.dep-add'); await page.waitForTimeout(250);

// --- 2. put a unit on the parapet by hand
await step('2', 'place a unit on the parapet');
const own0 = await page.evaluate(() => window.__units(0));
say('my army', own0.map(u => `${u.id}:${u.type}:${u.alive}@(${u.x},${u.z})y${u.meanY}`));
const ground = own0.filter(u => u.meanY !== null && u.meanY < 46);
say('units NOT on the wall at the start:', ground.map(u => `${u.id}:${u.type}`));
const mover = ground[0] ?? own0[0];
let s = await selectHard(page, mover.id, { zoom: 0.6, yaw: Math.PI });
say(`select ${mover.id} ${mover.type}:`, s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why} ${s.answering}/${s.probes}`);
const bTarget = bays.filter(b => b.garr).sort((p, q) => Math.abs(p.cx - mover.x) - Math.abs(q.cx - mover.x))[0];
say('aiming at bay', bTarget);
if (s.ok) {
  const wp = await wallPixel(page, bTarget, { side: -1, zoom: 0.62 });
  say(`bay ${bTarget.i}: ${wp.hit}/${wp.tried} probed pixels offer a wall order`);
  await shot(page, OUT, `${L_}-2a-aim`);
  if (wp.p) {
    const h = await hover(page, wp.p);
    say('cursor before I commit:', { cursor: h.cursor });
    const d = await rightDrag(page, wp.p, { x: wp.p.x + 80, y: wp.p.y });
    say('hint while dragging:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await page.waitForTimeout(800);
    const u = await page.evaluate((i) => window.__u(i), mover.id);
    say('after the drop:', u);
    say(`bay walkY ${bTarget.walkY}  men mean ${u.meanY}  error ${(u.meanY - bTarget.walkY).toFixed(3)} m  spread ${(u.hiY - u.loY).toFixed(3)} m`);
    await shot(page, OUT, `${L_}-2b-onparapet`);
    // can I still click them, up there, during deployment?
    const p2 = await aim(page, u.x, u.meanY + 0.9, u.z, { zoom: 0.6, yaw: Math.PI });
    if (p2) { const h2 = await hover(page, p2); say('hovering my own men on the parapet during deployment:', { cursor: h2.cursor, hovered: h2.hovered, want: mover.id }); }
  }
}
await flush();

await page.click('.dep-begin'); await page.waitForTimeout(900);
await step('3', 'battle begins');
await fast(page, 3);
say('my units and where they stand:', (await page.evaluate(() => window.__units(0))).map(u => `${u.id}:${u.type}:${u.alive}:y${u.meanY}:elev${u.elevated}`));
await shot(page, OUT, `${L_}-3-begin`);

// --- 4. traverse along the wall
await step('4', 'take a stretch of my own wall — traverse');
const wallUnits = (await page.evaluate(() => window.__units(0))).filter(u => u.elevated > 5);
say('units on the wall:', wallUnits.map(u => `${u.id}:${u.type}:${u.elevated}/${u.alive}@x${u.x}`));
const w0 = wallUnits[0];
s = await selectHard(page, w0.id, { zoom: 0.6, yaw: Math.PI });
say(`select ${w0.id}:`, s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`);
if (s.ok) {
  const far = bays.filter(b => b.garr && Math.abs(b.cx - w0.x) > 60 && Math.abs(b.cx - w0.x) < 130)[0];
  say('traverse target bay', far);
  const wp = await wallPixel(page, far, { side: -1, zoom: 0.62 });
  say(`${wp.hit}/${wp.tried} pixels answer`);
  if (wp.p) {
    const d = await rightClick(page, wp.p, { hold: 450 });
    say('hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await shot(page, OUT, `${L_}-4a-traverseorder`);
    const before = await page.evaluate((i) => window.__u(i), w0.id);
    await fast(page, 45);
    const after = await page.evaluate((i) => window.__u(i), w0.id);
    say('before x', before.x, '-> after x', after.x, ' target', far.cx, ' elevated', after.elevated, '/', after.alive);
    say('wall state', await page.evaluate((i) => window.__wallState(i), w0.id));
    await shot(page, OUT, `${L_}-4b-traversed`);
  }
}
await flush();

// --- 5. down into the city
await step('5', 'take them down into the city');
if (s.ok) {
  
  const u = await page.evaluate((i) => window.__u(i), w0.id);
  const inX = u.x, inZ = u.z + 45;
  const gy = await page.evaluate(([x, z]) => window.__game.battle.groundAt(x, z), [inX, inZ]);
  const pin = await aim(page, inX, gy, inZ, { zoom: 0.62, yaw: Math.PI });
  if (pin) {
    const d = await rightClick(page, pin, { hold: 450 });
    say('hint over the street:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await fast(page, 60);
    const after = await page.evaluate((i) => window.__u(i), w0.id);
    say('after 60 s:', after, 'wall state', await page.evaluate((i) => window.__wallState(i), w0.id));
    await shot(page, OUT, `${L_}-5-descended`);
  } else say('could not frame a street');
}
await flush();

// --- 6. back up the stairs
await step('6', 'send them back up the stairs');
if (s.ok) {
  const back = bays.filter(x => x.garr)[Math.floor(bays.filter(x => x.garr).length / 2)];
  const wp = await wallPixel(page, back, { side: -1, zoom: 0.62 });
  say(`bay ${back.i}: ${wp.hit}/${wp.tried} pixels answer`);
  if (wp.p) {
    const d = await rightClick(page, wp.p, { hold: 450 });
    say('hint:', JSON.stringify(d.hint), 'cursor', d.cursor);
    await fast(page, 70);
    const after = await page.evaluate((i) => window.__u(i), w0.id);
    say('after 70 s:', after, 'wall state', await page.evaluate((i) => window.__wallState(i), w0.id));
    await shot(page, OUT, `${L_}-6-ascended`);
  }
}
await flush();

// --- 7. fight for the wall, and the verdict
await step('7', 'let the Juthungi come');
let r = await rep();
for (let k = 0; k < 26; k++) {
  await fast(page, 25);
  r = await rep();
  const foeUp = await page.evaluate(() => window.__units(1).filter(u => u.elevated > 3).map(u => `${u.id}:${u.type}:${u.elevated}`));
  if (k % 2 === 0) say(`t+${r.t}  ${brief(r)}  enemyOnWall=${JSON.stringify(foeUp)}`);
  if (k === 6 || k === 14) await shot(page, OUT, `${L_}-7-${Math.round(r.t)}s`);
  const done = await ended(page);
  if (done) { say(`result screen at t+${r.t}: ${done.verdict} — ${done.reason}`); break; }
}
/*
 * And if the loop above ran out without one, say so as a failure rather than as a log line.
 * The sweep for "any element whose class looks resultish" that used to sit here was the
 * shape of the bug: an instrument that reports what it found instead of whether it found
 * what it was looking for.
 */
await mustEnd(page, L, { until: 1600, step: 25, label: 'the defence of Rome' });
await shot(page, OUT, `${L_}-7-end`);
say('HUD at the end:', await page.evaluate(() => window.__hud()));
} catch (e) { L.ck('the session ran without throwing', false, 'no throw', String(e).slice(0, 400)); try { await shot(page, OUT, `${L_}-crash`); } catch {} }
L.ck('no page errors', errs.length === 0, 0, errs.length);
await flush();
await browser.close();
process.exitCode = L.summary() > 0 ? 1 : 0;
