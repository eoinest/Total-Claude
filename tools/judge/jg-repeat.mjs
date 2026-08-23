/**
 * THE GATE EVERY HASH CLAIM HANGS ON: is one seed on one tree reproducible across page loads?
 *
 * I never ran this, and it invalidated a day of work. My "negative control" for `jg-compare` was
 * `jg-compare before.json before.json` — the same file twice. It compared a string to itself,
 * refused, and I reported that as proof the refusal path worked. It proved string equality of
 * identical strings and nothing whatever about reproducibility.
 *
 * Run properly, it failed: two loads of one seed gave `51b3a42a` and `e4bb3a6a` at tick 900, and
 * 8,249 against 8,256 alive at 2,700. So the hash-equality refusal I had been invoking all day as
 * my safety mechanism **could never have fired** — a check that cannot fail, which is the same
 * object as a test that cannot fail, in the guard instead of the statistic.
 *
 * Two causes, both mine: `boot()` waits 1,500 ms of wall clock after `ready`, which under autoplay
 * advances the sim up to 900 ticks; and the hash was taken on the first sample past the mark
 * rather than *at* it. Fixed by hashing at exact ticks, in ONE evaluate so no rAF frame can land
 * between reading the shortfall and spending it, with the first mark moved clear of boot drift.
 *
 * Held to exact ticks the engine is reproducible to the bit, which is the reassuring half: the
 * simulation really is a pure function of (config, seed, tick index). Run this before trusting any
 * before/after hash comparison, on the tree you are about to grade.
 */
import { boot, argsOf } from './jg-lib.mjs';
const A = argsOf();
const PORT = Number(A.get('port') ?? 5814);
const MAP = A.get('map') ?? 'campus-martius';
const SCEN = A.get('scen') ?? 'field';
const SEED = Number(A.get('seed') ?? 4265438264);
const MARKS = [1800, 2700, 6000];
const out = [];
for (let run = 0; run < 2; run++) {
  const r = await boot({ port: PORT, map: MAP, scenario: SCEN, tier: 'ultra',
    out: '/tmp/jg-repeat', label: `r${run}`, seed: SEED, query: 'autoplay=1&deploy=0' });
  const hs = {};
  for (const m of MARKS) {
    hs[m] = await r.page.evaluate((mark) => {
      const g = window.__game, now = g.engine.time.tick;
      if (now >= mark) return { overshot: now };
      g.advanceTicks(mark - now, 1000 / 60);
      return { at: g.engine.time.tick, ...g.hashes() };
    }, m);
  }
  out.push(hs);
  console.log(`run ${run}: ${JSON.stringify(hs)}`);
  await r.browser.close();
}
const same = JSON.stringify(out[0]) === JSON.stringify(out[1]);
console.log(`\n${MAP}/${SCEN} seed ${SEED}: ${same ? 'REPRODUCIBLE — a hash difference is now evidence' : '*** STILL NOT REPRODUCIBLE ***'}`);
process.exit(same ? 0 : 1);
