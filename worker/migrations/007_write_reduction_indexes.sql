-- Write-rate reduction. In D1 every secondary-index entry counts as a row WRITTEN, so
-- an index that earns nothing on reads is a permanent tax on every insert/update.

-- 1. positions_mmsi_tier_ts earned nothing. Every /track query is
--    `WHERE mmsi=?1 [AND tier IN (...)] ORDER BY ts DESC LIMIT n`, which
--    positions_mmsi_ts already serves optimally: seek the mmsi, walk ts DESC, filter
--    tier inline, stop at LIMIT — no sort. The tier index would instead force a walk
--    per tier value plus a merge. So it only ever cost ~25% of each position insert.
DROP INDEX IF EXISTS positions_mmsi_tier_ts;

-- 2. vessels_of_interest was keyed (of_interest, last_seen). last_seen changes on EVERY
--    heartbeat, so the index row was rewritten every heartbeat — doubling the cost of
--    the system's highest-frequency write. of_interest alone still serves the
--    `WHERE of_interest = 1` filter, and because last_seen is no longer part of the key
--    a heartbeat leaves the index untouched. The `ORDER BY last_seen` in those queries
--    now sorts a few hundred rows, which is free at this table's size.
DROP INDEX IF EXISTS vessels_of_interest;
CREATE INDEX vessels_of_interest ON vessels (of_interest);
