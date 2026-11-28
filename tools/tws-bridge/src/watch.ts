import type { Contract } from "@stoqey/ib";
import { isDone } from "./book.js";
import type { OrderRecord } from "./book.js";
import type { SellData } from "./bridge.js";
import type { AutoConfig } from "./config.js";
import { BridgeError, errorMessage } from "./errors.js";
import type { Journal } from "./journal.js";
import type { QuoteField, QuoteListener } from "./link.js";
import { formatPrice } from "./order.js";
import { systemClock } from "./time.js";
import type { Clock } from "./time.js";

// The automation's exit watch: when the bridge sells, by itself, what the automation bought.
//
// Every buy of the automation goes out with a take-profit and a stop, and most of the time one of
// the two simply fills. The operator's rule is for the two times it does not (2026-11-28):
//
//   1. The price trades at the take-profit, or through it, and the take-profit does not fill (a
//      fast move jumped over it). After a short wait the position is sold at the bid, as long as
//      the bid is above what the shares cost: a take-profit does not sell at a loss.
//   2. The stop is due (a trade at or under its price, or the stop has sold part) and has not
//      sold everything: its own limit was jumped too. After a short wait, if the bid is still at
//      or under the stop, the rest is sold at the bid, "as soon as possible": from then on there
//      is no price it will not sell at.
//
// One print starts the wait, and one print can be a stray one: so at the end of the wait the bid
// is asked again (`verdict`), and when the reason is gone and nothing has been sent, the order is
// left to its own exits. Once a sell is out, the watch moves it down to the new bid every
// `auto.resellMs` while shares are left (the stop's until the order holds nothing; the
// take-profit's only while the bid is above cost). Each sell is `Bridge.autoSell`, the same sell
// a click on Sell sends, so it never sells more than the order holds or the account has.
//
// What it leaves alone: an order that was clicked, not placed by the automation; an exit the
// operator has cancelled in TWS (it chases only exits that exist); and anything while TWS is not
// connected. It works while orders are halted and after the automation's hour: getting out is
// never switched off. It needs a real-time quote for each position it watches (one stream per
// order); without one it cannot see the take-profit's price trade, and says so in the log.

const PRICE_EPS = 1e-9;
/** A bid from the stream is used for a sell only while it is this fresh; else the sell reads one from TWS. */
const BID_FRESH_MS = 5000;
/** A quote stream TWS refused is asked for again after this long. */
const STREAM_RETRY_MS = 30_000;
/** No price at all this long after a stream opened: worth a line in the log, once. */
const STREAM_SILENT_MS = 15_000;
/** Refusals of a sell after which trying again cannot help: the watch on that order ends at once. */
const GIVE_UP_CODES = new Set(["not_auto", "unknown_order"]);
/**
 * "Nothing to sell" (the account does not hold the shares the book says the order holds) ends the
 * watch only after it has been the answer this many times, over at least this long.
 */
const NO_SHARES_TRIES = 3;
const NO_SHARES_MS = 20_000;

/** What the watch needs of the bridge. */
export interface WatchHost {
  onOrderChanged: ((record: OrderRecord) => void) | null;
  onLinkUp: (() => void) | null;
  onLinkDown: (() => void) | null;
  allOrders(): OrderRecord[];
  contractFor(record: OrderRecord): Contract;
  autoSell(orderId: number, bid: number | null): Promise<SellData>;
}

/** The quote streams of the connection to TWS (`TwsLink`). */
export interface QuoteSource {
  isReady(): boolean;
  watchQuotes(contract: Contract, listener: QuoteListener): number;
  unwatchQuotes(requestId: number): void;
}

export interface ExitWatchOptions {
  auto: AutoConfig;
  bridge: WatchHost;
  link: QuoteSource;
  journal: Journal;
  clock?: Clock;
  /** One line for the console. */
  say?: (message: string) => void;
  /** How often an order with nothing due is looked at anyway (default 5 s): the quote stream's upkeep. */
  idleLookMs?: number;
}

interface Watched {
  record: OrderRecord;
  streamId: number | null;
  /** When a stream was last asked for, and whether any price has come on the current one. */
  streamAskedMs: number | null;
  heard: boolean;
  silenceNoted: boolean;
  bid: number | null;
  bidAtMs: number;
  last: number | null;
  /** What was seen and when; null until then. Once set it stays: the watch sells until the order holds nothing. */
  due: { state: "tp_crossed" | "stop_due"; sinceMs: number } | null;
  timer: NodeJS.Timeout | null;
  selling: boolean;
  lastSellMs: number | null;
  sells: number;
  lastErrorCode: string | null;
  /** Since when, and how many times in a row, a sell was refused because the account does not hold the shares. */
  noSharesSinceMs: number | null;
  noSharesCount: number;
  /**
   * The wait ended with nothing sent ("cleared") on the trade that is still the last one. That
   * same standing price must not start the wait over and over: for the stop it counts again only
   * once the bid has followed it down; for the take-profit, only a new trade does.
   */
  stopLetGo: boolean;
  takeProfitLetGo: boolean;
}

export class ExitWatch {
  private readonly auto: AutoConfig;
  private readonly bridge: WatchHost;
  private readonly link: QuoteSource;
  private readonly journal: Journal;
  private readonly clock: Clock;
  private readonly say: (message: string) => void;
  private readonly idleLookMs: number;

  private readonly watched = new Map<number, Watched>();
  /** Orders the watch has given up on (a sell that cannot go through): not taken up again. */
  private readonly givenUp = new Set<number>();
  private closed = false;

  constructor(options: ExitWatchOptions) {
    this.auto = options.auto;
    this.bridge = options.bridge;
    this.link = options.link;
    this.journal = options.journal;
    this.clock = options.clock ?? systemClock;
    this.say = options.say ?? (() => undefined);
    this.idleLookMs = options.idleLookMs ?? 5000;

    this.bridge.onOrderChanged = (record) => this.consider(record);
    this.bridge.onLinkUp = () => this.resume();
    this.bridge.onLinkDown = () => this.pause();
    if (this.link.isReady()) this.resume();
  }

  /** Ends every timer and stream. Orders and positions stay as they are in TWS. */
  close(): void {
    this.closed = true;
    for (const watch of this.watched.values()) this.release(watch);
    this.watched.clear();
  }

  /** The orders being watched now: for tests and the start-up line. */
  watching(): number[] {
    return [...this.watched.keys()];
  }

  // -------------------------------------------------------------- events

  /** An order changed. One of the automation's that holds shares is watched; one that holds none is let go. */
  private consider(record: OrderRecord): void {
    if (this.closed || record.source !== "auto") return;
    const id = record.order_id;
    const known = this.watched.get(id);
    if (record.held_qty <= 0) {
      if (known !== undefined) this.finish(known);
      return;
    }
    if (this.givenUp.has(id)) return;
    this.look(known ?? this.begin(record));
  }

  /** TWS is connected (again): every position of the automation is taken up, and its quotes asked for anew. */
  private resume(): void {
    if (this.closed) return;
    for (const record of this.bridge.allOrders()) this.consider(record);
  }

  /** TWS is gone, and its quote streams with it. What was seen stays seen; nothing can be sold until it is back. */
  private pause(): void {
    for (const watch of this.watched.values()) {
      watch.streamId = null;
      watch.streamAskedMs = null;
      this.forgetQuotes(watch);
      if (watch.timer !== null) clearTimeout(watch.timer);
      watch.timer = null;
    }
  }

  /**
   * The prices of a stream that has ended say nothing about now. TWS sends the bid and the last
   * trade only when they change, so while a stream is open the last one heard is the current
   * one, however long ago it came; once the stream is gone, it is nobody's.
   */
  private forgetQuotes(watch: Watched): void {
    watch.bid = null;
    watch.bidAtMs = 0;
    watch.last = null;
  }

  private begin(record: OrderRecord): Watched {
    const watch: Watched = {
      record,
      streamId: null,
      streamAskedMs: null,
      heard: false,
      silenceNoted: false,
      bid: null,
      bidAtMs: 0,
      last: null,
      due: null,
      timer: null,
      selling: false,
      lastSellMs: null,
      sells: 0,
      lastErrorCode: null,
      noSharesSinceMs: null,
      noSharesCount: 0,
      stopLetGo: false,
      takeProfitLetGo: false,
    };
    this.watched.set(record.order_id, watch);
    this.journal.write("auto_watch", {
      order_id: record.order_id,
      ticker: record.ticker,
      what: "watching",
      held: record.held_qty,
      take_profit: record.sent.take_profit,
      stop: record.sent.stop,
    });
    return watch;
  }

  /** The order holds nothing any more: the watch on it is over. */
  private finish(watch: Watched): void {
    const { record } = watch;
    if (watch.due !== null) {
      this.journal.write("auto_watch", {
        order_id: record.order_id,
        ticker: record.ticker,
        what: "flat",
        after: watch.due.state,
        sells: watch.sells,
      });
    }
    record.watch = null;
    this.release(watch);
    this.watched.delete(record.order_id);
  }

  private release(watch: Watched): void {
    if (watch.timer !== null) clearTimeout(watch.timer);
    watch.timer = null;
    if (watch.streamId !== null) this.link.unwatchQuotes(watch.streamId);
    watch.streamId = null;
  }

  // -------------------------------------------------------------- quotes

  private openStream(watch: Watched, now: number): void {
    if (watch.streamId !== null || !this.link.isReady()) return;
    if (watch.streamAskedMs !== null && now - watch.streamAskedMs < STREAM_RETRY_MS) return;
    watch.streamAskedMs = now;
    watch.heard = false;
    this.forgetQuotes(watch);
    const { record } = watch;
    const listener: QuoteListener = {
      onPrice: (field, price) => this.onPrice(watch, field, price),
      onError: (code, message) => {
        // TWS ended the stream: it is asked for again later. Until then only the stop's own fills are seen.
        watch.streamId = null;
        this.forgetQuotes(watch);
        this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "no_quotes", code, message });
        this.say(`auto order ${record.order_id} ${record.ticker}: no live quotes from TWS (${message}); the take-profit cannot be watched`);
      },
    };
    try {
      watch.streamId = this.link.watchQuotes(this.bridge.contractFor(record), listener);
    } catch (err) {
      this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "no_quotes", message: errorMessage(err) });
    }
  }

  private onPrice(watch: Watched, field: QuoteField, price: number): void {
    if (this.closed || this.watched.get(watch.record.order_id) !== watch) return;
    watch.heard = true;
    if (field === "bid") {
      watch.bid = price;
      watch.bidAtMs = this.clock();
    } else if (field === "last") {
      watch.last = price;
      // A new trade: whatever was let go on the one before is open again.
      watch.stopLetGo = false;
      watch.takeProfitLetGo = false;
    }
    this.look(watch);
  }

  // ------------------------------------------------------------ the rule

  // Only exits that exist are looked at: a take-profit or a stop the operator has cancelled in
  // TWS is theirs to have cancelled.

  /** The stop has sold part: it triggered for certain, and what is left is what its limit did not reach. */
  private stopSoldPart(watch: Watched): boolean {
    return (watch.record.legs.stop?.filled_qty ?? 0) > 0;
  }

  /** The stop is due: it has sold part, or a trade printed at or under its price (what triggers it in TWS too). */
  private stopDue(watch: Watched): boolean {
    const { record, last, bid } = watch;
    const stop = record.sent.stop;
    const leg = record.legs.stop;
    if (stop === null || leg === null) return false;
    if (leg.filled_qty > 0) return true;
    if (isDone(leg.status) || last === null || last > stop + PRICE_EPS) return false;
    // That print was let go once, because the bid stood above the stop: it counts again only now
    // that the bid has come down to the stop too. (Trades that go on at the same price bring no
    // new "last" from TWS, so waiting for a new one alone could wait for ever.)
    return !watch.stopLetGo || (bid !== null && bid <= stop + PRICE_EPS);
  }

  /**
   * The take-profit was passed over: its price has traded while it is still working, and no sell
   * has begun (a sell moves the take-profit under the market: its price trading then means nothing).
   */
  private takeProfitPassed(watch: Watched): boolean {
    const { record, last } = watch;
    const takeProfit = record.sent.take_profit;
    const leg = record.legs.take_profit;
    return (
      !watch.takeProfitLetGo &&
      record.exit === null &&
      takeProfit !== null &&
      leg !== null &&
      !isDone(leg.status) &&
      last !== null &&
      last >= takeProfit - PRICE_EPS
    );
  }

  /**
   * The wait is over and a sell is about to go out: is there still reason to? One print started
   * the wait, and one print can be a stray one, or the price can have come back. This is asked
   * before every sell of the watch, and answers one of:
   *
   * - "sell": go on.
   * - "wait": nothing now, look again soon (a sell that is already out stays where it is).
   * - "clear": nothing was sent yet and the reason is gone: the order is left to its own exits,
   *   as if nothing had been seen. A later print starts it afresh.
   *
   * The stop: once a sell is out it goes on until the order holds nothing ("as soon as possible":
   * no price it will not sell at). Before the first, the bid decides: at or under the stop's
   * price the market is where the stop said to get out; above it the print that started the wait
   * did not hold (and if TWS's own stop did trigger on it, that order has sold by now).
   *
   * The take-profit: it is a take-profit, so it never sells under what the shares cost. With the
   * bid at or under the buy's average price nothing is sent; the stop is what answers a price
   * down there.
   */
  private verdict(watch: Watched): "sell" | "wait" | "clear" {
    const { record } = watch;
    const due = watch.due;
    if (due === null) return "wait";
    // The stream's last word on the bid: current while the stream is open, forgotten when it ends.
    const bid = watch.bid;
    if (due.state === "stop_due") {
      if (watch.sells > 0 || this.stopSoldPart(watch)) return "sell";
      const stop = record.sent.stop;
      const leg = record.legs.stop;
      // The stop was cancelled (by hand, or with a Sell of the operator's) while the watch waited.
      if (stop === null || leg === null || isDone(leg.status)) return "clear";
      if (bid !== null) return bid <= stop + PRICE_EPS ? "sell" : "clear";
      // No live bid to go by: the last trade is all there is.
      if (watch.last !== null) return watch.last <= stop + PRICE_EPS ? "sell" : "clear";
      // No price at all: the stream has just been opened (TWS was away and is back), or there is
      // none. That is not the reason being gone. What was seen stays seen until a price says otherwise.
      return "wait";
    }
    const cost = record.avg_fill_price;
    if (watch.sells === 0) {
      // The take-profit filled part or was cancelled, or the operator began a Sell: theirs now.
      const leg = record.legs.take_profit;
      if (leg === null || isDone(leg.status) || record.exit !== null) return "clear";
    }
    // Without a live bid or a cost there is nothing to hold the bid against: not yet.
    if (bid === null || cost === null) return "wait";
    if (bid > cost + PRICE_EPS) return "sell";
    return watch.sells === 0 ? "clear" : "wait";
  }

  /** Looks at one order: after a price, after a change to it, and when its timer runs out. */
  private look(watch: Watched): void {
    if (this.closed) return;
    const { record } = watch;
    if (this.watched.get(record.order_id) !== watch) return;
    if (record.held_qty <= 0) {
      this.finish(watch);
      return;
    }
    const now = this.clock();
    this.openStream(watch, now);
    if (!watch.silenceNoted && !watch.heard && watch.streamId !== null && watch.streamAskedMs !== null && now - watch.streamAskedMs >= STREAM_SILENT_MS) {
      watch.silenceNoted = true;
      this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "quotes_silent", ms: now - watch.streamAskedMs });
      this.say(`auto order ${record.order_id} ${record.ticker}: no live price from TWS yet; the take-profit cannot be watched without one`);
    }

    // The stop being due outranks the take-profit having been passed: a price that came all the
    // way back down is the stop's business, and the stop sells at any price where the take-profit
    // does not sell under cost.
    const state: "tp_crossed" | "stop_due" | null =
      watch.due?.state !== "stop_due" && this.stopDue(watch)
        ? "stop_due"
        : watch.due === null && this.takeProfitPassed(watch)
          ? "tp_crossed"
          : null;
    if (state !== null) {
      watch.due = { state, sinceMs: now };
      record.watch = { state, since: new Date(now).toISOString(), sells: watch.sells, last_error: null };
      const level = state === "tp_crossed" ? record.sent.take_profit : record.sent.stop;
      this.journal.write("auto_watch", {
        order_id: record.order_id,
        ticker: record.ticker,
        what: state,
        level,
        last: watch.last,
        bid: watch.bid,
        held: record.held_qty,
      });
      const seen = watch.last === null ? "" : ` (last ${formatPrice(watch.last)})`;
      this.say(
        state === "tp_crossed"
          ? `auto order ${record.order_id} ${record.ticker}: the take-profit ${level === null ? "" : formatPrice(level)} traded${seen} and has not filled`
          : `auto order ${record.order_id} ${record.ticker}: the stop ${level === null ? "" : formatPrice(level)} is due${seen} and has not sold everything`,
      );
    }

    if (watch.due === null) {
      this.lookAgainIn(watch, this.idleLookMs);
      return;
    }
    const grace = watch.due.state === "tp_crossed" ? this.auto.tpGraceMs : this.auto.stopGraceMs;
    const sellAt = Math.max(watch.due.sinceMs + grace, watch.lastSellMs === null ? 0 : watch.lastSellMs + this.auto.resellMs);
    if (now < sellAt) {
      this.lookAgainIn(watch, sellAt - now);
      return;
    }
    if (watch.selling) {
      this.lookAgainIn(watch, Math.min(this.idleLookMs, this.auto.resellMs));
      return;
    }
    const verdict = this.verdict(watch);
    if (verdict === "clear") {
      // Nothing was sent, and the reason for sending is gone.
      this.journal.write("auto_watch", {
        order_id: record.order_id,
        ticker: record.ticker,
        what: "cleared",
        was: watch.due.state,
        last: watch.last,
        bid: watch.bid,
      });
      this.say(
        watch.due.state === "tp_crossed"
          ? `auto order ${record.order_id} ${record.ticker}: nothing sold: the take-profit is no longer there to chase, or the bid is back under what the shares cost`
          : `auto order ${record.order_id} ${record.ticker}: nothing sold: the bid is back above the stop`,
      );
      // The trade that started it is let go: standing there as the last one, it must not start
      // the wait over (see `stopLetGo`).
      if (watch.due.state === "stop_due") watch.stopLetGo = true;
      else watch.takeProfitLetGo = true;
      watch.due = null;
      record.watch = null;
      this.lookAgainIn(watch, this.idleLookMs);
      return;
    }
    if (verdict === "wait") {
      this.lookAgainIn(watch, Math.min(this.idleLookMs, this.auto.resellMs));
      return;
    }
    if (this.link.isReady()) {
      // Nothing waits for this promise: whatever it throws is said and logged here, and the order
      // is looked at again all the same (a sell ends by looking again itself; this is for the
      // case that it could not).
      this.sell(watch).catch((err: unknown) => {
        this.journal.write("internal_error", { where: "the exit watch", message: errorMessage(err) });
        console.error("tws-bridge: error in the exit watch:", err);
        if (!this.closed && this.watched.get(record.order_id) === watch) this.lookAgainIn(watch, this.auto.resellMs);
      });
      return;
    }
    // While a sell is on its way, or TWS is away, it is looked at again soon.
    this.lookAgainIn(watch, Math.min(this.idleLookMs, this.auto.resellMs));
  }

  private lookAgainIn(watch: Watched, ms: number): void {
    if (watch.timer !== null) clearTimeout(watch.timer);
    watch.timer = setTimeout(
      () => {
        watch.timer = null;
        try {
          this.look(watch);
        } catch (err) {
          // A timer has nobody to answer to: said and logged, never thrown.
          this.journal.write("internal_error", { where: "the exit watch", message: errorMessage(err) });
          console.error("tws-bridge: error in the exit watch:", err);
        }
      },
      Math.max(1, Math.ceil(ms)),
    );
  }

  /** One sell at the bid: the first for this order, or the next move down of the one before. */
  private async sell(watch: Watched): Promise<void> {
    const { record } = watch;
    const due = watch.due;
    if (due === null) return;
    watch.selling = true;
    const now = this.clock();
    const bid = watch.bid !== null && now - watch.bidAtMs <= BID_FRESH_MS ? watch.bid : null;
    try {
      const sold = await this.bridge.autoSell(record.order_id, bid);
      watch.sells += 1;
      watch.lastErrorCode = null;
      watch.noSharesSinceMs = null;
      watch.noSharesCount = 0;
      if (record.watch !== null) {
        record.watch.sells = watch.sells;
        record.watch.last_error = null;
      }
      this.journal.write("auto_sell", {
        order_id: record.order_id,
        ticker: record.ticker,
        why: due.state,
        qty: sold.qty,
        limit: sold.limit,
        via: sold.via,
        status: sold.status,
        bid,
        bid_from: bid === null ? "tws" : "stream",
        sells: watch.sells,
      });
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : "internal";
      // "no_change": the sell already sits at or under the bid less the offset. It is marketable
      // as it stands; there is nothing to move, and nothing wrong.
      if (code !== "no_change") {
        const message = errorMessage(err);
        if (record.watch !== null) record.watch.last_error = message;
        // The same refusal every two seconds is one line, not thirty a minute.
        if (code !== watch.lastErrorCode) {
          this.journal.write("auto_sell_failed", { order_id: record.order_id, ticker: record.ticker, why: due.state, code, message });
          this.say(`auto order ${record.order_id} ${record.ticker}: the sell did not go out: ${message}`);
        }
        watch.lastErrorCode = code;
        if (!(err instanceof BridgeError)) console.error("tws-bridge: error in the exit watch:", err);
        if (GIVE_UP_CODES.has(code)) {
          this.giveUp(watch, code, message);
          return;
        }
        // "The account does not hold these shares" can be a moment's truth: TWS's position can
        // lag a fill, and another order's sell can have the shares spoken for. Only when it has
        // been the answer for a while is it the answer.
        if (code === "nothing_to_sell") {
          const at = this.clock();
          watch.noSharesSinceMs ??= at;
          watch.noSharesCount += 1;
          if (watch.noSharesCount >= NO_SHARES_TRIES && at - watch.noSharesSinceMs >= NO_SHARES_MS) {
            this.giveUp(watch, code, message);
            return;
          }
        } else {
          watch.noSharesSinceMs = null;
          watch.noSharesCount = 0;
        }
      }
    } finally {
      watch.selling = false;
      watch.lastSellMs = this.clock();
    }
    if (!this.closed && this.watched.get(record.order_id) === watch) this.look(watch);
  }

  /**
   * A sell that cannot go through however often it is tried (after 20 s of "the account does not
   * hold the shares the book says the order holds": they were sold by hand in TWS, most likely).
   * The watch on the order ends, and the order keeps the reason for the dashboard to show.
   */
  private giveUp(watch: Watched, code: string, message: string): void {
    const { record } = watch;
    this.givenUp.add(record.order_id);
    this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "gave_up", code, message });
    this.say(`auto order ${record.order_id} ${record.ticker}: the exit watch has stopped (${message})`);
    this.release(watch);
    this.watched.delete(record.order_id);
  }
}
