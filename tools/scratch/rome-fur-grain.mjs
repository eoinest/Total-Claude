import fs from 'fs';
const g=JSON.parse(fs.readFileSync('/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-forma-urbis-severiana-vector-EPSG4326.geo.json','utf8'));
const MLAT=111132, MLON=82857;
const byLayer={};
for(const f of g.features){ const L=f.properties.layer; byLayer[L]=(byLayer[L]||0)+1; }
console.log('layers', JSON.stringify(byLayer));
// collect segment lengths from the interior-line layer
const segs=[];
let poly=0;
for(const f of g.features){
  if(f.properties.layer!=='002_fum_caratt_interna') continue;
  const gg=f.geometry;
  const rings = gg.type==='MultiPolygon' ? gg.coordinates.flat() : gg.type==='Polygon' ? gg.coordinates : gg.type==='MultiLineString' ? gg.coordinates : [gg.coordinates];
  for(const r of rings){ poly++;
    for(let i=1;i<r.length;i++){ const a=r[i-1], b=r[i];
      const dx=(b[0]-a[0])*MLON, dy=(b[1]-a[1])*MLAT; const L=Math.hypot(dx,dy);
      if(L>0.05 && L<200) segs.push(L); } }
}
console.log('interior rings', poly, 'segments', segs.length);
segs.sort((a,b)=>a-b);
const q=p=>segs[Math.floor(p*segs.length)];
console.log('segment length quantiles (m): p10',q(.1).toFixed(2),'p25',q(.25).toFixed(2),'p50',q(.5).toFixed(2),'p75',q(.75).toFixed(2),'p90',q(.9).toFixed(2),'p99',q(.99).toFixed(2));
// histogram of the LONG segments (walls of rooms), 0.5 m bins up to 60
const H=new Array(120).fill(0);
for(const L of segs) if(L<60) H[Math.floor(L/0.5)]++;
console.log('\nhistogram, 0.5 m bins (only bins > 0.4% of total):');
const tot=segs.filter(L=>L<60).length;
for(let i=0;i<120;i++){ if(H[i]/tot>0.004) console.log(`  ${(i*0.5).toFixed(1)}-${(i*0.5+0.5).toFixed(1)} m  ${String(H[i]).padStart(5)}  ${'#'.repeat(Math.round(H[i]/tot*400))}`); }
// Roman foot test: modulus of segment length against 0.296 m
const PES=0.296;
const bins=new Array(40).fill(0);
let n=0;
for(const L of segs){ if(L<1.5||L>40) continue; const m=(L/PES)%1; bins[Math.floor(m*40)]++; n++; }
console.log(`\nfractional part of length/0.296 m over ${n} segments (uniform would be ${(n/40).toFixed(0)} per bin):`);
let s=''; for(let i=0;i<40;i++) s+= (bins[i]/(n/40)).toFixed(2)+' ';
console.log(' ',s);
const chi = bins.reduce((a,b)=>a+Math.pow(b-n/40,2)/(n/40),0);
console.log('  chi2(39 df) =', chi.toFixed(1), ' (critical 54.6 at p=0.05)');
// same against a 1 m grid as a control
const bins2=new Array(40).fill(0); let n2=0;
for(const L of segs){ if(L<1.5||L>40) continue; const m=(L/1.0)%1; bins2[Math.floor(m*40)]++; n2++; }
const chi2 = bins2.reduce((a,b)=>a+Math.pow(b-n2/40,2)/(n2/40),0);
console.log('  control, modulus 1.000 m: chi2 =', chi2.toFixed(1));
