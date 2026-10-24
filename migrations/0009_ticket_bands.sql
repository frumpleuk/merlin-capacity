-- Ticket availability as the park's own band, for stores that publish no
-- numbers (DigiTickets: Xtreme Scream Park, Tulleys). A row only when a band
-- changes, like the other logs: a night going from "Low availability" to "Sold
-- out" is one row, timestamped when we first saw it.
--
-- slot is '' for the night as a whole, or 'HH:MM' for a timed arrival slot
-- (Tulleys sells entry every 15 minutes, each with its own band).
-- band: 0 sold out, 1 very low, 2 low, 3 limited, 4 tickets available.
CREATE TABLE IF NOT EXISTS ticket_band_observation (
  park        TEXT    NOT NULL,
  event_date  TEXT    NOT NULL,  -- 'YYYY-MM-DD', the park's date
  slot        TEXT    NOT NULL,  -- '' or 'HH:MM'
  band        INTEGER NOT NULL,
  observed_at TEXT    NOT NULL,  -- poll time, UTC ISO8601
  PRIMARY KEY (park, event_date, slot, observed_at)
);
