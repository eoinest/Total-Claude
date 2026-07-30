/**
 * Scalar / vector helpers shared across the whole engine.
 * Kept dependency-free and allocation-free on the hot paths.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const remap = (v: number, a1: number, b1: number, a2: number, b2: number): number =>
  lerp(a2, b2, clamp01(invLerp(a1, b1, v)));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Frame-rate independent exponential approach. `rate` = how much of the gap closes per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * Math.exp(-rate * dt);

/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/** Rotate `a` toward `b` by at most `maxStep` radians. */
export const turnToward = (a: number, b: number, maxStep: number): number => {
  const d = angleDelta(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
};

export const angleLerp = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;

/** Wrap an angle into [-PI, PI). */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.sqrt(dist2(ax, ay, bx, by));

export const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Signed area of a triangle; >0 means CCW. */
export const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** Non-allocating 2D vector normalise-in-place into a shared scratch pair. */
export const norm2 = (out: { x: number; y: number }, x: number, y: number): number => {
  const l = Math.hypot(x, y);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 0;
    return 0;
  }
  out.x = x / l;
  out.y = y / l;
  return l;
};

/** Closest point on segment AB to P, returned as parametric t in [0,1]. */
export const closestOnSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number => {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return 0;
  return clamp01(((px - ax) * abx + (py - ay) * aby) / len2);
};

/** Next power of two >= v. */
export const nextPow2 = (v: number): number => {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
};

/** Triangle-wave ping-pong in [0, len]. */
export const pingPong = (t: number, len: number): number => {
  const m = ((t % (len * 2)) + len * 2) % (len * 2);
  return m <= len ? m : len * 2 - m;
};

/** Value in [0,1] with a soft plateau — useful for attack windup curves. */
export const bell = (t: number, peak = 0.5, width = 0.35): number => {
  const x = (clamp01(t) - peak) / width;
  return Math.exp(-x * x);
};

export const approxEq = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) < eps;
