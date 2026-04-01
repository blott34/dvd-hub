-- Delete any listings that don't contain DVDBOX or WIIBOX in the SKU
DELETE FROM listings
WHERE sku NOT ILIKE '%dvdbox%' AND sku NOT ILIKE '%wiibox%';

-- Add a CHECK constraint so non-DVDBOX/WIIBOX SKUs can never be inserted
ALTER TABLE listings
ADD CONSTRAINT listings_sku_dvdbox_wiibox_only
CHECK (sku ILIKE '%dvdbox%' OR sku ILIKE '%wiibox%');
