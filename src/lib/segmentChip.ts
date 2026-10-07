import type { PlacedClip } from "./clips";

const sourceMs = (c: PlacedClip, outMs: number, duration: number) =>
  Math.max(0, Math.min(duration * 1000, (c.srcStart + (outMs / 1000 - c.outStart) * c.speed) * 1000));

// A chip may represent only part of a segment; moving it must preserve the full range.
export const mapSegmentChipPatch = <P extends { startMs?: number; endMs?: number }>(
  c: PlacedClip, segment: { startMs: number; endMs: number }, patch: P, srcDuration: number,
): P => {
  const visibleStart = Math.max(segment.startMs, c.srcStart * 1000);
  const visibleEnd = Math.min(segment.endMs, c.srcEnd * 1000);
  if (patch.startMs !== undefined && patch.endMs !== undefined) {
    const requested = sourceMs(c, patch.startMs, srcDuration) - visibleStart;
    const delta = Math.max(
      Math.max(-segment.startMs, c.srcStart * 1000 - visibleStart),
      Math.min(requested, srcDuration * 1000 - segment.endMs, c.srcEnd * 1000 - visibleEnd),
    );
    return { ...patch, startMs: segment.startMs + delta, endMs: segment.endMs + delta };
  }
  return {
    ...patch,
    ...(patch.startMs !== undefined ? { startMs: segment.startMs < c.srcStart * 1000
      ? segment.startMs : Math.max(c.srcStart * 1000, Math.min(visibleEnd - 50 * c.speed, sourceMs(c, patch.startMs, srcDuration))) } : {}),
    ...(patch.endMs !== undefined ? { endMs: segment.endMs > c.srcEnd * 1000
      ? segment.endMs : Math.min(c.srcEnd * 1000, Math.max(visibleStart + 50 * c.speed, sourceMs(c, patch.endMs, srcDuration))) } : {}),
  };
};
