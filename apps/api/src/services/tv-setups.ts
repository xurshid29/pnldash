// TradingView VWAP-setup signals (2026-10-03) — the operator's discretionary
// edge, detected by TradingView itself. A Pine v6 script
// (apps/web/src/tv/mvwap-bb-setup.pine) runs as ONE watchlist alert over the
// "runners" list (GET /api/tv/watchlist): a top gainer (day high ≥ +20% vs
// the prior close) whose price sits under the month-anchored VWAP while the
// Bollinger basis (SMA 20) curls up beneath it. Stages, each once per setup:
//   FORMING  basis 6–10% under mVWAP, rising, gap closing — open the chart
//   READY    basis ≤6% under mVWAP, rising, price holding the basis — entry zone
//   GO       the basis crosses above mVWAP (only after FORMING/READY)
// Script v10 (2026-10-05) adds a second setup to the same script, PULLBACK: a
// fast run stretches price well above the session or month VWAP and it comes
// back down to the line —
//   PULLBACK  a close back within ~5% above the line — be ready
//   BROKEN    a close under the line — the setup is over (the operator's exit)
//   HELD      price ran +10% from the PULLBACK close first
// tagged with the line (session / month / both) and the touch number. The
// operator rates the first pullback after the first big move highest; on our
// own data (research/vwap-pullback, 2026-10-05) touch 2 did as well.
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

export type TvStage = 'forming' | 'ready' | 'go' | 'pullback' | 'broken' | 'held';
// The PULLBACK setup's stages (script v10); the rest belong to the reclaim setup.
export const PULLBACK_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['pullback', 'broken', 'held']);
// Which VWAP a PULLBACK-setup message is about: 'both' = the session and month
// lines fired the same event on one bar (they sit close together early in a month).
export type TvLine = 'session' | 'month' | 'both';
// Which shape reached FORMING/READY (script v2+): 'base' = price consolidated
// until the basis converged under the line; 'fast' = price ran at the line
// while the basis lagged. Null for GO and for v1 / fallback messages.
export type TvPath = 'base' | 'fast';
// What triggered GO (script v5+): 'reclaim' = price closed decisively back above
// the line; 'cross' = the basis crossed above it. Null on FORMING/READY and older messages.
export type TvGoVia = 'reclaim' | 'cross';

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
  go_via: TvGoVia | null;
  vol_x: number | null;       // script v9+: signal bar volume ÷ average of the previous 20 bars
  run_pct: number | null;     // script v9+: close vs 10 bars earlier, %
  // PULLBACK setup only (script v10); null on the reclaim setup's messages.
  svwap?: number | null;      // session VWAP (anchor Session, 04:00 ET on an Extended chart)
  spx_pct?: number | null;    // price vs the session VWAP, %
  line?: TvLine | null;
  touch?: number | null;      // pullbacks to this line today, this one included
  peak_pct?: number | null;   // PULLBACK: highest bar high above the line before it, %
}

export const TV_SETUP = {
  dup_sec: 120,           // same ticker + stage + timeframe again within 2 min = a re-delivery → dropped
  notify_merge_sec: 300,  // same ticker + stage from another timeframe within 5 min → logged, not re-notified
  max_per_min: 120,       // flood guard: a leaked key or a runaway alert must not spam the phone
  // Priority (operator, 2026-10-04): a setup on a ticker that is on our Momentum
  // list right now is the one to act on — ⭐ and a normal (buzzing) Telegram push.
  // Off-list setups still go out, but as silent messages.
  offscreen_silent: true,
  // GO strength (operator, 2026-10-05: "how not to enter the weak ones?"). Each
  // GO is scored on four checks; the first two came out of the replay (§ GO
  // strength in docs/vwap-setup.md), volume is the classic breakout test and
  // is unvalidated until the live log is graded. A tag to read, not a filter.
  strength_window_et: [240, 630] as const,  // 04:00–10:30 ET: pre-market + first hour (8/8 strong in replay)
  strength_run_min: 5,    // % run-up over the previous 10 bars into the GO (16/18 strong vs 4/7 weak)
  strength_vol_min: 2,    // GO-bar volume at least 2× the previous-20-bar average
} as const;

export interface TvStrength {
  score: number;              // checks passed
  max: number;                // checks with data (volume/run-up need script v9)
  morning: boolean;
  run_up: boolean | null;     // null = no data
  volume: boolean | null;
  on_momentum: boolean;
}

function etMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return n('hour') * 60 + n('minute');
}

// Strength of a GO: morning window, a run-up into it, volume on the GO bar, and
// whether the ticker is on our Momentum list. Null for FORMING/READY.
export function goStrength(sig: TvSetupSignal, at: Date, onMomentum: boolean): TvStrength | null {
  if (sig.stage !== 'go') return null;
  const m = etMinutes(at);
  const morning = m >= TV_SETUP.strength_window_et[0] && m < TV_SETUP.strength_window_et[1];
  const runUp = sig.run_pct == null ? null : sig.run_pct >= TV_SETUP.strength_run_min;
  const volume = sig.vol_x == null ? null : sig.vol_x >= TV_SETUP.strength_vol_min;
  const checks = [morning, runUp, volume, onMomentum].filter((c): c is boolean => c !== null);
  return { score: checks.filter(Boolean).length, max: checks.length, morning, run_up: runUp, volume, on_momentum: onMomentum };
}

const STAGES: Record<string, TvStage> = {
  forming: 'forming', ready: 'ready', go: 'go', pullback: 'pullback', broken: 'broken', held: 'held',
};

function toLine(v: unknown): TvLine | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === 'session' || p === 'month' || p === 'both' ? p : null;
}

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
    go_via: toVia(o.go_via),
    vol_x: toNum(o.vol_x),
    run_pct: toNum(o.run_pct),
    svwap: toNum(o.svwap),
    spx_pct: toNum(o.spx_pct),
    line: toLine(o.line),
    touch: toNum(o.touch),
    peak_pct: toNum(o.peak_pct),
  };
}

function toVia(v: unknown): TvGoVia | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === 'reclaim' || p === 'cross' ? p : null;
}

function toPath(v: unknown): TvPath | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return p === 'base' || p === 'fast' ? p : null;
}

// The Pine script's alert() message (v2 appends the path on FORMING/READY;
// v3 adds the after-hours gain and writes a negative day high as "-2%"):
//   READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1 | path base
//   READY AMOD 1.38 | mVWAP 1.42 (-2.5%) | basis 1.35 (-4.6%) | day high +20% | ah +34% | tf 1 | path base
//   GO NIVF 0.1961 | mVWAP 0.188 (4.3%) | basis 0.169 (-10.1%) | day high +38% | tf 1 | via reclaim   (v5)
//   PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | tf 1   (v10)
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
  const head = /^(FORMING|READY|GO|PULLBACK|BROKEN|HELD)\s+([A-Za-z0-9_.:-]+)(?:\s+\$?(\d*\.?\d+))?/i.exec(text);
  if (!head) return null;
  const ticker = normTicker(head[2]);
  if (!ticker) return null;
  const line = (label: string) => new RegExp(`${label}\\s+\\$?(\\d*\\.?\\d+)\\s*\\(\\s*([-+]?\\d*\\.?\\d+)\\s*%\\s*\\)`, 'i').exec(text);
  const mv = line('mVWAP');
  const sv = line('sVWAP');
  const bb = line('basis');
  const day = /day\s+high\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);   // v1/v2 wrote "+-2%" for a negative day
  const ah = /\bah\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const tf = /\btf\s+([0-9A-Za-z]+)/i.exec(text);
  const path = /\bpath\s+(base|fast)\b/i.exec(text);
  const via = /\bvia\s+(reclaim|cross)\b/i.exec(text);
  const vol = /\bvol\s+(\d*\.?\d+)\s*x\b/i.exec(text);
  const run = /\brun\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const ln = /\bline\s+(session|month|both)\b/i.exec(text);
  const touch = /\btouch\s+(\d+)\b/i.exec(text);
  const peak = /\bpeak\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
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
    go_via: toVia(via?.[1]),
    vol_x: toNum(vol?.[1]),
    run_pct: toNum(run?.[1]),
    svwap: toNum(sv?.[1]),
    spx_pct: toNum(sv?.[2]),
    line: toLine(ln?.[1]),
    touch: toNum(touch?.[1]),
    peak_pct: toNum(peak?.[1]),
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

    // The line is part of the exact key: a PULLBACK on the month line two
    // minutes after one on the session line is a second event, not a re-delivery.
    const exact = `${sig.ticker}|${sig.stage}|${sig.tf ?? ''}|${sig.line ?? ''}`;
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

export const TV_STAGE_LABEL: Record<TvStage, string> = {
  forming: 'FORMING', ready: 'READY', go: 'GO', pullback: 'PULLBACK', broken: 'BROKEN', held: 'HELD',
};
const STAGE_ICON: Record<TvStage, string> = { forming: '🟡', ready: '🟠', go: '🟢', pullback: '↩️', broken: '✖️', held: '✅' };
const STAGE_HINT: Record<TvStage, string> = {
  forming: 'setup forming — open the chart',
  ready: 'entry zone',
  go: 'basis crossed above mVWAP',
  pullback: 'back near VWAP after the run — be ready',
  broken: 'closed under VWAP — setup broken',
  held: 'held — ran +10% from the pullback',
};
const LINE_NAME: Record<TvLine, string> = { session: 'session VWAP', month: 'month VWAP', both: 'session + month VWAP' };

// "touch 1 (first)" — the operator rates the first pullback after the first big move highest.
export function touchText(touch: number | null | undefined): string {
  return touch == null ? '' : `touch ${touch}${touch === 1 ? ' (first)' : ''}`;
}

function fmtPx(p: number | null): string {
  return p == null ? '' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}
function fmtSigned(p: number | null): string {
  return p == null ? '?' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// Telegram message. `tvSym` is the exchange-qualified chart symbol (edgar.tvSymbol)
// and `row` the Momentum row when the ticker is on our screen right now — those
// get ⭐ and an "on Momentum" line (they are the priority signals).
export function formatTvSetupAlert(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
  strength: TvStrength | null = null,
): string {
  const pb = PULLBACK_STAGES.has(sig.stage);
  // PULLBACK / BROKEN name the line: "back near the session VWAP after the run — be ready"
  const hint = sig.stage === 'go' && sig.go_via === 'reclaim' ? 'price reclaimed mVWAP'
    : pb && sig.line && sig.stage !== 'held' ? STAGE_HINT[sig.stage].replace('VWAP', `the ${LINE_NAME[sig.line]}`)
      : STAGE_HINT[sig.stage];
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${hint}${sig.path === 'fast' ? ' · fast approach (price leads, basis lagging)' : ''}</i>`,
  ];
  if (pb) {
    const what = [touchText(sig.touch)];
    if (sig.stage === 'pullback' && sig.peak_pct != null) what.push(`ran +${Math.round(sig.peak_pct)}% above the line first`);
    if (what.some(Boolean)) lines.push(what.filter(Boolean).join(' · '));
  }
  const lvl: string[] = [];
  if (sig.svwap != null) lvl.push(`sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})`);
  if (sig.mvwap != null) lvl.push(`mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})`);
  if (sig.basis != null) lvl.push(`basis ${fmtPx(sig.basis)} (${fmtSigned(sig.basis_pct)})`);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  if (row) {
    const mom = ['⭐ <b>on Momentum</b>'];
    if (row.grade) mom.push(`grade ${escapeHtml(row.grade)}`);
    if (row.change_pct != null) mom.push(`now ${fmtSigned(row.change_pct)}`);
    if (row.float_m != null) mom.push(`float ${row.float_m.toFixed(1)}M`);
    lines.push(mom.join(' · '));
  } else {
    lines.push('<i>not on our Momentum list</i>');
  }
  if (strength) lines.push(strengthLine(strength, sig));
  const ctx: string[] = [];
  if (sig.day_gain != null) ctx.push(`day high ${fmtSigned(Math.round(sig.day_gain)).replace('.0%', '%')}`);
  if (sig.ah_gain != null) ctx.push(`after hours ${fmtSigned(Math.round(sig.ah_gain)).replace('.0%', '%')}`);
  if (sig.tf) ctx.push(`tf ${escapeHtml(sig.tf)}`);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(sig.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  lines.push(`<a href="${tv}">TradingView</a> · <a href="${finviz}">Finviz</a>`);
  return lines.join('\n');
}

// "💪 GO strength 3/4 · morning ✓ · run-up +8.1% ✓ · volume 3.2× ✓ · on Momentum ✗"
export function strengthLine(st: TvStrength, sig: TvSetupSignal): string {
  const mark = (b: boolean | null) => (b ? '✓' : '✗');
  const parts = [`💪 <b>GO strength ${st.score}/${st.max}</b>`, `morning ${mark(st.morning)}`];
  if (st.run_up !== null) parts.push(`run-up ${fmtSigned(sig.run_pct)} ${mark(st.run_up)}`);
  if (st.volume !== null) parts.push(`volume ${sig.vol_x!.toFixed(1)}× ${mark(st.volume)}`);
  parts.push(`on Momentum ${mark(st.on_momentum)}`);
  return parts.join(' · ');
}
