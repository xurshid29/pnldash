import { Button, Checkbox, Divider, Popover, Space, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { setAlertKind, useAlertKinds, type AlertKind } from '../../hooks/useAlertKinds';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import type { TvStage } from '../../api/types';

const { Text } = Typography;

const KINDS: Array<{ kind: AlertKind; label: string; hint: string }> = [
  { kind: 'grade_aplus', label: '🅰️ New A+', hint: 'first time a ticker reaches A+ today' },
  { kind: 'fast_move', label: '⚡ Fast move', hint: '+10% within 60s on volume' },
  { kind: 'news', label: '📰 Fresh news', hint: 'headline published in the last 30 min' },
  { kind: 'tv_setup', label: '📐 VWAP setup', hint: 'TradingView alert — the stages below' },
];

const STAGE_LABEL: Record<TvStage, string> = {
  ready: 'READY', go: 'GO', pullback: 'PULLBACK', forming: 'FORMING', broken: 'BROKEN', held: 'HELD',
};

// Click-to-open switches for which opportunity alerts make a sound and a
// browser notification on this device. The master ON/OFF stays next to it.
// Below them, the 📐 stage switches (2026-10-06): server-side, so they mute
// the phone too, for everyone; a switched-off stage still shows in the 📐
// sidebar, it just doesn't ping.
export function AlertKindsMenu() {
  const kinds = useAlertKinds();
  const { settings, save } = useTvAlertStages();
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
          phone + dashboard · off = sidebar only
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
