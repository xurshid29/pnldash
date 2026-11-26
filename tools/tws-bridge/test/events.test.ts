import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { loadOrCreateConfig, persistHalted } from "../src/config.js";
import { FileJournal } from "../src/journal.js";
import { until } from "./fake-tws.js";
import type { FakeIb } from "./fake-tws.js";
import { buy, refuses, refusesNow, rig, T0, TOKEN } from "./harness.js";

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fill(ib: FakeIb, orderId: number, execId: string, shares: number, price: number, cumQty?: number, avgPrice?: number): void {
  ib.emit("execDetails", -1, { symbol: "ABCD" }, { orderId, execId, shares, price, cumQty, avgPrice, time: "20261125 10:00:01" });
}

// ------------------------------------------------------- fills and slippage

test("fills: filled quantity, average price and slip_pct against the alert's price", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy()); // alert 2.50, limit 2.53
  const ib = r.world.current;

  ib.emit("orderStatus", 1000, "PreSubmitted", 0, 100, 0);
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0); // TWS repeats itself
  assert.equal(r.bridge.orders()[0]?.status, "Submitted");
  assert.equal(r.bridge.orders()[0]?.slip_pct, null);
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });

  fill(ib, 1000, "e1", 60, 2.52, 60, 2.52);
  let order = r.bridge.orders()[0];
  assert.equal(order?.filled_qty, 60);
  assert.equal(order?.avg_fill_price, 2.52);
  assert.equal(order?.slip_pct, 0.8); // 2.52 against 2.50
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 1 });

  ib.emit("orderStatus", 1000, "Submitted", 60, 40, 2.52);
  fill(ib, 1000, "e2", 40, 2.54, 100, 2.528);
  fill(ib, 1000, "e2", 40, 2.54, 100, 2.528); // the same fill reported twice counts once
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.528);

  order = r.bridge.orders()[0];
  assert.equal(order?.status, "Filled");
  assert.equal(order?.filled_qty, 100);
  assert.equal(order?.avg_fill_price, 2.528);
  assert.equal(order?.slip_pct, 1.12);

  // Every status change once (a status that only repeats what a fill already said is not one),
  // every fill once, each with the slip.
  assert.deepEqual(
    r.journal.ofType("order_status").map((line) => [line["leg"], line["status"], line["filled"], line["slip_pct"]]),
    [
      ["parent", "PreSubmitted", 0, null],
      ["parent", "Submitted", 0, null],
      ["parent", "Filled", 100, 1.12],
    ],
  );
  assert.deepEqual(
    r.journal.ofType("fill").map((line) => [line["ticker"], line["exec_id"], line["shares"], line["price"], line["alert_price"], line["slip_pct"]]),
    [
      ["ABCD", "e1", 60, 2.52, 2.5, 0.8],
      ["ABCD", "e2", 40, 2.54, 2.5, 1.12],
    ],
  );
});

test("fills: without TWS's running totals the average is worked out from the fills", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  fill(r.world.current, 1000, "a", 60, 2.52);
  fill(r.world.current, 1000, "b", 40, 2.54);
  const order = r.bridge.orders()[0];
  assert.equal(order?.filled_qty, 100);
  assert.ok(Math.abs((order?.avg_fill_price ?? 0) - 2.528) < 1e-9);
  assert.equal(order?.slip_pct, 1.12);
});

test("fills: a fill under the alert's price is a negative slip; a status alone is enough", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  r.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.45);
  const order = r.bridge.orders()[0];
  assert.equal(order?.filled_qty, 100);
  assert.equal(order?.avg_fill_price, 2.45);
  assert.equal(order?.slip_pct, -2);
});

test("fills: the exits are followed too, and they do not move the buy's numbers", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  ib.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  ib.emit("orderStatus", 1002, "PreSubmitted", 0, 100, 0);
  fill(ib, 1001, "x1", 100, 2.78, 100, 2.78);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);

  const order = r.bridge.orders()[0];
  assert.deepEqual(order?.legs, {
    take_profit: { order_id: 1001, status: "Filled", filled_qty: 100, avg_fill_price: 2.78 },
    stop: { order_id: 1002, status: "Cancelled", filled_qty: 0, avg_fill_price: null },
  });
  assert.equal(order?.status, "Filled");
  assert.equal(order?.avg_fill_price, 2.52);
  assert.equal(order?.slip_pct, 0.8);
  assert.deepEqual(r.journal.ofType("fill").map((line) => [line["leg"], line["leg_order_id"], line["price"]]), [["take_profit", 1001, 2.78]]);
});

test("fills: events for orders the bridge did not place are ignored", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  const ib = r.world.current;
  ib.emit("orderStatus", 42, "Filled", 500, 0, 9.99);
  fill(ib, 42, "z", 500, 9.99, 500, 9.99);
  ib.emit("error", new Error("Order rejected"), 201, 42);
  assert.equal(r.bridge.orders().length, 1);
  assert.equal(r.bridge.orders()[0]?.status, "PendingSubmit");
  assert.equal(r.bridge.orders()[0]?.error, null);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
});

// ------------------------------------------------------------ TWS says no

test("TWS refuses the buy: /order answers with TWS's words and the bracket is taken back once", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.placed().length === 3, "the bracket");
  const ib = r.world.current;
  ib.emit("error", new Error("Order rejected - reason: insufficient funds"), 201, 1000);
  await refuses(pending, 502, "tws_refused", /^TWS refused order 1000: buy: Order rejected - reason: insufficient funds \(code 201\)$/);

  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  // The exits fall with it; that is no reason to cancel again.
  ib.emit("error", new Error("Order rejected - reason: parent order is being cancelled"), 201, 1002);
  assert.equal(ib.callsOf("cancelOrder").length, 1);

  const order = r.bridge.orders()[0];
  assert.match(order?.error ?? "", /^stop: Order rejected - reason: parent order is being cancelled \(code 201\)$/);
  assert.equal(r.journal.ofType("order_error").length, 2);
  assert.equal(r.journal.ofType("order_cleanup").length, 1);
  // It was sent, so it counts for the day.
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });
  // Nothing is ever placed again on its own.
  assert.equal(r.world.allPlaced().length, 3);
});

test("TWS refuses an exit: the whole unfilled bracket is cancelled, not left half-built", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.placed().length === 3, "the bracket");
  r.world.current.emit("error", new Error("The price does not conform to the minimum price variation for this contract."), 110, 1002);
  await refuses(pending, 502, "tws_refused", /stop: The price does not conform/);
  assert.deepEqual(r.world.current.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
});

test("TWS refuses an exit after the buy filled: the error is kept, nothing is cancelled", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  ib.emit("error", new Error("Order rejected - reason: something"), 201, 1002);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.match(r.bridge.orders()[0]?.error ?? "", /^stop: Order rejected/);
});

test("TWS warnings and cancel notices are notes, not refusals", async (t) => {
  const r = await rig(t, { ackWaitMs: 500 });
  const pending = r.bridge.order(buy());
  await until(() => r.world.current.placed().length === 3, "the bracket");
  const ib = r.world.current;
  ib.emit("error", new Error("Order Message: BUY 100 ABCD Warning: your order will not be placed at the exchange until 04:00"), 399, 1000);
  ib.emit("error", new Error("Order Event Warning: Attribute 'Outside Regular Trading Hours' is ignored"), 2109, 1002);
  ib.emit("orderStatus", 1000, "PreSubmitted", 0, 100, 0);
  assert.equal((await pending).status, "PreSubmitted");

  let order = r.bridge.orders()[0];
  assert.equal(order?.error, null);
  assert.match(order?.note ?? "", /^stop: Order Event Warning.*\(code 2109\)$/);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);

  // "Order Canceled" after a cancel is the cancel working, not a failure.
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  order = r.bridge.orders()[0];
  assert.equal(order?.error, null);
  assert.equal(order?.status, "Cancelled");
  assert.equal(ib.callsOf("cancelOrder").length, 1);
});

test("a leg that cannot be sent: the legs already in TWS are taken back", async (t) => {
  const r = await rig(t, { world: (w) => (w.failPlaceOrderAt = 2) });
  await refuses(r.bridge.order(buy()), 502, "send_failed", /order 1000 for ABCD was not placed: sending failed after 1 of 3 legs/);
  assert.deepEqual(r.world.current.placed().map((p) => [p.id, p.order.transmit]), [
    [1000, false],
    [1001, false],
  ]);
  assert.deepEqual(r.world.current.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  assert.match(r.bridge.orders()[0]?.error ?? "", /sending failed/);
});

test("an order that cannot be written to the log is not sent", async (t) => {
  const r = await rig(t);
  r.journal.failWrites = true;
  await refuses(r.bridge.order(buy()), 500, "log_failed", /the order was NOT sent/);
  assert.deepEqual(r.world.allPlaced(), []);
  assert.deepEqual(r.bridge.orders(), []);

  r.journal.failWrites = false;
  const result = await r.bridge.order(buy());
  assert.equal(result.order_id, 1003); // the ids set aside for the failed attempt are not reused
});

// ---------------------------------------------------------------- cancel

test("cancel: cancels the buy by its order id; TWS takes the exits with it", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);

  assert.deepEqual(r.bridge.cancel({ order_id: 1000 }), { order_id: 1000, status: "PendingCancel" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  assert.deepEqual(r.journal.ofType("cancel"), [{ type: "cancel", order_id: 1000, ticker: "ABCD" }]);

  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.equal(r.bridge.orders()[0]?.status, "Cancelled");
  refusesNow(() => r.bridge.cancel({ order_id: 1000 }), 409, "already_done", /order 1000 is already Cancelled/);
  assert.equal(ib.callsOf("cancelOrder").length, 1);
});

test("cancel: only a buy this bridge placed, by a whole-number id", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  refusesNow(() => r.bridge.cancel({ order_id: 1001 }), 404, "unknown_order"); // an exit's id is not a handle
  refusesNow(() => r.bridge.cancel({ order_id: 7 }), 404, "unknown_order");
  for (const body of [{}, { order_id: "1000" }, { order_id: 1000.5 }, { order_id: -1 }, { order_id: null }, null]) {
    refusesNow(() => r.bridge.cancel(body), 400, "bad_request");
  }
  refusesNow(() => r.bridge.cancel({ order_id: 1000, all: true }), 400, "bad_request", /unknown field "all"/);
  assert.deepEqual(r.world.current.callsOf("cancelOrder"), []);
});

test("cancel: a filled buy has nothing to cancel, and its exits are left alone", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  r.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  refusesNow(() => r.bridge.cancel({ order_id: 1000 }), 409, "already_filled", /take-profit and stop stay working in TWS/);
  assert.deepEqual(r.world.current.callsOf("cancelOrder"), []);
});

test("cancel: works while halted, and needs TWS", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy());
  r.bridge.halt({ halted: true });
  assert.equal(r.bridge.cancel({ order_id: 1000 }).status, "PendingCancel");

  await r.bridge.halt({ halted: false });
  r.clock.now += 60_000;
  await r.bridge.order(buy());
  r.world.mode = "refuse";
  r.world.drop();
  refusesNow(() => r.bridge.cancel({ order_id: 1003 }), 503, "tws_down");
});

// ------------------------------------------------------ restart, the log

test("restart: today's orders come back from the log; the daily count and the duplicate window hold", async (t) => {
  const dir = tempDir(t);
  const limits = (c: { limits: { maxOrdersPerDay: number } }): void => {
    c.limits.maxOrdersPerDay = 2;
  };
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), config: limits });
  await a.bridge.order(buy({ alert_stop: 2.42, stage: "band" }));
  a.world.current.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  fill(a.world.current, 1000, "e1", 100, 2.52, 100, 2.52);
  a.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  a.world.current.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  a.world.current.emit("error", new Error("Order Event Warning: something"), 2109, 1002);
  const before = a.bridge.orders();
  a.link.stop();

  // Five seconds later the bridge is started again. TWS offers the same next order id as before
  // (as it does when its own numbering was reset).
  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 5000, [TOKEN]),
    config: limits,
    now: T0 + 5000,
    world: (w) => (w.nextValidId = 1000),
  });
  assert.deepEqual(b.bridge.orders(), before);
  assert.deepEqual(b.bridge.status().today, { orders: 1, filled: 1 });
  assert.equal(b.bridge.orders()[0]?.slip_pct, 0.8);
  assert.equal(b.bridge.orders()[0]?.legs.take_profit?.status, "Submitted");

  // On connecting it asks TWS where its orders stand, and sends none.
  assert.equal(b.world.current.callsOf("reqOpenOrders").length, 1);
  assert.deepEqual(b.world.current.callsOf("reqExecutions")[0]?.args[1], { clientId: "77" });
  assert.deepEqual(b.world.allPlaced(), []);

  // A fill TWS reports again after the restart is not counted twice.
  fill(b.world.current, 1000, "e1", 100, 2.52, 100, 2.52);
  assert.equal(b.bridge.orders()[0]?.filled_qty, 100);

  await refuses(b.bridge.order(buy()), 409, "duplicate", /ABCD was ordered 5s ago/);
  // Ids 1000-1002 were used before the restart: the next order starts after them.
  assert.equal((await b.bridge.order(buy({ ticker: "WXYZ" }))).order_id, 1003);
  assert.deepEqual(b.world.allPlaced().map((p) => p.id), [1003, 1004, 1005]);
  await refuses(b.bridge.order(buy({ ticker: "QQQQ" })), 409, "daily_limit", /2 of 2 today/);
  b.bridge.cancel({ order_id: 1003 }); // an order restored or new can be cancelled alike
});

test("restart: with no orders today, connecting asks TWS for nothing about orders", async (t) => {
  const r = await rig(t);
  assert.deepEqual(r.world.current.callsOf("reqOpenOrders"), []);
  assert.deepEqual(r.world.current.callsOf("reqExecutions"), []);
  assert.deepEqual(r.world.current.callsOf("placeOrder"), []);

  // After a reconnect with an order on the book, it does ask — and still sends nothing.
  await r.bridge.order(buy());
  r.world.drop();
  await until(() => r.link.isReady(), "ready again");
  assert.equal(r.world.current.callsOf("reqOpenOrders").length, 1);
  assert.deepEqual(r.world.current.callsOf("placeOrder"), []);
  assert.equal(r.world.allPlaced().length, 3);
});

test("log: one JSONL file per New York date, a time on every line, never the token", async (t) => {
  const dir = tempDir(t);
  // 22:00 on the 25th in New York; the UTC date is the 26th.
  const now = Date.parse("2026-11-26T03:00:00Z");
  const journal = new FileJournal(dir, () => now, [TOKEN]);
  const r = await rig(t, { journal, now });
  await r.bridge.order(buy());
  r.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  journal.write("request", { path: "/order", note: `someone put the token ${TOKEN} in a field` });

  assert.deepEqual(fs.readdirSync(dir), ["2026-11-25.jsonl"]);
  const text = fs.readFileSync(path.join(dir, "2026-11-25.jsonl"), "utf8");
  assert.equal(text.includes(TOKEN), false);
  assert.ok(text.includes("[redacted]"));
  const lines = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const line of lines) assert.equal(line["t"], "2026-11-26T03:00:00.000Z");
  const types = lines.map((line) => line["type"]);
  for (const type of ["tws_up", "order_placed", "order_status", "request"]) assert.ok(types.includes(type), type);

  const placed = lines.find((line) => line["type"] === "order_placed") as Record<string, any>;
  assert.equal(placed["ticker"], "ABCD");
  assert.equal(placed["asked"].alert_price, 2.5);
  assert.deepEqual(
    [placed["sent"].limit, placed["sent"].take_profit, placed["sent"].stop, placed["sent"].stop_limit],
    [2.53, 2.78, 2.4, 2.37],
  );
  assert.deepEqual(placed["sent"].order_ids, { parent: 1000, take_profit: 1001, stop: 1002 });
  const filled = lines.find((line) => line["type"] === "order_status");
  assert.deepEqual([filled?.["status"], filled?.["filled"], filled?.["alert_price"], filled?.["slip_pct"]], ["Filled", 100, 2.5, 0.8]);
  // The account id is masked in the log as well.
  assert.equal(text.includes("DU1234567"), false);
});

test("log: a torn or foreign line in the day's file does not stop a start", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "2026-11-25.jsonl"),
    ['{"type":"order_placed","order_id":"not a number"}', "{ torn", "[1,2,3]", '{"type":"fill","leg_order_id":5}', ""].join("\n"),
  );
  const r = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  assert.deepEqual(r.bridge.orders(), []);
  await r.bridge.order(buy());
  assert.equal(r.bridge.orders().length, 1);
});

// --------------------------------------------------------- halt, on disk

test("halt persistence: the switch is in config.json and holds after a restart", async (t) => {
  const file = path.join(tempDir(t), "config.json");
  loadOrCreateConfig(file);
  const a = await rig(t, { saveHalted: (halted) => persistHalted(file, halted) });
  a.bridge.halt({ halted: true });
  a.link.stop();

  const loaded = loadOrCreateConfig(file).config;
  assert.equal(loaded.halted, true);
  assert.equal(loaded.paperOnly, true);
  const b = await rig(t, {
    config: (c) => (c.halted = loaded.halted),
    saveHalted: (halted) => persistHalted(file, halted),
  });
  await refuses(b.bridge.order(buy()), 409, "halted");
  assert.deepEqual(b.world.allPlaced(), []);

  b.bridge.halt({ halted: false });
  assert.equal(loadOrCreateConfig(file).config.halted, false);
});
