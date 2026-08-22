#!/usr/bin/env node
/**
 * QA: does this battle run the same way in three browser engines?
 *
 * `docs/MULTIPLAYER.md` §3 Stage 0 item 5. It is the arm that turns this project's central
 * multiplayer finding from an anecdote into a standing measurement, and until now the finding
 * lived in a document: three engines run the default field battle bit-identically through
 * every pinned checkpoint and fork at **t+205.5 s**, while the Carthage assault is a *different
 * battle in three engines before a single tick runs*.
 *
 * ## This is not part of the per-commit gate, on purpose
 *
 * `tools/qa-determinism.mjs` answers "does this battle replay" and "is it the battle that was
 * pinned". Both are reproducibility questions and both are things a commit can break. This
 * answers a *portability* question, and the thing that moves it is usually not a commit — it is
 * a browser update. Eleven of twelve `Math` functions changed between Chrome 149 and 151 with
 * no change to this tree at all. An arm that reds every agent's gate the day Firefox ships a
 * point release is an arm that gets commented out, and this project has already lost a year to
 * a gate nobody wanted to run.
 *
 * So it is its own tool, with its own exit code, run deliberately. Run it when you are asking
 * whether cross-machine play is possible, after any change to `src/terrain`, `src/maps` or
 * `src/city`, and before pricing anything in Stage 3.
 *
 * ## How it is kept from passing vacuously
 *
 * This project's most expensive recurring failure is a check that compares something against
 * itself. The most recent instance was in the sibling of this file: `--battle=rome` appended a
 * meaningless query parameter, loaded the field battle, looked up a baseline key that did not
 * exist and exited 0. Five of the six assertions below exist only so that the sixth means
 * something, and each one can fail on its own:
 *
 *   1. **`--battle` names a battle.** Every segment must be `key=value` and every key must be
 *      one `src/` actually reads. `--battle=carthage` exits 2 rather than measuring the field
 *      battle under Carthage's name. (Duplicated from `qa-determinism.mjs` deliberately — see
 *      the note on `PARAM_KEYS`.)
 *   2. **The dev server serves *this* tree.** `tools/lib/devtree.mjs` verifies every `.ts`
 *      under `src/` against the listener before reusing it. Eighty worktrees in this checkout
 *      all default to the same few ports; a harness that measures another agent's branch and
 *      reports the answer as this one's is the same defect class as an arm pointed at the wrong
 *      battle.
 *   3. **Each page is the engine it was asked for**, established by *feature detection rather
 *      than the user-agent string* — Gecko exposes `mozInnerScreenX`, JavaScriptCore exposes
 *      `webkitConvertPointFromNodeToPage`, and Blink is the one that is neither and reports
 *      `navigator.vendor === 'Google Inc.'`. Exactly one must be true and it must be the one
 *      asked for. Playwright silently falling back, or a channel resolving to a Chromium build,
 *      would otherwise be three loads of one engine reporting perfect agreement.
 *   4. **The three engines' libms really do disagree.** A page-side probe evaluates fourteen
 *      implementation-approximated `Math` functions over inputs built from integers with `+ - *
 *      /` only — all four correctly rounded per IEEE-754, so the input bit vector is identical
 *      in every engine *by construction* — and digests the exact float64 bits of the results.
 *      At least one engine pair must differ on at least one function. If all three digests
 *      match, these are not three libms and nothing follows from the battle hashes matching.
 *   5. **The probe's own controls hold.** The input digest, `Math.sqrt` and `a * b + c` must be
 *      **identical in every engine**. `sqrt` is one of the two operations IEEE-754 requires
 *      correctly rounded and JavaScript has no fused multiply-add. If a control moves, the
 *      inputs were not identical and assertion 4's disagreement is the instrument, not the
 *      engine.
 *   6. **A repeat load of the reference engine is bit-identical to itself.** Chromium is loaded
 *      twice and the second run is a control, not a datum. Without it, any cross-engine
 *      difference reported here could be run-to-run noise in the harness — and it has been
 *      before: a rAF race made t+0 unstable in the sibling tool. If the control run diverges,
 *      the cross-engine verdict is **void** and the tool says so instead of reporting it.
 *
 * Then the finding: the pool hash, `uf64`, `uctl`, `count`, `alive` and unit count, compared
 * per checkpoint between each engine and the reference. Exact bits. The discrete marks
 * (`count`, `alive`, `units`, `uctl` — the roster and what the battle decided) are reported and
 * ruled on **separately** from the continuous ones (`hash`, `uf64`), because the difference
 * between them is the difference between "a different army" and "the same army, arithmetic one
 * ULP apart", and that distinction is the whole content of §1.2.
 *
 * ## The localiser, which is why this file is longer than twenty lines
 *
 * §3 estimates "roughly twenty lines". Twenty lines gets a red light. What is actually wanted
 * from a cross-engine run is *which men, and by how much*, because the documented Carthage
 * split has two disjoint populations with different causes: 340 attacking infantry 1–2 float32
 * ULP apart in x/z, and 361 wall-garrison men at **identical x/z** differing in **y** by up to
 * 3.87 mm because their foot height comes from curved-wall geometry. The pool hash covers
 * x/z/state/hp and cannot see the second population at all. So the localiser dumps y as well,
 * splits the differing men into an x/z group and a y-only group, and reports the worst gap in
 * both float32 ULP and metres for each. That is the measurement the Stage 0 decision point
 * turns on, and no hash can produce it.
 *
 * ## Usage
 *
 *     node tools/qa-xengine.mjs                                  # field battle, all seven checkpoints
 *     node tools/qa-xengine.mjs --at=0                           # the cheap t+0 read
 *     node tools/qa-xengine.mjs --battle='map=carthage&scenario=assault'
 *     node tools/qa-xengine.mjs --battle='map=campus-martius&scenario=assault'
 *     node tools/qa-xengine.mjs --engines=chromium,webkit        # skip one
 *     node tools/qa-xengine.mjs --port=5902 --json=/tmp/x.json
 *     node tools/qa-xengine.mjs --libm-only    # every build in the Playwright cache, no game
 *
 * Quote the `--battle` value or the shell backgrounds on the `&`. Confirm every run by
 * headcount: **field battle 8,632 / Rome 3,074 / Carthage 3,440.**
 *
 * Exit 0 identical, 1 divergent, 2 instrument fault (a vacuity assertion failed).
 */

import { chromium, firefox, webkit } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ownDevServer } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

/** Not 5173 — that is the owner's. Not 5226 either — that is `qa-determinism`'s. */
const PORT = Number(args.get('port') ?? 5901);
const CHECKPOINTS = (args.get('at') ?? '0,30,90,150,200,250,400')
  .split(',').map(Number).filter((n) => Number.isFinite(n));
const JSON_OUT = args.get('json') ?? null;
const QUALITY = args.get('quality') ?? 'high';

const ENGINE_TYPES = { chromium, firefox, webkit };
const ENGINES = (args.get('engines') ?? 'chromium,firefox,webkit').split(',').map((s) => s.trim());
/** The engine everything else is compared against, and the one loaded twice as a control. */
const REFERENCE = ENGINES[0];

// ---------------------------------------------------------------------------
// Assertion 1 — `--battle` names a battle
// ---------------------------------------------------------------------------
/*
 * The same two conditions `qa-determinism.mjs` applies, and the duplication is deliberate: a
 * shared module would be one more thing for a merge to silently disable, and the failure it
 * prevents is worth ten lines twice. If this list and that one ever disagree, the *union* is
 * right — a key either appears in a `params.get`/`params.has` call under `src/` or it does not.
 */
const PARAM_KEYS = new Set([
  'autoplay', 'battle', 'deploy', 'difficulty', 'enemy', 'from', 'h', 'harness', 'map',
  'menu', 'overlay', 'procedural', 'quality', 'replay', 'scenario', 'w',
]);
const BATTLE = args.get('battle') ?? '';
if (BATTLE) {
  const segs = BATTLE.split('&').map((s) => s.trim()).filter(Boolean);
  const bad = segs.filter((s) => !s.includes('=') || !PARAM_KEYS.has(s.split('=')[0]));
  if (!segs.length || bad.length) {
    console.error(`--battle=${BATTLE} is not a battle.\n`);
    console.error(bad.length
      ? `  ${bad.length} segment(s) the app does not read: ${bad.join(', ')}`
      : '  empty value');
    console.error('\n  The value is appended verbatim as query parameters, so a short name loads');
    console.error('  the default field battle and reports it under another battle\'s name. The');
    console.error('  three real invocations are:\n');
    console.error('    node tools/qa-xengine.mjs');
    console.error("    node tools/qa-xengine.mjs --battle='map=campus-martius&scenario=assault'");
    console.error("    node tools/qa-xengine.mjs --battle='map=carthage&scenario=assault'\n");
    console.error('  Confirm by headcount: field battle 8,632 / Rome 3,074 / Carthage 3,440.');
    process.exit(2);
  }
}
const BATTLE_KEY = BATTLE
  ? BATTLE.split('&').map((s) => s.trim()).filter(Boolean).sort().join('&')
  : 'default';
const EXTRA = BATTLE ? `&${BATTLE}` : '';

if (!CHECKPOINTS.length) {
  console.error('--at is empty. There is nothing to compare and a green light would be a lie.');
  process.exit(2);
}
for (const e of ENGINES) {
  if (!ENGINE_TYPES[e]) {
    console.error(`unknown engine '${e}'. Known: ${Object.keys(ENGINE_TYPES).join(', ')}.`);
    process.exit(2);
  }
}
if (ENGINES.length < 2) {
  console.error('--engines needs at least two engines. One engine compared with itself is'
    + ' `qa-determinism.mjs`, which already exists and is faster.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The page-side probes
// ---------------------------------------------------------------------------
/*
 * Everything below runs in the page. Nothing here recomputes a battle hash — those come from
 * `window.__game.hashes()`, which is `src/sim/stateHash.ts` in the product, so this tool cannot
 * drift from `qa-determinism.mjs` by copying forty lines slightly wrong.
 */
const PROBES = `
  /*
   * Which engine is this, established without believing the user-agent string.
   *
   * Measured in all three, arm64 macOS, Playwright 1.62: Gecko is the only one with
   * \`mozInnerScreenX\`; JavaScriptCore is the only one that still exposes
   * \`webkitConvertPointFromNodeToPage\` (Blink removed it); headless Chromium reports
   * \`navigator.vendor === 'Google Inc.'\` and neither of the other two markers. The three
   * predicates are mutually exclusive and the caller requires exactly one to be true.
   */
  window.__engineId = () => {
    const gecko = 'mozInnerScreenX' in window;
    const jsc = typeof window.webkitConvertPointFromNodeToPage === 'function';
    const blink = !gecko && !jsc && navigator.vendor === 'Google Inc.';
    return {
      firefox: gecko, webkit: jsc, chromium: blink,
      ua: navigator.userAgent, vendor: navigator.vendor,
    };
  };

  /*
   * The libm fingerprint, and its controls.
   *
   * Inputs are built from integers with + - * / only. All four are required to be correctly
   * rounded by IEEE-754 and JavaScript has no fused multiply-add, so the input bit vector is
   * identical in every engine by construction rather than by hope — and \`inputs\` below is
   * digested and compared so that "by construction" is also checked.
   *
   * The digest is Math.imul, xor and shift over the exact float64 bits of each result. Those
   * are bit-portable operations: \`src/util/rand.ts\` is built from the same three and was
   * bit-exact in every engine every pass tested.
   */
  window.__libm = () => {
    const N = 4096;
    const dv = new DataView(new ArrayBuffer(8));
    const mix = (h, v) => {
      dv.setFloat64(0, v);
      for (let b = 0; b < 8; b++) h = Math.imul(h ^ dv.getUint8(b), 0x01000193) >>> 0;
      return h >>> 0;
    };
    const digest = (f) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < N; i++) h = mix(h, f(i));
      return h.toString(16).padStart(8, '0');
    };
    // Two independent input streams, both exact-integer in origin.
    const a = (i) => (i * 7919 % 100003) / 4096;      // 0 .. ~24.4
    const b = (i) => (i * 104729 % 99991) / 8192 - 6; // -6 .. ~6.2
    const fns = {
      tan: (i) => Math.tan(b(i)), hypot: (i) => Math.hypot(a(i), b(i)),
      atan2: (i) => Math.atan2(b(i), a(i) + 1), acos: (i) => Math.acos(b(i) / 6.5),
      asin: (i) => Math.asin(b(i) / 6.5), exp: (i) => Math.exp(b(i)),
      sin: (i) => Math.sin(a(i)), cos: (i) => Math.cos(a(i)),
      pow: (i) => Math.pow(a(i) + 1, b(i) / 3), log: (i) => Math.log(a(i) + 1),
      log1p: (i) => Math.log1p(a(i)), expm1: (i) => Math.expm1(b(i)),
      atan: (i) => Math.atan(b(i)), cbrt: (i) => Math.cbrt(b(i)),
    };
    const out = {};
    for (const k of Object.keys(fns)) out[k] = digest(fns[k]);
    return {
      fns: out,
      controls: {
        inputs: digest((i) => a(i) * 1e6 + b(i)),
        sqrt: digest((i) => Math.sqrt(a(i) + 1)),
        fma: digest((i) => a(i) * b(i) + a(i)),
      },
    };
  };

  /*
   * The pool dump for the localiser. \`y\` is here and is not in the hash: the documented
   * Carthage cross-engine split is 361 men at identical x/z whose *foot height* differs,
   * and the pinned hash covers x/z/state/hp only, so without y this tool could report a
   * divergence it cannot describe.
   */
  /*
   * The unit-layer dump. \`UnitGroupState\` is plain float64 integrated in place with no
   * quantisation step, so it is the layer that diverges first and the layer the pool hash
   * cannot see — and after the \`hypot\` sweep it is the *only* layer left diverging on the
   * Carthage assault, which makes naming the field the whole of the remaining question.
   * The field lists come from \`window.__game.hashFields()\`, so the localiser and the hash
   * can never be reading different sets.
   */
  window.__unitDump = () => {
    const f = window.__game.hashFields();
    return {
      fields: { f64: f.f64.slice(), ctl: f.ctl.slice() },
      units: window.__game.battle.units.map((u) => ({
        id: u.id, typeId: u.typeId,
        f64: f.f64.map((k) => u[k]),
        ctl: f.ctl.map((k) => u[k]),
        // \`uf64\` hashes the waypoint queue and \`uctl\` hashes the member list, and neither is
        // in \`hashFields()\`. Leaving them out of the dump was a localiser that could report
        // "0 fields differ" beside a hash that did differ — the exact shape of instrument this
        // project keeps having to fix. Measured: on Rome and Carthage after the float32
        // firewall landed, the whole of the remaining t+0 cross-engine difference was here.
        waypoints: (u.waypoints ?? []).slice(),
        members: (u.members ?? []).slice(),
      })),
    };
  };

  window.__poolXYZ = () => {
    const p = window.__game.battle.pool;
    return {
      count: p.count,
      x: Array.from(p.x.subarray(0, p.count)),
      y: Array.from(p.y.subarray(0, p.count)),
      z: Array.from(p.z.subarray(0, p.count)),
      state: Array.from(p.state.subarray(0, p.count)),
      hp: Array.from(p.hp.subarray(0, p.count)),
      unitId: Array.from(p.unitId.subarray(0, p.count)),
    };
  };
`;

/**
 * float64 ULP distance, for the unit layer, which is not quantised anywhere.
 *
 * Sign-magnitude to a monotone integer key so the count of representable doubles between two
 * values is a subtraction. -0 and +0 both map to 0: they are the same point on the number line
 * and reporting them 2^63 apart would be an instrument defect rather than a finding.
 */
const DV = new DataView(new ArrayBuffer(8));
const f64Key = (v) => {
  DV.setFloat64(0, v);
  const u = DV.getBigUint64(0);
  return u & (1n << 63n) ? -(u & ((1n << 63n) - 1n)) : u;
};
const f64Ulp = (a, b) => {
  if (Object.is(a, b)) return 0n;
  if (Number.isNaN(a) || Number.isNaN(b)) return -1n;
  const d = f64Key(a) - f64Key(b);
  return d < 0n ? -d : d;
};

/** float32 ULP distance, for a pool field that is stored as float32. */
const F32 = new Float32Array(1);
const I32 = new Int32Array(F32.buffer);
const f32Key = (v) => { F32[0] = v; return I32[0] < 0 ? -(I32[0] & 0x7fffffff) : I32[0]; };
const f32Ulp = (a, b) => Math.abs(f32Key(a) - f32Key(b));

// ---------------------------------------------------------------------------
// --libm-only: the build matrix, which is what actually prices the restriction
// ---------------------------------------------------------------------------
/*
 * `docs/MULTIPLAYER.md` §1.5 says a routine Chrome update is as dangerous as a different
 * browser, and §2 rests on it: the restriction a same-engine realtime product would have to
 * ship is not "same browser", it is **same patch build**, and two friends will routinely not
 * have it. That claim was measured once, on 512 inputs, and reported as a count of changed
 * functions. It is the sentence the whole "do not build realtime yet" argument leans on and
 * nobody has re-run it.
 *
 * This mode runs the libm fingerprint and nothing else — `about:blank`, no dev server, no game,
 * a second or two per build — across every browser sitting in the Playwright cache. It answers
 * the pricing question directly: between two adjacent Chromium releases, how many of the
 * fourteen approximated functions move? That number *is* the probability that a pairing which
 * worked last month stops working, because one changed function is enough.
 *
 * Three things keep it honest:
 *
 *   - **every launched build must report a distinct version string.** Two cache entries that
 *     resolve to the same binary would otherwise read as "no change between releases", which is
 *     the good news this mode could most easily fabricate.
 *   - **the controls must hold across every build**: `inputs`, `sqrt` and `a * b + c`. If the
 *     input digest moves between two Chromium revisions then the probe is not feeding them the
 *     same numbers and none of the counts mean anything.
 *   - **a build that fails to launch is named and excluded**, never silently skipped. An old
 *     Chromium under a new Playwright driver is exactly the thing that fails quietly.
 *
 * It is a strictly weaker instrument than two machines (§7.1): same OS, same loader, same
 * hardware. It measures the *libm*, not the pairing. Read it as a lower bound on how often a
 * pairing breaks, never as the whole answer.
 */
const LIBM_ONLY = args.get('libm-only') === 'true';
if (LIBM_ONLY) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  const targets = [
    { label: 'firefox', type: firefox },
    { label: 'webkit', type: webkit },
  ];
  let revs = [];
  try {
    revs = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => Number(d.slice('chromium-'.length)))
      .sort((a, b) => a - b);
  } catch { /* no cache */ }
  /*
   * The cache's directory layout is not stable across Playwright versions, and guessing one
   * path silently finds one build out of six. Measured here: `chromium-1140` is
   * `chrome-mac/Chromium.app/Contents/MacOS/Chromium` and `chromium-1237` is
   * `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
   * So the `.app` is *found* rather than named, and the architecture is read off the directory
   * name and printed, because a cross-architecture read is a different claim from a
   * cross-version one and the two must not be confused in the write-up.
   */
  for (const rev of revs) {
    const dir = path.join(cache, `chromium-${rev}`);
    let exe = null;
    let arch = '?';
    for (const sub of readdirSync(dir)) {
      if (!sub.startsWith('chrome-')) continue;
      arch = sub.includes('arm64') ? 'arm64' : sub.includes('x64') ? 'x64' : 'universal?';
      for (const app of readdirSync(path.join(dir, sub))) {
        if (!app.endsWith('.app')) continue;
        const cand = path.join(dir, sub, app, 'Contents/MacOS', app.slice(0, -4));
        if (existsSync(cand)) { exe = cand; break; }
      }
      const linux = path.join(dir, sub, 'chrome');
      if (!exe && existsSync(linux)) exe = linux;
      if (exe) break;
    }
    if (exe) targets.push({ label: `chromium-${rev}`, type: chromium, exe, arch });
    else console.log(`  chromium-${rev}: no executable found under ${dir}`);
  }
  if (targets.length < 3) {
    console.error(`only ${targets.length} browser(s) available; this mode needs at least three`
      + ' to say anything about a build-to-build change.');
    process.exit(2);
  }

  console.log(`\n=== libm fingerprint across ${targets.length} builds `
    + `(${revs.length} Chromium revisions in the cache) ===\n`);
  const rows = [];
  for (const t of targets) {
    try {
      const b = await t.type.launch(t.exe ? { executablePath: t.exe } : {});
      const pg = await b.newPage();
      await pg.goto('about:blank');
      await pg.evaluate(PROBES);
      const id = await pg.evaluate(() => window.__engineId());
      const libm = await pg.evaluate(() => window.__libm());
      rows.push({ label: t.label, version: b.version(), arch: t.arch ?? 'default', ua: id.ua, libm });
      console.log(`  ${t.label.padEnd(16)} ${b.version().padEnd(18)} ${(t.arch ?? '').padEnd(10)} ok`);
      await b.close();
    } catch (e) {
      console.log(`  ${t.label.padEnd(16)} ${'—'.padEnd(18)} FAILED TO LAUNCH:`
        + ` ${e.message.split('\n')[0].slice(0, 80)}`);
    }
  }
  if (rows.length < 3) {
    console.error(`\nonly ${rows.length} build(s) launched. Not enough to compare.`);
    process.exit(2);
  }

  // Distinct versions, or two cache entries are one binary.
  const versions = new Map();
  for (const r of rows) versions.set(r.version, (versions.get(r.version) ?? 0) + 1);
  const dupes = [...versions.entries()].filter(([, n]) => n > 1);
  let bad = 0;
  if (dupes.length) {
    console.log(`\n  FAIL: ${dupes.length} version string(s) appear on more than one build`
      + ` (${dupes.map(([v, n]) => `${v}×${n}`).join(', ')}).`);
    console.log('    Two cache entries resolving to one binary would read as "nothing changed";');
    console.log('    that is the one wrong answer this mode would most like to give.');
    bad++;
  }
  // Controls, across every build.
  const ctlKeys = Object.keys(rows[0].libm.controls);
  const movedCtl = ctlKeys.filter((k) => new Set(rows.map((r) => r.libm.controls[k])).size > 1);
  console.log(`\n  controls across all ${rows.length} builds: `
    + ctlKeys.map((k) => `${k} ${movedCtl.includes(k) ? '✗ MOVED' : '='}`).join('  '));
  if (movedCtl.length) {
    console.log(`    FAIL: ${movedCtl.join(', ')} moved. \`inputs\` moving means the builds were`);
    console.log('      not fed the same numbers; `sqrt` or `fma` moving would contradict');
    console.log('      IEEE-754. Either way every count below is the instrument.');
    bad++;
  }

  const fnNames = Object.keys(rows[0].libm.fns);
  console.log(`\n  --- how many of ${fnNames.length} approximated functions differ, pairwise ---`);
  const w = Math.max(...rows.map((r) => r.label.length)) + 1;
  console.log('  ' + ''.padEnd(w) + rows.map((r) => r.label.slice(-6).padStart(8)).join(''));
  for (const a of rows) {
    let line = '  ' + a.label.padEnd(w);
    for (const b of rows) {
      const n = a === b ? 0 : fnNames.filter((f) => a.libm.fns[f] !== b.libm.fns[f]).length;
      line += (a === b ? '·' : String(n)).padStart(8);
    }
    console.log(line);
  }

  /*
   * The pricing line. Adjacent Chromium revisions in the cache are the closest thing available
   * to "the update your friend took last Tuesday".
   */
  const chrome = rows.filter((r) => r.label.startsWith('chromium-'));
  if (chrome.length >= 2) {
    console.log(`\n  --- adjacent Chromium releases: what one update changes ---`);
    let anyMoved = 0;
    for (let i = 1; i < chrome.length; i++) {
      const [a, b] = [chrome[i - 1], chrome[i]];
      const moved = fnNames.filter((f) => a.libm.fns[f] !== b.libm.fns[f]);
      if (moved.length) anyMoved++;
      console.log(`    ${a.version} → ${b.version}`.padEnd(46)
        + `${String(moved.length).padStart(2)}/${fnNames.length}`
        + (moved.length ? `  ${moved.join(', ')}` : '  identical'));
    }
    console.log(`\n    ${anyMoved} of ${chrome.length - 1} adjacent release pairs changed at least`
      + ` one approximated function.`);
    console.log('    One changed function is enough to fork a battle, so that ratio is the rate at');
    console.log('    which a same-build pairing stops working when either side takes an update.');
  } else {
    console.log('\n  only one Chromium build launched, so nothing here prices a Chrome update.');
  }

  console.log('');
  if (bad) {
    console.log(`✗ INSTRUMENT FAULT: ${bad} assertion(s) failed. The counts above are not`
      + ' measurements of anything.');
    process.exit(2);
  }
  console.log(`✓ libm fingerprint read on ${rows.length} builds. This mode measures the libm, not`);
  console.log('  a pairing: same machine, same OS, same loader. See MULTIPLAYER.md §7.1 for the');
  console.log('  two-machine test it does not replace.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Assertion 2 — the dev server serves this tree
// ---------------------------------------------------------------------------
const { base, kill } = await ownDevServer({
  root: ROOT,
  port: PORT,
  cacheDir: process.env.TC_VITE_CACHE_DIR ?? null,
  label: 'qa-xengine',
});

// ---------------------------------------------------------------------------
// One run: one engine, one page, the same schedule
// ---------------------------------------------------------------------------
async function run(engine, label) {
  const launchArgs = engine === 'chromium'
    // The same flags `qa-determinism.mjs` gives Chromium, so a Chromium number here and a
    // Chromium number there are the same measurement.
    ? { args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
    : {};
  const browser = await ENGINE_TYPES[engine].launch(launchArgs);
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${base}/?harness=1&quality=${QUALITY}&w=960&h=540${EXTRA}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(PROBES);

  const id = await page.evaluate(() => window.__engineId());
  const libm = await page.evaluate(() => window.__libm());

  const marks = [];
  /** Filled at the first checkpoint; see the note in the loop. */
  const dumps = { pool: null, units: null };
  let prev = 0;
  for (const at of CHECKPOINTS) {
    if (at > prev) {
      await page.evaluate(
        (secs) => window.__game.engine.advance(secs, 1000 / 60, { render: false }),
        at - prev
      );
      prev = at;
    }
    const m = await page.evaluate(() => window.__marks ? window.__marks() : window.__game.hashes());
    marks.push({ at, hash: m.hash, count: m.count, alive: m.alive, uf64: m.uf64, uctl: m.uctl, units: m.units });
    /*
     * The localiser's dumps are taken **here**, at the first checkpoint, and not at the end of
     * the run.
     *
     * This was a bug and it is worth the paragraph. The localiser used to call
     * `page.evaluate(__poolXYZ)` after every run had finished, which reads whatever state the
     * page is in *now* — t+400 — and then printed it under the heading "localising at t+0". On
     * a run where the engines happened to agree at t+400 and disagree at t+0 it reported "0 of
     * 3,440 men differ" beside a t+0 hash that plainly did differ, and I nearly wrote that up
     * as a difference in the waypoint queue. A label that lies about which moment it describes
     * is the same instrument defect as an arm pointed at the wrong battle, in a tool whose
     * whole subject is that defect.
     */
    if (at === CHECKPOINTS[0]) {
      dumps.pool = await page.evaluate(() => window.__poolXYZ());
      dumps.units = await page.evaluate(() => window.__unitDump());
    }
    console.log(`  ${label.padEnd(11)} t+${String(at).padStart(3)}  count ${m.count}  alive ${m.alive}`
      + `  hash ${m.hash}  uf64 ${m.uf64}  uctl ${m.uctl}`);
  }
  return { engine, label, page, browser, id, libm, marks, errors, dumps };
}

// ---------------------------------------------------------------------------
// Run them
// ---------------------------------------------------------------------------
console.log(`\n=== cross-engine: '${BATTLE_KEY}' at quality=${QUALITY}, `
  + `t+${CHECKPOINTS.join(', t+')} ===`);
console.log(`    engines: ${ENGINES.join(', ')}   reference: ${REFERENCE}`
  + `   control: a second ${REFERENCE} load\n`);

const runs = [];
let fatal = 0;
try {
  for (const e of ENGINES) runs.push(await run(e, e));
  // Assertion 6's control: the reference engine, loaded again.
  runs.push(await run(REFERENCE, `${REFERENCE}#2`));
} catch (e) {
  console.error(`\n✗ a run failed to complete: ${e.message}`);
  for (const r of runs) { await r.browser.close().catch(() => {}); }
  kill();
  process.exit(2);
}

const ref = runs[0];
const control = runs.at(-1);
const others = runs.slice(1, -1);

// ---------------------------------------------------------------------------
// Assertion 3 — each page is the engine it was asked for
// ---------------------------------------------------------------------------
console.log('\n--- the pages are three different engines (feature detection, not the UA) ---');
for (const r of runs) {
  const flags = ['chromium', 'firefox', 'webkit'].filter((k) => r.id[k]);
  const ok = flags.length === 1 && flags[0] === r.engine;
  console.log(`  ${r.label.padEnd(11)} ${ok ? 'OK  ' : 'FAIL'} detected [${flags.join(',') || 'none'}]`
    + `  vendor '${r.id.vendor}'`);
  console.log(`              ${r.id.ua}`);
  if (!ok) {
    console.log(`    FAIL: asked for '${r.engine}' and the page detects `
      + `${flags.length === 1 ? `'${flags[0]}'` : `${flags.length} engines`}.`);
    console.log('      Playwright handed back something other than the engine requested, so this');
    console.log('      arm would be comparing one engine with itself and calling it agreement.');
    fatal++;
  }
}

// ---------------------------------------------------------------------------
// Assertions 4 and 5 — the libms really disagree, and the controls hold
// ---------------------------------------------------------------------------
console.log('\n--- the engines really do compute Math differently (and the controls say so) ---');
const FNS = Object.keys(ref.libm.fns);
const distinct = ENGINES.map((e) => runs.find((r) => r.engine === e && r.label === e));
const disagreeing = FNS.filter((fn) => new Set(distinct.map((r) => r.libm.fns[fn])).size > 1);
const controlKeys = Object.keys(ref.libm.controls);
const brokenControls = controlKeys.filter(
  (k) => new Set(distinct.map((r) => r.libm.controls[k])).size > 1);

const perFn = FNS.map((fn) => {
  const digs = distinct.map((r) => r.libm.fns[fn]);
  return `${fn}${new Set(digs).size > 1 ? ' ✗' : ' ='}`;
});
console.log(`  ${perFn.join('  ')}`);
console.log(`  ${disagreeing.length}/${FNS.length} approximated functions disagree across`
  + ` ${distinct.length} engines: ${disagreeing.join(', ') || '(none)'}`);
console.log(`  controls (must be identical everywhere): `
  + controlKeys.map((k) => `${k} ${brokenControls.includes(k) ? '✗ MOVED' : '='}`).join('  '));
for (const fn of FNS) {
  if (!disagreeing.includes(fn)) continue;
  console.log(`    ${fn.padEnd(6)} ` + distinct.map((r) => `${r.engine} ${r.libm.fns[fn]}`).join('  '));
}
if (!disagreeing.length) {
  console.log('\n    FAIL: not one approximated Math function differs between these engines.');
  console.log('      Either they are the same engine under different names or the probe is');
  console.log('      broken. Battle hashes matching would prove nothing either way.');
  fatal++;
}
if (brokenControls.length) {
  console.log(`\n    FAIL: control(s) moved across engines: ${brokenControls.join(', ')}.`);
  console.log('      `inputs` moving means the probe fed the engines different numbers, so the');
  console.log('      disagreement above is the instrument. `sqrt` or `fma` moving would');
  console.log('      contradict IEEE-754 and five independent passes, and is far more likely to');
  console.log('      be a defect here. Nothing below can be believed until this is explained.');
  fatal++;
}

// ---------------------------------------------------------------------------
// Assertion 6 — the reference engine agrees with itself
// ---------------------------------------------------------------------------
console.log(`\n--- control: ${REFERENCE} vs a second ${REFERENCE} load (must be identical) ---`);
const MARKS = ['hash', 'count', 'alive', 'uf64', 'uctl', 'units'];
const controlDrift = [];
for (let i = 0; i < CHECKPOINTS.length; i++) {
  const bad = MARKS.filter((k) => ref.marks[i][k] !== control.marks[i][k]);
  if (bad.length) controlDrift.push(`t+${ref.marks[i].at}: `
    + bad.map((k) => `${k} ${ref.marks[i][k]} vs ${control.marks[i][k]}`).join('  '));
}
if (controlDrift.length) {
  console.log(`  FAIL: ${controlDrift.length} checkpoint(s) differ between two loads of the same engine.`);
  for (const d of controlDrift) console.log(`    ${d}`);
  console.log('    Every cross-engine number below is VOID: a difference that reproduces between');
  console.log('    two loads of one engine is this harness, not a libm. Fix that first —');
  console.log('    `qa-determinism.mjs` is the tool that localises it.');
  fatal++;
} else {
  console.log(`  IDENTICAL at all ${CHECKPOINTS.length} checkpoints. Any difference below is the engine.`);
}

// ---------------------------------------------------------------------------
// The finding
// ---------------------------------------------------------------------------
console.log(`\n--- ${REFERENCE} vs each other engine ---`);
console.log('    discrete  = count, alive, units, uctl — the roster and what the battle decided');
console.log('    continuous = hash (float32 pool x/z/state/hp), uf64 (float64 unit layer)\n');

const DISCRETE = ['count', 'alive', 'units', 'uctl'];
const CONTINUOUS = ['hash', 'uf64'];
let divergent = 0;
const findings = [];
for (const r of others) {
  const rows = [];
  let firstDiscrete = null;
  let firstContinuous = null;
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const a = ref.marks[i], b = r.marks[i];
    const dBad = DISCRETE.filter((k) => a[k] !== b[k]);
    const cBad = CONTINUOUS.filter((k) => a[k] !== b[k]);
    if (dBad.length && firstDiscrete === null) firstDiscrete = a.at;
    if (cBad.length && firstContinuous === null) firstContinuous = a.at;
    rows.push({ at: a.at, dBad, cBad, a, b });
  }
  for (const row of rows) {
    const verdict = row.dBad.length ? 'DIFFERENT BATTLE'
      : row.cBad.length ? 'same decisions, different arithmetic'
        : 'IDENTICAL';
    console.log(`  ${REFERENCE} vs ${r.engine}  t+${String(row.at).padStart(3)}  ${verdict}`);
    if (row.dBad.length) {
      console.log(`      discrete: ` + row.dBad.map((k) => `${k} ${row.a[k]} vs ${row.b[k]}`).join('  '));
    }
    if (row.cBad.length) {
      console.log(`      continuous: ` + row.cBad.map((k) => `${k} ${row.a[k]} vs ${row.b[k]}`).join('  '));
    }
  }
  const diverged = firstDiscrete !== null || firstContinuous !== null;
  if (diverged) divergent++;
  findings.push({ engine: r.engine, firstDiscrete, firstContinuous, rows: rows.map((x) => ({ at: x.at, discrete: x.dBad, continuous: x.cBad })) });
  console.log(`    → ${r.engine}: ${diverged
    ? `first continuous difference t+${firstContinuous ?? '—'}, first discrete t+${firstDiscrete ?? '—'}`
    : `identical to ${REFERENCE} at every checkpoint`}`);
}

// ---------------------------------------------------------------------------
// The localiser
// ---------------------------------------------------------------------------
/*
 * Only for the earliest checkpoint at which anything differs, and only if it is the first one
 * in `--at`: a dump is 6 arrays × 8,632 entries per page and localising a divergence that has
 * been amplifying for four hundred seconds tells you nothing a hash did not.
 */
const localised = [];
const earliest = findings.filter((f) => f.firstContinuous === CHECKPOINTS[0] || f.firstDiscrete === CHECKPOINTS[0]);
if (earliest.length) {
  console.log(`\n--- localising at t+${CHECKPOINTS[0]}: which men, and by how much ---`);
  const dref = ref.dumps.pool;
  for (const f of earliest) {
    const r = others.find((o) => o.engine === f.engine);
    const d = r.dumps.pool;
    const n = Math.min(dref.count, d.count);
    let xz = 0, yOnly = 0, other = 0;
    let worstXzUlp = 0, worstXzM = 0, worstYUlp = 0, worstYM = 0;
    const sample = [];
    for (let i = 0; i < n; i++) {
      const dx = dref.x[i] !== d.x[i], dz = dref.z[i] !== d.z[i], dy = dref.y[i] !== d.y[i];
      const ds = dref.state[i] !== d.state[i] || dref.hp[i] !== d.hp[i];
      if (!dx && !dz && !dy && !ds) continue;
      if (dx || dz) {
        xz++;
        worstXzUlp = Math.max(worstXzUlp, dx ? f32Ulp(dref.x[i], d.x[i]) : 0, dz ? f32Ulp(dref.z[i], d.z[i]) : 0);
        worstXzM = Math.max(worstXzM, Math.abs(dref.x[i] - d.x[i]), Math.abs(dref.z[i] - d.z[i]));
      } else if (dy) {
        yOnly++;
        worstYUlp = Math.max(worstYUlp, f32Ulp(dref.y[i], d.y[i]));
        worstYM = Math.max(worstYM, Math.abs(dref.y[i] - d.y[i]));
      } else other++;
      if (sample.length < 6) {
        sample.push(`slot ${i} (unit ${dref.unitId[i]}): `
          + [dx && `x ${dref.x[i]} vs ${d.x[i]}`, dz && `z ${dref.z[i]} vs ${d.z[i]}`,
            dy && `y ${dref.y[i]} vs ${d.y[i]} (${f32Ulp(dref.y[i], d.y[i])} f32 ULP,`
              + ` ${((dref.y[i] - d.y[i]) * 1000).toFixed(4)} mm)`,
            ds && `state/hp`].filter(Boolean).join('; '));
      }
    }
    console.log(`  ${REFERENCE} vs ${f.engine}: ${xz + yOnly + other} of ${n} men differ`
      + ` — ${xz} in x/z, ${yOnly} in y only, ${other} in state/hp only`);
    if (xz + yOnly + other === 0) {
      console.log('      the float32 pool is bit-identical. Whatever differs is upstream of the');
      console.log('      quantisation firewall and only `uf64` can see it — see the unit layer below.');
    }
    if (xz) console.log(`      x/z population: worst ${worstXzUlp} float32 ULP, `
      + `${(worstXzM * 1000).toFixed(4)} mm`);
    if (yOnly) console.log(`      y-only population: worst ${worstYUlp} float32 ULP, `
      + `${(worstYM * 1000).toFixed(4)} mm  — foot height, which the pinned hash cannot see`);
    for (const s of sample) console.log(`      ${s}`);
    /*
     * The unit layer, which is the only thing left once the pool agrees.
     *
     * `UnitGroupState` is plain float64 with no quantisation step anywhere, so a single libm
     * call rounding differently shows here and nowhere else. Reporting the *field* and the ULP
     * gap is the difference between "a browser rounded a number" (1–3 ULP on one field) and
     * "these are two different battles" (thousands of ULP, or anything in `uctl`).
     */
    const ua = ref.dumps.units;
    const ub = r.dumps.units;
    const uf = [];
    let worstUlp = 0n, f64Count = 0, ctlCount = 0;
    const byField = new Map();
    for (let i = 0; i < Math.min(ua.units.length, ub.units.length); i++) {
      for (let k = 0; k < ua.fields.f64.length; k++) {
        const [x, y] = [ua.units[i].f64[k], ub.units[i].f64[k]];
        if (Object.is(x, y)) continue;
        f64Count++;
        const g = f64Ulp(x, y);
        if (g > worstUlp) worstUlp = g;
        const name = ua.fields.f64[k];
        byField.set(name, (byField.get(name) ?? 0) + 1);
        if (uf.length < 6) uf.push(`unit ${ua.units[i].id} (${ua.units[i].typeId}) `
          + `${name} ${x} vs ${y} (${g} ULP)`);
      }
      for (let k = 0; k < ua.fields.ctl.length; k++) {
        if (ua.units[i].ctl[k] === ub.units[i].ctl[k]) continue;
        ctlCount++;
        const name = ua.fields.ctl[k];
        byField.set(name, (byField.get(name) ?? 0) + 1);
        if (uf.length < 6) uf.push(`unit ${ua.units[i].id} ${name} `
          + `${ua.units[i].ctl[k]} vs ${ub.units[i].ctl[k]}  [control flow]`);
      }
      // The two list fields the hashes cover and `hashFields()` does not name.
      const [wa, wb] = [ua.units[i].waypoints, ub.units[i].waypoints];
      if (wa.length !== wb.length) {
        f64Count++;
        byField.set('waypoints.length', (byField.get('waypoints.length') ?? 0) + 1);
        if (uf.length < 6) uf.push(`unit ${ua.units[i].id} waypoints.length `
          + `${wa.length} vs ${wb.length}`);
      } else {
        for (let k = 0; k < wa.length; k++) {
          if (Object.is(wa[k], wb[k])) continue;
          f64Count++;
          const g = f64Ulp(wa[k], wb[k]);
          if (g > worstUlp) worstUlp = g;
          // Flat [x, z, facing] triples; naming the component is what makes this actionable.
          const comp = ['x', 'z', 'facing'][k % 3];
          byField.set(`waypoint.${comp}`, (byField.get(`waypoint.${comp}`) ?? 0) + 1);
          if (uf.length < 6) uf.push(`unit ${ua.units[i].id} (${ua.units[i].typeId}) `
            + `waypoint[${k}].${comp} ${wa[k]} vs ${wb[k]} (${g} ULP)`);
        }
      }
      const [ma, mb] = [ua.units[i].members, ub.units[i].members];
      if (ma.length !== mb.length || ma.some((v, k) => v !== mb[k])) {
        ctlCount++;
        byField.set('members', (byField.get('members') ?? 0) + 1);
        if (uf.length < 6) uf.push(`unit ${ua.units[i].id} members differ`
          + ` (${ma.length} vs ${mb.length})  [control flow]`);
      }
    }
    const totalFields = Math.min(ua.units.length, ub.units.length)
      * (ua.fields.f64.length + ua.fields.ctl.length);
    console.log(`      unit layer: ${f64Count} float64 and ${ctlCount} control field(s) differ`
      + ` of ${totalFields} across ${ua.units.length} units; worst ${worstUlp} float64 ULP`);
    if (byField.size) {
      console.log(`      by field: ` + [...byField.entries()]
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
    }
    for (const line of uf) console.log(`      ${line}`);
    localised.push({
      engine: f.engine, at: CHECKPOINTS[0], of: n, xz, yOnly, other,
      worstXzUlp, worstXzMm: worstXzM * 1000, worstYUlp, worstYMm: worstYM * 1000,
      unitF64Fields: f64Count, unitCtlFields: ctlCount, unitFieldsOf: totalFields,
      unitWorstUlp: String(worstUlp), unitByField: Object.fromEntries(byField),
    });
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const errors = [...new Set(runs.flatMap((r) => r.errors))];
if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), `${JSON.stringify({
    battle: BATTLE_KEY, quality: QUALITY, checkpoints: CHECKPOINTS, reference: REFERENCE,
    engines: runs.map((r) => ({ label: r.label, engine: r.engine, ua: r.id.ua, marks: r.marks })),
    libm: Object.fromEntries(distinct.map((r) => [r.engine, r.libm])),
    disagreeing, brokenControls, controlDrift, findings, localised, errors,
  }, null, 2)}\n`);
  console.log(`\n• wrote ${JSON_OUT}`);
}

for (const r of runs) await r.browser.close().catch(() => {});
kill();

console.log('');
if (fatal) {
  console.log(`✗ INSTRUMENT FAULT: ${fatal} vacuity assertion(s) failed on '${BATTLE_KEY}'.`);
  console.log('  Nothing above is a measurement of the game. Fix the instrument first.');
  process.exit(2);
}
if (divergent) {
  console.log(`✗ '${BATTLE_KEY}' is not the same battle in every engine:`
    + ` ${divergent} of ${others.length} engine(s) diverge from ${REFERENCE}`
    + ` (${ref.marks.at(-1).count} men).`);
  for (const f of findings) {
    console.log(`    ${f.engine.padEnd(9)} first continuous t+${f.firstContinuous ?? '—'}`
      + `   first discrete t+${f.firstDiscrete ?? '—'}`);
  }
  process.exit(1);
}
console.log(`✓ '${BATTLE_KEY}' is bit-identical in ${ENGINES.join(', ')} at all`
  + ` ${CHECKPOINTS.length} checkpoints (${ref.marks.at(-1).count} men),`
  + ` with ${disagreeing.length}/${FNS.length} Math functions measured disagreeing between them.`);
process.exit(0);
