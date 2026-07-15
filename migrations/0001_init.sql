-- Append-only change log. A row exists only where a value actually moved
-- for a (park, product, event_date), so this doubles as the ticket-release
-- event log: RAP batch releases show up as capacity jumping.
CREATE TABLE IF NOT EXISTS observation (
  park        TEXT    NOT NULL,   -- 'alton_towers'
  product     TEXT    NOT NULL,   -- 'main' | 'rap'
  event_date  TEXT    NOT NULL,   -- visit date, 'YYYY-MM-DD'
  capacity    INTEGER NOT NULL,   -- nominal ceiling (main) / hard pool (rap)
  available   INTEGER NOT NULL,   -- tickets left  <-- the signal
  used        INTEGER NOT NULL,   -- sold so far
  package_ids TEXT,               -- as returned, may be comma-joined
  observed_at TEXT    NOT NULL,   -- poll time, UTC ISO8601 (ms)
  PRIMARY KEY (park, product, event_date, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_obs_lookup ON observation (park, product, event_date, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_time   ON observation (observed_at);

-- Every poll attempt, changed or not — for monitoring cadence, blocks, drift.
CREATE TABLE IF NOT EXISTS poll_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  park          TEXT    NOT NULL,
  product       TEXT    NOT NULL,
  http_status   INTEGER NOT NULL,
  api_status    TEXT    NOT NULL,   -- 'OK' | 'FAILED' | ...
  changed_count INTEGER NOT NULL,
  dates_seen    INTEGER NOT NULL,
  observed_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poll_time ON poll_log (observed_at);
