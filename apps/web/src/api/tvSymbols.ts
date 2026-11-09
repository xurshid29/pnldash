// Unambiguous TradingView chart links (the SPRO lesson, 2026-07-24: TV
// resolved the bare symbol to CBOE's "S&P 500 Buffer Protect Index" instead
// of the Nasdaq stock). The API serves SEC's Nasdaq-listed ticker set; those
// get an explicit NASDAQ: prefix. Everything else stays bare — SEC lumps
// NYSE American/Arca under "NYSE" while TV files those under AMEX:, so a
// blind prefix would break Arca names. Loads lazily on first link render;
// links are bare until the set arrives and upgrade on the next re-render.
import { apiClient } from './client';

let nasdaq: Set<string> | null = null;
let pending: Promise<Set<string>> | null = null;

function load(): Promise<Set<string>> {
  if (nasdaq) return Promise.resolve(nasdaq);
  pending ??= apiClient.get<string[]>('/api/screener/tv-map')
    .then((r) => (nasdaq = new Set(r.data ?? [])))
    .catch((err: unknown) => { pending = null; throw err; });   // retry on a later call
  return pending;
}

function ensureLoaded(): void {
  if (!nasdaq) load().catch(() => { /* retry on a later render */ });
}

function tvSym(ticker: string): string {
  const t = ticker.toUpperCase();
  return nasdaq?.has(t) ? `NASDAQ:${t}` : t;
}

export function tvChartUrl(ticker: string): string {
  ensureLoaded();
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym(ticker))}`;
}

// A list for a TradingView watchlist (Momentum's Copy, 2026-11-09), the same rule as the
// 📐 sidebar's server-built list. Waits for the Nasdaq set; bare symbols if it can't load.
export async function tvSymbols(tickers: string[]): Promise<string[]> {
  await load().catch(() => null);
  return tickers.map(tvSym);
}
