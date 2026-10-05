# The 📐 RECLAIM setup on the SESSION VWAP instead of the month line (operator, 2026-10-05:
# "could we do the same with other VWAP anchors, such as session and yearly?").
#
#   python reclaim_session.py <rows.csv.gz> [--list TICKER|all]
#
# Same rows as study.py (export-rows.sql). Runs the script's own reclaim stage
# machine — pinesim.simulate(), current defaults (V7 = v9 logic) — with our
# stored session VWAP as the line, on 1m bars built from the 20s snapshots.
# The year line can't be rebuilt from our rows (like the month line), so only
# the session line is measured here.
#
# Gainer gate: a synthetic prior-day bar carries the prior close implied by the
#   first row's change %, so "day high ≥ +20% vs the prior close" works as in
#   the script. The BB basis warms up on each day's first 20 on-screen bars.
# Trade:  enter at the signal close; stop 0.5% under the session line (filled at
#   the stop, or the bar's open if it gapped under); +10% / +20% / no target;
#   out at the close 60 min later. "Win" = +10% before the stop.
# Baseline: every plain reclaim of the session line (a close above it after
#   ≥5 closes under it) on the same ticker-days — the shape of the ↑ VWAP
#   reclaim layer that graded as noise in August 2026.
import argparse, collections, datetime, duckdb, os, statistics, sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
from pinesim import ET, V7, simulate   # the script's reclaim stage machine

ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--list', help="print every GO for a ticker, or 'all'")
args = ap.parse_args()
MAX_GAP, HORIZON, SLIP = 3, 60, 0.005

con = duckdb.connect()
con.execute(f"create table raw as select * from read_csv_auto('{args.rows}', header=true)")
con.execute("""
create table bars as
with t as (
  select ticker, ts, try_cast(price as double) as price, try_cast(volume as double) as volume,
         try_cast(vwap as double) as vwap, try_cast(change_pct as double) as chg,
         timezone('America/New_York', to_timestamp(ts)) as et
  from raw)
select ticker, cast(et as date) as day, hour(et) * 60 + minute(et) as tmin,
       arg_min(price, ts) as o, max(price) as h, min(price) as l, arg_max(price, ts) as c,
       arg_max(vwap, ts) as vw, arg_max(volume, ts) as vol, arg_min(chg, ts) as chg0
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")


def bucket(v, edges, labels):
    for e, lab in zip(edges, labels):
        if v < e:
            return lab
    return labels[-1]


def tod(m):
    return bucket(m, [420, 570, 630, 720, 960], ['a 04-07', 'b 07-09:30', 'c 09:30-10:30', 'd 10:30-12', 'e 12-16', 'f AH'])


def forward(seen, k, entry, target):
    """seen: [(minute, o, h, l, c, line)]; stop 0.5% under the line on each bar."""
    t0, last_t, last_c = seen[k][0], seen[k][0], entry
    for j in range(k + 1, len(seen)):
        t, o, h, l, c, ln = seen[j]
        if t - last_t > MAX_GAP:
            break
        stop = ln * (1 - SLIP)
        if l <= stop:
            return min(o, stop) / entry - 1
        if target and h >= entry * (1 + target):
            return target
        if t - t0 >= HORIZON:
            return c / entry - 1
        last_t, last_c = t, c
    return last_c / entry - 1


GO, READY, BASE = [], [], []


def run_day(key, rows):
    seen, bars, prev_vol, chg0 = [], [], None, None
    for (t, o, h, l, c, vw, vol, cg) in rows:
        bv = 0 if (prev_vol is None or vol is None) else max(0, vol - prev_vol)
        if vol is not None:
            prev_vol = vol
        if not (vw and vw > 0 and h is not None):
            continue
        if chg0 is None and cg is not None and cg > -99:
            chg0 = cg
        seen.append((t, o, h, l, c, vw))
        bars.append({'t': datetime.datetime.combine(key[1], datetime.time(t // 60, t % 60), ET),
                     'o': o, 'h': h, 'l': l, 'c': c, 'v': bv, 'vw': vw, 'k': len(seen) - 1})
    if len(bars) < 25 or chg0 is None:
        return
    prior_close = bars[0]['c'] / (1 + chg0 / 100)
    prior = {'t': datetime.datetime.combine(key[1] - datetime.timedelta(days=1), datetime.time(15, 59), ET),
             'o': prior_close, 'h': prior_close, 'l': prior_close, 'c': prior_close, 'v': 0, 'vw': None, 'k': None}
    by_t = {b['t']: b for b in bars}
    for (t, stage, path, c, basis, pxb, bb, gain) in simulate([prior] + bars, lambda b: b['vw'], dict(V7)):
        b = by_t.get(t)
        if b is None:
            continue
        ev = dict(ticker=key[0], day=key[1], t=t.hour * 60 + t.minute, entry=c, seen=seen, k=b['k'], path=path)
        (GO if stage == 'GO' else READY if stage == 'READY' else []).append(ev)
    # baseline: plain reclaims of the line after ≥5 closes under it
    under = 0
    for k, (t, o, h, l, c, vw) in enumerate(seen):
        if c < vw:
            under += 1
            continue
        if under >= 5:
            BASE.append(dict(ticker=key[0], day=key[1], t=t, entry=c, seen=seen, k=k))
        under = 0


key, rows = None, []
cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, vol, chg0 from bars order by ticker, day, tmin")
while True:
    chunk = cur.fetchmany(200_000)
    if not chunk:
        break
    for r in chunk:
        k = (r[0], r[1])
        if k != key:
            if rows:
                run_day(key, rows)
            key, rows = k, []
        rows.append(r[2:])
if rows:
    run_day(key, rows)

N_DAYS = con.execute("select count(distinct day) from bars where dayofweek(day) between 1 and 5").fetchone()[0]


def line(label, evs):
    if not evs:
        return
    cells = []
    for tg in (0.10, 0.20, None):
        p = [forward(e['seen'], e['k'], e['entry'], tg) for e in evs]
        cells.append(f"{sum(p) / len(p):+6.2%} ({sum(x > 0 for x in p) / len(p):3.0%})")
    win = sum(forward(e['seen'], e['k'], e['entry'], 0.10) >= 0.0999 for e in evs) / len(evs)
    hold = [hold60(e['seen'], e['k'], e['entry']) for e in evs]
    print(f"  {label:32} {len(evs):6,} ({len(evs) / N_DAYS:4.1f}/day)  win {win:5.1%}   +10% {cells[0]}   +20% {cells[1]}   "
          f"no target {cells[2]}   60-min hold, no stop {sum(hold) / len(hold):+6.2%}")


def hold60(seen, k, entry):
    """No stop, no target: the close 60 min later (or the last close before a gap / the day's end)."""
    t0, last_c, last_t = seen[k][0], entry, seen[k][0]
    for j in range(k + 1, len(seen)):
        t, o, h, l, c, ln = seen[j]
        if t - last_t > MAX_GAP:
            break
        last_t, last_c = t, c
        if t - t0 >= HORIZON:
            break
    return last_c / entry - 1


def split(title, evs, fn):
    print(f"\n{title}")
    g = collections.defaultdict(list)
    for e in evs:
        g[fn(e)].append(e)
    for k in sorted(g):
        line(k, g[k])


print(f"RECLAIM setup on the session VWAP — {N_DAYS} trading days")
print("  columns: signals, +10% before the stop, mean P&L (share > 0) by target; stop 0.5% under the line")
line('GO (the reclaim)', GO)
line('READY', READY)
line('baseline: any reclaim after ≥5 under', BASE)
split('GO by time of day (ET)', GO, lambda e: tod(e['t']))
split('READY by path', READY, lambda e: f"READY {e['path']}")
split('GO by month', GO, lambda e: e['day'].strftime('%Y-%m'))
split('Baseline by time of day (ET)', BASE, lambda e: tod(e['t']))
if args.list:
    print('\nGO signals')
    for e in GO:
        if args.list.upper() != 'ALL' and e['ticker'] != args.list.upper():
            continue
        p = forward(e['seen'], e['k'], e['entry'], 0.10)
        print(f"  {e['ticker']:6} {e['day']} {e['t'] // 60:02d}:{e['t'] % 60:02d} entry {e['entry']:.4g} → {p:+.1%}")
