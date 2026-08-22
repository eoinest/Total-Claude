// Same as crop.mjs but draws a survey-metre grid relative to the nominal centre, so a
// position can be read OFF the plate rather than eyeballed against the survey rectangle.
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ernestmccarter/Documents/dev/Total-Claude/package.json')('sharp');
import { pxOf } from './plate.mjs';
const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png';

export async function crop2(out, cE, cN, halfM, rects, step = 50, W = 1000) {
  const c = pxOf(cE, cN);
  const halfPx = Math.round(halfM / 1.71);
  const left = Math.round(c.px - halfPx), top = Math.round(c.py - halfPx);
  const size = halfPx * 2, s = W / size;
  const P = (e, n) => { const p = pxOf(e, n); return [(p.px - left) * s, (p.py - top) * s]; };
  const parts = [];
  // grid in survey metres, aligned to the survey frame (so it is NOT axis aligned on the plate)
  for (let d = -halfM; d <= halfM; d += step) {
    const major = Math.abs(d % (step * 2)) < 1e-6;
    const col = d === 0 ? '#0a0' : (major ? '#3af' : '#9cf');
    const wdt = d === 0 ? 1.6 : (major ? 1.0 : 0.5);
    const a = P(cE + d, cN - halfM), b = P(cE + d, cN + halfM);
    parts.push(`<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${col}" stroke-width="${wdt}" opacity="0.75"/>`);
    const p2 = P(cE - halfM, cN + d), q2 = P(cE + halfM, cN + d);
    parts.push(`<line x1="${p2[0].toFixed(1)}" y1="${p2[1].toFixed(1)}" x2="${q2[0].toFixed(1)}" y2="${q2[1].toFixed(1)}" stroke="${col}" stroke-width="${wdt}" opacity="0.75"/>`);
    if (major && d !== 0) {
      const t1 = P(cE + d, cN + halfM * 0.92); parts.push(`<text x="${t1[0].toFixed(1)}" y="${t1[1].toFixed(1)}" font-family="monospace" font-size="14" fill="#06c">${d > 0 ? '+' : ''}${d}E</text>`);
      const t2 = P(cE - halfM * 0.94, cN + d); parts.push(`<text x="${t2[0].toFixed(1)}" y="${t2[1].toFixed(1)}" font-family="monospace" font-size="14" fill="#06c">${d > 0 ? '+' : ''}${d}N</text>`);
    }
  }
  for (const r of rects) {
    const th = ((r.bearing ?? 0) * Math.PI) / 180;
    const ux = Math.sin(th), uy = Math.cos(th), vx = Math.cos(th), vy = -Math.sin(th);
    const hl = r.len / 2, hw = r.wid / 2;
    const pts = [[1,1],[1,-1],[-1,-1],[-1,1]].map(([a,b]) => P(r.e + a*hl*ux + b*hw*vx, r.n + a*hl*uy + b*hw*vy).map(v=>v.toFixed(1)).join(',')).join(' ');
    const cc = P(r.e, r.n);
    parts.push(`<polygon points="${pts}" fill="none" stroke="${r.colour||'#e00'}" stroke-width="2.5"/>`);
    parts.push(`<circle cx="${cc[0].toFixed(1)}" cy="${cc[1].toFixed(1)}" r="4" fill="${r.colour||'#e00'}"/>`);
  }
  parts.push(`<text x="8" y="22" font-family="monospace" font-size="18" fill="#000" stroke="#fff" stroke-width="0.5">${rects[0]?.label||''} — grid ${step} m, centre (${cE}, ${cN})</text>`);
  const svg = `<svg width="${W}" height="${W}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  await sharp(SRC).extract({ left: Math.max(0,left), top: Math.max(0,top), width: size, height: size })
    .resize(W, W, { kernel: 'lanczos3' }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
}
