// Clip sequence: the edited output is an ordered list of source ranges, each
// with its own playback speed. Everything else (zoom, effects, camera, cursor)
// stays in source time; these helpers map between source and output time.

export type Clip = {
  id: string;
  /** Source range in seconds of the original recording. */
  srcStart: number;
  srcEnd: number;
  /** Playback speed multiplier (1 = realtime, 10 = timelapse). */
  speed: number;
  /** Silence all audio while this clip plays. */
  muted: boolean;
};

export type PlacedClip = Clip & { outStart: number; outEnd: number };

export const MIN_CLIP_SEC = 0.1;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 50;
export const SPEED_PRESETS = [0.5, 1, 2, 4, 8, 16, 25, 50];
/** Highest rate the <video> element plays natively; faster clips are stepped by seeking. */
export const NATIVE_RATE_MAX = 16;

export const newClipId = () =>
  `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const fullClip = (duration: number): Clip => ({
  id: "full",
  srcStart: 0,
  srcEnd: Math.max(0, duration),
  speed: 1,
  muted: false,
});

export const clampSpeed = (s: number) =>
  Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number.isFinite(s) ? s : 1));

export function layoutClips(clips: Clip[]): PlacedClip[] {
  let t = 0;
  return clips.map((c) => {
    const len = Math.max(0, c.srcEnd - c.srcStart) / c.speed;
    const p = { ...c, outStart: t, outEnd: t + len };
    t += len;
    return p;
  });
}

export const outDuration = (placed: PlacedClip[]) =>
  placed.length ? placed[placed.length - 1].outEnd : 0;

/** Index of the clip playing at output time `o` (clamped to the sequence). */
export function clipIndexAtOut(placed: PlacedClip[], o: number): number {
  for (let i = 0; i < placed.length; i++) {
    if (o < placed[i].outEnd) return i;
  }
  return Math.max(0, placed.length - 1);
}

export const outToSrc = (c: PlacedClip, o: number) =>
  Math.max(c.srcStart, Math.min(c.srcEnd, c.srcStart + (o - c.outStart) * c.speed));

export const srcToOut = (c: PlacedClip, t: number) =>
  Math.max(c.outStart, Math.min(c.outEnd, c.outStart + (t - c.srcStart) / c.speed));

/** Where the source range [s0, s1] appears in the output, one piece per clip. */
export function srcRangePieces(
  placed: PlacedClip[],
  s0: number,
  s1: number,
): { clip: PlacedClip; outStart: number; outEnd: number }[] {
  const out: { clip: PlacedClip; outStart: number; outEnd: number }[] = [];
  for (const c of placed) {
    const a = Math.max(s0, c.srcStart);
    const b = Math.min(s1, c.srcEnd);
    if (b - a <= 1e-6) continue;
    out.push({ clip: c, outStart: srcToOut(c, a), outEnd: srcToOut(c, b) });
  }
  return out;
}

/** Split the clip under output time `o`. Returns null when too close to an edge. */
export function splitAt(
  clips: Clip[],
  o: number,
  onlyId?: string,
): { clips: Clip[]; rightId: string } | null {
  const placed = layoutClips(clips);
  const i = clipIndexAtOut(placed, o);
  const c = placed[i];
  if (!c || (onlyId && c.id !== onlyId)) return null;
  const t = outToSrc(c, o);
  if (t - c.srcStart < MIN_CLIP_SEC || c.srcEnd - t < MIN_CLIP_SEC) return null;
  const left: Clip = { ...clips[i], id: newClipId(), srcEnd: t };
  const right: Clip = { ...clips[i], id: newClipId(), srcStart: t };
  return { clips: [...clips.slice(0, i), left, right, ...clips.slice(i + 1)], rightId: right.id };
}

/** Split every timed segment (or only `onlyId`) that spans source time `tMs`. */
export function splitSegmentsAt<T extends { id: string; startMs: number; endMs: number }>(
  segs: T[],
  tMs: number,
  onlyId?: string,
): T[] {
  const minMs = MIN_CLIP_SEC * 1000;
  return segs.flatMap((s) =>
    (onlyId && s.id !== onlyId) || tMs - s.startMs < minMs || s.endMs - tMs < minMs
      ? [s]
      : [{ ...s, endMs: tMs }, { ...s, id: `${s.id}-${newClipId()}`, startMs: tMs }],
  );
}

export function removeClip(clips: Clip[], id: string): Clip[] {
  if (clips.length <= 1) return clips;
  return clips.filter((c) => c.id !== id);
}

export function duplicateClip(clips: Clip[], id: string): { clips: Clip[]; newId: string } {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return { clips, newId: id };
  const copy = { ...clips[i], id: newClipId() };
  return { clips: [...clips.slice(0, i + 1), copy, ...clips.slice(i + 1)], newId: copy.id };
}

/** Move a clip so it ends up at `toIndex` in the resulting order. */
export function moveClip(clips: Clip[], id: string, toIndex: number): Clip[] {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return clips;
  const rest = clips.filter((c) => c.id !== id);
  const j = Math.max(0, Math.min(rest.length, toIndex));
  return [...rest.slice(0, j), clips[i], ...rest.slice(j)];
}

export function patchClip(clips: Clip[], id: string, patch: Partial<Clip>): Clip[] {
  return clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
}

/** Map one visible piece's edit without truncating the underlying source segment. */
export function mapSegmentPiecePatch<P extends { startMs?: number; endMs?: number }>(
  clip: PlacedClip,
  segment: { startMs: number; endMs: number },
  pieceStartMs: number,
  patch: P,
  sourceDurationMs: number,
): P {
  if (patch.startMs !== undefined && patch.endMs !== undefined) {
    const requested = (patch.startMs - pieceStartMs) * clip.speed;
    const delta = Math.max(-segment.startMs, Math.min(sourceDurationMs - segment.endMs, requested));
    return { ...patch, startMs: segment.startMs + delta, endMs: segment.endMs + delta };
  }
  return {
    ...patch,
    ...(patch.startMs !== undefined ? { startMs: Math.min(segment.endMs - 50, outToSrc(clip, patch.startMs / 1000) * 1000) } : {}),
    ...(patch.endMs !== undefined ? { endMs: Math.max(segment.startMs + 50, outToSrc(clip, patch.endMs / 1000) * 1000) } : {}),
  };
}
