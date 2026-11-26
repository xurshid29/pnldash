# CLAUDE.md

Project: a real-time low-float momentum screener with a multi-panel web dashboard. The original implementation is a bash script (`screener-poll_breakout.sh`) — it stays as-is. The web port lives in `apps/api` (Express + Kysely + Postgres) and `apps/web` (React + Antd + Vite). Multi-user with JWT auth.

The web service runs a singleton `PollerService` that does the same Finviz + Yahoo + Benzinga work as the bash script (plus SEC EDGAR filings and Nasdaq trade halts), persists every cycle to Postgres, and pushes live deltas to the browser via SSE.

**Continuing a session? Start with [`docs/HANDOVER.md`](docs/HANDOVER.md)** — the live "where we are + what's open" layer; its **START HERE** section (top) is the current state, live features, parked components, prod config and the ranked open items. Then:

**Status & roadmap:** what's built, recent work, and what's next live in [`docs/web-dashboard.md`](docs/web-dashboard.md). The low-float runner-detection strategy and its phased plan: [`docs/catching-runners.md`](docs/catching-runners.md); the Ignition screener spec: [`docs/ignition-screener-spec.md`](docs/ignition-screener-spec.md); the in-progress multi-day Swing screener spec: [`docs/swing-screener-spec.md`](docs/swing-screener-spec.md). **The early-detection chain (📰 news radar → 🤫 quiet accumulation → 📈 EMA cross → 👀/🛰️ tick watch/confirm → screens) is documented layer-by-layer in [`docs/detection-layers.md`](docs/detection-layers.md)** — read it before touching the tick feed, the poller's tier logic, or `tier_events`. **The operator's current edge, the 📐 VWAP setup (detected by a TradingView Pine script, delivered by webhook), is documented in [`docs/vwap-setup.md`](docs/vwap-setup.md)** — read it before changing the Pine script, `routes/tv.ts`, `services/tv-setups.ts` or the 📐 setups sidebar.

## Environment Variables

Required in `.env` (copy from `.env.example`):

```bash
DATABASE_URL=postgres://app:app@localhost:5438/app?sslmode=disable
FINVIZ_API_TOKEN=your-token-here
BENZINGA_API_TOKEN=bz.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # optional — comment out to park the sub (radar goes dark; Finviz/Yahoo/SEC/halt news continue)
SEC_EDGAR_USER_AGENT=App Name (you@example.com)          # optional — SEC requires a descriptive UA; a default is used if unset
JWT_SECRET=your-secret-key-here
JWT_EXPIRES_IN=7d
REGISTRATION_OPEN=true                                   # public sign-up — closed unless exactly 'true'
TELEGRAM_BOT_TOKEN=...                                   # optional — Telegram bot token for push alerts + commands
TELEGRAM_CHAT_ID=...                                     # optional — destination chat id for alerts + command auth
TELEGRAM_USER_ID=...                                     # optional — dashboard user uuid the bot acts as for /hidden + /unhide; that user's hidden tickers (today) are skipped on the phone
DATABENTO_API_KEY=db-...                                 # optional — Databento live (EQUS.MINI) for the tick-feed detector; Live Ticks PARKED 2026-10-01 (commented out in prod, subscription cancelled)
TICKFEED_ENABLED=true                                    # optional — turn on the live tick feed (needs DATABENTO_API_KEY + a Standard/US-Equities subscription); off unless exactly 'true'
TICKFEED_PYTHON=python3                                  # optional — python interpreter for the sidecar (default python3)
ALERTS_DISABLED=tick_watch,accum                         # optional — mute these components' TELEGRAM pushes only; detection, grading, and the dashboard keep running (also: edge_armed, edge_entry, edge_bailout, vwap_reclaim; the live opportunity alerts are grade_aplus, fast_move, news, and the 📐 TradingView setups: tv_setup = all stages, or per stage tv_pullback / tv_broken / tv_held / tv_cross / tv_retest / tv_ema / tv_bounce / tv_band / tv_turn / tv_pop / tv_back, and tv_year for messages about the year line alone)
TV_WEBHOOK_SECRET=...                                    # optional — shared secret for POST /api/tv/webhook?key=… (TradingView alert webhook for the 📐 VWAP setup); unset = endpoint answers 503
COMPONENTS_DISABLED=ignition,momo,setups,ema,swing,outcomes,continuation,edge,vwap,ticks # optional product gates; this lean set is the default. Empty = enable all; "faders" aliases "continuation"
```

## Database Schema

Postgres, migrations via `dbmate` in `db/migrations/`.

| Table | Purpose |
|---|---|
| `users` | Accounts (JWT auth) |
| `screener_cycles` | One row per poll: `polled_at`, `filter_snapshot` (jsonb), `row_count` |
| `screener_results` | Tickers seen in each cycle: `cycle_id`, `ticker`, `change_pct`, `float_m`, `price`, `volume`, `mcap`, `country`, `status` (NEW/ACC/UP/NEWS/-), `prev_change_pct` |
| `news_articles` | Deduped news: `source` (finviz/yahoo/benzinga/sec/halt), `url` UNIQUE, `title`, `published_at`, `fetched_at`, `raw` (jsonb) |
| `news_ticker_links` | M:N — `article_id`, `ticker` |
| `user_filter_presets` | Per-user saved filters: `user_id`, `name`, `filter` (jsonb), `is_default` |
| `user_panel_layout` | Per-user panel sizing/visibility: `user_id`, `layout` (jsonb) |
| `user_chart_prefs` | Per-user chart slots: `user_id`, `slot` (1..4), `ticker`, `interval` |
| `user_edge_presets` | Per-user/per-ticker Edge rules: custom EMA pair, proximity and bailout buffers, alert switches |
| `edge_bars_1m` | Small shared 1-minute warmup store for saved Edge tickers only (not the parked global technical universe) |
| `edge_events` | Durable Armed/Entry/Bailout transitions with indicator snapshot for review and later journal attribution |
| `broker_imports` | Per-user uploaded broker statement (IBKR `.tlg`): `account`, `file_hash`, period, fill counts |
| `screener_ticker_days` | One row per ticker per ET day on the Momentum screen: `ticker`, `et_date`, `max_chg` — feeds the 📐 TradingView watchlist (90-day repeat runners); backfilled by its migration, topped up by `GET /api/tv/watchlist` |
| `app_settings` | Small global key/value settings (`key` PK, `value` jsonb): `tv_alert_stages` = the 📐 stages that get announced; `tv_alert_rules` = the ⚙ menu's rules beside them (`ema_momo_only`) |
| `trade_executions` | Per-user broker fills: `exec_id` (UNIQUE per user — idempotent re-import), `symbol`, `side`, signed `quantity`/`amount`, `commission`, `executed_at` (ET wall clock), `et_date`. Round-trip *trades* (flat-to-flat, P&L by exit date) are derived in `services/ibkr-tlg.ts`, not stored. Powers the `/journal` P&L calendar |

## Code Conventions

- **API responses:** `{ data: ... }` for success, `{ error: ... }` for failure
- **DB:** `getDb()` for lazy initialization (ensures env vars loaded). For quick queries: `source .env && psql "$DATABASE_URL"`
- **Validation:** Zod schemas at route boundaries
- **Naming:** camelCase in TypeScript, snake_case in Postgres
- **Types:** Kysely `Database` interface in `apps/api/src/db/types.ts` mirrors migrations
- **Imports:** ESM only (`type: module`); local imports keep the `.js` extension at runtime (`import x from './foo.js'`)
- **Frontend state:** TanStack Query for server state; React Context only for cross-cutting concerns (auth)
- **Displayed times:** the operator's clock, `Asia/Tashkent` (UTC+5, also the embedded TradingView charts); date pickers stay on the ET trading day (one US session = one date). Server-side day logic is ET

## Polling architecture (how the web service replicates the bash script)

`apps/api/src/services/poller.ts` is a long-lived singleton. On API startup it begins a 20s loop:

1. Fetch Finviz `v=131` (ownership: gives float, mcap, price, change, volume) **and** `v=110` (overview: gives country) in parallel. Join by ticker. Post-filter `float < FLOAT_MAX_M` (default 35M). Every 3rd cycle (~1 min) one more batched `v=152` quote covers today's 📐 setup tickers that aren't on the screen (`payload.tv_quotes`, for the 📐 sidebar's change %).
2. Per cycle, fetch news from five sources:
   - **Finviz** `news_export?v=3&t=<batch>` — one call for all current tickers, today only
   - **Yahoo RSS** `feeds.finance.yahoo.com/rss/2.0/headline?s=<ticker>` — per-ticker fan-out, today only
   - **Benzinga delta** `api.benzinga.com/api/v2/news?updatedSince=<watermark>` with `Accept: application/json` header — only articles with `ts > stored_max` count as "fresh" (audio-worthy)
   - **SEC EDGAR** `browse-edgar?action=getcurrent` — the "latest filings" firehose (one call), matched to screener tickers via the `company_tickers.json` CIK map. Surfaces offerings/dilution (424B*, S-1/S-3), 8-Ks, M&A, and 13D/G stakes. Watermark = filing dissemination ts.
   - **Nasdaq trade halts** `nasdaqtrader.com/rss.aspx?feed=tradehalts` — the market-wide halt feed (one call), filtered to screener tickers. A T1 ("news pending") halt scores as a major catalyst. Watermark = halt ts.
3. Merge precedence (highest wins): **halt > sec > Benzinga > Yahoo > Finviz**
4. Cross-cycle state lives in service memory (per-ticker `prev_change_pct`, Benzinga headline cache, three ts watermarks — Benzinga / SEC / halt). Auto-cleared at midnight ET.
5. Classify rows: `NEW` (first appearance), `ACC` (`change% delta > 2`), `UP` (any positive delta), `NEWS` (no movement but has today's news).
6. Persist cycle + rows + new news articles to DB.
7. Broadcast a delta payload to all connected SSE clients on `/api/screener/stream`.
8. Opportunity alerts (`services/opportunity-alerts.ts`, 2026-10-01): one engine decides 🅰️ first A+ of the day / ⚡ fast move / 📰 fresh headline per cycle; the same set goes to Telegram (if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set; per-kind mutes via `ALERTS_DISABLED`) and to the dashboard via `payload.alerts`. Dedup state is seeded from `tier_events` (tier='alert') and recent `news_articles` on boot, so deploys don't re-ping. The older fresh-catalyst push (`momentum` slug) still exists but stays muted in prod — the 📰 alert supersedes it. A fourth kind arrives between cycles (2026-10-03): 📐 `tv_setup`, the operator's VWAP setup detected by TradingView itself (Pine script `apps/web/src/tv/mvwap-bb-setup.pine` run as two watchlist alerts, 1m and 30s; offline replay in `apps/api/scripts/research/vwap-setup/`) and posted to `POST /api/tv/webhook` (`routes/tv.ts` → `services/tv-setups.ts` → `poller.deliverTvSetup`); it is stored as `tier_events` tier='alert' event='tv_setup', pushed over SSE as an `alert` event and shown in the 📐 setups sidebar (the left rail, `TvSetupsSidebar.tsx`). **Since script v27 (2026-10-28) the script carries two setups, PULLBACK and the VWAP + BB cross — the ones the operator kept after trying all four. RECLAIM (FORMING / READY / GO) and the BB breakout were removed from the script, the server and the dashboard (code in git at v26 `e38c06b`; their rows stay in `tier_events`; their messages now get 400).** Which stages are announced is a global setting, the ⚙ menu's **📐 Stages that alert** (`GET/PUT /api/tv/settings`, `app_settings` key `tv_alert_stages`; default PULLBACK / CROSS / RETEST on, BROKEN / HELD off — the operator hides those markers; hiding a marker on the chart doesn't stop its alert). A switched-off stage is stored but never announced, and hidden from the sidebar list (2026-10-05/06). Since script v21 (2026-10-20) the **VWAP + BB cross** (`docs/vwap-setup.md` §16): a candle of a configurable timeframe (default 5m) crosses a VWAP line (session; since v22 also month and year, each its own setup, those two anchored on hourly bars) and the upper BB of another configurable timeframe (default 45s since v27): since v23 the open is under and the close above both lines as they stand at that 30s close (what the chart draws; the day's first candle counts). CROSS is sent from the 30s alert at the first such 30s close, while the candle is open; the script builds the candle, VWAP and band from the 30s bars. It is stored as `tier_events` event `tv_setup` stage `cross` and announced for Momentum names only (`TV_SETUP.vb_momentum_only`, except a day high ≥ +30%, `vb_fresh_gain`), behind the ⚙ stage switch and `TV_SETUP.vb_cap` (3 crosses per line per day). Since v28 the follow-up is **RETEST** (stage `retest`, the operator's entry; it replaced v25–v27's LEVEL / BREAK, which now get 400): after the VB candle closes, price comes back within 1% of the line it crossed and (v30) the candle that came back closes above it — fired at that close ("VB retest fires: Candle close"; v28's first green 30s close above the line is an option); the message carries a stop under the pullback low and `retest N`, and it is announced like CROSS with its own ⚙ switch; a candle's close under the line (v26), 6 candles or a newer VB candle end it. v29–v38 also ran up to three more VB timeframes ("lanes", 1h / 4h / 1D on the month and year lines) in the same 30s alert; v39 (2026-11-15) removed them at the operator's request, with the server's `TV_SETUP.vb_long_min` exception (code in git at v38 `7c7b4b9`; `docs/vwap-setup.md` §16.10 is the record). Since v28 the VWAP lines come from 30s bars by default ("VWAP lines from: 30s bars | Chart bars", `vwap 30s|chart` in every message), so the 5m and 30s charts show one session line; since v31 the month line has its own switch ("Month VWAP from", default 30s bars: this month's hourly bars + today's 30s bars, drawn and used by PULLBACK and the VB alike). Since v32 (2026-11-08) a third setup, the **RSI cross** (stage `rsi`, `docs/vwap-setup.md` §17), is for longer trades. At each 6h close, the 12h RSI crosses above its SMA-14 while at or under 30, now or within its last 6 candles. Since v33 there is one RSI, with any timeframe and check timeframe; 30m checked at 30m is the plain cross, and it is replicated in `pinesim.simulate_rsi`. It is built from requests, so it works on the operator's 2m chart. It is sent from the 30s alert, announced off Momentum behind its own ⚙ switch, and not graded. Since v34 (2026-11-12) an RSI cross arms a **DIP** (stage `dip`, §17.2): on the RSI's own candles, the RSI closes back under its MA and then turns up, which is the pullback entry, with a stop under the dip's low. It has its own ⚙ switch, DIP, since 2026-11-13 (it rode the RSI's before; the saved switches are `{ announced, known }`, and an older plain list gives DIP the RSI's value), and its chart marks need bars that divide the RSI's timeframe. Since v39 (2026-11-15) a DIP starts a wait for the **MACD** (stage `macd`, §17.4, the operator's entry because a DIP alone can keep going lower): the MACD line (EMA 12 − EMA 26 of 5m closes, built from a request like the RSI) closes above zero after closing at or under it; a newer DIP starts the wait over, and it ends after 3 sessions. It has its own ⚙ switch after DIP (a saved list gives it the DIP's value) and is announced like the DIP; measured in `apps/api/scripts/research/rsi-dip/` it is no better than the DIP itself, so it is the operator's confirmation, not an edge. Its inputs and plots sit in the script's section 5, after the EMA section, because new inputs go last; it is replicated in `pinesim.simulate_rsi` (`macds`). v39 also removed v38's **LIFT** (stage `lift`, §17.3: a level 8% above the DIP): its messages now get 400, a saved LIFT switch is dropped, its rows stay in `tier_events` unlisted, and its code is in git at v38 `7c7b4b9`. v39 needs Reset settings once (inputs left the middle and the end), and its RSI defaults are the operator's (a 10m RSI checked at 1h). Since v35 (2026-11-13) a fourth setup, the **EMA cross over VWAP** (stage `ema`, §18): the EMA 9 of 3m closes crosses above the session VWAP (month and year lines are switches), judged at each 3m close from a request like the RSI. It is sent from the 30s alert and announced like CROSS, behind its own ⚙ switch and `TV_SETUP.em_cap`; it is replicated in `pinesim.simulate_ema` and not graded. Since v36 (2026-11-13) the script filters it (§18.1, measured in `apps/api/scripts/research/ema-vwap/`): a cross is **weak** when its candle opened before 07:00 New York, the EMA had been under the line for fewer than 5 candles, or the two crossed more than 2 times in the 20 candles before. A weak cross is still sent (`| under N | flips N | weak`), takes no `cross N`, is stored quietly and never gets a 📐 sidebar row. Since v37 (2026-11-13) a sent EMA cross arms a **BOUNCE** (stage `bounce`, §18.2): within 10 of the EMA's candles, a candle's low comes down to the EMA or the VWAP and that candle or a later one closes green above the EMA, with a stop under the pullback's low; a close under the VWAP first ends the wait. It rides the EMA's ⚙ switch (`stageSwitch()`), is limited like the cross, and is weak after a weak cross. Since v40 (2026-11-15) the script's last input, "EMA cross: the line that crosses the VWAP", picks the EMA, the **BB upper band** or both (the default) (§18.3): the band is the VB's (its BB timeframe, length and StdDev, rebuilt from the 30s bars and replayed on bigger charts), its crosses follow the EMA's rule, settings and filter on their own state (script section 4b) with no BOUNCE, and its message is the EMA's with `| upper … | bb …` in the place of `| ema …`. The server keeps it in stage `ema` (`emaByBand()`; the same switch and cap; the gate's key carries `|bb`) and shows it as BAND; it is replicated in `pinesim.simulate_ema(src='bb')`. Since v41 (2026-11-16, §18.5) a band cross whose candle closed under the band's middle line (a fast drop widened the band and its upper line rose over the VWAP while the price fell away) is weak like a filtered EMA cross (`bbMidOn`, the script's last input), and every band cross's message carries `| mid <line> (<price vs it>%)` (`bb_mid` / `bb_mid_pct`); measured in `apps/api/scripts/research/ema-vwap/band_cross_study.py`, those drop-made crosses are a quarter of the band's crosses and were followed by a bounce more often than the rest, so the test marks a different event, not a worse one. Since v42 (2026-11-16, §18.6) a third line can cross the VWAP, the **basis** (middle line) of a separate Bollinger Band with its own switch, timeframe and length (`bsOn`, `bsTf` 45S, `bsLen` 10; the script's last inputs, section 4c): the band cross's rule with no middle-line test and no BOUNCE, its message the EMA's with `| basis … | bb … | len …`; the server keeps it in stage `ema` (`emaByBasis()`, the gate's key carries `|bs`, fields `basis` / `basis_pct` / `bb_len`) and shows it as BASIS; replicated in `pinesim.simulate_ema(src='bs')`, not measured. Since 2026-11-16 (§18.7) the band's and the basis's crosses are stages of their own, `band` and `basis`: the script still heads all three messages "EMA" and `parseTvMessage` sorts them by their fields (`emaLineStage()`; rows stored as `ema` on 11-15 / 11-16 are read the same way), each has a ⚙ switch after EMA + BOUNCE (a saved list gives it the EMA's value) and a Telegram slug, and `GET /api/screener/alerts` now passes every stage-specific field of a stored row (`storedSetupFields()`; it passed the VB's alone, so a reloaded page mislabelled rows). Since v43 (2026-11-18, §19) the hourly request for the year's and the month's sums is the script's first request again: on a 30s chart a timeframe's bars first requested after a `request.security_lower_tf()` call load only as deep as 100,000 30s bars would reach (833 hourly bars), so from v28 to v42 the 30s alert's year line started months late (a median 22% under the 1m alert's; the 30s alert's rows stored from 10-29 until v43's alerts keep that line), and a new request that needs a long history must go above the first lower-timeframe request. It was found through TradingView's MCP server (`mcp-tradingview`, added to Claude Code for this project on 2026-11-18, §19.4), which compiles and runs the script on TradingView's side: compile-check a new script version through it before the operator pastes (send the comment-free copy from `research/vwap-setup/pine_strip.py`; every call counts against a daily limit of 50; interactive use only, nothing in `apps/api` calls it). **Since v44 (2026-11-22, §20) the RSI cross with its DIP, the MACD cross after a DIP and the BASIS cross are removed at the operator's request, so the sentences about them above are history: the script carries PULLBACK, the VWAP + BB cross with its RETEST, and the EMA cross with its filter, its BOUNCE and the band's cross.** Stages `rsi`, `dip`, `macd` and `basis` are gone from the server and the dashboard (their messages get 400, an `EMA …` message carrying `| basis …` included; saved switches are dropped; their rows stay in `tier_events` unlisted; `storedStage()` still names a basis row so it can be skipped); the code is in git at v43 `97546dd`, and `pinesim` keeps the simulators. `rsSym` and `rsChartSec` stay in the script under those names because the EMA section uses them. v44 needs Reset settings once (inputs left the middle and the end), and four defaults became the operator's live settings: VB candle 2m, VB band 30S, EMA candle 2m, and "BB upper" as the EMA cross's line (so by default the EMA's own crosses and its BOUNCE don't run). Since v45 (2026-11-22, §13.8) the script draws one more line for the PULLBACK, the basis of a Bollinger Band of its own timeframe (`pbBsOn`, `pbBsTf` 15S, `pbBsLen` 20: the SMA of that timeframe's closes, from a lower-timeframe request; the script's last inputs, shown in the Pullback group, and its last plot): a line only for the operator's entry experiment (a close above it after a pullback), with no alert, message field or server side; measured the same day in `research/vwap-pullback/basis_study.py` (§13.9: a rising basis at the alert is the worse PULLBACK, and entering at the close above the basis does not beat the alert's price). Since v46 (2026-11-24, §18.8) the EMA cross setup has the same kind of line for its band cross (`bbBsOn`, `bbBsTf` 15S, `bbBsLen` 20; the script's last inputs, shown in the EMA cross over VWAP group; the last plot, teal): a separate band from the one the cross uses, again a line only. Since v47 (2026-11-25, §21) a fourth setup, **TURN** (stage `turn`): on the candles of its own basis (SMA 15 of 1m closes; script section 8, thirteen inputs in the group "TURN: the bounce off a basis that turned up", the script's last), after the basis fell at least 10% and turned up, a close above it, a low back at it within 10 candles, then a green close above it with the basis rising and the MACD (12 26 9) above its signal. It reads the chart's own candles, so it is sent from the 1m alert (`tf 1`), with `| sma N … | fall …% | turn N | since N | green 1` (`sma_len` / `sma` / `sma_pct` / `fall_pct` / `turn_n` / `macd_green`); announced behind its own ⚙ switch (on by default), on Momentum names (the ⚙ rule reads "EMA / BAND / BOUNCE / TURN: Momentum list only") and up to `TV_SETUP.tn_cap` a day per ticker; replicated in `pinesim.simulate_turn`. Measured before building (`research/ema-vwap/basis_bounce_study.py`): the fall is the condition that counts, and after a 10% fall it is about break-even, so it is the operator's experiment. Since v48 (2026-11-26, §22) a fifth setup in two steps, **POP** and **BACK** (stages `pop` and `back`; script section 9, twelve inputs in the group "POP and BACK: a pop off the basis and its first pullback", the script's last): on the candles of its own basis (SMA 15 of 1m closes), a run is the closes above the basis from the one that crossed it to the first close under it; POP, a heads-up with no entry, is the first candle of a run by which a high has reached 10% above the basis; BACK, the entry, is the first pullback after it: a low back at the basis (within 1%), then a green close above it with the basis rising and the MACD (12 26 9) above its signal, within 20 candles of the POP, with a stop a tick under the lowest low after the run's highest high. Both are sent from the 1m alert (`tf 1`): `POP … | sma N … | ran …% | pop N` and `BACK … | stop … | sma N … | ran …% | back N | since N | green 1` (`ran_pct` / `pop_n` / `back_n`, with TURN's `sma_len` / `sma` / `sma_pct` / `since_n` / `macd_green`); each has its own ⚙ switch (on by default), announces on Momentum names (the ⚙ rule now reads "EMA / BAND / BOUNCE / TURN / POP / BACK: Momentum list only") and up to `TV_SETUP.pp_cap` a day per ticker each; a BACK does not need its POP to have been sent; replicated in `pinesim.simulate_pop`. Measured before building (`research/ema-vwap/pop_study.py`, `pop_back_study.py`): buying the pop's own candle loses, which is why the POP is only a heads-up; at 10% there are about 35 POPs and 10 BACKs a day and the BACK is about break-even (at 5% over a hundred POPs a day and worse BACKs), so it is the operator's experiment. Since v49 (2026-11-26, §22.8) the POP has a volume test, the operator's ("the stocks which are almost without volume, suddenly started popping up … we should focus on only such moves"): the reading is the largest volume among the POP candle and the two candles before it ÷ the average of the 20 candles before those three; with the switch on (`ppVolOn`, `ppVolMin` 10, the script's last two inputs) a POP under the minimum is **weak** (a gray "pop" label, `| weak`, no `pop N`; stored, never announced, no 📐 sidebar row, like a weak EMA cross) and so is its BACK; every POP and BACK message carries `| vol 34.5x` after `ran` (`vol_x`; a BACK carries its POP's). Measured first (`pop_back_study.py` tables 3–6): among names already on the Momentum screen the reading does not sort the POPs, but that data has no pop out of a stock that was not yet moving, which is the case meant; the stored readings are how it gets graded. Since 2026-11-15 an EMA cross, a band cross or a BOUNCE announces on Momentum names only (§18.4, `TV_SETUP.em_momentum_only`): the VB's +30% day-high exception no longer applies to them unless the ⚙ menu's "EMA / BAND / BOUNCE: Momentum list only" is unticked (`ema_momo_only` in `GET/PUT /api/tv/settings`, `app_settings` key `tv_alert_rules`). Each setup has an on/off switch (`pbOn` / `vbOn` / `emOn` / `tnOn` / `ppOn`); new script inputs go last, because TradingView keeps saved input values by position (v27, v39 and v44 moved them, each with a Reset settings step; the defaults are the operator's settings: gainer filter 10%, VB candle 2m, band 30S, tolerance 0). Since script v16 (2026-10-10) the PULLBACK daily cap (2 failed pullbacks per line) is applied by the server from each message's `fails N`: past it a PULLBACK is quiet unless the ticker is on Momentum at grade B+ or better (`TV_SETUP.pb_cap` / `pb_cap_exempt`, a trial). Since script v10 (2026-10-05) the same script also carries a second setup, PULLBACK: after a fast run, price comes back to the session, month or (v14) year VWAP (since v24 a month or year PULLBACK may touch on the bar's low, a trial; stages PULLBACK / BROKEN / HELD; `docs/vwap-setup.md` §13; measured on our data in `apps/api/scripts/research/vwap-pullback/`). Since v14 the year line is built from this year's hourly bars (`request.security`, so every timeframe agrees) and lines that fire together are named together (`line session+month`, `month+year`, …). Keep the Pine message format and `parseTvMessage` in step (`npx tsx scripts/verify-tv-setups.ts` checks both), and the Pine logic and `pinesim.py` in step (`python3 pinesim.py` self-tests both setups; it also keeps the removed setups' simulators for research).

When enabled, each cycle also runs a second **Ignition screen** alongside the Momentum one. In the default lean profile it is parked by `COMPONENTS_DISABLED`, so its fetch, score, writes, payload and UI list do not run. The same gate parks MOMO/SETUPS/EMA, Swing, Outcomes, Continuation, Edge (parked 2026-08-21 — `EdgeService` does not start and `/api/edge` answers 503), the ↑ VWAP reclaim tick layer (parked 2026-08-22 after grading as noise) and Live Ticks itself (`ticks`, parked 2026-10-01 — no Databento connection at all; the subscription is being cancelled); the shared daily-bar and technical-bar engines start only when one of their consumers is enabled. The default desk is Momentum (with the A+…D grade) + Momentum History, all Finviz-fed. See `docs/HANDOVER.md` for the current operating profile and `docs/ignition-screener-spec.md` for the preserved experiment.

A standalone `ShelfService` (`services/shelf.ts`) runs alongside the poller: for every screener ticker it does a rate-limited 12-month SEC submissions lookback (`data.sec.gov/submissions`) and grades dilution risk `shelf` / `effective` / `active` — an effective shelf is the runner's kill-switch. The flag rides on each enriched row, penalises the `runner_score`, and shows in Telegram alerts.

**Single-instance only:** the service holds cross-cycle state in memory. Don't deploy multiple replicas without moving state to Redis or DB.

## Local TWS bridge (`tools/tws-bridge`, 2026-11-26)

Not part of the deployed service: a small Node/TypeScript program for the operator's own Mac, outside the npm workspaces (own `package.json` and lockfile; `npm install --ignore-scripts`, `npm start`, `npm test` in that folder). It connects to the TWS that is already running there (TWS's socket API, port 7497 paper / 7496 live) and serves a token-protected HTTP API on `127.0.0.1:8765` that the dashboard page calls from the browser: `POST /focus` (make TWS's linked windows show an alert's ticker) and `POST /order` (the operator's bracket: limit buy + take-profit + stop-limit, prices worked out by the bridge from its `config.json`), plus `/preview`, `/orders`, `/cancel`, `/halt`, `/status`. Orders never touch the pnldash server. Rails live in the bridge: paper accounts only until `paperOnly` is set to false by hand in `config.json` (there is no HTTP way), max shares / dollars / orders a day, a duplicate window, stale alerts refused, a halt switch, nothing queued or resent on reconnect. Human-clicked orders only: do not add automatic order placement, and do not place orders or change TWS settings yourself. `config.json` (the token) and `logs/` are git-ignored: never read the token into output or commit it. The dashboard side is `apps/web/src/api/twsBridge.ts` and the TWS controls in the 📐 sidebar, off until enabled in that browser. Read `tools/tws-bridge/README.md` before touching either.

## Finviz API Quick Reference

**Important:** Add `-A "Mozilla/5.0"` to curl commands to avoid blocks. Add `-L` to follow the `export.ashx` → `export` redirect (Finviz silently moved this in early 2026).

**Screener exports name their product (2026-11-16):** Finviz split the screener into a Stock and an ETF one, so a screener export URL is `export/screener?type=stocks&v=…` (`type=etf` for ETFs). A URL without `type=` still answers, but from 07.Dec.2026 in the new screener's layout (stocks only; a custom `c=` column list then starts with `No.` and `Ticker`). The API builds every screener URL with `screenerExportUrl()` and reads columns by header name (`csvColumns()`, both in `services/finviz.ts`; `npx tsx scripts/verify-finviz-export.ts` checks them). `quote_export` and `news_export` are not screener exports and are unchanged. The three bash scripts still use the old URLs.

**Rate limit:** Finviz Elite's real ceiling is **~1 request/second** (measured 2026-06-11: a 2nd call 300ms after the 1st gets a 429). All API-side Finviz HTTP goes through `rateLimitGate()` in `apps/api/src/services/finviz.ts` (≥1.1s spacing) and 429s raise a typed `FinvizRateLimitError`. Keep manual curl probing under ~1/s too — hammering faster starves the live poller.

```bash
# Screen stocks (v=111 overview, v=171 technical, v=131 ownership, v=161 financial)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export/screener?type=stocks&v=171&f=sh_price_o20,sh_price_u30,cap_midover&auth=$FINVIZ_API_TOKEN"

# Price history (daily bars only — Finviz API doesn't expose intraday)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/quote_export?t=AAPL&p=d&auth=$FINVIZ_API_TOKEN" | tail -30

# News (batch via comma-separated tickers)
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/news_export?v=3&t=AAPL,MSFT&auth=$FINVIZ_API_TOKEN"
```

### Reliable Fetch Patterns

News and quote exports sometimes return empty on first call. Use:
- **News:** don't pipe — let it complete fully, then process
- **Quotes:** save to file then read (most reliable for large data)

```bash
source .env

# QUOTES (large data) — save to file first
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/quote_export?t=TICKER&p=d&auth=$FINVIZ_API_TOKEN" > /tmp/ticker.csv && tail -60 /tmp/ticker.csv

# MULTIPLE TICKERS — Technical
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export/screener?type=stocks&v=171&t=AAPL,MSFT,GOOGL&auth=$FINVIZ_API_TOKEN"

# MULTIPLE TICKERS — Ownership
curl -sL -A "Mozilla/5.0" "https://elite.finviz.com/export/screener?type=stocks&v=131&t=AAPL,MSFT,GOOGL&auth=$FINVIZ_API_TOKEN"
```

### View Types for Screening

| View | Code | Data Returned |
|------|------|---------------|
| Overview | v=111 / v=110 | Ticker, company, sector, market cap, P/E, price, change, volume, country |
| Technical | v=171 | Beta, ATR, SMA 20/50/200, 52W High/Low, RSI, price, change, volume |
| Ownership | v=131 | Market cap, shares, insider/inst ownership & transactions, short float/ratio, **shares float** |
| Financial | v=161 | P/E, EPS, profit margin, ROE, debt/equity, dividend yield |

**Key gotcha:** No single view returns both `Float` AND `Country`. The poller calls `v=131` + `v=110` in parallel and joins by ticker.

**If a fetch returns empty:** retry without piping to `head`/`tail` first; pipe after confirming data returns.

## Single Stock Analysis Template

When the user asks for analysis of a single stock (demand/support zones + trade setups), use this structure:

### 1. Current Stats Table
| Metric | Value |
|--------|-------|
| **Price** | $XX.XX (+/-X.XX%) |
| **Market Cap** | $X.XB |
| **RSI** | XX.XX (oversold <30 / neutral 30-70 / overbought >70) |
| **Beta** | X.XX |
| **vs 52W High** | -XX.XX% |
| **vs 52W Low** | +XX.XX% |
| **Short Float** | XX.XX% |
| **Inst Trans** | +/-XX.XX% |
| **Insider Trans** | +/-XX.XX% |

### 2. Technical Position Table
| SMA | vs Price | Trend |
|-----|----------|-------|
| 20 SMA | +/-X.XX% | Bullish/Bearish |
| 50 SMA | +/-X.XX% | Bullish/Bearish |
| 200 SMA | +/-X.XX% | Bullish/Bearish |

### 3. Price Structure (ASCII)
```
$XX.XX ─── 52W High / Resistance
$XX.XX ─── Resistance level
$XX.XX ─── Current price ◀ CURRENT
$XX.XX ─── Support level
$XX.XX ─── Demand zone
$XX.XX ─── 52W Low
```

### 4. Support & Demand Zones
- **Support:** lows tested multiple times that held
- **Demand:** consolidation areas before significant rallies (accumulation)
- **Strength:** more tests + longer consolidation = stronger zone

### 5. Catalysts / Concerns / Positives — short tables
### 6. Trade Setup
| Scenario | Entry | Stop | Target | R/R | Time Stop |
|----------|-------|------|--------|-----|-----------|
| Aggressive | ... | ... | ... | X:1 | 5d |
| Moderate | ... | ... | ... | X:1 | 5d |
| Conservative | ... | ... | ... | X:1 | 7d |

### 7. Verdict — bias, best entry, key risks, BUY/WATCH/SKIP

## Key Metrics Interpretation

### RSI
| Range | Interpretation |
|-------|----------------|
| < 30 | Oversold — potential bounce |
| 30-50 | Neutral-bearish |
| 50-70 | Neutral-bullish |
| > 70 | Overbought — potential pullback |

### Short Float
| Short Float | Risk |
|-------------|------|
| < 5% | Low |
| 5-15% | Medium |
| 15-25% | High |
| > 25% | Very high (squeeze + downside both elevated) |

### Insider/Inst Activity
| Activity | Interpretation |
|----------|----------------|
| Inst Trans > +5% | Institutions accumulating (bullish) |
| Inst Trans < -5% | Institutions distributing (bearish) |
| Insider Trans > 0 | Insiders buying (very bullish) |
| Insider Trans -3% to 0 | Minimal selling, not alarming |
| Insider Trans -3% to -10% | Moderate selling |
| Insider Trans < -10% | Heavy insider selling (red flag) |

### Beta
| Beta | Volatility |
|------|------------|
| < 1.0 | Less volatile than market |
| 1.0-2.0 | Normal |
| 2.0-4.0 | High |
| > 4.0 | Extreme |

### Market Regime
| Signal | Regime | Action |
|--------|--------|--------|
| SPY/QQQ above SMA20, VIX < 20 | Risk-On | Screen normally |
| SPY/QQQ near SMA20, VIX 20-25 | Neutral | Reduce picks, smaller positions |
| SPY/QQQ below SMA20, VIX > 25 | Risk-Off | Pause screening, favor defensives |
| Multiple sectors down >3%/day | Broad Selloff | Do NOT enter new positions |

## Direct Database Access

For quick queries:

```bash
source .env
psql "$DATABASE_URL" -c "SELECT * FROM screener_cycles ORDER BY polled_at DESC LIMIT 5;"
```
