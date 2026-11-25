import { describe, expect, it } from "vitest";
import {
  BALL_COUNT, beginReveal, createRng, createSim, FLOOR_Y, GLOBE_RADIUS, GUIDE_END, settleSim, stepSim, TUBE_TOP_BALL_Y,
} from "./machinePhysics";
import { project } from "./machineCamera";

const colors = ["#e63946", "#2a6fdb", "#f4c430"];

function insideGlobe(sim: ReturnType<typeof createSim>) {
  return sim.balls.every((b) => Math.hypot(b.x, b.y, b.z) <= GLOBE_RADIUS + 0.002 && b.y >= FLOOR_Y + b.r - 0.002);
}

describe("3D lottery globe physics", () => {
  it("settles all balls into a resting pile on the floor, without overlapping", () => {
    const sim = createSim(colors, createRng(7));
    settleSim(sim);
    expect(sim.balls).toHaveLength(BALL_COUNT);
    expect(insideGlobe(sim)).toBe(true);
    expect(sim.balls.every((b) => b.y < FLOOR_Y + 0.9)).toBe(true);
    let minDistance = Infinity;
    for (let i = 0; i < sim.balls.length; i += 1) for (let j = i + 1; j < sim.balls.length; j += 1) {
      const a = sim.balls[i]; const b = sim.balls[j];
      minDistance = Math.min(minDistance, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
    expect(minDistance).toBeGreaterThan(sim.balls[0].r * 2 * 0.8);
  });

  it("lifts and tumbles the balls in three dimensions when the air is on, and keeps them inside the glass", () => {
    const sim = createSim(colors, createRng(11));
    settleSim(sim);
    const mean = (pick: (b: (typeof sim.balls)[number]) => number) => sim.balls.reduce((s, b) => s + pick(b), 0) / sim.balls.length;
    const before = mean((b) => b.y);
    sim.airTarget = 1;
    let highest = -Infinity;
    for (let i = 0; i < 120 * 4; i += 1) {
      stepSim(sim);
      expect(insideGlobe(sim)).toBe(true);
      highest = Math.max(highest, ...sim.balls.map((b) => b.y));
    }
    expect(mean((b) => b.y)).toBeGreaterThan(before + 0.4);
    expect(highest).toBeGreaterThan(0.5);
    // the balls move toward and away from the viewer, not only sideways
    expect(Math.max(...sim.balls.map((b) => Math.abs(b.z)))).toBeGreaterThan(0.4);
  });

  it("brings the selected ball up the chimney to its resting place, whatever the air was doing", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = createSim(colors, createRng(seed));
      settleSim(sim);
      sim.airTarget = 1;
      for (let i = 0; i < 120 * 3; i += 1) stepSim(sim);
      const chosen = beginReveal(sim);
      for (let i = 0; i < Math.ceil(120 * (GUIDE_END + 0.1)); i += 1) stepSim(sim);
      expect(chosen.x).toBeCloseTo(0, 1);
      expect(chosen.z).toBeCloseTo(0, 1);
      expect(chosen.y).toBeCloseTo(TUBE_TOP_BALL_Y, 1);
    }
  });

  it("keeps every other ball inside the globe while one is lifted out", () => {
    const sim = createSim(colors, createRng(9));
    settleSim(sim);
    sim.airTarget = 1;
    for (let i = 0; i < 120 * 2; i += 1) stepSim(sim);
    const chosen = beginReveal(sim);
    for (let i = 0; i < 120 * 3.2; i += 1) {
      stepSim(sim);
      for (const b of sim.balls) if (b !== chosen) expect(Math.hypot(b.x, b.y, b.z)).toBeLessThan(GLOBE_RADIUS + 0.002);
    }
  });
});

describe("perspective camera", () => {
  it("draws nearer things larger and lower, and higher things higher", () => {
    const far = project(0, 0, -1);
    const near = project(0, 0, 1);
    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.y).toBeGreaterThan(far.y);
    expect(project(0, 1, 0).y).toBeLessThan(project(0, 0, 0).y);
    expect(project(0.5, 0, 0).x).toBeGreaterThan(project(-0.5, 0, 0).x);
  });
});
