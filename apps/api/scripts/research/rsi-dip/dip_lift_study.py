"""RSI DIP — is a buy stop some % above the DIP a better entry than the DIP itself?
(operator, 2026-11-14: "most of them just keep going lower after the DIP candle … I tested the trades
with entering >=8% from the latest DIP setup, and it's working very well … placing the buy order with
StopLimit at 8% from dip and waiting, and if it keeps going down I just cancel them".)

Data     Yahoo 5m bars, 60 days, pre- and post-market included (prices; Yahoo's extended-hours volume
         is zero), for the tickers the live RSI / DIP alerts ran on (a file of tickers). Cached as
         JSON in --cache. Not our Momentum rows: these names are rarely on the screen.
DIPs     the script's rule replayed by pinesim.rsi_rule_direct on the RSI timeframe's candles
         (--rsi 10, checked at --check 60: the operator's settings since 11-13): an RSI cross while
         oversold arms it; the RSI closes under its MA and turns up → DIP. P = the DIP candle's close
         (the alert's price). These are the rule's DIPs on consolidated prices, not the operator's
         alerts one for one: TradingView's feed is partial (three of four live alerts are judged a
         bar late), and an RSI against its MA is a knife edge. The replay check prints the overlap.
Order    a buy stop at P × (1 + L%), live from the DIP candle's close until it fills, a newer DIP on
         the ticker replaces it ("the latest DIP"), or --expire sessions pass. Filled at the level,
         or at the bar's open when it gaps over it (`gap`); a stop-limit would miss those.
Outcomes after the fill (L = 0: buying the DIP's close)
         1h / eod / 3d   the fill against the bar an hour later, the session's last bar, the last
                         bar of the third session after, %
         -5/+10          a bracket: stop 5% under the fill, target 10% over, out at the session's
                         end → % per trade and how many hit the target first
         cut -5 / cut3   cut the losers, keep the winners: a stop 5% under the fill and no target,
                         out at the session's end (cut) or the third session's after (cut3) → %;
                         `less top 1%` = the same mean without its best 1% (what a few runners carry)
         1R              stop at P (the order's reason is gone; for L = 0 a tick under the dip's
                         low), target the same distance over the fill, 3 sessions → R
         run / dip       the best and the worst against the fill in the rest of the session, median %
Variants `close +8%` = bought at the close of the first 5m bar closing over the level, not on a touch;
         fills in regular hours only; fills that didn't gap 2% over the level (a stop-limit's);
         fills with the ticker on our Momentum screen in the 15 minutes before (--onscreen)
Control  the same order above closes that are not DIPs (every --stride-th candle of the same
         tickers): is it the DIP, or does any +L% move do this?
Fair     `listed` = the ticker was on the runners list by our own rule on the DIP's day (a +30% day
         on our screen in the 90 days before, or +20% in the 5 days before): the list as it stood
         then, not names known today to have run.
Split    by date: the first --split of the sessions in sample, the rest out of sample.

Run:  python3 -I dip_lift_study.py tickers.txt --cache DIR [--days ticker_days.csv] [--live live.csv]
      (tickers.txt: one per line; ticker_days.csv: ticker,et_date,max_chg from screener_ticker_days;
       live.csv: the live rows, ticker,epoch,stage,price,stop,dip_n,rsi_tf,candle_tf,late)
"""
import argparse, bisect, datetime, json, os, statistics, sys, time, urllib.request, zoneinfo
from collections import defaultdict

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vwap-setup'))
import pinesim  # noqa: E402  (the script's replica: resample_session, rsi_rule_direct)

ap = argparse.ArgumentParser()
ap.add_argument('tickers')
ap.add_argument('--cache', required=True, help='a folder for the Yahoo downloads')
ap.add_argument('--days', help='screener_ticker_days export: ticker,et_date,max_chg')
ap.add_argument('--live', help='live RSI / DIP rows: ticker,epoch,stage,price,stop,dip_n,rsi_tf,candle_tf,late')
ap.add_argument('--rsi', type=int, default=10, help="the RSI's timeframe, minutes")
ap.add_argument('--check', type=int, default=60, help='the check timeframe, minutes')
ap.add_argument('--expire', type=int, default=3, help='sessions an order stays live after the DIP day')
ap.add_argument('--stride', type=int, default=40, help='control: every Nth candle is an anchor')
ap.add_argument('--split', type=float, default=0.6)
ap.add_argument('--onscreen', help='gzipped ticker,bucket,chg,grade: the 5-minute buckets (epoch / 300) a ticker was on the Momentum screen')
ap.add_argument('--fetch-only', action='store_true')
ap.add_argument('--dump', action='store_true', help='list the live alerts whose +8% order filled')
args = ap.parse_args()
ET = zoneinfo.ZoneInfo('America/New_York')
LEVELS = [0, 3, 5, 8, 10, 12, 15]
CLOSES = ['c5', 'c8', 'c12']     # bought at a 5m close at or over the level, not on a touch
NAME = {0: 'buy the DIP', 'c5': 'close +5%', 'c8': 'close +8%', 'c12': 'close +12%'}
P_RSI = dict(sig_min=args.rsi, check_min=args.check)


def fetch(ticker):
    """Yahoo 5m bars, 60 days, extended hours → the cached JSON's path (None if Yahoo has nothing)."""
    path = os.path.join(args.cache, f'{ticker}.json')
    if os.path.exists(path):
        return path if os.path.getsize(path) > 2 else None
    sym = ticker.replace('.', '-')
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=5m&range=60d&includePrePost=true&events=splits'
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            with open(path, 'wb') as f:
                f.write(body)
            time.sleep(0.35)
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                break
            time.sleep(3 + 4 * attempt)
        except Exception:
            time.sleep(3 + 4 * attempt)
    with open(path, 'w') as f:
        f.write('{}')
    return None


def load(path):
    """→ 5m bars in ET, 04:00–20:00, oldest first; bars before a split in the window are dropped."""
    try:
        with open(path) as f:
            res = json.load(f)['chart']['result'][0]
        ts, q = res['timestamp'], res['indicators']['quote'][0]
    except Exception:
        return []
    splits = [int(k) for k in (res.get('events') or {}).get('splits', {})]
    since = max(splits) if splits else 0
    out = []
    for i, t in enumerate(ts):
        o, h, l, c = q['open'][i], q['high'][i], q['low'][i], q['close'][i]
        if None in (o, h, l, c) or c <= 0 or t < since:
            continue
        d = datetime.datetime.fromtimestamp(t, ET)
        if not (240 <= d.hour * 60 + d.minute < 1200) or d.weekday() >= 5:
            continue
        out.append(dict(t=d, o=o, h=h, l=l, c=c, v=q['volume'][i] or 0))
    return out


def tick(p):
    return 0.0001 if p < 1 else 0.01


tickers = [x.strip() for x in open(args.tickers) if x.strip()]
os.makedirs(args.cache, exist_ok=True)
got = 0
for n, tk in enumerate(tickers):
    if fetch(tk):
        got += 1
    if (n + 1) % 50 == 0:
        print(f'  fetched {n + 1}/{len(tickers)} ({got} with data)', file=sys.stderr, flush=True)
if args.fetch_only:
    print(f'{got} of {len(tickers)} tickers have bars')
    raise SystemExit(0)

# The runners list as it stood on a day, by our own rule.
days_of = defaultdict(list)     # ticker → [(date, max_chg)]
if args.days:
    for row in open(args.days):
        tk, d, chg = row.strip().split(',')
        days_of[tk].append((datetime.date.fromisoformat(d), float(chg)))


def listed(tk, day):
    """True / False by the list's rule on `day`; None when our screen never held the ticker."""
    rows = days_of.get(tk)
    if not rows:
        return None
    for d, chg in rows:
        back = (day - d).days
        if (1 <= back <= 90 and chg >= 30) or (1 <= back <= 5 and chg >= 20):
            return True
    return False


# Was the ticker on our Momentum screen just before a fill? (the operator: "usually it happens after
# a catalyst" — a name with one is a day's gainer on volume, which is what the screen holds)
SCREEN = defaultdict(dict)      # ticker → {5-minute bucket: highest change % seen on the screen}
if args.onscreen:
    import gzip
    with gzip.open(args.onscreen, 'rt') as fh:
        for row in fh:
            f = row.strip().split(',')
            if len(f) >= 3 and f[2]:
                SCREEN[f[0]][int(f[1])] = float(f[2])


def on_screen(tk, t):
    """The highest change % the screen showed for the ticker in the 15 minutes before bar `t`; None if it wasn't on it."""
    b = int(t.timestamp()) // 300
    seen = [SCREEN[tk][k] for k in (b - 1, b - 2, b - 3) if k in SCREEN.get(tk, {})]
    return max(seen) if seen else None


class Tape:
    """One ticker's 5m bars with what the outcomes need: bar times, the sessions, each one's last bar."""
    def __init__(self, bars):
        self.bars = bars
        self.times = [b['t'] for b in bars]
        self.last = {}
        for i, b in enumerate(bars):
            self.last[b['t'].date()] = i
        self.dates = sorted(self.last)

    def after_fill(self, i, fill, stop):
        """A fill inside bar i at `fill`, the 1R stop at `stop` → what followed (the bars after i)."""
        bars = self.bars
        k = bisect.bisect_left(self.dates, bars[i]['t'].date())
        eod_i = self.last[self.dates[k]]
        end3 = self.last[self.dates[min(k + 3, len(self.dates) - 1)]]
        h1_i = bisect.bisect_right(self.times, bars[i]['t'] + datetime.timedelta(minutes=60)) - 1
        out = dict(eod=bars[eod_i]['c'] / fill - 1,
                   h1=bars[h1_i]['c'] / fill - 1 if h1_i > i else None,
                   d3=bars[end3]['c'] / fill - 1 if k + 3 < len(self.dates) else None)
        # the rest of the session: the run, the dip, and a -5% / +10% bracket (the stop first when a bar holds both)
        hi = lo = bars[i]['c']
        br = None
        for m in range(i + 1, eod_i + 1):
            b = bars[m]
            hi, lo = max(hi, b['h']), min(lo, b['l'])
            if br is None:
                if b['l'] <= fill * 0.95:
                    br = min(fill * 0.95, b['o']) / fill - 1
                elif b['h'] >= fill * 1.10:
                    br = 0.10
        out['br'] = br if br is not None else out['eod']
        out['br_won'] = br == 0.10
        out['run'], out['dip'] = (hi / fill - 1) * 100, (lo / fill - 1) * 100
        # cut the losers, keep the winners: a stop 5% under the fill and no target, out at the
        # session's end (`cut`) or at the end of the third session after (`cut3`)
        cut_v = cut3_v = None
        for m in range(i + 1, end3 + 1):
            b = bars[m]
            if b['l'] <= fill * 0.95:
                hit = min(fill * 0.95, b['o']) / fill - 1
                if m <= eod_i:
                    cut_v = hit
                cut3_v = hit
                break
        out['cut'] = cut_v if cut_v is not None else out['eod']
        out['cut3'] = cut3_v if cut3_v is not None else out['d3']
        # 1R: stop at `stop`, target the same distance over the fill, 3 sessions
        risk = fill - stop
        if risk > 0:
            r1 = None
            for m in range(i + 1, end3 + 1):
                b = bars[m]
                if b['l'] <= stop:
                    r1 = -1.0
                    break
                if b['h'] >= fill + risk:
                    r1 = 1.0
                    break
            out['r1'] = r1 if r1 is not None else (bars[end3]['c'] - fill) / risk
        return out

    def span(self, t_close, next_close, expire):
        """The bars an order placed at t_close is live on → (first bar, last bar)."""
        i0 = bisect.bisect_left(self.times, t_close)
        k = bisect.bisect_left(self.dates, t_close.date())
        i_end = self.last[self.dates[min(k + expire, len(self.dates) - 1)]] if self.dates else -1
        if next_close is not None:
            i_end = min(i_end, bisect.bisect_left(self.times, next_close) - 1)
        return i0, i_end

    def place(self, i0, i_end, p, lift, dip_stop=None):
        """A buy stop at p × (1 + lift %) on bars i0..i_end → the fill's outcomes, or None.
        lift 0: bought at p (the DIP's close), the 1R stop at dip_stop. lift 'c8': not a resting
        stop — bought at the close of the first 5m bar that closes at or over the +8% level."""
        bars = self.bars
        if lift == 0:
            if i0 > i_end:
                return None
            o = self.after_fill(i0 - 1, p, dip_stop)
            o.update(wait=0.0, gap=0.0, bar=0.0, t=bars[i0 - 1]['t'], fill=p,
                     rth=570 <= bars[i0 - 1]['t'].hour * 60 + bars[i0 - 1]['t'].minute < 960)
            return o
        on_close = isinstance(lift, str)
        level = p * (1 + (int(lift[1:]) if on_close else lift) / 100)
        for m in range(i0, i_end + 1):
            b = bars[m]
            if (b['c'] if on_close else b['h']) >= level:
                fill = b['c'] if on_close else max(level, b['o'])
                o = self.after_fill(m, fill, p)
                o.update(wait=(b['t'] - bars[i0 - 1]['t']).total_seconds() / 3600, gap=(fill / level - 1) * 100,
                         bar=(b['c'] / fill - 1) * 100, t=b['t'], fill=fill,
                         rth=570 <= b['t'].hour * 60 + b['t'].minute < 960)
                return o
        return None


ROWS, CTRL = [], []      # one per DIP / per control anchor: day, ticker, listed, n, and per level the outcome or None
REPLAY = []              # (ticker, the DIP candle's close time), for the check against the live rows
TAPES = {}
for tk in tickers:
    path = os.path.join(args.cache, f'{tk}.json')
    bars = load(path) if os.path.exists(path) else []
    if len(bars) < 500:
        continue
    tape = TAPES[tk] = Tape(bars)
    candles = pinesim.resample_session(bars, args.rsi)
    res = pinesim.rsi_rule_direct(candles, P_RSI)
    by_t = {c['t']: c for c in candles}
    step = datetime.timedelta(minutes=args.rsi)
    dips = res['dips']
    for j, (t0, n, low_px, age) in enumerate(dips):
        c = by_t[t0]
        nxt = dips[j + 1][0] + step if j + 1 < len(dips) else None
        i0, i_end = tape.span(t0 + step, nxt, args.expire)
        REPLAY.append((tk, t0 + step))
        if i0 < 1 or i0 >= len(bars):
            continue
        row = dict(tk=tk, day=t0.date(), n=n, listed=listed(tk, t0.date()), px=c['c'])
        for L in LEVELS + CLOSES:
            o = row[L] = tape.place(i0, i_end, c['c'], L, dip_stop=low_px - tick(c['c']))
            if o is not None:
                o['scr'] = on_screen(tk, o['t'])
        ROWS.append(row)
    dip_t = {t for t, *_ in dips}
    for j in range(60, len(candles), args.stride):
        c = candles[j]
        if c['t'] in dip_t:
            continue
        i0, i_end = tape.span(c['t'] + step, None, args.expire)
        if i0 < 1 or i0 >= len(bars):
            continue
        row = dict(tk=tk, day=c['t'].date(), n=0, listed=listed(tk, c['t'].date()), px=c['c'])
        for L in LEVELS + CLOSES:
            o = row[L] = tape.place(i0, i_end, c['c'], L, dip_stop=c['c'] * 0.95)
            if o is not None:
                o['scr'] = on_screen(tk, o['t'])
        CTRL.append(row)

all_days = sorted({r['day'] for r in ROWS})
cut = all_days[int(len(all_days) * args.split)]
print(f"{len(TAPES)} tickers with bars (of {len(tickers)}), {all_days[0]} → {all_days[-1]} | RSI {args.rsi}m checked at {args.check}m | "
      f"{len(ROWS):,} DIPs ({len(ROWS) / len(all_days):.0f} a day) | orders live {args.expire} sessions | in sample before {cut}")


def avg(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else float('nan')


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else float('nan')


def share(xs):
    xs = [x for x in xs if x is not None]
    return sum(1 for x in xs if x) / len(xs) * 100 if xs else float('nan')


def trimmed(xs, top=0.01):
    """The mean without the best `top` share of the values: how much of it a few runners carry."""
    xs = sorted(x for x in xs if x is not None)
    keep = xs[:max(1, len(xs) - max(1, round(len(xs) * top)))] if len(xs) > 20 else xs
    return statistics.mean(keep) if keep else float('nan')


def line(rows, L, keep=lambda o: True, same_day=False):
    """One row of a table. same_day: the bars end with the fill's session (the live alerts), so no 3-session columns."""
    f = [r[L] for r in rows if r[L] is not None and keep(r[L])]
    if not rows or not f:
        return '     —'
    later = '' if same_day else (f"3d {avg(o['d3'] for o in f) * 100:+5.1f}%  cut3 {avg(o['cut3'] for o in f) * 100:+5.2f}%  "
                                 f"1R {avg(o.get('r1') for o in f):+5.2f} (won {share(o['r1'] >= 1 for o in f if 'r1' in o):3.0f}%)  ")
    return (f"{len(f):>5,} ({len(f) / len(rows) * 100:3.0f}%)  wait {med(o['wait'] for o in f):5.1f}h  "
            f"1h {avg(o['h1'] for o in f) * 100:+5.1f}%  eod {avg(o['eod'] for o in f) * 100:+5.1f}%  "
            f"up at eod {share(o['eod'] > 0 for o in f):3.0f}%  -5/+10 {avg(o['br'] for o in f) * 100:+5.2f}% (target {share(o['br_won'] for o in f):3.0f}%)  "
            f"cut -5 {avg(o['cut'] for o in f) * 100:+5.2f}% (less top 1%: {trimmed(o['cut'] for o in f) * 100:+5.2f}%, stopped {share(o['cut'] <= -0.05 for o in f):3.0f}%)  "
            f"{later}run {med(o['run'] for o in f):+5.1f}%  dip {med(o['dip'] for o in f):+5.1f}%")


def table(title, rows, keep=lambda o: True, levels=LEVELS):
    a = [r for r in rows if r['day'] < cut]
    b = [r for r in rows if r['day'] >= cut]
    if not a and not b:
        return
    print(f"\n== {title}: {len(a):,} in sample, {len(b):,} out ==")
    for L in levels:
        name = NAME.get(L, f'stop +{L}%')
        print(f"  {name:<11} in  {line(a, L, keep)}\n  {'':<11} out {line(b, L, keep)}")


table('all DIPs', ROWS)
table('all DIPs, bought at a 5m close over the level instead of on a touch', ROWS, levels=CLOSES)
table('CONTROL: the same orders above closes that are not DIPs', CTRL)
table('CONTROL, at a 5m close over the level', CTRL, levels=CLOSES)
table('listed on the DIP day (the runners list as it stood)', [r for r in ROWS if r['listed'] is True])
table('CONTROL, listed on the day', [r for r in CTRL if r['listed'] is True])
table('not listed on the DIP day', [r for r in ROWS if r['listed'] is False], levels=[0, 8])
table('tickers our screen never held', [r for r in ROWS if r['listed'] is None], levels=[0, 8])
if args.onscreen:
    table('fills with the ticker on our Momentum screen in the 15 minutes before', ROWS, keep=lambda o: o['scr'] is not None, levels=[0, 5, 8, 12])
    table('…on the screen and up 20%+ on the day there', ROWS, keep=lambda o: o['scr'] is not None and o['scr'] >= 20, levels=[0, 5, 8, 12])
    table('fills with the ticker not on the screen', ROWS, keep=lambda o: o['scr'] is None, levels=[0, 5, 8, 12])
    table('CONTROL, on the screen in the 15 minutes before', CTRL, keep=lambda o: o['scr'] is not None, levels=[0, 8])
    table('CONTROL, on the screen and up 20%+', CTRL, keep=lambda o: o['scr'] is not None and o['scr'] >= 20, levels=[0, 8])
    table('on the screen, regular hours', ROWS, keep=lambda o: o['scr'] is not None and o['rth'], levels=[0, 8])
table('fills in regular hours only (09:30–16:00)', ROWS, keep=lambda o: o['rth'], levels=[0, 5, 8, 12])
table('fills that did not gap 2%+ over the level (what a stop-limit gets)', ROWS, keep=lambda o: o['gap'] < 2, levels=[5, 8, 12])
table('first turn of a dip (#1)', [r for r in ROWS if r['n'] == 1], levels=[0, 8])
table('under $1', [r for r in ROWS if r['px'] < 1], levels=[0, 8])
table('$1 to $5', [r for r in ROWS if 1 <= r['px'] < 5], levels=[0, 8])
table('$5 and over', [r for r in ROWS if r['px'] >= 5], levels=[0, 8])

# What the +8% order skips: buying the DIP on the ones it never fills.
print('\n== buying the DIP itself, split by whether the +8% order later filled ==')
for name, rows in (('in ', [r for r in ROWS if r['day'] < cut]), ('out', [r for r in ROWS if r['day'] >= cut])):
    print(f"  +8% filled       {name} {line([r for r in rows if r[8] is not None], 0)}\n"
          f"  +8% never filled {name} {line([r for r in rows if r[8] is None], 0)}")

f8 = [r[8] for r in ROWS if r[8] is not None]
if f8:
    waits = sorted(o['wait'] for o in f8)
    q = lambda p: waits[min(len(waits) - 1, int(len(waits) * p))]
    print(f"\n+8% fills: {len(f8):,} of {len(ROWS):,} DIPs ({len(f8) / len(ROWS) * 100:.0f}%); wait quartiles {q(0.25):.1f}h / {q(0.5):.1f}h / {q(0.75):.1f}h; "
          f"gapped 2%+ over the level: {share(o['gap'] >= 2 for o in f8):.0f}%; in regular hours: {share(o['rth'] for o in f8):.0f}%; "
          f"the fill's own 5m bar closed under the fill {share(o['bar'] < 0 for o in f8):.0f}% of the time (on average {avg(o['bar'] for o in f8):+.1f}%)")
    print('== +8% fills by the wait ==')
    for lo, hi in ((0, 1), (1, 4), (4, 12), (12, 30), (30, 10**9)):
        for name, keep in (('in ', lambda r: r['day'] < cut), ('out', lambda r: r['day'] >= cut)):
            sel = [r for r in ROWS if keep(r) and r[8] is not None and lo <= r[8]['wait'] < hi]
            if sel:
                label = f'{lo}h+' if hi >= 10**9 else f'{lo}–{hi}h'
                print(f"  {label:<7} {name} {line(sel, 8)}")

# The live alerts themselves (their own prices and times), as far as the bars reach after them.
if args.live:
    live = []
    for row in open(args.live):
        f = row.strip().split(',')
        if len(f) >= 8 and f[2] == 'dip' and f[3]:
            live.append((f[0], datetime.datetime.fromtimestamp(int(f[1]), ET), float(f[3]), f[6]))
    same = [(tk, t) for tk, t, _, tf in live if tf == str(args.rsi) and tk in TAPES]
    if same:
        t_lo, t_hi = min(t for _, t in same), max(t for _, t in same)
        pad = datetime.timedelta(minutes=15)
        rep = [(tk, t) for tk, t in REPLAY if t_lo - pad <= t <= t_hi + pad]
        near = lambda a, pool: any(a[0] == b[0] and abs((a[1] - b[1]).total_seconds()) <= 900 for b in pool)
        print(f"\nreplay check, {t_lo:%m-%d %H:%M} → {t_hi:%H:%M} ET, the {args.rsi}m RSI: {len(same)} live DIP alerts on tickers with bars; the replay has "
              f"{sum(1 for a in same if near(a, rep))} of them within 15 min, and {len(rep)} DIPs of its own there ({sum(1 for a in rep if near(a, same))} alerted live)")
    by_tk = defaultdict(list)
    for tk, t, p, tf in live:
        by_tk[tk].append((t, p))
    rows = []
    for tk, lst in by_tk.items():
        tape = TAPES.get(tk)
        if not tape:
            continue
        lst.sort()
        for j, (t, p) in enumerate(lst):
            i0 = bisect.bisect_right(tape.times, t)
            i_end = len(tape.bars) - 1
            if j + 1 < len(lst):
                i_end = min(i_end, bisect.bisect_right(tape.times, lst[j + 1][0]) - 1)
            if i0 < 1 or i0 > len(tape.bars) - 1:
                continue
            row = dict(day=t.date(), tk=tk, t=t, p=p)
            for L in (0, 5, 8, 12, 'c8'):
                row[L] = tape.place(i0, i_end, p, L, dip_stop=p * 0.95)
            rows.append(row)
    print(f"\n== the live DIP alerts themselves ({len(rows)} with bars after them; 11-12 and 11-13 only, so 'eod' is all there is) ==")
    for d in sorted({r['day'] for r in rows}):
        sel = [r for r in rows if r['day'] == d]
        for L in (0, 5, 8, 12, 'c8'):
            print(f"  {d} {NAME.get(L, f'stop +{L}%'):<11} {line(sel, L, same_day=True)}")
    if args.dump:
        print('\n== the live alerts whose +8% order filled: ticker, the DIP, the fill, then ==')
        for r in sorted(rows, key=lambda r: r['t']):
            o = r[8]
            if o:
                print(f"  {r['tk']:<6} DIP {r['t']:%m-%d %H:%M} {r['p']:<8g} fill {o['t']:%m-%d %H:%M} {o['fill']:<8.4g} wait {o['wait']:5.1f}h  "
                      f"bar {o['bar']:+5.1f}%  1h {(o['h1'] or 0) * 100:+6.1f}%  eod {o['eod'] * 100:+6.1f}%  run {o['run']:+6.1f}%  dip {o['dip']:+6.1f}%")
