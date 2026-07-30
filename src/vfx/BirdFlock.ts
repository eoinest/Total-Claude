import * as THREE from 'three';
import type { BattleSystem } from '../sim/BattleSystem';
import { SoldierState } from '../sim/types';
import { clamp, clamp01, damp } from '../util/math';
import { hash01 } from '../util/rand';

/**
 * Crows over the field.
 *
 * Astonishing value for the cost. A dozen birds turning slowly above the fighting give
 * the sky scale, tie the empty upper two-thirds of a wide shot to the action below, and
 * — once they start dropping onto the dead — narrate the battle's outcome without a
 * single line of UI.
 *
 * One draw call. Flapping happens in the vertex shader: each vertex carries a wing side
 * (-1, 0, +1) and the shader rotates the wing panels about the bird's fore-aft axis by
 * a per-instance phase. That means real articulated flight from a static geometry with
 * no per-frame vertex writes.
 *
 * The flock has three states: circling a drift point that follows the densest fighting,
 * gliding down to a chosen corpse, and perched on it with the occasional startled hop.
 */

interface Bird {
  /** 0 circling, 1 descending, 2 perched. */
  mode: number;
  /** Orbit parameters while circling. */
  cx: number;
  cz: number;
  radius: number;
  angle: number;
  angVel: number;
  alt: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  /** Flap phase and rate; perched birds barely move. */
  phase: number;
  flap: number;
  /** Seconds until the next state decision. */
  timer: number;
  scale: number;
}

const VERT = /* glsl */ `
precision highp float;

uniform float uTime;

attribute vec3 aPos;
attribute vec3 aParams;   // yaw, flapPhase, flapRate
attribute vec2 aScale;    // scale, wing amplitude (0 when perched)
attribute float aWing;    // -1 left panel, 0 body, +1 right panel

varying float vShade;

void main() {
  vec3 lp = position * aScale.x;

  if (abs(aWing) > 0.5) {
    // Wings hinge about the bird's own fore-aft (local Z) axis.
    float amp = aScale.y;
    float a = sin(uTime * aParams.z + aParams.y) * 0.95 * amp;
    // Downstroke sweeps forward as well as down: it is what reads as thrust.
    float sweep = cos(uTime * aParams.z + aParams.y) * 0.20 * amp;
    float ang = a * sign(aWing);
    float c = cos(ang);
    float s = sin(ang);
    vec3 r = vec3(lp.x * c - lp.y * s, lp.x * s + lp.y * c, lp.z + abs(lp.x) * sweep);
    lp = r;
  }

  float cy = cos(aParams.x);
  float sy = sin(aParams.x);
  vec3 wp = aPos + vec3(lp.x * cy + lp.z * sy, lp.y, -lp.x * sy + lp.z * cy);

  // Wings catch a little light on the upstroke; bodies stay dark.
  vShade = 0.55 + 0.45 * clamp(lp.y * 3.0 + 0.5, 0.0, 1.0);

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunColour;
uniform vec3 uAmbient;
varying float vShade;
void main() {
  // Corvid black is never actually black: it is a very dark blue-grey with a sheen.
  vec3 base = vec3(0.035, 0.036, 0.045);
  vec3 lit = uAmbient * 1.5 + uSunColour * vShade * 0.55;
  gl_FragColor = vec4(base * 2.2 * lit + uSunColour * pow(vShade, 6.0) * 0.06, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = 1.0;
}
`;

export class BirdFlock {
  readonly mesh: THREE.Mesh;

  private birds: Bird[] = [];
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.InstancedBufferAttribute;
  private aParams: THREE.InstancedBufferAttribute;
  private aScale: THREE.InstancedBufferAttribute;
  private t = 0;
  /** Point the flock circles; drifts toward wherever men are dying. */
  private driftX = 0;
  private driftZ = 0;
  private corpseX: number[] = [];
  private corpseZ: number[] = [];
  private corpseScan = 0;
  private landingUrge = 0;

  constructor(count: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.buildBirdGeometry();

    const inst = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = inst(3);
    this.aParams = inst(3);
    this.aScale = inst(2);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aParams', this.aParams);
    this.geo.setAttribute('aScale', this.aScale);
    this.geo.instanceCount = count;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunColour: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0.2, 0.25, 0.33) },
      },
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vfx-crows';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    for (let i = 0; i < count; i++) {
      const h1 = hash01(i, 501);
      const h2 = hash01(i, 503);
      const h3 = hash01(i, 509);
      this.birds.push({
        mode: 0,
        cx: 0, cz: 0,
        radius: 34 + h1 * 78,
        angle: h2 * Math.PI * 2,
        // Slower birds on the wide orbits, so the flock never rotates as one body.
        angVel: (0.11 + h3 * 0.13) * (h1 < 0.5 ? 1 : -1),
        alt: 26 + h3 * 42,
        x: 0, y: 40, z: 0,
        yaw: 0,
        targetX: 0, targetY: 0, targetZ: 0,
        phase: h2 * Math.PI * 2,
        flap: 3.4 + h1 * 2.2,
        timer: 4 + h2 * 20,
        scale: 0.86 + h3 * 0.4,
      });
    }
  }

  /**
   * A crow: dart-shaped body, tail, and two wing panels. 12 triangles. `aWing` marks
   * which vertices belong to the articulating panels.
   */
  private buildBirdGeometry(): void {
    const pos: number[] = [];
    const wing: number[] = [];
    const idx: number[] = [];

    const v = (x: number, y: number, z: number, w: number): number => {
      pos.push(x, y, z);
      wing.push(w);
      return pos.length / 3 - 1;
    };

    // Body: a flattened diamond, nose at +Z.
    const nose = v(0, 0, 0.30, 0);
    const tail = v(0, 0.01, -0.34, 0);
    const bl = v(-0.055, 0, 0.02, 0);
    const br = v(0.055, 0, 0.02, 0);
    const bt = v(0, 0.055, 0.0, 0);
    const bb = v(0, -0.045, 0.0, 0);
    idx.push(nose, bl, bt, nose, bt, br, nose, br, bb, nose, bb, bl);
    idx.push(tail, bt, bl, tail, br, bt, tail, bb, br, tail, bl, bb);

    // Tail fan.
    const t1 = v(-0.09, 0.01, -0.50, 0);
    const t2 = v(0.09, 0.01, -0.50, 0);
    idx.push(tail, t1, t2);

    // Wing panels: swept, with a slight dihedral at rest.
    for (const side of [-1, 1]) {
      const root1 = v(side * 0.05, 0.02, 0.10, side);
      const root2 = v(side * 0.05, 0.02, -0.14, side);
      const mid = v(side * 0.40, 0.05, 0.02, side);
      const tip = v(side * 0.72, 0.07, -0.16, side);
      const trail = v(side * 0.34, 0.03, -0.26, side);
      idx.push(root1, mid, root2);
      idx.push(root2, mid, trail);
      idx.push(mid, tip, trail);
    }

    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
    this.geo.setIndex(idx);
  }

  update(dt: number, battle: BattleSystem, camX: number, camZ: number, groundAt: (x: number, z: number) => number): void {
    this.t += dt;
    this.mat.uniforms.uTime.value = this.t;

    this.scanCorpses(battle);

    // The flock drifts toward wherever the fighting is, which is where the food is.
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const u of battle.units) {
      if (u.destroyed || !u.engaged) continue;
      sx += u.x;
      sz += u.z;
      n++;
    }
    if (n === 0) {
      sx = camX;
      sz = camZ;
    } else {
      sx /= n;
      sz /= n;
    }
    this.driftX = damp(this.driftX, sx, 0.15, dt);
    this.driftZ = damp(this.driftZ, sz, 0.15, dt);

    // The urge to land grows with the number of dead lying about.
    const dead = this.corpseX.length;
    this.landingUrge = clamp01(dead / 90);

    for (let i = 0; i < this.birds.length; i++) {
      this.updateBird(this.birds[i], i, dt, groundAt);
      const b = this.birds[i];
      this.aPos.array[i * 3] = b.x;
      this.aPos.array[i * 3 + 1] = b.y;
      this.aPos.array[i * 3 + 2] = b.z;
      this.aParams.array[i * 3] = b.yaw;
      this.aParams.array[i * 3 + 1] = b.phase;
      this.aParams.array[i * 3 + 2] = b.flap;
      this.aScale.array[i * 2] = b.scale;
      // Perched birds fold their wings; gliding birds hold them nearly still.
      this.aScale.array[i * 2 + 1] = b.mode === 2 ? 0.06 : b.mode === 1 ? 0.35 : 1;
    }
    this.aPos.needsUpdate = true;
    this.aParams.needsUpdate = true;
    this.aScale.needsUpdate = true;
  }

  /** Sample a slice of the pool each frame; a full scan every frame is pointless. */
  private scanCorpses(battle: BattleSystem): void {
    const p = battle.pool;
    const n = p.count;
    if (n === 0) return;
    const slice = 512;
    let found = 0;
    if (this.corpseScan === 0) {
      this.corpseX.length = 0;
      this.corpseZ.length = 0;
    }
    for (let k = 0; k < slice && this.corpseScan + k < n; k++) {
      const i = this.corpseScan + k;
      if (p.state[i] !== SoldierState.Dead) continue;
      if (this.corpseX.length < 220) {
        this.corpseX.push(p.x[i]);
        this.corpseZ.push(p.z[i]);
      }
      found++;
    }
    void found;
    this.corpseScan += slice;
    if (this.corpseScan >= n) this.corpseScan = 0;
  }

  private updateBird(b: Bird, i: number, dt: number, groundAt: (x: number, z: number) => number): void {
    b.timer -= dt;

    if (b.mode === 0) {
      b.cx = damp(b.cx, this.driftX, 0.35, dt);
      b.cz = damp(b.cz, this.driftZ, 0.35, dt);
      b.angle += b.angVel * dt;
      const px = b.x;
      const pz = b.z;
      b.x = b.cx + Math.cos(b.angle) * b.radius;
      b.z = b.cz + Math.sin(b.angle) * b.radius;
      // A slow vertical wander: thermals, and it stops the orbit reading as a ring.
      const bob = Math.sin(this.t * 0.31 + b.phase) * 4.5 + Math.sin(this.t * 0.13 + b.phase * 2) * 2.5;
      b.y = damp(b.y, groundAt(b.x, b.z) + b.alt + bob, 2.4, dt);
      b.yaw = Math.atan2(b.x - px, b.z - pz);
      // Wings beat, then rest: crows flap in bursts and glide between them.
      b.flap = 3.0 + Math.max(0, Math.sin(this.t * 0.37 + b.phase)) * 4.5;

      if (b.timer <= 0 && this.corpseX.length > 4 && hash01(i, (this.t * 3) | 0) < this.landingUrge * 0.55) {
        const k = (hash01(i, 601 + ((this.t * 7) | 0)) * this.corpseX.length) | 0;
        b.targetX = this.corpseX[k] + (hash01(i, 607) - 0.5) * 2.2;
        b.targetZ = this.corpseZ[k] + (hash01(i, 613) - 0.5) * 2.2;
        b.targetY = groundAt(b.targetX, b.targetZ) + 0.16;
        b.mode = 1;
        b.timer = 9;
      } else if (b.timer <= 0) {
        b.timer = 5 + hash01(i, (this.t * 11) | 0) * 16;
      }
      return;
    }

    if (b.mode === 1) {
      const dx = b.targetX - b.x;
      const dz = b.targetZ - b.z;
      const d = Math.hypot(dx, dz);
      const speed = clamp(4 + d * 0.5, 3, 16);
      if (d > 0.5) {
        b.x += (dx / d) * speed * dt;
        b.z += (dz / d) * speed * dt;
        b.yaw = Math.atan2(dx, dz);
      }
      // Glide slope: steeper the closer it gets, flaring at the end.
      b.y = damp(b.y, b.targetY + clamp(d * 0.35, 0, 12), 2.2, dt);
      if (d < 0.7 && b.y - b.targetY < 0.4) {
        b.mode = 2;
        b.y = b.targetY;
        b.timer = 8 + hash01(i, 619) * 26;
      }
      if (b.timer <= 0) {
        b.mode = 0;
        b.timer = 12;
      }
      return;
    }

    // Perched: small hops and head turns; startled back into the air after a while.
    b.y = b.targetY + Math.abs(Math.sin(this.t * 2.1 + b.phase)) * 0.05;
    b.yaw += Math.sin(this.t * 0.7 + b.phase) * dt * 1.4;
    b.flap = 0.8;
    if (b.timer <= 0) {
      b.mode = 0;
      b.alt = 22 + hash01(i, (this.t * 13) | 0) * 40;
      b.timer = 16 + hash01(i, 631) * 20;
    }
  }

  setLighting(sunColour: THREE.Color, ambient: THREE.Color): void {
    (this.mat.uniforms.uSunColour.value as THREE.Color).copy(sunColour);
    (this.mat.uniforms.uAmbient.value as THREE.Color).copy(ambient);
  }

  get perched(): number {
    let n = 0;
    for (const b of this.birds) if (b.mode === 2) n++;
    return n;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
