import { describe, expect, it } from "vitest";
import { ballColorFor, formatTicket } from "./ballColors";
import { winnersInDrawOrder } from "./winnerHistory";
import { sampleNumbers, createSim, createRng } from "./machinePhysics";
import type { Winner } from "./types";

const winner = (drawNumber: number, name: string, ticketNumber = drawNumber): Winner => ({
  participant: { id: name, name, weight: 1, number: ticketNumber }, drawNumber, ticketNumber, timestamp: `2026-11-24T08:3${drawNumber}:00Z`, mode: "random",
});

describe("winner history order", () => {
  it("lists the first winner on top and later winners below (the stored list is newest-first)", () => {
    const stored = [winner(3, "C"), winner(2, "B"), winner(1, "A")];
    expect(winnersInDrawOrder(stored).map((w) => w.participant.name)).toEqual(["A", "B", "C"]);
    expect(stored.map((w) => w.participant.name)).toEqual(["C", "B", "A"]);
  });
});

describe("participant numbers on the balls", () => {
  it("formats numbers the way the participant list shows them", () => {
    expect(formatTicket(6)).toBe("06");
    expect(formatTicket(655)).toBe("655");
    expect(formatTicket(null)).toBe("?");
  });

  it("colours a ball by the participant number, cycling through the palette", () => {
    const palette = ["#111111", "#222222", "#333333"];
    expect(ballColorFor(palette, 1)).toBe("#111111");
    expect(ballColorFor(palette, 3)).toBe("#333333");
    expect(ballColorFor(palette, 4)).toBe("#111111");
    expect(ballColorFor(palette, null)).toBe("#111111");
  });

  it("puts real participant numbers on the machine balls (unique when there are enough participants)", () => {
    const numbers = Array.from({ length: 655 }, (_, i) => i + 1);
    const labels = sampleNumbers(numbers, 60, createRng(5));
    expect(labels).toHaveLength(60);
    expect(new Set(labels).size).toBe(60);
    expect(labels.every((n) => n >= 1 && n <= 655)).toBe(true);
    expect(sampleNumbers([4, 9, 12], 6)).toEqual([4, 9, 12, 4, 9, 12]);
    // numbers that remain after winners were removed are used as they are, never renumbered
    expect(sampleNumbers([2, 5], 4)).toEqual([2, 5, 2, 5]);
    const sim = createSim(["#111111", "#222222"], createRng(2), 3, [6, 7, 8]);
    expect(sim.balls.map((b) => b.label)).toEqual(["06", "07", "08"]);
    expect(sim.balls[0].color).toBe(ballColorFor(["#111111", "#222222"], 6));
  });
});
