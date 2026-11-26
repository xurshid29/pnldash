import { SecType } from "@stoqey/ib";
import type { Contract, ContractDetails } from "@stoqey/ib";
import { isDone, OrderBook } from "./book.js";
import type { OrderRecord } from "./book.js";
import type { Config, LimitsConfig, OrderConfig } from "./config.js";
import { badRequest, BridgeError, errorMessage } from "./errors.js";
import type { Journal } from "./journal.js";
import { NotConnectedError, TwsRequestError, TwsTimeoutError } from "./link.js";
import type { ExecutionEvent, OrderMessageEvent, OrderStatusEvent, TwsLink } from "./link.js";
import { buildBracket, formatPrice, planOrder } from "./order.js";
import type { OrderPlan } from "./order.js";
import { nyDate, systemClock } from "./time.js";
import type { Clock } from "./time.js";

const TICKER_FORMAT = /^[A-Z][A-Z0-9.]{0,6}$/;
const MAX_PRICE = 100000;
/** An alert older than this is not acted on. */
export const ALERT_MAX_AGE_MS = 10 * 60 * 1000;
/** The dashboard's server and this Mac do not share a clock: allow this much "from the future". */
const ALERT_CLOCK_SKEW_MS = 60 * 1000;
const CONTRACT_CACHE_MS = 12 * 60 * 60 * 1000;

/** When a ticker has several listings, the one on one of these primary exchanges is taken. */
export const US_PRIMARY_EXCHANGES: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);

/** TWS's "no security definition has been found for the request". */
const CODE_NO_SECURITY = 200;

/**
 * Messages TWS sends against an order id that report on a cancel, not a failure of the order:
 * cancelled (202), nothing to cancel (135, 10147), not cancellable in this state (161, 10148).
 */
const CANCEL_NOTICE_CODES = new Set([202, 135, 161, 10147, 10148]);

export interface ResolvedContract {
  conid: number;
  /** The symbol as TWS spells it (a class share is "BRK B", not "BRK.B"). */
  symbol: string;
  primaryExch: string | null;
}

export interface Check {
  name: string;
  detail: string;
}

export interface StatusData {
  version: string;
  tws: { connected: boolean; port: number; paper: boolean; accounts: string[] };
  enabled: boolean;
  halted: boolean;
  paper_only: boolean;
  display_group: number;
  order: OrderConfig;
  limits: LimitsConfig;
  today: { orders: number; filled: number };
}

export interface FocusData {
  ticker: string;
  conid: number;
  group: number;
}

export interface PreviewData {
  ticker: string;
  qty: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  notional: number;
  checks: Check[];
}

export interface OrderData {
  order_id: number;
  ticker: string;
  qty: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  status: string;
}

interface OrderRequest {
  ticker: string;
  alertPrice: number;
  alertStop: number | null;
  qty: number | null;
  stage: string | null;
  alertAtMs: number | null;
  alertAt: string | null;
  alertId: string | null;
}

export interface BridgeOptions {
  config: Config;
  link: TwsLink;
  journal: Journal;
  version: string;
  /** Saves the halt switch to config.json. */
  saveHalted: (halted: boolean) => void;
  clock?: Clock;
  /** One line for the console. */
  say?: (message: string) => void;
  /** How long `/order` waits for TWS's first word on the order before answering. */
  ackWaitMs?: number;
  contractTimeoutMs?: number;
  /** How long a `priceFrom: "ask"` order waits for the ask. */
  askTimeoutMs?: number;
}

export function maskAccount(account: string): string {
  return account.length <= 4 ? "…" : `${account.slice(0, 2)}…${account.slice(-2)}`;
}

/** Paper accounts are the ones whose id starts with "D"; no account known yet is not paper. */
export function isPaper(accounts: string[]): boolean {
  return accounts.length > 0 && accounts.every((account) => account.startsWith("D"));
}

function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("the body must be a JSON object");
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw badRequest(`unknown field ${JSON.stringify(key.slice(0, 40))}: only ${allowed.join(", ")} are accepted`);
    }
  }
  return body as Record<string, unknown>;
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function parseTicker(value: unknown): string {
  if (typeof value !== "string") throw badRequest("ticker must be a string");
  const ticker = value.toUpperCase();
  if (!TICKER_FORMAT.test(ticker)) throw badRequest("ticker is not a US stock symbol (a letter, then up to 6 letters, digits or dots)");
  return ticker;
}

function parsePrice(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= MAX_PRICE) {
    throw badRequest(`${name} must be a number above 0 and under ${MAX_PRICE}`);
  }
  return value;
}

function parseAlertAt(value: unknown): { ms: number; text: string } {
  let ms = Number.NaN;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds or milliseconds since the epoch.
    ms = value < 1e11 ? value * 1000 : value;
  } else if (typeof value === "string" && value.length <= 40) {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) throw badRequest("alert_at must be an ISO time or epoch milliseconds");
  return { ms, text: new Date(ms).toISOString() };
}

const ORDER_FIELDS = ["ticker", "alert_price", "alert_stop", "qty", "stage", "alert_at", "alert_id"] as const;

function parseOrderRequest(body: unknown): OrderRequest {
  const f = fields(body, ORDER_FIELDS);
  const ticker = parseTicker(f["ticker"]);
  const alertPrice = parsePrice(f["alert_price"], "alert_price");
  const alertStop = given(f["alert_stop"]) ? parsePrice(f["alert_stop"], "alert_stop") : null;

  let qty: number | null = null;
  if (given(f["qty"])) {
    const value = f["qty"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw badRequest("qty must be a whole number of shares, 1 or more");
    }
    qty = value;
  }

  let stage: string | null = null;
  if (given(f["stage"])) {
    const value = f["stage"];
    if (typeof value !== "string" || value.length > 40) throw badRequest("stage must be a short string");
    stage = value;
  }

  let alertId: string | null = null;
  if (given(f["alert_id"])) {
    const value = f["alert_id"];
    if (typeof value === "number" && Number.isFinite(value)) alertId = String(value);
    else if (typeof value === "string" && value.length <= 80) alertId = value;
    else throw badRequest("alert_id must be a short string or a number");
  }

  const at = given(f["alert_at"]) ? parseAlertAt(f["alert_at"]) : null;
  return { ticker, alertPrice, alertStop, qty, stage, alertAtMs: at?.ms ?? null, alertAt: at?.text ?? null, alertId };
}

/**
 * Picks the stock a ticker means among TWS's answers: a single listing is taken as it is; among
 * several, the one whose primary exchange is a US one; anything else is an error.
 */
export function pickContract(ticker: string, symbol: string, details: ContractDetails[]): ResolvedContract {
  const byConid = new Map<number, ResolvedContract>();
  for (const { contract } of details) {
    const conid = contract.conId;
    if (conid === undefined || !Number.isInteger(conid) || conid <= 0) continue;
    if (contract.secType !== undefined && contract.secType !== SecType.STK) continue;
    if (contract.currency !== undefined && contract.currency !== "USD") continue;
    if (contract.symbol !== undefined && contract.symbol !== symbol) continue;
    if (!byConid.has(conid)) byConid.set(conid, { conid, symbol, primaryExch: contract.primaryExch || null });
  }
  const listings = [...byConid.values()];
  const only = listings[0];
  if (only === undefined) throw new BridgeError(404, "unknown_ticker", `TWS knows no US stock ${ticker}`);
  if (listings.length === 1) return only;

  const us = listings.filter(
    (listing) => listing.primaryExch !== null && US_PRIMARY_EXCHANGES.has(listing.primaryExch.toUpperCase()),
  );
  const chosen = us[0];
  if (us.length === 1 && chosen !== undefined) return chosen;
  const seen = listings.map((listing) => `${listing.conid} on ${listing.primaryExch ?? "?"}`).join(", ");
  throw new BridgeError(
    409,
    "ambiguous_ticker",
    `${ticker} is ambiguous in TWS: ${listings.length} listings (${seen}), ` +
      `${us.length === 0 ? "none" : us.length} of them on a US primary exchange`,
  );
}

/**
 * Everything the HTTP API does, with every rail. The HTTP layer in `server.ts` only checks who is
 * calling; whether an order may go out is decided here and nowhere else.
 */
export class Bridge {
  private readonly config: Config;
  private readonly link: TwsLink;
  private readonly journal: Journal;
  private readonly version: string;
  private readonly saveHalted: (halted: boolean) => void;
  private readonly clock: Clock;
  private readonly say: (message: string) => void;
  private readonly ackWaitMs: number;
  private readonly contractTimeoutMs: number;
  private readonly askTimeoutMs: number;

  private readonly book = new OrderBook();
  private readonly contracts = new Map<string, { contract: ResolvedContract; at: number }>();
  private readonly ackWaiters = new Map<number, () => void>();
  /** Brackets already cancelled by the bridge after a leg was refused: once each. */
  private readonly cleanedUp = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeOptions) {
    this.config = options.config;
    this.link = options.link;
    this.journal = options.journal;
    this.version = options.version;
    this.saveHalted = options.saveHalted;
    this.clock = options.clock ?? systemClock;
    this.say = options.say ?? (() => undefined);
    this.ackWaitMs = options.ackWaitMs ?? 1000;
    this.contractTimeoutMs = options.contractTimeoutMs ?? 3000;
    this.askTimeoutMs = options.askTimeoutMs ?? 800;

    // Today's orders from the log: the daily count and the duplicate window survive a restart,
    // and their order ids are not handed out again even if TWS restarts its numbering.
    this.book.restore(this.journal.readDay(nyDate(this.clock())));
    this.link.raiseOrderIdFloor(this.book.highestOrderId() + 1);

    this.link.handlers = {
      onUp: ({ accounts, nextValidId }) => this.onUp(accounts, nextValidId),
      onAccounts: (accounts) => this.onAccounts(accounts),
      onDown: (reason) => this.onDown(reason),
      onOrderStatus: (event) => this.onOrderStatus(event),
      onExecution: (event) => this.onExecution(event),
      onOrderMessage: (event) => this.onOrderMessage(event),
      onNote: (kind, noteFields) => this.onNote(kind, noteFields),
    };
  }

  status(): StatusData {
    const accounts = this.link.getAccounts();
    const today = nyDate(this.clock());
    return {
      version: this.version,
      tws: {
        connected: this.link.isReady(),
        port: this.config.tws.port,
        paper: isPaper(accounts),
        accounts: accounts.map(maskAccount),
      },
      enabled: this.config.enabled,
      halted: this.config.halted,
      paper_only: this.config.paperOnly,
      display_group: this.config.displayGroup,
      order: { ...this.config.order },
      limits: { ...this.config.limits },
      today: { orders: this.book.countOn(today), filled: this.book.filledOn(today) },
    };
  }

  /** Step 1: the TWS windows linked to the display group jump to the ticker. Places nothing. */
  async focus(body: unknown): Promise<FocusData> {
    const ticker = parseTicker(fields(body, ["ticker"])["ticker"]);
    this.requireConnected();
    const contract = await this.resolveContract(ticker);
    const group = this.config.displayGroup;
    try {
      this.link.focus(group, contract.conid);
    } catch (err) {
      throw this.linkError(err, ticker);
    }
    this.journal.write("focus", { ticker, conid: contract.conid, group });
    return { ticker, conid: contract.conid, group };
  }

  /** The order `/order` would send right now, or the error it would give. Sends nothing. */
  async preview(body: unknown): Promise<PreviewData> {
    const request = parseOrderRequest(body);
    const { plan, checks } = await this.prepare(request);
    return {
      ticker: request.ticker,
      qty: plan.qty,
      limit: plan.limit,
      take_profit: plan.takeProfit,
      stop: plan.stop,
      stop_limit: plan.stopLimit,
      notional: plan.notional,
      checks,
    };
  }

  /** Step 2: places the bracket. One order at a time: a second click waits, then hits the duplicate rail. */
  async order(body: unknown): Promise<OrderData> {
    const request = parseOrderRequest(body);
    const record = await this.serial(async () => {
      const { plan, contract } = await this.prepare(request);
      return this.send(request, plan, contract);
    });
    await this.waitForAck(record);
    if (record.error !== null) {
      throw new BridgeError(502, "tws_refused", `TWS refused order ${record.order_id}: ${record.error}`);
    }
    return {
      order_id: record.order_id,
      ticker: record.ticker,
      qty: record.sent.qty,
      limit: record.sent.limit,
      take_profit: record.sent.take_profit,
      stop: record.sent.stop,
      stop_limit: record.sent.stop_limit,
      status: record.status,
    };
  }

  /** Today's (New York date) orders, newest first. */
  orders(): OrderRecord[] {
    return this.book.ordersOn(nyDate(this.clock()));
  }

  /** Cancels a buy that has not filled; TWS cancels its exits with it. */
  cancel(body: unknown): { order_id: number; status: string } {
    const orderId = fields(body, ["order_id"])["order_id"];
    if (typeof orderId !== "number" || !Number.isInteger(orderId) || orderId < 1) {
      throw badRequest("order_id must be the order_id of one of the orders in /orders");
    }
    const record = this.book.get(orderId);
    if (record === undefined) {
      throw new BridgeError(404, "unknown_order", `order ${orderId} is not a buy order this bridge placed`);
    }
    if (record.status === "Filled") {
      throw new BridgeError(
        409,
        "already_filled",
        `order ${orderId} has filled: nothing is left to cancel, and its take-profit and stop stay working in TWS`,
      );
    }
    if (isDone(record.status)) {
      throw new BridgeError(409, "already_done", `order ${orderId} is already ${record.status}`);
    }
    this.requireConnected();
    try {
      this.link.cancelOrder(orderId);
    } catch (err) {
      throw this.linkError(err, record.ticker);
    }
    this.journal.write("cancel", { order_id: orderId, ticker: record.ticker });
    this.onOrderStatus({
      orderId,
      status: "PendingCancel",
      filled: record.filled_qty,
      remaining: 0,
      avgFillPrice: record.avg_fill_price ?? 0,
    });
    return { order_id: orderId, status: record.status };
  }

  /** The off switch. It takes effect at once; saving it to config.json comes second. */
  halt(body: unknown): { halted: boolean } {
    const halted = fields(body, ["halted"])["halted"];
    if (typeof halted !== "boolean") throw badRequest("halted must be true or false");
    this.config.halted = halted;
    this.journal.write("halt", { halted });
    this.say(halted ? "orders HALTED" : "orders on again (halt switched off)");
    try {
      this.saveHalted(halted);
    } catch (err) {
      throw new BridgeError(
        500,
        "not_saved",
        `halted is now ${halted} in the running bridge, but saving it to config.json failed: ${errorMessage(err)}`,
      );
    }
    return { halted };
  }

  // ---------------------------------------------------------------- the rails

  private assertTradingOn(): void {
    if (!this.config.enabled) {
      throw new BridgeError(409, "disabled", 'orders are switched off: "enabled" is false in config.json');
    }
    if (this.config.halted) {
      throw new BridgeError(409, "halted", "orders are halted: switch the halt off to place orders again");
    }
  }

  private requireConnected(): void {
    if (!this.link.isReady()) {
      throw new BridgeError(
        503,
        "tws_down",
        `TWS is not connected (API port ${this.config.tws.port}): is TWS running, logged in, and its API switched on?`,
      );
    }
  }

  /**
   * Every rail, then the prices. Used by `/preview` and `/order` alike and changes nothing, so a
   * preview answers exactly what an order placed at the same moment would.
   */
  private async prepare(
    request: OrderRequest,
  ): Promise<{ plan: OrderPlan; contract: ResolvedContract; checks: Check[] }> {
    const { order: orderCfg, limits } = this.config;
    const checks: Check[] = [];
    const now = this.clock();
    const { ticker } = request;

    this.assertTradingOn();
    checks.push({ name: "switches", detail: "orders are enabled and not halted" });

    this.requireConnected();
    if (this.link.isServerLinkLost()) {
      throw new BridgeError(
        503,
        "tws_offline",
        "TWS has lost its connection to IB's servers: an order sent now would wait in TWS and go out later",
      );
    }

    const accounts = this.link.getAccounts();
    const paper = isPaper(accounts);
    if (this.config.paperOnly && !paper) {
      throw new BridgeError(
        409,
        "paper_only",
        (accounts.length === 0
          ? "paperOnly is on and TWS has not reported its account yet: no orders. "
          : "paperOnly is on and the account TWS is logged in to is not a paper account: no orders. ") +
          'To trade a live account, set "paperOnly": false in config.json by hand and restart the bridge; ' +
          "it cannot be changed over HTTP.",
      );
    }
    checks.push({ name: "account", detail: paper ? "paper account" : "LIVE account (paperOnly is off)" });

    if (request.alertAtMs !== null) {
      const ageMs = now - request.alertAtMs;
      if (ageMs < -ALERT_CLOCK_SKEW_MS) throw badRequest("alert_at is in the future");
      if (ageMs > ALERT_MAX_AGE_MS) {
        throw new BridgeError(
          422,
          "stale_alert",
          `the alert is stale: it is ${Math.floor(ageMs / 60000)} min old (the limit is ${ALERT_MAX_AGE_MS / 60000} min)`,
        );
      }
      checks.push({ name: "alert_age", detail: `${Math.max(0, Math.round(ageMs / 1000))}s old` });
    }

    const qty = request.qty ?? orderCfg.qty;
    if (qty > limits.maxShares) {
      throw new BridgeError(422, "too_many_shares", `${qty} shares is above maxShares (${limits.maxShares})`);
    }
    checks.push({ name: "shares", detail: `${qty} of ${limits.maxShares} allowed` });

    const today = nyDate(now);
    const placedToday = this.book.countOn(today);
    if (placedToday >= limits.maxOrdersPerDay) {
      throw new BridgeError(
        409,
        "daily_limit",
        `the daily order limit is reached: ${placedToday} of ${limits.maxOrdersPerDay} today (New York date ${today})`,
      );
    }
    checks.push({ name: "daily", detail: `order ${placedToday + 1} of ${limits.maxOrdersPerDay} today` });

    const lastMs = this.book.lastPlacedMs(ticker);
    if (lastMs !== undefined && now - lastMs < limits.duplicateWindowSec * 1000) {
      const agoSec = Math.max(0, Math.round((now - lastMs) / 1000));
      throw new BridgeError(
        409,
        "duplicate",
        `duplicate: ${ticker} was ordered ${agoSec}s ago (the window is ${limits.duplicateWindowSec}s)`,
      );
    }
    checks.push({ name: "duplicate", detail: `no order for ${ticker} in the last ${limits.duplicateWindowSec}s` });

    const contract = await this.resolveContract(ticker);
    checks.push({
      name: "contract",
      detail: `conid ${contract.conid}${contract.primaryExch === null ? "" : ` on ${contract.primaryExch}`}`,
    });

    let ask: number | null = null;
    if (orderCfg.priceFrom === "ask") {
      try {
        ask = await this.link.askSnapshot(this.ibContract(contract), this.askTimeoutMs);
      } catch (err) {
        if (err instanceof TwsRequestError) {
          throw new BridgeError(502, "no_ask", `TWS gave no ask for ${ticker}: ${err.message} (code ${err.code})`);
        }
        throw this.linkError(err, ticker);
      }
      if (ask === null) {
        throw new BridgeError(504, "no_ask", `no ask for ${ticker} from TWS within ${this.askTimeoutMs} ms`);
      }
    }

    const plan = planOrder(orderCfg, { qty, alertPrice: request.alertPrice, alertStop: request.alertStop, ask });
    checks.push({
      name: "limit",
      detail:
        `${formatPrice(plan.limit)} = the ${plan.priceFrom === "ask" ? "ask" : "alert's price"} ` +
        `${formatPrice(plan.basePrice)} + ${orderCfg.limitOffsetPct}%; ` +
        `${plan.chasePct.toFixed(1)}% past the alert (max ${orderCfg.maxChasePct}%)`,
    });
    checks.push({
      name: "take_profit",
      detail:
        plan.takeProfit === null
          ? "none (takeProfitPct is 0)"
          : `${formatPrice(plan.takeProfit)}, ${orderCfg.takeProfitPct}% above the limit`,
    });
    checks.push({ name: "stop", detail: this.describeStop(plan) });

    if (plan.notional > limits.maxNotionalUsd + 1e-9) {
      throw new BridgeError(
        422,
        "too_large",
        `the order is $${plan.notional.toFixed(2)} (${qty} × ${formatPrice(plan.limit)}), ` +
          `above maxNotionalUsd ($${limits.maxNotionalUsd})`,
      );
    }
    checks.push({ name: "notional", detail: `$${plan.notional.toFixed(2)} of $${limits.maxNotionalUsd} allowed` });

    return { plan, contract, checks };
  }

  private describeStop(plan: OrderPlan): string {
    const ignored = plan.alertStopIgnored === null ? "" : `; the alert's stop was not used: ${plan.alertStopIgnored}`;
    if (plan.stop === null || plan.stopLimit === null) return `none (stopPct is 0)${ignored}`;
    const prices = `${formatPrice(plan.stop)}, limit ${formatPrice(plan.stopLimit)}`;
    if (plan.stopFrom === "alert") return `${prices}: the alert's stop`;
    return `${prices}: ${this.config.order.stopPct}% under the limit${ignored}`;
  }

  // ------------------------------------------------------------- sending

  /**
   * Sends the bracket. There is no `await` in here: between the last checks and the last leg
   * nothing else runs, so the connection, the switches and the order ids cannot change under it.
   */
  private send(request: OrderRequest, plan: OrderPlan, contract: ResolvedContract): OrderRecord {
    this.assertTradingOn();
    this.requireConnected();
    const now = this.clock();
    let firstId: number;
    try {
      firstId = this.link.allocateOrderIds(3);
    } catch (err) {
      throw this.linkError(err, request.ticker);
    }
    const legs = buildBracket(plan, firstId, this.config.order.outsideRth);
    const takeProfitId = plan.takeProfit === null ? null : firstId + 1;
    const stopId = plan.stop === null ? null : firstId + 2;

    const record: OrderRecord = {
      order_id: firstId,
      ticker: request.ticker,
      conid: contract.conid,
      placed_at: new Date(now).toISOString(),
      asked: {
        alert_price: request.alertPrice,
        alert_stop: request.alertStop,
        qty: request.qty,
        stage: request.stage,
        alert_at: request.alertAt,
        alert_id: request.alertId,
      },
      sent: {
        qty: plan.qty,
        limit: plan.limit,
        take_profit: plan.takeProfit,
        stop: plan.stop,
        stop_limit: plan.stopLimit,
        price_from: plan.priceFrom,
        stop_from: plan.stopFrom,
        outside_rth: this.config.order.outsideRth,
        order_ids: { parent: firstId, take_profit: takeProfitId, stop: stopId },
      },
      status: "PendingSubmit",
      filled_qty: 0,
      avg_fill_price: null,
      slip_pct: null,
      legs: {
        take_profit:
          takeProfitId === null
            ? null
            : { order_id: takeProfitId, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
        stop: stopId === null ? null : { order_id: stopId, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
      },
      error: null,
      note: null,
    };

    // The log line comes first: an order that cannot be written down is not sent.
    try {
      this.journal.writeOrThrow("order_placed", { ...record });
    } catch (err) {
      throw new BridgeError(500, "log_failed", `the order was NOT sent: the log cannot be written (${errorMessage(err)})`);
    }
    this.book.add(record, now);

    let sent = 0;
    try {
      const ibContract = this.ibContract(contract);
      for (const leg of legs) {
        this.link.placeOrder(leg.orderId, ibContract, leg.order);
        sent += 1;
      }
    } catch (err) {
      // Earlier legs carry transmit=false, so TWS holds them unsent; take them back out.
      record.error = `sending failed after ${sent} of ${legs.length} legs: ${errorMessage(err)}`;
      this.journal.write("order_error", { order_id: firstId, ticker: record.ticker, message: record.error });
      if (sent > 0) this.cleanUp(record);
      throw new BridgeError(502, "send_failed", `order ${firstId} for ${record.ticker} was not placed: ${record.error}`);
    }

    this.say(
      `order ${firstId} ${record.ticker}: buy ${plan.qty} @ ${formatPrice(plan.limit)}` +
        (plan.takeProfit === null ? "" : `, take-profit ${formatPrice(plan.takeProfit)}`) +
        (plan.stop === null || plan.stopLimit === null
          ? ""
          : `, stop ${formatPrice(plan.stop)} / ${formatPrice(plan.stopLimit)}`),
    );
    return record;
  }

  private waitForAck(record: OrderRecord): Promise<void> {
    if (this.ackWaitMs <= 0 || record.status !== "PendingSubmit" || record.error !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.ackWaiters.delete(record.order_id);
        resolve();
      };
      const timer = setTimeout(done, this.ackWaitMs);
      this.ackWaiters.set(record.order_id, done);
    });
  }

  /** Cancels a bracket that has a refused leg and no fill, once: an entry without its exits is not what was clicked. */
  private cleanUp(record: OrderRecord): void {
    if (this.cleanedUp.has(record.order_id)) return;
    if (record.filled_qty > 0 || isDone(record.status)) return;
    this.cleanedUp.add(record.order_id);
    try {
      this.link.cancelOrder(record.order_id);
      this.journal.write("order_cleanup", { order_id: record.order_id, ticker: record.ticker });
    } catch {
      // Not connected: nothing can be cancelled now; the error stays on the record.
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ contracts

  private ibContract(contract: ResolvedContract): Contract {
    return {
      conId: contract.conid,
      symbol: contract.symbol,
      secType: SecType.STK,
      exchange: "SMART",
      currency: "USD",
    };
  }

  private async resolveContract(ticker: string): Promise<ResolvedContract> {
    const now = this.clock();
    const cached = this.contracts.get(ticker);
    if (cached !== undefined && now - cached.at >= 0 && now - cached.at < CONTRACT_CACHE_MS) return cached.contract;

    // TWS writes a class share with a space where the tape uses a dot.
    const symbol = ticker.replaceAll(".", " ");
    let details: ContractDetails[];
    try {
      details = await this.link.contractDetails(
        { symbol, secType: SecType.STK, exchange: "SMART", currency: "USD" },
        this.contractTimeoutMs,
      );
    } catch (err) {
      if (err instanceof TwsRequestError) {
        if (err.code === CODE_NO_SECURITY) {
          throw new BridgeError(404, "unknown_ticker", `TWS knows no US stock ${ticker}`);
        }
        throw new BridgeError(502, "tws_error", `TWS could not look up ${ticker}: ${err.message} (code ${err.code})`);
      }
      throw this.linkError(err, ticker);
    }
    const contract = pickContract(ticker, symbol, details);
    this.contracts.set(ticker, { contract, at: now });
    return contract;
  }

  private linkError(err: unknown, ticker: string): BridgeError {
    if (err instanceof BridgeError) return err;
    if (err instanceof NotConnectedError) {
      return new BridgeError(503, "tws_down", `TWS is not connected: nothing was sent for ${ticker}`);
    }
    if (err instanceof TwsTimeoutError) return new BridgeError(504, "tws_timeout", err.message);
    return new BridgeError(502, "tws_error", `TWS call failed for ${ticker}: ${errorMessage(err)}`);
  }

  // ---------------------------------------------------- events from TWS

  private onUp(accounts: string[], nextValidId: number): void {
    this.journal.write("tws_up", { accounts: accounts.map(maskAccount), paper: isPaper(accounts), next_order_id: nextValidId });
    this.say(`TWS connected on port ${this.config.tws.port}${this.describeAccounts(accounts)}`);
    // Catch up on orders placed earlier today: reads only, nothing is ever sent again.
    if (this.book.countOn(nyDate(this.clock())) > 0) {
      try {
        this.link.syncOrders();
      } catch {
        // Dropped again already.
      }
    }
  }

  private onAccounts(accounts: string[]): void {
    if (!this.link.isReady()) return;
    this.journal.write("tws_accounts", { accounts: accounts.map(maskAccount), paper: isPaper(accounts) });
    this.say(`TWS account${this.describeAccounts(accounts)}`);
  }

  private describeAccounts(accounts: string[]): string {
    if (accounts.length === 0) return "";
    const kind = isPaper(accounts) ? "paper" : "LIVE";
    return `: ${accounts.map(maskAccount).join(", ")} (${kind})`;
  }

  private onDown(reason: string): void {
    this.journal.write("tws_down", { reason });
    this.say(`TWS not connected: ${reason} (retrying)`);
  }

  private onNote(kind: string, noteFields: Record<string, unknown>): void {
    this.journal.write(kind, noteFields);
    if (kind === "display_groups") {
      const groups = this.link.getDisplayGroups() ?? [];
      const mine = this.config.displayGroup;
      this.say(
        `TWS display groups: ${groups.join(", ") || "none"}` +
          (groups.includes(mine) ? "" : ` (displayGroup ${mine} is not among them: /focus may do nothing)`),
      );
    } else if (kind === "display_group_error") {
      this.say(`TWS refused the display group: ${String(noteFields["message"])}`);
    }
  }

  private onOrderStatus(event: OrderStatusEvent): void {
    const ref = this.book.applyStatus(event);
    if (ref === null) return;
    const { record, leg, state } = ref;
    this.journal.write("order_status", {
      order_id: record.order_id,
      ticker: record.ticker,
      leg,
      leg_order_id: event.orderId,
      status: state.status,
      filled: state.filled_qty,
      avg_fill_price: state.avg_fill_price,
      ...(leg === "parent" ? { alert_price: record.asked.alert_price, slip_pct: record.slip_pct } : {}),
    });
    if (leg === "parent") this.ackWaiters.get(record.order_id)?.();
  }

  private onExecution(event: ExecutionEvent): void {
    const ref = this.book.applyExecution(event);
    if (ref === null) return;
    const { record, leg, state } = ref;
    this.journal.write("fill", {
      order_id: record.order_id,
      ticker: record.ticker,
      leg,
      leg_order_id: event.orderId,
      exec_id: event.execId,
      shares: event.shares,
      price: event.price,
      cum_qty: state.filled_qty,
      avg_price: state.avg_fill_price,
      exec_time: event.time,
      ...(leg === "parent" ? { alert_price: record.asked.alert_price, slip_pct: record.slip_pct } : {}),
    });
    this.say(
      `fill ${record.ticker} (${leg}): ${event.shares} @ ${formatPrice(event.price)}` +
        (leg === "parent" && record.slip_pct !== null ? `, slip ${record.slip_pct}% against the alert` : ""),
    );
  }

  private onOrderMessage(event: OrderMessageEvent): void {
    const ref = this.book.findLeg(event.orderId);
    if (ref === undefined) {
      this.journal.write("tws_message", { id: event.orderId, code: event.code, message: event.message });
      return;
    }
    const { record, leg } = ref;
    const legName = leg === "parent" ? "buy" : leg === "take_profit" ? "take-profit" : "stop";
    const message = `${legName}: ${event.message} (code ${event.code})`;
    const entry = { order_id: record.order_id, ticker: record.ticker, leg, leg_order_id: event.orderId, code: event.code, message };

    if (event.nonFatal || CANCEL_NOTICE_CODES.has(event.code)) {
      record.note = message;
      this.journal.write("order_note", entry);
      return;
    }
    record.error = message;
    this.journal.write("order_error", entry);
    this.say(`order ${record.order_id} ${record.ticker} refused by TWS: ${message}`);
    this.cleanUp(record);
    this.ackWaiters.get(record.order_id)?.();
  }
}
