import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--use-gl=angle','--use-angle=metal'] });
for (const dsf of [1,2]) {
  const p = await b.newPage({ viewport:{width:1600,height:900}, deviceScaleFactor: dsf });
  await p.goto('http://127.0.0.1:5735/?harness=1&w=1600&h=900&map=rome&quality=ultra&scenario=assault&autoplay=1',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>window.__game?.ready===true,null,{timeout:300000});
  await p.evaluate(()=>window.__game.advance(60));
  const r = await p.evaluate(async (dsf) => {
    const eng = window.__game.engine;
    const gl = eng.renderer.getContext();
    const px = new Uint8Array(4);
    const drain = () => gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);
    const out = { scale: [], };
    for (const s of [1.0, 0.7, 0.5, 1.0]) {
      eng.applyRenderQuality({ renderScale: s });
      for (let i=0;i<5;i++) await new Promise(r=>requestAnimationFrame(r));
      const iv=[], rm=[], dr=[];
      let last = performance.now();
      for (let i=0;i<90;i++) {
        await new Promise(r=>requestAnimationFrame(r));
        const n = performance.now(); iv.push(n-last); last=n;
        rm.push(eng.lastRenderMs);
        // drained wall clock: a 1x1 readPixels is a real round trip; gl.finish is not.
        const t0=performance.now(); drain(); dr.push(performance.now()-t0);
      }
      const q=(a,f)=>{const s2=[...a].sort((x,y)=>x-y);return +s2[Math.round(f*(s2.length-1))].toFixed(2);};
      out.scale.push({ s, db: eng.drawingBufferSize(),
        iv:{p50:q(iv,.5),p90:q(iv,.9)}, render:{p50:q(rm,.5),p90:q(rm,.9)}, drain:{p50:q(dr,.5),p90:q(dr,.9)} });
    }
    eng.applyRenderQuality({renderScale:1});
    return out;
  }, dsf);
  console.log(`dsf=${dsf}`); for (const x of r.scale) console.log('  ', JSON.stringify(x));
  await p.close();
}
await b.close();
