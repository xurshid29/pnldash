import express, { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { poller } from '../services/poller.js';
import { nasdaqTickerSet } from '../services/edgar.js';
import { DEFAULT_ANNOUNCED, parseStageList, parseTvMessage, pastCap, TV_STAGE_ORDER, TvSetupGate } from '../services/tv-setups.js';

// TradingView ↔ dashboard bridge for the 📐 VWAP setup (services/tv-setups.ts).
const router = Router();
const gate = new TvSetupGate();

// The ⚙ menu's 📐 stage switches (2026-10-06): which stages are announced —
// phone and dashboard alike. One global row in app_settings, like the
// screener config, because the gate and Telegram are global. Loaded once,
// before the first webhook or settings read; never rejects (defaults stay).
const STAGES_KEY = 'tv_alert_stages';
let settingsLoad: Promise<void> | null = null;
function loadSettings(): Promise<void> {
  settingsLoad ??= getDb()
    .selectFrom('app_settings').select('value').where('key', '=', STAGES_KEY)
    .executeTakeFirst()
    .then((row) => {
      const stages = row ? parseStageList(row.value) : null;
      if (stages) gate.setAnnounced(stages);
      console.log(`[tv-setup] announced stages: ${gate.announcedStages().join(', ') || 'none'}${stages ? '' : ' (default)'}`);
    })
    .catch((err) => {
      console.error('[tv-setup] stage settings load failed (defaults in use):', err instanceof Error ? err.message : err);
    });
  return settingsLoad;
}

// A deploy restarts the gate empty. Before the first webhook, reload today's
// announced READYs once, so a READY already announced today stays quiet.
// Never rejects: on a DB error the gate just starts empty.
let gateSeed: Promise<void> | null = null;
function seedGate(): Promise<void> {
  gateSeed ??= getDb()
    .selectFrom('tier_events')
    .select(['ticker', sql<string | null>`meta->>'line'`.as('line')])
    .where('tier', '=', 'alert')
    .where('event', '=', 'tv_setup')
    .where(sql<boolean>`(at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`)
    .where(sql<boolean>`meta->>'stage' = 'ready' AND (meta->>'notified')::boolean`)
    .execute()
    .then((rows) => {
      const lines = gate.seedReady(rows, Math.floor(Date.now() / 1000));
      console.log(`[tv-setup] gate seeded — ${rows.length} READYs announced today, ${lines} ticker lines`);
    })
    .catch((err) => {
      console.error('[tv-setup] gate seeding failed (a READY announced earlier today may be announced again):', err instanceof Error ? err.message : err);
    });
  return gateSeed;
}

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
router.post('/webhook', express.text({ type: () => true, limit: '16kb' }), async (req, res) => {
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

  await Promise.all([loadSettings(), seedGate()]);
  // Express 4 doesn't catch errors thrown after an await — answer them here.
  try {
    // v16: a PULLBACK past the cap still pings for a B+-or-better Momentum ticker.
    const capped = pastCap(sig);
    const capExempt = capped && poller.tvCapExempt(sig.ticker);
    const verdict = gate.admit(sig, Math.floor(Date.now() / 1000), capExempt);
    if (verdict === 'flood') {
      console.warn(`[tv-setup] flood guard — dropped ${sig.stage} ${sig.ticker}`);
      return res.status(429).json({ error: 'Too many alerts' });
    }
    if (verdict === 'drop') return res.json({ data: { duplicate: true } });
    const why = verdict !== 'quiet' ? undefined
      : !gate.announces(sig.stage) ? 'muted' : capped && !capExempt ? 'capped' : 'repeat';
    const alert = poller.deliverTvSetup(sig, verdict, why, capExempt);
    res.json({ data: { id: alert.id, notified: verdict === 'notify' } });
  } catch (err) {
    console.error(`[tv-setup] delivery failed for ${sig.stage} ${sig.ticker}:`, err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Delivery failed' });
  }
});

// GET /api/tv/settings — the 📐 stage switches: which stages are announced
// (Telegram + dashboard toast/sound/notification). Off = quiet: still stored,
// graded and shown in the 📐 sidebar.
router.get('/settings', authMiddleware, async (_req, res) => {
  await loadSettings();
  res.json({ data: { announced: gate.announcedStages(), stages: TV_STAGE_ORDER, defaults: DEFAULT_ANNOUNCED } });
});

// PUT /api/tv/settings { announced: ["go", "pullback", …] } — global, like the
// screener config. Takes effect on the next webhook; persisted for restarts.
const settingsSchema = z.object({ announced: z.array(z.enum(TV_STAGE_ORDER as [string, ...string[]])) });
router.put('/settings', authMiddleware, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'announced must be a list of stages' });
  await loadSettings();   // so a late first load can't overwrite this change
  const stages = parseStageList(parsed.data.announced) ?? [];
  try {
    await getDb()
      .insertInto('app_settings')
      .values({ key: STAGES_KEY, value: JSON.stringify(stages), updated_at: new Date() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(stages), updated_at: new Date() }))
      .execute();
  } catch (err) {
    console.error('[tv-setup] stage settings save failed:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Could not save the stage settings' });
  }
  gate.setAnnounced(stages);
  console.log(`[tv-setup] announced stages set to: ${stages.join(', ') || 'none'}`);
  res.json({ data: { announced: gate.announcedStages(), stages: TV_STAGE_ORDER, defaults: DEFAULT_ANNOUNCED } });
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
