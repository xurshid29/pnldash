import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { FileJournal } from "../src/journal.js";
import { listing } from "./fake-tws.js";
import type { FakeTws } from "./fake-tws.js";
import { buy, refuses, rig, T0, TOKEN } from "./harness.js";

// One order per alert: an alert_id is refused (409 duplicate_alert) while an order placed today
// with that id is still working or has any fill. An order that ended with nothing filled frees
// its alert, whoever ended it: cancelled by the operator, refused by TWS, never sent.

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-alert-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Well past the ticker's own duplicate window (10 s), so only the alert rule can say no. */
const LATER = 60_000;

const TAKEN = /^this alert already has an order \(order 1000, ABCD, 10:00:00 New York\)$/;

test("alert: a second order for the same alert is refused, for /order and /preview alike", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" })); // 10:00:00 in New York
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  await refuses(r.bridge.preview(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  assert.equal(r.world.allPlaced().length, 3);

  // The rule is about the alert, whatever else the request says.
  await refuses(r.bridge.order(buy({ alert_id: "ev-1", alert_price: 2.6, qty: 10 })), 409, "duplicate_alert", TAKEN);
  await refuses(r.bridge.order(buy({ alert_id: "ev-1", ticker: "WXYZ" })), 409, "duplicate_alert", TAKEN);
  assert.equal(r.world.allPlaced().length, 3);

  // Another alert on the same ticker is another decision, and so is a click with no alert id.
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-2" }))).order_id, 1003);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy())).order_id, 1006);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy())).order_id, 1009);
});

test("alert: it is checked before the ticker's duplicate window, and says which order has the alert", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  r.clock.now += 2000;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  // Another alert on that ticker two seconds later is the ticker rule's business.
  await refuses(r.bridge.order(buy({ alert_id: "ev-2" })), 409, "duplicate", /ABCD was ordered 2s ago/);
});

test("alert: ids are compared as strings", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: 987 })); // a number on the wire
  assert.equal(r.bridge.orders()[0]?.asked.alert_id, "987");
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "987" })), 409, "duplicate_alert", TAKEN);
  await refuses(r.bridge.order(buy({ alert_id: 987 })), 409, "duplicate_alert", TAKEN);

  await r.bridge.order(buy({ ticker: "WXYZ", alert_id: "55" })); // text first, a number later
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ ticker: "WXYZ", alert_id: 55 })), 409, "duplicate_alert", /order 1003, WXYZ, 10:01:00 New York/);

  // Text that only looks like the same number is another id.
  assert.equal((await r.bridge.order(buy({ ticker: "QQQQ", alert_id: "0987" }))).order_id, 1006);
  assert.equal(r.world.allPlaced().length, 9);
});

test("alert: two tabs clicking the same alert at once place one order", async (t) => {
  const r = await rig(t);
  const results = await Promise.allSettled([
    r.bridge.order(buy({ alert_id: "ev-1" })),
    r.bridge.order(buy({ alert_id: "ev-1" })),
    r.bridge.order(buy({ alert_id: "ev-1" })),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected"]);
  for (const result of results.slice(1)) assert.equal((result as PromiseRejectedResult).reason.code, "duplicate_alert");
  assert.equal(r.world.allPlaced().length, 3);
});

test("alert: /preview lists the check, and a preview does not use the alert up", async (t) => {
  const r = await rig(t);
  const preview = await r.bridge.preview(buy({ alert_id: "ev-1" }));
  assert.deepEqual(
    preview.checks.map((check) => check.name),
    ["switches", "account", "alert", "shares", "daily", "duplicate", "contract", "limit", "take_profit", "stop", "notional"],
  );
  assert.equal(preview.checks.find((check) => check.name === "alert")?.detail, "no order uses up this alert today");
  await r.bridge.preview(buy({ alert_id: "ev-1" }));
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1000);
});

test("alert: an order the operator cancelled frees its alert once TWS confirms the cancel", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN); // working

  // Asked for, not yet confirmed: the buy can still fill, so the alert is still taken.
  assert.equal(r.bridge.cancel({ order_id: 1000 }).status, "PendingCancel");
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  await refuses(r.bridge.preview(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  assert.equal(r.world.allPlaced().length, 3);

  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.equal(r.bridge.orders()[0]?.status, "Cancelled");
  assert.equal(r.bridge.orders()[0]?.error, null);

  // Ended with nothing filled: the Buy can come back, and a new order goes out.
  const preview = await r.bridge.preview(buy({ alert_id: "ev-1" }));
  assert.equal(preview.checks.find((check) => check.name === "alert")?.detail, "no order uses up this alert today");
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
  assert.equal(r.world.allPlaced().length, 6);

  // The new order is working: now it has the alert.
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", /\(order 1003, ABCD, 10:01:00 New York\)$/);
});

test("alert: an order cancelled in TWS itself frees its alert the same way", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 0, 100, 0);
  // The operator cancels it in TWS: the bridge only hears the status.
  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);

  // "ApiCancelled" is the same ending under TWS's other name.
  ib.emit("orderStatus", 1003, "ApiCancelled", 0, 100, 0);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1006);
});

test("alert: a cancelled order with a partial fill still uses up its alert", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Submitted", 40, 60, 2.52);
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", 40, 60, 2.52);
  const [order] = r.bridge.orders();
  assert.deepEqual([order?.status, order?.filled_qty], ["Cancelled", 40]);

  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  assert.equal(r.world.allPlaced().length, 3);
});

test("alert: a cancelled order still counts for the day and still starts the ticker's window", async (t) => {
  const r = await rig(t, { config: (c) => (c.limits.maxOrdersPerDay = 2) });
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  r.bridge.cancel({ order_id: 1000 });
  r.world.current.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.deepEqual(r.bridge.status().today, { orders: 1, filled: 0 });

  // The alert is free, but the ticker was ordered three seconds ago.
  r.clock.now += 3000;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate", /ABCD was ordered 3s ago/);

  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003); // the second of two
  r.bridge.cancel({ order_id: 1003 });
  r.world.current.emit("orderStatus", 1003, "Cancelled", 0, 100, 0);

  // Free again, but the day's two orders are spent, cancelled or not.
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "daily_limit", /2 of 2 today/);
  assert.deepEqual(r.bridge.status().today, { orders: 2, filled: 0 });
});

test("alert: a filled order uses up its alert, also when TWS refused one of its exits afterwards", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);

  ib.emit("error", new Error("Order rejected - reason: something"), 201, 1002);
  assert.match(r.bridge.orders()[0]?.error ?? "", /^stop: Order rejected/);
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);
  assert.equal(r.world.allPlaced().length, 3);
});

test("alert: an order TWS refused before any fill frees its alert once nothing of it is left working", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  ib.emit("error", new Error("Order rejected - reason: insufficient funds"), 201, 1000);
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  r.clock.now += LATER;

  // Refused, and being taken back, but TWS has not said it is gone: it could still fill.
  assert.equal(r.bridge.orders()[0]?.status, "PendingSubmit");
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);

  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);

  // The second order is a working one: now it has the alert.
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", /\(order 1003, ABCD, 10:01:00 New York\)$/);
  assert.equal(r.world.allPlaced().length, 6);
});

test('alert: "Inactive" from TWS after a refusal frees the alert as well', async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  r.world.current.emit("error", new Error("Order rejected - reason: no trading permission"), 201, 1000);
  r.world.current.emit("orderStatus", 1000, "Inactive", 0, 100, 0);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: a refused buy that TWS says it does not have is over, and its alert is free", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  const ib = r.world.current;
  // Refused at the door: TWS never made an order of it, so no status will ever come.
  ib.emit("error", new Error("The price does not conform to the minimum price variation for this contract."), 110, 1000);
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);

  // "Cannot be cancelled in this state" says the order exists: nothing changes.
  ib.emit("error", new Error("OrderId 1000 that needs to be cancelled cannot be cancelled, state: PendingSubmit."), 10148, 1000);
  // "Not found" about an exit says nothing about the buy either.
  ib.emit("error", new Error("OrderId 1002 that needs to be cancelled is not found."), 10147, 1002);
  assert.equal(r.bridge.orders()[0]?.status, "PendingSubmit");
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);

  // The answer to the bridge's own cancel: TWS has no such order.
  ib.emit("error", new Error("OrderId 1000 that needs to be cancelled is not found."), 10147, 1000);
  const [order] = r.bridge.orders();
  assert.equal(order?.status, "Inactive");
  assert.match(order?.error ?? "", /^buy: The price does not conform/);
  assert.match(order?.note ?? "", /is not found\. \(code 10147\)$/);
  assert.deepEqual(
    r.journal.ofType("order_status").map((line) => [line["order_id"], line["leg"], line["status"]]),
    [[1000, "parent", "Inactive"]],
  );
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
  assert.equal(ib.callsOf("cancelOrder").length, 1);
});

test("alert: an operator's cancel that TWS answers with 'not found' ends the order and frees the alert", async (t) => {
  const r = await rig(t);
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  r.bridge.cancel({ order_id: 1000 });
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN); // PendingCancel

  // TWS has no such order: it is over with nothing filled, and no status will ever say so.
  r.world.current.emit("error", new Error("Can't find order with id = 1000"), 135, 1000);
  assert.equal(r.bridge.orders()[0]?.status, "Inactive");
  assert.equal(r.bridge.orders()[0]?.error, null);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: an order that failed to send frees its alert; the ticker's window still holds", async (t) => {
  const r = await rig(t, { world: (w) => (w.failPlaceOrderAt = 2) });
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 502, "send_failed", /after 1 of 3 legs/);
  const [failed] = r.bridge.orders();
  // The leg that transmits never went out: nothing can fill, and the bridge says so itself.
  assert.equal(failed?.status, "Inactive");
  assert.match(failed?.error ?? "", /^sending failed after 1 of 3 legs/);
  assert.deepEqual(r.world.current.callsOf("cancelOrder").map((call) => call.args), [[1000]]);

  r.world.failPlaceOrderAt = 0;
  // Seconds later the alert is free, but the ticker was just tried.
  r.clock.now += 3000;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate", /ABCD was ordered 3s ago/);
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: a failure on the very first leg is taken back and freed the same way", async (t) => {
  const r = await rig(t, { world: (w) => (w.failPlaceOrderAt = 1) });
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 502, "send_failed", /after 0 of 3 legs/);
  assert.equal(r.bridge.orders()[0]?.status, "Inactive");
  // The cancel goes out even though no leg is known to have arrived.
  assert.deepEqual(r.world.current.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  r.world.failPlaceOrderAt = 0;
  r.clock.now += LATER;
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: a failure on the leg that transmits is not called over until TWS answers the cancel", async (t) => {
  const r = await rig(t, { world: (w) => (w.failPlaceOrderAt = 3) });
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 502, "send_failed", /after 2 of 3 legs/);
  const ib = r.world.current;
  // That leg may have reached TWS before the failure: the bracket could be live.
  assert.equal(r.bridge.orders()[0]?.status, "PendingSubmit");
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  r.world.failPlaceOrderAt = 0;
  r.clock.now += LATER;
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", TAKEN);

  ib.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: the rule is per New York date", async (t) => {
  // 23:50 on the 25th in New York.
  const r = await rig(t, { now: Date.parse("2026-11-26T04:50:00Z") });
  await r.bridge.order(buy({ alert_id: "ev-1" }));
  r.clock.now = Date.parse("2026-11-26T04:59:00Z"); // 23:59, the same New York day
  await refuses(r.bridge.order(buy({ alert_id: "ev-1" })), 409, "duplicate_alert", /\(order 1000, ABCD, 23:50:00 New York\)$/);
  r.clock.now = Date.parse("2026-11-26T05:01:00Z"); // 00:01 on the 26th: yesterday's orders are not looked at
  assert.equal((await r.bridge.order(buy({ alert_id: "ev-1" }))).order_id, 1003);
});

test("alert: the rule holds across a restart, with each order's outcome read back from the log", async (t) => {
  const dir = tempDir(t);
  const moreTickers = (w: FakeTws): void => {
    w.contracts.set("PART", [listing("PART", 666, "NASDAQ")]);
    w.contracts.set("PEND", [listing("PEND", 777, "NASDAQ")]);
  };
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), world: moreTickers });
  const ib = a.world.current;

  await a.bridge.order(buy({ alert_id: 987 })); // 1000: working

  await a.bridge.order(buy({ ticker: "WXYZ", alert_id: "ev-2" })); // 1003: TWS refuses it
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1003);
  ib.emit("orderStatus", 1003, "Inactive", 0, 100, 0);

  await a.bridge.order(buy({ ticker: "QQQQ", alert_id: "ev-3" })); // 1006: the operator cancels it, nothing filled
  a.bridge.cancel({ order_id: 1006 });
  ib.emit("orderStatus", 1006, "Cancelled", 0, 100, 0);

  a.world.failPlaceOrderAt = ib.callsOf("placeOrder").length + 2; // 1009: its second leg cannot be sent
  await refuses(a.bridge.order(buy({ ticker: "PENY", alert_id: "ev-4" })), 502, "send_failed");
  a.world.failPlaceOrderAt = 0;

  await a.bridge.order(buy({ ticker: "BRK.B", alert_id: "ev-5" })); // 1012: refused, TWS does not have it
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1012);
  ib.emit("error", new Error("OrderId 1012 that needs to be cancelled is not found."), 10147, 1012);

  await a.bridge.order(buy({ ticker: "PART", alert_id: "ev-6" })); // 1015: cancelled after 40 of 100 filled
  ib.emit("orderStatus", 1015, "Submitted", 40, 60, 2.52);
  a.bridge.cancel({ order_id: 1015 });
  ib.emit("orderStatus", 1015, "Cancelled", 40, 60, 2.52);

  await a.bridge.order(buy({ ticker: "PEND", alert_id: "ev-7" })); // 1018: cancel asked for, not confirmed
  a.bridge.cancel({ order_id: 1018 });

  const before = a.bridge.orders();
  assert.deepEqual(
    before.map((order) => [order.order_id, order.status, order.filled_qty, order.error !== null]),
    [
      [1018, "PendingCancel", 0, false],
      [1015, "Cancelled", 40, false],
      [1012, "Inactive", 0, true],
      [1009, "Inactive", 0, true],
      [1006, "Cancelled", 0, false],
      [1003, "Inactive", 0, true],
      [1000, "PendingSubmit", 0, false],
    ],
  );
  a.link.stop();

  // A minute later the bridge is started again.
  const b = await rig(t, { journal: new FileJournal(dir, () => T0 + LATER, [TOKEN]), now: T0 + LATER, world: moreTickers });
  assert.deepEqual(b.bridge.orders(), before);

  // Still working, cancelled with a partial fill, cancel not yet confirmed: their alerts are used up.
  await refuses(b.bridge.order(buy({ alert_id: "987" })), 409, "duplicate_alert", TAKEN);
  await refuses(b.bridge.preview(buy({ alert_id: 987 })), 409, "duplicate_alert", TAKEN);
  await refuses(
    b.bridge.order(buy({ ticker: "PART", alert_id: "ev-6" })),
    409,
    "duplicate_alert",
    /^this alert already has an order \(order 1015, PART, 10:00:00 New York\)$/,
  );
  await refuses(b.bridge.order(buy({ ticker: "PEND", alert_id: "ev-7" })), 409, "duplicate_alert", /order 1018, PEND/);
  assert.deepEqual(b.world.allPlaced(), []);

  // Ended with nothing filled (refused by TWS, cancelled by the operator, failed to send,
  // refused and unknown to TWS): free to order again.
  assert.equal((await b.bridge.order(buy({ ticker: "WXYZ", alert_id: "ev-2" }))).order_id, 1021);
  assert.equal((await b.bridge.order(buy({ ticker: "QQQQ", alert_id: "ev-3" }))).order_id, 1024);
  assert.equal((await b.bridge.order(buy({ ticker: "PENY", alert_id: "ev-4" }))).order_id, 1027);
  assert.equal((await b.bridge.order(buy({ ticker: "BRK.B", alert_id: "ev-5" }))).order_id, 1030);

  // And those new orders use the alerts up in turn.
  b.clock.now += LATER;
  await refuses(b.bridge.order(buy({ ticker: "WXYZ", alert_id: "ev-2" })), 409, "duplicate_alert", /order 1021, WXYZ, 10:01:00 New York/);
});
