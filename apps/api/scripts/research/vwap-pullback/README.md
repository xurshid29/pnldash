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
  the cap stays.
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
