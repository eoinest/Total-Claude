import fs from 'fs';
const files=['/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-1m-central-rome-EPSG4326.geo.json','/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-ne-quadrant-EPSG4326.geo.json'];
const V=[]; for(const p of files){const g=JSON.parse(fs.readFileSync(p,'utf8'));
 for(const f of g.features){const a=+f.properties.altitudine; for(const l of f.geometry.coordinates) for(const [lo,la] of l) V.push([lo,la,a]);}}
const MLAT=111132,MLON=82857, LAT0=41.8925, LON0=12.4823;
const CS=0.0012; const grid=new Map();
V.forEach((v,i)=>{const k=Math.floor(v[1]/CS)+'|'+Math.floor(v[0]/CS); let b=grid.get(k); if(!b){b=[];grid.set(k,b);} b.push(i);});
function nearest(lat,lon){ const r0=Math.floor(lat/CS),c0=Math.floor(lon/CS); let b=null,bd=1e18;
 for(let R=1;R<=5;R++){ for(let r=r0-R;r<=r0+R;r++)for(let c=c0-R;c<=c0+R;c++){const bb=grid.get(r+'|'+c); if(!bb)continue;
   for(const i of bb){const v=V[i];const dx=(v[0]-lon)*MLON,dy=(v[1]-lat)*MLAT,d=dx*dx+dy*dy;if(d<bd){bd=d;b=v;}}}
   if(b && Math.sqrt(bd) < R*CS*MLON*0.9) break; }
 return b?{a:b[2],d:Math.sqrt(bd)}:null; }
// Aurelian circuit waypoints, Tiber -> Castra Praetoria (lat, lon)
const WP=[
 ['Tiber / NW corner',      41.91055, 12.47440],
 ['Porta Flaminia',         41.91090, 12.47630],
 ['Muro Torto W foot',      41.91085, 12.47900],
 ['Muro Torto mid',         41.91045, 12.48220],
 ['Muro Torto E / Pincio',  41.90985, 12.48560],
 ['Porta Pinciana',         41.90860, 12.48870],
 ['Vallis Sallust. lip',    41.90855, 12.49150],
 ['Porta Salaria',          41.90855, 12.49480],
 ['Sallust. E shoulder',    41.90830, 12.49800],
 ['Castra Pr. approach',    41.90810, 12.50100],
 ['Porta Nomentana',        41.90855, 12.50440],
 ['Castra Praetoria NW',    41.90790, 12.50560],
 ['Castra Praetoria NE',    41.90670, 12.51070],
 ['Castra Praetoria SE',    41.90380, 12.51000],
];
const STEP=40;
console.log('e/n are metres E/N of the Temple of Jupiter OM (41.8925 N, 12.4823 E)');
console.log('cum  |    e    |    n    | h (m a.s.l., 1924 survey) | nearest contour dist | note');
let cum=0;
for(let s=0;s<WP.length-1;s++){
  const [n0,la0,lo0]=WP[s], [n1,la1,lo1]=WP[s+1];
  const dx=(lo1-lo0)*MLON, dy=(la1-la0)*MLAT, L=Math.hypot(dx,dy);
  const steps=Math.max(1,Math.round(L/STEP));
  for(let i=0;i<steps;i++){
    const t=i/steps, la=la0+(la1-la0)*t, lo=lo0+(lo1-lo0)*t;
    const r=nearest(la,lo); const e=(lo-LON0)*MLON, n=(la-LAT0)*MLAT;
    const tag = i===0 ? n0 : '';
    const rel = r && r.d<35 ? 'measured' : r && r.d<90 ? 'weak' : 'NO DATA';
    console.log(`${cum.toFixed(0).padStart(4)} | ${e.toFixed(0).padStart(7)} | ${n.toFixed(0).padStart(7)} | ${r?String(r.a).padStart(4):'   ?'} | ${r?r.d.toFixed(0).padStart(5):'    ?'} m | ${rel.padEnd(8)} ${tag}`);
    cum += L/steps;
  }
}
const last=WP[WP.length-1]; const r=nearest(last[1],last[2]);
console.log(`${cum.toFixed(0).padStart(4)} | ${((last[2]-LON0)*MLON).toFixed(0).padStart(7)} | ${((last[1]-LAT0)*MLAT).toFixed(0).padStart(7)} | ${String(r.a).padStart(4)} | ${r.d.toFixed(0).padStart(5)} m |          ${last[0]}`);
console.log('\nTOTAL circuit length modelled:', cum.toFixed(0), 'real m  ->  at KX 0.443:', (cum*0.443).toFixed(0), 'world m');
