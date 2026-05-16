import type { CursorSidecar } from "./native";

export type ZoomEasing = "easeInOutCubic" | "easeOutCubic" | "linear";

export type ZoomSegment = {
  id: string;
  startMs: number;
  endMs: number;
  targetLevel: number;
  focal: { x: number; y: number };
  easing: ZoomEasing;
  source: "auto" | "manual";
  mode: "auto" | "manual";
  instant: boolean;
  disabled: boolean;
  snapToEdges: number;
};

export const DEFAULT_SNAP_TO_EDGES = 0;

export type AutoZoomOptions = {
  defaultLevel: number;
  leadInMs: number;
  holdMs: number;
  releaseMs: number;
  mergeGapMs: number;
};

export const DEFAULT_AUTO_ZOOM_OPTIONS: AutoZoomOptions = {
  defaultLevel: 1.8,
  leadInMs: 300,
  holdMs: 1500,
  releaseMs: 400,
  mergeGapMs: 500,
};

let segIdCounter = 0;
function nextSegId(): string {
  segIdCounter += 1;
  return `seg-${Date.now().toString(36)}-${segIdCounter}`;
}

export function deriveAutoZoom(
  cursor: CursorSidecar,
  opts: AutoZoomOptions = DEFAULT_AUTO_ZOOM_OPTIONS,
): ZoomSegment[] {
  const downs = cursor.clicks.filter((c) => c.kind === "down");
  if (downs.length === 0) return [];

  const totalMs = cursor.durationMs;
  const candidates: ZoomSegment[] = downs.map((c) => {
    const start = Math.max(0, c.tMs - opts.leadInMs);
    const end = Math.min(totalMs, c.tMs + opts.holdMs + opts.releaseMs);
    return {
      id: nextSegId(),
      startMs: start,
      endMs: end,
      targetLevel: opts.defaultLevel,
      focal: { x: c.x, y: c.y },
      easing: "easeInOutCubic",
      source: "auto",
      mode: "auto",
      instant: false,
      disabled: false,
      snapToEdges: DEFAULT_SNAP_TO_EDGES,
    };
  });
  candidates.sort((a, b) => a.startMs - b.startMs);

  const merged: (ZoomSegment & { _focals: { x: number; y: number }[] })[] = [];
  for (const seg of candidates) {
    const tail = merged[merged.length - 1];
    if (tail && seg.startMs <= tail.endMs + opts.mergeGapMs) {
      tail.endMs = Math.max(tail.endMs, seg.endMs);
      tail.targetLevel = Math.max(tail.targetLevel, seg.targetLevel);
      tail._focals.push(seg.focal);
    } else {
      merged.push({ ...seg, _focals: [seg.focal] });
    }
  }

  return merged.map((m) => {
    const fx = m._focals.reduce((a, p) => a + p.x, 0) / m._focals.length;
    const fy = m._focals.reduce((a, p) => a + p.y, 0) / m._focals.length;
    return {
      id: m.id,
      startMs: m.startMs,
      endMs: m.endMs,
      targetLevel: m.targetLevel,
      focal: { x: fx, y: fy },
      easing: m.easing,
      source: m.source,
      mode: m.mode,
      instant: m.instant,
      disabled: m.disabled,
      snapToEdges: m.snapToEdges,
    };
  });
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function applyEasing(kind: ZoomEasing, t: number): number {
  if (kind === "linear") return t;
  if (kind === "easeOutCubic") return easeOutCubic(t);
  return easeInOutCubic(t);
}

// Binary search the index of the last sample whose tMs is at-or-before targetMs.
function indexAt(cursor: CursorSidecar, tMs: number): number {
  const ss = cursor.samples;
  if (ss.length === 0) return -1;
  let lo = 0;
  let hi = ss.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ss[mid].tMs <= tMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Mean-position over the trailing window. `smoothing` ∈ [0,1] maps to a
// window of 0..500ms — 0 follows the raw cursor frame-by-frame, 1 averages
// over a longer window so the camera lags behind small wiggles.
function smoothedCursorAt(
  cursor: CursorSidecar,
  tMs: number,
  smoothing: number,
): { x: number; y: number } | null {
  const ss = cursor.samples;
  if (ss.length === 0) return null;
  const windowMs = 500 * Math.max(0, Math.min(1, smoothing));
  const endIdx = indexAt(cursor, tMs);
  if (endIdx < 0) return null;
  if (windowMs < 1) return { x: ss[endIdx].x, y: ss[endIdx].y };
  const lowerT = ss[endIdx].tMs - windowMs;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = endIdx; i >= 0; i--) {
    const s = ss[i];
    if (s.tMs < lowerT) break;
    sx += s.x;
    sy += s.y;
    n += 1;
  }
  return n > 0 ? { x: sx / n, y: sy / n } : { x: ss[endIdx].x, y: ss[endIdx].y };
}

export type ResolvedZoom = {
  scale: number;
  focal: { x: number; y: number };
};

// Resolve the active zoom state at time `tMs`. `segments` should be sorted by start.
// `smoothing` ∈ [0,1] — 0 = focal stays at seg.focal, 1 = focal fully follows live cursor.
export function resolveZoom(
  tMs: number,
  segments: ZoomSegment[],
  cursor: CursorSidecar | null,
  smoothing: number,
  defaultFocal?: { x: number; y: number },
): ResolvedZoom {
  const active = findActive(tMs, segments);
  if (!active) {
    return {
      scale: 1,
      focal: defaultFocal ?? { x: 0, y: 0 },
    };
  }
  const { seg } = active;
  let scale: number;
  if (seg.instant) {
    scale = seg.targetLevel;
  } else {
    const holdStart = seg.startMs + Math.min(active.leadInMs, (seg.endMs - seg.startMs) / 2);
    const holdEnd = seg.endMs - Math.min(active.releaseMs, (seg.endMs - seg.startMs) / 2);
    let progress: number;
    if (tMs < holdStart) {
      progress = (tMs - seg.startMs) / Math.max(1, holdStart - seg.startMs);
    } else if (tMs > holdEnd) {
      progress = 1 - (tMs - holdEnd) / Math.max(1, seg.endMs - holdEnd);
    } else {
      progress = 1;
    }
    progress = Math.max(0, Math.min(1, progress));
    const eased = applyEasing(seg.easing, progress);
    scale = 1 + (seg.targetLevel - 1) * eased;
  }

  // Manual mode: stay at the seg-defined focal regardless of live cursor.
  // Auto mode: follow the smoothed live cursor, falling back to seg.focal.
  let focal: { x: number; y: number };
  if (seg.mode === "manual") {
    focal = seg.focal;
  } else {
    const live = cursor ? smoothedCursorAt(cursor, tMs, smoothing) : null;
    focal = live ?? seg.focal;
  }
  return { scale, focal };
}

function findActive(
  tMs: number,
  segments: ZoomSegment[],
): { seg: ZoomSegment; leadInMs: number; releaseMs: number } | null {
  for (const seg of segments) {
    if (seg.disabled) continue;
    if (tMs >= seg.startMs && tMs <= seg.endMs) {
      const span = seg.endMs - seg.startMs;
      const leadInMs = Math.min(DEFAULT_AUTO_ZOOM_OPTIONS.leadInMs, span / 3);
      const releaseMs = Math.min(DEFAULT_AUTO_ZOOM_OPTIONS.releaseMs, span / 3);
      return { seg, leadInMs, releaseMs };
    }
  }
  return null;
}

// Same as `findActive` but exposed for the canvas clamping path, which needs
// per-segment `snapToEdges` without re-implementing segment lookup.
export function activeSegmentAt(tMs: number, segments: ZoomSegment[]): ZoomSegment | null {
  return findActive(tMs, segments)?.seg ?? null;
}

export function newManualSegment(
  startMs: number,
  endMs: number,
  focal: { x: number; y: number },
  level: number,
): ZoomSegment {
  return {
    id: nextSegId(),
    startMs,
    endMs,
    targetLevel: level,
    focal,
    easing: "easeInOutCubic",
    source: "manual",
    mode: "manual",
    instant: false,
    disabled: false,
    snapToEdges: DEFAULT_SNAP_TO_EDGES,
  };
}
