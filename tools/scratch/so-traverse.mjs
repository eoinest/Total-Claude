/**
 * How often a wall order is given that the wall cannot carry out.
 *
 * `moveAlongWall` now refuses a run no chain of links reaches. This counts the calls and the
 * refusals over 200 s of an uncommanded assault, so "the fix changed the battle" can be
 * stated as a number rather than inferred from a hash that moved.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'carthage';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&map=${MAP}&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.evaluate(() => {
  const s = window.__game.battle.siege;
  window.__tally = { move: 0, moveNo: 0, esc: 0, escNo: 0, climbNo: 0 };
  const mv = s.moveAlongWall.bind(s);
  s.moveAlongWall = (u, x, z) => { const ok = mv(u, x, z);
    window.__tally.move++; if (!ok) window.__tally.moveNo++; return ok; };
  const es = s.escalade.bind(s);
  s.escalade = (u, x, z) => {
    const off = s.escaladeOfferAt ? s.escaladeOfferAt(u.id, x, z) : null;
    const ok = es(u, x, z);
    window.__tally.esc++;
    if (!ok) window.__tally.escNo++;
    if (off && off.refusal === 'notFoot') window.__tally.climbNo++;
    return ok;
  };
});
await p.evaluate(() => window.__game.engine.advance(200, 166));
const t = await p.evaluate(() => window.__tally);
console.log(`# ${MAP} port ${PORT}, 200 s uncommanded`);
console.log(`  moveAlongWall ${t.move} calls, ${t.moveNo} refused`);
console.log(`  escalade      ${t.esc} calls, ${t.escNo} refused (${t.climbNo} because the unit cannot climb)`);
console.log('errors:', errs.slice(0,2));
await b.close();
