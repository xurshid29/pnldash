-- migrate:up
-- Small global settings that aren't the screener filter (screener_settings).
-- Global because the services they steer are singletons. First key:
-- 'tv_alert_stages', the 📐 TradingView setup stages that get announced
-- (the ⚙ alerts menu; services/tv-setups.ts, routes/tv.ts).
create table app_settings (
    key        text primary key,
    value      jsonb not null,
    updated_at timestamptz not null default now()
);

-- migrate:down
drop table if exists app_settings;
