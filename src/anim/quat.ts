/**
 * Allocation-free quaternion / rigid-transform helpers over flat Float32Arrays.
 *
 * The animation pipeline touches tens of thousands of transforms at load and a few
 * thousand per frame, and every one lives inside a packed array indexed by bone. Working
 * on `(array, offset)` pairs keeps that traffic out of the allocator entirely; THREE's
 * object-based Quaternion is used only where the count is small (socket solving).
 */

/** out = a * b, quaternion product. Offsets are element offsets, not component counts. */
export function qmul(
  out: Float32Array, o: number,
  a: Float32Array, ao: number,
  b: Float32Array, bo: number
): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = conjugate(a); valid inverse for unit quaternions. */
export function qconj(out: Float32Array, o: number, a: Float32Array, ao: number): void {
  out[o] = -a[ao];
  out[o + 1] = -a[ao + 1];
  out[o + 2] = -a[ao + 2];
  out[o + 3] = a[ao + 3];
}

export function qnormalise(q: Float32Array, o: number): void {
  const l = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]);
  if (l < 1e-12) {
    q[o] = 0; q[o + 1] = 0; q[o + 2] = 0; q[o + 3] = 1;
    return;
  }
  q[o] /= l; q[o + 1] /= l; q[o + 2] /= l; q[o + 3] /= l;
}

/** Rotate the vector at `vo` by the quaternion at `qo`, writing to `out`. */
export function qrotate(
  out: Float32Array, o: number,
  q: Float32Array, qo: number,
  v: Float32Array, vo: number
): void {
  const x = q[qo], y = q[qo + 1], z = q[qo + 2], w = q[qo + 3];
  const vx = v[vo], vy = v[vo + 1], vz = v[vo + 2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[o] = vx + w * tx + (y * tz - z * ty);
  out[o + 1] = vy + w * ty + (z * tx - x * tz);
  out[o + 2] = vz + w * tz + (x * ty - y * tx);
}

/** Shortest-arc normalised lerp. Good enough below ~60 degrees and far cheaper than slerp. */
export function qnlerp(
  out: Float32Array, o: number,
  a: Float32Array, ao: number,
  b: Float32Array, bo: number,
  t: number
): void {
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  out[o] = ax + (bx - ax) * t;
  out[o + 1] = ay + (by - ay) * t;
  out[o + 2] = az + (bz - az) * t;
  out[o + 3] = aw + (bw - aw) * t;
  qnormalise(out, o);
}

/** True spherical interpolation; `t` outside [0,1] extrapolates, which is how clip amplitudes are scaled. */
export function qslerp(
  out: Float32Array, o: number,
  a: Float32Array, ao: number,
  b: Float32Array, bo: number,
  t: number
): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    out[o] = ax + (bx - ax) * t;
    out[o + 1] = ay + (by - ay) * t;
    out[o + 2] = az + (bz - az) * t;
    out[o + 3] = aw + (bw - aw) * t;
    qnormalise(out, o);
    return;
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  out[o] = ax * wa + bx * wb;
  out[o + 1] = ay * wa + by * wb;
  out[o + 2] = az * wa + bz * wb;
  out[o + 3] = aw * wa + bw * wb;
  qnormalise(out, o);
}

/** Euler XYZ in radians -> quaternion, matching THREE's 'XYZ' order. */
export function qFromEuler(out: Float32Array, o: number, x: number, y: number, z: number): void {
  const c1 = Math.cos(x * 0.5), c2 = Math.cos(y * 0.5), c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5), s2 = Math.sin(y * 0.5), s3 = Math.sin(z * 0.5);
  out[o] = s1 * c2 * c3 + c1 * s2 * s3;
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

export function qIdentity(out: Float32Array, o: number): void {
  out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
}

/**
 * Mirror a rotation through the YZ plane (x -> -x).
 *
 * Reflecting a rotation R gives M·R·M with M = diag(-1,1,1), which for a quaternion is
 * just negating y and z. Used to turn a right-handed strike or a fall to one side into
 * its opposite without authoring it twice.
 */
export function qMirrorX(out: Float32Array, o: number, a: Float32Array, ao: number): void {
  out[o] = a[ao];
  out[o + 1] = -a[ao + 1];
  out[o + 2] = -a[ao + 2];
  out[o + 3] = a[ao + 3];
}
