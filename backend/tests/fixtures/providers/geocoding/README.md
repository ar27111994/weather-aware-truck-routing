# Geocoding provider fixtures

Real responses of the two upstreams behind `haulcast.providers.geocoding`, used by the adapter tests
(served through `respx`; no test ever touches the network). Nothing in these files is hand-written.

- **Photon** (`https://photon.komoot.io/api`, key-free): GeoJSON `FeatureCollection`. Data (c)
  OpenStreetMap contributors, ODbL.
- **Open-Meteo geocoding** (`https://geocoding-api.open-meteo.com/v1/search`, key-free): GeoNames data,
  CC BY 4.0.

## Provenance

Two recording sessions, both against the live services:

- **Research run, 2026-10-19 21:13-21:14 UTC** (card `t_97573092`, notes in `PROVIDERS.md` section Q4):
  the files marked `research samples` were copied from `.planning/research/samples/`, which is
  gitignored and therefore absent in CI. Each copy was checked against the SHA-256 recorded in that
  run's `INDEX.json` (the research run saved them with Windows line endings; the hash covers the
  text with LF newlines).
- **Re-recording, 2026-10-19 23:28 UTC (= 2026-10-20 in Pakistan time)**: the research run kept the
  request but not the body for some probes (`chicago, il`, partial `den`/`denv`, Springfield with a
  Missouri bias, and several Open-Meteo queries). Those were fetched again with the identical
  parameters (one request each, identifying `User-Agent`, 1.5 s apart); the response sizes match the
  research index (for example 2303, 1850, 1920 and 3209 bytes for the Photon probes).

## Files

| File                               | HTTP | Request                                                                                                            | Recorded                | Source           | sha256       | What it exercises                                                                      |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------- | ------------ | -------------------------------------------------------------------------------------- |
| `photon-denver.json`               | 200  | `https://photon.komoot.io/api?q=denver&limit=5&lang=en`                                                            | 2026-10-19 21:13:40 UTC | research samples | 1140f379ce76 | Denver CO first, three villages, one NC hamlet (`type: district`, `osm_type: N`)       |
| `photon-chicago-il.json`           | 200  | `https://photon.komoot.io/api?q=chicago%2C+il&limit=5&lang=en`                                                     | 2026-10-19 23:28:01 UTC | re-recorded      | 5fc523fffe69 | city + `house` features that carry name, street, housenumber and city                  |
| `photon-address.json`              | 200  | `https://photon.komoot.io/api?q=1600+pennsylvania+ave+nw+washington&limit=5&lang=en`                               | 2026-10-19 21:13:53 UTC | research samples | 50f8234e4c20 | street-address query: White House (name + housenumber + street), bus stops             |
| `photon-partial-den.json`          | 200  | `https://photon.komoot.io/api?q=den&limit=5&lang=en`                                                               | 2026-10-19 23:28:03 UTC | re-recorded      | cc7a4df82de2 | no US bias: Denmark first (`type: country`, no `state`), a county, non-ASCII name      |
| `photon-partial-denv-us-bias.json` | 200  | `https://photon.komoot.io/api?q=denv&limit=5&lang=en&lat=39.5&lon=-98.35`                                          | 2026-10-19 23:28:04 UTC | re-recorded      | 9f3ca7edc6f1 | with the US bias: Denver first; `street` and `other` types, same name in three cities  |
| `photon-springfield-nobias.json`   | 200  | `https://photon.komoot.io/api?q=springfield&limit=8&lang=en`                                                       | 2026-10-19 21:13:43 UTC | research samples | 7976ce10cbde | eight Springfields; the first one repeats its name as `city`                           |
| `photon-springfield-bias-mo.json`  | 200  | `https://photon.komoot.io/api?q=springfield&limit=8&lang=en&lat=37.2&lon=-93.3`                                    | 2026-10-19 23:28:06 UTC | re-recorded      | 7cbbdffff168 | bias over Missouri: `city`, `house`, `locality` and `other` features                   |
| `photon-lang-unsupported.json`     | 400  | `https://photon.komoot.io/api?q=denver&limit=2&lang=xx`                                                            | 2026-10-19 21:13:58 UTC | research samples | c23014c0fc1d | HTTP 400, field-keyed error body (no top-level message)                                |
| `photon-no-q.json`                 | 400  | `https://photon.komoot.io/api?limit=2`                                                                             | 2026-10-19 21:13:59 UTC | research samples | 28a23e23e17f | HTTP 400, `{"message": ...}` error body                                                |
| `photon-bad-lat.json`              | 400  | `https://photon.komoot.io/api?q=denver&lat=abc&lon=1`                                                              | 2026-10-19 21:14:02 UTC | research samples | 629371dcf463 | HTTP 400, field-keyed error body                                                       |
| `omgeo-denver.json`                | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=denver&count=5&language=en&format=json&countryCode=US`        | 2026-10-19 21:14:12 UTC | research samples | e02a90a05151 | five results with population and postcodes (PPLA, PPL)                                 |
| `omgeo-salt-lake.json`             | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=salt+lake&count=5&language=en&format=json`                    | 2026-10-19 21:14:13 UTC | research samples | efb6f6356de5 | no `countryCode`: Salt Lake (HI) first, other countries, missing populations           |
| `omgeo-springfield.json`           | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=springfield&count=10&language=en&format=json&countryCode=US`  | 2026-10-19 23:28:08 UTC | re-recorded      | d0f02a4bf0a6 | API order is NOT population order (Massachusetts 154,341 comes after Illinois 114,394) |
| `omgeo-partial-den.json`           | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=den&count=5&language=en&format=json&countryCode=US`           | 2026-10-19 23:28:10 UTC | re-recorded      | 8f2015817548 | an airport (`AIRP`, no population) ranked second by the API                            |
| `omgeo-denver-co.json`             | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=denver%2C+co&count=5&language=en&format=json&countryCode=US`  | 2026-10-19 23:28:12 UTC | re-recorded      | a422eb7b7b24 | qualified query: city plus `MT`, `PRK` and `AIRH` features                             |
| `omgeo-united-states.json`         | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=united+states&count=5&language=en&format=json&countryCode=US` | 2026-10-19 23:28:15 UTC | re-recorded      | b7c082fba0d3 | a `PCLI` country row without `admin1`                                                  |
| `omgeo-newark.json`                | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=newark&count=8&language=en&format=json&countryCode=US`        | 2026-10-19 21:14:14 UTC | research samples | c2146bb9dc3b | eight results (PPLA2, PPL) in population order                                         |
| `omgeo-address.json`               | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=1600+pennsylvania+ave+nw&count=5&language=en&format=json`     | 2026-10-19 21:14:19 UTC | research samples | 16650187931b | address query: object WITHOUT `results` (HTTP 200)                                     |
| `omgeo-one-char.json`              | 200  | `https://geocoding-api.open-meteo.com/v1/search?name=d&count=5&language=en&format=json`                            | 2026-10-19 21:14:20 UTC | research samples | f5c04ccc764c | one-character query: object WITHOUT `results` (HTTP 200)                               |
| `omgeo-no-name.json`               | 400  | `https://geocoding-api.open-meteo.com/v1/search?count=5`                                                           | 2026-10-19 21:14:22 UTC | research samples | 78d4519dfd81 | HTTP 400, `{"error": true, "reason": ...}` error body                                  |

`sha256` is the first 12 hex digits of the SHA-256 of the recorded body: for the research samples,
the value in that run's `INDEX.json` (the pretty-printed sample with LF newlines, as saved by the
probe script); for the re-recordings, the raw response bytes exactly as the server sent them.

## Processing

- **Re-serialised, not edited:** 2-space indentation, LF newlines, a final newline and UTF-8
  (`.editorconfig`), with the parsed content verified identical to what the upstream sent.
- **Nothing trimmed:** every upstream response body is under 5 KB (the indented files are slightly
  larger).
- The error fixtures were served with the HTTP status in the table; every other file is a 200.
