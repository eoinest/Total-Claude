import * as THREE from 'three';

/**
 * Shared asset cache.
 *
 * Several subsystems want the same files — terrain and the city both need limestone
 * and travertine, units and city both need worn iron. Without a cache each loads its
 * own copy of a 2K texture set, which triples VRAM for no benefit. Everything goes
 * through here so a given URL is fetched, decoded and uploaded exactly once.
 *
 * Every accessor is failure-tolerant on purpose: the game must run with an empty
 * `public/assets/` folder, falling back to procedural substitutes. A missing texture
 * is a downgrade, never a crash.
 */

export interface TextureMaps {
  albedo: string | null;
  normal: string | null;
  roughness: string | null;
  ao: string | null;
  displacement: string | null;
}

export interface TextureEntry {
  id: string;
  name: string;
  author: string;
  license: string;
  maps: TextureMaps;
  resolutionPx?: number;
  tiling?: number;
}

export interface HdriEntry {
  id: string;
  name: string;
  path: string;
  author: string;
  license: string;
  timeOfDay?: string;
  weather?: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  path: string;
  author: string;
  license: string;
  [k: string]: unknown;
}

export interface AssetManifest {
  hdris: HdriEntry[];
  textures: TextureEntry[];
  models: ModelEntry[];
}

const EMPTY: AssetManifest = { hdris: [], textures: [], models: [] };

/** Which maps must be treated as colour data rather than linear data. */
const SRGB_MAPS = new Set(['albedo']);

export class Assets {
  private static _manifest: Promise<AssetManifest> | null = null;
  private static textures = new Map<string, Promise<THREE.Texture | null>>();
  private static loader = new THREE.TextureLoader();
  private static missing = new Set<string>();

  /** Fetch and cache the manifest. Resolves to an empty manifest if absent. */
  static manifest(): Promise<AssetManifest> {
    if (!this._manifest) {
      this._manifest = fetch('/assets/manifest.json')
        .then((r) => (r.ok ? r.json() : EMPTY))
        .then((m: Partial<AssetManifest>) => ({
          hdris: m.hdris ?? [],
          textures: m.textures ?? [],
          models: m.models ?? [],
        }))
        .catch(() => {
          console.info('[Assets] no manifest found — using procedural substitutes');
          return EMPTY;
        });
    }
    return this._manifest;
  }

  static async texturesById(): Promise<Map<string, TextureEntry>> {
    const m = await this.manifest();
    return new Map(m.textures.map((t) => [t.id, t]));
  }

  static async hdriById(id: string): Promise<HdriEntry | undefined> {
    const m = await this.manifest();
    return m.hdris.find((h) => h.id === id);
  }

  static async modelsMatching(prefix: string): Promise<ModelEntry[]> {
    const m = await this.manifest();
    return m.models.filter((x) => x.id.startsWith(prefix));
  }

  /**
   * Load a single texture with the right colour space and wrapping.
   * Returns null (once, with one log line) if the file is unavailable.
   */
  static texture(
    url: string | null | undefined,
    opts: { srgb?: boolean; repeat?: number; anisotropy?: number } = {}
  ): Promise<THREE.Texture | null> {
    if (!url) return Promise.resolve(null);
    const key = `${url}|${opts.srgb ? 's' : 'l'}|${opts.repeat ?? 1}`;
    let p = this.textures.get(key);
    if (p) return p;

    p = new Promise<THREE.Texture | null>((resolve) => {
      this.loader.load(
        url,
        (tex) => {
          tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          if (opts.repeat) tex.repeat.setScalar(opts.repeat);
          tex.anisotropy = opts.anisotropy ?? 8;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          resolve(tex);
        },
        undefined,
        () => {
          if (!this.missing.has(url)) {
            this.missing.add(url);
            console.info(`[Assets] missing "${url}" — falling back`);
          }
          resolve(null);
        }
      );
    });
    this.textures.set(key, p);
    return p;
  }

  /**
   * Load a full PBR set by manifest id. Any individual map may come back null;
   * callers should build their material from whatever is present.
   */
  static async materialSet(
    id: string,
    opts: { repeat?: number; anisotropy?: number } = {}
  ): Promise<Partial<Record<keyof TextureMaps, THREE.Texture | null>> & { entry?: TextureEntry }> {
    const byId = await this.texturesById();
    const entry = byId.get(id);
    if (!entry) return {};
    const keys = Object.keys(entry.maps) as (keyof TextureMaps)[];
    const loaded = await Promise.all(
      keys.map((k) => this.texture(entry.maps[k], { srgb: SRGB_MAPS.has(k), ...opts }))
    );
    const out: Partial<Record<keyof TextureMaps, THREE.Texture | null>> & { entry?: TextureEntry } = { entry };
    keys.forEach((k, i) => { out[k] = loaded[i]; });
    return out;
  }

  /** Release everything. Call on teardown. */
  static dispose(): void {
    for (const p of this.textures.values()) {
      p.then((t) => t?.dispose()).catch(() => {});
    }
    this.textures.clear();
    this.missing.clear();
    this._manifest = null;
  }

  /** Attribution lines for the credits screen — every CC-BY asset must appear here. */
  static async attributions(): Promise<string[]> {
    const m = await this.manifest();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of [...m.hdris, ...m.textures, ...m.models]) {
      const line = `${a.name} — ${a.author} (${a.license})`;
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
    return out.sort();
  }
}
