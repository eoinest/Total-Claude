#!/usr/bin/env node
/**
 * Boot every battle this change can reach and report anything the page said.
 *
 * Four loads: both maps, field and assault. The assault is the one the victory conditions
 * changed and the field is the one that must be untouched by them, and `BattleFlowSystem`
 * takes a different path through `findWall` on each. Each is advanced far enough for the
 * census to have run a few hundred times and for the HUD to have printed the new plaque
 * line at least once.
 *
 *   node tools/scratch/boot-vs.mjs --port=5486
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5486);
const SHOTS = args.get('shots') ?? '';
const UNTIL = Number(args.get('until') ?? 120);

async function up(url, ms) {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await up(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await up(base, 120000))) throw new Error('vite did not start');
  console.log(`• vite pid ${server.pid} on ${PORT}`);
}
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
let bad = 0;
for (const map of ['campus-martius', 'carthage']) {
  for (const scenario of ['field', 'assault']) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${String(e.message).slice(0, 220)}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text().slice(0, 220)}`); });
    const token = Buffer.from(JSON.stringify({ map, scenario, quality: 'high' }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await page.goto(`${base}/?menu=0&autoplay=1&quality=high&battle=${token}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
    await page.evaluate(() => window.__game.engine.stop());
    await page.evaluate((s) => window.__game.engine.advance(s, 166), UNTIL);
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => {
      const g = window.__game, ctx = g.engine.context;
      const flow = ctx.get('battleFlow');
      const o = flow.objective;
      const t = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        t: +ctx.time.simTime.toFixed(0),
        strength: { ...g.battle.strength },
        objective: o ? {
          onWall: o.stormOnWall, holding: o.stormHolding, runs: o.holdingRuns,
          garrison: o.garrisonOnWall, inside: o.stormInside, heldFor: +o.heldFor.toFixed(1),
          need: o.needFoothold,
        } : null,
        phase: t('.tb-phase'), note: t('.tb-note'), result: flow.result?.reason ?? null,
      };
    });
    const tag = `${map}/${scenario}`;
    console.log(`${errs.length ? '!! ' : '   '}${tag.padEnd(24)} t+${state.t}  ${JSON.stringify(state.strength)}`);
    console.log(`      objective ${JSON.stringify(state.objective)}`);
    console.log(`      plaque "${state.phase}" — "${state.note}"`);
    if (errs.length) { bad += errs.length; for (const e of [...new Set(errs)].slice(0, 4)) console.log(`      ${e}`); }
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `boot-${map}-${scenario}.png`) });
    await page.close();
  }
}
console.log(bad === 0 ? '\nno page errors on any of the four boots' : `\n!! ${bad} page errors`);
await browser.close();
if (server) { server.kill('SIGTERM'); console.log(`• killed vite ${server.pid}`); }
process.exit(bad === 0 ? 0 : 1);
