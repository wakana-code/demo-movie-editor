// File: js/exporter.js.js
'use strict';

const CODEC_CANDIDATES = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pickEncoderConfig(width, height) {
  for (const codec of CODEC_CANDIDATES) {
    const config = { codec, width, height, bitrate: 10_000_000, framerate: FPS };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch (_) {
      // 次の候補を試す
    }
  }
  return null;
}

async function exportMp4(project, { onProgress, signal } = {}) {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('このブラウザは動画の書き出しに対応していません。Google Chrome で開いてください。');
  }
  if (typeof Mp4Muxer === 'undefined') {
    throw new Error('mp4-muxer を読み込めませんでした。インターネット接続を確認してください。');
  }

  const { w, h } = SIZES[project.size] || SIZES['16:9'];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const tl = buildTimeline(project, ctx);

  const config = await pickEncoderConfig(w, h);
  if (!config) throw new Error('H.264 エンコーダーが見つかりませんでした。');

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h },
    fastStart: 'in-memory',
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure(config);

  const total = tl.totalFrames;
  const frameDuration = 1e6 / FPS;

  try {
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new DOMException('中止しました', 'AbortError');
      if (encodeError) throw encodeError;

      renderFrame(ctx, tl, i / FPS);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDuration),
        duration: Math.round(frameDuration),
      });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();

      while (encoder.encodeQueueSize > 6) await sleep(2);
      if (i % 5 === 0) {
        if (onProgress) onProgress(i / total);
        await sleep(0);
      }
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  if (encodeError) throw encodeError;
  muxer.finalize();
  if (onProgress) onProgress(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}