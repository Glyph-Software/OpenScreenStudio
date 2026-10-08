// Per-track audio pieces in source time. Pieces tile the whole track; a muted piece is silent.
export type AudioPiece = { id: string; start: number; end: number; muted: boolean };

const MIN_PIECE = 0.1;
const newId = () => `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const piecesOrDefault = (pieces: AudioPiece[] | undefined, srcDuration: number): AudioPiece[] =>
  pieces && pieces.length ? pieces : [{ id: "all", start: 0, end: Math.max(0, srcDuration), muted: false }];

export const pieceAt = (pieces: AudioPiece[], t: number) =>
  pieces.find((p) => t >= p.start && t < p.end) ?? pieces[pieces.length - 1] ?? null;

export const isSilencedAt = (pieces: AudioPiece[] | undefined, t: number) =>
  !!pieces?.some((p) => p.muted && t >= p.start && t < p.end);

export function splitPiece(pieces: AudioPiece[], t: number, onlyId?: string): { pieces: AudioPiece[]; rightId: string } | null {
  const p = pieceAt(pieces, t);
  if (!p || (onlyId && p.id !== onlyId) || t - p.start < MIN_PIECE || p.end - t < MIN_PIECE) return null;
  const right = { ...p, id: newId(), start: t };
  return { pieces: pieces.flatMap((x) => (x.id === p.id ? [{ ...x, end: t }, right] : [x])), rightId: right.id };
}

/** Source ranges inside [s0, s1] that are audible (not in a muted piece). */
export function audibleRanges(pieces: AudioPiece[] | undefined, s0: number, s1: number): [number, number][] {
  if (!pieces?.length) return s1 > s0 ? [[s0, s1]] : [];
  return pieces
    .filter((p) => !p.muted)
    .map((p): [number, number] => [Math.max(s0, p.start), Math.min(s1, p.end)])
    .filter(([a, b]) => b - a > 1e-3);
}
