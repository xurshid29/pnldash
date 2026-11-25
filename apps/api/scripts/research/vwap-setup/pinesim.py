"""Offline replica of apps/web/src/tv/mvwap-bb-setup.pine — the reclaim setup (v9 logic = v7 + message
fields) in simulate() for one line and (v11) simulate_lines() for the month + year lines, the
PULLBACK setup (script v10) in PullbackLine / simulate_pullback(), the BB breakout (v17–v20) in
simulate_breakout() / simulate_breakout_1m(), and the VWAP + BB cross (v21) in simulate_vb_cross().
Further down, each with the rule stated a second time, independently, and a self-test that holds
the two against each other: the RSI cross with its DIP, LIFT and MACD (v32–v39) in simulate_rsi(),
the EMA / band / basis cross over VWAP with its BOUNCE (v35–v42) in simulate_ema(), TURN, the
bounce off a basis that fell and turned up (v47), in simulate_turn() / turn_rule_direct(), and POP
and BACK, a pop off the basis and its first pullback (v48), in simulate_pop() / pop_rule_direct().

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



# ── RSI cross (script v32; one RSI since v33), its DIP (v34) and the MACD after a DIP (v39) ──
# The script reads each RSI timeframe's state after its last finished candle (request.security,
# lookahead on + [1]) and adds the chart bar's close as the open candle, then samples it when a
# chart bar closes a "check" candle (or one bar late if that bar had no trades). A signal: above
# its MA now, at or under it at the previous check, and the RSI at or under `os` now or within
# its last `os_n` finished candles. TradingView's RSI: ta.rma seeded with the SMA of the first n.
RSI_DEFAULTS = dict(sig_min=720, check_min=360, n=14, ma_n=14, os=30.0, os_n=6,
                    dip_wait=16, dip_max=2,   # v34: the DIP's dials (rsDipWait, rsDipMax)
                    # v38, the LIFT: after a DIP, a level lift_pct % above its close; LIFT on the first
                    # bar after the DIP candle whose high reaches it ('touch') or that closes at or over
                    # it ('close'); a newer DIP moves the level; it goes after lift_days sessions (0 = never).
                    # Script v39 removed it; it stays here for research (../rsi-dip/), as the script had it at v38.
                    lift=True, lift_pct=8.0, lift_by='touch', lift_days=3,
                    # v39, the MACD cross after a DIP: the MACD line (EMA macd_fast − EMA macd_slow of the closes
                    # of macd_min candles) closes above zero after closing at or under it; a newer DIP starts the
                    # wait over; it ends after macd_life sessions begun since the DIP's candle (0 = never)
                    macd=True, macd_min=5, macd_fast=12, macd_slow=26, macd_life=3)


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


def lift_rule_direct(bars, p=None):
    """The plain LIFT rule (v38, 'touch') on the bars the RSI's candles are made of: for each DIP of
    rsi_rule_direct, the bars from its candle's close to the next DIP's candle's close, while no more
    than lift_days new sessions have begun; the first whose high reaches the DIP's close × (1 + lift_pct %).
    → [(the RSI candle that bar is in, the level, the DIP's close)]."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    candles = resample_session(bars, p['sig_min'])
    close_of = {c['t']: c['c'] for c in candles}
    dips = rsi_rule_direct(candles, p)['dips']
    step = datetime.timedelta(minutes=p['sig_min'])
    out = []
    for j, (t0, _n, _low, _age) in enumerate(dips):
        base = close_of[t0]
        level = base * (1 + p['lift_pct'] / 100)
        until = dips[j + 1][0] + step if j + 1 < len(dips) else None
        days, day = 0, t0.date()
        for b in bars:
            if b['t'] < t0 + step:
                continue
            if until is not None and b['t'] >= until:
                break
            if b['t'].date() != day:
                day, days = b['t'].date(), days + 1
            if p['lift_days'] > 0 and days > p['lift_days']:
                break
            if b['h'] >= level:
                out.append((_candle_start(b['t'], p['sig_min']), level, base))
                break
    return out


def _macd_line(candles, p):
    """Per candle of the MACD's timeframe: the MACD line at its close (EMA fast − EMA slow of the closes) as the
    script has it — None until both EMAs had a value after the candle before (the request's `[1]`)."""
    closes = [c['c'] for c in candles]
    ef, es = ema_series(closes, p['macd_fast']), ema_series(closes, p['macd_slow'])
    return [None if i == 0 or ef[i - 1] is None or es[i - 1] is None else ef[i] - es[i] for i in range(len(candles))]


def _macd_up(before, now):
    """The script's mcUp: the line closed above zero after closing at or under it."""
    return before is not None and now is not None and before <= 0 < now


def macd_rule_direct(bars, p=None):
    """The plain MACD rule (v39) on the bars the candles are made of, for a MACD timeframe that divides the
    RSI's: for each DIP of rsi_rule_direct, the MACD candles that close after its candle and no later than the
    next DIP's candle, while no more than macd_life sessions have begun since its candle; the first at whose
    close the line is above zero after being at or under it at the candle close before.
    → [(the MACD candle's start, the DIP's close, the DIP's number in its dip)]."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    assert p['sig_min'] % p['macd_min'] == 0
    candles = resample_session(bars, p['sig_min'])
    close_of = {c['t']: c['c'] for c in candles}
    dips = rsi_rule_direct(candles, p)['dips']
    mc = resample_session(bars, p['macd_min'])
    line = _macd_line(mc, p)
    day_no = {d: i for i, d in enumerate(sorted({b['t'].date() for b in bars}))}
    sig, mstep = datetime.timedelta(minutes=p['sig_min']), datetime.timedelta(minutes=p['macd_min'])
    out = []
    for j, (t0, n, _low, _age) in enumerate(dips):
        closed = t0 + sig
        until = dips[j + 1][0] + sig if j + 1 < len(dips) else None
        for i, c in enumerate(mc):
            end = c['t'] + mstep
            if end <= closed:
                continue
            if until is not None and end > until:
                break
            if p['macd_life'] > 0 and day_no[c['t'].date()] - day_no[t0.date()] > p['macd_life']:
                break
            if _macd_up(line[i - 1], line[i]):
                out.append((c['t'], close_of[t0], n))
                break
    return out


def simulate_rsi(bars, chart_min, p=None, full=False, fine=None):
    """The script's RSI section (v34) on chart bars of `chart_min` minutes → [(check candle start, late)],
    or with full=True a dict: crosses, starts [(RSI candle start)], dips [(RSI candle start, late, n,
    lowest price, age)], both (bars that sampled a late and an on-time candle of one kind), late_c /
    late_a (late samples of check / RSI candles), (v38, removed from the script in v39) lifts [(the RSI
    candle the bar that fired is in, the level, the DIP's close)] and (v39) macds [(the MACD candle's
    start, late, the DIP's close, the DIP's number)]. `fine`: the bars the candles are really made
    of, for a chart whose bars don't divide the RSI's timeframe (the request reads true candles)."""
    p = dict(RSI_DEFAULTS, **(p or {}))
    cross_ok = chart_min <= p['sig_min'] and p['check_min'] % chart_min == 0
    dip_ok = cross_ok and p['sig_min'] % chart_min == 0
    sig = resample_session(fine or bars, p['sig_min']) if fine or p['sig_min'] != chart_min else [dict(b) for b in bars]
    st = rsi_states([c['c'] for c in sig], p['n'])
    rsi_hist = [None if x is None else x[2] for x in st]
    starts = [c['t'] for c in sig]
    s = _RsiSetup(p)
    out = dict(crosses=[], starts=[], dips=[], both=0, late_c=0, late_a=0, lifts=[], macds=[], late_m=0)
    done_c = done_a = None
    prev_live, prev_tc, prev_ta = None, None, None
    c_low = c_low_p = None
    lf_level = lf_base = None      # v38: the lift's level and its DIP's close
    lf_days, prev_day, prev_close = 0, None, None
    # v39, the MACD after a DIP (the script's section 5): the two EMAs after each finished candle of the
    # MACD's timeframe (the request), the line live at each bar, and the wait a DIP starts.
    mc_ok = p['macd'] and dip_ok and chart_min <= p['macd_min'] and p['macd_min'] % chart_min == 0
    mcs = resample_session(fine or bars, p['macd_min']) if fine or p['macd_min'] != chart_min else [dict(b) for b in bars]
    mc_f, mc_s = ema_series([c['c'] for c in mcs], p['macd_fast']), ema_series([c['c'] for c in mcs], p['macd_slow'])
    mc_starts = [c['t'] for c in mcs]
    mc_af, mc_as = 2.0 / (p['macd_fast'] + 1), 2.0 / (p['macd_slow'] + 1)
    mc_was = mc_base = mc_n = done_m = prev_tm = prev_line = None
    mc_armed, mc_age = False, 0
    k = 0   # finished MACD candles before the current chart bar's candle
    step = datetime.timedelta(minutes=chart_min)
    j = 0   # finished RSI candles before the current chart bar's candle
    for b in bars:
        t = b['t']
        ta = _candle_start(t, p['sig_min'])
        tc = _candle_start(t, p['check_min'])
        tm = _candle_start(t, p['macd_min'])
        while k < len(mc_starts) and mc_starts[k] < tm:
            k += 1
        line = None
        if k >= 1 and mc_f[k - 1] is not None and mc_s[k - 1] is not None:
            line = (mc_af * b['c'] + (1 - mc_af) * mc_f[k - 1]) - (mc_as * b['c'] + (1 - mc_as) * mc_s[k - 1])
        end_m = _candle_start(t + step, p['macd_min']) != tm or chart_min >= p['macd_min']
        late_m = prev_tm is not None and tm != prev_tm and done_m != prev_tm
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
        dip_go = dip_late = False       # this bar's DIP, as the script's rsDipGo / rsDipLate / rsDPx / rsDN end up
        dip_px = dip_n = None
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
                    dip_go, dip_late, dip_px, dip_n = True, True, prev_close, s.n
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
                    dip_go, dip_late, dip_px, dip_n = True, False, b['c'], s.n
            if end_c and done_c != tc:
                out['both'] += 1 if late_c else 0
                r, ma, lo = live or none3
                fired = s.check_cross(r, ma, lo)
                done_c = tc
                if fired:
                    out['crosses'].append((tc, False))
                    s.arm_dip()
        new_day = prev_day is not None and t.date() != prev_day
        # v39, the MACD after a DIP (the script's section 5), in the script's order: the candle that ended
        # before this bar (it belongs to the DIP before), the sessions' count, a late DIP's wait, the candle
        # this bar closes, an on-time DIP's wait.
        if mc_ok:
            if late_m:
                out['late_m'] += 1
                if mc_armed and _macd_up(mc_was, prev_line):
                    out['macds'].append((prev_tm, True, mc_base, mc_n))
                    mc_armed = False
                if prev_line is not None:
                    mc_was = prev_line
                done_m = prev_tm
            if mc_armed and new_day:
                mc_age += 1
            if mc_armed and p['macd_life'] > 0 and mc_age > p['macd_life']:
                mc_armed = False
            if dip_go and dip_late:
                mc_armed, mc_base, mc_n, mc_age = True, dip_px, dip_n, 1 if new_day else 0
            if end_m and done_m != tm:
                if mc_armed and _macd_up(mc_was, line):
                    out['macds'].append((tm, False, mc_base, mc_n))
                    mc_armed = False
                if line is not None:
                    mc_was = line
                done_m = tm
            if dip_go and not dip_late:
                mc_armed, mc_base, mc_n, mc_age = True, dip_px, dip_n, 0
        # v38, the LIFT (the script's section 5 at v38; removed in v39). A late DIP's level takes over before
        # this bar's check (the bar is already after its candle), an on-time DIP's after it.
        if p['lift'] and dip_ok:
            if dip_go and dip_late:
                lf_level, lf_base, lf_days = dip_px * (1 + p['lift_pct'] / 100), dip_px, 0
            elif lf_level is not None and new_day:
                lf_days += 1
            if lf_level is not None and p['lift_days'] > 0 and lf_days > p['lift_days']:
                lf_level = None
            if lf_level is not None and (b['h'] if p['lift_by'] == 'touch' else b['c']) >= lf_level:
                out['lifts'].append((ta, lf_level, lf_base))
                lf_level = None
            if dip_go and not dip_late:
                lf_level, lf_base, lf_days = dip_px * (1 + p['lift_pct'] / 100), dip_px, 0
        prev_live, prev_tc, prev_ta, prev_day, prev_close = live, tc, ta, t.date(), b['c']
        prev_tm, prev_line = tm, line
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
    # v38 LIFT: for each DIP the first bar after its candle whose high reaches the level, until the next
    # DIP — the plain rule on the 1m bars against the script on the 15m, 5m, 3m and 1m charts (the same
    # RSI candle, level and DIP); then the level's life in sessions, the close instead of a touch, off
    pl = dict(p3, lift_pct=4.0, lift_days=0)
    want_l = lift_rule_direct(bars, pl)
    ok6, shown_l = len(want_l) >= 5 and len(want_l) < len(d['dips']), []
    for cm in (15, 5, 3, 1):
        g = simulate_rsi(resample_session(bars, cm) if cm > 1 else bars, cm, pl, full=True)
        ok6 = ok6 and g['lifts'] == want_l
        shown_l.append(f"{cm}m {len(g['lifts'])}")
    on15 = lambda q: simulate_rsi(resample_session(bars, 15), 15, q, full=True)['lifts']
    by_close = on15(dict(pl, lift_by='close'))
    ok6 = (ok6 and 0 < len(by_close) <= len(want_l) and on15(dict(pl, lift=False)) == []
           and all(abs(lv / base - 1.04) < 1e-9 for _, lv, base in want_l))
    # the level's life: a calmer tape (40 days), where a level 5% up can take more than a session to reach
    rnd3 = random.Random(3)
    calm, px = [], 10.0
    for day in range(40):
        if day % 4 == 0:
            drift = rnd3.choice([-0.00012, -0.00008, 0.00008, 0.00012])
        for m in range(240, 1200):
            px *= math.exp(drift + rnd3.gauss(0, 0.002))
            if rnd3.random() < 0.2 and not (day == 39 and m == 1199):
                continue
            calm.append({'t': t0 + dt.timedelta(days=day, minutes=m - 240), 'o': px, 'h': px * 1.0005, 'l': px * 0.9995, 'c': px, 'v': 100})
    life = []
    for days in (0, 1):
        q = dict(p3, lift_pct=5.0, lift_days=days)
        w = lift_rule_direct(calm, q)
        ok6 = (ok6 and simulate_rsi(resample_session(calm, 15), 15, q, full=True)['lifts'] == w
               and simulate_rsi(calm, 1, q, full=True)['lifts'] == w)
        life.append(len(w))
    ok6 = ok6 and 0 < life[1] < life[0]
    print(f"RSI dip's LIFT (v38), 4% above the DIP: {len(want_l)} of {len(d['dips'])} DIPs reach it by the plain rule; the script: {', '.join(shown_l)}; "
          f"on a 15m close instead of a touch {len(by_close)}; off none; on a calmer tape, 5% up: {life[0]} with no limit, {life[1]} when the level "
          f"lives one session (the 15m and 1m charts agree)", '→', 'OK' if ok6 else 'UNEXPECTED')
    # v39 MACD after a DIP: for each DIP the first MACD candle closing after its candle at whose close the
    # line is above zero after being at or under it, until the next DIP — the plain rule on the 1m bars
    # against the script on every chart that can show it (the same candle, DIP and number), for a 5m, a
    # 3m and a 15m MACD; then the wait's life in sessions, a chart too big for it, off
    ok7, shown_m, late_m = True, [], 0
    for mm, charts in ((5, (5, 1)), (3, (3, 1)), (15, (15, 5, 3, 1))):
        pm = dict(p3, macd_min=mm, macd_life=0)
        want_m = macd_rule_direct(bars, pm)
        ok7 = ok7 and 5 <= len(want_m) <= len(d['dips']) and len({t for t, _, _ in want_m}) == len(want_m)
        got = []
        for cm in charts:
            g = simulate_rsi(resample_session(bars, cm) if cm > 1 else bars, cm, pm, full=True)
            ok7 = ok7 and [(t, base, n) for t, _, base, n in g['macds']] == want_m
            got.append(f"{cm}m {len(g['macds'])}")
            if cm == 1:
                late_m += sum(1 for x in g['macds'] if x[1])
                ok7 = ok7 and g['late_m'] > 0
            else:
                ok7 = ok7 and (cm < mm or not any(x[1] for x in g['macds']))
        shown_m.append(f"{mm}m MACD {len(want_m)} ({', '.join(got)})")
    p5 = dict(p3, macd_min=5, macd_life=0)
    on = lambda cm, q, tape=bars: simulate_rsi(resample_session(tape, cm) if cm > 1 else tape, cm, q, full=True)['macds']
    ok7 = (ok7 and late_m > 0 and on(15, p5) == [] and on(5, dict(p5, macd=False)) == []
           and any(n == 2 for _, _, n in macd_rule_direct(bars, p5)))
    # the wait's life: a slow line (150 / 400 on 5m candles), which can take more than a session to cross
    life_m = []
    for tape, lens in ((bars, (150, 400)), (bars, (12, 26)), (calm, (12, 26))):
        for days in (0, 1):
            q = dict(p5, macd_fast=lens[0], macd_slow=lens[1], macd_life=days)
            w = macd_rule_direct(tape, q)
            ok7 = ok7 and all([(t, base, n) for t, _, base, n in on(cm, q, tape)] == w for cm in (5, 1))
            life_m.append(len(w))
    ok7 = ok7 and 0 < life_m[1] < life_m[0] and life_m[3] <= life_m[2] and life_m[5] <= life_m[4]
    print(f"RSI dip's MACD (v39), the line over zero after a DIP, of {len(d['dips'])} DIPs by the plain rule and the script: {'; '.join(shown_m)}; "
          f"{late_m} of the 1m charts' marks a bar late; none on a 15m chart with a 5m MACD, none when off; a wait of one session "
          f"after the DIP's own: a slow line (150 / 400) {life_m[1]} of {life_m[0]}, 12 / 26 {life_m[3]} of {life_m[2]}, on the calmer tape "
          f"{life_m[5]} of {life_m[4]} (the 5m and 1m charts agree)", '→', 'OK' if ok7 else 'UNEXPECTED')
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
    return ok and ok2 and ok3 and ok4 and ok6 and ok7


# ── EMA cross over VWAP (script v35), and the band in the EMA's place (v40) ────
# The EMA of a timeframe's closes (3m, length 9) against the session VWAP, judged at each close of
# that timeframe's candles: above the line now, at or under it at the close before. As the RSI, the
# script reads the EMA after the last finished candle (request.security, lookahead on + [1]) and
# adds the chart bar's close; a candle whose closing bar had no trades is sampled on the next bar,
# but not announced across the day's end. The day's first candle can't fire (the line restarts).
# v36, the filter: a cross is weak when its candle opened before `from_hour` (New York), when the EMA
# had been at or under the line for fewer than `min_under` candles, or when the two crossed more than
# `max_flips` times in the 20 candles before. A weak cross is still sent (`| weak`), takes no day's
# number, and the server keeps it quiet. Measured in ../ema-vwap/.
# v37, the BOUNCE: a sent cross starts a wait of `wait` candles. A candle's low comes down to the EMA
# (within `tol_e` % above it) or the VWAP (within `tol_v` %), and that candle or a later one closes
# green above the EMA → BOUNCE, the stop under the lowest low since the touch. A close under the VWAP
# first ends the wait; a newer cross starts it over. A bounce after a weak cross is weak.
# v40, the line that crosses: `src` 'ema', or 'bb' for the upper Bollinger Band — the VB's band, built
# from the alert timeframe's bars (`base_min`; 30s in the script, 1m here): the last bb_n − 1 finished
# closes of bb_min candles plus the forming one. The same rule, filter and numbers on the band's own
# state; no bounce (it is the EMA's). The script's "Both" runs the two side by side, each on its own.
# v41, `bb_mid`: a band cross whose candle closed under the band's middle line (the band widened on a
# fast drop and rose over the VWAP while the price fell away) is weak, whatever the v36 filter says.
# v42, `src` 'bs': the basis (middle line) of a band of its own — the last bs_n − 1 finished closes of
# bs_min candles plus the forming one, averaged (bs_n 1 = the close). The band cross's rule on its own
# state; no middle-line test and no bounce.
EMA_DEFAULTS = dict(tf_min=3, n=9, filter=True, min_under=5, max_flips=2, from_hour=7,
                    bounce=True, wait=10, tol_e=0.0, tol_v=1.0, from_ema=True, from_vwap=True,
                    src='ema', base_min=1, bb_min=1, bb_n=20, bb_mult=2.0, bb_mid=True, bs_min=1, bs_n=10)


def _line_params(p):
    """→ (the crossing line's band timeframe and length as bb_min / bb_n, which of the pair
    bb_upper_series returns is the line: 0 the upper band, 1 the average) for src 'bb' / 'bs'."""
    if p['src'] == 'bs':
        return dict(p, bb_min=p['bs_min'], bb_n=p['bs_n']), 1
    return p, 0


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


def bb_upper_series(base_bars, p):
    """The script's emBand per bar of the alert timeframe: the BB timeframe's last bb_n − 1 finished
    closes plus this bar's close → (mean + bb_mult × their (population) standard deviation, the mean:
    v41's middle line); (None, None) until it has them. A BB candle is finished when a bar starts a
    new one (timeframe.change)."""
    out, closes, last_c, prev_bt = [], [], None, None
    for b in base_bars:
        bt = _candle_start(b['t'], p['bb_min'])
        if prev_bt is not None and bt != prev_bt and last_c is not None:
            closes.append(last_c)
            if len(closes) > p['bb_n'] - 1:
                closes.pop(0)
        last_c, prev_bt = b['c'], bt
        band = (None, None)
        if len(closes) == p['bb_n'] - 1:
            vals = closes + [b['c']]
            mean = sum(vals) / p['bb_n']
            band = (mean + p['bb_mult'] * (sum((v - mean) ** 2 for v in vals) / p['bb_n']) ** 0.5, mean)
        out.append(band)
    return out


def _band_at(base_bars, p, minutes):
    """{start of each `minutes` bar: (the band, its middle line) at its last bar of the alert
    timeframe} — what a bigger chart reads from its replay of those bars (the band at the chart
    bar's close)."""
    return {_candle_start(b['t'], minutes): v for b, v in zip(base_bars, bb_upper_series(base_bars, p))}


def _band_drop(p, close, mid):
    """v41, the script's `drop`: with bb_mid on, a band cross whose candle closed under the band's
    middle line (the band widened on a drop) is weak."""
    return p['bb_mid'] and mid is not None and close is not None and close < mid


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
        self.armed = self.hitE = self.hitV = self.weakX = False   # v37, the wait for a bounce
        self.age = self.bn = 0
        self.lowP = None

    def arm(self, weak):
        self.armed, self.age, self.hitE, self.hitV, self.lowP, self.weakX = True, 0, False, False, None, weak

    def step_bounce(self, e, ln, c_open, c_low, c_close, p):
        go = False
        if self.armed and e is not None and ln is not None and c_open is not None and c_low is not None:
            self.age += 1
            if p['from_ema'] and c_low <= e * (1 + p['tol_e'] / 100):
                self.hitE = True
            if p['from_vwap'] and c_low <= ln * (1 + p['tol_v'] / 100):
                self.hitV = True
            if self.hitE or self.hitV:
                self.lowP = c_low if self.lowP is None else min(self.lowP, c_low)
            if c_close < ln:
                self.armed = False
            elif (self.hitE or self.hitV) and c_close > c_open and c_close > e:
                go, self.armed = True, False
            elif self.age >= p['wait']:
                self.armed = False
        return go

    def came_from(self):
        return 'ema+vwap' if self.hitE and self.hitV else 'ema' if self.hitE else 'vwap'

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
        self.armed = False


def ema_rule_direct(bars, p=None):
    """The plain rule on the EMA timeframe's own candles (`bars` carry 'vw'): the EMA closes above
    the session VWAP after closing at or under it, the day's first candle excluded. The filter's
    readings are taken from the day's candles directly, as the study does (ema_vwap_study.py).
    With src 'bb' (v40) the line that crosses is the band as it stands at each candle's close; `bars`
    are then the alert timeframe's.
    → [(candle start, the day's number, the candle is its day's last, under, flips, weak)]."""
    p = dict(EMA_DEFAULTS, **(p or {}))
    c = resample_vw(bars, p['tf_min'])
    mids = [None] * len(c)
    if p['src'] in ('bb', 'bs'):
        q, k = _line_params(p)
        band = _band_at(bars, q, p['tf_min'])
        e = [band.get(x['t'], (None, None))[k] for x in c]
        if p['src'] == 'bb':                                   # v41's middle-line test is the band's alone
            mids = [band.get(x['t'], (None, None))[1] for x in c]
    else:
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
            weak = _ema_weak(p, x['t'].hour, under, flips) or _band_drop(p, x['c'], mids[i])
            if not weak:
                n += 1
            last = i + 1 == len(c) or c[i + 1]['t'].date() != day
            out.append((x['t'], n, last, under, flips, weak))
        seen.append((e[i], x['vw']))
    return out


def ema_bounce_direct(bars, p=None):
    """The plain bounce rule (v37) on the EMA timeframe's own candles: for each cross, the candles
    after it until a bounce, a close under the VWAP, `wait` candles, a newer cross or the day's end.
    → [(candle start, the day's number, the candle is its day's last, the pullback's low, candles
    after the cross, 'ema' | 'vwap' | 'ema+vwap', weak)]. None after a band's cross (v40)."""
    p = dict(EMA_DEFAULTS, **(p or {}))
    if p['src'] in ('bb', 'bs'):
        return []
    c = resample_vw(bars, p['tf_min'])
    e = ema_series([x['c'] for x in c], p['n'])
    idx = {x['t']: i for i, x in enumerate(c)}
    crosses = [(idx[t], weak) for t, _, _, _, _, weak in ema_rule_direct(bars, p)]
    cross_at = {i for i, _ in crosses}
    out, day, bn = [], None, 0
    for i, weak in crosses:
        d = c[i]['t'].date()
        if d != day:
            day, bn = d, 0
        hit_e = hit_v = False
        low_p, age = None, 0
        for j in range(i + 1, len(c)):
            x = c[j]
            if x['t'].date() != d:
                break
            if e[j] is None or x['vw'] is None:
                continue
            age += 1
            hit_e = hit_e or (p['from_ema'] and x['l'] <= e[j] * (1 + p['tol_e'] / 100))
            hit_v = hit_v or (p['from_vwap'] and x['l'] <= x['vw'] * (1 + p['tol_v'] / 100))
            if hit_e or hit_v:
                low_p = x['l'] if low_p is None else min(low_p, x['l'])
            if x['c'] < x['vw']:
                break
            if (hit_e or hit_v) and x['c'] > x['o'] and x['c'] > e[j]:
                if not weak:
                    bn += 1
                last = j + 1 == len(c) or c[j + 1]['t'].date() != d
                out.append((x['t'], bn, last, low_p, age, 'ema+vwap' if hit_e and hit_v else 'ema' if hit_e else 'vwap', weak))
                break
            if age >= p['wait'] or j in cross_at:
                break
    return out


def simulate_ema(bars, chart_min, p=None, fine=None, full=False):
    """The script's EMA section (v35, v36's filter) on chart bars of `chart_min` minutes carrying 'vw' →
    [(candle start, late, the day's number, under, flips, weak)]. `fine`: the bars the EMA's candles
    are really made of, for a chart of the EMA's own timeframe built from smaller bars.
    `full`: → (those crosses, the v37 bounces [(candle start, late, the day's number, the pullback's
    low, candles after the cross, what it came down to, weak)]).
    With src 'bb' (v40, the script's section 4b) the sampled line is the band at each chart bar's
    close: the chart's own bars on a chart of the alert timeframe, `fine` (the alert timeframe's
    bars, replayed) on a bigger one; no bounces."""
    p = dict(EMA_DEFAULTS, **(p or {}))
    if not (chart_min <= p['tf_min'] and p['tf_min'] % chart_min == 0):
        return ([], []) if full else []
    by_band = p['src'] in ('bb', 'bs')          # the band (v40) or the basis of the separate band (v42)
    if by_band:
        q, line_k = _line_params(p)
        # the script's emBbOk / bsBbOk: a chart of the alert timeframe or a multiple of it, a band timeframe no smaller
        if not (chart_min >= p['base_min'] and chart_min % p['base_min'] == 0 and q['bb_min'] >= p['base_min']):
            return ([], []) if full else []
        band_at = _band_at(fine if chart_min > p['base_min'] else bars, q, chart_min)
    c = resample_vw(fine or bars, p['tf_min'])
    e_after = ema_series([x['c'] for x in c], p['n'])
    starts = [x['t'] for x in c]
    alpha = 2.0 / (p['n'] + 1)
    line, out, bounces, done = _EmaLine(), [], [], None
    prev_live = prev_vw = prev_t = prev_day = prev_c = None
    mid = prev_mid = None           # v41: the band's middle line at this chart bar, and at the one before
    co = cl = cop = clp = None      # the EMA candle's open and low so far, and the candle before's
    step = datetime.timedelta(minutes=chart_min)
    j = 0   # finished EMA candles before the current chart bar's candle
    for b in bars:
        t = b['t']
        ct = _candle_start(t, p['tf_min'])
        while j < len(starts) and starts[j] < ct:
            j += 1
        live = alpha * b['c'] + (1 - alpha) * e_after[j - 1] if j >= 1 and e_after[j - 1] is not None else None
        if by_band:
            pair = band_at.get(_candle_start(t, chart_min), (None, None))
            live = pair[line_k]                                   # the line that crosses: the band, or the basis
            mid = pair[1] if p['src'] == 'bb' else None           # the middle-line test is the band's alone
        new_day = prev_day is not None and t.date() != prev_day
        if prev_t is None or ct != prev_t:
            cop, clp, co, cl = co, cl, b['o'], b['l']
        else:
            cl = min(cl, b['l'])
        if prev_t is not None and ct != prev_t and done != prev_t:      # the candle before, from the bar before
            # v37: an earlier cross's bounce first (a cross candle can't be its own bounce)
            if p['bounce'] and not by_band and line.step_bounce(prev_live, prev_vw, cop, clp, prev_c, p) and not new_day:
                if not line.weakX:
                    line.bn += 1
                bounces.append((prev_t, True, line.bn, line.lowP, line.age, line.came_from(), line.weakX))
            fired = line.cross_up(prev_live, prev_vw)
            done = prev_t
            if fired and not new_day:
                weak = _ema_weak(p, prev_t.hour, line.ran, line.flips)     # the candle's own hour, by its open
                weak = weak or (by_band and _band_drop(p, prev_c, prev_mid))
                if not weak:
                    line.n += 1
                out.append((prev_t, True, line.n, line.ran, line.flips, weak))
                line.arm(weak)
        if new_day:
            line.restart()
            line.n = line.bn = 0
        ends = _candle_start(t + step, p['tf_min']) != ct or chart_min >= p['tf_min']
        if ends and done != ct:
            if p['bounce'] and not by_band and line.step_bounce(live, b['vw'], co, cl, b['c'], p):
                if not line.weakX:
                    line.bn += 1
                bounces.append((ct, False, line.bn, line.lowP, line.age, line.came_from(), line.weakX))
            fired = line.cross_up(live, b['vw'])
            done = ct
            if fired:
                weak = _ema_weak(p, ct.hour, line.ran, line.flips) or (by_band and _band_drop(p, b['c'], mid))
                if not weak:
                    line.n += 1
                out.append((ct, False, line.n, line.ran, line.flips, weak))
                line.arm(weak)
        prev_live, prev_vw, prev_t, prev_day, prev_c, prev_mid = live, b['vw'], ct, t.date(), b['c'], mid
    return (out, bounces) if full else out


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
    # v37, the BOUNCE: for each cross, the plain rule's bounce against the script's sampling
    wantb = ema_bounce_direct(fine)
    _, b3 = simulate_ema(resample_vw(fine, 3), 3, fine=fine, full=True)
    _, b1 = simulate_ema(fine, 1, full=True)
    bkey = lambda got: [(t, n, lo, age, frm, w) for t, _, n, lo, age, frm, w in got]
    all_b = [(t, n, lo, age, frm, w) for t, n, _, lo, age, frm, w in wantb]
    end_b = {(t, n, lo, age, frm, w) for t, n, last, lo, age, frm, w in wantb if last}
    drop_b = [x for x in all_b if x not in bkey(b1)]
    weak_b = sum(1 for x in all_b if x[5])
    late_b = sum(1 for _, late, *_ in b1 if late)
    cross_t = {t for t, *_ in wantf}
    only_e = ema_bounce_direct(fine, dict(from_vwap=False))
    only_v = ema_bounce_direct(fine, dict(from_ema=False))
    short = ema_bounce_direct(fine, dict(wait=1))
    ok6 = (len(all_b) >= 15 and bkey(b3) == all_b and not any(late for _, late, *_ in b3)
           and [x for x in all_b if x not in drop_b] == bkey(b1) and all(x in end_b for x in drop_b)
           and 0 < weak_b < len(all_b) and len(all_b) < len(all_f)
           and all(1 <= age <= 10 and lo is not None for _, _, lo, age, _, _ in all_b)
           and {frm for *_, frm, _ in all_b} <= {'ema', 'vwap', 'ema+vwap'}
           and all(frm == 'ema' for *_, frm, _ in only_e) and all(frm == 'vwap' for *_, frm, _ in only_v)
           and 0 < len(short) < len(all_b) and all(age == 1 for *_, age, _, _ in short)
           and simulate_ema(fine, 1, dict(bounce=False), full=True)[1] == []
           and bkey(simulate_ema(resample_vw(fine, 3), 3, dict(from_vwap=False), fine=fine, full=True)[1])
           == [(t, n, lo, age, frm, w) for t, n, _, lo, age, frm, w in only_e])
    on_cross = sum(1 for t, *_ in all_b if t in cross_t)
    print(f'…the bounce (v37): {len(all_b)} bounces after {len(all_f)} crosses by the plain rule ({weak_b} after a weak cross; '
          f'EMA only {len(only_e)}, VWAP only {len(only_v)}, a 1-candle wait {len(short)}); the script gives the same ones, lows and counts on the 3m chart '
          f'and on the 1m chart ({late_b} a bar late, {len(drop_b)} on a day\'s last candle not announced; {on_cross} on a newer cross\'s candle)',
          '→', 'OK' if ok6 else 'UNEXPECTED')
    # v40, the band as the line that crosses: the plain rule on the 1m bars (the alert timeframe here)
    # against the script on a 3m chart (replaying them) and on the 1m chart — the same crosses, numbers,
    # readings and verdicts, with a 1m band and with a 2m band built from the 1m bars; never a bounce;
    # no marks on a chart the band isn't right on
    ok7, shown_b = True, []
    ema_t = {t for t, *_ in wantf}
    for bb_min in (1, 2):
        q = dict(src='bb', bb_min=bb_min, bb_mid=False)     # v40's rule (v41's middle-line test is below)
        wantq = ema_rule_direct(fine, q)
        q3, bq3 = simulate_ema(resample_vw(fine, 3), 3, q, fine=fine, full=True)
        q1, bq1 = simulate_ema(fine, 1, q, full=True)
        all_q = [(t, n, u, f, w) for t, n, _, u, f, w in wantq]
        end_q = {(t, n, u, f, w) for t, n, last, u, f, w in wantq if last}
        drop_q = [x for x in all_q if x not in full(q1)]
        weak_q = sum(1 for x in all_q if x[4])
        late_q = sum(1 for _, late, *_ in q1 if late)
        ok7 = (ok7 and len(all_q) >= 20 and full(q3) == all_q and not any(late for _, late, *_ in q3)
               and [x for x in all_q if x not in drop_q] == full(q1) and all(x in end_q for x in drop_q) and late_q > 0
               and bq3 == [] and bq1 == [] and ema_bounce_direct(fine, q) == []
               and 0 < weak_q < len(all_q) and {t for t, *_ in all_q} != ema_t
               and all(w == (t.hour < 7 or u < 5 or f > 2) for t, _, u, f, w in all_q))
        shown_b.append(f"a {bb_min}m band {len(all_q)} crosses ({weak_q} weak; 3m chart {len(q3)}, 1m chart {len(q1)}, {late_q} a bar late, "
                       f"{len(drop_q)} on a day's last candle not announced)")
    ok7 = (ok7 and simulate_ema(fine, 1, dict(src='bb', base_min=3, bb_min=3)) == []                      # a chart under the alert timeframe
           and simulate_ema(resample_vw(fine, 3), 3, dict(src='bb', base_min=3, bb_min=1), fine=fine) == []   # a band timeframe under it
           and simulate_ema(resample_vw(fine, 5), 5, dict(src='bb'), fine=fine) == [])                    # a chart that doesn't divide the candle
    print(f"…the band as the line (v40), 20 closes and 2 st. dev. from the 1m bars, judged at the 3m close: {'; '.join(shown_b)}; "
          f"the script gives the plain rule's crosses, numbers and verdicts on both charts, and no bounce", '→', 'OK' if ok7 else 'UNEXPECTED')
    # v41, the middle-line test: the same crosses; one whose candle closed under the band's middle line
    # is weak as well (the band widened on a drop), so the strong ones are renumbered. The plain rule's
    # verdicts and numbers against the script's on both charts, with a 1m and a 2m band.
    ok8, shown_m = True, []
    for bb_min in (1, 2):
        off = ema_rule_direct(fine, dict(src='bb', bb_min=bb_min, bb_mid=False))
        qm = dict(src='bb', bb_min=bb_min)                  # bb_mid on, the default
        wantm = ema_rule_direct(fine, qm)
        m3 = simulate_ema(resample_vw(fine, 3), 3, qm, fine=fine)
        m1 = simulate_ema(fine, 1, qm)
        all_m = [(t, n, u, f, w) for t, n, _, u, f, w in wantm]
        end_m = {(t, n, u, f, w) for t, n, last, u, f, w in wantm if last}
        drop_m = [x for x in all_m if x not in full(m1)]
        weak_off = {t for t, _, _, _, _, w in off if w}
        weak_on = {t for t, _, _, _, w in all_m if w}
        by_drop = weak_on - weak_off
        days_m = {}
        for t, n, _, _, w in all_m:
            if not w:
                days_m.setdefault(t.date(), []).append(n)
        # the test alone (the v36 filter off): every weak one is a close under the middle
        alone = dict(qm, filter=False)
        wanta = ema_rule_direct(fine, alone)
        a3 = simulate_ema(resample_vw(fine, 3), 3, alone, fine=fine)
        a1 = simulate_ema(fine, 1, alone)
        all_a = [(t, n, u, f, w) for t, n, _, u, f, w in wanta]
        end_a = {(t, n, u, f, w) for t, n, last, u, f, w in wanta if last}
        drop_a = [x for x in all_a if x not in full(a1)]
        under_mid = sum(1 for x in all_a if x[4])
        ok8 = (ok8 and [t for t, *_ in all_m] == [t for t, *_ in off] and weak_off <= weak_on
               and len(weak_on) < len(all_m) and full(m3) == all_m
               and [x for x in all_m if x not in drop_m] == full(m1) and all(x in end_m for x in drop_m)
               and all(ns == list(range(1, len(ns) + 1)) for ns in days_m.values())
               and [t for t, *_ in all_a] == [t for t, *_ in off] and 0 < under_mid < len(all_a) and full(a3) == all_a
               and [x for x in all_a if x not in drop_a] == full(a1) and all(x in end_a for x in drop_a)
               and by_drop <= {t for t, _, _, _, w in all_a if w})
        shown_m.append(f"a {bb_min}m band {under_mid} of {len(all_a)} crosses closed under the middle; with the v36 filter {len(weak_on)} weak ({len(by_drop)} of them by this test alone)")
    print(f"…the band's middle line (v41), a cross whose candle closed under it is weak: {'; '.join(shown_m)}; "
          f"the same crosses, the script's verdicts and numbers the plain rule's on the 3m and 1m charts", '→', 'OK' if ok8 else 'UNEXPECTED')
    # v42, the basis of a separate band as the line that crosses: the average of the band timeframe's last
    # closes (10 by default; 2; 1 = the close itself), a 1m and a 2m band. The plain rule against the
    # script on the 3m and 1m charts; no bounce; the middle-line test doesn't apply.
    ok9, shown_s = True, []
    band_t = {t for t, *_ in ema_rule_direct(fine, dict(src='bb'))}
    for bs_min, bs_n in ((1, 10), (1, 2), (1, 1), (2, 10)):
        q = dict(src='bs', bs_min=bs_min, bs_n=bs_n)
        wants = ema_rule_direct(fine, q)
        s3, bs3 = simulate_ema(resample_vw(fine, 3), 3, q, fine=fine, full=True)
        s1, bs1 = simulate_ema(fine, 1, q, full=True)
        all_s = [(t, n, u, f, w) for t, n, _, u, f, w in wants]
        end_s = {(t, n, u, f, w) for t, n, last, u, f, w in wants if last}
        drop_s = [x for x in all_s if x not in full(s1)]
        ok9 = (ok9 and len(all_s) >= 20 and full(s3) == all_s and not any(late for _, late, *_ in s3)
               and [x for x in all_s if x not in drop_s] == full(s1) and all(x in end_s for x in drop_s)
               and bs3 == [] and bs1 == [] and ema_bounce_direct(fine, q) == []
               and {t for t, *_ in all_s} != ema_t and {t for t, *_ in all_s} != band_t
               and all(w == (t.hour < 7 or u < 5 or f > 2) for t, _, u, f, w in all_s)       # no middle-line test
               and full(simulate_ema(fine, 1, dict(q, bb_mid=False))) == full(s1))
        shown_s.append(f"a {bs_min}m band of {bs_n} {len(all_s)} crosses ({sum(1 for x in all_s if x[4])} weak)")
    # with a length of 1 the basis is the close: the candle's close crossing the VWAP
    c3 = resample_vw(fine, 3)
    px_cross = [x['t'] for i, x in enumerate(c3) if i > 0 and c3[i - 1]['t'].date() == x['t'].date() and x['vw'] is not None
                and c3[i - 1]['vw'] is not None and x['c'] > x['vw'] and c3[i - 1]['c'] <= c3[i - 1]['vw']]
    ok9 = (ok9 and [t for t, *_ in ema_rule_direct(fine, dict(src='bs', bs_n=1))] == px_cross
           and simulate_ema(fine, 1, dict(src='bs', base_min=3, bs_min=3)) == []
           and simulate_ema(resample_vw(fine, 3), 3, dict(src='bs', base_min=3, bs_min=1), fine=fine) == []
           and simulate_ema(resample_vw(fine, 5), 5, dict(src='bs'), fine=fine) == [])
    print(f"…the basis of a separate band (v42), judged at the 3m close: {'; '.join(shown_s)}; a length of 1 gives the close's own crosses "
          f"of the VWAP ({len(px_cross)}); the script gives the plain rule's crosses, numbers and verdicts on the 3m and 1m charts, and no bounce",
          '→', 'OK' if ok9 else 'UNEXPECTED')
    return ok and first_of_day == 0 and ok5 and ok6 and ok7 and ok8 and ok9


# ── TURN: the bounce off a basis that has turned up (script v47, its section 8) ─
# On the candles of the basis's own timeframe (the script runs it only on a chart of that timeframe:
# no request and no sampling, so the bars given here are the candles):
#   break    a close above the basis (the SMA of the last `len` closes) after a close at or under it
#   touch    on a later candle, within `wait`, the low comes down to the basis (within `tol` % above it)
#   bounce   that candle or a later one (still within `wait`) closes green and above the basis, the
#            basis above its value a candle before and (`macd_on`) the MACD's histogram above zero.
#            A close under the basis first ends the wait; one bounce per break
#   TURN     a bounce after the basis fell: its lowest value in the 31 candles to the bounce is no older
#            than `low_bars` candles and at least `fall_min` % under its highest value in the 46 candles
#            up to that low (`fall_min` 0 = no fall needed). A bounce without that fall uses up its break
# The gainer filter and the alert window are the caller's (gainer_of / in_window_of, default: always).
# Taken from TradingView's built-ins, not from the script's text — where to look first if a chart
# disagrees with this file:
#   ta.ema        seeded with the SMA of its first `length` values, na before (ema_series)
#   ta.macd       the signal line is the ta.ema of the MACD line from that line's first value on
#   ta.lowest / ta.highest / ta.lowestbars    na until the window is full of non-na values (_ta_window)
#   ta.lowestbars on equal lowest values      the most recent one (_lowestbars_tie)
#   a comparison with na is false (the histogram before it exists is not green)
#   timeframe.change("D")                     a bar whose calendar day, in the bars' own times, is not the bar before's
TURN_DEFAULTS = dict(len=15, fall_min=10.0, low_bars=15, tol=1.0, wait=10, macd_on=True, fast=12, slow=26, sig=9)
TURN_LOW_WIN, TURN_PEAK_WIN = 31, 46   # the script's literals: ta.lowestbars / ta.lowest(tnB, 31), ta.highest(tnB, 46)


def sma_series(vals, n):
    """TradingView's ta.sma per value: the mean of the last n; None until n exist."""
    return [sum(vals[i + 1 - n:i + 1]) / n if i + 1 >= n else None for i in range(len(vals))]


def macd_hist_series(closes, fast, slow, sig):
    """ta.macd's histogram per close: the MACD line (ta.ema fast − ta.ema slow) less its signal line,
    the ta.ema of the line's own values from its first one; None until the signal line exists."""
    ef, es = ema_series(closes, fast), ema_series(closes, slow)
    line = [None if a is None or b is None else a - b for a, b in zip(ef, es)]
    first = next((i for i, v in enumerate(line) if v is not None), len(line))
    signal = [None] * first + ema_series(line[first:], sig)
    return [None if s is None else m - s for m, s in zip(line, signal)]


def _lowestbars_tie(agos):
    """ta.lowestbars' tie rule, stated in this one place: when the window's lowest value stands on
    several bars, which of them (given as bars ago) the built-in reports. ASSUMED the most recent,
    the smallest bars-ago; TradingView's reference doesn't say. `max` would be the other rule (the
    oldest). simulate_turn and turn_rule_direct both take the tie from here."""
    return min(agos)


def _ta_window(vals, i, n):
    """The n values to bar i as ta.lowest / ta.highest / ta.lowestbars see them, or None while one is
    missing (ASSUMED: those built-ins are na until the window is full of non-na values)."""
    if i + 1 < n:
        return None
    w = vals[i + 1 - n:i + 1]
    return None if None in w else w


def lowest_ago(vals, i, n):
    """The script's −ta.lowestbars(vals, n) at bar i: how many bars ago the lowest of the n values to
    bar i stands (0 = on bar i itself); None while ta.lowestbars is na."""
    w = _ta_window(vals, i, n)
    if w is None:
        return None
    low = min(w)
    return _lowestbars_tie([n - 1 - k for k, v in enumerate(w) if v == low])


def simulate_turn(bars, p=None, tick=0.01, gainer_of=None, in_window_of=None):
    """The script's TURN section (v47), statement for statement, on the bars of the setup's own
    timeframe (dicts with 't', 'o', 'h', 'l', 'c'; the script's tnRun is taken as true).
    `tick` = syminfo.mintick; gainer_of(bar) / in_window_of(bar) → bool stand for the script's
    `(not tnGainOn or gainer)` and `inWindow` (default: always true).
    → the TURNs: [{'t', 'close', 'stop', 'basis', 'fall_pct' (None when the script sends no `fall`),
    'turn_n', 'since', 'green'}], the message's fields."""
    p = dict(TURN_DEFAULTS, **(p or {}))
    closes = [b['c'] for b in bars]
    basis = sma_series(closes, p['len'])                                    # tnB
    hist = macd_hist_series(closes, p['fast'], p['slow'], p['sig'])         # tnHist
    high46 = []                                                             # tnHigh46, per bar
    for i in range(len(bars)):
        w = _ta_window(basis, i, TURN_PEAK_WIN)
        high46.append(None if w is None else max(w))
    waiting, break_bar, pb_low, touched, count = False, None, None, False, 0   # the script's `var`s
    out, prev_day = [], None
    for i, b in enumerate(bars):
        o, low, c, tb = b['o'], b['l'], b['c'], basis[i]
        green = hist[i] is not None and hist[i] > 0                         # tnGreen
        low_ago = lowest_ago(basis, i, TURN_LOW_WIN)                        # tnLowAgo
        w = _ta_window(basis, i, TURN_LOW_WIN)
        low_val = None if w is None else min(w)                             # tnLowVal
        peak = high46[i - low_ago] if low_ago is not None else None         # tnPeak = tnHigh46[tnLowAgo]
        fall_pct = (1 - low_val / peak) * 100 if peak is not None and peak > 0 else None
        fell = p['fall_min'] <= 0 or (fall_pct is not None and low_ago <= p['low_bars'] and fall_pct >= p['fall_min'])
        gainer = True if gainer_of is None else bool(gainer_of(b))
        in_window = True if in_window_of is None else bool(in_window_of(b))
        new_day = prev_day is not None and b['t'].date() != prev_day        # newDay
        prev_day = b['t'].date()
        if new_day:
            count = 0
            waiting = False
        fire, stop, age = False, None, None
        if tb is not None and i >= 1 and basis[i - 1] is not None:
            rising = tb > basis[i - 1]
            if waiting:
                if c < tb:
                    waiting = False
                else:
                    pb_low = min(pb_low, low)
                    if low <= tb * (1 + p['tol'] / 100):
                        touched = True
                    if touched and c > o and c > tb and rising and (not p['macd_on'] or green):
                        # the bounce: it uses up the break, whether or not the fall and the filters let it send
                        waiting = False
                        if fell and in_window and gainer:
                            fire = True
                            stop = pb_low - tick
                            age = i - break_bar
                            count += 1
                    elif i - break_bar >= p['wait']:
                        waiting = False
            if not waiting and not fire and c > tb and closes[i - 1] <= basis[i - 1]:
                waiting, break_bar, pb_low, touched = True, i, c, False
        if fire:
            out.append({'t': b['t'], 'close': c, 'stop': stop, 'basis': tb, 'fall_pct': fall_pct,
                        'turn_n': count, 'since': age, 'green': green})
    return out


def turn_rule_direct(bars, p=None, tick=0.01, gainer_of=None, in_window_of=None):
    """The TURN rule from its definitions, with none of the script's variables: the basis, the MACD
    and the fall are worked out again here, and each candle is judged by looking back from it.
      a crossing   a close above the basis, the close before at or under its own basis
      its wait     the candles after it, up to and including the first that closes under the basis,
                   is a bounce, or is the `wait`-th; a new day's first candle ends it and is not in it
      a bounce     a green close above a basis that is above its value a candle before, the MACD's
                   histogram above zero (`macd_on`), a low at or under basis × (1 + `tol` %) on that
                   candle or an earlier one of the wait
      a break      a crossing on a candle that no earlier break's wait runs past and that is no TURN
      a TURN       the bounce that ends a break's wait, when the basis fell (below), in the window,
                   on a gainer
    → the same list as simulate_turn."""
    p = dict(TURN_DEFAULTS, **(p or {}))
    n, length, wait = len(bars), p['len'], p['wait']
    o, lows, c = [b['o'] for b in bars], [b['l'] for b in bars], [b['c'] for b in bars]
    day = [b['t'].date() for b in bars]
    gain = [True if gainer_of is None else bool(gainer_of(b)) for b in bars]
    inw = [True if in_window_of is None else bool(in_window_of(b)) for b in bars]
    first = length - 1                                         # the first candle with a basis
    basis = [sum(c[i + 1 - length:i + 1]) / length if i >= first else None for i in range(n)]

    def ema(vals, m):
        """Of a list with no gaps: the mean of the first m, then each value weighted 2 / (m + 1)."""
        got, a = [], 2.0 / (m + 1)
        for i, v in enumerate(vals):
            got.append(None if i + 1 < m else sum(vals[:m]) / m if i + 1 == m else a * v + (1 - a) * got[-1])
        return got

    both = max(p['fast'], p['slow']) - 1                       # the first candle with both EMAs
    fast_e, slow_e = ema(c, p['fast']), ema(c, p['slow'])
    line = [fast_e[i] - slow_e[i] for i in range(both, n)]     # the MACD line, from its first candle
    signal = ema(line, p['sig'])
    green = [i >= both and signal[i - both] is not None and line[i - both] - signal[i - both] > 0 for i in range(n)]

    def crossing(k):
        return k > first and c[k] > basis[k] and c[k - 1] <= basis[k - 1]

    ends = {}

    def wait_end(k):
        """The wait after a crossing at k → (the candle that ends it, why)."""
        if k not in ends:
            ends[k] = (n, 'tape')
            for j in range(k + 1, n):
                if day[j] != day[k]:
                    ends[k] = (j, 'day')
                elif c[j] < basis[j]:
                    ends[k] = (j, 'under')
                elif (c[j] > o[j] and c[j] > basis[j] and basis[j] > basis[j - 1] and (green[j] or not p['macd_on'])
                      and any(lows[m] <= basis[m] * (1 + p['tol'] / 100) for m in range(k + 1, j + 1))):
                    ends[k] = (j, 'bounce')
                elif j - k >= wait:
                    ends[k] = (j, 'last')
                else:
                    continue
                break
        return ends[k]

    def fall(j):
        """→ (candles since the basis's lowest value in the 31 candles to j, how far in % that is under
        its highest value in the 46 candles to that low); None where the candles before don't reach."""
        if j - (TURN_LOW_WIN - 1) < first:
            return None, None
        span = range(j - (TURN_LOW_WIN - 1), j + 1)
        low = min(basis[m] for m in span)
        ago = _lowestbars_tie([j - m for m in span if basis[m] == low])
        at = j - ago
        if at - (TURN_PEAK_WIN - 1) < first:
            return ago, None
        peak = max(basis[m] for m in range(at - (TURN_PEAK_WIN - 1), at + 1))
        return ago, (1 - low / peak) * 100 if peak > 0 else None

    out, is_break = [], [False] * n
    for j in range(n):
        before = range(max(0, j - wait), j)                    # a wait is at most `wait` candles long
        turn = False
        k = next((k for k in before if is_break[k] and wait_end(k) == (j, 'bounce')), None)
        if k is not None:
            ago, pct = fall(j)
            fell = p['fall_min'] <= 0 or (pct is not None and ago <= p['low_bars'] and pct >= p['fall_min'])
            turn = fell and inw[j] and gain[j]
        if turn:
            out.append({'t': bars[j]['t'], 'close': c[j], 'stop': min([c[k]] + lows[k + 1:j + 1]) - tick,
                        'basis': basis[j], 'fall_pct': pct, 'turn_n': 1 + sum(1 for x in out if x['t'].date() == day[j]),
                        'since': j - k, 'green': green[j]})
        is_break[j] = crossing(j) and not turn and not any(is_break[k] and wait_end(k)[0] > j for k in before)
    return out


def _turn_tape(seed, days, day_bars, grid=None, gap=True):
    """A generated 1m tape for selftest_turn: quiet stretches, chop, slow slides, and fast drops with
    a base and a recovery after them, so breaks, touches and bounces come with and without a fall.
    `grid`: every price is a multiple of it (1/64: sums of closes are exact, so the basis can stand
    on one value for several candles and a close can sit exactly on the basis; a base is then often
    perfectly flat). `gap`: each day opens somewhere else; off, the days run on into each other."""
    import datetime as dt, math, random
    rnd = random.Random(seed)
    t0 = dt.datetime(2026, 11, 2, 4, 0, tzinfo=ET)
    snap = (lambda x: max(grid, round(x / grid) * grid)) if grid else (lambda x: x)
    bars, px, phase, left, drift, vol, fell = [], snap(4.0), 'quiet', 0, 0.0, 0.0, -0.2
    for day in range(days):
        if gap:
            px = snap(rnd.uniform(3.0, 6.0))
        for m in range(day_bars):
            while left == 0:
                phase = ('base' if phase == 'drop' else 'rise' if phase == 'base'
                         else rnd.choice(['quiet', 'chop', 'chop', 'drop', 'drop', 'drop', 'slide']))
                if px < 1.5 and phase in ('drop', 'slide'):
                    phase = 'rise'
                if phase == 'quiet':
                    left, drift, vol = rnd.randrange(5, 20), 0.0, 0.003
                elif phase == 'chop':
                    left, drift, vol = rnd.randrange(15, 45), rnd.uniform(-0.001, 0.002), 0.012
                elif phase == 'slide':
                    left = rnd.randrange(30, 60)
                    drift, vol = math.log(1 - rnd.uniform(0.05, 0.2)) / left, 0.008
                elif phase == 'drop':
                    left = rnd.randrange(6, 22)
                    fell = math.log(1 - rnd.uniform(0.08, 0.35))
                    drift, vol = fell / left, 0.006
                elif phase == 'base':
                    left, drift = rnd.randrange(0, 22), 0.0
                    vol = 0.0 if grid and rnd.random() < 0.6 else 0.004
                else:                                       # the recovery: some or all of the drop back
                    left = rnd.randrange(12, 40)
                    drift, vol = -fell * rnd.uniform(0.3, 1.2) / left, rnd.choice([0.006, 0.010, 0.014])
            left -= 1
            o = snap(px * math.exp(rnd.gauss(0, vol * 0.3)))   # a candle can open off the close before
            c = snap(px * math.exp(drift + rnd.gauss(0, vol)))
            h = max(o, c, snap(max(o, c) * (1 + abs(rnd.gauss(0, vol * 0.6)))))
            low = min(o, c, snap(min(o, c) * (1 - abs(rnd.gauss(0, vol * 0.8)))))
            bars.append({'t': t0 + dt.timedelta(days=day, minutes=m), 'o': o, 'h': h, 'l': low, 'c': c})
            px = c
    return bars


def selftest_turn():
    """TURN (v47): the script's state machine (simulate_turn) against the rule from its definitions
    (turn_rule_direct) — the same TURNs, field for field — on generated tapes: two-day tapes of
    continuous prices and of prices on a 1/64 grid (exact ties: the basis's low on several candles, a
    close on the basis), tapes cut into many short days (a new day ends a wait), and short tapes (the
    warm-up of the basis, the MACD and the 31 / 46-candle windows), under the script's defaults and
    with each dial moved."""
    import datetime as dt
    global _lowestbars_tie
    g = 1 / 64
    tapes = ([('two days', None, _turn_tape(s, 2, 700)) for s in (1, 2, 3, 4)]                 # (kind, its grid, bars)
             + [('two days', g, _turn_tape(s, 2, 700, g)) for s in (11, 12, 13, 14)]
             + [('short days', None, _turn_tape(21, 120, 20, gap=False)), ('short days', g, _turn_tape(22, 120, 20, g, gap=False))]
             + [('short', None, _turn_tape(40 + s, 1, 60 + 3 * s)) for s in range(0, 30, 2)]
             + [('short', g, _turn_tape(40 + s, 1, 60 + 3 * s, g)) for s in range(1, 30, 2)])
    cases = [('the defaults', {}), ('MACD off', dict(macd_on=False)), ('no fall needed', dict(fall_min=0)),
             ('a 5% fall', dict(fall_min=5.0)), ('the low within 5', dict(low_bars=5)),
             ('len 10', dict(len=10)), ('len 20', dict(len=20)), ('wait 3', dict(wait=3)),
             ('wait 25 + the low within 30', dict(wait=25, low_bars=30)), ('tol 0', dict(tol=0.0)), ('tol 3', dict(tol=3.0)),
             ('MACD 5 13 4', dict(fast=5, slow=13, sig=4)),
             ('MACD 26 12 9 (upside down) + no fall', dict(fall_min=0, fast=26, slow=12)),
             ('len 5 + wait 30 + MACD off + no fall', dict(fall_min=0, macd_on=False, len=5, wait=30)),
             ('len 2 + wait 1 + tol 0 + no fall', dict(fall_min=0, len=2, wait=1, tol=0.0))]
    same, got = True, {}
    for label, q in cases:
        got[label] = []
        for _, _, bars in tapes:
            a = simulate_turn(bars, q)
            same = same and a == turn_rule_direct(bars, q)
            got[label].append(a)
    base = got['the defaults']
    count = {label: sum(len(a) for a in runs) for label, runs in got.items()}
    total = sum(count.values())
    moved_dial = all(count[label] > 0 and (label == 'the defaults' or runs != base) for label, runs in got.items())
    # the day's number: 1, 2, … on each day of each tape; TURNs on both days of a two-day tape
    numbered, second, twice = True, 0, 0
    for runs in got.values():
        for (kind, _, bars), a in zip(tapes, runs):
            by_day = {}
            for x in a:
                by_day.setdefault(x['t'].date(), []).append(x['turn_n'])
            numbered = numbered and all(ns == list(range(1, len(ns) + 1)) for ns in by_day.values())
            twice += sum(1 for ns in by_day.values() if len(ns) > 1)
            if kind == 'two days':
                second += sum(1 for x in a if x['t'].date() != bars[0]['t'].date())
    # a gainer filter and an alert window, applied where the script applies them: a bounce they stop
    # still uses up its break, and (the third setting: a 2-close basis, where a close often sits on
    # it) its candle can be the next break
    cb = dict(gainer_of=lambda b: b['t'].minute % 3 != 0, in_window_of=lambda b: b['t'].minute % 7 != 0)
    n_cb = n_open = 0
    for q in ({}, dict(fall_min=0), dict(fall_min=0, macd_on=False, len=2, wait=3)):
        for _, _, bars in tapes:
            a = simulate_turn(bars, q, **cb)
            same = same and a == turn_rule_direct(bars, q, **cb)
            n_cb += len(a)
            n_open += len(simulate_turn(bars, q))
    # a new day ends a wait: the short-day tapes against the same candles all on one day
    cut = 0
    for kind, _, bars in tapes:
        if kind != 'short days':
            continue
        one_day = [dict(b, t=bars[0]['t'] + dt.timedelta(seconds=i)) for i, b in enumerate(bars)]
        for q in ({}, dict(fall_min=0)):
            dated, undated = simulate_turn(bars, q), simulate_turn(one_day, q)
            same = same and undated == turn_rule_direct(one_day, q)
            at = {b['t']: i for i, b in enumerate(bars)}
            kept = {(at[x['t']], x['since'], x['stop']) for x in dated}
            cut += sum(1 for x in undated if ((x['t'] - bars[0]['t']).seconds, x['since'], x['stop']) not in kept)
    # the warm-up: TURNs sent with no `fall` (the 46 candles to the low not there yet; fall_min 0 only)
    early = sum(1 for label, runs in got.items() for a in runs for x in a if x['fall_pct'] is None)
    early_ok = early > 0 and all(x['fall_pct'] is not None for label, q in cases if q.get('fall_min', 10.0) > 0
                                 for a in got[label] for x in a)
    # ties: closes exactly on the basis, and the basis's low standing on several candles — under the
    # other tie rule (the oldest) the two still agree, and the grid tapes' TURNs change; the others' don't
    on_basis = sum(1 for _, grid, bars in tapes if grid
                   for b, v in zip(bars, sma_series([x['c'] for x in bars], TURN_DEFAULTS['len'])) if v is not None and b['c'] == v)
    tie_runs = tie_moved = plain_moved = 0
    keep, _lowestbars_tie = _lowestbars_tie, max
    try:
        for label, q in cases[:6]:
            for (_, grid, bars), recent in zip(tapes, got[label]):
                a = simulate_turn(bars, q)
                same = same and a == turn_rule_direct(bars, q)
                if grid:
                    tie_runs += 1
                    tie_moved += a != recent
                else:
                    plain_moved += a != recent
    finally:
        _lowestbars_tie = keep
    ok = (same and count['the defaults'] >= 100 and total >= 1000 and moved_dial and numbered and second > 0 and twice > 0
          and 0 < n_cb < n_open and cut > 0 and early_ok and on_basis > 0 and tie_moved > 0 and plain_moved == 0)
    shown = ', '.join(f'{label} {n}' for label, n in count.items())
    print(f"TURN (v47), the bounce off a basis that fell and turned up: {total} TURNs on {len(tapes)} generated tapes "
          f"× {len(cases)} settings ({shown}); the script's state machine and the rule from its definitions give the same ones, "
          f"field for field; so do they with a gainer filter and a window ({n_cb} TURNs, {n_open} without them), and before the 46-candle "
          f"window is full ({early} sent with no fall); numbered 1, 2, … per day ({second} on a tape's second day; {cut} gone where a new day "
          f"cut the wait); ties on the grid tapes ({on_basis} closes exactly on the basis): the oldest-low rule would change {tie_moved} of "
          f"{tie_runs} of their runs and none of the other tapes'", '→', 'OK' if ok else 'UNEXPECTED')
    return ok


# ── POP and BACK: a pop off the basis and its first pullback (script v48, its section 9) ─
# On the candles of the basis's own timeframe, like TURN (no request and no sampling: the bars given
# here are the candles):
#   run      starts at a close above the basis (the SMA of the last `len` closes) when the close before
#            was at or under the basis before, or on a day's first candle that closes above it; ends at
#            a close under the basis, and at a new day
#   POP      the first candle of a run by which a high of the run has stood `up` % above its own
#            candle's basis (the run's first candle can be it). One per run; a heads-up, no entry
#   touch    on a candle after the POP candle, a low at or under basis × (1 + `tol` %)
#   BACK     that candle or a later one, at most `wait` candles after the POP candle (`wait` 0 = up to
#            the run's end): a green close above the basis, the basis above its value a candle before
#            and (`macd_on`) the MACD's histogram above zero. One per POP; the entry
#   stop     a tick under the lowest low after the candle of the run's highest high, the bounce
#            candle's low included. That high is the one standing before the bounce candle (the first
#            candle to reach it): a bounce candle that makes a new high keeps the lows before it
# The gainer filter and the alert window are the caller's (gainer_of / in_window_of, default: always),
# read at each alert's own candle: a POP or a bounce they stop is used up all the same, and only the
# alerts sent are returned and numbered (`pop_n` / `back_n`, from 1 each day).
# The built-ins are TURN's (ta.sma, ta.macd, timeframe.change("D")): see the list above TURN_DEFAULTS.
POP_DEFAULTS = dict(len=15, up=10.0, tol=1.0, wait=20, macd_on=True, fast=12, slow=26, sig=9)


def simulate_pop(bars, p=None, tick=0.01, gainer_of=None, in_window_of=None):
    """The script's POP and BACK section (v48), statement for statement, on the bars of the setup's
    own timeframe (dicts with 't', 'o', 'h', 'l', 'c'; the script's ppRun is taken as true).
    `tick` = syminfo.mintick; gainer_of(bar) / in_window_of(bar) → bool stand for the script's
    `(not ppGainOn or gainer)` and `inWindow` (default: always true).
    → the alerts in order, the messages' fields:
      {'kind': 'pop', 't', 'close', 'basis', 'ran_pct', 'pop_n'}
      {'kind': 'back', 't', 'close', 'stop', 'basis', 'ran_pct', 'back_n', 'since', 'green'}"""
    p = dict(POP_DEFAULTS, **(p or {}))
    closes = [b['c'] for b in bars]
    basis = sma_series(closes, p['len'])                                    # ppB
    hist = macd_hist_series(closes, p['fast'], p['slow'], p['sig'])         # ppHist
    in_run, ran, top, pb_low, popped = False, 0.0, None, None, False        # the script's `var`s
    waiting, pop_bar, touched, pop_n, back_n = False, None, False, 0, 0
    out, prev_day = [], None
    for i, b in enumerate(bars):
        o, h, low, c, pb = b['o'], b['h'], b['l'], b['c'], basis[i]
        green = hist[i] is not None and hist[i] > 0                         # ppGreen
        gainer = True if gainer_of is None else bool(gainer_of(b))
        in_window = True if in_window_of is None else bool(in_window_of(b))
        new_day = prev_day is not None and b['t'].date() != prev_day        # newDay
        prev_day = b['t'].date()
        if new_day:
            pop_n = 0
            back_n = 0
            in_run = False
            waiting = False
        pop_fire, back_fire, stop, age = False, False, None, None
        if pb is not None and i >= 1 and basis[i - 1] is not None:
            if in_run and c < pb:
                in_run = False
                waiting = False
            elif not in_run and c > pb and (closes[i - 1] <= basis[i - 1] or new_day):
                in_run, ran, top, pb_low, popped, waiting = True, 0.0, None, None, False, False
            if in_run:
                ran = max(ran, (h / pb - 1) * 100)
                # the pullback's low with this candle in it (read before a new high starts it over)
                low_now = low if pb_low is None else min(pb_low, low)
                if not popped:
                    if ran >= p['up']:
                        # the POP: it uses up the run, whether or not the filters let it send
                        popped, waiting, touched, pop_bar = True, True, False, i
                        if in_window and gainer:
                            pop_fire = True
                            pop_n += 1
                elif waiting:
                    if low <= pb * (1 + p['tol'] / 100):
                        touched = True
                    if touched and c > o and c > pb and pb > basis[i - 1] and (not p['macd_on'] or green):
                        # the bounce: it uses up the POP, whether or not the filters let it send
                        waiting = False
                        if in_window and gainer:
                            back_fire = True
                            stop = low_now - tick
                            age = i - pop_bar
                            back_n += 1
                    elif p['wait'] > 0 and i - pop_bar >= p['wait']:
                        waiting = False
                if top is None or h > top:
                    top = h
                    pb_low = None
                else:
                    pb_low = low_now
        if pop_fire:
            out.append({'kind': 'pop', 't': b['t'], 'close': c, 'basis': pb, 'ran_pct': ran, 'pop_n': pop_n})
        if back_fire:
            out.append({'kind': 'back', 't': b['t'], 'close': c, 'stop': stop, 'basis': pb, 'ran_pct': ran,
                        'back_n': back_n, 'since': age, 'green': green})
    return out


def pop_rule_direct(bars, p=None, tick=0.01, gainer_of=None, in_window_of=None):
    """The POP and BACK rule from its definitions, with none of the script's variables: the basis and
    the MACD are worked out again here, the runs are found first, and each run is then read whole.
      a start    a close above the basis on a candle that is its day's first, or whose close before
                 was at or under the basis before
      a run      from a start that is in no earlier run, to the candle before the first one after it
                 that closes under its basis or opens a new day
      its POP    the first candle of the run by which a high of the run stood `up` % above its own
                 candle's basis
      a bounce   a green close above a basis that is above its value a candle before, the MACD's
                 histogram above zero (`macd_on`), a low at or under basis × (1 + `tol` %) on that
                 candle or an earlier one after the POP candle
      its BACK   the run's first bounce after the POP candle, when it comes within `wait` candles of
                 it (`wait` 0: whenever)
      the stop   a tick under the lowest low from the candle after the top to the BACK candle; the top
                 is the first candle with the highest high of the run's candles before the BACK candle
    An alert is sent in the window, on a gainer; the ones sent are numbered per day.
    → the same list as simulate_pop."""
    p = dict(POP_DEFAULTS, **(p or {}))
    n, length = len(bars), p['len']
    o, h, lows, c = [b['o'] for b in bars], [b['h'] for b in bars], [b['l'] for b in bars], [b['c'] for b in bars]
    day = [b['t'].date() for b in bars]
    gain = [True if gainer_of is None else bool(gainer_of(b)) for b in bars]
    inw = [True if in_window_of is None else bool(in_window_of(b)) for b in bars]
    basis = [sum(c[i + 1 - length:i + 1]) / length if i + 1 >= length else None for i in range(n)]

    def ema(vals, m):
        """Of a list with no gaps, its values from the m-th on: the mean of the first m, then each
        value weighted 2 / (m + 1)."""
        if len(vals) < m:
            return []
        got, a = [sum(vals[:m]) / m], 2.0 / (m + 1)
        for v in vals[m:]:
            got.append(a * v + (1 - a) * got[-1])
        return got

    fast_e, slow_e = ema(c, p['fast']), ema(c, p['slow'])                  # from candles fast − 1 and slow − 1
    both = max(p['fast'], p['slow']) - 1                                   # the first candle with both
    line = [fast_e[i - (p['fast'] - 1)] - slow_e[i - (p['slow'] - 1)] for i in range(both, n)]
    signal = ema(line, p['sig'])                                           # from candle both + sig − 1
    lit = both + p['sig'] - 1
    green = [i >= lit and line[i - both] - signal[i - lit] > 0 for i in range(n)]

    def start(k):
        return c[k] > basis[k] and (day[k] != day[k - 1] or c[k - 1] <= basis[k - 1])

    runs, free = [], 0                     # `free`: the first candle after the runs found so far
    for k in range(length, n):             # candle `length` is the first with a basis on the candle before it
        if k < free or not start(k):
            continue
        e = k
        while e + 1 < n and day[e + 1] == day[k] and c[e + 1] >= basis[e + 1]:
            e += 1
        runs.append((k, e))
        free = e + 1

    out = []

    def number(kind, k):
        return 1 + sum(1 for x in out if x['kind'] == kind and x['t'].date() == day[k])

    for k, e in runs:
        reach = [(h[m] / basis[m] - 1) * 100 for m in range(k, e + 1)]      # each candle's high against its own basis

        def ran(j):
            return max(0.0, max(reach[:j - k + 1]))

        pop = next((j for j in range(k, e + 1) if ran(j) >= p['up']), None)
        if pop is None:
            continue
        if inw[pop] and gain[pop]:
            out.append({'kind': 'pop', 't': bars[pop]['t'], 'close': c[pop], 'basis': basis[pop], 'ran_pct': ran(pop),
                        'pop_n': number('pop', pop)})
        last = e if p['wait'] <= 0 else min(e, pop + p['wait'])
        touch = next((j for j in range(pop + 1, last + 1) if lows[j] <= basis[j] * (1 + p['tol'] / 100)), None)
        if touch is None:
            continue
        back = next((j for j in range(touch, last + 1) if c[j] > o[j] and c[j] > basis[j] and basis[j] > basis[j - 1]
                     and (green[j] or not p['macd_on'])), None)
        if back is None or not (inw[back] and gain[back]):
            continue
        highs = h[k:back]
        top = k + highs.index(max(highs))
        out.append({'kind': 'back', 't': bars[back]['t'], 'close': c[back], 'stop': min(lows[top + 1:back + 1]) - tick,
                    'basis': basis[back], 'ran_pct': ran(back), 'back_n': number('back', back), 'since': back - pop,
                    'green': green[back]})
    return out


def _pop_tape(seed, days, day_bars, grid=None, gap=True):
    """A generated 1m tape for selftest_pop: quiet stretches and chop around the basis, fast pops (one
    to six candles), pullbacks after them that come down to the 15-close basis (to a little over it,
    or through it), second legs, and fades back under it, so runs come with and without a POP, and
    POPs with and without a BACK. `grid` and `gap` as in _turn_tape (on a grid a quiet stretch is
    often perfectly flat: its closes stand on the basis)."""
    import datetime as dt, math, random
    rnd = random.Random(seed)
    t0 = dt.datetime(2026, 11, 2, 4, 0, tzinfo=ET)
    snap = (lambda x: max(grid, round(x / grid) * grid)) if grid else (lambda x: x)
    bars, px, phase, left, drift, vol, aim = [], snap(4.0), 'quiet', 0, 0.0, 0.0, 0.0
    for day in range(days):
        if gap:
            px = snap(rnd.uniform(3.0, 6.0))
        for m in range(day_bars):
            while left == 0:
                phase = (rnd.choice(['back', 'back', 'back', 'pop', 'fade']) if phase == 'pop'
                         else rnd.choice(['leg', 'leg', 'leg', 'quiet', 'fade']) if phase == 'back'
                         else rnd.choice(['quiet', 'chop', 'chop', 'pop', 'pop', 'fade']))
                if px < 1.5 and phase == 'fade':
                    phase = 'pop'
                if px > 15 and phase in ('pop', 'leg'):
                    phase = 'fade'
                if phase == 'quiet':
                    left, drift = rnd.randrange(4, 18), 0.0
                    vol = 0.0 if grid and rnd.random() < 0.5 else 0.003
                elif phase == 'chop':
                    left, drift, vol = rnd.randrange(8, 30), rnd.uniform(-0.001, 0.002), 0.012
                elif phase == 'pop':
                    left = rnd.randrange(1, 7)
                    drift, vol = math.log(1 + rnd.uniform(0.06, 0.45)) / left, 0.01
                elif phase == 'back':                       # the pullback: to `aim` over (or under) the basis, see below
                    left, aim, vol = rnd.randrange(1, 12), rnd.uniform(-0.01, 0.025), 0.005
                elif phase == 'leg':
                    left = rnd.randrange(3, 12)
                    drift, vol = rnd.uniform(0.02, 0.2) / left, 0.01
                else:                                       # the fade: back under the basis
                    left = rnd.randrange(8, 30)
                    drift, vol = math.log(1 - rnd.uniform(0.05, 0.25)) / left, 0.008
            if phase == 'back':                             # each candle heads for where the basis now is
                tail = [b['c'] for b in bars[-15:]] or [px]
                drift = math.log(sum(tail) / len(tail) * (1 + aim) / px) / left
            left -= 1
            o = snap(px * math.exp(rnd.gauss(0, vol * 0.3)))   # a candle can open off the close before
            c = snap(px * math.exp(drift + rnd.gauss(0, vol)))
            h = max(o, c, snap(max(o, c) * (1 + abs(rnd.gauss(0, vol * 0.6)))))
            low = min(o, c, snap(min(o, c) * (1 - abs(rnd.gauss(0, vol * 0.8)))))
            bars.append({'t': t0 + dt.timedelta(days=day, minutes=m), 'o': o, 'h': h, 'l': low, 'c': c})
            px = c
    return bars


def selftest_pop():
    """POP and BACK (v48). First on hand-built candles, each case's alerts worked out by hand in the
    comments: `lead` candles standing on 10.00 (the basis is 10.00 and every close is on it), then the
    case's own rows (open, high, low, close); with the default 15-close basis, m rows in it is
    (10 × (15 − m) + those m closes) / 15. Then the script's state machine (simulate_pop) against the
    rule from its definitions (pop_rule_direct) — the same alerts, field for field — on generated
    tapes like selftest_turn's (continuous prices and a 1/64 grid with its exact ties, tapes cut into
    many short days, short tapes for the warm-up), under the script's defaults and with each dial moved."""
    import datetime as dt
    t0 = dt.datetime(2026, 11, 2, 9, 30, tzinfo=ET)
    near = {'basis': 1e-4, 'ran_pct': 1e-3, 'stop': 1e-9}      # the figures below are written to 4 and 3 decimals

    def check(rows, want, q=None, lead=40, new_day_at=None, gain=None, window=None, **cb):
        """simulate_pop and pop_rule_direct on `lead` flat candles + rows, against the alerts worked
        out: ('pop', row, pop_n, basis, ran_pct) / ('back', row, back_n, since, stop, green, basis,
        ran_pct). `new_day_at`: the row that opens the next day; gain / window: row → bool (the
        gainer filter and the alert window); `tick` is passed on."""
        bars = [{'t': t0 + dt.timedelta(minutes=i), 'o': 10.0, 'h': 10.0, 'l': 10.0, 'c': 10.0} for i in range(lead)]
        for r, (o, h, low, c) in enumerate(rows):
            t = t0 + dt.timedelta(minutes=lead + r, days=1 if new_day_at is not None and r >= new_day_at else 0)
            bars.append({'t': t, 'o': o, 'h': h, 'l': low, 'c': c})
        row_of = {b['t']: i - lead for i, b in enumerate(bars)}
        if gain is not None:
            cb['gainer_of'] = lambda b: gain(row_of[b['t']])
        if window is not None:
            cb['in_window_of'] = lambda b: window(row_of[b['t']])
        exp = []
        for kind, r, n, *more in want:
            x = {'kind': kind, 't': bars[lead + r]['t'], 'close': rows[r][3], 'basis': more[-2], 'ran_pct': more[-1]}
            x.update({'pop_n': n} if kind == 'pop' else {'back_n': n, 'since': more[0], 'stop': more[1], 'green': more[2]})
            exp.append(x)

        def as_worked_out(got):
            return len(got) == len(exp) and all(
                g.keys() == x.keys() and all(abs(g[k] - x[k]) <= near[k] if k in near else g[k] == x[k] for k in x)
                for g, x in zip(got, exp))

        return as_worked_out(simulate_pop(bars, q, **cb)) and as_worked_out(pop_rule_direct(bars, q, **cb))

    # a candle that starts a run and is its POP: the close before is on the basis (10.00), this one is
    # above it, basis (140 + 11.5) / 15 = 10.10, high 11.6 = +14.851%
    pop0 = (10.0, 11.6, 10.0, 11.5)
    first = ('pop', 0, 1, 10.1, 14.851)
    plain = [(10.0, 10.5, 10.0, 10.4),    # basis 150.4 / 15 = 10.0267: the run starts; high +4.72%, no POP yet
             (10.4, 11.6, 10.4, 11.5),    # basis 151.9 / 15 = 10.1267, high +14.549%: the POP
             (11.5, 11.5, 10.2, 10.6),    # basis 152.5 / 15 = 10.1667: the low 10.2 is within 1% of it (≤ 10.268), the touch; red
             (10.6, 11.0, 10.5, 10.9),    # basis 153.4 / 15 = 10.2267, up; green and above it: the BACK, 2 after the POP;
                                          # the top is row 1, the lows after it 10.2 and 10.5 → stop 10.19
             (10.9, 11.3, 10.3, 11.2)]    # basis 154.6 / 15 = 10.3067, up; green, low ≤ 10.41: a bounce, if the POP still had its BACK to give
    plain_pop, plain_back = ('pop', 1, 1, 10.1267, 14.549), ('back', 3, 1, 2, 10.19, True, 10.2267, 14.549)
    # one POP per run: row 1's high is further out (+26.377% over 154.3 / 15) and sends nothing; row 2 touches (10.25 ≤ 10.43,
    # basis 10.3267), row 3 is the BACK (basis 156 / 15 = 10.40, 3 after the POP; the top is row 1, the lows after it 10.25
    # and 10.5); row 4 runs to +27% and sends nothing; row 5 closes under the basis (10.6267): the run is over; row 6 starts
    # the next one and is its POP (basis 161.9 / 15 = 10.7933, high +16.739%), the day's second; row 7 touches (11.0 ≤ 11.036),
    # is green above a rising basis (163.9 / 15 = 10.9267): the day's second BACK, stop under its own low
    two_runs = [pop0, (11.5, 13.0, 11.5, 12.8), (12.8, 12.8, 10.25, 10.6), (10.6, 11.2, 10.5, 11.1), (11.1, 13.5, 11.1, 13.4),
                (13.4, 13.4, 10.0, 10.0), (10.0, 12.6, 10.0, 12.5), (11.0, 12.1, 11.0, 12.0)]
    # the wait: rows 1–3 stay far above the basis (no touch), row 4 comes down to it (10.4 ≤ 10.524, basis 156.3 / 15 = 10.42,
    # up from 10.36) and closes green above it, 4 candles after the POP; the top is row 0, the lowest low after it 10.4
    late = [pop0, (11.5, 11.5, 11.3, 11.4), (11.4, 11.5, 11.2, 11.3), (11.3, 11.4, 11.1, 11.2), (10.4, 11.0, 10.4, 10.9)]
    late_back = ('back', 4, 1, 4, 10.39, True, 10.42, 14.851)
    # the bounce on the candle after the POP candle, which is the top: basis 152.3 / 15 = 10.1533 (up), low 10.2 ≤ 10.255
    at_once = [pop0, (10.3, 10.9, 10.2, 10.8)]
    at_once_back = ('back', 1, 1, 1, 10.19, True, 10.1533, 14.851)
    # the MACD: after the POP nine closes slide down onto the rising basis (touch at row 7: 10.8 ≤ 10.824); row 9 is green
    # above the basis (162.47 / 15 = 10.8313) with the histogram under zero, row 10 (163.87 / 15 = 10.9247) with it above
    slide = [(10.0, 12.2, 10.0, 12.0), (12.0, 12.0, 11.7, 11.8), (11.8, 11.8, 11.5, 11.6), (11.6, 11.6, 11.3, 11.4),
             (11.4, 11.4, 11.1, 11.2), (11.2, 11.2, 10.9, 11.0), (11.0, 11.0, 10.85, 10.9), (10.9, 10.9, 10.8, 10.85),
             (10.85, 10.86, 10.8, 10.82), (10.82, 10.92, 10.8, 10.9), (10.9, 11.5, 10.9, 11.4)]
    slide_pop = ('pop', 0, 1, 10.1333, 20.395)                  # basis 152 / 15, high 12.2
    hist = macd_hist_series([10.0] * 40 + [r[3] for r in slide], 12, 26, 9)
    # a new day: rows 0–1 are a POP and its BACK; row 2 stays above the basis; row 3 closes above it again (no crossing) with
    # a high +15.236% over 154.9 / 15 = 10.3267; row 4 touches (10.45 ≤ 10.49) and is green above 155.8 / 15 = 10.3867
    two_days = [pop0, (10.3, 10.9, 10.2, 10.8), (10.8, 10.9, 10.7, 10.8), (10.8, 11.9, 10.8, 11.8), (10.5, 11.0, 10.45, 10.9)]
    # a 2-close basis: row 0 is the POP (basis 11, high +13.636%); row 1 closes exactly on the basis ((12 + 12) / 2), green,
    # the basis up, its low a touch — the run goes on, and it is no bounce (the close is not above the basis); row 2 is
    # (basis 12.25): the top before it is row 0, the lows after that 11.9 and 12.0. Its high is +10.2% out, but it is a
    # candle of the same run (a close above the basis after a close on it starts nothing while a run is on)
    on_it = [(10.0, 12.5, 10.0, 12.0), (11.9, 12.0, 11.9, 12.0), (12.0, 13.5, 12.0, 12.5)]
    len2 = dict(len=2, macd_on=False)
    on_it_pop = ('pop', 0, 1, 11.0, 13.636)
    # a 3-close basis (and a histogram of 0, see below): row 0 is the POP (basis 33 / 3 = 11, high +18.182%); row 1 touches
    # (11.5 ≤ 11.70, basis 34.75 / 3); row 2 is red (basis 37.25 / 3 = 12.4167); row 3 is green above the basis, but the basis
    # is 37.25 / 3 again: not above its value a candle before, no bounce; row 4 is (basis 38.75 / 3 = 12.9167). Row 3's
    # high only equals the top (row 0's 13.0), so the stop is still under the lowest low after row 0: 11.5
    level = [(10.0, 13.0, 10.0, 13.0), (13.0, 13.0, 11.5, 11.75), (12.75, 12.75, 12.25, 12.5), (12.5, 13.0, 12.5, 13.0),
             (13.0, 13.25, 13.0, 13.25)]
    len3 = dict(len=3, macd_on=False, fast=1, slow=2, sig=1)
    hand = [
        ('a POP, a touch, the BACK on the candle after',
         check(plain[:4], [plain_pop, plain_back])),
        ('the stop is one tick under the low, whatever the tick',
         check(plain[:4], [plain_pop, plain_back[:4] + (10.1999,) + plain_back[5:]], tick=0.0001)),
        # row 1 is green above a rising basis (153.3 / 15 = 10.22) with a low far over it: no touch, though the POP candle's
        # own low (10.0) was at the basis
        ("a POP on the run's first candle, whose own low is no touch",
         check([pop0, (11.5, 11.9, 11.4, 11.8)], [first])),
        ('one POP per run, the next run is POP 2 and BACK 2',
         check(two_runs, [first, ('back', 3, 1, 3, 10.24, True, 10.4, 26.377), ('pop', 6, 2, 10.7933, 16.739),
                          ('back', 7, 2, 1, 10.99, True, 10.9267, 16.739)])),
        ('a 15% pop asked: none', check(plain[:4], [], dict(up=15.0))),
        ('tol 0: a low above the basis is no touch', check(plain[:4], [plain_pop], dict(tol=0.0))),
        ('the wait runs out (wait 3, the bounce 4 after)', check(late, [first], dict(wait=3))),
        ('the bounce on the last candle allowed (wait 4)', check(late, [first, late_back], dict(wait=4))),
        ('wait 0: no limit', check(late, [first, late_back], dict(wait=0))),
        ('wait 1, the bounce on the next candle', check(at_once, [first, at_once_back], dict(wait=1))),
        # row 1 closes under the basis (151.5 / 15 = 10.10): the run and the wait are over; row 2 starts a run that only gets to +8.3%
        ('the run ends before the bounce', check([pop0, (11.5, 11.5, 10.0, 10.0), (10.0, 11.0, 10.0, 10.9)], [first])),
        # …with row 1 closing above it (10.3 over 151.8 / 15 = 10.12) the same bounce is the BACK: basis 152.7 / 15, lows 10.1 and 10.2
        ('the same with the close above the basis: a BACK',
         check([pop0, (11.5, 11.5, 10.1, 10.3), (10.3, 11.0, 10.2, 10.9)], [first, ('back', 2, 1, 2, 10.09, True, 10.18, 14.851)])),
        # row 1 touches (10.15 ≤ 10.228) and closes above the basis, row 2 closes under it (151.9 / 15 = 10.1267): the run is
        # over with no bounce. Row 3 starts the next run and is its POP (basis 153.7 / 15 = 10.2467, high +16.135%), the day's
        # second; row 4 is green above a rising basis but its low is far over it: the touch before this POP does not count
        ('a touch, then the run ends; the next POP starts with no touch',
         check([pop0, (11.5, 11.5, 10.15, 10.4), (10.4, 10.4, 10.0, 10.0), (10.0, 11.9, 10.0, 11.8), (11.8, 12.2, 11.7, 12.1)],
               [first, ('pop', 3, 2, 10.2467, 16.135)])),
        # row 1 comes down to the basis and closes where it opened, above a rising basis: not green, no bounce; row 2 is green
        # (basis 153.2 / 15 = 10.2133): the BACK, the lows after the top 10.2 and 10.7
        ('a close equal to the open is not green',
         check([pop0, (10.8, 10.9, 10.2, 10.8), (10.8, 11.0, 10.7, 10.9)], [first, ('back', 2, 1, 2, 10.19, True, 10.2133, 14.851)])),
        # row 1 pulls back to 10.15; row 2 bounces and makes the run's new high (12.0, +17.035% over 153.8 / 15 = 10.2533):
        # the top before it is row 0, so the stop is under row 1's low, not under its own 10.35
        ('the stop under a deeper low before a bounce candle that makes a new high',
         check([pop0, (11.5, 11.5, 10.15, 10.4), (10.4, 12.0, 10.35, 11.9)], [first, ('back', 2, 1, 2, 10.14, True, 10.2533, 17.035)])),
        # row 1 touches; row 2 is red with a new high (11.8, +15.611% over 153.1 / 15); row 3 bounces (basis 154.5 / 15 = 10.30):
        # the top is row 2, the only low after it row 3's own 11.1; row 1's 10.15 is before the top
        ('the stop after a new high between the touch and the bounce',
         check([pop0, (11.5, 11.5, 10.15, 10.4), (11.5, 11.8, 11.0, 11.2), (11.2, 11.5, 11.1, 11.4)],
               [first, ('back', 3, 1, 3, 11.09, True, 10.3, 15.611)])),
        ('the stop when the bounce is the candle after the top', check(at_once, [first, at_once_back])),
        ('MACD on: the bounce waits for a green histogram',
         hist[49] < 0 < hist[50] and check(slide, [slide_pop, ('back', 10, 1, 10, 10.79, True, 10.9247, 20.395)])),
        ('MACD off: the bounce before it, green 0',
         check(slide, [slide_pop, ('back', 9, 1, 9, 10.79, False, 10.8313, 20.395)], dict(macd_on=False))),
        # a signal length of 1: the signal line is the MACD line, the histogram 0 on every candle, never green
        ('a histogram of 0 is not green', check(plain[:4], [plain_pop], dict(fast=1, slow=2, sig=1))
         and check(plain[:4], [plain_pop, plain_back[:5] + (False,) + plain_back[6:]], dict(fast=1, slow=2, sig=1, macd_on=False))),
        ("a new day: the counts start over and its first candle starts a run",
         check(two_days, [first, at_once_back, ('pop', 3, 1, 10.3267, 15.236), ('back', 4, 1, 1, 10.44, True, 10.3867, 15.236)],
               new_day_at=3)),
        ('the same candles on one day: nothing after the first BACK', check(two_days, [first, at_once_back])),
        # the gainer filter stops the POP (row 1): the run has had its POP all the same (row 2 is still +14.5% out and
        # sends none), and the BACK is the day's first
        ('a POP not sent, its BACK sent as BACK 1', check(plain, [plain_back], gain=lambda r: r > 1)
         and check(plain, [plain_back], window=lambda r: r > 1)),
        ('a bounce not sent uses up the POP (the next bounce sends nothing)', check(plain, [plain_pop], gain=lambda r: r != 3)),
        ('a green close on the basis keeps the run and is no bounce', check(on_it, [on_it_pop, ('back', 2, 1, 2, 11.89, True, 12.25, 13.636)], len2)),
        # …with row 1 closing at 11.99, under its basis (11.995), the run is over; row 2 starts the next one and is its POP
        # (basis 12.245, high +10.249%), not the first one's BACK
        ('a close a cent under it ends the run: the next candle is a new run',
         check([on_it[0], (12.0, 12.0, 11.9, 11.99), on_it[2]], [on_it_pop, ('pop', 2, 2, 12.245, 10.249)], len2)),
        # tol 0, the 2-close basis: row 1 stands on 12.0, its low exactly on its basis (12.0), the touch; row 2 opens over its
        # basis (12.4) and never comes down to it, so its BACK needs that touch; the lows after the top (row 0) are 12.0 and 12.6
        ('tol 0: a low exactly on the basis is a touch',
         check([on_it[0], (12.0, 12.0, 12.0, 12.0), (12.6, 12.9, 12.6, 12.8)], [on_it_pop, ('back', 2, 1, 2, 11.99, True, 12.4, 13.636)],
               dict(len2, tol=0.0))),
        # the 2-close basis is 12 and the high 15: exactly 25% out
        ('a high exactly `up` % out is a POP', check([(10.0, 15.0, 10.0, 14.0)], [('pop', 0, 1, 12.0, 25.0)], dict(len=2, up=25.0))),
        ('a level basis is not a rising one, a high equal to the top is no new top',
         check(level, [('pop', 0, 1, 11.0, 18.182), ('back', 4, 1, 4, 11.49, False, 12.9167, 18.182)], len3)),
        # 15 flat candles: row 0 is the first with a basis on the candle before it. 14: its own basis is the first, so it is
        # skipped, and row 1 is no crossing (row 0 closed above its basis)
        ('the warm-up: a candle with no basis before it is skipped',
         check([pop0, (11.5, 11.6, 11.4, 11.5)], [first], lead=15) and check([pop0, (11.5, 11.6, 11.4, 11.5)], [], lead=14)),
    ]
    off = [label for label, good in hand if not good]
    ok_hand = not off
    print(f"POP and BACK (v48), a pop off the basis and its first pullback, on hand-built candles: {len(hand) - len(off)} of {len(hand)} "
          f"cases give the alerts worked out by hand, from the script's state machine and from the rule's definitions alike (a POP and "
          f"its BACK, on the run's first candle and later; one POP per run; the wait running out, its last candle, wait 0; the run "
          f"ending first; the stop after a new high, on the bounce candle and before it; the MACD on and off; a new day; a POP or a "
          f"bounce the gainer filter stops; closes, lows and highs exactly on a line; the warm-up)"
          + (f" — NOT: {'; '.join(off)}" if off else ''), '→', 'OK' if ok_hand else 'UNEXPECTED')

    g = 1 / 64
    tapes = ([('two days', None, _pop_tape(s, 2, 600)) for s in (1, 2, 3, 4, 5, 6)]                # (kind, its grid, bars)
             + [('two days', g, _pop_tape(s, 2, 600, g)) for s in (11, 12, 13, 14, 15, 16)]
             + [('short days', None, _pop_tape(21, 100, 24, gap=False)), ('short days', g, _pop_tape(22, 100, 24, g, gap=False))]
             + [('short', None, _pop_tape(40 + s, 1, 20 + 3 * s)) for s in range(0, 30, 2)]
             + [('short', g, _pop_tape(40 + s, 1, 20 + 3 * s, g)) for s in range(1, 30, 2)])
    cases = [('the defaults', {}), ('MACD off', dict(macd_on=False)), ('a 5% pop', dict(up=5.0)), ('a 20% pop', dict(up=20.0)),
             ('len 10', dict(len=10)), ('len 20', dict(len=20)), ('wait 6', dict(wait=6)), ('no limit', dict(wait=0)),
             ('tol 0', dict(tol=0.0)), ('tol 3', dict(tol=3.0)), ('MACD 5 13 4', dict(fast=5, slow=13, sig=4)),
             ('MACD 26 12 9 (upside down)', dict(fast=26, slow=12)),
             ('len 2 + a 3% pop + wait 1 + tol 0 + MACD off', dict(len=2, up=3.0, wait=1, tol=0.0, macd_on=False)),
             ('len 5 + a 5% pop + no limit + MACD off', dict(len=5, up=5.0, wait=0, macd_on=False))]
    same, got = True, {}
    at_start = on_last = deeper = over = 0          # situations the tapes must hold, counted from the alerts
    for label, q in cases:
        pq = dict(POP_DEFAULTS, **q)
        got[label] = []
        for _, _, bars in tapes:
            a = simulate_pop(bars, q)
            same = same and a == pop_rule_direct(bars, q)
            got[label].append(a)
            at = {b['t']: i for i, b in enumerate(bars)}
            line = sma_series([b['c'] for b in bars], pq['len'])
            for x in a:
                i = at[x['t']]
                if x['kind'] == 'pop':              # a POP on the first close above the basis
                    at_start += bars[i - 1]['c'] <= line[i - 1]
                    continue
                on_last += x['since'] == pq['wait'] > 1                   # a BACK on the last candle allowed (of several)
                under = x['stop'] < bars[i]['l'] - 0.01 - 1e-9            # its stop under an earlier candle's low…
                deeper += under
                since_pop = [b['h'] for b in bars[i - x['since']:i]]      # …where its own high is the highest since the POP
                over += under and bool(since_pop) and bars[i]['h'] > max(since_pop)
    base = got['the defaults']
    count = {label: (sum(1 for a in runs for x in a if x['kind'] == 'pop'), sum(1 for a in runs for x in a if x['kind'] == 'back'))
             for label, runs in got.items()}
    pops, backs = sum(n for n, _ in count.values()), sum(n for _, n in count.values())
    moved_dial = all(n_pop > 0 and n_back > 0 and (label == 'the defaults' or got[label] != base) for label, (n_pop, n_back) in count.items())
    # the day's numbers: 1, 2, … for the POPs and for the BACKs on each day of each tape; alerts on both days of a two-day tape
    numbered, second, twice = True, 0, 0
    for runs in got.values():
        for (kind, _, bars), a in zip(tapes, runs):
            by_day = {}
            for x in a:
                by_day.setdefault((x['t'].date(), x['kind']), []).append(x['pop_n'] if x['kind'] == 'pop' else x['back_n'])
            numbered = numbered and all(ns == list(range(1, len(ns) + 1)) for ns in by_day.values())
            twice += sum(1 for (_, k), ns in by_day.items() if k == 'back' and len(ns) > 1)
            if kind == 'two days':
                second += sum(1 for x in a if x['t'].date() != bars[0]['t'].date())
    # a gainer filter and an alert window, applied where the script applies them: a POP they stop still uses up its run
    # (its BACK can be sent: `lone`), and a bounce they stop still uses up its POP
    cb = dict(gainer_of=lambda b: b['t'].minute % 3 != 0, in_window_of=lambda b: b['t'].minute % 7 != 0)
    n_cb = n_open = lone = 0
    for q in ({}, dict(macd_on=False), dict(len=2, up=3.0, wait=3, tol=0.0, macd_on=False)):
        for _, _, bars in tapes:
            a = simulate_pop(bars, q, **cb)
            same = same and a == pop_rule_direct(bars, q, **cb)
            n_cb += len(a)
            n_open += len(simulate_pop(bars, q))
            at = {b['t']: i for i, b in enumerate(bars)}
            sent = {at[x['t']] for x in a if x['kind'] == 'pop'}
            lone += sum(1 for x in a if x['kind'] == 'back' and at[x['t']] - x['since'] not in sent)
    # a new day ends a run and can start one on its first candle: the short-day tapes against the same candles all on one day
    new = cut = 0
    for kind, _, bars in tapes:
        if kind != 'short days':
            continue
        one_day = [dict(b, t=bars[0]['t'] + dt.timedelta(seconds=i)) for i, b in enumerate(bars)]
        for q in ({}, dict(macd_on=False)):
            dated, undated = simulate_pop(bars, q), simulate_pop(one_day, q)
            same = same and undated == pop_rule_direct(one_day, q)
            at = {b['t']: i for i, b in enumerate(bars)}
            with_days = {(at[x['t']], x['kind'], x.get('since'), x.get('stop')) for x in dated}
            without = {((x['t'] - bars[0]['t']).seconds, x['kind'], x.get('since'), x.get('stop')) for x in undated}
            new += len(with_days - without)
            cut += len(without - with_days)
    # ties on the grid tapes: closes exactly on the 15-close basis (a run starts after one, and does not end at one)
    on_basis = sum(1 for _, grid, bars in tapes if grid
                   for b, v in zip(bars, sma_series([x['c'] for x in bars], POP_DEFAULTS['len'])) if v is not None and b['c'] == v)
    ok = (same and count['the defaults'][0] >= 100 and count['the defaults'][1] >= 20 and pops >= 2000 and backs >= 400 and moved_dial
          and numbered and second > 0 and twice > 0 and 0 < n_cb < n_open and lone > 0 and new > 0 and cut > 0 and on_basis > 0
          and at_start > 0 and on_last > 0 and deeper > 0 and over > 0)
    shown = ', '.join(f'{label} {n_pop} + {n_back}' for label, (n_pop, n_back) in count.items())
    print(f"…and on {len(tapes)} generated tapes × {len(cases)} settings: {pops} POPs + {backs} BACKs ({shown}); the script's state machine "
          f"and the rule from its definitions {'give the same ones, field for field, also' if same else 'DO NOT give the same ones, or not'} "
          f"with a gainer filter and a window ({n_cb} alerts, {n_open} without them; {lone} BACKs sent after a POP that was not); "
          f"numbered 1, 2, … per day, POPs and BACKs apart ({second} alerts on a tape's second day); a new day: {new} alerts it made and "
          f"{cut} it cut, against the same candles on one day; {at_start} POPs on the first close above the basis, {on_last} BACKs on the "
          f"last candle allowed, {deeper} stops under an earlier candle's low ({over} of them on a bounce candle with the highest high "
          f"since the POP); {on_basis} closes exactly on the basis on the grid tapes", '→', 'OK' if ok else 'UNEXPECTED')
    return ok_hand and ok


if __name__ == '__main__':
    raise SystemExit(0 if (selftest() & selftest_pullback() & selftest_breakout() & selftest_vb() & selftest_rsi() & selftest_ema()
                           & selftest_turn() & selftest_pop()) else 1)
