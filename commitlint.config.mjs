// Conventional Commits 1.0 for commit messages (the pre-commit commit-msg hook, and the `commit-lint`
// job of ci.yml for every commit of a pull request) and for pull-request titles (the `pr-title` job
// of ci.yml). Self-contained on purpose: no preset to resolve, so `npx @commitlint/cli` works anywhere.
//
// Scopes are free-form kebab-case: feat(frontend-api), test(e2e), fix(a11y). commitlint's own
// `scope-case: kebab-case` cannot say that: it compares the scope with lodash's kebabCase, which
// splits letters from digits (e2e becomes e-2-e), so test(e2e) fails. `scope-kebab-case` below is
// the same check with digits allowed, over the same delimiters (a slash, a backslash, or a comma
// with one optional space after it). An empty scope, feat(), and an empty segment, as in
// feat(frontend,), are refused.
const KEBAB_CASE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_DELIMITERS = /[/\\]|, ?/;
// The parser reports feat() with the same empty scope as a header with no parentheses at all.
const EMPTY_SCOPE = /^[^(:]*\(\)/;

function scopeIsKebabCase({ scope, header }) {
  // String() because the header of an empty message is null; "null" has no parentheses.
  if (EMPTY_SCOPE.test(String(header))) {
    return false;
  }
  if (!scope) {
    return true;
  }
  return scope.split(SCOPE_DELIMITERS).every((segment) => KEBAB_CASE_SEGMENT.test(segment));
}

// Dependabot (.github/dependabot.yml) opens the pull requests that these rules judge too, and it does
// not write to our limits. Two exceptions, each for what Dependabot writes and for nothing else:
//
// - header-max-length: the title of a pull request that names the dependencies it bumps (one update in
//   a group of one or in no group, or several updates in no group) is as long as their names, so no
//   setting of Dependabot bounds it, and the commit subject of such an update is shortened by
//   Dependabot itself. A header of exactly that form passes at any length: build(deps) or ci(deps) (or
//   deps-dev), then `bump <dep> from <old> to <new>` or `bump <a>, <b> and <c>`, then the optional
//   ` (via audit fix)`, ` in /<directory>`, ` in the <group> group` and ` across <k> directory`, in
//   the order of dependabot-core (message_builder.rb at commit 7c06280). The titles of a group of
//   SEVERAL updates are not exempt: the name of the group bounds them, and
//   scripts/tests/commitlint-config.test.mjs holds the real dependabot.yml to 72 in the worst case.
// - body-max-line-length: commitlint already lets a line that holds a link exceed the limit, but the
//   intro line of a group is a plain list of names when no source link is known. A message whose
//   header starts like a Dependabot bump (build(deps): bump ...) AND whose footer holds Dependabot's
//   own signature may exceed it. Nothing else about such a message changes.
//
// What a human needs to get past these: for the header, a header that reads exactly like such a title
// (a list of package names after `bump`, not a sentence); for the body, such a header plus the line
// `Signed-off-by: dependabot[bot] <support@github.com>` in the footer, which is a false statement
// that review and the log show. The first buys a long list of names in a dependency bump, the second a
// long line in the body of one: every other rule still judges the message, and no check rests on
// either limit (they keep the log readable).
//
// commitlint runs a plugin rule in place of the built-in one of the same name (lint.js of
// @commitlint/lint), which keeps the rule names, the limits and the messages of the config above and
// below. The two rules below do what the built-in ones do for any other message.
const DEPENDABOT_BUMP = /^(?:build|ci)\(deps(?:-dev)?\): bump /;
const DEPENDABOT_SOLO_TITLE =
  /^(?:build|ci)\(deps(?:-dev)?\): bump \S+(?:(?:, \S+)* and \S+| from \S+ to \S+)?(?: \(via audit fix\))?(?: in \/\S*)?(?: in the [\w|-]+ group(?: across \d+ directory)?)?$/;
const DEPENDABOT_SIGNATURE = /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m;
// The exception that commitlint's own body-max-line-length makes (@commitlint/ensure, maxLineLength).
const LINE_WITH_URL = /\bhttps?:\/\/\S+/;

export default {
  plugins: [
    {
      rules: {
        "header-max-length": ({ header }, _when, max) => [
          String(header).length <= max || DEPENDABOT_SOLO_TITLE.test(String(header)),
          `header must not be longer than ${String(max)} characters, current length is ${String(header?.length)}`,
        ],
        "body-max-line-length": ({ header, body, footer }, _when, max) => [
          !body ||
            (DEPENDABOT_BUMP.test(String(header)) && DEPENDABOT_SIGNATURE.test(String(footer))) ||
            body.split(/\r?\n/).every((line) => LINE_WITH_URL.test(line) || line.length <= max),
          `body's lines must not be longer than ${String(max)} characters`,
        ],
        // Only `always` is meaningful, and it is the only way the rule is used below.
        "scope-kebab-case": (parsed) => [
          scopeIsKebabCase(parsed),
          "scope must be kebab-case: lower-case letters and digits, joined by single hyphens",
        ],
      },
    },
  ],
  rules: {
    "type-enum": [
      2,
      "always",
      ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"],
    ],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "scope-kebab-case": [2, "always"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "subject-case": [2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 72],
    "body-leading-blank": [2, "always"],
    "body-max-line-length": [2, "always", 100],
    "footer-leading-blank": [2, "always"],
  },
};
