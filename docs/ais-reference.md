# AIS Reference

## aisstream.io subscribe frame

```json
{
  "APIKey": "<key>",
  "BoundingBoxes": [[[SW_lat, SW_lon], [NE_lat, NE_lon]]],
  "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
  "FiltersShipMMSI": ["123456789"]
}
```

`FiltersShipMMSI` is optional. When set, only those MMSIs are returned — but the bounding box still applies, so use a near-global box for enrichment. TODO: verify aisstream accepts `[[-90,-180],[90,180]]`.

## PositionReport message

```json
{
  "MessageType": "PositionReport",
  "MetaData": {
    "MMSI": 123456789,
    "ShipName": "MV EXAMPLE",
    "latitude": 48.43,
    "longitude": -123.36,
    "time_utc": "2026-01-01T00:00:00Z"
  },
  "Message": {
    "PositionReport": {
      "Sog": 12.4,
      "Cog": 247.0,
      "TrueHeading": 245
    }
  }
}
```

`TrueHeading = 511` means "not available" per AIS spec — treat as `null`.
`Sog` = speed over ground in knots.

## ShipStaticData message

```json
{
  "MessageType": "ShipStaticData",
  "MetaData": { "MMSI": 123456789 },
  "Message": {
    "ShipStaticData": {
      "Type": 70,
      "Dimension": { "A": 120, "B": 30 },
      "Destination": "PRINCE RUPERT",
      "Name": "MV EXAMPLE"
    }
  }
}
```

`Dimension.A + Dimension.B` = vessel length in metres (A = bow to GPS, B = stern to GPS).
`Type` = AIS vessel type code (see table below).

## AIS vessel type codes → categories

| Range   | Category           |
|---------|--------------------|
| 60–69   | Passenger          |
| 70–79   | Cargo              |
| 80–89   | Tanker             |
| 40–49   | High speed / Ferry |
| 35      | Military           |
| 30      | Fishing            |
| 31–32   | Tug / push         |
| 33–34   | Dredging / Diving  |
| 36–37   | Pleasure craft     |
| 50–51   | Pilot / SAR        |
| 52–53   | Tug                |
| 54      | Anti-pollution     |
| 55–59   | Government         |
| 90–99   | Other (govt/aux)   |
| null    | —                  | Name/length heuristics: govt name prefixes → `government`, length >150m → `cargo` |
| other   | Unknown            |

Full table: https://www.maritec.co.za/tools/aisvdmvdodecoding/

## Bounding boxes

Defined in `worker/src/constants.ts`:

- **LOCAL** `[[47.8, -124.5], [49.0, -122.5]]` — Strait of Juan de Fuca + Haro Strait, south/east of Victoria BC. Used by live ingest cron.
- **GLOBAL** `[[-90, -180], [90, 180]]` — near-global, paired with `FiltersShipMMSI` for weekly enrichment. TODO: verify aisstream accepts this exact box.
