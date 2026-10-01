import { Button, Checkbox, Popover, Space, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { setAlertKind, useAlertKinds, type AlertKind } from '../../hooks/useAlertKinds';

const { Text } = Typography;

const KINDS: Array<{ kind: AlertKind; label: string; hint: string }> = [
  { kind: 'grade_aplus', label: '🅰️ New A+', hint: 'first time a ticker reaches A+ today' },
  { kind: 'fast_move', label: '⚡ Fast move', hint: '+10% within 60s on volume' },
  { kind: 'news', label: '📰 Fresh news', hint: 'headline published in the last 30 min' },
];

// Click-to-open switches for which opportunity alerts make a sound and a
// browser notification on this device. The master ON/OFF stays next to it.
export function AlertKindsMenu() {
  const kinds = useAlertKinds();
  const content = (
    <Space direction="vertical" size={8} style={{ minWidth: 250 }}>
      {KINDS.map(({ kind, label, hint }) => (
        <Checkbox key={kind} checked={kinds[kind]} onChange={(e) => setAlertKind(kind, e.target.checked)}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{hint}</Text>
        </Checkbox>
      ))}
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
