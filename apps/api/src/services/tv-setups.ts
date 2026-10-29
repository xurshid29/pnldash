// TradingView VWAP-setup signals (2026-10-03) — the operator's discretionary
// edge, detected by TradingView itself. A Pine v6 script
// (apps/web/src/tv/mvwap-bb-setup.pine) runs as two watchlist alerts (1m + 30s)
// over the "runners" list (GET /api/tv/watchlist). Since script v27 (2026-10-28)
// it carries two setups, the ones the operator kept after trying all four:
// PULLBACK (script v10): a fast run stretches price well above the session,
// month or year VWAP and it comes back down to the line —
//   PULLBACK  a close back within ~5% above the line — be ready
//   BROKEN    a close under the line — the setup is over (the operator's exit)
//   HELD      price ran +10% from the PULLBACK close first
// tagged with the line (session / month / year, or several) and the touch
// number. The operator rates the first pullback after the first big move
// highest; on our own data (research/vwap-pullback, 2026-10-05) touch 2 did as well.
// The VWAP + BB cross (script v21): one candle of a timeframe the operator picks
// (5m, 1h, …) crosses over both a VWAP line (session; v22 also month and year)
// and the upper BB of another timeframe (45s, 2m, 30m, …) — CROSS, sent from the
// 30s alert the moment a 30s close inside the candle is above both lines. v25 adds
// its trigger: LEVEL when the candle closes, BREAK when price takes its high.
// v27 removed the RECLAIM setup (FORMING / READY / GO, v1–v26) and the BB breakout
// (TOUCH / BREAKOUT / TRIGGERED, v17–v26); their rows stay in tier_events, and a
// message of theirs is now rejected as unrecognised (400).
//
// Why TradingView computes it and we don't: the lines are VWAPs anchored at the
// session, month and year INCLUDING pre-market volume. Yahoo's extended-hours bars
// carry zero volume, and our Finviz snapshots start only when a name reaches
// the screen — our own line cannot match the chart the operator trades.
//
// The alert's webhook posts the message to POST /api/tv/webhook (routes/tv.ts).
// This module parses it and gates duplicates; the poller delivers it like any
// opportunity alert (tier_events tier='alert' event='tv_setup', payload.alerts,
// an immediate SSE 'alert' event, Telegram) so every stage can be graded later
// against what the price did next.

import { escapeHtml } from './telegram.js';

export type TvStage = 'pullback' | 'broken' | 'held' | 'cross' | 'level' | 'break';
// The PULLBACK setup's stages (script v10).
export const PULLBACK_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['pullback', 'broken', 'held']);
// The VWAP + BB cross (script v21): one stage, CROSS, on the candle timeframe's
// session VWAP — v21 messages name no line — and since v22 also on the month and
// year VWAPs (`line session|month|year`, combined like PULLBACK's). Stored as
// tier_events event 'tv_setup' and announced behind the ⚙ stage switch and the cap.
// v25 adds its trigger: LEVEL when a VB candle closes (its high = the buy stop, its
// low = the stop; stored, never announced) and BREAK when price reaches that high
// (announced like CROSS, its own ⚙ switch).
export const VB_STAGES: ReadonlySet<TvStage> = new Set<TvStage>(['cross', 'level', 'break']);
// Which VWAP line(s) a message is about: session / month / year (v14). Lines
// that fired the same stage on one bar are named together in script order,
// e.g. "session+month". The legacy 'both' (v10–v13) meant session + month.
export type TvLineName = 'session' | 'month' | 'year';
export type TvLine = TvLineName | 'both' | 'session+month' | 'session+year' | 'month+year' | 'session+month+year';
const LINE_ORDER: TvLineName[] = ['session', 'month', 'year'];

// The individual lines of a message; a VB message without a line (v21) is the session line.
export function lineTokens(stage: TvStage, line: TvLine | null | undefined): TvLineName[] {
  if (!line) return VB_STAGES.has(stage) ? ['session'] : [];
  if (line === 'both') return ['session', 'month'];
  return line.split('+') as TvLineName[];
}

export interface TvSetupSignal {
  stage: TvStage;
  ticker: string;
  price: number | null;
  mvwap: number | null;
  px_pct: number | null;      // price vs mVWAP, % (negative = under the line)
  day_gain: number | null;    // day high vs the prior close, %
  ah_gain: number | null;     // after hours only (script v3+): high since today's close, %
  tf: string | null;          // TradingView interval: "1", "2", "30S", …
  vol_x: number | null;       // script v9+: signal bar volume ÷ average of the previous 20 bars
  run_pct: number | null;     // script v9+: close vs 10 bars earlier, %
  svwap?: number | null;      // session VWAP (anchor Session, 04:00 ET on an Extended chart)
  spx_pct?: number | null;    // price vs the session VWAP, %
  yvwap?: number | null;      // year VWAP (script v11; v14 from this year's hourly bars)
  ypx_pct?: number | null;    // price vs the year VWAP, %
  line?: TvLine | null;       // null on a v21 CROSS = the session line
  // PULLBACK setup (script v10)
  touch?: number | null;      // pullbacks to this line today, this one included
  fails?: number | null;      // script v16+, PULLBACK: failed pullbacks on the line before this one (null = older script, which capped itself)
  peak_pct?: number | null;   // PULLBACK: highest bar high above the line before it, %
  // VWAP + BB cross (script v21): svwap / upper are the candle timeframe's session
  // VWAP and the BB timeframe's upper band at the 30s close that crossed.
  upper?: number | null;      // the BB timeframe's upper band at the cross
  upper_pct?: number | null;  // price vs that band, %
  candle_tf?: string | null;  // the candle's timeframe: "5", "60", …
  bb_tf?: string | null;      // the band's timeframe: "2", "45S", …
  candle_open?: number | null; // the candle's open
  cross_n?: number | null;    // the day's crosses on this ticker, this one included
  // VB break (script v25)
  level?: number | null;      // LEVEL / BREAK: the VB candle's high, the trigger
  stop?: number | null;       // LEVEL / BREAK: the VB candle's low
  break_n?: number | null;    // BREAK: the day's breaks on this ticker, this one included
}

export const TV_SETUP = {
  dup_sec: 120,           // same ticker + stage + timeframe again within 2 min = a re-delivery → dropped
  notify_merge_sec: 300,  // same event from another timeframe within 5 min → logged; one announcement per ticker + stage (PULLBACK: per line) per 5 min
  max_per_min: 120,       // flood guard: a leaked key or a runaway alert must not spam the phone
  // Noise cut (operator, 2026-10-05: "I hide broken, held … setups"). Quiet
  // stages are stored, graded and shown in the 📐 sidebar, but never announced:
  // no toast, sound, browser notification or Telegram. This is the DEFAULT;
  // since 2026-10-06 the live set is the ⚙ menu's stage switches
  // (app_settings 'tv_alert_stages', TvSetupGate.setAnnounced).
  quiet_stages: ['broken', 'held'] as readonly TvStage[],
  // The PULLBACK cap moved here from the script in v16 (2026-10-10): past
  // pb_cap failed pullbacks on a line (BROKEN or straight through, the
  // message's `fails`), a PULLBACK is quiet — unless the ticker is on our
  // Momentum list at grade pb_cap_exempt or better (operator's trial after
  // WFF 10-09 and BIYA 10-07; on the session line, capped touches averaged
  // −0.64%, the B+ ones +0.90% on n 17 in October). Grade ~10-24.
  pb_cap: 2,
  pb_cap_exempt: 'B+' as string,
  // VWAP + BB cross (script v21). The script sends one CROSS per candle from the
  // 30s alert alone, so there's no other timeframe's copy to merge and a cross on
  // the next candle is a real event: only a re-delivery inside this window drops.
  vb_dup_sec: 20,
  // Past this many crosses on a ticker in a day (the message's `cross N`), a CROSS
  // is stored and shown, not announced — a name chopping around VWAP crosses on
  // candle after candle. Untested: grade with the first live weeks.
  vb_cap: 3,
  // A CROSS is announced only for a ticker on our Momentum list, like GO
  // (operator, 2026-10-20: the first morning announced 20–25 an hour on the
  // session line alone, 4–5 of them on Momentum). Off-list crosses are quiet:
  // stored, graded and shown dimmed in the 📐 sidebar.
  vb_momentum_only: true,
  // …except a runner our 20-s screen hasn't caught yet (operator, 2026-10-21:
  // RBNE reached the screen at 04:00:34 ET and WHLR at 04:01:14, after the 30s bar
  // that crossed): a message saying the day high is at least this % still announces.
  // On 10-20 that would have added 18 off-list crosses on 11 tickers.
  vb_fresh_gain: 30,
  // A v25 BREAK follows the same rules (its own ⚙ switch, Momentum or fresh, vb_cap on
  // its own `break N`); a LEVEL is stored and shown in the sidebar, never announced.
  // Priority (operator, 2026-10-04): a setup on a ticker that is on our Momentum
  // list right now is the one to act on — ⭐ and a normal (buzzing) Telegram push.
  // Off-list setups still go out, but as silent messages.
  offscreen_silent: true,
} as const;

const STAGES: Record<string, TvStage> = {
  pullback: 'pullback', broken: 'broken', held: 'held', cross: 'cross', level: 'level', break: 'break',
};

// v16: a PULLBACK past the day's cap on every line it names. Older scripts
// (no `fails`) capped themselves, so they're never capped here.
// v21: a CROSS past the day's TV_SETUP.vb_cap crosses on its ticker.
export function pastCap(sig: TvSetupSignal): boolean {
  if (sig.stage === 'cross') return sig.cross_n != null && sig.cross_n > TV_SETUP.vb_cap;
  if (sig.stage === 'break') return sig.break_n != null && sig.break_n > TV_SETUP.vb_cap;
  return sig.stage === 'pullback' && sig.fails != null && sig.fails >= TV_SETUP.pb_cap;
}

// The VWAP + BB cross's fields (CROSS v21; LEVEL / BREAK v25) for the alert's setup info and
// its tier_events row; none on other stages.
export function vbFields(sig: TvSetupSignal): {
  upper?: number | null; upper_pct?: number | null; candle_tf?: string | null; bb_tf?: string | null;
  candle_open?: number | null; cross_n?: number | null; level?: number | null; stop?: number | null; break_n?: number | null;
} {
  if (sig.stage === 'cross') {
    return {
      upper: sig.upper ?? null, upper_pct: sig.upper_pct ?? null, candle_tf: sig.candle_tf ?? null,
      bb_tf: sig.bb_tf ?? null, candle_open: sig.candle_open ?? null, cross_n: sig.cross_n ?? null,
    };
  }
  if (sig.stage === 'level' || sig.stage === 'break') {
    return {
      level: sig.level ?? null, stop: sig.stop ?? null, candle_tf: sig.candle_tf ?? null, bb_tf: sig.bb_tf ?? null,
      break_n: sig.break_n ?? null,
    };
  }
  return {};
}

const GRADE_LADDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C', 'D'];
// "B+" or better, by the Momentum grade ladder.
export function gradeAtLeast(grade: string | null | undefined, min: string): boolean {
  const g = grade == null ? -1 : GRADE_LADDER.indexOf(grade);
  return g >= 0 && g <= GRADE_LADDER.indexOf(min);
}

// Every stage, in the order the ⚙ menu lists them, and the stages announced
// until the operator changes the switches.
export const TV_STAGE_ORDER: readonly TvStage[] = ['pullback', 'cross', 'break', 'broken', 'held'];
export const DEFAULT_ANNOUNCED: readonly TvStage[] = TV_STAGE_ORDER.filter((s) => !TV_SETUP.quiet_stages.includes(s));

// A stored or posted stage list → known stages in menu order; null if it isn't a list.
// A stage v27 removed (forming / ready / go) is dropped.
export function parseStageList(v: unknown): TvStage[] | null {
  if (!Array.isArray(v)) return null;
  const wanted = new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()));
  return TV_STAGE_ORDER.filter((s) => wanted.has(s));
}

function toLine(v: unknown): TvLine | null {
  const p = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (p === 'both') return 'both';
  const parts = new Set(p.split('+').map((x) => x.trim()));
  const tokens = LINE_ORDER.filter((t) => parts.has(t));
  return tokens.length > 0 && tokens.length === parts.size ? (tokens.join('+') as TvLine) : null;
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
    day_gain: toNum(o.day_gain),
    ah_gain: toNum(o.ah_gain),
    tf: typeof o.tf === 'string' || typeof o.tf === 'number' ? String(o.tf) : null,
    vol_x: toNum(o.vol_x),
    run_pct: toNum(o.run_pct),
    svwap: toNum(o.svwap),
    spx_pct: toNum(o.spx_pct),
    yvwap: toNum(o.yvwap),
    ypx_pct: toNum(o.ypx_pct),
    line: toLine(o.line),
    touch: toNum(o.touch),
    peak_pct: toNum(o.peak_pct),
    fails: toNum(o.fails),
    upper: toNum(o.upper),
    upper_pct: toNum(o.upper_pct),
    candle_tf: toTf(o.candle_tf ?? o.candle),
    bb_tf: toTf(o.bb_tf ?? o.bb),
    candle_open: toNum(o.candle_open ?? o.open),
    cross_n: toNum(o.cross_n ?? o.cross),
    level: toNum(o.level),
    stop: toNum(o.stop),
    break_n: toNum(o.break_n),
  };
}

function toTf(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^[0-9]+[A-Za-z]?$/.test(s) ? s.toUpperCase() : null;
}

// The Pine script's alert() message:
//   PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | tf 1   (v10)
//   PULLBACK MI 5.31 | sVWAP 4.67 (+13.7%) | mVWAP 4.65 (+14.2%) | yVWAP 5.2 (+2.1%) | line year | touch 1 | peak +27% | tf 1   (v14)
//   PULLBACK WFF 3.53 | sVWAP 3.12 (+13.1%) | mVWAP 3.11 (+13.5%) | yVWAP 3.39 (+4.1%) | line year | touch 4 | fails 2 | peak +45% | tf 30S   (v16)
//   CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | upper 2.58 (+1.2%) | open 2.5 | candle 5 | bb 2 | cross 1 | day high +25% | vol 1.8x | tf 30S   (v21)
//   CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | mVWAP 2.55 (+2.4%) | yVWAP 3.1 (-15.8%) | upper 2.58 (+1.2%) | open 2.5 | line session+month | candle 5 | bb 2 | cross 1 | … | tf 30S   (v22)
//   LEVEL TANH 12.48 | level 12.59 | stop 11.8 | sVWAP 12.1 (+3.1%) | … | line month | candle 10 | bb 2 | tf 30S   (v25)
//   BREAK TANH 12.6 | level 12.59 | stop 11.8 | … | line month | candle 10 | bb 2 | break 1 | day high +60% | tf 30S   (v25)
// (a negative day high is written "-2%"; scripts before v3 wrote "+-2%"), or a JSON
// object with the TvSetupSignal field names. Express hands us the raw text for
// text/plain bodies and an already-parsed object for JSON ones.
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
  const head = /^(PULLBACK|BROKEN|HELD|CROSS|LEVEL|BREAK)\s+([A-Za-z0-9_.:-]+)(?:\s+\$?(\d*\.?\d+))?/i.exec(text);
  if (!head) return null;
  const ticker = normTicker(head[2]);
  if (!ticker) return null;
  const line = (label: string) => new RegExp(`${label}\\s+\\$?(\\d*\\.?\\d+)\\s*\\(\\s*([-+]?\\d*\\.?\\d+)\\s*%\\s*\\)`, 'i').exec(text);
  const mv = line('mVWAP');
  const sv = line('sVWAP');
  const yv = line('yVWAP');
  const up = line('upper');
  const day = /day\s+high\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);   // v1/v2 wrote "+-2%" for a negative day
  const ah = /\bah\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const tf = /\btf\s+([0-9A-Za-z]+)/i.exec(text);
  const vol = /\bvol\s+(\d*\.?\d+)\s*x\b/i.exec(text);
  const run = /\brun\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const ln = /\bline\s+((?:session|month|year)(?:\+(?:session|month|year)){0,2}|both)\b/i.exec(text);
  const touch = /\btouch\s+(\d+)\b/i.exec(text);
  const fails = /\bfails\s+(\d+)\b/i.exec(text);
  const peak = /\bpeak\s+\+?(-?\d*\.?\d+)\s*%/i.exec(text);
  const stop = /\bstop\s+\$?(\d*\.?\d+)/i.exec(text);
  // v21 fields, read after a "|" so a ticker can't pass for one (BB, OPEN).
  const candle = /\|\s*candle\s+([0-9]+[A-Za-z]?)\b/i.exec(text);
  const bbTf = /\|\s*bb\s+([0-9]+[A-Za-z]?)\b/i.exec(text);
  const open = /\|\s*open\s+\$?(\d*\.?\d+)/i.exec(text);
  const crossN = /\|\s*cross\s+(\d+)\b/i.exec(text);
  const level = /\|\s*level\s+\$?(\d*\.?\d+)/i.exec(text);     // v25
  const breakN = /\|\s*break\s+(\d+)\b/i.exec(text);
  return {
    stage: STAGES[head[1].toLowerCase()],
    ticker,
    price: toNum(head[3]),
    mvwap: toNum(mv?.[1]),
    px_pct: toNum(mv?.[2]),
    day_gain: toNum(day?.[1]),
    ah_gain: toNum(ah?.[1]),
    tf: tf?.[1] ?? null,
    vol_x: toNum(vol?.[1]),
    run_pct: toNum(run?.[1]),
    svwap: toNum(sv?.[1]),
    spx_pct: toNum(sv?.[2]),
    yvwap: toNum(yv?.[1]),
    ypx_pct: toNum(yv?.[2]),
    line: toLine(ln?.[1]),
    touch: toNum(touch?.[1]),
    peak_pct: toNum(peak?.[1]),
    fails: toNum(fails?.[1]),
    upper: toNum(up?.[1]),
    upper_pct: toNum(up?.[2]),
    candle_tf: toTf(candle?.[1]),
    bb_tf: toTf(bbTf?.[1]),
    candle_open: toNum(open?.[1]),
    cross_n: toNum(crossN?.[1]),
    level: toNum(level?.[1]),
    stop: toNum(stop?.[1]),
    break_n: toNum(breakN?.[1]),
  };
}

// Duplicate + flood gate, and which signals get announced. TradingView can
// deliver the same alert twice, and the watchlist alert runs on two timeframes
// (1m and 30s), so one event arrives twice: the first copy counts, the second
// is only logged. A first copy is then 'quiet' (stored and shown in the 📐
// sidebar, not announced) for a stage switched off in the ⚙ menu, a PULLBACK
// past the cap, or a CROSS / BREAK off our Momentum list, else announced — a
// PULLBACK at most once per ticker and line per 5 min; the rest are logged.
export type TvVerdict = 'notify' | 'quiet' | 'log' | 'drop' | 'flood';

export class TvSetupGate {
  private lastExact = new Map<string, number>();   // ticker|stage|tf|line → epoch sec
  private lastEvent = new Map<string, number>();   // ticker|stage|line → epoch sec of the event's first copy
  private lastNotify = new Map<string, number>();  // ticker|stage (PULLBACK: ticker|pullback|line) → last announcement
  private announced = new Set<TvStage>(DEFAULT_ANNOUNCED);  // the ⚙ stage switches
  private recent: number[] = [];

  setAnnounced(stages: readonly TvStage[]): void {
    this.announced = new Set(stages);
  }

  announcedStages(): TvStage[] {
    return TV_STAGE_ORDER.filter((s) => this.announced.has(s));
  }

  announces(stage: TvStage): boolean {
    return this.announced.has(stage);
  }

  // `capExempt`: a PULLBACK past the cap may still announce (v16 — the caller
  // knows the ticker's Momentum row and grade). `onMomentum`: the ticker is on
  // our Momentum list now; off it, a CROSS or BREAK is quiet (vb_momentum_only)
  // unless its day high is ≥ vb_fresh_gain %.
  admit(sig: TvSetupSignal, nowSec: number, capExempt = false, onMomentum = true): TvVerdict {
    this.recent = this.recent.filter((t) => nowSec - t < 60);
    if (this.recent.length >= TV_SETUP.max_per_min) return 'flood';
    this.recent.push(nowSec);
    for (const m of [this.lastExact, this.lastEvent, this.lastNotify]) {
      for (const [k, t] of m) if (nowSec - t > 600) m.delete(k);
    }

    // The line is part of the exact key: a PULLBACK on the month line two
    // minutes after one on the session line is a second event, not a re-delivery.
    const exact = `${sig.ticker}|${sig.stage}|${sig.tf ?? ''}|${sig.line ?? ''}`;
    const prev = this.lastExact.get(exact);
    const vb = VB_STAGES.has(sig.stage);
    const dupSec = vb ? TV_SETUP.vb_dup_sec : TV_SETUP.dup_sec;
    if (prev != null && nowSec - prev < dupSec) return 'drop';
    this.lastExact.set(exact, nowSec);
    // A v25 LEVEL is stored and shown on its CROSS row in the sidebar, never announced.
    if (sig.stage === 'level') return 'quiet';
    // v21 CROSS and v25 BREAK: one per candle / level from the 30s alert alone — no
    // copy to merge, and no 5-min spacing (the next one is a new event); the cap and
    // the Momentum-only rule limit them.
    if (vb) {
      const fresh = sig.day_gain != null && sig.day_gain >= TV_SETUP.vb_fresh_gain;
      const quiet = !this.announced.has(sig.stage) || (pastCap(sig) && !capExempt) || (TV_SETUP.vb_momentum_only && !onMomentum && !fresh);
      return quiet ? 'quiet' : 'notify';
    }

    const tokens = lineTokens(sig.stage, sig.line);
    const event = `${sig.ticker}|${sig.stage}|${tokens.join('+')}`;
    const first = this.lastEvent.get(event);
    if (first != null && nowSec - first < TV_SETUP.notify_merge_sec) return 'log';
    this.lastEvent.set(event, nowSec);

    if (!this.announced.has(sig.stage)) return 'quiet';
    if (pastCap(sig) && !capExempt) return 'quiet';

    // One announcement per ticker + stage per 5 min. A quiet event doesn't use
    // up the slot. PULLBACK counts per line (operator, 2026-10-05):
    // each line is its own level and setup — MI's 15:21 session pullback,
    // +10% two minutes later, was only logged because a year-line PULLBACK
    // had pinged 3½ min earlier. A line already announced in another
    // combination (session+month, then session) is the same level → logged.
    const keys = sig.stage === 'pullback' && tokens.length > 0
      ? tokens.map((t) => `${sig.ticker}|pullback|${t}`)
      : [`${sig.ticker}|${sig.stage}`];
    const announcedLately = (k: string) => {
      const t = this.lastNotify.get(k);
      return t != null && nowSec - t < TV_SETUP.notify_merge_sec;
    };
    if (keys.some(announcedLately)) return 'log';
    for (const k of keys) this.lastNotify.set(k, nowSec);
    return 'notify';
  }
}

export const TV_STAGE_LABEL: Record<TvStage, string> = {
  pullback: 'PULLBACK', broken: 'BROKEN', held: 'HELD', cross: 'CROSS', level: 'LEVEL', break: 'BREAK',
};
const STAGE_ICON: Record<TvStage, string> = {
  pullback: '↩️', broken: '✖️', held: '✅', cross: '⏫', level: '📏', break: '🔼',
};
const STAGE_HINT: Record<TvStage, string> = {
  pullback: 'back near VWAP after the run — be ready',
  broken: 'closed under VWAP — setup broken',
  held: 'held — ran +10% from the pullback',
  cross: 'the candle crossed over the session VWAP and the BB upper band',
  level: 'the VB candle closed: its high is the trigger, its low the stop',
  break: "price took the VB candle's high",
};
// A TradingView interval, short: "5" → "5m", "60" → "1h", "30S" → "30s".
export function fmtTf(tf: string | null | undefined): string {
  if (!tf) return '?';
  if (/^\d+$/.test(tf)) {
    const n = Number(tf);
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  return /^\d+S$/i.test(tf) ? tf.toLowerCase() : tf;
}
// The line(s) a message is about, in words: "session + month VWAP".
function lineName(sig: TvSetupSignal): string {
  const tokens = lineTokens(sig.stage, sig.line);
  return `${(tokens.length > 0 ? tokens : ['session']).join(' + ')} VWAP`;
}

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
): string {
  if (sig.stage === 'cross') return formatCross(sig, tvSym, row);
  if (sig.stage === 'break' || sig.stage === 'level') return formatBreak(sig, tvSym, row);
  // PULLBACK / BROKEN / HELD. PULLBACK and BROKEN name the line: "back near the
  // session VWAP after the run — be ready".
  const tokens = lineTokens(sig.stage, sig.line);
  const hint = sig.line && sig.stage !== 'held' ? STAGE_HINT[sig.stage].replace('VWAP', `the ${lineName(sig)}`) : STAGE_HINT[sig.stage];
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${hint}</i>`,
  ];
  const what = [touchText(sig.touch)];
  if (sig.stage === 'pullback' && sig.fails != null && sig.fails > 0) {
    what.push(pastCap(sig) ? `${sig.fails} failed before — past the cap, sent for grade ${escapeHtml(row?.grade ?? '?')}` : `${sig.fails} failed before`);
  }
  if (sig.stage === 'pullback' && sig.peak_pct != null) what.push(`ran +${Math.round(sig.peak_pct)}% above the line first`);
  if (what.some(Boolean)) lines.push(what.filter(Boolean).join(' · '));
  // Levels: the setup's own line(s) first, then the others the message carries.
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl: string[] = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))]
    .map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v21 CROSS: "the 5m candle crossed over the session VWAP and the 2m BB upper band";
// v22 names the month / year line it crossed ("the session + month VWAP").
function formatCross(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const bb = fmtTf(sig.bb_tf);
  const tokens = lineTokens(sig.stage, sig.line);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON.cross} <b>${TV_STAGE_LABEL.cross}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>the ${fmtTf(sig.candle_tf)} candle crossed over the ${tokens.join(' + ')} VWAP and the ${bb} BB upper band</i>`,
  ];
  const what: string[] = [];
  if (sig.cross_n != null) {
    what.push(`cross ${sig.cross_n} today${sig.cross_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (sig.candle_open != null) what.push(`opened ${fmtPx(sig.candle_open)}`);
  if (what.length > 0) lines.push(what.join(' · '));
  // Levels: the crossed line(s), the band, then the other lines the message carries.
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = tokens.map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (sig.upper != null) lvl.push(`${bb} BB upper ${fmtPx(sig.upper)} (${fmtSigned(sig.upper_pct ?? null)})`);
  lvl.push(...LINE_ORDER.filter((t) => !tokens.includes(t)).map((t) => lvlOf[t]).filter((x): x is string => x != null));
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig, sig.vol_x != null ? [`volume ${sig.vol_x.toFixed(1)}× its last 20 candles`] : []);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

// v25 BREAK: "over the 10m VB candle's high $12.59 · stop $11.80 (its low, −6.3%)".
function formatBreak(
  sig: TvSetupSignal,
  tvSym: string,
  row: { change_pct: number | null; grade: string | null; float_m: number | null } | null,
): string {
  const tokens = lineTokens(sig.stage, sig.line);
  const lines = [
    `${row ? '⭐ ' : ''}📐 ${STAGE_ICON[sig.stage]} <b>${TV_STAGE_LABEL[sig.stage]}</b>  <b>${escapeHtml(sig.ticker)}</b>  ${fmtPx(sig.price)}`.trimEnd(),
    `<i>${sig.stage === 'break' ? 'over' : 'trigger:'} the ${fmtTf(sig.candle_tf)} VB candle's high ${fmtPx(sig.level ?? null)} (${tokens.join(' + ')} VWAP + ${fmtTf(sig.bb_tf)} BB cross)</i>`,
  ];
  const what: string[] = [];
  if (sig.stop != null) {
    const risk = sig.level != null && sig.level > 0 ? ` (its low, ${fmtSigned((sig.stop / sig.level - 1) * 100)})` : ' (its low)';
    what.push(`stop ${fmtPx(sig.stop)}${risk}`);
  }
  if (sig.break_n != null) {
    what.push(`break ${sig.break_n} today${sig.break_n === 1 ? ' (first)' : ''}${pastCap(sig) ? ' — past the cap' : ''}`);
  }
  if (what.length > 0) lines.push(what.join(' · '));
  const lvlOf: Record<TvLineName, string | null> = {
    session: sig.svwap != null ? `sVWAP ${fmtPx(sig.svwap)} (${fmtSigned(sig.spx_pct ?? null)})` : null,
    month: sig.mvwap != null ? `mVWAP ${fmtPx(sig.mvwap)} (${fmtSigned(sig.px_pct)})` : null,
    year: sig.yvwap != null ? `yVWAP ${fmtPx(sig.yvwap)} (${fmtSigned(sig.ypx_pct ?? null)})` : null,
  };
  const lvl = [...tokens, ...LINE_ORDER.filter((t) => !tokens.includes(t))].map((t) => lvlOf[t]).filter((x): x is string => x != null);
  if (lvl.length > 0) lines.push(lvl.join(' · '));
  lines.push(momentumLine(row));
  const ctx = contextParts(sig);
  if (ctx.length > 0) lines.push(ctx.join(' · '));
  lines.push(linksLine(sig, tvSym));
  return lines.join('\n');
}

function momentumLine(row: { change_pct: number | null; grade: string | null; float_m: number | null } | null): string {
  if (!row) return '<i>not on our Momentum list</i>';
  const mom = ['⭐ <b>on Momentum</b>'];
  if (row.grade) mom.push(`grade ${escapeHtml(row.grade)}`);
  if (row.change_pct != null) mom.push(`now ${fmtSigned(row.change_pct)}`);
  if (row.float_m != null) mom.push(`float ${row.float_m.toFixed(1)}M`);
  return mom.join(' · ');
}

// "day high +41% · after hours +34% · tf 1" (`extra` goes before the timeframe)
function contextParts(sig: TvSetupSignal, extra: string[] = []): string[] {
  const ctx: string[] = [];
  if (sig.day_gain != null) ctx.push(`day high ${fmtSigned(Math.round(sig.day_gain)).replace('.0%', '%')}`);
  if (sig.ah_gain != null) ctx.push(`after hours ${fmtSigned(Math.round(sig.ah_gain)).replace('.0%', '%')}`);
  ctx.push(...extra);
  if (sig.tf) ctx.push(`tf ${escapeHtml(sig.tf)}`);
  return ctx;
}

function linksLine(sig: TvSetupSignal, tvSym: string): string {
  const finviz = `https://finviz.com/quote.ashx?t=${encodeURIComponent(sig.ticker)}`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym)}`;
  return `<a href="${tv}">TradingView</a> · <a href="${finviz}">Finviz</a>`;
}
