import { Engine, type QualityTier } from './core/Engine';
import { SkySystem } from './render/SkySystem';
import { LightingSystem } from './render/LightingSystem';
import { PostFXSystem } from './render/PostFX';
import { TerrainSystem } from './terrain/TerrainSystem';
import { UnitRenderSystem } from './units/UnitRenderSystem';
import { BattleSystem } from './sim/BattleSystem';
import { deploySiegeOfRome } from './sim/scenario';

/**
 * Entry point. Builds the engine, registers subsystems in dependency order, deploys
 * the scenario and starts the loop.
 *
 * The screenshot harness drives the same path but sets `?harness=1`, which pins the
 * canvas size, disables the intro fade and exposes `window.__game` so a headless
 * browser can step the simulation deterministically and grab frames.
 */

const params = new URLSearchParams(location.search);
const harness = params.get('harness') === '1';
const qualityParam = (params.get('quality') as QualityTier | null) ?? (harness ? 'ultra' : 'high');

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const loading = document.getElementById('loading') as HTMLElement;
const loadBar = document.getElementById('load-bar') as HTMLElement;
const loadText = document.getElementById('load-text') as HTMLElement;

const engine = new Engine({
  canvas,
  quality: qualityParam,
  fixedSize: harness
    ? { w: Number(params.get('w') ?? 1920), h: Number(params.get('h') ?? 1080) }
    : undefined,
});

// Registration order does not matter for update ordering (that is driven by
// `Subsystem.order`), but init runs in registration order, so anything that
// publishes a contract others read at init time must come first.
engine.add(new SkySystem());
engine.add(new LightingSystem());
engine.add(new TerrainSystem());
const battle = engine.add(new BattleSystem());
engine.add(new UnitRenderSystem());
engine.add(new PostFXSystem());

const perf = document.createElement('div');
perf.id = 'perf';
document.getElementById('hud-root')!.appendChild(perf);

let perfTimer = 0;
function updatePerf(): void {
  const t = engine.time;
  const s = engine.stats();
  let men = 0;
  for (const u of battle.units) men += u.alive;
  const fpsCls = t.fps >= 55 ? '' : t.fps >= 30 ? 'warn' : 'bad';
  perf.innerHTML =
    `<b>${t.fps.toFixed(0)}</b> fps  <span class="${fpsCls}">${t.frameMs.toFixed(1)} ms</span>\n` +
    `draws ${s.calls}   tris ${(s.tris / 1000).toFixed(0)}k\n` +
    `men   ${men}   units ${battle.units.filter((u) => !u.destroyed).length}\n` +
    `speed ${t.paused ? 'PAUSED' : `${t.gameSpeed}x`}   t+${t.simTime.toFixed(0)}s`;
}

async function boot(): Promise<void> {
  await engine.initAll((frac, label) => {
    loadBar.style.width = `${Math.round(frac * 100)}%`;
    loadText.textContent = label === 'ready' ? 'Ready' : `Preparing ${label}…`;
  });

  const result = deploySiegeOfRome(battle, engine.context);
  const f = result.cameraFocus;
  engine.rig.jumpTo(f.x, f.z, f.zoom, f.yaw);

  // Game speed controls, Total War style.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') engine.time.togglePause();
    if (e.code === 'Digit1') engine.time.setSpeed(1);
    if (e.code === 'Digit2') engine.time.setSpeed(2);
    if (e.code === 'Digit3') engine.time.setSpeed(4);
  });

  engine.add({
    name: 'perf-overlay',
    order: 1000,
    update: (dt) => {
      perfTimer += dt;
      if (perfTimer > 0.2) {
        perfTimer = 0;
        updatePerf();
      }
    },
  });

  if (harness) {
    loading.remove();
  } else {
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 1400);
  }

  engine.start();
  engine.events.emit('loadComplete', {});
}

// The harness contract: everything a headless driver needs, and nothing more.
declare global {
  interface Window {
    __game?: {
      engine: Engine;
      battle: BattleSystem;
      ready: boolean;
      /** Run the sim forward `seconds` without waiting on real time. */
      advance(seconds: number): void;
      /** Park the camera for a repeatable screenshot. */
      setCamera(x: number, z: number, zoom: number, yaw: number): void;
      /** Sim seconds elapsed. */
      simTime(): number;
    };
  }
}

window.__game = {
  engine,
  battle,
  ready: false,
  advance: (seconds: number) => engine.advance(seconds),
  setCamera: (x, z, zoom, yaw) => engine.rig.jumpTo(x, z, zoom, yaw),
  simTime: () => engine.time.simTime,
};

boot()
  .then(() => {
    window.__game!.ready = true;
  })
  .catch((err) => {
    console.error('[boot] failed:', err);
    loadText.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    loadText.style.color = '#e2564b';
  });
