import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { RISK_RULES, riskOrdinal } from "../../lib/risk";
import {
  riskRulesSchema,
  SAMPLING_INTERVALS_MI,
  SCENARIO_NOTICE,
  heatmapSchema,
  isPlanId,
  planSchema,
  type Checkpoint,
  type PlanLocation,
  type PlanRequest,
  type RiskLevel,
  type RiskRules,
} from "../contract";
import {
  FixtureError,
  buildHeatmap,
  buildPlan,
  buildWorld,
  checkpointDistances,
  idempotencyKey,
  mockPlanId,
  summarizeCheckpoints,
  usZone,
  utcOffsetSeconds,
} from "./plan-builder";
import {
  GEOCODE_CATALOG,
  TRIPS,
  TRIPS_DATA,
  findTrip,
  interpolateLinear,
  searchGeocode,
} from "./trips";
import {
  SCENARIO_CATALOG,
  SCENARIO_IDS,
  assessWeather,
  ceilToHour,
  createWeatherField,
  heatmapRiskValue,
  isScenarioId,
  rankRoutes,
  type RankCandidate,
  type ScenarioId,
} from "./weather";

const place = (name: string): PlanLocation => {
  const entry = GEOCODE_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no catalog city ${name}`);
  return { lat: entry.lat, lon: entry.lon, label: entry.label };
};

const TRIP_PAIRS = [
  ["Salt Lake City", "Denver"],
  ["Chicago", "Denver"],
  ["Newark", "Jersey City"],
] as const;

function request(from: string, to: string, overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    origin: place(from),
    destination: place(to),
    departure_time: "2026-10-20T14:00:00Z",
    load_weight_lb: 38000,
    sampling_interval_mi: 25,
    scenario: null,
    ...overrides,
  };
}

const slc = (scenario: ScenarioId | null, overrides: Partial<PlanRequest> = {}): PlanRequest =>
  request("Salt Lake City", "Denver", { scenario, ...overrides });

/** Every contract invariant the card lists, checked on a built plan. */
function expectPlanInvariants(plan: ReturnType<typeof buildPlan>): void {
  expect(planSchema.safeParse(plan).success).toBe(true);
  expect(isPlanId(plan.plan_id)).toBe(true);
  expect(plan.routes.map((route) => route.rank)).toEqual(plan.routes.map((_, index) => index + 1));
  expect(plan.routes.filter((route) => route.recommended)).toHaveLength(1);
  expect(plan.routes[0]?.route_id).toBe(plan.recommendation.route_id);
  for (const route of plan.routes) {
    const interval = plan.request.sampling_interval_mi;
    const ownedSum = route.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.owned_mi, 0);
    expect(Math.abs(ownedSum - route.distance_mi)).toBeLessThan(1e-6);
    const statsSum =
      Object.values(route.stats.miles_by_level).reduce((sum, miles) => sum + miles, 0) +
      route.stats.unknown_mi;
    expect(Math.abs(statsSum - route.distance_mi)).toBeLessThan(1e-6);
    expect(route.checkpoints).toHaveLength(Math.ceil((route.distance_mi - 0.01) / interval) + 1);
    expect(route.checkpoints[0]?.distance_mi).toBe(0);
    expect(route.checkpoints.at(-1)?.distance_mi).toBe(route.distance_mi);
    const last = route.geometry.coordinates.length - 1;
    expect(route.checkpoints[0]?.coord_start).toBe(0);
    expect(route.checkpoints.at(-1)?.coord_end).toBe(last);
    route.checkpoints.forEach((checkpoint, position) => {
      expect(checkpoint.index).toBe(position);
      expect(checkpoint.coord_start).toBeLessThanOrEqual(checkpoint.coord_end);
      const next = route.checkpoints[position + 1];
      if (next) {
        expect(next.coord_start).toBe(checkpoint.coord_end);
        expect(Date.parse(next.eta)).toBeGreaterThanOrEqual(Date.parse(checkpoint.eta));
      }
    });
    expect(route.cumulative_mi.at(-1)).toBe(route.distance_mi);
    expect(route.cumulative_s.at(-1)).toBe(route.duration_s);
    expect(route.cumulative_s[0]).toBe(0);
  }
}

describe("recorded trips", () => {
  it("ships real geometry with provenance for every sample it came from", () => {
    expect(TRIPS_DATA.provenance.samples).toHaveLength(4);
    expect(TRIPS.map((trip) => trip.id)).toEqual(["slc-den", "chi-den", "newark-jc"]);
    for (const trip of TRIPS) expect(trip.routes).toHaveLength(3);
  });

  it("decodes SLC-Denver to the provider's real distances and endpoints", () => {
    const trip = TRIPS.find((candidate) => candidate.id === "slc-den");
    expect(trip?.routes.map((route) => route.distanceMi)).toEqual([537.1, 491.8, 525.9]);
    for (const route of trip?.routes ?? []) {
      const [lon, lat] = route.coords[0] ?? [0, 0];
      expect(Math.abs(lat - 40.76)).toBeLessThan(0.05);
      expect(Math.abs(lon + 111.89)).toBeLessThan(0.05);
      expect(route.coords.length).toBeGreaterThan(500);
    }
  });

  it("finds a trip within 30 miles of the recorded endpoints and nothing else", () => {
    expect(findTrip(place("Salt Lake City"), place("Denver"))?.id).toBe("slc-den");
    expect(findTrip(place("Seattle"), place("Denver"))).toBeUndefined();
  });

  it("interpolates linearly, clamped, and tolerates repeated x values", () => {
    expect(interpolateLinear([0, 10], [0, 100], 5)).toBe(50);
    expect(interpolateLinear([0, 10], [0, 100], -5)).toBe(0);
    expect(interpolateLinear([0, 10], [0, 100], 99)).toBe(100);
    expect(interpolateLinear([0, 0, 10], [0, 5, 15], 0)).toBe(0);
  });

  it("searches the geocode catalog by label, prefix matches first, within the limit", () => {
    expect(searchGeocode("den", 5)[0]?.name).toBe("Denver");
    expect(searchGeocode("new", 5).map((entry) => entry.name)).toEqual(["Newark", "Jersey City"]);
    expect(searchGeocode("a", 2)).toHaveLength(2);
    expect(searchGeocode("zzz", 5)).toEqual([]);
  });
});

describe("scenarios", () => {
  it("lists the five fixtures the card names", () => {
    expect(SCENARIO_IDS).toEqual([
      "calm",
      "mixed",
      "severe-on-fastest",
      "no-safe-route",
      "partial-unknown",
    ]);
    expect(SCENARIO_CATALOG.map((scenario) => scenario.id)).toEqual([...SCENARIO_IDS]);
    expect(isScenarioId("calm")).toBe(true);
    expect(isScenarioId("plains-blizzard")).toBe(false);
  });
});

describe("scenario storms", () => {
  it("refuses a trip it has no severe-on-fastest storm for instead of guessing one", () => {
    const [trip] = TRIPS;
    if (!trip) throw new Error("no recorded trip");

    expect(() =>
      createWeatherField("severe-on-fastest", { ...trip, id: "no-such-trip" }, 0),
    ).toThrow('No severe-on-fastest storm is authored for trip "no-such-trip"');
  });
});

describe.each(TRIP_PAIRS)("plans for %s to %s", (from, to) => {
  it.each(SCENARIO_IDS)(
    "satisfies every contract invariant in scenario %s (all intervals)",
    (scenario) => {
      for (const interval of [10, 25, 50] as const) {
        expectPlanInvariants(
          buildPlan(request(from, to, { scenario, sampling_interval_mi: interval })),
        );
      }
    },
  );

  it("is deterministic and idempotent for an identical request", () => {
    const first = buildPlan(request(from, to));
    expect(buildPlan(request(from, to))).toEqual(first);
    expect(buildPlan(request(from, to, { load_weight_lb: 1000 })).plan_id).not.toBe(first.plan_id);
  });
});

describe("scenario semantics on Salt Lake City to Denver", () => {
  const levels = (plan: ReturnType<typeof buildPlan>): (RiskLevel | null)[] =>
    plan.routes.flatMap((route) => route.checkpoints.map((checkpoint) => checkpoint.risk.level));

  it("calm: every checkpoint of every route is Low", () => {
    expect(new Set(levels(buildPlan(slc("calm"))))).toEqual(new Set(["low"]));
  });

  it("mixed: a real mix of levels, nothing worse than High", () => {
    const seen = new Set(levels(buildPlan(slc("mixed"))));
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect(seen.has("severe") || seen.has("no_travel")).toBe(false);
  });

  it("severe-on-fastest: the fastest route crosses severe miles and a slower route is recommended", () => {
    const plan = buildPlan(slc("severe-on-fastest"));
    const fastest = plan.routes.find((route) => route.route_id === "A");
    expect(fastest?.stats.miles_by_level.severe).toBeGreaterThan(0);
    expect(plan.recommendation.route_id).not.toBe("A");
    expect(plan.routes[0]?.stats.miles_by_level.severe).toBe(0);
    expect(plan.recommendation.status).toBe("ok");
    expect(plan.routes.at(-1)?.route_id).toBe("A");
    const durations = Object.fromEntries(
      plan.routes.map((route) => [route.route_id, route.duration_s]),
    );
    expect(durations[plan.recommendation.route_id]).toBeGreaterThan(durations["A"] ?? 0);
  });

  it("no-safe-route: every route crosses No Travel and the status says so", () => {
    for (const [from, to] of TRIP_PAIRS) {
      const plan = buildPlan(request(from, to, { scenario: "no-safe-route" }));
      expect(plan.recommendation.status).toBe("no_safe_route");
      for (const route of plan.routes)
        expect(route.stats.miles_by_level.no_travel).toBeGreaterThan(0);
      expect(plan.recommendation.warnings).toEqual([]);
    }
  });

  it("partial-unknown: some checkpoints are unknown, flagged incomplete, and the plan warns", () => {
    const plan = buildPlan(slc("partial-unknown"));
    const all = plan.routes.flatMap((route) => route.checkpoints);
    expect(
      all.some(
        (checkpoint) => checkpoint.risk.level === null && checkpoint.weather.wind_mph === null,
      ),
    ).toBe(true);
    expect(
      all.some(
        (checkpoint) =>
          checkpoint.risk.level !== null &&
          checkpoint.risk.incomplete &&
          checkpoint.weather.snow_in_hr === null,
      ),
    ).toBe(true);
    expect(plan.routes.some((route) => route.stats.unknown_mi > 0)).toBe(true);
    expect(plan.warnings.join(" ")).toContain("missing");
    expect(plan.recommendation.warnings.join(" ")).toContain("has no usable weather data for");
  });

  it("the default (no scenario) pretends to be the real forecast; a named one is labelled simulated", () => {
    const real = buildPlan(slc(null));
    expect(real.sources).toMatchObject({ weather: "open-meteo", scenario: null });
    expect(real.warnings).toEqual([]);
    const simulated = buildPlan(slc("calm"));
    expect(simulated.sources).toMatchObject({ weather: "scenario", scenario: "calm" });
    expect(simulated.sources.attribution.join(" ")).toContain("Simulated weather");
    expect(simulated.warnings).toContain(SCENARIO_NOTICE);
  });

  // R4-11: the mock wrote the UI's title ("Simulated weather. Not a forecast.") where the API writes
  // its own sentence, so the page's dedupe, which matched the title, passed against the mock and
  // showed the notice twice against the real backend.
  describe("the words are the backend's", () => {
    const backend = (path: string): string =>
      readFileSync(resolve(import.meta.dirname, "../../../../backend", path), "utf8");

    it("says the scenario notice of the reviewed snapshot of a scenario plan", () => {
      const golden = JSON.parse(
        backend(
          "tests/plans/__snapshots__/test_golden/test_short_trip_plan_matches_the_reviewed_snapshot.json",
        ),
      ) as { warnings: string[] };

      expect(golden.warnings).toContain(SCENARIO_NOTICE);
      expect(buildPlan(slc("calm")).warnings).toContain(SCENARIO_NOTICE);
    });

    it("describes a route with checkpoints without weather in the backend's sentence", () => {
      const source = backend("src/haulcast/services/plan_assembly.py");
      expect(source).toContain("weather is missing at {unknown} of {total} checkpoints");
      expect(source).toContain("that stretch's risk is shown as unknown.");

      const gaps = buildPlan(slc("partial-unknown")).warnings.filter(
        (warning) => warning !== SCENARIO_NOTICE,
      );

      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) {
        expect(gap).toMatch(
          /^Route [A-C]: weather is missing at \d+ of \d+ checkpoints \(\d+\.\d mi\); that stretch's risk is shown as unknown\.$/u,
        );
      }
    });

    // R5-03: every other warning, notice and attribution that the mock can say is a sentence of the
    // backend, the variable parts of a sentence apart (they are named placeholders). The golden
    // plans are scenario plans without gaps, so a sentence that no snapshot holds is compared with
    // the backend source that writes it: that is the class table below.
    describe("every warning, notice and attribution is a sentence of the backend", () => {
      const placeholders = (sentence: string): string =>
        sentence
          .replace(/\bRoute [A-C]\b/gu, "{route}")
          .replace(/\d{1,3}(?:,\d{3})*\.\d%/gu, "{share}")
          .replace(/(?:less than )?\d{1,3}(?:,\d{3})*\.\d\b/gu, "{mi}")
          .replace(/\b\d+\b/gu, "{n}");

      type Field = "warnings" | "attribution";

      /**
       * What a sentence is compared by. A warning or a notice is compared with its variable parts named
       * (labels, miles, shares). An attribution is compared as it is: its numbers are not variable, the
       * version of a licence ("CC BY 4.0") is part of what it says.
       */
      const compared = (field: Field, sentence: string): string =>
        field === "attribution" ? sentence : placeholders(sentence);

      interface Source {
        readonly file: string;
        readonly field: Field;
        readonly fragments: readonly string[];
        readonly examples: readonly string[];
      }

      const SNAPSHOT_DIRS = [
        "tests/plans/__snapshots__/test_golden",
        "tests/domain/__snapshots__/test_golden",
      ];

      /** Sentences that no snapshot holds: the backend file that writes them, and an example each. */
      const SOURCES: readonly Source[] = [
        {
          file: "src/haulcast/services/plan_assembly.py",
          field: "warnings",
          fragments: [
            "weather is missing at ",
            " of ",
            " checkpoints ",
            "that stretch's risk is shown as unknown.",
          ],
          examples: [
            "Route A: weather is missing at 3 of 8 checkpoints (4.2 mi); that stretch's risk is shown as unknown.",
          ],
        },
        {
          file: "src/haulcast/domain/scoring.py",
          field: "warnings",
          fragments: [
            " has no usable weather data for ",
            " of its ",
            " miles",
            "; its risk may be understated.",
          ],
          examples: [
            "Route A has no usable weather data for 3.5 of its 120.0 miles; its risk may be understated.",
            "Route A has no usable weather data for 30.0 of its 100.0 miles (30.0%); its risk may be understated.",
          ],
        },
        {
          file: "src/haulcast/providers/weather/openmeteo.py",
          field: "attribution",
          fragments: ["Weather data by Open-Meteo.com (CC BY 4.0)"],
          examples: ["Weather data by Open-Meteo.com (CC BY 4.0)"],
        },
      ];

      /** The weather source names that no snapshot holds (a real forecast), and where they are set. */
      const TAG_SOURCE = {
        file: "src/haulcast/providers/weather/openmeteo.py",
        fragments: ['name: str = "open-meteo"', 'MODEL: Final = "best_match"'],
        tags: ["open-meteo", "best_match"],
      };

      function goldenWords(): { sentences: Set<string>; tags: Set<string> } {
        const sentences = new Set<string>();
        const tags = new Set<string>();
        const walk = (value: unknown, key: string): void => {
          if (Array.isArray(value)) {
            for (const item of value as unknown[]) {
              if (typeof item === "string" && (key === "warnings" || key === "attribution")) {
                sentences.add(compared(key, item));
              } else {
                walk(item, key);
              }
            }
          } else if (typeof value === "object" && value !== null) {
            for (const [name, child] of Object.entries(value)) {
              if (
                key === "sources" &&
                /^weather(_model)?$/u.test(name) &&
                typeof child === "string"
              ) {
                tags.add(child);
              }
              walk(child, name);
            }
          }
        };
        for (const dir of SNAPSHOT_DIRS) {
          const folder = resolve(import.meta.dirname, "../../../../backend", dir);
          for (const file of readdirSync(folder).filter((name) => name.endsWith(".json"))) {
            walk(JSON.parse(backend(`${dir}/${file}`)) as unknown, "");
          }
        }
        return { sentences, tags };
      }

      const rankCandidate = (
        id: string,
        overrides: Partial<RankCandidate> = {},
      ): RankCandidate => ({
        routeId: id,
        label: `Route ${id}`,
        durationS: 3600,
        distanceMi: 100,
        noTravelMi: 0,
        severeMi: 0,
        highMi: 0,
        avgRisk: 0,
        unknownMi: 0,
        ...overrides,
      });

      /** Everything the mock can say, each sentence compared by its kind: every scenario, and rankings that reach each warning. */
      function mockWords(): { sentences: string[]; tags: string[] } {
        const plans = [null, ...SCENARIO_IDS].map((scenario) => buildPlan(slc(scenario)));
        const rankings = [
          rankRoutes([rankCandidate("A", { noTravelMi: 4, unknownMi: 2 })]),
          rankRoutes([
            rankCandidate("A", { unknownMi: 30 }),
            rankCandidate("B", { unknownMi: 12, durationS: 7200 }),
          ]),
          rankRoutes([rankCandidate("A", { unknownMi: 0.01 })]),
        ];
        const warnings = [
          ...plans.flatMap((plan) => [...plan.warnings, ...plan.recommendation.warnings]),
          ...rankings.flatMap((ranking) => ranking.warnings),
        ];
        const attribution = plans.flatMap((plan) => plan.sources.attribution);
        return {
          sentences: [
            ...warnings.map((sentence) => compared("warnings", sentence)),
            ...attribution.map((sentence) => compared("attribution", sentence)),
          ],
          tags: plans.flatMap((plan) => [plan.sources.weather, plan.sources.weather_model]),
        };
      }

      it("says only sentences that a snapshot or the backend source holds", () => {
        const golden = goldenWords();
        const known = new Set([
          ...golden.sentences,
          ...SOURCES.flatMap((source) =>
            source.examples.map((example) => compared(source.field, example)),
          ),
        ]);
        const said = mockWords();

        const missing = [...new Set(said.sentences)].filter((sentence) => !known.has(sentence));

        expect(missing).toEqual([]);
      });

      it("names its weather source and model as the backend does", () => {
        const golden = goldenWords();
        const said = mockWords();

        const knownTags = new Set([...golden.tags, ...TAG_SOURCE.tags]);

        expect([...new Set(said.tags)].filter((tag) => !knownTags.has(tag))).toEqual([]);
      });

      it("says each kind of sentence, so that the check above is not empty", () => {
        const said = new Set(mockWords().sentences);
        const kinds = [
          ...SOURCES.flatMap((source) =>
            source.examples.map((example) => compared(source.field, example)),
          ),
          compared("warnings", SCENARIO_NOTICE),
          compared("attribution", "© OpenStreetMap contributors"),
        ];

        expect(kinds.filter((kind) => !said.has(kind))).toEqual([]);
      });

      it("compares an attribution as it is: another licence version is not the backend's", () => {
        const licence = (version: string): string =>
          `Weather data by Open-Meteo.com (CC BY ${version})`;

        expect(compared("attribution", licence("5.0"))).not.toBe(
          compared("attribution", licence("4.0")),
        );
        // The twin: warnings that differ only in a label and a number are the same sentence.
        const gap = (route: string, mi: string): string =>
          `Route ${route} has no usable weather data for ${mi} of its 120.0 miles; its risk may be understated.`;
        expect(compared("warnings", gap("A", "3.5"))).toBe(compared("warnings", gap("B", "7.0")));
      });

      it("takes the sentences and the names that no snapshot holds from the backend source", () => {
        for (const source of SOURCES) {
          const text = backend(source.file);
          for (const fragment of source.fragments) {
            expect(text, `${source.file} no longer has ${fragment}`).toContain(fragment);
          }
        }
        const text = backend(TAG_SOURCE.file);
        for (const fragment of TAG_SOURCE.fragments) {
          expect(text, `${TAG_SOURCE.file} no longer has ${fragment}`).toContain(fragment);
        }
      });
    });
  });

  it("applies the load rules: a heavy load escalates wind that a light load survives", () => {
    // `mixed` never gets windy enough for a load rule at any spacing, so this uses the violent wind
    // cell of `no-safe-route`: its fringe is 35-54 mph, where only a heavy load is escalated.
    const heavy = buildPlan(slc("no-safe-route", { load_weight_lb: 80000 }));
    const light = buildPlan(slc("no-safe-route", { load_weight_lb: 0 }));
    const rules = (plan: typeof heavy): (string | null)[] =>
      plan.routes.flatMap((route) =>
        route.checkpoints.map((checkpoint) => checkpoint.risk.load_rule),
      );
    expect(rules(light).every((rule) => rule === null)).toBe(true);
    expect(heavy.routes.length).toBe(3);
    expect(rules(heavy).some((rule) => rule !== null)).toBe(true);
  });

  it("uses the requested creation time and a seven-day expiry", () => {
    const plan = buildPlan(slc("calm"), { createdAt: "2026-10-20T13:00:00Z" });
    expect(plan.created_at).toBe("2026-10-20T13:00:00Z");
    expect(plan.expires_at).toBe("2026-10-27T13:00:00Z");
    expect(buildPlan(slc("calm")).created_at).toBe("2026-10-20T13:55:00Z");
  });

  it("holds for any interval, load and scenario (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(10, 25, 50),
        fc.integer({ min: 0, max: 80000 }),
        fc.constantFrom(...SCENARIO_IDS),
        (interval, load, scenario) => {
          expectPlanInvariants(
            buildPlan(slc(scenario, { sampling_interval_mi: interval, load_weight_lb: load })),
          );
        },
      ),
      { numRuns: 12 },
    );
  });
});

describe.each(TRIP_PAIRS)("severe-on-fastest from %s to %s", (from, to) => {
  const DEPARTURES = ["2026-10-20T14:00:00Z", "2026-10-20T14:37:00Z", "2026-10-20T14:59:00Z"];

  it.each(SAMPLING_INTERVALS_MI)(
    "hits the fastest route and recommends a slower one at %i-mile spacing",
    (interval) => {
      for (const departureTime of DEPARTURES) {
        const plan = buildPlan(
          request(from, to, {
            scenario: "severe-on-fastest",
            sampling_interval_mi: interval,
            departure_time: departureTime,
          }),
        );
        const fastest = plan.routes.reduce((best, route) =>
          route.duration_s < best.duration_s ? route : best,
        );
        const recommended = plan.routes[0];

        expect(fastest.stats.miles_by_level.severe).toBeGreaterThan(0);
        expect(fastest.stats.miles_by_level.no_travel).toBe(0);
        expect(plan.recommendation.status).toBe("ok");
        expect(fastest.recommended).toBe(false);
        expect(plan.recommendation.route_id).not.toBe(fastest.route_id);
        expect(recommended?.duration_s).toBeGreaterThan(fastest.duration_s);
        expect(recommended?.stats.miles_by_level.severe).toBeLessThan(
          fastest.stats.miles_by_level.severe,
        );
      }
    },
  );
});

describe("plan rejections", () => {
  it("names the reason a request cannot be answered", () => {
    expect(() => buildPlan(slc("plains-blizzard" as ScenarioId))).toThrow(
      new FixtureError("unknown_scenario", 'Unknown scenario "plains-blizzard"'),
    );
    expect(() => buildPlan(request("Denver", "Denver"))).toThrow(FixtureError);
    expect(() => buildPlan(request("Seattle", "Phoenix"))).toThrow(/no recorded route/);
    try {
      buildWorld(request("Seattle", "Phoenix"));
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureError);
      expect((error as FixtureError).code).toBe("no_route_found");
    }
  });
});

describe("helpers", () => {
  it("checkpoint distances follow the interval and end at the destination without a near-duplicate", () => {
    expect(checkpointDistances(100, 25)).toEqual([0, 25, 50, 75, 100]);
    expect(checkpointDistances(100.005, 25)).toEqual([0, 25, 50, 75, 100.005]);
    expect(checkpointDistances(8.9, 25)).toEqual([0, 8.9]);
    expect(checkpointDistances(537.1, 50)).toHaveLength(12);
  });

  it("derives well-formed deterministic plan ids and a contract idempotency key", () => {
    expect(isPlanId(mockPlanId("a"))).toBe(true);
    expect(mockPlanId("a")).toBe(mockPlanId("a"));
    expect(mockPlanId("a")).not.toBe(mockPlanId("b"));
    expect(idempotencyKey(slc(null))).toContain("2026-10-20T14:00|38000|25|null");
    expect(idempotencyKey(slc("calm"))).toContain("|calm");
  });

  it("maps longitude to US time zones and computes DST-aware offsets", () => {
    expect(usZone(-120)).toBe("America/Los_Angeles");
    expect(usZone(-111.9)).toBe("America/Denver");
    expect(usZone(-90)).toBe("America/Chicago");
    expect(usZone(-74)).toBe("America/New_York");
    expect(utcOffsetSeconds("America/Denver", Date.parse("2026-10-20T14:00:00Z"))).toBe(-21600);
    expect(utcOffsetSeconds("America/Denver", Date.parse("2026-11-02T14:00:00Z"))).toBe(-25200);
    expect(utcOffsetSeconds("UTC", Date.parse("2026-10-20T14:00:00Z"))).toBe(0);
  });

  it("rounds an instant up to the next hour and leaves exact hours alone", () => {
    expect(ceilToHour(Date.parse("2026-10-20T14:00:01Z"))).toBe(Date.parse("2026-10-20T15:00:00Z"));
    expect(ceilToHour(Date.parse("2026-10-20T14:00:00Z"))).toBe(Date.parse("2026-10-20T14:00:00Z"));
  });

  it("encodes unknown risk as -1 in the heatmap", () => {
    expect(heatmapRiskValue(null)).toBe(-1);
    expect(heatmapRiskValue("severe")).toBe(3);
  });

  it("summarises a route whose weather is entirely unknown", () => {
    const unknown = (index: number): Checkpoint => {
      const plan = buildPlan(slc("calm"));
      const checkpoint = plan.routes[0]?.checkpoints[0];
      if (!checkpoint) throw new Error("no checkpoint");
      return { ...checkpoint, index, owned_mi: 10, risk: { ...checkpoint.risk, level: null } };
    };
    expect(summarizeCheckpoints([unknown(0), unknown(1)])).toEqual({
      miles_by_level: { low: 0, moderate: 0, high: 0, severe: 0, no_travel: 0 },
      unknown_mi: 20,
      avg_risk: null,
      max_level: null,
    });
  });
});

describe("risk assessment", () => {
  const weather = (wind: number | null, rain: number | null, snow: number | null) => ({
    valid_time: "2026-10-20T14:00:00Z",
    wind_mph: wind,
    gust_mph: null,
    rain_in_hr: rain,
    snow_in_hr: snow,
    temperature_f: null,
    weather_code: null,
  });

  it("takes the worst known factor and explains each one", () => {
    const risk = assessWeather(weather(12.3, 0.3, 0), 38000);
    expect(risk.level).toBe("high");
    expect(risk.factors).toEqual({ wind: "low", rain: "high", snow: "low" });
    expect(risk.reasons).toEqual([
      "Wind 12.3 mph (Low)",
      "Rain 0.300 in/hr (High)",
      "Snow 0.000 in/hr (Low)",
    ]);
    expect(risk.incomplete).toBe(false);
    expect(risk.load_rule).toBeNull();
  });

  it("escalates wind by load exactly as LR-2 and LR-3 say (strict greater-than)", () => {
    expect(assessWeather(weather(47, 0, 0), 38000)).toMatchObject({
      level: "no_travel",
      load_rule: "LR-2",
    });
    expect(assessWeather(weather(47, 0, 0), 38000).reasons.at(-1)).toBe(
      "Load 38,000 lb > 30,000 lb escalates to No Travel (LR-2)",
    );
    expect(assessWeather(weather(47, 0, 0), 30000)).toMatchObject({
      level: "severe",
      load_rule: null,
    });
    expect(assessWeather(weather(40, 0, 0), 40001)).toMatchObject({
      level: "severe",
      load_rule: "LR-3",
    });
    expect(assessWeather(weather(40, 0, 0), 40000)).toMatchObject({
      level: "high",
      load_rule: null,
    });
    expect(assessWeather(weather(60, 0, 0), 0)).toMatchObject({
      level: "no_travel",
      load_rule: null,
    });
  });

  it("marks missing factors and a fully unknown checkpoint", () => {
    expect(assessWeather(weather(10, 0, null), 0)).toMatchObject({
      level: "low",
      incomplete: true,
    });
    expect(assessWeather(weather(10, 0, null), 0).reasons.at(-1)).toBe("Snow data unavailable");
    expect(assessWeather(weather(null, null, null), 0)).toMatchObject({
      level: null,
      incomplete: true,
      load_rule: null,
    });
  });

  it("describes a load rule that has no load threshold", () => {
    const rules = riskRulesSchema.parse({
      ...structuredClone(RISK_RULES),
      factors: {
        ...structuredClone(RISK_RULES.factors),
        wind: {
          ...structuredClone(RISK_RULES.factors.wind),
          bands: [
            { level: "low", max_exclusive: 25 },
            { level: "moderate", min_inclusive: 25 },
            { level: "high", min_inclusive: 1000 },
            { level: "severe", min_inclusive: 1001 },
            { level: "no_travel", min_inclusive: 1002 },
          ],
        },
      },
    });
    const risk = assessWeather(weather(60, 0, 0), 0, rules);
    expect(risk).toMatchObject({ level: "no_travel", load_rule: "LR-1" });
    expect(risk.reasons.at(-1)).toBe("Load 0 lb escalates to No Travel (LR-1)");
    expect(riskOrdinal("no_travel")).toBe(4);
  });

  it("applies the strongest rule when several fire together, whatever their order", () => {
    const stricter = {
      id: "LR-X",
      factor: "wind",
      min_inclusive: 35,
      max_exclusive: 45,
      load_lb_min_exclusive: 50000,
      result: "no_travel",
      brief_text: "35–44 mph + >50,000 lb → No Travel",
    };
    const lr3 = RISK_RULES.load_rules.filter((rule) => rule.id === "LR-3");
    expect(lr3).toHaveLength(1);
    const withLoadRules = (loadRules: readonly unknown[]): RiskRules =>
      riskRulesSchema.parse({ ...structuredClone(RISK_RULES), load_rules: loadRules });

    for (const loadRules of [
      [...lr3, stricter],
      [stricter, ...lr3],
    ]) {
      // 40 mph is High on its own; at 60,000 lb both LR-3 (Severe) and LR-X (No Travel) fire.
      expect(assessWeather(weather(40, 0, 0), 60000, withLoadRules(loadRules))).toMatchObject({
        level: "no_travel",
        load_rule: "LR-X",
      });
      // At 45,000 lb only LR-3 fires.
      expect(assessWeather(weather(40, 0, 0), 45000, withLoadRules(loadRules))).toMatchObject({
        level: "severe",
        load_rule: "LR-3",
      });
    }
  });
});

describe("ranking", () => {
  const candidate = (id: string, overrides: Partial<RankCandidate> = {}): RankCandidate => ({
    routeId: id,
    label: `Route ${id}`,
    durationS: 3600,
    distanceMi: 100,
    noTravelMi: 0,
    severeMi: 0,
    highMi: 0,
    avgRisk: 0,
    unknownMi: 0,
    ...overrides,
  });

  it("orders by no-travel, severe, high miles, average risk, then duration, then input order", () => {
    expect(rankRoutes([candidate("A", { severeMi: 5 }), candidate("B")]).order).toEqual(["B", "A"]);
    expect(
      rankRoutes([candidate("A", { noTravelMi: 1 }), candidate("B", { severeMi: 50 })]).order,
    ).toEqual(["B", "A"]);
    expect(rankRoutes([candidate("A", { highMi: 3 }), candidate("B")]).decidedBy).toBe("high_mi");
    expect(
      rankRoutes([candidate("A", { avgRisk: 0.5 }), candidate("B", { avgRisk: 0.2 })]).order,
    ).toEqual(["B", "A"]);
    expect(rankRoutes([candidate("A", { avgRisk: null }), candidate("B")]).order).toEqual([
      "B",
      "A",
    ]);
    expect(rankRoutes([candidate("A", { durationS: 7200 }), candidate("B")]).decidedBy).toBe(
      "duration_s",
    );
  });

  it("is a tie, in input order, when two routes match on every key", () => {
    const tied = rankRoutes([candidate("A"), candidate("B")]);
    expect(tied).toMatchObject({ order: ["A", "B"], decidedBy: "tie", status: "ok" });
  });

  it("answers only_route for a single route, however risky: there is nothing to compare", () => {
    expect(rankRoutes([candidate("A")])).toMatchObject({
      order: ["A"],
      decidedBy: "only_route",
      status: "ok",
      warnings: [],
    });
    expect(rankRoutes([candidate("A", { noTravelMi: 4 })])).toMatchObject({
      decidedBy: "only_route",
      status: "no_safe_route",
    });
  });

  it("refuses to rank no routes, as the domain does", () => {
    expect(() => rankRoutes([])).toThrow("at least one route is needed to rank");
  });

  it.each([
    ["no_travel_mi", { noTravelMi: 1 }],
    ["severe_mi", { severeMi: 1 }],
    ["high_mi", { highMi: 1 }],
    ["avg_risk", { avgRisk: 0.5 }],
    ["duration_s", { durationS: 7200 }],
  ] as const)("decides by %s when it is the first key on which two routes differ", (key, worse) => {
    const ranking = rankRoutes([candidate("A", worse), candidate("B")]);
    expect(ranking).toMatchObject({ order: ["B", "A"], decidedBy: key });
  });

  it("stops at the first differing key, whatever the later keys say", () => {
    const ranking = rankRoutes([
      candidate("A", { severeMi: 5, highMi: 0 }),
      candidate("B", { severeMi: 0, highMi: 9 }),
    ]);
    expect(ranking).toMatchObject({ order: ["B", "A"], decidedBy: "severe_mi" });
  });

  it("decides by the first key on which the top two differ: only_route alone, tie when none does", () => {
    // DOMAIN-CONTRACT section 8, restated as an oracle on raw fields. Two values per field keep
    // the routes colliding often, so ties and every deciding key turn up.
    const keys = [
      ["no_travel_mi", "noTravelMi"],
      ["severe_mi", "severeMi"],
      ["high_mi", "highMi"],
      ["avg_risk", "avgRisk"],
      ["duration_s", "durationS"],
    ] as const;
    const route = fc.record({
      noTravelMi: fc.constantFrom(0, 5),
      severeMi: fc.constantFrom(0, 5),
      highMi: fc.constantFrom(0, 5),
      avgRisk: fc.constantFrom(null, 0.5),
      durationS: fc.constantFrom(600, 1200),
    });
    fc.assert(
      fc.property(fc.array(route, { minLength: 1, maxLength: 4 }), (routes) => {
        const candidates = routes.map((fields, index) => candidate(`R${String(index)}`, fields));
        const ranking = rankRoutes(candidates);
        const [first, second] = ranking.order.map((routeId) =>
          candidates.find((entry) => entry.routeId === routeId),
        );
        const expected =
          first && second
            ? (keys.find(([, field]) => first[field] !== second[field])?.[0] ?? "tie")
            : "only_route";
        expect(ranking.decidedBy).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("builds a single-route plan that the contract accepts", () => {
    const plan = buildPlan(slc("calm"));
    const [route] = plan.routes;
    if (!route) throw new Error("the fixture plan has no routes");
    const ranking = rankRoutes([
      candidate(route.route_id, {
        durationS: route.duration_s,
        noTravelMi: route.stats.miles_by_level.no_travel,
        severeMi: route.stats.miles_by_level.severe,
        highMi: route.stats.miles_by_level.high,
        avgRisk: route.stats.avg_risk,
        unknownMi: route.stats.unknown_mi,
      }),
    ]);
    const single = {
      ...plan,
      routes: [route],
      recommendation: {
        route_id: route.route_id,
        status: ranking.status,
        decided_by: ranking.decidedBy,
        rationale: ranking.rationale,
        warnings: ranking.warnings,
      },
    };

    expect(single.recommendation.decided_by).toBe("only_route");
    expect(planSchema.safeParse(single).success).toBe(true);
  });

  it("states the time trade-off against the fastest option and the no-travel warning", () => {
    const ranking = rankRoutes([
      candidate("A", { noTravelMi: 4, durationS: 3600 }),
      candidate("B", { noTravelMi: 2, durationS: 5000 }),
    ]);
    expect(ranking.status).toBe("no_safe_route");
    expect(ranking.rationale[0]).toContain("Route B is recommended");
    expect(ranking.rationale[0]).toContain("+23 min vs the fastest option");
    expect(ranking.rationale[1]).toContain("Route A ranks #2");
    expect(ranking.rationale[1]).toContain("the fastest option");
    expect(ranking.warnings).toEqual([]);
  });
});

describe("heatmaps", () => {
  it.each(TRIP_PAIRS)(
    "%s to %s: a valid 49-frame field over at most 200 lattice-aligned cells",
    (from, to) => {
      for (const scenario of SCENARIO_IDS) {
        const plan = buildPlan(request(from, to, { scenario }));
        const heatmap = buildHeatmap(plan);
        expect(heatmapSchema.safeParse(heatmap).success).toBe(true);
        expect(heatmap.cells.length).toBeGreaterThan(0);
        expect(heatmap.cells.length).toBeLessThanOrEqual(200);
        expect(heatmap.fields.risk).toHaveLength(49 * heatmap.cells.length);
        expect(Math.round(heatmap.grid.dlat * 10) / 10).toBe(heatmap.grid.dlat);
        expect(heatmap.grid.dlat).toBeGreaterThanOrEqual(0.2);
        expect(heatmap.grid.dlat).toBe(heatmap.grid.dlon);
        expect(Math.round(heatmap.grid.lat0 * 10) / 10).toBe(heatmap.grid.lat0);
        expect(heatmap.plan_id).toBe(plan.plan_id);
        expect(heatmap.load_weight_lb).toBe(38000);
      }
    },
  );

  it("anchors the grid at its south-west corner and samples every cell at its centre", () => {
    // The README documents this reading of `grid.lat0` / `grid.lon0` (the contract is silent).
    const plan = buildPlan(slc("severe-on-fastest"));
    const heatmap = buildHeatmap(plan);
    const world = buildWorld(plan.request);
    const { lat0, lon0, dlat, dlon, cols } = heatmap.grid;
    const frame = 8;

    expect(heatmap.cells.length).toBeGreaterThan(0);
    heatmap.cells.forEach((cell, position) => {
      const row = Math.floor(cell / cols);
      const col = cell % cols;
      const sampled = world.field(lat0 + (row + 0.5) * dlat, lon0 + (col + 0.5) * dlon, frame);
      const index = frame * heatmap.cells.length + position;
      expect(heatmap.fields.wind_mph[index]).toBeCloseTo(sampled.wind_mph, 1);
      expect(heatmap.fields.snow_in_hr[index]).toBeCloseTo(sampled.snow_in_hr, 2);
    });
  });

  it("starts at the departure hour and carries the plan's sources", () => {
    const plan = buildPlan(slc("mixed", { departure_time: "2026-10-20T14:35:00Z" }));
    const heatmap = buildHeatmap(plan);
    expect(heatmap.start_time).toBe("2026-10-20T14:00:00Z");
    expect(heatmap.sources).toEqual(plan.sources);
    expect(heatmap.generated_at).toBe(plan.created_at);
  });

  it("holds all five fields, with a storm that moves between frames", () => {
    const heatmap = buildHeatmap(buildPlan(slc("severe-on-fastest")));
    const cellCount = heatmap.cells.length;
    const severeAt = (frame: number): number[] =>
      heatmap.fields.risk
        .slice(frame * cellCount, (frame + 1) * cellCount)
        .flatMap((value, cell) => (value >= 3 ? [cell] : []));
    expect(severeAt(8).length).toBeGreaterThan(0);
    expect(severeAt(8)).not.toEqual(severeAt(40));
    expect(
      Math.max(...heatmap.fields.snow_in_hr.filter((value): value is number => value !== null)),
    ).toBeGreaterThan(2);
    expect(
      Math.max(...heatmap.fields.wind_mph.filter((value): value is number => value !== null)),
    ).toBeGreaterThan(5);
    expect(heatmap.fields.gust_mph.length).toBe(heatmap.fields.rain_in_hr.length);
  });

  it("partial-unknown hides some cells (risk -1, null values); other scenarios hide none", () => {
    const partial = buildHeatmap(buildPlan(slc("partial-unknown")));
    expect(partial.fields.risk).toContain(-1);
    expect(partial.fields.wind_mph).toContain(null);
    const calm = buildHeatmap(buildPlan(slc("calm")));
    expect(calm.fields.risk).not.toContain(-1);
    expect(new Set(calm.fields.risk)).toEqual(new Set([0]));
  });

  it("is deterministic", () => {
    const plan = buildPlan(slc("mixed"));
    expect(buildHeatmap(plan)).toEqual(buildHeatmap(plan));
  });
});
