import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { AutoTrader } from "../src/auto.js";
import type { AutoDecision, FeedLike } from "../src/auto.js";
import type { OrderRecord } from "../src/book.js";
import type { FeedSetup, FeedStatus } from "../src/feed.js";
import type { Journal, JournalFields } from "../src/journal.js";
import type { AutoMode, BridgeState } from "../src/state.js";
import { listing, until } from "./fake-tws.js";
import type { FakeIb, FakeTws } from "./fake-tws.js";
import { buy, rig } from "./harness.js";
import type { Rig, RigOptions } from "./harness.js";

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

// ------------------------------------------------------------- the automation
//
// Its hour is 04:00 up to 05:00 New York. W0 is the middle of it on the test day (EST, UTC−5).
// The default buy for an alert at 2.50: BUY STP LMT 150 shares ($400 at the limit), trigger 2.63
// (+5%), limit 2.66 (+1%, up), take-profit 3.16 (+20% of the trigger), stop 2.36 (−10%, down) with
// its limit 2.28 (−3%, down), good till 300 s after it was placed.

/** 2026-11-25 04:30 in New York (EST, UTC−5): the middle of the automation's hour. */
export const W0 = Date.parse("2026-11-25T09:30:00Z");

/** Where the dashboard says the alerts are, as state.json keeps it. */
export const FEED = { server: "https://pnldash.uz", token: "feed-token-3f9a1c0d5e7b2a4c" } as const;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * A journal that keeps every line exactly as it was given (it never replaces a secret, unlike
 * FileJournal and MemoryJournal) and what was asked of it, in order: to show that a secret is
 * never written at all, and that the journal was told about it before the first line.
 */
export class RecordingJournal implements Journal {
  readonly lines: JournalFields[] = [];
  readonly steps: string[] = [];
  readonly secrets: string[] = [];

  write(type: string, fields: JournalFields = {}): void {
    this.steps.push(`write ${type}`);
    this.lines.push(JSON.parse(JSON.stringify({ type, ...fields })) as JournalFields);
  }

  writeOrThrow(type: string, fields: JournalFields = {}): void {
    this.write(type, fields);
  }

  readDay(): JournalFields[] {
    return [];
  }

  addSecret(secret: string): void {
    this.steps.push("addSecret");
    this.secrets.push(secret);
  }

  ofType(type: string): JournalFields[] {
    return this.lines.filter((line) => line["type"] === type);
  }
}

/** More symbols the fake TWS knows, for tests that need many tickers at once (contract ids 601, 602, …). */
export const MORE_TICKERS = ["EEEE", "FFFF", "GGGG", "HHHH", "IIII"] as const;

export function knowMoreTickers(world: FakeTws): void {
  MORE_TICKERS.forEach((symbol, i) => world.contracts.set(symbol, [listing(symbol, 601 + i, "NASDAQ")]));
}

/** ABCD, WXYZ, QQQQ, PENY, then the extra ones: seven tickers, each its own contract. */
export const TICKERS = ["ABCD", "WXYZ", "QQQQ", "PENY", ...MORE_TICKERS] as const;

/** The alert feed, as the automation uses it: every start and stop is written down, and it says what it is told. */
export class FakeFeed implements FeedLike {
  readonly calls: Array<{ call: "start"; server: string; token: string } | { call: "stop" }> = [];
  /** What a start leaves it as. */
  startsAs: FeedStatus["state"] = "connected";
  current: FeedStatus = { state: "off", server: null, connected_at: null, last_event_at: null, error: null };

  start(server: string, token: string): void {
    this.calls.push({ call: "start", server, token });
    this.current = { state: this.startsAs, server, connected_at: null, last_event_at: null, error: null };
  }

  stop(): void {
    this.calls.push({ call: "stop" });
    this.current = { state: "off", server: null, connected_at: null, last_event_at: null, error: null };
  }

  status(): FeedStatus {
    return { ...this.current };
  }

  /** The calls in short: "start <server>" or "stop" (never the token). */
  words(): string[] {
    return this.calls.map((call) => (call.call === "start" ? `start ${call.server}` : "stop"));
  }
}

export interface AutoRigOptions extends RigOptions {
  /** The mode state.json holds at the start (default "on"). */
  mode?: AutoMode;
  /** Whether state.json already knows where the alerts are (default true). */
  paired?: boolean;
  /** What saving state.json does (default: a copy goes into `savedStates`). */
  saveState?: (state: BridgeState) => void;
}

export interface AutoRig extends Rig {
  auto: AutoTrader;
  feed: FakeFeed;
  /** The state the automation was handed, and keeps. */
  state: BridgeState;
  savedStates: BridgeState[];
  /** The journal the bridge and the automation both write: `options.journal`, or the rig's own. */
  log: Journal;
  /** Hands one alert to the automation and waits until it is decided: its decision, or undefined. */
  send(setup: FeedSetup): Promise<AutoDecision | undefined>;
}

/** A bridge on a fake TWS (as `rig`, at W0 unless told otherwise) with the automation over it, fed by hand. */
export async function autoRig(t: TestContext, options: AutoRigOptions = {}): Promise<AutoRig> {
  const r = await rig(t, { now: W0, ...options });
  const state: BridgeState = { auto: { mode: options.mode ?? "on" }, feed: options.paired === false ? null : { ...FEED } };
  const savedStates: BridgeState[] = [];
  const feed = new FakeFeed();
  const log = options.journal ?? r.journal;
  const auto = new AutoTrader({
    config: r.config,
    bridge: r.bridge,
    journal: log,
    state,
    saveState: options.saveState ?? ((next) => void savedStates.push(structuredClone(next))),
    feed: () => feed,
    clock: () => r.clock.now,
    say: (message) => void r.said.push(message),
  });
  t.after(() => auto.close());
  const send = async (setup: FeedSetup): Promise<AutoDecision | undefined> => {
    auto.onSetup(setup);
    await auto.idle();
    return auto.status().decisions.find((decision) => decision.alert_id === setup.id);
  };
  return { ...r, auto, feed, state, savedStates, log, send };
}

let popCount = 0;

/** A yellow POP as the feed hands it over: ABCD at 2.50, received at `at`, with a fresh id. */
export function pop(at: number, overrides: Partial<FeedSetup> = {}): FeedSetup {
  popCount += 1;
  return {
    id: `pop-${popCount}`,
    ticker: "ABCD",
    at: iso(at),
    stage: "pop",
    price: 2.5,
    mode: "notify",
    why: null,
    setup: { vol_x: 34.5, tv_rv1: 48210 },
    ...overrides,
  };
}

function recordOf(r: Rig, orderId: number): OrderRecord {
  const record = r.bridge.allOrders().find((order) => order.order_id === orderId);
  if (record === undefined) throw new Error(`order ${orderId} is not on the book`);
  return record;
}

/** TWS has taken a bracket: its buy works (a stop entry waits, PreSubmitted), its exits wait for it. */
export function taken(r: Rig, orderId: number): void {
  const record = recordOf(r, orderId);
  const ib = r.world.current;
  for (const id of [orderId, orderId + 1, orderId + 2]) ib.emit("orderStatus", id, "PreSubmitted", 0, record.sent.qty, 0);
}

/** A bracket's buy fills in full at `price`: the account holds the shares, the take-profit works and the stop waits. */
export function boughtAll(r: Rig, orderId: number, price = 2.64): void {
  const record = recordOf(r, orderId);
  const qty = record.sent.qty;
  const ib = r.world.current;
  r.world.positions.set(record.conid, (r.world.positions.get(record.conid) ?? 0) + qty);
  fill(ib, orderId, `buy-${orderId}`, qty, price, qty);
  ib.emit("orderStatus", orderId, "Filled", qty, 0, price);
  ib.emit("orderStatus", orderId + 1, "Submitted", 0, qty, 0);
  ib.emit("orderStatus", orderId + 2, "PreSubmitted", 0, qty, 0);
}

/** Part of a bracket's buy fills at `price`; the rest of it still works. */
export function boughtPart(r: Rig, orderId: number, shares: number, price = 2.64): void {
  const record = recordOf(r, orderId);
  const ib = r.world.current;
  r.world.positions.set(record.conid, (r.world.positions.get(record.conid) ?? 0) + shares);
  fill(ib, orderId, `buy-${orderId}`, shares, price, shares);
  ib.emit("orderStatus", orderId, "Submitted", shares, record.sent.qty - shares, price);
}

/** The take-profit sells all the order holds at `price`, and TWS cancels the stop with it. */
export function soldAtTarget(r: Rig, orderId: number, price?: number): void {
  const record = recordOf(r, orderId);
  const held = record.held_qty;
  const at = price ?? record.sent.take_profit ?? 0;
  const ib = r.world.current;
  r.world.positions.set(record.conid, Math.max(0, (r.world.positions.get(record.conid) ?? 0) - held));
  fill(ib, orderId + 1, `tp-${orderId}`, held, at, held);
  ib.emit("orderStatus", orderId + 1, "Filled", held, 0, at);
  ib.emit("orderStatus", orderId + 2, "Cancelled", 0, record.sent.qty, 0);
}

/** A waiting buy ends with nothing filled (cancelled, or expired at its time), and its exits with it. */
export function endedUnfilled(r: Rig, orderId: number): void {
  const record = recordOf(r, orderId);
  const ib = r.world.current;
  for (const id of [orderId, orderId + 1, orderId + 2]) ib.emit("orderStatus", id, "Cancelled", 0, record.sent.qty, 0);
}
