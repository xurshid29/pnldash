import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  BRIDGE_ALERT_MAX_AGE_MS, BRIDGE_DEFAULT_URL, bridgeBuyNumbers, bridgeOrderCancellable, bridgeOrderCounts,
  bridgeOrderDone, bridgeOrderText, bridgeOrigin, bridgeSentText, describeBridge, toBridgeFailure, twsBridge,
  type BridgeConn, type BridgeFailure, type BridgeOrder, type BridgeOrderRecord, type BridgeOrderRequest,
  type BridgeStatus, type BridgeView,
} from '../api/twsBridge';

// The TWS bridge on this browser (2026-11-26): its settings, the bridge's status, and the two
// things a setup row can ask of it — show the ticker in TWS (/focus) and place the operator's
// bracket order (/order). Device-local on purpose: the bridge runs on the operator's own computer,
// so the switch, the address and the token live in this browser's localStorage and nowhere else.
// Off by default: another signed-in user sees one small "TWS" button and nothing more, and no
// call is made until the switch is on and a token is set.
//
// The work is in TwsBridgeController, a plain object outside React (one per page, so a remount of
// the sidebar loses nothing — above all not the one-click-one-order lock); useTwsBridge reads it.

export interface TwsBridgeSettings {
  enabled: boolean;   // the feature, on this browser
  url: string;        // the bridge's address: http://127.0.0.1:<port>
  token: string;      // the secret from tools/tws-bridge/config.json
  follow: boolean;    // selecting a setup row also shows it in TWS
  buy: boolean;       // show the Buy button
}

const STORAGE_KEY = 'twsBridge.settings';
export const TWS_BRIDGE_DEFAULTS: TwsBridgeSettings = { enabled: false, url: BRIDGE_DEFAULT_URL, token: '', follow: true, buy: true };

function clean(v: Partial<Record<keyof TwsBridgeSettings, unknown>>): TwsBridgeSettings {
  return {
    enabled: v.enabled === true,
    url: typeof v.url === 'string' && v.url.trim() !== '' ? v.url.trim() : TWS_BRIDGE_DEFAULTS.url,
    token: typeof v.token === 'string' ? v.token.trim() : '',
    follow: v.follow !== false,
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
  followEveryMs: number;     // /orders after a click …
  followMs: number;          // … for this long
  noteOkMs: number;          // "TWS → RAYA" stays this long
  noteErrMs: number;         // an error a little longer: it has to be read
  // A Buy click that got no answer in time: after this long, an /orders answer without an order
  // for the alert means none was placed (the bridge's own waits are a few seconds).
  unknownSettleMs: number;
}
const TIMING: BridgeTiming = {
  statusEveryMs: 5_000, followEveryMs: 2_000, followMs: 60_000, noteOkMs: 4_000, noteErrMs: 8_000, unknownSettleMs: 20_000,
};

// What a Buy click on one alert came to. Keyed by the alert's id.
export type BuyClick =
  | { phase: 'sending'; at: number; ticker: string }
  | { phase: 'sent'; at: number; ticker: string; order: BridgeOrder }
  // no answer in time: the order may have gone out; /orders is asked until it is known
  | { phase: 'unknown'; at: number; ticker: string; text: string }
  // the bridge refused the click because this alert already has an order (`duplicate_alert`):
  // its text is shown, and the alert stays used
  | { phase: 'taken'; at: number; ticker: string; text: string }
  | { phase: 'error'; at: number; ticker: string; text: string };

export interface RowNote {
  text: string;
  ok: boolean;
}

export interface TwsBridgeState {
  settings: TwsBridgeSettings;
  // the last /status answer, or the failure in its place; both null before the first answer
  status: BridgeStatus | null;
  failure: BridgeFailure | null;
  // today's orders as the bridge lists them, newest first
  orders: BridgeOrderRecord[];
  clicks: Record<string, BuyClick>;
  // by ticker, for a few seconds: "TWS → RAYA" or an error
  notes: Record<string, RowNote>;
  focusing: string | null;
  cancelling: number[];
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
  private ordersWorking = false;
  private ordersSig = '';
  private followUntil = 0;
  private followTimer: Timer | null = null;
  private readonly noteTimers = new Map<string, Timer>();
  private focusBusy = false;
  private focusNext: string | null = null;
  // One click = one order. An alert's id is in here while its /order call is in flight and from
  // then on once it succeeded (or while its outcome is unknown); a ticker's ("ticker:RAYA") while
  // any /order call for it is in flight.
  private readonly locks = new Set<string>();
  private readonly cancels = new Set<number>();

  constructor(env: BridgeEnv) {
    this.env = env;
    this.t = { ...TIMING, ...env.timing };
    this.state = {
      settings: env.load(), status: null, failure: null, orders: [], clicks: {}, notes: {}, focusing: null, cancelling: [],
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

  // The tab is on screen again: ask at once.
  wake = (): void => {
    void this.poll();
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
    this.ordersSig = '';
    if (this.state.status != null || this.state.failure != null) this.set({ status: null, failure: null });
    if (key == null) return;
    this.pollTimer = setInterval(() => { void this.poll(); }, this.t.statusEveryMs);
    void this.poll();
  }

  // One /status call; nothing while the tab is hidden. The orders are re-read when the day's
  // counts change, while a buy is working and while a click's outcome is not known.
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
      if (sig !== this.ordersSig || this.ordersWorking || this.hasUnknown()) {
        this.ordersSig = sig;
        void this.loadOrders();
      }
    } catch (err) {
      if (epoch === this.epoch) this.set({ status: null, failure: toBridgeFailure(err) });
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

  note = (ticker: string, text: string, ok: boolean): void => {
    const old = this.noteTimers.get(ticker);
    if (old != null) clearTimeout(old);
    this.set({ notes: { ...this.state.notes, [ticker]: { text, ok } } });
    this.noteTimers.set(ticker, setTimeout(() => {
      this.noteTimers.delete(ticker);
      const notes = { ...this.state.notes };
      delete notes[ticker];
      this.set({ notes });
    }, ok ? this.t.noteOkMs : this.t.noteErrMs));
  };

  // Today's orders. Also settles a Buy click that got no answer: its order is in the list (it
  // went out after all), or it is not and enough time has passed (it never did).
  private async loadOrders(): Promise<void> {
    const s = this.state.settings;
    if (this.ordersLoading || !s.enabled || s.token === '') return;
    this.ordersLoading = true;
    try {
      const orders = await twsBridge.orders(this.conn());
      this.ordersWorking = orders.some((o) => !bridgeOrderDone(o.status));
      this.set({ orders });
      for (const [alertId, c] of Object.entries(this.state.clicks)) {
        if (c.phase !== 'unknown') continue;
        const rec = orders.find((o) => o.asked.alert_id === alertId
          || (o.ticker === c.ticker && Date.parse(o.placed_at) >= c.at - 2_000));
        if (rec) {
          this.setClick(alertId, {
            phase: 'sent', at: c.at, ticker: c.ticker,
            order: {
              order_id: rec.order_id, ticker: rec.ticker, qty: rec.sent.qty, limit: rec.sent.limit,
              take_profit: rec.sent.take_profit, stop: rec.sent.stop, stop_limit: rec.sent.stop_limit, status: rec.status,
            },
          });
        } else if (Date.now() - c.at > this.t.unknownSettleMs) {
          this.locks.delete(alertId);
          this.setClick(alertId, {
            phase: 'error', at: Date.now(), ticker: c.ticker,
            text: 'The bridge gave no answer and lists no order for this alert: nothing was sent.',
          });
        }
      }
    } catch {
      // the status line says what is wrong; the next poll asks again
    } finally {
      this.ordersLoading = false;
    }
  }

  // After a click: /orders every 2 s for up to 60 s, ending early once no buy is still working
  // and no click is waiting for its answer.
  private follow(): void {
    this.followUntil = Date.now() + this.t.followMs;
    if (this.followTimer != null) return;
    const step = (): void => {
      this.followTimer = null;
      if (Date.now() > this.followUntil) return;
      void this.loadOrders().then(() => {
        if (this.followTimer != null || Date.now() > this.followUntil) return;
        const waiting = this.ordersWorking
          || Object.values(this.state.clicks).some((c) => c.phase === 'unknown' || c.phase === 'sending');
        if (waiting) this.followTimer = setTimeout(step, this.t.followEveryMs);
      });
    };
    this.followTimer = setTimeout(step, this.t.followEveryMs);
  }

  // Shows a ticker in TWS. One /focus at a time, and the last ticker asked for wins: a row
  // clicked while a call is in flight waits for it (replacing any other that was waiting), so TWS
  // ends on the last click. Not awaited by the caller: the outcome arrives as the row's note.
  focus = (ticker: string): void => {
    if (!this.state.settings.enabled) return;
    if (this.focusBusy) { this.focusNext = ticker; return; }
    this.focusBusy = true;
    void (async () => {
      let t: string | null = ticker;
      while (t != null) {
        this.set({ focusing: t });
        try {
          const d = await twsBridge.focus(this.conn(), t);
          this.note(t, `TWS → ${d.ticker}`, true);
        } catch (err) {
          this.note(t, toBridgeFailure(err).message, false);
        }
        t = this.focusNext;
        this.focusNext = null;
      }
      this.focusBusy = false;
      this.set({ focusing: null });
    })();
  };

  // Places the bracket for one alert: one /order call, never retried. An error answer leaves the
  // alert free for another click; no answer in time keeps it locked until /orders shows what
  // happened; a success keeps it locked for good, and so does the bridge's own "this alert
  // already has an order" (`duplicate_alert`).
  buy = (alertId: string, req: BridgeOrderRequest): void => {
    const tickerLock = `ticker:${req.ticker}`;
    if (!this.state.settings.enabled || this.locks.has(alertId) || this.locks.has(tickerLock)) return;
    this.locks.add(alertId);
    this.locks.add(tickerLock);
    const at = Date.now();
    this.setClick(alertId, { phase: 'sending', at, ticker: req.ticker });
    void (async () => {
      try {
        const order = await twsBridge.order(this.conn(), req);
        this.setClick(alertId, { phase: 'sent', at, ticker: req.ticker, order });
        this.follow();
      } catch (err) {
        const f = toBridgeFailure(err);
        // No answer in time, or a 2xx answer that cannot be read: the bridge may have placed it.
        if (f.code === 'timeout' || (f.code === 'bad_answer' && f.status >= 200 && f.status < 300)) {
          this.setClick(alertId, {
            phase: 'unknown', at, ticker: req.ticker,
            text: `${f.message}. The order may still have gone out: asking the bridge for it. Check TWS.`,
          });
          this.follow();
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

  // Cancels a buy that has not filled (TWS cancels its exits with it). An error shows as the
  // row's note; the order's line follows from /orders.
  cancel = (orderId: number, ticker: string): void => {
    if (this.cancels.has(orderId)) return;
    this.cancels.add(orderId);
    this.set({ cancelling: [...this.cancels] });
    void (async () => {
      try {
        await twsBridge.cancel(this.conn(), orderId);
      } catch (err) {
        this.note(ticker, toBridgeFailure(err).message, false);
      } finally {
        this.cancels.delete(orderId);
        this.set({ cancelling: [...this.cancels] });
        void this.loadOrders();
        this.follow();
      }
    })();
  };

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
export interface BridgeCard {
  // for a few seconds: "TWS → RAYA" (ok) or an error
  note: RowNote | null;
  // "Buy 100 @ 0.5858" / "Buy LIVE 100 @ 0.5858"; null = this card has no Buy button
  buyLabel: string | null;
  // the click's /order call is in flight: the button is shown, disabled
  sending: boolean;
  // the alert's order: "sent: …", "filled …", "cancelled", TWS's own message
  orderText: string | null;
  orderTone: 'working' | 'filled' | 'done' | 'error';
  // the buy can still be cancelled: its order id
  cancelId: number | null;
  // the bridge's answer to a Buy click it refused, or the note that no answer came
  error: string | null;
  // another alert's buy on this ticker: still working, or (beside a Buy button) filled today
  other: BridgeOrderRecord | null;
  // anything for the card's third line?
  any: boolean;
}

export function bridgeCard(
  tws: Pick<TwsBridgeState, 'settings' | 'status' | 'orders' | 'clicks' | 'notes'> & { view: BridgeView },
  alert: BridgeCardAlert,
  now: number,
): BridgeCard {
  const note = tws.notes[alert.ticker] ?? null;
  // This alert's order as the bridge lists it today (by the id of any of the alert's merged
  // copies), so a reloaded page knows the alert was bought; and the click made on this page.
  const rec = tws.orders.find((o) => o.asked.alert_id != null && alert.ids.includes(o.asked.alert_id)) ?? null;
  const click = alert.ids.map((id) => tws.clicks[id]).find((x) => x != null) ?? null;
  const sending = click?.phase === 'sending';
  // One order per alert: bought once (or its click still unanswered), the button is gone. An
  // order TWS refused does not count, and neither does a click the bridge answered with an error
  // — except its "this alert already has an order", which does.
  const used = (rec != null && bridgeOrderCounts(rec)) || (click != null && click.phase !== 'error');
  const buyLabel = tws.settings.buy && tws.view.canOrder && tws.status != null && alert.over !== true
    && typeof alert.price === 'number' && alert.price > 0
    && now - alert.at <= BRIDGE_ALERT_MAX_AGE_MS && (!used || sending)
    ? `${tws.view.live ? 'Buy LIVE' : 'Buy'} ${bridgeBuyNumbers(tws.status.order, alert.price)}`
    : null;
  // Another alert's buy on this ticker, so a second Buy is a choice and not a slip: one that is
  // still working (always shown: it can be cancelled here), or, beside a Buy button, the last one
  // that filled today.
  const other = rec != null ? null
    : tws.orders.find((o) => o.ticker === alert.ticker && !bridgeOrderDone(o.status))
      ?? (buyLabel != null ? tws.orders.find((o) => o.ticker === alert.ticker && o.filled_qty > 0) : undefined)
      ?? null;
  // A refusal's text stays a minute. The bridge's "this alert already has an order" stays until
  // that order is on the card, so a card without a Buy button always says why.
  const error = click?.phase === 'unknown' ? click.text
    : click?.phase === 'taken' && (rec == null || now - click.at < BUY_ERROR_MS) ? click.text
      : click?.phase === 'error' && now - click.at < BUY_ERROR_MS ? click.text : null;
  const orderText = rec != null
    ? (error != null && !bridgeOrderCounts(rec) ? null : bridgeOrderText(rec))   // a refused order: the click's error says it already
    : click?.phase === 'sent' ? bridgeSentText(click.order) : null;
  const orderTone = rec == null ? 'working'
    : rec.error ? 'error' : rec.status === 'Filled' ? 'filled' : bridgeOrderDone(rec.status) ? 'done' : 'working';
  const cancelId = rec != null
    ? (bridgeOrderCancellable(rec) ? rec.order_id : null)
    : click?.phase === 'sent' && bridgeOrderCancellable(click.order) ? click.order.order_id : null;
  const any = buyLabel != null || orderText != null || error != null || other != null || (note != null && !note.ok);
  return { note, buyLabel, sending, orderText, orderTone, cancelId, error, other, any };
}

export interface TwsBridge extends TwsBridgeState {
  // enabled, with a token and a usable address: /status is polled
  active: boolean;
  // what the status line reads, and whether a focus / an order can work
  view: BridgeView;
  update: (patch: Partial<TwsBridgeSettings>) => void;
  focus: (ticker: string) => void;
  buy: (alertId: string, req: BridgeOrderRequest) => void;
  cancel: (orderId: number, ticker: string) => void;
  halt: (halted: boolean) => Promise<string | null>;
  note: (ticker: string, text: string, ok: boolean) => void;
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
    update: controller.update, focus: controller.focus, buy: controller.buy,
    cancel: controller.cancel, halt: controller.halt, note: controller.note,
  };
}
