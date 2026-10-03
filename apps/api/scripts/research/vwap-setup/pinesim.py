"""Offline replica of apps/web/src/tv/mvwap-bb-setup.pine (script v5).

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
V5 = dict(minDayGain=20.0, runnerDays=2, useAhGain=True, maxPxBelow=15.0, formBasis=10.0, readyBasis=6.0,
          holdTol=0.0, failPct=2.0, slopeBars=3, useFast=True, fastAbove=3.0, formPx=10.0, readyPx=5.0,
          maxBasis=15.0, maxCycles=6, window=(240, 1200),  # alert window in ET minutes [04:00, 20:00); None = always
          fromBelowBars=10,  # fast route only if every close of the previous N bars was under the line (0 = off)
          goMemory=60,       # GO also fires within N bars of the last FORMING/READY, even after a break (0 = off)
          breakBars=0,       # replica-only experiment: also break after N closes in a row under the basis
          goOn='either',     # GO trigger: 'basis' = basis crosses above the line; 'price' = price reclaims the
                             # line (basis rising); 'either' = whichever comes first (the script's "Either")
          goAbovePct=2.0,    # price reclaim must close this % above the line…
          goWithin=5)        # …having been at/under it within the previous N bars
# Earlier versions: V5 with the newer parts switched off / older defaults.
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
    p = {**V5, **(params or {})}
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
        k = p['goWithin']
        was_under = any(m is not None and cc <= m for cc, m in zip(closes[-1 - k:-1], mv_hist[-1 - k:-1]))
        reclaim = (mv is not None and basis is not None and basis_up and was_under
                   and c > mv * (1 + p['goAbovePct'] / 100))
        trig = {'basis': cross_up, 'price': reclaim, 'either': cross_up or reclaim}[p['goOn']]
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
