import { useEffect, useRef } from 'react';
import { App } from 'antd';
import type { TvBreakout } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useAlertsArmed } from '../../hooks/useAlertsArmed';
import { useHiddenTickers } from '../../hooks/useHiddenTickers';
import { useBreakouts } from '../../hooks/useBreakouts';
import { getBreakoutAlarm, type BreakoutAlarm } from '../../hooks/useBreakoutAlarm';
import { breakoutAlarm } from '../../hooks/useScreenerAlerts';
import { isHot } from '../screener/breakoutContext';

// A BREAKOUT older than this when it reaches the list (a refetch after a
// reconnect, a slow tab) is listed but doesn't ring: its trigger candle is over.
const FRESH_SEC = 90;

function rings(b: TvBreakout, level: BreakoutAlarm): boolean {
  if (b.stage !== 'breakout' || level === 'off') return false;
  if (level === 'hot') return b.strong === true && isHot(b);
  if (level === 'strong') return b.strong === true && b.on_screen;
  if (level === 'momentum') return b.on_screen;
  return true;
}

function px(p: number | null): string {
  return p == null ? '—' : `$${p < 1 ? p.toFixed(4) : p.toFixed(2)}`;
}

// ⚡ BB breakout alarm on the dashboard (2026-10-19): a sound, a toast and a
// browser notification when a BREAKOUT arrives (the 1m close above the 30s
// band), carrying the buy stop and the stop, so the order can go in before the
// next candle takes the high. Which ones ring is the ⚙ menu's per-device
// level (default: strong BOs on Momentum names). Follows Alerts ON/OFF and the
// hidden tickers, like the 📐 toasts. Click → the ticker's charts.
export function BreakoutAlerts() {
  const { notification } = App.useApp();
  const { setSelected } = useSelection();
  const armed = useAlertsArmed();
  const { breakouts, isLoading } = useBreakouts();
  const { hidden } = useHiddenTickers();
  const hiddenRef = useRef(hidden);
  useEffect(() => { hiddenRef.current = hidden; });
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    // The first list is the day so far (maybe empty, before the day's first BO) — don't replay it.
    if (!seeded.current) {
      seeded.current = true;
      breakouts.forEach((b) => seen.current.add(b.id));
      return;
    }
    const level = getBreakoutAlarm();
    const now = Date.now();
    for (const b of [...breakouts].reverse()) {   // oldest first, so the newest toast ends on top
      if (seen.current.has(b.id)) continue;
      seen.current.add(b.id);
      if (!armed || hiddenRef.current.has(b.ticker) || !rings(b, level)) continue;
      if ((now - Date.parse(b.at)) / 1000 > FRESH_SEC) continue;
      const hot = b.strong === true && isHot(b);
      const risk = b.trigger && b.stop != null ? ` (${((b.stop / b.trigger - 1) * 100).toFixed(1)}%)` : '';
      const title = `${hot ? '🔥' : '⚡'} BREAKOUT ${b.ticker} — buy > ${px(b.trigger)}`;
      const body = [
        `stop ${px(b.stop)}${risk}`,
        b.strong === true ? 'strong' : b.strong === false ? 'weak' : null,
        b.on_screen ? `⭐ on Momentum${b.grade ? ` · grade ${b.grade}` : ''}` : 'not on Momentum',
        b.spx_pct != null ? `${b.spx_pct >= 0 ? '+' : ''}${b.spx_pct.toFixed(0)}% vs sVWAP` : null,
        b.run30 != null ? `run30 +${Math.round(b.run30)}%` : null,
      ].filter(Boolean).join(' · ');
      breakoutAlarm(title, body);
      notification.open({
        key: b.id,
        title,
        description: body,
        placement: 'topRight',
        // The trigger window is the next 1m candle.
        duration: 60,
        showProgress: true,
        pauseOnHover: true,
        onClick: () => setSelected(b.ticker),
        style: { cursor: 'pointer', borderLeft: `4px solid ${hot ? '#fadb14' : b.strong === true ? '#c41d7f' : '#595959'}` },
      });
    }
  }, [breakouts, isLoading, armed, notification, setSelected]);

  return null;
}
