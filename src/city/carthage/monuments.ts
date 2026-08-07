import * as THREE from 'three';
import { box, column, gableRoof, pavedField, statue, steps, type Batch } from '../build';
import type { CityChunkSpec, TreeRequest } from '../wall';
import { MONUMENTS, type Monument } from './layout';
import { PUN, tinted } from './palette';
import { hash2 } from '../../util/rand';

/**
 * Everything monumental that is not the citadel or the harbours.
 *
 * The forum and its stoa, the tophet, the public cisterns, the harbour horrea and the
 * lower temple of Eshmoun. Each is one chunk so that LOD fires on it independently — a
 * monument the camera is standing next to and a monument 900 m away have no business
 * sharing a detail level, which is exactly what happens when a whole quarter's worth of
 * masonry is baked into one 600 m chunk.
 */

const M4 = new THREE.Matrix4();

export interface MonumentOutput {
  chunks: CityChunkSpec[];
  trees: TreeRequest[];
  footprints: { x: number; z: number; hw: number; hd: number; rot: number }[];
}

/** A colonnaded portico along one side of a rectangle, facing inward. */
function portico(b: Batch, hw: number, z: number, facing: 1 | -1, y: number, detail: number): void {
  const st = b.s('stone');
  const h = 6.2;
  const d = 6.0;
  box(st, -hw, y, z - (facing > 0 ? d : 0), hw, y + 0.55, z + (facing > 0 ? 0 : d),
    tinted(PUN.ashlar, 0.6, 0.06), { bottom: false });
  const n = Math.max(4, Math.round(hw / 3.4));
  if (detail >= 1) {
    for (let i = 0; i <= n; i++) {
      const px = -hw + (i * hw * 2) / n;
      column(st, px, y + 0.55, z, 0.52, h, 'ionic', PUN.sandstonePale, detail >= 2 ? 1 : 0);
    }
  }
  box(st, -hw - 0.4, y + h + 0.55, z - (facing > 0 ? d : 0.4), hw + 0.4, y + h + 2.1,
    z + (facing > 0 ? 0.4 : d), tinted(PUN.ashlar, 0.8, 0.05), { bottom: false });
  const rs = b.s('roof');
  box(rs, -hw - 0.6, y + h + 2.1, z - (facing > 0 ? d + 0.4 : 0.6), hw + 0.6, y + h + 3.0,
    z + (facing > 0 ? 0.6 : d + 0.4), PUN.tile, { bottom: false });
}

function buildMonument(m: Monument, b: Batch, detail: number, y: number): void {
  const streams = b.pushAll(
    ['stone', 'stucco', 'road', 'roof', 'timber', 'metal', 'concrete'],
    M4.makeRotationY(m.rot).setPosition(m.x, y, m.z)
  );
  const st = b.s('stone');

  switch (m.kind) {
    case 'forum': {
      // A paved public square with a stepped edge. Punic Carthage's agora is described as
      // large enough for the whole assembly, and Appian's fighting reaches it from the
      // harbours — so it wants to be genuinely open ground: 210 × 96 m of level paving is
      // the only place inside the fabric a cohort can deploy in line.
      pavedField(b.s('road'), m.hw, m.hd, 0.12, 6.5, PUN.paving, 0x61, 0.1);
      for (const s of [-1, 1] as const) {
        const sub = b.pushAllTranslate(['stone'], 0, 0, s * m.hd);
        steps(st, m.hw * 2, -0.9, s > 0 ? 0 : 2.4, 3, 0.3, 0.8, tinted(PUN.ashlar, 0.5, 0.05));
        b.popAll(sub);
      }
      if (detail >= 1) {
        // Honorific columns down the spine, which is what gives a big empty square scale.
        for (let i = -2; i <= 2; i++) {
          const px = i * m.hw * 0.36;
          box(st, px - 1.6, 0.12, -1.6, px + 1.6, 1.5, 1.6, PUN.ashlar, { bottom: false });
          column(st, px, 1.5, 0, 0.7, 9.5, 'tuscan', PUN.sandstonePale, detail >= 2 ? 1 : 0);
          if (detail >= 2) statue(b.s('metal'), px, 11.0, 0, 3.0, PUN.bronze, i * 0.4);
        }
      }
      break;
    }
    case 'stoa': {
      portico(b, m.hw, 0, 1, 0, detail);
      break;
    }
    case 'temple': {
      // Levantine plan: a walled court with a pillared front, on a low podium.
      const podH = 3.0;
      box(st, -m.hw, 0, -m.hd, m.hw, podH, m.hd, tinted(PUN.ashlar, 0.7, 0.06),
        { bottom: false, batter: 0.02 });
      box(b.s('stucco'), -m.hw + 3, podH, -m.hd + 3, m.hw - 3, podH + 9.5, m.hd - 10,
        tinted(PUN.render, 0.6, 0.1), { bottom: false });
      const rs = b.s('roof');
      const sub = b.pushAllTranslate(['roof'], 0, podH + 9.5, (-m.hd + 3 + m.hd - 10) * 0.5);
      gableRoof(rs, rs, (m.hw - 3) * 2, m.hd - 13, 0, 2.4, 0.6, PUN.tile, true);
      b.popAll(sub);
      if (detail >= 1) {
        for (let i = 0; i < 4; i++) {
          column(st, -m.hw + 6 + (i * (m.hw * 2 - 12)) / 3, podH, m.hd - 6, 0.85, 8.5,
            'ionic', PUN.sandstonePale, detail >= 2 ? 1 : 0);
        }
        const s2 = b.pushAllTranslate(['stone'], 0, 0, m.hd + 0.1);
        steps(st, m.hw * 1.2, 0, 3.2, 8, podH / 8, 0.4, tinted(PUN.ashlar, 0.5, 0.05));
        b.popAll(s2);
      }
      break;
    }
    case 'tophet': {
      // The sanctuary: a walled enclosure of stelae over urn burials, terraced. Nothing in
      // Carthage is more distinctive and nothing is cheaper — a field of 1.2 m markers.
      const t = 0.6;
      for (const [x0, z0, x1, z1] of [
        [-m.hw, -m.hd, m.hw, -m.hd + t], [-m.hw, m.hd - t, m.hw, m.hd],
        [-m.hw, -m.hd, -m.hw + t, m.hd], [m.hw - t, -m.hd, m.hw, m.hd],
      ] as [number, number, number, number][]) {
        box(st, x0, -0.3, z0, x1, 2.6, z1, PUN.sandstoneDark, { bottom: false, groundShade: 0.2 });
      }
      pavedField(b.s('concrete'), m.hw - t, m.hd - t, 0.1, 5, PUN.earth, 0x62, 0.14);
      if (detail >= 1) {
        const cols = Math.floor((m.hw * 2 - 8) / 3.4);
        const rows = Math.floor((m.hd * 2 - 8) / 3.4);
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const h = hash2(i, j, 0x63);
            if (h < 0.22) continue;
            const px = -m.hw + 4 + i * 3.4 + (h - 0.5) * 0.6;
            const pz = -m.hd + 4 + j * 3.4 + (hash2(i, j, 0x64) - 0.5) * 0.6;
            const sh = 0.9 + h * 0.9;
            box(st, px - 0.32, 0.1, pz - 0.14, px + 0.32, sh, pz + 0.14,
              tinted(PUN.sandstonePale, h, 0.16), { bottom: false });
            // The pyramidal cap of a Punic stele — the shape that identifies the site.
            box(st, px - 0.24, sh, pz - 0.1, px + 0.24, sh + 0.3, pz + 0.1,
              tinted(PUN.sandstone, h, 0.12), { bottom: false });
          }
        }
      }
      break;
    }
    case 'cistern': {
      // Barrel-vaulted reservoirs in a parallel range. Approximated as vaulted bars, which
      // is what they look like: a row of long humps.
      const n = Math.max(3, Math.round(m.hd / 7));
      for (let i = 0; i < n; i++) {
        const cz = -m.hd + ((i + 0.5) * m.hd * 2) / n;
        const w = (m.hd * 2) / n - 1.4;
        box(st, -m.hw, 0, cz - w * 0.5, m.hw, 3.4, cz + w * 0.5, tinted(PUN.render, hash2(i, 0, 0x65), 0.1),
          { bottom: false, groundShade: 0.16 });
        if (detail >= 1) {
          // The vault: three steps of a barrel, which reads as a curve at any real distance.
          box(st, -m.hw, 3.4, cz - w * 0.42, m.hw, 4.3, cz + w * 0.42, tinted(PUN.render, 0.6, 0.08), { bottom: false });
          box(st, -m.hw, 4.3, cz - w * 0.26, m.hw, 4.9, cz + w * 0.26, tinted(PUN.render, 0.75, 0.06), { bottom: false });
        }
      }
      break;
    }
    case 'quay-fort': {
      // §6.4: the Roman siege platform on the captured quay — brick and timber, "as high as
      // the city wall", 4,000 men shooting down onto a 16 m rampart from level with it. An
      // *attacker's* structure standing inside the defender's city, which is the single
      // clearest statement the map can make about what moment it is set at.
      const deck = 16;
      box(st, -m.hw, 0, -m.hd, m.hw, 3.2, m.hd, tinted(PUN.sandstoneDark, 0.4, 0.1),
        { bottom: false, groundShade: 0.2, batter: 0.03 });
      box(b.s('stucco'), -m.hw + 1.5, 3.2, -m.hd + 1.5, m.hw - 1.5, deck - 1.2, m.hd - 1.5,
        tinted(PUN.mudbrick, 0.5, 0.1), { bottom: false, batter: 0.02 });
      box(b.s('timber'), -m.hw, deck - 1.2, -m.hd, m.hw, deck, m.hd, PUN.timber, { bottom: false });
      box(b.s('timber'), -m.hw, deck, -m.hd, m.hw, deck + 1.6, -m.hd + 0.5, PUN.timberDark, { bottom: false });
      if (detail >= 1) {
        // The raking ramp up the landward face, which is how the 4,000 got up there.
        for (let i = 0; i < 8; i++) {
          const y = (deck * i) / 8;
          box(b.s('timber'), -m.hw - 16 + i * 2.1, y - 0.3, -m.hd - 5,
            -m.hw - 14 + i * 2.1, y, m.hd + 5, PUN.timber, { bottom: false });
        }
      }
      break;
    }
    case 'warehouse': {
      const h = 7.2;
      box(st, -m.hw, -0.4, -m.hd, m.hw, 1.2, m.hd, PUN.sandstone, { bottom: false, groundShade: 0.2 });
      box(b.s('stucco'), -m.hw, 1.2, -m.hd, m.hw, h, m.hd, PUN.renderWorn, { bottom: false });
      const rs = b.s('roof');
      const sub = b.pushAllTranslate(['roof'], 0, h, 0);
      gableRoof(rs, rs, m.hw * 2, m.hd * 2, 0, 3.0, 0.7, PUN.tile, m.hw >= m.hd);
      b.popAll(sub);
      if (detail >= 2) {
        const n = Math.max(4, Math.round(m.hw / 7));
        for (let i = 0; i < n; i++) {
          const px = -m.hw + ((i + 0.5) * m.hw * 2) / n;
          box(b.s('timber'), px - 1.8, 1.2, -m.hd - 0.1, px + 1.8, 5.0, -m.hd + 0.4,
            PUN.timberDark, { bottom: false });
        }
      }
      break;
    }
    default:
      break;
  }
  b.popAll(streams);
}

export function buildMonuments(heightAt: (x: number, z: number) => number): MonumentOutput {
  const chunks: CityChunkSpec[] = [];
  const footprints: { x: number; z: number; hw: number; hd: number; rot: number }[] = [];
  const trees: TreeRequest[] = [];

  for (const m of MONUMENTS) {
    // The Byrsa and the two harbours build themselves; they are listed in `MONUMENTS` only
    // so that the ways and the fabric keep out of them.
    if (m.kind === 'byrsa' || m.kind === 'cothon' || m.kind === 'harbour') continue;
    const y = heightAt(m.x, m.z);
    chunks.push({
      name: `carthage-${m.id}`,
      cx: m.x,
      cz: m.z,
      radius: Math.hypot(m.hw, m.hd) + 14,
      castShadow: true,
      lodSwitch: [340, 1100],
      farMaterial: 'stone',
      build: (b, detail) => {
        b.setUvOrigin(m.x, 0, m.z);
        buildMonument(m, b, detail, y);
      },
    });
    if (m.solid) footprints.push({ x: m.x, z: m.z, hw: m.hw, hd: m.hd, rot: m.rot });
    // Planting round the forum and the tophet: both were, and it breaks the paving up.
    if (m.kind === 'forum' || m.kind === 'tophet') {
      for (let i = 0; i < 8; i++) {
        const h = hash2(i, Math.round(m.x), 0x66);
        trees.push({
          x: m.x + (h - 0.5) * m.hw * 2.1,
          z: m.z + (hash2(i, Math.round(m.z), 0x67) > 0.5 ? 1 : -1) * (m.hd + 7),
          kind: 'cypress',
          scale: 0.85 + h * 0.4,
        });
      }
    }
  }

  return { chunks, trees, footprints };
}
