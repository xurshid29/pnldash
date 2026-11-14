"""RSI DIP — which RSI timeframe and check timeframe win most often with a take-profit near 15%?
(operator, 2026-11-14: "can we measure what chart timeframe + RSI and RSI Cross timeframe+RSI can
have better win rate, if we put take-profit around 15%?")

The script's RSI setup has two timeframes: the RSI's own (`rsTfA`: the candles the RSI, its MA and
the DIP are read on — the operator's chart and its RSI) and the check timeframe (`rsCheck`: the RSI
cross is judged at these candles' closes). This replays the rule for a grid of the two on the same
bars and grades two entries with one exit.

Data     the Yahoo 5m bars dip_lift_study.py cached (60 days, extended hours, the tickers of the
         live RSI / DIP alerts). RSI timeframes are multiples of 5m; a check timeframe is a multiple
         of the RSI's.
Entries  DIP    the DIP candle's close
         LIFT   a buy stop --lift % above it (v38), live until a newer DIP or --expire sessions
Exit     take-profit --tp % above the entry, a stop, else out at the last bar of the --hold-th
         session after the entry's. Three stops, since a win rate means nothing without one:
         reach    no stop: the price got to the take-profit at some point in the hold
         -8%      a stop 8% under the entry (for a LIFT, about back at the DIP's price). With a
                  +15% target it needs 35% wins to break even
         -15%     a stop as far as the target: needs 50% wins
         low      a tick under the dip's low, the stop the alerts carry (`risk` = its median
                  distance). Too tight for a 15% target on a DIP entry: it is 1–3% away
         win = the take-profit came first (the stop first when one 5m bar holds both);
         avg = the average result per trade, % — the number that matters.
Split    by date: the first --split of the sessions in sample, the rest out of sample.

Run:  python3 -I rsi_tf_grid.py tickers.txt --cache DIR [--tp 15] [--lift 8] [--hold 3]
"""
import argparse, bisect, datetime, json, os, statistics, sys, zoneinfo

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
import pinesim  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('tickers')
ap.add_argument('--cache', required=True)
ap.add_argument('--tp', type=float, default=15.0, help='take-profit, %% above the entry')
ap.add_argument('--lift', type=float, default=8.0, help='the LIFT level, %% above the DIP')
ap.add_argument('--expire', type=int, default=3, help='sessions a LIFT order stays live after the DIP day')
ap.add_argument('--hold', type=int, default=3, help='sessions a trade is held after the entry day')
ap.add_argument('--split', type=float, default=0.6)
args = ap.parse_args()
ET = zoneinfo.ZoneInfo('America/New_York')
GRID = [(5, 5), (5, 15), (5, 30), (5, 60),
        (10, 10), (10, 30), (10, 60), (10, 120),
        (15, 15), (15, 30), (15, 60), (15, 120), (15, 240),
        (30, 30), (30, 60), (30, 120), (30, 240),
        (60, 60), (60, 120), (60, 240)]


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


def tf(m):
    return f'{m // 60}h' if m % 60 == 0 else f'{m}m'


STOPS = ['8', '15', 'low']      # % under the entry, or the dip's low


def trade(bars, last, dates, i, entry, low_stop):
    """Bought at `entry` inside bar i → for each stop, what the exit gave on the bars after i."""
    k = bisect.bisect_left(dates, bars[i]['t'].date())
    end = last[dates[min(k + args.hold, len(dates) - 1)]]
    tp = entry * (1 + args.tp / 100)
    level = {'8': entry * 0.92, '15': entry * 0.85, 'low': low_stop}
    res, reach = {}, False
    for m in range(i + 1, end + 1):
        b = bars[m]
        for s in STOPS:
            if s not in res and b['l'] <= level[s]:
                res[s] = ('stop', (min(level[s], b['o']) / entry - 1) * 100)
        if b['h'] >= tp:
            reach = True
            for s in STOPS:
                res.setdefault(s, ('win', args.tp))
            break
    timed = (bars[end]['c'] / entry - 1) * 100
    out = dict(reach=reach, risk=(1 - low_stop / entry) * 100, day=bars[i]['t'].date(), full=k + args.hold < len(dates))
    for s in STOPS:
        out[s] = res.get(s, ('time', timed))
    return out


STATS = {g: dict(dips=0, dip=[], lift=[]) for g in GRID}
tickers = [x.strip() for x in open(args.tickers) if x.strip()]
all_dates, n_tk = set(), 0
for n, tk in enumerate(tickers):
    path = os.path.join(args.cache, f'{tk}.json')
    bars = load(path) if os.path.exists(path) else []
    if len(bars) < 500:
        continue
    n_tk += 1
    times = [b['t'] for b in bars]
    last = {}
    for i, b in enumerate(bars):
        last[b['t'].date()] = i
    dates = sorted(last)
    all_dates.update(dates)
    for sig, chk in GRID:
        candles = pinesim.resample_session(bars, sig)
        dips = pinesim.rsi_rule_direct(candles, dict(sig_min=sig, check_min=chk))['dips']
        if not dips:
            continue
        close_of = {c['t']: c['c'] for c in candles}
        step = datetime.timedelta(minutes=sig)
        st = STATS[(sig, chk)]
        for j, (t0, _n, low_px, _age) in enumerate(dips):
            p = close_of[t0]
            i0 = bisect.bisect_left(times, t0 + step)
            if i0 < 1 or i0 >= len(bars):
                continue
            stop = low_px - tick(p)
            if not (0 < stop < p):
                continue
            st['dips'] += 1
            st['dip'].append(trade(bars, last, dates, i0 - 1, p, stop))
            # the LIFT: a buy stop above the DIP, until a newer DIP or the order's life ends
            k = bisect.bisect_left(dates, t0.date())
            i_end = last[dates[min(k + args.expire, len(dates) - 1)]]
            if j + 1 < len(dips):
                i_end = min(i_end, bisect.bisect_left(times, dips[j + 1][0] + step) - 1)
            level = p * (1 + args.lift / 100)
            for m in range(i0, i_end + 1):
                if bars[m]['h'] >= level:
                    st['lift'].append(trade(bars, last, dates, m, max(level, bars[m]['o']), stop))
                    break
    if (n + 1) % 50 == 0:
        print(f'  {n + 1}/{len(tickers)} tickers', file=sys.stderr, flush=True)

days = sorted(all_dates)
cut = days[int(len(days) * args.split)]
print(f"{n_tk} tickers, {days[0]} → {days[-1]} ({len(days)} sessions) | take-profit +{args.tp:g}%, stop under the dip's low, held {args.hold} sessions | "
      f"LIFT +{args.lift:g}% | in sample before {cut}")


def wins(rows, s):
    return sum(r[s][0] == 'win' for r in rows) / len(rows) * 100


def mean(rows, s):
    return statistics.mean(r[s][1] for r in rows)


def cell(rows):
    if len(rows) < 5:
        return f"{len(rows):>5}      —"
    return (f"{len(rows):>5}  reach {sum(r['reach'] for r in rows) / len(rows) * 100:3.0f}%  "
            f"-8%: win {wins(rows, '8'):3.0f}% avg {mean(rows, '8'):+5.2f}%  -15%: win {wins(rows, '15'):3.0f}% avg {mean(rows, '15'):+5.2f}%  "
            f"low: win {wins(rows, 'low'):3.0f}% avg {mean(rows, 'low'):+5.2f}% (risk {statistics.median(r['risk'] for r in rows):4.1f}%)")


for kind, title in (('dip', 'ENTRY AT THE DIP'), ('lift', f'ENTRY AT THE LIFT (+{args.lift:g}% above the DIP)')):
    print(f"\n== {title} ==")
    print(f"  {'RSI':>4} {'check':>5} {'DIPs/day':>8}   {'in sample':<118} out of sample")
    for sig, chk in GRID:
        st = STATS[(sig, chk)]
        a = [r for r in st[kind] if r['day'] < cut]
        b = [r for r in st[kind] if r['day'] >= cut]
        print(f"  {tf(sig):>4} {tf(chk):>5} {st['dips'] / len(days):8.1f}   {cell(a):<118} {cell(b)}")

# Ranked by the worse of the two halves, so one good half can't carry a setting.
for kind, title in (('dip', 'at the DIP'), ('lift', 'at the LIFT')):
    for s, name in (('8', 'the -8% stop'), ('15', 'the -15% stop')):
        rank = []
        for g in GRID:
            a = [r for r in STATS[g][kind] if r['day'] < cut]
            b = [r for r in STATS[g][kind] if r['day'] >= cut]
            if len(a) >= 40 and len(b) >= 40:
                rank.append((min(wins(a, s), wins(b, s)), g, wins(a, s), wins(b, s), mean(a, s), mean(b, s), len(a) + len(b)))
        rank.sort(reverse=True)
        print(f"\n== ranked by the worse half's win rate, entry {title}, {name} (40+ trades in each half) ==")
        for worst, (sig, chk), wa, wb, ma, mb, n in rank:
            print(f"  RSI {tf(sig):>3} checked at {tf(chk):>3}   win {wa:3.0f}% / {wb:3.0f}%   avg {ma:+5.2f}% / {mb:+5.2f}%   {n:>5} trades")
