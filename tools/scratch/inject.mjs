#!/usr/bin/env node
/**
 * Throwaway: apply one named fault, run one qa-net arm, print the verdict, put it back.
 *
 * `node tools/scratch/inject.mjs <name>` — the list is below. Every new check on this branch has
 * an entry here, because a check nobody has seen fail is a check nobody has tested.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const F = {
  qr: 'src/net/qr.ts',
  lobby: 'src/ui/NetLobby.ts',
  main: 'src/main.ts',
  net: 'tools/qa-net.mjs',
  host: 'tools/host-lan.mjs',
};

const FAULTS = {
  'block-table': [F.qr, '[18, 2, 15, 2, 16], [24, 4, 19, 0, 0]', '[18, 2, 15, 2, 17], [24, 4, 19, 0, 0]', 'qr'],
  'placement': [F.qr, "    if (right === 6) right = 5;\n", '', 'qr'],
  'half-blocks': [F.qr, "top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '", "top && bottom ? '█' : top ? '▄' : bottom ? '▀' : ' '", 'qr'],
  'ecc-level': [F.qr, "const ecc = opts.ecc ?? 'Q';", "const ecc = opts.ecc ?? 'L';", 'qr'],
  'quiet-zone': [F.qr, 'export const QUIET = 4;', 'export const QUIET = 0;', 'qr'],
  'tiny-qr': [F.lobby, 'width:200px;height:200px;padding:0;background:#fff;', 'width:44px;height:44px;padding:0;background:#fff;', 'lan'],
  'no-white': [F.qr, '`<rect width="${n}" height="${n}" fill="#fff"/>`', "''", 'lan'],
  'no-autocreate': [F.lobby, "if (params.get('create') === '1' && validCode(room.value.trim().toUpperCase())) create(true);", '', 'lan'],
  'long-invite': [F.lobby, 'const shortLink = declared !== null && declared === addr;', 'const shortLink = false;', 'lan'],
  'no-autojoin': [F.main, "if (!params.get('net') && params.get('room')) {", 'if (false) {', 'lan'],
  'no-override': [F.net, '`--ip-address-space-overrides=${ip}:${HTTPS_PORT}=public`', "'--hide-scrollbars'", 'https'],
  'form-on-https': [F.lobby, "  if (!ours && secureOrigin()) {", '  if (false) {', 'https'],
  'https-noise': [F.lobby, "  if (!ours && secureOrigin()) {",
    "  if (!ours && secureOrigin()) {\n    console.error('deliberate noise');", 'https'],
  'no-race-fix': [F.lobby, 'if (r.status === 409 && fromLink && asked) {', 'if (false) {', 'lan'],
  'no-completion': [F.lobby, "  relay.addEventListener('change', () => {", "  relay.addEventListener('never', () => {", 'dev'],
};

const name = process.argv[2];
const fault = FAULTS[name];
if (!fault) {
  console.error(`usage: node tools/scratch/inject.mjs <${Object.keys(FAULTS).join('|')}>`);
  process.exit(2);
}
const [rel, from, to, arm] = fault;
const file = path.join(ROOT, rel);
const orig = readFileSync(file, 'utf8');
if (!orig.includes(from)) {
  console.error(`fault '${name}': anchor not found in ${rel}:\n  ${from.slice(0, 90)}`);
  process.exit(2);
}
writeFileSync(file, orig.replace(from, to));
console.log(`injected '${name}' into ${rel}; running --only=${arm}`);
const code = await new Promise((r) => {
  const p = spawn('node', [path.join(ROOT, 'tools/qa-net.mjs'), `--only=${arm}`],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += String(d); process.stdout.write(d); });
  p.stderr.on('data', (d) => process.stderr.write(d));
  p.on('exit', (c) => { void out; r(c); });
});
writeFileSync(file, orig);
console.log(`\nreverted ${rel}; qa-net --only=${arm} exited ${code} (non-zero is the point)`);
