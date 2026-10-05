# VWAP base breakout study — "how could we catch SDEV 05:00–05:30?" (operator, 2026-10-05)
#
#   python base_study.py <rows.csv.gz> [--n 15] [--range 4] [--volx 2] [--list TICKER|all]
#
# Same rows as study.py (export-rows.sql). SDEV on 2026-10-05 reclaimed its
# session VWAP at 04:51 ET, sat on it for 30 min in a 3% range (9.06–9.35) as
# volume dried up, broke the range high at 05:27 on 3–4× volume and ran to 10.48
# by 05:39, then 12.3 at 06:17. Neither 📐 setup sees that: PULLBACK needs a
# +15% stretch first, RECLAIM watches the month line.
#
# Base      the n bars before bar i span at most --range % (highest high ÷
#           lowest low), with no gap over 3 min. Where the base sits is the
#           mean close vs the session VWAP: under (< −1.5%), ON the line
#           (−1.5…+3%), above (+3…+10%), far above (> +10%).
# Breakout  bar i closes above the base high +0.3% on a bar volume ≥ --volx ×
#           the base's average. One per base: the next needs n fresh bars.
# Trade     enter at the breakout close; stop 0.5% under the base low (filled
#           at the stop, or the bar's open if it gapped under); +10% / +20% /
#           no target; out at the close 60 min later. "Win" = +10% first.
import argparse, collections, duckdb, statistics

ap = argparse.ArgumentParser()
ap.add_argument('rows')
ap.add_argument('--n', type=int, default=15, help='base length, 1m bars')
ap.add_argument('--range', type=float, default=4.0, help='max base range, %%')
ap.add_argument('--volx', type=float, default=2.0, help='breakout bar volume ÷ base average')
ap.add_argument('--list', help="print every breakout for a ticker, or 'all'")
args = ap.parse_args()
N, RNG, VOLX = args.n, args.range / 100, args.volx
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
       arg_max(vwap, ts) as vw, arg_max(volume, ts) as vol, arg_max(chg, ts) as chg
from t where hour(et) * 60 + minute(et) between 240 and 1199
group by all""")


def bucket(v, edges, labels):
    for e, lab in zip(edges, labels):
        if v < e:
            return lab
    return labels[-1]


def tod(t):
    return bucket(t, [420, 570, 630, 720, 960], ['a 04-07', 'b 07-09:30', 'c 09:30-10:30', 'd 10:30-12', 'e 12-16', 'f AH'])


def forward(seen, k, entry, stop, target):
    t0, last_t, last_c = seen[k][0], seen[k][0], entry
    for j in range(k + 1, len(seen)):
        t, o, h, l, c, vw, bv = seen[j]
        if t - last_t > MAX_GAP:
            break
        if l <= stop:
            return min(o, stop) / entry - 1
        if target and h >= entry * (1 + target):
            return target
        if t - t0 >= HORIZON:
            return c / entry - 1
        last_t, last_c = t, c
    return last_c / entry - 1


def mfe(seen, k, entry, stop):
    best, t0 = 0.0, seen[k][0]
    for j in range(k + 1, len(seen)):
        t, o, h, l, c, vw, bv = seen[j]
        if t - seen[j - 1][0] > MAX_GAP or t - t0 > HORIZON:
            break
        best = max(best, h / entry - 1)
        if l <= stop:
            break
    return best


def run_day(key, rows, out):
    seen, prev_vol = [], None
    chg_at = {}
    for (t, o, h, l, c, vw, vol, chg) in rows:
        chg_at[t] = chg
        bv = 0 if (prev_vol is None or vol is None) else max(0, vol - prev_vol)
        if vol is not None:
            prev_vol = vol
        if vw and vw > 0 and h is not None:
            seen.append((t, o, h, l, c, vw, bv))
    cool = -1
    for i in range(N, len(seen)):
        if i <= cool:
            continue
        win = seen[i - N:i]
        if any(win[j][0] - win[j - 1][0] > MAX_GAP for j in range(1, N)) or seen[i][0] - win[-1][0] > MAX_GAP:
            continue
        hi, lo = max(b[2] for b in win), min(b[3] for b in win)
        if hi / lo - 1 > RNG:
            continue
        t, o, h, l, c, vw, bv = seen[i]
        avg = sum(b[6] for b in win) / N
        if not (c > hi * 1.003 and avg > 0 and bv >= VOLX * avg):
            continue
        pre = [b[6] for b in seen[max(0, i - N - 30):i - N]]
        pos = statistics.mean(b[4] / b[5] - 1 for b in win)
        stop = lo * (1 - SLIP)
        out.append(dict(ticker=key[0], day=key[1], t=t, entry=c, hi=hi, lo=lo, line=vw, pos=pos, rng=hi / lo - 1, chg=chg_at.get(t),
                        dry=(avg / (sum(pre) / len(pre))) if pre and sum(pre) > 0 else None, volx=bv / avg,
                        risk=c / stop - 1, seen=seen, k=i, stop=stop))
        cool = i + N


def run():
    out, key, rows = [], None, []
    cur = con.execute("select ticker, day, tmin, o, h, l, c, vw, vol, chg from bars order by ticker, day, tmin")
    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk:
            break
        for r in chunk:
            k = (r[0], r[1])
            if k != key:
                if rows:
                    run_day(key, rows, out)
                key, rows = k, []
            rows.append(r[2:])
    if rows:
        run_day(key, rows, out)
    return out


def line(label, evs):
    if not evs:
        return
    cells = []
    for tg in (0.10, 0.20, None):
        p = [forward(e['seen'], e['k'], e['entry'], e['stop'], tg) for e in evs]
        cells.append(f"{sum(p) / len(p):+6.2%} ({sum(x > 0 for x in p) / len(p):3.0%})")
    win = sum(forward(e['seen'], e['k'], e['entry'], e['stop'], 0.10) >= 0.0999 for e in evs) / len(evs)
    risk = statistics.median(e['risk'] for e in evs)
    m = statistics.median(mfe(e['seen'], e['k'], e['entry'], e['stop']) for e in evs)
    print(f"  {label:30} {len(evs):5,}  win {win:5.1%}  risk {risk:4.1%}  med MFE {m:+5.1%}   "
          f"+10% {cells[0]}   +20% {cells[1]}   no target {cells[2]}")


def split(title, evs, fn):
    print(f"\n{title}")
    g = collections.defaultdict(list)
    for e in evs:
        k = fn(e)
        if k is not None:
            g[k].append(e)
    for k in sorted(g):
        line(k, g[k])


ev = run()
days = len({(e['ticker'], e['day']) for e in ev})
print(f"base {N} bars ≤{RNG:.0%} range, breakout close > high +0.3% on ≥{VOLX:g}× volume | {len(ev):,} breakouts on {days:,} ticker-days")
print("  columns: n, +10% before the stop, median risk to the stop, median best move in 60 min, mean P&L (share > 0) by target")
POS = lambda e: bucket(e['pos'], [-0.015, 0.03, 0.10], ['a under the line', 'b ON the line', 'c above (3-10%)', 'd far above (>10%)'])
split('By where the base sits vs the session VWAP', ev, POS)
on = [e for e in ev if -0.015 <= e['pos'] < 0.03]
split('ON the line — by time of day (ET)', on, lambda e: tod(e['t']))
split('ON the line — by base range', on, lambda e: bucket(e['rng'], [0.02, 0.03], ['a ≤2%', 'b 2-3%', 'c 3-4%']))
split('ON the line — by volume dry-up (base ÷ the 30 bars before)', on,
      lambda e: None if e['dry'] is None else bucket(e['dry'], [0.5, 1.0], ['a <0.5 dried up', 'b 0.5-1', 'c >1']))
split('ON the line — by breakout volume', on, lambda e: bucket(e['volx'], [3, 5], ['a 2-3x', 'b 3-5x', 'c 5x+']))
split('ON the line — by month', on, lambda e: e['day'].strftime('%Y-%m'))
CHG = lambda e: None if e['chg'] is None else bucket(e['chg'], [30, 50, 100], ['a +20-30%', 'b +30-50%', 'c +50-100%', 'd +100%+'])
split('ON the line — by the day change at the breakout', on, CHG)
split('ON the line, 09:30-10:30 — by the day change', [e for e in on if 570 <= e['t'] < 630], CHG)
split('ON the line, 07:00-10:30 and up ≥ +50% on the day — by month', [e for e in on if 420 <= e['t'] < 630 and (e['chg'] or 0) >= 50],
      lambda e: e['day'].strftime('%Y-%m'))
split('All bases — by month', ev, lambda e: e['day'].strftime('%Y-%m'))
if args.list:
    print('\nBreakouts')
    hm = lambda m: f"{m // 60:02d}:{m % 60:02d}"
    for e in ev:
        if args.list.upper() != 'ALL' and e['ticker'] != args.list.upper():
            continue
        p = forward(e['seen'], e['k'], e['entry'], e['stop'], 0.10)
        print(f"  {e['ticker']:6} {e['day']} {hm(e['t'])} entry {e['entry']:.4g} base {e['lo']:.4g}-{e['hi']:.4g} "
              f"({e['rng']:.1%}) vs line {e['pos']:+.1%} vol {e['volx']:.1f}x → {p:+.1%}")
