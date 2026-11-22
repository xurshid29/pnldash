# VWAP pullback — research

Measures the PULLBACK setup (📐 script v10, `docs/vwap-setup.md` §13) on our own
data before trusting it: a fast run stretches price well above VWAP, it comes
back to within ~5% of the line (the alert), and the setup is broken by a close
under the line (the operator's exit).

**Only the session line can be measured here.** Every screener row since
2026-06-12 stores the poller's session VWAP (`screener_results.vwap`), within
~1% of TradingView's line for names on our screen from the start of their move
(SDEV 9.12 vs 9.05, SAIQ 9.78 vs 9.85 on 2026-10-05). The month line can't be
rebuilt: we only see a ticker while it is up 20%+, and the month line includes
all the volume we never saw. Against TradingView's own month VWAP (every 📐
signal carries it), a rebuild from our rows landed within 3% for half the names
and 6–37% off for the rest. That version is graded live from TradingView's
signals.

`study.py` runs the Pine script's own state machine (`PullbackLine` from
`../vwap-setup/pinesim.py`) on 1m bars built from the 20s snapshots, so its
numbers describe what the script does.

## Run

Export outside 07:00–11:00 ET (a 38 s scan, ~87 MB gzipped for 06-12 → 10-05):

```bash
cd apps/api/scripts/research/vwap-pullback
ssh root@<droplet> 'cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash -q | gzip -1' < export-rows.sql > /tmp/pb/rows.csv.gz
python3 -m venv /tmp/pb/venv && /tmp/pb/venv/bin/pip install duckdb
/tmp/pb/venv/bin/python study.py /tmp/pb/rows.csv.gz --grid          # ~1 min
/tmp/pb/venv/bin/python study.py /tmp/pb/rows.csv.gz --list SAIQ     # every setup for one ticker
/tmp/pb/venv/bin/python study.py /tmp/pb/rows.csv.gz --cap 2 --cap-compare   # what the daily cap counts: touches / failures (v15) / broken
/tmp/pb/venv/bin/python study.py /tmp/pb/rows.csv.gz --cap-strong            # the touches the cap blocks, by change % and grade
```

`--arm` / `--near` / `--brk` change the script inputs (defaults 15 / 5 / 0).

## Results — 2026-10-05 (06-12 → 10-05, 18,335 ticker-days, session line)

1,883 setups on 1,087 ticker-days; 416 crashed straight through the line (no
alert). "Win" = +10% before a close under the line.

| | alerts | win | broke | P&L, exit on a 1m close under the line, +10% target | P&L, stop 0.5% under the line, +10% / +20% / no target |
|---|---:|---:|---:|---:|---|
| touch 1 | 842 | 26.4% | 64.8% | −0.94% | −0.24% / −0.22% / −0.37% |
| touch 2 | 346 | 29.8% | 62.1% | −0.21% | +0.38% / +0.29% / +0.31% |
| touch 3+ | 279 | 25.8% | 62.7% | −0.87% | −0.15% / −0.68% / −1.18% |
| baseline: any close within 5% above the line | 60,683 | 4.8% | 50.8% | −0.55% | −0.34% / −0.34% / −0.32% |

- **The alert puts you in front of moving stocks, but it's not a mechanical
  edge.** 26–30% of alerts reach +10% before breaking, against 5% for an
  ordinary moment near the line. The average trade is still about break-even.
- **"The first touch is best" doesn't hold here.** Touch 2 did as well as touch 1
  or better. Touch 3+ was the weakest, so the script alerts on 2 touches per
  line per day. Not counting closes straight through the line and allowing up
  to 4 alerts per line adds ~3 alerts a day, averaging −0.45% (stop, +10%), so
  the cap stays. **v15 changed what it counts:** failed pullbacks (BROKEN or
  straight through) instead of every touch. That was at least as good on every
  exit rule (stop +10%: −0.06% → +0.00%, 14.5 → 16.3 alerts/day; `--cap 2
  --cap-on failures` vs `--cap 2 --cap-on touches`). It also stopped cutting off
  a line that keeps holding (MI 2026-10-05).
- **A straight-through stays a failure (measured 2026-10-07, after BIYA).** BIYA's
  session line crashed straight through on its first touch (13:14 Tashkent),
  broke on touch 3, and the cap then blocked a 05:22 ET pullback that ran +19%.
  Counting only alerted-then-BROKEN pullbacks (`--cap 2 --cap-compare`,
  06-12 → 10-07) adds 70 alerts (0.9/day, touches 3–6) that won 22.9% and
  broke 71.4%, at −0.76% per trade (stop, +10%) and −1.84% (close exit). That's
  worse than the baseline, and they lost in 4 of 5 months (October +6.3%, n 4).
  A line a stock has already crashed through is a weaker line, so v15's rule
  stays. Caveat: our session VWAP starts when a name reaches our screen, so the
  first minutes of a move can read differently from TradingView's line (BIYA's
  05:22 is touch 2 on ours and alerts either way).
- **No cap exemption for top gainers (measured 2026-10-10, after WFF).** The v15
  cap blocks 1.8 touches a day, averaging −0.64% (stop, +10%; `--cap-strong`).
  The bigger the day's gain, the worse: +100–200% −0.88%, +200%+ −0.95%. Grade
  B+ or better at the alert: +0.90% on 17 blocked touches, all October (grades
  are stored from 10-01), unproven. Script v16 moved the cap to the server so
  a B+-on-Momentum exemption can run live and be graded.
- **A stop just under the line beats waiting for a 1m close under it**, by about
  0.7 points per trade (touch 1: −0.94% → −0.24%). The close of a breaking bar
  is often far under the line.
- **A looser break rule doesn't help.** Allowing a close 1–5% under the line
  raises the win rate (26% → 33%), but each loss is bigger: −0.94% → −1.40%.
- **A bigger first run doesn't help either.** Arming at 10/15/20/30/50% above
  the line: touch-1 win 22/26/27/28/29%, P&L −1.1/−0.9/−1.1/−1.4/−1.9%.
- **It has been improving month by month** (touch 1, stop +10%): June −0.90%,
  July −0.73%, August −0.50%, September +0.64%, October +2.85% (24 alerts).
- **Time of day** (touch 1, stop +10%): 04:00–07:00 is the worst (−1.07%,
  n 129); 07:00–09:30 is flat (+0.02%, or +1.81% with no target); 12:00–16:00
  +0.61%.
- Weaker hints (n ≈ 50–200, touch 1, close exit): a pullback that takes
  10–30 min beat a fast drop (< 3 min: −1.79% vs −0.07%); a lighter pullback
  (bar volume 0.25–0.5× the run's) beat a heavy one (−0.08% vs −1.12%). Runners
  and fresh names performed the same.
- Volume: 16–21 session-line PULLBACKs per day on names on our screen (median
  16), 13–17 for touches 1–2. Month-line alerts come on top of that.

On 2026-10-05, SAIQ's touches went: 04:03 win, 04:06 broken at 04:09 (a close
2.8% under the line, just before the run to 16), 05:34 win. SDEV 10-02 (the
operator's chart) broke at 12:18 under the strict rule, then ran after an hour
sitting on the line.

## The touch on the bar's low instead of its close (2026-10-21)

The operator, after WHLR / RBNE on 10-21: "shouldn't we check the candle low
instead of close when checking the PULLBACK?" `--touch low` counts a bar whose
low reaches the band (or goes under the line) as the touch, as long as its close
holds at or above the line; the alert still trades from that bar's close.
06-12 → 10-20, session line, 1m bars from our 20s snapshots:

| | close (the script) | low |
|---|---|---|
| alerts (touch 1 / 2 / 3+) | 967 / 402 / 335 | 1,043 / 451 / 406 (~2 more a day) |
| +10% before a close under the line, touch 1 | 26.0% | 28.7% |
| stop 0.5% under the line, +10%: touch 1 / 2 / 3+ | −0.29% / **+0.48%** / −0.20% | −0.69% / −0.41% / −0.51% |
| entry instead by a limit at line × 1.005 (fills ~25%): touch 1 / 2 / 3+ | +0.15% / −0.05% / +0.45% | +0.36% / +0.56% / +0.82% |

- **Not adopted.** The low adds wicks that tagged the zone but closed well above
  it. Entering at that close puts the stop under the line far away, and every
  touch averages 0.3–0.9 points worse.
- **What helps is the entry, not the trigger.** In both versions a limit just
  over the line after the alert, filled about a quarter of the time, beat
  buying the alert's close.
- A close straight under the line stays a failed touch either way (RBNE 04:09
  on 10-21). The lows here are the lowest 20s snapshot of each minute, so real
  wicks reach deeper.

## Two related questions, measured the same day

**A tight base on the session VWAP, then a breakout** (`base_study.py`; the
operator asked about SDEV 05:00–05:30 ET on 10-05). The rule: a 15-min range
≤4% sitting on the line (−1.5% to +3%), then a close above the range on ≥2×
volume, with a stop 0.5% under the range. SDEV's 05:27 breakout is caught
(+10%), but over four months:

| breakouts from a base on the session VWAP | n | +10% before the stop | avg per trade |
|---|---:|---:|---:|
| all | 3,126 (~38/day) | 9% | −0.31% |
| pre-market 04:00–07:00 (like SDEV's) | 245 | 14% | −1.22% |
| 09:30–10:30 | 288 | 13% | +0.63% |
| on names up 30–100% on the day | 402 | 15–23% | ~0% |

Neither volume drying up in the base nor a bigger breakout volume helped. Not
built as an alert.

**The reclaim setup on the session VWAP** (`reclaim_session.py`; "could we do
the same with other VWAP anchors?"). The script's own reclaim logic
(`pinesim.simulate`) runs with our stored session VWAP as the line:

| on the session VWAP | per day | +10% before the stop | avg per trade | held 60 min, no stop |
|---|---:|---:|---:|---:|
| GO | 37 | 16% | −1.18% | −1.48% |
| READY | 72 | 1% | −0.21% | −0.74% |
| any plain reclaim of the line (≥5 closes under, then above) | 165 | 7% | −0.82% | −0.95% |

Not added. The year line can't be measured here; it shipped as a live trial in
script v11.

## The basis line as an entry rule (2026-11-22, `basis_study.py`)

The operator, a few hours after script v45 drew the pullback's basis line (the SMA of the last
20 closes of 15-second bars), with VWAV charts: measure the PULLBACKs where "bb basis going down
when pullback fires, and started going up and candle closes above it", but not those where the
"candle could not close above bb basis", and not those where the "bb basis [is] going up while
pullback fires, I noticed that such setups often drop, or we can count them if we wait for the
drop, returns back and breaks out the candle with the pullback". "With measuring I mean the setup
went +10% or not."

    python basis_study.py rows.csv.gz [--cut 2026-10-09] [--window 300] [--list TICKER]

**What stands in for the line.** We have no 15-second bars. The basis here is the mean of our
own price snapshots (one per ~20 s) over the last 300 seconds, read at each 1m bar's last
snapshot: the same five minutes of prices, sampled a little more coarsely, and from the whole
market where TradingView's feed is Cboe One. Session line only. A borderline candle can fall on
the other side of the line here than on the chart (VWAV 11-20 09:15 ET closes just above it in
our data; on the operator's chart it didn't).

**Data:** 08-14 → 11-21, 70 days, 19,191 ticker-days, 1,303 PULLBACKs (every touch, no cap); the
basis's direction known for 1,246. In sample before 10-09, out of sample from it. The race is
study.py's: a bar high +10% above the entry, or a bar close under the line first, 60 bars.

| | n (in / out) | reach +10% | close under the line first | avg P&L |
|---|---:|---:|---:|---:|
| every PULLBACK, bought at its close (today's alert) | 751 / 552 | 29.3% / 24.6% | 61.7% / 64.1% | −0.32% / −1.19% |
| **basis going down** at the PULLBACK (78% of them) | 568 / 398 | 30.8% / 27.9% | 59.2% / 60.6% | +0.13% / −0.38% |
| **basis going up** at the PULLBACK (22%) | 155 / 125 | 25.8% / 17.6% | 72.9% / 79.2% | −1.87% / −3.46% |
| basis down, **no candle closes above the basis** before the line breaks (a third) | 182 / 134 | 1.1% / 1.5% | 92.3% / 94.0% | −4.97% / −5.59% |
| basis down, a candle does close above it (two thirds): the same PULLBACKs **bought at the PULLBACK's close** | 386 / 264 | 44.8% / 41.3% | 43.5% / 43.6% | +2.54% / +2.27% |
| …**bought at that close above the basis** (rule A, a median 3 min later), +10% from there | 386 / 264 | 28.2% / 27.7% | 55.2% / 53.4% | −1.58% / −1.68% |
| …the same entry, aiming at the PULLBACK's own +10% level | 370 / 248 | 41.9% / 37.5% | 46.2% / 47.2% | −1.10% / −1.75% |
| …rule A with the basis also rising at that candle | 342 / 213 | 26.9% / 28.2% | 54.7% / 47.9% | −2.33% / −1.64% |
| basis up: a drop under the PULLBACK candle's low, then a close above its high within 15 bars | 48 / 42 | 52.1% / 33.3% | 47.9% / 61.9% | +0.06% / −3.65% |

**Read:**

- **The basis's direction at the alert separates them, in both halves.** With the basis going up
  the line breaks 73–79% of the time against 59–61%, and out of sample those reach +10% 18% of
  the time against 28%. Buying only the basis-down PULLBACKs at their close is about break-even
  (+0.13% / −0.38% a trade) where buying all of them loses (−0.32% / −1.19%).
- **A PULLBACK that never gets a close above the basis fails**, 98–99% of the time. That is close
  to true by construction: it never got back over its own five-minute average before closing
  under the VWAP.
- **Waiting for the close above the basis picks the good ones and then pays for it.** The entry
  is a median 3.0% / 3.6% above the PULLBACK's close. From there +10% comes 28% of the time, no
  more often than from the PULLBACK's own close (31% / 28%), and a break costs more, so the
  average trade loses 1.6–1.7% where the PULLBACK's close made +0.1% / −0.4%.
- **The break of the PULLBACK candle after a basis-up PULLBACK** is too few trades to call, and
  the two halves disagree (52% of 48, then 33% of 42).
- The same shape with a 180 s and a 420 s basis (rule A 26.5–28% from its entry; never-above
  0.6–1.5%; basis-up breaking 70–80%).

**Not built.** What it supports: marking or quieting a PULLBACK whose basis is rising at the
alert, and treating "no close above the basis" as a reason to stand aside, not the close above
it as a better price. Not measured: a tighter stop for the later entry (under the pullback's
low), the month and year lines, and the real 15-second line.
