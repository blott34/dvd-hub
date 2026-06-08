import { describe, it, expect } from 'vitest';
import {
  keepaNum,
  normalizeCandidate,
  isActiveCandidate,
  compareCandidates,
  selectAsin,
} from './asinSelection.js';

// Build a fake Keepa product. Caller sets the high-level fields; we drop them
// into the right slot of the stats arrays (rank index 3, BB index 18).
function product({
  asin = 'B000000000',
  current_rank = null,
  avg30_rank = null,
  monthly_sold = null,
  current_bb_cents = null,
  offer_count = 0,
} = {}) {
  const stats = { current: [], avg30: [] };
  stats.current[3] = current_rank ?? -1;
  stats.current[18] = current_bb_cents ?? -1;
  stats.avg30[3] = avg30_rank ?? -1;
  return {
    asin,
    stats,
    monthlySold: monthly_sold,
    offers: Array.from({ length: offer_count }, () => ({})),
  };
}

describe('keepaNum', () => {
  it('treats -1 as null (Keepa "no data" sentinel)', () => {
    expect(keepaNum(-1)).toBeNull();
  });
  it('treats 0 as null (selection wants positive ranks/prices only)', () => {
    expect(keepaNum(0)).toBeNull();
  });
  it('treats null / undefined / NaN as null', () => {
    expect(keepaNum(null)).toBeNull();
    expect(keepaNum(undefined)).toBeNull();
    expect(keepaNum(NaN)).toBeNull();
  });
  it('passes positive numbers through unchanged', () => {
    expect(keepaNum(1)).toBe(1);
    expect(keepaNum(140_000)).toBe(140_000);
  });
});

describe('normalizeCandidate — -1 sentinel handling', () => {
  it('normalizes -1 rank / -1 BB / -1 avg30 to null', () => {
    const c = normalizeCandidate(
      product({ asin: 'B0XXXXXXXX', current_rank: -1, current_bb_cents: -1, avg30_rank: -1 }),
    );
    expect(c.current_rank).toBeNull();
    expect(c.current_bb_cents).toBeNull();
    expect(c.avg30_rank).toBeNull();
  });

  it('keeps monthly_sold of 0 distinct from null (0 is real data, not a sentinel)', () => {
    const c = normalizeCandidate(product({ asin: 'B0YYYYYYYY', monthly_sold: 0 }));
    expect(c.monthly_sold).toBe(0);
  });
});

describe('isActiveCandidate — filter', () => {
  it('rejects a zombie: rank -1, no monthly_sold', () => {
    const c = normalizeCandidate(product({ current_rank: -1 }));
    expect(isActiveCandidate(c)).toBe(false);
  });
  it('accepts on positive monthly_sold even if rank is -1 (rare but possible)', () => {
    const c = normalizeCandidate(product({ current_rank: -1, monthly_sold: 5 }));
    expect(isActiveCandidate(c)).toBe(true);
  });
  it('accepts on positive current_rank alone', () => {
    const c = normalizeCandidate(product({ current_rank: 50_000 }));
    expect(isActiveCandidate(c)).toBe(true);
  });
  it('rejects when monthly_sold is 0 and rank is -1 (0 is not > 0)', () => {
    const c = normalizeCandidate(product({ current_rank: -1, monthly_sold: 0 }));
    expect(isActiveCandidate(c)).toBe(false);
  });
});

describe('ASIN selection — zombie filtering', () => {
  it('zombie (rank=-1) loses to real listing (production case UPC 025192545726)', () => {
    const zombie = product({
      asin: 'B00G4DSH02',
      current_rank: -1,
      avg30_rank: -1,
      current_bb_cents: 798,
      offer_count: 1,
    });
    const real = product({
      asin: 'B00023B1LC',
      current_rank: 39_000,
      avg30_rank: 42_000,
      current_bb_cents: 1200,
      offer_count: 3,
    });
    const { winnerAsin, candidates } = selectAsin([zombie, real]);
    expect(winnerAsin).toBe('B00023B1LC');
    const zRow = candidates.find((c) => c.asin === 'B00G4DSH02');
    const rRow = candidates.find((c) => c.asin === 'B00023B1LC');
    expect(zRow.passed_active_filter).toBe(false);
    expect(zRow.selected).toBe(false);
    expect(rRow.passed_active_filter).toBe(true);
    expect(rRow.selected).toBe(true);
  });

  it('returns no winner when every candidate is a zombie (FF-3 path)', () => {
    const z1 = product({ asin: 'B000000001', current_rank: -1 });
    const z2 = product({ asin: 'B000000002', current_rank: -1 });
    const { winnerAsin, candidates } = selectAsin([z1, z2]);
    expect(winnerAsin).toBeNull();
    expect(candidates.every((c) => c.passed_active_filter === false)).toBe(true);
    expect(candidates.every((c) => c.selected === false)).toBe(true);
  });
});

describe('ASIN selection — sort priority', () => {
  it('better current_rank wins over higher monthly_sold (rank is the primary key)', () => {
    // Per spec: monthly_sold > 0 qualifies as active but does NOT auto-win selection.
    // Sort is current_rank ASC first, so rank 50k beats rank 200k even when the
    // higher-ranked listing has the better monthly_sold.
    const a = product({ asin: 'B0AAAAAAAA', current_rank: 200_000, monthly_sold: 5 });
    const b = product({ asin: 'B0BBBBBBBB', current_rank: 50_000, monthly_sold: null });
    const { winnerAsin } = selectAsin([a, b]);
    expect(winnerAsin).toBe('B0BBBBBBBB');
  });
});

describe('ASIN selection — tiebreak chain', () => {
  it('rank tied → monthly_sold DESC breaks it', () => {
    const a = product({ asin: 'B0AAAAAAAA', current_rank: 100_000, monthly_sold: 1 });
    const b = product({ asin: 'B0BBBBBBBB', current_rank: 100_000, monthly_sold: 5 });
    const { winnerAsin } = selectAsin([a, b]);
    expect(winnerAsin).toBe('B0BBBBBBBB');
  });

  it('rank + monthly_sold tied → avg30_rank ASC breaks it', () => {
    const a = product({
      asin: 'B0AAAAAAAA',
      current_rank: 100_000,
      monthly_sold: 3,
      avg30_rank: 120_000,
    });
    const b = product({
      asin: 'B0BBBBBBBB',
      current_rank: 100_000,
      monthly_sold: 3,
      avg30_rank: 80_000,
    });
    const { winnerAsin } = selectAsin([a, b]);
    expect(winnerAsin).toBe('B0BBBBBBBB');
  });

  it('rank + monthly_sold + avg30_rank tied → offer_count DESC breaks it', () => {
    const a = product({
      asin: 'B0AAAAAAAA',
      current_rank: 100_000,
      monthly_sold: 3,
      avg30_rank: 100_000,
      offer_count: 1,
    });
    const b = product({
      asin: 'B0BBBBBBBB',
      current_rank: 100_000,
      monthly_sold: 3,
      avg30_rank: 100_000,
      offer_count: 7,
    });
    const { winnerAsin } = selectAsin([a, b]);
    expect(winnerAsin).toBe('B0BBBBBBBB');
  });

  it('every signal tied → alphabetical ASIN is the deterministic final tiebreak', () => {
    const common = { current_rank: 100_000, avg30_rank: 100_000, monthly_sold: 3, offer_count: 2 };
    const c = product({ asin: 'B0CCCCCCCC', ...common });
    const a = product({ asin: 'B0AAAAAAAA', ...common });
    const b = product({ asin: 'B0BBBBBBBB', ...common });
    const { winnerAsin } = selectAsin([c, b, a]);
    expect(winnerAsin).toBe('B0AAAAAAAA');
  });
});

describe('candidate logging shape', () => {
  it('every input product produces one audit row with the expected fields', () => {
    const a = product({ asin: 'B0AAAAAAAA', current_rank: -1 });
    const b = product({
      asin: 'B0BBBBBBBB',
      current_rank: 50_000,
      monthly_sold: 4,
      current_bb_cents: 1299,
      offer_count: 4,
    });
    const { candidates } = selectAsin([a, b]);
    expect(candidates).toHaveLength(2);

    const aRow = candidates.find((c) => c.asin === 'B0AAAAAAAA');
    expect(aRow).toEqual({
      asin: 'B0AAAAAAAA',
      current_rank: null,
      avg30_rank: null,
      monthly_sold: null,
      current_bb_cents: null,
      offer_count: 0,
      passed_active_filter: false,
      selected: false,
    });

    const bRow = candidates.find((c) => c.asin === 'B0BBBBBBBB');
    expect(bRow).toEqual({
      asin: 'B0BBBBBBBB',
      current_rank: 50_000,
      avg30_rank: null,
      monthly_sold: 4,
      current_bb_cents: 1299,
      offer_count: 4,
      passed_active_filter: true,
      selected: true,
    });
  });
});

describe('compareCandidates — direct comparator sanity', () => {
  it('returns negative when a sorts before b on rank', () => {
    const a = { asin: 'B1', current_rank: 100, avg30_rank: null, monthly_sold: null, offer_count: 0 };
    const b = { asin: 'B2', current_rank: 200, avg30_rank: null, monthly_sold: null, offer_count: 0 };
    expect(compareCandidates(a, b)).toBeLessThan(0);
  });
});
