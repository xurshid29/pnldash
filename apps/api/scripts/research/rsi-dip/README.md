# RSI DIP — research

The 📐 script's DIP (v34, `docs/vwap-setup.md` §17.2): after an RSI cross, the RSI closes back under
its MA and turns up. These names are rarely on our Momentum screen, so the price history here is
Yahoo's, not our rows.

## Is a buy stop 8% above the DIP a better entry? (2026-11-14)

The operator: "most of them just keep going lower after the DIP candle … I tested the trades with
entering >=8% from the latest DIP setup, and it's working very well … placing the buy order with
StopLimit at 8% from dip and waiting, and if it keeps going down I just cancel them, otherwise they
get filled while ticker is moving up (usually it happens after a catalyst)", with KRMN and AKAN
(11-13) as samples.

```bash
cd apps/api/scripts/research/rsi-dip
# tickers.txt: the tickers of the live rsi / dip rows; ticker_days.csv: screener_ticker_days;
# live.csv: the live rows (ticker,epoch,stage,price,stop,dip_n,rsi_tf,candle_tf,late);
# onscreen.csv.gz: ticker, epoch / 300, max change %, grade from screener_results (5-minute buckets)
python3 -I dip_lift_study.py tickers.txt --cache <folder> --days ticker_days.csv --live live.csv \
        --onscreen onscreen.csv.gz --dump
```

`dip_lift_study.py` downloads Yahoo 5m bars (60 days, extended hours) for the 342 tickers the live
RSI / DIP alerts ran on from 11-10 to 11-13, replays the DIP rule with the operator's settings (a 10m
RSI checked at the 1h close, the rest default) through `pinesim.rsi_rule_direct`, and places a buy
stop L% above each DIP's close. The order lives until it fills, a newer DIP on the ticker replaces
it, or three sessions pass. 327 tickers have bars: 4,591 DIPs from 08-21 to 11-13 (77 a day), in
sample before 10-13, out of sample from it.

| after the fill | buy the DIP | | stop +8% | | any +8% move (control) | |
|---|---:|---:|---:|---:|---:|---:|
| | in | out | in | out | in | out |
| the order fills | 100% | 100% | 28% | 32% | 43% | 48% |
| an hour later | −0.2% | −0.1% | −1.6% | −0.7% | −0.8% | −0.3% |
| the session's last bar | −0.1% | −0.7% | −2.2% | −3.0% | −1.0% | −0.3% |
| higher at the session's end | 45% | 43% | 30% | 34% | 33% | 38% |
| stop −5%, target +10%, out at the session's end | −0.30% | −0.39% | −2.42% | −1.55% | −1.70% | −1.09% |
| stop −5%, no target, out at the session's end | −0.30% | −0.56% | −2.23% | −1.46% | −1.28% | −0.92% |
| …the same without its best 1% | −0.60% | −0.83% | −2.81% | −2.06% | −2.34% | −1.86% |
| three sessions later | −1.9% | −0.8% | −3.1% | −3.6% | −2.2% | −4.0% |
| the best / the worst in the rest of the session (median) | +1.5 / −1.9% | +1.9 / −2.4% | +2.0 / −6.5% | +3.3 / −5.7% | +3.2 / −6.9% | +3.8 / −6.0% |

- **The operator's observation holds:** a DIP drifts lower more often than not (43–45% are higher by
  the session's end; about −2% three sessions later).
- **The +8% fill is worse, not better.** It fills on 30% of the DIPs (a median 21 hours later), and
  after it the price is lower an hour later, at the session's end and three sessions later, in
  both halves. Two fills in three are under the fill at the session's end, and the typical one sees
  −6% first.
- **It isn't the DIP.** The same order above any other close of these names does the same or a
  little better: a +8% move on a low-float runner fades on average.
- **No variation is positive in both halves:** +3%, +5%, +10%, +12%, +15%; buying a 5m close over the
  level instead of a touch (−1.9% / +0.5% at the session's end, 32–34% higher); only the fills a
  stop-limit would get, without the 11% that gap 2% over the level (−1.7% / −2.0%); price buckets;
  the first turn of a dip.
- **Regular hours are the least bad:** fills between 09:30 and 16:00 (56% of them) are −0.4% / −0.4%
  at the session's end and −0.5% / −0.2% with the 5% stop. The pre-market and after-hours fills carry
  most of the loss.
- **On our Momentum screen at the fill** (a proxy for "after a catalyst"): 75 of 1,359 fills, −3.2% /
  −7.3% at the session's end. Too few to say more than that it doesn't stand out.
- **Why it looks good on paper:**
  - Buying the DIP itself on the DIPs whose +8% order later filled made +2.0% / +1.8% by the
    session's end and +5.8% / +5.9% in three sessions; on the others −1.0% / −1.8% and −4.9% / −4.4%.
    The +8% level picks the DIPs that worked, after the part that worked.
  - The winners are few and large. On the live alerts of 11-13 (161 with bars after them), 24
    reached +8%: 6 ended the session higher, 18 lower. AKAN was +151%; the average is +1.2% with it
    and −5.3% without. Several ran hard before fading (GP +36%, SST +34%, YMT +32%, POAS +22%), so
    selling into the spike is a different result from any exit measured here.

Limits:

- **The replay is the rule on consolidated prices, not the operator's alerts one for one.** Of the
  132 live DIP alerts on 11-13 (11:00–19:55 ET) it has 28 within 15 minutes, and 101 of its own.
  TradingView's feed is partial (three of four live alerts are judged a bar late) and an RSI against
  its MA is a knife edge. The live alerts themselves, graded on the same bars, agree with it for the
  one day there is.
- Yahoo's extended-hours bars carry thin prints (and no volume), so a touch there may not have been
  a fill. The regular-hours rows don't have that problem.
- Fills are at the level (or the open on a gap), the stop first when a bar holds both; no spread.
- The tickers are the ones on the watchlist this week. `listed` in the script's output counts only
  DIPs on days the ticker was already on the runners list by our own rule; it reads the same.
- The exits are fixed ones. The operator's own exit isn't known.

The operator's answer the same day: they don't take every DIP ("I usually check their price actions,
RSI, and previous behavior"), and "lets add the +8% level (better configurable) and alert to the
script. I want to experiment with it." Built as script v38's **LIFT** (`docs/vwap-setup.md` §17.3):
the level, drawn and named in the DIP's message, and an alert when price reaches it. From v38 each
LIFT is its own row in `tier_events` (stage `lift`), so the live test logs itself.

## Which RSI and check timeframes win most with a 15% take-profit? (2026-11-14)

The operator: "can we measure what chart timeframe + RSI and RSI Cross timeframe+RSI can have better
win rate, if we put take-profit around 15%?" The two timeframes are the script's `rsTfA` (the RSI's
candles, where the DIP is read: the chart and its RSI) and `rsCheck` (where the RSI cross is judged).

```bash
python3 -I rsi_tf_grid.py tickers.txt --cache <folder>             # +15%, held 3 sessions
python3 -I rsi_tf_grid.py tickers.txt --cache <folder> --hold 5    # also --tp 8, --tp 25
```

`rsi_tf_grid.py` replays the rule on the same cached bars for 20 pairs (an RSI of 5m, 10m, 15m, 30m
or 1h, checked at its own timeframe up to 4h) and grades two entries, the DIP's close and the LIFT
8% above it, with a +15% target, held for three sessions after the entry's.

- **reach** = no stop: the price got to +15% at some point in the hold.
- **win** = +15% came before the stop. A stop 8% under the entry needs 35% wins to break even; one
  15% under needs 50%.

| held 3 sessions, in / out of sample | DIPs a day | DIP: reach | DIP: win, stop −8% | LIFT: reach | LIFT: win, stop −8% | LIFT: win, stop −15% |
|---|---:|---:|---:|---:|---:|---:|
| RSI 5m checked at 5m | 205 | 20% / 27% | 14% / 20% | 34% / 37% | 21% / 24% | 29% / 31% |
| RSI 10m checked at 10m | 125 | 19% / 25% | 13% / 19% | 33% / 37% | 22% / 24% | 28% / 31% |
| **RSI 10m checked at 1h (the operator's)** | 77 | 19% / 27% | 13% / 19% | 35% / 39% | 22% / 25% | 30% / 33% |
| RSI 15m checked at 1h | 63 | 20% / 27% | 14% / 20% | 33% / 41% | 21% / 25% | 29% / 34% |
| RSI 15m checked at 4h | 24 | 21% / 29% | 14% / 22% | 35% / 40% | 23% / 27% | 31% / 33% |
| RSI 30m checked at 1h | 45 | 22% / 31% | 15% / 21% | 37% / 40% | 21% / 26% | 29% / 34% |
| RSI 30m checked at 4h | 26 | 19% / 30% | 14% / 20% | 35% / 43% | 21% / 29% | 28% / 36% |
| RSI 1h checked at 1h | 39 | 21% / 31% | 14% / 23% | 37% / 41% | 25% / 26% | 32% / 34% |
| RSI 1h checked at 4h | 25 | 20% / 32% | 15% / 24% | 32% / 43% | 23% / 26% | 29% / 36% |

- **The timeframes barely move it.** Across all 20 pairs the win rates sit within a few points of
  each other, and the order changes between the two halves. A 1h RSI is at the top for the LIFT
  with the −8% stop (25% / 26% against 22% / 25% for the operator's 10m at 1h), for a third to a
  half of the signals.
- **No pair gets near break-even.** The LIFT with a −8% stop wins 20–29% (35% needed), with a −15%
  stop 26–36% (50% needed). The average result per trade is negative for every pair, entry and
  stop: about −0.5% to −2% from the DIP, −1% to −3% from the LIFT.
- **The alerts' own stop** (a tick under the dip's low) is a median 1–3% from a DIP entry: 5–16%
  wins with a 15% target, nearly everything stopped first.
- **A longer hold** (5 sessions) adds about 6 points of reach everywhere (the LIFT reaches +15% on
  40–42% / 43–50%) and leaves the order as it is.
- **Other targets**, for the operator's pair with a −8% stop: +8% wins 30% / 38% from the DIP and
  33% / 36% from the LIFT (50% needed); +25% wins 7% / 11% and 13% / 15% (24% needed). The average
  stays negative.

The same limits as above: every DIP of the rule, not the operator's picks; the rule replayed on
consolidated prices; 60 days; this week's watchlist. The second half is better than the first for
every pair, so a difference between two pairs smaller than that gap says little.

## What would raise the win rate to 50%? (2026-11-14)

The operator, after the grid: "what could we do to raise it to 50%?"

```bash
python3 -I dip_features.py tickers.txt --cache <folder>      # the operator's 10m RSI checked at 1h, +15%, 3 sessions
```

`dip_features.py` takes the same DIPs and LIFTs and, for each, 22 things known before the entry (the
time of day, the price, the day's and the week's change, how far under the 5-session high, the
average daily range, the best day and the number of +15% days in the last 10 sessions, volume
against the days before, the RSI at the DIP and its low, the 1h RSI, the drop into the dip, the
DIP's number and age, the hours from the DIP to the LIFT). Each is cut in thirds on the in-sample
trades; a third counts when it wins in both halves. `w15` = +15% before a stop 15% under the
entry (50% needed); `reach` = +15% with no stop.

| LIFT entries, in / out of sample | trades | reach | w15 | average, stop −15% |
|---|---:|---:|---:|---:|
| all | 551 / 727 | 35% / 39% | 30% / 33% | −2.2% / −1.7% |
| average daily range over 17% | 183 / 279 | 48% / 49% | 40% / 37% | −2.0% / −2.5% |
| …under 9% | 184 / 182 | 24% / 29% | 22% / 27% | −1.8% / −0.1% |
| a +28% day in the last 10 sessions | 183 / 259 | 46% / 46% | 40% / 37% | −1.5% / −1.6% |
| …no day over +11% | 184 / 234 | 23% / 35% | 21% / 34% | −2.7% / −0.2% |
| 3+ days of +15% in the last 10 sessions | 118 / 139 | 42% / 57% | 37% / 46% | −3.1% / +0.0% |
| 18%+ under the 5-session high | 184 / 371 | 47% / 47% | 39% / 37% | −1.7% / −2.0% |
| the LIFT within 16 hours of the DIP | 184 / 316 | 43% / 48% | 36% / 38% | −1.6% / −1.2% |
| …later than 16 hours | 367 / 411 | 30% / 32% | 27% / 29% | −2.4% / −2.1% |
| **a +28% day in the last 10 + within 16 hours** | 90 / 157 | 51% / 57% | **43% / 46%** | −1.2% / −0.0% |
| 3+ days of +15% + within 16 hours | 68 / 95 | 46% / 63% | 40% / 52% | −2.2% / +1.5% |

- **Nothing reaches 50% in both halves.** The best single conditions take the LIFT from about 31% to
  37–40%, the best pair to 43% / 46%. One pair is 52% out of sample and 40% in sample.
- **What raises it is how much the name moves**, in several forms that are one thing: a large daily
  range, big days in the last two weeks, a low price, a deep drop, far under the recent high. A
  name that moves 17% a day gets to +15% twice as often as one that moves 9%.
- **It doesn't raise the result.** The same names hit the stop more often and harder: the average
  per trade stays between about −3% and 0% for every one of them. A fixed +15% is a small move for
  a wild name and a large one for a calm name, so the win rate at +15% mostly measures the name.
- **A quick LIFT is the one separate thing:** reached within 16 hours of the DIP it wins 36% / 38%,
  later 27% / 29%.
- **What makes no difference:** how oversold the RSI was (its value at the DIP, its low, the 1h
  RSI), the DIP's number and its age, the day's or the week's change, the volume of the day before.
- **From the DIP itself** (4,297 entries, 17% / 23% overall) the same things lead: a daily range over
  12% gives 29% / 32%. The best pair, a DIP more than 2% under the day's average price with little
  regular-hours volume yet, gives 43% / 39% with an average of +1.0% / +0.1% on 127 / 148 trades —
  one pair out of many tried, so a lead to watch, not a finding.
- **The target and the stop move the win rate by themselves**, without a better trade: with a +8%
  target and a −15% stop the LIFT wins 42% / 47%, and then needs 65% to break even.

Limits as above, plus: 22 features and their pairs were tried on about 1,300 LIFTs, so some of the
best rows are luck; the thirds are cut in sample and only rows that hold in both halves are quoted.

## The LIFT at 10% with the MACD line above zero (2026-11-15)

The operator: "what if I set LIFT % to 10%, and add MACD and enter only when LIFT fires and MACD
line above the zero?"

```bash
python3 -I lift_macd.py tickers.txt --cache <folder>      # LIFT 8 / 10 / 12%, MACD 12 / 26 / 9 on 5m, 10m, 30m, 1h
```

`lift_macd.py` takes the LIFTs of the operator's DIPs at 8%, 10% and 12%, and the MACD as a chart
shows it at the moment of the LIFT (the finished candles plus the fill price as the open one's
close). Same outcome as above: +15%, held 3 sessions, `w15` with a stop 15% under the fill.

| in / out of sample | LIFTs | reach | w8 | w15 | average, stop −15% |
|---|---:|---:|---:|---:|---:|
| LIFT +8%, all | 620 / 739 | 35% / 39% | 22% / 25% | 30% / 33% | −2.3% / −1.7% |
| LIFT +10%, all | 483 / 612 | 40% / 42% | 24% / 27% | 33% / 35% | −2.4% / −1.4% |
| …10m MACD line above zero (89% / 78% of them) | 432 / 478 | 38% / 38% | 24% / 27% | 32% / 33% | −2.1% / −1.5% |
| …10m MACD line at or under zero | 51 / 134 | 57% / 54% | 22% / 27% | 35% / 43% | −4.3% / −0.8% |
| …30m MACD line above zero (68% / 52%) | 324 / 315 | 33% / 35% | 22% / 28% | 29% / 32% | −2.4% / −1.1% |
| …1h MACD line above zero (54% / 35%) | 251 / 214 | 33% / 36% | 24% / 29% | 29% / 33% | −2.0% / −0.6% |
| …1h MACD line at or under zero | 212 / 393 | 46% / 45% | 25% / 25% | 34% / 37% | −3.2% / −1.8% |
| LIFT +12%, all | 392 / 518 | 41% / 45% | 24% / 29% | 33% / 38% | −2.8% / −1.2% |

- **10% instead of 8%** raises the win rate by two or three points and takes a fifth of the signals
  away. The average result doesn't move.
- **The MACD line on the chart's own timeframe is above zero at 78–89% of the LIFTs already**: a
  price 10% over a recent low has pulled the fast average over the slow one. The filter removes few
  and what it keeps wins no more often (32% / 33% against 33% / 35%).
- **On 30m or 1h candles** it removes about half, and the half it keeps wins no more often (29–33%).
  It loses a little less on average, out of sample more than in sample.
- **The LIFTs with the MACD under zero reach +15% more often** (45–57%): they are the names that
  fell hardest and move most, the volatility effect of the study above. Their average is worse in
  sample.
- Adding "and over its signal line" changes nothing: at a LIFT the line is almost always over it.

So neither the 10% nor the MACD filter gets near 50%.

To grade it on the real alerts later: export the `dip` rows from
`tier_events` again as `live.csv` and read the script's last table (every DIP alert is stored with
its price and time; the bars reach 60 days back).
