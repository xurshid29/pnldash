"""An earlier BB breakout (operator, 2026-10-19, after WORX ran 1.40 → 2.54 with no BO:
"+20% would be too late maybe? Maybe earlier, such as 5-10% and some confirmation such
as rvol or current vol").

Unlike study.py (days that ENDED +20%, which flatters any rule firing below +20%),
the universe here is every name on the TradingView watchlist as built the night
before (≥+30% on our screen in the prior 90 days, or ≥+20% in the prior 3 sessions),
whether it moved that day or not, the names the 📐 alert actually watches.

Rules, per gain threshold g (day high vs the prior regular close, at the signal):
  first-g  the first candle of the day to reach +g% while closing above the band
           (fresh or already riding: WORX 19:13)
  fresh-g  any fresh close above the band while the day is ≥ +g% (v17–v19 use g = 20)
The trade is the same: the next candle takes the signal candle's high; stop at its
low; out on the first close back under the band (or 60 min).
Confirmations (regular hours only: Yahoo has no pre/post volume):
  vol  the signal candle's volume vs the previous 20 candles
  rv5  the last 5 minutes' volume vs (average day ÷ 78), the average from the
       name's own previous sessions (RVol v2's definition)

  python3 early_study.py <std_all.csv>     # screener_ticker_days since 2026-06-01
Bars: Yahoo 1m, cached in $BB_DATA (shared with study.py).
"""
import concurrent.futures as cf
import csv
import datetime
import json
import os
import statistics as st
import sys
from collections import defaultdict

import study as S

FIRST, LAST = datetime.date(2026, 9, 21), datetime.date(2026, 10, 16)
GAINS = (5, 10, 15, 20)


def watchlists(path):
    by_day = defaultdict(list)
    for r in csv.DictReader(open(path)):
        by_day[datetime.date.fromisoformat(r['et_date'])].append((r['ticker'], float(r['max_chg'])))
    days = sorted(d for d in by_day if d.weekday() < 5)
    out = {}
    for d in days:
        if not FIRST <= d <= LAST:
            continue
        prior = [x for x in days if x < d]
        big90 = {tk for x in prior if (d - x).days <= 90 for tk, m in by_day[x] if m >= 30}
        last3 = {tk for x in prior[-3:] for tk, m in by_day[x] if m >= 20}
        out[d] = big90 | last3
    return out


def events_for(tk, bars, member_days):
    t = [b[0] for b in bars]
    o, h, l, c, v = ([b[k] for b in bars] for k in (1, 2, 3, 4, 5))
    bb = S.bands(c, 10)
    et = [datetime.datetime.fromtimestamp(x, S.ET) for x in t]
    day_of = [x.date() for x in et]
    rth = [(x.hour > 9 or (x.hour == 9 and x.minute >= 30)) and x.hour < 16 for x in et]
    prev_close, rth_vol = {}, defaultdict(float)
    for i in range(len(bars)):
        if et[i].hour < 16 or (et[i].hour == 16 and et[i].minute == 0):
            prev_close[day_of[i]] = c[i]
        if rth[i]:
            rth_vol[day_of[i]] += v[i]
    sessions = sorted(prev_close)
    out = []
    by_day = defaultdict(list)
    for i, d in enumerate(day_of):
        by_day[d].append(i)
    for d in sorted(member_days):
        idx = by_day.get(d)
        before = [x for x in sessions if x < d]
        if not idx or not before:
            continue
        pc = prev_close[before[-1]]
        prior_vols = [rth_vol[x] for x in before[-20:] if rth_vol[x] > 0]
        adv = st.mean(prior_vols) if len(prior_vols) >= 3 else None
        day_hi, crossed = 0.0, set()
        day_max = (max(h[i] for i in idx) / pc - 1) * 100
        for i in idx:
            if not (4 <= et[i].hour < 20) or i == 0 or bb[i] is None or bb[i - 1] is None:
                day_hi = max(day_hi, h[i])
                continue
            day_hi = max(day_hi, h[i])
            gain = (day_hi / pc - 1) * 100
            above = c[i] > bb[i][1]
            fresh = c[i - 1] <= bb[i - 1][1]
            kinds = []
            for g in GAINS:
                if gain >= g and g not in crossed:
                    crossed.add(g)
                    if above:
                        kinds.append(f'first-{g}')
                if above and fresh and gain >= g:
                    kinds.append(f'fresh-{g}')
            if not kinds:
                continue
            j = i + 1
            if j >= len(bars) or day_of[j] != d or t[j] - t[i] > 180 or h[j] <= h[i]:
                continue                                 # no trigger, no trade
            entry, stop = max(o[j], h[i] + S.tick(h[i])), l[i]
            k, pnl = j, None
            while k < len(bars) and day_of[k] == d and t[k] - t[j] <= S.HORIZON:
                if l[k] <= stop:
                    pnl = (min(o[k], stop) if k > j else stop) / entry - 1
                    break
                if k > j and bb[k] and c[k] < bb[k][1]:
                    pnl = c[k] / entry - 1
                    break
                k += 1
            if pnl is None:
                pnl = c[k - 1] / entry - 1
            mfe = max(h[m] for m in range(j, min(k + 1, len(bars)))) / entry - 1
            pv = v[max(0, i - 20):i]
            vol_x = v[i] / st.mean(pv) if rth[i] and pv and st.mean(pv) > 0 else None
            rv5 = sum(v[max(0, i - 4):i + 1]) / (adv / 78) * 100 if rth[i] and adv else None
            for kind in kinds:
                out.append(dict(ticker=tk, day=d, et=et[i], kind=kind, gain=gain, pnl=pnl, mfe=mfe, rth=rth[i],
                                vol_x=vol_x, rv5=rv5, day_max=day_max))
    return out


def table(title, rows, sessions):
    print(f'\n## {title}')
    print(f"{'':44}{'/day':>6}{'avg':>8}{'>0':>5}{'median best':>12}{'day ran ≥+50%':>15}{'  halves':>20}")
    mid = sessions[len(sessions) // 2]
    for name, g in rows:
        if len(g) < 25:
            print(f"{name[:44]:44}{'n ' + str(len(g)):>6}")
            continue
        p = [e['pnl'] for e in g]
        h1 = [e['pnl'] for e in g if e['day'] < mid]
        h2 = [e['pnl'] for e in g if e['day'] >= mid]
        print(f"{name[:44]:44}{len(g) / len(sessions):6.1f}{st.mean(p):+8.2%}{sum(x > 0 for x in p) / len(p):5.0%}"
              f"{st.median(e['mfe'] for e in g):12.1%}{sum(e['day_max'] >= 50 for e in g) / len(g):15.0%}"
              f"{(st.mean(h1) if h1 else 0):+10.2%} /{(st.mean(h2) if h2 else 0):+8.2%}")


def main():
    lists = watchlists(sys.argv[1])
    sessions = sorted(lists)
    member = defaultdict(set)
    for d, names in lists.items():
        for tk in names:
            member[tk].add(d)
    os.makedirs(S.DATA, exist_ok=True)
    jobs = sorted({(tk, S.week_of(d)) for tk, ds in member.items() for d in ds})
    print(f"{len(sessions)} sessions, {sum(len(x) for x in lists.values())} watchlist ticker-days, "
          f"{len(member)} tickers, {len(jobs)} ticker-weeks", flush=True)
    with cf.ThreadPoolExecutor(4) as ex:
        list(ex.map(S.fetch, jobs))
    ev = []
    for tk, ds in member.items():
        bars = []
        for mon in sorted({S.week_of(d) for d in ds}):
            p = os.path.join(S.DATA, f'{tk}_{mon:%Y%m%d}.json')
            if os.path.exists(p):
                bars += json.load(open(p))
        bars.sort()
        if len(bars) > 30:
            ev += events_for(tk, bars, ds)
    k = lambda name: [e for e in ev if e['kind'] == name]
    table('first time the day reaches +g% while above the band (WORX 19:13-type), next candle takes the high',
          [(f'first-{g}', k(f'first-{g}')) for g in GAINS], sessions)
    table('fresh BO while the day is ≥ +g% (v19 = fresh-20)', [(f'fresh-{g}', k(f'fresh-{g}')) for g in GAINS], sessions)
    for g in (5, 10):
        base = k(f'first-{g}')
        reg = [e for e in base if e['rth']]
        table(f'first-{g}, by session and confirmation (volume only in regular hours)', [
            ('pre-market (04:00–09:30)', [e for e in base if not e['rth'] and e['et'].hour < 10]),
            ('after hours (16:00–20:00)', [e for e in base if not e['rth'] and e['et'].hour >= 16]),
            ('regular hours, all', reg),
            ('  candle volume ≥ 2× last 20', [e for e in reg if (e['vol_x'] or 0) >= 2]),
            ('  candle volume ≥ 4× last 20', [e for e in reg if (e['vol_x'] or 0) >= 4]),
            ('  RVol 5m ≥ 1,000%', [e for e in reg if (e['rv5'] or 0) >= 1000]),
            ('  RVol 5m ≥ 3,000%', [e for e in reg if (e['rv5'] or 0) >= 3000]),
            ('  RVol 5m ≥ 1,000% and volume ≥ 2×', [e for e in reg if (e['rv5'] or 0) >= 1000 and (e['vol_x'] or 0) >= 2]),
            ('  candle volume < 2× (no confirmation)', [e for e in reg if e['vol_x'] is not None and e['vol_x'] < 2]),
        ], sessions)
    worx = [e for e in ev if e['ticker'] == 'WORX']
    print('\nWORX in the sample:', [(e['day'].isoformat(), e['kind'], round(e['gain']), f"{e['pnl']:+.1%}") for e in worx][:12])


if __name__ == '__main__':
    main()
