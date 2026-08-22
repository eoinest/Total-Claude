/**
 * Units routing over time, per side, out of jg-shape records.
 *
 * The field battle's verdict is `rout`, and `BattleFlow.update` reads it off **men in units
 * that are not routing**, normalised by each side's starting men (`frac`) and against the
 * strongest side (`rel`). So the thing to watch is not casualties but how many *units* have
 * broken on each side and when — a rout cascade is the only route Rome has to a win here,
 * because `DECISIVE_RATIO` at 0.33 is unreachable for the smaller army.
 *
 * `myRouting` / `theirRouting` in the curve are unit counts (`u.order === Rout || routTimer > 0`).
 */
import { readFile } from 'node:fs/promises';

const TS = [90, 110, 130, 150, 175, 200, 225, 250, 275, 300, 350, 400];
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(await readFile(f, 'utf8'));
  console.log(`\n=== ${d.tag}  src ${d.srcHash}  ${d.map}/${d.scen} ===`);
  console.log('seed        verdict   at   ' + TS.map((t) => `t${t}`.padStart(8)).join(''));
  for (const r of d.rows) {
    if (r.error) continue;
    const cells = TS.map((t) => {
      const c = (r.curve ?? []).filter((x) => x.t >= t)[0];
      return c ? `${c.myRouting}/${c.theirRouting}`.padStart(8) : '       -';
    });
    console.log(`${String(r.seed).padStart(10)} ${String(r.verdict).padEnd(8)} ${String(Math.round(r.at ?? -1)).padStart(4)} ` + cells.join(''));
  }
  // peak routing per side, and the units each side started with
  for (const r of d.rows) {
    if (r.error) continue;
    let pm = 0, pt = 0, uM = 0, uT = 0;
    for (const c of r.curve ?? []) { pm = Math.max(pm, c.myRouting); pt = Math.max(pt, c.theirRouting); }
    const first = (r.curve ?? [])[0];
    if (first) { uM = first.me; uT = first.them; }
    console.log(`  seed ${String(r.seed).padStart(10)}  peak routing units  Rome ${String(pm).padStart(2)}  foe ${String(pt).padStart(2)}   men at first sample ${uM}/${uT}`);
  }
}
