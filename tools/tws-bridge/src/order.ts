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

function formatPct(pct: number): string {
  return `${Number(pct.toFixed(2))}%`;
}

export interface PlanInput {
  qty: number;
  alertPrice: number;
  /** The stop the alert itself carries, when it has one. */
  alertStop: number | null;
  /** TWS's ask at the click; needed only with `priceFrom: "ask"`. */
  ask: number | null;
}

export interface OrderPlan {
  qty: number;
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
  const { qty, alertPrice, alertStop } = input;

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

export type LegName = "parent" | "take_profit" | "stop";

export interface BracketLeg {
  leg: LegName;
  orderId: number;
  order: Order;
}

/**
 * The orders of one bracket, in the order they must be sent. Three consecutive ids are always
 * set aside (parent, take-profit, stop), also when a leg is switched off.
 *
 * `transmit` is false on every leg but the last: TWS holds the earlier ones and sends the whole
 * bracket when the last arrives, so a bracket never goes out without its exits. The library sends
 * a missing `transmit` as an empty field, so every leg sets it.
 */
export function buildBracket(plan: OrderPlan, firstOrderId: number, outsideRth: boolean): BracketLeg[] {
  const hasTakeProfit = plan.takeProfit !== null;
  const hasStop = plan.stop !== null && plan.stopLimit !== null;

  const legs: BracketLeg[] = [
    {
      leg: "parent",
      orderId: firstOrderId,
      order: {
        action: OrderAction.BUY,
        orderType: OrderType.LMT,
        totalQuantity: plan.qty,
        lmtPrice: plan.limit,
        tif: TimeInForce.DAY,
        outsideRth,
        parentId: 0,
        transmit: !hasTakeProfit && !hasStop,
      },
    },
  ];

  if (plan.takeProfit !== null) {
    legs.push({
      leg: "take_profit",
      orderId: firstOrderId + 1,
      order: {
        action: OrderAction.SELL,
        orderType: OrderType.LMT,
        totalQuantity: plan.qty,
        lmtPrice: plan.takeProfit,
        tif: TimeInForce.GTC,
        outsideRth,
        parentId: firstOrderId,
        transmit: !hasStop,
      },
    });
  }

  if (plan.stop !== null && plan.stopLimit !== null) {
    legs.push({
      leg: "stop",
      orderId: firstOrderId + 2,
      order: {
        action: OrderAction.SELL,
        orderType: OrderType.STP_LMT,
        totalQuantity: plan.qty,
        auxPrice: plan.stop,
        lmtPrice: plan.stopLimit,
        tif: TimeInForce.GTC,
        outsideRth,
        parentId: firstOrderId,
        transmit: true,
      },
    });
  }

  return legs;
}
