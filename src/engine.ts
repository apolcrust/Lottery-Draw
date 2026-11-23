import type { Participant, SelectionMode } from "./types";

// Winner selection used by the local (no-Supabase) mode and kept in step with the SQL in
// supabase/schema.sql (begin_lottery_draw). The animation NEVER chooses a winner.

export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1) {
    throw new RangeError("The participant count must be a positive safe integer.");
  }
  const range = 0x1_0000_0000;
  if (maxExclusive > range) throw new RangeError("The participant count exceeds the secure random range.");
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % maxExclusive;
}

export function pickRandomIndex(participants: readonly Participant[]): number {
  if (participants.length === 0) throw new RangeError("There are no eligible participants.");
  return secureRandomInt(participants.length);
}

function totalWeight(participants: readonly Participant[]): number {
  const total = participants.reduce((sum, participant) => {
    if (!Number.isFinite(participant.weight) || participant.weight <= 0) {
      throw new RangeError("Every participant must have a positive, finite weight.");
    }
    return sum + participant.weight;
  }, 0);
  if (!Number.isFinite(total) || total <= 0) throw new RangeError("The total weight is invalid.");
  return total;
}

export function pickWeightedIndex(participants: readonly Participant[]): number {
  if (participants.length === 0) throw new RangeError("There are no eligible participants.");
  totalWeight(participants);
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return weightedIndexForRoll(participants, random[0] / 0x1_0000_0000);
}

export function weightedIndexForRoll(participants: readonly Participant[], roll: number): number {
  if (participants.length === 0) throw new RangeError("There are no eligible participants.");
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError("The weighted roll must be between zero and one.");
  let threshold = roll * totalWeight(participants);
  for (let index = 0; index < participants.length; index += 1) {
    threshold -= participants[index].weight;
    if (threshold < 0) return index;
  }
  return participants.length - 1;
}

/** "weighted" when at least one participant's weight differs from the rest, otherwise "random". */
export function selectionModeFor(participants: readonly Participant[]): SelectionMode {
  const first = participants[0]?.weight;
  return participants.some((participant) => participant.weight !== first) ? "weighted" : "random";
}

export interface LocalSelection {
  index: number;
  mode: SelectionMode;
}

/**
 * Local-mode selection. An armed, eligible predetermined winner wins; otherwise a weighted secure
 * random draw (which is a uniform draw when every weight is 1).
 */
export function selectWinner(
  participants: readonly Participant[],
  overrideId: string | null,
  overrideActivated: boolean,
): LocalSelection {
  if (participants.length === 0) throw new RangeError("There are no eligible participants.");
  if (overrideActivated && overrideId) {
    const index = participants.findIndex((participant) => participant.id === overrideId);
    if (index >= 0) return { index, mode: "controlled" };
  }
  return { index: pickWeightedIndex(participants), mode: selectionModeFor(participants) };
}

export function removeParticipantById(participants: readonly Participant[], id: string): Participant[] {
  return participants.filter((participant) => participant.id !== id);
}

export function consumeOverride(overrideId: string | null, selectedId: string): string | null {
  return overrideId === selectedId ? null : overrideId;
}
