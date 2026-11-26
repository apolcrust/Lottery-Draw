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
    expect(() => validateData({ ...base, participants: [{ id: "a", name: "Ada", weight: 0, number: 1 }] })).toThrow("invalid participant");
    expect(() => validateData({ ...base, winners: [{ participant: { id: "a", name: "Ada", weight: 1, number: 1 }, drawNumber: 1, timestamp: "t", mode: "magic" }] }))
      .toThrow("invalid winner record");
  });

  it("migrates winner records and drops wheel-only settings from original Wheel of Fortune backups", () => {
    const legacy = {
      participants: [],
      winners: [{ participant: { id: "a", name: "Ada", weight: 1, number: 1 }, spinNumber: 4, timestamp: "2026-01-01T00:00:00Z", mode: "random" }],
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

describe("winner ticket numbers", () => {
  const person = { id: "a", name: "Ada", weight: 1, number: 1 };
  const base = () => structuredClone(DEFAULT_DATA);

  it("keeps the participant number stored with each winner", () => {
    const result = validateData({ ...base(), winners: [{ participant: person, drawNumber: 2, ticketNumber: 655, timestamp: "t", mode: "random" }] });
    expect(result.winners[0].ticketNumber).toBe(655);
    expect(result.winners[0].drawNumber).toBe(2);
  });

  it("falls back to the draw order for older records without a participant number", () => {
    const result = validateData({ ...base(), winners: [{ participant: person, drawNumber: 3, timestamp: "t", mode: "random" }] });
    expect(result.winners[0].ticketNumber).toBe(3);
  });
});

describe("excluded participants", () => {
  const people = [{ id: "a", name: "Ada", weight: 1, number: 1 }, { id: "b", name: "Ben", weight: 1, number: 1 }];
  it("keeps valid excluded ids and drops unknown or duplicate ones", () => {
    const result = validateData({ ...structuredClone(DEFAULT_DATA), participants: people, excludedParticipantIds: ["b", "ghost", "b"] });
    expect(result.excludedParticipantIds).toEqual(["b"]);
  });
  it("defaults to nobody excluded", () => {
    expect(validateData(structuredClone(DEFAULT_DATA)).excludedParticipantIds).toEqual([]);
  });
});

describe("permanent participant numbers", () => {
  const base = () => structuredClone(DEFAULT_DATA);

  it("keeps each participant's number and the counter exactly as stored", () => {
    const result = validateData({ ...base(), participants: [{ id: "b", name: "Ben", weight: 1, number: 7 }, { id: "d", name: "Dev", weight: 1, number: 12 }], nextNumber: 20 });
    expect(result.participants.map((p) => p.number)).toEqual([7, 12]);
    expect(result.nextNumber).toBe(20);
  });

  it("numbers people who have no number yet, after the highest existing number, and never reuses one", () => {
    const result = validateData({ ...base(), participants: [{ id: "a", name: "Ada", weight: 1 }, { id: "b", name: "Ben", weight: 1, number: 5 }, { id: "c", name: "Cleo", weight: 1 }] });
    expect(result.participants.map((p) => p.number)).toEqual([6, 5, 7]);
    expect(result.nextNumber).toBe(8);
  });

  it("never lets the counter fall behind the numbers in use", () => {
    const result = validateData({ ...base(), participants: [{ id: "a", name: "Ada", weight: 1, number: 9 }], nextNumber: 2 });
    expect(result.nextNumber).toBe(10);
  });

  it("gives older winner records a participant number from their ticket number", () => {
    const result = validateData({ ...base(), winners: [{ participant: { id: "a", name: "Ada", weight: 1 }, drawNumber: 1, ticketNumber: 4, timestamp: "t", mode: "random" }] });
    expect(result.winners[0].participant.number).toBe(4);
  });
});

describe("publicEventData", () => {
  it("removes the operator-only predetermined winner", () => {
    const data = { ...structuredClone(DEFAULT_DATA), overrideParticipantId: "x", overrideActivated: true, excludedParticipantIds: ["y"] };
    expect(Object.keys(publicEventData(data)).sort()).toEqual(["nextNumber", "participants", "settings", "winners"]);
  });
});
