"""Offline replica of apps/web/src/tv/mvwap-bb-setup.pine — the reclaim setup (v9 logic = v7 + message
fields) in simulate(), and the PULLBACK setup (script v10) in PullbackLine / simulate_pullback().

Replays the 📐 VWAP-setup stage machine on Yahoo 1m/2m bars so a script change
can be scored on past examples in seconds instead of by hand in bar replay.
Keep it in step with the .pine file (docs/vwap-setup.md §10).

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


# ── PULLBACK setup (script v10) ────────────────────────────────────────────────
# Inputs, same meaning and defaults as the script's "Pullback to VWAP (v10)" group.
PB = dict(arm=15.0,        # armed: a bar high at least % above the line (the big move)
          near=5.0,        # PULLBACK: a close back within % above the line
          brk=0.0,         # BROKEN: a close at least % under the line
          win=10.0,        # HELD: a high % above the PULLBACK close
          max_touches=2,   # pullbacks per line per day (a close straight through counts)
          timeout=60,      # stop watching a pullback after N bars
          window=(240, 1200))


class PullbackLine:
    """One line's state — the script's `PbLine` and `method step`, bar for bar."""

    def __init__(self, params=None):
        self.p = {**PB, **(params or {})}
        self.new_day()

    def new_day(self):
        self.armed, self.arm_bar, self.peak_pct, self.peak_bar = False, None, None, None
        self.touches, self.open, self.entry, self.alert_bar = 0, False, None, None

    def step(self, i, h, c, ln, can_arm=True):
        """Bar index i, high, close, the line → 0 nothing, 1 PULLBACK, 2 BROKEN, 3 HELD."""
        p, ev = self.p, 0
        if ln is None or ln <= 0:
            return 0
        if self.open:
            if c < ln * (1 - p['brk'] / 100):
                self.open, ev = False, 2
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
                if i > self.arm_bar and c <= ln * (1 + p['near'] / 100):
                    self.armed = False
                    self.touches += 1
                    if ev == 0 and self.touches <= p['max_touches'] and c >= ln * (1 - p['brk'] / 100):
                        self.open, self.entry, self.alert_bar, ev = True, c, i, 1
        return ev


def simulate_pullback(bars, session_of, month_of, params=None, lines='both', gainer_of=None):
    """Both lines of the PULLBACK setup over bars (dicts with t, h, c). session_of / month_of(bar) → the
    line or None; gainer_of(bar) → bool (default: always a gainer). Returns the script's messages:
    (time, PULLBACK|BROKEN|HELD, line session|month|both, touch, close, line value, % vs line, peak %)."""
    p = {**PB, **(params or {})}
    sl, ml = PullbackLine(p), PullbackLine(p)
    out, day = [], None
    names = {1: 'PULLBACK', 2: 'BROKEN', 3: 'HELD'}
    for i, b in enumerate(bars):
        t = b['t']
        if t.date() != day:
            day = t.date()
            sl.new_day(); ml.new_day()
        m = t.hour * 60 + t.minute
        if p['window'] is not None and not (p['window'][0] <= m < p['window'][1]):
            continue
        ok = True if gainer_of is None else gainer_of(b)
        sv, mv = session_of(b), month_of(b)
        ev_s = sl.step(i, b['h'], b['c'], sv, ok) if lines != 'month' else 0
        ev_m = ml.step(i, b['h'], b['c'], mv, ok) if lines != 'session' else 0
        pct = lambda ln: (b['c'] / ln - 1) * 100 if ln else None
        if ev_s and ev_s == ev_m:
            out.append((t, names[ev_s], 'both', min(sl.touches, ml.touches), b['c'], sv, pct(sv),
                        max(sl.peak_pct, ml.peak_pct) if ev_s == 1 else None))
            continue
        if ev_s:
            out.append((t, names[ev_s], 'session', sl.touches, b['c'], sv, pct(sv), sl.peak_pct if ev_s == 1 else None))
        if ev_m:
            out.append((t, names[ev_m], 'month', ml.touches, b['c'], mv, pct(mv), ml.peak_pct if ev_m == 1 else None))
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
            1.25, 1.02,                           # re-armed, back near: touch 4 > max 2 → nothing
            1.30, 1.01]                           # still nothing (touches exhausted for the day)
    bars = [{'t': t0 + dt.timedelta(minutes=k), 'h': c, 'c': c} for k, c in enumerate(path)]
    got = [(e[1], e[3], e[4]) for e in simulate_pullback(bars, lambda b: 1.00, lambda b: None)]
    want = [('PULLBACK', 1, 1.04), ('HELD', 1, 1.16), ('PULLBACK', 2, 1.03), ('BROKEN', 2, 0.98)]
    ok = got == want
    print('pullback state machine:', got, '→', 'OK' if ok else f'UNEXPECTED (want {want})')
    both = simulate_pullback(bars[:6], lambda b: 1.00, lambda b: 1.00)
    ok_both = [(e[1], e[2]) for e in both] == [('PULLBACK', 'both')]
    print('same event on both lines → one "both" message:', [(e[1], e[2]) for e in both], '→', 'OK' if ok_both else 'UNEXPECTED')
    return ok and ok_both


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
    return ok


if __name__ == '__main__':
    raise SystemExit(0 if (selftest() & selftest_pullback()) else 1)
