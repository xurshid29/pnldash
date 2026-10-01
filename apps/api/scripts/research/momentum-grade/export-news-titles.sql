COPY (
  select l.ticker, extract(epoch from a.fetched_at)::bigint as fetched_ts, extract(epoch from a.published_at)::bigint as pub_ts,
         a.source, regexp_replace(lower(a.title), '[^a-z0-9]+', ' ', 'g') as ntitle, nc.impact_score, nc.direction
  from news_ticker_links l join news_articles a on a.id = l.article_id
  left join news_classifications nc on nc.article_id = a.id
  where a.fetched_at >= timestamp '2026-08-03' and a.fetched_at < timestamp '2026-10-01'
) TO STDOUT WITH CSV HEADER;
