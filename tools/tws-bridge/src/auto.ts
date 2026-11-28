import { isDone } from "./book.js";
import type { OrderRecord } from "./book.js";
import type { AutoBlocker, AutoBuy } from "./bridge.js";
import { autoSlots, minutesOfDay } from "./config.js";
import type { AutoConfig, Config } from "./config.js";
import { badRequest, BridgeError, errorMessage } from "./errors.js";
import type { FeedSetup, FeedStatus } from "./feed.js";
import type { Journal, JournalFields } from "./journal.js";
import { formatPrice, formatUsd } from "./order.js";
import type { OrderPlan } from "./order.js";
import { isFeedServer, isFeedToken } from "./state.js";
import type { AutoMode, BridgeState } from "./state.js";
import { nyDate, nyInstant, systemClock } from "./time.js";
import type { Clock } from "./time.js";

// The automation: which alerts the bridge buys by itself.
//
// The operator's rule (2026-11-28): in one hour of the day, every POP alert that passed the
// script's volume test (a "yellow" POP: stage `pop`, not `weak`) gets a waiting buy above the
// alert's price with a take-profit and a stop, a fixed number of dollars each, and no more than a
// set number of them a day. This file decides; it sends nothing itself. A buy it decides on goes
// down the road a click on "Buy if ≥" takes (`Bridge.autoOrder`), so every rail of the bridge
// holds for it too. The selling side is `src/watch.ts`.
//
// Three modes, switched from the dashboard and kept in state.json: "off"; "watch" (it decides and
// writes down what it would do, and places nothing); "on".

/** The most decisions kept for `GET /auto`. */
const MAX_DECISIONS = 100;
/** A feed token shorter than this is not one. */
const MIN_TOKEN_LENGTH = 20;
/** A buy that could wait less than this is not placed: IB takes whole seconds, and it would be gone at once. */
const MIN_VALID_SEC = 10;
/** Refusals of the bridge that are the rule saying no, not something that failed. */
const SKIP_CODES = new Set(["duplicate", "duplicate_alert", "daily_limit", "window_closing"]);

export type AutoAction = "placed" | "would_place" | "skipped" | "failed";

export interface AutoPlan {
  trigger: number;
  limit: number;
  qty: number;
  take_profit: number | null;
  stop: number | null;
  /** When the buy stops waiting (ISO). */
  good_until: string | null;
}

/** What was decided about one yellow POP. */
export interface AutoDecision {
  /** When the bridge decided (ISO). */
  at: string;
  alert_id: string;
  alert_at: string;
  ticker: string;
  price: number | null;
  /** The POP's own volume reading, and the stock's RVol 1m as the script read it (percent), when the alert carries them. */
  vol_x: number | null;
  rvol1: number | null;
  /** The mode at the decision. */
  mode: AutoMode;
  action: AutoAction;
  /** A short code: `placed`, `would_place`, why it was skipped, or the bridge's own code for a refusal. */
  reason: string;
  /** The same in plain words. */
  text: string;
  order_id: number | null;
  plan: AutoPlan | null;
}

export type AutoBlocked =
  | "off"
  | "watch"
  | "disabled"
  | "halted"
  | "tws_down"
  | "tws_offline"
  | "not_paper"
  | "no_feed"
  | "outside_hours"
  | "day_full"
  | "no_slot";

export interface AutoStatus {
  mode: AutoMode;
  /** Why no order would be placed right now; null = the next yellow POP is bought. */
  blocked: AutoBlocked | null;
  blocked_text: string | null;
  /** The hour it buys in: the New York times as set, and today's (New York date) instants. */
  window: { start: string; end: string; tz: "America/New_York"; start_at: string; end_at: string; open: boolean };
  rule: {
    stage: "pop";
    strong_only: true;
    amount_usd: number;
    budget_usd: number;
    slots: number;
    max_trades: number;
    max_orders: number;
    entry_stop_pct: number;
    entry_limit_pct: number;
    entry_valid_sec: number;
    take_profit_pct: number;
    stop_pct: number;
    stop_limit_offset_pct: number;
    max_alert_age_sec: number;
    /** An alert under this price is not bought; 0 = no floor. */
    min_price: number;
    paper_only: boolean;
    exit_watch: { tp_grace_ms: number; stop_grace_ms: number; resell_ms: number };
  };
  feed: FeedStatus & { paired: boolean };
  today: {
    date: string;
    strong_pops: number;
    weak_pops: number;
    /** Buys the automation placed today, filled or not. */
    placed: number;
    /** Those that filled at least in part. */
    trades: number;
    /** Buys still waiting with nothing filled (in "watch": the ones it would have waiting). */
    waiting: number;
    /** Orders of the automation that still hold shares. */
    held: number;
    slots_free: number;
  };
  /** Today's decisions, newest first. */
  decisions: AutoDecision[];
}

/** The alert feed as the automation uses it (`AlertFeed` in src/feed.ts). */
export interface FeedLike {
  start(server: string, token: string): void;
  stop(): void;
  status(): FeedStatus;
}

/** What the automation needs of the bridge. */
export interface AutoHost {
  /** Today's (New York date) orders. */
  orders(): OrderRecord[];
  /** Every order on the book. */
  allOrders(): OrderRecord[];
  openOrdersFor(ticker: string): OrderRecord[];
  autoBlocker(): AutoBlocker | null;
  autoPlan(buy: AutoBuy): { plan: OrderPlan; goodUntilMs: number };
  autoOrder(buy: AutoBuy): Promise<OrderRecord>;
  /** Cancels the automation's buys that are still waiting with nothing filled; returns their order ids. */
  cancelAutoWaiting(why: string): number[];
}

export interface AutoOptions {
  config: Config;
  bridge: AutoHost;
  journal: Journal;
  /** The state read from state.json at the start. The automation keeps it from then on and saves every change. */
  state: BridgeState;
  saveState: (state: BridgeState) => void;
  /** Makes the alert feed; `onSetup` is where its alerts go. */
  feed: (onSetup: (setup: FeedSetup) => void) => FeedLike;
  clock?: Clock;
  /** One line for the console. */
  say?: (message: string) => void;
}

interface Counts {
  placed: number;
  trades: number;
  waiting: number;
  held: number;
  free: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Reads the `plan` of a logged decision back; null when it is not a whole one. */
function planFromJournal(value: unknown): AutoPlan | null {
  if (!isPlainObject(value)) return null;
  const trigger = finite(value["trigger"]);
  const limit = finite(value["limit"]);
  const qty = finite(value["qty"]);
  if (trigger === null || limit === null || qty === null) return null;
  return {
    trigger,
    limit,
    qty,
    take_profit: finite(value["take_profit"]),
    stop: finite(value["stop"]),
    good_until: text(value["good_until"]),
  };
}

/** Reads an `auto_decision` log line back; null when it is not a whole one. */
export function decisionFromJournal(event: JournalFields): AutoDecision | null {
  const at = text(event["at"]);
  const alertId = text(event["alert_id"]);
  const alertAt = text(event["alert_at"]);
  const ticker = text(event["ticker"]);
  const mode = event["mode"];
  const action = event["action"];
  const reason = text(event["reason"]);
  const words = text(event["text"]);
  if (at === null || alertId === null || alertAt === null || ticker === null || reason === null || words === null) return null;
  if (mode !== "off" && mode !== "watch" && mode !== "on") return null;
  if (action !== "placed" && action !== "would_place" && action !== "skipped" && action !== "failed") return null;
  return {
    at,
    alert_id: alertId,
    alert_at: alertAt,
    ticker,
    price: finite(event["price"]),
    vol_x: finite(event["vol_x"]),
    rvol1: finite(event["rvol1"]),
    mode,
    action,
    reason,
    text: words,
    order_id: finite(event["order_id"]),
    plan: planFromJournal(event["plan"]),
  };
}

export class AutoTrader {
  private readonly config: Config;
  private readonly auto: AutoConfig;
  private readonly bridge: AutoHost;
  private readonly journal: Journal;
  private readonly state: BridgeState;
  private readonly saveState: (state: BridgeState) => void;
  private readonly feed: FeedLike;
  private readonly clock: Clock;
  private readonly say: (message: string) => void;

  /** The New York date the day's memory below is for. */
  private day: string;
  /** Alert ids already dealt with today: a replay after a reconnect brings the same alert again. */
  private seen = new Set<string>();
  private decisions: AutoDecision[] = [];
  private strongPops = 0;
  private weakPops = 0;
  /**
   * "Watch only" places nothing, so nothing would ever take a slot or a ticker: each buy it would
   * have placed is remembered here for as long as it would have waited, as if it never filled.
   * That is the most buys the rule could have had out, which is what a watch-only morning is for.
   */
  private imagined: Array<{ ticker: string; untilMs: number }> = [];
  /** How many buys "watch only" would have placed today: they count against the day's limit as placed ones would. */
  private wouldPlaced = 0;
  /** Alerts are decided one at a time, in the order they came. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: AutoOptions) {
    this.config = options.config;
    this.auto = options.config.auto;
    this.bridge = options.bridge;
    this.journal = options.journal;
    this.state = options.state;
    this.saveState = options.saveState;
    this.clock = options.clock ?? systemClock;
    this.say = options.say ?? (() => undefined);
    this.day = nyDate(this.clock());
    this.restore();
    this.feed = options.feed((setup) => this.onSetup(setup));
    this.applyFeed();
  }

  /** Ends the feed. Orders already in TWS stay in TWS, and the exit watch is its own to stop. */
  close(): void {
    this.closed = true;
    this.feed.stop();
  }

  get mode(): AutoMode {
    return this.state.auto.mode;
  }

  /** Resolves once every alert handed in so far has been decided: for tests and a clean stop. */
  idle(): Promise<void> {
    return this.queue;
  }

  // ------------------------------------------------------------- over HTTP

  status(): AutoStatus {
    const now = this.clock();
    this.rollDay(now);
    const { auto } = this;
    const window = this.windowAt(now);
    const counts = this.counts(now);
    const feed = this.feed.status();
    const blocked = this.blockedNow(window.open, counts, feed);
    return {
      mode: this.mode,
      blocked: blocked?.code ?? null,
      blocked_text: blocked?.text ?? null,
      window: {
        start: auto.windowStart,
        end: auto.windowEnd,
        tz: "America/New_York",
        start_at: new Date(window.startMs).toISOString(),
        end_at: new Date(window.endMs).toISOString(),
        open: window.open,
      },
      rule: {
        stage: "pop",
        strong_only: true,
        amount_usd: auto.amountUsd,
        budget_usd: auto.budgetUsd,
        slots: autoSlots(auto),
        max_trades: auto.maxTrades,
        max_orders: auto.maxOrdersPerDay,
        entry_stop_pct: auto.entryStopPct,
        entry_limit_pct: auto.entryStopLimitPct,
        entry_valid_sec: auto.entryValidSec,
        take_profit_pct: auto.takeProfitPct,
        stop_pct: auto.stopPct,
        stop_limit_offset_pct: auto.stopLimitOffsetPct,
        max_alert_age_sec: auto.maxAlertAgeSec,
        min_price: auto.minPrice,
        paper_only: auto.paperOnly,
        exit_watch: { tp_grace_ms: auto.tpGraceMs, stop_grace_ms: auto.stopGraceMs, resell_ms: auto.resellMs },
      },
      feed: { ...feed, paired: this.state.feed !== null },
      today: {
        date: this.day,
        strong_pops: this.strongPops,
        weak_pops: this.weakPops,
        placed: counts.placed,
        trades: counts.trades,
        waiting: counts.waiting,
        held: counts.held,
        slots_free: Math.max(0, counts.free),
      },
      decisions: [...this.decisions],
    };
  }

  /** The switch: `{ mode: "off" | "watch" | "on" }`. It takes effect at once; saving it comes second. */
  setMode(body: unknown): AutoStatus {
    if (!isPlainObject(body)) throw badRequest("the body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (key !== "mode") throw badRequest(`unknown field ${JSON.stringify(key.slice(0, 40))}: only mode is accepted`);
    }
    const mode = body["mode"];
    if (mode !== "off" && mode !== "watch" && mode !== "on") throw badRequest('mode must be "off", "watch" or "on"');
    const was = this.mode;
    if (mode !== was) {
      this.state.auto.mode = mode;
      // What "watch only" imagined to be waiting has no place under another mode.
      this.imagined = [];
      this.journal.write("auto_mode", { mode, was });
      this.say(
        mode === "on"
          ? "automation ON: it places orders by itself"
          : mode === "watch"
            ? "automation on WATCH ONLY: it logs what it would do and places nothing"
            : "automation off",
      );
      this.applyFeed();
      // Leaving "on" stops its buying, and a buy still waiting would be a buy to come: those are
      // cancelled. What it holds stays, with its exits, and the exit watch goes on.
      if (was === "on") {
        try {
          this.bridge.cancelAutoWaiting(mode === "off" ? "automation switched off" : "automation switched to watch only");
        } catch (err) {
          this.journal.write("internal_error", { where: "the automation's switch", message: errorMessage(err) });
        }
      }
      this.save(`the automation is now "${mode}" in the running bridge`);
    }
    return this.status();
  }

  /**
   * Where the alerts come from: `{ server, token }`, sent by the dashboard page (the server's
   * origin, and a read-only token for its alert stream). The server must be one of the origins
   * the bridge already answers to. The token is kept in state.json, never logged.
   */
  pairFeed(body: unknown): { paired: true; server: string } {
    if (!isPlainObject(body)) throw badRequest("the body must be a JSON object");
    for (const key of Object.keys(body)) {
      if (key !== "server" && key !== "token") {
        throw badRequest(`unknown field ${JSON.stringify(key.slice(0, 40))}: only server and token are accepted`);
      }
    }
    const server = body["server"];
    const token = body["token"];
    if (!isFeedServer(server) || !this.config.allowedOrigins.includes(server)) {
      throw badRequest("server must be one of allowedOrigins in config.json (scheme://host[:port])");
    }
    // The server's tokens are a few hundred characters. A short one is no token, and one under 8
    // characters the log could not even keep out of its lines (journal.addSecret).
    if (!isFeedToken(token) || token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
      throw badRequest("token must be the token the server gave for its alert stream");
    }
    // Before anything else can write a line: the log replaces it wherever it turns up.
    this.journal.addSecret(token);
    this.state.feed = { server, token };
    this.journal.write("auto_feed", { server });
    this.applyFeed();
    this.save("the alert stream is set in the running bridge");
    return { paired: true, server };
  }

  private save(whatHolds: string): void {
    try {
      this.saveState(this.state);
    } catch (err) {
      throw new BridgeError(500, "not_saved", `${whatHolds}, but saving it to state.json failed: ${errorMessage(err)}`);
    }
  }

  /** The feed runs while the automation is not off and knows where the alerts are. */
  private applyFeed(): void {
    if (this.closed) return;
    const { feed } = this.state;
    if (this.mode === "off" || feed === null) {
      this.feed.stop();
      return;
    }
    try {
      this.feed.start(feed.server, feed.token);
    } catch (err) {
      // The feed refuses an address or a token it cannot use. Its message never holds the token.
      this.journal.write("auto_feed_error", { server: feed.server, message: errorMessage(err) });
      this.say(`automation: the alert stream could not be started: ${errorMessage(err)}`);
    }
  }

  // ------------------------------------------------------------ the alerts

  /** One alert from the feed. Decided in its turn; nothing here throws. */
  onSetup(setup: FeedSetup): void {
    this.queue = this.queue
      .then(() => this.handle(setup))
      .catch((err: unknown) => {
        this.journal.write("internal_error", { where: "the automation", message: errorMessage(err) });
        console.error("tws-bridge: error in the automation:", err);
      });
  }

  private async handle(setup: FeedSetup): Promise<void> {
    if (this.closed || this.mode === "off") return;
    if (setup.stage !== "pop") return;
    const now = this.clock();
    this.rollDay(now);
    if (this.seen.has(setup.id)) return;
    this.seen.add(setup.id);

    // A gray POP (it failed the script's volume test) is counted and left alone.
    if (setup.setup["weak"] === true) {
      this.weakPops += 1;
      this.journal.write("auto_alert", { alert_id: setup.id, ticker: setup.ticker, alert_at: setup.at, weak: true });
      return;
    }
    this.strongPops += 1;

    const mode = this.mode;
    const outcome = await this.decide(setup, now, mode);
    const decision: AutoDecision = {
      at: new Date(this.clock()).toISOString(),
      alert_id: setup.id,
      alert_at: setup.at,
      ticker: setup.ticker.toUpperCase(),
      price: setup.price,
      vol_x: finite(setup.setup["vol_x"]),
      rvol1: finite(setup.setup["tv_rv1"]),
      mode,
      ...outcome,
    };
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.length = MAX_DECISIONS;
    this.journal.write("auto_decision", { ...decision });
    // Outside its hours it says nothing on the console: that is most of the day.
    if (decision.reason !== "outside_hours") {
      const price = decision.price === null ? "" : ` ${formatPrice(decision.price)}`;
      this.say(`auto ${decision.ticker} POP${price}: ${decision.text}`);
    }
  }

  /** The rule, in order. Everything up to the last step asks nothing of TWS. */
  private async decide(
    setup: FeedSetup,
    now: number,
    mode: AutoMode,
  ): Promise<Pick<AutoDecision, "action" | "reason" | "text" | "order_id" | "plan">> {
    const { auto } = this;
    const skip = (reason: string, words: string): Pick<AutoDecision, "action" | "reason" | "text" | "order_id" | "plan"> => ({
      action: "skipped",
      reason,
      text: words,
      order_id: null,
      plan: null,
    });

    // Its hour: by the alert's own time and by the clock now.
    const window = this.windowAt(now);
    const alertMs = Date.parse(setup.at);
    if (!Number.isFinite(alertMs)) return skip("no_time", "the alert carries no time");
    if (alertMs < window.startMs || alertMs >= window.endMs || !window.open) {
      return skip("outside_hours", `outside its hours (${auto.windowStart}–${auto.windowEnd} New York)`);
    }
    const ageSec = Math.round((now - alertMs) / 1000);
    if (now - alertMs > auto.maxAlertAgeSec * 1000) {
      return skip("late", `it reached the helper ${ageSec} s after the alert (the limit is ${auto.maxAlertAgeSec} s)`);
    }
    const price = setup.price;
    if (price === null || !(price > 0)) return skip("no_price", "the alert carries no price");
    // The operator's floor (2026-11-28, "maybe we ignore below $0.5?"): under it the commission is
    // at its 1% cap each way, and a tick is a large part of the price.
    if (auto.minPrice > 0 && price < auto.minPrice - 1e-9) {
      return skip("under_min_price", `its price ${formatPrice(price)} is under the floor of ${formatPrice(auto.minPrice)}`);
    }

    // One trade per ticker a day, and never a second order beside one that is working or held.
    // Upper-cased as the bridge writes every ticker on its book, so the two are told to be the same.
    const ticker = setup.ticker.toUpperCase();
    const mine = this.bridge.orders().filter((record) => record.source === "auto");
    if (mine.some((record) => record.ticker === ticker && record.filled_qty > 0)) {
      return skip("ticker_done", `${ticker} was already traded today`);
    }
    const imaginedOpen = mode === "watch" && this.imagined.some((buy) => buy.ticker === ticker && buy.untilMs > now);
    if (imaginedOpen || this.bridge.openOrdersFor(ticker).length > 0) {
      return skip("ticker_open", `an order for ${ticker} is already working or held`);
    }

    // The day and the budget.
    const counts = this.counts(now);
    const slots = autoSlots(auto);
    if (counts.trades >= auto.maxTrades) {
      return skip("day_full", `${counts.trades} of ${auto.maxTrades} trades done today`);
    }
    if (counts.placed >= auto.maxOrdersPerDay) {
      return skip("daily_limit", `${counts.placed} buys placed today (the limit is ${auto.maxOrdersPerDay})`);
    }
    if (counts.waiting + counts.held >= slots) {
      return skip("no_slot", `no free slot: ${counts.waiting} waiting, ${counts.held} held (${plural(slots, "slot")})`);
    }
    if (counts.trades + counts.waiting >= auto.maxTrades) {
      return skip(
        "no_slot",
        `the day's last trades are already waiting: ${counts.trades} done, ${counts.waiting} waiting (${auto.maxTrades} a day)`,
      );
    }

    // No buy waits past the end of the hour.
    const validSec = Math.min(auto.entryValidSec, Math.floor((window.endMs - now) / 1000));
    if (validSec < MIN_VALID_SEC) {
      return skip("window_closing", `its hour ends in ${Math.max(0, validSec)} s: too late for a waiting buy`);
    }

    const buy: AutoBuy = {
      ticker,
      alertPrice: price,
      alertAt: setup.at,
      alertId: setup.id,
      validSec: auto.entryValidSec,
      notAfterMs: window.endMs,
    };

    if (mode === "watch") {
      try {
        const { plan, goodUntilMs } = this.bridge.autoPlan(buy);
        this.imagined.push({ ticker, untilMs: goodUntilMs });
        this.wouldPlaced += 1;
        return {
          action: "would_place",
          reason: "would_place",
          text: `would buy ${this.describe(plan, validSec)}`,
          order_id: null,
          plan: this.planOf(plan, goodUntilMs),
        };
      } catch (err) {
        return this.refused(err);
      }
    }

    const blocker = this.bridge.autoBlocker();
    if (blocker !== null) return skip(blocker.code, blocker.text);

    try {
      const record = await this.bridge.autoOrder(buy);
      const { sent } = record;
      return {
        action: "placed",
        reason: "placed",
        text:
          `buys if ≥ ${formatPrice(sent.trigger ?? sent.limit)}: ${sent.qty.toLocaleString("en-US")} shares ` +
          `(${formatUsd(auto.amountUsd)})` +
          (sent.take_profit === null ? "" : `, take-profit ${formatPrice(sent.take_profit)}`) +
          (sent.stop === null ? "" : `, stop ${formatPrice(sent.stop)}`) +
          `, waits ${this.waitWords(validSec)}`,
        order_id: record.order_id,
        plan: {
          trigger: sent.trigger ?? sent.limit,
          limit: sent.limit,
          qty: sent.qty,
          take_profit: sent.take_profit,
          stop: sent.stop,
          good_until: sent.good_until,
        },
      };
    } catch (err) {
      return this.refused(err);
    }
  }

  /** A refusal of the bridge (a rail, TWS) or anything else that went wrong, as a decision. */
  private refused(err: unknown): Pick<AutoDecision, "action" | "reason" | "text" | "order_id" | "plan"> {
    const code = err instanceof BridgeError ? err.code : "internal";
    if (!(err instanceof BridgeError)) console.error("tws-bridge: error in the automation:", err);
    return {
      action: SKIP_CODES.has(code) ? "skipped" : "failed",
      reason: code,
      text: errorMessage(err),
      order_id: null,
      plan: null,
    };
  }

  private describe(plan: OrderPlan, validSec: number): string {
    return (
      `if ≥ ${formatPrice(plan.trigger ?? plan.limit)}: ${plan.qty.toLocaleString("en-US")} shares ` +
      `(${formatUsd(this.auto.amountUsd)})` +
      (plan.takeProfit === null ? "" : `, take-profit ${formatPrice(plan.takeProfit)}`) +
      (plan.stop === null ? "" : `, stop ${formatPrice(plan.stop)}`) +
      `, waiting ${this.waitWords(validSec)}`
    );
  }

  private waitWords(validSec: number): string {
    return validSec % 60 === 0 ? `${validSec / 60} min` : `${validSec} s`;
  }

  private planOf(plan: OrderPlan, goodUntilMs: number): AutoPlan {
    return {
      trigger: plan.trigger ?? plan.limit,
      limit: plan.limit,
      qty: plan.qty,
      take_profit: plan.takeProfit,
      stop: plan.stop,
      good_until: new Date(goodUntilMs).toISOString(),
    };
  }

  // ------------------------------------------------------- the day's state

  /** Today's hour as instants, and whether it is open now. */
  private windowAt(now: number): { startMs: number; endMs: number; open: boolean } {
    const date = nyDate(now);
    const startMs = nyInstant(date, minutesOfDay(this.auto.windowStart) ?? 0);
    const endMs = nyInstant(date, minutesOfDay(this.auto.windowEnd) ?? 0);
    return { startMs, endMs, open: now >= startMs && now < endMs };
  }

  /**
   * Where the day stands, from the bridge's book: the automation's own orders only. A trade is a
   * buy that filled at least in part; a waiting buy is one still working with nothing filled.
   * `free` is how many more buys may go out now: never more waiting or held than the budget pays
   * for, and never more waiting than the day has trades left.
   */
  private counts(now: number): Counts {
    let trades = 0;
    let waiting = 0;
    const today = this.bridge.orders().filter((record) => record.source === "auto");
    for (const record of today) {
      if (record.filled_qty > 0) trades += 1;
      else if (!isDone(record.status)) waiting += 1;
    }
    // A position kept from an earlier day still holds its dollars.
    const held = this.bridge.allOrders().filter((record) => record.source === "auto" && record.held_qty > 0).length;
    let placed = today.length;
    if (this.mode === "watch") {
      this.imagined = this.imagined.filter((buy) => buy.untilMs > now);
      waiting += this.imagined.length;
      placed += this.wouldPlaced;
    }
    const { auto } = this;
    const free = Math.min(autoSlots(auto) - waiting - held, auto.maxTrades - trades - waiting, auto.maxOrdersPerDay - placed);
    return { placed, trades, waiting, held, free };
  }

  private blockedNow(windowOpen: boolean, counts: Counts, feed: FeedStatus): { code: AutoBlocked; text: string } | null {
    const { auto } = this;
    if (this.mode === "off") return { code: "off", text: "The automation is off." };
    if (this.mode === "watch") {
      return { code: "watch", text: "Watch only: it logs what it would do and places nothing." };
    }
    const blocker = this.bridge.autoBlocker();
    if (blocker !== null) {
      const sentence = `${blocker.text.charAt(0).toUpperCase()}${blocker.text.slice(1)}`;
      return { code: blocker.code, text: `${sentence}: the automation places nothing.` };
    }
    if (this.state.feed === null) {
      return { code: "no_feed", text: "No alerts are coming in: the helper has not been told where the server is yet." };
    }
    if (feed.state !== "connected") {
      return { code: "no_feed", text: `No alerts are coming in: ${feed.error ?? "connecting to the server"}.` };
    }
    if (!windowOpen) {
      return {
        code: "outside_hours",
        text: `Outside its hours (${auto.windowStart}–${auto.windowEnd} New York): it buys nothing now. Open positions are still watched.`,
      };
    }
    if (counts.trades >= auto.maxTrades) {
      return { code: "day_full", text: `${counts.trades} of ${auto.maxTrades} trades done today: it buys nothing more.` };
    }
    if (counts.free <= 0) {
      return { code: "no_slot", text: `No free slot right now: ${counts.waiting} waiting, ${counts.held} held.` };
    }
    return null;
  }

  /** A new New York date: the day's memory starts empty. Orders are the book's to keep. */
  private rollDay(now: number): void {
    const today = nyDate(now);
    if (today === this.day) return;
    this.day = today;
    this.seen = new Set();
    this.decisions = [];
    this.strongPops = 0;
    this.weakPops = 0;
    this.imagined = [];
    this.wouldPlaced = 0;
  }

  /**
   * After a restart: today's alerts and decisions from the log, so an alert the feed replays is
   * not decided twice and `GET /auto` shows the day as it was.
   */
  private restore(): void {
    const now = this.clock();
    for (const event of this.journal.readDay(this.day)) {
      if (event["type"] === "auto_alert") {
        const id = text(event["alert_id"]);
        if (id === null || this.seen.has(id)) continue;
        this.seen.add(id);
        if (event["weak"] === true) this.weakPops += 1;
      } else if (event["type"] === "auto_decision") {
        const decision = decisionFromJournal(event);
        if (decision === null || this.seen.has(decision.alert_id)) continue;
        this.seen.add(decision.alert_id);
        this.strongPops += 1;
        this.decisions.unshift(decision);
        if (decision.action !== "would_place") continue;
        this.wouldPlaced += 1;
        const until = decision.plan?.good_until ?? null;
        const untilMs = until === null ? Number.NaN : Date.parse(until);
        if (Number.isFinite(untilMs) && untilMs > now) this.imagined.push({ ticker: decision.ticker, untilMs });
      }
    }
    if (this.decisions.length > MAX_DECISIONS) this.decisions.length = MAX_DECISIONS;
  }
}
