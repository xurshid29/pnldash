import { apiClient } from './client';
import type { TvStage } from './types';

export interface TvWatchlist {
  symbols: string[];   // TradingView symbols, Nasdaq names NASDAQ:-prefixed
  today: number;       // names from today's Momentum screen
  runners: number;     // recent runners (≥ min_chg % on our screen in the last `days`)
  days: number;
  min_chg: number;
  generated_at: string;
}

// The ⚙ menu's 📐 stage switches: which stages are announced (phone +
// dashboard, global). Off = still stored and shown in the 📐 sidebar.
export interface TvAlertSettings {
  announced: TvStage[];
  stages: TvStage[];     // every stage, in menu order
  defaults: TvStage[];
}

// The 📐 VWAP setup's TradingView side (server: routes/tv.ts).
export const tvApi = {
  async watchlist(): Promise<TvWatchlist> {
    const res = await apiClient.get<TvWatchlist>('/api/tv/watchlist');
    return res.data;
  },
  async settings(): Promise<TvAlertSettings> {
    const res = await apiClient.get<TvAlertSettings>('/api/tv/settings');
    return res.data;
  },
  async saveSettings(announced: TvStage[]): Promise<TvAlertSettings> {
    const res = await apiClient.put<TvAlertSettings>('/api/tv/settings', { announced });
    return res.data;
  },
};
