/**
 * Amazon SP-API Connection Layer
 *
 * This file isolates all Amazon SP-API calls. Currently returns mock data.
 * When SP-API credentials are available, replace the mock implementations
 * with real API calls. No other files need to change.
 *
 * To connect the real API:
 * 1. Install the Amazon SP-API SDK
 * 2. Add credentials to .env (AMAZON_SP_API_CLIENT_ID, etc.)
 * 3. Replace each function below with the real SP-API call
 */

// ---- Configuration (replace with real credentials later) ----
const config = {
  clientId: '',
  clientSecret: '',
  refreshToken: '',
  marketplaceId: 'ATVPDKIKX0DER', // US marketplace
};

// ---- Mock Data ----
const MOCK_LISTINGS = [
  { asin: 'B00005JNOG', sku: 'DVD-001', title: 'The Shawshank Redemption (1994)', current_price: 12.99, min_price: 8.50, max_price: 24.99, cost_basis: 3.50, sales_rank: 45000, date_listed: '2026-02-15', last_sold: '2026-03-20T14:30:00Z', last_repriced: null, status: 'active' },
  { asin: 'B00003CXCT', sku: 'DVD-002', title: 'The Godfather (1972)', current_price: 24.99, min_price: 8.50, max_price: 24.99, cost_basis: 4.00, sales_rank: 32000, date_listed: '2026-03-31', last_sold: null, last_repriced: null, status: 'active' },
  { asin: 'B00005JMF8', sku: 'DVD-003', title: 'Pulp Fiction (1994)', current_price: 8.50, min_price: 8.50, max_price: 24.99, cost_basis: 2.75, sales_rank: 78000, date_listed: '2026-01-10', last_sold: '2026-02-05T09:15:00Z', last_repriced: '2026-03-01T12:00:00Z', status: 'active' },
  { asin: 'B000P0J0AQ', sku: 'DVD-004', title: 'The Dark Knight (2008)', current_price: 15.49, min_price: 8.50, max_price: 24.99, cost_basis: 5.00, sales_rank: 120000, date_listed: '2026-03-01', last_sold: null, last_repriced: null, status: 'active' },
  { asin: 'B001AQO3QA', sku: 'DVD-005', title: 'Forrest Gump (1994)', current_price: 10.99, min_price: 8.50, max_price: 24.99, cost_basis: 3.00, sales_rank: 650000, date_listed: '2026-02-01', last_sold: null, last_repriced: '2026-03-15T08:00:00Z', status: 'active' },
  { asin: 'B00AEFYIKQ', sku: 'DVD-006', title: 'Inception (2010)', current_price: 18.75, min_price: 8.50, max_price: 24.99, cost_basis: 4.50, sales_rank: 95000, date_listed: '2026-03-10', last_sold: '2026-03-25T16:45:00Z', last_repriced: null, status: 'active' },
  { asin: 'B003EYIZ1G', sku: 'DVD-007', title: 'The Matrix (1999)', current_price: 9.25, min_price: 8.50, max_price: 24.99, cost_basis: 8.00, sales_rank: 210000, date_listed: '2026-01-20', last_sold: '2026-02-28T11:00:00Z', last_repriced: '2026-03-10T10:30:00Z', status: 'active' },
  { asin: 'B00G4RKQ0M', sku: 'DVD-008', title: 'Interstellar (2014)', current_price: 22.00, min_price: 8.50, max_price: 24.99, cost_basis: 6.00, sales_rank: 55000, date_listed: '2026-03-20', last_sold: null, last_repriced: null, status: 'active' },
  { asin: 'B005LAIINI', sku: 'DVD-009', title: 'Goodfellas (1990)', current_price: 14.00, min_price: 8.50, max_price: 24.99, cost_basis: 3.25, sales_rank: 180000, date_listed: '2026-02-10', last_sold: null, last_repriced: null, status: 'active' },
  { asin: 'B00K19SD8Q', sku: 'DVD-010', title: 'Guardians of the Galaxy (2014)', current_price: 11.50, min_price: 8.50, max_price: 24.99, cost_basis: 4.25, sales_rank: 88000, date_listed: '2026-03-05', last_sold: '2026-03-28T13:20:00Z', last_repriced: '2026-03-25T09:00:00Z', status: 'active' },
];

// ---- API Functions ----

/**
 * Fetch all active listings from Amazon
 * Replace with: SP-API Reports API or Catalog Items API
 */
export async function fetchListings() {
  return JSON.parse(JSON.stringify(MOCK_LISTINGS));
}

/**
 * Fetch current competitive pricing for an ASIN
 * Replace with: SP-API Product Pricing API - getCompetitivePricing
 */
export async function getCompetitivePrice(asin) {
  const listing = MOCK_LISTINGS.find(l => l.asin === asin);
  return {
    asin,
    lowestPrice: listing ? listing.current_price * 0.95 : null,
    buyBoxPrice: listing ? listing.current_price : null,
  };
}

/**
 * Update the price of a listing on Amazon
 * Replace with: SP-API Feeds API - POST_PRODUCT_PRICING_DATA
 */
export async function updatePrice(sku, newPrice) {
  console.log(`[MOCK] Would update SKU ${sku} to $${newPrice.toFixed(2)} on Amazon`);
  return { success: true, sku, newPrice };
}

/**
 * Fetch sales rank for an ASIN
 * Replace with: SP-API Catalog Items API
 */
export async function getSalesRank(asin) {
  const listing = MOCK_LISTINGS.find(l => l.asin === asin);
  return listing ? listing.sales_rank : null;
}
