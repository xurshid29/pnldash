/** Milliseconds since the epoch. Injected everywhere so tests can move the clock. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The New York calendar date (`YYYY-MM-DD`) of an instant: one US session = one date. */
export function nyDate(ms: number): string {
  let year = "";
  let month = "";
  let day = "";
  for (const part of NEW_YORK.formatToParts(new Date(ms))) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}
