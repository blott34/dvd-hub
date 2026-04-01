// Supabase Edge Function: sp-api-sync
// SKU-based sync — accepts a list of SKUs, looks up each via Listings Items API
// and Pricing API, then upserts into the listings table.
// Processes in batches of 10 with progress tracking.
//
// Called by the sp-api function's "startSync" action.
// Can also be called directly with a list of SKUs for manual import.
// Progress is tracked in the sync_status table.

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

// ---- Main sync logic ----

interface SyncedListing {
  asin: string;
  sku: string;
  title: string;
  current_price: number;
  sales_rank: number | null;
}

async function runSync(jobId: string, skus?: string[]) {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  const appendLog = async (msg: string) => {
    console.log(msg);
    await sb.rpc("sync_append_log", { job_id: jobId, msg: msg + "\n" }).catch(() => {});
  };

  const updateStatus = async (fields: Record<string, unknown>) => {
    await sb.from("sync_status").update(fields).eq("id", jobId);
  };

  try {
    // Determine which SKUs to sync
    let skusToSync: string[] = [];

    if (skus && skus.length > 0) {
      // Manual import — use provided SKUs
      skusToSync = skus.filter((s) => SKU_FILTER.test(s));
      await appendLog("Manual import: " + skusToSync.length + " valid SKUs provided");
    } else {
      // Refresh mode — reload all existing SKUs from the database
      await appendLog("Refresh mode: loading existing SKUs from database...");
      const { data: dbListings } = await sb
        .from("listings")
        .select("sku")
        .eq("status", "active")
        .or("sku.ilike.%dvdbox%,sku.ilike.%wiibox%");

      if (dbListings && dbListings.length > 0) {
        skusToSync = dbListings.map((l: { sku: string }) => l.sku);
        await appendLog("Found " + skusToSync.length + " existing SKUs to refresh");
      } else {
        await appendLog("No existing listings in DB. Use Import SKUs to add listings.");
        await updateStatus({
          status: "complete",
          completed_at: new Date().toISOString(),
          listings_synced: 0,
          prices_fetched: 0,
          ranks_fetched: 0,
        });
        return;
      }
    }

    await updateStatus({ total_raw: skusToSync.length });

    // ==========================================
    // Step 1: Look up each SKU via Listings Items API to get ASIN + title
    // Process 10 at a time to avoid throttling
    // ==========================================
    await appendLog("Step 1: Looking up " + skusToSync.length + " SKUs via Listings Items API...");
    const results: SyncedListing[] = [];
    const LOOKUP_BATCH = 10;
    let lookupsDone = 0;
    let lookupsFailed = 0;

    for (let i = 0; i < skusToSync.length; i += LOOKUP_BATCH) {
      const batch = skusToSync.slice(i, i + LOOKUP_BATCH);

      // Run batch in parallel (Listings Items API is per-SKU)
      const promises = batch.map(async (sku) => {
        try {
          const encodedSku = encodeURIComponent(sku);
          const res = await spApiGet(
            `/listings/2021-08-01/items/${CONFIRMED_SELLER_ID}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=summaries`
          ) as Record<string, unknown>;

          if (res.error) {
            console.warn(`  [${sku}] Listing lookup failed:`, (res.message as string || "").substring(0, 100));
            lookupsFailed++;
            return;
          }

          // Extract ASIN and title from summaries
          const summaries = res.summaries as Array<Record<string, unknown>> | undefined;
          let asin = "";
          let title = "";

          if (summaries && summaries.length > 0) {
            asin = (summaries[0].asin || "") as string;
            title = (summaries[0].itemName || "") as string;
          }

          if (!asin) {
            // Try alternate response paths
            asin = (res.asin || "") as string;
          }

          if (asin) {
            results.push({
              asin,
              sku,
              title,
              current_price: 0,
              sales_rank: null,
            });
            lookupsDone++;
          } else {
            console.warn(`  [${sku}] No ASIN found in response`);
            lookupsFailed++;
          }
        } catch (err) {
          console.warn(`  [${sku}] Lookup error:`, err);
          lookupsFailed++;
        }
      });

      await Promise.all(promises);
      await appendLog("  Looked up " + (i + batch.length) + "/" + skusToSync.length + " SKUs (" + results.length + " found, " + lookupsFailed + " failed)");
      await updateStatus({ listings_synced: results.length });

      if (i + LOOKUP_BATCH < skusToSync.length) await sleep(300);
    }

    await appendLog("Listings found: " + results.length + " / " + skusToSync.length);

    if (results.length === 0) {
      await updateStatus({
        status: lookupsFailed > 0 ? "failed" : "complete",
        completed_at: new Date().toISOString(),
        listings_synced: 0,
        prices_fetched: 0,
        ranks_fetched: 0,
        error_message: lookupsFailed > 0 ? lookupsFailed + " SKU lookups failed" : null,
      });
      return;
    }

    // ==========================================
    // Step 2: Batch-fetch live prices via Pricing API (20 SKUs per batch)
    // ==========================================
    await appendLog("Step 2: Fetching live prices...");
    const priceSkus = results.map((l) => l.sku).filter(Boolean);
    let pricesFetched = 0;
    const PRICE_BATCH = 20;

    for (let i = 0; i < priceSkus.length; i += PRICE_BATCH) {
      const batch = priceSkus.slice(i, i + PRICE_BATCH);
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
              const listing = results.find((l) => l.sku === sku);
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
      if (i + PRICE_BATCH < priceSkus.length) await sleep(200);
    }

    await appendLog("Prices fetched: " + pricesFetched + " / " + priceSkus.length);

    // ==========================================
    // Step 3: Batch-fetch sales ranks via Catalog Items API (5 at a time)
    // ==========================================
    await appendLog("Step 3: Fetching sales ranks...");
    const asins = [...new Set(results.map((l) => l.asin).filter(Boolean))];
    let ranksFetched = 0;
    const RANK_BATCH = 5;

    for (let i = 0; i < asins.length; i += RANK_BATCH) {
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
                  for (const l of results) {
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

    await appendLog("Ranks fetched: " + ranksFetched + " / " + asins.length);

    // ==========================================
    // Step 4: Upsert into Supabase
    // ==========================================
    await appendLog("Step 4: Upserting " + results.length + " listings...");
    let synced = 0;
    const UPSERT_BATCH = 50;

    for (let i = 0; i < results.length; i += UPSERT_BATCH) {
      const batch = results.slice(i, i + UPSERT_BATCH);
      const rows = batch.map((l) => {
        const row: Record<string, unknown> = {
          asin: l.asin,
          sku: l.sku,
          title: l.title,
          status: "active",
        };
        if (l.current_price > 0) row.current_price = l.current_price;
        if (l.sales_rank !== null) row.sales_rank = l.sales_rank;
        return row;
      });

      const { error } = await sb
        .from("listings")
        .upsert(rows, { onConflict: "sku", ignoreDuplicates: false });

      if (error) {
        await appendLog("Upsert error: " + error.message);
      } else {
        synced += batch.length;
      }
    }

    await appendLog("Sync complete: " + synced + " listings upserted, " + pricesFetched + " prices, " + ranksFetched + " ranks");
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
    const body = await req.json();
    const jobId = body.jobId;
    const skus = body.skus as string[] | undefined;

    if (!jobId) throw new Error("Missing jobId");

    const syncPromise = runSync(jobId, skus);

    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime && typeof runtime.waitUntil === "function") {
      runtime.waitUntil(syncPromise);
      return new Response(JSON.stringify({ ok: true, jobId }), {
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      });
    }

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
