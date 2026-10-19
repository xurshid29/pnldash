import { App, Button, Checkbox, Divider, Popover, Radio, Space, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { DASHBOARD_KINDS, setAlertKind, useAlertKinds, type AlertKind } from '../../hooks/useAlertKinds';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import { BREAKOUT_ALARM_OPTIONS, setBreakoutAlarm, useBreakoutAlarm, type BreakoutAlarm } from '../../hooks/useBreakoutAlarm';
import { useAlertsArmed } from '../../hooks/useAlertsArmed';
import { breakoutAlarm } from '../../hooks/useScreenerAlerts';
import type { TvStage } from '../../api/types';

const { Text } = Typography;

// Since 2026-10-06 the dashboard alerts on 📐 setups only (DASHBOARD_KINDS);
// 🅰️ / ⚡ / 📰 still reach the phone.
const KINDS: Array<{ kind: AlertKind; label: string; hint: string }> = [
  { kind: 'tv_setup', label: '📐 VWAP setup', hint: 'sound + notification on this device' },
].filter((k) => DASHBOARD_KINDS.includes(k.kind as AlertKind)) as Array<{ kind: AlertKind; label: string; hint: string }>;

const STAGE_LABEL: Record<TvStage, string> = {
  ready: 'READY', go: 'GO', pullback: 'PULLBACK', forming: 'FORMING', broken: 'BROKEN', held: 'HELD',
};

// Click-to-open switches for which opportunity alerts make a sound and a
// browser notification on this device. The master ON/OFF stays next to it.
// Below them, the 📐 stage switches (2026-10-06): server-side, so they mute
// the phone too, for everyone, and hide the stage from the 📐 sidebar list.
export function AlertKindsMenu() {
  const kinds = useAlertKinds();
  const { settings, save } = useTvAlertStages();
  const boAlarm = useBreakoutAlarm();
  const armed = useAlertsArmed();
  const { notification } = App.useApp();
  // 10-19: check the alarm on this device — sound, toast, browser notification.
  const testAlarm = () => {
    const title = '⚡ BREAKOUT TEST — buy > $1.00';
    const body = armed ? 'stop $0.95 (−5.0%) · this is how a BO alarm looks and sounds'
      : 'Alerts are OFF in the header — turn them on, or no BO will ring';
    breakoutAlarm(title, body);
    notification.open({ key: 'bo-test', title, description: body, placement: 'topRight', duration: 8, style: { borderLeft: '4px solid #c41d7f' } });
  };
  const content = (
    <Space direction="vertical" size={8} style={{ minWidth: 260 }}>
      {KINDS.map(({ kind, label, hint }) => (
        <Checkbox key={kind} checked={kinds[kind]} onChange={(e) => setAlertKind(kind, e.target.checked)}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{hint}</Text>
        </Checkbox>
      ))}
      <Divider style={{ margin: '4px 0' }} />
      <div>
        <span style={{ fontWeight: 600 }}>📐 Stages that alert</span>
        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
          phone + dashboard · off = no ping, hidden from the sidebar
        </Text>
      </div>
      {settings ? (
        <Checkbox.Group
          value={settings.announced}
          onChange={(v) => save(settings.stages.filter((s) => (v as TvStage[]).includes(s)))}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '4px 12px' }}
          options={settings.stages.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 11 }}>loading…</Text>
      )}
      <Divider style={{ margin: '4px 0' }} />
      <div>
        <span style={{ fontWeight: 600 }}>⚡ BB breakout alarm</span>
        <Button size="small" type="link" onClick={testAlarm} style={{ padding: '0 6px', height: 18 }}>Test</Button>
        <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
          this device only · rings at the BO (buy stop in the toast), before the ▲
        </Text>
      </div>
      <Radio.Group value={boAlarm} onChange={(e) => setBreakoutAlarm(e.target.value as BreakoutAlarm)}>
        <Space direction="vertical" size={2}>
          {BREAKOUT_ALARM_OPTIONS.map((o) => (
            <Radio key={o.value} value={o.value}>
              <span>{o.label}</span>
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{o.hint}</Text>
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Space>
  );
  const on = KINDS.filter(({ kind }) => kinds[kind]).length;
  return (
    <Popover trigger="click" placement="bottomRight" title="Alert types" content={content}>
      <Button size="small" icon={<SettingOutlined />}>
        {on}/{KINDS.length}
      </Button>
    </Popover>
  );
}
