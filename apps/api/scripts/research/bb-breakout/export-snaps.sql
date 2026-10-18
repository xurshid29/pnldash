-- Our 20s Momentum rows on those ticker-days (grade, session VWAP). Read-only, ~40 s,
-- ~17 MB gzipped for 20 sessions. Run outside 07:00–11:00 ET. Edit the range.
SET random_page_cost = 1.1;
COPY (
  select sr.ticker, extract(epoch from c.polled_at)::bigint as ts, sr.price, sr.vwap, sr.change_pct, sr.grade, sr.rel_vol_1min, sr.float_m
  from screener_results sr
  join screener_cycles c on c.id = sr.cycle_id
  join screener_ticker_days d on d.ticker = sr.ticker
    and d.et_date = (c.polled_at at time zone 'America/New_York')::date and d.max_chg >= 20
  where c.polled_at >= timestamptz '2026-09-21 04:00 America/New_York'
    and c.polled_at <  timestamptz '2026-10-17 04:00 America/New_York'
    and sr.price > 0
) TO STDOUT WITH CSV HEADER;
