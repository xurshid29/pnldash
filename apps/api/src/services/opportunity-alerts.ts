// Opportunity alerts (2026-10-01) — one engine behind both the phone
// (Telegram) and the dashboard (sound + browser notification), so the two can
// never disagree about what happened. Three triggers, sized on September 2026
// (22 sessions, out-of-sample for the grade):
//
//   🅰️ grade_aplus  First time a Momentum ticker reaches A+ that ET day —
//                   new on screen or upgraded. Repeat entries are mostly the
//                   2-minute smoothing breathing around the cut: every entry
//                   = 162/day, 30-min cooldown = 68/day, first-of-day = 26/day
//                   AND the best quality (+10% within 30 min 38% vs 3% base;
//                   two-way though: −10% first 39%, +10% first 33%).
//   ⚡ fast_move    A name on screen ≥5 min trades ≥+10% above its price
//                   ~60s earlier with RVol 1m ≥1000%. 15-min cooldown per
//                   ticker, and folded away when the same ticker alerted in
//                   the last 5 min: ~31/day, +10% within 30 min 44% — but
//                   −10% first 50%: fast tapes are fast both ways.
//   📰 news         A headline PUBLISHED ≤30 min before we first see it, on a
//                   ticker that is on the Momentum screen, deduped by URL and
//                   by title per ticker per day (Finviz + Yahoo repeat each
//                   other). 48/day; the phone gets only catalyst ≥40 (17/day),
//                   the dashboard gets all. 74% of first-seen headlines are
//                   OLD news found when a ticker first appears — the publish
//                   age gate is what keeps them out.
//
// Same-ticker events in one cycle merge into one alert. Combined, the phone
// sees ~63/day (busiest hour 09:00–10:00 ET ≈ 10), the dashboard ~88/day.
// Per-type mutes: Telegram via ALERTS_DISABLED slugs (grade_aplus,
// fast_move, news); dashboard via the header's per-type switches.
//
// A fourth kind arrives from outside the cycle (2026-10-03): 📐 tv_setup, the
// operator's VWAP setup as detected by a TradingView watchlist alert and
// posted to our webhook (tv-setups.ts). The poller hands it to pushExternal()
// so it rides in payload.alerts with the rest.

import type { NewsSource } from '../db/types.js';
import { classifyByRules } from './catalyst-rules.js';
import type { TvGoVia, TvPath, TvStage } from './tv-setups.js';

export type OpportunityKind = 'grade_aplus' | 'fast_move' | 'news' | 'tv_setup';

// 📐 tv_setup details — the levels TradingView reported at the signal.
export interface TvSetupInfo {
  stage: TvStage;
  mvwap: number | null;
  px_pct: number | null;      // price vs mVWAP, %
  basis: number | null;
  basis_pct: number | null;   // BB basis vs mVWAP, %
  day_gain: number | null;    // day high vs prior close, %
  ah_gain: number | null;     // after hours: high since today's close, % (script v3+)
  tf: string | null;
  path: TvPath | null;        // 'base' | 'fast' — which shape reached FORMING/READY (script v2+)
  go_via: TvGoVia | null;     // 'reclaim' | 'cross' — what fired GO (script v5+)
  on_screen: boolean;         // on our Momentum screen at the signal
  notified: boolean;          // false = same stage already announced from another timeframe
}

export const OPPORTUNITY = {
  fast_move_pct: 10,          // % above the price ~60s earlier
  fast_min_rel_vol_1min: 1000, // RVol 1m (%), the volume confirmation
  fast_min_age_min: 5,        // "existing" ticker — new arrivals belong to the A+ path
  fast_cooldown_sec: 900,
  lookback_min_sec: 55,       // the ~60s reference sample: newest with age 55–120s
  lookback_max_sec: 120,
  merge_sec: 300,             // fold a fast move into a same-ticker alert from <5 min ago
  news_max_age_sec: 1800,     // published at most 30 min before first sight
  news_phone_min_score: 40,   // strong/major catalysts reach the phone
  recent_keep_ms: 60 * 60_000,
  recent_max: 40,
} as const;

export interface OpportunityRow {
  ticker: string;
  price: number | null;
  change_pct: number | null;
  grade: string | null;
  float_m: number | null;
  rel_vol_1min: number | null;
  first_seen_at: string;       // ISO
}

export interface OpportunityNewsItem {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: Date | null;
  secForm?: string | null;
  haltReason?: string | null;
}

export interface OpportunityNews {
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
  score: number;
  direction: string;
  type: string;
}

export interface OpportunityAlert {
  id: string;
  ticker: string;
  kinds: OpportunityKind[];
  at: string;                  // ISO
  price: number | null;
  change_pct: number | null;
  grade: string | null;
  prev_grade: string | null;   // grade_aplus: the letter before A+ (null = new on screen)
  new_on_screen: boolean;
  move_pct: number | null;     // fast_move: % gained over ~60s
  rel_vol_1min: number | null;
  float_m: number | null;
  news: OpportunityNews | null;
  setup?: TvSetupInfo | null;  // tv_setup only
}

export function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class OpportunityAlerts {
  private lastGrade = new Map<string, string>();
  private aplusToday = new Set<string>();
  private lastFastAt = new Map<string, number>();   // ticker → epoch sec
  private lastAlertAt = new Map<string, number>();  // ticker → epoch sec (any momentum alert)
  private priceHist = new Map<string, Array<{ ts: number; price: number }>>();
  private seenUrls = new Set<string>();
  private seenTitles = new Set<string>();           // `${ticker}|${normTitle}` — per ET day
  private recent: OpportunityAlert[] = [];

  // Boot seeding (poller.seedOpportunityState) so a deploy neither re-pings
  // today's alerts nor treats already-stored headlines as new.
  seed(s: { aplus?: string[]; fast?: Array<[string, number]>; urls?: string[]; titles?: string[] }): void {
    for (const t of s.aplus ?? []) this.aplusToday.add(t);
    for (const [t, at] of s.fast ?? []) {
      this.lastFastAt.set(t, Math.max(this.lastFastAt.get(t) ?? 0, at));
      this.lastAlertAt.set(t, Math.max(this.lastAlertAt.get(t) ?? 0, at));
    }
    for (const u of s.urls ?? []) this.seenUrls.add(u);
    for (const k of s.titles ?? []) this.seenTitles.add(k);
  }

  // Midnight-ET roll (with the poller's other alert dedups). URLs are kept —
  // they are globally unique and an old article must never re-alert.
  resetDay(): void {
    this.lastGrade.clear();
    this.aplusToday.clear();
    this.lastFastAt.clear();
    this.lastAlertAt.clear();
    this.priceHist.clear();
    this.seenTitles.clear();
    this.recent = [];
  }

  // An alert produced outside the cycle (📐 tv_setup) — kept in the recent
  // list so payload.alerts carries it like the cycle's own alerts.
  pushExternal(a: OpportunityAlert): void {
    this.recent.push(a);
  }

  recentAlerts(nowMs: number): OpportunityAlert[] {
    this.recent = this.recent.filter((a) => nowMs - Date.parse(a.at) <= OPPORTUNITY.recent_keep_ms);
    return this.recent.slice(-OPPORTUNITY.recent_max).reverse();
  }

  // One cycle. `rows` = the Momentum screen as displayed; `news` = every item
  // the five news sources returned this cycle. Returns the alerts to deliver.
  evaluate(rows: OpportunityRow[], news: OpportunityNewsItem[], nowSec: number): OpportunityAlert[] {
    const byTicker = new Map<string, OpportunityAlert>();
    const onScreen = new Map(rows.map((r) => [r.ticker, r]));
    const ensure = (r: OpportunityRow): OpportunityAlert => {
      let a = byTicker.get(r.ticker);
      if (!a) {
        a = {
          id: '', ticker: r.ticker, kinds: [], at: new Date(nowSec * 1000).toISOString(),
          price: r.price, change_pct: r.change_pct, grade: r.grade, prev_grade: null,
          new_on_screen: false, move_pct: null, rel_vol_1min: r.rel_vol_1min, float_m: r.float_m, news: null,
        };
        byTicker.set(r.ticker, a);
      }
      return a;
    };

    for (const r of rows) {
      const ageMin = (nowSec * 1000 - Date.parse(r.first_seen_at)) / 60000;
      // ~60s reference price, then record this cycle's sample.
      const hist = this.priceHist.get(r.ticker) ?? [];
      let ref: number | null = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        const age = nowSec - hist[i].ts;
        if (age < OPPORTUNITY.lookback_min_sec) continue;
        if (age <= OPPORTUNITY.lookback_max_sec) ref = hist[i].price;
        break;
      }
      if (r.price != null && r.price > 0) {
        hist.push({ ts: nowSec, price: r.price });
        while (hist.length > 0 && nowSec - hist[0].ts > 180) hist.shift();
        this.priceHist.set(r.ticker, hist);
      }

      // 🅰️ first A+ of the day.
      const prev = this.lastGrade.get(r.ticker) ?? null;
      if (r.grade) this.lastGrade.set(r.ticker, r.grade);
      if (r.grade === 'A+' && !this.aplusToday.has(r.ticker)) {
        this.aplusToday.add(r.ticker);
        const a = ensure(r);
        a.kinds.push('grade_aplus');
        a.prev_grade = prev === 'A+' ? null : prev;
        // Minutes on screen (firstSeenAt is DB-seeded on boot), not `prev` —
        // after a deploy every ticker has no in-memory previous grade.
        a.new_on_screen = ageMin < 5;
      }

      // ⚡ fast move on an existing ticker.
      if (
        ref != null && r.price != null && ageMin >= OPPORTUNITY.fast_min_age_min
        && (r.price / ref - 1) * 100 >= OPPORTUNITY.fast_move_pct
        && (r.rel_vol_1min ?? 0) >= OPPORTUNITY.fast_min_rel_vol_1min
        && nowSec - (this.lastFastAt.get(r.ticker) ?? 0) >= OPPORTUNITY.fast_cooldown_sec
      ) {
        this.lastFastAt.set(r.ticker, nowSec);
        const sameCycle = byTicker.get(r.ticker)?.kinds.includes('grade_aplus') ?? false;
        const recentAlert = nowSec - (this.lastAlertAt.get(r.ticker) ?? 0) < OPPORTUNITY.merge_sec;
        if (sameCycle || !recentAlert) {
          const a = ensure(r);
          a.kinds.push('fast_move');
          a.move_pct = Math.round((r.price / ref - 1) * 1000) / 10;
        }
      }
    }

    // 📰 fresh headlines on screened tickers — best one per ticker per cycle.
    for (const n of news) {
      const row = onScreen.get(n.ticker);
      if (!row || !n.url) continue;           // only screened names; not marked seen
      if (this.seenUrls.has(n.url)) continue;
      this.seenUrls.add(n.url);
      if (!n.published_at || Number.isNaN(n.published_at.getTime())) continue;
      if (nowSec - n.published_at.getTime() / 1000 > OPPORTUNITY.news_max_age_sec) continue;
      const tkey = `${n.ticker}|${normTitle(n.title)}`;
      if (this.seenTitles.has(tkey)) continue;
      this.seenTitles.add(tkey);
      const cls = classifyByRules({ ticker: n.ticker, title: n.title, source: n.source, secForm: n.secForm ?? null, haltReason: n.haltReason ?? null });
      const item: OpportunityNews = {
        source: n.source, title: n.title, url: n.url, published_at: n.published_at.toISOString(),
        score: cls.impact_score, direction: cls.direction, type: cls.catalyst_type,
      };
      const a = ensure(row);
      if (!a.kinds.includes('news')) a.kinds.push('news');
      if (!a.news || item.score > a.news.score) a.news = item;
    }

    const out: OpportunityAlert[] = [];
    for (const a of byTicker.values()) {
      if (a.kinds.length === 0) continue;
      a.id = `${a.ticker}:${nowSec}:${a.kinds.join('+')}`;
      if (a.kinds.includes('grade_aplus') || a.kinds.includes('fast_move')) this.lastAlertAt.set(a.ticker, nowSec);
      out.push(a);
      this.recent.push(a);
    }
    return out;
  }
}

// Does this alert qualify for the phone, given the per-kind mutes? News-only
// alerts need a strong/major catalyst; momentum kinds always qualify.
export function phoneKinds(a: OpportunityAlert, disabled: (k: OpportunityKind) => boolean): OpportunityKind[] {
  return a.kinds.filter((k) => !disabled(k)
    && (k !== 'news' || (a.news?.score ?? 0) >= OPPORTUNITY.news_phone_min_score));
}
