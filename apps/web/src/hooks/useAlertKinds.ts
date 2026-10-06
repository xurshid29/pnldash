import { useEffect, useState } from 'react';

// Per-type switches for the dashboard's opportunity alerts (2026-10-01):
// 🅰️ first A+ of the day, ⚡ fast move, 📰 fresh news, and since 2026-10-03
// 📐 the TradingView VWAP setup (which stages alert at all is the server-side
// ⚙ stage switch, useTvAlertStages). Device-local like the
// Alerts ON/OFF master switch (useAlertsArmed) — sound/notification are
// per-browser concerns. The phone has its own mutes server-side
// (ALERTS_DISABLED slugs grade_aplus / fast_move / news / tv_setup).
export type AlertKind = 'grade_aplus' | 'fast_move' | 'news' | 'tv_setup';
export type AlertKinds = Record<AlertKind, boolean>;

const STORAGE_KEY = 'alerts.kinds';
const CHANGE_EVENT = 'alert-kinds-changed';
const DEFAULTS: AlertKinds = { grade_aplus: true, fast_move: true, news: true, tv_setup: true };

export function getAlertKinds(): AlertKinds {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AlertKinds>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setAlertKind(kind: AlertKind, on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...getAlertKinds(), [kind]: on }));
  } catch {
    // storage disabled — the in-tab event still updates this session
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAlertKinds(): AlertKinds {
  const [kinds, setKinds] = useState<AlertKinds>(getAlertKinds);
  useEffect(() => {
    const sync = () => setKinds(getAlertKinds());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return kinds;
}
