# VWAP + BB cross — research

The 📐 script's fourth setup, the VWAP + BB cross (v21–v24, `docs/vwap-setup.md`
§16), measured on our own data. Only the session line can be replayed here: our
rows carry the poller's session VWAP; the month and year lines can't be rebuilt.

## The break of the VB candle's high (2026-10-22)

The operator: "the latest VB candle's high should become a resistance line and I
want to be notified when price crosses over that resistance line (or a little
bit earlier)", using the VB timeframe settings (TANH and SHFS on 10m charts,
10-22). Measured before building it.

```bash
cd apps/api/scripts/research/vwap-bb-cross
# rows.csv.gz from ../vwap-pullback/export-rows.sql (run outside 07:00–11:00 ET)
python vb_break_study.py rows.csv.gz                # 5m and 10m candles, 2m band, +10% target
python vb_break_study.py rows.csv.gz --cancel       # a close under the session VWAP cancels the level
python vb_break_study.py rows.csv.gz --target 5
```

`vb_break_study.py` replays the v23 rule on 1m bars built from the 20s snapshots,
for gainers (≥ 20% today so far, or on one of the 5 days before). The level is
the VB candle's high when it closes; its low is the stop. A newer VB candle
replaces the level. The exits are the target, the stop, 60 minutes, or the
ticker leaving our screen. The data covers 06-12 → 10-20: 21,816 ticker-days.

| | trades | +10% before the stop | avg per trade | made money |
|---|---:|---:|---:|---:|
| 5m candles: buy the CROSS (stop: the candle's low so far) | 6,615 | 15.9% | −1.61% | 22.5% |
| 5m: **buy stop over the VB candle's high** (stop its low) | 4,265 | 23.9% | **−1.00%** | 34.8% |
| 5m: buy the first close above the high | 3,962 | 22.3% | −1.67% | 33.2% |
| 10m candles: buy the CROSS | 6,549 | 18.0% | −1.69% | 25.9% |
| 10m: **buy stop over the VB candle's high** | 3,876 | 25.8% | **−0.98%** | 38.4% |
| 10m: buy the first close above the high | 3,639 | 23.9% | −1.76% | 35.9% |

- **The break beats the CROSS** by 0.6–0.7 points a trade, and lifts the win rate
  from 16–18% to 24–26%. With a +5% target the win rate goes from 27–30% to
  38–41%, and the break is still about 0.55 points better. It also filters: 35–40%
  of VB candles never get their high taken out.
- **It is still a heads-up, not an edge.** The average trade is about −1% in
  every month and every time window.
- **How you enter matters more than the alert.** A buy stop placed at the high
  beats buying after a close above it by about 0.7 points. The level is known
  when the VB candle closes, and the break comes a median 3–4 minutes later (59%
  on 5m, 64% on 10m in the very next candle). So the useful "earlier" is showing
  the level at the candle's close.
- **Time of day** (buy stop, 10m): 09:30–12:00 is the best (32% win, −0.68%);
  12:00–16:00 has the lowest win rate (15%); 04:00–07:00 has the worst average
  (−1.76%).
- **Cancelling the level on a close under the session VWAP** removes a third of
  the trades and leaves the rest about the same (5m −1.00% → −0.94%, 10m −0.98% →
  −1.04%), so it costs nothing as a noise cut. With it, the breaks that remain
  come fast: 79–85% in the next candle.

Limits: 1m bars from 20s snapshots instead of the alert's 30s bars; the session
line only; a name's first ~40 minutes on our screen have no band yet; fills are
ideal (a buy stop at the level, or the bar's open if it gapped over).

## Which candle timeframe (2026-10-22)

The operator: "what chart timeframe is best for it?" Bigger candles have wider
stops, so here the exits scale with the trade: a target of 2× the risk (entry
minus the VB candle's low), a horizon of 6 candles, and a level cancelled on a
close under the session VWAP. The results are in R, the risk unit
(`--rr 2 --hcandles 6 --cancel`). Buy stop over the VB candle's high:

| candles | band 1m | band 2m | band 5m | signals (2m band, 06-12 → 10-20) | median stop distance |
|---|---:|---:|---:|---:|---:|
| 3m | −0.12R | −0.15R | −0.12R | 3,078 | 4.6% |
| 5m | −0.12R | −0.10R | −0.11R | 2,841 | 5.8% |
| 10m | −0.09R | −0.09R | −0.09R | 2,461 | 7.6% |
| 15m | −0.09R | −0.07R | −0.05R | 2,160 | 8.4% |
| 30m | −0.04R | −0.02R | −0.03R | 1,751 | 10.1% |
| buying the CROSS instead (any) | | −0.24R to −0.37R | | | |

- **No timeframe makes it an edge.** Every one is slightly negative, and the
  break beats buying the CROSS by about 0.2–0.25R everywhere.
- **Bigger candles get closer to break-even, but fire less and need wider
  stops.** 30m is about 60% of 5m's signals, with a 10% stop and a 3-hour
  horizon. 3m is the weakest, which fits the operator's sense that the fastest
  charts are noise.
- **The band's timeframe barely matters** (1m, 2m and 5m are within ~0.03R). A
  5m band halves the number of signals.

## The cancel on a candle's close (2026-10-23, script v26)

The operator, on XXII 10-23 (10m): the VB candle's high "acts like a resistance", and
the break of it one candle later gave no alert. v25 had cancelled the level on a 30s
close under the session VWAP, a wick on the 10m chart. `--cancel-candle` cancels only
when a candle of the timeframe (the VB candle included) closes under the session VWAP:

```bash
python vb_break_study.py rows.csv.gz --candle 5 10 15 --rr 2 --hcandles 6                   # never cancel
python vb_break_study.py rows.csv.gz --candle 5 10 15 --rr 2 --hcandles 6 --cancel          # any 1m close (≈ v25)
python vb_break_study.py rows.csv.gz --candle 5 10 15 --rr 2 --hcandles 6 --cancel-candle   # a candle's close (v26)
```

| Cancel when… | 5m | 10m | 15m |
|---|---|---|---|
| any 1m close is under the VWAP (≈ v25) | 2,841 · −0.10R | 2,461 · −0.09R | 2,160 · −0.07R |
| **a candle closes under it, the VB candle included (v26)** | 3,098 · −0.11R | **2,755 · −0.08R** | 2,490 · −0.06R |
| a later candle closes under it (not the VB candle) | 3,319 · −0.11R | 3,099 · −0.10R | 2,878 · −0.07R |
| never | 4,265 · −0.13R | 3,876 · −0.11R | 3,551 · −0.08R |

The cancel rule changes how many breaks there are, not what one is worth. Breaks that
come after the next candle (the XXII kind) were −0.02R on 10m under v26, against
−0.08R with the 1m-close cancel. Built as script v26 (`docs/vwap-setup.md` §16.8).

## The retest after the VB candle (2026-10-28/29)

The operator, on AIOK 10-28 (5m chart for the VB, 30s chart for the entry): "I'm not using BREAKs for
enter (because they can be very extended by the moment entering), but waiting 1st 5min candle closes with
VB and pulls back to vwap line and bounces, I'm entering right at that moment". `vb_retest_study.py`
replays it on 06-12 → 10-28 (23,461 ticker-days): after the VB candle closes, a bar whose low comes within
`--touch` % of the session VWAP, then the first bar that closes above the VWAP and above its open — bought
at that close, stop under the pullback's low (or 1% under the line). Same VB candles, same cancel (a candle
closing under the VWAP, v26), 2R target, 6-candle horizon, `--tol 0` (the operator's setting), 1m band
(the nearest to their 45s).

```bash
python vb_retest_study.py rows.csv.gz --candle 5 10 --bb 1 --tol 0
python vb_retest_study.py rows.csv.gz --candle 5 --list AIOK 2026-10-28
```

| 5m candles, 1m band | trades | 2R before the stop | stopped | avg per trade | avg R | median risk |
|---|---:|---:|---:|---:|---:|---:|
| buy the CROSS | 6,539 | 14.8% | 59% | −1.87% | −0.33R | 4.6% |
| buy stop over the VB high (BREAK) | 2,868 | 13.8% | 40% | −1.26% | −0.14R | 7.2% |
| **RETEST** (within 1%, ≤ 6 candles, stop the pullback low) | 2,718 | 22.1% | 63% | **−0.92%** | −0.30R | 2.2% |

- **The retest is the cheapest entry per trade** (−0.9% against −1.3% for the break and −1.9% for the
  CROSS), because its stop sits ~2% under the entry instead of ~7%. It reaches 2R before the stop about
  twice as often as the break (22% vs 14%), but it is stopped more often (63%), so **per unit of risk the
  break is still better** (−0.14R vs −0.30R). With the same shares per trade the retest loses least; with the
  same dollars at risk per trade the break does. Still a heads-up, not an edge, like every entry measured.
- **It comes fast:** 42% of VB candles get a retest within 6 candles, a median 3 minutes after the candle
  closes.
- **The variants hardly differ:** a touch to the line, or within 0.5 / 1 / 2% of it; the stop under the
  pullback low or 1% under the line; a 6-candle limit or none — all within ~0.15 points and ~0.05R.
- **10m candles:** retest −0.91% (−0.25R), break −1.11% (−0.09R), CROSS −2.03% (−0.31R).
- **By time of day** (5m, retest): 09:30–12:00 is the best (−0.79%, −0.20R); before 09:30 it is stopped
  67–70% of the time (−0.38 to −0.42R).
- **By grade** (October only, when grades were first stored): on A-grade Momentum names the retest did
  −0.80% (−0.17R, 2R first 28%, n 251), on B grades −1.05% (−0.25R).
- **Which VWAP:** our VWAP comes from 20-second snapshots, so it is closest to the VWAP TradingView builds from
  30s bars. On TradingView the 5m-candle VWAP sat a median 0.4% from the 30s chart's (90% within 0.9%) and
  the 10m one 1.6% (90% within 4.9%), from paired alert messages since 10-23.

Limits: 1m bars from 20s snapshots (quick wicks to the line can be missed, and the alert uses 30s bars);
our VWAP starts when a name reaches our screen (AIOK 10-28: ~$17.20 against TradingView's $17.02, which
shifted its VB candles by one and cancelled the 22:40 one); the session line only; ideal fills.

### At the candle's close (2026-10-30, script v30)

The operator (CLPT 10-29): "RT should not be fired if its candle's close is under the vwap".
`vb_retest_study.py` now also enters at the close of the first candle after the VB candle that came
within 1% of the line and closed above it (`cc_close`; `cc_green` also needs a green candle). The R
average also excludes stops under 0.5% away: a candle closing just above its low leaves a stop a
hair under the entry, and one gap through it counts as dozens of R.

| | 5m: trades | avg | R (stops ≥ 0.5%) | stopped | 10m: avg | R |
|---|---:|---:|---:|---:|---:|---:|
| first green 1m close above the line (v28) | 2,718 | −0.92% | −0.31R | 63% | −0.91% | −0.25R |
| **at the candle's close, closed above (v30)** | 2,297 | **−0.84%** | **−0.26R** | 57% | **−0.83%** | **−0.18R** |
| at the candle's close, green | 1,522 | −1.44% | −0.26R | 53% | −1.21% | −0.18R |
