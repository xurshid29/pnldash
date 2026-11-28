import type { Contract } from "@stoqey/ib";
import { isDone } from "./book.js";
import type { OrderRecord } from "./book.js";
import type { SellData, SellScope, StopMove } from "./bridge.js";
import type { AutoConfig } from "./config.js";
import { BridgeError, errorMessage } from "./errors.js";
import type { Journal } from "./journal.js";
import type { QuoteField, QuoteListener } from "./link.js";
import { formatPrice, roundDown } from "./order.js";
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
// It also tends the stop of a position that is doing well, the operator's choice of the same day
// ("I would prefer 1 and 2"), with nothing sold by the watch itself:
//
//   a. Once the price has traded `auto.stopToEntryAtPct` above what the shares cost, the stop is
//      moved up to that cost: a trade that was up 10% no longer ends 10% down.
//   b. The take-profit is for a part of the position (`auto.takeProfitPortion`, half). When it has
//      sold, the stop is made to fit what is left (TWS may have shrunk it, left it, or taken it
//      away with the take-profit: all three are handled), stands at the cost at least, and from
//      then on follows the highest price `auto.trailPct` under it, never down.
//
// Each of those is `Bridge.autoMoveStop`: one stop order changed, or one placed when the bracket's
// is gone. A stop cannot be put at or above the bid (it would sell at once), so when the price is
// already under where the stop should stand, that is the stop being due, and rule 2 takes over.
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
/** A stop is put no nearer to the bid than this many percent under it: nearer, it would sell on the next tick. */
const STOP_ROOM_PCT = 1.0;
/** A trailing stop is moved only when it would go up by at least this many percent: every move is a message to TWS. */
const STOP_STEP_PCT = 1.0;
/** After the take-profit's first fill, how long TWS is given to say what became of the stop before the watch touches it. */
const HALF_SETTLE_MS = 700;
/** After a stop move that failed, how long before the next try. */
const MOVE_RETRY_MS = 15_000;
/** A stop of the wrong size is made to fit this soon after the last move (the bridge keeps changes to one order 300 ms apart). */
const FIT_GAP_MS = 500;
/**
 * A stop that was still working this long after the take-profit's last fill, and is gone later,
 * was cancelled by hand: TWS takes a bracket's stop away with the fill itself, not seconds after.
 */
const HAND_AFTER_MS = 3000;
/**
 * Refusals of a stop move after which the stop is left alone for good. "stop_gone" is not one:
 * whether a stop that is gone was cancelled by hand is `tend`'s to judge, with time to do it in.
 */
const MOVE_OFF_CODES = new Set(["not_auto", "unknown_order"]);
/** After this many stop moves in a row that TWS or the bridge refused, the watch stops trying for that order and says so. */
const MOVE_GIVE_UP = 5;
/** Failures that are the connection's, not a refusal: they do not count toward giving up. */
const MOVE_WAIT_CODES = new Set(["tws_down", "tws_offline", "tws_timeout", "no_position"]);

/** What the watch needs of the bridge. */
export interface WatchHost {
  onOrderChanged: ((record: OrderRecord) => void) | null;
  onLinkUp: (() => void) | null;
  onLinkDown: (() => void) | null;
  allOrders(): OrderRecord[];
  contractFor(record: OrderRecord): Contract;
  /** `scope` "target": only the take-profit order's own shares; "all": everything the order holds. */
  autoSell(orderId: number, bid: number | null, scope: SellScope): Promise<SellData>;
  autoMoveStop(orderId: number, stop: number): Promise<StopMove>;
  /** The stop order's own size as last sent or reported; null when not known. */
  stopQtyOf(record: OrderRecord): number | null;
  /** The bridge itself asked TWS to cancel the order's current stop (one TWS answered with an error). */
  stopCleanedUp(record: OrderRecord): boolean;
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
  /** The highest trade seen since the watch began: what sends the stop to the entry. Kept when a stream ends. */
  hi: number | null;
  /**
   * The highest bid seen since the watch began: what the stop trails. The bid and not the trade,
   * because one stray print far above the market would lift a trail for good, to a level over
   * the bid, and that would sell the position at once; a stray print does not move the bid.
   */
  hiBid: number | null;
  /** When the last stop move went out (or failed). */
  lastMoveMs: number | null;
  /** A stop move is on its way to TWS. */
  moving: boolean;
  /** No stop move before this time (the gap between two moves, or the wait after one that failed). */
  moveAfterMs: number;
  /** The stop is left alone altogether: it was cancelled by hand. */
  moveOff: boolean;
  /**
   * The watch has given up moving the stop: its moves were refused too often. No more stop orders
   * are tried; if no stop is working, the rule's own level still stands in for one.
   */
  gaveUp: boolean;
  /** Stop moves refused in a row. */
  moveFailures: number;
  lastMoveErrorCode: string | null;
  /** When the take-profit was first seen to have sold something. */
  halfSeenMs: number | null;
  /** When the stop was first seen gone. */
  stopGoneMs: number | null;
  /** When the stop was last seen working. */
  stopSeenMs: number | null;
  /** When the watch last placed a stop of its own for this order. */
  stopPlacedMs: number | null;
  /** How much the take-profit had sold at the last look, and when that last changed (null: not looked yet). */
  targetFilled: number | null;
  targetFillMs: number | null;
  /**
   * Where the rule's stop stands when no order could be put there: the bid was already at or
   * under it. A bid at or under this level is the stop being due, as a trade under the order's
   * price is.
   */
  level: number | null;
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
      hi: null,
      hiBid: null,
      lastMoveMs: null,
      moving: false,
      moveAfterMs: 0,
      moveOff: false,
      gaveUp: false,
      moveFailures: 0,
      lastMoveErrorCode: null,
      halfSeenMs: null,
      stopGoneMs: null,
      stopSeenMs: null,
      stopPlacedMs: null,
      targetFilled: null,
      targetFillMs: null,
      level: null,
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
      if (watch.hiBid === null || price > watch.hiBid) watch.hiBid = price;
    } else if (field === "last") {
      watch.last = price;
      if (watch.hi === null || price > watch.hi) watch.hi = price;
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
    // The rule's own level, where no order could be put (`tend`): the bid at or under it.
    if (watch.level !== null && bid !== null && bid <= watch.level + PRICE_EPS) return true;
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
      const leg = record.legs.stop;
      const working = record.sent.stop !== null && leg !== null && !isDone(leg.status);
      // The stop was cancelled (by hand, or with a Sell of the operator's) while the watch waited,
      // and the rule has no level of its own standing: nothing to chase.
      if (!working && watch.level === null) return "clear";
      // Where the stop stands: the order's price, or the rule's level where no order could be put.
      const stop = Math.max(working ? (record.sent.stop ?? 0) : 0, watch.level ?? 0);
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

    // The take-profit that was passed over has sold now (by itself, or through the watch's sell):
    // that chase is over. What the order still holds is the stop's, which is tended below.
    if (watch.due?.state === "tp_crossed") {
      const leg = record.legs.take_profit;
      if (leg === null || isDone(leg.status)) {
        // "target_gone": it ended without selling (cancelled in TWS): nothing left to chase either.
        const what = (leg?.filled_qty ?? 0) > 0 ? "target_sold" : "target_gone";
        this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what, sells: watch.sells, held: record.held_qty });
        watch.due = null;
        watch.sells = 0;
        watch.lastSellMs = null;
        record.watch = null;
      }
    }
    // The stop of a position that is doing well: to the entry, to fit what is left, trailing.
    // `soon`: it wants to look again in so many ms (TWS is settling, or a move must wait its turn).
    // It goes on while a passed-over take-profit is being chased: that chase can last (it does not
    // sell under cost), and the stop beside it must still fit what is held.
    const soon = watch.due === null || watch.due.state === "tp_crossed" ? this.tend(watch, now) : null;

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
      // The stop taking over from a take-profit chase starts its own count: what that chase sent
      // is not the stop's first sell, and the stop's first sell asks the bid.
      if (watch.due !== null) {
        watch.sells = 0;
        watch.lastSellMs = null;
      }
      watch.due = { state, sinceMs: now };
      record.watch = { state, since: new Date(now).toISOString(), sells: watch.sells, last_error: null };
      const level = state === "tp_crossed" ? record.sent.take_profit : Math.max(record.sent.stop ?? 0, watch.level ?? 0) || null;
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
      // A stop move on its way looks again itself when it is done.
      if (!watch.moving) this.lookAgainIn(watch, soon === null ? this.idleLookMs : Math.min(this.idleLookMs, soon));
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
      watch.level = null;
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

  // ------------------------------------------------------- tending the stop

  /**
   * Where the stop of this order should stand now, and a move of it when that is worth a message.
   * Nothing is sold here. It runs while nothing is due, the buy is over, no sell is working and
   * the stop has not begun to sell.
   */
  private tend(watch: Watched, now: number): number | null {
    const { auto } = this;
    const { record } = watch;
    const tended = auto.stopToEntryAtPct > 0 || auto.takeProfitPortion < 1;
    if (!tended || watch.moveOff || watch.moving || watch.selling || !this.link.isReady()) return null;
    const cost = record.avg_fill_price;
    if (cost === null || !(cost > 0)) return null;
    if (!(isDone(record.status) || record.filled_qty >= record.sent.qty)) return null;
    // A sell order for everything held has taken the stop's place. A sell through the take-profit
    // order has not: that order is for its own shares, and the stop beside it is still tended.
    if (record.exit !== null && !isDone(record.exit.status) && record.exit.via !== "take_profit") return null;
    const stopLeg = record.legs.stop;
    if (stopLeg !== null && stopLeg.filled_qty > 0) return null;
    const stopWorking = record.sent.stop !== null && stopLeg !== null && !isDone(stopLeg.status);
    const targetFilled = record.legs.take_profit?.filled_qty ?? 0;
    const targetSold = targetFilled > 0;
    if (targetFilled !== watch.targetFilled) {
      watch.targetFilled = targetFilled;
      watch.targetFillMs = now;
    }
    if (stopWorking) {
      // A stop that is being cancelled is not one seen working: the time it waits for TWS's
      // answer must not count as time it stood.
      if (stopLeg.status !== "PendingCancel") watch.stopSeenMs = now;
      watch.stopGoneMs = null;
    } else {
      // The stop is gone. TWS takes a bracket's stop away with a fill of its take-profit, at once;
      // the bridge takes a stop of the watch's own away when TWS answered it with an error; a
      // move of the watch's that TWS answers "no such order" marks it not working ("Inactive");
      // TWS may refuse a stop of the watch's own just after it was placed. A stop that goes in
      // any other way was cancelled by hand, and an exit cancelled by hand is left alone for
      // good. So: with nothing sold by the take-profit it is "by hand" once the settle time has
      // passed with still nothing sold (TWS's word that the stop is gone can arrive a moment
      // before its word of the fill that took it). With something sold it is "by hand" when TWS
      // says it was cancelled, the bridge did not ask for that, and it was still seen working
      // well after the last thing that could have taken it (the take-profit's last fill; for a
      // stop of the watch's own, its placing).
      watch.stopGoneMs ??= now;
      const since = Math.max(watch.targetFillMs ?? 0, watch.stopPlacedMs ?? 0);
      const byHand = targetSold
        ? stopLeg?.status !== "Inactive" &&
          !this.bridge.stopCleanedUp(record) &&
          watch.stopSeenMs !== null &&
          watch.stopSeenMs - since > HAND_AFTER_MS
        : now - watch.stopGoneMs >= HALF_SETTLE_MS;
      if (byHand) {
        watch.moveOff = true;
        watch.level = null;
        this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "stop_by_hand", held: record.held_qty });
        this.say(`auto order ${record.order_id} ${record.ticker}: its stop was cancelled by hand: the watch leaves the stop alone from here`);
        return null;
      }
      if (!targetSold) return HALF_SETTLE_MS - (now - watch.stopGoneMs);
    }

    // Where the stop should stand: never under where it stood last (also when that order is gone).
    // The gain is the highest bid's, as the trail's is: a stray print does not move a stop.
    const base = record.sent.stop ?? 0;
    let want = base;
    let why: "to_entry" | "trail" | "fit" = "fit";
    const gained = watch.hiBid === null ? 0 : (watch.hiBid / cost - 1) * 100;
    // To the cost: once the price has gained enough, and in any case once the take-profit has sold
    // (what is left of a trade that reached its target does not go back under what it cost).
    if (((auto.stopToEntryAtPct > 0 && gained >= auto.stopToEntryAtPct) || targetSold) && cost > want) {
      want = cost;
      why = "to_entry";
    }
    if (targetSold && auto.trailPct > 0 && watch.hiBid !== null && watch.hiBid * (1 - auto.trailPct / 100) > want) {
      want = watch.hiBid * (1 - auto.trailPct / 100);
      why = "trail";
    }
    want = roundDown(want);
    if (!(want > 0)) return null;

    // While no stop order is working (TWS took it with the take-profit's fill and the new one is
    // not in yet, or could not be placed), the rule's own level stands in for it: a bid at or
    // under it is the stop being due (`stopDue`), and what is held is sold at the bid. This comes
    // before every wait below, so there is no moment with neither an order nor a level.
    if (!stopWorking && watch.bid !== null && watch.bid <= want + PRICE_EPS) {
      watch.level = want;
      return null;
    }
    // The watch has given up moving this order's stop (TWS refused it too often). The level above
    // still stands in for a stop that is not there; no more orders are tried.
    if (watch.gaveUp) return null;
    if (targetSold) {
      watch.halfSeenMs ??= now;
      // TWS has a moment to say what became of the stop when the take-profit filled.
      if (now - watch.halfSeenMs < HALF_SETTLE_MS) return HALF_SETTLE_MS - (now - watch.halfSeenMs);
    }

    // Is a move worth a message? The stop is gone (after the take-profit sold), it is not known
    // to be the size of what is held, or it would go up: to the entry in one move, trailing by a
    // step. A size that is not known (after a restart TWS reports the size of every order it
    // still has, within the settle time: one it did not report may be gone) is asked of TWS by
    // the move itself: it takes the change, or says it has no such order.
    const knownQty = this.bridge.stopQtyOf(record);
    const wrongSize = stopWorking && targetSold && knownQty !== record.held_qty;
    const up = want > base + PRICE_EPS && (why !== "trail" || want >= base * (1 + STOP_STEP_PCT / 100));
    if (stopWorking && !wrongSize && !up) return null;
    // Two moves are kept apart, and a move that failed waits longer. A stop of the wrong size, or
    // no stop at all, does not wait out a failure: only a short gap since the last try.
    const urgent = wrongSize || !stopWorking;
    const sinceLast = (watch.lastMoveMs ?? Number.NEGATIVE_INFINITY) + (wrongSize ? FIT_GAP_MS : auto.resellMs);
    const notBefore = urgent ? Math.min(watch.moveAfterMs, sinceLast) : watch.moveAfterMs;
    if (now < notBefore) return notBefore - now;

    // A stop at or over the bid would sell at once: no order goes there.
    const ref = watch.bid ?? watch.last;
    if (ref === null) {
      // No price to hold the place against (no live quotes for this stock). The size and the
      // presence of a stop do not need one: it is made to fit, or put back, where it stood.
      if (!wrongSize && stopWorking) return null;
      want = roundDown(base);
      why = "fit";
      if (!(want > 0)) return null;
    }
    const ceiling = ref === null ? Number.POSITIVE_INFINITY : ref * (1 - STOP_ROOM_PCT / 100);
    if (want >= ceiling) {
      const hit = watch.bid !== null && watch.bid <= want + PRICE_EPS;
      // The bid is already at or under where the stop should stand, and no order of TWS's stands
      // there to act on it: the rule's stop is hit. That is the stop being due (`stopDue`), and
      // what is held is sold at the bid by that rule.
      if (hit && (!stopWorking || want > base + PRICE_EPS)) {
        watch.level = want;
        return null;
      }
      if (!stopWorking) {
        // No stop at all, and the place it should have is too near the bid: as near as there is room for.
        want = roundDown(Math.min(want, ceiling));
        if (!(want > 0)) return null;
      } else if (wrongSize) {
        // Too near to raise: it is still made to fit what is held, where it stands.
        want = base;
        why = "fit";
      } else {
        // Too near to raise and not hit: asked again with the next price.
        return null;
      }
    }

    watch.moving = true;
    watch.lastMoveMs = now;
    // With no stop working, this move places one.
    if (!stopWorking) watch.stopPlacedMs = now;
    const hi = watch.hi;
    const hiBid = watch.hiBid;
    this.bridge
      .autoMoveStop(record.order_id, want)
      .then((moved) => {
        watch.level = null;
        watch.lastMoveErrorCode = null;
        watch.moveFailures = 0;
        watch.moveAfterMs = this.clock() + this.auto.resellMs;
        this.journal.write("auto_stop", {
          order_id: record.order_id,
          ticker: record.ticker,
          why,
          stop: moved.stop,
          stop_limit: moved.stop_limit,
          qty: moved.qty,
          via: moved.via,
          leg_order_id: moved.leg_order_id,
          cost,
          hi,
          hi_bid: hiBid,
        });
      })
      .catch((err: unknown) => {
        const code = err instanceof BridgeError ? err.code : "internal";
        // "no_change": the stop is there already. "too_soon" / "busy": asked again shortly.
        const soon = code === "no_change" || code === "too_soon" || code === "busy";
        watch.moveAfterMs = this.clock() + (soon ? this.auto.resellMs : MOVE_RETRY_MS);
        if (code === "no_change") return;
        if (MOVE_OFF_CODES.has(code)) watch.moveOff = true;
        if (code !== watch.lastMoveErrorCode) {
          const message = errorMessage(err);
          this.journal.write("auto_stop_failed", { order_id: record.order_id, ticker: record.ticker, why, stop: want, code, message });
          if (!soon) this.say(`auto order ${record.order_id} ${record.ticker}: the stop was not moved: ${message}`);
        }
        watch.lastMoveErrorCode = code;
        if (!(err instanceof BridgeError)) console.error("tws-bridge: error in the exit watch:", err);
        // The same thing refused again and again is not going to be taken: the watch stops asking,
        // and says so where it will be seen. A connection that is away, or slow, is not a refusal.
        if (!soon && !MOVE_WAIT_CODES.has(code)) watch.moveFailures += 1;
        if (watch.moveFailures >= MOVE_GIVE_UP && !watch.gaveUp) {
          watch.gaveUp = true;
          const note = `the exit watch could not set this order's stop (${errorMessage(err)}): look at it in TWS`;
          record.note = note;
          this.journal.write("auto_watch", { order_id: record.order_id, ticker: record.ticker, what: "stop_gave_up", code, tries: watch.moveFailures, note });
          this.say(`auto order ${record.order_id} ${record.ticker}: ${note}`);
        }
      })
      .finally(() => {
        watch.moving = false;
        if (!this.closed && this.watched.get(record.order_id) === watch) this.lookAgainIn(watch, Math.min(this.idleLookMs, this.auto.resellMs));
      });
    return null;
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
      // A take-profit that was passed over: its own shares, through that order. The stop due:
      // everything the order holds.
      const scope: SellScope = due.state === "tp_crossed" ? "target" : "all";
      const sold = await this.bridge.autoSell(record.order_id, bid, scope);
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
