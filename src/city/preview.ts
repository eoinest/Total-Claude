import * as THREE from 'three';
import { Engine, type QualityTier } from '../core/Engine';
import { LightingSystem } from '../render/LightingSystem';
import { SkySystem } from '../render/SkySystem';
import { TerrainSystem } from '../terrain/TerrainSystem';
import { ROME_PLAN } from './rome/plan';
import { hash01 } from '../util/rand';
import { CitySystem } from './CitySystem';
import { LANDMARKS } from './rome/layout';
import { REFERENCE_PLANS, type OverlayOptions } from './overlay';
import { ROME } from './rome/survey';

/**
 * Standalone preview harness for the city.
 *
 * The city agent owns only `src/city/**`, so this page exists to render and grade the
 * city without editing `src/main.ts` (which other agents are working in). It boots the
 * same engine with sky, lighting, terrain and the city, plus 2,500 man-sized boxes
 * standing where the two armies deploy — enough to check that the scale reads and
 * that the frame budget survives a crowd.
 *
 * Served by Vite at `/src/city/preview.html`; driven by `shoot-city.mjs`.
 */

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const statsEl = document.getElementById('stats') as HTMLElement;
const quality = (params.get('quality') as QualityTier | null) ?? 'ultra';
const W = Number(params.get('w') ?? 1600);
const H = Number(params.get('h') ?? 900);

const engine = new Engine({ canvas, quality, fixedSize: { w: W, h: H } });
engine.add(new SkySystem());
engine.add(new LightingSystem());
const terrain = engine.add(new TerrainSystem());
// The city preview is Rome's. A second city gets its own entry point rather than a query
// parameter here: this page exists to grade the Aurelian Wall against archaeology.
const city = engine.add(new CitySystem(ROME_PLAN));
if (params.get('procedural') === '1') city.useProceduralTexturesOnly(true);

/** Stand-in soldiers: a man is 1.75 m, shoulders 0.5 m, 0.86 m lateral spacing. */
function addCrowd(): THREE.InstancedMesh {
  const COUNT = 2500;
  const geo = new THREE.BoxGeometry(0.5, 1.75, 0.34);
  geo.translate(0, 0.875, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6d5a48, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  let i = 0;
  const block = (x0: number, z0: number, cols: number, rows: number, n: number): void => {
    for (let k = 0; k < n && i < COUNT; k++) {
      const c = k % cols;
      const r = Math.floor(k / cols) % rows;
      const x = x0 + (c - cols / 2) * 0.86 + (hash01(i, 3) - 0.5) * 0.18;
      const z = z0 + r * 0.9 + (hash01(i, 7) - 0.5) * 0.18;
      p.set(x, terrain.heightAt(x, z), z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash01(i, 11) * 0.2);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      i++;
    }
  };
  // Roman line at z = 130, Juthungi host at z = −190 (see src/sim/scenario.ts).
  for (let k = 0; k < 4; k++) block((k - 1.5) * 62, 130, 34, 8, 260);
  block(-132, 124, 22, 8, 170);
  block(132, 124, 22, 8, 170);
  block(0, 246, 40, 4, 150);
  for (let k = 0; k < 4; k++) block((k - 1.5) * 70, -190, 40, 10, 300);
  engine.scene.add(mesh);
  return mesh;
}

/**
 * Orthographic plan view.
 *
 * The whole point of the reference overlay is that the render and the archaeological plan
 * become the *same picture*, and that only works from a camera with no perspective: under
 * a perspective camera a 40 m building 800 m from the lens is displaced by its own height
 * times the tangent of its off-axis angle, which is tens of metres of parallax — the same
 * order as the error being measured. So the plan shots render through an
 * `OrthographicCamera` looking straight down, framed on an exact world rectangle, which
 * makes screen pixels a linear function of world metres and lets the comparison be
 * measured rather than eyeballed.
 *
 * Shadows are off and the sky's fog is suspended for the duration: both are aerial-
 * perspective cues, and both destroy a flat orthophoto.
 */
const planCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
let planFog: THREE.Scene['fog'] = null;
let planning = false;

function planView(
  rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  /**
   * Detail level to pin. 0 is full detail and is what a measurement wants. **1 and 2 are
   * what the battlefield camera actually sees**, and rendering those from overhead is how a
   * fault that only exists in a reduced level — such as a monument emitted at the world
   * origin because its placement matrix was composed once per material alias — becomes
   * visible instead of merely being asserted.
   */
  lod = 0
): void {
  if (!rect) {
    if (planning) {
      engine.renderOverride = null;
      engine.renderer.shadowMap.enabled = true;
      engine.scene.fog = planFog;
      city.debugForceLod(null);
      planning = false;
    }
    return;
  }
  if (!planning) {
    planFog = engine.scene.fog;
    planning = true;
  }
  engine.scene.fog = null;
  engine.renderer.shadowMap.enabled = false;
  // The plan view sits 1.5 km up, where distance-based LOD would drop the entire city to
  // silhouettes and leave nothing to measure.
  city.debugForceLod(lod);
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const hw = (rect.maxX - rect.minX) / 2;
  const hd = (rect.maxZ - rect.minZ) / 2;
  planCam.left = -hw;
  planCam.right = hw;
  // World +Z must read *down* the image so north is up, which is what `up = (0,0,-1)`
  // below arranges; the vertical half-extent is therefore the depth half-extent.
  planCam.top = hd;
  planCam.bottom = -hd;
  planCam.near = 1;
  planCam.far = 3000;
  planCam.position.set(cx, 1800, cz);
  planCam.up.set(0, 0, -1);
  planCam.lookAt(cx, 0, cz);
  planCam.updateProjectionMatrix();
  planCam.updateMatrixWorld();
  engine.renderOverride = () => engine.renderer.render(engine.scene, planCam);
}

declare global {
  interface Window {
    __city?: {
      engine: Engine;
      city: CitySystem;
      ready: boolean;
      setCamera(x: number, z: number, zoom: number, yaw: number): void;
      advance(seconds: number): void;
      /** Debug-only, see `planView`. Pass null to return to the game camera. */
      planView(rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null, lod?: number): void;
      /** Debug-only: drape a georeferenced plan of Rome on the ground. */
      setOverlay(id: string | null, opts?: OverlayOptions): Promise<boolean>;
      setCityVisible(on: boolean): void;
      setOverlayVisible(on: boolean): void;
      /** Debug-only: re-frame the render target for a plan view of a given aspect. */
      setSize(w: number, h: number): void;
      landmarkTable(): {
        id: string;
        name: string;
        x: number;
        z: number;
        idealX: number;
        idealZ: number;
        e: number;
        n: number;
      }[];
      stray: ReturnType<CitySystem['stats']>['strayGeometry'];
    };
  }
}

window.__city = {
  engine,
  city,
  ready: false,
  setCamera: (x, z, zoom, yaw) => engine.rig.jumpTo(x, z, zoom, yaw),
  advance: (seconds) => engine.advance(seconds),
  planView,
  setOverlay: (id, opts) =>
    city.setReferenceOverlay(id === null ? null : (REFERENCE_PLANS.find((p) => p.id === id) ?? null), opts),
  setCityVisible: (on) => city.setDebugVisible(on),
  setOverlayVisible: (on) => city.setOverlayVisible(on),
  // `Engine` is constructed with a fixed size for reproducibility, and the plan-view
  // rectangles are not all the same aspect. Nothing in this harness runs a post chain, so
  // resizing the renderer and the canvas is the whole of it.
  setSize: (w, h) => {
    engine.renderer.setPixelRatio(1);
    engine.renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    engine.viewW = w;
    engine.viewH = h;
  },
  // Emitted so the shooter can annotate the plan-view PNGs and measure per-landmark error
  // without duplicating the projection.
  landmarkTable: () =>
    LANDMARKS.map((l) => {
      const m = ROME.find((r) => r.id === l.id)!;
      return { id: l.id, name: l.name, x: l.x, z: l.z, idealX: l.idealX, idealZ: l.idealZ, e: m.e, n: m.n };
    }),
  stray: 0,
};

let timer = 0;
let api = '';
engine
  .initAll()
  .then(async () => {
    addCrowd();
    engine.add({
      name: 'preview-stats',
      order: 1000,
      update: (dt) => {
        timer += dt;
        if (timer < 0.25) return;
        timer = 0;
        const st = engine.stats();
        const cs = city.stats();
        statsEl.textContent = api + '\n' +
          `${engine.time.fps.toFixed(0)} fps  ${engine.time.frameMs.toFixed(1)} ms\n` +
          `frame: draws ${st.calls}  tris ${(st.tris / 1e6).toFixed(2)}M\n` +
          `city:  <=${cs.visibleMeshes} draws  ${(cs.visibleTriangles / 1e6).toFixed(2)}M tris visible\n` +
          `city:  ${cs.chunks} chunks  ${cs.meshes} meshes  ${(cs.triangles / 1e6).toFixed(2)}M baked\n` +
          `mats ${cs.materials}  manifest: ${cs.usedManifest ? 'yes' : 'procedural only'}`;
      },
    });
    // Smoke-test the public API from the preview, so a regression shows up in a frame
    // rather than in someone else's pathfinder.
    const gate = city.getGates()[0];
    const segs = city.getWallSegments();
    const throughGate = city.blocksMovement(gate.x, gate.z - 30, gate.x, gate.z + 30);
    const throughCurtain = city.blocksMovement(gate.x + 120, gate.z - 30, gate.x + 120, gate.z + 30);
    const openField = city.blocksMovement(-200, -200, 200, 100);
    api =
      `api: ${segs.length} segments  gate (${gate.x.toFixed(0)}, ${gate.z.toFixed(0)})  ` +
      `gate-open ${throughGate ? 'FAIL' : 'ok'}  curtain-blocks ${throughCurtain ? 'ok' : 'FAIL'}  ` +
      `field-clear ${openField ? 'FAIL' : 'ok'}`;

    engine.rig.jumpTo(gate.x, gate.z - 190, 0.62, 0);
    // Optional debug layers, driven by the query string so `shoot-city.mjs` and a browser
    // can reach them identically. Never on by default.
    const overlayId = params.get('overlay');
    if (overlayId) await window.__city!.setOverlay(overlayId, { mode: 'ground', opacity: 1 });
    window.__city!.stray = city.stats().strayGeometry;
    engine.start();
    window.__city!.ready = true;
  })
  .catch((err) => {
    statsEl.textContent = `FAILED: ${err instanceof Error ? err.stack : String(err)}`;
    console.error('[city preview] boot failed', err);
  });
