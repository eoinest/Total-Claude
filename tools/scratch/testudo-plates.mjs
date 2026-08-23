#!/usr/bin/env node
/**
 * Export the before/after testudo plates as committable JPEGs.
 *
 * `screenshots/**` is `.gitignore`d for every raster format — deliberately, because a review
 * agent once wrote frames derived from copyrighted press material onto a committable path.
 * `docs/images/` is where a frame that has to survive in the repository goes, and everything
 * already there is JPEG. This is the one-line conversion, kept so the plates can be
 * regenerated after a re-shoot rather than hand-converted.
 *
 *   node tools/scratch/testudo-plates.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, 'screenshots/testudo');
const OUT = path.join(ROOT, 'docs/images/testudo');
mkdirSync(OUT, { recursive: true });

/** Shot on both trees at bit-identical eye and aim positions. */
const PAIRS = ['front-eye', 'roof-rake', 'tactical', 'flank-halt', 'corner'];
/** Diagnostics that only exist on the after tree. */
const AFTER_ONLY = ['roof-close', 'rear', 'far120', 'flank-march'];

const jpeg = (src, dst) => {
  if (!existsSync(src)) { console.log(`  missing ${path.relative(ROOT, src)}`); return; }
  execFileSync('sips', [
    '-s', 'format', 'jpeg', '-s', 'formatOptions', '62', '-Z', '1280', src, '--out', dst,
  ], { stdio: 'ignore' });
  console.log(`  ${path.relative(ROOT, dst)}`);
};

for (const c of PAIRS) {
  jpeg(path.join(SHOTS, 'before-final', `${c}.png`), path.join(OUT, `before-${c}.jpg`));
  jpeg(path.join(SHOTS, 'after-final', `${c}.png`), path.join(OUT, `after-${c}.jpg`));
}
for (const c of AFTER_ONLY) {
  jpeg(path.join(SHOTS, 'after-final', `${c}.png`), path.join(OUT, `after-${c}.jpg`));
}
