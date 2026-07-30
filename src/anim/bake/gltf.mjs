/**
 * Minimal glTF 2.0 reader for the offline animation retargeter.
 *
 * Only what the baker needs: node hierarchy, skins, and animation samplers. The
 * Quaternius source files embed their buffers as base64 data URIs, so there is no
 * external .bin to resolve and no need for a real loader.
 *
 * This runs at author time (`node src/anim/bake/retarget.mjs`), never in the browser.
 */

import { readFileSync } from 'node:fs';

const COMPONENT = {
  5120: [Int8Array, 1],
  5121: [Uint8Array, 1],
  5122: [Int16Array, 2],
  5123: [Uint16Array, 2],
  5125: [Uint32Array, 4],
  5126: [Float32Array, 4],
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function loadGltf(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const buffers = json.buffers.map((b) => {
    if (!b.uri || !b.uri.startsWith('data:')) {
      throw new Error(`[gltf] ${path}: only embedded data-URI buffers are supported`);
    }
    return Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64');
  });

  /** Read an accessor into a flat Float32Array, de-interleaving if needed. */
  const accessor = (index) => {
    const a = json.accessors[index];
    const n = COMPONENTS_PER[a.type];
    const [Arr, size] = COMPONENT[a.componentType];
    const bv = json.bufferViews[a.bufferView];
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride || n * size;
    const buf = buffers[bv.buffer];
    const out = new Float32Array(a.count * n);
    for (let k = 0; k < a.count; k++) {
      const view = new Arr(buf.buffer, buf.byteOffset + base + k * stride, n);
      for (let c = 0; c < n; c++) out[k * n + c] = view[c];
    }
    return { data: out, stride: n, count: a.count };
  };

  const nodes = json.nodes;
  const byName = new Map();
  nodes.forEach((n, i) => {
    if (n.name !== undefined && !byName.has(n.name)) byName.set(n.name, i);
  });
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    for (const c of n.children || []) parent[c] = i;
  });

  return { json, accessor, nodes, byName, parent };
}

/**
 * The authoritative bind pose, from the skin's `inverseBindMatrices`.
 *
 * The node hierarchy's own TRS is NOT the bind pose in these files — Blender's exporter
 * leaves whatever pose was current, which here is a relaxed asymmetric idle. Inverting
 * the bind matrices recovers the true symmetric T-pose the mesh was skinned in, and the
 * retarget is only exact if it starts from that.
 */
export function bindPose(gltf, skinIndex = 0) {
  const skin = gltf.json.skins[skinIndex];
  const ibm = gltf.accessor(skin.inverseBindMatrices);
  const out = new Map();
  for (let j = 0; j < skin.joints.length; j++) {
    const m = ibm.data.subarray(j * 16, j * 16 + 16); // column-major, m[col*4 + row]
    // The bind matrix is [R | t], so the inverse bind matrix is [Rᵀ | -Rᵀt]. Reading
    // the IBM's columns as a row-major 3x3 transposes it, which recovers R directly.
    const r = [
      m[0], m[1], m[2],
      m[4], m[5], m[6],
      m[8], m[9], m[10],
    ];
    const ti = [m[12], m[13], m[14]];
    // t = -R * ti
    const t = [
      -(r[0] * ti[0] + r[1] * ti[1] + r[2] * ti[2]),
      -(r[3] * ti[0] + r[4] * ti[1] + r[5] * ti[2]),
      -(r[6] * ti[0] + r[7] * ti[1] + r[8] * ti[2]),
    ];
    out.set(skin.joints[j], { r, t });
  }
  return out;
}

/** Row-major 3x3 rotation matrix -> quaternion (Shepperd's branchless-ish method). */
export function mat3ToQuat(r) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Build a per-node sampler table for one animation: for each node, the rotation and
 * translation key streams. Quaternius exports every bone with baked LINEAR keys, so a
 * plain binary search plus slerp reproduces the source exactly.
 */
export function readAnimation(gltf, name) {
  const anim = gltf.json.animations.find((a) => a.name === name);
  if (!anim) throw new Error(`[gltf] animation "${name}" not found`);
  const tracks = new Map();
  let duration = 0;
  for (const ch of anim.channels) {
    const path = ch.target.path;
    if (path !== 'rotation' && path !== 'translation') continue;
    const s = anim.samplers[ch.sampler];
    const times = gltf.accessor(s.input);
    const values = gltf.accessor(s.output);
    duration = Math.max(duration, times.data[times.count - 1]);
    let t = tracks.get(ch.target.node);
    if (!t) tracks.set(ch.target.node, (t = {}));
    t[path] = { times: times.data, values: values.data, stride: values.stride };
  }
  return { name, duration, tracks };
}
