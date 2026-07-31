#!/usr/bin/env node
/**
 * Typecheck gate that cannot report a false pass.
 *
 * `npx tsc --noEmit` goes **blind to every semantic error in the program** the moment any one
 * file has a syntax error. Verified empirically rather than assumed: a lone
 * `const x: number = "s"` reports one error; add a second file containing
 * `export function broken( {` and the count of semantic errors drops to zero, with only the
 * syntax error listed.
 *
 * That is a live hazard whenever more than one agent is editing the tree, because the usual
 * reflex on seeing an unrelated file's error is to filter it out — `tsc --noEmit | grep -v
 * TheirFile.ts` — and a filtered syntax error looks exactly like a clean build. This session
 * did that at least once and reported "clean" on the strength of it. One workstream lost hours
 * to a silently blind typecheck for the same reason.
 *
 * So this classifies rather than counts:
 *
 *   PASS          no diagnostics at all
 *   FAIL          semantic errors, and no syntax error to have masked them
 *   INCONCLUSIVE  at least one syntax error (TS1xxx), so semantic analysis did not run
 *                 program-wide and a "clean" result would mean nothing
 *
 * Exit codes: 0 pass, 1 fail, 2 inconclusive. Treat 2 as "you do not know yet", never as
 * success — that distinction is the entire point of the file.
 *
 *   node tools/typecheck.mjs            # whole program
 *   node tools/typecheck.mjs --mine=src/units    # only fail on errors under a path
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const MINE = args.get('mine') ?? null;

const run = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
});
const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`
  .split('\n')
  .filter((l) => /error TS\d+/.test(l));

/** TS1xxx is the parser's range; anything else came from the checker. */
const isSyntax = (l) => /error TS1\d{3}:/.test(l);
const fileOf = (l) => (l.match(/^([^(]+)\(/) ?? [, ''])[1];

const syntax = lines.filter(isSyntax);
const semantic = lines.filter((l) => !isSyntax(l));

const show = (arr, n = 12) => arr.slice(0, n).map((l) => `  ${l}`).join('\n')
  + (arr.length > n ? `\n  ... and ${arr.length - n} more` : '');

if (syntax.length) {
  console.log(`INCONCLUSIVE — ${syntax.length} syntax error(s); semantic analysis did not run program-wide.`);
  console.log(show([...new Set(syntax)]));
  const files = [...new Set(syntax.map(fileOf))].filter(Boolean);
  console.log(`\nFiles that do not parse: ${files.join(', ')}`);
  console.log('A clean semantic result is impossible until these parse. Do NOT read this as a pass,');
  console.log('and do not filter these lines out to make the output look green.');
  process.exit(2);
}

if (!semantic.length) {
  console.log('PASS — no diagnostics.');
  process.exit(0);
}

const mine = MINE ? semantic.filter((l) => fileOf(l).startsWith(MINE)) : semantic;
const theirs = MINE ? semantic.filter((l) => !fileOf(l).startsWith(MINE)) : [];

if (MINE && !mine.length) {
  console.log(`PASS for ${MINE} — ${theirs.length} error(s) elsewhere, none under your path.`);
  console.log(show([...new Set(theirs)], 6));
  console.log('\nNote these are real semantic errors, not masked ones: no file failed to parse.');
  process.exit(0);
}

console.log(`FAIL — ${mine.length} semantic error(s)${MINE ? ` under ${MINE}` : ''}.`);
console.log(show(mine));
if (theirs.length) console.log(`\n(${theirs.length} further error(s) outside ${MINE}.)`);
process.exit(1);
