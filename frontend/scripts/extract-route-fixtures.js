// Extracts the REAL provider route geometries into the committed fixture data used by the MSW mocks.
//
//   node frontend/scripts/extract-route-fixtures.js <samples-dir> <output.json>
//
// <samples-dir> is `.planning/research/samples/` (local, gitignored research evidence from T1), so this
// is an offline provenance tool: CI never runs it, it only runs against the committed output. Each
// route is decoded (Valhalla polyline6), simplified to the contract's display precision (Douglas-
// Peucker 15 m, 5 decimals), re-encoded as polyline5, and keeps maneuver-level (miles, seconds)
// anchors so the mocks reproduce realistic speed changes along the route.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const TOLERANCE_MI = 0.0093; // 15 m, the contract's simplification tolerance
const MILES_PER_DEGREE = 69.0933;

/** One trip = one origin/destination pair and the sample files its routes come from. */
const TRIPS = [
  {
    id: "slc-den",
    origin: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, Utah, United States" },
    destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
    sources: [{ file: "valhalla-slc-den-truck-alt3.json", trips: [0, 1, 2] }],
  },
  {
    id: "chi-den",
    origin: { lat: 41.8781, lon: -87.6298, label: "Chicago, Illinois, United States" },
    destination: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
    sources: [
      { file: "valhalla-chi-den-truck-alt2.json", trips: [0, 1] },
      { file: "valhalla-force-chi-den-25-loc.json", trips: [0] },
    ],
  },
  {
    id: "newark-jc",
    origin: { lat: 40.7357, lon: -74.1724, label: "Newark, New Jersey, United States" },
    destination: { lat: 40.7178, lon: -74.0431, label: "Jersey City, New Jersey, United States" },
    sources: [{ file: "valhalla-newark-jc-truck-alt2.json", trips: [0, 1, 2] }],
  },
];

function decode(encoded, precision) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const read = () => {
    let result = 0;
    let shift = 0;
    let chunk;
    do {
      chunk = encoded.charCodeAt(index++) - 63;
      result += (chunk % 32) * 2 ** shift;
      shift += 5;
    } while (chunk >= 32);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (index < encoded.length) {
    lat += read();
    lon += read();
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

function write(value) {
  let remaining = value < 0 ? -value * 2 - 1 : value * 2;
  let text = "";
  while (remaining >= 32) {
    text += String.fromCharCode(32 + (remaining % 32) + 63);
    remaining = Math.floor(remaining / 32);
  }
  return text + String.fromCharCode(remaining + 63);
}

function encode(coords, precision) {
  const factor = 10 ** precision;
  let previousLat = 0;
  let previousLon = 0;
  let text = "";
  for (const [lon, lat] of coords) {
    const scaledLat = Math.round(lat * factor);
    const scaledLon = Math.round(lon * factor);
    text += write(scaledLat - previousLat) + write(scaledLon - previousLon);
    previousLat = scaledLat;
    previousLon = scaledLon;
  }
  return text;
}

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Iterative Douglas-Peucker in a local equirectangular projection (miles). */
function simplify(coords, tolerance) {
  const meanLat = coords.reduce((sum, [, lat]) => sum + lat, 0) / coords.length;
  const xScale = Math.cos((meanLat * Math.PI) / 180) * MILES_PER_DEGREE;
  const projected = coords.map(([lon, lat]) => [lon * xScale, lat * MILES_PER_DEGREE]);
  const keep = new Set([0, coords.length - 1]);
  const stack = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const distance = segmentDistance(projected[i], projected[first], projected[last]);
      if (distance > farthestDistance) {
        farthest = i;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return coords.filter((_, i) => keep.has(i));
}

/** "I 80/Dwight D. Eisenhower Highway" -> "I-80"; "I 25 South" -> "I-25 S". */
function shortName(streetNames) {
  const first = (streetNames?.[0] ?? "").split("/")[0].trim();
  return first
    .replace(/^(I|US|CO|NJ|NE|WY|UT|IL|IA)\s+(\d+)/, "$1-$2")
    .replace(/\s+(North|South|East|West)\b/, (_m, d) => ` ${d[0]}`);
}

function summarize(maneuvers) {
  const lengthByName = new Map();
  const firstSeen = new Map();
  maneuvers.forEach((m, index) => {
    const name = shortName(m.street_names);
    if (!/^(I|US|CO|NJ|NE|WY|UT|IL|IA)-\d+/.test(name)) return;
    const base = name.replace(/\s[NSEW]$/, "");
    lengthByName.set(base, (lengthByName.get(base) ?? 0) + m.length);
    if (!firstSeen.has(base)) firstSeen.set(base, index);
  });
  const top = [...lengthByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name);
  top.sort((a, b) => firstSeen.get(a) - firstSeen.get(b));
  return top.length > 0 ? `via ${top.join(", ")}` : "via local roads";
}

function extractRoute(trip, id) {
  const leg = trip.legs[0];
  const coords = simplify(decode(leg.shape, 6), TOLERANCE_MI).map(([lon, lat]) => [
    Math.round(lon * 1e5) / 1e5,
    Math.round(lat * 1e5) / 1e5,
  ]);
  let miles = 0;
  let seconds = 0;
  const anchors = [[0, 0]];
  for (const maneuver of leg.maneuvers) {
    miles += maneuver.length;
    seconds += maneuver.time;
    anchors.push([Math.round(miles * 1e3) / 1e3, Math.round(seconds)]);
  }
  return {
    id,
    summary: summarize(leg.maneuvers),
    distance_mi: Math.round(trip.summary.length * 10) / 10,
    duration_s: Math.round(trip.summary.time),
    polyline5: encode(coords, 5),
    vertices: coords.length,
    anchors,
  };
}

const [samplesDir, outputPath] = process.argv.slice(2);
if (!samplesDir || !outputPath) {
  console.error("usage: node extract-route-fixtures.js <samples-dir> <output.json>");
  process.exit(2);
}

const provenance = [];
const trips = TRIPS.map((definition) => {
  const routes = [];
  for (const source of definition.sources) {
    const raw = readFileSync(`${samplesDir}/${source.file}`);
    provenance.push({ file: source.file, sha256: createHash("sha256").update(raw).digest("hex") });
    const json = JSON.parse(raw.toString("utf8"));
    const all = [json.trip, ...(json.alternates ?? []).map((a) => a.trip)];
    for (const index of source.trips) {
      routes.push(extractRoute(all[index], String.fromCharCode(65 + routes.length)));
    }
  }
  return {
    id: definition.id,
    origin: definition.origin,
    destination: definition.destination,
    routes,
  };
});

const output = {
  provenance: {
    generator: "frontend/scripts/extract-route-fixtures.js",
    provider: "Valhalla public server (costing=truck), recorded by the T1 research card",
    transform: "decode polyline6 -> Douglas-Peucker 15 m -> round 5 decimals -> encode polyline5",
    samples: provenance,
  },
  trips,
};
writeFileSync(outputPath, `${JSON.stringify(output)}\n`);
console.log(
  trips
    .map(
      (t) =>
        `${t.id}: ${t.routes.map((r) => `${r.id} ${r.distance_mi} mi ${r.vertices} vertices`).join(" | ")}`,
    )
    .join("\n"),
);
