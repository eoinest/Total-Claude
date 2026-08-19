#!/usr/bin/env node
/**
 * Can a besieger point at the wall at all?
 *
 * `SelectionController.wallValid` has two ways to be true: the ray landed on the walk
 * (`solidY` at the bay's top), or the selection is storming and the hit is masonry. From the
 * field the first is impossible — the merlons are between the eye and the walk — so the whole
 * feature rests on the second, and the second asks `Siege.wallTargetAt` about the point the
 * ray struck. A shallow field ray strikes the outer face, and on Carthage the bay is modelled
 * as two thin panels whose front face stands outside the click band, so the query answers −1
 * and the storming branch never fires.
 *
 * This sweeps a grid of pixels over one bay from a camera parked in the field by the wall's
 * own geometry — identical framing in both arms — and reports, of the pixels that hit
 * masonry, how many the cursor is willing to call a wall order.
 *
 * Usage: node tools/probe-stormpick.mjs --port=5477 [--map=carthage] [--json=path]
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'carthage';
const JSON_OUT = args.get('json') ?? null;
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }
console.log(`• dev server ${base}   map ${MAP}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
const settle = (ms = 250) => page.waitForTimeout(ms);

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 90000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(250);
await page.click('.menu [data-scen="assault"]'); await settle(250);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await settle(600);
if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(800); }

await page.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  window.__ctl = () => ctx.tryGet('hud')?.controller ?? null;
  const V = new (ctx.camera.position.constructor)();
  window.__project = (x, y, z) => { V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH }; };
  window.__hovered = () => window.__ctl()?.model.hoveredId ?? -2;
  window.__selected = () => window.__ctl()?.model.selection.slice() ?? [];
  window.__overUi = () => { const c = window.__ctl(); return c && c.ptr ? !!c.ptr.overUi : null; };
  /** Where a point sits across the curtain: negative into the city, positive out into the field. */
  window.__offset = (x, z) => {
    const s = g.battle.siege;
    const st = s.stationNear(x, z);
    if (st < 0) return null;
    return { station: st,
      off: +((x - s.sx[st]) * s.snx[st] + (z - s.sz[st]) * s.snz[st]).toFixed(2),
      inner: +s.sInner[st].toFixed(2), outer: +s.sOuter[st].toFixed(2),
      target: s.wallTargetAt(x, z) };
  };
  window.__cursor = () => {
    const c = window.__ctl();
    // `storming` is private in TypeScript, which is a compile-time word. Reading it is the
    // whole point: `wallValid` on the field side is gated on it, so a probe that cannot see
    // it cannot tell "the pick refused" from "the selection was never storming".
    return { storming: !!c.storming, kind: c.cursor, solidValid: c.solidValid, solidX: +c.solidX.toFixed(2),
      solidY: +c.solidY.toFixed(2), solidZ: +c.solidZ.toFixed(2),
      wallValid: c.wallValid, wallX: +c.wallX.toFixed(2), wallZ: +c.wallZ.toFixed(2),
      orderX: +c.orderX.toFixed(2), orderZ: +c.orderZ.toFixed(2), hovered: c.model.hoveredId };
  };
  window.__aim = (id) => {
    const c = window.__ctl(), v = c ? c.model.view(id) : null;
    if (!v) return null;
    const p = g.battle.pool;
    let n = 0, sx = 0, sz = 0, sy = 0;
    for (const i of v.unit.members) { if (!p.aliveAt(i)) continue; n++; sx += p.x[i]; sz += p.z[i]; sy += p.y[i]; }
    return n ? window.__project(sx / n, sy / n + 0.9, sz / n) : null;
  };
  window.__pickTarget = () => {
    const g2 = window.__game, s = g2.battle.siege;
    // A bay a ladder is leaning on, and the nearest player cohort standing in the field.
    const l = (s.ladders ?? [])[Math.floor((s.ladders ?? []).length / 2)];
    const st = l ? l.station : Math.floor(s.nStations / 2);
    /*
     * A line cohort in the field, not a ladder crew.
     *
     * The escalade parties are their own ladders' crews and are on the parapet within a
     * couple of minutes, at which point `isGarrisoned` is true and `refreshStorming` stops
     * counting them — so a probe that selected one measured `storming false` and graded the
     * defender's branch of `wallValid` while believing it was grading the besieger's. Both
     * arms then read an identical 25/148 and the change looked inert.
     */
    const cands = g2.battle.units.filter((u) => u.faction === 0 && !u.destroyed && u.alive > 60
      && s.wallSideAt(u.x, u.z) > 0 && !s.isGarrisoned(u.id) && !s.owned.has(u.id));
    let best = null;
    for (const u of cands) {
      const d = Math.hypot(u.x - s.sx[st], u.z - s.sz[st]);
      if (!best || d < best.d) best = { d, id: u.id, typeId: u.typeId };
    }
    return { station: st, x: s.sx[st], y: s.sy[st], z: s.sz[st], nx: s.snx[st], nz: s.snz[st],
      unit: best };
  };
});

await page.evaluate(() => window.__game.engine.advance(20, 166));
await settle(300);
const T = await page.evaluate(() => window.__pickTarget());
console.log(`  bay station ${T.station} at (${T.x.toFixed(1)}, ${T.z.toFixed(1)}) walk y ${T.y.toFixed(2)}; `
  + `cohort ${T.unit?.id} (${T.unit?.typeId}) ${T.unit?.d.toFixed(0)} m out`);

// Select the storming cohort with a real click, else `selectionIsStorming()` is false by
// definition and the whole question is unaskable.
const px0 = await page.evaluate((id) => window.__aim(id), T.unit.id);
await page.evaluate(([u]) => {
  const g = window.__game, b = g.battle.unitById(u);
  g.setCamera(b.x, b.z, 0.34, Math.PI);
}, [T.unit.id]);
await settle(400);
let sel = [];
outer: for (const r of [0, 12, 26, 44, 70]) {
  const dirs = r === 0 ? 1 : 10;
  for (let a = 0; a < dirs; a++) {
    const p = await page.evaluate((id) => window.__aim(id), T.unit.id);
    if (!p) break outer;
    const x = p.x + Math.cos((a * Math.PI * 2) / dirs) * r;
    const y = p.y + Math.sin((a * Math.PI * 2) / dirs) * r;
    await page.mouse.move(x, y); await settle(80);
    const q = await page.evaluate(() => ({ h: window.__hovered(), ui: window.__overUi() }));
    if (q.ui || q.h !== T.unit.id) continue;
    await page.mouse.click(x, y); await settle(260);
    sel = await page.evaluate(() => window.__selected());
    if (sel.includes(T.unit.id)) break outer;
  }
}
const stormNow = await page.evaluate(() => !!window.__ctl().storming);
console.log(`  selection [${sel.join(',')}] (must contain ${T.unit.id}); `
  + `SelectionController.storming = ${stormNow} — the storm branch of wallValid is `
  + `${stormNow ? 'reachable' : 'UNREACHABLE, and this run grades the defender\'s branch'}`);

/*
 * The camera, parked from the wall's own geometry so both arms photograph the same pixels:
 * 90 m out into the field on the bay's own normal, looking back at it.
 */
/*
 * Park the eye in the field, and *measure* that it is there.
 *
 * The yaw convention is not worth deriving from the rig: the eye stands some distance
 * behind the focus along a bearing this file does not own, and at zoom 0.66 that distance
 * is about 200 m — so a focus 40 m into the field put the eye 160 m inside the city and the
 * probe measured the defender's question by mistake. Every candidate is therefore checked
 * by reading `camera.position` back and asking the sim which side of its own wall it is on.
 */
let anchor = null;
let framing = null;
search:
for (const zoom of [0.30, 0.38, 0.46, 0.56, 0.24, 0.66]) {
  for (let k = 0; k < 16; k++) {
    const yaw = (k / 16) * Math.PI * 2;
    for (const out of [0, 60, 140]) {
      const got = await page.evaluate(([t, z, y, o]) => {
        window.__game.setCamera(t.x + t.nx * o, t.z + t.nz * o, z, y);
        return true;
      }, [T, zoom, yaw, out]);
      void got;
      await settle(240);
      const st = await page.evaluate(([t]) => {
        const g = window.__game, c = g.engine.context.camera.position;
        return { p: window.__project(t.x, t.y, t.z),
          side: g.battle.siege.wallSideAt(c.x, c.z),
          eye: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)] };
      }, [T]);
      if (st.side < 0) continue;
      const p = st.p;
      if (!p || p.x <= 160 || p.x >= W - 160 || p.y <= 250 || p.y >= H - 210) continue;
      anchor = p;
      framing = { zoom, yaw: +yaw.toFixed(3), out, eye: st.eye };
      break search;
    }
  }
}
if (!anchor) { console.error('  could not frame the bay from a camera standing in the field'); await browser.close(); process.exit(2); }
console.log(`  bay projects to (${anchor.x | 0}, ${anchor.y | 0}) at zoom ${framing.zoom}, yaw `
  + `${framing.yaw}, focus ${framing.out} m out; the eye is at ${JSON.stringify(framing.eye)}, `
  + `on the FIELD side`);

const rows = [];
for (let dy = -70; dy <= 70; dy += 10) {
  for (let dx = -120; dx <= 120; dx += 20) {
    const x = (anchor?.x ?? W / 2) + dx;
    const y = (anchor?.y ?? H / 2) + dy;
    if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
    await page.mouse.move(x, y); await settle(55);
    const c = await page.evaluate(() => window.__cursor());
    if (await page.evaluate(() => window.__overUi())) continue;
    const o = c.solidValid ? await page.evaluate(([px, pz]) => window.__offset(px, pz), [c.solidX, c.solidZ]) : null;
    rows.push({ dx, dy, ...c, off: o });
  }
}
const masonry = rows.filter((r) => r.solidValid);
const ok = masonry.filter((r) => r.wallValid);
const offs = masonry.map((r) => r.off?.off).filter((v) => typeof v === 'number').sort((a, b) => a - b);
const band = masonry.find((r) => r.off)?.off;
console.log(`\n  ${rows.length} pixels swept, ${masonry.length} hit masonry, `
  + `${ok.length} of those answer wallValid  (${(100 * ok.length / Math.max(1, masonry.length)).toFixed(1)}%)`);
if (offs.length) {
  console.log(`  hit offset across the curtain: min ${offs[0]}, median ${offs[offs.length >> 1]}, `
    + `max ${offs[offs.length - 1]} m against a click band of `
    + `${band ? `${(band.inner - 1.7).toFixed(2)} … ${(band.outer + 1.7).toFixed(2)}` : '?'} m`);
}
const rowsY = new Map();
for (const r of masonry) {
  const k = r.dy;
  const v = rowsY.get(k) ?? { n: 0, ok: 0 };
  v.n++; if (r.wallValid) v.ok++;
  rowsY.set(k, v);
}
for (const [k, v] of [...rowsY.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`    dy ${String(k).padStart(4)}  masonry ${String(v.n).padStart(2)}  wallValid ${String(v.ok).padStart(2)}`);
}
console.log(`  page errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT),
  JSON.stringify({ map: MAP, target: T, selection: sel, storming: stormNow, framing, anchor, rows }, null, 1));
await browser.close();
process.exit(ok.length > 0 ? 0 : 1);
