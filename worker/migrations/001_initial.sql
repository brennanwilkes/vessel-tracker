-- Track which migrations have been applied. This table bootstraps itself
-- on first run before any other migration is applied.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id      INTEGER PRIMARY KEY,  -- migration number, e.g. 1 for 001_*.sql
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vessels (
  mmsi             INTEGER PRIMARY KEY,
  name             TEXT,
  vessel_type      INTEGER,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  times_seen       INTEGER NOT NULL DEFAULT 1,
  closest_nm       REAL,
  last_destination TEXT
);

CREATE TABLE IF NOT EXISTS vessel_pings (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi   INTEGER NOT NULL,
  lat    REAL    NOT NULL,
  lon    REAL    NOT NULL,
  ts     INTEGER NOT NULL,
  source TEXT    NOT NULL CHECK (source IN ('live', 'enrichment')),
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);

CREATE INDEX IF NOT EXISTS vessel_pings_mmsi_ts ON vessel_pings (mmsi, ts);
