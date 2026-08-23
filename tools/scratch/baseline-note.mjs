#!/usr/bin/env node
/**
 * Scratch: append the re-record notes to `tools/determinism-baseline.json`.
 *
 * A one-shot. It appends to `note` and touches no hash, no count and no checkpoint.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const p = path.resolve(import.meta.dirname, '../determinism-baseline.json');
const j = JSON.parse(readFileSync(p, 'utf8'));
const add = (k, s) => { j[k].note = (j[k].note ? `${j[k].note} ||| ` : '') + s; };

add('default',
  'Re-recorded 22 Aug 2026 on e/city/rome-eye-level, in the same commit as the change that '
  + 'moved it. The Campus Martius heightfield changed: the flood plain no longer inherits the '
  + 'upland ridged multifractal or the "behind the crest" lift, so the ground under this battle '
  + 'is 20-30 m lower over most of the map and every man stands somewhere new. Head count is '
  + 'unchanged at 8,632 in 35 units and all four quality tiers remain the same battle, which is '
  + 'what says this is a terrain move and not a simulation change. Survivors at t+400 go 4,660 '
  + 'to 5,178: the assault crosses flatter ground and more of it lives.');

add('map=campus-martius&scenario=assault',
  'Re-recorded 22 Aug 2026 on e/city/rome-eye-level, same commit, same cause as the default '
  + 'entry. 3,072 men in 32 units, unchanged.');

add('map=carthage&scenario=assault',
  'NOT re-recorded 22 Aug 2026, and that is a measurement rather than a decision. This entry '
  + 'is stale, and it was already stale on main: e/city/rome-eye-level touches nothing Carthage '
  + 'reads, and the two trees were run side by side to prove it rather than reasoned about. On '
  + 'ef8b5c7 and on 17e885c the Carthage assault hashes are byte-identical at all seven '
  + 'checkpoints - aadd5ef2 / a99f4f80 / 223201b2 / 561364a0 / e23a7a98 / b66cd272 / 80fce118, '
  + 'head count 3,440 in 34 units on both - and every one of them differs from what is pinned '
  + 'here. So somebody moved this battle earlier and did not re-record. Re-recording it from '
  + 'this branch would put another branch\'s drift under this one\'s name, which is the exact '
  + 'thing the rule at the top of this note exists to stop. Whoever moved it should record it '
  + 'and say why.');

writeFileSync(p, `${JSON.stringify(j, null, 1)}\n`);
console.log('ok');
