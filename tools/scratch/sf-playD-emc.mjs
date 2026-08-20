/**
 * The defender's chair, played, with one question: **when you lose, can you see it coming?**
 *
 * Rome's assault is decided by the lodgement condition — 24 storming men on a stretch of
 * parapet with no defender left on it, held for 20 s — on 9 of the 24 seeds measured. This
 * boots through the real menu at `?autoplay=0`, so the Juthungi are the AI and Rome is the
 * player, and every second it records three things side by side:
 *
 *   - what `BattleFlow` is actually about to decide on (`stormHolding`, `heldFor`),
 *   - what the top plaque is telling the player,
 *   - and, the first time a lodgement forms, whether a real right-click can answer it
 *     inside the window the rules allow.
 *
 *   node tools/scratch/sf-playD-emc.mjs --port=5491 --answer=1
 */
import { argsOf, boot, shot, dump, fast, rightClick, selectHard, wallPixel, installDiag, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';

const A = argsOf();
const OUT = path.join(ROOT, 'screenshots/siegefun/play');
const L = A.get('label') ?? 'playD';
const ANSWER = A.get('answer') === '1';
const log = [];
const say = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); console.log(s); log.push(s); };
let page, browser, errs, cerrs;
({ browser, page, errs, cerrs } = await boot({ port: Number(A.get('port') ?? 5491), map: 'campus-martius', out: OUT, label: L }));
await installDiag(page);

const READ = () => page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  const flow = ctx.get('battleFlow');
  const o = flow.objective ?? {};
  const bar = document.querySelector('.tb-adv');
  const top = document.querySelector('.topbar, .top');
  return {
    t: +g.simTime().toFixed(0),
    holding: o.stormHolding ?? 0, need: o.needFoothold ?? 0, heldFor: +(o.heldFor ?? 0).toFixed(1),
    holdSecs: o.holdSeconds ?? 0, onWall: o.stormOnWall ?? 0, inside: o.stormInside ?? 0,
    garrOnWall: o.garrisonOnWall ?? 0, runs: (o.holdingRuns ?? []).slice(0, 6),
    plaqueBar: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : null,
    plaque: top ? top.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
    result: flow.result ? `${flow.result.victor} ${flow.result.reason} @${flow.result.at.toFixed(0)}` : null,
  };
});

try {
  say('# deployment plaque:', await page.evaluate(() => {
    const e = document.querySelector('.dep-brief, .dep-objective, .dep-plaque, .dep-sheet');
    return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 420) : '(none found)';
  }));
  await shot(page, OUT, `${L}-0-deploy`);
  await page.click('.dep-begin');
  await page.waitForTimeout(700);

  let firstLodge = null;
  let answered = false;
  for (let k = 0; k < 200; k++) {
    await fast(page, 5, 5);
    const r = await READ();
    if (k % 4 === 0 || r.holding >= r.need) {
      say(`t+${String(r.t).padStart(4)}  holding ${String(r.holding).padStart(3)}/${r.need}  heldFor ${String(r.heldFor).padStart(5)}/${r.holdSecs}  onWall ${String(r.onWall).padStart(3)}  garrOnWall ${String(r.garrOnWall).padStart(3)}  inside ${String(r.inside).padStart(2)}  || PLAQUE: ${JSON.stringify(r.plaqueBar)}`);
    }
    if (!firstLodge && r.holding >= r.need) {
      firstLodge = r;
      say(`\n!! LODGEMENT at t+${r.t} on run(s) ${JSON.stringify(r.runs)} — ${r.holding} men, ${r.holdSecs} s to lose the city`);
      say(`   what the plaque says at this instant: ${JSON.stringify(r.plaque)}`);
      say(`   what the objective bar says:          ${JSON.stringify(r.plaqueBar)}`);
      await shot(page, OUT, `${L}-1-lodgement`);
      if (ANSWER) {
        // The obvious answer: take the nearest garrison unit still on the wall and send it
        // at the lodgement. Timed, because the rules give 20 s.
        const t0 = r.t;
        const bays = await page.evaluate(() => window.__bays());
        const mine = (await page.evaluate(() => window.__units(0))).filter((u) => u.elevated > 5);
        const runIdx = r.runs[0] ?? 0;
        const bay = bays.find((q) => q.i === runIdx) ?? bays[Math.floor(bays.length / 2)];
        const near = mine.sort((a, c) => Math.abs(a.x - bay.cx) - Math.abs(c.x - bay.cx))[0];
        say(`   nearest garrison unit on the wall: ${near ? `${near.id}:${near.type} at x${near.x}, ${Math.abs(near.x - bay.cx).toFixed(0)} m along the wall from bay ${bay.i}` : 'NONE'}`);
        if (near) {
          const s = await selectHard(page, near.id, { zoom: 0.6, yaw: Math.PI });
          say(`   select: ${s.ok ? `OK (${s.easy ? 'first click' : `hunted ${s.answering}/${s.probes}`})` : `FAILED ${s.why}`}`);
          if (s.ok) {
            const wp = await wallPixel(page, bay, { side: -1, zoom: 0.62 });
            say(`   bay ${bay.i}: ${wp.hit}/${wp.tried} pixels offer a wall order`);
            if (wp.p) {
              const d = await rightClick(page, wp.p, { hold: 320 });
              say(`   order given, hint ${JSON.stringify(d.hint)}`);
              answered = true;
              const t1 = await page.evaluate(() => +window.__game.simTime().toFixed(0));
              say(`   giving the order cost ${t1 - t0} s of battle time (the rules allow ${r.holdSecs})`);
            } else say('   NO PIXEL ON THAT BAY ANSWERS — the order cannot be given');
          }
        }
      }
    }
    if (r.result) { say(`\n== result ${r.result}`); await shot(page, OUT, `${L}-2-end`); break; }
  }
  say('answered:', answered, ' firstLodgementAt:', firstLodge ? firstLodge.t : null);
  say('HUD at the end:', await page.evaluate(() => window.__hud()));
} catch (e) { say('!! THREW', String(e).slice(0, 400)); }
say('pageerrors', errs.length, 'console errors', cerrs.length, errs.slice(0, 3));
await dump(OUT, `${L}-log`, { log, errs, cerrs });
await browser.close();
