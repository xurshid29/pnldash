"""How to buy a POP: at the alert's price, or with a buy stop above it? (2026-11-27)

The operator, after the first live morning (four paper trades off POP / BACK alerts, bought at the
alert through the bridge): "TPs were at the 10%, and price moved too quickly and jumped over the
TP but [didn't] fill it, and dropped down … TRUG, TGHL POPs couldn't move, dropped almost at the
price where POP fired … Maybe, we should place them with offset, for example, 3% (or bigger
percentage) from the alert price? Because, if price's intention is going up, we will catch it,
if not, we just don't buy it".

Data     as pop_back_study.py: Momentum rows → 1m bars from ~20-second snapshots, runs split
         where a name is off our screen for over 3 minutes; the POP of script v49 (a run's high
         10% above the basis; the volume reading = the biggest of the POP candle and the two
         before it against the 20 candles before those).
Entries  now      the POP candle's close (the alert's price)
         stop x   a buy stop x % above that close, good for --valid candles after the POP candle:
                  filled at the level on the first candle whose high reaches it, or at that
                  candle's open when it opens above the level (not filled when it opens more than
                  --gap % above the level: a stop-limit's limit)
Exits    a bracket from the entry: take-profit +T %, stop −S %; whichever a later candle reaches
         first (both in one candle = the stop); neither within 60 candles = that candle's close.
         On the candle the buy stop fills, a close at or under the stop level counts as stopped.
Costs    none taken off (commissions and the spread come on top).
Split    by date: in sample before --cut, out of sample from it.

Run:  python pop_entry_study.py rows.csv.gz [--up 10] [--valid 5] [--stop 5] [--cut 2026-10-09]
"""
import argparse, datetime, duckdb, statistics, sys

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--up', type=float, default=10.0)
ap.add_argument('--valid', type=int, default=5, help='the buy stop is good for N candles after the POP candle')
ap.add_argument('--gap', type=float, default=2.0, help='no fill when a candle opens more than this %% above the stop level')
ap.add_argument('--stop', type=float, default=5.0, help='the bracket stop, %% under the entry')
ap.add_argument('--gain', type=float, default=10.0)
ap.add_argument('--len', type=int, default=15)
ap.add_argument('--cut', default='2026-10-09')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
MAX_GAP, HORIZON = 3, 60
OFFSETS = [0.0, 1.0, 2.0, 3.0, 5.0, 8.0]
TPS = [5.0, 10.0, 20.0]

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
print(f"POP = a run's high ≥ {args.up:g}% above the basis (SMA {args.len}) | buy stop good for {args.valid} candles, bracket stop −{args.stop:g}% | "
      f"{days_in} days in sample, {days_out} out (from {CUT})")

POPS = []


def bracket(run, j, entry, tp_pct, same_bar_close=None):
    """The bracket's result in % of the entry, from the candle after j."""
    stop, tp = entry * (1 - args.stop / 100), entry * (1 + tp_pct / 100)
    if same_bar_close is not None and same_bar_close <= stop:
        return -args.stop, 'stop'
    for k in range(j + 1, min(len(run), j + HORIZON + 1)):
        _, _, h, l, c = run[k][:5]
        if l <= stop:
            return -args.stop, 'stop'
        if h >= tp:
            return tp_pct, 'tp'
    last = run[min(len(run) - 1, j + HORIZON)][4]
    return (last / entry - 1) * 100, 'time'


def do_run(ticker, day, run):
    n = len(run)
    if n < args.len + 2:
        return
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
    inrun = popped = False
    ran = 0.0
    for i in range(args.len, n):
        t, o, h, l, c, chg, _ = run[i]
        b, pb = basis[i], basis[i - 1]
        if inrun and c < b:
            inrun = False
        elif not inrun and c > b and closes[i - 1] <= pb:
            inrun, popped, ran = True, False, 0.0
        if not inrun:
            continue
        ran = max(ran, (h / b - 1) * 100)
        if popped or ran < args.up:
            continue
        popped = True
        if chg is None or chg < args.gain or i + 2 >= n:
            continue
        prev = bv[i - 22:i - 2] if i >= 23 else None
        m = sum(prev) / 20 if prev else None
        top3 = max(bv[i - 2:i + 1])
        rv = (top3 / m if m > 0 else (999.0 if top3 > 0 else None)) if m is not None else None
        e = dict(ticker=ticker, day=day, t=t, price=c, rv=rv, res={})
        for off in OFFSETS:
            if off == 0.0:
                fill = (i, c, None)
            else:
                level, fill = c * (1 + off / 100), None
                for k in range(i + 1, min(n, i + args.valid + 1)):
                    ko, kh, kc = run[k][1], run[k][2], run[k][4]
                    if kh >= level:
                        px = max(level, ko)
                        fill = (k, px, kc) if px <= level * (1 + args.gap / 100) else 'gapped'
                        break
            if fill is None or fill == 'gapped':
                e['res'][off] = fill
                continue
            j, px, same = fill
            e['res'][off] = dict(wait=j - i, entry=px, vs_alert=(px / c - 1) * 100,
                                 out={tp: bracket(run, j, px, tp, same) for tp in TPS})
        POPS.append(e)


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


def line(label, evs, off, tp):
    n = len(evs)
    if n == 0:
        return f"  {label:<24}{'—':>7}"
    got = [e['res'][off] for e in evs if isinstance(e['res'][off], dict)]
    gapped = sum(1 for e in evs if e['res'][off] == 'gapped')
    if not got:
        return f"  {label:<24}{n:>6,} {0:>5.0f}%"
    outs = [g['out'][tp] for g in got]
    pnl = [o[0] for o in outs]
    return (f"  {label:<24}{n:>6,} {100 * len(got) / n:>5.0f}% {100 * gapped / n:>4.0f}% | "
            f"{100 * sum(o[1] == 'tp' for o in outs) / len(got):>5.1f}% {100 * sum(o[1] == 'stop' for o in outs) / len(got):>5.1f}% "
            f"{statistics.fmean(pnl):>+6.2f}% {statistics.median(pnl):>+6.2f}% | {statistics.fmean(pnl) * len(got) / n:>+6.2f}% "
            f"{statistics.fmean(g['vs_alert'] for g in got):>+5.1f}%")


HEAD = (f"  {'':<24}{'POPs':>6} {'fill':>6} {'gap':>5} | {'TP':>6} {'stop':>6} {'avg':>7} {'median':>7} | {'/alert':>7} {'paid':>6}")


def table(title, pick_evs, tp):
    print(f"\n{title} — take-profit +{tp:g}%, stop −{args.stop:g}%")
    print("  (fill = the share of POPs the order fills on; gap = opened too far above the level; TP / stop = which came first, of the filled;"
          " avg / median = the result per filled trade; /alert = per POP alert; paid = the entry against the alert's price)")
    for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
        evs = [e for e in pick_evs if pick(e)]
        print(f"  {name}\n{HEAD}")
        for off in OFFSETS:
            print(line('at the alert price' if off == 0 else f'buy stop +{off:g}%', evs, off, tp))


STRONG = [e for e in POPS if e['rv'] is not None and e['rv'] >= 10]
for tp in TPS:
    table("1) Every POP", POPS, tp)
for tp in TPS:
    table("2) POPs with a volume reading of 10× and over (the ones that alert)", STRONG, tp)
table("3) Every POP, 04:00–09:30 New York", [e for e in POPS if e['t'] < 570], 10.0)
table("4) Every POP, 09:30–11:00", [e for e in POPS if 570 <= e['t'] < 660], 10.0)

print("\n5) After the POP candle: how far the price got above the alert's price within the valid candles, and how fast")
for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
    evs = [e for e in POPS if pick(e)]
    parts = []
    for off in OFFSETS[1:]:
        got = [e['res'][off] for e in evs if isinstance(e['res'][off], dict)]
        parts.append(f"+{off:g}%: {100 * len(got) / len(evs):.0f}% (median {statistics.median(g['wait'] for g in got):.0f} candle{'s' if statistics.median(g['wait'] for g in got) != 1 else ''})" if got else f"+{off:g}%: 0%")
    print(f"  {name}: " + " · ".join(parts))
