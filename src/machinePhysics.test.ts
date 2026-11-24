import { describe, expect, it } from "vitest";
import {
  BALL_COUNT, beginReveal, CHAMBER, createRng, createSim, GUIDE_END, settleSim, stepSim, TUBE_CENTER_X, TUBE_TOP_BALL_Y,
} from "./machinePhysics";

const colors = ["#e63946", "#2a6fdb", "#f4c430"];

function inBounds(sim: ReturnType<typeof createSim>) {
  return sim.balls.every((b) => b.x >= CHAMBER.left && b.x <= CHAMBER.right && b.y >= CHAMBER.ceiling && b.y <= CHAMBER.floor + 0.5);
}

describe("lottery machine physics", () => {
  it("settles all balls into a resting pile on the chamber floor, without overlapping", () => {
    const sim = createSim(colors, createRng(7));
    settleSim(sim);
    expect(sim.balls).toHaveLength(BALL_COUNT);
    expect(inBounds(sim)).toBe(true);
    expect(sim.balls.every((b) => b.y > CHAMBER.floor - 110)).toBe(true);
    let minDistance = Infinity;
    for (let i = 0; i < sim.balls.length; i += 1) for (let j = i + 1; j < sim.balls.length; j += 1) {
      minDistance = Math.min(minDistance, Math.hypot(sim.balls[i].x - sim.balls[j].x, sim.balls[i].y - sim.balls[j].y));
    }
    expect(minDistance).toBeGreaterThan(sim.balls[0].r * 2 * 0.8);
  });

  it("lifts and mixes the balls when the air is on, and keeps them inside the chamber", () => {
    const sim = createSim(colors, createRng(11));
    settleSim(sim);
    const before = sim.balls.reduce((sum, b) => sum + b.y, 0) / sim.balls.length;
    sim.airTarget = 1;
    let highest = Infinity;
    for (let i = 0; i < 120 * 4; i += 1) {
      stepSim(sim);
      expect(inBounds(sim)).toBe(true);
      highest = Math.min(highest, ...sim.balls.map((b) => b.y));
    }
    const after = sim.balls.reduce((sum, b) => sum + b.y, 0) / sim.balls.length;
    expect(after).toBeLessThan(before - 40);
    expect(highest).toBeLessThan(CHAMBER.floor - 120);
  });

  it("never lets an unselected ball into the selection tube", () => {
    const sim = createSim(colors, createRng(3));
    settleSim(sim);
    sim.airTarget = 1;
    for (let i = 0; i < 120 * 5; i += 1) {
      stepSim(sim);
      for (const b of sim.balls) {
        const inside = b.x > 216 + 3 && b.x < 238 - 3 && b.y > 58 + 3 && b.y < 170 - 3;
        expect(inside).toBe(false);
      }
    }
  });

  it("brings the selected ball up the tube to its resting place, whatever the air was doing", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = createSim(colors, createRng(seed));
      settleSim(sim);
      sim.airTarget = 1;
      for (let i = 0; i < 120 * 3; i += 1) stepSim(sim);
      const chosen = beginReveal(sim);
      for (let i = 0; i < Math.ceil(120 * (GUIDE_END + 0.1)); i += 1) stepSim(sim);
      expect(chosen.x).toBeCloseTo(TUBE_CENTER_X, 0);
      expect(chosen.y).toBeCloseTo(TUBE_TOP_BALL_Y, 0);
    }
  });
});
