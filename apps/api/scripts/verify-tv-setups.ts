// Regression for the 📐 TradingView VWAP-setup webhook (services/tv-setups.ts).
// Run:  npx tsx scripts/verify-tv-setups.ts
// Pins the message contract with the Pine script (apps/web/src/tv/
// mvwap-bb-setup.pine) and the duplicate gate that keeps the phone usable.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  parseTvMessage, normTicker, TvSetupGate, TV_SETUP, formatTvSetupAlert, goStrength, lineTokens,
  parseStageList, DEFAULT_ANNOUNCED, TV_STAGE_ORDER, pastCap, gradeAtLeast, type TvSetupSignal,
} from '../src/services/tv-setups.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('Parse — the Pine alert() message');
{
  const s = parseTvMessage('READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1');
  check('parses', s != null);
  check('stage/ticker/price', s?.stage === 'ready' && s.ticker === 'AIXI' && s.price === 1.48, JSON.stringify(s));
  check('levels', s?.mvwap === 1.57 && s.px_pct === -5.7 && s.basis === 1.49 && s.basis_pct === -5.1, JSON.stringify(s));
  check('day gain + timeframe', s?.day_gain === 41 && s.tf === '1', JSON.stringify(s));
  const sub = parseTvMessage('FORMING NIVF 0.1650 | mVWAP 0.1880 (-12.2%) | basis 0.1690 (-10.1%) | day high +38% | tf 2');
  check('sub-dollar prices keep their decimals', sub?.price === 0.165 && sub.mvwap === 0.188 && sub.basis_pct === -10.1, JSON.stringify(sub));
  const go = parseTvMessage('GO VEEA 3.34 | mVWAP 3.21 (4.0%) | basis 3.22 (0.3%) | day high +43% | tf 30S');
  check('GO with price above the line', go?.stage === 'go' && go.px_pct === 4 && go.basis_pct === 0.3 && go.tf === '30S', JSON.stringify(go));
  const minus = parseTvMessage('READY AIXI 1.48 | mVWAP 1.57 (−5.7%) | basis 1.49 (−5.1%) | day high +41% | tf 1');
  check('unicode minus reads as negative', minus?.px_pct === -5.7 && minus.basis_pct === -5.1, JSON.stringify(minus));
  check('a v1 message has no path', s?.path === null, JSON.stringify(s));
  const fast = parseTvMessage('READY MEDS 4.73 | mVWAP 4.94 (-4.3%) | basis 4.37 (-11.5%) | day high +0% | tf 1 | path fast');
  check('v2 fast path', fast?.path === 'fast' && fast.basis_pct === -11.5 && fast.day_gain === 0 && fast.tf === '1', JSON.stringify(fast));
  const base = parseTvMessage('FORMING VEEA 2.94 | mVWAP 3.06 (-4.0%) | basis 2.89 (-5.7%) | day high +101% | tf 2 | path base');
  check('v2 base path', base?.path === 'base' && base.stage === 'forming', JSON.stringify(base));
  const ah = parseTvMessage('READY AMOD 1.38 | mVWAP 1.42 (-2.5%) | basis 1.35 (-4.6%) | day high +20% | ah +34% | tf 1 | path base');
  check('v3 after-hours gain', ah?.ah_gain === 34 && ah.day_gain === 20 && ah.path === 'base' && ah.tf === '1', JSON.stringify(ah));
  check('no after-hours gain outside after hours', fast?.ah_gain === null, JSON.stringify(fast));
  const neg = parseTvMessage('FORMING MEDS 4.47 | mVWAP 4.94 (-9.5%) | basis 4.31 (-12.8%) | day high -2% | tf 1 | path fast');
  check('v3 negative day high', neg?.day_gain === -2, JSON.stringify(neg));
  const legacyNeg = parseTvMessage('FORMING MEDS 4.47 | mVWAP 4.94 (-9.5%) | basis 4.31 (-12.8%) | day high +-2% | tf 1 | path fast');
  check('v1/v2 "+-2%" reads as -2', legacyNeg?.day_gain === -2, JSON.stringify(legacyNeg));
  const goR = parseTvMessage('GO NIVF 0.1961 | mVWAP 0.188 (4.3%) | basis 0.169 (-10.1%) | day high +38% | tf 1 | via reclaim');
  check('v5 GO via reclaim', goR?.stage === 'go' && goR.go_via === 'reclaim' && goR.path === null, JSON.stringify(goR));
  const goC = parseTvMessage('GO AIXI 1.78 | mVWAP 1.565 (13.7%) | basis 1.565 (0.0%) | day high +48% | tf 1 | via cross');
  check('v5 GO via cross', goC?.go_via === 'cross', JSON.stringify(goC));
  check('READY has no GO trigger', ah?.go_via === null, JSON.stringify(ah));
}

console.log('Parse — fallbacks and JSON');
{
  const f = parseTvMessage('READY AIXI 1.48 | tf 1');
  check('alertcondition() fallback', f?.stage === 'ready' && f.ticker === 'AIXI' && f.price === 1.48 && f.tf === '1' && f.mvwap == null, JSON.stringify(f));
  const bare = parseTvMessage('go nxl');
  check('lower-case stage, no price', bare?.stage === 'go' && bare.ticker === 'NXL' && bare.price == null, JSON.stringify(bare));
  const pre = parseTvMessage('READY NASDAQ:AIXI 1.48');
  check('exchange prefix stripped', pre?.ticker === 'AIXI', JSON.stringify(pre));
  const js = parseTvMessage('{"stage":"READY","ticker":"amex:soar","price":0.31,"mvwap":0.336,"basis_pct":-4.2,"tf":2,"path":"FAST"}');
  check('JSON text body', js?.stage === 'ready' && js.ticker === 'SOAR' && js.price === 0.31 && js.basis_pct === -4.2 && js.tf === '2' && js.path === 'fast', JSON.stringify(js));
  const obj = parseTvMessage({ stage: 'forming', ticker: 'MEDS', price: '4.41' });
  check('pre-parsed JSON object', obj?.stage === 'forming' && obj.ticker === 'MEDS' && obj.price === 4.41, JSON.stringify(obj));
}

console.log('Parse — rejects');
{
  check('unknown stage', parseTvMessage('BUY AIXI 1.48') == null);
  check('empty body', parseTvMessage('') == null && parseTvMessage(undefined) == null && parseTvMessage({}) == null);
  check('malformed JSON', parseTvMessage('{"stage":"READY",') == null);
  check('implausible ticker', parseTvMessage('READY 123ABC 1.0') == null && normTicker('TOO-LONG-TICKER') == null);
  check('array body', parseTvMessage(['READY', 'AIXI']) == null);
}

console.log('GO strength (v9)');
{
  const go = parseTvMessage('GO NIVF 0.1961 | mVWAP 0.188 (4.3%) | basis 0.169 (-10.1%) | day high +38% | vol 3.2x | run +8.1% | tf 2 | via reclaim');
  check('parses volume and run-up', go?.vol_x === 3.2 && go.run_pct === 8.1 && go.go_via === 'reclaim', JSON.stringify(go));
  const neg = parseTvMessage('GO X 1.00 | vol 0.4x | run -2.5% | tf 1 | via cross');
  check('negative run-up', neg?.run_pct === -2.5 && neg.vol_x === 0.4, JSON.stringify(neg));
  const morning = new Date('2026-10-02T13:30:00Z');   // 09:30 ET
  const evening = new Date('2026-10-02T21:00:00Z');   // 17:00 ET
  const st = goStrength(go!, morning, true);
  check('all four checks pass', st?.score === 4 && st.max === 4 && st.morning && st.run_up === true && st.volume === true && st.on_momentum, JSON.stringify(st));
  const weak = goStrength(neg!, evening, false);
  check('weak GO scores 0/4', weak?.score === 0 && weak.max === 4 && !weak.morning, JSON.stringify(weak));
  const old = goStrength(parseTvMessage('GO X 1.00 | tf 1 | via cross')!, morning, false);
  check('v8 message: volume/run-up skipped (max 2)', old?.max === 2 && old.score === 1 && old.volume === null && old.run_up === null, JSON.stringify(old));
  check('no strength for READY', goStrength(parseTvMessage('READY X 1.00 | vol 3x | run +9%')!, morning, true) === null);
  const window = goStrength(go!, new Date('2026-10-02T14:31:00Z'), true);   // 10:31 ET — just past the window
  check('10:31 ET is outside the morning window', window?.morning === false && window.score === 3, JSON.stringify(window));
  const html = formatTvSetupAlert(go!, 'NASDAQ:NIVF', { change_pct: 30, grade: 'A+', float_m: 2 }, st);
  check('Telegram strength line', html.includes('GO strength 4/4') && html.includes('run-up +8.1% ✓') && html.includes('volume 3.2× ✓') && html.includes('on Momentum ✓'), html);
}

console.log('PULLBACK setup (v10)');
{
  const pb = parseTvMessage('PULLBACK SAIQ 6.2 | sVWAP 6.16 (+0.7%) | mVWAP 4.1 (+51.2%) | line session | touch 2 | peak +17% | day high +336% | vol 0.6x | run -9.6% | tf 1');
  check('parses', pb?.stage === 'pullback' && pb.ticker === 'SAIQ' && pb.price === 6.2, JSON.stringify(pb));
  check('both lines', pb?.svwap === 6.16 && pb.spx_pct === 0.7 && pb.mvwap === 4.1 && pb.px_pct === 51.2, JSON.stringify(pb));
  check('line, touch, peak', pb?.line === 'session' && pb.touch === 2 && pb.peak_pct === 17, JSON.stringify(pb));
  check('context', pb?.day_gain === 336 && pb.vol_x === 0.6 && pb.run_pct === -9.6 && pb.tf === '1' && pb.basis === null && pb.path === null, JSON.stringify(pb));
  const br = parseTvMessage('BROKEN SAIQ 5.98 | sVWAP 6.15 (-2.8%) | mVWAP 4.1 (+45.9%) | line session | touch 2 | day high +336% | tf 1');
  check('BROKEN under the line', br?.stage === 'broken' && br.spx_pct === -2.8 && br.touch === 2 && br.peak_pct === null, JSON.stringify(br));
  const held = parseTvMessage('HELD VEEA 3.75 | sVWAP 3.9 (-3.8%) | mVWAP 3.41 (+10.0%) | line month | touch 1 | day high +98% | tf 2');
  check('HELD on the month line', held?.stage === 'held' && held.line === 'month' && held.px_pct === 10 && held.tf === '2', JSON.stringify(held));
  const both = parseTvMessage('PULLBACK NXL 7.01 | sVWAP 6.89 (+1.7%) | mVWAP 6.86 (+2.2%) | line both | touch 1 | peak +15% | day high +60% | tf 1');
  check('line both', both?.line === 'both' && both.touch === 1, JSON.stringify(both));
  const nan = parseTvMessage('PULLBACK X 1.00 | sVWAP 0.97 (+3.1%) | mVWAP NaN (NaN%) | line session | touch 1 | peak +22% | day high NaN% | tf 1');
  check('a NaN month line reads as null', nan?.mvwap === null && nan.px_pct === null && nan.svwap === 0.97 && nan.day_gain === null, JSON.stringify(nan));
  check('reclaim messages carry no pullback fields', parseTvMessage('READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | tf 1')?.line === null);
  const js = parseTvMessage({ stage: 'pullback', ticker: 'SDEV', price: 6.31, svwap: 6.035, line: 'SESSION', touch: '1' });
  check('JSON body', js?.stage === 'pullback' && js.line === 'session' && js.touch === 1 && js.svwap === 6.035, JSON.stringify(js));
  check('no GO strength on a PULLBACK', goStrength(pb!, new Date('2026-10-05T08:08:00Z'), true) === null);

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

console.log('Reclaim setup on the year line (v11)');
{
  const yr = parseTvMessage('READY SAIQ 6.5 | mVWAP 4.1 (+58.5%) | yVWAP 7.0 (-7.1%) | basis 6.3 (-10.0%) | line year | day high +336% | vol 1.2x | run +4.0% | tf 1 | path base');
  check('parses', yr?.stage === 'ready' && yr.ticker === 'SAIQ' && yr.line === 'year' && yr.path === 'base', JSON.stringify(yr));
  check('year line + month line', yr?.yvwap === 7 && yr.ypx_pct === -7.1 && yr.mvwap === 4.1 && yr.px_pct === 58.5, JSON.stringify(yr));
  check('basis vs the setup line', yr?.basis === 6.3 && yr.basis_pct === -10, JSON.stringify(yr));
  const both = parseTvMessage('GO NXL 7.2 | mVWAP 7.0 (+2.9%) | yVWAP 7.05 (+2.1%) | basis 6.9 (-1.4%) | line both | day high +60% | tf 2 | via reclaim');
  check('GO on both lines', both?.stage === 'go' && both.line === 'both' && both.go_via === 'reclaim' && both.yvwap === 7.05, JSON.stringify(both));
  const month = parseTvMessage('READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | yVWAP 2.9 (-49.0%) | basis 1.49 (-5.1%) | line month | day high +41% | tf 1 | path base');
  check('month line with the year level along', month?.line === 'month' && month.ypx_pct === -49 && month.basis_pct === -5.1, JSON.stringify(month));
  const old = parseTvMessage('READY AIXI 1.48 | mVWAP 1.57 (-5.7%) | basis 1.49 (-5.1%) | day high +41% | tf 1 | path base');
  check('a v10 message has no line and no year level', old?.line === null && old.yvwap === null, JSON.stringify(old));

  const html = formatTvSetupAlert(yr!, 'NASDAQ:SAIQ', { change_pct: 140, grade: 'A', float_m: 3.1 });
  check('Telegram: names the year line', html.includes('entry zone · year VWAP'), html);
  check('Telegram: year level first', html.indexOf('yVWAP $7.00 (-7.1%)') >= 0 && html.indexOf('yVWAP $7.00') < html.indexOf('mVWAP $4.10'), html);
  const goY = formatTvSetupAlert({ ...yr!, stage: 'go', path: null, go_via: 'reclaim' }, 'NASDAQ:SAIQ', null);
  check('Telegram: GO reclaimed yVWAP', goY.includes('price reclaimed yVWAP'), goY);
  const goBoth = formatTvSetupAlert(both!, 'NASDAQ:NXL', null);
  check('Telegram: GO on both lines', goBoth.includes('price reclaimed mVWAP + yVWAP'), goBoth);
  const mHtml = formatTvSetupAlert(month!, 'NASDAQ:AIXI', null);
  check('Telegram: month line unchanged, year level after it', mHtml.includes('<i>entry zone</i>') && mHtml.indexOf('mVWAP $1.57') < mHtml.indexOf('yVWAP $2.90'), mHtml);

  const T0 = 1_790_100_000;
  const g = new TvSetupGate();
  check('month READY notifies', g.admit(month!, T0) === 'notify');
  check('year READY a minute later is logged, not dropped', g.admit({ ...month!, line: 'year' }, T0 + 60) === 'log');
}

console.log('Line combos (v14)');
{
  const pb3 = parseTvMessage('PULLBACK MI 5.31 | sVWAP 4.67 (+13.7%) | mVWAP 4.65 (+14.2%) | yVWAP 5.2 (+2.1%) | line year | touch 1 | peak +27% | day high +600% | tf 1');
  check('PULLBACK on the year line', pb3?.stage === 'pullback' && pb3.line === 'year' && pb3.yvwap === 5.2 && pb3.ypx_pct === 2.1 && pb3.peak_pct === 27, JSON.stringify(pb3));
  const all3 = parseTvMessage('BROKEN X 1.00 | sVWAP 1.01 (-1.0%) | mVWAP 1.02 (-2.0%) | yVWAP 1.01 (-1.0%) | line session+month+year | touch 1 | tf 30S');
  check('three lines at once', all3?.line === 'session+month+year' && all3.tf === '30S', JSON.stringify(all3));
  const my = parseTvMessage('GO NXL 7.2 | mVWAP 7.0 (+2.9%) | yVWAP 7.05 (+2.1%) | basis 6.9 (-1.4%) | line month+year | day high +60% | tf 1 | via reclaim');
  check('reclaim month+year (v14 spelling of "both")', my?.line === 'month+year' && my.go_via === 'reclaim', JSON.stringify(my));
  const js = parseTvMessage({ stage: 'pullback', ticker: 'MI', line: 'YEAR+session' });
  check('JSON line normalised to script order', js?.line === 'session+year', JSON.stringify(js));
  check('an unknown line part is rejected', parseTvMessage({ stage: 'pullback', ticker: 'MI', line: 'session+week' })?.line === null);
  check('lineTokens: legacy both, combos, a v10 reclaim message',
    JSON.stringify(lineTokens('pullback', 'both')) === '["session","month"]' && JSON.stringify(lineTokens('go', 'both')) === '["month","year"]'
      && JSON.stringify(lineTokens('broken', 'session+month+year')) === '["session","month","year"]' && JSON.stringify(lineTokens('ready', null)) === '["month"]');
  const yHtml = formatTvSetupAlert(pb3!, 'AMEX:MI', null);
  check('Telegram: year-line PULLBACK names the line, year level first',
    yHtml.includes('back near the year VWAP after the run') && yHtml.indexOf('yVWAP $5.20') < yHtml.indexOf('sVWAP $4.67'), yHtml);
  const myHtml = formatTvSetupAlert(my!, 'NASDAQ:NXL', null);
  check('Telegram: month+year GO', myHtml.includes('price reclaimed mVWAP + yVWAP'), myHtml);
  const allHtml = formatTvSetupAlert(all3!, 'X', null);
  check('Telegram: three-line BROKEN', allHtml.includes('closed under the session + month + year VWAP'), allHtml);
}

console.log('Gate — duplicates, other timeframes, flood');
{
  const T0 = 1_790_000_000;
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'ready', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, basis: 1.49, basis_pct: -5.1, day_gain: 41, ah_gain: null, tf: '1', path: 'base', go_via: null, ...over,
  });
  const g = new TvSetupGate();
  check('first READY notifies', g.admit(sig(), T0) === 'notify');
  check('same READY + tf within 2 min is a duplicate', g.admit(sig(), T0 + 30) === 'drop');
  check('same READY on 2m within 5 min is logged only', g.admit(sig({ tf: '2' }), T0 + 60) === 'log');
  check('GO is a new stage → notifies', g.admit(sig({ stage: 'go' }), T0 + 90) === 'notify');
  check('another ticker is independent', g.admit(sig({ ticker: 'NXL' }), T0 + 95) === 'notify');
  check('READY again after the dup window (1m) is logged, not re-announced', g.admit(sig(), T0 + TV_SETUP.dup_sec + 10) === 'log');
  check('READY after the merge window is a repeat on that line → quiet', g.admit(sig(), T0 + TV_SETUP.notify_merge_sec + 140) === 'quiet');
  const flood = new TvSetupGate();
  let verdicts: string[] = [];
  for (let i = 0; i < TV_SETUP.max_per_min + 5; i++) verdicts.push(flood.admit(sig({ ticker: `T${i}` }), T0));
  check('flood guard trips after max_per_min', verdicts.slice(0, TV_SETUP.max_per_min).every((v) => v === 'notify') && verdicts.slice(TV_SETUP.max_per_min).every((v) => v === 'flood'));
  verdicts = [flood.admit(sig({ ticker: 'LATER' }), T0 + 61)];
  check('…and recovers a minute later', verdicts[0] === 'notify');
}

console.log('Gate — quiet stages, READY once per line per day (2026-10-05)');
{
  const T0 = 1_791_200_000;   // 2026-10-05 07:33 ET; T0 + 10,700 s is still that day
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'ready', ticker: 'RETO', price: 1.95, mvwap: 2.05, px_pct: -4.9, basis: 1.94, basis_pct: -5.4, day_gain: 30, ah_gain: null,
    tf: '1', path: 'base', go_via: null, vol_x: null, run_pct: null, line: 'month', ...over,
  });
  check('quiet stages are FORMING / BROKEN / HELD', JSON.stringify(TV_SETUP.quiet_stages) === '["forming","broken","held"]');
  const g = new TvSetupGate();
  check('FORMING is quiet', g.admit(sig({ stage: 'forming' }), T0) === 'quiet');
  check('…its 30s copy is logged as a copy', g.admit(sig({ stage: 'forming', tf: '30S' }), T0 + 40) === 'log');
  check('the first month READY of the day notifies', g.admit(sig(), T0 + 600) === 'notify');
  check('…its 30s copy is logged', g.admit(sig({ tf: '30S' }), T0 + 630) === 'log');
  check('a month READY an hour later is quiet', g.admit(sig(), T0 + 4200) === 'quiet');
  check('…and its 30s copy is logged, not quiet', g.admit(sig({ tf: '30S' }), T0 + 4230) === 'log');
  check('the first year READY a minute after a quiet month READY notifies', g.admit(sig({ line: 'year' }), T0 + 4290) === 'notify');
  check('a month+year READY after both lines were announced is quiet', g.admit(sig({ line: 'month+year' }), T0 + 9000) === 'quiet');
  check('legacy "both" reads as month + year → quiet', g.admit(sig({ line: 'both' }), T0 + 9600) === 'quiet');
  check('a READY without a line (before v11) is the month line → quiet', g.admit(sig({ line: null }), T0 + 10200) === 'quiet');
  check('GO still announces', g.admit(sig({ stage: 'go' }), T0 + 10300) === 'notify');
  check('PULLBACK still announces', g.admit(sig({ stage: 'pullback', line: 'session' }), T0 + 10400) === 'notify');
  check('BROKEN and HELD are quiet', g.admit(sig({ stage: 'broken', line: 'session' }), T0 + 10500) === 'quiet'
    && g.admit(sig({ stage: 'held', line: 'month' }), T0 + 10600) === 'quiet');
  check("another ticker's first READY notifies", g.admit(sig({ ticker: 'QNME' }), T0 + 10700) === 'notify');
  check('the next ET day starts fresh', g.admit(sig(), T0 + 86_400) === 'notify');

  const seeded = new TvSetupGate();
  check('seeding reads stored lines (null = month, legacy both = month + year)',
    seeded.seedReady([{ ticker: 'RETO', line: 'month' }, { ticker: 'APUS', line: null }, { ticker: 'JAGX', line: 'both' }], T0) === 4);
  check('after a deploy, a READY announced earlier today stays quiet',
    seeded.admit(sig(), T0 + 60) === 'quiet' && seeded.admit(sig({ ticker: 'APUS' }), T0 + 70) === 'quiet'
      && seeded.admit(sig({ ticker: 'JAGX', line: 'year' }), T0 + 80) === 'quiet');
  check('…while a line not announced yet still notifies', seeded.admit(sig({ line: 'year' }), T0 + 400) === 'notify');
}

console.log('Gate — the 5-min PULLBACK limit counts per line (2026-10-05)');
{
  const T0 = 1_791_227_851;   // 2026-10-05 15:17:31 ET, MI's year-line PULLBACK
  const pb = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'pullback', ticker: 'MI', price: 5.86, mvwap: null, px_pct: null, basis: null, basis_pct: null, day_gain: null, ah_gain: null,
    tf: '30S', path: null, go_via: null, vol_x: null, run_pct: null, line: 'year', touch: 6, ...over,
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
  check('READY keeps one announcement per ticker per 5 min across lines',
    a.admit(apus({ stage: 'ready', line: 'month', tf: '1' }), T0 + 700) === 'notify'
      && a.admit(apus({ stage: 'ready', line: 'year', tf: '1' }), T0 + 760) === 'log');
}

console.log('Gate — the ⚙ stage switches (2026-10-06)');
{
  const T0 = 1_791_276_000;   // 2026-10-06 04:40 ET
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'ready', ticker: 'NAUT', price: 2, mvwap: 2.1, px_pct: -4.8, basis: 1.95, basis_pct: -7, day_gain: 25, ah_gain: null,
    tf: '1', path: 'base', go_via: null, vol_x: null, run_pct: null, line: 'month', ...over,
  });
  check('default switches: READY, GO, PULLBACK on', JSON.stringify(DEFAULT_ANNOUNCED) === '["ready","go","pullback"]');
  check('parseStageList keeps known stages in menu order, drops the rest',
    JSON.stringify(parseStageList(['held', 'GO', 'bogus', 'pullback', 7])) === '["go","pullback","held"]'
      && parseStageList('go') === null && JSON.stringify(parseStageList([])) === '[]');
  check('menu order lists all six stages', TV_STAGE_ORDER.length === 6 && new Set(TV_STAGE_ORDER).size === 6);
  const g = new TvSetupGate();
  g.setAnnounced(['go', 'pullback']);
  check('READY switched off → quiet, even the first of the day', g.admit(sig(), T0) === 'quiet' && !g.announces('ready'));
  check('GO still announces', g.admit(sig({ stage: 'go' }), T0 + 60) === 'notify');
  g.setAnnounced(['ready', 'go', 'pullback']);
  check('READY back on: the line was never announced, so the next READY notifies', g.admit(sig(), T0 + 900) === 'notify');
  check('…and a repeat after that is quiet again', g.admit(sig(), T0 + 2000) === 'quiet');
  g.setAnnounced(['ready', 'go', 'pullback', 'held']);
  check('HELD switched on → announces', g.admit(sig({ stage: 'held', line: 'session' }), T0 + 2100) === 'notify');
  check('FORMING still off → quiet', g.admit(sig({ stage: 'forming' }), T0 + 2200) === 'quiet');
  check('announcedStages() reports menu order', JSON.stringify(g.announcedStages()) === '["ready","go","pullback","held"]');
  g.setAnnounced([]);
  check('everything off → every first copy is quiet', g.admit(sig({ stage: 'pullback', line: 'year' }), T0 + 2300) === 'quiet');
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
    { stage: 'ready', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, basis: 1.49, basis_pct: -5.1, day_gain: 41, ah_gain: 34, tf: '1', path: 'fast', go_via: null },
    'NASDAQ:AIXI',
    { change_pct: 21.8, grade: 'B+', float_m: 3.2 },
  );
  check('headline', html.includes('<b>READY</b>') && html.includes('<b>AIXI</b>') && html.includes('$1.48'), html);
  check('levels line', html.includes('mVWAP $1.57 (-5.7%)') && html.includes('basis $1.49 (-5.1%)'), html);
  check('context line', html.includes('day high +41%') && html.includes('now +21.8%') && html.includes('grade B+') && html.includes('tf 1'), html);
  check('on Momentum → ⭐ priority line', html.startsWith('⭐ ') && html.includes('⭐ <b>on Momentum</b> · grade B+'), html);
  check('chart link is exchange-qualified', html.includes('symbol=NASDAQ%3AAIXI'), html);
  check('fast path is named in the hint', html.includes('fast approach'), html);
  check('after-hours gain shown', html.includes('after hours +34%'), html);
  const bare = formatTvSetupAlert({ stage: 'go', ticker: 'NXL', price: null, mvwap: null, px_pct: null, basis: null, basis_pct: null, day_gain: null, ah_gain: null, tf: null, path: null, go_via: null }, 'NXL', null);
  const goHtml = formatTvSetupAlert({ stage: 'go', ticker: 'NIVF', price: 0.1961, mvwap: 0.188, px_pct: 4.3, basis: 0.169, basis_pct: -10.1, day_gain: 38, ah_gain: null, tf: '1', path: null, go_via: 'reclaim' }, 'NASDAQ:NIVF', null);
  check('GO via reclaim says so', goHtml.includes('price reclaimed mVWAP') && !goHtml.includes('basis crossed'), goHtml);
  check('off Momentum → no star, says so', !bare.includes('⭐') && bare.includes('not on our Momentum list'), bare);
  check('fallback message renders without levels', bare.includes('<b>GO</b>') && !bare.includes('mVWAP $') && !bare.includes('undefined') && !bare.includes('null'), bare);
}

console.log('Contract — the Pine script still emits what the parser reads');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const pine = readFileSync(resolve(here, '../../web/src/tv/mvwap-bb-setup.pine'), 'utf8');
  for (const part of ['" | mVWAP "', '" | basis "', '" | day high "', '" | ah "', '" | tf "', '" | path "', '"base"', '"fast"',
    '" | via "', '"reclaim"', '"cross"', '" | vol "', '" | run "', '"FORMING"', '"READY"', '"GO"',
    '"PULLBACK"', '"BROKEN"', '"HELD"', '" | sVWAP "', '" | line "', '" | touch "', '" | peak +"', '"session"', '"month"', '"both"',
    '" | yVWAP "', '"year"', 'timeframe.change("M") or firstBar', 'firstBar = na(hlc3[1])',
    // v14: the year line from this year's hourly bars + today's chart bars; merged lines are named together
    'request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", yearBefore()', 'timeframe.change("12M")',
    '"month+year"', 'pbJoin(names, "year")',
    // v15: the day's PULLBACK cap counts failed pullbacks, not every touch
    's.fails < pbMax', 's.fails := s.fails + 1',
    // v16: no cap in the script by default; each PULLBACK says how many failed before it
    'pbMax == 0 or s.fails < pbMax', '" | fails "', 'fails := math.min(fails, pbY.fails)', 'pbCapMark']) {
    check(`script emits ${part}`, pine.includes(part));
  }
  check('alertcondition fallbacks carry ticker + close', pine.includes('READY {{ticker}} {{close}}') && pine.includes('GO {{ticker}} {{close}}'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll tv-setup checks passed');
