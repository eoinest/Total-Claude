import { chromium } from 'playwright';
const PORT = Number((process.argv.find(a=>a.startsWith('--port='))||'--port=5926').split('=')[1]);
const MAP = (process.argv.find(a=>a.startsWith('--map='))||'--map=campus-martius').split('=')[1];
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' })).toString('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(()=>null);
if(!r||!r.ok){console.error('no dev server');process.exit(2);}
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal'] });
const p = await b.newPage({viewport:{width:1280,height:720}});
await p.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
await p.waitForFunction(()=>window.__game&&window.__game.ready,null,{timeout:180000});
const out = await p.evaluate(() => {
  const g = window.__game; const city = g.engine.ctx.tryGet('city');
  const res = [];
  for (const gate of city.getGates()) {
    city.setGateOpen(gate.id, true);
    // collision: sweep x across the gate asking blocksMovement on a short cross-wall segment
    const zc = gate.z; let openLo=null, openHi=null;
    for (let d=-12; d<=12; d+=0.05) {
      const x = gate.x + d;
      const blocked = city.blocksMovement(x, zc-14, x, zc+14);
      if (!blocked) { if(openLo===null) openLo=d; openHi=d; }
    }
    // occupancy raster: blocksMovement is the raster+box union; probe the raster alone via
    // a degenerate point query on the wall centreline at fine steps
    let occLo=null, occHi=null;
    for (let d=-12; d<=12; d+=0.05) {
      const x = gate.x + d;
      const blocked = city.blocksMovement(x, zc, x, zc);
      if (!blocked) { if(occLo===null) occLo=d; occHi=d; }
    }
    // obstacle boxes: nearest box faces either side of the gate on the wall line
    const obs = city.getObstacles().filter(o => Math.abs(o.z - zc) < 30 && Math.abs(o.x - gate.x) < 40);
    res.push({ id: gate.id, x:+gate.x.toFixed(2), z:+zc.toFixed(2),
      declaredOpenWidth: city.cityPlan.gateOpenWidth,
      crossSegmentOpen: openLo===null?0:+(openHi-openLo+0.05).toFixed(2),
      pointOpen: occLo===null?0:+(occHi-occLo+0.05).toFixed(2),
      nearObstacles: obs.length });
    city.setGateOpen(gate.id, false);
    let shutLo=null, shutHi=null;
    for (let d=-12; d<=12; d+=0.05){ const x=gate.x+d; if(!city.blocksMovement(x,zc-14,x,zc+14)){ if(shutLo===null)shutLo=d; shutHi=d; } }
    res[res.length-1].shutOpen = shutLo===null?0:+(shutHi-shutLo+0.05).toFixed(2);
  }
  return res;
});
console.log(JSON.stringify(out,null,1));
await b.close();
