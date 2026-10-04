import { useMemo, useState } from 'react';
import { Segmented, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CyclePayload, OpportunityAlert, OpportunityKind } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { fmtFloat, fmtPct, fmtPrice } from '../../utils/format';
import { TvStageTag, StrengthTag, tvLevelsText, fmtTf } from '../common/TvStageTag';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // same clock as the Momentum "Appeared" column (UTC+5)

type Filter = 'all' | OpportunityKind;

// The day's opportunity alerts — the same events that pinged the phone and
// the browser — as a log you can scan after the fact. "Since alert" reads the
// live Momentum price, so you can see how each alert played out.
export function AlertsPanel({ alerts, payload }: { alerts: OpportunityAlert[]; payload: CyclePayload | null }) {
  const { selected, setSelected } = useSelection();
  const [filter, setFilter] = useState<Filter>('all');
  const livePrice = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of payload?.rows ?? []) if (r.price != null) m.set(r.ticker, Number(r.price));
    return m;
  }, [payload]);
  const count = (k: OpportunityKind) => alerts.filter((a) => a.kinds.includes(k)).length;
  const rows = filter === 'all' ? alerts : alerts.filter((a) => a.kinds.includes(filter));

  const columns: ColumnsType<OpportunityAlert> = [
    {
      title: 'Time',
      dataIndex: 'at',
      key: 'at',
      width: 84,
      render: (iso: string) => {
        const t = new Date(iso);
        const hms = t.toLocaleTimeString('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
        const ago = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
        return (
          <span style={{ lineHeight: 1.15, display: 'inline-block' }}>
            <div style={{ fontSize: 12 }}>{hms}</div>
            <div style={{ fontSize: 10, color: '#8c8c8c' }}>{ago} ago</div>
          </span>
        );
      },
    },
    {
      title: 'Ticker',
      dataIndex: 'ticker',
      key: 'ticker',
      width: 120,
      render: (t: string) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <TickerLinks ticker={t} />
          <TickerLink ticker={t} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
        </span>
      ),
    },
    {
      title: 'Alert',
      key: 'what',
      render: (_, a) => (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          {a.kinds.includes('grade_aplus') && (
            <span style={{ color: '#95de64', fontWeight: 700 }}>
              🅰️ {a.new_on_screen ? 'NEW A+' : `A+ (was ${(a.prev_grade ?? '—').replace('-', '−')})`}
            </span>
          )}
          {a.kinds.includes('fast_move') && (
            <span style={{ color: '#ffc53d', fontWeight: 700 }}>⚡ +{a.move_pct}% in 60s</span>
          )}
          {a.kinds.includes('tv_setup') && a.setup && (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ color: '#5cdbd3', fontWeight: 700 }}>{a.setup.on_screen ? '⭐ ' : ''}📐</span>
              <TvStageTag stage={a.setup.stage} dim={!a.setup.notified} path={a.setup.path} />
              {a.setup.strength && <StrengthTag st={a.setup.strength} />}
              <span style={{ color: '#d9d9d9', fontSize: 12 }}>{tvLevelsText(a.setup)}</span>
              {a.setup.tf && <Text type="secondary" style={{ fontSize: 10 }}>{fmtTf(a.setup.tf)}</Text>}
            </span>
          )}
          {a.kinds.includes('news') && a.news && (
            <span style={{ minWidth: 0 }}>
              <span style={{ color: a.news.direction === 'bearish' ? '#ff7875' : '#69c0ff', fontWeight: 700 }}>
                📰 {a.news.direction === 'bearish' ? '⚠️ ' : ''}{a.news.score}
              </span>{' '}
              {a.news.url ? (
                <a href={a.news.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: '#d9d9d9' }}>
                  {a.news.title}
                </a>
              ) : (
                <span style={{ color: '#d9d9d9' }}>{a.news.title}</span>
              )}
              <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }}>{a.news.source}</Text>
            </span>
          )}
        </span>
      ),
    },
    {
      title: 'At alert',
      key: 'at_alert',
      width: 170,
      align: 'right',
      render: (_, a) => (
        <span style={{ fontSize: 12 }}>
          {fmtPrice(a.price)}{' '}
          <span style={{ color: (a.change_pct ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(a.change_pct)}</span>
          <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }}>
            {a.grade ? `${a.grade.replace('-', '−')} · ` : ''}{a.float_m != null ? `${fmtFloat(a.float_m)} float` : ''}
          </Text>
        </span>
      ),
    },
    {
      title: 'Since alert',
      key: 'since',
      width: 96,
      align: 'right',
      render: (_, a) => {
        const now = livePrice.get(a.ticker);
        if (now == null || a.price == null || a.price <= 0) return <Text type="secondary">off screen</Text>;
        const pct = (now / a.price - 1) * 100;
        return <Text style={{ color: pct >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</Text>;
      },
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030' }}>
        <Segmented<Filter>
          size="small"
          value={filter}
          onChange={setFilter}
          options={[
            { label: `All · ${alerts.length}`, value: 'all' },
            { label: `🅰️ A+ · ${count('grade_aplus')}`, value: 'grade_aplus' },
            { label: `⚡ Fast · ${count('fast_move')}`, value: 'fast_move' },
            { label: `📰 News · ${count('news')}`, value: 'news' },
            { label: `📐 Setup · ${count('tv_setup')}`, value: 'tv_setup' },
          ]}
        />
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <Table<OpportunityAlert>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          sticky
          locale={{ emptyText: 'No alerts yet today' }}
          onRow={(a) => ({ onClick: () => setSelected(a.ticker), style: { cursor: 'pointer' } })}
          rowClassName={(a) => (a.ticker === selected ? 'ant-table-row-selected' : '')}
        />
      </div>
    </div>
  );
}
