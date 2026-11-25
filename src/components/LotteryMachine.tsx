import { useEffect, useRef, useState } from "react";
import { FOCUS_MS, REVEAL_RISE_MS, type MachinePhase } from "../machineTimeline";
import {
  CAMERA, LOGICAL_HEIGHT, LOGICAL_WIDTH, PITCH_SIN, globeCircle, project, ringEllipse,
} from "../machineCamera";
import {
  BALL_COUNT, FLOOR_Y, GLOBE_RADIUS, TUBE_BOTTOM_Y, TUBE_RADIUS, TUBE_TOP_BALL_Y, TUBE_TOP_Y,
  beginReveal, createSim, sampleLabels, settleSim, stepSim, type Ball, type Sim,
} from "../machinePhysics";

interface LotteryMachineProps {
  phase: MachinePhase;
  /** Number printed on the winning ball: the winner's number on the participant list ("?" until known). */
  ballLabel: string;
  ballColor: string;
  /** Colours of the balls in the machine. */
  colors: string[];
  /** Called once when the "ball rises through the chimney and is pulled into focus" sequence has finished. */
  onRevealComplete: () => void;
  participantCount: number;
}

// Where the winning ball sits at the top of the chimney, as a share of the machine's size.
// The "pulled into focus" overlay starts exactly there.
const TOP = project(0, TUBE_TOP_BALL_Y, 0);
const FOCUS_X = (TOP.x / LOGICAL_WIDTH) * 100;
const FOCUS_Y = (TOP.y / LOGICAL_HEIGHT) * 100;
const FOCUS_START_SIZE = ((2 * 0.115 * TOP.scale) / LOGICAL_WIDTH) * 100;
const FOCUS_SCALE = 36 / FOCUS_START_SIZE;

// ----- static artwork ---------------------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

const GOLD_LIGHT = "#f3dfae";
const GOLD = "#cfa95d";
const GOLD_DARK = "#7a5d2a";

/** A vertical cylinder (pedestal parts): side body with cylindrical shading and a top face. */
function cylinder(ctx: Ctx, yTop: number, yBottom: number, radius: number, stops: [number, string][], topFill: string | CanvasGradient) {
  const top = ringEllipse(yTop, radius);
  const bottom = ringEllipse(yBottom, radius);
  const gradient = ctx.createLinearGradient(top.cx - top.rx, 0, top.cx + top.rx, 0);
  for (const [position, color] of stops) gradient.addColorStop(position, color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(top.cx - top.rx, top.cy);
  ctx.lineTo(bottom.cx - bottom.rx, bottom.cy);
  ctx.ellipse(bottom.cx, bottom.cy, bottom.rx, bottom.ry, 0, Math.PI, 0, true);
  ctx.lineTo(top.cx + top.rx, top.cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = topFill;
  ctx.beginPath();
  ctx.ellipse(top.cx, top.cy, top.rx, top.ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function frontArc(ctx: Ctx, y: number, radius: number, width: number, style: string | CanvasGradient) {
  const e = ringEllipse(y, radius);
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0.04, Math.PI - 0.04);
  ctx.stroke();
}

const BASE_TOP = -1.02;
const BASE_BOTTOM = -1.2;
const COLUMN_BOTTOM = -1.02;
const COLLAR_TOP = FLOOR_Y;
const COLLAR_BOTTOM = FLOOR_Y - 0.1;
const COLUMN_RADIUS = 0.98;
const COLLAR_OUTER = 1.0;
const COLLAR_INNER = 0.86;
const LED_Y = -0.86;

/** Everything behind the balls: glow, shadow, pedestal, collar, floor and the inside back of the globe. */
function drawBackLayer(ctx: Ctx) {
  const globe = globeCircle(GLOBE_RADIUS);
  // soft ambient light behind the machine
  let g = ctx.createRadialGradient(globe.x, globe.y, 10, globe.x, globe.y, 300);
  g.addColorStop(0, "rgba(120, 150, 255, 0.13)");
  g.addColorStop(0.55, "rgba(120, 90, 200, 0.05)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  // contact shadow on the ground
  const ground = ringEllipse(BASE_BOTTOM - 0.01, 1.7);
  g = ctx.createRadialGradient(ground.cx, ground.cy, 4, ground.cx, ground.cy, ground.rx);
  g.addColorStop(0, "rgba(0,0,0,0.75)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(ground.cx, ground.cy);
  ctx.scale(1, ground.ry / ground.rx);
  ctx.translate(-ground.cx, -ground.cy);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(ground.cx, ground.cy, ground.rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // wide base plate
  const baseTop = ringEllipse(BASE_TOP, 1.24);
  g = ctx.createLinearGradient(baseTop.cx - baseTop.rx, 0, baseTop.cx + baseTop.rx, 0);
  g.addColorStop(0, "#1b1a22"); g.addColorStop(0.5, "#2c2a35"); g.addColorStop(1, "#121118");
  cylinder(ctx, BASE_TOP, BASE_BOTTOM, 1.24, [[0, "#0b0a0f"], [0.28, "#2d2b38"], [0.5, "#3a3846"], [0.78, "#17161d"], [1, "#07070a"]], g);
  frontArc(ctx, BASE_TOP, 1.24, 1.6, GOLD);
  // column
  const columnTop = ringEllipse(COLLAR_BOTTOM, COLUMN_RADIUS);
  g = ctx.createLinearGradient(columnTop.cx - columnTop.rx, 0, columnTop.cx + columnTop.rx, 0);
  g.addColorStop(0, "#15141a"); g.addColorStop(1, "#15141a");
  cylinder(ctx, COLLAR_BOTTOM, COLUMN_BOTTOM, COLUMN_RADIUS,
    [[0, "#08080b"], [0.22, "#1d1c25"], [0.42, "#34323f"], [0.55, "#2a2833"], [0.82, "#0e0d13"], [1, "#050507"]], g);
  // collar: a champagne ring the globe sits in
  const collarTop = ringEllipse(COLLAR_TOP, COLLAR_OUTER);
  g = ctx.createLinearGradient(collarTop.cx - collarTop.rx, 0, collarTop.cx + collarTop.rx, 0);
  g.addColorStop(0, GOLD_DARK); g.addColorStop(0.3, GOLD_LIGHT); g.addColorStop(0.6, GOLD); g.addColorStop(1, GOLD_DARK);
  cylinder(ctx, COLLAR_TOP, COLLAR_BOTTOM, COLLAR_OUTER,
    [[0, GOLD_DARK], [0.25, GOLD_LIGHT], [0.5, GOLD], [0.8, "#8c6a30"], [1, "#4a3717"]], g);
  // the floor inside the collar: glossy dark disc with faint rings
  const floor = ringEllipse(COLLAR_TOP, COLLAR_INNER);
  g = ctx.createRadialGradient(floor.cx, floor.cy - floor.ry * 0.3, 4, floor.cx, floor.cy, floor.rx);
  g.addColorStop(0, "#2d2a38"); g.addColorStop(0.6, "#15141b"); g.addColorStop(1, "#08080b");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(floor.cx, floor.cy, floor.rx, floor.ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 0.8;
  for (const ring of [0.3, 0.5, 0.7]) {
    ctx.beginPath(); ctx.ellipse(floor.cx, floor.cy, floor.rx * ring, floor.ry * ring, 0, 0, Math.PI * 2); ctx.stroke();
  }
  // air hub in the middle of the floor
  const hub = ringEllipse(COLLAR_TOP + 0.005, 0.2);
  g = ctx.createLinearGradient(hub.cx - hub.rx, 0, hub.cx + hub.rx, 0);
  g.addColorStop(0, GOLD_DARK); g.addColorStop(0.4, GOLD_LIGHT); g.addColorStop(1, GOLD_DARK);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(hub.cx, hub.cy, hub.rx, hub.ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#050507";
  ctx.beginPath(); ctx.ellipse(hub.cx, hub.cy, hub.rx * 0.55, hub.ry * 0.55, 0, 0, Math.PI * 2); ctx.fill();

  // the inside back of the glass gives the globe depth
  g = ctx.createRadialGradient(globe.x - globe.r * 0.2, globe.y - globe.r * 0.3, globe.r * 0.1, globe.x, globe.y, globe.r);
  g.addColorStop(0, "rgba(70, 90, 140, 0.10)");
  g.addColorStop(0.85, "rgba(30, 38, 70, 0.22)");
  g.addColorStop(1, "rgba(14, 18, 34, 0.45)");
  ctx.save();
  clipAboveCollar(ctx);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(globe.x, globe.y, globe.r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Clips to everything above the front edge of the collar, so the globe appears to sit inside it. */
function clipAboveCollar(ctx: Ctx) {
  const edge = ringEllipse(COLLAR_TOP, COLLAR_OUTER);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(LOGICAL_WIDTH, 0);
  ctx.lineTo(LOGICAL_WIDTH, edge.cy);
  ctx.lineTo(edge.cx + edge.rx, edge.cy);
  ctx.ellipse(edge.cx, edge.cy, edge.rx, edge.ry, 0, 0, Math.PI, false);
  ctx.lineTo(0, edge.cy);
  ctx.closePath();
  ctx.clip();
}

/** The glass: reflections and rim over the balls, the front of the collar, the chimney and its cap. */
function drawFrontLayer(ctx: Ctx) {
  const globe = globeCircle(GLOBE_RADIUS);
  ctx.save();
  clipAboveCollar(ctx);
  // glass body: clear in the middle, brighter toward the edge (fresnel)
  let g = ctx.createRadialGradient(globe.x - globe.r * 0.2, globe.y - globe.r * 0.25, globe.r * 0.2, globe.x, globe.y, globe.r);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.72, "rgba(150,205,255,0.05)");
  g.addColorStop(0.93, "rgba(170,220,255,0.16)");
  g.addColorStop(1, "rgba(225,245,255,0.38)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(globe.x, globe.y, globe.r, 0, Math.PI * 2); ctx.fill();
  // rim light
  g = ctx.createLinearGradient(globe.x - globe.r, globe.y - globe.r, globe.x + globe.r, globe.y + globe.r);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.45, "rgba(140,200,255,0.18)");
  g.addColorStop(0.7, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(200,235,255,0.5)");
  ctx.strokeStyle = g;
  ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.arc(globe.x, globe.y, globe.r - 1, 0, Math.PI * 2); ctx.stroke();
  // main curved highlight, upper left
  ctx.save();
  ctx.translate(globe.x - globe.r * 0.42, globe.y - globe.r * 0.5);
  ctx.rotate(-0.72);
  g = ctx.createLinearGradient(-globe.r * 0.4, 0, globe.r * 0.4, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.35, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(0, 0, globe.r * 0.4, globe.r * 0.09, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // small secondary glints
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath(); ctx.ellipse(globe.x + globe.r * 0.55, globe.y + globe.r * 0.42, globe.r * 0.15, globe.r * 0.04, -0.85, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.beginPath(); ctx.ellipse(globe.x + globe.r * 0.2, globe.y - globe.r * 0.78, globe.r * 0.12, globe.r * 0.03, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // front half of the collar
  const outer = ringEllipse(COLLAR_TOP, COLLAR_OUTER);
  const inner = ringEllipse(COLLAR_TOP, COLLAR_INNER);
  g = ctx.createLinearGradient(outer.cx - outer.rx, 0, outer.cx + outer.rx, 0);
  g.addColorStop(0, GOLD_DARK); g.addColorStop(0.3, GOLD_LIGHT); g.addColorStop(0.62, GOLD); g.addColorStop(1, GOLD_DARK);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(outer.cx, outer.cy, outer.rx, outer.ry, 0, 0, Math.PI, false);
  ctx.ellipse(inner.cx, inner.cy, inner.rx, inner.ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fill();
  frontArc(ctx, COLLAR_TOP, COLLAR_INNER, 1, "rgba(0,0,0,0.5)");

  // intake ring where the chimney meets the globe
  const intake = ringEllipse(TUBE_BOTTOM_Y - 0.02, TUBE_RADIUS * 1.5);
  g = ctx.createLinearGradient(intake.cx - intake.rx, 0, intake.cx + intake.rx, 0);
  g.addColorStop(0, GOLD_DARK); g.addColorStop(0.4, GOLD_LIGHT); g.addColorStop(1, GOLD_DARK);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(intake.cx, intake.cy, intake.rx, intake.ry + 1.5, 0, 0, Math.PI * 2); ctx.fill();

  // the glass chimney
  const tubeBottom = ringEllipse(TUBE_BOTTOM_Y, TUBE_RADIUS);
  const tubeTop = ringEllipse(TUBE_TOP_Y, TUBE_RADIUS);
  g = ctx.createLinearGradient(tubeBottom.cx - tubeBottom.rx, 0, tubeBottom.cx + tubeBottom.rx, 0);
  g.addColorStop(0, "rgba(220,240,255,0.30)");
  g.addColorStop(0.3, "rgba(220,240,255,0.06)");
  g.addColorStop(0.7, "rgba(220,240,255,0.04)");
  g.addColorStop(1, "rgba(220,240,255,0.26)");
  ctx.fillStyle = g;
  ctx.fillRect(tubeBottom.cx - tubeBottom.rx, tubeTop.cy, tubeBottom.rx * 2, tubeBottom.cy - tubeTop.cy);
  ctx.strokeStyle = "rgba(235,248,255,0.6)";
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(tubeBottom.cx - tubeBottom.rx, tubeTop.cy); ctx.lineTo(tubeBottom.cx - tubeBottom.rx, tubeBottom.cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(tubeBottom.cx + tubeBottom.rx, tubeTop.cy); ctx.lineTo(tubeBottom.cx + tubeBottom.rx, tubeBottom.cy); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fillRect(tubeBottom.cx - tubeBottom.rx + 3, tubeTop.cy + 2, 2.4, tubeBottom.cy - tubeTop.cy - 4);
  // champagne cap with a small finial
  g = ctx.createLinearGradient(tubeTop.cx - tubeTop.rx * 1.3, 0, tubeTop.cx + tubeTop.rx * 1.3, 0);
  g.addColorStop(0, GOLD_DARK); g.addColorStop(0.35, GOLD_LIGHT); g.addColorStop(0.7, GOLD); g.addColorStop(1, GOLD_DARK);
  const capTop = ringEllipse(TUBE_TOP_Y + 0.1, TUBE_RADIUS * 1.3);
  const capBottom = ringEllipse(TUBE_TOP_Y, TUBE_RADIUS * 1.3);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(capTop.cx - capTop.rx, capTop.cy);
  ctx.lineTo(capBottom.cx - capBottom.rx, capBottom.cy);
  ctx.ellipse(capBottom.cx, capBottom.cy, capBottom.rx, capBottom.ry, 0, Math.PI, 0, true);
  ctx.lineTo(capTop.cx + capTop.rx, capTop.cy);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = GOLD_LIGHT;
  ctx.beginPath(); ctx.ellipse(capTop.cx, capTop.cy, capTop.rx, capTop.ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = GOLD;
  ctx.beginPath(); ctx.arc(capTop.cx, capTop.cy - 4, 3.2, 0, Math.PI * 2); ctx.fill();
  // tube back lip inside the cap
  ctx.strokeStyle = "rgba(235,248,255,0.45)";
  ctx.beginPath(); ctx.ellipse(tubeBottom.cx, tubeBottom.cy, tubeBottom.rx, tubeBottom.ry, 0, 0, Math.PI); ctx.stroke();
}

function makeSprite(color: string, label: string, scale: number): HTMLCanvasElement {
  const size = Math.max(10, Math.ceil(2 * 21 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const c = size / 2;
  const r = c - 0.5;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  // lacquer shading: dark edge, soft highlight, tiny bright specular
  let gradient = ctx.createRadialGradient(c - r * 0.25, c - r * 0.3, r * 0.1, c, c, r);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.65, "rgba(0,0,0,0.10)");
  gradient.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  gradient = ctx.createRadialGradient(c - r * 0.4, c - r * 0.45, 0, c - r * 0.4, c - r * 0.45, r * 0.6);
  gradient.addColorStop(0, "rgba(255,255,255,0.7)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  // numbered label
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(c, c, r * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#17141a";
  ctx.font = `800 ${Math.round(r * (label.length >= 3 ? 0.46 : label.length === 2 ? 0.62 : 0.78))}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, c, c + r * 0.04);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath(); ctx.arc(c - r * 0.5, c - r * 0.55, r * 0.07, 0, Math.PI * 2); ctx.fill();
  return canvas;
}

// ----- the component ---------------------------------------------------------------------------------------

/** LED colour of the pedestal ring for each phase. */
function ledColor(phase: MachinePhase, now: number): { rgb: string; alpha: number } {
  if (phase === "mixing") return { rgb: "255, 170, 70", alpha: 0.65 + 0.3 * Math.sin(now / 90) };
  if (phase === "revealing") return { rgb: "255, 226, 150", alpha: 0.95 };
  if (phase === "revealed") return { rgb: "255, 214, 120", alpha: 0.85 };
  return { rgb: "94, 242, 214", alpha: 0.5 + 0.2 * Math.sin(now / 700) };
}

/**
 * The lottery machine: a glass globe on an obsidian pedestal, drawn in real perspective on a canvas.
 * Numbered lacquer balls tumble in an air jet; the winning ball is drawn up into a glass chimney on top.
 *   idle      -> balls resting on the floor, LED ring breathing
 *   mixing    -> air jet on, balls circulate in 3D for as long as the draw lasts
 *   revealing -> the air fades, one ball is lifted into the chimney, then pulled into focus
 *   revealed  -> the winning ball stays in focus
 * The machine only presents the draw; the winner is decided by the database / selection engine.
 */
export function LotteryMachine({ phase, ballLabel, ballColor, colors, onRevealComplete, participantCount }: LotteryMachineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim | null>(null);
  const layersRef = useRef<{ back: HTMLCanvasElement; front: HTMLCanvasElement } | null>(null);
  const spritesRef = useRef(new Map<Ball, HTMLCanvasElement>());
  const scaleRef = useRef(1);
  const phaseRef = useRef<MachinePhase>(phase);
  const rafRef = useRef(0);
  const hideChosenRef = useRef(false);
  const labelRef = useRef({ ballLabel, ballColor });
  labelRef.current = { ballLabel, ballColor };
  const colorsKey = colors.join("|");
  const countRef = useRef(participantCount);
  countRef.current = participantCount;
  const completeRef = useRef(onRevealComplete);
  completeRef.current = onRevealComplete;
  const [focus, setFocus] = useState<"off" | "animating" | "done">("off");

  const spriteFor = (ball: Ball) => {
    let sprite = spritesRef.current.get(ball);
    if (!sprite) {
      sprite = makeSprite(ball.color, ball.label, scaleRef.current);
      spritesRef.current.set(ball, sprite);
    }
    return sprite;
  };

  const draw = (now = performance.now()) => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const layers = layersRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !sim || !layers) return;
    const scale = scaleRef.current;
    const current = phaseRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layers.back, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // pedestal LED ring
    const led = ledColor(current, now);
    const ledEllipse = ringEllipse(LED_Y, COLUMN_RADIUS + 0.005);
    for (const [width, strength] of [[9, 0.12], [5, 0.25], [2.2, 0.95]] as const) {
      ctx.strokeStyle = `rgba(${led.rgb}, ${Math.max(0, led.alpha * strength)})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.ellipse(ledEllipse.cx, ledEllipse.cy, ledEllipse.rx, ledEllipse.ry, 0, 0.05, Math.PI - 0.05);
      ctx.stroke();
    }
    // light spilling onto the ground from the LED
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const spill = ringEllipse(BASE_BOTTOM, 1.55);
    const spillGradient = ctx.createRadialGradient(spill.cx, spill.cy, 8, spill.cx, spill.cy, spill.rx);
    spillGradient.addColorStop(0, `rgba(${led.rgb}, ${0.10 * led.alpha})`);
    spillGradient.addColorStop(1, `rgba(${led.rgb}, 0)`);
    ctx.fillStyle = spillGradient;
    ctx.save();
    ctx.translate(spill.cx, spill.cy);
    ctx.scale(1, spill.ry / spill.rx);
    ctx.beginPath(); ctx.arc(0, 0, spill.rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // the jet of air from the hub
    if (sim.air > 0.02) {
      const hub = project(0, FLOOR_Y, 0);
      const jet = ctx.createRadialGradient(hub.x, hub.y, 2, hub.x, hub.y - 40, 70);
      jet.addColorStop(0, `rgba(190, 225, 255, ${0.55 * sim.air})`);
      jet.addColorStop(1, "rgba(190, 225, 255, 0)");
      ctx.fillStyle = jet;
      ctx.beginPath(); ctx.ellipse(hub.x, hub.y - 18, 46, 62, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // shadows of the balls on the floor
    ctx.save();
    ctx.fillStyle = "#000";
    for (const ball of sim.balls) {
      const height = ball.y - FLOOR_Y - ball.r;
      if (height > 0.9 || ball === sim.chosen && hideChosenRef.current) continue;
      const point = project(ball.x, FLOOR_Y + 0.004, ball.z);
      const radius = ball.r * point.scale * (1 + height * 0.35);
      ctx.globalAlpha = Math.max(0, 0.42 - height * 0.5);
      ctx.beginPath(); ctx.ellipse(point.x, point.y, radius, radius * PITCH_SIN, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // balls, far to near
    const projected = sim.balls.map((ball) => ({ ball, p: project(ball.x, ball.y, ball.z) }))
      .filter(({ ball }) => !(ball === sim.chosen && hideChosenRef.current))
      .sort((a, b) => b.p.depth - a.p.depth);
    for (const { ball, p } of projected) {
      const radius = ball.r * p.scale;
      ctx.drawImage(spriteFor(ball), p.x - radius, p.y - radius, radius * 2, radius * 2);
      // balls at the back of the globe are slightly darker, which sells the depth
      const far = Math.min(1, Math.max(0, (p.depth - (CAMERA.distance - 0.9)) / 1.8));
      if (far > 0.02) {
        ctx.fillStyle = `rgba(6, 8, 18, ${far * 0.4})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
      }
    }

    // airborne dust in the jet while mixing
    if (sim.air > 0.05) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 34; i += 1) {
        const phaseOffset = i * 0.61803;
        const travel = ((sim.t * (0.55 + (i % 5) * 0.08) + phaseOffset) % 1);
        const angle = phaseOffset * 9 + sim.t * 1.4;
        const rho = 0.08 + ((i * 37) % 100) / 100 * 0.42;
        const y = FLOOR_Y + 0.05 + travel * 1.45;
        const p = project(Math.cos(angle) * rho, y, Math.sin(angle) * rho);
        ctx.fillStyle = `rgba(210, 235, 255, ${0.28 * sim.air * (1 - travel)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.1 + (i % 3) * 0.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layers.front, 0, 0);

    // chimney light: amber while mixing, bright gold when the ball rises
    if (current === "mixing" || current === "revealing" || current === "revealed") {
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      const top = project(0, TUBE_TOP_Y - 0.2, 0);
      const strength = current === "mixing" ? 0.35 + 0.15 * Math.sin(now / 130) : 0.9;
      const glow = ctx.createRadialGradient(top.x, top.y, 2, top.x, top.y, 62);
      glow.addColorStop(0, `rgba(255, 215, 130, ${0.8 * strength})`);
      glow.addColorStop(0.4, `rgba(255, 170, 80, ${0.3 * strength})`);
      glow.addColorStop(1, "rgba(255, 150, 60, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(top.x - 70, top.y - 70, 140, 140);
      if (current !== "mixing") {
        // a column of light in the chimney while the ball rises
        const bottom = project(0, TUBE_BOTTOM_Y, 0);
        const beam = ctx.createLinearGradient(0, top.y, 0, bottom.y);
        beam.addColorStop(0, `rgba(255, 226, 150, ${0.28 * strength})`);
        beam.addColorStop(1, "rgba(255, 226, 150, 0)");
        ctx.fillStyle = beam;
        ctx.fillRect(top.x - TUBE_RADIUS * top.scale * 0.8, top.y, TUBE_RADIUS * top.scale * 1.6, bottom.y - top.y);
      }
      ctx.restore();
    }
  };

  const rebuildPile = () => {
    // the balls carry random participant numbers, coloured like the participant's marker on the list
    const sim = createSim(colors, Math.random, BALL_COUNT, sampleLabels(Math.max(1, countRef.current), BALL_COUNT));
    settleSim(sim);
    simRef.current = sim;
    spritesRef.current = new Map();
    hideChosenRef.current = false;
  };

  // size the canvas to its container (crisp on every screen) and rebuild the static layers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const width = canvas.clientWidth;
      if (!width) return;
      const pixelRatio = Math.min(2.5, window.devicePixelRatio || 1);
      const scale = (width * pixelRatio) / LOGICAL_WIDTH;
      canvas.width = Math.round(LOGICAL_WIDTH * scale);
      canvas.height = Math.round(LOGICAL_HEIGHT * scale);
      scaleRef.current = scale;
      spritesRef.current = new Map();
      const layer = (paint: (ctx: Ctx) => void) => {
        const element = document.createElement("canvas");
        element.width = canvas.width;
        element.height = canvas.height;
        const context = element.getContext("2d");
        if (context) { context.setTransform(scale, 0, 0, scale, 0, 0); paint(context); }
        return element;
      };
      layersRef.current = { back: layer(drawBackLayer), front: layer(drawFrontLayer) };
      if (!simRef.current) rebuildPile();
      draw();
    };
    resize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    return () => observer?.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a new palette or a different number of participants means a new set of balls
  useEffect(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "revealed") {
      rebuildPile();
      draw();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorsKey, participantCount]);

  // the winner's number can arrive while the ball is already rising: update the ball in the chimney
  useEffect(() => {
    const sim = simRef.current;
    if (!sim?.chosen || (phaseRef.current !== "revealing" && phaseRef.current !== "revealed")) return;
    sim.chosen.label = ballLabel;
    sim.chosen.color = ballColor;
    spritesRef.current.delete(sim.chosen);
    if (!rafRef.current) draw();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ballLabel, ballColor]);

  useEffect(() => {
    phaseRef.current = phase;
    const timers: number[] = [];
    const stopLoop = () => { window.cancelAnimationFrame(rafRef.current); rafRef.current = 0; };
    const startLoop = (animateOnly = false) => {
      stopLoop();
      let last = performance.now();
      let accumulator = 0;
      let lastPaint = 0;
      const frame = (now: number) => {
        const sim = simRef.current;
        if (!sim) return;
        const elapsed = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!animateOnly) {
          accumulator += elapsed;
          while (accumulator >= 1 / 120) { stepSim(sim); accumulator -= 1 / 120; }
        }
        // the idle picture only needs the LED to breathe, so it repaints at a lower rate
        if (!animateOnly || now - lastPaint > 45) { lastPaint = now; if (!document.hidden) draw(now); }
        rafRef.current = window.requestAnimationFrame(frame);
      };
      rafRef.current = window.requestAnimationFrame(frame);
    };
    const reduced = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();

    if (phase === "idle") {
      setFocus("off");
      rebuildPile();
      draw();
      if (!reduced) startLoop(true); else stopLoop();
    } else if (phase === "mixing") {
      setFocus("off");
      if (!simRef.current) rebuildPile();
      const sim = simRef.current!;
      sim.chosen = null; sim.revealT = -1; hideChosenRef.current = false;
      sim.airTarget = reduced ? 0.6 : 1;
      startLoop();
    } else if (phase === "revealing") {
      setFocus("off");
      if (!simRef.current) rebuildPile();
      const sim = simRef.current!;
      const chosen = beginReveal(sim);
      chosen.label = labelRef.current.ballLabel;
      chosen.color = labelRef.current.ballColor;
      spritesRef.current.delete(chosen);
      hideChosenRef.current = false;
      startLoop();
      timers.push(window.setTimeout(() => { hideChosenRef.current = true; setFocus("animating"); }, REVEAL_RISE_MS));
      timers.push(window.setTimeout(() => { setFocus("done"); completeRef.current(); }, REVEAL_RISE_MS + FOCUS_MS));
    } else {
      // revealed: the winning ball stays in focus (drawn by the overlay)
      const sim = simRef.current;
      if (sim?.chosen) hideChosenRef.current = true;
      setFocus("done");
      if (!reduced) startLoop(true); else { stopLoop(); draw(); }
    }
    return () => { timers.forEach((id) => window.clearTimeout(id)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => window.cancelAnimationFrame(rafRef.current), []);

  const focused = focus !== "off";
  const label = phase === "idle" ? `Lottery machine with ${participantCount} participant${participantCount === 1 ? "" : "s"} ready`
    : phase === "mixing" ? "Lottery machine mixing the balls"
      : phase === "revealing" ? "The winning ball is rising through the glass chimney" : "The winning ball has been drawn";

  return <div className={`lottery-machine${phase === "mixing" ? " is-mixing" : ""}${focused ? " is-focused" : ""}`}
    data-phase={phase}
    style={{
      ["--ball-color" as string]: ballColor, ["--focus-ms" as string]: `${FOCUS_MS}ms`,
      ["--focus-x" as string]: `${FOCUS_X}%`, ["--focus-y" as string]: `${FOCUS_Y}%`,
      ["--focus-size" as string]: `${FOCUS_START_SIZE}%`, ["--focus-scale" as string]: FOCUS_SCALE,
    }}>
    <div className="machine-glow" aria-hidden="true" />
    <canvas ref={canvasRef} className="machine-art" role="img" aria-label={label} />
    {focused && <div className={`focus-ball focus-${focus} digits-${Math.min(3, ballLabel.length)}`} aria-hidden="true">
      <span className="focus-ball-number">{ballLabel}</span>
    </div>}
  </div>;
}

