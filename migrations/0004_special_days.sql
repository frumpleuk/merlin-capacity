-- Detected special days, kept permanently.
--
-- These can only be detected PROSPECTIVELY. accesso prunes a package from the
-- catalog once its event has passed: Thorpe's "1 Day Pass - VodafoneThree Big
-- Day Out" is still there on the day it runs, but Alton's equivalent for
-- 2026-09-06 was gone within a week and cannot be recovered. The served
-- special.json also only covers the forward window, so without this a day we
-- DID identify would vanish from the calendar the moment it passed.
--
-- So every detection is written here on the day it is found, and the served file
-- is the union of what we can currently see and what we have ever seen.
CREATE TABLE IF NOT EXISTS special_day (
  park       TEXT NOT NULL,
  event_date TEXT NOT NULL,          -- 'YYYY-MM-DD'
  name       TEXT NOT NULL,
  capacity   INTEGER NOT NULL,
  available  INTEGER NOT NULL,
  used       INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (park, event_date)
);

CREATE INDEX IF NOT EXISTS special_day_park_date ON special_day (park, event_date);
