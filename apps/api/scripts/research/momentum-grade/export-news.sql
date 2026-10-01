COPY (
  select l.ticker, extract(epoch from a.published_at)::bigint as pub_ts, a.source,
         nc.impact_score, nc.hype_score, nc.direction, nc.catalyst_type, nc.urgency
  from news_ticker_links l join news_articles a on a.id = l.article_id
  left join news_classifications nc on nc.article_id = a.id
  where a.published_at >= timestamp '2026-08-02' and a.published_at < timestamp '2026-10-01'
) TO STDOUT WITH CSV HEADER;
