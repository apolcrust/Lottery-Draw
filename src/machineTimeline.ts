// Timing for the lottery machine sequence. The machine is drawn live on a canvas (see LotteryMachine.tsx
// and machinePhysics.ts); nothing here depends on any image or GIF file.

/** Time from the start of the reveal until the selected ball is at the top of the tube. */
export const REVEAL_RISE_MS = 3200;
/** After that, the winning ball is pulled into focus for this long. */
export const FOCUS_MS = 1300;
export const REVEAL_TOTAL_MS = REVEAL_RISE_MS + FOCUS_MS;

export type MachinePhase = "idle" | "mixing" | "revealing" | "revealed";

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
