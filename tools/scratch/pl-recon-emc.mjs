import { argsOf, boot, shot, dump, ROOT } from './pl-lib-emc.mjs';
import path from 'node:path';
const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const OUT = path.join(ROOT, 'screenshots/playability');
const { browser, page, errs, bootS } = await boot({ port: Number(A.get('port') ?? 5431), map: MAP, out: OUT, label: `recon-${MAP}` });
console.log(`boot ${bootS.toFixed(1)}s  errs=${errs.length}`);
const info = await page.evaluate(() => {
  const g = window.__game;
  const dep = g.deployment;
  return {
    t: g.simTime(),
    dep: dep ? { active: dep.active, zone: JSON.parse(JSON.stringify(dep.zone)), budget: dep.budget(), roster: dep.roster() } : null,
    cam: { x: g.engine.rig.focusX ?? null, z: g.engine.rig.focusZ ?? null, zoom: g.engine.rig.zoom ?? null, yaw: g.engine.rig.yaw ?? null },
    units: window.__units(),
    bays: window.__bays(),
    reports: window.__reports(),
    quality: g.engine.quality.tier,
    hudPanels: Array.from(document.querySelectorAll('.hud-panel')).map(e => e.className),
  };
});
await dump(OUT, `recon-${MAP}`, info);
await shot(page, OUT, `recon-${MAP}-01`);
console.log('quality', info.quality, 'simT', info.t);
console.log('dep', JSON.stringify(info.dep?.zone), JSON.stringify(info.dep?.budget), 'active=', info.dep?.active);
console.log('roster', JSON.stringify(info.dep?.roster));
console.log('units:'); for (const u of info.units) console.log(' ', u.id, u.type, 'f' + u.faction, 'n' + u.alive, `(${u.x},${u.z})`, 'meanY', u.meanY, 'elev', u.elevated);
const b = info.bays;
console.log(`bays ${b.length}: i0 ${JSON.stringify(b[0])}`);
console.log(' garrisonable', b.filter(x => x.garr).length, ' gates', b.filter(x => x.gate).map(x => x.i).join(','));
console.log(' walkY range', Math.min(...b.map(x => x.walkY)).toFixed(2), Math.max(...b.map(x => x.walkY)).toFixed(2));
console.log(' x range', Math.min(...b.map(x => x.cx)).toFixed(0), Math.max(...b.map(x => x.cx)).toFixed(0), ' z', Math.min(...b.map(x => x.cz)).toFixed(0), Math.max(...b.map(x => x.cz)).toFixed(0));
console.log('reports', JSON.stringify(info.reports).slice(0, 3000));
await browser.close();
