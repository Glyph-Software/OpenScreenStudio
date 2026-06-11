// Pure, DOM-free compositor shared by the editor preview and the offline
// exporter. The in-editor preview is built from CSS transforms; the exporter
// must bake the *same* visual result into pixels frame-by-frame. To guarantee
// the preview and the export can never drift, the geometry/zoom/cursor math
// lives here once and is consumed by both.

import type { CursorSidecar, CursorSidecarShapeName } from "./native";
import {
  activeSegmentAt,
  resolveZoom,
  type ZoomSegment,
} from "./autoZoom";

export type CropRect = { x: number; y: number; w: number; h: number };

/** `var(--radius-lg)` — the rounded-corner radius of the recorded window. */
export const RADIUS_LG = 12;

// The preview reserves chrome around the viewport before sizing the canvas
// frame (see Editor `Canvas`). Kept here so the exporter reproduces the exact
// same layout from the same viewport box.
export const VIEWPORT_MARGIN_W = 80;
export const VIEWPORT_MARGIN_H = 110;

// ---------------------------------------------------------------------------
// Cursor glyphs (moved here from the editor so preview + export share one set)
// ---------------------------------------------------------------------------

export type Glyph = { svg: string; hot: [number, number] };

export const ARROW_GLYPH: Glyph = {
  svg: '<path d="M4 2 L4 18 L8 14 L11 20.5 L13.6 19.4 L10.6 13 L16 13 Z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>',
  hot: [4 / 24, 2 / 24],
};
export const CURSOR_GLYPHS: Partial<Record<CursorSidecarShapeName, Glyph>> = {
  arrow: ARROW_GLYPH,
  pointer: {
    svg: '<path d="M10 9V4.2c0-0.9 0.7-1.6 1.6-1.6s1.6 0.7 1.6 1.6V9.4 M13.2 10V8.4c0-0.8 0.7-1.5 1.5-1.5s1.5 0.7 1.5 1.5V11 M16.2 11.2v-1c0-0.8 0.6-1.4 1.4-1.4s1.4 0.6 1.4 1.4V16c0 2.6-1.9 4.8-4.6 4.8h-2.1c-1.4 0-2.7-0.6-3.6-1.7l-3.1-3.8c-0.5-0.7-0.4-1.6 0.3-2.1 0.6-0.5 1.5-0.4 2.1 0.2L10 15V6.2c0-0.9 0.7-1.6 1.6-1.6" fill="#000" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>',
    hot: [11 / 24, 2.6 / 24],
  },
  text: {
    svg: '<path d="M8.5 3.5h7M8.5 20.5h7M12 3.5v17" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round"/><path d="M8.5 3.5h7M8.5 20.5h7M12 3.5v17" stroke="#000" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    hot: [0.5, 0.5],
  },
};
CURSOR_GLYPHS.verticalText = CURSOR_GLYPHS.text;

export function glyphFor(shape: CursorSidecarShapeName): Glyph {
  return CURSOR_GLYPHS[shape] ?? ARROW_GLYPH;
}

/**
 * Interpolated cursor position (in sidecar reference coords) at `tMs`.
 * Linear-interpolates between the two bracketing samples. Clamps to the
 * first/last sample outside the captured range. Null when no samples.
 */
export function cursorPosAt(
  sc: CursorSidecar,
  tMs: number,
): { x: number; y: number } | null {
  const s = sc.samples;
  if (s.length === 0) return null;
  if (tMs <= s[0].tMs) return { x: s[0].x, y: s[0].y };
  const last = s[s.length - 1];
  if (tMs >= last.tMs) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const span = b.tMs - a.tMs;
  const f = span > 0 ? (tMs - a.tMs) / span : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Cursor shape in effect at `tMs` (last transition with tMs ≤ t). */
export function cursorShapeAt(
  sc: CursorSidecar,
  tMs: number,
): CursorSidecarShapeName {
  const cs = sc.cursorShapes;
  if (!cs || cs.length === 0) return "arrow";
  if (tMs <= cs[0].tMs) return cs[0].shape;
  let lo = 0;
  let hi = cs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }
  return cs[hi].tMs <= tMs ? cs[hi].shape : cs[lo].shape;
}

// ---------------------------------------------------------------------------
// Frame layout — exact mirror of the editor `Canvas` sizing math
// ---------------------------------------------------------------------------

export type FrameLayout = {
  /** Canvas-frame size in layout px. */
  w: number;
  h: number;
  ratio: number;
  padding: number;
  /** Inner content box (frame minus padding on all sides). */
  innerW: number;
  innerH: number;
  /** Recorded-window (video) box, centered inside the inner box. */
  wrapW: number;
  wrapH: number;
  wrapX: number;
  wrapY: number;
};

export function computeFrameLayout(opts: {
  aspectRatio: number;
  isSystem: boolean;
  videoNaturalSize: { w: number; h: number } | null;
  cropRect: CropRect | null;
  padding: number;
  box: { w: number; h: number };
}): FrameLayout {
  const { aspectRatio, isSystem, videoNaturalSize, cropRect, padding, box } =
    opts;
  const rawVideoAR =
    videoNaturalSize && videoNaturalSize.h > 0
      ? videoNaturalSize.w / videoNaturalSize.h
      : null;
  const videoAR =
    rawVideoAR && cropRect && cropRect.h > 0
      ? rawVideoAR * (cropRect.w / cropRect.h)
      : rawVideoAR;

  const maxW = box.w - VIEWPORT_MARGIN_W;
  const maxH = box.h - VIEWPORT_MARGIN_H;

  let w: number;
  let h: number;
  let ratio: number;
  if (isSystem && videoAR) {
    const availW = Math.max(1, maxW - 2 * padding);
    const availH = Math.max(1, maxH - 2 * padding);
    let videoW = availW;
    let videoH = availW / videoAR;
    if (videoH > availH) {
      videoH = availH;
      videoW = availH * videoAR;
    }
    w = videoW + 2 * padding;
    h = videoH + 2 * padding;
    ratio = w / h;
  } else {
    ratio = isSystem ? videoAR ?? 16 / 9 : aspectRatio;
    w = maxW;
    h = maxW / ratio;
    if (h > maxH) {
      h = maxH;
      w = maxH * ratio;
    }
  }

  const innerW = Math.max(1, w - 2 * padding);
  const innerH = Math.max(1, h - 2 * padding);
  let wrapW = innerW;
  let wrapH = innerH;
  if (videoAR) {
    let bw = innerW;
    let bh = innerW / videoAR;
    if (bh > innerH) {
      bh = innerH;
      bw = innerH * videoAR;
    }
    wrapW = bw;
    wrapH = bh;
  }
  const wrapX = padding + (innerW - wrapW) / 2;
  const wrapY = padding + (innerH - wrapH) / 2;

  return { w, h, ratio, padding, innerW, innerH, wrapW, wrapH, wrapX, wrapY };
}

// ---------------------------------------------------------------------------
// Zoom transform — exact mirror of the editor `Canvas` `apply()` clamp math
// ---------------------------------------------------------------------------

export type ZoomTransform = { tx: number; ty: number; scale: number };

const IDENTITY_ZOOM: ZoomTransform = { tx: 0, ty: 0, scale: 1 };

/**
 * Resolve the wrap transform at `tMs`. Returns the identity transform when
 * zoom is off / no segment is active — identical to the preview's early-outs.
 * `wrapW/wrapH` are the *untransformed* wrap box (layout px); `videoW/videoH`
 * are the natural video pixel dimensions.
 */
export function computeZoomTransform(opts: {
  tMs: number;
  zoomEnabled: boolean;
  zoomSegments: ZoomSegment[];
  cursorSidecar: CursorSidecar | null;
  smoothing: number;
  wrapW: number;
  wrapH: number;
  videoW: number;
  videoH: number;
}): ZoomTransform {
  const {
    tMs,
    zoomEnabled,
    zoomSegments,
    cursorSidecar,
    smoothing,
    wrapW,
    wrapH,
    videoW,
    videoH,
  } = opts;
  if (!zoomEnabled || zoomSegments.length === 0 || !cursorSidecar) {
    return IDENTITY_ZOOM;
  }
  const { scale, focal } = resolveZoom(
    tMs,
    zoomSegments,
    cursorSidecar,
    smoothing,
  );
  if (scale <= 1.001) return IDENTITY_ZOOM;

  const activeSeg = activeSegmentAt(tMs, zoomSegments);
  const snapPct = Math.max(
    0,
    Math.min(100, activeSeg?.snapToEdges ?? 0),
  );
  const vw = videoW || wrapW;
  const vh = videoH || wrapH;
  const fit = Math.min(wrapW / vw, wrapH / vh);
  const displayedW = vw * fit;
  const displayedH = vh * fit;
  const offsetX = (wrapW - displayedW) / 2;
  const offsetY = (wrapH - displayedH) / 2;
  const crop = cursorSidecar.crop;
  const refW = crop ? crop.width : cursorSidecar.display.width;
  const refH = crop ? crop.height : cursorSidecar.display.height;
  const rawPx = offsetX + (focal.x / Math.max(1, refW)) * displayedW;
  const rawPy = offsetY + (focal.y / Math.max(1, refH)) * displayedH;
  const halfVisibleW = wrapW / (2 * scale);
  const halfVisibleH = wrapH / (2 * scale);
  const peakScale = activeSeg?.targetLevel ?? scale;
  const zoomProgress =
    peakScale > 1
      ? Math.max(0, Math.min(1, (scale - 1) / (peakScale - 1)))
      : 0;
  const relax = (snapPct / 100) * zoomProgress;
  const minPx = offsetX + halfVisibleW * (1 - relax);
  const maxPx = offsetX + displayedW - halfVisibleW * (1 - relax);
  const minPy = offsetY + halfVisibleH * (1 - relax);
  const maxPy = offsetY + displayedH - halfVisibleH * (1 - relax);
  const px =
    minPx <= maxPx
      ? Math.min(maxPx, Math.max(minPx, rawPx))
      : offsetX + displayedW / 2;
  const py =
    minPy <= maxPy
      ? Math.min(maxPy, Math.max(minPy, rawPy))
      : offsetY + displayedH / 2;
  const tx = wrapW / 2 - px * scale;
  const ty = wrapH / 2 - py * scale;
  return { tx, ty, scale };
}

// ---------------------------------------------------------------------------
// Wallpaper — canvas reproduction of the `.wp-*` CSS gradients
// ---------------------------------------------------------------------------

type GradStop = [number, string];
type WallpaperDef =
  | { kind: "linear"; angle: number; stops: GradStop[] }
  | { kind: "radial"; cx: number; cy: number; stops: GradStop[] };

// Mirrors src/styles/globals.css `.wp-1`..`.wp-17`. Keep in sync if those change.
const L = (angle: number, stops: GradStop[]): WallpaperDef => ({
  kind: "linear",
  angle,
  stops,
});
const R = (cx: number, cy: number, stops: GradStop[]): WallpaperDef => ({
  kind: "radial",
  cx,
  cy,
  stops,
});
export const WALLPAPER_DEFS: Record<string, WallpaperDef> = {
  "wp-1": L(135, [
    [0, "#ff8c5a"],
    [0.6, "#ff5a3c"],
    [1, "#d4321a"],
  ]),
  "wp-2": L(135, [
    [0, "#ffae5a"],
    [1, "#ff5e3a"],
  ]),
  "wp-3": L(135, [
    [0, "#c84020"],
    [1, "#5a1a0a"],
  ]),
  "wp-4": R(0.3, 0.3, [
    [0, "#5cd6c4"],
    [0.6, "#3a8aa8"],
    [1, "#2a4a8a"],
  ]),
  "wp-5": L(135, [
    [0, "#d8e8c4"],
    [0.5, "#b8d4a4"],
    [1, "#5aa8c8"],
  ]),
  "wp-6": L(135, [
    [0, "#ff5a8c"],
    [0.5, "#ff8a3a"],
    [1, "#4ad8a8"],
  ]),
  "wp-7": L(135, [
    [0, "#ff5a3c"],
    [1, "#d4321a"],
  ]),
  "wp-8": L(135, [
    [0, "#ff8a4a"],
    [0.6, "#ff5a8a"],
    [1, "#ff3aa0"],
  ]),
  "wp-9": L(135, [
    [0, "#c4d8ff"],
    [1, "#8ab8ff"],
  ]),
  "wp-10": R(0.5, 0.5, [
    [0, "#c45aff"],
    [0.6, "#5a3aa8"],
    [1, "#3a1a8a"],
  ]),
  "wp-11": L(135, [
    [0, "#ff5a8c"],
    [0.5, "#c43aa8"],
    [1, "#4a3aa8"],
  ]),
  "wp-12": L(135, [
    [0, "#5aa8c4"],
    [1, "#4a3a8a"],
  ]),
  "wp-13": L(135, [
    [0, "#d4d8e4"],
    [1, "#a4a8c4"],
  ]),
  "wp-14": L(135, [
    [0, "#b89ad4"],
    [1, "#6a4ad4"],
  ]),
  "wp-15": L(135, [
    [0, "#8a5af0"],
    [1, "#5a3ad8"],
  ]),
  "wp-16": L(135, [
    [0, "#5a3aa8"],
    [0.6, "#3a1a6a"],
    [1, "#2a1a4a"],
  ]),
  "wp-17": L(135, [
    [0, "#ff5aa0"],
    [1, "#c43a8a"],
  ]),
};

export const isWallpaperImage = (wp: string) => wp.startsWith("/");

function paintWallpaper(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  wallpaper: string,
  wallpaperImg: CanvasImageSource | null,
) {
  if (isWallpaperImage(wallpaper)) {
    if (wallpaperImg) {
      const iw = (wallpaperImg as HTMLImageElement).naturalWidth || w;
      const ih = (wallpaperImg as HTMLImageElement).naturalHeight || h;
      const cover = Math.max(w / iw, h / ih);
      const dw = iw * cover;
      const dh = ih * cover;
      ctx.drawImage(wallpaperImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(x, y, w, h);
    }
    // CSS overlays a flat 15% black wash on image wallpapers.
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(x, y, w, h);
    return;
  }
  const def = WALLPAPER_DEFS[wallpaper] ?? WALLPAPER_DEFS["wp-7"];
  let grad: CanvasGradient;
  if (def.kind === "linear") {
    // CSS `linear-gradient(<angle>deg, ...)`: 0deg points up, clockwise; the
    // gradient line is sized so the box corners touch its perpendiculars.
    const rad = (def.angle * Math.PI) / 180;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const len =
      Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const dx = (Math.sin(rad) * len) / 2;
    const dy = (-Math.cos(rad) * len) / 2;
    grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  } else {
    const r = Math.max(w, h) * 0.75;
    grad = ctx.createRadialGradient(
      x + def.cx * w,
      y + def.cy * h,
      0,
      x + def.cx * w,
      y + def.cy * h,
      r,
    );
  }
  for (const [off, color] of def.stops) grad.addColorStop(off, color);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
}

/**
 * Rasterize the wallpaper layer (gradient/image + blur + inset bleed) into an
 * offscreen 2D canvas. The layer is static for a given (wallpaper, blur,
 * output size), so GPU paths bake it once and re-draw it as a texture.
 */
export function renderWallpaperToCanvas(o: {
  layoutW: number;
  layoutH: number;
  s: number;
  outW: number;
  outH: number;
  wallpaper: string;
  wallpaperImg: CanvasImageSource | null;
  blur: number;
}): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(o.outW));
  c.height = Math.max(1, Math.round(o.outH));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Could not create wallpaper canvas context");
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, c.width, c.height);
  ctx.clip();
  if (o.blur > 0) ctx.filter = `blur(${o.blur * 0.18 * o.s}px)`;
  const ins = o.blur > 0 ? o.blur * 0.3 + 4 : 0;
  paintWallpaper(
    ctx,
    -ins * o.s,
    -ins * o.s,
    (o.layoutW + 2 * ins) * o.s,
    (o.layoutH + 2 * ins) * o.s,
    o.wallpaper,
    o.wallpaperImg,
  );
  ctx.restore();
  return c;
}

// ---------------------------------------------------------------------------
// renderFrame — composite one frame, mirroring the preview DOM stack
// ---------------------------------------------------------------------------

/** Mutable cursor smoothing state, owned by the caller across frames. */
export type CursorRenderState = {
  sx: number;
  sy: number;
  has: boolean;
  lastTMs: number;
};

export function makeCursorRenderState(): CursorRenderState {
  return { sx: 0, sy: 0, has: false, lastTMs: 0 };
}

const SMOOTH_TAU = 0.06; // seconds; matches the editor preview

// Zoom motion blur. Engages whenever the zoom transform moves between frames:
// the zoom-in / zoom-out scale animation AND any positional change while
// zoomed in (the view panning to follow the cursor at a held zoom level).
// Frames where the transform is truly static (no zoom, or zoomed but not
// moving) take the single-pass path and are bit-identical to before. The
// video layer is re-sampled along the transform curve across the trailing
// shutter interval and averaged, smearing both scale and pan at the edges.
const ZOOM_BLUR_MAX_SAMPLES = 24;
// 1.0 = a full frame interval ("360° shutter"): each frame's trail ends where
// the next begins, so fast pans read as one continuous smear with no gap.
const ZOOM_BLUR_SHUTTER = 1.0;
// Roughly one sample per this many output px of motion (smaller ⇒ denser ⇒
// smoother gradient, no visible ghost steps), clamped to MAX_SAMPLES.
const ZOOM_BLUR_PX_PER_SAMPLE = 3;

/** A camera position/size keyframe. `t` is timeline seconds. */
export type CameraKeyframe = {
  t: number;
  pos: { x: number; y: number };
  size: number;
};

/**
 * Evaluate the camera bubble's position/size at time `tSec`. With no
 * keyframes the static base pos/size applies; otherwise the value eases
 * (smoothstep) between surrounding keyframes and clamps at the ends.
 * Shared by the editor preview and the exporter so motion is identical.
 */
export function cameraAt(
  cam: { pos: { x: number; y: number }; size: number; keyframes?: CameraKeyframe[] },
  tSec: number,
): { pos: { x: number; y: number }; size: number } {
  const kfs = cam.keyframes ?? [];
  if (kfs.length === 0) return { pos: cam.pos, size: cam.size };
  if (tSec <= kfs[0].t) return { pos: kfs[0].pos, size: kfs[0].size };
  const last = kfs[kfs.length - 1];
  if (tSec >= last.t) return { pos: last.pos, size: last.size };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (tSec >= a.t && tSec <= b.t) {
      const span = Math.max(1e-6, b.t - a.t);
      let f = (tSec - a.t) / span;
      f = f * f * (3 - 2 * f); // smoothstep ease-in-out
      return {
        pos: {
          x: a.pos.x + (b.pos.x - a.pos.x) * f,
          y: a.pos.y + (b.pos.y - a.pos.y) * f,
        },
        size: a.size + (b.size - a.size) * f,
      };
    }
  }
  return { pos: last.pos, size: last.size };
}

/**
 * Camera bubble parameters for one composited frame. The bubble lives in
 * frame space (not video space): it must NOT inherit the zoom transform —
 * the bubble stays put while the screen content zooms underneath it.
 */
export type CameraRenderOpts = {
  source: CanvasImageSource;
  naturalSize: { w: number; h: number };
  /** Bubble center, normalized 0..1 over the output frame. */
  pos: { x: number; y: number };
  /** Bubble edge as a fraction of the output frame width (square box). */
  size: number;
  shape: "circle" | "rounded";
  mirrored: boolean;
};

export type RenderFrameOpts = {
  layout: FrameLayout;
  /** Output px per layout px (= outputHeight / layout.h). */
  s: number;
  outW: number;
  outH: number;
  videoSource: CanvasImageSource;
  videoNaturalSize: { w: number; h: number };
  wallpaper: string;
  wallpaperImg: CanvasImageSource | null;
  blur: number;
  cropRect: CropRect | null;
  cursorSidecar: CursorSidecar | null;
  zoomSegments: ZoomSegment[];
  zoomEnabled: boolean;
  smoothing: number;
  timeMs: number;
  /** Pre-rasterized cursor glyphs keyed by shape. */
  glyphImages: Map<CursorSidecarShapeName, CanvasImageSource>;
  cursorState: CursorRenderState;
  /** Fixed timestep for cursor low-pass (1/fps). */
  dtSec: number;
  /** Camera bubble; omitted/null when no camera track or it's hidden. */
  camera?: CameraRenderOpts | null;
};

/** Crop source rect (video px) + object-fit:contain dest rect (layout px). */
export type VideoPlacement = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dX: number;
  dY: number;
  dW: number;
  dH: number;
};

export function computeVideoPlacement(o: {
  layout: FrameLayout;
  videoNaturalSize: { w: number; h: number };
  cropRect: CropRect | null;
}): VideoPlacement {
  const vnW = o.videoNaturalSize.w;
  const vnH = o.videoNaturalSize.h;
  let sx = 0;
  let sy = 0;
  let sw = vnW;
  let sh = vnH;
  if (o.cropRect) {
    sx = o.cropRect.x * vnW;
    sy = o.cropRect.y * vnH;
    sw = o.cropRect.w * vnW;
    sh = o.cropRect.h * vnH;
  }
  const srcAR = sw / sh;
  const wrapAR = o.layout.wrapW / o.layout.wrapH;
  let dW = o.layout.wrapW;
  let dH = o.layout.wrapH;
  if (srcAR > wrapAR) dH = o.layout.wrapW / srcAR;
  else dW = o.layout.wrapH * srcAR;
  const dX = (o.layout.wrapW - dW) / 2;
  const dY = (o.layout.wrapH - dH) / 2;
  return { sx, sy, sw, sh, dX, dY, dW, dH };
}

/** Resolve the zoom transform at `tMs` for one frame's options. */
export function zoomTransformAt(o: RenderFrameOpts, tMs: number): ZoomTransform {
  return computeZoomTransform({
    tMs,
    zoomEnabled: o.zoomEnabled,
    zoomSegments: o.zoomSegments,
    cursorSidecar: o.cursorSidecar,
    smoothing: o.smoothing,
    wrapW: o.layout.wrapW,
    wrapH: o.layout.wrapH,
    videoW: o.videoNaturalSize.w,
    videoH: o.videoNaturalSize.h,
  });
}

/**
 * Plan the video layer passes for one frame: a single sharp pass while the
 * zoom transform is static, or N samples along the trailing shutter interval
 * (each with the incremental-average alpha) while it is moving. Shared by
 * the Canvas2D and WebGL compositors so motion blur is identical.
 */
export function computeVideoPasses(
  o: RenderFrameOpts,
): Array<{ zt: ZoomTransform; alpha: number }> {
  const ztEnd = zoomTransformAt(o, o.timeMs);
  const dtMs = o.dtSec * 1000;
  const ztStart = dtMs > 0 ? zoomTransformAt(o, o.timeMs - dtMs) : ztEnd;
  const dScale = Math.abs(ztEnd.scale - ztStart.scale);
  const dShiftPx =
    Math.max(Math.abs(ztEnd.tx - ztStart.tx), Math.abs(ztEnd.ty - ztStart.ty)) *
    o.s;
  const moving = dtMs > 0 && (dScale > 0.002 || dShiftPx > 0.5);
  if (!moving) return [{ zt: ztEnd, alpha: 1 }];
  const motionPx =
    dShiftPx + dScale * Math.max(o.layout.wrapW, o.layout.wrapH) * o.s;
  const samples = Math.max(
    2,
    Math.min(
      ZOOM_BLUR_MAX_SAMPLES,
      Math.ceil(motionPx / ZOOM_BLUR_PX_PER_SAMPLE),
    ),
  );
  const passes: Array<{ zt: ZoomTransform; alpha: number }> = [];
  for (let i = 0; i < samples; i++) {
    const f = i / (samples - 1);
    const tMs = o.timeMs - dtMs * ZOOM_BLUR_SHUTTER * (1 - f);
    // Incremental running average ⇒ each sample ends weighted 1/samples.
    passes.push({ zt: zoomTransformAt(o, tMs), alpha: 1 / (i + 1) });
  }
  return passes;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  o: RenderFrameOpts,
) {
  const { layout, s, outW, outH } = o;
  ctx.save();
  ctx.clearRect(0, 0, outW, outH);

  // 1. Wallpaper background (clipped to the frame, blurred + inset bleed).
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, outW, outH);
  ctx.clip();
  if (o.blur > 0) ctx.filter = `blur(${o.blur * 0.18 * s}px)`;
  const ins = o.blur > 0 ? o.blur * 0.3 + 4 : 0;
  paintWallpaper(
    ctx,
    -ins * s,
    -ins * s,
    (layout.w + 2 * ins) * s,
    (layout.h + 2 * ins) * s,
    o.wallpaper,
    o.wallpaperImg,
  );
  ctx.restore();

  // 2. Recorded window: translate to wrap origin, apply the zoom transform,
  //    clip to the rounded rect. Cursor is drawn in the same transformed
  //    space (it is a child of the wrap in the preview DOM).
  // Video crop sub-rect + object-fit: contain placement (zoom-independent).
  const { sx, sy, sw, sh, dX, dY, dW, dH } = computeVideoPlacement(o);

  const rw = layout.wrapW * s;
  const rh = layout.wrapH * s;
  const rr = Math.min(RADIUS_LG * s, rw / 2, rh / 2);
  // Apply `zt`, clip to the rounded rect, run `body` in that space.
  const inZoomSpace = (zt: ZoomTransform, body: () => void) => {
    ctx.save();
    ctx.translate(layout.wrapX * s, layout.wrapY * s);
    ctx.translate(zt.tx * s, zt.ty * s);
    ctx.scale(zt.scale, zt.scale);
    ctx.beginPath();
    ctx.moveTo(rr, 0);
    ctx.arcTo(rw, 0, rw, rh, rr);
    ctx.arcTo(rw, rh, 0, rh, rr);
    ctx.arcTo(0, rh, 0, 0, rr);
    ctx.arcTo(0, 0, rw, 0, rr);
    ctx.closePath();
    ctx.clip();
    body();
    ctx.restore();
  };
  const paintVideo = (zt: ZoomTransform, alpha: number) =>
    inZoomSpace(zt, () => {
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.drawImage(
        o.videoSource,
        sx,
        sy,
        sw,
        sh,
        dX * s,
        dY * s,
        dW * s,
        dH * s,
      );
    });

  // 2a. Video frame. Average several samples along the zoom curve while the
  //     transform is moving; otherwise a single sharp pass.
  for (const pass of computeVideoPasses(o)) paintVideo(pass.zt, pass.alpha);

  // 2b. Synthetic cursor — kept sharp, drawn once at the final transform
  //     (its low-pass state must advance exactly one step per frame).
  if (o.cursorSidecar) {
    inZoomSpace(zoomTransformAt(o, o.timeMs), () => drawCursor(ctx, o, s));
  }

  // 3. Camera bubble — topmost, in plain output (frame) space so it is
  //    unaffected by the zoom transform. Mirrors the preview overlay DOM.
  if (o.camera) {
    drawCamera(ctx, o.camera, outW, outH, s);
  }
  ctx.restore();
}

function cameraBoxPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  box: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + box, y, x + box, y + box, r);
  ctx.arcTo(x + box, y + box, x, y + box, r);
  ctx.arcTo(x, y + box, x, y, r);
  ctx.arcTo(x, y, x + box, y, r);
  ctx.closePath();
}

function drawCamera(
  ctx: CanvasRenderingContext2D,
  cam: CameraRenderOpts,
  outW: number,
  outH: number,
  s: number,
) {
  const box = cam.size * outW;
  if (box < 2) return;
  const x = cam.pos.x * outW - box / 2;
  const y = cam.pos.y * outH - box / 2;
  // Keep in sync with the .camera-overlay CSS (50% vs 18% corner radius).
  const r = cam.shape === "circle" ? box / 2 : box * 0.18;

  // Drop shadow: fill the bubble path once with shadow enabled; the video
  // painted next fully covers the fill.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 18 * s;
  ctx.shadowOffsetY = 6 * s;
  cameraBoxPath(ctx, x, y, box, r);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  ctx.save();
  cameraBoxPath(ctx, x, y, box, r);
  ctx.clip();
  // object-fit: cover into the square box.
  const vw = Math.max(1, cam.naturalSize.w);
  const vh = Math.max(1, cam.naturalSize.h);
  const scale = Math.max(box / vw, box / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = x + (box - dw) / 2;
  const dy = y + (box - dh) / 2;
  if (cam.mirrored) {
    ctx.translate(x + box / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(x + box / 2), 0);
  }
  ctx.drawImage(cam.source, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * Cursor glyph placement for one frame, in zoom-space layout px. Advances the
 * caller's low-pass smoothing state exactly one step — call once per frame.
 * Null when the cursor is absent or outside the (cropped) frame.
 */
export type CursorSprite = {
  /** Smoothed hotspot position (layout px, zoom space). */
  x: number;
  y: number;
  /** Glyph box edge (layout px). */
  size: number;
  shape: CursorSidecarShapeName;
  hot: [number, number];
};

export function computeCursorSprite(o: RenderFrameOpts): CursorSprite | null {
  if (!o.cursorSidecar) {
    o.cursorState.has = false;
    return null;
  }
  const sc = o.cursorSidecar;
  const tMs = o.timeMs;
  const pos = cursorPosAt(sc, tMs);
  if (!pos) {
    o.cursorState.has = false;
    return null;
  }
  const wrapW = o.layout.wrapW;
  const wrapH = o.layout.wrapH;
  const vw = o.videoNaturalSize.w || wrapW;
  const vh = o.videoNaturalSize.h || wrapH;
  const fit = Math.min(wrapW / vw, wrapH / vh);
  const crop = sc.crop;
  const refW = crop ? crop.width : sc.display.width;
  const refH = crop ? crop.height : sc.display.height;
  let nx = pos.x / Math.max(1, refW);
  let ny = pos.y / Math.max(1, refH);
  let dW = vw * fit;
  let dH = vh * fit;
  let oX = (wrapW - dW) / 2;
  let oY = (wrapH - dH) / 2;
  if (o.cropRect) {
    nx = (nx - o.cropRect.x) / o.cropRect.w;
    ny = (ny - o.cropRect.y) / o.cropRect.h;
    dW = wrapW;
    dH = wrapH;
    oX = 0;
    oY = 0;
  }
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    o.cursorState.has = false;
    return null;
  }
  const px = oX + nx * dW;
  const py = oY + ny * dH;
  const st = o.cursorState;
  const jumped = Math.abs(tMs - st.lastTMs) > 120;
  st.lastTMs = tMs;
  if (!st.has || jumped || o.dtSec <= 0) {
    st.sx = px;
    st.sy = py;
    st.has = true;
  } else {
    const alpha = 1 - Math.exp(-o.dtSec / SMOOTH_TAU);
    st.sx += (px - st.sx) * alpha;
    st.sy += (py - st.sy) * alpha;
  }
  const refUnitsAcross = refW * (o.cropRect ? o.cropRect.w : 1);
  const pxPerRefUnit = dW / Math.max(1, refUnitsAcross);
  const size = Math.max(14, Math.min(64, 24 * pxPerRefUnit));
  const shape = cursorShapeAt(sc, tMs);
  return { x: st.sx, y: st.sy, size, shape, hot: glyphFor(shape).hot };
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  o: RenderFrameOpts,
  s: number,
) {
  const spr = computeCursorSprite(o);
  if (!spr) return;
  const img = o.glyphImages.get(spr.shape) ?? o.glyphImages.get("arrow");
  if (!img) return;
  const drawX = (spr.x - spr.hot[0] * spr.size) * s;
  const drawY = (spr.y - spr.hot[1] * spr.size) * s;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 2 * s;
  ctx.shadowOffsetY = 1 * s;
  ctx.drawImage(img, drawX, drawY, spr.size * s, spr.size * s);
  ctx.restore();
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to rasterize cursor glyph"));
    // WKWebView can't decode SVG via createImageBitmap(blob); a data-URL
    // <img> with explicit width/height works and stays crisp.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Rasterize all cursor glyphs once, before an export run. The 24×24 viewBox
 * is drawn onto an offscreen canvas at `px` so it scales crisply.
 */
export async function rasterizeGlyphs(
  px = 96,
): Promise<Map<CursorSidecarShapeName, CanvasImageSource>> {
  const out = new Map<CursorSidecarShapeName, CanvasImageSource>();
  const shapes = Object.keys(CURSOR_GLYPHS) as CursorSidecarShapeName[];
  if (!shapes.includes("arrow")) shapes.push("arrow");
  for (const shape of shapes) {
    const g = glyphFor(shape);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${px}" height="${px}" style="overflow:visible">${g.svg}</svg>`;
    const img = await loadSvgImage(svg);
    const c = document.createElement("canvas");
    c.width = px;
    c.height = px;
    const cx = c.getContext("2d");
    if (!cx) throw new Error("Could not create glyph canvas context");
    cx.drawImage(img, 0, 0, px, px);
    out.set(shape, c);
  }
  return out;
}
