-- Keep every reading of a special day, not just the latest.
--
-- 0004 made this table one row per date, overwritten each poll, so the Thorpe
-- VodafoneThree buyout on 2026-09-13 survives as a single figure (9,136 taken of
-- 15,000) with no record of how it got there. The `observation` table next door
-- has kept a per-minute change log of every product since July, and a buyout is
-- the case where the curve matters MOST: the package stops returning the date
-- within hours of the event, so whatever was not recorded is gone for good.
--
-- Same shape as `observation`: append on change, keyed by when it was observed.
CREATE TABLE IF NOT EXISTS special_day_new (
  park        TEXT NOT NULL,
  event_date  TEXT NOT NULL,          -- 'YYYY-MM-DD'
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL,
  available   INTEGER NOT NULL,
  used        INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (park, event_date, observed_at)
);

-- Carry the six rows 0004 collected across, dated when they were last read.
INSERT OR IGNORE INTO special_day_new
  (park, event_date, name, capacity, available, used, observed_at)
  SELECT park, event_date, name, capacity, available, used, last_seen FROM special_day;

DROP TABLE special_day;
ALTER TABLE special_day_new RENAME TO special_day;

CREATE INDEX IF NOT EXISTS special_day_park_date ON special_day (park, event_date);
