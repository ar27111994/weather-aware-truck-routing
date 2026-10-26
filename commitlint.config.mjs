// Conventional Commits 1.0 for commit messages (the pre-commit commit-msg hook, and the `commit-lint`
// job of ci.yml for every commit of a pull request) and for pull-request titles (the `pr-title` job
// of ci.yml). Self-contained on purpose: no preset to resolve, so `npx @commitlint/cli` works anywhere.
//
// Scopes are free-form kebab-case: feat(frontend-api), test(e2e), fix(a11y). commitlint's own
// `scope-case: kebab-case` cannot say that: it compares the scope with lodash's kebabCase, which
// splits letters from digits (e2e becomes e-2-e), so test(e2e) fails. `scope-kebab-case` below is
// the same check with digits allowed, over the same delimiters (a slash, a backslash or a comma
// separate scopes). An empty segment, as in feat(frontend,), is refused.
const KEBAB_CASE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_DELIMITERS = /[/\\,]/;

export default {
  plugins: [
    {
      rules: {
        // Only `always` is meaningful, and it is the only way the rule is used below.
        "scope-kebab-case": ({ scope }) => [
          !scope || scope.split(SCOPE_DELIMITERS).every((segment) => KEBAB_CASE_SEGMENT.test(segment)),
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
