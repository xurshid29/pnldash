import type { JournalFields } from "./journal.js";
import type { ExecutionEvent, OrderStatusEvent } from "./link.js";
import type { LegName } from "./order.js";
import { nyDate } from "./time.js";

export interface LegState {
  order_id: number;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
}

/** One bracket as `GET /orders` shows it. `order_id` is the parent's (the buy's) id. */
export interface OrderRecord {
  order_id: number;
  ticker: string;
  conid: number;
  placed_at: string;
  /** What the dashboard asked for. */
  asked: {
    alert_price: number;
    alert_stop: number | null;
    qty: number | null;
    stage: string | null;
    alert_at: string | null;
    alert_id: string | null;
  };
  /** What went to TWS. */
  sent: {
    qty: number;
    limit: number;
    take_profit: number | null;
    stop: number | null;
    stop_limit: number | null;
    price_from: "alert" | "ask";
    stop_from: "alert" | "pct" | null;
    outside_rth: boolean;
    order_ids: { parent: number; take_profit: number | null; stop: number | null };
  };
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
  legs: { take_profit: LegState | null; stop: LegState | null };
  /** The last message from TWS that stopped the order or one of its legs. */
  error: string | null;
  /** The last warning or notice from TWS about the order. */
  note: string | null;
}

/** Statuses after which the buy can no longer fill. */
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
  tallies: Map<number, FillTally>;
}

export interface LegRef {
  record: OrderRecord;
  leg: LegName;
  state: LegState;
}

/** The brackets this bridge has placed: kept in memory, rebuilt from the day's log at a start. */
export class OrderBook {
  private readonly byParent = new Map<number, Tracked>();
  private readonly byLeg = new Map<number, { parent: number; leg: LegName }>();

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
      tallies: new Map(),
    };
    this.byParent.set(record.order_id, tracked);
    const ids = record.sent.order_ids;
    this.byLeg.set(ids.parent, { parent: record.order_id, leg: "parent" });
    if (ids.take_profit !== null) this.byLeg.set(ids.take_profit, { parent: record.order_id, leg: "take_profit" });
    if (ids.stop !== null) this.byLeg.set(ids.stop, { parent: record.order_id, leg: "stop" });
  }

  get(parentId: number): OrderRecord | undefined {
    return this.byParent.get(parentId)?.record;
  }

  /** The bracket and leg an order id of TWS belongs to, if it is one of ours. */
  findLeg(orderId: number): LegRef | undefined {
    const ref = this.byLeg.get(orderId);
    if (ref === undefined) return undefined;
    const tracked = this.byParent.get(ref.parent);
    if (tracked === undefined) return undefined;
    const state =
      ref.leg === "parent"
        ? tracked.parent
        : ref.leg === "take_profit"
          ? tracked.record.legs.take_profit
          : tracked.record.legs.stop;
    return state === null ? undefined : { record: tracked.record, leg: ref.leg, state };
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

  countOn(date: string): number {
    return this.ordersOn(date).length;
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
    this.mirrorParent(ref);
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
    this.mirrorParent(ref);
    return ref;
  }

  /** Rebuilds the day from its log lines, through the same code the live events go through. */
  restore(events: JournalFields[]): void {
    for (const event of events) {
      switch (event["type"]) {
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
          if (event["type"] === "order_error") record.error = message;
          else record.note = message;
          break;
        }
        default:
          break;
      }
    }
  }

  private mirrorParent(ref: LegRef): void {
    if (ref.leg !== "parent") return;
    const { record, state } = ref;
    record.status = state.status;
    record.filled_qty = state.filled_qty;
    record.avg_fill_price = state.avg_fill_price;
    record.slip_pct =
      state.avg_fill_price !== null && state.filled_qty > 0
        ? slipPct(state.avg_fill_price, record.asked.alert_price)
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
  return {
    order_id: orderId,
    ticker,
    conid: num(event["conid"]) ?? 0,
    placed_at: placedAt,
    asked: {
      alert_price: alertPrice,
      alert_stop: num(asked["alert_stop"]),
      qty: num(asked["qty"]),
      stage: str(asked["stage"]),
      alert_at: str(asked["alert_at"]),
      alert_id: str(asked["alert_id"]),
    },
    sent: {
      qty,
      limit,
      take_profit: num(sent["take_profit"]),
      stop: num(sent["stop"]),
      stop_limit: num(sent["stop_limit"]),
      price_from: priceFrom,
      stop_from: stopFrom,
      outside_rth: sent["outside_rth"] === true,
      order_ids: { parent: orderId, take_profit: takeProfitId, stop: stopId },
    },
    status: str(event["status"]) ?? "PendingSubmit",
    filled_qty: num(event["filled_qty"]) ?? 0,
    avg_fill_price: num(event["avg_fill_price"]),
    slip_pct: num(event["slip_pct"]),
    legs: {
      take_profit: legFromJournal(legs?.["take_profit"], takeProfitId),
      stop: legFromJournal(legs?.["stop"], stopId),
    },
    error: str(event["error"]),
    note: str(event["note"]),
  };
}
