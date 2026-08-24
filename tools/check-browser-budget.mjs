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
 * ## What it cannot catch
 *
 *   - A launch reached indirectly: `const L = chromium.launch; await L({})`, or a helper in a
 *     file the allowlist covers. This is a lexer, not a parser.
 *   - A `spawn` whose arguments are computed, or built in a variable and spread in.
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
    id: 'direct-launch',
    re: /\b(?:chromium|firefox|webkit|browserType)\s*\.\s*launch(?:PersistentContext)?\s*\(/g,
    fix: "await launchBrowser({ label: '<tool>', port: PORT, root: ROOT })"
      + "   — import { launchBrowser } from './lib/browser-budget.mjs'",
    why: 'opens a browser without taking a slot, so nothing can count it',
  },
  {
    id: 'npx-vite',
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

let allowDoc = {};
try { allowDoc = JSON.parse(readFileSync(ALLOW_FILE, 'utf8')); } catch { /* first run */ }
const allow = allowDoc.files ?? [];
const allowed = new Set(allow);

const offenders = [...new Set(violations.map((v) => v.file))].sort();
const fresh = offenders.filter((f) => !allowed.has(f));
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
  /*
   * `note` and `generated` are **carried over**, not rewritten.
   *
   * They used to be re-emitted from string literals here, and the effect was that every prune
   * silently shortened the file's own explanation of itself — the second prune dropped "after
   * load average 160 on 16 cores took this machine down" and the instruction for how to shrink
   * the list, which is the only part a reader who has not read this file needs. `generated`
   * moved too, from the date the ratchet was set to the date it was last turned, which is the
   * one thing that date must not mean: the list is the *state of the tree on 22 Aug*, and a
   * moving stamp makes it impossible to tell an old entry from a new one.
   *
   * `shrunkTo` is the moving number, and it is a separate field so that it can move.
   */
  const DEFAULT_NOTE = 'Files that started a browser or a dev server directly when '
    + 'tools/lib/browser-budget.mjs landed on 22 Aug 2026, after load average 160 on 16 cores '
    + 'took this machine down. This list may shrink and must not grow. Convert a file, then '
    + 'run: node tools/check-browser-budget.mjs --prune --all. See tools/check-browser-budget.mjs '
    + 'for what counts and what it cannot see.';
  writeFileSync(ALLOW_FILE, `${JSON.stringify({
    note: allowDoc.note ?? DEFAULT_NOTE,
    generated: allowDoc.generated ?? new Date().toISOString().slice(0, 10),
    shrunkTo: { files: next.length, from: allow.length, on: new Date().toISOString().slice(0, 10) },
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

console.log(`check-browser-budget — ${violations.length} direct launch/spawn site(s) `
  + `across ${offenders.length} files (${ALL ? 'tools/ including scratch/' : 'tools/ excluding scratch/'})`);
console.log('');

if (LIST) {
  for (const f of offenders) {
    console.log(`  ${allowed.has(f) ? 'known ' : 'NEW   '} ${f}`);
    for (const v of byFile.get(f)) console.log(`           :${v.line}  ${v.rule}  ${v.text}`);
  }
  console.log('');
}

if (fresh.length) {
  console.log(`FAIL  ${fresh.length} file(s) start a browser or a dev server directly and are not`);
  console.log('      on the allowlist. Every agent runs these in its own worktree, and on 22 Aug');
  console.log('      2026 that reached load average 160 on 16 cores and took the machine down.\n');
  for (const f of fresh) {
    for (const v of byFile.get(f)) {
      const rule = RULES.find((r) => r.id === v.rule);
      console.log(`  ${f}:${v.line}`);
      console.log(`      ${v.text}   — ${rule.why}`);
      console.log(`      use: ${rule.fix}`);
    }
  }
  console.log('\n  If this really must start its own browser outside the cap, add the file to');
  console.log(`  ${path.relative(ROOT, ALLOW_FILE)} and say in the commit message why.`);
} else {
  console.log(`PASS  ${offenders.length} known direct site(s), 0 new.`);
  console.log(`      The allowlist is a to-do list: ${offenders.length} files still to convert.`);
  console.log('      Shrink it, never grow it. `--list` names them, `--prune` drops the ones');
  console.log('      that have since been converted.');
}

if (stale.length) {
  console.log(`\n  ${stale.length} allowlist entr${stale.length === 1 ? 'y is' : 'ies are'} `
    + 'now clean or deleted; run --prune to drop them:');
  for (const f of stale) console.log(`    ${f}`);
}

console.log('\nnot covered: an indirect launch through a variable or a helper; computed spawn');
console.log('arguments; anything outside tools/ (src/audio/audio-selftest.mjs and');
console.log('src/city/shoot-city.mjs both spawn npx vite and are not scanned); and a tool that');
console.log('takes one slot and then opens ten contexts inside it.');

process.exit(fresh.length ? 1 : 0);
