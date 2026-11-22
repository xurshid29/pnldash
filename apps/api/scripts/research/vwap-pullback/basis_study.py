# The pullback's basis line as an entry rule (operator, 2026-11-22; script v45 draws the line).
#
#   python basis_study.py <rows.csv.gz> [--cut 2026-10-09] [--list TICKER]
#
# <rows.csv.gz> comes from export-rows.sql (see README.md). Needs only `pip install duckdb`.
#
# The operator's question, with VWAV charts: after a PULLBACK,
#   (a) the basis is going DOWN when the PULLBACK fires, then a candle closes above it: enter there;
#   (b) no candle closes above the basis: no trade;
#   (c) the basis is going UP when the PULLBACK fires: "such setups often drop" — skip them, or wait
#       for the drop, the return, and a break of the PULLBACK candle (its high).
# "With measuring I mean the setup went +10% or not."
#
# What stands in for what
#   Basis    TradingView's line is the SMA of the last 20 closes of 15-second bars (5 minutes of
#            trading). We have no 15-second bars: the nearest thing is the mean of our own price
#            snapshots (one per ~20 s while a name is on the Momentum screen) over the last 300
#            seconds, read at each 1m bar's last snapshot. Needs 10+ snapshots in the window.
#   Bars     1m bars from the snapshots, as in study.py (highs and lows are the highest and lowest
#            of about three snapshots a minute, so they understate the real ones).
#   Line     the poller's session VWAP. Month and year PULLBACKs can't be rebuilt from our rows.
#   PULLBACK the script's own state machine (pinesim.PullbackLine, arm 15% / near 5% / close under
#            the line breaks it), every touch, no daily cap.
#   Slope    the basis at the PULLBACK bar against the basis one bar before (the bar must be the
#            minute before).
#
# The races (all the same one): from an entry price, a bar high +10% above it = "win"; a bar close
# under the line first = "broke"; 60 bars without either = "stall"; the name leaving our screen
# (> 3 min without a bar) or the day ending = "lost". P&L: +10% on a win, the break bar's close on
# a break, the last close otherwise.
#   plain    entry at the PULLBACK bar's close (what the alert is today).
#   A        entry at the first bar close above the basis, from the PULLBACK bar on, before a close
#            under the line and within 60 bars.
#   A2       the same, and the basis is rising at that bar (above its value a bar before).
#   C        after the PULLBACK bar: a later bar's low under the PULLBACK bar's low (the drop), then
#            a bar close above the PULLBACK bar's high, within --cwait bars (default 15).
#   C-any    a bar close above the PULLBACK bar's high within --cwait bars, drop or not.
import argparse, datetime, duckdb, os, statistics, sys
from collections import defaultdict

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
from pinesim import PullbackLine

ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--cut', default='2026-10-09', help='first out-of-sample day')
ap.add_argument('--arm', type=float, default=15)
ap.add_argument('--near', type=float, default=5)
ap.add_argument('--window', type=int, default=300, help='the basis: seconds of snapshots averaged')
ap.add_argument('--min-snaps', type=int, default=10, help='snapshots the window must hold')
ap.add_argument('--cwait', type=int, default=15, help='bars to wait for the break of the PULLBACK candle')
ap.add_argument('--list', help='print every PULLBACK of a ticker')
args = ap.parse_args()
WIN, HORIZON, MAX_GAP = 0.10, 60, 3
CUT = datetime.date.fromisoformat(args.cut)

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute(f"""
create table snap as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(vwap as double) as vwap,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, ts, price, vwap, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       avg(price) over w as basis, count(*) over w as bn
from t
window w as (partition by ticker order by ts range between {args.window - 1} preceding and current row)""")
con.execute(f"""
create table bars as
select ticker, day, tmin, arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw,
       case when arg_max(bn, ts) >= {args.min_snaps} then arg_max(basis, ts) end as basis
from snap
where tmin between 240 and 1199
group by all""")
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | in sample before {CUT}, out of sample from it")
print(f"PULLBACK: arm {args.arm:.0f}% near {args.near:.0f}%, session line | basis: mean of the last {args.window}s of snapshots "
      f"(≥ {args.min_snaps}) | win +{WIN:.0%}, horizon {HORIZON} bars")


class Race:
    __slots__ = ('entry', 'target', 'n', 'last_c', 'out', 'pnl')

    def __init__(self, entry, target=None):
        self.entry, self.n, self.last_c, self.out, self.pnl = entry, 0, entry, None, None
        self.target = entry * (1 + WIN) if target is None else target

    def step(self, h, c, vw):
        if self.out:
            return
        self.n += 1
        if c < vw:
            self.out, self.pnl = 'broke', c / self.entry - 1
        elif h >= self.target:
            self.out, self.pnl = 'win', self.target / self.entry - 1
        elif self.n >= HORIZON:
            self.out, self.pnl = 'stall', c / self.entry - 1
        self.last_c = c

    def lose(self):
        if not self.out:
            self.out, self.pnl = 'lost', self.last_c / self.entry - 1


class Wait:
    """One entry rule waiting on one PULLBACK. state: wait → in → done (why = no-entry reason)."""
    __slots__ = ('state', 'bars', 'race', 'why', 'entry_t', 'dropped')

    def __init__(self):
        self.state, self.bars, self.race, self.why, self.entry_t, self.dropped = 'wait', 0, None, None, None, False

    def enter(self, price, t, target=None):
        self.state, self.race, self.entry_t = 'in', Race(price, target), t

    def skip(self, why):
        self.state, self.why = 'done', why


EVENTS = []


def run_day(key, bars):
    ticker, day = key
    pl = PullbackLine(dict(arm=args.arm, near=args.near, brk=0, win=WIN * 100, max_touches=0, cap_on='touches',
                           timeout=HORIZON, window=None, touch_on='close'))
    plain = None            # the open PULLBACK's event (the script's own race)
    live = []               # events with an entry rule still waiting or racing
    prev_t = prev_basis = prev_c = None
    i = -1
    for (t, o, h, l, c, vw, basis) in bars:
        if vw is None or vw <= 0 or h is None:
            continue
        i += 1
        gap = 0 if prev_t is None else t - prev_t
        if gap > MAX_GAP:           # the name left our screen: nothing open can be judged past here
            if plain:
                plain['plain'], plain['plain_pnl'] = 'lost', prev_c / plain['c0'] - 1
                pl.open, plain = False, None
            for e in live:
                for w in e['rules'].values():
                    if w.state == 'wait':
                        w.skip('lost')
                    elif w.state == 'in':
                        w.race.lose()
                        w.state = 'done'
            live = []
        # the entry rules of the PULLBACKs already open
        for e in live:
            rising = basis is not None and prev_basis is not None and gap == 1 and basis > prev_basis
            for name, w in e['rules'].items():
                if w.state == 'in':
                    w.race.step(h, c, vw)
                    if w.race.out:
                        w.state = 'done'
                elif w.state == 'wait':
                    w.bars += 1
                    if name in ('A', 'A2', 'Ah'):
                        if c < vw:
                            w.skip('broke')
                        elif basis is not None and c > basis and (name != 'A2' or rising):
                            if name == 'Ah' and c >= e['c0'] * (1 + WIN):
                                w.skip('already +10%')      # the close above the basis is already past the level
                            else:
                                w.enter(c, t, e['c0'] * (1 + WIN) if name == 'Ah' else None)
                        elif w.bars >= HORIZON:
                            w.skip('timeout')
                    else:
                        if l < e['lo0']:
                            w.dropped = True
                        if c > e['hi0'] and c >= vw and (name == 'Cany' or w.dropped):
                            w.enter(c, t)
                        elif w.bars >= args.cwait:
                            w.skip('timeout')
        live = [e for e in live if any(w.state != 'done' for w in e['rules'].values())]
        # the script's own state machine
        was_open = pl.open
        ev = pl.step(i, h, c, vw, True, l)
        if plain:
            if ev == 2:
                plain['plain'], plain['plain_pnl'], plain = 'broke', c / plain['c0'] - 1, None
            elif ev == 3:
                plain['plain'], plain['plain_pnl'], plain = 'win', WIN, None
            elif was_open and not pl.open:
                plain['plain'], plain['plain_pnl'], plain = 'stall', c / plain['c0'] - 1, None
        if ev == 1:
            slope = None
            if basis is not None and prev_basis is not None and gap == 1:
                slope = 'down' if basis < prev_basis else 'up' if basis > prev_basis else 'flat'
            e = dict(ticker=ticker, day=day, t0=t, c0=c, hi0=h, lo0=l, vw0=vw, b0=basis, slope=slope, touch=pl.touches,
                     above=None if basis is None else c > basis, plain=None, plain_pnl=None,
                     rules={'A': Wait(), 'A2': Wait(), 'Ah': Wait(), 'C': Wait(), 'Cany': Wait()})
            # the PULLBACK bar itself can be the first close above the basis
            if basis is not None and c > basis:
                e['rules']['A'].enter(c, t)
                e['rules']['Ah'].enter(c, t, c * (1 + WIN))
                if slope == 'up':
                    e['rules']['A2'].enter(c, t)
            EVENTS.append(e)
            live.append(e)
            plain = e
        prev_t, prev_c = t, c
        prev_basis = basis
    if plain:
        plain['plain'], plain['plain_pnl'] = 'lost', prev_c / plain['c0'] - 1
    for e in live:
        for w in e['rules'].values():
            if w.state == 'wait':
                w.skip('lost')
            elif w.state == 'in':
                w.race.lose()
                w.state = 'done'


cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, basis from bars order by ticker, day, tmin")
key, day_bars = None, []
while True:
    chunk = cur.fetchmany(200_000)
    if not chunk:
        break
    for row in chunk:
        k = (row[0], row[1])
        if k != key:
            if day_bars:
                run_day(key, day_bars)
            key, day_bars = k, []
        day_bars.append(row[2:])
if day_bars:
    run_day(key, day_bars)


def hhmm(t):
    return f"{t // 60:02d}:{t % 60:02d}"


if args.list:
    for e in EVENTS:
        if e['ticker'] != args.list.upper():
            continue
        parts = []
        for name, w in e['rules'].items():
            if w.race:
                parts.append(f"{name} {hhmm(w.entry_t)} @{w.race.entry:.4g} {w.race.out} {w.race.pnl:+.1%}")
            else:
                parts.append(f"{name} – ({w.why})")
        b0 = '—' if e['b0'] is None else f"{e['b0']:.4g}"
        print(f"{e['day']} {hhmm(e['t0'])} ET  close {e['c0']:.4g}  line {e['vw0']:.4g}  basis {b0} {e['slope'] or '?'}  "
              f"touch {e['touch']}  plain {e['plain']} {e['plain_pnl']:+.1%} | " + ' | '.join(parts))
    sys.exit(0)


def summ(pairs):
    """pairs: (outcome, pnl) → n, win %, broke %, other %, mean P&L %."""
    n = len(pairs)
    if n == 0:
        return None
    win = sum(1 for o, _ in pairs if o == 'win')
    broke = sum(1 for o, _ in pairs if o == 'broke')
    return n, 100 * win / n, 100 * broke / n, 100 * (n - win - broke) / n, 100 * statistics.fmean(p for _, p in pairs)


def cell(s):
    return f"{'—':>34}" if s is None else f"{s[0]:>6,} {s[1]:>5.1f}% {s[2]:>5.1f}% {s[3]:>5.1f}% {s[4]:>+6.2f}%"


HEAD = f"{'':<46}{'in sample':>34}   {'out of sample':>34}\n{'':<46}" + f"{'n':>6} {'+10%':>6} {'broke':>6} {'other':>6} {'P&L':>7}   " * 2


def split(events):
    return [e for e in events if e['day'] < CUT], [e for e in events if e['day'] >= CUT]


def row(label, events, pick):
    a, b = split(events)
    print(f"{label:<46}{cell(summ([p for p in map(pick, a) if p]))}   {cell(summ([p for p in map(pick, b) if p]))}")


def plain_of(e):
    return (e['plain'], e['plain_pnl'])


def rule_of(name):
    def f(e):
        w = e['rules'][name]
        return (w.race.out, w.race.pnl) if w.race else None
    return f


known = [e for e in EVENTS if e['slope'] in ('down', 'up')]
down = [e for e in known if e['slope'] == 'down']
up = [e for e in known if e['slope'] == 'up']
days = sorted({e['day'] for e in EVENTS})
print(f"\n{len(EVENTS):,} PULLBACKs on {len(days)} days; basis slope known for {len(known):,} "
      f"(down {len(down):,}, up {len(up):,}; flat {sum(1 for e in EVENTS if e['slope'] == 'flat')}, "
      f"no basis {sum(1 for e in EVENTS if e['slope'] is None)})")

print("\n1) The PULLBACK as it alerts today (entry at its close), by the basis at that bar")
print(HEAD)
row('all PULLBACKs', EVENTS, plain_of)
row('basis going down', down, plain_of)
row('basis going up', up, plain_of)
row('  down, close under the basis', [e for e in down if e['above'] is False], plain_of)
row('  down, close above the basis', [e for e in down if e['above']], plain_of)
row('  up, close under the basis', [e for e in up if e['above'] is False], plain_of)
row('  up, close above the basis', [e for e in up if e['above']], plain_of)

print("\n2) Rule A: enter at the first close above the basis (the trades it takes)")
print(HEAD)
for label, group in (('after a basis-down PULLBACK', down), ('after a basis-up PULLBACK', up), ('after any PULLBACK', known)):
    row(f"A   {label}", group, rule_of('A'))
    row(f"A2  {label} (basis rising)", group, rule_of('A2'))


def taken(group, name):
    a, b = split(group)
    out = []
    for g in (a, b):
        n = len(g)
        ent = [e for e in g if e['rules'][name].race]
        at_bar = sum(1 for e in ent if e['rules'][name].entry_t == e['t0'])
        waits = [e['rules'][name].entry_t - e['t0'] for e in ent if e['rules'][name].entry_t != e['t0']]
        why = defaultdict(int)
        for e in g:
            if not e['rules'][name].race:
                why[e['rules'][name].why] += 1
        out.append(f"{len(ent):,} of {n:,} ({100 * len(ent) / n if n else 0:.0f}%) enter, {at_bar:,} at the PULLBACK bar, "
                   f"the rest after a median {statistics.median(waits) if waits else 0:.0f} min; no entry: "
                   + ', '.join(f"{k} {v:,}" for k, v in sorted(why.items(), key=lambda x: -x[1])))
    return out


print("\n   How many PULLBACKs give an entry (in sample / out of sample)")
for label, group, name in (('A, basis down', down, 'A'), ('A2, basis down', down, 'A2'), ('A, basis up', up, 'A')):
    a, b = taken(group, name)
    print(f"   {label:<16} {a}\n   {'':<16} {b}")

print("\n   What the wait costs after a basis-down PULLBACK: rule A's entry against the PULLBACK's close")
for label, g in zip(('in sample', 'out of sample'), split(down)):
    prem = sorted(100 * (e['rules']['A'].race.entry / e['c0'] - 1) for e in g if e['rules']['A'].race)
    if prem:
        q = lambda p: prem[min(len(prem) - 1, int(p * len(prem)))]
        print(f"   {label:<14} entry above the PULLBACK close by a median {q(0.5):.1f}% (quarter under {q(0.25):.1f}%, quarter over {q(0.75):.1f}%); "
              f"{sum(1 for x in prem if x >= 10):,} of {len(prem):,} entries are already +10% or more above it")
print("\n   Rule A's entry, aiming at the PULLBACK's own +10% level (the script's HELD) instead of +10% from the entry")
print(HEAD)
row('Ah  after a basis-down PULLBACK', down, rule_of('Ah'))
row('Ah  after a basis-up PULLBACK', up, rule_of('Ah'))

print("\n3) The basis-down PULLBACKs rule A never enters (their outcome as plain alerts)")
print(HEAD)
row('down, A never entered', [e for e in down if not e['rules']['A'].race], plain_of)
row('down, A entered (plain, for comparison)', [e for e in down if e['rules']['A'].race], plain_of)

print(f"\n4) Rule C after a basis-up PULLBACK: the PULLBACK candle's high broken within {args.cwait} bars")
print(HEAD)
row('C     up: drop under its low, then the break', up, rule_of('C'))
row('C-any up: the break, drop or not', up, rule_of('Cany'))
row('C     down (for comparison)', down, rule_of('C'))
row('C-any down (for comparison)', down, rule_of('Cany'))
for label, group, name in (('C, basis up', up, 'C'), ('C-any, basis up', up, 'Cany')):
    a, b = taken(group, name)
    print(f"   {label:<16} {a}\n   {'':<16} {b}")


def per100(group_all, picks):
    """Trades, wins and summed P&L per 100 PULLBACKs (of group_all), for a list of (subset, pick)."""
    out = []
    for g_all in split(group_all):
        ids = {id(e) for e in g_all}
        trades = wins = 0
        pnl = 0.0
        for subset, pick in picks:
            for e in subset:
                if id(e) in ids:
                    p = pick(e)
                    if p:
                        trades += 1
                        wins += p[0] == 'win'
                        pnl += p[1]
        n = len(g_all)
        out.append(f"{100 * trades / n:>5.0f} trades, {100 * wins / n:>4.1f} wins ({100 * wins / trades if trades else 0:>4.1f}%), "
                   f"P&L sum {100 * 100 * pnl / n:>+6.1f}%")
    return out


print("\n5) Per 100 PULLBACKs with a known basis slope: what each way of trading them gives")
for label, picks in (
        ('every PULLBACK at its close (today)', [(known, plain_of)]),
        ('basis-down only, at the close', [(down, plain_of)]),
        ('down → A; up → skip', [(down, rule_of('A'))]),
        ('down → A2; up → skip', [(down, rule_of('A2'))]),
        ('down → A; up → C (drop, then break)', [(down, rule_of('A')), (up, rule_of('C'))]),
        ('down → A; up → C-any', [(down, rule_of('A')), (up, rule_of('Cany'))]),
        ('A after any PULLBACK', [(known, rule_of('A'))])):
    a, b = per100(known, picks)
    print(f"   {label:<38} in: {a}\n   {'':<38} out: {b}")
