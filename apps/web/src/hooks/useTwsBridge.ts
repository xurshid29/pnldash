import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  BRIDGE_ALERT_MAX_AGE_MS, BRIDGE_DEFAULT_URL, bridgeAutoMissing, bridgeBuyNumbers, bridgeGetAuto, bridgeOrderBusy,
  bridgeOrderCancellable, bridgeOrderCounts, bridgeOrderLive, bridgeOrderView, bridgeOrigin, bridgePairFeed, bridgeSentText,
  bridgeSetAutoMode, bridgeStopNumbers, describeBridge, toBridgeFailure, twsBridge,
  type AutoMode, type AutoStatus, type BridgeConn, type BridgeEntry, type BridgeFailure, type BridgeOrder,
  type BridgeOrderRecord, type BridgeOrderRequest, type BridgeOrderView, type BridgeStatus, type BridgeView,
} from '../api/twsBridge';
import { tvApi } from '../api/tv';

// The TWS bridge on this browser (2026-11-26): its settings, the bridge's status, and what a
// setup row can ask of it — place the operator's bracket order (/order), follow it (/orders)
// and cancel it (/cancel). Device-local on purpose: the bridge runs on the operator's own
// computer, so the switch, the address and the token live in this browser's localStorage and
// nowhere else. Off by default: another signed-in user sees one small "TWS" button and nothing
// more, and no call is made until the switch is on and a token is set.
//
// The work is in TwsBridgeController, a plain object outside React (one per page, so a remount of
// the sidebar loses nothing — above all not the one-click-one-order lock); useTwsBridge reads it.
//
// 2026-11-27: the first version could also make TWS's windows show a row's ticker (a per-row
// "TWS" button, and a row click TWS followed). The operator did not need it; it is gone, with its
// `follow` setting (a stored one from before is ignored and dropped at the next save).
//
// 2026-11-27, later: beside Buy, a second button places the stop entry (/order with entry
// "stop"): the same bracket with a buy that waits above the alert's price and fills only if the
// price gets there; IB cancels it by itself after the bridge's entryValidSec. It shares Buy's
// lock, click state and error handling.
//
// 2026-11-28, the automation: the bridge buys every strong POP of its hour by itself. The
// controller reads /auto with the status poll (every 5 s; every 2 s while it is on or watching
// and its hour is open), switches its mode, and links it to the server's alert stream: a token
// from the server (POST /api/tv/feed-token), handed straight to the bridge's /auto/feed and kept
// nowhere. It links when the operator picks Watch only or On and the bridge has no link, and
// again by itself (at most once a minute) while the mode is not off and the bridge reports no
// link or a refused one. An older bridge has no /auto (404): it is asked again only every 30 s,
// or at once when the bridge's version changes.

export interface TwsBridgeSettings {
  enabled: boolean;   // the feature, on this browser
  url: string;        // the bridge's address: http://127.0.0.1:<port>
  token: string;      // the secret from tools/tws-bridge/config.json
  buy: boolean;       // show the Buy button
}

const STORAGE_KEY = 'twsBridge.settings';
export const TWS_BRIDGE_DEFAULTS: TwsBridgeSettings = { enabled: false, url: BRIDGE_DEFAULT_URL, token: '', buy: true };

// Only the settings this build knows: anything else in a stored value (the old `follow`) is left out.
function clean(v: Partial<Record<keyof TwsBridgeSettings, unknown>>): TwsBridgeSettings {
  return {
    enabled: v.enabled === true,
    url: typeof v.url === 'string' && v.url.trim() !== '' ? v.url.trim() : TWS_BRIDGE_DEFAULTS.url,
    token: typeof v.token === 'string' ? v.token.trim() : '',
    buy: v.buy !== false,
  };
}

function loadSettings(): TwsBridgeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return TWS_BRIDGE_DEFAULTS;
    const v: unknown = JSON.parse(raw);
    return v != null && typeof v === 'object' ? clean(v as Record<string, unknown>) : TWS_BRIDGE_DEFAULTS;
  } catch {
    return TWS_BRIDGE_DEFAULTS;
  }
}

function saveSettings(s: TwsBridgeSettings): void {
  // The controller's copy is the source of truth, so the settings still hold for this tab when
  // storage is blocked.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export interface BridgeTiming {
  statusEveryMs: number;     // /status, while the tab is visible
  followEveryMs: number;     // /orders while there is a reason to ask often (see TwsBridgeController.fast) …
  followMs: number;          // … which a click is for this long
  noteMs: number;            // a row's note stays this long: it has to be read
  // A Buy click that got no answer in time: after this long, an /orders answer without an order
  // for the alert means none was placed (the bridge's own waits are a few seconds).
  unknownSettleMs: number;
  autoFastEveryMs: number;   // /auto while the automation is on or watching and its hour is open (else with /status)
  autoMissingMs: number;     // /auto again after a 404 (an older bridge): no sooner than this
  relinkEveryMs: number;     // a link to the server's alerts that the operator did not click for: at most this often
}
const TIMING: BridgeTiming = {
  statusEveryMs: 5_000, followEveryMs: 2_000, followMs: 60_000, noteMs: 12_000, unknownSettleMs: 20_000,
  autoFastEveryMs: 2_000, autoMissingMs: 30_000, relinkEveryMs: 60_000,
};

// What is being asked of an order right now. One thing at a time per order: while a call is in
// flight its three buttons take no click.
export type OrderAction = 'cancel' | 'chase' | 'sell';

// What a Buy click on one alert came to — either of its two buttons, Buy (entry "now") or the
// stop entry (entry "stop"): one alert, one click at a time. Keyed by the alert's id.
export type BuyClick =
  // `entry`: which of the two buttons the call is for (it reads "sending…"; both take no click)
  | { phase: 'sending'; at: number; ticker: string; entry: BridgeEntry }
  | { phase: 'sent'; at: number; ticker: string; order: BridgeOrder }
  // no answer in time: the order may have gone out; /orders is asked until it is known
  | { phase: 'unknown'; at: number; ticker: string; text: string }
  // the bridge refused the click because this alert already has an order (`duplicate_alert`):
  // its text is shown, and the alert stays used
  | { phase: 'taken'; at: number; ticker: string; text: string }
  | { phase: 'error'; at: number; ticker: string; text: string };

export interface TwsBridgeState {
  settings: TwsBridgeSettings;
  // the last /status answer, or the failure in its place; both null before the first answer
  status: BridgeStatus | null;
  failure: BridgeFailure | null;
  // today's orders as the bridge lists them, newest first
  orders: BridgeOrderRecord[];
  clicks: Record<string, BuyClick>;
  // by ticker, for a few seconds: why a click did nothing (a Cancel, a Chase or a Sell the bridge
  // refused, a click the page held back)
  notes: Record<string, string>;
  // by order id: the call in flight for that order
  busy: Record<number, OrderAction>;
  // The automation (2026-11-28). `auto`: the last /auto answer; null before it, after a failure
  // of /status, and on a bridge without it (`autoMissing`, its 404).
  auto: AutoStatus | null;
  autoMissing: boolean;
  // /auto failed in another way (no answer, an answer of another shape); the last answer stays.
  autoFailure: string | null;
  // the mode a switch is being made to, and why the last switch did not take
  autoBusy: AutoMode | null;
  autoError: string | null;
  // why the last link to the server's alerts failed (the server's side, or the bridge's)
  linkError: string | null;
}

export interface BridgeEnv {
  load: () => TwsBridgeSettings;
  save: (s: TwsBridgeSettings) => void;
  // is the tab on screen? /status is not polled while it is not
  visible: () => boolean;
  timing?: Partial<BridgeTiming>;
}

type Timer = ReturnType<typeof setTimeout>;

export class TwsBridgeController {
  private state: TwsBridgeState;
  private readonly env: BridgeEnv;
  private readonly t: BridgeTiming;
  private readonly listeners = new Set<() => void>();
  private mounted = 0;
  // The bridge and token being polled (null = no polling), and a count that goes up whenever
  // that changes: an answer from before the change is dropped.
  private pollKey: string | null = null;
  private pollTimer: Timer | null = null;
  private epoch = 0;
  private polling = false;
  private pollAgain = false;
  private ordersLoading = false;
  private ordersAgain = false;
  // From the last /orders answer: an order to ask about every 2 s (a buy working, or shares held
  // with a sell working), and one to ask about with the status poll (also: shares held).
  private ordersBusy = false;
  private ordersLive = false;
  private ordersSig = '';
  private touchedUntil = 0;
  private fastTimer: Timer | null = null;
  private readonly noteTimers = new Map<string, Timer>();
  // One click = one order. An alert's id is in here while its /order call is in flight, while
  // its outcome is unknown, and after a success for as long as that order is working or has a
  // fill (an order that ended with nothing filled frees it); a ticker's ("ticker:RAYA") while
  // any /order call for it is in flight.
  private readonly locks = new Set<string>();
  // One click = one call, for Cancel, Chase and Sell too: an order's id is in here while a call
  // for it is in flight.
  private readonly inFlight = new Map<number, OrderAction>();
  // The automation's /auto: one call at a time (a refresh asked for meanwhile runs after it); the
  // 2 s round's timer; after a 404, when to ask again and the bridge version that answered it; a
  // count that goes up with each mode switch, so an answer from before the switch is dropped.
  private autoLoading = false;
  private autoAgain = false;
  private autoTimer: Timer | null = null;
  private autoRetryAt = 0;
  private autoMissingVersion: string | null = null;
  private autoGen = 0;
  private lastVersion: string | null = null;
  // The link to the server's alerts: the one in flight (a click and the background share it) and
  // when the last one was tried.
  private linking: Promise<string | null> | null = null;
  private linkTriedAt = 0;

  constructor(env: BridgeEnv) {
    this.env = env;
    this.t = { ...TIMING, ...env.timing };
    this.state = {
      settings: env.load(), status: null, failure: null, orders: [], clicks: {}, notes: {}, busy: {},
      auto: null, autoMissing: false, autoFailure: null, autoBusy: null, autoError: null, linkError: null,
    };
  }

  getState = (): TwsBridgeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<TwsBridgeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private conn(): BridgeConn {
    return { url: this.state.settings.url, token: this.state.settings.token };
  }

  // A sidebar is on screen: poll while one is. Answers the call that takes it off again.
  mount = (): (() => void) => {
    this.mounted += 1;
    this.sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.mounted -= 1;
      this.sync();
    };
  };

  update = (patch: Partial<TwsBridgeSettings>): void => {
    const next = clean({ ...this.state.settings, ...patch });
    this.env.save(next);
    this.set({ settings: next });
    this.sync();
  };

  // The settings changed in another tab.
  reload = (): void => {
    this.set({ settings: this.env.load() });
    this.sync();
  };

  // The tab is on screen again: ask at once, and pick the 2 s round up again if there is a
  // reason for it.
  wake = (): void => {
    void this.poll();
    if (this.wantsFast()) this.fast();
  };

  // Starts, stops or restarts the /status poll to match the settings: every 5 s while a sidebar
  // is mounted and the feature is on with a token and a usable address.
  private sync(): void {
    const s = this.state.settings;
    const origin = bridgeOrigin(s.url);
    const key = this.mounted > 0 && s.enabled && s.token !== '' && origin != null ? `${origin}\n${s.token}` : null;
    if (key === this.pollKey) return;
    this.pollKey = key;
    this.epoch += 1;
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.autoTimer != null) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.autoRetryAt = 0;
    this.linkTriedAt = 0;
    this.lastVersion = null;
    this.ordersSig = '';
    const st = this.state;
    if (st.status != null || st.failure != null || st.auto != null || st.autoMissing || st.autoFailure != null
      || st.autoError != null || st.linkError != null) {
      this.set({ status: null, failure: null, auto: null, autoMissing: false, autoFailure: null, autoError: null, linkError: null });
    }
    if (key == null) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.t.statusEveryMs);
    void this.poll();
  }

  // One /status call; nothing while the tab is hidden. The orders are re-read with it when the
  // day's counts change, while an order is working or holds shares (its exits in TWS can fill at
  // any time) and while a click's outcome is not known.
  private async poll(): Promise<void> {
    if (this.pollKey == null || !this.env.visible()) return;
    if (this.polling) { this.pollAgain = true; return; }
    this.polling = true;
    const epoch = this.epoch;
    try {
      const status = await twsBridge.status(this.conn());
      if (epoch !== this.epoch) return;
      this.set({ status, failure: null });
      const sig = `${status.today.orders}/${status.today.filled}`;
      if (sig !== this.ordersSig || this.ordersLive || this.hasUnknown()) {
        this.ordersSig = sig;
        void this.loadOrders();
      }
      // The automation, with the status: unless its 2 s round is on (it then asks by itself). A
      // bridge that answered 404 and has since been restarted as another version is asked at once.
      this.lastVersion = status.version;
      if (this.state.autoMissing && status.version !== this.autoMissingVersion) this.autoRetryAt = 0;
      if (this.autoTimer == null) void this.loadAuto(false);
    } catch (err) {
      // The bridge is not reachable: the panel shows the status line alone. What /auto said is
      // dropped, so a bridge that comes back (perhaps a newer one) is asked afresh.
      if (epoch === this.epoch) {
        this.autoRetryAt = 0;
        this.set({ status: null, failure: toBridgeFailure(err), auto: null, autoMissing: false, autoFailure: null });
      }
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    }
  }

  private hasUnknown(): boolean {
    return Object.values(this.state.clicks).some((c) => c.phase === 'unknown');
  }

  private setClick(alertId: string, click: BuyClick): void {
    this.set({ clicks: { ...this.state.clicks, [alertId]: click } });
  }

  // A line on one ticker's card for a few seconds: why a click did nothing.
  note = (ticker: string, text: string): void => {
    const old = this.noteTimers.get(ticker);
    if (old != null) clearTimeout(old);
    this.set({ notes: { ...this.state.notes, [ticker]: text } });
    this.noteTimers.set(ticker, setTimeout(() => {
      this.noteTimers.delete(ticker);
      const notes = { ...this.state.notes };
      delete notes[ticker];
      this.set({ notes });
    }, this.t.noteMs));
  };

  // Today's orders, and what they mean for the clicks made on this page:
  // - an order placed here that has ended with nothing filled (cancelled from the card or in TWS,
  //   refused, never sent) frees its alert: the lock is released and the click forgotten, so the
  //   card is worked out from /orders alone — exactly what a reloaded page sees;
  // - the same when the order the bridge refused a click for (`duplicate_alert`) has ended so;
  // - a click that got no answer is settled: its order is in the list (it went out after all),
  //   or it is not and enough time has passed (it never did).
  private async loadOrders(): Promise<void> {
    const s = this.state.settings;
    if (!s.enabled || s.token === '') return;
    // A call that comes while one is in flight (a click's own, right after its answer) is not
    // dropped: the list is read once more when that one is back, so it is never older than the click.
    if (this.ordersLoading) { this.ordersAgain = true; return; }
    this.ordersLoading = true;
    let answered = false;
    try {
      const orders = await twsBridge.orders(this.conn());
      this.ordersBusy = orders.some(bridgeOrderBusy);
      this.ordersLive = orders.some(bridgeOrderLive);
      const clicks = { ...this.state.clicks };
      for (const [alertId, c] of Object.entries(clicks)) {
        if (c.phase === 'sent') {
          const own = orders.find((o) => o.order_id === c.order.order_id);
          if (own != null && !bridgeOrderCounts(own)) {
            this.locks.delete(alertId);
            delete clicks[alertId];
          }
        } else if (c.phase === 'taken') {
          const theirs = orders.filter((o) => o.asked.alert_id === alertId);
          if (theirs.length > 0 && !theirs.some(bridgeOrderCounts)) {
            this.locks.delete(alertId);
            delete clicks[alertId];
          }
        } else if (c.phase === 'unknown') {
          const rec = orders.find((o) => o.asked.alert_id === alertId
            || (o.ticker === c.ticker && Date.parse(o.placed_at) >= c.at - 2_000));
          if (rec) {
            clicks[alertId] = {
              phase: 'sent', at: c.at, ticker: c.ticker,
              order: {
                order_id: rec.order_id, ticker: rec.ticker, entry: rec.entry ?? 'now', qty: rec.sent.qty, limit: rec.sent.limit,
                trigger: rec.sent.trigger ?? null, good_until: rec.sent.good_until ?? null,
                take_profit: rec.sent.take_profit, stop: rec.sent.stop, stop_limit: rec.sent.stop_limit, status: rec.status,
              },
            };
          } else if (Date.now() - c.at > this.t.unknownSettleMs) {
            this.locks.delete(alertId);
            clicks[alertId] = {
              phase: 'error', at: Date.now(), ticker: c.ticker,
              text: 'The bridge gave no answer and lists no order for this alert: nothing was sent.',
            };
          }
        }
      }
      this.set({ orders, clicks });
      answered = true;
    } catch {
      // the status line says what is wrong; the next status poll that is answered asks again
    } finally {
      this.ordersLoading = false;
      if (this.ordersAgain) {
        this.ordersAgain = false;
        void this.loadOrders();
      } else if (answered && this.wantsFast()) {
        this.fast();   // a bridge that does not answer is not asked every 2 s
      }
    }
  }

  // Is there a reason to ask /orders every 2 s? An order is working (it can fill at any moment),
  // an order holds shares with a sell working, a Buy click's outcome is open, or something was
  // clicked in the last 60 s. Otherwise the orders are re-read with the status poll.
  private wantsFast(): boolean {
    return this.ordersBusy || Date.now() < this.touchedUntil
      || Object.values(this.state.clicks).some((c) => c.phase === 'unknown' || c.phase === 'sending');
  }

  // The 2 s round: one /orders call, then the next while there is still a reason. It rests while
  // the tab is hidden or no sidebar is on screen (wake and mount start it again), and it re-prices
  // nothing: it only reads.
  private fast(): void {
    if (this.fastTimer != null) return;
    this.fastTimer = setTimeout(() => {
      this.fastTimer = null;
      if (this.mounted === 0 || !this.env.visible() || !this.wantsFast()) return;
      void this.loadOrders();   // its own end starts the next round, if one is wanted
    }, this.t.followEveryMs);
  }

  // Something was clicked: ask often for a minute.
  private touched(): void {
    this.touchedUntil = Date.now() + this.t.followMs;
    this.fast();
  }

  private setBusy(orderId: number, action: OrderAction | null): void {
    if (action == null) this.inFlight.delete(orderId); else this.inFlight.set(orderId, action);
    this.set({ busy: Object.fromEntries(this.inFlight) });
  }

  // Places the bracket for one alert: one /order call, never retried. An error answer leaves the
  // alert free for another click; no answer in time keeps it locked until /orders shows what
  // happened. A success keeps it locked while the order is working or has a fill, and so does
  // the bridge's own "this alert already has an order" (`duplicate_alert`); once /orders shows
  // that order ended with nothing filled, loadOrders releases the lock.
  //
  // Both of an alert's buttons come here — Buy, and the stop entry (`req.entry` "stop", the buy
  // that waits above the alert's price) — and share the one lock: a click on either while the
  // other's call is in flight, or after it placed an order that still counts, sends nothing. A
  // stop entry that IB expires unfilled has ended with nothing filled, so it frees the alert too.
  buy = (alertId: string, req: BridgeOrderRequest): void => {
    const tickerLock = `ticker:${req.ticker}`;
    if (!this.state.settings.enabled || this.locks.has(alertId) || this.locks.has(tickerLock)) return;
    this.locks.add(alertId);
    this.locks.add(tickerLock);
    const at = Date.now();
    this.setClick(alertId, { phase: 'sending', at, ticker: req.ticker, entry: req.entry ?? 'now' });
    void (async () => {
      try {
        const order = await twsBridge.order(this.conn(), req);
        this.setClick(alertId, { phase: 'sent', at, ticker: req.ticker, order });
        this.touched();
      } catch (err) {
        const f = toBridgeFailure(err);
        // No answer in time, or a 2xx answer that cannot be read: the bridge may have placed it.
        if (f.code === 'timeout' || (f.code === 'bad_answer' && f.status >= 200 && f.status < 300)) {
          this.setClick(alertId, {
            phase: 'unknown', at, ticker: req.ticker,
            text: `${f.message}. The order may still have gone out: asking the bridge for it. Check TWS.`,
          });
          this.touched();
        } else if (f.code === 'duplicate_alert') {
          // The bridge itself says this alert already has an order (placed from another tab, or
          // before a reload): its text is shown, the alert stays locked, and /orders brings the
          // earlier order onto the card.
          this.setClick(alertId, { phase: 'taken', at: Date.now(), ticker: req.ticker, text: f.message });
          void this.loadOrders();
        } else {
          this.locks.delete(alertId);
          this.setClick(alertId, { phase: 'error', at: Date.now(), ticker: req.ticker, text: f.message });
          if (f.status > 0) void this.loadOrders();   // an order TWS refused is in the bridge's list
        }
      } finally {
        this.locks.delete(tickerLock);
        void this.poll();
      }
    })();
  };

  // Cancels a buy that has not filled, or what has not filled of it (TWS cancels its exits with
  // it, or keeps them for the shares that did fill).
  cancel = (orderId: number, ticker: string): void => this.ask('cancel', orderId, ticker);

  // Moves a working buy up to the live ask + offset, and its exits with it: one click, one move.
  // The bridge reads the ask and holds the cap against the alert; the page sends the order's id.
  chase = (orderId: number, ticker: string): void => this.ask('chase', orderId, ticker);

  // Sells what the order still holds just under the live bid; while that sell is working, a
  // click moves it lower. One click, one sell or one move. A halt does not block it.
  sell = (orderId: number, ticker: string): void => this.ask('sell', orderId, ticker);

  // One call for one order, never retried and never repeated by the page: nothing here follows a
  // price. While it is in flight the order takes no other click. The outcome is read from
  // /orders (the line and its buttons follow from that); a refusal shows as the row's note, in
  // the bridge's words.
  private ask(action: OrderAction, orderId: number, ticker: string): void {
    if (!this.state.settings.enabled || this.inFlight.has(orderId)) return;
    this.setBusy(orderId, action);
    void (async () => {
      try {
        if (action === 'cancel') await twsBridge.cancel(this.conn(), orderId);
        else if (action === 'chase') await twsBridge.chase(this.conn(), orderId);
        else await twsBridge.sell(this.conn(), orderId);
      } catch (err) {
        const f = toBridgeFailure(err);
        const open = f.code === 'timeout' || (f.code === 'bad_answer' && f.status >= 200 && f.status < 300);
        this.note(ticker, open && action !== 'cancel'
          ? `${f.message}. The ${action === 'chase' ? 'move' : 'sell'} may still have gone out: the order's line shows what the bridge has. Check TWS.`
          : f.message);
      } finally {
        this.setBusy(orderId, null);
        void this.loadOrders();
        this.touched();
      }
    })();
  }

  // The bridge's off switch. Answers the error text, or null when it took.
  halt = async (halted: boolean): Promise<string | null> => {
    try {
      await twsBridge.halt(this.conn(), halted);
      return null;
    } catch (err) {
      return toBridgeFailure(err).message;
    } finally {
      void this.poll();
    }
  };

  // ------------------------------------------------------------- the automation (2026-11-28)

  // One /auto call. `refresh`: asked for by a switch (run after the call in flight, if there is
  // one); otherwise a call that comes while one is in flight is dropped (the next round asks).
  // After a 404 nothing is asked before autoRetryAt.
  private async loadAuto(refresh: boolean): Promise<void> {
    if (this.pollKey == null || !this.env.visible()) return;
    if (this.autoLoading) {
      if (refresh) this.autoAgain = true;
      return;
    }
    if (this.state.autoMissing && Date.now() < this.autoRetryAt) return;
    this.autoLoading = true;
    const epoch = this.epoch;
    const gen = this.autoGen;
    try {
      const auto = await bridgeGetAuto(this.conn());
      if (epoch !== this.epoch || gen !== this.autoGen) return;
      this.set({ auto, autoMissing: false, autoFailure: null });
      this.relinkIfNeeded(auto);
    } catch (err) {
      if (epoch !== this.epoch || gen !== this.autoGen) return;
      const f = toBridgeFailure(err);
      if (bridgeAutoMissing(f)) {
        // An older bridge: one line in the panel, and /auto again in 30 s at the soonest.
        this.autoRetryAt = Date.now() + this.t.autoMissingMs;
        this.autoMissingVersion = this.lastVersion;
        this.set({ auto: null, autoMissing: true, autoFailure: null });
      } else {
        this.set({ autoFailure: f.message });
      }
    } finally {
      this.autoLoading = false;
      if (this.autoAgain) {
        this.autoAgain = false;
        void this.loadAuto(false);
      } else {
        this.autoFast();
      }
    }
  }

  // Is there a reason to ask /auto every 2 s? It is on or watching, and its hour is open: that is
  // when it decides.
  private wantsAutoFast(): boolean {
    const a = this.state.auto;
    return a != null && a.mode !== 'off' && a.window.open;
  }

  // The 2 s round: one /auto call, then the next while there is still a reason. It rests while the
  // tab is hidden or no sidebar is on screen (the status poll and wake start it again).
  private autoFast(): void {
    if (this.autoTimer != null || !this.wantsAutoFast()) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (this.pollKey == null || !this.env.visible() || !this.wantsAutoFast()) return;
      void this.loadAuto(false);
    }, this.t.autoFastEveryMs);
  }

  // The bridge is on or watching with no link to the server's alerts, or with one the server
  // refused (an expired token): link it again, by itself, at most once a minute.
  private relinkIfNeeded(a: AutoStatus): void {
    if (a.mode === 'off' || this.state.autoBusy != null || this.linking != null) return;
    if (a.feed.paired && a.feed.state !== 'unauthorized') return;
    if (Date.now() - this.linkTriedAt < this.t.relinkEveryMs) return;
    void this.link().then((failed) => { if (failed == null) void this.loadAuto(true); });
  }

  // Links the bridge to the server's alert stream: a token from the server (the signed-in user's
  // own), handed straight to the bridge's /auto/feed with this page's origin. The token lives in
  // this function alone. Answers null when it took, or the line the panel shows.
  private link(): Promise<string | null> {
    if (this.linking != null) return this.linking;
    this.linkTriedAt = Date.now();
    const epoch = this.epoch;
    const conn = this.conn();
    const failed = (text: string): string => {
      if (epoch === this.epoch) this.set({ linkError: text });
      return text;
    };
    this.linking = (async (): Promise<string | null> => {
      let token: string;
      try {
        token = (await tvApi.feedToken()).token;
      } catch (err) {
        return failed(serverLinkFailure(err));
      }
      try {
        await bridgePairFeed(conn, { server: window.location.origin, token });
      } catch (err) {
        return failed(`The helper could not connect to the server's alerts: ${toBridgeFailure(err).message}`);
      }
      if (epoch === this.epoch) this.set({ linkError: null });
      return null;
    })().finally(() => { this.linking = null; });
    return this.linking;
  }

  // The operator picked a mode. Watch only and On need the server's alerts: when the bridge has
  // no link to them (or a refused one) the link comes first, and if it fails the mode stays as
  // the bridge has it and the panel says why. Then /auto takes the mode, and its answer is shown.
  setAutoMode = (mode: AutoMode): void => {
    if (!this.state.settings.enabled || this.pollKey == null || this.state.autoBusy != null) return;
    const epoch = this.epoch;
    this.autoGen += 1;   // an /auto answer from before the switch is dropped
    this.set({ autoBusy: mode, autoError: null, linkError: null });
    void (async () => {
      try {
        const a = this.state.auto;
        if (mode !== 'off' && (a == null || !a.feed.paired || a.feed.state === 'unauthorized')) {
          if ((await this.link()) != null) return;
        }
        const next = await bridgeSetAutoMode(this.conn(), mode);
        if (epoch !== this.epoch) return;
        this.autoGen += 1;
        this.set({ auto: next, autoMissing: false, autoFailure: null });
      } catch (err) {
        if (epoch === this.epoch) this.set({ autoError: toBridgeFailure(err).message });
      } finally {
        this.set({ autoBusy: null });
        void this.loadAuto(true);
      }
    })();
  };
}

// Why the server gave no token for the link, in one line. An older server has no such call and
// answers 404 `{ error: 'Not found' }`.
function serverLinkFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'Not found') return "The server cannot connect the helper to its alerts yet (it is an older version): nothing was changed.";
  if (err instanceof SyntaxError) return 'The server gave no readable answer about the alerts for the helper: nothing was changed.';
  if (err instanceof TypeError) return 'No answer from the server about the alerts for the helper: nothing was changed.';
  return `The server did not connect the helper to its alerts (${msg || 'no reason given'}): nothing was changed.`;
}

// The page's one controller.
export const twsBridgeController = new TwsBridgeController({
  load: loadSettings,
  save: saveSettings,
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
});
const controller = twsBridgeController;

// A Buy click's error stays on its card this long.
const BUY_ERROR_MS = 60_000;

// What the bridge adds to one setup card, worked out from the alert the card shows.
export interface BridgeCardAlert {
  ticker: string;
  ids: string[];          // the alert's id, and those of the copies merged into it
  at: number;             // ms
  price: number | null;
  // The setup is over — a BROKEN or HELD row, or a PULLBACK that already broke: no Buy button
  // (the TWS button stays).
  over?: boolean;
}
// One order on a card: its line (bridgeOrderView) and the buttons it has right now — what the
// order allows, cut down to what the bridge's state allows.
export interface BridgeOrderBlock extends BridgeOrderView {
  order_id: number;
  placed_at: string;
  // the call in flight for this order: its buttons take no click meanwhile
  busy: OrderAction | null;
}

export interface BridgeCard {
  // for a few seconds: why a click did nothing (the bridge refused a Cancel, a Chase or a Sell;
  // the page held a click back)
  note: string | null;
  // "Buy 100 @ 0.5858" / "Buy $400 ≈ 929 @ 0.4302" / "Buy LIVE …"; null = this card has no Buy button
  buyLabel: string | null;
  // The second button, beside Buy: the stop entry, a buy that waits above the alert's price.
  // "Buy 100 if ≥ 0.3744 (+5%)" / "Buy $400 if ≥ 0.3744 (+5%)" / "Buy LIVE …"; only beside a Buy
  // button, and only when the bridge has stop entries on (order.entryStopPct above 0).
  stopLabel: string | null;
  // which button's /order call is in flight ("now" = Buy, "stop" = the stop entry): both are
  // shown, disabled, and that one reads "sending…"; null = none
  sending: BridgeEntry | null;
  // the alert's own order, with its buttons
  order: BridgeOrderBlock | null;
  // that order ended with nothing filled, so the alert is free again: its line goes before the
  // Buy button ("cancelled · Buy 100 @ 0.4302"), so it is clear what happened
  orderEnded: boolean;
  // the bridge's answer to a Buy click it refused, or the note that no answer came
  error: string | null;
  // Other alerts' orders on this ticker that belong in view: every one that is still working or
  // holds shares (it keeps its line, its Cancel and its Sell here for as long as it does, also
  // after the card's row has moved on to a newer alert), and, beside a Buy button, the last one
  // that filled today.
  others: BridgeOrderBlock[];
  // anything for the card's third line?
  any: boolean;
}

export function bridgeCard(
  tws: Pick<TwsBridgeState, 'settings' | 'status' | 'orders' | 'clicks' | 'notes' | 'busy'> & { view: BridgeView },
  alert: BridgeCardAlert,
  now: number,
): BridgeCard {
  const note = tws.notes[alert.ticker] ?? null;
  // An order as the card shows it. A Chase needs what an order needs (but for the day's count); a
  // Sell needs only the bridge and TWS — not the halt switch, and not a fresh alert. On a live
  // account the Sell button says so, as the Buy button does.
  const block = (o: BridgeOrderRecord): BridgeOrderBlock => {
    const v = bridgeOrderView(o, tws.status?.order ?? null);
    return {
      ...v,
      order_id: o.order_id,
      placed_at: o.placed_at,
      chase: v.chase && tws.view.canChase,
      sell: v.sell != null && tws.view.canSell
        ? { ...v.sell, label: tws.view.liveAccount ? v.sell.label.replace(/^Sell/, 'Sell LIVE') : v.sell.label }
        : null,
      busy: tws.busy[o.order_id] ?? null,
    };
  };
  const click = alert.ids.map((id) => tws.clicks[id]).find((x) => x != null) ?? null;
  const sending = click?.phase === 'sending' ? click.entry : null;
  const sentOrder = click?.phase === 'sent' ? click.order : null;
  // An order this page has just placed that /orders does not list yet: the /order answer stands
  // in for it, and the alert is used.
  const fresh = sentOrder != null && !tws.orders.some((o) => o.order_id === sentOrder.order_id) ? sentOrder : null;
  // The alert's orders as the bridge lists them today, newest first (by the id of any of the
  // alert's merged copies) — all a reloaded page has, and all this page goes by once they are in.
  const recs = tws.orders
    .filter((o) => (o.asked.alert_id != null && alert.ids.includes(o.asked.alert_id)) || o.order_id === sentOrder?.order_id)
    .sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at) || b.order_id - a.order_id);
  // The one the card shows: an order that uses up the alert (working, or with a fill) if there
  // is one; else the latest that ended with nothing filled.
  const rec = fresh != null ? null : recs.find(bridgeOrderCounts) ?? recs[0] ?? null;
  const ended = rec != null && !bridgeOrderCounts(rec);
  // One working-or-filled order per alert. The alert is used while a click is in flight or its
  // outcome unknown, and while its order is working or has any fill. An order that ended with
  // nothing filled (cancelled here or in TWS, refused, never sent) frees it, and so does a click
  // the bridge answered with an error. The bridge's "this alert already has an order" counts
  // until /orders shows which order that is; then the order decides.
  const used = sending != null || click?.phase === 'unknown' || fresh != null
    || (rec != null ? !ended : click?.phase === 'taken');
  // The two buttons stand and go together: Buy, and beside it the stop entry when the bridge
  // offers one (both shown, disabled, while either's call is in flight).
  const orderSettings = tws.status?.order ?? null;   // the bridge's, from /status
  const price = typeof alert.price === 'number' && alert.price > 0 ? alert.price : null;
  const offered = orderSettings != null && price != null && tws.settings.buy && tws.view.canOrder && alert.over !== true
    && now - alert.at <= BRIDGE_ALERT_MAX_AGE_MS && (!used || sending != null);
  const buyWord = tws.view.live ? 'Buy LIVE' : 'Buy';
  const buyLabel = offered ? `${buyWord} ${bridgeBuyNumbers(orderSettings, price)}` : null;
  const stopNumbers = offered ? bridgeStopNumbers(orderSettings, price) : null;
  const stopLabel = stopNumbers != null ? `${buyWord} ${stopNumbers}` : null;
  // Other alerts' orders on this ticker. One that is working or holds shares is always in view,
  // with its buttons: it can be cancelled or sold here whatever alert the card's row shows now.
  // Beside a Buy button, with no order of this alert's own in the way, the last one that filled
  // today is shown too, so a second Buy is a choice and not a slip.
  const rest = tws.orders.filter((o) => o.ticker === alert.ticker && !recs.includes(o));
  const kept = rest.filter(bridgeOrderLive);
  const reminder = fresh == null && (rec == null || ended) && buyLabel != null && kept.length === 0
    ? rest.find((o) => o.filled_qty > 0)
    : undefined;
  const others = (reminder != null ? [reminder] : kept).map(block);
  // A refusal's text stays a minute. The bridge's "this alert already has an order" stays until
  // that order is on the card, so a card without a Buy button always says why.
  const error = click?.phase === 'unknown' ? click.text
    : click?.phase === 'taken' && (rec == null || now - click.at < BUY_ERROR_MS) ? click.text
      : click?.phase === 'error' && now - click.at < BUY_ERROR_MS ? click.text : null;
  // The alert's own order: the /order answer while /orders does not list it yet (its note with
  // it: why the price came from the alert), then the bridge's record.
  let order: BridgeOrderBlock | null = null;
  if (fresh != null) {
    order = {
      order_id: fresh.order_id, placed_at: new Date(click?.at ?? now).toISOString(),
      text: bridgeSentText(fresh), tone: 'working', error: null, note: fresh.note ?? null, loose: false,
      cancel: bridgeOrderCancellable(fresh) ? 'Cancel' : null, chase: false, sell: null,
      auto: false, watch: null,   // placed by a click on this page
      busy: tws.busy[fresh.order_id] ?? null,
    };
  } else if (rec != null && !(error != null && ended && rec.error != null)) {
    // (an order TWS refused at the click is left out while the click's own text says it)
    order = block(rec);
  }
  const any = buyLabel != null || order != null || error != null || others.length > 0 || note != null;
  return { note, buyLabel, stopLabel, sending, order, orderEnded: order != null && ended, error, others, any };
}

export interface TwsBridge extends TwsBridgeState {
  // enabled, with a token and a usable address: /status is polled
  active: boolean;
  // what the status line reads, and whether an order can be placed
  view: BridgeView;
  update: (patch: Partial<TwsBridgeSettings>) => void;
  buy: (alertId: string, req: BridgeOrderRequest) => void;
  cancel: (orderId: number, ticker: string) => void;
  chase: (orderId: number, ticker: string) => void;
  sell: (orderId: number, ticker: string) => void;
  halt: (halted: boolean) => Promise<string | null>;
  note: (ticker: string, text: string) => void;
  // the automation's mode: links it to the server's alerts first when it needs that
  setAutoMode: (mode: AutoMode) => void;
}

export function useTwsBridge(): TwsBridge {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    const unmount = controller.mount();
    const onVisible = () => { if (document.visibilityState === 'visible') controller.wake(); };
    const fromOtherTab = (e: StorageEvent) => { if (e.key === STORAGE_KEY) controller.reload(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', fromOtherTab);
    return () => {
      unmount();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', fromOtherTab);
    };
  }, []);

  const { settings, status, failure } = state;
  const view = useMemo(
    () => describeBridge({ url: settings.url, token: settings.token }, { status, failure }),
    [settings.url, settings.token, status, failure],
  );
  const active = settings.enabled && settings.token !== '' && bridgeOrigin(settings.url) != null;
  return {
    ...state, active, view,
    update: controller.update, buy: controller.buy, cancel: controller.cancel,
    chase: controller.chase, sell: controller.sell, halt: controller.halt, note: controller.note,
    setAutoMode: controller.setAutoMode,
  };
}
