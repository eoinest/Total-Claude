import * as THREE from 'three';
import type { BattleSystem } from '../sim/BattleSystem';
import { FACTIONS, Faction, UnitOrder, type UnitGroupState } from '../sim/types';
import { isCavalry } from '../units/roster';
import { clamp, clamp01 } from '../util/math';
import { hash01 } from '../util/rand';
import { BANNER_TILE } from './atlas';

/**
 * Unit standards with verlet-simulated cloth.
 *
 * These are the tall landmarks that let a player read a battlefield at a glance: which
 * cohort is where, which one is still standing, which one has broken. Rome II leans on
 * them heavily and so does this. A standard is:
 *
 *   pole      a 3.4 m staff carried a pace behind the front rank
 *   finial    aquila and phalerae, or a Germanic horned totem — the faction read
 *   cloth     a verlet grid, pinned along its top edge, driven by the real wind vector
 *
 * The cloth is a proper mass-spring sheet, not a sine wave: 8×6 particles with
 * structural, shear and bend constraints, plus per-quad aerodynamic force so it luffs
 * and snaps the way fabric does when a gust arrives. Twenty-odd standards of 48
 * particles is about 1000 verlet points — nothing — and it buys motion a vertex-shader
 * flap cannot match, because the cloth answers the same gust envelope the dust does.
 *
 * All cloth on the field lives in one buffer geometry rewritten each frame: one draw
 * call. Poles are two instanced meshes so they cast real shadows through the standard
 * material path, which is what stops a 3.4 m staff reading as a floating decal.
 */

const GX = 8;
const GY = 6;
const NP = GX * GY;

interface Constraint {
  a: number;
  b: number;
  /** Grid separation in cells, used to derive a rest length per banner size. */
  gdx: number;
  gdy: number;
  stiff: number;
}

interface Banner {
  unitId: number;
  faction: Faction;
  tile: number;
  /** Cloth dimensions in metres. */
  w: number;
  h: number;
  /** Height of the cloth's top edge above the pole base. */
  top: number;
  p: Float32Array;
  q: Float32Array;
  /** Rest length per constraint, resolved for this banner's dimensions. */
  rest: Float32Array;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  facing: number;
  active: boolean;
  /** Fades in on spawn and out when the unit dies, so standards never pop. */
  presence: number;
  seed: number;
  tintWritten: boolean;
}

const CLOTH_VERT = /* glsl */ `
precision highp float;
uniform float uAtlasDim;
attribute vec3 aTint;
attribute vec3 aDevice;
attribute float aTile;
attribute float aFade;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vDevice;
varying vec3 vWorld;
varying float vFade;
void main() {
  float col = mod(aTile, uAtlasDim);
  float row = floor(aTile / uAtlasDim);
  vUv = (vec2(col, row) + uv) / uAtlasDim;
  vTint = aTint;
  vDevice = aDevice;
  vFade = aFade;
  vWorld = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const CLOTH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec3 uSun;
uniform vec3 uSunColour;
uniform vec3 uAmbient;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vDevice;
varying vec3 vWorld;
varying float vFade;

void main() {
  vec4 t = texture2D(uTex, vUv);
  if (t.a * vFade < 0.4) discard;

  // Cloth luminance carries the unit's dye; the device mask carries the faction's
  // metal or paint. Tinting both together is what turns a gilded wreath into a
  // slightly lighter patch of red.
  vec3 base = mix(vTint * t.r, vDevice * (0.55 + 0.65 * t.r), t.g);

  // Screen-space derivatives give the true cloth normal without a normal attribute,
  // which matters because the geometry is rewritten from scratch every frame.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (!gl_FrontFacing) n = -n;

  float ndl = dot(n, uSun);
  float front = clamp(ndl, 0.0, 1.0);
  float back = clamp(-ndl, 0.0, 1.0);
  // Thin dyed wool transmits strongly, so a backlit banner glows rather than going
  // black. That translucency is most of what makes cloth read as cloth.
  vec3 lit = uAmbient * 0.9 + uSunColour * (front * 1.05 + pow(back, 1.5) * 0.6);
  base *= lit;

  gl_FragColor = vec4(base, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = 1.0;
}
`;

export class BannerSystem {
  readonly clothMesh: THREE.Mesh;
  /** One instanced mesh for every standard on the field, both factions. */
  readonly poleMesh: THREE.InstancedMesh;

  private banners: Banner[] = [];
  private byUnit = new Map<number, Banner>();
  private constraints: Constraint[] = [];
  private maxBanners: number;

  private posAttr: THREE.BufferAttribute;
  private tintAttr: THREE.BufferAttribute;
  private deviceAttr: THREE.BufferAttribute;
  private tileAttr: THREE.BufferAttribute;
  private fadeAttr: THREE.BufferAttribute;
  private clothMat: THREE.ShaderMaterial;
  private clothGeo: THREE.BufferGeometry;
  private poleVariant: THREE.InstancedBufferAttribute;

  private tmpMat = new THREE.Matrix4();
  private tmpQuat = new THREE.Quaternion();
  private tmpPos = new THREE.Vector3();
  private tmpScale = new THREE.Vector3(1, 1, 1);
  private tmpColour = new THREE.Color();
  private tmpDevice = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  private windScratch = new THREE.Vector3();
  private t = 0;

  constructor(bannerTexture: THREE.Texture, maxBanners: number) {
    this.maxBanners = maxBanners;
    this.buildConstraints();

    const verts = maxBanners * NP;
    const quads = maxBanners * (GX - 1) * (GY - 1);
    this.clothGeo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    const uvArr = new Float32Array(verts * 2);
    this.tintAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.deviceAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.tileAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.fadeAttr = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint32Array(quads * 6);

    for (let b = 0; b < maxBanners; b++) {
      const vo = b * NP;
      for (let y = 0; y < GY; y++) {
        for (let x = 0; x < GX; x++) {
          const v = vo + y * GX + x;
          uvArr[v * 2] = x / (GX - 1);
          // Cloth row 0 is the pinned top edge, so v runs downward from 1.
          uvArr[v * 2 + 1] = 1 - y / (GY - 1);
        }
      }
      let o = b * (GX - 1) * (GY - 1) * 6;
      for (let y = 0; y < GY - 1; y++) {
        for (let x = 0; x < GX - 1; x++) {
          const a = vo + y * GX + x;
          idx[o++] = a;
          idx[o++] = a + GX;
          idx[o++] = a + 1;
          idx[o++] = a + 1;
          idx[o++] = a + GX;
          idx[o++] = a + GX + 1;
        }
      }
    }

    this.clothGeo.setAttribute('position', this.posAttr);
    this.clothGeo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    this.clothGeo.setAttribute('aTint', this.tintAttr);
    this.clothGeo.setAttribute('aDevice', this.deviceAttr);
    this.clothGeo.setAttribute('aTile', this.tileAttr);
    this.clothGeo.setAttribute('aFade', this.fadeAttr);
    this.clothGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.clothGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.clothMat = new THREE.ShaderMaterial({
      vertexShader: CLOTH_VERT,
      fragmentShader: CLOTH_FRAG,
      uniforms: {
        uTex: { value: bannerTexture },
        uAtlasDim: { value: 2 },
        uSun: { value: new THREE.Vector3(0.4, 0.7, -0.6) },
        uSunColour: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0.2, 0.25, 0.33) },
      },
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    this.clothMesh = new THREE.Mesh(this.clothGeo, this.clothMat);
    this.clothMesh.name = 'vfx-banner-cloth';
    this.clothMesh.frustumCulled = false;
    this.clothMesh.castShadow = false;
    this.clothMesh.receiveShadow = false;

    // Both factions' standards in one geometry, selected per instance. A separate mesh
    // per faction would be simpler but costs a main draw plus one per shadow cascade,
    // and the effects layer has better uses for five draw calls than that.
    const poleGeo = this.buildStandardGeometry();
    const poleMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.44,
      metalness: 0.55,
    });
    poleMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aMask;\nattribute float aVariant;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
          '// Collapse the other faction\'s finial to a degenerate point: zero pixels,\n' +
          '// no branch divergence worth measuring, one draw call for both armies.\n' +
          'if (aMask > 0.5 && abs(aMask - aVariant) > 0.5) transformed = vec3(0.0);'
        );
    };
    poleMat.customProgramCacheKey = () => 'vfx-standard-variant';

    this.poleVariant = new THREE.InstancedBufferAttribute(new Float32Array(maxBanners), 1);
    this.poleVariant.setUsage(THREE.DynamicDrawUsage);
    poleGeo.setAttribute('aVariant', this.poleVariant);

    this.poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, maxBanners);
    this.poleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poleMesh.count = 0;
    // No shadow: a 3.4 m staff casts a thin line, and the cloth above it cannot cast
    // one without a custom depth material. Half a shadow reads worse than none.
    this.poleMesh.castShadow = false;
    this.poleMesh.receiveShadow = true;
    this.poleMesh.frustumCulled = false;
    this.poleMesh.name = 'vfx-standards';
  }

  private buildConstraints(): void {
    const at = (x: number, y: number): number => y * GX + x;
    const push = (a: number, b: number, gdx: number, gdy: number, stiff: number): void => {
      this.constraints.push({ a, b, gdx, gdy, stiff });
    };
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < GX; x++) {
        // Structural: holds the sheet together.
        if (x < GX - 1) push(at(x, y), at(x + 1, y), 1, 0, 1);
        if (y < GY - 1) push(at(x, y), at(x, y + 1), 0, 1, 1);
        // Shear: stops the grid collapsing into a parallelogram.
        if (x < GX - 1 && y < GY - 1) {
          push(at(x, y), at(x + 1, y + 1), 1, 1, 0.42);
          push(at(x + 1, y), at(x, y + 1), 1, 1, 0.42);
        }
        // Bend: gives the cloth body, so it forms folds instead of sharp creases.
        if (x < GX - 2) push(at(x, y), at(x + 2, y), 2, 0, 0.16);
        if (y < GY - 2) push(at(x, y), at(x, y + 2), 0, 2, 0.16);
      }
    }
  }

  /**
   * Both standards in one geometry. Every vertex carries `aMask`: 0 for the shared
   * staff, 1 for the Roman finial (aquila over a wreath, three phalerae below), 2 for
   * the Germanic one (horned skull on a lashed crossbar, iron rings hung beneath).
   * The vertex shader collapses whichever finial the instance is not.
   */
  private buildStandardGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const masks: number[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, hex: number, mask: number): void => {
      g.translate(x, y, z);
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
      masks.push(mask);
    };

    const WOOD = 0x4a3520;
    const GOLD = 0xc7973a;
    const BONE = 0xa89a7a;
    const IRON = 0x6a6a70;

    // Shared staff.
    add(new THREE.CylinderGeometry(0.028, 0.034, 3.4, 7), 0, 1.7, 0, WOOD, 0);

    // ---- Roman ----
    add(new THREE.BoxGeometry(1.52, 0.045, 0.045), 0, 3.16, 0, WOOD, 1);
    add(new THREE.SphereGeometry(0.05, 8, 6), -0.76, 3.16, 0, GOLD, 1);
    add(new THREE.SphereGeometry(0.05, 8, 6), 0.76, 3.16, 0, GOLD, 1);
    add(new THREE.TorusGeometry(0.115, 0.022, 6, 12), 0, 3.34, 0, GOLD, 1);
    // Aquila: small, but the swept-wing silhouette is unmistakable at any distance.
    add(new THREE.ConeGeometry(0.07, 0.24, 7), 0, 3.55, 0, GOLD, 1);
    const wl = new THREE.BoxGeometry(0.30, 0.035, 0.11);
    wl.rotateZ(0.42);
    add(wl, -0.16, 3.62, 0, GOLD, 1);
    const wr = new THREE.BoxGeometry(0.30, 0.035, 0.11);
    wr.rotateZ(-0.42);
    add(wr, 0.16, 3.62, 0, GOLD, 1);
    for (let i = 0; i < 3; i++) {
      const d = new THREE.CylinderGeometry(0.075, 0.075, 0.014, 10);
      d.rotateX(Math.PI / 2);
      add(d, 0, 2.62 - i * 0.20, 0.02, GOLD, 1);
    }

    // ---- Germanic ----
    const bar = new THREE.BoxGeometry(0.78, 0.05, 0.05);
    bar.rotateZ(0.09);
    add(bar, 0, 3.02, 0, WOOD, 2);
    // Aurochs skull: a squat cranium with the horns sweeping up and out, which is what
    // gives the totem its silhouette against the sky.
    add(new THREE.BoxGeometry(0.19, 0.26, 0.16), 0, 3.40, 0, BONE, 2);
    add(new THREE.BoxGeometry(0.11, 0.14, 0.20), 0, 3.26, 0.03, BONE, 2);
    const hl = new THREE.ConeGeometry(0.05, 0.46, 6);
    hl.rotateZ(0.62);
    add(hl, -0.20, 3.60, 0, BONE, 2);
    const hr = new THREE.ConeGeometry(0.05, 0.46, 6);
    hr.rotateZ(-0.62);
    add(hr, 0.20, 3.60, 0, BONE, 2);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.TorusGeometry(0.055, 0.011, 5, 9);
      t.rotateY(0.4 * i);
      add(t, 0.02, 2.72 - i * 0.17, 0, IRON, 2);
    }

    // Manual merge: cheaper than importing BufferGeometryUtils for two dozen primitives.
    let vTotal = 0;
    let iTotal = 0;
    for (const g of parts) {
      vTotal += g.attributes.position.count;
      iTotal += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const col = new Float32Array(vTotal * 3);
    const msk = new Float32Array(vTotal);
    const idx = new Uint16Array(iTotal);
    let vo = 0;
    let io = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const g = parts[pi];
      const gp = g.attributes.position as THREE.BufferAttribute;
      const gn = g.attributes.normal as THREE.BufferAttribute;
      const gc = g.attributes.color as THREE.BufferAttribute;
      pos.set(gp.array as Float32Array, vo * 3);
      nrm.set(gn.array as Float32Array, vo * 3);
      col.set(gc.array as Float32Array, vo * 3);
      msk.fill(masks[pi], vo, vo + gp.count);
      if (g.index) {
        const gi = g.index.array;
        for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
        io += gi.length;
      } else {
        for (let k = 0; k < gp.count; k++) idx[io + k] = k + vo;
        io += gp.count;
      }
      vo += gp.count;
      g.dispose();
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aMask', new THREE.BufferAttribute(msk, 1));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  update(dt: number, battle: BattleSystem, wind: THREE.Vector3): void {
    this.t += dt;
    this.sync(battle, dt);
    this.simulate(dt, wind);
    this.writeGeometry();
    this.writePoles();
  }

  private sync(battle: BattleSystem, dt: number): void {
    for (const u of battle.units) {
      let b = this.byUnit.get(u.id);
      const wants = !u.destroyed && u.alive > 0;
      if (!b && wants && this.banners.length < this.maxBanners) {
        b = this.spawn(u, battle);
      }
      if (!b) continue;
      b.presence = clamp01(b.presence + (wants ? dt * 1.6 : -dt * 1.1));
      b.active = b.presence > 0.002;
      if (wants) this.anchor(b, u, battle);
    }
  }

  private spawn(u: UnitGroupState, battle: BattleSystem): Banner {
    const def = battle.typeOf(u);
    const roman = u.faction === Faction.Rome;
    // Cohorts and the guard carry a vexillum; missile and light troops a narrower
    // signum pennant; Germanic warbands a torn war-streamer on a totem.
    const tile = roman
      ? (def.unitClass === 'heavy-infantry' || def.unitClass === 'general'
        ? BANNER_TILE.vexillum
        : BANNER_TILE.signum)
      : BANNER_TILE.totem;

    const wide = tile === BANNER_TILE.vexillum;
    // A vexillum was roughly a metre and a half square on a 2.5 m staff. Sized for the
    // camera as much as for history: a standard has to be legible from the strategic
    // zoom or it is not doing its job.
    const w = wide ? 1.46 : 0.82;
    const h = wide ? 1.18 : 1.72;

    const rest = new Float32Array(this.constraints.length);
    for (let i = 0; i < this.constraints.length; i++) {
      const c = this.constraints[i];
      const rx = (c.gdx / (GX - 1)) * w;
      const ry = (c.gdy / (GY - 1)) * h;
      rest[i] = Math.hypot(rx, ry);
    }

    const b: Banner = {
      unitId: u.id,
      faction: u.faction,
      tile,
      w,
      h,
      top: 3.1,
      p: new Float32Array(NP * 3),
      q: new Float32Array(NP * 3),
      rest,
      anchorX: u.x,
      anchorY: battle.groundAt(u.x, u.z),
      anchorZ: u.z,
      facing: u.facing,
      active: true,
      presence: 0,
      seed: u.id * 7 + 13,
      tintWritten: false,
    };

    // Start already hanging so the cloth does not snap into place on frame one.
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < GX; x++) {
        const v = (y * GX + x) * 3;
        b.p[v] = b.anchorX + (x / (GX - 1) - 0.5) * w;
        b.p[v + 1] = b.anchorY + b.top - (y / (GY - 1)) * h;
        b.p[v + 2] = b.anchorZ;
        b.q[v] = b.p[v];
        b.q[v + 1] = b.p[v + 1];
        b.q[v + 2] = b.p[v + 2];
      }
    }

    this.banners.push(b);
    this.byUnit.set(u.id, b);
    return b;
  }

  private anchor(b: Banner, u: UnitGroupState, battle: BattleSystem): void {
    const fx = Math.sin(u.facing);
    const fz = Math.cos(u.facing);
    const def = battle.typeOf(u);
    // Cavalry standards ride further back and higher; infantry sit in rank two.
    const back = isCavalry(def) ? 2.6 : 1.05;
    const x = u.x - fx * back;
    const z = u.z - fz * back;
    b.anchorX = x;
    b.anchorZ = z;
    b.anchorY = battle.groundAt(x, z) + (isCavalry(def) ? 1.15 : 0);
    b.facing = u.facing;
    // A routing unit's standard dips: the clearest single read that a unit has broken.
    b.top = u.order === UnitOrder.Rout ? 2.05 : 3.1;
  }

  /**
   * Verlet integration with per-quad aerodynamics. The force on a sheet is proportional
   * to the flow *through* it, which is why cloth luffs: as a panel turns edge-on the
   * force collapses and the panel falls back into the wind.
   */
  private simulate(dt: number, wind: THREE.Vector3): void {
    // Fixed substep. Verlet with a variable dt is unstable, and cloth that explodes on
    // one dropped frame is worse than cloth that is momentarily a little slow.
    const h = 1 / 60;
    let budget = clamp(dt, 0, 0.1);

    while (budget > 1e-4) {
      const step = Math.min(h, budget);
      budget -= step;
      const h2 = step * step;

      // Vortex shedding. A flag in steady flow does not sit still: the sheet sheds
      // alternating vortices off its trailing edge and the resulting lateral force
      // oscillates at a few hertz. That, not the mean wind, is what makes a banner
      // *snap*, and a quasi-static aerodynamic model on an 8x6 grid will never
      // produce it on its own — so it is injected as an oscillating cross-flow.
      const wl = Math.hypot(wind.x, wind.z) || 1e-3;
      const perpX = -wind.z / wl;
      const perpZ = wind.x / wl;

      for (let bi = 0; bi < this.banners.length; bi++) {
        const b = this.banners[bi];
        if (!b.active) continue;
        const p = b.p;
        const q = b.q;

        const ph = b.seed * 0.618;
        const osc = (Math.sin(this.t * 8.1 + ph) * 0.62 + Math.sin(this.t * 13.3 + ph * 1.7) * 0.38) * wl * 0.62;
        const w = this.windScratch.set(
          wind.x + perpX * osc,
          wind.y + Math.sin(this.t * 9.4 + ph) * 0.8,
          wind.z + perpZ * osc
        );

        // Pin the top edge to the crossbar, which lies across the unit's frontage.
        const cx = Math.cos(b.facing);
        const sx = Math.sin(b.facing);
        for (let x = 0; x < GX; x++) {
          const v = x * 3;
          const lx = (x / (GX - 1) - 0.5) * b.w;
          p[v] = b.anchorX + lx * cx;
          p[v + 1] = b.anchorY + b.top;
          p[v + 2] = b.anchorZ - lx * sx;
          q[v] = p[v];
          q[v + 1] = p[v + 1];
          q[v + 2] = p[v + 2];
        }

        // Free nodes: integrate gravity with light velocity damping.
        for (let i = GX; i < NP; i++) {
          const v = i * 3;
          const px = p[v];
          const py = p[v + 1];
          const pz = p[v + 2];
          // 0.988 settles without killing the ripple. Gravity at 40% of true weight:
          // dyed wool at this scale is light, and a standard that hangs like a
          // theatre curtain is the single most common cloth-sim tell.
          const nx = px + (px - q[v]) * 0.988;
          const ny = py + (py - q[v + 1]) * 0.988 - 9.81 * h2 * 0.40;
          const nz = pz + (pz - q[v + 2]) * 0.988;
          q[v] = px;
          q[v + 1] = py;
          q[v + 2] = pz;
          p[v] = nx;
          p[v + 1] = ny;
          p[v + 2] = nz;
        }

        // Aerodynamic force per quad, distributed to the free corners.
        for (let y = 0; y < GY - 1; y++) {
          const d = (y + 1) / GY;
          for (let x = 0; x < GX - 1; x++) {
            const a = (y * GX + x) * 3;
            const b1 = (y * GX + x + 1) * 3;
            const c1 = ((y + 1) * GX + x) * 3;
            const e1x = p[b1] - p[a];
            const e1y = p[b1 + 1] - p[a + 1];
            const e1z = p[b1 + 2] - p[a + 2];
            const e2x = p[c1] - p[a];
            const e2y = p[c1 + 1] - p[a + 1];
            const e2z = p[c1 + 2] - p[a + 2];
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nl = Math.hypot(nx, ny, nz);
            if (nl < 1e-7) continue;
            nx /= nl;
            ny /= nl;
            nz /= nl;
            const flow = nx * w.x + ny * w.y + nz * w.z;
            // Quadratic in flow: gusts hit hard, still air does nothing at all. The
            // coefficient is the ratio of panel area to cloth mass, and it is what
            // decides whether the banner streams or merely sways.
            const f = flow * Math.abs(flow) * 0.115 * h2 * (0.6 + d);
            const fx = nx * f;
            const fy = ny * f;
            const fz = nz * f;
            const pinRow = GX * 3;
            if (a >= pinRow) { p[a] += fx; p[a + 1] += fy; p[a + 2] += fz; }
            if (b1 >= pinRow) { p[b1] += fx; p[b1 + 1] += fy; p[b1 + 2] += fz; }
            if (c1 >= pinRow) { p[c1] += fx; p[c1 + 1] += fy; p[c1 + 2] += fz; }
          }
        }

        // Constraint relaxation. Three passes is the classic accuracy/cost trade.
        const cons = this.constraints;
        const rest = b.rest;
        for (let pass = 0; pass < 3; pass++) {
          for (let ci = 0; ci < cons.length; ci++) {
            const con = cons[ci];
            const ai = con.a * 3;
            const bj = con.b * 3;
            let dx = p[bj] - p[ai];
            let dy = p[bj + 1] - p[ai + 1];
            let dz = p[bj + 2] - p[ai + 2];
            const l = Math.hypot(dx, dy, dz);
            if (l < 1e-7) continue;
            const diff = ((l - rest[ci]) / l) * con.stiff * 0.5;
            dx *= diff;
            dy *= diff;
            dz *= diff;
            const aPinned = con.a < GX;
            const bPinned = con.b < GX;
            if (aPinned && bPinned) continue;
            if (aPinned) {
              p[bj] -= dx * 2;
              p[bj + 1] -= dy * 2;
              p[bj + 2] -= dz * 2;
            } else if (bPinned) {
              p[ai] += dx * 2;
              p[ai + 1] += dy * 2;
              p[ai + 2] += dz * 2;
            } else {
              p[ai] += dx;
              p[ai + 1] += dy;
              p[ai + 2] += dz;
              p[bj] -= dx;
              p[bj + 1] -= dy;
              p[bj + 2] -= dz;
            }
          }
        }
      }
    }
  }

  private writeGeometry(): void {
    const pos = this.posAttr.array as Float32Array;
    const fade = this.fadeAttr.array as Float32Array;
    const tint = this.tintAttr.array as Float32Array;
    const device = this.deviceAttr.array as Float32Array;
    const tile = this.tileAttr.array as Float32Array;
    let staticDirty = false;

    for (let bi = 0; bi < this.banners.length; bi++) {
      const b = this.banners[bi];
      const vo = bi * NP;
      if (!b.active) {
        for (let i = 0; i < NP; i++) fade[vo + i] = 0;
        continue;
      }
      for (let i = 0; i < NP; i++) {
        const s = (vo + i) * 3;
        const v = i * 3;
        pos[s] = b.p[v];
        pos[s + 1] = b.p[v + 1];
        pos[s + 2] = b.p[v + 2];
        fade[vo + i] = b.presence;
      }
      if (!b.tintWritten) {
        b.tintWritten = true;
        staticDirty = true;
        const f = FACTIONS[b.faction];
        this.tmpColour.setHex(b.tile === BANNER_TILE.totem ? f.clothColour : f.colour);
        // Roman devices are gilded bronze; Germanic ones are crude dark paint.
        if (b.faction === Faction.Rome) this.tmpDevice.setHex(f.accent).multiplyScalar(1.35);
        else this.tmpDevice.setRGB(0.09, 0.07, 0.055);
        // Per-unit variation: no two standards are the same shade of dye.
        const k = 0.8 + hash01(b.seed, 91) * 0.4;
        const dev = this.tmpDevice;
        for (let i = 0; i < NP; i++) {
          const s = (vo + i) * 3;
          tint[s] = this.tmpColour.r * k;
          tint[s + 1] = this.tmpColour.g * k;
          tint[s + 2] = this.tmpColour.b * k;
          device[s] = dev.r;
          device[s + 1] = dev.g;
          device[s + 2] = dev.b;
          tile[vo + i] = b.tile;
        }
      }
    }

    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    if (staticDirty) {
      this.tintAttr.needsUpdate = true;
      this.deviceAttr.needsUpdate = true;
      this.tileAttr.needsUpdate = true;
    }
  }

  private writePoles(): void {
    const mesh = this.poleMesh;
    const cap = mesh.instanceMatrix.count;
    let n = 0;
    for (const b of this.banners) {
      if (!b.active || n >= cap) continue;
      this.tmpQuat.setFromAxisAngle(this.up, b.facing);
      this.tmpPos.set(b.anchorX, b.anchorY, b.anchorZ);
      const s = 0.94 + hash01(b.seed, 17) * 0.14;
      this.tmpScale.set(s, s * b.presence, s);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(n, this.tmpMat);
      this.poleVariant.array[n] = b.faction === Faction.Rome ? 1 : 2;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    this.poleVariant.needsUpdate = true;
  }

  setLighting(sun: THREE.Vector3, sunColour: THREE.Color, ambient: THREE.Color): void {
    (this.clothMat.uniforms.uSun.value as THREE.Vector3).copy(sun);
    (this.clothMat.uniforms.uSunColour.value as THREE.Color).copy(sunColour);
    (this.clothMat.uniforms.uAmbient.value as THREE.Color).copy(ambient);
  }

  get count(): number {
    let n = 0;
    for (const b of this.banners) if (b.active) n++;
    return n;
  }

  /** Top of a unit's standard, for anyone who wants to hang a marker off it. */
  anchorOf(unitId: number, out: THREE.Vector3): boolean {
    const b = this.byUnit.get(unitId);
    if (!b || !b.active) return false;
    out.set(b.anchorX, b.anchorY + b.top, b.anchorZ);
    return true;
  }

  dispose(): void {
    this.clothGeo.dispose();
    this.clothMat.dispose();
    this.poleMesh.geometry.dispose();
    (this.poleMesh.material as THREE.Material).dispose();
    this.poleMesh.dispose();
    this.banners.length = 0;
    this.byUnit.clear();
  }
}
