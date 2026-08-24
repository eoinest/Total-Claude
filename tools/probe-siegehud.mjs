#!/usr/bin/env node
/**
 * Probe: does the interface ever mention the siege?
 *
 * Three things are read straight out of the DOM, because the finding this answers was that
 * the words on the screen were wrong, not that the state behind them was:
 *
 *   - the deployment plaque, which must state the objective before a shot is fired,
 *   - the top plaque through a whole storm, sampled against the wall's own state, so a
 *     phase heading can be checked against what is actually happening at the wall,
 *   - the end-of-battle dispatch, which must name the gate and the wall.
 *
 * Usage: node tools/probe-siegehud.mjs [--port=5348] [--maps=carthage,campus-martius]
 *                                      [--shots=dir] [--json=path] [--limit=1600]
 */

import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5348);
const MAPS = (args.get('maps') ?? 'carthage,campus-martius').split(',');
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const JSON_OUT = args.get('json') ?? null;
const LIMIT = Number(args.get('limit') ?? 1600);
/**
 * Extra query string appended to both loads, for a `?battle=` token.
 *
 * The shipped orders of battle put 3,440 men on Carthage, and `advance(20)` on that runs at
 * about a tenth of real time by the time two hundred are fighting on the parapet — 35 minutes
 * of wall clock to reach t+451, and the storm was nowhere near decided. A run that cannot
 * reach the dispatch cannot check the dispatch. `--extra=battle=<token>` with
 * `unitSize: small` is a quarter of the men and the same code path, and every phase, count
 * and threshold on the plaque is read from the sim rather than from the army's size.
 *
 * The army it fights is therefore not the shipped one, and any figure taken from a run that
 * used this has to say so.
 */
const EXTRA = args.get('extra') ? `&${args.get('extra')}` : '';
const STEP = Number(args.get('step') ?? 20);
const W = 1600, H = 900;

/*
 * Browser and server through `tools/lib/browser-budget.mjs` — 23 Aug 2026.
 *
 * This probe was one of three siege tools that opened Chromium with a bare `chromium.launch`
 * and started Vite with `spawn('npx', ['vite', …])`. Both are the shapes the budget exists to
 * remove: nothing counted the browser, so a release run could not use this file for a single
 * frame without becoming an unbudgeted extra renderer on a machine whose contended resource is
 * the GPU; and the handle `spawn('npx', …)` returns is the npx wrapper rather than Vite, so
 * `server.kill()` at the bottom left the server on the port.
 *
 * The slot is taken **first** and the server started second, so a run that has to queue queues
 * holding nothing. The four GPU flags are gone from this file: `launchBrowser` defaults them,
 * which is the only way they cannot drift.
 */
const browser = await launchBrowser({
  label: 'probe-siegehud', port: PORT, root: ROOT, args: ['--hide-scrollbars'],
});
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'probe-siegehud', slot: browser.budgetSlot,
});
console.log(`server ${base}`);
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

const TEXT = () => {
  const t = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const g = window.__game;
  const flow = g.engine.context.tryGet('battleFlow');
  const siege = g.battle.siege;
  return {
    t: +g.simTime().toFixed(0),
    phase: t('.tb-phase'),
    note: t('.tb-note'),
    adv: t('.tb-adv'),
    dataPhase: document.querySelector('.topbar')?.dataset.phase ?? '',
    dataSiege: document.querySelector('.topbar')?.dataset.siege ?? '',
    objective: flow?.objective
      ? {
        inside: flow.objective.stormInside,
        onWall: flow.objective.stormOnWall,
        garrison: flow.objective.garrisonOnWall,
        need: flow.objective.needInside,
      }
      : null,
    gate: (({ breached, open, blows }) => ({ breached, open, blows }))(siege.gateReport()),
    breachBays: siege.breachReport().bays.length,
    crossing: siege.stats().crossing,
    over: !!flow?.result,
    result: flow?.result ? { victor: flow.result.victor, reason: flow.result.reason } : null,
  };
};

const out = {};
for (const map of MAPS) {
  console.log(`\n=== ${map} ===`);
  const rec = { deployment: null, samples: [], results: null, errors: [] };
  out[map] = rec;

  // --- the deployment plaque -------------------------------------------------
  {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') rec.errors.push(`console.error: ${m.text()}`); });
    await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&deploy=1&autoplay=0&quality=high${EXTRA}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    await page.waitForTimeout(2500);
    rec.deployment = await page.evaluate(() => {
      const d = document.querySelector('.deploy');
      const r = d?.getBoundingClientRect();
      /*
       * `.dep-brief` as well as `.dep-note`, and the reason is worth keeping.
       *
       * This probe was first written to read `.dep-note`, because that is the class the
       * objective brief was first emitted with. It reported both notes empty and unshown —
       * correctly — and the run was read as "the brief is fine, those are the refusal lines".
       * It was not fine: `DeploymentPanel.sync` binds the refusal line with
       * `querySelector('.dep-note')`, took the brief as the first match, and cleared it on
       * the first tick. The instrument saw the defect and the defect looked exactly like the
       * instrument's own blind spot.
       *
       * The brief has its own class now, so the two are told apart here rather than being
       * counted together, and `objective` is asserted non-empty on its own.
       */
      const read = (e) => ({
        cls: e.className,
        text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
        shown: getComputedStyle(e).display !== 'none',
        w: Math.round(e.getBoundingClientRect().width),
        scrollW: Math.round(e.scrollWidth),
      });
      const notes = Array.from(d?.querySelectorAll('.dep-note, .dep-brief') ?? []).map(read);
      const brief = d?.querySelector('.dep-brief');
      const objective = brief ? read(brief) : null;
      return {
        plaque: r ? { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) } : null,
        notes,
        objective,
      };
    });
    console.log(`  plaque ${JSON.stringify(rec.deployment.plaque)}`);
    const ob = rec.deployment.objective;
    console.log(`  OBJECTIVE ${ob && ob.shown && ob.text ? 'ON THE PLAQUE' : '*** MISSING ***'}`
      + (ob ? ` shown=${ob.shown} clipped=${ob.scrollW > ob.w} (${ob.scrollW}/${ob.w})` : ''));
    if (ob) console.log(`    "${ob.text}"`);
    for (const n of rec.deployment.notes) {
      console.log(`  ${n.cls} shown=${n.shown} clipped=${n.scrollW > n.w} (${n.scrollW}/${n.w}): ${n.text.slice(0, 150)}`);
    }
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `hud-deploy-${map}.png`) });
    await page.close();
  }

  // --- the storm, and the dispatch that closes it ----------------------------
  {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') rec.errors.push(`console.error: ${m.text()}`); });
    await page.goto(`${base}/?menu=0&map=${map}&scenario=assault&autoplay=1&quality=high${EXTRA}`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    await page.waitForTimeout(1500);

    let last = '';
    for (let t = 0; t < LIMIT; t += STEP) {
      await page.evaluate((s) => window.__game.advance(s), STEP);
      // Let the HUD's own 10 Hz tick run against the state the sim just produced.
      await page.waitForTimeout(180);
      const smp = await page.evaluate(TEXT);
      rec.samples.push(smp);
      const key = `${smp.phase}|${smp.note}|${smp.adv}`;
      if (key !== last) {
        last = key;
        console.log(`  t+${String(smp.t).padStart(4)}  ${smp.phase.padEnd(20)} | ${smp.note.padEnd(58)} | ${smp.adv}`);
        console.log(`            wall: inside ${smp.objective?.inside ?? '-'} onWall ${smp.objective?.onWall ?? '-'} garrison ${smp.objective?.garrison ?? '-'}  gate blows ${smp.gate.blows} breached ${smp.gate.breached}  breachBays ${smp.breachBays}`);
        if (SHOT_DIR && smp.dataSiege) {
          await page.screenshot({
            path: path.join(SHOT_DIR, `hud-${map}-${smp.dataSiege}-t${smp.t}.png`),
            clip: { x: 300, y: 0, width: 1000, height: 100 },
          });
        }
      }
      if (smp.over) break;
    }

    await page.waitForTimeout(1200);
    rec.results = await page.evaluate(() => {
      const p = document.querySelector('.rs-panel');
      if (!p) return null;
      const txt = (sel) => (p.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const heads = Array.from(p.querySelectorAll('.sec-head')).map((e) => e.textContent?.trim());
      const wall = Array.from(p.querySelectorAll('.rs-honours'))
        .find((e) => e.querySelector('.sec-head')?.textContent?.trim() === 'The wall');
      return {
        verdict: txt('.rs-verdict'),
        reason: txt('.rs-reason'),
        clock: txt('.rs-clock'),
        secHeads: heads,
        wall: wall ? (wall.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
        honourOrder: Array.from(p.querySelectorAll('.rs-honours table tr')).map((tr) => {
          const h = tr.querySelector('.sec-head');
          return h ? `-- ${h.textContent?.trim()}` : (tr.querySelector('.h-name')?.textContent ?? '').trim();
        }),
      };
    });
    console.log(`  results: ${JSON.stringify(rec.results?.verdict)} ${JSON.stringify(rec.results?.reason)}`);
    console.log(`  wall block: ${rec.results?.wall ?? 'ABSENT'}`);
    console.log(`  honours: ${JSON.stringify(rec.results?.honourOrder)}`);
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `hud-results-${map}.png`) });
    await page.close();
  }
  if (rec.errors.length) console.log(`  errors: ${rec.errors.slice(0, 3).join(' | ')}`);
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
await browser.close();
await closeServer();
