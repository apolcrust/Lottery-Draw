import type { SupabaseClient } from "@supabase/supabase-js";
import { publicEventData, validateData } from "../storage";
import { DEFAULT_DATA, type AppData, type DrawTicket } from "../types";

// Every database operation of the Lottery Ball app goes through this module. It only knows the
// lottery_* tables and *_lottery_* functions of the dedicated Lottery Ball Supabase project.

export const EVENTS_TABLE = "lottery_events";
export const SECRETS_TABLE = "lottery_event_secrets";

export interface LotteryEventRow {
  id: string;
  ownerId: string;
  data: AppData;
  isDrawing: boolean;
  drawStartedAt: string | null;
  drawDurationMs: number | null;
}

export interface OwnedEventSummary {
  id: string;
  title: string;
  participantCount: number;
  winnerCount: number;
  updatedAt: string;
}

export type ParticipantAction = "add" | "remove" | "deduplicate" | "clear";

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error &&
      typeof (error as { message: unknown }).message === "string" && (error as { message: string }).message) {
    return (error as { message: string }).message;
  }
  return fallback;
}

export function isNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network request failed|load failed|timed? ?out|fetch failed|offline/i.test(message);
}

/** The database says "Retry in 1234 ms." when finish_lottery_draw is called too early. */
export function retryDelayFromError(message: string): number | null {
  const match = /retry in (\d+) ms/i.exec(message);
  return match ? Number(match[1]) : null;
}

export function parseEventRow(row: unknown): LotteryEventRow {
  if (!row || typeof row !== "object") throw new Error("The shared lottery event is unavailable.");
  const value = row as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.owner_id !== "string") {
    throw new Error("The shared lottery event is incomplete.");
  }
  return {
    id: value.id,
    ownerId: value.owner_id,
    data: validateData(value.data, "shared event"),
    isDrawing: value.is_drawing === true,
    drawStartedAt: typeof value.draw_started_at === "string" ? value.draw_started_at : null,
    drawDurationMs: typeof value.draw_duration_ms === "number" ? value.draw_duration_ms : null,
  };
}

const EVENT_COLUMNS = "id, owner_id, data, is_drawing, draw_started_at, draw_duration_ms";

export async function fetchLotteryEvent(client: SupabaseClient, eventId: string): Promise<LotteryEventRow | null> {
  const { data, error } = await client.from(EVENTS_TABLE).select(EVENT_COLUMNS).eq("id", eventId).maybeSingle();
  if (error) throw error;
  return data ? parseEventRow(data) : null;
}

export async function listOwnedEvents(client: SupabaseClient, ownerId: string): Promise<OwnedEventSummary[]> {
  const { data, error } = await client.from(EVENTS_TABLE)
    .select("id, data, updated_at")
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []).map((row) => {
    const payload = (row.data ?? {}) as { settings?: { title?: unknown }; participants?: unknown[]; winners?: unknown[] };
    return {
      id: String(row.id),
      title: typeof payload.settings?.title === "string" && payload.settings.title ? payload.settings.title : "Untitled event",
      participantCount: Array.isArray(payload.participants) ? payload.participants.length : 0,
      winnerCount: Array.isArray(payload.winners) ? payload.winners.length : 0,
      updatedAt: String(row.updated_at),
    };
  });
}

export async function createLotteryEvent(client: SupabaseClient, ownerId: string): Promise<string> {
  const { data, error } = await client.from(EVENTS_TABLE)
    .insert({ owner_id: ownerId, data: publicEventData(structuredClone(DEFAULT_DATA)) })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function deleteLotteryEvent(client: SupabaseClient, eventId: string, ownerId: string): Promise<void> {
  const { error } = await client.from(EVENTS_TABLE).delete().eq("id", eventId).eq("owner_id", ownerId);
  if (error) throw error;
}

/** Owner-only save of participants, winners and settings. The predetermined pick is never included. */
export async function saveLotteryEventData(client: SupabaseClient, eventId: string, ownerId: string, data: AppData): Promise<void> {
  const { data: row, error } = await client.from(EVENTS_TABLE)
    .update({ data: publicEventData(data) })
    .eq("id", eventId)
    .eq("owner_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("This account is not allowed to update this lottery event.");
}

export async function fetchOverride(client: SupabaseClient, eventId: string): Promise<{ overrideParticipantId: string | null; overrideActivated: boolean }> {
  const { data, error } = await client.from(SECRETS_TABLE)
    .select("override_participant_id, override_armed")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw error;
  const id = data && typeof data.override_participant_id === "string" ? data.override_participant_id : null;
  return { overrideParticipantId: id, overrideActivated: !!data && data.override_armed === true && id !== null };
}

export async function setOverride(client: SupabaseClient, eventId: string, participantId: string | null, armed: boolean): Promise<void> {
  const { error } = await client.rpc("set_lottery_override", {
    p_event_id: eventId,
    p_participant_id: participantId,
    p_armed: armed,
  });
  if (error) throw error;
}

export function parseDrawTicket(value: unknown): DrawTicket {
  const ticket = value as Partial<DrawTicket> | null;
  if (!ticket || typeof ticket !== "object" || typeof ticket.drawId !== "string" ||
      typeof ticket.startedAt !== "string" || typeof ticket.durationMs !== "number" ||
      !Number.isFinite(ticket.durationMs) || Number.isNaN(Date.parse(ticket.startedAt))) {
    throw new Error("The lottery returned an invalid draw ticket.");
  }
  return { drawId: ticket.drawId, startedAt: ticket.startedAt, durationMs: ticket.durationMs };
}

/** Starts a draw. The database picks the winner privately and returns only the ticket (no winner). */
export async function beginLotteryDraw(client: SupabaseClient, eventId: string): Promise<DrawTicket> {
  const { data, error } = await client.rpc("begin_lottery_draw", { p_event_id: eventId });
  if (error) throw error;
  return parseDrawTicket(data);
}

export interface FinishOptions {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Finalises the draw and returns the updated event data (winner first in `winners`).
 * Safe to retry: the database returns the already-recorded result instead of creating a duplicate winner.
 */
export async function finishLotteryDraw(
  client: SupabaseClient,
  eventId: string,
  drawId: string,
  options: FinishOptions = {},
): Promise<AppData> {
  const attempts = options.attempts ?? 6;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data, error } = await client.rpc("finish_lottery_draw", { p_event_id: eventId, p_draw_id: drawId });
    if (!error) return validateData(data, "shared event");
    lastError = error;
    const message = errorText(error, "");
    const early = retryDelayFromError(message);
    if (early !== null) {
      await sleep(Math.min(5000, early + 150));
    } else if (isNetworkError(message)) {
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
    } else {
      throw error;
    }
  }
  throw lastError ?? new Error("The draw result could not be confirmed.");
}

export async function cancelLotteryDraw(client: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await client.rpc("cancel_lottery_draw", { p_event_id: eventId });
  if (error) throw error;
}

export async function importLotteryParticipants(
  client: SupabaseClient,
  eventId: string,
  input: { names: string[]; weights?: number[]; action: "append" | "replace"; keepDuplicates: boolean },
): Promise<AppData> {
  const { data, error } = await client.rpc("import_lottery_participants", {
    p_event_id: eventId,
    p_names: input.names,
    p_action: input.action,
    p_keep_duplicates: input.keepDuplicates,
    p_weights: input.weights ?? null,
  });
  if (error) throw error;
  return validateData(data, "shared event");
}

export async function manageLotteryParticipants(
  client: SupabaseClient,
  eventId: string,
  action: ParticipantAction,
  participantId?: string,
  name?: string,
): Promise<AppData> {
  const { data, error } = await client.rpc("manage_lottery_participants", {
    p_event_id: eventId,
    p_action: action,
    p_participant_id: participantId ?? null,
    p_name: name ?? null,
  });
  if (error) throw error;
  return validateData(data, "shared event");
}

export interface LotteryEventUpdate {
  row: LotteryEventRow;
  /** Server commit time of this change, when Realtime provides it. Used to estimate clock skew. */
  commitTimestamp: string | null;
}

/** Subscribes to this event's own Realtime channel on the Lottery Ball project. Returns an unsubscribe function. */
export function subscribeToLotteryEvent(
  client: SupabaseClient,
  eventId: string,
  onUpdate: (update: LotteryEventUpdate) => void,
  onProblem: (message: string) => void,
): () => void {
  const channel = client.channel(`lottery-event-${eventId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: EVENTS_TABLE,
      filter: `id=eq.${eventId}`,
    }, (payload) => {
      if (payload.eventType === "DELETE") return;
      const commitTimestamp = typeof (payload as { commit_timestamp?: unknown }).commit_timestamp === "string"
        ? (payload as { commit_timestamp: string }).commit_timestamp : null;
      void (async () => {
        try {
          const incoming = payload.new as Record<string, unknown>;
          // Large unchanged JSON columns can be omitted from the payload; fetch the full row in that case.
          const row = "data" in incoming && incoming.data !== undefined
            ? parseEventRow(incoming)
            : await fetchLotteryEvent(client, eventId);
          if (!row) throw new Error("This lottery event was removed or is no longer available.");
          onUpdate({ row, commitTimestamp });
        } catch (error) {
          onProblem(errorText(error, "The shared lottery data could not be refreshed."));
        }
      })();
    })
    .subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        onProblem(error?.message ?? "Live updates could not connect. Refresh to try again.");
      }
    });
  return () => { void client.removeChannel(channel); };
}

// ----- Interrupted-draw recovery (browser refresh, crash, lost connection) --------------------------------

const PENDING_PREFIX = "lottery-ball-system:pending-draw:";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Remembers the draw ticket (which holds no winner) so a refreshed page can finish the draw it started. */
export function savePendingDraw(eventId: string, ticket: DrawTicket, store: KeyValueStore | null = browserStore()): void {
  try { store?.setItem(PENDING_PREFIX + eventId, JSON.stringify(ticket)); } catch { /* storage unavailable */ }
}

export function loadPendingDraw(eventId: string, store: KeyValueStore | null = browserStore()): DrawTicket | null {
  try {
    const raw = store?.getItem(PENDING_PREFIX + eventId);
    return raw ? parseDrawTicket(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearPendingDraw(eventId: string, store: KeyValueStore | null = browserStore()): void {
  try { store?.removeItem(PENDING_PREFIX + eventId); } catch { /* storage unavailable */ }
}
