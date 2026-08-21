import fs from 'fs';
const files = [
 '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-1m-central-rome-EPSG4326.geo.json',
 '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-ne-quadrant-EPSG4326.geo.json'];
const V=[];
for (const p of files){ const g=JSON.parse(fs.readFileSync(p,'utf8'));
  for(const f of g.features){ const a=+f.properties.altitudine;
    for(const l of f.geometry.coordinates) for(const [lo,la] of l) V.push([lo,la,a]); } }
console.log('vertices', V.length);
const MLAT=111132, MLON=82857;
// Bucket into a grid for speed
const CS=0.0015; const grid=new Map();
for(let i=0;i<V.length;i++){ const k=Math.floor(V[i][1]/CS)+'|'+Math.floor(V[i][0]/CS); let b=grid.get(k); if(!b){b=[];grid.set(k,b);} b.push(i); }
function near(lat,lon,rings){ const r0=Math.floor(lat/CS), c0=Math.floor(lon/CS); const out=[];
  for(let r=r0-rings;r<=r0+rings;r++) for(let c=c0-rings;c<=c0+rings;c++){ const b=grid.get(r+'|'+c); if(b) out.push(...b); } return out; }
function sample(lat,lon){
  let cand=[]; for(let rings=1; rings<=6 && cand.length<40; rings++) cand=near(lat,lon,rings);
  let best=null,bd=1e18;
  for(const i of cand){ const [lo,la,a]=V[i]; const dx=(lo-lon)*MLON, dy=(la-lat)*MLAT; const d=dx*dx+dy*dy; if(d<bd){bd=d;best=V[i];} }
  if(!best) return null;
  const d1=Math.sqrt(bd), a1=best[2];
  let b2=null,bd2=1e18;
  for(const i of cand){ const [lo,la,a]=V[i]; if(a===a1) continue; const dx=(lo-lon)*MLON, dy=(la-lat)*MLAT; const d=dx*dx+dy*dy; if(d<bd2){bd2=d;b2=V[i];} }
  if(!b2) return { h:a1, a1, d1, a2:null, d2:null };
  const d2=Math.sqrt(bd2), a2=b2[2];
  return { h: a1 + (a2-a1)*(d1/(d1+d2)), a1, d1, a2, d2 };
}
const pts = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
for (const [name,lat,lon] of pts){
  const s = sample(lat,lon);
  if(!s){ console.log(`${name.padEnd(42)}  no data`); continue; }
  const trust = s.d1<=60 && (s.d2===null || s.d2<=140) ? '' : '   (SPARSE — nearest contour '+s.d1.toFixed(0)+' m)';
  console.log(`${name.padEnd(42)} ${s.h.toFixed(1).padStart(6)} m   [${s.a1} @ ${s.d1.toFixed(0)}m , ${s.a2} @ ${s.d2===null?'-':s.d2.toFixed(0)}m]${trust}`);
}
