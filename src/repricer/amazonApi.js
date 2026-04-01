/**
 * Amazon SP-API Connection Layer
 *
 * All calls go through the Supabase Edge Function "sp-api" which holds
 * the credentials server-side. No Amazon secrets in frontend code.
 *
 * The edge function handles: LWA token exchange, SP-API requests,
 * and returns the results.
 *
 * To set up:
 * 1. Deploy: supabase functions deploy sp-api
 * 2. Set secrets: supabase secrets set SP_API_CLIENT_ID=... SP_API_CLIENT_SECRET=... SP_API_REFRESH_TOKEN=... SP_API_MARKETPLACE_ID=... SP_API_SELLER_ID=...
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

async function callSpApi(action, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sp-api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ action, ...params }),
  });

  const data = await res.json();
  if (data.error && typeof data.error === 'string') {
    throw new Error(data.error);
  }
  return data;
}

/**
 * Fetch all active listings from Amazon via Listings Items API
 */
export async function fetchListings() {
  return await callSpApi('fetchListings');
}

/**
 * Get competitive (Buy Box) pricing for a single ASIN
 */
export async function getCompetitivePrice(asin) {
  return await callSpApi('getCompetitivePrice', { asin });
}

/**
 * Get competitive pricing for multiple ASINs (up to 20)
 */
export async function getCompetitivePriceBatch(asins) {
  return await callSpApi('getCompetitivePriceBatch', { asins });
}

/**
 * Update the price of a listing on Amazon via Listings Items API
 */
export async function updatePrice(sku, price) {
  return await callSpApi('updatePrice', { sku, price });
}

/**
 * Get sales rank for a single ASIN via Catalog Items API
 */
export async function getSalesRank(asin) {
  return await callSpApi('getSalesRank', { asin });
}

/**
 * Get sales rank for multiple ASINs
 */
export async function getSalesRankBatch(asins) {
  return await callSpApi('getSalesRankBatch', { asins });
}
