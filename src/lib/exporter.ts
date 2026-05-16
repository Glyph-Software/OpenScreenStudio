// Offline export pipeline: step the recording frame-by-frame, composite each
// frame with the shared compositor (so the result is pixel-identical to the
// editor preview), and hand PNG frames to the Rust ffmpeg sidecar for
// encoding. See lib/compositor and src-tauri export_* commands.

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  native,
  type CaptureArtifact,
  type CursorSidecar,
  type ExportFormat,
  type ExportPreset,
} from "./native";
import type { ZoomSegment } from "./autoZoom";
import {
  computeFrameLayout,
  makeCursorRenderState,
  rasterizeGlyphs,
  renderFrame,
  type CropRect,
} from "./compositor";

export type ExportResolution = "720" | "1080" | "4k";
export type ExportTarget = "file" | "clipboard";

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
  // Render is the dominant cost: ~per-frame compositing relative to 720p area.
  const areaFactor = (o.width * o.height) / (1280 * 720);
  const seconds = dur * o.fps * areaFactor * 0.012 + 2;
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
  const objectUrls: string[] = [];
  const video = document.createElement("video");
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

    sessionId = await native.exportBegin(
      dims.w,
      dims.h,
      p.fps,
      p.format,
      p.preset,
    );

    const canvas = document.createElement("canvas");
    canvas.width = dims.w;
    canvas.height = dims.h;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create 2D canvas context");

    const cursorState = makeCursorRenderState();
    const dtSec = 1 / p.fps;

    for (let i = 0; i < totalFrames; i++) {
      if (p.signal.aborted) {
        await native.exportCancel(sessionId);
        return { ok: false, canceled: true };
      }
      const t = Math.min(end - 1e-3, start + i / p.fps);
      await seekVideo(video, t);
      renderFrame(ctx, {
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
      });
      const png = await canvasToPng(canvas);
      await native.exportFrame(sessionId, i, png);
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
          0.9 + (ev.done / ev.total) * 0.1,
          "Encoding video",
        );
      }
    });

    const audioSrc = p.format === "mp4" ? p.artifact.path : null;
    const finalPath = await native.exportFinish(
      sessionId,
      outPath,
      audioSrc,
      start,
      end,
    );

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
    video.removeAttribute("src");
    video.load();
    for (const u of objectUrls) URL.revokeObjectURL(u);
  }
}
