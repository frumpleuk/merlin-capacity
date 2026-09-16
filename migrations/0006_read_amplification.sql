-- Stop the D1 read amplification that produced a 145-billion-row month.
--
-- `readQueueDay` (src/db.ts) asks for one park's rows for one UTC day:
--
--     WHERE park = ? AND observed_at >= ? AND observed_at < ?
--
-- The only park-leading index was idx_q_lookup (park, ride_id, queue_line_id,
-- observed_at). `observed_at` sits behind two columns the query does not
-- constrain, so SQLite could only use the `park =` term and then had to walk
-- every row that park had EVER written, throwing away all but today's:
--
--     SEARCH queue_observation USING INDEX idx_q_lookup (park=?)
--     USE TEMP B-TREE FOR ORDER BY
--
-- That query runs once per changed poll -- per park, every minute the feed moves
-- -- so one poll costs the size of the whole table. The waste factor is the
-- collector's age in days, which means the daily read volume grows with the
-- SQUARE of how long this has been running: it was never going to level off.
--
-- (park, observed_at) makes the day a direct range seek, and also serves the
-- ORDER BY, dropping the temp b-tree.
CREATE INDEX IF NOT EXISTS idx_q_park_time ON queue_observation (park, observed_at);

-- idx_q_lookup duplicates PRIMARY KEY (park, ride_id, queue_line_id,
-- observed_at) column for column, and SQLite already maintains a unique index
-- for that key. It never offered a lookup path the primary key didn't -- it only
-- doubled the write and storage cost -- and it was the index the planner kept
-- choosing above. Dropping it removes the bad plan as well as the duplication.
DROP INDEX IF EXISTS idx_q_lookup;

-- Same duplication on `observation`: idx_obs_lookup repeats PRIMARY KEY
-- (park, product, event_date, observed_at) exactly. The primary key's own index
-- serves every query that named it, including as a covering index.
DROP INDEX IF EXISTS idx_obs_lookup;

-- Same again on `special_day`: 0005 recreated special_day_park_date
-- (park, event_date) under a primary key of (park, event_date, observed_at),
-- which already covers any (park) or (park, event_date) seek as a prefix.
DROP INDEX IF EXISTS special_day_park_date;
