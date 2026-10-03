# 📐 VWAP setup — offline replay of the Pine script

`pinesim.py` mirrors `apps/web/src/tv/mvwap-bb-setup.pine` (script v2; v1 is
the `V1` preset). `replay.py` scores a script version on the six examples the
setup was defined from, on 1m and 2m bars. It shows the first FORMING/READY
inside the window the operator actually traded ("caught") and counts every
other FORMING/READY ("noise"). Use it before shipping any change to the
script's logic or defaults. The full reference is `docs/vwap-setup.md`.

```bash
cd apps/api/scripts/research/vwap-setup
python3 replay.py            # scorecard, v1 vs v2, 1m and 2m
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
differences between Yahoo and TradingView can shift a signal by a minute.

**Results when v2 shipped (2026-10-03):**

| | 1m caught | 1m noise | 2m caught | 2m noise |
|---|---|---|---|---|
| v1 | 2/6 (AIXI, VEEA) | 4 | 3/6 (+NXL) | 5 |
| v2 | 5/6 (all but NXL) | 8 | 6/6 | 9 |
