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
