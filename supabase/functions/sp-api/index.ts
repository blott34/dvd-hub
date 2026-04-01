// Supabase Edge Function: SP-API proxy
// Keeps Amazon credentials server-side. Frontend calls this function,
// which authenticates with Amazon and proxies the request.
//
// Deploy: supabase functions deploy sp-api
// Set secrets:
//   supabase secrets set SP_API_CLIENT_ID=amzn1.application-oa2-client.xxx
//   supabase secrets set SP_API_CLIENT_SECRET=amzn1.oa2-cs.v1.xxx
//   supabase secrets set SP_API_REFRESH_TOKEN=Atzr|xxx
//   supabase secrets set SP_API_MARKETPLACE_ID=ATVPDKIKX0DER
//   supabase secrets set SP_API_SELLER_ID=YOUR_SELLER_ID

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// Cache access token in memory (edge functions are short-lived, but avoids
// re-fetching within the same invocation for multi-action requests)
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  const clientId = Deno.env.get("SP_API_CLIENT_ID");
  const clientSecret = Deno.env.get("SP_API_CLIENT_SECRET");
  const refreshToken = Deno.env.get("SP_API_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("SP-API credentials not configured. Set secrets via: supabase secrets set");
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
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  const headers: Record<string, string> = {
    "x-amz-access-token": token,
    "Content-Type": "application/json",
  };

  const url = `${SP_API_BASE}${path}`;
  const opts: RequestInit = { method, headers };
  if (body && method !== "GET") {
    opts.body = JSON.stringify(body);
  }

  // Debug logging
  console.log("=== SP-API REQUEST ===");
  console.log("URL:", url);
  console.log("Method:", method);
  console.log("Headers:", JSON.stringify(headers, null, 2));
  if (opts.body) {
    console.log("Body:", opts.body);
  }

  const res = await fetch(url, opts);
  const responseBody = await res.text();

  console.log("=== SP-API RESPONSE ===");
  console.log("Status:", res.status);
  console.log("Response Headers:", JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
  console.log("Body:", responseBody);

  if (!res.ok) {
    return { error: true, status: res.status, message: responseBody };
  }

  try {
    return JSON.parse(responseBody);
  } catch {
    return { raw: responseBody };
  }
}

// Confirmed seller ID for the US marketplace (ATVPDKIKX0DER)
const CONFIRMED_SELLER_ID = "A1TXEW03NQ1VT4";

function getActiveSellerId(): string {
  const envSellerId = Deno.env.get("SP_API_SELLER_ID") || "";
  if (envSellerId && envSellerId !== CONFIRMED_SELLER_ID) {
    console.warn("WARNING: SP_API_SELLER_ID env var (" + envSellerId + ") differs from confirmed seller ID (" + CONFIRMED_SELLER_ID + "). Using confirmed ID.");
  }
  return CONFIRMED_SELLER_ID;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Action Handlers ----

async function handleFetchListings(): Promise<unknown> {
  // fetchListings is now a lightweight action that returns listings from Supabase DB.
  // Use startSync or importSkus to populate/refresh from Amazon.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  const { data: listings, error } = await sb
    .from("listings")
    .select("*")
    .eq("status", "active")
    .or("sku.ilike.%dvdbox%,sku.ilike.%wiibox%")
    .order("sku", { ascending: true });

  if (error) {
    return { error: true, message: error.message };
  }

  return { listings: listings || [], totalRaw: listings?.length || 0 };
}

async function handleGetCompetitivePrice(asin: string): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Product Pricing API v0 — getCompetitivePricing
  const result = await spApiRequest(
    `/products/pricing/v0/competitivePrice?MarketplaceId=${marketplaceId}&Asins=${asin}&ItemType=Asin`
  );
  return result;
}

async function handleGetCompetitivePriceBatch(asins: string[]): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Batch competitive pricing — up to 20 ASINs at a time
  const requests = asins.map((asin) => ({
    MarketplaceId: marketplaceId,
    Asin: asin,
    ItemType: "Asin",
  }));

  const result = await spApiRequest(
    "/batches/products/pricing/v0/competitivePrice",
    "POST",
    { requests }
  );
  return result;
}

async function handleGetListingInfo(sku: string): Promise<unknown> {
  const sellerId = getActiveSellerId();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";
  const encodedSku = encodeURIComponent(sku);

  const result = await spApiRequest(
    `/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes,offers,issues&issueLocale=en_US`
  );
  return { sellerId, marketplaceId, sku, ...result as Record<string, unknown> };
}

async function handleVerifySeller(): Promise<unknown> {
  const result = await spApiRequest("/sellers/v1/marketplaceParticipations");
  return result;
}

async function handleUpdatePrice(sku: string, price: number): Promise<unknown> {
  const sellerId = getActiveSellerId();
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";
  const encodedSku = encodeURIComponent(sku);
  const priceStr = price.toFixed(2);

  // Step 1: GET full listing info via the same handler used by getListingInfo action
  console.log("========================================");
  console.log("=== STEP 1: FETCH LISTING INFO ===");
  console.log("SKU:", sku);
  console.log("Seller ID:", sellerId);
  console.log("Marketplace:", marketplaceId);
  console.log("========================================");

  const listingInfo = await handleGetListingInfo(sku) as Record<string, unknown>;

  console.log("=== FULL LISTING INFO RESPONSE ===");
  console.log(JSON.stringify(listingInfo, null, 2));

  // Extract productType from summaries
  let productType: string | null = null;
  if (listingInfo && !listingInfo.error) {
    const summaries = listingInfo.summaries as Array<Record<string, unknown>> | undefined;
    if (summaries && summaries.length > 0 && summaries[0].productType) {
      productType = summaries[0].productType as string;
    }
  }

  console.log("========================================");
  console.log("=== EXTRACTED productType:", productType ?? "NOT FOUND");
  console.log("========================================");

  if (!productType) {
    return {
      method: "PATCH",
      error: true,
      message: "Could not determine productType from listing info. Cannot proceed with PATCH.",
      listingInfo,
      sellerId,
      sku,
    };
  }

  // Step 2: Build and send PATCH request
  const patchUrl = `${SP_API_BASE}/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&issueLocale=en_US`;
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
                  {
                    value_with_tax: priceStr,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  console.log("========================================");
  console.log("=== STEP 2: PATCH PRICE UPDATE ===");
  console.log("URL:", patchUrl);
  console.log("Method: PATCH");
  console.log("Seller ID:", sellerId);
  console.log("SKU:", sku, "→ encoded:", encodedSku);
  console.log("productType:", productType);
  console.log("Price:", priceStr);
  console.log("=== FULL PATCH BODY ===");
  console.log(JSON.stringify(patchBody, null, 2));
  console.log("========================================");

  const patchResult = await spApiRequest(
    `/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&issueLocale=en_US`,
    "PATCH",
    patchBody
  ) as Record<string, unknown>;

  console.log("=== PATCH RESPONSE ===");
  console.log(JSON.stringify(patchResult, null, 2));

  // If PATCH succeeded, return it
  if (!patchResult.error) {
    return { method: "PATCH", productType, sellerId, ...patchResult };
  }

  console.log("=== PATCH FAILED, TRYING FEEDS API FALLBACK ===");

  // Step 3: Feeds API fallback — POST_FLAT_FILE_PRICEANDQUANTITYONLY_UPDATE_DATA
  const feedContent = "sku\tprice\n" + sku + "\t" + priceStr + "\n";

  // Create feed document
  const docRes = await spApiRequest("/feeds/2021-06-30/documents", "POST", {
    contentType: "text/tab-separated-values; charset=UTF-8",
  }) as Record<string, unknown>;

  if (docRes.error) {
    return { method: "FEEDS_FALLBACK", patchError: patchResult, feedDocError: docRes };
  }

  const feedDocId = docRes.feedDocumentId as string;
  const uploadUrl = docRes.url as string;

  if (!uploadUrl) {
    return { method: "FEEDS_FALLBACK", patchError: patchResult, error: "No upload URL returned", docRes };
  }

  // Upload the TSV content to the presigned URL
  console.log("Uploading feed content to:", uploadUrl);
  console.log("Feed content:", feedContent);

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/tab-separated-values; charset=UTF-8" },
    body: feedContent,
  });

  if (!uploadRes.ok) {
    const uploadErr = await uploadRes.text();
    return { method: "FEEDS_FALLBACK", patchError: patchResult, uploadError: uploadErr };
  }

  // Create the feed
  const feedRes = await spApiRequest("/feeds/2021-06-30/feeds", "POST", {
    feedType: "POST_FLAT_FILE_PRICEANDQUANTITYONLY_UPDATE_DATA",
    marketplaceIds: [marketplaceId],
    inputFeedDocumentId: feedDocId,
  }) as Record<string, unknown>;

  if (feedRes.error) {
    return { method: "FEEDS_FALLBACK", patchError: patchResult, feedError: feedRes };
  }

  return {
    method: "FEEDS_FALLBACK",
    feedId: feedRes.feedId,
    status: "SUBMITTED",
    note: "Feed submitted. Price update will process in 5-15 minutes.",
    patchError: patchResult,
  };
}

async function handleGetSalesRank(asin: string): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Catalog Items API v2022-04-01 — includes salesRanks
  const result = await spApiRequest(
    `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=salesRanks,summaries`
  );
  return result;
}

async function handleGetSalesRankBatch(asins: string[]): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Catalog Items API search — batch lookup
  const results = [];
  for (const asin of asins) {
    const result = await spApiRequest(
      `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=salesRanks,summaries`
    );
    results.push({ asin, data: result });
  }
  return results;
}

async function handleTestCatalog(asin: string): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  console.log("========================================");
  console.log("=== TEST: Catalog Items API read ===");
  console.log("ASIN:", asin);
  console.log("Marketplace:", marketplaceId);
  console.log("========================================");

  // This is a simple GET — no seller ID needed — to verify the access token works
  const result = await spApiRequest(
    `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,salesRanks,attributes`
  );

  console.log("=== CATALOG RESPONSE ===");
  console.log(JSON.stringify(result, null, 2));

  return { action: "testCatalog", asin, result };
}

async function handleStartSync(skus?: string[]): Promise<unknown> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  // Create a sync job row
  const { data: job, error: insertErr } = await sb
    .from("sync_status")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (insertErr || !job) {
    return { error: true, message: "Failed to create sync job: " + (insertErr?.message || "unknown") };
  }

  const jobId = job.id;
  console.log("Created sync job:", jobId);

  // Fire off the sp-api-sync function asynchronously
  const syncFnUrl = `${supabaseUrl}/functions/v1/sp-api-sync`;
  const syncBody: Record<string, unknown> = { jobId };
  if (skus && skus.length > 0) {
    syncBody.skus = skus;
  }

  fetch(syncFnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(syncBody),
  }).catch((err) => {
    console.error("Failed to invoke sp-api-sync:", err);
  });

  return { ok: true, jobId, message: skus ? "Import started (" + skus.length + " SKUs)" : "Sync started" };
}

async function handleGetSyncStatus(jobId?: string): Promise<unknown> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  if (jobId) {
    const { data, error } = await sb
      .from("sync_status")
      .select("*")
      .eq("id", jobId)
      .single();
    if (error) return { error: true, message: error.message };
    return data;
  }

  // Return the most recent sync job
  const { data, error } = await sb
    .from("sync_status")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .single();
  if (error) return { error: true, message: error.message };
  return data;
}

// ---- Main Handler ----

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { action, ...params } = await req.json();

    let result: unknown;

    switch (action) {
      case "fetchListings":
        result = await handleFetchListings();
        break;

      case "getCompetitivePrice":
        if (!params.asin) throw new Error("Missing required param: asin");
        result = await handleGetCompetitivePrice(params.asin);
        break;

      case "getCompetitivePriceBatch":
        if (!params.asins?.length) throw new Error("Missing required param: asins[]");
        result = await handleGetCompetitivePriceBatch(params.asins);
        break;

      case "updatePrice":
        if (!params.sku || params.price == null) throw new Error("Missing required params: sku, price");
        result = await handleUpdatePrice(params.sku, params.price);
        break;

      case "getSalesRank":
        if (!params.asin) throw new Error("Missing required param: asin");
        result = await handleGetSalesRank(params.asin);
        break;

      case "getSalesRankBatch":
        if (!params.asins?.length) throw new Error("Missing required param: asins[]");
        result = await handleGetSalesRankBatch(params.asins);
        break;

      case "getListingInfo":
        if (!params.sku) throw new Error("Missing required param: sku");
        result = await handleGetListingInfo(params.sku);
        break;

      case "verifySeller":
        result = await handleVerifySeller();
        break;

      case "testCatalog":
        if (!params.asin) throw new Error("Missing required param: asin");
        result = await handleTestCatalog(params.asin);
        break;

      case "startSync":
        result = await handleStartSync(params.skus);
        break;

      case "importSkus":
        if (!params.skus?.length) throw new Error("Missing required param: skus[]");
        result = await handleStartSync(params.skus);
        break;

      case "getSyncStatus":
        result = await handleGetSyncStatus(params.jobId);
        break;

      default:
        throw new Error(`Unknown action: ${action}. Valid: fetchListings, getCompetitivePrice, getCompetitivePriceBatch, updatePrice, getSalesRank, getSalesRankBatch, getListingInfo, verifySeller, testCatalog, startSync, importSkus, getSyncStatus`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
