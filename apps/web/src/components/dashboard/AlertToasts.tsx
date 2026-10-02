import { useEffect, useRef } from 'react';
import { App } from 'antd';
import type { CyclePayload, OpportunityKind } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useAlertsArmed } from '../../hooks/useAlertsArmed';
import { getAlertKinds } from '../../hooks/useAlertKinds';
import { opportunityBody, opportunityTitle } from '../../hooks/useScreenerAlerts';

const KIND_COLOR: Record<OpportunityKind, string> = {
  grade_aplus: '#52c41a',
  fast_move: '#faad14',
  news: '#1890ff',
};

// In-page toast for every new opportunity alert (2026-10-02) — the same events
// as the sound + browser notification, but drawn by the dashboard itself, so
// it shows even when the OS swallows browser notifications (macOS Focus,
// notification settings). Follows the same switches: Alerts ON/OFF and the
// per-type menu. Click a toast to load its ticker into the charts and Quote.
export function AlertToasts({ payload }: { payload: CyclePayload | null }) {
  const { notification } = App.useApp();
  const { setSelected } = useSelection();
  const armed = useAlertsArmed();
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    if (!payload) return;
    const alerts = payload.alerts ?? [];
    // The first payload is a snapshot of the last hour — don't replay it.
    if (!seeded.current) {
      seeded.current = true;
      alerts.forEach((a) => seen.current.add(a.id));
      return;
    }
    const kindsOn = getAlertKinds();
    // payload.alerts is newest first; open oldest first so the newest ends on top.
    for (const a of [...alerts].reverse()) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      if (!armed) continue;
      const kinds = a.kinds.filter((k) => kindsOn[k]);
      if (kinds.length === 0) continue;
      const shown = { ...a, kinds };
      notification.open({
        key: a.id,
        title: opportunityTitle(shown),
        description: <span style={{ whiteSpace: 'pre-line' }}>{opportunityBody(shown)}</span>,
        placement: 'topRight',
        duration: 12,
        showProgress: true,
        pauseOnHover: true,
        onClick: () => setSelected(a.ticker),
        style: { cursor: 'pointer', borderLeft: `4px solid ${KIND_COLOR[kinds[0]]}` },
      });
    }
  }, [payload, armed, notification, setSelected]);

  return null;
}
