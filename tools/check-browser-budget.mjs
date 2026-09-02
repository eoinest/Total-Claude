#!/usr/bin/env node
/**
 * Static check: a browser or a dev server started without going through the budget.
 *
 * ## The bug this exists for
 *
 * On 22 August 2026 this machine reached load average 160 on 16 cores with 136 concurrent
 * `vite` and `chrome-headless-shell` processes, and had to be recovered by hand. Earlier the
 * same morning nineteen orphaned dev servers were swept off it, several more than a day old.
 *
 * `tools/lib/browser-budget.mjs` caps concurrent browsers across processes and
 * `tools/lib/vite-runner.mjs` stops a terminated harness leaving a server on a port. Neither
 * helps a file that does not call them, and **303 runnable entry points in this repository
 * open a browser** — 106 in `tools/`, 172 in `tools/scratch/`, plus 23 more through
 * `pl-lib-emc.mjs`. A convention alone will not survive that, and the previous convention
 * (HANDOFF.md asking agents to use ports in the 5900s) did not: nothing enforced it, two agents
 * landed on 5901, and one killed the other's server.
 *
 * ## It is a ratchet, not a wall
 *
 * Converting 303 files in one pass would be a 303-file diff nobody can review, most of it
 * touching one-off scratch scripts that will never run again. So this check carries an
 * **allowlist of the files that were already doing it directly when the budget landed**, and
 * fails only on files that are not on it. The count can go down and cannot go up:
 *
 *   - a *new* tool that calls `chromium.launch` directly fails the check, with the one-line
 *     fix printed;
 *   - an *old* tool that gets converted can be dropped from the allowlist with `--prune`;
 *   - the allowlist is a to-do list with a number on it, which is the only kind that shrinks.
 *
 * ## Scope, stated plainly
 *
 * `tools/`, excluding `tools/scratch/` — the same scope as `tools/check-tool-args.mjs`, and for
 * the same reason: scratch is where a one-off measurement gets written in five minutes and
 * deleted the same day, and a lint that blocks that is a lint people route around. `--all`
 * includes it and prints the real total. Scratch scripts are still counted by
 * `node tools/browsers.mjs`, which reports browsers running without a slot however they started.
 *
 * ## The third rule, and why it is not ratcheted
 *
 * This check caught a new `chromium.launch()` and did not catch a `spawn()` of a script that
 * launches one. That is the exact hole the 23 Aug orphan went through: an agent ran
 * `spawn('node', ['tools/scratch/net-flake-load.mjs', '--runs=6'], { detached: true })`, was
 * stopped, and the loop — reparented to init — went on launching browsers through two `pkill`
 * sweeps. Nothing in this file had an opinion about that line, and the browsers it started were
 * inside the cap one at a time and unbounded over an afternoon.
 *
 * You cannot see, lexically, whether a spawned script opens a browser. But you can see the shape
 * that makes it survivable, and it is one token: **`detached: true`**. Both orphans in this
 * repository's history had it — the `npx vite` wrapper and the flake loop — and there is now
 * exactly one sanctioned way to write it, `spawnOwned()` in `tools/lib/process-registry.mjs`,
 * which puts the child in a guarded process group with a recorded owner and an anchor on the
 * agent. So the rule is: **`detached: true` anywhere in `tools/` outside that mechanism fails.**
 *
 * It is **not** on the ratcheted allowlist and it never will be. That list is a to-do list of 91
 * pre-existing direct launches; adding a rule's worth of new entries to a list whose whole
 * discipline is that it may only shrink would spend the discipline to buy nothing. Instead the six
 * legitimate uses are named in `DETACHED_OK` below **with a reason each**, in code, where a
 * reviewer reads them — which is a thing a JSON array of ninety-one paths cannot be.
 *
 * ## What it cannot catch
 *
 *   - A launch reached indirectly: `const L = chromium.launch; await L({})`, or a helper in a
 *     file the allowlist covers. This is a lexer, not a parser.
 *   - A `spawn` whose arguments are computed, or built in a variable and spread in.
 *   - `detached` set from a variable, or an options object built elsewhere and spread in.
 *   - A long-running child spawned **without** `detached`. It shares the caller's group, so a
 *     group kill reaches it and a terminal Ctrl-C ends it; it is a leak only if nobody signals
 *     anything, which is what `reapOwned()` and `browsers.mjs sweep` are for.
 *   - Anything outside `tools/`. `src/audio/audio-selftest.mjs` and `src/city/shoot-city.mjs`
 *     both spawn `npx vite`; they are named here and not scanned.
 *   - A tool that takes a slot and then opens *ten* browser contexts inside it. The budget
 *     counts `launch()`, not contexts, deliberately: a context is cheap, a browser is not.
 *
 * ## Usage
 *
 *     node tools/check-browser-budget.mjs            # scan tools/, fail on anything new
 *     node tools/check-browser-budget.mjs --all      # include tools/scratch/
 *     node tools/check-browser-budget.mjs --list     # every violation, allowlisted or not
 *     node tools/check-browser-budget.mjs --prune    # drop allowlist entries that are now clean
 *     node tools/check-browser-budget.mjs --json
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { lineOf, scan } from './lib/jsscan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const ALLOW_FILE = path.join(TOOLS, 'browser-budget-allow.json');

const flags = new Set(process.argv.slice(2));
const ALL = flags.has('--all');
const LIST = flags.has('--list');
const PRUNE = flags.has('--prune');
const JSON_OUT = flags.has('--json');

/** Files that *are* the budget, or that must not depend on it. */
const EXEMPT = new Set([
  'tools/lib/browser-budget.mjs',
  'tools/lib/vite-runner.mjs',
  'tools/browsers.mjs',
  'tools/check-browser-budget.mjs',
  // The bench measures what the machine can do with the budget switched off. That is its job.
  'tools/scratch/bb-bench.mjs',
]);

/**
 * The six files that may write `detached: true`, and why each one may.
 *
 * In code rather than in `browser-budget-allow.json` on purpose: this is a list that must be read
 * to be maintained, and a reason next to each entry is the only thing that stops it growing by
 * accident. Anything not here that wants to detach a child should call `spawnOwned()` instead —
 * which is one line, and gets a process group, an owner in the registry and an anchor on the agent
 * for it.
 */
const DETACHED_OK = new Map([
  ['tools/qa-net.mjs',
    'a dev server whose log this harness has to read: spawnOwned returns a handle '
    + '(pgid, done, kill, entry) and not a child, so there is no stdout to watch for the '
    + '"ready" line. Grouped on purpose, killed as a group by stop(), and cleanup() runs from '
    + 'both the ordinary exit and unhandledRejection. The residual is real and named: qa-net '
    + 'SIGKILLed leaves a healthy unowned server, which is the 23 Aug shape. Closing it '
    + 'properly means teaching spawnOwned to pipe stdio and hand the pipes back -- a change to '
    + 'the mechanism, not to this call site. Converting it without that broke the dev arm '
    + 'outright (p.stdout undefined), which is how this entry came to exist.'],
  ['tools/lib/process-registry.mjs',
    'it *is* the mechanism — spawnOwned is the one sanctioned detached spawn in the repository'],
  ['tools/lib/spawn-guard.mjs',
    'documents the flag its caller passes; the child it runs is deliberately detached: false'],
  ['tools/host-lan.mjs',
    "hands a URL to the OS opener; it starts nothing this repository owns, counts or could reap"],
  ['tools/qa-reclaim.mjs',
    'a fixture: a live process standing in a worktree, so the reclaimer can be seen to refuse it'],
  ['tools/qa-supervisor.mjs',
    'the test for this rule; it spawns deliberate orphans, kills them, and asserts they are gone'],
  ['tools/fixtures/orphan-parent.mjs',
    'the control arm — the 23 Aug bug on purpose, so the fix can be measured against something'],
]);

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!ALL && path.relative(TOOLS, p) === 'scratch') continue;
      out.push(...walk(p));
    } else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
};

/**
 * The two shapes, matched against *blanked* source so that a comment explaining the rule is
 * not a violation of it. Every file this check produced was written with `chromium.launch` in
 * its own header prose; the first version of the check failed on its own documentation.
 */
const RULES = [
  {
    id: 'detached-spawn',
    /*
     * `detached: true`, in code, anywhere but the six files above. Matched on blanked source so
     * that the paragraphs in `spawn-guard.mjs` explaining what the flag does are not violations of
     * the rule they explain — the first version of this check failed on its own documentation, in
     * this file, for the same reason.
     */
    re: /\bdetached\s*:\s*true\b/g,
    ratcheted: false,
    ok: DETACHED_OK,
    fix: "const job = spawnOwned(process.execPath, [script, ...args], { label: '<tool>', root: ROOT })"
      + "   — import { spawnOwned } from './lib/process-registry.mjs'",
    why: 'a detached child survives its parent — this is the shape of both orphans this '
      + 'repository has had, and it leaves nothing that knows the process group',
  },
  {
    id: 'direct-launch',
    ratcheted: true,
    re: /\b(?:chromium|firefox|webkit|browserType)\s*\.\s*launch(?:PersistentContext)?\s*\(/g,
    fix: "await launchBrowser({ label: '<tool>', port: PORT, root: ROOT })"
      + "   — import { launchBrowser } from './lib/browser-budget.mjs'",
    why: 'opens a browser without taking a slot, so nothing can count it',
  },
  {
    id: 'npx-vite',
    ratcheted: true,
    re: /spawn\s*\(\s*['"`]npx['"`]\s*,\s*\[\s*['"`]vite['"`]/g,
    fix: "await startVite({ port: PORT, root: ROOT, label: '<tool>' })"
      + "   — import { startVite } from './lib/browser-budget.mjs'",
    why: 'the handle is the npx wrapper, not Vite, so kill() leaves the server on the port',
  },
];

const violations = [];
for (const abs of walk(TOOLS)) {
  const rel = path.relative(ROOT, abs);
  if (EXEMPT.has(rel)) continue;
  const src = readFileSync(abs, 'utf8');
  const { code } = scan(src);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(code)) !== null) {
      violations.push({ file: rel, rule: rule.id, line: lineOf(src, m.index), text: m[0].trim() });
    }
  }
}

let allow = [];
try { allow = JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).files ?? []; } catch { /* first run */ }
const allowed = new Set(allow);

/*
 * Two populations, and only one of them is on the ratchet.
 *
 * The allowlist is the record of what was already being done directly when the budget landed, and
 * it may only shrink. A rule added afterwards has no backlog to forgive: `detached-spawn` fails on
 * anything not named in `DETACHED_OK`, today and every day, so the file allowlist cannot silently
 * absorb it — a file forgiven for calling `chromium.launch()` in 2026 is not thereby forgiven for
 * detaching a child.
 */
const ratchetedIds = new Set(RULES.filter((r) => r.ratcheted).map((r) => r.id));
const legacy = violations.filter((v) => ratchetedIds.has(v.rule));
const strict = violations.filter((v) => !ratchetedIds.has(v.rule));

const offenders = [...new Set(legacy.map((v) => v.file))].sort();
const strictOffenders = [...new Set(strict
  .filter((v) => !RULES.find((r) => r.id === v.rule).ok?.has(v.file))
  .map((v) => v.file))].sort();
const fresh = [...new Set([...offenders.filter((f) => !allowed.has(f)), ...strictOffenders])].sort();
/*
 * Only allowlist entries **inside the scanned scope** can be called stale. Without this the
 * default run — which skips `tools/scratch/` — reported all 146 scratch entries as "now clean",
 * which is the check lying about 146 files it did not look at.
 */
const inScope = (f) => ALL || !f.startsWith('tools/scratch/');
const stale = allow.filter((f) => inScope(f) && !offenders.includes(f)).sort();

if (PRUNE) {
  if (!ALL) {
    console.error('--prune needs --all, or it would drop every tools/scratch/ entry it did not scan.');
    process.exit(2);
  }
  const next = offenders.filter((f) => allowed.has(f));
  writeFileSync(ALLOW_FILE, `${JSON.stringify({
    note: 'Files that started a browser or a dev server directly when tools/lib/browser-budget.mjs '
      + 'landed on 22 Aug 2026. This list may shrink and must not grow. '
      + 'See tools/check-browser-budget.mjs.',
    generated: new Date().toISOString().slice(0, 10),
    files: next,
  }, null, 2)}\n`);
  console.log(`pruned ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'}; `
    + `${next.length} remain in ${path.relative(ROOT, ALLOW_FILE)}`);
  for (const f of stale) console.log(`  - ${f}`);
  process.exit(0);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: ALL ? 'tools/ incl. scratch' : 'tools/ excl. scratch', violations, fresh, stale }, null, 2));
  process.exit(fresh.length ? 1 : 0);
}

const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

console.log(`check-browser-budget — ${legacy.length} direct launch/spawn site(s) across `
  + `${offenders.length} files, and ${strict.length} \`detached: true\` site(s) across `
  + `${[...new Set(strict.map((v) => v.file))].length} `
  + `(${ALL ? 'tools/ including scratch/' : 'tools/ excluding scratch/'})`);
console.log('');

if (LIST) {
  for (const f of offenders) {
    console.log(`  ${allowed.has(f) ? 'known ' : 'NEW   '} ${f}`);
    for (const v of byFile.get(f)) console.log(`           :${v.line}  ${v.rule}  ${v.text}`);
  }
  console.log('');
}

if (fresh.length) {
  console.log(`FAIL  ${fresh.length} file(s) start a browser or a dev server outside the budget, or`);
  console.log('      detach a child that nothing then owns. Every agent runs these in its own');
  console.log('      worktree; on 22 Aug 2026 that reached load average 160 on 16 cores and took');
  console.log('      the machine down, and on 23 Aug a detached loop survived two pkill sweeps.\n');
  for (const f of fresh) {
    for (const v of byFile.get(f)) {
      const rule = RULES.find((r) => r.id === v.rule);
      // A file already forgiven for a ratcheted rule should not have that forgiven site reprinted
      // as though it were the new problem; only the thing that actually failed is listed.
      if (rule.ratcheted && allowed.has(f)) continue;
      console.log(`  ${f}:${v.line}`);
      console.log(`      ${v.text}   — ${rule.why}`);
      console.log(`      use: ${rule.fix}`);
    }
  }
  console.log('\n  If this really must start its own browser outside the cap, add the file to');
  console.log(`  ${path.relative(ROOT, ALLOW_FILE)} and say in the commit message why.`);
  if (fresh.some((f) => strictOffenders.includes(f))) {
    console.log('  A `detached: true` cannot be answered that way. Either call spawnOwned(), or');
    console.log('  add the file to DETACHED_OK in this check with a reason a reviewer will read.');
  }
} else {
  console.log(`PASS  ${offenders.length} known direct site(s), 0 new; `
    + `${DETACHED_OK.size} file(s) may detach a child and no others do.`);
  console.log(`      The allowlist is a to-do list: ${offenders.length} files still to convert.`);
  console.log('      Shrink it, never grow it. `--list` names them, `--prune` drops the ones');
  console.log('      that have since been converted. `detached: true` is not on that list and');
  console.log('      never joins it: see DETACHED_OK in this file, six entries with a reason each.');
}

if (stale.length) {
  console.log(`\n  ${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} `
    + 'now clean or deleted; run --prune to drop them:');
  for (const f of stale) console.log(`    ${f}`);
}

console.log('\nnot covered: an indirect launch through a variable or a helper; computed spawn');
console.log('arguments; `detached` read from a variable or spread in from an options object');
console.log('built elsewhere; a long-running child spawned without `detached`, which shares its');
console.log("caller's group and dies with it; anything outside tools/ (src/audio/audio-selftest.mjs");
console.log('and src/city/shoot-city.mjs both spawn npx vite and are not scanned); and a tool that');
console.log('takes one slot and then opens ten contexts inside it.');

process.exit(fresh.length ? 1 : 0);
