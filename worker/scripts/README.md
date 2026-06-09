# D1 Inspection Tools for AI Agents

Read-only query scripts wrapping `npx wrangler d1 execute`. All output JSON
by default (use `--pretty` for human-readable tables).

## Common flags

| Flag | Description |
|------|-------------|
| `--local` | Query local D1 (default: remote) |
| `--db <name>` | Database name (default: `vessel-tracker`) |
| `--pretty` | ASCII table instead of JSON |
| `--help`, `-h` | Show help |

## Scripts

| Script | Description |
|--------|-------------|
| `db-stats` | High-level counts: vessels, of_interest, positions by tier, max_extent |
| `db-list-ships` | All vessels with key fields, sorted by last_seen desc |
| `db-ship <mmsi>` | Full row + per-tier position stats for a single vessel |
| `db-positions <mmsi>` | Movement-event timeline for a vessel (--tier, --limit) |
| `db-of-interest` | Vessels that entered the direct bounding box (map candidates) |
| `db-recent` | Most recently seen vessels with moving/stopped status |
| `db-timeline` | Recent position events across all vessels (--tier, --limit) |
| `db-stale` | Vessels not seen within N hours (--hours, default 24) |
| `db-by-extent` | Vessel count grouped by max_extent (direct/local/global) |
| `db-by-type` | Vessel count grouped by AIS type code (--min N) |
| `db-tiers` | Position stats per scan tier (count, distinct vessels, avg speed) |
| `db-search <term>` | Search by MMSI or name fragment (case-insensitive) |
| `db-raw <sql>` | Run arbitrary SQL (read-only guard; --write to bypass) |

## Safety

- MMSI is validated as 6-9 digit integer before interpolation.
- Numeric flags (`--limit`, `--hours`, `--min`) validated as positive integers.
- Search terms sanitized (SQLite single-quote escaping).
- `db-raw` read-only guard rejects non-SELECT/WITH unless `--write` passed.
