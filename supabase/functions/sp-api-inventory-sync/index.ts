// Supabase Edge Function: sp-api-inventory-sync
// Pulls FBA inventory summaries from Amazon SP-API and writes fulfillable /
// inbound quantities + is_sellable into the listings table.
//
// Paginates via nextToken until exhausted. Invoked manually — no pg_cron.
//
// Deploy: supabase functions deploy sp-api-inventory-sync

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const MARKETPLACE_ID = "ATVPDKIKX0DER";
const UPSERT_BATCH = 50;

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

async function spApiGet(
  path: string,
): Promise<Record<string, unknown> & { __status?: number; __retryAfter?: number | null }> {
  const token = await getAccessToken();
  const url = `${SP_API_BASE}${path}`;
  console.log("GET", url);
  const res = await fetch(url, {
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error("SP-API error", res.status, body);
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : null;
    return {
      error: true,
      status: res.status,
      message: body,
      __status: res.status,
      __retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    };
  }
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPageWithRetry(
  path: string,
  page: number,
): Promise<Record<string, unknown>> {
  const MAX_RETRIES = 5;
  let attempt = 0;
  let backoffSec = 2;
  while (true) {
    const res = await spApiGet(path);
    if (!res.error) return res;

    if (res.__status !== 429) {
      throw new Error(
        "FBA inventory fetch failed (page " + page + "): " +
          JSON.stringify(res.message ?? res).slice(0, 300),
      );
    }

    if (attempt >= MAX_RETRIES) {
      throw new Error(
        "FBA inventory fetch 429 exhausted retries (page " + page + ", " +
          MAX_RETRIES + " attempts)",
      );
    }

    const waitSec = res.__retryAfter && res.__retryAfter > 0
      ? res.__retryAfter
      : backoffSec;
    attempt++;
    console.log(
      `429 on page ${page}, retry attempt ${attempt}/${MAX_RETRIES}, waiting ${waitSec}s`,
    );
    await sleep(waitSec * 1000);
    if (!res.__retryAfter) backoffSec *= 2;
  }
}

function toInt(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

interface InventoryRow {
  sku: string;
  fulfillable_quantity: number;
  inbound_working_quantity: number;
  inbound_shipped_quantity: number;
  inbound_receiving_quantity: number;
  is_sellable: boolean;
  inventory_updated_at: string;
}

async function runInventorySync() {
  const started = Date.now();
  const sb = getSupabaseAdmin();

  // Load existing listing SKUs so we can count unmatched (FBA SKUs not in listings).
  const existingSkus = new Set<string>();
  {
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await sb
        .from("listings")
        .select("sku")
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error("Failed to load listings: " + error.message);
      if (!data || data.length === 0) break;
      for (const r of data) existingSkus.add(r.sku as string);
      if (data.length < pageSize) break;
      offset += pageSize;
    }
  }
  console.log("Loaded existing SKUs:", existingSkus.size);

  let totalFetched = 0;
  let totalUnmatchedSkus = 0;
  let totalMatched = 0;
  let totalUpserted = 0;
  const nowIso = new Date().toISOString();

  const basePath =
    `/fba/inventory/v1/summaries?granularityType=Marketplace` +
    `&granularityId=${MARKETPLACE_ID}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&details=true`;

  let nextToken: string | null = null;
  let page = 0;
  do {
    page++;
    if (nextToken) {
      await sleep(600);
    }
    const path = nextToken
      ? `${basePath}&nextToken=${encodeURIComponent(nextToken)}`
      : basePath;

    const res = await fetchPageWithRetry(path, page);

    const payload = res.payload as Record<string, unknown> | undefined;
    const summaries =
      (payload?.inventorySummaries as Array<Record<string, unknown>> | undefined) ?? [];
    const pagination = res.pagination as Record<string, unknown> | undefined;
    nextToken = (pagination?.nextToken as string | undefined) ?? null;

    console.log(`Page ${page}: ${summaries.length} summaries, nextToken=${nextToken ? "yes" : "no"}`);

    const pageRows: InventoryRow[] = [];
    for (const s of summaries) {
      totalFetched++;
      const sku = (s.sellerSku as string | undefined)?.trim();
      if (!sku) continue;

      const fulfillable = toInt(s.fulfillableQuantity);
      const idq = s.inventoryDetails as Record<string, unknown> | undefined;
      const working = toInt(s.inboundWorkingQuantity ?? idq?.inboundWorkingQuantity);
      const shipped = toInt(s.inboundShippedQuantity ?? idq?.inboundShippedQuantity);
      const receiving = toInt(s.inboundReceivingQuantity ?? idq?.inboundReceivingQuantity);

      if (!existingSkus.has(sku)) {
        totalUnmatchedSkus++;
        continue;
      }

      pageRows.push({
        sku,
        fulfillable_quantity: fulfillable,
        inbound_working_quantity: working,
        inbound_shipped_quantity: shipped,
        inbound_receiving_quantity: receiving,
        is_sellable: fulfillable > 0,
        inventory_updated_at: nowIso,
      });
    }
    totalMatched += pageRows.length;

    for (let i = 0; i < pageRows.length; i += UPSERT_BATCH) {
      const batch = pageRows.slice(i, i + UPSERT_BATCH);
      const { error } = await sb
        .from("listings")
        .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });
      if (error) {
        throw new Error(
          "Upsert failed (page " + page + ", offset " + i + "): " + error.message,
        );
      }
      totalUpserted += batch.length;
    }
    console.log(`Page ${page} upserted ${pageRows.length} rows (running total: ${totalUpserted})`);
  } while (nextToken);

  console.log(`Fetched ${totalFetched} summaries, ${totalMatched} matched, ${totalUnmatchedSkus} unmatched`);

  const durationMs = Date.now() - started;
  const summary = { totalFetched, totalUpserted, totalUnmatchedSkus, durationMs };
  console.log("Inventory sync complete:", JSON.stringify(summary));
  return summary;
}

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
    const result = await runInventorySync();
    return new Response(JSON.stringify(result), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Inventory sync failed:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  }
});
