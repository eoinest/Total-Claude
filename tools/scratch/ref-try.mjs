#!/usr/bin/env node
// Ad-hoc crop trials: node tools/scratch/ref-try.mjs r2-00 1200 110 360 480 [more...]
// Writes unresized trials to tools/scratch/.try/ for eyeballing.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/ernestmccarter/Documents/dev/Total-Claude/reference/rome2';
const TRY = '/Users/ernestmccarter/Documents/dev/Total-Claude/.claude/worktrees/soldier-fidelity/tools/scratch/.try';
mkdirSync(TRY, { recursive: true });

const a = process.argv.slice(2);
for (let i = 0; i + 4 < a.length; i += 5) {
  const plate = a[i];
  const [x, y, w, h] = a.slice(i + 1, i + 5).map(Number);
  const name = `${plate}_${x}-${y}-${w}-${h}.png`;
  await sharp(join(SRC, `${plate}.jpg`))
    .extract({ left: x, top: y, width: w, height: h })
    .png()
    .toFile(join(TRY, name));
  console.log(name, 'ar=', (w / h).toFixed(2), 'right=', x + w, 'bottom=', y + h);
}
