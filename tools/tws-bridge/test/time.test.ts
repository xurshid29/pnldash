import assert from "node:assert/strict";
import { test } from "node:test";
import { nyDate, nyInstant, nyTime } from "../src/time.js";

// nyInstant(date, minutes): the instant New York's clock reads that time on that date. The
// automation's hour (04:00 to 05:00 New York) is worked out with it every day, so it has to be
// right in winter (EST, UTC−5), in summer (EDT, UTC−4) and on the days the clocks change. In 2026
// they change on Sunday 8 March (02:00 EST → 03:00 EDT) and Sunday 1 November (02:00 EDT → 01:00 EST).

const at = (text: string): number => Date.parse(text);

test("nyInstant: winter (EST, UTC−5): 04:00 New York is 09:00 UTC", () => {
  assert.equal(nyInstant("2026-11-25", 4 * 60), at("2026-11-25T09:00:00Z"));
  assert.equal(nyInstant("2026-11-25", 5 * 60), at("2026-11-25T10:00:00Z"));
  assert.equal(nyInstant("2026-01-15", 4 * 60), at("2026-01-15T09:00:00Z"));
  assert.equal(nyInstant("2026-11-25", 0), at("2026-11-25T05:00:00Z"));
  assert.equal(nyInstant("2026-11-25", 9 * 60 + 30), at("2026-11-25T14:30:00Z"));
  // Late in the evening is the next day in UTC.
  assert.equal(nyInstant("2026-11-25", 23 * 60 + 59), at("2026-11-26T04:59:00Z"));
  assert.equal(nyInstant("2026-12-31", 23 * 60 + 59), at("2027-01-01T04:59:00Z"));
});

test("nyInstant: summer (EDT, UTC−4): 04:00 New York is 08:00 UTC", () => {
  assert.equal(nyInstant("2026-07-15", 4 * 60), at("2026-07-15T08:00:00Z"));
  assert.equal(nyInstant("2026-07-15", 5 * 60), at("2026-07-15T09:00:00Z"));
  assert.equal(nyInstant("2026-07-15", 0), at("2026-07-15T04:00:00Z"));
  assert.equal(nyInstant("2026-06-30", 23 * 60 + 59), at("2026-07-01T03:59:00Z"));
});

test("nyInstant: the days the clocks change, and the days after", () => {
  // Spring: midnight is still EST, 04:00 is already EDT.
  assert.equal(nyInstant("2026-03-08", 0), at("2026-03-08T05:00:00Z"));
  assert.equal(nyInstant("2026-03-08", 3 * 60), at("2026-03-08T07:00:00Z"));
  assert.equal(nyInstant("2026-03-08", 4 * 60), at("2026-03-08T08:00:00Z"));
  assert.equal(nyInstant("2026-03-08", 5 * 60), at("2026-03-08T09:00:00Z"));
  assert.equal(nyInstant("2026-03-09", 4 * 60), at("2026-03-09T08:00:00Z"));
  assert.equal(nyInstant("2026-03-09", 5 * 60), at("2026-03-09T09:00:00Z"));
  // The Saturday before is still winter.
  assert.equal(nyInstant("2026-03-07", 4 * 60), at("2026-03-07T09:00:00Z"));
  // Autumn: midnight is still EDT, 04:00 is EST again.
  assert.equal(nyInstant("2026-11-01", 0), at("2026-11-01T04:00:00Z"));
  assert.equal(nyInstant("2026-11-01", 4 * 60), at("2026-11-01T09:00:00Z"));
  assert.equal(nyInstant("2026-11-01", 5 * 60), at("2026-11-01T10:00:00Z"));
  assert.equal(nyInstant("2026-11-02", 4 * 60), at("2026-11-02T09:00:00Z"));
  assert.equal(nyInstant("2026-11-02", 5 * 60), at("2026-11-02T10:00:00Z"));
  // The Saturday before is still summer.
  assert.equal(nyInstant("2026-10-31", 4 * 60), at("2026-10-31T08:00:00Z"));
});

test("nyInstant: every day of two years, 04:00 and 05:00 read back as that date and time in New York", () => {
  for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2028, 0, 1); day += 24 * 60 * 60 * 1000) {
    const date = new Date(day).toISOString().slice(0, 10);
    for (const [minutes, clock] of [
      [4 * 60, "04:00:00"],
      [5 * 60, "05:00:00"],
      [0, "00:00:00"],
      [23 * 60 + 59, "23:59:00"],
    ] as const) {
      const instant = nyInstant(date, minutes);
      assert.equal(nyDate(instant), date, `${date} ${clock}`);
      assert.equal(nyTime(instant), clock, `${date} ${clock}`);
    }
    // The hour is always one hour long, whatever the season.
    assert.equal(nyInstant(date, 5 * 60) - nyInstant(date, 4 * 60), 60 * 60 * 1000, date);
  }
});
