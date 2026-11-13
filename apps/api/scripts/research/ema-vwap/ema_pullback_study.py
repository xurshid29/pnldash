"""EMA cross over VWAP — is the pullback after the cross a better entry than the cross itself?
(operator, 2026-11-13, PARA on a 3m chart with v36's marks: "maybe, pullback or bounce from ema
and/or vwap can help?") Measured before building anything.

Data     as ema_vwap_study.py: every Momentum row → 1m bars → --tf minute candles, the poller's
         session VWAP, runs split at gaps over 6 minutes, 15 candles of warm-up per run.
Cross    the script's rule: the EMA (--len) of the closes above the VWAP at a candle's close, at or
         under it at the close before. `weak` is v36's filter (before 07:00 ET, under the line for
         fewer than 5 candles, or more than 2 flips in the 20 before).
Entries  one per cross, the first that comes within --wait candles after the cross candle:
         cross     the cross candle's close (what v35 / v36 announce) — the baseline
         next      the first later candle that closes green above the EMA and the VWAP, no touch
                   needed — the control: is it the pullback that helps, or just waiting?
         ema       a candle's low comes down to the EMA (at or under it, or within --tol-ema % above),
                   then that candle or a later one closes green above the EMA and the VWAP
         vwap      the same against the VWAP (within --tol-vwap %, as the VB's RETEST)
         either    whichever of the two comes first
         A candle closing under the VWAP before the entry ends the wait (no entry).
Outcomes false     a candle closes under the VWAP within 5 candles after the entry
         B         cross: stop a tick under the lower of the cross candle's low and the VWAP;
                   the others: a tick under the lowest low from the touch to the entry candle
                   (next: the entry candle's low). Target 2R, 20 candles → R; stops under 0.5% away
                   are left out of the R average (their share is printed). `%` is the same trade's
                   return in % (all trades).
         per cross = the entry's share of the crosses × its average R: what waiting for it is
                   worth per signal, the crosses that never pull back counted as no trade.
Split    by date, the first --split of the days in sample, the rest out of sample.

Run:  python ema_pullback_study.py rows.csv.gz [--tf 3] [--len 9] [--wait 10] [--split 0.6]
"""
import argparse, duckdb, statistics, sys

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--tf', type=int, default=3, help='candle timeframe, minutes')
ap.add_argument('--len', type=int, default=9, help='EMA length')
ap.add_argument('--wait', type=int, default=10, help='candles after the cross candle an entry may come in')
ap.add_argument('--tol-ema', type=float, default=0.0, help='a low within this %% above the EMA counts as a touch')
ap.add_argument('--tol-vwap', type=float, default=1.0, help='a low within this %% above the VWAP counts as a touch')
ap.add_argument('--split', type=float, default=0.6, help='share of the days used in sample')
args = ap.parse_args()
TF, N, MAX_GAP, WARM, WAIT = args.tf, args.len, 6, 15, args.wait
TOL_E, TOL_V = args.tol_ema / 100, args.tol_vwap / 100

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
n_days = con.execute("select count(distinct (ticker, day)) from bars").fetchone()[0]
span = con.execute("select min(day), max(day) from bars").fetchone()


def tick(p):
    return 0.0001 if p < 1 else 0.01


def runs_of(bars):
    runs, cur, prev_t = [], [], None
    for t, o, h, l, c, vw in bars:
        if prev_t is not None and t - prev_t > MAX_GAP:
            runs.append(cur)
            cur = []
        k = (t - 240) // TF
        if cur and cur[-1]['k'] == k:
            x = cur[-1]
            x['h'] = max(x['h'], h); x['l'] = min(x['l'], l); x['c'] = c; x['vw'] = vw
        else:
            cur.append(dict(k=k, t=240 + k * TF, o=o, h=h, l=l, c=c, vw=vw))
        prev_t = t
    if cur:
        runs.append(cur)
    return runs


def trade(cs, k, stop):
    """Entry at candle k's close, a stop, a 2R target, 20 candles → (false5, R or None, %, won, stop distance %)."""
    entry = cs[k]['c']
    false5 = any(cs[m]['c'] < cs[m]['vw'] for m in range(k + 1, min(k + 6, len(cs))))
    if not (0 < stop < entry):
        return None
    risk = (entry - stop) / entry
    tgt = entry + 2 * (entry - stop)
    out, ret = 'time', None
    for m in range(k + 1, min(k + 21, len(cs))):
        if cs[m]['l'] <= stop:
            out, ret = 'stop', min(stop, cs[m]['o']) / entry - 1
            break
        if cs[m]['h'] >= tgt:
            out, ret = 'win', tgt / entry - 1
            break
    if ret is None:
        ret = cs[min(k + 20, len(cs) - 1)]['c'] / entry - 1
    return dict(false5=false5, r=ret / risk if risk >= 0.005 else None, pct=ret * 100, won=out == 'win', risk=risk * 100)


def find_entry(cs, ema, i, kind):
    """The first entry of `kind` within WAIT candles after cross candle i → (entry candle, stop, the
    high above the cross close before the touch in %, candles after the cross), or None."""
    touched, low_p = kind == 'next', None
    ran = 0.0
    for j in range(i + 1, min(i + 1 + WAIT, len(cs))):
        c = cs[j]
        at_e = c['l'] <= ema[j] * (1 + TOL_E)
        at_v = c['l'] <= c['vw'] * (1 + TOL_V)
        hit = at_e if kind == 'ema' else at_v if kind == 'vwap' else (at_e or at_v) if kind == 'either' else False
        if hit:
            touched = True
        if not touched:
            ran = max(ran, (c['h'] / cs[i]['c'] - 1) * 100)
        if touched and kind != 'next':
            low_p = c['l'] if low_p is None else min(low_p, c['l'])
        if c['c'] < c['vw']:
            return None                      # a close under the VWAP ends the wait
        if touched and c['c'] > c['o'] and c['c'] > ema[j]:
            stop = (c['l'] if kind == 'next' else low_p) - tick(c['c'])
            return j, stop, ran, j - i
    return None


KINDS = ['cross', 'next', 'ema', 'vwap', 'either']
ROWS = []     # one per cross: day, t, weak, and per kind the trade (or None)


def run_day(key, bars):
    ticker, day = key
    for cs in runs_of(bars):
        if len(cs) <= WARM + 1:
            continue
        alpha, e, ema = 2.0 / (N + 1), None, []
        for x in cs:
            e = x['c'] if e is None else alpha * x['c'] + (1 - alpha) * e
            ema.append(e)
        above = [ema[i] > x['vw'] for i, x in enumerate(cs)]
        for i in range(WARM, len(cs)):
            if not (above[i] and not above[i - 1]):
                continue
            x = cs[i]
            under, j = 0, i - 1
            while j >= 0 and not above[j]:
                under += 1
                j -= 1
            lo = max(0, i - 20)
            flips = sum(1 for k in range(lo + 1, i) if above[k] != above[k - 1])
            row = dict(day=day, t=x['t'], weak=x['t'] < 420 or under < 5 or flips > 2)
            row['cross'] = trade(cs, i, min(x['l'], x['vw']) - tick(x['c']))
            if row['cross'] is not None:
                row['cross'].update(ran=0.0, after=0)
            for kind in KINDS[1:]:
                got = find_entry(cs, ema, i, kind)
                tr = None
                if got is not None:
                    k, stop, ran, after = got
                    tr = trade(cs, k, stop)
                    if tr is not None:
                        tr.update(ran=ran, after=after, gap=(ema[k] / cs[k]['vw'] - 1) * 100, vs_cross=(cs[k]['c'] / x['c'] - 1) * 100)
                row[kind] = tr
            ROWS.append(row)


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
cut = days[int(len(days) * args.split)]
print(f"{n_days:,} ticker-days, {span[0]} → {span[1]} | {TF}m candles, EMA {N} | {len(ROWS):,} crosses | an entry within {WAIT} candles "
      f"({WAIT * TF} min) | touch: EMA +{args.tol_ema:g}%, VWAP +{args.tol_vwap:g}% | in sample before {cut}")


def summ(rows, kind):
    tr = [r[kind] for r in rows if r[kind] is not None]
    if not rows or not tr:
        return None
    rs = [t['r'] for t in tr if t['r'] is not None]
    share = len(tr) / len(rows)
    mean_r = statistics.mean(rs) if rs else 0.0
    return dict(n=len(tr), share=share * 100, false=sum(t['false5'] for t in tr) / len(tr) * 100, r=mean_r,
                won=sum(t['won'] for t in tr) / len(tr) * 100, pct=statistics.mean(t['pct'] for t in tr),
                risk=statistics.median(t['risk'] for t in tr), tight=(len(tr) - len(rs)) / len(tr) * 100,
                per_cross=share * len(rs) / len(tr) * mean_r)


def fmt(s):
    if s is None:
        return '      —'
    return (f"{s['n']:>5,} ({s['share']:3.0f}%)  false {s['false']:3.0f}%  B {s['r']:+5.2f}R  2R first {s['won']:3.0f}%  {s['pct']:+5.2f}%/trade  "
            f"stop {s['risk']:4.1f}% (tight {s['tight']:2.0f}%)  per cross {s['per_cross']:+5.2f}R")


def table(title, pick):
    print(f"\n== {title} ==")
    for kind in KINDS:
        a = [r for r in ROWS if r['day'] < cut and pick(r)]
        b = [r for r in ROWS if r['day'] >= cut and pick(r)]
        print(f"  {kind:<7} in  {fmt(summ(a, kind))}\n  {'':<7} out {fmt(summ(b, kind))}")


table('all crosses', lambda r: True)
table("strong crosses (v36's filter keeps them)", lambda r: not r['weak'])
table("weak crosses (v36's filter drops them)", lambda r: r['weak'])
table('regular hours, 09:30–16:00 ET', lambda r: 570 <= r['t'] < 960)
table('strong, 09:30–11:00 ET', lambda r: not r['weak'] and 570 <= r['t'] < 660)

# The crosses the pullback entry never takes: what did buying the cross do on those?
print('\n== the crosses with no pullback entry: the cross entry on them (the runs waiting misses) ==')
for kind in ['ema', 'vwap', 'either']:
    for name, rows in (('in ', [r for r in ROWS if r['day'] < cut]), ('out', [r for r in ROWS if r['day'] >= cut])):
        miss = [r for r in rows if r[kind] is None]
        took = [r for r in rows if r[kind] is not None]
        print(f"  no {kind:<6} entry {name} {fmt(summ(miss, 'cross'))}\n  had one         {name} {fmt(summ(took, 'cross'))}")


def buckets(title, kind, field, edges):
    print(f"\n== {kind} entry by {title} ==")
    for lo, hi in zip(edges, edges[1:]):
        label = f"{lo:g}+" if hi >= 10**9 else f"{lo:g} to {hi:g}"
        for name, rows in (('in ', [r for r in ROWS if r['day'] < cut]), ('out', [r for r in ROWS if r['day'] >= cut])):
            sel = [r for r in rows if r[kind] is not None and lo <= r[kind][field] < hi]
            tr = [r[kind] for r in sel]
            rs = [t['r'] for t in tr if t['r'] is not None]
            if tr:
                print(f"  {label:<10} {name} {len(tr):>5,}  false {sum(t['false5'] for t in tr) / len(tr) * 100:3.0f}%  "
                      f"B {statistics.mean(rs) if rs else 0:+5.2f}R  2R first {sum(t['won'] for t in tr) / len(tr) * 100:3.0f}%  {statistics.mean(t['pct'] for t in tr):+5.2f}%/trade")


for kind in ['ema', 'vwap']:
    buckets('candles after the cross', kind, 'after', [1, 2, 4, 7, 10**9])
    buckets('the run above the cross close before the touch, %', kind, 'ran', [0, 1, 3, 6, 10**9])
    buckets('the EMA above the VWAP at the entry, %', kind, 'gap', [0, 0.5, 1.5, 3, 10**9])
    buckets('the entry against the cross close, %', kind, 'vs_cross', [-10**9, -1, 0, 1, 3, 10**9])
