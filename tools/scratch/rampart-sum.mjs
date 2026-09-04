// Scratch reader for probe-rampart JSON. Prints the arms in one screen each.
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const f = (x) => (x === null || x === undefined ? '-' : x);
console.log(`rev ${d.rev} label ${d.label} battle ${d.battle} window ${d.seconds}s`);
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const a = d[k]; if (!a) continue;
  console.log('=== ARM ' + k + ' ===');
  if (a.fail) { console.log('  FAIL: ' + a.fail); continue; }
  if (k === 'A') {
    console.log(`  stations ${a.stationCount} runs ${a.runCount} unreachable ${a.unreachableStations} on runs ${JSON.stringify(a.unreachableRuns)}`);
    const r = a.runs.filter((x) => x.stair);
    const seats = r.map((x) => x.seats).sort((p, q) => p - q);
    console.log(`  reachable runs ${r.length}; seats min/med/max ${seats[0]}/${seats[r.length >> 1]}/${seats[seats.length - 1]}`);
    for (const g of a.garrisons) {
      console.log(`   u${g.id} ${g.type} alive=${g.alive} span=${g.span} ranks=${g.ranks} seats=${g.seats} overflow=${g.overflow} pile=${g.worstPile} share=${g.menSharingASlot} inStone=${g.inStone} offEdge=${g.offEdge} overStone=${g.overStone} outBand=${g.outBand}/${g.worstOut} far=${g.far} stuckW=${g.stuckOnWall}`);
    }
    continue;
  }
  const hdr = k === 'F'
    ? `run ${a.run} st=${a.runStations} ranks=${a.runRanks} seats=${a.runSeats} surplus=${a.surplus} accepted=${a.accepted}`
    : k === 'E' ? `st ${a.fromStation}(run ${a.fromRun}) -> ${a.destStation}(run ${a.destRun})`
      : k === 'D' ? `station ${a.station} at (${a.gx},${a.gz})`
        : `dest st ${a.destStation} run ${a.destRun} accepted=${a.accepted}`;
  console.log(`  u${a.unitId} ${a.type} alive=${a.alive} width=${a.width} | ${hdr}`);
  console.log(`  settleSec=${f(a.settleSec)}  strict=${JSON.stringify(a.strict)}`);
  console.log(`  occupancy=${JSON.stringify(a.occupancy)}`);
  console.log(`  netMoved med/max ${a.netMovedMed}/${a.netMovedMax}`);
  console.log('  t     n  locus[par,rung,pend,link,grass] | bad off over stone | pile share | onWall farW stuckW outBand | d');
  for (const x of a.samples) {
    const L = x.locus, P = x.pileAt;
    console.log(`  ${String(x.t).padStart(5)} ${String(x.n).padStart(3)} [${L.parapet},${L.rungs},${L.pending},${L.link},${L.grass}] | ${x.badSlots} ${x.offEdge} ${x.overStone} ${x.inStone} | ${x.worstPile}${P && P.onWall ? 'W' : 'g'} ${x.menSharingASlot} | ${x.onWall} ${x.farOnWall} ${x.stuckOnWall} ${x.outBand}/${x.worstOut} | ${x.meanToSlot}/${x.maxToSlot}`);
  }
}
