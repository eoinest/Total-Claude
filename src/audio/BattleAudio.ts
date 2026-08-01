/**
 * Turning simulation state into a battle you can hear.
 *
 * Two jobs, and the first is the important one:
 *
 * 1. **Clustering.** At the height of a fight the combat system reports hundreds of blows
 *    a second. Playing them is both impossible (voice budget) and wrong (a real melee is
 *    not a sequence of audible individual blows, it is a dense texture with a few nearby
 *    events standing out of it). So every discrete event is binned into a 15 m spatial
 *    grid, the handful of nearest and busiest cells get one representative one-shot each,
 *    and *all* of the events — including the ones that got no voice — feed the level of a
 *    continuous melee bed. Two hundred hits become five voices and a louder roar.
 *
 * 2. **Derivation.** Marching, hooves and the roar of contact are continuous, and events
 *    are discrete, so those are read straight off `battle.units` each frame: a cohort's
 *    real speed sets its step cadence, its man-count sets the density, and units in
 *    contact (either flagged `engaged` or simply within reach of an enemy anchor, so this
 *    still works before the combat system lands) set the melee level.
 */

import { clamp, clamp01, damp, lerp } from '../util/math';
import { hash01 } from '../util/rand';
import { FACTIONS, Faction, UnitOrder, type UnitGroupState } from '../sim/types';
import { isCavalry, unitType } from '../units/roster';
import type { BusName, Mixer } from './Mixer';
import { Bed } from './Mixer';
import { variantId } from './Synth';

/** The parts of `BattleSystem` this module reads. Duck-typed so a stub can drive tests. */
export interface BattleView {
  units: readonly UnitGroupState[];
  pool: {
    count: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    state: Uint8Array;
  };
  groundAt?(x: number, z: number): number;
}

/** Optional feed from a projectile system, if one is registered. */
export interface ProjectileView {
  activeCount: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
}

/** Grid cell size for clustering, metres. Roughly a platoon frontage. */
const CELL = 15;
/** Cluster flush cadence. Faster than this and the grid never accumulates anything. */
const FLUSH_DT = 1 / 16;
/** Per-flush ceiling on discrete melee voices. */
const MAX_DISCRETE_MELEE = 5;
/** Per-flush ceiling on discrete projectile-impact voices. */
const MAX_DISCRETE_IMPACT = 4;
/** Continuous-derivation cadence. */
const DERIVE_DT = 1 / 12;
/** A discrete melee hit beyond this is never worth its own voice. */
const MELEE_DETAIL_RANGE = 130;
/** Blows per second at which the melee layers are at full level. */
const HITS_FULL = 180;

const MELEE_SOUND: Record<string, string> = {
  flesh: 'hit_flesh',
  shield: 'hit_shield',
  armour: 'hit_armour',
  parry: 'parry',
  miss: 'swing_miss',
};
const MELEE_KIND_ORDER = ['flesh', 'shield', 'armour', 'parry', 'miss'];

const IMPACT_SOUND: Record<string, string> = {
  ground: 'impact_ground',
  shield: 'impact_shield',
  flesh: 'impact_flesh',
  armour: 'impact_armour',
  stone: 'impact_stone',
  wood: 'impact_wood',
};
const IMPACT_KIND_ORDER = ['ground', 'shield', 'flesh', 'armour', 'stone', 'wood'];

interface Cell {
  key: number;
  n: number;
  sx: number;
  sy: number;
  sz: number;
  kinds: Float32Array;
  weight: number;
}

/**
 * Spatial accumulator. Pools its cells so a heavy tick allocates nothing.
 */
class ClusterGrid {
  private cells: Cell[] = [];
  private used = 0;
  private index = new Map<number, number>();
  total = 0;
  weight = 0;

  constructor(private readonly kindCount: number) {}

  add(x: number, y: number, z: number, kind: number, weight = 1): void {
    // Offset keeps the key positive across the ±1400 m battlefield.
    const cx = Math.floor((x + 2048) / CELL);
    const cz = Math.floor((z + 2048) / CELL);
    const key = cx * 4096 + cz;
    let ci = this.index.get(key);
    if (ci === undefined) {
      if (this.used < this.cells.length) {
        ci = this.used++;
        const c = this.cells[ci];
        c.key = key;
        c.n = 0;
        c.sx = 0;
        c.sy = 0;
        c.sz = 0;
        c.weight = 0;
        c.kinds.fill(0);
      } else {
        ci = this.used++;
        this.cells.push({
          key, n: 0, sx: 0, sy: 0, sz: 0, weight: 0,
          kinds: new Float32Array(this.kindCount),
        });
      }
      this.index.set(key, ci);
    }
    const c = this.cells[ci];
    c.n++;
    c.sx += x;
    c.sy += y;
    c.sz += z;
    c.weight += weight;
    if (kind >= 0 && kind < this.kindCount) c.kinds[kind] += weight;
    this.total++;
    this.weight += weight;
  }

  get count(): number {
    return this.used;
  }

  cellAt(i: number): Cell {
    return this.cells[i];
  }

  reset(): void {
    this.used = 0;
    this.total = 0;
    this.weight = 0;
    this.index.clear();
  }
}

/** Per-unit continuous emitter state: cadence phase, smoothed speed, distant bed. */
interface UnitEmitter {
  unitId: number;
  lastX: number;
  lastZ: number;
  speed: number;
  phase: number;
  bed: Bed | null;
  variant: number;
  cavalry: boolean;
}

export interface BattleAudioStats {
  meleeIntensity: number;
  engagedMen: number;
  routingMen: number;
  hitsPerSecond: number;
  deathsPerSecond: number;
  discreteThisFlush: number;
  emitters: number;
  beds: number;
}

export class BattleAudio {
  private melee = new ClusterGrid(MELEE_KIND_ORDER.length);
  private impacts = new ClusterGrid(IMPACT_KIND_ORDER.length);
  private deaths = new ClusterGrid(1);

  private flushTimer = 0;
  private deriveTimer = 0;

  /** Smoothed event rates, per second. */
  private hitRate = 0;
  private deathRate = 0;
  private hitAccum = 0;
  private deathAccum = 0;
  private rateWindow = 0;

  /** 0..1 combat intensity, exported for the score. */
  meleeIntensity = 0;
  engagedMen = 0;
  routingMen = 0;
  /** Fraction of all living men currently in contact. */
  engagedFraction = 0;

  private fightX = 0;
  private fightY = 0;
  private fightZ = 0;
  private haveFightCentre = false;

  private clatter: Bed;
  private roarLow: Bed;
  private roarHigh: Bed;
  private panic: Bed;
  private cheer: Bed;

  private emitters = new Map<number, UnitEmitter>();
  private defCache = new Map<string, { cavalry: boolean; walk: number; run: number; men: number }>();

  private cryCooldown = 0;
  private screamBudget = 0;
  private discreteThisFlush = 0;
  private cheering = 0;

  private battle: BattleView | null = null;
  private projectiles: ProjectileView | null = null;
  private flybys: Array<{ handle: ReturnType<Mixer['startLoop']>; idx: number }> = [];

  constructor(
    private readonly mixer: Mixer,
    private readonly opts: { detail?: number } = {}
  ) {
    this.clatter = new Bed(mixer, 'melee_clatter', { bus: 'combat', aggregate: true, tau: 0.5 });
    this.roarLow = new Bed(mixer, 'crowd_roar_low', { bus: 'voice', aggregate: true, tau: 0.7 });
    this.roarHigh = new Bed(mixer, 'crowd_roar_high', { bus: 'voice', aggregate: true, tau: 0.55 });
    this.panic = new Bed(mixer, 'crowd_panic', { bus: 'voice', aggregate: true, tau: 0.6 });
    this.cheer = new Bed(mixer, 'crowd_cheer', { bus: 'voice', aggregate: true, tau: 0.9 });
  }

  attach(battle: BattleView | null, projectiles: ProjectileView | null): void {
    this.battle = battle;
    this.projectiles = projectiles;
  }

  // -------------------------------------------------------------------------
  // Discrete events — accumulated, never played directly
  // -------------------------------------------------------------------------

  meleeHit(x: number, y: number, z: number, kind: string, lethal: boolean): void {
    const k = MELEE_KIND_ORDER.indexOf(kind);
    // A killing blow is worth more of the cluster's attention than a parry.
    this.melee.add(x, y, z, k < 0 ? 1 : k, lethal ? 2.2 : kind === 'miss' ? 0.35 : 1);
    this.hitAccum++;
  }

  projectileImpact(x: number, y: number, z: number, material: string, hitTarget: boolean): void {
    const k = IMPACT_KIND_ORDER.indexOf(material);
    this.impacts.add(x, y, z, k < 0 ? 0 : k, hitTarget ? 1.4 : 1);
  }

  soldierDied(x: number, y: number, z: number, index: number): void {
    this.deaths.add(x, y, z, 0, 1);
    this.deathAccum++;
    // Most deaths make no distinct sound at all — the crowd covers them. The ones that do
    // are chosen by a stable hash of the man's index so a replay screams in the same place.
    if (this.screamBudget > 0 && hash01(index, 7717) < 0.18) {
      const t = hash01(index, 991);
      const near = this.mixer.distanceTo(x, y, z) < 55;
      const id = near && t < 0.55 ? variantId('scream', t / 0.55) : variantId('death_grunt', t);
      if (this.mixer.play(id, {
        x, y: y + 1.2, z,
        gain: near ? 0.9 : 0.7,
        rate: 0.92 + t * 0.2,
        bus: 'voice',
        priority: 0.4,
      }, 0.05)) {
        this.screamBudget--;
      }
    }
  }

  volleyFired(x: number, y: number, z: number, kind: string, count: number): void {
    // An unrecognised missile kind still gets a volley rather than silence.
    const id = `volley_${kind}`;
    const use = this.mixer.bank.has(id) ? id : 'volley_arrow';
    // One voice for the whole volley, level from the number of men releasing.
    const gain = clamp(0.45 + 0.5 * Math.sqrt(Math.max(1, count) / 60), 0.3, 1.1);
    this.mixer.play(use, {
      x, y: y + 1.5, z,
      gain,
      rate: 0.96 + hash01(Math.round(x + z), 31) * 0.08,
      bus: 'combat',
      aggregate: true,
      priority: 1.4,
    }, 0.06);
  }

  linesClashed(x: number, z: number, intensity: number, faction: number): void {
    const y = this.groundAt(x, z);
    this.mixer.play('clash_shieldwall', {
      x, y: y + 1.4, z,
      gain: clamp(0.6 + intensity * 0.5, 0.5, 1.2),
      rate: lerp(1.06, 0.9, clamp01(intensity)),
      bus: 'combat',
      aggregate: true,
      priority: 3,
    }, 0.35);
    // The shout that goes with the crash, not a separate cue.
    this.warCry(faction, x, z, 0.12);
    this.meleeIntensity = Math.max(this.meleeIntensity, 0.55);
  }

  cavalryCharge(x: number, z: number, intensity: number, faction: number): void {
    const y = this.groundAt(x, z);
    this.mixer.play('cavalry_impact', {
      x, y: y + 1.6, z,
      gain: clamp(0.55 + intensity * 0.5, 0.45, 1.15),
      rate: lerp(1.04, 0.94, clamp01(intensity)),
      bus: 'combat',
      aggregate: true,
      priority: 3,
    }, 0.5);
    this.warCry(faction, x, z, 0.4);
  }

  unitRouted(unitId: number): void {
    const u = this.battle?.units.find((v) => v.id === unitId);
    if (!u) return;
    const y = this.groundAt(u.x, u.z);
    this.mixer.play('crowd_panic', {
      x: u.x, y: y + 1.5, z: u.z,
      gain: 0.75,
      rate: 1.0,
      bus: 'voice',
      aggregate: true,
      priority: 1.2,
    }, 0.8);
  }

  /** A faction war cry, rate-limited hard — the barritus is not a sound effect. */
  warCry(faction: number, x: number, z: number, delay = 0): void {
    if (this.cryCooldown > 0) return;
    // `FactionDef.warCrySound` is the declared home for this and every other caller already
    // uses it — `Abilities.ts` does. This was the one place that re-derived it from a
    // two-faction ternary, so a third faction would have shouted the barritus.
    const id = FACTIONS[faction as Faction]?.warCrySound ?? 'cry_germanic';
    const y = this.groundAt(x, z);
    if (this.mixer.play(id, {
      x, y: y + 1.6, z,
      gain: 0.95,
      bus: 'voice',
      aggregate: true,
      priority: 2.5,
      when: this.mixer.time + delay,
    })) {
      // Rome shouts on command and rarely; a barbarian host works itself up and repeats.
      // Carthage sits between the two, and its cue is the longest of the three.
      this.cryCooldown = faction === Faction.Rome ? 7 : faction === Faction.Carthage ? 11 : 9;
    }
  }

  /** Signal horn — battle start, and the victory/defeat stinger. */
  cornu(x: number, z: number, low = false, delay = 0): void {
    const y = this.groundAt(x, z);
    this.mixer.play(low ? 'cornu_low' : 'cornu_call', {
      x, y: y + 2, z,
      gain: 0.9,
      bus: 'voice',
      aggregate: true,
      priority: 3,
      when: this.mixer.time + delay,
    });
  }

  battleEnded(): void {
    this.cheering = 14;
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (dt > 0) {
      this.cryCooldown = Math.max(0, this.cryCooldown - dt);
      this.cheering = Math.max(0, this.cheering - dt);
      // Two screams a second, tops. Beyond that it stops sounding like men dying and
      // starts sounding like a sound effect looping.
      this.screamBudget = Math.min(2, this.screamBudget + dt * 2);
      this.rateWindow += dt;
    }

    this.flushTimer += dt;
    if (this.flushTimer >= FLUSH_DT) {
      this.flushClusters(this.flushTimer);
      this.flushTimer = 0;
    }

    if (this.rateWindow >= 0.25) {
      const inv = 1 / this.rateWindow;
      // Rise fast, fall slow: the roar should swell instantly on contact and ebb away.
      const hits = this.hitAccum * inv;
      const deaths = this.deathAccum * inv;
      this.hitRate = damp(this.hitRate, hits, hits > this.hitRate ? 9 : 1.6, this.rateWindow);
      this.deathRate = damp(this.deathRate, deaths, deaths > this.deathRate ? 6 : 1.1, this.rateWindow);
      this.hitAccum = 0;
      this.deathAccum = 0;
      this.rateWindow = 0;
    }

    this.deriveTimer += dt;
    if (this.deriveTimer >= DERIVE_DT) {
      this.derive(this.deriveTimer);
      this.deriveTimer = 0;
    }

    this.stepEmitters(dt);
    this.updateBeds(dt);
    this.updateFlybys();
  }

  // -------------------------------------------------------------------------
  // Clustering
  // -------------------------------------------------------------------------

  private flushClusters(dt: number): void {
    this.discreteThisFlush = 0;
    this.emitCluster(this.melee, MELEE_KIND_ORDER, MELEE_SOUND, {
      max: MAX_DISCRETE_MELEE,
      range: MELEE_DETAIL_RANGE,
      bus: 'combat',
      minInterval: 0.012,
      baseGain: 0.8,
      doubleTap: true,
    });
    this.emitCluster(this.impacts, IMPACT_KIND_ORDER, IMPACT_SOUND, {
      max: MAX_DISCRETE_IMPACT,
      range: 170,
      bus: 'combat',
      minInterval: 0.02,
      baseGain: 0.85,
      doubleTap: false,
    });

    // Fold the fighting's centre of mass toward the busiest cluster so the roar tracks
    // where the fight actually is rather than the midpoint of the whole field.
    if (this.melee.weight > 0) {
      let bx = 0, by = 0, bz = 0, bw = 0;
      for (let i = 0; i < this.melee.count; i++) {
        const c = this.melee.cellAt(i);
        bx += c.sx;
        by += c.sy;
        bz += c.sz;
        bw += c.n;
      }
      if (bw > 0) this.setFightCentre(bx / bw, by / bw, bz / bw, dt, 3.5);
    }

    this.melee.reset();
    this.impacts.reset();
    this.deaths.reset();
  }

  private emitCluster(
    grid: ClusterGrid,
    kindOrder: readonly string[],
    sounds: Record<string, string>,
    o: { max: number; range: number; bus: BusName; minInterval: number; baseGain: number; doubleTap: boolean }
  ): void {
    const n = grid.count;
    if (n === 0) return;
    const detail = this.opts.detail ?? 1;
    const budget = Math.max(1, Math.round(o.max * detail));

    // Rank cells by how much they deserve a voice: busy and close beats quiet and far.
    // Small arrays (a big melee fills maybe 30 cells), so an insertion pass is fine.
    let order: number[] | null = null;
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = grid.cellAt(i);
      const cx = c.sx / c.n;
      const cy = c.sy / c.n;
      const cz = c.sz / c.n;
      const d = this.mixer.distanceTo(cx, cy, cz);
      scores[i] = d > o.range ? -1 : (Math.sqrt(c.weight) * 40) / (40 + d);
    }
    order = [];
    for (let i = 0; i < n; i++) if (scores[i] > 0) order.push(i);
    order.sort((a, b) => scores[b] - scores[a]);

    for (let k = 0; k < order.length && this.discreteThisFlush < budget; k++) {
      const c = grid.cellAt(order[k]);
      const cx = c.sx / c.n;
      const cy = c.sy / c.n;
      const cz = c.sz / c.n;
      // Dominant kind in this cell.
      let best = 0;
      for (let j = 1; j < c.kinds.length; j++) if (c.kinds[j] > c.kinds[best]) best = j;
      const base = sounds[kindOrder[best]];
      if (!base) continue;
      const sel = hash01(c.key, 13);
      const id = variantId(base, sel);
      // sqrt on count: ten men fighting in one cell is louder than one, not ten times.
      const gain = clamp(o.baseGain * (0.62 + 0.2 * Math.sqrt(c.n)), 0.2, 1.25);
      const rate = 0.9 + hash01(c.key, 29) * 0.24;
      if (this.mixer.play(id, {
        x: cx, y: cy, z: cz,
        gain, rate,
        bus: o.bus,
        priority: 0.6 + Math.min(1, c.n * 0.08),
      }, o.minInterval)) {
        this.discreteThisFlush++;
        // A close, busy cell gets a second offset blow so it reads as several men, not one.
        if (o.doubleTap && c.n >= 3 && this.discreteThisFlush < budget &&
            this.mixer.distanceTo(cx, cy, cz) < 46) {
          const t2 = this.mixer.time + 0.035 + hash01(c.key, 71) * 0.05;
          if (this.mixer.play(variantId(base, hash01(c.key, 101)), {
            x: cx + 1.4, y: cy, z: cz - 1.1,
            gain: gain * 0.75,
            rate: rate * 1.07,
            bus: o.bus,
            when: t2,
            priority: 0.5,
          })) this.discreteThisFlush++;
        }
      }
    }
  }

  private setFightCentre(x: number, y: number, z: number, dt: number, rate: number): void {
    if (!this.haveFightCentre) {
      this.fightX = x;
      this.fightY = y;
      this.fightZ = z;
      this.haveFightCentre = true;
      return;
    }
    this.fightX = damp(this.fightX, x, rate, dt);
    this.fightY = damp(this.fightY, y, rate, dt);
    this.fightZ = damp(this.fightZ, z, rate, dt);
  }

  // -------------------------------------------------------------------------
  // Continuous derivation from unit state
  // -------------------------------------------------------------------------

  private defOf(typeId: string): { cavalry: boolean; walk: number; run: number; men: number } {
    let d = this.defCache.get(typeId);
    if (!d) {
      try {
        const t = unitType(typeId);
        d = { cavalry: isCavalry(t), walk: t.walkSpeed, run: t.runSpeed, men: t.strength };
      } catch {
        // An unknown type id must not stop the audio; assume infantry.
        d = { cavalry: false, walk: 1.55, run: 3.5, men: 120 };
      }
      this.defCache.set(typeId, d);
    }
    return d;
  }

  private groundAt(x: number, z: number): number {
    return this.battle?.groundAt?.(x, z) ?? 0;
  }

  private derive(dt: number): void {
    const b = this.battle;
    this.engagedMen = 0;
    this.routingMen = 0;
    let livingMen = 0;
    if (!b) {
      this.engagedFraction = 0;
      return;
    }

    const units = b.units;
    // Contact test without the combat system: an enemy anchor inside a generous radius.
    // Crude, but it means marching, roaring and music intensity all work on day one.
    let cx = 0, cy = 0, cz = 0, cw = 0;

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.destroyed || u.alive <= 0) continue;
      livingMen += u.alive;
      const routing = u.order === UnitOrder.Rout;
      if (routing) this.routingMen += u.alive;

      let engaged = u.engaged;
      if (!engaged) {
        for (let j = 0; j < units.length; j++) {
          const o = units[j];
          if (o.destroyed || o.alive <= 0 || o.faction === u.faction) continue;
          const dx = o.x - u.x;
          const dz = o.z - u.z;
          if (dx * dx + dz * dz < 26 * 26) {
            engaged = true;
            break;
          }
        }
      }
      if (engaged && !routing) {
        this.engagedMen += u.alive;
        const w = u.alive;
        cx += u.x * w;
        cz += u.z * w;
        cy += this.groundAt(u.x, u.z) * w;
        cw += w;
      }

      this.ensureEmitter(u, dt);
    }

    // Retire emitters for units that are gone.
    for (const [id, e] of this.emitters) {
      if (!units.some((u) => u.id === id && !u.destroyed && u.alive > 0)) {
        e.bed?.stop(0.5);
        this.emitters.delete(id);
      }
    }

    this.engagedFraction = livingMen > 0 ? clamp01(this.engagedMen / livingMen) : 0;
    if (cw > 0) this.setFightCentre(cx / cw, cy / cw + 1.4, cz / cw, dt, 1.6);
  }

  private ensureEmitter(u: UnitGroupState, dt: number): void {
    let e = this.emitters.get(u.id);
    const def = this.defOf(u.typeId);
    if (!e) {
      e = {
        unitId: u.id,
        lastX: u.x,
        lastZ: u.z,
        speed: 0,
        // Gait phase offset per unit, so two cohorts never step in unison.
        phase: hash01(u.id, 5),
        bed: null,
        variant: hash01(u.id, 17),
        cavalry: def.cavalry,
      };
      this.emitters.set(u.id, e);
      return;
    }
    if (dt > 1e-4) {
      const inst = Math.hypot(u.x - e.lastX, u.z - e.lastZ) / dt;
      e.speed = damp(e.speed, Math.min(inst, def.run * 1.6), 6, dt);
    }
    e.lastX = u.x;
    e.lastZ = u.z;
  }

  /**
   * Advance every emitter's gait phase and fire footfalls. Called every frame so cadence
   * is smooth, but the work is a dozen units of arithmetic — no allocation, no lookups
   * beyond a cached unit-type record.
   */
  private stepEmitters(dt: number): void {
    const b = this.battle;
    if (!b || dt <= 0) return;
    for (const u of b.units) {
      if (u.destroyed || u.alive <= 0) continue;
      const e = this.emitters.get(u.id);
      if (!e) continue;
      const def = this.defOf(u.typeId);
      const y = this.groundAt(u.x, u.z);
      const d = this.mixer.distanceTo(u.x, y + 1, u.z);

      if (e.speed < 0.22 || d > 420) {
        e.bed?.set(dt, 0, u.x, y, u.z);
        continue;
      }

      const massFrac = clamp01(u.alive / Math.max(20, def.men));

      if (e.cavalry) {
        // Gait from real speed. A walk is four separate beats, a trot two diagonal
        // pairs, a gallop a rolling four with a gap — and at any distance or squadron
        // size worth speaking of, all of that collapses into one bed.
        const gallop = e.speed > 6.2;
        const trot = !gallop && e.speed > 3.2;
        const useBed = d > 55 || u.alive > 10;
        if (useBed) {
          if (!e.bed) e.bed = new Bed(this.mixer, 'hooves_mass', { bus: 'combat', aggregate: true, tau: 0.4 });
          const rate = gallop ? 1.35 : trot ? 1.0 : 0.72;
          const gain = clamp(0.5 * massFrac * (gallop ? 1.25 : trot ? 1 : 0.7), 0, 1.1);
          e.bed.set(dt, gain, u.x, y + 1, u.z, rate);
          continue;
        }
        e.bed?.set(dt, 0, u.x, y, u.z);
        // Close, small group: discrete hooves.
        const beatsPerSec = gallop ? e.speed / 2.4 : trot ? e.speed / 1.7 : e.speed / 0.95;
        e.phase += beatsPerSec * dt;
        while (e.phase >= 1) {
          e.phase -= 1;
          const sel = hash01(Math.floor(e.phase * 977 + u.id * 31), 3);
          const beats = gallop ? [0, 0.11, 0.22, 0.4] : trot ? [0, 0.5] : [0, 0.26, 0.52, 0.78];
          for (let k = 0; k < beats.length; k++) {
            this.mixer.play(variantId('hoof', hash01(k + u.id, 61)), {
              x: u.x + (sel - 0.5) * 2.4,
              y: y + 0.2,
              z: u.z + (hash01(k, 7) - 0.5) * 2.4,
              gain: clamp(0.5 + massFrac * 0.4, 0.3, 0.95),
              rate: 0.94 + hash01(k * 7 + u.id, 23) * 0.16,
              bus: 'combat',
              priority: 0.35,
              when: this.mixer.time + beats[k] / Math.max(0.5, beatsPerSec),
            }, 0.008);
          }
        }
        continue;
      }

      // Infantry. Cadence from speed: a Roman military pace is about 114 steps a minute
      // at the 1.55 m/s march, and rises sub-linearly into a run.
      const stepHz = clamp(1.9 * Math.pow(e.speed / 1.55, 0.6), 0.8, 3.4);
      e.phase += stepHz * dt;
      let fired = 0;
      while (e.phase >= 1 && fired < 2) {
        e.phase -= 1;
        fired++;
        const v = Math.floor(this.rotate(e) * 3) % 3;
        const gain = clamp(0.32 + 0.55 * massFrac, 0.1, 0.95) * (u.order === UnitOrder.Rout ? 0.8 : 1);
        this.mixer.play(`march_mass_${v}`, {
          x: u.x, y: y + 0.15, z: u.z,
          gain,
          rate: 0.94 + e.variant * 0.14,
          bus: 'combat',
          aggregate: true,
          priority: 0.3 + massFrac * 0.3,
        }, 0.03);
        // Close enough to pick out kit: add a jingle on alternate steps.
        if (d < 34 && fired === 1 && (Math.floor(e.phase * 4) & 1) === 0) {
          this.mixer.play(variantId('kit_jingle', this.rotate(e)), {
            x: u.x + (e.variant - 0.5) * 3,
            y: y + 1.1,
            z: u.z + (e.variant - 0.5) * 2,
            gain: 0.4,
            rate: 0.9 + e.variant * 0.25,
            bus: 'combat',
            priority: 0.2,
          }, 0.09);
        }
      }
      if (e.phase > 1) e.phase = 0;
    }
  }

  /** A cheap advancing hash so successive steps pick different variants. */
  private rotate(e: UnitEmitter): number {
    e.variant = (e.variant * 1.618033988 + 0.31830988) % 1;
    return e.variant;
  }

  // -------------------------------------------------------------------------
  // Beds
  // -------------------------------------------------------------------------

  private updateBeds(dt: number): void {
    // Two independent readings of "how much fighting is happening": the event rate from
    // the combat system, and the mass of men in contact. Whichever is higher wins, so the
    // roar is right whether or not the combat system is emitting yet.
    //
    // 180 hits/second is "the whole line is engaged": roughly 250 men actually in contact
    // (front ranks only) at the ~0.8 blows/second of the roster's attack rates. 900 men
    // committed is the equivalent reading from mass. If the combat system's real blow rate
    // turns out to differ, HITS_FULL is the one number to retune.
    const fromEvents = clamp01(this.hitRate / HITS_FULL);
    const fromMass = clamp01(this.engagedMen / 900);
    const target = Math.max(fromEvents, fromMass * 0.92);
    this.meleeIntensity = damp(this.meleeIntensity, target, target > this.meleeIntensity ? 3.2 : 0.75, dt);

    const i = this.meleeIntensity;
    const x = this.haveFightCentre ? this.fightX : 0;
    const y = this.haveFightCentre ? this.fightY : 1.5;
    const z = this.haveFightCentre ? this.fightZ : 0;

    this.clatter.set(dt, Math.pow(i, 0.75) * 0.9, x, y, z, lerp(0.92, 1.06, i));
    this.roarLow.set(dt, Math.pow(i, 0.55) * 0.85, x, y, z, 1);
    this.roarHigh.set(dt, Math.pow(clamp01((i - 0.3) / 0.7), 0.8) * 0.7, x, y, z, 1);

    const routFrac = clamp01(this.routingMen / 420);
    this.panic.set(dt, routFrac * 0.7, x, y, z, 1);
    this.cheer.set(dt, this.cheering > 0 ? clamp01(this.cheering / 4) * 0.8 : 0, x, y, z, 1);
  }

  // -------------------------------------------------------------------------
  // Projectile fly-bys (only when a projectile system publishes positions)
  // -------------------------------------------------------------------------

  /**
   * True Doppler needs projectile positions every frame, which only exists if the combat
   * agent's projectile system is registered and exposes them. When it is, the three
   * closest shafts in flight get a pitch-shifted whistle; when it is not, nothing happens
   * and the volley buffer's massed whoosh carries the moment instead.
   */
  private updateFlybys(): void {
    const p = this.projectiles;
    if (!p || !Number.isFinite(p.activeCount)) {
      for (const f of this.flybys) f.handle?.stop(0.1);
      this.flybys.length = 0;
      return;
    }
    const n = Math.min(p.activeCount, p.x.length, p.vx.length);
    // Find the three nearest.
    const best: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < n; i++) {
      const d = this.mixer.distanceTo(p.x[i], p.y[i], p.z[i]);
      if (d > 45) continue;
      best.push({ i, d });
    }
    best.sort((a, b) => a.d - b.d);
    best.length = Math.min(best.length, 3);

    while (this.flybys.length > best.length) {
      this.flybys.pop()?.handle?.stop(0.12);
    }
    for (let k = 0; k < best.length; k++) {
      const { i, d } = best[k];
      let f = this.flybys[k];
      if (!f) {
        f = { handle: this.mixer.startLoop('arrow_flight', { bus: 'combat', priority: 0.8 }), idx: i };
        this.flybys[k] = f;
      }
      f.idx = i;
      if (!f.handle) continue;
      // Radial velocity → Doppler. 343 m/s at 20 °C.
      const speed = Math.hypot(p.vx[i], p.vy[i], p.vz[i]);
      const closing = speed > 0.01 ? 1 : 0;
      const shift = clamp(343 / (343 - closing * speed * 0.55), 0.7, 1.6);
      f.handle.setPosition(p.x[i], p.y[i], p.z[i], 0.01);
      f.handle.setGain(clamp01(1 - d / 45) * 0.55, 0.05);
      f.handle.setRate(shift);
    }
  }

  // -------------------------------------------------------------------------

  stats(): BattleAudioStats {
    let beds = 0;
    for (const bd of [this.clatter, this.roarLow, this.roarHigh, this.panic, this.cheer]) if (bd.live) beds++;
    for (const e of this.emitters.values()) if (e.bed?.live) beds++;
    return {
      meleeIntensity: this.meleeIntensity,
      engagedMen: this.engagedMen,
      routingMen: this.routingMen,
      hitsPerSecond: this.hitRate,
      deathsPerSecond: this.deathRate,
      discreteThisFlush: this.discreteThisFlush,
      emitters: this.emitters.size,
      beds,
    };
  }

  dispose(): void {
    for (const bd of [this.clatter, this.roarLow, this.roarHigh, this.panic, this.cheer]) bd.stop(0.05);
    for (const e of this.emitters.values()) e.bed?.stop(0.05);
    this.emitters.clear();
    for (const f of this.flybys) f.handle?.stop(0.05);
    this.flybys.length = 0;
  }
}
