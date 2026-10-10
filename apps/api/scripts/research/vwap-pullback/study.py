# VWAP pullback study — the operator's second VWAP setup (2026-10-05).
#
#   python study.py <rows.csv.gz> [--arm 15] [--near 5] [--brk 0] [--grid] [--list TICKER|all]
#
# <rows.csv.gz> comes from export-rows.sql (see README.md). Needs only
# `pip install duckdb`.
#
# The setup (operator, 2026-10-05): a fast run stretches price well above
# VWAP, then it pulls back. Alert when price comes back to within ~5% above
# the line ("so I can be ready"). The setup is broken, and the operator exits,
# when price closes under the line. The first pullback after the first big
# move is the attractive one.
#
# Line     the poller's stored session VWAP (screener_results.vwap: Δvolume ×
#          price since the ticker's first sight today). Within ~1% of
#          TradingView's session VWAP when the name was on screen from the
#          start of its move (SDEV 9.12 vs 9.05, SAIQ 9.78 vs 9.85 on
#          2026-10-05). The month line can't be rebuilt from our rows (we only
#          see a ticker while it is up 20%+), so that version is graded live.
# Bars     1m bars from the 20s snapshots (close = the minute's last snapshot),
#          i.e. what a 1m bar-close alert sees.
# Setup    the Pine script's own PULLBACK state machine (v10), imported from
#          ../vwap-setup/pinesim.py (PullbackLine) — so these numbers describe
#          exactly what the script does on the session line:
#          armed by a bar high ≥ line × (1 + arm%); PULLBACK on a later close in
#          [line × (1 − brk%), line × (1 + near%)]; a close straight under that
#          is a "through" event (a touch, no alert); then BROKEN on a close
#          under line × (1 − brk%) → "broke", HELD on a high +10% above the
#          PULLBACK close → "win", 60 bars without either → "stall". The
#          ticker leaving our screen (> 3 min gap) or the day ending first →
#          "lost". P&L: +10% on a win, the break bar's close on a break, the
#          last close on a stall or lost.
# Touch #  touches so far for the ticker today, the script's `touch` (re-arming
#          needs a new stretch ≥ arm% after the previous touch).
# At line  variant entry: a limit at line × 1.005 once a bar's low reaches it,
#          same race from the fill.
# Baseline any bar close in [line, line × (1 + near%)] on the same
#          ticker-days that is not a setup alert (≤ 1 per 15 min per
#          ticker-day), same race: "just near VWAP".
import argparse, duckdb, os, statistics, sys
from collections import Counter, defaultdict

sys.dont_write_bytecode = True   # no __pycache__ in the repo
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
from pinesim import PullbackLine   # the Pine script's v10 PULLBACK state machine, bar for bar

ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--arm', type=float, default=15, help='stretch above the line that arms a setup, %%')
ap.add_argument('--near', type=float, default=5, help='alert band above the line, %%')
ap.add_argument('--brk', type=float, default=0, help='a close this far under the line breaks the setup, %%')
ap.add_argument('--grid', action='store_true', help='also sweep --brk and --arm (touch-level summary)')
ap.add_argument('--list', help="print every setup for a ticker, or 'all'")
ap.add_argument('--cap', type=int, default=99, help='pullbacks per line per day (99 = uncapped, the default for the touch tables)')
ap.add_argument('--cap-on', choices=['touches', 'failures', 'broken'], default='touches',
                help="what the cap counts: all touches (script v10–v14), BROKEN + straight-through (v15), or BROKEN only")
ap.add_argument('--cap-strong', action='store_true',
                help='the touches the cap (2 failures) blocks, by how strong the ticker was: change %% and grade at the alert')
ap.add_argument('--cap-compare', action='store_true',
                help='compare the cap modes at --cap (default 2): alerts/day, P&L per exit rule, and the alerts each mode adds')
args = ap.parse_args()
PATH, ARM, NEAR, BRK = args.rows, args.arm / 100, args.near / 100, args.brk / 100
WIN = 0.10
HORIZON = 60      # minutes
MAX_GAP = 3       # minutes without a bar = the ticker left our screen
BASE_EVERY = 15   # minutes between baseline samples per ticker-day

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{PATH}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(volume as double) as volume,
         try_cast(vwap as double) as vwap, try_cast(change_pct as double) as change_pct,
         try_cast(float_m as double) as float_m, cast(grade as varchar) as grade,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c, arg_max(vwap, ts) as vw,
       arg_max(volume, ts) as vol, arg_max(change_pct, ts) as chg, arg_max(float_m, ts) as flt,
       arg_max(grade, ts) as grade
from t
where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")
# Per ticker-day: first sight, and whether it ran ≥ +30% on an earlier day in
# the last 30 (a "runner" — the TradingView watchlist's definition).
con.execute("""
create table td as
with d as (
  select ticker, day, min(tmin) filter (where vw is not null) as first_t, max(chg) as day_max from bars group by all)
select *, max(day_max) over (partition by ticker order by day
                             range between interval 30 days preceding and interval 1 day preceding) as prior_max
from d""")
TD = {(r[0], r[1]): (r[2], r[3]) for r in con.execute("select ticker, day, first_t, prior_max from td").fetchall()}
n_bars, n_days = con.execute("select count(*), count(distinct (ticker, day)) from bars").fetchone()
span = con.execute("select min(day), max(day) from bars").fetchone()
print(f"{n_bars:,} 1m bars, {n_days:,} ticker-days, {span[0]} → {span[1]} | arm {ARM:.0%} near {NEAR:.0%} brk {BRK:.0%} "
      f"win +{WIN:.0%} horizon {HORIZON}m")


class Race:
    """+WIN (bar high) vs a bar close under the line, from `entry` at minute t0."""
    __slots__ = ('entry', 't0', 'last_t', 'last_c', 'mfe', 'out', 't_out', 'pnl', 'seen', 'k')

    def __init__(self, entry, t0):
        self.entry, self.t0, self.last_t, self.last_c = entry, t0, t0, entry
        self.mfe = 0.0
        self.out = self.t_out = self.pnl = None

    def step(self, t, h, c, vw):
        if self.out:
            return
        if t - self.last_t > MAX_GAP:
            return self._end('lost', self.last_t, self.last_c / self.entry - 1)
        self.mfe = max(self.mfe, h / self.entry - 1)
        if c < vw * (1 - BRK):
            self._end('broke', t, c / self.entry - 1)
        elif h >= self.entry * (1 + WIN):
            self._end('win', t, WIN)
        elif t - self.t0 >= HORIZON:
            self._end('stall', t, c / self.entry - 1)
        self.last_t, self.last_c = t, c

    def close_day(self):
        if not self.out:
            self._end('lost', self.last_t, self.last_c / self.entry - 1)

    def _end(self, out, t, pnl):
        self.out, self.t_out, self.pnl = out, t, pnl


def bucket(v, edges, labels):
    for e, lab in zip(edges, labels):
        if v < e:
            return lab
    return labels[-1]


def tod(t):
    return bucket(t, [420, 570, 630, 720, 960], ['a 04-07', 'b 07-09:30', 'c 09:30-10:30', 'd 10:30-12', 'e 12-16', 'f AH'])


def run(arm):
    events, base = [], []
    cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, vol, chg, flt, grade from bars order by ticker, day, tmin")
    key, day_bars = None, []

    def flush():
        if day_bars:
            run_day(key, day_bars, arm, events, base)

    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk:
            break
        for row in chunk:
            k = (row[0], row[1])
            if k != key:
                flush()
                key, day_bars = k, []
            day_bars.append(row[2:])
    flush()
    return events, base


def run_day(key, bars, arm, events, base):
    first_t, prior_max = TD.get(key, (None, None))
    runner = prior_max is not None and prior_max >= 30
    pl = PullbackLine(dict(arm=arm * 100, near=NEAR * 100, brk=BRK * 100, win=WIN * 100, max_touches=args.cap,
                           cap_on=args.cap_on, timeout=HORIZON, window=None))
    ep, open_base, open_side, last_base = None, [], [], -999
    bvols, seen = [], []       # (minute, bar volume) for every bar; (t, o, h, l, c, line) for each bar the setup saw
    prev_vol = prev_t = None
    for (t, o, h, l, c, vw, vol, chg, flt, grade) in bars:
        bv = 0 if (prev_vol is None or vol is None) else max(0, vol - prev_vol)
        if vol is not None:
            prev_vol = vol
        bvols.append((t, bv))
        if vw is None or vw <= 0 or h is None:
            continue
        gap = 0 if prev_t is None else t - prev_t
        prev_t = t
        i = len(seen)
        seen.append((t, o, h, l, c, vw))
        # 1) side races: the baseline samples and the at-line entries
        for r in open_base + open_side:
            if t > r.t0:
                r.step(t, h, c, vw)
        open_base = [r for r in open_base if not r.out]
        open_side = [r for r in open_side if not r.out]
        # 2) the setup — the script's own state machine (pinesim.PullbackLine). The
        # ticker leaving our screen mid-pullback means we can't see the outcome.
        if ep and gap > MAX_GAP:
            r = ep['race']
            r._end('lost', r.last_t, r.last_c / ep['entry'] - 1)
            pl.open, ep = False, None
        was_open, touches = pl.open, pl.touches
        ev = pl.step(i, h, c, vw, True)
        if ep:
            r = ep['race']
            r.mfe = max(r.mfe, h / ep['entry'] - 1)
            if ev == 2:
                r._end('broke', t, c / ep['entry'] - 1)
            elif ev == 3:
                r._end('win', t, WIN)
            elif was_open and not pl.open:
                r._end('stall', t, c / ep['entry'] - 1)
            r.last_t, r.last_c = t, c
            at = ep['at_line']
            if at['race'] is None and not r.out and l <= vw * 1.005:
                fill = vw * 1.005
                at['race'] = Race(fill, t)
                if c < vw * (1 - BRK):
                    at['race']._end('broke', t, c / fill - 1)
                else:
                    open_side.append(at['race'])
            if r.out:
                ep = None
        if pl.touches > touches:   # a PULLBACK, or a close straight through the line
            pk = seen[pl.peak_bar][0]
            imp = [v for (bt, v) in bvols if pk - 9 <= bt <= pk]
            pull = [v for (bt, v) in bvols if pk < bt <= t]
            imp_avg = sum(imp) / len(imp) if imp else 0
            pull_avg = sum(pull) / len(pull) if pull else None
            e = dict(ticker=key[0], day=key[1], t0=t, entry=c, line=vw, touch=pl.touches,
                     stretch=pl.peak_pct / 100, from_peak=t - pk,
                     vol_ratio=(pull_avg / imp_avg) if (imp_avg and pull_avg is not None) else None,
                     arm_after_sight=(seen[pl.arm_bar][0] - first_t) if first_t is not None else None,
                     chg=chg, flt=flt, grade=grade, runner=runner, through=ev != 1,
                     race=Race(c, t), at_line={'race': None}, seen=seen, k=i)
            if ev == 1:
                ep = e
            else:
                e['race']._end('through', t, 0.0)
            events.append(e)
        # 3) baseline: near the line, not a setup alert
        if ev != 1 and vw <= c <= vw * (1 + NEAR) and t - last_base >= BASE_EVERY:
            r = Race(c, t)
            r.seen, r.k = seen, i
            open_base.append(r)
            base.append(r)
            last_base = t
    if ep:
        ep['race'].close_day()
    for r in open_base + open_side:
        r.close_day()


def summarize(races):
    n = len(races)
    if not n:
        return None
    cnt = defaultdict(int)
    for r in races:
        cnt[r.out] += 1
    pnl = [r.pnl for r in races]
    mfe = [r.mfe for r in races]
    return dict(n=n, win=cnt['win'] / n, broke=cnt['broke'] / n, stall=cnt['stall'] / n, lost=cnt['lost'] / n,
                pnl=sum(pnl) / n, mfe=statistics.median(mfe))


def line(label, races, extra=''):
    s = summarize(races)
    if not s:
        return
    print(f"  {label:26} {s['n']:6,}  win {s['win']:6.1%}  broke {s['broke']:6.1%}  stall {s['stall']:6.1%}  "
          f"lost {s['lost']:6.1%}  avg P&L {s['pnl']:+6.2%}  med MFE {s['mfe']:+6.1%}{extra}")


def split(title, evs, fn):
    print(f"\n{title}")
    groups = defaultdict(list)
    for e in evs:
        g = fn(e)
        if g is not None:
            groups[g].append(e['race'])
    for g in sorted(groups):
        line(str(g), groups[g])


STOP_SLIP = 0.005   # a stop 0.5% under the line
EXITS = [('close<line', 'close', 0.10), ('close<line', 'close', 0.20), ('close<line', 'close', None),
         ('stop -0.5%', 'stop', 0.10), ('stop -0.5%', 'stop', 0.20), ('stop -0.5%', 'stop', None)]


def forward(seen, k, entry, rule, target):
    """Trade an alert: enter at `entry` on bar k's close, then per later bar — exit under the line
    ('close': the 1m close under it; 'stop': a stop 0.5% under it, filled at the stop or at the bar's
    open if it opened lower), take `target` (None = no target), or leave at the close 60 min later.
    Losing sight of the ticker (> 3 min gap) or the day ending exits at the last close."""
    t0, last_t, last_c = seen[k][0], seen[k][0], entry
    for j in range(k + 1, len(seen)):
        t, o, h, l, c, vw = seen[j]
        if t - last_t > MAX_GAP:
            break
        if rule == 'close':
            if c < vw:
                return c / entry - 1
        else:
            stop = vw * (1 - STOP_SLIP)
            if l <= stop:
                return min(o, stop) / entry - 1
        if target and h >= entry * (1 + target):
            return target
        if t - t0 >= HORIZON:
            return c / entry - 1
        last_t, last_c = t, c
    return last_c / entry - 1


def exit_grid(title, groups):
    print(f"\n{title} — mean P&L per trade (share of trades that made money)")
    label = lambda n, tg: f"{n} " + (f"+{round(tg * 100)}%" if tg else 'no target')
    print('  ' + ' ' * 22 + ''.join(f"{label(n, tg):>21}" for n, _, tg in EXITS))
    for label, pts in groups:
        if not pts:
            continue
        cells = []
        for _, rule, tg in EXITS:
            pnl = [forward(sn, k, en, rule, tg) for (sn, k, en) in pts]
            cells.append(f"{sum(pnl) / len(pnl):+7.2%} ({sum(p > 0 for p in pnl) / len(pnl):3.0%})")
        print(f"  {label:16} {len(pts):5,}" + ''.join(f"{c:>21}" for c in cells))


def by_touch(evs, k):
    return [e for e in evs if (e['touch'] == k if k < 3 else e['touch'] >= 3)]


def report(events, base):
    alerts = [e for e in events if not e['through']]
    print(f"\nsetups {len(events):,} on {len({(e['ticker'], e['day']) for e in events}):,} ticker-days; "
          f"{sum(e['through'] for e in events):,} went straight through the line (no alert)")
    print("\nBy touch number (alerts; 'through' events excluded)")
    for k in (1, 2, 3):
        thr = [e for e in by_touch(events, k) if e['through']]
        line(f"touch {k}{'+' if k == 3 else ''}", [e['race'] for e in by_touch(alerts, k)], f"   through {len(thr):,}")
    line('baseline (near line)', base)
    print("\nEntry at the line instead (limit at line × 1.005 after the alert)")
    for k in (1, 2, 3):
        sel = by_touch(alerts, k)
        filled = [e['at_line']['race'] for e in sel if e['at_line']['race'] is not None]
        line(f"touch {k}{'+' if k == 3 else ''} filled {len(filled) / max(1, len(sel)):.0%}", filled)
    first = by_touch(alerts, 1)
    split('Touch 1 by stretch above the line before the pullback', first,
          lambda e: bucket(e['stretch'], [0.2, 0.3, 0.5, 1.0], ['a <20%', 'b 20-30%', 'c 30-50%', 'd 50-100%', 'e 100%+']))
    split('Touch 1 by time of day (ET)', first, lambda e: tod(e['t0']))
    split('Touch 1 by minutes from the peak to the alert', first,
          lambda e: bucket(e['from_peak'], [3, 10, 30, 60], ['a <3', 'b 3-10', 'c 10-30', 'd 30-60', 'e 60+']))
    split('Touch 1 by pullback volume ÷ impulse volume (per bar)', first,
          lambda e: None if e['vol_ratio'] is None else bucket(e['vol_ratio'], [0.25, 0.5, 1.0], ['a <0.25', 'b 0.25-0.5', 'c 0.5-1', 'd >1']))
    split('Touch 1 by arm minutes after the line was anchored (≤2 = anchored mid-move)', first,
          lambda e: None if e['arm_after_sight'] is None else bucket(e['arm_after_sight'], [3, 15, 60], ['a ≤2', 'b 3-14', 'c 15-59', 'd 60+']))
    split('Touch 1 by runner (≥ +30% on an earlier day in the last 30)', first, lambda e: 'runner' if e['runner'] else 'fresh')
    split('Touch 1 by float', first,
          lambda e: None if e['flt'] is None else bucket(e['flt'], [2, 5, 10, 20], ['a <2M', 'b 2-5M', 'c 5-10M', 'd 10-20M', 'e 20M+']))
    split('Touch 1 by price at the alert', first, lambda e: bucket(e['entry'], [1, 2, 5, 10], ['a <1', 'b 1-2', 'c 2-5', 'd 5-10', 'e 10+']))
    split('Touch 1 by month (stability)', first, lambda e: e['day'].strftime('%Y-%m'))
    split('Touch 1 by grade at the alert (grade persisted since 2026-10-01)', first,
          lambda e: e['grade'] if e['grade'] not in (None, '') else None)


def compact(label, events, base):
    alerts = [e for e in events if not e['through']]
    parts = []
    for k in (1, 2, 3):
        s = summarize([e['race'] for e in by_touch(alerts, k)])
        if s:
            parts.append(f"t{k}{'+' if k == 3 else ''} {s['n']:5,} win {s['win']:5.1%} brk {s['broke']:5.1%} P&L {s['pnl']:+5.2%}")
    b = summarize(base)
    print(f"  {label:12} " + ' | '.join(parts) + (f" | base win {b['win']:4.1%} P&L {b['pnl']:+5.2%}" if b else ''))


GRADE_RANK = {g: i for i, g in enumerate(['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C', 'D'])}


def grade_group(e):
    g = e['grade']
    if g in (None, ''):
        return None
    return 'a B+ or better' if GRADE_RANK.get(g, 9) <= GRADE_RANK['B+'] else 'b B or worse'


def chg_group(e):
    return None if e['chg'] is None else bucket(e['chg'], [30, 60, 100, 200], ['a <30%', 'b 30-60%', 'c 60-100%', 'd 100-200%', 'e 200%+'])


if args.cap_strong:
    # 2026-10-10 (operator, after WFF's year-line pullback at 12:35 ET ran +40%
    # past the cap): "we should not limit pullbacks or increase the cap at least
    # for session top gainers maybe? Or at least, for >B grades?" — the touches
    # the v15 cap blocks (2 failures per line per day), split by strength at the
    # alert. Session line only (the one our data can rebuild).
    runs = {}
    for name, cap in (('capped', 2), ('uncapped', 99)):
        args.cap, args.cap_on = cap, 'failures'
        evs, _ = run(ARM)
        runs[name] = [e for e in evs if not e['through']]
    key = lambda e: (e['ticker'], e['day'], e['t0'])
    kept = {key(e) for e in runs['capped']}
    blocked = [e for e in runs['uncapped'] if key(e) not in kept]
    days = len({e['day'] for e in runs['uncapped']})
    pts = lambda evs: [(e['seen'], e['k'], e['entry']) for e in evs]
    s_all = summarize([e['race'] for e in runs['capped']])
    s_blk = summarize([e['race'] for e in blocked])
    print(f"\nAlerts the cap keeps: {len(runs['capped']):,} ({len(runs['capped']) / days:.1f}/day), win {s_all['win']:.1%}")
    print(f"Touches the cap blocks: {len(blocked):,} ({len(blocked) / days:.1f}/day), win {s_blk['win']:.1%}, broke {s_blk['broke']:.1%}")
    exit_grid('Blocked vs kept, overall', [('kept (cap 2)', pts(runs['capped'])), ('blocked', pts(blocked))])
    for title, fn in (('change % at the alert', chg_group), ('grade at the alert (stored since 10-01)', grade_group)):
        groups = defaultdict(list)
        kept_g = defaultdict(list)
        for e in blocked:
            g = fn(e)
            if g is not None:
                groups[g].append(e)
        for e in runs['capped']:
            g = fn(e)
            if g is not None:
                kept_g[g].append(e)
        rows = []
        for g in sorted(set(groups) | set(kept_g)):
            rows.append((f'blocked {g}', pts(groups.get(g, []))))
            rows.append((f'  kept {g}', pts(kept_g.get(g, []))))
        exit_grid(f'By {title}', rows)
    strong = [e for e in blocked if e['chg'] is not None and e['chg'] >= 100]
    exit_grid('Blocked, change ≥ +100%: by month', [(m, pts([e for e in strong if e['day'].strftime('%Y-%m') == m]))
                                                     for m in sorted({e['day'].strftime('%Y-%m') for e in strong})])
    exit_grid('Blocked, change ≥ +100%: by time of day (ET)', [(b, pts([e for e in strong if tod(e['t0']) == b]))
                                                                for b in sorted({tod(e['t0']) for e in strong})])
    if args.list:
        hm = lambda m: f"{m // 60:02d}:{m % 60:02d}"
        for e in blocked:
            if args.list.upper() in ('ALL', e['ticker']):
                print(f"  ✗ {e['ticker']:6} {e['day']} {hm(e['t0'])} touch {e['touch']} chg {e['chg'] if e['chg'] is not None else float('nan'):+.0f}% "
                      f"grade {e['grade'] or '-':3} entry {e['entry']:.4g} → {e['race'].out} {e['race'].pnl:+.1%} mfe {e['race'].mfe:+.1%}")
    sys.exit(0)

if args.cap_compare:
    # The cap modes head to head (2026-10-07, after BIYA: its session line's first
    # touch crashed straight through, used one of the two failures, and the cap
    # then blocked a 14:22 pullback that ran +19%). Same data, same exits; only
    # what the cap counts changes.
    cap = args.cap if args.cap != 99 else 2
    runs = {}
    for mode in ('touches', 'failures', 'broken'):
        args.cap, args.cap_on = cap, mode
        evs, _ = run(ARM)
        runs[mode] = [e for e in evs if not e['through']]
    days = len({e['day'] for evs in runs.values() for e in evs})
    key = lambda e: (e['ticker'], e['day'], e['t0'])
    pts = lambda evs: [(e['seen'], e['k'], e['entry']) for e in evs]
    print(f"\nCap {cap} per line per day, by what it counts ({days} days with alerts)")
    for mode, evs in runs.items():
        s = summarize([e['race'] for e in evs])
        print(f"  {mode:9} {len(evs):6,} alerts  {len(evs) / days:5.1f}/day  win {s['win']:5.1%}  broke {s['broke']:5.1%}")
    groups = [(mode, pts(evs)) for mode, evs in runs.items()]
    base_keys = {key(e) for e in runs['failures']}
    extra = [e for e in runs['broken'] if key(e) not in base_keys]
    gone = [e for e in runs['failures'] if key(e) not in {key(x) for x in runs['broken']}]
    groups.append(('broken − failures', pts(extra)))
    if gone:
        groups.append(('failures − broken', pts(gone)))
    exit_grid(f'Cap {cap} — trading every alert', groups)
    if extra:
        s = summarize([e['race'] for e in extra])
        print(f"\n'broken' adds {len(extra):,} alerts ({len(extra) / days:.1f}/day): win {s['win']:.1%}, broke {s['broke']:.1%}; "
              f"touch numbers {sorted(Counter(e['touch'] for e in extra).items())}")
        exit_grid("The added alerts by month", [(m, pts([e for e in extra if e['day'].strftime('%Y-%m') == m]))
                                                for m in sorted({e['day'].strftime('%Y-%m') for e in extra})])
        exit_grid("The added alerts by time of day (ET)", [(b, pts([e for e in extra if tod(e['t0']) == b]))
                                                          for b in sorted({tod(e['t0']) for e in extra})])
    if args.list:
        hm = lambda m: f"{m // 60:02d}:{m % 60:02d}"
        for e in extra:
            if args.list.upper() in ('ALL', e['ticker']):
                print(f"  + {e['ticker']:6} {e['day']} {hm(e['t0'])} touch {e['touch']} entry {e['entry']:.4g} line {e['line']:.4g} "
                      f"→ {e['race'].out} {e['race'].pnl:+.1%} mfe {e['race'].mfe:+.1%}")
    sys.exit(0)

events, base = run(ARM)
report(events, base)
alerts = [e for e in events if not e['through']]
pts = lambda evs: [(e['seen'], e['k'], e['entry']) for e in evs]
exit_grid('Trading the alert (enter at the PULLBACK close)', [
    ('touch 1', pts(by_touch(alerts, 1))), ('touch 2', pts(by_touch(alerts, 2))), ('touch 3+', pts(by_touch(alerts, 3))),
    ('baseline', [(r.seen, r.k, r.entry) for r in base])])
exit_grid('Touch 1 by month', [(m, pts([e for e in by_touch(alerts, 1) if e['day'].strftime('%Y-%m') == m]))
                               for m in sorted({e['day'].strftime('%Y-%m') for e in alerts})])
exit_grid('Touch 1 by time of day (ET)', [(b, pts([e for e in by_touch(alerts, 1) if tod(e['t0']) == b]))
                                          for b in sorted({tod(e['t0']) for e in alerts})])

if args.grid:
    print(f"\nGrid — break tolerance (arm {ARM:.0%})")
    for brk in (0, 1, 2, 3, 5):
        BRK = brk / 100
        compact(f"brk {brk}%", *run(ARM))
    BRK = args.brk / 100
    print(f"\nGrid — arm stretch (brk {BRK:.0%})")
    for arm in (10, 15, 20, 30, 50):
        compact(f"arm {arm}%", *run(arm / 100))

if args.list:
    want = args.list.upper()
    print('\nSetups')
    hm = lambda m: f"{m // 60:02d}:{m % 60:02d}" if m is not None else '--:--'
    for e in events:
        if want != 'ALL' and e['ticker'] != want:
            continue
        r, a = e['race'], e['at_line']['race']
        print(f"  {e['ticker']:6} {e['day']} {hm(e['t0'])} touch {e['touch']} entry {e['entry']:.4g} line {e['line']:.4g} "
              f"stretch {e['stretch']:+.0%} peak→alert {e['from_peak']}m → {r.out} {hm(r.t_out)} {r.pnl:+.1%} mfe {r.mfe:+.1%}"
              + (f" | at-line {a.out} {hm(a.t_out)} {a.pnl:+.1%}" if a else ''))
