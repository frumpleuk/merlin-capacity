-- A maintained "latest reading per date" projection, so the hot path stops
-- scanning the log.
--
-- `observation` is an append-only log: a row per date per time the numbers
-- moved. Every serving read wants only the LAST row per date, but had to scan
-- every reading of every date in the range to find it. The waste factor is the
-- readings accumulated so far, and tickets never reset the way a queue day does
-- -- a date 300 days out collects readings for 300 days before it is finally
-- served -- so a month scan that visits 300 rows to return 30 today visits
-- 6,000 to return the same 30 once the log matures.
--
-- Worse, it fans out: the 365-day horizon spans 13 distinct months, and a poll
-- re-projects every month its deltas touched. A RAP batch release moves dates
-- across the whole horizon at once, so the widest fan-out lands on exactly the
-- event most worth capturing.
--
-- This table is one row per (park, product, event_date), upserted in the same
-- batch as the log append. Reads become one row per date and stay flat as the
-- log grows. The log remains the source of truth: `rebuildMonthsFromD1` still
-- projects the month files from it every 30 minutes, and now reconciles this
-- table against it in the same pass, so any drift is found and repaired rather
-- than served indefinitely.
--
-- Like the log and unlike the forward product files, a date is never removed
-- here. A date the API stops returning keeps its last known reading (Chessington
-- 2026-11-20 and its RAP allocation of 249), which is what the anomaly report
-- and the calendar both rely on.
CREATE TABLE IF NOT EXISTS observation_latest (
  park        TEXT    NOT NULL,
  product     TEXT    NOT NULL,
  event_date  TEXT    NOT NULL,
  capacity    INTEGER NOT NULL,
  available   INTEGER NOT NULL,
  used        INTEGER NOT NULL,
  package_ids TEXT,
  on_sale     INTEGER,
  observed_at TEXT    NOT NULL,   -- the reading this row came from
  PRIMARY KEY (park, product, event_date)
);

-- No secondary index: the primary key already seeks
-- (park = ? AND product = ? AND event_date BETWEEN ? AND ?) and returns it in
-- event_date order. Adding one would repeat the key, which is the mistake
-- migration 0006 had to undo on three tables.

-- Backfill from the log, so the projection is correct the moment it exists
-- rather than filling in as dates happen to move.
--
-- SQLite resolves bare columns alongside a single MAX() to the row that MAX came
-- from, per GROUP BY group (sqlite.org/lang_select.html#bareagg), so this takes
-- each date's latest reading whole. One full pass over `observation`; it is a
-- one-off, but it is the largest statement in this file -- if D1 rejects it for
-- size or time, run it per park with an added `WHERE park = '...'` and the
-- result is identical.
INSERT OR REPLACE INTO observation_latest
  (park, product, event_date, capacity, available, used, package_ids, on_sale, observed_at)
SELECT park, product, event_date, capacity, available, used, package_ids, on_sale,
       MAX(observed_at)
  FROM observation
 GROUP BY park, product, event_date;
