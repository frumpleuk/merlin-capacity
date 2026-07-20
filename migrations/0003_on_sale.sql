-- Whether the public day ticket was on general sale for this date, vs the date
-- being open only via the annual-pass "prebook" yield anchor (see src/discover.ts
-- and docs/accesso-api.md). NULL for rows written before this column existed —
-- the frontend treats NULL as "on sale" so historical dates render normally.
-- Only meaningful for product='main' (RAP has no anchor, so it's always 1).
ALTER TABLE observation ADD COLUMN on_sale INTEGER;
