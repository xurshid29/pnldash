"""Score the 📐 VWAP-setup script on the examples it was built from.

  python3 replay.py              # scorecard: every version on 1m and 2m
  python3 replay.py MEDS 1       # every signal for one example (1m), per version
  python3 replay.py go           # GO quality: upside left (30m), drawdown (10m), back under the line

A FORMING/READY inside the example's real entry window = caught; every other
FORMING/READY in the report window = noise. Bars come from Yahoo (1m reaches
back ~30 days, so these examples stop being replayable around 2026-10-18 —
add newer ones); they are cached in $VWAP_SETUP_DATA (default /tmp/vwap-setup).
mVWAP levels were read off the operator's TradingView screenshots.
"""
import datetime
import json
import os
import sys
import time
import urllib.request

from pinesim import ET, V1, V2, V3, V4, V5, V6, V7, load, resample, simulate

DATA = os.environ.get('VWAP_SETUP_DATA', '/tmp/vwap-setup')
U5 = datetime.timezone(datetime.timedelta(hours=5))   # the operator's clock


def D(mo, d, h, m):
    return datetime.datetime(2026, mo, d, h, m, tzinfo=ET)


def session_vwap(path, day, seed=None):
    """mVWAP built from the bars themselves, anchored at `day` 04:00 ET — exact enough when
    `day` is the month's first session and its pre-market volume (zero on Yahoo) was tiny.
    seed=(price, shares) stands in for that pre-market volume (the level read off TradingView).
    Loads lazily: the bars may not be fetched yet when the examples are defined."""
    cache = {}

    def f(b):
        if not cache:
            pv, v = (seed[0] * seed[1], float(seed[1])) if seed else (0.0, 0.0)
            for x in load(path):
                if x['t'].date() < day:
                    continue
                pv += (x['h'] + x['l'] + x['c']) / 3 * x['v']
                v += x['v']
                cache[x['t']] = pv / v if v else (x['h'] + x['l'] + x['c']) / 3
        return cache.get(b['t'])
    return f


def flat(*segs):
    """mVWAP read off the chart: [(start, end, level), ...]; None (no signals) elsewhere."""
    def f(b):
        for s, e, v in segs:
            if s <= b['t'] <= e:
                return v
        return None
    return f


# ticker, Yahoo fetch range (UTC dates; includes prior sessions for the runner gate),
# mVWAP, report window, the entry window the operator traded, note
EXAMPLES = [
    ('MEDS', ('2026-09-15', '2026-09-19'), flat((D(9, 17, 9, 30), D(9, 18, 9, 0), 4.94)),
     (D(9, 17, 9, 30), D(9, 18, 9, 0)), (D(9, 18, 6, 45), D(9, 18, 7, 8)),
     '3rd-day runner: VWAP cross 07:08, 6.83 by 07:40; 09-17 afternoon = chop'),
    ('AIXI', ('2026-09-25', '2026-10-03'), flat((D(10, 2, 7, 0), D(10, 2, 8, 30), 1.565)),
     (D(10, 2, 7, 0), D(10, 2, 8, 30)), (D(10, 2, 7, 30), D(10, 2, 8, 9)),
     'base, rejected push 07:52, higher low 07:56-08:05, breakout 08:09 to 1.89'),
    ('NXL', ('2026-09-28', '2026-10-02'), flat((D(10, 1, 8, 40), D(10, 1, 9, 25), 6.60)),
     (D(10, 1, 8, 40), D(10, 1, 9, 25)), (D(10, 1, 8, 50), D(10, 1, 9, 12)),
     'pullback to the line 08:57-09:11, then 9+ (a 2m-chart setup)'),
    ('VEEA', ('2026-09-28', '2026-10-02'),
     flat((D(10, 1, 8, 45), D(10, 1, 9, 45), 3.06), (D(10, 1, 13, 30), D(10, 1, 15, 30), 3.22)),
     (D(10, 1, 8, 45), D(10, 1, 15, 30)), (D(10, 1, 8, 50), D(10, 1, 9, 31)),
     'base 09:00-09:29 -> 3.7+ at the open'),
    ('NIVF', ('2026-09-25', '2026-10-01'), flat((D(9, 30, 8, 0), D(9, 30, 9, 45), 0.188)),
     (D(9, 30, 8, 0), D(9, 30, 9, 45)), (D(9, 30, 8, 45), D(9, 30, 9, 31)),
     'fast approach into the open -> 0.25 by 09:40'),
    ('SOAR', ('2026-09-24', '2026-09-30'), flat((D(9, 29, 4, 0), D(9, 29, 15, 30), 0.336)),
     (D(9, 29, 4, 0), D(9, 29, 15, 30)), (D(9, 29, 10, 0), D(9, 29, 13, 30)),
     '2nd-day runner: chop, then the base that ran to 0.42 by 15:30'),
    # Added 2026-10-03 from the operator's question "why nothing around 02:30?" (UTC+5):
    # fell 24% on the day (+19.8% day high on TV), then +70% after hours from 1.19.
    ('AMOD', ('2026-09-25', '2026-10-03'), flat((D(10, 1, 16, 0), D(10, 1, 18, 40), 1.415)),
     (D(10, 1, 16, 0), D(10, 1, 18, 40)), (D(10, 1, 16, 50), D(10, 1, 17, 40)),
     'after-hours base under the line 17:00-17:35, GO 17:43, then 2.10'),
    # The operator's "ideal" setups (2026-10-03): price ABOVE a rising basis, both under the line.
    ('SDEV', ('2026-09-25', '2026-10-03'), flat((D(10, 1, 7, 0), D(10, 1, 8, 45), 3.40)),
     (D(10, 1, 7, 0), D(10, 1, 8, 45)), (D(10, 1, 8, 20), D(10, 1, 8, 45)),
     'ideal #1: base on the line, cross ~08:40, then 4.5 by 10:05'),
    ('SDEV-AH', ('2026-09-25', '2026-10-03'), flat((D(10, 1, 14, 0), D(10, 1, 17, 30), 3.78)),
     (D(10, 1, 14, 0), D(10, 1, 17, 30)), (D(10, 1, 16, 15), D(10, 1, 16, 55)),
     'ideal #2 (after hours): base under the line, cross ~16:50, 4.2 by 18:30'),
    # Should NOT fire (operator): READYs right after a spike, the 2nd with price under the basis.
    # Only 2m bars exist this far back (Yahoo 1m ≈ 30 days); level ≈ the legend's 2.94.
    ('AMOD-0901', ('2026-08-27', '2026-09-03'), flat((D(9, 1, 15, 58), D(9, 1, 16, 30), 2.94)),
     (D(9, 1, 15, 58), D(9, 1, 16, 30)), None,
     'NEGATIVE: spike to 3.2 then back under the line and the basis'),
    # 3rd-session runner (operator, 2026-10-03: "why nothing between 13:00-13:20?"): Sep 29 was
    # +22%, then +5% and +1%; Oct 2 pre-market reclaimed the line 1.25 at 04:21 and ran to 2.26.
    ('AIXI-1002PM', ('2026-09-25', '2026-10-03'), flat((D(10, 2, 4, 0), D(10, 2, 4, 45), 1.25)),
     (D(10, 2, 4, 0), D(10, 2, 4, 45)), (D(10, 2, 4, 0), D(10, 2, 4, 21)),
     'pre-market base under the line, READY ~04:06, GO ~04:21 (needs runnerDays 3)'),
    # Should NOT give GO (operator, 2026-10-03): the 09:38 ET crash bar pulled the 1st-of-month
    # VWAP under a flat basis — a "cross" with price below both lines.
    ('AIXI-1001', ('2026-09-25', '2026-10-03'), None, (D(10, 1, 9, 0), D(10, 1, 10, 30)), None,
     'NEGATIVE: open crash 1.34 -> 1.23 on Oct 1 (session VWAP from the bars)'),
]
# AIXI's Oct 1 pre-market: a few hundred shares around 1.33 on TV (Yahoo shows zero volume)
EXAMPLES = [(t, r, mv if mv is not None else session_vwap(os.path.join(DATA, 'aixi_1m.json'), datetime.date(2026, 10, 1),
                                                          seed=(1.333, 2000)),
             w, tg, n) for t, r, mv, w, tg, n in EXAMPLES]


# Where Yahoo's bars sit on the other side of a gate than TradingView's do.
# AMOD 10-01: Yahoo's high 1.88 = +20.1% vs the prior close; the operator's TV
# chart peaked ~1.875 = +19.8%, under the 20% line. Nudge the gate to match TV.
TV_ADJUST = {'AMOD': {'minDayGain': 20.2}}


def params_for(ticker, params):
    return {**params, **TV_ADJUST.get(ticker, {})}


FILES = {'SDEV-AH': 'sdev_1m.json', 'AMOD-0901': 'amod_sep_2m.json', 'AIXI-1001': 'aixi_1m.json',
         'AIXI-1002PM': 'aixi_1m.json'}   # second windows on the same bars; 2m-only data
BAR_MINUTES = {'AMOD-0901': 2}


def bars_for(ticker, rng, minutes):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, FILES.get(ticker, f'{ticker.lower()}_1m.json'))
    base = BAR_MINUTES.get(ticker, 1)
    if minutes < base:
        return None
    if not os.path.exists(path):
        p1 = int(datetime.datetime.fromisoformat(rng[0] + 'T04:00:00+00:00').timestamp())
        p2 = int(datetime.datetime.fromisoformat(rng[1] + 'T04:00:00+00:00').timestamp())
        url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker.split("-")[0]}'
               f'?interval={base}m&period1={p1}&period2={p2}&includePrePost=true')
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        data = urllib.request.urlopen(req, timeout=20).read()   # read first: a failed fetch must not leave an empty file
        open(path, 'wb').write(data)
        time.sleep(1)
    bars = load(path)
    return bars if minutes == base else resample(bars, minutes)


def show(events):
    for t, st, path, c, basis, px, bb, g in events:
        print(f"    {t:%m-%d %H:%M} ET ({t.astimezone(U5):%H:%M} UTC+5)  {st:7s} {path:4s}  "
              f"c={c:<8.4g} px<={px:5.1f}%  bb<={bb:5.1f}%")


def scorecard(variants, minutes):
    targets = [x for x in EXAMPLES if x[4] is not None]
    print(f"\n=== {minutes}m — first FORMING/READY in the traded entry window (+ other FORMING/READY); "
          f"negatives count only noise; n/a = no bars at this timeframe")
    print(f"{'variant':12s}" + ''.join(f"{x[0]:>13s}" for x in EXAMPLES) + "   caught   noise")
    for name, params in variants:
        cells, caught, noise, scored = [], 0, 0, 0
        for tk, rng, mv, (s, e), target, _ in EXAMPLES:
            bars = bars_for(tk, rng, minutes)
            if bars is None:
                cells.append('n/a'); continue
            ev = [x for x in simulate(bars, mv, params_for(tk, params), start=s, end=e) if x[1] != 'GO']
            if target is None:
                noise += len(ev); cells.append(f"neg +{len(ev)}"); continue
            a, z = target
            hit = [x for x in ev if a <= x[0] <= z]
            other = len(ev) - len(hit)
            caught += bool(hit); noise += other; scored += 1
            cells.append((f"{hit[0][0]:%H:%M} {hit[0][1][:4]}" if hit else '—') + f" +{other}")
        print(f"{name:12s}" + ''.join(f"{c:>13s}" for c in cells) + f"   {caught}/{scored}    {noise}")


def go_report(variants, minutes):
    """Every GO: how much upside was left (max high, next ~30 min), the drawdown
    (min low, next ~10 min), and whether price closed 2% back under the line within ~10 min."""
    print(f"\n=== GO quality, {minutes}m")
    for name, params in variants:
        rows = []
        for tk, rng, mv, (s, e), _, _ in EXAMPLES:
            bars = bars_for(tk, rng, minutes)
            if bars is None:
                continue
            idx = {b['t']: i for i, b in enumerate(bars)}
            for ev in simulate(bars, mv, params_for(tk, params), start=s, end=e):
                if ev[1] != 'GO':
                    continue
                i, px = idx[ev[0]], ev[3]
                nxt, nxt10 = bars[i + 1:i + 1 + 30 // minutes], bars[i + 1:i + 1 + max(1, 10 // minutes)]
                up = (max(b['h'] for b in nxt) / px - 1) * 100 if nxt else 0.0
                dd = (min(b['l'] for b in nxt10) / px - 1) * 100 if nxt10 else 0.0
                lvl = mv(bars[i])
                back = any(lvl and b['c'] < lvl * 0.98 for b in nxt10)
                rows.append((tk, ev[0], up, dd, back))
        if not rows:
            print(f"{name:6s} no GOs"); continue
        med = lambda xs: sorted(xs)[len(xs) // 2]
        print(f"{name:6s} {len(rows):2d} GOs | median upside left +{med([r[2] for r in rows]):.1f}% | "
              f"median drawdown {med([r[3] for r in rows]):+.1f}% | back under {sum(r[4] for r in rows)} | "
              + ' '.join(f"{r[0][:4]}@{r[1].astimezone(U5):%H:%M}{'*' if r[4] else ''}" for r in rows))


if __name__ == '__main__':
    variants = [('v1', V1), ('v2', V2), ('v3', V3), ('v4', V4), ('v5', V5), ('v6', V6), ('v7', V7)]
    if len(sys.argv) >= 2 and sys.argv[1] == 'go':
        for minutes in (1, 2):
            go_report(variants[2:], minutes)
    elif len(sys.argv) >= 2:
        tk = sys.argv[1].upper()
        minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 1
        for t, rng, mv, (s, e), _, note in EXAMPLES:
            if t == tk:
                print(f"{t} {minutes}m — {note}")
                bars = bars_for(t, rng, minutes)
                if bars is None:
                    print('  no bars at this timeframe'); continue
                for name, params in variants:
                    print(f"  {name}:")
                    show(simulate(bars, mv, params_for(t, params), start=s, end=e))
    else:
        for minutes in (1, 2):
            scorecard(variants, minutes)
