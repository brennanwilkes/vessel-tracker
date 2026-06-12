-- Server-side trail precompute (worker/scripts/precompute-trails.mjs, run by a
-- GitHub Actions cron). Stores ONLY the inferred (A*-routed) waypoints that keep
-- the rendered Catmull-Rom curve off land; the client unions these with the live
-- `positions` rows at request time and re-splines with pure math (no coastline).
-- We never store real fixes here — they already live in `positions`.

-- One row per inferred waypoint. Keyed per SEGMENT (a run of fakes bracketed by
-- two real fixes); a segment's points are a deterministic function of its
-- bracketing fixes + vessel length bucket + generator_version, so once written
-- they are stable and never rewritten unless a new real fix changes the bracket.
CREATE TABLE inferred_positions (
  mmsi              INTEGER NOT NULL,
  seg_hash          TEXT    NOT NULL,
  seq               INTEGER NOT NULL,  -- order within the segment
  lat               REAL    NOT NULL,
  lon               REAL    NOT NULL,
  t                 INTEGER NOT NULL,  -- interpolated, strictly between the bracketing reals
  tier              TEXT    NOT NULL,  -- inherited from the bracketing reals (client tier filter)
  dashed            INTEGER NOT NULL DEFAULT 1,  -- 1 = inferred/dashed (data gap), 0 = solid (bulge repair)
  generator_version INTEGER NOT NULL,
  PRIMARY KEY (mmsi, seg_hash, seq),
  FOREIGN KEY (mmsi) REFERENCES vessels(mmsi)
);
CREATE INDEX inferred_positions_mmsi_t ON inferred_positions (mmsi, t);

-- "This segment has been processed" — present even when A* routed 0 points (out
-- of coverage), so a processed segment is never recomputed. Drives the converge-
-- don't-churn skip in the precompute.
CREATE TABLE inferred_segments (
  mmsi              INTEGER NOT NULL,
  seg_hash          TEXT    NOT NULL,
  point_count       INTEGER NOT NULL,
  generator_version INTEGER NOT NULL,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (mmsi, seg_hash)
);

-- Per-vessel heuristic: skip a vessel whose newest position hasn't advanced since
-- we last examined it (no new movement -> curve unchanged -> still land-free).
CREATE TABLE precompute_state (
  mmsi             INTEGER PRIMARY KEY,
  last_pos_ts_seen INTEGER NOT NULL,
  last_run_at      INTEGER NOT NULL
);
