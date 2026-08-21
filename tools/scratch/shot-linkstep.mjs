#!/usr/bin/env node
/**
 * Film the worst wall link on Rome, before and after the step classifier.
 *
 * Runs 12 and 13 abut at x -134.6, across a tower, with their walks 7.70 m apart in height
 * and 5.03 m apart in plan. `buildLinks` used to bridge that on the horizontal gap alone, so
 * a cohort ordered west along the parapet was admitted to a 57 degree crossing and walked up
 * it — the first 3.16 m of it above the surface `CitySystem.walkableTopAt` reports, because
 * `buildSpine` stands the last stations of a bay inside the next tower's ramp and levels them
 * to the bay's own `walkY`.
 *
 * This gives the same order in both trees and photographs what happens. It also prints the
 * numbers behind the frame, because a still of a man on a staircase and a still of a man in
 * the air look similar at 1280x720 and the point is which one it is.
 *
 * Usage:
 *   node tools/scratch/shot-linkstep.mjs --port=5949 --label=before
 *   node tools/scratch/shot-linkstep.mjs --port=5949 --label=after
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5949));
const LABEL = arg('label', 'shot');
const OUT = arg('out', 'screenshots/link-step');
const ZOOM = Number(arg('zoom', 0.42));
const YAW = Number(arg('yaw', 0.5));
const TIMES = arg('at', '4,10,18,30').split(',').map(Number);
/** Try four bearings at one moment instead of one bearing at four, to choose a framing. */
const SWEEP = process.argv.includes('--sweep');
/** The tower at the head of the 7.70 m joint. Named, not searched, so both arms frame it. */
const AT_X = -134.6;

const token = Buffer.from(JSON.stringify({ map: 'campus-martius', scenario: 'assault' }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1600&h=900&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server on', PORT); process.exit(2); }
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
// No interface in the plate: the subject is a man's feet against the stone.
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});
await page.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  if (hud && hud.overlay) hud.overlay.visible = false;
});

/** Everything the arms share, installed once. */
await page.evaluate((atX) => {
  const g = window.__game;
  const b = g.battle;
  const s = b.siege;
  window.__ls = {
    g, b, s, atX,
    /** The run boundary whose east station is nearest `atX`. */
    joint() {
      let best = -1; let bd = Infinity;
      for (let r = 0; r + 1 < s.nRuns; r++) {
        const a = s.runHi[r]; const q = s.runLo[r + 1];
        if (a < 0 || q < 0) continue;
        const d = Math.abs(s.sx[a] - atX);
        if (d < bd) { bd = d; best = r; }
      }
      const a = s.runHi[best]; const q = s.runLo[best + 1];
      return {
        r: best, a, q,
        gap: +Math.hypot(s.sx[q] - s.sx[a], s.sz[q] - s.sz[a]).toFixed(2),
        dy: +Math.abs(s.sy[q] - s.sy[a]).toFixed(2),
        x: +s.sx[a].toFixed(1), z: +s.sz[a].toFixed(1),
        ay: +s.sy[a].toFixed(2), by: +s.sy[q].toFixed(2),
        linked: s.runNext[best] >= 0,
      };
    },
    /** Men standing within `rad` of the joint, and how far each is off the drawn walk. */
    census(x, z, rad) {
      const p = b.pool;
      const rows = [];
      for (let i = 0; i < p.count; i++) {
        if (p.state[i] === 10 || p.state[i] === 11) continue;
        const d = Math.hypot(p.x[i] - x, p.z[i] - z);
        if (d > rad) continue;
        const top = s.city && s.city.walkableTopAt
          ? s.city.walkableTopAt(p.x[i], p.z[i], p.y[i] + 1.6) : -Infinity;
        rows.push({
          i, x: +p.x[i].toFixed(1), y: +p.y[i].toFixed(2), z: +p.z[i].toFixed(1),
          state: p.state[i], elevated: b.elevated[i],
          air: isFinite(top) ? +(p.y[i] - top).toFixed(2) : null,
        });
      }
      rows.sort((m, n) => (n.air ?? -99) - (m.air ?? -99));
      return rows;
    },
  };
}, AT_X);

const joint = await page.evaluate(() => window.__ls.joint());
console.log(`[${LABEL}] joint runs ${joint.r}→${joint.r + 1} at x ${joint.x}: `
  + `gap ${joint.gap} m, step ${joint.dy} m, ay ${joint.ay} → by ${joint.by}, `
  + `linked ${joint.linked}`);

// Let the deployment settle before anyone is ordered anywhere.
await page.evaluate(() => window.__ls.g.fastForward(6));

const order = await page.evaluate((j) => {
  const w = window.__ls;
  const east = w.s.stationWorld(j.r + 1);
  const west = w.s.stationWorld(j.r);
  // The garrison standing on the high side of the joint, whichever unit that is.
  let u = null;
  for (const q of w.b.units) {
    if (q.destroyed || q.alive < 8 || !w.s.isGarrisoned(q.id)) continue;
    const st = w.s.stationNear(q.x, q.z);
    if (st < 0 || w.s.sRun[st] !== j.r + 1) continue;
    if (!u || q.alive > u.alive) u = q;
  }
  if (!u) {
    // Nobody is posted there in the shipped order of battle, so post somebody: the biggest
    // defender not already on the stone. `garrison` places rather than routes, so this does
    // not itself use a link and cannot beg the question.
    const defender = w.b.units.find((q) => w.s.isGarrisoned(q.id))?.faction;
    for (const q of w.b.units) {
      if (q.destroyed || q.alive < 8 || q.faction !== defender) continue;
      if (w.s.ownsUnit(q.id) || w.s.isGarrisoned(q.id)) continue;
      if (!u || q.alive > u.alive) u = q;
    }
    if (!u) return { fail: 'no unit available' };
    if (!w.s.garrison(u, east.x, east.z)) return { fail: 'garrison refused' };
    w.g.fastForward(40);
  }
  const offer = w.s.traverseOfferAt(u.id, west.x, west.z);
  const accepted = w.s.moveAlongWall(u, west.x, west.z);
  return {
    unitId: u.id, alive: u.alive, type: u.typeId,
    from: { x: +east.x.toFixed(1), y: +east.y.toFixed(2) },
    to: { x: +west.x.toFixed(1), y: +west.y.toFixed(2) },
    offer, accepted,
  };
}, joint);
console.log(`[${LABEL}] order:`, JSON.stringify(order));

// Park the camera on the joint and photograph the crossing as it fills.
const shots = [];
let elapsed = 0;
const frame = async (name, zoom, yaw) => {
  await page.evaluate(([j, z2, y2]) => window.__ls.g.setCamera(j.x, j.z, z2, y2), [joint, zoom, yaw]);
  // One real frame after the fast-forward, because `fastForward` does not draw.
  await page.evaluate(() => window.__ls.g.advance(1 / 60));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
if (SWEEP) {
  await page.evaluate(() => window.__ls.g.fastForward(30));
  for (const z2 of [0.26, 0.42]) {
    for (const y2 of [0, 0.5, 1.0, 1.5]) {
      await frame(`${LABEL}-sweep-z${z2}-y${y2}`, z2, Math.PI * y2);
      console.log(`  sweep zoom ${z2} yaw ${y2}pi`);
    }
  }
} else {
  for (const t of TIMES) {
    await page.evaluate((d) => window.__ls.g.fastForward(d), t - elapsed);
    elapsed = t;
    const cen = await page.evaluate((j) => window.__ls.census(j.x, j.z, 14), joint);
    const worst = cen.filter((m) => m.air !== null).slice(0, 3);
    const name = `${LABEL}-t${String(t).padStart(2, '0')}`;
    await frame(name, ZOOM, Math.PI * YAW);
    shots.push({ t, men: cen.length, worst });
    console.log(`  t+${t}s  ${cen.length} men within 14 m; worst off the drawn walk: `
      + `${worst.map((m) => `${m.air > 0 ? '+' : ''}${m.air} m`).join(', ') || 'none'}  -> ${name}.png`);
  }
}

const after = await page.evaluate(() => {
  const w = window.__ls;
  const rep = w.s.wallReport();
  // The `before` tree's report has neither of the first two fields; a probe that throws on
  // the arm it is comparing against is a probe that only ever measures one side.
  const links = rep.linkUse.filter((l) => l.kind === 'towerPass' || l.kind === 'step');
  const step = (l) => Math.abs(l.rise !== undefined ? l.rise : 0);
  return { unbridged: rep.unbridged ?? null, refusedSteps: rep.refusedSteps ?? null,
    walkLinks: links.length,
    worstStep: rep.worstStep !== undefined ? +rep.worstStep.toFixed(2)
      : +Math.max(0, ...links.map(step)).toFixed(2),
    worstPitch: rep.worstPitch !== undefined ? +rep.worstPitch.toFixed(3) : null,
    reachable: rep.reachable, runs: rep.runs };
});
console.log(`[${LABEL}] wallReport:`, JSON.stringify(after));
if (errs.length) console.log(`[${LABEL}] PAGE ERRORS ${errs.length}: ${errs.join(' | ')}`);
await writeFile(`${OUT}/${LABEL}.json`, JSON.stringify({ joint, order, shots, after, errs }, null, 2));
await browser.close();
