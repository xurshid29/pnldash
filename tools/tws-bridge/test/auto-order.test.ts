import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderBook, recordFromJournal } from "../src/book.js";
import { autoOrderConfig } from "../src/bridge.js";
import type { AutoBuy } from "../src/bridge.js";
import { AUTO_DEFAULTS, defaultConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { listing, until } from "./fake-tws.js";
import { buy, refuses, rig, T0, TOKEN } from "./harness.js";
import type { Rig } from "./harness.js";
import { ABCD, autoRig, boughtAll, fill, iso, pop, taken, W0 } from "./scenes.js";

// The bridge's side of the automation's buy (src/bridge.ts, "the automation"): the bracket it
// sends for a POP, priced from `auto` alone, down the same road and rails as a click's "Buy if ≥".
//
// The default one: alert 2.50 → BUY STP LMT 150, trigger 2.63 (2.625 to the nearest tick), limit
// 2.66 (2.6563 up), take-profit 3.16 (3.156), stop 2.36 (2.367 down), its limit 2.28 (2.2892
// down); 150 = floor(400 / 2.66). Placed at W0 (04:30 New York), good till 300 s later.

const CLOSE = Date.parse("2026-11-25T10:00:00Z");
const SEC = 1000;

let alerts = 0;

function autoBuy(r: Rig, overrides: Partial<AutoBuy> = {}): AutoBuy {
  alerts += 1;
  return { ticker: "ABCD", alertPrice: 2.5, alertAt: iso(r.clock.now), alertId: `pop-o${alerts}`, validSec: 300, notAfterMs: CLOSE, ...overrides };
}

function bracket(gtd: string, qty = 150): Array<Record<string, unknown>> {
  return [
    { action: "BUY", orderType: "STP LMT", totalQuantity: qty, auxPrice: 2.63, lmtPrice: 2.66, tif: "GTD", goodTillDate: gtd, outsideRth: true, parentId: 0, transmit: false },
    { action: "SELL", orderType: "LMT", totalQuantity: qty, lmtPrice: 3.16, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
    { action: "SELL", orderType: "STP LMT", totalQuantity: qty, auxPrice: 2.36, lmtPrice: 2.28, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
  ];
}

/** A click's "Buy if ≥" with the click settings' defaults: alert 2.50 → trigger 2.58, limit 2.61, take-profit 2.84, stop 2.45 / 2.42, 100 shares. */
function clickStopBracket(gtd: string): Array<Record<string, unknown>> {
  return [
    { action: "BUY", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.58, lmtPrice: 2.61, tif: "GTD", goodTillDate: gtd, outsideRth: true, parentId: 0, transmit: false },
    { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.84, tif: "GTC", outsideRth: true, parentId: 1000, transmit: false },
    { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.45, lmtPrice: 2.42, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
  ];
}

// ------------------------------------------------------------------ the buy

test("auto order: a BUY STP LMT 5% over the alert, its limit 1% over that, exits from the trigger, $400 of shares, GTD", async (t) => {
  const a = await autoRig(t);
  const setup = pop(W0, { id: "pop-the-one" });
  await a.send(setup);
  const placed = a.world.allPlaced();
  assert.deepEqual(placed.map((p) => p.id), [1000, 1001, 1002]);
  assert.deepEqual(placed.map((p) => p.order), bracket("20261125-09:35:00"));
  for (const p of placed) assert.deepEqual(p.contract, ABCD);

  const [record] = a.bridge.orders();
  assert.equal(record?.source, "auto");
  assert.deepEqual(record?.asked, { alert_price: 2.5, alert_stop: null, qty: null, stage: "pop", alert_at: setup.at, alert_id: "pop-the-one" });
  assert.deepEqual(record?.sizing, { mode: "usd", amount_usd: 400 });
  assert.equal(record?.entry, "stop");
  assert.deepEqual(record?.sent, {
    qty: 150,
    limit: 2.66,
    trigger: 2.63,
    good_until: iso(W0 + 300 * SEC),
    take_profit: 3.16,
    stop: 2.36,
    stop_limit: 2.28,
    first_limit: 2.66,
    first_take_profit: 3.16,
    first_stop: 2.36,
    first_stop_limit: 2.28,
    price_from: "alert",
    stop_from: "pct",
    outside_rth: true,
    order_ids: { parent: 1000, take_profit: 1001, stop: 1002 },
  });
  assert.deepEqual([record?.watch, record?.exit, record?.chases], [null, null, 0]);
  // The log line says whose it is.
  assert.equal(a.journal.ofType("order_placed")[0]?.["source"], "auto");
  // No ask was read for it.
  assert.deepEqual(a.world.current.callsOf("reqMktData"), []);
});

test("auto order: its prices on both sides of $1, and the bridge's share limit still holds", async (t) => {
  const r = await rig(t, { now: W0, world: (w) => w.contracts.set("CENT", [listing("CENT", 901, "NASDAQ")]) });
  const prices = async (ticker: string, alertPrice: number): Promise<number[]> => {
    const record = await r.bridge.autoOrder(autoBuy(r, { ticker, alertPrice }));
    const { sent } = record;
    return [sent.trigger ?? 0, sent.limit, sent.qty, sent.take_profit ?? 0, sent.stop ?? 0, sent.stop_limit ?? 0];
  };
  // 1.23: 1.2915 → 1.29; 1.3029 → 1.31 (up); 400 / 1.31 = 305.3; 1.548 → 1.55; 1.161 → 1.16; 1.1252 → 1.12.
  assert.deepEqual(await prices("WXYZ", 1.23), [1.29, 1.31, 305, 1.55, 1.16, 1.12]);
  // 0.85: 0.8925; 0.901425 → 0.9015 (up); 443.7 → 443; 1.071 → 1.07 (cents above $1); 0.80325 → 0.8032; 0.779104 → 0.7791.
  assert.deepEqual(await prices("QQQQ", 0.85), [0.8925, 0.9015, 443, 1.07, 0.8032, 0.7791]);
  // 12: 12.60; 12.726 → 12.73; 31.4 → 31; 15.12; 11.34; 10.9998 → 10.99.
  assert.deepEqual(await prices("PENY", 12), [12.6, 12.73, 31, 15.12, 11.34, 10.99]);
  // 0.50: $400 is 754 shares at 0.5303, above limits.maxShares (500): refused, as a click would be.
  await refuses(r.bridge.autoOrder(autoBuy(r, { ticker: "CENT", alertPrice: 0.5 })), 422, "too_many_shares", /^\$400 at 0\.5303 is 754 shares, above maxShares \(500\)$/);
  assert.equal(r.world.allPlaced().length, 9);
});

test("auto order: the click's settings do not leak into it", async (t) => {
  const r = await rig(t, {
    now: W0,
    config: (c) => {
      c.order.takeProfitPct = 7;
      c.order.stopPct = 3;
      c.order.stopLimitOffsetPct = 0.5;
      c.order.entryStopPct = 2;
      c.order.entryStopLimitPct = 4;
      c.order.entryValidSec = 60;
      c.order.amountUsd = 250;
      c.order.qty = 77;
      c.order.useAlertStop = true;
      c.order.priceFrom = "ask";
      c.order.limitOffsetPct = 2;
      c.order.maxChasePct = 2.5;
    },
    world: (w) => w.asks.set("ABCD", 9),
  });
  await r.bridge.autoOrder(autoBuy(r));
  assert.deepEqual(r.world.allPlaced().map((p) => p.order), bracket("20261125-09:35:00"));
  assert.deepEqual(r.world.current.callsOf("reqMktData"), []);
});

test("auto order: the automation's settings do not change what a click on Buy if ≥ sends", async (t) => {
  const odd = (c: Config): void => {
    c.auto.entryStopPct = 9;
    c.auto.entryStopLimitPct = 2;
    c.auto.entryValidSec = 100;
    c.auto.takeProfitPct = 30;
    c.auto.stopPct = 15;
    c.auto.stopLimitOffsetPct = 5;
    c.auto.amountUsd = 300;
  };
  const r = await rig(t, { config: odd }); // 10:00 New York, outside the automation's hour
  const order = await r.bridge.order(buy({ entry: "stop" }));
  assert.deepEqual(r.world.allPlaced().map((p) => p.order), clickStopBracket("20261125-15:05:00"));
  assert.deepEqual([order.sizing, order.good_until], [{ mode: "shares" }, iso(T0 + 300 * SEC)]);
  assert.equal(r.bridge.orders()[0]?.source, "click");

  // A click at 04:59 New York waits its full 300 s: the end of the automation's hour is not its end.
  const early = await rig(t, { now: CLOSE - 60 * SEC, config: odd });
  const late = await early.bridge.order(buy({ entry: "stop" }));
  assert.equal(late.good_until, iso(CLOSE + 240 * SEC));
});

test("auto order: its alert is used up: a click on the same alert id is refused duplicate_alert", async (t) => {
  const a = await autoRig(t);
  await a.send(pop(W0, { id: "pop-taken" }));
  a.clock.now += 20 * SEC;
  await refuses(a.bridge.order(buy({ ticker: "WXYZ", alert_id: "pop-taken" })), 409, "duplicate_alert", /\(order 1000, ABCD, 04:30:00 New York\)$/);
  await refuses(a.bridge.order(buy({ ticker: "WXYZ", entry: "stop", alert_id: "pop-taken" })), 409, "duplicate_alert");
  await refuses(a.bridge.preview(buy({ alert_id: "pop-taken" })), 409, "duplicate_alert");
  assert.equal(a.world.allPlaced().length, 3);
});

test("auto order: autoPlan is the bracket autoOrder sends, and asks TWS nothing", async (t) => {
  const r = await rig(t, { now: W0 });
  const { plan, goodUntilMs } = r.bridge.autoPlan(autoBuy(r));
  assert.deepEqual(
    [plan.entry, plan.trigger, plan.limit, plan.qty, plan.takeProfit, plan.stop, plan.stopLimit, plan.sizing, plan.notional],
    ["stop", 2.63, 2.66, 150, 3.16, 2.36, 2.28, { mode: "usd", amount_usd: 400 }, 399],
  );
  assert.equal(goodUntilMs, W0 + 300 * SEC);
  assert.equal(r.bridge.autoPlan(autoBuy(r, { notAfterMs: W0 + 90_500 })).goodUntilMs, W0 + 90 * SEC);
  assert.deepEqual(
    r.world.current.calls.filter((call) => ["reqContractDetails", "reqMktData", "placeOrder", "modifyOrder"].includes(call.name)),
    [],
  );
  const { sent } = await r.bridge.autoOrder(autoBuy(r));
  assert.deepEqual(
    [sent.trigger, sent.limit, sent.qty, sent.take_profit, sent.stop, sent.stop_limit, sent.good_until],
    [plan.trigger, plan.limit, plan.qty, plan.takeProfit, plan.stop, plan.stopLimit, iso(goodUntilMs)],
  );
});

test("auto order: its buy may work outside regular hours whatever order.outsideRth says, its hour being all pre-market", async (t) => {
  const r = await rig(t, { now: W0, config: (c) => (c.order.outsideRth = false) });
  await r.bridge.autoOrder(autoBuy(r));
  assert.deepEqual(r.world.allPlaced().map((p) => p.order.outsideRth), [true, true, true]);
});

// ------------------------------------------------------------------ its time

test("auto order: it waits until the sooner of now + validSec and notAfterMs (on a whole second); under 5 s left it is not sent", async (t) => {
  const r = await rig(t, { now: W0 });
  const soon = await r.bridge.autoOrder(autoBuy(r, { notAfterMs: W0 + 61_500 }));
  assert.equal(soon.sent.good_until, iso(W0 + 61 * SEC));
  assert.equal(r.world.allPlaced()[0]?.order.goodTillDate, "20261125-09:31:01");

  r.clock.now += 11 * SEC;
  const later = await r.bridge.autoOrder(autoBuy(r, { ticker: "WXYZ", notAfterMs: CLOSE }));
  assert.equal(later.sent.good_until, iso(W0 + 311 * SEC));

  await refuses(r.bridge.autoOrder(autoBuy(r, { ticker: "QQQQ", notAfterMs: r.clock.now + 4999 })), 409, "window_closing");
  assert.equal(r.world.allPlaced().length, 6);
  const five = await r.bridge.autoOrder(autoBuy(r, { ticker: "PENY", notAfterMs: r.clock.now + 5000 }));
  assert.equal(five.sent.good_until, iso(r.clock.now + 5000));
});

// --------------------------------------------------------------- the rails

test("auto order: a buy above limits.maxNotionalUsd (auto.amountUsd 1200) is refused too_large when tried", async (t) => {
  const r = await rig(t, {
    now: W0,
    config: (c) => {
      c.auto.amountUsd = 1200;
      c.auto.budgetUsd = 2400;
    },
  });
  await refuses(r.bridge.autoOrder(autoBuy(r)), 422, "too_large", /^the order is \$1199\.66 \(451 × 2\.66, sized from \$1200\), above maxNotionalUsd \(\$1000\)$/);
  assert.deepEqual(r.world.allPlaced(), []);
});

test("auto order: the clicks' and the automation's daily counts are kept apart, each against its own limit", async (t) => {
  const r = await rig(t, {
    now: W0,
    config: (c) => {
      c.auto.maxOrdersPerDay = 2;
      c.limits.maxOrdersPerDay = 1;
    },
  });
  await r.bridge.autoOrder(autoBuy(r));
  await r.bridge.autoOrder(autoBuy(r, { ticker: "WXYZ" }));
  await refuses(r.bridge.autoOrder(autoBuy(r, { ticker: "QQQQ" })), 409, "daily_limit", /^the automation's daily order limit is reached: 2 of 2 today/);
  assert.equal((await r.bridge.order(buy({ ticker: "PENY" }))).order_id, 1006);
  await refuses(r.bridge.order(buy({ ticker: "QQQQ" })), 409, "daily_limit", /^the daily order limit is reached: 1 of 1 today/);
  assert.equal(r.bridge.status().today.orders, 3);
});

test("auto order: autoBlocker says the switch, the connection or the account; autoOrder itself holds the same rails", async (t) => {
  const r = await rig(t, { now: W0 });
  assert.equal(r.bridge.autoBlocker(), null);
  r.config.enabled = false;
  assert.equal(r.bridge.autoBlocker()?.code, "disabled");
  await refuses(r.bridge.autoOrder(autoBuy(r)), 409, "disabled");
  r.config.enabled = true;
  r.config.halted = true;
  assert.equal(r.bridge.autoBlocker()?.code, "halted");
  await refuses(r.bridge.autoOrder(autoBuy(r)), 409, "halted");
  r.config.halted = false;
  r.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  assert.equal(r.bridge.autoBlocker()?.code, "tws_offline");
  await refuses(r.bridge.autoOrder(autoBuy(r)), 503, "tws_offline");
  r.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  assert.equal(r.bridge.autoBlocker(), null);

  const down = await rig(t, { now: W0, world: (w) => (w.mode = "refuse"), connect: false });
  assert.equal(down.bridge.autoBlocker()?.code, "tws_down");
  await refuses(down.bridge.autoOrder(autoBuy(down)), 503, "tws_down");

  const live = (w: { accounts: string | null }): void => void (w.accounts = "U7654321");
  const locked = await rig(t, { now: W0, world: live, config: (c) => (c.paperOnly = false) });
  assert.equal(locked.bridge.autoBlocker()?.code, "not_paper");
  await refuses(locked.bridge.autoOrder(autoBuy(locked)), 409, "not_paper", /auto\.paperOnly/);
  const open = await rig(t, {
    now: W0,
    world: live,
    config: (c) => {
      c.paperOnly = false;
      c.auto.paperOnly = false;
    },
  });
  assert.equal(open.bridge.autoBlocker(), null);
  for (const x of [r, down, locked]) assert.deepEqual(x.world.allPlaced(), []);
});

test("auto order: a buy that is not a whole one is refused before anything is asked of TWS", async (t) => {
  const r = await rig(t, { now: W0 });
  const bad: Array<Partial<AutoBuy>> = [
    { validSec: 9 },
    { validSec: 3601 },
    { validSec: 30.5 },
    { notAfterMs: Number.NaN },
    { alertId: "" },
    { alertId: "x".repeat(81) },
    { ticker: "AB CD" },
    { alertPrice: 0 },
    { alertPrice: Number.NaN },
    { alertAt: "yesterday" },
  ];
  for (const overrides of bad) await refuses(r.bridge.autoOrder(autoBuy(r, overrides)), 400, "bad_request");
  assert.deepEqual(r.world.current.callsOf("reqContractDetails"), []);
  assert.deepEqual(r.world.allPlaced(), []);
});

test("auto order: autoSell sells only an order of the automation's", async (t) => {
  const r = await rig(t, { now: W0, world: (w) => w.bids.set("ABCD", 2.4) });
  const click = await r.bridge.order(buy());
  boughtAll(r, click.order_id, 2.52);
  r.clock.now += SEC;
  await refuses(r.bridge.autoSell(click.order_id, 2.4), 409, "not_auto");
  await refuses(r.bridge.autoSell(4242, 2.4), 404, "unknown_order");
  assert.deepEqual(r.world.allModified(), []);
  // The click's own Sell works as always.
  assert.equal((await r.bridge.sell({ order_id: click.order_id })).via, "take_profit");
});

// -------------------------------------------------------- expiry and cancels

test("auto order: a stop entry whose time passed while TWS was away is taken as expired 5 s into the new connection, auto or clicked; nothing is sent", async (t) => {
  const a = await autoRig(t);
  const decision = await a.send(pop(W0));
  taken(a, decision?.order_id ?? 0);
  const click = await a.bridge.order(buy({ ticker: "WXYZ", entry: "stop" }));
  taken(a, click.order_id);
  a.world.mode = "refuse";
  a.world.drop();
  await until(() => !a.link.isReady(), "TWS gone");
  a.clock.now = W0 + 301 * SEC; // both expire in IB, and nobody tells the bridge
  const upAt = a.clock.now;
  a.world.mode = "accept";
  await until(() => a.link.isReady(), "TWS back");
  const ib = a.world.current;
  const statuses = (): string[] => a.bridge.orders().flatMap((order) => [order.status, order.legs.take_profit?.status ?? "", order.legs.stop?.status ?? ""]);

  // TWS is given 5 s to report its open orders and today's fills.
  assert.deepEqual(statuses(), Array(6).fill("PreSubmitted"));
  a.clock.now = upAt + 4999;
  assert.deepEqual(statuses(), Array(6).fill("PreSubmitted"));
  assert.deepEqual(verdictOf(await a.send(pop(a.clock.now))), ["skipped", "ticker_open"]);

  a.clock.now = upAt + 5000;
  assert.deepEqual(statuses(), Array(6).fill("Cancelled"));
  for (const order of a.bridge.orders()) assert.equal(order.note, "expired unfilled at 04:35:00 New York");
  assert.deepEqual(
    a.journal.ofType("entry_expiry_assumed").map((line) => [line["order_id"], line["good_until"], line["connected_at"]]),
    [
      [1000, iso(W0 + 300 * SEC), iso(upAt)],
      [1003, iso(W0 + 300 * SEC), iso(upAt)],
    ],
  );
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.deepEqual(ib.placed(), []);
  // The automation's slot and ticker are free again.
  assert.equal(a.auto.status().today.waiting, 0);
  assert.deepEqual(verdictOf(await a.send(pop(a.clock.now))), ["placed", "placed"]);
});

function verdictOf(decision: { action: string; reason: string } | undefined): [string, string] | undefined {
  return decision === undefined ? undefined : [decision.action, decision.reason];
}

test("auto order: a stop entry whose time passes while TWS is connected is left for TWS to report", async (t) => {
  const r = await rig(t, { now: W0 });
  const record = await r.bridge.autoOrder(autoBuy(r));
  taken(r, record.order_id);
  r.clock.now = W0 + 400 * SEC;
  assert.equal(r.bridge.orders()[0]?.status, "PreSubmitted");
  assert.deepEqual(r.journal.ofType("entry_expiry_assumed"), []);
  // TWS's own word then: an expiry, with its note.
  for (const id of [1000, 1001, 1002]) r.world.current.emit("orderStatus", id, "Cancelled", 0, 150, 0);
  assert.equal(r.bridge.orders()[0]?.note, "expired unfilled at 04:35:00 New York");
});

test("auto order: TWS's answer to a cancel of a buy settles it: 'cannot be cancelled, state: Filled', and 'no such order' after a part fill", async (t) => {
  // Its fills came while TWS was away, its status never did: the cancel's answer says it filled.
  const r = await rig(t, { now: W0 });
  await r.bridge.order(buy());
  r.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  fill(r.world.current, 1000, "b1", 100, 2.52, 100);
  r.bridge.cancel({ order_id: 1000 });
  assert.equal(r.bridge.orders()[0]?.status, "PendingCancel");
  r.world.current.emit("error", new Error("OrderId 1000 that needs to be cancelled cannot be cancelled, state: Filled."), 10148, 1000);
  assert.deepEqual([r.bridge.orders()[0]?.status, r.bridge.orders()[0]?.filled_qty], ["Filled", 100]);

  // Part-filled, its cancel asked for, and TWS has no such order: the rest is gone, the 40 stay bought.
  const p = await rig(t, { now: W0 });
  await p.bridge.order(buy());
  p.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  fill(p.world.current, 1000, "b1", 40, 2.52, 40);
  p.bridge.cancel({ order_id: 1000 });
  p.world.current.emit("error", new Error("Order with id 1000 cannot be found"), 10147, 1000);
  const order = p.bridge.orders()[0];
  assert.deepEqual([order?.status, order?.filled_qty, order?.held_qty], ["Cancelled", 40, 40]);
});

// ------------------------------------------------------------ the book

test("auto order: the book reads source back from the log; a line without it is a click", async (t) => {
  const r = await rig(t, { now: W0 });
  await r.bridge.autoOrder(autoBuy(r));
  await r.bridge.order(buy({ ticker: "WXYZ" }));
  const lines = r.journal.ofType("order_placed");
  assert.deepEqual(lines.map((line) => line["source"]), ["auto", "click"]);
  const book = new OrderBook();
  book.restore(lines);
  assert.deepEqual(book.all().map((order) => [order.order_id, order.source]), [
    [1000, "auto"],
    [1003, "click"],
  ]);
  // Written before the automation existed: no source, so a click. Anything else is no "auto" either.
  const older = { ...lines[0] };
  delete older["source"];
  const old = new OrderBook();
  old.restore([older]);
  assert.equal(old.all()[0]?.source, "click");
  assert.equal(recordFromJournal({ ...lines[0], source: "robot" })?.source, "click");
  assert.equal(recordFromJournal({ ...lines[0] })?.source, "auto");
  assert.equal(recordFromJournal({ ...lines[0] })?.watch, null);
});

test("autoOrderConfig: the automation's settings over the click's, the alert's stop never used, the click's left as they were", () => {
  const order = { ...defaultConfig(TOKEN).order, takeProfitPct: 7, stopPct: 3, useAlertStop: true, amountUsd: 250, entryValidSec: 60, entryStopPct: 2 };
  const before = { ...order };
  assert.deepEqual(autoOrderConfig(order, AUTO_DEFAULTS, 120), {
    ...order,
    amountUsd: 400,
    entryStopPct: 5,
    entryStopLimitPct: 1,
    entryValidSec: 120,
    takeProfitPct: 20,
    stopPct: 10,
    stopLimitOffsetPct: 3,
    useAlertStop: false,
  });
  assert.deepEqual(order, before);
});
