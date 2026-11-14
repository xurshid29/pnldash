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

Nothing was built from this. To grade it on the real alerts later: export the `dip` rows from
`tier_events` again as `live.csv` and read the script's last table (every DIP alert is stored with
its price and time; the bars reach 60 days back).
