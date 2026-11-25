import { DEFAULT_DATA, DEFAULT_SETTINGS, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS, type AppData, type LotterySettings } from "./types";

const DATABASE = "lottery-ball-system";
const STORE = "session";
const KEY = "current";

export type DataSource = "backup file" | "saved browser session" | "shared event";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local storage."));
  });
}

export async function loadData(): Promise<AppData> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result ? validateData(request.result, "saved browser session") : structuredClone(DEFAULT_DATA));
      request.onerror = () => reject(request.error ?? new Error("Could not load saved data."));
    });
  } finally {
    db.close();
  }
}

export async function saveData(data: AppData): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(data, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save your changes."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving your changes was aborted."));
    });
  } finally {
    db.close();
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

function isParticipant(participant: unknown): boolean {
  if (!participant || typeof participant !== "object") return false;
  const entry = participant as { id?: unknown; name?: unknown; weight?: unknown };
  return typeof entry.id === "string" && typeof entry.name === "string" &&
    !!entry.name.trim() && entry.name.trim().length <= 100 &&
    typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight > 0;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanSettings(raw: unknown, sourceLabel: string): LotterySettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settings: LotterySettings = {
    title: typeof input.title === "string" ? input.title : DEFAULT_SETTINGS.title,
    duration: input.duration === undefined ? DEFAULT_SETTINGS.duration : (input.duration as number),
    autoRemove: boolOr(input.autoRemove, DEFAULT_SETTINGS.autoRemove),
    sound: boolOr(input.sound, DEFAULT_SETTINGS.sound),
    confetti: boolOr(input.confetti, DEFAULT_SETTINGS.confetti),
    shortcut: typeof input.shortcut === "string" ? input.shortcut : DEFAULT_SETTINGS.shortcut,
    colors: input.colors === undefined ? [...DEFAULT_SETTINGS.colors] : (input.colors as string[]),
    audienceCanDraw: boolOr(input.audienceCanDraw, DEFAULT_SETTINGS.audienceCanDraw),
    audienceCanManageRoster: boolOr(input.audienceCanManageRoster, DEFAULT_SETTINGS.audienceCanManageRoster),
  };
  if (typeof settings.title !== "string" || settings.title.length > 60 ||
      typeof settings.duration !== "number" || !Number.isFinite(settings.duration) ||
      settings.duration < MIN_DURATION_SECONDS || settings.duration > MAX_DURATION_SECONDS ||
      !Array.isArray(settings.colors) || settings.colors.length === 0 ||
      !settings.colors.every((color) => typeof color === "string" && HEX.test(color)) ||
      !settings.shortcut) {
    throw new Error(`${sourceLabel} contains invalid lottery settings.`);
  }
  return settings;
}

export function validateData(value: unknown, source: DataSource = "backup file"): AppData {
  const sourceLabel = source === "saved browser session" ? "The saved browser session" :
    source === "shared event" ? "The shared event" : "The backup file";
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${sourceLabel} contains malformed JSON session data.`);
    }
  }
  if (!value || typeof value !== "object") {
    const storedValue = value === null ? "null" : typeof value;
    throw new Error(
      `${sourceLabel} has no session data (stored value: ${storedValue}). ` +
      "The event may be incomplete. Restore its data from a backup or create a new shared event.",
    );
  }
  const candidate = value as Partial<AppData> & { winners?: unknown[] };
  if (!Array.isArray(candidate.participants) || !Array.isArray(candidate.winners)) {
    throw new Error(`${sourceLabel} must include participant and winner lists.`);
  }
  if (!candidate.participants.every(isParticipant)) {
    throw new Error(`${sourceLabel} contains an invalid participant.`);
  }
  const winners = candidate.winners.map((winner) => {
    if (!winner || typeof winner !== "object") return null;
    const entry = winner as unknown as Record<string, unknown>;
    // Backups made by the original Wheel of Fortune app use "spinNumber"; accept them.
    const drawNumber = entry.drawNumber ?? entry.spinNumber;
    if (!isParticipant(entry.participant) || typeof drawNumber !== "number" || !Number.isInteger(drawNumber) ||
        typeof entry.timestamp !== "string" || !["random", "weighted", "controlled"].includes(entry.mode as string)) return null;
    // Older records have no ticketNumber; fall back to the draw order so they still display.
    const ticketNumber = typeof entry.ticketNumber === "number" && Number.isInteger(entry.ticketNumber) && entry.ticketNumber > 0
      ? entry.ticketNumber : drawNumber;
    return { participant: entry.participant, drawNumber, ticketNumber, timestamp: entry.timestamp, mode: entry.mode };
  });
  if (winners.some((winner) => winner === null)) throw new Error(`${sourceLabel} contains an invalid winner record.`);
  const settings = cleanSettings(candidate.settings, sourceLabel);
  const ids = new Set(candidate.participants.map((participant) => participant.id));
  if (ids.size !== candidate.participants.length) throw new Error(`${sourceLabel} contains duplicate participant IDs.`);
  const overrideId = candidate.overrideParticipantId;
  if (typeof overrideId === "string" && !ids.has(overrideId)) {
    throw new Error(`${sourceLabel} has a one-time pick that is not an active participant.`);
  }
  const rawExcluded = (candidate as { excludedParticipantIds?: unknown }).excludedParticipantIds;
  const excludedParticipantIds = Array.isArray(rawExcluded)
    ? [...new Set(rawExcluded.filter((id): id is string => typeof id === "string" && ids.has(id)))] : [];
  return {
    participants: candidate.participants,
    winners: winners as AppData["winners"],
    settings,
    excludedParticipantIds,
    overrideParticipantId: typeof overrideId === "string" ? overrideId : null,
    overrideActivated: candidate.overrideActivated === true && typeof overrideId === "string" && ids.has(overrideId),
  };
}

/** The shape stored in the shared, publicly readable lottery_events.data column: no operator secrets. */
export function publicEventData(data: AppData): Omit<AppData, "overrideParticipantId" | "overrideActivated" | "excludedParticipantIds"> {
  return { participants: data.participants, winners: data.winners, settings: data.settings };
}
