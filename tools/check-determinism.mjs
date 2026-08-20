#!/usr/bin/env node
/**
 * Static check: non-deterministic calls in simulation code.
 *
 * `docs/ARCHITECTURE.md:74` states the rule this enforces:
 *
 *   > **Determinism rule.** Anything in `fixedUpdate` must be deterministic: no
 *   > `Math.random()`, no `Date.now()`, no reads of frame time. Use `Rng` from
 *   > `src/util/rand.ts` (`rng.fork('my-system')`).
 *
 * Until this file existed, that rule was enforced by people remembering it. There is still no
 * ESLint config, no CI and no `.github/` in this repository; the only other thing that can see
 * a determinism failure is `tools/qa-determinism.mjs`, which boots two browsers, hashes ~9,000
 * soldiers at five checkpoints, takes minutes, and tells you *that* the sim diverged rather
 * than which line did it — and only if somebody runs it.
 *
 * This runs in milliseconds with no browser, no server and no dependencies.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * ## WHAT THIS CANNOT CATCH
 *
 * Read this section before trusting a PASS. A checker that implies more coverage than it has
 * is itself an instrument that lies, and this project has shipped several of those.
 *
 * A PASS here means "no banned wall-clock or global-random call appears in the scanned
 * directories". It does **not** mean the simulation is deterministic. Every one of the
 * following is a real way this sim could diverge, and none of them is visible to a lexer:
 *
 *  1. **Identity-keyed iteration order.** `for (const x of someSet)` and `map.forEach(...)`
 *     iterate in insertion order. If the insertion order depends on allocation, on a hash of
 *     an object reference, or on anything that differs between runs, the traversal differs and
 *     so does every accumulation over it. This is the classic data-oriented-sim divergence and
 *     it is invisible here.
 *  2. **Unstable and incomplete sorts.** `Array.prototype.sort` is stable per spec since
 *     ES2019, but a comparator that returns 0 for distinct elements leaves their relative order
 *     to whatever produced the input, and a comparator without a total order (NaN, a partial
 *     `a.score - b.score` over equal scores) is undefined behaviour in practice. Sorting by a
 *     float that two runs compute 1 ULP apart flips the order outright.
 *  3. **Floating-point differences from parallelism or vectorisation.** Any reduction whose
 *     association order can change — a worker split, a SIMD path, a JIT that fuses a
 *     multiply-add on one tier and not another — produces different last bits. The pool hash
 *     in `qa-determinism.mjs` compares exact bit patterns precisely because these are real.
 *  4. **Non-deterministic *inputs* that are not calls.** `RagdollSystem.fixedUpdate` reads the
 *     camera position (`src/sim/Ragdoll.ts:268`) to pick which 40 deaths get the real solve.
 *     The camera is player input inside a fixed step. It is safe only because that system is
 *     write-isolated, and nothing here checks that write-isolation still holds.
 *  5. **Iteration over `Object.keys` of an object with numeric-like keys**, which the spec
 *     reorders into ascending integer order ahead of insertion order.
 *  6. **Async ordering.** Anything awaited inside a step resolves on microtask timing.
 *  7. **Shared mutable state reached through a module import**, and any divergence introduced
 *     outside the scanned directories — see the scope note below.
 *  8. **A banned call reached indirectly**: `const now = performance.now; now();`, a helper in
 *     `src/core` called from the sim, `globalThis['Math']['random']()`. The lexer matches
 *     source text, not values.
 *
 * The honest summary: this converts the cheapest class of future mistake from "found by an
 * end-to-end gate somebody remembered to run" into "found in milliseconds", and it would have
 * caught none of the determinism bugs this project has actually had. `qa-determinism.mjs`
 * remains the only instrument that can see the list above.
 *
 * ## Scope, and why it is a proxy
 *
 * The rule is written about `fixedUpdate`. This scans **directories** — `src/sim`, `src/ai`,
 * `src/units` — because following a call graph out of every `fixedUpdate` needs a type
 * checker, not a lexer. The proxy is wrong in both directions and both are worth knowing:
 *
 *   - *Too wide*: it also covers code in those directories that never runs in a fixed step.
 *     That is deliberate; a helper there is one call away from being used by one.
 *   - *Too narrow*: `fixedUpdate` also exists in `src/city/CitySystem.ts`, `src/ui/*`,
 *     `src/vfx/VFXSystem.ts`, `src/core/AdaptiveQuality.ts` and `src/core/Engine.ts`. Those are
 *     **not scanned**, and several of them read the clock legitimately — `AdaptiveQuality`'s
 *     entire job is to read it. Adding them would produce noise, not safety. If simulation
 *     state ever moves into one of them, add it to `SCOPE` and expect to grow the allowlist.
 *
 * ## The allowlist
 *
 * Two entries, both in `src/ai/profile.ts`, both pinned to the **exact source line**. Edit the
 * line and the allowlist stops matching and the hit reappears — an allowlist keyed on a file
 * or a line number silently covers whatever is written there next.
 *
 * Everything else clears through the profiling *pattern* rather than the allowlist: a
 * `const t0 = performance.now();` paired with a `… = performance.now() - t0` in the same file,
 * where `t0` has no other use. That pairing is the point. A timer start whose value is read
 * anywhere except as the left operand of that subtraction is a wall-clock value entering the
 * program, and it is reported.
 *
 * ## Usage
 *
 *     node tools/check-determinism.mjs             # exit 0 clean, 1 on any violation
 *     node tools/check-determinism.mjs --verbose   # also show what was cleared, and why
 *     node tools/check-determinism.mjs --json
 *     node tools/check-determinism.mjs --scope=src/sim,src/ai,src/units,src/city
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { scan, lineOf } from './lib/jsscan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const VERBOSE = args.has('verbose');
const JSON_OUT = args.has('json');
const SCOPE = (args.get('scope') ?? 'src/sim,src/ai,src/units').split(',').map((s) => s.trim());

/** The banned calls. Each is matched as source text in code — never in a comment or string. */
const BANNED = [
  { re: /\bMath\.random\s*\(/g, name: 'Math.random()', use: "Rng from src/util/rand.ts — rng.fork('my-system')" },
  { re: /\bDate\.now\s*\(/g, name: 'Date.now()', use: 'the sim clock: ctx.time.simTime' },
  { re: /\bnew\s+Date\s*\(/g, name: 'new Date()', use: 'the sim clock: ctx.time.simTime' },
  { re: /\bperformance\.now\s*\(/g, name: 'performance.now()', use: 'the profiling pair, or nothing' },
];

/**
 * Content-pinned allowlist. Two entries. `line` is the exact trimmed source line; if it stops
 * matching, the hit is reported again, which is the behaviour you want from an allowlist.
 */
const ALLOWLIST = [
  {
    file: 'src/ai/profile.ts',
    line: 'export const profileBegin = (): number => (AIProfile.enabled ? performance.now() : 0);',
    why: 'the AI profiler\'s timer start. Gated on AIProfile.enabled, which is false unless the '
      + 'F3 overlay is on, and the value is returned to profileEnd and nowhere else.',
  },
  {
    file: 'src/ai/profile.ts',
    line: 'const ms = performance.now() - t0;',
    why: 'the matching stop. `ms` is written only to AIProfile.last/avg/peak, which are read by '
      + 'the debug overlay and the harness — never by a simulation decision. The file header '
      + 'states the constraint.',
  },
];

const walk = (dir, out = []) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
};

/**
 * The profiling pattern, per file.
 *
 * A start is `const|let|var IDENT = performance.now();` — terminated, so
 * `const ms = performance.now() - t0;` is a *stop*, not a start.
 * A stop is `performance.now() - IDENT`.
 *
 * An identifier clears only if it has at least one start, at least one stop, and no other use
 * anywhere in the file. "No other use" is what makes this a check rather than a rubber stamp.
 */
const profilingPairs = (code) => {
  const starts = new Map();
  const stops = new Map();
  const add = (m, k, i) => m.set(k, [...(m.get(k) ?? []), i]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*performance\.now\(\)\s*;/g)) {
    add(starts, m[1], m.index + m[0].indexOf('performance.now'));
  }
  for (const m of code.matchAll(/\bperformance\.now\(\)\s*-\s*([A-Za-z_$][\w$]*)/g)) {
    add(stops, m[1], m.index);
  }
  const cleared = new Set();
  const paired = new Map();
  for (const [name, at] of starts) {
    if (!stops.has(name)) continue;
    const uses = [...code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    if (uses !== at.length + stops.get(name).length) continue;   // read somewhere else too
    paired.set(name, { starts: at.length, stops: stops.get(name).length });
    for (const i of [...at, ...stops.get(name)]) cleared.add(i);
  }
  return { cleared, paired };
};

const files = SCOPE.flatMap((s) => walk(path.join(ROOT, s))).sort();
const violations = [];
const allowed = [];
const clearedHits = [];
let raw = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const { code } = scan(src);                    // comments and string bodies blanked out
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const { cleared } = profilingPairs(code);

  for (const b of BANNED) {
    b.re.lastIndex = 0;
    for (const m of code.matchAll(b.re)) {
      raw++;
      const line = lineOf(src, m.index);
      const text = src.split('\n')[line - 1].trim();
      const hit = { file: rel, line, call: b.name, text, use: b.use };

      if (cleared.has(m.index)) { clearedHits.push({ ...hit, why: 'profiling pair (t0 / … - t0), no other use of the binding' }); continue; }
      const allow = ALLOWLIST.find((a) => a.file === rel && a.line === text);
      if (allow) { allowed.push({ ...hit, why: allow.why }); continue; }
      violations.push(hit);
    }
  }
}

const NOT_COVERED = [
  'identity-keyed iteration order (Set/Map insertion order, object-keyed maps)',
  'unstable or non-total sorts, and sorts keyed on a float that can differ by 1 ULP',
  'floating-point differences from parallelism, SIMD or JIT tier changes',
  'non-deterministic inputs that are not calls — Ragdoll.fixedUpdate reads the camera',
  'a banned call reached indirectly, through an alias, a helper, or globalThis',
  `fixedUpdate bodies outside the scanned scope (${SCOPE.join(', ')})`,
];

if (JSON_OUT) {
  console.log(JSON.stringify({
    scope: SCOPE, files: files.length, rawHits: raw,
    violations, allowed: allowed.length, clearedByPattern: clearedHits.length,
    notCovered: NOT_COVERED,
  }, null, 2));
  process.exit(violations.length ? 1 : 0);
}

console.log(`check-determinism — ${files.length} files under ${SCOPE.join(', ')}`);
console.log(`  ${raw} raw hits  →  ${clearedHits.length} cleared by the profiling pattern`
  + `, ${allowed.length} allowlisted, ${violations.length} violation(s)`);

if (VERBOSE) {
  for (const h of clearedHits) console.log(`  cleared    ${h.file}:${h.line}  ${h.text}`);
  for (const h of allowed) console.log(`  allowed    ${h.file}:${h.line}  ${h.text}\n             → ${h.why}`);
}

if (violations.length) {
  console.log(`\nFAIL  ${violations.length} non-deterministic call(s) in simulation code\n`);
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  ${v.call}`);
    console.log(`    ${v.text}`);
    console.log(`    use instead: ${v.use}`);
  }
  console.log('\n  If the call really is safe, add a content-pinned entry to ALLOWLIST in this');
  console.log('  file with a reason — not a line number, and not a whole file.');
} else {
  console.log('\nPASS  no banned wall-clock or global-random call in simulation code');
}

console.log('\nA PASS is narrow. Not covered:');
for (const n of NOT_COVERED) console.log(`  · ${n}`);
console.log('  tools/qa-determinism.mjs is the only instrument that can see those.');

process.exit(violations.length ? 1 : 0);
