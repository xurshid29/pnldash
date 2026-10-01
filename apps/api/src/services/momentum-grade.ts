// Momentum letter grade (A+ … D) — "how likely is a tradeable +10% move from
// HERE in the next 30 minutes", per Momentum row, every cycle.
//
// Origin (2026-10-01): the operator asked for a Ross-Cameron-style ranking
// next to each Momentum ticker. Ross's five criteria were tested on our own
// data first: change %, time of day, catalyst and float carry signal; his
// $2–20 price band and day-RVol ≥5× do not (inside our screen). The grade is
// therefore FITTED, not hand-weighted:
//
//   • Unit: one Momentum row per 20s cycle (what the dashboard displays).
//   • Label: price touches +10% above the current price within 30 minutes
//     while still on our screen.
//   • Fit: August 2026 (3.29M rows). Each feature bucket earns points =
//     log-odds lift over the base rate (smoothed toward the base, A=200) —
//     an additive naive-Bayes score, transparent and cheap.
//   • Test: September 2026 (3.35M rows), never seen by the fit. Letters are
//     cut at AUGUST percentiles of the 2-minute (6-cycle) rolling mean of the
//     score: A+ top 3%, A next 4%, A− next 5%, B+ next 8%, B next 10%,
//     B− next 10%, C next 25%, D the bottom 35%.
//
// Out-of-sample (September) P(+10% within 30 min) by letter:
//   A+ 26.8%  A 18.5%  A− 11.3%  B+ 7.4%  B 3.8%  B− 1.7%  C 0.3%  D 0.1%
// A-tier (A+/A/A−, ~11% of rows) hit 17.2% vs 13.5% for the top 12% by Heat.
// Path check (which comes first within 30 min, +10% or −10%):
//   A+ 25.0% up-first / 29.8% down-first   A 17.8/15.2   A− 11.0/6.5   B+ 7.3/3.1
// → the grade ranks WHERE the big moves happen; A+ is a two-way market, not a
// directional call. It is an attention ranking, not an entry signal.
//
// Research scripts: apps/api/scripts/research/momentum-grade/ (export SQL +
// DuckDB study). Re-fit there before touching POINTS/CUTS by hand — every
// number below is a fitted output.

export interface GradeInputs {
  changePct: number | null;   // the row's change % as displayed (AH rows = AH overlay)
  floatM: number | null;
  price: number | null;
  etMinute: number;           // minute of day in ET, 0–1439
  catImpact: number | null;   // best NON-bearish classified impact in the prior 16h
  newsCount: number;          // all linked articles in the prior 16h (any class)
  ageMin: number;             // minutes since first seen today
  accelDelta: number | null;  // null = change % did not move this cycle (or first sight)
  relVol1min: number | null;
  relVol5min: number | null;
  aboveVwap: boolean | null;  // null = no volume traded since we started tracking
}

// Fitted points (August 2026). Keys are the study's bucket labels so a re-fit
// can be pasted straight in.
const POINTS: Record<string, number> = {
  'chg a <10': -0.76, 'chg b 10-20': -0.47, 'chg c 20-50': 0.05, 'chg d 50-100': 0.91, 'chg e 100+': 1.4,
  'flt a <2M': 0.42, 'flt b 2-5M': 0.13, 'flt c 5-10M': -0.04, 'flt d 10-20M': 0.08, 'flt e 20M+': -0.77,
  'px a <1': 0.16, 'px b 1-2': 0.02, 'px c 2-5': -0.02, 'px d 5-20': -0.07, 'px e 20+': -0.74,
  'tod a PM<7': -0.38, 'tod b PM 7-9:30': 0.91, 'tod c 9:30-11': 1.0, 'tod d 11-16': 0.31, 'tod e AH': -0.76,
  'cat a none': -0.37, 'cat b bearish/unscored': 0.18, 'cat c weak': 0.1, 'cat d strong': 0.86, 'cat e major': 0.41,
  'age a <5m': 0.97, 'age b 5-15m': 0.8, 'age c 15-60m': 0.4, 'age d 60m+': -0.15,
  'acc ?': -1.28, 'acc a >2': 2.26, 'acc b 0-2': 1.08, 'acc c <=0': 1.35,
  'vol ?': 0.72, 'vol a burst': 2.25, 'vol b normal': -0.54, 'vol c drying': 0.39,
  'vwap ?': -2.79, 'vwap a above': 0.68, 'vwap b below': 0.53,
};

// Letter cut-offs on the 6-cycle rolling mean (August percentiles) — exact
// fitted values; rounding them flips rows that sit on a boundary.
export const GRADE_CUTS: ReadonlyArray<readonly [string, number]> = [
  ['A+', 4.516099999999472], ['A', 2.615], ['A-', 1.565], ['B+', 0.4216666666666667], ['B', -0.9116666666666666], ['B-', -2.155], ['C', -4.66],
];
export const GRADE_SMOOTH_CYCLES = 6; // 2 minutes at the 20s poll

export type MomentumGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C' | 'D';

// Bucket labels — MUST mirror the study's SQL CASE expressions exactly
// (boundaries and null handling). verify-momentum-grade.ts pins them.
export function gradeBuckets(x: GradeInputs): string[] {
  const b: string[] = [];
  const c = x.changePct;
  if (c != null) b.push(c < 10 ? 'chg a <10' : c < 20 ? 'chg b 10-20' : c < 50 ? 'chg c 20-50' : c < 100 ? 'chg d 50-100' : 'chg e 100+');
  const f = x.floatM;
  if (f != null) b.push(f < 2 ? 'flt a <2M' : f < 5 ? 'flt b 2-5M' : f < 10 ? 'flt c 5-10M' : f < 20 ? 'flt d 10-20M' : 'flt e 20M+');
  const p = x.price;
  if (p != null) b.push(p < 1 ? 'px a <1' : p < 2 ? 'px b 1-2' : p < 5 ? 'px c 2-5' : p <= 20 ? 'px d 5-20' : 'px e 20+');
  const t = x.etMinute;
  b.push(t < 420 ? 'tod a PM<7' : t < 570 ? 'tod b PM 7-9:30' : t < 660 ? 'tod c 9:30-11' : t < 960 ? 'tod d 11-16' : 'tod e AH');
  b.push(
    x.catImpact == null
      ? (x.newsCount > 0 ? 'cat b bearish/unscored' : 'cat a none')
      : x.catImpact < 40 ? 'cat c weak' : x.catImpact < 70 ? 'cat d strong' : 'cat e major',
  );
  const a = x.ageMin;
  b.push(a < 5 ? 'age a <5m' : a < 15 ? 'age b 5-15m' : a < 60 ? 'age c 15-60m' : 'age d 60m+');
  const d = x.accelDelta;
  b.push(d == null ? 'acc ?' : d > 2 ? 'acc a >2' : d > 0 ? 'acc b 0-2' : 'acc c <=0');
  const r1 = x.relVol1min, r5 = x.relVol5min;
  b.push(
    r1 == null || r5 == null ? 'vol ?'
      : r1 >= 4000 && r5 >= 5000 ? 'vol a burst'
        : r5 > 0 && r1 < 0.5 * r5 ? 'vol c drying'
          : 'vol b normal',
  );
  b.push(x.aboveVwap == null ? 'vwap ?' : x.aboveVwap ? 'vwap a above' : 'vwap b below');
  return b;
}

export function gradeScore(x: GradeInputs): number {
  let s = 0;
  for (const k of gradeBuckets(x)) s += POINTS[k] ?? 0;
  return s;
}

// Scores are sums of 2-decimal points, so many rows land EXACTLY on a cut;
// the study summed exact decimals while JS doubles can fall a hair short
// (2.6149999… vs 2.615). The epsilon restores the study's `>=` on ties.
const CUT_EPS = 1e-6;

export function letterFor(smoothed: number): MomentumGrade {
  for (const [letter, cut] of GRADE_CUTS) if (smoothed >= cut - CUT_EPS) return letter as MomentumGrade;
  return 'D';
}

// Per-ticker rolling mean over the last GRADE_SMOOTH_CYCLES on-screen cycles —
// the same window the study validated (consecutive appearances of the ticker
// that ET day). Cuts flicker ~24 → ~9 letter changes per ticker-hour at equal
// accuracy. Reset at midnight ET with the rest of the poller's day state.
export class MomentumGrader {
  private hist = new Map<string, number[]>();

  grade(ticker: string, x: GradeInputs): { grade: MomentumGrade; score: number; raw: number } {
    const raw = gradeScore(x);
    let h = this.hist.get(ticker);
    if (!h) { h = []; this.hist.set(ticker, h); }
    h.push(raw);
    if (h.length > GRADE_SMOOTH_CYCLES) h.shift();
    const score = h.reduce((a, v) => a + v, 0) / h.length;
    return { grade: letterFor(score), score: Math.round(score * 100) / 100, raw: Math.round(raw * 100) / 100 };
  }

  reset(): void {
    this.hist.clear();
  }
}
