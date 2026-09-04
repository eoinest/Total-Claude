/**
 * Throwaway: what a four-system scenic backdrop costs, phase by phase, on the main thread.
 *
 * The prior `e/ui/cinematic-menu` branch measured 2,340-2,662 ms for sky+lighting+terrain+city
 * and rejected a live backdrop on it. That number is a *total*; this splits it, because the
 * design question is not "how long" but "how long is the longest block the menu cannot
 * interrupt". A build made of six 400 ms awaits is a usable menu; one 2.3 s synchronous block
 * is a frozen one.
 *
 *   node tools/scratch/backdrop-cost.mjs --map=campus-martius --port=5613
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5613);
const MAPS = (args.get('map') ?? 'campus-martius,carthage,pydna').split(',');
const TIER = args.get('quality') ?? 'ultra';

const vite = await startVite({ port: PORT, root: ROOT, label: 'backdrop-cost' });
const browser = await launchBrowser({ label: 'backdrop-cost', port: PORT, root: ROOT });
try {
  for (const map of MAPS) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e.message).split('\n')[0]));
    // `?menu=0` so `main.ts` builds nothing of its own while this measures; the probe drives
    // the modules directly. `autoplay=0` keeps the battle it does build quiet.
    await page.goto(`${vite.base}/?menu=0&autoplay=0&quality=low&harness=1&w=320&h=200`, { waitUntil: 'domcontentloaded' });
    const out = await page.evaluate(async ({ map, tier }) => {
      /*
       * The number that decides the design is not how long a phase takes but how long the main
       * thread is *unavailable* inside it. A phase made of awaited I/O leaves the menu clickable;
       * one synchronous block does not. A rAF that never misses a beat is the honest witness, so
       * one runs throughout and the largest gap between two of its callbacks is the freeze a
       * player would feel.
       */
      let lastRaf = performance.now();
      let maxGap = 0;
      let stop = false;
      const beat = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - lastRaf);
        lastRaf = now;
        if (!stop) requestAnimationFrame(beat);
      };
      requestAnimationFrame(beat);
      const t = [];
      const mark = async (label, fn) => {
        const a = performance.now();
        maxGap = 0; lastRaf = performance.now();
        const r = await fn();
        t.push({ label, ms: Math.round(performance.now() - a), blockMs: Math.round(maxGap) });
        return r;
      };
      const [{ Engine }, { SkySystem }, { LightingSystem }, { TerrainSystem }, { CitySystem }, maps] =
        await mark('import', () => Promise.all([
          import('/src/core/Engine.ts'),
          import('/src/render/SkySystem.ts'),
          import('/src/render/LightingSystem.ts'),
          import('/src/terrain/TerrainSystem.ts'),
          import('/src/city/CitySystem.ts'),
          import('/src/maps/index.ts'),
        ]));
      const before = maps.activeMap().id;
      maps.setActiveMap(map);
      const canvas = document.createElement('canvas');
      canvas.width = 1600; canvas.height = 900;
      document.body.appendChild(canvas);
      const engine = await mark('new Engine', () =>
        new Engine({ canvas, quality: tier, fixedSize: { w: 1600, h: 900 } }));
      const sky = new SkySystem();
      const lighting = new LightingSystem();
      const terrain = new TerrainSystem();
      const plan = maps.getMap(map).city;
      const city = plan ? new CitySystem(plan) : null;
      for (const s of [sky, lighting, terrain, city]) if (s) engine.add(s);
      const ctx = engine.context;
      await mark('sky.init', () => sky.init?.(ctx));
      await mark('lighting.init', () => lighting.init?.(ctx));
      await mark('terrain.init', () => terrain.init?.(ctx));
      if (city) await mark('city.init', () => city.init?.(ctx));
      await mark('compileAsync', () => engine.renderer.compileAsync(engine.scene, engine.rig.camera));
      await mark('first frame', () => { engine.renderer.render(engine.scene, engine.rig.camera); });
      // Second pass: what a *warmed* build costs, which is what a map switch pays.
      const warm = [];
      const mark2 = async (label, fn) => {
        const a = performance.now(); maxGap = 0; lastRaf = performance.now(); await fn();
        warm.push({ label, ms: Math.round(performance.now() - a), blockMs: Math.round(maxGap) });
      };
      const sky2 = new SkySystem(); const light2 = new LightingSystem();
      const terr2 = new TerrainSystem(); const city2 = plan ? new CitySystem(plan) : null;
      const canvas2 = document.createElement('canvas');
      const engine2 = new Engine({ canvas: canvas2, quality: tier, fixedSize: { w: 640, h: 360 } });
      for (const s of [sky2, light2, terr2, city2]) if (s) engine2.add(s);
      await mark2('sky.init', () => sky2.init?.(engine2.context));
      await mark2('lighting.init', () => light2.init?.(engine2.context));
      await mark2('terrain.init', () => terr2.init?.(engine2.context));
      if (city2) await mark2('city.init', () => city2.init?.(engine2.context));
      maps.setActiveMap(before);
      stop = true;
      return { cold: t, warm, total: t.reduce((s, x) => s + x.ms, 0),
        warmTotal: warm.reduce((s, x) => s + x.ms, 0) };
    }, { map, tier: TIER });
    console.log(`\n=== ${map} @ ${TIER} ===`);
    const fmt = (a) => a.map((x) => `${x.label} ${x.ms}ms (block ${x.blockMs})`).join('  |  ');
    console.log('cold:', fmt(out.cold), `=> ${out.total} ms`);
    console.log('warm:', fmt(out.warm), `=> ${out.warmTotal} ms`);
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
