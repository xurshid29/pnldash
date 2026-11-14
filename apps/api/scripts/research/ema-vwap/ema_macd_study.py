"""EMA cross over VWAP — is it better when the MACD is positive at the cross? (operator, 2026-11-15:
"1 or 5 min chart, 9 ema must cross the session vwap and macd line must be above the signal line
and zero line and its histogram must be green, so macd must be positive when ema crosses the vwap".)
Measured before building anything.

Data     as ema_vwap_study.py: every Momentum row → 1m bars → --tf minute candles, the poller's
         session VWAP. A ticker's bars exist only while it is on our screen: a gap over 6 minutes
         starts a new run, and a cross counts after 15 candles of its run.
Cross    the script's v35 rule: the EMA (--len) of the candle closes is above the session VWAP at a
         candle's close and was at or under it at the close before.
MACD     12 / 26 / 9 on the same candles, at the cross candle's close: the line (EMA 12 − EMA 26),
         the signal (EMA 9 of the line), the histogram (line − signal; green = above zero).
         Ours starts with the run (TradingView's carries over from the bars before; ours can't),
         so it is read only for crosses with --macd-warm candles of run behind them ("warm").
         --yahoo <folder of cached Yahoo 5m JSON, ../rsi-dip/dip_lift_study.py's cache>: for those
         tickers, on 5m candles, the MACD of the continuous 5m series (pre- and after-market
         included, as a TradingView chart has it) is read too, to check ours against it.
Outcomes (entry at the cross candle's close), as ema_vwap_study.py
         false     a candle closes back under the VWAP within 5 candles
         A         exit when a candle closes under the EMA, 40 candles at most → %
         B         stop a tick under the lower of the cross candle's low and the VWAP, target 2R,
                   20 candles → R (stops under 0.5% away left out of the R average)
Split    by date (--cut, or the first --split of the days): in sample before it, out of sample
         from it. A rule counts only if it helps in both.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql):
  python ema_macd_study.py rows.csv.gz --tf 5 [--cut 2026-10-09] [--yahoo <folder>]
  python ema_macd_study.py rows.csv.gz --tf 1
"""
import argparse, bisect, datetime, duckdb, json, os, statistics, sys, zoneinfo

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--tf', type=int, default=5, help='candle timeframe, minutes')
ap.add_argument('--len', type=int, default=9, help='EMA length')
ap.add_argument('--split', type=float, default=0.6, help='share of the days used in sample')
ap.add_argument('--cut', help='first out-of-sample day, YYYY-MM-DD (instead of --split)')
ap.add_argument('--macd', type=int, nargs=3, default=[12, 26, 9], metavar=('FAST', 'SLOW', 'SIGNAL'))
ap.add_argument('--macd-warm', type=int, default=35, help='candles of run before our MACD is read')
ap.add_argument('--yahoo', help='folder of cached Yahoo 5m chart JSON (5m candles only)')
args = ap.parse_args()
TF, N, MAX_GAP, WARM = args.tf, args.len, 6, 15
FAST, SLOW, SIG = args.macd
ET = zoneinfo.ZoneInfo('America/New_York')

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         try_cast(change_pct as double) as chg,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw, max(chg) as chg
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()


def tick(p):
    return 0.0001 if p < 1 else 0.01


def runs_of(bars):
    """A ticker-day's 1m bars → runs of candles (a gap over MAX_GAP minutes starts a new run)."""
    runs, cur, prev_t = [], [], None
    for t, o, h, l, c, vw, chg in bars:
        if prev_t is not None and t - prev_t > MAX_GAP:
            runs.append(cur)
            cur = []
        k = (t - 240) // TF
        if cur and cur[-1]['k'] == k:
            x = cur[-1]
            x['h'] = max(x['h'], h); x['l'] = min(x['l'], l); x['c'] = c; x['vw'] = vw
            x['chg'] = chg if x['chg'] is None else max(x['chg'], chg if chg is not None else x['chg'])
        else:
            cur.append(dict(k=k, t=240 + k * TF, o=o, h=h, l=l, c=c, vw=vw, chg=chg))
        prev_t = t
    if cur:
        runs.append(cur)
    return runs


def ema_of(values, n):
    """TradingView's ta.ema from the first value on."""
    a, e, out = 2.0 / (n + 1), None, []
    for v in values:
        e = v if e is None else a * v + (1 - a) * e
        out.append(e)
    return out


def macd_of(closes):
    """Per close: (line, signal, histogram)."""
    line = [f - s for f, s in zip(ema_of(closes, FAST), ema_of(closes, SLOW))]
    return [(m, g, m - g) for m, g in zip(line, ema_of(line, SIG))]


_yahoo = {}


def yahoo_macd(ticker):
    """A cached ticker's continuous 5m series → ([bar start, epoch], [(line, signal, hist)]); None if not cached."""
    if ticker in _yahoo:
        return _yahoo[ticker]
    out = None
    path = os.path.join(args.yahoo, f'{ticker}.json')
    try:
        with open(path) as f:
            res = json.load(f)['chart']['result'][0]
        ts, q = res['timestamp'], res['indicators']['quote'][0]
        splits = [int(k) for k in (res.get('events') or {}).get('splits', {})]
        since = max(splits) if splits else 0
        times, closes = [], []
        for i, t in enumerate(ts):
            c = q['close'][i]
            if c is None or c <= 0 or t < since:
                continue
            d = datetime.datetime.fromtimestamp(t, ET)
            if not (240 <= d.hour * 60 + d.minute < 1200) or d.weekday() >= 5:
                continue
            times.append(t)
            closes.append(c)
        if len(times) > 100:
            out = (times, macd_of(closes))
    except Exception:
        out = None
    _yahoo[ticker] = out
    return out


def yahoo_at(ticker, day, tmin):
    """The continuous MACD at the close of the 5m candle starting at `tmin` on `day`: that bar, or
    the last one before it that day (no bar = no trades = the chart's MACD hasn't moved)."""
    y = yahoo_macd(ticker)
    if y is None:
        return None
    times, ms = y
    start = int(datetime.datetime(day.year, day.month, day.day, tmin // 60, tmin % 60, tzinfo=ET).timestamp())
    i = bisect.bisect_right(times, start) - 1
    if i < 100 or datetime.datetime.fromtimestamp(times[i], ET).date() != day:
        return None
    return ms[i] + (ms[i - 1][2],)


ROWS = []


def run_day(key, bars):
    ticker, day = key
    for cs in runs_of(bars):
        if len(cs) <= WARM + 1:
            continue
        ema = ema_of([x['c'] for x in cs], N)
        macd = macd_of([x['c'] for x in cs])
        above = [x['vw'] is not None and x['vw'] > 0 and ema[i] > x['vw'] for i, x in enumerate(cs)]
        for i in range(WARM, len(cs)):
            x, p = cs[i], cs[i - 1]
            if not (x['vw'] and p['vw'] and above[i] and not above[i - 1]):
                continue
            entry = x['c']
            under = 0
            j = i - 1
            while j >= 0 and not above[j]:
                under += 1
                j -= 1
            flips = sum(1 for k in range(max(0, i - 20) + 1, i) if above[k] != above[k - 1])
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
            m, g, h = macd[i]
            ym = yahoo_at(ticker, day, x['t']) if args.yahoo and TF == 5 else None
            ROWS.append(dict(
                ticker=ticker, day=day, t=x['t'], under=under, flips=flips, px=entry, warm=i >= args.macd_warm,
                m=m, g=g, h=h, h1=macd[i - 1][2], mp=m / entry * 100, hp=h / entry * 100,
                ym=ym, false5=false5, a=a_ret * 100, b_r=b_r, b_win=b_out == 'win', b_has=b_out is not None))


cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, chg from bars order by ticker, day, tmin")
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
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | {TF}m candles, EMA {N}, MACD {FAST} / {SLOW} / {SIG} | "
      f"{len(ROWS):,} crosses ({len(ROWS) / max(len(days), 1):.0f} a day) | in sample before {cut}")


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


def helps(s, b):
    return s is not None and b is not None and s['n'] >= 100 and s['a'] > b['a'] and s['b_r'] > b['b_r'] and s['false'] < b['false']


def table(title, rows, rules, base_name='all of them'):
    """Each rule in sample and out of sample; ✓ = better than `rows` on false %, A and B in both halves."""
    i_s, o_s = [r for r in rows if r['day'] < cut], [r for r in rows if r['day'] >= cut]
    bi, bo = summ(i_s), summ(o_s)
    print(f"\n{title}")
    print(f"  {base_name:<52} in  {fmt(bi)}\n  {'':<52} out {fmt(bo)}")
    for name, f in rules:
        si, so = summ([r for r in i_s if f(r)]), summ([r for r in o_s if f(r)])
        share = f"{(si['n'] if si else 0) / max(len(i_s), 1) * 100:.0f}% / {(so['n'] if so else 0) / max(len(o_s), 1) * 100:.0f}%"
        ok = helps(si, bi) and helps(so, bo)
        print(f"{'✓' if ok else ' '} {name + ' (' + share + ')':<52} in  {fmt(si)}\n  {'':<52} out {fmt(so)}")


both = lambda r: r['m'] > 0 and r['h'] > 0                       # the operator's rule
v36 = lambda r: r['under'] >= 5 and r['flips'] <= 2 and r['t'] >= 420
RULES = [
    ('MACD line above zero', lambda r: r['m'] > 0),
    ('line above the signal (histogram green)', lambda r: r['h'] > 0),
    ('BOTH: line above zero and above the signal', both),
    ('…and the signal above zero too', lambda r: both(r) and r['g'] > 0),
    ('…and the histogram rising', lambda r: both(r) and r['h'] > r['h1']),
    ('not both (what the rule drops)', lambda r: not both(r)),
    ('line at or under zero', lambda r: r['m'] <= 0),
    ('histogram red (line at or under the signal)', lambda r: r['h'] <= 0),
    ('line under zero, histogram green (turning up)', lambda r: r['m'] <= 0 and r['h'] > 0),
]

table('all crosses (the README\'s baseline)', ROWS, [('MACD warm (' + str(args.macd_warm) + '+ candles of run)', lambda r: r['warm'])])
W = [r for r in ROWS if r['warm']]
table(f'the MACD at the cross — crosses with a warm MACD ({len(W):,} of {len(ROWS):,})', W, RULES)
table('…with the v36 filter (under ≥ 5 candles, at most 2 flips, not before 07:00 ET)', [r for r in W if v36(r)],
      [('BOTH', both), ('not both', lambda r: not both(r))], 'the filter\'s crosses')
table('…regular hours (09:30–16:00 ET)', [r for r in W if 570 <= r['t'] < 960],
      [('BOTH', both), ('not both', lambda r: not both(r))], 'regular-hours crosses')
table('…09:30–11:00 ET', [r for r in W if 570 <= r['t'] < 660],
      [('BOTH', both), ('not both', lambda r: not both(r))], '09:30–11:00 crosses')
table('…04:00–09:30 ET', [r for r in W if r['t'] < 570],
      [('BOTH', both), ('not both', lambda r: not both(r))], 'pre-market crosses')

print("\nby bucket, warm crosses, all days (a rule worth trusting changes steadily across its buckets)")
for title, key_, edges in [('MACD line, % of the price', 'mp', [-10**9, -1, -0.5, -0.2, 0, 0.2, 0.5, 1, 10**9]),
                           ('histogram, % of the price', 'hp', [-10**9, -0.2, -0.05, 0, 0.05, 0.1, 0.2, 0.4, 10**9])]:
    print(f"  {title}")
    for lo, hi in zip(edges, edges[1:]):
        rows = [r for r in W if lo <= r[key_] < hi]
        label = f"{lo:g}+" if hi >= 10**9 else f"under {hi:g}" if lo <= -10**9 else f"{lo:g} to {hi:g}"
        print(f"    {label:<14}{fmt(summ(rows))}")

if args.yahoo and TF == 5:
    Y = [r for r in ROWS if r['ym'] is not None]
    yboth = lambda r: r['ym'][0] > 0 and r['ym'][2] > 0
    print(f"\nthe chart's MACD (Yahoo's continuous 5m series) — {len(Y):,} crosses on {len({r['ticker'] for r in Y}):,} cached tickers, "
          f"{min((r['day'] for r in Y), default=None)} → {max((r['day'] for r in Y), default=None)}")
    for name, rows in (('all of them', Y), ('ours warm', [r for r in Y if r['warm']]), ('ours not warm', [r for r in Y if not r['warm']])):
        if rows:
            same = sum(1 for r in rows if both(r) == yboth(r)) / len(rows) * 100
            line = sum(1 for r in rows if (r['m'] > 0) == (r['ym'][0] > 0)) / len(rows) * 100
            hist = sum(1 for r in rows if (r['h'] > 0) == (r['ym'][2] > 0)) / len(rows) * 100
            print(f"  {name:<14} {len(rows):>5,}  our MACD agrees with the chart's on BOTH {same:3.0f}%  (line's sign {line:3.0f}%, histogram's sign {hist:3.0f}%)  "
                  f"BOTH by the chart {sum(1 for r in rows if yboth(r)) / len(rows) * 100:3.0f}%, by ours {sum(1 for r in rows if both(r)) / len(rows) * 100:3.0f}%")
    YR = [
        ('MACD line above zero', lambda r: r['ym'][0] > 0),
        ('line above the signal (histogram green)', lambda r: r['ym'][2] > 0),
        ('BOTH: line above zero and above the signal', yboth),
        ('…and the signal above zero too', lambda r: yboth(r) and r['ym'][1] > 0),
        ('…and the histogram rising', lambda r: yboth(r) and r['ym'][2] > r['ym'][3]),
        ('not both (what the rule drops)', lambda r: not yboth(r)),
        ('line at or under zero', lambda r: r['ym'][0] <= 0),
        ('histogram red', lambda r: r['ym'][2] <= 0),
    ]
    table('the same rules with the chart\'s MACD (every cross of the cached tickers, warm or not)', Y, YR)
    table('…with the v36 filter', [r for r in Y if v36(r)], [('BOTH', yboth), ('not both', lambda r: not yboth(r))], 'the filter\'s crosses')
    table('…regular hours (09:30–16:00 ET)', [r for r in Y if 570 <= r['t'] < 960],
          [('BOTH', yboth), ('not both', lambda r: not yboth(r))], 'regular-hours crosses')
