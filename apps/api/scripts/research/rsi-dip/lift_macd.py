"""RSI DIP — the LIFT at 10% with the MACD line above zero.
(operator, 2026-11-15: "what if I set LIFT % to 10%, and add MACD and enter only when LIFT fires and
MACD line above the zero?")

Data     the Yahoo 5m bars dip_lift_study.py cached; the DIPs of the operator's settings (--rsi 10
         checked at --check 60) by pinesim.rsi_rule_direct.
LIFT     a buy stop L% above the DIP's close (8, 10 and 12 are compared), as v38: until a newer
         DIP or --expire sessions.
MACD     12 / 26 / 9 on the closes of a timeframe's candles (5m, 10m, 30m, 1h), as the chart shows
         it at the moment of the LIFT: the finished candles plus the fill price as the open one's
         close. `line` = EMA 12 − EMA 26; `hist` = the line − its EMA 9 (the signal).
Outcome  take-profit --tp % above the fill, held --hold sessions after the fill's:
         reach   it got there, no stop
         w8 / w15   it got there before a stop 8% / 15% under the fill (35% / 50% needed with +15%)
         a8 / a15   the average result with that stop, %
Split    by date: the first --split of the sessions in sample, the rest out of sample.

Run:  python3 -I lift_macd.py tickers.txt --cache DIR [--tp 15] [--hold 3]
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
ap.add_argument('--expire', type=int, default=3)
ap.add_argument('--hold', type=int, default=3)
ap.add_argument('--split', type=float, default=0.6)
args = ap.parse_args()
ET = zoneinfo.ZoneInfo('America/New_York')
LIFTS = [8, 10, 12]
MACD_TF = [5, 10, 30, 60]
A12, A26, A9 = 2 / 13, 2 / 27, 2 / 10


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


class Macd:
    """MACD 12 / 26 / 9 of a timeframe's candles; `live(t, px)` = (line, hist) with px as the open candle's close."""
    def __init__(self, bars, minutes):
        self.minutes = minutes
        c = pinesim.resample_session(bars, minutes)
        self.starts = [x['t'] for x in c]
        closes = [x['c'] for x in c]
        self.e12, self.e26 = pinesim.ema_series(closes, 12), pinesim.ema_series(closes, 26)
        line = [None if a is None or b is None else a - b for a, b in zip(self.e12, self.e26)]
        first = next((i for i, v in enumerate(line) if v is not None), len(line))
        sig = pinesim.ema_series(line[first:], 9)
        self.sig = [None] * first + sig

    def live(self, t, px):
        j = bisect.bisect_left(self.starts, pinesim._candle_start(t, self.minutes)) - 1   # the last finished candle
        if j < 0 or self.e26[j] is None or self.sig[j] is None:
            return None
        line = (A12 * px + (1 - A12) * self.e12[j]) - (A26 * px + (1 - A26) * self.e26[j])
        return line, line - (A9 * line + (1 - A9) * self.sig[j])


def trade(bars, last, dates, i, entry):
    k = bisect.bisect_left(dates, bars[i]['t'].date())
    end = last[dates[min(k + args.hold, len(dates) - 1)]]
    tp = entry * (1 + args.tp / 100)
    res, reach = {}, False
    for m in range(i + 1, end + 1):
        b = bars[m]
        for s in (8, 15):
            if s not in res and b['l'] <= entry * (1 - s / 100):
                res[s] = (False, (min(entry * (1 - s / 100), b['o']) / entry - 1) * 100)
        if b['h'] >= tp:
            reach = True
            for s in (8, 15):
                res.setdefault(s, (True, args.tp))
            break
    timed = (bars[end]['c'] / entry - 1) * 100
    return dict(reach=reach, w8=res.get(8, (False, timed))[0], a8=res.get(8, (False, timed))[1],
                w15=res.get(15, (False, timed))[0], a15=res.get(15, (False, timed))[1])


ROWS = {L: [] for L in LIFTS}
DIPS = 0
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
    macd = {m: Macd(bars, m) for m in MACD_TF}
    candles = pinesim.resample_session(bars, args.rsi)
    close_of = {c['t']: c['c'] for c in candles}
    step = datetime.timedelta(minutes=args.rsi)
    dips = pinesim.rsi_rule_direct(candles, dict(sig_min=args.rsi, check_min=args.check))['dips']
    for j, (t0, _n, _low, _age) in enumerate(dips):
        p = close_of[t0]
        i0 = bisect.bisect_left(times, t0 + step)
        if i0 < 1 or i0 >= len(bars):
            continue
        DIPS += 1
        k = bisect.bisect_left(dates, t0.date())
        i_end = last[dates[min(k + args.expire, len(dates) - 1)]]
        if j + 1 < len(dips):
            i_end = min(i_end, bisect.bisect_left(times, dips[j + 1][0] + step) - 1)
        for L in LIFTS:
            level = p * (1 + L / 100)
            for m in range(i0, i_end + 1):
                if bars[m]['h'] >= level:
                    fill = max(level, bars[m]['o'])
                    row = dict(trade(bars, last, dates, m, fill), date=bars[m]['t'].date(),
                               wait=(bars[m]['t'] - bars[i0 - 1]['t']).total_seconds() / 3600)
                    for mt in MACD_TF:
                        v = macd[mt].live(bars[m]['t'], fill)
                        row[f'line{mt}'], row[f'hist{mt}'] = v if v else (None, None)
                    ROWS[L].append(row)
                    break
    if (n_t + 1) % 50 == 0:
        print(f'  {n_t + 1}/{len(tickers)} tickers', file=sys.stderr, flush=True)

days = sorted(all_days)
cut = days[int(len(days) * args.split)]
print(f"{days[0]} → {days[-1]} | RSI {args.rsi}m checked at {args.check}m | {DIPS:,} DIPs | take-profit +{args.tp:g}%, held {args.hold} sessions | in sample before {cut}")


def show(rows, of=None):
    if len(rows) < 5:
        return f"{len(rows):>5}      —"
    n = len(rows)
    share = f" ({n / of * 100:3.0f}%)" if of else '       '
    return (f"{n:>5}{share}  reach {sum(r['reach'] for r in rows) / n * 100:3.0f}%  w8 {sum(r['w8'] for r in rows) / n * 100:3.0f}% "
            f"(a {statistics.mean(r['a8'] for r in rows):+5.2f}%)  w15 {sum(r['w15'] for r in rows) / n * 100:3.0f}% (a {statistics.mean(r['a15'] for r in rows):+5.2f}%)")


def table(label, rows_in, rows_out, of_in=None, of_out=None):
    print(f"  {label:<34} in  {show(rows_in, of_in)}\n  {'':<34} out {show(rows_out, of_out)}")


for L in LIFTS:
    IS = [r for r in ROWS[L] if r['date'] < cut]
    OOS = [r for r in ROWS[L] if r['date'] >= cut]
    print(f"\n== LIFT +{L}% ==")
    table('all LIFTs', IS, OOS)
    for mt in MACD_TF:
        name = f"{mt // 60}h" if mt % 60 == 0 else f"{mt}m"
        ok = lambda r, mt=mt: r[f'line{mt}'] is not None
        a, b = [r for r in IS if ok(r)], [r for r in OOS if ok(r)]
        up = lambda r, mt=mt: r[f'line{mt}'] > 0
        table(f'{name} MACD line above zero', [r for r in a if up(r)], [r for r in b if up(r)], len(a), len(b))
        table(f'{name} MACD line at or under zero', [r for r in a if not up(r)], [r for r in b if not up(r)], len(a), len(b))
        both = lambda r, mt=mt: r[f'line{mt}'] > 0 and r[f'hist{mt}'] > 0
        table(f'{name} line above zero and over signal', [r for r in a if both(r)], [r for r in b if both(r)], len(a), len(b))
