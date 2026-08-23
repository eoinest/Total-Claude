#!/usr/bin/env node
/** Scratch: measure terrain relief over the Campus Martius. Not a gate. */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5952);
const MAP = args.get('map') ?? 'campus-martius';
const base = `http://127.0.0.1:${PORT}`;
const browser = await launchBrowser({ label: 'relief-measure', port: PORT, root: path.resolve(import.meta.dirname, '../..') });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${base}/?harness=1&map=${MAP}&scenario=assault&quality=ultra&w=800&h=600`, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 300000 });
  const out = await page.evaluate(() => {
    const eng = window.__game.engine;
    const h = (x, z) => eng.rig.heightAt(x, z);
    const rows = [];
    const STEP = 10;
    for (let z = 540; z <= 1240; z += STEP) {
      for (let x = -200; x <= 500; x += STEP) rows.push([x, z, h(x, z)]);
    }
    const key = (x, z) => x + ',' + z;
    const map = new Map(rows.map((r) => [key(r[0], r[1]), r[2]]));
    const relief = [];
    const slopes = [];
    for (const [x, z] of rows) {
      let mn = Infinity, mx = -Infinity, n = 0;
      for (let dz = -60; dz <= 60; dz += STEP) for (let dx = -60; dx <= 60; dx += STEP) {
        const v = map.get(key(x + dx, z + dz)); if (v === undefined) continue;
        mn = Math.min(mn, v); mx = Math.max(mx, v); n++;
      }
      if (n >= 100) relief.push([x, z, mx - mn]);
      const a = map.get(key(x + STEP, z)), b = map.get(key(x - STEP, z));
      const c = map.get(key(x, z + STEP)), d = map.get(key(x, z - STEP));
      if (a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
        const gx = (a - b) / (2 * STEP), gz = (c - d) / (2 * STEP);
        slopes.push([x, z, Math.hypot(gx, gz)]);
      }
    }
    const q = (arr, p) => { const s = arr.slice().sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const rv = relief.map((r) => r[2]);
    const sv = slopes.map((r) => r[2] * 100);
    relief.sort((u, v) => v[2] - u[2]);
    const ys = rows.map((r) => r[2]);
    return {
      stations: rows.length,
      y: { min: +Math.min(...ys).toFixed(2), max: +Math.max(...ys).toFixed(2), median: +q(ys, 0.5).toFixed(2) },
      relief60: { median: +q(rv, 0.5).toFixed(2), p90: +q(rv, 0.9).toFixed(2), p99: +q(rv, 0.99).toFixed(2), max: +Math.max(...rv).toFixed(2) },
      slopePct: { median: +q(sv, 0.5).toFixed(2), p90: +q(sv, 0.9).toFixed(2), p99: +q(sv, 0.99).toFixed(2), max: +Math.max(...sv).toFixed(2) },
      worst: relief.slice(0, 20).map((r) => ({ x: r[0], z: r[1], relief: +r[2].toFixed(2) })),
      axis: Array.from({ length: 36 }, (_, i) => { const z = 540 + i * 20; return { z, y: +h(100 + (z - 540) * 0.08, z).toFixed(2) }; }),
      cross: Array.from({ length: 36 }, (_, i) => { const x = -200 + i * 20; return { x, y: +h(x, 900).toFixed(2) }; }),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await browser.close(); }
