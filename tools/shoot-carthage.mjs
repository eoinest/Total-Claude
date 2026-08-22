#!/usr/bin/env node
/**
 * Screenshot harness for the Carthaginian order of battle.
 *
 * Its own script rather than shots added to `tools/shoot.mjs`, for two reasons. The
 * architecture says the shared `SHOTS` map is the integrator's to extend; and `shoot.mjs`'s
 * auto-framing cameras accumulate army centroids into `const cx = [0, 0]` indexed by
 * `p.faction[i]`, so a faction with id 2 writes to `cx[2]`, `undefined + x` is `NaN`, and the
 * camera goes to the origin. Fixing that is a one-line change in a file another workstream
 * is also editing, so it is reported rather than made.
 *
 *   node tools/shoot-carthage.mjs --port=5541 --out=screenshots/carthage
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5541);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/carthage');
const ONLY = args.get('shots') ? String(args.get('shots')).split(',') : null;
const W = Number(args.get('w') ?? 1920);
const H = Number(args.get('h') ?? 1080);

/**
 * `?battle=` is base64url of the config JSON, matching `encodeConfig`. Only the fields that
 * differ from the default need to be present: `sanitiseConfig` refills anything absent, and
 * an empty composition falls back to `DEFAULT_CONFIG`'s — so `{opponent: 2}` deploys the
 * shipped Punic order of battle.
 */
const token = (o) =>
  Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Carthage as Rome's opponent. `2` is `Faction.Carthage`. */
const PUNIC = (hour) => token({ opponent: 2, timeOfDay: hour });

const SHOTS = {
  // --- daylight, matching r2-00's hazy afternoon ---------------------------
  eleline: {
    hour: 10, at: 6, follow: 'war-elephants', 
    desc: 'The elephant line in front of the Punic centre, seen from the Roman side',
    cam: { x: 0, z: 0, zoom: 0.52, yaw: 0 },
  },
  elecharge: {
    hour: 10, at: 54, follow: 'war-elephants', 
    desc: 'Elephants at the charge, head on',
    cam: { x: 0, z: 0, zoom: 0.52, yaw: 0 },
  },
  eleclose: {
    hour: 9, at: 30, follow: 'war-elephants', single: true, 
    desc: 'Close on one animal: chamfron, tusks, tower and mahout',
    cam: { x: 0, z: 0, zoom: 0.34, yaw: Math.PI * 0.16 },
  },
  eleflank: {
    hour: 10, at: 30, follow: 'war-elephants', single: true, 
    desc: 'Three-quarter rear: the howdah, its crew and the caparison',
    cam: { x: 0, z: 0, zoom: 0.36, yaw: Math.PI * 1.28 },
  },
  punicline: {
    hour: 10, at: 8, follow: 'libyan-spearmen', 
    desc: 'Along the Punic battle line — Libyan, Iberian and Gallic blocks interleaved',
    cam: { x: 0, z: 0, zoom: 0.50, yaw: Math.PI * 0.5 },
  },
  punicinf: {
    hour: 11, at: 8, follow: 'iberian-scutarii', 
    desc: 'Low telephoto into the Iberian ranks — white linen, falcata, sinew caps',
    cam: { x: 0, z: 0, zoom: 0.40, yaw: 0 },
  },
  sacredband: {
    hour: 10, at: 8, follow: 'sacred-band', 
    desc: 'The Sacred Band: Attic helmets, hoplons, linen and purple',
    cam: { x: 0, z: 0, zoom: 0.40, yaw: 0 },
  },
  slingers: {
    hour: 10, at: 20, follow: 'balearic-slingers', 
    desc: 'Balearic slingers loosing',
    cam: { x: 0, z: 0, zoom: 0.38, yaw: Math.PI * 0.1 },
  },
  clash: {
    hour: 10, at: 108, follow: 'libyan-spearmen', 
    desc: 'The lines meet',
    cam: { x: 0, z: 0, zoom: 0.48, yaw: Math.PI * 0.62 },
  },
  elemelee: {
    hour: 10, at: 82, follow: 'war-elephants', 
    desc: 'Elephants into unsupported infantry',
    cam: { x: 0, z: 0, zoom: 0.44, yaw: Math.PI * 0.2 },
  },
  // --- low sun, closer to r2-08's firelit night ----------------------------
  eledusk: {
    hour: 18, at: 40, follow: 'war-elephants', 
    desc: 'The elephant line under a low sun',
    cam: { x: 0, z: 0, zoom: 0.46, yaw: Math.PI * 0.06 },
  },
  punicdusk: {
    hour: 18, at: 10, follow: 'gallic-mercenaries', 
    desc: 'Gallic mercenaries under a low sun',
    cam: { x: 0, z: 0, zoom: 0.42, yaw: Math.PI * 0.42 },
  },
  numidian: {
    hour: 10, at: 44, follow: 'numidian-cavalry', 
    desc: 'Numidian light horse on the wing',
    cam: { x: 0, z: 0, zoom: 0.44, yaw: Math.PI * 0.3 },
  },
};

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const names = (ONLY ?? Object.keys(SHOTS)).filter((n) => SHOTS[n]);
// Group by hour so one page load serves every shot at that time of day: a reload costs
// about twenty seconds of atlas and animation baking.
const byHour = new Map();
for (const n of names) {
  const h = SHOTS[n].hour;
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h).push(n);
}

const report = [];
for (const [hour, group] of byHour) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  const url = `${base}/?harness=1&quality=ultra&w=${W}&h=${H}&battle=${PUNIC(hour)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 150000 });

  /**
   * Neuter the AI, exactly as `tools/matchup.mjs` does.
   *
   * Not a cosmetic choice: `AIWorld.attach` registers perception views for Rome and the
   * Juthungi only and `view()` launders the miss through a non-null assertion, so
   * `buildThreats` throws `Cannot read properties of undefined (reading 'seen')` on the
   * first tick a Carthaginian unit exists. `src/ai/*` belongs to another workstream, so the
   * fix is reported rather than made; these frames are graded on how the army *looks*, and
   * the scenario already issues the advance orders the AI would have given.
   */
  await page.evaluate(() => {
    const ctx = window.__game.engine.context;
    for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage']) {
      const sys = ctx.tryGet(name);
      if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
    }
  });
  // The world is what is being graded, so the DOM HUD comes off — same as `shoot.mjs --nohud`.
  await page.addStyleTag({
    content: '#hud-root, #loading { display: none !important; visibility: hidden !important; }',
  });

  // Sorted by sim time so the battle is advanced forward once, never restarted.
  group.sort((a, b) => SHOTS[a].at - SHOTS[b].at);
  let t = 0;
  for (const name of group) {
    const s = SHOTS[name];
    const stats = await page.evaluate(
      async ({ s, dt }) => {
        const g = window.__game;
        if (dt > 0) g.advance(dt);
        /**
         * Framing follows the troops rather than a hand-placed coordinate.
         *
         * `shoot.mjs` records why: a hardcoded focus "goes stale the moment the order of
         * battle, the terrain or the deployment changes, and it did — the line ended up in
         * the top-left corner with 90% of the frame full of grass." The first pass of this
         * script did exactly that and photographed an empty field.
         */
        let cx = s.cam.x;
        let cz = s.cam.z;
        if (s.follow) {
          const b = g.battle;
          const p = b.pool;
          /**
           * One unit, not the centroid of every unit of that type.
           *
           * Measured the hard way: the two elephant units screen the Punic line from x -65
           * and x +65, so their combined centroid is x 0 — 65 m of empty grass between them,
           * which is precisely what the camera photographed. A centroid is only a subject
           * when the thing it averages is contiguous.
           */
          let sx = 0;
          let sz = 0;
          let nn = 0;
          const pick = b.units.filter((u) => !u.destroyed && u.typeId === s.follow && u.alive > 0);
          const chosen = pick[Math.min(pick.length - 1, s.which ?? 0)];
          if (chosen) {
            if (s.single) {
              /**
               * One animal, not the unit's centre.
               *
               * A portrait framed on a unit centroid cannot work for elephants: the camera
               * boom is about 10 m at these zooms and the animals stand on a 3.8 m lattice,
               * so the focus lands *between* them and the nearest one is a metre from the
               * lens. Measured boom against zoom on this camera: 0.07 -> 3 m, 0.3 -> 8.6 m,
               * 0.5 -> 35 m. Nothing about that is linear, which is why these were guessed
               * wrong twice.
               */
              const i = chosen.members.find((k) => p.aliveAt(k));
              if (i !== undefined) { sx = p.x[i]; sz = p.z[i]; nn = 1; }
            } else {
              for (const i of chosen.members) {
                if (!p.aliveAt(i)) continue;
                sx += p.x[i]; sz += p.z[i]; nn++;
              }
            }
          }
          if (nn > 0) {
            /**
             * The focus goes *on* the subject, not behind it.
             *
             * `setCamera(x, z, zoom, yaw)` sets the point the camera looks at; the eye sits
             * behind it on a boom whose length comes from the zoom — `shoot.mjs` measures
             * that boom at 116 m at zoom 0.66. So an extra stand-off subtracted here moves
             * the *look-at* away from the troops and photographs the empty ground in front
             * of them, which is exactly what the first two passes of this script did.
             */
            cx = sx / nn;
            cz = sz / nn;
          }
        }
        g.setCamera(cx, cz, s.cam.zoom, s.cam.yaw);
        g.advance(0.34);
        const r = g.engine.ctx.renderer;
        const b = g.battle;
        let ele = 0;
        let punic = 0;
        for (const u of b.units) {
          if (u.destroyed) continue;
          if (u.typeId === 'war-elephants') ele += u.alive;
          if (u.faction === 2) punic += u.alive;
        }
        return {
          fps: Math.round(g.engine.ctx.time.fps),
          frameMs: +g.engine.ctx.time.frameMs.toFixed(2),
          draws: r.info.render.calls,
          tris: r.info.render.triangles,
          simTime: +g.simTime().toFixed(1),
          elephants: ele,
          punicMen: punic,
        };
      },
      { s, dt: Math.max(0, s.at - t) }
    );
    t = s.at;
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    report.push({ name, ...stats, desc: s.desc });
    console.log(
      `${name.padEnd(12)} t+${String(stats.simTime).padStart(5)}  `
      + `${String(stats.draws).padStart(4)} draws  ${(stats.tris / 1e6).toFixed(2)}M tris  `
      + `${stats.frameMs.toFixed(2)} ms  ele ${stats.elephants}  punic ${stats.punicMen}`
    );
  }
  await page.close();
}

/*
 * Wrapped in the same provenance envelope `tools/shoot.mjs` writes, because
 * `tools/blind-compare.mjs` refuses to build a blind deck from a directory that cannot
 * prove it was shot without the interface. This pass strips the HUD unconditionally
 * (above), so `hud` is a constant false rather than a flag — but it has to be *recorded*,
 * or a deck built from this directory is indistinguishable from a careless one.
 */
await writeFile(path.join(OUT, 'report.json'), JSON.stringify({
  at: new Date().toISOString(),
  tool: 'tools/shoot-carthage.mjs',
  argv: process.argv.slice(2),
  hud: false,
  worldOverlay: 'n/a',
  blindSafe: true,
  shots: report,
}, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
