// Independent camera-track edits. A cut shows the camera over [start, end)
// of screen-source time; `shift` delays the camera content by that many seconds.
export type CameraCut = { id: string; start: number; end: number; shift: number };

const MIN_CUT = 0.1;
const newId = () => `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const defaultCameraCuts = (offset: number, duration: number, srcDuration: number): CameraCut[] => [
  { id: "cam", start: Math.max(0, offset), end: duration > 0 ? offset + duration : srcDuration, shift: 0 },
];

export const cameraCutAt = (cuts: CameraCut[], t: number) =>
  cuts.find((c) => t >= c.start && t < c.end) ?? null;

export function splitCameraCut(cuts: CameraCut[], t: number, onlyId?: string): { cuts: CameraCut[]; rightId: string } | null {
  const c = cameraCutAt(cuts, t);
  if (!c || (onlyId && c.id !== onlyId) || t - c.start < MIN_CUT || c.end - t < MIN_CUT) return null;
  const right = { ...c, id: newId(), start: t };
  return { cuts: cuts.flatMap((x) => (x.id === c.id ? [{ ...x, end: t }, right] : [x])), rightId: right.id };
}

/** Slide a cut (window + content) by `delta` seconds without overlapping its neighbours. */
export function moveCameraCut(cuts: CameraCut[], id: string, delta: number, srcDuration: number): CameraCut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === id);
  if (i < 0) return cuts;
  const c = sorted[i];
  const lo = (i > 0 ? sorted[i - 1].end : 0) - c.start;
  const hi = i + 1 < sorted.length ? sorted[i + 1].start - c.end : srcDuration - MIN_CUT - c.start;
  const d = Math.max(lo, Math.min(hi, delta));
  return cuts.map((x) => (x.id === id ? { ...x, start: x.start + d, end: x.end + d, shift: x.shift + d } : x));
}
