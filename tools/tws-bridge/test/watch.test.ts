import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { OrderRecord } from "../src/book.js";
import type { AutoBuy } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { MemoryJournal } from "../src/journal.js";
import type { QuoteListener } from "../src/link.js";
import { ExitWatch } from "../src/watch.js";
import type { QuoteSource, WatchHost } from "../src/watch.js";
import { sleep, until } from "./fake-tws.js";
import { buy, rig, T0 } from "./harness.js";
import type { Rig, RigOptions } from "./harness.js";
import { ABCD, boughtAll, boughtPart, changes, fill, iso, soldAtTarget, taken, W0 } from "./scenes.js";

// The automation's half that sells (src/watch.ts), over a real bridge on the fake TWS. Its order
// here: alert 2.50 → 150 shares bought at 2.64 (the buy's average, its cost), take-profit 3.16,
// stop 2.36 / 2.28; ids 1000 (buy), 1001 (take-profit), 1002 (stop); ABCD is contract 111. A sell
// is at the bid less order.sellOffsetPct (2%), rounded down: a bid of 3.12 sells at 3.05.
//
// The grace periods and the re-sell interval are measured on the movable clock, and the watch's
// timers run in real time: here they are a few tens of milliseconds, so a test moves the clock and
// then lets that much real time pass. A wait the clock has not finished never ends, however long
// the real wait is.

const TP_GRACE = 30;
const STOP_GRACE = 20;
const RESELL = 40;
/** Real time enough for every timer of the watch to have fired at least once. */
const SETTLE = 70;
const CLOSE = Date.parse("2026-11-25T10:00:00Z");

interface WatchRig extends Rig {
  watch: ExitWatch;
}

async function watched(t: TestContext, options: RigOptions = {}): Promise<WatchRig> {
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

let alerts = 0;

function autoBuy(r: Rig, overrides: Partial<AutoBuy> = {}): AutoBuy {
  alerts += 1;
  return { ticker: "ABCD", alertPrice: 2.5, alertAt: iso(r.clock.now), alertId: `pop-w${alerts}`, validSec: 300, notAfterMs: CLOSE, ...overrides };
}

/** The automation's order, placed, taken by TWS and bought in full at 2.64: the account holds 150 ABCD. */
async function holding(r: Rig): Promise<OrderRecord> {
  const record = await r.bridge.autoOrder(autoBuy(r));
  taken(r, record.order_id);
  r.clock.now += 1000; // a change to the bracket is not "too soon" after it was placed
  boughtAll(r, record.order_id, 2.64);
  return record;
}

/** The quote moves on the stream (and a snapshot of the bid, should the bridge read one, says the same). */
function quote(r: Rig, field: "bid" | "ask" | "last", price: number): void {
  if (field === "bid") r.world.bids.set("ABCD", price);
  r.world.tick(111, field, price);
}

function settle(): Promise<void> {
  return sleep(SETTLE);
}

function watchLines(r: Rig): unknown[] {
  return r.journal.ofType("auto_watch").map((line) => line["what"]);
}

/** The take-profit leg as a sell moves it: the whole order again, at the new limit. */
function movedTakeProfit(qty: number, limit: number): Record<string, unknown> {
  return { action: "SELL", orderType: "LMT", totalQuantity: qty, lmtPrice: limit, tif: "GTC", outsideRth: true, parentId: 1000, transmit: true };
}

// ------------------------------------------------------------ what it watches

test("watch: only the automation's order is watched, from its first share to its last, with a stream for that time", async (t) => {
  const r = await watched(t);
  const record = await r.bridge.autoOrder(autoBuy(r));
  taken(r, record.order_id);
  // A buy that only waits is not watched, and no quote is asked for.
  assert.deepEqual(r.watch.watching(), []);
  assert.deepEqual(r.world.streams(), []);
  r.clock.now += 1000;

  boughtPart(r, 1000, 50);
  assert.deepEqual(r.watch.watching(), [1000]);
  assert.deepEqual(r.world.streams().map((stream) => [stream.conId, stream.symbol]), [[111, "ABCD"]]);
  // A plain stream: not a snapshot, never the regulatory snapshot (it costs money per request).
  assert.deepEqual(r.world.current.callsOf("reqMktData").at(-1)?.args.slice(2), ["", false, false]);
  assert.deepEqual(watchLines(r), ["watching"]);

  // The rest fills, the take-profit sells it all: the watch ends and its stream is closed.
  fill(r.world.current, 1000, "b2", 100, 2.64, 150);
  r.world.current.emit("orderStatus", 1000, "Filled", 150, 0, 2.64);
  r.world.positions.set(111, 150);
  assert.deepEqual(r.world.current.callsOf("reqMktData").length, 1);
  soldAtTarget(r, 1000);
  assert.deepEqual(r.watch.watching(), []);
  assert.deepEqual(r.world.streams(), []);
  assert.equal(r.world.current.callsOf("cancelMktData").length, 1);
  assert.equal(r.bridge.orders()[0]?.watch, null);
});

test("watch: a clicked order is never watched, and never sold by the watch, whatever the price does", async (t) => {
  const r = await watched(t);
  const click = await r.bridge.order(buy()); // 1000: take-profit 2.78, stop 2.40
  boughtAll(r, click.order_id, 2.52);
  assert.deepEqual(r.watch.watching(), []);
  assert.deepEqual(r.world.streams(), []);

  // An order of the automation's on the same stock opens a stream: its prices reach the click's levels too.
  r.clock.now += 11_000;
  await holding(r); // 1003, take-profit 3.16, stop 2.36
  assert.deepEqual(r.watch.watching(), [1003]);
  quote(r, "bid", 2.2);
  quote(r, "last", 2.25); // under both stops
  r.clock.now += 1000;
  await until(() => r.world.allModified().length === 1, "the automation's sell");
  await settle();
  assert.deepEqual(changes(r.world.current), [[1004, 150, 2.15, undefined]]);
  const clickNow = r.bridge.orders().find((order) => order.order_id === 1000);
  assert.deepEqual([clickNow?.watch, clickNow?.exit, clickNow?.sent.take_profit], [null, null, 2.78]);
});

// ------------------------------------------------------------- the take-profit

test("watch: the take-profit traded at and not filled: nothing in its grace, then one sell, through the take-profit, at the bid", async (t) => {
  const r = await watched(t);
  await holding(r);
  const ib = r.world.current;
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  const since = r.clock.now;
  const record = (): OrderRecord | undefined => r.bridge.orders()[0];
  assert.deepEqual(record()?.watch, { state: "tp_crossed", since: iso(since), sells: 0, last_error: null });
  const line = r.journal.ofType("auto_watch").find((entry) => entry["what"] === "tp_crossed");
  assert.deepEqual([line?.["level"], line?.["last"], line?.["held"]], [3.16, 3.16, 150]);

  await settle(); // real time passes, the clock does not: still in its grace
  assert.deepEqual(ib.modified(), []);
  r.clock.now = since + TP_GRACE - 1;
  await settle();
  assert.deepEqual(ib.modified(), []);

  r.clock.now = since + TP_GRACE;
  await until(() => ib.modified().length === 1, "the sell");
  assert.deepEqual(ib.modified(), [{ id: 1001, contract: ABCD, order: movedTakeProfit(150, 3.05) }]);
  assert.equal(r.world.allPlaced().length, 3); // no order of its own
  await settle();
  assert.equal(ib.modified().length, 1, "one sell");
  assert.deepEqual(record()?.watch, { state: "tp_crossed", since: iso(since), sells: 1, last_error: null });
  assert.deepEqual([record()?.exit?.via, record()?.exit?.limit, record()?.exit?.qty], ["take_profit", 3.05, 150]);
  const sold = r.journal.ofType("auto_sell");
  assert.equal(sold.length, 1);
  assert.deepEqual(
    [sold[0]?.["why"], sold[0]?.["qty"], sold[0]?.["limit"], sold[0]?.["via"], sold[0]?.["bid"], sold[0]?.["bid_from"], sold[0]?.["sells"]],
    ["tp_crossed", 150, 3.05, "take_profit", 3.12, "stream", 1],
  );
});

test("watch: the take-profit filling in its grace: nothing is ever sent; one that fills in part leaves the rest to be sold", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  soldAtTarget(r, 1000, 3.16);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual(r.world.allModified(), []);
  assert.deepEqual([r.watch.watching(), r.world.streams(), r.bridge.orders()[0]?.watch], [[], [], null]);

  // 100 of the 150 sell at the target; the other 50 are left behind.
  const p = await watched(t);
  await holding(p);
  quote(p, "bid", 3.12);
  quote(p, "last", 3.16);
  fill(p.world.current, 1001, "t1", 100, 3.16, 100);
  p.world.current.emit("orderStatus", 1001, "Submitted", 100, 50, 3.16);
  p.world.positions.set(111, 50);
  p.clock.now += TP_GRACE;
  await until(() => p.world.current.modified().length === 1, "the sell of the rest");
  // The order again for its whole quantity: 100 sold, 50 to go.
  assert.deepEqual(changes(p.world.current), [[1001, 150, 3.05, undefined]]);
  assert.equal(p.bridge.orders()[0]?.exit?.qty, 50);
});

test("watch: only a trade counts: a bid or an ask at the take-profit, or a trade under it, is no crossing", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.2);
  quote(r, "ask", 3.25);
  quote(r, "last", 3.15);
  assert.equal(r.bridge.orders()[0]?.watch, null);
  r.clock.now += 5000;
  await settle();
  assert.deepEqual(r.world.allModified(), []);
  assert.deepEqual(watchLines(r), ["watching"]);
});

test("watch: the take-profit never sells at or under cost: cleared, and the same standing trade starts nothing; a new one does", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 2.6); // under the cost, 2.64
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => watchLines(r).includes("cleared"), "the clear");
  assert.deepEqual(r.world.allModified(), []);
  assert.equal(r.bridge.orders()[0]?.watch, null);
  const cleared = r.journal.ofType("auto_watch").find((line) => line["what"] === "cleared");
  assert.equal(cleared?.["was"], "tp_crossed");

  // The bid comes back above cost; the last trade is still the one at 3.16: nothing starts again.
  quote(r, "bid", 3.0);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual([r.world.allModified(), r.bridge.orders()[0]?.watch], [[], null]);
  // A new trade at the take-profit does.
  quote(r, "last", 3.17);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "tp_crossed");
  r.clock.now += TP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.94, undefined]]);
});

test("watch: the take-profit with no bid yet waits and sends nothing; the first bid above cost sells", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "last", 3.16); // a stream opens silent: no bid has come
  r.clock.now += 1000;
  await settle();
  assert.deepEqual(r.world.allModified(), []);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "tp_crossed"); // not cleared
  quote(r, "bid", 3.1);
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 3.03, undefined]]);
});

test("watch: the re-check goes by the stream's latest bid however old; the sell then reads the bid from TWS; a stream that ends takes its bid with it", async (t) => {
  // TWS sends a bid only when it changes: one heard 10 s ago is the bid now.
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.12);
  r.clock.now += 10_000;
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 3.05, undefined]]);
  const sold = r.journal.ofType("auto_sell")[0];
  assert.deepEqual([sold?.["bid"], sold?.["bid_from"]], [null, "tws"]); // too old to pass along as the price

  // TWS ends the stream: its bid is nobody's, and the crossing waits for a bid instead of selling on it.
  const e = await watched(t);
  await holding(e);
  quote(e, "bid", 3.12);
  quote(e, "last", 3.16);
  const reqId = e.world.streams()[0]?.reqId ?? -1;
  e.world.current.streamError(reqId, 10197, "No market data during competing live session");
  assert.deepEqual(e.world.streams(), []);
  e.clock.now += 1000;
  await settle();
  assert.deepEqual(e.world.allModified(), []);
  assert.equal(e.bridge.orders()[0]?.watch?.state, "tp_crossed");
});

test("watch: the take-profit cancelled by hand, or a click's Sell, during its grace clears it", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  r.world.current.emit("orderStatus", 1001, "Cancelled", 0, 150, 0);
  r.clock.now += TP_GRACE;
  await until(() => watchLines(r).includes("cleared"), "the clear");
  await settle();
  assert.deepEqual(r.world.allModified(), []);

  const c = await watched(t);
  await holding(c);
  quote(c, "bid", 3.12);
  quote(c, "last", 3.16);
  assert.deepEqual(await c.bridge.sell({ order_id: 1000 }), { order_id: 1000, qty: 150, limit: 3.05, status: "Submitted", via: "take_profit" });
  c.clock.now += TP_GRACE;
  await until(() => watchLines(c).includes("cleared"), "the clear");
  await settle();
  assert.deepEqual(changes(c.world.current), [[1001, 150, 3.05, undefined]]); // the click's, and nothing more
  assert.deepEqual(c.journal.ofType("auto_sell"), []);
});

test("watch: once its take-profit sell is out, it is moved down with the bid while the bid is above cost, and left where it is at or under it", async (t) => {
  const r = await watched(t);
  await holding(r);
  const ib = r.world.current;
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => ib.modified().length === 1, "the first sell");

  quote(r, "bid", 2.9);
  r.clock.now += 400;
  await until(() => ib.modified().length === 2, "the second");
  // The bid at or under the cost: the sell stays at 2.84, and that is no error.
  quote(r, "bid", 2.6);
  r.clock.now += 400;
  await settle();
  r.clock.now += 400;
  await settle();
  assert.equal(ib.modified().length, 2);
  assert.equal(r.bridge.orders()[0]?.watch?.last_error, null);
  assert.deepEqual(r.journal.ofType("auto_sell_failed"), []);
  // Above cost again: it moves.
  quote(r, "bid", 2.7);
  r.clock.now += 400;
  await until(() => ib.modified().length === 3, "the third");
  assert.deepEqual(changes(ib), [
    [1001, 150, 3.05, undefined],
    [1001, 150, 2.84, undefined],
    [1001, 150, 2.64, undefined],
  ]);
});

// ------------------------------------------------------------------- the stop

test("watch: the stop traded at: nothing in its grace, then a sell with the bid at or under it; the stop selling all in time: nothing", async (t) => {
  const r = await watched(t);
  await holding(r);
  const ib = r.world.current;
  quote(r, "bid", 2.3);
  quote(r, "last", 2.36); // the stop's own price
  const since = r.clock.now;
  assert.deepEqual(r.bridge.orders()[0]?.watch, { state: "stop_due", since: iso(since), sells: 0, last_error: null });
  await settle();
  r.clock.now = since + STOP_GRACE - 1;
  await settle();
  assert.deepEqual(ib.modified(), []);
  r.clock.now = since + STOP_GRACE;
  await until(() => ib.modified().length === 1, "the sell");
  // The take-profit leg is alive: it is the one moved, down to the bid − 2%, under cost.
  assert.deepEqual(ib.modified(), [{ id: 1001, contract: ABCD, order: movedTakeProfit(150, 2.25) }]);
  assert.equal(r.journal.ofType("auto_sell")[0]?.["why"], "stop_due");

  // The stop sells it all within its grace: nothing is sent.
  const s = await watched(t);
  await holding(s);
  quote(s, "bid", 2.3);
  quote(s, "last", 2.36);
  fill(s.world.current, 1002, "s1", 150, 2.33, 150);
  s.world.current.emit("orderStatus", 1002, "Filled", 150, 0, 2.33);
  s.world.current.emit("orderStatus", 1001, "Cancelled", 0, 150, 0);
  s.world.positions.set(111, 0);
  s.clock.now += 1000;
  await settle();
  assert.deepEqual([s.world.allModified(), s.watch.watching()], [[], []]);
});

test("watch: the stop with the bid back above it at the end of its grace: cleared, and only a bid at or under it starts it again", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 2.65);
  quote(r, "last", 2.36);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "stop_due");
  r.clock.now += STOP_GRACE;
  await until(() => watchLines(r).includes("cleared"), "the clear");
  assert.deepEqual([r.world.allModified(), r.bridge.orders()[0]?.watch], [[], null]);
  assert.equal(r.journal.ofType("auto_watch").find((line) => line["what"] === "cleared")?.["was"], "stop_due");

  // The bid stays above the stop: the trade at 2.36 standing as the last one starts nothing.
  quote(r, "bid", 2.6);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual([r.world.allModified(), r.bridge.orders()[0]?.watch], [[], null]);
  // The bid comes down to it: due again, and after its grace a sell.
  quote(r, "bid", 2.3);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "stop_due");
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.25, undefined]]);

  // After a clear, a new trade at or under the stop starts it again too.
  const n = await watched(t);
  await holding(n);
  quote(n, "bid", 2.65);
  quote(n, "last", 2.36);
  n.clock.now += STOP_GRACE;
  await until(() => watchLines(n).includes("cleared"), "the clear");
  quote(n, "last", 2.35);
  assert.equal(n.bridge.orders()[0]?.watch?.state, "stop_due");
});

test("watch: the stop with no bid known goes by the last trade; the stop cancelled in its grace clears it", async (t) => {
  const r = await watched(t);
  await holding(r);
  r.world.bids.set("ABCD", 2.28); // what a snapshot reads; the stream has sent no bid
  quote(r, "last", 2.3);
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.23, undefined]]);
  const sold = r.journal.ofType("auto_sell")[0];
  assert.deepEqual([sold?.["bid"], sold?.["bid_from"]], [null, "tws"]);

  const c = await watched(t);
  await holding(c);
  quote(c, "bid", 2.3);
  quote(c, "last", 2.3);
  c.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0); // by hand
  c.clock.now += STOP_GRACE;
  await until(() => watchLines(c).includes("cleared"), "the clear");
  await settle();
  assert.deepEqual(c.world.allModified(), []);
});

test("watch: the stop's own partial fill makes it due with no price at all, and the rest is sold", async (t) => {
  const r = await watched(t);
  await holding(r);
  r.world.bids.set("ABCD", 2.25);
  fill(r.world.current, 1002, "s1", 50, 2.3, 50);
  r.world.positions.set(111, 100);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "stop_due");
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  // 100 left: the take-profit leg is moved for those 100.
  assert.deepEqual(changes(r.world.current), [[1001, 100, 2.2, undefined]]);
});

test("watch: the stop outranks the take-profit: a crossing that falls to the stop is sold as the stop is, under cost", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  assert.equal(r.bridge.orders()[0]?.watch?.state, "tp_crossed");
  quote(r, "bid", 2.28);
  quote(r, "last", 2.3);
  const since = r.clock.now;
  assert.deepEqual(r.bridge.orders()[0]?.watch, { state: "stop_due", since: iso(since), sells: 0, last_error: null });
  assert.deepEqual(watchLines(r), ["watching", "tp_crossed", "stop_due"]);
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.23, undefined]]);

  // A take-profit sell already out when the price falls to the stop goes on as the stop's, under cost.
  const o = await watched(t);
  await holding(o);
  const ib = o.world.current;
  quote(o, "bid", 3.12);
  quote(o, "last", 3.16);
  o.clock.now += TP_GRACE;
  await until(() => ib.modified().length === 1, "the take-profit's sell");
  quote(o, "bid", 2.3);
  quote(o, "last", 2.3);
  assert.equal(o.bridge.orders()[0]?.watch?.state, "stop_due");
  o.clock.now += 400;
  await until(() => ib.modified().length === 2, "the stop's");
  assert.deepEqual(changes(ib), [
    [1001, 150, 3.05, undefined],
    [1001, 150, 2.25, undefined],
  ]);
});

test("watch: once its stop sell is out it is moved down every resellMs, past order.maxChases, with no floor, and a click's Sell still works", async (t) => {
  const r = await watched(t, { config: (c) => (c.order.maxChases = 1) });
  await holding(r);
  const ib = r.world.current;
  quote(r, "bid", 2.3);
  quote(r, "last", 2.36);
  r.clock.now += STOP_GRACE;
  await until(() => ib.modified().length === 1, "the first sell");

  // The bid falls between two looks: the move waits for resellMs on the clock, then goes.
  quote(r, "bid", 2.2);
  await settle();
  assert.equal(ib.modified().length, 1);
  r.clock.now += 400;
  await until(() => ib.modified().length === 2, "the second");
  quote(r, "bid", 2.1);
  r.clock.now += 400;
  await until(() => ib.modified().length === 3, "the third");
  quote(r, "bid", 0.5);
  r.clock.now += 400;
  await until(() => ib.modified().length === 4, "the fourth");
  assert.deepEqual(changes(ib), [
    [1001, 150, 2.25, undefined],
    [1001, 150, 2.15, undefined],
    [1001, 150, 2.05, undefined],
    [1001, 150, 0.49, undefined],
  ]);

  // The bid comes back up, above the stop: nothing is moved (a sell moves down only), and nothing is wrong.
  quote(r, "bid", 2.5);
  r.clock.now += 400;
  await settle();
  r.clock.now += 400;
  await settle();
  assert.equal(ib.modified().length, 4);
  const record = r.bridge.orders()[0];
  assert.deepEqual([record?.watch?.state, record?.watch?.sells, record?.watch?.last_error], ["stop_due", 4, null]);
  assert.deepEqual(r.journal.ofType("auto_sell_failed"), []);

  // The watch's moves are not the clicks': order.maxChases (1) is all still there for a click.
  assert.equal(record?.exit?.reprices, 0);
  r.world.bids.set("ABCD", 0.45);
  r.clock.now += 400;
  const click = await r.bridge.sell({ order_id: 1000 });
  assert.deepEqual([click.limit, click.via], [0.441, "take_profit"]);
  assert.equal(r.bridge.orders()[0]?.exit?.reprices, 1);
});

// ----------------------------------------------------------- what is held

test("watch: it never sells more than the account holds", async (t) => {
  const r = await watched(t);
  await holding(r);
  r.world.positions.set(111, 40); // 110 sold by hand in TWS
  quote(r, "bid", 2.3);
  quote(r, "last", 2.36);
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 40, 2.25, undefined]]);
});

test("watch: the account holding none: refused and said on the order, and the watch ends only after 3 refusals over 20 s", async (t) => {
  const r = await watched(t);
  await holding(r);
  const ib = r.world.current;
  r.world.positions.set(111, 0);
  quote(r, "bid", 2.3);
  quote(r, "last", 2.36);
  const tries = (): number => ib.callsOf("reqPositions").length;
  r.clock.now += STOP_GRACE;
  await until(() => tries() === 1 && r.journal.ofType("auto_sell_failed").length === 1, "the first try");
  await settle();
  assert.match(r.bridge.orders()[0]?.watch?.last_error ?? "", /the account's position in TWS is 0/);
  assert.equal(r.journal.ofType("auto_sell_failed")[0]?.["code"], "nothing_to_sell");
  assert.deepEqual(r.watch.watching(), [1000]);

  r.clock.now += 10_000;
  await until(() => tries() === 2, "the second try");
  await settle();
  assert.deepEqual(r.watch.watching(), [1000], "two refusals in 10 s");
  r.clock.now += 9_000;
  await until(() => tries() === 3, "the third try");
  await settle();
  assert.deepEqual(r.watch.watching(), [1000], "three refusals in 19 s");
  r.clock.now += 1_000;
  await until(() => !r.watch.watching().includes(1000), "the end of the watch");
  assert.equal(r.journal.ofType("auto_watch").at(-1)?.["what"], "gave_up");
  assert.match(r.bridge.orders()[0]?.watch?.last_error ?? "", /the account's position in TWS is 0/);

  // For good: shares, prices and time bring it back no more.
  const after = tries();
  r.world.positions.set(111, 150);
  quote(r, "bid", 2.2);
  quote(r, "last", 2.2);
  r.clock.now += 60_000;
  await settle();
  assert.deepEqual([tries(), r.world.allModified(), r.watch.watching()], [after, [], []]);
});

test("watch: a position that shows up between refusals is sold, and the count starts over", async (t) => {
  const r = await watched(t);
  await holding(r);
  const ib = r.world.current;
  r.world.positions.set(111, 0);
  quote(r, "bid", 2.3);
  quote(r, "last", 2.36);
  const tries = (): number => ib.callsOf("reqPositions").length;
  r.clock.now += STOP_GRACE;
  await until(() => tries() === 1, "refusal 1");
  r.clock.now += 10_000;
  await until(() => tries() === 2, "refusal 2");
  // TWS's position catches up: the sell goes through.
  r.world.positions.set(111, 150);
  r.clock.now += 10_000;
  await until(() => ib.modified().length === 1, "the sell");
  // Gone again: two more refusals over 20 s are not three in a row.
  r.world.positions.set(111, 0);
  quote(r, "bid", 2.2);
  r.clock.now += 10_000;
  await until(() => tries() === 4, "refusal 3");
  r.clock.now += 10_000;
  await until(() => tries() === 5, "refusal 4");
  await settle();
  assert.deepEqual(r.watch.watching(), [1000]);
});

// ------------------------------------------------------------- left alone

test("watch: an exit the operator cancelled by hand is left alone", async (t) => {
  const r = await watched(t);
  await holding(r);
  r.world.current.emit("orderStatus", 1002, "Cancelled", 0, 150, 0); // the stop, nothing filled
  quote(r, "bid", 2.25);
  quote(r, "last", 2.3);
  r.clock.now += 1000;
  await settle();
  assert.deepEqual([r.world.allModified(), r.bridge.orders()[0]?.watch], [[], null]);

  const s = await watched(t);
  await holding(s);
  s.world.current.emit("orderStatus", 1001, "Cancelled", 0, 150, 0); // the take-profit
  quote(s, "bid", 3.15);
  quote(s, "last", 3.2);
  s.clock.now += 1000;
  await settle();
  assert.deepEqual([s.world.allModified(), s.bridge.orders()[0]?.watch], [[], null]);
});

test("watch: after a click's Sell has begun, the moved take-profit trading is no crossing", async (t) => {
  const r = await watched(t, { world: (w) => w.bids.set("ABCD", 3.0) });
  await holding(r);
  await r.bridge.sell({ order_id: 1000 }); // the take-profit goes to 2.94
  quote(r, "bid", 3.0);
  quote(r, "last", 3.0);
  quote(r, "last", 3.2); // over the take-profit as it was placed, too
  r.clock.now += 1000;
  await settle();
  assert.equal(r.bridge.orders()[0]?.watch, null);
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.94, undefined]]);
});

// ------------------------------------------------------- TWS and the rails

test("watch: TWS going away: nothing is sent, what was seen is kept, and after the reconnect the stream is asked again and the selling goes on", async (t) => {
  const r = await watched(t);
  await holding(r);
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  const since = r.clock.now;
  r.world.mode = "refuse";
  r.world.drop();
  await until(() => !r.link.isReady(), "TWS gone");
  r.clock.now = since + 1000;
  await settle();
  assert.deepEqual(r.world.allModified(), []);
  assert.deepEqual(r.bridge.orders()[0]?.watch, { state: "tp_crossed", since: iso(since), sells: 0, last_error: null });

  r.world.mode = "accept";
  await until(() => r.link.isReady() && r.world.streams().length === 1, "TWS back, and the stream asked for again");
  assert.deepEqual(r.world.streams().map((stream) => stream.conId), [111]);
  // The bid of the old stream is nobody's now: nothing goes until the new stream says the bid.
  await settle();
  assert.deepEqual(r.world.allModified(), []);
  quote(r, "bid", 3.1);
  await until(() => r.world.current.modified().length === 1, "the sell, on the new connection");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 3.03, undefined]]);
  assert.equal(r.world.allModified().length, 1);
});

test(
  "watch: a stop seen due before TWS went away is still due after the reconnect, and is sold on the new stream's prices",
  async (t) => {
    const r = await watched(t);
    await holding(r);
    quote(r, "bid", 2.3);
    quote(r, "last", 2.3);
    const since = r.clock.now;
    r.world.mode = "refuse";
    r.world.drop();
    await until(() => !r.link.isReady(), "TWS gone");
    r.clock.now += 1000; // its grace ends while TWS is away
    r.world.mode = "accept";
    await until(() => r.link.isReady() && r.world.streams().length === 1, "TWS back");
    await settle();
    // What was seen is kept: nothing says the bid is back above the stop.
    assert.deepEqual(r.bridge.orders()[0]?.watch, { state: "stop_due", since: iso(since), sells: 0, last_error: null });
    assert.ok(!watchLines(r).includes("cleared"), JSON.stringify(watchLines(r)));
    // The new stream says where the market is (TWS sends the current quote on a new subscription).
    quote(r, "bid", 2.28);
    quote(r, "last", 2.3);
    await until(() => r.world.allModified().length === 1, "the sell", 500);
    assert.deepEqual(changes(r.world.current), [[1001, 150, 2.23, undefined]]);
  },
);

test("watch: a quote stream TWS refuses is logged and breaks nothing; the stop's own fill still makes it due", async (t) => {
  const r = await watched(t, { world: (w) => w.refusedStreams.set(111, { code: 354, message: "Requested market data is not subscribed." }) });
  await holding(r);
  await until(() => watchLines(r).includes("no_quotes"), "the refusal");
  const refused = r.journal.ofType("auto_watch").find((line) => line["what"] === "no_quotes");
  assert.deepEqual([refused?.["code"], refused?.["message"]], [354, "Requested market data is not subscribed."]);
  assert.deepEqual(r.watch.watching(), [1000]);
  assert.equal(r.bridge.status().tws.connected, true);

  r.world.bids.set("ABCD", 2.25);
  fill(r.world.current, 1002, "s1", 50, 2.3, 50);
  r.world.positions.set(111, 100);
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 100, 2.2, undefined]]);
  // Asked for once in that time, not again and again.
  assert.equal(r.world.current.callsOf("reqMktData").filter((call) => call.args[3] === false).length, 1);
  assert.deepEqual(r.journal.ofType("internal_error"), []);
});

test("watch: a buy that filled while TWS was away (fills reported, no status after the reconnect) is watched and sold through its take-profit", async (t) => {
  const r = await watched(t);
  const record = await r.bridge.autoOrder(autoBuy(r));
  taken(r, record.order_id);
  r.clock.now += 1000;
  r.world.mode = "refuse";
  r.world.drop();
  await until(() => !r.link.isReady(), "TWS gone");
  r.world.mode = "accept";
  await until(() => r.link.isReady(), "TWS back");
  // TWS reports the buy's fills and nothing else about it: its status still reads as waiting.
  r.world.positions.set(111, 150);
  fill(r.world.current, 1000, "b1", 150, 2.64, 150);
  const now = r.bridge.orders()[0];
  assert.deepEqual([now?.status, now?.filled_qty, now?.held_qty], ["PreSubmitted", 150, 150]);
  assert.deepEqual(r.watch.watching(), [1000]);

  quote(r, "bid", 2.3);
  quote(r, "last", 2.3);
  r.clock.now += STOP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 2.25, undefined]]);
  assert.deepEqual(r.world.current.callsOf("cancelOrder"), []); // the buy is over: nothing to cancel first
});

test("watch: it sells while orders are halted and outside the automation's hour", async (t) => {
  const r = await watched(t);
  await holding(r);
  r.bridge.halt({ halted: true });
  r.clock.now = T0; // 10:00 New York
  quote(r, "bid", 3.12);
  quote(r, "last", 3.16);
  r.clock.now += TP_GRACE;
  await until(() => r.world.allModified().length === 1, "the sell");
  assert.deepEqual(changes(r.world.current), [[1001, 150, 3.05, undefined]]);
});

test("watch: close() leaves no timer and no stream; not_auto ends the watch on that order at once", async (t) => {
  const r = await rig(t, { now: W0 });
  const record = await holding(r);
  const heard: { listener: QuoteListener | null } = { listener: null };
  const unwatched: number[] = [];
  const asked: Array<number | null> = [];
  const host: WatchHost = {
    onOrderChanged: null,
    onLinkUp: null,
    onLinkDown: null,
    allOrders: () => [record],
    contractFor: () => ({ symbol: "ABCD" }),
    autoSell: async (_orderId, bid) => {
      asked.push(bid);
      throw new BridgeError(409, "not_auto", "order 1000 was not placed by the automation");
    },
  };
  const quotes: QuoteSource = {
    isReady: () => true,
    watchQuotes: (_contract, listener) => {
      heard.listener = listener;
      return 7;
    },
    unwatchQuotes: (requestId) => void unwatched.push(requestId),
  };
  const timeouts = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const clock = { now: W0 };
  const before = timeouts();
  const watch = new ExitWatch({ auto: r.config.auto, bridge: host, link: quotes, journal: new MemoryJournal(), clock: () => clock.now, idleLookMs: 5 });
  assert.deepEqual(watch.watching(), [1000]);
  heard.listener?.onPrice("bid", 3.12);
  heard.listener?.onPrice("last", 3.16); // due: its grace is a timer now
  assert.ok(timeouts() > before);
  watch.close();
  assert.equal(timeouts(), before);
  assert.deepEqual(unwatched, [7]);
  // Nothing wakes it after that.
  clock.now += 60_000;
  heard.listener?.onPrice("last", 3.2);
  host.onOrderChanged?.(record);
  await sleep(20);
  assert.deepEqual([asked, watch.watching(), timeouts()], [[], [], before]);

  // A refusal that cannot change ends the watch on the order at the first try.
  const journal = new MemoryJournal();
  const once = new ExitWatch({ auto: { ...r.config.auto, tpGraceMs: 0 }, bridge: host, link: quotes, journal, clock: () => clock.now, idleLookMs: 5 });
  t.after(() => once.close());
  heard.listener?.onPrice("bid", 3.12);
  heard.listener?.onPrice("last", 3.16);
  await until(() => once.watching().length === 0, "the end of the watch");
  assert.equal(asked.length, 1);
  assert.deepEqual(journal.ofType("auto_watch").map((line) => [line["what"], line["code"]]).at(-1), ["gave_up", "not_auto"]);
});
