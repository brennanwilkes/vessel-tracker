-- Rebuild: KV+D1 -> D1-only, event-based positions. Wipes prior tables (~1 day of data only).
DROP TABLE IF EXISTS vessel_pings;
DROP TABLE IF EXISTS vessel_sightings;
DROP TABLE IF EXISTS vessels;

-- One row per vessel (MMSI). Static data + DENORMALIZED current position.
CREATE TABLE vessels (
  mmsi             INTEGER PRIMARY KEY,
  name             TEXT,
  vessel_type      INTEGER,
  length           INTEGER,
  destination      TEXT,
  last_lat         REAL,
  last_lon         REAL,
  last_speed       REAL,
  last_heading     INTEGER,
  last_pos_ts      INTEGER,
  last_seen        INTEGER NOT NULL,
  first_seen       INTEGER NOT NULL,
  of_interest      INTEGER NOT NULL DEFAULT 0,
  max_extent       TEXT    NOT NULL DEFAULT 'direct',
  first_direct_at  INTEGER,
  times_seen       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX vessels_of_interest ON vessels (of_interest, last_seen);

-- Movement-event log. A row exists ONLY when the vessel moved past the tier threshold.
CREATE TABLE positions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi    INTEGER NOT NULL,
  lat     REAL    NOT NULL,
  lon     REAL    NOT NULL,
  speed   REAL,
  heading INTEGER,
  ts      INTEGER NOT NULL,
  tier    TEXT    NOT NULL,
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);
CREATE INDEX positions_mmsi_ts      ON positions (mmsi, ts DESC);
CREATE INDEX positions_mmsi_tier_ts ON positions (mmsi, tier, ts DESC);
