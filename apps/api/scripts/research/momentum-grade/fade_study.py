# Fade-cap study (2026-10-01, the LONA case) — does an A-tier name that has
# faded from its recent high behave differently? Measured on the first-touch
# race (+10% vs -10% first within 30 min) by distance below the 10-minute
# high, threshold chosen on the FIT month and checked on the TEST month.
#
#   python fade_study.py <data_dir> [fit_end] [parity_days]
#
# Runs study.py first (same args). GRADE_FADE in services/momentum-grade.ts
# (8% / cap B+) came from this output: 8% is where both months turn
# down-first; the cap lifted Sep A-tier up:down 1.12 -> 1.19.
import sys
exec(open(__file__.replace('fade_study.py', 'study.py')).read())

# study.py raced first-touch on the test month only; add the fit month.
con.execute("""insert into ft
  select a.id, min(b.ts) filter (where b.price >= a.price * 1.10), min(b.ts) filter (where b.price <= a.price * 0.90)
  from gv a join r2 b on b.ticker = a.ticker and b.day = a.day and b.ts > a.ts and b.ts <= a.ts + 1800
  where a.split = 'train' group by a.id""")
con.execute("""create table fz as
  select g.id, g.split, g.g, (g.price / hi.hi10 - 1) * 100 as off_hi,
         (ft.t_up is not null and (ft.t_dn is null or ft.t_up < ft.t_dn)) as upfirst,
         (ft.t_dn is not null and (ft.t_up is null or ft.t_dn < ft.t_up)) as dnfirst
  from gv g join hi using (id) left join ft using (id)""")
ORDER = ['>-3', '-3..-5', '-5..-8', '-8..-12', '-12..-20', '<=-20']
print("\n=== A-tier up:down (+10% first vs -10% first) by distance below the 10-min high ===")
for split in ('train', 'test'):
    rows = q(f"""select case when off_hi > -3 then '>-3' when off_hi > -5 then '-3..-5' when off_hi > -8 then '-5..-8'
                              when off_hi > -12 then '-8..-12' when off_hi > -20 then '-12..-20' else '<=-20' end,
                        count(*), avg(upfirst::int), avg(dnfirst::int)
                 from fz where g in ('A+','A','A-') and split = '{split}' group by 1""")
    print(f"  {'FIT ' if split == 'train' else 'TEST'}: " + "   ".join(
        f"{b}: {up/dn:.2f} (n={n:,})" for b, n, up, dn in sorted(rows, key=lambda r: ORDER.index(r[0]))))
print("\n=== A-tier with the cap at each threshold (share of rows, up-first, down-first, up:down) ===")
for split in ('train', 'test'):
    for thr in (None, -5, -8, -12):
        cond = "g in ('A+','A','A-')" + ("" if thr is None else f" and off_hi > {thr}")
        tot = q(f"select count(*) from fz where split = '{split}'")[0][0]
        n, up, dn = q(f"select count(*), avg(upfirst::int), avg(dnfirst::int) from fz where split = '{split}' and {cond}")[0]
        print(f"  {'FIT ' if split == 'train' else 'TEST'} {'no cap' if thr is None else f'cap at {thr}%':>12s}: "
              f"{100*n/tot:4.1f}% of rows  up {100*up:4.1f}%  down {100*dn:4.1f}%  = {up/dn:.2f}")
