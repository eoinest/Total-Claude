#!/usr/bin/env node
// Overlay a labelled 100px grid on each Rome II reference plate so crop boxes
// can be read off by eye. Writes to tools/scratch/.grid/ (gitignored scratch).
import sharp from 'sharp';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome2';
const OUT = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/soldier-fidelity/tools/scratch/.grid';
mkdirSync(OUT, { recursive: true });

const files = readdirSync(SRC).filter((f) => f.endsWith('.jpg')).sort();

for (const f of files) {
  const img = sharp(join(SRC, f));
  const { width: W, height: H } = await img.metadata();
  const lines = [];
  for (let x = 0; x <= W; x += 100) {
    const major = x % 500 === 0;
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${major ? '#00ff00' : '#ff00ff'}" stroke-width="${major ? 3 : 1}" opacity="${major ? 0.95 : 0.5}"/>`
    );
    lines.push(
      `<text x="${x + 4}" y="22" font-family="monospace" font-size="26" fill="#00ff00" stroke="#000" stroke-width="0.7">${x}</text>`
    );
    lines.push(
      `<text x="${x + 4}" y="${H - 8}" font-family="monospace" font-size="26" fill="#00ff00" stroke="#000" stroke-width="0.7">${x}</text>`
    );
  }
  for (let y = 0; y <= H; y += 100) {
    const major = y % 500 === 0;
    lines.push(
      `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${major ? '#00ff00' : '#ff00ff'}" stroke-width="${major ? 3 : 1}" opacity="${major ? 0.95 : 0.5}"/>`
    );
    lines.push(
      `<text x="4" y="${y - 6}" font-family="monospace" font-size="26" fill="#ffff00" stroke="#000" stroke-width="0.7">${y}</text>`
    );
    lines.push(
      `<text x="${W - 90}" y="${y - 6}" font-family="monospace" font-size="26" fill="#ffff00" stroke="#000" stroke-width="0.7">${y}</text>`
    );
  }
  // Wordmark exclusion zone
  lines.push(
    `<rect x="1400" y="820" width="${W - 1400}" height="${H - 820}" fill="none" stroke="#ff0000" stroke-width="5"/>`
  );
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join('')}</svg>`
  );
  await sharp(join(SRC, f))
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(join(OUT, f.replace('.jpg', '-grid.png')));
  console.log('grid', f, W, 'x', H);
}
