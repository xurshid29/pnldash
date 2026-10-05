import { useEffect, useMemo, useState } from 'react';
import { App, Button, Dropdown, Modal, Typography } from 'antd';
import { CaretDownOutlined, CaretRightOutlined, EllipsisOutlined } from '@ant-design/icons';
import type { CyclePayload, OpportunityAlert, TvSetupInfo } from '../../api/types';
import { tvApi, type TvWatchlist } from '../../api/tv';
import { useAlertLog } from '../../hooks/useAlertLog';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { TvStageTag, StrengthTag, tvLevelsText, fmtTf, fmtSignedPct, isPullbackStage } from '../common/TvStageTag';
import { GradeCell } from '../common/GradeCell';
import { fmtPct, fmtPrice } from '../../utils/format';
import pineScript from '../../tv/mvwap-bb-setup.pine?raw';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // UTC+5, the operator's clock (same as the Alerts tab)

// What counts as live (operator, 2026-10-05): a setup still forming, a fresh
// GO, or a pullback still waiting at its line. Everything else is "earlier".
const LIVE_MIN = { forming: 30, ready: 30, go: 15, pullback: 60 } as const;
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
  events: SetupEvent[];   // oldest first, 1m/2m copies merged
  current: SetupEvent;    // the live event, or the latest one
  live: boolean;
}

// One setup thread per line: reclaim (month / year / both) and pullback
// (session / month / both). A pullback's BROKEN / HELD on a line also closes a
// "both" pullback.
function threadOf(s: TvSetupInfo): string {
  return `${isPullbackStage(s.stage) ? 'pb' : 'rc'}:${s.line ?? 'month'}`;
}

function buildCards(alerts: OpportunityAlert[], now: number): TickerCard[] {
  const byTicker = new Map<string, SetupEvent[]>();
  const sorted = alerts
    .filter((a) => a.kinds.includes('tv_setup') && a.setup)
    .map((a) => ({ a, at: Date.parse(a.at) }))
    .sort((x, y) => x.at - y.at);
  for (const { a, at } of sorted) {
    const s = a.setup!;
    const list = byTicker.get(a.ticker) ?? [];
    const dup = list.find((e) => e.setup.stage === s.stage && threadOf(e.setup) === threadOf(s) && at - e.at <= MERGE_MS);
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
      if ((e.setup.stage === 'broken' || e.setup.stage === 'held') && e.setup.line !== 'both') {
        const both = latest.get('pb:both');
        if (both && both.setup.stage === 'pullback' && both.at < e.at) latest.set('pb:both', e);
      }
    }
    let live: SetupEvent | null = null;
    for (const e of latest.values()) {
      const limit = (LIVE_MIN as Record<string, number | undefined>)[e.setup.stage];
      if (limit != null && now - e.at <= limit * 60_000 && (!live || e.at > live.at)) live = e;
    }
    cards.push({ ticker, events, current: live ?? events[events.length - 1], live: live != null });
  }
  return cards;
}

// "+1.2% vs sVWAP" — where price sat against the setup's own line at the signal.
function lineDistance(s: TvSetupInfo): string {
  if (isPullbackStage(s.stage)) {
    return s.line === 'month' ? `${fmtSignedPct(s.px_pct)} vs mVWAP` : `${fmtSignedPct(s.spx_pct)} vs sVWAP`;
  }
  return s.line === 'year' ? `${fmtSignedPct(s.ypx_pct)} vs yVWAP` : `${fmtSignedPct(s.px_pct)} vs mVWAP`;
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
    <div><b>1.</b> <b>Copy Pine script</b> → TradingView Pine Editor → paste → Add to chart. Its yellow line must sit exactly on your “VWAP Month”, its purple line on your “VWAP Session” and its blue line on your “VWAP Year”.</div>
    <div><b>2.</b> <b>Download .txt</b> → watchlist menu → Import list (or paste <b>Copy list</b>). Refresh it each morning.</div>
    <div><b>3.</b> Create <b>two</b> alerts → Symbols: that watchlist → Condition: <i>mVWAP-BB</i> → “Any alert() function call” · session Extended · once per bar close — one on <b>1 minute</b>, one on <b>2 minutes</b>.</div>
    <div><b>↻</b> After a script update: paste the new version, Save, then delete and recreate both alerts.</div>
    <div><b>4.</b> Notifications → Webhook URL: <code>https://pnldash.uz/api/tv/webhook?key=…</code> (the key is TV_WEBHOOK_SECRET).</div>
  </div>
);

// 📐 setups in the left rail (operator, 2026-10-05: "organize this list … move
// it to the sidebar"). One row per ticker with its CURRENT state — the stage,
// its line (S session / M month / Y year), touch #, age and the distance to
// the line — live setups first, the rest under "Earlier today", each section
// newest first (operator: order by alert time; ⭐ still marks Momentum names).
// The 1m and 2m alerts' copies merge into one event. A click selects the
// ticker and opens its day trail. The full log stays on the Alerts tab.
export function TvSetupsSidebar({ payload }: { payload: CyclePayload | null }) {
  const { message } = App.useApp();
  const { selected, setSelected } = useSelection();
  const { alerts } = useAlertLog(payload);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showEarlier, setShowEarlier] = useState(() => {
    try { return localStorage.getItem('tvSidebar.earlier') !== '0'; } catch { return true; }
  });
  const [howTo, setHowTo] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rowByTicker = useMemo(() => new Map((payload?.rows ?? []).map((r) => [r.ticker, r])), [payload]);
  const cards = useMemo(() => buildCards(alerts, now), [alerts, now]);
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
      { key: 'howto', label: 'How to set up the alerts' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'copy') {
        void withList(async (list) => {
          await navigator.clipboard.writeText(list.symbols.join(','));
          message.success(`Copied ${list.symbols.length} symbols — ${list.today} on today's screen + ${list.runners} runners (≥+${list.min_chg}% in ${list.days}d)`);
        });
      } else if (key === 'download') {
        void withList((list) => {
          const url = URL.createObjectURL(new Blob([list.symbols.join(',')], { type: 'text/plain' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `pnldash-runners-${new Date().toISOString().slice(0, 10)}.txt`;
          a.click();
          URL.revokeObjectURL(url);
          message.success(`Downloaded ${list.symbols.length} symbols — import it from the TradingView watchlist menu`);
        });
      } else if (key === 'script') {
        navigator.clipboard.writeText(pineScript)
          .then(() => message.success('Pine script copied — paste it into the TradingView Pine Editor'))
          .catch(() => message.error('Clipboard blocked by the browser'));
      } else {
        setHowTo(true);
      }
    },
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
    const resolved = s.stage === 'go' || s.stage === 'held' || s.stage === 'broken';
    return (
      <div
        key={c.ticker}
        onClick={() => { setSelected(c.ticker); toggleOpen(c.ticker); }}
        style={{
          padding: '5px 8px', borderBottom: '1px solid #262626', cursor: 'pointer',
          background: c.ticker === selected ? '#111d2c' : undefined,
          opacity: dim ? (r ? 0.7 : 0.45) : r ? 1 : 0.7,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {expanded ? <CaretDownOutlined style={{ fontSize: 9, color: '#8c8c8c' }} /> : <CaretRightOutlined style={{ fontSize: 9, color: '#595959' }} />}
          <TickerLinks ticker={c.ticker} />
          <TickerLink ticker={c.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {r && <span style={{ color: '#fadb14', fontSize: 11 }}>⭐</span>}
          <TvStageTag stage={s.stage} dim={!e.notified} path={s.path} line={s.line} touch={s.touch} />
          {s.strength && <StrengthTag st={s.strength} />}
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
                  <TvStageTag stage={x.setup.stage} dim={!x.notified} line={x.setup.line} touch={x.setup.touch} />
                  <Text type="secondary" style={{ fontSize: 10 }}>{hhmm(x.at)}</Text>
                </span>
              ))}
            </div>
            <div style={{ color: '#bfbfbf', marginTop: 3 }}>
              {fmtPrice(e.price)} · {tvLevelsText(s)}
              {s.day_gain != null && <> · day high {s.day_gain >= 0 ? '+' : '−'}{Math.abs(Math.round(s.day_gain))}%</>}
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
        <Text type="secondary" style={{ fontSize: 11 }}>{live.length} live · {earlier.length} earlier</Text>
        <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
          <Button size="small" type="text" icon={<EllipsisOutlined />} loading={busy} style={{ marginLeft: 'auto' }} />
        </Dropdown>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <div style={{ padding: '4px 8px', fontSize: 10, color: '#8c8c8c', letterSpacing: 0.5, background: '#141414' }}>
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
