"""VB retest — research (operator, 2026-10-28/29, AIOK 19:05–19:10 and 22:45 Tashkent): "I'm not using
BREAKs for enter (because they can be very extended by the moment entering), but waiting 1st 5min candle
closes with VB and pulls back to vwap line and bounces, I'm entering right at that moment." Two panes: a
5m chart for the VB and a 30s chart for the entry. Measured before building, like the VB break.

Data     every Momentum row since 2026-06-12 (../vwap-pullback/export-rows.sql), turned into 1m bars
         (close = the minute's last 20s snapshot, low = its lowest), with the poller's stored session
         VWAP. Our 1m lows come from 20s snapshots, so a quick wick to the line can be missed.
VB       as vb_break_study.py: the script's v23 rule on 1m bars, candles of --candle minutes, the band of
         the --bb-minute closes (the operator's 45s band can't be built from 1m bars; --bb 1 is the
         nearest), --tol (the operator uses 0 since 10-29), gainers only.
Setup    each VB candle, from its close: replaced by a newer VB candle, cancelled when a candle of the
         timeframe closes under the session VWAP (script v26), or the day ends.
Entries  CROSS     the VB bar's close (stop: the candle's low so far)
         BUY STOP  one tick over the VB candle's high (stop: its low) — the v25 BREAK
         RETEST    after the VB candle closes: a bar whose low comes within --touch % of the VWAP (0 = to
                   the line or under it), then the first bar from there that closes above the VWAP and
                   above its own open (the bounce): bought at that close, within --wait candles of the VB
                   candle's close (0 = no limit). Stop: 'low' = the pullback's low (the lowest low since
                   the VB candle closed) minus a tick, or 'line' = 1% under the VWAP at the entry.
Exits    target --rr × the risk, the stop (a bar touching both counts as the stop), --hcandles candles,
         or the ticker leaving our screen (> 3 min without a bar) / the day's end.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql, outside 07:00–11:00 ET):
  python vb_retest_study.py rows.csv.gz [--candle 5 10] [--bb 1] [--tol 0] [--rr 2] [--hcandles 6]
  python vb_retest_study.py rows.csv.gz --candle 5 --list AIOK 2026-10-28
"""
import argparse, datetime, duckdb, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--candle', type=int, nargs='+', default=[5, 10], help='VB candle timeframes, minutes')
ap.add_argument('--bb', type=int, default=1, help='band timeframe, minutes')
ap.add_argument('--tol', type=float, default=0.0, help='the candle may open up to %% over the lower line')
ap.add_argument('--rr', type=float, default=2.0, help='target as a multiple of the risk')
ap.add_argument('--hcandles', type=int, default=6, help='horizon in candles of the timeframe being run')
ap.add_argument('--list', nargs=2, metavar=('TICKER', 'DAY'), help='print one ticker-day\'s VB candles and entries')
args = ap.parse_args()
LEN, MULT, MAX_GAP = 20, 2.0, 3
TOUCHES = [0.0, 0.5, 1.0, 2.0]
WAITS = [6, 0]
STOPS = ['low', 'line']

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         try_cast(change_pct as double) as chg, try_cast(grade as varchar) as grade,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw, max(chg) as chg, arg_max(grade, ts) as grade
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
con.execute("""
create table td as
with d as (select ticker, day, max(chg) as day_max from bars group by all)
select *, max(day_max) over (partition by ticker order by day
                             range between interval 5 days preceding and interval 1 day preceding) as prior_max
from d""")
PRIOR = {(r[0], r[1]): r[2] for r in con.execute("select ticker, day, prior_max from td").fetchall()}
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | band {args.bb}m ({LEN}, {MULT}) | tol {args.tol}% "
      f"| target {args.rr}R | horizon {args.hcandles} candles | cancel on a candle close under VWAP")


def tick(p):
    return 0.0001 if p < 1 else 0.01


def trade(bars, k, entry, stop, horizon):
    """Bars after index k (the entry bar) → (outcome, P&L, risk)."""
    risk = (entry - stop) / entry
    tgt = entry + args.rr * (entry - stop)
    t0, last_t, last_c = bars[k][0], bars[k][0], bars[k][4]
    for j in range(k + 1, len(bars)):
        t, o, h, l, c = bars[j][:5]
        if t - last_t > MAX_GAP:
            return 'lost', last_c / entry - 1, risk
        if t - t0 > horizon:
            return 'time', last_c / entry - 1, risk
        if l <= stop:
            return 'stop', min(stop, o) / entry - 1, risk
        if h >= tgt:
            return 'win', tgt / entry - 1, risk
        last_t, last_c = t, c
    return 'eod', last_c / entry - 1, risk


def et_hm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def tash_hm(m):   # ET minute → Tashkent clock (EDT +9h; EST +10h from Nov 2)
    return et_hm((m + 9 * 60) % (24 * 60))


def run_day(key, bars, cmin, out, listing=False):
    prior = PRIOR.get(key)
    horizon = args.hcandles * cmin
    closes, last_bb, last_c = [], None, None
    ckey = c_open = c_high = c_low = None
    fired, vb_t = False, None
    day_max = -1e9
    prev_c = prev_vw = None
    setup = None   # the live VB candle: high, low, set_k, set_t, retest states per variant
    for k, (t, o, h, l, c, vw, chg, grade) in enumerate(bars):
        day_max = max(day_max, chg if chg is not None else -1e9)
        bkey = (t - 240) // args.bb
        if last_bb is not None and bkey != last_bb and last_c is not None:
            closes = (closes + [last_c])[-(LEN - 1):]
        last_bb, last_c = bkey, c
        band = None
        if len(closes) == LEN - 1:
            win = closes + [c]
            m = sum(win) / LEN
            band = m + MULT * (sum((x - m) ** 2 for x in win) / LEN) ** 0.5
        key_c = (t - 240) // cmin
        if key_c != ckey:
            if fired:   # the VB candle just closed: a new setup, replacing the last one
                setup = dict(high=c_high, low=c_low, set_k=k, set_t=t, vb_t=vb_t, live=True, stop_done=False,
                             pull_low=None, rt={}, cancelled_at=None)
                out['setups'].append(setup)
                if listing:
                    print(f"  VB candle {et_hm(vb_t - (vb_t - 240) % cmin)} ET ({tash_hm(vb_t - (vb_t - 240) % cmin)} Tashkent) closed: "
                          f"high {c_high} · low {c_low} · close {prev_c} · VWAP {prev_vw}")
            # a candle (the VB candle itself or a later one) closed under the VWAP: the setup ends (v26)
            if setup and setup['live'] and prev_vw and prev_c < prev_vw:
                setup['live'] = False
                setup['cancelled_at'] = t
                if listing:
                    print(f"    cancelled: the candle closed {prev_c} under the VWAP {prev_vw}")
            ckey, c_open, c_high, c_low, fired = key_c, o, h, l, False
        else:
            c_high, c_low = max(c_high, h), min(c_low, l)
        if setup and setup['live'] and k >= setup['set_k'] and vw:
            setup['pull_low'] = l if setup['pull_low'] is None else min(setup['pull_low'], l)
            # BUY STOP over the VB candle's high (the v25 BREAK)
            trig = setup['high'] + tick(setup['high'])
            if not setup['stop_done'] and h >= trig:
                setup['stop_done'] = True
                fill = max(trig, o)
                res = (('stop', min(setup['low'], o) / fill - 1, (fill - setup['low']) / fill)
                       if l <= setup['low'] and o < trig else trade(bars, k, fill, setup['low'], horizon))
                out['buystop'].append(res + (None, t, grade))
                if listing:
                    print(f"    BREAK {et_hm(t)} ET ({tash_hm(t)}) fill {fill:.4g} → {res[0]} {res[1] * 100:+.1f}%")
            # RETEST variants: touch within x % of the line, then a green close above it
            waited = (t - setup['set_t']) // cmin
            for tch in TOUCHES:
                for wait in WAITS:
                    st = setup['rt'].setdefault((tch, wait), dict(touched=False, done=False))
                    if st['done'] or (wait and waited >= wait):
                        continue
                    if not st['touched'] and l <= vw * (1 + tch / 100):
                        st['touched'] = True
                    if st['touched'] and c > vw and c > o:
                        st['done'] = True
                        for sv in STOPS:
                            stop = setup['pull_low'] - tick(setup['pull_low']) if sv == 'low' else vw * 0.99
                            if stop >= c:
                                continue
                            res = trade(bars, k, c, stop, horizon)
                            out['retest'][(tch, wait, sv)].append(res + ((t - setup['set_t']), t, grade))
                            if listing and wait == 6 and sv == 'low' and tch in (0.0, 1.0):
                                print(f"    RETEST (touch {tch}%) {et_hm(t)} ET ({tash_hm(t)}) buy {c:.4g} · VWAP {vw:.4g} · "
                                      f"stop {stop:.4g} ({(stop / c - 1) * 100:+.1f}%) → {res[0]} {res[1] * 100:+.1f}%")
        # VB (v23): open at/under the higher line and ≤ tol % over the lower; close above both
        gainer = day_max >= 20 or (prior is not None and prior >= 20)
        if (not fired and gainer and band is not None and vw and c_open <= max(vw, band)
                and c_open <= min(vw, band) * (1 + args.tol / 100) and c > vw and c > band):
            fired, vb_t = True, t
            out['cross'].append(trade(bars, k, c, c_low, horizon) + (None, t, grade))
            if listing:
                print(f"  CROSS {et_hm(t)} ET ({tash_hm(t)} Tashkent) {c} · VWAP {vw} · band {band:.4g} · candle open {c_open}")
        prev_c, prev_vw = c, vw


def stats(res):
    if not res:
        return '     —'
    n = len(res)
    win = sum(r[0] == 'win' for r in res) / n
    stop = sum(r[0] == 'stop' for r in res) / n
    pnl = [r[1] * 100 for r in res]
    risk = statistics.median(r[2] * 100 for r in res)
    rr = [r[1] / r[2] for r in res if r[2] > 0]
    return (f"{n:>6,}  {args.rr:g}R first {win:5.1%}  stop {stop:5.1%}  avg {statistics.mean(pnl):+6.2f}%  "
            f"made money {sum(p > 0 for p in pnl) / n:5.1%}  median risk {risk:4.1f}%  avg {statistics.mean(rr):+5.2f}R")


def rows_of(cmin, ticker=None, day=None):
    q = "select ticker, day, tmin, o, h, l, c, vw, chg, grade from bars"
    if ticker:
        q += f" where ticker = '{ticker}' and day = date '{day}'"
    return con.execute(q + " order by ticker, day, tmin")


def each_day(cur, fn):
    key, day_bars = None, []
    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk:
            break
        for r in chunk:
            kk = (r[0], r[1])
            if kk != key:
                if day_bars:
                    fn(key, day_bars)
                key, day_bars = kk, []
            if r[7] is not None and r[7] > 0 and r[4] is not None:
                day_bars.append((r[2],) + tuple(r[3:8]) + (r[8], r[9]))
    if day_bars:
        fn(key, day_bars)


if args.list:
    tk, day = args.list
    for cmin in args.candle:
        print(f"\n=== {tk} {day}, {cmin}m candles, {args.bb}m band ===")
        out = {'cross': [], 'setups': [], 'buystop': [], 'retest': defaultdict(list)}
        each_day(rows_of(cmin, tk, day), lambda key, b: run_day(key, b, cmin, out, listing=True))
    sys.exit(0)

for cmin in args.candle:
    out = {'cross': [], 'setups': [], 'buystop': [], 'retest': defaultdict(list)}
    each_day(rows_of(cmin), lambda key, b: run_day(key, b, cmin, out))
    ns = len(out['setups'])
    print(f"\n=== {cmin}m candles, {args.bb}m band: {len(out['cross']):,} VB crosses, {ns:,} VB candles ===")
    print(f"  CROSS (buy the VB bar, stop the candle's low so far)        {stats(out['cross'])}")
    print(f"  BUY STOP over the VB candle's high (stop its low)            {stats(out['buystop'])}")
    for wait in WAITS:
        for tch in TOUCHES:
            for sv in STOPS:
                res = out['retest'][(tch, wait, sv)]
                label = f"RETEST touch {'to the line' if tch == 0 else f'{tch:g}% over'}, {'≤' + str(wait) + ' candles' if wait else 'no limit'}, stop {sv}"
                print(f"  {label:<61}{stats(res)}")
        reached = out['retest'][(1.0, wait, 'low')]
        if reached:
            mins = statistics.median(r[3] for r in reached)
            print(f"    (touch 1%: {len(reached) / max(ns, 1):.0%} of VB candles get a retest entry, a median {mins:.0f} min after the candle closed)")
    # splits for the main variant (touch 1%, ≤6 candles, stop the pullback low) against the CROSS and the buy stop
    def tod(m):
        return 'a 04:00-07:00' if m < 420 else 'b 07:00-09:30' if m < 570 else 'c 09:30-12:00' if m < 720 else 'd 12:00-16:00' if m < 960 else 'e 16:00-20:00'
    def gr(g):
        return 'on Momentum, A+/A/A-' if g in ('A+', 'A', 'A-') else 'on Momentum, B+/B/B-' if g in ('B+', 'B', 'B-') else 'C / D / no grade'
    # r = (outcome, P&L, risk, minutes after the VB candle closed, entry minute ET, grade); grades are stored since 10-01
    for name, fn, idx in (('time of day (ET)', tod, 4), ('grade at the entry (since 10-01, when grades were first stored)', gr, 5)):
        print(f"  by {name}:")
        groups = defaultdict(lambda: defaultdict(list))
        for label, res in (('CROSS', out['cross']), ('BUY STOP', out['buystop']), ('RETEST', out['retest'][(1.0, 6, 'low')])):
            for r in res:
                if idx == 5 and r[5] is None:
                    continue
                groups[fn(r[idx])][label].append(r)
        for gname in sorted(groups):
            for label in ('CROSS', 'BUY STOP', 'RETEST'):
                print(f"    {gname:<22}{label:<10}{stats(groups[gname][label])}")
