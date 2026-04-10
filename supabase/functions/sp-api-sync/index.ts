// Supabase Edge Function: sp-api-sync
// Two-phase listing sync using Amazon Reports API.
//
// Phase 1 (no report_id in sync_status): Request the report, save reportId, exit.
// Phase 2 (report_id exists): Poll report status. If DONE, download, parse, upsert.
//
// Designed to be called repeatedly (by pg_cron every minute, or manually).
// Each call does a small amount of work and exits within edge function limits.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
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
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
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
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
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
  salesRank?: number | null;
}

function parseTsv(tsv: string): TsvListing[] {
  const lines = tsv.split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase().replace(/[- ]/g, "_"));
  const skuIdx = headers.findIndex((h) => h === "seller_sku" || h === "sku");
  const asinIdx = headers.findIndex((h) => h === "asin1" || h === "asin");
  const titleIdx = headers.findIndex((h) => h === "item_name" || h === "title" || h === "product_name");
  const priceIdx = headers.findIndex((h) => h === "price" || h === "your_price" || h === "current_price");

  if (skuIdx === -1) {
    throw new Error("No SKU column found. Headers: " + headers.slice(0, 10).join(", "));
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
    });
  }
  return results;
}

// ---- Two-phase sync ----

async function runSync(jobId: string) {
  const sb = getSupabaseAdmin();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  let logBuffer = "";
  const appendLog = async (msg: string) => {
    console.log(msg);
    logBuffer += msg + "\n";
    await sb.from("sync_status").update({ log: logBuffer }).eq("id", jobId);
  };

  const updateStatus = async (fields: Record<string, unknown>) => {
    await sb.from("sync_status").update(fields).eq("id", jobId);
  };

  try {
    // Check current job state — do we already have a report_id?
    const { data: job } = await sb
      .from("sync_status")
      .select("*")
      .eq("id", jobId)
      .single();

    if (!job) throw new Error("Job not found: " + jobId);

    // Load existing log so we can append to it
    logBuffer = job.log || "";

    // The log field stores report_id as "REPORT_ID:xxx" on the first line
    const logLines = logBuffer.split("\n");
    const reportIdLine = logLines.find((l: string) => l.startsWith("REPORT_ID:"));
    const existingReportId = reportIdLine ? reportIdLine.replace("REPORT_ID:", "").trim() : null;

    if (!existingReportId) {
      // =====================
      // PHASE 1: Request report
      // =====================
      await appendLog("Phase 1: Requesting GET_MERCHANT_LISTINGS_ALL_DATA report...");

      const createRes = await spApiPost("/reports/2021-06-30/reports", {
        reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
        marketplaceIds: [marketplaceId],
      }) as Record<string, unknown>;

      if (createRes.error) {
        throw new Error("Failed to create report: " + JSON.stringify(createRes).substring(0, 300));
      }

      const reportId = createRes.reportId as string;
      if (!reportId) throw new Error("No reportId in response");

      // Store reportId in the log so Phase 2 can find it
      logBuffer = "REPORT_ID:" + reportId + "\n";
      await sb.from("sync_status").update({ log: logBuffer }).eq("id", jobId);
      await appendLog("Report requested: " + reportId + " — waiting for Amazon to generate...");

      return { phase: 1, reportId, message: "Report requested. Call again to check status." };
    }

    // =====================
    // PHASE 2: Check report, download if ready, parse, upsert
    // =====================
    await appendLog("Phase 2: Checking report " + existingReportId + "...");

    const statusRes = await spApiGet(`/reports/2021-06-30/reports/${existingReportId}`) as Record<string, unknown>;

    if (statusRes.error) {
      throw new Error("Report status check failed: " + JSON.stringify(statusRes).substring(0, 300));
    }

    const processingStatus = statusRes.processingStatus as string;
    await appendLog("Report status: " + processingStatus);

    if (processingStatus === "IN_QUEUE" || processingStatus === "IN_PROGRESS") {
      return { phase: 2, status: processingStatus, message: "Report still processing. Call again." };
    }

    if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
      throw new Error("Report failed: " + processingStatus);
    }

    if (processingStatus !== "DONE") {
      return { phase: 2, status: processingStatus, message: "Unexpected status. Call again." };
    }

    // Report is DONE — download it
    const reportDocId = statusRes.reportDocumentId as string;
    if (!reportDocId) throw new Error("No reportDocumentId");

    await appendLog("Report DONE. Downloading document: " + reportDocId);

    const docRes = await spApiGet(`/reports/2021-06-30/documents/${reportDocId}`) as Record<string, unknown>;
    if (docRes.error) throw new Error("Doc fetch failed: " + JSON.stringify(docRes).substring(0, 300));

    const downloadUrl = docRes.url as string;
    if (!downloadUrl) throw new Error("No download URL");

    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error("Download failed: " + dlRes.status);

    const tsvContent = await dlRes.text();
    await appendLog("Downloaded: " + tsvContent.length + " bytes");

    // Parse and filter
    const allListings = parseTsv(tsvContent);
    const filtered = allListings.filter((l) => SKU_FILTER.test(l.sku));
    await appendLog("Total in report: " + allListings.length + " | DVDBOX/WIIBOX: " + filtered.length);
    await updateStatus({ total_raw: allListings.length });

    if (filtered.length === 0) {
      await updateStatus({ status: "complete", completed_at: new Date().toISOString(), listings_synced: 0 });
      return { phase: 2, status: "complete", listings: 0 };
    }

    // Fetch live prices (batches of 20)
    await appendLog("Fetching live prices...");
    let pricesFetched = 0;
    const PRICE_BATCH = 20;

    for (let i = 0; i < filtered.length; i += PRICE_BATCH) {
      const batch = filtered.slice(i, i + PRICE_BATCH);
      const skuParam = batch.map((s) => encodeURIComponent(s.sku)).join("&Skus=");

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
              if (lp) { const amt = parseFloat(lp.Amount as string || "0"); if (amt > 0) livePrice = amt; }
            }
            if (livePrice === null) {
              const rp = offers[0].RegularPrice as Record<string, unknown> | undefined;
              if (rp) { const amt = parseFloat(rp.Amount as string || "0"); if (amt > 0) livePrice = amt; }
            }

            // Sales rank comes back in the same response under Product.SalesRankings.
            // First entry is usually the main product category rank (e.g.
            // "dvd_display_on_website") which is what we want for the UI.
            let salesRank: number | null = null;
            const salesRankings = product.SalesRankings as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(salesRankings) && salesRankings.length > 0) {
              const first = salesRankings[0];
              const rankVal = first?.Rank;
              if (rankVal != null) {
                const parsed = parseInt(String(rankVal), 10);
                if (!isNaN(parsed) && parsed > 0) salesRank = parsed;
              }
            }

            const listing = filtered.find((l) => l.sku === sku);
            if (listing) {
              if (livePrice !== null) { listing.price = livePrice; pricesFetched++; }
              if (salesRank !== null) listing.salesRank = salesRank;
            }
          }
        }
      } catch (err) {
        console.warn("Pricing batch failed:", err);
      }

      await updateStatus({ prices_fetched: pricesFetched });
      if (i + PRICE_BATCH < filtered.length) await sleep(200);
    }

    await appendLog("Prices fetched: " + pricesFetched);

    // Upsert into listings table
    await appendLog("Upserting " + filtered.length + " listings...");
    let synced = 0;
    const UPSERT_BATCH = 50;

    for (let i = 0; i < filtered.length; i += UPSERT_BATCH) {
      const batch = filtered.slice(i, i + UPSERT_BATCH);
      const rows = batch.map((l) => {
        const row: Record<string, unknown> = {
          asin: l.asin,
          sku: l.sku,
          title: l.title,
          status: "active",
        };
        if (l.price > 0) row.current_price = l.price;
        if (l.salesRank != null) row.sales_rank = l.salesRank;
        // Set sensible min/max for WIIBOX listings based on current price
        const isWiibox = /wiibox/i.test(l.sku);
        if (isWiibox && l.price > 0) {
          row.min_price = Math.max(parseFloat((l.price - 7).toFixed(2)), 8.50);
          row.max_price = parseFloat((l.price + 12).toFixed(2));
        }
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

    // Mark listings not in report as inactive
    const activeSKUs = new Set(filtered.map((l) => l.sku));
    const { data: dbListings } = await sb
      .from("listings")
      .select("id, sku")
      .eq("status", "active")
      .or("sku.ilike.*dvdbox*,sku.ilike.*wiibox*")
      .range(0, 4999);

    let deactivated = 0;
    if (dbListings) {
      for (const dl of dbListings) {
        if (!activeSKUs.has(dl.sku)) {
          await sb.from("listings").update({ status: "inactive" }).eq("id", dl.id);
          deactivated++;
        }
      }
    }

    await appendLog("Sync complete: " + synced + " upserted, " + pricesFetched + " prices, " + deactivated + " deactivated");
    await updateStatus({
      status: "complete",
      completed_at: new Date().toISOString(),
      listings_synced: synced,
    });

    return { phase: 2, status: "complete", listings_synced: synced, prices_fetched: pricesFetched };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Sync failed:", msg);
    await appendLog("ERROR: " + msg);
    await updateStatus({ status: "failed", completed_at: new Date().toISOString(), error_message: msg });
    return { error: msg };
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

    const result = await runSync(jobId);

    return new Response(JSON.stringify(result), {
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
