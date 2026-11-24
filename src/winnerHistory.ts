import type { Winner } from "./types";

/** Draw order: the first winner first, then every later winner below. (The stored list is newest-first.) */
export function winnersInDrawOrder(winners: readonly Winner[]): Winner[] {
  return [...winners].sort((a, b) => a.drawNumber - b.drawNumber || Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function formatWinnerTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
