#!/usr/bin/env node
/**
 * Append this pass's paragraph to each of the three baseline notes.
 *
 * `qa-determinism.mjs --record` deliberately carries the previous `note` forward — the field
 * is the file's history and overwriting it would throw away every earlier re-record's reason.
 * So the tool records the numbers and this writes down why they moved, in the same `|||`
 * convention the file already uses. One-shot; kept because the next person to move a pin
 * needs to know that the note is not written by `--record`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FILE = path.join(ROOT, 'tools/determinism-baseline.json');
const b = JSON.parse(readFileSync(FILE, 'utf8'));

const COMMON = '**Re-recorded by the testudo pass, and the change that moved it is one field: '
  + '`FormationDef.packRadius`.** `BattleSystem.resolveCrowding` separated every man to a fixed '
  + '0.84 m centre to centre, so `testudo`\'s 0.516 m file spacing and `shieldwall`\'s 0.636 m '
  + 'had never done anything at all — the solver moves a man up to 0.22 m a tick and the '
  + 'steering that pulls him back to his slot manages millimetres, so both formations expanded '
  + 'until every man stood exactly where a `line` stands. Measured on the field battle with one '
  + '320-man legionary cohort ordered into testudo and left 30 s to settle '
  + '(`tools/probe-testudo.mjs`): **14.39 m x 13.47 m at 0.606 m2 a man, with the median man '
  + '2.00 m from his own slot and the worst 11.80 m**, against the 10.80 x 8.85 m the formation '
  + 'asks for. Those two formations now take a body radius a little under half their own file '
  + 'spacing — 0.25 m and 0.31 m — and the same cohort comes out at **11.06 x 8.91 m at 0.308 '
  + 'm2, median 0.052 m off slot**. Everything else keeps 0.42 m, and the *sum of two defaults* '
  + 'is bit-identical to the `radius * 2` constant it replaces because doubling is exact in '
  + 'binary floating point, so a formation that is neither of those two does not move by a ULP. '
  + '**This is a balance change and it is meant as one**: a testudo that can close up presents '
  + 'about half the frontage to missiles, fits gaps it could not fit, and stands on a third of '
  + 'the ground. Everything else in that commit is presentation — five solved shield poses, the '
  + 'dressing, the stature evening, the stowed pilum — and writes nothing `poolHash` covers. '
  + 'A and B bit-identical at all seven checkpoints on `hash`, `uf64` and `uctl`, and identical '
  + 'across all four quality tiers. `docs/tech/TESTUDO.md` has the whole of it.';

const ARMS = {
  default:
    ' On this arm: **`hash` and both unit marks are UNCHANGED at t+0** (`4c88901a`, '
    + '`61168a5f`/`2b2ac282`) and `uctl` is unchanged at t+30 as well (`13f5b86e`) — the '
    + 'deployment and the discrete half of every unit at boot are byte-identical to the battle '
    + 'that shipped, which is the claim "this is a crowd radius and not an order of battle" '
    + 'stands on. The pool first moves at t+30 and control flow at t+90, which is when the '
    + 'tactical AI first calls for a shieldwall. Survivors: t+200 6,304 -> 7,068 (+12.1%), '
    + 't+400 4,973 -> 5,408 (+8.7%). Denser formations lose fewer men, which is the whole '
    + 'point of standing in one. Headcount 8,632 and 35 units unchanged.',
  'map=campus-martius&scenario=assault':
    ' On this arm: t+0 UNCHANGED on `hash`, `uf64` and `uctl`; first movement at t+30, which is '
    + 'the garrison forming up on the wall-walk. The storm is much less sensitive than the '
    + 'field battle because most of it is fought on stone by units `Siege` places man by man '
    + 'through `steerToSlots`, which never consults a formation: t+200 survivors 2,524 -> 2,524 '
    + 'exactly, t+400 2,272 -> 2,293 (+0.9%). Headcount 3,072 and 32 units unchanged.',
  'map=carthage&scenario=assault':
    ' On this arm: t+0 UNCHANGED on `hash`, `uf64` and `uctl`; first movement at t+30. '
    + 'Survivors t+200 2,746 -> 2,807 (+2.2%) and t+400 2,330 -> 2,258 (-3.1%) — the sign '
    + 'differs from the field battle\'s and from Rome\'s, which is what a change that alters '
    + 'who can reach whom does to three different tactical problems. Headcount 3,440 and 34 '
    + 'units unchanged.',
};

for (const [key, tail] of Object.entries(ARMS)) {
  const arm = b[key];
  if (!arm) throw new Error(`[testudo-note] no baseline arm "${key}"`);
  if (arm.note.includes('packRadius')) {
    console.log(`  ${key}: already noted, skipped`);
    continue;
  }
  arm.note = `${arm.note} ||| ${COMMON}${tail}`;
  console.log(`  ${key}: note appended (${arm.note.length} chars)`);
}

writeFileSync(FILE, `${JSON.stringify(b, null, 2)}\n`);
console.log(`wrote ${path.relative(ROOT, FILE)}`);
