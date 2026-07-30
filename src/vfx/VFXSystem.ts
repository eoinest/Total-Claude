import * as THREE from 'three';
import type { EngineContext, Subsystem } from '../core/Engine';
import type { BattleSystem } from '../sim/BattleSystem';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import type { SkySystem } from '../render/SkySystem';
import type { PostFXSystem } from '../render/PostFX';
import { SoldierState } from '../sim/types';
import { isCavalry } from '../units/roster';
import { clamp01 } from '../util/math';
import { hash01 } from '../util/rand';
import { makeBannerTexture, makeDecalAtlas, makeNoiseTexture, makeParticleAtlas, DT, PT } from './atlas';
import { buildHeightTexture, type HeightTexture } from './heightField';
import { PLayer, ParticleSystem } from './ParticleSystem';
import { GroundDamageLayer } from './GroundDamage';
import { DecalPool } from './DecalPool';
import { DustEmitter } from './DustEmitter';
import { CombatFX } from './CombatFX';
import { LitterField } from './Litter';
import { BannerSystem } from './BannerSystem';
import { BirdFlock } from './BirdFlock';
import { SmokeFire, EmitterKind } from './SmokeFire';
import { Weather, type WeatherKind } from './Weather';

/**
 * The effects subsystem: one registration, one place that owns every visual that is
 * neither terrain, soldier, city nor sky.
 *
 * Draw-call inventory (the whole VFX budget):
 *   1  soft particles      dust, smoke, blood, debris, rain, mist
 *   2  additive particles  sparks, embers, flame, shock rings
 *   3  ground damage       persistent accumulation overlay
 *   4  decals              crisp blood pools, splatter, scuffs
 *   5  banner cloth        every standard on the field
 *   6  standards           instanced poles and finials, both factions in one mesh
 *   7  crows
 *   8  litter              dropped shields, blades, helmets
 *   = 8 draw calls, no shadow passes. Weather rides the particle layers, so it is free.
 *
 * Everything is visual-only. Nothing here touches `fixedUpdate` or writes to the
 * soldier pool; the one place VFX wants to feed back into the sim (raising a man's
 * accumulated grime) is exposed as `grimeSink` for the integrator to wire, because the
 * pool is not this agent's file to write.
 */

/**
 * Soft-layer capacity is sized for the melee, not the march. Contact dust lives six to
 * ten seconds so that a modest spawn rate integrates into an opaque bank, and that
 * trades particle *count* for fill rate deliberately: 30k live billboards of 2–6 m at
 * battle range is ~4× screen overdraw, which on the measured budget costs well under a
 * millisecond, while the same optical depth from short-lived puffs would need five times
 * the spawn rate.
 */
const QUALITY_SCALE: Record<string, { soft: number; add: number; density: number; decals: number; birds: number; litter: number; spawns: number }> = {
  low: { soft: 6000, add: 1600, density: 0.32, decals: 200, birds: 8, litter: 900, spawns: 180 },
  medium: { soft: 14000, add: 3200, density: 0.62, decals: 380, birds: 12, litter: 1800, spawns: 520 },
  high: { soft: 26000, add: 5200, density: 1, decals: 640, birds: 16, litter: 3000, spawns: 1000 },
  ultra: { soft: 34000, add: 6400, density: 1.15, decals: 820, birds: 20, litter: 3600, spawns: 1400 },
};

export class VFXSystem implements Subsystem {
  readonly name = 'vfx';
  readonly order = 110;

  // ---- Public contract for other subsystems ----

  /**
   * Instantaneous wind in m/s, world space, including gusts. Vegetation, cloth and
   * anything else that should move with the weather can read this directly.
   */
  readonly wind = new THREE.Vector3();
  /** 0..1 gust envelope — useful as a cheap driver for grass sway amplitude. */
  gust = 0;

  /**
   * Optional hook the integrator wires so VFX can raise a soldier's accumulated
   * blood/dirt. The soldier pool is not this system's file to write, so blood does not
   * dirty men until this is set. In `main.ts`:
   *
   *   vfx.grimeSink = (i, amt) => {
   *     const g = battle.pool.grime;
   *     g[i] = Math.min(1, g[i] + amt);
   *   };
   */
  set grimeSink(fn: ((soldierIndex: number, amount: number) => void) | null) {
    this.combat.hooks.grimeSink = fn;
  }
  get grimeSink(): ((soldierIndex: number, amount: number) => void) | null {
    return this.combat.hooks.grimeSink;
  }

  /** Master switch, for A/B screenshots. */
  enabled = true;

  /**
   * Depth-buffer soft particles. Off by default, and deliberately so: `PostFX` exposes
   * the depth attachment of the render target it is *currently writing*, so sampling it
   * during the transparent pass is a read-write hazard on the same attachment — the
   * driver is entitled to return anything, and on Metal it returns nothing useful.
   * Flip this on the day PostFX gains a completed depth prepass, and the fade is
   * already wired end to end. Until then, particles are grounded against the terrain
   * heightfield in the vertex shader, which removes the artefact that matters most:
   * ground dust slicing through a hillside.
   */
  softParticles = false;

  // ---- Internals ----

  private ctx!: EngineContext;
  private battle?: BattleSystem;
  private terrain?: TerrainSystem;
  private sky?: SkySystem;
  private postfx?: PostFXSystem;

  /**
   * The particle engine. Public so any subsystem can emit its own effects without
   * this class growing a wrapper per effect: fill `particles.reset(layer, tile)` and
   * call `particles.push()`.
   */
  particles!: ParticleSystem;

  private damage!: GroundDamageLayer;
  private decals!: DecalPool;
  private dust = new DustEmitter();
  private combat = new CombatFX();
  private litter!: LitterField;
  private banners!: BannerSystem;
  private birds!: BirdFlock;
  private fires = new SmokeFire();
  private weather = new Weather();
  private height!: HeightTexture;

  private atlasTex?: THREE.Texture;
  private decalTex?: THREE.Texture;
  private noiseTex?: THREE.Texture;
  private bannerTex?: THREE.Texture;

  private sunView = new THREE.Vector3(0, 0, 1);
  private sunColour = new THREE.Color(1, 0.94, 0.82);
  private ambient = new THREE.Color(0.2, 0.25, 0.33);

  /** Per-unit contact bookkeeping, for deriving clashes the sim has not announced. */
  private prevEngaged = new Map<number, number>();
  private battleOver = false;
  /**
   * Ring of recent per-frame CPU costs. Reported as a median, not a mean: one long
   * frame — a shader compile, a GC pause, a harness clock jump — poisons a mean for
   * as long as it stays in the window, and a wrong number in a debug readout is worse
   * than no number at all.
   */
  private cpuRing = new Float32Array(31);
  private cpuRingHead = 0;
  private cpuSorted = new Float32Array(31);

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  init(ctx: EngineContext): void {
    this.ctx = ctx;
    this.battle = ctx.tryGet<BattleSystem>('battle');
    this.terrain = ctx.tryGet<TerrainSystem>('terrain');
    this.sky = ctx.tryGet<SkySystem>('sky');
    this.postfx = ctx.tryGet<PostFXSystem>('postfx');

    const q = QUALITY_SCALE[ctx.quality.tier] ?? QUALITY_SCALE.high;

    this.atlasTex = makeParticleAtlas();
    this.decalTex = makeDecalAtlas();
    this.noiseTex = makeNoiseTexture();
    this.bannerTex = makeBannerTexture();
    this.height = buildHeightTexture(this.terrain);

    this.particles = new ParticleSystem(this.atlasTex, this.height, {
      softCapacity: q.soft,
      additiveCapacity: q.add,
    });
    ctx.scene.add(this.particles.group);

    // The buffer covers the ground both armies can reach. Routed units run off the
    // edge of it, but nothing that happens out there is worth 4 MB of texture.
    this.damage = new GroundDamageLayer(this.decalTex, this.noiseTex, this.terrain, {
      extent: 1100,
      centreX: 0,
      centreZ: 0,
      resolution: 1024,
      segments: 168,
    });
    ctx.scene.add(this.damage.mesh);

    this.decals = new DecalPool(this.decalTex, this.height, q.decals);
    ctx.scene.add(this.decals.mesh);

    this.litter = new LitterField(q.litter, this.terrain);
    ctx.scene.add(this.litter.mesh);

    this.banners = new BannerSystem(this.bannerTex, 40);
    ctx.scene.add(this.banners.clothMesh);
    ctx.scene.add(this.banners.poleMesh);

    this.birds = new BirdFlock(q.birds);
    ctx.scene.add(this.birds.mesh);

    this.dust.budget.density = q.density;
    this.dust.budget.maxSpawnsPerFrame = q.spawns;

    if (this.battle) {
      this.combat.init(ctx, this.battle, this.particles, this.damage, this.decals, this.litter);
    }

    this.fires.seedScenario((x, z) => this.groundAt(x, z));
    this.weather.set('clear');

    ctx.events.on('battleEnded', () => {
      this.battleOver = true;
    });
    ctx.events.on('unitRouted', (e) => {
      if (!e || !this.battle) return;
      const u = this.battle.unitById(e.unitId);
      if (!u) return;
      // A unit breaking scuffs the ground badly as it turns and runs.
      for (let i = 0; i < 4; i++) {
        const h1 = hash01(e.unitId * 8 + i, 811);
        const h2 = hash01(e.unitId * 8 + i, 823);
        this.damage.splat(
          u.x + (h1 - 0.5) * 12,
          u.z + (h2 - 0.5) * 12,
          3 + h1 * 3,
          DT.dirtScuff,
          h2 * 6.283,
          0, 0.10, 0
        );
      }
    });
  }

  private groundAt(x: number, z: number): number {
    return this.terrain?.heightAt(x, z) ?? this.battle?.groundAt(x, z) ?? 0;
  }

  // -------------------------------------------------------------------------
  // Public API for other systems
  // -------------------------------------------------------------------------

  setWeather(kind: WeatherKind): void {
    this.weather.set(kind);
    this.dust.wetness = this.weather.preset.dustFactor;
  }

  get weatherKind(): WeatherKind {
    return this.weather.kind;
  }

  /** A burst of dust at a point — for anything that lands, falls or collapses. */
  burstDust(x: number, y: number, z: number, strength: number, radius: number): void {
    const ps = this.particles;
    const n = Math.min(40, Math.round(8 + strength * 18));
    const salt = (this.particles.clock * 1301) | 0;
    for (let i = 0; i < n; i++) {
      const h1 = hash01(i, salt);
      const h2 = hash01(i, salt + 1);
      const a = (i / n) * Math.PI * 2 + h1 * 0.6;
      const rec = ps.reset(PLayer.Soft, i % 3 === 0 ? PT.dustBillow : PT.smokeSoft);
      rec.x = x + Math.cos(a) * radius * 0.4;
      rec.y = y + 0.2;
      rec.z = z + Math.sin(a) * radius * 0.4;
      rec.vx = Math.cos(a) * (1.5 + strength * 2.5);
      rec.vz = Math.sin(a) * (1.5 + strength * 2.5);
      rec.vy = 0.8 + h2 * 1.6 * strength;
      rec.life = 2 + h1 * 2.5;
      rec.size0 = radius * 0.35 * (0.6 + h2 * 0.8);
      rec.size1 = rec.size0 * 3.2;
      rec.r = 0.70; rec.g = 0.62; rec.b = 0.48;
      rec.a = 0.08 + 0.06 * clamp01(strength);
      rec.gravity = 0.4;
      rec.drag = 1;
      rec.turb = 0.9;
      ps.push();
    }
  }

  /** Blood along a blow direction. Exposed so combat can be explicit when it wants. */
  bloodSpray(x: number, y: number, z: number, dirX: number, dirZ: number, amount: number, arterial: boolean): void {
    this.combat.bloodSpray(x, y, z, dirX, dirZ, amount, arterial);
  }

  /** Stamp persistent ground damage. `kind` selects the brush. */
  groundSplat(
    kind: 'blood' | 'trample' | 'scorch',
    x: number,
    z: number,
    radius: number,
    strength: number
  ): void {
    const tile = kind === 'blood' ? DT.bloodPool : kind === 'scorch' ? DT.scorch : DT.trampleSoft;
    this.damage.splat(
      x, z, radius, tile, hash01((x * 31 + z * 17) | 0, 907) * 6.283,
      kind === 'blood' ? strength : 0,
      kind === 'trample' ? strength : 0,
      kind === 'scorch' ? strength : 0
    );
  }

  /**
   * Add a fire at runtime — a burning siege tower, a torched building, a rooftop
   * hearth. `y` is absolute if given, otherwise the fire sits on the ground.
   */
  addFire(
    x: number,
    z: number,
    scale: number,
    kind: EmitterKind = EmitterKind.Pyre,
    y?: number
  ): number {
    return this.fires.add(kind, x, y ?? this.groundAt(x, z), z, scale, 1);
  }

  setFireIntensity(handle: number, v: number): void {
    this.fires.setIntensity(handle, v);
  }

  /**
   * Discard the scenario's guessed hearth and brazier placements. The city system
   * should call this and then `addFire` at its real chimneys and brazier stands; until
   * it does, smoke columns are scattered over the city quarter at plausible roof
   * height, which reads correctly from any distance a battle is watched from.
   */
  clearFires(): void {
    this.fires.clear();
  }

  shake(amplitude: number, decay = 3.2): void {
    this.ctx.events.emit('cameraShake', { amplitude, decay });
  }

  /** Top of a unit's standard, for HUD markers and camera framing. */
  standardOf(unitId: number, out: THREE.Vector3): boolean {
    return this.banners.anchorOf(unitId, out);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  update(dt: number, ctx: EngineContext): void {
    if (!this.enabled) return;
    const t0 = performance.now();

    // Scaled time: particles freeze on pause and run fast at 4x, like the sim.
    const sdt = Math.min(dt, 0.1);
    this.particles.advance(sdt);
    this.decals.advance(sdt);

    this.weather.update(sdt);
    this.wind.copy(this.weather.wind);
    this.gust = this.weather.gust;

    const cam = ctx.camera.position;

    if (this.battle) {
      this.dust.update(sdt, this.battle, this.terrain, this.particles, this.damage, cam.x, cam.z);
      this.combat.update(sdt);
      this.deriveContacts(sdt);
      this.banners.update(sdt, this.battle, this.wind);
      this.birds.update(sdt, this.battle, cam.x, cam.z, (x, z) => this.groundAt(x, z));
    }

    this.fires.update(sdt, this.particles, this.damage, cam.x, cam.z);
    this.weather.emit(this.particles, sdt, cam.x, cam.y, cam.z, (x, z) => this.groundAt(x, z));

    this.cpuRing[this.cpuRingHead] = performance.now() - t0;
    this.cpuRingHead = (this.cpuRingHead + 1) % this.cpuRing.length;
  }

  /** Median of the CPU-cost ring. Insertion sort: 31 entries, called only for stats. */
  private cpuMedian(): number {
    const n = this.cpuRing.length;
    this.cpuSorted.set(this.cpuRing);
    const s = this.cpuSorted;
    for (let i = 1; i < n; i++) {
      const v = s[i];
      let j = i - 1;
      while (j >= 0 && s[j] > v) {
        s[j + 1] = s[j];
        j--;
      }
      s[j + 1] = v;
    }
    return s[n >> 1];
  }

  /**
   * Derive clash and charge shockwaves from unit state, so contact reads even before
   * the combat subsystem is emitting `linesClashed` / `cavalryCharge`. Suppressed
   * automatically once real events start arriving.
   */
  private deriveContacts(dt: number): void {
    const b = this.battle;
    if (!b) return;
    void dt;
    for (const u of b.units) {
      if (u.destroyed) continue;
      const prev = this.prevEngaged.get(u.id) ?? 0;
      // Count men in contact rather than trusting the flag, so a partial contact along
      // one flank does not trigger a full-frontage shockwave.
      let fighting = 0;
      for (const i of u.members) {
        if (b.pool.state[i] === SoldierState.Fighting) fighting++;
      }
      this.prevEngaged.set(u.id, fighting);
      const gained = fighting - prev;
      // A dozen men entering contact inside one frame is a line meeting, not attrition.
      if (gained >= 10) {
        const def = b.typeOf(u);
        const horse = isCavalry(def);
        const intensity = clamp01(gained / 26) * (horse ? 1.5 : 1);
        this.combat.deriveClash(u.x, u.z, intensity, horse);
      }
    }
  }

  preRender(ctx: EngineContext): void {
    if (!this.enabled) return;

    // ---- Lighting, pulled from the sky each frame so effects track time of day ----
    const sunDir = this.sky?.sunDirection ?? DEFAULT_SUN;
    if (this.sky) {
      // Match the scene's directional light: three's physical lights divide diffuse by
      // pi, so the same 3.1-intensity sun lands at ~0.99 on a lambert surface.
      this.sunColour.copy(this.sky.sunColour).multiplyScalar(0.99);
      // Enough sky fill that the shadowed side of a dust cloud takes a cool blue-grey
      // instead of going black — the warm/cool split inside the dust is what makes it
      // read as a volume rather than a tinted sprite. Still well under the sun term so
      // ochre dust never turns to grey steam.
      this.ambient.copy(this.sky.ambientColour).multiplyScalar(0.55);
    }
    // Sun direction in view space; the particle shader lights billboards with it.
    this.sunView.copy(sunDir).transformDirection(ctx.camera.matrixWorldInverse);

    this.damage.setLighting(sunDir, this.sunColour, this.ambient);
    this.decals.flush(sunDir, this.sunColour, this.ambient);
    this.banners.setLighting(sunDir, this.sunColour, this.ambient);
    this.birds.setLighting(this.sunColour, this.ambient);

    const depth = this.softParticles ? (this.postfx?.depthTexture ?? null) : null;
    this.particles.flush(
      this.wind,
      this.sunView,
      this.sunColour,
      this.ambient,
      depth,
      ctx.viewW,
      ctx.viewH,
      ctx.camera.near,
      ctx.camera.far
    );

    // Offscreen accumulation. Runs here, before the engine resets its draw counters,
    // so the splat pass is not charged against the visible draw budget.
    this.damage.commit(ctx.renderer);

    // After the battle the field settles: no more dust, and the crows come down.
    if (this.battleOver) {
      this.dust.budget.density = 0.15;
    }
  }

  resize(_w: number, _h: number, _ctx: EngineContext): void {}

  // -------------------------------------------------------------------------
  // Debug / reporting
  // -------------------------------------------------------------------------

  stats(): {
    particles: number;
    particleCapacity: number;
    spawnedTotal: number;
    dustPerFrame: number;
    decals: number;
    splats: number;
    litter: number;
    banners: number;
    perchedCrows: number;
    /** Median per-frame CPU cost over the last 31 frames, in milliseconds. */
    cpuMs: number;
    /** Worst frame in the same window — the number that matters for a hitch. */
    cpuPeakMs: number;
  } {
    return {
      particles: this.particles.liveCount(),
      particleCapacity: this.particles.capacity,
      spawnedTotal: this.particles.totalSpawned(),
      dustPerFrame: this.dust.spawnsLastFrame,
      decals: this.decals.liveCount(),
      splats: this.damage.splatCount,
      litter: this.litter.count,
      banners: this.banners.count,
      perchedCrows: this.birds.perched,
      cpuMs: this.cpuMedian(),
      cpuPeakMs: Math.max(...this.cpuRing),
    };
  }

  dispose(): void {
    this.particles.dispose();
    this.damage.dispose();
    this.decals.dispose();
    this.litter.dispose();
    this.banners.dispose();
    this.birds.dispose();
    this.atlasTex?.dispose();
    this.decalTex?.dispose();
    this.noiseTex?.dispose();
    this.bannerTex?.dispose();
    this.height.texture.dispose();
  }
}

/** Fallback if no sky system is registered: a mid-morning south-easterly sun. */
const DEFAULT_SUN = new THREE.Vector3(0.42, 0.62, -0.66).normalize();
