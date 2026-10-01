# Momentum grade — research pipeline

How the Momentum table's letter grade (A+ … D, `services/momentum-grade.ts`)
was fitted and validated, and how to re-fit it. Every number in
`POINTS` / `GRADE_CUTS` is an output of this pipeline — re-fit here rather
than hand-editing.

## 1. Export (read-only, from the droplet)

Run outside the busy premarket window; it is a sequential scan of
`screener_results` (~6.6M rows for two months, ~80 MB gzipped).

```bash
cd apps/api/scripts/research/momentum-grade
mkdir -p /tmp/grade
ssh root@<droplet> 'cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash -q | gzip -1' < export-rows.sql > /tmp/grade/rows.csv.gz
ssh root@<droplet> 'cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash -q | gzip -1' < export-news.sql > /tmp/grade/news.csv.gz
```

Edit the date range in both SQL files first (fit month + test month).

## 2. Fit + out-of-sample test

```bash
python3 -m venv /tmp/grade/venv && /tmp/grade/venv/bin/pip install duckdb
/tmp/grade/venv/bin/python study.py /tmp/grade 2026-08-31 2026-09-15,2026-09-24
```

Prints the out-of-sample table by letter, the A-tier vs Heat comparison and
the +10%-vs-−10% first-touch race, and writes `model.json` + `parity.csv`.

## 3. Port + prove parity

Paste `points` / `cuts_m6` from `model.json` into `momentum-grade.ts`
(exact cut values — rounding them flips boundary rows), then:

```bash
cd apps/api && npx tsx scripts/verify-momentum-grade.ts /tmp/grade/parity.csv
```

Must report every replayed row's letter matching the study.

## Results of the first fit (2026-10-01)

Fit 2026-08-03…08-31 (3.29M rows), test 2026-09-01…09-30 (3.35M rows).
P(+10% within 30 min) on September: A+ 26.8%, A 18.5%, A− 11.3%, B+ 7.4%,
B 3.8%, B− 1.7%, C 0.3%, D 0.1%. A-tier 17.2% vs Heat's top 12% 13.5%.
First touch within 30 min: A+ 25.0% up / 29.8% down — a two-way market;
A 17.8/15.2, A− 11.0/6.5, B+ 7.3/3.1. Parity: 201,981/201,981 rows.
