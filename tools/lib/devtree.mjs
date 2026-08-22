/**
 * Own your port, or prove the listener on it is serving *this* tree.
 *
 * ## The hazard
 *
 * Every browser harness in this repository opens with the same four lines: try the port, and
 * if something answers, use it. That is a speed-up worth having — a warm Vite is seconds
 * instead of a minute — and it is also a silent instrument defect, because "something answers
 * on 5226" and "the tree I am measuring is on 5226" are different claims. There are eighty-odd
 * git worktrees in this checkout and they all default to the same handful of ports. An agent
 * who runs `qa-determinism` while another agent's server holds the port measures the *other*
 * agent's branch, prints somebody else's hashes, compares them against this tree's baseline,
 * and reports a drift or an all-clear with complete confidence. Nineteen orphaned Vite
 * processes were swept off this machine in one day.
 *
 * That is the same defect class as an arm pointed at the wrong battle, and this project has
 * already paid for that one: `--battle=rome` loaded the field battle and compared it against a
 * baseline key that did not exist, and passed while asserting nothing.
 *
 * ## The proof, and why it is a proof rather than a heuristic
 *
 * Vite's dev server answers `GET /<path>?raw` with `export default <JSON.stringify(source)>` —
 * the file's exact bytes as they are on the disk *the server is rooted at*, with no transform
 * applied. So the listener can be asked, file by file, what it thinks the source is, and the
 * answer can be compared with what is actually on this disk.
 *
 * The manifest is **every `.ts` under `src/`**, derived by walking the tree rather than written
 * down here. A three-file spot check would be a heuristic: two branches that happen to agree on
 * those three files pass it. Every file under `src/` is the whole of the code any of these
 * harnesses measure, and it is not expensive — measured here, 189 files verified in **209 ms**
 * against a warm server, twelve requests at a time.
 *
 * Both directions of that check were verified when it was written, which matters more than the
 * timing: against a server rooted at this worktree, all 189 files matched; against the same
 * server, the main checkout's copies mismatched on 24 files and a third worktree's on 11. It
 * discriminates between branches, not merely between repositories.
 *
 * ## What it does not catch
 *
 *  - **A tree that differs only outside `src/`** — `index.html`, `public/assets`, a
 *    `vite.config.ts` edit, `package.json` dependency drift. `vite.config.ts` is deliberately
 *    excluded because a worktree is *expected* to differ there (`TC_VITE_CACHE_DIR`), and a
 *    check that fires on the normal case is a check that gets disabled.
 *  - **A server that is mid-restart**, which will 404 the manifest and be reported as a foreign
 *    tree. The message says how to tell the difference.
 *  - **Anything at all if the harness never calls it.** This is a library; the hazard closes
 *    only in the tools that use it.
 */

import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Vite's own binary, resolved by walking up from `root`, or `null` if there is none.
 *
 * `node_modules` is not in every worktree — the one this was written in has none at all and
 * `npx` finds Vite by walking up to the main checkout — so this looks the same way rather than
 * assuming one directory down.
 */
export const resolveViteBin = (root) => {
  for (let d = root; ; d = path.dirname(d)) {
    const cand = path.join(d, 'node_modules/.bin/vite');
    if (existsSync(cand)) return cand;
    if (path.dirname(d) === d) return null;
  }
};

/**
 * Spawn a Vite dev server whose handle is *the server*, and which dies when this process does.
 *
 * **This exists because of nineteen orphans and a load average of 72.** Every harness in this
 * repository used to spawn `npx vite`, and `npx` is a wrapper *process* around Vite rather than
 * Vite itself. `server.kill('SIGTERM')` reaches the wrapper, the wrapper exits, and the actual
 * dev server keeps running and keeps the port — visible in `ps` as an `npm exec vite` parent
 * above a `node .../vite` child, and visible to the next agent as a port they cannot have and a
 * machine they cannot use. Some of the nineteen were more than a day old, and the load they
 * carried broke a gate run.
 *
 * Two changes, and the first is the one that matters:
 *
 *   - **the binary, not the wrapper**, so the returned handle is the process holding the port
 *     and every existing `server.kill('SIGTERM')` in the tree starts working as written;
 *   - **its own process group plus an `exit` hook**, so a harness that throws, is Ctrl-C'd, or
 *     calls `process.exit` in an assertion still takes its server with it. "The agent that
 *     starts a server owns killing it" has to survive the ways a script ends other than by
 *     falling off the bottom.
 *
 * Drop-in for the call it replaces: `spawn('npx', ['vite', ...args], opts)` becomes
 * `spawnVite(args, opts)`.
 */
export const spawnVite = (args, opts = {}) => {
  const root = opts.cwd ?? process.cwd();
  const bin = resolveViteBin(root);
  const proc = spawn(bin ?? 'npx', bin ? args : ['vite', ...args], { detached: true, ...opts });
  const stop = () => {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  };
  process.once('exit', stop);
  return proc;
};

/** Poll a URL until it answers or the budget runs out. */
export const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

/**
 * Every `.ts` under `src/`. Walked, never hardcoded.
 *
 * `index.html` is deliberately not in it: Vite rewrites the entry HTML on the way out (it
 * injects `/@vite/client`) even for a `?raw` request, so the served bytes never equal the
 * bytes on disk and including it would make every run report a foreign tree. That is the
 * shape of a check that gets deleted rather than fixed.
 */
const manifest = (root) => {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(root, r)).isDirectory()) walk(r);
      else if (name.endsWith('.ts')) out.push(r);
    }
  };
  walk('src');
  return out;
};

/**
 * Does the listener on `base` serve the tree at `root`?
 *
 * Returns `{ ok, checked, mismatched, missing }`. `mismatched` is the list of paths whose
 * served bytes differ from this disk's, truncated for printing by the caller.
 */
export const servesThisTree = async (base, root) => {
  const files = manifest(root);
  const mismatched = [];
  let checked = 0;

  /*
   * Bounded concurrency and a retry, and both were earned rather than anticipated.
   *
   * The first version fired all 190 requests at once with `Promise.all`. Against a *warm* server
   * that is 200 ms and fine, which is how it was measured. Against one that started four seconds
   * ago it is not: 151 of 190 came back as a `TypeError` from `fetch` — the connection, not the
   * content — and the guard reported a foreign tree and exited 2 in the middle of a gate run.
   * **A flaky guard is worse than the hazard it closes**, because the first thing anyone does
   * with one is take it out.
   *
   * So: twelve at a time, and one retry with a pause on a *transport* error only. A non-200 or a
   * content mismatch is never retried — those are answers, and asking twice would only make a
   * real mismatch slower to report.
   */
  const attempt = async (f, local) => {
    const r = await fetch(`${base}/${f}?raw`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return `${f} (HTTP ${r.status})`;
    // Vite emits `export default <json>;\n`. Substring rather than equality, so a future
    // change to the trailing semicolon or a sourcemap comment does not read as a foreign
    // tree. The JSON literal itself is exact.
    return (await r.text()).includes(JSON.stringify(local)) ? null : f;
  };

  const queue = [...files];
  const worker = async () => {
    for (;;) {
      const f = queue.pop();
      if (f === undefined) return;
      let local;
      try { local = await readFile(path.join(root, f), 'utf8'); } catch { continue; }
      checked++;
      let verdict;
      try {
        verdict = await attempt(f, local);
      } catch {
        await new Promise((r) => setTimeout(r, 400));
        try { verdict = await attempt(f, local); } catch (e) { verdict = `${f} (${e.name})`; }
      }
      if (verdict) mismatched.push(verdict);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  return { ok: mismatched.length === 0, checked, mismatched };
};

/**
 * Get a dev server on `port` that is serving `root`, or refuse to run.
 *
 * Three outcomes, and the middle one is the whole point of the file:
 *
 *   - nothing on the port → spawn one, and hand back a `kill` the caller is obliged to call;
 *   - a listener that proves it serves this tree → reuse it, and `kill` is a no-op because
 *     the process that started it owns killing it;
 *   - a listener that does not → **exit 2** with the mismatching paths named. It does not fall
 *     back to another port: a harness that silently moves ports is a harness whose printed
 *     port is a guess, and the operator needs to know another agent is holding theirs.
 */
export const ownDevServer = async ({ root, port, cacheDir = null, label = 'harness' }) => {
  const base = `http://127.0.0.1:${port}`;

  if (await waitForServer(base, 1200)) {
    const v = await servesThisTree(base, root);
    if (v.ok) {
      console.log(`• reusing the dev server on ${port}; it serves this tree`
        + ` (${v.checked} files verified)`);
      return { base, kill: () => {}, spawned: false };
    }
    console.error(`\nSomething is already serving port ${port}, and it is not this tree.`);
    console.error(`  ${v.mismatched.length} of ${v.checked} files differ from`);
    console.error(`  ${root}`);
    for (const f of v.mismatched.slice(0, 8)) console.error(`    ${f}`);
    if (v.mismatched.length > 8) console.error(`    … and ${v.mismatched.length - 8} more`);
    console.error('\n  Every harness in this repo defaults to a handful of ports and there are');
    console.error('  eighty worktrees in this checkout, so this is another agent\'s branch. Running');
    console.error('  anyway would measure their tree and report the answer as this one\'s.');
    console.error(`\n  Pick your own port:  --port=59xx`);
    console.error('  Or, if those paths are 404s rather than diffs, the server is mid-restart —');
    console.error('  wait for it and try again.');
    process.exit(2);
  }

  console.log(`• starting a dev server on ${port} for ${label}`);
  /*
   * `node_modules/.bin/vite` directly, and **not** `npx vite`, and this is the whole reason
   * nineteen orphaned Vite processes were swept off this machine in one day.
   *
   * `npx` is a process that spawns Vite as a *child*. `proc.kill('SIGTERM')` reaches the npx
   * wrapper, npx exits, and the actual server keeps the port and keeps running — visible in
   * `ps` as an `npm exec vite` parent above a `node .../vite` child, and visible to the next
   * agent as a port they cannot have. Spawning the binary means the handle this function
   * returns is the server, so killing it kills the server.
   */
  const proc = spawnVite(['--port', String(port), '--host', '127.0.0.1', '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      TC_NO_HMR: '1',
      ...(cacheDir ? { TC_VITE_CACHE_DIR: cacheDir } : {}),
    },
  });
  if (!resolveViteBin(root)) {
    console.log('  (via npx — no node_modules/.bin/vite found from here upward. The group kill');
    console.log('   still reaches its child; check `ps -ax | grep vite` if in doubt.)');
  }
  if (!(await waitForServer(base, 60000))) {
    console.error(`vite did not start on ${port}`);
    proc.kill('SIGTERM');
    process.exit(1);
  }
  // A server we started is a server we can trust, but check anyway: it costs 200 ms and it is
  // the one place the check itself gets exercised on every run.
  const v = await servesThisTree(base, root);
  if (!v.ok) {
    console.error(`the dev server this run started does not serve this tree`
      + ` (${v.mismatched.length}/${v.checked} files differ). That is an instrument fault,`
      + ` not a port collision.`);
    for (const f of v.mismatched.slice(0, 8)) console.error(`    ${f}`);
    proc.kill('SIGTERM');
    process.exit(2);
  }
  let dead = false;
  const kill = () => {
    if (dead) return;
    dead = true;
    // The group first — that is what reaches an npx wrapper's child — then the handle itself.
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  };
  /*
   * An agent that starts a server owns killing it, and "owns" has to survive the ways a harness
   * ends other than falling off the bottom: a throw, a Ctrl-C, a `process.exit` in an assertion.
   */
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });
  return { base, spawned: true, kill };
};
