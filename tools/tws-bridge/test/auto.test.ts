import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoDecision } from "../src/auto.js";
import type { FeedSetup } from "../src/feed.js";
import { FileJournal, MemoryJournal } from "../src/journal.js";
import { ExitWatch } from "../src/watch.js";
import { until } from "./fake-tws.js";
import { buy, refuses, refusesNow, T0, TOKEN } from "./harness.js";
import {
  autoRig,
  boughtAll,
  boughtPart,
  endedUnfilled,
  expire,
  FEED,
  iso,
  knowMoreTickers,
  pop,
  RecordingJournal,
  soldAtTarget,
  taken,
  tempDir,
  TICKERS,
  W0,
} from "./scenes.js";
import type { AutoRig } from "./scenes.js";

// The automation's half that decides (src/auto.ts): which yellow POPs it buys, in its hour, within
// its budget. Every test drives it with alerts by hand (the feed is a fake that only records its
// starts and stops) over a real bridge on the fake TWS, at W0 = 04:30 New York unless it says.

const SEC = 1000;
const MIN = 60 * SEC;
/** New York 04:00 and 05:00 on the test day (EST, UTC−5): 09:00 and 10:00 UTC. */
const OPEN = Date.parse("2026-11-25T09:00:00Z");
const CLOSE = Date.parse("2026-11-25T10:00:00Z");
/** The same on a summer day (EDT, UTC−4): 08:00 and 09:00 UTC. */
const SUMMER_OPEN = Date.parse("2026-07-15T08:00:00Z");
const SUMMER_CLOSE = Date.parse("2026-07-15T09:00:00Z");
const DAY = 24 * 60 * MIN;

/** The plan of the default buy for an alert at 2.50, decided at `at`, waiting `validSec`. */
function plan(at: number, validSec = 300): Record<string, unknown> {
  return {
    trigger: 2.63,
    limit: 2.66,
    qty: 150,
    take_profit: 3.16,
    stop: 2.36,
    good_until: iso(Math.floor((at + validSec * SEC) / SEC) * SEC),
  };
}

function verdict(decision: AutoDecision | undefined): [string, string] | undefined {
  return decision === undefined ? undefined : [decision.action, decision.reason];
}

const PLACED: [string, string] = ["placed", "placed"];
const WOULD: [string, string] = ["would_place", "would_place"];
const skipped = (reason: string): [string, string] => ["skipped", reason];

/** Sends a POP that must be bought, and has TWS take the bracket; the buy's order id. */
async function placeOne(a: AutoRig, setup: FeedSetup): Promise<number> {
  const decision = await a.send(setup);
  assert.deepEqual(verdict(decision), PLACED, `${setup.ticker}: ${decision?.text}`);
  const id = decision?.order_id ?? Number.NaN;
  taken(a, id);
  return id;
}

/** `blocked`, and whether `blocked_text` goes with it (words when blocked, null when not). */
function blocked(a: AutoRig): [string | null, boolean] {
  const status = a.auto.status();
  const text = status.blocked_text;
  return [status.blocked, status.blocked === null ? text === null : typeof text === "string" && text.length > 0];
}

// ------------------------------------------------------------ which alerts

test("auto: only a POP is looked at; another stage is not decided, counted or logged", async (t) => {
  for (const mode of ["watch", "on"] as const) {
    const a = await autoRig(t, { mode });
    const lines = a.journal.events.length;
    for (const stage of ["back", "turn", "pullback", "broken", "held", "cross", "retest", "ema", "band", "bounce"]) {
      assert.equal(await a.send(pop(W0, { stage })), undefined, `${mode} ${stage}`);
    }
    assert.equal(a.journal.events.length, lines, `${mode}: no line was written`);
    const status = a.auto.status();
    assert.deepEqual(status.decisions, []);
    assert.deepEqual([status.today.strong_pops, status.today.weak_pops, status.today.placed], [0, 0, 0]);
    assert.deepEqual(a.world.allPlaced(), []);
  }
});

test("auto: a gray POP (weak) is counted and logged as an alert, never bought and never a decision", async (t) => {
  for (const mode of ["watch", "on"] as const) {
    const a = await autoRig(t, { mode });
    const gray = pop(W0, { setup: { weak: true, vol_x: 3.1 } });
    assert.equal(await a.send(gray), undefined);
    const status = a.auto.status();
    assert.deepEqual([status.today.weak_pops, status.today.strong_pops, status.decisions.length], [1, 0, 0], mode);
    const alerts = a.journal.ofType("auto_alert");
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0]?.["alert_id"], alerts[0]?.["ticker"], alerts[0]?.["weak"]], [gray.id, "ABCD", true]);
    assert.deepEqual(a.journal.ofType("auto_decision"), []);
    assert.deepEqual(a.world.allPlaced(), []);

    // A yellow one on the same ticker after it is decided as usual.
    assert.deepEqual(verdict(await a.send(pop(W0))), mode === "on" ? PLACED : WOULD);
  }
});

test("auto: off: nothing is decided or logged, nothing is bought, and the feed is stopped", async (t) => {
  const a = await autoRig(t, { mode: "off" });
  assert.deepEqual(a.feed.words(), ["stop"]);
  const lines = a.journal.events.length;
  for (const setup of [pop(W0), pop(W0, { ticker: "WXYZ", setup: { weak: true } }), pop(W0, { ticker: "QQQQ" })]) {
    assert.equal(await a.send(setup), undefined);
  }
  assert.equal(a.journal.events.length, lines);
  const status = a.auto.status();
  assert.deepEqual([status.mode, status.decisions.length, status.today.strong_pops, status.today.weak_pops], ["off", 0, 0, 0]);
  assert.deepEqual(a.world.allPlaced(), []);
  assert.deepEqual(a.feed.words(), ["stop"]);
});

test("auto: watch only: the rule is applied, the decision is would_place with its plan, and TWS is sent nothing", async (t) => {
  const a = await autoRig(t, { mode: "watch" });
  assert.deepEqual(a.feed.words(), [`start ${FEED.server}`]);
  const setup = pop(W0);
  const decision = await a.send(setup);
  assert.deepEqual(decision, {
    at: iso(W0),
    alert_id: setup.id,
    alert_at: setup.at,
    ticker: "ABCD",
    price: 2.5,
    vol_x: 34.5,
    rvol1: 48210,
    mode: "watch",
    action: "would_place",
    reason: "would_place",
    text: decision?.text,
    order_id: null,
    plan: plan(W0),
  });
  assert.match(decision?.text ?? "", /2\.63/);
  assert.deepEqual(a.world.allPlaced(), []);
  assert.deepEqual(a.world.allModified(), []);
  assert.deepEqual(a.world.current.callsOf("cancelOrder"), []);
  assert.deepEqual(a.journal.ofType("order_placed"), []);
  const lines = a.journal.ofType("auto_decision");
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], type: undefined }, { ...decision, type: undefined });

  // The rule holds as if it were placed: the same ticker again while that buy would wait is no second buy.
  assert.deepEqual(verdict(await a.send(pop(W0 + SEC))), skipped("ticker_open"));
});

test("auto: on: the bracket goes to TWS, and the decision says which order it is", async (t) => {
  const a = await autoRig(t);
  const setup = pop(W0);
  const decision = await a.send(setup);
  assert.deepEqual(
    [decision?.mode, decision?.action, decision?.reason, decision?.order_id, decision?.plan],
    ["on", "placed", "placed", 1000, plan(W0)],
  );
  assert.deepEqual(
    a.world.allPlaced().map((p) => [p.id, p.order.action, p.order.orderType]),
    [
      [1000, "BUY", "STP LMT"],
      [1001, "SELL", "LMT"],
      [1002, "SELL", "STP LMT"],
    ],
  );
  assert.equal(a.bridge.orders()[0]?.source, "auto");
  assert.equal(a.journal.ofType("auto_decision").length, 1);
});

// --------------------------------------------------------------- the hour

test("auto: its hour in winter (EST): New York 04:00:00 up to but not 05:00:00, by the alert's time and by the clock", async (t) => {
  const cases: Array<[string, number, number, [string, string]]> = [
    ["04:00:00.000 (09:00 UTC)", OPEN, OPEN, WOULD],
    ["an alert at 03:59:59.999, decided at 04:00:00", OPEN - 1, OPEN, skipped("outside_hours")],
    ["an alert a second before 04:00, decided 5 s into the hour", OPEN - SEC, OPEN + 5 * SEC, skipped("outside_hours")],
    ["04:59:00: a minute left", CLOSE - MIN, CLOSE - MIN, WOULD],
    ["04:59:59: inside the hour, too late for a waiting buy", CLOSE - SEC, CLOSE - SEC, skipped("window_closing")],
    ["05:00:00.000 (10:00 UTC)", CLOSE, CLOSE, skipped("outside_hours")],
    ["an alert at 04:59:58, decided at 05:00:00", CLOSE - 2 * SEC, CLOSE, skipped("outside_hours")],
    ["03:30 New York is 08:30 UTC: outside in winter", Date.parse("2026-11-25T08:30:00Z"), Date.parse("2026-11-25T08:30:00Z"), skipped("outside_hours")],
    ["10:00 New York", T0, T0, skipped("outside_hours")],
  ];
  for (const [what, alertAt, now, expected] of cases) {
    const a = await autoRig(t, { mode: "watch", now });
    assert.deepEqual(verdict(await a.send(pop(alertAt))), expected, what);
  }

  // The same in mode on, where nothing goes to TWS outside it.
  const early = await autoRig(t, { now: OPEN });
  assert.deepEqual(verdict(await early.send(pop(OPEN))), PLACED);
  const late = await autoRig(t, { now: CLOSE });
  assert.deepEqual(verdict(await late.send(pop(CLOSE))), skipped("outside_hours"));
  assert.deepEqual(late.world.allPlaced(), []);

  const status = early.auto.status();
  assert.deepEqual(status.window, { start: "04:00", end: "05:00", tz: "America/New_York", start_at: iso(OPEN), end_at: iso(CLOSE), open: true });
  assert.equal(late.auto.status().window.open, false);
});

test("auto: its hour in summer (EDT): New York 04:00 is 08:00 UTC", async (t) => {
  const cases: Array<[string, number, [string, string]]> = [
    ["04:00:00 EDT = 08:00 UTC", SUMMER_OPEN, WOULD],
    ["03:59:59 EDT", SUMMER_OPEN - SEC, skipped("outside_hours")],
    ["04:30 EDT = 08:30 UTC, outside in winter", SUMMER_OPEN + 30 * MIN, WOULD],
    ["04:59 EDT", SUMMER_CLOSE - MIN, WOULD],
    ["05:00 EDT = 09:00 UTC, inside in winter", SUMMER_CLOSE, skipped("outside_hours")],
  ];
  for (const [what, at, expected] of cases) {
    const a = await autoRig(t, { mode: "watch", now: at });
    assert.deepEqual(verdict(await a.send(pop(at))), expected, what);
  }
  const a = await autoRig(t, { mode: "watch", now: SUMMER_OPEN + 30 * MIN });
  const { window } = a.auto.status();
  assert.deepEqual([window.start_at, window.end_at, window.open], [iso(SUMMER_OPEN), iso(SUMMER_CLOSE), true]);
});

test("auto: an alert older than 60 s when it is decided is late; an alert with no price is not bought", async (t) => {
  const a = await autoRig(t, { mode: "watch" });
  assert.deepEqual(verdict(await a.send(pop(W0 - 60 * SEC))), WOULD, "60 s old is not older than 60 s");
  assert.deepEqual(verdict(await a.send(pop(W0 - 60 * SEC - 1, { ticker: "WXYZ" }))), skipped("late"));
  assert.deepEqual(verdict(await a.send(pop(W0 - 10 * MIN, { ticker: "QQQQ" }))), skipped("late"));
  assert.deepEqual(verdict(await a.send(pop(W0, { ticker: "PENY", price: null }))), skipped("no_price"));

  // The age is the alert's when it is decided, not when it came in: one that waits its turn past 60 s is late.
  const b = await autoRig(t);
  b.auto.onSetup(pop(W0));
  b.clock.now += 61 * SEC;
  await b.auto.idle();
  assert.deepEqual(verdict(b.auto.status().decisions[0]), skipped("late"));
  assert.deepEqual(b.world.allPlaced(), []);
});

test("auto: the same alert again (the feed replays after a reconnect) is not decided again and buys nothing more", async (t) => {
  const a = await autoRig(t);
  const setup = pop(W0);
  assert.deepEqual(verdict(await a.send(setup)), PLACED);
  a.clock.now += 20 * SEC; // past the ticker's duplicate window: only the id can stop it
  a.auto.onSetup({ ...setup });
  a.auto.onSetup({ ...setup, at: iso(a.clock.now) });
  await a.auto.idle();
  assert.equal(a.auto.status().decisions.length, 1);
  assert.equal(a.journal.ofType("auto_decision").length, 1);
  assert.equal(a.world.allPlaced().length, 3);

  // A skipped one is not decided again either, and a gray one is not counted twice.
  const old = pop(W0 - 5 * MIN, { ticker: "WXYZ" });
  await a.send(old);
  await a.send({ ...old });
  const gray = pop(a.clock.now, { ticker: "QQQQ", setup: { weak: true } });
  await a.send(gray);
  await a.send({ ...gray });
  const status = a.auto.status();
  assert.deepEqual([status.decisions.length, status.today.strong_pops, status.today.weak_pops], [2, 2, 1]);
  assert.equal(a.journal.ofType("auto_alert").length, 1);
});

// ------------------------------------------------------- one trade a ticker

test("auto: one trade per ticker a day: once its order on a ticker has filled, even in part, the ticker is done", async (t) => {
  const a = await autoRig(t);
  const id = await placeOne(a, pop(W0));
  boughtPart(a, id, 50);
  a.clock.now += 20 * SEC;
  assert.deepEqual(verdict(await a.send(pop(a.clock.now))), skipped("ticker_done"));

  // The rest of the buy is cancelled and the 50 are sold: nothing is open on it, and it stays done for the day.
  a.world.current.emit("orderStatus", id, "Cancelled", 50, 100, 2.64);
  soldAtTarget(a, id);
  assert.deepEqual(a.bridge.openOrdersFor("ABCD"), []);
  a.clock.now += MIN;
  assert.deepEqual(verdict(await a.send(pop(a.clock.now))), skipped("ticker_done"));
  // Another ticker is not done.
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: "WXYZ" }))), PLACED);
  assert.equal(a.world.allPlaced().length, 6);
});

test("auto: an order still working or still holding on the ticker, clicked or its own, keeps the ticker out", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers });
  const next = async (ticker: string): Promise<AutoDecision | undefined> => {
    a.clock.now += 20 * SEC;
    return a.send(pop(a.clock.now, { ticker }));
  };
  // Its own buy, still waiting.
  await placeOne(a, pop(W0));
  assert.deepEqual(verdict(await next("ABCD")), skipped("ticker_open"));
  // A click whose buy works.
  await a.bridge.order(buy({ ticker: "WXYZ" }));
  assert.deepEqual(verdict(await next("WXYZ")), skipped("ticker_open"));
  // A click that has bought: it holds the shares and its exits work.
  const held = await a.bridge.order(buy({ ticker: "QQQQ" }));
  boughtAll(a, held.order_id, 2.52);
  assert.deepEqual(verdict(await next("QQQQ")), skipped("ticker_open"));
  // A click's stop entry that waits.
  await a.bridge.order(buy({ ticker: "PENY", entry: "stop" }));
  assert.deepEqual(verdict(await next("PENY")), skipped("ticker_open"));
  // A click that bought and sold everything is over, and was no trade of the automation's: the ticker is free.
  const over = await a.bridge.order(buy({ ticker: "EEEE" }));
  boughtAll(a, over.order_id, 2.52);
  soldAtTarget(a, over.order_id);
  assert.deepEqual(verdict(await next("EEEE")), PLACED);
});

test("auto: a waiting buy that ended with nothing filled, cancelled or expired, leaves the ticker free for its next POP", async (t) => {
  const a = await autoRig(t);
  const first = await placeOne(a, pop(W0));
  a.clock.now += 20 * SEC;
  endedUnfilled(a, first);
  const second = await placeOne(a, pop(a.clock.now));
  assert.equal(second, 1003);

  // IB cancels it at its time with nothing filled.
  expire(a, a.world.current, second);
  assert.match(a.bridge.orders().find((order) => order.order_id === second)?.note ?? "", /^expired unfilled/);
  assert.equal(await placeOne(a, pop(a.clock.now)), 1006);
});

// ---------------------------------------------------------------- the budget

test("auto: never more than 5 buys waiting or held at once; a waiting buy that ends unfilled gives its slot back", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers });
  const ids: number[] = [];
  for (const ticker of TICKERS.slice(0, 5)) ids.push(await placeOne(a, pop(a.clock.now, { ticker })));
  let today = a.auto.status().today;
  assert.deepEqual([today.placed, today.waiting, today.held, today.slots_free], [5, 5, 0, 0]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));

  // Held counts as waiting does: two of them fill, the sixth is still refused.
  boughtAll(a, ids[0] ?? 0);
  boughtAll(a, ids[1] ?? 0);
  today = a.auto.status().today;
  assert.deepEqual([today.trades, today.held, today.waiting, today.slots_free], [2, 2, 3, 0]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));

  // A waiting buy ends with nothing filled: its slot is free again, for one buy.
  a.clock.now += 20 * SEC;
  endedUnfilled(a, ids[4] ?? 0);
  assert.equal(a.auto.status().today.slots_free, 1);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), PLACED);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[6] }))), skipped("no_slot"));
  assert.equal(a.world.allPlaced().length, 18);
});

test("auto: a trade that has closed does not give its slot back for the day", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers });
  const ids: number[] = [];
  for (const ticker of TICKERS.slice(0, 5)) ids.push(await placeOne(a, pop(a.clock.now, { ticker })));
  boughtAll(a, ids[0] ?? 0);
  soldAtTarget(a, ids[0] ?? 0);
  const today = a.auto.status().today;
  assert.deepEqual([today.trades, today.held, today.waiting, today.slots_free], [1, 0, 4, 0]);
  a.clock.now += 20 * SEC;
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));
});

test("auto: 5 trades a day: a buy still waiting counts against the trades left, and the sixth trade is day_full", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers });
  // Four trades, each bought and sold.
  for (const ticker of TICKERS.slice(0, 4)) {
    const id = await placeOne(a, pop(a.clock.now, { ticker }));
    boughtAll(a, id);
    soldAtTarget(a, id);
  }
  // The fifth waits: the day's last trade is spoken for.
  const fifth = await placeOne(a, pop(a.clock.now, { ticker: TICKERS[4] }));
  let today = a.auto.status().today;
  assert.deepEqual([today.trades, today.waiting, today.held, today.slots_free], [4, 1, 0, 0]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));

  // It fills and is sold: five trades, nothing open, and the day is full.
  boughtAll(a, fifth);
  soldAtTarget(a, fifth);
  today = a.auto.status().today;
  assert.deepEqual([today.trades, today.waiting, today.held], [5, 0, 0]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("day_full"));
  assert.deepEqual(blocked(a), ["day_full", true]);
  assert.equal(a.world.allPlaced().length, 15);
});

test("auto: at most 30 buys placed a day, filled or not", async (t) => {
  const a = await autoRig(t);
  for (let i = 1; i <= 30; i += 1) {
    const id = await placeOne(a, pop(a.clock.now));
    endedUnfilled(a, id);
    a.clock.now += 11 * SEC; // past the ticker's duplicate window
    assert.equal(a.auto.status().today.placed, i);
  }
  assert.deepEqual(verdict(await a.send(pop(a.clock.now))), skipped("daily_limit"));
  assert.equal(a.world.allPlaced().length, 90);
});

test("auto: clicked orders count against none of its limits", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers });
  // Six clicks: three bought and held, two bought and sold, one still working.
  const clicks: number[] = [];
  for (const ticker of TICKERS.slice(1, 7)) clicks.push((await a.bridge.order(buy({ ticker }))).order_id);
  for (const id of clicks.slice(0, 5)) boughtAll(a, id, 2.52);
  for (const id of clicks.slice(3, 5)) soldAtTarget(a, id);
  assert.deepEqual(a.auto.status().today, {
    date: "2026-11-25",
    strong_pops: 0,
    weak_pops: 0,
    placed: 0,
    trades: 0,
    waiting: 0,
    held: 0,
    slots_free: 5,
  });
  assert.deepEqual(blocked(a), [null, true]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now))), PLACED);
});

test("auto: its orders count against none of the clicks' limits, and the clicks' day does not stop it", async (t) => {
  const a = await autoRig(t, { world: knowMoreTickers, config: (c) => (c.limits.maxOrdersPerDay = 2) });
  for (const ticker of TICKERS.slice(0, 3)) await placeOne(a, pop(a.clock.now, { ticker }));
  const preview = await a.bridge.preview(buy({ ticker: TICKERS[3] }));
  assert.equal(preview.checks.find((check) => check.name === "daily")?.detail, "order 1 of 2 today");
  await a.bridge.order(buy({ ticker: TICKERS[3] }));
  await a.bridge.order(buy({ ticker: TICKERS[4] }));
  await refuses(a.bridge.order(buy({ ticker: TICKERS[5] })), 409, "daily_limit", /: 2 of 2 today/);
  // The clicks are done for the day; the automation is not.
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), PLACED);
});

test("auto: no buy waits past the end of its hour; with under 10 s left none is placed", async (t) => {
  const at = CLOSE - 2 * MIN; // 04:58:00 New York
  const a = await autoRig(t, { now: at });
  const decision = await a.send(pop(at));
  assert.deepEqual(verdict(decision), PLACED);
  assert.equal(decision?.plan?.good_until, iso(CLOSE));
  const [record] = a.bridge.orders();
  assert.equal(record?.sent.good_until, iso(CLOSE));
  assert.deepEqual([a.world.allPlaced()[0]?.order.tif, a.world.allPlaced()[0]?.order.goodTillDate], ["GTD", "20261125-10:00:00"]);

  // Watch only plans it the same way.
  const w = await autoRig(t, { mode: "watch", now: at });
  assert.deepEqual((await w.send(pop(at)))?.plan, plan(at, 120));

  // 10 s left: it still goes, good till 05:00:00. Under 10 s: it does not.
  const ten = await autoRig(t, { now: CLOSE - 10 * SEC });
  const last = await ten.send(pop(CLOSE - 10 * SEC));
  assert.deepEqual([...(verdict(last) ?? []), last?.plan?.good_until], [...PLACED, iso(CLOSE)]);
  const nine = await autoRig(t, { now: CLOSE - 9999 });
  assert.deepEqual(verdict(await nine.send(pop(CLOSE - 9999))), skipped("window_closing"));
  assert.deepEqual(nine.world.allPlaced(), []);
});

// ------------------------------------------------------------- the rails (on)

test("auto: in mode on, switched off, halted, TWS not connected or TWS offline is a skip, and nothing is sent", async (t) => {
  const disabled = await autoRig(t, { config: (c) => (c.enabled = false) });
  assert.deepEqual(verdict(await disabled.send(pop(W0))), skipped("disabled"));
  const halted = await autoRig(t, { config: (c) => (c.halted = true) });
  assert.deepEqual(verdict(await halted.send(pop(W0))), skipped("halted"));
  const down = await autoRig(t, { world: (w) => (w.mode = "refuse"), connect: false });
  assert.deepEqual(verdict(await down.send(pop(W0))), skipped("tws_down"));
  const offline = await autoRig(t);
  offline.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  assert.deepEqual(verdict(await offline.send(pop(W0))), skipped("tws_offline"));
  for (const r of [disabled, halted, down, offline]) {
    assert.deepEqual(r.world.allPlaced(), []);
    assert.equal(r.auto.status().decisions[0]?.order_id, null);
  }
  // Back online, the next POP goes.
  offline.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  assert.deepEqual(verdict(await offline.send(pop(W0, { ticker: "WXYZ" }))), PLACED);
});

test("auto: an account that is not a paper one is not_paper, also with paperOnly off while auto.paperOnly holds", async (t) => {
  const live = (w: { accounts: string | null }): void => void (w.accounts = "U7654321");
  const a = await autoRig(t, { world: live });
  assert.deepEqual(verdict(await a.send(pop(W0))), skipped("not_paper"));

  // paperOnly off for clicks: the automation's own lock still holds, and a click may trade that account.
  const b = await autoRig(t, { world: live, config: (c) => (c.paperOnly = false) });
  assert.equal(b.config.auto.paperOnly, true);
  assert.deepEqual(verdict(await b.send(pop(W0))), skipped("not_paper"));
  assert.deepEqual(b.world.allPlaced(), []);
  b.clock.now += 20 * SEC;
  assert.equal((await b.bridge.order(buy({ ticker: "WXYZ" }))).order_id, 1000);
  assert.equal(b.bridge.orders()[0]?.source, "click");

  // Only with both locks off by hand does it buy on a live account.
  const c = await autoRig(t, {
    world: live,
    config: (cfg) => {
      cfg.paperOnly = false;
      cfg.auto.paperOnly = false;
    },
  });
  assert.deepEqual(verdict(await c.send(pop(W0))), PLACED);
});

test("auto: TWS refusing the buy, or another refusal of the bridge, is failed with the bridge's code and words", async (t) => {
  const refusing = await autoRig(t, {
    ackWaitMs: 500,
    world: (w) => {
      w.onOrder = (ib, id, _order, change) => {
        if (!change && id === 1002) {
          queueMicrotask(() => ib.emit("error", new Error("Order rejected - reason: the contract is not available for trading"), 201, 1000));
        }
      };
    },
  });
  const refused = await refusing.send(pop(W0));
  assert.deepEqual(
    [refused?.action, refused?.reason, refused?.text, refused?.order_id, refused?.plan],
    ["failed", "tws_refused", "TWS refused order 1000: buy: Order rejected - reason: the contract is not available for trading (code 201)", null, null],
  );

  // A ticker TWS does not know.
  const a = await autoRig(t);
  const unknown = await a.send(pop(W0, { ticker: "ZZZZ" }));
  assert.deepEqual([unknown?.action, unknown?.reason, unknown?.text], ["failed", "unknown_ticker", "TWS knows no US stock ZZZZ"]);
  // A buy over the bridge's dollar limit (auto.amountUsd above limits.maxNotionalUsd).
  const big = await autoRig(t, { config: (c) => (c.auto.amountUsd = 1200) });
  const tooLarge = await big.send(pop(W0));
  assert.deepEqual([tooLarge?.action, tooLarge?.reason], ["failed", "too_large"]);
  assert.match(tooLarge?.text ?? "", /above maxNotionalUsd \(\$1000\)/);
  for (const r of [a, big]) assert.deepEqual(r.world.allPlaced(), []);
});

test("auto: the ticker's duplicate window (10 s) is a skip, not a failure", async (t) => {
  const a = await autoRig(t);
  const click = await a.bridge.order(buy());
  a.world.current.emit("orderStatus", click.order_id, "Cancelled", 0, 100, 0); // over, nothing filled: not open
  a.clock.now += 5 * SEC;
  const decision = await a.send(pop(a.clock.now));
  assert.deepEqual(verdict(decision), skipped("duplicate"));
  assert.match(decision?.text ?? "", /^duplicate: ABCD was ordered 5s ago/);
  assert.equal(a.world.allPlaced().length, 3);
});

// ------------------------------------------------------------- watch only

test("auto: watch only holds a slot and the ticker for each buy it would place, until that buy would stop waiting", async (t) => {
  const a = await autoRig(t, { mode: "watch", world: knowMoreTickers });
  for (const ticker of TICKERS.slice(0, 5)) assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker }))), WOULD, ticker);
  const today = a.auto.status().today;
  // In watch only, `placed` and `waiting` are the buys it would have placed and would have waiting.
  assert.deepEqual([today.placed, today.waiting, today.slots_free], [5, 5, 0]);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: "ABCD" }))), skipped("ticker_open"));

  // A moment before those buys would have stopped waiting: still held.
  a.clock.now = W0 + 300 * SEC - 1;
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));
  // At that time they are free again, slot and ticker.
  a.clock.now = W0 + 300 * SEC;
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), WOULD);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: "ABCD" }))), WOULD);
  assert.deepEqual(a.world.allPlaced(), []);
});

test("auto: switching the mode forgets watch only's imagined buys", async (t) => {
  for (const via of ["off", "on"] as const) {
    const a = await autoRig(t, { mode: "watch", world: knowMoreTickers });
    for (const ticker of TICKERS.slice(0, 5)) await a.send(pop(a.clock.now, { ticker }));
    assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));
    a.auto.setMode({ mode: via });
    a.auto.setMode({ mode: "watch" });
    assert.equal(a.auto.status().today.waiting, 0, via);
    assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: TICKERS[5] }))), WOULD, via);
    assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker: "ABCD" }))), WOULD, via);
  }
});

test("auto: watch only counts the buys it would have placed against the 30 a day", async (t) => {
  const a = await autoRig(t, { mode: "watch", now: OPEN, world: knowMoreTickers });
  // Five at a time, each imagined for its 300 s: six rounds make 30 by 04:30.
  for (let round = 0; round < 6; round += 1) {
    for (const ticker of TICKERS.slice(0, 5)) assert.deepEqual(verdict(await a.send(pop(a.clock.now, { ticker }))), WOULD);
    a.clock.now += 300 * SEC;
  }
  assert.equal(a.auto.status().today.placed, 30);
  assert.deepEqual(verdict(await a.send(pop(a.clock.now))), skipped("daily_limit"));
  assert.deepEqual(a.world.allPlaced(), []);
});

// ---------------------------------------------------------------- the switch

test("auto: setMode takes only { mode: off | watch | on }", async (t) => {
  const a = await autoRig(t, { mode: "watch" });
  const lines = a.journal.ofType("auto_mode").length;
  const bodies: unknown[] = [{ mode: "ON" }, { mode: "auto" }, { mode: "" }, { mode: null }, { mode: true }, {}, { mode: "on", extra: 1 }, null, [], "on", 1];
  for (const body of bodies) refusesNow(() => a.auto.setMode(body), 400, "bad_request");
  assert.equal(a.auto.mode, "watch");
  assert.deepEqual(a.savedStates, []);
  assert.equal(a.journal.ofType("auto_mode").length, lines);
  assert.deepEqual(a.feed.words(), [`start ${FEED.server}`]);
});

test("auto: setMode switches at once, saves state.json, starts or stops the feed, and logs it", async (t) => {
  const a = await autoRig(t, { mode: "off" });
  assert.deepEqual(a.feed.words(), ["stop"]);

  const watching = a.auto.setMode({ mode: "watch" });
  assert.deepEqual([watching.mode, a.auto.mode], ["watch", "watch"]);
  assert.deepEqual(a.savedStates.at(-1), { auto: { mode: "watch" }, feed: { ...FEED } });
  assert.deepEqual(a.feed.calls.at(-1), { call: "start", server: FEED.server, token: FEED.token });
  assert.deepEqual(a.journal.ofType("auto_mode").at(-1), { type: "auto_mode", mode: "watch", was: "off" });

  a.auto.setMode({ mode: "on" });
  assert.deepEqual([a.savedStates.at(-1)?.auto.mode, a.feed.calls.at(-1)?.call], ["on", "start"]);
  assert.deepEqual(a.journal.ofType("auto_mode").at(-1), { type: "auto_mode", mode: "on", was: "watch" });

  a.auto.setMode({ mode: "off" });
  assert.deepEqual([a.savedStates.at(-1)?.auto.mode, a.feed.calls.at(-1)?.call], ["off", "stop"]);
  assert.equal(a.feed.status().state, "off");

  // Not paired: the mode is switched, and there is no feed to start.
  const b = await autoRig(t, { mode: "off", paired: false });
  b.auto.setMode({ mode: "on" });
  assert.equal(b.auto.mode, "on");
  assert.deepEqual(b.feed.calls.filter((call) => call.call === "start"), []);
  assert.deepEqual(b.savedStates.at(-1), { auto: { mode: "on" }, feed: null });
});

test("auto: a setMode whose save fails is a 500 not_saved, and the mode has changed all the same", async (t) => {
  const a = await autoRig(t, {
    mode: "off",
    saveState: () => {
      throw new Error("disk full");
    },
  });
  refusesNow(() => a.auto.setMode({ mode: "on" }), 500, "not_saved", /disk full/);
  assert.equal(a.auto.mode, "on");
  assert.equal(a.auto.status().mode, "on");
  assert.equal(a.state.auto.mode, "on");
  assert.deepEqual(a.feed.calls.at(-1), { call: "start", server: FEED.server, token: FEED.token });
  assert.deepEqual(a.journal.ofType("auto_mode").at(-1), { type: "auto_mode", mode: "on", was: "off" });
  // And it acts on it.
  assert.deepEqual(verdict(await a.send(pop(W0))), PLACED);
});

// ------------------------------------------------------------------ pairing

test("auto: pairFeed keeps the server and token, gives the token to the log as a secret before any line, and starts the feed", async (t) => {
  const journal = new RecordingJournal();
  const a = await autoRig(t, { mode: "watch", paired: false, journal });
  assert.deepEqual(a.feed.words(), ["stop"]);
  assert.equal(a.auto.status().feed.paired, false);

  const token = "a-new-feed-token-7c1e9b2f44d0";
  const server = "http://localhost:5173";
  const from = journal.steps.length;
  assert.deepEqual(a.auto.pairFeed({ server, token }), { paired: true, server });
  const steps = journal.steps.slice(from);
  assert.equal(steps[0], "addSecret", JSON.stringify(steps));
  assert.ok(steps.includes("write auto_feed"), JSON.stringify(steps));
  assert.deepEqual(journal.secrets, [token]);
  assert.deepEqual(a.state.feed, { server, token });
  assert.deepEqual(a.savedStates.at(-1), { auto: { mode: "watch" }, feed: { server, token } });
  assert.deepEqual(a.feed.calls.at(-1), { call: "start", server, token });
  assert.equal(a.auto.status().feed.paired, true);

  // A morning after it, the token is in no line the bridge or the automation wrote.
  await a.send(pop(W0));
  a.auto.setMode({ mode: "on" });
  await a.send(pop(W0, { ticker: "WXYZ" }));
  a.auto.pairFeed({ server: FEED.server, token });
  for (const line of journal.lines) assert.ok(!JSON.stringify(line).includes(token), JSON.stringify(line));
  assert.deepEqual(journal.lines.filter((line) => line["type"] === "auto_feed"), [
    { type: "auto_feed", server },
    { type: "auto_feed", server: FEED.server },
  ]);
});

test("auto: pairFeed over a MemoryJournal made with no secrets: no line holds the token, and the log replaces it from then on", async (t) => {
  const journal = new MemoryJournal();
  const a = await autoRig(t, { paired: false, journal });
  const token = "another-feed-token-0d4c7a99e1";
  a.auto.pairFeed({ server: FEED.server, token });
  await a.send(pop(W0));
  assert.ok(journal.events.length > 0);
  for (const event of journal.events) assert.ok(!JSON.stringify(event).includes(token), JSON.stringify(event));
  journal.write("probe", { text: `x ${token} y` });
  assert.deepEqual(journal.ofType("probe"), [{ type: "probe", text: "x [redacted] y" }]);
});

test("auto: pairFeed while off keeps the pairing and starts nothing", async (t) => {
  const a = await autoRig(t, { mode: "off", paired: false });
  a.auto.pairFeed({ server: FEED.server, token: FEED.token });
  assert.deepEqual(a.state.feed, { ...FEED });
  assert.deepEqual(a.feed.calls.filter((call) => call.call === "start"), []);
  // Switched on later, it starts with what it was given.
  a.auto.setMode({ mode: "watch" });
  assert.deepEqual(a.feed.calls.at(-1), { call: "start", server: FEED.server, token: FEED.token });
});

test("auto: pairFeed takes { server, token } only, the server exactly one of allowedOrigins", async (t) => {
  const a = await autoRig(t, { mode: "watch", paired: false });
  const token = FEED.token;
  const bodies: unknown[] = [
    { server: "https://evil.example", token },
    { server: "https://pnldash.uz/", token },
    { server: "https://pnldash.uz/api", token },
    { server: "pnldash.uz", token },
    { server: "http://pnldash.uz", token },
    { server: "https://pnldash.uz:8443", token },
    { server: FEED.server, token: "" },
    { server: FEED.server, token: "two words" },
    { server: FEED.server, token: 42 },
    { server: FEED.server },
    { token },
    { server: FEED.server, token, mode: "on" },
    null,
    [],
    "https://pnldash.uz",
  ];
  const starts = a.feed.calls.length;
  for (const body of bodies) refusesNow(() => a.auto.pairFeed(body), 400, "bad_request");
  assert.equal(a.state.feed, null);
  assert.deepEqual(a.savedStates, []);
  assert.equal(a.feed.calls.length, starts);
  assert.deepEqual(a.journal.ofType("auto_feed"), []);
  // Both of the allowed origins are taken.
  for (const server of a.config.allowedOrigins) assert.deepEqual(a.auto.pairFeed({ server, token }), { paired: true, server });
});

// ------------------------------------------------------------------- status

test("auto: status says why the next POP would not be bought, and null when it would be", async (t) => {
  const ready = await autoRig(t);
  assert.deepEqual(blocked(ready), [null, true]);
  assert.deepEqual(verdict(await ready.send(pop(W0))), PLACED);

  assert.deepEqual(blocked(await autoRig(t, { mode: "off" })), ["off", true]);
  assert.deepEqual(blocked(await autoRig(t, { mode: "watch" })), ["watch", true]);
  assert.deepEqual(blocked(await autoRig(t, { paired: false })), ["no_feed", true]);
  const retrying = await autoRig(t);
  retrying.feed.current = { ...retrying.feed.current, state: "retrying", error: "the server answered 502" };
  assert.deepEqual(blocked(retrying), ["no_feed", true]);
  assert.match(retrying.auto.status().blocked_text ?? "", /the server answered 502/);
  const connecting = await autoRig(t);
  connecting.feed.current = { ...connecting.feed.current, state: "connecting" };
  assert.deepEqual(blocked(connecting), ["no_feed", true]);
  const refused = await autoRig(t);
  refused.feed.current = { ...refused.feed.current, state: "unauthorized", error: "the server refused the token" };
  assert.deepEqual(blocked(refused), ["no_feed", true]);
  assert.deepEqual(blocked(await autoRig(t, { now: T0 })), ["outside_hours", true]);

  // Five buys waiting: no slot.
  const full = await autoRig(t, { world: knowMoreTickers });
  for (const ticker of TICKERS.slice(0, 5)) await placeOne(full, pop(full.clock.now, { ticker }));
  assert.deepEqual(blocked(full), ["no_slot", true]);
});

test("auto: status says each rail of the bridge in blocked", async (t) => {
  const a = await autoRig(t);
  a.config.enabled = false;
  assert.deepEqual(blocked(a), ["disabled", true]);
  a.config.enabled = true;
  a.bridge.halt({ halted: true });
  assert.deepEqual(blocked(a), ["halted", true]);
  a.bridge.halt({ halted: false });
  a.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  assert.deepEqual(blocked(a), ["tws_offline", true]);
  a.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  assert.deepEqual(blocked(a), [null, true]);

  const live = (w: { accounts: string | null }): void => void (w.accounts = "U7654321");
  assert.deepEqual(blocked(await autoRig(t, { world: live })), ["not_paper", true]);
  assert.deepEqual(blocked(await autoRig(t, { world: live, config: (c) => (c.paperOnly = false) })), ["not_paper", true]);
  assert.deepEqual(blocked(await autoRig(t, { world: (w) => (w.mode = "refuse"), connect: false })), ["tws_down", true]);
  // Watch only says it is watching, whatever the rails.
  assert.deepEqual(blocked(await autoRig(t, { mode: "watch", config: (c) => (c.halted = true) })), ["watch", true]);
});

test("auto: the decision says when the take-profit is for a part of the shares, and the status carries the exit's settings", async (t) => {
  const a = await autoRig(t);
  assert.match((await a.send(pop(W0)))?.text ?? "", /, take-profit 3\.16 for 75 of them, stop 2\.36,/);
  const w = await autoRig(t, { mode: "watch" });
  assert.match((await w.send(pop(W0)))?.text ?? "", /, take-profit 3\.16 for 75 of them, stop 2\.36,/);
  // For all of them: no such words.
  const all = await autoRig(t, { config: (c) => (c.auto.takeProfitPortion = 1) });
  const whole = (await all.send(pop(W0)))?.text ?? "";
  assert.match(whole, /, take-profit 3\.16, stop 2\.36,/);
  assert.doesNotMatch(whole, /of them/);

  const { rule } = a.auto.status();
  assert.deepEqual([rule.take_profit_portion, rule.stop_to_entry_at_pct, rule.trail_pct], [0.5, 10, 20]);
  const custom = await autoRig(t, {
    config: (c) => {
      c.auto.takeProfitPortion = 1;
      c.auto.stopToEntryAtPct = 0;
      c.auto.trailPct = 0;
    },
  });
  const plainRule = custom.auto.status().rule;
  assert.deepEqual([plainRule.take_profit_portion, plainRule.stop_to_entry_at_pct, plainRule.trail_pct], [1, 0, 0]);
});

test("auto: status: today's window in New York, the day's counts, and the decisions newest first, at most 100", async (t) => {
  const a = await autoRig(t);
  const status = a.auto.status();
  assert.deepEqual(status.window, { start: "04:00", end: "05:00", tz: "America/New_York", start_at: iso(OPEN), end_at: iso(CLOSE), open: true });
  assert.deepEqual(
    [status.rule.stage, status.rule.amount_usd, status.rule.budget_usd, status.rule.slots, status.rule.max_trades, status.rule.max_orders, status.rule.max_alert_age_sec],
    ["pop", 400, 2000, 5, 5, 30, 60],
  );
  assert.deepEqual(status.decisions, []);

  // A morning: a gray POP, a buy that waits, a buy that filled, one too late.
  await a.send(pop(W0, { ticker: "QQQQ", setup: { weak: true } }));
  const waiting = pop(W0);
  await placeOne(a, waiting);
  const filled = pop(W0, { ticker: "WXYZ" });
  boughtAll(a, await placeOne(a, filled));
  const late = pop(W0 - 2 * MIN, { ticker: "PENY" });
  await a.send(late);
  const after = a.auto.status();
  assert.deepEqual(after.today, { date: "2026-11-25", strong_pops: 3, weak_pops: 1, placed: 2, trades: 1, waiting: 1, held: 1, slots_free: 3 });
  assert.deepEqual(after.decisions.map((decision) => decision.alert_id), [late.id, filled.id, waiting.id]);

  // At most 100 are kept, the newest.
  const many = await autoRig(t, { now: T0 }); // outside its hours: each one is a quick skip
  const ids: string[] = [];
  for (let i = 0; i < 101; i += 1) {
    const setup = pop(T0, { ticker: TICKERS[i % 4] ?? "ABCD" });
    ids.push(setup.id);
    many.auto.onSetup(setup);
  }
  await many.auto.idle();
  const kept = many.auto.status().decisions;
  assert.equal(kept.length, 100);
  assert.deepEqual([kept[0]?.alert_id, kept[99]?.alert_id], [ids[100], ids[1]]);
  assert.equal(many.auto.status().today.strong_pops, 101);
});

// --------------------------------------------------------- days and restarts

test("auto: a new New York day starts with an empty memory: no decisions, no counts, no ids seen", async (t) => {
  const a = await autoRig(t, { mode: "watch" });
  const first = pop(W0);
  await a.send(first);
  await a.send(pop(W0, { ticker: "WXYZ", setup: { weak: true } }));
  let status = a.auto.status();
  assert.deepEqual([status.today.date, status.decisions.length, status.today.strong_pops, status.today.weak_pops], ["2026-11-25", 1, 1, 1]);

  a.clock.now = W0 + DAY;
  status = a.auto.status();
  assert.deepEqual([status.today.date, status.decisions.length, status.today.strong_pops, status.today.weak_pops], ["2026-11-26", 0, 0, 0]);
  assert.deepEqual([status.window.start_at, status.window.end_at], ["2026-11-26T09:00:00.000Z", "2026-11-26T10:00:00.000Z"]);
  // The id seen yesterday is a new alert today.
  assert.deepEqual(verdict(await a.send({ ...first, at: iso(a.clock.now) })), WOULD);
});

test("auto: after a restart the day's decisions and counts come back from the log, and a replayed alert is not decided again", async (t) => {
  const dir = tempDir(t, "auto-restart");
  let current: AutoRig | undefined;
  const journalOf = (): FileJournal => new FileJournal(dir, () => current?.clock.now ?? W0, [TOKEN]);
  current = await autoRig(t, { journal: journalOf() });
  const a = current;
  const gray = pop(W0, { ticker: "QQQQ", setup: { weak: true } });
  const bought = pop(W0);
  const late = pop(W0 - 2 * MIN, { ticker: "WXYZ" });
  const priceless = pop(W0, { ticker: "PENY", price: null });
  await a.send(gray);
  await placeOne(a, bought);
  await a.send(late);
  a.clock.now += 5 * SEC;
  await a.send(priceless);
  const before = a.auto.status();
  assert.deepEqual([before.decisions.length, before.today.strong_pops, before.today.weak_pops], [3, 3, 1]);
  a.auto.close();

  // The bridge is started again ten seconds later, on the same log.
  current = await autoRig(t, { journal: journalOf(), now: a.clock.now + 10 * SEC });
  const b = current;
  const after = b.auto.status();
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(
    [after.today.strong_pops, after.today.weak_pops, after.today.placed, after.today.waiting],
    [before.today.strong_pops, before.today.weak_pops, 1, 1],
  );

  // The feed replays the morning: nothing is decided again, nothing counted again, nothing sent.
  for (const setup of [gray, bought, late, priceless]) b.auto.onSetup({ ...setup });
  await b.auto.idle();
  const replayed = b.auto.status();
  assert.deepEqual(replayed.decisions, before.decisions);
  assert.deepEqual([replayed.today.strong_pops, replayed.today.weak_pops], [3, 1]);
  assert.deepEqual(b.world.allPlaced(), []);

  // A new alert is decided, and its order takes the next free ids.
  const fresh = await b.send(pop(b.clock.now, { ticker: "WXYZ" }));
  assert.deepEqual([fresh?.action, fresh?.order_id], ["placed", 1003]);
});

test("auto: after a restart, watch only's imagined buys still hold their slots and tickers until their time", async (t) => {
  const dir = tempDir(t, "auto-restart-watch");
  let current: AutoRig | undefined;
  const journalOf = (): FileJournal => new FileJournal(dir, () => current?.clock.now ?? W0, [TOKEN]);
  current = await autoRig(t, { mode: "watch", journal: journalOf(), world: knowMoreTickers });
  const a = current;
  for (const ticker of TICKERS.slice(0, 5)) assert.deepEqual(verdict(await a.send(pop(W0, { ticker }))), WOULD);
  a.auto.close();

  current = await autoRig(t, { mode: "watch", journal: journalOf(), now: W0 + 10 * SEC, world: knowMoreTickers });
  const b = current;
  assert.equal(b.auto.status().today.waiting, 5);
  assert.deepEqual(verdict(await b.send(pop(b.clock.now, { ticker: TICKERS[5] }))), skipped("no_slot"));
  assert.deepEqual(verdict(await b.send(pop(b.clock.now, { ticker: "ABCD" }))), skipped("ticker_open"));
  b.clock.now = W0 + 300 * SEC;
  assert.deepEqual(verdict(await b.send(pop(b.clock.now, { ticker: TICKERS[5] }))), WOULD);
});

test("auto: the documented limit: after a restart on a later day, a position of its own from an earlier day is not on the book, not counted and not watched", async (t) => {
  const dir = tempDir(t, "auto-overnight");
  let current: AutoRig | undefined;
  const journalOf = (): FileJournal => new FileJournal(dir, () => current?.clock.now ?? W0, [TOKEN]);
  current = await autoRig(t, { journal: journalOf() });
  const a = current;
  boughtAll(a, await placeOne(a, pop(W0)));
  assert.equal(a.auto.status().today.held, 1);
  // Without a restart, the next day still counts it: the book in memory keeps every day's orders.
  a.clock.now = W0 + DAY;
  assert.deepEqual([a.auto.status().today.held, a.auto.status().today.slots_free], [1, 4]);
  a.auto.close();

  // The next morning the bridge is started again; the 150 shares and their exits are still in TWS.
  current = await autoRig(t, { journal: journalOf(), now: W0 + DAY, world: (w) => w.positions.set(111, 150) });
  const b = current;
  const watch = new ExitWatch({ auto: b.config.auto, bridge: b.bridge, link: b.link, journal: b.journal, clock: () => b.clock.now, idleLookMs: 5 });
  t.after(() => watch.close());
  // The book is rebuilt from today's log only: the position is in no count and nothing watches it.
  assert.deepEqual(b.bridge.allOrders(), []);
  assert.deepEqual([b.auto.status().today.held, b.auto.status().today.slots_free], [0, 5]);
  assert.deepEqual(watch.watching(), []);
});

// ------------------------------------------------- leaving "on", and a halt

test("auto: leaving on cancels its buys still waiting with nothing filled, and nothing else", async (t) => {
  for (const to of ["watch", "off"] as const) {
    const a = await autoRig(t, { world: knowMoreTickers });
    const waiting = await placeOne(a, pop(W0, { id: `${to}-a` }));
    const waiting2 = await placeOne(a, pop(W0, { ticker: "WXYZ" }));
    const part = await placeOne(a, pop(W0, { ticker: "QQQQ" }));
    boughtPart(a, part, 50);
    const full = await placeOne(a, pop(W0, { ticker: "PENY" }));
    boughtAll(a, full);
    const click = await a.bridge.order(buy({ ticker: "EEEE", entry: "stop" }));
    taken(a, click.order_id);
    const ib = a.world.current;
    assert.deepEqual(ib.callsOf("cancelOrder"), []);

    a.auto.setMode({ mode: to });
    assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [waiting, waiting2], to);
    const why = to === "off" ? "automation switched off" : "automation switched to watch only";
    assert.deepEqual(
      a.journal.ofType("cancel").map((line) => [line["order_id"], line["why"]]),
      [
        [waiting, why],
        [waiting2, why],
      ],
    );
    const status = (id: number): string | undefined => a.bridge.orders().find((order) => order.order_id === id)?.status;
    assert.deepEqual([status(waiting), status(waiting2), status(part), status(full), status(click.order_id)], ["PendingCancel", "PendingCancel", "Submitted", "Filled", "PreSubmitted"]);

    // TWS confirms, after the buys' own time: that is a cancel, not an expiry.
    a.clock.now = W0 + 301 * SEC;
    endedUnfilled(a, waiting);
    endedUnfilled(a, waiting2);
    assert.deepEqual(a.journal.ofType("entry_expired"), []);
    assert.ok(!/expired/.test(a.bridge.orders().find((order) => order.order_id === waiting)?.note ?? ""));

    // The slots, the tickers and the alerts are free again.
    a.auto.setMode({ mode: "on" });
    assert.equal(a.auto.status().today.waiting, 0);
    assert.deepEqual(verdict(await a.send(pop(a.clock.now))), PLACED, to);
    assert.equal((await a.bridge.order(buy({ ticker: "FFFF", alert_id: `${to}-a` }))).ticker, "FFFF");
  }
});

test("auto: a halt cancels its buys still waiting, and no clicked order and nothing that holds shares", async (t) => {
  const a = await autoRig(t);
  const waiting = await placeOne(a, pop(W0));
  const full = await placeOne(a, pop(W0, { ticker: "WXYZ" }));
  boughtAll(a, full);
  const click = await a.bridge.order(buy({ ticker: "QQQQ", entry: "stop" }));
  const ib = a.world.current;
  a.bridge.halt({ halted: true });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [waiting]);
  assert.deepEqual(a.journal.ofType("cancel").map((line) => [line["order_id"], line["why"]]), [[waiting, "halt"]]);
  assert.equal(a.bridge.orders().find((order) => order.order_id === click.order_id)?.status, "PendingSubmit");
  // Off again: nothing more is sent.
  a.bridge.halt({ halted: false });
  assert.equal(ib.callsOf("cancelOrder").length, 1);
});

test("auto: with TWS not connected, leaving on or a halt sends nothing", async (t) => {
  const a = await autoRig(t);
  const waiting = await placeOne(a, pop(W0));
  a.world.mode = "refuse";
  a.world.drop();
  await until(() => !a.link.isReady(), "TWS gone");
  a.auto.setMode({ mode: "watch" });
  a.auto.setMode({ mode: "on" });
  a.bridge.halt({ halted: true });
  assert.deepEqual(a.world.instances.flatMap((ib) => ib.callsOf("cancelOrder")), []);
  assert.deepEqual(a.journal.ofType("cancel"), []);
  assert.equal(a.bridge.orders().find((order) => order.order_id === waiting)?.status, "PreSubmitted");
});

test("auto: a slow contract lookup cannot push the buy's time past 05:00:00, nor send one with under 5 s left", async (t) => {
  const at = CLOSE - 2 * MIN; // decided at 04:58:00
  const a = await autoRig(t, { now: at, world: (w) => (w.holdLookups = true) });
  a.auto.onSetup(pop(at));
  await until(() => a.world.heldLookups.length === 1, "the contract lookup");
  a.clock.now = CLOSE - 30 * SEC; // TWS answers at 04:59:30
  a.world.answerLookups();
  await a.auto.idle();
  const decision = a.auto.status().decisions[0];
  assert.deepEqual([...(verdict(decision) ?? []), decision?.plan?.good_until], [...PLACED, iso(CLOSE)]);
  assert.equal(a.world.allPlaced()[0]?.order.goodTillDate, "20261125-10:00:00");

  // Answered at 04:59:57: 3 s would be left, and nothing is sent.
  const b = await autoRig(t, { now: at, world: (w) => (w.holdLookups = true) });
  b.auto.onSetup(pop(at));
  await until(() => b.world.heldLookups.length === 1, "the contract lookup");
  b.clock.now = CLOSE - 3 * SEC;
  b.world.answerLookups();
  await b.auto.idle();
  assert.deepEqual(verdict(b.auto.status().decisions[0]), skipped("window_closing"));
  assert.deepEqual(b.world.allPlaced(), []);
});

test("auto: watch only shows as failed a buy that on would refuse for its size, and holds no slot or ticker for it", async (t) => {
  // $400 at a limit of 0.5303 is 754 shares, above the default limits.maxShares (500).
  const a = await autoRig(t, { mode: "watch" });
  const small = await a.send(pop(W0, { price: 0.5 }));
  assert.deepEqual(verdict(small), ["failed", "too_many_shares"]);
  assert.match(small?.text ?? "", /754 shares, above maxShares \(500\)/);
  assert.equal(small?.plan, null);
  assert.equal(a.auto.status().today.waiting, 0);
  // The ticker is free: nothing was imagined to be waiting on it.
  assert.deepEqual(verdict(await a.send(pop(W0 + SEC))), WOULD);

  // The same alert with on: the bridge refuses it with the same code.
  const b = await autoRig(t);
  assert.deepEqual(verdict(await b.send(pop(W0, { price: 0.5 }))), ["failed", "too_many_shares"]);
  assert.deepEqual(b.world.allPlaced(), []);

  // An order's dollars are held to the same way.
  const c = await autoRig(t, { mode: "watch", config: (config) => (config.limits.maxNotionalUsd = 250) });
  assert.deepEqual(verdict(await c.send(pop(W0))), ["failed", "too_large"]);
});

test("auto: an alert under the price floor ($0.50) is not bought; at the floor it is; a floor of 0 is no floor", async (t) => {
  const a = await autoRig(t, { config: (config) => (config.limits.maxShares = 50_000) });
  const under = await a.send(pop(W0, { price: 0.4999 }));
  assert.deepEqual(verdict(under), skipped("under_min_price"));
  assert.match(under?.text ?? "", /0\.4999 is under the floor of 0\.5000/);
  assert.deepEqual(a.world.allPlaced(), []);
  assert.equal(a.auto.status().rule.min_price, 0.5);
  // At the floor itself it is bought.
  assert.deepEqual(verdict(await a.send(pop(W0 + SEC, { price: 0.5 }))), PLACED);

  // Watch only says the same, and holds no slot for it.
  const w = await autoRig(t, { mode: "watch", config: (config) => (config.limits.maxShares = 50_000) });
  assert.deepEqual(verdict(await w.send(pop(W0, { price: 0.3 }))), skipped("under_min_price"));
  assert.equal(w.auto.status().today.waiting, 0);

  // Outside its hour that is still the reason given: the floor is asked after the hour.
  const late = await autoRig(t, { now: CLOSE + MIN });
  assert.deepEqual(verdict(await late.send(pop(CLOSE + MIN, { price: 0.3 }))), skipped("outside_hours"));

  // Switched off in config.json.
  const none = await autoRig(t, { config: (config) => ((config.auto.minPrice = 0), (config.limits.maxShares = 50_000)) });
  assert.deepEqual(verdict(await none.send(pop(W0, { price: 0.3 }))), PLACED);
});

test("auto: a ticker is the same ticker in any case: the decision names it as the book does", async (t) => {
  const a = await autoRig(t);
  const first = await a.send(pop(W0, { ticker: "abcd" }));
  assert.deepEqual([...(verdict(first) ?? []), first?.ticker], [...PLACED, "ABCD"]);
  assert.equal(a.bridge.orders()[0]?.ticker, "ABCD");
  assert.deepEqual(verdict(await a.send(pop(W0 + SEC))), skipped("ticker_open"));
});

test("auto: pairFeed refuses a token too short to be one", async (t) => {
  const a = await autoRig(t, { mode: "watch", paired: false });
  refusesNow(() => a.auto.pairFeed({ server: FEED.server, token: "short-token" }), 400, "bad_request");
  assert.equal(a.state.feed, null);
  assert.deepEqual(a.journal.ofType("auto_feed"), []);
});
