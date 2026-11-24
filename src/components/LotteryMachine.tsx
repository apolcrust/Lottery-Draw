import { useEffect, useRef, useState } from "react";
import { FOCUS_MS, REVEAL_RISE_MS, type MachinePhase } from "../machineTimeline";
import {
  beginReveal, BALL_RADIUS, CHAMBER, createSim, LOGICAL_HEIGHT, LOGICAL_WIDTH, settleSim, stepSim, TUBE, TUBE_CENTER_X,
  type Ball, type Sim,
} from "../machinePhysics";

interface LotteryMachineProps {
  phase: MachinePhase;
  /** Number printed on the winning ball (the draw number). Never contains the winner's identity. */
  ballLabel: string;
  ballColor: string;
  /** Colours of the balls in the machine. */
  colors: string[];
  /** Called once when the "ball rises through the tube and is pulled into focus" sequence has finished. */
  onRevealComplete: () => void;
  participantCount: number;
}

// ----- drawing helpers --------------------------------------------------------------------------------------

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Cabinet, lid, chamber back wall, floor and the back half of the selection tube. */
function drawBackLayer(ctx: CanvasRenderingContext2D) {
  // base cabinet
  let gradient = ctx.createLinearGradient(0, 250, 0, LOGICAL_HEIGHT);
  gradient.addColorStop(0, "#131318");
  gradient.addColorStop(1, "#040405");
  ctx.fillStyle = gradient;
  ctx.fillRect(86, 250, 272, LOGICAL_HEIGHT - 250);
  ctx.fillStyle = "#2c2c34";
  ctx.fillRect(86, 250, 272, 2);
  ctx.fillStyle = "#0a0a0d";
  ctx.fillRect(86, 252, 6, LOGICAL_HEIGHT - 252);
  // small handle slot on the front of the cabinet
  ctx.fillStyle = "#757982";
  roundedRect(ctx, 95, 290, 16, 13, 3); ctx.fill();
  ctx.fillStyle = "#16161b";
  roundedRect(ctx, 98, 293, 10, 7, 2); ctx.fill();

  // lid: top surface and front face
  ctx.fillStyle = "#23232a";
  ctx.beginPath(); ctx.moveTo(92, 9); ctx.lineTo(362, 9); ctx.lineTo(362, 20); ctx.lineTo(76, 20); ctx.closePath(); ctx.fill();
  gradient = ctx.createLinearGradient(0, 20, 0, 60);
  gradient.addColorStop(0, "#1b1b21");
  gradient.addColorStop(1, "#08080a");
  ctx.fillStyle = gradient;
  roundedRect(ctx, 76, 20, 286, 40, 4); ctx.fill();
  ctx.fillStyle = "#34343d";
  ctx.fillRect(78, 20, 282, 1.5);
  // blue knobs on top
  for (const knobX of [196, 232]) {
    ctx.fillStyle = "#1d4fa8";
    ctx.beginPath(); ctx.arc(knobX, 8, 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#4f8df0";
    ctx.beginPath(); ctx.arc(knobX - 1.5, 6.5, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // chamber back wall (dark glass interior)
  gradient = ctx.createLinearGradient(0, 60, 0, 252);
  gradient.addColorStop(0, "rgba(46, 58, 80, 0.62)");
  gradient.addColorStop(0.55, "rgba(22, 27, 38, 0.82)");
  gradient.addColorStop(1, "rgba(10, 12, 17, 0.95)");
  ctx.fillStyle = gradient;
  ctx.fillRect(98, 60, 200, 192);
  // floor of the chamber
  ctx.fillStyle = "rgba(150, 162, 180, 0.30)";
  ctx.fillRect(98, CHAMBER.floor, 200, 8);
  ctx.fillStyle = "rgba(220, 230, 245, 0.45)";
  ctx.fillRect(98, CHAMBER.floor, 200, 1.2);
  // air inlet box on the left of the tube
  ctx.fillStyle = "rgba(180, 196, 218, 0.09)";
  ctx.fillRect(142, 84, 16, 66);
  ctx.strokeStyle = "rgba(200, 212, 230, 0.34)";
  ctx.lineWidth = 1;
  ctx.strokeRect(142.5, 84.5, 15, 65);
  // back half of the selection tube
  ctx.fillStyle = "rgba(214, 228, 248, 0.10)";
  ctx.fillRect(TUBE.x0, TUBE.y0, TUBE.x1 - TUBE.x0, TUBE.y1 - TUBE.y0);
}

/** Glass reflections, rail, the side panel and the front edges of the tube; drawn over the balls. */
function drawFrontLayer(ctx: CanvasRenderingContext2D) {
  // diagonal glare on the front glass
  ctx.fillStyle = "rgba(255, 255, 255, 0.055)";
  ctx.beginPath(); ctx.moveTo(112, 62); ctx.lineTo(176, 62); ctx.lineTo(134, 246); ctx.lineTo(104, 246); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  ctx.beginPath(); ctx.moveTo(240, 62); ctx.lineTo(262, 62); ctx.lineTo(236, 246); ctx.lineTo(222, 246); ctx.closePath(); ctx.fill();
  // horizontal rail
  ctx.fillStyle = "rgba(205, 218, 238, 0.30)";
  ctx.fillRect(98, 186, 200, 3);
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.fillRect(98, 186, 200, 0.9);
  // left glass edge
  ctx.fillStyle = "rgba(190, 206, 228, 0.35)";
  ctx.fillRect(97, 60, 2, 192);
  // frosted side panel on the right
  const gradient = ctx.createLinearGradient(298, 0, 358, 0);
  gradient.addColorStop(0, "rgba(222, 226, 234, 0.58)");
  gradient.addColorStop(1, "rgba(150, 157, 170, 0.50)");
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.moveTo(298, 60); ctx.lineTo(358, 66); ctx.lineTo(358, 240); ctx.lineTo(298, 252); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // tube front edges and lip
  ctx.strokeStyle = "rgba(236, 246, 255, 0.55)";
  ctx.beginPath(); ctx.moveTo(TUBE.x0 + 0.5, TUBE.y0); ctx.lineTo(TUBE.x0 + 0.5, TUBE.y1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(TUBE.x1 - 0.5, TUBE.y0); ctx.lineTo(TUBE.x1 - 0.5, TUBE.y1); ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  ctx.fillRect(TUBE.x0 + 3, TUBE.y0, 2.5, TUBE.y1 - TUBE.y0);
  ctx.strokeStyle = "rgba(236, 246, 255, 0.5)";
  ctx.beginPath(); ctx.ellipse(TUBE_CENTER_X, TUBE.y1, (TUBE.x1 - TUBE.x0) / 2, 3, 0, 0, Math.PI * 2); ctx.stroke();
  // glass top edge
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(98, 58, 200, 4);
}

function makeSprite(color: string, label: string, scale: number): HTMLCanvasElement {
  const size = Math.max(8, Math.ceil(BALL_RADIUS * 2 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const c = size / 2;
  const r = c - 0.5;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  // shading: soft edge darkening and a highlight
  let gradient = ctx.createRadialGradient(c - r * 0.25, c - r * 0.3, r * 0.1, c, c, r);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.7, "rgba(0,0,0,0.08)");
  gradient.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  gradient = ctx.createRadialGradient(c - r * 0.38, c - r * 0.42, 0, c - r * 0.38, c - r * 0.42, r * 0.55);
  gradient.addColorStop(0, "rgba(255,255,255,0.75)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fill();
  // numbered label
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(c, c, r * 0.55, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#17141a";
  ctx.font = `800 ${Math.round(r * (label.length > 1 ? 0.62 : 0.78))}px "DM Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, c, c + r * 0.04);
  return canvas;
}

/**
 * The lottery machine, drawn live on a canvas: a black cabinet with a glass chamber full of numbered balls,
 * an air jet that tosses them around, and a transparent selection tube. States:
 *   idle      -> balls resting in a pile
 *   mixing    -> air on, balls bounce and tumble for as long as the draw lasts
 *   revealing -> air fades, one ball is guided into the tube and rises to the top, then is pulled into focus
 *   revealed  -> the winning ball stays in focus
 * The machine only presents the draw; the winner is decided by the database / selection engine.
 */
export function LotteryMachine({ phase, ballLabel, ballColor, colors, onRevealComplete, participantCount }: LotteryMachineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim | null>(null);
  const layersRef = useRef<{ back: HTMLCanvasElement; front: HTMLCanvasElement; scale: number } | null>(null);
  const spritesRef = useRef(new Map<Ball, HTMLCanvasElement>());
  const scaleRef = useRef(1);
  const phaseRef = useRef<MachinePhase>(phase);
  const rafRef = useRef(0);
  const hideChosenRef = useRef(false);
  const glowRef = useRef(0);
  const labelRef = useRef({ ballLabel, ballColor });
  labelRef.current = { ballLabel, ballColor };
  const colorsKey = colors.join("|");
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

  const draw = () => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const layers = layersRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !sim || !layers) return;
    const scale = scaleRef.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layers.back, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const ball of sim.balls) {
      if (ball === sim.chosen && hideChosenRef.current) continue;
      const sprite = spriteFor(ball);
      ctx.drawImage(sprite, ball.x - BALL_RADIUS, ball.y - BALL_RADIUS, BALL_RADIUS * 2, BALL_RADIUS * 2);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layers.front, 0, 0);
    // red indicator light around the tube while a draw is running
    if (glowRef.current > 0.01) {
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(TUBE_CENTER_X, 84, 2, TUBE_CENTER_X, 84, 52);
      glow.addColorStop(0, `rgba(255, 70, 60, ${0.85 * glowRef.current})`);
      glow.addColorStop(0.35, `rgba(255, 40, 40, ${0.38 * glowRef.current})`);
      glow.addColorStop(1, "rgba(255, 30, 30, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(TUBE_CENTER_X - 56, 40, 112, 100);
      ctx.fillStyle = `rgba(255, 190, 190, ${0.9 * glowRef.current})`;
      ctx.beginPath(); ctx.arc(TUBE_CENTER_X, 66, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  };

  const rebuildPile = () => {
    const sim = createSim(colors);
    settleSim(sim);
    simRef.current = sim;
    spritesRef.current = new Map();
    hideChosenRef.current = false;
    glowRef.current = 0;
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
      const layer = () => {
        const element = document.createElement("canvas");
        element.width = canvas.width;
        element.height = canvas.height;
        const context = element.getContext("2d");
        context?.setTransform(scale, 0, 0, scale, 0, 0);
        return { element, context };
      };
      const back = layer();
      const front = layer();
      if (back.context) drawBackLayer(back.context);
      if (front.context) drawFrontLayer(front.context);
      layersRef.current = { back: back.element, front: front.element, scale };
      if (!simRef.current) rebuildPile();
      draw();
    };
    resize();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    return () => observer?.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a new palette means a new set of balls
  useEffect(() => {
    if (phaseRef.current === "idle" || phaseRef.current === "revealed") {
      rebuildPile();
      draw();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorsKey]);

  useEffect(() => {
    phaseRef.current = phase;
    const timers: number[] = [];
    const stopLoop = () => { window.cancelAnimationFrame(rafRef.current); rafRef.current = 0; };
    const startLoop = () => {
      stopLoop();
      let last = performance.now();
      let accumulator = 0;
      const frame = (now: number) => {
        const sim = simRef.current;
        if (!sim) return;
        const elapsed = Math.min(0.05, (now - last) / 1000);
        last = now;
        accumulator += elapsed;
        while (accumulator >= 1 / 120) { stepSim(sim); accumulator -= 1 / 120; }
        const target = phaseRef.current === "mixing" ? 0.45 + 0.2 * Math.sin(now / 130) : 0.95;
        glowRef.current += (target - glowRef.current) * Math.min(1, elapsed * 6);
        draw();
        rafRef.current = window.requestAnimationFrame(frame);
      };
      rafRef.current = window.requestAnimationFrame(frame);
    };
    const reduced = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } })();

    if (phase === "idle") {
      stopLoop();
      setFocus("off");
      rebuildPile();
      draw();
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
      timers.push(window.setTimeout(() => { setFocus("done"); stopLoop(); draw(); completeRef.current(); }, REVEAL_RISE_MS + FOCUS_MS));
    } else {
      // revealed: the winning ball stays in focus (drawn by the overlay)
      stopLoop();
      const sim = simRef.current;
      if (sim?.chosen) hideChosenRef.current = true;
      glowRef.current = 0.9;
      setFocus("done");
      draw();
    }
    return () => { timers.forEach((id) => window.clearTimeout(id)); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => () => window.cancelAnimationFrame(rafRef.current), []);

  const focused = focus !== "off";
  const label = phase === "idle" ? `Lottery machine with ${participantCount} participant${participantCount === 1 ? "" : "s"} ready`
    : phase === "mixing" ? "Lottery machine mixing the balls"
      : phase === "revealing" ? "The winning ball is rising through the tube" : "The winning ball has been drawn";

  return <div className={`lottery-machine${phase === "mixing" ? " is-mixing" : ""}${focused ? " is-focused" : ""}`}
    data-phase={phase}
    style={{ ["--ball-color" as string]: ballColor, ["--focus-ms" as string]: `${FOCUS_MS}ms` }}>
    <div className="machine-glow" aria-hidden="true" />
    <canvas ref={canvasRef} className="machine-art" role="img" aria-label={label} />
    {focused && <div className={`focus-ball focus-${focus}`} aria-hidden="true">
      <span className="focus-ball-number">{ballLabel}</span>
    </div>}
  </div>;
}

