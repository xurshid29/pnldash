// TradingView VWAP-setup signals (2026-10-03) — the operator's discretionary
// edge, detected by TradingView itself. A Pine v6 script
// (apps/web/src/tv/mvwap-bb-setup.pine) runs as ONE watchlist alert over the
// "runners" list (GET /api/tv/watchlist): a top gainer (day high ≥ +20% vs
// the prior close) whose price sits under the month-anchored VWAP while the
// Bollinger basis (SMA 20) curls up beneath it. Stages, each once per setup:
//   FORMING  basis 6–10% under mVWAP, rising, gap closing — open the chart
//   READY    basis ≤6% under mVWAP, rising, price holding the basis — entry zone
//   GO       the basis crosses above mVWAP (only after FORMING/READY)
//
// Why TradingView computes it and we don't: the line is a VWAP anchored at the
// 1st of the month INCLUDING pre-market volume. Yahoo's extended-hours bars
// carry zero volume, and our Finviz snapshots start only when a name reaches
// the screen — our own line cannot match the chart the operator trades.
//
// The alert's webhook posts the message to POST /api/tv/webhook (routes/tv.ts).
// This module parses it and gates duplicates; the poller delivers it like any
// opportunity alert (tier_events tier='alert' event='tv_setup', payload.alerts,
// an immediate SSE 'alert' event, Telegram) so every stage can be graded later
// against what the price did next.

import { escapeHtml } from './telegram.js';

export type TvStage = 'forming' | 'ready' | 'go';
// Which shape reached FORMING/READY (script v2+): 'base' = price consolidated
// until the basis converged under the line; 'fast' = price ran at the line
// while the basis lagged. Null for GO and for v1 / fallback messages.
export type TvPath = 'base' | 'fast';

export interface TvSetupSignal {
  stage: TvStage;
  ticker: string;
  price: number | null;
  mvwap: number | null;
  px_pct: number | null;      // price vs mVWAP, % (negative = under the line)
  basis: number | null;
  basis_pct: number | null;   // BB basis vs mVWAP, %
  day_gain: number | null;    // day high vs the prior close, %
  ah_gain: number | null;     // after hours only (script v3+): high since today's close, %
  tf: string | null;          // TradingView interval: "1", "2", "30S", …
  path: TvPath | null;
}

export const TV_SETUP = {
  dup_sec: 120,           // same ticker + stage + timeframe again within 2 min = a re-delivery → dropped
  notify_merge_sec: 300,  // same ticker + stage from another timeframe within 5 min → logged, not re-notified
  max_per_min: 120,       // flood guard: a leaked key or a runaway alert must not spam the phone
} as const;

const STAGES: Record<string, TvStage> = { forming: 'forming', ready: 'ready', go: 'go' };

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// "NASDAQ:AIXI" / "aixi" → "AIXI"; anything that isn't a plausible US ticker → null.
export function normTicker(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase().replace(/^[A-Z_]+:/, '');
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(t) ? t : null;
}

function fromJson(o: Record<string, unknown>): TvSetupSignal | null {
  const stage = typeof o.stage === 'string' ? STAGES[o.stage.trim().toLowerCase()] : undefined;
  const ticker = normTicker(o.ticker);
  if (!stage || !ticker) return null;
  return {
    stage, ticker,
    price: toNum(o.price),
    mvwap: toNum(o.mvwap),
    px_pct: toNum(o.px_pct),
    basis: toNum(o.basis),
    basis_pct: toNum(o.basis_pct),
    day_gain: toNum(o.day_gain),
    ah_gain: toNum(o.ah_gain),
    tf: typeof o.tf === 'string' || typeof o.tf === 'number' ? String(o.tf) : null,
    path: toPath(o.path),
  };
}

function toPath(v: unknown): TvPath | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === 'base' || p === 'fast' ? p : null;
}

// The Pine script's alert() message (v2 appends the path on FORMING/READY;
// v3 adds the after-hours gain and writes a negative day high as "-2%"):
//   READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1 | path base
//   READY AMOD 1.38 | mVWAP 1.42 (-2.5%) | basis 1.35 (-4.6%) | day high +20% | ah +34% | tf 1 | path base
// its alertcondition() fallback:   READY AIXI 1.48 | tf 1
// or a JSON object with the TvSetupSignal field names. Express hands us the
// raw text for text/plain bodies and an already-parsed object for JSON ones.
export function parseTvMessage(body: unknown): TvSetupSignal | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) return fromJson(body as Record<string, unknown>);
  if (typeof body !== 'string') return null;
  const text = body.replace(/−/g, '-').trim();
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as unknown;
      return o && typeof o === 'object' && !Array.isArray(o) ? fromJson(o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const head = /^(FORMING|READY|GO)\s+([A-Za-z0-9_.:-]+)(?:\s+\$?(\d*\.?\d+))?/i.exec(text);
  if (!head) return null;
  const ticker = normTicker(head[2]);
  if (!ticker) return null;
  const line = (label: string) => new RegExp(`${label}\\s+\\$?(\\d*\\.?\\d+)\\s*\\(\\s*([-+]?\\d*\\.?\\d+)\\s*%\\s*\\)`, 'i').exec(text);
  const mv = line('mVWAP');
  const bb = line('basis');
  const day = /day\s+high\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);   // v1/v2 wrote "+-2%" for a negative day
  const ah = /\bah\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const tf = /\btf\s+([0-9A-Za-z]+)/i.exec(text);
  const path = /\bpath\s+(base|fast)\b/i.exec(text);
  return {
    stage: STAGES[head[1].toLowerCase()],
    ticker,
    price: toNum(head[3]),
    mvwap: toNum(mv?.[1]),
    px_pct: toNum(mv?.[2]),
    basis: toNum(bb?.[1]),
    basis_pct: toNum(bb?.[2]),
    day_gain: toNum(day?.[1]),
    ah_gain: toNum(ah?.[1]),
    tf: tf?.[1] ?? null,
    path: toPath(path?.[1]),
  };
}

// Duplicate + flood gate. TradingView can deliver the same alert twice, and an
// operator running the watchlist alert on two timeframes (1m and 2m) gets the
// same stage twice: the first notifies, the second is only logged.
export type TvVerdict = 'notify' | 'log' | 'drop' | 'flood';

export class TvSetupGate {
  private lastExact = new Map<string, number>();   // ticker|stage|tf → epoch sec
  private lastNotify = new Map<string, number>();  // ticker|stage → epoch sec
  private recent: number[] = [];

  admit(sig: TvSetupSignal, nowSec: number): TvVerdict {
    this.recent = this.recent.filter((t) => nowSec - t < 60);
    if (this.recent.length >= TV_SETUP.max_per_min) return 'flood';
    this.recent.push(nowSec);
    for (const [k, t] of this.lastExact) if (nowSec - t > 600) this.lastExact.delete(k);
    for (const [k, t] of this.lastNotify) if (nowSec - t > 600) this.lastNotify.delete(k);

    const exact = `${sig.ticker}|${sig.stage}|${sig.tf ?? ''}`;
    const prev = this.lastExact.get(exact);
    if (prev != null && nowSec - prev < TV_SETUP.dup_sec) return 'drop';
    this.lastExact.set(exact, nowSec);

    const key = `${sig.ticker}|${sig.stage}`;
    const prevNotify = this.lastNotify.get(key);
    if (prevNotify != null && nowSec - prevNotify < TV_SETUP.notify_merge_sec) return 'log';
    this.lastNotify.set(key, nowSec);
    return 'notify';
  }
}

export const TV_STAGE_LABEL: Record<TvStage, string> = { forming: 'FORMING', ready: 'READY', go: 'GO' };
const STAGE_ICON: Record<TvStage, string> = { forming: '🟡', ready: '🟠', go: '🟢' };
const STAGE_HINT: Record<TvStage, string> = {
  forming: 'setup forming — open the chart',
  ready: 'entry zone',
  go: 'basis crossed above mVWAP',
};

function fmtPx(p: number | null): string {
  return p == null ? '' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}
function fmtSigned(p: number | null): string {
  return p == null ? '?' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// Telegram message. `tvSym` is the exchange-qualified chart symbol (edgar.tvSymbol)
// and `row` the Momentum row when the ticker is on our screen right now.
export function formatTvSetupAlert(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const lines = [
    `📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${STAGE_HINT[sig.stage]}${sig.path === 'fast' ? ' · fast approach (price leads, basis lagging)' : ''}</i>`,
  ];
  const lvl: string[] = [];
  if (sig.mvwap != null) lvl.push(`mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})`);
  if (sig.basis != null) lvl.push(`basis ${fmtPx(sig.basis)} (${fmtSigned(sig.basis_pct)})`);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  const ctx: string[] = [];
  if (sig.day_gain != null) ctx.push(`day high ${fmtSigned(Math.round(sig.day_gain)).replace('.0%', '%')}`);
  if (sig.ah_gain != null) ctx.push(`after hours ${fmtSigned(Math.round(sig.ah_gain)).replace('.0%', '%')}`);
  if (row?.change_pct != null) ctx.push(`now ${fmtSigned(row.change_pct)}`);
  if (row?.grade) ctx.push(`grade ${escapeHtml(row.grade)}`);
  if (row?.float_m != null) ctx.push(`float ${row.float_m.toFixed(1)}M`);
  if (sig.tf) ctx.push(`tf ${escapeHtml(sig.tf)}`);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(sig.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  lines.push(`<a href="${tv}">TradingView</a> · <a href="${finviz}">Finviz</a>`);
  return lines.join('\n');
}
