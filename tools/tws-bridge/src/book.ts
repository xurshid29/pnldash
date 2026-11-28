import type { JournalFields } from "./journal.js";
import type { ExecutionEvent, OrderStatusEvent } from "./link.js";
import type { Entry, LegName, Sizing } from "./order.js";
import { nyDate } from "./time.js";

export interface LegState {
  order_id: number;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
}

/** An order of a bracket, or the order a `/sell` placed for it. */
export type BookLeg = LegName | "exit";

/**
 * The sell a `/sell` click started, as `GET /orders` shows it. `status`, `filled_qty` and
 * `avg_fill_price` are those of the order doing the selling: the bracket's take-profit leg moved
 * down to the bid (`via: "take_profit"`), or a sell order of its own (`via: "new_order"`).
 */
export interface ExitState {
  via: "take_profit" | "new_order";
  /** The TWS order doing the selling. */
  order_id: number;
  /** The shares this sell is for. */
  qty: number;
  /** Its limit now, and the limit of the first click. */
  limit: number;
  first_limit: number;
  /** The bid read at the last click. */
  bid: number;
  /** How many times a later click moved the limit down. */
  reprices: number;
  sent_at: string;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
  /** The average sell against the buy's average fill, in percent: negative = sold lower. */
  exit_pct: number | null;
}

/** Who placed a bracket: a click on the dashboard, or the automation (`src/auto.ts`). */
export type OrderSource = "click" | "auto";

/**
 * What the automation's exit watch has seen on an order it placed and is acting on: the
 * take-profit's price was traded without the take-profit filling, or the stop is due and has not
 * sold everything. From then on the watch sells at the bid until the order holds nothing.
 */
export interface ExitWatchState {
  state: "tp_crossed" | "stop_due";
  /** When it was first seen (ISO). */
  since: string;
  /** How many sells (the first and every move lower) the watch has sent. */
  sells: number;
  /** Why its last sell did not go out, when it did not; null otherwise. */
  last_error: string | null;
}

/** One bracket as `GET /orders` shows it. `order_id` is the parent's (the buy's) id. */
export interface OrderRecord {
  order_id: number;
  ticker: string;
  conid: number;
  placed_at: string;
  /** "click": placed from the dashboard. "auto": placed by the automation, which also watches its exits. */
  source: OrderSource;
  /** What the dashboard asked for. */
  asked: {
    alert_price: number;
    alert_stop: number | null;
    qty: number | null;
    stage: string | null;
    alert_at: string | null;
    alert_id: string | null;
  };
  /** How the quantity was arrived at: `amountUsd` dollars' worth, or a number of shares. */
  sizing: Sizing;
  /** "now": a limit buy. "stop": a stop-limit buy that waits above the alert's price until `sent.good_until`. */
  entry: Entry;
  /**
   * What went to TWS. The prices are the current ones: a chase, a sell through the take-profit
   * leg, and TWS's own report of an order (after a change made by hand in TWS, too) move them.
   * The `first_` ones are the prices the bracket was placed with.
   */
  sent: {
    qty: number;
    /** The buy's limit; for a stop entry, the most it pays once triggered. */
    limit: number;
    /** A stop entry's trigger (its stop price); null for a buy now. */
    trigger: number | null;
    /** A stop entry's end (ISO time): IB cancels it then if nothing has filled. Null for a buy now. */
    good_until: string | null;
    take_profit: number | null;
    stop: number | null;
    stop_limit: number | null;
    first_limit: number;
    first_take_profit: number | null;
    first_stop: number | null;
    first_stop_limit: number | null;
    price_from: "alert" | "ask";
    stop_from: "alert" | "pct" | null;
    outside_rth: boolean;
    order_ids: { parent: number; take_profit: number | null; stop: number | null };
  };
  /** How many `/chase` clicks moved this buy. */
  chases: number;
  /**
   * The buy's status, in TWS's words (PendingSubmit, PreSubmitted, Submitted, Filled, Cancelled,
   * Inactive, ...). "Inactive" is also what the bridge sets itself for a buy that never went out
   * or that TWS says it does not have.
   */
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
  /** The average fill against the alert's price, in percent: positive = paid more than the alert. */
  slip_pct: number | null;
  /** Shares bought by this order and not sold yet by its legs or a `/sell`: what `/sell` would sell. */
  held_qty: number;
  legs: { take_profit: LegState | null; stop: LegState | null };
  /** The last `/sell` of this order; null until one is clicked. */
  exit: ExitState | null;
  /**
   * True while the order holds nothing any more and a sell order of its own (an exit of the
   * bracket, or a `/sell` order) is still working in TWS after the grace period: the bridge has
   * asked TWS to cancel it, and TWS has not confirmed yet. Such an order could open a short.
   */
  loose_exit: boolean;
  /** The automation's exit watch on this order, once it has something to act on; null before that and for a clicked order. */
  watch: ExitWatchState | null;
  /** The last message from TWS that stopped the order or a leg, or refused a change to one. */
  error: string | null;
  /** The last warning or notice from TWS about the order. */
  note: string | null;
}

/** Prices (and the quantity) of a bracket to set on the book; a missing key is left as it is. */
export interface PriceChange {
  qty?: number;
  limit?: number;
  /** A stop entry's trigger. */
  trigger?: number;
  take_profit?: number;
  stop?: number;
  stop_limit?: number;
}

/** Statuses after which an order can no longer fill. */
const DONE = new Set(["Filled", "Cancelled", "ApiCancelled", "Inactive"]);

export function isDone(status: string): boolean {
  return DONE.has(status);
}

/**
 * Does this order use up its alert? Only while it is still working, or once anything of it has
 * filled. An order that has ended with nothing filled frees its alert, whoever ended it: the
 * operator cancelled it (from the dashboard or in TWS), TWS refused it, or it never went out.
 *
 * "Ended" is a finished status, which TWS has confirmed or the bridge has set itself for a buy
 * TWS will never report on. `PendingCancel` is not one: until the cancel is confirmed the buy can
 * still fill.
 *
 * The dashboard decides whether an alert can be clicked again with the same rule
 * (`bridgeOrderCounts` in apps/web/src/api/twsBridge.ts): keep the two in step. The one thing
 * written out here that is implied there is that a `Filled` status counts even if no fill
 * quantity came with it.
 */
export function usesUpAlert(record: OrderRecord): boolean {
  return record.filled_qty > 0 || record.status === "Filled" || !isDone(record.status);
}

export function slipPct(avgFillPrice: number, alertPrice: number): number {
  return Math.round((avgFillPrice / alertPrice - 1) * 10000) / 100;
}

interface FillTally {
  execIds: Set<string>;
  qty: number;
  value: number;
}

interface Tracked {
  record: OrderRecord;
  placedMs: number;
  date: string;
  /** The buy's own state; copied onto the record's top-level fields after every change. */
  parent: LegState;
  /** Every sell order a `/sell` placed for this bracket, by its TWS order id. */
  exits: Map<number, LegState>;
  tallies: Map<number, FillTally>;
  /** The bridge has asked TWS to cancel this buy (`/cancel`, a `/sell` that had to, a clean-up). */
  cancelAsked: boolean;
  /** A stop entry that IB cancelled at its time with nothing filled: its note says so. */
  expired: boolean;
}

export interface LegRef {
  record: OrderRecord;
  leg: BookLeg;
  state: LegState;
}

/** Log lines that carry a new state of a bracket (`prices`, `chases`, `exit`, `error`, `note`) to put back at a start. */
const STATE_LINES = new Set(["chase", "chase_failed", "sell", "sell_failed", "change_refused", "order_open", "exit_cleanup"]);

/** The brackets this bridge has placed: kept in memory, rebuilt from the day's log at a start. */
export class OrderBook {
  private readonly byParent = new Map<number, Tracked>();
  private readonly byLeg = new Map<number, { parent: number; leg: BookLeg }>();

  add(record: OrderRecord, placedMs: number): void {
    const tracked: Tracked = {
      record,
      placedMs,
      date: nyDate(placedMs),
      parent: {
        order_id: record.order_id,
        status: record.status,
        filled_qty: record.filled_qty,
        avg_fill_price: record.avg_fill_price,
      },
      exits: new Map(),
      tallies: new Map(),
      cancelAsked: false,
      expired: false,
    };
    this.byParent.set(record.order_id, tracked);
    const ids = record.sent.order_ids;
    this.byLeg.set(ids.parent, { parent: record.order_id, leg: "parent" });
    if (ids.take_profit !== null) this.byLeg.set(ids.take_profit, { parent: record.order_id, leg: "take_profit" });
    if (ids.stop !== null) this.byLeg.set(ids.stop, { parent: record.order_id, leg: "stop" });
    this.refresh(tracked);
  }

  get(parentId: number): OrderRecord | undefined {
    return this.byParent.get(parentId)?.record;
  }

  /** The bracket with this parent id, if it was placed on that New York date. */
  getOn(date: string, parentId: number): OrderRecord | undefined {
    const tracked = this.byParent.get(parentId);
    return tracked !== undefined && tracked.date === date ? tracked.record : undefined;
  }

  /** The bracket and leg an order id of TWS belongs to, if it is one of ours. */
  findLeg(orderId: number): LegRef | undefined {
    const ref = this.byLeg.get(orderId);
    if (ref === undefined) return undefined;
    const tracked = this.byParent.get(ref.parent);
    if (tracked === undefined) return undefined;
    let state: LegState | null | undefined;
    if (ref.leg === "parent") state = tracked.parent;
    else if (ref.leg === "take_profit") state = tracked.record.legs.take_profit;
    else if (ref.leg === "stop") state = tracked.record.legs.stop;
    else state = tracked.exits.get(orderId);
    return state === null || state === undefined ? undefined : { record: tracked.record, leg: ref.leg, state };
  }

  /** Every bracket on the book, whatever day it was placed (its exits are good till cancelled). */
  all(): OrderRecord[] {
    return [...this.byParent.values()].map((tracked) => tracked.record);
  }

  /** The sell-side orders of a bracket: its take-profit, its stop, and every order a `/sell` placed for it. */
  sellOrders(parentId: number): Array<{ leg: BookLeg; state: LegState }> {
    const tracked = this.byParent.get(parentId);
    if (tracked === undefined) return [];
    const orders: Array<{ leg: BookLeg; state: LegState }> = [];
    const { take_profit: takeProfit, stop } = tracked.record.legs;
    if (takeProfit !== null) orders.push({ leg: "take_profit", state: takeProfit });
    if (stop !== null) orders.push({ leg: "stop", state: stop });
    for (const state of tracked.exits.values()) orders.push({ leg: "exit", state });
    return orders;
  }

  /** Notes that the bridge asked TWS to cancel this buy: when it then ends, it did not expire. */
  markCancelAsked(parentId: number): void {
    const tracked = this.byParent.get(parentId);
    if (tracked !== undefined) tracked.cancelAsked = true;
  }

  cancelAsked(parentId: number): boolean {
    return this.byParent.get(parentId)?.cancelAsked === true;
  }

  /** Notes that this stop entry expired unfilled (its `note` says when). */
  markExpired(parentId: number): void {
    const tracked = this.byParent.get(parentId);
    if (tracked !== undefined) tracked.expired = true;
  }

  isExpired(parentId: number): boolean {
    return this.byParent.get(parentId)?.expired === true;
  }

  /** The highest TWS order id of any leg on the book, or 0. */
  highestOrderId(): number {
    let highest = 0;
    for (const orderId of this.byLeg.keys()) highest = Math.max(highest, orderId);
    return highest;
  }

  /** Newest first. */
  ordersOn(date: string): OrderRecord[] {
    return [...this.byParent.values()]
      .filter((tracked) => tracked.date === date)
      .sort((a, b) => b.placedMs - a.placedMs || b.record.order_id - a.record.order_id)
      .map((tracked) => tracked.record);
  }

  /** How many brackets were placed on that New York date: all of them, or those of one source. */
  countOn(date: string, source?: OrderSource): number {
    const orders = this.ordersOn(date);
    return source === undefined ? orders.length : orders.filter((record) => record.source === source).length;
  }

  /** Every bracket on the book for this ticker that is still working or still holds shares, whatever day it is from. */
  openFor(ticker: string): OrderRecord[] {
    return this.all().filter((record) => record.ticker === ticker && (!isDone(record.status) || record.held_qty > 0));
  }

  filledOn(date: string): number {
    return this.ordersOn(date).filter((record) => record.filled_qty > 0).length;
  }

  /** The newest order of that New York date that carries this alert id and uses the alert up. */
  alertOrderOn(date: string, alertId: string): OrderRecord | undefined {
    return this.ordersOn(date).find((record) => record.asked.alert_id === alertId && usesUpAlert(record));
  }

  /** When this ticker was last ordered, in ms, or undefined. */
  lastPlacedMs(ticker: string): number | undefined {
    let last: number | undefined;
    for (const tracked of this.byParent.values()) {
      if (tracked.record.ticker === ticker && (last === undefined || tracked.placedMs > last)) last = tracked.placedMs;
    }
    return last;
  }

  /**
   * Shares of a contract that other brackets are selling right now through a `/sell` that has
   * not finished: they are still in the account's position, and they are spoken for.
   */
  claimedBySells(conid: number, exceptParentId: number): number {
    let claimed = 0;
    for (const { record } of this.byParent.values()) {
      if (record.order_id === exceptParentId || record.conid !== conid) continue;
      if (record.exit !== null && !isDone(record.exit.status)) claimed += record.held_qty;
    }
    return claimed;
  }

  /** Sets prices (and the quantity) of a bracket; a key that is not given, or whose leg does not exist, is left alone. */
  setPrices(parentId: number, change: PriceChange): void {
    const tracked = this.byParent.get(parentId);
    if (tracked === undefined) return;
    const { sent } = tracked.record;
    if (change.qty !== undefined) sent.qty = change.qty;
    if (change.limit !== undefined) sent.limit = change.limit;
    if (change.trigger !== undefined && sent.trigger !== null) sent.trigger = change.trigger;
    if (change.take_profit !== undefined && sent.take_profit !== null) sent.take_profit = change.take_profit;
    if (change.stop !== undefined && sent.stop !== null) sent.stop = change.stop;
    if (change.stop_limit !== undefined && sent.stop_limit !== null) sent.stop_limit = change.stop_limit;
  }

  /**
   * Sets the bracket's `/sell`. One through an order of its own makes that order a leg of the
   * bracket, so its status and fills are followed; an earlier sell order of the bracket stays
   * followed too, and what it sold stays counted.
   */
  setExit(parentId: number, exit: ExitState | null): void {
    const tracked = this.byParent.get(parentId);
    if (tracked === undefined) return;
    tracked.record.exit = exit;
    if (exit !== null && exit.via === "new_order" && !tracked.exits.has(exit.order_id) && !this.byLeg.has(exit.order_id)) {
      tracked.exits.set(exit.order_id, {
        order_id: exit.order_id,
        status: exit.status,
        filled_qty: exit.filled_qty,
        avg_fill_price: exit.avg_fill_price,
      });
      this.byLeg.set(exit.order_id, { parent: parentId, leg: "exit" });
    }
    this.refresh(tracked);
  }

  /** Applies a status report. Returns the leg when something changed, else null. */
  applyStatus(event: OrderStatusEvent): LegRef | null {
    const ref = this.findLeg(event.orderId);
    if (ref === undefined) return null;
    const { state } = ref;
    const filled = Number.isFinite(event.filled) ? Math.max(state.filled_qty, event.filled) : state.filled_qty;
    const avg = Number.isFinite(event.avgFillPrice) && event.avgFillPrice > 0 ? event.avgFillPrice : state.avg_fill_price;
    if (state.status === event.status && state.filled_qty === filled && state.avg_fill_price === avg) return null;
    state.status = event.status;
    state.filled_qty = filled;
    state.avg_fill_price = avg;
    this.refreshOf(ref);
    return ref;
  }

  /** Applies one fill. Returns the leg, or null for a fill already seen or not ours. */
  applyExecution(event: ExecutionEvent): LegRef | null {
    const ref = this.findLeg(event.orderId);
    if (ref === undefined) return null;
    const tracked = this.byParent.get(ref.record.order_id);
    if (tracked === undefined) return null;
    let tally = tracked.tallies.get(event.orderId);
    if (tally === undefined) {
      tally = { execIds: new Set(), qty: 0, value: 0 };
      tracked.tallies.set(event.orderId, tally);
    }
    if (tally.execIds.has(event.execId)) return null;
    tally.execIds.add(event.execId);
    tally.qty += event.shares;
    tally.value += event.shares * event.price;

    const cumQty = event.cumQty !== null && event.cumQty > 0 ? event.cumQty : tally.qty;
    const avgPrice = event.avgPrice !== null && event.avgPrice > 0 ? event.avgPrice : tally.value / tally.qty;
    if (cumQty >= ref.state.filled_qty) {
      ref.state.filled_qty = cumQty;
      ref.state.avg_fill_price = avgPrice;
    }
    this.refresh(tracked);
    return ref;
  }

  /** Rebuilds the day from its log lines, through the same code the live events go through. */
  restore(events: JournalFields[]): void {
    for (const event of events) {
      const type = event["type"];
      switch (type) {
        case "order_placed": {
          const record = recordFromJournal(event);
          const placedMs = record === null ? Number.NaN : Date.parse(record.placed_at);
          if (record !== null && Number.isFinite(placedMs) && !this.byParent.has(record.order_id)) {
            this.add(record, placedMs);
          }
          break;
        }
        case "order_status": {
          const orderId = event["leg_order_id"];
          const status = event["status"];
          if (typeof orderId !== "number" || typeof status !== "string") break;
          this.applyStatus({
            orderId,
            status,
            filled: num(event["filled"]) ?? 0,
            remaining: 0,
            avgFillPrice: num(event["avg_fill_price"]) ?? 0,
          });
          break;
        }
        case "fill": {
          const orderId = event["leg_order_id"];
          const execId = event["exec_id"];
          const shares = num(event["shares"]);
          const price = num(event["price"]);
          if (typeof orderId !== "number" || typeof execId !== "string" || shares === null || price === null) break;
          this.applyExecution({
            orderId,
            execId,
            shares,
            price,
            cumQty: num(event["cum_qty"]),
            avgPrice: num(event["avg_price"]),
            time: null,
          });
          break;
        }
        case "order_error":
        case "order_note": {
          const parent = event["order_id"];
          const message = event["message"];
          const record = typeof parent === "number" ? this.get(parent) : undefined;
          if (record === undefined || typeof message !== "string") break;
          if (type === "order_error") record.error = message;
          // A notice about the buy of a stop entry that expired does not take the place of the expiry.
          else if (!(event["leg"] === "parent" && this.isExpired(record.order_id))) record.note = message;
          break;
        }
        case "cancel":
        case "order_cleanup": {
          // A cancel the bridge asked for: of the buy (and with it the bracket), not of one exit.
          const parent = event["order_id"];
          if (typeof parent === "number" && !("leg" in event)) this.markCancelAsked(parent);
          break;
        }
        case "entry_expired": {
          const parent = event["order_id"];
          if (typeof parent === "number") this.markExpired(parent);
          this.restoreState(event);
          break;
        }
        default:
          if (typeof type === "string" && STATE_LINES.has(type)) this.restoreState(event);
          break;
      }
    }
  }

  /**
   * Puts back what a chase, a sell, a refused change or TWS's own report of an order did to a
   * bracket: each such log line carries the state it left behind (`prices`, `chases`, `exit`).
   */
  private restoreState(event: JournalFields): void {
    const parentId = event["order_id"];
    const record = typeof parentId === "number" ? this.get(parentId) : undefined;
    if (typeof parentId !== "number" || record === undefined) return;

    const prices = obj(event["prices"]);
    if (prices !== null) {
      const change: PriceChange = {};
      for (const key of ["qty", "limit", "trigger", "take_profit", "stop", "stop_limit"] as const) {
        const value = num(prices[key]);
        if (value !== null && value > 0) change[key] = value;
      }
      this.setPrices(parentId, change);
    }
    const chases = num(event["chases"]);
    if (chases !== null && Number.isInteger(chases) && chases >= 0) record.chases = chases;
    if ("exit" in event) {
      const exit = event["exit"] === null ? null : exitFromJournal(event["exit"]);
      if (exit !== undefined) this.setExit(parentId, exit);
    }
    const error = event["error"];
    if (typeof error === "string") record.error = error;
    const note = event["note"];
    if (typeof note === "string") record.note = note;
  }

  private refreshOf(ref: LegRef): void {
    const tracked = this.byParent.get(ref.record.order_id);
    if (tracked !== undefined) this.refresh(tracked);
  }

  /** Everything on the record that is worked out from the legs: the buy's numbers, what is held, the sell's. */
  private refresh(tracked: Tracked): void {
    const { record, parent } = tracked;
    record.status = parent.status;
    record.filled_qty = parent.filled_qty;
    record.avg_fill_price = parent.avg_fill_price;
    record.slip_pct =
      parent.avg_fill_price !== null && parent.filled_qty > 0
        ? slipPct(parent.avg_fill_price, record.asked.alert_price)
        : null;

    let sold = (record.legs.take_profit?.filled_qty ?? 0) + (record.legs.stop?.filled_qty ?? 0);
    for (const exit of tracked.exits.values()) sold += exit.filled_qty;
    record.held_qty = Math.max(0, parent.filled_qty - sold);

    const exit = record.exit;
    if (exit === null) return;
    const selling = exit.via === "take_profit" ? record.legs.take_profit : tracked.exits.get(exit.order_id);
    if (selling !== null && selling !== undefined) {
      exit.status = selling.status;
      exit.filled_qty = selling.filled_qty;
      exit.avg_fill_price = selling.avg_fill_price;
    }
    exit.exit_pct =
      exit.avg_fill_price !== null && exit.filled_qty > 0 && parent.avg_fill_price !== null && parent.avg_fill_price > 0
        ? slipPct(exit.avg_fill_price, parent.avg_fill_price)
        : null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function legFromJournal(value: unknown, orderId: number | null): LegState | null {
  if (orderId === null) return null;
  const leg = obj(value);
  return {
    order_id: orderId,
    status: str(leg?.["status"]) ?? "PendingSubmit",
    filled_qty: num(leg?.["filled_qty"]) ?? 0,
    avg_fill_price: num(leg?.["avg_fill_price"]),
  };
}

/** A line written before orders could be sized in dollars has no `sizing`: it was a number of shares. */
function sizingFromJournal(value: unknown): Sizing {
  const sizing = obj(value);
  const amount = num(sizing?.["amount_usd"]);
  return sizing?.["mode"] === "usd" && amount !== null ? { mode: "usd", amount_usd: amount } : { mode: "shares" };
}

/** Reads the `exit` of a log line back; undefined when it is not a whole one. */
export function exitFromJournal(value: unknown): ExitState | undefined {
  const exit = obj(value);
  if (exit === null) return undefined;
  const via = exit["via"];
  const orderId = num(exit["order_id"]);
  const qty = num(exit["qty"]);
  const limit = num(exit["limit"]);
  if ((via !== "take_profit" && via !== "new_order") || orderId === null || qty === null || limit === null) return undefined;
  return {
    via,
    order_id: orderId,
    qty,
    limit,
    first_limit: num(exit["first_limit"]) ?? limit,
    bid: num(exit["bid"]) ?? 0,
    reprices: num(exit["reprices"]) ?? 0,
    sent_at: str(exit["sent_at"]) ?? "",
    status: str(exit["status"]) ?? "PendingSubmit",
    filled_qty: num(exit["filled_qty"]) ?? 0,
    avg_fill_price: num(exit["avg_fill_price"]),
    exit_pct: num(exit["exit_pct"]),
  };
}

/** Reads an `order_placed` log line back into a record; null when the line is not a whole one. */
export function recordFromJournal(event: JournalFields): OrderRecord | null {
  const asked = obj(event["asked"]);
  const sent = obj(event["sent"]);
  const ids = obj(sent?.["order_ids"]);
  const legs = obj(event["legs"]);
  const orderId = num(event["order_id"]);
  const ticker = str(event["ticker"]);
  const placedAt = str(event["placed_at"]);
  const alertPrice = num(asked?.["alert_price"]);
  const qty = num(sent?.["qty"]);
  const limit = num(sent?.["limit"]);
  if (asked === null || sent === null || ids === null) return null;
  if (orderId === null || ticker === null || placedAt === null || alertPrice === null || qty === null || limit === null) {
    return null;
  }
  const takeProfitId = num(ids["take_profit"]);
  const stopId = num(ids["stop"]);
  const priceFrom = sent["price_from"] === "ask" ? "ask" : "alert";
  const stopFrom = sent["stop_from"] === "alert" || sent["stop_from"] === "pct" ? sent["stop_from"] : null;
  const takeProfit = num(sent["take_profit"]);
  const stop = num(sent["stop"]);
  const stopLimit = num(sent["stop_limit"]);
  // A line written before the bridge could chase has no `first_` prices: an order_placed line
  // holds the prices the bracket was placed with, so they are those.
  return {
    order_id: orderId,
    ticker,
    conid: num(event["conid"]) ?? 0,
    placed_at: placedAt,
    // A line written before the automation existed was a click.
    source: event["source"] === "auto" ? "auto" : "click",
    asked: {
      alert_price: alertPrice,
      alert_stop: num(asked["alert_stop"]),
      qty: num(asked["qty"]),
      stage: str(asked["stage"]),
      alert_at: str(asked["alert_at"]),
      alert_id: str(asked["alert_id"]),
    },
    sizing: sizingFromJournal(event["sizing"]),
    // A line written before stop entries existed is a buy now.
    entry: event["entry"] === "stop" ? "stop" : "now",
    sent: {
      qty,
      limit,
      trigger: num(sent["trigger"]),
      good_until: str(sent["good_until"]),
      take_profit: takeProfit,
      stop,
      stop_limit: stopLimit,
      first_limit: num(sent["first_limit"]) ?? limit,
      first_take_profit: num(sent["first_take_profit"]) ?? takeProfit,
      first_stop: num(sent["first_stop"]) ?? stop,
      first_stop_limit: num(sent["first_stop_limit"]) ?? stopLimit,
      price_from: priceFrom,
      stop_from: stopFrom,
      outside_rth: sent["outside_rth"] === true,
      order_ids: { parent: orderId, take_profit: takeProfitId, stop: stopId },
    },
    chases: num(event["chases"]) ?? 0,
    status: str(event["status"]) ?? "PendingSubmit",
    filled_qty: num(event["filled_qty"]) ?? 0,
    avg_fill_price: num(event["avg_fill_price"]),
    slip_pct: num(event["slip_pct"]),
    held_qty: 0,
    legs: {
      take_profit: legFromJournal(legs?.["take_profit"], takeProfitId),
      stop: legFromJournal(legs?.["stop"], stopId),
    },
    exit: null,
    // Not read back: it is about TWS now, and is found out again once TWS is connected.
    loose_exit: false,
    // Not read back either: the watch looks at the order afresh once TWS is connected.
    watch: null,
    error: str(event["error"]),
    note: str(event["note"]),
  };
}
