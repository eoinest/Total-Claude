#!/usr/bin/env node
/**
 * Film the camera walking on top of a wall. Before and after, the same four walks.
 *
 * The change this films is a *feel* change, and no still can show it. A parked camera on a
 * parapet is a number — 1.70 m over the walkway instead of 12.07 m under it — and
 * `tools/probe-walleye.mjs` prints that number at thirty stations. What it cannot print is
 * what going over the edge looks like, which is the half of the brief that says "the eye must
 * not teleport 27 m when the focus crosses the parapet line".
 *
 * So this holds a key down in real time and lets Playwright's own screencast record the page.
 * Everything about that is deliberate:
 *
 *  - **Real time, not `advance`.** A fast-forward renders as fast as the CPU manages and the
 *    screencast would sample it at whatever cadence it liked, so the recording would not be
 *    of the motion the player sees. This runs the ordinary rAF loop and waits on the clock.
 *  - **A real held key, through `Input`.** `page.keyboard.down('KeyW')` reaches `window`'s
 *    own listener, so the pan is `RTSCamera.handleInput` and not a second copy of it written
 *    here. An instrument that drives the focus directly cannot see a defect in the driving.
 *  - **One video per arm per map**, with the walks back to back and a titled pause between
 *    them, because the comparison a human makes is "play both, look". Playwright's screencast
 *    is VP8/WebM and needs no ffmpeg, which this repo does not have.
 *
 * The walks are resolved against the live wall — `getGarrisonBays()`, `getWallStairs()`,
 * `getGateBlock()` — for the reason every other camera in this project is: the circuit is
 * generated and a written-down coordinate has a shelf life.
 *
 * Usage:
 *   node tools/film-walleye.mjs --port=5347 --map=carthage --out=screenshots/walleye/after
 *   node tools/film-walleye.mjs --port=5348 --map=rome --out=screenshots/walleye/before
 *
 * Requires a dev server you started yourself on `--port`, for the same reason the probes do:
 * a tool that falls back to a stale `dist/` films a tree nobody is editing.
 */

import { chromium } from 'playwright';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const PORT = Number(args.get('port') ?? 5347);
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'assault';
const QUALITY = args.get('quality') ?? 'high';
const OUT = path.resolve(ROOT, args.get('out') ?? `screenshots/walleye/${MAP}`);
const W = Number(args.get('w') ?? 1280);
const H = Number(args.get('h') ?? 720);
/** Metres of ground the eye-level pan covers per second. Measured, not nominal. */
const PAN_RATE = 11;
/** Seconds parked at the start of each walk, so the eye is visibly settled before it moves. */
const SETTLE = Number(args.get('settle') ?? 1.0);
const TIMEOUT = Number(args.get('timeout') ?? 240000);
/** Plates per walk in the contact strip. 0 turns it off. See the note above the strip loop. */
const STRIP = Number(args.get('strip') ?? 7);

const base = `http://127.0.0.1:${PORT}`;
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?harness=1&quality=${QUALITY}&autoplay=0&hud=0&scenario=${SCENARIO}`
  + `&w=${W}&h=${H}&battle=${token}`;

// ---- provenance: which source is on the wire, not which directory was asked for ---------
const served = await fetch(`${base}/src/core/RTSCamera.ts`).then((r) => r.text()).catch(() => '');
if (!served) {
  console.error(`FATAL: nothing served at ${base}/src/core/RTSCamera.ts — is vite up on ${PORT}?`);
  process.exit(2);
}
const arm = served.includes('walkableTopAt') ? 'AFTER' : 'BEFORE';
console.log(`arm:  ${arm}  (${served.length} bytes of src/core/RTSCamera.ts from ${base})`);
console.log(`map:  ${MAP}  out: ${OUT}`);

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: TIMEOUT });
console.log('booted');

/*
 * The interface off, both halves of it, exactly as `tools/shoot.mjs` does.
 *
 * A DOM strip is not enough on its own: `WorldOverlay` is a `THREE.Group` in the scene —
 * selection footprints, facing arrows, order paths — so `#hud-root { display: none }` leaves
 * every one of them drawing. `?hud=0` in the URL above is not a parameter this app reads; it
 * is left in only because it is how every other harness invocation in this repo is spelled,
 * and this is the line that actually does it.
 */
await page.addStyleTag({
  content: '#hud-root, #loading, #menu-root { display: none !important; visibility: hidden !important; }',
});
const overlay = await page.evaluate(() => {
  const hud = window.__game?.engine?.context?.tryGet?.('hud');
  if (!hud || !hud.overlay) return 'absent';
  hud.overlay.visible = false;
  return hud.overlay.visible === false ? 'hidden' : 'refused';
});
console.log(`HUD off: DOM stripped, world overlay ${overlay}`);

/**
 * A caption burnt into the page, so a reviewer scrubbing the file knows which walk is which
 * and which arm they are looking at without a second window open.
 *
 * On the page rather than in the encoder because there is no encoder: the screencast records
 * what the compositor shows.
 */
await page.evaluate((tag) => {
  const el = document.createElement('div');
  el.id = '__filmcap';
  el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;'
    + 'font:600 15px/1.5 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.55);'
    + 'padding:6px 12px;letter-spacing:.02em;pointer-events:none;white-space:pre';
  el.textContent = tag;
  document.body.appendChild(el);
  window.__filmcap = (t) => { el.textContent = t; };
}, `${arm}`);

// ---- the walks, resolved off the live wall ----------------------------------------------
const plan = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const city = ctx.tryGet('city');
  if (!city) return [];
  const bays = [...city.getGarrisonBays()];
  const stairs = [...city.getWallStairs()];
  const gb = city.getGateBlock ? city.getGateBlock() : null;
  const walkable = bays.filter((b) => b.walkable && !b.isGate);
  const bay = walkable[Math.floor(walkable.length * 0.5)] ?? bays[0];
  const t = bay.length * 0.5;
  const cx = bay.x0 + bay.dx * t;
  const cz = bay.z0 + bay.dz * t;
  const outYaw = Math.atan2(bay.nx, bay.nz);
  const alongYaw = Math.atan2(bay.dx, bay.dz);
  const p = [];

  /*
   * Each walk is a **distance**, not a duration, and the driver holds the key until the focus
   * has covered it.
   *
   * The first cut held every walk for the same 3.2 s. The eye-level pan rate is a clean 11.00
   * m/s — measured, in real time, at three durations — so that is 35 m for every subject
   * whatever its length, and the stair reached its head at 24 m and then walked off the end of
   * the landing for the remaining eleven. What that films is the fall and not the climb. The
   * second cut converted the length to seconds at 11 m/s and still overshot by 2.5 m, which is
   * past the landing capsule, so the mark came back mid-fall at 18.55 instead of 26.00 at the
   * head. A frame rate this tool does not control has no business deciding where the shot
   * stops, so it does not: the numbers below are metres of ground.
   */
  p.push({
    name: '1. along the parapet',
    note: 'eye level, down the wall-walk',
    x: cx, z: cz, yaw: alongYaw, key: 'KeyW', metres: 38,
  });
  p.push({
    name: '2. over the edge',
    note: 'out across the fieldward parapet and off it',
    x: cx, z: cz, yaw: outYaw, key: 'KeyW', metres: 28,
  });
  const st = stairs[Math.floor(stairs.length * 0.5)];
  if (st) {
    p.push({
      name: '3. up the stair',
      // Stop at the head: `run` is the plan length of the rake and 11 m/s is the pan rate.
      note: `from the foot in the pomerium onto the walk, ${st.rise.toFixed(1)} m of rise`,
      // 0.92 of the rake: the head, and short of the point where the flight's own capsule
      // ends and the camera is standing on nothing but the pomerium again.
      x: st.footX, z: st.footZ, metres: st.run * 0.92,
      yaw: Math.atan2(st.headX - st.footX, st.headZ - st.footZ), key: 'KeyW',
    });
  }
  p.push({
    name: '4. into the ditch',
    note: 'the earth, which must read exactly as it did before',
    x: cx + bay.nx * 46, z: cz + bay.nz * 46, yaw: outYaw + Math.PI, key: 'KeyW', metres: 42,
  });
  const tower = bays.find((b) => b.hasTower && b.walkable && b.index > 1
    && bays[b.index - 1] && bays[b.index - 1].walkable
    && Math.abs(bays[b.index - 1].walkY - b.walkY) > 0.5);
  if (tower) {
    const mid = (tower.passInner + tower.passOuter) * 0.5;
    p.push({
      name: '5. through a tower',
      note: `the walk steps ${Math.abs(tower.walkY - bays[tower.index - 1].walkY).toFixed(2)} m here`,
      x: tower.x0 + tower.dx * -13 + tower.nx * mid,
      z: tower.z0 + tower.dz * -13 + tower.nz * mid,
      yaw: Math.atan2(tower.dx, tower.dz), key: 'KeyW', metres: 30,
    });
  }
  if (gb) {
    p.push({
      name: '6. through the arch',
      note: 'the carriageway, under the crown',
      x: gb.x + gb.nx * 30, z: gb.z + gb.nz * 30,
      yaw: Math.atan2(-gb.nx, -gb.nz), key: 'KeyW', metres: 62,
    });
  }
  return p;
});

if (plan.length === 0) {
  console.error('FATAL: this map has no city, so there is no wall to walk on');
  await context.close(); await browser.close();
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const marks = [];
let clock = 0;

for (const w of plan) {
  await page.evaluate((p) => {
    window.__game.setCamera(p.x, p.z, 0, p.yaw);
    window.__filmcap(`${p.name}  —  ${p.note}`);
  }, w);
  clock += SETTLE;
  await wait(SETTLE * 1000);
  const before = await page.evaluate(() => {
    const r = window.__game.engine.rig;
    return { eye: r.camera.position.y, focus: r.focus.y };
  });
  await page.keyboard.down(w.key);
  const t0 = Date.now();
  let held = 0;
  // Poll the focus rather than the clock. Bounded, because a walk that cannot advance — a
  // bounds clamp, a key that never reached the page — must end the shot rather than the run.
  for (;;) {
    await wait(60);
    held = (Date.now() - t0) / 1000;
    const d = await page.evaluate((p) => {
      const r = window.__game.engine.rig;
      return Math.hypot(r.focus.x - p.x, r.focus.z - p.z);
    }, w);
    if (d >= w.metres || held > w.metres / PAN_RATE + 4) break;
  }
  clock += held;
  await page.keyboard.up(w.key);
  await wait(400);
  clock += 0.4;
  const after = await page.evaluate(() => {
    const r = window.__game.engine.rig;
    const t = r.camera.position;
    return { eye: t.y, focus: r.focus.y, x: r.focus.x, z: r.focus.z };
  });
  marks.push({
    name: w.name, at: +clock.toFixed(1),
    startEyeY: +before.eye.toFixed(2), startFocusY: +before.focus.toFixed(2),
    endEyeY: +after.eye.toFixed(2), endFocusY: +after.focus.toFixed(2),
  });
  console.log(`  ${w.name.padEnd(22)} eye ${before.eye.toFixed(2)} -> ${after.eye.toFixed(2)}  `
    + `focus ${before.focus.toFixed(2)} -> ${after.focus.toFixed(2)}`);
}

await page.evaluate(() => window.__filmcap(''));
await wait(300);

/**
 * A contact strip, replayed on the fixed step after the video is in the can.
 *
 * The video is the deliverable and this is what makes it checkable. A screencast cannot be
 * paged through frame by frame from a terminal, and this project has shipped a camera that
 * satisfied every framing statistic while pointing at the wrong unit three times over — so
 * the rule is that somebody looks at what was captured, and these are the plates they look
 * at. Replayed with `advance` rather than in real time so the pair is the same frames and not
 * merely the same seconds, and driven by the same held key so it is the same code path.
 */
if (STRIP > 0) {
  const stripDir = path.join(OUT, `strip-${MAP}-${arm.toLowerCase()}`);
  await mkdir(stripDir, { recursive: true });
  /*
   * **Stop the rAF loop first.** This is not tidiness; the first cut of the strip did not and
   * the plates were nonsense — the stair read 14.0, then 27.7 twenty frames later, then 15.6.
   * Every `page.screenshot` and every `page.evaluate` is a round trip of a few milliseconds,
   * and the engine's own loop keeps running across it with the key still held. So each
   * "1/60 s" step was one fixed step plus however many real frames fitted in the gap, the pan
   * ran at several times 11 m/s, and the frame numbers on the plates were fiction. The probe
   * next door never saw it because its whole walk is inside one `evaluate` and JavaScript is
   * single-threaded. With the loop stopped, `advance` is the only thing moving the world and
   * a plate labelled f120 is the hundred-and-twentieth frame.
   */
  await page.evaluate(() => window.__game.engine.stop());
  let n = 0;
  for (const w of plan) {
    await page.evaluate((p) => {
      window.__game.setCamera(p.x, p.z, 0, p.yaw);
      window.__filmcap(`${p.name}  —  ${p.note}`);
      window.__game.engine.advance(2 / 60);
    }, w);
    // 11.00 m/s at zoom 0, measured. On the fixed step this is exact rather than nominal.
    const frames = Math.round((w.metres / PAN_RATE) * 60);
    const step = Math.max(1, Math.floor(frames / (STRIP - 1)));
    await page.keyboard.down(w.key);
    for (let i = 0; i < frames; i++) {
      await page.evaluate(() => window.__game.engine.advance(1 / 60));
      if (i % step === 0 || i === frames - 1) {
        const rec = await page.evaluate(() => {
          const r = window.__game.engine.rig;
          return { eye: +r.camera.position.y.toFixed(2), focus: +r.focus.y.toFixed(2) };
        });
        const slug = w.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
        await page.screenshot({
          path: path.join(stripDir, `${String(n).padStart(3, '0')}-${slug}-f${String(i).padStart(3, '0')}`
            + `-eye${rec.eye.toFixed(1)}.png`),
        });
        n++;
      }
    }
    await page.keyboard.up(w.key);
  }
  await page.evaluate(() => window.__game.engine.start());
  console.log(`strip: ${n} plates in ${stripDir}`);
}

const video = page.video();
await context.close();
const raw = video ? await video.path() : null;
await browser.close();

/** A stable name, because Playwright's is a random hash and a pair has to be findable. */
const named = path.join(OUT, `walleye-${MAP}-${arm.toLowerCase()}.webm`);
if (raw) {
  await rename(raw, named);
  console.log(`\nvideo: ${named}`);
}
await writeFile(path.join(OUT, `walleye-${MAP}-${arm.toLowerCase()}.json`),
  JSON.stringify({ arm, map: MAP, w: W, h: H, panRate: PAN_RATE, settle: SETTLE, marks, errors }, null, 2));
console.log(`marks: ${marks.map((m) => `${m.name}@${m.at}s`).join(', ')}`);
if (errors.length) {
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}
// Any leftover screencast files from a crashed run would make the pair ambiguous.
for (const f of await readdir(OUT)) {
  if (f.endsWith('.webm') && !f.startsWith('walleye-')) console.log(`  note: stray capture ${f}`);
}
process.exit(errors.length ? 1 : 0);
