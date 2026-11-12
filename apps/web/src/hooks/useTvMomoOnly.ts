import { useEffect, useState } from 'react';
import type { CyclePayload, OpportunityAlert } from '../api/types';

// 📐 "Show only Momentum tickers" (2026-11-03): the setups sidebar's checkbox.
// It keeps only the ⭐ rows (on the Momentum screen right now) and, since the
// same day (operator: "we don't need to show alerts (and play sound) for those"),
// also mutes the dashboard's toast, sound and notification for a 📐 setup on a
// ticker off the screen. Device-local like the alert switches (useAlertKinds);
// the phone's Telegram pings are server-side and unchanged.
const STORAGE_KEY = 'tvSidebar.momoOnly';
const CHANGE_EVENT = 'tv-momo-only-changed';

function read(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

// The module copy is the source of truth, so the switch still holds for this
// tab when storage is blocked.
let current = read();

export function getTvMomoOnly(): boolean {
  return current;
}

export function setTvMomoOnly(on: boolean): void {
  current = on;
  try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// A 📐 setup the switch silences: it's on and the ticker isn't on the screen
// in this payload (the same test as the sidebar's ⭐). A v32 RSI cross and its v34 DIP
// are never silenced — a longer trade, rarely on today's screen (the sidebar keeps their rows too).
export function mutedByMomoOnly(a: OpportunityAlert, payload: CyclePayload): boolean {
  const rsi = a.setup?.stage === 'rsi' || a.setup?.stage === 'dip';
  return current && !rsi && !(payload.rows ?? []).some((r) => r.ticker === a.ticker);
}

export function useTvMomoOnly(): boolean {
  const [on, setOn] = useState(current);
  useEffect(() => {
    const sync = () => setOn(current);
    const fromOtherTab = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      current = read();
      sync();
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', fromOtherTab);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', fromOtherTab);
    };
  }, []);
  return on;
}
