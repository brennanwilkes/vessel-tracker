-- Write-budget reduction, round 2. In D1 every secondary-index entry counts as a row
-- WRITTEN, so a frequently-updated column inside an index key doubles that write.

-- 1. zone_visits_zone was keyed (zone_id, last_ts DESC). `last_ts` is bumped every time a
--    vessel is re-seen in a zone it's already in, so EVERY bump rewrote the index entry as
--    well as the base row — 2 rows per bump. With ~145 of 330 live vessels sitting inside
--    a named zone at any moment and a 30-min throttle, that was ~12k rows/day for data
--    whose only job is "which named places has this vessel visited".
--    zone_id alone still serves the per-zone rollup (db-zones); the ORDER BY last_ts now
--    sorts a handful of rows per zone, which is free at this table's size. Paired with
--    ZONE_VISIT_THROTTLE_MS 30 min -> 6 h in constants.ts.
DROP INDEX IF EXISTS zone_visits_zone;
CREATE INDEX zone_visits_zone ON zone_visits (zone_id);

-- 2. Seed the AIS lock row once, so acquireAisLock no longer issues an INSERT OR IGNORE
--    on every acquire (~1,700/day) for a row that can only be created once.
INSERT OR IGNORE INTO scan_meta (key, value) VALUES ('ais_conn_lock', 0);
