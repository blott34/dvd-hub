// Supabase Edge Function: Keepa UPC lookup + auto-verdict
// Keeps the Keepa API key server-side. Frontend calls this function.
//
// Deploy: supabase functions deploy keepa-lookup
// Set secrets:
//   supabase secrets set KEEPA_API_KEY=your_keepa_api_key_here

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// In-memory token tracking across invocations within the same container
let lastKnownTokens: number | null = null;

// ============================================================================
// Rule engine (inlined — canonical copy lives at src/lib/keepaRuleEngine.js)
// THESE VALUES ARE PLACEHOLDERS — tune after week 1 of shadow mode
// ============================================================================
const RANK_CEILING = 1_500_000;
const FLOOR_PRICE_CENTS = 850;
const STANDARD_PASS_PRICE_CENTS = 850;
const STANDARD_PASS_RANK = 500_000;
const STANDARD_PASS_MONTHLY_SOLD = 4;
const HIGH_MARGIN_MONTHLY_SOLD = 2;
const HIGH_MARGIN_AVG180_CENTS = 2499;
const DIPPED_CURRENT_BB_CEILING_CENTS = 850;
const DIPPED_AVG90_FLOOR_CENTS = 1199;
const DIPPED_RANK = 750_000;
const DIPPED_MONTHLY_SOLD = 2;
const WAVE_PRICE_CENTS = 850;
const WAVE_AVG30_CENTS = 850;
const WAVE_MONTHLY_SOLD = 2;
const SUPPRESSED_FBA_FLOOR_CENTS = 1000;
const SUPPRESSED_AVG90_FLOOR_CENTS = 850;
const SUPPRESSED_RANK = 500_000;
const RANK_PROXY_BB_FLOOR_CENTS = 850;
const RANK_PROXY_RANK = 200_000;
const RANK_PROXY_AVG90_FLOOR_CENTS = 850;

// Null/NaN-safe numeric check. `null <= 200000` coerces null to 0 and returns
// true — silently matching ceilings on missing data. Every comparison below
// must gate through isNum first.
function isNum(v: unknown): v is number {
  return typeof v === "number" && !isNaN(v);
}

interface Snapshot {
  current_bb: number | null;
  avg30_bb: number | null;
  avg90_bb: number | null;
  avg180_bb: number | null;
  min_bb: number | null;
  max_bb: number | null;
  current_new: number | null;
  current_rank: number | null;
  avg30_rank: number | null;
  avg90_rank: number | null;
  monthly_sold: number | null;
  lowest_fba_cents: number | null;
  bb_suppressed: boolean;
}

interface RuleResult {
  verdict: "pass" | "fail";
  rule_triggered: string;
}

function evaluateSnapshot(s: Snapshot): RuleResult {
  // Hard-fail floors
  if (isNum(s.current_rank) && s.current_rank > RANK_CEILING) {
    return { verdict: "fail", rule_triggered: "FF-1 rank_too_slow" };
  }
  if (
    isNum(s.max_bb) && s.max_bb < FLOOR_PRICE_CENTS &&
    isNum(s.current_bb) && s.current_bb >= 0 && s.current_bb < FLOOR_PRICE_CENTS
  ) {
    return { verdict: "fail", rule_triggered: "FF-2 always_below_floor" };
  }
  // FF-3 handled before this function (no active ASIN)
  if (
    (!isNum(s.monthly_sold) || s.monthly_sold === 0) &&
    !isNum(s.avg90_rank) &&
    !isNum(s.lowest_fba_cents)
  ) {
    return { verdict: "fail", rule_triggered: "FF-4 no_sales_history" };
  }

  // Pass lanes
  if (
    isNum(s.current_bb) && s.current_bb >= STANDARD_PASS_PRICE_CENTS &&
    isNum(s.current_rank) && s.current_rank <= STANDARD_PASS_RANK &&
    isNum(s.monthly_sold) && s.monthly_sold >= STANDARD_PASS_MONTHLY_SOLD
  ) {
    return { verdict: "pass", rule_triggered: "PL-1 standard_pass" };
  }
  if (
    isNum(s.monthly_sold) && s.monthly_sold >= HIGH_MARGIN_MONTHLY_SOLD &&
    isNum(s.avg180_bb) && s.avg180_bb >= HIGH_MARGIN_AVG180_CENTS
  ) {
    return { verdict: "pass", rule_triggered: "PL-2 high_margin_slow_mover" };
  }
  if (
    isNum(s.current_bb) && s.current_bb >= 0 && s.current_bb < DIPPED_CURRENT_BB_CEILING_CENTS &&
    isNum(s.avg90_bb) && s.avg90_bb >= DIPPED_AVG90_FLOOR_CENTS &&
    isNum(s.current_rank) && s.current_rank <= DIPPED_RANK &&
    isNum(s.monthly_sold) && s.monthly_sold >= DIPPED_MONTHLY_SOLD
  ) {
    return { verdict: "pass", rule_triggered: "PL-3 dipped_but_historically_strong" };
  }
  if (
    isNum(s.current_bb) && s.current_bb >= WAVE_PRICE_CENTS &&
    isNum(s.avg30_bb) && s.avg30_bb >= WAVE_AVG30_CENTS &&
    isNum(s.monthly_sold) && s.monthly_sold >= WAVE_MONTHLY_SOLD
  ) {
    return { verdict: "pass", rule_triggered: "PL-4 riding_the_wave" };
  }
  if (
    s.bb_suppressed &&
    isNum(s.lowest_fba_cents) && s.lowest_fba_cents >= SUPPRESSED_FBA_FLOOR_CENTS &&
    isNum(s.avg90_bb) && s.avg90_bb >= SUPPRESSED_AVG90_FLOOR_CENTS &&
    isNum(s.current_rank) && s.current_rank <= SUPPRESSED_RANK
  ) {
    return { verdict: "pass", rule_triggered: "PL-5 suppressed_bb_strong_fba" };
  }
  // PL-6: rank_proxy_pass — monthly_sold missing, use sales rank as velocity proxy
  if (
    !isNum(s.monthly_sold) &&
    isNum(s.current_bb) && s.current_bb >= RANK_PROXY_BB_FLOOR_CENTS &&
    isNum(s.current_rank) && s.current_rank <= RANK_PROXY_RANK &&
    isNum(s.avg90_bb) && s.avg90_bb >= RANK_PROXY_AVG90_FLOOR_CENTS
  ) {
    return { verdict: "pass", rule_triggered: "PL-6 rank_proxy_pass" };
  }

  return { verdict: "fail", rule_triggered: "borderline_default_fail" };
}

// ============================================================================
// Keepa API helpers
// ============================================================================

function padUpc(upc: string): string {
  return upc.padStart(13, "0");
}

interface KeepaProduct {
  asin: string;
  stats?: {
    current?: (number | null)[];
    avg30?: (number | null)[];
    avg90?: (number | null)[];
    avg180?: (number | null)[];
    min?: (number | null)[];
    max?: (number | null)[];
  };
  monthlySold?: number;
  offers?: KeepaOffer[];
}

interface KeepaOffer {
  isFBA?: boolean;
  condition?: number;
  offerCSV?: number[];
}

function isActive(p: KeepaProduct): boolean {
  const bb = p.stats?.current?.[18];
  const hasBB = bb != null && bb > 0;
  const hasRankAvg = p.stats?.avg30?.[3] != null;
  const hasSales = (p.monthlySold ?? 0) > 0;
  const hasOffers = (p.offers?.length ?? 0) > 0;
  return hasBB || hasRankAvg || hasSales || hasOffers;
}

function selectAsin(products: KeepaProduct[]): {
  winner: KeepaProduct | null;
  candidates: string[];
} {
  const candidates = products.map((p) => p.asin);
  const active = products.filter(isActive);

  if (active.length === 0) return { winner: null, candidates };

  active.sort((a, b) => {
    const soldDiff = (b.monthlySold ?? 0) - (a.monthlySold ?? 0);
    if (soldDiff !== 0) return soldDiff;
    // Ties: highest rank = lower number is better
    const rankA = a.stats?.avg30?.[3] ?? Infinity;
    const rankB = b.stats?.avg30?.[3] ?? Infinity;
    return rankA - rankB;
  });

  return { winner: active[0], candidates };
}

function extractLowestFba(offers: KeepaOffer[] | undefined): number | null {
  if (!offers || offers.length === 0) return null;
  let lowest: number | null = null;
  for (const o of offers) {
    // condition 1 = New, must be FBA
    if (!o.isFBA || o.condition !== 1) continue;
    const csv = o.offerCSV;
    if (!csv || csv.length < 2) continue;
    // offerCSV is [time, price, time, price, ...] — last price is current
    const price = csv[csv.length - 1];
    if (price > 0 && (lowest === null || price < lowest)) {
      lowest = price;
    }
  }
  return lowest;
}

function buildSnapshot(p: KeepaProduct): Snapshot {
  const currentBb = p.stats?.current?.[18] ?? null;
  const lowestFba = extractLowestFba(p.offers);

  return {
    current_bb: currentBb,
    avg30_bb: p.stats?.avg30?.[18] ?? null,
    avg90_bb: p.stats?.avg90?.[18] ?? null,
    avg180_bb: p.stats?.avg180?.[18] ?? null,
    min_bb: p.stats?.min?.[18] ?? null,
    max_bb: p.stats?.max?.[18] ?? null,
    current_new: p.stats?.current?.[1] ?? null,
    current_rank: p.stats?.current?.[3] ?? null,
    avg30_rank: p.stats?.avg30?.[3] ?? null,
    avg90_rank: p.stats?.avg90?.[3] ?? null,
    monthly_sold: p.monthlySold ?? null,
    lowest_fba_cents: lowestFba,
    bb_suppressed: currentBb === -1,
  };
}

// ============================================================================
// Main handler
// ============================================================================

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("KEEPA_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        verdict: "error",
        rule_triggered: "config_error",
        snapshot: null,
        asin: null,
        candidate_asins: null,
        tokens_left: null,
        lookup_ms: null,
        error: "KEEPA_API_KEY not configured. Set via: supabase secrets set KEEPA_API_KEY=xxx",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let upc: string;
  try {
    const body = await req.json();
    upc = String(body.upc || "").trim();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!upc) {
    return new Response(
      JSON.stringify({ error: "upc is required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Rate-limit guard: if last known tokens < 10, wait 15s for regen
  if (lastKnownTokens !== null && lastKnownTokens < 10) {
    await new Promise((r) => setTimeout(r, 15_000));
  }

  const paddedUpc = padUpc(upc);
  const keepaUrl =
    `https://api.keepa.com/product?key=${apiKey}&domain=1&code=${paddedUpc}&stats=180&buybox=1&offers=20&history=0`;

  const t0 = Date.now();
  let keepaRes: Response;
  try {
    keepaRes = await fetch(keepaUrl);
  } catch (err) {
    return new Response(
      JSON.stringify({
        verdict: "error",
        rule_triggered: "keepa_network_error",
        snapshot: null,
        asin: null,
        candidate_asins: null,
        tokens_left: lastKnownTokens,
        lookup_ms: Date.now() - t0,
        error: `Keepa network error: ${(err as Error).message}`,
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const lookupMs = Date.now() - t0;

  let keepaData: { products?: KeepaProduct[]; tokensLeft?: number; error?: unknown };
  try {
    keepaData = await keepaRes.json();
  } catch {
    return new Response(
      JSON.stringify({
        verdict: "error",
        rule_triggered: "keepa_parse_error",
        snapshot: null,
        asin: null,
        candidate_asins: null,
        tokens_left: lastKnownTokens,
        lookup_ms: lookupMs,
        error: "Failed to parse Keepa response",
      }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Update token tracking
  if (keepaData.tokensLeft != null) {
    lastKnownTokens = keepaData.tokensLeft;
  }

  // Handle Keepa throttle / error responses
  if (!keepaRes.ok || keepaData.error) {
    const tokensLeft = keepaData.tokensLeft ?? lastKnownTokens;
    const isThrottle = keepaRes.status === 429 || (tokensLeft != null && tokensLeft <= 0);
    return new Response(
      JSON.stringify({
        verdict: "error",
        rule_triggered: isThrottle ? "keepa_throttled" : "keepa_api_error",
        snapshot: null,
        asin: null,
        candidate_asins: null,
        tokens_left: tokensLeft,
        lookup_ms: lookupMs,
        error: isThrottle
          ? `Keepa throttled — tokens: ${tokensLeft}. Wait ~60 seconds for regen.`
          : `Keepa API error: ${JSON.stringify(keepaData.error)}`,
      }),
      {
        status: isThrottle ? 429 : 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const products = keepaData.products || [];
  if (products.length === 0) {
    return new Response(
      JSON.stringify({
        verdict: "fail",
        rule_triggered: "FF-3 dead_listing",
        snapshot: null,
        asin: null,
        candidate_asins: [],
        tokens_left: keepaData.tokensLeft ?? null,
        lookup_ms: lookupMs,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // UPC → ASIN selection
  const { winner, candidates } = selectAsin(products);

  if (!winner) {
    return new Response(
      JSON.stringify({
        verdict: "fail",
        rule_triggered: "FF-3 dead_listing",
        snapshot: null,
        asin: null,
        candidate_asins: candidates,
        tokens_left: keepaData.tokensLeft ?? null,
        lookup_ms: lookupMs,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Build snapshot and evaluate
  const snapshot = buildSnapshot(winner);
  const { verdict, rule_triggered } = evaluateSnapshot(snapshot);

  return new Response(
    JSON.stringify({
      verdict,
      rule_triggered,
      snapshot,
      asin: winner.asin,
      candidate_asins: candidates,
      tokens_left: keepaData.tokensLeft ?? null,
      lookup_ms: lookupMs,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
