import { describe, it, expect } from 'vitest';
import { evaluateSnapshot } from './keepaRuleEngine.js';

// Helper: build a base snapshot with sensible defaults, override per test
function snap(overrides = {}) {
  return {
    current_bb: null,
    avg30_bb: null,
    avg90_bb: null,
    avg180_bb: null,
    min_bb: null,
    max_bb: null,
    current_new: null,
    current_rank: null,
    avg30_rank: null,
    avg90_rank: null,
    monthly_sold: null,
    lowest_fba_cents: null,
    bb_suppressed: false,
    ...overrides,
  };
}

describe('Keepa rule engine — worked examples from design doc', () => {
  it('Example 1: DVD rank 200k, BB $12.99, monthlySold 8 → PL-1 standard_pass', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 1299,
        current_rank: 200_000,
        monthly_sold: 8,
        avg30_bb: 1299,
        avg90_bb: 1299,
        avg180_bb: 1299,
        max_bb: 1299,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-1 standard_pass');
  });

  it('Example 2: DVD rank 800k, BB $26, monthlySold 2, 180d avg BB $27.50 → PL-2 high_margin_slow_mover', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 2600,
        current_rank: 800_000,
        monthly_sold: 2,
        avg180_bb: 2750,
        max_bb: 2750,
        avg30_bb: 2600,
        avg90_bb: 2600,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-2 high_margin_slow_mover');
  });

  it('Example 3: DVD rank 400k, current BB $7.99, 90d avg BB $13, monthlySold 3 → PL-3 dipped_but_historically_strong', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 799,
        current_rank: 400_000,
        avg90_bb: 1300,
        monthly_sold: 3,
        max_bb: 1300,
        avg180_bb: 1300,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-3 dipped_but_historically_strong');
  });

  it('Example 4: DVD rank 600k, current BB $9.25, 30d avg BB $9.00, 180d avg BB $6.50, monthlySold 3 → PL-4 riding_the_wave', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 925,
        current_rank: 600_000,
        avg30_bb: 900,
        avg180_bb: 650,
        monthly_sold: 3,
        max_bb: 925,
        avg90_bb: 800,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-4 riding_the_wave');
  });

  it('Example 5: DVD rank 300k, BB suppressed, lowest FBA $12.50, 90d avg BB $10, monthlySold 5 → PL-5 suppressed_bb_strong_fba', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: -1,
        bb_suppressed: true,
        current_rank: 300_000,
        lowest_fba_cents: 1250,
        avg90_bb: 1000,
        monthly_sold: 5,
        max_bb: 1000,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-5 suppressed_bb_strong_fba');
  });

  it('Example 6: DVD rank 2.1M, BB $4.99 → FF-1 rank_too_slow', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 499,
        current_rank: 2_100_000,
        monthly_sold: 0,
        max_bb: 499,
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.rule_triggered).toBe('FF-1 rank_too_slow');
  });
});

describe('Keepa rule engine — hard-fail floors', () => {
  it('FF-2: always_below_floor — max BB and current BB both below $8.50', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 500,
        current_rank: 200_000,
        monthly_sold: 5,
        max_bb: 700,
        avg90_bb: 600,
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.rule_triggered).toBe('FF-2 always_below_floor');
  });

  it('FF-4: no_sales_history — monthlySold 0, no rank avg, no offers', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 1500,
        current_rank: 300_000,
        monthly_sold: 0,
        avg90_rank: null,
        lowest_fba_cents: null,
        max_bb: 1500,
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.rule_triggered).toBe('FF-4 no_sales_history');
  });
});

describe('Keepa rule engine — default fail', () => {
  it('borderline_default_fail when no rule triggers', () => {
    // rank OK, BB above floor but below standard pass, monthlySold 1 (below all lanes)
    const result = evaluateSnapshot(
      snap({
        current_bb: 900,
        current_rank: 600_000,
        monthly_sold: 1,
        avg30_bb: 900,
        avg90_bb: 900,
        avg180_bb: 900,
        max_bb: 900,
        avg90_rank: 600_000,
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.rule_triggered).toBe('borderline_default_fail');
  });
});

describe('Keepa rule engine — PL-6 rank proxy (monthly_sold missing)', () => {
  // avg90_rank set in tests 1-3 to reflect realistic Keepa responses:
  // when current_rank is present, the rank-stats array is populated too. Without
  // it, FF-4 (no_sales_history) would trip first and we'd never reach PL-6.
  it('PL-6 triggers when monthly_sold is null but rank + BB are healthy (real production scan B0898Z8FC1)', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 1039,
        avg90_bb: 922,
        current_rank: 140_000,
        avg90_rank: 140_000,
        monthly_sold: null,
      }),
    );
    expect(result.verdict).toBe('pass');
    expect(result.rule_triggered).toBe('PL-6 rank_proxy_pass');
  });

  it('PL-6 does NOT trigger when rank is above the 200k ceiling', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 1039,
        avg90_bb: 922,
        current_rank: 350_000,
        avg90_rank: 350_000,
        monthly_sold: null,
      }),
    );
    expect(result.verdict).toBe('fail');
    expect(result.rule_triggered).toBe('borderline_default_fail');
  });

  it('PL-6 does NOT trigger when current BB is below the $8.50 floor', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 750,
        avg90_bb: 800,
        current_rank: 100_000,
        avg90_rank: 100_000,
        monthly_sold: null,
      }),
    );
    expect(result.verdict).toBe('fail');
  });

  it('PL-6 does NOT trigger when both current_rank and monthly_sold are null', () => {
    const result = evaluateSnapshot(
      snap({
        current_bb: 1039,
        avg90_bb: 922,
        current_rank: null,
        monthly_sold: null,
      }),
    );
    expect(result.verdict).toBe('fail');
  });
});
