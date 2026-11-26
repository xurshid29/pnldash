# tws-bridge

A small program that runs on this Mac, next to TWS. It lets the dashboard in the browser do four things in the TWS you are already logged in to:

1. **Focus**: make the TWS windows linked to one display group jump to an alert's ticker.
2. **Order**: place your usual bracket (limit buy + take-profit + stop-limit) with one click.
3. **Chase**: move a buy that has not filled up to the ask, with one click (see "Chase").
4. **Sell**: get out of what an order bought, at the bid, with one click (see "Sell").

The browser page talks to the bridge at `http://127.0.0.1:8765`; the bridge talks to TWS over TWS's own socket API. Nothing about orders goes to the pnldash server.

What it does not do:

- It never places or changes an order by itself. Every order, chase and sell is one click of yours; nothing is retried, queued or re-sent, also not after TWS reconnects. There is no loop or timer that follows a price. The one thing it sends on its own is a cancel, in three cases (see "What the bridge does on its own").
- It does not take prices from the web page. The page sends the ticker, the alert's price, the alert's stop and a quantity (a chase and a sell send only the order's id); the limit, take-profit and stop are worked out here from `config.json` and TWS's own quotes.
- It does not listen on the network: `127.0.0.1` only, and every call needs the token from `config.json`.
- It does not watch a position. After the buy fills, the take-profit and the stop live in TWS; the bridge touches them again only when you click Sell, or to cancel one that is left working after the order has sold everything.
- It never sells more than an order bought, and never more than the account holds: it cannot open a short.
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

Read once, at the start: after an edit, restart the bridge. A missing or unknown setting, a negative number or a port clash stops the start with the list of what is wrong. The exception is the settings marked *optional* below: they were added after the first `config.json` files were written, so a file without them still loads and each takes its default. Add them to your file when you want another value. The bridge writes the file itself only to save the halt switch.

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
| `order.qty` | `100` | Shares, when the click does not say and `order.amountUsd` is `0`. |
| `order.amountUsd` | `0` | *Optional.* Dollars per buy. Above `0`, a click that names no quantity buys as many whole shares as this pays for at the buy's limit (rounded down, so the order never costs more), and `order.qty` is not used. `0` = off. May not be above `limits.maxNotionalUsd`. |
| `order.priceFrom` | `"alert"` | `"alert"`: the limit starts from the alert's price. `"ask"`: from TWS's ask at the click (needs real-time data in TWS; waits at most 0.8 s). |
| `order.askFallback` | `"alert"` | *Optional.* With `priceFrom: "ask"`, what a buy does when TWS gives no live ask at the click: `"alert"` prices it from the alert instead and says so; `"none"` refuses (`no_ask`). A chase and a sell never fall back. |
| `order.limitOffsetPct` | `1.0` | Buy limit = that price + this %. |
| `order.maxChasePct` | `3.0` | If the limit would be more than this % above the alert's price: no order ("price has run N% past the alert"). A chase has the same cap. |
| `order.takeProfitPct` | `10.0` | Take-profit = limit + this %. `0` = no take-profit. |
| `order.stopPct` | `5.0` | Stop = limit − this %. `0` = no stop at all. |
| `order.stopLimitOffsetPct` | `1.0` | The stop's own limit = stop − this %. |
| `order.useAlertStop` | `true` | Use the alert's stop instead, when it is below the limit and no more than 3 × `stopPct` under it. |
| `order.outsideRth` | `true` | Orders may work in the pre-market and after hours. |
| `order.maxChases` | `5` | *Optional.* Most chases of one buy, and most later moves of one sell. A whole number, 0 to 20; `0` switches `/chase` off. |
| `order.sellOffsetPct` | `2.0` | *Optional.* A sell's limit = TWS's bid − this %. 0.1 to 20. |
| `limits.maxShares` | `500` | Most shares in one order. |
| `limits.maxNotionalUsd` | `1000` | Most dollars in one order (shares × limit). |
| `limits.maxOrdersPerDay` | `20` | Orders per New York date. Counted from the log, so a restart does not reset it. |
| `limits.duplicateWindowSec` | `10` | The same ticker again within this many seconds is refused as a duplicate. |

Prices are rounded to the US tick: $0.01 from $1 up, $0.0001 below $1. The buy limit and the take-profit go to the nearest tick, the stop, its limit and a sell's limit down.

The buy is a `DAY` limit order; the take-profit and the stop are `GTC` and stay until one fills or you cancel them. A sell order the bridge places itself is a `DAY` limit order.

### Sizing a buy in dollars

With `order.amountUsd` above `0`, the quantity of a buy is `amountUsd ÷ limit`, rounded down to whole shares, where the limit is the rounded price the order carries: `$400` at a limit of `2.53` is 158 shares (`$399.74`). A click that names a quantity (`qty`) uses that quantity instead. All the limits still apply to the result, and say so in dollars: "$400 at 0.0412 is 9,708 shares, above maxShares (500)". If one share costs more than the amount, the order is refused (`too_expensive`). `/preview`, `/order` and each item of `/orders` carry `sizing`: `{ "mode": "usd", "amount_usd": 400 }` or `{ "mode": "shares" }`.

A chase never changes the quantity. The buy then costs more than the amount, by what the chase added to the price and no more (at most `maxChasePct` above the alert).

## Chase

For a buy that has not filled because the price ran away from it. `POST /chase { order_id }` moves it, once per click:

- New limit = TWS's ask at the click (one snapshot, 0.8 s at most) + `limitOffsetPct`, rounded like every buy limit.
- The cap is the one a new order has, against the order's own alert price: more than `maxChasePct` above it and nothing is sent ("the ask 0.5310 + 1% is 6.2% past the alert (the limit is 3%)", code `chase`).
- A chase only moves the limit up. If the new limit is not above the current one, nothing is sent (`no_change`).
- The exits move with the buy, so the bracket keeps its distances: the take-profit is worked out again from the new limit; so is the stop, when it came from `stopPct`. A stop that came from the alert stays where it is. An exit that has already ended in TWS is left alone.
- The quantity stays what it is. A change never carries more shares than TWS last reported for that order (so an order you made smaller by hand in TWS is not made bigger again).
- At most `order.maxChases` chases per order (`chase_limit`), and none within 300 ms of the last change to the order (`too_soon`).
- It needs what an order needs: TWS connected and online, not halted, `enabled`, `paperOnly`. The daily order count, the ticker's duplicate window and `maxNotionalUsd` do not apply: it is the same order and the same shares.

Which buys: one the bridge placed today (New York date) that is still working with something left to fill. A filled buy is `already_filled`; a cancelled one, or one being cancelled, is `already_done`.

How it is sent: a change to an order is the whole order again under its own id, with the new price. A chase is up to three such messages, in this order: **the buy, then the take-profit, then the stop**. The buy goes first because its price is what the click is for, and because of what a failure part-way leaves: the buy at its new limit with an exit still at its old, lower price, which is a bracket with a wider stop or a nearer target than intended, never one whose stop sits above the buy.

When something goes wrong:

- A message cannot be sent (the connection): the ones before it stay sent, the ones after it are not tried, `/orders` shows exactly that, and the answer says which leg is where (`send_failed`).
- TWS refuses a change: that leg goes back, on the book, to the price TWS still has, and `error` on the order says what TWS said. A refused change is not a refused order: nothing is cancelled. If it was the buy's change that was refused, the answer is 502 `tws_refused`; the exits may have taken theirs, and `/orders` shows where they are.
- The buy fills while the chase is on its way: TWS refuses the change to the buy (it has filled) and may take the changes to the exits. The answer is then a normal one with `status: "Filled"`, the limit the buy really had, and the exits where TWS has them, which can be a little higher than a bracket built from the fill would have them.
- Nothing is sent a second time, and nothing is moved back on its own. The next click is a whole new chase from where things stand.

`sent` in `/orders` holds the current prices and `sent.first_limit`, `first_take_profit`, `first_stop`, `first_stop_limit` the ones the bracket was placed with. The current prices also follow TWS's own report of an order, so a buy you drag in TWS is chased from where you dragged it.

## Sell

For getting out now. `POST /sell { order_id }` sells what that order bought and still holds:

- Limit = TWS's bid at the click (one snapshot, 0.8 s at most) − `order.sellOffsetPct`, rounded down to the tick. It is a marketable limit: it should fill at the bid, and the limit is the worst price accepted.
- Quantity = what the order still holds by the bridge's book (bought, less what its take-profit, its stop and earlier sells have sold), and never more than **the account's position in that stock, read from TWS at the click**. If TWS does not report the position within 1 s, nothing is sent (`no_position`). If the account holds none, nothing is sent (`nothing_to_sell`). With several accounts in one login the smallest position counts.
- It never adds a second way out next to one that is working:
  - **The bracket's exits are alive** (the usual case): no order is added. The take-profit leg is moved down to the sell limit. It fills, and TWS cancels the stop with it, as it does when a take-profit fills at its target. `via: "take_profit"`.
  - **The exits are gone** while shares are held: one plain `SELL LMT` (`DAY`, `outsideRth` as configured) for the held quantity. `via: "new_order"`.
  - **A sell is already working** (you clicked before and it has not filled): that same order is moved to the new bid − offset. It moves down only (`no_change` otherwise), not within 300 ms of the last move (`too_soon`), and at most `order.maxChases` times (`chase_limit`).
- If the buy is only part-filled and still working, its unfilled rest is cancelled first, and the sell waits (1.5 s at most) for TWS to confirm that. TWS may take the exits with the buy or keep them for the shares that filled; the bridge gives it a moment (0.25 s) to say which, then moves the take-profit (for the filled quantity) or places the sell order, as above. If the cancel is not confirmed in time, nothing is sold and the answer is 504 `cancel_pending`: click again.
- If only a stop is left (no take-profit in the bracket, or it was cancelled by hand), the stop is cancelled first and confirmed cancelled before the sell order goes in, so the two cannot both sell.
- A halt does **not** block `/sell` (or `/cancel`), and neither does `enabled: false`: getting out is always possible. It needs TWS connected and online, and `paperOnly` holds. The daily order count does not apply.

When something goes wrong, nothing is sold twice and the book does not claim a sell TWS does not have: a refused move puts the order's price back on the book; a refused new sell order is cancelled once by its id, so the book ends with TWS's own word on it, and the next click can place another. The answer is 502 `tws_refused` with TWS's words.

Each item of `/orders` has `held_qty` (what a sell would sell) and, once Sell was clicked, `exit`: `{ via, order_id, qty, limit, first_limit, bid, reprices, sent_at, status, filled_qty, avg_fill_price, exit_pct }`. `status`, `filled_qty` and `avg_fill_price` are those of the order doing the selling; `exit_pct` is its average price against the buy's average fill (negative = sold lower).

What the bridge cannot know: shares you sold by hand in TWS. Its book still counts them as held, and the position check is what stops a second sale. If you close a position by hand, cancel that bracket's take-profit and stop in TWS too: an exit left working on a position that is gone is the one way this setup can go short, and the bridge cannot see that one (see the next section for the ones it can).

## What the bridge does on its own

Reading aside (what the display groups show, an order's status and fills, the open orders when it connects), the bridge sends TWS nothing without a click, with three exceptions. Each is a cancel of an order the bridge itself placed, sent once per order id, and logged:

1. **A bracket whose leg TWS refused, or that could not be sent whole, before the buy filled** is cancelled (`order_cleanup`), so a buy is never left working without the exits you clicked for.
2. **A sell order of the bridge's own that TWS refused** is cancelled by its id (`sell_cleanup`), so the book ends with TWS's word on it and the next Sell can place another without risking two.
3. **A sell order left working on an order that holds nothing** is cancelled (`exit_cleanup`). When an order has sold everything it bought (through its take-profit, its stop or a Sell) and its buy can add no more, no sell order of that order may stay working: it would sell shares that are not there. TWS cancels the other exit of a bracket itself when one fills. The bridge gives it 1 s to do so; a take-profit, a stop or a Sell order of that order that is still working then is cancelled. This also runs when the bridge connects (after a restart, or a reconnect), 1 s after the connection, on the book as rebuilt from the log and corrected by what TWS reports.

About the third:

- It is never done to an order that still holds shares, nor while the order's buy is still working (shares to come need their stop). It sends a cancel and nothing else.
- While such an order is working and TWS has not confirmed the cancel, the order's item in `/orders` has `loose_exit: true`, and `note` says what was cancelled and why ("order 1000 holds nothing any more (100 bought, all sold) and its stop order 1002 was still working 1000 ms later: the bridge cancelled it"). TWS's answer ends it: the order shows Cancelled, or TWS says it has no such order (it then reads `Inactive`), or that it cannot be cancelled because it is already Cancelled or Filled.
- The cancel is sent once. If `loose_exit` stays `true`, TWS has not confirmed it: look at that order in TWS.
- It goes by the bridge's book. Shares sold by hand in TWS are still "held" for the book, so an exit left behind by a position closed by hand is not found by this.

## To try on the paper login, in market hours

The tests run against a fake TWS. These are the things only the real one can confirm; each is one or two clicks on the paper account, with `logs/<today>.jsonl` open.

1. **A chase changes a working bracket.** Place a buy well under the market, click Chase. In TWS the buy, the take-profit and the stop should each show the new price, same ids, no new orders. In the log: a `chase` line, and no `change_refused` after it.
2. **TWS reports a changed order back.** After that chase the answer should come in well under a second. If every chase or sell answers only after a full second, TWS is not sending its report (`openOrder`) for changes: the order has still gone out, but the bridge is waiting for a confirmation that does not come, and that wait needs changing.
3. **A hand-made change is followed.** Drag the working buy to another price in TWS. `/orders` should show that price in `sent.limit` within a moment (an `order_open` line in the log).
4. **Sell through the take-profit.** Let a small buy fill, click Sell. The take-profit order should jump to bid − 2% and fill, **and the stop must show Cancelled** in TWS right after. This is the one to watch. Then look in the log for an `exit_cleanup` line: there should be **none**, which means TWS cancelled the stop itself. If there is one, the bridge's net did it after 1 s (the stop is gone either way, and `/orders` shows a `note`): the sell works, but the stop sat alone for that second, and it is worth knowing that a moved take-profit no longer takes its stop with it.
5. **The same without a click.** Let a take-profit fill at its target, or a stop fill, on another small order: the other exit should go at once, again with no `exit_cleanup` line. `loose_exit` in `/orders` should never be seen `true` for more than a moment; if it stays, TWS has not confirmed a cancel the bridge sent, and that order needs a look in TWS.
6. **A part-filled buy.** Hard to make on purpose (a buy for more shares than the ask shows, in a thin stock). Click Sell while part is filled: note in the log whether the exits were cancelled with the buy (`order_status` lines for both legs, `Cancelled`) or stayed, and at what quantity TWS shows them.
7. **The position line.** After a fill, click Sell and look at the `sell` line: `position` should be the shares TWS shows for that stock. A `no_position` answer means TWS did not answer the positions request within 1 s.
8. **Bid and ask in time.** In the pre-market and in regular hours, click Chase and Sell on a thin stock: `no_ask` / `no_bid` means no live quote came within 0.8 s (or the data is delayed: delayed quotes are not used).
9. **Sell with the exits gone.** Cancel a filled buy's take-profit and stop by hand in TWS, then click Sell: one new `SELL LMT` should appear and fill; a second click while it works should move that same order, not add one.
10. **A buy that fills as you chase it.** Not something to stage; when it happens, the answer says `Filled` and `/orders` shows the exits where TWS has them. Check them against TWS once.
11. **A restart with orders open.** Stop the bridge while a filled order's exits are working, start it again: `/orders` should show the same order, and nothing should be cancelled (no `exit_cleanup` line), because the order still holds its shares.
12. **`priceFrom: "ask"` and its fallback.** With `"priceFrom": "ask"`, `/preview` an alert: `price_from` should be `"ask"` in market hours. Outside them, or on a stock with no live data, it should be `"alert"` with the note "no live ask from TWS in 800 ms: priced from the alert".

## Live accounts

The bridge refuses to place orders on a live account until you set `"paperOnly": false` in `config.json` by hand and restart it. There is no way to change that from the dashboard or over HTTP. For a live login also set `tws.port` to TWS's live port (`7496`).

Try it on the paper login first: one focus, one preview, one small order, one cancel.

## The log

`logs/YYYY-MM-DD.jsonl`, one file per New York date, one JSON object per line: the requests with their results, every order with the alert's price, the computed prices and the order ids, every status change, every fill with `slip_pct` (the average fill against the alert's price), every message from TWS about an order. The token is never written.

A chase and a sell are logged like an order, before anything is sent (one that cannot be written down is not sent):

- `chase`: `order_id`, the `ask` it read, `alert_price`, `chase_pct`, `chases` (the count after it), `legs` (which orders were changed), `from` (the prices before) and `prices` (the prices after).
- `sell`: `order_id`, the `bid` it read, `position` (the account's, from TWS), `held` (by the book), `via`, `qty`, `limit`, `reprice` (a move of a sell already working) and `exit` (the block `/orders` shows).
- `change_refused`: TWS refused a change; `leg`, `code`, `message`, and `prices` (what the book went back to).
- `order_open`: TWS reported an order with a price or quantity other than the book's (a change made by hand in TWS); `leg` and the new `prices`.
- `chase_failed` / `sell_failed`: a message could not be sent; `sell_cleanup`: a refused sell order was cancelled by its id; `cancel` with `for: "sell"`: a cancel a sell had to send first.
- `exit_cleanup`: a sell order left working on an order that holds nothing was cancelled by the bridge; `leg`, `leg_order_id`, `why` and the `note` put on the order.

The sell order's own status changes and fills are `order_status` and `fill` lines with `leg: "exit"`.

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

The files are not cleaned up; delete old ones when you like. Today's file is what the day's orders are read back from at a start: the daily count, the duplicate window and the one-order-per-alert rule all survive a restart through it, and so do the chases (their count and the prices they left), a sell and what it has sold, and what each order still holds. A file written by an older bridge reads back too.

## HTTP API

JSON in and out. Every request except `OPTIONS` needs the `X-Bridge-Token` header; a `POST` body is `Content-Type: application/json`, at most 4 KB, and holds only the fields listed (an unknown field is a 400; `null` for an optional field means "not given").

- Success: `{ "data": … }`
- Failure: `{ "error": "the sentence to show", "code": "a_stable_name" }` with a 4xx / 5xx status. `error` is for the operator; `code` is for the page (the table below).

| Call | Body | `data` |
|---|---|---|
| `GET /status` | – | `{ version, tws: { connected, port, paper, accounts, offline }, enabled, halted, paper_only, display_group, display_groups: [{ id, shows }], order, limits, today: { orders, filled } }` (`order` has every setting of the table above, `order.maxChases`, `order.sellOffsetPct`, `order.amountUsd` and `order.askFallback` among them) |
| `POST /focus` | `{ ticker }` | `{ ticker, conid, group }` |
| `POST /preview` | the same body as `/order` | `{ ticker, qty, sizing, limit, take_profit, stop, stop_limit, notional, price_from, note, checks }` |
| `POST /order` | `{ ticker, alert_price, alert_stop?, qty?, stage?, alert_at?, alert_id? }` | `{ order_id, ticker, qty, sizing, limit, take_profit, stop, stop_limit, price_from, note, status }` |
| `GET /orders` | – | today's orders (New York date), newest first |
| `POST /cancel` | `{ order_id }` | `{ order_id, status }` |
| `POST /chase` | `{ order_id }` | `{ order_id, limit, take_profit, stop, stop_limit, chases, status }` |
| `POST /sell` | `{ order_id }` | `{ order_id, qty, limit, status, via }` |
| `POST /halt` | `{ halted }` | `{ halted }` |

Notes on the calls:

- **`/status`**: `tws.connected` means the socket to TWS is up and TWS has finished its handshake. `tws.accounts` are masked (`DU…67`); `tws.paper` is true when every one of them starts with `D`. `tws.offline` is true while TWS is connected to the bridge but says it has lost IB's servers: orders are refused (`tws_offline`) until it is back, because TWS would hold them and send them later. `display_group` is the configured group; `display_groups` is what each of TWS's groups shows now, by group number: `shows` is a ticker, the raw `"<conid>@<exchange>"` while the ticker is not known, `"combo"`, or `null` for nothing (the list is empty while TWS is not connected or has not listed its groups). `order` and `limits` are the settings from `config.json`. `today.filled` counts the orders with any fill.
- **`/focus`** works when orders are disabled, halted or the account is live: it places nothing.
- **`/order`**: `ticker` is upper-cased and must look like a US symbol. `alert_price` and `alert_stop` are JSON numbers above 0 and under 100000. `qty` is a whole number (default `order.qty`). `alert_at` is ISO text or epoch milliseconds / seconds; an alert older than 10 minutes is refused. `alert_id` is a string or a number and is kept as a string; `stage` is free text up to 40 characters. Both are stored with the order.
  The answer waits up to 1 s for TWS's first word: `status` is TWS's own (`PreSubmitted`, `Submitted`, …) or `PendingSubmit` when none came in time. If TWS refuses within that second the answer is 502 `tws_refused` with TWS's text.
  `sizing` says how `qty` was arrived at (`{ mode: "usd", amount_usd }` or `{ mode: "shares" }`). `price_from` is what the limit was worked out from: with `priceFrom: "ask"` it is `"ask"`, or `"alert"` when there was no live ask and `askFallback` is `"alert"`; `note` then says why ("no live ask from TWS in 800 ms: priced from the alert") and is `null` otherwise.
- **`/preview`** runs every check `/order` would, with the same body, and sends nothing: the order that would go out, or the error `/order` would give. `checks` is a list of `{ name, detail }`, one per check passed (`switches`, `account`, `alert`, `alert_age`, `shares`, `daily`, `duplicate`, `contract`, `limit`, `take_profit`, `stop`, `notional`; `alert` and `alert_age` only when the body carries `alert_id` / `alert_at`). `take_profit`, `stop` and `stop_limit` are `null` when that leg is switched off.
- **`/orders`**: each item is `{ order_id, ticker, conid, placed_at, asked, sizing, sent, chases, status, filled_qty, avg_fill_price, slip_pct, held_qty, legs, exit, loose_exit, error, note }`. `asked` is what the page sent (`alert_price`, `alert_stop`, `qty`, `stage`, `alert_at`, `alert_id`); `sent` is what went to TWS (`qty`, `limit`, `take_profit`, `stop`, `stop_limit`, the four `first_…` prices the bracket was placed with, `price_from`, `stop_from`, `outside_rth`, `order_ids`), its prices being the current ones. `chases` counts the chases. `status`, `filled_qty` and `avg_fill_price` are the buy's; `legs.take_profit` and `legs.stop` carry the exits' own. `held_qty` is what the order bought and has not sold; `exit` is the last sell (see "Sell"), `null` until Sell is clicked. `loose_exit` is `true` while the order holds nothing and a sell order of its own is still working in TWS after the bridge asked to cancel it (see "What the bridge does on its own"): worth a plain warning on the page. `error` is the last message from TWS that stopped the order or a leg, or refused a change to one; `note` the last warning or notice (at first, why the price came from the alert when the ask was asked for; later, a sell order the bridge cancelled on its own). A buy that never reached TWS, or that TWS says it does not have, reads `Inactive`.
- **`/cancel`** takes the `order_id` of a buy from `/orders` that has not filled; TWS cancels its exits with it. A filled buy is refused (`already_filled`): its take-profit and stop stay in TWS. A halt does not block it.
- **`/chase`** and **`/sell`** take the `order_id` of a buy placed today and nothing else: no price and no quantity can be sent in. Both wait up to 1 s for TWS's answer to what they sent, so `status` is TWS's own and a refusal within that second is the answer (502 `tws_refused`). See "Chase" and "Sell".
- **`/halt`** is the off switch, saved to `config.json`. `paperOnly` and `enabled` cannot be changed over HTTP.

One order per alert: when `/order` (or `/preview`) carries an `alert_id` that an order placed today already carries, it is refused with `duplicate_alert` and the text "this alert already has an order (order 123, RAYA, 04:27:31 New York)". This holds across tabs, reloads and a restart of the bridge. An alert is used up only while its order is still working, or once anything of it has filled. An order that has ended with nothing filled frees its alert, whoever ended it: you cancelled it (from the dashboard or in TWS), TWS refused it, or it could not be sent. "Ended" means TWS has confirmed it (`Cancelled`, `Inactive`); while a cancel is only asked for (`PendingCancel`) the buy can still fill and the alert stays taken. A cancelled order that had a partial fill keeps its alert. A cancelled order still counts toward `maxOrdersPerDay`, and the same ticker inside `duplicateWindowSec` is refused separately (`duplicate`), with or without an `alert_id`.

| Status | `code` |
|---|---|
| 400 | `bad_request` (a field is missing, wrong or unknown; the body is not a JSON object) |
| 401 | `bad_token` |
| 403 | `origin_not_allowed`, `bad_host` (the call was not addressed to `127.0.0.1` / `localhost`) |
| 404 | `not_found` (no such path), `unknown_ticker`, `unknown_order` |
| 405 | `method_not_allowed` |
| 409 | `disabled`, `halted`, `paper_only`, `duplicate_alert`, `daily_limit`, `duplicate`, `ambiguous_ticker`, `already_filled`, `already_done`, `no_change` (a chase that would not move the buy up; a sell already at or under the new limit), `chase_limit` (`maxChases` reached, or `0`), `too_soon` (within 300 ms of the last change to that order), `nothing_to_sell` (nothing bought, nothing left, or no position in the account), `busy` (the order kept changing under a sell: click again) |
| 413 | `body_too_large` (over 4 KB) |
| 415 | `not_json` |
| 422 | `stale_alert` (older than 10 min), `too_many_shares`, `too_large`, `too_expensive` (one share costs more than `amountUsd`), `chase` (an order or a chase too far above the alert), `bad_prices` |
| 500 | `not_saved` (halt applied but not written to `config.json`), `log_failed` (nothing was sent), `internal` |
| 502 | `tws_refused` (TWS said no to the order, the chase or the sell), `send_failed`, `tws_error`, `no_ask` / `no_bid` (TWS answered the quote request with an error), `no_position` (TWS's position line could not be read) |
| 503 | `tws_down` (TWS not connected), `tws_offline` (TWS has lost IB's servers) |
| 504 | `tws_timeout`, `no_ask` / `no_bid` (no live quote in time), `no_position` (no position report in time), `cancel_pending` (a sell is waiting for TWS to confirm a cancel: click again) |

If TWS refuses one leg of a bracket before the buy has filled, the bridge cancels that bracket, so a buy is never left working without the exits you clicked for. The same happens when a leg cannot be sent. A sell order of the bridge's own that TWS refuses is cancelled by its id, once, so the book ends with TWS's word on it. A sell order left working on an order that holds nothing is cancelled after 1 s. Those are the only things it sends on its own ("What the bridge does on its own" has them in full); the cancels a sell sends first (the unfilled rest of a buy, a stop left alone) are part of that click.

## Tests

```bash
npm test          # a fake TWS; no real TWS, no network
npm run typecheck
```
