import sharp from 'sharp';
for (const src of process.argv.slice(2)) {
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const n = info.width * info.height;
  const hist = new Array(20).fill(0);
  let sumS = 0;
  let below15 = 0;
  let above90 = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * ch] / 255, g = data[i * ch + 1] / 255, b = data[i * ch + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(19, Math.floor(y * 20))]++;
    if (y < 0.15) below15++;
    if (y > 0.90) above90++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sumS += mx === 0 ? 0 : (mx - mn) / mx;
  }
  console.log(src.split('/').slice(-2).join('/'));
  console.log('  meanSat %', (100 * sumS / n).toFixed(1),
    ' <15%L:', (100 * below15 / n).toFixed(2) + '%',
    ' >90%L:', (100 * above90 / n).toFixed(2) + '%');
  console.log('  hist', hist.map((v) => Math.round((100 * v) / n)).join(' '));
}
