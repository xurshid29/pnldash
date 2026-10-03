import express, { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { sql } from 'kysely';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { poller } from '../services/poller.js';
import { nasdaqTickerSet } from '../services/edgar.js';
import { parseTvMessage, TvSetupGate } from '../services/tv-setups.js';

// TradingView ↔ dashboard bridge for the 📐 VWAP setup (services/tv-setups.ts).
const router = Router();
const gate = new TvSetupGate();

function keyMatches(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST /api/tv/webhook?key=<TV_WEBHOOK_SECRET>[&dry=1] — the TradingView alert
// webhook. TradingView can't send auth headers, so the shared secret rides in
// the URL saved in the alert. The body is the alert message: text/plain for
// the Pine script's alert() text, application/json when the message is JSON
// (the global JSON parser has already turned that into an object). TradingView
// waits ~3s for an answer, so delivery (DB row, SSE, Telegram) is fire-and-
// forget behind an immediate reply. dry=1 parses and echoes without delivering.
router.post('/webhook', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
  const secret = process.env.TV_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'TradingView webhook disabled (TV_WEBHOOK_SECRET unset)' });
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!keyMatches(key, secret)) return res.status(401).json({ error: 'Invalid key' });

  const sig = parseTvMessage(req.body);
  if (!sig) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
    console.warn(`[tv-setup] unrecognised webhook message: ${raw.slice(0, 200)}`);
    return res.status(400).json({ error: 'Unrecognised alert message' });
  }
  if (req.query.dry === '1') return res.json({ data: { dry_run: true, signal: sig } });

  const verdict = gate.admit(sig, Math.floor(Date.now() / 1000));
  if (verdict === 'flood') {
    console.warn(`[tv-setup] flood guard — dropped ${sig.stage} ${sig.ticker}`);
    return res.status(429).json({ error: 'Too many alerts' });
  }
  if (verdict === 'drop') return res.json({ data: { duplicate: true } });
  const alert = poller.deliverTvSetup(sig, verdict);
  res.json({ data: { id: alert.id, notified: verdict === 'notify' } });
});

// GET /api/tv/watchlist[?days=30&min_chg=30] — the symbols for the TradingView
// watchlist the setup alert runs on: every name on today's Momentum screen,
// then every name that ran ≥ min_chg % on our screen in the last `days` days
// (the six examples that defined the setup had all been on our screen in the
// 2–3 weeks before their setup day). The Pine script filters to today's top
// gainers itself, so a wide list costs nothing but catches second-day names.
// Nasdaq names carry the NASDAQ: prefix (the SPRO index-collision fix); the
// rest stay bare and TradingView resolves them. Cached 10 min — it scans a
// month of screener_results.
const WATCHLIST_TTL_MS = 10 * 60_000;
const WATCHLIST_MAX = 1000;
const watchlistCache = new Map<string, { at: number; data: unknown }>();

router.get('/watchlist', authMiddleware, async (req, res) => {
  const days = Math.min(60, Math.max(1, Number.parseInt(String(req.query.days ?? '30'), 10) || 30));
  const minChgRaw = Number(req.query.min_chg ?? 30);
  const minChg = Number.isFinite(minChgRaw) ? Math.min(1000, Math.max(0, minChgRaw)) : 30;
  const cacheKey = `${days}|${minChg}`;
  const hit = watchlistCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WATCHLIST_TTL_MS) return res.json({ data: hit.data });

  let rows: Array<{ ticker: string; today: boolean }>;
  try {
    ({ rows } = await sql<{ ticker: string; today: boolean }>`
      WITH d AS (
        SELECT r.ticker,
               max(c.polled_at) AS last_seen,
               max(r.change_pct) AS max_chg,
               bool_or((c.polled_at AT TIME ZONE 'America/New_York')::date
                       = (now() AT TIME ZONE 'America/New_York')::date) AS today
        FROM screener_results r
        JOIN screener_cycles c ON c.id = r.cycle_id
        WHERE c.polled_at > now() - make_interval(days => ${days}::int)
        GROUP BY r.ticker
      )
      SELECT ticker, today FROM d
      WHERE today OR max_chg >= ${minChg}::numeric
      ORDER BY today DESC, last_seen DESC
      LIMIT ${WATCHLIST_MAX}::int
    `.execute(getDb()));
  } catch (err) {
    console.error('[tv-setup] watchlist query failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Watchlist query failed' });
  }

  const nasdaq = await nasdaqTickerSet();
  const symbols = rows.map((r) => (nasdaq.has(r.ticker.toUpperCase()) ? `NASDAQ:${r.ticker}` : r.ticker));
  const data = {
    symbols,
    today: rows.filter((r) => r.today).length,
    runners: rows.filter((r) => !r.today).length,
    days,
    min_chg: minChg,
    generated_at: new Date().toISOString(),
  };
  watchlistCache.set(cacheKey, { at: Date.now(), data });
  res.json({ data });
});

export default router;
