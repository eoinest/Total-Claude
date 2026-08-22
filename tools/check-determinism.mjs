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
 * ## The second check: portability, which is a different thing from reproducibility
 *
 * Everything above is about *reproducibility* — the same build, on the same machine, in the
 * same browser, replaying a battle identically. That is what the banned list protects and it
 * is a hard failure.
 *
 * `Math.sin`, `cos`, `tan`, `atan`, `atan2`, `asin`, `acos`, `exp`, `log`, `pow`, `hypot`,
 * `cbrt` and the rest of the transcendentals are **implementation-approximated** in ECMA-262:
 * the spec recommends fdlibm and requires nothing. Every one of them can return a different
 * last bit in a different engine, or in a different build of the same engine. `+ - * /` and
 * `Math.sqrt` are required to be correctly rounded, and JavaScript has no fused multiply-add,
 * so the arithmetic that ruins C++ determinism is already exact here and the hole is exactly
 * the transcendentals.
 *
 * Measured, five independent passes, Chromium / Firefox / WebKit on arm64 macOS, inputs
 * generated by integer-only arithmetic so the input bit vector is asserted identical in every
 * engine, with `sqrt` and `a*b+c` carried as controls (both clean in every pass):
 *
 *     tan    41% of inputs disagree, up to 3 ULP      sin    4%, 1 ULP
 *     hypot  37%, 2 ULP                               cos    4%, 1 ULP
 *     atan2  17%, 1 ULP                               pow    0% across these three engines —
 *     acos   17%, 1 ULP                                      but 10.5% between Chrome 130-x64
 *     exp    10%, 1 ULP                                      and Chrome 151-arm64. Not cleared.
 *     sqrt   0% (control)
 *
 * This is not a hypothetical. Two of this project's three shipped battles are affected: the
 * default field battle runs bit-identically in three engines to t+200 and forks at t+205.5 s,
 * and the Carthage assault is a *different battle in three engines before a single tick runs*,
 * a chain one pass bisected to `Math.hypot` alone in `src/city`.
 *
 * So this check reports them — and only reports them. **A portability warning is not a
 * reproducibility failure.** It never changes the exit code, for two reasons. There are
 * roughly eight hundred of these calls; removing them means vendoring a software libm, which
 * is a separate and much larger pass. And failing the build on them would block every agent
 * working in this tree tonight over a risk that has been latent for a year.
 *
 * The one substitution that is free has already been taken, and it is now taken everywhere:
 * `Math.hypot(a, b)` is `Math.sqrt(a * a + b * b)` throughout every directory this file scans —
 * `src/sim`, `src/ai`, `src/units`, `src/city`, `src/terrain` and `src/maps` — so a `hypot` hit
 * anywhere in `PORT_SCOPE` is a regression rather than a backlog item. The final 27 sites went
 * on 21 August 2026 and `tools/qa-xengine.mjs` measured what they bought: the Carthage assault
 * boots bit-identically in Chromium, Firefox and WebKit where it used to boot as three
 * different battles. It bought nothing after t+200 on the field battle, which is the other half
 * of the finding and is why `hypot` was never the whole story.
 *
 * ## Usage
 *
 *     node tools/check-determinism.mjs             # exit 0 clean, 1 on any violation
 *     node tools/check-determinism.mjs --verbose   # also show what was cleared, and why
 *     node tools/check-determinism.mjs --json
 *     node tools/check-determinism.mjs --scope=src/sim,src/ai,src/units,src/city
 *     node tools/check-determinism.mjs --portability      # list every approximated call site
 *     node tools/check-determinism.mjs --no-portability   # silence the portability section
 *     node tools/check-determinism.mjs --portability-scope=src/sim,src/city
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
/** List every approximated call site rather than counting them. */
const PORT_LIST = args.has('portability');
const PORT_OFF = args.has('no-portability');
/**
 * Deliberately wider than SCOPE, and it can be, because nothing here fails.
 *
 * The banned list is a proxy for "runs inside fixedUpdate", so widening it produces noise.
 * Portability is a proxy for "an approximated result reaches simulation state", and the
 * Carthage assault is the proof that this reaches further than `src/sim`: its t+0 divergence
 * is 361 wall-garrison men standing at identical x/z and differing in *y* by up to 3.87 mm,
 * because their foot height comes from curved-wall geometry built in `src/city`.
 */
const PORT_SCOPE = (args.get('portability-scope')
  ?? 'src/sim,src/ai,src/units,src/city,src/terrain,src/maps').split(',').map((s) => s.trim());

/** The banned calls. Each is matched as source text in code — never in a comment or string. */
const BANNED = [
  { re: /\bMath\.random\s*\(/g, name: 'Math.random()', use: "Rng from src/util/rand.ts — rng.fork('my-system')" },
  { re: /\bDate\.now\s*\(/g, name: 'Date.now()', use: 'the sim clock: ctx.time.simTime' },
  { re: /\bnew\s+Date\s*\(/g, name: 'new Date()', use: 'the sim clock: ctx.time.simTime' },
  { re: /\bperformance\.now\s*\(/g, name: 'performance.now()', use: 'the profiling pair, or nothing' },
];

/**
 * The implementation-approximated `Math` functions, worst first.
 *
 * `worst` is the highest pairwise disagreement rate measured across Chromium 151, Firefox 153
 * and WebKit 26.5 on arm64 macOS, over inputs generated by integer-only arithmetic so the
 * input bit patterns are identical in every engine. Five passes measured these; the individual
 * percentages move by a few points with the input range and the sample size (512 to 50,000),
 * but the ranking was stable in all five and `tan` and `hypot` were the worst in every one.
 *
 * `note: unmeasured` means exactly that. It is in ECMA-262's implementation-approximated set,
 * so it is a portability risk on the strength of the specification, but nobody in this project
 * has put a number on it. Do not read the absence of a number as a low number.
 */
const APPROXIMATED = [
  { fn: 'tan', worst: '41%', ulp: '3', note: 'the worst measured. Chromium vs WebKit.' },
  { fn: 'hypot', worst: '37%', ulp: '2',
    note: 'ALREADY REMOVED from every scanned directory — src/sim, src/ai, src/units, '
      + 'src/city, src/terrain and src/maps. A hit anywhere in PORT_SCOPE is a regression, '
      + 'not a backlog item. Use Math.sqrt(a * a + b * b): sqrt is one of the two things '
      + 'IEEE-754 requires correctly rounded, and it measured 0% disagreement in every engine '
      + 'tested. Measured, with tools/qa-xengine.mjs, before and after the last 27 sites went: '
      + 'the Carthage assault at t+0 went from three different pool hashes and 838 of 3,440 men '
      + 'differing between Chromium and Firefox — including 361 wall-garrison men at identical '
      + 'x/z whose foot height differed by up to 3.87 mm — to ONE hash in all three engines and '
      + 'zero men differing. It did not close the field battle\'s mid-battle fork: all three '
      + 'engines are still identical through t+200 and apart by t+250.' },
  { fn: 'atan2', worst: '17%', ulp: '1' },
  { fn: 'acos', worst: '17%', ulp: '1' },
  { fn: 'exp', worst: '10%', ulp: '1' },
  { fn: 'sin', worst: '4%', ulp: '1' },
  { fn: 'cos', worst: '4%', ulp: '1' },
  /*
   * `Math.pow(x, 2)` and `Math.pow(x, 3)` are not transcendental calls, they are `x * x` and
   * `x * x * x` written the slow and unportable way, and there are **15 of them** in the scanned
   * directories — 4 in `src/maps/carthage`, 3 in `src/maps/pydna`, and the rest across
   * `src/terrain` and `src/city`. Every one is a free removal in the same sense the `hypot`
   * substitution was free, and unlike `hypot` it does not even change the value when the
   * exponent is an exact small integer on most implementations — which is precisely why nobody
   * should assume it and why the change has to be measured rather than waved through. It is the
   * cheapest item left on this list; `tools/qa-xengine.mjs` is the instrument for it.
   */
  { fn: 'pow', worst: '0%', ulp: '0',
    note: 'zero across these three engines is luck, not a guarantee: Chrome 130-x64 vs '
      + 'Chrome 151-arm64 disagrees on 10.5% of inputs. Not cleared.' },
  { fn: 'asin', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'atan', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'log', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'log2', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'log10', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'log1p', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'expm1', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'cbrt', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'sinh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'cosh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'tanh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'asinh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'acosh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
  { fn: 'atanh', worst: '—', ulp: '—', note: 'unmeasured here; approximated per ECMA-262.' },
].map((e) => ({ ...e, re: new RegExp(`\\bMath\\.${e.fn}\\s*\\(`, 'g') }));

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

// ---------------------------------------------------------------------------
// Portability: the approximated Math calls. Counted, never failed on.
// ---------------------------------------------------------------------------
const portFiles = PORT_SCOPE.flatMap((s) => walk(path.join(ROOT, s))).sort();
/** `{ fn -> { total, byDir: { dir -> n }, sites: [...] } }` */
const port = new Map();
let portTotal = 0;
if (!PORT_OFF) {
  for (const file of portFiles) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('Math.')) continue;
    const { code } = scan(src);                  // comments and string bodies blanked out
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const dir = PORT_SCOPE.find((s) => rel.startsWith(`${s}/`)) ?? rel;
    for (const a of APPROXIMATED) {
      a.re.lastIndex = 0;
      for (const m of code.matchAll(a.re)) {
        portTotal++;
        let e = port.get(a.fn);
        if (!e) port.set(a.fn, (e = { total: 0, byDir: new Map(), sites: [] }));
        e.total++;
        e.byDir.set(dir, (e.byDir.get(dir) ?? 0) + 1);
        const line = lineOf(src, m.index);
        e.sites.push({ file: rel, line, text: src.split('\n')[line - 1].trim() });
      }
    }
  }
}
/**
 * A hit that is a regression rather than a backlog item: `hypot` was removed from these
 * four directories deliberately and there is a measurement saying the removal was free.
 */
const HYPOT_CLEARED = ['src/sim', 'src/ai', 'src/units', 'src/city'];
const hypotRegressions = (port.get('hypot')?.sites ?? [])
  .filter((s) => HYPOT_CLEARED.some((d) => s.file.startsWith(`${d}/`)));

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
    portability: {
      failsTheBuild: false,
      scope: PORT_SCOPE, files: portFiles.length, total: portTotal,
      byFunction: [...port].map(([fn, e]) => ({
        fn,
        count: e.total,
        worstDisagreement: APPROXIMATED.find((a) => a.fn === fn).worst,
        maxUlp: APPROXIMATED.find((a) => a.fn === fn).ulp,
        byDir: Object.fromEntries(e.byDir),
        ...(PORT_LIST ? { sites: e.sites } : {}),
      })),
      hypotRegressions,
    },
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

// ---------------------------------------------------------------------------
// The portability section
// ---------------------------------------------------------------------------
if (!PORT_OFF) {
  const ranked = [...port].sort((a, b) => {
    const ai = APPROXIMATED.findIndex((x) => x.fn === a[0]);
    const bi = APPROXIMATED.findIndex((x) => x.fn === b[0]);
    return ai - bi;
  });
  console.log(`\n─── portability (WARNING ONLY — never changes the exit code) ───`);
  console.log(`${portTotal} implementation-approximated Math call(s) in ${portFiles.length} files`
    + ` under ${PORT_SCOPE.join(', ')}\n`);
  console.log('  This is a PORTABILITY risk, not a REPRODUCIBILITY one. The same build in the same');
  console.log('  browser on the same machine still replays a battle bit-for-bit; that is what the');
  console.log('  check above protects and what qa-determinism.mjs proves. These calls are why the');
  console.log('  same battle in a *different* browser, or a different build of the same browser, is');
  console.log('  a different battle. ECMA-262 leaves them implementation-approximated: it recommends');
  console.log('  fdlibm and requires nothing. Only + - * / and Math.sqrt are correctly rounded.\n');

  console.log('  fn        calls   worst engine disagreement (measured, 5 passes)');
  for (const [fn, e] of ranked) {
    const a = APPROXIMATED.find((x) => x.fn === fn);
    console.log(`  ${fn.padEnd(9)} ${String(e.total).padStart(4)}    ${a.worst.padStart(4)}`
      + `${a.ulp === '—' ? '' : `, up to ${a.ulp} ULP`}`);
    console.log(`            ${[...e.byDir].map(([d, n]) => `${d} ${n}`).join('  ')}`);
    if (a.note) console.log(`            ${a.note.replace(/(.{86}) /g, '$1\n            ')}`);
  }

  if (PORT_LIST) {
    console.log('');
    for (const [fn, e] of ranked) for (const s of e.sites) console.log(`  ${fn.padEnd(6)} ${s.file}:${s.line}  ${s.text}`);
  } else {
    console.log('\n  --portability lists every site; --no-portability silences this section.');
  }

  if (hypotRegressions.length) {
    console.log(`\n  !! ${hypotRegressions.length} Math.hypot call(s) are back in `
      + `${HYPOT_CLEARED.join(', ')}, which were cleared`);
    console.log('     deliberately and measured free. Use Math.sqrt(a * a + b * b).');
    for (const s of hypotRegressions.slice(0, 20)) console.log(`       ${s.file}:${s.line}  ${s.text}`);
  }

  console.log('\n  Do not try to clear the backlog by hand. ~800 calls, and the real fix is a vendored');
  console.log('  software libm — a separate and much larger pass. What this section is for is telling');
  console.log('  the next person which functions are worst before they add another one: tan and hypot');
  console.log('  disagree on 41% and 37% of inputs, sin and cos on 4%, and sqrt on none at all.');
}

process.exit(violations.length ? 1 : 0);
