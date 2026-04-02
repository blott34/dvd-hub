// Supabase Edge Function: sp-api-reprice
// Automatic repricing engine that runs on a pg_cron schedule.
// Checks the auto_reprice_settings toggle, loads all active DVDBOX/WIIBOX
// listings, fetches Buy Box prices, applies repricing rules, and pushes
// price changes to Amazon.
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

// ---- Repricing Engine (server-side, mirrors src/repricer/engine.js) ----

interface Listing {
  id: string;
  asin: string;
  sku: string;
  title: string;
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
      if (daysSinceListed <= 1 && listing.current_price >= listing.max_price) {
        listing.max_price = parseFloat((listing.max_price + raiseAmount).toFixed(2));
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
        const raised = Math.min(listing.current_price + nobbRaise, listing.max_price);
        newPrice = parseFloat(raised.toFixed(2));
        reason = `No Buy Box - incremental raise of $${nobbRaise.toFixed(2)}`;
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

// ---- Main reprice logic ----

async function runAutoReprice() {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Step 0: Check if auto-reprice is enabled
  const { data: settings, error: settingsErr } = await sb
    .from("auto_reprice_settings")
    .select("enabled")
    .eq("id", 1)
    .single();

  console.log("Auto-reprice settings query:", JSON.stringify({ settings, error: settingsErr?.message }));

  if (!settings || !settings.enabled) {
    console.log("Auto-reprice is disabled. Skipping.");
    return { skipped: true, reason: "Auto-reprice disabled" };
  }

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
  console.log("Auto-reprice run started:", runId);

  try {
    // Step 1: Load active DVDBOX/WIIBOX listings from Supabase
    // Supabase JS client defaults to 1000 rows — use range to get all
    const { data: listings, error: listErr, count: listCount } = await sb
      .from("listings")
      .select("*", { count: "exact" })
      .eq("status", "active")
      .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*")
      .range(0, 4999);

    console.log("Listings query result — count:", listCount, "rows returned:", listings?.length, "error:", listErr?.message || "none");

    if (listErr) throw new Error("Failed to load listings: " + listErr.message);

    const activeListings = (listings || []) as Listing[];

    console.log("Active DVDBOX/WIIBOX listings:", activeListings.length);
    if (activeListings.length > 0) {
      console.log("Sample listing:", JSON.stringify(activeListings[0]));
    }

    if (activeListings.length === 0) {
      await sb.from("reprice_runs").update({
        status: "complete",
        completed_at: new Date().toISOString(),
        listings_checked: 0,
        prices_changed: 0,
      }).eq("id", runId);
      return { ok: true, listings_checked: 0, prices_changed: 0 };
    }

    // Step 2: Load repricing rules
    const { data: rules } = await sb
      .from("repricing_rules")
      .select("*")
      .order("id", { ascending: true });

    if (!rules || rules.length === 0) {
      throw new Error("No repricing rules found");
    }

    // Step 3: Fetch Buy Box prices for all active listings
    console.log("Fetching Buy Box prices for", activeListings.length, "listings...");
    const buyBoxPrices: Record<string, BuyBoxData> = {};
    const asins = [...new Set(activeListings.map((l) => l.asin).filter(Boolean))];

    // Batch competitive pricing — up to 20 ASINs at a time
    const BB_BATCH = 20;
    for (let i = 0; i < asins.length; i += BB_BATCH) {
      const batch = asins.slice(i, i + BB_BATCH);

      try {
        const requests = batch.map((asin) => ({
          MarketplaceId: marketplaceId,
          Asin: asin,
          ItemType: "Asin",
        }));

        const result = await spApiRequest(
          "/batches/products/pricing/v0/competitivePrice",
          "POST",
          { requests }
        ) as Record<string, unknown>;

        // Parse batch response
        const responses = (result as Record<string, unknown>).responses as Array<Record<string, unknown>> | undefined;
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
              buyBoxPrices[asin] = { buyBox: null, lowest: null };
              continue;
            }

            const bb = prices.find((p) => p.CompetitivePriceId === "1");
            const low = prices.find((p) => p.CompetitivePriceId === "2");

            const getBBPrice = (entry: Record<string, unknown> | undefined): number | null => {
              if (!entry) return null;
              const price = entry.Price as Record<string, unknown> | undefined;
              const landed = price?.LandedPrice as Record<string, unknown> | undefined;
              if (landed?.Amount) return parseFloat(String(landed.Amount));
              return null;
            };

            buyBoxPrices[asin] = {
              buyBox: getBBPrice(bb),
              lowest: getBBPrice(low),
            };
          }
        } else {
          // Fallback: single-ASIN response format
          for (const asin of batch) {
            try {
              const singleRes = await spApiRequest(
                `/products/pricing/v0/competitivePrice?MarketplaceId=${marketplaceId}&Asins=${asin}&ItemType=Asin`
              ) as Record<string, unknown>;

              if (singleRes.payload && Array.isArray(singleRes.payload)) {
                const item = (singleRes.payload as Array<Record<string, unknown>>)[0];
                const product = item?.Product as Record<string, unknown> | undefined;
                const cp = product?.CompetitivePricing as Record<string, unknown> | undefined;
                const prices = cp?.CompetitivePrices as Array<Record<string, unknown>> | undefined;

                if (prices) {
                  const bb = prices.find((p) => p.CompetitivePriceId === "1");
                  const low = prices.find((p) => p.CompetitivePriceId === "2");

                  const getPrice = (entry: Record<string, unknown> | undefined): number | null => {
                    if (!entry) return null;
                    const price = entry.Price as Record<string, unknown> | undefined;
                    const landed = price?.LandedPrice as Record<string, unknown> | undefined;
                    if (landed?.Amount) return parseFloat(String(landed.Amount));
                    return null;
                  };

                  buyBoxPrices[asin] = { buyBox: getPrice(bb), lowest: getPrice(low) };
                } else {
                  buyBoxPrices[asin] = { buyBox: null, lowest: null };
                }
              }
            } catch (err) {
              console.warn("Single BB fetch failed for", asin, err);
              buyBoxPrices[asin] = { buyBox: null, lowest: null };
            }
          }
        }
      } catch (err) {
        console.warn("Batch BB fetch failed:", err);
        // Mark all in batch as no data
        for (const asin of batch) {
          if (!buyBoxPrices[asin]) buyBoxPrices[asin] = { buyBox: null, lowest: null };
        }
      }

      if (i + BB_BATCH < asins.length) await sleep(500);
    }

    console.log("Buy Box data fetched for", Object.keys(buyBoxPrices).length, "ASINs");

    // Step 4: Run repricing engine
    console.log("Running repricing engine...");
    const changes = runRepricingEngine(activeListings, rules as Rule[], buyBoxPrices);
    console.log("Engine result:", changes.length, "price changes");

    // Step 5: Push changes to Amazon and persist to Supabase
    let pushedCount = 0;
    const pushErrors: string[] = [];

    for (const change of changes) {
      // Push to Amazon via Listings API
      try {
        const encodedSku = encodeURIComponent(change.sku);

        // Get product type for PATCH
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
          pushErrors.push(`${change.sku}: could not determine productType`);
          continue;
        }

        // PATCH price update
        const patchBody = {
          productType,
          patches: [
            {
              op: "replace",
              path: "/attributes/purchasable_offer",
              value: [
                {
                  marketplace_id: marketplaceId,
                  currency: "USD",
                  our_price: [
                    {
                      schedule: [
                        { value_with_tax: change.new_price.toFixed(2) },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        };

        const patchResult = await spApiRequest(
          `/listings/2021-08-01/items/${CONFIRMED_SELLER_ID}/${encodedSku}?marketplaceIds=${marketplaceId}&issueLocale=en_US`,
          "PATCH",
          patchBody
        ) as Record<string, unknown>;

        if (patchResult.error) {
          pushErrors.push(`${change.sku}: PATCH failed - ${JSON.stringify(patchResult).substring(0, 200)}`);
        } else {
          pushedCount++;
          console.log(`  [${change.sku}] $${change.old_price.toFixed(2)} -> $${change.new_price.toFixed(2)} PUSHED`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushErrors.push(`${change.sku}: ${msg}`);
      }

      // Small delay between price pushes to avoid throttling
      await sleep(300);
    }

    // Step 6: Persist changes to Supabase
    for (const change of changes) {
      // Save repricing log entry
      await sb.from("repricing_log").insert({
        asin: change.asin,
        sku: change.sku,
        old_price: change.old_price,
        new_price: change.new_price,
        reason: "[AUTO] " + change.reason,
      });

      // Update listing price in DB
      const listing = activeListings.find((l) => l.sku === change.sku);
      if (listing) {
        await sb.from("listings").update({
          current_price: change.new_price,
          last_repriced: new Date().toISOString(),
        }).eq("id", listing.id);
      }
    }

    // Step 7: Update reprice_runs record
    const finalStatus = pushErrors.length > 0 && pushedCount === 0 ? "failed" : "complete";
    const errorMsg = pushErrors.length > 0 ? pushErrors.join("\n") : null;

    await sb.from("reprice_runs").update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      listings_checked: activeListings.length,
      prices_changed: changes.length,
      error_message: errorMsg,
    }).eq("id", runId);

    console.log("Auto-reprice complete:", activeListings.length, "checked,", changes.length, "changed,", pushedCount, "pushed to Amazon");

    return {
      ok: true,
      runId,
      listings_checked: activeListings.length,
      prices_changed: changes.length,
      pushed_to_amazon: pushedCount,
      errors: pushErrors.length > 0 ? pushErrors : undefined,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Auto-reprice failed:", msg);

    await sb.from("reprice_runs").update({
      status: "failed",
      completed_at: new Date().toISOString(),
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
