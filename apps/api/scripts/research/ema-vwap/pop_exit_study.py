"""Which exit for a POP bought with the waiting buy? (2026-11-28)

The operator, the day the POP automation was built (a buy stop 5% above a yellow POP's alert,
take-profit +20%, stop −10%): "not 20% but maybe we do some calculations? Because, there can be
some problems with the fixed 20%, price can move up to 10-15% but still end up with -10%
stop-loss … and also, we can miss such great moves by taking only 20% and ignore the rest".
And: "regarding the price range, maybe we ignore below $0.5?"

Data     as pop_entry_study.py: Momentum rows → 1m bars from ~20-second snapshots, runs split
         where a name is off our screen for over 3 minutes; the POP of script v49 with its volume
         reading. Only the yellow POPs (a reading of --volmin and over), and of those the first
         one of a ticker's day that the buy fills on: the automation's one trade per ticker a day.
Entry    the automation's: a buy stop --off % above the POP candle's close, good for --valid
         candles; filled at the level on the first candle whose high reaches it, or at that
         candle's open when it opens above the level (not filled when that open is more than
         --gap % above the level: the stop-limit's limit).
Exits    every rule starts with a stop --sl % under the entry. Then, per rule: a take-profit; the
         stop moved up once the price has gained so much ("lock"); a stop that trails the highest
         price by a percentage, from the start or once so much is gained; half sold at a first
         target and the rest left to another rule; out at the close of the first candle that
         closes under the POP's own basis (the run's end, as the script defines a run).
         A trade lasts until its rule ends it or our bars of that name end (it left the screen,
         or the day ended at 20:00): then the last price seen is taken ("end").
Candles  inside one candle the order of its high and low is not known, so the stop that stood
         before the candle is asked first (a candle that opens under it sells at the open), then
         the targets, and only then is the stop raised from that candle's high: the careful order.
         On the candle the buy fills, a close at or under the stop counts as stopped.
Fills    a target fills at its price. A stop, moved or not, fills --slip % under its level (the
         first live stop of this trade sold 2.4% under it).
Costs    "net" takes off IBKR's fixed commission for --amount dollars a trade: $0.005 a share,
         at least $1 and at most 1% of the trade's value, per order. Nothing for the spread.
Split    by date: in sample before --cut, out of sample from it.
Caution  these are POPs on names that were already on the Momentum screen, all day long. The
         automation's own hour (04:00–05:00 New York) has only a handful of them in these bars,
         and a pop out of a stock that was not yet moving is not in them at all.

Run:  python pop_exit_study.py rows.csv.gz [--off 5] [--sl 10] [--slip 1] [--cut 2026-10-09]
"""
import argparse, datetime, duckdb, statistics, sys

sys.dont_write_bytecode = True
ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--up', type=float, default=10.0)
ap.add_argument('--len', type=int, default=15)
ap.add_argument('--gain', type=float, default=10.0)
ap.add_argument('--volmin', type=float, default=10.0, help='the POP volume reading a yellow POP needs')
ap.add_argument('--off', type=float, default=5.0, help='the buy stop, %% above the alert')
ap.add_argument('--valid', type=int, default=5, help='the buy stop is good for N candles after the POP candle')
ap.add_argument('--gap', type=float, default=1.0, help='no fill when a candle opens more than this %% above the stop level')
ap.add_argument('--sl', type=float, default=10.0, help='the stop every rule starts with, %% under the entry')
ap.add_argument('--slip', type=float, default=1.0, help='a stop fills this %% under its level')
ap.add_argument('--amount', type=float, default=400.0)
ap.add_argument('--cut', default='2026-10-09')
args = ap.parse_args()
CUT = datetime.date.fromisoformat(args.cut)
MAX_GAP = 3

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
HAVE = {r[0] for r in con.execute("describe raw").fetchall()}
num = lambda col: f"try_cast({col} as double)" if col in HAVE else "cast(null as double)"
con.execute(f"""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(change_pct as double) as chg,
         try_cast(volume as double) as volume, timezone('America/New_York', to_timestamp(ts)) as et,
         {num('rel_vol_1min')} as rv1
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(chg, ts) as chg, arg_max(volume, ts) as vol, max(rv1) as rv1
from t
where hour(et) * 60 + minute(et) between 240 and 1199 and isodow(et) < 6
group by all""")
days_in = con.execute(f"select count(distinct day) from bars where day < date '{CUT}'").fetchone()[0]
days_out = con.execute(f"select count(distinct day) from bars where day >= date '{CUT}'").fetchone()[0]

TRADES = []
SEEN = set()        # (ticker, day): one trade per ticker a day
POPS_YELLOW = 0     # yellow POPs before the fill and the one-a-day rule


def do_run(ticker, day, run):
    global POPS_YELLOW
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
        t, o, h, l, c, chg = run[i][:6]
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
        if rv is None or rv < args.volmin:
            continue
        POPS_YELLOW += 1
        if (ticker, day) in SEEN:
            continue
        level, fill = c * (1 + args.off / 100), None
        for k in range(i + 1, min(n, i + args.valid + 1)):
            ko, kh, kc = run[k][1], run[k][2], run[k][4]
            if kh >= level:
                px = max(level, ko)
                if px <= level * (1 + args.gap / 100):
                    fill = (k, px, kc)
                break
        if fill is None:
            continue
        SEEN.add((ticker, day))
        j, px, same = fill
        TRADES.append(dict(ticker=ticker, day=day, t=t, tfill=run[j][0], alert=c, E=px, same=same, rv=rv, rv1=run[i][7],
                           path=[(run[k][1], run[k][2], run[k][3], run[k][4], basis[k]) for k in range(j + 1, n)]))


cur = con.execute("select ticker, day, tmin, o, h, l, c, chg, vol, rv1 from bars order by ticker, day, tmin")
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


def play(tr, tp=None, lock=(), trail=None, basis=None, half=None, rest_tp=None, hard=False):
    """One trade under one exit rule → (result in % of the entry, how it ended, candles held, [fractions sold]).

    tp       a take-profit, % above the entry, for the whole position (or what is left of it)
    lock     pairs (gained %, stop to % above the entry): once the high has gained the first, the stop is at least the second
    trail    (from a gain of %, trail %): the stop is at least that far under the highest price
    basis    from a gain of this %, out at the close of a candle that closes under the POP's basis
    half     half is sold at this % above the entry; the other half goes on under the rest of the rule
    rest_tp  the take-profit of that other half (after `half` has sold)
    hard     the worst order inside a candle for a stop that moves: the candle made its high first
             (which raised the stop) and its low after it, so a low at or under the raised stop
             sells there, in that same candle. Without it such a candle only raises the stop, and
             the next candle is asked: the two are the bounds of what one-minute candles can say.
    """
    E, sl = tr['E'], args.sl
    stop = E * (1 - sl / 100)
    if tr['same'] <= stop:
        return -sl - args.slip, 'stop', 0, [1.0]
    hi, size, banked, sold = E, 1.0, 0.0, []
    for held, (o, h, l, c, b) in enumerate(tr['path'], 1):
        if l <= stop:
            px = min(stop, o) * (1 - args.slip / 100)
            return banked + size * (px / E - 1) * 100, ('stop' if stop < E * 0.9999 else 'moved stop'), held, sold + [size]
        if half is not None and size == 1.0 and h >= E * (1 + half / 100):
            banked, size = 0.5 * half, 0.5
            sold.append(0.5)
        target = rest_tp if (half is not None and size < 1.0) else tp
        if target is not None and h >= E * (1 + target / 100):
            return banked + size * target, 'take-profit', held, sold + [size]
        hi = max(hi, h)
        gained = (hi / E - 1) * 100
        before = stop
        for at, to in lock:
            if gained >= at:
                stop = max(stop, E * (1 + to / 100))
        if trail is not None and gained >= trail[0]:
            stop = max(stop, hi * (1 - trail[1] / 100))
        if hard and stop > before and l <= stop:
            px = stop * (1 - args.slip / 100)
            return banked + size * (px / E - 1) * 100, ('stop' if stop < E * 0.9999 else 'moved stop'), held, sold + [size]
        if basis is not None and gained >= basis and b is not None and c < b:
            return banked + size * (c / E - 1) * 100, 'under basis', held, sold + [size]
    last = tr['path'][-1][3] if tr['path'] else tr['same']
    return banked + size * (last / E - 1) * 100, 'end', len(tr['path']), sold + [size]


def commission_pct(E, sells):
    """IBKR fixed, in % of --amount: the buy and each sell order; $0.005 a share, min $1, max 1% of the order's value."""
    def one(value):
        return min(max(1.0, 0.005 * value / E), 0.01 * value) if value > 0 else 0.0
    return 100 * (one(args.amount) + sum(one(args.amount * f) for f in sells)) / args.amount


IN = [t for t in TRADES if t['day'] < CUT]
OUT = [t for t in TRADES if t['day'] >= CUT]
print(f"Yellow POPs (volume {args.volmin:g}×+): {POPS_YELLOW:,} in {days_in + days_out} days. The buy stop +{args.off:g}% filled, first of the "
      f"ticker's day: {len(TRADES):,} trades ({len(IN):,} in sample, {days_in} days; {len(OUT):,} out of sample from {CUT}, {days_out} days). "
      f"Every rule starts with a stop −{args.sl:g}%; a stop fills {args.slip:g}% under its level.")


def stats(trades, **rule):
    if not trades:
        return None
    res = [play(t, **rule) for t in trades]
    pct = [r[0] for r in res]
    net = [r[0] - commission_pct(t['E'], r[3]) for t, r in zip(trades, res)]
    how = {}
    for r in res:
        how[r[1]] = how.get(r[1], 0) + 1
    return dict(n=len(res), avg=statistics.fmean(pct), med=statistics.median(pct), win=100 * sum(p > 0 for p in pct) / len(pct),
                net=statistics.fmean(net), held=statistics.median(r[2] for r in res), how=how,
                best=max(pct), big=100 * sum(p >= 30 for p in pct) / len(pct))


def cell(s):
    if s is None:
        return f"{'—':>44}"
    return f"{s['n']:>5} {s['avg']:>+6.2f}% {s['med']:>+6.1f}% {s['win']:>4.0f}% {s['net']:>+6.2f}% {args.amount * s['net'] / 100:>+6.2f}$ {s['held']:>4.0f}"


HEAD = f"{'trades':>6} {'avg':>7} {'median':>7} {'win':>5} {'net':>7} {'net $':>7} {'min':>4}"


def show(title, rules, trades_in=IN, trades_out=OUT):
    print(f"\n{title}")
    print(f"  {'':<46}| {'in sample':^44} | {'out of sample':^44}")
    print(f"  {'':<46}| {HEAD} | {HEAD}")
    for label, rule in rules:
        print(f"  {label:<46}| {cell(stats(trades_in, **rule))} | {cell(stats(trades_out, **rule))}")


print("\n(avg / median = the result per trade before commission, in % of the entry; win = trades that ended above the entry;"
      " net = avg after commission; net $ = that on a trade; min = the median minutes held)")

# ---------------------------------------------------------------- 0: how far do they go
print(f"\n0) How far a trade goes before it ends, with only the stop −{args.sl:g}% standing (no take-profit): the highest gain it reached")
EDGES = [0, 5, 10, 15, 20, 30, 50, 100, 1e9]
for name, trades in (('in sample', IN), ('out of sample', OUT)):
    rows = []
    for t in trades:
        E = t['E']
        stop = E * (1 - args.sl / 100)
        if t['same'] <= stop:
            rows.append((0.0, True))
            continue
        hi, stopped = E, False
        for o, h, l, c, b in t['path']:
            if l <= stop:
                stopped = True
                break
            hi = max(hi, h)
        rows.append(((hi / E - 1) * 100, stopped))
    if not rows:
        continue
    print(f"  {name}: {len(rows)} trades")
    print(f"    {'highest gain reached':<24}{'trades':>7} {'share':>6} {'then stopped out':>17} {'reached at least':>17}")
    for lo, hi_ in zip(EDGES, EDGES[1:]):
        b = [r for r in rows if lo <= r[0] < hi_]
        atleast = 100 * sum(1 for r in rows if r[0] >= lo) / len(rows)
        label = f"{lo:g}% to {hi_:g}%" if hi_ < 1e9 else f"{lo:g}% and more"
        if b:
            print(f"    {label:<24}{len(b):>7} {100 * len(b) / len(rows):>5.0f}% {100 * sum(r[1] for r in b) / len(b):>16.0f}% {atleast:>16.0f}%")

# ---------------------------------------------------------------- 1: fixed take-profits
show(f"1) A fixed take-profit, stop −{args.sl:g}%",
     [(f"take-profit +{x:g}%", dict(tp=x)) for x in (5, 10, 15, 20, 30, 50, 100)] + [("no take-profit (the stop, or the bars' end)", dict())])

# ---------------------------------------------------------------- 2: the stop moved up
show("2) Take-profit +20%, and the stop moved up once the price has gained",
     [("as built (nothing moved)", dict(tp=20)),
      ("+5%: stop to the entry", dict(tp=20, lock=[(5, 0)])),
      ("+10%: stop to the entry", dict(tp=20, lock=[(10, 0)])),
      ("+10%: stop to +3%", dict(tp=20, lock=[(10, 3)])),
      ("+10%: stop to +5%", dict(tp=20, lock=[(10, 5)])),
      ("+15%: stop to +5%", dict(tp=20, lock=[(15, 5)])),
      ("+15%: stop to +10%", dict(tp=20, lock=[(15, 10)])),
      ("+10%: to the entry, +15%: to +8%", dict(tp=20, lock=[(10, 0), (15, 8)]))])

# ---------------------------------------------------------------- 3: trailing
show("3) No take-profit: a stop that trails the highest price",
     [(f"trail {x:g}% from the start", dict(trail=(0, x))) for x in (10, 15, 20, 25, 30)]
     + [(f"trail {x:g}% once +10% is gained", dict(trail=(10, x))) for x in (10, 15, 20)]
     + [(f"trail {x:g}% once +20% is gained", dict(trail=(20, x))) for x in (10, 15, 20)]
     + [("+10%: stop to the entry, then trail 15%", dict(lock=[(10, 0)], trail=(10, 15))),
        ("+10%: stop to the entry, then trail 20%", dict(lock=[(10, 0)], trail=(10, 20)))])

# ---------------------------------------------------------------- 4: the run's end
show("4) No take-profit: out when a candle closes under the POP's basis (SMA 15 of 1m closes: the run's end)",
     [("from the start", dict(basis=0)),
      ("once +10% is gained", dict(basis=10)),
      ("once +20% is gained", dict(basis=20)),
      ("+10%: stop to the entry; under the basis", dict(basis=0, lock=[(10, 0)])),
      ("once +10%, and trail 20% too", dict(basis=10, trail=(10, 20)))])

# ---------------------------------------------------------------- 5: half and half
show("5) Half sold at a first target, the other half left to run",
     [("half +10%, rest +20%", dict(half=10, rest_tp=20)),
      ("half +10%, rest +30%, stop to the entry", dict(half=10, rest_tp=30, lock=[(10, 0)])),
      ("half +10%, rest trails 15%, stop to entry", dict(half=10, lock=[(10, 0)], trail=(10, 15))),
      ("half +10%, rest trails 20%, stop to entry", dict(half=10, lock=[(10, 0)], trail=(10, 20))),
      ("half +20%, rest trails 15%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 15))),
      ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20))),
      ("half +20%, rest under the basis, stop to entry", dict(half=20, lock=[(20, 0)], basis=20)),
      ("half +10%, rest under the basis, stop to entry", dict(half=10, lock=[(10, 0)], basis=10))])

# ---------------------------------------------------------------- 6: how the rules end
print("\n6) How the trades of a rule end (all trades, both halves), and its best trade")
PICKS = [("take-profit +20% (as built)", dict(tp=20)),
         ("take-profit +20%, +10%: stop to the entry", dict(tp=20, lock=[(10, 0)])),
         ("trail 20% from the start", dict(trail=(0, 20))),
         ("trail 15% once +10% is gained", dict(trail=(10, 15))),
         ("under the basis, once +10%", dict(basis=10)),
         ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20)))]
for label, rule in PICKS:
    s = stats(TRADES, **rule)
    if s:
        ends = ', '.join(f"{k} {100 * v / s['n']:.0f}%" for k, v in sorted(s['how'].items(), key=lambda kv: -kv[1]))
        print(f"  {label:<46}| {ends} | trades that made +30% or more {s['big']:.0f}% | best {s['best']:+.0f}%")

# ---------------------------------------------------------------- 7: by price
print(f"\n7) By the price paid (all trades, both halves): the commission on ${args.amount:g}, and three rules")
print(f"  {'price':<16}{'trades':>7} {'commission':>11} | {'TP +20%: avg':>13} {'net':>7} | {'TP +20%, +10% → entry: avg':>27} {'net':>7} | {'trail 20%: avg':>15} {'net':>7}")
for lo, hi_ in ((0, 0.25), (0.25, 0.5), (0.5, 1), (1, 2), (2, 5), (5, 1e9)):
    b = [t for t in TRADES if lo <= t['E'] < hi_]
    if not b:
        continue
    label = f"${lo:g} to ${hi_:g}" if hi_ < 1e9 else f"${lo:g} and over"
    fee = statistics.fmean(commission_pct(t['E'], [1.0]) for t in b)
    a, l2, tr_ = stats(b, tp=20), stats(b, tp=20, lock=[(10, 0)]), stats(b, trail=(0, 20))
    print(f"  {label:<16}{len(b):>7} {fee:>10.2f}% | {a['avg']:>+12.2f}% {a['net']:>+6.2f}% | {l2['avg']:>+26.2f}% {l2['net']:>+6.2f}% | {tr_['avg']:>+14.2f}% {tr_['net']:>+6.2f}%")
for name, pick in (("under $0.50", lambda t: t['E'] < 0.5), ("$0.50 and over", lambda t: t['E'] >= 0.5)):
    for sname, trades in (('in sample', IN), ('out of sample', OUT)):
        b = [t for t in trades if pick(t)]
        a, l2 = stats(b, tp=20), stats(b, tp=20, lock=[(10, 0)])
        if a:
            print(f"  {name + ', ' + sname:<32}{a['n']:>5} trades | TP +20%: avg {a['avg']:+.2f}%, net {a['net']:+.2f}% | with +10% → entry: avg {l2['avg']:+.2f}%, net {l2['net']:+.2f}%")

# ---------------------------------------------------------------- 8: by hour, and by the stock's RVol
print("\n8) By the hour of the alert (New York), both halves: the rule as built against two others")
for label, lo, hi_ in (("04:00–05:00 (its hour)", 240, 300), ("05:00–09:30", 300, 570), ("09:30–11:00", 570, 660), ("11:00–16:00", 660, 960), ("16:00–20:00", 960, 1200)):
    b = [t for t in TRADES if lo <= t['t'] < hi_]
    a, l2, tr_ = stats(b, tp=20), stats(b, tp=20, lock=[(10, 0)]), stats(b, trail=(0, 20))
    if a:
        print(f"  {label:<24}{a['n']:>5} trades | TP +20%: {a['avg']:+.2f}% (net {a['net']:+.2f}%) | with +10% → entry: {l2['avg']:+.2f}% (net {l2['net']:+.2f}%) | trail 20%: {tr_['avg']:+.2f}% (net {tr_['net']:+.2f}%)")
    else:
        print(f"  {label:<24}    0 trades")
# ---------------------------------------------------------------- 10: is it a few trades?
print("\n10) How much of a rule's result is a few trades: the average per trade with its best ones taken out (both halves; before commission)")
print(f"  {'':<46}| {'trades':>6} {'all':>8} {'no best 1':>10} {'no best 3':>10} {'no best 5':>10} {'no best 10':>11} | {'the period, $':>14} {'best 5 give':>12}")
CHECK = [("take-profit +20% (as built)", dict(tp=20)),
         ("take-profit +20%, +5%: stop to the entry", dict(tp=20, lock=[(5, 0)])),
         ("take-profit +50%", dict(tp=50)),
         ("trail 10% from the start", dict(trail=(0, 10))),
         ("trail 15% from the start", dict(trail=(0, 15))),
         ("trail 20% from the start", dict(trail=(0, 20))),
         ("trail 25% from the start", dict(trail=(0, 25))),
         ("+10%: stop to the entry, then trail 20%", dict(lock=[(10, 0)], trail=(10, 20))),
         ("under the basis, once +10%", dict(basis=10)),
         ("half +10%, rest trails 15%, stop to entry", dict(half=10, lock=[(10, 0)], trail=(10, 15))),
         ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20)))]
for label, rule in CHECK:
    pct = sorted((play(t, **rule)[0] for t in TRADES), reverse=True)
    total = sum(pct)
    cut = lambda k: statistics.fmean(pct[k:]) if len(pct) > k else float('nan')
    print(f"  {label:<46}| {len(pct):>6} {cut(0):>+7.2f}% {cut(1):>+9.2f}% {cut(3):>+9.2f}% {cut(5):>+9.2f}% {cut(10):>+10.2f}% | "
          f"{args.amount * total / 100:>+13,.0f}$ {args.amount * sum(pct[:5]) / 100:>+11,.0f}$")

# ---------------------------------------------------------------- 11: the worst order inside a candle
show("11) The moving stops again, with the worst order inside every candle (its high first, then its low): the lower bound",
     [("take-profit +20%, +5%: stop to the entry", dict(tp=20, lock=[(5, 0)], hard=True)),
      ("take-profit +20%, +10%: stop to the entry", dict(tp=20, lock=[(10, 0)], hard=True)),
      ("trail 10% from the start", dict(trail=(0, 10), hard=True)),
      ("trail 15% from the start", dict(trail=(0, 15), hard=True)),
      ("trail 20% from the start", dict(trail=(0, 20), hard=True)),
      ("trail 25% from the start", dict(trail=(0, 25), hard=True)),
      ("trail 15% once +10% is gained", dict(trail=(10, 15), hard=True)),
      ("trail 20% once +20% is gained", dict(trail=(20, 20), hard=True)),
      ("+10%: stop to the entry, then trail 20%", dict(lock=[(10, 0)], trail=(10, 20), hard=True)),
      ("half +10%, rest trails 15%, stop to entry", dict(half=10, lock=[(10, 0)], trail=(10, 15), hard=True)),
      ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20), hard=True))])

# ---------------------------------------------------------------- 12: $0.50 and over only
HI_IN, HI_OUT = [t for t in IN if t['alert'] >= 0.5], [t for t in OUT if t['alert'] >= 0.5]
show("12) Alerts at $0.50 and over only (the operator's floor): the main rules, careful order",
     [("take-profit +20% (as built)", dict(tp=20)),
      ("take-profit +20%, +5%: stop to the entry", dict(tp=20, lock=[(5, 0)])),
      ("take-profit +30%", dict(tp=30)),
      ("take-profit +50%", dict(tp=50)),
      ("trail 15% from the start", dict(trail=(0, 15))),
      ("trail 20% from the start", dict(trail=(0, 20))),
      ("trail 25% from the start", dict(trail=(0, 25))),
      ("under the basis, once +10%", dict(basis=10)),
      ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20)))], HI_IN, HI_OUT)
show("12b) …the same, worst order inside every candle",
     [("trail 15% from the start", dict(trail=(0, 15), hard=True)),
      ("trail 20% from the start", dict(trail=(0, 20), hard=True)),
      ("trail 25% from the start", dict(trail=(0, 25), hard=True)),
      ("half +20%, rest trails 20%, stop to entry", dict(half=20, lock=[(20, 0)], trail=(20, 20), hard=True))], HI_IN, HI_OUT)

# ---------------------------------------------------------------- 13: the biggest trades, by name
print("\n13) The ten biggest trades under 'trail 20% from the start' (to see what the tail is made of)")
big = sorted(((play(t, trail=(0, 20)), t) for t in TRADES), key=lambda x: -x[0][0])[:10]
for (pct, how, held, _), t in big:
    print(f"  {t['day']} {t['t'] // 60:02d}:{t['t'] % 60:02d} {t['ticker']:<6} bought {t['E']:.4f}  {pct:>+7.1f}% in {held} min ({how}); "
          f"with take-profit +20%: {play(t, tp=20)[0]:+.1f}%")

# ---------------------------------------------------------------- 14: the operator's choice
# "I would prefer 1 and 2" (2026-11-28): the stop to the entry once the price has gained a little,
# half sold at +20%, the other half trailing 20% under the high. At which gain should the stop move?
CHOICE = [("as built: take-profit +20%, nothing moved", dict(tp=20)),
          ("half +20%, rest trails 20%; stop to entry at +5%", dict(half=20, lock=[(5, 0)], trail=(20, 20))),
          ("…stop to entry at +7.5%", dict(half=20, lock=[(7.5, 0)], trail=(20, 20))),
          ("…stop to entry at +10%", dict(half=20, lock=[(10, 0)], trail=(20, 20))),
          ("…stop to entry at +15%", dict(half=20, lock=[(15, 0)], trail=(20, 20))),
          ("…stop to entry only at +20% (option 2 alone)", dict(half=20, lock=[(20, 0)], trail=(20, 20))),
          ("…at +10%, the rest trails 15%", dict(half=20, lock=[(10, 0)], trail=(20, 15))),
          ("…at +10%, the rest trails 25%", dict(half=20, lock=[(10, 0)], trail=(20, 25)))]
show("14) The operator's choice, 1 and 2 together: alerts at $0.50 and over, careful order", CHOICE, HI_IN, HI_OUT)
show("14b) …the same, worst order inside every candle", [(label, dict(rule, hard=True)) for label, rule in CHOICE], HI_IN, HI_OUT)
print("\n14c) …and how those rules end, and what their best trades carry (alerts at $0.50 and over, both halves, careful order)")
HI = HI_IN + HI_OUT
for label, rule in CHOICE:
    res = [play(t, **rule) for t in HI]
    pct = sorted((r[0] for r in res), reverse=True)
    how = {}
    for r in res:
        how[r[1]] = how.get(r[1], 0) + 1
    ends = ', '.join(f"{k} {100 * v / len(res):.0f}%" for k, v in sorted(how.items(), key=lambda kv: -kv[1]))
    print(f"  {label:<50}| avg {statistics.fmean(pct):+.2f}%, without its best 5 {statistics.fmean(pct[5:]):+.2f}% | lost 5% or more: {100 * sum(p <= -5 for p in pct) / len(pct):.0f}% of trades | {ends}")

RV = [t for t in TRADES if t['rv1'] is not None]
if RV:
    cutv = 11745.0
    for label, pick in ((f"the dashboard's RVol 1m ≥ {cutv:,.0f}%", lambda t: t['rv1'] >= cutv), ("under it", lambda t: t['rv1'] < cutv)):
        show(f"9) {label}", [("take-profit +20% (as built)", dict(tp=20)), ("take-profit +20%, +10%: stop to the entry", dict(tp=20, lock=[(10, 0)])),
                             ("trail 20% from the start", dict(trail=(0, 20))), ("under the basis, once +10%", dict(basis=10))],
             [t for t in IN if t['rv1'] is not None and pick(t)], [t for t in OUT if t['rv1'] is not None and pick(t)])
