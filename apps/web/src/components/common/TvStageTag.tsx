import type { TvLine, TvSetupInfo, TvStage, TvStrength } from '../../api/types';

// 📐 VWAP setup stage pill (TradingView webhook, 2026-10-03). Amber → orange →
// green as the reclaim setup matures; blue → red/green for the PULLBACK setup
// (script v10) and its outcome. Shared by the Alerts log and the 📐 tab.
export const TV_STAGE_STYLE: Record<TvStage, { label: string; color: string; bg: string }> = {
  forming: { label: 'FORMING', color: '#ffe58f', bg: '#3d2f00' },
  ready: { label: 'READY', color: '#ffd591', bg: '#612500' },
  go: { label: 'GO', color: '#d9f7be', bg: '#237804' },
  pullback: { label: 'PULLBACK', color: '#bae7ff', bg: '#003a8c' },
  broken: { label: 'BROKEN', color: '#ffccc7', bg: '#5c0011' },
  held: { label: 'HELD', color: '#d9f7be', bg: '#135200' },
};

export function isPullbackStage(stage: TvStage): boolean {
  return stage === 'pullback' || stage === 'broken' || stage === 'held';
}

// The line a signal is about, colored like the operator's chart: session VWAP
// purple, month yellow, year blue. 'both' = the setup's two lines (S+M for a
// pullback, M+Y for a reclaim). Reclaim signals on the month line — the
// original setup — carry no tag.
const LINE_TAG: Record<Exclude<TvLine, 'both'>, { label: string; color: string }> = {
  session: { label: 'S', color: '#b37feb' },
  month: { label: 'M', color: '#fadb14' },
  year: { label: 'Y', color: '#4096ff' },
};
function lineTag(stage: TvStage, line: TvLine | null | undefined): { label: string; color: string } | null {
  if (!line) return null;
  if (line === 'both') return { label: isPullbackStage(stage) ? 'S+M' : 'M+Y', color: '#ffffff' };
  if (line === 'month' && !isPullbackStage(stage)) return null;
  return LINE_TAG[line];
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

// Trail arrows: → while a setup advances, · when a new one starts.
export const TV_STAGE_RANK: Record<TvStage, number> = { forming: 1, ready: 2, go: 3, pullback: 1, broken: 2, held: 2 };

export function fmtSignedPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// `path` 'fast' (script v2+): the stage came from the fast-approach route —
// price ran at the line while the basis lagged — shown as a small suffix.
// PULLBACK-setup stages show their line (S / M / S+M) and touch number (#1 = first).
export function TvStageTag({ stage, dim, path, line, touch }: {
  stage: TvStage; dim?: boolean; path?: 'base' | 'fast' | null; line?: TvLine | null; touch?: number | null;
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
export function tvLevelsText(s: TvSetupInfo): string {
  const parts: string[] = [];
  if (isPullbackStage(s.stage)) {
    const sv = s.spx_pct != null ? `${fmtSignedPct(s.spx_pct).replace('-', '−')} vs sVWAP` : null;
    const mv = s.px_pct != null ? `${fmtSignedPct(s.px_pct).replace('-', '−')} vs mVWAP` : null;
    parts.push(...(s.line === 'month' ? [mv, sv] : [sv, mv]).filter((p): p is string => p != null));
    if (s.stage === 'pullback' && s.peak_pct != null) parts.push(`ran +${Math.round(s.peak_pct)}%`);
    return parts.join(' · ');
  }
  // reclaim setup: its own line first (v11 adds the year line); basis % is against that line
  const mv = s.px_pct != null ? `${fmtSignedPct(s.px_pct).replace('-', '−')} vs mVWAP` : null;
  const yv = s.ypx_pct != null ? `${fmtSignedPct(s.ypx_pct).replace('-', '−')} vs yVWAP` : null;
  if (s.line === 'year') parts.push(...[yv].filter((p): p is string => p != null));
  else if (s.line === 'both') parts.push(...[mv, yv].filter((p): p is string => p != null));
  else if (mv) parts.push(mv);
  if (s.basis_pct != null) parts.push(`basis ${fmtSignedPct(s.basis_pct).replace('-', '−')}`);
  return parts.join(' · ');
}
