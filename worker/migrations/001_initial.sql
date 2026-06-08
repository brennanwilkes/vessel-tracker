-- Track which migrations have been applied. Bootstraps itself before any
-- other migration runs.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vessels (
  mmsi              INTEGER PRIMARY KEY,
  name              TEXT,
  vessel_type       INTEGER,
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  times_seen        INTEGER NOT NULL DEFAULT 1,
  closest_nm        REAL,
  last_destination  TEXT,
  -- Updated by the weekly enrichment cron: last known position outside our local view
  enrichment_lat    REAL,
  enrichment_lon    REAL,
  enrichment_ts     INTEGER
);

-- Contiguous visit tracking. One row per visit, not one row per poll.
-- entered_at/exited_at mark when the vessel appeared and left the local bounding box.
-- exited_at IS NULL means the vessel is currently visible.
CREATE TABLE IF NOT EXISTS vessel_sightings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi         INTEGER NOT NULL,
  entered_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  exited_at    INTEGER,
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);

CREATE INDEX IF NOT EXISTS vessel_sightings_mmsi   ON vessel_sightings (mmsi);
CREATE INDEX IF NOT EXISTS vessel_sightings_active ON vessel_sightings (exited_at) WHERE exited_at IS NULL;
