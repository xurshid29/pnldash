"""The BB upper band crossing the VWAP (script v40) — which crosses come from a falling price?
(operator, 2026-11-16, CLRO on a 1m chart: "bb upper row moves away from price if it drops too
fast, and crosses up the near vwap". RBNE and GP the same day were the good kind: the price ran
and took the band over the line.) Measured before changing the script.

Data     as ema_vwap_study.py: every Momentum row → 1m bars, the poller's session VWAP. A ticker's
         bars exist only while it is on our screen: a gap over 6 minutes starts a new run.
Band     the upper Bollinger Band of the 1m closes (--bb-len 20, --bb-mult 2: the last 19 finished
         closes and the current one), its basis (their mean) and lower band. The operator's band
         is on 45s candles from 30s bars; 1m is the nearest our bars allow.
Cross    v40's rule: at a --tf candle's close the band is above the session VWAP and was at or
         under it at the close before (the band as it stands at each candle's last 1m bar).
Features (known at the cross candle's close)
         green     the candle closed above its open
         up        it closed above the candle before
         mid       the close is at or above the band's basis (the middle line)
         midup     the basis is above where it stood at the close before
         pctb      where the close sits between the lower band (0) and the upper band (1)
         dist      how far the band is above the close, %
         avwap     the close is above the VWAP
         widen     the band's width against the close before, % (a drop or a pop widens it)
         under / flips / hour   the v36 filter's readings, on the band
Outcomes (entry at the cross candle's close)
         fell      a candle closes under the cross candle's low within 5 candles
         r5 / r10  the close 5 / 10 candles later against the entry, %
         B         stop a tick under the cross candle's low, target 2R, 20 candles → R (stops under
                   0.5% away left out of the R average)
Split    by date (--cut): in sample before it, out of sample from it. A test counts only if it
         helps in both.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql):
  python band_cross_study.py rows.csv.gz --tf 3 --cut 2026-10-09      # also --tf 1, --tf 5
"""
import argparse, datetime, duckdb, statistics, sys

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--tf', type=int, default=3, help='candle timeframe, minutes')
ap.add_argument('--bb-len', type=int, default=20)
ap.add_argument('--bb-mult', type=float, default=2.0)
ap.add_argument('--split', type=float, default=0.6, help='share of the days used in sample')
ap.add_argument('--cut', help='first out-of-sample day, YYYY-MM-DD (instead of --split)')
args = ap.parse_args()
TF, BN, BM, MAX_GAP = args.tf, args.bb_len, args.bb_mult, 6

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c, arg_max(vwap, ts) as vw
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()


def tick(p):
    return 0.0001 if p < 1 else 0.01


def runs_of(bars):
    """A ticker-day's 1m bars → runs (a gap over MAX_GAP minutes starts a new one)."""
    runs, cur, prev_t = [], [], None
    for b in bars:
        if prev_t is not None and b[0] - prev_t > MAX_GAP:
            runs.append(cur)
            cur = []
        cur.append(b)
        prev_t = b[0]
    if cur:
        runs.append(cur)
    return runs


ROWS = []


def run_day(key, bars):
    ticker, day = key
    for run in runs_of(bars):
        if len(run) < BN + 2 * TF:
            continue
        # the band at each 1m bar, then the candles: each with the band as it stands at its last bar
        closes = [b[4] for b in run]
        cs = []
        for i, (t, o, h, l, c, vw) in enumerate(run):
            band = None
            if i >= BN - 1:
                win = closes[i - BN + 1:i + 1]
                mean = sum(win) / BN
                sd = (sum((x - mean) ** 2 for x in win) / BN) ** 0.5
                band = (mean + BM * sd, mean, mean - BM * sd)
            k = (t - 240) // TF
            if cs and cs[-1]['k'] == k:
                x = cs[-1]
                x['h'] = max(x['h'], h); x['l'] = min(x['l'], l); x['c'] = c; x['vw'] = vw; x['band'] = band
            else:
                cs.append(dict(k=k, t=240 + k * TF, o=o, h=h, l=l, c=c, vw=vw, band=band))
        above = [x['band'] is not None and x['vw'] and x['band'][0] > x['vw'] for x in cs]
        for i in range(1, len(cs)):
            x, p = cs[i], cs[i - 1]
            if x['band'] is None or p['band'] is None or not x['vw'] or not p['vw'] or not (above[i] and not above[i - 1]):
                continue
            up, mid, lo = x['band']
            entry = x['c']
            under = 0
            j = i - 1
            while j >= 0 and cs[j]['band'] is not None and not above[j]:
                under += 1
                j -= 1
            flips = sum(1 for k in range(max(1, i - 19), i) if cs[k]['band'] is not None and cs[k - 1]['band'] is not None and above[k] != above[k - 1])
            fell = any(cs[k]['c'] < x['l'] for k in range(i + 1, min(i + 6, len(cs))))
            r5 = (cs[min(i + 5, len(cs) - 1)]['c'] / entry - 1) * 100
            r10 = (cs[min(i + 10, len(cs) - 1)]['c'] / entry - 1) * 100
            stop = x['l'] - tick(entry)
            b_r = b_out = None
            if 0 < stop < entry:
                risk = (entry - stop) / entry
                tgt = entry + 2 * (entry - stop)
                b_out, b_ret = 'time', None
                for k in range(i + 1, min(i + 21, len(cs))):
                    if cs[k]['l'] <= stop:
                        b_out, b_ret = 'stop', min(stop, cs[k]['o']) / entry - 1
                        break
                    if cs[k]['h'] >= tgt:
                        b_out, b_ret = 'win', tgt / entry - 1
                        break
                if b_ret is None:
                    b_ret = cs[min(i + 20, len(cs) - 1)]['c'] / entry - 1
                b_r = b_ret / risk if risk >= 0.005 else None
            pw = p['band'][0] - p['band'][2]
            ROWS.append(dict(
                ticker=ticker, day=day, t=x['t'], px=entry, green=entry > x['o'], up=entry > p['c'], mid=entry >= mid,
                midup=mid > p['band'][1], pctb=(entry - lo) / (up - lo) if up > lo else 0.5, dist=(up / entry - 1) * 100,
                avwap=entry > x['vw'], widen=((up - lo) / pw - 1) * 100 if pw > 0 else 0.0, under=under, flips=flips,
                fell=fell, r5=r5, r10=r10, b_r=b_r, b_win=b_out == 'win', b_has=b_out is not None))


cur = con.execute("select ticker, day, tmin, o, h, l, c, vw from bars order by ticker, day, tmin")
key, day_bars = None, []
while True:
    chunk = cur.fetchmany(200_000)
    if not chunk:
        break
    for r in chunk:
        kk = (r[0], r[1])
        if kk != key:
            if day_bars:
                run_day(key, day_bars)
            key, day_bars = kk, []
        if r[6] is not None and r[7] is not None and r[7] > 0:
            day_bars.append(tuple(r[2:]))
if day_bars:
    run_day(key, day_bars)

days = sorted({r['day'] for r in ROWS})
cut = datetime.date.fromisoformat(args.cut) if args.cut else days[int(len(days) * args.split)]
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | {TF}m candles, the upper band of {BN} 1m closes × {BM:g} | "
      f"{len(ROWS):,} band crosses ({len(ROWS) / max(len(days), 1):.0f} a day) | in sample before {cut}")


def summ(rows):
    if not rows:
        return None
    n = len(rows)
    b = [r for r in rows if r['b_has']]
    br = [r['b_r'] for r in rows if r['b_r'] is not None]
    return dict(n=n, fell=sum(r['fell'] for r in rows) / n * 100, r5=statistics.mean(r['r5'] for r in rows),
                r10=statistics.mean(r['r10'] for r in rows), up5=sum(r['r5'] > 0 for r in rows) / n * 100,
                b_r=statistics.mean(br) if br else 0.0, b_win=sum(r['b_win'] for r in b) / len(b) * 100 if b else 0.0)


def fmt(s):
    return ('     —' if s is None else
            f"{s['n']:>6,}  fell {s['fell']:4.0f}%  5 later {s['r5']:+5.2f}% (up {s['up5']:3.0f}%)  10 later {s['r10']:+5.2f}%  B {s['b_r']:+5.2f}R (2R first {s['b_win']:3.0f}%)")


def helps(s, b):
    return s is not None and b is not None and s['n'] >= 100 and s['fell'] < b['fell'] and s['r5'] > b['r5'] and s['b_r'] > b['b_r']


def table(title, rows, rules, base_name='all of them'):
    i_s, o_s = [r for r in rows if r['day'] < cut], [r for r in rows if r['day'] >= cut]
    bi, bo = summ(i_s), summ(o_s)
    print(f"\n{title}")
    print(f"  {base_name:<50} in  {fmt(bi)}\n  {'':<50} out {fmt(bo)}")
    for name, f in rules:
        si, so = summ([r for r in i_s if f(r)]), summ([r for r in o_s if f(r)])
        share = f"{(si['n'] if si else 0) / max(len(i_s), 1) * 100:.0f}% / {(so['n'] if so else 0) / max(len(o_s), 1) * 100:.0f}%"
        ok = helps(si, bi) and helps(so, bo)
        print(f"{'✓' if ok else ' '} {name + ' (' + share + ')':<50} in  {fmt(si)}\n  {'':<50} out {fmt(so)}")


RULES = [
    ('green candle', lambda r: r['green']),
    ('red or flat candle', lambda r: not r['green']),
    ('closed above the candle before', lambda r: r['up']),
    ('closed at or under the candle before', lambda r: not r['up']),
    ('close at or above the basis (middle)', lambda r: r['mid']),
    ('close under the basis', lambda r: not r['mid']),
    ('basis rising', lambda r: r['midup']),
    ('basis flat or falling', lambda r: not r['midup']),
    ('close above the VWAP', lambda r: r['avwap']),
    ('close at or under the VWAP', lambda r: not r['avwap']),
    ('close in the upper quarter of the bands', lambda r: r['pctb'] >= 0.75),
    ('close in the lower half of the bands', lambda r: r['pctb'] < 0.5),
    ('close in the lower quarter of the bands', lambda r: r['pctb'] < 0.25),
    ('green + at or above the basis', lambda r: r['green'] and r['mid']),
    ('at or above the basis + basis rising', lambda r: r['mid'] and r['midup']),
    ('under the basis + basis falling (the CLRO kind)', lambda r: not r['mid'] and not r['midup']),
    ('the v36 filter: under ≥ 5, flips ≤ 2, from 07:00', lambda r: r['under'] >= 5 and r['flips'] <= 2 and r['t'] >= 420),
    ('…and at or above the basis', lambda r: r['under'] >= 5 and r['flips'] <= 2 and r['t'] >= 420 and r['mid']),
]
table('every band cross, by what the price was doing', ROWS, RULES)

print("\nby bucket, all days")
for title, key_, edges in [('where the close sits in the bands (0 = lower band, 1 = upper band)', 'pctb', [-10**9, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0, 10**9]),
                           ('the band above the close, %', 'dist', [-10**9, 0, 0.5, 1, 2, 4, 8, 10**9]),
                           ('the band\'s width against the close before, %', 'widen', [-10**9, -5, 0, 5, 15, 40, 10**9])]:
    print(f"  {title}")
    for lo, hi in zip(edges, edges[1:]):
        rows = [r for r in ROWS if lo <= r[key_] < hi]
        label = f"{lo:g}+" if hi >= 10**9 else f"under {hi:g}" if lo <= -10**9 else f"{lo:g} to {hi:g}"
        print(f"    {label:<14}{fmt(summ(rows))}")
