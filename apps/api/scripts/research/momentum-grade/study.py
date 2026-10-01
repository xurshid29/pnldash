# Momentum letter-grade study — fit on one month, test on the next.
#
#   python study.py <data_dir> [fit_end=2026-08-31] [parity_days=2026-09-15,2026-09-24]
#
# <data_dir> must hold rows.csv.gz and news.csv.gz from export-rows.sql /
# export-news.sql (see README.md). Needs only `pip install duckdb`.
#
# Unit  = one Momentum row per 20s cycle (what the dashboard displays).
# Label = price touches +10% above the current price within 30 min while still
#         on our screen. Points = smoothed log-odds lift per feature bucket,
#         fitted on rows up to fit_end; letters cut at the fit window's
#         percentiles of the 6-cycle rolling mean; everything after fit_end
#         is reported out-of-sample. Writes model.json (paste POINTS/CUTS into
#         apps/api/src/services/momentum-grade.ts) and parity.csv (replay with
#         scripts/verify-momentum-grade.ts to prove the TS port matches).
import duckdb, json, math, sys

D = sys.argv[1]
FIT_END = sys.argv[2] if len(sys.argv) > 2 else '2026-08-31'
PARITY_DAYS = (sys.argv[3] if len(sys.argv) > 3 else '2026-09-15,2026-09-24').split(',')

con = duckdb.connect()
q = lambda sql: con.execute(sql).fetchall()
con.execute(f"create table raw as select * from read_csv_auto('{D}/rows.csv.gz', header=true)")
con.execute(f"create table news as select * from read_csv_auto('{D}/news.csv.gz', header=true)")
con.execute("""
create table r2 as
select row_number() over () as id, ticker, ts, price, change_pct as chg, float_m,
       rel_vol_1min as rv1, rel_vol_5min as rv5, accel_delta as acc, above_vwap as av, heat,
       cast(timezone('America/New_York', to_timestamp(ts)) as date) as day,
       hour(timezone('America/New_York', to_timestamp(ts))) * 60 + minute(timezone('America/New_York', to_timestamp(ts))) as tmin
from raw""")
con.execute("""
create table fw as
select id, max(price) over w30 as fmax30, min(price) over w30 as fmin30, max(price) over w60 as fmax60,
       (ts - min(ts) over (partition by ticker, day)) / 60.0 as age_min
from r2
window w30 as (partition by ticker, day order by ts range between 1 following and 1800 following),
       w60 as (partition by ticker, day order by ts range between 1 following and 3600 following)""")
# Catalyst known at t: best non-bearish classified article in the prior 16h + count of all linked articles.
con.execute("""
create table nb as
select r2.id, max(n.impact_score) filter (where n.direction is distinct from 'bearish') as imp, count(*) as n_news
from r2 join news n on n.ticker = r2.ticker and n.pub_ts <= r2.ts and n.pub_ts > r2.ts - 57600
group by r2.id""")
# Bucket CASEs — momentum-grade.ts gradeBuckets() mirrors these exactly.
con.execute(f"""
create table x as
select r2.*, fw.age_min, nb.imp, coalesce(nb.n_news, 0) as n_news,
  coalesce(fw.fmax30 / r2.price - 1 >= 0.10, false) as hit,
  coalesce(fw.fmax60 / r2.price - 1 >= 0.20, false) as hit20,
  coalesce(fw.fmin30 / r2.price - 1 <= -0.10, false) as dd10,
  case when day <= date '{FIT_END}' then 'train' else 'test' end as split,
  case when chg is null then 'chg ?' when chg < 10 then 'chg a <10' when chg < 20 then 'chg b 10-20'
       when chg < 50 then 'chg c 20-50' when chg < 100 then 'chg d 50-100' else 'chg e 100+' end as b_chg,
  case when float_m is null then 'flt ?' when float_m < 2 then 'flt a <2M' when float_m < 5 then 'flt b 2-5M'
       when float_m < 10 then 'flt c 5-10M' when float_m < 20 then 'flt d 10-20M' else 'flt e 20M+' end as b_flt,
  case when price < 1 then 'px a <1' when price < 2 then 'px b 1-2' when price < 5 then 'px c 2-5'
       when price <= 20 then 'px d 5-20' else 'px e 20+' end as b_px,
  case when tmin < 420 then 'tod a PM<7' when tmin < 570 then 'tod b PM 7-9:30' when tmin < 660 then 'tod c 9:30-11'
       when tmin < 960 then 'tod d 11-16' else 'tod e AH' end as b_tod,
  case when nb.imp is null and coalesce(nb.n_news, 0) = 0 then 'cat a none' when nb.imp is null then 'cat b bearish/unscored'
       when nb.imp < 40 then 'cat c weak' when nb.imp < 70 then 'cat d strong' else 'cat e major' end as b_cat,
  case when fw.age_min < 5 then 'age a <5m' when fw.age_min < 15 then 'age b 5-15m' when fw.age_min < 60 then 'age c 15-60m'
       else 'age d 60m+' end as b_age,
  case when acc is null then 'acc ?' when acc > 2 then 'acc a >2' when acc > 0 then 'acc b 0-2' else 'acc c <=0' end as b_acc,
  case when rv1 is null or rv5 is null then 'vol ?' when rv1 >= 4000 and rv5 >= 5000 then 'vol a burst'
       when rv5 > 0 and rv1 < 0.5 * rv5 then 'vol c drying' else 'vol b normal' end as b_vol,
  case when av is null then 'vwap ?' when av then 'vwap a above' else 'vwap b below' end as b_vwap
from r2 join fw using (id) left join nb using (id)""")

base = q("select avg(hit::int) from x where split='train'")[0][0]
print(f"fit rows {q('select count(*) from x where split=$$train$$')[0][0]:,} base {100*base:.1f}% | "
      f"test rows {q('select count(*) from x where split=$$test$$')[0][0]:,} base {100*q('select avg(hit::int) from x where split=$$test$$')[0][0]:.1f}%")

FEATS = ['b_chg', 'b_flt', 'b_px', 'b_tod', 'b_cat', 'b_age', 'b_acc', 'b_vol', 'b_vwap']
A = 200
logit = lambda p: math.log(p / (1 - p))
points = {}
for f in FEATS:
    for b, n, h in q(f"select {f}, count(*), sum(hit::int) from x where split='train' group by 1 order by 1"):
        points[b] = round(logit((h + A * base) / (n + A)) - logit(base), 2)
whens = " ".join(f"when '{b}' then {p}" for b, p in points.items())
score = " + ".join(f"(case {f} {whens} else 0 end)" for f in FEATS)
con.execute(f"""create table v as select *, avg({score}) over (partition by ticker, day order by ts rows between 5 preceding and current row) as m6 from x""")
LETTERS = [('A+', 0.97), ('A', 0.93), ('A-', 0.88), ('B+', 0.80), ('B', 0.70), ('B-', 0.60), ('C', 0.35)]
cuts = [(L, float(q(f"select quantile_cont(m6, {p}) from v where split='train'")[0][0])) for L, p in LETTERS]
case = "case " + " ".join(f"when m6 >= {c} then '{L}'" for L, c in cuts) + " else 'D' end"
con.execute(f"create table gv as select *, {case} as g from v")

order = {L: i for i, (L, _) in enumerate(LETTERS + [('D', 0)])}
print("\nOUT-OF-SAMPLE by letter:  share  +10%/30m  +20%/60m  -10%/30m")
tot = q("select count(*) from gv where split='test'")[0][0]
for g, n, h, h2, dd in sorted(q("select g, count(*), avg(hit::int), avg(hit20::int), avg(dd10::int) from gv where split='test' group by 1"), key=lambda r: order[r[0]]):
    print(f"  {g:3s} {100*n/tot:6.1f}% {100*h:8.1f}% {100*h2:8.1f}% {100*dd:8.1f}%")
thr = q("select quantile_cont(coalesce(heat, 0), 0.88) from v where split='test'")[0][0]
a_hit = q("select avg(hit::int) from gv where split='test' and g in ('A+','A','A-')")[0][0]
heat_hit = q(f"select avg(hit::int) from v where split='test' and coalesce(heat, 0) >= {thr}")[0][0]
print(f"A-tier {100*a_hit:.1f}% vs Heat top-12% {100*heat_hit:.1f}%")

con.execute("""create table ft as
  select a.id, min(b.ts) filter (where b.price >= a.price * 1.10) as t_up, min(b.ts) filter (where b.price <= a.price * 0.90) as t_dn
  from gv a join r2 b on b.ticker = a.ticker and b.day = a.day and b.ts > a.ts and b.ts <= a.ts + 1800
  where a.split = 'test' group by a.id""")
print("\nOUT-OF-SAMPLE first touch within 30 min:  +10% first  -10% first")
for g, up, dn in sorted(q("""select g.g, avg((ft.t_up is not null and (ft.t_dn is null or ft.t_up < ft.t_dn))::int),
                                  avg((ft.t_dn is not null and (ft.t_up is null or ft.t_dn < ft.t_up))::int)
                           from gv g left join ft using (id) where g.split='test' group by 1"""), key=lambda r: order[r[0]]):
    print(f"  {g:3s} {100*(up or 0):10.1f}% {100*(dn or 0):10.1f}%")

json.dump({'fit_end': FIT_END, 'points': points, 'cuts_m6': cuts}, open(f"{D}/model.json", 'w'), indent=1)
days = ", ".join(f"date '{d}'" for d in PARITY_DAYS)
con.execute(f"""copy (select ticker, day, ts, chg, float_m, price, tmin, imp, n_news, age_min, acc, rv1, rv5, av, round(m6, 4) as m6, g
                     from gv where day in ({days}) order by day, ticker, ts) to '{D}/parity.csv' (header)""")
print(f"\nwrote {D}/model.json and {D}/parity.csv")
