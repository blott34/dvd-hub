/**
 * Repricing Engine
 *
 * SKU-prefix-based rule sets:
 *
 * WIIBOX: Match Buy Box only, use listing's own min/max, hold on no BB.
 *         No stale inventory, no Max Hit Day 1, no default floors.
 *
 * DVDBOX: Match Buy Box with dynamic min/max from BB price each run.
 *         dynMin = max(8.50, BB - 3.00), dynMax = BB + 10.00, target = BB.
 *         Hard floor $8.50. Max Hit Day 1, Stale Inventory, hold on no BB.
 *
 * Shared: Never Below Cost, Sales Rank Guard.
 */

import { fetchListings, updatePrice } from './amazonApi.js';

function getSkuPrefix(sku) {
  const upper = sku.toUpperCase();
  if (upper.includes('DVDBOX')) return 'DVDBOX';
  if (upper.includes('WIIBOX')) return 'WIIBOX';
  return null;
}

/**
 * Run the repricing engine against all active listings.
 * @param {Array} listings - Array of listing objects
 * @param {Array} rules - Array of rule objects from repricing_rules table
 * @param {Object} buyBoxPrices - Map of ASIN -> { buyBox, lowest } prices
 * @returns {Array} Array of log entries for price changes made
 */
export function runRepricingEngine(listings, rules, buyBoxPrices = {}) {
  const log = [];
  const now = new Date();
  const skuFilter = /dvdbox|wiibox/i;

  const ruleMap = {};
  for (const r of rules) {
    ruleMap[r.rule_name] = r;
  }

  for (const listing of listings) {
    if (listing.status !== 'active') continue;
    if (!skuFilter.test(listing.sku)) continue;

    const prefix = getSkuPrefix(listing.sku);
    if (!prefix) continue;

    let newPrice = listing.current_price;
    let reason = null;

    // ---- DVDBOX: dynamic min/max computed from Buy Box in the Match Buy Box section below ----

    // ---- DVDBOX ONLY: Max Hit Day 1 ----
    if (prefix === 'DVDBOX') {
      const maxHitRule = ruleMap['Max Hit Day 1'];
      if (maxHitRule && maxHitRule.is_active) {
        const dateListed = new Date(listing.date_listed + 'T00:00:00');
        const daysSinceListed = Math.floor((now - dateListed) / 86400000);
        if (daysSinceListed === 0) {
          const bbData = buyBoxPrices[listing.asin];
          const bbPrice = bbData ? bbData.buyBox : null;
          if (bbPrice != null && bbPrice > listing.max_price) {
            listing.max_price = parseFloat(bbPrice.toFixed(2));
          }
        }
      }
    }

    // ---- DVDBOX ONLY: Stale Inventory ----
    if (prefix === 'DVDBOX') {
      const staleRule = ruleMap['Stale Inventory'];
      if (staleRule && staleRule.is_active) {
        const daysBefore = parseInt(staleRule.days_before_drop) || 30;
        const dropAmount = parseFloat(staleRule.drop_amount) || 0.50;
        const dateListed = new Date(listing.date_listed + 'T00:00:00');
        const daysActive = Math.floor((now - dateListed) / 86400000);
        const lastSold = listing.last_sold ? new Date(listing.last_sold) : null;
        const daysSinceSale = lastSold ? Math.floor((now - lastSold) / 86400000) : daysActive;
        if (daysSinceSale >= daysBefore) {
          listing.min_price = parseFloat((listing.min_price - dropAmount).toFixed(2));
        }
      }
    }

    // ---- Match Buy Box ----
    const bbData = buyBoxPrices[listing.asin];
    const bbPrice = bbData ? bbData.buyBox : null;

    if (prefix === 'DVDBOX') {
      // DVDBOX: dynamic min/max derived from Buy Box price each run
      const DVDBOX_HARD_FLOOR = 8.50;

      if (bbPrice != null) {
        const dynMin = parseFloat(Math.max(DVDBOX_HARD_FLOOR, bbPrice - 3.00).toFixed(2));
        const dynMax = parseFloat((bbPrice + 10.00).toFixed(2));

        // Update listing bounds to dynamic values
        listing.min_price = dynMin;
        listing.max_price = dynMax;

        // Target = match Buy Box directly, clamped to dynamic bounds
        newPrice = Math.max(dynMin, Math.min(bbPrice, dynMax));
        newPrice = parseFloat(newPrice.toFixed(2));
        reason = `Match Buy Box: target $${bbPrice.toFixed(2)} (dynMin=$${dynMin.toFixed(2)}, dynMax=$${dynMax.toFixed(2)})`;
      } else {
        // No Buy Box — hold current price
        newPrice = listing.current_price;
        reason = null;
      }
    } else {
      // WIIBOX: original min/max logic
      if (bbPrice != null) {
        if (bbPrice >= listing.min_price && bbPrice <= listing.max_price) {
          newPrice = bbPrice;
          reason = `Match Buy Box: matched at $${bbPrice.toFixed(2)}`;
        } else if (bbPrice < listing.min_price) {
          newPrice = listing.min_price;
          reason = `Match Buy Box: BB $${bbPrice.toFixed(2)} below min, set to min $${listing.min_price.toFixed(2)}`;
        } else {
          newPrice = listing.max_price;
          reason = `Match Buy Box: BB $${bbPrice.toFixed(2)} above max, set to max $${listing.max_price.toFixed(2)}`;
        }
      } else {
        // No Buy Box — hold current price
        newPrice = listing.current_price;
        reason = null;
      }
    }

    // ---- BOTH: Never Below Cost ----
    const costRule = ruleMap['Never Below Cost'];
    if (costRule && costRule.is_active) {
      if (newPrice < listing.cost_basis) {
        newPrice = listing.cost_basis;
        reason = `Never Below Cost: price floored at cost basis $${listing.cost_basis.toFixed(2)}`;
      }
    }

    // ---- BOTH: Sales Rank Guard ----
    const rankRule = ruleMap['Sales Rank Guard'];
    if (rankRule && rankRule.is_active) {
      const threshold = parseInt(rankRule.target_position) || 500000;
      if (listing.sales_rank > threshold && newPrice < listing.current_price) {
        newPrice = listing.current_price;
        reason = `Sales Rank Guard: rank ${listing.sales_rank.toLocaleString()} above ${threshold.toLocaleString()}, blocked downward reprice`;
      }
    }

    // Final bounds
    newPrice = Math.max(newPrice, listing.min_price);
    newPrice = Math.min(newPrice, listing.max_price);
    // DVDBOX hard floor — suggested_price can never go below $8.50
    if (prefix === 'DVDBOX') {
      newPrice = Math.max(newPrice, 8.50);
    }
    newPrice = parseFloat(newPrice.toFixed(2));

    if (newPrice !== listing.current_price) {
      log.push({
        asin: listing.asin,
        sku: listing.sku,
        old_price: listing.current_price,
        new_price: newPrice,
        reason: `[${prefix}] ${reason || 'Price adjusted within bounds'}`,
        timestamp: now.toISOString(),
      });
      listing.current_price = newPrice;
      listing.last_repriced = now.toISOString();
    }
  }

  return log;
}
