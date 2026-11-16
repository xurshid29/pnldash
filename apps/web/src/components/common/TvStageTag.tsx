import type { TvLine, TvLineName, TvSetupInfo, TvStage } from '../../api/types';

// 📐 VWAP setup stage pill (TradingView webhook, 2026-10-03). Blue → red/green for
// the PULLBACK setup (script v10) and its outcome; teal for the VWAP + BB cross
// (v21, the chart's "VB" marker) and its retest (v28). Used by the 📐 sidebar.
export const TV_STAGE_STYLE: Record<TvStage, { label: string; color: string; bg: string }> = {
  pullback: { label: 'PULLBACK', color: '#bae7ff', bg: '#003a8c' },
  broken: { label: 'BROKEN', color: '#ffccc7', bg: '#5c0011' },
  held: { label: 'HELD', color: '#d9f7be', bg: '#135200' },
  cross: { label: 'CROSS', color: '#b5f5ec', bg: '#00474f' },
  retest: { label: 'RETEST', color: '#ffffff', bg: '#08979c' },
  rsi: { label: 'RSI', color: '#efdbff', bg: '#391085' },   // v32, purple like its chart marker
  dip: { label: 'DIP', color: '#ffffff', bg: '#c41d7f' },   // v34, magenta like its chart marker
  macd: { label: 'MACD', color: '#1f1f1f', bg: '#36cfc9' }, // v39, aqua like its chart marker
  ema: { label: 'EMA', color: '#1f1f1f', bg: '#fa8c16' },   // v35, orange like its chart marker
  bounce: { label: 'BOUNCE', color: '#1f1f1f', bg: '#a0d911' },   // v37, lime like its chart marker
};

// The VWAP + BB cross's stages: CROSS (v21) and RETEST (v28).
export function isVbStage(stage: TvStage): boolean {
  return stage === 'cross' || stage === 'retest';
}

// The individual lines of a signal (server: tv-setups.ts lineTokens). The legacy
// 'both' (v10–v13) was session + month. A CROSS without a line (script v21) is the
// session line; v22 names session / month / year.
export function lineTokens(stage: TvStage, line: TvLine | null | undefined): TvLineName[] {
  if (!line) return isVbStage(stage) ? ['session'] : [];
  if (line === 'both') return ['session', 'month'];
  return line.split('+') as TvLineName[];
}

// The line(s) a signal is about, colored like the operator's chart: session
// VWAP purple, month yellow, year blue, several lines white ("S+Y").
const LINE_TAG: Record<TvLineName, { label: string; color: string }> = {
  session: { label: 'S', color: '#b37feb' },
  month: { label: 'M', color: '#fadb14' },
  year: { label: 'Y', color: '#4096ff' },
};
function lineTag(stage: TvStage, line: TvLine | null | undefined): { label: string; color: string } | null {
  const tokens = lineTokens(stage, line);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) return LINE_TAG[tokens[0]];
  return { label: tokens.map((t) => LINE_TAG[t].label).join('+'), color: '#ffffff' };
}

// "+1.2% vs sVWAP" for one line of a signal.
export function lineDistanceText(s: TvSetupInfo, line: TvLineName): string | null {
  const pct = line === 'session' ? s.spx_pct : line === 'month' ? s.px_pct : s.ypx_pct;
  return pct == null ? null : `${fmtSignedPct(pct).replace('-', '−')} vs ${{ session: 'sVWAP', month: 'mVWAP', year: 'yVWAP' }[line]}`;
}

// TradingView interval → short label: "1" → 1m, "60" → 1h, "30S" → 30s, "1D" → 1D.
export function fmtTf(tf: string | null | undefined): string {
  if (!tf) return '';
  if (/^\d+$/.test(tf)) {
    const n = Number(tf);
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  return /^\d+S$/i.test(tf) ? tf.toLowerCase() : tf;
}

// v21 CROSS / v28 RETEST: "5m/45s" — the candle's timeframe over the band's. v32 RSI: the
// signal RSI's timeframe ("12h"); its v34 DIP the same.
export function crossTfText(s: TvSetupInfo): string | null {
  if (s.stage === 'rsi' || s.stage === 'dip') return s.rsi_tf ? fmtTf(s.rsi_tf) : null;
  // v39 MACD: "5m" — the MACD's timeframe
  if (s.stage === 'macd') return s.macd_tf ? fmtTf(s.macd_tf) : null;
  // v40, the band as the line: "3m/45s" — the judged candle's timeframe over the band's, like a CROSS
  if (isBandCross(s)) return s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
  // v42, the basis as the line: "3m/45s·10" — the candle's timeframe over the basis band's timeframe and length
  if (isBasisCross(s)) return s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}·${s.bb_len ?? '?'}` : null;
  // v35 EMA cross: "3m/9" — the EMA's timeframe over its length (its v37 BOUNCE the same)
  if (s.stage === 'ema' || s.stage === 'bounce') return s.candle_tf ? `${fmtTf(s.candle_tf)}/${s.ema_len ?? '?'}` : null;
  return isVbStage(s.stage) && s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
}

// v40: an EMA-stage cross whose line is the BB upper band (the script's "EMA cross: the line that
// crosses the VWAP" set to "BB upper" or "Both"): the message carries the band and its timeframe
// in the EMA's place. Same stage and switch; its own thread per line; the pill reads "BAND".
export function isBandCross(s: TvSetupInfo): boolean {
  return s.stage === 'ema' && s.bb_tf != null && s.ema == null && s.basis == null;
}

// v42: an EMA-stage cross whose line is the basis (middle line) of the script's separate band
// ("Basis cross on"): the message carries the basis, its band's timeframe and length in the EMA's
// place. Same stage and switch; its own thread per line; the pill reads "BASIS".
export function isBasisCross(s: TvSetupInfo): boolean {
  return s.stage === 'ema' && s.basis != null && s.ema == null;
}

// The pill's label when it isn't the stage's own (a band or a basis cross), else undefined.
export function stageLabelOf(s: TvSetupInfo): string | undefined {
  return isBandCross(s) ? 'BAND' : isBasisCross(s) ? 'BASIS' : undefined;
}

// "45s basis (10) $8.03" — the basis a v42 cross read.
function basisText(s: TvSetupInfo): string | null {
  if (s.basis == null) return null;
  return `${fmtTf(s.bb_tf ?? null) || '?'} basis${s.bb_len != null ? ` (${s.bb_len})` : ''} $${s.basis < 1 ? s.basis.toFixed(4) : s.basis.toFixed(2)}`;
}

// "45s BB upper $8.03" — the band a v40 cross read.
function bandText(s: TvSetupInfo): string | null {
  if (s.upper == null) return null;
  return `${fmtTf(s.bb_tf ?? null) || '?'} BB upper $${s.upper < 1 ? s.upper.toFixed(4) : s.upper.toFixed(2)}`;
}

// v41: "−3.2% under the band's middle (a drop widened the band)" / "+0.5% over the band's middle".
function bandMidText(s: TvSetupInfo): string | null {
  if (s.bb_mid_pct == null) return null;
  return s.bb_mid_pct < 0
    ? `${fmtSignedPct(s.bb_mid_pct)} under the band's middle (a drop widened the band)`
    : `${fmtSignedPct(s.bb_mid_pct)} over the band's middle`;
}

// v36: an EMA cross the script's filter calls weak (too early in the day, the EMA under the line
// too briefly, or too much crossing before it), and (v37) the BOUNCE after one. Stored and listed
// in the history, not announced, and never a ticker's live row in the 📐 sidebar.
export function isWeakEma(s: TvSetupInfo): boolean {
  return (s.stage === 'ema' || s.stage === 'bounce') && s.weak === true;
}

// What tells one EMA cross (or bounce) from the next when merging copies: a weak one doesn't take
// a day's number, so two of them carry the same `cross N` / `bounce N`.
export function emaEventKey(s: TvSetupInfo): string {
  if (s.stage === 'bounce') return `${s.bounce_n ?? ''}/${s.since_n ?? ''}/${s.stop ?? ''}/${s.weak ? 'w' : ''}`;
  // v40: a band cross and an EMA cross of one candle are two events
  return `${s.cross_n ?? ''}/${s.under_n ?? ''}/${s.flips_n ?? ''}/${s.weak ? 'w' : ''}${isBandCross(s) ? '/bb' : isBasisCross(s) ? '/bs' : ''}`;
}

// The number beside a stage tag: a pullback's touch, a CROSS's or an EMA cross's number today, a
// RETEST's, a DIP's, a BOUNCE's. A weak EMA cross or bounce has none (the script doesn't count it).
export function tagNumber(s: TvSetupInfo): number | null {
  if (s.stage === 'ema') return s.weak ? null : s.cross_n ?? null;
  if (s.stage === 'bounce') return s.weak ? null : s.bounce_n ?? null;
  if (s.stage === 'cross') return s.cross_n ?? null;
  if (s.stage === 'retest') return s.retest_n ?? null;
  if (s.stage === 'dip') return s.dip_n ?? null;
  if (s.stage === 'macd') return null;   // one per DIP
  return s.touch ?? null;
}

// Trail arrows: → while a setup advances, · when a new one starts.
export const TV_STAGE_RANK: Record<TvStage, number> = { pullback: 1, broken: 2, held: 2, cross: 1, retest: 2, rsi: 1, dip: 2, macd: 3, ema: 1, bounce: 2 };

export function fmtSignedPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// PULLBACK-setup stages show their line (S / M / S+M) and touch number (#1 = first);
// a v21 CROSS / v28 RETEST its timeframes ("5m/45s", `tfs`) and the day's number as `touch`.
export function TvStageTag({ stage, dim, line, touch, tfs, label }: {
  stage: TvStage; dim?: boolean; line?: TvLine | null; touch?: number | null; tfs?: string | null; label?: string;
}) {
  const s = TV_STAGE_STYLE[stage];
  const ln = lineTag(stage, line);
  return (
    <span style={{ whiteSpace: 'nowrap', opacity: dim ? 0.55 : 1 }}>
      <span
        style={{
          display: 'inline-block', padding: '0 6px', borderRadius: 3, fontWeight: 700, fontSize: 11,
          lineHeight: '18px', color: s.color, background: s.bg,
        }}
      >
        {label ?? s.label}
      </span>
      {ln && <span style={{ color: ln.color, fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{ln.label}</span>}
      {tfs && <span style={{ color: '#5cdbd3', fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{tfs}</span>}
      {touch != null && <span style={{ color: touch === 1 ? '#ffffff' : '#8c8c8c', fontSize: 10, fontWeight: 700, marginLeft: 2 }}>#{touch}</span>}
    </span>
  );
}

// v28 RETEST: "retest · stop $17.09 (−1.1%)" — the stop under the pullback's low,
// against the RETEST price. v34 DIP: "dip · stop $7.89 (−2.5%)", under the dip's low. v37 BOUNCE:
// "bounce · stop $0.0985 (−3.5%)", under the pullback's low. v39 MACD: "DIP stop $37.20 (−2.4%)" —
// its DIP's stop, against the MACD signal's price.
export function retestStopText(s: TvSetupInfo, price: number | null | undefined): string | null {
  if (s.stop == null) return null;
  const px = (p: number) => `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
  const pct = price != null && price > 0 ? ` (${fmtSignedPct((s.stop / price - 1) * 100).replace('-', '−')})` : '';
  if (s.stage === 'macd') return `DIP stop ${px(s.stop)}${pct}`;
  return `${s.stage === 'dip' ? 'dip' : s.stage === 'bounce' ? 'bounce' : 'retest'} · stop ${px(s.stop)}${pct}`;
}

// Minutes as "45m", "4h 50m", "2d 3h" (server: tv-setups.ts fmtMinutes).
export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min < 0) return '?';
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ''}`;
}

const pxText = (p: number) => `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;

// v39 MACD: "+1.6% from the DIP at $37.53" — where the signal sits against its DIP's price.
export function macdFromDipText(s: TvSetupInfo, price: number | null | undefined): string | null {
  if (s.dip_px == null) return null;
  const pct = price != null && s.dip_px > 0 ? `${fmtSignedPct((price / s.dip_px - 1) * 100).replace('-', '−')} from ` : '';
  return `${pct}the DIP at ${pxText(s.dip_px)}`;
}

// v39 MACD: the MACD that crossed, the DIP it follows, the DIP's stop, how long it took.
export function macdText(s: TvSetupInfo, price?: number | null): string {
  const parts: Array<string | null> = [
    `${fmtTf(s.macd_tf ?? null) || '?'} MACD line over zero${s.macd_fast != null && s.macd_slow != null ? ` (${s.macd_fast} / ${s.macd_slow})` : ''}`,
    macdFromDipText(s, price),
    retestStopText(s, price),
  ];
  if (s.after_min != null) parts.push(`${fmtMinutes(s.after_min)} after the DIP`);
  if (s.candle_tf) parts.push(`${fmtTf(s.candle_tf)} RSI`);
  if (s.late) parts.push('late');
  return parts.filter((p): p is string => p != null).join(' · ');
}

// v37 BOUNCE: the stop, where price sat against its line, the EMA, what the pullback came down to,
// how long after the cross.
export function bounceText(s: TvSetupInfo, price?: number | null): string {
  const parts = [retestStopText(s, price), ...lineTokens(s.stage, s.line).map((t) => lineDistanceText(s, t))];
  if (s.ema != null) parts.push(`EMA ${s.ema_len ?? '?'} $${s.ema < 1 ? s.ema.toFixed(4) : s.ema.toFixed(2)}`);
  if (s.bounce_from) parts.push(`off ${s.bounce_from === 'ema+vwap' ? 'the EMA and the VWAP' : s.bounce_from === 'vwap' ? 'the VWAP' : 'the EMA'}`);
  if (s.since_n != null) parts.push(`${s.since_n} candle${s.since_n === 1 ? '' : 's'} after the cross`);
  if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close${s.late ? ' (late)' : ''}`);
  if (s.weak) parts.push('after a weak cross');
  return parts.filter((p): p is string => p != null).join(' · ');
}

// v34 DIP: the stop, the RSI against its MA at the turn, the dip's lowest RSI, how long after the RSI cross.
export function dipText(s: TvSetupInfo, price?: number | null): string {
  const one = (x: number | null | undefined) => (x == null ? '?' : x.toFixed(1));
  const parts = [retestStopText(s, price), `${fmtTf(s.rsi_tf ?? null) || '?'} RSI ${one(s.rsi)} / MA ${one(s.rsi_ma)}`];
  if (s.rsi_low != null) parts.push(`dip low ${one(s.rsi_low)}`);
  if (s.since_n != null) parts.push(`${s.since_n} candle${s.since_n === 1 ? '' : 's'} after the RSI cross`);
  if (s.late) parts.push('late');
  return parts.filter((p): p is string => p != null).join(' · ');
}

// v32 RSI cross: the signal RSI against its MA, its low, the second RSI, the check timeframe.
export function rsiText(s: TvSetupInfo): string {
  const one = (x: number | null | undefined) => (x == null ? '?' : x.toFixed(1));
  const parts = [`${fmtTf(s.rsi_tf ?? null) || '?'} RSI ${one(s.rsi)} / MA ${one(s.rsi_ma)}`];
  if (s.rsi_low != null) parts.push(`low ${one(s.rsi_low)}`);
  if (s.rsi2 != null) parts.push(`${fmtTf(s.rsi2_tf ?? null) || '?'} ${one(s.rsi2)} / ${one(s.rsi2_ma)}`);
  if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close${s.late ? ' (late)' : ''}`);
  return parts.join(' · ');
}

// Where price sat at the signal. PULLBACK setup: "+0.7% vs sVWAP · +51.2% vs mVWAP ·
// ran +17%", its own line first.
export function tvLevelsText(s: TvSetupInfo, price?: number | null): string {
  // v32 RSI: "12h RSI 29.2 / MA 27.0 · low 22.1 · 3h 41.2 / 30.7 · at the 6h close"
  if (s.stage === 'rsi') return rsiText(s);
  if (s.stage === 'dip') return dipText(s, price);
  if (s.stage === 'macd') return macdText(s, price);
  if (s.stage === 'bounce') return bounceText(s, price);
  // v35 EMA cross: "+1.0% vs sVWAP · EMA 9 $8.03 · at the 3m close · 12 candles under · 1 flip" (v36: the filter's readings)
  if (s.stage === 'ema') {
    const parts = lineTokens(s.stage, s.line).map((t) => lineDistanceText(s, t));
    if (isBandCross(s)) parts.push(bandText(s), bandMidText(s));   // v40: the band in the EMA's place; v41: the price against its middle
    else if (isBasisCross(s)) parts.push(basisText(s));           // v42: the basis in the EMA's place
    else if (s.ema != null) parts.push(`EMA ${s.ema_len ?? '?'} $${s.ema < 1 ? s.ema.toFixed(4) : s.ema.toFixed(2)}`);
    if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close${s.late ? ' (late)' : ''}`);
    if (s.under_n != null) parts.push(`${s.under_n} candle${s.under_n === 1 ? '' : 's'} under`);
    if (s.flips_n != null) parts.push(`${s.flips_n} flip${s.flips_n === 1 ? '' : 's'}`);
    if (s.weak) parts.push('filtered as weak');
    return parts.filter((p): p is string => p != null).join(' · ');
  }
  // v28 RETEST: the stop, then where price sat against its line
  if (s.stage === 'retest') {
    const parts = [retestStopText(s, price), ...lineTokens(s.stage, s.line).map((t) => lineDistanceText(s, t))];
    return parts.filter((p): p is string => p != null).join(' · ');
  }
  // v21 CROSS: "+5.7% vs sVWAP · +1.2% vs 2m BB · opened $2.50" (v22: its own line first)
  if (s.stage === 'cross') {
    const parts = lineTokens(s.stage, s.line).map((t) => lineDistanceText(s, t));
    if (s.upper_pct != null) parts.push(`${fmtSignedPct(s.upper_pct).replace('-', '−')} vs ${fmtTf(s.bb_tf ?? null) || '?'} BB`);
    if (s.candle_open != null) parts.push(`opened ${s.candle_open < 1 ? s.candle_open.toFixed(4) : s.candle_open.toFixed(2)}`);
    return parts.filter((p): p is string => p != null).join(' · ');
  }
  // The signal's own line(s) first (a pullback without a line: session, then month)
  const tokens = lineTokens(s.stage, s.line);
  const shown: TvLineName[] = tokens.length > 0 ? tokens : ['session', 'month'];
  const parts = shown.map((t) => lineDistanceText(s, t)).filter((p): p is string => p != null);
  if (s.stage === 'pullback' && s.peak_pct != null) parts.push(`ran +${Math.round(s.peak_pct)}%`);
  return parts.join(' · ');
}
