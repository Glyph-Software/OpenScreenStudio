// Offline export pipeline: step the recording frame-by-frame, composite each
// frame with the shared compositor (so the result is pixel-identical to the
// editor preview), and hand PNG frames to the Rust ffmpeg sidecar for
// encoding. See lib/compositor and src-tauri export_* commands.

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  native,
  type AudioTrackSpec,
  type CaptureArtifact,
  type CursorSidecar,
  type ExportFormat,
  type ExportPreset,
} from "./native";
import type { ZoomSegment } from "./autoZoom";
import {
  cameraAt,
  computeFrameLayout,
  makeCursorRenderState,
  rasterizeGlyphs,
  renderFrame,
  type CameraKeyframe,
  type CropRect,
  type RenderFrameOpts,
} from "./compositor";
import { GLCompositor, rasterizeGlyphsGL } from "./compositorGL";

export type ExportResolution = "720" | "1080" | "4k";
export type ExportTarget = "file" | "clipboard";

/**
 * One sidecar audio track with its editor state, as handed to the exporter.
 * Trims are timeline seconds (same convention as the clip trim: `trimStart`
 * cuts the head, `trimEnd` cuts from the end of the full recording).
 */
export type ExportAudioTrack = {
  path: string;
  muted: boolean;
  gain: number;
  trimStart: number;
  trimEnd: number;
};

/** The camera sidecar movie plus its bubble placement, for compositing. */
export type ExportCameraTrack = {
  path: string;
  /** Camera start relative to the screen recording start (ms). */
  offsetMs: number;
  enabled: boolean;
  pos: { x: number; y: number };
  size: number;
  shape: "circle" | "rounded";
  mirrored: boolean;
  /** Position/size keyframes (timeline seconds); empty = static placement. */
  keyframes: CameraKeyframe[];
};

const RES_HEIGHT: Record<ExportResolution, number> = {
  "720": 720,
  "1080": 1080,
  "4k": 2160,
};

const even = (n: number) => 2 * Math.round(n / 2);

/** Output pixel dimensions for a resolution choice given the frame layout. */
export function resolveOutputDims(
  ratio: number,
  resolution: ExportResolution,
): { w: number; h: number } {
  const h = even(RES_HEIGHT[resolution]);
  const w = even(Math.round(h * ratio));
  return { w: Math.max(2, w), h: Math.max(2, h) };
}

// Rough Mbps by format/preset/height — only drives the on-screen estimate.
const MP4_MBPS: Record<ExportPreset, [number, number, number]> = {
  // [720p, 1080p, 4k]
  studio: [8, 16, 50],
  social: [5, 10, 32],
  web: [2.5, 5, 18],
  weblow: [1, 2, 8],
};

export function estimateExport(o: {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  format: ExportFormat;
  preset: ExportPreset;
}): { seconds: number; bytes: number } {
  const dur = Math.max(0.1, o.durationSec);
  let bytes: number;
  if (o.format === "gif") {
    // GIF size scales with pixels × frames; ~0.6 bytes/px/frame after palette.
    bytes = o.width * o.height * o.fps * dur * 0.6;
  } else {
    const tier = o.height <= 720 ? 0 : o.height <= 1080 ? 1 : 2;
    const mbps = MP4_MBPS[o.preset][tier];
    bytes = (mbps * 1e6 * dur) / 8;
  }
  // Render dominates. GPU compositing + hardware encode brought the per-frame
  // cost down ~4x vs the old Canvas2D + libx264 pipeline (seek time floors it).
  const areaFactor = (o.width * o.height) / (1280 * 720);
  const seconds = dur * o.fps * areaFactor * 0.003 + 2;
  return { seconds, bytes };
}

export function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)}KB`;
  return `${Math.round(b)}B`;
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const anyV = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const onSeeked = () => {
      if (typeof anyV.requestVideoFrameCallback === "function") {
        anyV.requestVideoFrameCallback(() => finish());
        // Safety: rVFC won't fire while paused on some platforms.
        setTimeout(finish, 60);
      } else {
        finish();
      }
    };
    v.addEventListener("seeked", onSeeked, { once: true });
    try {
      v.currentTime = t;
    } catch {
      finish();
    }
  });
}

function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, "image/png");
  });
}

export type ExportParams = {
  artifact: CaptureArtifact;
  videoDurationSec: number;
  videoNaturalSize: { w: number; h: number };
  aspectRatio: number;
  isSystem: boolean;
  wallpaper: string;
  blur: number;
  padding: number;
  cropRect: CropRect | null;
  cursorSidecar: CursorSidecar | null;
  zoomSegments: ZoomSegment[];
  zoomEnabled: boolean;
  /** 0..1 (zoomSettings.smoothing / 100). */
  smoothing: number;
  trimStart: number;
  trimEnd: number;
  /**
   * Sidecar audio tracks to mix into the export. Empty when the recording
   * has none — the mp4's own soundtrack is used as a fallback then.
   */
  audioTracks: ExportAudioTrack[];
  /** Camera bubble to composite, or null when absent/hidden. */
  camera: ExportCameraTrack | null;
  /** Live editor viewport box, so export geometry matches the preview. */
  viewportBox: { w: number; h: number };
  resolution: ExportResolution;
  fps: number;
  format: ExportFormat;
  preset: ExportPreset;
  target: ExportTarget;
  onProgress: (frac: number, label: string) => void;
  signal: AbortSignal;
};

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

// Drawing an asset-protocol resource onto a canvas taints it in WKWebView, so
// canvas.toBlob() then throws "The operation is insecure". Fetch the file into
// a same-origin blob: URL first — the canvas stays clean.
async function fileObjectUrl(path: string): Promise<string> {
  const res = await fetch(convertFileSrc(path));
  if (!res.ok) throw new Error(`Failed to read ${path}`);
  return URL.createObjectURL(await res.blob());
}

function loadWallpaperImg(
  objectUrl: string | null,
): Promise<HTMLImageElement | null> {
  if (!objectUrl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = objectUrl;
  });
}

export async function exportVideo(
  p: ExportParams,
): Promise<ExportResult> {
  let sessionId: string | null = null;
  let unlistenProgress: (() => void) | null = null;
  let glc: GLCompositor | null = null;
  const objectUrls: string[] = [];
  const video = document.createElement("video");
  const cameraVideo = document.createElement("video");
  try {
    const layout = computeFrameLayout({
      aspectRatio: p.aspectRatio,
      isSystem: p.isSystem,
      videoNaturalSize: p.videoNaturalSize,
      cropRect: p.cropRect,
      padding: p.padding,
      box: p.viewportBox,
    });
    const dims = resolveOutputDims(layout.ratio, p.resolution);
    const s = dims.h / layout.h;

    const videoUrl = await fileObjectUrl(p.artifact.path);
    objectUrls.push(videoUrl);
    video.muted = true;
    video.preload = "auto";
    (video as HTMLVideoElement).playsInline = true;
    video.src = videoUrl;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), {
        once: true,
      });
      video.addEventListener(
        "error",
        () => reject(new Error("Failed to load recording for export")),
        { once: true },
      );
    });

    // Camera sidecar: a second offscreen video, seeked in lockstep with the
    // main one (shifted by the recorded start offset).
    const cam = p.camera && p.camera.enabled ? p.camera : null;
    let cameraDur = 0;
    if (cam) {
      const camUrl = await fileObjectUrl(cam.path);
      objectUrls.push(camUrl);
      cameraVideo.muted = true;
      cameraVideo.preload = "auto";
      cameraVideo.playsInline = true;
      cameraVideo.src = camUrl;
      await new Promise<void>((resolve, reject) => {
        cameraVideo.addEventListener("loadedmetadata", () => resolve(), { once: true });
        cameraVideo.addEventListener(
          "error",
          () => reject(new Error("Failed to load camera recording for export")),
          { once: true },
        );
      });
      cameraDur = isFinite(cameraVideo.duration) ? cameraVideo.duration : 0;
    }

    let wallpaperUrl: string | null = null;
    if (p.wallpaper.startsWith("/")) {
      wallpaperUrl = await fileObjectUrl(p.wallpaper);
      objectUrls.push(wallpaperUrl);
    }
    const [glyphImages, wallpaperImg] = await Promise.all([
      rasterizeGlyphs(),
      loadWallpaperImg(wallpaperUrl),
    ]);

    const start = Math.max(0, p.trimStart);
    const end = Math.max(start, p.videoDurationSec - p.trimEnd);
    const durSec = Math.max(1 / p.fps, end - start);
    const totalFrames = Math.max(1, Math.round(durSec * p.fps));

    // GPU path: composite on WebGL2 and (for mp4) stream raw RGBA frames
    // straight into the hardware encoder — no per-frame PNG round-trip.
    // Falls back to the Canvas2D + PNG pipeline when WebGL2 is unavailable.
    const glCanvas = document.createElement("canvas");
    glCanvas.width = dims.w;
    glCanvas.height = dims.h;
    glc = GLCompositor.create(glCanvas);
    if (glc) {
      try {
        glc.setGlyphs(await rasterizeGlyphsGL());
      } catch {
        glc.dispose();
        glc = null;
      }
    }
    let ctx: CanvasRenderingContext2D | null = null;
    let canvas2d: HTMLCanvasElement | null = null;
    const ensure2d = () => {
      if (ctx) return ctx;
      canvas2d = document.createElement("canvas");
      canvas2d.width = dims.w;
      canvas2d.height = dims.h;
      ctx = canvas2d.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Could not create 2D canvas context");
      return ctx;
    };
    if (!glc) ensure2d();

    let raw = !!glc && p.format === "mp4";
    sessionId = await native.exportBegin(
      dims.w,
      dims.h,
      p.fps,
      p.format,
      p.preset,
      raw,
    );

    const cursorState = makeCursorRenderState();
    const dtSec = 1 / p.fps;
    let rawBuf: Uint8Array | undefined;

    for (let i = 0; i < totalFrames; i++) {
      if (p.signal.aborted) {
        await native.exportCancel(sessionId);
        return { ok: false, canceled: true };
      }
      const t = Math.min(end - 1e-3, start + i / p.fps);
      await seekVideo(video, t);
      if (cam) {
        const camT = Math.max(
          0,
          Math.min(Math.max(0, cameraDur - 1e-3), t - cam.offsetMs / 1000),
        );
        await seekVideo(cameraVideo, camT);
      }
      const frameOpts: RenderFrameOpts = {
        layout,
        s,
        outW: dims.w,
        outH: dims.h,
        videoSource: video,
        videoNaturalSize: p.videoNaturalSize,
        wallpaper: p.wallpaper,
        wallpaperImg,
        blur: p.blur,
        cropRect: p.cropRect,
        cursorSidecar: p.cursorSidecar,
        zoomSegments: p.zoomSegments,
        zoomEnabled: p.zoomEnabled,
        smoothing: p.smoothing,
        timeMs: t * 1000,
        glyphImages,
        cursorState,
        dtSec,
        camera: cam
          ? (() => {
              // Keyframed bubble motion, evaluated at the absolute timeline
              // time — identical to the editor preview.
              const eff = cameraAt(cam, t);
              return {
                source: cameraVideo,
                naturalSize: {
                  w: cameraVideo.videoWidth || 1280,
                  h: cameraVideo.videoHeight || 720,
                },
                pos: eff.pos,
                size: eff.size,
                shape: cam.shape,
                mirrored: cam.mirrored,
              };
            })()
          : null,
      };

      if (glc) {
        try {
          glc.render(frameOpts);
        } catch (err) {
          // A cross-origin texture or driver failure surfaces on the first
          // frame — fall back to the Canvas2D + PNG pipeline. Later failures
          // are real errors (frames already streamed in raw mode).
          if (i > 0) throw err;
          glc.dispose();
          glc = null;
          if (raw) {
            await native.exportCancel(sessionId);
            raw = false;
            sessionId = await native.exportBegin(
              dims.w,
              dims.h,
              p.fps,
              p.format,
              p.preset,
              false,
            );
          }
        }
      }
      let bytes: Uint8Array;
      if (glc) {
        if (raw) {
          rawBuf = glc.readPixels(rawBuf);
          bytes = rawBuf;
        } else {
          bytes = await canvasToPng(glCanvas);
        }
      } else {
        renderFrame(ensure2d(), frameOpts);
        bytes = await canvasToPng(canvas2d!);
      }
      await native.exportFrame(sessionId, i, bytes);
      p.onProgress((i + 1) / totalFrames * 0.9, "Rendering frames");
    }

    // Pick a destination (File) or let Rust write to a temp file (Clipboard).
    let outPath = "";
    if (p.target === "file") {
      const ext = p.format === "gif" ? "gif" : "mp4";
      const base =
        p.artifact.path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, "") || "Untitled";
      const chosen = await native.pickExportPath(`${base}.${ext}`, ext);
      if (!chosen) {
        await native.exportCancel(sessionId);
        return { ok: false, canceled: true };
      }
      outPath = chosen;
    }

    unlistenProgress = await native.onExportProgress((ev) => {
      if (ev.total > 0) {
        p.onProgress(
          Math.min(1, 0.9 + (ev.done / ev.total) * 0.1),
          "Encoding video",
        );
      }
    });

    // Map each audible track onto the exported window: read [srcStart,
    // srcEnd] from the file and place it at `delay` seconds into the output.
    // Track t=0 equals video t=0 by construction (the Rust side aligns the
    // WAVs to the first video frame), so source and timeline times coincide.
    let audioSpecs: AudioTrackSpec[] = [];
    if (p.format === "mp4") {
      const tracks: ExportAudioTrack[] =
        p.audioTracks.length > 0
          ? p.audioTracks
          : [
              // No sidecar tracks (old recording / dev fixture): fall back to
              // the mp4's embedded soundtrack, preserving prior behavior.
              { path: p.artifact.path, muted: false, gain: 1, trimStart: 0, trimEnd: 0 },
            ];
      audioSpecs = tracks
        .filter((t) => !t.muted && t.gain > 0.001)
        .map((t) => {
          const s0 = Math.max(start, t.trimStart);
          const s1 = Math.min(end, p.videoDurationSec - t.trimEnd);
          if (s1 - s0 < 0.01) return null;
          return {
            path: t.path,
            srcStart: s0,
            srcEnd: s1,
            delay: s0 - start,
            gain: t.gain,
          };
        })
        .filter((t): t is AudioTrackSpec => t !== null);
    }

    const finalPath = await native.exportFinish(sessionId, outPath, audioSpecs);

    if (p.target === "clipboard") {
      await native.copyFileToClipboard(finalPath);
    }
    p.onProgress(1, "Done");
    return { ok: true, path: finalPath };
  } catch (e) {
    if (sessionId) {
      try {
        await native.exportCancel(sessionId);
      } catch {
        /* best effort */
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (unlistenProgress) unlistenProgress();
    glc?.dispose({ loseContext: true });
    video.removeAttribute("src");
    video.load();
    cameraVideo.removeAttribute("src");
    cameraVideo.load();
    for (const u of objectUrls) URL.revokeObjectURL(u);
  }
}
