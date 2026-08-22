/**
 * CAN I ATTACK ANYTHING?
 *
 * In three sessions on two maps, every right-click aimed at an enemy unit produced the hint
 * **"Move here"** and `model.hoveredId === -1`. That is either the most serious order bug in
 * the product — an RTS in which the attack verb cannot be issued — or my aim point missing the
 * men. Only a sweep can tell those apart, so this sweeps *both*: the same grid over one of my
 * units and over one of theirs, at the same zoom, in the same second, and reports the two hit
 * rates side by side. My own unit is the control. If mine answers and theirs does not, picking
 * is one-sided; if neither answers, my aim is the fault and the finding is withdrawn.
 */
import { argsOf, boot, ledger, dump, ff, shot, aim, hover, rightClick, selectHard, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const MAP = A.get('map') ?? 'pydna';
const SCEN = A.get('scen') ?? 'field';
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const AT = Number(A.get('at') ?? 130);
const OUT = path.join(ROOT, `screenshots/judge/attack-${MAP}`);
const L = ledger(`can I attack? — ${MAP}`);

async function sweep(page, id, label, zoom) {
  const u = await page.evaluate(i => window.__u(i), id);
  await aim(page, u.x, (u.meanY ?? 1) + 0.9, u.z, { zoom });
  await page.waitForTimeout(150);
  const box = await page.evaluate(i => window.__box(i), id);
  if (!box || !isFinite(box.x0)) { L.say(`  ${label}: not drawn on screen`); return { probes: 0, named: 0 }; }
  let probes = 0, named = 0, other = 0, first = null; const curs = {};
  for (let j = 0; j <= 7; j++) {
    const y = Math.round(box.y0 + (box.y1 - box.y0) * j / 7);
    for (let i = 0; i <= 9; i++) {
      const x = Math.round(box.x0 + (box.x1 - box.x0) * i / 9);
      if (x < 4 || x > 1596 || y < 110 || y > 780) continue;
      await page.mouse.move(x, y); await page.waitForTimeout(26);
      const h = await page.evaluate(() => window.__cur());
      probes++; curs[h.cursor || '-'] = (curs[h.cursor || '-'] ?? 0) + 1;
      if (h.hovered === id) { named++; if (!first) first = { x, y }; } else if (h.hovered >= 0) other++;
    }
  }
  L.say(`  ${label} (unit ${id}, ${u.alive} men, box ${Math.round(box.x1 - box.x0)}x${Math.round(box.y1 - box.y0)} px): ${named}/${probes} pixels name it, ${other} name someone else; cursors ${JSON.stringify(curs)}`);
  return { probes, named, other, curs, box, u, first };
}

let browser, page;
try {
  const r = await boot({ port: PORT, map: MAP, scenario: SCEN, tier: 'ultra', out: OUT, label: 'a', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 780); await page.waitForTimeout(300);
  await page.click('.dep-begin'); await page.waitForTimeout(600);
  await ff(page, AT);
  const t = await page.evaluate(() => Math.round(window.__game.simTime() * 10) / 10);
  L.say(`t+${t}`);

  const mine = (await page.evaluate(() => window.__units(0))).filter(u => u.alive > 40);
  const foeF = MAP === 'carthage' ? 2 : 1;
  const foes = (await page.evaluate(f => window.__units(f), foeF)).filter(u => u.alive > 40);
  const me = mine[0], them = foes.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];

  /*
   * A selection first, and it must be *confirmed*. `hostileUnder` is only consulted when
   * something is selected (`const hostile = haveSel ? this.hostileUnder(hovered) : -1`,
   * SelectionController l.1677), so a sweep run with an empty selection tests nothing —
   * which is exactly how the first version of this probe invalidated itself.
   */
  let s = { ok: false };
  for (const cand of mine.slice(0, 4)) {
    s = await selectHard(page, cand.id, { zoom: 0.42 });
    if (s.ok) { me.id = cand.id; me.x = cand.x; me.z = cand.z; break; }
  }
  if (!s.ok) { await page.keyboard.press('f'); await page.waitForTimeout(300); }
  const sel = await page.evaluate(() => window.__sel());
  L.ck('something of mine is selected before the sweep', (sel?.length ?? 0) > 0,
    'a non-empty selection', JSON.stringify(sel));

  L.say('\n--- the control: sweep one of MY units ---');
  const a = await sweep(page, me.id, 'my own unit', 0.42);
  L.say('\n--- the test: sweep one of THEIRS ---');
  const b = await sweep(page, them.id, 'the enemy unit', 0.42);

  L.ck('my own men can be picked out of the crowd', a.named > 0, '>0 pixels', `${a.named}/${a.probes}`);
  L.ck('THE ENEMY can be picked out of the crowd', b.named > 0, '>0 pixels', `${b.named}/${b.probes}`);
  L.ck('the enemy is as pickable as my own men (within 3x)',
    b.probes > 0 && a.probes > 0 && (b.named / b.probes) > (a.named / a.probes) / 3,
    `enemy hit rate within 3x of my own ${(a.named / Math.max(1, a.probes) * 100).toFixed(0)}%`,
    `${(b.named / Math.max(1, b.probes) * 100).toFixed(0)}%`);

  // and the order itself, at the best pixel found
  L.say('\n--- the order ---');
  /*
   * The pixel the *sweep found*, not the box centre. A unit's anchor is not reliably over its
   * own men — a 220-man skirmisher unit in `loose` read `hoveredId -1` at its own centre in
   * three sessions — and aiming at the anchor is what a script does, not what a player does.
   * A player clicks on a soldier they can see, so the probe must too.
   */
  const centre = b.first ?? (b.box ? { x: Math.round((b.box.x0 + b.box.x1) / 2), y: Math.round((b.box.y0 + b.box.y1) / 2) } : null);
  if (b.first) L.say(`  aiming at a pixel that answered with the enemy: ${JSON.stringify(b.first)}`);
  if (centre) {
    const h = await hover(page, centre);
    L.say(`  hovering the middle of the enemy: cursor=${h.cursor} hovered=${h.hovered} (want ${them.id})`);
    L.ck('the cursor turns to "attack" over an enemy', h.cursor === 'attack', 'attack', h.cursor);
    const d = await rightClick(page, centre, { hold: 500 });
    L.say(`  the hint while held: ${JSON.stringify(d.hint)} cursor=${d.cursor}`);
    L.ck('the hint offers to attack a named enemy', /^Attack /.test(d.hint ?? ''), '"Attack <name>"', d.hint || '(nothing)');
    await shot(page, OUT, 'a-attack-hint');
    const b4 = await page.evaluate(i => window.__u(i), me.id);
    const t4 = await page.evaluate(i => window.__u(i), them.id);
    await ff(page, 45);
    const af = await page.evaluate(i => window.__u(i), me.id);
    const ta = await page.evaluate(i => window.__u(i), them.id);
    L.say(`  45 s later: mine order ${b4.order}->${af.order} kills ${b4.kills}->${af.kills}; target ${t4.alive}->${ta.alive}`);
    L.ck('the order became an attack order (not a plain move)', af.order === 2 || af.order === 3,
      'UnitOrder Attack(2) or AttackMove(3)', af.order);
  }
  L.ck('no console errors', r.cerrs.length === 0, 0, r.cerrs.length);
  await dump(OUT, `attack-${MAP}`, { map: MAP, at: AT, mine: a, theirs: b, rows: L.rows, log: L.log });
} catch (e) {
  L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400));
} finally { if (browser) await browser.close(); }
L.summary();
