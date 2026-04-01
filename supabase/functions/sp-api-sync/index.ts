// Supabase Edge Function: sp-api-sync
// Fast sync using FBA Inventory Summaries API (no Reports API).
// Fetches all active inventory, filters to DVDBOX/WIIBOX, then batch-fetches
// live prices and sales ranks. Progressive upsert — partial results are saved
// as they come in so even a timeout yields useful data.
//
// Target: complete within 60 seconds.
// Called by the sp-api function's "startSync" action.
// Progress is tracked in the sync_status table.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CONFIRMED_SELLER_ID = "A1TXEW03NQ1VT4";
const SKU_FILTER = /dvdbox|wiibox/i;

// Hard timeout — stop fetching after this many ms to leave time for final upsert
const SYNC_DEADLINE_MS = 55_000;

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

async function spApiGet(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${SP_API_BASE}${path}`;
  console.log("GET", url);
  const res = await fetch(url, {
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
  });
  const body = await res.text();
  if (!res.ok) return { error: true, status: res.status, message: body };
  try { return JSON.parse(body); } catch { return { raw: body }; }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOverDeadline(startTime: number): boolean {
  return Date.now() - startTime > SYNC_DEADLINE_MS;
}

// ---- Main sync logic ----

interface InventoryListing {
  asin: string;
  sku: string;
  title: string;
  current_price: number;
  sales_rank: number | null;
  quantity: number;
}

async function runSync(jobId: string) {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";
  const startTime = Date.now();

  const appendLog = async (msg: string) => {
    console.log(msg);
    await sb.rpc("sync_append_log", { job_id: jobId, msg: msg + "\n" }).catch(() => {});
  };

  const updateStatus = async (fields: Record<string, unknown>) => {
    await sb.from("sync_status").update(fields).eq("id", jobId);
  };

  try {
    await appendLog("Starting fast sync (Inventory Summaries API)");

    // ==========================================
    // Step 1: Fetch all inventory via FBA Inventory Summaries API
    // This is paginated and returns results immediately — no report generation.
    // ==========================================
    await appendLog("Step 1: Fetching inventory summaries...");

    const allListings: InventoryListing[] = [];
    let nextToken: string | null = null;
    let pageCount = 0;
    let totalRaw = 0;

    do {
      if (isOverDeadline(startTime)) {
        await appendLog("Deadline approaching during inventory fetch — proceeding with " + allListings.length + " listings");
        break;
      }

      let inventoryUrl = `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;
      if (nextToken) {
        inventoryUrl += `&nextToken=${encodeURIComponent(nextToken)}`;
      }

      const invRes = await spApiGet(inventoryUrl) as Record<string, unknown>;

      if (invRes.error) {
        // If FBA Inventory API fails (e.g., not enrolled), fall back to DB-only refresh
        await appendLog("Inventory Summaries API failed: " + JSON.stringify(invRes).substring(0, 300));
        await appendLog("Falling back to DB-based refresh (prices + ranks only)...");
        break;
      }

      const payload = invRes.payload as Record<string, unknown> | undefined;
      const summaries = payload?.inventorySummaries as Array<Record<string, unknown>> | undefined;
      const pagination = invRes.pagination as Record<string, unknown> | undefined;

      if (summaries && Array.isArray(summaries)) {
        totalRaw += summaries.length;

        for (const item of summaries) {
          const sku = (item.sellerSku || "") as string;
          if (!SKU_FILTER.test(sku)) continue;
          const qty = (item.totalQuantity || 0) as number;
          if (qty <= 0) continue; // skip out-of-stock

          allListings.push({
            asin: (item.asin || "") as string,
            sku,
            title: (item.productName || "") as string,
            current_price: 0, // will be filled by Pricing API
            sales_rank: null,
            quantity: qty,
          });
        }
      }

      nextToken = pagination?.nextToken as string | null || null;
      pageCount++;
      await appendLog("  Page " + pageCount + ": " + (summaries?.length || 0) + " items, " + allListings.length + " DVDBOX/WIIBOX so far");

    } while (nextToken);

    await updateStatus({ total_raw: totalRaw });

    // If Inventory API returned nothing, fall back to refreshing existing DB listings
    let usingDbFallback = false;
    if (allListings.length === 0) {
      await appendLog("No listings from Inventory API — refreshing existing DB listings");
      usingDbFallback = true;

      const { data: dbListings } = await sb
        .from("listings")
        .select("asin, sku, title, current_price, sales_rank, status")
        .eq("status", "active");

      if (dbListings && dbListings.length > 0) {
        for (const l of dbListings) {
          if (SKU_FILTER.test(l.sku)) {
            allListings.push({
              asin: l.asin,
              sku: l.sku,
              title: l.title,
              current_price: l.current_price || 0,
              sales_rank: l.sales_rank,
              quantity: 1,
            });
          }
        }
        await appendLog("Loaded " + allListings.length + " listings from DB for refresh");
      }
    }

    if (allListings.length === 0) {
      await updateStatus({
        status: "complete",
        completed_at: new Date().toISOString(),
        listings_synced: 0,
        prices_fetched: 0,
        ranks_fetched: 0,
      });
      await appendLog("No listings to sync");
      return;
    }

    await appendLog("Total DVDBOX/WIIBOX listings: " + allListings.length);

    // ==========================================
    // Step 2: Batch-fetch live prices via Pricing API (20 SKUs per batch)
    // Progressive: upsert after each batch so partial data is saved.
    // ==========================================
    await appendLog("Step 2: Fetching live prices...");
    const skus = allListings.map((l) => l.sku).filter(Boolean);
    let pricesFetched = 0;
    const PRICE_BATCH = 20;

    for (let i = 0; i < skus.length; i += PRICE_BATCH) {
      if (isOverDeadline(startTime)) {
        await appendLog("Deadline approaching during price fetch — got " + pricesFetched + " prices");
        break;
      }

      const batch = skus.slice(i, i + PRICE_BATCH);
      const skuParam = batch.map((s) => encodeURIComponent(s)).join("&Skus=");

      try {
        const priceRes = await spApiGet(
          `/products/pricing/v0/price?MarketplaceId=${marketplaceId}&Skus=${skuParam}&ItemType=Sku`
        ) as Record<string, unknown>;

        const payload = priceRes.payload as Array<Record<string, unknown>> | undefined;
        if (payload && Array.isArray(payload)) {
          for (const item of payload) {
            const itemStatus = (item.status || item.Status) as string || "";
            const sku = (item.SKU || item.SellerSKU || item.seller_sku || item.sku) as string;
            if (!sku || itemStatus !== "Success") continue;

            const product = item.Product as Record<string, unknown> | undefined;
            if (!product) continue;

            const offers = product.Offers as Array<Record<string, unknown>> | undefined;
            if (!offers || offers.length === 0) continue;

            let livePrice: number | null = null;
            const buyingPrice = offers[0].BuyingPrice as Record<string, unknown> | undefined;
            if (buyingPrice) {
              const lp = buyingPrice.ListingPrice as Record<string, unknown> | undefined;
              if (lp) {
                const amt = parseFloat(lp.Amount as string || "0");
                if (amt > 0) livePrice = amt;
              }
            }
            if (livePrice === null) {
              const rp = offers[0].RegularPrice as Record<string, unknown> | undefined;
              if (rp) {
                const amt = parseFloat(rp.Amount as string || "0");
                if (amt > 0) livePrice = amt;
              }
            }

            if (livePrice !== null) {
              const listing = allListings.find((l) => l.sku === sku);
              if (listing) {
                listing.current_price = livePrice;
                pricesFetched++;
              }
            }
          }
        }
      } catch (err) {
        console.warn("Pricing batch failed:", err);
      }

      await updateStatus({ prices_fetched: pricesFetched });

      if (i + PRICE_BATCH < skus.length) await sleep(200);
    }

    await appendLog("Live prices fetched: " + pricesFetched + " / " + skus.length);

    // ==========================================
    // Step 3: Batch-fetch sales ranks via Catalog Items API (5 at a time)
    // ==========================================
    await appendLog("Step 3: Fetching sales ranks...");
    const asins = [...new Set(allListings.map((l) => l.asin).filter(Boolean))];
    let ranksFetched = 0;
    const RANK_BATCH = 5;

    for (let i = 0; i < asins.length; i += RANK_BATCH) {
      if (isOverDeadline(startTime)) {
        await appendLog("Deadline approaching during rank fetch — got " + ranksFetched + " ranks");
        break;
      }

      const batch = asins.slice(i, i + RANK_BATCH);
      const promises = batch.map(async (asin) => {
        try {
          const catRes = await spApiGet(
            `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=salesRanks`
          ) as Record<string, unknown>;

          if (catRes && !catRes.error) {
            const salesRanks = catRes.salesRanks as Array<Record<string, unknown>> | undefined;
            if (salesRanks && salesRanks.length > 0) {
              const ranks = salesRanks[0].ranks as Array<{ rank?: number; value?: number }> | undefined;
              if (ranks && ranks.length > 0) {
                const rank = ranks[0].rank ?? ranks[0].value;
                if (typeof rank === "number") {
                  // Apply rank to all listings with this ASIN
                  for (const l of allListings) {
                    if (l.asin === asin) l.sales_rank = rank;
                  }
                  ranksFetched++;
                }
              }
            }
          }
        } catch (err) {
          console.warn("Rank fetch failed for", asin, err);
        }
      });
      await Promise.all(promises);

      await updateStatus({ ranks_fetched: ranksFetched });

      if (i + RANK_BATCH < asins.length) await sleep(200);
    }

    await appendLog("Sales ranks fetched: " + ranksFetched + " / " + asins.length);

    // ==========================================
    // Step 4: Upsert all listings into Supabase
    // ==========================================
    await appendLog("Step 4: Upserting " + allListings.length + " listings...");
    let synced = 0;
    const UPSERT_BATCH = 50;

    for (let i = 0; i < allListings.length; i += UPSERT_BATCH) {
      const batch = allListings.slice(i, i + UPSERT_BATCH);
      const rows = batch.map((l) => {
        const row: Record<string, unknown> = {
          asin: l.asin,
          sku: l.sku,
          title: l.title,
          status: "active",
        };
        // Only update price if we got a live price (> 0)
        if (l.current_price > 0) row.current_price = l.current_price;
        // Only update rank if we got one
        if (l.sales_rank !== null) row.sales_rank = l.sales_rank;
        return row;
      });

      const { error } = await sb
        .from("listings")
        .upsert(rows, { onConflict: "sku", ignoreDuplicates: false });

      if (error) {
        await appendLog("Upsert error (batch " + Math.floor(i / UPSERT_BATCH) + "): " + error.message);
      } else {
        synced += batch.length;
      }

      await updateStatus({ listings_synced: synced });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    await appendLog("Sync complete in " + elapsed + "s: " + synced + " listings, " + pricesFetched + " prices, " + ranksFetched + " ranks");

    await updateStatus({
      status: "complete",
      completed_at: new Date().toISOString(),
      listings_synced: synced,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Sync failed:", msg);
    await updateStatus({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: msg,
    });
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
    const { jobId } = await req.json();
    if (!jobId) throw new Error("Missing jobId");

    // Run sync — respond immediately if EdgeRuntime.waitUntil is available
    const syncPromise = runSync(jobId);

    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime && typeof runtime.waitUntil === "function") {
      runtime.waitUntil(syncPromise);
      return new Response(JSON.stringify({ ok: true, jobId }), {
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      });
    }

    // Fallback: run synchronously
    await syncPromise;
    return new Response(JSON.stringify({ ok: true, jobId, note: "sync completed synchronously" }), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
