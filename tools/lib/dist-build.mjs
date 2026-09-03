#!/usr/bin/env node
/**
 * Is `dist/` the code that is on disk right now — and if not, make it so, out loud.
 *
 * ## Why `npm run host` needs this at all
 *
 * It serves the production build now, and a build is a *thing that goes stale*. The dev server
 * had exactly one virtue that this trades away: it could never be wrong about what the source
 * said, because it read the source on every request. A static server reads a directory that was
 * written at some point in the past, and the failure it introduces is the quiet one — the owner
 * changes a file, restarts the host, hands over the link, and both machines load yesterday's
 * game while every symptom points somewhere else.
 *
 * So the rule is: **never serve a build older than the source it was made from, and never
 * rebuild without saying so.** A person is watching this command; a seven-second pause with no
 * explanation is indistinguishable from a hang.
 *
 * ## What counts as "the source"
 *
 * Everything the build reads: `src/`, `public/`, the two HTML entries, `vite.config.ts`,
 * `tsconfig.json`, `package.json`, and `tools/optimize-assets.mjs` — which is not a build input
 * in Vite's sense but decides what `dist/assets` contains, so a change to it invalidates the
 * output just as surely.
 *
 * The fingerprint is the newest mtime **and the file count**, and the count is not redundant: a
 * deleted file leaves the newest mtime untouched, and a build that still ships a module the
 * source no longer has is exactly the stale-serve this exists to prevent. Directory mtimes are
 * included for the same reason — a rename shows up there and nowhere else. The walk is 439
 * entries and takes 50 ms cold, 6 ms once the directories are in the page cache — cheap enough
 * to do on every start rather than trusting a flag.
 *
 * ## Why it is `vite build` and not `npm run build`
 *
 * `npm run build` is `lint && tsc --noEmit && vite build && optimize-assets`. The first two are
 * gates on the *repository*, and this is a command somebody typed because they want to play a
 * game with a friend who is standing there. A lint rule about a detached spawn in an unrelated
 * tool must not be the reason two people cannot play. The two steps that actually produce the
 * bytes are run, and nothing else; `npm run build` remains the gate and is unchanged.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** The trees walked whole, and the single files that also decide the output. */
const SOURCE_DIRS = ['src', 'public'];
const SOURCE_FILES = ['index.html', 'viewer.html', 'vite.config.ts', 'tsconfig.json',
  'package.json', path.join('tools', 'optimize-assets.mjs')];

/** Where the last build recorded what it was made from. Inside `dist`, so `rm -rf dist` resets. */
export const stampPath = (root) => path.join(root, 'dist', '.tc-build.json');

/**
 * The newest mtime and the entry count across everything the build reads.
 *
 * Directories are counted and their mtimes taken: on every filesystem this runs on, adding or
 * removing a file bumps its parent's mtime, which is the only signal a rename produces.
 */
export async function sourceFingerprint(root) {
  let newest = 0;
  let entries = 0;
  const walk = async (dir) => {
    let list;
    try { list = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      entries++;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (e.isDirectory()) await walk(p);
    }
  };
  for (const d of SOURCE_DIRS) {
    const abs = path.join(root, d);
    const st = await stat(abs).catch(() => null);
    if (!st) continue;
    entries++;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    await walk(abs);
  }
  for (const f of SOURCE_FILES) {
    const st = await stat(path.join(root, f)).catch(() => null);
    if (!st) continue;
    entries++;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return { newest, entries };
}

/**
 * Whether `dist/` may be served as-is, and — when it may not — the sentence explaining why.
 *
 * `reason` is written to be printed. Every branch that returns `fresh: false` names the thing
 * that changed, because "rebuilding…" with no cause is the message that trains people to
 * distrust the rebuild.
 */
export async function distStatus(root) {
  const fp = await sourceFingerprint(root);
  const indexHtml = path.join(root, 'dist', 'index.html');
  const built = await stat(indexHtml).catch(() => null);
  if (!built) return { fresh: false, reason: 'there is no dist/index.html yet', fingerprint: fp, stamp: null };

  let stamp = null;
  try { stamp = JSON.parse(await readFile(stampPath(root), 'utf8')); } catch { /* no stamp */ }
  if (!stamp || typeof stamp.newest !== 'number') {
    return {
      fresh: false,
      reason: 'dist/ exists but was not stamped by this command, so what it was built from is unknown',
      fingerprint: fp,
      stamp: null,
    };
  }
  if (fp.newest > stamp.newest) {
    const when = new Date(fp.newest).toLocaleTimeString();
    return {
      fresh: false,
      reason: `a source file changed at ${when}, after the build at `
        + `${new Date(stamp.newest).toLocaleTimeString()}`,
      fingerprint: fp,
      stamp,
    };
  }
  if (fp.entries !== stamp.entries) {
    return {
      fresh: false,
      reason: `${Math.abs(fp.entries - stamp.entries)} file(s) were `
        + `${fp.entries > stamp.entries ? 'added' : 'removed'} since the build`,
      fingerprint: fp,
      stamp,
    };
  }
  return { fresh: true, reason: `dist/ matches the source as of ${new Date(stamp.builtAt).toLocaleTimeString()}`, fingerprint: fp, stamp };
}

/**
 * `node_modules/vite/bin/vite.js`, found by walking up from whatever `vite` resolves to.
 *
 * Not joined onto `root`: an agent worktree has no `node_modules` of its own and reaches the
 * main checkout's through node's resolution, so a path built from the root names a file that
 * does not exist. Not `require.resolve('vite/bin/vite.js')` either — vite's `exports` map does
 * not publish the bin. Copied in shape from `tools/qa-net.mjs`, which learned both of these.
 */
const viteBin = () => {
  let d = path.dirname(createRequire(import.meta.url).resolve('vite'));
  while (path.basename(d) !== 'vite' && d !== path.dirname(d)) d = path.dirname(d);
  return path.join(d, 'bin', 'vite.js');
};

/** Run one step to completion, forwarding its lines to `onLine` as they arrive. */
const run = (cmd, args, { cwd, onLine }) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const feed = (d) => {
    tail += String(d);
    const lines = tail.split('\n');
    tail = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) onLine?.(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd());
  };
  p.stdout.on('data', feed);
  p.stderr.on('data', feed);
  p.on('error', (err) => resolve({ code: 1, err: String(err?.message ?? err) }));
  p.on('close', (code) => {
    if (tail.trim()) onLine?.(tail.trim());
    resolve({ code: code ?? 1 });
  });
});

/**
 * One build at a time per checkout, and the lock is **not** inside `dist/`.
 *
 * `vite build` empties its output directory, so a lock file in there is deleted by the very
 * thing it is guarding. It lives in the temp directory instead, keyed by a hash of the absolute
 * root, which makes it per-checkout: two agent worktrees build their own `dist/` concurrently
 * and neither waits for the other, which is right, because they are different trees.
 *
 * Two processes in *one* tree is the case this exists for — the owner typing `npm run host`
 * while `tools/qa-net.mjs`'s `lan` arm is starting the same command. Two `vite build`s
 * interleaving in one output directory produce a `dist` that is neither of them, and the
 * symptom would be a served page missing a chunk with nothing in any log to explain it.
 */
const lockFile = (root) =>
  path.join(os.tmpdir(), `tc-dist-build-${createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)}.lock`);

const STALE_LOCK_MS = 10 * 60_000;

/**
 * Take the lock, or say who has it. Never blocks; the caller decides how long to wait.
 *
 * **`link()` and not `open(…, 'wx')`, and the difference is a bug this test caught.** The first
 * version wrote the holder's pid *after* creating the file, which leaves a window — microseconds
 * wide, and both processes start in the same millisecond because they are started by the same
 * command — in which the file exists and is empty. The loser read an unparseable record,
 * concluded the holder was dead, stole the lock, and both `vite build`s ran into one output
 * directory. Measured: two hosts started together, both built, and the second died with
 * `ENOTEMPTY: rmdir dist/assets/textures` because the first had just emptied it underneath.
 *
 * `writeFileSync` to a private temp name and then `linkSync` onto the lock path is atomic on
 * every filesystem this runs on: the name appears only when the contents are already complete,
 * so a reader can never see a half-written holder. The same technique, for the same reason, as
 * `linkAtomic` in `tools/lib/process-registry.mjs`.
 */
const takeLock = (root) => {
  const file = lockFile(root);
  const release = () => { try { unlinkSync(file); } catch { /* already gone */ } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }));
      linkSync(tmp, file);
      return { held: true, release };
    } catch (err) {
      if (err?.code !== 'EEXIST') return { held: false, by: null, error: String(err?.message ?? err) };
      let rec = null;
      try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { /* see below */ }
      /*
       * A holder that died mid-build leaves this behind, and a build that cannot start because
       * of a process that no longer exists is a worse failure than a rare double build. Same
       * liveness idea as the browser budget's `isStale`: a dead pid, or an age past ten minutes,
       * and the lock is taken. An *unreadable* record is now treated as held rather than dead —
       * with the atomic link above it can only mean a filesystem problem, and stealing on it is
       * exactly the mistake that produced the double build.
       */
      let alive = false;
      if (Number.isFinite(rec?.pid)) {
        try { process.kill(rec.pid, 0); alive = true; } catch (e) { alive = e?.code === 'EPERM'; }
      }
      if (!rec) {
        /*
         * Unreadable. With the atomic link above this should not happen, but a lock left by an
         * older build of this file could be empty — so fall back to the file's own mtime rather
         * than either stealing immediately (the bug) or waiting for ever (the overcorrection).
         */
        const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age <= STALE_LOCK_MS) return { held: false, by: { pid: null, at: null } };
      } else if (alive && Date.now() - rec.at <= STALE_LOCK_MS) {
        return { held: false, by: rec };
      }
      try { unlinkSync(file); } catch { /* somebody else got there first */ }
    } finally {
      try { unlinkSync(tmp); } catch { /* linked or never written */ }
    }
  }
  return { held: false, by: null };
};

/**
 * Build `dist/`, narrating it, and stamp what it was built from.
 *
 * The fingerprint is taken **before** the build rather than after, deliberately. Vite writes
 * into `dist/`, which is not walked, but `tools/optimize-assets.mjs` reads `public/` and an
 * mtime taken afterwards would also absorb any edit the owner made *during* the seven seconds
 * the build took — and then swear the result was current. Stamping the state the build actually
 * saw means a mid-build edit shows up as stale on the next start, which is the safe direction
 * to be wrong in.
 */
export async function buildDist(root, { onLine = () => {}, waitMs = 300_000 } = {}) {
  const t0 = Date.now();

  let lock = takeLock(root);
  if (!lock.held && lock.by) {
    onLine(`another build is running in this tree (pid ${lock.by.pid}); waiting for it`);
    const end = Date.now() + waitMs;
    while (Date.now() < end && !lock.held) {
      await new Promise((r) => setTimeout(r, 500));
      lock = takeLock(root);
    }
    if (!lock.held) return { ok: false, step: 'waiting for another build', ms: Date.now() - t0 };
    /*
     * The other build finished while we waited, and it may have produced exactly what we were
     * about to produce. Re-checking is cheap — one 21 ms walk — and skipping a redundant
     * five-second build is the whole reason for waiting rather than failing.
     */
    const now = await distStatus(root);
    if (now.fresh) {
      lock.release();
      return { ok: true, ms: Date.now() - t0, stamp: now.stamp, builtByAnother: true };
    }
  }

  try {
    const fp = await sourceFingerprint(root);
    const build = await run(process.execPath, [viteBin(), 'build'], { cwd: root, onLine });
    if (build.code !== 0) return { ok: false, step: 'vite build', ms: Date.now() - t0 };

    const opt = await run(process.execPath, [path.join(root, 'tools', 'optimize-assets.mjs')],
      { cwd: root, onLine });
    if (opt.code !== 0) return { ok: false, step: 'optimize-assets', ms: Date.now() - t0 };

    const stamp = { tc: 'dist-build', builtAt: Date.now(), newest: fp.newest, entries: fp.entries, node: process.version };
    await writeFile(stampPath(root), `${JSON.stringify(stamp, null, 2)}\n`);
    return { ok: true, ms: Date.now() - t0, stamp };
  } finally {
    if (lock.held) lock.release();
  }
}
