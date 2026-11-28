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
Exits    a bracket from the entry, three pairs: take-profit +5 / stop −5, +10 / −5, +20 / −10;
         whichever a later candle reaches first (both in one candle = the stop); neither within 60
         candles = that candle's close. On the candle the buy stop fills, a close at or under the
         stop level counts as stopped. The stop is taken to fill at its level.
Costs    none taken off in tables 1–5 (commissions and the spread come on top); tables 6–10 show
         dollars with and without --cost % of the trade value a side.
Tables   6–10 play the operator's automation, as they specified it on 11-28: POPs that alert
         (volume 10×+), 04:00–05:00 New York, a buy stop 5% above the alert, take-profit +20%,
         stop −10%, 5 positions of $400 a day, one per ticker.
Split    by date: in sample before --cut, out of sample from it.

Run:  python pop_entry_study.py rows.csv.gz [--up 10] [--valid 5] [--cut 2026-10-09]
"""
import argparse, datetime, duckdb, statistics, sys

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--up', type=float, default=10.0)
ap.add_argument('--valid', type=int, default=5, help='the buy stop is good for N candles after the POP candle')
ap.add_argument('--gap', type=float, default=2.0, help='no fill when a candle opens more than this %% above the stop level')
ap.add_argument('--amount', type=float, default=400.0, help='dollars a trade, for the automation table')
ap.add_argument('--slots', type=int, default=5, help='positions a day, for the automation table')
ap.add_argument('--cost', type=float, default=1.0, help='commission, %% of the trade value a side, for the automation table')
ap.add_argument('--gain', type=float, default=10.0)
ap.add_argument('--len', type=int, default=15)
ap.add_argument('--cut', default='2026-10-09')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
MAX_GAP, HORIZON = 3, 60
OFFSETS = [0.0, 1.0, 2.0, 3.0, 5.0, 8.0]
PAIRS = [(5.0, 5.0), (10.0, 5.0), (20.0, 10.0)]   # (take-profit %, stop %) from the entry

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
print(f"POP = a run's high ≥ {args.up:g}% above the basis (SMA {args.len}) | buy stop good for {args.valid} candles | "
      f"{days_in} days in sample, {days_out} out (from {CUT})")

POPS = []


def bracket(run, j, entry, tp_pct, sl_pct, same_bar_close=None):
    """The bracket's result in % of the entry, from the candle after j."""
    stop, tp = entry * (1 - sl_pct / 100), entry * (1 + tp_pct / 100)
    if same_bar_close is not None and same_bar_close <= stop:
        return -sl_pct, 'stop'
    for k in range(j + 1, min(len(run), j + HORIZON + 1)):
        _, _, h, l, c = run[k][:5]
        if l <= stop:
            return -sl_pct, 'stop'
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
                                 out={p: bracket(run, j, px, p[0], p[1], same) for p in PAIRS})
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


def line(label, evs, off, pair):
    n = len(evs)
    if n == 0:
        return f"  {label:<24}{'—':>7}"
    got = [e['res'][off] for e in evs if isinstance(e['res'][off], dict)]
    gapped = sum(1 for e in evs if e['res'][off] == 'gapped')
    if not got:
        return f"  {label:<24}{n:>6,} {0:>5.0f}%"
    outs = [g['out'][pair] for g in got]
    pnl = [o[0] for o in outs]
    return (f"  {label:<24}{n:>6,} {100 * len(got) / n:>5.0f}% {100 * gapped / n:>4.0f}% | "
            f"{100 * sum(o[1] == 'tp' for o in outs) / len(got):>5.1f}% {100 * sum(o[1] == 'stop' for o in outs) / len(got):>5.1f}% "
            f"{statistics.fmean(pnl):>+6.2f}% {statistics.median(pnl):>+6.2f}% | {statistics.fmean(pnl) * len(got) / n:>+6.2f}% "
            f"{statistics.fmean(g['vs_alert'] for g in got):>+5.1f}%")


HEAD = (f"  {'':<24}{'POPs':>6} {'fill':>6} {'gap':>5} | {'TP':>6} {'stop':>6} {'avg':>7} {'median':>7} | {'/alert':>7} {'paid':>6}")


def table(title, pick_evs, pair):
    print(f"\n{title} — take-profit +{pair[0]:g}%, stop −{pair[1]:g}%")
    for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
        evs = [e for e in pick_evs if pick(e)]
        print(f"  {name}\n{HEAD}")
        for off in OFFSETS:
            print(line('at the alert price' if off == 0 else f'buy stop +{off:g}%', evs, off, pair))


print("\n(fill = the share of POPs the order fills on; gap = opened too far above the level; TP / stop = which came first, of the filled;"
      " avg / median = the result per filled trade; /alert = per POP alert; paid = the entry against the alert's price)")
STRONG = [e for e in POPS if e['rv'] is not None and e['rv'] >= 10]
for pair in PAIRS:
    table("1) Every POP", POPS, pair)
for pair in PAIRS:
    table("2) POPs with a volume reading of 10× and over (the ones that alert)", STRONG, pair)
table("3) Every POP, 04:00–05:00 New York", [e for e in POPS if e['t'] < 300], (20.0, 10.0))
table("4) Every POP, 04:00–09:30", [e for e in POPS if e['t'] < 570], (20.0, 10.0))
table("5) Every POP, 09:30–11:00", [e for e in POPS if 570 <= e['t'] < 660], (20.0, 10.0))

def automation(title, evs, off, pair, strong_only):
    """The operator's automation as specified: the day's POPs in order, a buy stop `off` % above the
    alert, the bracket `pair`, at most --slots filled positions a day, one per ticker a day, --amount
    dollars each. A day's result in dollars, before and after --cost % a side."""
    pool = [e for e in evs if not strong_only or (e['rv'] is not None and e['rv'] >= 10)]
    by_day = {}
    for e in sorted(pool, key=lambda e: (e['day'], e['t'])):
        by_day.setdefault(e['day'], []).append(e)
    print(f"\n{title}")
    for name, days, pick in (('in sample', days_in, lambda d: d < CUT), ('out of sample', days_out, lambda d: d >= CUT)):
        day_pnl, trades, wins, stops = [], 0, 0, 0
        for d, es in by_day.items():
            if not pick(d):
                continue
            seen, filled, pnl = set(), 0, 0.0
            for e in es:
                if filled >= args.slots or e['ticker'] in seen:
                    continue
                r = e['res'][off]
                if not isinstance(r, dict):
                    continue
                seen.add(e['ticker'])
                filled += 1
                pct, how = r['out'][pair]
                pnl += args.amount * pct / 100
                wins += how == 'tp'
                stops += how == 'stop'
            if filled:
                day_pnl.append((pnl, filled))
                trades += filled
        if not trades:
            print(f"  {name}: no trades")
            continue
        gross = sum(p for p, _ in day_pnl)
        cost = trades * args.amount * 2 * args.cost / 100
        print(f"  {name}: {len(day_pnl)} of {days} days had a trade, {trades} trades ({trades / days:.1f} a day), take-profit first {100 * wins / trades:.0f}%, stop first {100 * stops / trades:.0f}% | "
              f"per trade {gross / trades:+.2f} $ before costs, {(gross - cost) / trades:+.2f} $ after {args.cost:g}% a side | "
              f"whole period {gross:+,.0f} $ before, {gross - cost:+,.0f} $ after | worst day {min(p for p, _ in day_pnl):+,.0f} $, best {max(p for p, _ in day_pnl):+,.0f} $")


AUTO = (20.0, 10.0)
automation(f"6) The automation as specified: POPs that alert (volume 10×+), 04:00–05:00 New York, buy stop +5%, take-profit +20%, stop −10%, {args.slots} × ${args.amount:g} a day",
           [e for e in POPS if e['t'] < 300], 5.0, AUTO, True)
automation("7) …the same rule on every POP of that hour (strong or not)", [e for e in POPS if e['t'] < 300], 5.0, AUTO, False)
automation("8) …the same rule, POPs that alert, the whole day (a bigger sample of the same trade)", POPS, 5.0, AUTO, True)
automation("9) …the whole day, bought at the alert's price instead", POPS, 0.0, AUTO, True)
automation("10) …the whole day, buy stop +5%, take-profit +10%, stop −5%", POPS, 5.0, (10.0, 5.0), True)

print("\n11) After the POP candle: how far the price got above the alert's price within the valid candles, and how fast")
for name, pick in (('in sample', lambda e: e['day'] < CUT), ('out of sample', lambda e: e['day'] >= CUT)):
    evs = [e for e in POPS if pick(e)]
    parts = []
    for off in OFFSETS[1:]:
        got = [e['res'][off] for e in evs if isinstance(e['res'][off], dict)]
        parts.append(f"+{off:g}%: {100 * len(got) / len(evs):.0f}% (median {statistics.median(g['wait'] for g in got):.0f} candle{'s' if statistics.median(g['wait'] for g in got) != 1 else ''})" if got else f"+{off:g}%: 0%")
    print(f"  {name}: " + " · ".join(parts))
