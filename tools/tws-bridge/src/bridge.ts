import { SecType } from "@stoqey/ib";
import type { Contract, ContractDetails, Order } from "@stoqey/ib";
import { isDone, OrderBook } from "./book.js";
import type { BookLeg, ExitState, OrderRecord, PriceChange } from "./book.js";
import type { Config, LimitsConfig, OrderConfig } from "./config.js";
import { badRequest, BridgeError, errorMessage } from "./errors.js";
import { describeDisplayGroups, parseContractInfo } from "./groups.js";
import type { GroupContent, GroupReading } from "./groups.js";
import type { Journal } from "./journal.js";
import { NotConnectedError, TwsRequestError, TwsTimeoutError } from "./link.js";
import type {
  DisplayGroupEvent,
  ExecutionEvent,
  FocusSent,
  OpenOrderEvent,
  OrderMessageEvent,
  OrderStatusEvent,
  PositionRow,
  TwsLink,
} from "./link.js";
import {
  buildBracket,
  buyOrder,
  formatPct,
  formatPrice,
  formatUsd,
  ibUtcDateTime,
  planChase,
  planOrder,
  sellLimit,
  sellOrder,
  stopEntryGoodUntil,
  stopEntryOff,
  stopOrder,
  takeProfitOrder,
} from "./order.js";
import type { Entry, LegName, OrderPlan, Sizing } from "./order.js";
import { nyDate, nyTime, systemClock } from "./time.js";
import type { Clock } from "./time.js";

const TICKER_FORMAT = /^[A-Z][A-Z0-9.]{0,6}$/;
const MAX_PRICE = 100000;
/** An alert older than this is not acted on. */
export const ALERT_MAX_AGE_MS = 10 * 60 * 1000;
/** The dashboard's server and this Mac do not share a clock: allow this much "from the future". */
const ALERT_CLOCK_SKEW_MS = 60 * 1000;
const CONTRACT_CACHE_MS = 12 * 60 * 60 * 1000;
/** A display group's event names the contract a `/focus` sent within this long: the focus did it. */
const FOCUS_ANSWER_MS = 2000;
/** Two changes the bridge sends to the same TWS order are kept at least this far apart. */
export const CHANGE_SPACING_MS = 300;
/**
 * A refusal from TWS against an order within this long of a change the bridge sent to it, and
 * before TWS has reported the order with the new price, is taken to be about that change.
 */
const CHANGE_ANSWER_MS = 5000;
/** Two prices are the same price when they are this close (TWS reports them as binary fractions). */
const PRICE_EPS = 1e-9;
/**
 * A stop entry that TWS reports cancelled this close to its end (or after it), with nothing filled
 * and no cancel asked by the bridge, is taken to have expired: IB's clock and this Mac's are not
 * one clock.
 */
const EXPIRY_CLOCK_SLACK_MS = 2000;
/** How many times `/sell` looks at an order again when it changed while TWS was being asked. */
const SELL_PASSES = 4;

/** When a ticker has several listings, the one on one of these primary exchanges is taken. */
export const US_PRIMARY_EXCHANGES: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]);

/** TWS's "no security definition has been found for the request". */
const CODE_NO_SECURITY = 200;

/**
 * Messages TWS sends against an order id that report on a cancel, not a failure of the order:
 * cancelled (202), nothing to cancel (135, 10147), not cancellable in this state (161, 10148).
 */
const CANCEL_NOTICE_CODES = new Set([202, 135, 161, 10147, 10148]);

/** Of those, the two that say TWS has no such order at all ("not found"). */
const ORDER_NOT_FOUND_CODES = new Set([135, 10147]);

/** "OrderId N that needs to be cancelled cannot be cancelled, state: <its state>." */
const CODE_NOT_CANCELLABLE = 10148;

/**
 * "Unable to modify this order as it is still being processed" (2102). Its number is among TWS's
 * warnings, and it is a refusal all the same: the change did not happen.
 */
const CHANGE_REFUSED_NOTICE_CODES = new Set([2102]);

const LEG_WORDS: Record<BookLeg, string> = { parent: "buy", take_profit: "take-profit", stop: "stop", exit: "sell" };

/**
 * The status the bridge itself gives a buy that TWS will never report on: it never went out, or
 * TWS says it has no such order. It is TWS's own word for "not working, was refused".
 */
const STATUS_NOT_WORKING = "Inactive";

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
  /**
   * `offline`: TWS is connected to the bridge but says it has lost IB's servers; orders are
   * refused (`tws_offline`) until it is back. Always false while `connected` is false.
   */
  tws: { connected: boolean; port: number; paper: boolean; accounts: string[]; offline: boolean };
  enabled: boolean;
  halted: boolean;
  paper_only: boolean;
  /** The configured group: the one `/focus` moves. */
  display_group: number;
  /**
   * What each of TWS's display groups shows right now, by group number: a ticker, the raw
   * `"<conid>@<exchange>"` while its ticker is not known, `"combo"`, or null for nothing (or not
   * heard from yet). Empty while TWS is not connected or has not listed its groups.
   */
  display_groups: Array<{ id: number; shows: string | null }>;
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
  /** "now" (a limit buy) or "stop" (a stop-limit buy that waits above the alert). */
  entry: Entry;
  qty: number;
  /** How the quantity was arrived at: `amountUsd` dollars' worth, or a number of shares. */
  sizing: Sizing;
  limit: number;
  /** A stop entry's trigger; null for a buy now. */
  trigger: number | null;
  /** When a stop entry would stop waiting (ISO time); null for a buy now. */
  good_until: string | null;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  notional: number;
  /** What the limit was worked out from. "alert" under `priceFrom: "ask"` means the fallback was used. */
  price_from: "alert" | "ask";
  /** Why the price did not come from where the config says, when it did not; else null. */
  note: string | null;
  checks: Check[];
}

export interface OrderData {
  order_id: number;
  ticker: string;
  entry: Entry;
  qty: number;
  sizing: Sizing;
  limit: number;
  trigger: number | null;
  good_until: string | null;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  price_from: "alert" | "ask";
  note: string | null;
  status: string;
}

export interface ChaseData {
  order_id: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  chases: number;
  status: string;
}

export interface SellData {
  order_id: number;
  /** The shares the sell is for. */
  qty: number;
  limit: number;
  /** The status of the order doing the selling. */
  status: string;
  via: "take_profit" | "new_order";
}

/**
 * A change the bridge sent to an order (or a sell order it placed) that TWS has neither reported
 * back nor refused yet. It is what a refusal is matched against, and it knows what the book goes
 * back to then.
 */
interface SentChange {
  what: "chase" | "sell";
  atMs: number;
  /** How TWS will report the order once it has taken this. */
  expect: { lmtPrice: number; auxPrice: number | null };
  /** A new order rather than a change to one: there is nothing to go back to. */
  fresh: boolean;
  /** The prices the book goes back to when TWS refuses the change. */
  back: PriceChange;
  /** The bracket's `/sell` as it was before the change, when the change touched it. */
  backExit?: ExitState | null;
  /** TWS's words, once it has refused. */
  refused: string | null;
}

/** What `/sell` does next for an order, from where the order stands. */
type SellStep = "reprice" | "finish_buy" | "take_profit" | "cancel_stop" | "new_order";

/**
 * An order that holds nothing any more while a sell order of its own still works: the grace
 * period TWS gets to cancel that order itself (`timer`), and whether it is over (`due`).
 */
interface FlatWatch {
  timer: NodeJS.Timeout | null;
  due: boolean;
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
  entry: Entry;
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
  /** How long a `priceFrom: "ask"` order and a `/chase` wait for the ask, and a `/sell` for the bid. */
  askTimeoutMs?: number;
  /** How long a `/sell` waits for TWS to report the account's position. */
  positionTimeoutMs?: number;
  /** How long a `/sell` waits for TWS to confirm a cancel it had to send first. */
  cancelWaitMs?: number;
  /** Once the buy's cancel is confirmed, how long a `/sell` gives TWS to say whether the exits went with it. */
  exitsSettleMs?: number;
  /**
   * How long a sell order of an order that holds nothing any more may stay working before the
   * bridge cancels it: the time TWS is given to cancel it itself, as it does within a bracket.
   */
  exitGraceMs?: number;
  /** After TWS lists its display groups, how long to wait for what they show before saying it. */
  groupReportMs?: number;
  /** How long to wait for the ticker of a contract id a display group shows. */
  groupLookupTimeoutMs?: number;
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

/** The `{ order_id }` body of `/cancel`, `/chase` and `/sell`. */
function parseOrderId(body: unknown): number {
  const orderId = fields(body, ["order_id"])["order_id"];
  if (typeof orderId !== "number" || !Number.isInteger(orderId) || orderId < 1) {
    throw badRequest("order_id must be the order_id of one of the orders in /orders");
  }
  return orderId;
}

function differs(a: number, b: number | null): boolean {
  return b === null || Math.abs(a - b) > PRICE_EPS;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
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

const ORDER_FIELDS = ["ticker", "alert_price", "alert_stop", "qty", "stage", "alert_at", "alert_id", "entry"] as const;

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

  let entry: Entry = "now";
  if (given(f["entry"])) {
    const value = f["entry"];
    if (value !== "now" && value !== "stop") throw badRequest('entry must be "now" or "stop"');
    entry = value;
  }

  const at = given(f["alert_at"]) ? parseAlertAt(f["alert_at"]) : null;
  return { ticker, alertPrice, alertStop, qty, stage, alertAtMs: at?.ms ?? null, alertAt: at?.text ?? null, alertId, entry };
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
 * The name to show for a contract id, from TWS's answer to a lookup by that id: a stock's symbol
 * the way the tape writes it ("BRK.B"), anything else by its local symbol. Null when the answer
 * names nothing.
 */
export function tickerOfConid(conid: number, details: ContractDetails[]): string | null {
  for (const { contract } of details) {
    if (contract.conId !== undefined && contract.conId !== conid) continue;
    const isStock = contract.secType === undefined || contract.secType === SecType.STK;
    const name = (isStock ? contract.symbol : contract.localSymbol || contract.symbol)?.trim();
    if (name) return (isStock ? name.replaceAll(" ", ".") : name).slice(0, 32);
  }
  return null;
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
  private readonly positionTimeoutMs: number;
  private readonly cancelWaitMs: number;
  private readonly exitsSettleMs: number;
  private readonly exitGraceMs: number;
  private readonly groupReportMs: number;
  private readonly groupLookupTimeoutMs: number;

  private readonly book = new OrderBook();
  private readonly contracts = new Map<string, { contract: ResolvedContract; at: number }>();
  private readonly ackWaiters = new Map<number, () => void>();
  /**
   * Orders already cancelled by the bridge after TWS refused them: once each. A bracket is in
   * here by its buy's id, a refused `/sell` order by its own.
   */
  private readonly cleanedUp = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();
  /** `/chase` and `/sell` run one at a time, in their own line: a sell never waits behind a buy being prepared. */
  private managing: Promise<unknown> = Promise.resolve();

  /** Per TWS order id: when the bridge last sent it or a change to it. */
  private readonly lastSentMs = new Map<number, number>();
  /** Per TWS order id: the change the bridge sent that TWS has neither reported back nor refused. */
  private readonly sentChanges = new Map<number, SentChange>();
  /** Per TWS order id: its whole quantity as last sent or as TWS last reported it. A change never sends more. */
  private readonly orderQty = new Map<number, number>();
  /** A `/chase` or `/sell` waiting for TWS's first word about the order it changed. */
  private readonly wordWaiters = new Map<number, () => void>();
  /** A `/sell` waiting for an order to reach a state (a cancel confirmed): asked again on every event. */
  private readonly stateWaiters = new Set<() => void>();
  /** Per bracket (its buy's id): it holds nothing and a sell order of its own still works. */
  private readonly flatWatches = new Map<number, FlatWatch>();
  private closed = false;

  /** Contract id → ticker, for what the display groups show. A contract id never changes hands. */
  private readonly conidTickers = new Map<number, string>();
  /** Contract ids whose ticker TWS did not give on this connection: not asked again. */
  private readonly conidUnknown = new Set<number>();
  private readonly conidLookups = new Set<number>();
  /** The once-per-connection console report of the display groups: its deadline, and whether it was said. */
  private groupReport: { timer: NodeJS.Timeout | null; said: boolean } | null = null;
  /** The last `/focus` per display group, and a count that tells one focus from the next. */
  private readonly lastFocus = new Map<number, { conid: number; atMs: number; seq: number }>();
  private focusCount = 0;
  /** The last event logged per display group on this connection: an identical repeat is left out. */
  private readonly groupTrail = new Map<number, { raw: string; focusSeq: number }>();
  /** Contract ids the console named only by number, to be named once TWS says what they are. */
  private readonly unnamedOnConsole = new Set<number>();

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
    this.positionTimeoutMs = options.positionTimeoutMs ?? 1000;
    this.cancelWaitMs = options.cancelWaitMs ?? 1500;
    this.exitsSettleMs = options.exitsSettleMs ?? 250;
    this.exitGraceMs = options.exitGraceMs ?? 1000;
    this.groupReportMs = options.groupReportMs ?? 3000;
    this.groupLookupTimeoutMs = options.groupLookupTimeoutMs ?? 2000;

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
      onOpenOrder: (event) => this.onOpenOrder(event),
      onDisplayGroups: () => this.onDisplayGroups(),
      onDisplayGroupShows: (group, contractInfo, detail) => this.onDisplayGroupShows(group, contractInfo, detail),
      onNote: (kind, noteFields) => this.onNote(kind, noteFields),
    };
  }

  /** Ends the bridge's own timers. The connection is the link's to stop. */
  close(): void {
    this.endGroupReport();
    this.closed = true;
    this.endFlatWatches();
    this.stateChanged();
    for (const done of [...this.wordWaiters.values()]) done();
  }

  status(): StatusData {
    const accounts = this.link.getAccounts();
    const today = nyDate(this.clock());
    const connected = this.link.isReady();
    return {
      version: this.version,
      tws: {
        connected,
        port: this.config.tws.port,
        paper: isPaper(accounts),
        accounts: accounts.map(maskAccount),
        offline: connected && this.link.isServerLinkLost(),
      },
      enabled: this.config.enabled,
      halted: this.config.halted,
      paper_only: this.config.paperOnly,
      display_group: this.config.displayGroup,
      display_groups: this.groupReadings().map(({ id, shows }) => ({ id, shows })),
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
    // Noted before it is sent: TWS's own report of the change can come back at once, and is
    // matched against this to tell "the focus did it" from "changed in TWS".
    const previous = this.lastFocus.get(group);
    this.focusCount += 1;
    this.lastFocus.set(group, { conid: contract.conid, atMs: this.clock(), seq: this.focusCount });
    let sent: FocusSent;
    try {
      sent = this.link.focus(group, contract.conid);
    } catch (err) {
      if (previous === undefined) this.lastFocus.delete(group);
      else this.lastFocus.set(group, previous);
      throw this.linkError(err, ticker);
    }
    // `sent` is the exact string that went to TWS, `request_id` the subscription it went under:
    // the group's `display_group_shows` lines carry the same id.
    this.journal.write("focus", {
      ticker,
      conid: contract.conid,
      group,
      sent: sent.contractInfo,
      request_id: sent.requestId,
    });
    return { ticker, conid: contract.conid, group };
  }

  /** The order `/order` would send right now, or the error it would give. Sends nothing. */
  async preview(body: unknown): Promise<PreviewData> {
    const request = parseOrderRequest(body);
    const { plan, checks, priceNote, goodUntilMs } = await this.prepare(request);
    return {
      ticker: request.ticker,
      entry: plan.entry,
      qty: plan.qty,
      sizing: plan.sizing,
      limit: plan.limit,
      trigger: plan.trigger,
      good_until: goodUntilMs === null ? null : new Date(goodUntilMs).toISOString(),
      take_profit: plan.takeProfit,
      stop: plan.stop,
      stop_limit: plan.stopLimit,
      notional: plan.notional,
      price_from: plan.priceFrom,
      note: priceNote,
      checks,
    };
  }

  /** Step 2: places the bracket. One order at a time: a second click waits, then hits the duplicate rail. */
  async order(body: unknown): Promise<OrderData> {
    const request = parseOrderRequest(body);
    const { record, priceNote } = await this.serial(async () => {
      const { plan, contract, priceNote: note } = await this.prepare(request);
      return { record: this.send(request, plan, contract, note), priceNote: note };
    });
    await this.waitForAck(record);
    if (record.error !== null) {
      throw new BridgeError(502, "tws_refused", `TWS refused order ${record.order_id}: ${record.error}`);
    }
    return {
      order_id: record.order_id,
      ticker: record.ticker,
      entry: record.entry,
      qty: record.sent.qty,
      sizing: record.sizing,
      limit: record.sent.limit,
      trigger: record.sent.trigger,
      good_until: record.sent.good_until,
      take_profit: record.sent.take_profit,
      stop: record.sent.stop,
      stop_limit: record.sent.stop_limit,
      price_from: record.sent.price_from,
      note: priceNote,
      status: record.status,
    };
  }

  /** Today's (New York date) orders, newest first. */
  orders(): OrderRecord[] {
    return this.book.ordersOn(nyDate(this.clock()));
  }

  /** Cancels a buy that has not filled; TWS cancels its exits with it. */
  cancel(body: unknown): { order_id: number; status: string } {
    const orderId = parseOrderId(body);
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
    this.cancelBuy(record, false);
    return { order_id: orderId, status: record.status };
  }

  /**
   * Moves a working buy up to the market, on a click: the limit goes to TWS's ask plus
   * `limitOffsetPct`, capped like a new order against the alert's price, and the exits move with
   * it. The quantity stays what it is. One change, sent once: nothing here repeats itself.
   */
  async chase(body: unknown): Promise<ChaseData> {
    const orderId = parseOrderId(body);
    const { record, change } = await this.managed(async () => {
      const order = this.todaysOrder(orderId);
      this.assertChaseable(order);
      const contract = this.contractOf(order);
      const ask = await this.readQuote("ask", order.ticker, contract);
      // The ask took a moment. The buy may have filled or been cancelled in it, the halt may
      // have been pressed, TWS may have gone: everything is asked again, and from here to the
      // last message there is no other wait.
      this.assertChaseable(order);
      return { record: order, change: this.sendChase(order, contract, ask) };
    });
    await this.waitForWord(record.sent.order_ids.parent, change);
    // TWS refuses a change to a buy that filled while the change was on its way: that is the
    // buy done, not a failure. The answer then carries what TWS has, as every answer does.
    const filled = record.status === "Filled" || record.filled_qty >= record.sent.qty;
    if (change.refused !== null && !filled) {
      throw new BridgeError(
        502,
        "tws_refused",
        `TWS refused the new limit for order ${orderId}: ${change.refused}. ` +
          `The buy is ${record.status} at ${formatPrice(record.sent.limit)}; /orders shows where its exits are`,
      );
    }
    return {
      order_id: orderId,
      limit: record.sent.limit,
      take_profit: record.sent.take_profit,
      stop: record.sent.stop,
      stop_limit: record.sent.stop_limit,
      chases: record.chases,
      status: record.status,
    };
  }

  /**
   * Gets out of what an order bought, on a click: a sell limit at TWS's bid less `sellOffsetPct`.
   *
   * It never adds a second way out next to one that is working. While the bracket's take-profit
   * leg is alive, that leg is moved down to the sell limit; when the exits are gone, one plain
   * sell order is placed; a click while a sell is working moves that sell down. It sells no more
   * than the order still holds, and no more than the account's position as TWS reports it at the
   * click: it cannot open a short.
   */
  async sell(body: unknown): Promise<SellData> {
    const orderId = parseOrderId(body);
    const { record, exit, change, filledBefore } = await this.managed(() => this.sellNow(orderId));
    await this.waitForWord(exit.order_id, change);
    if (change.refused !== null) {
      throw new BridgeError(
        502,
        "tws_refused",
        `TWS refused the sell of order ${orderId}: ${change.refused}. /orders shows what is still held; click Sell again`,
      );
    }
    const now = record.exit !== null && record.exit.order_id === exit.order_id ? record.exit : exit;
    if (now.status !== "Filled" && isDone(now.status) && now.filled_qty <= filledBefore) {
      throw new BridgeError(
        502,
        "tws_refused",
        `the sell of order ${orderId} did not go through: its order is ${now.status} in TWS. Click Sell again`,
      );
    }
    return { order_id: orderId, qty: now.qty, limit: now.limit, status: now.status, via: now.via };
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

  /** TWS is connected, and has its own connection to IB's servers. */
  private assertOnline(): void {
    this.requireConnected();
    if (this.link.isServerLinkLost()) {
      throw new BridgeError(
        503,
        "tws_offline",
        "TWS has lost its connection to IB's servers: an order sent now would wait in TWS and go out later",
      );
    }
  }

  /** The `paperOnly` rail. Returns whether the account is a paper one. */
  private assertAccount(): boolean {
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
    return paper;
  }

  /**
   * Every rail, then the prices. Used by `/preview` and `/order` alike and changes nothing, so a
   * preview answers exactly what an order placed at the same moment would.
   *
   * `priceNote` says why the price did not come from where the config says (no live ask, so it
   * was worked out from the alert), or is null. `goodUntilMs` is when a stop entry sent now would
   * stop waiting; null for a buy now.
   */
  private async prepare(request: OrderRequest): Promise<{
    plan: OrderPlan;
    contract: ResolvedContract;
    checks: Check[];
    priceNote: string | null;
    goodUntilMs: number | null;
  }> {
    const { order: orderCfg, limits } = this.config;
    const checks: Check[] = [];
    const now = this.clock();
    const { ticker } = request;
    const stopEntry = request.entry === "stop";
    const goodUntilMs = stopEntry ? stopEntryGoodUntil(now, orderCfg.entryValidSec) : null;

    this.assertTradingOn();
    checks.push({ name: "switches", detail: "orders are enabled and not halted" });

    if (stopEntry) {
      if (!(orderCfg.entryStopPct > 0)) throw stopEntryOff();
      checks.push({
        name: "entry",
        detail:
          `stop entry: a BUY STP LMT ${orderCfg.entryStopPct}% above the alert's price, priced from the alert alone; ` +
          `it waits ${orderCfg.entryValidSec} s, then IB cancels it if nothing has filled`,
      });
    }

    this.assertOnline();
    const paper = this.assertAccount();
    checks.push({ name: "account", detail: paper ? "paper account" : "LIVE account (paperOnly is off)" });

    // One order per alert, whichever tab or reload the click comes from. The ids are strings on
    // both sides (a numeric alert_id was turned into one when the request was read).
    const today = nyDate(now);
    if (request.alertId !== null) {
      const taken = this.book.alertOrderOn(today, request.alertId);
      if (taken !== undefined) {
        throw new BridgeError(
          409,
          "duplicate_alert",
          `this alert already has an order (order ${taken.order_id}, ${taken.ticker}, ` +
            `${nyTime(Date.parse(taken.placed_at))} New York)`,
        );
      }
      checks.push({ name: "alert", detail: "no order uses up this alert today" });
    }

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

    // The quantity: the click's own, else `amountUsd` dollars' worth, else `order.qty` shares. A
    // number of shares is checked here, before TWS is asked anything; dollars become shares only
    // once the limit is known, and are checked there. The check keeps its place in the list.
    const sizedInUsd = request.qty === null && orderCfg.amountUsd > 0;
    const sharesCheckAt = checks.length;
    if (!sizedInUsd) {
      const shares = request.qty ?? orderCfg.qty;
      if (shares > limits.maxShares) {
        throw new BridgeError(422, "too_many_shares", `${shares} shares is above maxShares (${limits.maxShares})`);
      }
      checks.push({ name: "shares", detail: `${shares} of ${limits.maxShares} allowed` });
    }

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
    let priceNote: string | null = null;
    // A stop entry reads no ask: its prices come from the alert alone.
    if (!stopEntry && orderCfg.priceFrom === "ask") {
      try {
        ask = await this.readQuote("ask", ticker, this.ibContract(contract));
      } catch (err) {
        // No live ask (none in time, or TWS refused the snapshot): with `askFallback: "alert"`
        // the buy is priced from the alert instead, and says so. Anything else stops the order.
        if (!(err instanceof BridgeError) || err.code !== "no_ask" || orderCfg.askFallback !== "alert") throw err;
        priceNote =
          err.status === 504
            ? `no live ask from TWS in ${this.askTimeoutMs} ms: priced from the alert`
            : `${err.message}: priced from the alert`;
      }
    }

    const plan = planOrder(ask === null ? { ...orderCfg, priceFrom: "alert" } : orderCfg, {
      qty: request.qty,
      alertPrice: request.alertPrice,
      alertStop: request.alertStop,
      ask,
      entry: request.entry,
    });
    if (sizedInUsd) {
      const amount = `${formatUsd(orderCfg.amountUsd)} at ${formatPrice(plan.limit)}`;
      if (plan.qty > limits.maxShares) {
        throw new BridgeError(
          422,
          "too_many_shares",
          `${amount} is ${plan.qty.toLocaleString("en-US")} shares, above maxShares (${limits.maxShares})`,
        );
      }
      checks.splice(sharesCheckAt, 0, {
        name: "shares",
        detail: `${plan.qty} of ${limits.maxShares} allowed (${amount})`,
      });
    }
    if (plan.trigger !== null && goodUntilMs !== null) {
      checks.push({
        name: "trigger",
        detail:
          `${formatPrice(plan.trigger)} = the alert's price ${formatPrice(plan.basePrice)} + ${orderCfg.entryStopPct}%; ` +
          `the buy waits for it until ${nyTime(goodUntilMs)} New York (${orderCfg.entryValidSec} s)`,
      });
      checks.push({
        name: "limit",
        detail:
          `${formatPrice(plan.limit)} = the trigger + ${orderCfg.entryStopLimitPct}%, rounded up; ` +
          `${plan.chasePct.toFixed(1)}% past the alert. maxChasePct does not apply to a stop entry: ` +
          "its distance from the alert is entryStopPct + entryStopLimitPct",
      });
    } else {
      checks.push({
        name: "limit",
        detail:
          `${formatPrice(plan.limit)} = the ${plan.priceFrom === "ask" ? "ask" : "alert's price"} ` +
          `${formatPrice(plan.basePrice)} + ${orderCfg.limitOffsetPct}%; ` +
          `${plan.chasePct.toFixed(1)}% past the alert (max ${orderCfg.maxChasePct}%)` +
          (priceNote === null ? "" : ` (${priceNote})`),
      });
    }
    checks.push({
      name: "take_profit",
      detail:
        plan.takeProfit === null
          ? "none (takeProfitPct is 0)"
          : `${formatPrice(plan.takeProfit)}, ${orderCfg.takeProfitPct}% above the ${plan.trigger === null ? "limit" : "trigger"}`,
    });
    checks.push({ name: "stop", detail: this.describeStop(plan) });

    if (plan.notional > limits.maxNotionalUsd + 1e-9) {
      throw new BridgeError(
        422,
        "too_large",
        `the order is $${plan.notional.toFixed(2)} (${plan.qty} × ${formatPrice(plan.limit)}` +
          `${sizedInUsd ? `, sized from ${formatUsd(orderCfg.amountUsd)}` : ""}), ` +
          `above maxNotionalUsd ($${limits.maxNotionalUsd})`,
      );
    }
    checks.push({ name: "notional", detail: `$${plan.notional.toFixed(2)} of $${limits.maxNotionalUsd} allowed` });

    return { plan, contract, checks, priceNote, goodUntilMs };
  }

  /**
   * One snapshot of TWS's live ask or bid for a contract. No price in time, or TWS refusing the
   * snapshot, is `no_ask` / `no_bid`: the caller decides whether that stops it.
   */
  private async readQuote(side: "ask" | "bid", ticker: string, contract: Contract): Promise<number> {
    const code = side === "ask" ? "no_ask" : "no_bid";
    let price: number | null;
    try {
      price =
        side === "ask"
          ? await this.link.askSnapshot(contract, this.askTimeoutMs)
          : await this.link.bidSnapshot(contract, this.askTimeoutMs);
    } catch (err) {
      if (err instanceof TwsRequestError) {
        throw new BridgeError(502, code, `TWS gave no ${side} for ${ticker}: ${err.message} (code ${err.code})`);
      }
      throw this.linkError(err, ticker);
    }
    if (price === null) {
      throw new BridgeError(504, code, `no ${side} for ${ticker} from TWS within ${this.askTimeoutMs} ms`);
    }
    return price;
  }

  private describeStop(plan: OrderPlan): string {
    const ignored = plan.alertStopIgnored === null ? "" : `; the alert's stop was not used: ${plan.alertStopIgnored}`;
    if (plan.stop === null || plan.stopLimit === null) return `none (stopPct is 0)${ignored}`;
    const prices = `${formatPrice(plan.stop)}, limit ${formatPrice(plan.stopLimit)}`;
    if (plan.stopFrom === "alert") return `${prices}: the alert's stop`;
    return `${prices}: ${this.config.order.stopPct}% under the ${plan.trigger === null ? "limit" : "trigger"}${ignored}`;
  }

  // ------------------------------------------------------------- sending

  /**
   * Sends the bracket. There is no `await` in here: between the last checks and the last leg
   * nothing else runs, so the connection, the switches and the order ids cannot change under it.
   */
  private send(request: OrderRequest, plan: OrderPlan, contract: ResolvedContract, priceNote: string | null): OrderRecord {
    this.assertTradingOn();
    this.requireConnected();
    const now = this.clock();
    let firstId: number;
    try {
      firstId = this.link.allocateOrderIds(3);
    } catch (err) {
      throw this.linkError(err, request.ticker);
    }
    // A stop entry waits until this moment; IB cancels it then, and the bridge does nothing about it.
    const goodUntilMs = plan.entry === "stop" ? stopEntryGoodUntil(now, this.config.order.entryValidSec) : null;
    const goodTillDate = goodUntilMs === null ? null : ibUtcDateTime(goodUntilMs);
    const legs = buildBracket(plan, firstId, this.config.order.outsideRth, goodTillDate);
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
      sizing: plan.sizing,
      entry: plan.entry,
      sent: {
        qty: plan.qty,
        limit: plan.limit,
        trigger: plan.trigger,
        good_until: goodUntilMs === null ? null : new Date(goodUntilMs).toISOString(),
        take_profit: plan.takeProfit,
        stop: plan.stop,
        stop_limit: plan.stopLimit,
        first_limit: plan.limit,
        first_take_profit: plan.takeProfit,
        first_stop: plan.stop,
        first_stop_limit: plan.stopLimit,
        price_from: plan.priceFrom,
        stop_from: plan.stopFrom,
        outside_rth: this.config.order.outsideRth,
        order_ids: { parent: firstId, take_profit: takeProfitId, stop: stopId },
      },
      chases: 0,
      status: "PendingSubmit",
      filled_qty: 0,
      avg_fill_price: null,
      slip_pct: null,
      held_qty: 0,
      legs: {
        take_profit:
          takeProfitId === null
            ? null
            : { order_id: takeProfitId, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
        stop: stopId === null ? null : { order_id: stopId, status: "PendingSubmit", filled_qty: 0, avg_fill_price: null },
      },
      exit: null,
      loose_exit: false,
      error: null,
      // Set when the price did not come from where the config says (no live ask: from the alert).
      note: priceNote,
    };

    // The log line comes first: an order that cannot be written down is not sent. A stop entry's
    // line also has the time exactly as it goes to TWS.
    try {
      this.journal.writeOrThrow("order_placed", { ...record, ...(goodTillDate === null ? {} : { good_till_date: goodTillDate }) });
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
        this.lastSentMs.set(leg.orderId, now);
        this.orderQty.set(leg.orderId, plan.qty);
      }
    } catch (err) {
      // Earlier legs carry transmit=false, so TWS holds them unsent; take them back out. The
      // cancel goes out also when no leg is known to have arrived: it costs nothing if none did.
      record.error = `sending failed after ${sent} of ${legs.length} legs: ${errorMessage(err)}`;
      this.journal.write("order_error", { order_id: firstId, ticker: record.ticker, message: record.error });
      this.cleanUp(record);
      // The leg that transmits the bracket is the last one. If it was never tried, nothing can
      // fill and TWS will not report on this buy: it is over now. If the failure was on that
      // last leg itself, TWS's answer to the cancel settles it instead.
      if (sent < legs.length - 1) this.markNotWorking(firstId);
      throw new BridgeError(502, "send_failed", `order ${firstId} for ${record.ticker} was not placed: ${record.error}`);
    }

    const buying =
      plan.trigger === null || goodUntilMs === null
        ? `buy ${plan.qty} @ ${formatPrice(plan.limit)}`
        : `stop buy ${plan.qty}, trigger ${formatPrice(plan.trigger)}, limit ${formatPrice(plan.limit)}, ` +
          `until ${nyTime(goodUntilMs)} New York`;
    this.say(
      `order ${firstId} ${record.ticker}: ${buying}` +
        (plan.sizing.amount_usd === undefined ? "" : ` (${formatUsd(plan.sizing.amount_usd)})`) +
        (plan.takeProfit === null ? "" : `, take-profit ${formatPrice(plan.takeProfit)}`) +
        (plan.stop === null || plan.stopLimit === null
          ? ""
          : `, stop ${formatPrice(plan.stop)} / ${formatPrice(plan.stopLimit)}`) +
        (priceNote === null ? "" : ` (${priceNote})`),
    );
    return record;
  }

  // ----------------------------------------------------- chase and sell
  //
  // Both act on an order already in TWS, on a click, and each sends what it sends once. A change
  // to an order is TWS's own way of changing one: the whole order again under its id, with the
  // new price. What the book says after it is what was sent; when TWS refuses a change the book
  // goes back, and when TWS reports an order itself the book follows TWS.

  /** `/chase` and `/sell` one at a time: two clicks never work on the same order at once. */
  private managed<T>(task: () => Promise<T>): Promise<T> {
    const run = this.managing.then(task, task);
    this.managing = run.catch(() => undefined);
    return run;
  }

  private todaysOrder(orderId: number): OrderRecord {
    const record = this.book.getOn(nyDate(this.clock()), orderId);
    if (record === undefined) {
      throw new BridgeError(404, "unknown_order", `order ${orderId} is not a buy order this bridge placed today`);
    }
    return record;
  }

  /** The contract of an order on the book, as it was sent with the order. */
  private contractOf(record: OrderRecord): Contract {
    // TWS writes a class share with a space where the tape uses a dot.
    const contract: Contract = { symbol: record.ticker.replaceAll(".", " "), secType: SecType.STK, exchange: "SMART", currency: "USD" };
    if (record.conid > 0) contract.conId = record.conid;
    return contract;
  }

  /**
   * The quantity to send with a change to an order: the book's, and never more than TWS last
   * said the order has (it may have been made smaller by hand in TWS).
   */
  private quantityFor(orderId: number, bookQty: number): number {
    return Math.min(bookQty, this.orderQty.get(orderId) ?? bookQty);
  }

  /** Two changes to one TWS order too close together: the second would reach TWS while it still works on the first. */
  private assertSpacing(record: OrderRecord, orderIds: Array<number | null>): void {
    const now = this.clock();
    for (const orderId of orderIds) {
      const last = orderId === null ? undefined : this.lastSentMs.get(orderId);
      if (last === undefined) continue;
      const ago = now - last;
      if (ago >= 0 && ago < CHANGE_SPACING_MS) {
        throw new BridgeError(
          409,
          "too_soon",
          `order ${record.order_id} was changed ${Math.round(ago)} ms ago: changes to one order are kept ${CHANGE_SPACING_MS} ms apart`,
        );
      }
    }
  }

  /** Every rail of a chase that needs no word from TWS. Asked before the ask is read and again after. */
  private assertChaseable(record: OrderRecord): void {
    const max = this.config.order.maxChases;
    const id = record.order_id;
    // A stop entry's buy is a stop-limit: a chase would send a limit buy in its place. One that is
    // over (filled or ended) is refused below as any buy is.
    const buyOver = record.status === "Filled" || record.sent.qty - record.filled_qty <= 0 || isDone(record.status);
    if (record.entry === "stop" && !buyOver) {
      const trigger = record.sent.trigger === null ? "its trigger" : formatPrice(record.sent.trigger);
      throw new BridgeError(
        409,
        "not_chaseable",
        record.filled_qty > 0
          ? `order ${id} is a stop entry (trigger ${trigger}) and has part-filled: it cannot be chased`
          : `this buy waits for ${trigger}: cancel it and buy now instead`,
      );
    }
    if (max === 0) {
      throw new BridgeError(409, "chase_limit", "chasing is switched off: order.maxChases is 0 in config.json");
    }
    this.assertTradingOn();
    this.assertOnline();
    this.assertAccount();

    if (record.status === "Filled" || record.sent.qty - record.filled_qty <= 0) {
      throw new BridgeError(409, "already_filled", `order ${id} has filled: there is nothing left to chase`);
    }
    if (isDone(record.status)) {
      throw new BridgeError(409, "already_done", `order ${id} is already ${record.status}`);
    }
    if (record.status === "PendingCancel" || this.cleanedUp.has(id)) {
      throw new BridgeError(409, "already_done", `order ${id} is being cancelled`);
    }
    if (record.chases >= max) {
      throw new BridgeError(
        409,
        "chase_limit",
        `order ${id} has been chased ${record.chases} ${record.chases === 1 ? "time" : "times"} (order.maxChases is ${max})`,
      );
    }
    const ids = record.sent.order_ids;
    this.assertSpacing(record, [ids.parent, ids.take_profit, ids.stop]);
  }

  /**
   * Sends a chase: up to three changes, the buy first, then the take-profit, then the stop. There
   * is no `await` in here.
   *
   * The buy goes first because its price is what the click is for, and because of what a failure
   * part-way leaves behind: the buy at its new limit with an exit still at its old, lower price.
   * That is a bracket with a wider stop or a nearer target than intended, never a stop above the
   * buy. If a message cannot be sent, the ones before it stay sent, the ones after it are not
   * tried, and the book holds exactly that. A change TWS refuses later is put back on the book
   * when TWS says so (`onOrderMessage`). Nothing is sent a second time and nothing is moved back
   * on its own.
   */
  private sendChase(record: OrderRecord, contract: Contract, ask: number): SentChange {
    const cfg = this.config.order;
    const { sent } = record;
    const ids = sent.order_ids;
    const id = record.order_id;
    const before = { limit: sent.limit, take_profit: sent.take_profit, stop: sent.stop, stop_limit: sent.stop_limit };
    const plan = planChase(cfg, {
      ask,
      alertPrice: record.asked.alert_price,
      current: { limit: sent.limit, takeProfit: sent.take_profit, stop: sent.stop, stopLimit: sent.stop_limit },
      stopFrom: sent.stop_from,
    });

    // The messages, in the order they go out. An exit that has ended in TWS is left alone.
    interface Step {
      leg: LegName;
      orderId: number;
      order: Order;
      prices: PriceChange;
      back: PriceChange;
      expect: SentChange["expect"];
    }
    const outsideRth = sent.outside_rth;
    const steps: Step[] = [
      {
        leg: "parent",
        orderId: ids.parent,
        order: buyOrder(this.quantityFor(ids.parent, sent.qty), plan.limit, outsideRth, true),
        prices: { limit: plan.limit },
        back: { limit: before.limit },
        expect: { lmtPrice: plan.limit, auxPrice: null },
      },
    ];
    const takeProfit = record.legs.take_profit;
    if (
      ids.take_profit !== null &&
      takeProfit !== null &&
      !isDone(takeProfit.status) &&
      plan.takeProfit !== null &&
      before.take_profit !== null &&
      differs(plan.takeProfit, before.take_profit)
    ) {
      steps.push({
        leg: "take_profit",
        orderId: ids.take_profit,
        order: takeProfitOrder(this.quantityFor(ids.take_profit, sent.qty), plan.takeProfit, outsideRth, ids.parent, true),
        prices: { take_profit: plan.takeProfit },
        back: { take_profit: before.take_profit },
        expect: { lmtPrice: plan.takeProfit, auxPrice: null },
      });
    }
    const stop = record.legs.stop;
    if (
      ids.stop !== null &&
      stop !== null &&
      !isDone(stop.status) &&
      plan.stop !== null &&
      plan.stopLimit !== null &&
      before.stop !== null &&
      before.stop_limit !== null &&
      (differs(plan.stop, before.stop) || differs(plan.stopLimit, before.stop_limit))
    ) {
      steps.push({
        leg: "stop",
        orderId: ids.stop,
        order: stopOrder(this.quantityFor(ids.stop, sent.qty), plan.stop, plan.stopLimit, outsideRth, ids.parent, true),
        prices: { stop: plan.stop, stop_limit: plan.stopLimit },
        back: { stop: before.stop, stop_limit: before.stop_limit },
        expect: { lmtPrice: plan.stopLimit, auxPrice: plan.stop },
      });
    }

    // The log line comes first, as for an order: a change that cannot be written down is not sent.
    const chases = record.chases + 1;
    const intended: PriceChange = {};
    for (const step of steps) Object.assign(intended, step.prices);
    try {
      this.journal.writeOrThrow("chase", {
        order_id: id,
        ticker: record.ticker,
        ask,
        alert_price: record.asked.alert_price,
        chase_pct: Math.round(plan.chasePct * 100) / 100,
        chases,
        legs: steps.map((step) => step.leg),
        from: before,
        prices: intended,
      });
    } catch (err) {
      throw new BridgeError(500, "log_failed", `order ${id} was NOT changed: the log cannot be written (${errorMessage(err)})`);
    }
    record.chases = chases;

    const now = this.clock();
    const moved: Step[] = [];
    let buyChange: SentChange | null = null;
    for (const step of steps) {
      try {
        this.link.modifyOrder(step.orderId, contract, step.order);
      } catch (err) {
        // Nothing went out at all: the click did not happen for TWS, and is not counted.
        if (moved.length === 0) record.chases = chases - 1;
        const left = steps.slice(moved.length).map((s) => `the ${LEG_WORDS[s.leg]} stays at ${this.describeLeg(record, s.leg)}`);
        const message =
          (moved.length === 0
            ? `order ${id} for ${record.ticker} was not changed`
            : `order ${id} for ${record.ticker}: ${moved.map((s) => `the ${LEG_WORDS[s.leg]} moved to ${this.describeLeg(record, s.leg)}`).join(", ")}, then sending failed`) +
          ` (${errorMessage(err)}): ${left.join(", ")}`;
        if (moved.length > 0) record.error = `chase: ${message}`;
        this.journal.write("chase_failed", {
          order_id: id,
          ticker: record.ticker,
          message,
          chases: record.chases,
          prices: this.pricesOf(record),
          ...(moved.length > 0 ? { error: record.error } : {}),
        });
        throw new BridgeError(502, "send_failed", message);
      }
      this.book.setPrices(id, step.prices);
      this.lastSentMs.set(step.orderId, now);
      this.orderQty.set(step.orderId, step.order.totalQuantity ?? sent.qty);
      const change: SentChange = { what: "chase", atMs: now, expect: step.expect, fresh: false, back: step.back, refused: null };
      this.sentChanges.set(step.orderId, change);
      if (step.leg === "parent") buyChange = change;
      moved.push(step);
    }

    this.say(
      `chase ${id} ${record.ticker}: buy limit ${formatPrice(before.limit)} → ${formatPrice(plan.limit)} ` +
        `(ask ${formatPrice(ask)}, ${plan.chasePct.toFixed(1)}% past the alert, chase ${chases} of ${cfg.maxChases})`,
    );
    // The buy is always the first step, and the loop either sent it or threw.
    if (buyChange === null) throw new BridgeError(500, "internal", "the chase sent nothing");
    return buyChange;
  }

  /** The current prices of a bracket, for a log line that carries the state it left behind. */
  private pricesOf(record: OrderRecord): PriceChange {
    const { sent } = record;
    const prices: PriceChange = { limit: sent.limit };
    if (sent.take_profit !== null) prices.take_profit = sent.take_profit;
    if (sent.stop !== null) prices.stop = sent.stop;
    if (sent.stop_limit !== null) prices.stop_limit = sent.stop_limit;
    return prices;
  }

  private describeLeg(record: OrderRecord, leg: LegName): string {
    const { sent } = record;
    if (leg === "parent") return formatPrice(sent.limit);
    if (leg === "take_profit") return sent.take_profit === null ? "none" : formatPrice(sent.take_profit);
    return sent.stop === null || sent.stop_limit === null ? "none" : `${formatPrice(sent.stop)} / ${formatPrice(sent.stop_limit)}`;
  }

  /** Waits (at most `ackWaitMs`) for TWS's first word about an order the bridge just changed or placed. */
  private waitForWord(orderId: number, change: SentChange): Promise<void> {
    if (this.ackWaitMs <= 0 || change.refused !== null || !this.awaitsAnswer(orderId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wordWaiters.get(orderId) === done) this.wordWaiters.delete(orderId);
        resolve();
      };
      const timer = setTimeout(done, this.ackWaitMs);
      this.wordWaiters.set(orderId, done);
    });
  }

  /**
   * TWS said something about this order. Whoever waits for its answer to a change has it when
   * the change is no longer open (TWS reported the order with it, or refused it), or when the
   * order has ended. A status that only repeats itself in between is not an answer.
   */
  private heard(orderId: number): void {
    const waiting = this.wordWaiters.get(orderId);
    if (waiting !== undefined && !this.awaitsAnswer(orderId)) waiting();
  }

  /** Is a change the bridge sent to this order still open, on an order that is still alive? */
  private awaitsAnswer(orderId: number): boolean {
    const ref = this.book.findLeg(orderId);
    return this.sentChanges.has(orderId) && ref !== undefined && !isDone(ref.state.status);
  }

  /**
   * Waits until `condition` holds, for at most `timeoutMs`: it is asked again each time TWS
   * reports on an order. Resolves with whether it holds. Ends early when TWS goes away.
   */
  private waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    if (timeoutMs <= 0 || this.closed || !this.link.isReady()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.stateWaiters.delete(check);
        resolve(condition());
      };
      const check = (): void => {
        if (condition() || this.closed || !this.link.isReady()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.stateWaiters.add(check);
    });
  }

  private stateChanged(): void {
    for (const check of [...this.stateWaiters]) check();
  }

  /** Sends the cancel of a buy and marks it as asked for; TWS's own word on it comes later. */
  private cancelBuy(record: OrderRecord, forSell: boolean): void {
    const orderId = record.order_id;
    try {
      this.link.cancelOrder(orderId);
    } catch (err) {
      throw this.linkError(err, record.ticker);
    }
    this.book.markCancelAsked(orderId);
    this.journal.write("cancel", { order_id: orderId, ticker: record.ticker, ...(forSell ? { for: "sell" } : {}) });
    this.onOrderStatus({
      orderId,
      status: "PendingCancel",
      filled: record.filled_qty,
      remaining: 0,
      avgFillPrice: record.avg_fill_price ?? 0,
    });
  }

  /** The rails of a sell. A halt and `enabled: false` are not among them: getting out stays possible. */
  private assertSellable(record: OrderRecord): void {
    this.assertOnline();
    this.assertAccount();
    const id = record.order_id;
    if (record.filled_qty <= 0) {
      throw new BridgeError(409, "nothing_to_sell", `order ${id} has bought nothing: there is nothing to sell`);
    }
    if (record.held_qty <= 0) {
      throw new BridgeError(
        409,
        "nothing_to_sell",
        `nothing of order ${id} is still held: the ${record.filled_qty} shares it bought have been sold`,
      );
    }
  }

  /** What a sell does next, from where the order stands. Asked again after every wait. */
  private sellStep(record: OrderRecord): SellStep {
    // A sell is already working: a click moves it, and never adds an order next to it.
    if (record.exit !== null && !isDone(record.exit.status)) return "reprice";
    // The buy can still add shares: its unfilled part is cancelled first.
    if (!isDone(record.status)) return "finish_buy";
    const { take_profit: takeProfit, stop } = record.legs;
    if (takeProfit !== null && !isDone(takeProfit.status)) return "take_profit";
    // No take-profit to move, and a stop still working: it must be out before a new sell goes in,
    // or the two could both sell.
    if (stop !== null && !isDone(stop.status)) return "cancel_stop";
    return "new_order";
  }

  /**
   * One `/sell`, from the click to the one message that sells (and, before it, a cancel when the
   * order's state needs one). After every wait the order is looked at afresh: a fill, a cancel
   * or TWS going away in the meantime changes what is right to do, or ends it.
   */
  private async sellNow(
    orderId: number,
  ): Promise<{ record: OrderRecord; exit: ExitState; change: SentChange; filledBefore: number }> {
    const record = this.todaysOrder(orderId);
    for (let pass = 0; pass < SELL_PASSES; pass += 1) {
      this.assertSellable(record);
      const step = this.sellStep(record);
      if (step === "finish_buy") {
        await this.finishBuy(record);
        continue;
      }
      if (step === "cancel_stop") {
        await this.cancelStop(record);
        continue;
      }
      this.assertSellMayMove(record, step);
      const contract = this.contractOf(record);
      const { bid, position } = await this.readBidAndPosition(record, contract);
      // The bid and the position took a moment: a fill or a cancel may have come in it.
      this.assertSellable(record);
      if (this.sellStep(record) !== step) continue;
      return this.sendSell(record, step, contract, bid, position);
    }
    throw new BridgeError(
      409,
      "busy",
      `order ${orderId} kept changing while it was being sold: nothing more was sent. Look at /orders and click Sell again`,
    );
  }

  /**
   * The buy is still working with part of it filled: its unfilled part is cancelled, and the
   * sell waits for TWS to confirm. TWS may take the bracket's exits with the buy, or keep them
   * for the shares that filled; it is given a moment to say which, and the next look at the
   * order goes by what it said. If it says so only later, the change to the take-profit is
   * refused by TWS, nothing is sold, and the next click finds the exits gone.
   */
  private async finishBuy(record: OrderRecord): Promise<void> {
    if (record.status !== "PendingCancel") this.cancelBuy(record, true);
    const confirmed = await this.waitUntil(() => isDone(record.status), this.cancelWaitMs);
    if (!confirmed) {
      throw new BridgeError(
        504,
        "cancel_pending",
        `nothing was sold yet: the unfilled part of buy ${record.order_id} is being cancelled, and TWS has not ` +
          `confirmed it within ${this.cancelWaitMs} ms. Click Sell again`,
      );
    }
    if (record.status === "Filled") return;
    await this.waitUntil(() => this.liveExits(record) === 0, this.exitsSettleMs);
  }

  private liveExits(record: OrderRecord): number {
    const { take_profit: takeProfit, stop } = record.legs;
    return (takeProfit !== null && !isDone(takeProfit.status) ? 1 : 0) + (stop !== null && !isDone(stop.status) ? 1 : 0);
  }

  /** A stop with no take-profit beside it is cancelled, and confirmed cancelled, before a sell order goes in. */
  private async cancelStop(record: OrderRecord): Promise<void> {
    const stop = record.legs.stop;
    if (stop === null) return;
    if (stop.status !== "PendingCancel") {
      try {
        this.link.cancelOrder(stop.order_id);
      } catch (err) {
        throw this.linkError(err, record.ticker);
      }
      this.journal.write("cancel", {
        order_id: record.order_id,
        ticker: record.ticker,
        leg: "stop",
        leg_order_id: stop.order_id,
        for: "sell",
      });
      this.onOrderStatus({
        orderId: stop.order_id,
        status: "PendingCancel",
        filled: stop.filled_qty,
        remaining: 0,
        avgFillPrice: stop.avg_fill_price ?? 0,
      });
    }
    const confirmed = await this.waitUntil(() => isDone(stop.status), this.cancelWaitMs);
    if (!confirmed) {
      throw new BridgeError(
        504,
        "cancel_pending",
        `nothing was sold yet: the stop of order ${record.order_id} has to be cancelled before a sell order goes in, ` +
          `and TWS has not confirmed it within ${this.cancelWaitMs} ms. Click Sell again`,
      );
    }
  }

  /** The counters of a sell that moves an order TWS already has. */
  private assertSellMayMove(record: OrderRecord, step: SellStep): void {
    if (step === "reprice" && record.exit !== null) {
      const max = this.config.order.maxChases;
      if (record.exit.reprices >= max) {
        throw new BridgeError(
          409,
          "chase_limit",
          `the sell of order ${record.order_id} has been moved ${record.exit.reprices} ` +
            `${record.exit.reprices === 1 ? "time" : "times"} (order.maxChases is ${max})`,
        );
      }
      this.assertSpacing(record, [record.exit.order_id]);
    } else if (step === "take_profit") {
      this.assertSpacing(record, [record.sent.order_ids.take_profit]);
    }
  }

  private async readBidAndPosition(record: OrderRecord, contract: Contract): Promise<{ bid: number; position: number }> {
    // Both are asked at once; the position's answer is waited for also when the bid fails first.
    const positionRead = this.readPosition(record);
    positionRead.catch(() => undefined);
    const bid = await this.readQuote("bid", record.ticker, contract);
    const position = await positionRead;
    return { bid, position };
  }

  /**
   * The account's position in the order's contract, read from TWS now. With several accounts in
   * the login it is the smallest of theirs: the bridge cannot tell which one an order would sell
   * from. If TWS does not answer in time, or a line cannot be read, there is no position to go
   * by and the sell is refused.
   */
  private async readPosition(record: OrderRecord): Promise<number> {
    let rows: PositionRow[];
    try {
      rows = await this.link.positions(this.positionTimeoutMs);
    } catch (err) {
      if (err instanceof TwsTimeoutError) {
        throw new BridgeError(
          504,
          "no_position",
          `nothing was sold: TWS did not report the account's position in ${record.ticker} within ${this.positionTimeoutMs} ms`,
        );
      }
      throw this.linkError(err, record.ticker);
    }
    const byAccount = new Map<string, number>();
    for (const account of this.link.getAccounts()) byAccount.set(account, 0);
    for (const row of rows) {
      if (row.conid === record.conid) byAccount.set(row.account, row.position);
    }
    let position = byAccount.size === 0 ? 0 : Number.POSITIVE_INFINITY;
    for (const held of byAccount.values()) position = Math.min(position, held);
    if (!Number.isFinite(position)) {
      throw new BridgeError(502, "no_position", `nothing was sold: TWS's report of the position in ${record.ticker} could not be read`);
    }
    return Math.floor(position);
  }

  /**
   * Sends the one message of a sell. There is no `await` in here: the quantity is worked out from
   * the book and the position as they are now, and goes out at once.
   *
   * The quantity is the smaller of what the order still holds by the book and what the account
   * holds (less what another order's unfinished sell has already spoken for). A change to an
   * order never carries more than the order has.
   */
  private sendSell(
    record: OrderRecord,
    step: SellStep,
    contract: Contract,
    bid: number,
    position: number,
  ): { record: OrderRecord; exit: ExitState; change: SentChange; filledBefore: number } {
    const cfg = this.config.order;
    const id = record.order_id;
    const { ticker } = record;
    const limit = sellLimit(cfg, bid);
    const from = `the bid ${formatPrice(bid)} − ${formatPct(cfg.sellOffsetPct)}`;

    const claimed = this.book.claimedBySells(record.conid, id);
    const target = Math.min(record.held_qty, position - claimed);
    if (target <= 0) {
      throw new BridgeError(
        409,
        "nothing_to_sell",
        `nothing was sold: by the bridge's book order ${id} still holds ${record.held_qty} ${ticker}, ` +
          `but the account's position in TWS is ${position}` +
          (claimed > 0 ? `, and ${claimed} of it is being sold for another order` : "") +
          ". The bridge does not sell what the account does not hold",
      );
    }

    const now = this.clock();
    const previousExit = record.exit;
    const logged = { order_id: id, ticker, bid, position, held: record.held_qty };
    const notLogged = (err: unknown): BridgeError =>
      new BridgeError(500, "log_failed", `nothing was sold: the log cannot be written (${errorMessage(err)})`);

    if (step === "new_order") {
      let exitId: number;
      try {
        exitId = this.link.allocateOrderIds(1);
      } catch (err) {
        throw this.linkError(err, ticker);
      }
      const exit: ExitState = {
        via: "new_order",
        order_id: exitId,
        qty: target,
        limit,
        first_limit: limit,
        bid,
        reprices: 0,
        sent_at: new Date(now).toISOString(),
        status: "PendingSubmit",
        filled_qty: 0,
        avg_fill_price: null,
        exit_pct: null,
      };
      try {
        this.journal.writeOrThrow("sell", { ...logged, via: exit.via, qty: target, limit, reprice: false, exit: { ...exit } });
      } catch (err) {
        throw notLogged(err);
      }
      this.book.setExit(id, exit);
      const change: SentChange = { what: "sell", atMs: now, expect: { lmtPrice: limit, auxPrice: null }, fresh: true, back: {}, refused: null };
      try {
        this.link.placeOrder(exitId, contract, sellOrder(target, limit, cfg.outsideRth));
      } catch (err) {
        // It never went out: TWS will not report on it, so it gets its final status here.
        const message = `the sell order ${exitId} for ${ticker} was not placed: ${errorMessage(err)}`;
        record.error = message;
        this.journal.write("sell_failed", { order_id: id, ticker, leg_order_id: exitId, message, error: message });
        this.markNotWorking(exitId);
        throw new BridgeError(502, "send_failed", `nothing was sold: ${message}`);
      }
      this.lastSentMs.set(exitId, now);
      this.orderQty.set(exitId, target);
      this.sentChanges.set(exitId, change);
      this.say(`sell ${id} ${ticker}: new order ${exitId}, ${target} @ ${formatPrice(limit)} (${from})`);
      return { record, exit, change, filledBefore: 0 };
    }

    // The other two move an order TWS already has: the bracket's take-profit leg, or the sell a
    // click before this one started.
    const viaTakeProfit = step === "take_profit" || previousExit?.via === "take_profit";
    const selling = step === "reprice" && previousExit !== null ? this.book.findLeg(previousExit.order_id) : undefined;
    const leg = viaTakeProfit ? record.legs.take_profit : (selling?.state ?? null);
    const legId = viaTakeProfit ? record.sent.order_ids.take_profit : (previousExit?.order_id ?? null);
    if (leg === null || legId === null) {
      throw new BridgeError(409, "busy", `order ${id} changed while it was being sold: nothing was sent. Click Sell again`);
    }
    const current = step === "reprice" && previousExit !== null ? previousExit.limit : record.sent.take_profit;
    // A sell only ever moves down. An order already at or under the new limit is marketable as it stands.
    if (current !== null && !(limit < current - PRICE_EPS)) {
      throw new BridgeError(
        409,
        "no_change",
        `the ${step === "reprice" ? "sell limit" : "take-profit"} ${formatPrice(current)} is already at or below ${from}`,
      );
    }
    const bookTotal = viaTakeProfit ? record.sent.qty : (previousExit?.qty ?? target);
    const total = Math.min(this.quantityFor(legId, bookTotal), leg.filled_qty + target);
    if (total <= leg.filled_qty) {
      throw new BridgeError(409, "nothing_to_sell", `nothing was sold: the ${LEG_WORDS[viaTakeProfit ? "take_profit" : "exit"]} order of ${id} has nothing left to sell`);
    }

    const exit: ExitState =
      step === "reprice" && previousExit !== null
        ? { ...previousExit, limit, bid, reprices: previousExit.reprices + 1, qty: viaTakeProfit ? previousExit.qty : total }
        : {
            via: "take_profit",
            order_id: legId,
            qty: total - leg.filled_qty,
            limit,
            first_limit: limit,
            bid,
            reprices: 0,
            sent_at: new Date(now).toISOString(),
            status: leg.status,
            filled_qty: leg.filled_qty,
            avg_fill_price: leg.avg_fill_price,
            exit_pct: null,
          };
    const prices: PriceChange = viaTakeProfit ? { take_profit: limit } : {};
    const back: PriceChange = viaTakeProfit && record.sent.take_profit !== null ? { take_profit: record.sent.take_profit } : {};
    try {
      this.journal.writeOrThrow("sell", {
        ...logged,
        via: exit.via,
        qty: total - leg.filled_qty,
        limit,
        reprice: step === "reprice",
        leg_order_id: legId,
        prices,
        exit: { ...exit },
      });
    } catch (err) {
      throw notLogged(err);
    }
    const order = viaTakeProfit
      ? takeProfitOrder(total, limit, record.sent.outside_rth, record.sent.order_ids.parent, true)
      : sellOrder(total, limit, cfg.outsideRth);
    try {
      this.link.modifyOrder(legId, contract, order);
    } catch (err) {
      // Nothing went out: the order is where it was, and the book says so.
      const message = `the ${LEG_WORDS[viaTakeProfit ? "take_profit" : "exit"]} order ${legId} of ${ticker} was not moved: ${errorMessage(err)}`;
      this.journal.write("sell_failed", { order_id: id, ticker, leg_order_id: legId, message, prices: back, exit: previousExit });
      throw new BridgeError(502, "send_failed", `nothing was sold: ${message}`);
    }
    const filledBefore = leg.filled_qty;
    this.book.setPrices(id, prices);
    this.book.setExit(id, exit);
    this.lastSentMs.set(legId, now);
    this.orderQty.set(legId, total);
    const change: SentChange = {
      what: "sell",
      atMs: now,
      expect: { lmtPrice: limit, auxPrice: null },
      fresh: false,
      back,
      backExit: previousExit,
      refused: null,
    };
    this.sentChanges.set(legId, change);
    this.say(
      `sell ${id} ${ticker}: ${viaTakeProfit ? "take-profit" : "sell order"} ${legId} moved to ${formatPrice(limit)} ` +
        `for ${total - leg.filled_qty} (${from})`,
    );
    return { record, exit, change, filledBefore };
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
      this.book.markCancelAsked(record.order_id);
      this.journal.write("order_cleanup", { order_id: record.order_id, ticker: record.ticker });
    } catch {
      // Not connected: nothing can be cancelled now; the error stays on the record.
    }
  }

  /**
   * Gives a buy that TWS will never report on its final status ("Inactive"): one that never went
   * out, or one TWS says it does not have. Without it such a buy would read as pending for the
   * rest of the day and keep its alert used up, though nothing of it can ever fill. The same for
   * a `/sell` order: one left reading as working would keep the next sell from placing another.
   */
  private markNotWorking(orderId: number): void {
    const ref = this.book.findLeg(orderId);
    if (ref === undefined || isDone(ref.state.status)) return;
    // A buy that has filled anything keeps the status TWS gave it. A sell-side order TWS says it
    // does not have is not working, whatever it sold before.
    if (ref.leg === "parent" && ref.state.filled_qty > 0) return;
    this.onOrderStatus({
      orderId,
      status: STATUS_NOT_WORKING,
      filled: ref.state.filled_qty,
      remaining: 0,
      avgFillPrice: 0,
    });
  }

  /**
   * Cancels a `/sell` order TWS has refused, once. A refusal does not always come with a final
   * status, and the next sell must not place an order next to one that might still be working:
   * the answer to this cancel (cancelled, or "no such order") is TWS's own last word on it.
   */
  private cleanUpSell(record: OrderRecord, orderId: number): void {
    if (this.cleanedUp.has(orderId)) return;
    const ref = this.book.findLeg(orderId);
    if (ref === undefined || isDone(ref.state.status)) return;
    this.cleanedUp.add(orderId);
    try {
      this.link.cancelOrder(orderId);
      this.journal.write("sell_cleanup", { order_id: record.order_id, ticker: record.ticker, leg_order_id: orderId });
    } catch {
      // Not connected: nothing can be cancelled now; the error stays on the record.
    }
  }

  // ------------------------------------------------- exits left behind
  //
  // An order that holds nothing any more must have no sell order of its own left working: such
  // an order (a stop, most likely) would sell shares that are not there, and open a short. TWS
  // cancels the other exit of a bracket itself when one fills. This is the net under that: if a
  // sell order of a flat order is still working after a grace period, the bridge cancels it,
  // once, by its id. It never sends anything but that cancel, and never for an order that still
  // holds shares or whose buy can still fill.

  /**
   * The sell orders of this bracket that work on nothing: none unless the buy is over (it can
   * add no more shares: TWS has said it ended, or it has filled in full), it bought something,
   * and all of that has been sold.
   */
  private looseExits(record: OrderRecord): Array<{ leg: BookLeg; orderId: number }> {
    const buyOver = isDone(record.status) || record.filled_qty >= record.sent.qty;
    if (!(record.filled_qty > 0) || record.held_qty > 0 || !buyOver) return [];
    return this.book
      .sellOrders(record.order_id)
      .filter(({ leg, state }) => {
        if (isDone(state.status)) return false;
        // An order that has sold its whole quantity is over, also before TWS has said "Filled"
        // (after a restart TWS reports the fills of an order it has finished, not its status).
        const whole = leg === "exit" ? (record.exit?.order_id === state.order_id ? record.exit.qty : Number.POSITIVE_INFINITY) : record.sent.qty;
        return state.filled_qty < (this.orderQty.get(state.order_id) ?? whole);
      })
      .map(({ leg, state }) => ({ leg, orderId: state.order_id }));
  }

  /**
   * Looks at an order after anything changed on it. The first time it is seen flat with a sell
   * order still working, the grace period starts; when none is working any more, the watch ends.
   * `loose_exit` on the record is true from the end of the grace period until then.
   */
  private watchFlat(record: OrderRecord): void {
    const id = record.order_id;
    const watch = this.flatWatches.get(id);
    if (this.looseExits(record).length === 0) {
      if (watch !== undefined) {
        if (watch.timer !== null) clearTimeout(watch.timer);
        this.flatWatches.delete(id);
      }
      record.loose_exit = false;
      return;
    }
    if (watch !== undefined) {
      // The grace period is over and something works (again): a sell order that came back to
      // life after it, say. What has not been asked to cancel yet is asked now.
      if (watch.due) this.cancelLooseExits(record);
      return;
    }
    if (this.closed || !this.link.isReady()) return;
    const started: FlatWatch = { timer: null, due: false };
    started.timer = setTimeout(() => {
      started.timer = null;
      if (this.flatWatches.get(id) !== started) return;
      started.due = true;
      try {
        this.cancelLooseExits(record);
      } catch (err) {
        // A timer has nobody to answer to: said and logged, never thrown.
        this.journal.write("internal_error", { where: "exit clean-up", message: errorMessage(err) });
        console.error("tws-bridge: error in the exit clean-up:", err);
      }
    }, this.exitGraceMs);
    this.flatWatches.set(id, started);
  }

  /**
   * The grace period is over: every sell order of the flat order that is still working, and has
   * not been asked to cancel before, is cancelled. One cancel per order id, ever; nothing else is
   * sent. TWS's answer (cancelled, or "no such order") ends it.
   */
  private cancelLooseExits(record: OrderRecord): void {
    const id = record.order_id;
    for (const { leg, orderId } of this.looseExits(record)) {
      const ref = this.book.findLeg(orderId);
      // A cancel already asked for (by this, or by a `/sell` that had to cancel the stop first) is not asked twice.
      if (ref === undefined || ref.state.status === "PendingCancel" || this.cleanedUp.has(orderId)) continue;
      try {
        this.link.cancelOrder(orderId);
      } catch {
        // Not connected: nothing went out. The order is looked at again when TWS is back.
        continue;
      }
      this.cleanedUp.add(orderId);
      const why =
        `order ${id} holds nothing any more (${record.filled_qty} bought, all sold) and its ${LEG_WORDS[leg]} order ${orderId} ` +
        `was still working ${this.exitGraceMs} ms later`;
      const note = `${why}: the bridge cancelled it`;
      record.note = note;
      this.journal.write("exit_cleanup", { order_id: id, ticker: record.ticker, leg, leg_order_id: orderId, why, note });
      this.say(`order ${id} ${record.ticker}: ${LEG_WORDS[leg]} order ${orderId} left working on nothing: cancelled`);
      this.onOrderStatus({
        orderId,
        status: "PendingCancel",
        filled: ref.state.filled_qty,
        remaining: 0,
        avgFillPrice: ref.state.avg_fill_price ?? 0,
      });
    }
    record.loose_exit = this.looseExits(record).length > 0;
  }

  /** Every order on the book is looked at afresh: at a connection, once TWS has had the grace period to report. */
  private watchAllFlat(): void {
    this.endFlatWatches();
    for (const record of this.book.all()) this.watchFlat(record);
  }

  private endFlatWatches(): void {
    for (const watch of this.flatWatches.values()) {
      if (watch.timer !== null) clearTimeout(watch.timer);
    }
    this.flatWatches.clear();
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
    this.conidTickers.set(contract.conid, ticker);
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
    // An order that holds nothing with a sell order of its own still working, by the book as it
    // was rebuilt from the log or left by the last connection: TWS gets the grace period to say
    // otherwise (its open orders and today's fills are on their way), then that order is cancelled.
    this.watchAllFlat();
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
    this.endGroupReport();
    this.conidLookups.clear();
    this.conidUnknown.clear();
    this.lastFocus.clear();
    this.groupTrail.clear();
    this.unnamedOnConsole.clear();
    // What TWS made of a change sent just before the drop is not known. Nothing waits for its
    // answer any more; TWS's own report of the orders after the reconnect sets the book right.
    this.sentChanges.clear();
    for (const done of [...this.wordWaiters.values()]) done();
    this.stateChanged();
    // Nothing can be cancelled while TWS is away: the orders are looked at again when it is back.
    this.endFlatWatches();
    this.journal.write("tws_down", { reason });
    this.say(`TWS not connected: ${reason} (retrying)`);
  }

  private onNote(kind: string, noteFields: Record<string, unknown>): void {
    this.journal.write(kind, noteFields);
    if (kind === "display_group_error") {
      this.say(`TWS refused display group ${String(noteFields["group"])}: ${String(noteFields["message"])}`);
    }
  }

  // ------------------------------------------------------ display groups
  //
  // Which numbered group shows which ticker, so `displayGroup` can be set without guessing. The
  // link subscribes to every group TWS lists; here the contract ids become tickers and the
  // console is told once per connection. All of it is reading: nothing here can change a window,
  // and its messages wait their turn in the link's background queue, behind any click.

  /** What each display group shows now, with contract ids turned into tickers where known. */
  private groupReadings(): GroupReading[] {
    return this.link.getDisplayGroupContents().map(({ id, contractInfo }) => {
      if (contractInfo === null) return { id, shows: null, answered: false };
      const content = parseContractInfo(contractInfo);
      if (content.kind === "none") return { id, shows: null, answered: true };
      if (content.kind === "combo") return { id, shows: "combo", answered: true };
      if (content.kind === "other") return { id, shows: content.text, answered: true };
      return { id, shows: this.conidTickers.get(content.conid) ?? contractInfo, answered: true };
    });
  }

  /** TWS has listed its groups: the report is due when they have all answered, or after the wait. */
  private onDisplayGroups(): void {
    if (this.groupReport !== null) return;
    const report: { timer: NodeJS.Timeout | null; said: boolean } = { timer: null, said: false };
    this.groupReport = report;
    report.timer = setTimeout(() => {
      report.timer = null;
      if (this.groupReport === report) this.sayDisplayGroups();
    }, this.groupReportMs);
    this.maybeSayDisplayGroups();
  }

  private onDisplayGroupShows(group: number, contractInfo: string, detail: DisplayGroupEvent): void {
    const content = parseContractInfo(contractInfo);
    this.noteGroupEvent(group, contractInfo, content, detail);
    if (content.kind === "contract") this.lookUpConid(content.conid, content.exchange);
    this.maybeSayDisplayGroups();
  }

  /**
   * Writes what a group now shows to the log, every time TWS says so, and for the configured
   * group to the console as well: the trail to hold a `/focus` against. Nothing is thinned out;
   * only an event that repeats the one before it word for word, with no `/focus` in between, is
   * left out.
   *
   * `cause` is "focus" when the event names the contract a `/focus` sent to that group within the
   * last 2 s, "initial" for the first thing a group says on a connection, and "tws" otherwise
   * (the operator, or TWS itself, changed it).
   */
  private noteGroupEvent(group: number, contractInfo: string, content: GroupContent, detail: DisplayGroupEvent): void {
    const focus = this.lastFocus.get(group);
    const focusSeq = focus?.seq ?? 0;
    const before = this.groupTrail.get(group);
    if (before !== undefined && before.raw === detail.raw && before.focusSeq === focusSeq) return;
    this.groupTrail.set(group, { raw: detail.raw, focusSeq });

    const ticker = content.kind === "contract" ? (this.conidTickers.get(content.conid) ?? null) : null;
    const sinceFocus = focus === undefined ? Number.NaN : this.clock() - focus.atMs;
    const followsFocus =
      focus !== undefined &&
      content.kind === "contract" &&
      content.conid === focus.conid &&
      sinceFocus >= 0 &&
      sinceFocus <= FOCUS_ANSWER_MS;
    const cause = followsFocus ? "focus" : before === undefined ? "initial" : "tws";
    this.journal.write("display_group_shows", {
      group,
      contract_info: detail.raw.slice(0, 256),
      ticker,
      request_id: detail.requestId,
      cause,
    });

    // The console: the configured group only, and not its first reading (the report covers that).
    if (group !== this.config.displayGroup || cause === "initial") return;
    let what: string;
    if (content.kind === "none") what = "nothing";
    else if (content.kind === "combo") what = "a combo";
    else if (ticker !== null) what = `${ticker} (${contractInfo})`;
    else what = contractInfo;
    if (content.kind === "contract" && ticker === null) this.unnamedOnConsole.add(content.conid);
    this.say(`group ${group} now shows ${what} ${cause === "focus" ? "← focus" : "← changed in TWS"}`);
  }

  /** A contract id now has its ticker: logged, and said if the console showed the bare number. */
  private onConidNamed(conid: number, ticker: string): void {
    this.journal.write("display_group_ticker", { conid, ticker });
    if (!this.unnamedOnConsole.delete(conid)) return;
    const group = this.config.displayGroup;
    const shown = this.link.getDisplayGroupContents().find((content) => content.id === group)?.contractInfo;
    const content = shown === null || shown === undefined ? null : parseContractInfo(shown);
    if (content?.kind === "contract" && content.conid === conid) this.say(`group ${group}: ${shown} is ${ticker}`);
  }

  /**
   * Asks TWS, in the background and once, which ticker a contract id is. The exchange the group
   * named goes with it: the pair is how TWS itself identifies what the window shows.
   */
  private lookUpConid(conid: number, exchange: string): void {
    if (this.conidTickers.has(conid) || this.conidUnknown.has(conid) || this.conidLookups.has(conid)) return;
    this.conidLookups.add(conid);
    const queued = this.link.inBackground(() => {
      // By the time its turn comes the operator may have moved on: then nobody needs the answer.
      const shown = this.link.getDisplayGroupContents().some(({ contractInfo }) => {
        const content = contractInfo === null ? null : parseContractInfo(contractInfo);
        return content?.kind === "contract" && content.conid === conid;
      });
      if (!shown) {
        this.conidLookups.delete(conid);
        return;
      }
      let lookup: Promise<ContractDetails[]>;
      try {
        lookup = this.link.contractDetails(
          exchange === "" ? { conId: conid } : { conId: conid, exchange },
          this.groupLookupTimeoutMs,
        );
      } catch {
        this.conidLookups.delete(conid);
        return;
      }
      lookup.then(
        (details) => {
          this.conidLookups.delete(conid);
          const ticker = tickerOfConid(conid, details);
          if (ticker === null) {
            this.conidUnknown.add(conid);
          } else {
            this.conidTickers.set(conid, ticker);
            this.onConidNamed(conid, ticker);
          }
          this.maybeSayDisplayGroups();
        },
        (err: unknown) => {
          // TWS refused or was slow: the group keeps reading as "<conid>@<exchange>". A dropped
          // connection is no answer at all: the next connection may ask again.
          this.conidLookups.delete(conid);
          if (!(err instanceof NotConnectedError)) this.conidUnknown.add(conid);
          this.maybeSayDisplayGroups();
        },
      );
    });
    if (!queued) this.conidLookups.delete(conid);
  }

  /** Says the report as soon as every listed group has answered and no ticker is still on its way. */
  private maybeSayDisplayGroups(): void {
    if (this.groupReport === null || this.groupReport.said) return;
    const listed = this.link.getDisplayGroups();
    if (listed === null) return;
    for (const { id, contractInfo } of this.link.getDisplayGroupContents()) {
      if (!listed.includes(id)) continue;
      if (contractInfo === null) return;
      const content = parseContractInfo(contractInfo);
      if (content.kind !== "contract") continue;
      if (!this.conidTickers.has(content.conid) && !this.conidUnknown.has(content.conid)) return;
    }
    this.sayDisplayGroups();
  }

  private sayDisplayGroups(): void {
    const report = this.groupReport;
    if (report === null || report.said || !this.link.isReady()) return;
    report.said = true;
    if (report.timer !== null) {
      clearTimeout(report.timer);
      report.timer = null;
    }
    const listed = this.link.getDisplayGroups() ?? [];
    const readings = this.groupReadings().filter((group) => listed.includes(group.id));
    for (const line of describeDisplayGroups(this.config.displayGroup, readings)) this.say(line);
    this.journal.write("display_groups_shown", { display_group: this.config.displayGroup, groups: readings });
  }

  private endGroupReport(): void {
    if (this.groupReport === null) return;
    if (this.groupReport.timer !== null) clearTimeout(this.groupReport.timer);
    this.groupReport = null;
  }

  private onOrderStatus(event: OrderStatusEvent): void {
    const ref = this.book.applyStatus(event);
    if (ref !== null) {
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
      if (leg === "parent") {
        this.noteExpiry(record);
        this.ackWaiters.get(record.order_id)?.();
      }
      this.watchFlat(record);
    }
    // TWS's word on the order, also when it only repeats itself: whoever waits on this order looks again.
    this.heard(event.orderId);
    this.stateChanged();
  }

  /**
   * A stop entry that has ended Cancelled with nothing filled, at (or after) its time, and that
   * the bridge was not asked to cancel, has expired: IB cancelled it as it was told to. The order
   * gets a note that says so, once, and the log a line that brings the note back at a start.
   * Nothing is sent: the alert is free again by the usual rule (ended, nothing filled).
   */
  private noteExpiry(record: OrderRecord): void {
    const id = record.order_id;
    if (record.entry !== "stop" || record.sent.good_until === null) return;
    if (record.status !== "Cancelled" || record.filled_qty > 0) return;
    if (this.book.isExpired(id) || this.book.cancelAsked(id)) return;
    const untilMs = Date.parse(record.sent.good_until);
    if (!Number.isFinite(untilMs) || this.clock() < untilMs - EXPIRY_CLOCK_SLACK_MS) return;
    const note = `expired unfilled at ${nyTime(untilMs)} New York`;
    this.book.markExpired(id);
    record.note = note;
    this.journal.write("entry_expired", { order_id: id, ticker: record.ticker, good_until: record.sent.good_until, note });
    this.say(`order ${id} ${record.ticker}: the stop entry ${note}`);
  }

  /**
   * TWS's own report of one of our orders: its price and quantity as TWS has them now. It comes
   * after the bridge places or changes an order, after a change made by hand in TWS, and for
   * every open order when the bridge connects.
   *
   * The book follows it: whatever the bridge sent last, what TWS says an order is, it is. So a
   * buy dragged to another price in TWS is chased from that price, and a change TWS did not take
   * does not stay on the book. A report that shows the change the bridge sent is also what ends
   * the wait for a refusal of it.
   */
  private onOpenOrder(event: OpenOrderEvent): void {
    const ref = this.book.findLeg(event.orderId);
    if (ref === undefined) return;
    const { record, leg } = ref;
    // Our buy is a buy and every other order of a bracket a sell: anything else is not that order.
    if (event.action !== null && event.action !== (leg === "parent" ? "BUY" : "SELL")) return;

    const qty = positive(event.totalQuantity);
    if (qty !== null) this.orderQty.set(event.orderId, qty);
    const limit = positive(event.lmtPrice);
    const aux = positive(event.auxPrice);
    const { sent } = record;
    const prices: PriceChange = {};
    if (leg === "parent") {
      if (limit !== null && differs(limit, sent.limit)) prices.limit = limit;
      // A stop entry's trigger is the buy's stop price.
      if (aux !== null && sent.trigger !== null && differs(aux, sent.trigger)) prices.trigger = aux;
      if (qty !== null && Number.isInteger(qty) && qty !== sent.qty) prices.qty = qty;
    } else if (leg === "take_profit") {
      if (limit !== null && sent.take_profit !== null && differs(limit, sent.take_profit)) prices.take_profit = limit;
    } else if (leg === "stop") {
      if (aux !== null && sent.stop !== null && differs(aux, sent.stop)) prices.stop = aux;
      if (limit !== null && sent.stop_limit !== null && differs(limit, sent.stop_limit)) prices.stop_limit = limit;
    }
    // The order a `/sell` works through (the take-profit leg, or its own) carries the sell's limit.
    const selling = record.exit;
    const exit =
      selling !== null && selling.order_id === event.orderId && limit !== null && differs(limit, selling.limit)
        ? { ...selling, limit }
        : undefined;

    const change = this.sentChanges.get(event.orderId);
    if (change !== undefined) {
      const taken =
        limit !== null &&
        !differs(limit, change.expect.lmtPrice) &&
        (change.expect.auxPrice === null || (aux !== null && !differs(aux, change.expect.auxPrice)));
      if (taken) {
        this.sentChanges.delete(event.orderId);
      } else {
        // TWS's word on the order while the change is still unanswered (a report from before it
        // took the change, or a price it set itself): if it then refuses the change, this, not
        // what the book had before, is what the order is.
        if (leg === "parent" && limit !== null) change.back = { ...change.back, limit };
        if (leg === "take_profit" && limit !== null) change.back = { ...change.back, take_profit: limit };
        if (leg === "stop" && aux !== null) change.back = { ...change.back, stop: aux };
        if (leg === "stop" && limit !== null) change.back = { ...change.back, stop_limit: limit };
        if (change.backExit !== undefined && change.backExit !== null && limit !== null) {
          change.backExit = { ...change.backExit, limit };
        }
      }
    }

    if (Object.keys(prices).length > 0 || exit !== undefined) {
      this.book.setPrices(record.order_id, prices);
      if (exit !== undefined) this.book.setExit(record.order_id, exit);
      this.journal.write("order_open", {
        order_id: record.order_id,
        ticker: record.ticker,
        leg,
        leg_order_id: event.orderId,
        prices,
        ...(exit !== undefined ? { exit: { ...exit } } : {}),
      });
    }
    this.heard(event.orderId);
    this.stateChanged();
  }

  private onExecution(event: ExecutionEvent): void {
    const ref = this.book.applyExecution(event);
    if (ref === null) return;
    this.stateChanged();
    const { record, leg, state } = ref;
    this.watchFlat(record);
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
    const { record, leg, state } = ref;
    const message = `${LEG_WORDS[leg]}: ${event.message} (code ${event.code})`;
    const entry = { order_id: record.order_id, ticker: record.ticker, leg, leg_order_id: event.orderId, code: event.code, message };
    // TWS says it has no such order. About a buy or a `/sell` order that settles it; about an
    // exit of a bracket it does when it answers a cancel the bridge itself asked for.
    const notFound =
      ORDER_NOT_FOUND_CODES.has(event.code) && (leg === "parent" || leg === "exit" || state.status === "PendingCancel");

    // Is this TWS's answer to a change the bridge sent to this order a moment ago? Then it is
    // the change that was refused, not the order: the order stands as it stood, and so must the
    // book. A message about a cancel the bridge asked for is about that cancel.
    const change = this.sentChanges.get(event.orderId);
    if (change !== undefined) {
      const cancelAsked = state.status === "PendingCancel";
      const inTime = this.clock() - change.atMs <= CHANGE_ANSWER_MS;
      const saysNo = !event.nonFatal || CHANGE_REFUSED_NOTICE_CODES.has(event.code);
      if (cancelAsked || !inTime) {
        this.sentChanges.delete(event.orderId);
      } else if (saysNo) {
        this.sentChanges.delete(event.orderId);
        change.refused = message;
        if (!change.fresh) {
          this.changeRefused(record, leg, event, change, message);
          if (notFound) this.markNotWorking(event.orderId);
          this.heard(event.orderId);
          this.stateChanged();
          return;
        }
        // A new sell order TWS refused: handled below like any refused order.
      }
    }

    if (event.nonFatal || CANCEL_NOTICE_CODES.has(event.code)) {
      // A notice about the buy of a stop entry that expired ("Order Canceled", say) does not take
      // the place of the note that says it expired.
      if (!(leg === "parent" && this.book.isExpired(record.order_id))) record.note = message;
      this.journal.write("order_note", entry);
      // TWS has no such order (the answer to a cancel of one it refused outright, or that never
      // reached it): no status will ever come for it, so it gets its final one here.
      if (notFound) this.markNotWorking(event.orderId);
      else this.cancelFoundItOver(event, leg, state.status);
      // A notice about a cancel is TWS's word on the order; a warning is not.
      if (!event.nonFatal) this.heard(event.orderId);
      this.stateChanged();
      return;
    }
    record.error = message;
    this.journal.write("order_error", entry);
    this.say(`order ${record.order_id} ${record.ticker} refused by TWS: ${message}`);
    if (leg === "exit") this.cleanUpSell(record, event.orderId);
    else this.cleanUp(record);
    this.ackWaiters.get(record.order_id)?.();
    this.heard(event.orderId);
    this.stateChanged();
  }

  /**
   * TWS's answer to a cancel the bridge asked for on a sell-side order: "cannot be cancelled,
   * state: Cancelled" (or Filled). The order was over already, and TWS has just said in which
   * way: that is its status. (A status of its own does not follow for an order that ended while
   * the bridge was not connected.) Any other state named leaves the order as it is.
   */
  private cancelFoundItOver(event: OrderMessageEvent, leg: BookLeg, status: string): void {
    if (leg === "parent" || status !== "PendingCancel" || event.code !== CODE_NOT_CANCELLABLE) return;
    const state = /\bstate:\s*([A-Za-z]+)/.exec(event.message)?.[1];
    if (state === undefined || !isDone(state)) return;
    const ref = this.book.findLeg(event.orderId);
    if (ref === undefined) return;
    this.onOrderStatus({
      orderId: event.orderId,
      status: state,
      filled: ref.state.filled_qty,
      remaining: 0,
      avgFillPrice: ref.state.avg_fill_price ?? 0,
    });
  }

  /**
   * TWS refused a change to an order: the book goes back to what the order was before it (its
   * price, and the `/sell` the change belonged to), and the record says what happened. Nothing is
   * cancelled and nothing is sent: the order itself is as it was.
   */
  private changeRefused(record: OrderRecord, leg: BookLeg, event: OrderMessageEvent, change: SentChange, message: string): void {
    const id = record.order_id;
    this.book.setPrices(id, change.back);
    if (change.backExit !== undefined) this.book.setExit(id, change.backExit);
    // A chase that reached TWS after the buy had filled is refused for that reason alone: worth
    // a note on the order, not an error on a buy that did what it was for.
    const filledFirst = leg === "parent" && (record.status === "Filled" || record.filled_qty >= record.sent.qty);
    const text = filledFirst ? `the chase came after the buy had filled: ${message}` : `${change.what} refused by TWS: ${message}`;
    if (filledFirst) record.note = text;
    else record.error = text;
    this.journal.write("change_refused", {
      order_id: id,
      ticker: record.ticker,
      leg,
      leg_order_id: event.orderId,
      code: event.code,
      message,
      ...(filledFirst ? { note: text } : { error: text }),
      prices: change.back,
      ...(change.backExit !== undefined ? { exit: change.backExit === null ? null : { ...change.backExit } } : {}),
    });
    this.say(`order ${id} ${record.ticker}: ${text}`);
  }
}
