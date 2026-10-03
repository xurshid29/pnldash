# 📐 VWAP setup — offline replay of the Pine script

`pinesim.py` mirrors `apps/web/src/tv/mvwap-bb-setup.pine` (script v3; `V1`
and `V2` presets reproduce the earlier versions). `replay.py` scores a script
version on the examples the setup was defined from, on 1m and 2m bars. There
are seven now: the six winners plus AMOD's after-hours setup. It shows the first FORMING/READY
inside the window the operator actually traded ("caught") and counts every
other FORMING/READY ("noise"). Use it before shipping any change to the
script's logic or defaults. The full reference is `docs/vwap-setup.md`.

```bash
cd apps/api/scripts/research/vwap-setup
python3 replay.py            # scorecard, v1 vs v2 vs v3, 1m and 2m
python3 replay.py MEDS 1     # every signal for one example on 1m
```

No dependencies beyond Python 3. Bars come from Yahoo's chart API and are
cached in `$VWAP_SETUP_DATA` (default `/tmp/vwap-setup`).

**Limits:**
- **Month VWAP is read off TradingView, not computed.** Yahoo's pre- and
  post-market bars carry zero volume, so `replay.py` supplies the level per
  window by hand. That's fine where the line is flat (mid-month) or over a
  short window around a setup.
- **Old bars expire.** Yahoo keeps 1m bars for ~30 days (2m for ~60), so these
  examples stop being replayable around 2026-10-18. Add new examples, and the
  operator's failures in particular, while their bars are still available.
- **The score is in-sample.** The v2 thresholds were shaped on these same six
  winners. Real precision comes from grading the live `tv_setup` rows
  (`docs/vwap-setup.md` §9).

**Validation:** with mVWAP 4.94, the v1 preset reproduces the markers on the
operator's MEDS 1m chart for 2026-09-17 and the 09-18 miss. Bar-level
differences between Yahoo and TradingView can shift a signal by a minute, and
can put a ticker on the other side of a hard gate. AMOD 10-01 is +20.1% on
Yahoo vs +19.8% on TradingView; `TV_ADJUST` in `replay.py` corrects that.

**Why didn't it fire?** `simulate(..., trace=fn)` calls `fn` on every bar with
each condition (gate, distances, slope, holding, zone, fast, stage, window).
That's how the MEDS and AMOD misses were diagnosed.

**Results on 2026-10-03 (seven examples):**

| | 1m caught | 1m noise | 2m caught | 2m noise |
|---|---|---|---|---|
| v1 | 2/7 (AIXI, VEEA) | 4 | 3/7 (+NXL) | 5 |
| v2 | 5/7 (all but NXL, AMOD) | 8 | 6/7 (all but AMOD) | 9 |
| v3 | 6/7 (all but NXL) | 9 | 7/7 | 12 |
