// Regression for the 📐 TradingView VWAP-setup webhook (services/tv-setups.ts).
// Run:  npx tsx scripts/verify-tv-setups.ts
// Pins the message contract with the Pine script (apps/web/src/tv/
// mvwap-bb-setup.pine) and the duplicate gate that keeps the phone usable.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseTvMessage, normTicker, TvSetupGate, TV_SETUP, formatTvSetupAlert, goStrength, type TvSetupSignal } from '../src/services/tv-setups.js';

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
  check('the month line minutes later is logged, not dropped', g.admit({ ...pb!, line: 'month' }, T0 + 60) === 'log');
  check('BROKEN is its own stage → notifies', g.admit(br!, T0 + 70) === 'notify');
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
  check('READY after the notify window notifies again', g.admit(sig(), T0 + TV_SETUP.notify_merge_sec + 140) === 'notify');
  const flood = new TvSetupGate();
  let verdicts: string[] = [];
  for (let i = 0; i < TV_SETUP.max_per_min + 5; i++) verdicts.push(flood.admit(sig({ ticker: `T${i}` }), T0));
  check('flood guard trips after max_per_min', verdicts.slice(0, TV_SETUP.max_per_min).every((v) => v === 'notify') && verdicts.slice(TV_SETUP.max_per_min).every((v) => v === 'flood'));
  verdicts = [flood.admit(sig({ ticker: 'LATER' }), T0 + 61)];
  check('…and recovers a minute later', verdicts[0] === 'notify');
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
    '"PULLBACK"', '"BROKEN"', '"HELD"', '" | sVWAP "', '" | line "', '" | touch "', '" | peak +"', '"session"', '"month"', '"both"']) {
    check(`script emits ${part}`, pine.includes(part));
  }
  check('alertcondition fallbacks carry ticker + close', pine.includes('READY {{ticker}} {{close}}') && pine.includes('GO {{ticker}} {{close}}'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll tv-setup checks passed');
