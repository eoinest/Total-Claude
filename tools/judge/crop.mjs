// Crop the georeferenced Lanciani raster around a survey position and draw the survey
// rectangle on it, so a human can see whether the rectangle sits on the inked plan.
import { createRequire } from 'node:module';
const sharp = createRequire('/Users/ernestmccarter/Documents/dev/Total-Claude/package.json')('sharp');
import { pxOf } from './plate.mjs';
const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome-plans/lanciani-georef-EPSG3004-2307658_4638583_2314671_4643263-4096px.png';

/** rects: [{e,n,len,wid,bearing,label,colour}]  bearing = deg cw from north of the LONG axis */
export async function crop(out, centreE, centreN, halfM, rects, scale = 1) {
  const c = pxOf(centreE, centreN);
  const halfPx = Math.round(halfM / 1.71);
  const left = Math.round(c.px - halfPx), top = Math.round(c.py - halfPx);
  const size = halfPx * 2;
  const parts = [];
  for (const r of rects) {
    const th = ((r.bearing ?? 0) * Math.PI) / 180; // long axis bearing
    // long axis unit vector in survey metres (e,n): bearing cw from north
    const ux = Math.sin(th), uy = Math.cos(th);
    const vx = Math.cos(th), vy = -Math.sin(th);
    const hl = r.len / 2, hw = r.wid / 2;
    const pts = [[1,1],[1,-1],[-1,-1],[-1,1]].map(([a,b]) => {
      const e = r.e + a*hl*ux + b*hw*vx, n = r.n + a*hl*uy + b*hw*vy;
      const p = pxOf(e, n); return `${((p.px-left)*scale).toFixed(1)},${((p.py-top)*scale).toFixed(1)}`;
    }).join(' ');
    const cp = pxOf(r.e, r.n);
    const cx = (cp.px-left)*scale, cy = (cp.py-top)*scale;
    parts.push(`<polygon points="${pts}" fill="none" stroke="${r.colour||'#e00'}" stroke-width="2.5"/>`);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${r.colour||'#e00'}"/>`);
    if (r.label) parts.push(`<text x="${(cx+8).toFixed(1)}" y="${(cy-8).toFixed(1)}" font-family="monospace" font-size="18" fill="${r.colour||'#e00'}" stroke="#fff" stroke-width="0.6">${r.label}</text>`);
  }
  const W = Math.round(size*scale);
  const svg = `<svg width="${W}" height="${W}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  await sharp(SRC).extract({ left: Math.max(0,left), top: Math.max(0,top), width: size, height: size })
    .resize(W, W).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out);
  return { left, top, size };
}
