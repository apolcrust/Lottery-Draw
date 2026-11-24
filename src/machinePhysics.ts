// Physics for the lottery machine drawn on the canvas. Pure TypeScript (no DOM) so it can be unit-tested.
// Coordinates are "logical" pixels in a 440 x 392 drawing space; the canvas scales them to any screen size.

export const LOGICAL_WIDTH = 440;
export const LOGICAL_HEIGHT = 392;

export const CHAMBER = { left: 106, right: 290, floor: 244, ceiling: 66 } as const;
export const TUBE = { x0: 216, x1: 238, y0: 58, y1: 170 } as const;
export const TUBE_CENTER_X = (TUBE.x0 + TUBE.x1) / 2;
/** Where the selected ball waits just under the tube mouth, and where it comes to rest at the top. */
export const TUBE_MOUTH_Y = 178;
export const TUBE_TOP_BALL_Y = 88;

export const BALL_RADIUS = 7;
export const BALL_COUNT = 60;

const GRAVITY = 900;
const STEP = 1 / 120;
/** Seconds into the reveal when the chosen ball starts being guided into the tube. */
export const GUIDE_START = 0.8;
/** Seconds into the reveal by which the chosen ball is guaranteed to be at the top of the tube. */
export const GUIDE_END = 3.0;

export interface Ball {
  x: number; y: number; vx: number; vy: number;
  r: number;
  /** Per-ball lift multiplier so the balls do not all behave identically. */
  k: number;
  seed: number;
  color: string;
  label: string;
  guided: boolean;
  atMouth: boolean;
}

export interface Sim {
  balls: Ball[];
  t: number;
  /** Current air strength, 0 to 1. */
  air: number;
  airTarget: number;
  /** Seconds since the reveal began, or -1 while not revealing. */
  revealT: number;
  chosen: Ball | null;
  rng: () => number;
}

export function createRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

/** Numbers printed on the machine's balls: random participant numbers from 1..total (unique when possible). */
export function sampleLabels(total: number, count: number, rng: () => number = Math.random): number[] {
  const size = Math.max(1, Math.floor(total));
  if (size <= count) return Array.from({ length: count }, (_, i) => (i % size) + 1);
  const picked = new Set<number>();
  while (picked.size < count) picked.add(1 + Math.floor(rng() * size));
  return [...picked];
}

export function createSim(colors: readonly string[], rng: () => number = Math.random, count = BALL_COUNT, labels?: readonly number[]): Sim {
  const palette = colors.length ? colors : ["#f4c430"];
  const balls: Ball[] = [];
  for (let i = 0; i < count; i += 1) {
    const number = labels?.[i] ?? i + 1;
    balls.push({
      x: CHAMBER.left + BALL_RADIUS + rng() * (CHAMBER.right - CHAMBER.left - 2 * BALL_RADIUS),
      y: CHAMBER.floor - 150 + rng() * 140,
      vx: 0, vy: 0, r: BALL_RADIUS,
      k: 0.82 + rng() * 0.36,
      seed: rng() * Math.PI * 2,
      color: palette[(number - 1) % palette.length],
      label: String(number).padStart(2, "0"),
      guided: false, atMouth: false,
    });
  }
  return { balls, t: 0, air: 0, airTarget: 0, revealT: -1, chosen: null, rng };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function collideWithTube(ball: Ball) {
  const nearestX = clamp(ball.x, TUBE.x0, TUBE.x1);
  const nearestY = clamp(ball.y, TUBE.y0, TUBE.y1);
  const dx = ball.x - nearestX;
  const dy = ball.y - nearestY;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= ball.r * ball.r) return;
  if (distanceSquared === 0) {
    // Centre is inside the tube footprint: push the ball out through the open bottom.
    ball.y = TUBE.y1 + ball.r;
    ball.vy = Math.max(ball.vy, 0);
    return;
  }
  const distance = Math.sqrt(distanceSquared);
  const nx = dx / distance;
  const ny = dy / distance;
  ball.x += nx * (ball.r - distance);
  ball.y += ny * (ball.r - distance);
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    ball.vx -= 1.5 * vn * nx;
    ball.vy -= 1.5 * vn * ny;
  }
}

function collidePairs(balls: Ball[]) {
  for (let i = 0; i < balls.length; i += 1) {
    const a = balls[i];
    for (let j = i + 1; j < balls.length; j += 1) {
      const b = balls[j];
      if (a.guided && b.guided) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = a.r + b.r;
      if (Math.abs(dx) > min || Math.abs(dy) > min) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const nx = dx / d;
      const ny = dy / d;
      const overlap = min - d;
      if (a.guided) {
        // The selected ball is moved by the guide; the others are pushed out of its way.
        b.x += nx * overlap; b.y += ny * overlap;
      } else if (b.guided) {
        a.x -= nx * overlap; a.y -= ny * overlap;
      } else {
        a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const impulse = -(1 + 0.55) * vn / 2;
          a.vx -= impulse * nx; a.vy -= impulse * ny;
          b.vx += impulse * nx; b.vy += impulse * ny;
        }
      }
    }
  }
}

/** Advances the simulation by one fixed step (1/120 s). `settling` adds heavy damping to build a resting pile. */
export function stepSim(sim: Sim, settling = false) {
  const dt = STEP;
  sim.t += dt;
  // ease the air strength toward its target
  const rate = sim.airTarget > sim.air ? 3 : 2.5;
  sim.air += clamp(sim.airTarget - sim.air, -rate * dt, rate * dt);
  const drag = Math.exp(-(settling ? 3 : 0.7) * dt);

  for (const ball of sim.balls) {
    if (ball.guided) continue;
    let ax = 0;
    let ay = GRAVITY;
    if (sim.air > 0.001) {
      const height = Math.max(0, CHAMBER.floor - ball.y);
      ay -= sim.air * 2300 * ball.k * (0.72 + 0.5 * Math.sin(sim.t * 1.9 + ball.seed * 2)) * Math.exp(-height / 135);
      ax = sim.air * (420 * Math.sin(sim.t * 3.1 + ball.y * 0.045 + ball.seed) + (sim.rng() - 0.5) * 900);
    }
    ball.vx = (ball.vx + ax * dt) * drag;
    ball.vy = (ball.vy + ay * dt) * drag;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 520) { ball.vx *= 520 / speed; ball.vy *= 520 / speed; }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
  }

  // chosen ball guidance (reveal)
  if (sim.chosen && sim.revealT >= 0) {
    sim.revealT += dt;
    const ball = sim.chosen;
    if (sim.revealT >= GUIDE_START && !ball.guided) { ball.guided = true; ball.vx = 0; ball.vy = 0; }
    if (ball.guided) {
      if (sim.revealT >= GUIDE_END) {
        ball.x = TUBE_CENTER_X; ball.y = TUBE_TOP_BALL_Y; ball.atMouth = true;
      } else if (!ball.atMouth) {
        const dx = TUBE_CENTER_X - ball.x;
        const dy = TUBE_MOUTH_Y - ball.y;
        const distance = Math.hypot(dx, dy);
        if (distance < 2) {
          ball.atMouth = true;
        } else {
          const speed = Math.min(240, distance * 5 + 30) * dt;
          ball.x += (dx / distance) * Math.min(speed, distance);
          ball.y += (dy / distance) * Math.min(speed, distance);
        }
      } else {
        ball.x = TUBE_CENTER_X;
        ball.y = Math.max(TUBE_TOP_BALL_Y, ball.y - 95 * dt);
      }
    }
  }

  for (const ball of sim.balls) {
    if (ball.guided) continue;
    const { left, right, floor, ceiling } = CHAMBER;
    if (ball.x < left + ball.r) { ball.x = left + ball.r; ball.vx = Math.abs(ball.vx) * 0.65; }
    if (ball.x > right - ball.r) { ball.x = right - ball.r; ball.vx = -Math.abs(ball.vx) * 0.65; }
    if (ball.y > floor - ball.r) { ball.y = floor - ball.r; ball.vy = -Math.abs(ball.vy) * 0.45; ball.vx *= 0.97; }
    if (ball.y < ceiling + ball.r) { ball.y = ceiling + ball.r; ball.vy = Math.abs(ball.vy) * 0.5; }
    collideWithTube(ball);
  }
  collidePairs(sim.balls);
  collidePairs(sim.balls);
}

/** Lets the balls fall into a resting pile instantly (used for the idle picture). */
export function settleSim(sim: Sim, steps = 700) {
  sim.air = 0; sim.airTarget = 0;
  for (let i = 0; i < steps; i += 1) stepSim(sim, true);
  for (const ball of sim.balls) { ball.vx = 0; ball.vy = 0; }
}

/** Picks the ball closest to the tube mouth and starts the reveal; it will be labelled and coloured by the caller. */
export function beginReveal(sim: Sim): Ball {
  let best = sim.balls[0];
  let bestDistance = Infinity;
  for (const ball of sim.balls) {
    const distance = Math.hypot(ball.x - TUBE_CENTER_X, ball.y - TUBE_MOUTH_Y);
    if (distance < bestDistance) { best = ball; bestDistance = distance; }
  }
  sim.chosen = best;
  sim.revealT = 0;
  sim.airTarget = 0;
  return best;
}
