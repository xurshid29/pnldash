"""BB-upper breakout (operator, 2026-10-18) — measured on our top-momentum days.

The setup, as the operator trades it on a 1m chart with a 30s Bollinger Band
(20, SMA, 2.0): a candle closes above the upper band, and the next candle takes
out that candle's high. Entry = a buy stop one tick over the signal candle's
high; stop = the signal candle's low.

  python3 study.py <days.csv> <snaps.csv.gz>            # report
  python3 study.py <days.csv> <snaps.csv.gz> examples   # the operator's 8 windows, signal by signal

days.csv: ticker, et_date, max_chg (screener_ticker_days, max_chg ≥ 20, weekdays).
snaps.csv.gz: our 20s Momentum rows for those days (grade, session VWAP, rv1).
Bars: Yahoo 1m with pre/post prices (pre/post volume is zero), cached in
$BB_DATA (default /tmp/bb-breakout); 1m bars reach back ~30 days.

No 30s data exists on our side, so the 30s band is approximated by a 1m band
of length 10 (the same 10 minutes). Length 20 on 1m (the band the operator found
"crossed too often") is measured next to it.
"""
import bisect
import concurrent.futures as cf
import csv
import datetime
import gzip
import json
import math
import os
import random
import statistics as st
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
U5 = datetime.timezone(datetime.timedelta(hours=5))   # the operator's clock
DATA = os.environ.get('BB_DATA', '/tmp/bb-breakout')
HORIZON = 3600
EXAMPLES = [   # (ticker, start, end) in Tashkent time, from the operator's screenshots
    ('NWGL', '2026-10-17 00:10', '2026-10-17 00:40'), ('NWGL', '2026-10-17 02:15', '2026-10-17 02:25'),
    ('NWGL', '2026-10-17 02:30', '2026-10-17 02:50'), ('HODO', '2026-10-16 13:25', '2026-10-16 13:45'),
    ('XLAB', '2026-10-16 18:45', '2026-10-16 19:15'), ('SGRX', '2026-10-16 21:00', '2026-10-16 21:25'),
    ('SGRX', '2026-10-16 21:35', '2026-10-16 21:50'), ('SGRX', '2026-10-16 22:25', '2026-10-16 22:40'),
    ('XXII', '2026-10-16 02:30', '2026-10-16 02:55'),
]


def week_of(day):
    return day - datetime.timedelta(days=day.weekday())


def fetch(job):
    tk, mon = job
    out = os.path.join(DATA, f'{tk}_{mon:%Y%m%d}.json')
    if os.path.exists(out):
        return
    a = datetime.datetime.combine(mon, datetime.time(0), ET)
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{tk.replace(".", "-")}?interval=1m'
           f'&period1={int(a.timestamp())}&period2={int((a + datetime.timedelta(days=6)).timestamp())}&includePrePost=true')
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            res = json.load(urllib.request.urlopen(req, timeout=20))['chart']['result'][0]
            q = res['indicators']['quote'][0]
            bars = [[t, o, h, l, c, v or 0] for t, o, h, l, c, v in
                    zip(res.get('timestamp') or [], q['open'], q['high'], q['low'], q['close'], q['volume']) if c is not None]
            json.dump(bars, open(out, 'w'))
            return
        except urllib.error.HTTPError as e:
            if e.code == 404:
                json.dump([], open(out, 'w'))
                return
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))


def bands(closes, n, mult=2.0):
    """TradingView ta.sma / ta.stdev (population) → (basis, upper) per bar; None while warming up."""
    out = [None] * len(closes)
    s = s2 = 0.0
    for i, c in enumerate(closes):
        s += c
        s2 += c * c
        if i >= n:
            s -= closes[i - n]
            s2 -= closes[i - n] ** 2
        if i >= n - 1:
            m = s / n
            out[i] = (m, m + mult * math.sqrt(max(s2 / n - m * m, 0.0)))
    return out


def ema(xs, n):
    k, out, e = 2 / (n + 1), [], None
    for x in xs:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


def tick(p):
    return 0.0001 if p < 1 else 0.01


def tod(t):
    h = t.hour + t.minute / 60
    return ('1 pre 04–07' if h < 7 else '2 pre 07–09:30' if h < 9.5 else '3 open 09:30–10:30' if h < 10.5
            else '4 10:30–12' if h < 12 else '5 12–16' if h < 16 else '6 after 16')


def load_snaps(path):
    snaps = defaultdict(list)
    with gzip.open(path, 'rt') as f:
        for r in csv.DictReader(f):
            snaps[r['ticker']].append((int(r['ts']), float(r['vwap']) if r['vwap'] else None, r['grade'] or None,
                                       float(r['change_pct']) if r['change_pct'] else None))
    for v in snaps.values():
        v.sort()
    return snaps


def snap_at(snaps, tk, ts):
    rows = snaps.get(tk)
    if not rows:
        return None
    i = bisect.bisect_right(rows, (ts + 1,)) - 1
    return rows[i] if i >= 0 and ts - rows[i][0] <= 90 else None


def signals(tk, bars, days, n, snaps):
    """Every fresh close above the upper band on a universe day, with the next-candle trigger and its outcome."""
    t = [b[0] for b in bars]
    o, h, l, c, v = ([b[k] for b in bars] for k in (1, 2, 3, 4, 5))
    bb = bands(c, n)
    m = [a - b for a, b in zip(ema(c, 2), ema(c, 13))]   # proxy for the operator's 30s MACD 4/26/10
    sig = ema(m, 5)
    hist = [a - b for a, b in zip(m, sig)]
    width = [None if x is None else 2 * (x[1] - x[0]) / x[0] for x in bb]
    et = [datetime.datetime.fromtimestamp(x, ET) for x in t]
    prev_close = {}
    for i in range(len(bars)):
        if et[i].hour < 16 or (et[i].hour == 16 and et[i].minute == 0):
            prev_close[et[i].date()] = c[i]
    closes_by_day = sorted(prev_close.items())
    out = []
    last_above = -999
    for i in range(1, len(bars) - 1):
        if bb[i] is None or bb[i - 1] is None:
            continue
        if c[i - 1] > bb[i - 1][1]:
            last_above = i - 1
        d = et[i].date()
        if d not in days or not (4 <= et[i].hour < 20):
            continue
        if not (c[i] > bb[i][1] and c[i - 1] <= bb[i - 1][1]):
            continue
        e = dict(ticker=tk, ts=t[i], et=et[i], n=n, day_max=days[d])
        j = i + 1
        e['trig'] = et[j].date() == d and t[j] - t[i] <= 180 and h[j] > h[i]
        pc = [x for dd, x in closes_by_day if dd < d]
        e['day_gain'] = c[i] / pc[-1] - 1 if pc else None
        e['fresh'] = i - last_above
        e['risk'] = (h[i] - l[i]) / h[i]
        e['candle'] = c[i] / o[i] - 1
        lo30 = min(l[max(0, i - 30):i + 1])
        e['run30'] = c[i] / lo30 - 1
        pv = v[max(0, i - 20):i]
        e['rth'] = (et[i].hour > 9 or (et[i].hour == 9 and et[i].minute >= 31)) and et[i].hour < 16
        e['vol_x'] = v[i] / (sum(pv) / len(pv)) if e['rth'] and pv and sum(pv) > 0 else None
        ws = [x for x in width[max(0, i - 61):i - 1] if x]
        e['squeeze'] = width[i - 1] / st.median(ws) if ws and width[i - 1] else None
        e['macd_up'] = hist[i] > 0 and hist[i] > hist[i - 1]
        e['macd_pos'] = m[i] > 0
        s = snap_at(snaps, tk, t[i] + 60)
        e['on_screen'] = s is not None
        e['grade'] = s[2] if s else None
        e['ext_vwap'] = c[i] / s[1] - 1 if s and s[1] else None
        def walk(j0, entry, stop, rule, target=None, at_close=False):
            """Enter at `entry` on bar j0, stop at `stop` (filled at the stop, or the open if it gapped
            through), optional +target, and an exit rule judged on each later bar's close:
            'band' = under the upper band, 'basis' = under the basis, 'trail' = under the previous bar's
            low, 'time15' = out after 15 min. Out at the close 60 min later at the latest.
            `at_close`: bought on bar j0's close, so that bar's own range doesn't count."""
            k = j0 + 1 if at_close else j0
            while k < len(bars) and et[k].date() == d and t[k] - t[j0] <= HORIZON:
                if l[k] <= stop:
                    return (min(o[k], stop) if k > j0 else stop) / entry - 1
                if target and h[k] >= entry * (1 + target):
                    return target
                if k > j0:
                    if rule == 'band' and bb[k] and c[k] < bb[k][1]:
                        return c[k] / entry - 1
                    if rule == 'basis' and bb[k] and c[k] < bb[k][0]:
                        return c[k] / entry - 1
                    if rule == 'trail' and c[k] < l[k - 1]:
                        return c[k] / entry - 1
                    if rule == 'time15' and t[k] - t[j0] >= 900:
                        return c[k] / entry - 1
                k += 1
            return c[k - 1] / entry - 1

        # no-trigger comparison: buy the signal candle's close, same stop
        e['at_close'] = walk(i, c[i], l[i], 'band', at_close=True) if c[i] > l[i] else None
        if e['trig']:
            entry, stop = max(o[j], h[i] + tick(h[i])), l[i]
            e['entry'] = entry
            race, hi = 'none', {15: entry, 30: entry, 60: entry}
            k = j
            while k < len(bars) and et[k].date() == d and t[k] - t[j] <= HORIZON:
                if race == 'none' and l[k] <= stop:
                    race = 'loss'
                if race == 'none' and h[k] >= entry * 1.10:
                    race = 'win'
                for w in hi:
                    if t[k] - t[j] <= w * 60:
                        hi[w] = max(hi[w], h[k])
                k += 1
            e.update(race=race, mfe15=hi[15] / entry - 1, mfe30=hi[30] / entry - 1, mfe60=hi[60] / entry - 1,
                     band=walk(j, entry, stop, 'band'), band10=walk(j, entry, stop, 'band', 0.10),
                     basis=walk(j, entry, stop, 'basis'), trail=walk(j, entry, stop, 'trail'),
                     time15=walk(j, entry, stop, 'time15'), tgt10=walk(j, entry, stop, None, 0.10))
        out.append(e)
    return out




def baseline(tk, bars, days):
    """Race +10% vs −5% from random bar closes on the same days."""
    res = Counter()
    for i in range(len(bars) - 1):
        d = datetime.datetime.fromtimestamp(bars[i][0], ET).date()
        if d not in days or random.random() > 0.2:
            continue
        entry, r = bars[i][4], 'none'
        for b in bars[i + 1:]:
            if b[0] - bars[i][0] > HORIZON:
                break
            if b[3] <= entry * 0.95:
                r = 'loss'
                break
            if b[2] >= entry * 1.10:
                r = 'win'
                break
        res[r] += 1
    return res


def table(title, groups):
    print(f'\n## {title}')
    print(f"{'':26}{'sig':>6}{'trig':>6}{'/day':>6}{'win':>6}{'loss':>6}{'race5':>7}{'mfe15':>7}{'mfe60':>7}{'≥10%':>6}"
          f"{'risk':>6}{'band':>8}{'band+10':>8}{'>0':>5}")
    for name, es in groups:
        tr = [e for e in es if e['trig']]
        if not es or not tr:
            continue
        n = len(tr)
        sessions = len({e['et'].date() for e in es})
        print(f"{str(name)[:26]:26}{len(es):>6}{n / len(es):>6.0%}{n / sessions:>6.0f}"
              f"{sum(e['race'] == 'win' for e in tr) / n:>6.0%}{sum(e['race'] == 'loss' for e in tr) / n:>6.0%}"
              f"{sum(e['mfe60'] >= 0.10 and e['race'] != 'loss' for e in tr) / n:>7.0%}"
              f"{st.median(e['mfe15'] for e in tr):>7.1%}{st.median(e['mfe60'] for e in tr):>7.1%}"
              f"{sum(e['mfe60'] >= 0.10 for e in tr) / n:>6.0%}{st.median(e['risk'] for e in tr):>6.1%}"
              f"{st.mean(e['band'] for e in tr):>8.2%}{st.mean(e['band10'] for e in tr):>8.2%}"
              f"{sum(e['band'] > 0 for e in tr) / n:>5.0%}")


def split(es, f):
    g = defaultdict(list)
    for e in es:
        g[f(e)].append(e)
    return sorted(g.items(), key=lambda kv: str(kv[0]))


def bucket(x, edges, fmt='{:g}'):
    if x is None:
        return '?'
    for i, ed in enumerate(edges):
        if x < ed:
            return f"{i} <{fmt.format(ed)}"
    return f"{len(edges)} ≥{fmt.format(edges[-1])}"


def main():
    days = defaultdict(dict)
    for r in csv.DictReader(open(sys.argv[1])):
        d = datetime.date.fromisoformat(r['et_date'])
        days[r['ticker']][d] = float(r['max_chg'])
    os.makedirs(DATA, exist_ok=True)
    jobs = sorted({(tk, week_of(d)) for tk, ds in days.items() for d in ds})
    with cf.ThreadPoolExecutor(4) as ex:
        list(ex.map(fetch, jobs))
    snaps = load_snaps(sys.argv[2])
    random.seed(1)
    allsig = {10: [], 20: []}
    base = Counter()
    for tk, ds in days.items():
        bars = []
        for mon in sorted({week_of(d) for d in ds}):
            p = os.path.join(DATA, f'{tk}_{mon:%Y%m%d}.json')
            if os.path.exists(p):
                bars += json.load(open(p))
        bars.sort()
        if len(bars) < 30:
            continue
        for n in (10, 20):
            allsig[n] += signals(tk, bars, ds, n, snaps)
        base += baseline(tk, bars, ds)
    nb = sum(base.values())
    if len(sys.argv) > 3 and sys.argv[3] == 'examples':
        for tk, a, b in EXAMPLES:
            ta = datetime.datetime.fromisoformat(a).replace(tzinfo=U5).timestamp()
            tb = datetime.datetime.fromisoformat(b).replace(tzinfo=U5).timestamp()
            print(f'\n{tk} {a[11:]}–{b[11:]} Tashkent')
            for e in allsig[10]:
                if e['ticker'] == tk and ta - 300 <= e['ts'] <= tb:
                    when = datetime.datetime.fromtimestamp(e['ts'], U5).strftime('%H:%M')
                    print(f"  {when} cross{' → TRIGGER' if e['trig'] else ' (no trigger)'}"
                          + (f" entry {e['entry']:.4g} · mfe60 {e['mfe60']:+.1%} · band exit {e['band']:+.1%} · race {e['race']}"
                             f" · fresh {e['fresh']} · run30 {e['run30']:+.0%}" if e['trig'] else ''))
        return
    print(f"{len(days)} tickers, {sum(len(d) for d in days.values())} ticker-days ≥+20% (20 sessions) | "
          f"baseline, any minute of these days: +10% before −5% {base['win'] / nb:.0%}, −5% first {base['loss'] / nb:.0%}")
    print("cols: sig = fresh closes above the band; trig = share where the next candle took out its high (the trade);"
          " /day = trades a day; win/loss = +10% vs the signal-candle-low stop first (60m); race5 = +10% before −5%;"
          " mfe = median best move; risk = stop distance; band = exit on the first close back under the band"
          " (or the stop), mean P&L; band+10 = same, with a +10% target")
    for n in (20, 10):
        es = allsig[n]
        table(f'1m BB({n}) — all', [('all', es), ('on Momentum', [e for e in es if e['on_screen']]), ('off', [e for e in es if not e['on_screen']])])
    es = allsig[10]
    table('BB(10) by fresh (bars since the last close above the band)', split(es, lambda e: bucket(e['fresh'], [2, 5, 15, 60])))
    table('BB(10) by time (ET)', split(es, lambda e: tod(e['et'])))
    table('BB(10) by run in the last 30 min', split(es, lambda e: bucket(e['run30'], [0.05, 0.1, 0.2, 0.4], '{:.0%}')))
    table('BB(10) by day gain at the signal', split(es, lambda e: bucket(e['day_gain'], [0.2, 0.5, 1.0, 2.0], '{:.0%}')))
    table('BB(10) by signal-candle size (stop distance)', split(es, lambda e: bucket(e['risk'], [0.02, 0.04, 0.07, 0.12], '{:.0%}')))
    table('BB(10) by band width vs its last hour (squeeze < 1)', split(es, lambda e: bucket(e['squeeze'], [0.6, 0.9, 1.2, 2.0], '{:.1f}')))
    table('BB(10) by volume vs last 20 bars (regular hours only)', split([e for e in es if e['rth']], lambda e: bucket(e['vol_x'], [1, 2, 4, 8], '{:g}x')))
    table('BB(10) MACD proxy: histogram >0 and rising', split(es, lambda e: e['macd_up']))
    table('BB(10) MACD proxy: MACD line > 0', split(es, lambda e: e['macd_pos']))
    table('BB(10) vs session VWAP (on Momentum)', split([e for e in es if e['ext_vwap'] is not None], lambda e: bucket(e['ext_vwap'], [0, 0.1, 0.25, 0.5], '{:.0%}')))
    table('BB(10) grade at the signal (on Momentum)', split([e for e in es if e['on_screen']], lambda e: e['grade'] or '?'))
    table('BB(10) by day', split(es, lambda e: e['et'].date()))
    exits(allsig[10])


def exits(es):
    tr = [e for e in es if e['trig']]
    first = sorted({e['et'].date() for e in es})[len({e['et'].date() for e in es}) // 2]
    cands = [
        ('all trades', lambda e: True),
        ('grade A+ (on Momentum)', lambda e: e['grade'] == 'A+'),
        ('grade A+/A', lambda e: e['grade'] in ('A+', 'A')),
        ('run30 ≥20%', lambda e: e['run30'] >= 0.2),
        ('run30 ≥20% + 04:00–10:30', lambda e: e['run30'] >= 0.2 and e['et'].hour * 60 + e['et'].minute < 630),
        ('vol ≥4x (RTH)', lambda e: (e['vol_x'] or 0) >= 4),
        ('day gain ≥100%', lambda e: (e['day_gain'] or 0) >= 1.0),
        ('candle ≥7%', lambda e: e['risk'] >= 0.07),
        ('vs VWAP +10–50%', lambda e: e['ext_vwap'] is not None and 0.1 <= e['ext_vwap'] < 0.5),
        ('fresh ≥60 bars', lambda e: e['fresh'] >= 60),
    ]
    print('\n## Exits — mean P&L per trade, stop at the signal-candle low (share > 0); then the two halves of the period')
    cols = ['band', 'basis', 'trail', 'time15', 'tgt10', 'band10']
    print(f"{'':30}{'n':>6}" + ''.join(f"{c:>13}" for c in cols) + f"{'1st half':>10}{'2nd half':>10}{'no top 1%':>11}{'median':>8}")
    for name, f in cands:
        g = [e for e in tr if f(e)]
        if len(g) < 20:
            continue
        cells = ''.join(f"{st.mean(e[c] for e in g):>+7.2%} ({sum(e[c] > 0 for e in g) / len(g):>3.0%})" for c in cols)
        h1 = [e['band'] for e in g if e['et'].date() < first]
        h2 = [e['band'] for e in g if e['et'].date() >= first]
        srt = sorted(e['band'] for e in g)
        trim = srt[:max(1, int(len(srt) * 0.99))]
        print(f"{name[:30]:30}{len(g):>6}{cells}{(st.mean(h1) if h1 else 0):>+10.2%}{(st.mean(h2) if h2 else 0):>+10.2%}"
              f"{st.mean(trim):>+11.2%}{st.median(srt):>+8.2%}")
    print('  (halves, trimmed mean and median use the band exit)')
    nt = [e for e in es if e['at_close'] is not None]
    print(f"\n## Waiting for the trigger vs buying the signal close (band exit, stop at the signal low)")
    print(f"  buy the close, all signals: n {len(nt)}, mean {st.mean(e['at_close'] for e in nt):+.2%}")
    print(f"  …signals that then triggered: {st.mean(e['at_close'] for e in nt if e['trig']):+.2%}; that didn't: {st.mean(e['at_close'] for e in nt if not e['trig']):+.2%}")
    print(f"  the trigger entry (band exit): {st.mean(e['band'] for e in tr):+.2%}")


if __name__ == '__main__':
    main()
