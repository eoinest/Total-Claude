#!/usr/bin/env node
/**
 * Replay a recorded campaign against candidate scopings of victory condition A.
 *
 * The point of doing it offline is that the recording is of the *unmodified* sim, so every
 * candidate is judged on exactly the same twelve battles — no rule can move the trajectory it
 * is being scored on, and the answer to "would this have fired, and when" is a fact about the
 * runs rather than about a second campaign. The rule the sim now enforces is `scoped`; the
 * others are here so that "reachable but still hard" is a comparison and not an assertion.
 *
 *   node tools/scratch/rulecheck-vs.mjs /tmp/vs-before.json
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? '/tmp/vs-before.json';
const d = JSON.parse(readFileSync(path, 'utf8'));
const FOOT = 24, HOLD = 20;
const FACTION = { 0: 'Rome', 1: 'Juthungi', 2: 'Carthage' };

/** Maximal blocks of consecutive runs the storm stands on. */
function blocks(runStorm) {
  const rs = Object.keys(runStorm).map(Number).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < rs.length;) {
    let j = i;
    while (j + 1 < rs.length && rs[j + 1] === rs[j] + 1) j++;
    out.push(rs.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** Men on lodgements the garrison has conceded, under a given shoulder and D-memory rule. */
function holding(s, contested, shoulder, requireTaken, takenOverShoulders = false) {
  let men = 0;
  for (const blk of blocks(s.runStorm)) {
    let m = 0, foe = 0, taken = false;
    for (const r of blk) { m += s.runStorm[r]; if (!takenOverShoulders && contested.has(r)) taken = true; }
    for (let r = blk[0] - shoulder; r <= blk[blk.length - 1] + shoulder; r++) {
      foe += s.runGarr[r] ?? 0;
      if (takenOverShoulders && contested.has(r)) taken = true;
    }
    if (foe === 0 && (taken || !requireTaken)) men += m;
  }
  return men;
}

const RULES = [
  { name: 'old (garrison 0 on the whole circuit)', old: true },
  { name: 'scoped, shoulder 1, taken ground (block only)', shoulder: 1, taken: true },
  { name: 'scoped, shoulder 1, taken ground (block + shoulders)', shoulder: 1, taken: true, overShoulders: true },
  { name: 'scoped, shoulder 1, any ground', shoulder: 1, taken: false },
  { name: 'scoped, shoulder 0, taken ground', shoulder: 0, taken: true },
  { name: 'scoped, shoulder 2, taken ground', shoulder: 2, taken: true },
  { name: 'scoped, shoulder 3, taken ground', shoulder: 3, taken: true },
];

console.log(`${d.runs.length} runs, sampled every ${d.sample}s\n`);
const tally = new Map();
for (const rule of RULES) {
  const fires = [];
  let bestEver = 0;
  for (const r of d.runs) {
    const contested = new Set();
    let held = 0, firedAt = null, best = 0;
    let prevT = 0;
    for (const s of r.series) {
      for (const k of Object.keys(s.runGarr)) contested.add(Number(k));
      const dt = s.t - prevT; prevT = s.t;
      const men = rule.old
        ? (s.garrisonOnWall === 0 ? s.stormOnWall : 0)
        : holding(s, contested, rule.shoulder, rule.taken, rule.overShoulders);
      if (men > best) best = men;
      held = men >= FOOT ? held + dt : 0;
      if (held >= HOLD && firedAt === null) firedAt = s.t;
    }
    bestEver = Math.max(bestEver, best);
    fires.push({ seed: r.seed, firedAt, best, endedAt: r.result?.at ?? null, reason: r.result?.reason ?? '-', victor: r.result?.victor });
  }
  // A firing only changes the outcome if it lands before the battle ended some other way.
  const wins = fires.filter((f) => f.firedAt !== null && (f.endedAt === null || f.firedAt <= f.endedAt));
  tally.set(rule.name, wins.length);
  console.log(`${rule.name}`);
  console.log(`  would fire in ${wins.length}/${fires.length} runs; best lodgement seen anywhere ${bestEver} men (need ${FOOT})`);
  for (const f of fires) {
    console.log(`   seed ${String(f.seed).padStart(10)}  best ${String(f.best).padStart(3)}  `
      + `fires ${f.firedAt === null ? '  never' : String(f.firedAt.toFixed(0)).padStart(6) + 's'}`
      + `   actual ${FACTION[f.victor] ?? '-'} / ${f.reason} @${f.endedAt?.toFixed(0) ?? '-'}s`);
  }
  console.log('');
}
