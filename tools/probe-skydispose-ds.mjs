#!/usr/bin/env node
/**
 * Does `SkySystem.dispose` give back everything it took?
 *
 * **A leak is monotonic growth, so the instrument is a cycle and not a single dispose.**
 * One init/dispose pair proves nothing: a scene that gains a child and a renderer that gains
 * a geometry can both be explained by something else on the frame. Ten pairs cannot. This
 * builds a *fresh* `SkySystem` against the live `EngineContext`, inits it, disposes it, and
 * counts four things every round:
 *
 *   - `scene.children.length`             — the sky quad is a child of the scene
 *   - children named 'sky'                — named at `buildBackground`, so it can be counted
 *   - `renderer.info.memory.geometries`   — GPU buffers three is still tracking
 *   - `renderer.info.memory.textures`     — the cube target, the PMREM and the cloud noise
 *
 * and two facts that are not counts:
 *
 *   - `scene.fog !== null`                — this system constructs it and nothing else writes it
 *   - `scene.environment !== null`        — the PMREM texture, freed by `pmremRT.dispose()`
 *
 * The last two are the interesting ones. A dangling `scene.environment` is not a leak in the
 * ordinary sense — the texture is *smaller* after dispose, not bigger. It is worse than a
 * leak: the scene holds a pointer to a destroyed GPU object and the next renderer to walk it
 * binds one.
 *
 * The app's own sky is left alone until the last round, so the page is still a game while the
 * cycles run.
 *
 *   node tools/probe-skydispose-ds.mjs --port=5435 [--cycles=10] [--map=campus-martius]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5435);
const CYCLES = Number(args.get('cycles') ?? 10);
const MAP = args.get('map') ?? 'campus-martius';

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'field' }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const url = `${base}/?harness=1&w=640&h=360&quality=low&battle=${token}`;
console.log(`[probe-skydispose] ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 300)}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, {
  timeout: 300000,
  polling: 250,
});

const out = await page.evaluate(async (cycles) => {
  const engine = window.__game.engine;
  const ctx = engine.context;
  const scene = ctx.scene;
  const info = ctx.renderer.info;

  const skyOf = () => {
    let n = 0;
    for (const c of scene.children) if (c.name === 'sky') n++;
    return n;
  };
  const snap = (label) => ({
    label,
    children: scene.children.length,
    named: skyOf(),
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    fog: scene.fog !== null && scene.fog !== undefined,
    env: scene.environment !== null && scene.environment !== undefined,
  });

  // The live system's class, taken from the instance so the probe cannot load a second copy
  // of the module and measure a different one.
  const live = ctx.get('sky');
  const Ctor = Object.getPrototypeOf(live).constructor;

  const rows = [snap('boot')];
  for (let i = 0; i < cycles; i++) {
    const s = new Ctor();
    // `init` is synchronous apart from a fire-and-forget HDRI load, which is silent-and-
    // continue against an empty public/assets and does not touch the scene on failure.
    s.init(ctx);
    rows.push(snap(`init ${i + 1}`));
    s.dispose();
    rows.push(snap(`dispose ${i + 1}`));
  }

  // Finally the real one, which is what `Engine.dispose` does.
  live.dispose();
  rows.push(snap('live dispose'));

  return { rows };
}, CYCLES);

const rows = out.rows;
console.log('\n  step            children  named-sky   geoms   textures   scene.fog  scene.env');
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(14)} ${String(r.children).padStart(8)} ${String(r.named).padStart(10)} ` +
      `${String(r.geometries).padStart(7)} ${String(r.textures).padStart(10)} ` +
      `${String(r.fog).padStart(11)} ${String(r.env).padStart(10)}`,
  );
}

const boot = rows[0];
const cycled = rows.filter((r) => r.label.startsWith('dispose'));
const first = cycled[0];
const last = cycled[cycled.length - 1];
const liveRow = rows[rows.length - 1];

console.log('\n  verdict');
const say = (ok, s) => console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${s}`);
say(
  last.children === first.children,
  `scene children across ${cycled.length} dispose cycles: ${first.children} -> ${last.children} ` +
    `(drift ${last.children - first.children} per ${cycled.length} cycles)`,
);
say(
  last.named === boot.named && first.named === boot.named,
  `children named 'sky' held at ${boot.named} through every cycle (last ${last.named})`,
);
say(
  last.geometries - first.geometries === 0,
  `renderer geometries: ${first.geometries} -> ${last.geometries} across the cycles`,
);
say(
  last.textures - first.textures === 0,
  `renderer textures: ${first.textures} -> ${last.textures} across the cycles`,
);
say(!liveRow.named, `after the live system's dispose, 0 sky meshes remain (${liveRow.named})`);
say(!liveRow.fog, `after the live system's dispose, scene.fog is surrendered (${liveRow.fog})`);
say(
  !liveRow.env,
  `after the live system's dispose, scene.environment is surrendered (${liveRow.env})`,
);

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
} else {
  console.log('\nno page errors');
}

await browser.close();
if (server) {
  server.kill('SIGTERM');
  console.log(`• killed vite pid ${server.pid}`);
}
