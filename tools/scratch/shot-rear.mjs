#!/usr/bin/env node
/**
 * Matched frames of a cavalry charge going in, for the eye rather than the spreadsheet.
 *
 * The owner reported this from watching it, so the before/after has to be watchable. The
 * shipped battle diverges the moment the simulation changes, so a frame at t+120 s of one
 * build is not comparable with the same frame of the other. This is a **lab**: the battle is
 * torn down, the AI and the arbiter are stubbed, two squadrons are spawned on empty ground
 * and ordered at each other, and the clock is stepped on a fixed schedule. Both builds then
 * run the identical opening, and the frames only part company where the change acts — which
 * is the comparison, not a nuisance.
 *
 * Every frame carries a caption row read off the live world: sim time, how many horses are
 * playing the `rear` clip this instant, and how many of those are travelling faster than a
 * trot while they do it (the skate).
 *
 * Usage:
 *   node tools/scratch/shot-rear.mjs --port=5962 --label=before [--out=screenshots/rear]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';
import { stopClockOnReady } from '../lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5962);
const LABEL = args.get('label') ?? 'shot';
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/rear');
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);

let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  if (execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim()) rev += '+dirty';
} catch { /* not a checkout */ }

await mkdir(OUT, { recursive: true });

const browser = await launchBrowser({ label: 'shot-rear', port: PORT, root: ROOT });
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'shot-rear', slot: browser.budgetSlot,
});

const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await stopClockOnReady(page);
const url = `${base}/?harness=1&quality=high&autoplay=1&w=${W}&h=${H}`;
console.log(`source: ${base}   rev ${rev}   label ${LABEL}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());

const setup = await page.evaluate(async () => {
  const g = window.__game, b = g.battle, ctx = g.engine.context, p = b.pool;
  for (const u of b.units) {
    if (u.destroyed) continue;
    for (const i of u.members) if (p.aliveAt(i)) p.setState(i, 11);
    u.alive = 0; u.destroyed = true;
  }
  const shared = await import('/src/sim/combatShared.ts');
  shared.resetCombatShared();
  ctx.tryGet('morale')?.redeploy?.();
  for (const name of ['tactical-ai', 'general-ai', 'pathfinding', 'battleFlow', 'autoEngage']) {
    const s = ctx.tryGet(name);
    if (s?.fixedUpdate) s.fixedUpdate = () => {};
  }
  b.unitSizeScale = 1;
  const idA = b.spawnUnit('equites', 0, 55, Math.PI, 'wedge');
  const idB = b.spawnUnit('juthungi-riders', 0, -55, 0, 'loose');
  const A = b.unitById(idA), B = b.unitById(idB);
  if (!A || !B) return { error: 'spawn failed' };
  ctx.events.emit('orderIssued', { unitIds: [A.id], kind: 'attack', targetUnitId: B.id });
  ctx.events.emit('orderIssued', { unitIds: [B.id], kind: 'attack', targetUnitId: A.id });

  const clips = await import('/src/anim/clips.ts');
  const REAR = clips.HORSE_CLIP_SET.index('rear');
  const render = ctx.tryGet('unitRender');
  window.__shot = {
    A: A.id, B: B.id,
    census: () => {
      let alive = 0, stag = 0, rear = 0, skate = 0, sum = 0;
      for (const u of [b.unitById(A.id), b.unitById(B.id)]) {
        if (!u || u.destroyed) continue;
        for (const i of u.members) {
          if (!p.aliveAt(i)) continue;
          alive++;
          const sp = Math.sqrt(p.vx[i] * p.vx[i] + p.vz[i] * p.vz[i]);
          sum += sp;
          if (p.state[i] === 9) stag++;
          if (render?.horseCur && render.horseCur[i] === REAR) {
            rear++;
            if (sp > 1.94) skate++;
          }
        }
      }
      return {
        t: +g.simTime().toFixed(2), alive, stag, rear, skate,
        speed: alive ? +(sum / alive).toFixed(2) : 0,
      };
    },
  };
  // Side on to the closing line at about 20 m, so the hooves are legible. `place()` puts
  // the eye at focus - (sin yaw, cos yaw) * r, so yaw = pi/2 stands the camera at -x and
  // looks back along +x across the lane the two squadrons are closing down.
  g.engine.rig.shakeScale = 0;
  g.setCamera(0, 4, 0.30, Math.PI / 2);
  // The dust is right and it makes this comparison impossible: a cavalry melee raises a
  // bank thick enough to hide every horse in it. Off for the plates only, and it touches
  // nothing the simulation reads.
  const vfx = ctx.tryGet('vfx');
  if (vfx) vfx.enabled = false;
  const r = document.getElementById('hud-root');
  if (r) r.style.setProperty('display', 'none', 'important');
  const hud = ctx.tryGet('hud');
  if (hud?.overlay) hud.overlay.visible = false;
  return { A: A.id, B: B.id, aAlive: A.alive, bAlive: B.alive };
});
if (setup.error) { console.error(setup.error); process.exit(2); }
console.log(`lab: equites ${setup.aAlive} vs juthungi-riders ${setup.bAlive}`);

const STEP = 0.5;
const SHOOT_FROM = 6.0;
const SHOOT_TO = 20.0;
const rows = [];
let t = 0;
let n = 0;
while (t < SHOOT_TO + 1e-6) {
  await page.evaluate((s) => window.__game.advance(s), STEP);
  t = +(t + STEP).toFixed(2);
  const c = await page.evaluate(() => window.__shot.census());
  rows.push(c);
  if (t >= SHOOT_FROM - 1e-6) {
    const name = `${LABEL}-t${String(Math.round(t * 10)).padStart(3, '0')}`;
    await page.screenshot({ path: path.join(OUT, `${name}.png`), type: 'png' });
    n++;
    console.log(`  ${name}  t+${c.t}s  alive ${c.alive}  staggered ${c.stag}  rearing ${c.rear} (skating ${c.skate})  mean speed ${c.speed}`);
  }
}

await page.close();
await closeServer();
await browser.close();

const rear = rows.reduce((a, r) => a + r.rear, 0);
const skate = rows.reduce((a, r) => a + r.skate, 0);
const stag = rows.reduce((a, r) => a + r.stag, 0);
console.log('');
console.log(`${LABEL}: ${n} frames in ${OUT}`);
console.log(`  rear samples ${rear} (skating ${skate} = ${(100 * skate / Math.max(1, rear)).toFixed(0)}%), staggered samples ${stag}`);
console.log(`  peak simultaneous rears in one frame: ${Math.max(...rows.map((r) => r.rear))}`);
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify({ rev, label: LABEL, rows }, null, 1));
if (errors.length) for (const e of errors.slice(0, 5)) console.log('  ' + e);
