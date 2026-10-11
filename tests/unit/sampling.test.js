import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOT_RANGES, LEVELS, CODE_LETTERS, SAMPLE_SIZE_BY_LETTER, TABLE_IIA, SUPPORTED_AQLS,
  codeLetter, singleSamplingPlan, samplingPlan, lotDisposition, normalizeAql, parseLotSize,
} from '../../src/sampling.js';

// Independent transcription of Table I (npm package garment-aql-calculator 1.0.1,
// "ISO 2859-1 Table A"), columns S1 S2 S3 S4 GI GII GIII. Identical in MIL-STD-105D/E.
const TABLE_I_FIXTURE = [
  [2, 8, 'A', 'A', 'A', 'A', 'A', 'A', 'B'],
  [9, 15, 'A', 'A', 'A', 'A', 'A', 'B', 'C'],
  [16, 25, 'A', 'A', 'B', 'B', 'B', 'C', 'D'],
  [26, 50, 'A', 'B', 'B', 'C', 'C', 'D', 'E'],
  [51, 90, 'B', 'B', 'C', 'C', 'C', 'E', 'F'],
  [91, 150, 'B', 'B', 'C', 'D', 'D', 'F', 'G'],
  [151, 280, 'B', 'C', 'D', 'E', 'E', 'G', 'H'],
  [281, 500, 'B', 'C', 'D', 'E', 'F', 'H', 'J'],
  [501, 1200, 'C', 'C', 'E', 'F', 'G', 'J', 'K'],
  [1201, 3200, 'C', 'D', 'E', 'G', 'H', 'K', 'L'],
  [3201, 10000, 'C', 'D', 'F', 'G', 'J', 'L', 'M'],
  [10001, 35000, 'C', 'D', 'F', 'H', 'K', 'M', 'N'],
  [35001, 150000, 'D', 'E', 'G', 'J', 'L', 'N', 'P'],
  [150001, 500000, 'D', 'E', 'G', 'J', 'M', 'P', 'Q'],
  [500001, Infinity, 'D', 'E', 'H', 'K', 'N', 'Q', 'R'],
];

// Independent transcription of Table II-A non-arrow cells (npm packages
// aql-sample-size 1.0.0 and garment-aql-calculator 1.0.1). Those packages
// collapse arrow cells to the neighbouring Ac/Re, so only cells whose sample
// size is the letter's own are compared here.
const TABLE_IIA_FIXTURE = {
  '0.65': { G: [0, 1], J: [1, 2], K: [2, 3], L: [3, 4], M: [5, 6], N: [7, 8], P: [10, 11], Q: [14, 15], R: [21, 22] },
  '1.0': { F: [0, 1], H: [1, 2], J: [2, 3], K: [3, 4], L: [5, 6], M: [7, 8], N: [10, 11], P: [14, 15], Q: [21, 22] },
  '1.5': { E: [0, 1], G: [1, 2], H: [2, 3], J: [3, 4], K: [5, 6], L: [7, 8], M: [10, 11], N: [14, 15], P: [21, 22] },
  '2.5': { D: [0, 1], F: [1, 2], G: [2, 3], H: [3, 4], J: [5, 6], K: [7, 8], L: [10, 11], M: [14, 15], N: [21, 22] },
  '4.0': { C: [0, 1], E: [1, 2], F: [2, 3], G: [3, 4], H: [5, 6], J: [7, 8], K: [10, 11], L: [14, 15], M: [21, 22] },
  '6.5': { B: [0, 1], D: [1, 2], E: [2, 3], F: [3, 4], G: [5, 6], H: [7, 8], J: [10, 11], K: [14, 15], L: [21, 22] },
};

test('Table I: every lot range and level matches the independent transcription', () => {
  assert.equal(LOT_RANGES.length, TABLE_I_FIXTURE.length);
  TABLE_I_FIXTURE.forEach(([low, high, ...letters], rowIndex) => {
    assert.deepEqual([...LOT_RANGES[rowIndex]], [low, high]);
    LEVELS.forEach((level, levelIndex) => {
      for (const lot of [low, Math.min(high, low + 1), high === Infinity ? 999999999 : high]) {
        assert.equal(codeLetter(lot, level), letters[levelIndex], `lot ${lot} level ${level}`);
      }
    });
  });
});

test('Table I: ranges are contiguous and cover 2..infinity', () => {
  for (let i = 1; i < LOT_RANGES.length; i++) assert.equal(LOT_RANGES[i][0], LOT_RANGES[i - 1][1] + 1);
  assert.equal(LOT_RANGES[0][0], 2);
  assert.equal(codeLetter(1, 'II'), null);
  assert.equal(codeLetter(0, 'II'), null);
  assert.equal(codeLetter(2, 'IV'), null);
});

test('Sample sizes by code letter', () => {
  assert.deepEqual(SAMPLE_SIZE_BY_LETTER, {
    A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50, J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250, R: 2000,
  });
  assert.deepEqual(CODE_LETTERS, 'ABCDEFGHJKLMNPQR'.split(''));
});

test('Table II-A: explicit cells match the independent transcription', () => {
  for (const [aql, cells] of Object.entries(TABLE_IIA_FIXTURE)) {
    for (const [letter, acre] of Object.entries(cells)) {
      const plan = singleSamplingPlan(letter, aql);
      assert.equal(plan.arrow, '', `${letter}/${aql} should not be an arrow cell`);
      assert.equal(plan.letter, letter);
      assert.deepEqual([plan.ac, plan.re], acre, `${letter}/${aql}`);
    }
  }
});

test('Table II-A: structural invariants (re = ac+1, one 0/1 per column, monotone, arrows only at edges and right after 0/1)', () => {
  for (const aql of SUPPORTED_AQLS) {
    const column = TABLE_IIA[aql];
    assert.equal(column.length, 16);
    const explicit = column.map((c, i) => ({ c, i })).filter(x => Array.isArray(x.c));
    const zeroCells = explicit.filter(x => x.c[0] === 0);
    assert.equal(zeroCells.length, 1, `exactly one Ac=0 cell in column ${aql}`);
    explicit.forEach(x => assert.equal(x.c[1], x.c[0] + 1));
    for (let k = 1; k < explicit.length; k++) assert.ok(explicit[k].c[0] > explicit[k - 1].c[0], 'Ac increases down the column');
    const first = explicit[0].i, last = explicit[explicit.length - 1].i;
    column.forEach((c, i) => {
      if (i < first) assert.equal(c, 'v', `${aql} row ${i} should be a down arrow`);
      if (i > last) assert.equal(c, '^', `${aql} row ${i} should be an up arrow`);
    });
    // The only interior arrow is the single up-arrow directly below the 0/1 cell.
    const interiorArrows = column.map((c, i) => ({ c, i })).filter(x => x.i > first && x.i < last && !Array.isArray(x.c));
    assert.equal(interiorArrows.length, 1);
    assert.equal(interiorArrows[0].i, zeroCells[0].i + 1);
    assert.equal(interiorArrows[0].c, '^');
    // Ac sequence is the standard's: 0,1,2,3,5,7,10,14,21
    assert.deepEqual(explicit.map(x => x.c[0]), [0, 1, 2, 3, 5, 7, 10, 14, 21].slice(0, explicit.length));
  }
});

test('Table II-A: diagonals of constant n x AQL (how the standard is built)', () => {
  // Each Ac value sits on a diagonal where sampleSize x AQL% is (nearly) constant.
  const expected = { 0: 0.2, 1: 0.5, 2: 0.8, 3: 1.25, 5: 2.0, 7: 3.15, 10: 5.0, 14: 8.0, 21: 12.5 };
  for (const aql of SUPPORTED_AQLS) {
    TABLE_IIA[aql].forEach((cell, i) => {
      if (!Array.isArray(cell)) return;
      const product = SAMPLE_SIZE_BY_LETTER[CODE_LETTERS[i]] * Number(aql) / 100;
      const ratio = product / expected[cell[0]];
      assert.ok(ratio > 0.9 && ratio < 1.1, `${CODE_LETTERS[i]}/${aql}: n*AQL=${product} for Ac=${cell[0]}`);
    });
  }
});

test('Arrows: down arrows resolve to the first plan below, up arrows to the first plan above', () => {
  // AQL 2.5: A, B, C are down arrows -> D (n=8, 0/1)
  for (const letter of ['A', 'B', 'C']) {
    assert.deepEqual(singleSamplingPlan(letter, '2.5'), { letter: 'D', sampleSize: 8, ac: 0, re: 1, arrow: 'down', aql: '2.5' });
  }
  // AQL 2.5: E is an up arrow -> D
  assert.deepEqual(singleSamplingPlan('E', '2.5'), { letter: 'D', sampleSize: 8, ac: 0, re: 1, arrow: 'up', aql: '2.5' });
  // AQL 2.5: P, Q, R up arrows -> N (n=500, 21/22)
  for (const letter of ['P', 'Q', 'R']) {
    assert.deepEqual(singleSamplingPlan(letter, '2.5'), { letter: 'N', sampleSize: 500, ac: 21, re: 22, arrow: 'up', aql: '2.5' });
  }
  // AQL 1.0: R is an up arrow -> Q
  assert.deepEqual(singleSamplingPlan('R', '1.0'), { letter: 'Q', sampleSize: 1250, ac: 21, re: 22, arrow: 'up', aql: '1.0' });
  // AQL 6.5: A down -> B; C up -> B
  assert.deepEqual(singleSamplingPlan('A', '6.5'), { letter: 'B', sampleSize: 3, ac: 0, re: 1, arrow: 'down', aql: '6.5' });
  assert.deepEqual(singleSamplingPlan('C', '6.5'), { letter: 'B', sampleSize: 3, ac: 0, re: 1, arrow: 'up', aql: '6.5' });
});

test('samplingPlan: typical CNC lots at level II / AQL 2.5', () => {
  const cases = [
    // lot, expected effective sample, letter of plan, ac, re, fullInspection
    [2, 2, 'D', 0, 1, true],
    [8, 8, 'D', 0, 1, true],
    [10, 8, 'D', 0, 1, false],
    [20, 8, 'D', 0, 1, false],
    [30, 8, 'D', 0, 1, false],
    [60, 8, 'D', 0, 1, false],   // code E -> up arrow -> D
    [100, 20, 'F', 1, 2, false],
    [200, 32, 'G', 2, 3, false],
    [400, 50, 'H', 3, 4, false],
    [1000, 80, 'J', 5, 6, false],
    [2000, 125, 'K', 7, 8, false],
    [5000, 200, 'L', 10, 11, false],
    [20000, 315, 'M', 14, 15, false],
    [100000, 500, 'N', 21, 22, false],
    [400000, 500, 'N', 21, 22, false],
    [600000, 500, 'N', 21, 22, false],
  ];
  for (const [lot, n, letter, ac, re, full] of cases) {
    const p = samplingPlan(String(lot), 'II', '2.5');
    assert.equal(p.sampleSize, n, `lot ${lot} sample`);
    assert.equal(p.plan.letter, letter, `lot ${lot} letter`);
    assert.equal(p.plan.ac, ac); assert.equal(p.plan.re, re);
    assert.equal(p.fullInspection, full, `lot ${lot} full`);
    assert.equal(p.planAvailable, true);
  }
});

test('samplingPlan: lot of one, bad input, unsupported AQL', () => {
  const one = samplingPlan('1', 'II', '2.5');
  assert.equal(one.sampleSize, 1); assert.ok(one.lotOfOne && one.fullInspection); assert.equal(one.plan, null);
  for (const bad of ['', '0', '-5', '12.5', 'abc', null, undefined, '1e3', '0x10']) {
    assert.equal(samplingPlan(bad, 'II', '2.5'), null, `input ${bad}`);
  }
  assert.equal(samplingPlan('100', 'IV', '2.5'), null);
  assert.equal(parseLotSize('1,200'), 1200);
  assert.equal(parseLotSize(' 150 '), 150);
  const other = samplingPlan('100', 'II', '0.4');
  assert.equal(other.planAvailable, false);
  assert.equal(other.plan, null);
  assert.equal(other.tableLetter, 'F');
  assert.equal(other.tableSampleSize, 20);
  assert.equal(other.sampleSize, 20);
  assert.equal(other.aql, null);
});

test('normalizeAql accepts common spellings', () => {
  assert.equal(normalizeAql('2.5'), '2.5');
  assert.equal(normalizeAql('2,5'), '2.5');
  assert.equal(normalizeAql(' 1 '), '1.0');
  assert.equal(normalizeAql('1.00'), '1.0');
  assert.equal(normalizeAql('4'), '4.0');
  assert.equal(normalizeAql('0.65'), '0.65');
  assert.equal(normalizeAql('0.4'), null);
  assert.equal(normalizeAql(''), null);
  assert.equal(normalizeAql('AQL 2.5'), null);
});

test('lotDisposition applies Ac/Re of the resolved plan only', () => {
  const p = samplingPlan('400', 'II', '2.5'); // H: n=50, Ac 3, Re 4
  assert.equal(lotDisposition(p, '0'), 'accept');
  assert.equal(lotDisposition(p, '3'), 'accept');
  assert.equal(lotDisposition(p, '4'), 'reject');
  assert.equal(lotDisposition(p, '99'), 'reject');
  assert.equal(lotDisposition(p, ''), null);
  assert.equal(lotDisposition(p, '-1'), null);
  assert.equal(lotDisposition(p, '1.5'), null);
  assert.equal(lotDisposition(samplingPlan('400', 'II', '0.4'), '0'), null);
  assert.equal(lotDisposition(samplingPlan('1', 'II', '2.5'), '0'), null);
  assert.equal(lotDisposition(null, '0'), null);
});
