# BB-upper breakout — research (operator, 2026-10-18)

The operator's third setup, from five charts of the 10-15/10-16 session (NWGL,
HODO, XLAB, SGRX, XXII). The chart is 1m, with a Bollinger Band (20, SMA, 2.0)
computed on **30s** bars. They chose 30s because the 1m band "crosses the 1m chart
too often".
- **Signal:** a 1m candle closes above the upper band, and the close before it
  didn't.
- **Trigger:** the next candle takes out the signal candle's high.
- **Entry:** a buy stop one tick over that high.
- **Stop:** the signal candle's low.

`study.py` replays this on every ticker-day that reached +20% on our screen,
09-21 → 10-16: 20 sessions, 1,263 ticker-days, 583 tickers. Bars are Yahoo 1m
with pre- and post-market prices. Our 20s Momentum rows add the grade and the
session VWAP.

```bash
cd apps/api/scripts/research/bb-breakout
# universe + snapshots (run outside 07:00–11:00 ET; the snapshot export is ~40 s, ~17 MB)
PSQL='cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash -q'
ssh root@<droplet> "$PSQL" < export-days.sql > /tmp/bb/days.csv
ssh root@<droplet> "$PSQL | gzip -1" < export-snaps.sql > /tmp/bb/snaps.csv.gz
python3 study.py /tmp/bb/days.csv /tmp/bb/snaps.csv.gz            # report (~8 min the first time: Yahoo download)
python3 study.py /tmp/bb/days.csv /tmp/bb/snaps.csv.gz examples   # the operator's 8 windows, signal by signal
```

**Limits:**
- **No 30s data exists on our side.** The 30s band is approximated by a 1m band
  of length 10, which covers the same 10 minutes. The 1m band of length 20 is
  measured next to it.
- Fills are ideal: a buy stop one tick over the high, and a stop filled at its
  price.
- Yahoo has no pre- or post-market volume, so the volume split covers regular
  hours only.
- The whole sample is 20 sessions.

## Results — 2026-10-18

**The operator's 8 windows:** the replica triggers in 6 of them. Their 17
entries reached +10% before the stop 15 times. The best move in an hour ranged
from +11% to +146%. The other three windows had a close above the band but no
next-candle break: NWGL 02:18 and 02:47, and SGRX 21:40 (Tashkent).

**Every +20% name:**

| | trades/day | +10% before stop | median best move, 60 min | P&L, exit on the first close back under the band |
|---|---:|---:|---:|---:|
| 1m BB(20) | 389 | 18% | 4.6% | −0.19% |
| 1m BB(10), ≈ the 30s band | 442 | 18% | 4.4% | +0.03% |
| …on Momentum | 218 | 20% | 5.3% | +0.07% |

The baseline, any minute of these days: +10% before −5% 15% of the time.

- **The raw rule is break-even and far too frequent to alert on**: ~440 trades
  a day across ~63 names.
- **MACD adds nothing.** A proxy for the operator's 30s MACD (4/26/10 → 1m
  2/13/5) had its histogram positive and rising on 99.7% of breakouts. A close
  above the upper band already is the momentum MACD would confirm.
- **What separates trades is how hot the name already is.** The cut-offs:
  - grade A+;
  - 10–50% above the session VWAP;
  - day gain ≥100%;
  - a run of ≥20% in the last 30 min;
  - a big signal candle;
  - bar volume ≥8× the last 20 bars (regular hours).

  Each of these makes the move bigger in *both* directions: the stop is farther
  away and the best move is larger. A first break after ≥60 quiet bars is the
  weakest kind, not the best.
- **Time of day:** 07:00–10:30 ET is the best window (+0.52%, +0.15%).
  04:00–07:00 ET is the worst (−0.37%).
- **Waiting for the trigger:** buying every signal close averaged −0.23%. The
  signals that never triggered lose −1.15% that way. The trigger avoids them, at
  the cost of a ~0.9-point higher entry on the ones that work. Net: +0.03% vs
  −0.23%.
- **The quickest exit is the best one.** Mean P&L by exit rule:

  | exit | mean P&L |
  |---|---:|
  | first close back under the upper band | +0.03% |
  | close under the basis | −0.53% |
  | close under the previous bar's low | −0.37% |
  | 15 minutes | −0.32% |
  | +10% target | −0.26% |

  The moves are fast, and giving them room loses money.

**A gate for announcing — the candidate:** on Momentum, and either grade A+ or
10–50% above the session VWAP.

| | trades/day | mean (band exit) | median | without the top 1% | 1st / 2nd half |
|---|---:|---:|---:|---:|---|
| gated | 37 | +0.77% | −0.57% | −0.30% | +1.00% / +0.56% |
| everything else | 405 | −0.04% | −0.30% | −0.38% | −0.11% / +0.04% |

- **It pays through a few big runners.** 43% of the gated trades are positive.
  The median breakout stall stops out and the occasional +50% run pays for it.
- **Slippage of 0.5% each way takes it to −0.23%.** On sub-$1 names that is a
  normal spread, so this is a heads-up for the operator's discretion, not a
  mechanical edge. That's the same verdict as the PULLBACK.

## How it would be built (proposed, not built)

- **In the 📐 Pine script (v17), on the 30s alert.** TradingView Premium allows 2
  watchlist alerts and both run this script, so a separate script would need a
  third alert.
  - The 30s chart has the exact 30s band natively.
  - The 1m candle is assembled from the two 30s bars of each minute.
  - The next-candle break is seen within ≤30 s of happening. The 1m alert only
    learns of it at the next bar close.
- **Messages:**
  - `BREAKOUT` at the signal candle's close, carrying the trigger (high + tick),
    the stop (its low), the band, vs sVWAP, run, volume and day high. This is
    the actionable one: place the buy stop.
  - `TRIGGERED` when the next candle takes the high.
  - Optional: `FADED` on the first close back under the band. That's the best
    exit measured, so it's worth a quiet message, like BROKEN.
- **Server:** parse the messages, store every one for grading, and announce only
  through the gate above (knobs in `TV_SETUP`). Show them in the sidebar and the
  History tab. Telegram slug `tv_breakout`.
- **Procedure (`docs/vwap-setup.md` §10):**
  - mirror the logic in `pinesim.py`;
  - extend `verify-tv-setups.ts`;
  - the operator pastes v17 and recreates both alerts;
  - grade live after ~2 weeks with `grade_live.py`, which uses TradingView's
    own 30s band and pre-market volume.
