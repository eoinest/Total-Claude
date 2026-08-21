/**
 * Where is everything on Rome's rebuilt circuit at t+0, and who can reach the ram?
 *
 * The circuit moved 157 m at `0372fc2` and gained two gates and a posterula. The ram's old
 * killers — `ballistarii#0` and `#1` at 53-60 m — are now 134 m away, so the garrison's
 * *layout* is the thing to look at before anything else is touched.
 */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'ultra';
const SEED = Number(A.get('seed') ?? 4265438264);
const AT = Number(A.get('at') ?? 0);
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 240 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed: SEED })}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
if (AT > 0) await p.evaluate((s) => window.__game.fastForward(s), AT);
const out = await p.evaluate(() => {
  const g = window.__game, b = g.battle, s = b.siege, ctx = g.engine.context;
  const city = ctx.tryGet('city');
  const gates = city.getGates().map((x) => ({ id: x.id, x: +x.x.toFixed(1), z: +x.z.toFixed(1), open: x.open }));
  const rams = s.ramReport().map((r) => ({ id: r.id, kind: r.kind, gateId: r.gateId,
    x: +r.x.toFixed(1), z: +r.z.toFixed(1), tx: +r.targetX.toFixed(1), tz: +r.targetZ.toFixed(1),
    unitId: r.unitId, crew: r.crewAlive, bay: r.bay }));
  const ram = rams[0];
  const units = b.units.map((u) => ({
    id: u.id, type: u.typeId, faction: u.faction, alive: u.alive, x: +u.x.toFixed(1), z: +u.z.toFixed(1),
    garr: !!s.isGarrisoned?.(u.id),
    dRam: ram ? +Math.hypot(u.x - ram.x, u.z - ram.z).toFixed(0) : -1,
    range: (() => { try { return b.typeOf(u.id)?.missile?.range ?? null; } catch { return null; } })(),
  })).sort((a, c) => a.dRam - c.dRam);
  return { gates, rams, units, t: +ctx.time.simTime.toFixed(0), stations: s.stats().stations };
});
console.log(`t+${out.t}  stations ${out.stations}`);
console.log('gates:', JSON.stringify(out.gates));
console.log('rams :', JSON.stringify(out.rams));
console.log('units by distance from the ram:');
for (const u of out.units) {
  console.log(`  ${String(u.dRam).padStart(4)} m  f${u.faction} ${u.type.padEnd(18)} #${String(u.id).padStart(2)}`
    + ` alive ${String(u.alive).padStart(4)} at (${u.x}, ${u.z})${u.garr ? ' GARRISON' : ''}`
    + (u.range !== null ? `  range ${u.range}` : ''));
}
await b.close();
