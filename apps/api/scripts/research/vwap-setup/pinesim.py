"""Offline replica of apps/web/src/tv/mvwap-bb-setup.pine — the reclaim setup (v9 logic = v7 + message
fields) in simulate() for one line and (v11) simulate_lines() for the month + year lines, the
PULLBACK setup (script v10) in PullbackLine / simulate_pullback(), the BB breakout (v17–v20) in
simulate_breakout() / simulate_breakout_1m(), and the VWAP + BB cross (v21) in simulate_vb_cross().

Replays the 📐 VWAP-setup stage machine on Yahoo 1m/2m bars so a script change
can be scored on past examples in seconds instead of by hand in bar replay.
Keep it in step with the .pine file (docs/vwap-setup.md §10).

Script v27 (2026-10-28) removed the reclaim setup and the BB breakout from the live
script; PULLBACK and the VWAP + BB cross are what it runs now. simulate() /
simulate_lines() and simulate_breakout*() stay here for research (the studies and
the old rows in tier_events), mirroring the script as it was at v26 (e38c06b).
The VB defaults below are the research ones (5m candle, 2m band); the live script's
default band is 45s since v27, which the 1m-bar studies can't build.

What it can't do: build the month-anchored VWAP. Yahoo's pre/post-market bars
carry zero volume, so the caller supplies mVWAP per bar (read off TradingView —
the line is flat mid-month, and a short window around a setup is enough).
Validated 2026-10-03: with mVWAP 4.94 it reproduces v1's markers on the
operator's MEDS 1m chart for 2026-09-17 (FORMING 11:07, READY 11:45 and 11:59,
FORMING 13:30 ET) and the 09-18 miss.
"""
import datetime
import json

ET = datetime.timezone(datetime.timedelta(hours=-4))   # EDT; fine for Sep–Oct examples

# Script inputs, same names and defaults as the .pine file (fromBelowBars = the script's `fromBelow`).
V7 = dict(minDayGain=20.0, runnerDays=3, useAhGain=True, maxPxBelow=15.0, formBasis=10.0, readyBasis=6.0,
          holdTol=0.0, failPct=2.0, slopeBars=3, useFast=True, fastAbove=3.0, formPx=10.0, readyPx=5.0,
          maxBasis=15.0, maxCycles=6, window=(240, 1200),  # alert window in ET minutes [04:00, 20:00); None = always
          fromBelowBars=10,  # fast route only if every close of the previous N bars was under the line (0 = off)
          goMemory=60,       # GO also fires within N bars of the last FORMING/READY, even after a break (0 = off)
          breakBars=0,       # replica-only experiment: also break after N closes in a row under the basis
          goOn='either',     # GO trigger: 'basis' = basis crosses above the line; 'price' = price reclaims the
                             # line (basis rising); 'either' = whichever comes first (the script's "Either")
          goAbovePct=2.0,    # price reclaim must close this % above the line…
          goWithin=5,        # …having been at/under it within the previous N bars
          crossRule='rising',  # extra test on a basis-cross GO: 'none' (v5) | 'rising' (basis rising, v6) |
                               # 'rising_up' (rising, close >= previous close) | 'full' (rising, close above line and basis)
          goNotFalling=True)   # v6: no GO of either kind on a bar that closes below the previous close
# Earlier versions: V7 with the newer parts switched off / older defaults.
V6 = dict(V7, runnerDays=2)
V5 = dict(V6, crossRule='none', goNotFalling=False)
V4 = dict(V5, goOn='basis', goAbovePct=0.0, goWithin=1)
V3 = dict(V4, holdTol=2.0, failPct=3.0, maxCycles=4, fromBelowBars=0, goMemory=0)
V2 = dict(V3, useAhGain=False, window=(240, 960))
V1 = dict(V2, runnerDays=0, useFast=False, maxCycles=3, window=None)


def load(path):
    """Yahoo v8 chart JSON → bars (ET-aware times; open/high/low/close/volume)."""
    d = json.load(open(path))['chart']['result'][0]
    q = d['indicators']['quote'][0]
    out = []
    for i, t in enumerate(d['timestamp']):
        if q['close'][i] is None:
            continue
        out.append({'t': datetime.datetime.fromtimestamp(t, ET), 'o': q['open'][i], 'h': q['high'][i],
                    'l': q['low'][i], 'c': q['close'][i], 'v': q['volume'][i] or 0})
    return out


def resample(bars, minutes):
    """1m → N-minute bars aligned to the hour (TradingView's 2m bars start on even minutes)."""
    out = []
    for b in bars:
        m = b['t'].hour * 60 + b['t'].minute
        key = (b['t'].date(), m // minutes)
        if out and out[-1]['key'] == key:
            o = out[-1]
            o['h'] = max(o['h'], b['h']); o['l'] = min(o['l'], b['l']); o['c'] = b['c']; o['v'] += b['v']
        else:
            start = m // minutes * minutes
            out.append({**b, 'key': key, 't': b['t'].replace(hour=start // 60, minute=start % 60)})
    return out


def is_market(t):
    m = t.hour * 60 + t.minute
    return 570 <= m < 960


def simulate(bars, mvwap_of, params=None, start=None, end=None, trace=None):
    """Run the stage machine. mvwap_of(bar) → month VWAP or None (no signal on that bar).
    Returns fired events: (time, stage, path, close, basis, px_below %, basis_below %, day-high gain %).
    trace(dict) — optional, called on every bar with each condition (the "why didn't it fire" tool)."""
    p = {**V7, **(params or {})}
    closes, basis_hist, bbelow_hist, gains, mv_hist = [], [], [], [], []
    last_reg = prev_close = day_high = cur_day = ah_high = None
    stage = cycles = under_basis = 0
    since_setup = None   # bars since the last FORMING/READY fired today
    prev_basis = prev_mv = None
    fired = []
    for b in bars:
        t, c = b['t'], b['c']
        closes.append(c)
        basis = sum(closes[-20:]) / 20 if len(closes) >= 20 else None
        mv = mvwap_of(b)
        mv_hist.append(mv)
        new_day = cur_day != t.date()
        if new_day:
            if day_high is not None and prev_close:
                gains.append((day_high / prev_close - 1) * 100)       # gain1..3 in the script
            cur_day, prev_close, day_high, ah_high = t.date(), last_reg, b['h'], None
        else:
            day_high = max(day_high, b['h'])
        if is_market(t):
            last_reg = c
        post = t.hour >= 16
        if post:
            ah_high = b['h'] if ah_high is None else max(ah_high, b['h'])
        # after hours, "top gainer" = the move since today's close (Finviz's AH change)
        ah_gain = (ah_high / last_reg - 1) * 100 if (post and ah_high is not None and last_reg) else None
        gain = (day_high / prev_close - 1) * 100 if prev_close else None
        recent = max(gains[-p['runnerDays']:]) if p['runnerDays'] > 0 and gains else None
        gainer = ((gain is not None and gain >= p['minDayGain']) or (recent is not None and recent >= p['minDayGain'])
                  or (p['useAhGain'] and ah_gain is not None and ah_gain >= p['minDayGain']))
        valid = gainer and mv is not None and basis is not None
        px_below = (mv - c) / mv * 100 if mv and basis else None
        b_below = (mv - basis) / mv * 100 if mv and basis else None
        basis_hist.append(basis); bbelow_hist.append(b_below)
        sb = p['slopeBars']
        basis_up = len(basis_hist) > sb and basis is not None and basis_hist[-1 - sb] is not None and basis > basis_hist[-1 - sb]
        gap_closing = (len(bbelow_hist) > sb and b_below is not None and bbelow_hist[-1 - sb] is not None
                       and b_below < bbelow_hist[-1 - sb])
        holding = basis is not None and c >= basis * (1 - p['holdTol'] / 100)
        cross_up = (None not in (prev_basis, prev_mv, basis, mv)) and basis > mv and prev_basis <= prev_mv
        prev_c = closes[-2] if len(closes) > 1 else None
        k = p['goWithin']
        was_under = any(m is not None and cc <= m for cc, m in zip(closes[-1 - k:-1], mv_hist[-1 - k:-1]))
        reclaim = (mv is not None and basis is not None and basis_up and was_under
                   and c > mv * (1 + p['goAbovePct'] / 100))
        # a real bullish cross: the basis rising through the line — not the line collapsing under a
        # flat basis on one heavy red bar early in a month (AIXI 2026-10-01 09:38)
        rule = p['crossRule']
        if rule == 'rising':
            cross_up = cross_up and basis_up
        elif rule == 'rising_up':
            cross_up = cross_up and basis_up and (prev_c is None or c >= prev_c)
        elif rule == 'full':
            cross_up = cross_up and basis_up and c > mv and c >= basis
        trig = {'basis': cross_up, 'price': reclaim, 'either': cross_up or reclaim}[p['goOn']]
        if p['goNotFalling'] and prev_c is not None and c < prev_c:
            trig = False
        in_zone = valid and 0 < px_below <= p['maxPxBelow'] and basis_up and holding
        fast = (p['useFast'] and basis is not None and b_below is not None
                and c >= basis * (1 + p['fastAbove'] / 100) and b_below <= p['maxBasis'])
        if fast and p['fromBelowBars'] > 0:
            # approaching from below: no close at/above the line in the last N bars
            # (a spike that falls back to the line is not an approach)
            n = p['fromBelowBars']
            prior = list(zip(closes[-1 - n:-1], mv_hist[-1 - n:-1]))
            fast = len(prior) == n and all(m is not None and cc < m for cc, m in prior)
        base_forming = in_zone and p['readyBasis'] < b_below <= p['formBasis']
        base_ready = in_zone and 0 < b_below <= p['readyBasis']
        forming = in_zone and gap_closing and (base_forming or (fast and px_below <= p['formPx']))
        ready = in_zone and (base_ready or (fast and px_below <= p['readyPx']))
        go = valid and trig
        if new_day:
            stage = cycles = 0
            since_setup = None
        elif since_setup is not None:
            since_setup += 1
        under_basis = under_basis + 1 if (basis is not None and c < basis) else 0
        if stage > 0 and mv is not None and basis is not None and c < mv and (
                c < basis * (1 - p['failPct'] / 100) or (p['breakBars'] > 0 and under_basis >= p['breakBars'])):
            stage = 0
        recent_setup = p['goMemory'] > 0 and since_setup is not None and since_setup <= p['goMemory']
        target = 3 if (go and stage < 3 and (stage >= 1 or recent_setup)) else 2 if ready else 1 if forming else 0
        m = t.hour * 60 + t.minute
        in_window = p['window'] is None or p['window'][0] <= m < p['window'][1]
        fire = in_window and target > stage and (stage > 0 or target == 3 or cycles < p['maxCycles'])
        if fire:
            if stage == 0 and target < 3:
                cycles += 1
            if target < 3:
                since_setup = 0
            stage = target
            path = '' if target == 3 else ('base' if (base_ready if target == 2 else base_forming) else 'fast')
            fired.append((t, ['', 'FORMING', 'READY', 'GO'][target], path, c, basis, px_below, b_below, gain))
        if trace:
            trace(dict(t=t, c=c, basis=basis, mv=mv, px_below=px_below, b_below=b_below, gain=gain, recent=recent, ah_gain=ah_gain,
                       gainer=gainer, basis_up=basis_up, gap_closing=gap_closing, holding=holding, in_zone=in_zone,
                       fast=fast, forming=forming, ready=ready, go=go, in_window=in_window, stage=stage,
                       cycles=cycles, fired=fired[-1][1] if fire else ''))
        prev_basis, prev_mv = basis, mv
    return [e for e in fired if (start is None or e[0] >= start) and (end is None or e[0] <= end)]


def simulate_lines(bars, lines, params=None, start=None, end=None):
    """Script v11: the reclaim setup on several lines at once, e.g. {'month': mvwap_of, 'year': yvwap_of}
    (pass the month line first). Each line keeps its own stages — exactly simulate() per line — and the
    same stage on the same bar from both lines is one event named after both ("month+year", v14; v11–v13
    said "both") with the first line's path. Returns (time, stage, line, path, close)."""
    by_key = {}
    for name, line_of in lines.items():
        for e in simulate(bars, line_of, params, start, end):
            by_key.setdefault((e[0], e[1]), []).append((name, e))
    out = []
    for (t, stage), hits in sorted(by_key.items(), key=lambda kv: (kv[0][0], ['FORMING', 'READY', 'GO'].index(kv[0][1]))):
        name, e = hits[0]
        out.append((t, stage, '+'.join(n for n, _ in hits), e[2], e[3]))
    return out


# ── PULLBACK setup (script v10) ────────────────────────────────────────────────
# Inputs, same meaning and defaults as the script's "Pullback to VWAP (v10)" group.
PB = dict(arm=15.0,        # armed: a bar high at least % above the line (the big move)
          near=5.0,        # PULLBACK: a close back within % above the line
          brk=0.0,         # BROKEN: a close at least % under the line
          win=10.0,        # HELD: a high % above the PULLBACK close
          max_touches=0,   # the day's cap per line (pbMax); v16: 0 = none, the dashboard applies it (v15: 2)…
          cap_on='failures',  # …counts BROKEN + straight-through pullbacks (v15); 'touches' = every touch (v10–v14);
                              # 'broken' = only alerted pullbacks that BROKE (the 2026-10-07 BIYA question)
          timeout=60,      # stop watching a pullback after N bars
          window=(240, 1200),
          touch_on='close')  # replica-only study (2026-10-21): 'low' = the touch is a bar whose LOW reaches
                             # line × (1 + near%) (a wick into the zone or through the line) with the close
                             # holding at or above line × (1 − brk%); the script uses the close ('close')


class PullbackLine:
    """One line's state — the script's `PbLine` and `method step`, bar for bar."""

    def __init__(self, params=None):
        self.p = {**PB, **(params or {})}
        self.new_day()

    def new_day(self):
        self.armed, self.arm_bar, self.peak_pct, self.peak_bar = False, None, None, None
        self.touches, self.open, self.entry, self.alert_bar = 0, False, None, None
        self.fails = 0   # BROKEN + straight-through touches (cap_on='failures'; 'broken': BROKEN only)
        self.alert_fails = None   # v16: failures on the line before the last PULLBACK (the message's `fails`)

    def step(self, i, h, c, ln, can_arm=True, lo=None):
        """Bar index i, high, close, the line → 0 nothing, 1 PULLBACK, 2 BROKEN, 3 HELD.
        `lo` (the bar's low) is only read with touch_on='low'."""
        p, ev = self.p, 0
        if ln is None or ln <= 0:
            return 0
        if self.open:
            if c < ln * (1 - p['brk'] / 100):
                self.open, ev = False, 2
                self.fails += 1
            elif h >= self.entry * (1 + p['win'] / 100):
                self.open, ev = False, 3
            elif i - self.alert_bar >= p['timeout']:
                self.open = False
        if not self.open:
            stretch = (h / ln - 1) * 100
            if not self.armed:
                if can_arm and stretch >= p['arm']:
                    self.armed, self.arm_bar, self.peak_pct, self.peak_bar = True, i, stretch, i
            else:
                if stretch > self.peak_pct:       # replica-only: peak_bar (the script keeps just the %)
                    self.peak_bar = i
                self.peak_pct = max(self.peak_pct, stretch)
                reach = lo if (p['touch_on'] == 'low' and lo is not None) else c
                if i > self.arm_bar and reach <= ln * (1 + p['near'] / 100):
                    self.armed = False
                    self.touches += 1
                    through = c < ln * (1 - p['brk'] / 100)
                    allowed = (p['max_touches'] == 0
                               or (self.fails < p['max_touches'] if p['cap_on'] in ('failures', 'broken')
                                   else self.touches <= p['max_touches']))
                    if through:
                        if p['cap_on'] != 'broken':
                            self.fails += 1
                    elif ev == 0 and allowed:
                        self.open, self.entry, self.alert_bar, ev = True, c, i, 1
                        self.alert_fails = self.fails
        return ev


def simulate_pullback(bars, lines, params=None, gainer_of=None, low_lines=('month', 'year')):
    """The PULLBACK setup on several lines, e.g. {'session': svwap_of, 'month': mvwap_of, 'year': yvwap_of}
    (in that order, like the script; v14 added the year line). Each line keeps its own state; the lines
    that fire the same event on one bar are one message named after all of them ("session+month"),
    with the lowest touch number and the highest peak. gainer_of(bar) → bool (default: always a gainer).
    Returns the script's messages: (time, PULLBACK|BROKEN|HELD, line, touch, close, first line's value,
    % vs it, peak %, fails) — `fails` (v16) on PULLBACK only, the lowest of the lines named.
    v24: the lines in `low_lines` (the script's pbLowMY: month and year) touch on the bar's low, the
    close holding at or above the line; pass low_lines=() for v23 and earlier."""
    p = {**PB, **(params or {})}
    state = {name: PullbackLine({**p, 'touch_on': 'low' if name in low_lines else p['touch_on']}) for name in lines}
    out, day = [], None
    names = {1: 'PULLBACK', 2: 'BROKEN', 3: 'HELD'}
    for i, b in enumerate(bars):
        t = b['t']
        if t.date() != day:
            day = t.date()
            for st in state.values():
                st.new_day()
        m = t.hour * 60 + t.minute
        if p['window'] is not None and not (p['window'][0] <= m < p['window'][1]):
            continue
        ok = True if gainer_of is None else gainer_of(b)
        ev = {name: state[name].step(i, b['h'], b['c'], line_of(b), ok, b.get('l')) for name, line_of in lines.items()}
        for e in (1, 2, 3):
            hit = [name for name in lines if ev[name] == e]
            if not hit:
                continue
            ln = lines[hit[0]](b)
            out.append((t, names[e], '+'.join(hit), min(state[n].touches for n in hit), b['c'], ln,
                        (b['c'] / ln - 1) * 100 if ln else None,
                        max(state[n].peak_pct for n in hit) if e == 1 else None,
                        min(state[n].alert_fails for n in hit) if e == 1 else None))
    return out


def selftest_pullback():
    """Synthetic check of the PULLBACK state machine against a flat line at 1.00."""
    import datetime as dt
    t0 = dt.datetime(2026, 10, 5, 9, 30, tzinfo=ET)
    path = [1.00, 1.00, 1.20, 1.15, 1.10, 1.04,   # run +20% (armed), back within 5% → PULLBACK #1
            1.08, 1.16,                           # +11.5% from 1.04 → HELD, and re-armed (16% above; an exact
                                                  # 15% computes as 14.999…% in floating point, in Pine too)
            1.12, 1.03,                           # back within 5% → PULLBACK #2
            0.98,                                 # close under the line → BROKEN
            1.20, 0.95,                           # re-armed, then straight through: touch 3, no PULLBACK
            1.25, 1.02,                           # re-armed, back near: already 2 failures (BROKEN + through) → nothing
            1.30, 1.01]                           # still nothing (touches exhausted for the day)
    bars = [{'t': t0 + dt.timedelta(minutes=k), 'h': c, 'c': c} for k, c in enumerate(path)]
    V15 = {'max_touches': 2}
    got = [(e[1], e[3], e[4]) for e in simulate_pullback(bars, {'session': lambda b: 1.00}, V15)]
    want = [('PULLBACK', 1, 1.04), ('HELD', 1, 1.16), ('PULLBACK', 2, 1.03), ('BROKEN', 2, 0.98)]
    ok = got == want
    print('pullback state machine:', got, '→', 'OK' if ok else f'UNEXPECTED (want {want})')
    # v15: held pullbacks don't use up the cap — the third HELD-after-HELD pullback still alerts;
    # v10–v14 capped every touch, so it stopped after two.
    held3 = [1.00, 1.20, 1.04, 1.16, 1.04, 1.16, 1.04]
    hb = [{'t': t0 + dt.timedelta(minutes=k), 'h': c, 'c': c} for k, c in enumerate(held3)]
    v15 = [e[1] for e in simulate_pullback(hb, {'session': lambda b: 1.00}, V15)]
    v14 = [e[1] for e in simulate_pullback(hb, {'session': lambda b: 1.00}, {**V15, 'cap_on': 'touches'})]
    ok_cap = (v15 == ['PULLBACK', 'HELD', 'PULLBACK', 'HELD', 'PULLBACK'] and v14 == ['PULLBACK', 'HELD', 'PULLBACK', 'HELD'])
    print('cap counts failures (v15) vs touches (v14):', v15, '/', v14, '→', 'OK' if ok_cap else 'UNEXPECTED')
    # 2026-10-07 (BIYA): cap_on='broken' doesn't count a straight-through. A crash through the line,
    # then PULLBACK → HELD, PULLBACK → BROKEN, then a 4th touch: v15 has used both failures and stays
    # quiet; 'broken' has used one and alerts. (Measured and rejected: research/vwap-pullback README.)
    biya = [1.00, 1.20, 0.95, 1.20, 1.04, 1.16, 1.03, 0.98, 1.20, 1.02]
    bb = [{'t': t0 + dt.timedelta(minutes=k), 'h': c, 'c': c} for k, c in enumerate(biya)]
    f15 = [(e[1], e[3]) for e in simulate_pullback(bb, {'session': lambda b: 1.00}, V15)]
    brk = [(e[1], e[3]) for e in simulate_pullback(bb, {'session': lambda b: 1.00}, {**V15, 'cap_on': 'broken'})]
    base4 = [('PULLBACK', 2), ('HELD', 2), ('PULLBACK', 3), ('BROKEN', 3)]
    ok_brk = f15 == base4 and brk == base4 + [('PULLBACK', 4)]
    print('straight-through counts (v15) vs BROKEN only:', f15, '/', brk, '→', 'OK' if ok_brk else 'UNEXPECTED')
    # v16: the script no longer caps; the BIYA path's 4th touch alerts and says 2 failed before it
    # (the dashboard decides whether it pings).
    v16 = [(e[1], e[3], e[8]) for e in simulate_pullback(bb, {'session': lambda b: 1.00})]
    want16 = [('PULLBACK', 2, 1), ('HELD', 2, None), ('PULLBACK', 3, 1), ('BROKEN', 3, None), ('PULLBACK', 4, 2)]
    ok_v16 = v16 == want16
    print('v16 no script cap, PULLBACK carries fails:', v16, '→', 'OK' if ok_v16 else f'UNEXPECTED (want {want16})')
    flat = lambda b: 1.00
    both = simulate_pullback(bars[:6], {'session': flat, 'month': flat})
    three = simulate_pullback(bars[:6], {'session': flat, 'month': lambda b: None, 'year': flat})
    ok_both = ([(e[1], e[2]) for e in both] == [('PULLBACK', 'session+month')]
               and [(e[1], e[2]) for e in three] == [('PULLBACK', 'session+year')])
    print('same event on several lines → one message naming them:', [(e[1], e[2]) for e in both + three], '→',
          'OK' if ok_both else 'UNEXPECTED')
    # v24 trial (RBNE 10-21 04:10 ET): after a run to +25%, a bar's low tags the band (1.03) but it
    # closes 8% above the line (1.08). The month line takes it as a PULLBACK (the close holds above
    # the line); the session line, on the close rule, doesn't; v23 (low_lines=()) neither. A wick
    # through the line that closes under it stays a failed touch on the month line too.
    def lbars(path):   # (low, close) per bar
        return [{'t': t0 + dt.timedelta(minutes=k), 'h': max(lo, c), 'l': lo, 'c': c} for k, (lo, c) in enumerate(path)]
    wick = lbars([(1.00, 1.00), (1.00, 1.25), (1.18, 1.20), (1.03, 1.08), (1.07, 1.10)])
    v24 = [(e[1], e[2], e[3]) for e in simulate_pullback(wick, {'session': flat, 'month': flat})]
    v23 = [(e[1], e[2]) for e in simulate_pullback(wick, {'session': flat, 'month': flat}, low_lines=())]
    thru = [(e[1], e[2]) for e in simulate_pullback(lbars([(1.00, 1.00), (1.00, 1.25), (0.97, 0.99)]), {'month': flat})]
    ok_v24 = v24 == [('PULLBACK', 'month', 1)] and v23 == [] and thru == []
    print('v24 month/year touch on the low:', v24, '| v23:', v23, '| wick through, close under:', thru, '→',
          'OK' if ok_v24 else 'UNEXPECTED')
    return ok and ok_both and ok_cap and ok_brk and ok_v16 and ok_v24


BO = dict(length=20,       # BB length (on the chart's bars: 30s on the 30s alert)
          mult=2.0,        # BB StdDev
          touch=True,      # TOUCH: the forming 1m candle reaches the band before the minute closes
          strong_slope=0.0,   # v19: strong = the band up at least % over the last 5 candles…
          strong_off=10.0,    # …and the close at most % under the day's high
          early=True,         # v20: the early BO — the first candle of the day to reach +early_gain%,
          early_gain=10.0,    #      regular hours, closing above the band, on early_vol× its last 20
          early_vol=2.0)      #      candles' volume (needs prev_close)


def _rth(t):
    """Regular hours, 09:30–16:00 ET (Pine: session.ismarket on an Extended chart)."""
    x = t.astimezone(ET)
    return (x.hour, x.minute) >= (9, 30) and x.hour < 16


def _context(upper, ups5, close, day_high, p):
    """v19: (band slope over the last 5 finished candles %, close vs the day's high %, strong)."""
    slope = (upper / ups5[0] - 1) * 100 if len(ups5) >= 5 and ups5[0] and upper is not None else None
    off = (close / day_high - 1) * 100 if day_high else None
    strong = slope is not None and slope >= p['strong_slope'] and off is not None and off >= -p['strong_off']
    return slope, off, strong


def _bands(closes, n, mult):
    """TradingView ta.sma / ta.stdev (population) upper band per bar; None while warming up."""
    out = []
    for i in range(len(closes)):
        win = closes[max(0, i - n + 1):i + 1]
        if len(win) < n:
            out.append(None)
            continue
        m = sum(win) / n
        out.append(m + mult * max(sum(x * x for x in win) / n - m * m, 0.0) ** 0.5)
    return out


def _tick(p):
    return 0.0001 if p < 1 else 0.01


def simulate_breakout(bars, bar_sec=30, params=None, gainer_of=None, prev_close=None):
    """Mirror of the script's BB breakout on its own chart (v17; the 30s alert): the band on the
    chart's bars, 1m candles built from them. bars: dicts with t (aware datetime, bar open),
    o, h, l, c, v. Returns (t, stage, close, upper, trigger, stop, slope, off_high, strong) per signal; a bar can carry
    TRIGGERED and TOUCH/BREAKOUT only in theory (the fresh test keeps them apart).
    v18: a candle whose closing 30s bar had no trades is closed on its last bar when the next
    minute starts (no BREAKOUT for it), so the next candle's "fresh" test stays right.
    v20: with `prev_close` (the prior regular close), the early BO too; each signal tuple then
    ends with `early` (True for an early BREAKOUT and its TRIGGERED)."""
    p = dict(BO, **(params or {}))
    ups = _bands([b['c'] for b in bars], p['length'], p['mult'])
    out = []
    cmin = chigh = clow = None
    touched, done = False, True
    prev_c = prev_u = last_c = last_u = None
    arm_min = trig = stop = None
    ups5, day, day_high, armed_ctx = [], None, None, (None, None, False)
    cvol, vols20, early_done, armed_early = 0.0, [], False, False
    for b, upper in zip(bars, ups):
        ts = int(b['t'].timestamp())
        minute = ts - ts % 60
        d = b['t'].astimezone(ET).date()
        if d != day:
            early_done = False
        day_high = b['h'] if d != day else max(day_high, b['h'])
        day = d
        if cmin is None or minute != cmin:
            if not done and last_c is not None:
                prev_c, prev_u = last_c, last_u        # closed on its last bar
                ups5 = (ups5 + [last_u])[-5:]
                vols20 = (vols20 + [cvol])[-20:]
            if arm_min is not None and minute > arm_min:
                arm_min = None                       # the trigger candle passed (or had no trades)
            done = False
            cmin, chigh, clow, touched, cvol = minute, b['h'], b['l'], False, b.get('v', 0)
        else:
            chigh, clow, cvol = max(chigh, b['h']), min(clow, b['l']), cvol + b.get('v', 0)
        ends = (ts + bar_sec) % 60 == 0
        fresh = prev_c is not None and prev_u is not None and prev_c <= prev_u
        last_c, last_u = b['c'], upper
        ctx = _context(upper, ups5, b['c'], day_high, p)
        can = upper is not None and (gainer_of is None or gainer_of(b))
        evs = []
        if arm_min is not None and cmin == arm_min and b['h'] >= trig:
            arm_min = None
            if (upper is not None) if armed_early else can:   # v20: an early one skips the gainer filter
                evs.append('TRIGGERED')
        if can and p['touch'] and not touched and fresh and not ends and chigh >= upper:
            touched = True
            evs.append('TOUCH')
        is_early = False
        if ends:
            avg = sum(vols20) / len(vols20) if vols20 else 0
            vol_x = cvol / avg if avg > 0 else None
            first = not early_done and prev_close and (day_high / prev_close - 1) * 100 >= p['early_gain']
            if first:
                early_done = True
            is_early = bool(p['early'] and first and _rth(b['t']) and upper is not None and b['c'] > upper
                            and vol_x is not None and vol_x >= p['early_vol'])
            if is_early or (can and fresh and b['c'] > upper):
                arm_min, trig, stop, armed_ctx, armed_early = cmin + 60, chigh + _tick(chigh), clow, ctx, is_early
                evs.append('BREAKOUT')
            prev_c, prev_u, done = b['c'], upper, True
            ups5 = (ups5 + [upper])[-5:]
            vols20 = (vols20 + [cvol])[-20:]
        for ev in evs:
            c3 = armed_ctx if ev == 'TRIGGERED' else ctx
            flag = armed_early if ev == 'TRIGGERED' else is_early if ev == 'BREAKOUT' else False
            out.append((b['t'], ev, b['c'], upper, trig if ev != 'TOUCH' else None, stop if ev != 'TOUCH' else None) + c3 + (flag,))
    return out


def simulate_breakout_1m(bars30, params=None, gainer_of=None, prev_close=None):
    """Mirror of the script's v18 1m-chart path: the band on the 30s bars, read inside each 1m bar
    (request.security_lower_tf). TOUCH = a 30s bar before the candle's last whose candle high so
    far reaches its band; BREAKOUT = the 1m close above the band at the last 30s bar; TRIGGERED =
    the next 1m bar's high at or over the trigger. Same returns as simulate_breakout, stamped with
    the 1m bar's open."""
    p = dict(BO, **(params or {}))
    ups = _bands([b['c'] for b in bars30], p['length'], p['mult'])
    minutes = {}
    for b, u in zip(bars30, ups):
        ts = int(b['t'].timestamp())
        minutes.setdefault(ts - ts % 60, []).append((b, u))
    out = []
    prev_c = prev_u = None
    arm_min = trig = stop = None
    ups5, day, day_high, armed_ctx = [], None, None, (None, None, False)
    vols20, early_done, armed_early = [], False, False
    for mts in sorted(minutes):
        inner = minutes[mts]
        b0 = inner[0][0]
        h, lo, c = max(x[0]['h'] for x in inner), min(x[0]['l'] for x in inner), inner[-1][0]['c']
        upper = inner[-1][1]
        cvol = sum(x[0].get('v', 0) for x in inner)
        d = b0['t'].astimezone(ET).date()
        if d != day:
            early_done = False
        day_high = h if d != day else max(day_high, h)
        day = d
        ctx = _context(upper, ups5, c, day_high, p)
        if arm_min is not None and mts > arm_min:
            arm_min = None
        fresh = prev_c is not None and prev_u is not None and prev_c <= prev_u
        can = upper is not None and (gainer_of is None or gainer_of(b0))
        run_hi, in_touch = None, False
        for x, u in inner[:-1]:
            run_hi = x['h'] if run_hi is None else max(run_hi, x['h'])
            if not in_touch and u is not None and run_hi >= u:
                in_touch = True
        evs = []
        if arm_min is not None and mts == arm_min and h >= trig:
            arm_min = None
            if (upper is not None) if armed_early else can:
                evs.append('TRIGGERED')
        if can and p['touch'] and fresh and in_touch:
            evs.append('TOUCH')
        avg = sum(vols20) / len(vols20) if vols20 else 0
        vol_x = cvol / avg if avg > 0 else None
        first = not early_done and prev_close and (day_high / prev_close - 1) * 100 >= p['early_gain']
        if first:
            early_done = True
        is_early = bool(p['early'] and first and _rth(b0['t']) and upper is not None and c > upper
                        and vol_x is not None and vol_x >= p['early_vol'])
        if is_early or (can and fresh and c > upper):
            arm_min, trig, stop, armed_ctx, armed_early = mts + 60, h + _tick(h), lo, ctx, is_early
            evs.append('BREAKOUT')
        prev_c, prev_u = c, upper
        ups5 = (ups5 + [upper])[-5:]
        vols20 = (vols20 + [cvol])[-20:]
        for ev in evs:
            c3 = armed_ctx if ev == 'TRIGGERED' else ctx
            flag = armed_early if ev == 'TRIGGERED' else is_early if ev == 'BREAKOUT' else False
            out.append((b0['t'], ev, c, upper, trig if ev != 'TOUCH' else None, stop if ev != 'TOUCH' else None) + c3 + (flag,))
    return out


def selftest_breakout():
    """Synthetic 30s bars: a flat base, then a 1m candle that touches the band at the half-minute
    and closes above it (TOUCH, BREAKOUT), a next candle over its high (TRIGGERED), then a candle
    above the band right after the breakout (not a fresh one: nothing). A second path: a breakout
    whose next candle stalls under the trigger (no TRIGGERED). v18: a 1m chart reading the 30s bars
    marks the same minutes as the 30s alert sends (random walks), and a minute whose closing 30s
    bar is missing no longer leaves the next candle's "fresh" test stale."""
    import datetime as dt
    import random
    t0 = dt.datetime(2026, 10, 16, 9, 30, tzinfo=ET)
    def bars_of(path, skip=()):   # (high, low, close) per 30s bar; `skip` = bar indexes with no trades
        return [{'t': t0 + dt.timedelta(seconds=30 * k), 'o': c, 'h': h, 'l': lo, 'c': c, 'v': 100}
                for k, (h, lo, c) in enumerate(path) if k not in skip]
    base = [(1.001, 0.999, 1.0) if k % 2 else (1.0, 0.998, 0.999) for k in range(30)]
    run = [(1.03, 1.0, 1.02), (1.05, 1.02, 1.045),     # 09:45: touches at :00 (seen at :30), closes above → TOUCH, BREAKOUT
           (1.06, 1.045, 1.055), (1.07, 1.05, 1.06),   # 09:46: at the 1.06 trigger (1.05 + a $0.01 tick) in its first half → TRIGGERED
           (1.08, 1.06, 1.075), (1.09, 1.07, 1.085)]   # 09:47: above the band again, not fresh → nothing
    events = simulate_breakout(bars_of(base + run))
    got = [(e[0].strftime('%H:%M:%S'), e[1]) for e in events]
    want = [('09:45:00', 'TOUCH'), ('09:45:30', 'BREAKOUT'), ('09:46:00', 'TRIGGERED')]
    bo = [e for e in events if e[1] == 'BREAKOUT']
    ok_levels = bool(bo) and abs(bo[0][4] - 1.06) < 1e-9 and bo[0][5] == 1.0
    stall = [(1.0005, 0.999, 1.0), (1.05, 1.0, 1.045),          # 09:45: no touch in its first half, closes above → BREAKOUT
             (1.04, 1.03, 1.035), (1.055, 1.03, 1.04)]           # 09:46: never reaches 1.06 → no TRIGGERED
    got2 = [e[1] for e in simulate_breakout(bars_of(base + stall))]
    ok = got == want and ok_levels and got2 == ['BREAKOUT']
    print('BB breakout (v17):', got, '| trigger/stop', 'OK' if ok_levels else 'WRONG', '| stalled:', got2, '→',
          'OK' if ok else f'UNEXPECTED (want {want} and [BREAKOUT])')

    # v18: the 1m chart's marks = the 30s alert's signals, minute for minute, on random walks
    # with breakouts (every 30s bar present).
    def minute_set(evs):   # v19: BREAKOUT / TRIGGERED also agree on strong vs weak (TOUCH is judged mid-candle on 30s)
        return sorted({(int(e[0].timestamp()) // 60, e[1], e[8] if e[1] != 'TOUCH' else None) for e in evs}, key=str)
    random.seed(7)
    mismatches, total = 0, 0
    for trial in range(40):
        px, path = 1.0, []
        for k in range(400):
            px *= 1 + random.gauss(0, 0.004) + (0.03 if random.random() < 0.02 else 0.0)
            hi, lo = px * (1 + abs(random.gauss(0, 0.004))), px * (1 - abs(random.gauss(0, 0.004)))
            path.append((hi, lo, px))
        a = minute_set(simulate_breakout(bars_of(path)))
        b = minute_set(simulate_breakout_1m(bars_of(path)))
        total += len(a)
        mismatches += a != b
    ok_1m = mismatches == 0 and total > 100
    print(f'v18 1m chart marks what the 30s alert sends: {total} signals on 40 random paths, {mismatches} paths differ →',
          'OK' if ok_1m else 'UNEXPECTED')

    # v18: a closed-above candle (09:45), then 09:46 with only its first 30s bar (back under the
    # band), then 09:47 closing above → a fresh BREAKOUT. v17 kept 09:45 as the last close and missed it.
    gap = base + [(1.03, 1.0, 1.02), (1.05, 1.02, 1.045),       # 09:45 BREAKOUT
                  (1.01, 0.99, 1.0), (0, 0, 0),                  # 09:46: first half only (index 33 skipped)
                  (1.02, 1.0, 1.01), (1.08, 1.01, 1.075)]        # 09:47: closes above the band
    got3 = [(e[0].strftime('%H:%M:%S'), e[1]) for e in simulate_breakout(bars_of(gap, skip={33})) if e[1] == 'BREAKOUT']
    ok_gap = got3 == [('09:45:30', 'BREAKOUT'), ('09:47:30', 'BREAKOUT')]
    print('v18 a candle with no closing 30s bar is closed on its last bar:', got3, '→', 'OK' if ok_gap else 'UNEXPECTED')

    # v19: the 09:45 breakout out of a flat base at the day's high is strong; a bounce into a band
    # still falling from a spike, well under the day's high, is weak (XLAB 19:30 on 10-16).
    strong_bo = [e for e in events if e[1] == 'BREAKOUT']
    fade = [(1.455 - 0.00625 * k, 1.445 - 0.00625 * k, 1.45 - 0.00625 * k) for k in range(24)]   # 12 min down from the spike
    flat = [(1.302, 1.298, 1.30) if k % 2 else (1.301, 1.297, 1.299) for k in range(8)]
    spike = base + [(1.6, 1.0, 1.5), (1.6, 1.4, 1.45)] + fade + flat + [(1.31, 1.30, 1.305), (1.42, 1.30, 1.40)]
    weak_bo = [e for e in simulate_breakout(bars_of(spike)) if e[1] == 'BREAKOUT']
    ok_ctx = (bool(strong_bo) and strong_bo[0][8] is True and strong_bo[0][6] >= 0 and strong_bo[0][7] > -10
              and bool(weak_bo) and weak_bo[-1][8] is False and (weak_bo[-1][6] < 0 or weak_bo[-1][7] < -10))
    print('v19 strong / weak:', [(e[0].strftime('%H:%M:%S'), round(e[6], 1), round(e[7], 1), e[8]) for e in strong_bo + weak_bo[-1:]],
          '→', 'OK' if ok_ctx else 'UNEXPECTED')

    # v20: the early BO. A flat base at +5% (prior close 0.95), then a candle whose day high
    # reaches +10.5% on 3× volume, closing above the band, in regular hours: early BREAKOUT and
    # TRIGGERED even though the +20% gainer filter says no. Flat volume, or the same path in the
    # pre-market: nothing. Both paths agree.
    def vbars(path, start, vols):
        return [{'t': start + dt.timedelta(seconds=30 * k), 'o': c, 'h': hh, 'l': lo, 'c': c, 'v': vv}
                for k, ((hh, lo, c), vv) in enumerate(zip(path, vols))]
    epath = base + run[:4]
    hot_vol = [100] * len(base) + [300, 300, 150, 150]
    no_gainer = lambda b: False
    rth_bars = vbars(epath, t0, hot_vol)
    got_e = [(e[0].strftime('%H:%M:%S'), e[1], e[9]) for e in simulate_breakout(rth_bars, gainer_of=no_gainer, prev_close=0.95)]
    got_e1m = [(e[1], e[9]) for e in simulate_breakout_1m(rth_bars, gainer_of=no_gainer, prev_close=0.95) if e[1] != 'TOUCH']
    flat = [e[1] for e in simulate_breakout(vbars(epath, t0, [100] * len(epath)), gainer_of=no_gainer, prev_close=0.95)]
    pre = [e[1] for e in simulate_breakout(vbars(epath, t0.replace(hour=6), hot_vol), gainer_of=no_gainer, prev_close=0.95)]
    ok_early = (got_e == [('09:45:30', 'BREAKOUT', True), ('09:46:00', 'TRIGGERED', True)]
                and got_e1m == [('BREAKOUT', True), ('TRIGGERED', True)] and flat == [] and pre == [])
    print('v20 early BO:', got_e, '| 1m chart', got_e1m, '| flat volume', flat, '| pre-market', pre, '→',
          'OK' if ok_early else 'UNEXPECTED')
    return ok and ok_1m and ok_gap and ok_ctx and ok_early


# ── VWAP + BB cross (script v21) ───────────────────────────────────────────────
# Inputs, same meaning and defaults as the script's "VWAP + BB cross (v21)" group.
VB = dict(candle_min=5,       # vbCandleTf: the candle's timeframe, minutes (the chart traded; its session VWAP)
          bb_min=2,           # vbBbTf: the band's timeframe, minutes
          length=20, mult=2.0,
          tol=0.0,            # vbTol: the candle may open up to % above the lower line (0 = under both; v28 default 0)
          window=(240, 1200),  # alertWin in ET minutes [04:00, 20:00); None = always
          lines=('session', 'month', 'year'),   # v22: vbSession / vbMonth / vbYear
          vwap='30s',         # v28 vwSrc: today's part of the lines from the alert's bars ('30s') or the candles ('chart')
          mv='30s',           # v31 mvSrc: the month line's today from the alert's bars ('30s') or per `vwap` ('chart')
          rt=True,            # v28 vbRtOn: the retest after the VB candle
          rt_cancel=True,     # vbRtCancel: a candle closing under the lowest crossed line cancels it (v26 rule)
          rt_near=1.0,        # vbRtNear: price back within % above the line (0 = to it or under it)
          rt_wait=6,          # vbRtWait: within N candles of the VB candle's close (0 = until cancelled)
          rt_when='close',    # v30 vbRtWhen: 'close' = at the close of the candle that came back, if above the line; 'bounce' = v28
          bar_sec=30)         # the bars' length: a bar ending at or after the candle's end closes it (time_close == time_close(tf))


def _bucket(t, minutes):
    """The bar of `minutes` holding t, aligned to the 04:00 ET session start like
    timeframe.change(tf) on an Extended chart (2m: even minutes; 45m: 04:00, 04:45, …)."""
    x = t.astimezone(ET)
    anchor = x.replace(hour=4, minute=0, second=0, microsecond=0)
    return anchor + datetime.timedelta(minutes=minutes * int((x - anchor).total_seconds() // (minutes * 60)))


def simulate_vb_cross(bars, params=None, gainer_of=None, trace=None, before_of=None, retests=None):
    """Mirror of the script's vbStep() (v21; v22 lines) on the alert's bars (30s; a 1m replay
    works too): candles of p['candle_min'], the upper band of the p['bb_min'] closes (the forming
    one live), and per line — session, month, year (p['lines']) — CROSS at the first bar close
    inside a candle whose open is at or under the higher of the line and the band and at most
    p['tol'] % over the lower one, with the close above both — the line and the band as they
    stand at that close (v23; v21/v22 took them at the close before the candle and skipped a
    line's first candle). Once per candle and line. The session line is the candles' own VWAP
    (hlc3 × volume, the forming one live) with p['vwap'] 'chart', or (v28 '30s', the default) the
    alert's own bars' (hlc3 × volume of every bar). The month and year lines add `before_of(bar)` →
    {'month': (pv, v), 'year': (pv, v)}: the sums up to the start of the bar's day (the script's
    hourly vbAnchors()); without it they stay off. bars: dicts with t (aware datetime, bar open),
    o, h, l, c, v. Returns (t, close, {line: vwap}, upper, candle_open, vol_x, names, n) per
    CROSS message — names like 'session+month', n the lowest daily count of those lines;
    `trace` (a list) collects (t, {line: vwap}, upper) per bar.
    v28: `retests` (a list) collects (t, close, stop, names, retest n) — the RETEST: armed when a VB
    candle closes (a newer one replaces it), then a bar whose low comes within p['rt_near'] % above
    the highest line the candle crossed (or under it), then the first bar from there that closes
    above that line and above its open; stop = a tick under the lowest low since the VB candle
    closed. A candle closing under the lowest crossed line cancels it (p['rt_cancel'], the v26
    rule, the VB candle's own close included), so do p['rt_wait'] candles and a new day — except (v29)
    with candles of 4h or longer (p['candle_min'] >= 240), where a retest of the month / year lines
    carries over the day's end (a VB candle closing at 20:00 arms it on the next day's first bar).
    v29's lanes are separate calls with their own candle_min / bb_min / lines.
    v30 (p['rt_when'] 'close', the default): no bounce test; at the close of a candle after the touch
    (judged on its last bar), a close above the line fires the RETEST at that bar, price = that close.
    v31: a RETEST judged on the next bar (the candle's closing bar was missing) carries late=True, the
    6th field; the script draws it one bar back. p['mv'] picks the month line's today's part."""
    p = dict(VB, **(params or {}))
    n_len = p['length']
    lines = ('session', 'month', 'year')
    out = []
    closes, last_c, last_bb, day = [], None, None, None
    pv = v = 0.0
    c_key = c_open = c_high = c_low = c_close = None
    c_vol = 0.0
    fired = dict.fromkeys(lines, False)
    count = dict.fromkeys(lines, 0)
    vols = []
    rt, rt_n = None, 0
    carry = p['candle_min'] >= 240   # v29
    pv30 = v30 = 0.0   # v28: today's Σ hlc3 × volume and Σ volume over the bars
    prev_vw = {}    # v26: the last bar's lines (where they stood at the candle's close)
    prev_t = prev_in_win = None   # v30: the last bar's time and window (a candle's closing bar)
    end_seen = False              # v30: the forming candle's closing bar has been judged
    for b in bars:
        x = b['t'].astimezone(ET)
        new_day = x.date() != day
        day = x.date()
        bb_key = _bucket(b['t'], p['bb_min'])
        if last_bb is not None and bb_key != last_bb and last_c is not None:
            closes = (closes + [last_c])[-(n_len - 1):]
        last_bb, last_c = bb_key, b['c']
        upper = None
        if len(closes) == n_len - 1:
            win = closes + [b['c']]
            m = sum(win) / n_len
            upper = m + p['mult'] * (sum((y - m) ** 2 for y in win) / n_len) ** 0.5
        key = _bucket(b['t'], p['candle_min'])
        if new_day or key != c_key or c_open is None:
            # v30: a candle whose closing bar was missing, judged on its last bar (30 s late, like the script)
            if p['rt_when'] == 'close' and rt and rt['armed'] and rt['touched'] and not end_seen and c_open is not None:
                lns = [prev_vw[ln] for ln in rt['lines'] if prev_vw.get(ln) is not None]
                if lns and c_close > max(lns) and prev_in_win:
                    rt['armed'], rt_n = False, rt_n + 1
                    if retests is not None:
                        retests.append((b['t'], c_close, rt['low'] - _tick(rt['low']), '+'.join(rt['lines']), rt_n, True))
            end_seen = False
            if new_day:
                rt_n = 0
                if rt and rt['armed'] and ('session' in rt['lines'] or not carry):
                    rt['armed'] = False
            if (p['rt'] and c_open is not None and any(fired.values())
                    and not (new_day and (fired['session'] or not carry))):   # the VB candle closed
                rt = dict(lines=[ln for ln in lines if fired[ln]], armed=True, touched=False, low=None, age=0)
            elif rt and rt['armed'] and c_open is not None:
                rt['age'] += 1
            # v26: that candle (the VB candle or a later one) closed under the lowest crossed line
            if p['rt_cancel'] and rt and rt['armed'] and c_open is not None:
                at_close = [prev_vw[ln] for ln in rt['lines'] if prev_vw.get(ln) is not None]
                if at_close and c_close < min(at_close):
                    rt['armed'] = False
            if rt and rt['armed'] and p['rt_wait'] > 0 and rt['age'] >= p['rt_wait']:
                rt['armed'] = False
            if c_open is not None:
                vols = (vols + [c_vol])[-20:]
            if new_day:
                pv = v = 0.0
                count = dict.fromkeys(lines, 0)
            elif c_open is not None:
                pv += (c_high + c_low + c_close) / 3 * c_vol
                v += c_vol
            c_key, c_open, c_high, c_low, c_vol = key, b['o'], b['h'], b['l'], b.get('v', 0)
            fired = dict.fromkeys(lines, False)
        else:
            c_high, c_low, c_vol = max(c_high, b['h']), min(c_low, b['l']), c_vol + b.get('v', 0)
        c_close = b['c']
        if new_day:
            pv30 = v30 = 0.0
        pv30 += (b['h'] + b['l'] + b['c']) / 3 * b.get('v', 0)
        v30 += b.get('v', 0)
        if p['vwap'] == '30s':
            tpv, tv = pv30, v30
        else:
            tpv, tv = pv + (c_high + c_low + b['c']) / 3 * c_vol, v + c_vol     # today, the forming candle included
        vw = {'session': tpv / tv if tv > 0 else None}
        bef = before_of(b) if before_of else None
        for ln in ('month', 'year'):
            sums = bef.get(ln) if bef else None
            lpv, lv = (pv30, v30) if ln == 'month' and p['mv'] == '30s' else (tpv, tv)   # v31
            vw[ln] = (sums[0] + lpv) / (sums[1] + lv) if sums is not None and sums[1] + lv > 0 else None
        avg = sum(vols) / len(vols) if vols else None
        vol_x = c_vol / avg if avg else None
        m_et = x.hour * 60 + x.minute
        ok = ((p['window'] is None or p['window'][0] <= m_et < p['window'][1]) and (gainer_of is None or gainer_of(b))
              and upper is not None)
        fires = []
        for ln in lines:
            if not ok or ln not in p['lines'] or fired[ln] or vw[ln] is None:
                continue
            hi, lo = max(vw[ln], upper), min(vw[ln], upper)
            if c_open <= hi and c_open <= lo * (1 + p['tol'] / 100) and b['c'] > vw[ln] and b['c'] > upper:
                fired[ln] = True
                count[ln] += 1
                fires.append(ln)
        if fires:
            out.append((b['t'], b['c'], dict(vw), upper, c_open, vol_x, '+'.join(fires), min(count[ln] for ln in fires)))
        in_win = p['window'] is None or p['window'][0] <= m_et < p['window'][1]
        if rt and rt['armed']:
            lns = [vw[ln] for ln in rt['lines'] if vw[ln] is not None]
            line = max(lns) if lns else None
            rt['low'] = b['l'] if rt['low'] is None else min(rt['low'], b['l'])
            if not rt['touched'] and line is not None and b['l'] <= line * (1 + p['rt_near'] / 100):
                rt['touched'] = True
            c_end = min(key + datetime.timedelta(minutes=p['candle_min']), x.replace(hour=20, minute=0, second=0, microsecond=0))
            ends_now = b['t'].astimezone(ET) + datetime.timedelta(seconds=p['bar_sec']) >= c_end
            go = (ends_now and b['c'] > line) if p['rt_when'] == 'close' and line is not None else (
                line is not None and b['c'] > line and b['c'] > b['o'])
            if rt['touched'] and in_win and line is not None and go:
                rt['armed'], rt_n = False, rt_n + 1
                if retests is not None:
                    retests.append((b['t'], b['c'], rt['low'] - _tick(rt['low']), '+'.join(rt['lines']), rt_n, False))
        c_end_b = min(key + datetime.timedelta(minutes=p['candle_min']), x.replace(hour=20, minute=0, second=0, microsecond=0))
        if b['t'].astimezone(ET) + datetime.timedelta(seconds=p['bar_sec']) >= c_end_b:
            end_seen = True
        prev_vw = dict(vw)
        prev_t, prev_in_win = b['t'], in_win
        if trace is not None:
            trace.append((b['t'], dict(vw), upper))
    return out


def selftest_vb():
    """Synthetic 30s bars for the v21 VWAP + BB cross. Day 1: a heavy spike to 1.20 leaves the
    VWAP high above a flat 1.00 base; a 5m candle out of the base crosses both lines (CROSS #1),
    rides on (nothing more in that candle), falls back; the next candle crosses again (#2); one
    opening above both lines never counts. Day 2: a candle opening 1% over the VWAP and under
    the band counts with the 2% tolerance, not with 0. Day 3 (v23): the day's first candle counts —
    a WHLR-like 04:00 gap-and-go crosses the VWAP and band it drags up over its open.
    No gainer → nothing. And the arithmetic: the live band equals a BB on the 2m closes at every
    2m close, and the live VWAP equals the 5m candles' VWAP at every 5m close (random walks)."""
    import datetime as dt
    import random
    d1 = dt.datetime(2026, 10, 16, 4, 0, tzinfo=ET)

    def bars_of(start, path, vols=None):   # path: closes (o = h = l = c) or (o, h, l, c) tuples
        out = []
        for k, q in enumerate(path):
            o, h, lo, c = (q, q, q, q) if isinstance(q, float) else q
            out.append({'t': start + dt.timedelta(seconds=30 * k), 'o': o, 'h': h, 'l': lo, 'c': c,
                        'v': vols[k] if vols else 100})
        return out

    spike = [1.20] * 20                                  # 04:00–04:10, heavy volume
    base = [1.000 if k % 2 else 1.001 for k in range(80)]   # 04:10–04:50
    cross1 = [1.00, 1.05, 1.10, 1.15, 1.18, 1.12, 1.06, 1.03, 1.01, 1.00]   # 04:50 candle: CROSS at 04:51:30
    cross2 = [1.00, 1.10, 1.20, 1.30, 1.40, 1.40, 1.40, 1.40, 1.40, 1.40]   # 04:55 candle: CROSS again
    above = [1.40, 1.45, 1.50, 1.55, 1.60, 1.60, 1.60, 1.60, 1.60, 1.60]    # 05:00 candle: opened above both
    path1 = spike + base + cross1 + cross2 + above
    day1 = bars_of(d1, path1, [1000] * 20 + [100] * (len(path1) - 20))
    CHART = dict(vwap='chart', mv='chart', tol=2.0)   # what these were written for: v21–v27's candle VWAP, 2% tolerance
    got = [(e[0].strftime('%H:%M:%S'), e[7]) for e in simulate_vb_cross(day1, params=CHART)]
    ok1 = len(got) == 2 and got[0] == ('04:51:30', 1) and got[1][1] == 2 and '04:55:00' <= got[1][0] < '05:00:00'
    print('v21 VWAP + BB cross, day 1:', got, '→', 'OK' if ok1 else 'UNEXPECTED (want 04:51:30 #1, then #2 in the 04:55 candle)')
    # v28 RETEST. Day 1: the 04:50 VB candle closes at 1.00, under the VWAP (~1.14): its own close
    # cancels it. The 04:55 one closes 1.40 and price never comes back near the line: no retest.
    rts = []
    simulate_vb_cross(day1, params=CHART, retests=rts)
    # A base at ~1.0005, the 04:40 VB candle runs to 1.10; the 04:45 candle pulls back: a 30s bar
    # dips to 1.00 and closes 1.005, under the line (a wick on the 5m chart: not a cancel), then a
    # bar opens 1.005 and closes green at 1.035, above it → RETEST at 04:46:00, stop a tick under
    # the 1.00 low.
    d4 = d1 + dt.timedelta(days=3)
    base4 = [1.000 if k % 2 else 1.001 for k in range(80)]                      # 04:00–04:40
    vb4 = [1.00, 1.04, 1.08, 1.10, 1.10, 1.10, 1.10, 1.10, 1.10, 1.10]           # the 04:40 VB candle
    pull = [(1.10, 1.10, 1.06, 1.06), (1.06, 1.06, 1.00, 1.005), (1.005, 1.04, 1.005, 1.035)] + [(1.035, 1.04, 1.03, 1.04)] * 7
    day4 = bars_of(d4, base4 + vb4) + bars_of(d4 + dt.timedelta(minutes=45), pull)
    r30, rch = [], []
    simulate_vb_cross(day4, params=dict(rt_when='bounce'), retests=r30)
    simulate_vb_cross(day4, params=dict(vwap='chart', rt_when='bounce'), retests=rch)
    got30 = [(e[0].strftime('%H:%M:%S'), e[1], round(e[2], 4), e[3], e[4]) for e in r30]
    ok_rt = (rts == [] and got30 == [('04:46:00', 1.035, 0.99, 'session', 1)]
             and [(e[0].strftime('%H:%M:%S'), e[4]) for e in rch] == [('04:46:00', 1)])
    print('v28 RETEST:', got30, '| day 1 (cancelled / never back):', rts, '→', 'OK' if ok_rt else 'UNEXPECTED')
    # The same pullback a candle later with vbRtWait 1 → too late; 0 → no limit. And a 04:45 candle
    # that closes under the line (1.00) cancels it before a bounce in the next candle.
    late = bars_of(d4, base4 + vb4 + [1.10] * 10) + bars_of(d4 + dt.timedelta(minutes=50), pull)
    w1, w0 = [], []
    simulate_vb_cross(late, params=dict(rt_wait=1, rt_when='bounce'), retests=w1)
    simulate_vb_cross(late, params=dict(rt_wait=0, rt_when='bounce'), retests=w0)
    under = bars_of(d4, base4 + vb4 + [1.06, 1.03, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00]) \
        + bars_of(d4 + dt.timedelta(minutes=50), [(1.00, 1.04, 1.00, 1.035)] * 3)
    cx = []
    simulate_vb_cross(under, params=dict(rt_when='bounce'), retests=cx)
    ok_rt2 = w1 == [] and [e[0].strftime('%H:%M:%S') for e in w0] == ['04:51:00'] and cx == []
    print('v28 RETEST wait / cancel:', '| wait 1:', w1, '| no limit:', [e[0].strftime('%H:%M:%S') for e in w0],
          '| a candle closing under the line:', cx, '→', 'OK' if ok_rt2 else 'UNEXPECTED')
    # v28 '30s': the session line is the bars' own VWAP at every bar (random walk).
    random.seed(28)
    px, path, vols = 2.0, [], []
    for k in range(300):
        o = px
        px *= 1 + random.gauss(0, 0.003)
        path.append((o, max(o, px) * 1.001, min(o, px) * 0.999, px))
        vols.append(random.randint(50, 5000))
    walk = bars_of(d1, path, vols)
    trw = []
    simulate_vb_cross(walk, trace=trw)
    worst30, cpv, cv = 0.0, 0.0, 0.0
    for b, (_, vws, _) in zip(walk, trw):
        cpv += (b['h'] + b['l'] + b['c']) / 3 * b['v']
        cv += b['v']
        worst30 = max(worst30, abs(vws['session'] - cpv / cv))
    ok_30 = worst30 < 1e-9
    print(f'v28 30s-bar session VWAP vs the bars\' VWAP, worst {worst30:.1e} →', 'OK' if ok_30 else 'UNEXPECTED')
    # v29: 4h candles on the month line. Day A: a flat 1.00 from 12:00, then the 16:00 candle runs to
    # 1.10 over a month line held at ~1.02 by earlier days → CROSS (month); it closes 1.10 at 20:00.
    # Day B 04:00: a dip to 1.025 (within 1% of the line), then a green 30s close at 1.045 → RETEST
    # at 04:01:00, carried over the night. The same day on the session line: no carry, no RETEST.
    dA = dt.datetime(2026, 10, 27, 12, 0, tzinfo=ET)
    flatA = [1.000 if k % 2 else 1.001 for k in range(480)]                     # 12:00–16:00
    runA = [1.00, 1.05, 1.10] + [1.10] * 477                                     # 16:00–20:00
    dayA = bars_of(dA, flatA + runA)
    dayB = bars_of(dA.replace(day=28, hour=4), [(1.08, 1.08, 1.08, 1.08), (1.06, 1.06, 1.025, 1.03),
                                                 (1.03, 1.05, 1.03, 1.045)] + [(1.045, 1.05, 1.04, 1.05)] * 7)
    month = {'month': (1.02 * 1_000_000, 1_000_000.0)}
    H4 = dict(candle_min=240, bb_min=10, lines=('month',), rt_when='bounce')
    cr4, rt4, rtS = [], [], []
    cr4 = [(e[0].strftime('%m-%d %H:%M:%S'), e[6]) for e in simulate_vb_cross(dayA + dayB, params=H4, before_of=lambda b: month, retests=rt4)]
    simulate_vb_cross(dayA + dayB, params=dict(H4, lines=('session',)), retests=rtS)
    got4 = [(e[0].strftime('%m-%d %H:%M:%S'), round(e[2], 4), e[3]) for e in rt4]
    ok_4h = cr4 == [('10-27 16:00:30', 'month')] and got4 == [('10-28 04:01:00', 1.015, 'month')] and rtS == []
    print('v29 4h month-line retest carries overnight:', cr4, got4, '| session line:', rtS, '→', 'OK' if ok_4h else 'UNEXPECTED')
    # v30, at the candle's close: day4's 04:45 candle came back (the 1.00 dip) and closes 1.04 above
    # the line → RETEST at its closing bar 04:49:30, price 1.04, the same stop. CLPT 10-29: a 30s bounce
    # mid-candle (bounce mode fires there), then the candle closes 1.00 under the line → no RETEST.
    c30 = []
    simulate_vb_cross(day4, retests=c30)
    got_c = [(e[0].strftime('%H:%M:%S'), e[1], round(e[2], 4)) for e in c30]
    clpt = bars_of(d4, base4 + vb4) + bars_of(d4 + dt.timedelta(minutes=45),
                                               [(1.10, 1.10, 1.00, 1.005), (1.005, 1.04, 1.005, 1.035)] + [(1.035, 1.035, 0.99, 1.00)] * 8)
    cl_close, cl_bounce = [], []
    simulate_vb_cross(clpt, retests=cl_close)
    simulate_vb_cross(clpt, params=dict(rt_when='bounce'), retests=cl_bounce)
    ok_c = (got_c == [('04:49:30', 1.04, 0.99)] and cl_close == []
            and [e[0].strftime('%H:%M:%S') for e in cl_bounce] == ['04:45:30'])
    print('v30 RETEST at the candle close:', got_c, '| CLPT-like (bounce, then a close under):', cl_close,
          '| bounce mode fired at', [e[0].strftime('%H:%M:%S') for e in cl_bounce], '→', 'OK' if ok_c else 'UNEXPECTED')
    # v31: day4's 04:45 candle with its closing bar (04:49:30) missing → the RETEST is judged on the
    # next candle's first bar (04:50:00), flagged late (the script draws it one bar back); and with
    # vwap 'chart' + mv '30s' the month line takes today's part from the bars, the session from candles.
    gap4 = bars_of(d4, base4 + vb4) + bars_of(d4 + dt.timedelta(minutes=45), pull[:9]) \
        + bars_of(d4 + dt.timedelta(minutes=50), [(1.04, 1.05, 1.04, 1.05)])
    lt = []
    simulate_vb_cross(gap4, retests=lt)
    got_lt = [(e[0].strftime('%H:%M:%S'), e[1], e[5]) for e in lt]
    on_time = [e[5] for e in c30]
    trm = []
    simulate_vb_cross(day4, params=dict(vwap='chart', mv='30s'), before_of=lambda b: month, trace=trm)
    _, vwl, _ = trm[-1]
    cpv = sum((b['h'] + b['l'] + b['c']) / 3 * b['v'] for b in day4)
    cvv = sum(b['v'] for b in day4)
    ok_31 = (got_lt == [('04:50:00', 1.04, True)] and on_time == [False]
             and abs(vwl['month'] - (month['month'][0] + cpv) / (month['month'][1] + cvv)) < 1e-12)
    print('v31 a late RETEST is flagged:', got_lt, '| on time:', on_time, '| month line from the bars with vwap chart:',
          'OK' if ok_31 else 'UNEXPECTED')
    ok_lv = ok_rt and ok_rt2 and ok_30 and ok_4h and ok_c and ok_31

    # Day 2: 2m closes alternating 0.97 / 1.01 → VWAP ≈ 0.99, band ≈ 1.03. A candle opening at
    # 1.00 (1% over the VWAP, under the band) and running to 1.10.
    d2 = d1 + dt.timedelta(days=1)
    chop = [(0.97 if (k // 4) % 2 == 0 else 1.01) for k in range(120)]          # 04:00–05:00
    run = [1.00, 1.02, 1.04, 1.06, 1.08, 1.10, 1.10, 1.10, 1.10, 1.10]         # the 05:00 candle
    day2 = bars_of(d2, [(c, c, c, c) for c in chop] + [(c, c, c, c) for c in run])
    tol2 = [e[0].strftime('%H:%M:%S') for e in simulate_vb_cross(day2, CHART)]
    tol0 = [e[0].strftime('%H:%M:%S') for e in simulate_vb_cross(day2, dict(CHART, tol=0.0))]
    ok2 = len(tol2) == 1 and tol2[0] >= '05:00:00' and tol0 == []
    print('v21 day 2: opened 1% over the VWAP → tol 2%:', tol2, '| tol 0:', tol0, '→', 'OK' if ok2 else 'UNEXPECTED')

    # v23: the day's first candle counts, against the lines as they stand. WHLR 10-21: flat at
    # 0.356 overnight, then the 04:00 candle opens 0.43 (a gap over yesterday's band), runs to
    # 0.65 and closes 0.55. Its own VWAP and the band it drags up sit above the 0.43 open, so the
    # body crosses both: CROSS at 04:00:30 (v22 stayed silent). No gainer → nothing.
    d3 = d2 + dt.timedelta(days=1)
    prev = bars_of(d3 - dt.timedelta(hours=8, minutes=50), [(0.356, 0.357, 0.355, 0.356)] * 100)   # 19:10–20:00 the day before
    gap = bars_of(d3, [(0.43, 0.50, 0.43, 0.48), (0.48, 0.55, 0.47, 0.52), (0.52, 0.65, 0.50, 0.55),
                       (0.55, 0.60, 0.53, 0.55)], vols=[3000, 3000, 3000, 3000])
    first = [(e[0].strftime('%H:%M:%S'), e[6], e[7]) for e in simulate_vb_cross(prev + gap, CHART) if e[0] >= d3]
    no_gainer = simulate_vb_cross(day1, CHART, gainer_of=lambda b: False)
    ok3 = first == [('04:00:30', 'session', 1)] and no_gainer == []
    print('v23 the day\'s first candle (WHLR-like gap-and-go):', first, '| no gainer:', no_gainer, '→',
          'OK' if ok3 else 'UNEXPECTED (want 04:00:30 session #1)')

    # Arithmetic on random walks: band vs a BB on the 2m closes, VWAP vs the 5m candles' VWAP.
    random.seed(21)
    worst_band = worst_vw = 0.0
    for trial in range(10):
        px, path, vols = 2.0, [], []
        for k in range(600):                                   # 04:00–09:00
            o = px
            px *= 1 + random.gauss(0, 0.003)
            path.append((o, max(o, px) * (1 + abs(random.gauss(0, 0.002))), min(o, px) * (1 - abs(random.gauss(0, 0.002))), px))
            vols.append(random.randint(50, 5000))
        bars = bars_of(d1, path, vols)
        tr = []
        simulate_vb_cross(bars, params=CHART, trace=tr)
        by2, by5 = {}, {}
        for b in bars:
            by2.setdefault(_bucket(b['t'], 2), []).append(b)
            by5.setdefault(_bucket(b['t'], 5), []).append(b)
        keys2 = sorted(by2)
        ups = _bands([by2[k][-1]['c'] for k in keys2], 20, 2.0)
        at = {t: (vw, up) for t, vw, up in tr}
        for k, u in zip(keys2, ups):
            mine = at[by2[k][-1]['t']][1]
            if u is not None and mine is not None:
                worst_band = max(worst_band, abs(mine - u))
        pv = vv = 0.0
        for k in sorted(by5):
            cb = by5[k]
            h, lo, c, vol = max(x['h'] for x in cb), min(x['l'] for x in cb), cb[-1]['c'], sum(x['v'] for x in cb)
            pv += (h + lo + c) / 3 * vol
            vv += vol
            worst_vw = max(worst_vw, abs(at[cb[-1]['t']][0]['session'] - pv / vv))
    ok4 = worst_band < 1e-9 and worst_vw < 1e-9
    print(f'v21 arithmetic: band vs BB on 2m closes, worst {worst_band:.1e}; VWAP vs 5m candles, worst {worst_vw:.1e} →',
          'OK' if ok4 else 'UNEXPECTED')

    # v22: the month line. A flat 1.00 day under a month VWAP held near 1.05 by the days before
    # (heavy volume): a candle out of the base crosses the session line first (1.03), then the
    # month line (1.07) — two messages, each line counted on its own. With no history before
    # today (the month's first day, or the year line on the year's) a line equals the session
    # one, so all three cross on one bar: one message, "session+month+year".
    d5 = d1 + dt.timedelta(days=4)
    flat = [1.000 if k % 2 else 1.001 for k in range(100)]                    # 04:00–04:50 (the band needs 38 min)
    ramp = [1.00, 1.03, 1.07, 1.08, 1.08, 1.08, 1.08, 1.08, 1.08, 1.08]       # the 04:50 candle
    day5 = bars_of(d5, flat + ramp)
    heavy = {'month': (1.05 * 1_000_000, 1_000_000.0)}
    m_ev = [(e[0].strftime('%H:%M:%S'), e[6], e[7]) for e in simulate_vb_cross(day5, CHART, before_of=lambda b: heavy)]
    ok5 = m_ev == [('04:50:30', 'session', 1), ('04:51:00', 'month', 1)]
    blank = {'month': (0.0, 0.0), 'year': (0.0, 0.0)}
    all3 = [(e[6], e[7]) for e in simulate_vb_cross(day5, CHART, before_of=lambda b: blank)]
    solo = [(e[6], e[7]) for e in simulate_vb_cross(day5, params=dict(CHART, lines=('month',)), before_of=lambda b: blank)]
    tr4 = []
    simulate_vb_cross(day5, params=CHART, before_of=lambda b: heavy, trace=tr4)
    _, vws, _ = tr4[99]                                                        # 04:49:30, the last bar before the ramp
    tpv = sum(((max(z['h'] for z in grp) + min(z['l'] for z in grp) + grp[-1]['c']) / 3) * sum(z['v'] for z in grp)
              for grp in [day5[i:i + 10] for i in range(0, 100, 10)])
    tv = 100.0 * 100
    want_m = (1.05 * 1_000_000 + tpv) / (1_000_000 + tv)
    ok6 = all3 == [('session+month+year', 1)] and solo == [('month', 1)] and abs(vws['month'] - want_m) < 1e-12
    print('v22 month line:', m_ev, '| no history before today:', all3, '| month only:', solo,
          f'| month VWAP {vws["month"]:.6f} vs {want_m:.6f} →', 'OK' if ok5 and ok6 else 'UNEXPECTED')
    return ok1 and ok2 and ok3 and ok4 and ok5 and ok6 and ok_lv


def selftest():
    """Synthetic check of the GO rules (run: python3 pinesim.py).
    Crash: a month-start line built on thin volume collapses under a flat basis on one
    heavy red bar — must NOT be GO. Breakout: the basis rises through the line — GO."""
    import datetime as dt
    t0 = dt.datetime(2026, 10, 1, 8, 0, tzinfo=ET)
    def bars_of(closes, vols):
        return [{'t': t0 + dt.timedelta(minutes=i), 'o': c, 'h': c, 'l': c, 'c': c, 'v': v}
                for i, (c, v) in enumerate(zip(closes, vols))]
    def vwap_of(bars):
        out, pv, v = {}, 0.0, 0.0
        for b in bars:
            pv += b['c'] * b['v']; v += b['v']; out[b['t']] = pv / v
        return lambda b: out[b['t']]
    gate = dict(minDayGain=-100.0, window=None)      # no gainer history in a synthetic series
    # thin month-start tape: flat 1.40, dip to 1.30, curl back up to ~1.37 under a ~1.39 line
    # (READY), then ONE heavy red bar at 1.25 drags the line under the basis
    closes = [1.40] * 30 + [1.40 - 0.01 * i for i in range(1, 11)] + [1.30 + 0.0045 * i for i in range(1, 16)] + [1.25]
    vols = [100] * (len(closes) - 1) + [50000]
    prior = {'t': t0 - dt.timedelta(days=1) + dt.timedelta(hours=7, minutes=59), 'o': 1.40, 'h': 1.40, 'l': 1.40,
             'c': 1.40, 'v': 1}            # yesterday 15:59 ET: gives the gate a prior close
    crash = [prior] + bars_of(closes, vols)
    line = vwap_of(crash)
    out = {}
    for name, params in (('v5', V5), ('v6', V6)):
        ev = simulate(crash, line, dict(params, **gate))
        armed = any(e[1] in ('FORMING', 'READY') for e in ev)
        out[name] = ('armed ' if armed else 'not armed ') + ','.join(e[1] for e in ev if e[0] == crash[-1]['t'])
    ok = out['v5'] == 'armed GO' and out['v6'] == 'armed '
    print('crash-bar GO by version:', out, '→', 'OK' if ok else 'UNEXPECTED')
    # v11: two lines. The same line twice → every event is "month+year"; a missing second line → all "month".
    one = simulate(crash, line, dict(V7, **gate))
    same = simulate_lines(crash, {'month': line, 'year': line}, dict(V7, **gate))
    solo = simulate_lines(crash, {'month': line, 'year': lambda b: None}, dict(V7, **gate))
    ok_lines = (len(same) == len(one) > 0 and all(e[2] == 'month+year' for e in same)
                and [(e[0], e[1]) for e in solo] == [(e[0], e[1]) for e in one] and all(e[2] == 'month' for e in solo))
    print('two lines (v11): same line twice → "month+year", no year line → "month":',
          f"{len(same)} month+year / {len(solo)} month", '→', 'OK' if ok_lines else 'UNEXPECTED')
    return ok and ok_lines



# ── RSI cross (script v32; one RSI since v33) and its DIP (v34) ────────────────
# The script reads each RSI timeframe's state after its last finished candle (request.security,
# lookahead on + [1]) and adds the chart bar's close as the open candle, then samples it when a
# chart bar closes a "check" candle (or one bar late if that bar had no trades). A signal: above
# its MA now, at or under it at the previous check, and the RSI at or under `os` now or within
# its last `os_n` finished candles. TradingView's RSI: ta.rma seeded with the SMA of the first n.
RSI_DEFAULTS = dict(sig_min=720, check_min=360, n=14, ma_n=14, os=30.0, os_n=6,
                    dip_wait=16, dip_max=2)   # v34: the DIP's dials (rsDipWait, rsDipMax)


def _rsi_value(up, dn):
    return 100.0 if dn == 0 else 0.0 if up == 0 else 100.0 - 100.0 / (1.0 + up / dn)


def rsi_states(closes, n):
    """Per close: (rma up, rma down, rsi) after it, TradingView's ta.rsi; None until seeded."""
    out, up, dn, su, sd = [], None, None, [], []
    for i, c in enumerate(closes):
        if i == 0:
            out.append(None)
            continue
        ch = c - closes[i - 1]
        u, d = max(ch, 0.0), max(-ch, 0.0)
        if up is None:
            su.append(u); sd.append(d)
            if len(su) == n:
                up, dn = sum(su) / n, sum(sd) / n
        else:
            up, dn = (up * (n - 1) + u) / n, (dn * (n - 1) + d) / n
        out.append(None if up is None else (up, dn, _rsi_value(up, dn)))
    return out


def _candle_start(t, minutes):
    """TradingView's intraday candles on an extended chart start at the 04:00 ET session open
    (6h: 04:00 / 10:00 / 16:00; 12h: 04:00 / 16:00); 30m and the like land on the same marks."""
    m = t.hour * 60 + t.minute
    s = 240 + (m - 240) // minutes * minutes if m >= 240 else m // minutes * minutes
    return t.replace(hour=s // 60, minute=s % 60, second=0, microsecond=0)


def resample_session(bars, minutes):
    """Bars → `minutes` candles anchored like _candle_start (the 04:00 open)."""
    out = []
    for b in bars:
        start = _candle_start(b['t'], minutes)
        if out and out[-1]['t'] == start:
            o = out[-1]
            o['h'] = max(o['h'], b['h']); o['l'] = min(o['l'], b['l']); o['c'] = b['c']; o['v'] += b['v']
        else:
            out.append({**b, 't': start})
    return out


def rsi_crosses_direct(candles, p=None):
    """The plain rule on the signal timeframe's own candles: on a candle's close the RSI crosses
    above its SMA, the RSI at or under `os` then or within the last `os_n` candles → candle starts."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    st = rsi_states([c['c'] for c in candles], p['n'])
    rsi = [None if x is None else x[2] for x in st]
    out, prev = [], None
    for i in range(len(candles)):
        win = rsi[i - p['ma_n'] + 1:i + 1] if i >= p['ma_n'] - 1 else []
        if len(win) < p['ma_n'] or any(r is None for r in win):
            prev = None
            continue
        ma = sum(win) / p['ma_n']
        low = min([r for r in rsi[max(0, i - p['os_n']):i] if r is not None] + [rsi[i]]) if p['os_n'] > 0 else rsi[i]
        if prev is not None and prev[0] <= prev[1] and rsi[i] > ma and low <= p['os']:
            out.append(candles[i]['t'])
        prev = (rsi[i], ma)
    return out


class _RsiSetup:
    """The script's `RsiSetup` type and its three methods (v34), one step per sampled candle close."""
    def __init__(self, p):
        self.p = p
        self.prevA = self.prevMa = self.prevR = None
        self.armed, self.age, self.in_dip = False, 0, False
        self.lowR, self.low_new, self.low_px, self.n = None, False, None, 0

    def check_cross(self, r, ma, lo):
        up = self.prevA is not None and r is not None and self.prevA <= self.prevMa and r > ma and lo <= self.p['os']
        if r is not None:
            self.prevA, self.prevMa = r, ma
        return up

    def arm_dip(self):
        self.armed, self.age, self.in_dip = True, 0, False
        self.lowR, self.low_new, self.low_px, self.n = None, False, None, 0

    def step_dip(self, r, ma, c_low):
        """→ 0 nothing, 1 the dip starts, 2 DIP."""
        ev = 0
        if r is None or ma is None:
            return ev
        if self.armed:
            self.age += 1
            if not self.in_dip:
                if r < ma:
                    self.in_dip, self.lowR, self.low_new, self.low_px, self.n = True, r, True, c_low, 0
                    ev = 1
                elif self.p['dip_wait'] > 0 and self.age >= self.p['dip_wait']:
                    self.armed = False
            else:
                self.low_px = c_low if self.low_px is None else min(self.low_px, c_low)
                rose = self.prevR is not None and r > self.prevR
                if ((rose and self.low_new) or (r > ma and self.n == 0)) and self.n < self.p['dip_max']:
                    self.n += 1
                    ev = 2
                if r > ma:
                    self.armed = self.in_dip = False
                elif r < self.lowR:
                    self.lowR, self.low_new = r, True
                else:
                    self.low_new = False
        self.prevR = r
        return ev


def _rsi_series(candles, p):
    """Per candle of the RSI's timeframe: (rsi, its SMA, the lowest RSI over it and the `os_n` before) or None."""
    st = rsi_states([c['c'] for c in candles], p['n'])
    rsi = [None if x is None else x[2] for x in st]
    out = []
    for i in range(len(candles)):
        win = rsi[i - p['ma_n'] + 1:i + 1] if i >= p['ma_n'] - 1 else []
        if len(win) < p['ma_n'] or any(r is None for r in win):
            out.append(None)
            continue
        low = min([r for r in rsi[max(0, i - p['os_n']):i] if r is not None] + [rsi[i]]) if p['os_n'] > 0 else rsi[i]
        out.append((rsi[i], sum(win) / p['ma_n'], low))
    return out


def rsi_rule_direct(candles, p=None):
    """The plain rule (v34) on the RSI timeframe's own candles, for a check timeframe that is a multiple
    of it: the RSI as it stands at each check candle's close (its last candle there) crosses above its
    SMA while oversold → RSI; then, candle by candle, the dip under the SMA and its turns up → DIP.
    → dict(crosses=[check candle start], starts=[candle start], dips=[(candle start, n, lowest price, age)])."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    assert p['check_min'] % p['sig_min'] == 0
    ser = _rsi_series(candles, p)
    s = _RsiSetup(p)
    out = dict(crosses=[], starts=[], dips=[])
    for i, c in enumerate(candles):
        chk = _candle_start(c['t'], p['check_min'])
        last_in_check = i + 1 == len(candles) or _candle_start(candles[i + 1]['t'], p['check_min']) != chk
        r, ma, lo = ser[i] if ser[i] is not None else (None, None, None)
        ev = s.step_dip(r, ma, c['l'])
        if ev == 1:
            out['starts'].append(c['t'])
        if ev == 2:
            out['dips'].append((c['t'], s.n, s.low_px, s.age))
        if last_in_check and s.check_cross(r, ma, lo):
            out['crosses'].append(chk)
            s.arm_dip()
    return out


def simulate_rsi(bars, chart_min, p=None, full=False, fine=None):
    """The script's RSI section (v34) on chart bars of `chart_min` minutes → [(check candle start, late)],
    or with full=True a dict: crosses, starts [(RSI candle start)], dips [(RSI candle start, late, n,
    lowest price, age)], both (bars that sampled a late and an on-time candle of one kind), late_c /
    late_a (late samples of check / RSI candles). `fine`: the bars the RSI's candles are really made
    of, for a chart whose bars don't divide the RSI's timeframe (the request reads true candles)."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    cross_ok = chart_min <= p['sig_min'] and p['check_min'] % chart_min == 0
    dip_ok = cross_ok and p['sig_min'] % chart_min == 0
    sig = resample_session(fine or bars, p['sig_min']) if fine or p['sig_min'] != chart_min else [dict(b) for b in bars]
    st = rsi_states([c['c'] for c in sig], p['n'])
    rsi_hist = [None if x is None else x[2] for x in st]
    starts = [c['t'] for c in sig]
    s = _RsiSetup(p)
    out = dict(crosses=[], starts=[], dips=[], both=0, late_c=0, late_a=0)
    done_c = done_a = None
    prev_live, prev_tc, prev_ta = None, None, None
    c_low = c_low_p = None
    step = datetime.timedelta(minutes=chart_min)
    j = 0   # finished RSI candles before the current chart bar's candle
    for b in bars:
        t = b['t']
        ta = _candle_start(t, p['sig_min'])
        tc = _candle_start(t, p['check_min'])
        while j < len(starts) and starts[j] < ta:
            j += 1
        live = None
        if j >= 1 and st[j - 1] is not None and j >= p['ma_n'] and all(r is not None for r in rsi_hist[j - (p['ma_n'] - 1):j]):
            up, dn, _ = st[j - 1]
            ch = b['c'] - sig[j - 1]['c']
            u = (up * (p['n'] - 1) + max(ch, 0.0)) / p['n']
            d = (dn * (p['n'] - 1) + max(-ch, 0.0)) / p['n']
            r = _rsi_value(u, d)
            ma = (sum(rsi_hist[j - (p['ma_n'] - 1):j]) + r) / p['ma_n']
            lows = [x for x in rsi_hist[max(0, j - p['os_n']):j] if x is not None] if p['os_n'] > 0 else []
            live = (r, ma, min(lows + [r]))
        if prev_ta is None or ta != prev_ta:
            c_low_p, c_low = c_low, b['l']
        else:
            c_low = min(c_low, b['l'])
        end_c = _candle_start(t + step, p['check_min']) != tc or chart_min >= p['check_min']
        end_a = _candle_start(t + step, p['sig_min']) != ta or chart_min >= p['sig_min']
        late_c = prev_tc is not None and tc != prev_tc and done_c != prev_tc
        late_a = prev_ta is not None and ta != prev_ta and done_a != prev_ta
        none3 = (None, None, None)
        if cross_ok:
            if dip_ok and late_a:
                out['late_a'] += 1
                r, ma, _ = prev_live or none3
                ev = s.step_dip(r, ma, c_low_p)
                done_a = prev_ta
                if ev == 1:
                    out['starts'].append(prev_ta)
                if ev == 2:
                    out['dips'].append((prev_ta, True, s.n, s.low_px, s.age))
            if late_c:
                out['late_c'] += 1
                r, ma, lo = prev_live or none3
                fired = s.check_cross(r, ma, lo)
                done_c = prev_tc
                if fired:
                    out['crosses'].append((prev_tc, True))
                    s.arm_dip()
            if dip_ok and end_a and done_a != ta:
                out['both'] += 1 if late_a else 0
                r, ma, _ = live or none3
                ev = s.step_dip(r, ma, c_low)
                done_a = ta
                if ev == 1:
                    out['starts'].append(ta)
                if ev == 2:
                    out['dips'].append((ta, False, s.n, s.low_px, s.age))
            if end_c and done_c != tc:
                out['both'] += 1 if late_c else 0
                r, ma, lo = live or none3
                fired = s.check_cross(r, ma, lo)
                done_c = tc
                if fired:
                    out['crosses'].append((tc, False))
                    s.arm_dip()
        prev_live, prev_tc, prev_ta = live, tc, ta
    return out if full else out['crosses']


def selftest_rsi():
    """The RSI cross (v33) and its DIP (v34): the replica of the script's sampling gives the plain
    rule's marks on every chart whose bars line up — a 30m RSI checked at the 30m close; a 15m RSI
    checked at the 1h close with its dips; a 12h RSI at the 6h close."""
    import datetime as dt, math, random
    rnd = random.Random(7)
    t0 = dt.datetime(2026, 9, 1, 4, 0, tzinfo=ET)
    bars, px = [], 10.0
    for day in range(25):
        drift = rnd.choice([-0.0012, -0.0008, 0.0006, 0.0010])
        thin = None
        for m in range(240, 1200):
            px *= math.exp(drift + rnd.gauss(0, 0.004))
            if m % 15 == 0:
                thin = rnd.random() < 0.06            # a quarter-hour with a single print, in its last minute
            last = day == 24 and m == 1199             # the series ends on a print (a late sample needs a later bar)
            if thin and m % 15 != 14:
                continue
            if m % 30 != 29 and rnd.random() < 0.15:      # thin tape: some minutes have no trades…
                continue
            if day % 3 == 0 and m % 15 == 14 and not thin and not last and rnd.random() < 0.5:
                continue                                   # …sometimes a candle's last minute too
            t = t0 + dt.timedelta(days=day, minutes=m - 240)
            bars.append({'t': t, 'o': px, 'h': px * 1.001, 'l': px * 0.999, 'c': px, 'v': 100})
    p = dict(sig_min=30, check_min=30)
    want = rsi_crosses_direct(resample_session(bars, 30), p)
    on30 = simulate_rsi(resample_session(bars, 30), 30, p)
    on2 = simulate_rsi(resample_session(bars, 2), 2, p)
    f1 = simulate_rsi(bars, 1, p, full=True)
    on1 = f1['crosses']
    same = lambda got: [t for t, _ in got] == want
    ok = (len(want) >= 5 and same(on30) and same(on2) and same(on1) and not any(l for _, l in on30) and f1['late_c'] > 0
          and rsi_rule_direct(resample_session(bars, 30), p)['crosses'] == want)
    print(f'RSI cross (v33), 30m RSI at the 30m close: {len(want)} marks by the plain rule; the script on a 30m chart '
          f"{len(on30)}, 2m {len(on2)}, 1m {len(on1)} ({f1['late_c']} of its candles sampled a bar late)", '→', 'OK' if ok else 'UNEXPECTED')
    # v34 DIP, the operator's settings (a 15m RSI checked at the 1h close): the plain rule on 15m candles
    # against the script on 15m, 5m, 3m and 1m charts — the same RSI marks, dip starts and DIPs (candle,
    # number, lowest price, candles since the RSI cross); a 10m chart keeps the RSI marks and draws no DIP.
    p3 = dict(sig_min=15, check_min=60, os=38.0)
    d = rsi_rule_direct(resample_session(bars, 15), p3)
    ok3, shown = len(d['crosses']) >= 5 and len(d['dips']) >= 5 and any(n == 2 for _, n, _, _ in d['dips']), []
    for cm in (15, 5, 3, 1):
        g = simulate_rsi(resample_session(bars, cm) if cm > 1 else bars, cm, p3, full=True)
        ok3 = (ok3 and [t for t, _ in g['crosses']] == d['crosses'] and g['starts'] == d['starts']
               and [(t, n, lp, age) for t, _, n, lp, age in g['dips']] == d['dips'])
        shown.append(f"{cm}m {len(g['crosses'])} / {len(g['dips'])}" + (f" ({sum(1 for x in g['dips'] if x[1])} late, {g['both']} bars sampling two)" if cm == 1 else ''))
    one = simulate_rsi(bars, 1, p3, full=True)
    ten = simulate_rsi(resample_session(bars, 10), 10, p3, full=True, fine=bars)
    hour = simulate_rsi(resample_session(bars, 60), 60, p3, full=True)
    # (on the 10m chart the RSI marks are right when the hour's last 10 minutes traded; no DIP marks there)
    ten_same = len(set(d['crosses']) & {t for t, _ in ten['crosses']})
    ok3 = (ok3 and one['both'] > 0 and one['late_a'] > 0 and ten_same >= len(d['crosses']) - 1
           and ten['dips'] == [] and hour['crosses'] == [] and hour['dips'] == [])
    print(f"RSI dip (v34), 15m RSI at the 1h close: {len(d['crosses'])} RSI / {len(d['starts'])} dips / {len(d['dips'])} DIP by the plain rule; "
          f"the script: {', '.join(shown)}; 10m chart {ten_same} of the RSI marks / {len(ten['dips'])} DIP, 1h chart none", '→', 'OK' if ok3 else 'UNEXPECTED')
    # the dip's dials: off → RSI marks only; one signal per dip; a dip that must start at once
    off = simulate_rsi(bars, 1, dict(p3, dip_wait=1), full=True)
    cap = simulate_rsi(bars, 1, dict(p3, dip_max=1), full=True)
    ok4 = (len(off['starts']) < len(one['starts'])
           and all(n == 1 for _, _, n, _, _ in cap['dips']) and len(cap['dips']) < len(one['dips']))
    print(f"…dials: at most 1 per dip → {len(cap['dips'])} DIP (of {len(one['dips'])}); must start on the next candle → {len(off['starts'])} dips (of {len(one['starts'])})",
          '→', 'OK' if ok4 else 'UNEXPECTED')
    # v32's default, a 12h RSI checked at the 6h close: the 2m chart marks what the 6h chart marks
    # (four months of the same kind of tape, so the 12h RSI has room to swing)
    rnd2 = random.Random(11)
    long, px = [], 10.0
    for day in range(120):
        if day % 8 == 0:                              # multi-day trends, so the 12h RSI reaches oversold
            drift = rnd2.choice([-0.0004, -0.0003, 0.0003, 0.0004])
        for m in range(240, 1200, 2):
            px *= math.exp(drift * 2 + rnd2.gauss(0, 0.005))
            long.append({'t': t0 + dt.timedelta(days=day, minutes=m - 240), 'o': px, 'h': px, 'l': px, 'c': px, 'v': 100})
    p2 = dict(sig_min=720, check_min=360, os=40.0)
    a, b = simulate_rsi(long, 2, p2), simulate_rsi(resample_session(long, 360), 360, p2)
    ok2 = len(a) >= 2 and [t for t, _ in a] == [t for t, _ in b]
    print(f'…12h RSI at the 6h close, 2m chart vs 6h chart: {len(a)} / {len(b)} marks', '→', 'OK' if ok2 else 'UNEXPECTED')
    return ok and ok2 and ok3 and ok4


# ── EMA cross over VWAP (script v35) ───────────────────────────────────────────
# The EMA of a timeframe's closes (3m, length 9) against the session VWAP, judged at each close of
# that timeframe's candles: above the line now, at or under it at the close before. As the RSI, the
# script reads the EMA after the last finished candle (request.security, lookahead on + [1]) and
# adds the chart bar's close; a candle whose closing bar had no trades is sampled on the next bar,
# but not announced across the day's end. The day's first candle can't fire (the line restarts).
# v36, the filter: a cross is weak when its candle opened before `from_hour` (New York), when the EMA
# had been at or under the line for fewer than `min_under` candles, or when the two crossed more than
# `max_flips` times in the 20 candles before. A weak cross is still sent (`| weak`), takes no day's
# number, and the server keeps it quiet. Measured in ../ema-vwap/.
EMA_DEFAULTS = dict(tf_min=3, n=9, filter=True, min_under=5, max_flips=2, from_hour=7)


def _ema_weak(p, hour, under, flips):
    """The script's emWeak, with the candle's hour."""
    return p['filter'] and (hour < p['from_hour'] or under < p['min_under'] or flips > p['max_flips'])


def ema_series(closes, n):
    """TradingView's ta.ema per close: seeded with the SMA of the first n closes; None before."""
    out, e, alpha = [], None, 2.0 / (n + 1)
    for i, c in enumerate(closes):
        if e is None:
            if i + 1 >= n:
                e = sum(closes[i + 1 - n:i + 1]) / n
        else:
            e = alpha * c + (1 - alpha) * e
        out.append(e)
    return out


def with_session_vwap(bars):
    """Bars plus 'vw': the session VWAP after each bar (hlc3 × volume from the day's first bar)."""
    out, day, pv, v = [], None, 0.0, 0.0
    for b in bars:
        if b['t'].date() != day:
            day, pv, v = b['t'].date(), 0.0, 0.0
        pv += (b['h'] + b['l'] + b['c']) / 3 * b['v']
        v += b['v']
        out.append({**b, 'vw': pv / v if v > 0 else None})
    return out


def resample_vw(bars, minutes):
    """resample_session that keeps each candle's last 'vw': the line as it stands at the candle's close."""
    out = []
    for b in bars:
        start = _candle_start(b['t'], minutes)
        if out and out[-1]['t'] == start:
            o = out[-1]
            o['h'] = max(o['h'], b['h']); o['l'] = min(o['l'], b['l']); o['c'] = b['c']; o['v'] += b['v']; o['vw'] = b['vw']
        else:
            out.append({**b, 't': start})
    return out


class _EmaLine:
    """The script's `EmaLine` type: one line's state, stepped once per sampled candle close."""
    def __init__(self):
        self.prevE = self.prevL = None
        self.n = 0
        self.under = self.ran = self.flips = 0   # v36
        self.hist = []                           # the last 20 closes: 1 = the EMA above the line

    def cross_up(self, e, ln):
        up = self.prevE is not None and e is not None and ln is not None and self.prevE <= self.prevL and e > ln
        if e is not None and ln is not None:
            if up:
                self.ran = self.under
                self.flips = sum(1 for i in range(1, len(self.hist)) if self.hist[i] != self.hist[i - 1])
            self.under = 0 if e > ln else self.under + 1
            self.hist.append(1 if e > ln else 0)
            if len(self.hist) > 20:
                self.hist.pop(0)
            self.prevE, self.prevL = e, ln
        return up

    def restart(self):
        self.prevE = self.prevL = None
        self.under = 0
        self.hist = []


def ema_rule_direct(bars, p=None):
    """The plain rule on the EMA timeframe's own candles (`bars` carry 'vw'): the EMA closes above
    the session VWAP after closing at or under it, the day's first candle excluded. The filter's
    readings are taken from the day's candles directly, as the study does (ema_vwap_study.py).
    → [(candle start, the day's number, the candle is its day's last, under, flips, weak)]."""
    p = dict(EMA_DEFAULTS, **(p or {}))
    c = resample_vw(bars, p['tf_min'])
    e = ema_series([x['c'] for x in c], p['n'])
    out, day, n = [], None, 0
    seen = []          # the day's candles with an EMA and a line: (EMA, line)
    for i, x in enumerate(c):
        if x['t'].date() != day:
            day, n, seen = x['t'].date(), 0, []
        if e[i] is None or x['vw'] is None:
            continue
        above = [a > b for a, b in seen]
        if seen and not above[-1] and e[i] > x['vw']:
            under = 0
            for a in reversed(above):
                if a:
                    break
                under += 1
            last20 = above[-20:]
            flips = sum(1 for k in range(1, len(last20)) if last20[k] != last20[k - 1])
            weak = _ema_weak(p, x['t'].hour, under, flips)
            if not weak:
                n += 1
            last = i + 1 == len(c) or c[i + 1]['t'].date() != day
            out.append((x['t'], n, last, under, flips, weak))
        seen.append((e[i], x['vw']))
    return out


def simulate_ema(bars, chart_min, p=None, fine=None):
    """The script's EMA section (v35, v36's filter) on chart bars of `chart_min` minutes carrying 'vw' →
    [(candle start, late, the day's number, under, flips, weak)]. `fine`: the bars the EMA's candles
    are really made of, for a chart of the EMA's own timeframe built from smaller bars."""
    p = dict(EMA_DEFAULTS, **(p or {}))
    if not (chart_min <= p['tf_min'] and p['tf_min'] % chart_min == 0):
        return []
    c = resample_vw(fine or bars, p['tf_min'])
    e_after = ema_series([x['c'] for x in c], p['n'])
    starts = [x['t'] for x in c]
    alpha = 2.0 / (p['n'] + 1)
    line, out, done = _EmaLine(), [], None
    prev_live = prev_vw = prev_t = prev_day = None
    step = datetime.timedelta(minutes=chart_min)
    j = 0   # finished EMA candles before the current chart bar's candle
    for b in bars:
        t = b['t']
        ct = _candle_start(t, p['tf_min'])
        while j < len(starts) and starts[j] < ct:
            j += 1
        live = alpha * b['c'] + (1 - alpha) * e_after[j - 1] if j >= 1 and e_after[j - 1] is not None else None
        new_day = prev_day is not None and t.date() != prev_day
        if prev_t is not None and ct != prev_t and done != prev_t:      # the candle before, from the bar before
            fired = line.cross_up(prev_live, prev_vw)
            done = prev_t
            if fired and not new_day:
                weak = _ema_weak(p, prev_t.hour, line.ran, line.flips)     # the candle's own hour, by its open
                if not weak:
                    line.n += 1
                out.append((prev_t, True, line.n, line.ran, line.flips, weak))
        if new_day:
            line.restart()
            line.n = 0
        ends = _candle_start(t + step, p['tf_min']) != ct or chart_min >= p['tf_min']
        if ends and done != ct:
            fired = line.cross_up(live, b['vw'])
            done = ct
            if fired:
                weak = _ema_weak(p, ct.hour, line.ran, line.flips)
                if not weak:
                    line.n += 1
                out.append((ct, False, line.n, line.ran, line.flips, weak))
        prev_live, prev_vw, prev_t, prev_day = live, b['vw'], ct, t.date()
    return out


def selftest_ema():
    """v35 EMA cross: the replica of the script's sampling gives the plain rule's crosses — the EMA 9
    of 3m closes over the session VWAP — on a 3m chart and on a 1m chart with missing minutes (late
    ones on the same candle; a cross on a day's last candle with no closing bar is not announced)."""
    import datetime as dt, math, random
    rnd = random.Random(21)
    t0 = dt.datetime(2026, 9, 1, 4, 0, tzinfo=ET)
    bars, px = [], 10.0
    for day in range(20):
        for m in range(240, 1200):
            drift = 0.0006 * math.sin((m - 240) / 55.0 + day)          # swings around the day's VWAP
            px *= math.exp(drift + rnd.gauss(0, 0.003))
            if rnd.random() < 0.25:                                    # thin tape: some minutes have no trades,
                continue                                                # a candle's last minute included
            bars.append({'t': t0 + dt.timedelta(days=day, minutes=m - 240), 'o': px, 'h': px * 1.001, 'l': px * 0.999,
                         'c': px, 'v': 100 + rnd.randrange(400)})
    fine = with_session_vwap(bars)
    # v35's rule first, the filter off: every cross takes a day's number
    plain = dict(filter=False)
    want = ema_rule_direct(fine, plain)
    on3 = simulate_ema(resample_vw(fine, 3), 3, plain, fine=fine)
    on1 = simulate_ema(fine, 1, plain)
    key = lambda got: [(t, n) for t, _, n, _, _, _ in got]
    all_w = [(t, n) for t, n, _, _, _, _ in want]
    dropped = [x for x in all_w if x not in key(on1)]
    day_end = {(t, n) for t, n, last, _, _, _ in want if last}
    late1 = sum(1 for _, late, _, _, _, _ in on1 if late)
    ok = (len(want) >= 20 and key(on3) == all_w and not any(l for _, l, _, _, _, _ in on3)
          and [x for x in all_w if x not in dropped] == key(on1) and all(x in day_end for x in dropped) and late1 > 0
          and not any(w for _, _, _, _, _, w in want + on3 + on1)
          and simulate_ema(resample_vw(fine, 2), 2, fine=fine) == [] and simulate_ema(resample_vw(fine, 5), 5, fine=fine) == [])
    first_of_day = sum(1 for t, _, _, _, _, _ in want if t.hour == 4 and t.minute < 3)
    print(f'EMA cross (v35), EMA 9 of 3m closes over the session VWAP: {len(want)} crosses by the plain rule; the script on a 3m chart '
          f'{len(on3)}, on a 1m chart {len(on1)} ({late1} a bar late, {len(dropped)} on a day\'s last candle not announced); '
          f'2m and 5m charts none; none on a day\'s first candle ({first_of_day})', '→', 'OK' if ok and first_of_day == 0 else 'UNEXPECTED')
    # v36, the filter on (the defaults): the same crosses, each with the stay under the line, the flips
    # before and the verdict the plain rule gives; only the strong ones take a day's number
    wantf = ema_rule_direct(fine)
    f3 = simulate_ema(resample_vw(fine, 3), 3, fine=fine)
    f1 = simulate_ema(fine, 1)
    full = lambda got: [(t, n, u, f, w) for t, _, n, u, f, w in got]
    all_f = [(t, n, u, f, w) for t, n, _, u, f, w in wantf]
    end_f = {(t, n, u, f, w) for t, n, last, u, f, w in wantf if last}
    drop_f = [x for x in all_f if x not in full(f1)]
    weak_n = sum(1 for x in all_f if x[4])
    early = sum(1 for t, _, _, u, f, w in wantf if w and t.hour < 7)
    short = sum(1 for t, _, _, u, f, w in wantf if w and t.hour >= 7 and u < 5)
    chop = sum(1 for t, _, _, u, f, w in wantf if w and t.hour >= 7 and u >= 5 and f > 2)
    strong_days = {}
    for t, n, _, u, f, w in wantf:
        if not w:
            strong_days.setdefault(t.date(), []).append(n)
    ok5 = ([t for t, _, _, _, _ in all_f] == [t for t, _ in all_w] and full(f3) == all_f
           and [x for x in all_f if x not in drop_f] == full(f1) and all(x in end_f for x in drop_f)
           and 0 < weak_n < len(all_f) and early > 0 and short > 0 and chop > 0
           and all(ns == list(range(1, len(ns) + 1)) for ns in strong_days.values())
           and all(w == (t.hour < 7 or u < 5 or f > 2) for t, _, u, f, w in all_f))
    print(f'…the filter (v36): {weak_n} of {len(all_f)} weak ({early} before 07:00, {short} under the line < 5 candles, {chop} with 3+ flips); '
          f'the script gives the same readings and verdicts on the 3m and 1m charts, and numbers the strong ones 1, 2, … per day',
          '→', 'OK' if ok5 else 'UNEXPECTED')
    return ok and first_of_day == 0 and ok5


if __name__ == '__main__':
    raise SystemExit(0 if (selftest() & selftest_pullback() & selftest_breakout() & selftest_vb() & selftest_rsi() & selftest_ema()) else 1)
