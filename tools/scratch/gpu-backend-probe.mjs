#!/usr/bin/env node
/**
 * Which rasteriser does a **bare** `chromium.launch()` actually get on this machine?
 *
 * `tools/lib/browser-budget.mjs` states that without `--use-angle=metal` Chromium falls back to
 * SwiftShader and rasterises in software — 4 to 6 minute boots, silently. `tools/browsers.mjs`
 * can only see that when the flag is spelled out on the GPU process command line, so a tool
 * that passes *no* `--use-angle` at all lands in its `unstated` bucket and looks innocent.
 *
 * This asks the page instead. `WEBGL_debug_renderer_info` reports the real backend, so the
 * answer is a string from the driver rather than an inference from a flag.
 *
 * Both launches are budgeted: the control passes `gpuArgs: []` to `launchBrowser`, which
 * reproduces a bare launch **while still holding a slot**, so measuring the unbudgeted case
 * does not require actually being unbudgeted.
 *
 *   node tools/scratch/gpu-backend-probe.mjs
 */
import { GPU_ARGS, launchBrowser } from '../lib/browser-budget.mjs';

const READ = () => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { ok: false, why: 'no webgl context at all' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION),
  };
};

for (const [name, opts] of [
  ['bare    chromium.launch()        ', { gpuArgs: [], args: [] }],
  ['budget  launchBrowser() defaults ', {}],
]) {
  const t0 = Date.now();
  const b = await launchBrowser({ label: 'gpu-backend-probe', ...opts });
  const p = await b.newPage();
  await p.goto('about:blank');
  const r = await p.evaluate(READ);
  console.log(`${name} ${JSON.stringify(r)}   (${Date.now() - t0} ms)`);
  await b.close();
}
console.log(`canonical GPU_ARGS: ${GPU_ARGS.join(' ')}`);
