/**
 * The audio subsystem.
 *
 * Owns the `AudioContext`, the synthesised sound bank, the mixer, the battle-derived
 * layers, the ambience and the score. Registered at `order: 400`, and does its work in
 * `preRender` so the listener transform comes from the *final* camera rather than one a
 * frame stale.
 *
 * Two hard rules shape the whole file:
 *
 *  - **It must never throw.** The screenshot harness runs headless with no user gesture, so
 *    the context is created suspended and nothing is ever scheduled; every event handler is
 *    individually guarded because `EventBus` logs a `console.error` for a throwing handler
 *    and that alone would fail the build gate.
 *  - **Nothing is synthesised in the frame loop.** Every buffer is built once, either at
 *    `init` (if audio is already permitted) or on the first user gesture. The per-frame cost
 *    is a listener update, a cluster flush and a dozen units of arithmetic.
 */

import type { EngineContext, Subsystem } from '../core/Engine';
import { clamp, clamp01 } from '../util/math';
import { Faction } from '../sim/types';
import { Ambience, type WeatherView } from './Ambience';
import { BattleAudio, type BattleView } from './BattleAudio';
import type { ProjectileFeed } from '../sim/Projectiles';
import { MAX_MUSIC_VOICES, MAX_SPATIAL_VOICES, Mixer } from './Mixer';
import { Music, type MusicCue } from './Music';
import { SoundBank, buildSoundBank } from './Synth';

export interface AudioEngineOptions {
  /**
   * Supply the context instead of constructing one. The offline self-test passes an
   * `OfflineAudioContext`; passing a factory that returns null exercises the
   * audio-unavailable path.
   */
  contextFactory?: () => BaseAudioContext | null;
  /** Start with the master muted. */
  muted?: boolean;
  masterGain?: number;
  /** Skip everything, including context creation. */
  disabled?: boolean;
}

export interface AudioStats {
  available: boolean;
  ready: boolean;
  state: string;
  sampleRate: number;
  voices: number;
  peakVoices: number;
  voiceCap: number;
  musicNotes: number;
  started: number;
  culled: number;
  stolen: number;
  /** Exponentially-smoothed main-thread cost of the audio subsystem, milliseconds. */
  cpuMs: number;
  buildMs: number;
  buffers: number;
  bufferBytes: number;
  cue: MusicCue;
  intensity: number;
  meleeIntensity: number;
  hitsPerSecond: number;
  emitters: number;
  beds: number;
}

/** How many discrete cluster voices each quality tier is allowed. */
const DETAIL_BY_TIER: Record<string, number> = { low: 0.5, medium: 0.75, high: 1, ultra: 1.15 };

export class AudioEngine implements Subsystem {
  readonly name = 'audio';
  readonly order = 400;

  private engineCtx: EngineContext | null = null;
  private actx: BaseAudioContext | null = null;
  private liveCtx: AudioContext | null = null;
  private bank: SoundBank | null = null;
  private mixer: Mixer | null = null;
  private battleAudio: BattleAudio | null = null;
  private ambience: Ambience | null = null;
  private music: Music | null = null;

  /** A context exists. */
  available = false;
  /** Buffers are built and the graph is live. */
  ready = false;
  private prepared = false;
  private muted: boolean;

  private unsubscribe: Array<() => void> = [];
  private gestureCleanup: Array<() => void> = [];
  private cpuMs = 0;
  private manualCueTimer = 0;
  private cueLocked = false;
  private intensity = 0;
  private attachTimer = 1e9;

  constructor(private readonly opts: AudioEngineOptions = {}) {
    this.muted = opts.muted === true;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(ctx: EngineContext): void {
    this.engineCtx = ctx;
    this.wireEvents(ctx);

    if (this.opts.disabled) return;

    this.actx = this.createContext();
    if (!this.actx) {
      // No Web Audio at all. Every entry point below is a no-op from here.
      return;
    }
    this.available = true;

    // `length` is on OfflineAudioContext and not on AudioContext — the cleanest way to
    // tell a rendering context from a real output device.
    const offline = 'length' in this.actx;
    if (!offline) {
      this.liveCtx = this.actx as AudioContext;
      this.liveCtx.addEventListener?.('statechange', this.onStateChange);
    }

    if (offline || this.liveCtx?.state === 'running') {
      this.prepare();
    } else {
      // Browsers block audio until the user does something. Wait for that, and do not
      // call resume() before it — an unprompted resume logs a console warning and, in a
      // headless harness, would be pure noise.
      this.armGesture();
    }
  }

  private createContext(): BaseAudioContext | null {
    if (this.opts.contextFactory) {
      try {
        return this.opts.contextFactory();
      } catch (err) {
        console.warn('[audio] supplied context factory failed:', err);
        return null;
      }
    }
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          // Safari shipped the prefixed name for years; still worth honouring.
          : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      return new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[audio] AudioContext unavailable:', err);
      return null;
    }
  }

  /** Build the bank and the graph. Safe to call more than once. */
  private prepare(): void {
    if (this.prepared || !this.actx) return;
    this.prepared = true;
    try {
      const tier = this.engineCtx?.quality.tier ?? 'high';
      this.bank = buildSoundBank(this.actx);
      this.mixer = new Mixer(this.actx, this.bank, {
        reverb: tier !== 'low',
        masterGain: this.muted ? 0 : this.opts.masterGain ?? 0.85,
      });
      this.mixer.running = this.isRunning();
      this.battleAudio = new BattleAudio(this.mixer, { detail: DETAIL_BY_TIER[tier] ?? 1 });
      this.ambience = new Ambience(this.mixer);
      this.music = new Music(this.mixer);
      this.music.start();
      this.attachTimer = 1e9;
      this.attachSimSources();
      this.ready = true;

      if (import.meta.env?.DEV) {
        // Debug/verification hook. The self-test drives voice counting through this.
        (globalThis as unknown as { __audio?: unknown }).__audio = {
          engine: this,
          stats: () => this.stats(),
          bank: this.bank,
          mixer: this.mixer,
          resume: () => this.resume(),
        };
      }
    } catch (err) {
      console.warn('[audio] failed to build the audio graph; continuing silent:', err);
      this.ready = false;
    }
  }

  private isRunning(): boolean {
    if (!this.actx) return false;
    if (!this.liveCtx) return true; // offline rendering contexts are always "running"
    return this.liveCtx.state === 'running';
  }

  private armGesture(): void {
    if (typeof window === 'undefined') return;
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    const handler = (): void => {
      this.disarmGesture();
      void this.resume();
    };
    for (const e of events) {
      try {
        window.addEventListener(e, handler, { passive: true });
        this.gestureCleanup.push(() => window.removeEventListener(e, handler));
      } catch {
        /* a hostile environment is still not a reason to crash */
      }
    }
  }

  private disarmGesture(): void {
    for (const off of this.gestureCleanup) off();
    this.gestureCleanup.length = 0;
  }

  private onStateChange = (): void => {
    if (!this.liveCtx) return;
    const running = this.liveCtx.state === 'running';
    if (running && !this.prepared) this.prepare();
    if (this.mixer) this.mixer.running = running;
  };

  /**
   * Resume a suspended context and finish setup. Call only from a user gesture. Never
   * rejects: an audio failure must not surface as an unhandled rejection.
   */
  async resume(): Promise<boolean> {
    if (!this.actx) return false;
    if (!this.liveCtx) {
      this.prepare();
      return true;
    }
    try {
      if (this.liveCtx.state !== 'running') await this.liveCtx.resume();
    } catch (err) {
      console.warn('[audio] resume refused:', err);
      return false;
    }
    this.prepare();
    if (this.mixer) this.mixer.running = this.isRunning();
    return this.isRunning();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.disarmGesture();
    this.liveCtx?.removeEventListener?.('statechange', this.onStateChange);
    this.battleAudio?.dispose();
    this.ambience?.dispose();
    this.music?.dispose();
    this.mixer?.dispose();
    this.battleAudio = null;
    this.ambience = null;
    this.music = null;
    this.mixer = null;
    this.bank = null;
    this.ready = false;
    // Only a context we created is ours to close.
    if (this.liveCtx && !this.opts.contextFactory) {
      this.liveCtx.close().catch(() => {
        /* closing twice is not an error worth reporting */
      });
    }
    this.liveCtx = null;
    this.actx = null;
    if (import.meta.env?.DEV) {
      delete (globalThis as unknown as { __audio?: unknown }).__audio;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * All audio work happens here rather than in `update` so the listener basis comes from
   * the camera the frame is actually rendered with.
   */
  preRender(ctx: EngineContext): void {
    if (!this.ready || !this.mixer) return;
    const t0 = performance.now();
    try {
      this.mixer.running = this.isRunning();

      // Listener basis from the final camera matrix, projected onto the ground plane.
      const m = ctx.camera.matrixWorld.elements;
      this.mixer.setListener(m[12], m[13], m[14], m[0], m[2], -m[8], -m[10]);

      const simDt = ctx.time.scaledDt;
      const realDt = ctx.time.frameDt;

      // A subsystem registered after us (combat, projectiles) still gets picked up.
      this.attachTimer += realDt;
      if (this.attachTimer > 2) {
        this.attachTimer = 0;
        this.attachSimSources();
      }

      this.battleAudio?.update(simDt);
      this.mixer.update();

      const s = this.battleAudio?.stats();
      if (s) {
        // One number for the score to react to: how much fighting, how fast men are
        // falling, how much of the army is committed, and how much of it is running.
        this.intensity = clamp01(
          0.5 * s.meleeIntensity +
          0.28 * clamp01(s.deathsPerSecond / 9) +
          0.26 * (this.battleAudio?.engagedFraction ?? 0) +
          0.18 * clamp01(s.routingMen / 420)
        );
      }

      this.ambience?.update(realDt, this.weather(), this.battleAudio?.meleeIntensity ?? 0);

      if (this.music) {
        this.music.setIntensity(this.intensity);
        this.manualCueTimer = Math.max(0, this.manualCueTimer - realDt);
        if (!this.cueLocked && this.manualCueTimer <= 0) this.autoCue();
        this.music.update(realDt);
      }
    } catch (err) {
      // A broken frame of audio must never take the renderer with it.
      console.warn('[audio] frame update failed; disabling audio:', err);
      this.ready = false;
    }
    const dtMs = performance.now() - t0;
    this.cpuMs += (dtMs - this.cpuMs) * 0.06;
  }

  /** Pick a cue from the state of the battle when the game has not asked for one. */
  private autoCue(): void {
    if (!this.music) return;
    const b = this.battleAudio;
    const want: MusicCue =
      this.intensity > 0.26 ? 'battle'
      : (b?.engagedFraction ?? 0) > 0.02 || this.enemyProximity() < 260 ? 'tension'
      : 'calm';
    this.music.setCue(want);
  }

  /** Closest distance between opposing unit anchors, for the calm→tension transition. */
  private enemyProximity(): number {
    const b = this.battle;
    if (!b) return Infinity;
    let best = Infinity;
    const units = b.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.destroyed || u.alive <= 0) continue;
      for (let j = i + 1; j < units.length; j++) {
        const o = units[j];
        if (o.destroyed || o.alive <= 0 || o.faction === u.faction) continue;
        const d = Math.hypot(o.x - u.x, o.z - u.z);
        if (d < best) best = d;
      }
    }
    return best;
  }

  private battle: BattleView | null = null;

  /** Resolve the sim systems we read from. Re-run periodically: they may register later. */
  private attachSimSources(): void {
    const ctx = this.engineCtx;
    if (!ctx || !this.battleAudio) return;
    const battle = (ctx.tryGet('battle') as unknown as BattleView | undefined) ?? null;
    /*
     * One method, and the record it returns is `ProjectileFeed`, which both files import.
     *
     * The seven-clause `instanceof` battery this replaces looked like the most careful test
     * in the file and was in fact the reason nobody looked at it again: it tested for
     * `activeCount`, `x`, `y` and `z`, which `ProjectileSystem` does not have and never had,
     * failed on the first clause, and handed `attach` a `null` in silence. A guard that can
     * only ever say no is indistinguishable from a system that is not registered.
     */
    const proj = ctx.tryGet('projectiles') as unknown as
      { projectileFeed?: () => ProjectileFeed } | undefined;
    const projView = typeof proj?.projectileFeed === 'function'
      ? () => proj.projectileFeed!()
      : null;
    this.battle = battle && battle.units && battle.pool ? battle : null;
    this.battleAudio.attach(this.battle, projView);
  }

  /**
   * The weather the ambience bed follows, gathered from the two systems that actually have it.
   *
   * **It used to ask `'sky'` for all four fields and got two of them back as `undefined`.**
   * `SkySystem` has `timeOfDay` and nothing else on that list: no `windSpeed`, no `rain`, and
   * its cloud cover is `preset.cloudCoverage`, not `cloud`. Every read was guarded with a
   * `typeof === 'number'`, every guard failed, and `Ambience.update` fell through to its
   * literals — `cloud = 0.2`, `rain = 0`, `base = 0.34` — for the whole life of the game. The
   * bed was weather-deaf: cicadas and a dawn chorus through a rainstorm, and a wind bed that
   * never once answered the gust the banners were visibly bending to.
   *
   * Wind and rain live on `VFXSystem`, which owns the weather state (`src/vfx/Weather.ts`).
   * `wind` there is the instantaneous vector including gusts, which is exactly what a wind bed
   * wants. Cloud stays with the sky, because cloud is the thing overhead and the sky is what
   * draws it — but it is `preset.cloudCoverage`, whose sense is **inverted** (its own doc: a
   * threshold in sigma units centred on 0.5, "LOWER means more cloud"), so it is turned round
   * here rather than handed over backwards.
   *
   * Every field is still optional and still guarded: a viewer scene with no VFX system is a
   * real configuration and it gets the procedural gust model, which is what the absent case
   * was always for.
   */
  private weather(): WeatherView | null {
    const ctx = this.engineCtx;
    if (!ctx) return null;
    const sky = ctx.tryGet('sky') as unknown as
      { timeOfDay?: number; preset?: { cloudCoverage?: number } } | undefined;
    const vfx = ctx.tryGet('vfx') as unknown as
      { wind?: { length(): number }; weatherKind?: string } | undefined;
    if (!sky && !vfx) return null;

    let cloud: number | undefined;
    const cov = sky?.preset?.cloudCoverage;
    if (typeof cov === 'number') {
      // 0.35 is roughly 84% sky covered and 0.65 roughly 16%; map that band onto 0..1 the
      // right way up. Clamped, because a preset may sit outside it.
      cloud = clamp01((0.65 - cov) / 0.3);
    }
    // Overcast and rain are weather states, not sky presets, and they win where they exist.
    if (vfx?.weatherKind === 'overcast') cloud = Math.max(cloud ?? 0, 0.8);
    else if (vfx?.weatherKind === 'rain') cloud = 1;

    return {
      timeOfDay: typeof sky?.timeOfDay === 'number' ? sky.timeOfDay : undefined,
      windSpeed: typeof vfx?.wind?.length === 'function' ? vfx.wind.length() : undefined,
      rain: vfx?.weatherKind === 'rain' ? 1 : vfx?.weatherKind ? 0 : undefined,
      cloud,
    };
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  private wireEvents(ctx: EngineContext): void {
    const on = <K extends keyof import('../core/events').GameEvents>(
      key: K,
      fn: (p: import('../core/events').GameEvents[K]) => void
    ): void => {
      // Every handler is individually guarded. `EventBus` reports a throwing handler with
      // console.error, which the screenshot harness treats as a build failure.
      this.unsubscribe.push(ctx.events.on(key, (p) => {
        if (!this.ready) return;
        try {
          fn(p);
        } catch (err) {
          console.warn(`[audio] handler for "${String(key)}" failed:`, err);
        }
      }));
    };

    on('meleeHit', (e) => {
      this.battleAudio?.meleeHit(e.x, e.y, e.z, e.kind, e.lethal === true);
    });

    on('projectileImpact', (e) => {
      this.battleAudio?.projectileImpact(e.x, e.y, e.z, e.material, e.hitTarget === true);
    });

    on('volleyFired', (e) => {
      this.battleAudio?.volleyFired(e.x, e.y, e.z, e.kind, e.count ?? 1);
    });

    on('linesClashed', (e) => {
      this.battleAudio?.linesClashed(e.x, e.z, e.intensity ?? 1, e.attackerFaction ?? 0);
    });

    on('cavalryCharge', (e) => {
      const faction = this.battle?.units.find((u) => u.id === e.unitId)?.faction ?? 0;
      this.battleAudio?.cavalryCharge(e.x, e.z, e.intensity ?? 1, faction);
    });

    on('soldierDied', (e) => {
      this.battleAudio?.soldierDied(e.x, e.y, e.z, e.index ?? 0);
    });

    on('unitRouted', (e) => {
      this.battleAudio?.unitRouted(e.unitId);
    });

    on('unitDestroyed', (e) => {
      const u = this.battle?.units.find((v) => v.id === e.unitId);
      if (u) this.battleAudio?.unitRouted(e.unitId);
    });

    on('battleStarted', () => {
      // Cornu sounds the advance; the host answers with the barritus a beat later.
      const roman = this.factionCentre(Faction.Rome);
      const germ = this.factionCentre(Faction.Germanic);
      this.battleAudio?.cornu(roman.x, roman.z, false, 0.2);
      this.battleAudio?.warCry(Faction.Germanic, germ.x, germ.z, 2.4);
      this.music?.setCue('tension');
      this.manualCueTimer = 12;
    });

    on('battleEnded', (e) => {
      const playerWon = e.victor === Faction.Rome;
      this.music?.setCue(playerWon ? 'victory' : 'defeat');
      this.cueLocked = true;
      this.battleAudio?.battleEnded();
      const c = this.factionCentre(playerWon ? Faction.Rome : Faction.Germanic);
      this.battleAudio?.cornu(c.x, c.z, !playerWon, 0.6);
    });

    on('playSound', (e) => {
      if (!this.mixer || !e?.id) return;
      const positioned = typeof e.x === 'number' && typeof e.z === 'number';
      this.mixer.play(e.id, {
        x: e.x ?? 0,
        y: e.y ?? 0,
        z: e.z ?? 0,
        gain: clamp(e.volume ?? 1, 0, 4),
        rate: clamp(e.pitch ?? 1, 0.25, 4),
        bus: positioned ? 'combat' : 'ui',
        ambient: !positioned,
        priority: 1,
      });
    });

    on('musicCue', (e) => {
      if (!e?.id) return;
      this.music?.setCue(e.id);
      this.cueLocked = e.id === 'victory' || e.id === 'defeat';
      // Respect an explicit cue for a while before the automatic logic takes over again.
      this.manualCueTimer = 20;
    });

    on('unitMoraleChanged', (e) => {
      // A collapse in morale is a musical event even when nothing else is happening.
      if (!e) return;
      const drop = (e.previous ?? 0) - (e.morale ?? 0);
      if (drop > 18 && this.manualCueTimer <= 0 && !this.cueLocked) {
        this.music?.setCue('battle');
      }
    });
  }

  /** Centre of mass of a faction's surviving units, for placing signals and cries. */
  private factionCentre(faction: Faction): { x: number; z: number } {
    const b = this.battle;
    if (!b) return { x: 0, z: faction === Faction.Rome ? 130 : -190 };
    let sx = 0;
    let sz = 0;
    let w = 0;
    for (const u of b.units) {
      if (u.destroyed || u.faction !== faction || u.alive <= 0) continue;
      sx += u.x * u.alive;
      sz += u.z * u.alive;
      w += u.alive;
    }
    if (w === 0) return { x: 0, z: faction === Faction.Rome ? 130 : -190 };
    return { x: sx / w, z: sz / w };
  }

  // -------------------------------------------------------------------------
  // Public controls (for an options screen, and for the self-test)
  // -------------------------------------------------------------------------

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.mixer?.setMasterGain(muted ? 0 : this.opts.masterGain ?? 0.85);
  }

  setBusVolume(bus: 'music' | 'ambience' | 'combat' | 'ui' | 'voice', v: number): void {
    this.mixer?.setBusGain(bus, v);
  }

  /** Force the score to a cue and hold it there. */
  setMusicCue(cue: MusicCue): void {
    this.music?.setCue(cue);
    this.manualCueTimer = 30;
  }

  get soundBank(): SoundBank | null {
    return this.bank;
  }

  get audioMixer(): Mixer | null {
    return this.mixer;
  }

  get battleLayers(): BattleAudio | null {
    return this.battleAudio;
  }

  get score(): Music | null {
    return this.music;
  }

  stats(): AudioStats {
    const c = this.mixer?.counters;
    const bs = this.battleAudio?.stats();
    const ms = this.music?.stats();
    const amb = this.ambience?.stats();
    return {
      available: this.available,
      ready: this.ready,
      state: this.liveCtx?.state ?? (this.actx ? 'offline' : 'none'),
      sampleRate: this.actx?.sampleRate ?? 0,
      voices: this.mixer?.activeVoices ?? 0,
      peakVoices: c?.peakVoices ?? 0,
      voiceCap: MAX_SPATIAL_VOICES + MAX_MUSIC_VOICES,
      musicNotes: ms?.notes ?? 0,
      started: c?.started ?? 0,
      culled: c?.culled ?? 0,
      stolen: c?.stolen ?? 0,
      cpuMs: this.cpuMs,
      buildMs: this.bank?.stats.buildMs ?? 0,
      buffers: this.bank?.stats.count ?? 0,
      bufferBytes: this.bank?.stats.totalBytes ?? 0,
      cue: ms?.cue ?? 'calm',
      intensity: this.intensity,
      meleeIntensity: bs?.meleeIntensity ?? 0,
      hitsPerSecond: bs?.hitsPerSecond ?? 0,
      emitters: bs?.emitters ?? 0,
      beds: (bs?.beds ?? 0) + (amb?.beds ?? 0),
    };
  }
}
