import type { TvSetupInfo, TvStage } from '../../api/types';

// 📐 VWAP setup stage pill (TradingView webhook, 2026-10-03). Amber → orange →
// green as the setup matures; shared by the Alerts log and the 📐 tab.
export const TV_STAGE_STYLE: Record<TvStage, { label: string; color: string; bg: string }> = {
  forming: { label: 'FORMING', color: '#ffe58f', bg: '#3d2f00' },
  ready: { label: 'READY', color: '#ffd591', bg: '#612500' },
  go: { label: 'GO', color: '#d9f7be', bg: '#237804' },
};

// TradingView interval → short label: "1" → 1m, "60" → 1h, "30S" → 30s, "1D" → 1D.
export function fmtTf(tf: string | null | undefined): string {
  if (!tf) return '';
  if (/^\d+$/.test(tf)) {
    const n = Number(tf);
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  return /^\d+S$/i.test(tf) ? tf.toLowerCase() : tf;
}

export const TV_STAGE_RANK: Record<TvStage, number> = { forming: 1, ready: 2, go: 3 };

export function fmtSignedPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

export function TvStageTag({ stage, dim }: { stage: TvStage; dim?: boolean }) {
  const s = TV_STAGE_STYLE[stage];
  return (
    <span
      style={{
        display: 'inline-block', padding: '0 6px', borderRadius: 3, fontWeight: 700, fontSize: 11,
        lineHeight: '18px', color: s.color, background: s.bg, opacity: dim ? 0.55 : 1, whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

// "−5.7% vs mVWAP · basis −5.1%" — where price and the basis sat at the signal.
export function tvLevelsText(s: TvSetupInfo): string {
  const parts: string[] = [];
  if (s.px_pct != null) parts.push(`${fmtSignedPct(s.px_pct).replace('-', '−')} vs mVWAP`);
  if (s.basis_pct != null) parts.push(`basis ${fmtSignedPct(s.basis_pct).replace('-', '−')}`);
  return parts.join(' · ');
}
