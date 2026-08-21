/**
 * The browser half of `tools/menu-plates.mjs`.
 *
 * There is no ffmpeg on this machine — Playwright's bundled build carries `libvpx` (VP8) and
 * nothing else, which is why the trailer shipped at VP8 until `trailer-encode.mjs` found the
 * encoders Chromium already has. This is the same trick at a tenth of the size: JPEG frames
 * over a local HTTP server -> `createImageBitmap` -> a canvas that does the downscale *and*
 * the loop dissolve -> `VideoFrame` -> `VideoEncoder` (VP9) -> `webm-muxer` -> POST back.
 *
 * The dissolve is the only non-obvious part and it is what makes `<video loop>` seamless with
 * one element and no runtime JavaScript. Given a capture of `L` frames and a dissolve of `D`:
 *
 *     out[i] = lerp(src[L - D + i], src[i], i / D)     for i < D
 *     out[i] = src[i]                                  for D <= i < L - D
 *
 * The output is `L - D` frames long. Its last frame is `src[L-D-1]` and its first is
 * `src[L-D]`, which are consecutive frames of the capture — so the wrap is not a cut at all,
 * and the visible dissolve at the head of every loop is the tail of the crane melting into
 * its own beginning. Rails in `menu-plates.shot.mjs` are written to travel only a fifth of
 * the way they want to, precisely so those two framings are close enough for that to vanish.
 */
import { Muxer, ArrayBufferTarget } from '/webm-muxer.mjs';

const log = (m) => navigator.sendBeacon('/log', String(m));

const bitmap = async (i) => createImageBitmap(await (await fetch(`/f/${i}`)).blob());

window.__probe = async (cands) => {
  const out = [];
  for (const c of cands) {
    try {
      const r = await VideoEncoder.isConfigSupported(c);
      out.push({ codec: c.codec, supported: !!r.supported });
    } catch (e) { out.push({ codec: c.codec, supported: false, err: String(e).slice(0, 120) }); }
  }
  return out;
};

/**
 * @param {{n:number,dissolve:number,w:number,h:number,fps:number,codec:string,
 *          bitrate:number,gop:number}} o
 */
window.__encode = async (o) => {
  const { n, dissolve: D, w, h, fps, codec, bitrate, gop } = o;
  const outN = n - D;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: codec.startsWith('av01') ? 'V_AV1' : 'V_VP9', width: w, height: h, frameRate: fps },
    firstTimestampBehavior: 'offset',
  });

  let chunks = 0; let keys = 0; let vbytes = 0; let err = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      chunks++; if (chunk.type === 'key') keys++; vbytes += chunk.byteLength;
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => { err = String(e); },
  });
  encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' });

  const t0 = performance.now();
  for (let i = 0; i < outN && !err; i++) {
    if (i < D) {
      // The wrap. Tail underneath at full strength, head painted over it with a rising alpha.
      const tail = await bitmap(n - D + i);
      ctx.globalAlpha = 1;
      ctx.drawImage(tail, 0, 0, w, h);
      tail.close();
      const head = await bitmap(i);
      ctx.globalAlpha = i / D;
      ctx.drawImage(head, 0, 0, w, h);
      head.close();
      ctx.globalAlpha = 1;
    } else {
      const b = await bitmap(i);
      ctx.drawImage(b, 0, 0, w, h);
      b.close();
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % gop === 0 });
    frame.close();
    if (i % 60 === 0) log(`frame ${i}/${outN}`);
    // Keep the encoder queue bounded, or a 300-frame run holds 300 decoded bitmaps.
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  if (err) return { err };

  const buf = muxer.target.buffer;
  const secs = (performance.now() - t0) / 1000;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
  a.download = 'plate.webm';
  document.body.appendChild(a);
  a.click();
  return {
    bytes: buf.byteLength, vbytes, chunks, keys, outN,
    secs, fps: outN / secs,
    kbps: (vbytes * 8) / (outN / fps) / 1000,
  };
};

window.__ready = true;
