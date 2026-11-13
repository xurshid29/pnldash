"""EMA cross over VWAP — which crosses are false, and does any filter help? (operator, 2026-11-13,
PARA on a 3m chart: "is there anyway we can filter/optimize the false ones?", with a video whose
optimized ADX / time-window / ATR settings failed out of sample.) Measured before building anything.

Data     every Momentum row (../vwap-pullback/export-rows.sql) → 1m bars (close = the minute's last
         20s snapshot, high / low = its extremes, the poller's session VWAP, the day's cumulative
         volume), then --tf minute candles. A ticker's bars exist only while it is on our screen: a
         gap over 6 minutes starts a new run, and each run warms up 15 candles before a cross counts
         (TradingView's EMA carries over from the day before; ours can't).
Cross    the script's v35 rule: the EMA (--len) of the candle closes is above the session VWAP at a
         candle's close and was at or under it at the close before.
Features (known at the cross candle's close)
         under     candles in a row the EMA had been at or under the VWAP
         flips     EMA / VWAP crossings, either way, in the 20 candles before (chop)
         gap       the widest EMA-to-VWAP distance in the 10 candles before, % (lines glued together)
         adx       ADX(14) of the candles (the video's chop filter)
         volx      the cross candle's volume ÷ the average of the 20 before
         over      the cross candle's close above the VWAP, %
         slope     the VWAP now against 10 candles ago, %
         brk       the close is the highest close of the last 20 candles
         rsi       RSI(14) of the candle closes
         n         the day's cross number in this run; tod, the time of day; chg, the day's change %
Outcomes (entry at the cross candle's close)
         false     a candle closes back under the VWAP within 5 candles
         A         exit when a candle closes under the EMA (the video's exit), 40 candles at most → %
         B         stop a tick under the lower of the cross candle's low and the VWAP, target 2R,
                   20 candles → R (stops under 0.5% away left out of the R average), like the VB studies
Split    by date: the first --split of the days (in sample) against the rest (out of sample). A
         filter counts only if it helps in both.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql, outside 07:00–11:00 ET):
  python ema_vwap_study.py rows.csv.gz [--tf 3] [--len 9] [--split 0.6]
"""
import argparse, datetime, duckdb, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--tf', type=int, default=3, help='candle timeframe, minutes')
ap.add_argument('--len', type=int, default=9, help='EMA length')
ap.add_argument('--split', type=float, default=0.6, help='share of the days used in sample')
args = ap.parse_args()
TF, N, MAX_GAP, WARM = args.tf, args.len, 6, 15

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         try_cast(volume as double) as vol, try_cast(change_pct as double) as chg,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw, arg_max(vol, ts) as cv, max(chg) as chg
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()


def tick(p):
    return 0.0001 if p < 1 else 0.01


def runs_of(bars):
    """A ticker-day's 1m bars → runs of candles (a gap over MAX_GAP minutes starts a new run)."""
    runs, cur, prev_t = [], [], None
    for t, o, h, l, c, vw, cv, chg in bars:
        if prev_t is not None and t - prev_t > MAX_GAP:
            runs.append(cur)
            cur = []
        k = (t - 240) // TF
        if cur and cur[-1]['k'] == k:
            x = cur[-1]
            x['h'] = max(x['h'], h); x['l'] = min(x['l'], l); x['c'] = c; x['vw'] = vw; x['cv'] = cv
            x['chg'] = chg if x['chg'] is None else max(x['chg'], chg if chg is not None else x['chg'])
        else:
            cur.append(dict(k=k, t=240 + k * TF, o=o, h=h, l=l, c=c, vw=vw, cv=cv, chg=chg))
        prev_t = t
    if cur:
        runs.append(cur)
    return runs


def wilder(values, n):
    """Wilder's smoothing (rma), seeded with the mean of the first n values; None before."""
    out, s = [], None
    for i, v in enumerate(values):
        if s is None:
            s = sum(values[:n]) / n if i + 1 == n else None
        else:
            s = (s * (n - 1) + v) / n
        out.append(s)
    return out


def indicators(cs):
    """Per candle: EMA, RSI(14), ADX(14), the candle's own volume."""
    alpha = 2.0 / (N + 1)
    e, ema = None, []
    for x in cs:
        e = x['c'] if e is None else alpha * x['c'] + (1 - alpha) * e
        ema.append(e)
    ch = [0.0] + [cs[i]['c'] - cs[i - 1]['c'] for i in range(1, len(cs))]
    up, dn = wilder([max(d, 0) for d in ch[1:]], 14), wilder([max(-d, 0) for d in ch[1:]], 14)
    rsi = [None] + [None if u is None else (100.0 if d == 0 else 100 - 100 / (1 + u / d)) for u, d in zip(up, dn)]
    tr, pdm, mdm = [], [], []
    for i in range(1, len(cs)):
        a, b = cs[i], cs[i - 1]
        tr.append(max(a['h'] - a['l'], abs(a['h'] - b['c']), abs(a['l'] - b['c'])))
        u, d = a['h'] - b['h'], b['l'] - a['l']
        pdm.append(u if u > d and u > 0 else 0.0)
        mdm.append(d if d > u and d > 0 else 0.0)
    atr, sp, sm = wilder(tr, 14), wilder(pdm, 14), wilder(mdm, 14)
    dx = []
    for a, p, m in zip(atr, sp, sm):
        if a is None or a == 0:
            dx.append(None)
        else:
            pdi, mdi = 100 * p / a, 100 * m / a
            dx.append(100 * abs(pdi - mdi) / (pdi + mdi) if pdi + mdi > 0 else 0.0)
    first = next((i for i, v in enumerate(dx) if v is not None), None)
    adx = [None] * len(dx)
    if first is not None and len(dx) - first >= 14:
        sm_dx = wilder([0.0 if v is None else v for v in dx[first:]], 14)
        for i, v in enumerate(sm_dx):
            adx[first + i] = v
    adx = [None] + adx
    vol = [None] + [cs[i]['cv'] - cs[i - 1]['cv'] if cs[i]['cv'] is not None and cs[i - 1]['cv'] is not None
                    and cs[i]['cv'] >= cs[i - 1]['cv'] else None for i in range(1, len(cs))]
    return ema, rsi, adx, vol


ROWS = []


def run_day(key, bars):
    ticker, day = key
    for cs in runs_of(bars):
        if len(cs) <= WARM + 1:
            continue
        ema, rsi, adx, vol = indicators(cs)
        above = [x['vw'] is not None and x['vw'] > 0 and ema[i] > x['vw'] for i, x in enumerate(cs)]
        n_day = 0
        for i in range(WARM, len(cs)):
            x, p = cs[i], cs[i - 1]
            if not (x['vw'] and p['vw'] and above[i] and not above[i - 1]):
                continue
            n_day += 1
            entry = x['c']
            under = 0
            j = i - 1
            while j >= 0 and not above[j]:
                under += 1
                j -= 1
            lo = max(0, i - 20)
            flips = sum(1 for k in range(lo + 1, i) if above[k] != above[k - 1])
            gap = max(abs(ema[k] / cs[k]['vw'] - 1) * 100 for k in range(max(0, i - 10), i) if cs[k]['vw'])
            prev_v = [v for v in vol[max(1, i - 20):i] if v is not None]
            volx = vol[i] / (sum(prev_v) / len(prev_v)) if vol[i] is not None and len(prev_v) >= 10 and sum(prev_v) > 0 else None
            slope = (x['vw'] / cs[i - 10]['vw'] - 1) * 100 if i >= 10 and cs[i - 10]['vw'] else None
            # outcomes
            false5 = any(cs[k]['c'] < cs[k]['vw'] for k in range(i + 1, min(i + 6, len(cs))) if cs[k]['vw'])
            a_ret = None
            for k in range(i + 1, min(i + 41, len(cs))):
                if cs[k]['c'] < ema[k]:
                    a_ret = cs[k]['c'] / entry - 1
                    break
            if a_ret is None:
                a_ret = cs[min(i + 40, len(cs) - 1)]['c'] / entry - 1
            stop = min(x['l'], x['vw']) - tick(entry)
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
            ROWS.append(dict(
                ticker=ticker, day=day, t=x['t'], under=under, flips=flips, gap=gap, adx=adx[i], volx=volx,
                over=(entry / x['vw'] - 1) * 100, slope=slope, brk=entry >= max(c['c'] for c in cs[lo:i + 1]),
                rsi=rsi[i], n=n_day, chg=x['chg'], px=entry, green=entry > x['o'],
                false5=false5, a=a_ret * 100, b_r=b_r, b_win=b_out == 'win', b_has=b_out is not None))


cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, cv, chg from bars order by ticker, day, tmin")
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
cut = days[int(len(days) * args.split)] if days else None
IS = [r for r in ROWS if r['day'] < cut]
OOS = [r for r in ROWS if r['day'] >= cut]
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | {TF}m candles, EMA {N} | {len(ROWS):,} crosses "
      f"({len(ROWS) / max(len(days), 1):.0f} a day) | in sample before {cut}: {len(IS):,}, out of sample: {len(OOS):,}")


def summ(rows):
    if not rows:
        return None
    n = len(rows)
    b = [r for r in rows if r['b_has']]
    br = [r['b_r'] for r in rows if r['b_r'] is not None]
    return dict(n=n, false=sum(r['false5'] for r in rows) / n * 100, a=statistics.mean(r['a'] for r in rows),
                a_win=sum(r['a'] > 0 for r in rows) / n * 100, b_r=statistics.mean(br) if br else 0.0,
                b_win=sum(r['b_win'] for r in b) / len(b) * 100 if b else 0.0)


def fmt(s):
    return ('     —' if s is None else
            f"{s['n']:>6,}  false {s['false']:4.0f}%  A {s['a']:+5.2f}% (won {s['a_win']:3.0f}%)  B {s['b_r']:+5.2f}R (2R first {s['b_win']:3.0f}%)")


base_is, base_oos = summ(IS), summ(OOS)
print(f"\n{'all crosses':<34} in  {fmt(base_is)}\n{'':<34} out {fmt(base_oos)}")

FILTERS = [
    ('under ≥ 5 candles', lambda r: r['under'] >= 5),
    ('under ≥ 10', lambda r: r['under'] >= 10),
    ('under ≥ 20', lambda r: r['under'] >= 20),
    ('no flip in the 20 before', lambda r: r['flips'] == 0),
    ('at most 1 flip in the 20 before', lambda r: r['flips'] <= 1),
    ('3+ flips in the 20 before (chop)', lambda r: r['flips'] >= 3),
    ('lines were ≥ 1% apart (gap)', lambda r: r['gap'] >= 1),
    ('lines were ≥ 2% apart', lambda r: r['gap'] >= 2),
    ('ADX ≥ 20', lambda r: r['adx'] is not None and r['adx'] >= 20),
    ('ADX ≥ 25', lambda r: r['adx'] is not None and r['adx'] >= 25),
    ('ADX ≥ 36 (the video)', lambda r: r['adx'] is not None and r['adx'] >= 36),
    ('volume ≥ 1.5× its last 20', lambda r: r['volx'] is not None and r['volx'] >= 1.5),
    ('volume ≥ 2×', lambda r: r['volx'] is not None and r['volx'] >= 2),
    ('volume ≥ 3×', lambda r: r['volx'] is not None and r['volx'] >= 3),
    ('close ≥ 0.5% over the VWAP', lambda r: r['over'] >= 0.5),
    ('close ≥ 1% over', lambda r: r['over'] >= 1),
    ('close ≥ 2% over', lambda r: r['over'] >= 2),
    ('VWAP rising (10 candles)', lambda r: r['slope'] is not None and r['slope'] > 0),
    ('VWAP flat or falling', lambda r: r['slope'] is not None and r['slope'] <= 0),
    ('close = 20-candle high close', lambda r: r['brk']),
    ('green cross candle', lambda r: r['green']),
    ('RSI ≥ 55', lambda r: r['rsi'] is not None and r['rsi'] >= 55),
    ('RSI ≥ 65', lambda r: r['rsi'] is not None and r['rsi'] >= 65),
    ('first cross of the run', lambda r: r['n'] == 1),
    ('third or later cross', lambda r: r['n'] >= 3),
    ('04:00–07:00 ET', lambda r: r['t'] < 420),
    ('07:00–09:30', lambda r: 420 <= r['t'] < 570),
    ('09:30–11:00', lambda r: 570 <= r['t'] < 660),
    ('11:00–16:00', lambda r: 660 <= r['t'] < 960),
    ('16:00–20:00', lambda r: r['t'] >= 960),
    ('day change ≥ 30%', lambda r: r['chg'] is not None and r['chg'] >= 30),
    ('price under $1', lambda r: r['px'] < 1),
    ('price $1 or more', lambda r: r['px'] >= 1),
]


def helps(s, b):
    """Better than all crosses on the three counts, with a sample worth reading."""
    return s is not None and s['n'] >= 100 and s['a'] > b['a'] and s['b_r'] > b['b_r'] and s['false'] < b['false']


print("\nfilter (✓ = better than all crosses on false %, A and B, in sample AND out of sample; n ≥ 100 each)")
kept = []
for name, f in FILTERS:
    si, so = summ([r for r in IS if f(r)]), summ([r for r in OOS if f(r)])
    ok = helps(si, base_is) and helps(so, base_oos)
    if ok:
        kept.append((name, f))
    print(f"{'✓' if ok else ' '} {name:<32} in  {fmt(si)}\n  {'':<32} out {fmt(so)}")

if len(kept) >= 2:
    print("\npairs of the ✓ filters (the same test)")
    for a in range(len(kept)):
        for b in range(a + 1, len(kept)):
            f = lambda r, fa=kept[a][1], fb=kept[b][1]: fa(r) and fb(r)
            si, so = summ([r for r in IS if f(r)]), summ([r for r in OOS if f(r)])
            ok = helps(si, base_is) and helps(so, base_oos)
            print(f"{'✓' if ok else ' '} {kept[a][0] + ' + ' + kept[b][0]:<60} in  {fmt(si)}\n  {'':<60} out {fmt(so)}")

# A few rules put together from the buckets below (the relationships that move steadily: time of
# day, how long the EMA had been under the line, recent flips), not from a search over thresholds.
RULES = [
    ('not before 07:00 ET', lambda r: r['t'] >= 420),
    ('under ≥ 5 + at most 2 flips', lambda r: r['under'] >= 5 and r['flips'] <= 2),
    ('…and not before 07:00 ET', lambda r: r['under'] >= 5 and r['flips'] <= 2 and r['t'] >= 420),
    ('…and regular hours only (09:30–16:00)', lambda r: r['under'] >= 5 and r['flips'] <= 2 and 570 <= r['t'] < 960),
    ('…and 09:30–11:00 only', lambda r: r['under'] >= 5 and r['flips'] <= 2 and 570 <= r['t'] < 660),
    ('what those rules drop (the rest)', lambda r: not (r['under'] >= 5 and r['flips'] <= 2 and r['t'] >= 420)),
]
print("\nrules put together from the steady relationships")
for name, f in RULES:
    si, so = summ([r for r in IS if f(r)]), summ([r for r in OOS if f(r)])
    print(f"  {name:<40} in  {fmt(si)}\n  {'':<40} out {fmt(so)}")

print("\nby bucket, all days (a filter worth trusting should change steadily across its buckets)")
BUCKETS = [
    ('candles under the VWAP before', 'under', [0, 2, 5, 10, 20, 40, 10**9]),
    ('flips in the 20 before', 'flips', [0, 1, 2, 3, 5, 10**9]),
    ('ADX', 'adx', [0, 15, 20, 25, 30, 40, 10**9]),
    ('volume × its last 20', 'volx', [0, 0.5, 1, 1.5, 2, 3, 5, 10**9]),
    ('close over the VWAP, %', 'over', [0, 0.25, 0.5, 1, 2, 4, 10**9]),
    ('VWAP slope, % in 10 candles', 'slope', [-10**9, -0.5, 0, 0.25, 0.5, 1, 10**9]),
]
for title, key_, edges in BUCKETS:
    print(f"  {title}")
    for lo, hi in zip(edges, edges[1:]):
        rows = [r for r in ROWS if r[key_] is not None and lo <= r[key_] < hi]
        label = f"{lo:g}+" if hi >= 10**9 else f"under {hi:g}" if lo <= -10**9 else f"{lo:g} to {hi:g}"
        print(f"    {label:<14}{fmt(summ(rows))}")
