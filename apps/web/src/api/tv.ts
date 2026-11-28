import { apiClient } from './client';
import { isTvStage, type TvStage } from './types';

export interface TvWatchlist {
  symbols: string[];   // TradingView symbols, Nasdaq names NASDAQ:-prefixed
  today: number;       // names from today's Momentum screen
  runners: number;     // repeat runners (≥ min_chg % in the last `days`) + second-day names (≥ recent_min_chg % in the last recent_days)
  days: number;
  min_chg: number;
  recent_days: number;     // calendar days ≈ 3 sessions
  recent_min_chg: number;
  generated_at: string;
}

// The ⚙ menu's 📐 stage switches: which stages are announced (phone +
// dashboard, global). Off = still stored and shown in the 📐 sidebar.
export interface TvAlertSettings {
  announced: TvStage[];
  stages: TvStage[];     // every stage, in menu order
  defaults: TvStage[];
  // 2026-11-15, the menu's rule: an EMA cross, a band cross, a BOUNCE, (v47) a TURN or (v48) a POP
  // or a BACK announces on Momentum names only (true, the default) — false also lets a +30% day
  // high announce off the list. 2026-11-27, its one exception, whatever this is set to: a POP or
  // a BACK that is not weak, with a volume reading of 10 or more, is announced on any name
  // (server: TV_SETUP.pp_free_vol; here POP_FREE_VOL and isFreePop in TvStageTag.tsx).
  ema_momo_only: boolean;
}

// What a save may change: the stage switches, the rule, or both.
export type TvAlertSettingsPatch = { announced?: TvStage[]; ema_momo_only?: boolean };

// Only the stages this build knows (script v27 removed RECLAIM's FORMING / READY / GO,
// v28 the VB break's LEVEL / BREAK).
function knownStages(s: TvAlertSettings): TvAlertSettings {
  return {
    announced: s.announced.filter(isTvStage), stages: s.stages.filter(isTvStage), defaults: s.defaults.filter(isTvStage),
    ema_momo_only: s.ema_momo_only !== false,
  };
}

// The 📐 VWAP setup's TradingView side (server: routes/tv.ts).
export const tvApi = {
  async watchlist(): Promise<TvWatchlist> {
    const res = await apiClient.get<TvWatchlist>('/api/tv/watchlist');
    return res.data;
  },
  async settings(): Promise<TvAlertSettings> {
    const res = await apiClient.get<TvAlertSettings>('/api/tv/settings');
    return knownStages(res.data);
  },
  async saveSettings(patch: TvAlertSettingsPatch): Promise<TvAlertSettings> {
    const res = await apiClient.put<TvAlertSettings>('/api/tv/settings', patch);
    return knownStages(res.data);
  },
  // 2026-11-28: a short-lived token that lets the TWS bridge on this computer listen to the
  // server's alert stream (its automation). The caller hands it straight to the bridge's
  // /auto/feed and keeps it nowhere: not in state, storage, a log or an error text. An older
  // server answers 404 `{ error: 'Not found' }`.
  async feedToken(): Promise<{ token: string; expires_at: string }> {
    const res = await apiClient.post<{ token: string; expires_at: string }>('/api/tv/feed-token');
    const d = res.data as unknown;
    if (d == null || typeof d !== 'object' || typeof (d as { token?: unknown }).token !== 'string' || (d as { token: string }).token === '') {
      throw new Error('the server did not answer as expected');
    }
    return d as { token: string; expires_at: string };
  },
};
