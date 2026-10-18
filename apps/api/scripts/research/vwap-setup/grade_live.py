"""Grade the live 📐 signals (tier_events 'tv_setup') against what price did next.

  ssh root@<droplet> 'cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash -q' < export-live.sql > /tmp/vwap-setup/live.csv
  python3 grade_live.py /tmp/vwap-setup/live.csv          # full report
  python3 grade_live.py /tmp/vwap-setup/live.csv pb       # PULLBACK only (also: go, misc)

Events: the 30s/1m/2m copies of one event (same ticker, stage and lines within
5 min) are merged, as the History tab's 📐 Setups view does. A PULLBACK's
outcome is the first later BROKEN/HELD that day sharing one of its lines.

Columns:
- held / broke / open: TradingView's own outcome messages.
- win / loss: +10% vs −5% first, within 60 min (Yahoo 1m bars).
- mfe30 / mfe60: median best move; ≥10%: reached +10% within 60 min.
- trade: a stop 0.5% under the line (the line's value at the signal), a +10%
  target, out at the close 60 min later. The rule `research/vwap-pullback`
  used, so the numbers compare.
- tv: a trade priced on TradingView's messages alone: HELD at its price,
  BROKEN at its close (the operator's close-under-the-line exit).

Yahoo's extended-hours 1m bars have prices (no volume, which isn't needed), but
1m bars only reach back ~30 days: grade within a month. Bars are cached in
$VWAP_SETUP_DATA/live-bars. A signal whose price isn't within 3% of the Yahoo
bars around it is left out of the price-path columns.
"""
import bisect
import concurrent.futures as cf
import csv
import datetime
import json
import os
import random
import statistics as st
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict

from pinesim import ET

DATA = os.path.join(os.environ.get('VWAP_SETUP_DATA', '/tmp/vwap-setup'), 'live-bars')
MERGE = 300          # copies of one event within 5 min (History tab rule)
HORIZON = 3600       # 60 min
STOP_SLIP = 0.005    # a stop 0.5% under the line
MAX_GAP = 0.03       # TradingView vs Yahoo price at the signal


def line_tokens(stage, line):
    if stage in ('pullback', 'broken', 'held'):
        return ['session'] if not line else ['session', 'month'] if line == 'both' else line.split('+')
    return ['month'] if not line else ['month', 'year'] if line == 'both' else line.split('+')


def line_level(m, toks):
    """The nearest named line under price — the one a close under breaks first."""
    lv = {'session': m.get('svwap'), 'month': m.get('mvwap'), 'year': m.get('yvwap')}
    vals = [lv[t] for t in toks if lv.get(t)]
    return max(vals) if vals else None


def week_of(day):
    mon = day - datetime.timedelta(days=day.weekday())
    return mon, mon + datetime.timedelta(days=6)


# ---- Yahoo 1m bars, one request per ticker-week
def fetch(job):
    tk, mon = job
    out = os.path.join(DATA, f'{tk}_{mon:%Y%m%d}.json')
    if os.path.exists(out):
        return
    a = datetime.datetime.combine(mon, datetime.time(0), ET)
    b = a + datetime.timedelta(days=6)
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{tk.replace(".", "-")}?interval=1m'
           f'&period1={int(a.timestamp())}&period2={int(b.timestamp())}&includePrePost=true')
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            res = json.load(urllib.request.urlopen(req, timeout=20))['chart']['result'][0]
            q = res['indicators']['quote'][0]
            bars = [[t, o, h, l, c] for t, o, h, l, c in zip(res.get('timestamp') or [], q['open'], q['high'], q['low'], q['close'])
                    if c is not None]
            json.dump(bars, open(out, 'w'))
            return
        except urllib.error.HTTPError as e:
            if e.code == 404:
                json.dump([], open(out, 'w'))
                return
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))


BARS = {}


def bars(tk, day):
    mon = week_of(day)[0]
    if (tk, mon) not in BARS:
        p = os.path.join(DATA, f'{tk}_{mon:%Y%m%d}.json')
        b = json.load(open(p)) if os.path.exists(p) else []
        BARS[(tk, mon)] = (b, [x[0] for x in b])
    return BARS[(tk, mon)]


def path_after(tk, day, ts):
    """Bars from the one the signal arrived in (if under 30 s old) to 60 min later, same ET day."""
    b, tss = bars(tk, day)
    out = []
    for x in b[bisect.bisect_left(tss, ts - 30):]:
        if x[0] - ts > HORIZON + 60 or datetime.datetime.fromtimestamp(x[0], ET).date() != day:
            break
        out.append(x)
    return out


def price_gap(tk, day, ts, price):
    """Smallest gap between TradingView's price and the Yahoo bars around the signal (0 = inside a bar's range)."""
    b, tss = bars(tk, day)
    i, j = bisect.bisect_left(tss, ts - 150), bisect.bisect_right(tss, ts + 30)
    if i == j:
        return None
    best = 9
    for x in b[i:j]:
        if x[3] <= price <= x[2]:
            return 0
        best = min(best, abs(x[2] / price - 1), abs(x[3] / price - 1))
    return best


def score(e):
    p = path_after(e['ticker'], e['day'], e['ts'])
    if not p:
        return None
    entry, level = e['price'], line_level(e, e['toks'])
    race = 'none'
    for x in p:
        if x[3] <= entry * 0.95:
            race = 'loss'
            break
        if x[2] >= entry * 1.10:
            race = 'win'
            break
    trade = None
    if level:
        stop, trade = level * (1 - STOP_SLIP), p[-1][4] / entry - 1
        for x in p:
            if x[3] <= stop:
                trade = min(x[1], stop) / entry - 1
                break
            if x[2] >= entry * 1.10:
                trade = 0.10
                break
    return dict(race=race, trade=trade,
                mfe30=max((x[2] for x in p if x[0] - e['ts'] <= 1800), default=entry) / entry - 1,
                mfe60=max(x[2] for x in p) / entry - 1)


def load_events(path):
    rows = []
    for r in csv.DictReader(open(path)):
        m = json.loads(r['meta'])
        m.update(ticker=r['ticker'], ts=int(r['ts']))
        m['day'] = datetime.datetime.fromtimestamp(m['ts'], ET).date()
        rows.append(m)
    rows.sort(key=lambda m: m['ts'])
    events, last = [], {}
    for m in rows:
        toks = line_tokens(m['stage'], m.get('line'))
        k = (m['ticker'], m['stage'], '+'.join(toks))
        prev = last.get(k)
        if prev and m['ts'] - prev['ts'] <= MERGE:
            prev['tfs'].add(m.get('tf'))
            prev['notified'] |= bool(m.get('notified'))
            continue
        e = dict(m, toks=toks, tfs={m.get('tf')}, notified=bool(m.get('notified')))
        last[k] = e
        events.append(e)
    by_td = defaultdict(list)
    for e in events:
        by_td[(e['ticker'], e['day'])].append(e)
    for e in events:
        if e['stage'] != 'pullback':
            continue
        e['outcome'] = e['tv'] = None
        for x in by_td[(e['ticker'], e['day'])]:
            if x['ts'] > e['ts'] and x['stage'] in ('broken', 'held') and set(x['toks']) & set(e['toks']):
                e['outcome'], e['tv'] = x['stage'], x['price'] / e['price'] - 1
                break
    return rows, events, by_td


def tod(e):
    t = datetime.datetime.fromtimestamp(e['ts'], ET)
    h = t.hour + t.minute / 60
    return ('0 before 04:00' if h < 4 else '1 pre 04:00–07:00' if h < 7 else '2 pre 07:00–09:30' if h < 9.5
            else '3 open 09:30–10:30' if h < 10.5 else '4 10:30–12:00' if h < 12 else '5 12:00–16:00' if h < 16
            else '6 after 16:00')


def split(es, f):
    g = defaultdict(list)
    for e in es:
        g[f(e)].append(e)
    return sorted(g.items(), key=lambda kv: str(kv[0]))


def table(title, groups, pullback=False):
    print(f'\n## {title}')
    print(f"{'':28}{'n':>5}{'tick':>5}" + (f"{'held':>6}{'broke':>6}{'open':>6}{'tv':>8}" if pullback else '')
          + f"{'win':>6}{'loss':>6}{'mfe30':>7}{'mfe60':>7}{'≥10%':>6}{'trade':>8}{'>0':>5}")
    for name, es in groups:
        if not es:
            continue
        n = len(es)
        line = f"{str(name)[:28]:28}{n:>5}{len({e['ticker'] for e in es}):>5}"
        if pullback:
            oc = Counter(e.get('outcome') for e in es)
            tv = [e['tv'] for e in es if e.get('tv') is not None]
            line += f"{oc['held'] / n:>6.0%}{oc['broken'] / n:>6.0%}{oc[None] / n:>6.0%}{(st.mean(tv) if tv else 0):>8.2%}"
        s = [e['s'] for e in es if e.get('s')]
        tr = [x['trade'] for x in s if x['trade'] is not None]
        if s:
            line += (f"{sum(x['race'] == 'win' for x in s) / len(s):>6.0%}{sum(x['race'] == 'loss' for x in s) / len(s):>6.0%}"
                     f"{st.median(x['mfe30'] for x in s):>7.1%}{st.median(x['mfe60'] for x in s):>7.1%}"
                     f"{sum(x['mfe60'] >= 0.10 for x in s) / len(s):>6.0%}"
                     f"{(st.mean(tr) if tr else 0):>8.2%}{(sum(t > 0 for t in tr) / len(tr) if tr else 0):>5.0%}")
        print(line)


def peak_per_3min(stamps):
    stamps.sort()
    j = best = 0
    for i in range(len(stamps)):
        while stamps[i] - stamps[j] >= 180:
            j += 1
        best = max(best, i - j + 1)
    return best


def main():
    rows, events, by_td = load_events(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else 'all'
    os.makedirs(DATA, exist_ok=True)
    with cf.ThreadPoolExecutor(4) as ex:
        list(ex.map(fetch, sorted({(e['ticker'], week_of(e['day'])[0]) for e in events})))
    gaps = Counter()
    for e in events:
        g = price_gap(e['ticker'], e['day'], e['ts'], e['price']) if e.get('price') else 9
        gaps['no bar' if g is None else 'inside' if g == 0 else '≤3%' if g <= MAX_GAP else '>3% (left out)'] += 1
        if e['stage'] in ('pullback', 'go', 'ready', 'forming') and (g is None or g <= MAX_GAP):
            e['s'] = score(e)
    days = sorted({e['day'] for e in events})
    print(f"{len(rows)} rows → {len(events)} events, {days[0]} → {days[-1]} ({len(days)} days) | "
          f"TradingView price vs Yahoo bars: {dict(gaps)}")

    random.seed(1)
    base = Counter()
    for (tk, day) in by_td:
        b, _ = bars(tk, day)
        for i, x in enumerate(b):
            if datetime.datetime.fromtimestamp(x[0], ET).date() != day or random.random() > 0.25:
                continue
            r = 'none'
            for y in b[i + 1:]:
                if y[0] - x[0] > HORIZON + 60:
                    break
                if y[3] <= x[4] * 0.95:
                    r = 'loss'
                    break
                if y[2] >= x[4] * 1.10:
                    r = 'win'
                    break
            base[r] += 1
    nb = sum(base.values())
    print(f"baseline, any minute of the same ticker-days (n {nb:,}): win {base['win'] / nb:.0%}, loss {base['loss'] / nb:.0%}")

    pb = [e for e in events if e['stage'] == 'pullback']
    ann = [e for e in pb if e['notified']]
    go = [e for e in events if e['stage'] == 'go']
    if mode in ('all', 'pb'):
        table('PULLBACK', [('all', pb), ('announced', ann), ('not announced', [e for e in pb if not e['notified']])], True)
        table('PULLBACK announced, by line (any line it names)', [(t, [e for e in ann if t in e['toks']]) for t in ('session', 'month', 'year')], True)
        table('PULLBACK announced, by line (exact)', split(ann, lambda e: '+'.join(e['toks'])), True)
        table('PULLBACK announced, by touch', split(ann, lambda e: f"{min(e.get('touch') or 0, 3)}{'+' if (e.get('touch') or 0) >= 3 else ''}"), True)
        table('PULLBACK announced, by time (ET)', split(ann, tod), True)
        table('PULLBACK announced, on Momentum and grade at the signal (fade-capped, as shown)',
              [('off Momentum', [e for e in ann if not e.get('on_screen')])]
              + split([e for e in ann if e.get('on_screen')], lambda e: {'A+': 'A+/A', 'A': 'A+/A'}.get(e.get('grade'), e.get('grade') if e.get('grade') in ('A-', 'B+') else 'B or lower')), True)
        table('PULLBACK announced, by peak above the line', split(ann, lambda e: (lambda p: '?' if p is None else '1 <25%' if p < 25 else '2 25–50%' if p < 50 else '3 50%+')(e.get('peak_pct'))), True)
        table('PULLBACK, by the timeframes that caught it', split(pb, lambda e: '+'.join(sorted(t for t in e['tfs'] if t))), True)
        v16 = [e for e in pb if e.get('fails') is not None]
        table('PULLBACK cap (v16 rows)', [
            ('fails 0', [e for e in v16 if e['fails'] == 0]), ('fails 1', [e for e in v16 if e['fails'] == 1]),
            ('capped + exempt (pinged)', [e for e in v16 if e.get('capped') and e.get('cap_exempt')]),
            ('capped + quiet', [e for e in v16 if e.get('capped') and not e.get('cap_exempt')])], True)
        ce = [e for e in v16 if e.get('capped') and e.get('cap_exempt')]
        print('  capped + exempt by ticker:', Counter(e['ticker'] for e in ce).most_common(8))
        table('PULLBACK announced, by day', split(ann, lambda e: e['day']), True)
    if mode in ('all', 'go'):
        gann = [e for e in go if e['notified']]
        table('GO', [('all', go), ('announced', gann)])
        table('GO announced, by line', split(gann, lambda e: '+'.join(e['toks'])))
        table('GO announced, by strength 💪', split(gann, lambda e: (e.get('strength') or {}).get('score')))
        for chk in ('morning', 'run_up', 'volume', 'on_momentum'):
            table(f'GO announced, check {chk}', split(gann, lambda e, c=chk: (e.get('strength') or {}).get(c)))
        table('GO announced, via', split(gann, lambda e: e.get('go_via')))
        table('GO announced, by time (ET)', split(gann, tod))
        table('GO announced, grade at the signal (on Momentum)', split([e for e in gann if e.get('on_screen')], lambda e: e.get('grade') or '?'))
        seen, first, rep = set(), [], []
        for e in gann:
            k = (e['ticker'], e['day'], '+'.join(e['toks']))
            (rep if k in seen else first).append(e)
            seen.add(k)
        table('GO announced, first of the day (ticker + line) vs repeat', [('first', first), ('repeat', rep)])
        table('GO, by the timeframes that caught it', split(go, lambda e: '+'.join(sorted(t for t in e['tfs'] if t))))
        table('READY (quiet since 10-06)', [('all', [e for e in events if e['stage'] == 'ready'])])
    if mode in ('all', 'misc'):
        f = defaultdict(set)
        for m in rows:
            if m['stage'] in ('forming', 'ready', 'go'):
                for t in line_tokens(m['stage'], m.get('line')):
                    f[(m['ticker'], m['day'], t, m.get('tf'))].add(m['stage'])
        nr = sum('ready' in v for v in f.values())
        print(f"\nRECLAIM funnel per ticker-day-line-timeframe: FORMING {sum('forming' in v for v in f.values())}, "
              f"READY {nr}, GO {sum('go' in v for v in f.values())}; READY → GO {sum({'ready', 'go'} <= v for v in f.values()) / nr:.0%}")
        per_sym, per_alert = defaultdict(list), defaultdict(list)
        for m in rows:
            per_sym[(m.get('tf'), m['ticker'])].append(m['ts'])
            per_alert[m.get('tf')].append(m['ts'])
        sym = {}
        for (tf, tk), ts in per_sym.items():
            p = peak_per_3min(ts)
            if p > sym.get(tf, (0, ''))[0]:
                sym[tf] = (p, tk)
        print('TradingView limits — peak per symbol per 3 min (limit 15):', sym,
              '| per alert per 3 min (limit 1,000):', {tf: peak_per_3min(ts) for tf, ts in per_alert.items()})
        per_day = defaultdict(Counter)
        for e in events:
            if e['notified']:
                per_day[e['day']][f"{e['stage']} {'⭐' if e.get('on_screen') else 'off'}"] += 1
        print('Announced events per day:')
        for d in sorted(per_day):
            print(' ', d, dict(sorted(per_day[d].items())), 'total', sum(per_day[d].values()))


if __name__ == '__main__':
    main()
