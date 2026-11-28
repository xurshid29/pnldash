import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { FileJournal } from "../src/journal.js";
import type { JournalFields } from "../src/journal.js";
import { ExitWatch } from "../src/watch.js";
import { sleep, until } from "./fake-tws.js";
import type { FakeTws } from "./fake-tws.js";
import { rig, TOKEN } from "./harness.js";
import type { Rig, RigOptions } from "./harness.js";
import {
  answering,
  autoBuyNow,
  autoHolding,
  both,
  boughtAll,
  boughtPart,
  changes,
  confirmsCancels,
  fill,
  halfSold,
  taken,
  tempDir,
  W0,
} from "./scenes.js";

// The operator's exit (2026-11-28), as the exit watch carries it out (src/watch.ts, "tending the
// stop"): the stop goes to the entry once the bid has been 10% above what the shares cost; the
// take-profit (+20%) sells half; after it has sold, the stop of the other half stands at the cost
// at least and trails 20% under the highest bid, never down. Nothing of that sells by itself: it
// moves the stop (`bridge.autoMoveStop`), and TWS's stop does the selling. When the stop is due,
// everything held is sold at the bid.
//
// The trade: 150 ABCD bought at 2.64 (the cost); take-profit 3.16 for 75 (1001); stop 2.36 / 2.28
// for 150 (1002). +10% of the cost is 2.904. A stop's own limit is 3% under it, rounded down; a
// sell's limit is the bid less 2%, rounded down.
//
// The clock is the movable one; the watch's timers run in real time, a few milliseconds here.

const TP_GRACE = 30;
const STOP_GRACE = 20;
const RESELL = 40;
/** What TWS is given, on the watch's clock, to say what became of the stop after the take-profit's fill. */
const HALF = 700;
const SETTLE = 70;

interface RuleRig extends Rig {
  watch: ExitWatch;
}

/** A rig with the exit watch over it, under the default rule (and short waits). */
async function ruled(t: TestContext, options: RigOptions = {}): Promise<RuleRig> {
  const r = await rig(t, {
    now: W0,
    ...options,
    config: (c) => {
      c.auto.tpGraceMs = TP_GRACE;
      c.auto.stopGraceMs = STOP_GRACE;
      c.auto.resellMs = RESELL;
      options.config?.(c);
    },
  });
  const watch = new ExitWatch({ auto: r.config.auto, bridge: r.bridge, link: r.link, journal: r.journal, clock: () => r.clock.now, idleLookMs: 5 });
  t.after(() => watch.close());
  return { ...r, watch };
}

function quote(r: Rig, field: "bid" | "ask" | "last", price: number): void {
  if (field === "bid") r.world.bids.set("ABCD", price);
  r.world.tick(111, field, price);
}

function settle(): Promise<void> {
  return sleep(SETTLE);
}

/** The stop moves the watch made, as `[why, stop, qty, via]`. */
function moves(r: Rig): unknown[][] {
  return r.journal.ofType("auto_stop").map((line) => [line["why"], line["stop"], line["qty"], line["via"]]);
}

function watchLines(r: Rig): unknown[] {
  return r.journal.ofType("auto_watch").map((line) => line["what"]);
}

function pick(line: JournalFields | undefined, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, line?.[key]]));
}

/** The new orders sent after the bracket, as `[id, type, qty, limit, stop, parent]`. */
function newOrders(r: Rig): unknown[][] {
  return r.world
    .allPlaced()
    .slice(3)
    .map((p) => [p.id, p.order.orderType, p.order.totalQuantity, p.order.lmtPrice, p.order.auxPrice, p.order.parentId]);
}

function cancels(r: Rig): unknown[] {
  return r.world.instances.flatMap((ib) => ib.callsOf("cancelOrder").map((call) => call.args[0]));
}

/** TWS goes away and comes back; on the new connection it has said nothing yet. */
async function reconnect(r: Rig): Promise<void> {
  r.world.mode = "refuse";
  r.world.drop();
  await until(() => !r.link.isReady(), "TWS gone");
  r.world.mode = "accept";
  await until(() => r.link.isReady() && r.world.streams().length === 1, "TWS back, and the stream asked for again");
}

// ------------------------------------------------------------- a whole trade

test("rule: the life of one trade: to the entry at +10%, half sold at +20%, the stop fitted, trailing up, and the stop sells the rest", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  const ib = r.world.current;
  quote(r, "bid", 2.78);
  quote(r, "last", 2.8); // +6%: nothing yet
  quote(r, "bid", 2.88);
  quote(r, "last", 2.95); // a trade up there, the bid not: still nothing
  await settle();
  assert.deepEqual(moves(r), []);

  // The bid at +10%: the stop goes to the entry, for all 150.
  quote(r, "bid", 2.91);
  await until(() => moves(r).length === 1, "the stop to the entry");
  assert.deepEqual(pick(r.journal.ofType("auto_stop")[0], ["why", "stop", "stop_limit", "qty", "via", "leg_order_id", "cost", "hi", "hi_bid"]), {
    why: "to_entry",
    stop: 2.64,
    stop_limit: 2.56,
    qty: 150,
    via: "moved",
    leg_order_id: 1002,
    cost: 2.64,
    hi: 2.95,
    hi_bid: 2.91,
  });

  // +20%: the take-profit sells its 75. TWS leaves the stop at 150.
  r.clock.now += 400;
  quote(r, "bid", 3.14);
  quote(r, "last", 3.16);
  halfSold(r);
  await until(() => watchLines(r).includes("target_sold"), "the half sold");
  await settle();
  assert.equal(moves(r).length, 1, "TWS is given its 700 ms first");
  r.clock.now += HALF;
  await until(() => moves(r).length === 2, "the stop made to fit the 75");

  // The price runs on: the stop follows 20% under the highest bid, by steps of 1% or more.
  r.clock.now += 400;
  quote(r, "bid", 3.4);
  quote(r, "last", 3.41);
  await until(() => moves(r).length === 3, "the first step");
  r.clock.now += 400;
  quote(r, "bid", 3.42); // 2.736: under a 1% step from 2.72
  quote(r, "last", 5.0); // one stray print far above the market lifts nothing
  await settle();
  assert.equal(moves(r).length, 3);
  assert.deepEqual(r.journal.ofType("auto_sell"), []);
  r.clock.now += 400;
  quote(r, "bid", 3.5);
  await until(() => moves(r).length === 4, "the second step");
  r.clock.now += 400;
  quote(r, "bid", 3.75);
  await until(() => moves(r).length === 5, "the third step");

  // It falls back: the stop is never lowered.
  r.clock.now += 400;
  quote(r, "bid", 3.2);
  quote(r, "last", 3.21);
  await settle();
  assert.equal(moves(r).length, 5);

  // The stop is traded at, and TWS's stop sells the rest.
  quote(r, "bid", 2.98);
  quote(r, "last", 2.99);
  fill(ib, 1002, "stop", 75, 2.97, 75);
  ib.emit("orderStatus", 1002, "Filled", 75, 0, 2.97);
  r.world.positions.set(111, 0);
  await settle();

  assert.deepEqual(moves(r), [
    ["to_entry", 2.64, 150, "moved"],
    ["fit", 2.64, 75, "moved"],
    ["trail", 2.72, 75, "moved"],
    ["trail", 2.8, 75, "moved"],
    ["trail", 3, 75, "moved"],
  ]);
  assert.deepEqual(changes(ib), [
    [1002, 150, 2.56, 2.64],
    [1002, 75, 2.56, 2.64],
    [1002, 75, 2.63, 2.72],
    [1002, 75, 2.71, 2.8],
    [1002, 75, 2.91, 3],
  ]);
  for (const sent of ib.modified()) assert.deepEqual([sent.order.orderType, sent.order.tif, sent.order.parentId], ["STP LMT", "GTC", 1000]);
  assert.deepEqual([r.world.allPlaced().length, r.journal.ofType("auto_sell").length, r.watch.watching()], [3, 0, []]);
  const record = r.bridge.orders()[0];
  assert.deepEqual([record?.held_qty, record?.legs.take_profit?.avg_fill_price, record?.legs.stop?.avg_fill_price], [0, 3.16, 2.97]);
});

// --------------------------------------------------------------- a. to the entry

test("rule a: to the entry once the bid has been +10% over the cost, once; trades up there, stray or not, do not do it", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  quote(r, "bid", 2.8);
  quote(r, "last", 2.95);
  quote(r, "last", 5.0); // a stray print
  quote(r, "ask", 2.96);
  quote(r, "bid", 2.9); // +9.85%
  await settle();
  assert.deepEqual([moves(r), r.world.allModified()], [[], []]);
  quote(r, "bid", 2.91);
  await until(() => moves(r).length === 1, "the move");
  assert.deepEqual(changes(r.world.current), [[1002, 150, 2.56, 2.64]]);
  // A higher bid moves it no more while the take-profit has sold nothing: there is no trailing yet.
  r.clock.now += 400;
  quote(r, "bid", 3.1);
  await settle();
  r.clock.now += 400;
  await settle();
  assert.equal(moves(r).length, 1);
});

test("rule a and c: before the take-profit has sold there is no trailing, even a tight one; after it, there is", async (t) => {
  const r = await ruled(t, { config: (c) => (c.auto.trailPct = 5) });
  await autoHolding(r);
  quote(r, "bid", 3.1); // 5% under it is 2.945: above the entry, and not used yet
  await until(() => moves(r).length === 1, "the move to the entry");
  r.clock.now += 400;
  await settle();
  assert.deepEqual(moves(r), [["to_entry", 2.64, 150, "moved"]]);
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 2, "the trail");
  assert.deepEqual(moves(r)[1], ["trail", 2.94, 75, "moved"]);
});

// ----------------------------------------------------------- b. made to fit

test("rule b: after the take-profit's fill TWS gets 700 ms, then the stop is made to fit, at the cost at least: TWS shrank it, left it, or took it", async (t) => {
  for (const how of ["shrank", "left", "took"] as const) {
    const r = await ruled(t);
    await autoHolding(r);
    quote(r, "bid", 2.8); // under +10%: the stop is still at 2.36
    halfSold(r);
    const ib = r.world.current;
    if (how === "shrank") ib.reports(1002, { totalQuantity: 75 });
    if (how === "took") ib.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
    const since = r.clock.now;
    await settle();
    r.clock.now = since + HALF - 1;
    await settle();
    assert.deepEqual([moves(r), r.world.allModified(), newOrders(r)], [[], [], []], how);
    r.clock.now = since + HALF;
    await until(() => moves(r).length === 1, `${how}: the fit`);
    if (how === "took") {
      assert.deepEqual(newOrders(r), [[1003, "STP LMT", 75, 2.56, 2.64, 0]]);
      assert.deepEqual(r.world.allModified(), []);
      assert.deepEqual(pick(r.journal.ofType("auto_stop")[0], ["stop", "qty", "via", "leg_order_id"]), { stop: 2.64, qty: 75, via: "placed", leg_order_id: 1003 });
      assert.deepEqual([r.bridge.orders()[0]?.sent.order_ids.stop, r.bridge.orders()[0]?.sent.stop_own], [1003, true]);
    } else {
      assert.deepEqual(changes(ib), [[1002, 75, 2.56, 2.64]], how);
      assert.deepEqual(newOrders(r), []);
    }
    await settle();
    assert.equal(moves(r).length, 1, `${how}: once`);
  }
});

test("rule b: a take-profit that fills in parts: the stop is made to fit after each", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r, 1000, 3.16, 40); // 40 of its 75: 110 held
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the first fit");
  halfSold(r, 1000, 3.16, 35); // the rest of its 75: 75 held
  r.clock.now += 400;
  await until(() => moves(r).length === 2, "the second fit");
  assert.deepEqual(changes(r.world.current), [
    [1002, 110, 2.56, 2.64],
    [1002, 75, 2.56, 2.64],
  ]);
});

test("rule b (12): a stop of the wrong size is fitted 500 ms after the last move at the earliest, not resellMs", async (t) => {
  const r = await ruled(t, { config: (c) => (c.auto.resellMs = 2000) });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r, 1000, 3.16, 40);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the first fit");
  const at = r.clock.now;
  halfSold(r, 1000, 3.16, 35);
  await settle();
  r.clock.now = at + 499;
  await settle();
  assert.equal(moves(r).length, 1);
  r.clock.now = at + 500;
  await until(() => moves(r).length === 2, "the second fit");
  assert.deepEqual(moves(r)[1], ["fit", 2.64, 75, "moved"]);
});

test("rule b: a change of the stop that TWS takes after a fill it had already counted is too large for a moment, and the next fit puts it right", async (t) => {
  const raced = { done: false };
  const race = (w: FakeTws): void => {
    w.onOrder = (ib, id, order, change) => {
      if (!change || id !== 1002 || raced.done) return;
      raced.done = true;
      // At TWS the take-profit's next 45 sold first; then this change, for 120, was taken.
      queueMicrotask(() => {
        fill(ib, 1001, "tp-45", 45, 3.16, 75);
        ib.emit("orderStatus", 1001, "Filled", 75, 0, 3.16);
        w.positions.set(111, 75);
        ib.reports(1002, { totalQuantity: order.totalQuantity });
      });
    };
  };
  const r = await ruled(t, { world: race });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r, 1000, 3.16, 30); // 120 held
  r.world.current.reports(1002, { totalQuantity: 120 }); // TWS shrank the stop
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the move, for 120");
  assert.equal(r.bridge.orders()[0]?.held_qty, 75);
  r.clock.now += 600;
  await until(() => moves(r).length === 2, "the fit");
  assert.deepEqual(changes(r.world.current), [
    [1002, 120, 2.56, 2.64],
    [1002, 75, 2.56, 2.64],
  ]);
});

test("rule b with no price at all: a stop of the wrong size is changed to what is held where it stands, a stop that is gone is put back where it stood; nothing else moves", async (t) => {
  // TWS gives this stock no live quotes: not one bid or trade reaches the watch.
  const left = await ruled(t);
  await autoHolding(left);
  halfSold(left);
  left.clock.now += HALF;
  await until(() => moves(left).length === 1, "the fit");
  assert.deepEqual(changes(left.world.current), [[1002, 75, 2.28, 2.36]]);
  assert.deepEqual(moves(left), [["fit", 2.36, 75, "moved"]]);
  left.clock.now += 20_000;
  await settle();
  assert.equal(moves(left).length, 1, "no move to the entry, no trail, without a price");

  const took = await ruled(t);
  await autoHolding(took);
  halfSold(took);
  took.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  took.clock.now += HALF;
  await until(() => moves(took).length === 1, "the stop put back");
  assert.deepEqual(newOrders(took), [[1003, "STP LMT", 75, 2.28, 2.36, 0]]);
  assert.deepEqual(moves(took), [["fit", 2.36, 75, "placed"]]);

  const shrank = await ruled(t);
  await autoHolding(shrank);
  halfSold(shrank);
  shrank.world.current.reports(1002, { totalQuantity: 75 });
  shrank.clock.now += HALF;
  await settle();
  shrank.clock.now += 20_000;
  await settle();
  assert.deepEqual([moves(shrank), shrank.world.allModified()], [[], []]);
});

test("rule b (4): a stop the operator cut by hand, with shares sold by hand, is moved for what the account holds, never more", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  r.world.positions.set(111, 50); // 100 sold by hand in TWS
  r.world.current.reports(1002, { totalQuantity: 50 }); // and the stop cut to 50
  quote(r, "bid", 2.95);
  await until(() => moves(r).length === 1, "the move to the entry");
  assert.deepEqual(changes(r.world.current), [[1002, 50, 2.56, 2.64]]);

  // The half sold, TWS took the stop, and the account is flat: no stop goes in.
  const flat = await ruled(t);
  await autoHolding(flat);
  quote(flat, "bid", 2.8);
  halfSold(flat);
  flat.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  flat.world.positions.set(111, 0);
  flat.clock.now += HALF;
  await until(() => flat.journal.ofType("auto_stop_failed").length === 1, "the refusal");
  assert.equal(flat.journal.ofType("auto_stop_failed")[0]?.["code"], "nothing_to_sell");
  flat.clock.now += 1000;
  await settle();
  assert.deepEqual(newOrders(flat), []);
});

// ------------------------------------------------------------- c. trailing

test("rule c: the trail follows the highest bid, not a stray trade above the market", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the stop fitted, at the entry");
  // One print at 5.00 with the bid at 3.20: by trades the stop would want 4.00, over the bid, and sell.
  r.clock.now += 400;
  quote(r, "bid", 3.2);
  quote(r, "last", 5.0);
  await settle();
  r.clock.now += 400;
  await settle();
  assert.deepEqual(moves(r), [["to_entry", 2.64, 75, "moved"]]);
  assert.deepEqual([r.journal.ofType("auto_sell"), r.bridge.orders()[0]?.watch], [[], null]);
  // The bid itself gets up there: the stop follows it.
  quote(r, "bid", 3.4);
  await until(() => moves(r).length === 2, "the trail");
  assert.deepEqual(moves(r)[1], ["trail", 2.72, 75, "moved"]);
  assert.deepEqual(pick(r.journal.ofType("auto_stop")[1], ["hi", "hi_bid"]), { hi: 5, hi_bid: 3.4 });
});

test("rule c: after the half sold, the stop is at the cost at least, also with the move to the entry switched off", async (t) => {
  const r = await ruled(t, { config: (c) => (c.auto.stopToEntryAtPct = 0) });
  await autoHolding(r);
  quote(r, "bid", 3.16); // 20% under it is 2.528: under the cost, 2.64
  await settle();
  assert.deepEqual(moves(r), [], "no move to the entry before the half");
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the stop after the half");
  assert.deepEqual(changes(r.world.current), [[1002, 75, 2.56, 2.64]]);
});

test("rule c: two trailing moves are at least resellMs apart on the watch's clock", async (t) => {
  const r = await ruled(t, { config: (c) => (c.auto.resellMs = 1000) });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the first move");
  const at = r.clock.now;
  quote(r, "bid", 3.6); // 2.88: a step up, but too soon
  await settle();
  r.clock.now = at + 999;
  await settle();
  assert.equal(moves(r).length, 1);
  r.clock.now = at + 1000;
  await until(() => moves(r).length === 2, "the second move");
  assert.deepEqual(moves(r), [
    ["to_entry", 2.64, 75, "moved"],
    ["trail", 2.88, 75, "moved"],
  ]);
});

test("rule c: the highest bid is kept when TWS goes away and comes back", async (t) => {
  const r = await ruled(t, { config: (c) => (c.auto.resellMs = 1000) });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the first move, to 2.64");
  quote(r, "bid", 3.6); // 2.88 is due, but must wait resellMs: TWS goes away first
  await reconnect(r);
  r.clock.now += 1000;
  quote(r, "bid", 3.3); // under the high it saw before
  await until(() => moves(r).length === 2, "the move the high still asks for");
  assert.deepEqual(moves(r)[1], ["trail", 2.88, 75, "moved"]);
  assert.deepEqual(changes(r.world.current), [[1002, 75, 2.79, 2.88]]);
});

// ------------------------------------------------- d. never within 1% of the bid

test("rule d: a fast reversal before the stop could be moved: the bid under where it should go, no order there; the rule's stop is hit and everything is sold at once", async (t) => {
  const r = await ruled(t, { world: confirmsCancels });
  const record = await r.bridge.autoOrder(autoBuyNow(r));
  taken(r, record.order_id);
  boughtAll(r, record.order_id, 2.64); // the same moment the bracket went out: a change to it now is too soon
  const ib = r.world.current;
  quote(r, "bid", 2.95); // +11.7%
  await until(() => r.journal.ofType("auto_stop_failed").length === 1, "too soon");
  quote(r, "bid", 2.6); // and back under the cost before the move could go
  r.clock.now += RESELL;
  await until(() => r.bridge.orders()[0]?.watch?.state === "stop_due", "the rule's stop hit");
  const due = r.journal.ofType("auto_watch").find((line) => line["what"] === "stop_due");
  assert.equal(due?.["level"], 2.64);
  assert.deepEqual(ib.modified(), [], "no stop is put at or above the bid");

  r.clock.now += STOP_GRACE;
  await until(() => newOrders(r).length === 1, "the sell");
  // Everything at once: the take-profit cancelled, then the stop, then one sell order for 150.
  assert.deepEqual(cancels(r), [1001, 1002]);
  assert.deepEqual(newOrders(r), [[1003, "LMT", 150, 2.54, undefined, 0]]);
  assert.deepEqual([moves(r), ib.modified()], [[], []]);
});

test("rule d: the bid back above the rule's level before its wait ends: cleared, nothing sold, and the stop goes to the entry", async (t) => {
  const r = await ruled(t);
  const record = await r.bridge.autoOrder(autoBuyNow(r));
  taken(r, record.order_id);
  boughtAll(r, record.order_id, 2.64);
  quote(r, "bid", 2.95);
  await until(() => r.journal.ofType("auto_stop_failed").length === 1, "too soon");
  quote(r, "bid", 2.6);
  r.clock.now += RESELL;
  await until(() => r.bridge.orders()[0]?.watch?.state === "stop_due", "the rule's stop hit");
  quote(r, "bid", 2.7);
  r.clock.now += STOP_GRACE;
  await until(() => watchLines(r).includes("cleared"), "the clear");
  r.clock.now += 400; // past the 300 ms a change to the bracket keeps from its placing
  await until(() => moves(r).length === 1, "the move to the entry");
  assert.deepEqual(changes(r.world.current), [[1002, 150, 2.56, 2.64]]);
  assert.deepEqual([r.journal.ofType("auto_sell"), newOrders(r)], [[], []]);
});

test("rule d: the bid above the stop's place but within 1%: nothing this round; with room, the move", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the fit at the entry");
  quote(r, "bid", 3.4); // the trail wants 2.72...
  quote(r, "bid", 2.74); // ...and the bid is within 1% of it before it could go
  r.clock.now += 400;
  await settle();
  r.clock.now += 400;
  await settle();
  assert.deepEqual([moves(r).length, r.bridge.orders()[0]?.watch], [1, null]);
  quote(r, "bid", 2.8);
  await until(() => moves(r).length === 2, "the move");
  assert.deepEqual(moves(r)[1], ["trail", 2.72, 75, "moved"]);
});

test("rule d: no stop at all after the half sold: placed as near the bid as there is room for", async (t) => {
  const near = await ruled(t);
  await autoHolding(near);
  halfSold(near);
  near.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  quote(near, "bid", 2.66);
  near.clock.now += HALF;
  await until(() => moves(near).length === 1, "the stop placed");
  // roundDown(2.66 × 0.99) = 2.63, its limit 2.5511 → 2.55.
  assert.deepEqual(newOrders(near), [[1003, "STP LMT", 75, 2.55, 2.63, 0]]);
});

test("rule d (10): no stop working and the bid at or under its place is the stop due at once, also inside the 700 ms and inside the wait after a failed placement", async (t) => {
  // TWS took the stop with the take-profit's fill, and the bid is already under the cost: no settle time is waited.
  const hit = await ruled(t);
  await autoHolding(hit);
  halfSold(hit);
  hit.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  quote(hit, "bid", 2.6);
  assert.equal(hit.bridge.orders()[0]?.watch?.state, "stop_due");
  hit.clock.now += STOP_GRACE; // well inside the 700 ms
  await until(() => newOrders(hit).length === 1, "the sell");
  assert.deepEqual(newOrders(hit), [[1003, "LMT", 75, 2.54, undefined, 0]]);
  assert.deepEqual(moves(hit), []);

  // A stop of its own TWS refused (and the cancel of it confirmed): the bid falls before the next try.
  const failed = await ruled(t, { ackWaitMs: 300, world: both(answering((id, change) => !change && id === 1003), confirmsCancels) });
  await autoHolding(failed);
  quote(failed, "bid", 2.8);
  halfSold(failed);
  failed.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  failed.clock.now += HALF;
  await until(() => failed.bridge.orders()[0]?.legs.stop?.status === "Cancelled" && failed.journal.ofType("auto_stop_failed").length === 1, "the refused stop, cancelled");
  quote(failed, "bid", 2.6);
  assert.equal(failed.bridge.orders()[0]?.watch?.state, "stop_due");
  failed.clock.now += STOP_GRACE; // under resellMs: the next try has not come
  await until(() => newOrders(failed).length === 2, "the sell");
  assert.deepEqual(newOrders(failed), [
    [1003, "STP LMT", 75, 2.56, 2.64, 0],
    [1004, "LMT", 75, 2.54, undefined, 0],
  ]);
});

// --------------------------------------------------- e. cancelled by hand

test("rule e: a stop cancelled by hand before the take-profit sold anything is left alone: no move and no new stop, ever", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0); // by the operator
  quote(r, "bid", 2.95);
  await settle();
  r.clock.now += HALF;
  await until(() => watchLines(r).includes("stop_by_hand"), "taken for the operator's");
  assert.deepEqual([moves(r), r.world.allModified(), newOrders(r)], [[], [], []]);
  // Later the take-profit sells its half: the stop the operator cancelled stays cancelled.
  halfSold(r);
  r.clock.now += HALF;
  await settle();
  r.clock.now += 20_000;
  await settle();
  assert.deepEqual([moves(r), newOrders(r)], [[], []]);
});

test("rule e: TWS's word that the stop is gone can come a moment before the fill that took it: then the stop is replaced", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  quote(r, "bid", 2.8);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  r.clock.now += 100;
  await settle();
  halfSold(r); // the take-profit's fill, 100 ms later
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the stop replaced");
  assert.deepEqual(newOrders(r), [[1003, "STP LMT", 75, 2.56, 2.64, 0]]);
  assert.ok(!watchLines(r).includes("stop_by_hand"));
});

test("rule e (13): after the half sold, a stop gone more than 3 s after the take-profit's last fill was cancelled by hand; within 3 s it was TWS's doing", async (t) => {
  const late = await ruled(t);
  await autoHolding(late);
  quote(late, "bid", 2.8);
  halfSold(late);
  late.clock.now += HALF;
  await until(() => moves(late).length === 1, "the fit");
  late.clock.now += 2800; // 3.5 s after the fill, the stop still seen working
  await settle();
  late.world.current.emit("orderStatus", 1002, "Cancelled", 0, 75, 0);
  await until(() => watchLines(late).includes("stop_by_hand"), "taken for the operator's");
  late.clock.now += 20_000;
  await settle();
  assert.deepEqual([newOrders(late), moves(late).length], [[], 1]);

  const soon = await ruled(t);
  await autoHolding(soon);
  quote(soon, "bid", 2.8);
  halfSold(soon);
  soon.clock.now += HALF;
  await until(() => moves(soon).length === 1, "the fit");
  soon.clock.now += 300; // 1 s after the fill
  await settle();
  soon.world.current.emit("orderStatus", 1002, "Cancelled", 0, 75, 0);
  soon.clock.now += 400;
  await until(() => moves(soon).length === 2, "the stop replaced");
  assert.deepEqual(newOrders(soon), [[1003, "STP LMT", 75, 2.56, 2.64, 0]]);
  assert.ok(!watchLines(soon).includes("stop_by_hand"));
});

// ------------------------------------------------------------ f. the log

test("rule f: a refused move is logged once per code and tried again 15 s later while a stop is working", async (t) => {
  let refusing = true;
  const r = await ruled(t, { ackWaitMs: 300, world: answering((id, change) => refusing && change && id === 1002) });
  await autoHolding(r);
  const tries = (): number => r.world.current.modified().length;
  quote(r, "bid", 2.91);
  await until(() => r.journal.ofType("auto_stop_failed").length === 1, "the refusal");
  assert.deepEqual(pick(r.journal.ofType("auto_stop_failed")[0], ["why", "stop", "code"]), { why: "to_entry", stop: 2.64, code: "tws_refused" });
  const at = r.clock.now;
  r.clock.now = at + 14_999;
  await settle();
  assert.equal(tries(), 1);
  r.clock.now = at + 15_000;
  await until(() => tries() === 2, "the second try");
  await settle();
  assert.equal(r.journal.ofType("auto_stop_failed").length, 1, "the same refusal again is not a second line");
  // TWS takes it now.
  refusing = false;
  r.clock.now += 15_000;
  await until(() => moves(r).length === 1, "the move");
  assert.equal(tries(), 3);
});

test("rule f: a move too soon after the last change is tried again resellMs later", async (t) => {
  const r = await ruled(t);
  const record = await r.bridge.autoOrder(autoBuyNow(r));
  taken(r, record.order_id);
  boughtAll(r, record.order_id, 2.64); // the same moment the bracket went out
  quote(r, "bid", 2.91);
  await until(() => r.journal.ofType("auto_stop_failed").length === 1, "too soon");
  assert.equal(r.journal.ofType("auto_stop_failed")[0]?.["code"], "too_soon");
  r.clock.now += 400;
  await until(() => moves(r).length === 1, "the move");
});

test("rule f (7, 12): a stop of its own refused, cancelled by its id and confirmed: tried again resellMs after the last try, not 15 s", async (t) => {
  const r = await ruled(t, { ackWaitMs: 300, world: both(answering((id, change) => !change && id === 1003), confirmsCancels) });
  await autoHolding(r);
  quote(r, "bid", 3.1);
  await until(() => moves(r).length === 1, "to the entry");
  halfSold(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  r.clock.now += HALF;
  await until(() => r.bridge.orders()[0]?.legs.stop?.status === "Cancelled" && r.journal.ofType("auto_stop_failed").length === 1, "refused, cancelled, confirmed");
  assert.deepEqual(r.journal.ofType("stop_cleanup").map((line) => line["leg_order_id"]), [1003]);
  r.clock.now += RESELL;
  await until(() => newOrders(r).length === 2, "the second try");
  assert.deepEqual(newOrders(r).map((order) => order[0]), [1003, 1004]);
});

test("rule f (7): a stop of its own answered with an error and then silence: one stop placed, one cancel, and nothing more until TWS answers the cancel", async (t) => {
  const r = await ruled(t, {
    ackWaitMs: 300,
    world: answering(
      (id, change) => !change && id === 1003,
      404,
      "Shares for this order are not immediately available for short sale. The order will be held while we attempt to locate the shares.",
    ),
  });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  r.clock.now += HALF;
  await until(() => r.bridge.orders()[0]?.legs.stop?.status === "PendingCancel", "the cancel of it asked");
  for (let i = 0; i < 4; i += 1) {
    r.clock.now += 20_000;
    await settle();
  }
  assert.deepEqual([newOrders(r).map((order) => order[0]), cancels(r)], [[1003], [1003]]);
  assert.deepEqual(r.journal.ofType("stop_cleanup").map((line) => line["leg_order_id"]), [1003]);
  // TWS confirms the cancel: now another goes in.
  r.world.current.emit("orderStatus", 1003, "Cancelled", 0, 75, 0);
  await until(() => newOrders(r).length === 2, "the next stop", 500).catch(() => undefined);
  assert.deepEqual(newOrders(r)[1], [1004, "STP LMT", 75, 2.56, 2.64, 0], `auto_watch: ${JSON.stringify(watchLines(r))}`);
});

test("rule f (16): after five refused moves in a row the watch stops tending the stop, and says so on the order", async (t) => {
  const r = await ruled(t, { ackWaitMs: 300, world: both(answering((id, change) => !change && id >= 1003), confirmsCancels) });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  halfSold(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
  r.clock.now += HALF;
  for (let round = 1; round <= 5; round += 1) {
    await until(() => newOrders(r).length === round && r.journal.ofType("stop_cleanup").length === round && r.bridge.orders()[0]?.legs.stop?.status === "Cancelled", `round ${round}`);
    r.clock.now += RESELL;
  }
  await until(() => watchLines(r).includes("stop_gave_up"), "the end of it");
  const gaveUp = r.journal.ofType("auto_watch").find((line) => line["what"] === "stop_gave_up");
  assert.deepEqual([gaveUp?.["tries"], gaveUp?.["code"]], [5, "tws_refused"]);
  assert.match(r.bridge.orders()[0]?.note ?? "", /^the exit watch could not set this order's stop \(.+\): look at it in TWS$/);
  r.clock.now += 60_000;
  await settle();
  assert.equal(newOrders(r).length, 5);
  assert.deepEqual(r.watch.watching(), [1000]);
});

test(
  "rule f (16, 10): after it stopped tending, a bid at or under where the stop should stand still sells what is held",
  async (t) => {
    const r = await ruled(t, { ackWaitMs: 300, world: both(answering((id, change) => !change && id >= 1003), confirmsCancels) });
    await autoHolding(r);
    quote(r, "bid", 2.8);
    halfSold(r);
    r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0);
    r.clock.now += HALF;
    for (let round = 1; round <= 5; round += 1) {
      await until(() => newOrders(r).length === round && r.bridge.orders()[0]?.legs.stop?.status === "Cancelled", `round ${round}`);
      r.clock.now += RESELL;
    }
    await until(() => watchLines(r).includes("stop_gave_up"), "the end of it");
    quote(r, "bid", 2.6); // under the cost, where the stop should have stood
    r.clock.now += STOP_GRACE;
    await until(() => newOrders(r).length === 6, "the sell", 500);
    assert.deepEqual(newOrders(r)[5], [1008, "LMT", 75, 2.54, undefined, 0]);
  },
);

// ------------------------------------------------------- g., h. and the chase

test("rule g: a passed-over take-profit for a part: the watch moves the take-profit only, and once it has sold the rest is tended, not sold", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  const ib = r.world.current;
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16); // the take-profit traded, and the bid +18%: the stop goes to the entry too
  r.clock.now += TP_GRACE;
  await until(() => changes(ib).some(([id]) => id === 1001), "the take-profit's sell");
  assert.deepEqual(changes(ib).filter(([id]) => id === 1001), [[1001, 75, 3.05, undefined]]);
  halfSold(r, 1000, 3.05);
  await until(() => watchLines(r).includes("target_sold"), "that chase over");
  r.clock.now += 400;
  await settle();
  assert.equal(r.journal.ofType("auto_sell").length, 1, "the 75 left are not sold");
  r.clock.now += HALF;
  await until(() => moves(r).length === 2, "the stop fitted");
  assert.deepEqual(moves(r), [
    ["to_entry", 2.64, 150, "moved"],
    ["fit", 2.64, 75, "moved"],
  ]);
  assert.deepEqual([r.bridge.orders()[0]?.held_qty, r.watch.watching(), cancels(r)], [75, [1000], []]);
});

test("rule g (14): the stop is tended while a passed-over take-profit is chased: cut to what is held once part of it has sold", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  const ib = r.world.current;
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => changes(ib).some(([id]) => id === 1001), "the take-profit's sell");
  halfSold(r, 1000, 3.05, 30); // 30 of its 75 sold: 120 held, the chase goes on
  quote(r, "bid", 2.6); // under the cost: the chase waits
  r.clock.now += HALF;
  await until(() => changes(ib).length === 3, "the stop cut to 120");
  assert.deepEqual(changes(ib), [
    [1002, 150, 2.56, 2.64],
    [1001, 75, 3.05, undefined],
    [1002, 120, 2.56, 2.64],
  ]);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "tp_crossed");
});

test("rule g (15): when the stop takes over from a take-profit chase, its first sell asks the bid again", async (t) => {
  const r = await ruled(t, { world: confirmsCancels });
  await autoHolding(r);
  const ib = r.world.current;
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => changes(ib).some(([id]) => id === 1001), "the take-profit's sell");
  // A trade at 2.60, under the stop at the entry; the bid stands at 2.70, above it.
  quote(r, "last", 2.6);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "stop_due");
  quote(r, "bid", 2.7);
  r.clock.now += STOP_GRACE;
  await until(() => watchLines(r).includes("cleared"), "the clear");
  assert.equal(r.journal.ofType("auto_watch").find((line) => line["what"] === "cleared")?.["was"], "stop_due");
  assert.deepEqual([cancels(r), newOrders(r), r.journal.ofType("auto_sell").length], [[], [], 1]);
});

test("rule h: the stop due at its own price sells everything at once: the take-profit cancelled, then the stop, then one sell order", async (t) => {
  const r = await ruled(t, { world: confirmsCancels });
  await autoHolding(r);
  quote(r, "bid", 2.91);
  await until(() => moves(r).length === 1, "the stop to the entry");
  r.clock.now += 400;
  quote(r, "bid", 2.6);
  quote(r, "last", 2.62);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "stop_due");
  r.clock.now += STOP_GRACE;
  await until(() => newOrders(r).length === 1, "the sell");
  assert.deepEqual(cancels(r), [1001, 1002]);
  assert.deepEqual(newOrders(r), [[1003, "LMT", 150, 2.54, undefined, 0]]);
  assert.deepEqual(changes(r.world.current), [[1002, 150, 2.56, 2.64]]); // only the move to the entry
  assert.deepEqual(pick(r.journal.ofType("auto_sell")[0], ["why", "qty", "via"]), { why: "stop_due", qty: 150, via: "new_order" });
});

// ---------------------------------------------- i. the plain bracket, and when not

test("rule i: with takeProfitPortion 1 and stopToEntryAtPct 0 nothing is tended at all", async (t) => {
  const r = await ruled(t, {
    config: (c) => {
      c.auto.takeProfitPortion = 1;
      c.auto.stopToEntryAtPct = 0;
    },
  });
  const record = await autoHolding(r);
  assert.equal(record.sent.take_profit_qty, 150);
  for (const [bid, last] of [
    [2.9, 2.95],
    [3.1, 3.12],
    [2.9, 2.91],
  ]) {
    r.clock.now += 400;
    quote(r, "bid", bid ?? 0);
    quote(r, "last", last ?? 0);
    await settle();
  }
  assert.deepEqual([moves(r), r.world.allModified(), r.journal.ofType("auto_stop_failed")], [[], [], []]);
});

test("the stop is not tended while the buy can still fill, nor while a sell order for everything works", async (t) => {
  const r = await ruled(t);
  const record = await r.bridge.autoOrder(autoBuyNow(r));
  taken(r, record.order_id);
  r.clock.now += 1000;
  boughtPart(r, 1000, 50);
  quote(r, "bid", 2.95);
  await settle();
  assert.deepEqual(moves(r), []);
  fill(r.world.current, 1000, "b2", 100, 2.64, 150);
  r.world.positions.set(111, 150);
  await until(() => moves(r).length === 1, "the move once the buy is over");
  assert.deepEqual(moves(r), [["to_entry", 2.64, 150, "moved"]]);

  const s = await ruled(t, { world: both((w) => w.bids.set("ABCD", 3.0), confirmsCancels) });
  await autoHolding(s);
  assert.equal((await s.bridge.sell({ order_id: 1000 })).via, "new_order"); // the operator's Sell: everything
  quote(s, "bid", 2.95);
  await settle();
  s.clock.now += 400;
  await settle();
  assert.deepEqual([moves(s), s.world.allModified()], [[], []]);
});

// ---------------------------------------------------------- the unhappy ones

test("unhappy: up 12% and back to the entry: the stop at the entry sells, a scratch instead of −10%", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  const ib = r.world.current;
  quote(r, "bid", 2.95);
  quote(r, "last", 2.96);
  await until(() => moves(r).length === 1, "the stop to the entry");
  r.clock.now += 400;
  quote(r, "bid", 2.63);
  quote(r, "last", 2.64);
  // TWS's stop at 2.64 sells the 150 (and TWS takes the take-profit with it).
  fill(ib, 1002, "stop", 150, 2.63, 150);
  ib.emit("orderStatus", 1002, "Filled", 150, 0, 2.63);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 75, 0);
  r.world.positions.set(111, 0);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual(changes(ib), [[1002, 150, 2.56, 2.64]]);
  assert.deepEqual([r.journal.ofType("auto_sell"), newOrders(r), r.watch.watching()], [[], [], []]);
  assert.equal(r.bridge.orders()[0]?.legs.stop?.avg_fill_price, 2.63);
});

test("unhappy: straight down: the −10% stop sells, and nothing is tended", async (t) => {
  const r = await ruled(t);
  await autoHolding(r);
  const ib = r.world.current;
  for (const [bid, last] of [
    [2.49, 2.5],
    [2.39, 2.4],
    [2.35, 2.36],
  ]) {
    quote(r, "bid", bid ?? 0);
    quote(r, "last", last ?? 0);
  }
  fill(ib, 1002, "stop", 150, 2.33, 150);
  ib.emit("orderStatus", 1002, "Filled", 150, 0, 2.33);
  ib.emit("orderStatus", 1001, "Cancelled", 0, 75, 0);
  r.world.positions.set(111, 0);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual([moves(r), r.world.allModified(), newOrders(r), r.journal.ofType("auto_sell")], [[], [], [], []]);
});

// --------------------------------------------- TWS away, and a restart

test("(1) the half take-profit filled while TWS was away (fills on reconnect, no status): the watch tends the stop, and sells the rest when it is due", async (t) => {
  const r = await ruled(t, { world: confirmsCancels });
  await autoHolding(r);
  quote(r, "bid", 2.7);
  await reconnect(r);
  // What TWS says on the new connection: the stop is still there, shrunk to 75; the take-profit's fill; no status for it.
  const ib = r.world.current;
  r.world.positions.set(111, 75);
  ib.reports(1002, { totalQuantity: 75 });
  fill(ib, 1001, "tp", 75, 3.16, 75);
  const record = r.bridge.orders()[0];
  assert.deepEqual([record?.legs.take_profit?.status, record?.held_qty], ["Filled", 75]);
  quote(r, "bid", 2.75);
  r.clock.now += HALF;
  await until(() => moves(r).length === 1, "the stop to the cost");
  assert.deepEqual(moves(r), [["to_entry", 2.64, 75, "moved"]]);

  // It falls through the stop: everything held is sold, and the watch does not give up.
  r.clock.now += 400;
  quote(r, "bid", 2.6);
  quote(r, "last", 2.6);
  r.clock.now += STOP_GRACE;
  await until(() => newOrders(r).length === 1, "the sell");
  assert.deepEqual(newOrders(r), [[1003, "LMT", 75, 2.54, undefined, 0]]);
  assert.deepEqual(cancels(r), [1002]);
  assert.deepEqual([r.journal.ofType("auto_sell_failed"), watchLines(r).includes("gave_up")], [[], false]);
});

test("(1) the half take-profit filled while TWS was away: a click on Sell sells the rest", async (t) => {
  const r = await ruled(t, { world: both((w) => w.bids.set("ABCD", 2.7), confirmsCancels) });
  await autoHolding(r);
  await reconnect(r);
  const ib = r.world.current;
  r.world.positions.set(111, 75);
  ib.reports(1002, { totalQuantity: 75 });
  fill(ib, 1001, "tp", 75, 3.16, 75);
  r.clock.now += 2000;
  assert.deepEqual(await r.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 75, limit: 2.64, status: "PendingSubmit", via: "new_order" });
  assert.deepEqual(cancels(r), [1002]);
  assert.deepEqual(newOrders(r), [[1003, "LMT", 75, 2.64, undefined, 0]]);
});

test("(6) the take-profit filled and TWS took the stop while the bridge was away: the fit is answered 'no such order', and a stop of its own goes in", async (t) => {
  const r = await ruled(t, {
    ackWaitMs: 300,
    world: answering((id, change) => change && id === 1002, 135, "Can't find order with id ={id}"),
  });
  await autoHolding(r);
  quote(r, "bid", 2.8);
  await reconnect(r);
  // TWS reports the take-profit's fill, and nothing about the stop.
  r.world.positions.set(111, 75);
  fill(r.world.current, 1001, "tp", 75, 3.16, 75);
  quote(r, "bid", 2.8);
  r.clock.now += HALF;
  await until(() => r.bridge.orders()[0]?.legs.stop?.status === "Inactive", "the stop known gone");
  const refused = r.journal.ofType("change_refused");
  assert.deepEqual([refused.length, refused[0]?.["leg"], refused[0]?.["leg_order_id"]], [1, "stop", 1002]);
  r.clock.now += RESELL;
  await until(() => moves(r).length === 1, "a stop of its own");
  assert.deepEqual(newOrders(r), [[1003, "STP LMT", 75, 2.56, 2.64, 0]]);
  assert.deepEqual(moves(r), [["to_entry", 2.64, 75, "placed"]]);
  assert.ok(!watchLines(r).includes("stop_by_hand"));
});

test("restart in the middle of a trailed trade: the watch takes it up again, makes sure of the stop's size, and the stop only rises from there", async (t) => {
  const dir = tempDir(t, "trail-restart");
  let current: Rig | undefined;
  const journalOf = (): FileJournal => new FileJournal(dir, () => current?.clock.now ?? W0, [TOKEN]);
  const a = await ruled(t, { journal: journalOf() });
  current = a;
  await autoHolding(a);
  quote(a, "bid", 2.91);
  await until(() => moves(a).length === 1, "to the entry");
  halfSold(a);
  quote(a, "bid", 3.5);
  a.clock.now += HALF;
  await until(() => moves(a).length === 2, "fitted and trailing at 2.80");
  assert.equal(a.bridge.orders()[0]?.sent.stop, 2.8);
  a.watch.close();
  a.link.stop();

  // The bridge starts again; TWS still has the orders, the account the 75.
  const world = (w: FakeTws): void => {
    for (const id of [1000, 1001, 1002]) w.orderIds.add(id);
    w.positions.set(111, 75);
  };
  const b = await ruled(t, { journal: journalOf(), now: a.clock.now + 5000, world });
  current = b;
  assert.deepEqual(b.watch.watching(), [1000]);
  const record = b.bridge.orders()[0];
  assert.ok(record !== undefined);
  assert.deepEqual([record.sent.stop, record.held_qty, record.sent.take_profit_qty, b.bridge.stopQtyOf(record)], [2.8, 75, 75, null]);
  // Its high starts from the price now: 3.20 asks for 2.56. The stop is not lowered; its size,
  // not known after the restart, is set to what is held where it stands.
  quote(b, "bid", 3.2);
  b.clock.now += HALF;
  await until(() => b.world.current.modified().length === 1, "the size made sure of");
  assert.deepEqual(changes(b.world.current), [[1002, 75, 2.71, 2.8]]);
  // A new high takes it up from there.
  b.clock.now += 600;
  quote(b, "bid", 3.6);
  await until(() => b.world.current.modified().length === 2, "the move");
  assert.deepEqual(changes(b.world.current)[1], [1002, 75, 2.79, 2.88]);
  assert.equal(b.world.current.modified()[1]?.order.parentId, 1000);
});
