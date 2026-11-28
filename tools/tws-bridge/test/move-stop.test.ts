import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderBook } from "../src/book.js";
import { FileJournal } from "../src/journal.js";
import { until } from "./fake-tws.js";
import type { FakeTws } from "./fake-tws.js";
import { buy, refuses, rig, TOKEN } from "./harness.js";
import type { Rig, RigOptions } from "./harness.js";
import {
  ABCD,
  answering,
  autoBuyNow,
  autoHolding,
  boughtAll,
  boughtPart,
  changes,
  confirmsCancels,
  fill,
  halfSold,
  soldAtTarget,
  taken,
  tempDir,
  W0,
} from "./scenes.js";

// `bridge.autoMoveStop(orderId, wanted)`: the exit watch's one tool for the stop of an order the
// automation placed. It moves the stop up (never down) for exactly what the order holds, or, when
// the bracket's stop is gone after the take-profit sold its part, places a stop of its own. It
// sells nothing.
//
// The order (the default rule): 150 ABCD bought at 2.64; take-profit 3.16 for 75 (1001); stop
// 2.36 / 2.28 for 150 (1002). A stop's limit is 3% under it, rounded down: 2.64 → 2.56.

/** A stop order as the bridge sends it: SELL STP LMT, good till cancelled. */
function stopOrder(qty: number, stop: number, limit: number, parentId = 1000): Record<string, unknown> {
  return { action: "SELL", orderType: "STP LMT", totalQuantity: qty, auxPrice: stop, lmtPrice: limit, tif: "GTC", outsideRth: true, parentId, transmit: true };
}

// ------------------------------------------------------------------- moving

test("autoMoveStop: the bracket's stop is changed, up to the price asked, for what the order holds, under the buy; the log line goes first", async (t) => {
  const box: { r?: Rig } = {};
  const linesAtSend: number[] = [];
  const r = await rig(t, {
    now: W0,
    world: (w) => {
      w.onOrder = (_ib, id, _order, change) => {
        if (change && id === 1002) linesAtSend.push(box.r?.journal.ofType("stop_moved").length ?? -1);
      };
    },
  });
  box.r = r;
  const record = await autoHolding(r);
  assert.equal(r.bridge.stopQtyOf(record), 150);

  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.64), { order_id: 1000, leg_order_id: 1002, stop: 2.64, stop_limit: 2.56, qty: 150, via: "moved" });
  assert.deepEqual(r.world.current.modified(), [{ id: 1002, contract: ABCD, order: stopOrder(150, 2.64, 2.56) }]);
  assert.deepEqual(linesAtSend, [1], "the stop_moved line was written before the change went out");
  assert.deepEqual(
    [record.sent.stop, record.sent.stop_limit, record.sent.first_stop, record.sent.stop_own, record.sent.order_ids.stop],
    [2.64, 2.56, 2.36, false, 1002],
  );
  assert.deepEqual(r.journal.ofType("stop_moved"), [
    {
      type: "stop_moved",
      order_id: 1000,
      ticker: "ABCD",
      leg_order_id: 1002,
      qty: 150,
      from: { stop: 2.36, stop_limit: 2.28, qty: 150 },
      prices: { stop: 2.64, stop_limit: 2.56 },
    },
  ]);
  // Nothing was sold, and nothing else was sent.
  assert.deepEqual([r.world.allPlaced().length, r.world.current.callsOf("cancelOrder").length], [3, 0]);
  assert.equal(record.held_qty, 150);

  // The take-profit sells its half. Asked for less, the stop stays where it is (never down), and is made to fit the 75.
  r.clock.now += 400;
  halfSold(r);
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.0), { order_id: 1000, leg_order_id: 1002, stop: 2.64, stop_limit: 2.56, qty: 75, via: "moved" });
  assert.deepEqual(changes(r.world.current).at(-1), [1002, 75, 2.56, 2.64]);
  assert.equal(r.bridge.stopQtyOf(record), 75);

  // Where it is, for the size it has: nothing to change, and nothing sent.
  r.clock.now += 400;
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 409, "no_change");
  await refuses(r.bridge.autoMoveStop(1000, 1.5), 409, "no_change");
  assert.equal(r.world.current.modified().length, 2);

  // Down to the tick: 2.7199 → 2.71, its limit 2.6287 → 2.62.
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.7199), { order_id: 1000, leg_order_id: 1002, stop: 2.71, stop_limit: 2.62, qty: 75, via: "moved" });
  assert.deepEqual(changes(r.world.current).at(-1), [1002, 75, 2.62, 2.71]);
});

test("autoMoveStop (4): the size is the least of what the book holds, what the account holds and what TWS last had the stop for; the position is read at every move", async (t) => {
  // The operator sold 100 by hand and cut the stop to 50.
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  const ib = r.world.current;
  r.world.positions.set(111, 50);
  ib.reports(1002, { totalQuantity: 50 });
  assert.equal((await r.bridge.autoMoveStop(1000, 2.64)).qty, 50);
  assert.deepEqual(changes(ib), [[1002, 50, 2.56, 2.64]]);
  assert.equal(ib.callsOf("reqPositions").length, 1);
  // A stop cut by hand stays cut, also with the account holding all 150.
  const c = await rig(t, { now: W0 });
  await autoHolding(c);
  c.world.current.reports(1002, { totalQuantity: 50 });
  assert.equal((await c.bridge.autoMoveStop(1000, 2.64)).qty, 50);

  // The take-profit sold 30 and TWS shrank the stop to 120; then 45 more sold, and TWS said nothing.
  const p = await rig(t, { now: W0 });
  await autoHolding(p);
  halfSold(p, 1000, 3.16, 30);
  p.world.current.reports(1002, { totalQuantity: 120 });
  assert.equal((await p.bridge.autoMoveStop(1000, 2.64)).qty, 120);
  p.clock.now += 400;
  halfSold(p, 1000, 3.16, 45);
  assert.equal((await p.bridge.autoMoveStop(1000, 2.64)).qty, 75);
  assert.deepEqual(changes(p.world.current), [
    [1002, 120, 2.56, 2.64],
    [1002, 75, 2.56, 2.64],
  ]);
  assert.equal(p.world.current.callsOf("reqPositions").length, 2);

  // The account holds none: no stop is put on shares it does not hold, and none is placed.
  const z = await rig(t, { now: W0 });
  await autoHolding(z);
  halfSold(z);
  z.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  z.world.positions.set(111, 0);
  await refuses(z.bridge.autoMoveStop(1000, 2.64), 409, "nothing_to_sell", /puts no stop on shares the account does not hold/);
  assert.deepEqual([z.world.allPlaced().length, z.world.allModified()], [3, []]);

  // TWS does not answer the positions request in time: nothing is sent.
  const q = await rig(t, { now: W0, world: (w) => (w.silentPositions = true) });
  await autoHolding(q);
  await refuses(q.bridge.autoMoveStop(1000, 2.64), 504, "no_position");
  assert.deepEqual(q.world.allModified(), []);
});

test("autoMoveStop (5): allowed while a sell through the take-profit order works, refused while a sell order for everything does", async (t) => {
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  assert.equal((await r.bridge.autoSell(1000, 3.0, "target")).via, "take_profit");
  r.clock.now += 400;
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.64), { order_id: 1000, leg_order_id: 1002, stop: 2.64, stop_limit: 2.56, qty: 150, via: "moved" });
  assert.deepEqual(changes(r.world.current), [
    [1001, 75, 2.94, undefined],
    [1002, 150, 2.56, 2.64],
  ]);
});

test("autoSell (3): with scope 'target' only the take-profit order is moved, for its own shares; when it has nothing left, nothing_to_sell", async (t) => {
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  await r.bridge.autoSell(1000, 3.0, "target");
  assert.deepEqual([changes(r.world.current), r.world.current.callsOf("cancelOrder"), r.world.allPlaced().length], [[[1001, 75, 2.94, undefined]], [], 3]);
  halfSold(r, 1000, 2.94);
  r.clock.now += 400;
  await refuses(r.bridge.autoSell(1000, 2.9, "target"), 409, "nothing_to_sell", /take-profit of order 1000 has nothing left to sell/);
  assert.equal(r.world.allModified().length, 1);
});

test("autoMoveStop (6): TWS answering a move of the stop with 'no such order' marks the stop gone; the next move places one of its own", async (t) => {
  const r = await rig(t, { now: W0, ackWaitMs: 300, world: answering((id, change) => change && id === 1002, 135, "Can't find order with id ={id}") });
  const record = await autoHolding(r);
  halfSold(r); // TWS took the stop with this fill, and has not said so
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 502, "tws_refused", /Can't find order/);
  assert.equal(record.legs.stop?.status, "Inactive");
  assert.deepEqual(r.journal.ofType("change_refused").map((line) => [line["leg"], line["leg_order_id"]]), [["stop", 1002]]);
  r.clock.now += 400;
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.64), { order_id: 1000, leg_order_id: 1003, stop: 2.64, stop_limit: 2.56, qty: 75, via: "placed" });
});

test("autoMoveStop: it is not held back by a halt or by orders switched off", async (t) => {
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  r.bridge.halt({ halted: true });
  r.config.enabled = false;
  assert.equal((await r.bridge.autoMoveStop(1000, 2.64)).stop, 2.64);
  assert.equal(r.world.current.modified().length, 1);
});

test("autoMoveStop: refused, with nothing sent: not its order, not connected, nothing held, the buy or a sell or the stop itself still at work, too soon", async (t) => {
  const nothingSent = (r: Rig): void => assert.deepEqual(r.world.allModified(), []);

  const r = await rig(t, { now: W0 });
  await refuses(r.bridge.autoMoveStop(4242, 2.64), 404, "unknown_order");
  const click = await r.bridge.order(buy());
  boughtAll(r, click.order_id, 2.52);
  await refuses(r.bridge.autoMoveStop(click.order_id, 2.6), 409, "not_auto");
  nothingSent(r);

  // Its buy still waits: nothing held. In part: the buy can still fill.
  const w = await rig(t, { now: W0 });
  const waiting = await w.bridge.autoOrder(autoBuyNow(w));
  taken(w, waiting.order_id);
  w.clock.now += 1000;
  await refuses(w.bridge.autoMoveStop(1000, 2.64), 409, "nothing_to_sell");
  boughtPart(w, 1000, 50);
  await refuses(w.bridge.autoMoveStop(1000, 2.64), 409, "busy", /can still fill/);
  nothingSent(w);

  // A sell order for everything is working (a click's Sell: the take-profit and the stop were cancelled first).
  const s = await rig(t, {
    now: W0,
    world: (x) => {
      x.bids.set("ABCD", 2.9);
      confirmsCancels(x);
    },
  });
  await autoHolding(s);
  assert.equal((await s.bridge.sell({ order_id: 1000 })).via, "new_order");
  s.clock.now += 400;
  await refuses(s.bridge.autoMoveStop(1000, 2.64), 409, "busy", /a sell of order 1000 is working/);
  assert.deepEqual(s.world.allModified(), []);
  assert.deepEqual(s.world.allPlaced().slice(3).map((p) => p.order.orderType), ["LMT"]); // the sell's own order, and no stop

  // The stop has begun to sell; the stop is being cancelled.
  const p = await rig(t, { now: W0 });
  await autoHolding(p);
  fill(p.world.current, 1002, "s1", 30, 2.35, 30);
  await refuses(p.bridge.autoMoveStop(1000, 2.64), 409, "busy", /begun to sell/);
  const c = await rig(t, { now: W0 });
  await autoHolding(c);
  c.world.current.emit("orderStatus", 1002, "PendingCancel", 0, 150, 0);
  await refuses(c.bridge.autoMoveStop(1000, 2.64), 409, "busy", /being cancelled/);
  for (const x of [p, c]) nothingSent(x);

  // Two changes to the stop under 300 ms apart.
  const q = await rig(t, { now: W0 });
  await autoHolding(q);
  await q.bridge.autoMoveStop(1000, 2.64);
  q.clock.now += 100;
  await refuses(q.bridge.autoMoveStop(1000, 2.7), 409, "too_soon");
  assert.equal(q.world.allModified().length, 1);

  // TWS away, or without IB's servers.
  const d = await rig(t, { now: W0 });
  await autoHolding(d);
  d.world.current.emit("info", "Connectivity between IB and Trader Workstation has been lost.", 1100);
  await refuses(d.bridge.autoMoveStop(1000, 2.64), 503, "tws_offline");
  d.world.current.emit("info", "Connectivity restored - data maintained.", 1102);
  d.world.mode = "refuse";
  d.world.drop();
  await until(() => !d.link.isReady(), "TWS gone");
  await refuses(d.bridge.autoMoveStop(1000, 2.64), 503, "tws_down");
  assert.deepEqual(d.world.allModified(), []);

  // All of it sold.
  const f = await rig(t, { now: W0 });
  await autoHolding(f);
  soldAtTarget(f, 1000); // the whole 150, for this test's sake
  await refuses(f.bridge.autoMoveStop(1000, 2.64), 409, "nothing_to_sell");
});

test("autoMoveStop: a log that cannot be written stops it: 500 log_failed, nothing sent, the book as it was", async (t) => {
  const r = await rig(t, { now: W0 });
  const record = await autoHolding(r);
  r.journal.failWrites = true;
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 500, "log_failed");
  assert.deepEqual(r.world.allModified(), []);
  assert.deepEqual([record.sent.stop, record.sent.stop_limit, r.bridge.stopQtyOf(record)], [2.36, 2.28, 150]);
});

test("autoMoveStop: TWS refusing the change is a 502; the book goes back to the price and the size TWS still has", async (t) => {
  let refusing = true;
  const r = await rig(t, { now: W0, ackWaitMs: 300, world: answering((id, change) => refusing && change && id === 1002) });
  const record = await autoHolding(r);
  halfSold(r);
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 502, "tws_refused", /^TWS refused the stop of order 1000: stop: Order rejected/);
  assert.deepEqual(changes(r.world.current), [[1002, 75, 2.56, 2.64]]); // it went out, and TWS said no
  assert.deepEqual([record.sent.stop, record.sent.stop_limit, r.bridge.stopQtyOf(record)], [2.36, 2.28, 150]);
  const [refused] = r.journal.ofType("change_refused");
  assert.deepEqual([refused?.["leg"], refused?.["leg_order_id"], refused?.["prices"]], ["stop", 1002, { stop: 2.36, stop_limit: 2.28 }]);
  // A later move is a whole new one, from where TWS has it.
  refusing = false;
  r.clock.now += 400;
  assert.deepEqual((await r.bridge.autoMoveStop(1000, 2.64)).qty, 75);
});

// ------------------------------------------------------------ a stop of its own

test("autoMoveStop: the stop gone while the take-profit has sold nothing is a stop cancelled by hand: stop_gone, left alone", async (t) => {
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 409, "stop_gone", /left alone/);
  assert.deepEqual([r.world.allPlaced().length, r.world.allModified()], [3, []]);
});

test("autoMoveStop: the stop gone after the take-profit sold: one stop of its own for what is held, and it is the bracket's stop from then on", async (t) => {
  const r = await rig(t, { now: W0, world: confirmsCancels });
  const record = await autoHolding(r);
  halfSold(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0); // TWS took it with the take-profit's fill
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.64), { order_id: 1000, leg_order_id: 1003, stop: 2.64, stop_limit: 2.56, qty: 75, via: "placed" });
  const ib = r.world.current;
  assert.deepEqual(ib.placed().slice(3), [{ id: 1003, contract: ABCD, order: stopOrder(75, 2.64, 2.56, 0) }]);
  assert.deepEqual(ib.modified(), []);
  assert.deepEqual(
    [record.sent.order_ids.stop, record.sent.stop_own, record.sent.stop, record.sent.stop_limit, record.legs.stop],
    [1003, true, 2.64, 2.56, { order_id: 1003, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null }],
  );
  const [line] = r.journal.ofType("stop_placed");
  assert.deepEqual(
    [line?.["order_id"], line?.["leg_order_id"], line?.["replaces"], line?.["qty"], line?.["prices"]],
    [1000, 1003, 1002, 75, { stop: 2.64, stop_limit: 2.56 }],
  );

  // TWS's word on the new order is the stop's.
  ib.emit("orderStatus", 1003, "PreSubmitted", 0, 75, 0);
  assert.equal(record.legs.stop?.status, "PreSubmitted");
  // A later move changes that order, with no parent.
  r.clock.now += 400;
  assert.equal((await r.bridge.autoMoveStop(1000, 2.8)).leg_order_id, 1003);
  assert.deepEqual(ib.modified(), [{ id: 1003, contract: ABCD, order: stopOrder(75, 2.8, 2.71, 0) }]);
  // A Sell cancels that order first, and then sells what is held.
  r.world.bids.set("ABCD", 2.9);
  r.clock.now += 400;
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 75, limit: 2.84, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [1003]);
  assert.deepEqual(ib.placed().slice(4).map((p) => [p.id, p.order.orderType, p.order.totalQuantity, p.order.lmtPrice]), [[1004, "LMT", 75, 2.84]]);
});

test("autoMoveStop: the fills of a stop of its own are the stop's: what the order holds goes down", async (t) => {
  const r = await rig(t, { now: W0 });
  const record = await autoHolding(r);
  halfSold(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  await r.bridge.autoMoveStop(1000, 2.64);
  fill(r.world.current, 1003, "s1", 30, 2.62, 30);
  assert.deepEqual([record.held_qty, record.legs.stop?.filled_qty], [45, 30]);
  fill(r.world.current, 1003, "s2", 45, 2.61, 75, 2.614);
  r.world.current.emit("orderStatus", 1003, "Filled", 75, 0, 2.614);
  assert.deepEqual([record.held_qty, record.legs.stop?.status], [0, "Filled"]);
  // Nothing held: nothing to move.
  await refuses(r.bridge.autoMoveStop(1000, 2.7), 409, "nothing_to_sell");
});

test("autoMoveStop: a stop of its own that TWS answers with an error is cancelled by its id, once; no second stop until TWS has answered that", async (t) => {
  const r = await rig(t, { now: W0, ackWaitMs: 300, world: answering((id, change) => !change && id === 1003) });
  const record = await autoHolding(r);
  halfSold(r);
  const ib = r.world.current;
  ib.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 502, "tws_refused");
  // Whether TWS keeps it is not known from an error: it is cancelled by its id, and counts as working until TWS says.
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [1003]);
  assert.deepEqual([record.legs.stop?.order_id, record.legs.stop?.status], [1003, "PendingCancel"]);
  assert.match(record.error ?? "", /^stop: Order rejected - reason: the stop price is not valid \(code 201\)$/);
  assert.deepEqual(r.journal.ofType("stop_cleanup").map((line) => line["leg_order_id"]), [1003]);
  r.clock.now += 400;
  await refuses(r.bridge.autoMoveStop(1000, 2.64), 409, "busy", /being cancelled/);
  assert.deepEqual(ib.placed().slice(3).map((p) => p.id), [1003]);
  // TWS confirms the cancel: the next move places another.
  ib.emit("orderStatus", 1003, "Cancelled", 0, 75, 0);
  assert.deepEqual(await r.bridge.autoMoveStop(1000, 2.64), { order_id: 1000, leg_order_id: 1004, stop: 2.64, stop_limit: 2.56, qty: 75, via: "placed" });

  // "No such order" as the answer to that cancel ends it too.
  const n = await rig(t, { now: W0, ackWaitMs: 300, world: answering((id, change) => !change && id === 1003) });
  await autoHolding(n);
  halfSold(n);
  n.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  await refuses(n.bridge.autoMoveStop(1000, 2.64), 502, "tws_refused");
  n.world.current.emit("error", new Error("Order with id 1003 cannot be found"), 10147, 1003);
  assert.equal(n.bridge.orders()[0]?.legs.stop?.status, "Inactive");
  n.clock.now += 400;
  assert.equal((await n.bridge.autoMoveStop(1000, 2.64)).leg_order_id, 1004);
});

// --------------------------------------------------------------- read back

async function restartable(t: Parameters<typeof rig>[0], options: RigOptions = {}): Promise<{ first: Rig; again: (world?: (w: FakeTws) => void) => Promise<Rig> }> {
  const dir = tempDir(t, "stop-restart");
  let current: Rig | undefined;
  const journalOf = (): FileJournal => new FileJournal(dir, () => current?.clock.now ?? W0, [TOKEN]);
  current = await rig(t, { now: W0, ...options, journal: journalOf() });
  const first = current;
  return {
    first,
    again: async (world) => {
      first.link.stop();
      current = await rig(t, {
        now: first.clock.now + 1000,
        ...options,
        journal: journalOf(),
        world: (w) => {
          // TWS still has the orders the first run sent.
          for (const id of [1000, 1001, 1002, 1003]) w.orderIds.add(id);
          world?.(w);
        },
      });
      return current;
    },
  };
}

test("restart: the book reads stop_placed and stop_moved back: the stop of its own, its price, what is held", async (t) => {
  const { first: a, again } = await restartable(t);
  await autoHolding(a);
  halfSold(a);
  a.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  await a.bridge.autoMoveStop(1000, 2.64);
  a.world.current.emit("orderStatus", 1003, "Submitted", 0, 75, 0);
  a.clock.now += 400;
  await a.bridge.autoMoveStop(1000, 2.8);

  const b = await again((w) => w.positions.set(111, 75));
  const [record] = b.bridge.orders();
  assert.deepEqual(
    [record?.sent.order_ids.stop, record?.sent.stop_own, record?.sent.stop, record?.sent.stop_limit, record?.legs.stop?.status, record?.held_qty, record?.sent.take_profit_qty],
    [1003, true, 2.8, 2.71, "Submitted", 75, 75],
  );
  // A move after the restart changes that order, with no parent, for what is held.
  b.clock.now += 400;
  await b.bridge.autoMoveStop(1000, 2.9);
  assert.deepEqual(b.world.current.modified(), [{ id: 1003, contract: ABCD, order: stopOrder(75, 2.9, 2.81, 0) }]);
});

test("restart: the bracket's stop moved before it comes back where it was moved to", async (t) => {
  const { first: a, again } = await restartable(t);
  await autoHolding(a);
  await a.bridge.autoMoveStop(1000, 2.64);
  const b = await again((w) => w.positions.set(111, 150));
  const [record] = b.bridge.orders();
  assert.deepEqual([record?.sent.stop, record?.sent.stop_limit, record?.sent.first_stop, record?.sent.stop_own, record?.sent.order_ids.stop], [2.64, 2.56, 2.36, false, 1002]);
});

// ------------------------------------------------ the take-profit's own size

test("the take-profit's own size goes with it when it is sent again: the watch's sell through it, and a Sell it carries, also after a restart", async (t) => {
  // The exit watch's sell of a passed-over take-profit: that order only, for its own 75.
  const r = await rig(t, { now: W0 });
  await autoHolding(r);
  assert.deepEqual(await r.bridge.autoSell(1000, 2.9, "target"), { order_id: 1000, qty: 75, limit: 2.84, status: "Submitted", via: "take_profit" });
  assert.deepEqual(changes(r.world.current), [[1001, 75, 2.84, undefined]]);
  assert.deepEqual([r.world.current.callsOf("cancelOrder"), r.world.allPlaced().length], [[], 3]);

  // With 75 held (the stop sold the other 75), a click's Sell goes through the take-profit, for its 75.
  const { first: a, again } = await restartable(t);
  await autoHolding(a);
  fill(a.world.current, 1002, "s1", 75, 2.35, 75);
  a.world.positions.set(111, 75);
  const b = await again((w) => {
    w.positions.set(111, 75);
    w.bids.set("ABCD", 2.9);
  });
  // After a restart the sizes TWS was sent are not in memory: the book's take_profit_qty is what goes.
  assert.deepEqual([b.bridge.orders()[0]?.sent.take_profit_qty, b.bridge.orders()[0]?.held_qty], [75, 75]);
  b.clock.now += 400;
  assert.equal((await b.bridge.sell({ order_id: 1000 })).via, "take_profit");
  assert.deepEqual(changes(b.world.current), [[1001, 75, 2.84, undefined]]);
});

// ------------------------------------------------------------ a Sell of all

test("a Sell of an automation order with its half take-profit sells everything: the take-profit cancelled, then the stop, then one sell order", async (t) => {
  const r = await rig(t, {
    now: W0,
    world: (w) => {
      w.bids.set("ABCD", 2.9);
      confirmsCancels(w);
    },
  });
  await autoHolding(r);
  const ib = r.world.current;
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 150, limit: 2.84, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(ib.callsOf("cancelOrder").map((call) => call.args[0]), [1001, 1002]);
  assert.deepEqual(ib.modified(), []);
  assert.deepEqual(ib.placed().slice(3).map((p) => [p.id, p.order.orderType, p.order.totalQuantity, p.order.lmtPrice, p.order.parentId]), [[1003, "LMT", 150, 2.84, 0]]);
  // In that order: the take-profit's cancel confirmed before the stop's was sent, the stop's before the sell.
  const names = ib.calls.filter((call) => call.name === "cancelOrder" || call.name === "placeOrder").map((call) => `${call.name} ${String(call.args[0])}`);
  assert.deepEqual(names.slice(3), ["cancelOrder 1001", "cancelOrder 1002", "placeOrder 1003"]);

  // The same through the watch's sell of everything (the stop due).
  const w = await rig(t, { now: W0, world: confirmsCancels });
  await autoHolding(w);
  assert.deepEqual(await w.bridge.autoSell(1000, 2.3, "all"), { order_id: 1000, qty: 150, limit: 2.25, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(w.world.current.callsOf("cancelOrder").map((call) => call.args[0]), [1001, 1002]);

  // A take-profit not confirmed cancelled in time: nothing is sold, and the next Sell goes on from there.
  const slow = await rig(t, { now: W0, world: (x) => x.bids.set("ABCD", 2.9) });
  await autoHolding(slow);
  await refuses(slow.bridge.sell({ order_id: 1000 }), 504, "cancel_pending", /take-profit/);
  assert.deepEqual([slow.world.current.callsOf("cancelOrder").map((call) => call.args[0]), slow.world.allPlaced().length], [[1001], 3]);
});

test("the book: a log line from before a take-profit could be a part reads back as for all of it; stop_placed puts the new stop in", () => {
  const sent = {
    qty: 150,
    limit: 2.66,
    trigger: 2.63,
    good_until: "2026-11-25T09:35:00.000Z",
    take_profit: 3.16,
    stop: 2.36,
    stop_limit: 2.28,
    price_from: "alert",
    stop_from: "pct",
    outside_rth: true,
    order_ids: { parent: 1000, take_profit: 1001, stop: 1002 },
  };
  const placed = { type: "order_placed", order_id: 1000, ticker: "ABCD", conid: 111, placed_at: "2026-11-25T09:30:00.000Z", source: "auto", asked: { alert_price: 2.5 }, entry: "stop", sent };
  const old = new OrderBook();
  old.restore([placed]);
  assert.deepEqual([old.get(1000)?.sent.take_profit_qty, old.get(1000)?.sent.stop_own], [150, false]);
  const none = new OrderBook();
  none.restore([{ ...placed, sent: { ...sent, take_profit: null, order_ids: { parent: 1000, take_profit: null, stop: 1002 } } }]);
  assert.equal(none.get(1000)?.sent.take_profit_qty, null);

  const book = new OrderBook();
  book.restore([
    { ...placed, sent: { ...sent, take_profit_qty: 75 } },
    { type: "order_status", order_id: 1000, leg_order_id: 1000, status: "Filled", filled: 150, avg_fill_price: 2.64 },
    { type: "order_status", order_id: 1000, leg_order_id: 1001, status: "Filled", filled: 75, avg_fill_price: 3.16 },
    { type: "order_status", order_id: 1000, leg_order_id: 1002, status: "Cancelled", filled: 0, avg_fill_price: 0 },
    { type: "stop_placed", order_id: 1000, ticker: "ABCD", leg_order_id: 1003, replaces: 1002, qty: 75, prices: { stop: 2.64, stop_limit: 2.56 } },
    { type: "order_status", order_id: 1000, leg_order_id: 1003, status: "Submitted", filled: 0, avg_fill_price: 0 },
    { type: "stop_moved", order_id: 1000, ticker: "ABCD", leg_order_id: 1003, qty: 75, prices: { stop: 2.72, stop_limit: 2.63 } },
    // A status of the old stop after it was replaced belongs to nothing any more.
    { type: "order_status", order_id: 1000, leg_order_id: 1002, status: "Filled", filled: 150, avg_fill_price: 2.3 },
  ]);
  const record = book.get(1000);
  assert.deepEqual(
    [record?.sent.take_profit_qty, record?.sent.order_ids.stop, record?.sent.stop_own, record?.sent.stop, record?.sent.stop_limit, record?.legs.stop?.status, record?.held_qty],
    [75, 1003, true, 2.72, 2.63, "Submitted", 75],
  );
});
