-- "Visited destinations" — sparse named-place attribution. One row per (mmsi, zone):
-- first_ts/last_ts bracket the vessel's presence in that zone, lat/lon a representative
-- fix for the map dot. Bounded by saturation (a finite vessel×zone matrix), never
-- deleted. Local zones are populated for free by the existing direct/local scans;
-- distant zones by the (future) rotating foreign scan.
CREATE TABLE zone_visits (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  mmsi     INTEGER NOT NULL,
  zone_id  TEXT    NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL,
  lat      REAL    NOT NULL,
  lon      REAL    NOT NULL,
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);
CREATE UNIQUE INDEX zone_visits_mmsi_zone ON zone_visits (mmsi, zone_id);
CREATE INDEX zone_visits_zone ON zone_visits (zone_id, last_ts DESC);

-- Small key/value scratch for cron state (e.g. the rotating foreign-scan cursor).
CREATE TABLE scan_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
