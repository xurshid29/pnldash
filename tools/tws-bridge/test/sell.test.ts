import assert from "node:assert/strict";
import { test } from "node:test";
import { FileJournal } from "../src/journal.js";
import type { FakeIb, FakeTws } from "./fake-tws.js";
import { until } from "./fake-tws.js";
import { buy, refuses, rig, T0, TOKEN } from "./harness.js";
import type { Rig } from "./harness.js";
import { ABCD, changes, fill, filled, partlyFilled, tempDir, working } from "./scenes.js";

// POST /sell { order_id }: a click gets out of what that order bought, at TWS's bid less
// sellOffsetPct (2%), rounded down. With a bid of 2.40 the sell limit is 2.35.
//
// It moves the bracket's take-profit leg while that is alive, places one plain sell order when
// the exits are gone, and moves a sell that is already working. It never sells more than the
// order still holds by the book, nor more than the account's position in TWS.

const BID = (w: FakeTws): void => void w.bids.set("ABCD", 2.4);

/** 60 shares held and no exits left: the buy was cancelled part-filled, and TWS took the exits with it. */
async function heldWithoutExits(r: Rig, shares = 60): Promise<FakeIb> {
  const ib = await partlyFilled(r, shares);
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", shares, 100 - shares, 2.52);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  return ib;
}

/** Every sell order and every change to a sell-side order, on any connection: `[id, quantity]`. */
function sellSideQuantities(world: FakeTws): Array<[number, number]> {
  return [...world.allPlaced(), ...world.allModified()]
    .filter((sent) => sent.order.action === "SELL")
    .map((sent) => [sent.id, sent.order.totalQuantity ?? Number.NaN]);
}

// ------------------------------------------------- through the take-profit

test("sell: with the bracket alive, the take-profit leg is moved to the bid − offset; no order is added", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  assert.equal(r.bridge.orders()[0]?.held_qty, 100);

  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 100, limit: 2.35, status: "Submitted", via: "take_profit" });

  // One message: the take-profit order itself, under its own id, parent kept, at the sell limit.
  assert.deepEqual(ib.modified(), [
    {
      id: 1001,
      contract: ABCD,
      order: { action: "SELL", orderType: "LMT", totalQuantity: 100, lmtPrice: 2.35, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true },
    },
  ]);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  // The bid came from one plain snapshot, and the account's position was read (and the stream stopped again).
  assert.deepEqual(ib.callsOf("reqMktData").map((call) => call.args.slice(1)), [[ABCD, "", true, false]]);
  assert.equal(ib.callsOf("reqPositions").length, 1);
  assert.equal(ib.callsOf("cancelPositions").length, 1);

  const sentAt = new Date(r.clock.now).toISOString();
  const exit = { via: "take_profit", order_id: 1001, qty: 100, limit: 2.35, first_limit: 2.35, bid: 2.4, reprices: 0, sent_at: sentAt };
  let order = r.bridge.orders()[0];
  assert.deepEqual(order?.exit, { ...exit, status: "Submitted", filled_qty: 0, avg_fill_price: null, exit_pct: null });
  assert.equal(order?.sent.take_profit, 2.35); // the leg's price now
  assert.equal(order?.sent.first_take_profit, 2.78); // the price it was placed with
  assert.equal(order?.held_qty, 100);

  // Logged with the bid it read.
  assert.deepEqual(r.journal.ofType("sell"), [
    {
      type: "sell",
      order_id: 1000,
      ticker: "ABCD",
      bid: 2.4,
      position: 100,
      held: 100,
      via: "take_profit",
      qty: 100,
      limit: 2.35,
      reprice: false,
      leg_order_id: 1001,
      prices: { take_profit: 2.35 },
      exit: { ...exit, status: "Submitted", filled_qty: 0, avg_fill_price: null, exit_pct: null },
    },
  ]);

  // It fills at the bid, and TWS cancels the stop with it.
  fill(ib, 1001, "s1", 100, 2.39, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.39);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  order = r.bridge.orders()[0];
  // 2.39 against the buy's 2.52: −5.16%
  assert.deepEqual(order?.exit, { ...exit, status: "Filled", filled_qty: 100, avg_fill_price: 2.39, exit_pct: -5.16 });
  assert.equal(order?.held_qty, 0);
  assert.equal(order?.legs.stop?.status, "Cancelled");

  // Nothing is left: another click is refused, and asks TWS nothing.
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /^nothing of order 1000 is still held: the 100 shares it bought have been sold$/);
  assert.equal(ib.callsOf("reqMktData").length, 1);
  assert.equal(ib.modified().length, 1);
});

test("sell: the limit is the bid less sellOffsetPct, rounded down to the tick, on both sides of $1", async (t) => {
  // The ask is not what a sell goes by.
  const r = await rig(t, {
    world: (w) => {
      w.asks.set("ABCD", 2.6);
      w.bids.set("ABCD", 2.47);
    },
  });
  await filled(r);
  assert.equal((await r.bridge.sell({ order_id: 1000 })).limit, 2.42); // 2.47 − 2% = 2.4206, down

  const other = await rig(t, { config: (c) => (c.order.sellOffsetPct = 0.5), world: (w) => w.bids.set("ABCD", 2.47) });
  await filled(other);
  assert.equal((await other.bridge.sell({ order_id: 1000 })).limit, 2.45); // 2.47 − 0.5% = 2.45765, down

  const penny = await rig(t, { world: (w) => w.bids.set("PENY", 0.4011) });
  const ib = await working(penny, { ticker: "PENY", alert_price: 0.42 });
  fill(ib, 1000, "b1", 100, 0.4242, 100);
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 0.4242);
  penny.world.positions.set(444, 100);
  assert.equal((await penny.bridge.sell({ order_id: 1000 })).limit, 0.393); // 0.4011 − 2% = 0.393078, down
});

test("sell: twice: the second click moves the same sell down, and only down", async (t) => {
  const r = await rig(t, { config: (c) => (c.order.maxChases = 2), world: BID });
  const ib = await filled(r);
  await r.bridge.sell({ order_id: 1000 }); // the take-profit at 2.35

  // Too soon after the first.
  r.clock.now += 100;
  r.world.bids.set("ABCD", 2.3);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "too_soon", /^order 1000 was changed 100 ms ago/);
  // The bid has gone up: the sell at 2.35 is marketable as it stands.
  r.clock.now += 300;
  r.world.bids.set("ABCD", 2.45);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "no_change", /^the sell limit 2\.35 is already at or below the bid 2\.45 − 2%$/);
  assert.equal(ib.modified().length, 1);

  // The bid has fallen away under it: the same order goes down to 2.30 − 2% = 2.25.
  r.world.bids.set("ABCD", 2.3);
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 100, limit: 2.25, status: "Submitted", via: "take_profit" });
  assert.deepEqual(changes(ib), [
    [1001, 100, 2.35, undefined],
    [1001, 100, 2.25, undefined],
  ]);
  assert.equal(r.world.allPlaced().length, 3); // still no order of its own
  const exit = r.bridge.orders()[0]?.exit;
  assert.deepEqual([exit?.limit, exit?.first_limit, exit?.bid, exit?.reprices, exit?.order_id], [2.25, 2.35, 2.3, 1, 1001]);
  assert.equal(r.bridge.orders()[0]?.sent.take_profit, 2.25);

  r.clock.now += 400;
  r.world.bids.set("ABCD", 2.2);
  assert.equal((await r.bridge.sell({ order_id: 1000 })).limit, 2.15);
  // order.maxChases bounds the moves of one sell as it bounds the chases of one buy.
  r.clock.now += 400;
  r.world.bids.set("ABCD", 2.1);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "chase_limit", /^the sell of order 1000 has been moved 2 times \(order\.maxChases is 2\)$/);
  assert.equal(ib.modified().length, 3);
  assert.equal(r.world.allPlaced().length, 3);
});

test("sell: a double click sends one sell", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  const results = await Promise.allSettled([r.bridge.sell({ order_id: 1000 }), r.bridge.sell({ order_id: 1000 }), r.bridge.sell({ order_id: 1000 })]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected"]);
  for (const result of results.slice(1)) assert.equal((result as PromiseRejectedResult).reason.code, "too_soon");
  assert.equal(ib.modified().length, 1);
  assert.equal(r.world.allPlaced().length, 3);

  // The same for the path that places an order: one order, never two.
  const s = await rig(t, { world: BID });
  const tws = await heldWithoutExits(s);
  const again = await Promise.allSettled([s.bridge.sell({ order_id: 1000 }), s.bridge.sell({ order_id: 1000 })]);
  assert.deepEqual(again.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.deepEqual(tws.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [[1003, 60]]);
  assert.deepEqual(tws.modified(), []);
});

// ------------------------------------------------- through an order of its own

test("sell: with the exits gone, one plain sell order for what is held, after the position is read", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await heldWithoutExits(r, 60);
  assert.equal(r.bridge.orders()[0]?.held_qty, 60);

  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 60, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.placed().slice(3), [
    {
      id: 1003,
      contract: ABCD,
      order: { action: "SELL", orderType: "LMT", totalQuantity: 60, lmtPrice: 2.35, tif: "DAY", outsideRth: true, parentId: 0, transmit: true },
    },
  ]);
  assert.deepEqual(ib.modified(), []);
  // The position was asked for, and answered, before the order went out.
  const names = ib.calls.map((call) => call.name);
  assert.ok(names.indexOf("reqPositions") < names.lastIndexOf("placeOrder"));
  assert.ok(names.indexOf("cancelPositions") < names.lastIndexOf("placeOrder"));

  const sentAt = new Date(r.clock.now).toISOString();
  const exit = { via: "new_order", order_id: 1003, qty: 60, limit: 2.35, first_limit: 2.35, bid: 2.4, reprices: 0, sent_at: sentAt };
  assert.deepEqual(r.bridge.orders()[0]?.exit, { ...exit, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null, exit_pct: null });

  // The sell order is followed like a leg of the bracket.
  ib.emit("orderStatus", 1003, "Submitted", 0, 60, 0);
  fill(ib, 1003, "s1", 20, 2.37, 20);
  assert.equal(r.bridge.orders()[0]?.held_qty, 40);
  assert.deepEqual(
    [r.bridge.orders()[0]?.exit?.status, r.bridge.orders()[0]?.exit?.filled_qty, r.bridge.orders()[0]?.exit?.avg_fill_price, r.bridge.orders()[0]?.exit?.exit_pct],
    ["Submitted", 20, 2.37, -5.95],
  );

  // A click while it works moves it; it does not add another.
  r.clock.now += 400;
  r.world.bids.set("ABCD", 2.3);
  r.world.positions.set(111, 40);
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 60, limit: 2.25, status: "Submitted", via: "new_order" });
  assert.deepEqual(changes(ib), [[1003, 60, 2.25, undefined]]); // the order's whole quantity: 20 filled, 40 to go
  assert.equal(ib.modified()[0]?.order.tif, "DAY");
  assert.equal(ib.placed().length, 4);

  fill(ib, 1003, "s2", 40, 2.26, 60, 2.2967);
  ib.emit("orderStatus", 1003, "Filled", 60, 0, 2.2967);
  const order = r.bridge.orders()[0];
  assert.equal(order?.held_qty, 0);
  assert.deepEqual([order?.exit?.status, order?.exit?.filled_qty, order?.exit?.avg_fill_price, order?.exit?.exit_pct], ["Filled", 60, 2.2967, -8.86]);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
  assert.deepEqual(r.journal.ofType("fill").map((line) => [line["leg"], line["leg_order_id"], line["shares"]]).slice(1), [
    ["exit", 1003, 20],
    ["exit", 1003, 40],
  ]);
});

test("sell: outsideRth of a new sell order is the config's", async (t) => {
  const r = await rig(t, { world: BID, config: (c) => (c.order.outsideRth = false) });
  const ib = await heldWithoutExits(r);
  await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual([ib.placed()[3]?.order.outsideRth, ib.placed()[3]?.order.tif], [false, "DAY"]);
});

test("sell: a sell order that ended without selling everything does not block the next one, and what it sold stays counted", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await heldWithoutExits(r, 60);
  await r.bridge.sell({ order_id: 1000 });
  ib.emit("orderStatus", 1003, "Submitted", 0, 60, 0);
  fill(ib, 1003, "s1", 20, 2.36, 20);
  ib.emit("orderStatus", 1003, "Cancelled", 20, 40, 2.36); // cancelled by hand in TWS, or the day ended
  assert.equal(r.bridge.orders()[0]?.held_qty, 40);

  r.clock.now += 1000;
  r.world.positions.set(111, 40);
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 40, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [
    [1003, 60],
    [1004, 40],
  ]);
  fill(ib, 1004, "s2", 40, 2.36, 40);
  ib.emit("orderStatus", 1004, "Filled", 40, 0, 2.36);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0); // 60 bought, 20 + 40 sold
  assert.equal(r.bridge.orders()[0]?.exit?.order_id, 1004);
});

// --------------------------------------------- a buy that is only part-filled

test("sell: a part-filled buy: the rest of the buy is cancelled first; TWS takes the exits with it → a sell order for what filled", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await partlyFilled(r, 60);
  r.world.onCancel = (tws) =>
    queueMicrotask(() => {
      tws.emit("error", new Error("Order Canceled - reason:"), 202, 1000);
      tws.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
      tws.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
      tws.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
    });

  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 60, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  assert.deepEqual(ib.modified(), []);
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.action, p.order.totalQuantity, p.order.lmtPrice]), [[1003, "SELL", 60, 2.35]]);
  // First the cancel, then (once TWS has confirmed it) the questions, then the order.
  const names = ib.calls.map((call) => call.name).filter((name) => ["cancelOrder", "reqPositions", "reqMktData"].includes(name) || name === "placeOrder");
  assert.deepEqual(names.slice(3), ["cancelOrder", "reqPositions", "reqMktData", "placeOrder"]);
  assert.deepEqual(r.journal.ofType("cancel"), [{ type: "cancel", order_id: 1000, ticker: "ABCD", for: "sell" }]);
  assert.equal(r.bridge.orders()[0]?.status, "Cancelled");
  assert.equal(r.bridge.orders()[0]?.error, null);
});

test("sell: a part-filled buy: TWS keeps the exits for the shares that filled → the take-profit is moved, for that quantity", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await partlyFilled(r, 60);
  r.world.onCancel = (tws) => queueMicrotask(() => tws.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52));

  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 60, limit: 2.35, status: "PreSubmitted", via: "take_profit" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  // 60, not the 100 the leg was placed with: never more than is held.
  assert.deepEqual(changes(ib), [[1001, 60, 2.35, undefined]]);
  assert.equal(ib.modified()[0]?.order.parentId, 1000);
  assert.equal(r.world.allPlaced().length, 3);

  fill(ib, 1001, "s1", 60, 2.4, 60);
  ib.emit("orderStatus", 1001, "Filled", 60, 0, 2.4);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);
});

test("sell: a part-filled buy: TWS says only afterwards that the exits went too → the change is refused, nothing is sold, the next click places the order", async (t) => {
  const r = await rig(t, { ackWaitMs: 500, world: BID });
  const ib = await partlyFilled(r, 60);
  r.world.onCancel = (tws) => queueMicrotask(() => tws.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52));
  // The take-profit was on its way out when the change reached TWS.
  r.world.onOrder = (tws, id, _order, change) => {
    if (!change || id !== 1001) return;
    queueMicrotask(() => {
      tws.emit("error", new Error("Order Canceled - reason:"), 202, 1001);
      tws.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
      tws.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
    });
  };

  await refuses(
    r.bridge.sell({ order_id: 1000 }),
    502,
    "tws_refused",
    /^TWS refused the sell of order 1000: take-profit: Order Canceled - reason: \(code 202\)\. \/orders shows what is still held; click Sell again$/,
  );
  let order = r.bridge.orders()[0];
  assert.equal(order?.exit, null); // no sell is working, and the book does not say one is
  assert.equal(order?.sent.take_profit, 2.78);
  assert.equal(order?.held_qty, 60);
  assert.match(order?.error ?? "", /^sell refused by TWS: take-profit: Order Canceled/);
  assert.equal(r.world.allPlaced().length, 3);

  r.clock.now += 1000;
  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual([result.via, result.qty, result.limit], ["new_order", 60, 2.35]);
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [[1003, 60]]);
  assert.equal(ib.modified().length, 1); // the one refused change; nothing was sent again for it
  order = r.bridge.orders()[0];
  assert.equal(order?.exit?.order_id, 1003);
});

test("sell: a part-filled buy whose cancel TWS does not confirm in time: nothing is sold, and the next click does not cancel twice", async (t) => {
  const r = await rig(t, { cancelWaitMs: 30, world: BID });
  const ib = await partlyFilled(r, 60);
  await refuses(
    r.bridge.sell({ order_id: 1000 }),
    504,
    "cancel_pending",
    /^nothing was sold yet: the unfilled part of buy 1000 is being cancelled, and TWS has not confirmed it within 30 ms\. Click Sell again$/,
  );
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000]]);
  assert.equal(r.bridge.orders()[0]?.status, "PendingCancel");
  assert.deepEqual(ib.modified(), []);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(ib.callsOf("reqMktData"), []); // not even a price was asked for

  await refuses(r.bridge.sell({ order_id: 1000 }), 504, "cancel_pending");
  assert.equal(ib.callsOf("cancelOrder").length, 1);

  // TWS confirms while the third click waits.
  const pending = r.bridge.sell({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.deepEqual([(await pending).via, (await pending).qty], ["new_order", 60]);
  assert.equal(ib.callsOf("cancelOrder").length, 1);
});

test("sell: a part-filled buy that fills completely while its cancel is on the way: the whole position goes, through the take-profit", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await partlyFilled(r, 60);
  r.world.onCancel = (tws) =>
    queueMicrotask(() => {
      fill(tws, 1000, "b2", 40, 2.53, 100, 2.524);
      tws.emit("orderStatus", 1000, "Filled", 100, 0, 2.524);
      tws.emit("error", new Error("OrderId 1000 that needs to be cancelled cannot be cancelled, state: Filled."), 10148, 1000);
      tws.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
      r.world.positions.set(111, 100);
    });
  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 100, limit: 2.35, status: "Submitted", via: "take_profit" });
  assert.deepEqual(changes(ib), [[1001, 100, 2.35, undefined]]);
  assert.equal(r.world.allPlaced().length, 3);
});

test("sell: an order that has bought nothing is not touched: no cancel, no question to TWS", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await working(r);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /^order 1000 has bought nothing: there is nothing to sell$/);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
  assert.deepEqual(ib.callsOf("reqMktData"), []);
  assert.deepEqual(ib.callsOf("reqPositions"), []);
  assert.equal(r.bridge.orders()[0]?.status, "Submitted");
});

// ------------------------------------------------- a bracket with no take-profit

test("sell: a stop with no take-profit beside it is cancelled, and confirmed cancelled, before the sell order goes in", async (t) => {
  const r = await rig(t, { world: BID, config: (c) => (c.order.takeProfitPct = 0) });
  const ib = await filled(r);
  r.world.onCancel = (tws, id) => queueMicrotask(() => tws.emit("orderStatus", id, "Cancelled", 0, 100, 0));

  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 100, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1002]]);
  assert.deepEqual(ib.placed().map((p) => [p.id, p.order.action, p.order.totalQuantity]), [
    [1000, "BUY", 100],
    [1002, "SELL", 100],
    [1003, "SELL", 100],
  ]);
  const names = ib.calls.map((call) => call.name);
  assert.ok(names.indexOf("cancelOrder") < names.indexOf("reqPositions"));
  assert.deepEqual(r.journal.ofType("cancel"), [{ type: "cancel", order_id: 1000, ticker: "ABCD", leg: "stop", leg_order_id: 1002, for: "sell" }]);
});

test("sell: the stop fills instead of cancelling: nothing is left, and no sell order is placed", async (t) => {
  const r = await rig(t, { world: BID, config: (c) => (c.order.takeProfitPct = 0) });
  const ib = await filled(r);
  r.world.onCancel = (tws) =>
    queueMicrotask(() => {
      fill(tws, 1002, "x1", 100, 2.38, 100);
      tws.emit("orderStatus", 1002, "Filled", 100, 0, 2.38);
    });
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /the 100 shares it bought have been sold/);
  assert.equal(ib.placed().length, 2);

  // And a cancel TWS does not confirm in time: the sell order waits for the next click.
  const s = await rig(t, { cancelWaitMs: 30, world: BID, config: (c) => (c.order.takeProfitPct = 0) });
  const tws = await filled(s);
  await refuses(s.bridge.sell({ order_id: 1000 }), 504, "cancel_pending", /the stop of order 1000 has to be cancelled before a sell order goes in/);
  assert.equal(tws.placed().length, 2);
  await refuses(s.bridge.sell({ order_id: 1000 }), 504, "cancel_pending");
  assert.deepEqual(tws.callsOf("cancelOrder").map((call) => call.args), [[1002]]); // asked once
});

// ---------------------------------------------------------- never a short

test("sell: never more than the account holds: the position in TWS caps it, on both paths", async (t) => {
  // The book says 100 are held; the account has 40 (the rest was sold by hand in TWS).
  const viaLeg = await rig(t, { world: BID });
  const a = await filled(viaLeg);
  viaLeg.world.positions.set(111, 40);
  assert.deepEqual(await viaLeg.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 40, limit: 2.35, status: "Submitted", via: "take_profit" });
  assert.deepEqual(changes(a), [[1001, 40, 2.35, undefined]]);

  const viaOrder = await rig(t, { world: BID });
  const b = await heldWithoutExits(viaOrder, 60);
  viaOrder.world.positions.set(111, 25);
  assert.equal((await viaOrder.bridge.sell({ order_id: 1000 })).qty, 25);
  assert.deepEqual(b.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [[1003, 25]]);

  // Part of a share is not a share.
  const fraction = await rig(t, { world: BID });
  const c = await heldWithoutExits(fraction, 60);
  fraction.world.positions.set(111, 59.7);
  assert.equal((await fraction.bridge.sell({ order_id: 1000 })).qty, 59);
  assert.equal(c.placed()[3]?.order.totalQuantity, 59);

  // More in the account than the order holds (another buy, a buy by hand): the order's own, no more.
  const more = await rig(t, { world: BID });
  const d = await heldWithoutExits(more, 60);
  more.world.positions.set(111, 500);
  assert.equal((await more.bridge.sell({ order_id: 1000 })).qty, 60);
  assert.equal(d.placed()[3]?.order.totalQuantity, 60);
});

test("sell: no position, or a short one, in the account: nothing is sent", async (t) => {
  for (const position of [undefined, 0, -20]) {
    for (const scene of [filled, heldWithoutExits] as const) {
      const r = await rig(t, { world: BID });
      const ib = await scene(r);
      if (position === undefined) r.world.positions.delete(111);
      else r.world.positions.set(111, position);
      await refuses(
        r.bridge.sell({ order_id: 1000 }),
        409,
        "nothing_to_sell",
        new RegExp(`^nothing was sold: by the bridge's book order 1000 still holds \\d+ ABCD, but the account's position in TWS is ${position ?? 0}\\. The bridge does not sell what the account does not hold$`),
      );
      assert.deepEqual(ib.modified(), []);
      assert.equal(ib.placed().length, 3);
      assert.equal(r.bridge.orders()[0]?.exit, null);
      assert.deepEqual(r.journal.ofType("sell"), []);
    }
  }
});

test("sell: a position that cannot be read in time, or cannot be read at all, means no sell", async (t) => {
  for (const scene of [filled, heldWithoutExits] as const) {
    const silent = await rig(t, { world: BID });
    const a = await scene(silent);
    silent.world.silentPositions = true;
    await refuses(
      silent.bridge.sell({ order_id: 1000 }),
      504,
      "no_position",
      /^nothing was sold: TWS did not report the account's position in ABCD within 40 ms$/,
    );
    assert.deepEqual(a.modified(), []);
    assert.equal(a.placed().length, 3);
    assert.equal(a.callsOf("cancelPositions").length, 1); // the stream is not left running

    // A line for this contract with no number in it: there is no position to go by.
    const garbled = await rig(t, { world: BID });
    const b = await scene(garbled);
    garbled.world.otherPositions = [{ account: "DU1234567", conId: 111, shares: undefined }];
    await refuses(garbled.bridge.sell({ order_id: 1000 }), 502, "no_position", /could not be read/);
    assert.deepEqual(b.modified(), []);
    assert.equal(b.placed().length, 3);
  }

  // The connection dropping while the position is read.
  const dropped = await rig(t, { world: BID });
  await filled(dropped);
  dropped.world.silentPositions = true;
  const pending = dropped.bridge.sell({ order_id: 1000 });
  await until(() => dropped.world.current.callsOf("reqPositions").length === 1, "the positions request");
  dropped.world.mode = "refuse";
  dropped.world.drop();
  await refuses(pending, 503, "tws_down");
  assert.deepEqual(dropped.world.allModified(), []);
});

test("sell: with several accounts in the login, the smallest position counts", async (t) => {
  // The second account has no line for the contract: it holds none.
  const r = await rig(t, { world: (w) => ((w.accounts = "DU1234567,DU7654321"), BID(w)) });
  const ib = await heldWithoutExits(r, 60);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /the account's position in TWS is 0/);
  assert.equal(ib.placed().length, 3);

  r.world.otherPositions = [{ account: "DU7654321", conId: 111, shares: 30 }];
  assert.equal((await r.bridge.sell({ order_id: 1000 })).qty, 30);
  // A position in another contract is not this one's.
  const other = await rig(t, { world: BID });
  await heldWithoutExits(other, 60);
  other.world.positions.delete(111);
  other.world.positions.set(222, 500);
  await refuses(other.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
});

test("sell: shares another order's unfinished sell has spoken for are not sold twice", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r); // order 1000: 100 held, its exits alive
  r.clock.now += 11_000; // past the ticker's duplicate window
  await r.bridge.order(buy()); // order 1003, the same ticker
  fill(ib, 1003, "c1", 100, 2.52, 100);
  ib.emit("orderStatus", 1003, "Filled", 100, 0, 2.52);
  ib.emit("orderStatus", 1004, "Submitted", 0, 100, 0);
  ib.emit("orderStatus", 1005, "PreSubmitted", 0, 100, 0);
  r.clock.now += 1000;
  // 200 by the book, but 100 of them were sold by hand in TWS: the account has 100.
  r.world.positions.set(111, 100);

  assert.equal((await r.bridge.sell({ order_id: 1000 })).qty, 100); // working, not filled yet: the position still shows 100
  await refuses(
    r.bridge.sell({ order_id: 1003 }),
    409,
    "nothing_to_sell",
    /the account's position in TWS is 100, and 100 of it is being sold for another order\. The bridge does not sell/,
  );
  assert.deepEqual(changes(ib), [[1001, 100, 2.35, undefined]]);

  // Once the first sell has filled, the account says so itself.
  fill(ib, 1001, "s1", 100, 2.39, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.39);
  r.world.positions.set(111, 0);
  await refuses(r.bridge.sell({ order_id: 1003 }), 409, "nothing_to_sell", /the account's position in TWS is 0\./);
  assert.equal(ib.modified().length, 1);
});

test("sell: a take-profit TWS has for less than is held is not moved: it is cancelled, then the stop, and one sell order goes for all", async (t) => {
  const confirming = (w: FakeTws): void => {
    BID(w);
    w.onCancel = (tws, id) => queueMicrotask(() => tws.emit("orderStatus", id, "Cancelled", 0, 100, 0));
  };
  const r = await rig(t, { world: confirming });
  const ib = await filled(r);
  ib.reports(1001, { totalQuantity: 80 }); // TWS has the take-profit at 80, with 100 held
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 100, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.modified(), []); // the take-profit is not changed at all, so never for more than TWS has it
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [1001, 1002]);
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.totalQuantity, p.order.lmtPrice]), [[1003, 100, 2.35]]);

  // One that is for at least what is held is moved, and a change never carries more than TWS says it has.
  const s = await rig(t, { world: BID });
  const tws = await filled(s);
  tws.reports(1001, { totalQuantity: 80 });
  fill(tws, 1002, "x1", 30, 2.38, 30); // the stop sold 30: 70 held
  s.world.positions.set(111, 70);
  assert.equal((await s.bridge.sell({ order_id: 1000 })).via, "take_profit");
  assert.deepEqual(changes(tws), [[1001, 70, 2.35, undefined]]);
});

// ------------------------------------------- when the stop got there first

test("sell: after the stop has sold the position there is nothing to sell, and nothing is asked or sent", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  fill(ib, 1002, "x1", 100, 2.38, 100);
  ib.emit("orderStatus", 1002, "Filled", 100, 0, 2.38);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  r.world.positions.set(111, 0);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);

  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell", /^nothing of order 1000 is still held: the 100 shares it bought have been sold$/);
  assert.deepEqual(ib.modified(), []);
  assert.equal(ib.placed().length, 3);
  assert.deepEqual(ib.callsOf("reqMktData"), []);
  assert.deepEqual(ib.callsOf("reqPositions"), []);

  // The same when the take-profit sold it at its target.
  const s = await rig(t, { world: BID });
  const tws = await filled(s);
  fill(tws, 1001, "x1", 100, 2.78, 100);
  await refuses(s.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
  assert.deepEqual(tws.modified(), []);
});

test("sell: a stop that sold part of the position: the rest is sold, and no more", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  // The stop triggered and its limit caught 40 shares before the price fell through it.
  fill(ib, 1002, "x1", 40, 2.38, 40);
  ib.emit("orderStatus", 1002, "Submitted", 40, 60, 2.38);
  r.world.positions.set(111, 60);
  assert.equal(r.bridge.orders()[0]?.held_qty, 60);

  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 60, limit: 2.35, status: "Submitted", via: "take_profit" });
  assert.deepEqual(changes(ib), [[1001, 60, 2.35, undefined]]);
});

test("sell: a fill arriving between the snapshot and the change is counted before anything is sent", async (t) => {
  // The stop sells everything while the bridge waits for the bid.
  const gone = await rig(t, { world: BID });
  const a = await filled(gone);
  gone.world.onMktData = (tws) => {
    fill(tws, 1002, "x1", 100, 2.38, 100);
    tws.emit("orderStatus", 1002, "Filled", 100, 0, 2.38);
  };
  await refuses(gone.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
  assert.deepEqual(a.modified(), []);
  assert.equal(a.placed().length, 3);

  // The stop sells 30 in that moment. TWS's position answer may not show it yet (here it still
  // says 100): the book does, and the sell is for 70.
  const part = await rig(t, { world: BID });
  const b = await filled(part);
  part.world.onMktData = (tws) => fill(tws, 1002, "x1", 30, 2.38, 30);
  assert.equal((await part.bridge.sell({ order_id: 1000 })).qty, 70);
  assert.deepEqual(changes(b), [[1001, 70, 2.35, undefined]]);

  // The take-profit is cancelled in TWS in that moment: there is no leg to move any more. The
  // stop is still there, so it is cancelled first and then the sell order goes in.
  const moved = await rig(t, { world: BID });
  const c = await filled(moved);
  let asked = 0;
  moved.world.onMktData = (tws) => {
    asked += 1;
    if (asked === 1) tws.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  };
  moved.world.onCancel = (tws, id) => queueMicrotask(() => tws.emit("orderStatus", id, "Cancelled", 0, 100, 0));
  assert.deepEqual(await moved.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 100, limit: 2.35, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(c.modified(), []);
  assert.deepEqual(c.callsOf("cancelOrder").map((call) => call.args), [[1002]]);
  assert.deepEqual(c.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [[1003, 100]]);
});

test("sell: an order that keeps changing under the click is given up on after a few looks, with nothing sold", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  // Every time the bridge asks for the bid, TWS says something else about the take-profit.
  let asked = 0;
  r.world.onMktData = (tws) => {
    asked += 1;
    tws.emit("orderStatus", 1001, asked % 2 === 1 ? "Cancelled" : "Submitted", 0, 100, 0);
  };
  r.world.onCancel = (tws, id) => queueMicrotask(() => tws.emit("orderStatus", id, "Cancelled", 0, 100, 0));
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "busy", /^order 1000 kept changing while it was being sold: nothing more was sent\./);
  assert.deepEqual(ib.modified(), []);
  assert.equal(ib.placed().length, 3);
  assert.equal(r.bridge.orders()[0]?.exit, null);
  assert.equal(r.bridge.orders()[0]?.held_qty, 100);
});

// ------------------------------------------------------------ the rails

test("sell: a halt and enabled: false do not block it (nor /cancel): getting out stays possible", async (t) => {
  const halted = await rig(t, { world: BID });
  const a = await filled(halted);
  halted.bridge.halt({ halted: true });
  assert.equal((await halted.bridge.sell({ order_id: 1000 })).via, "take_profit");
  assert.equal(a.modified().length, 1);
  await refuses(halted.bridge.order(buy({ ticker: "WXYZ" })), 409, "halted"); // buying is what the halt stops

  const disabled = await rig(t, { world: BID });
  const b = await heldWithoutExits(disabled);
  disabled.config.enabled = false;
  assert.equal((await disabled.bridge.sell({ order_id: 1000 })).via, "new_order");
  assert.equal(b.placed().length, 4);

  // A part-filled buy can be sold out of (its rest cancelled) with both switches against buying.
  const both = await rig(t, { world: BID });
  const c = await partlyFilled(both, 60);
  both.bridge.halt({ halted: true });
  both.config.enabled = false;
  both.world.onCancel = (tws) => queueMicrotask(() => tws.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52));
  assert.equal((await both.bridge.sell({ order_id: 1000 })).qty, 60);
  assert.deepEqual(c.callsOf("cancelOrder").map((call) => call.args), [[1000]]);

  const cancel = await rig(t);
  await working(cancel);
  cancel.bridge.halt({ halted: true });
  cancel.config.enabled = false;
  assert.equal(cancel.bridge.cancel({ order_id: 1000 }).status, "PendingCancel");
});

test("sell: a live account under paperOnly, TWS offline or gone refuse it; the daily count does not", async (t) => {
  const live = await rig(t, { world: BID });
  await filled(live);
  live.world.current.emit("managedAccounts", "U7654321");
  await refuses(live.bridge.sell({ order_id: 1000 }), 409, "paper_only");

  const offline = await rig(t, { world: BID });
  await filled(offline);
  offline.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  await refuses(offline.bridge.sell({ order_id: 1000 }), 503, "tws_offline");

  const down = await rig(t, { world: BID });
  await filled(down);
  down.world.mode = "refuse";
  down.world.drop();
  await refuses(down.bridge.sell({ order_id: 1000 }), 503, "tws_down");

  for (const r of [live, offline, down]) {
    assert.deepEqual(r.world.allModified(), []);
    assert.equal(r.world.allPlaced().length, 3);
  }

  // With paperOnly switched off by hand, a live account sells.
  const allowed = await rig(t, { world: (w) => ((w.accounts = "U7654321"), BID(w)), config: (c) => (c.paperOnly = false) });
  await filled(allowed);
  assert.equal((await allowed.bridge.sell({ order_id: 1000 })).via, "take_profit");

  // The day's last allowed order was this one: selling it, also through a new order, is not "an order too many".
  const counted = await rig(t, { world: BID, config: (c) => (c.limits.maxOrdersPerDay = 1) });
  const ib = await heldWithoutExits(counted);
  assert.equal((await counted.bridge.sell({ order_id: 1000 })).via, "new_order");
  assert.equal(ib.placed().length, 4);
  assert.deepEqual(counted.bridge.status().today, { orders: 1, filled: 1 }); // a sell is not a new order of the day
});

test("sell: the request is { order_id } of a buy placed today, and nothing else", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  for (const body of [{}, { order_id: "1000" }, { order_id: 1000.5 }, { order_id: -1 }, { order_id: null }, null]) {
    await refuses(r.bridge.sell(body), 400, "bad_request");
  }
  for (const extra of ["qty", "limit", "price", "all"]) {
    await refuses(r.bridge.sell({ order_id: 1000, [extra]: 1 }), 400, "bad_request", new RegExp(`unknown field "${extra}"`));
  }
  await refuses(r.bridge.sell({ order_id: 1001 }), 404, "unknown_order"); // an exit's id is not a handle
  await refuses(r.bridge.sell({ order_id: 7 }), 404, "unknown_order", /^order 7 is not a buy order this bridge placed today$/);
  r.clock.now += 24 * 60 * 60 * 1000;
  await refuses(r.bridge.sell({ order_id: 1000 }), 404, "unknown_order");
  assert.deepEqual(ib.modified(), []);
  assert.equal(ib.placed().length, 3);
});

test("sell: without a live bid there is no sell", async (t) => {
  const r = await rig(t);
  const ib = await filled(r);
  await refuses(r.bridge.sell({ order_id: 1000 }), 504, "no_bid", /^no bid for ABCD from TWS within 40 ms$/);

  const pending = r.bridge.sell({ order_id: 1000 });
  await until(() => ib.callsOf("reqMktData").length === 2, "the second snapshot");
  ib.emit("error", new Error("Requested market data is not subscribed"), 354, ib.callsOf("reqMktData")[1]?.args[0]);
  await refuses(pending, 502, "no_bid", /^TWS gave no bid for ABCD: Requested market data is not subscribed \(code 354\)$/);

  // A delayed bid (tick type 66) is not a price to sell at.
  const delayed = r.bridge.sell({ order_id: 1000 });
  await until(() => ib.callsOf("reqMktData").length === 3, "the third snapshot");
  ib.emit("tickPrice", ib.callsOf("reqMktData")[2]?.args[0], 66, 2.4);
  await refuses(delayed, 504, "no_bid");

  assert.deepEqual(ib.modified(), []);
  assert.equal(ib.placed().length, 3);
  assert.equal(r.bridge.orders()[0]?.exit, null);
  assert.equal(r.bridge.orders()[0]?.sent.take_profit, 2.78);
});

test("sell: a sell that cannot be written to the log is not sent", async (t) => {
  for (const scene of [filled, heldWithoutExits] as const) {
    const r = await rig(t, { world: BID });
    const ib = await scene(r);
    r.journal.failWrites = true;
    await refuses(r.bridge.sell({ order_id: 1000 }), 500, "log_failed", /^nothing was sold: the log cannot be written/);
    assert.deepEqual(ib.modified(), []);
    assert.equal(ib.placed().length, 3);
    assert.equal(r.bridge.orders()[0]?.exit, null);
    r.journal.failWrites = false;
    assert.equal((await r.bridge.sell({ order_id: 1000 })).limit, 2.35);
  }
});

// ----------------------------------------------------------- TWS says no

test("sell: TWS refuses the new sell order: its id is cancelled once, the book ends with TWS's word, and the next click places another", async (t) => {
  const r = await rig(t, { ackWaitMs: 500, world: BID });
  const ib = await heldWithoutExits(r, 60);
  r.world.onOrder = (tws, id, _order, change) => {
    if (!change && id === 1003) queueMicrotask(() => tws.emit("error", new Error("Order rejected - reason: no"), 201, 1003));
  };
  r.world.onCancel = (tws, id) => {
    if (id === 1003) queueMicrotask(() => tws.emit("error", new Error("OrderId 1003 that needs to be cancelled is not found."), 10147, 1003));
  };

  await refuses(r.bridge.sell({ order_id: 1000 }), 502, "tws_refused", /^TWS refused the sell of order 1000: sell: Order rejected - reason: no \(code 201\)\./);
  let order = r.bridge.orders()[0];
  assert.equal(order?.exit?.status, "Inactive"); // TWS has no such order: it cannot fill
  assert.equal(order?.held_qty, 60);
  assert.match(order?.error ?? "", /^sell: Order rejected - reason: no \(code 201\)$/);
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args), [[1000], [1003]]); // the operator's cancel of the buy, and this one
  assert.equal(r.journal.ofType("sell_cleanup").length, 1);

  // A second complaint about it is no reason to cancel again.
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1003);
  assert.equal(ib.callsOf("cancelOrder").length, 2);

  r.world.onOrder = null;
  r.clock.now += 1000;
  const result = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual([result.via, result.qty], ["new_order", 60]);
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.totalQuantity]), [
    [1003, 60],
    [1004, 60],
  ]);
  order = r.bridge.orders()[0];
  assert.equal(order?.exit?.order_id, 1004);
});

test("sell: TWS ends the take-profit order instead of taking the change: the answer says the sell did not go through", async (t) => {
  const r = await rig(t, { ackWaitMs: 500, world: BID });
  const ib = await filled(r);
  r.world.onOrder = (tws, id, _order, change) => {
    if (change && id === 1001) queueMicrotask(() => tws.emit("orderStatus", 1001, "Cancelled", 0, 100, 0));
  };
  await refuses(r.bridge.sell({ order_id: 1000 }), 502, "tws_refused", /^the sell of order 1000 did not go through: its order is Cancelled in TWS\. Click Sell again$/);
  assert.equal(r.bridge.orders()[0]?.held_qty, 100);
  assert.equal(ib.modified().length, 1);
});

test("sell: TWS refuses a later move of the sell: the sell stays at its earlier limit, on the book too", async (t) => {
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  await r.bridge.sell({ order_id: 1000 }); // 2.35
  ib.reports(1001);
  r.clock.now += 400;
  r.world.bids.set("ABCD", 2.3);
  await r.bridge.sell({ order_id: 1000 }); // 2.25
  ib.emit("error", new Error("Unable to modify this order as it is still being processed."), 2102, 1001);

  const order = r.bridge.orders()[0];
  assert.deepEqual([order?.exit?.limit, order?.exit?.reprices, order?.exit?.via], [2.35, 0, "take_profit"]);
  assert.equal(order?.sent.take_profit, 2.35);
  assert.match(order?.error ?? "", /^sell refused by TWS: take-profit: Unable to modify this order/);
  assert.deepEqual(ib.callsOf("cancelOrder"), []);
});

test("sell: a message that cannot be sent leaves everything as it was", async (t) => {
  // The change to the take-profit cannot be sent.
  const r = await rig(t, { world: BID });
  const ib = await filled(r);
  r.world.failModifyAt = 1;
  await refuses(r.bridge.sell({ order_id: 1000 }), 502, "send_failed", /^nothing was sold: the take-profit order 1001 of ABCD was not moved: encoder blew up$/);
  assert.equal(r.bridge.orders()[0]?.exit, null);
  assert.equal(r.bridge.orders()[0]?.sent.take_profit, 2.78);
  r.world.failModifyAt = 0;
  assert.equal((await r.bridge.sell({ order_id: 1000 })).limit, 2.35);
  assert.equal(ib.modified().length, 2); // the failed call and the one that went

  // The new sell order cannot be sent: it reads as not working, and the next click places another.
  const s = await rig(t, { world: BID });
  const tws = await heldWithoutExits(s);
  s.world.failPlaceOrderAt = 4;
  await refuses(s.bridge.sell({ order_id: 1000 }), 502, "send_failed", /^nothing was sold: the sell order 1003 for ABCD was not placed: encoder blew up$/);
  assert.equal(s.bridge.orders()[0]?.exit?.status, "Inactive");
  assert.equal(s.bridge.orders()[0]?.held_qty, 60);
  assert.match(s.bridge.orders()[0]?.error ?? "", /^the sell order 1003 for ABCD was not placed/);
  s.clock.now += 1000;
  assert.equal((await s.bridge.sell({ order_id: 1000 })).qty, 60);
  assert.deepEqual(tws.placed().slice(3).map((p) => p.id), [1003, 1004]);
});

// ---------------------------------------------------------------- restart

test("sell: restart in the middle of a sell through its own order: the book knows the sell, what it sold and what is held", async (t) => {
  const dir = tempDir(t, "sell");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), world: BID });
  const ib = await heldWithoutExits(a, 60);
  await a.bridge.sell({ order_id: 1000 });
  ib.emit("orderStatus", 1003, "Submitted", 0, 60, 0);
  fill(ib, 1003, "s1", 20, 2.37, 20);
  const before = a.bridge.orders();
  assert.deepEqual(
    [before[0]?.held_qty, before[0]?.exit?.status, before[0]?.exit?.filled_qty, before[0]?.exit?.avg_fill_price, before[0]?.exit?.exit_pct],
    [40, "Submitted", 20, 2.37, -5.95],
  );
  a.link.stop();

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    now: T0 + 60_000,
    world: (w) => {
      w.bids.set("ABCD", 2.3);
      w.positions.set(111, 40);
      w.nextValidId = 1000; // TWS offers an id the day has already used
      for (const id of [1000, 1001, 1002, 1003]) w.orderIds.add(id);
    },
  });
  assert.deepEqual(b.bridge.orders(), before);

  // A fill TWS reports again after the restart is not counted twice.
  fill(b.world.current, 1003, "s1", 20, 2.37, 20);
  assert.equal(b.bridge.orders()[0]?.held_qty, 40);

  // A click moves the sell that is working; it does not place a second one.
  const result = await b.bridge.sell({ order_id: 1000 });
  assert.deepEqual(result, { order_id: 1000, qty: 60, limit: 2.25, status: "Submitted", via: "new_order" });
  assert.deepEqual(changes(b.world.current), [[1003, 60, 2.25, undefined]]);
  assert.deepEqual(b.world.allPlaced(), []);

  fill(b.world.current, 1003, "s2", 40, 2.27, 60, 2.3033);
  b.world.current.emit("orderStatus", 1003, "Filled", 60, 0, 2.3033);
  assert.equal(b.bridge.orders()[0]?.held_qty, 0);
  await refuses(b.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
  // The sell order's id is not handed out again.
  b.clock.now += 60_000;
  assert.equal((await b.bridge.order(buy({ ticker: "WXYZ" }))).order_id, 1004);
});

test("sell: restart in the middle of a sell through the take-profit: the leg's price and the sell come back", async (t) => {
  const dir = tempDir(t, "sell-tp");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), world: BID });
  const ib = await filled(a);
  await a.bridge.sell({ order_id: 1000 });
  ib.reports(1001);
  const before = a.bridge.orders();
  a.link.stop();

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    now: T0 + 60_000,
    world: (w) => {
      w.bids.set("ABCD", 2.3);
      w.positions.set(111, 100);
      for (const id of [1000, 1001, 1002]) w.orderIds.add(id);
    },
  });
  assert.deepEqual(b.bridge.orders(), before);
  const restored = b.bridge.orders()[0];
  assert.deepEqual([restored?.exit?.via, restored?.exit?.limit, restored?.sent.take_profit, restored?.held_qty], ["take_profit", 2.35, 2.35, 100]);

  assert.equal((await b.bridge.sell({ order_id: 1000 })).limit, 2.25);
  assert.deepEqual(changes(b.world.current), [[1001, 100, 2.25, undefined]]);
  assert.deepEqual(b.world.allPlaced(), []);

  fill(b.world.current, 1001, "s1", 100, 2.31, 100);
  b.world.current.emit("orderStatus", 1001, "Filled", 100, 0, 2.31);
  b.link.stop();

  // And once more, after it has filled: nothing is held, by the log alone.
  const c = await rig(t, { journal: new FileJournal(dir, () => T0 + 120_000, [TOKEN]), now: T0 + 120_000, world: BID });
  assert.deepEqual([c.bridge.orders()[0]?.held_qty, c.bridge.orders()[0]?.exit?.status, c.bridge.orders()[0]?.exit?.exit_pct], [0, "Filled", -8.33]);
  await refuses(c.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
  assert.deepEqual(c.world.allPlaced(), []);
  assert.deepEqual(c.world.allModified(), []);
});

test("sell: restart after a sell that TWS refused or that could not be sent: the book does not claim it", async (t) => {
  const dir = tempDir(t, "sell-refused");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]), world: BID });
  const ib = await filled(a);
  await a.bridge.sell({ order_id: 1000 });
  ib.emit("error", new Error("Order rejected - reason: no"), 201, 1001);
  assert.equal(a.bridge.orders()[0]?.exit, null);
  const before = a.bridge.orders();
  a.link.stop();

  const b = await rig(t, { journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, world: BID });
  assert.deepEqual(b.bridge.orders(), before);
  assert.deepEqual([b.bridge.orders()[0]?.exit, b.bridge.orders()[0]?.sent.take_profit, b.bridge.orders()[0]?.held_qty], [null, 2.78, 100]);
  b.link.stop();

  const dir2 = tempDir(t, "sell-unsent");
  const c = await rig(t, { journal: new FileJournal(dir2, () => T0, [TOKEN]), world: BID });
  await filled(c);
  c.world.failModifyAt = 1;
  await refuses(c.bridge.sell({ order_id: 1000 }), 502, "send_failed");
  const unsent = c.bridge.orders();
  c.link.stop();
  const d = await rig(t, { journal: new FileJournal(dir2, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, world: BID });
  assert.deepEqual(d.bridge.orders(), unsent);
  assert.deepEqual([d.bridge.orders()[0]?.exit, d.bridge.orders()[0]?.sent.take_profit], [null, 2.78]);
});

// ------------------------------------------------------- the whole file

test("sell and chase: across every scene, no sell-side quantity is above the order's, and none above what was held", async (t) => {
  // A chase, a partial fill, a sell through the leg, a re-price, a second order on the ticker.
  const r = await rig(t, { world: (w) => (w.asks.set("ABCD", 2.54), w.bids.set("ABCD", 2.4)) });
  const ib = await working(r);
  await r.bridge.chase({ order_id: 1000 });
  fill(ib, 1000, "b1", 70, 2.56, 70);
  ib.emit("orderStatus", 1000, "Submitted", 70, 30, 2.56);
  r.world.positions.set(111, 70);
  r.world.onCancel = (tws) => queueMicrotask(() => tws.emit("orderStatus", 1000, "Cancelled", 70, 30, 2.56));
  r.clock.now += 1000;
  await r.bridge.sell({ order_id: 1000 });
  r.clock.now += 1000;
  r.world.bids.set("ABCD", 2.3);
  await r.bridge.sell({ order_id: 1000 });

  const sells = sellSideQuantities(r.world);
  // The bracket's exits were placed and chased at 100 (the order's quantity); every sell after the fill is for the 70 held.
  assert.deepEqual(sells, [
    [1001, 100],
    [1002, 100],
    [1001, 100],
    [1002, 100],
    [1001, 70],
    [1001, 70],
  ]);
  for (const [, qty] of sells) assert.ok(qty <= 100);
  // The buy's quantity never grew either.
  assert.deepEqual(
    [...r.world.allPlaced(), ...r.world.allModified()].filter((s) => s.order.action === "BUY").map((s) => s.order.totalQuantity),
    [100, 100],
  );
});
