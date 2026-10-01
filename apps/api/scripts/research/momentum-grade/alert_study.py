# Opportunity-alert sizing study (2026-10-01) — how often each alert trigger
# would fire and how good the moment was, on the TEST month of study.py.
#
#   python alert_study.py <data_dir> [fit_end] [parity_days]
#
# Needs rows.csv.gz + news.csv.gz (study.py inputs) and news_titles.csv.gz
# from export-news-titles.sql. Runs study.py first (same args) for the graded
# per-cycle table, then measures: A+ entries under several cooldowns, fast
# moves (+X% vs ~60s ago, RVol 1m gate, 15-min cooldown), fresh headlines,
# and the combined/merged daily volume + busiest hour. The thresholds in
# services/opportunity-alerts.ts came from this output.
import sys
exec(open(__file__.replace('alert_study.py', 'study.py')).read())
from collections import defaultdict
import statistics
sep_days = [d[0] for d in q("select distinct day from gv where split='test' and dayofweek(day) between 1 and 5 order by 1")]
ND = len(sep_days)
print(f"September trading days: {ND}")

def cooldown(rows, secs):
    out, last = [], {}
    for r in rows:  # rows sorted by ticker, day, ts; r = (id, ticker, day, ts, ...)
        k = (r[1], r[2])
        if k not in last or r[3] - last[k] >= secs:
            out.append(r); last[k] = r[3]
    return out

def quality(ids, label):
    if not ids:
        print(f"  {label}: none"); return
    con.execute("create or replace temp table ids as select unnest(?) as id", [ids])
    h, up, dn = q("""select avg(g.hit::int),
        avg((ft.t_up is not null and (ft.t_dn is null or ft.t_up < ft.t_dn))::int),
        avg((ft.t_dn is not null and (ft.t_up is null or ft.t_dn < ft.t_up))::int)
      from ids join gv g using (id) left join ft using (id)""")[0]
    per_day = defaultdict(int)
    for (d,) in q("select g.day from ids join gv g using (id)"): per_day[d] += 1
    counts = [per_day.get(d, 0) for d in sep_days]
    print(f"  {label}: {len(ids)/ND:5.1f}/day (busiest day {max(counts)})  +10% in 30m {100*h:4.1f}%  up-first {100*(up or 0):4.1f}%  down-first {100*(dn or 0):4.1f}%")

base_h = q("select avg(hit::int) from gv where split='test'")[0][0]
print(f"baseline any Momentum row: +10% in 30m {100*base_h:.1f}%")

print("\n=== A) grade enters A+ (new on screen or upgraded) ===")
trans = q("""with t as (select id, ticker, day, ts, g, lag(g) over (partition by ticker, day order by ts) pg, age_min, tmin from gv where split='test')
            select id, ticker, day, ts, pg, age_min, tmin from t where g = 'A+' and (pg is null or pg <> 'A+') order by ticker, day, ts""")
for secs, lab in ((0, 'every entry'), (900, '15-min cooldown'), (1800, '30-min cooldown'), (3600, '60-min cooldown'), (10**9, 'once per ticker per day')):
    quality([r[0] for r in cooldown(trans, secs)], lab)
c30 = cooldown(trans, 1800)
print("  30-min cooldown split: new-on-screen (<5 min) %d, upgraded %d; by session PM %d / REG %d / AH %d" % (
    sum(1 for r in c30 if r[5] < 5), sum(1 for r in c30 if r[5] >= 5),
    sum(1 for r in c30 if r[6] < 570), sum(1 for r in c30 if 570 <= r[6] < 960), sum(1 for r in c30 if r[6] >= 960)))

print("\n=== B) existing ticker (on screen >=5 min) moves fast: price up X% within ~60s ===")
con.execute("""create table pm as
  select a.id, a.ticker, a.day, a.ts, a.price, b.price as p60, a.ts - b.ts as lag_s, a.rv1, a.age_min, a.g
  from gv a asof join r2 b on a.ticker = b.ticker and a.day = b.day and b.ts <= a.ts - 55
  where a.split = 'test'""")
for X in (5, 8, 10, 15):
    for rv in (0, 1000, 4000):
        rows = q(f"""select id, ticker, day, ts from pm where lag_s <= 120 and age_min >= 5 and price / p60 - 1 >= {X/100}
                     and coalesce(rv1, 0) >= {rv} order by ticker, day, ts""")
        quality([r[0] for r in cooldown(rows, 900)], f"+{X:>2}% in 60s, RVol1m>={rv:>4}, 15-min cooldown")

print("\n=== C) new headline on a ticker that is on the screen (first sight, published <=30 min before) ===")
con.execute(f"create table nt as select * from read_csv_auto('{D}/news_titles.csv.gz', header=true)")
con.execute("""create table nf as
  select ticker, ntitle, min(fetched_ts) as first_ts, min(pub_ts) as pub_ts, max(impact_score) as imp,
         bool_or(direction = 'bearish') as bear, count(distinct source) as n_src
  from nt group by 1, 2""")
con.execute("""create table nfs as
  select n.*, cast(timezone('America/New_York', to_timestamp(n.first_ts)) as date) as day
  from nf n where exists (select 1 from r2 where r2.ticker = n.ticker and r2.ts between n.first_ts - 60 and n.first_ts + 60)""")
for lab, cond in (("all fresh headlines", "true"), ("fresh, catalyst >= 40 (strong/major)", "imp >= 40"),
                  ("fresh, not bearish", "not coalesce(bear, false)"), ("fresh, >=40 and not bearish", "imp >= 40 and not coalesce(bear, false)")):
    per = dict(q(f"""select day, count(*) from nfs where day >= date '2026-09-01' and pub_ts is not null
                     and pub_ts >= first_ts - 1800 and {cond} group by 1"""))
    counts = [per.get(d, 0) for d in sep_days]
    print(f"  {lab:40s} {sum(counts)/ND:5.1f}/day  (busiest day {max(counts)})")
stale = q("""select count(*) filter (where pub_ts < first_ts - 1800), count(*) from nfs where day >= date '2026-09-01' and pub_ts is not null""")[0]
print(f"  (headlines first seen >30 min after publication — old news found when a ticker appears: {stale[0]} of {stale[1]})")

print("\n=== D) combined: A+ first-of-day + fast (+10%/60s, RVol1m>=1000, 15m cd) + fresh headlines ===")
ap = [(r[1], r[3], 'aplus') for r in cooldown(trans, 10**9)]
fm = [(r[1], r[3], 'fast') for r in cooldown(q("""select id, ticker, day, ts from pm where lag_s <= 120 and age_min >= 5
        and price / p60 - 1 >= 0.10 and coalesce(rv1, 0) >= 1000 order by ticker, day, ts"""), 900)]
nw_all = [(t, ts, 'news') for t, ts in q("""select ticker, first_ts from nfs where day >= date '2026-09-01' and pub_ts is not null and pub_ts >= first_ts - 1800""")]
nw_strong = [(t, ts, 'news') for t, ts in q("""select ticker, first_ts from nfs where day >= date '2026-09-01' and pub_ts is not null and pub_ts >= first_ts - 1800 and imp >= 40""")]
import datetime, zoneinfo
ET = zoneinfo.ZoneInfo('America/New_York')
def merged(events, window):
    events = sorted(events, key=lambda e: (e[0], e[1]))
    out, last = [], {}
    for t, ts, k in events:
        if t in last and ts - last[t] < window: continue
        out.append((t, ts, k)); last[t] = ts
    return out
for lab, ev in (("dashboard (all fresh news)", ap + fm + nw_all), ("phone (news only catalyst>=40)", ap + fm + nw_strong)):
    for w in (0, 300, 600):
        m = merged(ev, w) if w else ev
        hours = defaultdict(int)
        for t, ts, k in m:
            dt = datetime.datetime.fromtimestamp(ts, ET)
            if dt.weekday() < 5: hours[dt.hour] += 1
        peak_h = max(hours, key=hours.get)
        print(f"  {lab:32s} merge {w//60:2d} min: {len(m)/ND:5.1f}/day; busiest hour {peak_h:02d}:00 ET avg {hours[peak_h]/ND:4.1f}/day; 07-11 ET {sum(v for h, v in hours.items() if 7 <= h < 11)/ND:4.1f}/day")
