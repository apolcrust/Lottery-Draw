// 3D physics for the lottery globe. Pure TypeScript (no DOM) so it can be unit-tested.
// World units: the glass globe is a sphere of radius 1 centred on the origin, y points up.

export const GLOBE_RADIUS = 1;
/** Height of the floor (the champagne collar) the balls rest on. */
export const FLOOR_Y = -0.58;

export const BALL_RADIUS = 0.115;
export const BALL_COUNT = 64;

/** The transparent chimney on top of the globe that the winning ball rises into. */
export const TUBE_RADIUS = 0.13;
export const TUBE_BOTTOM_Y = 0.98;
export const TUBE_TOP_Y = 1.62;
/** Where the selected ball waits just under the chimney, and where it comes to rest at the top. */
export const MOUTH_Y = 0.72;
export const TUBE_TOP_BALL_Y = 1.4;

const GRAVITY = 9.8;
const STEP = 1 / 120;
/** Seconds into the reveal when the chosen ball starts being guided into the chimney. */
export const GUIDE_START = 0.8;
/** Seconds into the reveal by which the chosen ball is guaranteed to be at the top of the chimney. */
export const GUIDE_END = 3.0;

export interface Ball {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
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

/** The colour of the ball for a given participant number (their position on the list). */
export function paletteColor(colors: readonly string[], number: number): string {
  const palette = colors.length ? colors : ["#f4c430"];
  return palette[(Math.max(1, number) - 1) % palette.length];
}

/** Numbers printed on the machine's balls: random participant numbers from the real list (unique when possible). */
export function sampleNumbers(numbers: readonly number[], count: number, rng: () => number = Math.random): number[] {
  const pool = numbers.length ? [...numbers] : [1];
  if (pool.length <= count) return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function createSim(colors: readonly string[], rng: () => number = Math.random, count = BALL_COUNT, labels?: readonly number[]): Sim {
  const balls: Ball[] = [];
  for (let i = 0; i < count; i += 1) {
    const number = labels?.[i] ?? i + 1;
    let x = 0; let y = 0; let z = 0;
    do {
      x = (rng() - 0.5) * 1.5;
      z = (rng() - 0.5) * 1.5;
      y = FLOOR_Y + BALL_RADIUS + rng() * 1.1;
    } while (Math.hypot(x, y, z) > GLOBE_RADIUS - BALL_RADIUS);
    balls.push({
      x, y, z, vx: 0, vy: 0, vz: 0, r: BALL_RADIUS,
      k: 0.82 + rng() * 0.36,
      seed: rng() * Math.PI * 2,
      color: paletteColor(colors, number),
      label: String(number).padStart(2, "0"),
      guided: false, atMouth: false,
    });
  }
  return { balls, t: 0, air: 0, airTarget: 0, revealT: -1, chosen: null, rng };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function collidePairs(balls: Ball[]) {
  for (let i = 0; i < balls.length; i += 1) {
    const a = balls[i];
    for (let j = i + 1; j < balls.length; j += 1) {
      const b = balls[j];
      if (a.guided && b.guided) continue;
      const dx = b.x - a.x;
      const min = a.r + b.r;
      if (Math.abs(dx) > min) continue;
      const dy = b.y - a.y;
      if (Math.abs(dy) > min) continue;
      const dz = b.z - a.z;
      if (Math.abs(dz) > min) continue;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const nx = dx / d; const ny = dy / d; const nz = dz / d;
      const overlap = min - d;
      if (a.guided) {
        // The selected ball is moved by the guide; the others are pushed out of its way.
        b.x += nx * overlap; b.y += ny * overlap; b.z += nz * overlap;
      } else if (b.guided) {
        a.x -= nx * overlap; a.y -= ny * overlap; a.z -= nz * overlap;
      } else {
        const half = overlap * 0.5;
        a.x -= nx * half; a.y -= ny * half; a.z -= nz * half;
        b.x += nx * half; b.y += ny * half; b.z += nz * half;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
        if (vn < 0) {
          const impulse = -(1 + 0.55) * vn / 2;
          a.vx -= impulse * nx; a.vy -= impulse * ny; a.vz -= impulse * nz;
          b.vx += impulse * nx; b.vy += impulse * ny; b.vz += impulse * nz;
        }
      }
    }
  }
}

/** Advances the simulation by one fixed step (1/120 s). `settling` adds heavy damping to build a resting pile. */
export function stepSim(sim: Sim, settling = false) {
  const dt = STEP;
  sim.t += dt;
  const rate = sim.airTarget > sim.air ? 3 : 2.5;
  sim.air += clamp(sim.airTarget - sim.air, -rate * dt, rate * dt);
  const drag = Math.exp(-(settling ? 3 : 0.6) * dt);

  for (const ball of sim.balls) {
    if (ball.guided) continue;
    let ax = 0; let ay = -GRAVITY; let az = 0;
    if (sim.air > 0.001) {
      const height = Math.max(0, ball.y - FLOOR_Y);
      const rho = Math.hypot(ball.x, ball.z);
      // an air jet from the hub in the middle of the floor: a fountain that rises in the centre and falls at the sides
      const column = 0.55 + 0.45 * Math.exp(-((rho / 0.7) ** 2));
      const pulse = 0.72 + 0.5 * Math.sin(sim.t * 1.9 + ball.seed * 2);
      ay += sim.air * 31 * ball.k * pulse * column * Math.exp(-height / 1.6);
      // swirl around the vertical axis plus turbulence
      const swirl = sim.air * 1.6;
      // a gentle pull toward the axis keeps the balls circulating through the jet instead of hugging the glass
      const pull = sim.air * 5;
      ax += -ball.z * swirl - ball.x * pull + sim.air * (sim.rng() - 0.5) * 9;
      az += ball.x * swirl - ball.z * pull + sim.air * (sim.rng() - 0.5) * 9;
      ax += sim.air * 3.2 * Math.sin(sim.t * 3.1 + ball.seed);
      az += sim.air * 3.2 * Math.cos(sim.t * 2.7 + ball.seed * 1.3);
    }
    ball.vx = (ball.vx + ax * dt) * drag;
    ball.vy = (ball.vy + ay * dt) * drag;
    ball.vz = (ball.vz + az * dt) * drag;
    const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
    if (speed > 6) { const f = 6 / speed; ball.vx *= f; ball.vy *= f; ball.vz *= f; }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.z += ball.vz * dt;
  }

  // chosen ball guidance (reveal)
  if (sim.chosen && sim.revealT >= 0) {
    sim.revealT += dt;
    const ball = sim.chosen;
    if (sim.revealT >= GUIDE_START && !ball.guided) { ball.guided = true; ball.vx = 0; ball.vy = 0; ball.vz = 0; }
    if (ball.guided) {
      if (sim.revealT >= GUIDE_END) {
        ball.x = 0; ball.z = 0; ball.y = TUBE_TOP_BALL_Y; ball.atMouth = true;
      } else if (!ball.atMouth) {
        const dx = -ball.x; const dy = MOUTH_Y - ball.y; const dz = -ball.z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance < 0.02) {
          ball.atMouth = true;
        } else {
          const move = Math.min(distance, Math.min(3.4, distance * 5 + 0.6) * dt);
          ball.x += (dx / distance) * move; ball.y += (dy / distance) * move; ball.z += (dz / distance) * move;
        }
      } else {
        ball.x = 0; ball.z = 0;
        ball.y = Math.min(TUBE_TOP_BALL_Y, ball.y + 0.85 * dt);
      }
    }
  }

  constrain(sim.balls);
  collidePairs(sim.balls);
  collidePairs(sim.balls);
  constrain(sim.balls);
}

/** The globe's glass wall and the floor. */
function constrain(balls: Ball[]) {
  for (const ball of balls) {
    if (ball.guided) continue;
    const dist = Math.hypot(ball.x, ball.y, ball.z);
    const maxDist = GLOBE_RADIUS - ball.r;
    if (dist > maxDist) {
      const nx = ball.x / dist; const ny = ball.y / dist; const nz = ball.z / dist;
      ball.x = nx * maxDist; ball.y = ny * maxDist; ball.z = nz * maxDist;
      const vn = ball.vx * nx + ball.vy * ny + ball.vz * nz;
      if (vn > 0) {
        ball.vx -= 1.6 * vn * nx; ball.vy -= 1.6 * vn * ny; ball.vz -= 1.6 * vn * nz;
      }
    }
    if (ball.y < FLOOR_Y + ball.r) {
      ball.y = FLOOR_Y + ball.r;
      ball.vy = Math.abs(ball.vy) * 0.45;
      ball.vx *= 0.97; ball.vz *= 0.97;
    }
  }
}

/** Lets the balls fall into a resting pile instantly (used for the idle picture). */
export function settleSim(sim: Sim, steps = 800) {
  sim.air = 0; sim.airTarget = 0;
  for (let i = 0; i < steps; i += 1) stepSim(sim, true);
  for (const ball of sim.balls) { ball.vx = 0; ball.vy = 0; ball.vz = 0; }
}

/** Picks the ball closest to the chimney mouth and starts the reveal; it will be labelled and coloured by the caller. */
export function beginReveal(sim: Sim): Ball {
  let best = sim.balls[0];
  let bestDistance = Infinity;
  for (const ball of sim.balls) {
    const distance = Math.hypot(ball.x, ball.y - MOUTH_Y, ball.z);
    if (distance < bestDistance) { best = ball; bestDistance = distance; }
  }
  sim.chosen = best;
  sim.revealT = 0;
  sim.airTarget = 0;
  return best;
}
