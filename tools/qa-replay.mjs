#!/usr/bin/env node
/**
 * QA: the replay record, driven by a real mouse through the real menu.
 *
 * Usage: node tools/qa-replay.mjs [--port=5245] [--json=path] [--shots=dir]
 *                                 [--only=record|replay|coarse|tier|drop|late|bus|write|command]
 *                                 [--seconds=200]
 *
 * An unknown flag, or an unknown `--only=` arm, exits 2 rather than running a subset of
 * nothing and printing a tick. That is not hypothetical: `qa-determinism.mjs --battle=rome`
 * appends a meaningless `&rome`, loads the default field battle, looks up a baseline key that
 * does not exist, compares nothing and exits 0. A gate that can be pointed at nothing and
 * still go green is precisely the defect this file exists to catch, so it must not have it.
 *
 * ## What this is for, and why nothing else in the project can do it
 *
 * `tools/qa-determinism.mjs` loads one build twice and compares the two runs. That answers
 * "does this battle replay" and is structurally incapable of answering "did the player's
 * input reach the simulation through a path anybody recorded". Both of its runs take the
 * same twenty-three out-of-band writes, in the same order, and agree perfectly.
 *
 * This file closes that. It boots the game the way a player does — the front door, the setup
 * sheet, BEGIN BATTLE, the deployment plaque, a real mouse on real pixels — records what
 * that produces, and then replays the record in a fresh page **on a deliberately different
 * frame schedule** and demands bit-equality of the pool hash, both unit hashes and
 * `BattleFlow.result`.
 *
 * The day somebody adds a twenty-fourth input path that writes simulation state from
 * outside a tick, the recorded battle stops replaying and this goes red. Nothing else in
 * this repository can notice that, and three of the arms below exist to prove the claim
 * rather than assert it: each breaks the battle on purpose, in a different way, and is a
 * failure if it does *not* go red.
 *
 * ## The comparison is at an equal tick count, not an equal elapsed time
 *
 * `advance(dt, 166)` and an exactly-five-tick `advance(dt, 1000/6)` produce different
 * hashes from `advance(dt, 1000/60)` at the same wall clock, and the reason is an
 * off-by-one in tick count rather than anything reaching the simulation: at t+30, 1000/60
 * gives 900 ticks, 166 ms gives 901 and 1000/6 gives 899, because `double(1/6)` is about
 * 7e-18 short of five times `double(1/30)` so the fifth subtraction fails once, and
 * `maxStepsPerFrame = 5` means the tick can never be made up. Three separate passes reported
 * those arms as "different battles" and none of them were comparing equal tick counts.
 *
 * `window.__game.advanceTicks(n, stepMs)` runs exactly n ticks at whatever schedule is
 * asked for, using the `Time.tickCeiling` added for this. So the `coarse` arm below runs
 * the identical battle at five ticks per frame and one tick per two frames and is entitled
 * to demand identical bits.
 *
 * ## Port
 *
 * 5245, and never 5173, which belongs to whoever is playing the game.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { bootThroughMenu, ensureServer } from './lib/menu-boot.mjs';
import { stopClockOnReady } from './lib/simclock.mjs';
import { launchBrowser } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
/**
 * The arms, and the reason this list is a constant rather than a string in six `if`s.
 *
 * An unknown flag is silently ignored by the argument parser every tool here shares, and
 * `qa-determinism.mjs` has already been run as `--battle=rome` — which appends a meaningless
 * `&rome`, loads the default field battle, looks up a baseline key that does not exist, and
 * reports success having compared nothing. A gate that can be pointed at nothing and still
 * go green is the defect this file exists to catch, so it must not have it: every flag and
 * every `--only=` value below is checked against this list and an unknown one is fatal.
 */
const ARMS = ['record', 'replay', 'coarse', 'tier', 'drop', 'late', 'bus', 'write', 'command'];
const FLAGS = ['port', 'json', 'shots', 'only', 'seconds'];

const bad = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (bad.length) {
  console.error(`unknown flag(s): ${bad.map((k) => `--${k}`).join(', ')}`);
  console.error(`known: ${FLAGS.map((k) => `--${k}`).join(' ')}`);
  process.exit(2);
}

const PORT = Number(args.get('port') ?? 5245);
const JSON_OUT = args.get('json') ?? null;
const SHOT_DIR = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;
const ONLY = args.get('only') ?? null;
if (ONLY) {
  const unknown = ONLY.split(',').filter((a) => !ARMS.includes(a));
  if (unknown.length) {
    console.error(`unknown arm(s) in --only: ${unknown.join(', ')}`);
    console.error(`known arms: ${ARMS.join(', ')}`);
    process.exit(2);
  }
}
/** Simulated seconds of battle to record. The design's size estimate is for 200. */
const SECONDS = Number(args.get('seconds') ?? 200);
if (!Number.isFinite(SECONDS) || SECONDS < 10) {
  console.error(`--seconds must be a number of at least 10; got '${args.get('seconds')}'`);
  process.exit(2);
}
const W = 1600;
const H = 900;

const results = [];
const measured = {};
let failed = 0;
function record(name, pass, what, changed, note = '') {
  results.push({ name, pass, what, changed, note });
  if (!pass) failed++;
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name.padEnd(22)} ${what}`);
  console.log(`        → ${changed}${note ? `  [${note}]` : ''}`);
}
const wanted = (name) => !ONLY || ONLY.split(',').includes(name);

// ---------------------------------------------------------------------------
// Server and browser
// ---------------------------------------------------------------------------

/*
 * The browser first, then the server — 22 Aug 2026, `tools/lib/browser-budget.mjs`.
 *
 * `launchBrowser` takes one of a small number of machine-wide slots and queues if they are all
 * held, which is the whole point: every agent runs this in its own worktree and no copy of it
 * could see any other. Taking the slot *before* `ensureServer` means a run that has to wait in
 * the queue is not sitting on a dev server and a port while it waits.
 */
const browser = await launchBrowser({
  label: 'qa-replay', port: PORT, root: ROOT,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const { base, server, close: closeServer } = await ensureServer({
  port: PORT, root: ROOT, label: 'qa-replay', slot: browser.budgetSlot,
});
console.log(`server ${base}${server ? ' (started here)' : ' (already up)'}`);
if (SHOT_DIR) await mkdir(SHOT_DIR, { recursive: true });

const settle = (page, ms = 320) => page.waitForTimeout(ms);
const shot = async (page, name) => {
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
};

const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  page.__errs = errs;
  return page;
};

/**
 * Page-side readers. Deliberately read-only: nothing here issues an order or moves a unit,
 * because a gate that drives the API is testing the API. Every order below goes through
 * `page.mouse` and `page.keyboard`.
 */
const INSTALL = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  const V = new (ctx.camera.position.constructor)();
  window.__proj = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH };
  };
  /*
   * Every order on the bus, counted by provenance.
   *
   * This is the number that says the recorder is filtering rather than hoping. `ai/Orders.ts`
   * emits on the same channel the mouse does — thousands of them over a battle — and a bus
   * recorder without a `source` test would capture all of them and double-apply every one on
   * playback, because the AI regenerates them from the same seed anyway.
   */
  window.__bus = { local: 0, ai: 0, deploy: 0, none: 0 };
  ctx.events.on('orderIssued', (o) => {
    const k = o.source ?? 'none';
    window.__bus[k] = (window.__bus[k] ?? 0) + 1;
  });
  window.__rp = () => {
    const r = g.replay;
    return { mode: r.mode, tick: r.tick, remaining: r.remaining, refusal: r.refusal,
      divergedAt: r.divergedAt };
  };
  window.__rec = () => g.replay.record();
  window.__tok = () => g.replay.token();
  window.__dep = () => {
    const d = g.deployment;
    return d ? { active: d.active, committed: d.committed } : null;
  };
  window.__flow = () => {
    const f = g.engine.context.tryGet('battleFlow');
    return f?.result ?? null;
  };
  /** A screen point over bare canvas — nothing of the HUD claims it. */
  window.__bare = () => {
    const out = [];
    for (const fy of [0.42, 0.5, 0.58, 0.36]) {
      for (const fx of [0.3, 0.45, 0.6, 0.7, 0.38]) {
        const x = Math.round(window.innerWidth * fx);
        const y = Math.round(window.innerHeight * fy);
        const el = document.elementFromPoint(x, y);
        if (el && el.id === 'viewport') out.push({ x, y });
      }
    }
    return out;
  };
  /** Where a friendly unit's men are actually drawn, feet first — see qa-interact. */
  window.__unitAt = (i) => {
    const own = g.battle.units.filter((u) => !u.destroyed && u.faction === 0 && u.alive > 0);
    const u = own[i % Math.max(1, own.length)];
    if (!u) return null;
    // Park the camera on the unit first. The camera is render-only — `rig.jumpTo` touches
    // nothing the simulation reads — but without it, only the regiments that happen to be in
    // the boot framing are ever clickable, and half the battle goes unordered. The focus is
    // the unit itself and not an offset from it: the rig centres on what it is given, so any
    // offset walks the men straight out of the band of the screen that is not HUD.
    g.setCamera(u.x, u.z, 0.55, 0);
    const p = g.battle.pool;
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (const k of u.members) {
      if (p.hp[k] <= 0) continue;
      n++; sx += p.x[k]; sy += p.y[k]; sz += p.z[k];
    }
    if (!n) return null;
    const q = window.__proj(sx / n, sy / n + 0.5, sz / n);
    return q ? { id: u.id, ...q } : null;
  };
  window.__selection = () => {
    const h = ctx.tryGet('hud');
    return h ? h.controller.model.selection.slice() : [];
  };
};

// ---------------------------------------------------------------------------
// Arm 1 — record a battle through the real menu with a real mouse
// ---------------------------------------------------------------------------

/**
 * The front door, the setup sheet, the deployment plaque, then orders.
 *
 * `?autoplay=0` and no `?harness=1`: the harness flag pins the canvas and skips the intro
 * fade, and this arm is supposed to be the player's boot. `window.__game` is published
 * unconditionally, so the readers above work either way.
 */
async function recordBattle() {
  const page = await newPage();
  // `bootThroughMenu` is the playability rig's own sequence, moved into `tools/lib/` so this
  // gate and `tools/scratch/pl-*-emc.mjs` drive the menu one way rather than two. The rig's
  // copy had been unable to reach the setup sheet since the front door landed, which is what
  // a shared driver is for.
  await bootThroughMenu(page, {
    base,
    map: 'campus-martius',
    scenario: 'field',
    tier: 'high',
    size: 'small',
    onSetup: (p) => shot(p, 'rp-01-setup'),
  });
  await settle(page, 2200);
  await page.evaluate(INSTALL);

  const gestures = [];

  // ---- the deployment phase, driven by the plaque and the mouse ----
  const dep0 = await page.evaluate(() => window.__dep());
  if (dep0?.active) {
    await shot(page, 'rp-02-deploy');
    // Add a unit off the palette. This is the operation with the sharpest hazard in it:
    // `add` -> `spawnUnit` does `nextUnitId++` *before* `rng.fork('unit' + id)`, so a
    // different sequence of deployment operations mints different ids and forks different
    // streams. The record asserts the id that came back.
    await page.click('.dep-add');
    await settle(page, 200);
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.dep-row')).map((r) => r.dataset.unit));
    if (rows.length) {
      await page.click(`.dep-row[data-unit="${rows[0]}"] [data-d="1"]`);
      gestures.push(`palette +1 ${rows[0]}`);
      await settle(page, 260);
    }
    await page.click('.dep-add');
    await settle(page, 200);

    // Drag a regiment somewhere else. Card bar for the selection — the one selection route
    // that does not depend on framing a unit that may be behind the camera.
    const cards = await page.$$('.cardbar .card:not(.foe)');
    if (cards.length) {
      const box = await cards[0].boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await settle(page, 260);
      }
    }
    const spots = await page.evaluate(() => window.__bare());
    if (spots.length >= 2) {
      await page.mouse.move(spots[0].x, spots[0].y);
      await settle(page, 150);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(spots[1].x, spots[1].y, { steps: 8 });
      await settle(page, 200);
      await page.mouse.up({ button: 'right' });
      await settle(page, 400);
      gestures.push('right-drag place');
    }
    await page.click('.dep-begin');
    await settle(page, 900);
    gestures.push('BEGIN BATTLE');
  }

  // ---- the battle ----
  const ticksTotal = Math.round(SECONDS * 30);
  /*
   * A burst of orders every fifteen simulated seconds, with the battle jumped forward
   * between them. Each burst is a selection, a right-click move and an R, plus a formation
   * key and a halt once each — so roughly one order every five seconds of battle, which is
   * a plausible rate for somebody actually playing and is what the size figure below is
   * measuring. A player who micromanages harder produces a bigger record, linearly.
   */
  const bursts = Math.max(4, Math.round(SECONDS / 15));
  const chunk = Math.floor(ticksTotal / bursts);
  for (let b = 0; b < bursts; b++) {
    // Two evaluates: the first parks the camera, and the projection is only meaningful once
    // a real frame has run with it.
    // Try a few regiments: a unit can be dead, routed off the field, or drawn behind the
    // card bar, and a burst that finds nothing to click is a burst that records nothing.
    let u = null;
    for (let k = 0; k < 4 && !u; k++) {
      await page.evaluate((i) => window.__unitAt(i), b * 3 + k);
      await settle(page, 220);
      const q = await page.evaluate((i) => window.__unitAt(i), b * 3 + k);
      if (q && q.x > 40 && q.x < W - 40 && q.y > 200 && q.y < H - 240) u = q;
    }
    if (u) {
      await page.mouse.move(u.x, u.y);
      await settle(page, 180);
      await page.mouse.click(u.x, u.y);
      await settle(page, 260);
      const sel = await page.evaluate(() => window.__selection());
      if (sel.length) {
        gestures.push(`select ${sel.join(',')}`);
        const spots = await page.evaluate(() => window.__bare());
        if (spots.length) {
          const p = spots[(b + 1) % spots.length];
          await page.mouse.move(p.x, p.y);
          await settle(page, 120);
          // Explicit down / hold / up. A zero-duration right-click can put the press and
          // the release edge in one frame, and `Input` reports one edge per frame.
          await page.mouse.down({ button: 'right' });
          await settle(page, 200);
          await page.mouse.up({ button: 'right' });
          await settle(page, 300);
          gestures.push('right-click move');
        }
        // Keyboard verbs. The cursor is parked over the field so nothing eats the key.
        await page.keyboard.press('KeyR');
        await settle(page, 200);
        gestures.push('R gait');
        if (b % 5 === 1) { await page.keyboard.press('KeyZ'); await settle(page, 200); gestures.push('Z formation'); }
        if (b % 5 === 3) { await page.keyboard.press('KeyH'); await settle(page, 200); gestures.push('H halt'); }
      }
    }
    // Jump the battle on. The rAF loop is still running, so the exact tick count here is
    // not predictable and does not need to be — the record carries whatever it reaches.
    await page.evaluate((n) => window.__game.advanceTicks(n, 1000 / 60), chunk);
    await settle(page, 120);
    if (b === bursts - 1) await shot(page, 'rp-03-battle');
  }

  // Stop the loop before reading, so the tick count in the record is the tick count the
  // replay will be driven to. With rAF live, the battle moves between the two evaluates.
  await page.evaluate(() => window.__game.engine.stop());
  await settle(page, 200);
  const rec = await page.evaluate(() => window.__rec());
  const token = await page.evaluate(() => window.__tok());
  const flow = await page.evaluate(() => window.__flow());
  const bus = await page.evaluate(() => window.__bus);
  const errs = page.__errs.slice();
  await page.close();
  return { rec, token, flow, gestures, bus, errs };
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * Play a token back in a fresh page and return everything worth comparing.
 *
 * `stepMs` is the frame schedule. `injectAt`/`inject` break the battle on purpose part way
 * through, which is how the negative arms prove this gate can see the fault it exists for.
 */
async function playback(token, {
  stepMs = 1000 / 60, ticks, fromTick, injectAt, inject, shotName, quality,
} = {}) {
  const page = await newPage();
  /*
   * Stop the clock on the `ready` assignment, before a frame can run.
   *
   * `main.ts` calls `engine.start()` and *then* sets `__game.ready = true`, so the
   * `engine.stop()` below — which waits for the flag and then makes a driver round trip — has
   * an unbounded number of rAF frames in front of it on a loaded machine, and every frame
   * carries fixed steps. This arm compensates for the *count* (`target - done` reads the real
   * tick), which is why it has been green, and the count was never the whole hazard: those
   * ticks run before `tickCeiling` is pinned, so the recorded deployment operations can be
   * pumped at a tick number that varies with the load average. A replay whose deployment
   * happened at a different tick is a different battle, and the negative arms below are
   * calibrated on the difference between "different battle" and "no difference".
   *
   * `recordBattle` deliberately does **not** get this: it drives a real mouse through a real
   * battle in real time and records whatever tick count that reaches. `tools/lib/simclock.mjs`
   * states the rule — if your tool hashes at a fixed checkpoint, stop the clock; if it watches
   * a battle happen, do not.
   */
  await stopClockOnReady(page);
  const q = (fromTick === undefined ? '' : `&from=${(fromTick / 30).toFixed(6)}`)
    + (quality === undefined ? '' : `&quality=${quality}`);
  await page.goto(`${base}/?replay=${token}${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
  await page.evaluate(INSTALL);

  /*
   * The deployment phase runs off the render loop, because the clock is stopped and there
   * is no tick to hang it on. Frames with the tick ceiling held at the current tick let
   * `ReplaySystem.update` pump the recorded operations and press BEGIN, without letting the
   * battle start a single tick early on whichever frame `commit` happens to land in.
   */
  await page.evaluate(() => {
    const g = window.__game;
    g.engine.stop();
    const t = g.engine.time;
    t.tickCeiling = t.tick;
    g.engine.advance(1.5, 1000 / 60, { render: false });
    t.tickCeiling = -1;
  });

  const target = ticks;
  /*
   * Did the sabotage actually land?
   *
   * A negative arm that injects nothing and then reports "no difference" is a check that
   * cannot fail, dressed as one that just did. Every `inject` below returns a truthy value
   * on success, and the arm asserts on it separately from the divergence.
   */
  let injected = null;
  // A frame of the replay for the eye as well as the hash: the REPLAY strip, the orders still
  // to come, and the TAKE COMMAND button, over a battle nobody is playing.
  if (shotName && SHOT_DIR) {
    await page.evaluate(([n, s2]) => window.__game.advanceTicks(n, s2), [Math.round(target * 0.3), stepMs]);
    await page.evaluate(() => window.__game.engine.advance(0.1, 1000 / 60));
    await settle(page, 400);
    await shot(page, shotName);
  }
  if (injectAt !== undefined) {
    // Absolute tick targets, so this composes with the screenshot above rather than assuming
    // the page is still at tick 0.
    const now = await page.evaluate(() => window.__game.engine.time.tick);
    await page.evaluate(([n, s]) => window.__game.advanceTicks(n, s), [injectAt - now, stepMs]);
    injected = await page.evaluate(inject);
    await page.evaluate(([n, s]) => window.__game.advanceTicks(n, s), [target - injectAt, stepMs]);
  } else {
    const done = await page.evaluate(() => window.__game.engine.time.tick);
    await page.evaluate(([n, s]) => window.__game.advanceTicks(n, s), [target - done, stepMs]);
  }

  const out = {
    injected,
    rec: await page.evaluate(() => window.__rec()),
    rp: await page.evaluate(() => window.__rp()),
    hashes: await page.evaluate(() => window.__game.hashes()),
    flow: await page.evaluate(() => window.__flow()),
    errs: page.__errs.slice(),
  };
  await page.close();
  return out;
}

/** Compare two mark lists and name the first tick that differs. */
function markDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].tick !== b[i].tick) return { at: a[i].tick, why: `checkpoint grid ${a[i].tick} vs ${b[i].tick}` };
    if (a[i].hash !== b[i].hash) return { at: a[i].tick, why: `pool ${a[i].hash} vs ${b[i].hash}` };
    if (a[i].uctl !== b[i].uctl) return { at: a[i].tick, why: `uctl ${a[i].uctl} vs ${b[i].uctl}` };
    if (a[i].uf64 !== b[i].uf64) return { at: a[i].tick, why: `uf64 ${a[i].uf64} vs ${b[i].uf64}` };
    if (a[i].alive !== b[i].alive) return { at: a[i].tick, why: `alive ${a[i].alive} vs ${b[i].alive}` };
  }
  if (a.length !== b.length) return { at: -1, why: `${a.length} checkpoints vs ${b.length}` };
  return null;
}

const sameResult = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** First event that differs between two logs, spelled out. Says nothing when they match. */
function logDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i] ?? null);
    const y = JSON.stringify(b[i] ?? null);
    if (x !== y) return `event ${i}: recorded ${x} vs replayed ${y}`;
  }
  return null;
}

/** Rewrite one field of the wire JSON and re-seal the token. Node's gzip, browser's gunzip. */
function remake(token, edit) {
  const json = JSON.parse(gunzipSync(Buffer.from(token, 'base64url')).toString('utf8'));
  const before = JSON.stringify(json);
  edit(json);
  const after = JSON.stringify(json);
  // An edit that changed nothing would make the arm below compare a record with itself and
  // call the resulting agreement a pass.
  if (before === after) throw new Error('remake: the edit changed nothing');
  return gzipSync(Buffer.from(after, 'utf8')).toString('base64url');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('\n=== recording a battle through the real menu ===');
const R = await recordBattle();
const rec = R.rec;
const orderEvents = rec.events.filter((e) => e.k === 'order').length;
const depEvents = rec.events.filter((e) => e.k === 'deploy').length;
const machineEvents = rec.events.filter((e) => e.k === 'machine').length;

const gz = Buffer.from(R.token, 'base64url');
const rawJson = gunzipSync(gz).toString('utf8');
/*
 * Where the bytes actually are.
 *
 * The design's 1.1 kB is for "the order log plus the seed", and a record is more than that:
 * it also carries the whole `BattleConfig` (seven orders of battle, because the menu keeps
 * every one a player has built) and a checkpoint every 30 s. Both are worth their space —
 * the config is what makes the token self-contained, and the checkpoints are what let a
 * playback say *which tick* it left the record at rather than only that it did — but the
 * comparison is only honest if the split is printed.
 */
const wire = JSON.parse(rawJson);
const gzLen = (o) => gzipSync(Buffer.from(JSON.stringify(o), 'utf8')).length;
measured.breakdown = {
  cfgGzip: gzLen(wire.cfg),
  eventsGzip: gzLen(wire.ev),
  marksGzip: gzLen(wire.mk),
  cfgRaw: JSON.stringify(wire.cfg).length,
  eventsRaw: JSON.stringify(wire.ev).length,
  marksRaw: JSON.stringify(wire.mk).length,
};
measured.record = {
  ticks: rec.ticks,
  seconds: +(rec.ticks / 30).toFixed(1),
  men: rec.count0,
  events: rec.events.length,
  orderEvents,
  depEvents,
  machineEvents,
  marks: rec.marks.length,
  rawJsonBytes: Buffer.byteLength(rawJson, 'utf8'),
  gzipBytes: gz.length,
  tokenChars: R.token.length,
  bytesPerOrder: rec.events.length ? +(gz.length / rec.events.length).toFixed(1) : 0,
  gestures: R.gestures,
  bus: R.bus,
};
console.log(`  ${rec.count0} men, ${rec.ticks} ticks (${(rec.ticks / 30).toFixed(1)} s)`);
console.log(`  ${rec.events.length} recorded events `
  + `(${orderEvents} order, ${depEvents} deployment, ${machineEvents} machine), `
  + `${rec.marks.length} checkpoints`);
console.log(`  raw JSON ${measured.record.rawJsonBytes} B  gzip ${gz.length} B  `
  + `token ${R.token.length} chars`);
console.log(`  of which, gzipped alone: config ${measured.breakdown.cfgGzip} B, `
  + `order log ${measured.breakdown.eventsGzip} B, checkpoints ${measured.breakdown.marksGzip} B`);
console.log(`  gestures: ${R.gestures.join(' | ')}`);

if (wanted('record')) {
  record('record-mouse', orderEvents >= 3,
    'the recorder saw the mouse and the keyboard',
    `${orderEvents} player order(s) logged from ${R.gestures.length} gestures`,
    R.gestures.join(' | '));
  record('record-deploy', depEvents >= 1,
    'the deployment phase is in the record',
    `${depEvents} deployment operation(s), commit included`);
  /*
   * The headcount and the checkpoint count, asserted rather than printed.
   *
   * Everything downstream compares one checkpoint list against another, and two empty lists
   * agree. A battle that recorded no army, or one checkpoint, would sail through every arm
   * below. `2247` is what `campus-martius` / `field` / `small` / `high` fields; if that moves,
   * the run is not measuring the battle this file thinks it is.
   */
  record('record-scale', rec.count0 > 1000 && rec.marks.length >= 4 && rec.ticks > 3000,
    'the recorded battle is big enough for the comparisons below to mean anything',
    `${rec.count0} men, ${rec.ticks} ticks, ${rec.marks.length} checkpoints`,
    'two empty checkpoint lists agree with each other');
  record('record-provenance', orderEvents === R.bus.local && R.bus.ai > 50 && R.bus.none === 0,
    'the recorder took the player\'s orders off the bus and left the AI\'s',
    `bus carried ${R.bus.ai} AI, ${R.bus.local} local, ${R.bus.deploy} deploy`
      + `${R.bus.none ? `, ${R.bus.none} with no provenance` : ''}; `
      + `the record has ${orderEvents}`,
    'the AI regenerates its own orders on playback — recording them would apply each twice');
  record('record-console', R.errs.length === 0,
    'the recording page raised no console error',
    R.errs.length ? R.errs.slice(0, 3).join(' ; ') : 'clean');
}

let base60 = null;
// Only the `replay` arm needs this run; every other arm compares against the record itself.
if (wanted('replay')) {
  console.log('\n=== replaying at the recording schedule (1000/60 ms) ===');
  base60 = await playback(R.token, { stepMs: 1000 / 60, ticks: rec.ticks, shotName: 'rp-04-replay' });
  const d = markDiff(rec.marks, base60.rec.marks);
  measured.replay60 = { marks: base60.rec.marks.length, diverged: base60.rp.divergedAt,
    refusal: base60.rp.refusal, diff: d };
  {
    record('replay-hashes', d === null,
      'every checkpoint of the replay matches the record, bit for bit',
      d === null ? `${rec.marks.length} checkpoints identical (pool, uf64, uctl, survivors)`
        : `first difference at tick ${d.at}: ${d.why}`);
    record('replay-selfcheck', base60.rp.divergedAt === -1 && base60.rp.refusal === '',
      'the product noticed nothing wrong on its own',
      base60.rp.refusal || 'divergedAt -1, no refusal');
    const ld = logDiff(rec.events, base60.rec.events);
    record('replay-log', ld === null,
      'the replay re-records the identical order log',
      ld ?? `${base60.rec.events.length} events replayed of ${rec.events.length} recorded`);
    record('replay-result', sameResult(R.flow, base60.flow),
      'BattleFlow.result is the same battle',
      R.flow ? `${R.flow.reason}, victor ${R.flow.victor}` : 'battle still running in both');
    record('replay-console', base60.errs.length === 0,
      'the replay page raised no console error',
      base60.errs.length ? base60.errs.slice(0, 3).join(' ; ') : 'clean');
  }
}

if (wanted('coarse')) {
  console.log('\n=== replaying at a deliberately different schedule (1000/6 ms, 5 ticks a frame) ===');
  const coarse = await playback(R.token, { stepMs: 1000 / 6, ticks: rec.ticks });
  const d = markDiff(rec.marks, coarse.rec.marks);
  measured.coarse = { diff: d, diverged: coarse.rp.divergedAt };
  record('coarse-schedule', d === null,
    'the same battle at five ticks a frame instead of one every two',
    d === null ? `${rec.marks.length} checkpoints identical at a 27x coarser frame step`
      : `first difference at tick ${d.at}: ${d.why}`,
    'frame grouping does not reach the simulation once tick counts are equal');
  record('coarse-result', sameResult(R.flow, coarse.flow),
    'and the same verdict',
    coarse.flow ? `${coarse.flow.reason}, victor ${coarse.flow.victor}` : 'battle still running');
}

if (wanted('tier')) {
  console.log('\n=== the graphics tier is not a simulation input ===');
  /*
   * It was one, and this arm's name is the history. Measured on the Campus Martius assault at
   * one seed: **ultra fielded 3,074 men and medium 3,009**, the ram crew died 16 m short of the
   * door at ultra and landed 26 blows at medium, and the Porta Flaminia opened at one tier and
   * never at the other. Same map, same scenario, same seed. The chain was one field —
   * `quality.maxSoldiers` sized the pool, `fittedUnitScale` fitted the army to it, `scenario.ts`
   * wrote `battle.unitSizeScale` — and the owner ruled that a graphics setting must not change
   * the outcome of a battle. The pool is `SOLDIER_POOL_CAPACITY` now, one number at every tier.
   *
   * So the first check has changed meaning and is worth more than it was. It used to say "the
   * record's tier beats the URL's, so a replay cannot be watched at another army size", which
   * was true and was a workaround. It now says the stronger thing: `?quality=low` over a record
   * made at any tier replays the identical battle, because there is no army size to watch it at.
   * A regression that reintroduced the coupling would fail it here as well as in
   * `qa-determinism.mjs`'s cross-tier arm, which is the instrument that owns the ruling.
   *
   * The second check is untouched and is the one that keeps this arm honest. It tampers with the
   * token's `us` field rather than changing a tier, because whether some tier clamps *this* army
   * is arithmetic that can change; whether the refusal fires when the recorded army differs from
   * the fitted one must not depend on that. It is now the only way the refusal can fire at all,
   * and it still fires.
   */
  const forced = await playback(R.token, { stepMs: 1000 / 60, ticks: rec.ticks, quality: 'low' });
  const d = markDiff(rec.marks, forced.rec.marks);
  measured.tier = { urlTier: 'low', recordedTier: rec.quality, count0: forced.rec.count0, diff: d };
  record('tier-in-record', d === null && forced.rec.count0 === rec.count0,
    'a record replays identically at another graphics tier — the tier is not an army size',
    `?quality=low over a record made at '${rec.quality}': `
      + `${forced.rec.count0} men against ${rec.count0} recorded, `
      + (d === null ? 'every checkpoint identical' : `diverged at ${d.at}: ${d.why}`));

  const lying = remake(R.token, (j) => { j.us = j.us * 0.5; });
  const refused = await playback(lying, { stepMs: 1000 / 60, ticks: 60 });
  measured.tierRefusal = refused.rp.refusal;
  record('tier-refused', refused.rp.refusal !== '' && refused.rec.events.length === 0,
    'a record whose army this run cannot field is refused by name, not quietly fitted',
    refused.rp.refusal || 'NOT REFUSED — it played a different battle and said nothing',
    `${refused.rec.events.length} event(s) applied`);
}

if (wanted('drop')) {
  console.log('\n=== dropping a .tcr on the window ===');
  /*
   * The other half of "save".
   *
   * `Save replay` writes the token to a file, so the file and the URL carry the identical
   * string and there is one thing to read either way — but a write with no read is a dead
   * feature, and a twelve-line handler nobody has fired is exactly the kind of thing this
   * project ships and finds later. Dropped onto the front door, before any battle is built,
   * because that is where somebody with a file in their downloads folder actually is.
   */
  const page = await newPage();
  await page.goto(`${base}/?menu=battle`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu .begin', { timeout: 60000 });
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'battle.tcr', { type: 'application/octet-stream' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, R.token);
  let landed = false;
  try {
    await page.waitForURL((u) => u.searchParams.get('replay') === R.token, { timeout: 30000 });
    landed = true;
  } catch { /* it did not navigate */ }
  const seen = page.url().slice(0, 60);
  const errs = page.__errs.slice();
  await page.close();
  measured.drop = { landed, url: seen, errs };
  record('tcr-drop', landed && errs.length === 0,
    'a .tcr dropped on the front door opens that battle',
    landed ? `navigated to ${seen}… with the token intact`
      : `no navigation; the URL is still ${seen}…`,
    errs.length ? errs.slice(0, 2).join(' ; ') : 'no console error');
}

// ---------------------------------------------------------------------------
// The negative arms. Each of these must go RED, or the gate is decorative.
// ---------------------------------------------------------------------------

if (wanted('late')) {
  console.log('\n=== breaking it on purpose: one player order, N ticks late ===');
  /*
   * The design's own number is that four ticks (133 ms) of lateness is already a different
   * battle. One tick is the interesting question, because one tick is what a frame boundary
   * can move an order by if the record stamps wall-clock time instead of a tick index. So
   * this ladder starts at one and reports the smallest lateness the gate can see.
   */
  let caught = 0;
  const ladder = [];
  for (const late of [1, 2, 4, 8]) {
    const bad = remake(R.token, (j) => {
      const i = j.ev.findIndex((e) => e[1] === 0 && e[0] > 0);
      if (i >= 0) j.ev[i][0] += late;
    });
    const out = await playback(bad, { stepMs: 1000 / 60, ticks: rec.ticks });
    const d = markDiff(rec.marks, out.rec.marks);
    ladder.push({ late, diverged: d ? d.at : -1, why: d ? d.why : 'identical' });
    console.log(`  ${late} tick(s) late → ${d ? `DIVERGED at tick ${d.at} (${d.why})` : 'no difference'}`);
    if (d) { caught = late; break; }
  }
  measured.late = ladder;
  record('late-order', caught > 0,
    'an order applied late is a different battle, and the gate says so',
    caught > 0 ? `caught at ${caught} tick(s) of lateness`
      : 'up to 8 ticks of lateness moved no checkpoint — the gate cannot see this fault',
    'the design measured 4 ticks as already a different battle');
}

if (wanted('bus')) {
  console.log('\n=== breaking it on purpose: an unrecorded order straight onto the bus ===');
  /*
   * The twenty-fourth input path, simulated exactly. A new UI that emits `orderIssued`
   * itself instead of going through the queue leaves no trace in the log, so the replay
   * never re-applies it and the battle forks. This is the fault this whole file exists for.
   */
  const half = Math.floor(rec.ticks / 2);
  const out = await playback(R.token, {
    stepMs: 1000 / 60,
    ticks: rec.ticks,
    injectAt: half,
    inject: () => {
      const g = window.__game;
      const u = g.battle.units.find((x) => !x.destroyed && x.faction === 0 && x.alive > 0);
      if (!u) return null;
      g.engine.context.events.emit('orderIssued', {
        unitIds: [u.id], kind: 'move', source: 'local',
        x: u.x + 30, z: u.z + 30, running: true,
      });
      return u.id;
    },
  });
  const d = markDiff(rec.marks, out.rec.marks);
  measured.bus = { at: half, diff: d, productSaid: out.rp.divergedAt };
  record('unrecorded-order', d !== null && out.injected !== null,
    'an order that skipped the recorder forks the battle, and the gate sees it',
    out.injected === null ? 'NOTHING WAS INJECTED — this arm proved nothing'
      : d ? `diverged at tick ${d.at}: ${d.why}` : 'NO DIFFERENCE — the gate is blind to this',
    `injected on unit ${out.injected} at tick ${half}; `
      + `the product's own check said ${out.rp.divergedAt}`);
  record('unrecorded-selfcheck', out.rp.divergedAt >= 0,
    'and the product refuses on its own, without this tool comparing anything',
    out.rp.divergedAt >= 0 ? `ReplaySystem reported tick ${out.rp.divergedAt}: ${out.rp.refusal}`
      : 'the product noticed nothing');
}

if (wanted('write')) {
  console.log('\n=== breaking it on purpose: a direct write to UnitGroupState outside a tick ===');
  /*
   * The shape of the bug this stage deleted. `SelectionController` used to write `u.width`
   * straight into `UnitGroupState` from the update phase, with a comment saying to remove it
   * once the sim honoured `o.width` — which it had. This reproduces that class of write and
   * asks whether the gate can see it. `width` is in the `uctl` field list, so it should be
   * visible on the discrete hash rather than only in the float32 pool thousands of ticks later.
   */
  const at = Math.floor(rec.ticks / 3);
  const out = await playback(R.token, {
    stepMs: 1000 / 60,
    ticks: rec.ticks,
    injectAt: at,
    inject: () => {
      const u = window.__game.battle.units.find((x) => !x.destroyed && x.faction === 0 && x.alive > 8);
      if (!u) return null;
      u.width = Math.max(1, u.width - 1);
      return u.id;
    },
  });
  const d = markDiff(rec.marks, out.rec.marks);
  measured.write = { at, diff: d, productSaid: out.rp.divergedAt };
  record('out-of-band-write', d !== null && out.injected !== null,
    'a field written from outside a tick forks the battle, and the gate sees it',
    out.injected === null ? 'NOTHING WAS WRITTEN — this arm proved nothing'
      : d ? `diverged at tick ${d.at}: ${d.why}` : 'NO DIFFERENCE — the gate is blind to this',
    `unit ${out.injected}'s frontage changed by 1 at tick ${at}`);
}

if (wanted('command')) {
  console.log('\n=== take command from here ===');
  /*
   * Withholding the rest of the log *is* taking over, so this arm checks two things: that
   * the battle is bit-identical up to the handover tick, and that the log stops being fed
   * after it. Past the handover the two battles legitimately differ — the AI keeps fighting
   * and nobody is commanding Rome — so nothing beyond it is compared.
   */
  /*
   * The handover goes *before the last order in the log*, on purpose.
   *
   * A handover past the end of the log proves nothing: the feed would have run dry anyway,
   * and the arm would pass with the takeover code never executed. Picking the tick of the
   * median order means there are orders on the far side that the record must decline to give.
   */
  const orderTicks = rec.events.filter((e) => e.k === 'order' && e.t > 0).map((e) => e.t);
  const at = orderTicks.length > 1
    ? orderTicks[Math.floor(orderTicks.length / 2)]
    : Math.floor(rec.ticks / 2);
  const withheld = rec.events.filter((e) => e.t >= at).length;
  const out = await playback(R.token, { stepMs: 1000 / 60, ticks: rec.ticks, fromTick: at });
  const upTo = rec.marks.filter((m) => m.tick <= at);
  const mine = out.rec.marks.filter((m) => m.tick <= at);
  const d = markDiff(upTo, mine);
  const fedAfter = out.rec.events.filter((e) => e.t >= at).length;
  measured.command = { at, withheld, diff: d, fedAfter, mode: out.rp.mode };
  record('take-command', d === null && fedAfter === 0 && withheld > 0 && out.rp.mode === 'commanded',
    'the record plays to the handover tick and then hands the army over',
    (d === null ? `${upTo.length} checkpoint(s) identical up to tick ${at}`
      : `diverged at ${d.at}: ${d.why}`)
      + `; ${withheld} event(s) withheld, ${fedAfter} fed`,
    `mode '${out.rp.mode}'`);
  record('take-command-record', out.rec.events.length > 0 && out.rec.ticks === rec.ticks,
    'and the taken-over battle is itself a record',
    `${out.rec.events.length} events over ${out.rec.ticks} ticks`);
}

// ---------------------------------------------------------------------------

await browser.close();
await closeServer();

console.log(`\nrecord size: ${measured.record.gzipBytes} B gzipped `
  + `(${measured.record.rawJsonBytes} B raw, ${measured.record.tokenChars}-char token) for `
  + `${measured.record.seconds} s and ${measured.record.events} events`);
// A run that asserted nothing is a failure, not a pass. `--only=` with a stale arm name is
// caught above; this catches every other way of arriving here having checked nothing.
if (results.length === 0) {
  console.log('\n✗ no checks ran — nothing was measured');
  failed = 1;
}
console.log(`\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} checks passed`);
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ results, measured }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(failed === 0 ? 0 : 1);
