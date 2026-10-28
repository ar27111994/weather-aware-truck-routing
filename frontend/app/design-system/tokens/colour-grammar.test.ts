import { describe, expect, it } from "vitest";

import { type ThemeName, type TokenName, tokens } from "./tokens";

/**
 * The colour grammar of the feedback states (DESIGN.md section 3.2 and section 4, rule 1; the
 * rulings DR2 for danger and DR3 for warning and success).
 *
 * A feedback state (an error, a warning, a success) has an ink of its own. It never borrows a
 * risk-ladder ink: a feedback state is not a risk level, and two meanings painted in one ink read as
 * one meaning. This test reads the shipped token values and measures them. `tokens.ts` holds the
 * literals that the generator resolves from `tokens.json`, and `tokens.test.ts` pins the two equal.
 *
 * - CIEDE2000 (dE00) is the distance between two colours as a person sees it: about 1 is the
 *   smallest visible difference, 10 or more is two clearly different colours.
 * - WCAG 2.2 contrast: 4.5:1 for text (SC 1.4.3), 3:1 for a border or an icon (SC 1.4.11).
 *
 * The colour maths is checked first: against the 34 reference pairs that Sharma, Wu and Dalal
 * published for CIEDE2000, and against the numbers the design seat's tool printed in the rulings,
 * which pins the whole path from a hex code to a distance. Then the rules run over the palette, and
 * over palettes with one planted defect each, so that a rule that cannot fail does not pass for free.
 */

/** DR2's floor for two inks that mean different things (dE00). */
const MIN_DELTA_E00 = 10;
/** WCAG 2.2 SC 1.4.3, text. */
const MIN_TEXT_CONTRAST = 4.5;
/** WCAG 2.2 SC 1.4.11, a border or an icon. */
const MIN_NON_TEXT_CONTRAST = 3;
/** The reference distances of Sharma, Wu and Dalal (2005) are printed to four decimals. */
const SHARMA_TOLERANCE = 1e-4;
/** The rulings print distances and ratios to two decimals. */
const PRINTED_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------------------------

type Triple = readonly [number, number, number];

const hexChannel = (hex: string, index: number): number =>
  parseInt(hex.slice(1 + 2 * index, 3 + 2 * index), 16) / 255;

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const linearRgb = (hex: string): Triple => [
  toLinear(hexChannel(hex, 0)),
  toLinear(hexChannel(hex, 1)),
  toLinear(hexChannel(hex, 2)),
];

const dot = (row: Triple, column: Triple): number =>
  row[0] * column[0] + row[1] * column[1] + row[2] * column[2];

/** WCAG 2.2 relative luminance of an sRGB colour. */
const relativeLuminance = (hex: string): number => dot([0.2126, 0.7152, 0.0722], linearRgb(hex));

/** WCAG 2.2 contrast ratio between two sRGB colours, 1 to 21. */
function contrastRatio(first: string, second: string): number {
  const [a, b] = [relativeLuminance(first), relativeLuminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Linear sRGB to CIE XYZ under D65 (Lindbloom's matrix: the one the design seat's tool uses). */
const SRGB_TO_XYZ: readonly [Triple, Triple, Triple] = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
/** The D65 reference white of CIE 15 CIELAB. */
const D65_WHITE: Triple = [0.95047, 1, 1.08883];
const LAB_DELTA = 6 / 29;

const labF = (ratio: number): number =>
  ratio > LAB_DELTA ** 3 ? Math.cbrt(ratio) : ratio / (3 * LAB_DELTA ** 2) + 4 / 29;

/** CIELAB (D65) of an sRGB colour. */
function labOf(hex: string): Triple {
  const rgb = linearRgb(hex);
  const [xRow, yRow, zRow] = SRGB_TO_XYZ;
  const fx = labF(dot(xRow, rgb) / D65_WHITE[0]);
  const fy = labF(dot(yRow, rgb) / D65_WHITE[1]);
  const fz = labF(dot(zRow, rgb) / D65_WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const POWER_25_7 = 25 ** 7;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
const hueDegrees = (b: number, aPrime: number): number =>
  (toDegrees(Math.atan2(b, aPrime)) + 360) % 360;

function hueDifference(first: number, second: number): number {
  const difference = second - first;
  if (difference > 180) {
    return difference - 360;
  }
  return difference < -180 ? difference + 360 : difference;
}

function meanHue(first: number, second: number): number {
  if (Math.abs(first - second) <= 180) {
    return (first + second) / 2;
  }
  return (first + second + (first + second < 360 ? 360 : -360)) / 2;
}

/**
 * CIEDE2000 between two CIELAB colours, with the parametric weights at 1. Follows the formulas and
 * the notation of Sharma, Wu and Dalal (2005), Color Research and Application 30(1):21-30.
 */
function ciede2000(first: Triple, second: Triple): number {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;

  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + POWER_25_7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1Prime = c1Prime === 0 ? 0 : hueDegrees(b1, a1Prime);
  const h2Prime = c2Prime === 0 ? 0 : hueDegrees(b2, a2Prime);

  const achromatic = c1Prime * c2Prime === 0;
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  const deltaHue = achromatic ? 0 : hueDifference(h1Prime, h2Prime);
  const deltaH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(toRadians(deltaHue / 2));

  const meanL = (l1 + l2) / 2;
  const meanC = (c1Prime + c2Prime) / 2;
  const meanH = achromatic ? h1Prime + h2Prime : meanHue(h1Prime, h2Prime);
  const t =
    1 -
    0.17 * Math.cos(toRadians(meanH - 30)) +
    0.24 * Math.cos(toRadians(2 * meanH)) +
    0.32 * Math.cos(toRadians(3 * meanH + 6)) -
    0.2 * Math.cos(toRadians(4 * meanH - 63));
  const rotation = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const rotationChroma = 2 * Math.sqrt(meanC ** 7 / (meanC ** 7 + POWER_25_7));
  const sL = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sC = 1 + 0.045 * meanC;
  const sH = 1 + 0.015 * meanC * t;
  const rT = -Math.sin(toRadians(2 * rotation)) * rotationChroma;

  const lightness = deltaL / sL;
  const chroma = deltaC / sC;
  const hue = deltaH / sH;
  return Math.sqrt(lightness ** 2 + chroma ** 2 + hue ** 2 + rT * chroma * hue);
}

const deltaE00 = (first: string, second: string): number => ciede2000(labOf(first), labOf(second));

/** Sharma, Wu and Dalal (2005), Table 1: L1, a1, b1, L2, a2, b2 and the published dE00. */
const SHARMA_PAIRS: readonly (readonly [number, number, number, number, number, number, number])[] =
  [
    [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
    [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
    [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
    [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
    [50.0, -1.1848, -84.8006, 50.0, 0.0, -82.7485, 1.0],
    [50.0, -0.9009, -85.5211, 50.0, 0.0, -82.7485, 1.0],
    [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
    [50.0, -1.0, 2.0, 50.0, 0.0, 0.0, 2.3669],
    [50.0, 2.49, -0.001, 50.0, -2.49, 0.0009, 7.1792],
    [50.0, 2.49, -0.001, 50.0, -2.49, 0.001, 7.1792],
    [50.0, 2.49, -0.001, 50.0, -2.49, 0.0011, 7.2195],
    [50.0, 2.49, -0.001, 50.0, -2.49, 0.0012, 7.2195],
    [50.0, -0.001, 2.49, 50.0, 0.0009, -2.49, 4.8045],
    [50.0, -0.001, 2.49, 50.0, 0.001, -2.49, 4.8045],
    [50.0, -0.001, 2.49, 50.0, 0.0011, -2.49, 4.7461],
    [50.0, 2.5, 0.0, 50.0, 0.0, -2.5, 4.3065],
    [50.0, 2.5, 0.0, 73.0, 25.0, -18.0, 27.1492],
    [50.0, 2.5, 0.0, 61.0, -5.0, 29.0, 22.8977],
    [50.0, 2.5, 0.0, 56.0, -27.0, -3.0, 31.903],
    [50.0, 2.5, 0.0, 58.0, 24.0, 15.0, 19.4535],
    [50.0, 2.5, 0.0, 50.0, 3.1736, 0.5854, 1.0],
    [50.0, 2.5, 0.0, 50.0, 3.2972, 0.0, 1.0],
    [50.0, 2.5, 0.0, 50.0, 1.8634, 0.5757, 1.0],
    [50.0, 2.5, 0.0, 50.0, 3.2592, 0.335, 1.0],
    [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
    [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
    [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
    [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
    [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
    [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
    [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
    [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
    [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
    [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
  ];

/** dE00 between two inks as the design seat's tool printed it in DR2 and DR3. */
const RULED_DISTANCES: readonly (readonly [string, string, number])[] = [
  ["#C2181D", "#8C001C", 12.4], // DR2 light danger, against Severe
  ["#FF968A", "#F25855", 13.42], // DR2 dark danger, against Severe
  ["#C2181D", "#580055", 35.71], // DR2 light danger, against No Travel
  ["#955A00", "#893E00", 10.81], // DR3 light warning, against High
  ["#FDD500", "#DDAB46", 13.45], // DR3 dark warning, against Moderate
  ["#005E28", "#128460", 14.75], // DR3 light success, against Low
  ["#58B670", "#91DBAB", 11.99], // DR3 dark success, against Low
];

/** WCAG contrast ratios: two known to the world, the rest as the design seat's tool printed them. */
const RULED_CONTRASTS: readonly (readonly [string, string, number])[] = [
  ["#000000", "#FFFFFF", 21], // the WCAG maximum
  ["#767676", "#FFFFFF", 4.54], // the lightest grey that passes 4.5:1 on white
  ["#C2181D", "#FEFEFA", 6.03], // DR2 light danger on the panel
  ["#C2181D", "#E8E8E5", 4.97], // DR2 light danger on a pressed row, its tightest surface
  ["#955A00", "#E8E8E5", 4.57], // DR3 light warning on a pressed row, the tightest of all
  ["#FF968A", "#2B2B29", 6.74], // DR2 dark danger on a pressed row
  ["#58B670", "#2B2B29", 5.63], // DR3 dark success on a pressed row
];

describe("the colour maths", () => {
  it("holds the 34 reference pairs of Sharma, Wu and Dalal (2005)", () => {
    expect(SHARMA_PAIRS).toHaveLength(34);
  });

  it("reproduces every Sharma pair to four decimals, in both argument orders", () => {
    const misses = SHARMA_PAIRS.flatMap(([l1, a1, b1, l2, a2, b2, expected], index) => {
      const forward = ciede2000([l1, a1, b1], [l2, a2, b2]);
      const backward = ciede2000([l2, a2, b2], [l1, a1, b1]);
      const worst = Math.max(Math.abs(forward - expected), Math.abs(backward - expected));
      return worst < SHARMA_TOLERANCE ? [] : [`pair ${String(index + 1)}: off by ${String(worst)}`];
    });

    expect(misses).toEqual([]);
  });

  it("puts the D65 white at L 100 and black at L 0, both without chroma", () => {
    const [whiteL, whiteA, whiteB] = labOf("#FFFFFF");
    const [blackL, blackA, blackB] = labOf("#000000");

    // Lindbloom's matrix is rounded to 7 digits: its Y row sums to 1.0000001, so the white lands
    // at L 100.000004. The rulings were measured with this very matrix, so it stays as it is.
    expect(whiteL).toBeCloseTo(100, 4);
    expect(whiteA).toBeCloseTo(0, 4);
    expect(whiteB).toBeCloseTo(0, 4);
    expect(blackL).toBeCloseTo(0, 4);
    expect(blackA).toBeCloseTo(0, 4);
    expect(blackB).toBeCloseTo(0, 4);
  });

  it("gives the distances that DR2 and DR3 ruled, from hex codes", () => {
    const misses = RULED_DISTANCES.flatMap(([first, second, expected]) => {
      const got = deltaE00(first, second);
      return Math.abs(got - expected) < PRINTED_TOLERANCE
        ? []
        : [`${first} ${second}: ${String(got)} not ${String(expected)}`];
    });

    expect(misses).toEqual([]);
  });

  it("gives the contrast ratios that the rulings printed, and the two known to WCAG", () => {
    const misses = RULED_CONTRASTS.flatMap(([first, second, expected]) => {
      const got = contrastRatio(first, second);
      const agrees =
        Math.abs(got - expected) < PRINTED_TOLERANCE && contrastRatio(second, first) === got;
      return agrees ? [] : [`${first} on ${second}: ${String(got)} not ${String(expected)}`];
    });

    expect(misses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------------------------

/** A palette as the audit reads it: per theme, token name to value (the shape of `tokens`). */
type Palette = Readonly<Record<ThemeName, Readonly<Record<string, unknown>>>>;

const THEMES: readonly ThemeName[] = ["light", "dark"];

/** The six rungs of the risk ladder (DESIGN.md section 4). Feedback inks must differ from each. */
const LADDER_FILLS = [
  "risk-low-fill",
  "risk-moderate-fill",
  "risk-high-fill",
  "risk-severe-fill",
  "risk-no-travel-fill",
  "risk-unknown-fill",
] as const satisfies readonly TokenName[];

/** The seven surfaces that text can sit on (DESIGN.md section 3.1). */
const SURFACES = [
  "color-surface-page",
  "color-surface-panel",
  "color-surface-raised",
  "color-surface-sunken",
  "color-surface-hover",
  "color-surface-pressed",
  "color-surface-selected",
] as const satisfies readonly TokenName[];

interface FeedbackState {
  readonly name: "danger" | "warning" | "success";
  /** Every token that paints this state's ink; the first is the text. In a theme they are one colour. */
  readonly roles: readonly [TokenName, ...TokenName[]];
  /** The banner fill that the state's text and icon sit on. */
  readonly fill: TokenName;
  /** The backgrounds that the state's border and icon touch (WCAG 1.4.11). */
  readonly touches: readonly TokenName[];
}

const FEEDBACK_STATES: readonly FeedbackState[] = [
  {
    name: "danger",
    roles: [
      "color-text-danger",
      "color-border-danger",
      "color-feedback-danger-border",
      "c-field-border-invalid",
      "c-button-danger-bg",
    ],
    fill: "color-feedback-danger-bg",
    // The invalid field (its own background and the surfaces it sits on) and the banner.
    touches: [
      "c-field-bg",
      "color-surface-page",
      "color-surface-panel",
      "color-surface-raised",
      "color-surface-sunken",
      "color-surface-hover",
      "color-feedback-danger-bg",
    ],
  },
  {
    name: "warning",
    roles: ["color-text-warning", "color-feedback-warning-border"],
    fill: "color-feedback-warning-bg",
    touches: [
      "color-feedback-warning-bg",
      "color-surface-page",
      "color-surface-panel",
      "color-surface-raised",
      "color-surface-sunken",
    ],
  },
  {
    name: "success",
    roles: ["color-text-success", "color-feedback-success-border"],
    fill: "color-feedback-success-bg",
    touches: [
      "color-feedback-success-bg",
      "color-surface-page",
      "color-surface-panel",
      "color-surface-raised",
      "color-surface-sunken",
    ],
  },
];

/** The label of the reserved danger button and the three fills it sits on. */
const DANGER_BUTTON = {
  label: "c-button-danger-fg",
  fills: ["c-button-danger-bg", "c-button-danger-bg-hover", "c-button-danger-bg-pressed"],
} as const satisfies { label: TokenName; fills: readonly TokenName[] };

const RULES = [
  "each state paints one ink in every role",
  "no role of a state borrows a risk-ladder ink",
  "the three states differ from each other",
  "text reads at 4.5:1 on every surface it sits on",
  "borders and icons read at 3:1 on every background they touch",
  "the danger button label reads at 4.5:1 on every fill",
] as const;

type Rule = (typeof RULES)[number];

interface Violation {
  readonly rule: Rule;
  readonly message: string;
}

/** The colour that a token holds in a theme. Throws when it is missing or not a #RRGGBB colour. */
function inkOf(palette: Palette, theme: ThemeName, name: TokenName): string {
  const value = palette[theme][name];
  if (typeof value !== "string" || !/^#[0-9A-F]{6}$/i.test(value)) {
    throw new Error(`${theme} ${name} is not a #RRGGBB colour: ${JSON.stringify(value)}`);
  }
  return value;
}

const fixed = (value: number): string => value.toFixed(2);

/** Runs every rule of the grammar over a palette and lists each place where one is broken. */
function audit(palette: Palette): Violation[] {
  const violations: Violation[] = [];
  const report = (rule: Rule, message: string): void => {
    violations.push({ rule, message });
  };

  for (const theme of THEMES) {
    const ink = (name: TokenName): string => inkOf(palette, theme, name);
    const label = (name: TokenName): string => `${theme} ${name} ${ink(name)}`;

    for (const state of FEEDBACK_STATES) {
      const [text] = state.roles;
      const stateInk = ink(text);

      for (const role of state.roles) {
        if (ink(role) !== stateInk) {
          report(RULES[0], `${theme} ${state.name}: ${label(role)} is not ${text} ${stateInk}`);
        }
        for (const rung of LADDER_FILLS) {
          const distance = deltaE00(ink(role), ink(rung));
          if (distance < MIN_DELTA_E00) {
            const need = `needs ${String(MIN_DELTA_E00)}`;
            report(
              RULES[1],
              `${label(role)} is ${fixed(distance)} dE00 from ${rung} ${ink(rung)}, ${need}`,
            );
          }
        }
      }

      for (const other of FEEDBACK_STATES.filter((candidate) => candidate.name > state.name)) {
        const [otherText] = other.roles;
        const distance = deltaE00(stateInk, ink(otherText));
        if (distance < MIN_DELTA_E00) {
          const need = `needs ${String(MIN_DELTA_E00)}`;
          report(
            RULES[2],
            `${label(text)} is ${fixed(distance)} dE00 from ${other.name} ${ink(otherText)}, ${need}`,
          );
        }
      }

      for (const surface of [...SURFACES, state.fill]) {
        const contrast = contrastRatio(stateInk, ink(surface));
        if (contrast < MIN_TEXT_CONTRAST) {
          const need = `needs ${String(MIN_TEXT_CONTRAST)}`;
          report(
            RULES[3],
            `${label(text)} on ${surface} ${ink(surface)} is ${fixed(contrast)}:1, ${need}`,
          );
        }
      }

      for (const background of state.touches) {
        const contrast = contrastRatio(stateInk, ink(background));
        if (contrast < MIN_NON_TEXT_CONTRAST) {
          const need = `needs ${String(MIN_NON_TEXT_CONTRAST)}`;
          report(
            RULES[4],
            `${label(text)} on ${background} ${ink(background)} is ${fixed(contrast)}:1, ${need}`,
          );
        }
      }
    }

    for (const fill of DANGER_BUTTON.fills) {
      const contrast = contrastRatio(ink(DANGER_BUTTON.label), ink(fill));
      if (contrast < MIN_TEXT_CONTRAST) {
        const need = `needs ${String(MIN_TEXT_CONTRAST)}`;
        report(
          RULES[5],
          `${label(DANGER_BUTTON.label)} on ${fill} ${ink(fill)} is ${fixed(contrast)}:1, ${need}`,
        );
      }
    }
  }
  return violations;
}

/** The palette with some tokens of one theme replaced: a planted defect. */
function patched(theme: ThemeName, replacements: Partial<Record<TokenName, string>>): Palette {
  return { ...tokens, [theme]: { ...tokens[theme], ...replacements } };
}

/** Every role of one state painted in one colour (to be planted in one theme). */
function paintedIn(
  stateName: FeedbackState["name"],
  colour: string,
): Partial<Record<TokenName, string>> {
  const state = FEEDBACK_STATES.find((candidate) => candidate.name === stateName);
  return Object.fromEntries((state?.roles ?? []).map((role) => [role, colour]));
}

describe("the feedback inks keep their own colour grammar (DR2 danger, DR3 warning and success)", () => {
  it("measures the six risk-ladder fills, and only those", () => {
    const fills = Object.keys(tokens.light).filter(
      (name) => name.startsWith("risk-") && name.endsWith("-fill") && !name.endsWith("-on-fill"),
    );

    expect([...LADDER_FILLS].sort()).toEqual(fills.sort());
  });

  it.each(RULES)("shipped palette: %s", (rule) => {
    const broken = audit(tokens)
      .filter((violation) => violation.rule === rule)
      .map((violation) => violation.message);

    expect(broken).toEqual([]);
  });

  describe("a planted defect is caught by the rule that it breaks", () => {
    const DEFECTS: readonly {
      readonly defect: string;
      readonly palette: Palette;
      readonly rule: Rule;
      /** The start of the message that the rule must give for it: it names the guilty token. */
      readonly names: string;
    }[] = [
      {
        defect: "danger painted in the Severe ink (the pairing Ahmed vetoed)",
        palette: patched("light", paintedIn("danger", tokens.light["risk-severe-fill"])),
        rule: RULES[1],
        names: "light color-text-danger #8C001C is 0.00 dE00 from risk-severe-fill #8C001C",
      },
      {
        defect: "warning painted in the Moderate ink",
        palette: patched("dark", paintedIn("warning", tokens.dark["risk-moderate-fill"])),
        rule: RULES[1],
        names: "dark color-text-warning #DDAB46 is 0.00 dE00 from risk-moderate-fill #DDAB46",
      },
      {
        defect: "a success border painted in the Low ink",
        palette: patched("light", {
          "color-feedback-success-border": tokens.light["risk-low-fill"],
        }),
        rule: RULES[1],
        names: "light color-feedback-success-border #128460 is 0.00 dE00 from risk-low-fill",
      },
      {
        defect: "the invalid-field border one step off the danger text",
        palette: patched("dark", { "c-field-border-invalid": "#FF968B" }),
        rule: RULES[0],
        names: "dark danger: dark c-field-border-invalid #FF968B is not color-text-danger",
      },
      {
        defect: "danger and warning painted in one ink",
        palette: patched("light", paintedIn("warning", tokens.light["color-text-danger"])),
        rule: RULES[2],
        names: "light color-text-danger",
      },
      {
        defect: "danger text lightened until a pressed row reads it below 4.5:1",
        palette: patched("light", paintedIn("danger", "#D33A33")),
        rule: RULES[3],
        names: "light color-text-danger #D33A33 on color-surface-pressed",
      },
      {
        defect: "a warning ink that a banner border cannot hold at 3:1",
        palette: patched("dark", paintedIn("warning", "#7A6000")),
        rule: RULES[4],
        names: "dark color-text-warning #7A6000 on color-feedback-warning-bg",
      },
      {
        defect: "a danger button label that fades into the hover fill",
        palette: patched("dark", { "c-button-danger-fg": "#6A6A66" }),
        rule: RULES[5],
        names: "dark c-button-danger-fg #6A6A66 on c-button-danger-bg-hover",
      },
    ];

    it.each(DEFECTS)("$defect", ({ palette, rule, names }) => {
      const caught = audit(palette)
        .filter((violation) => violation.rule === rule)
        .map((violation) => violation.message);

      expect(caught.join("\n")).toContain(names);
    });
  });
});
