// 📐 setups for one ET day — the History tab's "📐 Setups" view (2026-10-17,
// operator: "can we list history of setups, like history tab does?").
// Reads the day's alert log (GET /api/screener/alerts?day=), keeps the
// TradingView setup rows, merges the 30s and 1m copies of an event (same
// ticker, stage and line within 5 min, like the sidebar), and pairs each
// PULLBACK with how it ended (the first later BROKEN / HELD on a shared line).
// Paginated, so a busy day stays light. Click a row → charts + Quote Details.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Checkbox, Empty, Segmented, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { OpportunityAlert, TvSetupInfo, TvStage } from '../../api/types';
import { screenerApi } from '../../api/screener';
import { useSelection } from '../../context/SelectionContext';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { TvStageTag, crossTfText, fmtSignedPct, fmtTf, lineDistanceText, lineTokens } from '../common/TvStageTag';
import { GradeCell } from '../common/GradeCell';
import { BreakoutsHistoryTable } from './BreakoutsHistoryTable';
import { fmtPct, fmtPrice } from '../../utils/format';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // the operator's clock, like the 📐 sidebar
const MERGE_MS = 5 * 60_000;

interface SetupEvent {
  key: string;
  ticker: string;
  at: number;                 // ms
  price: number | null;
  chg: number | null;         // change % at the signal (on Momentum)
  grade: string | null;       // grade at the signal (on Momentum)
  setup: TvSetupInfo;
  tfs: string[];
  notified: boolean;
  outcome: { stage: 'broken' | 'held'; at: number } | null;
}

type StageFilter = 'on' | 'all' | 'go' | 'pullback' | 'cross' | 'bo';

function buildEvents(alerts: OpportunityAlert[]): SetupEvent[] {
  const sorted = alerts
    .filter((a) => a.kinds.includes('tv_setup') && a.setup)
    .map((a) => ({ a, at: Date.parse(a.at) }))
    .sort((x, y) => x.at - y.at);
  const events: SetupEvent[] = [];
  const last = new Map<string, SetupEvent>();   // ticker|stage|lines → its latest event
  for (const { a, at } of sorted) {
    const s = a.setup!;
    // A v21 CROSS comes from one alert: only a copy of the same cross merges, not the next candle's.
    const k = `${a.ticker}|${s.stage}|${lineTokens(s.stage, s.line).join('+')}${s.stage === 'cross' ? `|${s.cross_n ?? ''}` : ''}`;
    const prev = last.get(k);
    if (prev && at - prev.at <= MERGE_MS) {
      if (s.tf && !prev.tfs.includes(s.tf)) prev.tfs.push(s.tf);
      prev.notified ||= s.notified;
      continue;
    }
    const e: SetupEvent = {
      key: a.id, ticker: a.ticker, at, price: a.price, chg: a.change_pct, grade: a.grade,
      setup: s, tfs: s.tf ? [s.tf] : [], notified: s.notified, outcome: null,
    };
    last.set(k, e);
    events.push(e);
  }
  for (const e of events) {
    if (e.setup.stage !== 'pullback') continue;
    const lines = lineTokens('pullback', e.setup.line);
    const o = events.find((x) => x.ticker === e.ticker && x.at > e.at
      && (x.setup.stage === 'broken' || x.setup.stage === 'held')
      && lineTokens(x.setup.stage, x.setup.line).some((t) => lines.includes(t)));
    if (o) e.outcome = { stage: o.setup.stage as 'broken' | 'held', at: o.at };
  }
  return events;
}

function hhmm(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
}

// "30S" < "1" < "2": seconds before minutes.
function tfSeconds(tf: string): number {
  return /^\d+S$/i.test(tf) ? Number.parseInt(tf, 10) : /^\d+$/.test(tf) ? Number(tf) * 60 : Number.MAX_SAFE_INTEGER;
}

export function SetupsHistoryTable({ date }: { date: string }) {
  const { selected, setSelected } = useSelection();
  const { settings } = useTvAlertStages();
  const [stageFilter, setStageFilter] = useState<StageFilter>('on');
  const [momentumOnly, setMomentumOnly] = useState(false);

  const { data, isFetching } = useQuery({
    // Its own key: the live alert log invalidates ['screener', 'alerts'] on
    // every new alert, and a past day doesn't need that.
    queryKey: ['tv-setups-history', date],
    queryFn: () => screenerApi.alerts(date),
    staleTime: 60_000,
  });
  const events = useMemo(() => buildEvents(data ?? []), [data]);

  const visible = useMemo(() => {
    const on = new Set<TvStage>(settings?.announced ?? ['ready', 'go', 'pullback']);
    return events.filter((e) => {
      const st = e.setup.stage;
      if (stageFilter === 'on' && !on.has(st)) return false;
      if (stageFilter === 'go' && st !== 'go') return false;
      if (stageFilter === 'pullback' && st !== 'pullback') return false;
      if (stageFilter === 'cross' && st !== 'cross') return false;
      return !momentumOnly || e.setup.on_screen;
    });
  }, [events, settings, stageFilter, momentumOnly]);

  const pullbacks = visible.filter((e) => e.setup.stage === 'pullback');
  const held = pullbacks.filter((e) => e.outcome?.stage === 'held').length;
  const broke = pullbacks.filter((e) => e.outcome?.stage === 'broken').length;
  const gos = visible.filter((e) => e.setup.stage === 'go').length;
  const crosses = visible.filter((e) => e.setup.stage === 'cross').length;

  const columns: ColumnsType<SetupEvent> = useMemo(() => [
    {
      title: 'Time', key: 'at', width: 64,
      sorter: (a, b) => a.at - b.at, defaultSortOrder: 'descend',
      render: (_v, e) => (
        <span style={{ whiteSpace: 'nowrap' }}>{hhmm(e.at, LOCAL_TZ)}</span>
      ),
    },
    { title: '', key: 'links', width: 64, render: (_v, e) => <TickerLinks ticker={e.ticker} /> },
    {
      title: 'Ticker', key: 'ticker', width: 96,
      sorter: (a, b) => a.ticker.localeCompare(b.ticker),
      render: (_v, e) => (
        <span>
          <TickerLink ticker={e.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {e.setup.on_screen && <span style={{ color: '#fadb14', fontSize: 11, marginLeft: 3 }}>⭐</span>}
        </span>
      ),
    },
    {
      title: 'Setup', key: 'setup', width: 170,
      render: (_v, e) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <TvStageTag stage={e.setup.stage} dim={!e.notified} path={e.setup.path} line={e.setup.line}
            touch={e.setup.stage === 'cross' ? e.setup.cross_n : e.setup.touch} tfs={crossTfText(e.setup)} />
          {e.setup.capped && <Text type="secondary" style={{ fontSize: 10 }}>past cap</Text>}
        </span>
      ),
    },
    {
      title: 'Outcome', key: 'outcome', width: 96,
      render: (_v, e) => (e.outcome ? (
        <span style={{ fontSize: 11, color: e.outcome.stage === 'held' ? '#52c41a' : '#ff4d4f', whiteSpace: 'nowrap' }}>
          {e.outcome.stage === 'held' ? '✓ held' : '✗ broke'} {hhmm(e.outcome.at, LOCAL_TZ)}
        </span>
      ) : <Text type="secondary">—</Text>),
    },
    { title: 'Price', key: 'price', width: 72, align: 'right', render: (_v, e) => fmtPrice(e.price) },
    {
      title: 'vs line', key: 'line', width: 110,
      render: (_v, e) => {
        const first = lineTokens(e.setup.stage, e.setup.line)[0] ?? 'session';
        return <Text type="secondary" style={{ fontSize: 11 }}>{lineDistanceText(e.setup, first) ?? '—'}</Text>;
      },
    },
    {
      title: 'Day high', key: 'day', width: 72, align: 'right',
      sorter: (a, b) => (a.setup.day_gain ?? -1e9) - (b.setup.day_gain ?? -1e9),
      render: (_v, e) => (e.setup.day_gain == null ? '—' : fmtSignedPct(Math.round(e.setup.day_gain)).replace('.0%', '%')),
    },
    { title: 'Grade', key: 'grade', width: 62, render: (_v, e) => <GradeCell grade={e.grade} /> },
    { title: 'Chg', key: 'chg', width: 64, align: 'right', render: (_v, e) => (e.chg == null ? '—' : fmtPct(e.chg)) },
    {
      title: 'TF', key: 'tf', width: 64,
      render: (_v, e) => <Text type="secondary" style={{ fontSize: 11 }}>{[...e.tfs].sort((a, b) => tfSeconds(a) - tfSeconds(b)).map(fmtTf).join('+')}</Text>,
    },
  ], [setSelected]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', borderBottom: '1px solid #262626', flexWrap: 'wrap' }}>
        <Segmented
          size="small"
          value={stageFilter}
          onChange={(v) => setStageFilter(v as StageFilter)}
          options={[
            { label: 'Stages switched on', value: 'on' },
            { label: 'All stages', value: 'all' },
            { label: 'GO', value: 'go' },
            { label: 'PULLBACK', value: 'pullback' },
            { label: 'CROSS', value: 'cross' },
            { label: '⚡ Breakouts', value: 'bo' },
          ]}
        />
        <Checkbox checked={momentumOnly} onChange={(e) => setMomentumOnly(e.target.checked)}>
          <span style={{ fontSize: 12 }}>⭐ on Momentum only</span>
        </Checkbox>
        {stageFilter !== 'bo' && <Text type="secondary" style={{ fontSize: 11 }}>
          {isFetching ? <Spin size="small" /> : (
            <>
              {visible.length} setup{visible.length === 1 ? '' : 's'} · {gos} GO · {pullbacks.length} PULLBACK
              {pullbacks.length > 0 && <> (<span style={{ color: '#52c41a' }}>{held} held</span> / <span style={{ color: '#ff4d4f' }}>{broke} broke</span>)</>}
              {crosses > 0 && <> · {crosses} CROSS</>}
            </>
          )}
        </Text>}
      </div>
      {stageFilter === 'bo' ? <BreakoutsHistoryTable date={date} momentumOnly={momentumOnly} /> : visible.length === 0 && !isFetching ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary" style={{ fontSize: 12 }}>No 📐 setups for {date} with these filters.</Text>} />
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          <Table<SetupEvent>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={visible}
            pagination={{ pageSize: 50, size: 'small', showSizeChanger: false, hideOnSinglePage: true }}
            sticky
            onRow={(e) => ({
              onClick: () => setSelected(e.ticker),
              style: { cursor: 'pointer', background: e.ticker === selected ? '#15395b' : undefined },
            })}
          />
        </div>
      )}
    </div>
  );
}
