import { OrderAction, OrderType, TimeInForce } from "@stoqey/ib";
import type { Order } from "@stoqey/ib";
import type { OrderConfig } from "./config.js";
import { BridgeError } from "./errors.js";

/** Guards the comparisons against binary floating point (1.15 / 0.01 is 114.99999999999999). */
const EPS = 1e-9;

/** How many times `stopPct` an alert's own stop may sit under the limit and still be used. */
export const ALERT_STOP_MAX_MULTIPLE = 3;

/** US stocks trade in cents from $1 up and in hundredths of a cent below $1. */
function roundToTick(price: number, mode: "nearest" | "down" | "up"): number {
  const scale = price >= 1 - EPS ? 100 : 10000;
  // The small nudge keeps a price that is on a tick on it (1.15 * 100 is 114.99999999999999).
  if (mode === "up") return Math.ceil(price * scale - 1e-6) / scale;
  const ticks = price * scale + 1e-6;
  return (mode === "down" ? Math.floor(ticks) : Math.round(ticks)) / scale;
}

export function roundNearest(price: number): number {
  return roundToTick(price, "nearest");
}

export function roundDown(price: number): number {
  return roundToTick(price, "down");
}

export function roundUp(price: number): number {
  return roundToTick(price, "up");
}

/**
 * How a buy enters: "now" is a limit buy at the alert (or the ask) plus `limitOffsetPct`; "stop"
 * is a stop-limit buy that waits above the alert's price and fills only if the price gets there.
 */
export type Entry = "now" | "stop";

/** When a stop entry placed at `nowMs` stops waiting: `validSec` later, on a whole second (IB's time has no fractions). */
export function stopEntryGoodUntil(nowMs: number, validSec: number): number {
  return Math.floor((nowMs + validSec * 1000) / 1000) * 1000;
}

/** An instant in the IB API's UTC form, `YYYYMMDD-HH:MM:SS`: what `goodTillDate` carries. */
export function ibUtcDateTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
  );
}

/** The refusal of a stop entry while `entryStopPct` is 0. */
export function stopEntryOff(): BridgeError {
  return new BridgeError(409, "stop_entry_off", "stop entries are switched off: order.entryStopPct is 0 in config.json");
}

export function formatPrice(price: number): string {
  return price >= 1 ? price.toFixed(2) : price.toFixed(4);
}

export function formatPct(pct: number): string {
  return `${Number(pct.toFixed(2))}%`;
}

/** How an order's quantity was arrived at: so many dollars' worth (`amountUsd`), or a number of shares. */
export interface Sizing {
  mode: "usd" | "shares";
  /** The dollars the quantity was worked out from; only with `mode: "usd"`. */
  amount_usd?: number;
}

/** Dollars without needless cents: "$400", "$412.50". */
export function formatUsd(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

export interface PlanInput {
  /**
   * The quantity the click itself named, or null. Without one the order is sized by the config:
   * `amountUsd` dollars' worth when that is above 0, else `qty` shares.
   */
  qty: number | null;
  alertPrice: number;
  /** The stop the alert itself carries, when it has one. */
  alertStop: number | null;
  /** TWS's ask at the click; needed only with `priceFrom: "ask"` (and never for a stop entry). */
  ask: number | null;
  /** "now" when not given. */
  entry?: Entry;
}

export interface OrderPlan {
  entry: Entry;
  qty: number;
  sizing: Sizing;
  /** The buy's limit. For a stop entry, the limit of the stop-limit buy: the most it pays once triggered. */
  limit: number;
  /** A stop entry's trigger (the buy's stop price); null for a buy now. */
  trigger: number | null;
  takeProfit: number | null;
  stop: number | null;
  stopLimit: number | null;
  /** qty × limit, in dollars. */
  notional: number;
  priceFrom: "alert" | "ask";
  /** The price the limit (a stop entry: the trigger) was worked out from: the alert's price or the ask. */
  basePrice: number;
  /**
   * How far the limit sits above the alert's price, in percent (negative when below). For a stop
   * entry it is only said: `maxChasePct` does not apply to one.
   */
  chasePct: number;
  stopFrom: "alert" | "pct" | null;
  /** Why the alert's own stop was not used, when one was given and ignored. */
  alertStopIgnored: string | null;
}

function refuse(code: string, message: string): BridgeError {
  return new BridgeError(422, code, message);
}

/**
 * Works out every price of the bracket from the config and the alert. Nothing here comes from the
 * web page except the alert's price, the alert's stop, the quantity and how to enter.
 *
 * A buy now is a limit at the alert's price (or the ask) + `limitOffsetPct`, capped by
 * `maxChasePct`. A stop entry is priced from the alert alone: the trigger is the alert's price +
 * `entryStopPct` (nearest tick), its limit the trigger + `entryStopLimitPct` (rounded up, so never
 * under the trigger), and `maxChasePct` does not apply (the two settings are its distance from the
 * alert). The exits are measured from the price the buy is expected to fill at: the limit of a buy
 * now, the trigger of a stop entry. Dollars are turned into shares at the limit either way, the
 * most a share can cost.
 */
export function planOrder(cfg: OrderConfig, input: PlanInput): OrderPlan {
  const { alertPrice, alertStop } = input;
  const entry = input.entry ?? "now";

  let basePrice = alertPrice;
  let priceFrom = cfg.priceFrom;
  let trigger: number | null = null;
  let limit: number;
  if (entry === "stop") {
    if (!(cfg.entryStopPct > 0)) throw stopEntryOff();
    priceFrom = "alert";
    trigger = roundNearest(alertPrice * (1 + cfg.entryStopPct / 100));
    if (!(trigger > alertPrice + EPS)) {
      throw refuse(
        "bad_prices",
        `the stop entry's trigger, ${formatPct(cfg.entryStopPct)} above the alert's ${formatPrice(alertPrice)}, ` +
          `rounds to ${formatPrice(trigger)}: not above the alert`,
      );
    }
    limit = roundUp(trigger * (1 + cfg.entryStopLimitPct / 100));
    if (!(limit >= trigger - EPS)) {
      throw refuse("bad_prices", `the stop entry's limit (${formatPrice(limit)}) is under its trigger (${formatPrice(trigger)})`);
    }
  } else {
    if (cfg.priceFrom === "ask") {
      if (input.ask === null || !(input.ask > 0)) throw refuse("no_ask", "no ask price to work from");
      basePrice = input.ask;
    }
    limit = roundNearest(basePrice * (1 + cfg.limitOffsetPct / 100));
    if (!(limit > 0)) throw refuse("bad_prices", "the buy limit rounds to zero");
  }

  const chasePct = (limit / alertPrice - 1) * 100;
  if (entry === "now" && chasePct > cfg.maxChasePct + EPS) {
    throw refuse(
      "chase",
      `price has run ${chasePct.toFixed(1)}% past the alert ` +
        `(limit ${formatPrice(limit)} against the alert's ${formatPrice(alertPrice)}; maxChasePct is ${cfg.maxChasePct})`,
    );
  }

  // The quantity. Dollars are turned into shares at the limit the order will carry, rounded
  // down, so the order can never cost more than the amount.
  let qty: number;
  let sizing: Sizing;
  if (input.qty !== null) {
    qty = input.qty;
    sizing = { mode: "shares" };
  } else if (cfg.amountUsd > 0) {
    qty = Math.floor(cfg.amountUsd / limit + EPS);
    sizing = { mode: "usd", amount_usd: cfg.amountUsd };
    if (qty < 1) {
      throw refuse(
        "too_expensive",
        `one share at ${formatPrice(limit)} costs more than the ${formatUsd(cfg.amountUsd)} of an order (amountUsd)`,
      );
    }
  } else {
    qty = cfg.qty;
    sizing = { mode: "shares" };
  }

  // The price the exits are measured from, and its name in the texts.
  const from = trigger ?? limit;
  const fromWord = trigger === null ? "limit" : "trigger";

  let takeProfit: number | null = null;
  if (cfg.takeProfitPct > 0) {
    takeProfit = roundNearest(from * (1 + cfg.takeProfitPct / 100));
    // Above the most the buy can pay, also for a stop entry (whose limit is above its trigger).
    if (!(takeProfit > limit)) {
      throw refuse(
        "bad_prices",
        `after rounding, the take-profit (${formatPrice(takeProfit)}) is not above the ` +
          `${trigger === null ? "limit" : "buy's limit"} (${formatPrice(limit)})`,
      );
    }
  }

  let stop: number | null = null;
  let stopFrom: "alert" | "pct" | null = null;
  let alertStopIgnored: string | null = null;
  if (alertStop !== null) {
    if (!cfg.useAlertStop) {
      alertStopIgnored = "useAlertStop is off";
    } else {
      const candidate = roundDown(alertStop);
      const maxAwayPct = ALERT_STOP_MAX_MULTIPLE * cfg.stopPct;
      const awayPct = ((from - candidate) / from) * 100;
      if (!(candidate < from)) {
        alertStopIgnored = `it (${formatPrice(candidate)}) is not below the ${fromWord} (${formatPrice(from)})`;
      } else if (awayPct > maxAwayPct + EPS) {
        alertStopIgnored =
          `it (${formatPrice(candidate)}) is ${formatPct(awayPct)} under the ${fromWord}, ` +
          `more than ${ALERT_STOP_MAX_MULTIPLE} × stopPct (${formatPct(maxAwayPct)})`;
      } else {
        stop = candidate;
        stopFrom = "alert";
      }
    }
  }
  if (stop === null && cfg.stopPct > 0) {
    stop = roundDown(from * (1 - cfg.stopPct / 100));
    stopFrom = "pct";
  }

  let stopLimit: number | null = null;
  if (stop !== null) {
    if (!(stop > 0) || !(stop < from)) {
      throw refuse(
        "bad_prices",
        `after rounding, the stop (${formatPrice(stop)}) is not below the ${fromWord} (${formatPrice(from)})`,
      );
    }
    stopLimit = roundDown(stop * (1 - cfg.stopLimitOffsetPct / 100));
    if (!(stopLimit > 0) || stopLimit > stop) {
      throw refuse("bad_prices", `the stop's own limit (${formatPrice(stopLimit)}) is not usable`);
    }
  }

  return {
    entry,
    qty,
    sizing,
    limit,
    trigger,
    takeProfit,
    stop,
    stopLimit,
    notional: Math.round(qty * limit * 100) / 100,
    priceFrom,
    basePrice,
    chasePct,
    stopFrom,
    alertStopIgnored,
  };
}

/** The prices of a bracket as they stand: what a chase starts from and what it changes. */
export interface BracketPrices {
  limit: number;
  takeProfit: number | null;
  stop: number | null;
  stopLimit: number | null;
}

export interface ChaseInput {
  /** TWS's ask at the click. */
  ask: number;
  /** The price of the alert the order was placed for: the chase cap is measured against it. */
  alertPrice: number;
  /** The bracket's prices now. */
  current: BracketPrices;
  /** Where the stop came from when the order was placed. */
  stopFrom: "alert" | "pct" | null;
}

export interface ChasePlan extends BracketPrices {
  /** How far the new limit sits above the alert's price, in percent. */
  chasePct: number;
}

/**
 * The prices of a bracket after a chase: the buy limit moves up to the ask plus `limitOffsetPct`,
 * and the exits move with it so the bracket keeps its distances.
 *
 * - The cap is the one a new order has: no further than `maxChasePct` above the alert's price.
 * - A chase only ever moves the limit up: a new limit at or under the current one is refused.
 * - The take-profit is worked out again from the new limit.
 * - The stop is worked out again from the new limit when it came from `stopPct`. A stop that
 *   came from the alert stays where it is: it marks a price on the chart, not a distance.
 * - A leg whose percentage is 0 in the config now stays where it is.
 */
export function planChase(cfg: OrderConfig, input: ChaseInput): ChasePlan {
  const { ask, alertPrice, current } = input;
  if (!(ask > 0)) throw refuse("no_ask", "no ask price to work from");

  const limit = roundNearest(ask * (1 + cfg.limitOffsetPct / 100));
  const from = `the ask ${formatPrice(ask)} + ${formatPct(cfg.limitOffsetPct)}`;
  const chasePct = (limit / alertPrice - 1) * 100;
  if (chasePct > cfg.maxChasePct + EPS) {
    throw refuse("chase", `${from} is ${chasePct.toFixed(1)}% past the alert (the limit is ${formatPct(cfg.maxChasePct)})`);
  }
  if (!(limit > current.limit + EPS)) {
    throw new BridgeError(409, "no_change", `the limit ${formatPrice(current.limit)} is already at or above ${from}`);
  }

  let takeProfit = current.takeProfit;
  if (takeProfit !== null) {
    if (cfg.takeProfitPct > 0) takeProfit = roundNearest(limit * (1 + cfg.takeProfitPct / 100));
    if (!(takeProfit > limit)) {
      throw refuse(
        "bad_prices",
        `the take-profit (${formatPrice(takeProfit)}) would not be above the new limit (${formatPrice(limit)})`,
      );
    }
  }

  let stop = current.stop;
  let stopLimit = current.stopLimit;
  if (stop !== null) {
    if (input.stopFrom === "pct" && cfg.stopPct > 0) {
      stop = roundDown(limit * (1 - cfg.stopPct / 100));
      stopLimit = roundDown(stop * (1 - cfg.stopLimitOffsetPct / 100));
    }
    if (!(stop > 0) || !(stop < limit)) {
      throw refuse("bad_prices", `the stop (${formatPrice(stop)}) would not be below the new limit (${formatPrice(limit)})`);
    }
    if (stopLimit === null || !(stopLimit > 0) || stopLimit > stop) {
      throw refuse("bad_prices", "the stop's own limit is not usable");
    }
  }

  return { limit, takeProfit, stop, stopLimit, chasePct };
}

/**
 * The limit of a `/sell`: the bid less `sellOffsetPct`, rounded down to the tick. It is a
 * marketable limit: it should fill at the bid, and the limit is the worst price accepted.
 */
export function sellLimit(cfg: OrderConfig, bid: number): number {
  if (!(bid > 0)) throw refuse("no_bid", "no bid price to work from");
  const limit = roundDown(bid * (1 - cfg.sellOffsetPct / 100));
  if (!(limit > 0)) throw refuse("bad_prices", `the sell limit under the bid ${formatPrice(bid)} rounds to zero`);
  return limit;
}

export type LegName = "parent" | "take_profit" | "stop";

export interface BracketLeg {
  leg: LegName;
  orderId: number;
  order: Order;
}

// The three orders of a bracket, and the plain sell. Each is built in one place, so a change
// sent to an order later is that same order again with only its price (and `transmit`) different.
// The library sends a missing `transmit` as an empty field, so every order sets it.

export function buyOrder(qty: number, limit: number, outsideRth: boolean, transmit: boolean): Order {
  return {
    action: OrderAction.BUY,
    orderType: OrderType.LMT,
    totalQuantity: qty,
    lmtPrice: limit,
    tif: TimeInForce.DAY,
    outsideRth,
    parentId: 0,
    transmit,
  };
}

/**
 * A stop entry's buy: a stop-limit that triggers at `trigger` and then buys at no more than
 * `limit`. It is good till `goodTillDate` (IB's UTC form, `YYYYMMDD-HH:MM:SS`): IB cancels it
 * itself then, so nothing in the bridge times it.
 */
export function stopBuyOrder(
  qty: number,
  trigger: number,
  limit: number,
  outsideRth: boolean,
  goodTillDate: string,
  transmit: boolean,
): Order {
  return {
    action: OrderAction.BUY,
    orderType: OrderType.STP_LMT,
    totalQuantity: qty,
    auxPrice: trigger,
    lmtPrice: limit,
    tif: TimeInForce.GTD,
    goodTillDate,
    outsideRth,
    parentId: 0,
    transmit,
  };
}

export function takeProfitOrder(qty: number, price: number, outsideRth: boolean, parentId: number, transmit: boolean): Order {
  return {
    action: OrderAction.SELL,
    orderType: OrderType.LMT,
    totalQuantity: qty,
    lmtPrice: price,
    tif: TimeInForce.GTC,
    outsideRth,
    parentId,
    transmit,
  };
}

export function stopOrder(
  qty: number,
  stop: number,
  stopLimit: number,
  outsideRth: boolean,
  parentId: number,
  transmit: boolean,
): Order {
  return {
    action: OrderAction.SELL,
    orderType: OrderType.STP_LMT,
    totalQuantity: qty,
    auxPrice: stop,
    lmtPrice: stopLimit,
    tif: TimeInForce.GTC,
    outsideRth,
    parentId,
    transmit,
  };
}

/** The order a `/sell` places when the bracket's exits are gone: a plain sell limit for the day. */
export function sellOrder(qty: number, limit: number, outsideRth: boolean): Order {
  return {
    action: OrderAction.SELL,
    orderType: OrderType.LMT,
    totalQuantity: qty,
    lmtPrice: limit,
    tif: TimeInForce.DAY,
    outsideRth,
    parentId: 0,
    transmit: true,
  };
}

/**
 * The orders of one bracket, in the order they must be sent. Three consecutive ids are always
 * set aside (parent, take-profit, stop), also when a leg is switched off.
 *
 * `transmit` is false on every leg but the last: TWS holds the earlier ones and sends the whole
 * bracket when the last arrives, so a bracket never goes out without its exits.
 *
 * The buy of a stop entry is a stop-limit good till `goodTillDate`; the exits are the same either way.
 */
export function buildBracket(
  plan: OrderPlan,
  firstOrderId: number,
  outsideRth: boolean,
  goodTillDate: string | null = null,
): BracketLeg[] {
  const hasTakeProfit = plan.takeProfit !== null;
  const hasStop = plan.stop !== null && plan.stopLimit !== null;
  const transmitBuy = !hasTakeProfit && !hasStop;

  let buy: Order;
  if (plan.entry === "stop") {
    if (plan.trigger === null || goodTillDate === null) throw new Error("a stop entry needs its trigger and the time it is good till");
    buy = stopBuyOrder(plan.qty, plan.trigger, plan.limit, outsideRth, goodTillDate, transmitBuy);
  } else {
    buy = buyOrder(plan.qty, plan.limit, outsideRth, transmitBuy);
  }
  const legs: BracketLeg[] = [{ leg: "parent", orderId: firstOrderId, order: buy }];

  if (plan.takeProfit !== null) {
    legs.push({
      leg: "take_profit",
      orderId: firstOrderId + 1,
      order: takeProfitOrder(plan.qty, plan.takeProfit, outsideRth, firstOrderId, !hasStop),
    });
  }

  if (plan.stop !== null && plan.stopLimit !== null) {
    legs.push({
      leg: "stop",
      orderId: firstOrderId + 2,
      order: stopOrder(plan.qty, plan.stop, plan.stopLimit, outsideRth, firstOrderId, true),
    });
  }

  return legs;
}
