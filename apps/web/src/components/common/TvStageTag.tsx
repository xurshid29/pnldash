import type { TvLine, TvLineName, TvSetupInfo, TvStage } from '../../api/types';
import { fmtBigPct, fmtBigPctShort } from '../../utils/format';

// 📐 VWAP setup stage pill (TradingView webhook, 2026-10-03). Blue → red/green for
// the PULLBACK setup (script v10) and its outcome; teal for the VWAP + BB cross
// (v21, the chart's "VB" marker) and its retest (v28). Used by the 📐 sidebar.
export const TV_STAGE_STYLE: Record<TvStage, { label: string; color: string; bg: string }> = {
  pullback: { label: 'PULLBACK', color: '#bae7ff', bg: '#003a8c' },
  broken: { label: 'BROKEN', color: '#ffccc7', bg: '#5c0011' },
  held: { label: 'HELD', color: '#d9f7be', bg: '#135200' },
  cross: { label: 'CROSS', color: '#b5f5ec', bg: '#00474f' },
  retest: { label: 'RETEST', color: '#ffffff', bg: '#08979c' },
  ema: { label: 'EMA', color: '#1f1f1f', bg: '#fa8c16' },   // v35, orange like its chart marker
  bounce: { label: 'BOUNCE', color: '#1f1f1f', bg: '#a0d911' },   // v37, lime like its chart marker
  band: { label: 'BAND', color: '#ffffff', bg: '#a8071a' },       // v40, maroon like its chart marker (the BB upper band over the VWAP)
  turn: { label: 'TURN', color: '#ffffff', bg: '#c41d7f' },       // v47, fuchsia like its chart marker (the bounce off a basis that turned up)
  pop: { label: 'POP', color: '#1f1f1f', bg: '#d48806' },         // v48, gold (its chart marker is yellow): a run popped above its basis — a heads-up, no entry
  back: { label: 'BACK', color: '#ffffff', bg: '#722ed1' },       // v48, purple (its chart marker is an aqua "BK"; teal here is RETEST's): the bounce off the basis after a POP — the entry
};

// The VWAP + BB cross's stages: CROSS (v21) and RETEST (v28).
export function isVbStage(stage: TvStage): boolean {
  return stage === 'cross' || stage === 'retest';
}

// v48: the two steps of the pop off a basis line — POP (the heads-up) and BACK (the entry).
export function isPopBack(stage: TvStage): boolean {
  return stage === 'pop' || stage === 'back';
}

// 2026-11-27: a POP or a BACK whose volume reading is this many times or more is announced on any
// name, on the Momentum list or not (server: TV_SETUP.pp_free_vol — the server's own number, it
// does not move with the script's minimum). The first live morning had 12 strong POPs and only 2
// pinged: the other 10 were on names not on the list at that moment, and a stock with no volume
// that suddenly pops is not on the Momentum screen yet.
export const POP_FREE_VOL = 10;
// The test, in one place for the sidebar's "Show only Momentum tickers" checkbox, the off-list
// dimming, the toasts and the sounds: a POP or a BACK, not weak, with a reading of POP_FREE_VOL or
// more (a BACK carries its POP's reading). A row with no reading does not pass. Whether such a row
// was announced is its `notified`: the ⚙ stage switch and the day's cap can still keep it quiet.
export function isFreePop(s: TvSetupInfo): boolean {
  return isPopBack(s.stage) && s.weak !== true && s.vol_x != null && s.vol_x >= POP_FREE_VOL;
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

// v21 CROSS / v28 RETEST: "5m/45s" — the candle's timeframe over the band's.
export function crossTfText(s: TvSetupInfo): string | null {
  // v47 TURN: "1m·15" — the basis's timeframe and its length (a v48 POP / BACK the same)
  if (s.stage === 'turn' || isPopBack(s.stage)) return s.candle_tf ? `${fmtTf(s.candle_tf)}·${s.sma_len ?? '?'}` : null;
  // v40, the band as the line: "3m/45s" — the judged candle's timeframe over the band's, like a CROSS
  if (isBandCross(s)) return s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
  // v35 EMA cross: "3m/9" — the EMA's timeframe over its length (its v37 BOUNCE the same)
  if (s.stage === 'ema' || s.stage === 'bounce') return s.candle_tf ? `${fmtTf(s.candle_tf)}/${s.ema_len ?? '?'}` : null;
  return isVbStage(s.stage) && s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
}

// v40 BAND: the EMA cross's rule with the BB upper band as the line over the VWAP (the script's
// "EMA cross: the line that crosses the VWAP" set to "BB upper" or "Both"). A stage of its own
// since 2026-11-16 (the server sorts an "EMA …" message, and an older stored row, by its
// fields), with its ⚙ switch, pill and thread.
export function isBandCross(s: TvSetupInfo): boolean {
  return s.stage === 'band';
}
// The two crosses of a line over the VWAP: the EMA's and the band's (not the BOUNCE).
export function isLineCross(stage: TvStage): boolean {
  return stage === 'ema' || stage === 'band';
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
// too briefly, or too much crossing before it), and (v37) the BOUNCE after one. v49: a POP whose
// volume reading is under the script's minimum (the biggest of the POP candle and the two candles
// before it traded under 10 times the average of the 20 candles before them), and the BACK after
// one. Stored and listed in the history, not announced, and never a ticker's live row in the 📐
// sidebar.
export function isWeakSetup(s: TvSetupInfo): boolean {
  return (isLineCross(s.stage) || s.stage === 'bounce' || isPopBack(s.stage)) && s.weak === true;   // …and a weak band cross
}

// What tells one EMA cross (or bounce) from the next when merging copies: a weak one doesn't take
// a day's number, so two of them carry the same `cross N` / `bounce N`.
export function emaEventKey(s: TvSetupInfo): string {
  if (s.stage === 'bounce') return `${s.bounce_n ?? ''}/${s.since_n ?? ''}/${s.stop ?? ''}/${s.weak ? 'w' : ''}`;
  // v40: a band cross and an EMA cross of one candle are two events
  return `${s.cross_n ?? ''}/${s.under_n ?? ''}/${s.flips_n ?? ''}/${s.weak ? 'w' : ''}${isBandCross(s) ? '/bb' : ''}`;
}

// The same for a POP or a BACK (v49): one that counts is told from the next by its day's number;
// a weak one doesn't take a number (it carries the count as it stood), so its own readings tell
// it from a counted one and from the next weak one.
export function popEventKey(s: TvSetupInfo): string {
  const n = (s.stage === 'back' ? s.back_n : s.pop_n) ?? '';
  if (!s.weak) return `${n}`;
  return s.stage === 'back' ? `w/${n}/${s.since_n ?? ''}/${s.stop ?? ''}` : `w/${n}/${s.ran_pct ?? ''}/${s.vol_x ?? ''}`;
}

// The number beside a stage tag: a pullback's touch, a CROSS's or an EMA cross's number today, a
// RETEST's, a BOUNCE's, a TURN's, a POP's, a BACK's. A weak EMA cross or bounce has none (the
// script doesn't count it), and (v49) neither has a weak POP or BACK.
export function tagNumber(s: TvSetupInfo): number | null {
  if (isLineCross(s.stage)) return s.weak ? null : s.cross_n ?? null;   // the EMA's and the band's: each its own count
  if (s.stage === 'bounce') return s.weak ? null : s.bounce_n ?? null;
  if (s.stage === 'turn') return s.turn_n ?? null;
  if (s.stage === 'pop') return s.weak ? null : s.pop_n ?? null;     // v48: the day's POPs on the ticker
  if (s.stage === 'back') return s.weak ? null : s.back_n ?? null;   // …and its BACKs, counted apart
  if (s.stage === 'cross') return s.cross_n ?? null;
  if (s.stage === 'retest') return s.retest_n ?? null;
  return s.touch ?? null;
}

// Trail arrows: → while a setup advances, · when a new one starts.
export const TV_STAGE_RANK: Record<TvStage, number> = { pullback: 1, broken: 2, held: 2, cross: 1, retest: 2, ema: 1, bounce: 2, band: 1, turn: 1, pop: 1, back: 2 };   // a TURN is a setup of one stage; a BACK follows a POP like a RETEST its CROSS

export function fmtSignedPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// PULLBACK-setup stages show their line (S / M / S+M) and touch number (#1 = first);
// a v21 CROSS / v28 RETEST its timeframes ("5m/45s", `tfs`) and the day's number as `touch`.
export function TvStageTag({ stage, dim, line, touch, tfs }: {
  stage: TvStage; dim?: boolean; line?: TvLine | null; touch?: number | null; tfs?: string | null;
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
        {s.label}
      </span>
      {ln && <span style={{ color: ln.color, fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{ln.label}</span>}
      {tfs && <span style={{ color: '#5cdbd3', fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{tfs}</span>}
      {touch != null && <span style={{ color: touch === 1 ? '#ffffff' : '#8c8c8c', fontSize: 10, fontWeight: 700, marginLeft: 2 }}>#{touch}</span>}
    </span>
  );
}

// v28 RETEST: "retest · stop $17.09 (−1.1%)" — the stop under the pullback's low,
// against the RETEST price. v37 BOUNCE: "bounce · stop $0.0985 (−3.5%)", under the pullback's low.
// v47 TURN: "turn · stop $0.0206 (−3.3%)", the same. v48 BACK: "back · stop $1.84 (−4.2%)", the same.
export function retestStopText(s: TvSetupInfo, price: number | null | undefined): string | null {
  if (s.stop == null) return null;
  const px = (p: number) => `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
  const pct = price != null && price > 0 ? ` (${fmtSignedPct((s.stop / price - 1) * 100).replace('-', '−')})` : '';
  return `${s.stage === 'bounce' ? 'bounce' : s.stage === 'turn' ? 'turn' : s.stage === 'back' ? 'back' : 'retest'} · stop ${px(s.stop)}${pct}`;
}

// v48 POP: "pop · ran +12.6% · RVol 48K% · vol 212×" — how far a high of the run got above its
// basis, (v49) the POP's volume reading: the biggest volume among the POP candle and the two
// candles before it, against the average of the 20 candles before those three (whole numbers from
// 10× up, one decimal under it), and (v50) the stock's RVol 1m as the script computes it, short
// (fmtBigPctShort: "8,450%", "48K%", "1.3M%"). A POP is a heads-up, so it has no stop; this stands
// where a RETEST's or a BACK's stop does. No volume reading: a row from before v49, a POP whose 20
// candles before had no volume at all, or a chart with fewer than 23 candles. No RVol: a row from
// before v50, or a POP the script had no reading for. The row ellipsizes what doesn't fit.
export function popRanText(s: TvSetupInfo): string | null {
  const parts: string[] = [];
  if (s.ran_pct != null) parts.push(`ran ${fmtSignedPct(s.ran_pct).replace('-', '−')}`);
  // RVol before vol: the rail cuts a long lead, and the RVol is the reading the operator asked for.
  if (s.tv_rv1 != null) parts.push(`RVol ${fmtBigPctShort(s.tv_rv1)}`);
  if (s.vol_x != null) parts.push(`vol ${s.vol_x >= 10 ? Math.round(s.vol_x) : s.vol_x.toFixed(1).replace(/\.0$/, '')}×`);
  return parts.length > 0 ? `pop · ${parts.join(' · ')}` : null;
}

// v50: "RVol 1m 48,210% · 5m 11,975%" — the stock's relative volume at the POP as the TradingView
// script computes it: the last minute's volume (and the last 5 minutes') against the stock's
// average day, in percent. Not the Momentum table's RVol (the alert's rel_vol_1min), which only
// names on the Momentum screen have. On a BACK the readings are its POP's: "the pop's RVol 1m …".
// `short` (a toast): the 1-minute reading alone, short — "RVol 1m 48K%". Null on other stages and
// on a row without the reading (before v50, or none from the script). A reading only.
export function popRvolText(s: TvSetupInfo, short = false): string | null {
  if (!isPopBack(s.stage)) return null;
  const parts: string[] = [];
  if (s.tv_rv1 != null) parts.push(`1m ${short ? fmtBigPctShort(s.tv_rv1) : fmtBigPct(s.tv_rv1)}`);
  if (!short && s.tv_rv5 != null) parts.push(`5m ${fmtBigPct(s.tv_rv5)}`);
  if (parts.length === 0) return null;
  return `${s.stage === 'back' ? "the pop's " : ''}RVol ${parts.join(' · ')}`;
}

// v49: "volume 212.4× the 20 candles before the pop" — the POP's volume reading: the biggest
// volume among the POP candle and the two candles before it ÷ the average volume of the 20
// candles before those three (so not the POP candle's own last 20). On a BACK the reading is its
// POP's: "the pop's volume 212.4× the 20 candles before it".
export function popVolText(s: TvSetupInfo): string | null {
  if (!isPopBack(s.stage) || s.vol_x == null) return null;
  const x = `${s.vol_x.toFixed(1)}×`;
  return s.stage === 'back' ? `the pop's volume ${x} the 20 candles before it` : `volume ${x} the 20 candles before the pop`;
}

// "basis 15 $0.0207 (+2.9%)" — a basis line (v47 TURN, v48 POP / BACK) and the price against it.
function basisText(s: TvSetupInfo): string | null {
  if (s.sma == null) return null;
  const vs = s.sma_pct != null ? ` (${fmtSignedPct(s.sma_pct).replace('-', '−')})` : '';
  return `basis ${s.sma_len ?? '?'} $${s.sma < 1 ? s.sma.toFixed(4) : s.sma.toFixed(2)}${vs}`;
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

// v47 TURN: "turn · stop $0.0206 (−3.3%) · fall −12.3% · basis 15 $0.0207 (+2.9%) · 3 candles
// after the break · MACD green · at the 1m close · +0.9% vs sVWAP" — the stop, how far the basis
// fell before it turned, the basis and the price against it, how long after the close above it,
// then the VWAP lines (a TURN has no line of its own: session, then month).
export function turnText(s: TvSetupInfo, price?: number | null): string {
  const parts: Array<string | null> = [retestStopText(s, price)];
  if (s.fall_pct != null) parts.push(`fall −${Math.abs(s.fall_pct).toFixed(1)}%`);
  parts.push(basisText(s));
  if (s.since_n != null) parts.push(`${s.since_n} candle${s.since_n === 1 ? '' : 's'} after the break`);
  if (s.macd_green != null) parts.push(s.macd_green ? 'MACD green' : 'MACD not green');
  if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close`);
  parts.push(lineDistanceText(s, 'session'), lineDistanceText(s, 'month'));
  return parts.filter((p): p is string => p != null).join(' · ');
}

// v48 POP: "pop · ran +12.6% above the basis · volume 212.4× the 20 candles before the pop ·
// RVol 1m 48,210% · 5m 11,975% · basis 15 $1.66 (+11.4%) · at the 1m close · +14.2% vs sVWAP ·
// +32.1% vs mVWAP · a heads-up, no entry: wait for the BACK" — how far a high of the run got above
// the basis, (v49) the POP's volume reading (popVolText), (v50) the stock's RVol (popRvolText), the
// basis and the price against it, then the VWAP lines (like a TURN it has no line of its own). It
// has no stop: the entry is the BACK. A weak one (v49, under the script's volume minimum) says so in
// the place of the heads-up: its BACK is weak with it.
function popText(s: TvSetupInfo): string {
  const parts: Array<string | null> = [
    s.ran_pct != null ? `pop · ran ${fmtSignedPct(s.ran_pct).replace('-', '−')} above the basis` : null,
    popVolText(s), popRvolText(s), basisText(s),
  ];
  if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close`);
  parts.push(lineDistanceText(s, 'session'), lineDistanceText(s, 'month'),
    s.weak ? 'weak: under the volume minimum' : 'a heads-up, no entry: wait for the BACK');
  return parts.filter((p): p is string => p != null).join(' · ');
}

// v48 BACK: "back · stop $1.84 (−4.2%) · ran +18.4% above the basis · the pop's volume 212.4× the
// 20 candles before it · the pop's RVol 1m 48,210% · 5m 11,975% · basis 15 $1.88 (+2.1%) · 6
// candles after the pop · MACD green · at the 1m close · +12.9% vs sVWAP · +36.2% vs mVWAP" — the
// stop (a tick under the pullback's lowest low), how far the run's highs got above the basis,
// (v49) its POP's volume reading, (v50) its POP's RVol, the basis and the price against it, how
// long after the POP candle, then the VWAP lines. A BACK after a weak POP (v49) ends with "after a
// weak pop", like a BOUNCE after a weak cross.
function backText(s: TvSetupInfo, price?: number | null): string {
  const parts: Array<string | null> = [retestStopText(s, price)];
  if (s.ran_pct != null) parts.push(`ran ${fmtSignedPct(s.ran_pct).replace('-', '−')} above the basis`);
  parts.push(popVolText(s), popRvolText(s), basisText(s));
  if (s.since_n != null) parts.push(`${s.since_n} candle${s.since_n === 1 ? '' : 's'} after the pop`);
  if (s.macd_green != null) parts.push(s.macd_green ? 'MACD green' : 'MACD not green');
  if (s.candle_tf) parts.push(`at the ${fmtTf(s.candle_tf)} close`);
  parts.push(lineDistanceText(s, 'session'), lineDistanceText(s, 'month'));
  if (s.weak) parts.push('after a weak pop');
  return parts.filter((p): p is string => p != null).join(' · ');
}

// Where price sat at the signal. PULLBACK setup: "+0.7% vs sVWAP · +51.2% vs mVWAP ·
// ran +17%", its own line first.
export function tvLevelsText(s: TvSetupInfo, price?: number | null): string {
  if (s.stage === 'bounce') return bounceText(s, price);
  if (s.stage === 'turn') return turnText(s, price);
  if (s.stage === 'pop') return popText(s);
  if (s.stage === 'back') return backText(s, price);
  // v35 EMA cross: "+1.0% vs sVWAP · EMA 9 $8.03 · at the 3m close · 12 candles under · 1 flip" (v36: the filter's readings)
  if (isLineCross(s.stage)) {   // …and the band's cross, with its line in the EMA's place
    const parts = lineTokens(s.stage, s.line).map((t) => lineDistanceText(s, t));
    if (isBandCross(s)) parts.push(bandText(s), bandMidText(s));   // v40: the band in the EMA's place; v41: the price against its middle
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
