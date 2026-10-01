// Regression for the opportunity-alert engine (services/opportunity-alerts.ts).
// Run:  npx tsx scripts/verify-opportunity-alerts.ts
// Pins the dedup / cooldown / merge contract that keeps the phone usable.

import {
  OpportunityAlerts, OPPORTUNITY, phoneKinds,
  type OpportunityRow, type OpportunityNewsItem, type OpportunityAlert,
} from '../src/services/opportunity-alerts.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const T0 = 1_790_000_000; // arbitrary epoch sec
const iso = (sec: number) => new Date(sec * 1000).toISOString();
function row(over: Partial<OpportunityRow> & { ticker: string }, firstSeenSec = T0 - 3600): OpportunityRow {
  return {
    price: 2, change_pct: 40, grade: 'B', float_m: 3, rel_vol_1min: 5000, first_seen_at: iso(firstSeenSec), ...over,
  };
}
const kinds = (as: OpportunityAlert[], t: string) => as.find((a) => a.ticker === t)?.kinds ?? [];

console.log('A+ — first of the day only');
{
  const e = new OpportunityAlerts();
  let out = e.evaluate([row({ ticker: 'AAA', grade: 'B+' })], [], T0);
  check('no alert below A+', out.length === 0);
  out = e.evaluate([row({ ticker: 'AAA', grade: 'A+' })], [], T0 + 20);
  check('upgrade to A+ alerts', kinds(out, 'AAA').includes('grade_aplus'));
  check('…labelled as an upgrade from B+', out[0]?.prev_grade === 'B+' && out[0]?.new_on_screen === false, JSON.stringify(out[0]));
  e.evaluate([row({ ticker: 'AAA', grade: 'A' })], [], T0 + 40);
  out = e.evaluate([row({ ticker: 'AAA', grade: 'A+' })], [], T0 + 60);
  check('re-entering A+ the same day stays quiet', out.length === 0);
  e.resetDay();
  out = e.evaluate([row({ ticker: 'AAA', grade: 'A+' })], [], T0 + 86_400);
  check('next day alerts again', kinds(out, 'AAA').includes('grade_aplus'));
  const n = new OpportunityAlerts();
  out = n.evaluate([row({ ticker: 'NEW', grade: 'A+' }, T0 - 60)], [], T0);
  check('a name 1 min on screen is "new on screen"', out[0]?.new_on_screen === true);
}

console.log('Fast move — +10% vs ~60s ago, RVol, age, cooldown');
{
  const e = new OpportunityAlerts();
  e.evaluate([row({ ticker: 'FST', price: 1.0 })], [], T0);
  let out = e.evaluate([row({ ticker: 'FST', price: 1.12 })], [], T0 + 30);
  check('reference must be ≥55s old (30s → no alert)', out.length === 0);
  out = e.evaluate([row({ ticker: 'FST', price: 1.12 })], [], T0 + 60);
  check('+12% vs 60s ago fires', kinds(out, 'FST').includes('fast_move') && out[0]?.move_pct === 12, JSON.stringify(out[0]));
  e.evaluate([row({ ticker: 'FST', price: 1.12 })], [], T0 + 120);
  out = e.evaluate([row({ ticker: 'FST', price: 1.40 })], [], T0 + 180);
  check('within the 15-min cooldown → quiet', out.length === 0);
  for (let t = 200; t <= OPPORTUNITY.fast_cooldown_sec + 60; t += 20) e.evaluate([row({ ticker: 'FST', price: 1.4 })], [], T0 + t);
  out = e.evaluate([row({ ticker: 'FST', price: 1.6 })], [], T0 + OPPORTUNITY.fast_cooldown_sec + 120);
  check('after the cooldown it can fire again', kinds(out, 'FST').includes('fast_move'));

  const lowVol = new OpportunityAlerts();
  lowVol.evaluate([row({ ticker: 'LV', price: 1, rel_vol_1min: 500 })], [], T0);
  out = lowVol.evaluate([row({ ticker: 'LV', price: 1.2, rel_vol_1min: 500 })], [], T0 + 60);
  check('RVol 1m under 1000% → quiet', out.length === 0);

  const fresh = new OpportunityAlerts();
  fresh.evaluate([row({ ticker: 'FR', price: 1 }, T0 - 120)], [], T0);
  out = fresh.evaluate([row({ ticker: 'FR', price: 1.2 }, T0 - 120)], [], T0 + 60);
  check('on screen <5 min → left to the A+ path', out.length === 0);

  const gap = new OpportunityAlerts();
  gap.evaluate([row({ ticker: 'GP', price: 1 })], [], T0);
  out = gap.evaluate([row({ ticker: 'GP', price: 1.3 })], [], T0 + 200);
  check('reference older than 120s (screen gap) → quiet', out.length === 0);
}

console.log('Merge');
{
  const e = new OpportunityAlerts();
  e.evaluate([row({ ticker: 'MRG', price: 1, grade: 'B+' })], [], T0);
  let out = e.evaluate([row({ ticker: 'MRG', price: 1.15, grade: 'A+' })], [], T0 + 60);
  check('A+ and fast in one cycle → ONE alert with both kinds', out.length === 1 && out[0].kinds.join() === 'grade_aplus,fast_move', JSON.stringify(out.map((a) => a.kinds)));

  const m2 = new OpportunityAlerts();
  m2.evaluate([row({ ticker: 'M2', price: 1, grade: 'B+' })], [], T0);
  m2.evaluate([row({ ticker: 'M2', price: 1, grade: 'A+' })], [], T0 + 20); // A+ alert at T0+20
  m2.evaluate([row({ ticker: 'M2', price: 1, grade: 'A+' })], [], T0 + 80);
  out = m2.evaluate([row({ ticker: 'M2', price: 1.15, grade: 'A+' })], [], T0 + 140);
  check('fast move <5 min after an A+ alert is folded away', out.length === 0);
}

console.log('News');
{
  const e = new OpportunityAlerts();
  const on = [row({ ticker: 'NWS' })];
  const n = (over: Partial<OpportunityNewsItem>): OpportunityNewsItem => ({
    ticker: 'NWS', source: 'finviz', title: 'NWS receives FDA approval for lead drug', url: 'https://x/1',
    published_at: new Date((T0 - 600) * 1000), ...over,
  });
  let out = e.evaluate(on, [n({})], T0);
  check('fresh headline on a screened ticker alerts', kinds(out, 'NWS').includes('news') && (out[0]?.news?.score ?? 0) > 0, JSON.stringify(out[0]?.news));
  out = e.evaluate(on, [n({})], T0 + 20);
  check('same URL again → quiet', out.length === 0);
  out = e.evaluate(on, [n({ url: 'https://y/1', source: 'yahoo', title: 'NWS Receives FDA Approval for Lead Drug!' })], T0 + 40);
  check('same headline from another source → quiet', out.length === 0);
  out = e.evaluate(on, [n({ url: 'https://x/old', title: 'NWS old story', published_at: new Date((T0 - 7200) * 1000) })], T0 + 60);
  check('headline published 2h before first sight → quiet', out.length === 0);
  out = e.evaluate(on, [n({ url: 'https://x/nodate', title: 'NWS undated', published_at: null })], T0 + 80);
  check('undated headline → quiet', out.length === 0);
  out = e.evaluate([], [n({ ticker: 'OFF', url: 'https://x/off', title: 'OFF signs merger agreement' })], T0 + 100);
  check('ticker not on screen → quiet…', out.length === 0);
  out = e.evaluate([row({ ticker: 'OFF' })], [n({ ticker: 'OFF', url: 'https://x/off', title: 'OFF signs merger agreement' })], T0 + 120);
  check('…but alerts once it is on screen (still fresh)', kinds(out, 'OFF').includes('news'));
}

console.log('Phone filter + seeding');
{
  const weak: OpportunityAlert = {
    id: 'x', ticker: 'W', kinds: ['news'], at: iso(T0), price: 1, change_pct: 20, grade: 'B', prev_grade: null,
    new_on_screen: false, move_pct: null, rel_vol_1min: null, float_m: null,
    news: { source: 'yahoo', title: 'W shares rise', url: 'u', published_at: iso(T0), score: 15, direction: 'neutral', type: 'other' },
  };
  check('weak news-only alert stays off the phone', phoneKinds(weak, () => false).length === 0);
  check('strong news reaches the phone', phoneKinds({ ...weak, news: { ...weak.news!, score: 60 } }, () => false).join() === 'news');
  check('a muted kind is dropped', phoneKinds({ ...weak, kinds: ['grade_aplus', 'news'] }, (k) => k === 'grade_aplus').length === 0);

  const e = new OpportunityAlerts();
  e.seed({ aplus: ['SEED'], urls: ['https://seen'] });
  let out = e.evaluate([row({ ticker: 'SEED', grade: 'A+' })], [], T0);
  check('A+ already alerted today (seeded) → quiet after a deploy', out.length === 0);
  out = e.evaluate([row({ ticker: 'SEED', grade: 'A+' })], [{
    ticker: 'SEED', source: 'finviz', title: 'Seeded', url: 'https://seen', published_at: new Date(T0 * 1000),
  }], T0 + 20);
  check('stored URL (seeded) → quiet after a deploy', out.length === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
