/**
 * Design-token generator: turns the W3C DTCG `tokens.json` into CSS custom properties and a typed
 * TypeScript map. It mirrors `.planning/design/scripts/build_tokens.py` (the design seat's own
 * generator) so both produce the same custom properties; `tokens.test.ts` proves the equivalence
 * against a verbatim snapshot of the design seat's output.
 *
 * Naming rule (tokens.json `$extensions`): a custom property is `--` plus the kebab-joined token
 * path, with the tier segment mapped `primitive -> p`, `semantic -> (dropped)`, `component -> c`.
 * `semantic.color.text.primary` becomes `--color-text-primary`.
 *
 * Mode rule: `$value` is the light value; `$extensions["dev.haulcast"].modes.dark` is the dark
 * value. Tokens without it are mode-independent. Dark shadows double their layer alpha.
 */

/** The extension namespace the design seat stores Haulcast-specific token metadata under. */
const EXTENSION_NAMESPACE = "dev.haulcast";

/** Themes a token resolves to. `light` is the base, `dark` the override. */
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Any value that survives a JSON round trip. */
export type Json =
  string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

type JsonObject = Extract<Json, Readonly<Record<string, Json>>>;

/** The tokens as written to `tokens.ts`: every name resolved to a literal, per theme. */
export type ResolvedTokens = Record<Theme, Record<string, Json>>;

/** Result of one generation run. */
export interface GeneratedTokenFiles {
  /** Contents of `tokens.css`. */
  readonly css: string;
  /** Contents of `tokens.ts`. */
  readonly ts: string;
  /** Counts reported by the CLI and the delivery handoff. */
  readonly stats: {
    /** Tokens in the source document (all tiers). */
    readonly tokens: number;
    /** Custom properties in the light (`:root`) block, typography sub-properties included. */
    readonly cssVariables: number;
    /** Custom properties the dark theme overrides. */
    readonly darkOverrides: number;
  };
}

/** Raised for any malformed token document so callers get one catchable, descriptive error type. */
export class TokenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

interface Token {
  readonly path: readonly string[];
  readonly type: string;
  readonly light: Json;
  readonly dark: Json | undefined;
}

type TokenIndex = ReadonlyMap<string, Token>;

const MAX_ALIAS_DEPTH = 20;
const TIER_PREFIX: Readonly<Record<string, readonly string[]>> = {
  primitive: ["p"],
  semantic: [],
  component: ["c"],
};
const TYPOGRAPHY_PROPERTIES = [
  ["fontFamily", "font-family"],
  ["fontSize", "font-size"],
  ["fontWeight", "font-weight"],
  ["letterSpacing", "letter-spacing"],
  ["lineHeight", "line-height"],
] as const;
const SHADOW_GEOMETRY = ["offsetX", "offsetY", "blur", "spread"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJson);
  }
  return isRecord(value) && Object.values(value).every(isJson);
}

function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlias(value: Json | undefined): value is string {
  return typeof value === "string" && value.startsWith("{") && value.endsWith("}");
}

function aliasPath(alias: string): readonly string[] {
  return alias.slice(1, -1).split(".");
}

function isColor(value: Json | undefined): value is JsonObject & { readonly hex: string } {
  return (
    isJsonObject(value) &&
    typeof value["hex"] === "string" &&
    typeof value["colorSpace"] === "string"
  );
}

function isDimension(
  value: Json | undefined,
): value is JsonObject & { readonly value: number; readonly unit: string } {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value["value"] === "number" &&
    typeof value["unit"] === "string"
  );
}

function requireField(object: JsonObject, key: string, owner: string): Json {
  const value = object[key];
  if (value === undefined) {
    throw new TokenError(`${owner} is missing "${key}".`);
  }
  return value;
}

function darkOverride(node: Record<string, unknown>): Json | undefined {
  const extensions = node["$extensions"];
  const namespace = isRecord(extensions) ? extensions[EXTENSION_NAMESPACE] : undefined;
  const modes = isRecord(namespace) ? namespace["modes"] : undefined;
  if (!isRecord(modes) || !("dark" in modes)) {
    return undefined;
  }
  const dark = modes["dark"];
  if (!isJson(dark)) {
    throw new TokenError("A dark-mode override is not a JSON value.");
  }
  return dark;
}

function toToken(path: readonly string[], node: Record<string, unknown>): Token {
  const name = path.join(".");
  const type = node["$type"];
  const value = node["$value"];
  if (typeof type !== "string") {
    throw new TokenError(`Token ${name} has no string $type.`);
  }
  if (!isJson(value)) {
    throw new TokenError(`Token ${name} has a $value that is not a JSON value.`);
  }
  return { path, type, light: value, dark: darkOverride(node) };
}

/** Walks the DTCG tree in document order and returns every token (a node with `$value`). */
function collectTokens(
  group: Record<string, unknown>,
  path: readonly string[],
  into: Token[],
): Token[] {
  for (const [key, child] of Object.entries(group)) {
    if (key.startsWith("$")) {
      continue;
    }
    const childPath = [...path, key];
    if (!isRecord(child)) {
      throw new TokenError(`Expected a token or a group at ${childPath.join(".")}.`);
    }
    if ("$value" in child) {
      into.push(toToken(childPath, child));
    } else {
      collectTokens(child, childPath, into);
    }
  }
  return into;
}

function cssName(path: readonly string[]): string {
  const [tier = "", ...rest] = path;
  const prefix = TIER_PREFIX[tier];
  if (prefix === undefined) {
    throw new TokenError(`Unknown token tier "${tier}" in ${path.join(".")}.`);
  }
  return `--${[...prefix, ...rest].join("-").replaceAll("_", "-")}`;
}

function rawValue(token: Token, mode: Theme): Json {
  return mode === "dark" && token.dark !== undefined ? token.dark : token.light;
}

function resolveValue(value: Json, mode: Theme, index: TokenIndex, depth = 0): Json {
  if (depth > MAX_ALIAS_DEPTH) {
    throw new TokenError("Token alias cycle detected.");
  }
  if (isAlias(value)) {
    const target = index.get(aliasPath(value).join("."));
    if (target === undefined) {
      throw new TokenError(`Unresolved token alias ${value}.`);
    }
    return resolveValue(rawValue(target, mode), mode, index, depth + 1);
  }
  if (isColor(value)) {
    return value.hex;
  }
  if (isDimension(value)) {
    return `${String(value.value)}${value.unit}`;
  }
  if (isJsonArray(value)) {
    return value.map((item) => resolveValue(item, mode, index, depth + 1));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, mode, index, depth + 1)]),
    );
  }
  return value;
}

/** Python-compatible rounding (half to even): the design seat's generator uses `round()`. */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

function scalarCss(value: Json, owner: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new TokenError(`${owner} must be a string, number or boolean.`);
}

function dimensionCss(value: Json | undefined, owner: string): string {
  if (!isDimension(value)) {
    throw new TokenError(`${owner} must be a {value, unit} dimension.`);
  }
  return `${String(value.value)}${value.unit}`;
}

function shadowLayerCss(layer: Json, mode: Theme, index: TokenIndex, owner: string): string {
  if (!isJsonObject(layer) || typeof layer["$alpha"] !== "number") {
    throw new TokenError(`${owner} needs layers with a numeric $alpha.`);
  }
  const color = resolveValue(requireField(layer, "color", owner), mode, index);
  if (typeof color !== "string") {
    throw new TokenError(`${owner} needs a colour on every layer.`);
  }
  const alpha = Math.min(1, layer["$alpha"] * (mode === "dark" ? 2 : 1));
  const geometry = SHADOW_GEOMETRY.map((key) => dimensionCss(layer[key], `${owner} ${key}`));
  return `${geometry.join(" ")} color-mix(in srgb, ${color} ${String(roundHalfToEven(alpha * 100))}%, transparent)`;
}

function cssValue(token: Token, mode: Theme, index: TokenIndex): string {
  const value = rawValue(token, mode);
  const owner = `Token ${token.path.join(".")}`;
  if (isAlias(value)) {
    return `var(${cssName(aliasPath(value))})`;
  }
  switch (token.type) {
    case "color":
      if (!isColor(value)) {
        throw new TokenError(`${owner} has no hex value.`);
      }
      return value.hex;
    case "dimension":
    case "duration":
      return dimensionCss(value, owner);
    case "cubicBezier":
      if (!isJsonArray(value)) {
        throw new TokenError(`${owner} must be an array of four numbers.`);
      }
      return `cubic-bezier(${value.map((point) => scalarCss(point, owner)).join(", ")})`;
    case "fontFamily":
      if (!isJsonArray(value)) {
        throw new TokenError(`${owner} must be an array of family names.`);
      }
      return value
        .map((family) => scalarCss(family, owner))
        .map((family) => (family.includes(" ") ? `"${family}"` : family))
        .join(", ");
    case "shadow":
      if (!isJsonArray(value)) {
        throw new TokenError(`${owner} must be an array of shadow layers.`);
      }
      return value.length === 0
        ? "none"
        : value.map((layer) => shadowLayerCss(layer, mode, index, owner)).join(", ");
    case "string-url":
      return `"${scalarCss(value, owner)}"`;
    default:
      return scalarCss(value, owner);
  }
}

function typographyDeclarations(name: string, token: Token): string[] {
  const owner = `Typography token ${token.path.join(".")}`;
  if (!isJsonObject(token.light)) {
    throw new TokenError(`${owner} must be an object.`);
  }
  const composite = token.light;
  return TYPOGRAPHY_PROPERTIES.map(([key, property]) => {
    const part = requireField(composite, key, owner);
    const output = isAlias(part)
      ? `var(${cssName(aliasPath(part))})`
      : isDimension(part)
        ? dimensionCss(part, owner)
        : scalarCss(part, owner);
    return `  ${name}-${property}: ${output};`;
  });
}

function renderCss(lightLines: readonly string[], darkLines: readonly string[]): string {
  return [
    "/* GENERATED by frontend/scripts/build-tokens.ts from tokens.json. Do not edit by hand. */",
    '/* Theme contract: the pre-hydration script sets <html data-theme="light|dark"> (system resolved). */',
    "@layer tokens {",
    ":root {",
    "  color-scheme: light;",
    ...lightLines,
    "}",
    ':root[data-theme="dark"] {',
    "  color-scheme: dark;",
    ...darkLines,
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  :root:not([data-theme]) {",
    "    color-scheme: dark;",
    ...darkLines.map((line) => `  ${line}`),
    "  }",
    "}",
    "}",
    "",
  ].join("\n");
}

function renderTs(resolved: ResolvedTokens): string {
  const block = (theme: Theme): string =>
    Object.entries(resolved[theme])
      .map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`)
      .join("\n");
  return [
    "/* GENERATED by frontend/scripts/build-tokens.ts from tokens.json. Do not edit by hand. */",
    "",
    "/**",
    " * Every design token resolved to a literal per theme. Keys are the CSS custom property names",
    " * without the leading dashes (`color-surface-page` is `--color-surface-page`). Use this where CSS",
    " * variables are out of reach, e.g. MapLibre paint expressions.",
    " */",
    "export const tokens = {",
    "  light: {",
    block("light"),
    "  },",
    "  dark: {",
    block("dark"),
    "  },",
    "} as const;",
    "",
    "/** The themes the token map resolves to. */",
    "export type ThemeName = keyof typeof tokens;",
    "",
    "/** Every token name (identical in both themes). */",
    'export type TokenName = keyof (typeof tokens)["light"];',
    "",
  ].join("\n");
}

/**
 * Generates `tokens.css` and `tokens.ts` from a parsed DTCG document.
 *
 * @param document - The parsed `tokens.json` (`JSON.parse` output).
 * @returns The two files plus summary counts.
 * @throws {TokenError} When the document is malformed (unknown tier, dangling alias, bad value).
 */
export function generateTokenFiles(document: unknown): GeneratedTokenFiles {
  if (!isRecord(document)) {
    throw new TokenError("The token document must be a JSON object.");
  }
  const tokens = collectTokens(document, [], []);
  const index: TokenIndex = new Map(tokens.map((token) => [token.path.join("."), token]));

  const lightLines: string[] = [];
  const darkLines: string[] = [];
  const resolved: ResolvedTokens = { light: {}, dark: {} };

  for (const token of tokens) {
    const name = cssName(token.path);
    for (const mode of THEMES) {
      resolved[mode][name.slice(2)] = resolveValue(rawValue(token, mode), mode, index);
    }
    if (token.type === "typography") {
      lightLines.push(...typographyDeclarations(name, token));
      continue;
    }
    lightLines.push(`  ${name}: ${cssValue(token, "light", index)};`);
    if (token.dark !== undefined || token.type === "shadow") {
      darkLines.push(`  ${name}: ${cssValue(token, "dark", index)};`);
    }
  }

  return {
    css: renderCss(lightLines, darkLines),
    ts: renderTs(resolved),
    stats: {
      tokens: tokens.length,
      cssVariables: lightLines.length,
      darkOverrides: darkLines.length,
    },
  };
}
