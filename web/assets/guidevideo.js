// Records the exact guide video of one walkthrough shot: the model drawn as clay along the camera
// path, frame by frame, encoded in the browser (WebCodecs, H.264 where the browser has it, else VP9
// which the server converts). The AI films the shot on top of this, so the camera and the building
// come from the architect's model, not from the AI's imagination.
import { Muxer, ArrayBufferTarget } from "../vendor/mp4-muxer/mp4-muxer.mjs";

export const GUIDE_SIZES = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [960, 960] };
export const GUIDE_FPS = 24;
const CODECS = [["avc1.640028", "avc"], ["avc1.4d0028", "avc"], ["avc1.42E028", "avc"], ["vp09.00.40.08", "vp9"]];

export function canRecord() { return typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function"; }

async function codecFor(w, h) {
  for (const [codec, kind] of CODECS) {
    const config = { codec, width: w, height: h, bitrate: 6_000_000, framerate: GUIDE_FPS, ...(kind === "avc" ? { avc: { format: "avc" } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, kind }; } catch { /* try the next */ }
  }
  return null;
}

/**
 * viewer: the 3D viewer; poses: the shot's camera poses; seconds: its length; format: "16:9" etc.
 * Returns { blob, first } where first is the first frame's stills { clay, lines } as data URLs.
 */
export async function recordShot(viewer, poses, seconds, format, { onProgress, signal } = {}) {
  const [w, h] = GUIDE_SIZES[format];
  const chosen = await codecFor(w, h);
  if (!chosen) throw new Error("This browser cannot record the shot. Use Chrome or Edge on a computer, or Safari 17 or newer.");
  const first = viewer.guides(w, h, ["clay", "lines"], viewer.along(poses, 0));
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: chosen.kind, width: w, height: h, frameRate: GUIDE_FPS }, fastStart: "in-memory" });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  enc.configure(chosen.config);
  const n = Math.max(2, Math.round(seconds * GUIDE_FPS));
  viewer.beginGuide("clay", w, h);
  try {
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (failure) throw failure;
      const canvas = viewer.guideFrame(viewer.along(poses, i / (n - 1)));
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / GUIDE_FPS), duration: Math.round(1e6 / GUIDE_FPS) });
      enc.encode(frame, { keyFrame: i % (GUIDE_FPS * 2) === 0 });
      frame.close();
      if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
      if (i % 6 === 0) { onProgress?.(i / n); await new Promise(r => setTimeout(r, 0)); }
    }
    await enc.flush();
  } finally {
    viewer.endGuide();
    if (enc.state !== "closed") enc.close();
  }
  if (failure) throw failure;
  muxer.finalize();
  onProgress?.(1);
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), first, width: w, height: h };
}
