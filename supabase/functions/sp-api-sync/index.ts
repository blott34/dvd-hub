// Supabase Edge Function: sp-api-sync
// Full listing discovery using Amazon Reports API (GET_MERCHANT_LISTINGS_ALL_DATA).
// Triggered daily at 6am ET by pg_cron, or manually from the owner dashboard.
//
// Flow:
//   1. Request GET_MERCHANT_LISTINGS_ALL_DATA report
//   2. Poll until report is DONE (no timeout — runs in background)
//   3. Download and parse TSV
//   4. Filter to DVDBOX/WIIBOX SKUs
//   5. Batch-fetch prices via Pricing API
//   6. Batch-fetch sales ranks via Catalog Items API
//   7. Upsert all active listings into the listings table
//   8. Mark any existing DB listings NOT in the report as inactive
//
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

async function spApiPost(path: string, body: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${SP_API_BASE}${path}`;
  console.log("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseBody = await res.text();
  if (!res.ok) return { error: true, status: res.status, message: responseBody };
  try { return JSON.parse(responseBody); } catch { return { raw: responseBody }; }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- TSV Parser ----

interface TsvListing {
  sku: string;
  asin: string;
  title: string;
  price: number;
  status: string;
}

function parseTsv(tsv: string): TsvListing[] {
  const lines = tsv.split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase().replace(/[- ]/g, "_"));

  // Find column indices — Amazon report columns vary, handle common names
  const skuIdx = headers.findIndex((h) => h === "seller_sku" || h === "sku");
  const asinIdx = headers.findIndex((h) => h === "asin1" || h === "asin");
  const titleIdx = headers.findIndex((h) => h === "item_name" || h === "title" || h === "product_name");
  const priceIdx = headers.findIndex((h) => h === "price" || h === "your_price" || h === "current_price");
  const statusIdx = headers.findIndex((h) => h === "status" || h === "listing_status" || h === "item_status");

  if (skuIdx === -1) {
    console.warn("TSV headers:", headers.join(", "));
    throw new Error("Could not find SKU column in report TSV. Headers: " + headers.slice(0, 10).join(", "));
  }

  const results: TsvListing[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split("\t");
    const sku = (cols[skuIdx] || "").trim();
    if (!sku) continue;

    results.push({
      sku,
      asin: asinIdx >= 0 ? (cols[asinIdx] || "").trim() : "",
      title: titleIdx >= 0 ? (cols[titleIdx] || "").trim() : "",
      price: priceIdx >= 0 ? parseFloat(cols[priceIdx] || "0") || 0 : 0,
      status: statusIdx >= 0 ? (cols[statusIdx] || "Active").trim() : "Active",
    });
  }

  return results;
}

// ---- Main sync logic ----

interface SyncedListing {
  asin: string;
  sku: string;
  title: string;
  current_price: number;
  sales_rank: number | null;
}

async function runSync(jobId: string) {
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
    // ==========================================
    // Step 1: Request the GET_MERCHANT_LISTINGS_ALL_DATA report
    // ==========================================
    await appendLog("Step 1: Requesting GET_MERCHANT_LISTINGS_ALL_DATA report...");

    const createReportRes = await spApiPost("/reports/2021-06-30/reports", {
      reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
      marketplaceIds: [marketplaceId],
    }) as Record<string, unknown>;

    if (createReportRes.error) {
      throw new Error("Failed to create report: " + JSON.stringify(createReportRes));
    }

    const reportId = createReportRes.reportId as string;
    if (!reportId) {
      throw new Error("No reportId returned: " + JSON.stringify(createReportRes));
    }

    await appendLog("Report requested: " + reportId);

    // ==========================================
    // Step 2: Poll until report is DONE
    // ==========================================
    await appendLog("Step 2: Waiting for report to complete...");

    let reportDocId: string | null = null;
    let pollCount = 0;
    const MAX_POLLS = 120; // Up to 20 minutes (10s intervals)

    while (pollCount < MAX_POLLS) {
      await sleep(10_000); // Wait 10 seconds between polls
      pollCount++;

      const statusRes = await spApiGet(`/reports/2021-06-30/reports/${reportId}`) as Record<string, unknown>;

      if (statusRes.error) {
        await appendLog("  Poll error: " + JSON.stringify(statusRes).substring(0, 200));
        continue;
      }

      const processingStatus = statusRes.processingStatus as string;
      await appendLog("  Poll " + pollCount + ": status=" + processingStatus);

      if (processingStatus === "DONE") {
        reportDocId = statusRes.reportDocumentId as string;
        break;
      } else if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
        throw new Error("Report failed with status: " + processingStatus);
      }
      // IN_QUEUE or IN_PROGRESS — keep polling
    }

    if (!reportDocId) {
      throw new Error("Report did not complete after " + MAX_POLLS + " polls");
    }

    await appendLog("Report complete. Document ID: " + reportDocId);

    // ==========================================
    // Step 3: Download the report document
    // ==========================================
    await appendLog("Step 3: Downloading report document...");

    const docRes = await spApiGet(`/reports/2021-06-30/documents/${reportDocId}`) as Record<string, unknown>;

    if (docRes.error) {
      throw new Error("Failed to get report document: " + JSON.stringify(docRes));
    }

    const downloadUrl = docRes.url as string;
    if (!downloadUrl) {
      throw new Error("No download URL in report document response");
    }

    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) {
      throw new Error("Failed to download report: " + downloadRes.status);
    }

    const tsvContent = await downloadRes.text();
    await appendLog("Report downloaded: " + tsvContent.length + " bytes");

    // ==========================================
    // Step 4: Parse TSV and filter to DVDBOX/WIIBOX
    // ==========================================
    await appendLog("Step 4: Parsing report and filtering to DVDBOX/WIIBOX...");

    const allListings = parseTsv(tsvContent);
    await appendLog("Total listings in report: " + allListings.length);

    const filteredListings = allListings.filter((l) => SKU_FILTER.test(l.sku));
    await appendLog("DVDBOX/WIIBOX listings: " + filteredListings.length);

    await updateStatus({ total_raw: allListings.length });

    if (filteredListings.length === 0) {
      await appendLog("No DVDBOX/WIIBOX listings found in report.");
      await updateStatus({
        status: "complete",
        completed_at: new Date().toISOString(),
        listings_synced: 0,
        prices_fetched: 0,
        ranks_fetched: 0,
      });
      return;
    }

    // Build results array from parsed TSV
    const results: SyncedListing[] = filteredListings.map((l) => ({
      asin: l.asin,
      sku: l.sku,
      title: l.title,
      current_price: l.price,
      sales_rank: null,
    }));

    // ==========================================
    // Step 5: Batch-fetch live prices via Pricing API (20 SKUs per batch)
    // For listings where the report price might be stale
    // ==========================================
    await appendLog("Step 5: Fetching live prices...");
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
    // Step 6: Batch-fetch sales ranks via Catalog Items API (5 at a time)
    // ==========================================
    await appendLog("Step 6: Fetching sales ranks...");
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
    // Step 7: Upsert into Supabase
    // ==========================================
    await appendLog("Step 7: Upserting " + results.length + " listings...");
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

    // ==========================================
    // Step 8: Mark inactive listings not in the report
    // ==========================================
    await appendLog("Step 8: Marking inactive listings...");
    const activeSKUs = new Set(results.map((l) => l.sku));

    const { data: dbListings } = await sb
      .from("listings")
      .select("id, sku")
      .eq("status", "active")
      .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*");

    let deactivated = 0;
    if (dbListings) {
      for (const dbListing of dbListings) {
        if (!activeSKUs.has(dbListing.sku)) {
          await sb.from("listings").update({ status: "inactive" }).eq("id", dbListing.id);
          deactivated++;
        }
      }
    }

    if (deactivated > 0) {
      await appendLog("Deactivated " + deactivated + " listings no longer in Amazon report.");
    }

    await appendLog("Sync complete: " + synced + " listings upserted, " + pricesFetched + " prices, " + ranksFetched + " ranks, " + deactivated + " deactivated");
    await updateStatus({
      status: "complete",
      completed_at: new Date().toISOString(),
      listings_synced: synced,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Sync failed:", msg);
    await appendLog("ERROR: " + msg);
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

    if (!jobId) throw new Error("Missing jobId");

    const syncPromise = runSync(jobId);

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
