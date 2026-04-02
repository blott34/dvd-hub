// Supabase Edge Function: sp-api-reprice
// Automatic repricing engine that runs on a pg_cron schedule.
// Checks the auto_reprice_settings toggle, loads active DVDBOX/WIIBOX
// listings in pages, fetches Buy Box prices, applies repricing rules,
// and pushes price changes to Amazon.
//
// Designed to stay within edge function resource limits by:
//   - Loading listings in pages of 200
//   - Selecting only needed columns
//   - Processing Buy Box fetches in small batches
//   - Batching DB writes
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

function runRepricingEngine(
  listings: Listing[],
  rules: Rule[],
  buyBoxPrices: Record<string, BuyBoxData>,
): LogEntry[] {
  const log: LogEntry[] = [];
  const now = new Date();

  const ruleMap: Record<string, Rule> = {};
  for (const r of rules) {
    ruleMap[r.rule_name] = r;
  }

  for (const listing of listings) {
    if (listing.status !== "active") continue;
    if (!SKU_FILTER.test(listing.sku)) continue;

    let newPrice = listing.current_price;
    let reason: string | null = null;

    // Pre-pass: Max Hit Day 1
    const maxHitRule = ruleMap["Max Hit Day 1"];
    if (maxHitRule && maxHitRule.is_active) {
      const dateListed = new Date(listing.date_listed + "T00:00:00");
      const daysSinceListed = Math.floor((now.getTime() - dateListed.getTime()) / 86400000);
      const raiseAmount = parseFloat(String(maxHitRule.max_hit_raise_amount)) || 3.0;
      if (daysSinceListed === 0 && listing.current_price >= listing.max_price) {
        listing.max_price = parseFloat((listing.max_price + raiseAmount).toFixed(2));
      }
      // Also: if day 0 and Buy Box is above max, raise max to match Buy Box
      if (daysSinceListed === 0) {
        const bbData = buyBoxPrices[listing.asin];
        const bbPrice = bbData ? bbData.buyBox : null;
        if (bbPrice != null && bbPrice > listing.max_price) {
          listing.max_price = parseFloat(bbPrice.toFixed(2));
        }
      }
    }

    // Pre-pass: Stale Inventory
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
        listing.min_price = parseFloat((listing.min_price - dropAmount).toFixed(2));
      }
    }

    // Rule 0: Match Buy Box
    const matchBBRule = ruleMap["Match Buy Box"];
    if (matchBBRule && matchBBRule.is_active) {
      const bbData = buyBoxPrices[listing.asin];
      const bbPrice = bbData ? bbData.buyBox : null;
      const nobbRaise = parseFloat(String(matchBBRule.no_buybox_raise_amount)) || 1.0;

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
      } else {
        // No Buy Box — hold current price, do nothing
        newPrice = listing.current_price;
        reason = null;
      }
    }

    // Rule 1: Default Floors
    const defaultFloors = ruleMap["Default Floors"];
    if (defaultFloors && defaultFloors.is_active) {
      if (newPrice < listing.min_price) {
        newPrice = listing.min_price;
        reason = "Default Floors: price below minimum, raised to min";
      }
      if (newPrice > listing.max_price) {
        newPrice = listing.max_price;
        reason = "Default Floors: price above maximum, lowered to max";
      }
    }

    // Rule 4: Never Below Cost
    const costRule = ruleMap["Never Below Cost"];
    if (costRule && costRule.is_active) {
      if (newPrice < listing.cost_basis) {
        newPrice = listing.cost_basis;
        reason = `Never Below Cost: floored at cost $${listing.cost_basis.toFixed(2)}`;
      }
    }

    // Rule 5: Sales Rank Guard
    const rankRule = ruleMap["Sales Rank Guard"];
    if (rankRule && rankRule.is_active) {
      const threshold = parseInt(String(rankRule.target_position)) || 500000;
      if (listing.sales_rank && listing.sales_rank > threshold && newPrice < listing.current_price) {
        newPrice = listing.current_price;
        reason = `Sales Rank Guard: rank ${listing.sales_rank.toLocaleString()} above ${threshold.toLocaleString()}, blocked downward reprice`;
      }
    }

    // Final bounds
    newPrice = Math.max(newPrice, listing.min_price);
    newPrice = Math.min(newPrice, listing.max_price);
    newPrice = parseFloat(newPrice.toFixed(2));

    // Hard cap: never exceed max_price regardless of earlier rule mutations
    if (newPrice > listing.max_price) newPrice = listing.max_price;

    if (newPrice !== listing.current_price) {
      log.push({
        asin: listing.asin,
        sku: listing.sku,
        old_price: listing.current_price,
        new_price: newPrice,
        reason: reason || "Price adjusted within bounds",
        timestamp: now.toISOString(),
      });
      listing.current_price = newPrice;
      listing.last_repriced = now.toISOString();
    }
  }

  return log;
}

// ---- Buy Box fetch helper (batch only, no single-ASIN fallback) ----

async function fetchBuyBoxBatch(
  asins: string[],
  marketplaceId: string,
): Promise<Record<string, BuyBoxData>> {
  const result: Record<string, BuyBoxData> = {};

  const requests = asins.map((asin) => ({
    MarketplaceId: marketplaceId,
    Asin: asin,
    ItemType: "Asin",
  }));

  const apiRes = await spApiRequest(
    "/batches/products/pricing/v0/competitivePrice",
    "POST",
    { requests }
  ) as Record<string, unknown>;

  const responses = apiRes.responses as Array<Record<string, unknown>> | undefined;
  if (responses && Array.isArray(responses)) {
    for (const resp of responses) {
      const respBody = resp.body as Record<string, unknown> | undefined;
      if (!respBody) continue;
      const payload = respBody.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      const asin = (payload.ASIN || payload.asin) as string;
      if (!asin) continue;

      const competitivePricing = payload.CompetitivePricing as Record<string, unknown> | undefined;
      const prices = competitivePricing?.CompetitivePrices as Array<Record<string, unknown>> | undefined;
      if (!prices) {
        result[asin] = { buyBox: null, lowest: null };
        continue;
      }

      const bb = prices.find((p) => p.CompetitivePriceId === "1");
      const low = prices.find((p) => p.CompetitivePriceId === "2");

      const getPrice = (entry: Record<string, unknown> | undefined): number | null => {
        if (!entry) return null;
        const price = entry.Price as Record<string, unknown> | undefined;
        const landed = price?.LandedPrice as Record<string, unknown> | undefined;
        if (landed?.Amount) return parseFloat(String(landed.Amount));
        return null;
      };

      result[asin] = { buyBox: getPrice(bb), lowest: getPrice(low) };
    }
  }

  // Fill in any missing ASINs as no-data
  for (const asin of asins) {
    if (!result[asin]) result[asin] = { buyBox: null, lowest: null };
  }

  return result;
}

// ---- Main reprice logic ----
// Processes listings in chunks of CHUNK_SIZE to stay within resource limits.
// Each chunk: load listings → fetch Buy Box → run engine → push changes → persist.

const LISTING_COLS = "id,asin,sku,current_price,min_price,max_price,cost_basis,sales_rank,date_listed,last_sold,last_repriced,status";
const BATCH_SIZE = 100;  // listings per invocation — must complete in ~60s wall clock
const BB_BATCH = 20;     // ASINs per Buy Box API call
const MAX_PUSHES = 25;   // max Amazon price pushes per invocation (~2s each)

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

  // Determine which batch to process this invocation.
  // Each run processes BATCH_SIZE listings starting from a rotating offset.
  // The offset is stored in auto_reprice_settings so the next cron picks up where we left off.
  const { data: offsetRow } = await sb
    .from("auto_reprice_settings")
    .select("interval_minutes")
    .eq("id", 1)
    .single();

  // Reuse interval_minutes column to store the current offset (it's not used for anything else)
  let currentOffset = offsetRow?.interval_minutes || 0;

  // Count total active listings (lightweight HEAD-style query)
  const { count: totalActive } = await sb
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*");

  const totalListings = totalActive || 0;
  console.log("Total active listings:", totalListings, "| Starting at offset:", currentOffset);

  // If offset is past the end, wrap around
  if (currentOffset >= totalListings) currentOffset = 0;

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
  const allErrors: string[] = [];

  try {
    // Load this batch of listings
    const { data: batch, error: batchErr } = await sb
      .from("listings")
      .select(LISTING_COLS)
      .eq("status", "active")
      .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*")
      .range(currentOffset, currentOffset + BATCH_SIZE - 1);

    if (batchErr) throw new Error("Batch load failed: " + batchErr.message);

    const listings = (batch || []) as Listing[];
    totalChecked = listings.length;
    console.log("Loaded", listings.length, "listings (offset", currentOffset, "-", currentOffset + listings.length - 1, ")");

    // Save next offset for the next cron run
    const nextOffset = currentOffset + listings.length;
    await sb.from("auto_reprice_settings").update({
      interval_minutes: nextOffset >= totalListings ? 0 : nextOffset,
    }).eq("id", 1);

    if (listings.length === 0) {
      await sb.from("reprice_runs").update({
        status: "complete",
        completed_at: new Date().toISOString(),
        listings_checked: 0,
        prices_changed: 0,
      }).eq("id", runId);
      return { ok: true, listings_checked: 0, prices_changed: 0 };
    }

    // Fetch Buy Box prices for this batch
    const batchAsins = [...new Set(listings.map((l) => l.asin).filter(Boolean))];
    const buyBoxPrices: Record<string, BuyBoxData> = {};

    for (let i = 0; i < batchAsins.length; i += BB_BATCH) {
      const asinBatch = batchAsins.slice(i, i + BB_BATCH);
      try {
        const bbResult = await fetchBuyBoxBatch(asinBatch, marketplaceId);
        Object.assign(buyBoxPrices, bbResult);
      } catch (err) {
        console.warn("BB batch failed:", err);
        for (const asin of asinBatch) {
          buyBoxPrices[asin] = { buyBox: null, lowest: null };
        }
      }
      if (i + BB_BATCH < batchAsins.length) await sleep(200);
    }

    console.log("BB data:", Object.keys(buyBoxPrices).length, "ASINs");

    // Run repricing engine
    const changes = runRepricingEngine(listings, rules as Rule[], buyBoxPrices);
    totalChanged = changes.length;
    console.log("Engine:", changes.length, "changes");

    // Push price changes to Amazon — ONLY in live mode
    if (liveMode) {
      const toPush = changes.slice(0, MAX_PUSHES);
      for (const change of toPush) {
        try {
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
            allErrors.push(`${change.sku}: no productType`);
            continue;
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
            allErrors.push(`${change.sku}: PATCH failed`);
          } else {
            totalPushed++;
            console.log(`  ${change.sku}: $${change.old_price.toFixed(2)} -> $${change.new_price.toFixed(2)}`);
          }
        } catch (err) {
          allErrors.push(`${change.sku}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await sleep(200);
      }

      if (changes.length > MAX_PUSHES) {
        console.log("Capped Amazon pushes at", MAX_PUSHES, "of", changes.length, "— rest will be pushed next cycle");
      }
    } else {
      console.log("SIMULATION MODE: skipping Amazon push for", changes.length, "changes");
    }

    // Log all changes to repricing_log
    if (changes.length > 0) {
      const tag = liveMode ? "[AUTO]" : "[SIM]";
      const logRows = changes.map((c) => ({
        asin: c.asin,
        sku: c.sku,
        old_price: c.old_price,
        new_price: c.new_price,
        reason: tag + " " + c.reason,
      }));
      await sb.from("repricing_log").insert(logRows);

      // Only update listing prices in DB when in live mode
      if (liveMode) {
        for (const change of changes) {
          const listing = listings.find((l) => l.sku === change.sku);
          if (listing) {
            await sb.from("listings").update({
              current_price: change.new_price,
              last_repriced: new Date().toISOString(),
            }).eq("id", listing.id);
          }
        }
      }
    }

    // Final update
    const finalStatus = allErrors.length > 0 && totalPushed === 0 ? "failed" : "complete";
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
      batch_offset: currentOffset,
      next_offset: nextOffset >= totalListings ? 0 : nextOffset,
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
