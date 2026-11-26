import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CHANGE_SPACING_MS } from "../src/bridge.js";
import { FileJournal } from "../src/journal.js";
import { until } from "./fake-tws.js";
import { buy, refuses, rig, T0, TOKEN } from "./harness.js";
import { ABCD, changes, fill, partlyFilled, tempDir, working } from "./scenes.js";

// POST /chase { order_id }: a click moves a working buy up to TWS's ask + limitOffsetPct, capped
// against the alert's price like a new order, and moves the exits with it.
//
// The default bracket: alert 2.50 → buy 100 @ 2.53, take-profit 2.78, stop 2.40 / 2.37. The cap
// (maxChasePct 3) is 2.575, so an ask of 2.54 (limit 2.57) is the highest that still goes.

test("chase: the buy goes to the ask + offset and the exits keep their distances, as three changes in order", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);

  const result = await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, limit: 2.57, take_profit: 2.83, stop: 2.44, stop_limit: 2.41, chases: 1, status: "Submitted" });

  // Each change is the order itself again, under its own id, with the new price: same contract,
  // quantity, time in force and outsideRth; the exits keep their parent; each is transmitted.
  const sent = ib.modified();
  assert.deepEqual(sent.map((s) => s.id), [1000, 1001, 1002]); // the buy first, then the take-profit, then the stop
  for (const s of sent) assert.deepEqual(s.contract, ABCD);
  assert.deepEqual(
    sent.map((s) => s.order),
    [
      { action: "BUY", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.57, tif: "DAY", outsideRth: true, parentId: 0, transmit: true },
      { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.83, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
      { action: "SELL", orderType: "STP LMT", totalQuantity: 100, auxPrice: 2.44, lmtPrice: 2.41, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    ],
  );
  // No order was added, nothing was cancelled, and the ask came from one plain snapshot.
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.deepEqual(ib.callsOf("reqMktData").map((call) => call.args.slice(1)), [[ABCD, "", true, false]]);

  // /orders shows the current prices, keeps the ones the bracket was placed with, and counts.
  const order = r.bridge.orders()[0];
  assert.deepEqual(
    [order?.sent.limit, order?.sent.take_profit, order?.sent.stop, order?.sent.stop_limit],
    [2.57, 2.83, 2.44, 2.41],
  );
  assert.deepEqual(
    [order?.sent.first_limit, order?.sent.first_take_profit, order?.sent.first_stop, order?.sent.first_stop_limit],
    [2.53, 2.78, 2.4, 2.37],
  );
  assert.equal(order?.chases, 1);
  assert.equal(order?.sent.qty, 100);
  assert.equal(order?.error, null);

  // Logged like an order, with the ask it read.
  assert.deepEqual(r.journal.ofType("chase"), [
    {
      type: "chase",
      order_id: 1000,
      ticker: "ABCD",
      ask: 2.54,
      alert_price: 2.5,
      chase_pct: 2.8,
      chases: 1,
      legs: ["parent", "take_profit", "stop"],
      from: { limit: 2.53, take_profit: 2.78, stop: 2.4, stop_limit: 2.37 },
      prices: { limit: 2.57, take_profit: 2.83, stop: 2.44, stop_limit: 2.41 },
    },
  ]);
  assert.match(r.said.at(-1) ?? "", /^chase 1000 ABCD: buy limit 2\.53 → 2\.57 \(ask 2\.54, 2\.8% past the alert, chase 1 of 5\)$/);
});

test("chase: a stop that came from the alert stays where it is; the take-profit still moves", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r, { alert_stop: 2.42 });
  assert.equal(r.bridge.orders()[0]?.sent.stop_from, "alert");

  const result = await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, limit: 2.57, take_profit: 2.83, stop: 2.42, stop_limit: 2.39, chases: 1, status: "Submitted" });
  assert.deepEqual(changes(ib), [
    [1000, 100, 2.57, undefined],
    [1001, 100, 2.83, undefined],
  ]);
  assert.deepEqual(r.journal.ofType("chase")[0]?.["legs"], ["parent", "take_profit"]);
});

test("chase: a bracket without a take-profit or without a stop moves what it has", async (t) => {
  const noTarget = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54), config: (c) => (c.order.takeProfitPct = 0) });
  const a = await working(noTarget);
  assert.equal((await noTarget.bridge.chase({ order_id: 1000 })).take_profit, null);
  assert.deepEqual(changes(a), [
    [1000, 100, 2.57, undefined],
    [1002, 100, 2.41, 2.44],
  ]);

  const bare = await rig(t, {
    world: (w) => w.asks.set("ABCD", 2.54),
    config: (c) => {
      c.order.takeProfitPct = 0;
      c.order.stopPct = 0;
    },
  });
  const b = await working(bare);
  assert.deepEqual(await bare.bridge.chase({ order_id: 1000 }), {
    order_id: 1000,
    limit: 2.57,
    take_profit: null,
    stop: null,
    stop_limit: null,
    chases: 1,
    status: "Submitted",
  });
  assert.deepEqual(changes(b), [[1000, 100, 2.57, undefined]]);
});

test("chase: prices under $1 move on the hundredth of a cent", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("PENY", 0.425) });
  const ib = await working(r, { ticker: "PENY", alert_price: 0.42 }); // buy @ 0.4242
  const result = await r.bridge.chase({ order_id: 1000 });
  // 0.4250 + 1% = 0.42925 → 0.4293; + 10% → 0.4722; − 5% → 0.4078 (down); − 1% → 0.4037 (down)
  assert.deepEqual(result, { order_id: 1000, limit: 0.4293, take_profit: 0.4722, stop: 0.4078, stop_limit: 0.4037, chases: 1, status: "Submitted" });
  assert.deepEqual(changes(ib), [
    [1000, 100, 0.4293, undefined],
    [1001, 100, 0.4722, undefined],
    [1002, 100, 0.4037, 0.4078],
  ]);

  // The ask has not moved: the limit is where a chase would put it already.
  r.clock.now += 1000;
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "no_change", /^the limit 0\.4293 is already at or above the ask 0\.4250 \+ 1%$/);
  assert.equal(ib.modified().length, 3);
});

// ------------------------------------------------------------- the cap

test("chase: no further than maxChasePct above the order's own alert price; nothing is sent", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.6) });
  const ib = await working(r);
  await refuses(r.bridge.chase({ order_id: 1000 }), 422, "chase", /^the ask 2\.60 \+ 1% is 5\.2% past the alert \(the limit is 3%\)$/);
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.53);
  assert.deepEqual(r.journal.ofType("chase"), []);

  // The cap is on the limit: 2.54 + 1% = 2.57 is 2.8% past, 2.55 + 1% = 2.58 is 3.2% past.
  r.world.asks.set("ABCD", 2.55);
  await refuses(r.bridge.chase({ order_id: 1000 }), 422, "chase", /3\.2% past the alert/);
  r.world.asks.set("ABCD", 2.54);
  assert.equal((await r.bridge.chase({ order_id: 1000 })).limit, 2.57);
});

test("chase: the cap is measured from the alert's price, not from where the buy stands", async (t) => {
  // The buy was priced off an ask well under the alert; the room up to the cap is the alert's.
  const r = await rig(t, { config: (c) => (c.order.priceFrom = "ask"), world: (w) => w.asks.set("ABCD", 2.3) });
  const ib = await working(r); // alert 2.50, buy @ 2.32
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.32);
  r.world.asks.set("ABCD", 2.54);
  assert.equal((await r.bridge.chase({ order_id: 1000 })).limit, 2.57);
  assert.equal(ib.modified().length, 3);
});

test("chase: a limit that is not above the current one changes nothing (a chase only moves up)", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.5) });
  const ib = await working(r);
  // 2.50 + 1% rounds to 2.53: where the buy already is.
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "no_change", /^the limit 2\.53 is already at or above the ask 2\.50 \+ 1%$/);
  r.world.asks.set("ABCD", 2.4);
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "no_change", /^the limit 2\.53 is already at or above the ask 2\.40 \+ 1%$/);
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
});

// --------------------------------------------------------- the counters

test("chase: at most order.maxChases per order, counted per order", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.maxChases = 2), world: (w) => w.asks.set("ABCD", 2.51) });
  const ib = await working(r);
  assert.equal((await r.bridge.chase({ order_id: 1000 })).limit, 2.54);
  r.clock.now += 1000;
  r.world.asks.set("ABCD", 2.52);
  assert.deepEqual(
    [(await r.bridge.chase({ order_id: 1000 })).limit, r.bridge.orders()[0]?.chases],
    [2.55, 2],
  );
  r.clock.now += 1000;
  r.world.asks.set("ABCD", 2.53);
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "chase_limit", /^order 1000 has been chased 2 times \(order\.maxChases is 2\)$/);
  assert.equal(ib.modified().length, 6);
  assert.equal(ib.callsOf("reqMktData").length, 2); // the third click did not even ask TWS for a price

  // Another order has its own count.
  r.world.asks.set("WXYZ", 2.51);
  await r.bridge.order(buy({ ticker: "WXYZ" }));
  r.clock.now += 1000;
  assert.equal((await r.bridge.chase({ order_id: 1003 })).chases, 1);
});

test("chase: order.maxChases 0 switches it off", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.maxChases = 0), world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "chase_limit", /^chasing is switched off: order\.maxChases is 0 in config\.json$/);
  assert.deepEqual(ib.modified(), []);
  assert.deepEqual(ib.callsOf("reqMktData"), []);
});

test("chase: not within 300 ms of the previous change to the order, the placing included", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.51) });
  assert.equal(CHANGE_SPACING_MS, 300);
  await r.bridge.order(buy());
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);

  r.clock.now += 120;
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "too_soon", /^order 1000 was changed 120 ms ago: changes to one order are kept 300 ms apart$/);
  r.clock.now += 179;
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "too_soon"); // 299 ms
  assert.deepEqual(ib.modified(), []);
  r.clock.now += 1;
  await r.bridge.chase({ order_id: 1000 }); // 300 ms

  r.world.asks.set("ABCD", 2.52);
  r.clock.now += 299;
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "too_soon", /changed 299 ms ago/);
  r.clock.now += 1;
  assert.equal((await r.bridge.chase({ order_id: 1000 })).chases, 2);
  assert.equal(ib.modified().length, 6);
});

test("chase: a double click sends one chase", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  const results = await Promise.allSettled([
    r.bridge.chase({ order_id: 1000 }),
    r.bridge.chase({ order_id: 1000 }),
    r.bridge.chase({ order_id: 1000 }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected"]);
  for (const result of results.slice(1)) assert.equal((result as PromiseRejectedResult).reason.code, "too_soon");
  assert.equal(ib.modified().length, 3);
  assert.equal(r.bridge.orders()[0]?.chases, 1);
});

// ------------------------------------------------------------ the rails

test("chase: the request is { order_id } of a buy placed today, and nothing else", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  for (const body of [{}, { order_id: "1000" }, { order_id: 1000.5 }, { order_id: 0 }, { order_id: null }, null, [1000]]) {
    await refuses(r.bridge.chase(body), 400, "bad_request");
  }
  await refuses(r.bridge.chase({ order_id: 1000, limit: 2.6 }), 400, "bad_request", /unknown field "limit"/); // no price can be sent in
  await refuses(r.bridge.chase({ order_id: 1001 }), 404, "unknown_order"); // an exit's id is not a handle
  await refuses(r.bridge.chase({ order_id: 7 }), 404, "unknown_order", /^order 7 is not a buy order this bridge placed today$/);
  assert.deepEqual(ib.modified(), []);

  // The next New York day the order is not "today's" any more.
  r.clock.now += 24 * 60 * 60 * 1000;
  await refuses(r.bridge.chase({ order_id: 1000 }), 404, "unknown_order");
  assert.deepEqual(ib.modified(), []);
});

test("chase: halted, disabled, a live account, TWS offline or gone all refuse it", async (t) => {
  const asks = (w: { asks: Map<string, number> }): void => void w.asks.set("ABCD", 2.54);

  const halted = await rig(t, { world: asks });
  await working(halted);
  halted.bridge.halt({ halted: true });
  await refuses(halted.bridge.chase({ order_id: 1000 }), 409, "halted");

  const disabled = await rig(t, { world: asks });
  await working(disabled);
  disabled.config.enabled = false;
  await refuses(disabled.bridge.chase({ order_id: 1000 }), 409, "disabled");

  const live = await rig(t, { world: asks });
  await working(live);
  live.world.current.emit("managedAccounts", "U7654321");
  await refuses(live.bridge.chase({ order_id: 1000 }), 409, "paper_only");

  const offline = await rig(t, { world: asks });
  await working(offline);
  offline.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  await refuses(offline.bridge.chase({ order_id: 1000 }), 503, "tws_offline");

  const down = await rig(t, { world: asks });
  await working(down);
  down.world.mode = "refuse";
  down.world.drop();
  await refuses(down.bridge.chase({ order_id: 1000 }), 503, "tws_down");

  for (const r of [halted, disabled, live, offline, down]) {
    assert.deepEqual(r.world.allModified(), []);
    assert.equal(r.bridge.orders()[0]?.chases, 0);
    assert.deepEqual(r.world.instances.flatMap((ib) => ib.callsOf("reqMktData")), []); // refused before TWS was asked anything
  }
});

test("chase: the daily order count, the ticker's duplicate window and maxNotionalUsd do not stand in its way", async (t) => {
  // One order a day, and 395 × 2.53 = 999.35 of the 1000 allowed: a chase adds no order and no shares.
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 1), world: (w) => w.asks.set("ABCD", 2.54) });
  await r.bridge.order(buy({ qty: 395 }));
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 395, 0);
  r.clock.now += 1000; // inside the 10 s duplicate window
  await refuses(r.bridge.order(buy({ ticker: "WXYZ" })), 409, "daily_limit");
  await refuses(r.bridge.preview(buy()), 409, "daily_limit");

  assert.equal((await r.bridge.chase({ order_id: 1000 })).limit, 2.57);
  assert.deepEqual(changes(ib).map(([id, qty]) => [id, qty]), [
    [1000, 395],
    [1001, 395],
    [1002, 395],
  ]);
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 }); // still one order
});

// ---------------------------------------------- which orders can be chased

test("chase: only a buy that is still working with something left to fill", async (t) => {
  const asks = (w: { asks: Map<string, number> }): void => void w.asks.set("ABCD", 2.54);

  const done = await rig(t, { world: asks });
  const a = await working(done);
  a.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  await refuses(done.bridge.chase({ order_id: 1000 }), 409, "already_filled", /^order 1000 has filled: there is nothing left to chase$/);

  // Every share is in, by the fills, before TWS has said "Filled".
  const allIn = await rig(t, { world: asks });
  const b = await working(allIn);
  fill(b, 1000, "e1", 100, 2.52, 100);
  await refuses(allIn.bridge.chase({ order_id: 1000 }), 409, "already_filled");

  const cancelled = await rig(t, { world: asks });
  const c = await working(cancelled);
  c.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  await refuses(cancelled.bridge.chase({ order_id: 1000 }), 409, "already_done", /^order 1000 is already Cancelled$/);

  const cancelling = await rig(t, { world: asks });
  await working(cancelling);
  cancelling.bridge.cancel({ order_id: 1000 });
  await refuses(cancelling.bridge.chase({ order_id: 1000 }), 409, "already_done", /^order 1000 is being cancelled$/);

  const refused = await rig(t, { world: asks });
  const e = await working(refused);
  e.emit("error", new Error("Order rejected - reason: no"), 201, 1002); // the bridge is taking the bracket back
  await refuses(refused.bridge.chase({ order_id: 1000 }), 409, "already_done", /being cancelled/);

  for (const r of [done, allIn, cancelled, cancelling, refused]) assert.deepEqual(r.world.allModified(), []);
});

test("chase: a partly filled buy is chased for its whole quantity (TWS knows what has filled)", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await partlyFilled(r, 60);
  const result = await r.bridge.chase({ order_id: 1000 });
  assert.equal(result.limit, 2.57);
  assert.deepEqual(changes(ib).map(([id, qty]) => [id, qty]), [
    [1000, 100],
    [1001, 100],
    [1002, 100],
  ]);
  assert.equal(r.bridge.orders()[0]?.filled_qty, 60);
});

test("chase: an exit that has ended in TWS is left alone", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0); // the take-profit was cancelled by hand in TWS
  await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(changes(ib), [
    [1000, 100, 2.57, undefined],
    [1002, 100, 2.41, 2.44],
  ]);
  assert.equal(r.bridge.orders()[0]?.sent.take_profit, 2.78); // the book does not claim a price it did not send
});

// ----------------------------------------------------- the quote, the log

test("chase: without a live ask there is no chase, whatever askFallback says", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.askFallback = "alert") });
  const ib = await working(r);
  await refuses(r.bridge.chase({ order_id: 1000 }), 504, "no_ask", /^no ask for ABCD from TWS within 40 ms$/);

  const pending = r.bridge.chase({ order_id: 1000 });
  await until(() => ib.callsOf("reqMktData").length === 2, "the second snapshot");
  ib.emit("error", new Error("Requested market data is not subscribed"), 354, ib.callsOf("reqMktData")[1]?.args[0]);
  await refuses(pending, 502, "no_ask", /^TWS gave no ask for ABCD: Requested market data is not subscribed \(code 354\)$/);

  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
  assert.deepEqual(r.journal.ofType("chase"), []);
});

test("chase: a change that cannot be written to the log is not sent", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  r.journal.failWrites = true;
  await refuses(r.bridge.chase({ order_id: 1000 }), 500, "log_failed", /^order 1000 was NOT changed: the log cannot be written/);
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.53);

  r.journal.failWrites = false;
  assert.equal((await r.bridge.chase({ order_id: 1000 })).chases, 1);
});

// --------------------------------------------- things happening meanwhile

test("chase: a fill arriving between the snapshot and the change stops the chase", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  // TWS fills the buy while the bridge waits for the ask.
  r.world.onMktData = (tws) => {
    fill(tws, 1000, "e1", 100, 2.53, 100);
    tws.emit("orderStatus", 1000, "Filled", 100, 0, 2.53);
  };
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "already_filled");
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.bridge.orders()[0]?.chases, 0);
  assert.deepEqual([r.bridge.orders()[0]?.sent.limit, r.bridge.orders()[0]?.sent.take_profit], [2.53, 2.78]);
});

test("chase: the halt pressed, or a cancel sent, while the ask is being read stops it too", async (t) => {
  const halted = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  await working(halted);
  halted.world.onMktData = () => void halted.bridge.halt({ halted: true });
  await refuses(halted.bridge.chase({ order_id: 1000 }), 409, "halted");

  const cancelled = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  await working(cancelled);
  cancelled.world.onMktData = () => void cancelled.bridge.cancel({ order_id: 1000 });
  await refuses(cancelled.bridge.chase({ order_id: 1000 }), 409, "already_done");

  assert.deepEqual(halted.world.allModified(), []);
  assert.deepEqual(cancelled.world.allModified(), []);
});

test("chase: a partial fill arriving while the ask is read does not change the quantity sent", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  r.world.onMktData = (tws) => fill(tws, 1000, "e1", 30, 2.53, 30);
  await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(changes(ib).map(([id, qty]) => [id, qty]), [
    [1000, 100],
    [1001, 100],
    [1002, 100],
  ]);
});

test("chase: the buy fills while the change is on its way: the book ends with what TWS has", async (t) => {
  const r = await rig(t, { ackWaitMs: 500, world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  // TWS, a moment after each message: the buy had just filled at its old limit, so its change is
  // refused; the exits, working now, take theirs.
  r.world.onOrder = (tws, id, _order, change) => {
    if (!change) return;
    queueMicrotask(() => {
      if (id === 1000) {
        fill(tws, 1000, "e1", 100, 2.53, 100);
        tws.emit("orderStatus", 1000, "Filled", 100, 0, 2.53);
        tws.emit("error", new Error("Cannot modify a filled order."), 104, 1000);
      } else {
        tws.reports(id);
      }
    });
  };

  // Not an error for the click: the buy is done, and the answer says where everything stands.
  const result = await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, limit: 2.53, take_profit: 2.83, stop: 2.44, stop_limit: 2.41, chases: 1, status: "Filled" });

  const order = r.bridge.orders()[0];
  assert.equal(order?.status, "Filled");
  assert.equal(order?.sent.limit, 2.53); // TWS never had 2.57 for the buy
  assert.deepEqual([order?.sent.take_profit, order?.sent.stop, order?.sent.stop_limit], [2.83, 2.44, 2.41]); // it has these
  assert.equal(order?.avg_fill_price, 2.53);
  // A note on a buy that did what it was for, not an error.
  assert.equal(order?.error, null);
  assert.match(order?.note ?? "", /^the chase came after the buy had filled: buy: Cannot modify a filled order\. \(code 104\)$/);

  // The bridge sent its three messages once. It moved nothing back and cancelled nothing.
  assert.equal(ib.modified().length, 3);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(
    r.journal.ofType("change_refused").map((line) => [line["leg"], line["code"], line["prices"]]),
    [["parent", 104, { limit: 2.53 }]],
  );

  // TWS's refusal overtakes its word on the fill: the answer is the same, and the order carries
  // TWS's words as they came.
  const s = await rig(t, { ackWaitMs: 500, world: (w) => w.asks.set("ABCD", 2.54) });
  await working(s);
  s.world.onOrder = (tws, id, _order, change) => {
    if (!change || id !== 1000) return;
    queueMicrotask(() => {
      tws.emit("error", new Error("Cannot modify a filled order."), 104, 1000);
      tws.emit("orderStatus", 1000, "Filled", 100, 0, 2.53);
    });
  };
  assert.equal((await s.bridge.chase({ order_id: 1000 })).status, "Filled");
  assert.equal(s.bridge.orders()[0]?.sent.limit, 2.53);
  assert.match(s.bridge.orders()[0]?.error ?? "", /^chase refused by TWS: buy: Cannot modify a filled order\. \(code 104\)$/);
});

test("chase: TWS refuses the new limit: the buy stays where it was, on the book too, and is not cancelled", async (t) => {
  const r = await rig(t, { ackWaitMs: 500, world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  r.world.onOrder = (tws, id, _order, change) => {
    if (!change) return;
    queueMicrotask(() => {
      if (id === 1000) tws.emit("error", new Error("Order rejected - reason: price too far from the market"), 201, 1000);
      else tws.reports(id);
    });
  };
  await refuses(
    r.bridge.chase({ order_id: 1000 }),
    502,
    "tws_refused",
    /^TWS refused the new limit for order 1000: buy: Order rejected - reason: price too far from the market \(code 201\)\. The buy is Submitted at 2\.53; \/orders shows where its exits are$/,
  );

  const order = r.bridge.orders()[0];
  assert.equal(order?.status, "Submitted");
  assert.deepEqual(
    [order?.sent.limit, order?.sent.take_profit, order?.sent.stop, order?.sent.stop_limit],
    [2.53, 2.83, 2.44, 2.41],
  );
  assert.equal(order?.chases, 1); // it was sent: it counts
  // A refused change is not a refused order: the bracket is not taken back.
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.equal(ib.modified().length, 3);
});

test("chase: TWS refuses the change to an exit: that exit is back at its old price on the book, nothing is cancelled", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  await r.bridge.chase({ order_id: 1000 });
  ib.reports(1000);
  ib.reports(1001);
  ib.emit("error", new Error("The price does not conform to the minimum price variation for this contract."), 110, 1002);

  const order = r.bridge.orders()[0];
  assert.deepEqual(
    [order?.sent.limit, order?.sent.take_profit, order?.sent.stop, order?.sent.stop_limit],
    [2.57, 2.83, 2.4, 2.37],
  );
  assert.match(order?.error ?? "", /^chase refused by TWS: stop: The price does not conform/);
  // Before the chase could be sent, a refused leg of an unfilled bracket meant "take the bracket
  // back". A refused change does not: the stop is still there, at 2.40.
  assert.deepEqual(ib.callsOf("cancelOrder"), []);

  // "Still being processed" is numbered like a warning and is a refusal all the same.
  const again = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const other = await working(again);
  await again.bridge.chase({ order_id: 1000 });
  other.emit("error", new Error("Unable to modify this order as it is still being processed."), 2102, 1000);
  assert.equal(again.bridge.orders()[0]?.sent.limit, 2.53);
  assert.match(again.bridge.orders()[0]?.error ?? "", /^chase refused by TWS: buy: Unable to modify this order/);
  // An ordinary warning about a changed order leaves the change standing.
  other.emit("error", new Error("Order Event Warning: Attribute 'Outside Regular Trading Hours' is ignored"), 2109, 1001);
  assert.equal(again.bridge.orders()[0]?.sent.take_profit, 2.83);
});

test("chase: the answer waits for TWS's word on the change itself, not for a status that only repeats itself", async (t) => {
  // TWS repeats the buy's status at once, and refuses the change a moment later.
  const r = await rig(t, { ackWaitMs: 400, world: (w) => w.asks.set("ABCD", 2.54) });
  await working(r);
  r.world.onOrder = (tws, id, _order, change) => {
    if (!change || id !== 1000) return;
    queueMicrotask(() => tws.emit("orderStatus", 1000, "Submitted", 0, 100, 0));
    setTimeout(() => tws.emit("error", new Error("Order rejected - reason: no"), 201, 1000), 30);
  };
  await refuses(r.bridge.chase({ order_id: 1000 }), 502, "tws_refused");
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.53);

  // TWS reports the buy with its new limit: that is the answer, and the click does not wait longer.
  const s = await rig(t, { ackWaitMs: 5000, world: (w) => w.asks.set("ABCD", 2.54) });
  await working(s);
  s.world.onOrder = (tws, id, _order, change) => {
    if (change) queueMicrotask(() => (tws.emit("orderStatus", id, "Submitted", 0, 100, 0), tws.reports(id)));
  };
  const started = Date.now();
  assert.equal((await s.bridge.chase({ order_id: 1000 })).limit, 2.57);
  assert.ok(Date.now() - started < 2000);

  // TWS says nothing at all: the answer comes after the wait, with what was sent.
  const quiet = await rig(t, { ackWaitMs: 40, world: (w) => w.asks.set("ABCD", 2.54) });
  await working(quiet);
  assert.deepEqual([(await quiet.bridge.chase({ order_id: 1000 })).limit, quiet.bridge.orders()[0]?.error], [2.57, null]);
});

test("chase: when TWS refuses a change, the book goes back to TWS's own last word on the order", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  await r.bridge.chase({ order_id: 1000 }); // the book says 2.57
  // TWS reports the buy at 2.55: it was moved there by hand a moment before, and the chase has not been taken.
  ib.reports(1000, { lmtPrice: 2.55 });
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.55);
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1000);
  // Not the 2.53 the book had before the chase: 2.55 is what TWS has.
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.55);
  assert.deepEqual(r.journal.ofType("change_refused")[0]?.["prices"], { limit: 2.55 });
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
});

test("chase: a refusal long after a change is about the order, not the change", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  await r.bridge.chase({ order_id: 1000 });
  r.clock.now += 6000; // TWS never reported the orders back, and six seconds have gone
  ib.emit("error", new Error("Order rejected - reason: something"), 201, 1002);
  // The stop's price on the book stays the one that was sent, and the old rule applies: a refused
  // leg of an unfilled bracket takes the bracket back.
  assert.equal(r.bridge.orders()[0]?.sent.stop, 2.44);
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);

  // And once TWS has reported an order with its new price, a refusal is not about that change either.
  const s = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const tws = await working(s);
  await s.bridge.chase({ order_id: 1000 });
  tws.reports(1002);
  tws.emit("error", new Error("Order rejected - reason: something"), 201, 1002);
  assert.equal(s.bridge.orders()[0]?.sent.stop, 2.44);
  assert.deepEqual(tws.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
});

test("chase: a message that cannot be sent part-way: what went out stays, the rest is not tried, the book says exactly that", async (t) => {
  // The take-profit's change (the second message) fails.
  const r = await rig(t, { world: (w) => void w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  r.world.failModifyAt = 2;
  await refuses(
    r.bridge.chase({ order_id: 1000 }),
    502,
    "send_failed",
    /^order 1000 for ABCD: the buy moved to 2\.57, then sending failed \(encoder blew up\): the take-profit stays at 2\.78, the stop stays at 2\.40 \/ 2\.37$/,
  );
  // The fake logs the failed call too: the buy's change went out, the take-profit's blew up, the stop's was never tried.
  assert.deepEqual(ib.modified().map((s) => s.id), [1000, 1001]);
  const order = r.bridge.orders()[0];
  assert.deepEqual(
    [order?.sent.limit, order?.sent.take_profit, order?.sent.stop, order?.sent.stop_limit],
    [2.57, 2.78, 2.4, 2.37],
  );
  assert.equal(order?.chases, 1);
  assert.match(order?.error ?? "", /^chase: order 1000 for ABCD: the buy moved to 2\.57, then sending failed/);
  assert.deepEqual(r.journal.ofType("chase_failed")[0]?.["prices"], { limit: 2.57, take_profit: 2.78, stop: 2.4, stop_limit: 2.37 });
  // Nothing is sent again on its own, and nothing is cancelled.
  assert.deepEqual(ib.callsOf("cancelOrder"), []);

  // The next click is a whole chase again, from where things stand (the ask must have moved on).
  r.world.failModifyAt = 0;
  r.clock.now += 1000;
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "no_change");

  // The very first message fails: nothing changed, and the click does not count.
  const s = await rig(t, { world: (w) => void w.asks.set("ABCD", 2.54) });
  const tws = await working(s);
  s.world.failModifyAt = 1;
  await refuses(
    s.bridge.chase({ order_id: 1000 }),
    502,
    "send_failed",
    /^order 1000 for ABCD was not changed \(encoder blew up\): the buy stays at 2\.53, the take-profit stays at 2\.78, the stop stays at 2\.40 \/ 2\.37$/,
  );
  assert.deepEqual(tws.modified().map((sent) => sent.id), [1000]);
  assert.equal(s.bridge.orders()[0]?.chases, 0);
  assert.equal(s.bridge.orders()[0]?.sent.limit, 2.53);
  assert.equal(s.bridge.orders()[0]?.error, null);
});

// ------------------------------------------------- what TWS itself reports

test("chase: the book follows TWS's own report of an order, so a buy moved by hand is chased from there", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.53) });
  const ib = await working(r);
  // The operator drags the buy to 2.56 in TWS.
  ib.reports(1000, { lmtPrice: 2.56 });
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.56);
  assert.equal(r.bridge.orders()[0]?.sent.first_limit, 2.53);
  assert.deepEqual(r.journal.ofType("order_open"), [
    { type: "order_open", order_id: 1000, ticker: "ABCD", leg: "parent", leg_order_id: 1000, prices: { limit: 2.56 } },
  ]);
  // A report that says what the book says is not a line in the log.
  ib.reports(1000, { lmtPrice: 2.56 });
  ib.reports(1001);
  ib.reports(1002);
  assert.equal(r.journal.ofType("order_open").length, 1);

  // 2.53 + 1% = 2.56: a chase from the book's old 2.53 would have moved the buy; from where it
  // really is, it would not move it up, so it does nothing (and never moves it down).
  await refuses(r.bridge.chase({ order_id: 1000 }), 409, "no_change", /^the limit 2\.56 is already at or above the ask 2\.53 \+ 1%$/);
  assert.deepEqual(ib.modified(), []);

  // The exits' prices are followed the same way.
  ib.reports(1001, { lmtPrice: 2.9 });
  ib.reports(1002, { auxPrice: 2.45, lmtPrice: 2.43 });
  const { sent } = r.bridge.orders()[0] ?? {};
  assert.deepEqual([sent?.take_profit, sent?.stop, sent?.stop_limit], [2.9, 2.45, 2.43]);

  // An order of another API client with the same number, or one that is not the side ours is, is not ours.
  ib.emit("openOrder", 1000, {}, { action: "BUY", lmtPrice: 9.99, totalQuantity: 100, clientId: 5 }, {});
  ib.emit("openOrder", 1000, {}, { action: "SELL", lmtPrice: 9.99, totalQuantity: 100, clientId: 77 }, {});
  ib.emit("openOrder", 4242, {}, { action: "BUY", lmtPrice: 9.99, totalQuantity: 100, clientId: 77 }, {});
  assert.equal(r.bridge.orders()[0]?.sent.limit, 2.56);
});

test("chase: it never raises a quantity: an order made smaller in TWS is chased at that size", async (t) => {
  const r = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const ib = await working(r);
  // The operator cuts the buy to 50 shares in TWS; TWS reports the buy, and the exits at 50 too.
  ib.reports(1000, { totalQuantity: 50 });
  ib.reports(1001, { totalQuantity: 50 });
  ib.reports(1002, { totalQuantity: 50 });
  assert.equal(r.bridge.orders()[0]?.sent.qty, 50);

  await r.bridge.chase({ order_id: 1000 });
  assert.deepEqual(changes(ib).map(([id, qty]) => [id, qty]), [
    [1000, 50],
    [1001, 50],
    [1002, 50],
  ]);

  // TWS reports only the stop smaller: only the stop's change is smaller.
  const s = await rig(t, { world: (w) => w.asks.set("ABCD", 2.54) });
  const tws = await working(s);
  tws.reports(1002, { totalQuantity: 40 });
  await s.bridge.chase({ order_id: 1000 });
  assert.deepEqual(changes(tws).map(([id, qty]) => [id, qty]), [
    [1000, 100],
    [1001, 100],
    [1002, 40],
  ]);
  // In no message of any chase in this file is a quantity above the order's own.
  for (const sent of [...r.world.allModified(), ...s.world.allModified()]) assert.ok((sent.order.totalQuantity ?? 0) <= 100);
});

// ---------------------------------------------------------------- restart

test("chase: after a restart the book has the chased prices, the first ones and the count", async (t) => {
  const dir = tempDir(t, "chase");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), config: (c) => (c.order.maxChases = 2), world: (w) => w.asks.set("ABCD", 2.51) });
  const ib = await working(a);
  await a.bridge.chase({ order_id: 1000 }); // → 2.54 / 2.79 / 2.41 / 2.38
  ib.reports(1000);
  ib.reports(1001);
  // TWS refuses the stop's change, and the operator then drags the take-profit to 2.85.
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1002);
  ib.reports(1001, { lmtPrice: 2.85 });
  const before = a.bridge.orders();
  assert.deepEqual(
    [before[0]?.sent.limit, before[0]?.sent.take_profit, before[0]?.sent.stop, before[0]?.sent.stop_limit, before[0]?.chases],
    [2.54, 2.85, 2.4, 2.37, 1],
  );
  a.link.stop();

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    config: (c) => (c.order.maxChases = 2),
    now: T0 + 60_000,
    world: (w) => {
      w.asks.set("ABCD", 2.53);
      for (const id of [1000, 1001, 1002]) w.orderIds.add(id); // TWS still has the bracket
    },
  });
  assert.deepEqual(b.bridge.orders(), before);
  assert.equal(b.bridge.orders()[0]?.sent.first_limit, 2.53);
  assert.match(b.bridge.orders()[0]?.error ?? "", /^chase refused by TWS: stop: Order rejected/);

  // The second chase goes to the same three orders, and it is the last one allowed.
  const result = await b.bridge.chase({ order_id: 1000 });
  assert.deepEqual([result.limit, result.chases], [2.56, 2]);
  assert.deepEqual(b.world.current.modified().map((s) => s.id), [1000, 1001, 1002]);
  assert.deepEqual(b.world.allPlaced(), []);
  b.clock.now += 1000;
  b.world.asks.set("ABCD", 2.54);
  await refuses(b.bridge.chase({ order_id: 1000 }), 409, "chase_limit");
});

test("chase: a log line of an order placed before the bridge could chase reads back with its first prices", async (t) => {
  const dir = tempDir(t, "chase-old");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  await a.bridge.order(buy());
  a.link.stop();
  // The bridge as it was before wrote no `first_` prices, no `chases`, no `sizing`, no `held_qty`, no `exit`.
  const file = path.join(dir, "2026-11-25.jsonl");
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, any>);
  for (const line of lines) {
    if (line["type"] !== "order_placed") continue;
    for (const key of ["chases", "sizing", "held_qty", "exit"]) delete line[key];
    for (const key of ["first_limit", "first_take_profit", "first_stop", "first_stop_limit"]) delete line["sent"][key];
  }
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    now: T0 + 60_000,
    world: (w) => {
      w.asks.set("ABCD", 2.54);
      for (const id of [1000, 1001, 1002]) w.orderIds.add(id);
    },
  });
  const order = b.bridge.orders()[0];
  assert.deepEqual(
    [order?.sent.first_limit, order?.sent.first_take_profit, order?.sent.first_stop, order?.sent.first_stop_limit],
    [2.53, 2.78, 2.4, 2.37],
  );
  assert.deepEqual([order?.chases, order?.sizing, order?.held_qty, order?.exit], [0, { mode: "shares" }, 0, null]);
  assert.equal((await b.bridge.chase({ order_id: 1000 })).limit, 2.57);
  assert.equal(b.bridge.orders()[0]?.sent.first_limit, 2.53);
});
