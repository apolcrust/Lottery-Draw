/** The colour of the ball for a given participant number (their position on the list). */
export function ballColorFor(colors: readonly string[], number: number | null): string {
  const palette = colors.length ? colors : ["#f4c430"];
  if (number === null || !Number.isInteger(number) || number < 1) return palette[0];
  return palette[(number - 1) % palette.length];
}

/** "6" -> "06", "655" -> "655". This is how participant numbers are shown everywhere. */
export function formatTicket(number: number | null): string {
  return number === null ? "?" : String(number).padStart(2, "0");
}
