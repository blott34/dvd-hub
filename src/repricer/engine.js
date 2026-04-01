/**
 * Repricing Engine
 *
 * Loops through all active listings, applies rules in order,
 * and decides whether to adjust the price. Logs every change.
 *
 * Rules are applied in this order:
 * 0. Match Buy Box — set price to Buy Box within min/max bounds
 * 1. Default Floors — enforce min $8.50 / max $24.99 unless overridden
 * 2. Max Hit Day 1 — raise max if listing hits max on first day
 * 3. Stale Inventory — drop min after N days without a sale
 * 4. Never Below Cost — floor at cost_basis
 * 5. Sales Rank Guard — block downward repricing if rank > threshold
 *
 * Stale Inventory and Max Hit Day 1 adjust min/max BEFORE Buy Box comparison.
 */

import { fetchListings, updatePrice } from './amazonApi.js';

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

    let newPrice = listing.current_price;
    let reason = null;

    // Pre-pass: Adjust min/max based on Stale Inventory and Max Hit Day 1
    const maxHitRule = ruleMap['Max Hit Day 1'];
    if (maxHitRule && maxHitRule.is_active) {
      const dateListed = new Date(listing.date_listed + 'T00:00:00');
      const daysSinceListed = Math.floor((now - dateListed) / 86400000);
      const raiseAmount = parseFloat(maxHitRule.max_hit_raise_amount) || 3.00;
      if (daysSinceListed <= 1 && listing.current_price >= listing.max_price) {
        listing.max_price = parseFloat((listing.max_price + raiseAmount).toFixed(2));
      }
    }

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

    // Rule 0: Match Buy Box
    const matchBBRule = ruleMap['Match Buy Box'];
    if (matchBBRule && matchBBRule.is_active) {
      const bbData = buyBoxPrices[listing.asin];
      const bbPrice = bbData ? bbData.buyBox : null;
      const nobbRaise = parseFloat(matchBBRule.no_buybox_raise_amount) || 1.00;

      if (bbPrice != null) {
        if (bbPrice >= listing.min_price && bbPrice <= listing.max_price) {
          newPrice = bbPrice;
          reason = `Match Buy Box: matched Buy Box at $${bbPrice.toFixed(2)}`;
        } else if (bbPrice < listing.min_price) {
          newPrice = listing.min_price;
          reason = `Match Buy Box: Buy Box $${bbPrice.toFixed(2)} below min, set to min $${listing.min_price.toFixed(2)}`;
        } else {
          newPrice = listing.max_price;
          reason = `Match Buy Box: Buy Box $${bbPrice.toFixed(2)} above max, set to max $${listing.max_price.toFixed(2)}`;
        }
      } else {
        const raised = Math.min(listing.current_price + nobbRaise, listing.max_price);
        newPrice = parseFloat(raised.toFixed(2));
        reason = `No Buy Box - incremental raise of $${nobbRaise.toFixed(2)}`;
      }
    }

    // Rule 1: Default Floors
    const defaultFloors = ruleMap['Default Floors'];
    if (defaultFloors && defaultFloors.is_active) {
      if (newPrice < listing.min_price) {
        newPrice = listing.min_price;
        reason = 'Default Floors: price below minimum, raised to min';
      }
      if (newPrice > listing.max_price) {
        newPrice = listing.max_price;
        reason = 'Default Floors: price above maximum, lowered to max';
      }
    }

    // Rule 4: Never Below Cost
    const costRule = ruleMap['Never Below Cost'];
    if (costRule && costRule.is_active) {
      if (newPrice < listing.cost_basis) {
        newPrice = listing.cost_basis;
        reason = `Never Below Cost: price floored at cost basis $${listing.cost_basis.toFixed(2)}`;
      }
    }

    // Rule 5: Sales Rank Guard
    const rankRule = ruleMap['Sales Rank Guard'];
    if (rankRule && rankRule.is_active) {
      const threshold = parseInt(rankRule.target_position) || 500000;
      if (listing.sales_rank > threshold && newPrice < listing.current_price) {
        newPrice = listing.current_price;
        reason = `Sales Rank Guard: rank ${listing.sales_rank.toLocaleString()} above ${threshold.toLocaleString()}, blocked downward reprice`;
      }
    }

    // Final bounds check
    newPrice = Math.max(newPrice, listing.min_price);
    newPrice = Math.min(newPrice, listing.max_price);
    newPrice = parseFloat(newPrice.toFixed(2));

    if (newPrice !== listing.current_price) {
      log.push({
        asin: listing.asin,
        sku: listing.sku,
        old_price: listing.current_price,
        new_price: newPrice,
        reason: reason || 'Price adjusted within bounds',
        timestamp: now.toISOString(),
      });
      listing.current_price = newPrice;
      listing.last_repriced = now.toISOString();
    }
  }

  return log;
}
