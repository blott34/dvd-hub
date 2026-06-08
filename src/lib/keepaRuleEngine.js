// Keepa Auto-Verdict Rule Engine — Phase 1
//
// Pure function: input is a trimmed snapshot object, output is { verdict, rule_triggered }.
// All prices in cents. Ranks are raw integers. monthlySold is an integer.

// ============================================================================
// THESE VALUES ARE PLACEHOLDERS — tune after week 1 of shadow mode
// ============================================================================
const RANK_CEILING = 1_500_000;             // FF-1
const FLOOR_PRICE_CENTS = 850;              // FF-2: $8.50
const STANDARD_PASS_PRICE_CENTS = 850;      // PL-1: $8.50
const STANDARD_PASS_RANK = 500_000;         // PL-1
const STANDARD_PASS_MONTHLY_SOLD = 4;       // PL-1
const HIGH_MARGIN_MONTHLY_SOLD = 2;         // PL-2
const HIGH_MARGIN_AVG180_CENTS = 2499;      // PL-2: $24.99
const DIPPED_CURRENT_BB_CEILING_CENTS = 850; // PL-3: current BB < $8.50
const DIPPED_AVG90_FLOOR_CENTS = 1199;      // PL-3: $11.99
const DIPPED_RANK = 750_000;                // PL-3
const DIPPED_MONTHLY_SOLD = 2;              // PL-3
const WAVE_PRICE_CENTS = 850;               // PL-4: $8.50
const WAVE_AVG30_CENTS = 850;               // PL-4: $8.50
const WAVE_MONTHLY_SOLD = 2;                // PL-4
const SUPPRESSED_FBA_FLOOR_CENTS = 1000;    // PL-5: $10.00
const SUPPRESSED_AVG90_FLOOR_CENTS = 850;   // PL-5: $8.50
const SUPPRESSED_RANK = 500_000;            // PL-5
const RANK_PROXY_BB_FLOOR_CENTS = 850;      // PL-6: $8.50
const RANK_PROXY_RANK = 200_000;            // PL-6
const RANK_PROXY_AVG90_FLOOR_CENTS = 850;   // PL-6: $8.50
// ============================================================================

// Null/NaN-safe numeric check. `null <= 200000` coerces null to 0 and returns
// true — silently matching ceilings on missing data. Every comparison below
// must gate through isNum first.
const isNum = (v) => typeof v === 'number' && !isNaN(v);

/**
 * @param {object} snapshot — trimmed Keepa snapshot
 * @param {number|null} snapshot.current_bb — current Buy Box price in cents (-1 if suppressed)
 * @param {number|null} snapshot.avg30_bb
 * @param {number|null} snapshot.avg90_bb
 * @param {number|null} snapshot.avg180_bb
 * @param {number|null} snapshot.min_bb
 * @param {number|null} snapshot.max_bb
 * @param {number|null} snapshot.current_new
 * @param {number|null} snapshot.current_rank
 * @param {number|null} snapshot.avg30_rank
 * @param {number|null} snapshot.avg90_rank
 * @param {number|null} snapshot.monthly_sold
 * @param {number|null} snapshot.lowest_fba_cents
 * @param {boolean}     snapshot.bb_suppressed
 * @returns {{ verdict: 'pass'|'fail', rule_triggered: string }}
 */
export function evaluateSnapshot(snapshot) {
  const {
    current_bb,
    avg90_bb,
    avg180_bb,
    avg30_bb,
    max_bb,
    current_rank,
    avg90_rank,
    monthly_sold,
    lowest_fba_cents,
    bb_suppressed,
  } = snapshot;

  // --- Hard-fail floors (any one → FAIL) ---

  // FF-1: rank_too_slow
  if (isNum(current_rank) && current_rank > RANK_CEILING) {
    return { verdict: 'fail', rule_triggered: 'FF-1 rank_too_slow' };
  }

  // FF-2: always_below_floor
  // 180-day max BB < $8.50 AND current BB < $8.50 (and not suppressed)
  if (
    isNum(max_bb) && max_bb < FLOOR_PRICE_CENTS &&
    isNum(current_bb) && current_bb >= 0 && current_bb < FLOOR_PRICE_CENTS
  ) {
    return { verdict: 'fail', rule_triggered: 'FF-2 always_below_floor' };
  }

  // FF-3: dead_listing — handled before this function is called (no active ASIN)

  // FF-4: no_sales_history
  if (
    (!isNum(monthly_sold) || monthly_sold === 0) &&
    !isNum(avg90_rank) &&
    !isNum(lowest_fba_cents)
  ) {
    return { verdict: 'fail', rule_triggered: 'FF-4 no_sales_history' };
  }

  // --- Pass lanes (first match → PASS) ---

  // PL-1: standard_pass
  if (
    isNum(current_bb) && current_bb >= STANDARD_PASS_PRICE_CENTS &&
    isNum(current_rank) && current_rank <= STANDARD_PASS_RANK &&
    isNum(monthly_sold) && monthly_sold >= STANDARD_PASS_MONTHLY_SOLD
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-1 standard_pass' };
  }

  // PL-2: high_margin_slow_mover
  if (
    isNum(monthly_sold) && monthly_sold >= HIGH_MARGIN_MONTHLY_SOLD &&
    isNum(avg180_bb) && avg180_bb >= HIGH_MARGIN_AVG180_CENTS
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-2 high_margin_slow_mover' };
  }

  // PL-3: dipped_but_historically_strong
  if (
    isNum(current_bb) && current_bb >= 0 && current_bb < DIPPED_CURRENT_BB_CEILING_CENTS &&
    isNum(avg90_bb) && avg90_bb >= DIPPED_AVG90_FLOOR_CENTS &&
    isNum(current_rank) && current_rank <= DIPPED_RANK &&
    isNum(monthly_sold) && monthly_sold >= DIPPED_MONTHLY_SOLD
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-3 dipped_but_historically_strong' };
  }

  // PL-4: riding_the_wave
  if (
    isNum(current_bb) && current_bb >= WAVE_PRICE_CENTS &&
    isNum(avg30_bb) && avg30_bb >= WAVE_AVG30_CENTS &&
    isNum(monthly_sold) && monthly_sold >= WAVE_MONTHLY_SOLD
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-4 riding_the_wave' };
  }

  // PL-5: suppressed_bb_strong_fba
  if (
    bb_suppressed &&
    isNum(lowest_fba_cents) && lowest_fba_cents >= SUPPRESSED_FBA_FLOOR_CENTS &&
    isNum(avg90_bb) && avg90_bb >= SUPPRESSED_AVG90_FLOOR_CENTS &&
    isNum(current_rank) && current_rank <= SUPPRESSED_RANK
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-5 suppressed_bb_strong_fba' };
  }

  // PL-6: rank_proxy_pass — monthly_sold missing, use sales rank as velocity proxy
  if (
    !isNum(monthly_sold) &&
    isNum(current_bb) && current_bb >= RANK_PROXY_BB_FLOOR_CENTS &&
    isNum(current_rank) && current_rank <= RANK_PROXY_RANK &&
    isNum(avg90_bb) && avg90_bb >= RANK_PROXY_AVG90_FLOOR_CENTS
  ) {
    return { verdict: 'pass', rule_triggered: 'PL-6 rank_proxy_pass' };
  }

  // --- Default ---
  return { verdict: 'fail', rule_triggered: 'borderline_default_fail' };
}
