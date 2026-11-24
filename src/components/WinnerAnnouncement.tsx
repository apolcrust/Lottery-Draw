import { useEffect, useRef } from "react";
import { Check, Trophy } from "lucide-react";
import type { Winner } from "../types";

interface WinnerAnnouncementProps {
  winner: Winner;
  confetti: boolean;
  autoRemove: boolean;
  colors: string[];
  ballColor?: string;
  onClose: () => void;
}

export function WinnerAnnouncement({ winner, confetti, autoRemove, colors, ballColor, onClose }: WinnerAnnouncementProps) {
  const continueButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    continueButton.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const palette = colors.length ? colors : ["#f4c430"];
  return <div className="modal-backdrop winner-backdrop" role="presentation">
    {confetti && <div className="confetti" aria-hidden="true">{Array.from({ length: 56 }, (_, index) =>
      <i key={index} style={{
        left: `${(index * 37) % 100}%`, backgroundColor: palette[index % palette.length],
        animationDuration: `${2.4 + (index % 10) * 0.17}s`, animationDelay: `${-(index % 18) * 0.23}s`,
        transform: `rotate(${index * 31}deg)`,
      }} />)}</div>}
    <section className="winner-modal" role="dialog" aria-modal="true" aria-labelledby="winner-heading">
      <div className="winner-ball" aria-hidden="true" style={ballColor ? { background: `radial-gradient(circle at 32% 28%, #ffffffb8 0, #fff0 30%), ${ballColor}`, boxShadow: `inset -7px -9px 16px #0006, 0 0 34px ${ballColor}88` } : undefined}><span style={{ fontSize: String(winner.ticketNumber).length >= 3 ? 17 : 24 }}>{String(winner.ticketNumber).padStart(2, "0")}</span></div>
      <div className="winner-icon"><Trophy size={22} /></div>
      <div className="eyebrow">THE LUCKY BALL HAS BEEN DRAWN</div>
      <h2 id="winner-heading">Congratulations!</h2>
      <p className="winner-name">{winner.participant.name}</p>
      {autoRemove && <p className="winner-removed">Has been removed from the draw.</p>}
      <div className="winner-actions">
        <button ref={continueButton} className="button button-primary winner-continue" onClick={onClose}><Check size={16} /> Continue</button>
      </div>
    </section>
  </div>;
}
