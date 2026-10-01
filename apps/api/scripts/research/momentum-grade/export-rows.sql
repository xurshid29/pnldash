COPY (
  select sr.ticker, extract(epoch from c.polled_at)::bigint as ts, sr.price, sr.change_pct, sr.float_m, sr.float_is_proxy,
         sr.rel_volume, sr.rel_vol_1min, sr.rel_vol_5min, sr.accel_delta, sr.above_vwap, sr.heat, sr.volume, sr.status
  from screener_results sr join screener_cycles c on c.id = sr.cycle_id
  where c.polled_at >= timestamp '2026-08-03' and c.polled_at < timestamp '2026-10-01' and sr.price > 0
) TO STDOUT WITH CSV HEADER;
