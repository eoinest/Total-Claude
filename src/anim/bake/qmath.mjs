/**
 * Rigid-transform maths for the offline retargeter.
 *
 * Everything here is a (quaternion, translation) pair. Both source and target rigs are
 * rigid — no per-bone scale — so a quaternion plus a vector reproduces every transform
 * exactly, composes cheaply, and inverts in closed form. That is also precisely the
 * format the runtime animation texture stores, so the baker and the GPU agree.
 */

export const qmul = (a, b, out = [0, 0, 0, 1]) => {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
};

/** Inverse of a unit quaternion. */
export const qinv = (q, out = [0, 0, 0, 1]) => {
  out[0] = -q[0];
  out[1] = -q[1];
  out[2] = -q[2];
  out[3] = q[3];
  return out;
};

export const qnorm = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l;
  q[1] /= l;
  q[2] /= l;
  q[3] /= l;
  return q;
};

export const qrot = (q, v, out = [0, 0, 0]) => {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q_vec x v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
};

export const qslerp = (a, b, t, out = [0, 0, 0, 1]) => {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    out[0] = a[0] + (bx - a[0]) * t;
    out[1] = a[1] + (by - a[1]) * t;
    out[2] = a[2] + (bz - a[2]) * t;
    out[3] = a[3] + (bw - a[3]) * t;
    return qnorm(out);
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  out[0] = a[0] * wa + bx * wb;
  out[1] = a[1] * wa + by * wb;
  out[2] = a[2] * wa + bz * wb;
  out[3] = a[3] * wa + bw * wb;
  return out;
};

/** Euler XYZ in radians -> quaternion (matches THREE.Quaternion.setFromEuler order 'XYZ'). */
export const qeuler = (x, y, z, out = [0, 0, 0, 1]) => {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[3] = c1 * c2 * c3 - s1 * s2 * s3;
  return out;
};

export const qaxis = (ax, ay, az, angle, out = [0, 0, 0, 1]) => {
  const h = angle / 2;
  const s = Math.sin(h);
  out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(h);
  return out;
};

/** Rigid transform: { q, t }. Compose parent∘child. */
export const rcompose = (a, b) => ({
  q: qnorm(qmul(a.q, b.q)),
  t: (() => {
    const r = qrot(a.q, b.t);
    return [a.t[0] + r[0], a.t[1] + r[1], a.t[2] + r[2]];
  })(),
});

export const rinv = (a) => {
  const qi = qinv(a.q);
  const t = qrot(qi, [-a.t[0], -a.t[1], -a.t[2]]);
  return { q: qi, t };
};

export const rapply = (a, v) => {
  const r = qrot(a.q, v);
  return [a.t[0] + r[0], a.t[1] + r[1], a.t[2] + r[2]];
};

export const DEG = Math.PI / 180;
