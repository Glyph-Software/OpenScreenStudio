import { describe, expect, test } from 'bun:test';
import { fullClip, layoutClips, outDuration, outToSrc, srcToOut, srcRangePieces, splitAt, moveClip, removeClip, duplicateClip, mapSegmentPiecePatch } from '../src/lib/clips';

describe('clip sequence', () => {
  test('speed controls output duration and source mapping', () => {
    const clips = layoutClips([{ ...fullClip(60), speed: 10 }]);
    expect(outDuration(clips)).toBe(6);
    expect(outToSrc(clips[0], 4)).toBe(40);
    expect(srcToOut(clips[0], 40)).toBe(4);
    expect(outToSrc(clips[0], 99)).toBe(60);
  });
  test('split preserves speed, mute and source ranges', () => {
    const result = splitAt([{ ...fullClip(60), speed: 10, muted: true }], 2)!;
    expect(result.clips.map(c => [c.srcStart, c.srcEnd, c.speed, c.muted])).toEqual([[0,20,10,true],[20,60,10,true]]);
    expect(splitAt(result.clips, 0)).toBeNull();
    expect(splitAt(result.clips, 2)).toBeNull();
  });
  test('move, duplicate and remove close output gaps', () => {
    const clips = splitAt([fullClip(10)], 5)!.clips;
    const moved = moveClip(clips, clips[1].id, 0);
    expect(moved[0].srcStart).toBe(5);
    const copy = duplicateClip(moved, moved[0].id);
    expect(copy.clips[1].id).not.toBe(moved[0].id);
    expect(outDuration(layoutClips(copy.clips))).toBe(15);
    expect(removeClip(copy.clips, copy.newId)).toEqual(moved);
    expect(removeClip([fullClip(10)], 'full')).toHaveLength(1);
  });
});

describe('source segment piece edits', () => {
  const segment = { startMs: 3000, endMs: 8000 };
  const clips = layoutClips(splitAt([fullClip(10)], 5)!.clips);
  test('moving either piece preserves the entire segment length', () => {
    const pieces = srcRangePieces(clips, 3, 8);
    expect(pieces.map(p => [p.outStart,p.outEnd])).toEqual([[3,5],[5,8]]);
    for (const p of pieces) {
      expect(mapSegmentPiecePatch(p.clip, segment, p.outStart * 1000, { startMs: p.outStart * 1000 + 500, endMs: p.outEnd * 1000 + 500 }, 10000)).toEqual({ startMs:3500, endMs:8500 });
    }
  });
  test('trimming one edge preserves the other and clamps to the reordered clip', () => {
    const clip = layoutClips(moveClip(clips, clips[1].id, 0))[0];
    expect(mapSegmentPiecePatch(clip, segment, 0, { endMs: 9000 }, 10000)).toEqual({ endMs:10000 });
    expect(mapSegmentPiecePatch(clip, segment, 0, { startMs:-9000 }, 10000)).toEqual({ startMs:5000 });
  });
  test('speed scales moves and recording bounds preserve segment length', () => {
    const clip = layoutClips([{ ...fullClip(10), speed:2 }])[0];
    expect(mapSegmentPiecePatch(clip, segment, 1500, {startMs:2000,endMs:4500},10000)).toEqual({startMs:4000,endMs:9000});
    expect(mapSegmentPiecePatch(clip, segment, 1500, {startMs:9000,endMs:11500},10000)).toEqual({startMs:5000,endMs:10000});
  });
});
