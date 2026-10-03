// Regression for the 📐 TradingView VWAP-setup webhook (services/tv-setups.ts).
// Run:  npx tsx scripts/verify-tv-setups.ts
// Pins the message contract with the Pine script (apps/web/src/tv/
// mvwap-bb-setup.pine) and the duplicate gate that keeps the phone usable.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseTvMessage, normTicker, TvSetupGate, TV_SETUP, formatTvSetupAlert, type TvSetupSignal } from '../src/services/tv-setups.js';

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
}

console.log('Parse — fallbacks and JSON');
{
  const f = parseTvMessage('READY AIXI 1.48 | tf 1');
  check('alertcondition() fallback', f?.stage === 'ready' && f.ticker === 'AIXI' && f.price === 1.48 && f.tf === '1' && f.mvwap == null, JSON.stringify(f));
  const bare = parseTvMessage('go nxl');
  check('lower-case stage, no price', bare?.stage === 'go' && bare.ticker === 'NXL' && bare.price == null, JSON.stringify(bare));
  const pre = parseTvMessage('READY NASDAQ:AIXI 1.48');
  check('exchange prefix stripped', pre?.ticker === 'AIXI', JSON.stringify(pre));
  const js = parseTvMessage('{"stage":"READY","ticker":"amex:soar","price":0.31,"mvwap":0.336,"basis_pct":-4.2,"tf":2}');
  check('JSON text body', js?.stage === 'ready' && js.ticker === 'SOAR' && js.price === 0.31 && js.basis_pct === -4.2 && js.tf === '2', JSON.stringify(js));
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

console.log('Gate — duplicates, other timeframes, flood');
{
  const T0 = 1_790_000_000;
  const sig = (over: Partial<TvSetupSignal> = {}): TvSetupSignal => ({
    stage: 'ready', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, basis: 1.49, basis_pct: -5.1, day_gain: 41, tf: '1', ...over,
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
    { stage: 'ready', ticker: 'AIXI', price: 1.48, mvwap: 1.57, px_pct: -5.7, basis: 1.49, basis_pct: -5.1, day_gain: 41, tf: '1' },
    'NASDAQ:AIXI',
    { change_pct: 21.8, grade: 'B+', float_m: 3.2 },
  );
  check('headline', html.includes('<b>READY</b>') && html.includes('<b>AIXI</b>') && html.includes('$1.48'), html);
  check('levels line', html.includes('mVWAP $1.57 (-5.7%)') && html.includes('basis $1.49 (-5.1%)'), html);
  check('context line', html.includes('day high +41%') && html.includes('now +21.8%') && html.includes('grade B+') && html.includes('tf 1'), html);
  check('chart link is exchange-qualified', html.includes('symbol=NASDAQ%3AAIXI'), html);
  const bare = formatTvSetupAlert({ stage: 'go', ticker: 'NXL', price: null, mvwap: null, px_pct: null, basis: null, basis_pct: null, day_gain: null, tf: null }, 'NXL', null);
  check('fallback message renders without levels', bare.includes('<b>GO</b>') && !bare.includes('mVWAP $') && !bare.includes('undefined') && !bare.includes('null'), bare);
}

console.log('Contract — the Pine script still emits what the parser reads');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const pine = readFileSync(resolve(here, '../../web/src/tv/mvwap-bb-setup.pine'), 'utf8');
  for (const part of ['" | mVWAP "', '" | basis "', '" | day high +"', '" | tf "', '"FORMING"', '"READY"', '"GO"']) {
    check(`script emits ${part}`, pine.includes(part));
  }
  check('alertcondition fallbacks carry ticker + close', pine.includes('READY {{ticker}} {{close}}') && pine.includes('GO {{ticker}} {{close}}'));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll tv-setup checks passed');
