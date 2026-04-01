// Supabase Edge Function: sp-api-sync
// Long-running background sync job that pulls all DVDBOX/WIIBOX listings
// from Amazon via Reports API, fetches live prices via Pricing API,
// fetches sales ranks via Catalog Items API, and upserts into Supabase.
//
// Called by the sp-api function's "startSync" action.
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

async function spApiPost(path: string, data: unknown): Promise<unknown> {
  const token = await getAccessToken();
  const url = `${SP_API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const body = await res.text();
  if (!res.ok) return { error: true, status: res.status, message: body };
  try { return JSON.parse(body); } catch { return { raw: body }; }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseTsv(tsv: string): Record<string, string>[] {
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cols[j] || "").trim();
    }
    rows.push(row);
  }
  return rows;
}

// ---- Main sync logic ----

async function runSync(jobId: string) {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  const appendLog = async (msg: string) => {
    console.log(msg);
    // Append to log field
    await sb.rpc("sync_append_log", { job_id: jobId, msg: msg + "\n" }).catch(() => {
      // Fallback: direct update if RPC doesn't exist
    });
  };

  const updateStatus = async (fields: Record<string, unknown>) => {
    await sb.from("sync_status").update(fields).eq("id", jobId);
  };

  try {
    await appendLog("Starting sync for seller " + CONFIRMED_SELLER_ID);

    // Step 1: Create report
    await appendLog("Step 1: Creating GET_MERCHANT_LISTINGS_ALL_DATA report...");
    const createRes = await spApiPost("/reports/2021-06-30/reports", {
      reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
      marketplaceIds: [marketplaceId],
    }) as Record<string, unknown>;

    if (createRes.error) {
      await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "Report creation failed: " + JSON.stringify(createRes) });
      return;
    }

    const reportId = createRes.reportId as string;
    if (!reportId) {
      await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "No reportId returned" });
      return;
    }
    await appendLog("Report created: " + reportId);

    // Step 2: Poll until done (max ~3 minutes)
    await appendLog("Step 2: Polling for report completion...");
    let reportDocId: string | null = null;
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const status = await spApiGet(`/reports/2021-06-30/reports/${reportId}`) as Record<string, unknown>;
      const ps = status.processingStatus as string;
      if (i % 5 === 0) await appendLog("  Poll " + (i + 1) + ": " + ps);
      if (ps === "DONE") {
        reportDocId = status.reportDocumentId as string;
        break;
      }
      if (ps === "CANCELLED" || ps === "FATAL") {
        await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "Report " + ps });
        return;
      }
    }

    if (!reportDocId) {
      await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "Report timed out after 3 minutes" });
      return;
    }
    await appendLog("Report ready: " + reportDocId);

    // Step 3: Download report
    await appendLog("Step 3: Downloading report...");
    const docInfo = await spApiGet(`/reports/2021-06-30/documents/${reportDocId}`) as Record<string, unknown>;
    if (docInfo.error) {
      await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "Doc fetch failed: " + JSON.stringify(docInfo) });
      return;
    }

    const downloadUrl = docInfo.url as string;
    if (!downloadUrl) {
      await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: "No download URL" });
      return;
    }

    const dlRes = await fetch(downloadUrl);
    const tsvText = await dlRes.text();
    const rows = parseTsv(tsvText);
    await updateStatus({ total_raw: rows.length });
    await appendLog("Report parsed: " + rows.length + " total rows");

    // Step 4: Filter to DVDBOX/WIIBOX active listings
    const filtered = rows
      .filter((r) => (r["status"] || r["Status"] || "") === "Active")
      .filter((r) => {
        const sku = r["seller-sku"] || r["Seller SKU"] || r["sku"] || "";
        return SKU_FILTER.test(sku);
      });

    await appendLog("Active DVDBOX/WIIBOX: " + filtered.length + " listings");

    const listings = filtered.map((r) => ({
      asin: r["asin1"] || r["ASIN1"] || r["asin"] || "",
      sku: r["seller-sku"] || r["Seller SKU"] || r["sku"] || "",
      title: r["item-name"] || r["Title"] || r["item-description"] || "",
      report_price: parseFloat(r["price"] || r["Price"] || "0"),
      current_price: parseFloat(r["price"] || r["Price"] || "0"),
      quantity: parseInt(r["quantity"] || r["Quantity"] || "0"),
      sales_rank: null as number | null,
    }));

    // Step 5: Fetch live prices via Pricing API (20 SKUs per batch)
    await appendLog("Step 5: Fetching live prices...");
    const skus = listings.map((l) => l.sku).filter(Boolean);
    const livePriceMap: Record<string, number> = {};
    const PRICE_BATCH = 20;

    for (let i = 0; i < skus.length; i += PRICE_BATCH) {
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

            // Try BuyingPrice.ListingPrice.Amount first, then RegularPrice.Amount
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

            if (livePrice !== null) livePriceMap[sku] = livePrice;
          }
        }
      } catch (err) {
        console.warn("Pricing batch failed:", err);
      }

      if (i + PRICE_BATCH < skus.length) await sleep(500);
    }

    await appendLog("Live prices fetched: " + Object.keys(livePriceMap).length + " / " + skus.length);
    await updateStatus({ prices_fetched: Object.keys(livePriceMap).length });

    // Override report prices with live prices
    for (const listing of listings) {
      if (listing.sku && livePriceMap[listing.sku] !== undefined) {
        listing.current_price = livePriceMap[listing.sku];
      }
    }

    // Step 6: Fetch sales ranks (5 at a time)
    await appendLog("Step 6: Fetching sales ranks...");
    const asins = [...new Set(listings.map((l) => l.asin).filter(Boolean))];
    const salesRankMap: Record<string, number> = {};
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
                if (typeof rank === "number") salesRankMap[asin] = rank;
              }
            }
          }
        } catch (err) {
          console.warn("Rank fetch failed for", asin, err);
        }
      });
      await Promise.all(promises);
      if (i + RANK_BATCH < asins.length) await sleep(500);
    }

    await appendLog("Sales ranks fetched: " + Object.keys(salesRankMap).length + " / " + asins.length);
    await updateStatus({ ranks_fetched: Object.keys(salesRankMap).length });

    // Merge ranks
    for (const listing of listings) {
      if (listing.asin && salesRankMap[listing.asin] !== undefined) {
        listing.sales_rank = salesRankMap[listing.asin];
      }
    }

    // Step 7: Upsert into Supabase listings table
    await appendLog("Step 7: Upserting " + listings.length + " listings into database...");
    let synced = 0;

    // Batch upsert 50 at a time
    const UPSERT_BATCH = 50;
    for (let i = 0; i < listings.length; i += UPSERT_BATCH) {
      const batch = listings.slice(i, i + UPSERT_BATCH);
      const rows = batch.map((l) => ({
        asin: l.asin,
        sku: l.sku,
        title: l.title,
        current_price: l.current_price,
        sales_rank: l.sales_rank,
        status: "active",
      }));

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

    await appendLog("Sync complete: " + synced + " listings upserted");
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

    // Run sync in the background — respond immediately
    // Use EdgeRuntime.waitUntil if available, otherwise just fire and forget
    const syncPromise = runSync(jobId);

    // Deno edge functions: we need to await or the function exits
    // But we already responded. Use a pattern that keeps the function alive.
    // Actually in Supabase edge functions, we must await — the function stays
    // alive until the response is sent AND all promises resolve.
    // So we run sync and respond after it completes... but that defeats the purpose.
    //
    // Better approach: respond immediately and keep the function alive with waitUntil.
    // Supabase Edge Functions support this via EdgeRuntime.waitUntil()

    // deno-lint-ignore no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime && typeof runtime.waitUntil === "function") {
      runtime.waitUntil(syncPromise);
      return new Response(JSON.stringify({ ok: true, jobId }), {
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      });
    }

    // Fallback: just run sync (will be long but won't timeout if Supabase allows it)
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
