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

// v21 CROSS / v28 RETEST: "5m/45s" — the candle's timeframe over the band's.
export function crossTfText(s: TvSetupInfo): string | null {
  return isVbStage(s.stage) && s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
}

// Trail arrows: → while a setup advances, · when a new one starts.
export const TV_STAGE_RANK: Record<TvStage, number> = { pullback: 1, broken: 2, held: 2, cross: 1, retest: 2 };

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
// against the RETEST price.
export function retestStopText(s: TvSetupInfo, price: number | null | undefined): string | null {
  if (s.stop == null) return null;
  const px = (p: number) => `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
  const pct = price != null && price > 0 ? ` (${fmtSignedPct((s.stop / price - 1) * 100).replace('-', '−')})` : '';
  return `retest · stop ${px(s.stop)}${pct}`;
}

// Where price sat at the signal. PULLBACK setup: "+0.7% vs sVWAP · +51.2% vs mVWAP ·
// ran +17%", its own line first.
export function tvLevelsText(s: TvSetupInfo, price?: number | null): string {
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
