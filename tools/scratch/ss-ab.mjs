#!/usr/bin/env node
/**
 * Before/after wall clock to a fixed sim time, interleaved.
 *
 * Two dev servers, two pages, both with the rAF loop stopped so that only the arm being
 * measured is doing anything, and the schedule alternated chunk by chunk so a load spike lands
 * on both arms. That is the house rule on this box: two whole runs an hour apart are not
 * comparable, and the frame-time work on this project has been wrong twice for exactly that.
 *
 * Arm A drives the shipped `window.__game.advance(chunk)`. Arm B drives whatever `--armB`
 * names — by default `fastForward`, the same fast-forward with the submit left out.
 * Pool hashes are printed at every chunk boundary, so "faster" and "the same battle" are two
 * separate columns rather than one claim.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT_A = Number(args.get('portA') ?? 5789);
const PORT_B = Number(args.get('portB') ?? 5788);
const UNTIL = Number(args.get('until') ?? 200);
const CHUNK = Number(args.get('chunk') ?? 25);
const Q = args.get('quality') ?? 'high';
const W = Number(args.get('w') ?? 1600), H = Number(args.get('h') ?? 900);
const BOOT = args.get('boot') ?? 'menu0';
const ARM_B = args.get('armB') ?? 'fastForward';
const JSON_OUT = args.get('json') ?? null;
const load = () => { try { const m = execFileSync('uptime', { encoding: 'utf8' }).match(/load averages?:\s*([\d.]+)/); return m ? +m[1] : null; } catch { return null; } };
const HASH_FN = `window.__poolHash = () => {
  const p = window.__game.battle.pool; const dv = new DataView(new ArrayBuffer(4)); let h = 0x811c9dc5;
  const mix = (u) => { h ^= u & 0xff; h = (h*0x01000193)>>>0; h ^= (u>>>8)&0xff; h = (h*0x01000193)>>>0;
    h ^= (u>>>16)&0xff; h = (h*0x01000193)>>>0; h ^= (u>>>24)&0xff; h = (h*0x01000193)>>>0; };
  const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
  let alive = 0;
  for (let i = 0; i < p.count; i++) { f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]); if (p.state[i]!==10&&p.state[i]!==11) alive++; }
  return { hash: (h>>>0).toString(16).padStart(8,'0'), alive };
};`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function open(port, label) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  const url = BOOT === 'harness'
    ? `http://127.0.0.1:${port}/?harness=1&autoplay=1&w=${W}&h=${H}&map=carthage&scenario=assault&quality=${Q}`
    : `http://127.0.0.1:${port}/?menu=0&map=carthage&scenario=assault&autoplay=1&quality=${Q}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  // Stop the rAF loop on both, so the only work either page does is the chunk it is asked for.
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(HASH_FN);
  const men = await page.evaluate(() => window.__game.battle.units.reduce((a, u) => a + u.alive, 0));
  console.log(`${label}: ${url}  men ${men}`);
  return { page, errors, wall: 0, label };
}
const A = await open(PORT_A, 'A before');
const B = await open(PORT_B, `B after (${ARM_B})`);
const marks = [];
console.log(`\n  simT |    A wall   A hash |    B wall   B hash | same | speedup   load`);
for (let t = CHUNK; t <= UNTIL; t += CHUNK) {
  const ta = Date.now();
  await A.page.evaluate((s) => window.__game.advance(s), CHUNK);
  A.wall += Date.now() - ta;
  const tb = Date.now();
  await B.page.evaluate(([s, fn]) => (fn === 'fastForward' ? window.__game.fastForward(s) : window.__game.advance(s)), [CHUNK, ARM_B]);
  B.wall += Date.now() - tb;
  const ha = await A.page.evaluate(() => window.__poolHash());
  const hb = await B.page.evaluate(() => window.__poolHash());
  const same = ha.hash === hb.hash;
  marks.push({ t, aWall: A.wall / 1000, bWall: B.wall / 1000, aHash: ha.hash, bHash: hb.hash, same, alive: ha.alive });
  console.log(`  ${String(t).padStart(4)} | ${(A.wall / 1000).toFixed(1).padStart(8)}s ${ha.hash} | ${(B.wall / 1000).toFixed(1).padStart(8)}s ${hb.hash} | ${same ? ' == ' : '!!!!'} | ${(A.wall / B.wall).toFixed(2)}x  ${load()}`);
}
const bad = marks.filter((m) => !m.same).length;
console.log(`\nA (before) ${(A.wall / 1000).toFixed(1)}s to t+${UNTIL}  =>  ${(UNTIL / (A.wall / 1000)).toFixed(3)}x realtime`);
console.log(`B (after)  ${(B.wall / 1000).toFixed(1)}s to t+${UNTIL}  =>  ${(UNTIL / (B.wall / 1000)).toFixed(3)}x realtime`);
console.log(bad ? `FAIL: ${bad} checkpoint(s) diverged` : `PASS: identical pool hash at all ${marks.length} checkpoints`);
console.log(`speedup ${(A.wall / B.wall).toFixed(2)}x`);
if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify({ portA: PORT_A, portB: PORT_B, quality: Q, w: W, h: H, boot: BOOT, armB: ARM_B, marks, aErrors: A.errors, bErrors: B.errors }, null, 1));
for (const r of [A, B]) if (r.errors.length) console.log(r.label, 'ERRORS', r.errors.slice(0, 5));
await browser.close();
