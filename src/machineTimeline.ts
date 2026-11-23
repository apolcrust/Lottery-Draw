// Pure helpers that describe how the supplied GIF is played back. The GIF has 9 frames (450 ms each in the
// original file). Frame 0 shows the balls resting; frames 1-4 show them being blown around; frames 5-8
// show one ball rising into the transparent selection tube. Splitting the clip lets the "mixing" part loop
// for as long as the draw lasts while the "reveal" part plays exactly once.

export const FRAME_COUNT = 9;
export const IDLE_FRAME = 0;
export const MIX_FRAMES = [1, 2, 3, 4] as const;
export const REVEAL_FRAMES = [5, 6, 7, 8] as const;
export const FINAL_FRAME = 8;

/** Mixing frames advance quickly so the balls look turbulent rather than slideshow-like. */
export const MIX_FRAME_MS = 140;
/** Reveal frames keep the original 450 ms-per-frame pacing of the supplied GIF. */
export const REVEAL_FRAME_MS = 450;
/** After the last reveal frame, the winning ball is pulled into focus for this long. */
export const FOCUS_MS = 1300;
export const REVEAL_TOTAL_MS = REVEAL_FRAMES.length * REVEAL_FRAME_MS + FOCUS_MS;

export type MachinePhase = "idle" | "mixing" | "revealing" | "revealed";

/** Next mixing frame: never the same frame twice in a row, so the picture is always changing. */
export function nextMixFrame(previous: number, random: number): number {
  const choices = MIX_FRAMES.filter((frame) => frame !== previous);
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(random * choices.length)));
  return choices[index];
}

export function clampDurationSeconds(value: unknown, min = 3, max = 30, fallback = 8): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * How long a device that did not start the draw should keep mixing.
 * `skewMs` = (this device's clock) - (server clock); it is 0 when unknown.
 */
export function remainingMixMs(startedAtMs: number, durationMs: number, nowMs: number, skewMs = 0): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const serverNow = nowMs - skewMs;
  const remaining = startedAtMs + durationMs - serverNow;
  // A start time in the "future" (bad clock) must never make the machine mix longer than configured.
  return Math.min(durationMs, Math.max(0, remaining));
}

/** The frame to show for a given reveal progress (milliseconds since the reveal began). */
export function revealFrameAt(elapsedMs: number): number {
  const step = Math.floor(Math.max(0, elapsedMs) / REVEAL_FRAME_MS);
  return REVEAL_FRAMES[Math.min(REVEAL_FRAMES.length - 1, step)];
}
