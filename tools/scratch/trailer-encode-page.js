/**
 * The page half of `trailer-encode.mjs`. Served to a Playwright Chromium, which is the only
 * VP9/AV1/Opus encoder on this machine (Playwright's bundled ffmpeg is VP8-only and has no
 * audio codec at all). Frames arrive over the local server as JPEG, go out as an encoded
 * WebM with an Opus track. Its own file, not a template literal in the driver, because every
 * `${...}` in a driver-side template is interpolated by Node before the browser ever sees it.
 */
import { Muxer, ArrayBufferTarget } from '/webm-muxer.mjs';

const log = (s) => fetch('/log', { method: 'POST', body: s });

window.__probe = async (cands) => {
  const out = [];
  for (const c of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported(c);
      out.push({ codec: c.codec, supported: !!r.supported });
    } catch (e) { out.push({ codec: c.codec, supported: false, err: String(e) }); }
  }
  return out;
};

/** Opus, from the PCM the mixdown wrote. Raw packets, for the muxer. */
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
  if (!sup.supported) throw new Error('opus config unsupported');
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
  let audio = null;
  if (cfg.audioBytes) {
    const ab = await (await fetch('/pcm')).arrayBuffer();
    audio = await encodeAudio(ab, cfg.rate, cfg.channels, cfg.abitrate);
    let ab2 = 0; for (const c of audio.chunks) ab2 += c.data.length;
    await log('opus: ' + audio.chunks.length + ' packets, ' + ab2 + ' bytes, desc '
      + (audio.desc ? audio.desc.length + ' B' : 'none'));
  }
  const mkv = cfg.codec.indexOf('av01') === 0 ? 'V_AV1'
    : cfg.codec.indexOf('vp09') === 0 ? 'V_VP9' : 'V_VP8';
  const opts = {
    target: new ArrayBufferTarget(),
    video: { codec: mkv, width: cfg.w, height: cfg.h, frameRate: cfg.fps },
  };
  if (audio) opts.audio = { codec: 'A_OPUS', numberOfChannels: cfg.channels, sampleRate: cfg.rate };
  const muxer = new Muxer(opts);

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

  // A small read-ahead, so JPEG decode and video encode overlap instead of taking turns.
  const AHEAD = 4;
  const grab = async (i) => createImageBitmap(await (await fetch('/f/' + i)).blob());
  const pending = new Map();
  for (let i = 0; i < Math.min(AHEAD, cfg.n); i++) pending.set(i, grab(i));
  for (let i = 0; i < cfg.n; i++) {
    const bmp = await pending.get(i);
    pending.delete(i);
    if (i + AHEAD < cfg.n) pending.set(i + AHEAD, grab(i + AHEAD));
    const vf = new VideoFrame(bmp, {
      timestamp: Math.round((i * 1e6) / cfg.fps), duration: Math.round(1e6 / cfg.fps),
    });
    enc.encode(vf, { keyFrame: i % cfg.gop === 0 });
    vf.close(); bmp.close();
    while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 3));
    if (i % 120 === 0) {
      const el = (performance.now() - t0) / 1000;
      await log('frame ' + i + '/' + cfg.n + '  ' + ((i + 1) / el).toFixed(1) + ' fps  '
        + (vbytes / 1e6).toFixed(1) + ' MB so far  eta '
        + (((cfg.n - i) / ((i + 1) / el)) / 60).toFixed(1) + ' min');
    }
    if (errs.length) break;
  }
  await enc.flush(); enc.close();
  drainAudio(Infinity);
  if (errs.length) return { err: errs.join('; ') };
  muxer.finalize();
  const buf = muxer.target.buffer;
  const secs = (performance.now() - t0) / 1000;
  const res = { bytes: buf.byteLength, vbytes, vcount, keys, abytes: 0,
    apackets: audio ? audio.chunks.length : 0, secs, fps: cfg.n / secs };
  if (audio) for (const c of audio.chunks) res.abytes += c.data.length;
  /*
   * Hand the file back as a browser *download*, not as a POST.
   *
   * Posting 130 MB out of the page kills the driver: Playwright reads every CDP message as
   * one string, the request event carries the body, and a JSON-escaped 130 MB binary blows
   * past V8's 512 MB string ceiling — `ERR_STRING_TOO_LONG`, after a clean encode. A
   * download is written by the browser itself and Playwright streams it to disk.
   */
  if (cfg.write) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
    a.download = 'trailer.webm';
    document.body.appendChild(a);
    a.click();
  }
  return res;
};
window.__ready = true;
