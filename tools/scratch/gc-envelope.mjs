/**
 * gc-envelope.mjs — the shape of a recipe over time, not just its two headline numbers.
 *
 * `selftest.ts` reports peak and RMS for the whole buffer, which cannot tell a collapse whose
 * loudest instant is the failure from one whose loudest instant is a leaf landing 1.2 seconds
 * later — and the difference is the whole character of the sound. This prints a 50 ms envelope
 * and says where the peak actually is.
 *
 *   node tools/scratch/gc-envelope.mjs --port=5344 [--ids=gate_collapse,wall_breach]
 */
import { chromium } from 'playwright';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1'];
}));
const PORT = Number(args.get('port') ?? 5344);
const IDS = String(args.get('ids') ?? 'gate_collapse,wall_breach,tower_dock,machine_wreck').split(',');
const BIN = Number(args.get('bin') ?? 0.05);
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.route(`${base}/__gc_env`, (route) =>
  route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>env</title><body>' }));
await page.goto(`${base}/__gc_env`, { waitUntil: 'domcontentloaded' });

const out = await page.evaluate(async ({ ids, bin }) => {
  const m = await import('/src/audio/Synth.ts');
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const bank = m.buildSoundBank(ctx);
  const res = [];
  for (const id of ids) {
    const b = bank.get(id);
    if (!b) { res.push({ id, missing: true }); continue; }
    const n = b.length, sr = b.sampleRate;
    const chans = [];
    for (let c = 0; c < b.numberOfChannels; c++) chans.push(b.getChannelData(c));
    const step = Math.max(1, Math.round(bin * sr));
    const bins = [];
    let peak = 0, peakAt = 0;
    for (let i = 0; i < n; i += step) {
      const j = Math.min(n, i + step);
      let s = 0, p = 0, k = 0;
      for (const d of chans) for (let q = i; q < j; q++) {
        const v = d[q]; s += v * v; k++;
        const a = v < 0 ? -v : v;
        if (a > p) p = a;
        if (a > peak) { peak = a; peakAt = q / sr; }
      }
      bins.push({ t: +(i / sr).toFixed(3), rms: +Math.sqrt(s / k).toFixed(5), peak: +p.toFixed(4) });
    }
    res.push({ id, sr, seconds: +(n / sr).toFixed(3), peak: +peak.toFixed(4), peakAt: +peakAt.toFixed(3), bins });
  }
  return res;
}, { ids: IDS, bin: BIN });

for (const r of out) {
  if (r.missing) { console.log(`\n${r.id}: NOT IN BANK`); continue; }
  console.log(`\n${r.id}  ${r.seconds} s @ ${r.sr} Hz   peak ${r.peak} at t=${r.peakAt} s`);
  for (const b of r.bins) {
    console.log(`  ${b.t.toFixed(2).padStart(6)}  rms ${b.rms.toFixed(5)} peak ${b.peak.toFixed(4)}  ${'#'.repeat(Math.round(b.peak * 60))}`);
  }
}
await browser.close();
