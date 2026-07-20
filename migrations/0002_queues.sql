-- Append-only queue-time change log for ride waits (Attractions.io live feed).
-- Like `observation`, a row exists only where a value actually moved for a
-- (park, ride, queue line), so the table doubles as the intraday event log:
-- opens/closes and wait jumps show up as change-points.
CREATE TABLE IF NOT EXISTS queue_observation (
  park           TEXT    NOT NULL,   -- 'alton_towers'
  ride_id        INTEGER NOT NULL,   -- Item._id
  queue_line_id  INTEGER NOT NULL,   -- QueueLine._id, or 0 for a ride-level "main"
  line_type      TEXT,               -- 'physical_main' | 'single_rider' | ...
  queue_time     INTEGER,            -- posted wait, minutes; NULL when closed/not reporting
  status         TEXT,               -- QueueStatusMessage (e.g. 'CLOSED', 'Closed at 5pm')
  is_open        INTEGER NOT NULL,   -- ride-level, 0/1
  is_operational INTEGER NOT NULL,   -- ride-level, 0/1
  observed_at    TEXT    NOT NULL,   -- poll time, UTC ISO8601 (ms)
  PRIMARY KEY (park, ride_id, queue_line_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_q_lookup ON queue_observation (park, ride_id, queue_line_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_q_time   ON queue_observation (observed_at);
