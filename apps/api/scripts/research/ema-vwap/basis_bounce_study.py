"""The bounce off the basis line — a setup the operator read off NIVF's 1m chart (2026-11-25).

The operator, with the band cross's basis line (script v46) set to 1 minute / length 15 and a
MACD 12 26 9 under the chart, on three moves of NIVF (14:55, 16:00 and 16:55 their time): "How
can I catch such moves? … for all of them, candle breaks the bb basis, the bb basis moving up,
macd turned green, and price pulls back to bb basis line and bounces and this bounce is a signal".

Data     every Momentum row (export-rows.sql in ../vwap-pullback) → 1m bars from the ~20-second
         snapshots (a bar's high and low are the highest and lowest of about three snapshots, so
         real wicks are understated), runs split where a name is off our screen for over 3 minutes,
         --warm bars of warm-up per run. Names are on the Momentum screen, so already in play.
Lines    basis = SMA(--len, 15) of the 1m closes. MACD = EMA 12 − EMA 26 of the closes, signal =
         EMA 9 of it, "green" = MACD above its signal (the histogram above zero).
Setup    break    a close above the basis after a close at or under it
         touch    on a later bar, within --wait bars, the low comes down to the basis (at or under
                  it, or within --tol % above it)
         BOUNCE   that bar or a later one (still within --wait) closes green and above the basis,
                  with the basis rising (above its value a bar before) and the MACD green.
                  A close under the basis first ends the wait. One BOUNCE per break.
Controls break+   the break bar's own close, when the basis is rising and the MACD is green there
                  (no waiting): is the pullback worth waiting for?
         break    every break, no conditions
         no-macd / no-slope   the BOUNCE without one of its two conditions
Outcomes all from the entry close, inside the run, at most --horizon bars:
         +5% / +10%   a bar high that far above the entry before a close under the basis
         ride     hold until the first close under the basis (the line trails the trade): its
                  return in %, the share of rides that end above the entry
         2R       stop a tick under the pullback's lowest low (the break bar's low for the break
                  entries), target twice that distance, 30 bars → R; stops under 0.5% away are
                  left out of the R average
Split    by date: in sample before --cut, out of sample from it.

Run:  python basis_bounce_study.py rows.csv.gz [--len 15] [--wait 10] [--tol 1.0] [--cut 2026-10-09]
"""
import argparse, datetime, duckdb, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--len', type=int, default=15, help='basis length (1m closes)')
ap.add_argument('--wait', type=int, default=10, help='bars after the break a bounce may come in')
ap.add_argument('--tol', type=float, default=1.0, help='a low within this %% above the basis counts as a touch')
ap.add_argument('--warm', type=int, default=40, help='bars of warm-up per run')
ap.add_argument('--horizon', type=int, default=60)
ap.add_argument('--cut', default='2026-10-09')
ap.add_argument('--list', help='print the BOUNCEs of a ticker')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
MAX_GAP, TOL = 3, args.tol / 100

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         try_cast(change_pct as double) as chg, try_cast(volume as double) as volume,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw, arg_max(chg, ts) as chg, arg_max(volume, ts) as vol
from t
where hour(et) * 60 + minute(et) between 240 and 1199 and isodow(et) < 6
group by all""")
n_bars, n_days = con.execute("select count(*), count(distinct day) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()
print(f"{n_bars:,} 1m bars on {n_days} days, {span[0]} → {span[1]} | basis SMA {args.len}, MACD 12 26 9 | "
      f"touch within {args.tol:g}% of the basis, bounce within {args.wait} bars | in sample before {CUT}")

EV = defaultdict(list)       # variant → events


def outcome(run, j, entry, stop_low):
    """Everything measured from bar j's close (entry). run = list of (t, o, h, l, c, b)."""
    hit5 = hit10 = False
    ride = None
    r_out = None
    stop = stop_low * 0.999
    risk = entry - stop
    end = min(len(run) - 1, j + args.horizon)
    for k in range(j + 1, end + 1):
        _, _, h, l, c, b = run[k]
        if ride is None:
            if b is not None and c < b:
                ride = c / entry - 1
            else:
                hit5 = hit5 or h >= entry * 1.05
                hit10 = hit10 or h >= entry * 1.10
        if r_out is None and risk > 0 and k - j <= 30:
            if l <= stop:
                r_out = -1.0
            elif h >= entry + 2 * risk:
                r_out = 2.0
            elif k - j == 30:
                r_out = (c - entry) / risk
        if ride is not None and (r_out is not None or risk <= 0 or k - j > 30):
            break
    last_c = run[end][4]
    if ride is None:
        ride = last_c / entry - 1
    if r_out is None and risk > 0:
        r_out = (run[min(end, j + 30)][4] - entry) / risk
    return dict(hit5=hit5, hit10=hit10, ride=ride, r=r_out, risk=risk / entry if entry else 0)


def do_run(ticker, day, run_raw):
    """run_raw: consecutive 1m bars (t, o, h, l, c, vw, chg) of one stretch on screen."""
    n = len(run_raw)
    if n < args.warm + 5:
        return
    closes = [r[4] for r in run_raw]
    basis = [None] * n
    s = 0.0
    for i, c in enumerate(closes):
        s += c
        if i >= args.len:
            s -= closes[i - args.len]
        if i >= args.len - 1:
            basis[i] = s / args.len
    e12 = e26 = closes[0]
    sig = 0.0
    hist = [0.0] * n
    for i, c in enumerate(closes):
        e12 += (c - e12) * 2 / 13
        e26 += (c - e26) * 2 / 27
        m = e12 - e26
        sig += (m - sig) * 2 / 10
        hist[i] = m - sig
    run = [(r[0], r[1], r[2], r[3], r[4], basis[i]) for i, r in enumerate(run_raw)]
    macd_line = [0.0] * n
    e12 = e26 = closes[0]
    for i, c in enumerate(closes):
        e12 += (c - e12) * 2 / 13
        e26 += (c - e26) * 2 / 27
        macd_line[i] = e12 - e26
    bv = [0.0] * n                                   # the bar's own volume (the day's running volume, differenced)
    for i in range(1, n):
        a, b0 = run_raw[i][7], run_raw[i - 1][7]
        bv[i] = max(0.0, a - b0) if a is not None and b0 is not None else 0.0

    def rvol(i):
        prev = bv[max(1, i - 20):i]
        m = sum(prev) / len(prev) if prev else 0.0
        return bv[i] / m if m > 0 else None
    def fall(i):
        """The basis's fall before its last low: its lowest value in the 30 bars to i, against its
        highest in the 45 bars before that low. → (fall as a fraction, bars since the low)."""
        lo = max(args.len - 1, i - 30)
        tr = min(range(lo, i + 1), key=lambda k: basis[k])
        peak = max(basis[max(args.len - 1, tr - 45):tr + 1])
        return dict(fall=1 - basis[tr] / peak if peak > 0 else 0.0, since_low=i - tr)
    under = 0                                        # closes at or under the basis in a row, before this bar
    wait = None          # the open break: dict(i0, low, touched, done flags per variant)
    for i in range(args.warm, n):
        t, o, h, l, c, b = run[i]
        pb = basis[i - 1]
        if b is None or pb is None:
            continue
        rising, green_macd = b > pb, hist[i] > 0
        vw, chg = run_raw[i][5], run_raw[i][6]
        base = dict(ticker=ticker, day=day, t=t, entry=c, above_vwap=None if not vw else c >= vw, chg=chg, price=c,
                    rvol=rvol(i), macd_pos=macd_line[i] > 0, ext=c / b - 1)
        if wait is not None:
            if c < b:
                wait = None                       # a close under the basis ends it
            else:
                wait['low'] = min(wait['low'], l)
                if l <= b * (1 + TOL):
                    wait['touched'] = True
                if wait['touched'] and c > o and c > b:
                    for name, ok in (('bounce', rising and green_macd), ('no-macd', rising), ('no-slope', green_macd)):
                        if ok and name not in wait['fired']:
                            wait['fired'].add(name)
                            EV[name].append({**base, 'wait': i - wait['i0'], 'under_n': wait['under_n'], 'brk_rvol': wait['brk_rvol'],
                                             **fall(i), **outcome(run, i, c, wait['low'])})
                if i - wait['i0'] >= args.wait or len(wait['fired']) == 3:
                    wait = None
        prev_c = run[i - 1][4]
        if wait is None and c > b and prev_c <= pb:   # a break
            f = fall(i)
            EV['break'].append({**base, 'wait': 0, **f, **outcome(run, i, c, min(l, b))})
            if rising and green_macd:
                EV['break+'].append({**base, 'wait': 0, **f, **outcome(run, i, c, min(l, b))})
            wait = dict(i0=i, low=c, touched=False, fired=set(), under_n=under, brk_rvol=rvol(i))   # the pullback's low starts after the break bar
        under = under + 1 if c <= b else 0


cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, chg, vol from bars order by ticker, day, tmin")
key, run, prev_t = None, [], None
while True:
    chunk = cur.fetchmany(200_000)
    if not chunk:
        break
    for row in chunk:
        k = (row[0], row[1])
        t = row[2]
        if k != key or (prev_t is not None and t - prev_t > MAX_GAP):
            if run:
                do_run(key[0], key[1], run)
            run = []
        key, prev_t = k, t
        if row[6] is not None:
            run.append(row[2:])
if run:
    do_run(key[0], key[1], run)


def hhmm(t):
    return f"{t // 60:02d}:{t % 60:02d}"


if args.list:
    for e in EV['bounce']:
        if e['ticker'] == args.list.upper():
            print(f"{e['day']} {hhmm(e['t'])} ET  entry {e['entry']:.4g}  wait {e['wait']}  +5% {e['hit5']}  +10% {e['hit10']}  "
                  f"ride {e['ride']:+.1%}  R {e['r'] if e['r'] is None else round(e['r'], 2)}")
    sys.exit(0)

DAYS_IN = con.execute(f"select count(distinct day) from bars where day < date '{CUT}'").fetchone()[0]
DAYS_OUT = con.execute(f"select count(distinct day) from bars where day >= date '{CUT}'").fetchone()[0]


def stats(evs, days):
    n = len(evs)
    if n == 0:
        return None
    rides = [e['ride'] for e in evs]
    rs = [e['r'] for e in evs if e['r'] is not None and e['risk'] >= 0.005]
    return dict(n=n, per_day=n / days, hit5=100 * sum(e['hit5'] for e in evs) / n, hit10=100 * sum(e['hit10'] for e in evs) / n,
                ride=100 * statistics.fmean(rides), ride_med=100 * statistics.median(rides),
                ride_up=100 * sum(1 for r in rides if r > 0) / n,
                r=statistics.fmean(rs) if rs else float('nan'), stopped=100 * sum(1 for x in rs if x <= -1) / len(rs) if rs else float('nan'))


def cell(s):
    if s is None:
        return f"{'—':>58}"
    return (f"{s['n']:>6,} {s['per_day']:>6.1f} {s['hit5']:>5.1f}% {s['hit10']:>5.1f}% {s['ride']:>+6.2f}% {s['ride_med']:>+6.2f}% "
            f"{s['ride_up']:>4.0f}% {s['r']:>+6.2f} {s['stopped']:>4.0f}%")


HEAD = (f"{'':<34}{'n':>6} {'/day':>6} {'+5%':>6} {'+10%':>6} {'ride':>7} {'median':>7} {'up':>5} {'2R avg':>6} {'stop':>5}")


def table(title, rows):
    print(f"\n{title}")
    for label, days, pick in (('in sample', DAYS_IN, lambda e: e['day'] < CUT), ('out of sample', DAYS_OUT, lambda e: e['day'] >= CUT)):
        print(f"  {label}\n  {HEAD}")
        for name, evs in rows:
            print(f"  {name:<34}{cell(stats([e for e in evs if pick(e)], days))}")


B = EV['bounce']
table("1) The BOUNCE against its controls", [
    ('BOUNCE (the operator\'s rule)', B),
    ('break+ (no waiting)', EV['break+']),
    ('every break of the basis', EV['break']),
    ('bounce without the MACD', EV['no-macd']),
    ('bounce without the rising basis', EV['no-slope'])])
table("2) The BOUNCE by where the price is against the session VWAP", [
    ('at or above the VWAP', [e for e in B if e['above_vwap']]),
    ('under the VWAP', [e for e in B if e['above_vwap'] is False])])
table("3) The BOUNCE by the time of day (New York)", [
    ('04:00–07:00', [e for e in B if e['t'] < 420]),
    ('07:00–09:30', [e for e in B if 420 <= e['t'] < 570]),
    ('09:30–11:00', [e for e in B if 570 <= e['t'] < 660]),
    ('11:00–16:00', [e for e in B if 660 <= e['t'] < 960]),
    ('16:00–20:00', [e for e in B if e['t'] >= 960])])
table("4) The BOUNCE by price", [
    ('under $1', [e for e in B if e['price'] < 1]),
    ('$1 – $5', [e for e in B if 1 <= e['price'] < 5]),
    ('$5 and over', [e for e in B if e['price'] >= 5])])
table("6) The BOUNCE by the signal bar's volume against the 20 bars before", [
    ('under 1×', [e for e in B if e['rvol'] is not None and e['rvol'] < 1]),
    ('1× – 3×', [e for e in B if e['rvol'] is not None and 1 <= e['rvol'] < 3]),
    ('3× – 10×', [e for e in B if e['rvol'] is not None and 3 <= e['rvol'] < 10]),
    ('10× and over', [e for e in B if e['rvol'] is not None and e['rvol'] >= 10])])
table("7) The BOUNCE by the break bar's volume against the 20 bars before", [
    ('under 1×', [e for e in B if e['brk_rvol'] is not None and e['brk_rvol'] < 1]),
    ('1× – 3×', [e for e in B if e['brk_rvol'] is not None and 1 <= e['brk_rvol'] < 3]),
    ('3× – 10×', [e for e in B if e['brk_rvol'] is not None and 3 <= e['brk_rvol'] < 10]),
    ('10× and over', [e for e in B if e['brk_rvol'] is not None and e['brk_rvol'] >= 10])])
table("8) The BOUNCE by how long the price had closed under the basis before the break", [
    ('1–4 bars', [e for e in B if e['under_n'] < 5]),
    ('5–14 bars', [e for e in B if 5 <= e['under_n'] < 15]),
    ('15 bars and more', [e for e in B if e['under_n'] >= 15])])
table("9) The BOUNCE by the MACD line itself, and by the day's change at the signal", [
    ('MACD line above zero', [e for e in B if e['macd_pos']]),
    ('MACD line under zero', [e for e in B if not e['macd_pos']]),
    ('day change under +30%', [e for e in B if e['chg'] is not None and e['chg'] < 30]),
    ('+30% – +60%', [e for e in B if e['chg'] is not None and 30 <= e['chg'] < 60]),
    ('+60% and over', [e for e in B if e['chg'] is not None and e['chg'] >= 60])])
RECENT = [e for e in B if e['since_low'] <= 15]
FALLS = (('under 2%', 0, 0.02), ('2% – 5%', 0.02, 0.05), ('5% – 10%', 0.05, 0.10), ('10% and over', 0.10, 9))
table("10) The BOUNCE by how far the basis fell before it turned up (its low within the last 15 bars)",
      [(lab, [e for e in RECENT if a <= e['fall'] < b]) for lab, a, b in FALLS]
      + [('its low is older than 15 bars', [e for e in B if e['since_low'] > 15])])
BIG = [e for e in RECENT if e['fall'] >= 0.05]
table("11) After a fall of 5% or more: the BOUNCE against the plain break, and by the time of day", [
    ('BOUNCE', BIG),
    ('break+ (no waiting)', [e for e in EV['break+'] if e['since_low'] <= 15 and e['fall'] >= 0.05]),
    ('every break', [e for e in EV['break'] if e['since_low'] <= 15 and e['fall'] >= 0.05]),
    ('BOUNCE 04:00–09:30', [e for e in BIG if e['t'] < 570]),
    ('BOUNCE 09:30–11:00', [e for e in BIG if 570 <= e['t'] < 660]),
    ('BOUNCE 11:00–16:00', [e for e in BIG if 660 <= e['t'] < 960]),
    ('BOUNCE 16:00–20:00', [e for e in BIG if e['t'] >= 960]),
    ('BOUNCE, day change +60% and over', [e for e in BIG if e['chg'] is not None and e['chg'] >= 60]),
    ('BOUNCE, day change under +60%', [e for e in BIG if e['chg'] is not None and e['chg'] < 60])])
table("5) The BOUNCE by how long the pullback took", [
    ('1–2 bars after the break', [e for e in B if e['wait'] <= 2]),
    ('3–5 bars', [e for e in B if 3 <= e['wait'] <= 5]),
    ('6–10 bars', [e for e in B if e['wait'] >= 6])])
