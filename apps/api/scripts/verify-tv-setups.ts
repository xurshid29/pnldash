// Regression for the 📐 TradingView VWAP-setup webhook (services/tv-setups.ts).
// Run:  npx tsx scripts/verify-tv-setups.ts
// Pins the message contract with the Pine script (apps/web/src/tv/
// mvwap-bb-setup.pine) and the duplicate gate that keeps the phone usable.
// Since script v27 (2026-10-28) the script has two setups, PULLBACK and the VWAP +
// BB cross; RECLAIM (FORMING / READY / GO) and the BB breakout (TOUCH / BREAKOUT /
// TRIGGERED) were removed, and their messages are rejected. v28 replaced the VB break
// (LEVEL / BREAK) with RETEST and added `vwap 30s|chart` to every message.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  parseTvMessage, normTicker, TvSetupGate, TV_SETUP, formatTvSetupAlert, lineTokens,
  parseStageList, DEFAULT_ANNOUNCED, TV_STAGE_ORDER, pastCap, gradeAtLeast, type TvSetupSignal,
} from '../src/services/tv-setups.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('Parse — common fields');
{
  const s = parseTvMessage('PULLBACK AIXI 1.48 | sVWAP 1.45 (+2.1%) | mVWAP 1.57 (-5.7%) | line session | touch 1 | day high +41% | tf 1');
  check('parses', s != null);
  check('stage/ticker/price', s?.stage === 'pullback' && s.ticker === 'AIXI' && s.price === 1.48, JSON.stringify(s));
  check('levels', s?.svwap === 1.45 && s.spx_pct === 2.1 && s.mvwap === 1.57 && s.px_pct === -5.7, JSON.stringify(s));
  check('day gain + timeframe', s?.day_gain === 41 && s.tf === '1', JSON.stringify(s));
  const sub = parseTvMessage('PULLBACK NIVF 0.1650 | sVWAP 0.1601 (+3.1%) | mVWAP 0.1880 (-12.2%) | line session | touch 1 | day high +38% | tf 2');
  check('sub-dollar prices keep their decimals', sub?.price === 0.165 && sub.mvwap === 0.188 && sub.svwap === 0.1601, JSON.stringify(sub));
  const minus = parseTvMessage('BROKEN AIXI 1.40 | sVWAP 1.45 (−3.4%) | mVWAP 1.57 (−10.8%) | line session | touch 1 | tf 1');
  check('unicode minus reads as negative', minus?.spx_pct === -3.4 && minus.px_pct === -10.8, JSON.stringify(minus));
  const ah = parseTvMessage('PULLBACK AMOD 1.38 | sVWAP 1.35 (+2.2%) | line session | touch 1 | day high +20% | ah +34% | tf 1');
  check('v3 after-hours gain', ah?.ah_gain === 34 && ah.day_gain === 20, JSON.stringify(ah));
  check('no after-hours gain outside after hours', s?.ah_gain === null, JSON.stringify(s));
  const neg = parseTvMessage('BROKEN MEDS 4.47 | sVWAP 4.6 (-2.8%) | line session | touch 2 | day high -2% | tf 1');
  check('negative day high', neg?.day_gain === -2, JSON.stringify(neg));
  const legacyNeg = parseTvMessage('BROKEN MEDS 4.47 | sVWAP 4.6 (-2.8%) | line session | touch 2 | day high +-2% | tf 1');
  check('the old "+-2%" spelling reads as -2', legacyNeg?.day_gain === -2, JSON.stringify(legacyNeg));
}

console.log('Parse — JSON and prefixes');
{
  const bare = parseTvMessage('held nxl');
  check('lower-case stage, no price', bare?.stage === 'held' && bare.ticker === 'NXL' && bare.price == null, JSON.stringify(bare));
  const pre = parseTvMessage('PULLBACK NASDAQ:AIXI 1.48');
  check('exchange prefix stripped', pre?.ticker === 'AIXI', JSON.stringify(pre));
  const js = parseTvMessage('{"stage":"PULLBACK","ticker":"amex:soar","price":0.31,"svwap":0.30,"line":"session","tf":2}');
  check('JSON text body', js?.stage === 'pullback' && js.ticker === 'SOAR' && js.price === 0.31 && js.svwap === 0.3 && js.tf === '2', JSON.stringify(js));
  const obj = parseTvMessage({ stage: 'cross', ticker: 'MEDS', price: '4.41' });
  check('pre-parsed JSON object', obj?.stage === 'cross' && obj.ticker === 'MEDS' && obj.price === 4.41, JSON.stringify(obj));
}

console.log('Parse — rejects');
{
  check('unknown stage', parseTvMessage('BUY AIXI 1.48') == null);
  check('empty body', parseTvMessage('') == null && parseTvMessage(undefined) == null && parseTvMessage({}) == null);
  check('malformed JSON', parseTvMessage('{"stage":"PULLBACK",') == null);
  check('implausible ticker', parseTvMessage('PULLBACK 123ABC 1.0') == null && normTicker('TOO-LONG-TICKER') == null);
  check('array body', parseTvMessage(['PULLBACK', 'AIXI']) == null);
  // v27 removed RECLAIM and the BB breakout: a stale alert's message is unrecognised (400).
  for (const m of ['FORMING NIVF 0.165 | mVWAP 0.188 (-12.2%) | basis 0.169 (-10.1%) | tf 2',
    'READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1 | path base',
    'GO NIVF 0.1961 | mVWAP 0.188 (4.3%) | basis 0.169 (-10.1%) | tf 1 | via reclaim', 'READY AIXI 1.48 | tf 1',
    'TOUCH NWGL 0.1302 | upper 0.1305 (-0.2%) | tf 30S',
    'BREAKOUT XLAB 2.38 | upper 2.33 (+2.1%) | trigger 2.41 | stop 2.25 | tf 30S',
    'TRIGGERED XLAB 2.42 | upper 2.35 (+3.0%) | trigger 2.41 | stop 2.25 | tf 30S']) {
    check(`v27: rejects ${m.split(' ')[0]}`, parseTvMessage(m) == null);
  }
  check('v27: rejects their JSON too', parseTvMessage({ stage: 'go', ticker: 'NXL' }) == null && parseTvMessage({ stage: 'breakout', ticker: 'X' }) == null);
  // v28 replaced the VB break with RETEST: a v25–v27 alert's LEVEL / BREAK is unrecognised too.
  check('v28: rejects LEVEL and BREAK', parseTvMessage('LEVEL TANH 12.48 | level 12.59 | stop 11.8 | line month | candle 10 | bb 2 | tf 30S') == null
    && parseTvMessage('BREAK TANH 12.6 | level 12.59 | stop 11.8 | line month | candle 10 | bb 2 | break 1 | tf 30S') == null
    && parseTvMessage({ stage: 'break', ticker: 'TANH' }) == null);
}

console.log('PULLBACK setup (v10)');
{
  const pb = parseTvMessage('PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | vol 0.6x | run -9.6% | tf 1');
  check('parses', pb?.stage === 'pullback' && pb.ticker === 'SAIQ' && pb.price === 6.2, JSON.stringify(pb));
  check('both lines', pb?.svwap === 6.16 && pb.spx_pct === 0.7 && pb.mvwap === 4.1 && pb.px_pct === 51.2, JSON.stringify(pb));
  check('line, touch, peak', pb?.line === 'session' && pb.touch === 2 && pb.peak_pct === 17, JSON.stringify(pb));
  check('context', pb?.day_gain === 336 && pb.vol_x === 0.6 && pb.run_pct === -9.6 && pb.tf === '1', JSON.stringify(pb));
  const br = parseTvMessage('BROKEN SAIQ 5.98 | sVWAP 6.15 (-2.8%) | mVWAP 4.1 (+45.9%) | line session | touch 2 | day high +336% | tf 1');
  check('BROKEN under the line', br?.stage === 'broken' && br.spx_pct === -2.8 && br.touch === 2 && br.peak_pct === null, JSON.stringify(br));
  const held = parseTvMessage('HELD VEEA 3.75 | sVWAP 3.9 (-3.8%) | mVWAP 3.41 (+10.0%) | line month | touch 1 | day high +98% | tf 2');
  check('HELD on the month line', held?.stage === 'held' && held.line === 'month' && held.px_pct === 10 && held.tf === '2', JSON.stringify(held));
  const both = parseTvMessage('PULLBACK NXL 7.01 | sVWAP 6.89 (+1.7%) | mVWAP 6.86 (+2.2%) | line both | touch 1 | peak +15% | day high +60% | tf 1');
  check('line both', both?.line === 'both' && both.touch === 1, JSON.stringify(both));
  const nan = parseTvMessage('PULLBACK X 1.00 | sVWAP 0.97 (+3.1%) | mVWAP NaN (NaN%) | line session | touch 1 | peak +22% | day high NaN% | tf 1');
  check('a NaN month line reads as null', nan?.mvwap === null && nan.px_pct === null && nan.svwap === 0.97 && nan.day_gain === null, JSON.stringify(nan));
  const js = parseTvMessage({ stage: 'pullback', ticker: 'SDEV', price: 6.31, svwap: 6.035, line: 'SESSION', touch: '1' });
  check('JSON body', js?.stage === 'pullback' && js.line === 'session' && js.touch === 1 && js.svwap === 6.035, JSON.stringify(js));

  const html = formatTvSetupAlert(pb!, 'NASDAQ:SAIQ', { change_pct: 340, grade: 'B+', float_m: 3.1 });
  check('Telegram: names the line', html.includes('<b>PULLBACK</b>') && html.includes('back near the session VWAP after the run — be ready'), html);
  check('Telegram: touch + run', html.includes('touch 2') && !html.includes('(first)') && html.includes('ran +17% above the line first'), html);
  check('Telegram: both levels, no basis', html.includes('sVWAP $6.16 (+0.7%)') && html.includes('mVWAP $4.10 (+51.2%)') && !html.includes('basis'), html);
  const first = formatTvSetupAlert(both!, 'NASDAQ:NXL', null);
  check('Telegram: first touch says so', first.includes('touch 1 (first)') && first.includes('session + month VWAP'), first);
  const brHtml = formatTvSetupAlert(br!, 'NASDAQ:SAIQ', null);
  check('Telegram: BROKEN', brHtml.includes('<b>BROKEN</b>') && brHtml.includes('closed under the session VWAP — setup broken') && !brHtml.includes('ran +'), brHtml);
  const heldHtml = formatTvSetupAlert(held!, 'NASDAQ:VEEA', null);
  check('Telegram: HELD', heldHtml.includes('<b>HELD</b>') && heldHtml.includes('held — ran +10% from the pullback'), heldHtml);

  const T0 = 1_790_000_000;
  const g = new TvSetupGate();
  check('session PULLBACK notifies', g.admit(pb!, T0) === 'notify');
  check('same line + tf again within 2 min is a duplicate', g.admit(pb!, T0 + 20) === 'drop');
  check('a PULLBACK on another line a minute later is its own announcement', g.admit({ ...pb!, line: 'month' }, T0 + 60) === 'notify');
  check('BROKEN is its own stage → stored quietly (2026-10-05)', g.admit(br!, T0 + 70) === 'quiet');
}

console.log('Line combos (v14)');
{
  const pb3 = parseTvMessage('PULLBACK MI 5.31 | sVWAP 4.67 (+13.7%) | mVWAP 4.65 (+14.2%) | yVWAP 5.2 (+2.1%) | line year | touch 1 | peak +27% | day high +600% | tf 1');
  check('PULLBACK on the year line', pb3?.stage === 'pullback' && pb3.line === 'year' && pb3.yvwap === 5.2 && pb3.ypx_pct === 2.1 && pb3.peak_pct === 27, JSON.stringify(pb3));
  const all3 = parseTvMessage('BROKEN X 1.00 | sVWAP 1.01 (-1.0%) | mVWAP 1.02 (-2.0%) | yVWAP 1.01 (-1.0%) | line session+month+year | touch 1 | tf 30S');
  check('three lines at once', all3?.line === 'session+month+year' && all3.tf === '30S', JSON.stringify(all3));
  const js = parseTvMessage({ stage: 'pullback', ticker: 'MI', line: 'YEAR+session' });
  check('JSON line normalised to script order', js?.line === 'session+year', JSON.stringify(js));
  check('an unknown line part is rejected', parseTvMessage({ stage: 'pullback', ticker: 'MI', line: 'session+week' })?.line === null);
  check('lineTokens: legacy both, combos, no line',
    JSON.stringify(lineTokens('pullback', 'both')) === '["session","month"]'
      && JSON.stringify(lineTokens('broken', 'session+month+year')) === '["session","month","year"]'
      && JSON.stringify(lineTokens('pullback', null)) === '[]' && JSON.stringify(lineTokens('cross', null)) === '["session"]');
  const yHtml = formatTvSetupAlert(pb3!, 'AMEX:MI', null);
  check('Telegram: year-line PULLBACK names the line, year level first',
    yHtml.includes('back near the year VWAP after the run') && yHtml.indexOf('yVWAP $5.20') < yHtml.indexOf('sVWAP $4.67'), yHtml);
  const allHtml = formatTvSetupAlert(all3!, 'X', null);
  check('Telegram: three-line BROKEN', allHtml.includes('closed under the session + month + year VWAP'), allHtml);
}

console.log('Gate — duplicates, other timeframes, flood');
{
  const T0 = 1_790_000_000;
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'pullback', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, day_gain: 41, ah_gain: null, tf: '1',
    vol_x: null, run_pct: null, svwap: 1.45, spx_pct: 2.1, line: 'session', touch: 1, fails: 0, ...over,
  });
  const g = new TvSetupGate();
  check('first PULLBACK notifies', g.admit(sig(), T0) === 'notify');
  check('same PULLBACK + tf within 2 min is a duplicate', g.admit(sig(), T0 + 30) === 'drop');
  check('same PULLBACK on 30s within 5 min is logged only', g.admit(sig({ tf: '30S' }), T0 + 60) === 'log');
  check('another ticker is independent', g.admit(sig({ ticker: 'NXL' }), T0 + 95) === 'notify');
  check('PULLBACK again after the dup window (1m) is logged, not re-announced', g.admit(sig(), T0 + TV_SETUP.dup_sec + 10) === 'log');
  check('PULLBACK after the merge window announces again', g.admit(sig(), T0 + TV_SETUP.notify_merge_sec + 140) === 'notify');
  const flood = new TvSetupGate();
  let verdicts: string[] = [];
  for (let i = 0; i < TV_SETUP.max_per_min + 5; i++) verdicts.push(flood.admit(sig({ ticker: `T${i}` }), T0));
  check('flood guard trips after max_per_min', verdicts.slice(0, TV_SETUP.max_per_min).every((v) => v === 'notify') && verdicts.slice(TV_SETUP.max_per_min).every((v) => v === 'flood'));
  verdicts = [flood.admit(sig({ ticker: 'LATER' }), T0 + 61)];
  check('…and recovers a minute later', verdicts[0] === 'notify');
}

console.log('Gate — quiet stages (2026-10-05)');
{
  const T0 = 1_791_200_000;
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'broken', ticker: 'RETO', price: 1.95, mvwap: 2.05, px_pct: -4.9, day_gain: 30, ah_gain: null,
    tf: '1', vol_x: null, run_pct: null, svwap: 2.0, spx_pct: -2.5, line: 'session', touch: 1, ...over,
  });
  check('quiet stages are BROKEN / HELD', JSON.stringify(TV_SETUP.quiet_stages) === '["broken","held"]');
  const g = new TvSetupGate();
  check('BROKEN is quiet', g.admit(sig(), T0) === 'quiet');
  check('…its 30s copy is logged as a copy', g.admit(sig({ tf: '30S' }), T0 + 40) === 'log');
  check('HELD is quiet', g.admit(sig({ stage: 'held', line: 'month' }), T0 + 100) === 'quiet');
  check('PULLBACK still announces', g.admit(sig({ stage: 'pullback' }), T0 + 200) === 'notify');
}

console.log('Gate — the 5-min PULLBACK limit counts per line (2026-10-05)');
{
  const T0 = 1_791_227_851;   // 2026-10-05 15:17:31 ET, MI's year-line PULLBACK
  const pb = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'pullback', ticker: 'MI', price: 5.86, mvwap: null, px_pct: null, day_gain: null, ah_gain: null,
    tf: '30S', vol_x: null, run_pct: null, line: 'year', touch: 6, ...over,
  });
  const g = new TvSetupGate();
  check('MI 15:17 year-line PULLBACK notifies', g.admit(pb(), T0) === 'notify');
  check('…its 1m copy is logged', g.admit(pb({ tf: '1' }), T0 + 31) === 'log');
  check('MI 15:21 BROKEN on the year line is quiet', g.admit(pb({ stage: 'broken', tf: '1' }), T0 + 214) === 'quiet');
  check('MI 15:21 session-line PULLBACK 3½ min later notifies (it was logged before)',
    g.admit(pb({ line: 'session', tf: '1', price: 5.61, touch: 3 }), T0 + 214) === 'notify');
  check('…and its 30s copy is logged', g.admit(pb({ line: 'session', price: 5.61, touch: 3 }), T0 + 214) === 'log');

  const a = new TvSetupGate();
  const apus = (over: Partial<TvSetupSignal>) => pb({ ticker: 'APUS', ...over });
  check('APUS 08:04 session+month PULLBACK notifies', a.admit(apus({ line: 'session+month', tf: '1' }), T0) === 'notify');
  check('…the 2m alert\'s session-only copy is the same level → logged', a.admit(apus({ line: 'session', tf: '2' }), T0) === 'log');
  check('…a month-line PULLBACK 4 min later is still that level → logged', a.admit(apus({ line: 'month', tf: '2' }), T0 + 240) === 'log');
  check('…the year line within those 5 min is a new level → notifies', a.admit(apus({ line: 'year', tf: '2' }), T0 + 250) === 'notify');
  check('…the month line again after the window notifies', a.admit(apus({ line: 'month', tf: '2' }), T0 + 600) === 'notify');
}

console.log('Gate — the ⚙ stage switches (2026-10-06)');
{
  const T0 = 1_791_276_000;   // 2026-10-06 04:40 ET
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'pullback', ticker: 'NAUT', price: 2, mvwap: 2.1, px_pct: -4.8, day_gain: 25, ah_gain: null,
    tf: '1', vol_x: null, run_pct: null, svwap: 1.95, spx_pct: 2.6, line: 'session', touch: 1, fails: 0, ...over,
  });
  check('default switches: PULLBACK, CROSS, RETEST on', JSON.stringify(DEFAULT_ANNOUNCED) === '["pullback","cross","retest"]');
  check('parseStageList keeps known stages in menu order, drops the rest (v27: a saved go / ready / forming too)',
    JSON.stringify(parseStageList(['held', 'GO', 'bogus', 'pullback', 'ready', 7])) === '["pullback","held"]'
      && parseStageList('pullback') === null && JSON.stringify(parseStageList([])) === '[]');
  check('menu order lists the five stages (v28: RETEST in BREAK\'s place; a saved "break" is dropped)',
    JSON.stringify(TV_STAGE_ORDER) === '["pullback","cross","retest","broken","held"]'
      && JSON.stringify(parseStageList(['pullback', 'cross', 'break'])) === '["pullback","cross"]');
  const g = new TvSetupGate();
  g.setAnnounced(['cross']);
  check('PULLBACK switched off → quiet', g.admit(sig(), T0) === 'quiet' && !g.announces('pullback'));
  g.setAnnounced(['pullback', 'held']);
  check('PULLBACK back on → the next one (another line) notifies', g.admit(sig({ line: 'month' }), T0 + 60) === 'notify');
  check('HELD switched on → announces', g.admit(sig({ stage: 'held' }), T0 + 2100) === 'notify');
  check('BROKEN still off → quiet', g.admit(sig({ stage: 'broken' }), T0 + 2200) === 'quiet');
  check('announcedStages() reports menu order', JSON.stringify(g.announcedStages()) === '["pullback","held"]');
  g.setAnnounced([]);
  check('everything off → every first copy is quiet', g.admit(sig({ line: 'year' }), T0 + 2300) === 'quiet');
}

console.log('PULLBACK cap moved to the server (v16, 2026-10-10)');
{
  const msg = 'PULLBACK WFF 3.53 | sVWAP 3.12 (+13.1%) | mVWAP 3.11 (+13.5%) | yVWAP 3.39 (+4.1%) | line year | touch 4 | fails 2 | peak +45% | day high +120% | tf 30S';
  const w = parseTvMessage(msg);
  check('parses fails', w?.fails === 2 && w.touch === 4 && w.line === 'year' && w.peak_pct === 45, JSON.stringify(w));
  check('JSON fails', parseTvMessage({ stage: 'pullback', ticker: 'WFF', line: 'year', touch: 4, fails: 2 })?.fails === 2);
  const old = parseTvMessage('PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | tf 1');
  check('a v10–v15 message has no fails', old?.fails === null, JSON.stringify(old));
  check('past the cap: PULLBACK with 2 failed before', pastCap(w!) && !pastCap({ ...w!, fails: 1 }) && !pastCap(old!)
    && !pastCap({ ...w!, stage: 'broken' }), JSON.stringify(TV_SETUP));
  check('cap defaults: 2 failures, B+ exemption', TV_SETUP.pb_cap === 2 && TV_SETUP.pb_cap_exempt === 'B+');
  check('gradeAtLeast follows the ladder', gradeAtLeast('A+', 'B+') && gradeAtLeast('B+', 'B+') && !gradeAtLeast('B', 'B+')
    && !gradeAtLeast(null, 'B+') && !gradeAtLeast('?', 'B+'));

  const T0 = 1_791_563_700;   // 2026-10-09 12:35 ET
  const g = new TvSetupGate();
  check('past the cap, not exempt → quiet (stored, no ping)', g.admit(w!, T0) === 'quiet');
  check('…its 1m copy is logged', g.admit({ ...w!, tf: '1' }, T0 + 30) === 'log');
  const g2 = new TvSetupGate();
  check('past the cap, B+ on Momentum → announces', g2.admit(w!, T0, true) === 'notify');
  const g3 = new TvSetupGate();
  check('1 failed before → announces as before', g3.admit({ ...w!, fails: 1 }, T0) === 'notify');
  check('a pre-v16 message (no fails) is never capped here', new TvSetupGate().admit(old!, T0) === 'notify');
  check('BROKEN/HELD keep their stage switch', new TvSetupGate().admit({ ...w!, stage: 'broken' }, T0) === 'quiet');

  const ex = formatTvSetupAlert(w!, 'NASDAQ:WFF', { change_pct: 110, grade: 'A-', float_m: 2.1 });
  check('Telegram: says why a capped pullback was sent', ex.includes('touch 4') && ex.includes('2 failed before — past the cap, sent for grade A-'), ex);
  const one = formatTvSetupAlert({ ...w!, fails: 1 }, 'NASDAQ:WFF', null);
  check('Telegram: 1 failed before', one.includes('1 failed before') && !one.includes('past the cap'), one);
  const zero = formatTvSetupAlert({ ...w!, fails: 0, touch: 1 }, 'NASDAQ:WFF', null);
  check('Telegram: no failures, no mention', !zero.includes('failed before'), zero);
}

console.log('Telegram format');
{
  const html = formatTvSetupAlert(
    { stage: 'pullback', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, day_gain: 41, ah_gain: 34, tf: '1',
      vol_x: null, run_pct: null, svwap: 1.45, spx_pct: 2.1, line: 'session', touch: 1, fails: 0 },
    'NASDAQ:AIXI',
    { change_pct: 21.8, grade: 'B+', float_m: 3.2 },
  );
  check('headline', html.includes('<b>PULLBACK</b>') && html.includes('<b>AIXI</b>') && html.includes('$1.48'), html);
  check('levels line', html.includes('sVWAP $1.45 (+2.1%)') && html.includes('mVWAP $1.57 (-5.7%)'), html);
  check('context line', html.includes('day high +41%') && html.includes('now +21.8%') && html.includes('grade B+') && html.includes('tf 1'), html);
  check('on Momentum → ⭐ priority line', html.startsWith('⭐ ') && html.includes('⭐ <b>on Momentum</b> · grade B+'), html);
  check('chart link is exchange-qualified', html.includes('symbol=NASDAQ%3AAIXI'), html);
  check('after-hours gain shown', html.includes('after hours +34%'), html);
  const bare = formatTvSetupAlert({ stage: 'held', ticker: 'NXL', price: null, mvwap: null, px_pct: null, day_gain: null, ah_gain: null, tf: null, vol_x: null, run_pct: null }, 'NXL', null);
  check('off Momentum → no star, says so', !bare.includes('⭐') && bare.includes('not on our Momentum list'), bare);
  check('a bare message renders without levels', bare.includes('<b>HELD</b>') && !bare.includes('VWAP $') && !bare.includes('undefined') && !bare.includes('null'), bare);
}

console.log('VWAP + BB cross (v21, 2026-10-20)');
{
  const msg = 'CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | upper 2.58 (+1.2%) | open 2.5 | candle 5 | bb 2 | cross 1 | day high +25% | vol 1.8x | tf 30S';
  const x = parseTvMessage(msg);
  check('CROSS parses', x?.stage === 'cross' && x.ticker === 'AIXI' && x.price === 2.61, JSON.stringify(x));
  check('…session VWAP and the band', x?.svwap === 2.47 && x.spx_pct === 5.7 && x.upper === 2.58 && x.upper_pct === 1.2, JSON.stringify(x));
  check('…candle open, timeframes, count', x?.candle_open === 2.5 && x.candle_tf === '5' && x.bb_tf === '2' && x.cross_n === 1, JSON.stringify(x));
  check('…day high, volume, alert timeframe', x?.day_gain === 25 && x.vol_x === 1.8 && x.tf === '30S', JSON.stringify(x));
  check('…a v21 message: no line (= the session line), no month VWAP', x?.line === null && x.mvwap === null
    && JSON.stringify(lineTokens('cross', null)) === '["session"]', JSON.stringify(x));
  const hour = parseTvMessage('CROSS WORX 3.9 | sVWAP 3.7 (+5.4%) | upper 3.85 (+1.3%) | open 3.62 | candle 60 | bb 45 | cross 2 | day high +6% | ah +3% | tf 30S');
  check('1h candles on a 45m band', hour?.candle_tf === '60' && hour.bb_tf === '45' && hour.cross_n === 2 && hour.ah_gain === 3, JSON.stringify(hour));
  check('a 30s band reads as "30S"', parseTvMessage('CROSS X 1.0 | candle 1 | bb 30s | cross 1 | tf 30S')?.bb_tf === '30S');
  // Field names a ticker could spell must not be read off the ticker (BlackBerry, Opendoor).
  const bb = parseTvMessage('CROSS BB 4.52 | sVWAP 4.4 (+2.7%) | upper 4.5 (+0.4%) | open 4.38 | candle 5 | bb 2 | cross 1 | tf 30S');
  check('ticker BB is not the band timeframe', bb?.ticker === 'BB' && bb.bb_tf === '2' && bb.price === 4.52, JSON.stringify(bb));
  const op = parseTvMessage('CROSS OPEN 2.31 | sVWAP 2.2 (+5.0%) | upper 2.3 (+0.4%) | open 2.18 | candle 5 | bb 2 | cross 3 | tf 30S');
  check('ticker OPEN is not the candle open', op?.ticker === 'OPEN' && op.candle_open === 2.18 && op.cross_n === 3, JSON.stringify(op));
  check('JSON cross', parseTvMessage({ stage: 'cross', ticker: 'NWGL', price: 0.15, candle_tf: '5', bb_tf: 2, cross_n: 1 })?.bb_tf === '2');
  check('CROSS is in the ⚙ menu and on by default', TV_STAGE_ORDER.includes('cross') && DEFAULT_ANNOUNCED.includes('cross'));

  const T0 = 1_792_166_400;   // 2026-10-16 11:20 ET
  const g = new TvSetupGate();
  check('CROSS announces', g.admit(x!, T0) === 'notify');
  check('…a re-delivery within 20 s is dropped', g.admit(x!, T0 + 10) === 'drop');
  // The 30s alert alone sends it: the next candle's cross a minute later is a new event,
  // not a copy to merge (PULLBACK merges for 5 min).
  const second = parseTvMessage(msg.replace('cross 1', 'cross 2'))!;
  check('…the next candle\'s cross 60 s later announces too', g.admit(second, T0 + 60) === 'notify');
  check(`past the cap (cross ${TV_SETUP.vb_cap + 1}) → quiet`,
    pastCap(parseTvMessage(msg.replace('cross 1', `cross ${TV_SETUP.vb_cap + 1}`))!)
      && g.admit(parseTvMessage(msg.replace('cross 1', `cross ${TV_SETUP.vb_cap + 1}`))!, T0 + 400) === 'quiet');
  check(`…cross ${TV_SETUP.vb_cap} still announces`, g.admit(parseTvMessage(msg.replace('cross 1', `cross ${TV_SETUP.vb_cap}`))!, T0 + 800) === 'notify');
  check('…a CROSS without a count (JSON) is never capped', !pastCap({ ...x!, cross_n: null }));
  const off = new TvSetupGate();
  off.setAnnounced(['pullback']);
  check('switched off in ⚙ → quiet', off.admit(x!, T0) === 'quiet');
  check('…PULLBACK unaffected', off.admit(parseTvMessage('PULLBACK AIXI 2.5 | sVWAP 2.47 (+1.2%) | line session | touch 1 | fails 0 | tf 1')!, T0 + 30, false, true) === 'notify');
  check('off Momentum → quiet (vb_momentum_only, 2026-10-20)', TV_SETUP.vb_momentum_only && new TvSetupGate().admit(x!, T0, false, false) === 'quiet');
  check('…on Momentum → announces', new TvSetupGate().admit(x!, T0, false, true) === 'notify');
  check(`…off Momentum but day high ≥ +${TV_SETUP.vb_fresh_gain}% → announces (a runner the screen hasn't caught yet, 2026-10-21)`,
    new TvSetupGate().admit({ ...x!, day_gain: TV_SETUP.vb_fresh_gain }, T0, false, false) === 'notify'
      && new TvSetupGate().admit({ ...x!, day_gain: 264 }, T0, false, false) === 'notify'
      && new TvSetupGate().admit({ ...x!, day_gain: TV_SETUP.vb_fresh_gain - 1 }, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...x!, day_gain: null }, T0, false, false) === 'quiet');
  check('…a fresh runner past the cap stays quiet', new TvSetupGate().admit({ ...x!, day_gain: 264, cross_n: TV_SETUP.vb_cap + 1 }, T0, false, false) === 'quiet');
  check('…off-list quiet doesn\'t use up the line: the same ticker on Momentum a candle later announces',
    (() => { const q = new TvSetupGate(); return q.admit(x!, T0, false, false) === 'quiet' && q.admit(second, T0 + 300, false, true) === 'notify'; })());

  const html = formatTvSetupAlert(x!, 'NASDAQ:AIXI', { change_pct: 24.1, grade: 'A', float_m: 5.3 });
  check('Telegram: headline', html.includes('⏫ <b>CROSS</b>') && html.includes('<b>AIXI</b>') && html.includes('$2.61'), html);
  check('Telegram: names both timeframes', html.includes('the 5m candle crossed over the session VWAP and the 2m BB upper band'), html);
  check('Telegram: count, open and levels', html.includes('cross 1 today (first)') && html.includes('opened $2.50')
    && html.includes('sVWAP $2.47 (+5.7%)') && html.includes('2m BB upper $2.58 (+1.2%)'), html);
  check('Telegram: Momentum, context, links', html.includes('⭐ <b>on Momentum</b> · grade A') && html.includes('day high +25%')
    && html.includes('volume 1.8× its last 20 candles') && html.includes('tf 30S') && html.includes('symbol=NASDAQ%3AAIXI'), html);
  const capHtml = formatTvSetupAlert(parseTvMessage('CROSS WORX 3.9 | candle 60 | bb 45 | cross 4 | tf 30S')!, 'NASDAQ:WORX', null);
  check('Telegram: 1h / 45m, past the cap, off Momentum', capHtml.includes('the 1h candle') && capHtml.includes('the 45m BB upper band')
    && capHtml.includes('cross 4 today — past the cap') && capHtml.includes('not on our Momentum list') && !capHtml.includes('null'), capHtml);

  // v22: the month and year lines, each with its own state; lines crossing on one bar are one message.
  const both = parseTvMessage('CROSS AIXI 2.61 | sVWAP 2.47 (+5.7%) | mVWAP 2.55 (+2.4%) | yVWAP 3.1 (-15.8%) | upper 2.58 (+1.2%) | open 2.5 | line session+month | candle 5 | bb 2 | cross 1 | day high +25% | vol 1.8x | tf 30S');
  check('v22 parses the line and all three VWAPs', both?.line === 'session+month' && both.svwap === 2.47 && both.mvwap === 2.55 && both.px_pct === 2.4
    && both.yvwap === 3.1 && both.ypx_pct === -15.8 && JSON.stringify(lineTokens('cross', both.line)) === '["session","month"]', JSON.stringify(both));
  const yr = parseTvMessage('CROSS MI 5.31 | sVWAP 4.67 (+13.7%) | mVWAP 4.65 (+14.2%) | yVWAP 5.2 (+2.1%) | upper 5.25 (+1.1%) | open 5.12 | line year | candle 5 | bb 2 | cross 1 | tf 30S');
  check('…a year-line cross', yr?.line === 'year' && JSON.stringify(lineTokens('cross', yr.line)) === '["year"]', JSON.stringify(yr));
  const gl = new TvSetupGate();
  const month1 = parseTvMessage('CROSS MI 5.31 | mVWAP 5.2 (+2.1%) | upper 5.25 (+1.1%) | line month | candle 5 | bb 2 | cross 1 | tf 30S')!;
  check('lines are separate events: a session cross, then a month cross 30 s later, both announce',
    gl.admit(parseTvMessage('CROSS MI 5.3 | sVWAP 5.1 (+3.9%) | upper 5.25 (+1.0%) | line session | candle 5 | bb 2 | cross 1 | tf 30S')!, T0) === 'notify'
      && gl.admit(month1, T0 + 30) === 'notify');
  check('…a re-delivery of the month cross drops', gl.admit(month1, T0 + 35) === 'drop');
  const yHtml = formatTvSetupAlert(yr!, 'NASDAQ:MI', null);
  check('Telegram: names the year line and lists it first', yHtml.includes('crossed over the year VWAP and the 2m BB upper band')
    && yHtml.indexOf('yVWAP $5.20 (+2.1%)') < yHtml.indexOf('2m BB upper $') && yHtml.indexOf('2m BB upper $') < yHtml.indexOf('sVWAP $4.67'), yHtml);
  check('Telegram: two lines', formatTvSetupAlert(both!, 'NASDAQ:AIXI', null).includes('crossed over the session + month VWAP'));
}

console.log('VB retest (v28, 2026-10-29)');
{
  const msg = 'RETEST AIOK 17.28 | stop 17.09 | sVWAP 17.1 (+1.1%) | mVWAP 14.2 (+21.7%) | line session | candle 5 | bb 45S | retest 1 | day high +46% | vwap 30s | tf 30S';
  const r = parseTvMessage(msg);
  check('RETEST parses', r?.stage === 'retest' && r.ticker === 'AIOK' && r.price === 17.28 && r.stop === 17.09 && r.retest_n === 1
    && r.line === 'session' && r.candle_tf === '5' && r.bb_tf === '45S' && r.day_gain === 46 && r.tf === '30S', JSON.stringify(r));
  check('…the lines and the VWAP source', r?.svwap === 17.1 && r.spx_pct === 1.1 && r.mvwap === 14.2 && r.vwap_src === '30s', JSON.stringify(r));
  check('…"vwap chart", and a message without it (before v28) is null',
    parseTvMessage(msg.replace('vwap 30s', 'vwap chart'))?.vwap_src === 'chart'
      && parseTvMessage('CROSS X 1.0 | sVWAP 0.98 (+2.0%) | candle 5 | bb 2 | cross 1 | tf 30S')?.vwap_src === null);
  check('…the sVWAP / mVWAP labels are not read as the source', parseTvMessage('PULLBACK X 1.0 | sVWAP 0.98 (+2.0%) | line session | touch 1 | tf 1')?.vwap_src === null);
  check('…JSON retest', parseTvMessage({ stage: 'retest', ticker: 'AIOK', stop: 17.09, retest: 2, vwap: 'chart' })?.retest_n === 2);
  check('…a CROSS has no retest count, a RETEST no cross count', parseTvMessage('CROSS X 1.0 | candle 5 | bb 2 | cross 1 | tf 30S')?.retest_n === null && r?.cross_n === null);
  check('…without a line it is the session line', JSON.stringify(lineTokens('retest', null)) === '["session"]');
  const T0 = 1_792_166_400;
  const g = new TvSetupGate();
  check('RETEST on Momentum announces', g.admit(r!, T0, false, true) === 'notify');
  check('…a re-delivery within 20 s drops', g.admit(r!, T0 + 5, false, true) === 'drop');
  check('…off Momentum: quiet under +30%, announced at +46% (fresh runner)',
    new TvSetupGate().admit({ ...r!, day_gain: 20 }, T0, false, false) === 'quiet' && new TvSetupGate().admit(r!, T0, false, false) === 'notify');
  check(`…past the cap (retest ${TV_SETUP.vb_cap + 1}) quiet`, pastCap({ ...r!, retest_n: TV_SETUP.vb_cap + 1 })
    && new TvSetupGate().admit({ ...r!, retest_n: TV_SETUP.vb_cap + 1 }, T0, false, true) === 'quiet');
  const off = new TvSetupGate();
  off.setAnnounced(['pullback', 'cross']);
  check('…its own ⚙ switch (a list saved before v28 → quiet until ticked)', off.admit(r!, T0, false, true) === 'quiet');
  const html = formatTvSetupAlert(r!, 'NASDAQ:AIOK', { change_pct: 46, grade: 'A', float_m: 1.2 });
  check('Telegram: RETEST headline and what happened', html.includes('🔁 <b>RETEST</b>') && html.includes('<b>AIOK</b>') && html.includes('$17.28')
    && html.includes('back at the session VWAP after the 5m VB candle (45s BB) and bounced'), html);
  check('Telegram: stop, count, levels, Momentum', html.includes('stop $17.09 (-1.1%, under the pullback low)') && html.includes('retest 1 today (first)')
    && html.includes('sVWAP $17.10 (+1.1%)') && html.includes('⭐ <b>on Momentum</b>') && !html.includes('null') && !html.includes('undefined'), html);
}

console.log('Contract — the Pine script still emits what the parser reads');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const pine = readFileSync(resolve(here, '../../web/src/tv/mvwap-bb-setup.pine'), 'utf8');
  for (const part of ['" | mVWAP "', '" | day high "', '" | ah "', '" | tf "', '" | vol "', '" | run "',
    '"PULLBACK"', '"BROKEN"', '"HELD"', '" | sVWAP "', '" | line "', '" | touch "', '" | peak +"', '"session"', '"month"',
    '" | yVWAP "', '"year"', 'timeframe.change("M") or firstBar', 'firstBar = na(hlc3[1])',
    // v14: the year line from this year's hourly bars + today's chart bars; merged lines are named together
    'request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", yearBefore()', 'timeframe.change("12M")',
    'pbJoin(names, "year")',
    // v15: the day's PULLBACK cap counts failed pullbacks, not every touch
    's.fails < pbMax', 's.fails := s.fails + 1',
    // v16: no cap in the script by default; each PULLBACK says how many failed before it
    'pbMax == 0 or s.fails < pbMax', '" | fails "', 'fails := math.min(fails, pbY.fails)', 'pbCapMark',
    // v21: the VWAP + BB cross from the 30s alert, drawn on the candle's chart; the setup switches
    '"CROSS "', '" | upper "', '" | open "', '" | candle "', '" | bb "', '" | cross "',
    'vbSend = vbOk and timeframe.period == vbTf', 'timeframe.change(vbCandleTf)', 'timeframe.change(vbBbTf)',
    // v23: the lines as they stand at the 30s close (what the chart draws), the day's first candle counts
    'cOpen <= math.max(ln, up) and cOpen <= math.min(ln, up) * (1 + vbTol / 100) and close > ln and close > up',
    'vbCan(vVw, vBand, vOpen, vSFired)',
    'request.security_lower_tf(syminfo.tickerid, vbLower ? vbTf : timeframe.period, vbView())',
    // v22: the month and year lines from hourly bars + today's candles, per-line state, joined names
    'request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", vbAnchors(), lookahead = barmerge.lookahead_on)',
    'vbCan(vMw, vBand, vOpen, vMFired)', 'vbCan(vYw, vBand, vOpen, vYFired)',
    '" | line " + names', 'names := pbJoin(names, "month")',
    // v24: the month and year lines' PULLBACK may touch on the bar's low (a trial); the session line keeps the close
    'pbLowMY', 'float reach = useLow ? low : close', 'pbS.step(svwap, gainer, false)', 'pbM.step(mvwap, gainer, pbLowMY)',
    'pbY.step(yvwap, gainer, pbLowMY)',
    // v26: the cancel is a candle's close under the lowest crossed line (the VB candle's own included), not a 30s close
    'vbLowest(vRtS, vRtM, vRtY, vPrevVw, vPrevMw, vPrevYw)', 'if not na(vLnC) and vClose < vLnC', 'vPrevVw := vVw',
    // v27: two setups; the operator's settings are the defaults (gainer 10%, VB 5m candle, 45s band)
    'if pbOn and inWindow', 'input.float(10.0, "Up at least %', 'input.timeframe("5",     "VB: candle timeframe',
    'input.timeframe("45S",   "VB: BB timeframe (the band)"', '"VB: BB timeframe (the band)"',
    // v28: RETEST (the operator's entry) in the VB break's place, the 30s-bar VWAP option, the operator's tolerance 0
    'Script version: v28', 'alert(vbRtMsg(), alert.freq_once_per_bar_close)', '"RETEST "', '" | stop "', '" | retest "',
    'low <= vRtLine * (1 + vbRtNear / 100)', 'close > vRtLine and close > open', 'vRtStop  := vRtLow - syminfo.mintick',
    'vbHighest(vRtS, vRtM, vRtY, vVw, vMw, vYw)', 'vbRtWait > 0 and vRtAge >= vbRtWait', 'text = "RT"',
    '" | vwap " + (use30 ? "30s" : "chart")', 'options = ["30s bars", "Chart bars"]',
    'request.security_lower_tf(syminfo.tickerid, lower30 ? "30S" : timeframe.period, [hlc3 * volume, volume])',
    'float vTPV    = use30 ? vPV30 :', 'svwap = lower30 ?', 'input.float(0.0,         "VB: the candle may open up to %',
    'size = size.tiny, display = display.none']) {
    check(`script emits ${part}`, pine.includes(part));
  }
  check('v26: no 30s-close cancel of the VB level left', !pine.includes('close < vLvLine'));
  // v28: the VB break (LEVEL / BREAK) is gone; the new inputs went last (after vbShow).
  for (const gone of ['"LEVEL"', '"BREAK"', 'vbLvMsg', '" | level "', '" | break "', 'text = "BRK"']) {
    check(`v28: script no longer has ${gone}`, !pine.includes(gone));
  }
  const at = (x: string) => pine.indexOf(x);
  check('v28: the new inputs come after the last v27 one', at('vbShow     = input.bool') > 0 && at('vbShow     = input.bool') < at('vwSrc      = input.string')
    && at('vwSrc      = input.string') < at('vbRtNear   = input.float') && at('vbRtNear   = input.float') < at('vbRtWait   = input.int'));
  check('v28: the retest switches sit in the VB break\'s old places (same order around them)',
    at('vbYear     = input.bool') < at('vbRtOn     = input.bool') && at('vbRtOn     = input.bool') < at('vbRtCancel = input.bool')
      && at('vbRtCancel = input.bool') < at('vbTf       = input.timeframe'));
  // v27 removed RECLAIM and the BB breakout: none of their messages or inputs are left.
  for (const gone of ['"FORMING"', '"READY"', '"GO"', '"TOUCH"', '"BREAKOUT"', '"TRIGGERED"', '" | basis "', '" | path "', '" | via "',
    '" | trigger "', '" | run30 +"', '" | early +"', 'rcOn', 'boOn', 'reclaimConds', 'alertcondition(']) {
    check(`v27: script no longer has ${gone}`, !pine.includes(gone));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll tv-setup checks passed');
