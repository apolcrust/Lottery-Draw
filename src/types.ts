export type SelectionMode = "random" | "weighted" | "controlled";

export interface Participant {
  id: string;
  name: string;
  /** Relative chance of being drawn. 1 = a normal ticket; 3 = three times as likely. */
  weight: number;
}

export interface Winner {
  participant: Participant;
  /** 1-based order of this draw in the event's history (first winner = 1). */
  drawNumber: number;
  /** The winner's number on the participant list at the moment of the draw. This is the number shown on the winning ball. */
  ticketNumber: number;
  timestamp: string;
  mode: SelectionMode;
}

export interface LotterySettings {
  title: string;
  /** Seconds the balls are mixed before the winning ball is revealed (3 to 30). */
  duration: number;
  autoRemove: boolean;
  sound: boolean;
  confetti: boolean;
  /** Operator-only keyboard shortcut (KeyboardEvent.code) that arms the one-time predetermined winner. */
  shortcut: string;
  /** Ball colours used for participant markers, the winning ball and confetti. */
  colors: string[];
  /** When false, only the signed-in event owner can start a draw from an audience screen. */
  audienceCanDraw: boolean;
  /** When false, only the signed-in event owner can add/import/remove participants. */
  audienceCanManageRoster: boolean;
}

export interface AppData {
  participants: Participant[];
  winners: Winner[];
  settings: LotterySettings;
  /**
   * Operator-only. In shared (Supabase) events these two fields are NEVER stored in the public
   * lottery_events.data column; they live in the private lottery_event_secrets table.
   */
  overrideParticipantId: string | null;
  overrideActivated: boolean;
}

export const MIN_DURATION_SECONDS = 3;
export const MAX_DURATION_SECONDS = 30;

export const DEFAULT_SETTINGS: LotterySettings = {
  title: "THE GRAND DRAW",
  duration: 8,
  autoRemove: true,
  sound: true,
  confetti: true,
  shortcut: "KeyO",
  colors: ["#e63946", "#2a6fdb", "#f4c430", "#2fbf71", "#f28c28", "#8e44ad", "#f5f5f5", "#16a6b6"],
  audienceCanDraw: true,
  audienceCanManageRoster: true,
};

export const DEFAULT_DATA: AppData = {
  participants: [],
  winners: [],
  settings: DEFAULT_SETTINGS,
  overrideParticipantId: null,
  overrideActivated: false,
};

/** What the browser knows about an in-flight draw. Deliberately contains NO winner information. */
export interface DrawTicket {
  drawId: string;
  /** ISO timestamp of the moment the database reserved the draw. */
  startedAt: string;
  durationMs: number;
}
