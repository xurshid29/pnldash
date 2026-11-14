"""RSI DIP — enter when the MACD line crosses zero after the DIP.
(operator, 2026-11-15, from looking at 5m charts by hand: "get the latest DIP (from DIP, not from
LIFT) and wait for the MACD line cross the zero, and most of them could reach 10-15% change".
Their layout: a 5m chart, TradingView's standard MACD, the RSI cross checked at 1h with a 10m RSI.)

Data     the Yahoo 5m bars dip_lift_study.py cached; the DIPs of --rsi 10 checked at --check 60 by
         pinesim.rsi_rule_direct.
Entry    MACD   after the DIP candle closes, the first --macd-tf bar that closes with the MACD line
                (EMA 12 − EMA 26 of the closes) above zero after being at or under it; bought at
                that close. The wait ends with a newer DIP ("the latest DIP") or --expire sessions.
         DIP    the DIP candle's close.   LIFT 8 / 10   the buy stop above it (v38).
Outcome  from the entry, for a +10% and a +15% target:
         reach   the price got there within 1, 3 or 5 sessions after the entry's, no stop
         w8 / w15   it got there before falling 8% / 15% under the entry (3 sessions)
         a8      the average result with the −8% stop and that target, 3 sessions, %
         best / worst   the highest and the lowest against the entry in 3 sessions, median %
         first   for the ones that reached +10%: how far under the entry they went first, median %
Split    by date: the first --split of the sessions in sample, the rest out of sample.

Run:  python3 -I dip_macd_cross.py tickers.txt --cache DIR [--macd-tf 5]
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
ap.add_argument('--macd-tf', type=int, default=5, help="the MACD's chart timeframe, minutes")
ap.add_argument('--expire', type=int, default=3)
ap.add_argument('--split', type=float, default=0.6)
args = ap.parse_args()
ET = zoneinfo.ZoneInfo('America/New_York')
HOLDS = (1, 3, 5)


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


def walk(bars, last, dates, i, entry):
    """Bought at `entry` at the end of bar i → what the next 5 sessions did."""
    k = bisect.bisect_left(dates, bars[i]['t'].date())
    ends = {h: last[dates[min(k + h, len(dates) - 1)]] for h in HOLDS}
    full = {h: k + h < len(dates) for h in HOLDS}
    at = dict(t10=None, t15=None, s8=None, s15=None)
    hi = lo = entry
    first10 = None
    snap = {}
    for m in range(i + 1, ends[5] + 1):
        b = bars[m]
        if at['s8'] is None and b['l'] <= entry * 0.92:
            at['s8'] = m
        if at['s15'] is None and b['l'] <= entry * 0.85:
            at['s15'] = m
        if at['t10'] is None and b['h'] >= entry * 1.10:
            at['t10'], first10 = m, (min(lo, b['o']) / entry - 1) * 100
        if at['t15'] is None and b['h'] >= entry * 1.15:
            at['t15'] = m
        hi, lo = max(hi, b['h']), min(lo, b['l'])
        for h in HOLDS:
            if m == ends[h]:
                snap[h] = ((hi / entry - 1) * 100, (lo / entry - 1) * 100, (b['c'] / entry - 1) * 100)
    out = dict(day=bars[i]['t'].date(), full=full, first10=first10, snap=snap)
    for T, key in ((10, 't10'), (15, 't15')):
        t = at[key]
        for h in HOLDS:
            out[f'reach{T}_{h}'] = t is not None and t <= ends[h]
        for S, skey in ((8, 's8'), (15, 's15')):
            s = at[skey]
            won = t is not None and t <= ends[3] and (s is None or s > t)
            out[f'w{S}_{T}'] = won
            if S == 8:
                stopped = s is not None and s <= ends[3] and (t is None or s <= t)
                out[f'a8_{T}'] = -8.0 if stopped else float(T) if won else snap.get(3, (0, 0, 0))[2]
    return out


ROWS = {'macd': [], 'dip': [], 'lift8': [], 'lift10': []}
DIPS = above_at_dip = 0
WAIT, GAP = [], []
tickers = [x.strip() for x in open(args.tickers) if x.strip()]
all_days = set()
for n_t, tk in enumerate(tickers):
    path = os.path.join(args.cache, f'{tk}.json')
    bars = load(path) if os.path.exists(path) else []
    if len(bars) < 500:
        continue
    times = [b['t'] for b in bars]
    last = {}
    for i, b in enumerate(bars):
        last[b['t'].date()] = i
    dates = sorted(last)
    all_days.update(dates)
    # the MACD line on the MACD chart's bars, mapped to the 5m bar that closes each of them
    mb = pinesim.resample_session(bars, args.macd_tf)
    closes = [x['c'] for x in mb]
    e12, e26 = pinesim.ema_series(closes, 12), pinesim.ema_series(closes, 26)
    line = [None if a is None or b is None else a - b for a, b in zip(e12, e26)]
    m_end = []          # index of the last 5m bar inside each MACD bar
    j = 0
    for x in range(len(mb)):
        nxt = mb[x + 1]['t'] if x + 1 < len(mb) else None
        while j + 1 < len(bars) and (nxt is None or bars[j + 1]['t'] < nxt):
            j += 1
        m_end.append(j)
        j += 1
    candles = pinesim.resample_session(bars, args.rsi)
    close_of = {c['t']: c['c'] for c in candles}
    step = datetime.timedelta(minutes=args.rsi)
    dips = pinesim.rsi_rule_direct(candles, dict(sig_min=args.rsi, check_min=args.check))['dips']
    for d_i, (t0, _n, _low, _age) in enumerate(dips):
        p = close_of[t0]
        i0 = bisect.bisect_left(times, t0 + step)
        if i0 < 1 or i0 >= len(bars):
            continue
        DIPS += 1
        k = bisect.bisect_left(dates, t0.date())
        i_end = last[dates[min(k + args.expire, len(dates) - 1)]]
        if d_i + 1 < len(dips):
            i_end = min(i_end, bisect.bisect_left(times, dips[d_i + 1][0] + step) - 1)
        ROWS['dip'].append(walk(bars, last, dates, i0 - 1, p))
        for name, L in (('lift8', 8), ('lift10', 10)):
            level = p * (1 + L / 100)
            for m in range(i0, i_end + 1):
                if bars[m]['h'] >= level:
                    ROWS[name].append(walk(bars, last, dates, m, max(level, bars[m]['o'])))
                    break
        # the MACD bars that close after the DIP candle: the first cross up through zero
        x0 = bisect.bisect_left(m_end, i0)                # first MACD bar closing at or after bar i0
        prev = line[x0 - 1] if x0 >= 1 else None
        if prev is not None and prev > 0:
            above_at_dip += 1
        for x in range(max(x0, 1), len(mb)):
            if m_end[x] > i_end:
                break
            if line[x] is not None and line[x - 1] is not None and line[x] > 0 and line[x - 1] <= 0:
                m = m_end[x]
                ROWS['macd'].append(walk(bars, last, dates, m, bars[m]['c']))
                WAIT.append((bars[m]['t'] - bars[i0 - 1]['t']).total_seconds() / 3600)
                GAP.append((bars[m]['c'] / p - 1) * 100)
                break
    if (n_t + 1) % 50 == 0:
        print(f'  {n_t + 1}/{len(tickers)} tickers', file=sys.stderr, flush=True)

days = sorted(all_days)
cut = days[int(len(days) * args.split)]
print(f"{days[0]} → {days[-1]} | RSI {args.rsi}m checked at {args.check}m | {DIPS:,} DIPs | MACD 12 / 26 on {args.macd_tf}m bars | in sample before {cut}")
print(f"the MACD line was already above zero at {above_at_dip / DIPS * 100:.0f}% of the DIPs (there the next cross up counts); "
      f"it crossed up before a newer DIP or {args.expire} sessions on {len(ROWS['macd']) / DIPS * 100:.0f}% of them, "
      f"a median {statistics.median(WAIT):.1f}h later and {statistics.median(GAP):+.1f}% from the DIP's price "
      f"(quartiles {sorted(GAP)[len(GAP) // 4]:+.1f}% / {sorted(GAP)[3 * len(GAP) // 4]:+.1f}%)")


def pct(rows, key, h=None):
    rows = [r for r in rows if h is None or r['full'][h]]
    return sum(r[key] for r in rows) / len(rows) * 100 if rows else float('nan')


def line_for(rows):
    if len(rows) < 5:
        return f"{len(rows):>5}      —"
    f3 = [r for r in rows if r['full'][3] and 3 in r['snap']]
    reached = [r['first10'] for r in f3 if r['reach10_3'] and r['first10'] is not None]
    out = f"{len(rows):>5}"
    for T in (10, 15):
        out += (f"  | +{T}%: reach {pct(rows, f'reach{T}_1', 1):3.0f}/{pct(rows, f'reach{T}_3', 3):3.0f}/{pct(rows, f'reach{T}_5', 5):3.0f}%"
                f"  w8 {pct(f3, f'w8_{T}'):3.0f}%  w15 {pct(f3, f'w15_{T}'):3.0f}%  a8 {statistics.mean(r[f'a8_{T}'] for r in f3):+5.2f}%")
    out += (f"  | best {statistics.median(r['snap'][3][0] for r in f3):+5.1f}%  worst {statistics.median(r['snap'][3][1] for r in f3):+5.1f}%"
            f"  first {statistics.median(reached) if reached else float('nan'):+5.1f}%")
    return out


# Week by week (the entry's week): what a chart of the last weeks shows is not the 60 days' average.
print("\nthe MACD entry by week: entries, reached +10% within 3 / 5 sessions (no stop), the best in 3 sessions (median)")
weeks = {}
for r in ROWS['macd']:
    weeks.setdefault(r['day'] - datetime.timedelta(days=r['day'].weekday()), []).append(r)
for wk in sorted(weeks):
    rows = weeks[wk]
    f3 = [r for r in rows if r['full'][3] and 3 in r['snap']]
    if len(f3) < 20:
        print(f"  week of {wk}  {len(rows):>4}  (its sessions aren't over)")
        continue
    print(f"  week of {wk}  {len(rows):>4}  +10%: {pct(rows, 'reach10_3', 3):3.0f}% / {pct(rows, 'reach10_5', 5):3.0f}%   +15%: {pct(rows, 'reach15_3', 3):3.0f}% / {pct(rows, 'reach15_5', 5):3.0f}%   "
          f"best {statistics.median(r['snap'][3][0] for r in f3):+5.1f}%  worst {statistics.median(r['snap'][3][1] for r in f3):+5.1f}%")

print("\n(reach = within 1 / 3 / 5 sessions, no stop; w8, w15, a8, best, worst, first = 3 sessions)")
for name, title in (('macd', f'MACD line crosses zero ({args.macd_tf}m)'), ('dip', 'buy the DIP'), ('lift8', 'LIFT +8%'), ('lift10', 'LIFT +10%')):
    a = [r for r in ROWS[name] if r['day'] < cut]
    b = [r for r in ROWS[name] if r['day'] >= cut]
    print(f"  {title:<28} in  {line_for(a)}\n  {'':<28} out {line_for(b)}")
