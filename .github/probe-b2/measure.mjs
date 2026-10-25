// B2 (R4F-B2, D-51): the bundle numbers of one build, as JSON.
//
// The closure logic is K7B's routes.mjs / closure.mjs / cmpclosure.mjs (.planning/evidence/r4f/k7b),
// which K7B and SGN validated against CI to the byte: for a page, the files it downloads are the
// static import closure of the entry chunk, the manifest and the route modules that React Router's
// manifest lists, each sized the way the repo sizes a script (node:zlib gzipSync, level 6).
// "input" = the `/` page plus the static closure of the PlannerApp chunk (the planner after one
// input, the K3 number). "section" / "all" are the two /design pages (the K7 numbers).
//
// usage: node measure.mjs ASSETS_DIR OUT_JSON
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [dir, outFile] = process.argv.slice(2);
const names = readdirSync(dir).filter((name) => name.endsWith(".js"));
const body = new Map(names.map((name) => [name, readFileSync(join(dir, name))]));
const text = (name) => body.get(name).toString("utf8");
const stem = (name) => name.replace(/-[A-Za-z0-9_-]{8}\.js$/, "");
const byStem = (wanted) => names.filter((name) => stem(name) === wanted);

const staticImports = (name) => [
  ...new Set([...text(name).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => m[1])),
].filter((file) => body.has(file));
const dynamicImports = (name) => [
  ...new Set([...text(name).matchAll(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)].map((m) => m[1])),
].filter((file) => body.has(file));

function closure(starts) {
  const seen = new Set();
  const queue = [...starts];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...staticImports(name));
  }
  return seen;
}

const manifestName = names.find((name) => name.startsWith("manifest-"));
const manifestText = manifestName ? text(manifestName) : "";
const assetsOf = (chunk) =>
  [...chunk.matchAll(/\/assets\/([^"']+\.js)/g)].map((m) => m[1]).filter((file) => body.has(file));
const entryBlock = manifestText.match(/"entry":\{[^}]*\}/)?.[0] ?? "";
const routeBlocks = Object.fromEntries(
  [...manifestText.matchAll(/"(routes\/[\w-]+|root)":\{[^}]*\}/g)].map((m) => [m[1], m[0]]),
);
const fromBlocks = (...blocks) =>
  closure([manifestName, ...assetsOf(entryBlock), ...blocks.flatMap((block) => assetsOf(block))]);

/** gzip level 6 of every file; rows keyed by the name without the content hash ("#2" for a repeat). */
function sized(files) {
  const rows = {};
  let total = 0;
  for (const name of [...files].sort()) {
    const gz = gzipSync(body.get(name), { level: 6 }).length;
    let key = stem(name);
    for (let n = 2; key in rows; n += 1) key = `${stem(name)}#${n}`;
    rows[key] = gz;
    total += gz;
  }
  return { total, count: files.size ?? Object.keys(rows).length, rows };
}

const home = fromBlocks(routeBlocks["root"] ?? "", routeBlocks["routes/home"] ?? "");
const methodology = fromBlocks(routeBlocks["root"] ?? "", routeBlocks["routes/methodology"] ?? "");
const fallback = fromBlocks(routeBlocks["root"] ?? "", routeBlocks["routes/not-found"] ?? "");
const input = new Set([...home, ...closure(byStem("PlannerApp"))]);

const designBase = ["entry.client", "manifest", "root", "design"].flatMap(byStem);
const demos = names.filter((name) => /\.demo-/.test(name));
const section = closure([...designBase, ...byStem("TextField.demo")]);
const all = closure([...designBase, ...demos]);
let grew = true;
while (grew) {
  grew = false;
  for (const name of [...all]) {
    for (const next of dynamicImports(name)) {
      if (!all.has(next)) {
        for (const file of closure([next])) all.add(file);
        grew = true;
      }
    }
  }
}

const pages = {
  home: sized(home),
  methodology: sized(methodology),
  fallback: sized(fallback),
  input: sized(input),
  section: sized(section),
  all: sized(all),
};
const numbers = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.total]));
const counts = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.count]));
// Every script of the build (not only the ones a page loads): R4-23 compares one chunk across builds.
const allChunks = sized(new Set(names)).rows;
const containing = (needle) => names.filter((name) => text(name).includes(needle)).map(stem);
writeFileSync(
  outFile,
  JSON.stringify({ numbers, counts, pages, allChunks, panelOnWide: containing("panelOnWide") }, null, 1),
);
console.log(
  `home ${numbers.home} meth ${numbers.methodology} fallback ${numbers.fallback} input ${numbers.input} ` +
    `(${counts.input} files) section ${numbers.section} all ${numbers.all}`,
);
