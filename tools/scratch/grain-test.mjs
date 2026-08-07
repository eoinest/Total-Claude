import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs';
const B=32;
const luma=(d,w,h,c)=>{const o=new Float64Array(w*h);for(let i=0,p=0;i<w*h;i++,p+=c)o[i]=(0.2126*d[p]+0.7152*d[p+1]+0.0722*d[p+2])/255;return o;};
function smoothFrac(img,w,h){let n=0,s=0;for(let by=0;by+B<=h;by+=B)for(let bx=0;bx+B<=w;bx+=B){let ls=0,ls2=0,m=0;
 for(let y=0;y<B;y++)for(let x=0;x<B;x++){const gx=bx+x,gy=by+y,i=gy*w+gx;if(gx>0&&gy>0&&gx<w-1&&gy<h-1){const l=(4*img[i]-img[i-1]-img[i+1]-img[i-w]-img[i+w])*255;ls+=l;ls2+=l*l;m++;}}
 if(m>1&&Math.sqrt(Math.max(0,ls2/m-(ls/m)**2))<1.0)s++;n++;}return 100*s/n;}
async function sf(f){const{data,info}=await sharp(f).raw().toBuffer({resolveWithObject:true});return smoothFrac(luma(data,info.width,info.height,info.channels),info.width,info.height);}
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--hide-scrollbars']});
const p=await b.newPage({viewport:{width:900,height:1200},deviceScaleFactor:2});
await p.goto('http://127.0.0.1:5199/viewer.html',{waitUntil:'domcontentloaded'});
await p.waitForFunction(()=>window.__viewer&&window.__viewer.ready===true,null,{timeout:180000});
await p.evaluate(()=>{for(const s of ['#viewer-panel','#viewer-readout','#viewer-boot'])document.querySelector(s)?.remove();
 const c=document.getElementById('viewer-canvas');if(c){c.style.position='absolute';c.style.inset='0';c.style.width='100%';c.style.height='100%';}window.dispatchEvent(new Event('resize'));});
fs.mkdirSync('screenshots/grain',{recursive:true});
const out={};
for(const [name,g] of [['grain016',0.016],['grain000',0],['grain006',0.006],['grain016b',0.016]]){
  await p.evaluate(()=>window.__viewer.plate({unit:'legio-cohort',hash:0.37,lod:0,clip:'idleAlertReady',phase:0.32,azimuth:-0.85,elevation:0.05,fill:0.88}));
  await p.evaluate((v)=>window.__viewer.setGrain(v),g);
  for(let i=0;i<3;i++) await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const f=`screenshots/grain/${name}.png`; await p.screenshot({path:f,type:'png'});
  out[name]=await sf(f);
}
await b.close();
console.log('OUR PLATE smoothFrac% (32px blocks, Laplacian std < 1.0):');
for(const k in out) console.log('  '+k.padEnd(12), out[k].toFixed(2));
console.log('\nROME II crops:');
const refs=fs.readdirSync('reference-crops').filter(f=>f.endsWith('.png'));
let acc=[];
for(const r of refs){const v=await sf('reference-crops/'+r);acc.push(v);console.log('  '+r.padEnd(20), v.toFixed(2));}
console.log('  mean', (acc.reduce((a,b)=>a+b,0)/acc.length).toFixed(2), ' range', Math.min(...acc).toFixed(2),'-',Math.max(...acc).toFixed(2));
