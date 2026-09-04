/**
 * How a gate plays a networked battle: the page-side hooks, the mouse gestures, the comparison.
 *
 * ## Why this is a library and not two copies
 *
 * There are two netcode gates now — `tools/qa-net.mjs`, which drives a relayed match, and
 * `tools/qa-p2p.mjs`, which drives a peer-to-peer one — and every gesture in them is identical,
 * because a *player* does the identical thing either way. That is the whole claim the second
 * transport is making: same lobby, same plaque, same right-click, same battle.
 *
 * Two copies of a driver is the failure `src/net/room.ts` opens its own docstring by refusing,
 * and it would land here in a particularly nasty shape. `deployWith` carries three separate
 * lessons paid for in red runs — the plaque is attached two frames after `ready`, a disabled
 * palette row makes `page.click` hang for thirty seconds and then blame a locator, and BEGIN
 * BATTLE has to be *asked about* rather than clicked at. A second copy would start with those
 * lessons and lose them one at a time, and each loss would present as "the new transport is
 * flaky".
 *
 * So: one driver, two gates. What is deliberately **not** here is anything that knows about a
 * transport. `qa-net` stops a relay process with SIGSTOP to bring two clients to a common tick;
 * a peer session has no process to stop and has to be settled a different way. Those live in
 * their own files, where the difference is visible.
 *
 * ## Read-only by convention, and the convention is load-bearing
 *
 * Every order these functions issue goes through `page.mouse` and `page.keyboard`. Nothing calls
 * into `window.__game` to make something happen — the hooks below only *read*. A gate that
 * drove the API would be testing the API, and this repository has a documented history of
 * checks that could not fail.
 */

/**
 * Installed into a page with `page.evaluate(INSTALL)` once `window.__game.ready` is true.
 *
 * `window.__game` is the product's own hook (`src/main.ts`); everything here is the harness's,
 * and the split matters: the product publishes the engine, the battle and the session, and the
 * gate builds its own readers over them rather than asking the product to grow a test surface.
 */
export const INSTALL = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  const V = new (ctx.camera.position.constructor)();
  window.__proj = (x, y, z) => {
    V.set(x, y, z).project(ctx.camera);
    if (V.z > 1) return null;
    return { x: (V.x * 0.5 + 0.5) * ctx.viewW, y: (-V.y * 0.5 + 0.5) * ctx.viewH };
  };
  window.__net = () => (g.net ? {
    ...g.net.status(),
    desync: g.net.desync,
    perturbed: g.net.perturbedUnit,
    lastCheckpoint: g.net.lastCheckpoint,
    lat: g.net.latencies(),
  } : null);
  window.__tick = () => g.engine.time.tick;
  /**
   * The tick and the state, in **one** evaluate.
   *
   * Not two, and not three. A live frame lands between a driver's round trips and carries up to
   * `maxStepsPerFrame = 5` ticks with it, so reading the tick and then reading the hash reports
   * the hash of a *different* tick — measured elsewhere in this project as two runs both asked
   * for tick 6,000 and arriving at 6,000 and 6,004. Nothing about that looks like a harness
   * fault from the outside; it looks like the engine being sloppy. One evaluate, one tick.
   */
  window.__mark = () => ({ tick: g.engine.time.tick, sim: g.simTime(), ...g.hashes() });
  window.__rec = () => g.replay.record();
  window.__flow = () => ctx.tryGet('battleFlow')?.result ?? null;
  window.__dep = () => {
    const d = g.deployment;
    return d ? { active: d.active, committed: d.committed, own: d.ownUnits().length } : null;
  };
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
  /** A regiment of *this client's* faction, projected to the screen, camera parked on it. */
  window.__unitAt = (i) => {
    const mine = g.net ? g.net.myFaction : 0;
    const own = g.battle.units.filter((u) => !u.destroyed && u.faction === mine && u.alive > 0);
    const u = own[i % Math.max(1, own.length)];
    if (!u) return null;
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
  window.__selection = () => ctx.tryGet('hud')?.controller.model.selection.slice() ?? [];
  /**
   * Every checkpoint this client computed, keyed by tick.
   *
   * The independent half of the lockstep proof. Two pages read a fifth of a second apart are
   * two pages several ticks apart, so "read `__mark()` on both and compare" is a race — measured
   * while writing this: host at 853, guest at 854, every exchanged checkpoint agreeing, and the
   * naive comparison calling it a divergence. These are computed *at* ticks 30, 60, 90 … on each
   * page independently, so a gate can intersect them and compare bit for bit at every one.
   */
  window.__checks = () => (g.net ? g.net.checkpoints() : null);
  /**
   * The transport's own account of itself, or null on a relayed session.
   *
   * Added for the peer gate and read by nothing else. It is how a check can say *what kind of
   * connection this was* — `host` means the two machines were on one network and never needed a
   * server, `srflx` means the traffic crossed the internet directly — instead of asserting that
   * something connected and calling that a peer-to-peer measurement.
   */
  window.__peer = () => {
    const l = g.net?.linkForTests;
    return l && l.diag ? l.diag() : null;
  };
};

/**
 * What the lobby is showing *about transport*, which is the whole subject of several arms.
 *
 * **`checkVisibility()` and hit-testing, not a bounding box.** Measured while writing this:
 * Chromium gives an `<input>` inside a closed `<details>` a full 550×40 box at a real `y`, so
 * `getClientRects().length` and Playwright's own `isVisible()` both call it visible. It is not:
 * `checkVisibility()` returns false, `elementFromPoint` over the middle of that box returns
 * something else, and `innerText` leaves its label and its hint out. A check written on the
 * rectangle would have passed for a field sitting open on the screen.
 *
 * `text` is `innerText` for the same reason — it is the rendered text, so it is what the player
 * can actually read, which makes a regex over it a real claim about what is on screen.
 */
export const lobbyFace = (page) => page.evaluate(() => {
  const sheet = document.querySelector('.tc-sheet');
  const relay = document.querySelector('#tc-relay');
  const adv = document.querySelector('#tc-adv');
  const blocked = document.querySelector('#tc-no-relay');
  const via = document.querySelector('#tc-via-relay');
  const shown = (el) => !!el && el.checkVisibility();
  const flat = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const reaches = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const t = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return !!t && (t === el || el.contains(t));
  };
  return {
    origin: location.origin,
    // The server's own claims about itself, read back so an arm can prove which fixture it got.
    metaLan: document.querySelector('meta[name="tc-lan"]')?.getAttribute('content') ?? null,
    metaRelay: document.querySelector('meta[name="tc-relay"]')?.getAttribute('content') ?? null,
    text: flat(sheet),
    relayValue: relay ? relay.value : null,
    relayShown: shown(relay),
    relayReaches: reaches(relay),
    advPresent: !!adv,
    advOpen: !!adv?.open,
    blockedShown: shown(blocked),
    blockedText: shown(blocked) ? flat(blocked) : '',
    createDisabled: document.querySelector('#tc-host')?.disabled ?? null,
    joinDisabled: document.querySelector('#tc-join')?.disabled ?? null,
    // The relay-transport checkbox: present, and whether it is ticked. Its absence is a
    // finding, not a missing field, so `null` and `false` are deliberately different answers.
    viaRelayPresent: !!via,
    viaRelayChecked: via ? !!via.checked : null,
    roomPresent: !!document.querySelector('#tc-room'),
    roomReaches: reaches(document.querySelector('#tc-room')),
  };
});

/**
 * Open the transport disclosure, the way somebody who wanted it would.
 *
 * A real click on the summary, and then a wait on `details.open` — `page.fill('#tc-relay')`
 * needs the field rendered, and Playwright's actionability check for `fill` correctly refuses a
 * field inside a closed `<details>`.
 */
export const openAdvanced = async (page) => {
  /*
   * Idempotent, and that is a correction rather than a nicety.
   *
   * `<summary>` toggles, so clicking it on a panel that is *already* open closes it — and then
   * the wait below sits for its full ten seconds and throws about a locator. That is reachable
   * now: `?net=` makes the lobby open the disclosure by itself, because somebody who named a
   * relay in a URL is somebody who wants to see the relay field. Ask first.
   */
  const already = await page.evaluate(() => document.querySelector('#tc-adv')?.open === true);
  if (already) return;
  await page.click('#tc-adv-summary');
  await page.waitForFunction(() => document.querySelector('#tc-adv')?.open === true,
    null, { timeout: 10000 });
};

/**
 * Drive the menu, and say what the page was showing if it never appeared.
 *
 * `driveMenu` opens with a `waitForSelector` on the menu sheet, and a page that went somewhere
 * else instead produces sixty seconds of silence and then a `TimeoutError` naming a locator. That
 * is the failure shape this repository complains about most often, and it cost a whole `qa-net`
 * run: the `lan` arm died at `driveMenu` after CHOOSE THE BATTLE, the eight arms after it never
 * ran, and the log said nothing about *what was on the screen* — which turned out to be the one
 * thing needed.
 *
 * `main.ts` has several screens that are not the menu and are correct outcomes: a notice from
 * `netFailed`, the too-narrow refusal, the lobby itself. Naming which one appeared turns a
 * locator into a diagnosis.
 */
export async function driveMenuOrExplain(page, driveMenu, opts, tag) {
  try {
    return await driveMenu(page, opts);
  } catch (e) {
    const seen = await page.evaluate(() => ({
      url: location.href,
      h1: (document.querySelector('h1')?.textContent ?? '').trim(),
      sheet: (document.querySelector('.tc-sheet')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      load: (document.querySelector('#load-text')?.textContent ?? '').trim(),
      menu: !!document.querySelector('.menu'),
      ready: window.__game?.ready === true,
    })).catch(() => null);
    const errs = (page.__errs ?? []).slice(0, 3).join(' | ');
    throw new Error(`${tag}: the menu never appeared — ${e.message.split('\n')[0]}\n`
      + `  url    ${seen?.url ?? '(unreadable)'}\n`
      + `  screen ${seen?.h1 ? `"${seen.h1}"` : '(no h1)'} menu=${seen?.menu} ready=${seen?.ready}`
      + ` loading="${seen?.load ?? ''}"\n`
      + `  sheet  ${(seen?.sheet ?? '').slice(0, 260)}\n`
      + `  errors ${errs || '(none)'}`);
  }
}

/**
 * Are these two clients at the same tick of the same battle?
 *
 * Returns `null` when they are, and the term that failed when they are not — because a
 * comparison of six things that prints only four of them costs an hour the first time it goes
 * red, and it did.
 *
 * **`simTime` is deliberately *not* compared across the two clients.** It used to be, with the
 * reasoning that "equal hashes at unequal sim times would mean the comparison had been taken at
 * two moments". That reasoning is sound and the implementation did not follow from it.
 * `Time.beginFrame` accumulates `simTime += steps * fixedDt`, so the value depends on how the
 * frame loop *grouped* its ticks — five in one frame or one in five — and float addition is not
 * associative. Two clients that ran the identical 1,365 ticks therefore hold sim times
 * 3.6e-14 apart whenever the machine paced their frames differently, which is whenever the
 * machine is busy. Measured on the siege arm: tick, pool, `uf64`, `uctl`, count and alive all
 * identical, and this check red on 4 parts in 1e15 of an accumulator the simulation never
 * reads. It is a property of the wall clock, not of the battle.
 *
 * What the original intent actually needs is that each client's *own* mark is self-consistent —
 * that the tick and the state in it came from the same moment — and `window.__mark()` already
 * guarantees that by reading both in one `evaluate`. The tolerance check below is the belt to
 * that brace: it catches a clock that has been re-baselined out from under its tick counter,
 * which is a real bug this codebase has the machinery for (`Time.resync`, `tickCeiling`), and
 * it does so per client, where the question is well posed.
 */
const TICK_HZ = 30;
export function markDisagreement(a, b) {
  if (a.tick !== b.tick) return `they stopped at different ticks: ${a.tick} and ${b.tick}`;
  for (const [tag, m] of [['host', a], ['guest', b]]) {
    const want = m.tick / TICK_HZ;
    if (Math.abs(m.hashes.sim - want) > 1e-6) {
      return `${tag}'s own clock disagrees with its own tick: sim ${m.hashes.sim} at tick `
        + `${m.tick} (expected ${want})`;
    }
  }
  for (const layer of ['hash', 'uf64', 'uctl', 'alive', 'count']) {
    if (a.hashes[layer] !== b.hashes[layer]) {
      return `${layer} differs at tick ${a.tick}: ${a.hashes[layer]} against ${b.hashes[layer]}`;
    }
  }
  return null;
}

/** First event that differs between two merged order logs, spelled out. */
export function logDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i] ?? null);
    const y = JSON.stringify(b[i] ?? null);
    if (x !== y) return `event ${i}: host ${x} vs guest ${y}`;
  }
  return null;
}

/**
 * Where the session strip is, where the deployment plaque is, and what a click at the centre of
 * each deployment control would actually land on.
 *
 * Here rather than in `qa-net`, and for the reason at the top of this file: there are two
 * netcode gates, the strip is drawn by one `NetPanel` for both of them, and the owner's question
 * was explicitly *"do this for both transports"*. A relayed strip says ROOM QAQQR and a peer
 * strip says something else, so the two are worth asking separately — but they are worth asking
 * with **one** instrument, or the day they disagree nobody will be able to tell whether it was
 * the product or the two copies of the probe.
 *
 * ## Three deliberate choices about what "the player can reach this" means
 *
 * - **`checkVisibility()`**, not `getBoundingClientRect().height > 0` and not Playwright's
 *   `isVisible()`. Both of the latter report a healthy box for an element inside a closed
 *   `<details>`, which this repository has already been misled by once.
 * - **`document.elementFromPoint` at the measured centre.** This is the browser's own hit test,
 *   the same one a click runs, and it is the only reading that can distinguish *covered* from
 *   *drawn over*: `pointer-events: none` makes an element invisible to it, which is exactly the
 *   difference between a strip that hides a control and a strip that eats it.
 * - **`hitIsStrip` walks the strip's subtree.** `elementFromPoint` returns the innermost element,
 *   which over `.tc-net` is one of its `<span>`s and not `.tc-net` itself; a check that compared
 *   against the strip node alone would have passed through the whole fault.
 *
 * `distinct` is carried for the caller to assert on. A geometry check whose two selectors have
 * quietly collapsed onto one element compares that element against itself and cannot go red,
 * and this repository has shipped that shape before.
 */
export const STRIP_PROBE = (lab) => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right) };
  };
  const name = (el) => {
    if (!el) return '(nothing)';
    const c = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
      + (c.length ? `.${c.join('.')}` : '');
  };
  const strip = document.querySelector('.tc-net');
  const dep = document.querySelector('.deploy');
  const sb = box(strip);
  const db = box(dep);
  const S = strip ? getComputedStyle(strip) : null;
  const D = dep ? getComputedStyle(dep) : null;
  const overlap = !!(sb && db && sb.left < db.right && sb.right > db.left
    && sb.top < db.bottom && sb.bottom > db.top);
  const want = [];
  const add = (el, tag) => { if (el) want.push([tag, el]); };
  add(dep && dep.querySelector('.dep-add'), 'ADD UNITS');
  add(dep && dep.querySelector('.dep-remove'), 'REMOVE');
  add(dep && dep.querySelector('.dep-begin'), 'BEGIN BATTLE');
  for (const row of dep ? Array.from(dep.querySelectorAll('.dep-row')) : []) {
    add(row.querySelector('[data-d="1"]'), `+ ${row.dataset.unit}`);
    add(row.querySelector('[data-d="-1"]'), `- ${row.dataset.unit}`);
  }
  const controls = want.map(([tag, el]) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const onScreen = r.width > 0 && r.height > 0
      && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    const hit = onScreen ? document.elementFromPoint(x, y) : null;
    return {
      tag, x, y, box: box(el),
      visible: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      disabled: !!el.disabled,
      onScreen,
      hit: name(hit),
      reaches: !!(hit && (hit === el || el.contains(hit))),
      hitIsStrip: !!(strip && hit && (hit === strip || strip.contains(hit))),
    };
  });
  return {
    label: lab,
    scale: getComputedStyle(document.querySelector('.hud'))
      .getPropertyValue('--ui-scale').trim(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    paletteOpen: !!document.querySelector('.dep-palette')
      ?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    strip: sb && { ...sb, pointerEvents: S.pointerEvents, zIndex: S.zIndex,
      wide: strip.classList.contains('wide'),
      text: (strip.innerText ?? '').replace(/\s+/g, ' ').trim() },
    deploy: db && { ...db, pointerEvents: D.pointerEvents, zIndex: D.zIndex },
    overlap,
    controls,
    distinct: !!(strip && dep && strip !== dep
      && !strip.contains(dep) && !dep.contains(strip)),
  };
};

/** `STRIP_PROBE`, run in a page. */
export const readStrip = (page, label) => page.evaluate(STRIP_PROBE, label);

/**
 * One line per reading, in the shape a failing run has to be readable in.
 *
 * Printed by both gates, so the relay arm and the peer arm produce comparable output and a
 * difference between the two transports is visible by eye rather than only in the JSON.
 */
export function printStrip(r) {
  const bad = r.controls.filter((c) => c.visible && !c.reaches);
  console.log(`  ${String(r.label).padEnd(30)} strip `
    + `${r.strip ? `${r.strip.top}-${r.strip.bottom}` : 'MISSING'}`
    + ` (pe ${r.strip?.pointerEvents}, z ${r.strip?.zIndex})  plaque `
    + `${r.deploy ? `${r.deploy.top}-${r.deploy.bottom}` : 'MISSING'}`
    + ` (pe ${r.deploy?.pointerEvents}, z ${r.deploy?.zIndex})`
    + `  overlap ${r.overlap ? 'YES' : 'no'}  unreachable ${bad.length}/${r.controls.length}`);
  for (const c of bad.slice(0, 4)) {
    console.log(`      ${c.tag.padEnd(22)} centre ${c.x},${c.y} -> ${c.hit}`);
  }
}

/** Both clients' final state, for comparison. */
export async function readBoth(host, guest) {
  const rd = async (p) => {
    // The tick and the hashes together, in one evaluate: see `__mark`. Reading them separately
    // lets a live frame put five ticks between the number and the state it is supposed to
    // describe, and the comparison below is bit-for-bit.
    const mark = await p.evaluate(() => window.__mark());
    return {
      net: await p.evaluate(() => window.__net()),
      tick: mark.tick,
      simTime: mark.sim,
      hashes: mark,
      rec: await p.evaluate(() => window.__rec()),
      flow: await p.evaluate(() => window.__flow()),
      peer: await p.evaluate(() => window.__peer()),
      errs: p.__errs.slice(),
    };
  };
  return { a: await rd(host), b: await rd(guest) };
}

/**
 * The gestures, bound once to a viewport and a screenshot sink.
 *
 * A factory rather than eight functions each taking `{W, H, shot}`, because every one of them
 * needs the same three and a gate has exactly one set. `sleep` is here rather than imported so
 * the module has no dependencies at all.
 */
export function drivers({ W, H, shot = async () => {} }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const newPage = async (browser, opts = {}) => {
    const page = await browser.newPage({
      viewport: { width: W, height: H }, deviceScaleFactor: 1, ...opts,
    });
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
    page.__errs = errs;
    return page;
  };

  /**
   * What is on top of the page, if anything is. `NetPanel.raise` builds `.tc-over`.
   *
   * It is `position:fixed; inset:0`, so while it is up it swallows every click on the game
   * beneath it. That is right for a player -- a session that has ended should not accept orders
   * -- and it is the single most confusing thing that can happen to a driver.
   */
  const overlay = (page) => page.evaluate(() => {
    const o = document.querySelector('.tc-over');
    if (!o) return null;
    return {
      head: o.querySelector('h2')?.textContent?.trim() ?? '',
      text: (o.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  }).catch(() => null);

  /**
   * Every click this driver makes on a game control, with the cause attached when it fails.
   *
   * The bare version cost this gate a run and told it nothing. `qa-p2p`'s `desync` arm reported
   * *"page.click: Timeout 30000ms exceeded -- <div class="tc-over-fit"> intercepts pointer
   * events"*, which is thirty seconds of a Playwright retry loop describing the geometry of a
   * `<div>` and not one word about **why** a net panel was over the deployment screen. The panel
   * was saying something specific and legible -- a peer had gone quiet, or a session had ended --
   * and the driver stood in front of it repeating that a button would not take a click.
   *
   * So: ask before, ask after, and quote it. The pre-check is not redundant with the post-check,
   * because the overlay is usually already up when the click starts, and waiting the full timeout
   * to discover that spends the arm's budget as well as its explanation.
   */
  async function clickOrExplain(page, sel, tag, opts = {}) {
    const before = await overlay(page);
    if (before) {
      throw new Error(`${tag}: ${sel} is covered by the net panel, which says `
        + `"${before.head}" -- ${before.text}`);
    }
    try {
      await page.click(sel, { timeout: 25000, ...opts });
    } catch (e) {
      const after = await overlay(page);
      const net = await page.evaluate(() => window.__net?.() ?? null).catch(() => null);
      const state = `phase ${net?.phase ?? '?'}, ended '${net?.ended ?? ''}'`
        + `${net?.desync ? `, desync at tick ${net.desync.tick} on ${net.desync.layer}` : ''}`;
      if (after) {
        throw new Error(`${tag}: ${sel} was covered by the net panel, which says `
          + `"${after.head}" -- ${after.text} (${state})`);
      }
      throw new Error(`${tag}: ${sel} would not take a click (${state}) -- `
        + `${String(e.message).split('\n')[0]}`);
    }
  }

  /** Lay out an army with the plaque and the mouse, then press BEGIN BATTLE. */
  async function deployWith(page, tag) {
    /*
     * **A session in the deployment phase whose plaque has not attached yet is not a session
     * with nothing to deploy**, and the one-line version of this could not tell them apart.
     *
     * `window.__dep()` reads `main.ts`'s `deployment`, which is attached on `deploymentBegan`
     * inside `boot()`. A client that has just been told the phase is `deploy` reports
     * `active: false` for a beat, and `if (!d?.active) return []` walked away in silence. On a
     * peer connection with `?p2plag=60` that beat is long enough to lose the race: `qa-p2p`'s
     * `lag` arm reported *"60 ms one way: 6 orders … 0 checkpoints agreed"*, which reads as a
     * lost order under latency — the exact accusation this gate exists to make and the last one
     * it should make wrongly. Nothing had been lost; the challenger had never been asked.
     *
     * So the question is asked of the *session* first. `phase: 'deploy'` means a plaque is
     * coming and this waits for it; anything else means this client genuinely has no deployment
     * phase (`?deploy=0`), and returning `[]` is right.
     */
    let d = await page.evaluate(() => window.__dep());
    if (!d?.active) {
      const until = Date.now() + 20000;
      for (;;) {
        const st = await page.evaluate(() => ({
          dep: window.__dep(), phase: window.__net?.()?.phase ?? null,
        })).catch(() => null);
        d = st?.dep ?? null;
        if (d?.active) break;
        if (st?.phase !== 'deploy' || Date.now() > until) return [];
        await sleep(250);
      }
    }
    const done = [];
    await shot(page, `${tag}-02-deploy`);
    /*
     * Wait for the plaque rather than clicking straight at it.
     *
     * The panel is attached on `deploymentBegan`, which fires inside `boot()` — but the HUD
     * root fades in over two frames and `bootThroughMenu` returns on `window.__game.ready`,
     * which is the frame before that. A bare `page.click` on a page whose plaque has not been
     * attached yet reports "waiting for locator" thirty seconds later and says nothing about
     * which of the two clients it was.
     */
    try {
      await page.waitForSelector('.dep-add', { timeout: 30000 });
    } catch {
      const why = await page.evaluate(() => ({
        hud: document.querySelector('.hud')?.className ?? '(no .hud)',
        dep: window.__dep(),
        net: window.__net(),
        panels: Array.from(document.querySelectorAll('.hud > *')).map((e) => e.className),
      }));
      throw new Error(`${tag}: no deployment plaque — ${JSON.stringify(why)}`);
    }
    await clickOrExplain(page, '.dep-add', tag);
    await sleep(220);
    /*
     * The first row whose `+` is *enabled*, not simply the first row.
     *
     * This cost the siege arm its first run and it is the second time this repository has paid
     * for it. `tools/lib/menu-boot.mjs` says it at length: a bare `page.click` on a disabled
     * button waits thirty seconds and then throws, and it stopped `qa-replay`'s matrix arm dead
     * on its second battle. The identical hazard was sitting here, invisible, because every arm
     * booted `campus-martius / field` — where every row can be added to. On the assault the
     * establishment is fixed and `tower-assault`'s `+` ships disabled, so the driver hung on the
     * challenger and took the arm out with a `TimeoutError` naming a locator.
     *
     * Skipped rather than fatal: "this battle does not let you buy another one of those" is a
     * fact about the product. But it is *recorded* — a driver that quietly declines to do what
     * it was asked is how six playability scripts spent two days unable to reach a setup sheet.
     */
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.dep-row'))
      .map((r) => ({
        unit: r.dataset.unit,
        addable: !r.querySelector('[data-d="1"]')?.disabled,
      })));
    const addable = rows.find((r) => r.addable);
    if (addable) {
      await clickOrExplain(page, `.dep-row[data-unit="${addable.unit}"] [data-d="1"]`, tag);
      done.push(`palette +1 ${addable.unit}`);
      await sleep(320);
    } else if (rows.length) {
      done.push(`palette +1 skipped (all ${rows.length} rows at their establishment)`);
    }
    const cards = await page.$$('.cardbar .card:not(.foe)');
    if (cards.length) {
      const box = await cards[0].boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(260);
      }
    }
    const spots = await page.evaluate(() => window.__bare());
    if (spots.length >= 2) {
      await page.mouse.move(spots[0].x, spots[0].y);
      await sleep(140);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(spots[1].x, spots[1].y, { steps: 8 });
      await sleep(200);
      await page.mouse.up({ button: 'right' });
      await sleep(420);
      done.push('right-drag place');
    }
    /*
     * BEGIN, and a legible error rather than another thirty-second locator timeout.
     *
     * Same lesson as the palette row above: if this button is ever disabled — an army below its
     * minimum, a phase that has already ended under us — a bare click reports a selector and
     * nothing about which client, which battle or why. Ask first, and say all three.
     */
    const beginState = await page.evaluate(() => {
      const b = document.querySelector('.dep-begin');
      return b ? { present: true, disabled: !!b.disabled } : { present: false, disabled: false };
    });
    if (!beginState.present || beginState.disabled) {
      const why = await page.evaluate(() => ({ dep: window.__dep(), net: window.__net() }));
      throw new Error(`${tag}: BEGIN BATTLE is ${beginState.present ? 'disabled' : 'absent'}`
        + ` after ${done.length} gesture(s) — ${JSON.stringify(why)}`);
    }
    await clickOrExplain(page, '.dep-begin', tag);
    done.push('BEGIN BATTLE');
    await sleep(400);
    return done;
  }

  /** One burst of orders: select a regiment, move it, change its gait. */
  async function burst(page, i) {
    let u = null;
    for (let k = 0; k < 4 && !u; k++) {
      await page.evaluate((n) => window.__unitAt(n), i * 3 + k);
      await sleep(200);
      const qq = await page.evaluate((n) => window.__unitAt(n), i * 3 + k);
      if (qq && qq.x > 40 && qq.x < W - 40 && qq.y > 180 && qq.y < H - 220) u = qq;
    }
    if (!u) return [];
    const acts = [];
    await page.mouse.move(u.x, u.y);
    await sleep(160);
    await page.mouse.click(u.x, u.y);
    await sleep(240);
    const sel = await page.evaluate(() => window.__selection());
    if (!sel.length) return acts;
    acts.push(`select ${sel.join(',')}`);
    const spots = await page.evaluate(() => window.__bare());
    if (spots.length) {
      const p = spots[(i + 1) % spots.length];
      await page.mouse.move(p.x, p.y);
      await sleep(110);
      await page.mouse.down({ button: 'right' });
      await sleep(190);
      await page.mouse.up({ button: 'right' });
      await sleep(260);
      acts.push('right-click move');
    }
    await page.keyboard.press('KeyR');
    await sleep(180);
    acts.push('R gait');
    return acts;
  }

  /**
   * Three move orders on the same regiment, fast enough to land in one turn.
   *
   * The `swap` fault needs exactly this and nothing else will do: `applyOrder` mutates only the
   * units an order names, so two orders on *different* regiments commute and exchanging them
   * proves nothing. §4.1's claim is about two orders touching one unit, and several right-clicks
   * a few tens of milliseconds apart on one selection is what a player does when they change
   * their mind — which is also, not coincidentally, the gesture that a reordering breaks.
   *
   * Three, not two, and 25 ms apart: a turn closes every 100 ms, and two clicks straddling a
   * boundary land in two different turns, at which point there is no pair in one packet for the
   * swap to exchange and the arm passes by never having fired. Three clicks inside 75 ms cannot
   * all straddle one boundary.
   *
   * Three *distinct* spots. The third used to be `spots[0]` again, which made the sequence
   * `0,1,0`; combined with a swap of the first adjacent pair that produced `1,0,0`, and both
   * orderings ended at `spots[0]`. Distinct destinations mean the exchange is visible in the
   * final state whichever pair the fault takes.
   */
  async function doubleOrder(page, i) {
    let u = null;
    for (let k = 0; k < 4 && !u; k++) {
      await page.evaluate((n) => window.__unitAt(n), i * 2 + k);
      await sleep(200);
      const qq = await page.evaluate((n) => window.__unitAt(n), i * 2 + k);
      if (qq && qq.x > 40 && qq.x < W - 40 && qq.y > 180 && qq.y < H - 220) u = qq;
    }
    if (!u) return false;
    await page.mouse.click(u.x, u.y);
    await sleep(240);
    const sel = await page.evaluate(() => window.__selection());
    if (!sel.length) return false;
    const spots = await page.evaluate(() => window.__bare());
    if (spots.length < 2) return false;
    for (const p of [spots[0], spots[1], spots[2] ?? spots[0]]) {
      await page.mouse.move(p.x, p.y);
      await page.mouse.down({ button: 'right' });
      await sleep(25);
      await page.mouse.up({ button: 'right' });
      await sleep(25);
    }
    return true;
  }

  return { newPage, deployWith, burst, doubleOrder, sleep };
}
