import { getDb } from '../db/index.js';

// The Telegram user's hidden tickers today (2026-10-07, operator: "skip hidden
// tickers on telegram too"). The same per-user, per-ET-day list as the
// Momentum row's hide (user_hidden_tickers); TELEGRAM_USER_ID names the
// dashboard user the chat belongs to — the bot's /hidden and /unhide act as
// that user too. Cached 20 s, so a hide reaches the phone within a cycle.
// Never rejects: without a user or on a DB error nothing is skipped.
const TTL_MS = 20_000;
let cache: { at: number; day: string; set: Set<string> } | null = null;
let warned = false;

function etDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

export async function telegramHiddenTickers(): Promise<Set<string>> {
  const userId = process.env.TELEGRAM_USER_ID?.trim();
  if (!userId) {
    if (!warned) {
      warned = true;
      console.warn('[telegram] TELEGRAM_USER_ID unset — hidden tickers are not skipped on the phone');
    }
    return new Set();
  }
  const day = etDate();
  if (cache && cache.day === day && Date.now() - cache.at < TTL_MS) return cache.set;
  try {
    const rows = await getDb()
      .selectFrom('user_hidden_tickers')
      .select('ticker')
      .where('user_id', '=', userId)
      .where('hidden_date', '=', day)
      .execute();
    cache = { at: Date.now(), day, set: new Set(rows.map((r) => r.ticker.toUpperCase())) };
    return cache.set;
  } catch (err) {
    console.error('[telegram] hidden-ticker lookup failed (nothing skipped):', err instanceof Error ? err.message : err);
    return cache?.day === day ? cache.set : new Set();
  }
}
