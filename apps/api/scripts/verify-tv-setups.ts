// Regression for the 📐 TradingView VWAP-setup webhook (services/tv-setups.ts).
// Run:  npx tsx scripts/verify-tv-setups.ts
// Pins the message contract with the Pine script (apps/web/src/tv/
// mvwap-bb-setup.pine) and the duplicate gate that keeps the phone usable.
// Since script v27 (2026-10-28) the script has two setups, PULLBACK and the VWAP +
// BB cross; RECLAIM (FORMING / READY / GO) and the BB breakout (TOUCH / BREAKOUT /
// TRIGGERED) were removed, and their messages are rejected. v28 replaced the VB break
// (LEVEL / BREAK) with RETEST and added `vwap 30s|chart` to every message. v35 added the
// EMA cross over VWAP (stage EMA); v36 its filter; v37 its BOUNCE, which rides the EMA's switch;
// v40 the BB upper band as the line that crosses (stage BAND since 11-16); v41 its middle line.
// v39 removed v38's LIFT and v29's VB lanes. v44 (2026-11-22) removed the RSI cross (v32), its
// DIP (v34), the MACD cross after a DIP (v39) and the BASIS cross (v42): their messages are
// rejected, a saved switch of theirs is dropped, and the script had three setups (PULLBACK, the
// VWAP + BB cross, the EMA cross). v47 (2026-11-25) added a fourth, TURN (stage `turn`, from the 1m
// alert): after a basis fell and turned up, price closes above it, comes back to it and bounces.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  parseTvMessage, normTicker, TvSetupGate, TV_SETUP, formatTvSetupAlert, lineTokens,
  parseStageList, DEFAULT_ANNOUNCED, TV_STAGE_ORDER, pastCap, gradeAtLeast, tfMinutes, stageSwitch, readStoredStages, storedStages,
  emaByBand, emaFields, EMA_BAND_LABEL, readStoredRules, emaLineStage, storedSetupFields, storedStage,
  EMA_STAGES, LINE_CROSS_STAGES, TV_STAGE_LABEL, turnFields, vbFields, VB_STAGES, PULLBACK_STAGES,
  type TvSetupSignal,
} from '../src/services/tv-setups.js';
import * as tvSetups from '../src/services/tv-setups.js';

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
  check('default switches: PULLBACK, CROSS, RETEST, EMA, BAND and (v47) TURN on', JSON.stringify(DEFAULT_ANNOUNCED) === '["pullback","cross","retest","ema","band","turn"]');
  check('parseStageList keeps known stages in menu order, drops the rest (v27: a saved go / ready / forming too)',
    JSON.stringify(parseStageList(['held', 'GO', 'bogus', 'pullback', 'ready', 7])) === '["pullback","held"]'
      && parseStageList('pullback') === null && JSON.stringify(parseStageList([])) === '[]');
  check('menu order lists the eight stages (v28: RETEST in BREAK\'s place; a saved "break" is dropped; v35 EMA; 11-16 BAND after it; v44: RSI, DIP, MACD and BASIS left, a saved one is dropped like a saved "lift"; v47: TURN after BAND)',
    JSON.stringify(TV_STAGE_ORDER) === '["pullback","cross","retest","ema","band","turn","broken","held"]'
      && JSON.stringify(parseStageList(['pullback', 'cross', 'break'])) === '["pullback","cross"]'
      && JSON.stringify(parseStageList(['dip', 'lift', 'macd'])) === '[]'
      && JSON.stringify(parseStageList(['rsi', 'basis', 'band', 'ema'])) === '["ema","band"]');
  // The switches are stored as { announced, known } since 2026-11-13; before that as a plain list. A stage the saved
  // list didn't know takes the switch it follows (BAND ← EMA since 11-16), any other its default. v44: a saved RSI,
  // DIP, MACD or BASIS is dropped and switches nothing on or off.
  // v47: TURN follows no switch and is on by default, so every list saved before v47 (none of them knew it) reads back
  // with TURN on. The expectations below were the same lists without "turn" until v47.
  const legacy = readStoredStages(['pullback', 'cross', 'rsi', 'ema']);
  check('v44: an old saved list (a plain array) with RSI in it → the RSI is dropped, the rest as saved; EMA on → BAND with it (v47: and TURN at its default, on)',
    JSON.stringify(legacy) === '["pullback","cross","ema","band","turn"]', JSON.stringify(legacy));
  check('…with EMA off → BAND off; an RSI alone, or an empty old list, leaves nothing on but (v47) the TURN it never knew',
    JSON.stringify(readStoredStages(['pullback', 'cross', 'ema'])) === '["pullback","cross","ema","band","turn"]'
      && JSON.stringify(readStoredStages(['pullback', 'cross'])) === '["pullback","cross","turn"]'
      && JSON.stringify(readStoredStages(['rsi'])) === '["turn"]' && JSON.stringify(readStoredStages([])) === '["turn"]');
  check('a new saved list is read as saved: EMA on and BAND off stays so; BAND on alone',
    JSON.stringify(readStoredStages(storedStages(['pullback', 'ema']))) === '["pullback","ema"]'
      && JSON.stringify(readStoredStages(storedStages(['band']))) === '["band"]'
      && JSON.stringify(readStoredStages(storedStages(['ema', 'band']))) === '["ema","band"]'
      && JSON.stringify(readStoredStages(storedStages([]))) === '[]');
  check('…a stage the saved list didn\'t know takes the switch it follows (BAND ← EMA), any other its default (v47: TURN, on)',
    JSON.stringify(readStoredStages({ announced: ['ema'], known: ['pullback', 'cross', 'retest', 'rsi', 'ema', 'broken', 'held'] })) === '["ema","band","turn"]'
      && JSON.stringify(readStoredStages({ announced: ['rsi'], known: ['pullback', 'cross', 'retest', 'rsi', 'ema', 'broken', 'held'] })) === '["turn"]'
      && JSON.stringify(readStoredStages({ announced: [], known: ['pullback'] })) === '["cross","retest","ema","band","turn"]');
  // 2026-11-16: BAND got a switch; a list saved before starts it at the EMA's value (the saved DIP and MACD are dropped)
  const v42 = { known: ['pullback', 'cross', 'retest', 'rsi', 'dip', 'macd', 'ema', 'broken', 'held'], announced: ['pullback', 'dip', 'macd', 'ema'] };
  check('a list saved before 11-16 with EMA on → BAND on; with EMA off → BAND off (v47: TURN on either way)',
    JSON.stringify(readStoredStages(v42)) === '["pullback","ema","band","turn"]'
      && JSON.stringify(readStoredStages({ ...v42, announced: ['pullback', 'dip', 'macd'] })) === '["pullback","turn"]');
  // the operator's switches as saved on 11-13 (PULLBACK and DIP on), and under v38, which knew LIFT
  const saved = { known: ['pullback', 'cross', 'retest', 'rsi', 'dip', 'ema', 'broken', 'held'], announced: ['pullback', 'dip'] };
  const v38 = { known: ['pullback', 'cross', 'retest', 'rsi', 'dip', 'lift', 'ema', 'broken', 'held'], announced: ['pullback', 'dip', 'lift'] };
  check('…lists saved on 11-13 and under v38: the DIP, the RSI and the LIFT are dropped, PULLBACK stays, nothing else comes on but (v47) the TURN',
    JSON.stringify(readStoredStages(saved)) === '["pullback","turn"]'
      && JSON.stringify(readStoredStages({ ...saved, announced: ['pullback', 'rsi'] })) === '["pullback","turn"]'
      && JSON.stringify(readStoredStages(v38)) === '["pullback","turn"]'
      && JSON.stringify(readStoredStages({ ...v38, announced: ['pullback', 'lift', 'ema'] })) === '["pullback","ema","band","turn"]');
  // the operator's switches as saved on 2026-11-22, before v44: every stage v44 kept is in `known`, so none of those changes;
  // v47's TURN is not, so it comes on (its default)
  const today = { known: ['pullback', 'cross', 'retest', 'rsi', 'dip', 'macd', 'ema', 'band', 'basis', 'broken', 'held'], announced: ['pullback', 'band'] };
  check('v44: the operator\'s saved switches (PULLBACK and BAND on, the list knowing all eleven stages) read back as PULLBACK, BAND (v47: and TURN)',
    JSON.stringify(readStoredStages(today)) === '["pullback","band","turn"]', JSON.stringify(readStoredStages(today)));
  check('…with a removed stage switched on there too, the same; with EMA on and BAND off, BAND stays off',
    JSON.stringify(readStoredStages({ ...today, announced: ['pullback', 'rsi', 'dip', 'macd', 'band', 'basis'] })) === '["pullback","band","turn"]'
      && JSON.stringify(readStoredStages({ ...today, announced: ['ema', 'basis'] })) === '["ema","turn"]');
  check('…stored as { announced, known }; anything else is no list',
    JSON.stringify(storedStages(['band'])) === `{"announced":["band"],"known":${JSON.stringify(TV_STAGE_ORDER)}}`
      && readStoredStages('pullback') === null && readStoredStages({ announced: ['ema'] }) === null && readStoredStages(null) === null);
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

// v39 removed the script's three extra VB lanes (v29: 1h / 4h / 1D on month + year). The VB's one
// candle timeframe is still an input, so a longer one still parses; off Momentum it now follows
// the same rule as any other VB (v29–v38 announced 60m+ candles there, `vb_long_min`).
console.log('VB on a longer candle (the v29 lanes were removed in v39)');
{
  const h1 = parseTvMessage('CROSS AIOK 18.2 | mVWAP 17.6 (+3.4%) | yVWAP 15.1 (+20.5%) | upper 18.1 (+0.6%) | open 17.5 | line month+year | candle 60 | bb 10 | cross 1 | day high +46% | vwap 30s | tf 30S');
  check('a 1h-candle CROSS parses', h1?.stage === 'cross' && h1.candle_tf === '60' && h1.bb_tf === '10' && h1.line === 'month+year', JSON.stringify(h1));
  const d1 = parseTvMessage('CROSS AIOK 18.2 | mVWAP 17.6 (+3.4%) | upper 18.0 (+1.1%) | open 17.4 | line month | candle 1D | bb 60 | cross 1 | vwap 30s | tf 30S');
  check('…a daily candle ("1D"), and a bare "D" reads as "1D"', d1?.candle_tf === '1D' && d1.bb_tf === '60'
    && parseTvMessage('CROSS X 1.0 | candle D | bb 60 | cross 1 | tf 30S')?.candle_tf === '1D'
    && parseTvMessage({ stage: 'cross', ticker: 'X', candle_tf: 'd' })?.candle_tf === '1D', JSON.stringify(d1));
  check('tfMinutes', tfMinutes('5') === 5 && tfMinutes('240') === 240 && tfMinutes('1D') === 1440 && tfMinutes('30S') === 0.5
    && tfMinutes('1W') === 10080 && tfMinutes(null) === null && tfMinutes('x') === null);
  const T0 = 1_792_166_400;
  check('v39: off Momentum a 1h or daily candle is quiet like a 5m one (under +30%); the long-candle exception is gone',
    new TvSetupGate().admit({ ...h1!, day_gain: 8 }, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...d1!, day_gain: 3 }, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...h1!, candle_tf: '5', bb_tf: '45S', day_gain: 8 }, T0, false, false) === 'quiet'
      && !('vb_long_min' in TV_SETUP));
  check('…on Momentum, or with a day high of +30% or more, it announces', new TvSetupGate().admit({ ...h1!, day_gain: 8 }, T0, false, true) === 'notify'
    && new TvSetupGate().admit(h1!, T0, false, false) === 'notify');
  check('…the cap applies', new TvSetupGate().admit({ ...h1!, cross_n: TV_SETUP.vb_cap + 1 }, T0, false, true) === 'quiet');
  const r1 = parseTvMessage('RETEST AIOK 17.7 | stop 17.5 | mVWAP 17.6 (+0.6%) | line month | candle 240 | bb 30 | retest 1 | vwap 30s | tf 30S');
  check('…a 4h-candle RETEST off Momentum is quiet too', new TvSetupGate().admit(r1!, T0, false, false) === 'quiet', JSON.stringify(r1));
  const g = new TvSetupGate();
  check('a changed VB candle is another event (the candle is in the key)',
    g.admit(h1!, T0, false, true) === 'notify' && g.admit({ ...h1!, candle_tf: '240', bb_tf: '30' }, T0, false, true) === 'notify'
      && g.admit(h1!, T0 + 5, false, true) === 'drop');
  const html = formatTvSetupAlert(d1!, 'NASDAQ:AIOK', null);
  check('Telegram: a daily candle', html.includes('the 1D candle crossed over the month VWAP and the 1h BB upper band') && !html.includes('null'), html);
}

// v44 (operator, 2026-11-22) removed four stages from the script, the server and the dashboard: the RSI cross (v32), its
// DIP (v34), the MACD cross after a DIP (v39) and the BASIS cross (v42). A message of theirs — from an alert not recreated
// yet — is no longer read, so the webhook answers 400 and nothing is stored or announced. The EMA cross and the BAND
// cross, whose messages share the BASIS cross's "EMA" head word, are read as before.
console.log('Removed in v44 (2026-11-22): the RSI cross, its DIP, the MACD cross after a DIP, the BASIS cross');
{
  const rsiMsg = 'RSI XTND 1.07 | rsi 720 29.2 ma 27.0 | rsi 180 41.2 ma 30.7 | low 22.1 | candle 360 | tf 30S';
  const dipMsg = 'DIP OMH 8.09 | rsi 15 31.4 ma 31.3 | low 30.9 | stop 7.89 | dip 1 | since 8 | candle 15 | tf 30S';
  const macdMsg = 'MACD KRMN 38.12 | macd 5 12 26 | base 37.53 | stop 37.2 | dip 1 | after 200m | candle 10 | tf 30S';
  const basisMsg = 'EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | basis 8.03 (+0.7%) | bb 45S | len 10 | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S';
  check('v44: an RSI message is no longer read', parseTvMessage(rsiMsg) === null
    && parseTvMessage('RSI DKI 74.5 | rsi 720 31.0 ma 30.1 | low 22.4 | candle 360 | late | tf 30S') === null
    && parseTvMessage('RSI NCPL 1.26 | rsi 30 28.4 ma 26.9 | low 24.1 | candle 30 | tf 30S') === null);
  check('v44: a DIP message is no longer read', parseTvMessage(dipMsg) === null
    && parseTvMessage('DIP OMH 0.4412 | rsi 30 28.0 ma 33.5 | low 26.1 | stop 0.4299 | dip 2 | since 11 | candle 30 | late | tf 30S') === null);
  check('v44: a MACD message is no longer read', parseTvMessage(macdMsg) === null
    && parseTvMessage('MACD AKAN 0.6921 | macd 15 8 21 | base 0.686 | stop 0.6612 | dip 2 | after 1575m | candle 15 | late | tf 30S') === null);
  check('v44: an "EMA …" message about the basis (`| basis … | bb … | len …` in the EMA\'s place) is no longer read', parseTvMessage(basisMsg) === null
    && parseTvMessage('EMA NCPL 0.4412 | sVWAP 0.4391 (+.5%) | mVWAP 0.41 (+7.6%) | basis 0.4401 (+.2%) | bb 2 | len 1 | line session+month | candle 5 | cross 0 | under 3 | flips 4 | weak | late | vwap chart | tf 30S') === null
    && parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | basis 8.03 (+0.7%) | bb 1 | len 10 | line session | candle 1 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S') === null);
  check('…it is rejected, not read as a BAND cross for its `| bb` or as an EMA cross (without the "(…%)", lower-case, without the band too)',
    parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | basis 8.03 | bb 45S | len 10 | line session | candle 3 | cross 1 | tf 30S') === null
      && parseTvMessage(basisMsg.toLowerCase()) === null
      && parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | basis 8.03 (+0.7%) | line session | candle 3 | cross 1 | tf 30S') === null);
  check('v44: a JSON body naming a removed stage is rejected', parseTvMessage({ stage: 'rsi', ticker: 'XTND', rsi_tf: '720', rsi: 29.2, rsi_ma: 27, low: 22.1, candle: '360' }) === null
    && parseTvMessage({ stage: 'dip', ticker: 'OMH', rsi_tf: '15', rsi: 31.4, rsi_ma: 31.3, low: 30.9, stop: 7.89, dip: 2, since: 8, candle: '15' }) === null
    && parseTvMessage({ stage: 'macd', ticker: 'KRMN', macd_tf: '5', macd_fast: 12, macd_slow: 26, base: 37.53, after: 200, stop: 37.2 }) === null
    && parseTvMessage({ stage: 'basis', ticker: 'OMH', basis: 8.03, bb: '1', len: 10 }) === null
    && parseTvMessage('{"stage":"MACD","ticker":"KRMN","price":38.12}') === null);
  check('…and a JSON "ema" body that names a basis and no EMA', parseTvMessage({ stage: 'ema', ticker: 'OMH', basis: 8.03, bb: '45S', len: 10, candle: '3' }) === null
    && parseTvMessage({ stage: 'ema', ticker: 'OMH', basis: 8.03, bb_len: 20 }) === null
    && parseTvMessage('{"stage":"ema","ticker":"OMH","basis":8.03,"bb":"1"}') === null);
  // v38's LIFT was removed in v39 with the script's level: its messages are rejected (400) like these.
  check('v39: a LIFT message is no longer read', parseTvMessage('LIFT KRMN 40.55 | lift 40.53 | base 37.53 | up 8 | stop 37.2 | dip 1 | after 290m | by touch | candle 10 | tf 30S') === null
    && parseTvMessage({ stage: 'lift', ticker: 'KRMN', lift: 40.53, base: 37.53 }) === null);

  // The two crosses that keep the "EMA" head word parse as before.
  const ema = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S');
  const band = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.13 (-0.5%) | bb 45S | mid 8.02 (+0.9%) | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S');
  check('v44: an EMA message with `| ema …` still parses as an EMA cross', ema?.stage === 'ema' && ema.ticker === 'OMH' && ema.price === 8.09 && ema.ema_len === 9
    && ema.ema === 8.03 && ema.svwap === 8.01 && ema.spx_pct === 1 && ema.line === 'session' && ema.candle_tf === '3' && ema.cross_n === 1 && ema.under_n === 12
    && ema.flips_n === 1 && ema.weak === false && ema.late === false && ema.day_gain === 25 && ema.vwap_src === '30s' && ema.tf === '30S'
    && ema.upper === null && ema.bb_tf === null && ema.bb_mid === null, JSON.stringify(ema));
  check('v44: a BAND message (`| upper … | bb … | mid …`) still parses as a BAND cross', band?.stage === 'band' && band.ticker === 'OMH' && band.price === 8.09
    && band.upper === 8.13 && band.upper_pct === -0.5 && band.bb_tf === '45S' && band.bb_mid === 8.02 && band.bb_mid_pct === 0.9 && band.ema === null
    && band.ema_len === null && band.svwap === 8.01 && band.line === 'session' && band.candle_tf === '3' && band.cross_n === 1 && band.under_n === 12
    && band.flips_n === 1 && band.weak === false && band.day_gain === 25 && band.tf === '30S' && emaByBand(band), JSON.stringify(band));
  check('…and their Telegram headlines read EMA and BAND', formatTvSetupAlert(ema!, 'NASDAQ:OMH', null).includes('〽️ <b>EMA</b>')
    && formatTvSetupAlert(ema!, 'NASDAQ:OMH', null).includes('the 3m EMA 9 crossed above the session VWAP (at the 3m close)')
    && formatTvSetupAlert(band!, 'NASDAQ:OMH', null).includes('〽️ <b>BAND</b>')
    && formatTvSetupAlert(band!, 'NASDAQ:OMH', null).includes('the 45s BB upper band crossed above the session VWAP (at the 3m close)')
    && !formatTvSetupAlert(band!, 'NASDAQ:OMH', null).toLowerCase().includes('basis'));
  const removedFields = ['rsi_tf', 'rsi', 'rsi_ma', 'rsi2_tf', 'rsi2', 'rsi2_ma', 'rsi_low', 'dip_n', 'macd_tf', 'macd_fast', 'macd_slow', 'dip_px', 'after_min',
    'basis', 'basis_pct', 'bb_len'];
  const pbSig = parseTvMessage('PULLBACK X 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1');
  check('v44: no signal carries a removed stage\'s field (the RSI\'s, the DIP\'s, the MACD\'s, the basis\'s)',
    [ema, band, pbSig, parseTvMessage({ stage: 'band', ticker: 'OMH', upper: 8.13, bb: '30S', basis: 8.03, len: 10, rsi: 30, macd_tf: '5', dip: 1 })]
      .every((s) => s != null && removedFields.every((k) => !(k in s))), JSON.stringify(band));
  check('…nor does a stored row\'s field set', !('basis' in emaFields(band!)) && !('bb_len' in emaFields(band!)) && !('basis' in emaFields(ema!))
    && emaFields(band!).upper === 8.13 && emaFields(band!).bb_mid_pct === 0.9 && emaFields(ema!).ema === 8.03);
  check('v44: RSI, DIP, MACD and BASIS as tickers still parse as tickers',
    parseTvMessage('PULLBACK RSI 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'RSI'
      && parseTvMessage('PULLBACK DIP 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'DIP'
      && parseTvMessage('PULLBACK MACD 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'MACD'
      && parseTvMessage('CROSS BASIS 1.0 | candle 5 | bb 2 | cross 1 | tf 30S')?.ticker === 'BASIS'
      && parseTvMessage('CROSS BASIS 1.0 | candle 5 | bb 2 | cross 1 | tf 30S')?.stage === 'cross');
  check('v44: emaLineStage has no stage for the basis shape (a basis and no EMA); EMA and BAND as before',
    emaLineStage({ stage: 'ema', bb_tf: '1', basis: 8.03 }) === null && emaLineStage({ stage: 'ema', basis: 8.03 }) === null
      && emaLineStage({ stage: 'ema', ema: 8.03 }) === 'ema' && emaLineStage({ stage: 'ema', bb_tf: '45S' }) === 'band'
      && emaLineStage({ stage: 'ema' }) === 'ema');
  check('v44: the stage lists carry the eight kept stages only (and v47\'s TURN, the ninth)', JSON.stringify(Object.keys(TV_STAGE_LABEL).sort()) === '["band","bounce","broken","cross","ema","held","pullback","retest","turn"]'
    && JSON.stringify(TV_STAGE_ORDER) === '["pullback","cross","retest","ema","band","turn","broken","held"]'
    && JSON.stringify([...EMA_STAGES]) === '["ema","bounce","band"]' && JSON.stringify([...LINE_CROSS_STAGES]) === '["ema","band"]');
  check('v44: the module no longer exports the removed stages\' helpers',
    ['RSI_STAGES', 'rsiFields', 'emaByBasis', 'EMA_BASIS_LABEL', 'fmtMinutes'].every((name) => !(name in tvSetups))
      && 'emaByBand' in tvSetups && 'EMA_BAND_LABEL' in tvSetups && 'emaFields' in tvSetups && 'vbFields' in tvSetups);
  const g = new TvSetupGate();
  check('v44: the default switches and a gate\'s announced stages name no removed stage',
    JSON.stringify(g.announcedStages()) === '["pullback","cross","retest","ema","band","turn"]'
      && [...DEFAULT_ANNOUNCED, ...TV_STAGE_ORDER].every((s) => !['rsi', 'dip', 'macd', 'basis', 'lift'].includes(s)));
}

console.log('EMA cross over VWAP (v35, 2026-11-13)');
{
  const T0 = 1_794_570_000;
  const msg = 'EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | mVWAP 7.5 (+7.9%) | ema 9 8.03 | line session | candle 3 | cross 1 | day high +25% | vwap 30s | tf 30S';
  const e = parseTvMessage(msg);
  check('EMA parses', e?.stage === 'ema' && e.ticker === 'OMH' && e.price === 8.09 && e.svwap === 8.01 && e.spx_pct === 1 && e.mvwap === 7.5
    && e.px_pct === 7.9 && e.ema_len === 9 && e.ema === 8.03 && e.line === 'session' && e.candle_tf === '3' && e.cross_n === 1 && e.day_gain === 25
    && e.vwap_src === '30s' && e.tf === '30S' && e.late === false, JSON.stringify(e));
  check('…no VB band, retest or pullback fields', e?.upper === null && e?.bb_tf === null && e?.retest_n === null && e?.touch === null
    && e?.stop === null, JSON.stringify(e));
  const late = parseTvMessage('EMA NCPL 0.4412 | sVWAP 0.4391 (+.5%) | ema 20 0.4402 | line session+month | candle 5 | cross 4 | late | vwap chart | tf 30S');
  check('…a late one on two lines, sub-dollar, another length and timeframe', late?.late === true && late.ema_len === 20 && late.ema === 0.4402
    && late.line === 'session+month' && late.candle_tf === '5' && late.cross_n === 4 && late.spx_pct === 0.5 && late.vwap_src === 'chart', JSON.stringify(late));
  check('…JSON', parseTvMessage({ stage: 'ema', ticker: 'OMH', ema_len: 9, ema: 8.03, line: 'session', candle: '3', cross: 2 })?.ema === 8.03);
  check('…a CROSS has no EMA fields, and "EMA" as a ticker still parses as one',
    parseTvMessage('CROSS X 1.0 | candle 5 | bb 2 | cross 1 | tf 30S')?.ema === null
      && parseTvMessage('PULLBACK EMA 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'EMA');
  const g = new TvSetupGate();
  check('EMA on Momentum announces', g.admit(e!, T0, false, true) === 'notify');
  check('…the same candle again is a re-delivery; the next cross is a new event', g.admit(e!, T0 + 5, false, true) === 'drop'
    && g.admit({ ...e!, cross_n: 2 }, T0 + 200, false, true) === 'notify');
  // 2026-11-15 (operator: "ema cross must be checked only with momentum list … make it configurable"): Momentum names
  // only is the default; the ⚙ rule switched off brings back the VB's +30% day-high exception.
  const lax = () => { const x = new TvSetupGate(); x.setEmaMomentumOnly(false); return x; };
  check('…off Momentum quiet, with a +30% day high too (the ⚙ rule, on by default)', TV_SETUP.em_momentum_only === true
    && new TvSetupGate().emaMomentumOnly() && new TvSetupGate().admit(e!, T0, false, false) === 'quiet'
    && new TvSetupGate().admit({ ...e!, day_gain: 31 }, T0, false, false) === 'quiet'
    && new TvSetupGate().admit({ ...e!, day_gain: 300 }, T0, false, false) === 'quiet');
  check('…the rule switched off: a day high of +30% or more announces off the list, under it stays quiet; on the list either way',
    lax().admit({ ...e!, day_gain: 31 }, T0, false, false) === 'notify' && lax().admit(e!, T0, false, false) === 'quiet'
      && !lax().emaMomentumOnly() && lax().admit(e!, T0, false, true) === 'notify' && new TvSetupGate().admit(e!, T0, false, true) === 'notify');
  check('…a CROSS keeps its own rule whatever the EMA\'s: +30% off the list announces',
    new TvSetupGate().admit(parseTvMessage('CROSS OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.0 (+1.1%) | open 7.9 | line session | candle 5 | bb 45S | cross 1 | day high +31% | tf 30S')!, T0, false, false) === 'notify');
  check('the stored rules read back: true / false as saved; a missing row, a missing field or junk is the default',
    readStoredRules({ ema_momo_only: false }).ema_momo_only === false && readStoredRules({ ema_momo_only: true }).ema_momo_only === true
      && readStoredRules(undefined).ema_momo_only === true && readStoredRules(null).ema_momo_only === true
      && readStoredRules({}).ema_momo_only === true && readStoredRules({ ema_momo_only: 'no' }).ema_momo_only === true
      && readStoredRules([false]).ema_momo_only === true);
  check(`…past the cap (cross ${TV_SETUP.em_cap + 1}) quiet`, pastCap({ ...e!, cross_n: TV_SETUP.em_cap + 1 }) && !pastCap(e!)
    && new TvSetupGate().admit({ ...e!, cross_n: TV_SETUP.em_cap + 1 }, T0, false, true) === 'quiet');
  const off = new TvSetupGate();
  off.setAnnounced(['pullback', 'cross']);
  check('…switched off in ⚙ (the operator\'s saved list has no EMA yet) → quiet', off.admit(e!, T0, false, true) === 'quiet' && !off.announces('ema'));
  check('…two EMA timeframes crossing on one 30s bar are two events (the candle is in the key)',
    (() => { const g2 = new TvSetupGate(); return g2.admit(e!, T0, false, true) === 'notify' && g2.admit({ ...e!, candle_tf: '5' }, T0, false, true) === 'notify'; })());
  const html = formatTvSetupAlert(e!, 'NASDAQ:OMH', { change_pct: 24.1, grade: 'B+', float_m: 3.2 });
  check('Telegram: EMA headline and what happened', html.includes('〽️ <b>EMA</b>') && html.includes('<b>OMH</b>') && html.includes('$8.09')
    && html.includes('the 3m EMA 9 crossed above the session VWAP (at the 3m close)'), html);
  check('Telegram: the EMA, the count, the levels, Momentum', html.includes('EMA $8.03 · cross 1 today (first)')
    && html.includes('sVWAP $8.01 (+1.0%) · mVWAP $7.50 (+7.9%)') && html.includes('on Momentum') && html.includes('grade B+') && !html.includes('null'), html);
  check('Telegram: a late one on two lines says so', formatTvSetupAlert(late!, 'NASDAQ:NCPL', null).includes('crossed above the session + month VWAP (at the 5m close, a bar late)')
    && formatTvSetupAlert(late!, 'NASDAQ:NCPL', null).includes('cross 4 today — past the cap'));

  // v36: the script's filter — its readings ride every EMA message, `| weak` when it calls the cross weak
  check('v35 messages carry no filter readings and are not weak', e?.under_n === null && e?.flips_n === null && e?.weak === false
    && late?.weak === false, JSON.stringify(e));
  const strong = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S');
  check('v36: a strong cross parses with its readings', strong?.stage === 'ema' && strong.under_n === 12 && strong.flips_n === 1 && strong.weak === false
    && strong.cross_n === 1 && strong.day_gain === 25 && strong.ema === 8.03 && strong.candle_tf === '3', JSON.stringify(strong));
  const weak = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 3 | cross 0 | under 3 | flips 4 | weak | day high +25% | late | vwap 30s | tf 30S');
  check('v36: a weak cross parses (cross 0: it takes no number)', weak?.weak === true && weak.under_n === 3 && weak.flips_n === 4 && weak.cross_n === 0
    && weak.late === true && weak.day_gain === 25 && weak.tf === '30S', JSON.stringify(weak));
  check('…JSON', parseTvMessage({ stage: 'ema', ticker: 'OMH', ema_len: 9, ema: 8.03, under: 3, flips: 4, weak: true })?.weak === true
    && parseTvMessage({ stage: 'ema', ticker: 'OMH', under_n: 7, flips_n: 0 })?.under_n === 7);
  check('…"weak", "under" and "flips" are read after a "|" only (a ticker named WEAK is not a weak cross)',
    parseTvMessage('EMA WEAK 1.0 | sVWAP 1 (+0%) | ema 9 1.0 | line session | candle 3 | cross 1 | under 9 | flips 0 | tf 30S')?.weak === false
      && parseTvMessage('PULLBACK X 1.0 | sVWAP 1 (+0%) | line session | touch 1 | fails 2 | tf 1')?.flips_n === null);
  check('v36: a strong cross on Momentum announces; a weak one is quiet, on Momentum and with a +30% day high alike',
    new TvSetupGate().admit(strong!, T0, false, true) === 'notify' && new TvSetupGate().admit(weak!, T0, false, true) === 'quiet'
      && new TvSetupGate().admit({ ...weak!, day_gain: 80 }, T0, false, true) === 'quiet');
  check('…a weak cross does not use up the cap (cross 0), and the next strong one announces',
    !pastCap(weak!) && (() => { const g3 = new TvSetupGate(); return g3.admit(weak!, T0, false, true) === 'quiet' && g3.admit(strong!, T0 + 400, false, true) === 'notify'; })());
  const wHtml = formatTvSetupAlert(weak!, 'NASDAQ:OMH', null);
  check('Telegram: the readings, and "filtered as weak"', formatTvSetupAlert(strong!, 'NASDAQ:OMH', null).includes('12 candles under the line before · 1 crossing in the 20 before')
    && !formatTvSetupAlert(strong!, 'NASDAQ:OMH', null).includes('weak')
    && wHtml.includes('3 candles under the line before · 4 crossings in the 20 before · filtered as weak'), wHtml);
}

// v40 (operator: "can we make EMA Cross use BollingerBands upper row instead of EMA? … switch between
// EMA and BB Upper row", then "or, could we do both?"): the script's line that crosses the VWAP is the
// EMA, the BB upper band, or both. A band cross is an EMA-stage message with `| upper … | bb …` in
// the place of `| ema …`: the same switch, cap and filter; shown as BAND; its own event.
console.log('The band as the line that crosses (v40, 2026-11-15)');
{
  const T0 = 1_794_760_000;
  const ema = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S');
  const b = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.13 (-0.5%) | bb 45S | line session | candle 3 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S');
  check('a band cross parses: an "EMA …" message read as stage BAND (11-16), the band and its timeframe, no EMA', b?.stage === 'band' && b.ticker === 'OMH' && b.price === 8.09 && b.upper === 8.13
    && b.upper_pct === -0.5 && b.bb_tf === '45S' && b.ema === null && b.ema_len === null && b.svwap === 8.01 && b.line === 'session' && b.candle_tf === '3'
    && b.cross_n === 1 && b.under_n === 12 && b.flips_n === 1 && b.weak === false && b.day_gain === 25 && b.tf === '30S', JSON.stringify(b));
  check('emaByBand: the band cross yes; an EMA cross, a CROSS and a BOUNCE no', emaByBand(b!) && !emaByBand(ema!)
    && !emaByBand(parseTvMessage('CROSS X 1.0 | upper 0.99 (+1.0%) | candle 5 | bb 45S | cross 1 | tf 30S')!)
    && !emaByBand(parseTvMessage('BOUNCE X 1.0 | stop 0.9 | ema 9 0.99 | line session | from ema | candle 3 | bounce 1 | since 2 | tf 30S')!));
  const bl = parseTvMessage('EMA NCPL 0.4412 | sVWAP 0.4391 (+.5%) | mVWAP 0.41 (+7.6%) | upper 0.4405 (+.2%) | bb 2 | line session+month | candle 5 | cross 0 | under 3 | flips 4 | weak | late | vwap chart | tf 30S');
  check('…a weak, late one on two lines with a 2m band', bl?.upper === 0.4405 && bl.upper_pct === 0.2 && bl.bb_tf === '2' && bl.weak === true && bl.late === true
    && bl.line === 'session+month' && bl.candle_tf === '5' && bl.cross_n === 0 && emaByBand(bl), JSON.stringify(bl));
  check('…JSON', emaByBand(parseTvMessage({ stage: 'ema', ticker: 'OMH', upper: 8.13, bb: '45S', line: 'session', candle: '3', cross: 2 })!)
    && !emaByBand(parseTvMessage({ stage: 'ema', ticker: 'OMH', ema_len: 9, ema: 8.03, candle: '3' })!));
  check('its row fields carry the band; an EMA cross\'s don\'t', emaFields(b!).upper === 8.13 && emaFields(b!).upper_pct === -0.5 && emaFields(b!).bb_tf === '45S'
    && emaFields(b!).cross_n === 1 && emaFields(b!).under_n === 12 && !('upper' in emaFields(ema!)) && !('bb_tf' in emaFields(ema!)), JSON.stringify(emaFields(b!)));
  const g = new TvSetupGate();
  check('"Both": the EMA cross and the band cross of one candle are two events, each announced', g.admit(ema!, T0, false, true) === 'notify'
    && g.admit(b!, T0, false, true) === 'notify');
  check('…each again is a re-delivery', g.admit(ema!, T0 + 5, false, true) === 'drop' && g.admit(b!, T0 + 5, false, true) === 'drop');
  check('the band cross is limited like the EMA cross: Momentum names only (a +30% day high only with the ⚙ rule off), the cap, the EMA switch, weak ones quiet',
    new TvSetupGate().admit(b!, T0, false, false) === 'quiet' && new TvSetupGate().admit({ ...b!, day_gain: 31 }, T0, false, false) === 'quiet'
      && (() => { const x = new TvSetupGate(); x.setEmaMomentumOnly(false); return x.admit({ ...b!, day_gain: 31 }, T0, false, false) === 'notify'; })()
      && new TvSetupGate().admit({ ...b!, cross_n: TV_SETUP.em_cap + 1 }, T0, false, true) === 'quiet'
      && (() => { const off = new TvSetupGate(); off.setAnnounced(['pullback', 'cross']); return off.admit(b!, T0, false, true) === 'quiet'; })()
      && new TvSetupGate().admit(bl!, T0, false, true) === 'quiet' && stageSwitch('ema') === 'ema');
  const html = formatTvSetupAlert(b!, 'NASDAQ:OMH', { change_pct: 24.1, grade: 'B+', float_m: 3.2 });
  check('Telegram: BAND headline and what happened', html.includes(`〽️ <b>${EMA_BAND_LABEL}</b>`) && EMA_BAND_LABEL === 'BAND' && html.includes('<b>OMH</b>')
    && html.includes('$8.09') && html.includes('the 45s BB upper band crossed above the session VWAP (at the 3m close)') && !html.includes('<b>EMA</b>'), html);
  check('Telegram: the band, the count, the readings, the levels', html.includes('45s BB upper $8.13 (-0.5%) · cross 1 today (first)')
    && html.includes('12 candles under the line before · 1 crossing in the 20 before') && html.includes('sVWAP $8.01 (+1.0%)')
    && html.includes('on Momentum') && !html.includes('null') && !html.includes('EMA $'), html);
  const lHtml = formatTvSetupAlert(bl!, 'NASDAQ:NCPL', null);
  check('Telegram: a weak, late one on two lines', lHtml.includes('the 2m BB upper band crossed above the session + month VWAP (at the 5m close, a bar late)')
    && lHtml.includes('filtered as weak'), lHtml);
  check('an EMA cross still reads EMA', formatTvSetupAlert(ema!, 'NASDAQ:OMH', null).includes('〽️ <b>EMA</b>')
    && formatTvSetupAlert(ema!, 'NASDAQ:OMH', null).includes('the 3m EMA 9 crossed above the session VWAP'));

  // v41 (operator, CLRO 11-16: "bb upper row moves away from price if it drops too fast, and crosses up the near vwap"):
  // every band cross carries the band's middle line and the price against it; one that closed under the middle
  // (the band widened on a drop) is what the script's bbMidOn input calls weak.
  const up = parseTvMessage('EMA GP 1.74 | sVWAP 1.62 (+7.4%) | upper 1.71 (+1.8%) | bb 45S | mid 1.58 (+10.1%) | line session | candle 3 | cross 1 | under 30 | flips 0 | day high +28% | vwap 30s | tf 30S');
  const dn = parseTvMessage('EMA CLRO 4.88 | sVWAP 5.22 (-6.5%) | upper 5.24 (-6.9%) | bb 45S | mid 5.04 (-3.2%) | line session | candle 3 | cross 0 | under 6 | flips 1 | weak | day high +41% | vwap 30s | tf 30S');
  check('v41: the band\'s middle line parses, with the price against it', up?.bb_mid === 1.58 && up.bb_mid_pct === 10.1 && up.upper === 1.71 && up.upper_pct === 1.8
    && up.bb_tf === '45S' && up.weak === false && up.cross_n === 1 && emaByBand(up), JSON.stringify(up));
  check('…a cross made by a drop: under the middle, weak, no number', dn?.bb_mid === 5.04 && dn.bb_mid_pct === -3.2 && dn.upper_pct === -6.9 && dn.weak === true
    && dn.cross_n === 0 && dn.spx_pct === -6.5 && emaByBand(dn), JSON.stringify(dn));
  check('…v40 band crosses and every other message have none; JSON reads it too', b?.bb_mid === null && b?.bb_mid_pct === null && ema?.bb_mid === null
    && parseTvMessage('PULLBACK X 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.bb_mid === null
    && parseTvMessage({ stage: 'ema', ticker: 'GP', upper: 1.71, bb: '45S', mid: 1.58, bb_mid_pct: 10.1 })?.bb_mid === 1.58);
  check('…its row fields carry them (a band cross only)', emaFields(up!).bb_mid === 1.58 && emaFields(up!).bb_mid_pct === 10.1
    && emaFields(dn!).bb_mid_pct === -3.2 && !('bb_mid' in emaFields(ema!)));
  check('…the push announces on Momentum; the drop-made one is quiet there too', new TvSetupGate().admit(up!, T0, false, true) === 'notify'
    && new TvSetupGate().admit(dn!, T0, false, true) === 'quiet');
  const upHtml = formatTvSetupAlert(up!, 'NASDAQ:GP', { change_pct: 28, grade: 'B', float_m: 5 });
  const dnHtml = formatTvSetupAlert(dn!, 'NASDAQ:CLRO', { change_pct: 20, grade: 'B', float_m: 1 });
  check('Telegram: the price against the band\'s middle, and what a drop-made cross is', upHtml.includes('price +10.1% over the band\'s middle')
    && dnHtml.includes('price -3.2% under the band\'s middle (the band widened on a drop)') && dnHtml.includes('filtered as weak')
    && !html.includes('the band\'s middle'), `${upHtml}\n${dnHtml}`);
}

// 2026-11-16 (operator, with a sidebar of BAND pills and the ⚙ menu: "can we separate what band are these? … and, these
// ones also?"): BAND is a stage of its own, with a ⚙ switch; the script still heads its message "EMA". (v42's BASIS
// cross became a stage the same day; v44 removed it — the checks above.)
// And the day's rows a reloaded page reads carry every stage-specific field (they carried the VB's alone).
console.log('BAND as a stage with its own switch (2026-11-16)');
{
  const T0 = 1_794_830_000;
  const ema = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | ema 9 8.03 | line session | candle 1 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S')!;
  const band = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.13 (-0.5%) | bb 30S | mid 8.02 (+0.9%) | line session | candle 1 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S')!;
  const bounce = parseTvMessage('BOUNCE OMH 8.2 | stop 8.0 | sVWAP 8.01 (+2.4%) | ema 9 8.1 | line session | from ema | candle 1 | bounce 1 | since 3 | vwap 30s | tf 30S')!;
  check('the stage follows the line the message names: EMA, BAND', ema.stage === 'ema' && band.stage === 'band'
    && emaLineStage({ stage: 'ema', ema: 8.03 }) === 'ema' && emaLineStage({ stage: 'ema', bb_tf: '45S' }) === 'band'
    && emaLineStage({ stage: 'ema' }) === 'ema'
    && emaLineStage({ stage: 'cross', bb_tf: '45S' }) === 'cross' && emaLineStage({ stage: 'bounce', ema: 8.1 }) === 'bounce');
  check('…a JSON body may name the stage itself', parseTvMessage({ stage: 'band', ticker: 'OMH', upper: 8.13, bb: '30S' })?.stage === 'band'
    && parseTvMessage({ stage: 'ema', ticker: 'OMH', upper: 8.13, bb: '30S' })?.stage === 'band');
  check('BAND has its own switch, after EMA in the menu; the BOUNCE still rides the EMA\'s', stageSwitch('band') === 'band'
    && stageSwitch('bounce') === 'ema' && TV_STAGE_ORDER.indexOf('band') === TV_STAGE_ORDER.indexOf('ema') + 1);
  const only = (stages: Parameters<TvSetupGate['setAnnounced']>[0]) => { const g = new TvSetupGate(); g.setAnnounced(stages); return g; };
  check('BAND off, EMA on → the band cross is quiet, the EMA cross and the bounce announce',
    only(['ema']).admit(band, T0, false, true) === 'quiet' && only(['ema']).admit(ema, T0, false, true) === 'notify'
      && only(['ema']).admit(bounce, T0, false, true) === 'notify' && !only(['ema']).announces('band') && only(['ema']).announces('ema'));
  check('BAND alone on → only the band cross announces (no EMA, no bounce)',
    only(['band']).admit(band, T0, false, true) === 'notify'
      && only(['band']).admit(ema, T0, false, true) === 'quiet' && only(['band']).admit(bounce, T0, false, true) === 'quiet');
  check('…it still follows the Momentum rule, the cap and the weak rule', new TvSetupGate().admit(band, T0, false, false) === 'quiet'
    && pastCap({ ...band, cross_n: TV_SETUP.em_cap + 1 })
    && !pastCap(band) && new TvSetupGate().admit({ ...band, weak: true }, T0, false, true) === 'quiet');
  check('labels', formatTvSetupAlert(band, 'NASDAQ:OMH', null).includes('<b>BAND</b>')
    && formatTvSetupAlert(band, 'NASDAQ:OMH', null).includes('the 30s BB upper band crossed above the session VWAP (at the 1m close)'));

  // A reloaded page's rows (GET /api/screener/alerts): the stored meta → the setup info
  const bandRow = { stage: 'ema', ...emaFields(band), candle_tf: '1' };          // as stored on 11-15 / 11-16: stage `ema`
  // a basis cross as v42 stored it on 11-16 (stage `ema`, no EMA, the basis with its band's timeframe and length)
  const basisRow = { stage: 'ema', candle_tf: '1', cross_n: 1, ema_len: null, ema: null, late: false, under_n: 12, flips_n: 1, weak: false,
    basis: 8.03, basis_pct: 0.7, bb_tf: '1', bb_len: 10 };
  check('a row stored as `ema` reads BAND by its fields; an EMA row stays EMA; other stages are themselves',
    storedStage(bandRow) === 'band' && storedStage({ stage: 'ema', ...emaFields(ema) }) === 'ema'
      && storedStage({ stage: 'band' }) === 'band' && storedStage({ stage: 'cross', bb_tf: '45S' }) === 'cross' && storedStage({}) === null);
  check('v44: a basis cross stored as `ema` still reads `basis` (the removed stage GET /api/screener/alerts leaves out), not EMA or BAND',
    storedStage(basisRow) === 'basis' && storedStage({ stage: 'basis', basis: 8.03, bb_tf: '1' }) === 'basis'
      && storedStage({ stage: 'ema', basis: 8.03 }) === 'basis' && storedStage({ stage: 'ema', ema: 8.03, basis: 8.01 }) === 'ema');
  check('…an EMA row carries its length, readings and weak flag, a band row its band and middle line',
    storedSetupFields({ stage: 'ema', ...emaFields({ ...ema, weak: true }) }).weak === true
      && storedSetupFields({ stage: 'ema', ...emaFields(ema) }).ema_len === 9 && storedSetupFields({ stage: 'ema', ...emaFields(ema) }).under_n === 12
      && storedSetupFields(bandRow).bb_mid_pct === 0.9 && storedSetupFields(bandRow).upper === 8.13 && storedSetupFields(bandRow).bb_tf === '30S'
      && storedSetupFields(bandRow).cross_n === 1, JSON.stringify(storedSetupFields(bandRow)));
  const rsiRow = { stage: 'rsi', rsi_tf: '10', rsi: 28.4, rsi_ma: 26.9, rsi_low: 24.1, candle_tf: '60', late: true };
  const macdRow = { stage: 'macd', macd_tf: '5', macd_fast: 12, macd_slow: 26, dip_px: 37.53, after_min: 200, stop: 37.2, dip_n: 1 };
  check('…the BOUNCE\'s fields too; v44: the RSI\'s, the DIP\'s, the MACD\'s and the basis\'s are no longer copied',
    storedSetupFields({ stage: 'bounce', bounce_n: 2, bounce_from: 'ema+vwap', since_n: 3 }).bounce_from === 'ema+vwap'
      && storedSetupFields({ stage: 'bounce', bounce_n: 2, bounce_from: 'ema+vwap', since_n: 3 }).since_n === 3
      && ['rsi_tf', 'rsi', 'rsi_ma', 'rsi_low'].every((k) => !(k in storedSetupFields(rsiRow)))
      && ['macd_tf', 'macd_fast', 'macd_slow', 'dip_px', 'after_min', 'dip_n'].every((k) => !(k in storedSetupFields(macdRow)))
      && ['basis', 'basis_pct', 'bb_len'].every((k) => !(k in storedSetupFields(basisRow))), JSON.stringify(storedSetupFields(basisRow)));
  check('…only what the row has (a PULLBACK row gets none), and junk reads as null', Object.keys(storedSetupFields({ stage: 'pullback', touch: 1, line: 'session' })).length === 0
    && storedSetupFields({ ema_len: '9', bb_tf: 45 }).ema_len === null && storedSetupFields({ ema_len: '9', bb_tf: 45 }).bb_tf === null);
}

console.log('EMA bounce (v37, 2026-11-13)');
{
  const T0 = 1_794_580_000;
  const msg = 'BOUNCE PARA 0.1021 | stop 0.0985 | sVWAP 0.0975 (+4.7%) | ema 9 0.099 | line session | from ema+vwap | candle 3 | bounce 1 | since 3 | day high +25% | vwap 30s | tf 30S';
  const b = parseTvMessage(msg);
  check('BOUNCE parses', b?.stage === 'bounce' && b.ticker === 'PARA' && b.price === 0.1021 && b.stop === 0.0985 && b.svwap === 0.0975 && b.spx_pct === 4.7
    && b.ema_len === 9 && b.ema === 0.099 && b.line === 'session' && b.bounce_from === 'ema+vwap' && b.candle_tf === '3' && b.bounce_n === 1
    && b.since_n === 3 && b.day_gain === 25 && b.vwap_src === '30s' && b.tf === '30S' && b.weak === false && b.late === false, JSON.stringify(b));
  check('…no cross number, filter readings or VB fields', b?.cross_n === null && b?.under_n === null && b?.flips_n === null && b?.upper === null
    && b?.retest_n === null && b?.touch === null, JSON.stringify(b));
  const wk = parseTvMessage('BOUNCE OMH 8.12 | stop 8.01 | sVWAP 8.03 (+1.1%) | mVWAP 7.5 (+8.3%) | ema 9 8.06 | line session+month | from vwap | candle 5 | bounce 0 | since 9 | weak | late | vwap chart | tf 30S');
  check('…one after a weak cross: late, two lines, off the VWAP, a 5m EMA', wk?.weak === true && wk.late === true && wk.bounce_from === 'vwap' && wk.bounce_n === 0
    && wk.since_n === 9 && wk.line === 'session+month' && wk.candle_tf === '5' && wk.stop === 8.01 && wk.px_pct === 8.3, JSON.stringify(wk));
  check('…"from ema" alone, and JSON', parseTvMessage(msg.replace('from ema+vwap', 'from ema'))?.bounce_from === 'ema'
    && parseTvMessage({ stage: 'bounce', ticker: 'PARA', stop: 0.0985, bounce: 2, since: 4, from: 'ema', candle: '3' })?.bounce_n === 2
    && parseTvMessage({ stage: 'bounce', ticker: 'PARA', bounce_from: 'ema+vwap' })?.bounce_from === 'ema+vwap');
  check('…other stages carry no bounce fields, and "BOUNCE" as a ticker still parses as one',
    parseTvMessage('EMA X 1.0 | sVWAP 1 (+0%) | ema 9 1.0 | line session | candle 3 | cross 1 | under 9 | flips 0 | tf 30S')?.bounce_n === null
      && parseTvMessage('EMA X 1.0 | sVWAP 1 (+0%) | ema 9 1.0 | line session | candle 3 | cross 1 | tf 30S')?.bounce_from === null
      && parseTvMessage('PULLBACK BOUNCE 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'BOUNCE');
  check('BOUNCE rides the EMA switch', stageSwitch('bounce') === 'ema' && stageSwitch('ema') === 'ema' && !TV_STAGE_ORDER.includes('bounce'));
  check('BOUNCE on Momentum announces', new TvSetupGate().admit(b!, T0, false, true) === 'notify');
  const g = new TvSetupGate();
  check('…the same one again is a re-delivery; the next is a new event; an EMA cross on the same bar is its own event',
    g.admit(b!, T0, false, true) === 'notify' && g.admit(b!, T0 + 5, false, true) === 'drop'
      && g.admit({ ...b!, bounce_n: 2 }, T0 + 400, false, true) === 'notify'
      && g.admit(parseTvMessage('EMA PARA 0.1021 | sVWAP 0.0975 (+4.7%) | ema 9 0.099 | line session | candle 3 | cross 2 | under 6 | flips 1 | tf 30S')!, T0 + 400, false, true) === 'notify');
  check('…off Momentum quiet, with a +30% day high too; with the ⚙ rule off that one announces', new TvSetupGate().admit(b!, T0, false, false) === 'quiet'
    && new TvSetupGate().admit({ ...b!, day_gain: 31 }, T0, false, false) === 'quiet'
    && (() => { const x = new TvSetupGate(); x.setEmaMomentumOnly(false); return x.admit({ ...b!, day_gain: 31 }, T0, false, false) === 'notify'; })());
  check(`…past the cap (bounce ${TV_SETUP.em_cap + 1}) quiet`, pastCap({ ...b!, bounce_n: TV_SETUP.em_cap + 1 }) && !pastCap(b!)
    && new TvSetupGate().admit({ ...b!, bounce_n: TV_SETUP.em_cap + 1 }, T0, false, true) === 'quiet');
  check('…after a weak cross quiet, on Momentum too', new TvSetupGate().admit(wk!, T0, false, true) === 'quiet' && !pastCap(wk!));
  const off = new TvSetupGate();
  off.setAnnounced(['pullback', 'cross']);
  check('…the EMA switch off → quiet', off.admit(b!, T0, false, true) === 'quiet' && !off.announces('bounce'));
  const on = new TvSetupGate();
  on.setAnnounced(['ema']);
  check('…the EMA switch on → announces', on.announces('bounce') && on.admit(b!, T0, false, true) === 'notify');
  const html = formatTvSetupAlert(b!, 'NASDAQ:PARA', { change_pct: 24.1, grade: 'B+', float_m: 3.2 });
  check('Telegram: BOUNCE headline and what happened', html.includes('<b>BOUNCE</b>') && html.includes('<b>PARA</b>') && html.includes('$0.1021')
    && html.includes('after the 3m EMA 9 crossed above the session VWAP, price pulled back to the EMA and the VWAP and bounced (at the 3m close)'), html);
  check('Telegram: the stop, the count, the levels, Momentum', html.includes("stop $0.0985 (-3.5%, under the pullback's low)")
    && html.includes('bounce 1 today (first) · 3 candles after the cross') && html.includes('EMA $0.0990 · sVWAP $0.0975 (+4.7%)')
    && html.includes('on Momentum') && !html.includes('null') && !html.includes('weak'), html);
  const wkHtml = formatTvSetupAlert(wk!, 'NASDAQ:OMH', null);
  check('Telegram: one after a weak cross says so', wkHtml.includes('price pulled back to the VWAP and bounced (at the 5m close, a bar late)')
    && wkHtml.includes('after a weak cross') && wkHtml.includes('crossed above the session + month VWAP'), wkHtml);
}

// v47 (operator, 2026-11-25, on three moves of NIVF and one of APUS: "bb basis goes down (usually big drop), and after
// that, it starts moving up, price crosses it, and bounces (also, macd turns green)"; "I want to experiment with it,
// let's build it … a separate setup"): TURN, the script's fourth setup, sent from the 1m alert alone. Its own stage,
// ⚙ switch (on by default; it split from no other switch), cap (`turn N`) and Telegram text. The ⚙ rule "Momentum list
// only" that governs the EMA family governs it too. It names no VWAP line and has no weak filter.
const TURN_MSG = 'TURN NIVF 0.0213 | stop 0.0206 | sVWAP 0.0211 (+0.9%) | mVWAP 0.023 (-7.4%) | sma 15 0.0207 (+2.9%) | fall 12.3% | candle 1 | turn 1 | since 3 | green 1 | day high +25% | vwap 30s | tf 1';
console.log('TURN: the bounce off a basis that turned up (v47, 2026-11-25)');
{
  const T0 = 1_795_600_000;
  const t = parseTvMessage(TURN_MSG);
  check('v47: TURN parses — the head and the stop', t?.stage === 'turn' && t.ticker === 'NIVF' && t.price === 0.0213 && t.stop === 0.0206, JSON.stringify(t));
  check('v47: …the VWAP lines it carries (no year line here)', t?.svwap === 0.0211 && t.spx_pct === 0.9 && t.mvwap === 0.023 && t.px_pct === -7.4
    && t.yvwap === null && t.ypx_pct === null, JSON.stringify(t));
  check('v47: …the basis (`sma <length> <value> (<price vs it>%)`), its fall and its timeframe', t?.sma_len === 15 && t.sma === 0.0207 && t.sma_pct === 2.9
    && t.fall_pct === 12.3 && t.candle_tf === '1', JSON.stringify(t));
  check('v47: …the day\'s number, the candles after the break, the MACD green', t?.turn_n === 1 && t.since_n === 3 && t.macd_green === true, JSON.stringify(t));
  check('v47: …the day high, the VWAP source, and `tf 1` (the 1m alert sends it)', t?.day_gain === 25 && t.ah_gain === null && t.vwap_src === '30s' && t.tf === '1', JSON.stringify(t));
  check('v47: …no line, no cross / retest / bounce number, no EMA or band, not weak, not late', t?.line === null && t.cross_n === null && t.retest_n === null
    && t.bounce_n === null && t.bounce_from === null && t.ema === null && t.ema_len === null && t.upper === null && t.bb_tf === null && t.bb_mid === null
    && t.touch === null && t.fails === null && t.weak === false && t.late === false && JSON.stringify(lineTokens('turn', null)) === '[]', JSON.stringify(t));
  const bare = parseTvMessage('TURN APUS 1.52 | stop 1.47 | sma 15 1.5 (+1.3%) | candle 1 | turn 2 | since 1 | green 1 | vwap chart | tf 1');
  check('v47: a TURN without `| fall` and without the VWAP fields still parses', bare?.stage === 'turn' && bare.ticker === 'APUS' && bare.price === 1.52
    && bare.stop === 1.47 && bare.sma_len === 15 && bare.sma === 1.5 && bare.sma_pct === 1.3 && bare.fall_pct === null && bare.svwap === null
    && bare.spx_pct === null && bare.mvwap === null && bare.px_pct === null && bare.yvwap === null && bare.candle_tf === '1' && bare.turn_n === 2
    && bare.since_n === 1 && bare.macd_green === true && bare.day_gain === null && bare.vwap_src === 'chart' && bare.tf === '1', JSON.stringify(bare));
  const red = parseTvMessage(TURN_MSG.replace('green 1', 'green 0'));
  check('v47: `green 0` reads as the MACD not green; a message that doesn\'t say reads null',
    red?.macd_green === false && red.stage === 'turn' && red.turn_n === 1 && red.since_n === 3
      && parseTvMessage(TURN_MSG.replace(' | green 1', ''))?.macd_green === null, JSON.stringify(red));
  const full = parseTvMessage('TURN OMH 8.09 | stop 7.95 | sVWAP 8.01 (+1.0%) | mVWAP 7.5 (+7.9%) | yVWAP 9.2 (-12.1%) | sma 20 8.05 (+.5%) | fall 10.0% | candle 2 | turn 3 | since 10 | green 0 | day high +41% | ah +12% | vwap chart | tf 2');
  check('v47: all three VWAP lines, an after-hours gain, another basis (2m, 20 closes), a ".5" percent', full?.stage === 'turn' && full.svwap === 8.01
    && full.mvwap === 7.5 && full.px_pct === 7.9 && full.yvwap === 9.2 && full.ypx_pct === -12.1 && full.sma_len === 20 && full.sma === 8.05 && full.sma_pct === 0.5
    && full.fall_pct === 10 && full.candle_tf === '2' && full.turn_n === 3 && full.since_n === 10 && full.macd_green === false && full.day_gain === 41
    && full.ah_gain === 12 && full.vwap_src === 'chart' && full.tf === '2' && full.stop === 7.95, JSON.stringify(full));
  const pb = parseTvMessage('PULLBACK X 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')!;
  const bounce = parseTvMessage('BOUNCE OMH 8.2 | stop 8.0 | sVWAP 8.01 (+2.4%) | ema 9 8.1 | line session | from ema | candle 1 | bounce 1 | since 3 | vwap 30s | tf 30S')!;
  const band = parseTvMessage('EMA OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.13 (-0.5%) | bb 30S | mid 8.02 (+0.9%) | line session | candle 2 | cross 1 | under 12 | flips 1 | day high +25% | vwap 30s | tf 30S')!;
  const turnOnly = ['sma_len', 'sma', 'sma_pct', 'fall_pct', 'turn_n', 'macd_green'] as const;
  check('v47: the other stages\' messages carry no TURN reading', [pb, bounce, band,
    parseTvMessage('CROSS X 1.0 | sVWAP 0.98 (+2.0%) | upper 0.99 (+1.0%) | open 0.97 | candle 5 | bb 2 | cross 1 | tf 30S')!,
    parseTvMessage('RETEST X 1.0 | stop 0.97 | sVWAP 0.99 (+1.0%) | line session | candle 5 | bb 45S | retest 1 | vwap 30s | tf 30S')!]
    .every((s) => turnOnly.every((k) => s[k] === null)), JSON.stringify(bounce));
  // A JSON body: `stage: "turn"` and the signal's field names; the message's short names are read too.
  const js = parseTvMessage({ stage: 'turn', ticker: 'NIVF', price: 0.0213, stop: 0.0206, svwap: 0.0211, spx_pct: 0.9, mvwap: 0.023, px_pct: -7.4,
    sma_len: 15, sma: 0.0207, sma_pct: 2.9, fall_pct: 12.3, candle_tf: '1', turn_n: 1, since_n: 3, macd_green: true, day_gain: 25, vwap_src: '30s', tf: '1' });
  check('v47: the JSON body (stage "turn", the same field names) reads field for field as the message does',
    js != null && t != null && (Object.keys(t) as Array<keyof TvSetupSignal>).every((k) => js[k] === t[k]) && Object.keys(js).length === Object.keys(t).length,
    JSON.stringify(js));
  const jsShort = parseTvMessage('{"stage":"TURN","ticker":"nasdaq:nivf","price":"0.0213","stop":0.0206,"sma_len":15,"sma":0.0207,"fall":12.3,"turn":2,"since":3,"green":0,"candle":1,"vwap":"chart","tf":1}');
  check('v47: …JSON text, an exchange prefix and the message\'s short names (fall, turn, since, green, candle)', jsShort?.stage === 'turn' && jsShort.ticker === 'NIVF'
    && jsShort.price === 0.0213 && jsShort.fall_pct === 12.3 && jsShort.turn_n === 2 && jsShort.since_n === 3 && jsShort.macd_green === false
    && jsShort.candle_tf === '1' && jsShort.vwap_src === 'chart' && jsShort.tf === '1' && jsShort.sma_pct === null, JSON.stringify(jsShort));
  check('v47: …`green` as 1 / "1" / true is green, 0 / "0" / false is not, anything else or nothing is no reading',
    [1, '1', true].every((v) => parseTvMessage({ stage: 'turn', ticker: 'NIVF', green: v })?.macd_green === true)
      && [0, '0', false].every((v) => parseTvMessage({ stage: 'turn', ticker: 'NIVF', macd_green: v })?.macd_green === false)
      && parseTvMessage({ stage: 'turn', ticker: 'NIVF', green: 'yes' })?.macd_green === null
      && parseTvMessage({ stage: 'turn', ticker: 'NIVF' })?.macd_green === null
      && parseTvMessage({ stage: 'turn', ticker: 'NIVF' })?.turn_n === null);
  check('v47: a TURN ticker named like another head word still parses, and stays a TURN',
    ['EMA', 'BOUNCE', 'CROSS', 'RETEST', 'PULLBACK', 'BROKEN', 'HELD', 'TURN'].every((name) => {
      const s = parseTvMessage(TURN_MSG.replace('NIVF', name));
      return s?.stage === 'turn' && s.ticker === name && s.price === 0.0213 && s.turn_n === 1 && s.sma === 0.0207 && s.cross_n === null
        && s.bounce_n === null && s.retest_n === null && s.ema === null;
    }));
  check('v47: …"TURN" as another stage\'s ticker is a ticker, and "turn nivf" in lower case is a TURN',
    parseTvMessage('PULLBACK TURN 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.ticker === 'TURN'
      && parseTvMessage('PULLBACK TURN 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.stage === 'pullback'
      && parseTvMessage('PULLBACK TURN 1.0 | sVWAP 1 (+0%) | line session | touch 1 | tf 1')?.turn_n === null
      && parseTvMessage(TURN_MSG.toLowerCase())?.stage === 'turn' && parseTvMessage(TURN_MSG.toLowerCase())?.sma_len === 15);
  check('v47: …`sma`, `fall`, `turn` and `green` are read after a "|" only (tickers named SMA, FALL, GREEN)',
    (() => { const s = parseTvMessage('TURN SMA 15 | stop 14 | sma 20 14.5 (+3.4%) | candle 1 | turn 1 | since 2 | green 1 | tf 1');
      return s?.ticker === 'SMA' && s.price === 15 && s.sma_len === 20 && s.sma === 14.5 && s.sma_pct === 3.4; })()
      && parseTvMessage('CROSS GREEN 1 | candle 5 | bb 2 | cross 1 | tf 30S')?.macd_green === null
      && parseTvMessage('CROSS FALL 12 | upper 11.9 (+0.8%) | candle 5 | bb 2 | cross 1 | tf 30S')?.fall_pct === null);

  // The stage lists and the ⚙ switch
  check('v47: the stage lists — nine stages; the menu\'s eight with TURN after BAND, before BROKEN / HELD; six on by default; label TURN',
    Object.keys(TV_STAGE_LABEL).length === 9 && TV_STAGE_LABEL.turn === 'TURN'
      && JSON.stringify(TV_STAGE_ORDER) === '["pullback","cross","retest","ema","band","turn","broken","held"]'
      && JSON.stringify(DEFAULT_ANNOUNCED) === '["pullback","cross","retest","ema","band","turn"]'
      && JSON.stringify(new TvSetupGate().announcedStages()) === '["pullback","cross","retest","ema","band","turn"]');
  check('v47: TURN has its own switch (not the EMA\'s) and is none of the EMA family\'s, the VB\'s or the PULLBACK\'s stages',
    stageSwitch('turn') === 'turn' && new TvSetupGate().announces('turn') && !EMA_STAGES.has('turn') && !LINE_CROSS_STAGES.has('turn')
      && !VB_STAGES.has('turn') && !PULLBACK_STAGES.has('turn') && !emaByBand(t!) && emaLineStage({ stage: 'turn', bb_tf: '45S' }) === 'turn');
  const saved = { known: ['pullback', 'cross', 'retest', 'rsi', 'dip', 'macd', 'ema', 'band', 'basis', 'broken', 'held'], announced: ['pullback', 'band'] };
  check('v47: the operator\'s saved switches (PULLBACK and BAND on; the list never knew TURN) read back as PULLBACK, BAND, TURN',
    JSON.stringify(readStoredStages(saved)) === '["pullback","band","turn"]', JSON.stringify(readStoredStages(saved)));
  check('v47: a saved list that knows TURN and doesn\'t announce it keeps it off; one that announces it keeps it on',
    JSON.stringify(readStoredStages({ known: [...saved.known, 'turn'], announced: ['pullback', 'band'] })) === '["pullback","band"]'
      && JSON.stringify(readStoredStages(storedStages(['pullback', 'band']))) === '["pullback","band"]'
      && JSON.stringify(readStoredStages(storedStages(['pullback', 'band', 'turn']))) === '["pullback","band","turn"]'
      && JSON.stringify(readStoredStages(storedStages(['turn']))) === '["turn"]' && JSON.stringify(readStoredStages(storedStages([]))) === '[]'
      && storedStages(['pullback']).known.includes('turn'));
  check('v47: TURN split from no other switch: unknown to a saved list it is on, whatever the EMA\'s or the BAND\'s switch says',
    JSON.stringify(readStoredStages({ ...saved, announced: [] })) === '["turn"]'
      && JSON.stringify(readStoredStages({ ...saved, announced: ['ema'] })) === '["ema","turn"]'
      && JSON.stringify(readStoredStages({ ...saved, announced: ['ema', 'band', 'broken'] })) === '["ema","band","turn","broken"]'
      && JSON.stringify(readStoredStages(['pullback'])) === '["pullback","turn"]');
  check('v47: a posted list keeps TURN, in menu order', JSON.stringify(parseStageList(['held', 'TURN', 'pullback'])) === '["pullback","turn","held"]');

  // The gate: stored always; announced with its switch on, on Momentum (the EMA family's ⚙ rule), up to the cap
  check('v47: the cap is 3 TURNs a day on a ticker (`turn N`)', TV_SETUP.tn_cap === 3 && !pastCap(t!) && !pastCap({ ...t!, turn_n: 3 }) && pastCap({ ...t!, turn_n: 4 })
    && !pastCap({ ...t!, turn_n: null }) && !pastCap({ ...t!, turn_n: null, cross_n: 9, bounce_n: 9, retest_n: 9, fails: 9 }));
  check('v47: gate — on Momentum → announced', new TvSetupGate().admit(t!, T0, false, true) === 'notify');
  const g = new TvSetupGate();
  check('v47: gate — a re-delivery within 20 s is dropped; the next TURN three minutes later is a new event (one alert sends it: no copy to merge)',
    g.admit(t!, T0, false, true) === 'notify' && g.admit(t!, T0 + 5, false, true) === 'drop'
      && g.admit({ ...t!, turn_n: 2 }, T0 + 180, false, true) === 'notify' && g.admit({ ...t!, turn_n: 3 }, T0 + 360, false, true) === 'notify');
  check('v47: gate — off Momentum with the rule on (the default) → quiet, with a +30% day high too',
    new TvSetupGate().emaMomentumOnly() && new TvSetupGate().admit(t!, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...t!, day_gain: TV_SETUP.vb_fresh_gain }, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...t!, day_gain: 300 }, T0, false, false) === 'quiet');
  const lax = () => { const x = new TvSetupGate(); x.setEmaMomentumOnly(false); return x; };
  check(`v47: gate — off Momentum, the rule off, a day high ≥ +${TV_SETUP.vb_fresh_gain}% → announced; under it or without one, quiet; on the list either way`,
    lax().admit({ ...t!, day_gain: TV_SETUP.vb_fresh_gain }, T0, false, false) === 'notify' && lax().admit({ ...t!, day_gain: 264 }, T0, false, false) === 'notify'
      && lax().admit({ ...t!, day_gain: TV_SETUP.vb_fresh_gain - 1 }, T0, false, false) === 'quiet' && lax().admit(t!, T0, false, false) === 'quiet'
      && lax().admit({ ...t!, day_gain: null }, T0, false, false) === 'quiet' && lax().admit(t!, T0, false, true) === 'notify');
  check('v47: gate — `turn 4` → quiet (past the cap): on Momentum, as a fresh runner with the rule off, and with a grade exemption alike; `turn 3` announces',
    new TvSetupGate().admit({ ...t!, turn_n: 4 }, T0, false, true) === 'quiet'
      && lax().admit({ ...t!, turn_n: 4, day_gain: 264 }, T0, false, false) === 'quiet'
      && new TvSetupGate().admit({ ...t!, turn_n: 4 }, T0, true, true) === 'quiet'
      && new TvSetupGate().admit({ ...t!, turn_n: 3 }, T0, false, true) === 'notify');
  const only = (stages: Parameters<TvSetupGate['setAnnounced']>[0]) => { const x = new TvSetupGate(); x.setAnnounced(stages); return x; };
  check('v47: gate — its ⚙ switch off → quiet, on Momentum too; the EMA\'s and the BAND\'s switches don\'t announce it',
    only(['pullback', 'cross', 'retest', 'ema', 'band']).admit(t!, T0, false, true) === 'quiet'
      && !only(['pullback', 'cross', 'retest', 'ema', 'band']).announces('turn') && only([]).admit(t!, T0, false, true) === 'quiet');
  check('v47: gate — its switch alone on → the TURN announces, and no EMA, BAND or BOUNCE with it',
    only(['turn']).admit(t!, T0, false, true) === 'notify' && only(['turn']).announces('turn') && !only(['turn']).announces('ema')
      && !only(['turn']).announces('bounce') && only(['turn']).admit(band, T0, false, true) === 'quiet'
      && only(['turn']).admit(bounce, T0, false, true) === 'quiet');
  check('v47: gate — a quiet TURN uses nothing up: the same ticker\'s next one, on Momentum, announces',
    (() => { const q = new TvSetupGate(); return q.admit(t!, T0, false, false) === 'quiet' && q.admit({ ...t!, turn_n: 2 }, T0 + 240, false, true) === 'notify'; })());
  check('v47: gate — the key carries the ticker, the stage and the basis\'s timeframe: another basis timeframe, another ticker or a BOUNCE on that bar is its own event',
    (() => { const k = new TvSetupGate();
      return k.admit(t!, T0, false, true) === 'notify' && k.admit({ ...t!, candle_tf: '2' }, T0, false, true) === 'notify'
        && k.admit({ ...t!, ticker: 'APUS' }, T0, false, true) === 'notify' && k.admit({ ...bounce, ticker: 'NIVF' }, T0, false, true) === 'notify'
        && k.admit(t!, T0 + 1, false, true) === 'drop' && k.admit({ ...t!, candle_tf: '2' }, T0 + 1, false, true) === 'drop'
        && k.admit(t!, T0 + TV_SETUP.vb_dup_sec + 1, false, true) === 'notify'; })());
  check('v47: the other stages\' gates are as they were: a CROSS off the list with a +30% day high announces; a BAND there stays quiet',
    new TvSetupGate().admit(parseTvMessage('CROSS OMH 8.09 | sVWAP 8.01 (+1.0%) | upper 8.0 (+1.1%) | open 7.9 | line session | candle 5 | bb 45S | cross 1 | day high +31% | tf 30S')!, T0, false, false) === 'notify'
      && new TvSetupGate().admit({ ...band, day_gain: 31 }, T0, false, false) === 'quiet' && new TvSetupGate().admit(band, T0, false, true) === 'notify');

  // Telegram
  const html = formatTvSetupAlert(t!, 'NASDAQ:NIVF', { change_pct: 24.1, grade: 'B+', float_m: 3.2 });
  check('v47: Telegram — the TURN headline (⭐ on Momentum), the ticker, the price', html.startsWith('⭐ 📐 ⤴️ <b>TURN</b>  <b>NIVF</b>  $0.0213\n'), html);
  check('v47: Telegram — what happened, in words: the basis, its fall, the close above it, the bounce',
    html.includes('<i>after its 1m basis (SMA 15) fell 12.3% and turned up, price closed above it, came back to it and bounced (at the 1m close)</i>'), html);
  check('v47: Telegram — the stop with its distance, the day\'s number, the candles after the break, the MACD',
    html.includes("\nstop $0.0206 (-3.3%, under the pullback's low) · turn 1 today (first) · 3 candles after the close above the basis · MACD green\n"), html);
  check('v47: Telegram — the basis with the price against it, then the VWAP lines the message carries',
    html.includes('\nbasis $0.0207 (+2.9%) · sVWAP $0.0211 (+0.9%) · mVWAP $0.0230 (-7.4%)\n') && !html.includes('yVWAP'), html);
  check('v47: Telegram — Momentum, the context, the links; nothing null or undefined', html.includes('⭐ <b>on Momentum</b> · grade B+ · now +24.1% · float 3.2M')
    && html.includes('day high +25% · tf 1') && html.includes('symbol=NASDAQ%3ANIVF') && html.includes('finviz.com/quote.ashx?t=NIVF')
    && !html.includes('null') && !html.includes('undefined') && !html.includes('weak') && !html.includes('EMA'), html);
  const capHtml = formatTvSetupAlert({ ...full!, turn_n: 4 }, 'NASDAQ:OMH', null);
  check('v47: Telegram — past the cap, the MACD not green, the year line, a 2m basis, off Momentum (no ⭐)',
    capHtml.startsWith('📐 ⤴️ <b>TURN</b>  <b>OMH</b>  $8.09\n') && capHtml.includes('after its 2m basis (SMA 20) fell 10.0% and turned up')
      && capHtml.includes('bounced (at the 2m close)') && capHtml.includes("stop $7.95 (-1.7%, under the pullback's low) · turn 4 today — past the cap")
      && capHtml.includes('10 candles after the close above the basis · MACD not green')
      && capHtml.includes('basis $8.05 (+0.5%) · sVWAP $8.01 (+1.0%) · mVWAP $7.50 (+7.9%) · yVWAP $9.20 (-12.1%)')
      && capHtml.includes('not on our Momentum list') && capHtml.includes('day high +41% · after hours +12% · tf 2') && !capHtml.includes('⭐'), capHtml);
  const bareHtml = formatTvSetupAlert(bare!, 'APUS', null);
  check('v47: Telegram — without a fall or VWAP lines: no "fell", the basis alone, "1 candle"',
    bareHtml.includes('<i>after its 1m basis (SMA 15) turned up, price closed above it, came back to it and bounced (at the 1m close)</i>')
      && !bareHtml.includes('fell') && bareHtml.includes('turn 2 today · 1 candle after the close above the basis · MACD green')
      && bareHtml.includes('\nbasis $1.50 (+1.3%)\n') && !bareHtml.includes('VWAP $') && !bareHtml.includes('null') && !bareHtml.includes('undefined'), bareHtml);
  const jsHtml = formatTvSetupAlert(parseTvMessage({ stage: 'turn', ticker: 'NIVF' })!, 'NIVF', null);
  check('v47: Telegram — a bare JSON TURN renders without levels, a MACD word, null or undefined', jsHtml.includes('<b>TURN</b>  <b>NIVF</b>')
    && !jsHtml.includes('MACD') && !jsHtml.includes('basis $') && !jsHtml.includes('stop') && !jsHtml.includes('null') && !jsHtml.includes('undefined'), jsHtml);

  // What a TURN row stores (tier_events meta), and what a reloaded page reads back (GET /api/screener/alerts)
  const row = turnFields(t!);
  check('v47: a TURN row stores its nine fields (turnFields); other stages store none of them, and a TURN none of the VB\'s or the EMA family\'s',
    JSON.stringify(row) === JSON.stringify({ candle_tf: '1', stop: 0.0206, since_n: 3, sma_len: 15, sma: 0.0207, sma_pct: 2.9, fall_pct: 12.3, turn_n: 1, macd_green: true })
      && Object.keys(turnFields(bounce)).length === 0 && Object.keys(turnFields(pb)).length === 0 && Object.keys(turnFields(band)).length === 0
      && Object.keys(vbFields(t!)).length === 0 && Object.keys(emaFields(t!)).length === 0, JSON.stringify(row));
  const stored = storedSetupFields({ stage: 'turn', price: 0.0213, svwap: 0.0211, tf: '1', ...row });
  check('v47: storedSetupFields copies the TURN\'s fields — sma_len, sma, sma_pct, fall_pct, turn_n as numbers, macd_green as a boolean — with stop, since_n and candle_tf',
    stored.sma_len === 15 && stored.sma === 0.0207 && stored.sma_pct === 2.9 && stored.fall_pct === 12.3 && stored.turn_n === 1 && stored.macd_green === true
      && stored.stop === 0.0206 && stored.since_n === 3 && stored.candle_tf === '1' && Object.keys(stored).length === 9, JSON.stringify(stored));
  check('v47: …`green 0` comes back false; a row without a fall has it as null; junk reads as null',
    storedSetupFields({ stage: 'turn', ...turnFields(red!) }).macd_green === false
      && 'fall_pct' in storedSetupFields({ stage: 'turn', ...turnFields(bare!) }) && storedSetupFields({ stage: 'turn', ...turnFields(bare!) }).fall_pct === null
      && storedSetupFields({ sma_len: '15', sma: 'x', turn_n: null, macd_green: 'yes' }).sma_len === null
      && storedSetupFields({ sma_len: '15', sma: 'x', turn_n: null, macd_green: 'yes' }).sma === null
      && storedSetupFields({ sma_len: '15', sma: 'x', turn_n: null, macd_green: 'yes' }).turn_n === null
      && storedSetupFields({ sma_len: '15', sma: 'x', turn_n: null, macd_green: 'yes' }).macd_green === null);
  check('v47: …a row of another stage gets none of them, and a stored TURN row\'s stage reads `turn`',
    turnOnly.every((k) => !(k in storedSetupFields({ stage: 'bounce', ...emaFields(bounce) })))
      && turnOnly.every((k) => !(k in storedSetupFields({ stage: 'band', ...emaFields(band) })))
      && turnOnly.every((k) => !(k in storedSetupFields({ stage: 'pullback', touch: 1, line: 'session' })))
      && storedStage({ stage: 'turn', ...row }) === 'turn');
}

console.log('Contract — the Pine script still emits what the parser reads');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const pine = readFileSync(resolve(here, '../../web/src/tv/mvwap-bb-setup.pine'), 'utf8');
  for (const part of ['" | mVWAP "', '" | day high "', '" | ah "', '" | tf "', '" | vol "', '" | run "',
    '"PULLBACK"', '"BROKEN"', '"HELD"', '" | sVWAP "', '" | line "', '" | touch "', '" | peak +"', '"session"', '"month"',
    '" | yVWAP "', '"year"', 'timeframe.change("M") or firstBar', 'firstBar = na(hlc3[1])',
    // v14: the year line from this year's hourly bars + today's chart bars; merged lines are named together
    'request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", anchorsBefore()', 'timeframe.change("12M")',
    'pbJoin(names, "year")',
    // v15: the day's PULLBACK cap counts failed pullbacks, not every touch
    's.fails < pbMax', 's.fails := s.fails + 1',
    // v16: no cap in the script by default; each PULLBACK says how many failed before it
    'pbMax == 0 or s.fails < pbMax', '" | fails "', 'fails := math.min(fails, pbY.fails)', 'pbCapMark',
    // v21: the VWAP + BB cross from the 30s alert, drawn on the candle's chart; the setup switches
    '"CROSS "', '" | upper "', '" | open "', '" | candle "', '" | bb "', '" | cross "',
    'vbSend  = vbOk and timeframe.period == vbTf', 'timeframe.change(cTf)', 'timeframe.change(bTf)',   // v29: per lane
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
    // v27: two setups; the operator's settings are the defaults (gainer 10%; since v44 a 2m VB candle on a 30s band,
    // 5m and 45s before)
    'if pbOn and inWindow', 'input.float(10.0, "Up at least %', 'input.timeframe("2",     "VB: candle timeframe',
    'input.timeframe("30S",   "VB: BB timeframe (the band)"', '"VB: BB timeframe (the band)"',
    // v28: RETEST (the operator's entry) in the VB break's place, the 30s-bar VWAP option, the operator's tolerance 0
    // (the header: the script's version, and since v47 four setups — it was "Three setups … the EMA cross)")
    'Script version: v47 (2026-11-25)', 'Four setups in one script (PULLBACK, the VWAP + BB cross, the EMA cross, TURN)', '"RETEST "', '" | stop "', '" | retest "',
    'low <= vRtLine * (1 + vbRtNear / 100)', 'close > vRtLine and close > open', 'vRtStop  := vRtLow - syminfo.mintick',
    // v30: the RETEST waits for the close of the candle that came back (above the line), on its closing bar
    'bool vEndsNow  = time_close == time_close(cTf)', 'bool vRtGo = rtAtClose ? vEndsNow and close > vRtLine :',
    'if rtAtClose and vRtArmed and vRtTouch and not vEndSeen and not na(vOpen)', 'options = ["Candle close", "30s bounce"]',
    'str.tostring(na(lPx) ? close : lPx, format.mintick)', 'vbCandleTf, vbBbTf, vbRtPx), alert.freq_once_per_bar_close)',
    // v31: the month line's own switch — this month's hourly bars + today's 30s bars, drawn, used by PULLBACK and the VB;
    // a late RETEST is drawn on its own candle (one bar back)
    'mvSrc      = input.string("30s bars", "Month VWAP from (v31)', '[yPrevPV, yPrevV, mPrevPV, mPrevV] = request.security(',
    'mvwap = mv30 ? (na(mPrevV) or mPrevV + s30V <= 0 ? na : (mPrevPV + s30PV) / (mPrevV + s30V)) : mvChart',
    'need30  = (use30 or mv30) and chartSec > 30', 'float vMPV    = mv30 ? vPV30 : vTPV', 'evM := pbM.step(mvwap, gainer, pbLowMY)',
    'vRtLate  := true', '"VB retest, late close (v31)"', 'size = size.small, offset = -1)',
    'vbHighest(vRtS, vRtM, vRtY, vVw, vMw, vYw)', 'vbRtWait > 0 and vRtAge >= vbRtWait', 'text = "RT"',
    '" | vwap " + (use30 ? "30s" : "chart")', 'options = ["30s bars", "Chart bars"]',
    'request.security_lower_tf(syminfo.tickerid, need30 ? "30S" : timeframe.period, [hlc3 * volume, volume])',
    'float vTPV    = use30 ? vPV30 :', 'svwap = lower30 ?', 'input.float(0.0,         "VB: the candle may open up to %',
    'size = size.tiny, display = display.none',
    // v29's vbStep() (the VB as a function of its candle and band timeframes) stays; v39 removed the three extra lanes
    // that called it, so the one VB is the only caller: on the 30s alert and in the chart's replay
    'vbStep(simple string cTf, simple string bTf, bool onS, bool onM, bool onY, bool laneOk) =>',
    '= vbStep(vbCandleTf, vbBbTf, vbSession, vbMonth, vbYear, vbOk)',
    'bool vCarry    = timeframe.in_seconds(cTf) >= 14400',
    'if vRtArmed and (vRtS or not vCarry)', 'not (gNewDay and (vSFired or not vCarry))',
    'alert(vbMsg(vbFireS, vbFireM, vbFireY', 'alert(vbRtMsg(vbRtS, vbRtM, vbRtY',
    'vbLower    = vbOk and vbShow and timeframe.period == vbCandleTf and vbChartSec > vbBaseSec',
    // (v32's RSI cross and v34's DIP were pinned here until v44 removed them; the removal's own checks are below.)
    // v35: the EMA cross over VWAP — the EMA of a timeframe's closes from a request (lookahead on + [1]) plus the live
    // close, judged at that timeframe's candle closes (late ones first, never announced across the day's end), per line.
    // rsSym and rsChartSec keep the names the RSI section gave them. v44: the EMA's candle is 2m by default (3m before)
    '"EMA "', '" | late"', '" | ema " + str.tostring(emLen) + " " + str.tostring(e, format.mintick)', '" | candle " + emTf + " | cross " + str.tostring(n)',
    'rsSym = ticker.new(syminfo.prefix, syminfo.ticker, session.extended)', 'rsChartSec = timeframe.in_seconds(timeframe.period)',
    'emPrevE = request.security(rsSym, emTf, ta.ema(close, emLen)[1], lookahead = barmerge.lookahead_on)',
    'emLive  = emAlpha * close + (1 - emAlpha) * emPrevE', 'emOk    = emOn and rsChartSec <= emTfSec and emTfSec % rsChartSec == 0',
    'type EmaLine', 'method crossUp(EmaLine s, array<int> hist, float e, float ln) =>', 's.prevE <= s.prevL and e > ln',
    'emEnd = time_close == time_close(emTf)', 'bool emOkL = inWindow and not newDay and (not emGainOn or gainer[1])',
    'bool emOkC = inWindow and (not emGainOn or gainer)', 'emS.restart(emHS)',
    'input.timeframe("2", "EMA: candle timeframe', 'input.int(9,         "EMA: length"',
    'alert(emMsg(emLS, emLM, emLY, emLN, close[1], emLive[1], svwap[1], mvwap[1], yvwap[1], true, emLU, emLF, emLW, false, na), alert.freq_once_per_bar_close)',
    'alert(emMsg(emCS, emCM, emCY, emCN, close, emLive, svwap, mvwap, yvwap, false, emCU, emCF, emCW, false, na), alert.freq_once_per_bar_close)',
    '"EMA (EMA cross, v35)"', '"EMA cross (v35)"', '"EMA cross, late close (v35)"', '"sVWAP (EMA cross, v35)"',
    // v36: the filter — how long the EMA sat under the line, the crossings in the 20 candles before, the candle's hour in
    // New York; a weak cross says so, takes no day's number and is drawn gray
    '" | under " + str.tostring(under) + " | flips " + str.tostring(flips)', 'msg += " | weak"',
    'emWeak(EmaLine s, bool early) => emFilterOn and (early or s.ran < emMinUnder or s.flips > emMaxFlips)',
    's.ran := s.under', 's.under := e > ln ? 0 : s.under + 1', 'array.push(hist, e > ln ? 1 : 0)', 'if array.size(hist) > 20',
    'bool emEarlyL = hour(emT[1], "America/New_York") < emFromHour', 'bool emEarlyC = hour(emT, "America/New_York") < emFromHour',
    'emLW := not (emG1 or emG2 or emG3)', 'emCW := not (emG4 or emG5 or emG6)',
    'input.int(5,        "EMA filter: the EMA was under the line for at least N candles', 'input.int(2,        "EMA filter: at most N EMA / line crossings',
    'input.int(7,        "EMA filter: not before this hour, New York time',
    'plotshape(emShow and (emCS or emCM or emCY) and not emCW, "EMA cross (v35)"', 'plotshape(emShow and (emLS or emLM or emLY) and not emLW, "EMA cross, late close (v35)"',
    '"EMA cross, filtered (v36)"', '"EMA cross, filtered, late close (v36)"',
    // v37: the BOUNCE — a sent cross arms a wait; a candle's low at the EMA or the line, then a green close above the EMA;
    // a close under the line, the wait's end, a newer cross or the day's end stop it; the stop a tick under the pullback's low
    '"BOUNCE "', '" | stop " + str.tostring(stop, format.mintick)', '" | from " + (hitE and hitV ? "ema+vwap" : hitE ? "ema" : "vwap")',
    '" | candle " + emTf + " | bounce " + str.tostring(n) + " | since " + str.tostring(age)',
    'method arm(EmaLine s, bool weak) =>', 'method stepBounce(EmaLine s, float e, float ln, float cOpen, float cLow, float cClose) =>',
    'if emBncE and cLow <= e * (1 + emBncTolE / 100)', 'if emBncV and cLow <= ln * (1 + emBncTolV / 100)',
    's.lowP := na(s.lowP) ? cLow : math.min(s.lowP, cLow)', 'if cClose < ln', 'else if (s.hitE or s.hitV) and cClose > cOpen and cClose > e',
    'else if s.age >= emBncWait', 'emBncE = emBncFrom != "VWAP"', 'emBncV = emBncFrom != "EMA"',
    'bool emB1 = emBncOn and emSession and emS.stepBounce(emLive[1], svwap[1], emCOp, emCLp, close[1])',
    'bool emB4 = emBncOn and emSession and emS.stepBounce(emLive, svwap, emCO, emCL, close)',
    'bool emH1 = emBLS and not emS.weakX', 'emBLStop := emBLo1 - syminfo.mintick', 'emBCStop := emBLo2 - syminfo.mintick',
    'emS.arm(not emG1)', 'emS.arm(not emG4)', 'emM.armed := false', 'emS.bn := 0',
    'input.string("EMA or VWAP", "EMA bounce: the pullback comes down to", options = ["EMA or VWAP", "EMA", "VWAP"]',
    'input.int(10,              "EMA bounce: within N candles after the cross"', 'input.float(1.0,           "EMA bounce: a low within this % above the VWAP',
    'alert(emBncMsg(emBLS, emBLM, emBLY, emBLN, close[1], emLive[1], svwap[1], mvwap[1], yvwap[1], true, emBLStop, emBLAge, emBLE, emBLV, emBLW), alert.freq_once_per_bar_close)',
    'alert(emBncMsg(emBCS, emBCM, emBCY, emBCN, close, emLive, svwap, mvwap, yvwap, false, emBCStop, emBCAge, emBCE, emBCV, emBCW), alert.freq_once_per_bar_close)',
    '"EMA bounce (v37)"', '"EMA bounce, late close (v37)"', '"EMA bounce, filtered (v37)"', '"EMA bounce, filtered, late close (v37)"',
    // (v39's MACD cross after a DIP was pinned here until v44 removed it.)
    // v40: the line that crosses the VWAP — the EMA, the BB upper band (the VB's, rebuilt from the alert timeframe's bars
    // and replayed on bigger charts) or both; the band's crosses have their own lines and day's numbers, and send the EMA's
    // message with `| upper … | bb …` in the place of `| ema …`; the BOUNCE stays the EMA's. v44: "BB upper" is the default
    'options = ["EMA", "BB upper", "Both"]', 'emUseE  = emSrc != "BB upper"', 'emUseB  = emSrc != "EMA"',
    'emSrc   = input.string("BB upper", "EMA cross: the line that crosses the VWAP (v40)',
    'emBand(simple string bTf) =>', 'bool bNew = timeframe.change(bTf)', 'if array.size(bCloses) > vbLen - 1', 'if bN == vbLen - 1',
    'bUp  := bMean + vbMult * math.sqrt(bSq / vbLen)',
    'emBbOk    = rsChartSec >= vbBaseSec and rsChartSec % vbBaseSec == 0 and timeframe.in_seconds(vbBbTf) >= vbBaseSec',
    '[emBbIn, emBbMidIn] = request.security_lower_tf(syminfo.tickerid, emBbLower ? vbTf : timeframe.period, emBand(vbBbTf))',
    'emBb    := array.get(emBbIn, array.size(emBbIn) - 1)',
    // v41: the band's middle line beside it; a band cross whose candle closed under the middle (the band widened on a
    // drop) is weak with bbMidOn, and every band cross's message carries `| mid <line> (<price vs it>%)`
    'bMid := bMean', '[bUp, bMid]', 'emBbMid := array.get(emBbMidIn, array.size(emBbMidIn) - 1)',
    'bbMidOn = input.bool(true, "BB cross (v41): a cross with the candle closing under the band\'s middle line',
    'bool drop = bbMidOn and not na(mid) and px < mid', 'bool g2 = f2 and not drop and not emWeak(m, early)',
    'if not na(mid)', 'msg += " | mid " + str.tostring(mid, format.mintick) + " (" + emPct(px, mid) + "%)"',
    '"BB middle (EMA cross, v41)"', 'display = display.none)',
    // (v42's BASIS cross was pinned here until v44 removed it.) What v42 gave the EMA's and the band's messages stays:
    // emMsgBy, the message by the line that crossed — `kind` "ema" or "bb" since v44
    'emMsgBy(bool fS, bool fM, bool fY, int n, float px, float e, float sv, float mv, float yv, bool late, int under, int flips, bool weak, string kind, float mid) =>',
    'if kind == "bb"',
    'emMsgBy(fS, fM, fY, n, px, e, sv, mv, yv, late, under, flips, weak, band ? "bb" : "ema", mid)',
    'emOk    = emOn and rsChartSec <= emTfSec and emTfSec % rsChartSec == 0 and emUseE',
    'bbOk    = emOn and rsChartSec <= emTfSec and emTfSec % rsChartSec == 0 and emUseB and emBbOk',
    'bbSample(EmaLine s, EmaLine m, EmaLine y, array<int> hs, array<int> hm, array<int> hy, float b, float sv, float mv, float yv, bool ok, bool early, float px, float mid) =>',
    'bool x1 = emSession and s.crossUp(hs, b, sv)', 'bool g1 = f1 and not drop and not emWeak(s, early)', '[f1, f2, f3, n, u, f, weak]',
    'bool bbLateS = not na(emT[1]) and emT != emT[1] and (na(bbDone) or bbDone != emT[1])',
    'bool bbOkL    = inWindow and not newDay and (not emGainOn or gainer[1])', 'bool bbOkC    = inWindow and (not emGainOn or gainer)',
    'bbSample(bbS, bbM, bbY, bbHS, bbHM, bbHY, emBb[1], svwap[1], mvwap[1], yvwap[1], bbOkL, bbEarlyL, close[1], emBbMid[1])',
    'bbSample(bbS, bbM, bbY, bbHS, bbHM, bbHY, emBb, svwap, mvwap, yvwap, bbOkC, bbEarlyC, close, emBbMid)', 'bbS.restart(bbHS)',
    'if emEnd and (na(bbDone) or bbDone != emT)',
    'emMsg(bool fS, bool fM, bool fY, int n, float px, float e, float sv, float mv, float yv, bool late, int under, int flips, bool weak, bool band, float mid) =>',
    'msg += " | upper " + str.tostring(e, format.mintick) + " (" + emPct(px, e) + "%) | bb " + vbBbTf',
    'alert(emMsg(bbLS, bbLM, bbLY, bbLN, close[1], emBb[1], svwap[1], mvwap[1], yvwap[1], true, bbLU, bbLF, bbLW, true, emBbMid[1]), alert.freq_once_per_bar_close)',
    'alert(emMsg(bbCS, bbCM, bbCY, bbCN, close, emBb, svwap, mvwap, yvwap, false, bbCU, bbCF, bbCW, true, emBbMid), alert.freq_once_per_bar_close)',
    '"BB upper (EMA cross, v40)"', '"BB upper cross over VWAP (v40)"', '"BB upper cross, late close (v40)"', '"BB upper cross, filtered (v40)"',
    '"BB upper cross, filtered, late close (v40)"', 'text = "BB"']) {
    check(`script emits ${part}`, pine.includes(part));
  }
  // v40: the EMA's own crosses, bounce and marks read the EMA whichever line is chosen (only emOk switches them)
  check('v40: the EMA\'s block still reads the EMA, and its marks carry no band switch', !pine.includes('emSig') && !pine.includes('emUseBb')
    && pine.includes('bool emX1 = emSession and emS.crossUp(emHS, emLive[1], svwap[1])') && pine.includes('bool emX4 = emSession and emS.crossUp(emHS, emLive, svwap)')
    && pine.includes('plot(emOk and emShow ? emLive : na, "EMA (EMA cross, v35)", color.aqua)'));
  check('v40: the band\'s late sample, then the day\'s restart, then its on-time sample; after the EMA\'s block, before the messages',
    pine.indexOf('if bbLateS') > pine.indexOf('emY.arm(not emG6)') && pine.indexOf('if bbLateS') < pine.indexOf('bbS.restart(bbHS)')
    && pine.indexOf('bbS.restart(bbHS)') < pine.indexOf('if emEnd and (na(bbDone) or bbDone != emT)')
    && pine.indexOf('if emEnd and (na(bbDone) or bbDone != emT)') < pine.indexOf('emPct(float px, float ln) =>'));
  // 2026-11-16: v42's first paste failed in the Pine editor ("Syntax error at input 'fS'") because a function parameter
  // was named `by`, a reserved word. The script can't be compiled here, so at least no parameter, declared variable,
  // tuple target or loop counter may be a Pine keyword.
  {
    const reserved = new Set(['and', 'as', 'by', 'catch', 'class', 'const', 'continue', 'do', 'else', 'enum', 'export', 'false', 'for', 'if',
      'import', 'in', 'input', 'is', 'method', 'not', 'or', 'return', 'series', 'simple', 'switch', 'to', 'true', 'try', 'type', 'var', 'varip',
      'while', 'break']);
    const bad: string[] = [];
    pine.split('\n').forEach((raw, i) => {
      const line = raw.split('//')[0];
      const fn = /^\s*(?:export\s+)?(?:method\s+)?([A-Za-z_]\w*)\s*\((.*)\)\s*=>/.exec(line);
      if (fn) {
        for (const part of fn[2].split(',')) {
          const words = part.split('=')[0].replace(/<[^>]*>/g, '').trim().split(/\s+/);
          const name = words[words.length - 1];
          if (name && reserved.has(name)) bad.push(`line ${i + 1}: parameter ${name} of ${fn[1]}()`);
        }
      }
      const decl = /^\s*(?:var\s+|varip\s+)?(?:(?:simple|series|const)\s+)?(?:[A-Za-z_]\w*(?:<[^>]*>)?\s+)?([A-Za-z_]\w*)\s*(?::=|=(?![=>]))/.exec(line);
      if (decl && reserved.has(decl[1])) bad.push(`line ${i + 1}: variable ${decl[1]}`);
      const tuple = /^\s*\[([^\]]*)\]\s*=/.exec(line);
      if (tuple) for (const name of tuple[1].split(',').map((x) => x.trim())) if (reserved.has(name)) bad.push(`line ${i + 1}: tuple target ${name}`);
      const loop = /^\s*for\s+(?:\[([^\]]*)\]|([A-Za-z_]\w*))/.exec(line);
      if (loop) for (const name of (loop[1] ?? loop[2] ?? '').split(',').map((x) => x.trim())) if (reserved.has(name)) bad.push(`line ${i + 1}: loop counter ${name}`);
    });
    check('no Pine reserved word is used as a parameter, a variable, a tuple target or a loop counter', bad.length === 0, bad.join('; '));
    check('…the scan sees the mistake it is there for', (() => {
      const m = /^\s*([A-Za-z_]\w*)\s*\((.*)\)\s*=>/.exec('emMsgBy(bool weak, string by, float mid) =>');
      return m != null && m[2].split(',').some((p) => reserved.has(p.trim().split(/\s+/).pop() ?? ''));
    })());
  }
  check('v26: no 30s-close cancel of the VB level left', !pine.includes('close < vLvLine'));
  // v39 removed the DIP's LIFT (v38) and the three extra VB lanes (v29): none of their inputs, state, messages or plots are left.
  for (const gone of ['"LIFT "', 'rsLift', 'lfLevel', 'lfGo', 'rsLiftMsg', '" | lift "', '" | up "', '" | by "', '"DIP lift', 'text = "LIFT"',
    'vb2On', 'vb3On', 'vb4On', 'vb2Cndl', 'vb4Bb', 'vb2Ok', 'vlN', 'vlCndl', 'vlOk', 'v2FireS', 'v4RtPx', '"Lane ', 'timeframe.main_period']) {
    check(`v39: script no longer has ${gone}`, !pine.includes(gone));
  }
  // v44 removed the RSI cross with its DIP (v32–v34, section 3), the MACD cross after a DIP (v39, section 5) and the BASIS
  // cross (v42, section 4c): none of their messages, inputs, state, requests or plots are left. Each removed spot keeps a
  // one-line comment that may name what sat there, so these are looked for in code lines only.
  {
    const code = pine.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const gone of ['"RSI "', '"DIP "', '"MACD "', '" | rsi "', '" ma "', '" | low "', '" | dip "', '" | macd "', '" | base "', '" | after "',
      '" | basis "', '" | len "', '"bs"', 'rsState(', 'mcState(', 'bsBasis(', 'RsiSetup', 'stepDip(', 'rsDipMsg(', 'mcMsg(', 'ta.rma(',
      '"RSI: ', '"MACD: ', '"Basis: ', '"RSI cross', '"RSI dip', '"MACD after a DIP', '"Basis ', 'text = "MACD"', 'text = "BS"']) {
      check(`v44: script no longer has ${gone}`, !code.includes(gone));
    }
    for (const gone of ['rsOn', 'rsCheck', 'rsTfA', 'rsDipOn', 'rsDipMax', 'mcOn', 'mcTf', 'mcShow', 'bsOn', 'bsTf', 'bsLen', 'emBs']) {
      check(`v44: no code line names ${gone}`, !new RegExp(`\\b${gone}\\b`).test(code));
    }
    const left = [...new Set(code.match(/\b(?:rs|mc|bs)[A-Z0-9]\w*/g) ?? [])].sort();
    check('v44: of the removed sections\' names (rs… / mc… / bs…) only the two the EMA section uses are left, rsChartSec and rsSym',
      JSON.stringify(left) === '["rsChartSec","rsSym"]', left.join(', '));
    const lines = pine.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l));
    const firstAt = (name: string) => lines.findIndex((l) => new RegExp(`\\b${name}\\b`).test(l));
    const declared = (name: string) => lines.filter((l) => new RegExp(`^\\s*${name}\\s*=[^=]`).test(l)).length;
    check('v44: rsSym is declared once, and before its first use (the EMA\'s request)',
      declared('rsSym') === 1 && firstAt('rsSym') >= 0 && lines[firstAt('rsSym')].startsWith('rsSym = ticker.new(syminfo.prefix, syminfo.ticker, session.extended)')
        && firstAt('rsSym') < lines.findIndex((l) => l.includes('request.security(rsSym, emTf,')), `line ${firstAt('rsSym') + 1}`);
    check('v44: rsChartSec is declared once, and before its first use (the band\'s and the EMA\'s chart tests)',
      declared('rsChartSec') === 1 && firstAt('rsChartSec') >= 0 && lines[firstAt('rsChartSec')].startsWith('rsChartSec = timeframe.in_seconds(timeframe.period)')
        && firstAt('rsChartSec') < lines.findIndex((l) => l.startsWith('emBbOk    = rsChartSec'))
        && lines.findIndex((l) => l.startsWith('emBbOk    = rsChartSec')) < lines.findIndex((l) => l.startsWith('emOk    = emOn and rsChartSec')),
      `line ${firstAt('rsChartSec') + 1}`);
    check('v44: the four defaults the operator runs — a 2m VB candle on a 30s band, a 2m EMA candle, the BB upper band as the line that crosses',
      code.includes('\nvbCandleTf = input.timeframe("2",') && code.includes('\nvbBbTf     = input.timeframe("30S",')
        && code.includes('\nemTf      = input.timeframe("2",') && code.includes('\nemSrc   = input.string("BB upper",'));
    const inputs = lines.map((l) => /^([A-Za-z_]\w*)\s*=\s*input\.(?:bool|int|float|string|timeframe|session|source)\(/.exec(l)?.[1]).filter((x): x is string => x != null);
    check('v44 / v45 / v46 / v47: the 73 inputs, in order (TradingView keeps a saved value by position; v44 took 19 out, so it needed Reset settings once; v45 and v46 each add a basis line\'s three at the end and v47 the TURN\'s thirteen after them, so they need none)',
      inputs.join(' ') === 'minDayGain runnerDays useAhGain alertWin pbOn pbSession pbMonth pbYear pbArm pbNear pbLowMY pbBreak pbWin pbMax pbCapMark pbTimeout'
        + ' vbOn vbCandleTf vbBbTf vbLen vbMult vbTol vbGainOn vbSession vbMonth vbYear vbRtOn vbRtCancel vbTf vbShow vwSrc vbRtNear vbRtWait vbRtWhen mvSrc'
        + ' emOn emTf emLen emSession emMonth emYear emGainOn emShow emFilterOn emMinUnder emMaxFlips emFromHour emBncOn emBncFrom emBncWait emBncTolE emBncTolV'
        + ' emSrc bbMidOn pbBsOn pbBsTf pbBsLen bbBsOn bbBsTf bbBsLen'
        + ' tnOn tnTf tnLen tnFallMin tnLowBars tnTol tnWaitN tnMacdOn tnFast tnSlow tnSig tnGainOn tnShow', inputs.join(' '));
    // v45 (operator, 11-22, with TradingView's own BB 15S on a 1m chart, its middle line only: "add own BollingerBand to
    // Pullback section, with configurable timeframe, only basis row is enough … I'm going to experiment entering when price
    // closes above it after the pullback"): a line and nothing else. Its inputs sit last in the code and carry the Pullback
    // group, so the settings window shows them there; it sends nothing, so no alert() and no message field came with it.
    check('v45: the pullback basis line — a switch, a timeframe (15S) and a length (20) in the Pullback group; the SMA of that timeframe\'s closes',
      code.includes('\npbBsOn  = input.bool(true,') && code.includes('\npbBsTf  = input.timeframe("15S", "Pullback basis: its band\'s timeframe", group = "Pullback to VWAP (v10)")')
        && code.includes('\npbBsLen = input.int(20,') && lines.filter((l) => /^pbBs(On|Tf|Len)\s*=/.test(l)).every((l) => l.includes('group = "Pullback to VWAP (v10)"'))
        && code.includes('request.security_lower_tf(syminfo.tickerid, pbBsLower ? pbBsTf : timeframe.period, ta.sma(close, pbBsLen))')
        && code.includes('request.security(syminfo.tickerid, pbBsUpper ? pbBsTf : timeframe.period, ta.sma(close, pbBsLen))'));
    check('v45: …read at the chart bar\'s close (the last bar of its timeframe inside), kept where it was on a chart bar with none, and drawn while the Pullback setup and its own switch are on',
      code.includes('pbBsLower = pbOn and pbBsOn and pbBsSec < chartSec') && code.includes('pbBsUpper = pbOn and pbBsOn and pbBsSec > chartSec')
        && code.includes('\nvar float pbBasis = na\nif pbBsUpper\n    pbBasis := pbBsHtf\nelse if array.size(pbBsIn) > 0\n    pbBasis := array.get(pbBsIn, array.size(pbBsIn) - 1)\n')
        && code.includes('plot(pbOn and pbBsOn ? pbBasis : na, "Pullback basis (v45)", color.white)'));
    check('v45: …and it is a line only: no alert() and no message names it',
      lines.filter((l) => /pbBasis|pbBs[A-Z]/.test(l)).every((l) => !/alert\(|str\.tostring|msg/.test(l)));
    // v46 (operator, 11-24: "add own BollingerBands basis row to the BB setups, as we did for Pullback"; then, with the
    // "EMA cross over VWAP" settings open: "I mean, bb basis for this bb setups of EMA Cross Over VWAP"): the same kind of
    // line for the EMA cross setup, whose line the operator runs as the band. Its own switch, timeframe and length, in the
    // EMA cross over VWAP group. A line only. (Not the band cross's own band, whose middle line the v41 test reads.)
    check('v46: the band cross\'s basis line — a switch, a timeframe (15S) and a length (20) in the EMA cross over VWAP group; the SMA of that timeframe\'s closes, built like the pullback\'s',
      code.includes('\nbbBsOn  = input.bool(true,') && code.includes('\nbbBsTf  = input.timeframe("15S", "Band cross basis: its band\'s timeframe", group = "EMA cross over VWAP (v35)")')
        && code.includes('\nbbBsLen = input.int(20,') && lines.filter((l) => /^bbBs(On|Tf|Len)\s*=/.test(l)).every((l) => l.includes('group = "EMA cross over VWAP (v35)"'))
        && code.includes('request.security_lower_tf(syminfo.tickerid, bbBsLower ? bbBsTf : timeframe.period, ta.sma(close, bbBsLen))')
        && code.includes('request.security(syminfo.tickerid, bbBsUpper ? bbBsTf : timeframe.period, ta.sma(close, bbBsLen))')
        && code.includes('\nvar float bbBasis = na\nif bbBsUpper\n    bbBasis := bbBsHtf\nelse if array.size(bbBsIn) > 0\n    bbBasis := array.get(bbBsIn, array.size(bbBsIn) - 1)\n'));
    check('v46: …drawn while the EMA cross setup and its own switch are on',
      code.includes('bbBsUse   = emOn and bbBsOn') && code.includes('bbBsLower = bbBsUse and bbBsSec < chartSec')
        && code.includes('bbBsUpper = bbBsUse and bbBsSec > chartSec') && code.includes('plot(bbBsUse ? bbBasis : na, "Band cross basis (v46)", color.teal)'));
    check('v46: …and it is a line only: no alert() and no message names it, and the v41 middle-line test still reads the band\'s own middle',
      lines.filter((l) => /bbBasis|bbBs[A-Z]/.test(l)).every((l) => !/alert\(|str\.tostring|msg|bbSample/.test(l))
        && code.includes('emBbMid'));
  }
  // v47 (operator, 11-25): TURN, section 8 at the end of the script. It reads the chart's own candles, so it runs where
  // the chart's timeframe is the basis's (its alert comes from the 1m alert) and makes no request. Pinned: the rule's key
  // lines, the message's pieces and their order, and its inputs, alert and plots (all last; the counts are checked below).
  {
    for (const part of ['"TURN "', '" | sma "', '" | fall "', '" | turn "', '" | green "',
      'tnRun     = tnOn and timeframe.in_seconds(tnTf) == chartSec',
      // the basis and the MACD, from the chart's own closes
      'tnB       = ta.sma(close, tnLen)', '[tnMacdLine, tnSignalLine, tnHist] = ta.macd(close, tnFast, tnSlow, tnSig)', 'tnGreen   = tnHist > 0',
      // the fall: the basis's low of the last 31 candles, no older than tnLowBars, at least tnFallMin % under its high of the 46 before
      'tnLowAgo  = -ta.lowestbars(tnB, 31)', 'tnLowVal  = ta.lowest(tnB, 31)', 'tnHigh46  = ta.highest(tnB, 46)', 'tnPeak    = tnHigh46[tnLowAgo]',
      'tnFallPct = not na(tnPeak) and tnPeak > 0 ? (1 - tnLowVal / tnPeak) * 100 : na',
      'tnFell    = tnFallMin <= 0 or (not na(tnFallPct) and tnLowAgo <= tnLowBars and tnFallPct >= tnFallMin)',
      // the break (a close above the basis after one at or under it), the touch, the bounce, the wait's two ends
      'if not tnWaiting and not tnFire and close > tnB and close[1] <= tnB[1]', 'tnPbLow    := close',
      'if close < tnB', 'tnPbLow := math.min(tnPbLow, low)', 'if low <= tnB * (1 + tnTol / 100)',
      'if tnTouched and close > open and close > tnB and tnRising and (not tnMacdOn or tnGreen)', 'bool tnRising = tnB > tnB[1]',
      'else if bar_index - tnBreakBar >= tnWaitN',
      // what lets a bounce send, the stop a tick under the pullback's low, the day's number
      'if tnFell and inWindow and (not tnGainOn or gainer)', 'tnStop  := tnPbLow - syminfo.mintick', 'tnAge   := bar_index - tnBreakBar', 'tnCount += 1',
      // the message
      'string msg = "TURN " + syminfo.ticker + " " + str.tostring(close, format.mintick) + " | stop " + str.tostring(tnStop, format.mintick)',
      'msg += " | sma " + str.tostring(tnLen) + " " + str.tostring(tnB, format.mintick) + " (" + pctVs(tnB) + "%)"',
      'msg += " | fall " + str.tostring(tnFallPct, "#.0") + "%"',
      'msg += " | candle " + tnTf + " | turn " + str.tostring(tnCount) + " | since " + str.tostring(tnAge) + " | green " + (tnGreen ? "1" : "0")',
      'msg + " | vwap " + (use30 ? "30s" : "chart") + " | tf " + timeframe.period']) {
      check(`v47: script has ${part}`, pine.includes(part));
    }
    const code = pine.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const turn = code.slice(code.indexOf('\ntnOn      = input.bool('));
    check('v47: the TURN section is the script\'s last code, after the band cross\'s basis line', code.indexOf('\ntnOn      = input.bool(') > code.indexOf('"Band cross basis (v46)"')
      && code.indexOf('"Band cross basis (v46)"') > 0 && turn.trimEnd().endsWith('text = "TN", textcolor = color.white, size = size.small)'));
    const body = turn.slice(turn.indexOf('tnMsg() =>'), turn.indexOf('\nif tnFire'));
    const order = ['"TURN "', '" | stop "', '" | sVWAP "', '" | mVWAP "', '" | yVWAP "', '" | sma "', '" | fall "', '" | candle "', '" | turn "', '" | since "',
      '" | green "', '" | day high "', '" | ah "', '" | vwap "', '" | tf "'];
    check('v47: the TURN message\'s pieces come in the order the parser\'s example has them (stop, the VWAP lines, sma, fall, candle, turn, since, green, day high, ah, vwap, tf)',
      turn.indexOf('tnMsg() =>') > 0 && order.every((p, i) => body.indexOf(p) >= 0 && (i === 0 || body.indexOf(order[i - 1]) < body.indexOf(p))),
      order.map((p) => `${p}@${body.indexOf(p)}`).join(' '));
    check('v47: the fall is left out of the message when the script has no reading, the VWAP lines when they are na',
      body.includes('if not na(tnFallPct)\n        msg += " | fall "') && body.includes('if not na(svwap)\n        msg += " | sVWAP "')
        && body.includes('if not na(mvwap)\n        msg += " | mVWAP "') && body.includes('if not na(yvwap)\n        msg += " | yVWAP "'));
    const tnInputs = turn.split('\n').filter((l) => /^tn\w+\s*=\s*input\./.test(l));
    check('v47: the TURN\'s thirteen inputs, every one in its own group',
      tnInputs.length === 13 && tnInputs.every((l) => l.includes('group = "TURN: the bounce off a basis that turned up (v47)")'))
        && (code.match(/group = "TURN: the bounce off a basis that turned up \(v47\)"/g) ?? []).length === 13, String(tnInputs.length));
    check('v47: its defaults — on, a 1m basis of 15 closes, a fall of 10% whose low is within 15 candles, a low within 1% of the basis, the bounce within 10 candles, a MACD 12 26 9 that must be green, gainers only',
      turn.includes('\ntnOn      = input.bool(true,') && turn.includes('\ntnTf      = input.timeframe("1",') && turn.includes('\ntnLen     = input.int(15,')
        && turn.includes('\ntnFallMin = input.float(10.0,') && turn.includes('\ntnLowBars = input.int(15,') && turn.includes('\ntnTol     = input.float(1.0,')
        && turn.includes('\ntnWaitN   = input.int(10,') && turn.includes('\ntnMacdOn  = input.bool(true,') && turn.includes('\ntnFast    = input.int(12,')
        && turn.includes('\ntnSlow    = input.int(26,') && turn.includes('\ntnSig     = input.int(9,') && turn.includes('\ntnGainOn  = input.bool(true,')
        && turn.includes('\ntnShow    = input.bool(true,'));
    check('v47: one alert, at the bar\'s close, when a TURN fires — the script\'s last alert()',
      turn.includes('\nif tnFire\n    alert(tnMsg(), alert.freq_once_per_bar_close)\n') && (turn.match(/^\s*alert\(/gm) ?? []).length === 1
        && code.lastIndexOf('alert(') === code.indexOf('alert(tnMsg(), alert.freq_once_per_bar_close)'));
    check('v47: the day\'s number and an open wait are reset at the day\'s start', turn.includes('\nif newDay\n    tnCount   := 0\n    tnWaiting := false\n'));
    check('v47: TURN makes no request (it reads the chart\'s own candles)', !turn.includes('request.') && turn.length > 0
      && code.split('\n').filter((l) => /\btn[A-Z]\w*/.test(l)).every((l) => !l.includes('request.')));
    check('v47: its two plots — the basis line while the setup runs on this chart, and the mark at the bounce',
      turn.includes('\nplot(tnRun and tnShow ? tnB : na, "TURN basis (v47)", color.fuchsia)\n')
        && turn.includes('\nplotshape(tnShow and tnFire, "TURN (v47)", shape.labelup, location.belowbar, color.fuchsia, text = "TN"'));
    // The examples in the script's comments ("Message (the contract with parseTvMessage)") are read by the parser itself.
    const examples = pine.split('\n').map((l) => /^\/\/\s+((?:PULLBACK|BROKEN|HELD|CROSS|RETEST|EMA|BOUNCE|TURN) [A-Z]+ [0-9.]+ \|.*)$/.exec(l)?.[1].trim())
      .filter((x): x is string => x != null);
    check('v47: every example message in the script\'s comments parses, each to its own stage (the EMA example about the band to BAND)',
      JSON.stringify(examples.map((m) => parseTvMessage(m)?.stage ?? null)) === '["pullback","cross","retest","ema","band","bounce","turn"]',
      examples.map((m) => `${m.split(' ')[0]}→${parseTvMessage(m)?.stage ?? 'null'}`).join(' '));
    const ex = examples.find((m) => m.startsWith('TURN NIVF '));
    const exSig = ex ? parseTvMessage(ex) : null;
    check('v47: …the TURN example there is the message pinned above, read to every field',
      ex === TURN_MSG && exSig?.stage === 'turn' && exSig.ticker === 'NIVF' && exSig.price === 0.0213 && exSig.stop === 0.0206 && exSig.svwap === 0.0211
        && exSig.spx_pct === 0.9 && exSig.mvwap === 0.023 && exSig.px_pct === -7.4 && exSig.sma_len === 15 && exSig.sma === 0.0207 && exSig.sma_pct === 2.9
        && exSig.fall_pct === 12.3 && exSig.candle_tf === '1' && exSig.turn_n === 1 && exSig.since_n === 3 && exSig.macd_green === true && exSig.day_gain === 25
        && exSig.vwap_src === '30s' && exSig.tf === '1', ex ?? 'no TURN example in the script\'s comments');
  }
  check('v44 / v47: 12 alert() calls — three PULLBACK, the VB and its RETEST, four EMA / BOUNCE, two band crosses, and (v47) the TURN',
    (pine.match(/^\s*alert\(/gm) ?? []).length === 12, String((pine.match(/^\s*alert\(/gm) ?? []).length));
  // v28: the VB break (LEVEL / BREAK) is gone; the new inputs went last (after vbShow).
  for (const gone of ['"LEVEL"', '"BREAK"', 'vbLvMsg', '" | level "', '" | break "', 'text = "BRK"']) {
    check(`v28: script no longer has ${gone}`, !pine.includes(gone));
  }
  const at = (x: string) => pine.indexOf(x);
  // v43 (2026-11-18): on a 30s chart, a timeframe's bars first requested after a request.security_lower_tf() call load only
  // as deep as 100,000 30s bars would reach (833 hourly bars, 34 daily ones), and every later request for that timeframe shares
  // what the first one loaded. v28 put its 30s-bar request above the year line's hourly one, so from 10-29 to v42 the 30s
  // alert's year line started months late (LXEO 11-18: 3.64 against 4.79). Found and reproduced through TradingView's MCP
  // (docs/vwap-setup.md §19). The hourly anchors must stay the script's first request; the VB's hourly request shares them.
  {
    const code = pine.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l));
    const firstReq = code.findIndex((l) => /request\.[a-z_]+\(/.test(l));
    const firstLower = code.findIndex((l) => l.includes('request.security_lower_tf('));
    check('v43: the hourly anchors (the year\'s and the month\'s sums) are the script\'s first request, above every lower-timeframe request',
      firstReq >= 0 && code[firstReq].includes('"60", anchorsBefore()') && firstReq < firstLower,
      firstReq >= 0 ? `line ${firstReq + 1}: ${code[firstReq].slice(0, 90)}` : 'no request found');
    const hourly = code.filter((l) => l.includes('request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", '));
    check('v43: the VB asks for the same hourly bars (same ticker and timeframe), so it shares the fully loaded ones',
      hourly.length === 2 && hourly.some((l) => l.includes('vbAnchors()')), String(hourly.length));
    const plainAfter = code.slice(firstLower).filter((l) => /request\.security\(/.test(l))
      .map((l) => (l.includes('session.extended), "60", ') ? '"60"' : /request\.security\((?:rsSym|syminfo\.tickerid),\s*([^,]+),/.exec(l)?.[1]?.trim()));
    check('v43: every other plain request after it is for the hourly bars or a short-lookback timeframe (the EMA\'s; v44: the RSI\'s and the MACD\'s are gone; v45 / v46: a basis line\'s 20 closes)',
      plainAfter.join(', ') === '"60", emTf, pbBsUpper ? pbBsTf : timeframe.period, bbBsUpper ? bbBsTf : timeframe.period', plainAfter.join(', '));
    // v44: with the RSI's, the MACD's and the basis's requests gone, six were left; v45's and v46's basis lines add two each, last
    const reqs = code.filter((l) => /request\.[a-z_]+\(/.test(l));
    const want = ['request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", anchorsBefore()',
      'request.security_lower_tf(syminfo.tickerid, need30 ? "30S" : timeframe.period, [hlc3 * volume, volume])',
      'request.security(ticker.new(syminfo.prefix, syminfo.ticker, session.extended), "60", vbAnchors()',
      'request.security_lower_tf(syminfo.tickerid, vbLower ? vbTf : timeframe.period, vbView())',
      'request.security(rsSym, emTf, ta.ema(close, emLen)[1]',
      'request.security_lower_tf(syminfo.tickerid, emBbLower ? vbTf : timeframe.period, emBand(vbBbTf))',
      'request.security_lower_tf(syminfo.tickerid, pbBsLower ? pbBsTf : timeframe.period, ta.sma(close, pbBsLen))',
      'request.security(syminfo.tickerid, pbBsUpper ? pbBsTf : timeframe.period, ta.sma(close, pbBsLen))',
      'request.security_lower_tf(syminfo.tickerid, bbBsLower ? bbBsTf : timeframe.period, ta.sma(close, bbBsLen))',
      'request.security(syminfo.tickerid, bbBsUpper ? bbBsTf : timeframe.period, ta.sma(close, bbBsLen))'];
    check('v44 / v45 / v46: the script\'s ten requests, in order: the hourly anchors, the 30s bars, the VB\'s hourly anchors, the VB\'s view, the EMA, the EMA\'s band, the pullback basis\'s two, the band cross basis\'s two',
      reqs.length === want.length && want.every((w, i) => reqs[i].includes(w)), reqs.map((l) => l.trim().slice(0, 70)).join(' ¦ '));
  }
  check('v28: the new inputs come after the last v27 one', at('vbShow     = input.bool') > 0 && at('vbShow     = input.bool') < at('vwSrc      = input.string')
    && at('vwSrc      = input.string') < at('vbRtNear   = input.float') && at('vbRtNear   = input.float') < at('vbRtWait   = input.int'));
  check('v28: the retest switches sit in the VB break\'s old places (same order around them)',
    at('vbYear     = input.bool') < at('vbRtOn     = input.bool') && at('vbRtOn     = input.bool') < at('vbRtCancel = input.bool')
      && at('vbRtCancel = input.bool') < at('vbTf       = input.timeframe'));
  check('v35: the EMA inputs come after the last v31 one (the RSI\'s and the DIP\'s, between them until v44, are gone), in order',
    at('mvSrc      = input.string') > 0 && at('mvSrc      = input.string') < at('emOn      = input.bool')
    && at('emOn      = input.bool') < at('emTf      = input.timeframe') && at('emTf      = input.timeframe') < at('emLen     = input.int')
    && at('emLen     = input.int') < at('emSession = input.bool') && at('emSession = input.bool') < at('emGainOn  = input.bool')
    && at('emGainOn  = input.bool') < at('emShow    = input.bool'));
  check('v36: the four EMA filter inputs come after the v35 ones, in order', at('emShow    = input.bool') < at('emFilterOn = input.bool')
    && at('emFilterOn = input.bool') < at('emMinUnder = input.int') && at('emMinUnder = input.int') < at('emMaxFlips = input.int')
    && at('emMaxFlips = input.int') < at('emFromHour = input.int'));
  check('v37: the five EMA bounce inputs come after the filter ones, in order', at('emFromHour = input.int') < at('emBncOn   = input.bool')
    && at('emBncOn   = input.bool') < at('emBncFrom = input.string') && at('emBncFrom = input.string') < at('emBncWait = input.int')
    && at('emBncWait = input.int') < at('emBncTolE = input.float') && at('emBncTolE = input.float') < at('emBncTolV = input.float'));
  check('v40 / v41 / v45 / v46 / v47: their inputs come last, in order — emSrc, bbMidOn, the pullback basis line\'s three, the band cross basis line\'s three, then the TURN\'s thirteen, nothing after (v44: the MACD\'s six before them and the basis\'s three after them are gone) — the first two before the EMA section\'s code that reads them',
    at('emBncTolV = input.float') > 0 && at('emBncTolV = input.float') < at('emSrc   = input.string') && at('emSrc   = input.string') < at('bbMidOn = input.bool')
    && at('bbMidOn = input.bool') < at('emPrevE = request.security')
    && at('bbMidOn = input.bool') < at('pbBsOn  = input.bool') && at('pbBsOn  = input.bool') < at('pbBsTf  = input.timeframe') && at('pbBsTf  = input.timeframe') < at('pbBsLen = input.int')
    && at('pbBsLen = input.int') < at('bbBsOn  = input.bool') && at('bbBsOn  = input.bool') < at('bbBsTf  = input.timeframe') && at('bbBsTf  = input.timeframe') < at('bbBsLen = input.int')
    && at('bbBsLen = input.int') < at('tnOn      = input.bool') && at('tnOn      = input.bool') < at('tnTf      = input.timeframe')
    && at('tnTf      = input.timeframe') < at('tnLen     = input.int') && at('tnLen     = input.int') < at('tnFallMin = input.float')
    && at('tnFallMin = input.float') < at('tnLowBars = input.int') && at('tnLowBars = input.int') < at('tnTol     = input.float')
    && at('tnTol     = input.float') < at('tnWaitN   = input.int') && at('tnWaitN   = input.int') < at('tnMacdOn  = input.bool')
    && at('tnMacdOn  = input.bool') < at('tnFast    = input.int') && at('tnFast    = input.int') < at('tnSlow    = input.int')
    && at('tnSlow    = input.int') < at('tnSig     = input.int') && at('tnSig     = input.int') < at('tnGainOn  = input.bool')
    && at('tnGainOn  = input.bool') < at('tnShow    = input.bool')
    && (pine.slice(at('tnShow    = input.bool') + 'tnShow    = input.bool'.length).match(/input\.(bool|int|float|string|timeframe|session|source)\(/g) ?? []).length === 0
    && (pine.match(/input\.(bool|int|float|string|timeframe|session|source)\(/g) ?? []).length === 73,
    String((pine.match(/input\.(bool|int|float|string|timeframe|session|source)\(/g) ?? []).length));
  // New plots go last (TradingView keeps a plot's style by position too)
  check('v40 / v41 / v45 / v46 / v47: the band\'s line and its four marks, its middle line, the pullback basis line, the band cross basis line, then the TURN\'s basis and mark are the script\'s last plots, after the bounce\'s four (v44: the MACD\'s two before them and the basis\'s five after them are gone)',
    at('"EMA bounce, filtered, late close (v37)"') > 0 && at('"EMA bounce, filtered, late close (v37)"') < at('"BB upper (EMA cross, v40)"')
    && at('"BB upper (EMA cross, v40)"') < at('"BB upper cross over VWAP (v40)"')
    && at('"BB upper cross over VWAP (v40)"') < at('"BB upper cross, late close (v40)"')
    && at('"BB upper cross, late close (v40)"') < at('"BB upper cross, filtered (v40)"')
    && at('"BB upper cross, filtered (v40)"') < at('"BB upper cross, filtered, late close (v40)"')
    && at('"BB upper cross, filtered, late close (v40)"') < at('"BB middle (EMA cross, v41)"')
    && at('"BB middle (EMA cross, v41)"') < at('"Pullback basis (v45)"')
    && at('"Pullback basis (v45)"') < at('"Band cross basis (v46)"')
    && at('"Band cross basis (v46)"') < at('"TURN basis (v47)"') && at('"TURN basis (v47)"') < at('"TURN (v47)"')
    && !/^\s*(plot|plotshape|plotchar|bgcolor|fill)\(/m.test(pine.slice(at('"TURN (v47)"'))));
  {
    const titles = pine.split('\n').filter((l) => /^\s*(plot|plotshape|plotchar|bgcolor|fill)\(/.test(l)).map((l) => /"([^"]*)"/.exec(l)?.[1] ?? '?');
    check('v44 / v45 / v46 / v47: 35 plots, the last ten the band\'s six (its line, its four marks, its middle line), the pullback basis line, the band cross basis line and the TURN\'s two (its basis, its mark), right after the bounce\'s last mark',
      titles.length === 35 && JSON.stringify(titles.slice(-11)) === JSON.stringify(['EMA bounce, filtered, late close (v37)', 'BB upper (EMA cross, v40)',
        'BB upper cross over VWAP (v40)', 'BB upper cross, late close (v40)', 'BB upper cross, filtered (v40)', 'BB upper cross, filtered, late close (v40)',
        'BB middle (EMA cross, v41)', 'Pullback basis (v45)', 'Band cross basis (v46)', 'TURN basis (v47)', 'TURN (v47)']), `${titles.length}: ${titles.slice(-11).join(' ¦ ')}`);
  }
  check('v36 / v37: the gray "filtered" marks, then the four bounce marks, in order',
    at('"yVWAP (EMA cross, v35)"') > 0 && at('"yVWAP (EMA cross, v35)"') < at('"EMA cross, filtered (v36)"')
    && at('"EMA cross, filtered (v36)"') < at('"EMA cross, filtered, late close (v36)"')
    && at('"EMA cross, filtered, late close (v36)"') < at('"EMA bounce (v37)"') && at('"EMA bounce (v37)"') < at('"EMA bounce, late close (v37)"')
    && at('"EMA bounce, late close (v37)"') < at('"EMA bounce, filtered (v37)"') && at('"EMA bounce, filtered (v37)"') < at('"EMA bounce, filtered, late close (v37)"'));
  check('v38: the script has no "| level" (v25–v27\'s LEVEL field, which the parser no longer reads)', !pine.includes('" | level "'));
  // v37: on one sample the bounce of an earlier cross is judged before the cross (which re-arms), and read before the arm resets it
  check('v37: the bounce step, then the cross, then the arm — late and on time', at('bool emB1 = emBncOn') > 0
    && at('bool emB1 = emBncOn') < at('bool emX1 = emSession and emS.crossUp') && at('bool emX1 = emSession and emS.crossUp') < at('emS.arm(not emG1)')
    && at('emS.arm(not emG1)') < at('bool emB4 = emBncOn') && at('bool emB4 = emBncOn') < at('bool emX4 = emSession and emS.crossUp')
    && at('bool emX4 = emSession and emS.crossUp') < at('emS.arm(not emG4)')
    && at('emBLStop := emBLo1 - syminfo.mintick') < at('bool emX1 = emSession and emS.crossUp'));
  check('v37: the candle\'s open and low are tracked before the samples use them', at('if na(emT[1]) or emT != emT[1]') > 0
    && at('if na(emT[1]) or emT != emT[1]') < at('if emLateS') && at('emCOp := emCO') < at('emCO  := open'));
  // v35: the late sample first, then the anchors' restarts, then this bar's own close
  check('v35: late sample, then the day\'s restart, then the on-time sample', at('if emLateS') > 0 && at('if emLateS') < at('emS.restart(emHS)')
    && at('emS.restart(emHS)') < at('if emEnd and (na(emDone) or emDone != emT)'));
  // v33: one RSI — the second RSI and its "also require" switch are gone (and since v44 the RSI itself)
  for (const gone of ['rsTfB', 'rsNeedB', 'rsSB', 'rsMaB', '"RSI: the second', 'also require the second']) check(`v33: script no longer has ${gone}`, !pine.includes(gone));
  // v27 removed RECLAIM and the BB breakout: none of their messages or inputs are left.
  // (v42 brought a `" | basis "` back for the basis cross's line in an EMA message; v44 removed it again — the v44 list above.)
  for (const gone of ['"FORMING"', '"READY"', '"GO"', '"TOUCH"', '"BREAKOUT"', '"TRIGGERED"', '" | path "', '" | via "',
    '" | trigger "', '" | run30 +"', '" | early +"', 'rcOn', 'boOn', 'reclaimConds', 'alertcondition(']) {
    check(`v27: script no longer has ${gone}`, !pine.includes(gone));
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll tv-setup checks passed');
