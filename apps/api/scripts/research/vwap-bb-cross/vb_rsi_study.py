"""VB + RSI confirmation — research (operator, 2026-11-06, DBGI): two panes, 1m and 10m, each with
TradingView's default RSI (14, with its SMA-14 "RSI-based MA"). After a VB alert they wait on the 1m
chart for the pullback and the bounce off the VWAP, "and I enter when both RSIs start to go up after
the pullback" — clarified: when the purple RSI line crosses above the yellow MA, on the 1m and the 10m.
Measured against the RETEST entries before building anything.

Data     our Momentum rows (../vwap-pullback/export-rows.sql) → 1m bars, the poller's session VWAP; the
         VB, its candle lifecycle and the RETEST entries exactly as vb_retest_study.py.
RSI      TradingView's ta.rsi (Wilder: rma seeded with the SMA of the first 14 changes) and ta.sma(rsi, 14).
         1m: on our 1m bars, one series per ticker across days (TradingView's 1m RSI also runs across the
         night; ours also skips the minutes a name was off our screen).
         10m: Yahoo 5m bars with extended hours (`--yahoo DIR`, one JSON per ticker, range=60d) → 10m bars;
         at each of our 1m closes the 10m value is the live one, as the chart shows it: the completed 10m
         bars plus our current price as the open bar's close.
Setups   VB candles whose close has a warm 1m RSI (≥ 28 bars: 14 changes + 14 RSI values for the MA) and a
         warm 10m RSI (≥ 40 completed 10m bars).
Entries  (all after the VB candle closes, after a bar whose low came within 1% of the session VWAP — the
         pullback — at a 1m close above the VWAP, stop under the pullback's low, while the setup lives)
         RETEST (v30)      the first candle of the VB timeframe that touched and closed above the line
         RETEST (v28)      the first green 1m close above the line
         1m cross          the 1m RSI crosses above its MA
         1m cross, 10m up  the 1m RSI crosses above its MA while the 10m RSI is above its MA
         both up           the first 1m close where both RSIs are above their MAs, after a bar since the
                           pullback when they weren't (either one can cross last) — the operator's rule
         both up, 10m new  the same, but the 10m RSI was under its MA at some bar since the pullback
         both up, closed 10m   "both up" with the 10m RSI of the last finished 10m candle: the stepped line
                           of a 10m RSI on the 1m chart with "Wait for timeframe closes" ticked (the
                           operator's layout from 11-06, VIVK); a candle's value shows from its last minute
         Each within 6 candles of the VB candle's close, and again with no limit (until the setup ends);
         the v30 RETEST has its own 6-candle limit in both.
Exits    as vb_retest_study.py: --rr × the risk, the stop, --hcandles candles (or --hmin minutes), the ticker
         leaving our screen, the day's end.

Run (rows.csv.gz from ../vwap-pullback/export-rows.sql, outside 07:00–11:00 ET; yahoo/ from a 60d fetch):
  python vb_rsi_study.py rows.csv.gz --yahoo yahoo/ [--candle 2 5] [--from 2026-08-20] [--hmin 30]
  python vb_rsi_study.py rows.csv.gz --yahoo yahoo/ --candle 2 --list AIOK 2026-10-28
"""
import argparse, bisect, datetime, duckdb, gzip, json, os, statistics, sys, zoneinfo
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--yahoo', required=True, help='directory of <TICKER>.json.gz Yahoo 5m chart results')
ap.add_argument('--candle', type=int, nargs='+', default=[2, 5], help='VB candle timeframes, minutes')
ap.add_argument('--bb', type=int, default=1, help='band timeframe, minutes')
ap.add_argument('--tol', type=float, default=0.0, help='the candle may open up to %% over the lower line')
ap.add_argument('--rr', type=float, default=2.0, help='target as a multiple of the risk')
ap.add_argument('--hcandles', type=int, default=6, help='horizon in candles of the timeframe being run')
ap.add_argument('--hmin', type=int, default=0, help='horizon in minutes (overrides --hcandles)')
ap.add_argument('--from', dest='from_day', default='2026-08-20', help='first day with entries (earlier days warm up)')
ap.add_argument('--list', nargs=2, metavar=('TICKER', 'DAY'), help="print one ticker-day's setups and entries")
args = ap.parse_args()
LEN, MULT, MAX_GAP = 20, 2.0, 3
RSI_N, WARM_10M = 14, 40
ET = zoneinfo.ZoneInfo('America/New_York')
FROM = datetime.date.fromisoformat(args.from_day)
KINDS = ['v30', 'v28', 'x1', 'x1_10up', 'both', 'both_10new', 'both_c10']
LABELS = {
    'v30': 'RETEST at the candle close (v30)',
    'v28': 'RETEST, first green 1m close (v28)',
    'x1': '1m RSI crosses its MA',
    'x1_10up': '1m RSI crosses, 10m RSI above its MA',
    'both': 'both RSIs above their MAs (your rule)',
    'both_10new': 'both, the 10m crossing after the pullback',
    'both_c10': 'both, the 10m on finished 10m candles',
}

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
hz = f"{args.hmin} min" if args.hmin else f"{args.hcandles} candles"
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} (entries from {FROM}) | band {args.bb}m "
      f"| tol {args.tol}% | target {args.rr}R | horizon {hz} | RSI {RSI_N}, MA {RSI_N}")


class Rsi:
    """TradingView's ta.rsi(close, 14) and ta.sma(rsi, 14), one close at a time."""
    def __init__(self):
        self.last = None
        self.seed_u, self.seed_d = [], []
        self.up = self.dn = None
        self.hist = []          # the last 14 RSI values
        self.n = 0              # closes seen

    @staticmethod
    def value(up, dn):
        return 100.0 if dn == 0 else 0.0 if up == 0 else 100 - 100 / (1 + up / dn)

    def peek(self, close):
        """(rsi, ma) if `close` were the next bar's close, without keeping it."""
        if self.last is None or self.up is None or len(self.hist) < RSI_N - 1:
            return None, None
        ch = close - self.last
        up = (self.up * (RSI_N - 1) + max(ch, 0)) / RSI_N
        dn = (self.dn * (RSI_N - 1) + max(-ch, 0)) / RSI_N
        r = self.value(up, dn)
        return r, (sum(self.hist[-(RSI_N - 1):]) + r) / RSI_N

    def push(self, close):
        self.n += 1
        if self.last is not None:
            ch = close - self.last
            u, d = max(ch, 0), max(-ch, 0)
            if self.up is None:
                self.seed_u.append(u)
                self.seed_d.append(d)
                if len(self.seed_u) == RSI_N:
                    self.up, self.dn = sum(self.seed_u) / RSI_N, sum(self.seed_d) / RSI_N
                    self.hist.append(self.value(self.up, self.dn))
            else:
                self.up = (self.up * (RSI_N - 1) + u) / RSI_N
                self.dn = (self.dn * (RSI_N - 1) + d) / RSI_N
                self.hist = (self.hist + [self.value(self.up, self.dn)])[-RSI_N:]
        self.last = close
        if len(self.hist) == RSI_N:
            return self.hist[-1], sum(self.hist) / RSI_N
        return None, None


class Tenm:
    """One ticker's 10m bars from Yahoo 5m bars, with the RSI state after each completed bar."""
    def __init__(self, ticker):
        self.keys, self.states = [], []
        path = os.path.join(args.yahoo, f'{ticker}.json.gz')
        if not os.path.exists(path):
            return
        with gzip.open(path, 'rt') as f:
            d = json.load(f)
        ts = d.get('timestamp') or []
        closes = ((d.get('indicators') or {}).get('quote') or [{}])[0].get('close') or []
        buckets = {}
        for t, c in zip(ts, closes):
            if c is None:
                continue
            dt = datetime.datetime.fromtimestamp(t, ET)
            m = dt.hour * 60 + dt.minute
            if not 240 <= m < 1200:
                continue
            buckets[(dt.date().toordinal(), m // 10)] = c     # later 5m bars overwrite: the last close
        rsi = Rsi()
        for k in sorted(buckets):
            rsi.push(buckets[k])
            self.keys.append(k)
            # after this bar: last close, rma state, the last 14 RSI values
            self.states.append((rsi.last, rsi.up, rsi.dn, tuple(rsi.hist), rsi.n))

    def live(self, day_ord, tmin, price):
        """The 10m (rsi, ma) the chart shows at this 1m close: completed bars + `price` as the open bar."""
        j = bisect.bisect_left(self.keys, (day_ord, tmin // 10))
        if j < WARM_10M:
            return None, None
        last, up, dn, hist, _ = self.states[j - 1]
        if up is None or len(hist) < RSI_N - 1:
            return None, None
        ch = price - last
        u = (up * (RSI_N - 1) + max(ch, 0)) / RSI_N
        d = (dn * (RSI_N - 1) + max(-ch, 0)) / RSI_N
        r = Rsi.value(u, d)
        return r, (sum(hist[-(RSI_N - 1):]) + r) / RSI_N

    def closed(self, day_ord, tmin, price):
        """The 10m (rsi, ma) of the last finished 10m candle; in a candle's last minute, that candle."""
        if tmin % 10 == 9:
            return self.live(day_ord, tmin, price)
        j = bisect.bisect_left(self.keys, (day_ord, tmin // 10))
        if j < WARM_10M:
            return None, None
        hist = self.states[j - 1][3]
        if len(hist) < RSI_N:
            return None, None
        return hist[-1], sum(hist) / RSI_N


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


RSI1 = {}       # ticker → its 1m Rsi, carried across days
TENM = {}       # the current ticker's Tenm


def run_day(key, bars, cmin, out, listing=False):
    ticker, day = key
    prior = PRIOR.get(key)
    horizon = args.hmin if args.hmin else args.hcandles * cmin
    if ticker not in TENM:
        TENM.clear()
        TENM[ticker] = Tenm(ticker)
        RSI1.clear()
    tenm = TENM[ticker]
    rsi1 = RSI1.setdefault(ticker, Rsi())
    entries_on = day >= FROM
    day_ord = day.toordinal()
    closes, last_bb, last_c = [], None, None
    ckey = c_open = c_high = c_low = None
    fired, vb_t = False, None
    day_max = -1e9
    prev_c = prev_vw = None
    prev_r1 = prev_m1 = None
    setup = None
    for k, (t, o, h, l, c, vw, chg, grade) in enumerate(bars):
        day_max = max(day_max, chg if chg is not None else -1e9)
        r1, m1 = rsi1.push(c)
        r10, m10 = tenm.live(day_ord, t, c) if tenm.keys else (None, None)
        r10c, m10c = tenm.closed(day_ord, t, c) if tenm.keys else (None, None)
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
            # RETEST at the candle's close (v30): the first candle after the VB candle that came within 1%
            # of the line and closed above it, bought at that close
            if (setup and setup['live'] and setup['eligible'] and setup['touch_k'] is not None and prev_vw
                    and prev_c > prev_vw and k > setup['set_k'] and 'v30' not in setup['done']):
                if (t - setup['set_t'] - cmin) // cmin < 6:
                    enter(setup, 'v30', bars, k - 1, prev_c, horizon, out, listing, t - 1, grade)
            if fired:   # the VB candle just closed: a new setup, replacing the last one
                eligible = entries_on and r1 is not None and r10 is not None
                setup = dict(set_k=k, set_t=t, live=True, eligible=eligible, pull_low=None, touch_k=None,
                             done=set(), armed_both=False, ten_below=False, armed_c10=False)
                if eligible:
                    out['setups'] += 1
                if listing:
                    print(f"  VB candle closed {et_hm(t)} ET: high {c_high} · low {c_low} · close {prev_c} · VWAP {prev_vw}"
                          f" · {'eligible' if eligible else 'RSI not warm'}")
            if setup and setup['live'] and prev_vw and prev_c < prev_vw:
                setup['live'] = False
                if listing:
                    print(f"    cancelled {et_hm(t)}: the candle closed {prev_c} under the VWAP {prev_vw}")
            ckey, c_open, c_high, c_low, fired = key_c, o, h, l, False
        else:
            c_high, c_low = max(c_high, h), min(c_low, l)
        if setup and setup['live'] and setup['eligible'] and k >= setup['set_k'] and vw:
            setup['pull_low'] = l if setup['pull_low'] is None else min(setup['pull_low'], l)
            if setup['touch_k'] is None and l <= vw * 1.01:
                setup['touch_k'] = k
            if setup['touch_k'] is not None and r1 is not None and r10 is not None and r10c is not None:
                both = r1 > m1 and r10 > m10
                both_c = r1 > m1 and r10c > m10c
                if not both_c:
                    setup['armed_c10'] = True
                cross1 = prev_r1 is not None and prev_r1 <= prev_m1 and r1 > m1
                if not both:
                    setup['armed_both'] = True
                if r10 <= m10:
                    setup['ten_below'] = True
                if c > vw:
                    hits = {
                        'v28': c > o,
                        'x1': cross1,
                        'x1_10up': cross1 and r10 > m10,
                        'both': both and setup['armed_both'],
                        'both_10new': both and setup['ten_below'],
                        'both_c10': both_c and setup['armed_c10'],
                    }
                    for kind, hit in hits.items():
                        if hit:
                            enter(setup, kind, bars, k, c, horizon, out, listing, t, grade,
                                  extra=f" · RSI 1m {r1:.1f}/{m1:.1f} · 10m {r10:.1f}/{m10:.1f}")
        # VB (v23): open at/under the higher line and ≤ tol % over the lower; close above both
        gainer = day_max >= 20 or (prior is not None and prior >= 20)
        if (not fired and gainer and band is not None and vw and c_open <= max(vw, band)
                and c_open <= min(vw, band) * (1 + args.tol / 100) and c > vw and c > band):
            fired, vb_t = True, t
            if listing:
                rr = f"RSI 1m {r1:.1f}/{m1:.1f}" if r1 is not None else 'RSI 1m —'
                rr += f" · 10m {r10:.1f}/{m10:.1f}" if r10 is not None else ' · 10m —'
                print(f"  CROSS {et_hm(t)} ET {c} · VWAP {vw} · band {band:.4g} · candle open {c_open} · {rr}")
        prev_c, prev_vw, prev_r1, prev_m1 = c, vw, r1, m1


def enter(setup, kind, bars, k, price, horizon, out, listing, t, grade, extra=''):
    """Record the first entry of each kind per setup, under both wait limits."""
    if kind in setup['done']:
        return
    setup['done'].add(kind)
    stop = setup['pull_low'] - tick(setup['pull_low'])
    if stop >= price:
        return
    res = trade(bars, k, price, stop, horizon)
    waited = t - setup['set_t']
    vw = bars[k][5]
    row = res + (waited, t, grade, (price / vw - 1) * 100 if vw else None)
    out[(kind, 'any')].append(row)
    cmin = out['cmin']
    if waited < 6 * cmin:
        out[(kind, '6')].append(row)
    if listing:
        print(f"    {LABELS[kind]:<44} {et_hm(t)} ET buy {price:.4g} ({row[6]:+.1f}% vs VWAP) stop {stop:.4g} "
              f"→ {res[0]} {res[1] * 100:+.1f}%{extra}")


def stats(res, n_setups):
    if not res:
        return '     —'
    n = len(res)
    win = sum(r[0] == 'win' for r in res) / n
    stop = sum(r[0] == 'stop' for r in res) / n
    pnl = [r[1] * 100 for r in res]
    rr5 = [r[1] / r[2] for r in res if r[2] >= 0.005]
    return (f"{n:>6,} ({n / max(n_setups, 1):4.0%})  {args.rr:g}R first {win:5.1%}  stop {stop:5.1%}  "
            f"avg {statistics.mean(pnl):+6.2f}%  made money {sum(p > 0 for p in pnl) / n:5.1%}  "
            f"risk {statistics.median(r[2] * 100 for r in res):4.1f}%  {statistics.mean(rr5) if rr5 else 0:+5.2f}R  "
            f"wait {statistics.median(r[3] for r in res):3.0f}m  vs VWAP {statistics.median(r[6] for r in res if r[6] is not None):+4.1f}%")


def rows_of(ticker=None, day=None):
    q = "select ticker, day, tmin, o, h, l, c, vw, chg, grade from bars"
    if ticker:
        q += f" where ticker = '{ticker}' and day <= date '{day}'"
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


def new_out(cmin):
    out = defaultdict(list)
    out['setups'], out['cmin'] = 0, cmin
    return out


if args.list:
    tk, day = args.list
    target = datetime.date.fromisoformat(day)
    for cmin in args.candle:
        print(f"\n=== {tk} {day}, {cmin}m candles, {args.bb}m band ===")
        TENM.clear()
        RSI1.clear()
        out = new_out(cmin)
        # earlier days only warm the 1m RSI up; print the asked day
        each_day(rows_of(tk, day), lambda key, b: run_day(key, b, cmin, out, listing=key[1] == target))
    sys.exit(0)

for cmin in args.candle:
    TENM.clear()
    RSI1.clear()
    out = new_out(cmin)
    each_day(rows_of(), lambda key, b: run_day(key, b, cmin, out))
    ns = out['setups']
    print(f"\n=== {cmin}m candles, {args.bb}m band: {ns:,} VB candles with warm RSIs ===")
    print(f"  {'entry':<46}{'trades (of VB candles)':>13}")
    for wait, wname in (('6', 'within 6 candles of the VB candle'), ('any', 'no time limit (until the setup ends)')):
        print(f"  — {wname}")
        for kind in KINDS:
            print(f"  {LABELS[kind]:<46}{stats(out[(kind, wait)], ns)}")
    print("  by time of day (ET), no time limit:")
    def tod(m):
        return 'a 04:00-07:00' if m < 420 else 'b 07:00-09:30' if m < 570 else 'c 09:30-12:00' if m < 720 else 'd 12:00-16:00' if m < 960 else 'e 16:00-20:00'
    groups = defaultdict(lambda: defaultdict(list))
    for kind in ('v30', 'x1', 'both', 'both_c10'):
        for r in out[(kind, 'any')]:
            groups[tod(r[4])][kind].append(r)
    for g in sorted(groups):
        for kind in ('v30', 'x1', 'both', 'both_c10'):
            print(f"    {g:<15}{LABELS[kind]:<46}{stats(groups[g][kind], ns)}")
