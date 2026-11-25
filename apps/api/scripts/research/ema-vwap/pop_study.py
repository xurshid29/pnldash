"""The pop off a flat base: buy its first candle, or wait for its first pullback? (2026-11-26)

The operator, after the first-pullback measurement (README, "The first pullback after a pop"):
"but, now, I'm thinking how to catch them up, while the initial pop is moveing too fast".

Data     as basis_bounce_study.py: Momentum rows → 1m bars from ~20-second snapshots, runs split
         where a name is off our screen for over 3 minutes, basis = SMA 15 of the 1m closes.
Pop      the first green 1m candle that closes at least --up % above the basis as it stood a
         candle before, when the candle before did not, off a flat base: the 15 candles before
         it ranged (highest high to lowest low) no more than --flat % of the basis.
         `up` = how far above the basis that candle closed: what an alert at its close has
         already given away.
Entries  chase     the pop candle's close
         pullback  after it, within 20 candles and before a close under the basis: a low within
                   1% of the basis, then a green close above the basis with the basis rising
                   (TURN's touch and bounce)
Outcomes from the entry: a bar high +5% / +10% above it before a close under the basis; ride =
         hold until the first close under the basis; "failed fast" = that close comes within 5
         candles; MFE = the highest high before it.
Split    by date: in sample before --cut, out of sample from it.

Run:  python pop_study.py rows.csv.gz [--up 2] [--flat 6] [--cut 2026-10-09]
"""
import argparse, datetime, duckdb, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--up', type=float, default=2.0, help='the pop candle closes at least this %% above the basis')
ap.add_argument('--flat', type=float, default=6.0, help='the 15 candles before ranged at most this %% of the basis')
ap.add_argument('--len', type=int, default=15)
ap.add_argument('--cut', default='2026-10-09')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
UP, FLAT, MAX_GAP, HORIZON = args.up / 100, args.flat / 100, 3, 60

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
       arg_max(chg, ts) as chg, arg_max(volume, ts) as vol, list(price order by ts) as px
from t
where hour(et) * 60 + minute(et) between 240 and 1199 and isodow(et) < 6
group by all""")
days_in = con.execute(f"select count(distinct day) from bars where day < date '{CUT}'").fetchone()[0]
days_out = con.execute(f"select count(distinct day) from bars where day >= date '{CUT}'").fetchone()[0]
print(f"pop = first green 1m close ≥ {args.up:g}% above the basis (SMA {args.len}) off a base that ranged ≤ {args.flat:g}% in 15 candles | "
      f"{days_in} days in sample, {days_out} out (from {CUT})")

EV = []
FAST = []


def race(run, basis, j, entry):
    hit5 = hit10 = False
    mfe = 0.0
    for k in range(j + 1, min(len(run), j + HORIZON + 1)):
        _, _, h, l, c = run[k][:5]
        b = basis[k]
        if b is not None and c < b:
            return dict(hit5=hit5, hit10=hit10, ride=c / entry - 1, bars=k - j, mfe=mfe)
        mfe = max(mfe, h / entry - 1)
        hit5 = hit5 or h >= entry * 1.05
        hit10 = hit10 or h >= entry * 1.10
    last = run[min(len(run) - 1, j + HORIZON)][4]
    return dict(hit5=hit5, hit10=hit10, ride=last / entry - 1, bars=HORIZON, mfe=mfe)


def do_run(ticker, day, run):
    n = len(run)
    if n < 45:
        return
    closes = [r[4] for r in run]
    basis = [None] * n
    s = 0.0
    for i, c in enumerate(closes):
        s += c
        if i >= args.len:
            s -= closes[i - args.len]
        if i >= args.len - 1:
            basis[i] = s / args.len
    bv = [0.0] * n
    for i in range(1, n):
        a, b0 = run[i][6], run[i - 1][6]
        bv[i] = max(0.0, a - b0) if a is not None and b0 is not None else 0.0
    for i in range(25, n - 1):
        t, o, h, l, c, chg, _, px = run[i]
        base, base2 = basis[i - 1], basis[i - 2]
        if base is None or base2 is None:
            continue
        if run[i - 1][4] / base2 - 1 >= UP:
            continue
        rng = (max(r[2] for r in run[i - 15:i]) - min(r[3] for r in run[i - 15:i])) / base
        if rng > FLAT:
            continue
        # the fast trigger: the first ~20-second snapshot of this minute at or above the level,
        # whatever the minute goes on to do (the 1m-close pop below is the subset that held)
        j = next((k for k, p in enumerate(px) if p >= base * (1 + UP)), None)
        if j is not None:
            entry = px[j]
            rest = px[j + 1:]
            mfe0 = max(rest) / entry - 1 if rest else 0.0
            if basis[i] is not None and c < basis[i]:
                f = dict(hit5=mfe0 >= 0.05, hit10=mfe0 >= 0.10, ride=c / entry - 1, bars=0, mfe=max(0.0, mfe0))
            else:
                r = race(run, basis, i, entry)
                f = dict(hit5=r['hit5'] or mfe0 >= 0.05, hit10=r['hit10'] or mfe0 >= 0.10, ride=r['ride'], bars=r['bars'], mfe=max(r['mfe'], mfe0))
            FAST.append(dict(day=day, t=t, chg=chg, snap=j, held=c > o and c / base - 1 >= UP, close_vs=c / entry - 1, chase=f, pb=None))
        if c <= o:
            continue
        up = c / base - 1
        if up < UP:
            continue
        prev = bv[max(1, i - 20):i]
        m = sum(prev) / len(prev) if prev else 0.0
        e = dict(ticker=ticker, day=day, t=t, up=up, rng=rng, chg=chg, price=c, rvol=bv[i] / m if m > 0 else None,
                 chase=race(run, basis, i, c), pb=None, pb_vs=None, peak=None)
        # the first pullback: TURN's touch and bounce, within 20 candles, before a close under the basis
        touched, peak = False, h
        for k in range(i + 1, min(n, i + 21)):
            _, ko, kh, kl, kc = run[k][:5]
            b, pb = basis[k], basis[k - 1]
            if b is None or kc < b:
                break
            if kl <= b * 1.01:
                touched = True
            if touched and kc > ko and kc > b and pb is not None and b > pb:
                e['pb'], e['pb_vs'], e['peak'] = race(run, basis, k, kc), kc / c - 1, peak / c - 1
                e['pb_wait'] = k - i
                break
            peak = max(peak, kh)
        EV.append(e)


cur = con.execute("select ticker, day, tmin, o, h, l, c, chg, vol, px from bars order by ticker, day, tmin")
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


def line(label, evs, days):
    n = len(evs)
    if n == 0:
        return f"  {label:<30}{'—':>8}"
    ch = [e['chase'] for e in evs]
    pb = [e for e in evs if e['pb']]
    fast = 100 * sum(1 for x in ch if x['bars'] <= 5 and x['ride'] is not None and not x['hit5']) / n
    out = (f"  {label:<30}{n:>6,} {n / days:>5.1f} | {100 * sum(x['hit5'] for x in ch) / n:>5.1f}% {100 * sum(x['hit10'] for x in ch) / n:>5.1f}% "
           f"{fast:>5.1f}% {100 * statistics.fmean(x['ride'] for x in ch):>+6.2f}% {100 * med([x['mfe'] for x in ch]):>+5.1f}% |")
    if pb:
        out += (f" {100 * len(pb) / n:>4.0f}% {100 * sum(e['pb']['hit5'] for e in pb) / len(pb):>5.1f}% {100 * sum(e['pb']['hit10'] for e in pb) / len(pb):>5.1f}% "
                f"{100 * statistics.fmean(e['pb']['ride'] for e in pb):>+6.2f}% {100 * med([e['pb_vs'] for e in pb]):>+5.1f}% {med([e['pb_wait'] for e in pb]):>4.0f}")
    return out


HEAD = (f"  {'':<30}{'n':>6} {'/day':>5} | {'+5%':>6} {'+10%':>6} {'fail5':>6} {'ride':>7} {'MFE':>6} |"
        f" {'pb':>5} {'+5%':>6} {'+10%':>6} {'ride':>7} {'vs pop':>6} {'wait':>4}")


def table(title, rows):
    print(f"\n{title}\n  (left: buying the pop candle's close; right: the first pullback's bounce, where there is one)")
    for name, days, pick in (('in sample', days_in, lambda e: e['day'] < CUT), ('out of sample', days_out, lambda e: e['day'] >= CUT)):
        print(f"  {name}\n{HEAD}")
        for label, evs in rows:
            print(line(label, [e for e in evs if pick(e)], days))


table("1) By how far above the basis the pop candle closed", [
    ('all pops', EV),
    ('2% – 3%', [e for e in EV if e['up'] < 0.03]),
    ('3% – 5%', [e for e in EV if 0.03 <= e['up'] < 0.05]),
    ('5% – 8%', [e for e in EV if 0.05 <= e['up'] < 0.08]),
    ('8% and over', [e for e in EV if e['up'] >= 0.08])])
table("2) By the pop candle's volume against the 20 candles before", [
    ('under 3×', [e for e in EV if e['rvol'] is not None and e['rvol'] < 3]),
    ('3× – 10×', [e for e in EV if e['rvol'] is not None and 3 <= e['rvol'] < 10]),
    ('10× – 30×', [e for e in EV if e['rvol'] is not None and 10 <= e['rvol'] < 30]),
    ('30× and over', [e for e in EV if e['rvol'] is not None and e['rvol'] >= 30])])
table("3) By the time of day (New York)", [
    ('04:00–09:30', [e for e in EV if e['t'] < 570]),
    ('09:30–11:00', [e for e in EV if 570 <= e['t'] < 660]),
    ('11:00–16:00', [e for e in EV if 660 <= e['t'] < 960]),
    ('16:00–20:00', [e for e in EV if e['t'] >= 960])])
table("4) By the day's change at the pop, and by how flat the base was", [
    ('day change under +30%', [e for e in EV if e['chg'] is not None and e['chg'] < 30]),
    ('+30% – +60%', [e for e in EV if e['chg'] is not None and 30 <= e['chg'] < 60]),
    ('+60% and over', [e for e in EV if e['chg'] is not None and e['chg'] >= 60]),
    ('base ranged under 2%', [e for e in EV if e['rng'] < 0.02]),
    ('base ranged 2% – 4%', [e for e in EV if 0.02 <= e['rng'] < 0.04]),
    ('base ranged 4% – 6%', [e for e in EV if e['rng'] >= 0.04])])

table(f"6) A faster trigger: the first ~20-second snapshot at {args.up:g}% above the basis, against waiting for the 1m close", [
    ('snapshot trigger, all', FAST),
    ('…the minute then closed as a pop', [e for e in FAST if e['held']]),
    ('…the minute did not hold', [e for e in FAST if not e['held']]),
    ('1m-close trigger (table 1)', EV)])
for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
    f = [e for e in FAST if pick(e)]
    held = [e for e in f if e['held']]
    print(f"  {name}: {len(held):,} of {len(f):,} snapshot triggers ({100 * len(held) / len(f):.0f}%) are followed by a 1m close that holds the level; "
          f"where it holds, the minute closes a median {100 * med([e['close_vs'] for e in held]):+.1f}% above the snapshot price "
          f"(what the 1m-close trigger pays for waiting); over all triggers the minute closes a median {100 * med([e['close_vs'] for e in f]):+.1f}% from it")

print("\n5) What the first pullback looks like when it comes (all pops with one)")
for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
    pb = [e for e in EV if pick(e) and e['pb']]
    al = [e for e in EV if pick(e)]
    never = [e for e in al if not e['pb']]
    ran = [e for e in never if e['chase']['hit5']]
    print(f"  {name}: {len(pb):,} of {len(al):,} pops give a pullback bounce ({100 * len(pb) / len(al):.0f}%), a median {med([e['pb_wait'] for e in pb]):.0f} candles later; "
          f"by then the price had peaked a median {100 * med([e['peak'] for e in pb]):+.1f}% above the pop close, and the bounce entry is a median "
          f"{100 * med([e['pb_vs'] for e in pb]):+.1f}% against it ({100 * sum(1 for e in pb if e['pb_vs'] < 0) / len(pb):.0f}% of them cheaper than the pop close). "
          f"Of the {len(never):,} without one, {len(ran):,} ({100 * len(ran) / len(never):.0f}%) went +5% from the pop close anyway.")
