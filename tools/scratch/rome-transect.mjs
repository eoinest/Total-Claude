import fs from 'fs';
const files=['/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-1m-central-rome-EPSG4326.geo.json','/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/sitar-ptrs-1924-contours-ne-quadrant-EPSG4326.geo.json'];
const V=[]; for(const p of files){const g=JSON.parse(fs.readFileSync(p,'utf8'));
 for(const f of g.features){const a=+f.properties.altitudine; for(const l of f.geometry.coordinates) for(const [lo,la] of l) V.push([lo,la,a]);}}
const MLAT=111132,MLON=82857,LAT0=41.8925,LON0=12.4823, KX=0.443,KZ=0.222,X0=292.17,Z0=983.74;
const CS=0.0012; const grid=new Map();
V.forEach((v,i)=>{const k=Math.floor(v[1]/CS)+'|'+Math.floor(v[0]/CS); let b=grid.get(k); if(!b){b=[];grid.set(k,b);} b.push(i);});
function nearest(lat,lon){const r0=Math.floor(lat/CS),c0=Math.floor(lon/CS);let b=null,bd=1e18;
 for(let R=1;R<=6;R++){for(let r=r0-R;r<=r0+R;r++)for(let c=c0-R;c<=c0+R;c++){const bb=grid.get(r+'|'+c);if(!bb)continue;
  for(const i of bb){const v=V[i];const dx=(v[0]-lon)*MLON,dy=(v[1]-lat)*MLAT,d=dx*dx+dy*dy;if(d<bd){bd=d;b=v;}}}
  if(b&&Math.sqrt(bd)<R*CS*MLON*0.9)break;} return b?{a:b[2],d:Math.sqrt(bd)}:null;}
function run(label,lon,la0,la1,N){
 console.log(`\n${label}   (lon ${lon}, e ${((lon-LON0)*MLON).toFixed(0)}, x ${(X0+KX*(lon-LON0)*MLON).toFixed(0)})`);
 console.log('     n |     z |  h | contour dist | reliability');
 for(let i=0;i<=N;i++){const la=la0+(la1-la0)*i/N;const r=nearest(la,lon);
  const n=(la-LAT0)*MLAT,z=Z0-KZ*n;
  console.log(`${n.toFixed(0).padStart(6)} | ${z.toFixed(0).padStart(5)} | ${r?String(r.a).padStart(2):' ?'} | ${r?r.d.toFixed(0).padStart(5):'    ?'} m | ${r&&r.d<35?'measured':r&&r.d<90?'weak':'NO DATA'}`);}}
run('N-S across the Muro Torto / Pincian north scarp', 12.48220, 41.91500, 41.90600, 22);
run('N-S down the Via Flaminia at the Porta Flaminia', 12.47630, 41.92000, 41.90600, 24);
run('N-S at Porta Pinciana', 12.48870, 41.91400, 41.90400, 22);
run('N-S at Porta Salaria', 12.49480, 41.91400, 41.90400, 22);
