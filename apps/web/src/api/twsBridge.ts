// Client for the TWS bridge (tools/tws-bridge, 2026-11-26): a small program on the operator's own
// computer, next to TWS. The page calls it at http://127.0.0.1:8765 to place the operator's
// bracket order (/order), to follow it (/orders) and to cancel it (/cancel). Nothing here goes
// through the pnldash API, and the token is sent to the bridge alone: as a header, never in a
// URL, never logged, and only to a loopback address (bridgeOrigin).
//
// The bridge also has /focus (make TWS's linked windows show a ticker). The page used it for a
// per-row "TWS" button and a row click that TWS followed; both were removed on 2026-11-27 at the
// operator's request, and this client's focus() with them.

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
}

export interface BridgePreview {
  ticker: string;
  qty: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  notional: number;
  checks: Array<{ name: string; detail: string }>;
}

export interface BridgeOrder {
  order_id: number;
  ticker: string;
  qty: number;
  limit: number;
  take_profit: number | null;
  stop: number | null;
  stop_limit: number | null;
  status: string;
}

export interface BridgeLeg {
  order_id: number;
  status: string;
  filled_qty: number;
  avg_fill_price: number | null;
}

// One bracket as GET /orders lists it; `order_id` is the buy's.
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
  sent: {
    qty: number;
    limit: number;
    take_profit: number | null;
    stop: number | null;
    stop_limit: number | null;
  };
  status: string;                  // the buy's, in TWS's words (PendingSubmit, Submitted, Filled, Cancelled, …)
  filled_qty: number;
  avg_fill_price: number | null;
  slip_pct: number | null;         // the average fill against the alert's price, %: positive = paid more
  legs: { take_profit: BridgeLeg | null; stop: BridgeLeg | null };
  error: string | null;            // the last message from TWS that stopped the order or one of its legs
  note: string | null;             // the last warning or notice from TWS about it
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

function asOrder(d: unknown): BridgeOrder {
  if (isObj(d) && isNum(d.order_id) && typeof d.ticker === 'string' && isNum(d.qty) && isNum(d.limit)
    && numOrNull(d.take_profit) && numOrNull(d.stop) && typeof d.status === 'string') return d as unknown as BridgeOrder;
  throw notTheBridge('/order');
}

function isRecord(o: unknown): o is BridgeOrderRecord {
  return isObj(o) && isNum(o.order_id) && typeof o.ticker === 'string' && typeof o.placed_at === 'string' && typeof o.status === 'string'
    && isObj(o.asked) && isObj(o.sent) && isNum(o.sent.qty) && isNum(o.sent.limit) && numOrNull(o.sent.take_profit) && numOrNull(o.sent.stop)
    && isNum(o.filled_qty) && numOrNull(o.avg_fill_price) && numOrNull(o.slip_pct) && (o.error == null || typeof o.error === 'string');
}
function asOrders(d: unknown): BridgeOrderRecord[] {
  if (!Array.isArray(d)) throw notTheBridge('/orders');
  return d.filter(isRecord);
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
  halt: (conn: BridgeConn, halted: boolean) => call<{ halted: boolean }>(conn, 'POST', '/halt', { halted }, SHORT_MS),
};

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

// The buy limit the bridge works out from an alert's price (its roundNearest): the price plus
// limitOffsetPct, to the nearest US tick ($0.01 from $1 up, $0.0001 below).
export function bridgeLimit(alertPrice: number, limitOffsetPct: number): number {
  const raw = alertPrice * (1 + limitOffsetPct / 100);
  const scale = raw >= 1 - 1e-9 ? 100 : 10000;
  return Math.round(raw * scale + 1e-6) / scale;
}

// "100 @ 0.5858" — what the Buy button carries, from /status's order settings. With the bridge's
// priceFrom on "ask" the limit is only known at the click: "100 @ ask +1%".
export function bridgeBuyNumbers(order: BridgeOrderSettings, alertPrice: number): string {
  if (order.priceFrom === 'ask') return `${order.qty} @ ask +${order.limitOffsetPct}%`;
  return `${order.qty} @ ${bridgePx(bridgeLimit(alertPrice, order.limitOffsetPct))}`;
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

// "100 @ 0.5858 · take-profit 0.6444 · stop 0.5565" — the bracket as it went to TWS.
function bracketText(o: { qty: number; limit: number; take_profit: number | null; stop: number | null }): string {
  const parts = [`${o.qty} @ ${bridgePx(o.limit)}`];
  if (o.take_profit != null) parts.push(`take-profit ${bridgePx(o.take_profit)}`);
  if (o.stop != null) parts.push(`stop ${bridgePx(o.stop)}`);
  return parts.join(' · ');
}

// The answer of /order, before /orders has reported on it.
export function bridgeSentText(o: BridgeOrder): string {
  return `sent: ${bracketText(o)}`;
}

// One order as the card prints it:
//   "sent: 100 @ 0.5858 · take-profit 0.6444 · stop 0.5565"          working, nothing filled
//   "filled 100 @ 0.5850 (−0.1% vs the alert)"                        the buy filled
//   "filled 40 of 100 @ 0.5850 (−0.1% vs the alert) · still working"  part of it
//   "cancelling…" / "cancelled" / "cancelled · 40 of 100 filled @ 0.5850"
//   "Inactive" and other statuses in TWS's words; TWS's own message when it stopped the order.
export function bridgeOrderText(o: BridgeOrderRecord): string {
  const qty = o.sent.qty;
  const fill = o.avg_fill_price != null && o.filled_qty > 0
    ? `${o.filled_qty === qty ? `${qty}` : `${o.filled_qty} of ${qty}`} @ ${bridgePx(o.avg_fill_price)}`
      + (o.slip_pct != null ? ` (${signedPct(o.slip_pct)} vs the alert)` : '')
    : null;
  let text: string;
  if (o.status === 'Filled') text = `filled ${fill ?? `${qty}`}`;
  else if (o.status === 'Cancelled' || o.status === 'ApiCancelled') text = fill ? `cancelled · ${fill.replace(' @ ', ' filled @ ')}` : 'cancelled';
  else if (o.status === 'PendingCancel') text = fill ? `cancelling… · filled ${fill}` : 'cancelling…';
  else if (bridgeOrderDone(o.status)) text = fill ? `${o.status} · filled ${fill}` : o.status;
  else if (fill) text = `filled ${fill} · still working`;
  else text = `sent: ${bracketText(o.sent)}`;
  return o.error ? `${text} · ${o.error}` : text;
}

// A buy that can still be cancelled: not done, and not already being cancelled.
export function bridgeOrderCancellable(o: { status: string }): boolean {
  return !bridgeOrderDone(o.status) && o.status !== 'PendingCancel';
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
  const off = { canOrder: false, live: false };
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
  const blocked = (why: string, t: BridgeTone = 'warn'): BridgeView =>
    ({ text: `${account} · ${why}`, tone: t, canOrder: false, live: false });
  // TWS has lost IB's servers (a newer bridge says so; an older one sends no `offline`): no
  // orders, whatever else is on.
  if (s.tws.offline === true) return blocked("offline (TWS has lost IB's servers) · no orders");
  if (!known) return blocked('account not reported yet', 'muted');
  if (!paper && s.paper_only) return blocked('no orders (the bridge is paper-only)');
  if (s.halted) return blocked('halted');
  if (!s.enabled) return blocked("orders off in the bridge's config");
  if (s.today.orders >= s.limits.maxOrdersPerDay) return blocked(`daily limit reached (${s.today.orders} of ${s.limits.maxOrdersPerDay})`);
  return { text: `${account} · ready`, tone, canOrder: true, live: !paper };
}
