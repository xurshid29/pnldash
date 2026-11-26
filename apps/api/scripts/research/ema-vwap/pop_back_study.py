"""POP and BACK as script v48 builds them, measured on our own bars (2026-11-26)

The operator, after "Chasing the pop itself" (README): "yes, lets do that" to a two-step setup:
a POP alert as a heads-up, and the first pullback's bounce (BACK) as the entry. This runs the
rule the script's section 9 uses, so the alert counts and the outcomes are the built rule's.

Data     as basis_bounce_study.py: Momentum rows → 1m bars from ~20-second snapshots, runs split
         where a name is off our screen for over 3 minutes, basis = SMA 15 of the 1m closes.
         A name's first 15 candles on our screen have no basis, so pops in them are missed: the
         counts are a floor (TradingView has the candles from before).
Rule     run    starts at a close above the basis after a close at or under it; ends at a close
                under it
         POP    the first candle of a run by which a high has reached --up % above the basis
                (one per run)
         BACK   after the POP candle, within --wait candles of it (0 = until the run ends): a low
                within --tol % above the basis, then that candle or a later one closing green
                above the basis with the basis rising and (--macd) the MACD above its signal
         stop   a tick under the lowest low after the run's highest high, the bounce candle's
                low included
Outcomes from the BACK close: a bar high +5% / +10% above it before a close under the basis;
         ride = hold to the first close under the basis; R = the stop, a 2R target, or that close.
Split    by date: in sample before --cut, out of sample from it.
Tables   1 the POPs, 2 the BACKs, and (the operator's next question: do the POPs with a volume
         surge, or at certain hours, run further?) 3 POPs by the POP candle's volume against the
         20 candles before, 4 by the time of day, 5 both, 6 BACKs by their POP's volume. A
         minute's volume = the day's volume at its last snapshot less the minute before's.

Run:  python pop_back_study.py rows.csv.gz [--up 10] [--wait 20] [--tol 1] [--macd 1] [--cap 3]
"""
import argparse, datetime, duckdb, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--up', type=float, default=10.0, help='POP: a high at least this %% above the basis (the script\'s default)')
ap.add_argument('--wait', type=int, default=20, help='BACK: within N candles of the POP candle (0 = until the run ends)')
ap.add_argument('--tol', type=float, default=1.0, help='BACK: a low within this %% above the basis is the touch')
ap.add_argument('--macd', type=int, default=1, help='BACK: 1 = the MACD (12 26 9) must be above its signal')
ap.add_argument('--cap', type=int, default=3, help="the server's daily cap per ticker")
ap.add_argument('--gain', type=float, default=10.0, help='the gainer filter: day change at least this %%')
ap.add_argument('--len', type=int, default=15)
ap.add_argument('--cut', default='2026-10-09')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
MAX_GAP, HORIZON = 3, 60

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(change_pct as double) as chg,
         try_cast(volume as double) as volume, timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(chg, ts) as chg, arg_max(volume, ts) as vol
from t
where hour(et) * 60 + minute(et) between 240 and 1199 and isodow(et) < 6
group by all""")
days_in = con.execute(f"select count(distinct day) from bars where day < date '{CUT}'").fetchone()[0]
days_out = con.execute(f"select count(distinct day) from bars where day >= date '{CUT}'").fetchone()[0]
print(f"POP = a run's high ≥ {args.up:g}% above the basis (SMA {args.len}); BACK = touch within {args.tol:g}%, green close above a rising basis"
      f"{', MACD green' if args.macd else ''}, within {args.wait or '∞'} candles of the POP | {days_in} days in sample, {days_out} out (from {CUT})")

POPS, BACKS = [], []
SEEN = defaultdict(lambda: [0, 0])   # (ticker, day) → the day's POPs, BACKs sent


def ema(xs, n):
    a, out, e = 2 / (n + 1), [], None
    for x in xs:
        e = x if e is None else a * x + (1 - a) * e
        out.append(e)
    return out


def outcome(run, basis, j, entry, stop):
    risk = entry - stop
    hit5 = hit10 = False
    r = None
    for k in range(j + 1, min(len(run), j + HORIZON + 1)):
        _, _, h, l, c = run[k][:5]
        if r is None and risk > 0:
            if l <= stop:
                r = -1.0
            elif h >= entry + 2 * risk:
                r = 2.0
        if basis[k] is not None and c < basis[k]:
            return dict(hit5=hit5, hit10=hit10, ride=c / entry - 1, r=r if r is not None else ((c - entry) / risk if risk > 0 else None))
        hit5 = hit5 or h >= entry * 1.05
        hit10 = hit10 or h >= entry * 1.10
    last = run[min(len(run) - 1, j + HORIZON)][4]
    return dict(hit5=hit5, hit10=hit10, ride=last / entry - 1, r=r if r is not None else ((last - entry) / risk if risk > 0 else None))


def chase(run, basis, j, entry):
    """Buying the POP candle's close: the highest high before a close under the basis."""
    mfe = 0.0
    for k in range(j + 1, min(len(run), j + HORIZON + 1)):
        _, _, h, l, c = run[k][:5]
        if basis[k] is not None and c < basis[k]:
            return dict(mfe=mfe, ride=c / entry - 1, bars=k - j)
        mfe = max(mfe, h / entry - 1)
    return dict(mfe=mfe, ride=run[min(len(run) - 1, j + HORIZON)][4] / entry - 1, bars=HORIZON)


def do_run(ticker, day, run):
    n = len(run)
    if n < args.len + 2:
        return
    # a minute's volume = the day's volume at its last snapshot less the minute before's
    bv = [0.0] * n
    for i in range(1, n):
        a, b0 = run[i][6], run[i - 1][6]
        bv[i] = max(0.0, a - b0) if a is not None and b0 is not None else 0.0
    closes = [r[4] for r in run]
    basis = [None] * n
    s = 0.0
    for i, c in enumerate(closes):
        s += c
        if i >= args.len:
            s -= closes[i - args.len]
        if i >= args.len - 1:
            basis[i] = s / args.len
    macd = [f - sl for f, sl in zip(ema(closes, 12), ema(closes, 26))]
    hist = [m - sg for m, sg in zip(macd, ema(macd, 9))]
    seen = SEEN[(ticker, day)]
    inrun = popped = waiting = touched = False
    ran = top = 0.0
    pblow = None
    pop = None
    popbar = touchbar = topbar = 0
    pop_rv = None
    for i in range(args.len, n):
        t, o, h, l, c, chg, _ = run[i]
        b, pb = basis[i], basis[i - 1]
        gainer = chg is not None and chg >= args.gain
        if inrun and c < b:
            inrun = waiting = False
        elif not inrun and c > b and closes[i - 1] <= pb:
            inrun, popped, waiting, touched = True, False, False, False
            ran, top, pblow = 0.0, 0.0, None
        if not inrun:
            continue
        ran = max(ran, (h / b - 1) * 100)
        low_now = l if pblow is None else min(pblow, l)
        if not popped:
            if ran >= args.up:
                popped, waiting, touched, popbar = True, True, False, i
                pop = None
                # the script's reading (v49): the largest volume among the POP candle and the two
                # before it against the average of the 20 candles before those three; and how much
                # traded a minute in those 20, in dollars
                prev = bv[i - 22:i - 2] if i >= 23 else None
                m = sum(prev) / 20 if prev else None
                top3 = max(bv[i - 2:i + 1])
                pop_rv = (top3 / m if m > 0 else (999.0 if top3 > 0 else None)) if m is not None else None
                if gainer:
                    seen[0] += 1
                    pop = dict(ticker=ticker, day=day, t=t, ran=ran, price=c, n=seen[0], back=None, rv=pop_rv,
                               quiet=m * c if m is not None else None, chase=chase(run, basis, i, c), chg=chg)
                    POPS.append(pop)
        elif waiting:
            if l <= b * (1 + args.tol / 100):
                if not touched:
                    touchbar = i
                touched = True
            if touched and c > o and c > b and b > pb and (not args.macd or hist[i] > 0):
                waiting = False
                if gainer:
                    seen[1] += 1
                    tick = 0.01 if c >= 1 else 0.0001
                    e = dict(ticker=ticker, day=day, t=t, ran=ran, price=c, n=seen[1], since=i - popbar, green=hist[i] > 0,
                             vs_pop=c / run[popbar][4] - 1, stop_pct=(c - (low_now - tick)) / c, out=outcome(run, basis, i, c, low_now - tick),
                             had_pop=pop is not None, above=c / b - 1, after_touch=i - touchbar, rv=pop_rv,
                             newhigh=topbar > touchbar)   # a candle after the first touch made the run's high before this bounce
                    BACKS.append(e)
                    if pop is not None:
                        pop['back'] = e
            elif args.wait and i - popbar >= args.wait:
                waiting = False
        if h > top:
            top, pblow, topbar = h, None, i
        else:
            pblow = low_now


cur = con.execute("select ticker, day, tmin, o, h, l, c, chg, vol from bars order by ticker, day, tmin")
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


def med(xs):
    return statistics.median(xs) if xs else float('nan')


def pop_line(label, evs, days):
    n = len(evs)
    if n == 0:
        return f"  {label:<28}{'—':>8}"
    sent = [e for e in evs if e['n'] <= args.cap]
    bk = [e for e in evs if e['back']]
    return (f"  {label:<28}{n:>6,} {n / days:>6.1f} {len(sent) / days:>6.1f} | {100 * len(bk) / n:>4.0f}% "
            f"{med([e['back']['since'] for e in bk]):>5.0f} {100 * med([e['back']['vs_pop'] for e in bk]):>+6.1f}%")


def back_line(label, evs, days):
    n = len(evs)
    if n == 0:
        return f"  {label:<28}{'—':>8}"
    sent = [e for e in evs if e['n'] <= args.cap]
    o = [e['out'] for e in evs]
    rs = [x['r'] for x in o if x['r'] is not None]
    return (f"  {label:<28}{n:>6,} {n / days:>6.1f} {len(sent) / days:>6.1f} | {100 * sum(x['hit5'] for x in o) / n:>5.1f}% {100 * sum(x['hit10'] for x in o) / n:>5.1f}% "
            f"{100 * statistics.fmean(x['ride'] for x in o):>+6.2f}% {100 * sum(1 for r in rs if r <= -1) / len(rs):>5.1f}% {statistics.fmean(rs):>+6.2f}R "
            f"{100 * med([e['stop_pct'] for e in evs]):>5.1f}%")


def run_line(label, evs, days):
    """What the price did after the POP candle's close, before a close back under the basis."""
    n = len(evs)
    if n == 0:
        return f"  {label:<28}{'—':>8}"
    ch = [e['chase'] for e in evs]
    rv = [e['rv'] for e in evs if e['rv'] is not None]
    bk = [e for e in evs if e['back']]
    return (f"  {label:<28}{n:>6,} {n / days:>6.1f} | {100 * sum(x['mfe'] >= 0.10 for x in ch) / n:>5.1f}% {100 * sum(x['mfe'] >= 0.20 for x in ch) / n:>5.1f}% "
            f"{100 * sum(x['mfe'] >= 0.50 for x in ch) / n:>5.1f}% {100 * med([x['mfe'] for x in ch]):>+6.1f}% {100 * statistics.fmean(x['ride'] for x in ch):>+6.2f}% "
            f"{100 * sum(x['bars'] <= 5 for x in ch) / n:>5.1f}% | {med(rv):>6.1f}x {100 * len(bk) / n:>4.0f}%")


RUN_HEAD = (f"  {'':<28}{'n':>6} {'/day':>6} | {'+10%':>6} {'+20%':>6} {'+50%':>6} {'MFE':>7} {'ride':>7} {'fail5':>6} |"
            f" {'vol':>7} {'BACK':>5}")
POP_HEAD = f"  {'':<28}{'n':>6} {'/day':>6} {'capped':>6} | {'BACK':>5} {'wait':>5} {'vs POP':>7}"
BACK_HEAD = f"  {'':<28}{'n':>6} {'/day':>6} {'capped':>6} | {'+5%':>6} {'+10%':>6} {'ride':>7} {'stop':>6} {'2R':>7} {'risk':>6}"


def table(title, head, fn, rows):
    print(f"\n{title}")
    for name, days, pick in (('in sample', days_in, lambda e: e['day'] < CUT), ('out of sample', days_out, lambda e: e['day'] >= CUT)):
        print(f"  {name}\n{head}")
        for label, evs in rows:
            print(fn(label, [e for e in evs if pick(e)], days))


table(f"1) POP: the heads-up (capped = after the server's {args.cap} a day per ticker; BACK = the share a BACK follows, its wait in candles, its price against the POP close)",
      POP_HEAD, pop_line, [
          ('all POPs', POPS),
          ('04:00–09:30', [e for e in POPS if e['t'] < 570]),
          ('09:30–11:00', [e for e in POPS if 570 <= e['t'] < 660]),
          ('11:00–16:00', [e for e in POPS if 660 <= e['t'] < 960]),
          ('16:00–20:00', [e for e in POPS if e['t'] >= 960]),
          ("the day's 1st on a ticker", [e for e in POPS if e['n'] == 1]),
          ('2nd – 3rd', [e for e in POPS if 2 <= e['n'] <= 3]),
          ('4th and later', [e for e in POPS if e['n'] > 3])])
table("2) BACK: the entry (stop = stopped out before 2R or the close under the basis; risk = the stop's distance, median)",
      BACK_HEAD, back_line, [
          ('all BACKs', BACKS),
          (f'ran {args.up:g}% – 10%', [e for e in BACKS if e['ran'] < 10]),
          ('ran 10% – 20%', [e for e in BACKS if 10 <= e['ran'] < 20]),
          ('ran 20% and over', [e for e in BACKS if e['ran'] >= 20]),
          ('1 – 3 candles after the POP', [e for e in BACKS if e['since'] <= 3]),
          ('4 – 8', [e for e in BACKS if 4 <= e['since'] <= 8]),
          ('9 and later', [e for e in BACKS if e['since'] >= 9]),
          ('bounce on the touch candle', [e for e in BACKS if e['after_touch'] == 0]),
          ('1 – 2 candles after the touch', [e for e in BACKS if 1 <= e['after_touch'] <= 2]),
          ('3 and more after the touch', [e for e in BACKS if e['after_touch'] >= 3]),
          ('a new high since the touch', [e for e in BACKS if e['newhigh']]),
          ('no new high since the touch', [e for e in BACKS if not e['newhigh']]),
          ('closes under 2% above basis', [e for e in BACKS if e['above'] < 0.02]),
          ('2% – 5% above', [e for e in BACKS if 0.02 <= e['above'] < 0.05]),
          ('5% and more above', [e for e in BACKS if e['above'] >= 0.05]),
          ('MACD green', [e for e in BACKS if e['green']]),
          ('MACD not green', [e for e in BACKS if not e['green']]),
          ('04:00–09:30', [e for e in BACKS if e['t'] < 570]),
          ('09:30–11:00', [e for e in BACKS if 570 <= e['t'] < 660]),
          ('11:00–16:00', [e for e in BACKS if 660 <= e['t'] < 960]),
          ('16:00–20:00', [e for e in BACKS if e['t'] >= 960]),
          ("the day's 1st on a ticker", [e for e in BACKS if e['n'] == 1]),
          ('2nd – 3rd', [e for e in BACKS if 2 <= e['n'] <= 3]),
          ('4th and later', [e for e in BACKS if e['n'] > 3])])

# 3–5) The operator, 11-26: "the biggest 5-6 POPs happen after the pre-market open … or very fewer
# around 18:00 [08:00 New York] … the rvol for that moment should be very high … stocks which are
# almost without volume, suddenly started popping up".
# Columns: the price after the POP candle's close, before a close back under the basis: a high
# +10% / +20% / +50% above that close, the median highest high (MFE), the average if held to that
# close under the basis (ride), the share back under the basis within 5 candles (fail5); vol = the
# script's reading, the largest volume among the POP candle and the two before it against the
# average of the 20 candles before those three (median); BACK = the share a BACK follows.
RV = [e for e in POPS if e['rv'] is not None]
table("3) POP by its volume reading (the biggest of the POP candle and the two before, against the 20 candles before those)", RUN_HEAD, run_line, [
    ('all POPs with a reading', RV),
    ('under 2×', [e for e in RV if e['rv'] < 2]),
    ('2× – 5×', [e for e in RV if 2 <= e['rv'] < 5]),
    ('5× – 10×', [e for e in RV if 5 <= e['rv'] < 10]),
    ('10× – 30×', [e for e in RV if 10 <= e['rv'] < 30]),
    ('30× and over', [e for e in RV if e['rv'] >= 30]),
    ('5×+ and under $5K a minute before', [e for e in RV if e['rv'] >= 5 and e['quiet'] < 5000]),
    ('5×+ and $5K – $50K before', [e for e in RV if e['rv'] >= 5 and 5000 <= e['quiet'] < 50000]),
    ('5×+ and $50K and over before', [e for e in RV if e['rv'] >= 5 and e['quiet'] >= 50000]),
    ("5×+, the day's 1st on a ticker", [e for e in RV if e['rv'] >= 5 and e['n'] == 1]),
    ('5×+, 2nd and later', [e for e in RV if e['rv'] >= 5 and e['n'] > 1]),
    ("under 5×, the day's 1st", [e for e in RV if e['rv'] < 5 and e['n'] == 1]),
    ('under 5×, 2nd and later', [e for e in RV if e['rv'] < 5 and e['n'] > 1])])
HOURS = [('04:00–05:00', 240, 300), ('05:00–07:00', 300, 420), ('07:00–08:00', 420, 480), ('08:00–09:30', 480, 570),
         ('09:30–10:30', 570, 630), ('10:30–16:00', 630, 960), ('16:00–20:00', 960, 1200)]
table("4) POP by the time of day (New York)", RUN_HEAD, run_line,
      [(name, [e for e in POPS if a <= e['t'] < b]) for name, a, b in HOURS])
table("5) POP with a volume of 5× and over, by the time of day", RUN_HEAD, run_line,
      [(name, [e for e in RV if e['rv'] >= 5 and a <= e['t'] < b]) for name, a, b in HOURS])
RB = [e for e in BACKS if e['rv'] is not None]
table("6) BACK by its POP candle's volume", BACK_HEAD, back_line, [
    ('under 2×', [e for e in RB if e['rv'] < 2]),
    ('2× – 5×', [e for e in RB if 2 <= e['rv'] < 5]),
    ('5× – 10×', [e for e in RB if 5 <= e['rv'] < 10]),
    ('10× and over', [e for e in RB if e['rv'] >= 10])])
