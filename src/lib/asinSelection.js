// UPC → ASIN selection logic.
//
// Canonical copy. The edge function (supabase/functions/keepa-lookup/index.ts)
// inlines an equivalent TS version — keep both in lockstep when editing.
//
// Why this module exists separately from keepaRuleEngine: the rule engine
// evaluates ONE snapshot. Selection picks WHICH snapshot the rule engine sees
// when Keepa returns multiple ASINs for the same UPC. Mixing the two led to
// the production bug (UPC 025192545726) where a zombie listing with rank=-1
// beat the real listing with rank=39000.

// Keepa uses -1 as a "no data" sentinel on rank, BB, and price fields.
// Normalize -1 (and 0, null, undefined, NaN) to null so downstream
// ascending sorts don't treat -1 as the best value.
export const keepaNum = (v) =>
  typeof v === 'number' && !isNaN(v) && v > 0 ? v : null;

/**
 * Reduce a raw Keepa product to the fields we use for selection + audit logging.
 * Defensive against missing stats/offers arrays.
 */
export function normalizeCandidate(p) {
  return {
    asin: p.asin,
    current_rank: keepaNum(p.stats?.current?.[3]),
    avg30_rank: keepaNum(p.stats?.avg30?.[3]),
    // monthly_sold uses 0 as real data (zero estimated sales), not a sentinel —
    // so keep 0 distinct from null, don't keepaNum it.
    monthly_sold:
      typeof p.monthlySold === 'number' && !isNaN(p.monthlySold) && p.monthlySold >= 0
        ? p.monthlySold
        : null,
    current_bb_cents: keepaNum(p.stats?.current?.[18]),
    offer_count: Array.isArray(p.offers) ? p.offers.length : 0,
  };
}

/**
 * A candidate is active iff it shows real signs of life:
 *   - monthly_sold > 0 (Keepa estimated at least one sale last month), OR
 *   - current_rank is a positive integer (Keepa refreshes rank within hours
 *     of any sale, so a live rank is a live listing)
 *
 * NOT enough on their own (rejected): a stray offer with no rank, a stale
 * imputed BB, or a rank average without a current rank. These signals are
 * what zombies cling to.
 */
export function isActiveCandidate(c) {
  if (c.monthly_sold != null && c.monthly_sold > 0) return true;
  if (c.current_rank != null) return true; // already filtered to positive by keepaNum
  return false;
}

/**
 * Sort comparator for active candidates. Returns < 0 if a should come first.
 *   1. current_rank ASC (lower is better; null = Infinity, always loses)
 *   2. monthly_sold DESC (null → 0)
 *   3. avg30_rank ASC
 *   4. offer_count DESC
 *   5. asin alphabetical (deterministic final tiebreak)
 */
export function compareCandidates(a, b) {
  const ra = a.current_rank ?? Infinity;
  const rb = b.current_rank ?? Infinity;
  if (ra !== rb) return ra - rb;

  const ma = a.monthly_sold ?? 0;
  const mb = b.monthly_sold ?? 0;
  if (ma !== mb) return mb - ma;

  const aa = a.avg30_rank ?? Infinity;
  const ab = b.avg30_rank ?? Infinity;
  if (aa !== ab) return aa - ab;

  if (a.offer_count !== b.offer_count) return b.offer_count - a.offer_count;

  return a.asin.localeCompare(b.asin);
}

/**
 * Pick the winning ASIN from a list of Keepa products.
 *
 * Returns:
 *   winnerAsin: string | null   — null when no candidate passed the active filter
 *   candidates: array of audit objects, one per input product. Each has:
 *     { asin, current_rank, avg30_rank, monthly_sold, current_bb_cents,
 *       offer_count, passed_active_filter, selected }
 */
export function selectAsin(products) {
  const enriched = products.map((p) => {
    const info = normalizeCandidate(p);
    return { ...info, passed_active_filter: isActiveCandidate(info), selected: false };
  });

  const active = enriched.filter((c) => c.passed_active_filter);

  if (active.length === 0) {
    return { winnerAsin: null, candidates: enriched };
  }

  const sorted = [...active].sort(compareCandidates);
  const winnerAsin = sorted[0].asin;

  return {
    winnerAsin,
    candidates: enriched.map((c) => ({ ...c, selected: c.asin === winnerAsin })),
  };
}
