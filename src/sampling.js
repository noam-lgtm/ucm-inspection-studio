/*
 * Attribute sampling per MIL-STD-105D / MIL-STD-105E (identical tables; both
 * superseded by ANSI/ASQ Z1.4 and ISO 2859-1, which carry the same tables).
 *
 * Table I   - sample size code letters (lot size x inspection level).
 * Table II-A - single sampling plans for NORMAL inspection (code letter x AQL).
 *
 * Only Table II-A columns that were cross-checked against independent
 * transcriptions are shipped (AQL 0.65 / 1.0 / 1.5 / 2.5 / 4.0 / 6.5). Other
 * AQLs are accepted as free text but no plan is calculated for them.
 *
 * Tightened and reduced inspection (Tables II-B, II-C) and switching rules
 * are intentionally NOT implemented. Nothing here invents acceptance rules.
 */

export const LOT_RANGES = Object.freeze([
  [2, 8], [9, 15], [16, 25], [26, 50], [51, 90], [91, 150], [151, 280],
  [281, 500], [501, 1200], [1201, 3200], [3201, 10000], [10001, 35000],
  [35001, 150000], [150001, 500000], [500001, Number.POSITIVE_INFINITY],
]);

export const LEVELS = Object.freeze(['S-1', 'S-2', 'S-3', 'S-4', 'I', 'II', 'III']);
export const GENERAL_LEVELS = Object.freeze(['I', 'II', 'III']);

// Table I. One letter per lot range, in LOT_RANGES order.
const CODE_LETTER_ROWS = Object.freeze({
  'S-1': 'AAAABBBBCCCCDDD',
  'S-2': 'AAABBBCCCDDDEEE',
  'S-3': 'AABBCCDDEEFFGGH',
  'S-4': 'AABCCDEEFGGHJJK',
  'I': 'AABCCDEFGHJKLMN',
  'II': 'ABCDEFGHJKLMNPQ',
  'III': 'BCDEFGHJKLMNPQR',
});

export const CODE_LETTERS = 'ABCDEFGHJKLMNPQR'.split('');

export const SAMPLE_SIZE_BY_LETTER = Object.freeze({
  A: 2, B: 3, C: 5, D: 8, E: 13, F: 20, G: 32, H: 50,
  J: 80, K: 125, L: 200, M: 315, N: 500, P: 800, Q: 1250, R: 2000,
});

// Table II-A, normal inspection, single sampling. Index = CODE_LETTERS order.
// 'v' = arrow down (use first plan below), '^' = arrow up (use first plan above).
const DOWN = 'v';
const UP = '^';
const P = (ac, re) => Object.freeze([ac, re]);
export const TABLE_IIA = Object.freeze({
  '0.65': [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22)],
  '1.0': [DOWN, DOWN, DOWN, DOWN, DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22), UP],
  '1.5': [DOWN, DOWN, DOWN, DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22), UP, UP],
  '2.5': [DOWN, DOWN, DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22), UP, UP, UP],
  '4.0': [DOWN, DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22), UP, UP, UP, UP],
  '6.5': [DOWN, P(0, 1), UP, P(1, 2), P(2, 3), P(3, 4), P(5, 6), P(7, 8), P(10, 11), P(14, 15), P(21, 22), UP, UP, UP, UP, UP],
});

export const SUPPORTED_AQLS = Object.freeze(Object.keys(TABLE_IIA));

/** Normalise user AQL text ("2,5", "2.50", " 4 ") to a supported column key or null. */
export function normalizeAql(value) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const num = Number(text);
  return SUPPORTED_AQLS.find(k => Number(k) === num) || null;
}

/** Parse a lot size. Accepts "1,200" and " 150 ". Returns a positive safe integer or null. */
export function parseLotSize(value) {
  const text = String(value == null ? '' : value).trim().replace(/[\s,]/g, '');
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Table I lookup. Returns the code letter or null. Lot size must be >= 2. */
export function codeLetter(lotSize, level) {
  if (!LEVELS.includes(level)) return null;
  const n = Number(lotSize);
  if (!Number.isSafeInteger(n) || n < 2) return null;
  const index = LOT_RANGES.findIndex(([low, high]) => n >= low && n <= high);
  if (index === -1) return null;
  return CODE_LETTER_ROWS[level][index];
}

/**
 * Resolve the Table II-A cell for (letter, aql), following arrows.
 * Returns { letter, sampleSize, ac, re, arrow } or null when AQL unsupported.
 */
export function singleSamplingPlan(letter, aql) {
  const key = normalizeAql(aql);
  const column = key && TABLE_IIA[key];
  const start = CODE_LETTERS.indexOf(letter);
  if (!column || start === -1) return null;
  let i = start;
  let arrow = '';
  if (column[i] === DOWN) { arrow = 'down'; while (i < column.length && column[i] === DOWN) i++; }
  else if (column[i] === UP) { arrow = 'up'; while (i >= 0 && column[i] === UP) i--; }
  const cell = column[i];
  if (!Array.isArray(cell)) return null;
  const planLetter = CODE_LETTERS[i];
  return { letter: planLetter, sampleSize: SAMPLE_SIZE_BY_LETTER[planLetter], ac: cell[0], re: cell[1], arrow, aql: key };
}

/**
 * Full sampling evaluation for a lot.
 * @returns {object|null} null when the lot size is unusable.
 *  {
 *    lotSize, level, aql (normalised key or null),
 *    tableLetter, tableSampleSize,          // Table I
 *    plan: { letter, sampleSize, ac, re, arrow } | null,   // Table II-A (null when AQL unsupported)
 *    sampleSize,                            // effective sample size to inspect (after arrows and 100% rule)
 *    fullInspection, lotOfOne, planAvailable
 *  }
 */
export function samplingPlan(lotSizeInput, level = 'II', aql = '2.5') {
  const lotSize = parseLotSize(lotSizeInput);
  if (!lotSize || !LEVELS.includes(level)) return null;
  const aqlKey = normalizeAql(aql);
  if (lotSize === 1) {
    return {
      lotSize, level, aql: aqlKey, tableLetter: null, tableSampleSize: null, plan: null,
      sampleSize: 1, fullInspection: true, lotOfOne: true, planAvailable: false,
    };
  }
  const tableLetter = codeLetter(lotSize, level);
  const tableSampleSize = SAMPLE_SIZE_BY_LETTER[tableLetter];
  const plan = aqlKey ? singleSamplingPlan(tableLetter, aqlKey) : null;
  const planSize = plan ? plan.sampleSize : tableSampleSize;
  const fullInspection = planSize >= lotSize;
  return {
    lotSize, level, aql: aqlKey, tableLetter, tableSampleSize, plan,
    sampleSize: Math.min(lotSize, planSize),
    fullInspection, lotOfOne: false, planAvailable: Boolean(plan),
  };
}

/**
 * Lot disposition from the number of nonconforming units found in the sample.
 * Returns 'accept' | 'reject' | null (null = cannot evaluate).
 */
export function lotDisposition(plan, nonconformingCount) {
  if (!plan || !plan.plan) return null;
  const text = String(nonconformingCount == null ? '' : nonconformingCount).trim();
  if (!/^\d+$/.test(text)) return null;
  const d = Number(text);
  if (d <= plan.plan.ac) return 'accept';
  if (d >= plan.plan.re) return 'reject';
  return null;
}
