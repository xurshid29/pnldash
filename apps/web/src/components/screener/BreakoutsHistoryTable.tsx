// 📐 BB breakouts for one ET day — the History tab's 📐 Setups view, "⚡ Breakouts"
// (script v17, 2026-10-18). One row per BREAKOUT, paired with the TOUCH that came
// before it in the same minute and the TRIGGERED that came after it (within the
// next candle). Reads GET /api/screener/breakouts?day=. Click a row → charts.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Empty, Spin, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TvBreakout } from '../../api/types';
import { screenerApi } from '../../api/screener';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { GradeCell } from '../common/GradeCell';
import { fmtPct } from '../../utils/format';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // the operator's clock

interface Row {
  key: string;
  b: TvBreakout;
  at: number;                       // ms
  touchAt: number | null;           // a TOUCH earlier in the same minute
  triggeredAt: number | null;       // the TRIGGERED that followed (next candle)
}

// The study's gate (research/bb-breakout): on Momentum and A+, or 10–50% over sVWAP.
function isHot(b: TvBreakout): boolean {
  return b.on_screen && (b.grade === 'A+' || (b.spx_pct != null && b.spx_pct >= 10 && b.spx_pct < 50));
}

function buildRows(all: TvBreakout[]): Row[] {
  const byTicker = new Map<string, TvBreakout[]>();
  for (const b of all) byTicker.set(b.ticker, [...(byTicker.get(b.ticker) ?? []), b]);
  const rows: Row[] = [];
  for (const list of byTicker.values()) {
    const sorted = [...list].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
    for (const b of sorted) {
      if (b.stage !== 'breakout') continue;
      const at = Date.parse(b.at);
      const touch = sorted.find((x) => x.stage === 'touch' && Date.parse(x.at) < at && at - Date.parse(x.at) <= 75_000);
      const trig = sorted.find((x) => x.stage === 'triggered' && Date.parse(x.at) > at && Date.parse(x.at) - at <= 150_000);
      rows.push({ key: b.id, b, at, touchAt: touch ? Date.parse(touch.at) : null, triggeredAt: trig ? Date.parse(trig.at) : null });
    }
  }
  return rows;
}

function hms(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function px(p: number | null): string {
  return p == null ? '—' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}
function signed(p: number | null, digits = 1): string {
  return p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`;
}

export function BreakoutsHistoryTable({ date, momentumOnly }: { date: string; momentumOnly: boolean }) {
  const { selected, setSelected } = useSelection();
  const { data, isFetching } = useQuery({
    queryKey: ['tv-breakouts-history', date],
    queryFn: () => screenerApi.breakouts(date),
    staleTime: 60_000,
  });
  const rows = useMemo(() => buildRows(data ?? []), [data]);
  const visible = rows.filter((r) => !momentumOnly || r.b.on_screen);
  const triggered = visible.filter((r) => r.triggeredAt != null).length;
  const hot = visible.filter((r) => isHot(r.b));
  const touches = (data ?? []).filter((b) => b.stage === 'touch' && (!momentumOnly || b.on_screen)).length;

  const columns: ColumnsType<Row> = useMemo(() => [
    {
      title: 'Time', key: 'at', width: 76,
      sorter: (a, b) => a.at - b.at, defaultSortOrder: 'descend',
      render: (_v, r) => <span style={{ whiteSpace: 'nowrap' }}>{hms(r.at)}</span>,
    },
    { title: '', key: 'links', width: 64, render: (_v, r) => <TickerLinks ticker={r.b.ticker} /> },
    {
      title: 'Ticker', key: 'ticker', width: 96,
      sorter: (a, b) => a.b.ticker.localeCompare(b.b.ticker),
      render: (_v, r) => (
        <span>
          <TickerLink ticker={r.b.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {r.b.on_screen && <span style={{ color: '#fadb14', fontSize: 11, marginLeft: 3 }}>⭐</span>}
        </span>
      ),
    },
    {
      title: 'Signal', key: 'sig', width: 150,
      render: (_v, r) => (
        <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          {r.touchAt != null && <Text type="secondary" style={{ fontSize: 11 }}>touch → </Text>}
          <span style={{ color: '#ffadd2', fontWeight: 600 }}>BREAKOUT</span>
          {isHot(r.b) && <span style={{ color: '#ff7a45', marginLeft: 4 }}>🔥</span>}
        </span>
      ),
    },
    {
      title: 'Triggered', key: 'trig', width: 92,
      sorter: (a, b) => Number(a.triggeredAt != null) - Number(b.triggeredAt != null),
      render: (_v, r) => (r.triggeredAt != null
        ? <span style={{ fontSize: 11, color: '#52c41a', whiteSpace: 'nowrap' }}>✓ {hms(r.triggeredAt)}</span>
        : <Text type="secondary" style={{ fontSize: 11 }}>no</Text>),
    },
    { title: 'Close', key: 'price', width: 76, align: 'right', render: (_v, r) => px(r.b.price) },
    { title: 'Buy >', key: 'trigger', width: 76, align: 'right', render: (_v, r) => px(r.b.trigger) },
    {
      title: 'Stop', key: 'stop', width: 108, align: 'right',
      render: (_v, r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {px(r.b.stop)}
          {r.b.stop != null && r.b.trigger ? <Text type="secondary" style={{ fontSize: 11 }}> {signed((r.b.stop / r.b.trigger - 1) * 100)}</Text> : null}
        </span>
      ),
    },
    {
      title: 'vs sVWAP', key: 'vwap', width: 76, align: 'right',
      sorter: (a, b) => (a.b.spx_pct ?? -1e9) - (b.b.spx_pct ?? -1e9),
      render: (_v, r) => <Text type="secondary" style={{ fontSize: 11 }}>{signed(r.b.spx_pct, 0)}</Text>,
    },
    {
      title: 'Run 30m', key: 'run', width: 70, align: 'right',
      sorter: (a, b) => (a.b.run30 ?? -1) - (b.b.run30 ?? -1),
      render: (_v, r) => <Text type="secondary" style={{ fontSize: 11 }}>{r.b.run30 == null ? '—' : `+${Math.round(r.b.run30)}%`}</Text>,
    },
    {
      title: 'Vol', key: 'vol', width: 56, align: 'right',
      render: (_v, r) => <Text type="secondary" style={{ fontSize: 11 }}>{r.b.vol_x == null ? '—' : `${r.b.vol_x}×`}</Text>,
    },
    {
      title: 'Day high', key: 'day', width: 72, align: 'right',
      sorter: (a, b) => (a.b.day_gain ?? -1e9) - (b.b.day_gain ?? -1e9),
      render: (_v, r) => (r.b.day_gain == null ? '—' : `${r.b.day_gain >= 0 ? '+' : ''}${Math.round(r.b.day_gain)}%`),
    },
    { title: 'Grade', key: 'grade', width: 62, render: (_v, r) => <GradeCell grade={r.b.grade} /> },
    { title: 'Chg', key: 'chg', width: 64, align: 'right', render: (_v, r) => (r.b.chg == null ? '—' : fmtPct(r.b.chg)) },
  ], [setSelected]);

  return (
    <>
      <div style={{ padding: '4px 12px', borderBottom: '1px solid #262626' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {isFetching ? <Spin size="small" /> : (
            <>
              ⚡ {visible.length} BREAKOUT{visible.length === 1 ? '' : 'S'} · {triggered} triggered
              {visible.length > 0 && ` (${Math.round((triggered / visible.length) * 100)}%)`} · {touches} TOUCH · 🔥 {hot.length}
              {' '}· stored and graded, never pinged (script v17, 30s alert)
            </>
          )}
        </Text>
      </div>
      {visible.length === 0 && !isFetching ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<Text type="secondary" style={{ fontSize: 12 }}>No BB breakouts for {date} with these filters.</Text>} />
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          <Table<Row>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={visible}
            pagination={{ pageSize: 50, size: 'small', showSizeChanger: false, hideOnSinglePage: true }}
            sticky
            onRow={(r) => ({
              onClick: () => setSelected(r.b.ticker),
              style: { cursor: 'pointer', background: r.b.ticker === selected ? '#15395b' : undefined },
            })}
          />
        </div>
      )}
    </>
  );
}
