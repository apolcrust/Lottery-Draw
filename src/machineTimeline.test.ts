import { describe, expect, it } from "vitest";
import {
  clampDurationSeconds, FINAL_FRAME, FRAME_COUNT, MIX_FRAMES, nextMixFrame, REVEAL_FRAME_MS, REVEAL_FRAMES,
  remainingMixMs, revealFrameAt,
} from "./machineTimeline";

describe("GIF frame plan", () => {
  it("splits the 9 GIF frames into idle, mixing and reveal ranges without overlap", () => {
    const all = [0, ...MIX_FRAMES, ...REVEAL_FRAMES];
    expect(all).toHaveLength(FRAME_COUNT);
    expect(new Set(all).size).toBe(FRAME_COUNT);
    expect(FINAL_FRAME).toBe(FRAME_COUNT - 1);
  });

  it("never repeats a mixing frame back to back and never leaves the mixing range", () => {
    let frame = 1;
    for (let i = 0; i < 400; i += 1) {
      const next = nextMixFrame(frame, Math.random());
      expect(next).not.toBe(frame);
      expect(MIX_FRAMES).toContain(next);
      frame = next;
    }
    expect(MIX_FRAMES).toContain(nextMixFrame(0, 0.99));
    expect(MIX_FRAMES).toContain(nextMixFrame(4, 0));
  });

  it("plays the reveal frames in order and holds on the last one", () => {
    expect(revealFrameAt(0)).toBe(5);
    expect(revealFrameAt(REVEAL_FRAME_MS)).toBe(6);
    expect(revealFrameAt(REVEAL_FRAME_MS * 3)).toBe(8);
    expect(revealFrameAt(60_000)).toBe(8);
    expect(revealFrameAt(-50)).toBe(5);
  });
});

describe("drawing duration", () => {
  it("clamps configured durations to 3-30 seconds", () => {
    expect(clampDurationSeconds(1)).toBe(3);
    expect(clampDurationSeconds(99)).toBe(30);
    expect(clampDurationSeconds("12")).toBe(12);
    expect(clampDurationSeconds(Number.NaN)).toBe(8);
  });

  it("computes how long a second device should keep mixing", () => {
    const start = 1_000_000;
    expect(remainingMixMs(start, 8000, start + 2000)).toBe(6000);
    expect(remainingMixMs(start, 8000, start + 9000)).toBe(0);
    // Device clock 3 s ahead of the server: compensates for the skew.
    expect(remainingMixMs(start, 8000, start + 2000 + 3000, 3000)).toBe(6000);
    // A start time in the future never extends the draw beyond its configured length.
    expect(remainingMixMs(start + 60_000, 8000, start)).toBe(8000);
    expect(remainingMixMs(Number.NaN, 8000, start)).toBe(0);
  });
});
