#!/usr/bin/env node
/**
 * Static check: an options object sitting in an argument position.
 *
 * ## The bug this exists for
 *
 * Playwright's signature is `waitForFunction(pageFunction, arg, options)`. Write
 *
 *     await page.waitForFunction(() => window.__game?.ready === true, { timeout: 180000 });
 *
 * and the object is passed to the page function as its *argument*. No error, no warning: the
 * options are simply never read, and the 30-second default applies. Across this tool directory
 * that turned every intended 120–300 s boot wait into a 30 s one, and probes spent months
 * reporting "the app never became ready" for an app that was merely slow under load.
 *
 * ## The reason it is a *tool* and not a commit
 *
 * It was already fixed once. `60a3f9c`'s message says nineteen tools; its diff converts 17 call
 * sites in 14 files, and the difference is not sloppiness — it is that the fix was verified
 * with a line-grep, and a line-grep cannot see this:
 *
 *     await tp.waitForFunction(() => window.__game && window.__game.ready === true,
 *       { timeout: 180000 });
 *
 * A single-line grep for `waitForFunction(.*{ *timeout` finds 3 of the sites that were still
 * broken afterwards. This check matches parentheses instead, so a call spanning any number of
 * lines is counted correctly. **The check is the deliverable; the fix is the easy part.**
 *
 * ## What counts as a violation
 *
 * Exactly one shape: a call with **two** arguments whose second is an object literal carrying a
 * top-level key from the method's options set. Three-argument calls are correct regardless of
 * what stands in the argument slot — `null`, `undefined` and `{}` are all fine there, and a
 * count that flags them is wrong. `docs/tech/TOOLING.md` published a list of 19; eight of the
 * fourteen it named already passed three arguments. The true count was **9**. See `--explain`.
 *
 * ## What it does not catch
 *
 *   - A timeout passed correctly and then set to a wrong *value*.
 *   - The same argument-position mistake on an API not in `SIGNATURES` below. Adding one is a
 *     single table entry; only the methods listed there are checked.
 *   - Anything computed: `page.waitForFunction(fn, ...args)` or an options object built in a
 *     variable and spread in. A lexer cannot follow a value.
 *   - Any file outside `tools/`.
 *
 * ## Usage
 *
 *     node tools/check-tool-args.mjs             # scan, list violations, exit 1 if any
 *     node tools/check-tool-args.mjs --fix       # insert `null, ` in the argument position
 *     node tools/check-tool-args.mjs --all       # include tools/scratch/
 *     node tools/check-tool-args.mjs --json      # machine-readable
 *     node tools/check-tool-args.mjs --explain   # why three-argument calls are not violations
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findCalls } from './lib/jsscan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const flags = new Set(process.argv.slice(2));
const FIX = flags.has('--fix');
const ALL = flags.has('--all');
const JSON_OUT = flags.has('--json');

/**
 * The APIs whose third parameter is an options bag and whose second is a value handed to the
 * page. Add a row to extend the check; nothing else needs to change.
 */
const SIGNATURES = [
  {
    method: 'waitForFunction',
    optionKeys: ['timeout', 'polling'],
    correct: 'waitForFunction(fn, null, { timeout: N })',
  },
];

if (flags.has('--explain')) {
  console.log(`
Three-argument calls are correct. Playwright's signature is (pageFunction, arg, options); the
argument slot may hold anything, and this tree uses null, undefined and {} interchangeably in
it. Only a two-argument call whose second argument is an options literal is broken.

docs/tech/TOOLING.md listed 19 sites at 6698e19 — 14 named in tools/, 5 unnamed in scratch/.
Eight of the fourteen already passed three arguments and were never broken:

  banner-check.mjs:715        undefined in the arg slot
  grab-video-frames.mjs:206   a real argument, t, in the arg slot
  matchup.mjs:413             undefined
  probe-melee.mjs:124         undefined
  probe-meleegeom.mjs:286     undefined
  probe-shimmer.mjs:70        undefined
  probe-siege.mjs:300         {}
  probe-wall.mjs:157          {}

They were counted as broken because the counter tested "is the second argument the literal
null?" rather than "is the options object in the argument position?". The true totals at
3f4c203, matched two independent ways: 160 call sites, 9 violations — 6 in tools/ and 3 under
tools/scratch/. A checker that is wrong in the safe direction is still a checker that is wrong,
and a list of 19 with 8 non-bugs in it teaches the next reader to distrust the other 11.
`.trim());
  process.exit(0);
}

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || (!ALL && p.endsWith(`${path.sep}scratch`))) continue;
      walk(p, out);
    } else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
};

/** Does this argument text look like an options literal for the given method? */
const isOptionsLiteral = (code, keys) => {
  if (!code.startsWith('{') || !code.endsWith('}')) return false;
  const inner = code.slice(1, -1);
  return keys.some((k) => new RegExp(`(^|[{,\\s])${k}\\s*:`).test(inner));
};


/** Every violation in one file, in source order. */
const scanFile = (src) => {
  const out = [];
  for (const sig of SIGNATURES) {
    if (!src.includes(`.${sig.method}(`)) continue;
    for (const c of findCalls(src, sig.method)) {
      if (c.args.length === 2 && isOptionsLiteral(c.args[1].code, sig.optionKeys)) {
        out.push({ sig, call: c });
      }
    }
  }
  return out.sort((a, b) => a.call.index - b.call.index);
};

/** Total call sites, for the denominator — a violation count with no denominator is a rumour. */
const countCalls = (src) =>
  SIGNATURES.reduce((n, sig) => n + (src.includes(`.${sig.method}(`) ? findCalls(src, sig.method).length : 0), 0);

const files = walk(path.join(ROOT, 'tools')).sort();
const violations = [];
let checked = 0;
let fixed = 0;

for (const file of files) {
  let src = readFileSync(file, 'utf8');
  checked += countCalls(src);
  let found = scanFile(src);

  if (FIX && found.length) {
    // Back to front, so every earlier offset stays valid. The separator between the first and
    // second argument is rewritten whole — comma, whatever whitespace was there, and all — so
    // the result reads `fn, null, { … }` rather than `fn,null,  { … }`. A fixer that leaves
    // the tree looking machine-edited invites somebody to undo it by hand.
    for (let k = found.length - 1; k >= 0; k--) {
      const { index: argAt, commaIndex } = found[k].call.args[1];
      const gap = src.slice(commaIndex + 1, argAt);   // the whitespace as it was written
      const sep = gap.includes('\n') ? `, null,${gap}` : ', null, ';
      src = src.slice(0, commaIndex) + sep + src.slice(argAt);
    }
    writeFileSync(file, src);
    fixed += found.length;
    found = scanFile(src);                    // report only what survived the fix
  }

  for (const { sig, call } of found) {
    violations.push({
      file: path.relative(ROOT, file),
      line: call.line,
      method: sig.method,
      snippet: call.text.replace(/\s+/g, ' ').slice(0, 96),
      correct: sig.correct,
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ checked, fixed, violations }, null, 2));
} else {
  const scope = ALL ? 'tools/ including scratch/' : 'tools/ excluding scratch/';
  console.log(`check-tool-args — ${checked} call sites across ${files.length} files (${scope})`);
  if (FIX) console.log(`--fix: inserted \`null, \` at ${fixed} site(s)`);
  if (!violations.length) {
    console.log(`\nPASS  ${checked - fixed} already correct, 0 options objects in an argument position`);
  } else {
    console.log(`\nFAIL  ${violations.length} options object(s) in an argument position\n`);
    const w = Math.max(...violations.map((v) => `${v.file}:${v.line}`.length));
    for (const v of violations) console.log(`  ${`${v.file}:${v.line}`.padEnd(w)}  ${v.snippet}`);
    console.log(`\n  correct form: ${SIGNATURES[0].correct}`);
    console.log('  run with --fix to insert `null, ` at each site');
  }
  console.log('\nnot covered: a correct timeout set to a wrong value; APIs outside the SIGNATURES');
  console.log('table; spread or computed arguments; anything outside tools/.');
}

process.exit(violations.length ? 1 : 0);
