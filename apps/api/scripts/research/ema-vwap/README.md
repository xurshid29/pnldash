# EMA cross over VWAP — research

The 📐 script's fourth setup (v35, `docs/vwap-setup.md` §18): the EMA 9 of 3m closes crosses above
the session VWAP. Measured on our own data: every Momentum row, 1m bars from the 20s snapshots, the
poller's session VWAP.

## Which crosses are false, and does a filter help? (2026-11-13)

The operator, on PARA (3m chart, 11-12 / 11-13): "is there anyway we can filter/optimize the false
ones?", with a video whose optimized settings (ADX 36, a 60-minute window, a 1.5 ATR stop, a 3R
target) made money on 35 trades and lost on 287.

```bash
cd apps/api/scripts/research/ema-vwap
# rows.csv.gz from ../vwap-pullback/export-rows.sql
python ema_vwap_study.py rows.csv.gz            # 3m candles, EMA 9
python ema_vwap_study.py rows.csv.gz --tf 5
```

`ema_vwap_study.py` replays the v35 rule on 08-14 → 11-13 (17,110 ticker-days, 3,768 crosses on 3m
candles, 58 a day) and splits the days: in sample before 10-09, out of sample from it. A filter
counts only if it helps in both.

- **false** = a candle closes back under the VWAP within 5 candles of the cross.
- **A** = exit when a candle closes under the EMA (the video's exit), in % per trade.
- **B** = a stop a tick under the lower of the cross candle's low and the VWAP, a 2R target, 20
  candles, in R (as the VB studies).

| 3m candles | in sample | | | out of sample | | |
|---|---:|---:|---:|---:|---:|---:|
| | false | A | B | false | A | B |
| all crosses (2,052 / 1,716) | 49% | −0.50% | −0.20R | 47% | −1.31% | −0.22R |
| 04:00–07:00 ET (230 / 124) | 64% | −2.15% | −0.42R | 60% | −2.77% | −0.45R |
| 09:30–11:00 (386 / 300) | 48% | −0.91% | −0.06R | 46% | −1.82% | −0.05R |
| 3+ flips in the 20 candles before (318 / 287) | 54% | −0.63% | −0.23R | 56% | −1.66% | −0.33R |
| ADX ≥ 36, the video's filter (248 / 232) | 48% | −0.92% | −0.30R | 47% | −1.27% | −0.33R |
| volume ≥ 2× its last 20 (590 / 441) | 43% | −1.27% | −0.14R | 49% | −2.08% | −0.27R |
| RSI ≥ 65 (616 / 495) | 34% | −0.09% | −0.17R | 35% | −1.78% | −0.26R |
| **under ≥ 5 candles + at most 2 flips + not before 07:00** (1,253 / 1,053) | **44%** | −0.26% | **−0.16R** | **41%** | −1.08% | **−0.16R** |
| what that rule drops (799 / 663) | 57% | −0.88% | −0.26R | 57% | −1.66% | −0.31R |
| the rule, regular hours only (733 / 678) | 42% | −0.08% | −0.13R | 41% | −0.92% | −0.07R |

- **About half of the crosses are false, and the plain cross loses** by either exit, in both halves.
  No filter makes it profitable.
- **Three things separate the worse crosses steadily, in both halves and on 5m candles too:**
  - the hour: before 07:00 ET is the worst by far, and 09:30–11:00 is about break-even by R;
  - chop: the more EMA / VWAP crossings in the 20 candles before, the more false (none 43%,
    two 53%, five or more 64%);
  - a short stay under the line: fewer than 5 candles under it before the cross is 56–62% false,
    5 or more about 44%.
- **The rule built from those three** keeps 61% of the crosses. The ones it drops are false 57% of
  the time in both halves, against 41–44% for the ones it keeps; B goes from about −0.21R to −0.16R.
  Built as script v36's filter.
- **The video's ADX filter does nothing here**, and neither does the cross candle's volume (it helps
  in sample and not out of it). A high RSI or a 20-candle-high close cut the false rate but not the
  result: fewer quick failures, a worse entry.
- **The video's exit (a close under the EMA) does worse than a stop and a target** on these names: one
  candle can close far under the EMA.
- **5m candles** (2,149 crosses): all crosses −0.14R / −0.12R; the rule 41% / 41% false; 09:30–11:00
  with the rule +0.08R / +0.04R on 157 / 94 trades, too few to lean on.

Limits: bars exist only while a name is on our screen, and each run warms up 15 candles, so a
cross in a name's first 45 minutes on the screen isn't counted (TradingView's EMA carries over from
the day before); our VWAP starts when the name reaches the screen; 1m bars from 20s snapshots; ideal
fills; the session line only.
