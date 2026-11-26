# tws-bridge

A small program that runs on this Mac, next to TWS. It lets the dashboard in the browser do two things in the TWS you are already logged in to:

1. **Focus**: make the TWS windows linked to one display group jump to an alert's ticker.
2. **Order**: place your usual bracket (limit buy + take-profit + stop-limit) with one click.

The browser page talks to the bridge at `http://127.0.0.1:8765`; the bridge talks to TWS over TWS's own socket API. Nothing about orders goes to the pnldash server.

What it does not do:

- It never places an order by itself. Every order is one click of yours; nothing is retried, queued or re-sent, also not after TWS reconnects.
- It does not take prices from the web page. The page sends the ticker, the alert's price, the alert's stop and a quantity; the limit, take-profit and stop are worked out here from `config.json`.
- It does not listen on the network: `127.0.0.1` only, and every call needs the token from `config.json`.
- It does not manage a position after the buy fills. The take-profit and the stop live in TWS; change or cancel them there.
- It trades US stocks only (`STK` / `SMART` / `USD`), long only.

## One-time TWS settings

In TWS: **File → Global Configuration → API → Settings**

- tick **Enable ActiveX and Socket Clients**
- untick **Read-Only API** (needed for orders, step 2; focus works with it ticked)
- **Socket port**: `7497` on the paper login (TWS's default for paper; live is `7496`)
- tick **Allow connections from localhost only**

Then link the windows that should follow the alerts (chart, order entry, Level 2 …): click the chain-link icon in each window's title bar and pick the same colour group for all of them. TWS numbers its groups; the bridge moves the one whose number is `displayGroup` in `config.json` (default `1`) and prints the group numbers TWS reports when it connects. If a focus changes nothing on screen, the windows are linked to another group: try the next number (edit `config.json`, restart the bridge).

## Start

```bash
cd tools/tws-bridge
npm install --ignore-scripts     # once
npm start
```

The first start creates `config.json` with a random `token` and prints where the file is (never the token). Put that token into the dashboard's bridge setting. Stop the bridge with Ctrl+C: orders that are already in TWS stay in TWS.

TWS can be started before or after the bridge; the bridge keeps trying to connect and says so once.

Quick check from a terminal:

```bash
TOKEN=$(node -p "require('./config.json').token")
curl -s -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8765/status
curl -s -H "X-Bridge-Token: $TOKEN" -H "Content-Type: application/json" \
     -d '{"ticker":"AAPL"}' http://127.0.0.1:8765/focus
curl -s -H "X-Bridge-Token: $TOKEN" -H "Content-Type: application/json" \
     -d '{"ticker":"AAPL","alert_price":190}' http://127.0.0.1:8765/preview
```

`/preview` shows the order `/order` would send and sends nothing.

## config.json

Read once, at the start: after an edit, restart the bridge. A missing or unknown setting, a negative number or a port clash stops the start with the list of what is wrong. The bridge writes the file itself only to save the halt switch.

| Setting | Default | Meaning |
|---|---|---|
| `tws.host`, `tws.port`, `tws.clientId` | `127.0.0.1`, `7497`, `77` | Where TWS's API listens. `7497` = TWS paper, `7496` = TWS live. The client id must not be used by another API program (and not `0`). |
| `http.port` | `8765` | The bridge's own port, always on `127.0.0.1`. |
| `token` | random | The secret the dashboard sends as `X-Bridge-Token`. 64 hex characters. |
| `allowedOrigins` | `https://pnldash.uz`, `http://localhost:5173` | The pages allowed to call the bridge from a browser. |
| `displayGroup` | `1` | The TWS display group that `/focus` moves. |
| `paperOnly` | `true` | Orders only when every account TWS reports is a paper account (id starts with `D`). |
| `enabled` | `true` | `false` = no orders at all (focus still works). |
| `halted` | `false` | The off switch; the dashboard can flip it (`POST /halt`). |
| `order.qty` | `100` | Shares, when the click does not say. |
| `order.priceFrom` | `"alert"` | `"alert"`: the limit starts from the alert's price. `"ask"`: from TWS's ask at the click (needs real-time data in TWS; waits at most 0.8 s). |
| `order.limitOffsetPct` | `1.0` | Buy limit = that price + this %. |
| `order.maxChasePct` | `3.0` | If the limit would be more than this % above the alert's price: no order ("price has run N% past the alert"). |
| `order.takeProfitPct` | `10.0` | Take-profit = limit + this %. `0` = no take-profit. |
| `order.stopPct` | `5.0` | Stop = limit − this %. `0` = no stop at all. |
| `order.stopLimitOffsetPct` | `1.0` | The stop's own limit = stop − this %. |
| `order.useAlertStop` | `true` | Use the alert's stop instead, when it is below the limit and no more than 3 × `stopPct` under it. |
| `order.outsideRth` | `true` | Orders may work in the pre-market and after hours. |
| `limits.maxShares` | `500` | Most shares in one order. |
| `limits.maxNotionalUsd` | `1000` | Most dollars in one order (shares × limit). |
| `limits.maxOrdersPerDay` | `20` | Orders per New York date. Counted from the log, so a restart does not reset it. |
| `limits.duplicateWindowSec` | `10` | The same ticker again within this many seconds is refused as a duplicate. |

Prices are rounded to the US tick: $0.01 from $1 up, $0.0001 below $1. The buy limit and the take-profit go to the nearest tick, the stop and its limit down.

The buy is a `DAY` limit order; the take-profit and the stop are `GTC` and stay until one fills or you cancel them.

## Live accounts

The bridge refuses to place orders on a live account until you set `"paperOnly": false` in `config.json` by hand and restart it. There is no way to change that from the dashboard or over HTTP. For a live login also set `tws.port` to TWS's live port (`7496`).

Try it on the paper login first: one focus, one preview, one small order, one cancel.

## The log

`logs/YYYY-MM-DD.jsonl`, one file per New York date, one JSON object per line: every request (with its result), every order with the alert's price, the computed prices and the order ids, every status change, every fill with `slip_pct` (the average fill against the alert's price), every message from TWS about an order. The token is never written. The files are not cleaned up; delete old ones when you like (today's file is what the daily count is read from at a start).

## HTTP API

JSON in and out. Success is `{ "data": … }`; failure is `{ "error": "…", "code": "…" }` with a 4xx / 5xx status. Every request except `OPTIONS` needs the `X-Bridge-Token` header.

| Call | Body | Answer |
|---|---|---|
| `GET /status` | – | version, TWS connection, paper / live, the switches, the order defaults, the limits, today's counts |
| `POST /focus` | `{ ticker }` | `{ ticker, conid, group }` |
| `POST /preview` | `{ ticker, alert_price, alert_stop?, qty? }` | `{ ticker, qty, limit, take_profit, stop, stop_limit, notional, checks }` |
| `POST /order` | `{ ticker, alert_price, alert_stop?, qty?, stage?, alert_at?, alert_id? }` | `{ order_id, ticker, qty, limit, take_profit, stop, stop_limit, status }` |
| `GET /orders` | – | today's orders, newest first |
| `POST /cancel` | `{ order_id }` | `{ order_id, status }` (a buy that has not filled; TWS cancels its exits with it) |
| `POST /halt` | `{ halted }` | `{ halted }` |

| Status | Codes |
|---|---|
| 400 | `bad_request` (a field is missing, wrong or unknown) |
| 401 / 403 | `bad_token` / `origin_not_allowed`, `bad_host` |
| 404 / 405 | `not_found`, `unknown_ticker`, `unknown_order` / `method_not_allowed` |
| 409 | `disabled`, `halted`, `paper_only`, `daily_limit`, `duplicate`, `ambiguous_ticker`, `already_filled`, `already_done` |
| 413 / 415 | `body_too_large` (4 KB) / `not_json` |
| 422 | `stale_alert` (older than 10 min), `too_many_shares`, `too_large`, `chase`, `bad_prices` |
| 502 | `tws_refused` (TWS said no to the order), `send_failed`, `tws_error`, `no_ask` (TWS answered the ask request with an error) |
| 503 / 504 | `tws_down`, `tws_offline` / `tws_timeout`, `no_ask` (no ask in time) |
| 500 | `not_saved` (halt applied but not written to `config.json`), `log_failed` (order not sent), `internal` |

If TWS refuses one leg of a bracket before the buy has filled, the bridge cancels that bracket, so a buy is never left working without the exits you clicked for. That is the only thing it cancels on its own.

## Tests

```bash
npm test          # a fake TWS; no real TWS, no network
npm run typecheck
```
