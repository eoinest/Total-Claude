import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, buildDistricts, inTheRiverAt } from '../../src/city/rome/fabric.ts';
import { romeKeepOut } from '../../src/city/rome/layout.ts';
import { romeWallZ, WATER_LEVEL, riverOffset, riverInfluence, regionalPlain, riverProfile, riverHalfWidthAt } from '../../src/terrain/topography.ts';
const out = buildDistricts(() => 20, romeKeepOut(), 'rome-fabric', romeWallZ);
const want = [[-408.77,1046.64],[67.13,1336.37],[-456.91,1079.14],[-218.97,1224.05],[759.65,1383.28],[-339.2,926.65]];
for (const [x,z] of want) {
  const d = out.diag.reduce((b,e)=> Math.hypot(e.x-x,e.z-z) < Math.hypot(b.x-x,b.z-z) ? e : b, out.diag[0]);
  const off = riverOffset(x,z); const inf = riverInfluence(off,z);
  const plain = regionalPlain(x,z); const g = plain + (riverProfile(off,z,plain)-plain)*inf;
  console.log(`(${x},${z}) -> block ${d.index} ${d.region} plots ${d.plots} drowned ${d.drowned} urban ${d.urban.toFixed(2)} horti ${d.horti} "${d.emptyBecause}"`);
  console.log(`    riverOffset ${off.toFixed(1)} half ${riverHalfWidthAt(z).toFixed(1)} inf ${inf.toFixed(3)} ground ${g.toFixed(2)} (water ${WATER_LEVEL}) wet=${inTheRiverAt(x,z)}`);
  console.log(`    why`, JSON.stringify(d.why));
}
