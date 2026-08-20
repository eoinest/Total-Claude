/** Casualties by faction over the assault — who is killing whom, before and after. */
import { chromium } from 'playwright';
const arg=(k,d)=>(process.argv.find(a=>a.startsWith(`--${k}=`))??`--${k}=${d}`).split('=').slice(1).join('=');
const PORT=Number(arg('port',5487)), LABEL=arg('label','run');
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader']});
const p=await b.newPage({viewport:{width:800,height:500}});
const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&scenario=assault&autoplay=1&quality=low`,{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__game?.ready===true,null,{timeout:300000});
const r=await p.evaluate(`(()=>{
  const g=window.__game,pl=g.battle.pool;g.engine.stop();
  const F=1/30,tick=()=>g.engine.advance(F,1000/30);
  const snap=()=>{const c={};for(let i=0;i<pl.count;i++){if(!pl.aliveAt(i))continue;const f=pl.faction[i];c[f]=(c[f]||0)+1;}return c;};
  const out=[{t:0,c:snap()}];
  for(const t of [20,40,60,90]){while(g.engine.time.simTime<t)tick();out.push({t,c:snap()});}
  return out;
})()`);
const f0=r[0].c;
console.log(`--- ${LABEL} ---`);
for(const row of r){
  const parts=Object.keys(row.c).sort().map(f=>`f${f} ${row.c[f]} (lost ${f0[f]-row.c[f]})`);
  console.log(`t+${String(row.t).padStart(2)}  ${parts.join('   ')}`);
}
console.log('pageerrors',errs.length);
await b.close();
