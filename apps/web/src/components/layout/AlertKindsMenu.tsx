import { Button, Checkbox, Divider, Popover, Space, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { DASHBOARD_KINDS, setAlertKind, useAlertKinds, type AlertKind } from '../../hooks/useAlertKinds';
import { useTvAlertStages } from '../../hooks/useTvAlertStages';
import { POP_FREE_VOL } from '../common/TvStageTag';
import type { TvStage } from '../../api/types';

const { Text } = Typography;

// Since 2026-10-06 the dashboard alerts on 📐 setups only (DASHBOARD_KINDS);
// 🅰️ / ⚡ / 📰 still reach the phone.
const KINDS: Array<{ kind: AlertKind; label: string; hint: string }> = [
  { kind: 'tv_setup', label: '📐 VWAP setup', hint: 'sound + notification on this device' },
].filter((k) => DASHBOARD_KINDS.includes(k.kind as AlertKind)) as Array<{ kind: AlertKind; label: string; hint: string }>;

// The EMA switch also covers its v37 BOUNCE (the server lists no switch for 'bounce'). Since
// 2026-11-16 the band's cross (BAND, v40) has its own; it rode the EMA's. TURN (v47) has its own,
// and so do POP and BACK (v48), one each. The server's list sets the order: POP and BACK after TURN.
const STAGE_LABEL: Record<TvStage, string> = {
  pullback: 'PULLBACK', broken: 'BROKEN', held: 'HELD', cross: 'CROSS', retest: 'RETEST',
  ema: 'EMA + BOUNCE', bounce: 'BOUNCE', band: 'BAND (BB upper)', turn: 'TURN', pop: 'POP', back: 'BACK',
};

// Click-to-open switches for which opportunity alerts make a sound and a
// browser notification on this device. The master ON/OFF stays next to it.
// Below them, the 📐 stage switches (2026-10-06): server-side, so they mute
// the phone too, for everyone, and hide the stage from the 📐 sidebar list.
export function AlertKindsMenu() {
  const kinds = useAlertKinds();
  const { settings, save, saveEmaMomoOnly } = useTvAlertStages();
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
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '4px 12px', whiteSpace: 'nowrap' }}
          options={settings.stages.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 11 }}>loading…</Text>
      )}
      {/* 2026-11-15 (operator: "ema cross must be checked only with momentum list … make it configurable"):
          server-side like the switches above. Off = the VWAP + BB cross's rule (a +30% day high pings off the list too).
          2026-11-27, the rule's one exception, on its own line of the label (on one line the menu would be twice as
          wide): a POP or a BACK with a volume reading of POP_FREE_VOL or more is announced on any name, whatever
          this box says (server: TV_SETUP.pp_free_vol). */}
      {settings && (
        <Checkbox checked={settings.ema_momo_only} onChange={(e) => saveEmaMomoOnly(e.target.checked)}>
          <span style={{ fontWeight: 600 }}>EMA / BAND / BOUNCE / TURN / POP / BACK: Momentum list only</span>
          <span style={{ fontSize: 12, display: 'block' }}>
            (a POP or BACK with volume {POP_FREE_VOL}× and over alerts on any name)
          </span>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
            off = also pings off the list when the day high is +30% or more
          </Text>
        </Checkbox>
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
