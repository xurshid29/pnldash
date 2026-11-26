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

Then link the windows that should follow the alerts (chart, order entry, Level 2 …): click the chain-link icon in each window's title bar and pick the same colour group for all of them. TWS shows a colour; the API knows the groups only by number, and the bridge moves the one whose number is `displayGroup` in `config.json` (default `1`).

To find the number, look at what the bridge prints a second or so after it connects: what each group shows, read from TWS.

```
display groups: 1 nothing · 2 nothing · 4 WHLR ← windows are linked here · 5 nothing
displayGroup is 1 but the linked windows look like group 4: set "displayGroup": 4 in config.json and restart
```

The group that shows the ticker your windows show is yours. The second line appears only when `displayGroup` looks wrong, and it is a guess (a group no window is linked to shows nothing, so a single group that shows something is taken to be the linked one). It is said once per connection; `GET /status` carries the same, kept current, as `display_groups`. Reading the groups changes no window and sends nothing but the group subscriptions and ticker lookups.

After that the console says each time the configured group changes, and whether a focus did it (`group 4 now shows RAYA (755531415@SMART) ← focus`) or it was changed in TWS (`← changed in TWS`). If a focus is marked there and no window moved, the windows are linked to another group. The log keeps the same trail for every group (see "The log").

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
| `displayGroup` | `1` | The number of the TWS display group that `/focus` moves (the bridge prints what each group shows when it connects). |
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

`logs/YYYY-MM-DD.jsonl`, one file per New York date, one JSON object per line: the requests with their results, every order with the alert's price, the computed prices and the order ids, every status change, every fill with `slip_pct` (the average fill against the alert's price), every message from TWS about an order. The token is never written.

Not every request is a line. The dashboard's polls (`GET /status`, `GET /orders`) are left out when they are answered; one that fails is logged. Refused calls (wrong token, wrong origin) are logged up to 30 a minute and counted beyond that.

To check a focus against what TWS did with it:

- `focus`: `ticker`, `conid`, `group`, `sent` (the exact string that went to TWS, `"<conid>@SMART"`) and `request_id` (the group's subscription it went under).
- `display_group_shows`: one line every time TWS says what a group shows: `group`, `contract_info` (exactly as TWS sent it), `ticker` (when known), `request_id`, and `cause`: `focus` (it names the contract a focus sent to that group within the last 2 s), `initial` (the group's first word on a connection) or `tws` (changed in TWS). Nothing is thinned out; only an event that repeats the one before it word for word, with no focus in between, is left out.
- `display_group_ticker`: the name of a contract id, when TWS gives it.

A `focus` line with no `display_group_shows` line after it means TWS took the request and reported no change. A `display_group_shows` line with `cause: "focus"` while no window moved means TWS changed that group and the windows are linked to another one. For the configured group the console says the same as it happens:

```
group 4 now shows RAYA (755531415@SMART) ← focus
group 4 now shows WHLR (700@SMART) ← changed in TWS
```

The files are not cleaned up; delete old ones when you like. Today's file is what the day's orders are read back from at a start: the daily count, the duplicate window and the one-order-per-alert rule all survive a restart through it.

## HTTP API

JSON in and out. Every request except `OPTIONS` needs the `X-Bridge-Token` header; a `POST` body is `Content-Type: application/json`, at most 4 KB, and holds only the fields listed (an unknown field is a 400; `null` for an optional field means "not given").

- Success: `{ "data": … }`
- Failure: `{ "error": "the sentence to show", "code": "a_stable_name" }` with a 4xx / 5xx status. `error` is for the operator; `code` is for the page (the table below).

| Call | Body | `data` |
|---|---|---|
| `GET /status` | – | `{ version, tws: { connected, port, paper, accounts, offline }, enabled, halted, paper_only, display_group, display_groups: [{ id, shows }], order, limits, today: { orders, filled } }` |
| `POST /focus` | `{ ticker }` | `{ ticker, conid, group }` |
| `POST /preview` | the same body as `/order` | `{ ticker, qty, limit, take_profit, stop, stop_limit, notional, checks }` |
| `POST /order` | `{ ticker, alert_price, alert_stop?, qty?, stage?, alert_at?, alert_id? }` | `{ order_id, ticker, qty, limit, take_profit, stop, stop_limit, status }` |
| `GET /orders` | – | today's orders (New York date), newest first |
| `POST /cancel` | `{ order_id }` | `{ order_id, status }` |
| `POST /halt` | `{ halted }` | `{ halted }` |

Notes on the calls:

- **`/status`**: `tws.connected` means the socket to TWS is up and TWS has finished its handshake. `tws.accounts` are masked (`DU…67`); `tws.paper` is true when every one of them starts with `D`. `tws.offline` is true while TWS is connected to the bridge but says it has lost IB's servers: orders are refused (`tws_offline`) until it is back, because TWS would hold them and send them later. `display_group` is the configured group; `display_groups` is what each of TWS's groups shows now, by group number: `shows` is a ticker, the raw `"<conid>@<exchange>"` while the ticker is not known, `"combo"`, or `null` for nothing (the list is empty while TWS is not connected or has not listed its groups). `order` and `limits` are the settings from `config.json`. `today.filled` counts the orders with any fill.
- **`/focus`** works when orders are disabled, halted or the account is live: it places nothing.
- **`/order`**: `ticker` is upper-cased and must look like a US symbol. `alert_price` and `alert_stop` are JSON numbers above 0 and under 100000. `qty` is a whole number (default `order.qty`). `alert_at` is ISO text or epoch milliseconds / seconds; an alert older than 10 minutes is refused. `alert_id` is a string or a number and is kept as a string; `stage` is free text up to 40 characters. Both are stored with the order.
  The answer waits up to 1 s for TWS's first word: `status` is TWS's own (`PreSubmitted`, `Submitted`, …) or `PendingSubmit` when none came in time. If TWS refuses within that second the answer is 502 `tws_refused` with TWS's text.
- **`/preview`** runs every check `/order` would, with the same body, and sends nothing: the order that would go out, or the error `/order` would give. `checks` is a list of `{ name, detail }`, one per check passed (`switches`, `account`, `alert`, `alert_age`, `shares`, `daily`, `duplicate`, `contract`, `limit`, `take_profit`, `stop`, `notional`; `alert` and `alert_age` only when the body carries `alert_id` / `alert_at`). `take_profit`, `stop` and `stop_limit` are `null` when that leg is switched off.
- **`/orders`**: each item is `{ order_id, ticker, conid, placed_at, asked, sent, status, filled_qty, avg_fill_price, slip_pct, legs, error, note }`. `asked` is what the page sent (`alert_price`, `alert_stop`, `qty`, `stage`, `alert_at`, `alert_id`); `sent` is what went to TWS (`qty`, `limit`, `take_profit`, `stop`, `stop_limit`, `price_from`, `stop_from`, `outside_rth`, `order_ids`). `status`, `filled_qty` and `avg_fill_price` are the buy's; `legs.take_profit` and `legs.stop` carry the exits' own. `error` is the last message from TWS that stopped the order or a leg; `note` the last warning. A buy that never reached TWS, or that TWS says it does not have, reads `Inactive`.
- **`/cancel`** takes the `order_id` of a buy from `/orders` that has not filled; TWS cancels its exits with it. A filled buy is refused (`already_filled`): its take-profit and stop stay in TWS.
- **`/halt`** is the off switch, saved to `config.json`. `paperOnly` and `enabled` cannot be changed over HTTP.

One order per alert: when `/order` (or `/preview`) carries an `alert_id` that an order placed today already carries, it is refused with `duplicate_alert` and the text "this alert already has an order (order 123, RAYA, 04:27:31 New York)". This holds across tabs, reloads and a restart of the bridge. An alert is used up only while its order is still working, or once anything of it has filled. An order that has ended with nothing filled frees its alert, whoever ended it: you cancelled it (from the dashboard or in TWS), TWS refused it, or it could not be sent. "Ended" means TWS has confirmed it (`Cancelled`, `Inactive`); while a cancel is only asked for (`PendingCancel`) the buy can still fill and the alert stays taken. A cancelled order that had a partial fill keeps its alert. A cancelled order still counts toward `maxOrdersPerDay`, and the same ticker inside `duplicateWindowSec` is refused separately (`duplicate`), with or without an `alert_id`.

| Status | `code` |
|---|---|
| 400 | `bad_request` (a field is missing, wrong or unknown; the body is not a JSON object) |
| 401 | `bad_token` |
| 403 | `origin_not_allowed`, `bad_host` (the call was not addressed to `127.0.0.1` / `localhost`) |
| 404 | `not_found` (no such path), `unknown_ticker`, `unknown_order` |
| 405 | `method_not_allowed` |
| 409 | `disabled`, `halted`, `paper_only`, `duplicate_alert`, `daily_limit`, `duplicate`, `ambiguous_ticker`, `already_filled`, `already_done` |
| 413 | `body_too_large` (over 4 KB) |
| 415 | `not_json` |
| 422 | `stale_alert` (older than 10 min), `too_many_shares`, `too_large`, `chase`, `bad_prices` |
| 500 | `not_saved` (halt applied but not written to `config.json`), `log_failed` (the order was not sent), `internal` |
| 502 | `tws_refused` (TWS said no to the order), `send_failed`, `tws_error`, `no_ask` (TWS answered the ask request with an error) |
| 503 | `tws_down` (TWS not connected), `tws_offline` (TWS has lost IB's servers) |
| 504 | `tws_timeout`, `no_ask` (no ask in time) |

If TWS refuses one leg of a bracket before the buy has filled, the bridge cancels that bracket, so a buy is never left working without the exits you clicked for. The same happens when a leg cannot be sent. Those are the only cancels it sends on its own.

## Tests

```bash
npm test          # a fake TWS; no real TWS, no network
npm run typecheck
```
