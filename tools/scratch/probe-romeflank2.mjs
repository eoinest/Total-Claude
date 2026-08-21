import { chromium } from 'playwright';
const PORT = Number((process.argv.find(a=>a.startsWith('--port='))||'--port=5926').split('=')[1]);
const token = Buffer.from(JSON.stringify({ map: 'campus-martius', scenario: 'assault' })).toString('base64')
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(()=>null);
if(!r||!r.ok){console.error('no dev server');process.exit(2);}
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal'] });
const p = await b.newPage({viewport:{width:1280,height:720}});
await p.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
await p.waitForFunction(()=>window.__game&&window.__game.ready,null,{timeout:180000});
const out = await p.evaluate(() => {
  const g = window.__game;
  const city = g.engine.ctx.tryGet('city');
  const terrain = g.engine.ctx.tryGet('terrain');
  const nav = g.engine.ctx.tryGet('pathfinding') ?? g.pathfinding ?? null;
  // Tiber cross-section at the wall's latitude and at mid-approach
  const prof = [];
  for (const z of [-190, 0, 250, 480, 530]) {
    const row = [];
    for (let x = -1000; x <= -450; x += 10) row.push([x, +terrain.heightAt(x, z).toFixed(2)]);
    const deep = row.filter(([,h]) => h < 1.5).length;
    const wet  = row.filter(([,h]) => h < 5.0).length;
    prof.push({ z, minH: Math.min(...row.map(r=>r[1])), cellsBelowDrown: deep, cellsUnderWater: wet,
                span: row.filter(([,h])=>h<5.0).map(([x])=>x) });
  }
  const st = city.stats();
  // ground height along the wall line, and along the approach at the gate
  const bays = city.getGarrisonBays();
  const zAt = (x) => { let bb=bays[0],bd=1e9; for(const q of bays){const d=Math.abs(((q.x0+(q.x1??q.x0))*0.5)-x); if(d<bd){bd=d;bb=q;}} return (bb.z0+(bb.z1??bb.z0))*0.5; };
  const crest = []; for(let x=-635;x<=1145;x+=20) crest.push([x, +zAt(x).toFixed(0), +terrain.heightAt(x,zAt(x)).toFixed(1)]);
  const walkY = bays.map(q=>+((q.walkY??0)).toFixed(2));
  return {
    tiber: prof,
    crest,
    walkYMin: Math.min(...walkY), walkYMax: Math.max(...walkY),
    walkStepMax: Math.max(...walkY.slice(1).map((v,i)=>Math.abs(v-walkY[i]))),
    walkSteps: walkY.slice(1).map((v,i)=>+(v-walkY[i]).toFixed(2)),
    stats: { draws: st.visibleMeshes, tris: +(st.visibleTriangles/1e6).toFixed(2), chunks: st.chunks,
             drawsByFamily: st.drawsByFamily, checks: st.checks },
    navWaterLevel: nav ? nav.waterLevel : 'no handle',
  };
});
console.log("CREST x,z,groundH:"); out.crest.forEach(c=>console.log("  ",c.join("\t")));
console.log("walkY min",out.walkYMin,"max",out.walkYMax,"maxStep",out.walkStepMax);
console.log("steps",out.walkSteps.join(" "));
console.log("stats",JSON.stringify(out.stats).slice(0,3000));
await b.close();
