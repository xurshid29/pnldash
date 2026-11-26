import { OrderAction, OrderType, TimeInForce } from "@stoqey/ib";
import type { Order } from "@stoqey/ib";
import type { OrderConfig } from "./config.js";
import { BridgeError } from "./errors.js";

/** Guards the comparisons against binary floating point (1.15 / 0.01 is 114.99999999999999). */
const EPS = 1e-9;

/** How many times `stopPct` an alert's own stop may sit under the limit and still be used. */
export const ALERT_STOP_MAX_MULTIPLE = 3;

/** US stocks trade in cents from $1 up and in hundredths of a cent below $1. */
function roundToTick(price: number, mode: "nearest" | "down"): number {
  const scale = price >= 1 - EPS ? 100 : 10000;
  const ticks = price * scale + 1e-6;
  return (mode === "down" ? Math.floor(ticks) : Math.round(ticks)) / scale;
}

export function roundNearest(price: number): number {
  return roundToTick(price, "nearest");
}

export function roundDown(price: number): number {
  return roundToTick(price, "down");
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
  /** TWS's ask at the click; needed only with `priceFrom: "ask"`. */
  ask: number | null;
}

export interface OrderPlan {
  qty: number;
  sizing: Sizing;
  limit: number;
  takeProfit: number | null;
  stop: number | null;
  stopLimit: number | null;
  /** qty × limit, in dollars. */
  notional: number;
  priceFrom: "alert" | "ask";
  /** The price the limit was worked out from: the alert's price or the ask. */
  basePrice: number;
  /** How far the limit sits above the alert's price, in percent (negative when below). */
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
 * web page except the alert's price, the alert's stop and the quantity.
 */
export function planOrder(cfg: OrderConfig, input: PlanInput): OrderPlan {
  const { alertPrice, alertStop } = input;

  let basePrice = alertPrice;
  if (cfg.priceFrom === "ask") {
    if (input.ask === null || !(input.ask > 0)) throw refuse("no_ask", "no ask price to work from");
    basePrice = input.ask;
  }

  const limit = roundNearest(basePrice * (1 + cfg.limitOffsetPct / 100));
  if (!(limit > 0)) throw refuse("bad_prices", "the buy limit rounds to zero");

  const chasePct = (limit / alertPrice - 1) * 100;
  if (chasePct > cfg.maxChasePct + EPS) {
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

  let takeProfit: number | null = null;
  if (cfg.takeProfitPct > 0) {
    takeProfit = roundNearest(limit * (1 + cfg.takeProfitPct / 100));
    if (!(takeProfit > limit)) {
      throw refuse(
        "bad_prices",
        `after rounding, the take-profit (${formatPrice(takeProfit)}) is not above the limit (${formatPrice(limit)})`,
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
      const awayPct = ((limit - candidate) / limit) * 100;
      if (!(candidate < limit)) {
        alertStopIgnored = `it (${formatPrice(candidate)}) is not below the limit (${formatPrice(limit)})`;
      } else if (awayPct > maxAwayPct + EPS) {
        alertStopIgnored =
          `it (${formatPrice(candidate)}) is ${formatPct(awayPct)} under the limit, ` +
          `more than ${ALERT_STOP_MAX_MULTIPLE} × stopPct (${formatPct(maxAwayPct)})`;
      } else {
        stop = candidate;
        stopFrom = "alert";
      }
    }
  }
  if (stop === null && cfg.stopPct > 0) {
    stop = roundDown(limit * (1 - cfg.stopPct / 100));
    stopFrom = "pct";
  }

  let stopLimit: number | null = null;
  if (stop !== null) {
    if (!(stop > 0) || !(stop < limit)) {
      throw refuse(
        "bad_prices",
        `after rounding, the stop (${formatPrice(stop)}) is not below the limit (${formatPrice(limit)})`,
      );
    }
    stopLimit = roundDown(stop * (1 - cfg.stopLimitOffsetPct / 100));
    if (!(stopLimit > 0) || stopLimit > stop) {
      throw refuse("bad_prices", `the stop's own limit (${formatPrice(stopLimit)}) is not usable`);
    }
  }

  return {
    qty,
    sizing,
    limit,
    takeProfit,
    stop,
    stopLimit,
    notional: Math.round(qty * limit * 100) / 100,
    priceFrom: cfg.priceFrom,
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
 */
export function buildBracket(plan: OrderPlan, firstOrderId: number, outsideRth: boolean): BracketLeg[] {
  const hasTakeProfit = plan.takeProfit !== null;
  const hasStop = plan.stop !== null && plan.stopLimit !== null;

  const legs: BracketLeg[] = [
    {
      leg: "parent",
      orderId: firstOrderId,
      order: buyOrder(plan.qty, plan.limit, outsideRth, !hasTakeProfit && !hasStop),
    },
  ];

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
