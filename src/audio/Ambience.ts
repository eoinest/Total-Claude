/**
 * The sound of the place, with the battle taken out of it.
 *
 * A still frame of an empty field should still sound like somewhere: wind moving through
 * dry grass, insects in the heat, birds, and Rome itself as a low rumble off to the south.
 * All of it shifts with the hour of the day, and all of it ducks hard once the lines meet —
 * a man in the crush does not hear skylarks.
 */

import { clamp, clamp01, lerp, TAU } from '../util/math';
import { hash01 } from '../util/rand';
import { Bed, type Mixer } from './Mixer';
import { variantId } from './Synth';

/** What the ambience needs from the sky/weather system, all optional. */
export interface WeatherView {
  /** Hours past midnight, 0..24. */
  timeOfDay?: number;
  /** Metres per second. Absent means "use the procedural gust model". */
  windSpeed?: number;
  /** 0..1 precipitation. */
  rain?: number;
  /** 0..1 cloud cover — overcast days are quieter and have fewer birds. */
  cloud?: number;
}

/** Rome sits south of the Campus Martius; +Z is the city in this scenario's convention. */
const CITY_X = 0;
const CITY_Z = 620;

export class Ambience {
  private windSoft: Bed;
  private windGust: Bed;
  private insects: Bed;
  private city: Bed;

  private t = 0;
  private birdTimer = 2;
  private duck = 0;

  /** Smoothed 0..1 wind strength, either from the weather system or generated here. */
  wind = 0.35;

  constructor(private readonly mixer: Mixer) {
    this.windSoft = new Bed(mixer, 'wind_soft', { bus: 'ambience', ambient: true, tau: 0.9 });
    this.windGust = new Bed(mixer, 'wind_gust', { bus: 'ambience', ambient: true, tau: 0.7 });
    this.insects = new Bed(mixer, 'insects', { bus: 'ambience', ambient: true, tau: 1.4 });
    this.city = new Bed(mixer, 'city_distant', { bus: 'ambience', aggregate: true, tau: 1.6 });
  }

  /**
   * @param battleIntensity 0..1 — how loud the fighting is, used to duck everything here.
   */
  update(dt: number, weather: WeatherView | null, battleIntensity: number): void {
    if (dt <= 0) return;
    this.t += dt;

    const hour = weather?.timeOfDay ?? 10;
    const cloud = clamp01(weather?.cloud ?? 0.2);
    const rain = clamp01(weather?.rain ?? 0);

    // Gusting. Three incommensurate periods so it never reads as an LFO; if the sky
    // system publishes a real wind speed we follow that and only gust around it.
    const gust =
      0.5 + 0.5 * (
        0.55 * Math.sin(TAU * this.t * 0.043) +
        0.3 * Math.sin(TAU * this.t * 0.111 + 1.7) +
        0.15 * Math.sin(TAU * this.t * 0.29 + 4.1)
      );
    const base = weather?.windSpeed !== undefined ? clamp01(weather.windSpeed / 12) : 0.34;
    const targetWind = clamp01(base * 0.65 + gust * 0.55 + rain * 0.2);
    this.wind += (targetWind - this.wind) * clamp01(dt * 0.8);

    // Battle ducking, smoothed so a clash does not chop the wind off mid-gust.
    const wantDuck = clamp01(battleIntensity);
    this.duck += (wantDuck - this.duck) * clamp01(dt * 1.2);
    const open = 1 - this.duck * 0.72;

    this.windSoft.set(dt, lerp(0.28, 0.5, this.wind) * open, 0, 0, 0, lerp(0.95, 1.05, this.wind));
    this.windGust.set(dt, Math.pow(clamp01((this.wind - 0.35) / 0.65), 1.4) * 0.42 * open, 0, 0, 0, 1);

    // Cicadas from mid-morning through the afternoon heat, crickets after dark. Nothing
    // at dawn, which is when a Roman army would actually have deployed.
    const dayHeat = bellCurve(hour, 15, 5.0);
    const night = bellCurve(hour, 23.5, 3.2) + bellCurve(hour, 0.5, 3.2);
    const insectLevel = clamp01(dayHeat * 0.85 + night * 0.5) * (1 - rain * 0.8) * (1 - cloud * 0.35);
    this.insects.set(dt, insectLevel * 0.5 * open, 0, 0, 0, lerp(0.92, 1.08, clamp01(dayHeat)));

    // The city is audible day and night, but a million people are louder at midday.
    const cityLevel = lerp(0.35, 1, bellCurve(hour, 13, 7.5));
    this.city.set(dt, cityLevel * 0.95 * (1 - this.duck * 0.55), CITY_X, 12, CITY_Z, 1);

    // Birds: a dawn chorus, then sporadic through the day, silent at night and in rain.
    const birdActivity = clamp01(
      bellCurve(hour, 6.5, 1.6) * 1.4 + bellCurve(hour, 12, 5) * 0.5 + bellCurve(hour, 18.5, 1.8) * 0.7
    ) * (1 - rain) * (1 - this.duck * 0.9);
    this.birdTimer -= dt * (0.35 + birdActivity * 2.6);
    if (this.birdTimer <= 0) {
      this.birdTimer = 1.4 + hash01(Math.floor(this.t * 31), 5) * 4.5;
      if (birdActivity > 0.06) this.chirp(birdActivity);
    }
  }

  /** One bird, somewhere off to the side of the view and a little above the listener. */
  private chirp(activity: number): void {
    const h = hash01(Math.floor(this.t * 977), 3);
    const h2 = hash01(Math.floor(this.t * 977), 11);
    const ang = h * TAU;
    const dist = lerp(14, 90, h2);
    const x = this.mixer.listenerX + Math.sin(ang) * dist;
    const z = this.mixer.listenerZ + Math.cos(ang) * dist;
    this.mixer.play(variantId('bird', h2), {
      x,
      y: this.mixer.listenerY + lerp(-4, 10, h),
      z,
      gain: lerp(0.35, 0.8, activity),
      rate: 0.9 + h * 0.3,
      bus: 'ambience',
      priority: 0.1,
    }, 0.4);
  }

  stats(): { wind: number; beds: number } {
    let beds = 0;
    for (const b of [this.windSoft, this.windGust, this.insects, this.city]) if (b.live) beds++;
    return { wind: this.wind, beds };
  }

  dispose(): void {
    for (const b of [this.windSoft, this.windGust, this.insects, this.city]) b.stop(0.05);
  }
}

/** Unit-height gaussian over the 24 h clock, wrapping at midnight. */
function bellCurve(hour: number, centre: number, width: number): number {
  let d = Math.abs(((hour - centre) % 24 + 24) % 24);
  if (d > 12) d = 24 - d;
  const x = d / Math.max(0.1, width);
  return clamp(Math.exp(-x * x), 0, 1);
}
