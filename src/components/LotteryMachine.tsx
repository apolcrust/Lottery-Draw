import { useEffect, useRef, useState } from "react";
import {
  FINAL_FRAME, FOCUS_MS, FRAME_COUNT, IDLE_FRAME, MIX_FRAME_MS, MIX_FRAMES, REVEAL_FRAME_MS, REVEAL_FRAMES,
  nextMixFrame, type MachinePhase,
} from "../machineTimeline";

interface LotteryMachineProps {
  phase: MachinePhase;
  /** Number printed on the winning ball (the draw number). Never contains the winner's identity. */
  ballLabel: string;
  ballColor: string;
  /** Called once when the "ball enters the tube and is pulled into focus" sequence has finished. */
  onRevealComplete: () => void;
  participantCount: number;
}

const BASE = import.meta.env.BASE_URL;
export const MACHINE_SPRITE_URL = `${BASE}assets/lottery-machine-frames.webp`;
export const MACHINE_GIF_URL = `${BASE}assets/lottery-machine.gif`;

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The lottery machine. It plays the supplied GIF (439 x 390, 9 frames) under state control:
 *   idle      -> frame 0 (balls resting at the bottom)
 *   mixing    -> frames 1-4 looping for as long as the draw lasts (never freezes)
 *   revealing -> frames 5-8 once: the ball rises through the tube, then it is pulled into focus
 *   revealed  -> holds the final frame with the winning ball in focus
 * The machine only presents the draw; the winner is decided by the database / selection engine.
 */
export function LotteryMachine({ phase, ballLabel, ballColor, onRevealComplete, participantCount }: LotteryMachineProps) {
  const [frame, setFrame] = useState(IDLE_FRAME);
  const [focus, setFocus] = useState<"off" | "animating" | "done">("off");
  const [spriteState, setSpriteState] = useState<"loading" | "ready" | "failed">("loading");
  const frameRef = useRef(IDLE_FRAME);
  const completeRef = useRef(onRevealComplete);
  completeRef.current = onRevealComplete;

  const show = (next: number) => {
    frameRef.current = next;
    setFrame(next);
  };

  useEffect(() => {
    let active = true;
    const image = new Image();
    image.onload = () => { if (active) setSpriteState("ready"); };
    image.onerror = () => { if (active) setSpriteState("failed"); };
    image.src = MACHINE_SPRITE_URL;
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timers: number[] = [];
    const slow = prefersReducedMotion();
    if (phase === "idle") {
      show(IDLE_FRAME);
      setFocus("off");
    } else if (phase === "mixing") {
      setFocus("off");
      show(MIX_FRAMES[0]);
      const interval = window.setInterval(
        () => show(nextMixFrame(frameRef.current, Math.random())),
        slow ? REVEAL_FRAME_MS : MIX_FRAME_MS,
      );
      timers.push(interval);
    } else if (phase === "revealing") {
      setFocus("off");
      REVEAL_FRAMES.forEach((revealFrame, index) => {
        timers.push(window.setTimeout(() => show(revealFrame), index * REVEAL_FRAME_MS));
      });
      // The last GIF frame gets its own 450 ms, then the winning ball is pulled into focus.
      const focusStart = REVEAL_FRAMES.length * REVEAL_FRAME_MS;
      timers.push(window.setTimeout(() => setFocus("animating"), focusStart));
      timers.push(window.setTimeout(() => {
        setFocus("done");
        completeRef.current();
      }, focusStart + FOCUS_MS));
    } else {
      show(FINAL_FRAME);
      setFocus("done");
    }
    return () => {
      timers.forEach((id) => { window.clearTimeout(id); window.clearInterval(id); });
    };
  }, [phase]);

  const mixing = phase === "mixing";
  const focused = focus !== "off";
  const label = phase === "idle" ? `Lottery machine with ${participantCount} participant${participantCount === 1 ? "" : "s"} ready`
    : phase === "mixing" ? "Lottery machine mixing the balls"
      : phase === "revealing" ? "The winning ball is rising through the tube" : "The winning ball has been drawn";

  return <div className={`lottery-machine${mixing ? " is-mixing" : ""}${focused ? " is-focused" : ""}`}
    data-phase={phase} data-frame={frame}
    style={{ ["--ball-color" as string]: ballColor, ["--focus-ms" as string]: `${FOCUS_MS}ms` }}>
    <div className="machine-glow" aria-hidden="true" />
    {spriteState === "failed"
      ? <img className="machine-art machine-art-gif" src={MACHINE_GIF_URL} alt={label} draggable={false} />
      : <div className={`machine-art machine-art-sprite${spriteState === "ready" ? " is-ready" : ""}`} role="img" aria-label={label}
        style={{
          backgroundImage: `url(${MACHINE_SPRITE_URL})`,
          backgroundSize: `${FRAME_COUNT * 100}% 100%`,
          backgroundPosition: `${(frame / (FRAME_COUNT - 1)) * 100}% 0`,
        }} />}
    {focused && <div className={`focus-ball focus-${focus}`} aria-hidden="true">
      <span className="focus-ball-number">{ballLabel}</span>
    </div>}
  </div>;
}

