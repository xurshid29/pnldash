import { useMemo, useState } from 'react';
import { App, Button, Popover, Space, Table, Typography } from 'antd';
import { CodeOutlined, CopyOutlined, DownloadOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CyclePayload, OpportunityAlert, TvSetupInfo } from '../../api/types';
import { tvApi, type TvWatchlist } from '../../api/tv';
import { useSelection } from '../../context/SelectionContext';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { TvStageTag, tvLevelsText, fmtTf, TV_STAGE_RANK } from '../common/TvStageTag';
import { fmtPct, fmtPrice } from '../../utils/format';
import pineScript from '../../tv/mvwap-bb-setup.pine?raw';

const { Text } = Typography;
const LOCAL_TZ = 'Asia/Tashkent'; // UTC+5, same clock as the Alerts tab

interface Signal {
  id: string;
  at: string;
  price: number | null;
  setup: TvSetupInfo;
}
interface TickerSetups {
  ticker: string;
  signals: Signal[];   // oldest first
  latest: Signal;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: LOCAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

const HOW_TO = (
  <div style={{ maxWidth: 420, fontSize: 12, lineHeight: 1.5 }}>
    <div><b>1.</b> <b>Copy Pine script</b> → TradingView Pine Editor → paste → Add to chart. Its yellow line must sit exactly on your “VWAP Month”.</div>
    <div><b>2.</b> <b>Download .txt</b> → watchlist menu → Import list (or paste <b>Copy list</b>). Refresh it each morning.</div>
    <div><b>3.</b> Create <b>two</b> alerts → Symbols: that watchlist → Condition: <i>mVWAP-BB</i> → “Any alert() function call” · session Extended · once per bar close — one on <b>1 minute</b>, one on <b>2 minutes</b>.</div>
    <div><b>↻</b> After a script update: paste the new version, Save, then delete and recreate both alerts.</div>
    <div><b>4.</b> Notifications → Webhook URL: <code>https://pnldash.uz/api/tv/webhook?key=…</code> (the key is TV_WEBHOOK_SECRET).</div>
  </div>
);

// 📐 VWAP setups (2026-10-03) — the operator's edge, detected by TradingView
// (Pine script + one watchlist alert) and posted to our webhook. One row per
// ticker with its stage trail for today: FORMING → READY → GO (a broken setup
// re-arms, so a ticker can show more than one trail). "Since" compares the
// live Momentum price with the latest signal's price.
export function TvSetupsPanel({ alerts, payload }: { alerts: OpportunityAlert[]; payload: CyclePayload | null }) {
  const { message } = App.useApp();
  const { selected, setSelected } = useSelection();
  const [busy, setBusy] = useState(false);

  const rowByTicker = useMemo(() => new Map((payload?.rows ?? []).map((r) => [r.ticker, r])), [payload]);

  // Priority (operator, 2026-10-04): tickers on our Momentum list right now come
  // first (⭐), then the rest, each newest first; off-list rows are dimmed.
  const groups = useMemo<TickerSetups[]>(() => {
    const byTicker = new Map<string, Signal[]>();
    for (const a of alerts) {
      if (!a.kinds.includes('tv_setup') || !a.setup) continue;
      const list = byTicker.get(a.ticker) ?? [];
      list.push({ id: a.id, at: a.at, price: a.price, setup: a.setup });
      byTicker.set(a.ticker, list);
    }
    const out: TickerSetups[] = [];
    for (const [ticker, signals] of byTicker) {
      signals.sort((x, y) => x.at.localeCompare(y.at));
      out.push({ ticker, signals, latest: signals[signals.length - 1] });
    }
    const on = (g: TickerSetups) => (rowByTicker.has(g.ticker) ? 1 : 0);
    return out.sort((x, y) => on(y) - on(x) || y.latest.at.localeCompare(x.latest.at));
  }, [alerts, rowByTicker]);
  const onMomentum = groups.filter((g) => rowByTicker.has(g.ticker)).length;

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
  const copyList = () => withList(async (list) => {
    await navigator.clipboard.writeText(list.symbols.join(','));
    message.success(`Copied ${list.symbols.length} symbols — ${list.today} on today's screen + ${list.runners} runners (≥+${list.min_chg}% in ${list.days}d)`);
  });
  const downloadList = () => withList((list) => {
    const blob = new Blob([list.symbols.join(',')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pnldash-runners-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(`Downloaded ${list.symbols.length} symbols — import it from the TradingView watchlist menu`);
  });
  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(pineScript);
      message.success('Pine script copied — paste it into the TradingView Pine Editor');
    } catch {
      message.error('Clipboard blocked by the browser');
    }
  };

  const columns: ColumnsType<TickerSetups> = [
    {
      title: 'Ticker',
      key: 'ticker',
      width: 120,
      render: (_, g) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <TickerLinks ticker={g.ticker} />
          <TickerLink ticker={g.ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 600 }} />
          {rowByTicker.has(g.ticker) && <span style={{ color: '#fadb14' }}>⭐</span>}
        </span>
      ),
    },
    {
      title: 'Stages today',
      key: 'trail',
      render: (_, g) => (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          {g.signals.map((s, i) => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {i > 0 && (
                // → while the setup advances; · when a broken setup re-armed
                <Text type="secondary" style={{ fontSize: 10 }}>
                  {TV_STAGE_RANK[s.setup.stage] > TV_STAGE_RANK[g.signals[i - 1].setup.stage] ? '→' : '·'}
                </Text>
              )}
              <TvStageTag stage={s.setup.stage} dim={!s.setup.notified} path={s.setup.path} />
              <Text type="secondary" style={{ fontSize: 10 }}>{hhmm(s.at)}{s.setup.tf ? ` ${fmtTf(s.setup.tf)}` : ''}</Text>
            </span>
          ))}
        </span>
      ),
    },
    {
      title: 'Latest signal',
      key: 'latest',
      width: 250,
      render: (_, g) => (
        <span style={{ fontSize: 12 }}>
          {fmtPrice(g.latest.price)}{' '}
          <Text type="secondary" style={{ fontSize: 11 }}>{tvLevelsText(g.latest.setup)}</Text>
          {g.latest.setup.day_gain != null && (
            <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }}>
              day high {g.latest.setup.day_gain >= 0 ? '+' : '\u2212'}{Math.abs(Math.round(g.latest.setup.day_gain))}%
            </Text>
          )}
          {g.latest.setup.ah_gain != null && (
            <Text type="secondary" style={{ fontSize: 10, marginLeft: 6 }}>after hours +{Math.round(g.latest.setup.ah_gain)}%</Text>
          )}
        </span>
      ),
    },
    {
      title: 'Since',
      key: 'since',
      width: 80,
      align: 'right',
      render: (_, g) => {
        const r = rowByTicker.get(g.ticker);
        const now = r?.price != null ? Number(r.price) : null;
        if (now == null || g.latest.price == null || g.latest.price <= 0) return <Text type="secondary">off screen</Text>;
        const pct = (now / g.latest.price - 1) * 100;
        return <Text style={{ color: pct >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</Text>;
      },
    },
    {
      title: 'Now',
      key: 'now',
      width: 110,
      align: 'right',
      render: (_, g) => {
        const r = rowByTicker.get(g.ticker);
        if (!r) return <Text type="secondary">—</Text>;
        return (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: (r.change_pct ?? 0) >= 0 ? '#52c41a' : '#ff4d4f' }}>{fmtPct(r.change_pct)}</span>
            {r.grade && <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{r.grade.replace('-', '−')}</Text>}
          </span>
        );
      },
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          TradingView watchlist alert → 📐 forming · ready · go
          {groups.length > 0 && <> · ⭐ {onMomentum} on Momentum · {groups.length - onMomentum} other</>}
        </Text>
        <Space size={6}>
          <Button size="small" icon={<CopyOutlined />} loading={busy} onClick={copyList}>Copy list</Button>
          <Button size="small" icon={<DownloadOutlined />} disabled={busy} onClick={downloadList}>Download .txt</Button>
          <Button size="small" icon={<CodeOutlined />} onClick={copyScript}>Copy Pine script</Button>
          <Popover trigger="click" placement="bottomRight" title="Set up the TradingView alert" content={HOW_TO}>
            <Button size="small" icon={<QuestionCircleOutlined />}>How to</Button>
          </Popover>
        </Space>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <Table<TickerSetups>
          rowKey="ticker"
          size="small"
          columns={columns}
          dataSource={groups}
          pagination={false}
          sticky
          locale={{ emptyText: 'No setups yet today — signals appear here when the TradingView alert fires (see How to)' }}
          onRow={(g) => ({
            onClick: () => setSelected(g.ticker),
            style: { cursor: 'pointer', opacity: rowByTicker.has(g.ticker) ? 1 : 0.6 },
          })}
          rowClassName={(g) => (g.ticker === selected ? 'ant-table-row-selected' : '')}
        />
      </div>
    </div>
  );
}
