-- Every live 📐 TradingView signal (tier_events tier 'alert', event 'tv_setup').
-- Read-only and small (~1,000 rows a day). Feeds grade_live.py.
COPY (
  select id, ticker, extract(epoch from at)::bigint as ts, meta::text as meta
  from tier_events
  where tier = 'alert' and event = 'tv_setup'
  order by at
) TO STDOUT WITH CSV HEADER;
