import { useEffect, useMemo, useState } from 'react';
import { App, Button, Dropdown, Modal, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { CaretDownOutlined, CaretRightOutlined, EllipsisOutlined } from '@ant-design/icons';
import type { CyclePayload, OpportunityAlert, TvSetupInfo, TvStage } from '../../api/types';
import { tvApi, type TvWatchlist } from '../../api/tv';
import { useAlertLog } from '../../hooks/useAlertLog';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { TvStageTag, tvLevelsText, fmtTf, isVbStage, lineTokens, lineDistanceText, crossTfText, retestStopText } from '../common/TvStageTag';
import { GradeCell } from '../common/GradeCell';
import { fmtPct, fmtPrice } from '../../utils/format';
import pineScript from '../../tv/mvwap-bb-setup.pine?raw';
import rvolScript from '../../tv/rvol.pine?raw';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // UTC+5, the operator's clock

// What counts as live (operator, 2026-10-05): a fresh CROSS (v21) or RETEST (v28),
// or a pullback still waiting at its line. Everything else is "earlier".
const LIVE_MIN = { pullback: 60, cross: 15, retest: 15 } as const;
// The 1m and 2m alerts report the same stage separately; within this window
// they are one event.
const MERGE_MS = 5 * 60_000;

interface SetupEvent {
  id: string;
  at: number;          // ms
  price: number | null;
  setup: TvSetupInfo;
  tfs: string[];       // the alert timeframes that reported it
  notified: boolean;
}
interface TickerCard {
  ticker: string;
  events: SetupEvent[];   // oldest first, 1m/2m copies merged — every stage (the day trail)
  current: SetupEvent;    // the live event, or the latest one of a shown stage
  live: boolean;
  resolved: boolean;      // CROSS / RETEST / HELD / BROKEN, or a PULLBACK a later BROKEN / HELD closed
  // How a PULLBACK shown as current ended — labelled on the row, since BROKEN /
  // HELD are usually switched off and hidden (2026-10-13, WFF 00:34 → broke 00:35).
  outcome: { stage: 'broken' | 'held'; at: number } | null;
}

// One setup thread per line combination: pullback (session / month / year and
// combinations). A pullback's BROKEN / HELD also closes an open pullback on any
// combination sharing one of its lines. The v21 VWAP + BB cross and its v28
// RETEST are their own thread, one per line combination (v22).
function threadOf(s: TvSetupInfo): string {
  if (isVbStage(s.stage)) return `vb:${lineTokens(s.stage, s.line).join('+')}`;
  return `pb:${lineTokens(s.stage, s.line).join('+') || 'none'}`;
}

// `shown`: the ⚙ menu's 📐 stage switches (2026-10-06). A switched-off stage
// never becomes a card's current state, so a ticker with only such events has
// no card; BROKEN / HELD still close a pullback even while hidden.
function buildCards(alerts: OpportunityAlert[], now: number, shown: (stage: TvStage) => boolean): TickerCard[] {
  const byTicker = new Map<string, SetupEvent[]>();
  const sorted = alerts
    .filter((a) => a.kinds.includes('tv_setup') && a.setup)
    .map((a) => ({ a, at: Date.parse(a.at) }))
    .sort((x, y) => x.at - y.at);
  for (const { a, at } of sorted) {
    const s = a.setup!;
    const list = byTicker.get(a.ticker) ?? [];
    // A VB CROSS / RETEST comes from one alert: only a copy of the same one merges, not the next.
    const dup = list.find((e) => e.setup.stage === s.stage && threadOf(e.setup) === threadOf(s) && at - e.at <= MERGE_MS
      && (s.stage !== 'cross' || e.setup.cross_n === s.cross_n) && (s.stage !== 'retest' || e.setup.retest_n === s.retest_n));
    if (dup) {
      if (s.tf && !dup.tfs.includes(s.tf)) dup.tfs.push(s.tf);
      dup.notified ||= s.notified;
    } else {
      list.push({ id: a.id, at, price: a.price, setup: s, tfs: s.tf ? [s.tf] : [], notified: s.notified });
    }
    byTicker.set(a.ticker, list);
  }
  const cards: TickerCard[] = [];
  for (const [ticker, events] of byTicker) {
    const latest = new Map<string, SetupEvent>();
    for (const e of events) {
      const th = threadOf(e.setup);
      latest.set(th, e);
      if (e.setup.stage === 'broken' || e.setup.stage === 'held') {
        const lines = lineTokens(e.setup.stage, e.setup.line);
        for (const [k, open] of latest) {
          if (k !== th && open.setup.stage === 'pullback' && open.at < e.at
            && lineTokens(open.setup.stage, open.setup.line).some((t) => lines.includes(t))) latest.set(k, e);
        }
      }
    }
    let live: SetupEvent | null = null;
    for (const e of latest.values()) {
      const limit = (LIVE_MIN as Record<string, number | undefined>)[e.setup.stage];
      if (shown(e.setup.stage) && limit != null && now - e.at <= limit * 60_000 && (!live || e.at > live.at)) live = e;
    }
    const current = live ?? [...events].reverse().find((e) => shown(e.setup.stage));
    if (!current) continue;
    const st = current.setup.stage;
    const closer = latest.get(threadOf(current.setup));
    const closed = st === 'pullback' && closer != null && closer !== current
      && (closer.setup.stage === 'broken' || closer.setup.stage === 'held');
    const resolved = st === 'cross' || st === 'retest' || st === 'held' || st === 'broken' || closed;
    const outcome = closed ? { stage: closer!.setup.stage as 'broken' | 'held', at: closer!.at } : null;
    cards.push({ ticker, events, current, live: live != null, resolved, outcome });
  }
  return cards;
}

// "+1.2% vs sVWAP" — where price sat against the setup's own line at the signal.
function lineDistance(s: TvSetupInfo): string {
  const first = lineTokens(s.stage, s.line)[0] ?? 'session';
  return lineDistanceText(s, first) ?? '';
}

// A pullback to a line that already held today, or its 3rd+ touch (a 3rd
// touch only comes after one held: the cap counts failures). First live
// grading, 2026-10-18: these held 33–36% vs 24% for the rest. Announced
// pullbacks only — the quiet ones past the cap held 6%.
function provenLine(c: TickerCard, e: SetupEvent): string | null {
  if (e.setup.stage !== 'pullback' || !e.notified) return null;
  const lines = lineTokens('pullback', e.setup.line);
  const heldBefore = c.events.some((x) => x.setup.stage === 'held' && x.at < e.at
    && lineTokens('held', x.setup.line).some((t) => lines.includes(t)));
  if (heldBefore) return '↺ held before';
  return (e.setup.touch ?? 0) >= 3 ? '↺ touch 3+' : null;
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

// "30S" < "1" < "2": seconds before minutes, then by length.
function tfSeconds(tf: string): number {
  return /^\d+S$/i.test(tf) ? Number.parseInt(tf, 10) : /^\d+$/.test(tf) ? Number(tf) * 60 : Number.MAX_SAFE_INTEGER;
}
function byTf(a: string, b: string): number {
  return tfSeconds(a) - tfSeconds(b);
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

const HOW_TO = (
  <div style={{ fontSize: 13, lineHeight: 1.6 }}>
    <div><b>1.</b> <b>Copy Pine script</b> → TradingView Pine Editor → paste → Add to chart. Its yellow line is the month VWAP, the purple one the session VWAP. With “VWAP lines from: chart bars” they sit exactly on TradingView's own “VWAP Month” and “VWAP Session”; with the default, 30s bars, they can differ a little on a 5m chart (see <b>VWAP lines</b> below). Its blue line is this year's VWAP built from hourly bars (v14). On liquid names it can differ from TradingView's own “VWAP Year” on an intraday chart, which only reaches back as far as the chart has loaded. Trust the blue one.</div>
    <div><b>2.</b> <b>Download .txt</b> → watchlist menu → Import list (or paste <b>Copy list</b>). Refresh it each morning. During the day the sidebar flags new names missing from it — <b>Copy</b> and add them to the watchlist (the alerts pick up added symbols by themselves).</div>
    <div><b>3.</b> Create <b>two</b> alerts → Symbols: that watchlist → Condition: <i>mVWAP-BB</i> → “Any alert() function call” · session Extended · once per bar close — one on <b>1 minute</b>, one on <b>30 seconds</b>.</div>
    <div><b>↻</b> After a script update: paste the new version, Save, then delete and recreate both alerts. For <b>v28</b>: after pasting it, open the indicator's Settings → Defaults → <b>Reset settings</b> once more. The defaults are your settings (gainer filter 10%, VB candle 5m, band 45s, tolerance 0), and the reset also restores the chart markers (BROKEN / HELD hidden, RETEST shown). Then recreate both alerts, and tick <b>RETEST</b> in ⚙ → 📐 Stages that alert if it isn't.</div>
    <div><b>On / off</b>: each setup has a switch in the script's Inputs — “Pullback setup on”, “VWAP + BB cross setup on”. Off = no markers and no alerts from it; a VWAP line no setup uses isn't drawn. The alerts copy the switches when you create them.</div>
    <div><b>VWAP lines</b> (v28): the Inputs' “VWAP lines from” picks how the script builds its VWAPs, for the lines it draws and for every setup. <b>30s bars</b> (ours, the default): built from 30-second bars, so the line is the same on your 5m and 30s charts and closer to the true VWAP. <b>Chart bars</b>: TradingView's built-in way, from each chart's own bars, so it differs by timeframe (on your alerts, a 5m chart's line sat a median 0.4% from the 30s chart's, a 10m chart's 1.6%). The alerts copy the choice when you create them.</div>
    <div><b>VB lanes</b> (v29): the Inputs' “VB lanes” add up to three more candle timeframes to the same 30s alert, for longer trades — by default <b>1h</b> (10m band), <b>4h</b> (30m band) and <b>1D</b> (1h band), each on the <b>month and year</b> lines only. Each lane has its own candle, band and lines; the rest (BB length, tolerance, gainers, the retest) is shared. Their CROSS / RETEST rows show the lane's timeframes (<b>1h/10m</b>, <b>4h/30m</b>, <b>1D/1h</b>) and ping even off Momentum (a longer trade needn't be on today's screen; the daily cap still applies). On a 4h or daily lane a month / year retest carries over to the next day. A lane's markers draw on a chart of its candle timeframe (a 1h chart for the 1h lane). Untested on our data, which can't follow a trade past the day.</div>
    <div><b>4.</b> Notifications → Webhook URL: <code>https://pnldash.uz/api/tv/webhook?key=…</code> (the key is TV_WEBHOOK_SECRET).</div>
    <div><b>RVol</b> (optional): ⋯ → <b>Copy RVol script</b> → a new Pine Editor tab → Add to chart. It shows the Momentum table's RVol 1m / 5m / Day in its own pane, in the same units; set the pane's scale to Logarithmic. No alert needed.</div>
    <div style={{ marginTop: 8, color: '#8c8c8c' }}>
      <b>Reading the list.</b> Two setups: <b>PULLBACK</b> (price back near a VWAP line after a run; then BROKEN or HELD) and the <b>VWAP + BB cross</b> (CROSS, then RETEST). A CROSS or a RETEST pings only when the name is on Momentum (⭐) or its day high is +30% or more; off-list ones show dimmed.
      <span style={{ color: '#95de64' }}> ↺ held before</span> / <span style={{ color: '#95de64' }}>↺ touch 3+</span> on a pullback: that line already held today, or this is its 3rd+ touch. On the first 10 live days (to 10-16) those held 33–36% of the time, against 24% for the rest.
      <div style={{ marginTop: 6 }}>
        <b>CROSS</b> (v21, the 30s alert only): a candle of the timeframe you set (default <b>5m</b>) crosses a VWAP line and the upper BB of the other timeframe you set (default <b>45s</b>): at a 30s close inside it, its open is under both as they stand then (with the tolerance setting above 0, an open up to that % over the lower line also counts; default 0) and the close is above both — the body crosses the lines the chart draws for that candle (v23; the day's first candle counts). The lines (v22): session (<b>S</b>), month (<b>M</b>) and year (<b>Y</b>), each with its own count. It rings while the candle is still open, and on the candle timeframe's chart that candle gets a marker: teal <b>VB</b> (session), yellow <b>VB M</b> (month), blue <b>VB Y</b> (year). The tag shows the line, the timeframes and the day's cross number on that line (#1 = first); after a line's 3rd cross of the day, its crosses stay quiet, and so do crosses on names off our Momentum list unless the day high is +30% or more (a runner the screen hasn't caught yet). ⚙ → 📐 Stages that alert → CROSS turns it on or off.
      </div>
      <div style={{ marginTop: 6 }}>
        <b>RETEST</b> (v28, the 30s alert only): your entry. After the VB candle closes, price comes back to the VWAP line it crossed (within 1% of it, or under it), and (v30) <b>the candle that came back closes above the line</b> — it rings at that candle's close (a candle closing under it gives no RETEST and ends it); the Inputs' “VB retest fires” can switch back to v28's first green 30s close above the line. Its row shows <b>retest · stop $X</b>: the stop under the pullback's low, with its distance from the RETEST price. A newer VB candle starts a new one, and a candle closing back under the line cancels it (on your VB timeframe, so a wick under the line doesn't). Like CROSS it pings only on Momentum names (or a day high of +30% or more), its tag shows the timeframes and the ticker's retest number for the day, and after its 3rd of the day it stays quiet. It waits up to 6 candles after the VB candle closes (an input). Measured on four months: the cheapest entry per trade (−0.9% against −1.3% for buying the break of the VB high and −1.9% for buying the CROSS), with a ~2% stop, but stopped more often — a heads-up, not an edge. ⚙ → RETEST turns it on or off.
      </div>
    </div>
  </div>
);

// The TradingView watchlist the alerts run on is pasted in by hand (TradingView
// has no watchlist API), and the alerts only see names that are on it. The
// sidebar remembers what the last Copy list / Download held (this browser) and
// flags today's screen names that weren't in it — a name that wasn't a runner
// yet goes unwatched all day otherwise (MI 2026-10-05: +634%, no alerts).
// Watchlist alerts pick up added symbols by themselves; no alert recreation.
const LIST_KEY = 'tvList.lastCopied';
interface CopiedList { at: number; symbols: string[] }   // bare tickers
const bareSym = (s: string) => s.replace(/^[A-Z_]+:/i, '').toUpperCase();
function loadCopied(): CopiedList | null {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    return raw ? (JSON.parse(raw) as CopiedList) : null;
  } catch {
    return null;
  }
}
// Replace the remembered list (a full Copy / Download) or add to it (Copy new).
function saveCopied(symbols: string[], addTo: CopiedList | null): CopiedList {
  const v = { at: Date.now(), symbols: [...new Set([...(addTo?.symbols ?? []), ...symbols.map(bareSym)])] };
  try { localStorage.setItem(LIST_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  return v;
}

// 📐 setups in the left rail (operator, 2026-10-05: "organize this list … move
// it to the sidebar"). One row per ticker with its CURRENT state — the stage,
// its line (S session / M month / Y year), touch #, age and the distance to
// the line — live setups first, the rest under "Earlier today", each section
// newest first (operator: order by alert time; ⭐ still marks Momentum names).
// The 1m and 2m alerts' copies merge into one event. A click selects the
// ticker and opens its day trail.
export function TvSetupsSidebar({ payload }: { payload: CyclePayload | null }) {
  const { message } = App.useApp();
  const { selected, setSelected } = useSelection();
  const { alerts } = useAlertLog(payload);
  const { settings: stageSettings } = useTvAlertStages();
  // A ticker hidden from Momentum (today, this user) is hidden here too (2026-10-07).
  const { hidden } = useHiddenTickers();
  const hiddenKey = [...hidden].sort().join(',');
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showEarlier, setShowEarlier] = useState(() => {
    try { return localStorage.getItem('tvSidebar.earlier') !== '0'; } catch { return true; }
  });
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopiedList | null>(() => loadCopied());
  // Today's screen names come first in the server's list (`today` of them).
  const { data: tvList } = useQuery({
    queryKey: ['tv', 'watchlist'],
    queryFn: () => tvApi.watchlist(),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const missing = useMemo(() => {
    if (!tvList || !copied) return [];
    const have = new Set(copied.symbols);
    return tvList.symbols.slice(0, tvList.today).filter((sym) => !have.has(bareSym(sym)) && !hidden.has(bareSym(sym)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenKey stands in for the Set
  }, [tvList, copied, hiddenKey]);

  useEffect(() => {
    // 5 s (was 30 s): the 20-s "just rang" highlight below has to clear on time.
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  const rowByTicker = useMemo(() => new Map((payload?.rows ?? []).map((r) => [r.ticker, r])), [payload]);
  // Until the switches load, show every stage rather than flash an empty list.
  const allCards = useMemo(() => {
    const on = stageSettings ? new Set(stageSettings.announced) : null;
    return buildCards(alerts, now, (st) => on == null || on.has(st));
  }, [alerts, now, stageSettings]);
  const cards = useMemo(
    () => allCards.filter((c) => !hidden.has(c.ticker)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenKey stands in for the Set
    [allCards, hiddenKey],
  );
  const hiddenCount = allCards.length - cards.length;
  const live = cards.filter((c) => c.live).sort((x, y) => y.current.at - x.current.at);
  const earlier = cards.filter((c) => !c.live).sort((x, y) => y.current.at - x.current.at);

  const toggleEarlier = () => setShowEarlier((v) => {
    try { localStorage.setItem('tvSidebar.earlier', v ? '0' : '1'); } catch { /* private mode */ }
    return !v;
  });
  const toggleOpen = (t: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });

  const withList = async (use: (list: TvWatchlist) => Promise<void> | void) => {
    setBusy(true);
    try {
      await use(await tvApi.watchlist());
    } catch (err) {
      message.error(`Could not build the list: ${err instanceof Error ? err.message : 'error'}`);
    } finally {
      setBusy(false);
    }
  };
  const menu = {
    items: [
      { key: 'copy', label: 'Copy list' },
      { key: 'download', label: 'Download .txt' },
      { key: 'script', label: 'Copy Pine script' },
      { key: 'rvol', label: 'Copy RVol script' },
      { key: 'howto', label: 'How to set up the alerts' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'copy') {
        void withList(async (list) => {
          await navigator.clipboard.writeText(list.symbols.join(','));
          setCopied(saveCopied(list.symbols, null));
          message.success(`Copied ${list.symbols.length} symbols — ${list.today} on today's screen + ${list.runners} runners (≥+${list.min_chg}% in ${list.days}d, ≥+${list.recent_min_chg}% in the last 3 sessions)`);
        });
      } else if (key === 'download') {
        void withList((list) => {
          const url = URL.createObjectURL(new Blob([list.symbols.join(',')], { type: 'text/plain' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `pnldash-runners-${new Date().toISOString().slice(0, 10)}.txt`;
          a.click();
          URL.revokeObjectURL(url);
          setCopied(saveCopied(list.symbols, null));
          message.success(`Downloaded ${list.symbols.length} symbols — import it from the TradingView watchlist menu`);
        });
      } else if (key === 'script') {
        navigator.clipboard.writeText(pineScript)
          .then(() => message.success('Pine script copied — paste it into the TradingView Pine Editor'))
          .catch(() => message.error('Clipboard blocked by the browser'));
      } else if (key === 'rvol') {
        navigator.clipboard.writeText(rvolScript)
          .then(() => message.success('RVol script copied — paste it into a new Pine Editor tab and Add to chart (no alert needed)'))
          .catch(() => message.error('Clipboard blocked by the browser'));
      } else {
        setHowTo(true);
      }
    },
  };

  const copyNew = () => {
    navigator.clipboard.writeText(missing.join(','))
      .then(() => {
        setCopied(saveCopied(missing, copied));
        message.success(`Copied ${missing.length} new symbol${missing.length === 1 ? '' : 's'} — add them to the TradingView watchlist; the alerts pick them up by themselves`);
      })
      .catch(() => message.error('Clipboard blocked by the browser'));
  };

  const row = (c: TickerCard, dim: boolean) => {
    const e = c.current;
    const s = e.setup;
    const r = rowByTicker.get(c.ticker);
    // Current price / change: the Momentum row when the name is on our screen,
    // otherwise the server's ~1-min quote for 📐 tickers off it (no grade there).
    const q = r ? null : payload?.tv_quotes?.[c.ticker] ?? null;
    const nowPx = r?.price != null ? Number(r.price) : q?.price ?? null;
    const nowChg = r?.change_pct != null ? Number(r.change_pct) : q?.change_pct ?? null;
    const since = nowPx != null && e.price != null && e.price > 0 ? (nowPx / e.price - 1) * 100 : null;
    const expanded = open.has(c.ticker);
    const resolved = c.resolved;
    const proven = provenLine(c, e);
    // 10-20: a setup that just rang is lit for 20 s, so the row behind the sound
    // is easy to find.
    const fresh = e.notified && now - e.at < 20_000;
    // v28: a RETEST row leads with its stop (under the pullback's low) against the RETEST price.
    const retestStop = s.stage === 'retest' ? retestStopText(s, e.price) : null;
    return (
      <div
        key={c.ticker}
        onClick={() => { setSelected(c.ticker); toggleOpen(c.ticker); }}
        style={{
          padding: '5px 8px', borderBottom: '1px solid #262626', cursor: 'pointer',
          borderLeft: `3px solid ${fresh ? '#faad14' : 'transparent'}`,
          background: fresh ? 'rgba(250, 173, 20, 0.12)' : c.ticker === selected ? '#111d2c' : undefined,
          opacity: dim ? (r ? 0.7 : 0.45) : r ? 1 : 0.7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {expanded ? <CaretDownOutlined style={{ fontSize: 9, color: '#8c8c8c' }} /> : <CaretRightOutlined style={{ fontSize: 9, color: '#595959' }} />}
          <TickerLinks ticker={c.ticker} />
          <TickerLink ticker={c.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {r && <span style={{ color: '#fadb14', fontSize: 11 }}>⭐</span>}
          <TvStageTag stage={s.stage} dim={!e.notified} line={s.line} touch={s.stage === 'cross' ? s.cross_n : s.stage === 'retest' ? s.retest_n : s.touch} tfs={crossTfText(s)} />
          {/* v16: past the day's cap — pings only for a B+-or-better Momentum name */}
          {s.capped && <Text type="secondary" style={{ fontSize: 10 }}>past cap</Text>}
          {proven && <span style={{ fontSize: 10, color: '#95de64', whiteSpace: 'nowrap' }}>{proven}</span>}
          {c.outcome && (
            <span style={{ fontSize: 10, color: c.outcome.stage === 'held' ? '#52c41a' : '#ff4d4f', whiteSpace: 'nowrap' }}>
              {c.outcome.stage === 'held' ? '✓ held' : '✗ broke'} {hhmm(c.outcome.at)}
            </span>
          )}
          <Text type="secondary" style={{ fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{age(now - e.at)}</Text>
        </div>
        <div style={{ fontSize: 11, color: '#8c8c8c', paddingLeft: 59, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: nowChg == null ? '#595959' : nowChg >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 700, fontSize: 12 }}>
            {nowChg == null ? '—' : fmtPct(nowChg)}
          </span>
          <span style={{ transform: 'scale(0.9)', transformOrigin: 'left center' }}>
            <GradeCell grade={r?.grade} faded={r?.grade_faded} offHigh={r?.off_high_pct} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {retestStop && <span style={{ color: '#5cdbd3', fontWeight: 600 }}>{retestStop} · </span>}
            {resolved
              ? (since != null
                ? <span style={{ color: since >= 0 ? '#52c41a' : '#ff4d4f' }}>since {since >= 0 ? '+' : ''}{since.toFixed(1)}%</span>
                : 'since —')
              : lineDistance(s)}
            {e.tfs.length > 0 && <> · {[...e.tfs].sort(byTf).map(fmtTf).join('+')}</>}
          </span>
        </div>
        {expanded && (
          <div style={{ paddingLeft: 59, paddingTop: 4, fontSize: 11 }} onClick={(ev) => ev.stopPropagation()}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              {c.events.map((x) => (
                <span key={x.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <TvStageTag stage={x.setup.stage} dim={!x.notified} line={x.setup.line} touch={x.setup.stage === 'cross' ? x.setup.cross_n : x.setup.stage === 'retest' ? x.setup.retest_n : x.setup.touch} />
                  <Text type="secondary" style={{ fontSize: 10 }}>{hhmm(x.at)}</Text>
                </span>
              ))}
            </div>
            <div style={{ color: '#bfbfbf', marginTop: 3 }}>
              {fmtPrice(e.price)} · {tvLevelsText(s, e.price)}
              {s.day_gain != null && <> · day high {s.day_gain >= 0 ? '+' : '−'}{Math.abs(Math.round(s.day_gain))}%</>}
              {/* v28: which VWAP the script used — our 30s-bar line or TradingView's chart-bar one */}
              {s.vwap_src && <> · VWAP from {s.vwap_src === '30s' ? '30s bars' : 'chart bars'}</>}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Text strong style={{ fontSize: 13 }}>📐 Setups</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {live.length} live · {earlier.length} earlier{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
        </Text>
        <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
          <Button size="small" type="text" icon={<EllipsisOutlined />} loading={busy} style={{ marginLeft: 'auto' }} />
        </Dropdown>
      </div>
      {copied && missing.length > 0 && (
        <div style={{ padding: '4px 8px', background: '#2b2111', borderBottom: '1px solid #614700', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#ffd666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ⚠ {missing.length} new, not in your TV list: {missing.map(bareSym).join(', ')}
          </span>
          <Button size="small" onClick={copyNew} style={{ marginLeft: 'auto', flexShrink: 0 }}>Copy</Button>
        </div>
      )}
      {!copied && (
        <div style={{ padding: '4px 8px', borderBottom: '1px solid #262626', fontSize: 11, color: '#8c8c8c' }}>
          ⋯ → Copy list once, and new names missing from your TradingView list will show here.
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414', marginTop: 2 }}>
          LIVE · {live.length}
        </div>
        {live.length === 0 && (
          <div style={{ padding: '8px', fontSize: 11, color: '#595959' }}>Nothing live right now.</div>
        )}
        {live.map((c) => row(c, false))}
        <div
          onClick={toggleEarlier}
          style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414', cursor: 'pointer', marginTop: 2 }}
        >
          {showEarlier ? '▾' : '▸'} EARLIER TODAY · {earlier.length}
        </div>
        {showEarlier && earlier.map((c) => row(c, true))}
        {cards.length === 0 && (
          <div style={{ padding: '8px', fontSize: 11, color: '#595959' }}>
            No setups yet today. Signals appear here when the TradingView alerts fire (⋯ → How to).
          </div>
        )}
      </div>
      <Modal open={howTo} onCancel={() => setHowTo(false)} footer={null} title="Set up the TradingView alerts" width={560}>
        {HOW_TO}
      </Modal>
    </div>
  );
}
