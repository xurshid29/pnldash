"""RSI DIP — what, known at the entry, separates the trades that reach a 15% take-profit?
(operator, 2026-11-14, after the timeframe grid: "what could we do to raise it to 50%?" They pick
their DIPs by "price actions, RSI, and previous behavior".)

Data     the Yahoo 5m bars dip_lift_study.py cached; the DIPs of the operator's settings (--rsi 10
         checked at --check 60) by pinesim.rsi_rule_direct.
Entries  DIP (its candle's close) and LIFT (a buy stop --lift % above it, as v38).
Outcome  take-profit --tp % above the entry, held --hold sessions after the entry's:
         reach   it got there, no stop
         w8      it got there before a stop 8% under the entry      (35% needed with +15%)
         w15     it got there before a stop 15% under the entry     (50% needed)
         a8 / a15  the average result with that stop, %
Features every one from bars before the entry (the entry price is the only thing from its own bar):
         tod        when: pre-market, open (09:30–11:00), midday, close (15:00–16:00), after hours
         px         the price
         day        the entry against the last regular close, %
         d3 / d5    against the regular close 3 / 5 sessions back, %
         offhi5     under the highest high of the last 5 sessions and today so far, %
         abvlo5     over the lowest low of the same, %
         adr5       the average daily range of the last 5 sessions, % (how much the name moves)
         run10      the best day (high over the prior close) of the last 10 sessions, %
         big10      sessions of the last 10 whose high was 15%+ over the prior close
         rvprev     the last session's regular-hours volume over the 5 before it
         rvday      today's regular-hours volume so far over an average day of the last 5
         twap       against the average price of today's bars so far, %
         sma1 / sma5  against the average close of the last 1 / 5 sessions of bars, %
         rsi        the RSI at the DIP candle;  rsimin  its lowest in the 12 candles before
         rsi1h      the 1h RSI (14) after its last finished candle
         drop       the DIP's close under the highest close of the 36 candles before, %
         n / age    the DIP's number in its dip; candles since the RSI cross
         wait       LIFT only: hours from the DIP to the fill
Method   each number is cut in thirds on the in-sample trades; a third counts when it wins in both
         halves. Pairs of the best thirds are tried last. The first --split of the sessions are in
         sample. Many things are tried, so one that helps in one half only is noise.

Run:  python3 -I dip_features.py tickers.txt --cache DIR [--tp 15] [--lift 8] [--hold 3]
"""
import argparse, bisect, datetime, json, os, statistics, sys, zoneinfo

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
import pinesim  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('tickers')
ap.add_argument('--cache', required=True)
ap.add_argument('--rsi', type=int, default=10)
ap.add_argument('--check', type=int, default=60)
ap.add_argument('--tp', type=float, default=15.0)
ap.add_argument('--lift', type=float, default=8.0)
ap.add_argument('--expire', type=int, default=3)
ap.add_argument('--hold', type=int, default=3)
ap.add_argument('--split', type=float, default=0.6)
args = ap.parse_args()
ET = zoneinfo.ZoneInfo('America/New_York')
P_RSI = dict(sig_min=args.rsi, check_min=args.check)


def load(path):
    try:
        with open(path) as f:
            res = json.load(f)['chart']['result'][0]
        ts, q = res['timestamp'], res['indicators']['quote'][0]
    except Exception:
        return []
    splits = [int(k) for k in (res.get('events') or {}).get('splits', {})]
    since = max(splits) if splits else 0
    out = []
    for i, t in enumerate(ts):
        o, h, l, c = q['open'][i], q['high'][i], q['low'][i], q['close'][i]
        if None in (o, h, l, c) or c <= 0 or t < since:
            continue
        d = datetime.datetime.fromtimestamp(t, ET)
        if not (240 <= d.hour * 60 + d.minute < 1200) or d.weekday() >= 5:
            continue
        out.append(dict(t=d, o=o, h=h, l=l, c=c, v=q['volume'][i] or 0))
    return out


def tick(p):
    return 0.0001 if p < 1 else 0.01


def tod(t):
    m = t.hour * 60 + t.minute
    return 'pre' if m < 570 else 'open' if m < 660 else 'mid' if m < 900 else 'close' if m < 960 else 'after'


class Tape:
    def __init__(self, bars):
        self.bars = bars
        self.times = [b['t'] for b in bars]
        self.days = []            # per session: first, last bar, high, low, regular close, regular volume
        self.day_of = []          # bar → session index
        self.run_hi, self.run_lo, self.run_vol, self.run_sum = [], [], [], []   # today so far, through each bar
        self.pref = [0.0]         # prefix sums of closes
        cur = None
        for i, b in enumerate(bars):
            d = b['t'].date()
            rth = 570 <= b['t'].hour * 60 + b['t'].minute < 960
            if cur is None or cur['date'] != d:
                cur = dict(date=d, first=i, last=i, hi=b['h'], lo=b['l'], rclose=None, rvol=0.0, close=b['c'])
                self.days.append(cur)
                hi, lo, vol, s = b['h'], b['l'], 0.0, 0.0
            hi, lo = max(hi, b['h']), min(lo, b['l'])
            cur['last'], cur['hi'], cur['lo'], cur['close'] = i, hi, lo, b['c']
            if rth:
                cur['rclose'] = b['c']
                cur['rvol'] += b['v']
                vol += b['v']
            s += b['c']
            self.day_of.append(len(self.days) - 1)
            self.run_hi.append(hi); self.run_lo.append(lo); self.run_vol.append(vol); self.run_sum.append(s)
            self.pref.append(self.pref[-1] + b['c'])
        for d in self.days:
            if d['rclose'] is None:
                d['rclose'] = d['close']

    def features(self, i, px):
        """What is known through bar i, for an entry at `px` just after it."""
        k = self.day_of[i]
        if k < 5:
            return None
        D = self.days
        prev = D[k - 5:k]
        f = dict(tod=tod(self.bars[min(i + 1, len(self.bars) - 1)]['t']), px=px)
        f['day'] = (px / D[k - 1]['rclose'] - 1) * 100
        f['d3'] = (px / D[k - 3]['rclose'] - 1) * 100
        f['d5'] = (px / D[k - 5]['rclose'] - 1) * 100
        f['offhi5'] = (px / max(max(d['hi'] for d in prev), self.run_hi[i]) - 1) * 100
        f['abvlo5'] = (px / min(min(d['lo'] for d in prev), self.run_lo[i]) - 1) * 100
        f['adr5'] = statistics.mean((d['hi'] - d['lo']) / d['close'] for d in prev) * 100
        gains = [(D[j]['hi'] / D[j - 1]['rclose'] - 1) * 100 for j in range(max(1, k - 10), k)]
        f['run10'] = max(gains)
        f['big10'] = sum(1 for g in gains if g >= 15)
        base = statistics.mean(d['rvol'] for d in prev)
        older = [d['rvol'] for d in D[max(0, k - 6):k - 1]]
        f['rvprev'] = D[k - 1]['rvol'] / statistics.mean(older) if older and statistics.mean(older) > 0 else None
        f['rvday'] = self.run_vol[i] / base if base > 0 else None
        n_today = i - D[k]['first'] + 1
        f['twap'] = (px / (self.run_sum[i] / n_today) - 1) * 100
        for name, span in (('sma1', 192), ('sma5', 960)):
            lo = max(0, i + 1 - span)
            f[name] = (px / ((self.pref[i + 1] - self.pref[lo]) / (i + 1 - lo)) - 1) * 100
        return f

    def trade(self, i, entry):
        k = self.day_of[i]
        end = self.days[min(k + args.hold, len(self.days) - 1)]['last']
        tp = entry * (1 + args.tp / 100)
        res, reach = {}, False
        for m in range(i + 1, end + 1):
            b = self.bars[m]
            for s in (8, 15):
                if s not in res and b['l'] <= entry * (1 - s / 100):
                    res[s] = (False, (min(entry * (1 - s / 100), b['o']) / entry - 1) * 100)
            if b['h'] >= tp:
                reach = True
                for s in (8, 15):
                    res.setdefault(s, (True, args.tp))
                break
        timed = (self.bars[end]['c'] / entry - 1) * 100
        return dict(reach=reach, w8=res.get(8, (False, timed))[0], a8=res.get(8, (False, timed))[1],
                    w15=res.get(15, (False, timed))[0], a15=res.get(15, (False, timed))[1])


ROWS = {'dip': [], 'lift': []}
tickers = [x.strip() for x in open(args.tickers) if x.strip()]
all_days = set()
for n_t, tk in enumerate(tickers):
    path = os.path.join(args.cache, f'{tk}.json')
    bars = load(path) if os.path.exists(path) else []
    if len(bars) < 500:
        continue
    tape = Tape(bars)
    all_days.update(d['date'] for d in tape.days)
    candles = pinesim.resample_session(bars, args.rsi)
    ser = pinesim._rsi_series(candles, dict(pinesim.RSI_DEFAULTS, **P_RSI))
    idx = {c['t']: j for j, c in enumerate(candles)}
    hour = pinesim.resample_session(bars, 60)
    h_rsi = [None if x is None else x[2] for x in pinesim.rsi_states([c['c'] for c in hour], 14)]
    h_t = [c['t'] for c in hour]
    step = datetime.timedelta(minutes=args.rsi)
    dips = pinesim.rsi_rule_direct(candles, P_RSI)['dips']
    for j, (t0, n, low_px, age) in enumerate(dips):
        cj = idx[t0]
        p = candles[cj]['c']
        i0 = bisect.bisect_left(tape.times, t0 + step)
        if i0 < 1 or i0 >= len(bars):
            continue
        r = ser[cj]
        rs = [x[0] for x in ser[max(0, cj - 12):cj] if x is not None]
        hj = bisect.bisect_right(h_t, t0 + step - datetime.timedelta(minutes=60)) - 1
        own = dict(rsi=r[0] if r else None, rsimin=min(rs) if rs else None,
                   rsi1h=h_rsi[hj] if hj >= 0 else None,
                   drop=(p / max(c['c'] for c in candles[max(0, cj - 36):cj + 1]) - 1) * 100, n=n, age=age)
        f = tape.features(i0 - 1, p)
        if f is not None:
            ROWS['dip'].append(dict(f, **own, **tape.trade(i0 - 1, p), date=t0.date(), tk=tk))
        k = tape.day_of[i0 - 1]
        i_end = tape.days[min(k + args.expire, len(tape.days) - 1)]['last']
        if j + 1 < len(dips):
            i_end = min(i_end, bisect.bisect_left(tape.times, dips[j + 1][0] + step) - 1)
        level = p * (1 + args.lift / 100)
        for m in range(i0, i_end + 1):
            if bars[m]['h'] >= level:
                fill = max(level, bars[m]['o'])
                f = tape.features(m - 1, fill)
                if f is not None:
                    f['tod'] = tod(bars[m]['t'])
                    ROWS['lift'].append(dict(f, **own, **tape.trade(m, fill), date=bars[m]['t'].date(), tk=tk,
                                             wait=(bars[m]['t'] - bars[i0 - 1]['t']).total_seconds() / 3600))
                break
    if (n_t + 1) % 50 == 0:
        print(f'  {n_t + 1}/{len(tickers)} tickers', file=sys.stderr, flush=True)

days = sorted(all_days)
cut = days[int(len(days) * args.split)]
print(f"{days[0]} → {days[-1]} | RSI {args.rsi}m checked at {args.check}m | take-profit +{args.tp:g}%, held {args.hold} sessions | LIFT +{args.lift:g}% | "
      f"in sample before {cut} | {len(ROWS['dip']):,} DIP entries, {len(ROWS['lift']):,} LIFT entries (with 5 sessions of history)")


def stat(rows):
    if not rows:
        return None
    n = len(rows)
    return dict(n=n, reach=sum(r['reach'] for r in rows) / n * 100, w8=sum(r['w8'] for r in rows) / n * 100,
                w15=sum(r['w15'] for r in rows) / n * 100, a8=statistics.mean(r['a8'] for r in rows), a15=statistics.mean(r['a15'] for r in rows))


def show(s):
    return '     —' if s is None else (f"{s['n']:>5}  reach {s['reach']:3.0f}%  w8 {s['w8']:3.0f}% (a {s['a8']:+5.2f}%)  w15 {s['w15']:3.0f}% (a {s['a15']:+5.2f}%)")


NUMERIC = ['px', 'day', 'd3', 'd5', 'offhi5', 'abvlo5', 'adr5', 'run10', 'big10', 'rvprev', 'rvday', 'twap', 'sma1', 'sma5',
           'rsi', 'rsimin', 'rsi1h', 'drop', 'age', 'wait']
CATEG = ['tod', 'n']

for kind in ('lift', 'dip'):
    rows = ROWS[kind]
    IS = [r for r in rows if r['date'] < cut]
    OOS = [r for r in rows if r['date'] >= cut]
    print(f"\n{'=' * 30} ENTRY AT THE {kind.upper()} {'=' * 30}")
    print(f"  all            in  {show(stat(IS))}\n                 out {show(stat(OOS))}")
    conds = []      # (label, predicate) of every third / category, for the pairs below
    for name in CATEG:
        print(f"\n  -- {name} --")
        for v in sorted({r[name] for r in rows}, key=str):
            pred = (lambda r, name=name, v=v: r[name] == v)
            a, b = stat([r for r in IS if pred(r)]), stat([r for r in OOS if pred(r)])
            print(f"  {str(v):<14} in  {show(a)}\n  {'':<14} out {show(b)}")
            conds.append((f'{name}={v}', pred))
    for name in NUMERIC:
        vals = sorted(r[name] for r in IS if r.get(name) is not None)
        if len(vals) < 60:
            continue
        e1, e2 = vals[len(vals) // 3], vals[2 * len(vals) // 3]
        if e1 == e2:
            continue
        print(f"\n  -- {name} (thirds at {e1:.3g} and {e2:.3g}) --")
        for label, pred in ((f'{name} ≤ {e1:.3g}', lambda r, name=name, e1=e1: r.get(name) is not None and r[name] <= e1),
                            (f'{name} mid', lambda r, name=name, e1=e1, e2=e2: r.get(name) is not None and e1 < r[name] <= e2),
                            (f'{name} > {e2:.3g}', lambda r, name=name, e2=e2: r.get(name) is not None and r[name] > e2)):
            a, b = stat([r for r in IS if pred(r)]), stat([r for r in OOS if pred(r)])
            print(f"  {label:<14} in  {show(a)}\n  {'':<14} out {show(b)}")
            conds.append((label, pred))

    # Which single conditions, and which pairs of them, win most often with the -15% stop in BOTH halves?
    def both(pred, need=50):
        a, b = [r for r in IS if pred(r)], [r for r in OOS if pred(r)]
        return (stat(a), stat(b)) if len(a) >= need and len(b) >= need else None

    singles = sorted(((min(s[0]['w15'], s[1]['w15']), label, s) for label, pred in conds if (s := both(pred))), reverse=True)
    print(f"\n  -- single conditions, by the worse half's w15 (50+ trades in each half) --")
    for worst, label, (a, b) in singles[:10]:
        print(f"  {label:<26} in {show(a)}   out {show(b)}")
    top = [(label, pred) for label, pred in conds if any(label == s[1] for s in singles[:12])]
    pairs = []
    for x in range(len(top)):
        for y in range(x + 1, len(top)):
            if top[x][0].split(' ')[0].split('=')[0] == top[y][0].split(' ')[0].split('=')[0]:
                continue
            pred = (lambda r, p1=top[x][1], p2=top[y][1]: p1(r) and p2(r))
            if (s := both(pred, need=40)):
                pairs.append((min(s[0]['w15'], s[1]['w15']), f'{top[x][0]}  +  {top[y][0]}', s))
    pairs.sort(reverse=True)
    print(f"\n  -- pairs of the 12 best, by the worse half's w15 (40+ trades in each half) --")
    for worst, label, (a, b) in pairs[:12]:
        print(f"  {label:<44} in {show(a)}   out {show(b)}")
