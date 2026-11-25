// A small perspective camera used to draw the 3D lottery globe on a 2D canvas.
// World units: the glass globe has radius 1, y points up.

export const LOGICAL_WIDTH = 480;
export const LOGICAL_HEIGHT = 468;

export const CAMERA = {
  distance: 7.5,
  /** Radians the camera looks down on the machine. */
  pitch: 0.2,
  /** World height the camera looks at. */
  targetY: 0.32,
  focal: 1040,
  cx: LOGICAL_WIDTH / 2,
  cy: 212,
} as const;

const SIN_P = Math.sin(CAMERA.pitch);
const COS_P = Math.cos(CAMERA.pitch);

export interface Projected {
  x: number;
  y: number;
  /** Distance from the camera (larger = farther away). */
  depth: number;
  /** Logical pixels per world unit at this depth. */
  scale: number;
}

export function project(x: number, y: number, z: number): Projected {
  const yy = y - CAMERA.targetY;
  const camY = yy * COS_P - z * SIN_P;
  const towardCamera = z * COS_P + yy * SIN_P;
  const depth = CAMERA.distance - towardCamera;
  const scale = CAMERA.focal / depth;
  return { x: CAMERA.cx + x * scale, y: CAMERA.cy - camY * scale, depth, scale };
}

/** A horizontal circle of the given radius at height y, as an ellipse on screen. */
export function ringEllipse(y: number, radius: number) {
  const center = project(0, y, 0);
  const rx = radius * center.scale;
  return { cx: center.x, cy: center.y, rx, ry: rx * SIN_P, depth: center.depth };
}

/** Silhouette of a sphere of the given radius centred at the origin. */
export function globeCircle(radius: number) {
  const center = project(0, 0, 0);
  return { x: center.x, y: center.y, r: (CAMERA.focal * radius) / Math.sqrt(center.depth * center.depth - radius * radius) };
}

export const PITCH_SIN = SIN_P;
