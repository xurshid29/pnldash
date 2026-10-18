import type { TvBreakout } from '../../api/types';

// The study's gate (research/bb-breakout): on Momentum and either A+ or 10–50%
// over the session VWAP, and (v19) not weak. 🔥 strong did +1.22% a trade on 20
// sessions, 🔥 weak +0.06%.
export function isHot(b: TvBreakout): boolean {
  return b.on_screen && b.strong !== false && (b.grade === 'A+' || (b.spx_pct != null && b.spx_pct >= 10 && b.spx_pct < 50));
}
// v19: why a breakout is weak — the band falling over the last 5 candles, or the
// close more than 10% under the day's high (XLAB 19:30 on 10-16 was both).
export function weakWhy(b: TvBreakout): string | null {
  if (b.strong !== false) return null;
  const why: string[] = [];
  if (b.band_slope != null && b.band_slope < 0) why.push(`band ${b.band_slope.toFixed(1)}%`);
  if (b.off_high != null && b.off_high < -10) why.push(`${Math.round(b.off_high)}% off high`);
  return why.join(', ') || 'weak';
}
