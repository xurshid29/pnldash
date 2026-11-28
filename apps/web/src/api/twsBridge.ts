// Client for the TWS bridge (tools/tws-bridge, 2026-11-26): a small program on the operator's own
// computer, next to TWS. The page calls it at http://127.0.0.1:8765 to place the operator's
// bracket order (/order), to follow it (/orders), to cancel it (/cancel), to move a buy that has
// not filled up to the ask (/chase) and to get out of what an order bought (/sell). Every one of
// them is a click: nothing here, and nothing in the bridge, re-prices by itself. Nothing goes
// through the pnldash API, and the token is sent to the bridge alone: as a header, never in a
// URL, never logged, and only to a loopback address (bridgeOrigin).
//
// The bridge also has /focus (make TWS's linked windows show a ticker). The page used it for a
// per-row "TWS" button and a row click that TWS followed; both were removed on 2026-11-27 at the
// operator's request, and this client's focus() with them.
//
// 2026-11-28, the automation: the bridge itself buys every strong POP in one hour of the day
// with a waiting buy and sells by itself (its /auto). The page only reads it, switches its mode
// (off / watch only / on) and links it to the server's alert stream (/auto/feed: the server's
// address and a short-lived token the server gives the signed-in user). That token goes from
// the server's answer straight into the one /auto/feed call: never stored, logged or shown.

export const BRIDGE_DEFAULT_URL = 'http://127.0.0.1:8765';

// The bridge refuses an alert older than this (its ALERT_MAX_AGE_MS).
export const BRIDGE_ALERT_MAX_AGE_MS = 10 * 60_000;

export interface BridgeConn {
  url: string;
  token: string;
}

export interface BridgeOrderSettings {
  qty: number;
  priceFrom: 'alert' | 'ask';
  limitOffsetPct: number;
  maxChasePct: number;
  takeProfitPct: number;
  stopPct: number;
  stopLimitOffsetPct: number;
  useAlertStop: boolean;
  outsideRth: boolean;
  // Since the bridge's chase / sell / dollar-sizing version (2026-11-27); an older bridge sends
  // none of them, and the page then shows no Chase and sizes in shares.
  maxChases?: number;                 // most chases of one buy, and most later moves of one sell; 0 = no Chase
  sellOffsetPct?: number;             // a sell's limit = the live bid − this %
  amountUsd?: number;                 // dollars per buy; 0 = sized in shares (`qty`)
  askFallback?: 'alert' | 'none';     // with priceFrom "ask": what a buy does when TWS gives no live ask
  // Since the bridge's stop-entry version (2026-11-27); an older bridge sends none of them, and the
  // page then shows no second button.
  entryStopPct?: number;              // a stop entry's trigger = the alert's price + this %; 0 = stop entries off
  entryStopLimitPct?: number;         // its limit = the trigger + this %: the most it pays once triggered
  entryValidSec?: number;             // IB cancels it after this many seconds if nothing has filled
}

// How a buy enters (2026-11-27, the operator after the first live morning: "if price's intention
// is going up, we will catch it, if not, we just don't buy it"):
//   now  — the limit buy at the alert's price (or the ask) + limitOffsetPct, as before;
//   stop — a stop-limit buy that waits above the alert's price (+ entryStopPct) and fills only if
//          the price gets there; IB cancels it by itself after entryValidSec.
export type BridgeEntry = 'now' | 'stop';

// How an order's quantity was arrived at: so many dollars' worth, or a number of shares.
export interface BridgeSizing {
  mode: 'usd' | 'shares';
  amount_usd?: number;
}

export interface BridgeLimits {
  maxShares: number;
  maxNotionalUsd: number;
  maxOrdersPerDay: number;
  duplicateWindowSec: number;
}

export interface BridgeStatus {
  version: string;
  // `offline`: TWS is connected to the bridge but has lost IB's servers, so an order would wait
  // in TWS. Optional: an older bridge does not send it.
  tws: { connected: boolean; port: number; paper: boolean; accounts: string[]; offline?: boolean };
  enabled: boolean;
  halted: boolean;
  paper_only: boolean;
  order: BridgeOrderSettings;
  limits: BridgeLimits;
  today: { orders: number; filled: number };
}

// The body of /preview and /order. The bridge answers 400 to an unknown field, so only these.
export interface BridgeOrderRequest {
  ticker: string;
  alert_price: number;
  alert_stop?: number;
  qty?: number;
  stage?: string;
  alert_at?: string | number;   // ISO text or epoch milliseconds
  alert_id?: string | number;
  // Sent for a stop entry only; left out, the bridge places a buy now (an older bridge would
  // answer 400 to the field).
  entry?: BridgeEntry;
}

export interface BridgePreview {
  ticker: string;
  entry?: BridgeEntry;
  qty: number;
  sizing?: BridgeSizing;
  limit: number;
  trigger?: number | null;
  good_until?: string | null;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  notional: number;
  price_from?: 'alert' | 'ask';
  note?: string | null;
  checks: Array<{ name: string; detail: string }>;
}

export interface BridgeOrder {
  order_id: number;
  ticker: string;
  // asOrder fills these three in for an older bridge (a buy now).
  entry: BridgeEntry;
  qty: number;
  sizing?: BridgeSizing;
  limit: number;                 // a stop entry's: the most it pays once triggered
  trigger: number | null;        // a stop entry's trigger; null for a buy now
  good_until: string | null;     // ISO: when IB cancels a stop entry that has not filled; null for a buy now
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  // What the limit was worked out from; "alert" under priceFrom "ask" means the fallback was
  // used, and `note` then says why ("no live ask from TWS in 800 ms: priced from the alert").
  price_from?: 'alert' | 'ask';
  note?: string | null;
  status: string;
}

// The answer of /chase: the bracket's prices after the move.
export interface BridgeChase {
  order_id: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  chases: number;
  status: string;
}

// The answer of /sell: the order doing the selling — the bracket's take-profit leg moved down to
// the bid, or a sell order of its own when the exits are gone.
export interface BridgeSell {
  order_id: number;
  qty: number;
  limit: number;
  status: string;
  via: 'take_profit' | 'new_order';
}

export interface BridgeLeg {
  order_id: number;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
}

// The last /sell of an order, as /orders shows it. `status`, `filled_qty` and `avg_fill_price`
// are those of the order doing the selling.
export interface BridgeExit {
  via: 'take_profit' | 'new_order';
  order_id: number;
  qty: number;                     // the shares this sell is for
  limit: number;                   // its limit now …
  first_limit: number;             // … and at the first click
  bid: number;                     // the bid read at the last click
  reprices: number;                // how many later clicks moved it down
  sent_at: string;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
  exit_pct: number | null;         // the average sell against the buy's average fill, %: negative = sold lower
}

// One bracket as GET /orders lists it; `order_id` is the buy's. The fields marked optional came
// with the bridge's chase / sell version: asOrders fills them in (0, null) for an older bridge.
export interface BridgeOrderRecord {
  order_id: number;
  ticker: string;
  placed_at: string;
  asked: {
    alert_price: number;
    alert_stop: number | null;
    qty: number | null;
    stage: string | null;
    alert_at: string | null;
    alert_id: string | null;
  };
  sizing?: BridgeSizing;
  entry?: BridgeEntry;             // "now" or "stop" (a stop entry)
  // The prices are the current ones (a chase, a sell through the take-profit leg and a change
  // made by hand in TWS move them); `first_limit` is what the buy was placed with.
  sent: {
    qty: number;
    limit: number;
    trigger?: number | null;       // a stop entry's trigger (a trigger moved in TWS is followed); null for a buy now
    good_until?: string | null;    // ISO: when IB cancels a stop entry that has not filled; null for a buy now
    take_profit: number | null;
    stop: number | null;
    stop_limit: number | null;
    first_limit?: number;
  };
  chases?: number;                 // how many /chase clicks moved the buy
  status: string;                  // the buy's, in TWS's words (PendingSubmit, Submitted, Filled, Cancelled, …)
  filled_qty: number;
  avg_fill_price: number | null;
  slip_pct: number | null;         // the average fill against the alert's price, %: positive = paid more
  held_qty?: number;               // bought by this order and not sold yet: what /sell would sell
  legs: { take_profit: BridgeLeg | null; stop: BridgeLeg | null };
  exit?: BridgeExit | null;        // the last /sell; null until Sell is clicked
  // An exit leg is still working on an order that holds nothing; the bridge cancels it itself.
  loose_exit?: boolean;
  // The last message from TWS that stopped the order or a leg, or refused a change to one. It
  // can be set on an order that is still working (a refused chase or sell move).
  error: string | null;
  // The last warning or notice about it (at first: why the price came from the alert). A stop
  // entry that IB cancelled at its time with nothing filled: "expired unfilled at HH:MM:SS New York".
  note: string | null;
  // Since the automation (2026-11-28); cleanRecord fills both in for an older bridge ("click", null).
  // Who placed it: a click on a card, or the bridge's automation by itself.
  source?: 'click' | 'auto';
  // The automation's exit watch on one of its own orders: it has seen the take-profit crossed
  // without a fill, or the stop due, and is selling at the bid. Null otherwise.
  watch?: BridgeExitWatch | null;
}

export interface BridgeExitWatch {
  state: 'tp_crossed' | 'stop_due';
  since: string;                   // ISO
  sells: number;                   // sells it has sent for it
  last_error: string | null;       // TWS's or the bridge's last word against one of them
}

// ---------------------------------------------------------------- the automation (2026-11-28)

// watch = a dry run: it decides and logs, and places nothing.
export type AutoMode = 'off' | 'watch' | 'on';

// Why it would place no order right now (null = it would place the next strong POP).
export type AutoBlocked =
  | 'off' | 'watch' | 'disabled' | 'halted' | 'tws_down' | 'tws_offline' | 'not_paper'
  | 'no_feed' | 'outside_hours' | 'day_full' | 'no_slot';

export type AutoFeedState = 'off' | 'connecting' | 'connected' | 'retrying' | 'unauthorized';

export interface AutoRule {
  stage: 'pop';
  strong_only: boolean;
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
  // An alert under this price is not bought (0 = no floor). Missing on a bridge from before it.
  min_price?: number;
  // The exit rule since 2026-11-28 (missing on a bridge from before it: the take-profit sells
  // everything and the stop stays where it was put): the part of the position the take-profit
  // sells (0.5 = half), the gain at which the stop goes to the entry (0 = never), and how far
  // under the high the stop of the rest trails once the take-profit has sold (0 = no trailing).
  take_profit_portion?: number;
  stop_to_entry_at_pct?: number;
  trail_pct?: number;
  paper_only: boolean;
  exit_watch: { tp_grace_ms: number; stop_grace_ms: number; resell_ms: number };
}

export interface AutoStatus {
  mode: AutoMode;
  blocked: AutoBlocked | null;
  blocked_text: string | null;     // the same in plain words, from the bridge: shown as is
  // "04:00", "05:00" in New York; start_at / end_at are today's instants (ISO), what the page shows
  window: { start: string; end: string; tz: 'America/New_York'; start_at: string; end_at: string; open: boolean };
  rule: AutoRule;
  feed: {
    paired: boolean;
    server: string | null;
    state: AutoFeedState;
    connected_at: string | null;
    last_event_at: string | null;
    error: string | null;
  };
  today: { date: string; strong_pops: number; weak_pops: number; placed: number; trades: number; waiting: number; held: number; slots_free: number };
  decisions: AutoDecision[];       // today's, newest first, at most 100
}

export type AutoAction = 'placed' | 'would_place' | 'skipped' | 'failed';

export interface AutoDecision {
  at: string;                      // ISO, when the bridge decided
  alert_id: string;
  alert_at: string;
  ticker: string;
  price: number | null;
  vol_x: number | null;
  rvol1: number | null;
  mode: AutoMode;
  action: AutoAction;
  reason: string;                  // a code
  text: string;                    // plain words from the bridge: shown as is
  order_id: number | null;
  plan: { trigger: number; limit: number; qty: number; take_profit: number | null; stop: number | null; good_until: string | null } | null;
}

// Every failure in one shape. `status` is the HTTP status, 0 when the bridge gave no answer;
// `code` is the bridge's slug, or one of ours:
//   unreachable — no answer at all: the bridge is not running, or the browser blocked the call
//   timeout     — no answer in time (after /order the order may still have gone out)
//   bad_url / no_token / bad_token_text — the settings cannot be used, nothing was sent
//   bad_answer  — an answer that is not the bridge's JSON, or not of the shape the page prints from
export class TwsBridgeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'TwsBridgeError';
    this.code = code;
    this.status = status;
  }
}

export interface BridgeFailure {
  message: string;
  code: string;
  status: number;
}

export function toBridgeFailure(err: unknown): BridgeFailure {
  if (err instanceof TwsBridgeError) return { message: err.message, code: err.code, status: err.status };
  return { message: err instanceof Error ? err.message : 'the call to the TWS bridge failed', code: 'unreachable', status: 0 };
}

// The bridge's address as the page may call it: plain http on this computer, nothing else. A URL
// that points anywhere else is refused here, so the token cannot be sent off this machine by a
// mistyped setting. Path, query and user info are dropped.
export function bridgeOrigin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' || u.username !== '' || u.password !== '') return null;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return null;
    return u.origin;
  } catch {
    return null;
  }
}

// A header value the browser will send: printable ASCII, no spaces (the bridge's token is 64 hex
// characters).
export function tokenSendable(token: string): boolean {
  return /^[\x21-\x7e]+$/.test(token);
}

export function tokenLooksRight(token: string): boolean {
  return /^[0-9a-f]{64}$/i.test(token);
}

const SHORT_MS = 2500;   // status, preview, orders, cancel, halt
const ORDER_MS = 6000;   // /order: the bridge answers within about a second, more when TWS is slow
// /chase reads the ask (0.8 s at most) and waits up to a second for TWS's word on the change.
const CHASE_MS = 6000;
// /sell reads the bid and the account's position, may wait for a cancel to be confirmed first
// (1.5 s) and then for TWS's word: several seconds when everything is slow.
const SELL_MS = 8000;

async function call<T>(conn: BridgeConn, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<T> {
  const origin = bridgeOrigin(conn.url);
  if (origin == null) {
    throw new TwsBridgeError('The bridge URL must be http://127.0.0.1:<port> (a program on this computer)', 'bad_url', 0);
  }
  if (conn.token === '') throw new TwsBridgeError('No token is set for the TWS bridge', 'no_token', 0);
  if (!tokenSendable(conn.token)) {
    throw new TwsBridgeError('The token has characters that cannot be sent (it is 64 characters, 0-9 and a-f)', 'bad_token_text', 0);
  }

  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  let status = 0;
  let text = '';
  try {
    const headers: Record<string, string> = { 'X-Bridge-Token': conn.token };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',   // the bridge never redirects; whatever does would carry the token along
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw timedOut
      ? new TwsBridgeError(`No answer from the TWS bridge within ${timeoutMs / 1000} s`, 'timeout', 0)
      : new TwsBridgeError('TWS bridge not running, or the browser blocked the call to it', 'unreachable', 0);
  } finally {
    clearTimeout(timer);
  }

  let json: unknown = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = null; }
  const obj = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null;
  if (status >= 200 && status < 300 && obj != null && 'data' in obj) return obj.data as T;
  if (obj != null && typeof obj.error === 'string') {
    throw new TwsBridgeError(obj.error, typeof obj.code === 'string' ? obj.code : 'error', status);
  }
  throw new TwsBridgeError(`Port ${new URL(origin).port || '80'} answered ${status}, but not as the TWS bridge does`, 'bad_answer', status);
}

// The answers the page prints from are checked for their shape first: an answer of another shape
// (another program on that port, another version of the bridge) becomes a `bad_answer` failure
// here, and never a crash in the sidebar.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): boolean => v == null || isNum(v);
function notTheBridge(path: string): TwsBridgeError {
  return new TwsBridgeError(`The answer to ${path} is not the TWS bridge's (another program on that port, or another version)`, 'bad_answer', 200);
}

function asStatus(d: unknown): BridgeStatus {
  if (isObj(d) && isObj(d.tws) && typeof d.tws.connected === 'boolean' && typeof d.tws.paper === 'boolean' && Array.isArray(d.tws.accounts)
    && typeof d.enabled === 'boolean' && typeof d.halted === 'boolean' && typeof d.paper_only === 'boolean'
    && isObj(d.order) && isNum(d.order.qty) && isNum(d.order.limitOffsetPct) && isNum(d.order.stopPct) && isNum(d.order.takeProfitPct)
    && isObj(d.limits) && isNum(d.limits.maxOrdersPerDay) && isNum(d.limits.maxNotionalUsd)
    && isObj(d.today) && isNum(d.today.orders) && isNum(d.today.filled)) return d as unknown as BridgeStatus;
  throw notTheBridge('/status');
}

// The stop-entry fields are filled in, so the card can read them: an older bridge (or one of the
// wrong kind) is a buy now.
function asOrder(d: unknown): BridgeOrder {
  if (isObj(d) && isNum(d.order_id) && typeof d.ticker === 'string' && isNum(d.qty) && isNum(d.limit)
    && numOrNull(d.take_profit) && numOrNull(d.stop) && typeof d.status === 'string') {
    return {
      ...(d as unknown as BridgeOrder),
      entry: d.entry === 'stop' ? 'stop' : 'now',
      trigger: isNum(d.trigger) ? d.trigger : null,
      good_until: typeof d.good_until === 'string' ? d.good_until : null,
    };
  }
  throw notTheBridge('/order');
}

function isRecord(o: unknown): o is BridgeOrderRecord {
  return isObj(o) && isNum(o.order_id) && typeof o.ticker === 'string' && typeof o.placed_at === 'string' && typeof o.status === 'string'
    && isObj(o.asked) && isObj(o.sent) && isNum(o.sent.qty) && isNum(o.sent.limit) && numOrNull(o.sent.take_profit) && numOrNull(o.sent.stop)
    && isNum(o.filled_qty) && numOrNull(o.avg_fill_price) && numOrNull(o.slip_pct) && (o.error == null || typeof o.error === 'string');
}
function isLeg(l: unknown): l is BridgeLeg {
  return isObj(l) && isNum(l.order_id) && typeof l.status === 'string' && isNum(l.filled_qty) && numOrNull(l.avg_fill_price);
}
function isExit(e: unknown): e is BridgeExit {
  return isObj(e) && (e.via === 'take_profit' || e.via === 'new_order') && isNum(e.order_id) && isNum(e.qty) && isNum(e.limit)
    && typeof e.status === 'string' && isNum(e.filled_qty) && numOrNull(e.avg_fill_price) && numOrNull(e.exit_pct);
}
// A record with everything the card reads in place: what an older bridge does not send (and
// anything of the wrong kind) becomes "none" — no chases, nothing known to be held, no sell.
function cleanRecord(o: BridgeOrderRecord): BridgeOrderRecord {
  const raw = o as unknown as Obj;
  const legs = isObj(raw.legs) ? raw.legs : {};
  const exit = isExit(raw.exit)
    ? { ...raw.exit, bid: isNum(raw.exit.bid) ? raw.exit.bid : raw.exit.limit, first_limit: isNum(raw.exit.first_limit) ? raw.exit.first_limit : raw.exit.limit, reprices: isNum(raw.exit.reprices) ? raw.exit.reprices : 0 }
    : null;
  return {
    ...o,
    entry: raw.entry === 'stop' ? 'stop' : 'now',
    sent: {
      ...o.sent,
      first_limit: isNum(o.sent.first_limit) ? o.sent.first_limit : o.sent.limit,
      trigger: isNum(o.sent.trigger) ? o.sent.trigger : null,
      good_until: typeof o.sent.good_until === 'string' ? o.sent.good_until : null,
    },
    chases: isNum(raw.chases) ? raw.chases : 0,
    held_qty: isNum(raw.held_qty) ? raw.held_qty : undefined,
    legs: { take_profit: isLeg(legs.take_profit) ? legs.take_profit : null, stop: isLeg(legs.stop) ? legs.stop : null },
    exit,
    loose_exit: raw.loose_exit === true,
    note: typeof raw.note === 'string' ? raw.note : null,
    source: raw.source === 'auto' ? 'auto' : 'click',
    watch: isWatch(raw.watch)
      ? {
        state: raw.watch.state, since: typeof raw.watch.since === 'string' ? raw.watch.since : '',
        sells: isNum(raw.watch.sells) ? raw.watch.sells : 0,
        last_error: typeof raw.watch.last_error === 'string' && raw.watch.last_error !== '' ? raw.watch.last_error : null,
      }
      : null,
  };
}
function isWatch(w: unknown): w is Obj & { state: BridgeExitWatch['state'] } {
  return isObj(w) && (w.state === 'tp_crossed' || w.state === 'stop_due');
}
function asOrders(d: unknown): BridgeOrderRecord[] {
  if (!Array.isArray(d)) throw notTheBridge('/orders');
  return d.filter(isRecord).map(cleanRecord);
}

const AUTO_MODES = new Set<unknown>(['off', 'watch', 'on']);
const AUTO_ACTIONS = new Set<unknown>(['placed', 'would_place', 'skipped', 'failed']);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOr = (v: unknown): number | null => (isNum(v) ? v : null);

// A decision the list can print (its time, ticker, action and text); anything else is dropped.
function asDecision(x: unknown): AutoDecision | null {
  if (!isObj(x) || typeof x.at !== 'string' || typeof x.ticker !== 'string' || !AUTO_ACTIONS.has(x.action) || typeof x.text !== 'string') return null;
  return {
    ...(x as unknown as AutoDecision),
    alert_id: typeof x.alert_id === 'string' ? x.alert_id : '',
    alert_at: typeof x.alert_at === 'string' ? x.alert_at : '',
    price: numOr(x.price), vol_x: numOr(x.vol_x), rvol1: numOr(x.rvol1),
    mode: AUTO_MODES.has(x.mode) ? (x.mode as AutoMode) : 'off',
    reason: typeof x.reason === 'string' ? x.reason : '',
    order_id: numOr(x.order_id),
    plan: isObj(x.plan) ? (x.plan as AutoDecision['plan']) : null,
  };
}

// /auto's answer, with every field the panel prints checked: one of another shape (another
// version of the bridge in the making) is a `bad_answer` failure, never a crash in the panel.
function autoShaped(d: Obj): boolean {
  return AUTO_MODES.has(d.mode) && (d.blocked == null || typeof d.blocked === 'string')
    && isObj(d.window) && typeof d.window.start_at === 'string' && typeof d.window.end_at === 'string' && typeof d.window.open === 'boolean'
    && isObj(d.rule) && typeof d.rule.strong_only === 'boolean'
    && [d.rule.amount_usd, d.rule.budget_usd, d.rule.slots, d.rule.max_trades, d.rule.entry_stop_pct, d.rule.entry_valid_sec,
      d.rule.take_profit_pct, d.rule.stop_pct].every((v) => isNum(v))
    && isObj(d.feed) && typeof d.feed.paired === 'boolean' && typeof d.feed.state === 'string'
    && isObj(d.today) && [d.today.strong_pops, d.today.weak_pops, d.today.trades, d.today.waiting, d.today.held].every((v) => isNum(v))
    && Array.isArray(d.decisions);
}
function asAuto(d: unknown): AutoStatus {
  if (!isObj(d) || !autoShaped(d)) throw notTheBridge('/auto');
  const feed = d.feed as Obj;
  return {
    ...(d as unknown as AutoStatus),
    blocked: (strOrNull(d.blocked) as AutoBlocked | null),
    blocked_text: typeof d.blocked_text === 'string' && d.blocked_text !== '' ? d.blocked_text : null,
    feed: {
      ...(feed as unknown as AutoStatus['feed']),
      server: strOrNull(feed.server), connected_at: strOrNull(feed.connected_at),
      last_event_at: strOrNull(feed.last_event_at), error: typeof feed.error === 'string' && feed.error !== '' ? feed.error : null,
    },
    decisions: (d.decisions as unknown[]).map(asDecision).filter((x): x is AutoDecision => x != null).slice(0, 100),
  };
}

function asChase(d: unknown): BridgeChase {
  if (isObj(d) && isNum(d.order_id) && isNum(d.limit) && typeof d.status === 'string') return d as unknown as BridgeChase;
  throw notTheBridge('/chase');
}

function asSell(d: unknown): BridgeSell {
  if (isObj(d) && isNum(d.order_id) && isNum(d.qty) && isNum(d.limit) && typeof d.status === 'string') return d as unknown as BridgeSell;
  throw notTheBridge('/sell');
}

export const twsBridge = {
  status: async (conn: BridgeConn) => asStatus(await call<unknown>(conn, 'GET', '/status', undefined, SHORT_MS)),
  // The order /order would send right now, or the error it would give. Sends nothing.
  preview: (conn: BridgeConn, req: BridgeOrderRequest) => call<BridgePreview>(conn, 'POST', '/preview', req, SHORT_MS),
  // Places the bracket: one call = one order. Never retried by this client. An answer that
  // cannot be read (`bad_answer` with a 2xx status) leaves the outcome unknown, like a timeout.
  order: async (conn: BridgeConn, req: BridgeOrderRequest) => asOrder(await call<unknown>(conn, 'POST', '/order', req, ORDER_MS)),
  orders: async (conn: BridgeConn) => asOrders(await call<unknown>(conn, 'GET', '/orders', undefined, SHORT_MS)),
  cancel: (conn: BridgeConn, orderId: number) =>
    call<{ order_id: number; status: string }>(conn, 'POST', '/cancel', { order_id: orderId }, SHORT_MS),
  // Moves a working buy up to the live ask + offset, and its exits with it: one call = one move.
  // The page sends the order's id and nothing else; the bridge reads the ask itself.
  chase: async (conn: BridgeConn, orderId: number) => asChase(await call<unknown>(conn, 'POST', '/chase', { order_id: orderId }, CHASE_MS)),
  // Sells what that order still holds just under the live bid; a call while that sell is working
  // moves it lower. One call = one sell or one move. Not blocked by a halt.
  sell: async (conn: BridgeConn, orderId: number) => asSell(await call<unknown>(conn, 'POST', '/sell', { order_id: orderId }, SELL_MS)),
  halt: (conn: BridgeConn, halted: boolean) => call<{ halted: boolean }>(conn, 'POST', '/halt', { halted }, SHORT_MS),
};

// The automation's state: its mode, why it would place nothing now, its rule, the alert stream
// and today's decisions. An older bridge answers 404 `not_found` (bridgeAutoMissing).
export async function bridgeGetAuto(conn: BridgeConn): Promise<AutoStatus> {
  return asAuto(await call<unknown>(conn, 'GET', '/auto', undefined, SHORT_MS));
}

// Switches it: off, watch only (decides and logs, places nothing) or on. Answers the new state.
export async function bridgeSetAutoMode(conn: BridgeConn, mode: AutoMode): Promise<AutoStatus> {
  return asAuto(await call<unknown>(conn, 'POST', '/auto', { mode }, SHORT_MS));
}

// Links the bridge to the server's alert stream: the server's address (the page's own origin)
// and the token the server just gave. The token is in this one call's body and nowhere else;
// the errors thrown here never carry it. The bridge may check it against the server first, so
// it gets longer than the short calls.
const FEED_MS = 6000;
export async function bridgePairFeed(conn: BridgeConn, link: { server: string; token: string }): Promise<{ paired: true; server: string }> {
  const d = await call<unknown>(conn, 'POST', '/auto/feed', { server: link.server, token: link.token }, FEED_MS);
  if (isObj(d) && d.paired === true) return { paired: true, server: typeof d.server === 'string' ? d.server : link.server };
  throw notTheBridge('/auto/feed');
}

// An older bridge, without the automation: it has no /auto.
export function bridgeAutoMissing(f: BridgeFailure): boolean {
  return f.code === 'not_found' || f.status === 404;
}

// ---------------------------------------------------------------- what the page prints

// Statuses after which the buy can no longer fill (the bridge's own list).
const DONE = new Set(['Filled', 'Cancelled', 'ApiCancelled', 'Inactive']);
export function bridgeOrderDone(status: string): boolean {
  return DONE.has(status);
}

// Prices as the bridge writes them: cents from $1 up, hundredths of a cent below.
export function bridgePx(p: number): string {
  return p >= 1 ? p.toFixed(2) : p.toFixed(4);
}

// A price to the nearest US tick ($0.01 from $1 up, $0.0001 below), as the bridge rounds it
// (roundNearest in tools/tws-bridge/src/order.ts, its nudges against binary floating point included).
function nearestTick(raw: number): number {
  const scale = raw >= 1 - 1e-9 ? 100 : 10000;
  return Math.round(raw * scale + 1e-6) / scale;
}

// The buy limit the bridge works out from an alert's price (its roundNearest): the price plus
// limitOffsetPct, to the nearest US tick ($0.01 from $1 up, $0.0001 below).
export function bridgeLimit(alertPrice: number, limitOffsetPct: number): number {
  return nearestTick(alertPrice * (1 + limitOffsetPct / 100));
}

// The trigger of a stop entry, as the bridge works it out (its planOrder): the alert's price plus
// entryStopPct, to the nearest tick — the same sum and the same rounding, so the button shows the
// price the bridge will send. Null when there is no stop entry to offer: entryStopPct is 0, or
// missing (an older bridge), or the trigger rounds onto the alert's price (which the bridge
// refuses, `bad_prices`).
export function bridgeStopTrigger(order: Pick<BridgeOrderSettings, 'entryStopPct'>, alertPrice: number): number | null {
  const pct = order.entryStopPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return null;
  const trigger = nearestTick(alertPrice * (1 + pct / 100));
  return trigger > alertPrice + 1e-9 ? trigger : null;
}

// What the second button carries (the stop entry), from /status's order settings:
//   "100 if ≥ 0.3744 (+5%)"    sized in shares
//   "$400 if ≥ 0.3744 (+5%)"   sized in dollars: the shares are worked out by the bridge at the
//                              click, at the order's limit (the trigger + entryStopLimitPct), and
//                              the waiting line then says how many
// Always the trigger: a stop entry is priced from the alert's price, whatever priceFrom says.
// Null when there is no stop entry to offer (bridgeStopTrigger).
export function bridgeStopNumbers(order: BridgeOrderSettings, alertPrice: number): string | null {
  const trigger = bridgeStopTrigger(order, alertPrice);
  if (trigger == null) return null;
  const usd = order.amountUsd != null && order.amountUsd > 0 ? order.amountUsd : null;
  return `${usd != null ? bridgeUsd(usd) : order.qty} if ≥ ${bridgePx(trigger)} (+${order.entryStopPct ?? 0}%)`;
}

// A time on the operator's clock (Asia/Tashkent, like every time on the 📐 sidebar), to the
// second: "15:06:30". A stop entry ends on a whole second.
const OPERATOR_TZ = 'Asia/Tashkent';
function operatorClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: OPERATOR_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}
// "until 15:06:30" and the like, from an ISO time; null when there is none to read.
function clockOf(iso: string | null | undefined): string | null {
  const ms = iso != null ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? operatorClock(ms) : null;
}

// An ISO time from the bridge on the operator's clock: "15:06:30", or "15:06" with
// `seconds` false (the automation's hour). Null when there is none to read.
export function bridgeClock(iso: string | null | undefined, seconds = true): string | null {
  if (seconds) return clockOf(iso);
  const ms = iso != null ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString('en-GB', { timeZone: OPERATOR_TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    : null;
}

// Dollars as the bridge writes them, without needless cents: "$400", "$412.50".
export function bridgeUsd(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

// The shares a dollar-sized buy gets at a limit: as many whole shares as the amount pays for,
// rounded down, so the order never costs more (the bridge's planOrder, its 1e-9 guard included).
export function bridgeSharesFor(amountUsd: number, limit: number): number {
  return Math.floor(amountUsd / limit + 1e-9);
}

// What the Buy button carries, from /status's order settings:
//   "100 @ 0.5858"          sized in shares, the limit from the alert's price
//   "$400 ≈ 929 @ 0.4302"   sized in dollars (order.amountUsd above 0): the shares are the amount ÷
//                           the rounded limit, rounded down — the bridge's rule
//   "100 @ ask +1%" / "$400 @ ask +1%"   with the bridge's priceFrom on "ask": the limit, and with
//                           it the share count, is only known at the click
// After the click the card prints the bridge's own numbers.
export function bridgeBuyNumbers(order: BridgeOrderSettings, alertPrice: number): string {
  const usd = order.amountUsd != null && order.amountUsd > 0 ? order.amountUsd : null;
  if (order.priceFrom === 'ask') return `${usd != null ? bridgeUsd(usd) : order.qty} @ ask +${order.limitOffsetPct}%`;
  const limit = bridgeLimit(alertPrice, order.limitOffsetPct);
  if (usd != null) return `${bridgeUsd(usd)} ≈ ${bridgeSharesFor(usd, limit)} @ ${bridgePx(limit)}`;
  return `${order.qty} @ ${bridgePx(limit)}`;
}

// The body of /order for one alert row, or null when the row has no usable price. `alert_price`
// and `alert_stop` must be JSON numbers.
export function bridgeOrderRequest(row: {
  ticker: string; price: unknown; stop?: unknown; stage?: string | null; at?: number | null; id?: string | null;
}): BridgeOrderRequest | null {
  const price = typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 ? row.price : null;
  if (price == null) return null;
  const req: BridgeOrderRequest = { ticker: row.ticker.toUpperCase(), alert_price: price };
  if (typeof row.stop === 'number' && Number.isFinite(row.stop) && row.stop > 0) req.alert_stop = row.stop;
  if (row.stage) req.stage = row.stage.slice(0, 40);
  if (row.at != null && Number.isFinite(row.at)) req.alert_at = new Date(row.at).toISOString();
  if (row.id && row.id.length <= 80) req.alert_id = row.id;
  return req;
}

function signedPct(p: number): string {
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`;
}

// "929 @ 0.4410 (moved 2×, first 0.4302) · take-profit 0.4851 · stop 0.4190" — the bracket as TWS
// has it, with how often a chase moved the buy and where it started.
function bracketText(
  o: { qty: number; limit: number; take_profit: number | null; stop: number | null },
  moved?: { chases: number; first: number },
): string {
  const was = moved != null && moved.chases > 0 ? ` (moved ${moved.chases}×, first ${bridgePx(moved.first)})` : '';
  const parts = [`${o.qty} @ ${bridgePx(o.limit)}${was}`];
  if (o.take_profit != null) parts.push(`take-profit ${bridgePx(o.take_profit)}`);
  if (o.stop != null) parts.push(`stop ${bridgePx(o.stop)}`);
  return parts.join(' · ');
}

// A stop entry that waits for its trigger: "waiting: buy 1069 if the price reaches 0.3744 (limit
// 0.3782) · until 15:06:30 · take-profit 0.4118 · stop 0.3557" — the time IB cancels it if it has
// not filled, on the operator's clock.
function waitingText(o: {
  qty: number; limit: number; trigger: number; good_until?: string | null; take_profit: number | null; stop: number | null;
}): string {
  const parts = [`waiting: buy ${o.qty} if the price reaches ${bridgePx(o.trigger)} (limit ${bridgePx(o.limit)})`];
  const until = clockOf(o.good_until);
  if (until != null) parts.push(`until ${until}`);
  if (o.take_profit != null) parts.push(`take-profit ${bridgePx(o.take_profit)}`);
  if (o.stop != null) parts.push(`stop ${bridgePx(o.stop)}`);
  return parts.join(' · ');
}

// The answer of /order, before /orders has reported on it.
export function bridgeSentText(o: BridgeOrder): string {
  if (o.entry === 'stop' && o.trigger != null) return waitingText({ ...o, trigger: o.trigger });
  return `sent: ${bracketText(o)}`;
}

// A stop entry that IB cancelled at its time with nothing filled. The bridge says so in the
// order's note ("expired unfilled at 10:05:00 New York"); the card prints the time on the
// operator's clock instead, from `good_until`.
function bridgeOrderExpired(o: BridgeOrderRecord): boolean {
  return o.entry === 'stop' && bridgeOrderDone(o.status) && o.filled_qty === 0 && /^expired unfilled\b/.test(o.note ?? '');
}

// A buy that can still be cancelled: not done, and not already being cancelled.
export function bridgeOrderCancellable(o: { status: string }): boolean {
  return !bridgeOrderDone(o.status) && o.status !== 'PendingCancel';
}

// One order as a card shows it: its line, and what can be asked of it now.
export interface BridgeOrderView {
  // The line (see bridgeOrderView for every form it takes).
  text: string;
  // working (still to fill, or selling) · filled (holds shares) · done (nothing held, nothing working)
  tone: 'working' | 'filled' | 'done';
  // TWS's last word against the order: what stopped it or a leg, or refused a change to one. It
  // can stand on an order that is still working (a refused chase or sell move), so it is shown
  // beside the line and takes no button away.
  error: string | null;
  // The bridge's or TWS's last notice, while the buy is working or a sell is (at first: why the
  // price came from the alert when the ask was asked for). Not on an order that just holds its
  // shares: by then it is old news, and the line is long enough.
  note: string | null;
  // An exit leg is still working on a position that is closed; the bridge is cancelling it.
  loose: boolean;
  // Cancel the buy ("Cancel"), or what has not filled of it ("Cancel the rest"); null = nothing to cancel.
  cancel: 'Cancel' | 'Cancel the rest' | null;
  // A working buy with something left to fill and chases left (order.maxChases; 0 = no Chase).
  // Never a stop entry: the bridge does not chase one (`not_chaseable`).
  chase: boolean;
  // Shares held: "Sell", "Sell 40" (not all of the order: a part fill, or part already sold), and
  // "Sell lower" while a sell is working. `lower` tells the two kinds of click apart.
  sell: { label: string; lower: boolean } | null;
  // The bridge's automation placed it (2026-11-28): the line gets a small "auto" tag. Its
  // buttons are a clicked order's.
  auto: boolean;
  // The automation's exit watch while the order still holds shares: "take-profit crossed, selling
  // at the bid" / "stop due, selling at the bid", and its last error if it has one.
  watch: { text: string; error: string | null } | null;
}

// The line of one order:
//   working buy          "sent: 929 @ 0.4410 (moved 2×, first 0.4302) · take-profit 0.4851 · stop 0.4190"
//   stop entry, waiting  "waiting: buy 1069 if the price reaches 0.3744 (limit 0.3782) · until 15:06:30 · take-profit 0.4118 · stop 0.3557"
//   stop entry, expired  "expired unfilled at 15:06:30" (IB cancelled it at its time, nothing filled)
//   stop entry, filled   as any fill, with its trigger: "filled 1069 @ 0.3749 (+5.1% vs the alert, triggered at 0.3744) · holding …"
//   part filled, working "filled 40 of 100 @ 2.52 (+0.8% vs the alert) · 60 still working at 2.53"
//   being cancelled      "cancelling…" / "cancelling the rest… · filled 40 of 100 @ 2.52 (+0.8% vs the alert)"
//   filled, held         "filled 929 @ 0.4301 (+1.0% vs the alert) · holding 929 · take-profit 0.4731 · stop 0.4086"
//                        ("… · holding 929 · no exit order working" when neither exit is left in TWS)
//   filled, closed by an exit of its own
//                        "filled 929 @ 0.4301 (…) · take-profit filled 929 @ 0.4731 (+10.0% vs the buy)" / "… · stop filled …"
//   cancelled            "cancelled" / "cancelled · 40 of 100 filled @ 2.52 (+0.8% vs the alert) · holding 40 · …"
//   other final statuses in TWS's words ("Inactive")
//   Sell clicked         "bought 929 @ 0.4301 · selling 929 @ 0.4020 (bid 0.4102)"
//                        "… · selling 929 @ 0.3950 (bid 0.4031, moved 1×, first 0.4020) · sold 400 @ 0.4050 (−5.8% vs the buy), 529 left"
//   sold                 "bought 929 @ 0.4301 · sold 929 @ 0.4101 (−4.7% vs the buy)"
//   part sold, sell over "bought 929 @ 0.4301 · sold 400 of 929 @ 0.4050 (−5.8% vs the buy) · 529 still held"
//   a sell that sold nothing  "… · the sell did not go through (Cancelled)" after the holding line
// `settings` are /status's order settings (for maxChases); null = not known, so no Chase.
export function bridgeOrderView(o: BridgeOrderRecord, settings: Pick<BridgeOrderSettings, 'maxChases'> | null): BridgeOrderView {
  const qty = o.sent.qty;
  const filled = o.filled_qty;
  const avg = o.avg_fill_price;
  const done = bridgeOrderDone(o.status);
  const cancelling = o.status === 'PendingCancel';
  const held = o.held_qty ?? 0;
  const knowsHeld = o.held_qty != null;
  const exit = o.exit ?? null;
  const exitWorking = exit != null && !bridgeOrderDone(exit.status);
  const chases = o.chases ?? 0;
  const tp = o.legs.take_profit;
  const st = o.legs.stop;
  const alive = (l: BridgeLeg | null) => l != null && !bridgeOrderDone(l.status);
  const vsBuy = (p: number | null) => (p != null && avg != null && avg > 0 ? ` (${signedPct((p / avg - 1) * 100)} vs the buy)` : '');
  // A stop entry (a buy that waited above the alert's price), and the price it waited for.
  const stopEntry = o.entry === 'stop';
  const trigger = stopEntry ? o.sent.trigger ?? null : null;

  // "929 @ 0.4301 (+1.0% vs the alert)" / "40 of 100 @ 2.52 (…)"; `short` leaves the alert out. A
  // stop entry that filled says where it triggered: "(+5.1% vs the alert, triggered at 0.3744)".
  const fill = (short: boolean): string | null => {
    if (avg == null || filled <= 0) return null;
    const asides = short ? [] : [
      ...(o.slip_pct != null ? [`${signedPct(o.slip_pct)} vs the alert`] : []),
      ...(trigger != null ? [`triggered at ${bridgePx(trigger)}`] : []),
    ];
    return `${filled === qty ? `${qty}` : `${filled} of ${qty}`} @ ${bridgePx(avg)}${asides.length > 0 ? ` (${asides.join(', ')})` : ''}`;
  };
  // What is held and what stands between it and a loss: the bracket's exits still working in TWS.
  const holding = (): string => {
    const exits: string[] = [];
    if (alive(tp) && o.sent.take_profit != null) exits.push(`take-profit ${bridgePx(o.sent.take_profit)}`);
    if (alive(st) && o.sent.stop != null) exits.push(`stop ${bridgePx(o.sent.stop)}`);
    return `holding ${held} · ${exits.length > 0 ? exits.join(' · ') : 'no exit order working'}`;
  };
  // Nothing held and no Sell clicked: an exit of the bracket's own closed it.
  const closedBy = (): string => {
    const parts: string[] = [];
    if (tp != null && tp.filled_qty > 0) parts.push(`take-profit filled ${tp.filled_qty}${tp.avg_fill_price != null ? ` @ ${bridgePx(tp.avg_fill_price)}` : ''}${vsBuy(tp.avg_fill_price)}`);
    if (st != null && st.filled_qty > 0) parts.push(`stop filled ${st.filled_qty}${st.avg_fill_price != null ? ` @ ${bridgePx(st.avg_fill_price)}` : ''}${vsBuy(st.avg_fill_price)}`);
    return parts.length > 0 ? parts.join(' · ') : 'nothing held';
  };
  const after = (): string => (knowsHeld && filled > 0 ? ` · ${held > 0 ? holding() : closedBy()}` : '');

  let text: string;
  let tone: BridgeOrderView['tone'];
  if (exit != null && (exitWorking || exit.filled_qty > 0)) {
    // Sell was clicked, and that sell is working or has sold something.
    const at = exit.avg_fill_price != null
      ? ` @ ${bridgePx(exit.avg_fill_price)}${exit.exit_pct != null ? ` (${signedPct(exit.exit_pct)} vs the buy)` : ''}`
      : '';
    let selling: string;
    if (exitWorking) {
      const was = exit.reprices > 0 ? `, moved ${exit.reprices}×, first ${bridgePx(exit.first_limit)}` : '';
      selling = `selling ${exit.qty} @ ${bridgePx(exit.limit)} (bid ${bridgePx(exit.bid)}${was})`;
      if (exit.filled_qty > 0) selling += ` · sold ${exit.filled_qty}${at}, ${Math.max(0, exit.qty - exit.filled_qty)} left`;
    } else {
      selling = exit.filled_qty >= exit.qty ? `sold ${exit.filled_qty}${at}` : `sold ${exit.filled_qty} of ${exit.qty}${at}`;
      if (held > 0) selling += ` · ${held} still held`;
    }
    text = `bought ${fill(true) ?? `${qty}`} · ${selling}`;
    tone = exitWorking ? 'working' : held > 0 ? 'filled' : 'done';
  } else {
    if (!done && !cancelling) {
      const f = fill(false);
      const moved = { chases, first: o.sent.first_limit ?? o.sent.limit };
      text = f != null
        ? `filled ${f} · ${Math.max(0, qty - filled)} still working at ${bridgePx(o.sent.limit)}${chases > 0 ? ` (moved ${chases}×, first ${bridgePx(moved.first)})` : ''}`
        : trigger != null
          ? waitingText({ ...o.sent, trigger })
          : `sent: ${bracketText(o.sent, moved)}`;
      tone = 'working';
    } else if (cancelling) {
      const f = fill(false);
      text = f != null ? `cancelling the rest… · filled ${f}` : 'cancelling…';
      tone = 'working';
    } else if (o.status === 'Filled') {
      text = `filled ${fill(false) ?? `${qty}`}${after()}`;
      tone = knowsHeld && held === 0 ? 'done' : 'filled';
    } else if (bridgeOrderExpired(o)) {
      // The bridge's note has the time in New York's; the card's times are the operator's.
      const at = clockOf(o.sent.good_until);
      text = at != null ? `expired unfilled at ${at}` : 'expired unfilled';
      tone = 'done';
    } else {
      const word = o.status === 'Cancelled' || o.status === 'ApiCancelled' ? 'cancelled' : o.status;
      const f = fill(false);
      text = f != null ? `${word} · ${f.replace(' @ ', ' filled @ ')}${after()}` : word;
      tone = held > 0 ? 'filled' : 'done';
    }
    // A sell that ended with nothing sold: the shares are still held, and Sell can be clicked again.
    if (exit != null) text += ` · the sell did not go through (${exit.status})`;
  }

  const maxChases = settings?.maxChases ?? 0;
  // The exit watch says what it is doing only while there is something left to sell.
  const w = o.watch ?? null;
  const watch = w != null && (!knowsHeld || held > 0)
    ? { text: w.state === 'tp_crossed' ? 'take-profit crossed, selling at the bid' : 'stop due, selling at the bid', error: w.last_error }
    : null;
  return {
    text,
    tone,
    error: o.error ?? null,
    note: !done || exitWorking ? o.note ?? null : null,
    loose: o.loose_exit === true,
    cancel: bridgeOrderCancellable(o) ? (filled > 0 ? 'Cancel the rest' : 'Cancel') : null,
    chase: !stopEntry && !done && !cancelling && filled < qty && maxChases > 0 && chases < maxChases,
    sell: held > 0 ? { lower: exitWorking, label: exitWorking ? 'Sell lower' : held === qty ? 'Sell' : `Sell ${held}` } : null,
    auto: o.source === 'auto',
    watch,
  };
}

// The line alone.
export function bridgeOrderText(o: BridgeOrderRecord): string {
  return bridgeOrderView(o, null).text;
}

// Does the page have a reason to ask /orders often about this order? While the buy is working,
// and while it holds shares with a sell working (a Sell click's, or the automation's exit watch).
export function bridgeOrderBusy(o: BridgeOrderRecord): boolean {
  const held = (o.held_qty ?? 0) > 0;
  return !bridgeOrderDone(o.status) || (held && o.exit != null && !bridgeOrderDone(o.exit.status)) || (held && o.watch != null);
}

// …and a reason to ask now and then: it is busy, it holds shares (its exits in TWS can fill at
// any time), or an exit of it is loose.
export function bridgeOrderLive(o: BridgeOrderRecord): boolean {
  return bridgeOrderBusy(o) || (o.held_qty ?? 0) > 0 || o.loose_exit === true;
}

// Does this order use up its alert? Only while it is still working, or once anything of it has
// filled. An order that has ended with nothing filled frees its alert, whoever ended it: the
// operator cancelled it (from the card or in TWS), TWS refused it, or it never went out
// (2026-11-27, the operator after the first real test: "the Buy button should re-appear after
// cancelling"). "Ended" is a final status (Cancelled, Inactive); `PendingCancel` is not one —
// until the cancel is confirmed the buy can still fill. A cancelled order with a partial fill
// still counts.
//
// The bridge refuses a second order on an alert by the same rule (`usesUpAlert` in
// tools/tws-bridge/src/book.ts): keep the two in step.
export function bridgeOrderCounts(o: Pick<BridgeOrderRecord, 'status' | 'filled_qty'>): boolean {
  return o.filled_qty > 0 || o.status === 'Filled' || !bridgeOrderDone(o.status);
}

export type BridgeTone = 'muted' | 'ok' | 'warn' | 'danger';
// The sidebar's colours for them: gray, the green of "↺ held before", amber, red.
export const BRIDGE_TONE: Record<BridgeTone, string> = { muted: '#8c8c8c', ok: '#95de64', warn: '#faad14', danger: '#ff4d4f' };

export interface BridgeView {
  // What the status line reads.
  text: string;
  tone: BridgeTone;
  // Every switch the page can see says an order would be accepted.
  canOrder: boolean;
  // Orders would go to a LIVE account (TWS reports a non-paper account and paper_only is off).
  live: boolean;
  // A chase would be accepted: what an order needs, but for the day's order count (a chase is
  // the same order again).
  canChase: boolean;
  // A sell (and a cancel) can be asked for: the bridge answers and TWS is connected. A halt does
  // not block getting out, and neither does the alert's age; what else may stand in the way
  // (TWS offline, a live account under paper-only) the bridge says in its own words.
  canSell: boolean;
  // TWS is logged in to a non-paper account, whatever the switches say: the Sell button reads "LIVE".
  liveAccount: boolean;
}

// The status the sidebar prints, from the last /status answer (or the failure in its place).
//   not set up            "TWS bridge: not set up (no token)" / "TWS bridge: the URL must be http://127.0.0.1:<port>"
//   first check           "TWS bridge: checking…"
//   bridge not reachable  "TWS bridge not running (or the browser blocked the call)" / "TWS bridge: no answer in 2.5 s"
//   bridge said no        "TWS bridge: <its error text>" (a wrong token, an origin it does not allow)
//   TWS not connected     "TWS not connected (the bridge is running)"
//   paper account         "TWS: paper · ready"
//   LIVE account          "TWS: LIVE account · ready" / "TWS: LIVE account · no orders (the bridge is paper-only)"
//   halted                "TWS: paper · halted" / "TWS: LIVE account · halted"
//   TWS lost IB's servers "TWS: paper · offline (TWS has lost IB's servers) · no orders" (also "TWS: LIVE account · …")
//   also                  "… · orders off in the bridge's config", "… · daily limit reached (20 of 20)",
//                         "TWS: connected · account not reported yet"
export function describeBridge(
  setup: { url: string; token: string },
  poll: { status: BridgeStatus | null; failure: BridgeFailure | null },
): BridgeView {
  const off = { canOrder: false, live: false, canChase: false, canSell: false, liveAccount: false };
  if (bridgeOrigin(setup.url) == null) return { text: 'TWS bridge: the URL must be http://127.0.0.1:<port>', tone: 'warn', ...off };
  if (setup.token === '') return { text: 'TWS bridge: not set up (no token)', tone: 'muted', ...off };
  const f = poll.failure;
  if (f != null) {
    if (f.code === 'unreachable') return { text: 'TWS bridge not running (or the browser blocked the call)', tone: 'warn', ...off };
    if (f.code === 'timeout') return { text: 'TWS bridge: no answer in 2.5 s', tone: 'warn', ...off };
    return { text: `TWS bridge: ${f.message}`, tone: 'warn', ...off };
  }
  const s = poll.status;
  if (s == null) return { text: 'TWS bridge: checking…', tone: 'muted', ...off };
  if (!s.tws.connected) return { text: 'TWS not connected (the bridge is running)', tone: 'warn', ...off };

  const known = s.tws.accounts.length > 0;
  const paper = s.tws.paper;
  const account = !known ? 'TWS: connected' : paper ? 'TWS: paper' : 'TWS: LIVE account';
  const tone: BridgeTone = paper ? 'ok' : 'danger';
  // From here the bridge answers and TWS is connected: a sell can be asked for in every case.
  const liveAccount = known && !paper;
  const blocked = (why: string, t: BridgeTone = 'warn', canChase = false): BridgeView =>
    ({ text: `${account} · ${why}`, tone: t, canOrder: false, live: false, canChase, canSell: true, liveAccount });
  // TWS has lost IB's servers (a newer bridge says so; an older one sends no `offline`): no
  // orders, whatever else is on.
  if (s.tws.offline === true) return blocked("offline (TWS has lost IB's servers) · no orders");
  if (!known) return blocked('account not reported yet', 'muted');
  if (!paper && s.paper_only) return blocked('no orders (the bridge is paper-only)');
  if (s.halted) return blocked('halted');
  if (!s.enabled) return blocked("orders off in the bridge's config");
  // The day's count stops new orders; a chase is not one.
  if (s.today.orders >= s.limits.maxOrdersPerDay) return blocked(`daily limit reached (${s.today.orders} of ${s.limits.maxOrdersPerDay})`, 'warn', true);
  return { text: `${account} · ready`, tone, canOrder: true, live: !paper, canChase: true, canSell: true, liveAccount };
}
