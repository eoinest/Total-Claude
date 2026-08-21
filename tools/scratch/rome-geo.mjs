const MLAT=111132, MLON=82857, LAT0=41.8925, LON0=12.4823;
const KX=0.443, KZ=0.222;
const riseToeZ=(x)=>330+52*Math.sin(x*0.00476)+26*Math.sin(x*0.01053+2.1);
const crestZAt=(x)=>riseToeZ(x)+175;
const roadCentreX=(z)=>20+34*Math.sin((z+300)*0.0018519)-18*Math.sin((z+900)*0.0033333);
let gx=20; for(let i=0;i<6;i++) gx=roadCentreX(crestZAt(gx)); gx=Math.round(gx*10)/10;
const gz=crestZAt(gx);
const X0=gx-KX*(-497), Z0=gz+KZ*2045;
const W=(lat,lon)=>{const e=(lon-LON0)*MLON,n=(lat-LAT0)*MLAT;return{e,n,x:X0+KX*e,z:Z0-KZ*n};};
const riverCentreX=(z)=>-760+130*Math.sin(z*0.0023256)+50*Math.sin(z*0.0060606+1.3);

console.log(`X0 ${X0.toFixed(2)}  Z0 ${Z0.toFixed(2)}  GATE_X ${gx}  GATE_Z ${gz.toFixed(2)}\n`);

const LINE=[
 ['NW corner, Tiber left bank', 41.91055,12.47440],
 ['Porta Flaminia',             41.91090,12.47630],
 ['Muro Torto, west foot',      41.91085,12.47900],
 ['Muro Torto, mid',            41.91045,12.48220],
 ['Muro Torto, east / crest',   41.90985,12.48560],
 ['Porta Pinciana',             41.90860,12.48870],
 ['Vallis Sallustiana, W lip',  41.90855,12.49150],
 ['Porta Salaria',              41.90855,12.49480],
 ['Vallis Sallustiana, E lip',  41.90830,12.49800],
 ['Porta Nomentana',            41.90855,12.50440],
 ['Castra Praetoria, NW angle', 41.90790,12.50560],
 ['Castra Praetoria, NE angle', 41.90670,12.51070],
 ['Castra Praetoria, SE angle', 41.90380,12.51000],
 ['Porta Tiburtina (off map)',  41.89550,12.51500],
];
console.log('THE CIRCUIT — survey frame and world frame');
console.log('feature                          |      e |      n |      x |     z | dx from prev | bearing off +x');
let px=null,pz=null,runX=0,runL=0;
for(const [nm,la,lo] of LINE){ const w=W(la,lo);
 let d='',b='';
 if(px!==null){const ddx=w.x-px, ddz=w.z-pz; d=ddx.toFixed(1); b=(Math.atan2(ddz,ddx)*180/Math.PI).toFixed(1)+'°'; runX+=Math.abs(ddx); runL+=Math.hypot(ddx,ddz);}
 console.log(`${nm.padEnd(32)} | ${w.e.toFixed(0).padStart(6)} | ${w.n.toFixed(0).padStart(6)} | ${w.x.toFixed(1).padStart(6)} | ${w.z.toFixed(1).padStart(5)} | ${d.padStart(12)} | ${b.padStart(8)}`);
 px=w.x;pz=w.z; }
console.log(`\ntotal along-line world length ${runL.toFixed(0)} m, x-extent ${runX.toFixed(0)} m`);
// front only: NW corner -> Castra NE
const a=W(41.91055,12.47440), b=W(41.90670,12.51070);
console.log(`front (NW corner -> Castra NE): x ${a.x.toFixed(1)} .. ${b.x.toFixed(1)}  = ${(b.x-a.x).toFixed(0)} world m ; z ${a.z.toFixed(1)} .. ${b.z.toFixed(1)}`);
for(const sp of [29.6, 35.5, 44.4]) console.log(`  bays at ${sp} m pitch in x: ${((b.x-a.x)/sp).toFixed(1)}   real spacing implied ${(sp/KX).toFixed(1)} m`);

// The real Tiber course, projected
console.log('\nTHE TIBER, real course projected into the world frame');
const TIB=[
 [41.9450,12.4600],[41.9352,12.4670],[41.9270,12.4700],[41.9200,12.4712],
 [41.9130,12.4718],[41.9052,12.4723],[41.9020,12.4700],[41.9013,12.4665],
 [41.8990,12.4650],[41.8965,12.4640],[41.8945,12.4661],[41.8930,12.4700],
 [41.8905,12.4755],[41.8905,12.4778],[41.8870,12.4790],[41.8820,12.4760],
 [41.8770,12.4740],[41.8700,12.4720]];
console.log('   lat      lon    |     e |     n |      x |      z | modelled riverCentreX(z) | error');
for(const [la,lo] of TIB){ const w=W(la,lo); const m=riverCentreX(w.z);
  console.log(`  ${la.toFixed(4)} ${lo.toFixed(4)} | ${w.e.toFixed(0).padStart(5)} | ${w.n.toFixed(0).padStart(5)} | ${w.x.toFixed(0).padStart(6)} | ${w.z.toFixed(0).padStart(6)} | ${m.toFixed(0).padStart(24)} | ${(m-w.x).toFixed(0).padStart(5)}`); }
