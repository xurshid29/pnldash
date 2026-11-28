// Safe numeric formatters. Postgres can return numeric/bigint columns as
// strings — these guard against that so a stray string can't crash the UI.
function asNum(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = typeof n === 'number' ? n : parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

export function fmtPct(n: number | string | null | undefined): string {
  const v = asNum(n);
  return v == null ? '—' : `${v.toFixed(2)}%`;
}

export function fmtFloat(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  return v >= 1 ? `${v.toFixed(1)}M` : `${(v * 1000).toFixed(0)}K`;
}

export function fmtPrice(n: number | string | null | undefined): string {
  const v = asNum(n);
  return v == null ? '—' : `$${v.toFixed(2)}`;
}

export function fmtVolume(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

export function fmtMcap(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(1)}B` : `${v.toFixed(0)}M`;
}

export function fmtRelVol(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}x`;
}

// Big-percent formatter — handles values that can run into the millions (the
// 5-min rel-vol % of an ultra-thin micro-cap on a catalyst can hit 1.9M%).
export function fmtBigPct(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;
}

// The same percent, short, for a line that is short of room (the 📐 sidebar's row lead, a toast):
// under 10,000 the whole number ("8,450%", fmtBigPct); from 10,000 in thousands ("48K%"); from a
// million in millions with one decimal ("1.3M%", "1M%"). Rounded first, so 9,999.6 reads "10K%"
// and 999,600 "1M%", never "10,000%" or "1000K%".
export function fmtBigPctShort(n: number | string | null | undefined): string {
  const v = asNum(n);
  if (v == null) return '—';
  const r = Math.round(v);
  if (Math.abs(r) < 10_000) return fmtBigPct(r);
  const k = Math.round(r / 1000);
  if (Math.abs(k) < 1000) return `${k}K%`;
  return `${(r / 1e6).toFixed(1).replace(/\.0$/, '')}M%`;
}

export function num(n: number | string | null | undefined): number | null {
  return asNum(n);
}

// True when an ISO timestamp is within the last `withinSec` seconds. Drives the
// "just appeared" NEW badge + row highlight on the Ignition / Momentum lists.
// Recomputed each render (SSE cadence ~20s), so the highlight clears within a
// cycle of the window expiring.
export function isFreshArrival(iso: string | null | undefined, withinSec = 75): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < withinSec * 1000;
}
