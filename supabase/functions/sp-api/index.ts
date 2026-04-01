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

// ---- Action Handlers ----

async function handleFetchListings(): Promise<unknown> {
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";

  // Step 1: Request a GET_MERCHANT_LISTINGS_ALL_DATA report
  const createRes = await spApiRequest("/reports/2021-06-30/reports", "POST", {
    reportType: "GET_MERCHANT_LISTINGS_ALL_DATA",
    marketplaceIds: [marketplaceId],
  }) as Record<string, unknown>;

  if (createRes.error) return createRes;
  const reportId = createRes.reportId as string;
  if (!reportId) return { error: true, message: "No reportId returned", data: createRes };

  // Step 2: Poll until report is done (max ~60s)
  let reportDocId: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const status = await spApiRequest(`/reports/2021-06-30/reports/${reportId}`) as Record<string, unknown>;
    if (status.processingStatus === "DONE") {
      reportDocId = status.reportDocumentId as string;
      break;
    }
    if (status.processingStatus === "CANCELLED" || status.processingStatus === "FATAL") {
      return { error: true, message: `Report ${status.processingStatus}`, data: status };
    }
  }

  if (!reportDocId) {
    return { error: true, message: "Report timed out after 60s" };
  }

  // Step 3: Get the report document URL
  const docInfo = await spApiRequest(`/reports/2021-06-30/documents/${reportDocId}`) as Record<string, unknown>;
  if (docInfo.error) return docInfo;

  const downloadUrl = docInfo.url as string;
  if (!downloadUrl) return { error: true, message: "No download URL in report document", data: docInfo };

  // Step 4: Download and parse the TSV report
  const dlRes = await fetch(downloadUrl);
  const tsvText = await dlRes.text();
  const rows = parseTsv(tsvText);

  const skuFilter = /dvdbox|wiibox/i;

  // Normalize to our listing format — only DVDBOX and WIIBOX SKUs
  const listings = rows
    .filter((r) => r["status"] === "Active" || r["Status"] === "Active")
    .filter((r) => {
      const sku = r["seller-sku"] || r["Seller SKU"] || r["sku"] || "";
      return skuFilter.test(sku);
    })
    .map((r) => ({
      asin: r["asin1"] || r["ASIN1"] || r["asin"] || "",
      sku: r["seller-sku"] || r["Seller SKU"] || r["sku"] || "",
      title: r["item-name"] || r["Title"] || r["item-description"] || "",
      current_price: parseFloat(r["price"] || r["Price"] || "0"),
      quantity: parseInt(r["quantity"] || r["Quantity"] || "0"),
      status: "active",
    }));

  return { listings, totalRaw: rows.length };
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

async function handleUpdatePrice(sku: string, price: number): Promise<unknown> {
  const sellerId = Deno.env.get("SP_API_SELLER_ID") || "";
  const marketplaceId = Deno.env.get("SP_API_MARKETPLACE_ID") || "ATVPDKIKX0DER";
  const encodedSku = encodeURIComponent(sku);
  const priceStr = price.toFixed(2);

  // Listings Items API 2021-08-01 — PATCH to update price
  const body = {
    productType: "HOME_VIDEO",
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

  const result = await spApiRequest(
    `/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&issueLocale=en_US`,
    "PATCH",
    body
  );
  return result;
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

      default:
        throw new Error(`Unknown action: ${action}. Valid: fetchListings, getCompetitivePrice, getCompetitivePriceBatch, updatePrice, getSalesRank, getSalesRankBatch`);
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
