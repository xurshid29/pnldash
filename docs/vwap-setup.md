# 📐 VWAP setup — the operator's edge, detected by TradingView

The single reference for the VWAP/BB setup: what the setup is, what we learned
about it, why TradingView does the detecting, how the Pine script works and how
to tune it, how the signal reaches the dashboard and the phone, and how to grade
and improve it. `docs/detection-layers.md` carries a short summary that points
here; `docs/HANDOVER.md` carries the live status.

| | |
|---|---|
| Shipped | 2026-10-03, commit `d50ebbe` (verified on prod the same day) |
| Detector | `apps/web/src/tv/mvwap-bb-setup.pine` — Pine v6, **script version v14** (history in §12). Since v10 it carries two setups: the reclaim setup (§1–§12) and the PULLBACK setup (§13). Since v11 the reclaim setup runs on the month **and the year** VWAP (§5.2) |
| Runs as | two TradingView **watchlist alerts**: 1m and **30s** since 2026-10-05 ~11:40 ET (1m and 2m before). The operator watches 30s charts and missed a 30s-only GO (SDEV 10:59 ET). Premium = 2 watchlist alerts |
| Offline replay | `apps/api/scripts/research/vwap-setup/` — scores a script version on the examples in seconds |
| Delivered by | `POST /api/tv/webhook?key=<TV_WEBHOOK_SECRET>` → 📐 setups sidebar (left rail), toast + sound, Telegram, `tier_events` |
| First live session | Mon 2026-10-05 |
| Grade it | ~2026-10-17 (the "Grading plan" section below has the SQL) |
| Status | **The reclaim edge is unmeasured** — the evidence is six hand-picked winners. The PULLBACK setup's session-line version measured about break-even on four months of our data (§13.5) |

---

## 1. The setup (the operator's definition)

Described by the operator on 2026-10-03 as the entry they had been trading
"successfully in recent days" (since ~10-01):

1. **The ticker is one of the session's top gainers.** The operator clarified
   it does **not** need to be graded A+ at the moment of entry (in the examples
   it usually wasn't — see §3).
2. **Price is under the month-anchored VWAP** and moving toward it, usually
   less than 10–15% below it.
3. **The Bollinger basis is about to cross up through that VWAP** from about
   5–6% below it.
4. Usually there is a **"rejection confirmation"** first — the first push at the
   VWAP fails, and the pullback holds the rising basis (a higher low). The
   operator says it helps but isn't essential.
5. **MACD 12/26/9** as extra confirmation.
6. **Exit quickly** when the setup goes against them. The edge is not expected
   to work every time.

Chart settings (TradingView, from the operator's screenshots):

| Indicator | Settings |
|---|---|
| VWAP (yellow) | Anchor Period **Month**, Source (H+L+C)/3, bands off, Timeframe Chart, "Wait for timeframe closes" on; chart session **Extended** (pre/post-market included) |
| Bollinger Bands (green) | Length 20, Basis MA **SMA**, Source Close, StdDev 2 — **only the basis line** shown |
| MACD | 12, 26, 9 close |

Timeframes: the screenshots were 2-minute charts; the operator trades from 1m
and 30s charts.

## 2. The evidence so far

Six examples, all session top gainers, read off the operator's 2m screenshots
(times approximate; ET with the operator's UTC+5 in brackets):

| Ticker | Day (ET) | On our screen | Setup | Entry zone | What followed |
|---|---|---|---|---|---|
| AIXI | Fri 10-02 | from 04:56, first A+ 04:59 | basing under mVWAP 07:20–07:50 (16:20–16:50); first push through it 07:52–07:55 rejected; higher low 07:56–08:05 | ~1.48 | 1.89 by 08:13 (+27%); 2.22 after the open |
| NXL | Thu 10-01 | from 08:32, A+ 08:34 | pullback to mVWAP 08:57–09:11 (17:57–18:11), basis rising beneath | ~6.4 | 9.9 on our screen, a ~11 wick on TV around 10:00 |
| VEEA | Thu 10-01 | from 08:03, A+ 08:05 | base 09:00–09:29 (18:00–18:29) at 2.93–3.05 just under mVWAP ~3.06 | ~2.97 | 3.71–3.85 at the open (+25%); a second instance 14:10–15:25 ran to 4.00 |
| NIVF | Wed 09-30 | from 04:56 (before the grade existed) | 08:45–09:28 (17:45–18:28): price ~0.165 vs mVWAP ~0.188, basis ~0.16 | ~0.165 | 0.25 at ~09:40 (+50%) |
| MEDS | Fri 09-18 | from **07:17 — after its VWAP cross** | 06:00–07:09 (15:00–16:09): from ~4.0 up to ~4.6 under mVWAP 4.95 | ~4.5 | 6.83 at ~07:40 (+50%) |
| SOAR | Tue 09-29 | **not on our screen during the session** | several basis crosses that day; the one that ran started ~10:30–13:30 (19:30–22:30) under mVWAP 0.336 | ~0.31 | ~0.42 by 15:30 (+35%) |

**What this evidence cannot tell us.** These are hand-picked winners — the
session's top gainers, chosen after the fact. Bullish patterns tend to show up
on the charts of stocks that went up a lot. What's missing is how often the
same setup appeared on top gainers and failed. Getting that count is the point
of the grading plan (§9).

## 3. What we learned on the first look (2026-10-03)

- **The grade is usually not A+ at the entry.** AIXI on 10-02 went B+/A− while
  basing, briefly A+ on the first push through the VWAP (07:52–07:55), **B+**
  through the higher low (07:56–08:05), and A+ again only once it broke out
  (08:09). The first B+ minutes were the fade cap (≥8% under its 10-minute high)
  and the rest was a genuinely cooling score. VEEA was A/A− through its whole
  base and turned A+ at 09:33 with the opening spike. NXL stayed A+ throughout.
  The dashboard grade therefore looks lukewarm (B+ ▼) exactly when this setup
  wants an entry. The operator's rule is "top gainer today", and the script
  follows it.
- **"Monthly VWAP" is two different lines.** On the 1st trading day of a month
  it *is* the session VWAP (NXL and VEEA on 10-01), and early in a month it is
  a 1–2-day VWAP (AIXI on 10-02 was mostly its own pre-market). Mid- or late
  month, the spike day's volume dominates and the line goes flat: MEDS sat at
  ≈4.95 from its Sep 16–17 run, and SOAR at 0.336 after its 09-28 spike. Both
  can work, but they are different trades, so grading should split them.
- **The setup also chops, even in the operator's own charts.** AIXI around
  13:00 ET 10-02 (the basis reached the VWAP, +3%, then back), VEEA 11:30–14:00
  ET 10-01 (the basis crossed, then two flat hours), SOAR on 09-29 (3–4 crosses
  before the one that ran), and NIVF around 12:00 ET 09-30 (rejected under the
  line). With fast exits that's fine, but it means win rate is the wrong measure.
  What matters is small scratches against +20–60% squeezes.
- **The big moves cluster at clock events.** VEEA, NIVF and AIXI's second leg
  all launched at the 09:30 open, and AIXI's first at ~08:00. A base sitting
  under the VWAP right before the open may simply be riding the open's
  volatility, so time of day needs its own split in grading.
- **We tried the plain version before.** The session-VWAP reclaim layer
  (2026-08-21, retired 08-22) fired 48 reclaims. Of the 41 that "confirmed", 31
  fell back under the VWAP, the median best move was +1.16% above it, and the
  median hold was 10 minutes. It caught chop, not rallies (detection-layers ↑
  section). This setup adds exactly the filters that layer lacked — a top
  gainer, a basis rising under the line, a higher low — so it is a different
  hypothesis, not a disproven one.
- **A+ alone is a coin flip tilted down.** In September (out-of-sample), A+
  rows touched −10% first 29.8% of the time and +10% first 25.0% within 30 min.
  The setup is an attempt to pick out the up-first half: timing on leaders,
  which is the one family our EMA/MACD studies never ruled out (they ruled out
  those indicators as a stock-picking signal).
- **v1 was blind to fast approaches and second-day runners** (found 2026-10-03
  when the operator replayed MEDS on 1m: "missing the opportunity around
  16:00"). On Sep 18 MEDS closed the prior day at 4.60 and traded 4.1–4.5
  pre-market, so its day high was −2% and v1's today-only +20% gate stayed shut
  until 07:11, after the move had started. Its basis also lagged 12–13% under
  the line while price ran from 9.9% to 2.8% under it (07:00–07:07), outside
  FORMING's 10%. NIVF 09-30 (a fast run into the open) and SOAR 09-29 (a
  second-day name) were invisible to v1 for the same two reasons. Turning the
  gate off and widening the bands only reached 4/6 with ~2× the noise, and it
  still missed MEDS: earlier pre-market signals used up the day's setups first.
  That's why v2 changed the logic rather than the settings (§5, §12).
- **After hours, "top gainer" means the move since today's close** (found
  2026-10-03 on AMOD: "why nothing around 02:30?", i.e. 17:30 ET). AMOD fell
  24% on 10-01 (1.565 → 1.19), then ran +70% after hours. Its day high vs the
  prior close was +19.8% on TradingView's bars, just under the 20% gate, so v2
  never armed. The after-hours base under the line (17:00–17:35 ET) was the
  setup, with GO at 17:43 and then 2.10. Finviz and our own screen measure
  after-hours moves against today's close, so v3 does too.
- **Under the basis is no setup** (operator, 2026-10-03). Their rule: price
  must sit *above* the BB basis. v1–v3 let a close sit up to 2% under it
  (`holdTol`), which put a READY triangle under the green line on AMOD
  2026-09-01. The same chart showed a second flaw: a fast READY right after a
  spike *fell back* to the line. That's not an approach from below, though the
  lagging basis made it look like one.
- **A dip under the basis has to end the setup.** The operator's ideal SDEV
  after-hours setup (10-01, ~01:40 UTC+5 = 16:40 ET) went like this: v3 gave
  READY at 15:59 ET, then price dipped 2.2–2.5% under the basis (16:18–16:30)
  and reclaimed it at 16:34. v3's 3% break never triggered, so the stage stayed
  READY and the reclaim, the operator's actual entry, fired nothing. v4 breaks
  at 2% and fires the reclaim as a fresh READY. Breaking on *any* close under
  the basis doubled the noise, and a "N closes in a row under it" rule lost
  SOAR, so 2% it is (replay grid, §12).
- **A basis-cross GO comes too late on fast moves** (operator, NIVF 1m replay:
  "GO is not accurate"). The 20-bar basis lags price, so on NIVF 09-30 it
  crossed the line at 09:38 ET, after a +40% spike, close to the top (0.243 vs
  the 0.255 high). Price itself broke the line at 09:31. Across the replay, GOs
  on the basis cross left a median +6% (1m) of upside in the next 30 min.
  GOs on a decisive price reclaim left +16%, and only 2 of 12 fell back
  under the line within 10 min. v5 fires GO on whichever comes first.
- **Third-session runners are runners too** (operator, AIXI 10-02: "why
  nothing between 13:00–13:20?"). AIXI's +22% day was 09-29, then it went +5%
  and +1%. Its 10-02 pre-market base under the line (1.25) reclaimed at 04:21
  ET and ran to 2.26. With a 2-session look-back the gate was shut until 04:55
  (+20% on the day). With 3 sessions the replay gives READY 04:06 and GO
  04:21, and adds no noise anywhere else in the replay. v7 defaults to 3
  (max 5).
- **Early in a month the line can fall through the basis** (operator, AIXI
  10-01 replay: GO on a crash bar). On the 1st, AIXI's month VWAP rested on a
  few hundred pre-market shares and a ~30K-share opening bar. The 09:38 ET bar
  crashed 1.32 → 1.26 on 26K shares and dragged the line under a flat basis.
  v5 read that as "the basis crossed above the line" and fired GO with price
  under both. Since v6 a cross needs the basis *rising*, and no GO prints on a
  bar that closes below the previous close. The replay can't rebuild TV's
  pre-market line for that day, so `python3 pinesim.py` checks the mechanism
  on a synthetic crash instead.
- **The timeframe changes which setups exist.** On 1m, NXL's 20-bar basis was
  already *above* the line during its 09:00–09:08 pullback (a 20-minute mean
  that still remembered the run to 7.7). On the operator's 2m chart, the
  40-minute basis was −4.4% and crossed at ~09:06, exactly their setup. The
  operator's "5–6%" was learned on 2m, so v2 runs on both 1m and 2m.
- **Free data can't draw this line.** Yahoo's chart API returns real prices
  for pre- and post-market bars but **zero volume** (verified at 1m and 2m on
  AIXI). AIXI's month VWAP at the 10-02 close came out 1.81 from Yahoo
  (regular hours only) vs 1.77 on TradingView, while the BB basis matched to
  the cent (1.63). Our own Finviz snapshots have pre-market volume, but only
  from the moment a ticker reaches our screen, and the `vwap` column is
  anchored at first sight.

## 4. Design decisions

- **TradingView computes the setup; we don't.** The line needs the whole
  month's volume, including pre-market, which neither Yahoo nor our snapshots
  have (§3). Letting TradingView run the rule means the numbers match the
  operator's chart by construction, in real time, on servers TradingView runs,
  and at no extra cost on the Premium plan.
- **Not a headless browser + screenshots + LLM.** The operator floated this
  to watch more charts at once. We rejected it for four reasons:
  - The setup is arithmetic on three numbers (price, VWAP, basis) and a slope,
    and an LLM judging whether a line is 5% or 8% under another is the least
    precise step.
  - Reading the numbers from the chart legend makes the LLM unnecessary anyway.
  - A logged-in automated browser is against TradingView's terms and can clash
    with the operator's own session.
  - Cycling 20–30 charts takes minutes per round, while AIXI's whole entry
    window was ~10 minutes.
- **One watchlist alert over a wide list.** A watchlist alert runs one script
  condition on every symbol in a list. Premium allows 2 active watchlist alerts
  and Ultimate 15
  ([PineConnector, reviewed 2026-09-23](https://www.pineconnector.com/blogs/pico-blog/how-to-use-watchlist-alerts-in-tradingview-for-smarter-trading)).
  Rather than syncing the list with each day's gainers (TradingView has no
  watchlist API), the list is wide — today's screen plus a month of recent
  runners — and the script's own top-gainer gate keeps the quiet names silent.
  All six examples had been on our Momentum screen in the 2–3 weeks before
  their setup day.
- **Two alerts: 1m and 2m.** On the examples (§12), 1m catches fast moves a
  few minutes earlier (MEDS, NIVF) while 2m matches the operator's own 2m eye
  (NXL). Together they caught all six. A stage that fires on both is announced
  once; the second copy is logged only (§7.2).
- **Stages, not one signal.** The operator asked for *earlier* detection.
  FORMING is the heads-up ("open the chart"), READY is the entry zone, and GO
  is the confirmation they described.
- **A fourth opportunity-alert kind (`tv_setup`), not a separate pipeline.**
  It reuses the Alerts tab, toasts, sounds, the ⚙ switches, the row badges,
  Telegram and the `tier_events` grading log the other alerts already have.
- **Plan B, not built: an IBKR TWS API bridge** on the operator's Mac.
  IBKR's data includes pre-market volume, so we could compute the line
  ourselves and show live distances on every top gainer. That's more work, and
  it only runs while TWS is open (IBKR allows one session per username, so it
  can't run on the droplet alongside the operator's own TWS).

## 5. The Pine script (`apps/web/src/tv/mvwap-bb-setup.pine`)

The file in the repo is the only copy. The 📐 sidebar's **⋯ → Copy Pine script** item
serves exactly that file (a Vite `?raw` import), so after a deploy the button
always hands out the latest version. The excerpts below explain it; when they
disagree with the file, the file wins.

### 5.1 Inputs — what each one does and how to tune it

Grouped as in the script's settings dialog. The **gainer filter** (formerly
the "Top gainer" group, renamed in v8) is computed per ticker from that
ticker's own bars. It isn't a screener or a ranking: TradingView runs the
script on every symbol of the attached watchlist, and a ticker that fails the
filter stays silent. Set `minDayGain` to −100 to switch the filter off, e.g.
for a short personal watchlist. Our screener only supplies the suggested
watchlist (§7.1).

| Group | Input | Default | Meaning | Higher → / Lower → |
|---|---|---|---|---|
| Gainer filter | `minDayGain` | 20 | "Up at least %": day high vs the prior regular close; −100 = filter off | fewer, stronger names / more names |
| Gainer filter | `runnerDays` | 3 (v2–v6: 2) | "…today, or on any of the last N sessions" (0 = today only, max 5). New in v2 | older runners qualify / today's gainers only |
| Gainer filter | `useAhGain` | on | "After hours, also count the move since today's close". New in v3 | — / off = after-hours names need a +20% day too |
| Setup | `rcLines` | Month + Year | Which lines the reclaim setup runs on: Month + Year, Month, or Year. Each line keeps its own stages. New in v11 | — |
| Setup | `maxPxBelow` | 15 | Price may be at most this % under the line (month or year VWAP) | deeper pullbacks qualify / only near-the-line setups |
| Setup | `formBasis` | 10 | Base FORMING when the basis is within this % under the VWAP | earlier heads-up, noisier / later, fewer |
| Setup | `readyBasis` | 6 | Base READY when the basis is within this % (the operator's "5–6%") | earlier entries / tighter, later |
| Setup | `holdTol` | 0 (v1–v3: 2) | Price may sit this % under the basis and still count as holding it. 0 = must close at/above it (the operator's rule) | allows higher lows under the basis / — |
| Setup | `failPct` | 2 (v1–v3: 3) | The setup breaks on a close this % under the basis (and under the VWAP); the next reclaim is a fresh READY | fewer re-arms, may sit on a stale READY / more re-arms, more pings |
| Setup | `slopeBars` | 3 | The basis must be higher than N bars ago | smoother and later / faster and noisier |
| Fast approach | `useFast` | on | Price-led route for runs at the line while the basis lags. New in v2 | — / off = v1's base-only behavior |
| Fast approach | `fastAbove` | 3 | Price must be at least this % above the basis (the momentum test) | only strong runs / more, incl. drifts |
| Fast approach | `formPx` | 10 | Fast FORMING when price is within this % under the VWAP | earlier heads-up / later |
| Fast approach | `readyPx` | 5 | Fast READY when price is within this % | earlier, more failed tests / later, closer to the line |
| Fast approach | `maxBasis` | 15 | …while the basis is at most this % under the VWAP | catches steeper ramps / only moderate lag |
| Fast approach | `fromBelow` | 10 | The previous N closes must all be under the VWAP; 0 = off. New in v4 | a longer approach required / spike pull-backs can count |
| Alerts | `maxCycles` | 6 (v1: 3, v2–v3: 4) | Max setups per ticker per day (re-arms included), **per line** since v11: up to 6 on the month line and 6 on the year line. GO isn't capped | later setups survive early chop / fewer repeats |
| Alerts | `goMemory` | 60 | GO may fire up to N bars after the last FORMING/READY, even if a break came in between; 0 = only while armed. New in v4 | GO after longer shakeouts / stricter |
| GO | `goOn` | Either | What fires GO: Either (whichever first), Price reclaim, or Basis cross (v1–v4 behavior). New in v5 | — |
| GO | `goAbovePct` | 2 | Price reclaim: the close must be at least this % above the VWAP | fewer pokes, later GO / earlier, more false starts |
| GO | `goWithin` | 5 | …having been at/under the VWAP within the previous N bars | reclaims after longer holds count / only fresh crossings |
| Alerts | `alertWin` | 0400-2000 (v2: 0400-1600) | **New York time** window in which stages can fire — the whole extended session. New in v2 | — / e.g. 0600-1600 drops early pre-market chop and after-hours pings |

**The timeframe changes what the basis means.** The basis is a 20-bar SMA: 20
minutes on a 1m chart, 40 on 2m, 10 on 30s. The operator's "5–6%" came from 2m
screenshots, while the alert runs on 1m, so `readyBasis` / `formBasis` are the
first things to calibrate (bar replay, then grading).

### 5.2 The lines

```pine
mvwap  = ta.vwap(hlc3, timeframe.change("M"))   // resets on the first bar of each month
basis  = ta.sma(close, 20)                       // the BB basis line
crossU = ta.crossover(basis, mvwap)              // computed on EVERY bar — see 5.6
```

This reproduces TradingView's built-in VWAP with anchor Month and source hlc3,
and the BB basis. Volume includes extended hours when the chart or alert
session is Extended.

**v11 adds the year line** (plotted blue). v11–v13 built it like the built-in
VWAP with anchor Year, `ta.vwap(hlc3, timeframe.change("12M"))`; **v14 builds it
from hourly bars** (see below).
The reclaim rules run on each line separately, through `reclaimConds(line)` for
the conditions and `RcLine.advance()` for the stages (a broken month setup
doesn't reset the year one). The same stage on one bar from both lines is one
message with `line both`.

**Caveat — the year line is only as long as the loaded history.** A 1m chart
of a liquid name holds roughly 3–4 weeks of extended-hours bars, and a 2m chart
about twice that. Thin names reach further back, because TradingView only makes
a bar when something trades. So on intraday charts the "year" VWAP — the
script's and TradingView's built-in one alike — usually starts at the first
loaded bar, not at January 1, and the 1m and 2m alerts may see different year
lines. Each message carries `yVWAP`, so the alert engine's value can be checked
against the operator's chart. If it drifts, build the year-to-date part from
60m or daily bars (`request.security`) plus today's part from the chart's bars,
like the month-line fix in §5.7.

**v14: the year line from hourly bars.** The year line now comes from this
year's 60-minute bars, extended hours included, up to the end of yesterday,
fetched with `request.security(ticker.new(prefix, ticker, session.extended),
"60", yearBefore(), lookahead_on)`. Today's part comes from the chart's own
bars:
- `yearBefore()` keeps running sums and returns the totals at the start of the
  current day. They don't depend on the current hour, so `lookahead_on` can't
  leak future data.
- A year of hourly bars is ~4,000. That's within the history a request gets,
  so the line really starts at January 1 (or at listing) on every timeframe.
- The 30s chart, the 1m alert and the 30s alert share one line. (SDEV 10-05:
  30s showed 4.36 and the 2m alert 4.70 before v14.)
- The price is hourly hlc3 for past days, so it's an approximation within a
  fraction of a percent of a minute-built VWAP.
- On liquid names it no longer matches TradingView's built-in "VWAP Year" on an
  intraday chart, because the built-in has the history problem. The script's
  blue line is the reference.

**Every line restarts on the first loaded bar (v12).** This is exactly what
TradingView's built-in VWAP does (`if na(src[1]) … isNewPeriod := true`):
`ta.vwap(hlc3, timeframe.change("12M") or firstBar)`. v11 lacked it. Its year
line was then na until the chart's history reached January, so it showed only
on thin names. On 2026-10-05 SAIQ (1m) had the line and VEEA and PCVX (30s) did
not, and no year-line setup could fire on a liquid name. The same reset keeps
the month line from going blank late in a month on short timeframes.

### 5.3 The top-gainer gate (today, or a recent session — v2)

```pine
newDay = timeframe.change("D")
if newDay
    array.unshift(dayGains, (dayHigh / prevDayClose - 1) * 100)   // the session that just ended (newest first, keep 5)
    prevDayClose := lastRegClose                                   // the last regular-session close of the prior day
    dayHigh      := high
else
    dayHigh := na(dayHigh) ? high : math.max(dayHigh, high)
if session.ismarket
    lastRegClose := close
dayHighGain = (dayHigh / prevDayClose - 1) * 100
if session.ispostmarket
    ahHigh := na(ahHigh) ? high : math.max(ahHigh, high)       // reset with the day
ahGain = session.ispostmarket and not na(ahHigh) ? (ahHigh / lastRegClose - 1) * 100 : na
gainer = (not na(dayHighGain) and dayHighGain >= minDayGain) or recentGain >= minDayGain or
     (useAhGain and not na(ahGain) and ahGain >= minDayGain)   // recentGain = max of the newest runnerDays entries
```

A second- or third-day runner sets up *before* it is up on the day. MEDS on
09-18 was −2% until its move began, but +655% two sessions earlier. The
lookback needs those sessions loaded on the chart; on 1m and 2m they are.
After hours (v3), the high since today's regular close also counts, which is
the same reference as Finviz's AH change. AMOD 10-01 qualified that way.
Because the base gate is a hard 20% line, the data feed matters near the edge:
Yahoo's bars put AMOD at +20.1% and TradingView's at +19.8%.

The prior close is tracked from the last regular-session bar rather than
`request.security("D", close[1])`, because during pre-market the daily series'
"current bar" is ambiguous. This gives the same reference as Finviz's Change.
It needs at least one prior regular session loaded. The gate uses the **day
high** on purpose: the setup is a *pullback*, so the stock may currently be well
off its high.

### 5.4 Distances, conditions and the two shapes

```pine
pxBelow    = (mvwap - close) / mvwap * 100   // > 0 = price under the line
basisBelow = (mvwap - basis) / mvwap * 100   // > 0 = basis under the line
basisUp    = basis > basis[slopeBars]
gapClosing = basisBelow < basisBelow[slopeBars]
holding    = close >= basis * (1 - holdTol / 100)
inZone       = valid and pxBelow > 0 and pxBelow <= maxPxBelow and basisUp and holding
aboveRecent  = math.sum(close >= mvwap ? 1.0 : 0.0, math.max(fromBelow, 1))[1]   // top level, every bar
fromBelowOk  = fromBelow == 0 or aboveRecent == 0
fastApproach = useFast and fromBelowOk and close >= basis * (1 + fastAbove / 100) and basisBelow <= maxBasis
baseForming  = basisBelow > readyBasis and basisBelow <= formBasis
baseReady    = basisBelow > 0 and basisBelow <= readyBasis
forming = inZone and gapClosing and (baseForming or (fastApproach and pxBelow <= formPx))
ready   = inZone and (baseReady or (fastApproach and pxBelow <= readyPx))
go      = valid and crossU
inWindow = not na(time(timeframe.period, alertWin, "America/New_York"))
```

There are two shapes of the same setup:
- **Base:** price consolidates under the line long enough that the 20-bar
  basis converges within 6% (AIXI, VEEA). Stages are reached by the **basis**
  distance, as in v1.
- **Fast** (new in v2): price runs at the line while the basis lags far behind
  (MEDS 09-18, NIVF 09-30). Stages are reached by the **price** distance
  instead. The momentum test is price at least `fastAbove`% over a rising basis,
  which keeps flat drifts out; in flat chop, price ≈ basis. Since v4 the
  previous `fromBelow` (10) closes must also all be under the line. Right after
  a spike the basis lags far below while price falls back to the line, and v3
  mistook that for a fast approach (AMOD 2026-09-01).

Each FORMING/READY message says which shape reached it (`path base|fast`, §5.6).

`holding` has a tolerance because at AIXI's higher low (1.47 at ~08:02) price
sat slightly *under* the 2m basis (~1.49). A strict `close >= basis` would have
fired READY only after the bounce.

### 5.5 The stage machine

```
                 forming                ready              basis crosses above mVWAP
  IDLE (0) ───────────────▶ FORMING (1) ───────▶ READY (2) ──────────────────────▶ GO (3)
     │  └──────────── ready (skips FORMING) ──────────▲                              │
     ▲                                                                                │
     └──── break: close < mVWAP AND close < basis × (1 − failPct%) — from any stage ◀┘
  new ET day → IDLE and cycles = 0; a setup can start from IDLE only while cycles < maxCycles
```

- Each stage fires once per setup, and only forward (`target > stage`).
- **What fires GO (v5):** a decisive **price reclaim** or the **basis cross**,
  whichever comes first. A decisive reclaim is a close at least 2% above the
  line, at/under it within the previous 5 bars, with the basis rising. The
  message says which one fired (`via reclaim|cross`). The basis cross alone
  fired near the top of fast moves (§3).
- **GO sanity (v6):** a basis cross counts only with the basis **rising**, and
  no GO of either kind prints on a bar that closes **below the previous
  close**. This blocks a thin month-start line collapsing under a flat basis
  on one heavy red bar (AIXI 10-01, §3).
- **GO requires an earlier FORMING or READY**, so a vertical spike straight
  through the VWAP is not reported as this setup. Since v4, "earlier" means
  the setup is armed now *or* one fired within `goMemory` (60) bars, even if a
  break came in between. AIXI 2026-10-02 had READY, then a dip under the basis
  (a break), then one bar straight back over both lines; v4 still gives its GO
  at 08:12.
- **The break is now a close 2% under the basis** (and under the VWAP); v1–v3
  used 3%. It ends a setup that lost its basis, so the reclaim fires a fresh
  READY (SDEV's after-hours entry, §3).
- A broken setup re-arms and counts as a new cycle (max 4 per ticker per day).
- **Outside the alert window (default 04:00–20:00 New York, the whole extended
  session) nothing fires and no stage advances.** At the window's start,
  conditions fire fresh, and breaks still re-arm outside it. v2's default was
  04:00–16:00 to keep after-hours pings off the operator's night (UTC+5); the
  operator wants after-hours setups, so v3 opens it. The field is **New York
  time**, not UTC+5.
- On fire, the script sends the alert message and plots a marker (orange
  circle = FORMING, yellow triangle = READY, green "GO" label). Bar replay on
  past days therefore shows exactly where it would have fired.

### 5.6 The alert message — a contract with the server

```
READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1 | path base
READY AMOD 1.38 | mVWAP 1.42 (-2.5%) | basis 1.35 (-4.6%) | day high +20% | ah +34% | tf 1 | path base
```

`stage ticker close | mVWAP <value> (<price vs VWAP %>) | basis <value> (<basis
vs VWAP %>) | day high <±gain>% [| ah <±gain>%] | tf <timeframe.period> | path <base|fast>`.
- `path` (v2) appears only on FORMING/READY.
- `ah` (v3) appears only after hours.
- `via` (v5) appears only on GO: `reclaim` or `cross`.
- `vol <N>x` and `run <±N>%` (v9) appear on every signal: the signal bar's
  volume ÷ the average of the previous 20 bars, and the close vs 10 bars
  earlier. They feed the GO strength score (§7.5).
- v3 writes a negative day high as `-2%`; v1/v2 wrote `+-2%`, which the parser
  also reads.
- Older messages still parse; missing parts become null. It is built with
`str.tostring(x, format.mintick)`, which keeps sub-dollar precision (0.1259).
It is sent with `alert(msg, alert.freq_once_per_bar_close)`, so it arrives at
the bar close: up to 60 s after the condition on a 1m chart.

**v11** (the year line):
- every reclaim message adds `yVWAP <value> (<price vs it %>)` and
  `line month|year|both` (v14 writes `month+year` for both; see below);
- `basis (%)` is measured against the setup's own line (the month line on
  `month` and `both`);
- the mVWAP percentage gets a `+` when price is above the line.

```
READY SAIQ 6.5 | mVWAP 4.1 (+58.5%) | yVWAP 7.0 (-7.1%) | basis 6.3 (-10.0%) | line year | day high +336% | tf 1 | path base
```

The server stores `yvwap`, `ypx_pct` and `line`; older messages without
`line` are the month line. Telegram mute for the year-line experiment alone:
`ALERTS_DISABLED=tv_year`.

The PULLBACK setup (v10) has its own message, PULLBACK / BROKEN / HELD with
`sVWAP`, `line`, `touch` and `peak` (§13.4). **v14:**
- lines that fire the same stage on one bar are named together in script
  order: `session+month`, `session+year`, `month+year`, `session+month+year`;
- the parser still reads the legacy `both` (session + month for PULLBACK,
  month + year for reclaim);
- PULLBACK messages also carry `yVWAP`;
- Telegram `tv_year` mutes any message about the year line alone.

**The server parses this text** (`parseTvMessage` in
`apps/api/src/services/tv-setups.ts`). If you change the message, change the
parser too and run `npx tsx scripts/verify-tv-setups.ts` from `apps/api`. The
script's last section reads the `.pine` file and fails if the message parts the
parser relies on are gone. The parser also accepts:
- the `alertcondition()` fallbacks, `READY {{ticker}} {{close}} | tf {{interval}}`
  and `GO …`, for when watchlist alerts don't offer "Any alert() function call";
- a JSON body with the same field names as `TvSetupSignal`;
- exchange-prefixed tickers (`NASDAQ:AIXI`), lowercase stages, and the Unicode
  minus sign.

### 5.7 Pine v6 gotchas (learned writing v1)

- **`and` / `or` are lazy in v6.** A `ta.*` call inside a condition may be
  skipped on some bars, which corrupts its internal history. So `ta.crossover`
  is computed at the top level on every bar (`crossU`) and only *combined*
  inside conditions.
- **`var` state rolls back on every real-time tick** until the bar closes, so
  the stage machine effectively commits once per closed bar. Combined with
  once-per-bar-close alerts, nothing fires on an intrabar wiggle.
- **History limits are a known risk.** A 1m chart with extended hours has ~960
  bars a day and 30s has ~1,920. Late in a month the chart, and possibly the
  alert engine, may not hold bars back to the 1st. The month VWAP then starts at
  the first loaded bar, as the built-in one does since v12 (§5.2; before v12
  the script's line was na there), so it may drift from the operator's line if
  the alert engine loads less history than their chart. **Check:** the
  script's yellow line must sit exactly on the built-in "VWAP Month". **Fix if
  it drifts:** compute the month-to-date part from a 60m
  `request.security` and only today's part on the chart timeframe.
- `syminfo.ticker` is the bare ticker (no exchange); the server strips any
  `EXCH:` prefix anyway.
- **Alerts snapshot the script.** TradingView alerts keep running the script
  as it was when the alert was created. After saving a new version, delete and
  recreate the watchlist alert (§10).
- **Wrapping long expressions:** continuation lines must be indented by a
  number of spaces that is not a multiple of 4 (see `recentGain`).
- **`math.sum` must stay at the top level** (`aboveRecent`). Inside a lazily
  evaluated `and`/`or` it would skip bars and miscount.

### 5.8 Offline replay — score a change before shipping it

`apps/api/scripts/research/vwap-setup/` holds `pinesim.py`, a Python mirror of
the script (`V1` / `V2` presets), and `replay.py`, which scores a version on
the six examples on 1m and 2m. A FORMING/READY in the operator's real entry
window counts as caught, and every other FORMING/READY as noise. It was
validated against the operator's MEDS 1m chart (v1 markers on 09-17
reproduced). The month VWAP is read off TradingView per example, because
Yahoo can't build it. Yahoo's 1m bars only reach back ~30 days, so add fresh
examples (failures too) while they are available. See the folder's README.

### 5.9 Other timeframes (30s, 5m, …)

The script runs on any timeframe, and the webhook and the 📐 sidebar label any
interval ("30s", "5m"). Nothing is tied to 1m/2m, but the setup changes with
the bar size, because these are counted in **bars**, not minutes:
- the BB basis (20 bars: 10 min on 30s, 20 on 1m, 40 on 2m, 100 on 5m);
- `slopeBars` 3, `fromBelow` 10, `goWithin` 5 and `goMemory` 60.

The % thresholds were calibrated on 1m/2m charts.

Replay on 5m bars (2026-10-03, v8 defaults; 10 targets):

| | caught | other signals | GO median upside left | GO back under |
|---|---|---|---|---|
| 1m | 9/10 | 24 | +15.7% | 2 of 13 |
| 2m | 9/10 | 16 | +18.7% | 2 of 12 |
| 5m | 7/10 | 7 | +16.3% | 1 of 8 |

On 5m it's much quieter, but it misses the fast ones (NIVF into the open,
NXL, SDEV's morning setup): a 5-minute bar is too coarse for them. Shrinking
the bar counts to match 1m's minutes didn't help (7/10, noisier).

30s can't be replayed (Yahoo has no 30-second bars). Expect a basis that hugs
price, so more crosses and re-arms, i.e. noisier. The month VWAP may also
come out shorter late in the month, because a 30s chart holds fewer days, so
check the yellow line against the built-in "VWAP Month" (§5.7). Whether
watchlist alerts offer second-based intervals on a given plan is
TradingView's call; check the alert's interval list.

Premium has two watchlist-alert slots; **1m + 2m together caught 10/10** in
the replay. For a calmer feed, 2m + 5m is an option. 30s and 5m work fine
for *viewing* the markers on a chart.

## 6. TradingView setup (operator steps)

Everything is on the dashboard's **📐 VWAP setups** tab (the **How to** button
repeats these steps).

1. **Copy Pine script** → TradingView Pine Editor → paste → Save → Add to chart.
   Check that its yellow line sits on the built-in "VWAP Month".
2. **Download .txt** → watchlist menu → Import list (or paste **Copy list**).
   Refresh it each morning; it changes as new runners appear.
3. **Create two alerts** → Symbols: that watchlist → Condition: *mVWAP-BB* →
   "Any alert() function call" → session Extended → once per bar close. Make
   one with interval **1 minute** and one with **2 minutes**; that uses both of
   Premium's watchlist-alert slots.
4. **Notifications** → tick Webhook URL → `https://pnldash.uz/api/tv/webhook?key=<TV_WEBHOOK_SECRET>`.
   The key is in the prod `.env`; the full URL was given to the operator on
   2026-10-03. TradingView may ask for two-factor authentication on the account
   before it allows webhooks. App push and pop-up are optional, since Telegram
   and the dashboard already notify.

If "Any alert() function call" isn't offered for watchlists, use the READY
condition instead (one per timeframe). A stage that fires on both timeframes
within 5 min is announced once; the second copy is logged only (§7.2).
**After every script update, delete and recreate both alerts.**

## 7. Our side — how a signal travels

```
TradingView servers                                   pnldash droplet
┌──────────────────────────────┐   HTTPS POST       ┌──────────────────────────────────────────┐
│ watchlist "runners" (≤1000)  │   text/plain        │ nginx  /api/ → api:3001                  │
│ × mVWAP-BB script, 1m, ETH   │ ─────────────────▶  │ routes/tv.ts       key check, dry=1      │
│ alert(): FORMING/READY/GO    │   ?key=SECRET       │ services/tv-setups.ts  parse → gate      │
└──────────────────────────────┘   (answer < 3 s)    │ poller.deliverTvSetup                    │
                                                     │  ├─ tier_events (alert / tv_setup)       │
                                                     │  ├─ payload.alerts (engine recent list)  │
                                                     │  ├─ SSE 'alert' → browser, at once       │
                                                     │  └─ Telegram (unless muted)              │
                                                     └──────────────────────────────────────────┘
```

### 7.1 Endpoints

- **`POST /api/tv/webhook?key=…[&dry=1]`** (no JWT — TradingView can't send
  headers, so the shared secret rides in the URL).
  - Unset `TV_WEBHOOK_SECRET` → 503; wrong key → 401 (constant-time compare).
  - Unparseable message → 400, and the raw text (first 200 chars) is logged.
  - `dry=1` parses and echoes the signal without storing or sending anything.
  - The reply goes out immediately; delivery is fire-and-forget behind it
    (TradingView cancels requests that take over ~3 s).
  - The body is text/plain for the script's `alert()` text, or JSON, which the
    global parser has already turned into an object.
- **`GET /api/tv/watchlist[?days=30&min_chg=30]`** (JWT): every name on today's
  Momentum screen, then every name that hit ≥ `min_chg`% on our screen in the
  last `days` days, newest first, max 1,000. Nasdaq names get the `NASDAQ:`
  prefix (SEC exchange map — the SPRO index-collision fix) and the rest stay
  bare. It scans a month of `screener_results` (~8 s cold), so the result is
  cached for 10 min. On 2026-10-03 it returned 389 symbols (24 from today + 365
  runners), all six examples included.

### 7.2 Duplicate and flood gate (`TV_SETUP` in `tv-setups.ts`)

| Rule | Knob | Effect |
|---|---|---|
| Same ticker + stage + timeframe within 2 min | `dup_sec` 120 | `drop` — a re-delivery, not stored |
| Same ticker + stage from another timeframe within 5 min | `notify_merge_sec` 300 | `log` — stored for grading, not announced |
| More than 120 webhooks a minute | `max_per_min` 120 | `flood` → 429, so a leaked key or runaway alert can't spam the phone |

### 7.3 What gets stored — `tier_events` row (tier `alert`, event `tv_setup`)

`meta`: `id`, `at`, `stage` (forming/ready/go), `price`, `mvwap`, `px_pct`,
`basis`, `basis_pct`, `day_gain`, `ah_gain` (v3, after hours), `tf`, `path`
(v2: `base` / `fast`), `go_via` (v5: `reclaim` / `cross`) — all as
TradingView reported them —
plus our context at that moment: `chg`, `grade`, `float_m`, `rv1` (when the
ticker is on our Momentum screen), `on_screen`, and `notified` (false = a
repeat from another timeframe). `GET /api/screener/alerts` returns these rows
with a `setup` object; the boot seeding of the other alert kinds ignores them.

### 7.4 What the operator sees

**Priority (2026-10-04, operator's call): a setup on a ticker that is on our
Momentum list is the one to act on.** "On the list" means in the Momentum
rows of the latest cycle; at signal time that is stored as `on_screen`.
- **Telegram:** priority setups get a ⭐ header and a "⭐ on Momentum · grade …
  · now … · float …" line, and push normally (they buzz). Off-list setups say
  "not on our Momentum list" and arrive as **silent** messages (knob:
  `TV_SETUP.offscreen_silent` in `tv-setups.ts`).
- **Dashboard sound and toast:** priority setups get the stage sounds and a
  gold-edged 20 s toast. Off-list ones get a soft single tone and an 8 s toast.
- **📐 sidebar:** ⭐ marks tickers on Momentum *right now*; off-list rows are
  dimmed. Each section is sorted newest first (the operator asked on 10-05 to
  order by alert time, so ⭐ names no longer jump the list).
- **Alerts tab:** ⭐📐 marks a priority setup.

- **📐 setups sidebar** (the left rail, beside Momentum, since 2026-10-05;
  it replaced the 📐 tab). There's one row per ticker with its *current* state:
  - the stage pill with its line (S session / M month / Y year) and touch #;
  - 💪 strength on a GO, and how long ago it fired;
  - on the second line, the **current change %** (bold, green/red) and the
    **grade badge** (as in the Momentum table), then the distance to the line
    for a setup still in play, or "since" (live price vs the signal) once
    it's resolved. Names off the Momentum screen have no grade ("—"). Their
    change % and price come from the server's batched Finviz quote for
    today's 📐 tickers off the screen, every 3rd cycle (~1 min), `payload.tv_quotes`,
    after-hours values after 16:00 ET.

  It has two sections, both newest first. **Live** holds FORMING/READY under
  30 min old, a GO under 15 min, and a PULLBACK with no BROKEN/HELD yet (under
  60 min). Everything else is **Earlier today**, dimmed and collapsible. Each
  row starts with the Finviz and TradingView buttons, then the ticker. The 1m
  and 2m copies of a stage merge into one event, tagged "1m+2m". A click selects
  the ticker and opens its day trail. The ⋯ menu has Copy list, Download .txt,
  Copy Pine script and How to. `components/screener/TvSetupsSidebar.tsx`.
- **"Not in your TV list" nudge** (2026-10-05). The alerts only see the symbols
  on the TradingView watchlist, and that list is pasted in by hand. MI ran +634%
  on 10-05 with no alerts all day: it hadn't been a runner when the list was
  copied on Sunday. The sidebar now remembers what the last Copy list or
  Download held (this browser's localStorage, `tvList.lastCopied`). It flags
  today's screen names that weren't in it, with a **Copy** button for just
  those. Watchlist alerts pick up symbols added to the list by themselves, so
  nothing needs recreating
  ([TradingView](https://www.tradingview.com/support/solutions/43000739708-watchlist-alerts-your-trading-edge/)).
- **Toast + sound + browser notification** the moment the webhook lands:
  - GO: the bright pair (same as 🅰️ A+)
  - READY: a rising triple
  - FORMING: a soft single tone

  When alerts arrive together, the loudest one plays. The ⚙ menu has a
  **📐 VWAP setup** switch; the master Alerts ON/OFF applies too.
- **Alerts tab** — a "📐 Setup" filter, with each signal showing its stage pill,
  levels and timeframe.
- **Momentum row** — a 📐 badge and a cyan left edge for 15 min, pulsing for
  the first 90 s.
- **Telegram** — a header line (📐, the stage, the ticker and price), a hint
  line, the levels, the context, and TradingView + Finviz links. Mute it with
  `ALERTS_DISABLED`: `tv_setup` mutes all stages, or use `tv_forming` /
  `tv_ready` / `tv_go`. The bot's `/alerts off` command (a pause until
  `/alerts on` or the next API restart) applies too.

### 7.5 GO strength (v9, 2026-10-05)

The operator asked how to avoid entering weak GOs (moves under 10%). Every GO
is scored on four checks (`goStrength` in `tv-setups.ts`, knobs in `TV_SETUP`):

| Check | Passes when | Why |
|---|---|---|
| morning | received 04:00–10:30 ET (pre-market + first hour) | replay: 8/8 unique GOs here ran 10%+ in the next hour; afternoon/after hours 3/7 |
| run-up | price up ≥5% over the 10 bars before the GO (`run`) | replay: 16/18 strong GO alerts vs 4/7 weak |
| volume | GO-bar volume ≥2× the previous-20-bar average (`vol`) | the classic breakout confirmation; NIVF 09-30 (big spike, +30%) vs 10-01 (tiny, ~9%). **Unvalidated:** the replay has no pre-market volume |
| on Momentum | the ticker is on our Momentum list (⭐) | the operator's priority (§7.4) |

It shows as **💪3/4** next to GO in the 📐 sidebar and the Alerts tab, with the
checks spelled out under "Latest signal". Telegram adds a "💪 GO strength
3/4 · morning ✓ · run-up +8.1% ✓ · volume 3.2× ✓ · on Momentum ✗" line, and
the browser notification adds "strength 3/4". A v8 message has no
volume/run-up, so those checks are skipped (`max` 2).

**It is a tag, not a filter.** Nothing is suppressed. The score, `vol_x`,
`run_pct` and the per-check flags are stored on every signal, so after ~2
weeks of live signals the grading (§9) can tell which checks actually predict
a 10%+ run before any of them becomes a filter. MACD isn't a check: every
GO in the replay already had MACD above zero, so it separates nothing.
Practical rule meanwhile: exit a GO that closes back under the line or makes
no new high within ~3–5 bars. Weak GOs stall at once.

### 7.6 Files

| File | Role |
|---|---|
| `apps/web/src/tv/mvwap-bb-setup.pine` | the detector (the only copy, served by the Copy button) |
| `apps/api/src/routes/tv.ts` | webhook + watchlist endpoints |
| `apps/api/src/services/tv-setups.ts` | `parseTvMessage`, `TvSetupGate` + `TV_SETUP` knobs, `formatTvSetupAlert` |
| `apps/api/src/services/poller.ts` → `deliverTvSetup` | storage, `payload.alerts`, SSE, Telegram |
| `apps/api/src/services/opportunity-alerts.ts` | the `tv_setup` kind, `TvSetupInfo`, `pushExternal` |
| `apps/api/src/routes/screener.ts` → `GET /alerts` | returns `setup` for tv_setup rows |
| `apps/api/src/services/telegram.ts` | mute slugs `tv_setup` / `tv_forming` / `tv_ready` / `tv_go` / `tv_pullback` / `tv_broken` / `tv_held` / `tv_year` |
| `apps/api/scripts/verify-tv-setups.ts` | regression: 118 checks incl. the Pine ↔ parser contract (both setups, both reclaim lines) |
| `apps/api/scripts/research/vwap-pullback/` | the PULLBACK study on our own data (§13.5) |
| `apps/web/src/components/screener/TvSetupsSidebar.tsx` | the 📐 setups sidebar in the left rail (replaced the 📐 tab, `TvSetupsPanel.tsx`, on 2026-10-05) |
| `apps/web/src/components/common/TvStageTag.tsx` | stage pill, level text, timeframe labels |
| `apps/web/src/hooks/useScreenerStream.ts` | merges SSE `alert` events into the payload |
| `apps/web/src/hooks/useScreenerAlerts.ts` | stage sounds + notification text |
| `AlertToasts.tsx`, `AlertsPanel.tsx`, `ScreenerPanel.tsx`, `AlertKindsMenu.tsx`, `useAlertKinds.ts`, `index.css` | toast colour, Alerts filter, tab + row badge/tone, ⚙ switch |

## 8. Testing and operations

```bash
# Regression (parser, gate, Telegram format, Pine ↔ parser contract)
cd apps/api && npx tsx scripts/verify-tv-setups.ts

# Parse-only check against prod — nothing stored or sent
curl -s -X POST "https://pnldash.uz/api/tv/webhook?key=$TV_WEBHOOK_SECRET&dry=1" \
  -H 'Content-Type: text/plain' \
  --data 'READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1'

# Did signals arrive today? (logs reset on every deploy — tier_events is the durable record)
ssh root@165.245.210.95 'cd /root/projects/pnldash && docker compose -f docker-compose.prod.yml logs --since 12h api | grep tv-setup'
```

- **A full end-to-end test** (non-dry) stores a row and sends Telegram. Use
  ticker `TEST`, then delete it so it doesn't pollute grading:
  `DELETE FROM tier_events WHERE tier='alert' AND event='tv_setup' AND ticker='TEST';`
- **Rotating the secret:**
  1. `openssl rand -hex 20`.
  2. On the droplet, back up `.env`, replace the `TV_WEBHOOK_SECRET` line, and
     run `docker compose -f docker-compose.prod.yml up -d api`. A changed
     `env_file` needs the container recreated; `restart` keeps the old value.
  3. Update the webhook URL in the TradingView alert.
- **The secret also lands in nginx access logs** (it's in the query string).
  That's acceptable on our own droplet; never paste it into docs or commits.

## 9. Grading plan (~2026-10-17)

```sql
SELECT at AT TIME ZONE 'America/New_York' AS et, ticker, meta->>'stage' AS stage,
       (meta->>'price')::numeric AS price, (meta->>'px_pct')::numeric AS px_pct,
       (meta->>'basis_pct')::numeric AS basis_pct, (meta->>'day_gain')::numeric AS day_gain,
       meta->>'tf' AS tf, (meta->>'notified')::boolean AS notified,
       (meta->>'on_screen')::boolean AS on_screen, meta->>'grade' AS grade
FROM tier_events
WHERE tier = 'alert' AND event = 'tv_setup'
ORDER BY at;
```

**Forward path.** Take prices after each signal from `screener_results` for
on-screen names, or from Yahoo 1m bars, whose prices are fine (only the volume
is missing).

**Per stage, measure:**
- the race: +10% first vs a close under the basis (or −5%) first;
- the best move within 30 and 60 min;
- time to GO, and how often FORMING becomes READY and READY becomes GO.

**Split by:**
- the line (v11): month vs year vs both — the year line is a live trial;
- GO strength: score and each check (morning, run-up, volume, on Momentum) —
  which ones actually predict a 10%+ run? (v9, §7.5);
- `path`: base vs fast (v2) — did the fast route add winners or chop?
- timeframe: 1m vs 2m;
- early month (days 1–3, where the line is ≈ the session VWAP) vs mid/late month;
- time of day (pre-market, the open, 10:00–11:00, midday);
- the first setup of the day vs re-arms;
- on screen vs off;
- grade at the signal.

**Baselines:** all A+ moments (25.0% up-first / 29.8% down-first in September)
and the 2026-08 session-VWAP reclaim result.

**Decisions it feeds:**
- keep or retune `readyBasis` / `formBasis`;
- whether FORMING earns its sound and Telegram;
- whether a time-of-day gate helps;
- whether to try another anchor (§11).

Also ask the operator to import a fresh IBKR `.tlg`. The journal stops at
2026-06-18, and their real P&L on these trades is the other half of the answer.

## 10. Changing the script — the procedure

1. Edit `apps/web/src/tv/mvwap-bb-setup.pine` and **bump the version** in its
   header comment. Mirror the logic change in
   `apps/api/scripts/research/vwap-setup/pinesim.py` and run `replay.py`: the
   change should catch at least what the previous version caught, without
   much extra noise.
2. If the alert message changed: update `parseTvMessage`, extend
   `verify-tv-setups.ts`, and run it.
3. `npm run build --workspace=apps/web` (plus `npx tsc --noEmit` in `apps/api`
   if the server changed), then commit. CI deploys, and the 📐 sidebar's Copy
   button now serves the new version.
4. In TradingView: paste the new version into the Pine Editor → Save, then
   **delete and recreate the watchlist alert** (alerts keep the old script
   otherwise).
5. Add a line to the changelog (§12) with the date, version, commit and why.

## 11. Improvement backlog

Ordered roughly by expected value; most should wait for the first grading.

1. **Calibrate on failures, not just winners.** v2's thresholds were shaped on
   the six winners (in-sample). Add the operator's failed setups to `replay.py`
   while Yahoo still has their bars, then use the live grading.
2. **A volume test for the fast path.** It currently relies on price ≥ 3% over
   the basis. A rising-volume condition (e.g. the last N bars' volume vs the
   prior M) may separate real runs from bounces; TradingView has the volume
   even though our replica can't test it.
3. **GO on the price reclaim (option).** On fast moves the basis cross lags:
   MEDS went 07:08 price reclaim → 07:17 basis cross (5.07 → 5.52). An input
   could let GO fire on the first close back above the line after READY. Keep
   the basis cross as the default; it is the operator's definition and it
   filters AIXI-style first pokes that get rejected.
4. **A BROKE stage.** The script re-arms silently today. An explicit "setup
   broke" alert (close under the basis after READY/GO) would support the
   operator's fast exits. It would be a fourth message type: parser + UI + slug.
5. **Rejection confirmation as a stage.** First VWAP test rejected, then a
   higher low on the basis. It is the operator's preferred structure and is
   detectable in Pine (track the session's first close above the VWAP and the
   following low).
6. **Tighter alert window**, if grading confirms the clustering at 07:00–10:00
   ET and the open (`alertWin` already exists).
7. **Optional MACD confirmation:** the 12/26/9 histogram turning up at READY,
   as an input toggle.
8. **Anchor experiments:** session VWAP vs month VWAP vs an anchored VWAP from
   the spike day or first-seen day. The month anchor is a calendar accident; the
   crowd's cost basis may be better anchored at the run's start. Test in Pine
   (one input switching the anchor), grade side by side.
   - **Session line: measured 2026-10-05, no.** `research/vwap-pullback/
     reclaim_session.py` runs the script's own reclaim logic (`pinesim.simulate`)
     with our stored session VWAP as the line (06-12 → 10-05, names on our
     screen). GO fired 37 times a day. 16% reached +10% before a stop 0.5% under
     the line, and the average trade was −1.2% (−1.5% held 60 min with no
     stop). Any plain reclaim of the session line did −0.8% (165 a day). Same
     verdict as the August ↑ VWAP reclaim layer. The likely reason: the session
     line follows the day's own price, so crossing it is routine. A month or
     year line is a slow level, and reclaiming it is a rarer event.
   - **Year line: not measurable from our data** (like the month line, it needs
     volume we never saw). The operator's SAIQ 2026-10-05 chart: the 04:07 ET
     spike stopped at the year VWAP (~7.0), based under it while the basis
     curled up, then reclaimed it at ~04:22 and ran past 13. Only a live trial
     can grade it. **Shipped as that trial in v11** (§5.2); grade it alongside the
     month line (§9, split by `line`). v14 rebuilt the line from hourly bars so
     every timeframe agrees, and added it to PULLBACK too.
9. **Month-to-date from 60m bars**, if the yellow line drifts late in the month
   on 1m (§5.7).
10. **JSON messages** carrying bar time and volume, if the parser needs more
   than the text gives. TradingView then shows raw JSON in its own pop-ups, so
   keep the text format if the operator uses those.
11. **Merge a ticker's stages into one toast** within a few minutes, if
   FORMING → READY → GO in quick succession proves noisy (the same open item as
   the opportunity alerts' cross-cycle merge).
12. **"Since" for off-screen names** from Yahoo prices, and outcome columns on
    the 📐 sidebar once grading exists.
13. **Webhook hardening:** TradingView publishes its webhook source IPs, so an
    nginx allowlist on `/api/tv/webhook` would make a leaked key useless from
    elsewhere.

## 12. Changelog

| Date | Script | Commit | Change |
|---|---|---|---|
| 2026-10-03 | v1 | `d50ebbe` | First version: month VWAP + BB basis, top-gainer gate (day high ≥ +20%), FORMING / READY / GO stage machine with re-arm (max 3/day), once-per-bar-close alerts; webhook, 📐 tab, `tv_setup` alert kind, Telegram slugs, regression script. |
| 2026-10-03 | v2 | `dde023d` | The operator's MEDS replay showed v1 missing 09-18 07:00 ET (§3). Added: `runnerDays` (a gainer in the last 2 sessions also qualifies), the fast-approach route (`useFast`, `fastAbove` 3, `formPx` 10, `readyPx` 5, `maxBasis` 15), `alertWin` 04:00–16:00 New York, `maxCycles` 3 → 4, and a `path base|fast` message segment (parsed and stored; a "fast" tag in the UI). Run on 1m **and** 2m. Replay on the six examples: v1 caught 2/6 (1m) and 3/6 (2m) with 4/5 other signals; v2 caught 5/6 (1m, all but NXL) and 6/6 (2m) with 8/9. MEDS is now FORMING 07:01 → READY 07:05 → GO 07:17 on 1m. The offline replay tool was added in `apps/api/scripts/research/vwap-setup/`. |
| 2026-10-03 | v3 | `88a7093` | The operator asked why AMOD showed nothing around 02:30 UTC+5 (17:30 ET, after hours) (§3). Added `useAhGain`: after hours, the high since today's close also passes the gate (AMOD 10-01: +19.8% day high on TV, +70% after hours). `alertWin` default 0400-1600 → 0400-2000. Message adds `ah ±N%` after hours and writes a negative day high as `-2%` (the parser also reads v1/v2's `+-2%`). AMOD added to the replay as the 7th example. Replay: v3 catches 6/7 on 1m (all but NXL) and 7/7 on 2m, AMOD READY 17:08 / 17:30 ET; other signals 9 / 12 (v2: 8 / 9; the extra are after-hours chop the wider window now reaches). |
| 2026-10-03 | v4 | `3c0076a` | Operator: "a setup under the BB basis should not be a signal", plus three ideal setups (NIVF 09-30 18:30, SDEV 10-01 17:40 and 01:40 UTC+5). `holdTol` 2 → 0 (must close at/above the basis); `failPct` 3 → 2 (a basis loss ends the setup; the reclaim is a fresh READY: SDEV after hours 16:34 ET); new `fromBelow` 10 (the fast route needs the previous 10 closes under the line, which blocks spike pull-backs like AMOD 09-01); new `goMemory` 60 (GO after a break: AIXI 08:12, NXL 09:06 on 2m, SOAR 13:40 on 2m); `maxCycles` 4 → 6. Replay grows to 9 targets + 1 negative (SDEV ×2, AMOD-0901). v3 caught 7/9 on 1m and 7/9 on 2m; v4 caught 8/9 (1m, all but NXL) and 8/9 (2m, all but SDEV-AH), so the two alerts together catch 9/9, and the negative is silent on 2m. Other signals: 1m 14 → 23 (re-fired READYs on basis reclaims in chop), 2m 16 → 16. |
| 2026-10-03 | v5 | `c4a15a3` | Operator: "GO is not accurate" (NIVF 1m: GO at 09:38 ET, near the top of the spike). New `goOn` (Either / Price reclaim / Basis cross, default Either), `goAbovePct` 2, `goWithin` 5. GO now fires on a decisive price reclaim (close ≥2% above the line, at/under it within 5 bars, basis rising) or the basis cross, whichever comes first. The message adds `via reclaim|cross`; it is stored as `go_via`, and Telegram and the notification say which. FORMING/READY are unchanged from v4. Replay GO quality (`python3 replay.py go`): v4 → v5 median upside left over the next 30 min +5.9% → +15.7% (1m) and +11.6% → +18.7% (2m); fell back under the line within 10 min 1 → 2 (1m) and 0 → 2 (2m: AIXI's rejected first push, a MEDS after-hours poke). NIVF GO 18:38 → 18:31 UTC+5 (2m 18:42 → 18:30). |
| 2026-10-03 | v6 | `17f70ab` | Operator: "this one also is not accurate" (AIXI 10-01 1m: GO on the 09:38 ET crash bar). The month-start line, built on thin volume, fell under a flat basis on one 26K-share red bar, and v5 counted that as the basis crossing above it. v6: the cross needs `basisUp` (`crossOk`), and no GO prints on a bar that closes below the previous close. Replay: GOs unchanged except NXL 09:06 on 2m (NXL keeps its 09:12 reclaim GO). The replica gained `python3 pinesim.py`, a synthetic crash test: v5 gives GO, v6 doesn't. AIXI-1001 was added as a should-not-fire replay case (its pre-market line is approximated, since Yahoo has no pre-market volume). |
| 2026-10-03 | v7 | `90d580a` | Operator: "why nothing between 13:00–13:20?" (AIXI 10-02 pre-market). AIXI was a third-session runner (+22% on 09-29), so the 2-session look-back kept the gate shut. `runnerDays` default 2 → 3, max 3 → 5; the gains now live in a 5-entry array instead of gain1..3. Replay with the new AIXI-1002PM case: v6 caught 8/10 on 1m and 8/10 on 2m, v7 caught 9/10 on both (READY 04:06 / 04:08 ET, GO 04:21). Other signals unchanged (24 / 16). |
| 2026-10-03 | v8 | `cbd90a8` | Clarity only, no logic change. The settings group "Top gainer" is renamed "Gainer filter (this ticker's own move)", with titles "Up at least % (day high vs prior close; -100 = filter off)", "…today, or on any of the last N sessions", and "After hours, also count the move since today's close". The operator had asked which screener picks the "top gainers"; none does — it's a per-ticker filter. Renamed inputs may come back at their defaults after the update. |
| 2026-10-05 | v9 | `bf8eff4` | Operator: "how not to enter the weak GOs (under 10%)?" No signal logic change. Every message now carries `vol <N>x` (signal-bar volume ÷ previous-20-bar average) and `run <±N>%` (close vs 10 bars earlier). The server scores each GO 0–4 (morning 04:00–10:30 ET, run-up ≥5%, volume ≥2×, on Momentum) and shows 💪N/M on the 📐 and Alerts tabs, in Telegram and in the notification; all of it is stored for grading (§7.5). A tag, not a filter, until live data says which checks matter. Regression: 71 checks. |
| 2026-10-05 | v10 | `9d3a4f9` | Operator: a second VWAP setup — after a fast run, price comes back down to the session or month VWAP and bounces; alert at ~5% above the line "so I can be ready", exit when it crosses down. Added to the same script (Premium's 2 alert slots are taken) as the PULLBACK setup (§13): a session VWAP line (`ta.vwap(hlc3, timeframe.change("D"))`, purple), per-line state, messages PULLBACK / BROKEN / HELD with `sVWAP`, `line`, `touch`, `peak`; new input group "Pullback to VWAP (v10)" (arm 15, near 5, break 0, held 10, 2 per line per day, 60-bar timeout). The reclaim setup is unchanged. Server, 📐 tab (one row per ticker and setup, S/M line and #touch tags), Telegram (outcomes always silent), the replica (`PullbackLine`, `selftest_pullback`) and the study (`research/vwap-pullback/`) ship with it. Regression: 102 checks. |
| 2026-10-05 | v11 | `50280d1` | Operator: "could we do the same with other VWAP anchors, such as session and yearly?" The session line was measured first: the script's own reclaim logic on our stored session VWAP over four months fired GO 37 times a day, and the average trade was −1.2% (§11 item 8), so it was not added. The year line can't be measured from our data. It's added as a live trial: `yvwap = ta.vwap(hlc3, timeframe.change("12M"))` (blue), new input `rcLines` (Month + Year by default), the reclaim conditions moved into `reclaimConds(line)` and the stages into a per-line `RcLine`. The month line's logic is unchanged. Messages add `yVWAP` and `line month|year|both`; `basis %` is against the setup's line. The server stores `yvwap` / `ypx_pct`; the 📐 tab gets a "year" row and a Y / M+Y tag; Telegram mute `tv_year`. Replica: `simulate_lines()` plus a two-line self-test. Regression: 118 checks. |
| 2026-10-05 | v12 | `02f39eb` | Operator: "yearly VWAP is visible only for SAIQ, but not for others". v11's year line was na until the loaded history reached January. TradingView's built-in VWAP also restarts on the first loaded bar, and the script didn't, so the line showed only on thin names whose sparse bars reach back that far (SAIQ 1m yes; VEEA, PCVX 30s no). All three lines now restart on the first loaded bar like the built-in: `ta.vwap(hlc3, timeframe.change(...) or firstBar)`. No other change. |
| 2026-10-05 | v13 | `b8d338c` | Chart markers only. The year line's FORMING / READY / GO markers are drawn in blue, like its line, so a chart shows which line fired (the operator's AMOD chart had a cluster of unlabeled year-line READYs). No alert logic change, so the alerts don't need recreating. Also answered: `maxCycles` (6) counts per line, so up to 6 month-line and 6 year-line setups per ticker per day; GO isn't capped. |
| 2026-10-05 | v14 | `73aacf4` | Operator, two findings. **SDEV:** a year-line GO on the 30s chart (line 4.36) never reached us, because the 2m alert's year line was 4.70. **MI:** a 12:40 ET pullback to the year line, after a run to 6.6, then +90%, and the PULLBACK setup didn't watch that line. (MI also wasn't on the TradingView watchlist; the sidebar's "not in your TV list" nudge, shipped the same day, covers that.) Changes: the year line is built from this year's hourly bars (extended hours) up to yesterday plus today's chart bars (`request.security`, §5.2), so every timeframe shares one line. PULLBACK gets the year line (`pbSession` / `pbMonth` / `pbYear`). Lines that fire the same event on one bar are named together (`session+month`, `month+year`, …; the legacy `both` still parses). PULLBACK messages carry `yVWAP`, and `tv_year` mutes any year-only message. The replica's `simulate_pullback` takes any set of lines. Regression: 132 checks. |

## 13. The PULLBACK setup (script v10, 2026-10-05)

### 13.1 The operator's definition

> Usually, when the chart rapidly moves up (after the session start, when news
> comes out, or when it just starts moving fast), at some point it starts moving
> down, and when it reaches the VWAP it bounces. The first bounce after the first
> big move is the more attractive one.

The line is usually the month VWAP, and the session VWAP works well too ("I
noticed the monthly line works very often"). Asked for the details on
2026-10-05:
- **Alert** when price comes back down to about 5% above the line, "so I can be ready".
- **Exit** when the setup breaks, i.e. price crosses down through the line.
- **Either line**, session or month.

The operator's examples (screenshots):

| Ticker | Chart | Line | What happened (ET) |
|---|---|---|---|
| SAIQ | 10-05, 1m | session | 4.13 → 6.93 at the 04:00 open, back to the line at 04:09 (5.98, −2.8%), sat on it ~8 min, then 16.16 by 04:37 |
| SDEV | 10-02, 2m | session | 5.03 → 7.05 after the open, faded to the line by ~12:10, sat on it (as low as −2%) until 13:20, then 7.15 at 14:30 and 8.37 after hours |
| VEEA | 09-14/15, 5m | month | ran ~1.9 → 4.2 after hours on 09-14, pulled back to the month line (~3.4) in the 09-15 pre-market, then ran to 7.3 |

### 13.2 Design

- **The same script, not a second one.** Premium has two watchlist-alert slots,
  and the 1m and 2m alerts use both. The script carries both setups, so the same
  two alerts deliver both. The setups share the gainer filter, the alert window
  and the message fields; each line has its own state.
- **It's the reclaim setup's mirror image.** The reclaim setup buys a base
  under the month line. The pullback buys a return to a line from above. v4
  stopped the reclaim setup from firing on "a spike falling back to the line"
  (AMOD 09-01); that case is this setup.
- **Three lines since v14.** v14 added the year line after the operator's MI
  example (10-05, 12:40 ET: after a run to 6.6, price pulled back to the year
  line at ~5.2 while the session and month lines sat ~13% lower, then ran to
  10). Switches: `pbSession` / `pbMonth` / `pbYear`, all on.
- **Two lines (v10–v13).** The session line is TradingView's VWAP with anchor Session
  (`ta.vwap(hlc3, timeframe.change("D"))`; it resets at 04:00 ET on an Extended
  chart), plotted purple. The month line is the existing yellow one. When both
  fire the same event on one bar (early in a month they sit close together),
  the message says `line both`.
- **The outcome is a message too.** BROKEN and HELD come from TradingView,
  because we can't compute the month line ourselves (§13.5). That makes the
  month-line version gradable from its own messages.
- **Delivery.**
  - A PULLBACK is treated like the other stages: on our Momentum list → ⭐ and a
    buzzing push; off the list → a silent message and a dimmed row.
  - BROKEN and HELD are always silent messages and short toasts.
  - On the dashboard, a PULLBACK on a Momentum name plays the READY triple tone.
  - Mutes: `ALERTS_DISABLED` `tv_pullback` / `tv_broken` / `tv_held` (or
    `tv_setup` for all 📐).
  - The 📐 sidebar shows one row per ticker, with its current stage carrying
    the line (S purple / M yellow / S+M) and the touch number.

### 13.3 The rules and inputs (group "Pullback to VWAP (v10)")

Each line keeps its own state, reset every day.

1. **Armed** by a bar high at least *arm* % above the line (gainers only, the
   same filter as the reclaim setup).
2. **PULLBACK** on a *later* bar whose close is within *near* % above the line
   and not more than *break* % under it. A close below that while armed is a
   "through": the touch counts, but no message is sent.
3. While a pullback is open:
   - **BROKEN** on a close more than *break* % under the line;
   - **HELD** on a high *held* % above the PULLBACK close;
   - after *timeout* bars with neither, it is dropped silently.
4. **Re-arming** needs a new bar high at least *arm* % above the line.

| Input | Default | Where it came from |
|---|---|---|
| Pullback setup on | on | |
| Lines | Both | the operator: "either" |
| Armed: a bar high at least % above the line | 15 | the study: 10% adds noise (touch-1 win 22% vs 26%); 20–50% doesn't improve the P&L |
| PULLBACK: a close back within % above the line | 5 | the operator |
| BROKEN: a close at least % under the line | 0 | the operator's exit ("crosses down"); a looser rule wins more often but loses more (§13.5) |
| HELD: price runs % above the PULLBACK close | 10 | the study's win label; it only closes the setup for grading |
| Pullbacks per line per day | 2 | the study: touch 3+ was the weakest |
| Stop watching a pullback after N bars | 60 | the study's horizon |

### 13.4 The message

```
PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | vol 0.6x | run -9.6% | tf 1
BROKEN SAIQ 5.98 | sVWAP 6.15 (-2.8%) | mVWAP 4.1 (+45.9%) | line session | touch 2 | day high +336% | tf 1
HELD VEEA 3.75 | sVWAP 3.9 (-3.8%) | mVWAP 3.41 (+10.0%) | line month | touch 1 | day high +98% | tf 2
```

- `sVWAP` / `mVWAP`: each line and the close's distance from it.
- `line`: session, month, or both.
- `touch`: the touches to that line today, this one included.
- `peak` (PULLBACK only): the highest bar high above the line since arming, %.

The rest is the same as the reclaim setup's message (§5.6). The server stores
each of these as `svwap`, `spx_pct`, `line`, `touch` and `peak_pct` on the
`tier_events` row (tier `alert`, event `tv_setup`, stage `pullback` / `broken` /
`held`).

### 13.5 What our data says — the session line, 2026-06-12 → 10-05

`apps/api/scripts/research/vwap-pullback/` (README there) runs the script's own
state machine (`pinesim.PullbackLine`) on 1m bars built from our 20s snapshots.
The line is the poller's stored session VWAP, within ~1% of TradingView's on
SAIQ and SDEV on 10-05.

**The month line can't be measured from our data.** We only see a ticker while
it is up 20%+, and the month line includes all the volume we never saw. Against
TradingView's own month VWAP (every 📐 signal carries it), a rebuild from our
rows landed within 3% for half the names (CYCU 0.2%, MYND 1%, PMAX 1%, AIXI 2%,
VEEA 2.5%). The rest were 6–37% off (GNS, NIVF, FRGT, SAIQ −13%, LGHL +37%; RETO
had a reverse split). So the month-line version — the operator's favorite — is
graded live (§13.6).

The session line: 18,335 ticker-days, 1,883 setups (416 straight through the
line). "Win" = +10% before a close under the line.

| | alerts | win | broke | P&L: exit on a 1m close under the line, +10% target | P&L: stop 0.5% under the line, +10% / +20% / no target |
|---|---:|---:|---:|---:|---|
| touch 1 | 842 | 26.4% | 64.8% | −0.94% | −0.24% / −0.22% / −0.37% |
| touch 2 | 346 | 29.8% | 62.1% | −0.21% | +0.38% / +0.29% / +0.31% |
| touch 3+ | 279 | 25.8% | 62.7% | −0.87% | −0.15% / −0.68% / −1.18% |
| any close within 5% above the line | 60,683 | 4.8% | 50.8% | −0.55% | −0.34% / −0.34% / −0.32% |

- **A useful heads-up, not a mechanical edge.** Alerts reach +10% 5–6× as often
  as an ordinary moment near the line, but the average trade is about
  break-even. The operator's read of the tape at the line is what has to add
  the edge.
- **"The first touch is best" doesn't hold here.** Touch 2 did as well or
  better. Touch 3+ was the weakest, hence 2 per line per day.
- **The cap was checked again after shipping** (10-05, after SAIQ's early chop
  used up both of its session-line touches before a winning 05:34 pullback).
  Two alternatives were tried: not counting closes straight through the line,
  and allowing up to 4 alerts per line. Together they add ~3 alerts a day, and
  those averaged −0.45% per trade (stop, +10%; −1.59% with no target). v10's
  rule (2 touches, throughs counted, 14.5 alerts a day) did as well as or
  better than every alternative, so it stays.
- **Exit with a stop just under the line**, not on a 1m close under it. That
  was worth about 0.7 points per trade (touch 1: −0.94% → −0.24%), because a
  breaking bar often closes far under the line.
- **A looser break rule doesn't help.** A close 1–5% under the line raises the
  win rate to 33%, but the losses grow more (touch 1: −0.94% → −1.40%).
- **It has been improving month by month** (touch 1, stop, +10%): June −0.90%,
  July −0.73%, August −0.50%, September +0.64%, October +2.85% (n 24). The
  operator's recent experience matches the recent months.
- **Time of day** (touch 1, stop, +10%): 04:00–07:00 was the worst
  (−1.07%, n 129), 07:00–09:30 flat (+0.02%, or +1.81% with no target),
  12:00–16:00 +0.61%.
- Weaker hints (n 50–200): a pullback taking 10–30 min beat a drop of under
  3 min (−0.07% vs −1.79%), and a light pullback beat a heavy one (−0.08% vs
  −1.12%). Runners and fresh names performed the same.
- **Volume.** 16–21 session-line PULLBACKs per day on names on our screen
  (median 16; 13–17 for touches 1–2). Month-line alerts come on top of that.

### 13.6 Grading (~2026-10-19)

Two weeks of live messages give both lines, with TradingView's own outcome
messages:

```sql
SELECT meta->>'line' AS line, (meta->>'touch')::int AS touch, meta->>'tf' AS tf,
       count(*) FILTER (WHERE meta->>'stage' = 'pullback') AS pullbacks,
       count(*) FILTER (WHERE meta->>'stage' = 'held')     AS held,
       count(*) FILTER (WHERE meta->>'stage' = 'broken')   AS broken
FROM tier_events
WHERE tier = 'alert' AND event = 'tv_setup' AND meta->>'stage' IN ('pullback', 'held', 'broken')
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

- The outcome arrives per timeframe. Pair each PULLBACK with the first BROKEN
  or HELD for the same ticker, line and touch.
- **Month line vs session line** is the main question: the operator's
  experience says the month line works more often.
- Split by time of day (pre-market was the weak spot), by touch, by
  on/off Momentum, and by `peak`.
- For on-screen names, check the stop-vs-close exit on live data with our
  snapshots.
- Ask for the operator's IBKR `.tlg`: their discretionary entries at the line
  are what this setup lives on.

### 13.7 Replay and changes

`pinesim.PullbackLine` and `simulate_pullback()` mirror the script's
`PbLine.step` bar for bar. `python3 pinesim.py` runs `selftest_pullback()`, a
synthetic path through PULLBACK → HELD → PULLBACK → BROKEN → through → the
daily cap. The study imports the same class, so a logic change goes into the
`.pine` file and `PullbackLine` together (§10). Then rerun the self-test, the
study and `verify-tv-setups.ts`.
