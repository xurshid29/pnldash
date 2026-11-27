import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { until } from "./fake-tws.js";
import type { FakeIb } from "./fake-tws.js";
import { buy } from "./harness.js";
import type { Rig } from "./harness.js";

// What TWS says in the scenes the chase and sell tests start from. The default bracket is the one
// every test file uses: alert 2.50 → buy 100 @ 2.53, take-profit 2.78, stop 2.40 / 2.37, with the
// order ids 1000 (buy), 1001 (take-profit) and 1002 (stop).

export const ABCD = { conId: 111, symbol: "ABCD", secType: "STK", exchange: "SMART", currency: "USD" };

export function tempDir(t: TestContext, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tws-bridge-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One fill, as TWS reports it. */
export function fill(ib: FakeIb, orderId: number, execId: string, shares: number, price: number, cumQty: number, avgPrice = price): void {
  ib.emit("execDetails", -1, { symbol: "ABCD" }, { orderId, execId, shares, price, cumQty, avgPrice, time: "20261125 10:00:01" });
}

/**
 * The bracket is placed and TWS has taken it: the buy works, the exits wait for it. A second has
 * passed since, so the next change to it is not "too soon".
 */
export async function working(r: Rig, overrides: Record<string, unknown> = {}): Promise<FakeIb> {
  const before = r.world.allPlaced().length;
  const pending = r.bridge.order(buy(overrides));
  // A rig with an ack wait answers /order when TWS has said its first word about the buy: TWS
  // says it as soon as the bracket is out, as the real one does.
  await Promise.race([
    pending.then(
      () => undefined,
      () => undefined,
    ),
    until(() => r.world.allPlaced().length > before, "the bracket").catch(() => undefined),
  ]);
  const ib = r.world.current;
  const buyOrder = r.world.allPlaced()[before];
  if (buyOrder !== undefined) ib.emit("orderStatus", buyOrder.id, "Submitted", 0, buyOrder.order.totalQuantity, 0);
  const placed = await pending;
  const id = placed.order_id;
  if (placed.take_profit !== null) ib.emit("orderStatus", id + 1, "PreSubmitted", 0, placed.qty, 0);
  if (placed.stop !== null) ib.emit("orderStatus", id + 2, "PreSubmitted", 0, placed.qty, 0);
  r.clock.now += 1000;
  return ib;
}

/** Part of the buy fills at 2.52: the account holds those shares, the rest of the buy still works. */
export async function partlyFilled(r: Rig, shares = 60, overrides: Record<string, unknown> = {}): Promise<FakeIb> {
  const ib = await working(r, overrides);
  fill(ib, 1000, "b1", shares, 2.52, shares);
  ib.emit("orderStatus", 1000, "Submitted", shares, 100 - shares, 2.52);
  r.world.positions.set(111, shares);
  return ib;
}

/** The whole buy fills at 2.52: the account holds 100 shares and both exits work. */
export async function filled(r: Rig, overrides: Record<string, unknown> = {}): Promise<FakeIb> {
  const ib = await working(r, overrides);
  const order = r.bridge.orders()[0];
  fill(ib, 1000, "b1", 100, 2.52, 100);
  ib.emit("orderStatus", 1000, "Filled", 100, 0, 2.52);
  if (order?.legs.take_profit) ib.emit("orderStatus", 1001, "Submitted", 0, 100, 0);
  r.world.positions.set(111, 100);
  return ib;
}

/**
 * A stop entry is placed and TWS has taken it: the buy waits for its trigger (TWS reports a stop
 * that has not triggered as PreSubmitted), the exits wait for the buy. A second has passed since.
 *
 * The default one: alert 2.50 → BUY STP LMT 100, trigger 2.58, limit 2.61, good till 10:05:00
 * New York (T0 + 300 s); take-profit 2.84, stop 2.45 / 2.42; ids 1000, 1001, 1002.
 */
export async function waitingStop(r: Rig, overrides: Record<string, unknown> = {}): Promise<FakeIb> {
  const placed = await r.bridge.order(buy({ entry: "stop", ...overrides }));
  const ib = r.world.current;
  const id = placed.order_id;
  ib.emit("orderStatus", id, "PreSubmitted", 0, placed.qty, 0);
  if (placed.take_profit !== null) ib.emit("orderStatus", id + 1, "PreSubmitted", 0, placed.qty, 0);
  if (placed.stop !== null) ib.emit("orderStatus", id + 2, "PreSubmitted", 0, placed.qty, 0);
  r.clock.now += 1000;
  return ib;
}

/** IB cancels a stop entry at its time with nothing filled, and its exits with it: `afterMs` past its end. */
export function expire(r: Rig, ib: FakeIb, orderId = 1000, afterMs = 400): void {
  const record = r.bridge.orders().find((order) => order.order_id === orderId);
  if (record === undefined || record.sent.good_until === null) throw new Error(`order ${orderId} is not a stop entry on the book`);
  r.clock.now = Date.parse(record.sent.good_until) + afterMs;
  for (const id of [orderId, orderId + 1, orderId + 2]) ib.emit("orderStatus", id, "Cancelled", 0, record.sent.qty, 0);
}

/** The changes sent so far, as `[order id, quantity, limit price, stop price]`. */
export function changes(ib: FakeIb): Array<[number, number | undefined, number | undefined, number | undefined]> {
  return ib.modified().map((sent) => [sent.id, sent.order.totalQuantity, sent.order.lmtPrice, sent.order.auxPrice]);
}
