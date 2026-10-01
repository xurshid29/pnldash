// Regression for the Momentum letter grade (services/momentum-grade.ts).
// Run:  npx tsx scripts/verify-momentum-grade.ts [parity.csv]
//
// Part 1 pins the bucket boundaries, null handling, smoothing window and
// letter cuts. Part 2 (optional) replays a parity export from the research
// study — rows with the study's own inputs, 6-cycle score (m6) and letter —
// through MomentumGrader and requires an exact match. Generate the CSV with
// scripts/research/momentum-grade/study.py (see its README).

import { readFileSync } from 'node:fs';
import {
  MomentumGrader, gradeBuckets, gradeScore, letterFor, GRADE_CUTS, GRADE_SMOOTH_CYCLES, GRADE_FADE, type GradeInputs,
} from '../src/services/momentum-grade.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const base: GradeInputs = {
  changePct: 30, floatM: 3, price: 3, etMinute: 8 * 60, catImpact: 50, newsCount: 1, ageMin: 2,
  accelDelta: 3, relVol1min: 5000, relVol5min: 6000, aboveVwap: true,
};

console.log('Part 1 — buckets, smoothing, letters');
{
  const b = gradeBuckets(base);
  check('hot premarket runner buckets', JSON.stringify(b) === JSON.stringify([
    'chg c 20-50', 'flt b 2-5M', 'px c 2-5', 'tod b PM 7-9:30', 'cat d strong', 'age a <5m', 'acc a >2', 'vol a burst', 'vwap a above',
  ]), JSON.stringify(b));
  // Boundaries mirror the study's SQL (`<` everywhere except price ≤ 20).
  check('chg 20 → 20-50', gradeBuckets({ ...base, changePct: 20 })[0] === 'chg c 20-50');
  check('chg 100 → 100+', gradeBuckets({ ...base, changePct: 100 })[0] === 'chg e 100+');
  check('price 20 → 5-20, 20.01 → 20+', gradeBuckets({ ...base, price: 20 })[2] === 'px d 5-20' && gradeBuckets({ ...base, price: 20.01 })[2] === 'px e 20+');
  check('09:30 → 9:30-11, 16:00 → AH', gradeBuckets({ ...base, etMinute: 570 })[3] === 'tod c 9:30-11' && gradeBuckets({ ...base, etMinute: 960 })[3] === 'tod e AH');
  check('no news → none; bearish-only → bearish/unscored',
    gradeBuckets({ ...base, catImpact: null, newsCount: 0 })[4] === 'cat a none'
    && gradeBuckets({ ...base, catImpact: null, newsCount: 2 })[4] === 'cat b bearish/unscored');
  check('impact 70 → major', gradeBuckets({ ...base, catImpact: 70 })[4] === 'cat e major');
  check('idle tape (no accel) → acc ?', gradeBuckets({ ...base, accelDelta: null })[6] === 'acc ?');
  check('accel 0 → acc <=0', gradeBuckets({ ...base, accelDelta: 0 })[6] === 'acc c <=0');
  check('1m under half of 5m → drying', gradeBuckets({ ...base, relVol1min: 100, relVol5min: 1000 })[7] === 'vol c drying');
  check('missing 1m → vol ?', gradeBuckets({ ...base, relVol1min: null })[7] === 'vol ?');
  check('no volume since tracked → vwap ?', gradeBuckets({ ...base, aboveVwap: null })[8] === 'vwap ?');
  check('null change/float/price contribute nothing', gradeBuckets({ ...base, changePct: null, floatM: null, price: null }).length === 6);

  check('hot runner grades A+', letterFor(gradeScore(base)) === 'A+', `score ${gradeScore(base)}`);
  const dead: GradeInputs = { ...base, changePct: 5, floatM: 40, etMinute: 17 * 60, catImpact: null, newsCount: 0, ageMin: 120, accelDelta: null, relVol1min: 10, relVol5min: 10, aboveVwap: null };
  check('idle after-hours laggard grades D', letterFor(gradeScore(dead)) === 'D', `score ${gradeScore(dead)}`);
  check('cut-offs strictly descending', GRADE_CUTS.every(([, c], i) => i === 0 || c < GRADE_CUTS[i - 1][1]));

  const g = new MomentumGrader();
  const first = g.grade('T', base);
  check('first cycle: smoothed = raw', first.score === first.raw);
  for (let i = 0; i < GRADE_SMOOTH_CYCLES; i++) g.grade('T', dead);
  const after = g.grade('T', dead);
  check(`window is ${GRADE_SMOOTH_CYCLES} cycles (hot cycle fully aged out)`, after.score === after.raw, `${after.score} vs ${after.raw}`);
  const g2 = new MomentumGrader();
  g2.grade('T', base);
  const mixed = g2.grade('T', dead);
  check('2-cycle mean is the average', Math.abs(mixed.score - (gradeScore(base) + gradeScore(dead)) / 2) < 0.011);
  g2.reset();
  check('reset clears history', g2.grade('T', dead).score === g2.grade('U', dead).score);

  // Fade cap: an A-tier name ≥8% below its 10-min high shows B+.
  const f = new MomentumGrader();
  const T = 1_790_000_000;
  f.grade('F', { ...base, price: 5.0 }, T);
  const near = f.grade('F', { ...base, price: 4.7 }, T + 20);       // −6% off high
  check('6% off the high keeps the model letter', near.grade === near.base && !near.faded, JSON.stringify(near));
  const dump = f.grade('F', { ...base, price: 4.2 }, T + 40);       // −16% off high
  check('16% off the high caps an A-tier letter at B+', dump.base === 'A+' && dump.grade === GRADE_FADE.cap && dump.faded, JSON.stringify(dump));
  check('…and reports how far off the high it is', dump.offHighPct === -16);
  const later = f.grade('F', { ...base, price: 4.25 }, T + 40 + GRADE_FADE.lookback_sec + 1); // old high left the window
  check('cap lifts once the 10-min window rolls past the old high', !later.faded && later.grade === later.base, JSON.stringify(later));
  const seeded = new MomentumGrader();
  seeded.seedPrices([{ ticker: 'S', ts: T - 300, price: 5.0 }]);           // pre-deploy high
  const afterBoot = seeded.grade('S', { ...base, price: 4.2 }, T);
  check('seeded pre-deploy high still caps a dump right after boot', afterBoot.faded && afterBoot.grade === GRADE_FADE.cap, JSON.stringify(afterBoot));
  const low = new MomentumGrader();
  low.grade('L', { ...dead, price: 5 }, T);
  const lowDump = low.grade('L', { ...dead, price: 3 }, T + 20);
  check('below A-tier the cap never raises a letter', lowDump.grade === lowDump.base && !lowDump.faded, JSON.stringify(lowDump));
}

const csvPath = process.argv[2];
if (csvPath) {
  console.log(`\nPart 2 — parity with the study (${csvPath})`);
  const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
  const hdr = lines[0].split(',');
  const col = (name: string) => hdr.indexOf(name);
  const num = (v: string) => (v === '' ? null : Number(v));
  let grader = new MomentumGrader();
  let day = '';
  let n = 0, letterMiss = 0, scoreMiss = 0, finalMiss = 0, fadedRows = 0;
  const examples: string[] = [];
  const finalExamples: string[] = [];
  const hasFinal = col('g_final') >= 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[col('day')] !== day) { day = c[col('day')]; grader = new MomentumGrader(); }
    const x: GradeInputs = {
      changePct: num(c[col('chg')]), floatM: num(c[col('float_m')]), price: num(c[col('price')]),
      etMinute: Number(c[col('tmin')]), catImpact: num(c[col('imp')]), newsCount: Number(c[col('n_news')]),
      ageMin: Number(c[col('age_min')]), accelDelta: num(c[col('acc')]),
      relVol1min: num(c[col('rv1')]), relVol5min: num(c[col('rv5')]),
      aboveVwap: c[col('av')] === '' ? null : c[col('av')] === 'true',
    };
    const out = grader.grade(c[col('ticker')], x, Number(c[col('ts')]));
    n++;
    const wantScore = Number(c[col('m6')]);
    if (Math.abs(out.score - wantScore) > 0.011) scoreMiss++;
    if (out.base !== c[col('g')]) {
      letterMiss++;
      if (examples.length < 5) examples.push(`${c[col('ticker')]} ${c[col('ts')]}: ts=${out.base}/${out.score} study=${c[col('g')]}/${wantScore}`);
    }
    // Exports from the fade-cap study also carry the final (capped) letter.
    if (hasFinal) {
      if (out.grade !== c[col('g_final')]) {
        finalMiss++;
        if (finalExamples.length < 5) finalExamples.push(`${c[col('ticker')]} ${c[col('ts')]}: ts=${out.grade} (off ${out.offHighPct}) study=${c[col('g_final')]} (off ${c[col('off_hi')]})`);
      }
      if (out.faded) fadedRows++;
    }
  }
  check(`model letters match on all ${n.toLocaleString()} rows`, letterMiss === 0, `${letterMiss} mismatches; ${examples.join(' | ')}`);
  check('2-minute scores match (±0.01)', scoreMiss === 0, `${scoreMiss} mismatches`);
  if (hasFinal) check(`final letters incl. the fade cap match (${fadedRows.toLocaleString()} capped rows)`, finalMiss === 0, `${finalMiss} mismatches; ${finalExamples.join(' | ')}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
