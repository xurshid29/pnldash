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

## Is the pullback after the cross a better entry? (2026-11-13)

The operator, looking at v36's marks on PARA: "maybe, pullback or bounce from ema and/or vwap can
help?"

```bash
python ema_pullback_study.py rows.csv.gz                 # 3m candles, an entry within 10 candles
python ema_pullback_study.py rows.csv.gz --wait 20       # also --wait 5, --tf 5, --tol-ema 0.5 --tol-vwap 0.5
```

`ema_pullback_study.py` takes the same crosses and, for each, the first entry within 10 candles
after the cross candle. A candle closing under the VWAP before it ends the wait.

- **cross** = the cross candle's close (what v35 / v36 announce).
- **next** = the first later candle closing green above the EMA, no touch needed (the control: is it
  the pullback that helps, or only the waiting?).
- **ema** = a candle's low comes down to the EMA, then that candle or a later one closes green above
  the EMA. **vwap** = the same against the VWAP (a low within 1% above it). **either** = whichever
  comes first.
- B's stop is a tick under the lowest low from the touch to the entry candle; target 2R, 20 candles.
- **per cross** = the entry's share of the crosses × its average R: what waiting is worth per signal.

| 3m candles, all crosses | in sample | | | | out of sample | | | |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| | share | false | B | per cross | share | false | B | per cross |
| cross | 100% | 49% | −0.20R | −0.19R | 100% | 47% | −0.22R | −0.20R |
| next (no touch) | 56% | 36% | −0.20R | −0.10R | 52% | 34% | −0.11R | −0.05R |
| ema | 40% | 36% | −0.09R | −0.03R | 37% | 35% | −0.07R | −0.02R |
| vwap | 36% | 42% | −0.14R | −0.05R | 36% | 38% | −0.00R | −0.00R |
| **either** | **44%** | **37%** | **−0.10R** | **−0.04R** | **43%** | **35%** | **−0.06R** | **−0.02R** |
| either, strong crosses only | 46% | 34% | −0.10R | −0.04R | 44% | 32% | −0.04R | −0.01R |
| either, weak crosses only | 42% | 42% | −0.09R | −0.03R | 41% | 41% | −0.10R | −0.04R |

- **The bounce is a better entry than the cross, in both halves:** about a third of them fail fast
  instead of half, and the loss per trade is under half. It holds on 5m candles (either: −0.10R /
  −0.08R against −0.14R / −0.12R), with a 5 or a 20 candle wait, and with tighter touches.
- **It is the pullback, not only the waiting:** the control (the next green candle) is no better
  than the cross per trade in sample (−0.20R).
- **Waiting costs little.** The crosses that never give a bounce are mostly the failures: buying the
  cross on those was false 68–71% of the time and −0.54R / −0.56R. That split is hindsight (a close
  under the VWAP is what ends the wait), but it shows the runs that get away are few (7–9% of them
  reach 2R first).
- **Still not an edge on its own.** No version is positive in both halves; 09:30–11:00 on strong
  crosses is positive out of sample only (+0.07R to +0.25R on under 100 trades).
- A bounce after a weak cross fails fast more often (41–42% against 32–34%), so v37 keeps those quiet.
- Nothing in the buckets (how long after the cross, how far price ran first, how far the EMA sits
  above the VWAP) separates the better bounces in both halves.

Built as script v37's BOUNCE (`docs/vwap-setup.md` §18.2).

Limits: bars exist only while a name is on our screen, and each run warms up 15 candles, so a
cross in a name's first 45 minutes on the screen isn't counted (TradingView's EMA carries over from
the day before); our VWAP starts when the name reaches the screen; 1m bars from 20s snapshots; ideal
fills; the session line only.

## Is the cross better with the MACD positive? (2026-11-15)

The operator: "can we measure the EMA Cross setup with MACD, so, for example, 1 or 5 min chart, 9
ema must cross the session vwap and macd line must be above the signal line and zero line and its
histogram must be green, so macd must be positive when ema crosses the vwap".

```bash
python ema_macd_study.py rows.csv.gz --tf 5 --cut 2026-10-09 --yahoo <folder of cached Yahoo 5m JSON>
python ema_macd_study.py rows.csv.gz --tf 1 --cut 2026-10-09          # also --tf 3, --macd-warm 80
```

`ema_macd_study.py` takes the same crosses (08-14 → 11-14, 17,415 ticker-days) on 1m and 5m candles
and reads the MACD (12 / 26 / 9) of those candles at the cross candle's close. **BOTH** is the
operator's rule: the line above zero and above the signal (the histogram green). Our MACD starts
with a name's run on the screen, so it is read only for crosses with 35 candles of run behind them
("warm": 72% of the 1m crosses, 43% of the 5m ones). Same outcomes and the same split as above.

| in / out of sample | crosses | false | A | B |
|---|---:|---:|---:|---:|
| **1m candles**, all warm crosses | 3,895 / 3,338 | 47% / 44% | −1.07% / −1.29% | −0.39R / −0.39R |
| MACD line above zero (79% / 75% of them) | 3,075 / 2,491 | 45% / 42% | −1.08% / −1.39% | −0.39R / −0.40R |
| histogram green (85% / 85%) | 3,322 / 2,834 | 45% / 42% | −1.08% / −1.30% | −0.38R / −0.40R |
| **BOTH** (71% / 67%) | 2,766 / 2,248 | 44% / 41% | −1.08% / −1.38% | −0.38R / −0.40R |
| BOTH and the signal above zero (55% / 51%) | 2,141 / 1,700 | 44% / 41% | −1.05% / −1.35% | −0.35R / −0.40R |
| BOTH and the histogram rising (57% / 52%) | 2,203 / 1,734 | 41% / 40% | −1.08% / −1.45% | −0.35R / −0.39R |
| not both, what the rule drops | 1,129 / 1,090 | 55% / 50% | −1.06% / −1.11% | −0.40R / −0.37R |
| the v36 filter's crosses | 2,515 / 2,198 | 43% / 39% | −1.04% / −1.19% | −0.36R / −0.37R |
| the v36 filter and BOTH | 2,064 / 1,751 | 41% / 38% | −1.08% / −1.28% | −0.38R / −0.38R |
| 09:30–11:00 ET and BOTH | 505 / 413 | 43% / 40% | −0.45% / −1.29% | −0.22R / −0.19R |
| **5m candles**, all warm crosses | 532 / 418 | 47% / 44% | +0.10% / −1.31% | −0.12R / −0.14R |
| MACD line above zero (91% / 82%) | 484 / 341 | 46% / 45% | +0.18% / −1.45% | −0.11R / −0.20R |
| histogram green (83% / 80%) | 444 / 335 | 44% / 44% | +0.41% / −1.32% | −0.12R / −0.17R |
| **BOTH** (78% / 70%) | 415 / 291 | 44% / 43% | +0.51% / −1.42% | −0.10R / −0.21R |
| BOTH and the signal above zero (66% / 57%) | 353 / 239 | 43% / 43% | +0.78% / −1.19% | −0.08R / −0.15R |
| BOTH and the histogram rising (64% / 59%) | 341 / 247 | 43% / 40% | +0.77% / −1.48% | −0.13R / −0.25R |
| not both, what the rule drops | 117 / 127 | 57% / 47% | −1.37% / −1.04% | −0.16R / +0.01R |
| the v36 filter and BOTH | 359 / 239 | 42% / 39% | −0.35% / −1.11% | −0.09R / −0.17R |
| **5m, the chart's MACD** (Yahoo, 198 tickers), all crosses | 277 / 330 | 47% / 45% | −0.62% / −1.64% | −0.20R / −0.00R |
| BOTH by the chart's MACD (66% / 61%) | 183 / 201 | 40% / 43% | −0.44% / −2.11% | −0.08R / −0.02R |
| not both | 94 / 129 | 61% / 49% | −0.96% / −0.90% | −0.43R / +0.03R |

- **The MACD is already positive at about 7 crosses in 10** (66–78% by timeframe and half; 61–66% by
  the chart's own MACD on 5m). The EMA 9 can only cross up through the VWAP after price has been
  rising, which is what lifts the MACD.
- **Those crosses fail fast a little less often:** 3 points fewer false ones on 1m and 3m, 1–3 on
  5m, 2–7 with the chart's MACD. The ones the rule drops are false 50–55% of the time on 1m.
- **They don't pay better.** On 1m the result is the same with or without the rule (−0.38R / −0.40R
  against −0.39R / −0.39R). On 5m it is a little better in sample and worse out of sample (−0.10R /
  −0.21R against −0.12R / −0.14R), and out of sample the dropped crosses did better than the kept
  ones. Fewer quick failures, a later and higher entry: the same trade-off as the RSI ≥ 65 and
  20-candle-high filters above.
- **No stricter version is positive in both halves** (the signal above zero too, the histogram
  rising, with the v36 filter, by the hour). By bucket nothing moves steadily with the size of the
  line or the histogram, apart from the false rate.
- **The timeframe matters more than the MACD:** the plain cross on 1m candles loses −0.38R in both
  halves (154 crosses a day), on 3m about −0.21R (59 a day), on 5m about −0.14R (34 a day).
- **The check against the chart:** for the 198 tickers with cached Yahoo 5m bars (the continuous
  series a TradingView chart has, pre- and after-market included), our run-seeded MACD gives the
  same BOTH verdict on 89% of the warm crosses and 75% of the others, and the chart's MACD tells the
  same story (rows above).

Nothing built. Limits as above, plus: our MACD starts with the run, so the first 35 candles of a
name's time on the screen are left out of the main rows (on 5m that is its first three hours); the
Yahoo check covers the names of one week's RSI / DIP alerts, not every Momentum name, and its last
60 days only; no 1m Yahoo check (Yahoo keeps 1m bars for 30 days).

## The band's crosses: which come from a falling price? (2026-11-16)

Script v40 lets the upper Bollinger Band be the line that crosses the VWAP. The operator, a day
later, with RBNE, GP and CLRO on 1m charts: the band setups "are working very well", "But, I turned
out bb upper row moves away from price if it drops too fast, and crosses up the near vwap". A fast
drop widens the band, and its upper line rises over the VWAP while the price falls away.

```bash
python band_cross_study.py rows.csv.gz --tf 3 --cut 2026-10-09      # also --tf 1, --tf 5
```

`band_cross_study.py` takes v40's band crosses on the same data (08-14 → 11-14): the upper band of
20 one-minute closes × 2 (the operator's is on 45s candles; 1m is the nearest our bars allow),
sampled at each candle's close, against the session VWAP.

- **fell** = a candle closes under the cross candle's low within 5 candles.
- **5 later** = the close 5 candles later against the cross candle's close.
- **B** = a stop a tick under the cross candle's low, a 2R target, 20 candles, in R.

| in / out of sample | crosses | fell | 5 later | B |
|---|---:|---:|---:|---:|
| **3m candles**, all band crosses | 3,102 / 2,461 | 41% / 36% | −0.41% / −0.13% | −0.20R / −0.17R |
| green cross candle (49% / 45%) | 1,508 / 1,118 | 38% / 33% | −0.74% / −0.73% | −0.27R / −0.21R |
| red or flat candle (51% / 55%) | 1,594 / 1,343 | 44% / 39% | −0.10% / +0.36% | −0.05R / −0.07R |
| close above the VWAP (42% / 43%) | 1,311 / 1,058 | 36% / 34% | −0.80% / −0.81% | −0.32R / −0.26R |
| close at or above the band's middle (74% / 73%) | 2,286 / 1,803 | 45% / 40% | −0.64% / −0.49% | −0.28R / −0.24R |
| **close under the band's middle** (26% / 27%) | 816 / 658 | 30% / 26% | +0.22% / +0.84% | +0.21R / +0.26R |
| …and the middle falling (23% / 23%) | 710 / 564 | 28% / 24% | +0.20% / +0.74% | +0.23R / +0.26R |
| the v36 filter's crosses (52% / 49%) | 1,613 / 1,208 | 40% / 36% | −0.37% / −0.08% | −0.18R / −0.19R |
| **1m candles**, close at or above the middle | 2,598 / 2,019 | 50% / 43% | −0.57% / −0.52% | −0.47R / −0.43R |
| 1m, close under the middle (25% / 26%) | 849 / 694 | 28% / 22% | +0.35% / +0.60% | +0.31R / +0.30R |
| **5m candles**, close at or above the middle | 2,088 / 1,616 | 41% / 36% | −0.67% / −0.60% | −0.27R / −0.18R |
| 5m, close under the middle (28% / 28%) | 808 / 637 | 34% / 26% | +0.07% / +0.83% | +0.17R / +0.29R |

- **The close against the band's middle line separates the two kinds.** A quarter of the band's
  crosses have the cross candle closing under the middle: the price fell and the band widened over
  the line. On the rest the price pushed the band up.
- **The drop-made crosses are not the worse ones.** After them the price was higher 5 and 10
  candles later on average, they fell through the candle's low less often, and a stop under that
  low with a 2R target was positive, in both halves and on 1m, 3m and 5m candles. The crosses made
  by a push lost on every measure. By where the close sits in the bands: at the lower band (under
  0.1) +0.51% five candles later and +0.26R on 1,046 crosses; above the upper band −0.94% and
  −0.28R on 1,719.
- Read plainly: on names already on our screen, a fast dip tends to snap back and a pop tends to
  fade. It agrees with the other studies here (a high RSI or a 20-candle-high close made the EMA
  cross a worse entry).
- **What this can't see.** A name's bars start when it reaches our screen, and the band needs 20
  of them. The first push of a move from flat (RBNE's and GP's first candle, the ones the operator
  showed) happens before that, so the "push" rows are pops inside a run already under way.
- The v36 filter does little for the band (−0.18R / −0.19R against −0.20R / −0.17R).

Built as script v41's middle-line test (`docs/vwap-setup.md` §18.5): a band cross whose candle
closed under the middle is drawn gray and sent quietly, as the operator asked, and its message
carries the middle line, so the two kinds can be graded on live rows. Given the table, the quiet
ones may be the ones worth an alert of their own; that is for the live rows to say.

Limits as above, plus: a 1m band in the 45s band's place; the bounce after a dip is measured from
the cross candle's close with ideal fills on thin names; 20 minutes of a run are needed before the
first cross.

## The bounce off the basis line after it turns up (2026-11-25)

The operator, with the band cross's basis line (v46) set to 1 minute / 15 closes and a MACD
12 26 9 under a 1m chart, on three moves of NIVF and one of APUS: "How can I catch such moves? …
candle breaks the bb basis, the bb basis moving up, macd turned green, and price pulls back to bb
basis line and bounces and this bounce is a signal"; then: "The most important part is, bb basis
goes down (usually big drop), and after that, it starts moving up, price crosses it, and bounces
(also, macd turns green)".

    python basis_bounce_study.py rows.csv.gz [--len 15] [--wait 10] [--tol 1.0] [--cut 2026-10-09]

**The rule as measured** (1m bars; basis = SMA 15 of the closes): a close above the basis after a
close at or under it (the break); on a later bar within 10, the low comes within 1% of the basis;
that bar or a later one closes green above the basis with the basis rising and the MACD above
its signal: the BOUNCE, entry at that close. A close under the basis first ends the wait. The
fall = the basis's lowest value in the 30 bars before the signal against its highest in the 45
bars before that low.

**Outcomes:** a bar high +5% / +10% above the entry before a close under the basis; "ride" =
hold until the first close under the basis; 2R = stop a tick under the pullback's low, target
twice the distance, 30 bars.

**Data:** 08-14 → 11-20, 71 trading days of Momentum names, 23,475 BOUNCEs (about 330 a day). In
sample before 10-09 / out of sample from it.

| | a day | reach +5% | reach +10% | ride, average | 2R, average |
|---|---:|---:|---:|---:|---:|
| every BOUNCE | 313 / 353 | 10.8% / 9.1% | 4.4% / 3.4% | −0.64% / −0.77% | −0.09R / −0.13R |
| buying the break itself, same conditions | 319 / 376 | 8.0% / 7.3% | 3.2% / 2.6% | −0.79% / −1.06% | −0.18R / −0.23R |
| BOUNCE without the MACD condition | 344 / 391 | 10.5% / 8.7% | 4.2% / 3.4% | −0.62% / −0.72% | −0.10R / −0.13R |
| BOUNCE without the rising basis | 364 / 408 | 10.1% / 8.5% | 4.0% / 3.1% | −0.63% / −0.77% | −0.11R / −0.14R |
| **by the basis's fall before its low (low within 15 bars):** under 2% | 48 / 69 | 4.9% / 3.2% | 1.6% / 0.8% | −0.64% / −0.49% | −0.19R / −0.16R |
| 2% – 5% | 63 / 67 | 8.3% / 7.5% | 3.3% / 2.3% | −0.63% / −0.84% | −0.13R / −0.19R |
| 5% – 10% | 38 / 32 | 11.5% / 11.1% | 4.3% / 3.4% | −0.59% / −1.18% | −0.02R / −0.12R |
| **10% and over** | 24 / 21 | **18.7% / 20.5%** | **8.7% / 8.7%** | −0.51% / −0.86% | −0.01R / +0.03R |
| fall of 5%+, day change +60% and over | 15 / 10 | 21.9% / 22.3% | 11.0% / 11.1% | −0.30% / −0.94% | −0.03R / +0.01R |

**Read:**

- **The fall is the condition that counts**, as the operator said. The share of BOUNCEs that go
  on to +5% rises with it in both halves, from 3–5% after no fall to 19–21% after a fall of 10%
  or more, and +10% from 1–2% to 9%.
- **The MACD and the rising basis add nothing measurable**: without either the numbers are the
  same. A green close above a 15-bar average nearly implies both.
- **Waiting for the pullback beats buying the break**, a little, in both halves.
- **It is still not an edge.** After a 10% fall four in five BOUNCEs close back under the basis
  before +5%; riding the line loses 0.5–0.9% on average (a fifth of the rides end up); with a
  stop under the pullback's low and a 2R target it is about break-even.
- 09:30–11:00 and the pre-market do better than midday on +5% (14–18% against 6–8%) and no
  better in R; price above or under the VWAP, the signal bar's volume, and how long the price
  sat under the basis make no consistent difference.

**Limits:** 1m bars from ~20-second snapshots, so wicks are understated and touches undercounted
(the chart sees more BOUNCEs than this); names already on the Momentum screen (NIVF at $0.02 and
APUS that day are not in the data); ideal fills at the close; no spread.

**Built the same day as TURN** (script v47, `docs/vwap-setup.md` §21): the fall as its main
input (10% by default), the MACD a switch, about 20 a day on Momentum names.

### The first pullback after a pop (2026-11-26)

The operator's next question, with SVRE, ZNB, APUS and WHLR on 1m charts: "these moves are
initial pop, and their first pullback to bb basis row … how to catch such pullbacks?" The same
break → touch → bounce, with a different thing before it: no fall, but a run. Two measures of the
run between the break and the pullback: `stretch`, the furthest a high got above the basis, and
`pop`, the highest high against the break candle's open. Tables 12–15 of the script.

    python basis_bounce_study.py rows.csv.gz --wait 20

(20 bars: the first pullback after a pop comes later than after a turn.) 24,468 BOUNCEs, in
sample / out of sample:

| the price ran above the basis before the pullback | a day | reach +5% | reach +10% | ride, average | 2R, average |
|---|---:|---:|---:|---:|---:|
| under 2% | 245 / 283 | 8.7% / 6.7% | 3.1% / 2.1% | −0.58% / −0.61% | −0.09R / −0.13R |
| 2% – 5% | 64 / 68 | 15.9% / 14.6% | 7.5% / 6.4% | −0.88% / −1.27% | −0.08R / −0.14R |
| 5% – 10% | 13 / 16 | 22.5% / 22.5% | 11.2% / 10.8% | −1.19% / −1.72% | −0.19R / −0.13R |
| 10% – 20% | 3.0 / 3.4 | 29.4% / 34.0% | 17.6% / 17.9% | −1.00% / −1.69% | −0.05R / −0.11R |
| **from a flat base** (no 5% fall before), ran 5% – 10% | 9 / 11 | 24.5% / 22.9% | 11.1% / 11.3% | −1.30% / −1.57% | −0.17R / −0.15R |
| from a flat base, ran 10% and more | 2.6 / 2.7 | 29.1% / 39.8% | 19.4% / 24.1% | −1.21% / −1.67% | −0.03R / −0.15R |
| from a flat base, ran 5%+, day change +60% and over | 4.1 / 3.9 | 32.5% / 38.5% | 17.2% / 24.6% | −0.77% / −0.43% | −0.13R / −0.01R |

**Read:**

- **The size of the pop counts, as the fall did for TURN**: the further the price ran above the
  basis before coming back, the more often the bounce goes on, in both halves. After a run of
  5%+ about a quarter reach +5% and one in nine +10%; after 10%+ about a third and one in five.
  That is more often than after a 10% fall (one in five and one in eleven).
- **The failures are bigger too.** Riding the basis loses 1–1.7% on average (median −2% to −3%),
  and with a stop under the pullback's low and a 2R target it is −0.03R to −0.19R. More hits,
  larger losses: not an edge either, and a little worse than TURN on risk.
- 09:30–11:00 and names up 60%+ on the day do best on +5% (a third and more); a pullback more
  than 10 bars after the break is stopped less often (a third against a half) and no better in R.
- About 13 a day at a 5% run on Momentum names, about 3 at 10%.

Limits as above; in particular a pop's wicks are where our 1m bars from snapshots are weakest.

**Not built.** It would be TURN's state machine with the run in the fall's place and a longer
wait.

### Chasing the pop itself (2026-11-26, `pop_study.py`)

The operator's follow-up: "but, now, I'm thinking how to catch them up, while the initial pop is
moveing too fast". Measured: buying the pop's first candle, against waiting for its first
pullback, and whether a faster trigger helps.

    python pop_study.py rows.csv.gz [--up 2] [--flat 6]

**Pop** = the first green 1m candle that closes at least 2% above the basis (as it stood a
candle before) off a flat base (the 15 candles before ranged at most 6% of the basis). About 230
a day on Momentum names; 16,307 in 71 days. In sample / out of sample; "reach" = before a close
under the basis; "fails fast" = that close comes within 5 candles.

| buying the pop candle's close | a day | reach +5% | reach +10% | fails fast | ride, average | median further high |
|---|---:|---:|---:|---:|---:|---:|
| all pops | 226 / 234 | 15.5% / 13.6% | 6.1% / 4.8% | 35% / 38% | −1.04% / −1.40% | +0.8% / +0.5% |
| the candle closed 3–5% above the basis | 64 / 70 | 18.0% / 15.6% | 7.7% / 5.7% | 31% / 35% | −1.26% / −1.74% | +1.1% / +0.5% |
| 5–8% above | 12 / 15 | 24.6% / 17.8% | 9.7% / 7.5% | 26% / 31% | −2.22% / −2.60% | +1.2% / +0.2% |
| 8% and over | 3.0 / 3.5 | 40.3% / 32.7% | 21.8% / 17.8% | 23% / 29% | −1.50% / −4.44% | +1.8% / +0.1% |
| volume 3–10× the 20 candles before | 51 / 49 | 18.9% / 15.7% | 7.6% / 5.8% | 27% / 31% | −0.92% / −1.32% | +1.2% / +0.9% |
| day change +60% and over | 26 / 19 | 24.0% / 22.2% | 9.2% / 9.6% | 32% / 37% | −0.50% / −1.24% | +1.6% / +1.4% |

| the same pops, entered at the first pullback's bounce | share with one | reach +5% | reach +10% | ride, average | entry vs the pop close |
|---|---:|---:|---:|---:|---:|
| all pops | 50% / 46% | 12.8% / 11.1% | 4.8% / 4.1% | −0.63% / −0.83% | +0.0% / +0.0% (median) |

| a faster trigger: the first ~20-second snapshot at the level | a day | reach +5% | fails fast | ride, average |
|---|---:|---:|---:|---:|
| at 2% above the basis, every trigger | 377 / 393 | 13.9% / 12.7% | 40% / 42% | −1.13% / −1.42% |
| …of which the minute then closed as a pop (60%) | 226 / 234 | 17.1% / 15.4% | 35% / 37% | −0.79% / −1.18% |
| …of which it did not (40%) | 151 / 159 | 9.2% / 8.7% | 48% / 48% | −1.63% / −1.78% |
| at 5% above the basis, every trigger | 43 / 53 | 27.0% / 20.1% | 25% / 30% | −2.00% / −2.85% |

**Read:**

- **By the time a candle confirms a pop, the typical pop is spent.** The median further high
  before a close back under the basis is under 1%; over a third close back under it within 5
  candles; buying the pop candle's close loses 1.0–1.4% on average. Bigger pop candles go on more
  often (a third to 40% reach another +5% after an 8% candle) and lose more on average.
- **A faster trigger doesn't fix it** at the speed our data can see (~20 seconds): it fires 60%
  more often, the extra triggers are the pops that didn't hold (ride −1.6% to −1.8%), and where
  the minute did hold, its close is a median 0% above the snapshot that triggered.
- **The first pullback costs nothing in price and loses less.** Half the pops give one, a median
  4 candles later, at a median 0% from the pop candle's close; its average is −0.6% / −0.8%
  against −1.0% / −1.4% for the chase. Of the pops that never pull back, about one in ten goes
  +5% (5% of all pops): that is all the chase gains.
- Volume on the pop candle (3×+) and a name up 60%+ on the day cut the fast failures a little;
  neither makes the chase positive.

**Limits:** ~20-second snapshots (a pop's first seconds are invisible here, and so is anything a
hotkey could do inside them); names already on the Momentum screen (a first pop from nowhere is
not in the data); ideal fills at a moment when spreads are widest.

**Not built.** What it supports: a POP alert as a heads-up (open the chart, be ready), and the
first pullback's bounce as the entry.

### POP and BACK as built (script v48, 2026-11-26, `pop_back_study.py`)

The operator's answer to that: "yes, lets do that". Before writing the script section, the rule
it would use was run on the same bars, to choose the POP's threshold and to know how many alerts
a day it sends. The script's section 9 (`docs/vwap-setup.md` §22) is this rule.

    python pop_back_study.py rows.csv.gz [--up 10] [--wait 20] [--tol 1] [--macd 1] [--cap 3]

**Run** = closes above the basis (SMA 15 of 1m closes), from the close that crossed above it to
the first close under it. **POP** = the first candle of a run by which a high has reached `up` %
above the basis; one per run. **BACK** = after the POP candle, a low within 1% above the basis,
then that candle or a later one closing green above the basis with the basis rising and the MACD
(12 26 9) above its signal, within 20 candles of the POP. Stop = a tick under the lowest low
after the run's highest high. In sample / out of sample; "capped" = after 3 a day per ticker.

| the POP's threshold | POPs a day | capped | a BACK follows | BACKs a day | reach +5% | reach +10% | stopped | 2R, average |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5% | 109 / 129 | 66 / 72 | 34% / 32% | 38 / 42 | 20.8% / 23.1% | 10.6% / 10.9% | 33% / 27% | −0.22R / −0.22R |
| 8% | 50 / 57 | 38 / 40 | 31% / 29% | 15 / 17 | 27.0% / 28.1% | 14.0% / 15.6% | 30% / 24% | −0.11R / −0.14R |
| **10%** (built) | 33 / 37 | 28 / 29 | 28% / 27% | 9.5 / 9.8 | 28.7% / 34.9% | 15.5% / 20.4% | 32% / 23% | −0.08R / −0.05R |

At 10%, by what the run did and when the BACK came:

| BACKs at 10% | a day | reach +5% | reach +10% | 2R, average | the stop's distance, median |
|---|---:|---:|---:|---:|---:|
| the run's high got 10–20% above the basis | 8.2 / 8.3 | 29.3% / 34.6% | 14.9% / 18.3% | −0.07R / −0.05R | 3.3% / 3.8% |
| 20% and over | 1.3 / 1.5 | 25.0% / 36.2% | 19.2% / 31.9% | −0.19R / −0.08R | 3.9% / 6.5% |
| 1–3 candles after the POP | 1.4 / 2.1 | 36.8% / 37.5% | 22.8% / 18.8% | +0.05R / −0.07R | 4.1% / 4.7% |
| 4–8 candles after | 5.2 / 4.6 | 27.4% / 32.4% | 13.9% / 19.0% | −0.10R / −0.05R | 3.2% / 3.5% |
| 9 and later | 2.9 / 3.2 | 27.0% / 36.7% | 14.8% / 23.5% | −0.12R / −0.05R | 3.5% / 4.4% |
| 09:30–11:00 New York | 2.5 / 2.2 | 33.7% / 37.7% | 17.3% / 21.7% | −0.08R / +0.02R | 3.9% / 3.4% |
| 16:00–20:00 | 1.4 / 1.6 | 25.9% / 24.5% | 13.8% / 20.4% | −0.19R / −0.17R | 2.9% / 3.9% |

**Read:**

- **10% is the threshold.** At 5% the heads-up fires over a hundred times a day and its BACKs
  lose a fifth of the risk on average; at 10% there are about 35 POPs a day (28 after the cap),
  about 10 BACKs, and the BACKs are near break-even in both halves (−0.05R to −0.08R), with +5%
  reached by 29–35% and +10% by 16–20%. This is the 10–20% row of "The first pullback after a
  pop" again, from a rule that counts the wait from the POP candle.
- **A BACK follows a little over a quarter of the POPs**, a median 7 candles later, at a median
  1–2% under the POP candle's close. Three POPs in four get no BACK: the run ends under the basis
  first, or it never comes back to the basis within 20 candles.
- **Not an edge.** No row is clearly positive in both halves. After hours is the weakest.
- **How far above the basis the BACK closes sorts them by risk.** A BACK that closes under 2%
  above the basis (3.0 / 2.4 a day) has a stop a median 1.9% away and comes to +0.01R / +0.27R;
  one that closes 5% or more above it (2.0 / 2.8 a day: a big bounce candle, or the MACD turning
  green a few candles after the low) reaches +5% more often (41%) but its stop is a median 7.5–8%
  away and it comes to −0.25R / −0.27R. The message carries it (`sma N … (+x%)`), so the live
  rows can be graded by it.
- The touch is remembered until the bounce, so a BACK could come after the run has already made
  a new high: 9 of 684 BACKs. Not worth a rule.
- The MACD condition: with it off and no limit on the wait (`--macd 0 --wait 0`) there are 11.5
  BACKs a day and the extra ones do about the same (the not-green BACKs: +5% for 23% / 27%). It
  costs little and adds little; it is a switch because the operator reads the MACD.

**Limits:** as above; and a name's first 15 candles on our screen have no basis here, so pops in
them are missed: the counts are a floor. The gainer filter is approximated by the day's change
(10% and over), the alert window by 04:00–20:00.

### Which POPs run: the volume surge and the time of day (2026-11-26, tables 3–6)

The operator, with POPs arriving: "the biggest 5-6 POPs happen after the pre-market open …
[04:00–05:00 New York], or very fewer happen around [08:00] … the rvol for that moment should be
very high … the stocks which are almost without volume, suddenly started popping up. I think we
should focus on only such moves". Their examples, both RAYA on 11-25: the POP at 04:27 off a
flat base with almost no volume ("suitable") and the one at 11:10 at the end of a slow climb on
steady volume ("not").

Measured on the POPs of the rule above (10%): `vol` = the script's reading, the largest volume
among the POP candle and the two candles before it ÷ the average of the 20 candles before those
three (a minute's volume here = the day's volume at its last snapshot less the minute before's).
After the POP candle's close and before a close back under the basis: a high +10% / +20% above
that close, and the share back under the basis within 5 candles.

| the POP's volume reading | a day | +10% | +20% | back under within 5 | a BACK follows |
|---|---:|---:|---:|---:|---:|
| under 2× | 3.9 / 5.7 | 33.8% / 24.7% | 15.3% / 13.5% | 24% / 33% | 20% / 22% |
| 2× – 5× | 10.8 / 12.5 | 30.2% / 28.5% | 14.7% / 12.3% | 18% / 20% | 27% / 30% |
| 5× – 10× | 6.7 / 6.8 | 24.2% / 28.0% | 11.9% / 13.7% | 19% / 28% | 33% / 22% |
| 10× – 30× | 6.9 / 6.2 | 27.5% / 21.8% | 15.2% / 10.4% | 23% / 34% | 32% / 30% |
| 30× and over | 2.9 / 3.0 | 29.3% / 28.0% | 11.2% / 18.3% | 29% / 37% | 24% / 27% |
| 5×+ off under $5K a minute before | 2.0 / 3.7 | 27.2% / 22.6% | 13.6% / 13.0% | 32% / 37% | 32% / 26% |

| the time of the POP (New York) | a day | +10% | +20% | +50% | back under within 5 |
|---|---:|---:|---:|---:|---:|
| 04:00–05:00 | 1.3 / 1.3 | 29.4% / 41.0% | 15.7% / 15.4% | 3.9% / 7.7% | 31% / 21% |
| 05:00–07:00 | 2.8 / 2.8 | 18.6% / 19.5% | 8.0% / 9.2% | 2.7% / 1.1% | 23% / 41% |
| 07:00–08:00 | 2.5 / 2.5 | 19.0% / 30.3% | 5.0% / 13.2% | 0.0% / 1.3% | 32% / 24% |
| 08:00–09:30 | 3.5 / 4.0 | 30.9% / 19.2% | 12.2% / 10.4% | 3.6% / 2.4% | 22% / 38% |
| 09:30–10:30 | 6.6 / 6.4 | 35.5% / 33.7% | 18.9% / 17.1% | 4.9% / 6.0% | 22% / 28% |
| 10:30–16:00 | 11.3 / 14.1 | 30.4% / 27.8% | 16.2% / 15.1% | 4.4% / 2.8% | 18% / 25% |
| 16:00–20:00 | 5.4 / 5.8 | 29.2% / 20.4% | 13.0% / 8.3% | 2.3% / 2.8% | 21% / 25% |

**Read:**

- **In this data the volume surge does not sort the POPs.** Whatever the reading, 22–34% of
  POPs go on to a high +10% above the POP's close and 10–18% to +20%; the loudest ones (30× and
  over) are back under the basis within 5 candles a little more often. The BACKs after them are
  no different either (table 6). A quiet stretch before (under $5K a minute) changes nothing.
  About 30% of these POPs read 10× or more (9–10 a day).
- **Time of day:** the first hour after the open (09:30–10:30) is the best in both halves;
  04:00–05:00 is as good or better on few events (about 1.3 a day here); 05:00–07:00 is the
  worst. Nothing here sets 08:00 apart.
- **What this data cannot see is the case the operator means.** A stock that is flat on no
  volume is not on the Momentum screen, so its first pop is not in these rows: a name needs 15
  candles on our screen for a basis and 20 for a volume average. RAYA at 04:27 is exactly that
  kind. Every POP in these tables is on a name that was already moving. So the tables say the
  surge does not help *among names already on the screen*; they say nothing about pops out of
  nowhere.
- RAYA's "not suitable" POP (11:10) reads 6.2× on TradingView's own bars (5.0× if only the POP
  candle is taken against the 20 before it), which is why the script's minimum is 10× and not 5×.
- **Why three candles.** The first version read the POP candle alone against the 20 candles
  before it. A pop that takes two or three candles to reach the mark then waters its own average
  down: 50 times the base on each of three candles reads 8.5×. The biggest of three candles
  against the 20 before them reads that 50× and still reads a slow climb low (the same on each
  of five candles reads 8.5× again: three candles is how sudden "sudden" has to be).

### How to buy a POP: at the alert's price, or with a buy stop above it? (2026-11-28, `pop_entry_study.py`)

The operator after the first live morning (four paper trades bought at the alert through the TWS
bridge, one winner): "TRUG, TGHL POPs couldn't move, dropped almost at the price where POP fired …
Maybe, we should place them with offset, for example, 3% (or bigger percentage) from the alert
price? Because, if price's intention is going up, we will catch it, if not, we just don't buy it";
then "maybe, +3% is too risky? Maybe, we do 5%?"; then the automation they want: only the POPs
that alert, 04:00–05:00 New York, a buy stop +5%, take-profit +20%, stop −10%, 5 × $400 a day.

    python pop_entry_study.py rows.csv.gz [--valid 5]

Rows re-exported 08-14 → 11-27 (76 days, 40 in sample / 36 out). The POP of v49; the buy stop is
good for 5 candles; a bracket from the entry, whichever side a later candle reaches first (both
in one candle = the stop; the stop taken to fill at its level). **No costs taken off.** Result
per filled trade, in sample / out of sample:

| POPs that alert (volume 10×+) | fills on | +10% / −5%: TP first | average | +20% / −10%: TP first | average |
|---|---:|---:|---:|---:|---:|
| bought at the alert's price | 100% | 27.7% / 23.2% | −0.75% / −1.21% | 19.2% / 15.8% | −2.23% / −3.24% |
| buy stop +1% | 50% / 42% | 30.9% / 32.1% | −0.24% / +0.17% | 23.2% / 20.0% | −0.93% / −2.04% |
| buy stop +2% | 44% / 37% | 34.7% / 32.8% | +0.34% / +0.28% | 26.5% / 23.2% | −0.48% / −1.20% |
| buy stop +3% | 39% / 33% | 37.9% / 36.4% | +0.85% / +0.53% | 29.4% / 24.5% | +0.28% / −0.78% |
| buy stop +5% | 29% / 26% | 33.9% / 38.4% | +0.17% / +0.79% | 29.6% / 33.7% | +0.37% / +1.36% |
| buy stop +8% | 18% / 18% | 41.4% / 40.7% | +1.32% / +1.10% | 30.0% / 32.2% | −0.15% / +0.88% |

Every POP (strong or not) reads the same way a little lower (bought at the alert −0.67% / −1.37%
with +10 / −5; buy stop +3% +0.38% / 0.00%; +5% +0.17% / +0.21%).

The automation's rule played day by day (POPs that alert, buy stop +5%, +20% / −10%, 5 positions
of $400, one per ticker), in dollars:

| | trades | a day | TP first | per trade before costs | after 1% a side | whole period after costs |
|---|---:|---:|---:|---:|---:|---:|
| 04:00–05:00 only (the rule as specified) | 3 / 0 | 0.1 / 0 | 2 of 3 | +$40 / — | +$32 / — | +$96 / — |
| the whole day | 105 / 80 | 2.6 / 2.2 | 28% / 32% | −$0.63 / +$4.33 | −$8.63 / −$3.67 | −$906 / −$294 |
| the whole day, bought at the alert's price | 187 / 160 | 4.7 / 4.4 | 19% / 16% | −$10.21 / −$14.38 | −$18.21 / −$22.38 | −$3,406 / −$3,581 |
| the whole day, buy stop +5%, +10% / −5% | 105 / 80 | 2.6 / 2.2 | 33% / 39% | +$0.38 / +$3.39 | −$7.62 / −$4.61 | −$800 / −$369 |

**Read:**

- **The operator's idea does what they said it would.** A buy stop above the alert fills on a
  quarter to a half of the POPs and leaves out most of the ones that go nowhere: the average per
  trade moves from clearly negative (−0.7% to −3.2%) to about zero or a little above it, in both
  halves. Half of the POPs that fill do so on the very next candle.
- **3% or 5%: no clear winner.** With +10 / −5 they are about the same; with +20 / −10, +5% is the
  better of the two in both halves. 5% fills less often (26–29% of POPs against 33–39%).
- **It is about break-even before costs, and costs are larger than that.** The best rows are
  +0.2% to +1.4% a trade; IBKR's commission on a $400 trade in a sub-$1 stock is near its cap
  (0.5–1% of the trade value a side). After 1% a side the automation's rule loses $4–9 a trade.
  Above about $1 a share the commission is a fraction of that, so the price of the stock matters
  to the result as much as the entry does.
- **More than half of the filled trades stop out in every row** (the median result is the stop).
  +20 / −10 needs one winner in three and gets 29–34%; +10 / −5 needs the same and gets 34–41%.
- **The automation's own hour cannot be judged here.** 04:00–05:00 has 3 qualifying trades in 76
  days of our bars: a name needs 23 candles on our screen for a volume reading, and at that hour
  the pops come from stocks that are not on it yet. The paper run is the measurement; the
  benchmark from the whole day is 28–32% take-profits first, where +20 / −10 needs 37–40% after
  costs.

**The breakout indicator's signal as the entry (tables 12–13, 11-28).** The operator's next
idea, with the public "Significant Breakout Levels (FVG)" indicator on the chart: "entering not
when 5% from our POP candle, but when we get a buy signal (green box) from this indicator right
next to our yellow POP", and then, having watched it in replay ("the BUY signal is moving down
while price is dropping"): "maybe our 5% from POP is better, or wait for the candle with the BUY
signal and enter on its close (if it's a red candle), or … enter with 5% from its close". The
indicator's bullish rule is replicated in the script from its code: a pivot high (10 candles
each side, no older than 50), a green candle that opens under it and closes above it with a body
over half the ATR(14), and the next candle's low above the high of the candle before the break.
The signal is final at that next candle's close; until then the box follows the forming candle's
low, which is what moves in replay. +20% / −10%, every POP, in sample / out of sample:

| | trades | take-profit first | average per trade |
|---|---:|---:|---:|
| POPs with the signal within two candles | 190 / 156 (14% / 12% of POPs) | | |
| …bought at the alert's price | 190 / 156 | 21.6% / 25.6% | −1.83% / −0.29% |
| …bought at the signal candle's close | 190 / 156 | 19.5% / 22.4% | −2.26% / −0.87% |
| …that candle red, bought at its close | 52 / 53 | 21.2% / 18.9% | −1.43% / −1.68% |
| …that candle red, buy stop +5% above its close | 13 / 13 | 4 / 3 of them | −0.21% / +0.62% |
| …buy stop +5% above the alert, placed once the signal is known | 46 / 38 | 37.0% / 26.3% | +1.15% / −0.16% |
| POPs without the signal: buy stop +5% above the alert | 345 / 285 | 26.7% / 24.9% | −0.50% / −1.69% |

- **Buying the signal candle's close loses, red or green**, about as much as buying the alert.
- **The signal does not reliably improve the waiting buy.** Placed after the signal it is +1.15%
  in one half and −0.16% in the other on 46 and 38 trades; a row that looks better (+1.6% / +2.0%)
  uses the signal before it is known and is not a rule that can be traded.
- **It is rare**: one POP in seven or eight has it, about one trade a day over all POPs and one
  every two or three days on the POPs that alert (18 / 12 trades in 76 days).
- A red signal candle with a buy stop above it has 13 trades in each half: no answer.

So the entry stays the buy stop above the alert's price. Not measured: the indicator's levels as
a place for the stop.

**By the stock's relative volume (tables 14–15, 11-28).** The operator: "we need to test
win-rates with the stocks which have high rvol". The rows were exported again with the stock's
own figures (`avg_volume`, `rel_volume`, `rel_vol_5min`, `rel_vol_1min`, `float_m`), and each POP
takes the reading of its candle: day RVol (today's volume so far ÷ the average day), Finviz's
relative volume, and the dashboard's RVol 5m and RVol 1m (in %, the highest inside the candle).
Four groups of equal size; buy stop +5%, +20% / −10%; take-profit first and the average per
trade, in sample / out of sample:

| every POP, by RVol 5m | trades | take-profit first | average |
|---|---:|---:|---:|
| under 2,417% | 74 / 73 | 18.9% / 20.5% | −3.16% / −2.40% |
| 2,417% – 7,282% | 106 / 78 | 23.6% / 21.8% | −1.34% / −2.19% |
| 7,282% – 25,437% | 108 / 100 | 32.4% / 29.0% | +1.34% / −0.66% |
| 25,437% and over | 110 / 78 | 33.6% / 32.1% | +0.90% / +0.08% |

| the POPs that alert (volume 10×+), by RVol 1m | trades | take-profit first | average |
|---|---:|---:|---:|
| under 4,503% | 20 / 20 | 10.0% / 35.0% | −5.12% / +2.43% |
| 4,503% – 11,745% | 27 / 24 | 22.2% / 12.5% | −1.67% / −4.39% |
| 11,745% – 37,491% | 25 / 24 | 36.0% / 37.5% | +2.53% / +2.22% |
| 37,491% and over | 42 / 18 | 38.1% / 55.6% | +2.53% / +6.67% |
| **the upper two together (11,745% and over)** | 67 / 42 | 37% / 45% | +2.5% / +4.1% |
| the lower two together | 47 / 44 | 17% / 23% | −3.1% / −1.3% |

- **The stock's RVol does sort the POPs, where the POP candle's own volume reading did not.** By
  RVol 5m and RVol 1m the take-profit rate climbs from about 20% in the lowest group to 32–34% in
  the highest, in both halves; RVol 5m of the yellow POPs reads the same way (top group 39.5% /
  50.0%). Day RVol and Finviz's figure climb in one half and not in the other. Float sorts nothing.
- **Yellow POPs on a stock whose RVol 1m is about 12,000% or more are the first group here that
  is positive in both halves** with the buy stop: 37% / 45% take-profits first, +2.5% / +4.1% a
  trade before costs, on 67 and 42 trades (about 1.4 a day). The same POPs under that RVol lose.
- **Caution:** these are small groups cut several ways, the cut points come from the same data,
  and the out-of-sample top cell is 18 trades. It is the best lead so far, not a result.
- The dashboard's RVol exists only for names on the Momentum screen (it is the poller's, from
  Finviz volume). For it to be a condition on a POP out of a stock not yet on the screen, the
  script would have to carry its own (as `rvol.pine` computes it) in the POP message.

**Limits:** as above (1m bars from ~20-second snapshots, names already on the screen); a stop
fills at its level here, which a fast drop in thin pre-market trading will not give; the order
of events inside a candle is unknown (taken against the trade); the indicator is replicated
from its source, and its pivot rule on equal highs may differ a little from TradingView's.

**Built as script v49** (`docs/vwap-setup.md` §22.8): a POP under 10× is weak (gray, stored, not
announced) and so is its BACK; every POP and BACK carries the reading. TradingView sees every
candle of every watchlist name, so the stored rows will hold the pops this data lacks, and can
be graded by `vol_x` and by the hour. A proper measurement needs 1m bars with pre-market volume
for names before they reach the screen (IBKR's history through TWS would do).
