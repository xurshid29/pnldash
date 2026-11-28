import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, defaultConfig, loadOrCreateConfig, validateConfig } from "../src/config.js";
import type { OrderConfig } from "../src/config.js";
import { BridgeError } from "../src/errors.js";
import { FileJournal } from "../src/journal.js";
import { buildBracket, ibUtcDateTime, planOrder, roundUp, stopEntryGoodUntil } from "../src/order.js";
import type { PlanInput } from "../src/order.js";
import { createBridgeServer, listenOnLoopback } from "../src/server.js";
import { sleep, until } from "./fake-tws.js";
import { buy, refuses, refusesNow, rig, T0, TOKEN } from "./harness.js";
import { ABCD, expire, fill, tempDir, waitingStop } from "./scenes.js";

// entry: "stop": a buy that waits above the alert's price and fills only if the price gets there.
// The buy is a BUY STP LMT: its trigger is the alert's price + entryStopPct (3%), its limit the
// trigger + entryStopLimitPct (1%, rounded up), good till entryValidSec (300 s) later, when IB
// cancels it by itself. The exits are the usual ones, measured from the trigger.
//
// The default one here: alert 2.50 → trigger 2.58, limit 2.61, take-profit 2.84, stop 2.45 / 2.42,
// good till 10:05:00 New York (T0 + 300 s), which TWS is sent as 20261125-15:05:00 (UTC).

const UNTIL = "2026-11-25T15:05:00.000Z";
const GTD = "20261125-15:05:00";
const EXPIRED = "expired unfilled at 10:05:00 New York";
const LATER = 60_000;

function cfg(overrides: Partial<OrderConfig> = {}): OrderConfig {
  return { ...defaultConfig("x").order, ...overrides };
}

function input(alertPrice: number, overrides: Partial<PlanInput> = {}): PlanInput {
  return { qty: 100, alertPrice, alertStop: null, ask: null, entry: "stop", ...overrides };
}

function refusal(status: number, code: string, message?: RegExp): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof BridgeError, String(err));
    assert.equal(err.code, code, err.message);
    assert.equal(err.status, status, err.message);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  };
}

function onTick(price: number): boolean {
  const scale = price >= 1 ? 100 : 10000;
  return Math.abs(Math.round(price * scale) - price * scale) < 1e-6;
}

// --------------------------------------------------------- the arithmetic

test("stop entry: rounding up to the tick, without float drift", () => {
  assert.equal(roundUp(2.02), 2.02); // 2.02 * 100 is 202.00000000000003
  assert.equal(roundUp(1.15), 1.15); // 1.15 * 100 is 114.99999999999999
  assert.equal(roundUp(2.0001), 2.01);
  assert.equal(roundUp(0.37097), 0.371);
  assert.equal(roundUp(0.371), 0.371);
  assert.equal(roundUp(0.123401), 0.1235);
  assert.equal(roundUp(0.99995), 1); // a sub-dollar price may round up onto $1
});

test("stop entry: trigger, limit and exits from the alert, on both sides of $1 and under a penny", () => {
  const prices = (alert: number): Array<number | null> => {
    const plan = planOrder(cfg(), input(alert));
    return [plan.trigger, plan.limit, plan.takeProfit, plan.stop, plan.stopLimit];
  };
  // 2.50 + 3% = 2.575 → 2.58 (nearest); + 1% = 2.6058 → 2.61 (up). From the trigger: + 10% =
  // 2.838 → 2.84 (nearest); − 5% = 2.451 → 2.45 (down); − 1% = 2.4255 → 2.42 (down).
  assert.deepEqual(prices(2.5), [2.58, 2.61, 2.84, 2.45, 2.42]);
  // Under $1, on the hundredth of a cent: 0.367298 → 0.3673; 0.370973 → 0.3710.
  assert.deepEqual(prices(0.3566), [0.3673, 0.371, 0.404, 0.3489, 0.3454]);
  // The trigger under $1, its limit above: 0.9991 + 1% = 1.009091 → 1.01 (up, on cents).
  assert.deepEqual(prices(0.97), [0.9991, 1.01, 1.1, 0.9491, 0.9396]);
  // The trigger above $1, its stop under: 1.0094 → 1.01; 1.0201 → 1.03 (up); 0.9595 → 0.9595.
  assert.deepEqual(prices(0.98), [1.01, 1.03, 1.11, 0.9595, 0.9499]);
  // Under a penny: 0.005253 → 0.0053; 0.005353 → 0.0054 (up).
  assert.deepEqual(prices(0.0051), [0.0053, 0.0054, 0.0058, 0.005, 0.0049]);
  assert.deepEqual(prices(12), [12.36, 12.49, 13.6, 11.74, 11.62]);

  // Whatever the price: the trigger above the alert, the limit not under the trigger, both on a tick.
  for (const alert of [0.0037, 0.0412, 0.2999, 0.9708, 0.9709, 0.9999, 1, 1.07, 2.5, 3.333, 17.77, 99.99, 250]) {
    const plan = planOrder(cfg({ takeProfitPct: 0, stopPct: 0 }), input(alert));
    const trigger = plan.trigger ?? Number.NaN;
    assert.ok(trigger > alert, `${alert}: trigger ${trigger}`);
    assert.ok(plan.limit >= trigger, `${alert}: limit ${plan.limit} under trigger ${trigger}`);
    assert.ok(onTick(trigger) && onTick(plan.limit), `${alert}: ${trigger} / ${plan.limit}`);
  }

  const plan = planOrder(cfg(), input(2.5));
  assert.deepEqual(
    [plan.entry, plan.priceFrom, plan.basePrice, plan.notional, plan.stopFrom, plan.qty, plan.sizing],
    ["stop", "alert", 2.5, 261, "pct", 100, { mode: "shares" }],
  );
  assert.ok(Math.abs(plan.chasePct - 4.4) < 1e-9);

  // The two settings are its distance from the alert.
  const wide = planOrder(cfg({ entryStopPct: 5, entryStopLimitPct: 2 }), input(2.5)); // 2.625 → 2.63; 2.6826 → 2.69
  assert.deepEqual([wide.trigger, wide.limit, wide.takeProfit, wide.stop], [2.63, 2.69, 2.89, 2.49]);
  const narrow = planOrder(cfg({ entryStopPct: 0.5, entryStopLimitPct: 0.1 }), input(2.5)); // 2.5125 → 2.51; 2.51251 → 2.52
  assert.deepEqual([narrow.trigger, narrow.limit], [2.51, 2.52]);

  // A buy now is what it always was.
  const now = planOrder(cfg(), input(2.5, { entry: "now" }));
  assert.deepEqual([now.entry, now.trigger, now.limit, now.takeProfit, now.stop], ["now", null, 2.53, 2.78, 2.4]);
  assert.deepEqual(planOrder(cfg(), { qty: 100, alertPrice: 2.5, alertStop: null, ask: null }).entry, "now");
});

test("stop entry: maxChasePct does not apply, and no ask is used whatever priceFrom says", () => {
  const plan = planOrder(cfg({ maxChasePct: 0, priceFrom: "ask" }), input(2.5, { ask: null }));
  assert.deepEqual([plan.trigger, plan.limit, plan.priceFrom, plan.basePrice], [2.58, 2.61, "alert", 2.5]);
  assert.deepEqual(planOrder(cfg({ priceFrom: "ask" }), input(2.5, { ask: 9 })).limit, 2.61);
  // The same alert as a buy now is refused for chasing at that cap.
  assert.throws(() => planOrder(cfg({ maxChasePct: 0 }), input(2.5, { entry: "now" })), refusal(422, "chase"));
});

test("stop entry: dollars become shares at the buy's limit, the most a share can cost", () => {
  const plan = planOrder(cfg({ amountUsd: 400 }), input(2.5, { qty: null }));
  assert.deepEqual([plan.qty, plan.limit, plan.notional, plan.sizing], [153, 2.61, 399.33, { mode: "usd", amount_usd: 400 }]); // 400 / 2.61 = 153.3
  const penny = planOrder(cfg({ amountUsd: 400 }), input(0.3566, { qty: null }));
  assert.deepEqual([penny.qty, penny.limit, penny.notional], [1078, 0.371, 399.94]); // 400 / 0.3710 = 1078.2
  assert.throws(() => planOrder(cfg({ amountUsd: 2 }), input(2.5, { qty: null })), refusal(422, "too_expensive", /^one share at 2\.61 costs more/));
});

test("stop entry: the alert's stop is measured from the trigger", () => {
  const used = planOrder(cfg(), input(2.5, { alertStop: 2.42 }));
  assert.deepEqual([used.stop, used.stopLimit, used.stopFrom, used.alertStopIgnored], [2.42, 2.39, "alert", null]);
  // 3 × stopPct = 15% under the trigger 2.58 is 2.193.
  assert.equal(planOrder(cfg(), input(2.5, { alertStop: 2.2 })).stopFrom, "alert");
  assert.equal(planOrder(cfg(), input(2.5, { alertStop: 2.19 })).stopFrom, "pct");
  const far = planOrder(cfg(), input(2.5, { alertStop: 2.1 }));
  assert.deepEqual([far.stop, far.stopFrom], [2.45, "pct"]);
  assert.equal(far.alertStopIgnored, "it (2.10) is 18.6% under the trigger, more than 3 × stopPct (15%)");
  const above = planOrder(cfg(), input(2.5, { alertStop: 2.58 }));
  assert.equal(above.alertStopIgnored, "it (2.58) is not below the trigger (2.58)");
});

test("stop entry: prices that cannot be told apart, and the switch at 0, are refused", () => {
  // 0.0010 + 3% is under half a tick: the trigger would be the alert's price itself.
  assert.throws(
    () => planOrder(cfg(), input(0.001)),
    refusal(422, "bad_prices", /^the stop entry's trigger, 3% above the alert's 0\.0010, rounds to 0\.0010: not above the alert$/),
  );
  // A take-profit under the most the buy can pay would sell at a loss.
  assert.throws(
    () => planOrder(cfg({ takeProfitPct: 0.5 }), input(2.5)),
    refusal(422, "bad_prices", /^after rounding, the take-profit \(2\.59\) is not above the buy's limit \(2\.61\)$/),
  );
  assert.throws(
    () => planOrder(cfg({ entryStopPct: 0 }), input(2.5)),
    refusal(409, "stop_entry_off", /^stop entries are switched off: order\.entryStopPct is 0 in config\.json$/),
  );
});

test("stop entry: the bracket is a BUY STP LMT good till its time, and the usual exits", () => {
  const legs = buildBracket(planOrder(cfg(), input(2.5)), 1000, true, GTD);
  assert.deepEqual(
    legs.map((leg) => [leg.leg, leg.orderId]),
    [
      ["parent", 1000],
      ["take_profit", 1001],
      ["stop", 1002],
    ],
  );
  assert.deepEqual(
    legs.map((leg) => leg.order),
    [
      { action: "BUY", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.58, lmtPrice: 2.61, tif: "GTD", goodTillDate: GTD, outsideRth: true, parentId: 0, transmit: false },
      { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.84, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
      { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.45, lmtPrice: 2.42, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    ],
  );
  // With the exits switched off the buy transmits itself; outsideRth follows the config.
  const alone = buildBracket(planOrder(cfg({ takeProfitPct: 0, stopPct: 0 }), input(2.5)), 40, false, GTD);
  assert.deepEqual(
    alone.map((leg) => [leg.leg, leg.orderId, leg.order.orderType, leg.order.tif, leg.order.transmit, leg.order.outsideRth]),
    [["parent", 40, "STP LMT", "GTD", true, false]],
  );
  // Without the time it is good till it is not built at all.
  assert.throws(() => buildBracket(planOrder(cfg(), input(2.5)), 1000, true), /needs its trigger and the time it is good till/);
});

test("stop entry: the time it is good till: on a whole second, in IB's UTC form", () => {
  assert.equal(ibUtcDateTime(Date.parse("2026-11-25T15:05:00Z")), "20261125-15:05:00");
  assert.equal(ibUtcDateTime(Date.parse("2026-01-02T03:04:05.999Z")), "20260102-03:04:05");
  assert.equal(stopEntryGoodUntil(T0, 300), T0 + 300_000);
  assert.equal(stopEntryGoodUntil(T0 + 700, 300), T0 + 300_000); // never later than the setting
  // 18:58 in New York is 23:58 UTC: the UTC date moves on, which is what TWS is sent.
  assert.equal(ibUtcDateTime(stopEntryGoodUntil(Date.parse("2026-11-25T23:58:00Z"), 300)), "20261126-00:03:00");
});

// ------------------------------------------------------- preview and order

test("stop entry: /preview shows the order and its checks, reads no ask, and sends nothing", async (t) => {
  // priceFrom "ask", and an ask a buy now would refuse as chasing: a stop entry looks at neither.
  const r = await rig(t, { config: (c) => (c.order.priceFrom = "ask"), world: (w) => w.asks.set("ABCD", 2.9) });
  const preview = await r.bridge.preview(buy({ entry: "stop", alert_id: "ev-1" }));
  assert.deepEqual(
    { ...preview, checks: preview.checks.map((check) => check.name) },
    {
      ticker: "ABCD",
      entry: "stop",
      qty: 100,
      sizing: { mode: "shares" },
      limit: 2.61,
      trigger: 2.58,
      good_until: UNTIL,
      take_profit: 2.84,
      stop: 2.45,
      stop_limit: 2.42,
      notional: 261,
      price_from: "alert",
      note: null,
      checks: ["switches", "entry", "account", "alert", "shares", "daily", "duplicate", "contract", "trigger", "limit", "take_profit", "stop", "notional"],
    },
  );
  const detail = (name: string): string => preview.checks.find((check) => check.name === name)?.detail ?? "";
  assert.equal(
    detail("entry"),
    "stop entry: a BUY STP LMT 3% above the alert's price, priced from the alert alone; it waits 300 s, then IB cancels it if nothing has filled",
  );
  assert.equal(detail("trigger"), "2.58 = the alert's price 2.50 + 3%; the buy waits for it until 10:05:00 New York (300 s)");
  assert.equal(
    detail("limit"),
    "2.61 = the trigger + 1%, rounded up; 4.4% past the alert. maxChasePct does not apply to a stop entry: its distance from the alert is entryStopPct + entryStopLimitPct",
  );
  assert.equal(detail("take_profit"), "2.84, 10% above the trigger");
  assert.equal(detail("stop"), "2.45, limit 2.42: 5% under the trigger");
  assert.equal(detail("notional"), "$261.00 of $1000 allowed");

  assert.deepEqual(r.world.current.callsOf("reqMktData"), []);
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.journal.ofType("order_placed"), []);
  assert.deepEqual(r.bridge.status().today, { orders: 0, filled: 0 });

  // The alert's stop, as a buy now would have it, from the trigger.
  const withStop = await r.bridge.preview(buy({ entry: "stop", alert_stop: 1.9 }));
  assert.equal(withStop.stop, 2.45);
  assert.match(withStop.checks.find((check) => check.name === "stop")?.detail ?? "", /^2\.45, limit 2\.42: 5% under the trigger; the alert's stop was not used: it \(1\.90\) is 26\.36% under the trigger/);
});

test("stop entry: /order sends the bracket with a BUY STP LMT parent, and the book and the log say so", async (t) => {
  const r = await rig(t);
  r.clock.now = T0 + 700; // the time it is good till is a whole second, never later than 300 s
  const alertAt = new Date(T0 - 30_000).toISOString();
  const result = await r.bridge.order(buy({ entry: "stop", stage: "pop", alert_id: "ev-1", alert_at: alertAt }));
  assert.deepEqual(result, {
    order_id: 1000,
    ticker: "ABCD",
    entry: "stop",
    qty: 100,
    sizing: { mode: "shares" },
    limit: 2.61,
    trigger: 2.58,
    good_until: UNTIL,
    take_profit: 2.84,
    stop: 2.45,
    stop_limit: 2.42,
    price_from: "alert",
    note: null,
    status: "PendingSubmit",
  });

  const placed = r.world.current.placed();
  assert.deepEqual(placed.map((p) => p.id), [1000, 1001, 1002]);
  for (const p of placed) assert.deepEqual(p.contract, ABCD);
  assert.deepEqual(
    placed.map((p) => p.order),
    [
      { action: "BUY", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.58, lmtPrice: 2.61, tif: "GTD", goodTillDate: GTD, outsideRth: true, parentId: 0, transmit: false },
      { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.84, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
      { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.45, lmtPrice: 2.42, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    ],
  );
  // No quote was asked for, and nothing else was sent.
  assert.deepEqual(r.world.current.callsOf("reqMktData"), []);
  assert.deepEqual(r.world.current.callsOf("cancelOrder"), []);

  const [record] = r.bridge.orders();
  assert.deepEqual(record, {
    order_id: 1000,
    ticker: "ABCD",
    conid: 111,
    placed_at: new Date(T0 + 700).toISOString(),
    source: "click",
    asked: { alert_price: 2.5, alert_stop: null, qty: null, stage: "pop", alert_at: alertAt, alert_id: "ev-1" },
    sizing: { mode: "shares" },
    entry: "stop",
    sent: {
      qty: 100,
      limit: 2.61,
      trigger: 2.58,
      good_until: UNTIL,
      take_profit: 2.84,
      take_profit_qty: 100,
      stop: 2.45,
      stop_limit: 2.42,
      stop_own: false,
      first_limit: 2.61,
      first_take_profit: 2.84,
      first_stop: 2.45,
      first_stop_limit: 2.42,
      price_from: "alert",
      stop_from: "pct",
      outside_rth: true,
      order_ids: { parent: 1000, take_profit: 1001, stop: 1002 },
    },
    chases: 0,
    status: "PendingSubmit",
    filled_qty: 0,
    avg_fill_price: null,
    slip_pct: null,
    held_qty: 0,
    legs: {
      take_profit: { order_id: 1001, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
      stop: { order_id: 1002, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
    },
    exit: null,
    loose_exit: false,
    watch: null,
    error: null,
    note: null,
  });

  // The log line is the record, with the time exactly as it went to TWS.
  const [line] = r.journal.ofType("order_placed");
  assert.deepEqual({ ...line, type: undefined }, { ...record, good_till_date: GTD, type: undefined });
  assert.equal(r.said.at(-1), "order 1000 ABCD: stop buy 100, trigger 2.58, limit 2.61, until 10:05:00 New York, take-profit 2.84, stop 2.45 / 2.42");
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });
});

test("stop entry: /order answers with TWS's first word, PreSubmitted for a stop that waits", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy({ entry: "stop" }));
  await until(() => r.world.current.placed().length === 3, "the bracket");
  r.world.current.emit("orderStatus", 1000, "PreSubmitted", 0, 100, 0);
  assert.equal((await pending).status, "PreSubmitted");
});

test("stop entry: outsideRth from the config on every leg, the alert's stop, under $1, and a refused share count", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.outsideRth = false) });
  await r.bridge.order(buy({ entry: "stop", alert_stop: 2.42 }));
  assert.deepEqual(
    r.world.allPlaced().map((p) => [p.order.orderType, p.order.outsideRth, p.order.auxPrice, p.order.lmtPrice]),
    [
      ["STP LMT", false, 2.58, 2.61],
      ["LMT", false, undefined, 2.84],
      ["STP LMT", false, 2.42, 2.39],
    ],
  );
  assert.deepEqual([r.bridge.orders()[0]?.sent.stop_from, r.bridge.orders()[0]?.sent.outside_rth], ["alert", false]);

  const penny = await rig(t);
  const order = await penny.bridge.order(buy({ entry: "stop", ticker: "PENY", alert_price: 0.3566 }));
  assert.deepEqual([order.trigger, order.limit, order.take_profit, order.stop, order.stop_limit], [0.3673, 0.371, 0.404, 0.3489, 0.3454]);
  assert.deepEqual([penny.world.allPlaced()[0]?.order.auxPrice, penny.world.allPlaced()[0]?.order.lmtPrice], [0.3673, 0.371]);
});

test("stop entry: entry left out, \"now\" or null is the buy it always was; anything else is a 400", async (t) => {
  const lmtBracket = [
    { action: "BUY", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.53, tif: "DAY", outsideRth: true, parentId: 0, transmit: false },
    { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.78, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
    { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.4, lmtPrice: 2.37, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
  ];
  for (const body of [buy(), buy({ entry: "now" }), buy({ entry: null })]) {
    const r = await rig(t);
    const preview = await r.bridge.preview(body);
    assert.deepEqual([preview.entry, preview.trigger, preview.good_until], ["now", null, null]);
    assert.deepEqual(preview.checks.map((check) => check.name), ["switches", "account", "shares", "daily", "duplicate", "contract", "limit", "take_profit", "stop", "notional"]);
    const result = await r.bridge.order(body);
    assert.deepEqual([result.entry, result.trigger, result.good_until, result.limit], ["now", null, null, 2.53]);
    assert.deepEqual(r.world.allPlaced().map((p) => p.order), lmtBracket);
    const record = r.bridge.orders()[0];
    assert.deepEqual([record?.entry, record?.sent.trigger, record?.sent.good_until], ["now", null, null]);
    assert.equal("good_till_date" in (r.journal.ofType("order_placed")[0] ?? {}), false);
    assert.match(r.said.at(-1) ?? "", /^order 1000 ABCD: buy 100 @ 2\.53, take-profit/);
  }

  const r = await rig(t);
  for (const entry of ["STOP", "Stop", "later", "", 1, true, {}, ["stop"]]) {
    await refuses(r.bridge.order(buy({ entry })), 400, "bad_request", /^entry must be "now" or "stop"$/);
    await refuses(r.bridge.preview(buy({ entry })), 400, "bad_request");
  }
  assert.deepEqual(r.world.allPlaced(), []);
});

test("stop entry: sized in dollars at the buy's limit; the share and dollar rails say so", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.amountUsd = 400) });
  const preview = await r.bridge.preview(buy({ entry: "stop" }));
  assert.deepEqual([preview.qty, preview.notional, preview.sizing], [153, 399.33, { mode: "usd", amount_usd: 400 }]);
  assert.equal(preview.checks.find((check) => check.name === "shares")?.detail, "153 of 500 allowed ($400 at 2.61)");
  await r.bridge.order(buy({ entry: "stop" }));
  assert.deepEqual(r.world.allPlaced().map((p) => p.order.totalQuantity), [153, 153, 153]);
  // 400 / 0.3710 = 1,078 shares: above maxShares.
  await refuses(
    r.bridge.order(buy({ entry: "stop", ticker: "PENY", alert_price: 0.3566 })),
    422,
    "too_many_shares",
    /^\$400 at 0\.3710 is 1,078 shares, above maxShares \(500\)$/,
  );
  assert.equal(r.world.allPlaced().length, 3);
});

// ---------------------------------------------------------------- the rails

test("stop entry: entryStopPct 0 switches it off; a buy now still goes", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.entryStopPct = 0) });
  const off = /^stop entries are switched off: order\.entryStopPct is 0 in config\.json$/;
  await refuses(r.bridge.order(buy({ entry: "stop" })), 409, "stop_entry_off", off);
  await refuses(r.bridge.preview(buy({ entry: "stop" })), 409, "stop_entry_off", off);
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.world.current.callsOf("reqContractDetails"), []); // refused before TWS was asked anything
  assert.equal(r.bridge.status().order.entryStopPct, 0);
  assert.equal((await r.bridge.order(buy())).entry, "now");
});

test("stop entry: the switches, the account and the connection hold as for any order", async (t) => {
  const disabled = await rig(t, { config: (c) => (c.enabled = false) });
  await refuses(disabled.bridge.order(buy({ entry: "stop" })), 409, "disabled");
  const halted = await rig(t, { config: (c) => (c.halted = true) });
  await refuses(halted.bridge.order(buy({ entry: "stop" })), 409, "halted");
  await refuses(halted.bridge.preview(buy({ entry: "stop" })), 409, "halted");
  const live = await rig(t, { world: (w) => (w.accounts = "U7654321") });
  await refuses(live.bridge.order(buy({ entry: "stop" })), 409, "paper_only");
  const offline = await rig(t);
  offline.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  await refuses(offline.bridge.order(buy({ entry: "stop" })), 503, "tws_offline");
  const down = await rig(t, { world: (w) => (w.mode = "refuse"), connect: false });
  await refuses(down.bridge.order(buy({ entry: "stop" })), 503, "tws_down");
  for (const r of [disabled, halted, live, offline, down]) assert.deepEqual(r.world.allPlaced(), []);
});

test("stop entry: shares, dollars, a stale alert, the daily count, the ticker's window and the alert's one order", async (t) => {
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 2) });
  await refuses(r.bridge.order(buy({ entry: "stop", qty: 501 })), 422, "too_many_shares", /^501 shares is above maxShares \(500\)$/);
  // 384 × 2.61 = 1002.24: the notional is at the buy's limit, the most it can cost.
  await refuses(r.bridge.order(buy({ entry: "stop", qty: 384 })), 422, "too_large", /^the order is \$1002\.24 \(384 × 2\.61\), above maxNotionalUsd \(\$1000\)$/);
  assert.equal((await r.bridge.preview(buy({ entry: "stop", qty: 383 }))).notional, 999.63);
  await refuses(r.bridge.order(buy({ entry: "stop", alert_at: T0 - 11 * 60_000 })), 422, "stale_alert");
  assert.deepEqual(r.world.allPlaced(), []);

  await r.bridge.order(buy({ entry: "stop", alert_id: "ev-1" }));
  r.clock.now += 3000;
  await refuses(r.bridge.order(buy({ entry: "stop" })), 409, "duplicate", /^duplicate: ABCD was ordered 3s ago/);
  await refuses(r.bridge.order(buy()), 409, "duplicate"); // the ticker's window holds across both kinds
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ entry: "stop", alert_id: "ev-1" })), 409, "duplicate_alert", /\(order 1000, ABCD, 10:00:00 New York\)$/);
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert"); // nor a buy now for the same alert
  await r.bridge.order(buy({ entry: "stop", ticker: "WXYZ" }));
  await refuses(r.bridge.order(buy({ entry: "stop", ticker: "QQQQ" })), 409, "daily_limit", /2 of 2 today/);
  assert.equal(r.world.allPlaced().length, 6);
});

test("stop entry: maxChasePct does not stop it where it stops a buy now", async (t) => {
  // A cap of 2%: an ask of 2.55 puts a buy now at 2.58, 3.2% past the alert. A stop entry's limit is 4.4% past it, and goes.
  const r = await rig(t, {
    config: (c) => {
      c.order.priceFrom = "ask";
      c.order.maxChasePct = 2;
    },
    world: (w) => w.asks.set("ABCD", 2.55),
  });
  await refuses(r.bridge.order(buy()), 422, "chase");
  const order = await r.bridge.order(buy({ entry: "stop" }));
  assert.deepEqual([order.limit, order.trigger, order.price_from], [2.61, 2.58, "alert"]);
  assert.equal(r.world.current.callsOf("reqMktData").length, 1); // the buy now's, not the stop entry's
});

// ------------------------------------------------------------ while it waits

test("stop entry: one that waits is working, not filled: it holds its alert and the day's count, and nothing acts on it", async (t) => {
  const r = await rig(t, { exitGraceMs: 20, world: (w) => w.bids.set("ABCD", 2.4) });
  const ib = await waitingStop(r, { alert_id: "ev-1" });
  const order = r.bridge.orders()[0];
  assert.deepEqual(
    [order?.status, order?.filled_qty, order?.held_qty, order?.legs.take_profit?.status, order?.legs.stop?.status, order?.loose_exit, order?.note],
    ["PreSubmitted", 0, 0, "PreSubmitted", "PreSubmitted", false, null],
  );
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });

  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert");
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /has bought nothing/);
  // TWS reports the orders as they stand: the book has them so already.
  for (const id of [1000, 1001, 1002]) ib.reports(id);
  assert.deepEqual(r.journal.ofType("order_open"), []);
  // Nothing is sent on its own while it waits: no clean-up, no cancel, no change.
  await sleep(60);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(r.journal.ofType("entry_expired"), []);
});

test("stop entry: /chase is refused while it waits, and asks TWS for nothing", async (t) => {
  const r = await rig(t, { world: (w) => (w.asks.set("PENY", 0.4), w.asks.set("ABCD", 2.7)) });
  const ib = await waitingStop(r, { ticker: "PENY", alert_price: 0.3566 });
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "not_chaseable", /^this buy waits for 0\.3673: cancel it and buy now instead$/);
  // It says so before anything else, a halt included.
  r.bridge.halt({ halted: true });
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "not_chaseable");
  r.bridge.halt({ halted: false });
  assert.deepEqual(ib.callsOf("reqMktData"), []);
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
  assert.deepEqual(r.journal.ofType("chase"), []);

  // Part-filled once triggered: still a stop-limit, still not chased.
  const s = await rig(t, { world: (w) => w.asks.set("ABCD", 2.7) });
  const tws = await waitingStop(s);
  fill(tws, 1000, "b1", 40, 2.6, 40);
  tws.emit("orderStatus", 1000, "Submitted", 40, 60, 2.6);
  await refuses(s.bridge.chase({ order_id: 1000 }), 409, "not_chaseable", /^order 1000 is a stop entry \(trigger 2\.58\) and has part-filled: it cannot be chased$/);
  // Filled, or ended: refused as any buy is.
  fill(tws, 1000, "b2", 60, 2.6, 100);
  tws.emit("orderStatus", 1000, "Filled", 100, 0, 2.6);
  await refuses(s.bridge.chase({ order_id: 1000 }), 409, "already_filled");
  assert.deepEqual(tws.modified(), []);
});

test("stop entry: a trigger moved by hand in TWS is followed on the book", async (t) => {
  const r = await rig(t);
  const ib = await waitingStop(r);
  ib.reports(1000, { auxPrice: 2.62, lmtPrice: 2.65 });
  const order = r.bridge.orders()[0];
  assert.deepEqual([order?.sent.trigger, order?.sent.limit, order?.sent.first_limit], [2.62, 2.65, 2.61]);
  assert.deepEqual(r.journal.ofType("order_open").map((line) => line["prices"]), [{ limit: 2.65, trigger: 2.62 }]);
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "not_chaseable", /waits for 2\.62/);
});

// ------------------------------------------------------------------ the fill

test("stop entry: triggered and filled, it is an order like any other: Sell through the take-profit, then the stop left working is cleaned up", async (t) => {
  const r = await rig(t, { exitGraceMs: 30, world: (w) => w.bids.set("ABCD", 2.7) });
  const ib = await waitingStop(r, { alert_id: "ev-1" });
  // The price trades at 2.58: the stop triggers, and the buy fills at 2.59, under its limit.
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  fill(ib, 1000, "b1", 100, 2.59, 100);
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.59);
  ib.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  r.world.positions.set(111, 100);
  let order = r.bridge.orders()[0];
  assert.deepEqual([order?.status, order?.filled_qty, order?.avg_fill_price, order?.slip_pct, order?.held_qty], ["Filled", 100, 2.59, 3.6, 100]);
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 1 });

  // Its time comes and goes: a filled order is not expired, and keeps its alert.
  r.clock.now = Date.parse(UNTIL) + 1000;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert");
  refusesNow(() => r.bridge.cancel({ order_id: 1000 }), 409, "already_filled");

  // Sell: the take-profit is moved to the bid − 2% (2.646 → 2.64), as for any order.
  const sold = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(sold, { order_id: 1000, qty: 100, limit: 2.64, status: "Submitted", via: "take_profit" });
  assert.deepEqual(ib.modified(), [
    {
      id: 1001,
      contract: ABCD,
      order: { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.64, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    },
  ]);

  // It fills, and TWS leaves the stop working: the bridge cancels it, once, after the grace period.
  fill(ib, 1001, "s1", 100, 2.69, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.69);
  await until(() => ib.callsOf("cancelOrder").length > 0, "the clean-up cancel");
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1002]]);
  assert.deepEqual(r.journal.ofType("exit_cleanup").map((line) => [line["leg"], line["leg_order_id"]]), [["stop", 1002]]);
  order = r.bridge.orders()[0];
  assert.deepEqual([order?.held_qty, order?.exit?.status, order?.exit?.exit_pct], [0, "Filled", 3.86]);
  assert.match(order?.note ?? "", /its stop order 1002 was still working 30 ms later: the bridge cancelled it$/);
  assert.deepEqual(r.journal.ofType("entry_expired"), []);
  assert.equal(r.world.allPlaced().length, 3);
});

// ------------------------------------------------------------------ the end

test("stop entry: IB cancels it at its time with nothing filled: the alert is free, and the order says it expired", async (t) => {
  const r = await rig(t);
  const ib = await waitingStop(r, { alert_id: "ev-1" });
  expire(r, ib); // 10:05:00.4 New York
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1000); // TWS's words do not take the note's place
  const order = r.bridge.orders()[0];
  assert.deepEqual(
    [order?.status, order?.filled_qty, order?.note, order?.error, order?.legs.take_profit?.status, order?.legs.stop?.status],
    ["Cancelled", 0, EXPIRED, null, "Cancelled", "Cancelled"],
  );
  assert.deepEqual(r.journal.ofType("entry_expired"), [{ type: "entry_expired", order_id: 1000, ticker: "ABCD", good_until: UNTIL, note: EXPIRED }]);
  assert.ok(r.said.includes(`order 1000 ABCD: the stop entry ${EXPIRED}`));
  // The bridge sent nothing for it: IB did it all.
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.equal(r.world.allPlaced().length, 3);

  // A repeat of the status says nothing new.
  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.equal(r.journal.ofType("entry_expired").length, 1);

  // The alert is free again: a buy now, or another stop entry, can go for it.
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1", entry: "stop" }))).order_id, 1003);
  assert.deepEqual(r.bridge.status().today, { orders: 2, filled: 0 });

  // TWS's notice before its status: the note still ends as the expiry.
  const s = await rig(t);
  const tws = await waitingStop(s);
  s.clock.now = Date.parse(UNTIL) + 100;
  tws.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  tws.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.equal(s.bridge.orders()[0]?.note, EXPIRED);

  // A Mac clock a little behind IB's: TWS's word a moment before the time is still the expiry.
  const u = await rig(t);
  const early = await waitingStop(u);
  expire(u, early, 1000, -1500);
  assert.equal(u.bridge.orders()[0]?.note, EXPIRED);
});

test("stop entry: cancelled in TWS before its time: no expiry, and the alert is free", async (t) => {
  const r = await rig(t);
  const ib = await waitingStop(r, { alert_id: "ev-1" });
  r.clock.now = Date.parse(UNTIL) - LATER;
  for (const id of [1000, 1001, 1002]) ib.emit("orderStatus", id, "Cancelled", 0, 100, 0);
  assert.deepEqual([r.bridge.orders()[0]?.status, r.bridge.orders()[0]?.note], ["Cancelled", null]);
  assert.deepEqual(r.journal.ofType("entry_expired"), []);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("stop entry: cancelled by the owner with nothing filled: the alert is free, and it did not expire", async (t) => {
  const r = await rig(t);
  const ib = await waitingStop(r, { alert_id: "ev-1" });
  assert.deepEqual(r.bridge.cancel({ order_id: 1000 }), { order_id: 1000, status: "PendingCancel" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert"); // asked for, not confirmed

  // TWS confirms only after the stop entry's time: still the owner's cancel, not an expiry.
  r.clock.now = Date.parse(UNTIL) + 1000;
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  for (const id of [1000, 1001, 1002]) ib.emit("orderStatus", id, "Cancelled", 0, 100, 0);
  const order = r.bridge.orders()[0];
  assert.deepEqual([order?.status, order?.note], ["Cancelled", "buy: Order Canceled - reason: (code 202)"]);
  assert.deepEqual(r.journal.ofType("entry_expired"), []);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("stop entry: TWS refusing it is answered with TWS's words, the bracket is taken back, and that is no expiry", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy({ entry: "stop", alert_id: "ev-1" }));
  await until(() => r.world.current.placed().length === 3, "the bracket");
  const ib = r.world.current;
  ib.emit("error", new Error("Order rejected - reason: invalid Good Till Date"), 201, 1000);
  await refuses(pending, 502, "tws_refused", /^TWS refused order 1000: buy: Order rejected - reason: invalid Good Till Date \(code 201\)$/);
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);

  r.clock.now = Date.parse(UNTIL) + 1000;
  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.deepEqual(r.journal.ofType("entry_expired"), []);
  assert.match(r.bridge.orders()[0]?.error ?? "", /invalid Good Till Date/);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

// ------------------------------------------------------------------ restarts

test("stop entry: restart while it waits: the book comes back from the log, and IB's expiry is seen after it", async (t) => {
  const dir = tempDir(t, "stop-waiting");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  await waitingStop(a, { alert_id: "ev-1" });
  const before = a.bridge.orders();
  assert.deepEqual([before[0]?.entry, before[0]?.sent.trigger, before[0]?.sent.good_until, before[0]?.status], ["stop", 2.58, UNTIL, "PreSubmitted"]);
  a.link.stop();

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + LATER, [TOKEN]),
    now: T0 + LATER,
    world: (w) => {
      for (const id of [1000, 1001, 1002]) w.orderIds.add(id); // TWS still has the bracket
    },
  });
  assert.deepEqual(b.bridge.orders(), before);
  // Still waiting: its alert is taken, it cannot be chased, and nothing was sent.
  await refuses(b.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert");
  await refuses(b.bridge.chase({ order_id: 1000 }), 409, "not_chaseable", /^this buy waits for 2\.58/);
  assert.deepEqual(b.world.allPlaced(), []);

  expire(b, b.world.current);
  assert.deepEqual([b.bridge.orders()[0]?.status, b.bridge.orders()[0]?.note], ["Cancelled", EXPIRED]);
  assert.deepEqual(b.world.current.callsOf("cancelOrder"), []);
  assert.equal((await b.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("stop entry: restart after it expired: the note and the free alert come back", async (t) => {
  const dir = tempDir(t, "stop-expired");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const ib = await waitingStop(a, { alert_id: "ev-1" });
  expire(a, ib);
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  const before = a.bridge.orders();
  assert.equal(before[0]?.note, EXPIRED);
  a.link.stop();

  const later = Date.parse(UNTIL) + LATER;
  const b = await rig(t, { journal: new FileJournal(dir, () => later, [TOKEN]), now: later });
  assert.deepEqual(b.bridge.orders(), before);
  assert.deepEqual(b.bridge.status().today, { orders: 1, filled: 0 });
  // A notice about it after the restart does not take the note's place either.
  b.world.current.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  assert.equal(b.bridge.orders()[0]?.note, EXPIRED);
  assert.equal((await b.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("stop entry: restart after the owner's cancel: a confirmation after its time is not taken for an expiry", async (t) => {
  const dir = tempDir(t, "stop-cancelled");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  await waitingStop(a, { alert_id: "ev-1" });
  a.bridge.cancel({ order_id: 1000 });
  a.link.stop();

  const later = Date.parse(UNTIL) + 5000;
  const b = await rig(t, { journal: new FileJournal(dir, () => later, [TOKEN]), now: later });
  assert.equal(b.bridge.orders()[0]?.status, "PendingCancel");
  for (const id of [1000, 1001, 1002]) b.world.current.emit("orderStatus", id, "Cancelled", 0, 100, 0);
  assert.deepEqual([b.bridge.orders()[0]?.status, b.bridge.orders()[0]?.note], ["Cancelled", null]);
  assert.equal(new FileJournal(dir, () => later, [TOKEN]).readDay("2026-11-25").filter((line) => line["type"] === "entry_expired").length, 0);
  assert.equal((await b.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("stop entry: restart: a trigger moved in TWS comes back; a log line from before stop entries reads as a buy now", async (t) => {
  const dir = tempDir(t, "stop-moved");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const ib = await waitingStop(a);
  ib.reports(1000, { auxPrice: 2.62, lmtPrice: 2.65 });
  a.clock.now += LATER;
  await a.bridge.order(buy({ ticker: "WXYZ" }));
  const before = a.bridge.orders();
  a.link.stop();

  // The buy now's line as a bridge from before stop entries wrote it: no `entry`, no `trigger`, no `good_until`.
  const file = path.join(dir, "2026-11-25.jsonl");
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  for (const line of lines) {
    if (line["type"] !== "order_placed" || line["order_id"] !== 1003) continue;
    delete line["entry"];
    delete line["sent"]["trigger"];
    delete line["sent"]["good_until"];
  }
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const b = await rig(t, { journal: new FileJournal(dir, () => T0 + 2 * LATER, [TOKEN]), now: T0 + 2 * LATER });
  assert.deepEqual(b.bridge.orders(), before);
  const [now, stop] = b.bridge.orders();
  assert.deepEqual([stop?.entry, stop?.sent.trigger, stop?.sent.limit, stop?.sent.good_until], ["stop", 2.62, 2.65, UNTIL]);
  assert.deepEqual([now?.entry, now?.sent.trigger, now?.sent.good_until], ["now", null, null]);
});

// ------------------------------------------------------------------- HTTP

test("stop entry: over HTTP, the field, the answer and the request log", async (t) => {
  const r = await rig(t);
  const server = createBridgeServer({ bridge: r.bridge, token: TOKEN, allowedOrigins: r.config.allowedOrigins, journal: r.journal, clock: () => r.clock.now });
  const port = await listenOnLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  const post = (path: string, json: unknown): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(json));
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path,
          agent: false,
          headers: { "X-Bridge-Token": TOKEN, "Content-Type": "application/json", "Content-Length": String(payload.length) },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (chunk: Buffer) => parts.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  const bad = await post("/order", { ticker: "ABCD", alert_price: 2.5, entry: "later" });
  assert.deepEqual([bad.status, bad.body], [400, { error: 'entry must be "now" or "stop"', code: "bad_request" }]);
  const placed = await post("/order", { ticker: "ABCD", alert_price: 2.5, entry: "stop" });
  assert.equal(placed.status, 200);
  assert.deepEqual([placed.body.data.entry, placed.body.data.trigger, placed.body.data.limit, placed.body.data.good_until], ["stop", 2.58, 2.61, UNTIL]);
  const lines = r.journal.ofType("request").filter((line) => line["path"] === "/order");
  assert.deepEqual(lines.map((line) => [line["status"], line["entry"]]), [
    [400, "later"],
    [200, "stop"],
  ]);
});

// ----------------------------------------------------------------- config

test("stop entry settings: defaults, /status, bounds, and a config.json without them still loads", (t) => {
  const TOKEN64 = "0123456789abcdef".repeat(4);
  const base = (): Record<string, any> => JSON.parse(JSON.stringify(defaultConfig(TOKEN64))) as Record<string, any>;
  const problems = (raw: unknown): string[] => {
    try {
      validateConfig(raw);
      return [];
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.problems;
    }
  };
  assert.deepEqual(
    [defaultConfig(TOKEN64).order.entryStopPct, defaultConfig(TOKEN64).order.entryStopLimitPct, defaultConfig(TOKEN64).order.entryValidSec],
    [3, 1, 300],
  );

  // The owner's config.json has none of them: it loads, each at its default, and is not rewritten.
  const old = base();
  for (const key of ["entryStopPct", "entryStopLimitPct", "entryValidSec"]) delete old["order"][key];
  assert.deepEqual(problems(old), []);
  assert.deepEqual(validateConfig(old), defaultConfig(TOKEN64));
  const file = path.join(tempDir(t, "stop-config"), "config.json");
  const text = `${JSON.stringify(old, null, 2)}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  assert.deepEqual(loadOrCreateConfig(file).config.order, defaultConfig(TOKEN64).order);
  assert.equal(fs.readFileSync(file, "utf8"), text);

  // Each may be there without the others.
  for (const [key, value] of [["entryStopPct", 5], ["entryStopLimitPct", 0.5], ["entryValidSec", 60]] as const) {
    const some = JSON.parse(JSON.stringify(old)) as Record<string, any>;
    some["order"][key] = value;
    assert.deepEqual(validateConfig(some).order, { ...defaultConfig(TOKEN64).order, [key]: value });
  }

  const refused = (key: string, value: unknown, problem: RegExp): void => {
    const raw = base();
    raw["order"][key] = value;
    assert.ok(problems(raw).some((p) => problem.test(p)), `${key} = ${JSON.stringify(value)}: ${JSON.stringify(problems(raw))}`);
  };
  refused("entryStopPct", -1, /order\.entryStopPct must be at least 0/);
  refused("entryStopPct", 50.5, /order\.entryStopPct must be at most 50/);
  refused("entryStopPct", "3", /order\.entryStopPct must be a number/);
  refused("entryStopLimitPct", 0.05, /order\.entryStopLimitPct must be at least 0\.1/);
  refused("entryStopLimitPct", 21, /order\.entryStopLimitPct must be at most 20/);
  refused("entryValidSec", 9, /order\.entryValidSec must be at least 10/);
  refused("entryValidSec", 3601, /order\.entryValidSec must be at most 3600/);
  refused("entryValidSec", 30.5, /order\.entryValidSec must be a whole number/);
  refused("entryValidSec", null, /order\.entryValidSec must be a number/);
  refused("entryStopPcts", 3, /order\.entryStopPcts is not a known setting/);
  for (const [key, value] of [["entryStopPct", 0], ["entryStopPct", 50], ["entryStopLimitPct", 0.1], ["entryStopLimitPct", 20], ["entryValidSec", 10], ["entryValidSec", 3600]] as const) {
    const raw = base();
    raw["order"][key] = value;
    assert.deepEqual(problems(raw), [], `${key} = ${value}`);
  }
});

test("stop entry settings: /status carries them, and they price the order", async (t) => {
  const r = await rig(t, {
    config: (c) => {
      c.order.entryStopPct = 5;
      c.order.entryStopLimitPct = 2;
      c.order.entryValidSec = 60;
    },
  });
  const { order } = r.bridge.status();
  assert.deepEqual([order.entryStopPct, order.entryStopLimitPct, order.entryValidSec], [5, 2, 60]);
  const placed = await r.bridge.order(buy({ entry: "stop" }));
  assert.deepEqual([placed.trigger, placed.limit, placed.good_until], [2.63, 2.69, "2026-11-25T15:01:00.000Z"]);
  assert.equal(r.world.allPlaced()[0]?.order.goodTillDate, "20261125-15:01:00");
});
