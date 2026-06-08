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
  enrichment_lat    REAL,
  enrichment_lon    REAL,
  enrichment_ts     INTEGER
);

-- One row per arrival event. A vessel gets a new row each time it appears
-- in a scrape after having aged out of the KV snapshot (5 min stale threshold).
CREATE TABLE IF NOT EXISTS vessel_sightings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi        INTEGER NOT NULL,
  entered_at  INTEGER NOT NULL,
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);

CREATE INDEX IF NOT EXISTS vessel_sightings_mmsi ON vessel_sightings (mmsi);
