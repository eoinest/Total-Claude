import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Grade } from './grade';

/**
 * The room the models stand in.
 *
 * Two lighting presets, and the difference between them is the point of having both.
 *
 * **Studio** is for *inspection*: a neutral grey room probe, a key light you can orbit
 * against, no colour cast. Anything you dislike about the model under it is the model.
 *
 * **Field** reproduces the battle's own rig — the sun and hemisphere values are read off
 * `src/render/LightingSystem.ts`, and the environment is a sky gradient rather than a room —
 * because "does this helmet read at all in the game's light" is a different question from
 * "is this helmet modelled", and a viewer that can only answer the second one will tell you
 * a mesh is fine while it renders as a black lump on the field.
 *
 * The soldier material runs `envMapIntensity: 2.9` against a probe the game trims to 0.6.
 * With no `scene.environment` at all it is near-black — measured in the game at 0.9 probe
 * intensity, half of every soldier fell below 1.4% display luminance. So an environment is
 * not decoration here, it is a requirement for the material to show anything.
 */

export type LightPreset = 'studio' | 'field';

/** Metres. A man is 1.75 m; the gauge is marked so you can check that by eye. */
const GAUGE_HEIGHT = 2;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  readonly sun = new THREE.DirectionalLight(0xfff2dc, 3);
  private readonly fill = new THREE.HemisphereLight(0x9dbcdc, 0x6b5a3e, 0.42);
  private readonly bounce = new THREE.DirectionalLight(0xffd9a8, 0.24);

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envs = new Map<LightPreset, THREE.Texture>();
  /** Keyed wider than `LightPreset` because plate mode shares `field`'s probe but not its sky. */
  private readonly backgrounds = new Map<LightPreset | 'plate', THREE.Texture>();
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private readonly gauge: THREE.Group;
  private preset: LightPreset = 'studio';
  private plate = false;
  private readonly grade: Grade;
  private canvasW = 2;
  private canvasH = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    // The same output chain as the game (`src/core/Engine.ts:153-159`). A model graded under
    // a different tone map is a model graded for a different game.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 900);
    this.camera.position.set(2.4, 1.7, 3.1);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 0.95, 0);
    this.controls.minDistance = 0.35;
    // Far enough to stand at the impostor edge and look back at the ladder.
    this.controls.maxDistance = 520;
    // Stop just short of the poles: going under the floor is never what you wanted, and
    // exactly at the pole the azimuth becomes undefined and the camera snaps.
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI * 0.5 - 0.01;
    this.controls.autoRotateSpeed = 1.6;

    this.sun.position.set(4.2, 7.4, -6.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = -9; s.right = 9; s.top = 9; s.bottom = -9; s.near = 0.5; s.far = 40;
    // A soldier is 1.75 m of thin limbs and a 4 mm bias is a whole forearm of peter-panning;
    // normalBias is the right knob because the acne it fixes is on curved mail and plate.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.018;
    this.bounce.position.set(-5, 2.2, 5.5);
    this.scene.add(this.sun, this.sun.target, this.fill, this.bounce);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    // 400 m, not 60. At 60 the disc's own edge sits in shot as a hard grey line across the
    // frame and reads as a wall; pushed out past the far plane's useful range it reads as
    // ground meeting sky, which is what it is.
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(400, 96).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x6f6a5c, roughness: 0.97, metalness: 0 })
    );
    this.ground.receiveShadow = true;
    this.ground.name = 'viewer-ground';
    this.scene.add(this.ground);

    // One metre squares. The single most useful thing on the floor of a model viewer: it
    // turns "does he look the right size" into a measurement.
    this.grid = new THREE.GridHelper(40, 40, 0x8d8878, 0x4b4842);
    this.grid.position.y = 0.002;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.gauge = this.buildGauge();
    this.scene.add(this.gauge);

    this.grade = new Grade(this.renderer);

    this.setLightPreset('studio');
  }

  /**
   * A two-metre rule beside the model, ticked every 100 mm with a band at 1.75 m.
   *
   * `MeshBasicMaterial` on purpose: a measuring instrument that changes brightness with the
   * lighting preset is a measuring instrument you stop trusting.
   */
  private buildGauge(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'viewer-gauge';
    const pale = new THREE.MeshBasicMaterial({ color: 0xd8dde3 });
    const dark = new THREE.MeshBasicMaterial({ color: 0x2a2e34 });
    const mark = new THREE.MeshBasicMaterial({ color: 0xd9a441 });
    for (let i = 0; i < GAUGE_HEIGHT * 10; i++) {
      const h = 0.1;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.035, h, 0.035), i % 2 ? dark : pale);
      seg.position.set(0, i * h + h / 2, 0);
      g.add(seg);
    }
    // The reference man. 1.75 m is the figure `docs/ARCHITECTURE.md` sets the whole world by.
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.012, 0.13), mark);
    band.position.set(0, 1.75, 0);
    g.add(band);
    g.position.set(-0.85, 0, 0);
    return g;
  }

  /**
   * A vertical gradient as an equirectangular texture.
   *
   * Serves two jobs. As a *probe* it is close enough to the game's physical sky for an IBL:
   * what a soldier gets from that sky is a cool zenith, a warm horizon and a dusty bounce
   * from below, and three stops carry all three; the solar disc is left out because the
   * directional light already supplies it and doubling it blows the helmets. As a
   * *background* it removes the hard line a flat clear colour draws across the frame where
   * the ground plane ends.
   *
   * `sunward` adds a warm brightening toward one azimuth so the probe has a direction to it —
   * without it a gradient probe lights both cheeks of a helmet identically and the model
   * looks like a clay render.
   */
  private gradient(
    top: number, middle: number, bottom: number, gain: number, sunward: number
  ): THREE.DataTexture {
    const w = 64;
    const h = 64;
    const data = new Float32Array(w * h * 4);
    const a = new THREE.Color(top).convertSRGBToLinear();
    const b = new THREE.Color(middle).convertSRGBToLinear();
    const c = new THREE.Color(bottom).convertSRGBToLinear();
    const t = new THREE.Color();
    for (let y = 0; y < h; y++) {
      // v = 0 at the top of the equirect.
      const v = y / (h - 1);
      if (v < 0.5) t.copy(a).lerp(b, Math.pow(v * 2, 1.5));
      else t.copy(b).lerp(c, Math.min(1, (v - 0.5) * 2.6));
      for (let x = 0; x < w; x++) {
        const az = (x / w) * Math.PI * 2;
        const k = 1 + sunward * Math.max(0, Math.cos(az - 2.2)) * (1 - Math.abs(v - 0.42) * 1.4);
        const o = (y * w + x) * 4;
        data[o] = t.r * k * gain;
        data[o + 1] = t.g * k * gain;
        data[o + 2] = t.b * k * gain;
        data[o + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  setLightPreset(p: LightPreset): void {
    this.preset = p;
    let env = this.envs.get(p);
    if (!env) {
      if (p === 'studio') {
        const room = new RoomEnvironment();
        env = this.pmrem.fromScene(room, 0.04).texture;
        room.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            (m.material as THREE.Material).dispose();
          }
        });
      } else {
        const sky = this.gradient(0x3f6ea8, 0xd9cdb4, 0x6b6152, 1.9, 0.55);
        env = this.pmrem.fromEquirectangular(sky).texture;
        sky.dispose();
      }
      this.envs.set(p, env);
    }
    this.scene.environment = env;

    let bg = this.backgrounds.get(p);
    if (!bg) {
      bg = p === 'studio'
        ? this.gradient(0x191c21, 0x3c4149, 0x2a2d33, 1, 0)
        : this.gradient(0x5b8ec4, 0xc9d6e0, 0x8a806c, 1, 0.2);
      this.backgrounds.set(p, bg);
    }
    this.scene.background = this.plate ? this.plateBackdrop() : bg;

    if (p === 'studio') {
      // A neutral room. The probe does most of the work, so the key is there for form and
      // for a shadow rather than for exposure.
      this.scene.environmentIntensity = 0.85;
      this.sun.color.set(0xffffff);
      this.sun.intensity = 1.9;
      this.fill.color.set(0xc9d6e4);
      this.fill.groundColor.set(0x6a655a);
      this.fill.intensity = 0.5;
      this.bounce.intensity = 0.18;
      (this.ground.material as THREE.MeshStandardMaterial).color.set(0x55585e);
    } else {
      // The battle's own numbers: sun intensity 3 (`SkySystem.sunIntensity`), hemisphere
      // 0x9dbcdc over 0x6b5a3e at 0.42, warm bounce 0xffd9a8 at 0.24, and the probe trimmed
      // to 0.6 for the lighting rig's contrast.
      this.scene.environmentIntensity = 0.6;
      this.sun.color.set(0xfff2dc);
      this.sun.intensity = 3;
      this.fill.color.set(0x9dbcdc);
      this.fill.groundColor.set(0x6b5a3e);
      this.fill.intensity = 0.42;
      this.bounce.intensity = 0.24;
      (this.ground.material as THREE.MeshStandardMaterial).color.set(0x7d7460);
    }
  }

  get lightPreset(): LightPreset {
    return this.preset;
  }

  setGroundVisible(on: boolean): void {
    this.ground.visible = on;
    this.grid.visible = on;
  }

  setGaugeVisible(on: boolean): void {
    this.gauge.visible = on;
  }

  /**
   * Plate mode: the framing a *comparison* is shot in, as opposed to the framing an
   * inspection is shot in.
   *
   * Every blind round on this project has graded battle screenshots, in which a man is a
   * few hundred pixels among nine thousand and the grader ends up sorting on grass seams and
   * terrain rather than on the soldier. One man, large, is a strictly better instrument —
   * but only if the *frame* is not itself the tell. Against a press-plate crop of a Rome II
   * soldier, a studio grid and a measuring rule sort the deck in one glance, so plate mode
   * removes them and puts back the three things a real crop has:
   *
   *   - **a defocused ground**, not a grid. A tight crop of a battle plate has a
   *     low-frequency warm-grey field behind the man, so the disc keeps its shadow-catching
   *     job and loses its texture.
   *   - **a graded backdrop**, darker at the top than the bottom, which is what aerial
   *     perspective plus a dust layer does behind a man at 8 m.
   *   - **the game's own light**, i.e. the `field` preset. A studio key is the wrong
   *     question: nobody ships the studio.
   *
   * It is deliberately *not* a cut-out on white. An alpha matte would make the silhouette
   * the only thing graded and would hide exactly the defect this workstream is chasing,
   * which is how light behaves across a form.
   */
  setPlate(on: boolean): void {
    this.plate = on;
    this.grid.visible = !on;
    this.gauge.visible = !on;
    this.ground.visible = true;
    this.setLightPreset(on ? 'field' : this.preset);
    if (on) (this.ground.material as THREE.MeshStandardMaterial).color.set(0x6c6555);
  }

  /**
   * The backdrop a plate is shot against.
   *
   * Deliberately low-frequency: a *structured* backdrop would leak into the harshness and
   * block-contrast measurements that grade the man, and the point of the isolated deck is
   * that everything in the frame except the soldier is uninformative.
   */
  private plateBackdrop(): THREE.Texture {
    let bg = this.backgrounds.get('plate');
    if (!bg) {
      // Cool and dark above, dusty below. Deliberately *cooler* than the field sky: the
      // grade's warm/cool split keys off a display-referred luminance crossover, and a warm
      // backdrop filling two-thirds of a portrait frame drags the whole plate to one side of
      // it and comes out monochrome sepia — which is what the first graded plates did.
      bg = this.gradient(0x39424e, 0x6f7076, 0x5d574c, 1, 0.10);
      this.backgrounds.set('plate', bg);
    }
    return bg;
  }

  get plateMode(): boolean {
    return this.plate;
  }

  /**
   * Put the rule beside the subject, on the camera's left and *at the subject's depth*.
   *
   * Offsetting it along world -X instead put it nearer or further than the subject depending
   * on the orbit angle, and a measuring rule that is closer to the lens than the thing it
   * measures reads taller than it is. Perspective foreshortening is precisely the error the
   * rule exists to defeat, so it has to sit in the subject's own plane.
   */
  placeGaugeBeside(cx: number, cy: number, cz: number, offset: number): void {
    const f = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    f.y = 0;
    if (f.lengthSq() < 1e-8) f.set(0, 0, 1);
    f.normalize();
    // Camera-left in the ground plane.
    this.gauge.position.set(cx + f.z * offset, 0, cz - f.x * offset);
    void cy;
  }

  setShadows(on: boolean): void {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
  }

  setTurntable(on: boolean): void {
    this.controls.autoRotate = on;
  }

  /**
   * Near-orthographic projection, by lens rather than by camera swap.
   *
   * A 6° lens pulled back to keep the same framing removes essentially all perspective
   * convergence, which is what you need to judge proportion, silhouette and whether two
   * things are the same height. A true `OrthographicCamera` would be more exact but means
   * rebuilding the orbit controls and re-solving every frame call against a different
   * projection; the long lens gets the same answer and keeps one code path.
   *
   * 6° is not arbitrary: at the ~2 m working distance for a single man it puts the far and
   * near shoulders within 0.4% of the same scale, which is below what a screenshot resolves.
   */
  setLongLens(on: boolean): void {
    this.camera.fov = on ? 6 : 38;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Frame a box rather than a sphere.
   *
   * A sphere fit is what most viewers do and it wastes the frame badly on this subject: a man
   * is 1.75 m tall and 0.6 m wide, so his bounding sphere is 40% empty air and he ends up a
   * fifth of the frame height. Solving height against the vertical field of view and width
   * against the horizontal one — and taking whichever binds — puts him edge to edge.
   *
   * `halfD` enters as part of the horizontal extent because the camera looks in from an
   * azimuth, so depth projects into width; the exact projected width depends on the angle and
   * the hypotenuse is the safe bound.
   */
  frame(
    cx: number, cy: number, cz: number,
    halfW: number, halfH: number, halfD: number,
    azimuth = -0.85, elevation = 0.14, margin = 1.12
  ): void {
    const fovY = (this.camera.fov * Math.PI) / 180;
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * this.camera.aspect);
    const across = Math.hypot(halfW, halfD);
    const dist = Math.max(
      halfH / Math.tan(fovY / 2),
      across / Math.tan(fovX / 2)
    ) * margin + across * 0.6;
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(
      cx + Math.sin(azimuth) * Math.cos(elevation) * dist,
      cy + Math.sin(elevation) * dist,
      cz + Math.cos(azimuth) * Math.cos(elevation) * dist
    );
    this.controls.update();
  }

  /** Stand a given distance back, keeping the current direction — for the LOD edge buttons. */
  standOff(distance: number): void {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
    dir.normalize().multiplyScalar(distance);
    this.camera.position.copy(this.controls.target).add(dir);
    this.controls.update();
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.canvasW = w;
    this.canvasH = h;
    this.grade.resize(w, h, this.renderer.getPixelRatio());
  }

  /**
   * Put the game's tone map, grade and sharpen on the viewer's output.
   *
   * Off for inspection, on for a comparison plate. See `grade.ts` for why the difference
   * matters more than it sounds: the bare renderer path is AgX with no black point, no
   * scene-linear contrast and no warm/cool split, and it is not what the product ships.
   */
  setGraded(on: boolean): void {
    this.grade.enabled = on;
    this.grade.resize(this.canvasW, this.canvasH, this.renderer.getPixelRatio());
  }

  get graded(): boolean {
    return this.grade.enabled;
  }

  /** Keep the sun rig pointed at the subject so the key light does not slide off it. */
  aimSun(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.set(x + 4.2, y + 7.4, z - 6.1);
    this.bounce.position.set(x - 5, y + 2.2, z + 5.5);
  }

  render(): void {
    this.controls.update();
    if (this.grade.enabled) this.grade.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }
}
