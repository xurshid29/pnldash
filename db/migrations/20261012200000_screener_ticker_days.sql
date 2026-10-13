-- migrate:up
-- One row per ticker per ET day it was on our Momentum screen, with the day's
-- highest change % (2026-10-12). Feeds the 📐 TradingView watchlist
-- (GET /api/tv/watchlist): repeat runners from the last 90 days without
-- scanning ~10M screener_results rows per request. Complete days only; the
-- API tops it up with the days missing since the last row, and reads today's
-- names straight from screener_results.
create table screener_ticker_days (
    ticker  text    not null,
    et_date date    not null,
    max_chg numeric not null,
    primary key (ticker, et_date)
);
create index screener_ticker_days_date on screener_ticker_days (et_date);

insert into screener_ticker_days (ticker, et_date, max_chg)
select r.ticker, (c.polled_at at time zone 'America/New_York')::date, max(r.change_pct)
from screener_results r
join screener_cycles c on c.id = r.cycle_id
where r.change_pct is not null
  and c.polled_at < ((now() at time zone 'America/New_York')::date)::timestamp at time zone 'America/New_York'
group by 1, 2;

-- migrate:down
drop table if exists screener_ticker_days;
