#!/usr/bin/env node
/**
 * The archer's bow, in a battle, at the distance the shipped deck is graded from.
 *
 * Aims on a live sagittarius' own coordinates rather than a parked camera (the elephant
 * workstream's trap: a camera at a unit's spawn point photographs empty grass), and
 * reports draw calls at the standard camera set on both maps so a mesh change can be
 * shown to have moved neither.
 *
 *   node tools/scratch/bowfield-ab.mjs --port=5241 --tag=after
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5241);
const TAG = String(args.get('tag') ?? 'x');
const OUT = String(args.get('out') ?? 'screenshots/archer-bow');
const W = 1920, H = 1080;
const base = `http://127.0.0.1:${PORT}`;

// The shipped graded cameras, so "draws did not move" is measured where the budget is set.
const CAMS = {
  assault: null,
  clash: { x: 15, z: -17, zoom: 0.30, yaw: -1.92 },
  melee: { x: -28, z: -37, zoom: 0.30, yaw: -1.79 },
  wide: { x: 0, z: 90, zoom: 0.72, yaw: Math.PI * 0.82 },
  romanline: { x: -100, z: 128, zoom: 0.36, yaw: Math.PI * 1.42 },
  raking: { x: -20, z: 120, zoom: 0.22, yaw: Math.PI * 1.72 },
  terrain: { x: -560, z: -420, zoom: 0.44, yaw: Math.PI * 0.4 },
  city: { x: 40, z: 620, zoom: 0.74, yaw: Math.PI * 0.06 },
  wall: { x: -120, z: 470, zoom: 0.58, yaw: 0.0 },
};

const ping = await fetch(base, { signal: AbortSignal.timeout(4000) }).catch(() => null);
if (!ping?.ok) throw new Error(`no dev server on ${base} — start your own`);

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

const report = { tag: TAG, errors };

// -------------------------------------------------------------------- frames
await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&scenario=field`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
report.ready = await page.evaluate(() => window.__game.ready);

// Run until the archers are actually shooting: the bow only reads as a bow when it is drawn.
const pick = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  g.engine.advance(90, 160);
  const u = b.units.filter((x) => x.typeId === 'sagittarii' && !x.destroyed);
  const men = u.flatMap((x) => x.members).filter((i) => b.pool.aliveAt(i));
  // `SoldierState.Shooting` is the state that selects `releaseBow`, whose first frame is
  // the pose the bow is socketed to. A frame of archers who are not shooting photographs
  // the piece in the one pose it was not authored for.
  const SHOOTING = 7;
  const states = {};
  for (const i of men) states[b.pool.state[i]] = (states[b.pool.state[i]] ?? 0) + 1;
  const drawn = men.filter((i) => b.pool.state[i] === SHOOTING);
  const i = (drawn.length ? drawn : men)[Math.floor((drawn.length ? drawn.length : men.length) * 0.5)];
  return {
    units: u.length, men: men.length, slot: i, states, drawn: drawn.length,
    x: +b.pool.x[i].toFixed(2), y: +b.pool.y[i].toFixed(2), z: +b.pool.z[i].toFixed(2),
    facing: +b.pool.facing[i].toFixed(4),
    simTime: +g.simTime().toFixed(1),
  };
});
report.pick = pick;

const aim = async (x, z, zoom, yaw) => page.evaluate(({ x, z, zoom, yaw }) => {
  window.__game.setCamera(x, z, zoom, yaw);
  window.__game.engine.advance(0.017, 17);
}, { x, z, zoom, yaw });

/*
 * Two bearings, because a bow seen end-on is a vertical line whatever shape it is. The
 * archery pose is side-on and the bow is yawed with it, so `facing +/- PI/2` is the
 * profile and `facing + PI` is over his shoulder — the view a player standing behind his
 * own line actually has.
 */
const BEARINGS = { profile: pick.facing - Math.PI / 2, overshoulder: pick.facing + Math.PI };
// 0.30 is 10 m and 0.42 is 22 m on the rig's distance curve: the `melee`/`clash` and the
// company-view distances the shipped deck is graded at.
for (const [bname, yaw] of Object.entries(BEARINGS)) {
  for (const [zname, zoom] of [['10m', 0.30], ['22m', 0.42]]) {
    await aim(pick.x, pick.z, zoom, yaw);
    await page.screenshot({ path: path.join(OUT, `battle-${bname}-${zname}-${TAG}.png`) });
  }
}

// --------------------------------------------------------------------- draws
const draws = async (label) => {
  CAMS.assault = await page.evaluate(() => {
    const r = window.__game.engine.rig;
    return { x: r.focus.x, z: r.focus.z, zoom: r.zoom, yaw: r.yaw };
  });
  const out = {};
  for (const [name, c] of Object.entries(CAMS)) {
    await aim(c.x, c.z, c.zoom, c.yaw);
    out[name] = await page.evaluate(() => {
      const info = window.__game.engine.renderer.info.render;
      return { draws: info.calls, tris: info.triangles };
    });
  }
  report[label] = out;
};

const token = (map) => Buffer.from(JSON.stringify({ map, scenario: 'assault' }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
for (const map of ['campus-martius', 'carthage']) {
  await page.goto(`${base}/?harness=1&quality=ultra&w=${W}&h=${H}&scenario=assault`
    + `&battle=${token(map)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.addStyleTag({ content: '#hud-root, #loading { display: none !important; }' });
  await page.evaluate(() => window.__game.advance(72));
  await draws(`draws-${map}`);
}

await browser.close();
fs.writeFileSync(path.join(OUT, `report-${TAG}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
