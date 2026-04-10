// Supabase Edge Function: sp-api-reprice
// Automatic repricing engine — runs every 15 min via pg_cron.
// Processes ALL active DVDBOX/WIIBOX listings every run (~1854 listings).
//
// Performance: fetches Buy Box prices in parallel (5 concurrent batches of
// 20 ASINs = 100 ASINs in flight). ~1854 ASINs finish in ~20s vs ~140s
// sequential. Amazon price pushes run 3 concurrent.
//
// Deploy: supabase functions deploy sp-api-reprice

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CONFIRMED_SELLER_ID = "A1TXEW03NQ1VT4";
const SKU_FILTER = /dvdbox|wiibox/i;

let cachedToken: { token: string; expiresAt: number } | null = null;

function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey);
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const clientId = Deno.env.get("SP_API_CLIENT_ID");
  const clientSecret = Deno.env.get("SP_API_CLIENT_SECRET");
  const refreshToken = Deno.env.get("SP_API_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("SP-API credentials not configured");
  }

  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in * 1000),
  };
  return cachedToken.token;
}

async function spApiRequest(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${SP_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "x-amz-access-token": token,
    "Content-Type": "application/json",
  };
  const opts: RequestInit = { method, headers };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const responseBody = await res.text();
  if (!res.ok) return { error: true, status: res.status, message: responseBody };
  try { return JSON.parse(responseBody); } catch { return { raw: responseBody }; }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Repricing Engine ----

interface Listing {
  id: string;
  asin: string;
  sku: string;
  current_price: number;
  min_price: number;
  max_price: number;
  cost_basis: number;
  sales_rank: number | null;
  date_listed: string;
  last_sold: string | null;
  last_repriced: string | null;
  status: string;
}

interface Rule {
  id: string;
  rule_name: string;
  is_active: boolean;
  days_before_drop: number | null;
  drop_amount: number | null;
  max_hit_raise_amount: number | null;
  target_position: number | null;
  no_buybox_raise_amount: number | null;
}

interface BuyBoxData {
  buyBox: number | null;
  lowest: number | null;
}

interface LogEntry {
  asin: string;
  sku: string;
  old_price: number;
  new_price: number;
  reason: string;
  timestamp: string;
}

function getSkuPrefix(sku: string): "DVDBOX" | "WIIBOX" | null {
  const upper = sku.toUpperCase();
  if (upper.includes("DVDBOX")) return "DVDBOX";
  if (upper.includes("WIIBOX")) return "WIIBOX";
  return null;
}

function runRepricingEngine(
  listings: Listing[],
  rules: Rule[],
  buyBoxPrices: Record<string, BuyBoxData>,
  dbUpdates: Array<{ id: string; max_price?: number; min_price?: number; last_repriced?: string }>,
): LogEntry[] {
  const log: LogEntry[] = [];
  const now = new Date();
  const nowIso = now.toISOString();

  const ruleMap: Record<string, Rule> = {};
  for (const r of rules) {
    ruleMap[r.rule_name] = r;
  }

  for (const listing of listings) {
    if (listing.status !== "active") continue;
    if (!SKU_FILTER.test(listing.sku)) continue;

    const prefix = getSkuPrefix(listing.sku);
    if (!prefix) continue;

    // Every listing that the engine actually evaluates gets a last_repriced
    // stamp in the DB, regardless of live_mode or whether the price changed.
    // This lets the UI show when each listing was last touched by the engine.
    dbUpdates.push({ id: listing.id, last_repriced: nowIso });

    let newPrice = listing.current_price;
    let reason: string | null = null;
    const appliedRules: string[] = [];

    console.log(`[${prefix}] Processing ${listing.sku} (ASIN ${listing.asin}) current=$${listing.current_price.toFixed(2)} min=$${listing.min_price.toFixed(2)} max=$${listing.max_price.toFixed(2)}`);

    // ---- DVDBOX: dynamic min/max computed from Buy Box in the Match Buy Box section below ----

    // ---- DVDBOX ONLY: Max Hit Day 1 ----
    if (prefix === "DVDBOX") {
      const maxHitRule = ruleMap["Max Hit Day 1"];
      if (maxHitRule && maxHitRule.is_active) {
        const dateListed = new Date(listing.date_listed + "T00:00:00");
        const daysSinceListed = Math.floor((now.getTime() - dateListed.getTime()) / 86400000);
        if (daysSinceListed === 0) {
          const bbData = buyBoxPrices[listing.asin];
          const bbPrice = bbData ? bbData.buyBox : null;
          if (bbPrice != null && bbPrice > listing.max_price) {
            const oldMax = listing.max_price;
            listing.max_price = parseFloat(bbPrice.toFixed(2));
            appliedRules.push(`Max Hit Day 1: raised max from $${oldMax.toFixed(2)} to $${listing.max_price.toFixed(2)} (BB above max on day 0)`);
            // Persist the raised max_price to the database
            dbUpdates.push({ id: listing.id, max_price: listing.max_price });
          }
        }
      }
    }

    // ---- DVDBOX ONLY: Stale Inventory ----
    if (prefix === "DVDBOX") {
      const staleRule = ruleMap["Stale Inventory"];
      if (staleRule && staleRule.is_active) {
        const daysBefore = parseInt(String(staleRule.days_before_drop)) || 30;
        const dropAmount = parseFloat(String(staleRule.drop_amount)) || 0.5;
        const dateListed = new Date(listing.date_listed + "T00:00:00");
        const daysActive = Math.floor((now.getTime() - dateListed.getTime()) / 86400000);
        const lastSold = listing.last_sold ? new Date(listing.last_sold) : null;
        const daysSinceSale = lastSold
          ? Math.floor((now.getTime() - lastSold.getTime()) / 86400000)
          : daysActive;
        if (daysSinceSale >= daysBefore) {
          const oldMin = listing.min_price;
          listing.min_price = parseFloat((listing.min_price - dropAmount).toFixed(2));
          appliedRules.push(`Stale Inventory: dropped min from $${oldMin.toFixed(2)} to $${listing.min_price.toFixed(2)} (${daysSinceSale} days without sale)`);
          dbUpdates.push({ id: listing.id, min_price: listing.min_price });
        }
      }
    }

    // ---- Match Buy Box ----
    const bbData = buyBoxPrices[listing.asin];
    const bbPrice = bbData ? bbData.buyBox : null;

    if (prefix === "DVDBOX") {
      // DVDBOX: dynamic min/max derived from Buy Box price each run
      const DVDBOX_HARD_FLOOR = 8.50;

      if (bbPrice != null) {
        const dynMin = parseFloat(Math.max(DVDBOX_HARD_FLOOR, bbPrice - 3.00).toFixed(2));
        const dynMax = parseFloat((bbPrice + 10.00).toFixed(2));

        // Persist dynamic bounds to listing and DB
        listing.min_price = dynMin;
        listing.max_price = dynMax;
        dbUpdates.push({ id: listing.id, min_price: dynMin, max_price: dynMax });

        // Target = match Buy Box directly, clamped to dynamic bounds
        newPrice = Math.max(dynMin, Math.min(bbPrice, dynMax));
        newPrice = parseFloat(newPrice.toFixed(2));
        reason = `Match Buy Box: target $${bbPrice.toFixed(2)} (dynMin=$${dynMin.toFixed(2)}, dynMax=$${dynMax.toFixed(2)})`;
        appliedRules.push(reason);
      } else {
        // No Buy Box — hold current price, widen bounds so clamp doesn't cap at old 24.99
        newPrice = listing.current_price;
        listing.min_price = DVDBOX_HARD_FLOOR;
        listing.max_price = Math.max(listing.current_price, listing.max_price);
        dbUpdates.push({ id: listing.id, min_price: DVDBOX_HARD_FLOOR, max_price: listing.max_price });
        reason = null;
        appliedRules.push(`No Buy Box: holding at $${listing.current_price.toFixed(2)} (min=$${listing.min_price.toFixed(2)}, max=$${listing.max_price.toFixed(2)})`);
      }
    } else {
      // WIIBOX: original min/max logic
      if (bbPrice != null) {
        if (bbPrice >= listing.min_price && bbPrice <= listing.max_price) {
          newPrice = bbPrice;
          reason = `Match Buy Box: matched at $${bbPrice.toFixed(2)}`;
        } else if (bbPrice < listing.min_price) {
          newPrice = listing.min_price;
          reason = `Match Buy Box: BB $${bbPrice.toFixed(2)} below min, set to min $${listing.min_price.toFixed(2)}`;
        } else {
          newPrice = listing.max_price;
          reason = `Match Buy Box: BB $${bbPrice.toFixed(2)} above max, set to max $${listing.max_price.toFixed(2)}`;
        }
        appliedRules.push(reason);
      } else {
        // No Buy Box — hold current price
        newPrice = listing.current_price;
        reason = null;
        appliedRules.push("No Buy Box: holding current price");
      }
    }

    // ---- BOTH: Never Below Cost ----
    const costRule = ruleMap["Never Below Cost"];
    if (costRule && costRule.is_active) {
      if (newPrice < listing.cost_basis) {
        newPrice = listing.cost_basis;
        reason = `Never Below Cost: floored at cost $${listing.cost_basis.toFixed(2)}`;
        appliedRules.push(reason);
      }
    }

    // ---- BOTH: Sales Rank Guard ----
    const rankRule = ruleMap["Sales Rank Guard"];
    if (rankRule && rankRule.is_active) {
      const threshold = parseInt(String(rankRule.target_position)) || 500000;
      if (listing.sales_rank && listing.sales_rank > threshold && newPrice < listing.current_price) {
        newPrice = listing.current_price;
        reason = `Sales Rank Guard: rank ${listing.sales_rank.toLocaleString()} above ${threshold.toLocaleString()}, blocked downward reprice`;
        appliedRules.push(reason);
      }
    }

    // Final bounds
    const preBounds = newPrice;
    newPrice = Math.max(newPrice, listing.min_price);
    newPrice = Math.min(newPrice, listing.max_price);
    // DVDBOX hard floor — suggested_price can never go below $8.50
    if (prefix === "DVDBOX") {
      newPrice = Math.max(newPrice, 8.50);
    }
    newPrice = parseFloat(newPrice.toFixed(2));
    if (newPrice !== preBounds) {
      reason = `Bounds clamp: $${preBounds.toFixed(2)} -> $${newPrice.toFixed(2)} (min=$${listing.min_price.toFixed(2)}, max=$${listing.max_price.toFixed(2)})`;
      appliedRules.push(reason);
    }

    console.log(`[${prefix}] ${listing.sku}: rules applied: ${appliedRules.join(" | ")}`);

    if (newPrice !== listing.current_price) {
      const finalReason = `[${prefix}] ${reason || "No change reason"}`;
      console.log(`[${prefix}] ${listing.sku}: $${listing.current_price.toFixed(2)} -> $${newPrice.toFixed(2)} (${finalReason})`);
      log.push({
        asin: listing.asin,
        sku: listing.sku,
        old_price: listing.current_price,
        new_price: newPrice,
        reason: finalReason,
        timestamp: now.toISOString(),
      });
      listing.current_price = newPrice;
      listing.last_repriced = now.toISOString();
    } else {
      console.log(`[${prefix}] ${listing.sku}: no change, holding at $${listing.current_price.toFixed(2)}`);
    }
  }

  return log;
}

// ---- Buy Box fetch helper (batch only, no single-ASIN fallback) ----


/**
 * Pull a price value from a CompetitivePrices entry.
 * Prefers LandedPrice (what buyers actually pay), falls back to
 * ListingPrice + Shipping if LandedPrice is missing (some sellers don't
 * report landed price for FBM offers).
 */
function extractPriceFromEntry(entry: Record<string, unknown> | undefined): number | null {
  if (!entry) return null;
  const price = entry.Price as Record<string, unknown> | undefined;
  if (!price) return null;

  const landed = price.LandedPrice as Record<string, unknown> | undefined;
  if (landed && landed.Amount != null) {
    const amt = parseFloat(String(landed.Amount));
    if (!isNaN(amt) && amt > 0) return amt;
  }

  const listing = price.ListingPrice as Record<string, unknown> | undefined;
  if (listing && listing.Amount != null) {
    const listAmt = parseFloat(String(listing.Amount));
    const shipping = price.Shipping as Record<string, unknown> | undefined;
    const shipAmt = shipping && shipping.Amount != null ? parseFloat(String(shipping.Amount)) : 0;
    if (!isNaN(listAmt) && listAmt > 0) return listAmt + (isNaN(shipAmt) ? 0 : shipAmt);
  }

  return null;
}

/**
 * Parse one batch sub-response into { asin, buyBox, lowest }.
 *
 * Defensive against two real shapes observed in SP-API:
 *   A) body.payload is an OBJECT with CompetitivePricing at the root
 *      { payload: { ASIN, CompetitivePricing: { CompetitivePrices: [...] } } }
 *   B) body.payload is an ARRAY and CompetitivePricing is nested under Product
 *      { payload: [ { ASIN, Product: { CompetitivePricing: { CompetitivePrices: [...] } } } ] }
 *
 * The non-batch endpoint uses shape B. The batch endpoint has been observed
 * in both shapes across SP-API regions/versions, so we handle either.
 */
function parseCompetitivePricePayload(
  respBody: Record<string, unknown> | undefined
): { asin: string | null; buyBox: number | null; lowest: number | null } {
  if (!respBody) return { asin: null, buyBox: null, lowest: null };

  // Unwrap payload which may be array-of-one or a single object.
  let payloadNode: Record<string, unknown> | undefined;
  const raw = respBody.payload;
  if (Array.isArray(raw)) {
    payloadNode = raw[0] as Record<string, unknown> | undefined;
  } else {
    payloadNode = raw as Record<string, unknown> | undefined;
  }
  if (!payloadNode) return { asin: null, buyBox: null, lowest: null };

  const asin = ((payloadNode.ASIN || payloadNode.asin) as string) || null;

  // CompetitivePricing may be at payload root OR nested under Product.
  let competitivePricing = payloadNode.CompetitivePricing as Record<string, unknown> | undefined;
  if (!competitivePricing) {
    const product = payloadNode.Product as Record<string, unknown> | undefined;
    competitivePricing = product?.CompetitivePricing as Record<string, unknown> | undefined;
  }
  if (!competitivePricing) return { asin, buyBox: null, lowest: null };

  const prices = competitivePricing.CompetitivePrices as Array<Record<string, unknown>> | undefined;
  if (!prices || prices.length === 0) return { asin, buyBox: null, lowest: null };

  // CompetitivePriceId: "1" = Buy Box, "2" = Lowest. Amazon historically sends
  // these as strings, but we compare loosely to tolerate number form too.
  const idMatches = (entry: Record<string, unknown>, id: string) =>
    String(entry.CompetitivePriceId) === id;

  const bb = prices.find((p) => idMatches(p, "1"));
  const low = prices.find((p) => idMatches(p, "2"));

  return {
    asin,
    buyBox: extractPriceFromEntry(bb),
    lowest: extractPriceFromEntry(low),
  };
}

async function fetchBuyBoxBatch(
  asins: string[],
  marketplaceId: string,
): Promise<Record<string, BuyBoxData>> {
  const result: Record<string, BuyBoxData> = {};
  if (asins.length === 0) return result;

  // Use the GET /products/pricing/v0/competitivePrice endpoint, which accepts
  // up to 20 comma-separated ASINs in a single call. We previously used
  // POST /batches/products/pricing/v0/competitivePrice, but SP-API returns
  // 403 Unauthorized for that path — the batch variant either doesn't exist
  // for competitivePrice or requires a role we don't have. The single-GET
  // variant uses the same underlying Pricing API role.
  const asinsParam = asins.map(encodeURIComponent).join(",");
  const path = `/products/pricing/v0/competitivePrice?MarketplaceId=${marketplaceId}&Asins=${asinsParam}&ItemType=Asin`;

  const apiRes = await spApiRequest(path) as Record<string, unknown>;

  // If the request errored (e.g. 403, rate-limited), fall through and mark
  // every ASIN as no-data. The caller will hold prices on the no-BB path.
  if (apiRes.error) {
    for (const asin of asins) result[asin] = { buyBox: null, lowest: null };
    return result;
  }

  // Response shape: { payload: [ { ASIN, status, Product: { CompetitivePricing: {...} } }, ... ] }
  // Also tolerant of an object payload or a payload with CompetitivePricing at
  // the root — see parseCompetitivePricePayload for both shapes.
  const payloadArr = apiRes.payload as Array<Record<string, unknown>> | Record<string, unknown> | undefined;
  const entries: Array<Record<string, unknown>> = Array.isArray(payloadArr)
    ? payloadArr
    : payloadArr
      ? [payloadArr]
      : [];

  for (const entry of entries) {
    // Each entry from the GET endpoint is already "the payload" — wrap it so
    // parseCompetitivePricePayload can do its normal work.
    const parsed = parseCompetitivePricePayload({ payload: entry });
    if (!parsed.asin) continue;
    result[parsed.asin] = { buyBox: parsed.buyBox, lowest: parsed.lowest };
  }

  // Fill in any missing ASINs as no-data
  for (const asin of asins) {
    if (!result[asin]) result[asin] = { buyBox: null, lowest: null };
  }

  return result;
}

// ---- Main reprice logic ----
// Processes ALL active listings every run by fetching Buy Box prices in parallel.
// BB fetches run 5 concurrent batches of 20 ASINs each (100 ASINs in flight at once).
// Amazon price pushes run 3 concurrent to stay within SP-API rate limits.

const LISTING_COLS = "id,asin,sku,current_price,min_price,max_price,cost_basis,sales_rank,date_listed,last_sold,last_repriced,status";
const BB_BATCH = 20;          // ASINs per Buy Box API call (SP-API max)
const BB_CONCURRENCY = 5;     // concurrent BB API calls (5 × 20 = 100 ASINs in flight)
const PUSH_CONCURRENCY = 3;   // concurrent Amazon price pushes
const DB_PAGE_SIZE = 1000;    // Supabase returns max 1000 rows per query

/** Load ALL active DVDBOX/WIIBOX listings, paginating through Supabase's 1000-row limit */
async function loadAllListings(sb: ReturnType<typeof getSupabaseAdmin>): Promise<Listing[]> {
  const all: Listing[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("listings")
      .select(LISTING_COLS)
      .eq("status", "active")
      .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*")
      .order("asin", { ascending: true })
      .range(from, from + DB_PAGE_SIZE - 1);

    if (error) throw new Error("Listing load failed: " + error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as Listing[]));
    if (data.length < DB_PAGE_SIZE) break; // last page
    from += DB_PAGE_SIZE;
  }
  return all;
}

/** Fetch Buy Box prices for all ASINs in parallel with concurrency control */
async function fetchAllBuyBoxes(
  asins: string[],
  marketplaceId: string,
): Promise<Record<string, BuyBoxData>> {
  const buyBoxPrices: Record<string, BuyBoxData> = {};

  // Split into batches of BB_BATCH (20)
  const batches: string[][] = [];
  for (let i = 0; i < asins.length; i += BB_BATCH) {
    batches.push(asins.slice(i, i + BB_BATCH));
  }

  console.log(`Fetching BB for ${asins.length} ASINs in ${batches.length} batches (${BB_CONCURRENCY} concurrent)`);
  const startTime = Date.now();

  // Process batches with concurrency control
  let batchIndex = 0;
  const runNext = async (): Promise<void> => {
    while (batchIndex < batches.length) {
      const idx = batchIndex++;
      const batch = batches[idx];
      try {
        const result = await fetchBuyBoxBatch(batch, marketplaceId);
        Object.assign(buyBoxPrices, result);
      } catch (err) {
        console.warn(`BB batch ${idx} failed:`, err);
        for (const asin of batch) {
          buyBoxPrices[asin] = { buyBox: null, lowest: null };
        }
      }
    }
  };

  // Launch BB_CONCURRENCY workers
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(BB_CONCURRENCY, batches.length); w++) {
    workers.push(runNext());
  }
  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`BB fetch complete: ${Object.keys(buyBoxPrices).length} ASINs in ${elapsed}s`);
  return buyBoxPrices;
}

/** Push a single price change to Amazon (GET productType + PATCH price) */
async function pushPriceToAmazon(
  change: LogEntry,
  marketplaceId: string,
): Promise<{ ok: boolean; error?: string }> {
  const encodedSku = encodeURIComponent(change.sku);

  const listingInfo = await spApiRequest(
    `/listings/2021-08-01/items/${CONFIRMED_SELLER_ID}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=summaries`
  ) as Record<string, unknown>;

  let productType: string | null = null;
  if (listingInfo && !listingInfo.error) {
    const summaries = listingInfo.summaries as Array<Record<string, unknown>> | undefined;
    if (summaries && summaries.length > 0 && summaries[0].productType) {
      productType = summaries[0].productType as string;
    }
  }

  if (!productType) {
    return { ok: false, error: `${change.sku}: no productType` };
  }

  const patchBody = {
    productType,
    patches: [{
      op: "replace",
      path: "/attributes/purchasable_offer",
      value: [{
        marketplace_id: marketplaceId,
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: change.new_price.toFixed(2) }] }],
      }],
    }],
  };

  const patchResult = await spApiRequest(
    `/listings/2021-08-01/items/${CONFIRMED_SELLER_ID}/${encodedSku}?marketplaceIds=${marketplaceId}&issueLocale=en_US`,
    "PATCH",
    patchBody
  ) as Record<string, unknown>;

  if (patchResult.error) {
    return { ok: false, error: `${change.sku}: PATCH failed` };
  }

  console.log(`  PUSHED ${change.sku}: $${change.old_price.toFixed(2)} -> $${change.new_price.toFixed(2)}`);
  return { ok: true };
}

async function runAutoReprice() {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Step 0: Check if auto-reprice is enabled and whether live_mode is on
  const { data: settings, error: settingsErr } = await sb
    .from("auto_reprice_settings")
    .select("enabled,live_mode")
    .eq("id", 1)
    .single();

  console.log("Settings:", JSON.stringify({ settings, err: settingsErr?.message }));

  if (!settings || !settings.enabled) {
    console.log("Auto-reprice is disabled. Skipping.");
    return { skipped: true, reason: "Auto-reprice disabled" };
  }

  const liveMode = settings.live_mode === true;
  console.log("Mode:", liveMode ? "LIVE — will push to Amazon" : "SIMULATION — observe only");

  // Load repricing rules (small table, load once)
  const { data: rules } = await sb
    .from("repricing_rules")
    .select("*")
    .order("id", { ascending: true });

  if (!rules || rules.length === 0) {
    return { error: "No repricing rules found" };
  }

  console.log("Rules loaded:", rules.length);

  // Create a reprice_runs record
  const { data: run, error: runErr } = await sb
    .from("reprice_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (runErr || !run) {
    console.error("Failed to create reprice_runs entry:", runErr?.message);
    return { error: "Failed to create run record" };
  }

  const runId = run.id;
  let totalChecked = 0;
  let totalChanged = 0;
  let totalPushed = 0;
  let persistAttempted = 0;
  let persistSuccess = 0;
  let persistFail = 0;
  let persistNoMatch = 0;
  const persistErrors: string[] = [];
  const allErrors: string[] = [];

  try {
    // Load ALL active listings (paginated through Supabase 1000-row limit)
    const listings = await loadAllListings(sb);
    totalChecked = listings.length;
    console.log(`Loaded ALL ${listings.length} active listings`);

    if (listings.length === 0) {
      await sb.from("reprice_runs").update({
        status: "complete",
        completed_at: new Date().toISOString(),
        listings_checked: 0,
        prices_changed: 0,
      }).eq("id", runId);
      return { ok: true, listings_checked: 0, prices_changed: 0 };
    }

    // Fetch Buy Box prices for ALL unique ASINs in parallel
    const allAsins = [...new Set(listings.map((l) => l.asin).filter(Boolean))];
    const buyBoxPrices = await fetchAllBuyBoxes(allAsins, marketplaceId);

    // Run repricing engine
    const dbUpdates: Array<{ id: string; max_price?: number; min_price?: number; last_repriced?: string }> = [];
    const changes = runRepricingEngine(listings, rules as Rule[], buyBoxPrices, dbUpdates);
    totalChanged = changes.length;
    console.log("Engine:", changes.length, "changes,", dbUpdates.length, "DB updates (min/max/last_repriced)");

    // Merge duplicate dbUpdates per listing ID (last entry wins per field)
    const mergedUpdates: Record<string, { id: string; min_price?: number; max_price?: number; last_repriced?: string }> = {};
    for (const upd of dbUpdates) {
      if (!mergedUpdates[upd.id]) {
        mergedUpdates[upd.id] = { id: upd.id };
      }
      if (upd.min_price != null) mergedUpdates[upd.id].min_price = upd.min_price;
      if (upd.max_price != null) mergedUpdates[upd.id].max_price = upd.max_price;
      if (upd.last_repriced != null) mergedUpdates[upd.id].last_repriced = upd.last_repriced;
    }
    const dedupedUpdates = Object.values(mergedUpdates);

    // Persist min/max + last_repriced adjustments in parallel batches
    persistAttempted = dedupedUpdates.length;
    if (dedupedUpdates.length > 0) {
      console.log(`Persisting ${dedupedUpdates.length} listings (merged from ${dbUpdates.length} entries)`);
      // Log first 5 updates for debugging
      for (const sample of dedupedUpdates.slice(0, 5)) {
        console.log(`  DB UPDATE: id=${sample.id} min_price=${sample.min_price} max_price=${sample.max_price} last_repriced=${sample.last_repriced}`);
      }
      const updatePromises = dedupedUpdates.map(async (upd) => {
        const fields: Record<string, number | string> = {};
        if (upd.max_price != null) fields.max_price = upd.max_price;
        if (upd.min_price != null) fields.min_price = upd.min_price;
        if (upd.last_repriced != null) fields.last_repriced = upd.last_repriced;
        try {
          // .select("id") forces the update to return affected rows so we can
          // detect silent 0-row updates (e.g. id mismatch, RLS block).
          const { data, error } = await sb
            .from("listings")
            .update(fields)
            .eq("id", upd.id)
            .select("id");
          if (error) {
            persistFail++;
            const msg = `PERSIST FAILED id=${upd.id}: ${error.message} (code=${error.code})`;
            console.error(`  ${msg}`);
            if (persistErrors.length < 10) persistErrors.push(msg);
          } else if (!data || data.length === 0) {
            persistNoMatch++;
            const msg = `PERSIST NO-MATCH id=${upd.id}: update returned 0 rows (fields=${JSON.stringify(fields)})`;
            console.error(`  ${msg}`);
            if (persistErrors.length < 10) persistErrors.push(msg);
          } else {
            persistSuccess++;
          }
        } catch (e) {
          persistFail++;
          const msg = `PERSIST THREW id=${upd.id}: ${e instanceof Error ? e.message : String(e)}`;
          console.error(`  ${msg}`);
          if (persistErrors.length < 10) persistErrors.push(msg);
        }
      });
      await Promise.all(updatePromises);
      console.log(`Persist results: ${persistSuccess} success, ${persistNoMatch} no-match, ${persistFail} failed out of ${dedupedUpdates.length}`);
    }

    // Push price changes to Amazon — ONLY in live mode, with concurrency control
    if (liveMode && changes.length > 0) {
      console.log(`Pushing ${changes.length} price changes to Amazon (${PUSH_CONCURRENCY} concurrent)`);
      let pushIndex = 0;
      const pushNext = async (): Promise<void> => {
        while (pushIndex < changes.length) {
          const idx = pushIndex++;
          const change = changes[idx];
          try {
            const result = await pushPriceToAmazon(change, marketplaceId);
            if (result.ok) {
              totalPushed++;
            } else {
              allErrors.push(result.error || `${change.sku}: unknown push error`);
            }
          } catch (err) {
            allErrors.push(`${change.sku}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };

      const pushWorkers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(PUSH_CONCURRENCY, changes.length); w++) {
        pushWorkers.push(pushNext());
      }
      await Promise.all(pushWorkers);
    } else if (!liveMode && changes.length > 0) {
      console.log("SIMULATION MODE: skipping Amazon push for", changes.length, "changes");
    }

    // Log all changes to repricing_log (batch insert)
    if (changes.length > 0) {
      const tag = liveMode ? "[AUTO]" : "[SIM]";
      const logRows = changes.map((c) => ({
        asin: c.asin,
        sku: c.sku,
        old_price: c.old_price,
        new_price: c.new_price,
        reason: tag + " " + c.reason,
      }));
      // Supabase batch insert handles large arrays fine
      await sb.from("repricing_log").insert(logRows);

      // Update listing prices in DB when in live mode (batch via Promise.all)
      if (liveMode) {
        const priceUpdates = changes.map((change) => {
          const listing = listings.find((l) => l.sku === change.sku);
          if (!listing) return Promise.resolve();
          return sb.from("listings").update({
            current_price: change.new_price,
            last_repriced: new Date().toISOString(),
          }).eq("id", listing.id);
        });
        await Promise.all(priceUpdates);
      }
    }

    // Final update
    const finalStatus = allErrors.length > 0 && totalPushed === 0 && liveMode ? "failed" : "complete";
    await sb.from("reprice_runs").update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      listings_checked: totalChecked,
      prices_changed: totalChanged,
      error_message: allErrors.length > 0 ? allErrors.slice(0, 20).join("\n") : null,
    }).eq("id", runId);

    console.log("Done:", totalChecked, "checked,", totalChanged, "changed,", totalPushed, "pushed to Amazon");

    return {
      ok: true,
      runId,
      listings_checked: totalChecked,
      prices_changed: totalChanged,
      pushed_to_amazon: totalPushed,
      persist: {
        attempted: persistAttempted,
        success: persistSuccess,
        no_match: persistNoMatch,
        failed: persistFail,
        errors: persistErrors.length > 0 ? persistErrors : undefined,
      },
      errors: allErrors.length > 0 ? allErrors.slice(0, 10) : undefined,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Auto-reprice failed:", msg);

    await sb.from("reprice_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
      listings_checked: totalChecked,
      prices_changed: totalChanged,
      error_message: msg,
    }).eq("id", runId);

    return { error: msg, runId };
  }
}

// ---- HTTP Handler ----

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const result = await runAutoReprice();

    return new Response(JSON.stringify(result), {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  }
});
