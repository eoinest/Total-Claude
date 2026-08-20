/**
 * The page half of `trailer-tw-encode.mjs`. Its own file, not a template literal in the
 * driver, because every `${...}` in a driver-side template is interpolated by Node before the
 * browser ever sees it.
 *
 * Same shape as `trailer-encode-page.js` — WebCodecs `VideoEncoder` + `AudioEncoder` into
 * `webm-muxer`, because Playwright's bundled ffmpeg is VP8-only with no audio muxer — with
 * three differences that the smaller file needs:
 *
 *  1. **The frames are downscaled here, not by the encoder.** `VideoEncoder` will resample a
 *     frame that does not match its configured size, but by an unspecified filter. 1920 -> 1280
 *     is a 1.5x reduction, which is exactly the ratio where a plain bilinear tap drops every
 *     other column of a brick course, so it goes through a 2D context with
 *     `imageSmoothingQuality = 'high'` instead and the result is measured against a reference
 *     downscale afterwards rather than assumed.
 *  2. **Keyframes are forced at the cuts.** A hard cut is an intra frame whatever the encoder
 *     decides, so placing the GOP boundary there costs nothing and stops a P-frame being spent
 *     predicting one shot from another.
 *  3. **`--muxonly` returns only the byte count.** The bitrate ladder does not need six files
 *     on disk; it needs six numbers.
 */
import { Muxer, ArrayBufferTarget } from '/webm-muxer.mjs';

const log = (s) => fetch('/log', { method: 'POST', body: s });

window.__probe = async (vcands, acands) => {
  const out = { video: [], audio: [] };
  for (const c of vcands) {
    try {
      const r = await VideoEncoder.isConfigSupported(c);
      out.video.push({ codec: c.codec, supported: !!r.supported });
    } catch (e) { out.video.push({ codec: c.codec, supported: false, err: String(e) }); }
  }
  for (const c of acands) {
    try {
      const r = await AudioEncoder.isConfigSupported(c);
      out.audio.push({ codec: c.codec, supported: !!r.supported });
    } catch (e) { out.audio.push({ codec: c.codec, supported: false, err: String(e) }); }
  }
  return out;
};

/** Opus, from the PCM the cut wrote. Raw packets, for the muxer. */
async function encodeAudio(bytes, rate, channels, bitrate) {
  const data = new Float32Array(bytes);
  const frames = data.length / channels;
  const chunks = []; let desc = null; const errs = [];
  const enc = new AudioEncoder({
    output: (c, meta) => {
      const b = new Uint8Array(c.byteLength); c.copyTo(b);
      if (!desc && meta && meta.decoderConfig && meta.decoderConfig.description) {
        desc = new Uint8Array(meta.decoderConfig.description);
      }
      chunks.push({ data: b, ts: c.timestamp, dur: c.duration, type: c.type });
    },
    error: (e) => errs.push(String(e)),
  });
  const cfg = { codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate };
  const sup = await AudioEncoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error('opus config unsupported at ' + bitrate);
  enc.configure(cfg);
  const step = rate / 50;                                   // 20 ms: Opus' own frame size
  for (let off = 0; off < frames; off += step) {
    const n = Math.min(step, frames - off);
    enc.encode(new AudioData({
      format: 'f32', sampleRate: rate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((off / rate) * 1e6),
      data: data.subarray(off * channels, (off + n) * channels),
    }));
  }
  await enc.flush(); enc.close();
  if (errs.length) throw new Error(errs.join('; '));
  return { chunks, desc };
}

window.__encode = async (cfg) => {
  const t0 = performance.now();
  const errs = [];
  let audio = null, abytes = 0;
  if (cfg.audioBytes) {
    const ab = await (await fetch('/pcm')).arrayBuffer();
    audio = await encodeAudio(ab, cfg.rate, cfg.channels, cfg.abitrate);
    for (const c of audio.chunks) abytes += c.data.length;
    await log(`opus ${cfg.abitrate / 1000} kb/s: ${audio.chunks.length} packets, ${abytes} bytes, `
      + `desc ${audio.desc ? audio.desc.length + ' B' : 'none'}, `
      + `${((abytes * 8) / (cfg.n / cfg.fps) / 1000).toFixed(1)} kb/s actual`);
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'V_VP9', width: cfg.w, height: cfg.h, frameRate: cfg.fps },
    ...(audio ? { audio: { codec: 'A_OPUS', numberOfChannels: cfg.channels, sampleRate: cfg.rate } } : {}),
  });

  let ai = 0, vbytes = 0, vcount = 0, keys = 0;
  const drainAudio = (untilUs) => {
    while (audio && ai < audio.chunks.length && audio.chunks[ai].ts <= untilUs) {
      const c = audio.chunks[ai];
      const meta = ai === 0 && audio.desc ? { decoderConfig: { description: audio.desc } } : undefined;
      muxer.addAudioChunkRaw(c.data, c.type, c.ts, meta);
      ai++;
    }
  };
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      vbytes += chunk.byteLength; vcount++;
      if (chunk.type === 'key') keys++;
      drainAudio(chunk.timestamp);
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => errs.push(String(e)),
  });
  const vcfg = { codec: cfg.codec, width: cfg.w, height: cfg.h, framerate: cfg.fps,
    bitrate: cfg.bitrate, bitrateMode: 'variable', latencyMode: 'quality', alpha: 'discard' };
  const sup = await VideoEncoder.isConfigSupported(vcfg);
  if (!sup.supported) return { err: 'video config unsupported: ' + cfg.codec };
  enc.configure(vcfg);

  // One reused canvas: 654 OffscreenCanvases is 654 GPU surfaces for no reason.
  const canvas = new OffscreenCanvas(cfg.w, cfg.h);
  const g = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';

  const keySet = new Set(cfg.keyframesAt ?? [0]);
  // A small read-ahead, so JPEG decode and video encode overlap instead of taking turns.
  const AHEAD = 4;
  const grab = async (i) => createImageBitmap(await (await fetch('/f/' + i)).blob());
  const pending = new Map();
  for (let i = 0; i < Math.min(AHEAD, cfg.n); i++) pending.set(i, grab(i));
  for (let i = 0; i < cfg.n; i++) {
    const bmp = await pending.get(i);
    pending.delete(i);
    if (i + AHEAD < cfg.n) pending.set(i + AHEAD, grab(i + AHEAD));
    g.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, cfg.w, cfg.h);
    bmp.close();
    const vf = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / cfg.fps), duration: Math.round(1e6 / cfg.fps),
    });
    enc.encode(vf, { keyFrame: keySet.has(i) || i % cfg.gop === 0 });
    vf.close();
    while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 3));
    if (i % 120 === 0) {
      const el = (performance.now() - t0) / 1000;
      await log(`frame ${i}/${cfg.n}  ${((i + 1) / el).toFixed(1)} fps  `
        + `${(vbytes / 1e6).toFixed(2)} MB so far`);
    }
    if (errs.length) break;
  }
  await enc.flush(); enc.close();
  drainAudio(Infinity);
  if (errs.length) return { err: errs.join('; ') };
  muxer.finalize();
  const buf = muxer.target.buffer;
  const secs = (performance.now() - t0) / 1000;
  const res = { bytes: buf.byteLength, vbytes, abytes, vcount, keys,
    apackets: audio ? audio.chunks.length : 0, secs, fps: cfg.n / secs };
  if (cfg.write) {
    /*
     * Hand the file back as a browser *download*, not as a POST: Playwright reads every CDP
     * message as one string and a JSON-escaped binary body of any size is wasteful. This file
     * is under 5 MB so a POST would survive, but the download path is the one the 130 MB cut
     * proved and there is no reason to have two.
     */
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
    a.download = 'trailer-tw.webm';
    document.body.appendChild(a);
    a.click();
  }
  return res;
};
window.__ready = true;
