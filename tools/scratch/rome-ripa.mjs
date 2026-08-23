#!/usr/bin/env node
/**
 * **The right bank of the Tiber, as candidate `ripa-transtiberim` nodes.**
 *
 * `ways.ts` authors every other row off a plate. This one cannot be: the *Ripa* is a frontage,
 * and a frontage has to be on the same water as the region boundary (`regions.ts`'s `RIVER`)
 * and the block boundary (`fabric.ts`'s `riverWay`), both of which come from
 * `src/terrain/tiberSurvey.ts`. A line read off Shepherd would be a fourth answer.
 *
 * So this emits the offset, from the shipped station table, and `ways.ts` carries the printed
 * numbers with the station each came off in the comment beside it — the same treatment
 * `regions.ts` gives `RIVER`, and for the same reason: a change to the survey then shows up as
 * a diff in the way table rather than silently under it.
 *
 * **The offset is perpendicular to the local tangent, not by northing.** Two of the reaches
 * this crosses run east-west, and a by-northing offset on an east-west reach is the degeneracy
 * `MAP-METHOD.md` rule 20 was written for — it turned a 14.7 m error into 392 m the last time
 * this project did it. The station list runs *upstream* (it starts at n −1170 and ends at
 * n 7885), so downstream is `(−te, −tn)` and the right bank facing downstream is the
 * `(−tn, te)` normal. One rule, valid on every reach.
 *
 *   node --experimental-strip-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/rome-ripa.mjs [offsetM] [nFrom] [nTo]
 */
import { TIBER_SURVEY } from '../../src/terrain/tiberSurvey.ts';

const OFF = Number(process.argv[2] ?? 55);   // survey metres inland of the bank line
const lo = Number(process.argv[3] ?? -400);
const hi = Number(process.argv[4] ?? 1300);
const S = TIBER_SURVEY;
for (let i = 1; i + 1 < S.length; i++) {
  const [e, n, w] = S[i];
  if (n < lo || n > hi) continue;
  if (i % 4 !== 0) continue;                 // one node per ~100 m of course
  const te = S[i + 1][0] - S[i - 1][0];
  const tn = S[i + 1][1] - S[i - 1][1];
  const L = Math.sqrt(te * te + tn * tn) || 1;
  const d = OFF + w / 2;                     // half the channel's own modelled width, plus a quay
  const bank = { e: e + (-tn / L) * d, n: n + (te / L) * d };
  console.log(`  [${bank.e.toFixed(0)}, ${bank.n.toFixed(0)}],   // channel (${e.toFixed(0)}, ${n.toFixed(0)}) w${w.toFixed(0)}`);
}
