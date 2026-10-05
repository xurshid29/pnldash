-- Every Momentum row with the stored session VWAP (persisted since 2026-06-12).
-- Read-only; a sequential scan of screener_results (~11M rows for the range,
-- ~150 MB gzipped). Run outside 07:00–11:00 ET. Edit the range first.
COPY (
  select sr.ticker, extract(epoch from c.polled_at)::bigint as ts, sr.price, sr.volume, sr.vwap,
         sr.change_pct, sr.float_m, sr.grade
  from screener_results sr join screener_cycles c on c.id = sr.cycle_id
  where c.polled_at >= timestamp '2026-06-12' and c.polled_at < timestamp '2026-10-06' and sr.price > 0
) TO STDOUT WITH CSV HEADER;
