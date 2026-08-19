import sharp from 'sharp';
const [,, src, dst, x, y, w, h, scale] = process.argv;
await sharp(src).extract({ left: +x, top: +y, width: +w, height: +h })
  .resize({ width: Math.round(+w * (+scale || 3)), kernel: 'nearest' })
  .toFile(dst);
console.log('ok', dst);
