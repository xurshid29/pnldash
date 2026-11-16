// Finviz screener client — equivalent of the two parallel curl calls in
// screener-poll_breakout.sh (v=131 ownership + v=110 overview), joined by ticker.

import type { TradingSession } from '../db/types.js';

const FINVIZ_BASE = 'https://elite.finviz.com';
const UA = 'Mozilla/5.0';
// A stalled Elite response must not hold the poller's `inFlight` flag forever.
// The global rate gate serialises starts but cannot recover a fetch whose body
// never completes. Fifteen seconds is comfortably above normal export latency
// while still allowing the next 20s poll cycle to retry.
const REQUEST_TIMEOUT_MS = 15_000;

export interface ScreenerRow {
  ticker: string;
  change_pct: number | null;
  float_m: number | null;
  // True when float_m was filled in from shares_outstanding because Finviz
  // returned no Float value for the row. The displayed value still represents
  // the best-available estimate of tradeable supply.
  float_is_proxy: boolean;
  price: number | null;
  volume: number | null;
  avg_volume: number | null;
  rel_volume: number | null;
  mcap_m: number | null;
  country: string | null;
  company: string | null;
  sector: string | null;
  industry: string | null;
  // Sentiment / ownership fields from v=131 (no extra HTTP cost)
  short_float_pct: number | null;
  short_ratio: number | null;
  insider_own_pct: number | null;
  insider_trans_pct: number | null;
  inst_own_pct: number | null;
  inst_trans_pct: number | null;
  shares_out_m: number | null;
}

function token(): string {
  const t = process.env.FINVIZ_API_TOKEN;
  if (!t) throw new Error('FINVIZ_API_TOKEN is not set');
  return t;
}

// Finviz screener exports (2026-11-16). Finviz split its screener into a Stock and an ETF one
// and asks every export URL to name the product: "add type= to your Finviz screener export URLs
// by 07.Dec.2026" → /export/screener?type=stocks&…. A URL without it keeps answering, but from
// that date in the new screener's layout. Checked on 11-16 with type=stocks, on /export and on
// /export/screener alike: the v=131, v=110 and v=152 (custom columns) exports return the same
// headers and rows as the old URLs, with our filter and sort. `query` is everything but the
// product and the token ("v=131&f=…&o=-change").
export function screenerExportUrl(query: string, authToken: string = token()): string {
  return `${FINVIZ_BASE}/export/screener?type=stocks&${query}&auth=${authToken}`;
}

// The column each named field sits in, read from an export's header row. Finviz's notice says
// the new screener's CSV starts a custom column list with "No." and "Ticker", which would move
// every column of the quote exports below (they start at Ticker today); reading by name is right
// in either layout. A name the header doesn't have keeps the position it had on 2026-11-16, and
// is logged once.
const warnedColumns = new Set<string>();
export function csvColumns<K extends string>(header: readonly string[] | undefined, expected: Record<K, number>, view = 'export'): Record<K, number> {
  const names = (header ?? []).map((h) => h.trim().toLowerCase());
  const out = {} as Record<K, number>;
  for (const key of Object.keys(expected) as K[]) {
    const at = names.indexOf(key.toLowerCase());
    out[key] = at >= 0 ? at : expected[key];
    if (at < 0 && names.length > 0 && !warnedColumns.has(`${view}|${key}`)) {
      warnedColumns.add(`${view}|${key}`);
      console.warn(`[finviz] ${view}: no "${key}" column in the header (${(header ?? []).join(', ')}) — reading position ${expected[key]}`);
    }
  }
  return out;
}

// Thrown when Finviz returns HTTP 429. Distinct type so callers can tell a
// rate-limit ("back off, try later — data still exists") apart from a genuine
// empty result, instead of both collapsing to [].
export class FinvizRateLimitError extends Error {
  constructor() {
    super('Finviz HTTP 429 (rate limited)');
    this.name = 'FinvizRateLimitError';
  }
}

// ─── global rate-limit gate ─────────────────────────────────────────────────
// Measured 2026-06-11: Finviz Elite 429s on the SECOND request fired 300ms
// after the first — the real ceiling is ~1 request/second, far stricter than
// the "~5 rapid calls" earlier guess. Multiple callers fire concurrently (the
// poller's per-cycle momentum v131+v110 ∥ ignition v131+v110 + news + swing,
// plus the daily-bars drain), so without serialisation we blow past 1/s and
// 429 — and swing, the last screen each cycle, lost the race every time →
// empty tab. Funnel ALL Finviz HTTP through one chained gate spaced just over
// 1s apart. A cycle's ~7 calls then take ~8s (fits the 20s interval); daily-
// bars (1/4s) and the AH overlay share the same budget. Keeps us under ~1/s.
const MIN_SPACING_MS = 1100;
let gateTail: Promise<void> = Promise.resolve();
let lastStartMs = 0;

function rateLimitGate(): Promise<void> {
  const mine = gateTail.then(async () => {
    const wait = MIN_SPACING_MS - (Date.now() - lastStartMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStartMs = Date.now();
  });
  // Keep the chain alive even if a turn rejects (it won't — the body can't throw).
  gateTail = mine.catch(() => {});
  return mine;
}

async function fetchCsv(url: string): Promise<string[][]> {
  await rateLimitGate();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (res.status === 429) {
      // Spacing should prevent this; if it still happens it's a real signal, not
      // silent "no rows". Typed so the screener fetch surfaces it.
      console.warn('[finviz] HTTP 429 — rate limited (despite spacing)');
      throw new FinvizRateLimitError();
    }
    if (!res.ok) throw new Error(`Finviz HTTP ${res.status}`);
    const text = await res.text();
    return parseCsv(text);
  } finally {
    clearTimeout(timer);
  }
}

// Minimal CSV parser tolerant of quoted fields with commas (Finviz quotes
// company/title fields with embedded commas).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1);
}

// Parses Finviz volume-like values returned by v=131. Confirmed by direct
// export inspection (UONE → "42.99" in Average Volume = 42,990 shares):
//   "42.99"   (no suffix)  → 42_990    (implicit K = thousands)
//   "1.5M"    (M suffix)    → 1_500_000
//   "12345"   (no-suffix integer) → 12_345_000  (still K-based by convention)
// Use this for fields that semantically are share counts. For mcap/float that
// the rest of the pipeline stores as `_m` (already in millions), use `num()`.
const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
function numScaled(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const m = cleaned.match(/^([+-]?\d*\.?\d+)([KMBT])?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  const suffix = m[2]?.toUpperCase();
  if (suffix) return Math.round(v * SCALE[suffix]);
  // No suffix — Finviz exports these fields with implicit K base.
  return Math.round(v * 1000);
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%,]/g, '').trim();
  if (!cleaned || cleaned === '-') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

export interface ScreenerOptions {
  filter: string;       // e.g. ind_stocksonly,sh_float_u50,...
  floatMaxM: number;    // post-filter ceiling
  topN: number;
  session: TradingSession;  // 'afterhours' switches to the after-hours screen
}

// Fetch one cycle worth of screener rows.
// Mirrors lines 63-114 of screener-poll_breakout.sh.
export async function fetchScreener(opts: ScreenerOptions): Promise<ScreenerRow[]> {
  // After-hours: Finviz freezes the regular Change at the 4pm close, so we
  // screen on the after-hours move instead. Finviz applies the ah_change
  // filter to v=131/v=110 as well, so the ownership/overview joins below
  // still resolve to the right universe.
  const afterHours = opts.session === 'afterhours';
  const f = encodeURIComponent(afterHours ? toAfterHoursFilter(opts.filter) : opts.filter);
  const ownershipUrl = screenerExportUrl(`v=131&f=${f}&o=-change`);
  const overviewUrl = screenerExportUrl(`v=110&f=${f}&o=-change`);

  const [ownership, overview] = await Promise.all([
    fetchCsv(ownershipUrl),
    fetchCsv(overviewUrl),
  ]);

  // Finviz occasionally returns an empty body (transient). Distinguish that
  // from a legitimate "no matches" by requiring at least the header row on
  // the ownership response — without it, we can't trust the result and would
  // rather throw so the caller keeps the last good payload.
  if (ownership.length === 0) {
    throw new Error('Finviz ownership export returned empty body');
  }

  const out = parseScreenerExports(ownership, overview, opts);

  // After-hours: v=131's Price/Change/Volume are frozen at the 4pm close.
  // Overlay the live after-hours figures (which Finviz keeps in separate
  // columns) so the screener reflects the current session.
  if (afterHours && out.length > 0) {
    await applyAfterHoursQuotes(out);
  }
  return out;
}

// The two exports of one cycle → screener rows: v=131 (ownership) rows in their order, each
// with its v=110 (overview) company / sector / industry / country, the float cap applied, the
// first `topN`. Columns are read by header name (csvColumns; the positions are the fallback).
export function parseScreenerExports(ownership: string[][], overview: string[][], opts: { floatMaxM: number; topN: number }): ScreenerRow[] {
  // v=110 (overview) header: No., Ticker, Company, Sector, Industry, Country, ...
  const ov = csvColumns(overview[0], { Ticker: 1, Company: 2, Sector: 3, Industry: 4, Country: 5 }, 'v=110');
  const ovNeed = Math.max(ov.Ticker, ov.Company, ov.Sector, ov.Industry, ov.Country);
  type Meta = { company: string | null; sector: string | null; industry: string | null; country: string | null };
  const metaByTicker = new Map<string, Meta>();
  for (let i = 1; i < overview.length; i++) {
    const r = overview[i];
    if (r.length > ovNeed) {
      metaByTicker.set(r[ov.Ticker], {
        company: r[ov.Company] || null,
        sector: r[ov.Sector] || null,
        industry: r[ov.Industry] || null,
        country: r[ov.Country] || null,
      });
    }
  }

  // v=131 (ownership) header: No., Ticker, Market Cap, Shares Outstanding, Shares Float,
  // Insider Ownership, Insider Transactions, Institutional Ownership, Institutional
  // Transactions, Short Float, Short Ratio, Average Volume, Price, Change, Volume.
  const c = csvColumns(ownership[0], {
    'Ticker': 1, 'Market Cap': 2, 'Shares Outstanding': 3, 'Shares Float': 4, 'Insider Ownership': 5, 'Insider Transactions': 6,
    'Institutional Ownership': 7, 'Institutional Transactions': 8, 'Short Float': 9, 'Short Ratio': 10, 'Average Volume': 11,
    'Price': 12, 'Change': 13, 'Volume': 14,
  }, 'v=131');
  const need = Math.max(...Object.values(c));
  const out: ScreenerRow[] = [];
  for (let i = 1; i < ownership.length && out.length < opts.topN; i++) {
    const r = ownership[i];
    if (r.length <= need) continue;
    const ticker = r[c.Ticker];
    const rawFloat = num(r[c['Shares Float']]);
    const sharesOut = num(r[c['Shares Outstanding']]);
    // Size cap based on best-available "tradeable supply" estimate. If Finviz
    // returned a Float value, use it. If not (Finviz often misses Float for
    // recent IPOs / nano-caps like CNSP), fall back to Shares Outstanding —
    // for tiny issuers these are effectively equal anyway, and skipping these
    // rows would silently drop legitimate momentum candidates.
    let floatValue: number | null;
    let floatIsProxy: boolean;
    if (rawFloat != null && rawFloat > 0) {
      floatValue = rawFloat;
      floatIsProxy = false;
    } else if (sharesOut != null && sharesOut > 0) {
      floatValue = sharesOut;
      floatIsProxy = true;
    } else {
      // Neither (2026-10-14): JBDI ran 1 → 9 on 10-12 and never reached our
      // screen — Finviz had no float, shares outstanding or market cap for it,
      // and this used to `continue`. Keep the row with an unknown float; the
      // cap below only applies to a known size (the grade skips its float
      // factor, the UI shows —).
      floatValue = null;
      floatIsProxy = false;
    }
    if (floatValue != null && floatValue >= opts.floatMaxM) continue;
    const meta = metaByTicker.get(ticker);
    const avg_volume = numScaled(r[c['Average Volume']]);   // Finviz returns this with K/M/B suffix
    const volume = num(r[c.Volume]);
    const rel_volume = avg_volume && avg_volume > 0 && volume != null
      ? +(volume / avg_volume).toFixed(2)
      : null;
    out.push({
      ticker,
      change_pct: num(r[c.Change]),
      float_m: floatValue,
      float_is_proxy: floatIsProxy,
      price: num(r[c.Price]),
      volume,
      avg_volume,
      rel_volume,
      mcap_m: num(r[c['Market Cap']]),
      country: meta?.country ?? null,
      company: meta?.company ?? null,
      sector: meta?.sector ?? null,
      industry: meta?.industry ?? null,
      // Insider/Inst Own & Trans, Short Float & Ratio, Shares Outstanding (returned in
      // millions like Float).
      shares_out_m:      sharesOut,
      insider_own_pct:   num(r[c['Insider Ownership']]),
      insider_trans_pct: num(r[c['Insider Transactions']]),
      inst_own_pct:      num(r[c['Institutional Ownership']]),
      inst_trans_pct:    num(r[c['Institutional Transactions']]),
      short_float_pct:   num(r[c['Short Float']]),
      short_ratio:       num(r[c['Short Ratio']]),
    });
  }
  return out;
}

// Rewrite a regular-session filter string for the after-hours screen:
//   ta_change_*  → ah_change_*   (screen on the after-hours move; same range
//                                 syntax, e.g. ta_change_20to → ah_change_20to)
//   sh_relvol_*  → dropped       (relative volume is a regular-session metric
//                                 Finviz freezes at the close)
// All other tokens (industry, price band, …) carry over unchanged.
function toAfterHoursFilter(filter: string): string {
  return filter
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !t.startsWith('sh_relvol'))
    .map((t) => (t.startsWith('ta_change_') ? `ah_change_${t.slice(10)}` : t))
    .join(',');
}

// Overlay live after-hours price/change/volume onto rows whose v=131 figures
// are frozen at the regular close. Uses the v=152 custom view:
//   c=1 Ticker · c=71 After-Hours Close · c=72 After-Hours Change · c=141 After-Hours Volume
// Best-effort: on any fetch failure or a missing per-ticker quote we keep the
// regular-session value rather than blanking the row.
async function applyAfterHoursQuotes(rows: ScreenerRow[]): Promise<void> {
  const url = screenerExportUrl(`v=152&t=${rows.map((r) => r.ticker).join(',')}&c=1,71,72,141`);
  let csv: string[][];
  try {
    csv = await fetchCsv(url);
  } catch {
    return;
  }
  const ah = parseAfterHoursQuotes(csv);
  for (const row of rows) {
    const q = ah.get(row.ticker);
    if (!q) continue;
    if (q.close != null) row.price = q.close;
    if (q.change != null) row.change_pct = q.change;
    if (q.volume != null) row.volume = q.volume;
  }
}

// The after-hours overlay's CSV → ticker → its after-hours close, change and volume. Header
// today: Ticker, After-Hours Close, After-Hours Change, After-Hours Volume (read by name, so a
// leading "No." doesn't move them).
export function parseAfterHoursQuotes(csv: string[][]): Map<string, { close: number | null; change: number | null; volume: number | null }> {
  const c = csvColumns(csv[0], { 'Ticker': 0, 'After-Hours Close': 1, 'After-Hours Change': 2, 'After-Hours Volume': 3 }, 'v=152 after-hours');
  const need = Math.max(...Object.values(c));
  const ah = new Map<string, { close: number | null; change: number | null; volume: number | null }>();
  for (let i = 1; i < csv.length; i++) {
    const r = csv[i];
    if (r.length <= need || !r[c.Ticker]) continue;
    ah.set(r[c.Ticker], { close: num(r[c['After-Hours Close']]), change: num(r[c['After-Hours Change']]), volume: num(r[c['After-Hours Volume']]) });
  }
  return ah;
}

// Live quotes for any tickers (2026-10-05: the 📐 setups that aren't on the
// Momentum screen, so the sidebar can show every setup's change %). One
// batched custom-view export: c=1 Ticker · c=65 Price · c=66 Change, and after
// hours c=71 After-Hours Close · c=72 After-Hours Change, matching the Momentum
// rows' after-hours overlay. Best-effort: a failed fetch returns an empty map.
export interface TickerQuote {
  price: number | null;
  change_pct: number | null;
}
export async function fetchQuotes(tickers: string[], afterHours: boolean): Promise<Map<string, TickerQuote>> {
  const out = new Map<string, TickerQuote>();
  if (tickers.length === 0) return out;
  const url = screenerExportUrl(`v=152&t=${tickers.map(encodeURIComponent).join(',')}&c=${afterHours ? '1,65,66,71,72' : '1,65,66'}`);
  let csv: string[][];
  try {
    csv = await fetchCsv(url);
  } catch {
    return out;
  }
  return parseQuotes(csv, afterHours);
}

// The quote export's CSV → ticker → price and change; after hours the after-hours close and
// change take their place where Finviz has them. Header today: Ticker, Price, Change[,
// After-Hours Close, After-Hours Change] (read by name).
export function parseQuotes(csv: string[][], afterHours: boolean): Map<string, TickerQuote> {
  const out = new Map<string, TickerQuote>();
  const c = csvColumns(csv[0], { Ticker: 0, Price: 1, Change: 2 }, 'v=152 quotes');
  const a = afterHours ? csvColumns(csv[0], { 'After-Hours Close': 3, 'After-Hours Change': 4 }, 'v=152 quotes') : null;
  const need = Math.max(c.Ticker, c.Price, c.Change);
  for (let i = 1; i < csv.length; i++) {
    const r = csv[i];
    if (r.length <= need || !r[c.Ticker]) continue;
    let price = num(r[c.Price]);
    let change = num(r[c.Change]);
    if (a && r.length > Math.max(a['After-Hours Close'], a['After-Hours Change'])) {
      price = num(r[a['After-Hours Close']]) ?? price;
      change = num(r[a['After-Hours Change']]) ?? change;
    }
    out.set(r[c.Ticker], { price, change_pct: change });
  }
  return out;
}

// Batch news fetch. Returns ticker → { title, url, published_at } where
// published_at is the Finviz date string (ET-local, no TZ).
export interface FinvizNewsItem {
  ticker: string;
  title: string;
  url: string;
  date: string; // raw "YYYY-MM-DD HH:MM:SS"
}

export async function fetchFinvizNews(tickers: string[], todayEt: string): Promise<FinvizNewsItem[]> {
  if (tickers.length === 0) return [];
  const t = tickers.join(',');
  const url = `${FINVIZ_BASE}/news_export?v=3&t=${t}&auth=${token()}`;
  let rows: string[][];
  try {
    rows = await fetchCsv(url);
  } catch {
    return [];
  }

  // header: Title, Source, Date, Url, Category, Ticker
  // Finviz tags aggregate articles (e.g. "BC-Most Active Stocks") with a
  // comma-joined Ticker field — split it so each link is a single ticker.
  const out: FinvizNewsItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 6) continue;
    const [title, , date, link, , tickerField] = r;
    if (!title || !tickerField) continue;
    if (todayEt && !date.startsWith(todayEt)) continue;
    const cleanTitle = title.replace(/[\t\n]/g, ' ').trim();
    for (const ticker of splitTickers(tickerField)) {
      out.push({ ticker, title: cleanTitle, url: link, date });
    }
  }
  return out;
}

// Split a (possibly comma-joined) Finviz Ticker field into individual,
// plausible tickers. Anything not ticker-shaped — a real ticker is 1–7 chars
// of A-Z/0-9 plus optional . or - — is dropped, which also keeps non-ticker
// junk out of the news_ticker_links table.
function splitTickers(field: string): string[] {
  return field
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z0-9][A-Z0-9.-]{0,6}$/.test(t));
}

// ─── daily-bar history ────────────────────────────────────────────────────

export interface DailyBar {
  date: string;   // YYYY-MM-DD (normalised from Finviz's MM/DD/YYYY)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Fetch a ticker's daily-bar history from Finviz `quote_export?p=d`. Header:
// `Date,Open,High,Low,Close,Volume`; date format `MM/DD/YYYY`; volume is a raw
// integer (no K/M scaling). Returns chronological-ascending bars; an empty
// array on either an empty body (unknown ticker / Finviz transient) or a row
// that can't be parsed.
export async function fetchFinvizDailyBars(ticker: string): Promise<DailyBar[]> {
  const url = `${FINVIZ_BASE}/quote_export?t=${encodeURIComponent(ticker)}&p=d&auth=${token()}`;
  let rows: string[][];
  try {
    rows = await fetchCsv(url);
  } catch {
    return [];
  }
  // Header + at least one bar.
  if (rows.length < 2) return [];

  const out: DailyBar[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 6) continue;
    const isoDate = normaliseDate(r[0]);
    if (!isoDate) continue;
    const open = num(r[1]);
    const high = num(r[2]);
    const low = num(r[3]);
    const close = num(r[4]);
    const volume = num(r[5]);
    if (open == null || high == null || low == null || close == null || volume == null) continue;
    out.push({ date: isoDate, open, high, low, close, volume });
  }
  return out;
}

// MM/DD/YYYY → YYYY-MM-DD. Returns null on anything that doesn't match.
function normaliseDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}
