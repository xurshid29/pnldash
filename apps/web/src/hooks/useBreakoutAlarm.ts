import { useEffect, useState } from 'react';

// Which 📐 BB breakouts ring on this device (2026-10-19, operator: "I should get
// notified at least in the dashboard when BO fires, I usually get late to react
// when I get the triangle"). The alarm comes at the BREAKOUT (the 1m close above
// the band, with the buy stop), so the order can be placed before TRIGGERED.
// Dashboard only: the server still never announces breakouts (no Telegram).
// Device-local like the other alert switches (useAlertKinds, useAlertsArmed).
// Levels, narrowest first; on 10-19 04:00–06:06 ET: 45 BOs, 34 on Momentum,
// 5 strong on Momentum, 2 🔥 — and several times that rate after the open.
export type BreakoutAlarm = 'off' | 'hot' | 'strong' | 'momentum' | 'all';

export const BREAKOUT_ALARM_OPTIONS: Array<{ value: BreakoutAlarm; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'listed only' },
  { value: 'hot', label: '🔥 only', hint: 'strong, on Momentum, A+ or 10–50% over sVWAP' },
  { value: 'strong', label: 'Strong on Momentum', hint: 'pink BOs on ⭐ names' },
  { value: 'momentum', label: 'All on Momentum', hint: 'pink and gray on ⭐ names' },
  { value: 'all', label: 'All', hint: 'every BO, noisy' },
];

const STORAGE_KEY = 'alerts.breakouts';
const CHANGE_EVENT = 'breakout-alarm-changed';
// Default 'momentum' since 10-19 (operator: "I'd like to get grey BOs as well").
const DEFAULT: BreakoutAlarm = 'momentum';

export function getBreakoutAlarm(): BreakoutAlarm {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return BREAKOUT_ALARM_OPTIONS.some((o) => o.value === v) ? (v as BreakoutAlarm) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function setBreakoutAlarm(level: BreakoutAlarm): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // storage disabled — the in-tab event still updates this session
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useBreakoutAlarm(): BreakoutAlarm {
  const [level, setLevel] = useState<BreakoutAlarm>(getBreakoutAlarm);
  useEffect(() => {
    const sync = () => setLevel(getBreakoutAlarm());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return level;
}
