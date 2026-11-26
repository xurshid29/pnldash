import assert from "node:assert/strict";
import { test } from "node:test";
import { FileJournal } from "../src/journal.js";
import type { FakeTws } from "./fake-tws.js";
import { sleep, until } from "./fake-tws.js";
import { refuses, rig, T0, TOKEN } from "./harness.js";
import { fill, filled, partlyFilled, tempDir, working } from "./scenes.js";

// The net under TWS's own bracket: an order that holds nothing any more must have no sell order
// of its own left working (it would sell shares that are not there, and open a short). When one
// is still working after a grace period, the bridge cancels it, once, by its id. `loose_exit` on
// the order says so from then until TWS confirms.
//
// The grace period is 30 ms in these tests (1 s in the bridge).

const GRACE = 30;
const BID = (w: FakeTws): void => void w.bids.set("ABCD", 2.4);

function cancels(world: FakeTws): number[] {
  return world.instances.flatMap((ib) => ib.callsOf("cancelOrder").map((call) => call.args[0] as number));
}

test("loose exit: the take-profit fills after /sell and the stop stays working: cancelled once, after the grace period", async (t) => {
  const r = await rig(t, { world: BID, exitGraceMs: GRACE });
  const ib = await filled(r);
  await r.bridge.sell({ order_id: 1000 });
  fill(ib, 1001, "s1", 100, 2.39, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.39);

  // Nothing at once: TWS has the grace period to cancel the stop itself.
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);
  assert.deepEqual(cancels(r.world), []);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);

  await until(() => cancels(r.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(r.world), [1002]);
  let order = r.bridge.orders()[0];
  assert.equal(order?.loose_exit, true); // asked, not confirmed yet
  assert.equal(order?.legs.stop?.status, "PendingCancel");
  const note = "order 1000 holds nothing any more (100 bought, all sold) and its stop order 1002 was still working 30 ms later: the bridge cancelled it";
  assert.equal(order?.note, note);
  assert.deepEqual(r.journal.ofType("exit_cleanup"), [
    {
      type: "exit_cleanup",
      order_id: 1000,
      ticker: "ABCD",
      leg: "stop",
      leg_order_id: 1002,
      why: "order 1000 holds nothing any more (100 bought, all sold) and its stop order 1002 was still working 30 ms later",
      note,
    },
  ]);
  assert.match(r.said.at(-1) ?? "", /^order 1000 ABCD: stop order 1002 left working on nothing: cancelled$/);

  // TWS confirms: the order is clean again.
  ib.emit("error", new Error("Order Canceled - reason:"), 202, 1002);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  order = r.bridge.orders()[0];
  assert.equal(order?.loose_exit, false);
  assert.equal(order?.legs.stop?.status, "Cancelled");

  // A cancel was all this sent: no order, no change (the one change is the sell's own).
  await sleep(GRACE * 3);
  assert.deepEqual(cancels(r.world), [1002]);
  assert.equal(r.world.allPlaced().length, 3);
  assert.deepEqual(r.world.allModified().map((sent) => sent.id), [1001]);
});

test("loose exit: TWS cancels the stop itself within the grace period: the bridge sends nothing", async (t) => {
  const r = await rig(t, { world: BID, exitGraceMs: GRACE });
  const ib = await filled(r);
  await r.bridge.sell({ order_id: 1000 });
  fill(ib, 1001, "s1", 100, 2.39, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.39);
  await sleep(GRACE / 3);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0); // the bracket's own cancel, as TWS does it

  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), []);
  assert.deepEqual(r.journal.ofType("exit_cleanup"), []);
  const order = r.bridge.orders()[0];
  assert.deepEqual([order?.loose_exit, order?.note, order?.legs.stop?.status], [false, null, "Cancelled"]);
});

test("loose exit: the stop fills and the take-profit stays working: the take-profit is cancelled", async (t) => {
  const r = await rig(t, { exitGraceMs: GRACE });
  const ib = await filled(r);
  fill(ib, 1002, "x1", 100, 2.38, 100);
  ib.emit("orderStatus", 1002, "Filled", 100, 0, 2.38);
  assert.deepEqual(cancels(r.world), []);

  await until(() => cancels(r.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(r.world), [1001]);
  const order = r.bridge.orders()[0];
  assert.equal(order?.loose_exit, true);
  assert.match(order?.note ?? "", /its take-profit order 1001 was still working 30 ms later: the bridge cancelled it$/);
  assert.deepEqual(r.journal.ofType("exit_cleanup").map((line) => [line["leg"], line["leg_order_id"]]), [["take_profit", 1001]]);

  // The same when the take-profit fills at its target and the stop stays.
  const s = await rig(t, { exitGraceMs: GRACE });
  const tws = await filled(s);
  fill(tws, 1001, "x1", 100, 2.78, 100);
  tws.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  await until(() => cancels(s.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(s.world), [1002]);
});

test("loose exit: a /sell order fills while a stop is alive after all: the stop is cancelled", async (t) => {
  const r = await rig(t, { world: BID, exitGraceMs: GRACE });
  const ib = await partlyFilled(r, 60);
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  await r.bridge.sell({ order_id: 1000 }); // the exits are gone by TWS's word: a sell order of its own, 1003
  assert.equal(r.bridge.orders()[0]?.exit?.order_id, 1003);
  // TWS reports the stop working after all (its "Cancelled" was not its last word).
  ib.emit("orderStatus", 1002, "Submitted", 0, 60, 0);
  fill(ib, 1003, "s1", 60, 2.37, 60);
  ib.emit("orderStatus", 1003, "Filled", 60, 0, 2.37);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);

  await until(() => cancels(r.world).length > 1, "the clean-up cancel");
  assert.deepEqual(cancels(r.world), [1000, 1002]); // the operator's cancel of the buy, then the clean-up
  assert.equal(r.bridge.orders()[0]?.loose_exit, true);
  assert.equal(r.world.allPlaced().length, 4);
});

test("loose exit: the /sell order itself is the one left working: it is cancelled", async (t) => {
  const r = await rig(t, { world: BID, exitGraceMs: GRACE });
  const ib = await partlyFilled(r, 60);
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  await r.bridge.sell({ order_id: 1000 });
  ib.emit("orderStatus", 1003, "Submitted", 0, 60, 0);
  // The stop was alive after all, and it sells the 60 before the sell order does.
  ib.emit("orderStatus", 1002, "Submitted", 0, 60, 0);
  fill(ib, 1002, "x1", 60, 2.36, 60);
  ib.emit("orderStatus", 1002, "Filled", 60, 0, 2.36);

  await until(() => cancels(r.world).length > 1, "the clean-up cancel");
  assert.deepEqual(cancels(r.world), [1000, 1003]);
  assert.match(r.bridge.orders()[0]?.note ?? "", /its sell order 1003 was still working/);
  assert.deepEqual(r.journal.ofType("exit_cleanup").map((line) => [line["leg"], line["leg_order_id"]]), [["exit", 1003]]);
  // Its cancel is confirmed: nothing is loose, and nothing is left to sell.
  ib.emit("orderStatus", 1003, "Cancelled", 0, 60, 0);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);
  await refuses(r.bridge.sell({ order_id: 1000 }), 409, "nothing_to_sell");
});

test("loose exit: both exits still working on a flat order are each cancelled, once", async (t) => {
  // The whole position went through a /sell order of its own while TWS says both exits work.
  const r = await rig(t, { world: BID, exitGraceMs: GRACE });
  const ib = await partlyFilled(r, 60);
  r.bridge.cancel({ order_id: 1000 });
  ib.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  await r.bridge.sell({ order_id: 1000 });
  fill(ib, 1003, "s1", 60, 2.37, 60);
  ib.emit("orderStatus", 1003, "Filled", 60, 0, 2.37);
  ib.emit("orderStatus", 1001, "Submitted", 0, 60, 0);
  ib.emit("orderStatus", 1002, "PreSubmitted", 0, 60, 0);

  await until(() => cancels(r.world).length >= 3, "both clean-up cancels");
  await sleep(GRACE * 3);
  assert.deepEqual(cancels(r.world), [1000, 1001, 1002]);
  assert.deepEqual(r.journal.ofType("exit_cleanup").map((line) => line["leg"]), ["take_profit", "stop"]);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 60, 0);
  assert.equal(r.bridge.orders()[0]?.loose_exit, true); // the stop is not confirmed yet
  ib.emit("orderStatus", 1002, "Cancelled", 0, 60, 0);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);
});

test("loose exit: the cancel is never repeated, whatever TWS keeps saying", async (t) => {
  const r = await rig(t, { exitGraceMs: GRACE });
  const ib = await filled(r);
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  await until(() => cancels(r.world).length > 0, "the clean-up cancel");

  // TWS goes on reporting the stop as working, and says the cancel cannot be done right now.
  ib.emit("orderStatus", 1002, "PreSubmitted", 0, 100, 0);
  ib.emit("error", new Error("OrderId 1002 that needs to be cancelled cannot be cancelled, state: PendingCancel."), 10148, 1002);
  ib.emit("orderStatus", 1002, "Submitted", 0, 100, 0);
  ib.reports(1002);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), [1002]);
  assert.equal(r.bridge.orders()[0]?.loose_exit, true); // still loose: the page keeps warning
  assert.equal(r.journal.ofType("exit_cleanup").length, 1);

  // Not after a reconnect either: one cancel per order, for as long as the bridge runs.
  r.world.drop();
  await until(() => r.link.isReady(), "ready again");
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), [1002]);
  assert.equal(r.bridge.orders()[0]?.loose_exit, true);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);
});

test("loose exit: 'no such order' from TWS ends it: the leg is marked finished", async (t) => {
  const r = await rig(t, { exitGraceMs: GRACE });
  const ib = await filled(r);
  r.world.onCancel = (tws, id) => queueMicrotask(() => tws.emit("error", new Error(`OrderId ${id} that needs to be cancelled is not found.`), 10147, id));
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  await until(() => cancels(r.world).length > 0, "the clean-up cancel");
  await sleep(5);
  const order = r.bridge.orders()[0];
  assert.deepEqual([order?.legs.stop?.status, order?.loose_exit], ["Inactive", false]);
  await sleep(GRACE * 3);
  assert.deepEqual(cancels(r.world), [1002]);

  // "Cannot be cancelled, state: Cancelled": it was over already, and TWS has said how.
  for (const [state, over] of [["Cancelled", true], ["Filled", true], ["PendingCancel", false], ["Submitted", false]] as const) {
    const s = await rig(t, { exitGraceMs: GRACE });
    const tws = await filled(s);
    s.world.onCancel = (api, id) =>
      queueMicrotask(() => api.emit("error", new Error(`OrderId ${id} that needs to be cancelled cannot be cancelled, state: ${state}.`), 10148, id));
    fill(tws, 1001, "x1", 100, 2.78, 100);
    tws.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
    await until(() => cancels(s.world).length > 0, "the clean-up cancel");
    await sleep(5);
    assert.deepEqual(
      [s.bridge.orders()[0]?.legs.stop?.status, s.bridge.orders()[0]?.loose_exit],
      over ? [state, false] : ["PendingCancel", true],
      state,
    );
    assert.deepEqual(cancels(s.world), [1002]);
  }
});

test("loose exit: an order that still holds shares is never touched", async (t) => {
  // Everything held, both exits working: the normal state of a filled order.
  const whole = await rig(t, { exitGraceMs: GRACE });
  await filled(whole);

  // Part sold by the stop, the rest held: both exits are still needed.
  const part = await rig(t, { exitGraceMs: GRACE });
  const a = await filled(part);
  fill(a, 1002, "x1", 40, 2.38, 40);
  a.emit("orderStatus", 1002, "Submitted", 40, 60, 2.38);

  // A /sell working on the shares that are held.
  const selling = await rig(t, { world: BID, exitGraceMs: GRACE });
  await filled(selling);
  await selling.bridge.sell({ order_id: 1000 });

  // A buy that never filled and was cancelled: nothing was ever held, and its exits are TWS's to end.
  const never = await rig(t, { exitGraceMs: GRACE });
  const b = await working(never);
  b.emit("orderStatus", 1000, "Cancelled", 0, 100, 0);

  await sleep(GRACE * 5);
  for (const r of [whole, part, selling, never]) {
    assert.deepEqual(cancels(r.world), []);
    assert.deepEqual(r.journal.ofType("exit_cleanup"), []);
    assert.equal(r.bridge.orders()[0]?.loose_exit, false);
  }
  assert.deepEqual([whole.bridge.orders()[0]?.held_qty, part.bridge.orders()[0]?.held_qty, selling.bridge.orders()[0]?.held_qty], [100, 60, 100]);
});

test("loose exit: while the buy can still fill, its exits are left alone even when nothing is held", async (t) => {
  // 60 of 100 bought, and the take-profit sold those 60 at its target; the buy is still working.
  const r = await rig(t, { exitGraceMs: GRACE });
  const ib = await partlyFilled(r, 60);
  fill(ib, 1001, "x1", 60, 2.78, 60);
  ib.emit("orderStatus", 1001, "Submitted", 60, 40, 2.78);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);
  await sleep(GRACE * 4);
  // The 40 still to come need their stop.
  assert.deepEqual(cancels(r.world), []);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);

  // The rest of the buy fills: shares are held again, and nothing is touched.
  fill(ib, 1000, "b2", 40, 2.53, 100);
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.524);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), []);
  assert.equal(r.bridge.orders()[0]?.held_qty, 40);

  // Had the buy been cancelled instead, the order would be over and flat: then its exits go.
  const s = await rig(t, { exitGraceMs: GRACE });
  const tws = await partlyFilled(s, 60);
  fill(tws, 1001, "x1", 60, 2.78, 60);
  tws.emit("orderStatus", 1001, "Filled", 60, 0, 2.78);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(s.world), []);
  s.bridge.cancel({ order_id: 1000 });
  tws.emit("orderStatus", 1000, "Cancelled", 60, 40, 2.52);
  await until(() => cancels(s.world).length > 1, "the clean-up cancel");
  assert.deepEqual(cancels(s.world), [1000, 1002]);
});

test("loose exit: a cancel a /sell already asked for is not asked a second time", async (t) => {
  // The take-profit was cancelled by hand, so /sell cancels the stop first; TWS does not confirm in time.
  const r = await rig(t, { world: BID, exitGraceMs: GRACE, cancelWaitMs: 20 });
  const ib = await filled(r);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 100, 0);
  await refuses(r.bridge.sell({ order_id: 1000 }), 504, "cancel_pending");
  assert.deepEqual(cancels(r.world), [1002]);
  // TWS: the take-profit is there after all, and it sells everything at its target.
  ib.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  assert.equal(r.bridge.orders()[0]?.held_qty, 0);

  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), [1002]); // still the one the sell sent
  assert.deepEqual(r.journal.ofType("exit_cleanup"), []);
  assert.equal(r.bridge.orders()[0]?.loose_exit, true); // and TWS has not confirmed it: the page warns
  ib.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);
});

test("loose exit: an order that has sold its whole quantity is over, also before TWS says 'Filled'", async (t) => {
  // A bracket with no take-profit: the stop sells everything, and TWS has reported the fills but no status.
  const r = await rig(t, { exitGraceMs: GRACE, config: (c) => (c.order.takeProfitPct = 0) });
  const ib = await filled(r);
  fill(ib, 1002, "x1", 60, 2.38, 60);
  fill(ib, 1002, "x2", 40, 2.37, 100);
  assert.deepEqual([r.bridge.orders()[0]?.held_qty, r.bridge.orders()[0]?.legs.stop?.status], [0, "PreSubmitted"]);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), []); // nothing is left for that stop to sell
  assert.equal(r.bridge.orders()[0]?.loose_exit, false);
});

test("loose exit: with TWS away at the end of the grace period nothing is sent; it is done when TWS is back", async (t) => {
  const r = await rig(t, { exitGraceMs: GRACE });
  const ib = await filled(r);
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  r.world.mode = "refuse";
  r.world.drop();
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(r.world), []);

  r.world.mode = "accept";
  await until(() => r.link.isReady(), "ready again");
  // The grace period runs again from the connection, then the one cancel goes out on it.
  await until(() => cancels(r.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(r.world), [1002]);
  assert.deepEqual(r.world.current.callsOf("cancelOrder").map((call) => call.args), [[1002]]);
  assert.deepEqual(r.world.current.placed(), []);
  assert.deepEqual(r.world.current.modified(), []);
});

// ---------------------------------------------------------------- restart

test("loose exit: restart with a flat order and a working stop: one cancel after the connection's grace period", async (t) => {
  const dir = tempDir(t, "loose");
  // The bridge of before: the take-profit sold everything, the stop was still working when it stopped.
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const ib = await filled(a);
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  assert.deepEqual([a.bridge.orders()[0]?.held_qty, a.bridge.orders()[0]?.legs.stop?.status], [0, "PreSubmitted"]);
  a.link.stop();

  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    now: T0 + 60_000,
    exitGraceMs: GRACE,
    world: (w) => {
      for (const id of [1000, 1001, 1002]) w.orderIds.add(id);
    },
  });
  assert.deepEqual([b.bridge.orders()[0]?.held_qty, b.bridge.orders()[0]?.legs.stop?.status, b.bridge.orders()[0]?.loose_exit], [0, "PreSubmitted", false]);
  // On connecting it asks TWS where its orders stand and sends nothing yet.
  assert.equal(b.world.current.callsOf("reqOpenOrders").length, 1);
  assert.deepEqual(cancels(b.world), []);
  // TWS's answer: the stop is open.
  b.world.current.emit("orderStatus", 1002, "PreSubmitted", 0, 100, 0);

  await until(() => cancels(b.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(b.world), [1002]);
  assert.equal(b.bridge.orders()[0]?.loose_exit, true);
  b.world.current.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  assert.equal(b.bridge.orders()[0]?.loose_exit, false);
  await sleep(GRACE * 3);
  assert.deepEqual(cancels(b.world), [1002]);
  assert.deepEqual(b.world.allPlaced(), []);
  assert.deepEqual(b.world.allModified(), []);
  const after = b.bridge.orders();
  b.link.stop();

  // Once more: the log now says the stop is cancelled and why, and nothing is sent.
  const c = await rig(t, { journal: new FileJournal(dir, () => T0 + 120_000, [TOKEN]), now: T0 + 120_000, exitGraceMs: GRACE });
  assert.deepEqual(c.bridge.orders(), after);
  assert.match(c.bridge.orders()[0]?.note ?? "", /its stop order 1002 was still working 30 ms later: the bridge cancelled it$/);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(c.world), []);
});

test("loose exit: restart: a stop TWS no longer has is marked finished by TWS's answer; a stop TWS ended meanwhile is not cancelled at all", async (t) => {
  const dir = tempDir(t, "loose-gone");
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const ib = await filled(a);
  fill(ib, 1001, "x1", 100, 2.78, 100);
  ib.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  a.link.stop();

  // TWS ended the stop while the bridge was down and no longer knows the id.
  const b = await rig(t, {
    journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]),
    now: T0 + 60_000,
    exitGraceMs: GRACE,
    world: (w) => {
      w.onCancel = (tws, id) => queueMicrotask(() => tws.emit("error", new Error(`OrderId ${id} that needs to be cancelled is not found.`), 10147, id));
    },
  });
  await until(() => cancels(b.world).length > 0, "the clean-up cancel");
  await sleep(5);
  assert.deepEqual(cancels(b.world), [1002]);
  assert.deepEqual([b.bridge.orders()[0]?.legs.stop?.status, b.bridge.orders()[0]?.loose_exit], ["Inactive", false]);
  b.link.stop();

  // Another day's log: TWS says, within the grace period after the connection, that the stop is cancelled.
  const dir2 = tempDir(t, "loose-told");
  const c = await rig(t, { journal: new FileJournal(dir2, () => T0, [TOKEN]) });
  const tws = await filled(c);
  fill(tws, 1001, "x1", 100, 2.78, 100);
  tws.emit("orderStatus", 1001, "Filled", 100, 0, 2.78);
  c.link.stop();
  const d = await rig(t, { journal: new FileJournal(dir2, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, exitGraceMs: GRACE });
  d.world.current.emit("orderStatus", 1002, "Cancelled", 0, 100, 0);
  await sleep(GRACE * 4);
  assert.deepEqual(cancels(d.world), []);
  assert.equal(d.bridge.orders()[0]?.loose_exit, false);
});

test("loose exit: restart: fills TWS reports on connecting count before anything is decided", async (t) => {
  const dir = tempDir(t, "loose-fills");
  // By the log the order holds nothing (the take-profit sold 100) and the stop works...
  const a = await rig(t, { journal: new FileJournal(dir, () => T0, [TOKEN]) });
  const ib = await partlyFilled(a, 60);
  fill(ib, 1001, "x1", 60, 2.78, 60);
  ib.emit("orderStatus", 1001, "Submitted", 60, 40, 2.78);
  a.link.stop();

  // ...but while the bridge was down the rest of the buy filled: TWS says so on connecting.
  const b = await rig(t, { journal: new FileJournal(dir, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, exitGraceMs: GRACE });
  assert.equal(b.bridge.orders()[0]?.held_qty, 0);
  fill(b.world.current, 1000, "b2", 40, 2.53, 100);
  b.world.current.emit("orderStatus", 1000, "Filled", 100, 0, 2.524);
  await sleep(GRACE * 4);
  assert.equal(b.bridge.orders()[0]?.held_qty, 40);
  assert.deepEqual(cancels(b.world), []); // 40 shares are held: their exits stay
  b.link.stop();

  // The other way round: by the log everything is held and both exits work; while the bridge was
  // down the take-profit sold it all, and the stop is still there. TWS's fills on connecting make
  // the order flat, and the stop goes after the grace period.
  const dir2 = tempDir(t, "loose-sold");
  const c = await rig(t, { journal: new FileJournal(dir2, () => T0, [TOKEN]) });
  await filled(c);
  c.link.stop();
  const d = await rig(t, { journal: new FileJournal(dir2, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, exitGraceMs: GRACE });
  assert.deepEqual([d.bridge.orders()[0]?.held_qty, d.bridge.orders()[0]?.loose_exit], [100, false]);
  fill(d.world.current, 1001, "x1", 100, 2.78, 100);
  await until(() => cancels(d.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(d.world), [1002]);
  assert.equal(d.bridge.orders()[0]?.held_qty, 0);
  d.link.stop();

  // And both at once: the buy was still working when the bridge stopped; it then filled in full
  // and the take-profit sold it all. TWS reports fills for finished orders, not their status: a
  // buy filled in full is over all the same, and the stop goes.
  const dir3 = tempDir(t, "loose-both");
  const e = await rig(t, { journal: new FileJournal(dir3, () => T0, [TOKEN]) });
  await partlyFilled(e, 60);
  e.link.stop();
  const f = await rig(t, { journal: new FileJournal(dir3, () => T0 + 60_000, [TOKEN]), now: T0 + 60_000, exitGraceMs: GRACE });
  fill(f.world.current, 1000, "b2", 40, 2.53, 100);
  fill(f.world.current, 1001, "x1", 100, 2.78, 100);
  assert.deepEqual([f.bridge.orders()[0]?.status, f.bridge.orders()[0]?.filled_qty, f.bridge.orders()[0]?.held_qty], ["Submitted", 100, 0]);
  await until(() => cancels(f.world).length > 0, "the clean-up cancel");
  assert.deepEqual(cancels(f.world), [1002]);
});
