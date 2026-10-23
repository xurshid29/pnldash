"""VB break — research (operator, 2026-10-22): after a VWAP + BB cross (📐 script v21–v24,
docs/vwap-setup.md §16), the latest VB candle's high becomes a resistance line; alert when price
crosses over it. Measured before building, on our own data.

Data     every Momentum row since 2026-06-12 (../vwap-pullback/export-rows.sql), turned into 1m bars
         (close = the minute's last 20s snapshot); the session line is the poller's stored session
         VWAP (within ~1% of TradingView's for names on our screen from the start of their move).
         The month and year lines can't be rebuilt here.
VB       the script's v23 rule on 1m bars (the alert uses 30s bars): candles of --candle minutes
         aligned to 04:00 ET, the upper band of the --bb-minute closes (the forming one live), and a
         CROSS at the first bar close in a candle whose open is at or under the higher of the session
         VWAP and the band and at most --tol % over the lower one, with the close above both. Gainers
         only: up ≥ 20% today so far, or ≥ 20% on one of the 5 calendar days before. Once per candle.
         The band needs 19 finished --bb buckets on our screen, so a name's first ~40 min on the
         screen can't cross (TradingView has the history).
Level    the VB candle's high, set when the candle closes; its low is the stop. A newer VB candle
         replaces it; it ends at the day's end (or, with --cancel, on a close under the session VWAP;
         with --cancel-candle, on a candle's close under it, the VB candle's own included: script v26).
Entries  CROSS     the VB bar's close (stop: the candle's low so far)
         BUY STOP  a buy stop one tick over the level: filled at max(level + tick, bar open) on the
                   first later bar whose high reaches it
         CLOSE     the first later bar close above the level (the 30s-close alert's 1m analogue)
Exits    +--target % (win), the stop (filled at the stop, or the bar's open if it opened under it;
         a bar touching both counts as the stop), --horizon minutes, or the ticker leaving our screen
         (> 3 min without a bar) / the day's end at the last close.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql, outside 07:00–11:00 ET):
  python vb_break_study.py rows.csv.gz [--candle 5 10] [--bb 2] [--tol 2] [--target 10] [--horizon 60] [--cancel | --cancel-candle]
"""
import argparse, duckdb, statistics, sys
from collections import Counter, defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--candle', type=int, nargs='+', default=[5, 10], help='VB candle timeframes, minutes')
ap.add_argument('--bb', type=int, default=2, help='band timeframe, minutes')
ap.add_argument('--tol', type=float, default=2.0, help='the candle may open up to %% over the lower line')
ap.add_argument('--target', type=float, default=10.0, help='win target, %%')
ap.add_argument('--horizon', type=int, default=60, help='minutes before a trade is closed at the market')
ap.add_argument('--cancel', action='store_true', help='also cancel a level on a close under the session VWAP')
ap.add_argument('--cancel-candle', action='store_true',
                help='cancel a level only when a candle of the timeframe closes under the session VWAP (not a 1m close)')
ap.add_argument('--rr', type=float, help='target as a multiple of the risk (entry − stop) instead of --target %%')
ap.add_argument('--hcandles', type=int, help='horizon in candles of the timeframe being run instead of --horizon minutes')
args = ap.parse_args()
LEN, MULT, MAX_GAP = 20, 2.0, 3

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
      f"| target +{args.target}% | horizon {args.horizon}m{' | cancel under VWAP' if args.cancel else ''}"
      f"{' | cancel on a candle close under VWAP' if args.cancel_candle else ''}")


def tick(p):
    return 0.0001 if p < 1 else 0.01


HORIZON = args.horizon   # minutes; set per timeframe with --hcandles


def trade(bars, k, entry, stop):
    """Bars after index k (the entry bar) → (outcome, P&L)."""
    tgt = entry + args.rr * (entry - stop) if args.rr else entry * (1 + args.target / 100)
    t0, last_t, last_c = bars[k][0], bars[k][0], bars[k][4]
    for j in range(k + 1, len(bars)):
        t, o, h, l, c = bars[j][:5]
        if t - last_t > MAX_GAP:
            return 'lost', last_c / entry - 1
        if t - t0 > HORIZON:
            return 'time', last_c / entry - 1
        if l <= stop:
            return 'stop', min(stop, o) / entry - 1
        if h >= tgt:
            return 'win', tgt / entry - 1
        last_t, last_c = t, c
    return 'eod', last_c / entry - 1


def run_day(key, bars, cmin, out):
    prior = PRIOR.get(key)
    closes, last_bb, last_c = [], None, None
    ckey = c_open = c_high = c_low = None
    fired, vb_low_so_far, vb_bar = False, None, None
    level = None            # dict: high, low, set_k, set_t, vb_t, broke flags
    day_max = -1e9
    prev_c = prev_vw = None  # the last bar's close and session VWAP (a closing candle's close)
    for k, (t, o, h, l, c, vw, chg, grade) in enumerate(bars):
        day_max = max(day_max, chg if chg is not None else -1e9)
        # the band: the last LEN-1 finished bb-bucket closes + the current close
        bkey = (t - 240) // args.bb
        if last_bb is not None and bkey != last_bb and last_c is not None:
            closes = (closes + [last_c])[-(LEN - 1):]
        last_bb, last_c = bkey, c
        band = None
        if len(closes) == LEN - 1:
            win = closes + [c]
            m = sum(win) / LEN
            band = m + MULT * (sum((x - m) ** 2 for x in win) / LEN) ** 0.5
        # the candle
        key_c = (t - 240) // cmin
        if key_c != ckey:
            if fired:   # the VB candle just closed: its high is the new level, replacing the old one
                if level and not level['done']:
                    level['done'] = 'replaced'
                level = dict(ticker=key[0], day=key[1], high=c_high, low=c_low, set_k=k, set_t=t, vb_t=vb_bar,
                             done=None, stop_k=None, close_k=None, cancelled=False)
                out['levels'].append(level)
            # --cancel-candle (script v26): the candle that just closed — the VB candle itself or a
            # later one — closed under the session VWAP
            if (args.cancel_candle and level and not level['done'] and level['stop_k'] is None
                    and prev_vw and prev_c < prev_vw):
                level['cancelled'] = True
                level['done'] = 'cancelled'
            ckey, c_open, c_high, c_low, fired = key_c, o, h, l, False
        else:
            c_high, c_low = max(c_high, h), min(c_low, l)
        # the active level: the buy stop and the close above it, on bars after the VB candle closed
        if level and not level['done'] and k >= level['set_k']:
            if args.cancel and vw and c < vw and level['stop_k'] is None:
                level['cancelled'] = True
                level['done'] = 'cancelled'
            else:
                trig = level['high'] + tick(level['high'])
                if level['stop_k'] is None and h >= trig:
                    level['stop_k'] = k
                    fill = max(trig, o)
                    oc, pnl = ('stop', min(level['low'], o) / fill - 1) if l <= level['low'] and o < trig else trade(bars, k, fill, level['low'])
                    level['stop_res'] = (oc, pnl, fill, (fill - level['low']) / fill)
                    level['mins'] = t - level['set_t']
                    level['next_candle'] = (t - 240) // cmin == (level['set_t'] - 240) // cmin
                if level['close_k'] is None and c > level['high']:
                    level['close_k'] = k
                    level['close_res'] = trade(bars, k, c, level['low']) + (c, (c - level['low']) / c)
                    level['done'] = 'broke'
        # VB (v23): open at/under the higher line and ≤ tol % over the lower; close above both
        gainer = day_max >= 20 or (prior is not None and prior >= 20)
        if (not fired and gainer and band is not None and vw and c_open <= max(vw, band)
                and c_open <= min(vw, band) * (1 + args.tol / 100) and c > vw and c > band):
            fired, vb_bar = True, t
            out['cross'].append(trade(bars, k, c, c_low) + (c, (c - c_low) / c, t, grade))
        prev_c, prev_vw = c, vw
    if level and not level['done']:
        level['done'] = 'eod'


def stats(res):
    if not res:
        return '—'
    n = len(res)
    win = sum(r[0] == 'win' for r in res) / n
    stop = sum(r[0] == 'stop' for r in res) / n
    pnl = [r[1] * 100 for r in res]
    risk = statistics.median(r[3] * 100 for r in res)
    rr = [r[1] / r[3] for r in res if r[3] > 0]
    return (f"{n:>6,}  win {win:5.1%}  stop {stop:5.1%}  avg {statistics.mean(pnl):+6.2f}%  median {statistics.median(pnl):+6.2f}%"
            f"  made money {sum(p > 0 for p in pnl) / n:5.1%}  median risk {risk:4.1f}%  avg {statistics.mean(rr):+5.2f}R")


for cmin in args.candle:
    HORIZON = args.hcandles * cmin if args.hcandles else args.horizon
    out = {'cross': [], 'levels': []}
    cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, chg, grade from bars order by ticker, day, tmin")
    key, day_bars = None, []
    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk:
            break
        for r in chunk:
            kk = (r[0], r[1])
            if kk != key:
                if day_bars:
                    run_day(key, day_bars, cmin, out)
                key, day_bars = kk, []
            if r[7] is not None and r[7] > 0 and r[4] is not None:
                day_bars.append((r[2],) + tuple(r[3:8]) + (r[8], r[9]))
    if day_bars:
        run_day(key, day_bars, cmin, out)
    lv = out['levels']
    ends = Counter(x['done'] for x in lv)
    stopped = [x for x in lv if x['stop_k'] is not None]
    closed = [x for x in lv if x['close_k'] is not None]
    days = len({(x['ticker'], x['day']) for x in lv}) or 1
    print(f"\n=== {cmin}m candles, {args.bb}m band ===")
    print(f"VB crosses {len(out['cross']):,}; levels (VB candles) {len(lv):,} on {days:,} ticker-days; "
          f"how they ended: {dict(ends)}")
    print(f"level reached by a buy stop: {len(stopped) / max(len(lv), 1):.1%} (median {statistics.median([x['mins'] for x in stopped]) if stopped else 0:.0f} min after "
          f"the VB candle closed; {sum(x['next_candle'] for x in stopped) / max(len(stopped), 1):.0%} in the next candle)")
    print(f"  CROSS (buy the VB bar, stop the candle's low so far)   {stats(out['cross'])}")
    print(f"  BUY STOP over the VB candle's high (stop its low)       {stats([x['stop_res'] for x in stopped])}")
    print(f"  CLOSE above the VB candle's high (stop its low)         {stats([x['close_res'] for x in closed])}")
    nxt = [x['stop_res'] for x in stopped if x['next_candle']]
    later = [x['stop_res'] for x in stopped if not x['next_candle']]
    print(f"    buy stop, broke in the next candle                     {stats(nxt)}")
    print(f"    buy stop, broke later                                  {stats(later)}")
    tod = defaultdict(list)
    for x in stopped:
        m = x['set_t']
        b = 'a 04-07' if m < 420 else 'b 07-09:30' if m < 570 else 'c 09:30-12' if m < 720 else 'd 12-16' if m < 960 else 'e AH'
        tod[b].append(x['stop_res'])
    for b in sorted(tod):
        print(f"    buy stop, {b:<44}{stats(tod[b])}")
    months = defaultdict(list)
    for x in stopped:
        months[x['day'].strftime('%Y-%m')].append(x['stop_res'])
    for mth in sorted(months):
        print(f"    buy stop, {mth:<44}{stats(months[mth])}")
