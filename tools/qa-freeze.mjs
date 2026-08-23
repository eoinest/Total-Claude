#!/usr/bin/env node
/**
 * QA: the simulation clock cannot stop silently.
 *
 * Usage: node tools/qa-freeze.mjs [--port=5941] [--relay=5992] [--json=path] [--only=arm,arm]
 *        arms: commit, quiet, ceiling, orphan, throw, net-drop
 *
 * ## The bug this gate is the receipt for
 *
 * > "i was in middle of game and all the soldiers have frozen. idk why this happened"
 * >
 * > "now all animations are running but no characters are moving"
 *
 * Animation playheads run off `time.scaledDt` and positions come out of `fixedUpdate`, so a
 * world that animates and does not move is a render loop in perfect health being handed zero
 * fixed steps a frame. There are three ways to arrange that — the pause, a subsystem hold, and
 * `Time.tickCeiling` — and the game had **no error, no message and no indication** for any of
 * them. The owner had to be told which key to press.
 *
 * The cause was the third: a lockstep client re-pins its ceiling at the last turn the relay
 * authorised, `NetLink.onclose` did nothing after the handshake because `die` is a no-op once
 * the connect promise has settled, and so a relay that went away left the battle at
 * `tick N, ceiling N, paused false, gameSpeed 1` for ever. `net-drop` below is that, and it
 * fails on the tree this gate was written against.
 *
 * ## Why the arms are shaped like this
 *
 * A watchdog nobody has watched fire is worth nothing, and this repository has shipped several
 * checks in that condition. So every detection arm **induces the freeze deliberately** and then
 * asserts on the report, the console line and the words on the screen. And because a safety net
 * that cries wolf is worse than no net, there is a `quiet` arm that spends as long again
 * proving it says *nothing* through the three stops that are supposed to happen: the player's
 * pause, the deployment hold, and a lockstep client sitting on its ceiling waiting for its
 * peer with the relay deliberately slowed to a 2.5-second turn.
 *
 * That last one is the real design tension. A client waiting on its peer is *supposed* to stop
 * ticking, and it looks identical from the clock's side to a client whose relay has died. They
 * are told apart by a fact about the transport rather than a duration — see
 * `NetSession.linkFault` — which is why this arm can hold the sim still for 2.5 s at a time,
 * many times over, and still expect silence.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { bootThroughMenu } from './lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARMS = ['commit', 'quiet', 'ceiling', 'orphan', 'throw', 'net-drop', 'net-silent'];
const FLAGS = ['port', 'relay', 'json', 'only'];
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? ''] : [a, ''];
}));
const bad = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (bad.length) {
  console.error(`unknown flag(s): ${bad.map((k) => `--${k}`).join(', ')}`);
  console.error(`known: ${FLAGS.map((k) => `--${k}`).join(' ')}`);
  process.exit(2);
}
const ONLY = args.get('only') ? args.get('only').split(',') : null;
const wanted = (n) => !ONLY || ONLY.includes(n);
if (ONLY) {
  const unknown = ONLY.filter((a) => !ARMS.includes(a));
  if (unknown.length) {
    console.error(`--only names ${ARMS.join(', ')}; got '${unknown.join(', ')}'`);
    process.exit(2);
  }
}
const PORT = Number(args.get('port') ?? 5941);
const RELAY_PORT = Number(args.get('relay') ?? 5992);
const JSON_OUT = args.get('json') ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const measured = {};
const record = (name, ok, claim, detail, note = '') => {
  results.push({ name, ok, claim, detail, note });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${claim}`);
  if (detail) console.log(`        ${detail}`);
  if (!ok && note) console.log(`        ${note}`);
};

// ---------------------------------------------------------------------------
// The page's side of the contract
// ---------------------------------------------------------------------------

/**
 * Everything read out of a page, in one call.
 *
 * `banner` is the *rendered* text, not the report, because "it says so on screen" is the part
 * of this that the owner would have benefited from and the part a gate is most likely to let
 * rot: a watchdog whose banner element stopped being appended would still pass every assertion
 * made against `reports`.
 */
const INSTALL = () => {
  window.__wd = () => {
    const e = window.__game.engine;
    const t = e.time;
    const b = document.querySelector('[data-tc-watchdog]');
    return {
      tick: t.tick,
      paused: t.paused,
      stopped: t.stopped,
      held: t.held,
      holders: t.holders(),
      ceiling: t.tickCeiling,
      ceilingOwner: t.ceilingOwner,
      speed: t.gameSpeed,
      scaledDt: +t.scaledDt.toFixed(4),
      elapsed: +t.elapsed.toFixed(2),
      frames: e.renderer.info.render.frame,
      reports: e.watchdog.reports.map((r) => ({
        kind: r.kind, owner: r.owner, why: r.why, count: r.count,
        stillFor: +r.stillFor.toFixed(1),
      })),
      banner: b && b.style.display !== 'none' ? (b.textContent ?? '') : '',
      net: window.__game.net ? window.__game.net.status() : null,
    };
  };
  /**
   * Where every man is, summed. The symptom itself, rather than the clock it is inferred from.
   *
   * Across the *whole* pool, not the first few hundred slots. `commitInner` sets every unit's
   * target to where it already stands, so the player's own army — which owns the low slots —
   * holds station for the first seconds of a battle and reads as frozen when it is obeying an
   * order. The advancing side is the one that answers the question.
   */
  window.__menMoved = () => {
    const p = window.__game.battle.pool;
    let s = 0;
    for (let i = 0; i < p.count; i++) s += p.x[i] + p.z[i];
    return s;
  };
};

/** Sim ticks and rendered frames over a window: the two clocks, side by side. */
const both = async (page, ms) => {
  const a = await page.evaluate(() => window.__wd());
  const m0 = await page.evaluate(() => window.__menMoved());
  await sleep(ms);
  const b = await page.evaluate(() => window.__wd());
  const m1 = await page.evaluate(() => window.__menMoved());
  return {
    a, b, ticks: b.tick - a.tick, frames: b.frames - a.frames,
    menMoved: Math.abs(m1 - m0) > 1e-6,
  };
};

// ---------------------------------------------------------------------------

const relays = [];
const startRelay = async (port, extra = []) => {
  const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${port}`,
    `--parent=${process.pid}`, '--quiet', ...extra], { stdio: 'inherit' });
  relays.push(p);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`,
        { signal: AbortSignal.timeout(800) });
      if (r.ok) return { proc: p, base: `ws://127.0.0.1:${port}` };
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error(`relay on ${port} never came up`);
};
const stopRelays = () => {
  for (const p of relays.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
};

const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'qa-freeze',
});
const browser = await launchBrowser({ label: 'qa-freeze', port: PORT, root: ROOT });
const pages = [];
const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.__errs = [];
  page.__cerr = [];
  page.on('pageerror', (e) => page.__errs.push(String(e.message ?? e)));
  page.on('console', (m) => { if (m.type() === 'error') page.__cerr.push(m.text()); });
  pages.push(page);
  return page;
};
const cleanup = async () => {
  for (const p of pages.splice(0)) { try { await p.close(); } catch { /* gone */ } }
  try { await browser.close(); } catch { /* gone */ }
  stopRelays();
  try { await closeServer(); } catch { /* gone */ }
};
process.on('exit', stopRelays);

/** A single-player battle with the deployment phase live, booted the way a player boots. */
const bootSolo = async ({ deploy = 1 } = {}) => {
  const page = await newPage();
  await bootThroughMenu(page, {
    base, map: 'campus-martius', scenario: 'field', tier: 'low', size: 'small',
    query: `autoplay=0&deploy=${deploy}`,
  });
  await page.evaluate(INSTALL);
  return page;
};

try {
  // -------------------------------------------------------------------------
  // Arm: every way out of the deployment phase leaves a running clock
  // -------------------------------------------------------------------------
  if (wanted('commit')) {
    console.log('\n=== the deployment commit, attacked ===');
    /*
     * Five routes into `commit`, because the diagnosis that opened this pass named
     * `commitInner` as a place a throw would strand the clock and could not rule it out from
     * the interface. It still cannot be ruled out by inspection — that is what the `finally`
     * and the orphan check are for — but "no input reaches it" is worth knowing and worth
     * keeping true.
     */
    const arms = {
      button: async (p) => { await p.click('.dep-begin'); },
      enter: async (p) => { await p.keyboard.press('Enter'); },
      'double-press': async (p) => {
        await p.evaluate(() => {
          const b = document.querySelector('.dep-begin');
          b.click();
          b.click();
        });
        await p.keyboard.press('Enter');
        await p.keyboard.press('Enter');
      },
      benched: async (p) => {
        await p.click('.dep-add');
        await sleep(250);
        await p.evaluate(() => {
          for (const r of Array.from(document.querySelectorAll('.dep-row')).slice(0, 4)) {
            r.querySelector('[data-d="1"]')?.click();
          }
        });
        await sleep(400);
        await p.evaluate(() => {
          for (const r of Array.from(document.querySelectorAll('.dep-row')).slice(0, 4)) {
            r.querySelector('[data-d="-1"]')?.click();
          }
        });
        await sleep(400);
        await p.click('.dep-begin');
      },
      placed: async (p) => {
        const box = await p.evaluate(() => {
          const r = document.querySelector('canvas').getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        await p.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.72);
        await sleep(200);
        await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.72);
        await p.mouse.down({ button: 'right' });
        await p.mouse.move(box.x + box.w * 0.42, box.y + box.h * 0.8, { steps: 8 });
        await p.mouse.up({ button: 'right' });
        await sleep(300);
        await p.click('.dep-begin');
      },
    };
    const rows = [];
    for (const [name, arm] of Object.entries(arms)) {
      const page = await bootSolo();
      const before = await page.evaluate(() => window.__wd());
      await arm(page);
      await sleep(700);
      const m = await both(page, 900);
      rows.push({
        name, holdersBefore: before.holders, ticks: m.ticks,
        holdersAfter: m.b.holders, stopped: m.b.stopped, reports: m.b.reports.length,
      });
      record(`commit-${name}`,
        before.holders.includes('deployment') && m.ticks > 0 && !m.b.stopped
          && m.b.holders.length === 0 && m.b.reports.length === 0,
        'the phase holds the clock by name and gives it back',
        `held ${JSON.stringify(before.holders)} → ${JSON.stringify(m.b.holders)}, `
          + `+${m.ticks} ticks after, ${m.b.reports.length} watchdog report(s)`,
        'a commit that strands the clock is the freeze this pass exists for');
      await page.close();
      pages.splice(pages.indexOf(page), 1);
    }
    measured.commit = rows;
  }

  // -------------------------------------------------------------------------
  // Arm: it says nothing through the stops that are supposed to happen
  // -------------------------------------------------------------------------
  if (wanted('quiet')) {
    console.log('\n=== silence through three legitimate stops ===');
    const page = await bootSolo();

    // 1. The deployment hold, held for well over the grace period.
    await sleep(5000);
    const dep = await page.evaluate(() => window.__wd());
    record('quiet-deployment', dep.reports.length === 0 && dep.held
      && dep.holders.includes('deployment') && dep.tick === 0,
    'a deployment phase holding the clock for five seconds raises nothing',
    `holders ${JSON.stringify(dep.holders)}, tick ${dep.tick}, `
      + `${dep.reports.length} report(s)`,
    'the plaque is on screen saying so; a banner as well would be noise');

    // 2. The transition out of it, which is where the first draft of the watchdog fired.
    await page.click('.dep-begin');
    await sleep(2500);
    const after = await page.evaluate(() => window.__wd());
    record('quiet-commit-edge', after.reports.length === 0 && after.tick > 0,
      'and nothing on the frame the hold is released, before the accumulator refills',
      `tick ${after.tick}, ${after.reports.length} report(s)`,
      'the first draft fired here: four seconds still, then one frame with nothing holding');

    // 3. The player's own pause, which the pause button already announces.
    await page.keyboard.press('Space');
    await sleep(5000);
    const paused = await page.evaluate(() => window.__wd());
    const lit = await page.evaluate(() =>
      !!document.querySelector('.tb-speed button[data-s="0"].on'));
    await page.keyboard.press('Space');
    await sleep(1200);
    const resumed = await page.evaluate(() => window.__wd());
    record('quiet-paused', paused.reports.length === 0 && paused.paused && lit
      && resumed.reports.length === 0 && resumed.tick > paused.tick,
    'five seconds paused raises nothing, and the pause button says so instead',
    `paused ${paused.paused}, button lit ${lit}, tick ${paused.tick} → ${resumed.tick}, `
      + `${resumed.reports.length} report(s)`,
    'Space is the recovery the owner had to be told about; it must stay self-evident');
    measured.quiet = { dep, after, paused, resumed, pauseButtonLit: lit };
    await page.close();
    pages.splice(pages.indexOf(page), 1);
  }

  // -------------------------------------------------------------------------
  // Arm: and nothing through a legitimate lockstep stall
  // -------------------------------------------------------------------------
  if (wanted('quiet')) {
    console.log('\n=== silence through a real lockstep wait ===');
    /*
     * A 2.5-second turn, which is 25x the relay's default and holds each client on its ceiling
     * for about 2.4 s at a stretch — well past the watchdog's 1.5 s grace, many times over.
     * This is the arm that would go red if the freeze test were a timer, and it is the reason
     * `NetSession.linkFault` asks about the socket instead.
     */
    const relay = await startRelay(RELAY_PORT, ['--turn-ms=2500']);
    const q = `net=${encodeURIComponent(relay.base)}&room=FRZQT&autoplay=1&deploy=0`;
    const host = await newPage();
    await bootThroughMenu(host, {
      base, map: 'campus-martius', scenario: 'field', tier: 'low', size: 'small', query: q,
    });
    const guest = await newPage();
    await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    await host.evaluate(INSTALL);
    await guest.evaluate(INSTALL);
    for (const p of [host, guest]) {
      await p.waitForFunction(() => window.__game.net.status().phase === 'battle',
        null, { timeout: 90000 });
    }
    const m = await both(host, 16000);
    const g = await guest.evaluate(() => window.__wd());

    /*
     * And a blocked main thread, which is the false positive this pass actually produced.
     *
     * The first version of the silence test differenced `performance.now()` against the last
     * inbound frame. On a machine running three determinism gates at once it ended a healthy
     * match with `linkLost` in the middle of `qa-net`'s desync arm — because `onmessage` runs
     * on the page's main thread, so a blocked thread cannot *receive* a packet that has already
     * arrived, and eight seconds of blocked thread read identically to eight seconds of dead
     * relay. Eight seconds is past the six-second threshold with room to spare; the arm passes
     * only because the count is now in rendered frames, which a stalled page does not have.
     */
    const stalled = await host.evaluate(() => {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { /* hold the main thread, as a load spike does */ }
      return Date.now() - t0;
    });
    await sleep(2500);
    const afterStall = await host.evaluate(() => window.__wd());
    record('quiet-main-thread-stall',
      !afterStall.net?.ended && afterStall.reports.length === 0,
      `a ${(stalled / 1000).toFixed(0)}-second main-thread block does not end the match`,
      `ended ${JSON.stringify(afterStall.net?.ended ?? '')}, `
        + `${afterStall.reports.length} watchdog report(s), turn ${afterStall.net?.turn}`,
      'a blocked thread cannot receive a packet that has arrived; that is not a dead relay');

    measured.lockstepWait = {
      stallMs: stalled, afterStall: { ended: afterStall.net?.ended, reports: afterStall.reports },
      ticks: m.ticks, frames: m.frames, host: m.b.reports, guest: g.reports,
      turn: m.b.net?.turn, ceiling: m.b.ceiling, ceilingOwner: m.b.ceilingOwner,
      stalls: m.b.net?.stalls,
    };
    record('quiet-lockstep-wait',
      m.b.reports.length === 0 && g.reports.length === 0 && m.ticks > 0 && m.frames > 0,
      'a client sitting on its ceiling for 2.4 s at a time, sixteen seconds running, '
        + 'raises nothing',
      `+${m.ticks} sim ticks in +${m.frames} frames, ceiling ${m.b.ceiling} by `
        + `'${m.b.ceilingOwner}', ${m.b.net?.stalls} self-reported stall(s), `
        + `${m.b.reports.length}/${g.reports.length} watchdog report(s)`,
      'this is the false alarm that would fire in every match if the test were a duration');
    for (const p of [host, guest]) { await p.close(); pages.splice(pages.indexOf(p), 1); }
    relay.proc.kill('SIGKILL');
  }

  // -------------------------------------------------------------------------
  // Arm: an induced stuck ceiling is caught and named
  // -------------------------------------------------------------------------
  if (wanted('ceiling')) {
    console.log('\n=== induced: a tick ceiling nobody clears ===');
    const page = await bootSolo();
    await page.click('.dep-begin');
    await sleep(1500);
    // The shape of the real fault, with the owner's name removed: a bare write to the field,
    // which is what every harness in `tools/` does and what nothing used to be able to see.
    await page.evaluate(() => {
      const t = window.__game.engine.time;
      t.tickCeiling = t.tick;
    });
    const m = await both(page, 5000);
    const rep = m.b.reports.at(-1);
    record('ceiling-freezes-the-sim', m.ticks === 0 && m.frames > 0 && !m.b.paused,
      'the induced freeze is the owner\'s freeze: frames yes, ticks no, not paused',
      `+${m.ticks} ticks in +${m.frames} frames, paused ${m.b.paused}, `
        + `scaledDt ${m.b.scaledDt}`);
    record('ceiling-reported', !!rep && rep.kind === 'unexplained'
      && rep.owner.includes('ceiling') && rep.why.includes('never cleared'),
    'the watchdog names it: an unexplained ceiling, and who set it',
    rep ? `${rep.kind} / ${rep.owner} / ${rep.why}` : 'no report at all',
    'this is the exact state the owner sat in with nothing on screen');
    record('ceiling-on-screen', m.b.banner.includes('THE SIMULATION HAS STOPPED')
      && m.b.banner.includes('never cleared'),
    'and puts it on screen, not only in the console',
    m.b.banner ? m.b.banner.slice(0, 150).replace(/\s+/g, ' ') : '(no banner)');
    record('ceiling-in-console',
      page.__cerr.some((l) => l.startsWith('[watchdog]') && l.includes('never cleared')),
      'and in the console, once rather than once a frame',
      `${page.__cerr.filter((l) => l.startsWith('[watchdog]')).length} watchdog line(s): `
        + JSON.stringify(page.__cerr.filter((l) => l.startsWith('[watchdog]')).slice(0, 2)));

    // Recovery: clearing the ceiling clears the notice, so a live banner means a live fault.
    await page.evaluate(() => { window.__game.engine.time.tickCeiling = -1; });
    await sleep(1500);
    const back = await page.evaluate(() => window.__wd());
    record('ceiling-recovers', back.tick > m.b.tick && back.banner === '',
      'and takes the notice down when the battle starts again',
      `tick ${m.b.tick} → ${back.tick}, banner ${back.banner ? 'still up' : 'gone'}`,
      'a banner that never goes away is a banner nobody reads');
    measured.ceiling = {
      ticksWhileStuck: m.ticks, framesWhileStuck: m.frames,
      reports: m.b.reports, banner: m.b.banner.slice(0, 200),
      watchdogConsole: page.__cerr.filter((l) => l.startsWith('[watchdog]')),
    };
    await page.close();
    pages.splice(pages.indexOf(page), 1);
  }

  // -------------------------------------------------------------------------
  // Arm: a hold whose owner has gone
  // -------------------------------------------------------------------------
  if (wanted('orphan')) {
    console.log('\n=== induced: a pause whose owner vanished ===');
    const page = await bootSolo();
    await page.click('.dep-begin');
    await sleep(1500);
    /*
     * The `commitInner` shape exactly: a phase takes the clock, then stops believing it is
     * holding anything — which is what a throw between `active = false` and the release
     * produced before the `finally` landed. The hold is still there and its owner disowns it.
     */
    await page.evaluate(() => {
      window.__ghostActive = true;
      window.__game.engine.time.hold('phantom-phase', () => ({
        held: window.__ghostActive,
        expected: true,
        why: 'the army is being laid out',
      }));
    });
    await sleep(2500);
    const whileHeld = await page.evaluate(() => window.__wd());
    await page.evaluate(() => { window.__ghostActive = false; });
    await sleep(4000);
    const after = await page.evaluate(() => window.__wd());
    const rep = after.reports.find((r) => r.kind === 'orphaned');
    record('orphan-quiet-while-owned', whileHeld.reports.length === 0
      && whileHeld.holders.includes('phantom-phase') && whileHeld.stopped,
    'a live hold stops the clock and says nothing, exactly as deployment does',
    `holders ${JSON.stringify(whileHeld.holders)}, `
      + `${whileHeld.reports.length} report(s)`);
    record('orphan-reported', !!rep && rep.owner === 'phantom-phase'
      && rep.why.includes('no longer claims it'),
    'and the moment its owner disowns it, the watchdog names the owner',
    rep ? rep.why : 'no orphan report');
    record('orphan-released', after.holders.length === 0 && after.tick > whileHeld.tick,
      'and releases it, so the battle carries on rather than needing a reload',
      `holders ${JSON.stringify(after.holders)}, tick ${whileHeld.tick} → ${after.tick}`,
      'a hold nobody claims has no authority to stop anything');
    record('orphan-on-screen', after.banner.includes('STOPPED BY NOTHING'),
      'and leaves the notice up after the repair, so the player learns it happened',
      after.banner ? after.banner.slice(0, 140).replace(/\s+/g, ' ') : '(no banner)',
      'self-repairing silently is the same disease');
    measured.orphan = { whileHeld: whileHeld.reports, after: after.reports,
      banner: after.banner.slice(0, 200) };
    await page.close();
    pages.splice(pages.indexOf(page), 1);
  }

  // -------------------------------------------------------------------------
  // Arm: a subsystem whose fixedUpdate throws
  // -------------------------------------------------------------------------
  if (wanted('throw')) {
    console.log('\n=== induced: a fixedUpdate that throws ===');
    const page = await bootSolo();
    await page.click('.dep-begin');
    await sleep(1500);
    // Baseline: were the men moving *before* the fault? An arm that measures "still frozen"
    // against a battle that was already standing still proves nothing.
    const healthy = await both(page, 1200);
    const armed = await page.evaluate(() => {
      const s = window.__game.engine.context.get('morale');
      if (typeof s.fixedUpdate !== 'function') return false;
      s.fixedUpdate = () => { throw new Error('induced by qa-freeze'); };
      /*
       * And an observer on a system *after* the thrower in `order`, which is the claim.
       *
       * `morale` is 30 and `ragdoll` is 120. "One throwing system cannot take the battle with
       * it" is precisely the statement that 120 still runs on a tick where 30 threw, and it is
       * unobservable from the outside — the wrapper counts and delegates, and changes nothing.
       */
      const late = window.__game.engine.context.get('ragdoll');
      const orig = late.fixedUpdate.bind(late);
      window.__lateRan = 0;
      late.fixedUpdate = (dt, ctx) => { window.__lateRan++; orig(dt, ctx); };
      return true;
    });
    record('throw-armed', armed && healthy.menMoved,
      'the induced fault is real: a registered system now throws, in a battle that was moving',
      `morale.fixedUpdate replaced; men were moving beforehand: ${healthy.menMoved}`,
      'an arm that injects nothing, or measures a battle that was already still, proves nothing');
    const m = await both(page, 4000);
    const lateRan = await page.evaluate(() => window.__lateRan);
    const rep = m.b.reports.find((r) => r.kind === 'fault');
    record('throw-frame-survives',
      m.frames > 0 && m.ticks > 0 && m.menMoved && lateRan >= m.ticks,
      'one throwing system does not take the battle with it: frames, ticks, men and the '
        + 'systems ordered after it all keep going',
      `+${m.ticks} ticks, +${m.frames} frames, men moved ${m.menMoved}, `
        + `ragdoll (order 120) ran ${lateRan} times behind a morale (order 30) that threw`,
      'unguarded, the throw escaped `frame()` and the picture froze on the last good frame');
    record('throw-reported', !!rep && rep.owner === 'morale'
      && rep.why.includes('induced by qa-freeze') && rep.count > 1,
    'the watchdog names the system, the phase and the message, and counts the repeats',
    rep ? `${rep.why} (x${rep.count})` : 'no fault report');
    record('throw-on-screen', m.b.banner.includes('A SUBSYSTEM FAILED')
      && m.b.banner.includes('morale'),
    'and says so on screen rather than only in a console nobody has open',
    m.b.banner ? m.b.banner.slice(0, 160).replace(/\s+/g, ' ') : '(no banner)');
    const wdLines = page.__cerr.filter((l) => l.startsWith('[watchdog]'));
    record('throw-console-once', wdLines.length === 1,
      'once in the console, not thirty times a second',
      `${wdLines.length} watchdog line(s) for a fault that fired ${rep?.count ?? 0} times`,
      'a console with nine hundred identical stacks in it has the signal buried in it');
    const induced = page.__errs.filter((e) => e.includes('induced by qa-freeze'));
    record('throw-still-a-pageerror', induced.length === 1,
      'and still reaches `window.onerror` exactly once, so no gate goes blind',
      `${induced.length} pageerror(s) carrying the induced message`,
      'swallowing it would make every `pageerror` collector in tools/ stop seeing this class');
    measured.throw = {
      ticks: m.ticks, frames: m.frames, menMoved: m.menMoved,
      report: rep, watchdogConsole: wdLines, pageErrors: induced.length,
    };
    await page.close();
    pages.splice(pages.indexOf(page), 1);
  }

  // -------------------------------------------------------------------------
  // Arm: the relay disappears mid-battle — the cause, reproduced
  // -------------------------------------------------------------------------
  if (wanted('net-drop')) {
    console.log('\n=== the relay disappears mid-battle ===');
    const relay = await startRelay(RELAY_PORT + 1);
    const q = `net=${encodeURIComponent(relay.base)}&room=FRZDR&autoplay=1&deploy=0`;
    const host = await newPage();
    await bootThroughMenu(host, {
      base, map: 'campus-martius', scenario: 'field', tier: 'low', size: 'small', query: q,
    });
    const guest = await newPage();
    await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    await host.evaluate(INSTALL);
    await guest.evaluate(INSTALL);
    for (const p of [host, guest]) {
      await p.waitForFunction(() => window.__game.net.status().phase === 'battle',
        null, { timeout: 90000 });
    }
    await sleep(3000);
    const live = await host.evaluate(() => window.__wd());
    // Not `guest.close()` — `tools/qa-net.mjs`'s `leave` arm already covers a peer that goes
    // away, and the relay tells the survivor about that. This is the half nothing covered:
    // the relay itself is what disappears, so there is nobody left to send a message.
    relay.proc.kill('SIGKILL');
    const m = await both(host, 6000);
    const gm = await guest.evaluate(() => window.__wd());
    record('net-drop-halts', m.ticks === 0,
      'the battle stops, which is correct — there is no reconnection and §4.5 refuses one',
      `+${m.ticks} ticks over 6 s (was at tick ${live.tick})`);
    record('net-drop-is-named', m.b.net?.ended === 'linkLost'
      && !!m.b.net?.message && gm.net?.ended === 'linkLost',
    'and both clients say what happened, by name, at a stated tick',
    `host: ${m.b.net?.ended} — ${m.b.net?.message}; guest: ${gm.net?.ended}`,
    'before this the ceiling simply stood: 1x on the top bar, animations running, no message');
    const strip = await host.evaluate(() =>
      document.querySelector('.tc-net')?.textContent ?? '');
    record('net-drop-on-screen', strip.includes('linkLost'),
      'and it is on the screen the player is looking at',
      strip.replace(/\s+/g, ' ').slice(-160));
    record('net-drop-no-false-alarm', m.b.reports.length === 0,
      'the watchdog stays quiet, because a match that has ended with a result is not a freeze',
      `${m.b.reports.length} watchdog report(s); the session strip is the message`,
      'two notices for one event is how a player learns to ignore both');
    measured.netDrop = {
      tickAtDrop: live.tick, ticksAfter: m.ticks, framesAfter: m.frames,
      host: m.b.net, guest: gm.net, strip: strip.replace(/\s+/g, ' ').slice(-200),
      reports: m.b.reports,
    };
    for (const p of [host, guest]) { await p.close(); pages.splice(pages.indexOf(p), 1); }
  }
  // -------------------------------------------------------------------------
  // Arm: the socket stays open and the relay stops talking — the sleeping laptop
  // -------------------------------------------------------------------------
  if (wanted('net-silent')) {
    console.log('\n=== the relay stops talking without closing the socket ===');
    /*
     * `SIGSTOP`, not `SIGKILL`, and the difference is the whole arm.
     *
     * A killed process closes its sockets and the browser fires `onclose`, which is the path
     * `net-drop` covers. A *stopped* one does not: the TCP connection stays open in the
     * kernel, the client's `WebSocket.readyState` stays 1, and the packets simply cease. That
     * is what a laptop waking from sleep and a wireless link that has gone away both look
     * like, and it is the case `onclose` cannot cover — so if this arm goes red the fix is
     * half a fix and the freeze is still shippable.
     */
    const relay = await startRelay(RELAY_PORT + 2);
    const q = `net=${encodeURIComponent(relay.base)}&room=FRZSL&autoplay=1&deploy=0`;
    const host = await newPage();
    await bootThroughMenu(host, {
      base, map: 'campus-martius', scenario: 'field', tier: 'low', size: 'small', query: q,
    });
    const guest = await newPage();
    await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
    await host.evaluate(INSTALL);
    for (const p of [host, guest]) {
      await p.waitForFunction(() => window.__game.net.status().phase === 'battle',
        null, { timeout: 90000 });
    }
    await sleep(3000);
    const live = await host.evaluate(() => window.__wd());
    relay.proc.kill('SIGSTOP');
    // Four seconds — under the six-second threshold — must still be silence, not a verdict.
    await sleep(4000);
    const early = await host.evaluate(() => window.__wd());
    record('net-silent-patient', !early.net?.ended,
      'four seconds of silence is a hitch and is treated as one',
      `ended ${JSON.stringify(early.net?.ended ?? '')} after 4 s at tick ${early.tick}`,
      'the threshold has to leave room for a link having a bad moment');
    await sleep(9000);
    const late = await host.evaluate(() => window.__wd());
    record('net-silent-named', late.net?.ended === 'linkLost'
      && late.net.message.includes('nothing has arrived'),
    'and thirteen seconds is a dead link, named, even though the socket never closed',
    `${late.net?.ended}: ${late.net?.message}`,
    'this is the half `onclose` cannot cover — a sleeping laptop leaves the socket open');
    const strip = await host.evaluate(() =>
      document.querySelector('.tc-net')?.textContent ?? '');
    record('net-silent-on-screen', strip.includes('linkLost'),
      'and it is on screen rather than only in the console',
      strip.replace(/\s+/g, ' ').slice(-170));
    measured.netSilent = {
      tickAtStop: live.tick, early: early.net?.ended ?? '', late: late.net,
      reports: late.reports, strip: strip.replace(/\s+/g, ' ').slice(-200),
    };
    try { relay.proc.kill('SIGCONT'); } catch { /* gone */ }
    relay.proc.kill('SIGKILL');
    for (const p of [host, guest]) { await p.close(); pages.splice(pages.indexOf(p), 1); }
  }
} catch (e) {
  console.error(e);
  results.push({ name: 'harness', ok: false, claim: 'the gate itself ran', detail: String(e) });
}

await cleanup();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (JSON_OUT) {
  fs.writeFileSync(path.resolve(ROOT, JSON_OUT),
    `${JSON.stringify({ results, measured }, null, 2)}\n`);
  console.log(`wrote ${JSON_OUT}`);
}
process.exit(passed === results.length ? 0 : 1);
