/**
 * The page half of `trailer-mp4-encode.mjs`. Its own file, not a template literal in the
 * driver, because every `${...}` in a driver-side template is interpolated by Node before the
 * browser ever sees it.
 *
 * This is `trailer-tw-encode-page.js` with the container and both codecs swapped: H.264 into
 * `mp4-muxer` instead of VP9 into `webm-muxer`, and AAC-LC instead of Opus, because X's upload
 * endpoint takes MP4 and MOV and will not take a WebM. Everything about the *picture* — the
 * 1920 -> 1280 downscale done here rather than by the encoder, the keyframes forced at the
 * cuts, the four-frame read-ahead, the one reused canvas — is deliberately unchanged, so that
 * the only difference between the two deliverables is the codec.
 *
 * Five things the swap needs that the WebM path did not:
 *
 *  1. **`avc: { format: 'avc' }` and `aac: { format: 'aac' }`.** WebCodecs will happily hand
 *     back Annex-B H.264 and ADTS-framed AAC, and both are wrong inside an MP4: the muxer
 *     wants length-prefixed NAL units and raw AAC frames with the setup in `avcC` / `esds`.
 *     Chromium's defaults are already these, but a default is not a guarantee and this file
 *     asks for them.
 *  2. **The real profile is read back out of `avcC`, not trusted from the codec string.**
 *     `isConfigSupported` can say yes to `avc1.64001f` and the encoder can still hand you
 *     Baseline if it fell back to the software path, and nothing downstream would notice. So
 *     bytes 1-3 of the decoder description — profile_idc, constraints, level_idc — are
 *     returned to the driver, which prints them.
 *  3. **Monotonic timestamps are asserted.** `mp4-muxer` is given presentation timestamps and
 *     no composition offsets, which is correct only while the encoder does not reorder. It
 *     does not today; if it ever does, this fails loudly instead of producing a file whose
 *     motion is subtly wrong.
 *  4. **AAC is fed in 1024-sample blocks**, which is the AAC-LC frame, where Opus wanted 960.
 *  5. **`fastStart: 'in-memory'`.** The whole file is in memory anyway, and an MP4 with its
 *     `moov` at the end is one an uploader has to buffer completely before it can do anything.
 */
import { Muxer, ArrayBufferTarget } from '/mp4-muxer.mjs';

const log = (s) => fetch('/log', { method: 'POST', body: s });

window.__probe = async (vcands, acands) => {
  const out = { video: [], audio: [] };
  for (const c of vcands) {
    try {
      const r = await VideoEncoder.isConfigSupported(c);
      out.video.push({ codec: c.codec, hw: c.hardwareAcceleration ?? 'no-preference',
        supported: !!r.supported, got: r.config ? r.config.codec : null });
    } catch (e) { out.video.push({ codec: c.codec, hw: c.hardwareAcceleration ?? 'no-preference', supported: false, err: String(e) }); }
  }
  for (const c of acands) {
    try {
      const r = await AudioEncoder.isConfigSupported(c);
      out.audio.push({ codec: c.codec, supported: !!r.supported });
    } catch (e) { out.audio.push({ codec: c.codec, supported: false, err: String(e) }); }
  }
  return out;
};

/**
 * AAC-LC, from the PCM the cut wrote. Raw frames, for the muxer.
 *
 * Two corrections live here that Opus in a WebM did not need.
 *
 * **Pre-roll.** AAC-LC's filterbank costs the encoder a frame or two of delay: what comes out
 * of a decoder at time t is what went in at t minus that delay. Opus carries its pre-skip in
 * the container and every WebM demuxer takes it off; an MP4 written from raw AAC frames has no
 * edit list, so the delay is simply left in and the sound plays late — measured at 44 ms on
 * this material, which is exactly where a viewer starts to be able to hear it. Dropping the
 * first packets is not the fix, because AAC frames overlap and the frame after a dropped one
 * decodes wrong. So the compensation is made in the PCM instead: the encoder is fed the
 * mixdown from sample `preroll` onward with `preroll` samples of silence appended, which lands
 * the decoded output back on the picture and costs only the first 43 ms of a battle ambience
 * that starts from nothing anyway.
 *
 * **Trim.** 1,052,800 samples is 1028.1 AAC frames, and the encoder pads that to whole frames
 * and adds its own, which makes the audio track 83 ms longer than the video and the file's
 * duration 22.02 s for a 21.93 s cut. Frames that start after the last picture frame are
 * dropped.
 */
async function encodeAudio(bytes, rate, channels, bitrate, preroll, maxUs) {
  const raw = new Float32Array(bytes);
  const frames = raw.length / channels;
  const data = new Float32Array(raw.length);
  for (let i = 0; i < frames - preroll; i++) {
    for (let c = 0; c < channels; c++) data[i * channels + c] = raw[(i + preroll) * channels + c];
  }
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
  const cfg = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: channels, bitrate,
    aac: { format: 'aac' } };
  const sup = await AudioEncoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error('aac config unsupported at ' + bitrate);
  enc.configure(cfg);
  const step = 1024;                                        // AAC-LC's own frame size
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
  const made = chunks.length;
  const kept = maxUs ? chunks.filter((c) => c.ts < maxUs) : chunks;
  return { chunks: kept, desc, made, dropped: made - kept.length,
    firstTs: kept.length ? kept[0].ts : null,
    lastTs: kept.length ? kept[kept.length - 1].ts : null };
}

window.__encode = async (cfg) => {
  const t0 = performance.now();
  const errs = [];
  let audio = null, abytes = 0;
  if (cfg.audioBytes) {
    const ab = await (await fetch('/pcm')).arrayBuffer();
    const maxUs = Math.round((cfg.n / cfg.fps) * 1e6);
    audio = await encodeAudio(ab, cfg.rate, cfg.channels, cfg.abitrate, cfg.apreroll ?? 0, maxUs);
    for (const c of audio.chunks) abytes += c.data.length;
    await log(`aac ${cfg.abitrate / 1000} kb/s: ${audio.chunks.length} frames kept of ${audio.made} `
      + `(${audio.dropped} past the last picture frame), ${abytes} bytes, `
      + `desc ${audio.desc ? [...audio.desc].map((b) => b.toString(16).padStart(2, '0')).join('') : 'none'}, `
      + `pre-roll ${cfg.apreroll ?? 0} samples, last ts ${audio.lastTs} us, `
      + `${((abytes * 8) / (cfg.n / cfg.fps) / 1000).toFixed(1)} kb/s actual`);
  }
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    video: { codec: 'avc', width: cfg.w, height: cfg.h, frameRate: cfg.fps },
    ...(audio ? { audio: { codec: 'aac', numberOfChannels: cfg.channels, sampleRate: cfg.rate } } : {}),
  });

  let ai = 0, vbytes = 0, vcount = 0, keys = 0, lastTs = -1, avcC = null, reordered = 0;
  const drainAudio = (untilUs) => {
    while (audio && ai < audio.chunks.length && audio.chunks[ai].ts <= untilUs) {
      const c = audio.chunks[ai];
      const meta = ai === 0 && audio.desc ? { decoderConfig: { description: audio.desc } } : undefined;
      muxer.addAudioChunkRaw(c.data, c.type, c.ts, c.dur ?? Math.round((1024 / cfg.rate) * 1e6), meta);
      ai++;
    }
  };
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      vbytes += chunk.byteLength; vcount++;
      if (chunk.type === 'key') keys++;
      if (chunk.timestamp <= lastTs) reordered++;
      lastTs = chunk.timestamp;
      if (!avcC && meta && meta.decoderConfig && meta.decoderConfig.description) {
        avcC = [...new Uint8Array(meta.decoderConfig.description)];
      }
      drainAudio(chunk.timestamp);
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => errs.push(String(e)),
  });
  const vcfg = { codec: cfg.codec, width: cfg.w, height: cfg.h, framerate: cfg.fps,
    bitrate: cfg.bitrate, bitrateMode: 'variable', latencyMode: 'quality', alpha: 'discard',
    avc: { format: 'avc' },
    ...(cfg.hw ? { hardwareAcceleration: cfg.hw } : {}) };
  const sup = await VideoEncoder.isConfigSupported(vcfg);
  if (!sup.supported) return { err: 'video config unsupported: ' + cfg.codec };
  enc.configure(vcfg);

  // One reused canvas: 658 OffscreenCanvases is 658 GPU surfaces for no reason.
  const canvas = new OffscreenCanvas(cfg.w, cfg.h);
  const g = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';

  const keySet = new Set(cfg.keyframesAt ?? [0]);
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
  if (reordered) return { err: `${reordered} video chunks came back out of order; this muxing `
    + 'path assumes presentation order and would produce wrong motion' };
  muxer.finalize();
  const buf = muxer.target.buffer;
  const secs = (performance.now() - t0) / 1000;
  const res = { bytes: buf.byteLength, vbytes, abytes, vcount, keys,
    apackets: audio ? audio.chunks.length : 0, secs, fps: cfg.n / secs, avcC,
    profile: avcC ? avcC[1] : null, constraints: avcC ? avcC[2] : null, level: avcC ? avcC[3] : null,
    audioFirstTs: audio ? audio.firstTs : null, audioLastTs: audio ? audio.lastTs : null,
    audioDropped: audio ? audio.dropped : null,
    audioDesc: audio && audio.desc ? [...audio.desc] : null };
  if (cfg.write) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
    a.download = 'trailer-tw.mp4';
    document.body.appendChild(a);
    a.click();
  }
  return res;
};
window.__ready = true;
