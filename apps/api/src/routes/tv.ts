import express, { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import { poller } from '../services/poller.js';
import { nasdaqTickerSet } from '../services/edgar.js';
import { BREAKOUT_STAGES, DEFAULT_ANNOUNCED, parseStageList, parseTvMessage, pastCap, TV_STAGE_ORDER, TvSetupGate } from '../services/tv-setups.js';

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
    // v16: a PULLBACK past the cap still pings for a B+-or-better Momentum ticker
    // (a v21 CROSS past its cap doesn't).
    const capped = pastCap(sig);
    const capExempt = capped && sig.stage === 'pullback' && poller.tvCapExempt(sig.ticker);
    // 2026-10-18: a GO pings only for a ticker on our Momentum list.
    const onMomentum = poller.tvOnMomentum(sig.ticker);
    const verdict = gate.admit(sig, Math.floor(Date.now() / 1000), capExempt, onMomentum);
    if (verdict === 'flood') {
      console.warn(`[tv-setup] flood guard — dropped ${sig.stage} ${sig.ticker}`);
      return res.status(429).json({ error: 'Too many alerts' });
    }
    if (verdict === 'drop') return res.json({ data: { duplicate: true } });
    // v17 BB breakout: stored and shown, never announced (its own delivery path).
    if (BREAKOUT_STAGES.has(sig.stage)) {
      const ev = poller.deliverTvBreakout(sig);
      return res.json({ data: { id: ev.id, notified: false } });
    }
    const why = verdict !== 'quiet' ? undefined
      : !gate.announces(sig.stage) ? 'muted' : capped && !capExempt ? 'capped'
        : (sig.stage === 'go' || sig.stage === 'cross' || sig.stage === 'break') && !onMomentum ? 'offlist' : 'repeat';   // a quiet off-list CROSS / BREAK is under vb_fresh_gain
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

// GET /api/tv/watchlist[?days=90&min_chg=30&recent_days=5&recent_min_chg=20] —
// the symbols for the TradingView watchlist the 📐 alerts run on, today's
// Momentum names first, then:
//   - every name that ran ≥ min_chg % on our screen in the last `days` days —
//     repeat runners (operator, 2026-10-12: "too many tickers repeat their big
//     moves once a several days"). Of the +30% days since mid-August, a list
//     built the night before held 64% at 30 days, 80% at 90 days;
//   - every name ≥ recent_min_chg % in the last `recent_days` calendar days
//     (≈ 3 sessions — the script's own gainer rule: +20% in the last 3
//     sessions), so second-day names are on an overnight download too.
// With today's names that's ~850–960 symbols, under TradingView's 1,000 per
// list (WATCHLIST_MAX trims the oldest first). The script filters to gainers
// itself, so a wide list costs nothing. Nasdaq names carry the NASDAQ: prefix
// (the SPRO index-collision fix). History comes from screener_ticker_days
// (one row per ticker per day, topped up here), today from screener_results.
// Cached 10 min.
const WATCHLIST_TTL_MS = 10 * 60_000;
const WATCHLIST_MAX = 1000;
const watchlistCache = new Map<string, { at: number; data: unknown }>();

function etToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

// Add the complete ET days missing from screener_ticker_days (the migration
// filled history up to its deploy day). Once per ET day; a day is ~100k rows
// read by the polled_at index. Errors are logged and the list uses what's there.
let tickerDaysReadyFor = '';
async function topUpTickerDays(today: string): Promise<void> {
  if (tickerDaysReadyFor === today) return;
  try {
    await getDb().transaction().execute(async (trx) => {
      await sql`set local random_page_cost = 1.1`.execute(trx);
      await sql`set local jit = off`.execute(trx);
      const res = await sql`
        insert into screener_ticker_days (ticker, et_date, max_chg)
        select r.ticker, (c.polled_at at time zone 'America/New_York')::date, max(r.change_pct)
        from screener_results r
        join screener_cycles c on c.id = r.cycle_id
        where r.change_pct is not null
          and c.polled_at >= coalesce(
                ((select max(et_date) from screener_ticker_days) + 1)::timestamp at time zone 'America/New_York',
                (${today}::date - 120)::timestamp at time zone 'America/New_York')
          and c.polled_at < (${today}::date)::timestamp at time zone 'America/New_York'
        group by 1, 2
        on conflict (ticker, et_date) do update set max_chg = excluded.max_chg
      `.execute(trx);
      const n = Number(res.numAffectedRows ?? 0);
      if (n > 0) console.log(`[tv-setup] watchlist history topped up: ${n} ticker-days`);
    });
    tickerDaysReadyFor = today;
  } catch (err) {
    console.error('[tv-setup] watchlist history top-up failed:', err instanceof Error ? err.message : err);
  }
}

const intParam = (v: unknown, def: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.parseInt(String(v ?? def), 10) || def));
const numParam = (v: unknown, def: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : def;
};

router.get('/watchlist', authMiddleware, async (req, res) => {
  const days = intParam(req.query.days, 90, 1, 180);
  const minChg = numParam(req.query.min_chg, 30);
  const recentDays = intParam(req.query.recent_days, 5, 0, 30);
  const recentMinChg = numParam(req.query.recent_min_chg, 20);
  const today = etToday();
  const cacheKey = `${today}|${days}|${minChg}|${recentDays}|${recentMinChg}`;
  const hit = watchlistCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WATCHLIST_TTL_MS) return res.json({ data: hit.data });

  await topUpTickerDays(today);
  let rows: Array<{ ticker: string; today: boolean }>;
  try {
    rows = await getDb().transaction().execute(async (trx) => {
      await sql`set local random_page_cost = 1.1`.execute(trx);
      await sql`set local jit = off`.execute(trx);
      const { rows: r } = await sql<{ ticker: string; today: boolean }>`
        with t as (
          select r.ticker, max(c.polled_at) as last_seen
          from screener_results r
          join screener_cycles c on c.id = r.cycle_id
          where c.polled_at >= (${today}::date)::timestamp at time zone 'America/New_York'
          group by r.ticker
        ),
        h as (
          select ticker, max(et_date) as last_day
          from screener_ticker_days
          where (et_date >= ${today}::date - ${days}::int and max_chg >= ${minChg}::numeric)
             or (et_date >= ${today}::date - ${recentDays}::int and max_chg >= ${recentMinChg}::numeric)
          group by ticker
        )
        select coalesce(t.ticker, h.ticker) as ticker, t.ticker is not null as today
        from t full join h on h.ticker = t.ticker
        order by (t.ticker is not null) desc, t.last_seen desc nulls last, h.last_day desc nulls last
        limit ${WATCHLIST_MAX}::int
      `.execute(trx);
      return r;
    });
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
    recent_days: recentDays,
    recent_min_chg: recentMinChg,
    generated_at: new Date().toISOString(),
  };
  watchlistCache.set(cacheKey, { at: Date.now(), data });
  res.json({ data });
});

export default router;
