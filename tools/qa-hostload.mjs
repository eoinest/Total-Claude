#!/usr/bin/env node
/**
 * QA: how long a guest on the next laptop waits for `npm run host`.
 *
 * ## The complaint this measures
 *
 * The owner ran `npm run host`, a friend on another machine opened the link, and it *"takes
 * wayyyy too long to load"*. The host never feels it — his browser is on loopback, warm, and
 * has every module cached from the last run. The guest pays for all of it over Wi-Fi, once,
 * cold, on a first visit.
 *
 * So this measures the guest and nothing else:
 *
 *   - **Over the LAN address**, never loopback. A number taken at `127.0.0.1` is a number
 *     about the kernel's loopback shortcut, and the whole complaint is about the thing it
 *     skips. `--base` is asserted non-loopback unless `--allow-loopback` says otherwise.
 *   - **Cold**, which means a browser cache cleared through CDP *and* a fresh context, because
 *     the second visit is a different product and is measured separately as `warm`.
 *   - **To interactive**, not to `load`. `load` fires when the bytes are in; what the guest is
 *     waiting for is a screen with a button on it, which is `.tc-lobby` on an invite link and
 *     the main menu on a bare one. Those selectors are the definition of "done" here.
 *   - **Throttled as well as not.** The friend is on Wi-Fi, not a switch. An unthrottled
 *     number on a gigabit LAN flatters any payload; see `PROFILES`.
 *
 * Bytes are counted on the wire from `Network.loadingFinished.encodedDataLength`, which is what
 * the interface actually carried — not `content-length`, and not the decompressed size.
 *
 * ## Usage
 *
 *     node tools/qa-hostload.mjs                       # start `npm run host`, measure it
 *     node tools/qa-hostload.mjs --dev                 # the same, through the dev server
 *     node tools/qa-hostload.mjs --base=http://192.168.1.77:5958   # measure a server already up
 *     node tools/qa-hostload.mjs --reps=3 --json=/tmp/before.json
 *
 *     node tools/qa-hostload.mjs --battle --reps=1 --profiles=off   # what a battle fetches
 *
 * Flags: --port --relay-port --dev --base --room --reps --profiles --json --keep
 *        --allow-loopback --quiet --label --battle
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from './lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const FLAGS = ['port', 'relay-port', 'dev', 'base', 'room', 'reps', 'profiles', 'json', 'keep',
  'allow-loopback', 'quiet', 'label', 'battle'];
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const bad = [...args.keys()].filter((k) => !FLAGS.includes(k));
if (bad.length) {
  console.error(`unknown flag(s): ${bad.map((k) => `--${k}`).join(', ')}`);
  console.error(`known: ${FLAGS.map((k) => `--${k}`).join(' ')}`);
  process.exit(2);
}

const PORT = Number(args.get('port') ?? 5952);
const RELAY_PORT = Number(args.get('relay-port') ?? 5953);
const DEV = args.has('dev');
const BASE_IN = args.get('base') ?? null;
const REPS = Number(args.get('reps') ?? 3);
const JSON_OUT = args.get('json') ?? null;
const KEEP = args.has('keep');
const ALLOW_LOOPBACK = args.has('allow-loopback');
const QUIET = args.has('quiet');
const LABEL = args.get('label') ?? (DEV ? 'dev' : 'prod');
/*
 * `--battle` swaps the two page loads for one battle boot, and it answers a different question.
 *
 * The lobby and the menu touch no textures at all — measured, 0 bytes under `/assets/` on both
 * servers — so they say nothing about the 214 MB the dev server would serve raw. A battle is
 * where `manifest.json` is read and the ground textures and the HDRI are fetched, and it is the
 * only load on which the difference between `public/assets` and `dist/assets` can be seen.
 *
 * Slow, so it is opt-in and normally run at `--reps=1 --profiles=off`: the number wanted from
 * it is the byte count under `/assets/`, and that does not vary with the link speed.
 */
const BATTLE = args.has('battle');

/**
 * The link profiles, and why these two numbers.
 *
 * `off` is the control: a gigabit LAN between two machines on the same switch, which is the
 * number that makes any payload look acceptable and is not what anybody in this story has.
 *
 * `wifi` is the case the complaint is about — a laptop a couple of rooms from the access point.
 * 30 Mbit/s down and 20 ms of round trip is a deliberately *mid-range* 802.11 link: better than
 * a bad one, worse than sitting next to the router. It is chosen so the comparison is about the
 * payload rather than about how pessimistic the profile is; a payload that is fine here is fine
 * on anything better, and the ratio between the two builds is what actually transfers.
 */
const PROFILES = {
  off: null,
  wifi: { label: '30 Mbit/s down, 15 up, 20 ms RTT', downMbps: 30, upMbps: 15, latencyMs: 20 },
  'wifi-weak': { label: '8 Mbit/s down, 4 up, 60 ms RTT', downMbps: 8, upMbps: 4, latencyMs: 60 },
};
const PROFILE_NAMES = (args.get('profiles') ?? 'off,wifi').split(',').map((s) => s.trim());
for (const p of PROFILE_NAMES) {
  if (!(p in PROFILES)) {
    console.error(`unknown profile '${p}'; known: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(2);
  }
}

const say = (...a) => { if (!QUIET) console.log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)} ms`);
/*
 * Bytes below a kilobyte are printed as bytes, not as "0 kB".
 *
 * A returning guest's whole revisit is two conditional requests and a couple of hundred bytes
 * of 304 headers, and rounding that to zero would make the caching claim look better than it
 * is and hide the case where something is quietly re-fetched.
 */
const kb = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(0)} kB` : `${Math.round(n)} B`);
const median = (xs) => {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ---------------------------------------------------------------------------
// The server under measurement
// ---------------------------------------------------------------------------

let host = null;
const stopHost = () => {
  if (!host || KEEP) return;
  try { host.kill('SIGTERM'); } catch { /* already gone */ }
  host = null;
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopHost(); process.exit(1); });
process.on('exit', stopHost);

/** `npm run host`'s own tool, in the mode being measured, reporting itself in one JSON line. */
async function startHost() {
  const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'host-lan.mjs'),
    `--port=${PORT}`, `--relay-port=${RELAY_PORT}`, '--json', '--no-open',
    ...(DEV ? ['--dev'] : [])],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  host = p;
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += String(d); if (!QUIET) process.stderr.write(String(d).replace(/^(?!\{)/gm, '  | ')); });
  p.stderr.on('data', (d) => { err += String(d); });
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    const m = out.match(/^\{.*\}$/m);
    if (m) { try { return JSON.parse(m[0]); } catch { /* half a line */ } }
    if (p.exitCode !== null) break;
    await sleep(300);
  }
  throw new Error(`host-lan said nothing usable on ${PORT}/${RELAY_PORT}: `
    + `${(err || out).trim().slice(0, 600) || '(silence)'}`);
}

let base;
let room = args.get('room') ?? null;
let served = null;
if (BASE_IN) {
  base = BASE_IN.replace(/\/+$/, '');
} else {
  const said = await startHost();
  base = `http://${said.lan}:${said.gamePort}`;
  room = room ?? said.room;
  served = said.served ?? (DEV ? 'dev' : 'unknown');
}
if (!ALLOW_LOOPBACK && /\/\/(localhost|127\.|\[?::1)/.test(base)) {
  console.error(`${base} is loopback. This tool measures the machine next door; a loopback`);
  console.error('number is about a kernel shortcut the guest does not get. --allow-loopback to override.');
  process.exit(2);
}

/*
 * The two pages a guest can land on, and they are different products.
 *
 * `lobby` is the invite link's screen: `?mp=1` reaches it without a room, and the room is
 * deliberately *not* in the URL. `?room=CODE` — the string the terminal prints — auto-joins,
 * and a joiner with no host in the room sits on the loading splash until the relay gives up.
 * Measured that way the first draft of this tool reported 121 s three times running, which is
 * a true fact about an empty room and says nothing at all about how long the page took to
 * arrive. What a guest is waiting for is the sheet; `?mp=1` is the shortest honest path to it.
 *
 * `menu` is a bare visit, which has to boot the whole front door. It is the longer of the two
 * and the one that moves most when the payload changes.
 */
const PAGES = BATTLE
  ? [{
    id: 'battle',
    url: `${base}/?menu=0&autoplay=1&quality=high&map=campus-martius&scenario=assault`,
    readyFn: 'window.__game && window.__game.ready === true',
  }]
  : [
    { id: 'lobby', url: `${base}/?mp=1`, ready: '.tc-lobby' },
    { id: 'menu', url: `${base}/`, ready: '.menu.at-home .menu-home' },
  ];

// ---------------------------------------------------------------------------
// One load, cold or warm, throttled or not
// ---------------------------------------------------------------------------

/**
 * One context, one or two navigations: the cold one, and optionally the revisit.
 *
 * They have to share a context, and that is the correction that made the warm number mean
 * anything. Playwright partitions the HTTP cache per `BrowserContext`, so the first version —
 * which opened a fresh context for the "warm" pass — measured a second cold load and reported
 * that a returning guest re-downloaded all 23 MB. A returning guest does not; the point of
 * `Cache-Control` is that they do not, and a tool that cannot see the difference cannot check
 * it. So: cache cleared once through CDP, load, then load again on the same page.
 */
async function loadOnce(browser, { url, ready, readyFn, profile, revisit = false, timeoutMs = 300000 }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`.slice(0, 200)); });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`.slice(0, 200)));

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Network.emulateNetworkConditions', profile
    ? {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: (profile.downMbps * 1e6) / 8,
      uploadThroughput: (profile.upMbps * 1e6) / 8,
    }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  /*
   * Wire bytes, from the only place that knows them.
   *
   * `encodedDataLength` on `loadingFinished` is what came off the socket for that request,
   * compression included. `content-length` is a claim the server makes and is absent on a
   * chunked response; `response.encodedBodyLength` in the page is the decompressed figure and
   * would make a gzipped payload look identical to an ungzipped one, which is the exact
   * distinction this tool exists to show.
   */
  let seen = new Map();
  let wire = 0;
  let cacheHits = 0;
  cdp.on('Network.responseReceived', (e) => {
    seen.set(e.requestId, {
      url: e.response.url,
      status: e.response.status,
      mime: e.response.mimeType,
      cached: !!e.response.fromDiskCache,
      encoding: e.response.headers?.['content-encoding'] ?? e.response.headers?.['Content-Encoding'] ?? '',
      bytes: 0,
    });
  });
  cdp.on('Network.requestServedFromCache', () => { cacheHits++; });
  cdp.on('Network.loadingFinished', (e) => {
    const r = seen.get(e.requestId);
    if (!r) return;
    r.bytes = e.encodedDataLength ?? 0;
    wire += r.bytes;
  });

  /** One navigation, timed from `goto` to the screen the guest is waiting for. */
  const once = async () => {
    const t0 = Date.now();
    let interactive = null;
    let failed = null;
    let nav = null;
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
      if (readyFn) {
        // A string expression rather than a closure, and three arguments rather than two.
        // Playwright's signature is (pageFunction, arg, options): an options object in the
        // argument slot is silently handed to the page and the 30 s default applies instead.
        // `tools/check-tool-args.mjs` exists for exactly that mistake.
        await page.waitForFunction(readyFn, null, { timeout: timeoutMs });
      } else {
        await page.waitForSelector(ready, { state: 'visible', timeout: timeoutMs });
      }
      interactive = Date.now() - t0;
      nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        const fp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
        return n
          ? {
            ttfb: n.responseStart, domContentLoaded: n.domContentLoadedEventEnd,
            load: n.loadEventEnd || null, fcp: fp ? fp.startTime : null,
          }
          : null;
      });
    } catch (err) {
      failed = String(err?.message ?? err).split('\n')[0].slice(0, 200);
    }
    // A short settle so late requests land in the byte count rather than after the tab closes.
    await sleep(600);
    return { interactive, failed, nav };
  };

  const first = await once();
  const cold = {
    ...first, wire, cacheHits, count: seen.size,
    requests: [...seen.values()].sort((a, b) => b.bytes - a.bytes),
  };

  let warm = null;
  if (revisit) {
    seen = new Map();
    wire = 0;
    cacheHits = 0;
    const second = await once();
    warm = {
      ...second, wire, cacheHits, count: seen.size,
      requests: [...seen.values()].sort((a, b) => b.bytes - a.bytes),
    };
  }

  await context.close();
  return { ...cold, warm, errs: errs.slice(0, 6) };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

say(`\n=== guest load over ${base} (${served ?? 'given'}) ===`);
if (room) say(`  invite link: ${base}/?room=${room}`);

const browser = await launchBrowser({ label: `qa-hostload:${LABEL}`, port: PORT, root: ROOT });
const results = [];
try {
  for (const pageSpec of PAGES) {
    for (const name of PROFILE_NAMES) {
      const profile = PROFILES[name];
      const runs = [];
      for (let i = 0; i < REPS; i++) {
        // The last rep carries the revisit, so a returning guest costs one navigation and not
        // a whole extra cold load.
        runs.push(await loadOnce(browser, { ...pageSpec, profile, revisit: i === REPS - 1 }));
      }
      const ok = runs.filter((r) => r.interactive !== null);
      const warm = runs[runs.length - 1].warm;
      const byDir = new Map();
      for (const r of (ok[0] ?? runs[0]).requests) {
        const p = r.url.replace(base, '').split('?')[0];
        const dir = p.startsWith('/assets/') ? `/assets/${p.split('/')[2] ?? ''}`
          : p.startsWith('/bundle/') ? '/bundle'
            : p.startsWith('/src/') ? '/src'
              : p.startsWith('/@') || p.startsWith('/node_modules') ? '/@vite deps'
                : '(document & other)';
        const cur = byDir.get(dir) ?? { bytes: 0, count: 0 };
        byDir.set(dir, { bytes: cur.bytes + r.bytes, count: cur.count + 1 });
      }
      const rec = {
        page: pageSpec.id,
        url: pageSpec.url,
        profile: name,
        profileLabel: profile?.label ?? 'unthrottled',
        reps: REPS,
        interactiveMs: median(ok.map((r) => r.interactive)),
        interactiveAll: runs.map((r) => r.interactive),
        wireBytes: median(ok.map((r) => r.wire)),
        requests: median(ok.map((r) => r.count)),
        ttfbMs: median(ok.map((r) => r.nav?.ttfb)),
        fcpMs: median(ok.map((r) => r.nav?.fcp)),
        warmInteractiveMs: warm?.interactive ?? null,
        warmWireBytes: warm?.wire ?? null,
        warmRequests: warm?.count ?? null,
        warmCacheHits: warm?.cacheHits ?? null,
        failures: runs.filter((r) => r.failed).map((r) => r.failed),
        consoleErrs: [...new Set(runs.flatMap((r) => r.errs))].slice(0, 6),
        byDir: Object.fromEntries([...byDir].sort((a, b) => b[1].bytes - a[1].bytes)),
        heaviest: (ok[0] ?? runs[0]).requests.slice(0, 12)
          .map((r) => ({ url: r.url.replace(base, ''), bytes: r.bytes, mime: r.mime, enc: r.encoding })),
      };
      results.push(rec);
      say(`\n  ${pageSpec.id.padEnd(7)} ${name.padEnd(10)} ${(profile?.label ?? 'unthrottled')}`);
      say(`    interactive   ${ms(rec.interactiveMs)}   (reps: ${rec.interactiveAll.map((n) => (n === null ? 'fail' : Math.round(n))).join(', ')})`);
      say(`    wire bytes    ${rec.wireBytes === null ? '—' : kb(rec.wireBytes)} over ${rec.requests ?? '—'} requests`);
      say(`    ttfb / fcp    ${ms(rec.ttfbMs)} / ${ms(rec.fcpMs)}`);
      say(`    warm revisit  ${ms(rec.warmInteractiveMs)}, ${rec.warmWireBytes === null ? '—' : kb(rec.warmWireBytes)} over `
        + `${rec.warmRequests ?? '—'} requests (${rec.warmCacheHits ?? 0} served from cache without asking)`);
      say(`    by directory  ${Object.entries(rec.byDir).map(([d, v]) => `${d} ${kb(v.bytes)}/${v.count}`).join('   ')}`);
      if (rec.failures.length) say(`    FAILED        ${rec.failures[0]}`);
      if (rec.consoleErrs.length) say(`    console       ${rec.consoleErrs.join(' ; ').slice(0, 200)}`);
    }
  }
} finally {
  await browser.close();
  stopHost();
}

if (results.length) {
  say('\n  heaviest requests on the slowest measured page:');
  const worst = results.reduce((a, b) => ((b.interactiveMs ?? 0) > (a.interactiveMs ?? 0) ? b : a));
  for (const r of worst.heaviest.slice(0, 10)) {
    say(`    ${kb(r.bytes).padStart(10)}  ${r.enc ? `[${r.enc}] ` : ''}${r.url.slice(0, 78)}`);
  }
}

const report = {
  tc: 'qa-hostload', label: LABEL, base, room, served, dev: DEV,
  node: process.version, at: new Date().toISOString(), results,
};
if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), `${JSON.stringify(report, null, 2)}\n`);
  say(`\n  → ${JSON_OUT}`);
}

const anyFail = results.some((r) => r.interactiveMs === null);
process.exit(anyFail ? 1 : 0);
