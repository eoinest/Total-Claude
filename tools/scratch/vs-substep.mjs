/**
 * scratch: does `motion: 'substep'` produce the same battle as `motion: 'hold'`?
 *
 * The video studio's default slow motion renders extra frames with `Time.paused` set, which
 * fires no tick and touches no accumulator, so it is bit-identical to real time by construction.
 * The opt-in `substep` mode instead runs `advance(1/(30n), 1000/(30n))` per output frame, which
 * ticks on every nth call and interpolates the men in between. `Engine.advance`'s own comment
 * says a coarser step reaches the simulation; this asks whether a *finer* one does too.
 *
 * Two loads of the same battle, same seed, same total elapsed time, same number of 1/30 s
 * ticks — one at stepMs 1000/30 and one at 1000/60 — hashed against each other with the same
 * FNV-1a over exact float bits that `qa-determinism.mjs` uses.
 *
 *   node tools/scratch/vs-substep.mjs [port] [seconds]
 */
import { chromium } from 'playwright';

const PORT = process.argv[2] ?? '5209';
const SECS = Number(process.argv[3] ?? 40);
const base = `http://127.0.0.1:${PORT}`;

const HASH_FN = `
  window.__poolHash = () => {
    const p = window.__game.battle.pool;
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    let h = 0x811c9dc5;
    const mix = (u) => { h ^= u & 255; h = Math.imul(h, 0x01000193);
      h ^= (u >>> 8) & 255; h = Math.imul(h, 0x01000193);
      h ^= (u >>> 16) & 255; h = Math.imul(h, 0x01000193);
      h ^= (u >>> 24) & 255; h = Math.imul(h, 0x01000193); };
    const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
    for (let i = 0; i < p.count; i++) { f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]); }
    return (h >>> 0).toString(16);
  };
`;

const cfg = {
  map: 'campus-martius', scenario: 'assault', opponent: 1, unitSize: 'ultra',
  difficulty: 'hard', timeOfDay: 14.3, seed: 4265438264,
};
const token = Buffer.from(JSON.stringify(cfg)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function arm(sub) {
  const p = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await p.goto(`${base}/?harness=1&quality=ultra&w=960&h=540&map=campus-martius&scenario=assault&enemy=juthungi&battle=${token}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
  await p.evaluate(() => window.__game.engine.stop());
  await p.evaluate(HASH_FN);
  const out = await p.evaluate((a) => {
    const g = window.__game;
    const calls = a.secs * 30 * a.sub;
    const dt = 1 / (30 * a.sub);
    const ms = 1000 / (30 * a.sub);
    for (let i = 0; i < calls; i++) g.engine.advance(dt, ms, { render: false });
    const pool = g.battle.pool;
    let alive = 0;
    for (let i = 0; i < pool.count; i++) if (pool.state[i] !== 10 && pool.state[i] !== 11) alive++;
    return { sub: a.sub, t: +g.simTime().toFixed(4), hash: window.__poolHash(), alive };
  }, { secs: SECS, sub });
  await p.close();
  return out;
}

const a = await arm(1);
const b = await arm(2);
const c = await arm(1);
console.log(`hold   x1  t+${a.t}  alive ${a.alive}  ${a.hash}`);
console.log(`substep x2 t+${b.t}  alive ${b.alive}  ${b.hash}`);
console.log(`hold   x1  t+${c.t}  alive ${c.alive}  ${c.hash}   (control re-run)`);
console.log(a.hash === c.hash ? 'control: the two 1x runs agree' : 'CONTROL FAILED: two 1x runs disagree');
console.log(a.hash === b.hash
  ? 'substep is bit-identical to hold at this horizon'
  : 'substep DIVERGES from hold — a slow-motion insert is not the same battle');
await browser.close();
