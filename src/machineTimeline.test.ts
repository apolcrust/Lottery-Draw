import { describe, expect, it } from "vitest";
import { clampDurationSeconds, FOCUS_MS, REVEAL_RISE_MS, REVEAL_TOTAL_MS, remainingMixMs } from "./machineTimeline";
import { GUIDE_END } from "./machinePhysics";

describe("reveal timeline", () => {
  it("lets the ball reach the top of the tube before the focus animation starts", () => {
    expect(REVEAL_RISE_MS).toBeGreaterThan(GUIDE_END * 1000);
    expect(REVEAL_TOTAL_MS).toBe(REVEAL_RISE_MS + FOCUS_MS);
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
