#!/usr/bin/env node
/**
 * A dev server that cannot outlive the harness that started it.
 *
 * ## The orphan, measured
 *
 * Nineteen dev servers were swept off this machine in one morning, several more than a day
 * old, from worktrees whose agent sessions had ended hours before. They were not leaks in the
 * ordinary sense — every harness that starts one also kills it. The mechanism is narrower and
 * it is the same in every harness in `tools/`:
 *
 *     const server = spawn('npx', ['vite', '--port', String(PORT), ...]);
 *     ...
 *     server.kill('SIGTERM');
 *
 * `server` is **npx**, not Vite. `npx` execs a shell which execs `node .../vite.js`, so the
 * handle node holds is a wrapper two levels above the process holding the port. SIGTERM to the
 * wrapper is delivered to the wrapper; Vite keeps the port. And if the harness itself is
 * SIGKILLed — the crash an hour ago took the whole machine down with load 160 — the kill never
 * runs at all and there is nothing left that even *knows* the port is held.
 *
 * ## What this does instead
 *
 * It is Vite, in-process, via `createServer` from the `vite` package. No `npx`, no shell, no
 * wrapper: the PID the parent holds **is** the PID holding the port, so SIGTERM works. And it
 * watches its parent, because SIGTERM only helps when someone is alive to send it:
 *
 *   - Every `TC_VITE_WATCH_MS` (default 2 s) it calls `process.kill(parentPid, 0)`. When that
 *     throws `ESRCH` the parent is gone — cleanly, crashed, or SIGKILLed, it does not matter —
 *     and this closes the server and exits. macOS has no `PR_SET_PDEATHSIG`, so polling is the
 *     portable way to get "die with my parent", and 2 s is a bounded orphan lifetime rather
 *     than the unbounded one this replaces.
 *   - It also exits if the parent PID is 1 at startup, which means it was already reparented
 *     before it got going.
 *
 * It prints exactly one machine-readable line on stdout when the server is listening:
 *
 *     TC_VITE_READY {"port":5901,"base":"http://127.0.0.1:5901","pid":12345}
 *
 * so a caller can wait for readiness without polling HTTP, and knows the real PID.
 *
 * ## `--host`, and the plaque that only exists on a LAN bind
 *
 * `127.0.0.1` remains the default and every harness keeps it. `tools/host-lan.mjs` passes
 * `--host=0.0.0.0 --relay-port=5959`, and that combination — and only that combination — makes
 * this server state the address the machine next door reaches it at.
 *
 * It exists because of a case the lobby cannot solve on its own. The invite link is built from
 * `location.href`; a host who opens `http://localhost:5958` while this server is *also* bound
 * to `192.168.0.238:5958` is on a loopback origin, so the lobby correctly withholds the link —
 * and correctly withholds a link that could have been made. The page cannot know the machine's
 * other address; the server can.
 *
 * **Two transports, one `lanPlaque()`.** `<meta name="tc-lan">` in the document for the page,
 * and `/__tc/lan` for anything holding a shell. The meta tag rather than a fetch, and the
 * reason is measured: a `fetch('/__tc/lan')` that 404s makes Chromium write *"Failed to load
 * resource: the server responded with a status of 404"* to the console, unsuppressably, on
 * every origin that is not this one — the deployed site, `npm run dev`, and the dev server
 * every other arm in `tools/qa-net.mjs` runs on. `lobby-console` went red on it. A fact that
 * belongs to the document should travel in the document.
 *
 * Bound to loopback the tag is **absent**, not empty, so the honest refusal is still the
 * default and is still what the gate measures.
 *
 * ## Usage
 *
 *     node tools/lib/vite-runner.mjs --port=5901 --root=/path/to/worktree \
 *          --cache-dir=/tmp/tc-vite-x --parent=<pid>
 *
 * Callers should not run this by hand. `startVite()` in `tools/lib/browser-budget.mjs` spawns
 * it, and `ensureServer()` in `tools/lib/menu-boot.mjs` goes through that.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { isLoopbackHost, lanAddress } from './lan-address.mjs';

const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
    })
);

const PORT = Number(args.get('port'));
const ROOT = args.get('root') ? path.resolve(args.get('root')) : process.cwd();
const CACHE_DIR = args.get('cache-dir') || process.env.TC_VITE_CACHE_DIR || '';
const PARENT = Number(args.get('parent') || process.ppid);
const WATCH_MS = Number(process.env.TC_VITE_WATCH_MS || 2000);
const HOST = args.get('host') || '127.0.0.1';
const RELAY_PORT = Number(args.get('relay-port') || 0);
/** `--lan=` pins the advertised address when the ranking in `lan-address.mjs` picks wrong. */
const LAN_PREFER = args.get('lan') || '';
const LAN_BIND = !isLoopbackHost(HOST);
/**
 * `<hostname>.local`, spelled once.
 *
 * `os.hostname()` on a Mac already ends in `.local` on some networks and does not on others,
 * so the suffix is stripped before it is added. Used in two places that must agree: the name
 * the plaque advertises, and the name Vite's DNS-rebinding guard will answer to.
 */
const MDNS = `${os.hostname().replace(/\.local\.?$/, '')}.local`;

if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error('vite-runner: --port=<n> is required');
  process.exit(2);
}
/*
 * The one port this must never take. 5173 is the owner's playtest server; `--strictPort` would
 * make a collision loud rather than silent, but a harness that takes it while he is playing is
 * a harness that stole the game out from under him, and loud is not the same as harmless.
 */
if (PORT === 5173 && process.env.TC_ALLOW_OWNER_PORT !== '1') {
  console.error('vite-runner: 5173 belongs to the owner\'s playtest server. Use the 5900s.');
  process.exit(2);
}

// Vite reads this through `vite.config.ts` (`cacheDir: process.env.TC_VITE_CACHE_DIR`). Setting
// it here rather than passing `cacheDir` inline keeps one spelling of the knob, which is the
// point of the long comment on that field: two agents once added two names for it.
if (CACHE_DIR) process.env.TC_VITE_CACHE_DIR = CACHE_DIR;
// Harness runs never want HMR: a file edited mid-run reloads the page and destroys the
// execution context, which surfaces as a spurious crash at a random simulation time.
if (!process.env.TC_NO_HMR) process.env.TC_NO_HMR = '1';

const { createServer } = await import('vite');

let server;
let closing = false;

const shutdown = async (why, code) => {
  if (closing) return;
  closing = true;
  try { await server?.close(); } catch { /* already down */ }
  if (why) process.stderr.write(`vite-runner: exiting (${why})\n`);
  process.exit(code ?? 0);
};

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { void shutdown(sig, 0); });
}

/**
 * `/__tc/tree` — which tree is this, actually.
 *
 * Every harness in `tools/` reuses a listener it finds on its port instead of starting one,
 * and none of them asks what that listener is serving. `qa-determinism.mjs` will happily
 * measure **another worktree's branch** and print a confident pass, and the only tell is a
 * headcount that happens to differ. With every agent in its own worktree and a hand-picked
 * port, two agents landing on one port is not hypothetical — it has already happened, and the
 * resolution that day was one agent killing the other's server.
 *
 * So the server states its identity. `startVite()` calls this before reusing anything, and
 * refuses a listener whose root is not the root it was asked for.
 */
const treeIdentity = () => ({
  tc: 'vite-runner',
  root: ROOT,
  pid: process.pid,
  port: PORT,
  host: HOST,
  parent: PARENT,
  startedAt: new Date().toISOString(),
});

/**
 * The LAN plaque. `null` on a loopback bind, which is what makes its absence meaningful.
 *
 * `relayUrl` is only stated when a relay port was given. A page that gets `relayPort: null`
 * must not go on to invent `ws://<lan>:5959` — it would be guessing at a process nobody
 * started, which is the exact shape of the wrong answer `defaultRelay()` used to give on the
 * deployed site.
 */
const lanPlaque = () => {
  if (!LAN_BIND) return null;
  const pick = lanAddress({ prefer: LAN_PREFER });
  if (!pick) return null;
  return {
    tc: 'host-lan',
    lan: pick.ip,
    iface: pick.iface,
    mdns: MDNS,
    gamePort: PORT,
    gameUrl: `http://${pick.ip}:${PORT}/`,
    relayPort: RELAY_PORT || null,
    relayUrl: RELAY_PORT ? `ws://${pick.ip}:${RELAY_PORT}` : null,
  };
};

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'error',
    server: {
      port: PORT,
      host: HOST,
      strictPort: true,
      /*
       * Vite already allows every IP-address Host header, so the IP this hands out needs no
       * entry. The `.local` name does, and it is worth having: Mac to Mac, `ernests-air.local`
       * survives a DHCP lease change and an IP address does not. The list stays explicit
       * rather than `true` — the DNS-rebinding protection is worth keeping for every name
       * that is *not* one of these two.
       */
      ...(LAN_BIND
        ? { allowedHosts: [os.hostname(), MDNS] }
        : {}),
    },
    plugins: [{
      name: 'tc-tree-identity',
      configureServer(s) {
        s.middlewares.use('/__tc/tree', (_req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(treeIdentity()));
        });
        s.middlewares.use('/__tc/lan', (_req, res) => {
          const plaque = lanPlaque();
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          if (!plaque) { res.statusCode = 404; res.end('{"error":"not serving on a LAN address"}'); return; }
          res.end(JSON.stringify(plaque));
        });
      },
      /*
       * The same plaque, in the document, for the page that must not make a request to get it.
       * `order: 'pre'` so it is in the head before any module runs; `src/ui/NetLobby.ts` reads
       * it synchronously on mount and never waits on anything.
       */
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          const plaque = lanPlaque();
          if (!plaque) return html;
          const content = JSON.stringify(plaque)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
          return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    <meta name="tc-lan" content="${content}">`);
        },
      },
    }],
  });
  await server.listen();
} catch (err) {
  process.stderr.write(`vite-runner: failed to listen on ${PORT}: ${err?.message ?? err}\n`);
  process.exit(1);
}

/*
 * `base` stays a loopback URL even on a LAN bind. Every caller of this line uses it to drive a
 * browser on *this* machine, and `0.0.0.0` is a bind address, not a destination — `fetch` to it
 * works on Linux by accident and is not a thing to rely on. The LAN address travels in `lan`,
 * beside it, for the one caller that wants to print it.
 */
process.stdout.write(
  `TC_VITE_READY ${JSON.stringify({
    port: PORT,
    base: `http://127.0.0.1:${PORT}`,
    host: HOST,
    lan: lanPlaque(),
    pid: process.pid,
    root: ROOT,
  })}\n`
);

/*
 * The parent watch. `kill(pid, 0)` sends no signal and only asks whether the process exists:
 * ESRCH means gone, EPERM means alive and owned by somebody else. A parent of 1 means we have
 * already been reparented to launchd, which is the orphan state itself.
 */
const watch = setInterval(() => {
  if (!Number.isFinite(PARENT) || PARENT <= 1) { void shutdown('no parent to watch', 0); return; }
  try {
    process.kill(PARENT, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') void shutdown(`parent ${PARENT} is gone`, 0);
    // EPERM: alive, not ours to signal. Keep serving.
  }
}, WATCH_MS);
watch.unref();

/*
 * `unref` on the watch means the timer alone will not hold the process open — the listening
 * server does that. Keeping it unref'd means that if the server ever closes for its own
 * reasons, this exits rather than spinning forever on a dead parent check.
 */
