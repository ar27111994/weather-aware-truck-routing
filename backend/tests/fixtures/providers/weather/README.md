# Open-Meteo fixtures: real recorded responses

Every file here is a response recorded live from `https://api.open-meteo.com/v1/forecast`
on 2026-10-19 (about 21:15-21:51 UTC) by the provider research probes (T1). The originals
live in the gitignored research folder `.planning/research/samples/` (index:
`INDEX.json`; the research write-up is `.planning/research/PROVIDERS.md`, section Q3), which
does not exist in CI, hence the copies. Nothing is hand-written or synthesised.

Edits made when copying (everything else is the upstream's bytes):

- Line endings were normalised from CRLF to LF (`.gitattributes` forces LF).
- `openmeteo-snow-sites-inch-units.json` was trimmed programmatically to the first 72
  of 168 hourly values of every one of its 12 sites (all other structure is kept).
- `openmeteo-600loc-post.json` was already trimmed by the probe to the first 2 of its 600
  locations (the full response was 1.8 MB).

| File | Recorded request | HTTP | Recorded (UTC) | Used for |
| ---- | ---------------- | ---- | -------------- | -------- |
| `openmeteo-denver-gmt-start-end-hour.json` | `GET latitude=39.7392&longitude=-104.9903&hourly=wind_speed_10m,wind_gusts_10m,rain,showers,snowfall,precipitation,temperature_2m,weather_code&wind_speed_unit=mph&precipitation_unit=inch&temperature_unit=fahrenheit&timeformat=unixtime&timezone=GMT&start_hour=2026-10-20T14:00&end_hour=2026-10-22T14:00` | 200 | 2026-10-19T21:15:57Z | Single location, 49 hourly values (start_hour/end_hour inclusive): the happy path. |
| `openmeteo-multi-3loc-gmt.json` | `GET latitude=40.7608,39.7392,41.8781&longitude=-111.8910,-104.9903,-87.6298&hourly=wind_speed_10m,wind_gusts_10m,rain,showers,snowfall,precipitation,temperature_2m,weather_code&wind_speed_unit=mph&precipitation_unit=inch&temperature_unit=fahrenheit&timeformat=unixtime&timezone=GMT&forecast_hours=6` | 200 | 2026-10-19T21:16:05Z | Three locations -> a JSON list in request order, 6 hourly values each. |
| `openmeteo-600loc-post.json` | `POST form (large, 600 locations x 8 vars x 49 h via form POST; saved body trimmed to first 2 locations)` | 200 | 2026-10-19T21:49:10Z | Real response of a form POST (8 variables x 49 h); the probe kept the first 2 of 600 locations. Template for the chunking tests. |
| `openmeteo-post-form-3loc.json` | `POST form: latitude=40.7608,39.7392,41.8781&longitude=-111.8910,-104.9903,-87.6298&hourly=temperature_2m,wind_speed_10m&timezone=GMT&forecast_hours=3` | 200 | 2026-10-19T21:16:17Z | Answer to a request WITHOUT our unit parameters (degC, km/h, iso8601 time, 2 variables): the adapter must refuse it as unexpected units. |
| `openmeteo-error-bad-latitude.json` | `GET latitude=123&longitude=-104.9&hourly=temperature_2m` | 400 | 2026-10-19T21:16:11Z | HTTP 400 error body (rejected request). |
| `openmeteo-error-bad-unit.json` | `GET latitude=39.7&longitude=-104.9&hourly=temperature_2m&wind_speed_unit=furlongs` | 400 | 2026-10-19T21:16:15Z | HTTP 400 error body (rejected request). |
| `openmeteo-error-bad-variable.json` | `GET latitude=39.7&longitude=-104.9&hourly=foo_bar` | 400 | 2026-10-19T21:16:10Z | HTTP 400 error body (rejected request). |
| `openmeteo-error-count-mismatch.json` | `GET latitude=39.7,40.1&longitude=-104.9&hourly=temperature_2m` | 400 | 2026-10-19T21:16:12Z | HTTP 400 error body (rejected request). |
| `openmeteo-error-forecast-days-17.json` | `GET latitude=39.7&longitude=-104.9&hourly=temperature_2m&forecast_days=17` | 400 | 2026-10-19T21:16:13Z | HTTP 400 error body (rejected request). |
| `openmeteo-error-no-coords.txt` | `GET hourly=temperature_2m` | 200 | 2026-10-19T21:16:16Z | HTTP 200 with an EMPTY body (missing coordinates): must be an upstream failure. |
| `openmeteo-1001loc-post.json` | `POST form (large, 1001 locations: expect a 'Only up to N locations' error)` | 429 | 2026-10-19T21:49:11Z | HTTP 429 minutely limit exceeded (right after the 600-location POST). |
| `openmeteo-1001loc-post-retry.json` | `POST form (large, 1001 locations after the minutely window reset)` | 400 | 2026-10-19T21:51:02Z | HTTP 400 'Only up to 1000 locations can be requested at once'. |
| `openmeteo-snow-sites-inch-units.json` | `GET latitude=64.84,61.22,46.54,44.27,39.66,40.59,48.41,43.48,48.6,42.89,46.86,39.25&longitude=-147.72,-149.9,-87.4,-71.3,-105.88,-111.64,-114.34,-110.76,-93.4,-78.88,-68.01,-106.29&hourly=snowfall,precipitation,rain,showers,temperature_2m&timezone=GMT&forecast_days=7&precipitation_unit=inch` | 200 | 2026-10-19T21:16:28Z | 12 snowy sites with precipitation_unit=inch. Real snowfall/precipitation/rain/showers in inches, but the probe asked for 5 variables, default degC and iso8601 time, so as recorded it is NOT in our request shape (the adapter refuses it); one test re-wraps its real numbers into our shape. Trimmed to the first 72 of 168 hours per site. |

Integrity: the SHA-256 of every stored file below equals `sha256_of_saved_body` in
`INDEX.json` (the probe hashed the LF body before Windows wrote it with CRLF), so
`sha256sum` reproduces it. The one exception is the trimmed snow-sites file: its line shows
the hash of the full recorded body, not of the trimmed copy.

```text
5dfb43c7868fc7187285a8bd8bae007d92b134e19ab155dc3fdb78e785e7d688  openmeteo-denver-gmt-start-end-hour.json
f224558d2d5b3a7db128305f3a05c0becc9a899c219f7066e4d1cfd6939ab87f  openmeteo-multi-3loc-gmt.json
9656df2e63a0d1cd15b3289f7035f4ee1081821c4999a6d5f1fe9a7d902f05c8  openmeteo-600loc-post.json
4ef6c060479ce2d05a2781facf88e084ce78ff72357cc735f8164514cb360431  openmeteo-post-form-3loc.json
4b2380f3540fed83e15525b5121946397df6f8adaa855da03c6f91efa61ba7d2  openmeteo-error-bad-latitude.json
91a3898529e48ee2a4875bc55aa9de48a7285a61e8917ce4a09fb420819ad128  openmeteo-error-bad-unit.json
8f9dafa6826bf541071cd1529c6a719347318c9f5b3da9f3c1e79da62ea09392  openmeteo-error-bad-variable.json
c1e2e12fcf46836cbf55e5a7aedf381f4cb6d5d3c2841da18dd815f6abe12a74  openmeteo-error-count-mismatch.json
fadea338329a57fcff87c07d8d874a28b29b9e6d76c00cfaf0125a891cc31cdd  openmeteo-error-forecast-days-17.json
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  openmeteo-error-no-coords.txt
1c419377325adecb81c0e15ae9a577dc3be14ea38409ad8493cc4ef625cf6f86  openmeteo-1001loc-post.json
ab54b9477315613671cee3c2d1a6c48ec0e528482135b43f9b94eef94a666304  openmeteo-1001loc-post-retry.json
0b012f007a1b0130730ca6b1268b55871fee39b08776673baa26f93f3ac36188  openmeteo-snow-sites-inch-units.json  (full recorded body; stored copy is trimmed)
```
