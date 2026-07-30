/**
 * AI timing instrumentation.
 *
 * `performance.now()` must never influence a simulation decision, so profiling is
 * off by default and the numbers it collects are only ever read by the debug overlay
 * and the verification harness. When disabled the cost is one boolean test per system
 * per tick.
 */

export type AIProfileKey = 'pathfinding' | 'tactical' | 'general';

const KEYS: AIProfileKey[] = ['pathfinding', 'tactical', 'general'];

export const AIProfile = {
  enabled: false,
  /** Milliseconds spent in the most recent fixedUpdate, per system. */
  last: { pathfinding: 0, tactical: 0, general: 0 } as Record<AIProfileKey, number>,
  /** Exponential moving average in milliseconds. */
  avg: { pathfinding: 0, tactical: 0, general: 0 } as Record<AIProfileKey, number>,
  /** Worst single tick seen since the last reset. */
  peak: { pathfinding: 0, tactical: 0, general: 0 } as Record<AIProfileKey, number>,
  samples: 0,

  reset(): void {
    for (const k of KEYS) {
      this.last[k] = 0;
      this.avg[k] = 0;
      this.peak[k] = 0;
    }
    this.samples = 0;
  },

  /** Sum of the three systems' moving averages — the number the budget applies to. */
  totalAvg(): number {
    return this.avg.pathfinding + this.avg.tactical + this.avg.general;
  },

  totalPeak(): number {
    return this.peak.pathfinding + this.peak.tactical + this.peak.general;
  },
};

export const setAIProfiling = (on: boolean): void => {
  AIProfile.enabled = on;
  if (on) AIProfile.reset();
};

export const profileBegin = (): number => (AIProfile.enabled ? performance.now() : 0);

export const profileEnd = (key: AIProfileKey, t0: number): void => {
  if (!AIProfile.enabled) return;
  const ms = performance.now() - t0;
  AIProfile.last[key] = ms;
  // 40-tick time constant: settles in about a second and a half of sim time.
  AIProfile.avg[key] = AIProfile.avg[key] === 0 ? ms : AIProfile.avg[key] * 0.975 + ms * 0.025;
  if (ms > AIProfile.peak[key]) AIProfile.peak[key] = ms;
  if (key === 'general') AIProfile.samples++;
};
