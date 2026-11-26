import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  beginLotteryDraw, clearPendingDraw, fetchOverride, setExcluded, finishLotteryDraw, isNetworkError, loadPendingDraw, parseDrawTicket,
  parseEventRow, retryDelayFromError, saveLotteryEventData, savePendingDraw, setOverride,
} from "./lotteryService";
import { DEFAULT_DATA, type AppData } from "../types";

const ticket = { drawId: "11111111-1111-1111-1111-111111111111", startedAt: "2026-11-23T10:00:00.000Z", durationMs: 8000 };

function fakeClient(rpc: ReturnType<typeof vi.fn>, from?: unknown) {
  return { rpc, from } as unknown as SupabaseClient;
}

function completed(): AppData {
  return {
    ...structuredClone(DEFAULT_DATA),
    winners: [{ participant: { id: "a", name: "Ada", weight: 1, number: 1 }, drawNumber: 1, ticketNumber: 6, timestamp: "2026-11-23T10:00:09Z", mode: "random" }],
  };
}

describe("draw tickets", () => {
  it("accepts a valid ticket and never carries winner information", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ticket, error: null });
    await expect(beginLotteryDraw(fakeClient(rpc), "evt")).resolves.toEqual(ticket);
    expect(rpc).toHaveBeenCalledWith("begin_lottery_draw", { p_event_id: "evt" });
  });

  it("rejects malformed tickets and propagates database errors", async () => {
    expect(() => parseDrawTicket({ drawId: 1 })).toThrow("invalid draw ticket");
    expect(() => parseDrawTicket({ ...ticket, startedAt: "nope" })).toThrow("invalid draw ticket");
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "A draw is already in progress." } });
    await expect(beginLotteryDraw(fakeClient(rpc), "evt")).rejects.toMatchObject({ message: "A draw is already in progress." });
  });
});

describe("finishLotteryDraw", () => {
  it("returns the recorded winner data", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: completed(), error: null });
    const result = await finishLotteryDraw(fakeClient(rpc), "evt", ticket.drawId, { sleep: async () => undefined });
    expect(result.winners[0].participant.name).toBe("Ada");
    expect(rpc).toHaveBeenCalledWith("finish_lottery_draw", { p_event_id: "evt", p_draw_id: ticket.drawId });
  });

  it("waits and retries when the database says the draw is not ready", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "The draw is not ready to be revealed yet. Retry in 400 ms." } })
      .mockResolvedValueOnce({ data: completed(), error: null });
    await finishLotteryDraw(fakeClient(rpc), "evt", ticket.drawId, { sleep });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(550);
  });

  it("retries network failures with backoff, then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "TypeError: Failed to fetch" } })
      .mockResolvedValueOnce({ data: null, error: { message: "TypeError: Failed to fetch" } })
      .mockResolvedValueOnce({ data: completed(), error: null });
    await finishLotteryDraw(fakeClient(rpc), "evt", ticket.drawId, { sleep });
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it("does not retry fatal errors such as an expired draw", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "This draw is no longer active (it was expired)." } });
    await expect(finishLotteryDraw(fakeClient(rpc), "evt", ticket.drawId, { sleep: async () => undefined }))
      .rejects.toMatchObject({ message: expect.stringContaining("no longer active") });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    await expect(finishLotteryDraw(fakeClient(rpc), "evt", ticket.drawId, { attempts: 3, sleep: async () => undefined })).rejects.toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});

describe("error helpers", () => {
  it("recognises network errors and early-finish hints", () => {
    expect(isNetworkError("TypeError: Failed to fetch")).toBe(true);
    expect(isNetworkError("A draw is already in progress.")).toBe(false);
    expect(retryDelayFromError("Retry in 1234 ms.")).toBe(1234);
    expect(retryDelayFromError("nothing")).toBeNull();
  });
});

describe("event persistence", () => {
  it("never sends the predetermined winner to the public data column", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "evt" }, error: null });
    const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle }) }) }) }));
    const from = vi.fn(() => ({ update }));
    const data: AppData = { ...structuredClone(DEFAULT_DATA), overrideParticipantId: "secret", overrideActivated: true };
    await saveLotteryEventData(fakeClient(vi.fn(), from), "evt", "owner", data);
    const sent = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(sent).not.toHaveProperty("overrideParticipantId");
    expect(sent).not.toHaveProperty("overrideActivated");
    expect(from).toHaveBeenCalledWith("lottery_events");
  });

  it("sets the predetermined winner through the owner-only function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await setOverride(fakeClient(rpc), "evt", "p1", true);
    expect(rpc).toHaveBeenCalledWith("set_lottery_override", { p_event_id: "evt", p_participant_id: "p1", p_armed: true });
  });

  it("parses event rows into validated app data", () => {
    const row = parseEventRow({ id: "e", owner_id: "o", data: structuredClone(DEFAULT_DATA), is_drawing: true,
      draw_started_at: "2026-11-23T10:00:00Z", draw_duration_ms: 8000 });
    expect(row).toMatchObject({ id: "e", ownerId: "o", isDrawing: true, drawDurationMs: 8000 });
    expect(() => parseEventRow({ id: "e" })).toThrow();
  });
});

describe("excluded participants (operator only)", () => {
  it("saves the excluded list through the owner-only function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await setExcluded(fakeClient(rpc), "evt", ["p1", "p2"]);
    expect(rpc).toHaveBeenCalledWith("set_lottery_excluded", { p_event_id: "evt", p_participant_ids: ["p1", "p2"] });
  });

  it("reads the private operator settings together", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { override_participant_id: "p1", override_armed: true, excluded_participant_ids: ["p2", 7, "p3"] }, error: null });
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));
    const result = await fetchOverride(fakeClient(vi.fn(), from), "evt");
    expect(result).toEqual({ overrideParticipantId: "p1", overrideActivated: true, excludedParticipantIds: ["p2", "p3"] });
    expect(from).toHaveBeenCalledWith("lottery_event_secrets");
  });
});

describe("interrupted draw recovery", () => {
  function memoryStore() {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  }

  it("round-trips a pending ticket per event and clears it", () => {
    const store = memoryStore();
    savePendingDraw("evt", ticket, store);
    expect(loadPendingDraw("evt", store)).toEqual(ticket);
    expect(loadPendingDraw("other", store)).toBeNull();
    clearPendingDraw("evt", store);
    expect(loadPendingDraw("evt", store)).toBeNull();
  });

  it("ignores corrupted storage", () => {
    const store = memoryStore();
    store.setItem("lottery-ball-system:pending-draw:evt", "{not json");
    expect(loadPendingDraw("evt", store)).toBeNull();
  });
});
