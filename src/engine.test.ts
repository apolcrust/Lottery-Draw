import { describe, expect, it } from "vitest";
import {
  pruneExcluded, consumeOverride, pickRandomIndex, pickWeightedIndex, removeParticipantById, secureRandomInt, selectionModeFor,
  selectWinner, weightedIndexForRoll,
} from "./engine";
import type { Participant } from "./types";

const participants: Participant[] = [
  { id: "a", name: "Ada", weight: 1, number: 1 },
  { id: "b", name: "Ben", weight: 3, number: 1 },
];

describe("weighted selection", () => {
  it("maps random rolls to the correct weight intervals", () => {
    expect(weightedIndexForRoll(participants, 0)).toBe(0);
    expect(weightedIndexForRoll(participants, 0.249)).toBe(0);
    expect(weightedIndexForRoll(participants, 0.25)).toBe(1);
    expect(weightedIndexForRoll(participants, 0.999)).toBe(1);
  });

  it("rejects invalid weights and rolls", () => {
    expect(() => weightedIndexForRoll([], 0)).toThrow();
    expect(() => weightedIndexForRoll(participants, 1)).toThrow();
    expect(() => weightedIndexForRoll([{ ...participants[0], weight: 0, number: 1 }], 0.5)).toThrow();
    expect(() => pickWeightedIndex([])).toThrow();
  });

  it("gives every eligible participant the probability proportional to its weight", () => {
    const draws = 40_000;
    const counts = [0, 0];
    for (let i = 0; i < draws; i += 1) counts[pickWeightedIndex(participants)] += 1;
    expect(counts[1] / draws).toBeGreaterThan(0.72);
    expect(counts[1] / draws).toBeLessThan(0.78);
  });

  it("is uniform when all weights are equal", () => {
    const equal: Participant[] = ["a", "b", "c", "d"].map((id) => ({ id, name: id, weight: 1, number: 1 }));
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i += 1) counts[pickRandomIndex(equal)] += 1;
    for (const count of counts) expect(count / 40_000).toBeGreaterThan(0.23);
  });
});

describe("secure random integers", () => {
  it("stays in range and rejects invalid bounds", () => {
    for (let i = 0; i < 500; i += 1) {
      const value = secureRandomInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(() => secureRandomInt(0)).toThrow();
    expect(() => secureRandomInt(1.5)).toThrow();
  });
});

describe("selection mode and predetermined winner", () => {
  it("labels draws weighted only when weights differ", () => {
    expect(selectionModeFor(participants)).toBe("weighted");
    expect(selectionModeFor([{ id: "a", name: "A", weight: 2, number: 1 }, { id: "b", name: "B", weight: 2, number: 1 }])).toBe("random");
  });

  it("uses an armed, eligible predetermined winner and labels it controlled", () => {
    expect(selectWinner(participants, "a", true)).toEqual({ index: 0, mode: "controlled" });
  });

  it("ignores an unarmed pick or one that is no longer on the roster", () => {
    expect(selectWinner(participants, "a", false).mode).not.toBe("controlled");
    expect(selectWinner(participants, "gone", true).mode).not.toBe("controlled");
    expect(() => selectWinner([], null, false)).toThrow();
  });

  it("removes winners and consumes the one-time pick only when it was used", () => {
    expect(removeParticipantById(participants, "a").map((p) => p.id)).toEqual(["b"]);
    expect(consumeOverride("a", "a")).toBeNull();
    expect(consumeOverride("a", "b")).toBe("a");
  });
});

describe("participants excluded from the random draw", () => {
  const people: Participant[] = ["a", "b", "c", "d"].map((id) => ({ id, name: id, weight: 1, number: 1 }));

  it("never picks an excluded participant at random, over many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i += 1) seen.add(people[selectWinner(people, null, false, ["a", "c"]).index].id);
    expect([...seen].sort()).toEqual(["b", "d"]);
  });

  it("returns the index in the full list and keeps the weights of the eligible people", () => {
    const weighted: Participant[] = [{ id: "a", name: "a", weight: 1, number: 1 }, { id: "b", name: "b", weight: 1, number: 1 }, { id: "c", name: "c", weight: 9, number: 1 }];
    expect(selectWinner(weighted, null, false, ["c"]).mode).toBe("random");
    expect(selectWinner(weighted, null, false, ["a"]).mode).toBe("weighted");
    expect(selectWinner(weighted, null, false, ["a", "b"]).index).toBe(2);
  });

  it("refuses to draw when everyone is excluded, with a clear message", () => {
    expect(() => selectWinner(people, null, false, ["a", "b", "c", "d"])).toThrow("excluded from the random draw");
  });

  it("still lets an armed one-time pick choose an excluded participant", () => {
    expect(selectWinner(people, "a", true, ["a"])).toEqual({ index: 0, mode: "controlled" });
  });

  it("prunes ids that are no longer on the roster, without duplicates", () => {
    expect(pruneExcluded(["a", "ghost", "a", "b"], people)).toEqual(["a", "b"]);
  });
});
