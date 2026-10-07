import { expect, test } from "bun:test";
import { layoutClips, fullClip } from "../src/lib/clips";
import { mapSegmentChipPatch } from "../src/lib/segmentChip";

const segment = { startMs: 2000, endMs: 8000 };
const right = layoutClips([
  { ...fullClip(5), id: "left" },
  { ...fullClip(10), id: "right", srcStart: 5 },
])[1];

test("moving the right chip preserves the complete source segment", () => {
  expect(mapSegmentChipPatch(right, segment, { startMs: 6000, endMs: 9000 }, 10))
    .toEqual({ startMs: 3000, endMs: 9000 });
});
test("a clip boundary cannot resize the hidden segment start", () => {
  expect(mapSegmentChipPatch(right, segment, { startMs: 6000 }, 10))
    .toEqual({ startMs: 2000 });
});
test("movement cannot hide the grabbed chip in removed source time", () => {
  expect(mapSegmentChipPatch(right, segment, { startMs: 3000, endMs: 6000 }, 10))
    .toEqual(segment);
  expect(mapSegmentChipPatch(right, segment, { startMs: 9000, endMs: 12000 }, 10))
    .toEqual({ startMs: 4000, endMs: 10000 });
});
test("clip speed and output offset map movement into source time", () => {
  const fast = { ...right, speed: 2, outStart: 1, outEnd: 3.5 };
  expect(mapSegmentChipPatch(fast, segment, { startMs: 1500, endMs: 3000 }, 10))
    .toEqual({ startMs: 3000, endMs: 9000 });
});
test("real segment edges clamp to the captured clip", () => {
  expect(mapSegmentChipPatch(right, segment, { endMs: 12000 }, 10)).toEqual({ endMs: 10000 });
  const inner = { startMs: 6000, endMs: 8000 };
  expect(mapSegmentChipPatch(right, inner, { startMs: 2000 }, 10)).toEqual({ startMs: 5000 });
});
