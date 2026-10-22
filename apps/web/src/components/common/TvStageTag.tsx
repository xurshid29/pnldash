import type { TvLine, TvLineName, TvSetupInfo, TvStage, TvStrength } from '../../api/types';

// 📐 VWAP setup stage pill (TradingView webhook, 2026-10-03). Amber → orange →
// green as the reclaim setup matures; blue → red/green for the PULLBACK setup
// (script v10) and its outcome; teal for the VWAP + BB cross (v21, the chart's
// "VB" marker). Used by the 📐 sidebar.
export const TV_STAGE_STYLE: Record<TvStage, { label: string; color: string; bg: string }> = {
  forming: { label: 'FORMING', color: '#ffe58f', bg: '#3d2f00' },
  ready: { label: 'READY', color: '#ffd591', bg: '#612500' },
  go: { label: 'GO', color: '#d9f7be', bg: '#237804' },
  pullback: { label: 'PULLBACK', color: '#bae7ff', bg: '#003a8c' },
  broken: { label: 'BROKEN', color: '#ffccc7', bg: '#5c0011' },
  held: { label: 'HELD', color: '#d9f7be', bg: '#135200' },
  cross: { label: 'CROSS', color: '#b5f5ec', bg: '#00474f' },
  level: { label: 'LEVEL', color: '#d9d9d9', bg: '#262626' },
  break: { label: 'BREAK', color: '#ffffff', bg: '#08979c' },
};

export function isPullbackStage(stage: TvStage): boolean {
  return stage === 'pullback' || stage === 'broken' || stage === 'held';
}

// The VWAP + BB cross's stages: CROSS (v21), LEVEL and BREAK (v25).
export function isVbStage(stage: TvStage): boolean {
  return stage === 'cross' || stage === 'level' || stage === 'break';
}

// The individual lines of a signal (server: tv-setups.ts lineTokens). A
// reclaim signal without a line (before v11) is the month line; the legacy
// 'both' was session + month for PULLBACK, month + year for reclaim. A CROSS
// without a line (script v21) is the session line; v22 names session / month / year.
export function lineTokens(stage: TvStage, line: TvLine | null | undefined): TvLineName[] {
  if (!line) return isPullbackStage(stage) ? [] : isVbStage(stage) ? ['session'] : ['month'];
  if (line === 'both') return isPullbackStage(stage) ? ['session', 'month'] : ['month', 'year'];
  return line.split('+') as TvLineName[];
}

// The line(s) a signal is about, colored like the operator's chart: session
// VWAP purple, month yellow, year blue, several lines white ("S+Y"). Reclaim
// signals on the month line alone — the original setup — carry no tag; PULLBACK
// and CROSS (v22) always do.
const LINE_TAG: Record<TvLineName, { label: string; color: string }> = {
  session: { label: 'S', color: '#b37feb' },
  month: { label: 'M', color: '#fadb14' },
  year: { label: 'Y', color: '#4096ff' },
};
function lineTag(stage: TvStage, line: TvLine | null | undefined): { label: string; color: string } | null {
  const tokens = lineTokens(stage, line);
  if (tokens.length === 0 || (!isPullbackStage(stage) && !isVbStage(stage) && tokens.length === 1 && tokens[0] === 'month')) return null;
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

// v21 CROSS: "5m/2m" — the candle's timeframe over the band's.
export function crossTfText(s: TvSetupInfo): string | null {
  return isVbStage(s.stage) && s.candle_tf ? `${fmtTf(s.candle_tf)}/${fmtTf(s.bb_tf ?? null) || '?'}` : null;
}

// Trail arrows: → while a setup advances, · when a new one starts.
export const TV_STAGE_RANK: Record<TvStage, number> = { forming: 1, ready: 2, go: 3, pullback: 1, broken: 2, held: 2, cross: 1, level: 2, break: 3 };

export function fmtSignedPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// `path` 'fast' (script v2+): the stage came from the fast-approach route —
// price ran at the line while the basis lagged — shown as a small suffix.
// PULLBACK-setup stages show their line (S / M / S+M) and touch number (#1 = first);
// a v21 CROSS its timeframes ("5m/2m", `tfs`) and the day's cross number as `touch`.
export function TvStageTag({ stage, dim, path, line, touch, tfs }: {
  stage: TvStage; dim?: boolean; path?: 'base' | 'fast' | null; line?: TvLine | null; touch?: number | null; tfs?: string | null;
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
      {path === 'fast' && <span style={{ color: '#5cdbd3', fontSize: 10, fontWeight: 700, marginLeft: 3 }}>fast</span>}
      {ln && <span style={{ color: ln.color, fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{ln.label}</span>}
      {tfs && <span style={{ color: '#5cdbd3', fontSize: 10, fontWeight: 700, marginLeft: 3 }}>{tfs}</span>}
      {touch != null && <span style={{ color: touch === 1 ? '#ffffff' : '#8c8c8c', fontSize: 10, fontWeight: 700, marginLeft: 2 }}>#{touch}</span>}
    </span>
  );
}

// GO strength "3/4" pill: green at full marks, amber one short, grey below.
export function StrengthTag({ st }: { st: TvStrength }) {
  const color = st.score === st.max ? '#95de64' : st.score === st.max - 1 ? '#ffd666' : '#8c8c8c';
  return <span style={{ color, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>💪{st.score}/{st.max}</span>;
}

// "morning ✓ · run-up +8.1% ✓ · volume 3.2× ✓ · ⭐ ✗" — which checks a GO passed.
export function strengthText(s: TvSetupInfo): string {
  const st = s.strength;
  if (!st) return '';
  const mark = (b: boolean | null | undefined) => (b ? '✓' : '✗');
  const parts = [`morning ${mark(st.morning)}`];
  if (st.run_up != null) parts.push(`run-up ${fmtSignedPct(s.run_pct).replace('-', '\u2212')} ${mark(st.run_up)}`);
  if (st.volume != null && s.vol_x != null) parts.push(`volume ${s.vol_x.toFixed(1)}× ${mark(st.volume)}`);
  parts.push(`⭐ ${mark(st.on_momentum)}`);
  return parts.join(' · ');
}

// "−5.7% vs mVWAP · basis −5.1%" — where price and the basis sat at the signal.
// PULLBACK setup: "+0.7% vs sVWAP · +51.2% vs mVWAP · ran +17%", its own line first.
// v25: "break > $12.59 · stop $11.80" — the VB candle's trigger and stop.
export function vbTriggerText(s: TvSetupInfo, verb = 'break >'): string | null {
  const px = (p: number) => `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
  return s.level == null ? null : `${verb} ${px(s.level)}${s.stop != null ? ` · stop ${px(s.stop)}` : ''}`;
}

export function tvLevelsText(s: TvSetupInfo): string {
  if (s.stage === 'level' || s.stage === 'break') return vbTriggerText(s, s.stage === 'break' ? 'over' : 'break >') ?? '';
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
  if (isPullbackStage(s.stage)) {
    if (s.stage === 'pullback' && s.peak_pct != null) parts.push(`ran +${Math.round(s.peak_pct)}%`);
    return parts.join(' · ');
  }
  // reclaim: basis % is against the setup's line (the month line on month+year)
  if (s.basis_pct != null) parts.push(`basis ${fmtSignedPct(s.basis_pct).replace('-', '−')}`);
  return parts.join(' · ');
}
