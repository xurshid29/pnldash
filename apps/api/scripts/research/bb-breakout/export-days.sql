-- The study's universe: every weekday ticker-day that reached +20% on our screen. Edit the range.
COPY (select ticker, et_date, max_chg from screener_ticker_days
      where et_date >= date '2026-09-21' and et_date <= date '2026-10-16' and max_chg >= 20
        and extract(isodow from et_date) <= 5 order by et_date, ticker) TO STDOUT WITH CSV HEADER;
