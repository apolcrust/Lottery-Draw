import { describe, expect, it } from "vitest";
import { DEFAULT_DATA } from "./types";
import { publicEventData, validateData } from "./storage";

describe("validateData", () => {
  it("reports which data source contains invalid session data", () => {
    expect(() => validateData(null)).toThrow("The backup file has no session data (stored value: null).");
    expect(() => validateData(null, "saved browser session"))
      .toThrow("The saved browser session has no session data (stored value: null).");
    expect(() => validateData(null, "shared event"))
      .toThrow("The shared event has no session data (stored value: null).");
  });

  it("accepts valid session data from any source", () => {
    expect(validateData(structuredClone(DEFAULT_DATA), "shared event")).toEqual(DEFAULT_DATA);
  });

  it("accepts JSON-encoded session data and reports malformed JSON by source", () => {
    expect(validateData(JSON.stringify(DEFAULT_DATA), "shared event")).toEqual(DEFAULT_DATA);
    expect(() => validateData("{", "shared event")).toThrow("The shared event contains malformed JSON session data.");
  });

  it("fills in defaults for shared events that have no operator-only fields", () => {
    const { overrideParticipantId, overrideActivated, ...pub } = structuredClone(DEFAULT_DATA);
    void overrideParticipantId; void overrideActivated;
    const result = validateData(pub, "shared event");
    expect(result.overrideParticipantId).toBeNull();
    expect(result.overrideActivated).toBe(false);
  });

  it("rejects out-of-range durations, bad weights and bad winner modes", () => {
    const base = structuredClone(DEFAULT_DATA);
    expect(() => validateData({ ...base, settings: { ...base.settings, duration: 2 } })).toThrow("invalid lottery settings");
    expect(() => validateData({ ...base, settings: { ...base.settings, duration: 31 } })).toThrow("invalid lottery settings");
    expect(() => validateData({ ...base, participants: [{ id: "a", name: "Ada", weight: 0 }] })).toThrow("invalid participant");
    expect(() => validateData({ ...base, winners: [{ participant: { id: "a", name: "Ada", weight: 1 }, drawNumber: 1, timestamp: "t", mode: "magic" }] }))
      .toThrow("invalid winner record");
  });

  it("migrates winner records and drops wheel-only settings from original Wheel of Fortune backups", () => {
    const legacy = {
      participants: [],
      winners: [{ participant: { id: "a", name: "Ada", weight: 1 }, spinNumber: 4, timestamp: "2026-01-01T00:00:00Z", mode: "random" }],
      settings: { ...DEFAULT_DATA.settings, rotations: 6, background: "#111014", textColor: "#fff8e9", borderColor: "#e5c27c" },
    };
    const result = validateData(legacy);
    expect(result.winners[0].drawNumber).toBe(4);
    expect(result.settings).not.toHaveProperty("rotations");
    expect(result.settings).not.toHaveProperty("background");
  });

  it("rejects an override that is not an active participant", () => {
    expect(() => validateData({ ...structuredClone(DEFAULT_DATA), overrideParticipantId: "ghost" })).toThrow("one-time pick");
  });
});

describe("publicEventData", () => {
  it("removes the operator-only predetermined winner", () => {
    const data = { ...structuredClone(DEFAULT_DATA), overrideParticipantId: "x", overrideActivated: true };
    expect(Object.keys(publicEventData(data)).sort()).toEqual(["participants", "settings", "winners"]);
  });
});
