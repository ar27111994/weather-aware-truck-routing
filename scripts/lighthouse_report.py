"""Lighthouse CI reporting for the pipeline (``.github/workflows/lighthouse.yml``).

Lighthouse CI measures; this script decides what the measurement means:

* ``mode``    resolves whether the budgets block (enforce) or are published only (report), from the
              target branch and the ``LIGHTHOUSE_ENFORCE`` repository variable;
* ``report``  evaluates the budgets of ``lighthouserc.json`` on each page's representative run
              (the run LHCI itself asserts on), writes the job summary, the pull request comment
              body and a JSON summary, and fails only when the mode is enforce and a budget was
              missed;
* ``comment`` creates or updates the one sticky pull request comment through the ``gh`` CLI.

``lighthouserc.json`` stays the single source of the budgets. Standard library only.
"""

# The command line is this script's interface: stdout carries GitHub workflow commands and step
# output, stderr carries errors.
# ruff: noqa: T201

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

MARKER = "<!-- lighthouse-report -->"
SWITCH = "LIGHTHOUSE_ENFORCE"
ENFORCED_BRANCH = "main"
BOT_LOGIN = "github-actions[bot]"
LABELS = {
    "categories:performance": "Performance",
    "categories:accessibility": "Accessibility",
    "categories:best-practices": "Best practices",
    "categories:seo": "SEO",
    "largest-contentful-paint": "LCP",
    "cumulative-layout-shift": "CLS",
    "total-blocking-time": "TBT",
}
GhRunner = Callable[[Sequence[str], str | None], str]


# --- gate mode ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Mode:
    """Whether a missed budget fails the job (enforce) or is only published (report)."""

    enforce: bool
    reason: str

    @property
    def name(self) -> str:
        """``enforce`` or ``report``, the value the workflow passes around."""
        return "enforce" if self.enforce else "report"


def resolve_mode(event_name: str, base_ref: str, ref_name: str, switch: str) -> Mode:
    """Decide the gate mode: always strict for ``main``, staged elsewhere until the switch is on.

    Args:
        event_name: The triggering event (for the message only).
        base_ref: Base branch of a pull request, empty for other events.
        ref_name: Branch of a push or a manual run (``<n>/merge`` on pull requests).
        switch: The raw ``LIGHTHOUSE_ENFORCE`` repository variable.

    Raises:
        ValueError: If the switch is set to anything but ``true`` or ``false``.
    """
    flag = switch.strip().lower()
    if flag not in {"", "true", "false"}:
        message = f"{SWITCH} must be 'true' or 'false', got {switch!r}"
        raise ValueError(message)
    target = base_ref or ref_name
    if target == ENFORCED_BRANCH:
        return Mode(enforce=True, reason=f"{event_name} targeting {ENFORCED_BRANCH}")
    if flag == "true":
        return Mode(enforce=True, reason=f"{SWITCH}=true for {target}")
    return Mode(enforce=False, reason=f"staged for {target}: set {SWITCH}=true to enforce it")


# --- budgets and runs -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Budget:
    """One assertion of ``lighthouserc.json``: a category score floor or an audit value ceiling."""

    key: str
    level: str
    minimum: float | None = None
    maximum: float | None = None


def _parse_assertion(key: str, spec: object) -> Budget | None:
    """Parse one ``[level, options]`` assertion; ``None`` for ``off``."""
    if not isinstance(spec, list) or not spec or spec[0] not in {"error", "warn", "off"}:
        message = f"unsupported assertion {key!r}: {spec!r}"
        raise ValueError(message)
    if spec[0] == "off":
        return None
    options = spec[1] if len(spec) == 2 and isinstance(spec[1], dict) else {}  # noqa: PLR2004
    if set(options) == {"minScore"}:
        return Budget(key, spec[0], minimum=float(options["minScore"]))
    if set(options) == {"maxNumericValue"}:
        return Budget(key, spec[0], maximum=float(options["maxNumericValue"]))
    message = f"unsupported assertion {key!r}: {spec!r} (only minScore or maxNumericValue)"
    raise ValueError(message)


def load_budgets(config: Mapping[str, Any]) -> list[Budget]:
    """Read the budgets from a parsed ``lighthouserc.json``.

    Only what LHCI's ``median-run`` aggregation of ``minScore``/``maxNumericValue`` assertions
    means is implemented; anything else is refused instead of being silently skipped.
    """
    section = config["ci"]["assert"]
    if section.get("aggregationMethod") != "median-run":
        message = "lighthouserc.json must use aggregationMethod 'median-run'"
        raise ValueError(message)
    parsed = (_parse_assertion(key, spec) for key, spec in section.get("assertions", {}).items())
    return [budget for budget in parsed if budget is not None]


def load_results(directory: Path) -> list[dict[str, Any]]:
    """Every Lighthouse result LHCI collected (``lhr-*.json``), oldest first."""
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("lhr-*.json"))
    ]


def _audit_value(lhr: Mapping[str, Any], audit_id: str) -> float:
    """``numericValue`` of an audit, 0 when absent (what LHCI's representative-run code does)."""
    return float(lhr.get("audits", {}).get(audit_id, {}).get("numericValue") or 0)


def representative_runs(lhrs: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Per page, the run closest to the median first-contentful-paint and interactive time.

    This is ``computeRepresentativeRuns`` of ``@lhci/utils``: the run ``lhci assert`` evaluates
    with ``aggregationMethod: median-run``, so the published numbers cannot disagree with it.
    """
    pages: dict[str, list[dict[str, Any]]] = {}
    for lhr in lhrs:
        pages.setdefault(lhr["finalUrl"], []).append(lhr)
    chosen: dict[str, dict[str, Any]] = {}
    for url, runs in pages.items():
        middle = len(runs) // 2
        median_fcp = _audit_value(
            sorted(runs, key=lambda run: _audit_value(run, "first-contentful-paint"))[middle],
            "first-contentful-paint",
        )
        median_tti = _audit_value(
            sorted(runs, key=lambda run: _audit_value(run, "interactive"))[middle], "interactive"
        )
        chosen[url] = min(
            runs,
            key=lambda run, fcp=median_fcp, tti=median_tti: (
                (fcp - _audit_value(run, "first-contentful-paint")) ** 2
                + (tti - _audit_value(run, "interactive")) ** 2
            ),
        )
    return chosen


@dataclass(frozen=True)
class Check:
    """A budget evaluated on one page: the value measured (``None`` if missing) and the verdict."""

    budget: Budget
    actual: float | None
    passed: bool


def measured(lhr: Mapping[str, Any], key: str) -> float | None:
    """The value a budget key refers to: a category score or an audit's ``numericValue``."""
    if key.startswith("categories:"):
        return lhr.get("categories", {}).get(key.removeprefix("categories:"), {}).get("score")
    return lhr.get("audits", {}).get(key, {}).get("numericValue")


def evaluate(lhr: Mapping[str, Any], budgets: Sequence[Budget]) -> list[Check]:
    """Evaluate every budget on a run; a value that was not measured fails its budget."""
    checks = []
    for budget in budgets:
        actual = measured(lhr, budget.key)
        passed = (
            actual is not None
            and (budget.minimum is None or actual >= budget.minimum)
            and (budget.maximum is None or actual <= budget.maximum)
        )
        checks.append(Check(budget, actual, passed))
    return checks


# --- rendering ------------------------------------------------------------------------------------


def format_value(key: str, value: float | None) -> str:
    """Human format of a measurement: scores as 0-100, LCP in seconds, TBT in ms."""
    if value is None:
        return "n/a"
    if key.startswith("categories:"):
        return f"{round(value * 100, 1):.1f}".removesuffix(".0")
    if key == "largest-contentful-paint":
        return f"{value / 1000:.2f} s"
    if key == "total-blocking-time":
        return f"{value:.0f} ms"
    if key == "cumulative-layout-shift":
        return f"{value:.3f}".rstrip("0").rstrip(".") or "0"
    return f"{value:g}"


def _format_limit(budget: Budget) -> str:
    if budget.minimum is not None:
        return f"≥ {format_value(budget.key, budget.minimum)}"
    return f"≤ {format_value(budget.key, budget.maximum)}"


def _page_label(url: str) -> str:
    parts = urlsplit(url)
    return (parts.path or "/") + (f"?{parts.query}" if parts.query else "")


@dataclass(frozen=True)
class Report:
    """The evaluated measurement: Markdown for humans, a JSON-able summary, the missed budgets."""

    markdown: str
    summary: dict[str, Any]
    failures: list[tuple[str, Check]]


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" + ("" if count == 1 else "s")


def _verdict(mode: Mode, failures: int) -> str:
    if failures == 0:
        return "✅ all budgets met"
    missed = f"{_plural(failures, 'budget')} missed"
    return f"❌ {missed} — blocking" if mode.enforce else f"⚠️ {missed} — report-only"


def _marker(check: Check) -> str:
    if check.passed:
        return "✅"
    return "❌" if check.budget.level == "error" else "⚠️"


def _cell(check: Check) -> str:
    return f"{format_value(check.budget.key, check.actual)} {_marker(check)}"


def build_report(
    lhrs: Sequence[dict[str, Any]],
    budgets: Sequence[Budget],
    mode: Mode,
    *,
    target: str,
    commit: str,
) -> Report:
    """Evaluate the budgets on each page's representative run and render the result."""
    counts = Counter(lhr["finalUrl"] for lhr in lhrs)
    runs_per_page = sorted(set(counts.values()))
    pages = representative_runs(lhrs)
    evaluated = {url: evaluate(lhr, budgets) for url, lhr in pages.items()}
    failures = [
        (url, check)
        for url, checks in evaluated.items()
        for check in checks
        if not check.passed and check.budget.level == "error"
    ]
    labels = [LABELS.get(budget.key, budget.key) for budget in budgets]
    rows = [
        f"| Page | {' | '.join(labels)} |",
        f"| --- | {' | '.join('---:' for _ in labels)} |",
        f"| Budget | {' | '.join(_format_limit(budget) for budget in budgets)} |",
        *(
            f"| `{_page_label(url)}` | {' | '.join(_cell(check) for check in checks)} |"
            for url, checks in evaluated.items()
        ),
    ]
    stance = "**enforced**" if mode.enforce else "**report-only**"
    why = f" ({mode.reason})" if mode.reason else ""
    footer = (
        f"<sub>{target} · median run of {'/'.join(map(str, runs_per_page))} per page · "
        f"commit `{commit[:7]}`</sub>"
    )
    markdown = "\n".join(
        [
            MARKER,
            f"## Lighthouse (mobile): {_verdict(mode, len(failures))}",
            "",
            f"The budgets are {stance} here{why}. They always block pull requests into `main`.",
            "",
            *rows,
            "",
            footer,
            "",
        ]
    )
    summary = {
        "mode": mode.name,
        "target": target,
        "commit": commit,
        "budgets_met": not failures,
        "pages": [
            {
                "url": url,
                "values": {check.budget.key: check.actual for check in checks},
                "failures": [
                    check.budget.key
                    for check in checks
                    if not check.passed and check.budget.level == "error"
                ],
            }
            for url, checks in evaluated.items()
        ],
    }
    return Report(markdown, summary, failures)


def escape_annotation(text: str) -> str:
    """Escape a workflow-command message (``::warning::...``) the way the runner expects."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


# --- sticky pull request comment ------------------------------------------------------------------


def run_gh(args: Sequence[str], stdin: str | None = None) -> str:
    """Run ``gh`` (authenticated through ``GH_TOKEN``) and return its standard output."""
    result = subprocess.run(  # noqa: S603
        ["gh", *args],  # noqa: S607
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout


def find_sticky(comments: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """The report comment this workflow owns: the bot's comment that carries the marker."""
    for comment in comments:
        if comment.get("user", {}).get("login") == BOT_LOGIN and MARKER in comment.get("body", ""):
            return comment
    return None


def upsert_comment(gh: GhRunner, repo: str, pull: int, body: str) -> str:
    """Create the sticky comment, or update it in place; returns ``created`` or ``updated``."""
    endpoint = f"repos/{repo}/issues/{pull}/comments?per_page=100"
    pages = json.loads(gh(["api", "--paginate", "--slurp", endpoint], None))
    existing = find_sticky([comment for page in pages for comment in page])
    payload = json.dumps({"body": body})
    if existing is None:
        gh(
            ["api", "--method", "POST", "--input", "-", f"repos/{repo}/issues/{pull}/comments"],
            payload,
        )
        return "created"
    gh(
        [
            "api",
            "--method",
            "PATCH",
            "--input",
            "-",
            f"repos/{repo}/issues/comments/{existing['id']}",
        ],
        payload,
    )
    return "updated"


# --- command line ---------------------------------------------------------------------------------


def _run_mode() -> int:
    env = os.environ
    try:
        mode = resolve_mode(
            env.get("GITHUB_EVENT_NAME", ""),
            env.get("GITHUB_BASE_REF", ""),
            env.get("GITHUB_REF_NAME", ""),
            env.get(SWITCH, ""),
        )
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    print(f"Lighthouse gate: {mode.name} ({mode.reason})")
    if output := env.get("GITHUB_OUTPUT"):
        with Path(output).open("a", encoding="utf-8") as handle:
            handle.write(f"mode={mode.name}\nreason={mode.reason}\n")
    return 0


def _run_report(args: argparse.Namespace) -> int:
    lhrs = load_results(Path(args.results))
    if not lhrs:
        print(
            f"no Lighthouse results in {args.results}: the collect step produced nothing",
            file=sys.stderr,
        )
        return 2
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    mode = Mode(enforce=args.mode == "enforce", reason=args.reason)
    report = build_report(lhrs, load_budgets(config), mode, target=args.target, commit=args.commit)
    level = "error" if mode.enforce else "warning"
    for url, check in report.failures:
        label = LABELS.get(check.budget.key, check.budget.key)
        message = (
            f"{_page_label(url)}: {label} {format_value(check.budget.key, check.actual)} "
            f"misses the budget ({_format_limit(check.budget)})"
        )
        print(f"::{level} title=Lighthouse budget missed::{escape_annotation(message)}")
    if args.summary:
        with Path(args.summary).open("a", encoding="utf-8") as handle:
            handle.write(report.markdown)
    if args.comment_file:
        Path(args.comment_file).write_text(report.markdown, encoding="utf-8")
    if args.json:
        Path(args.json).write_text(json.dumps(report.summary, indent=2) + "\n", encoding="utf-8")
    return 1 if mode.enforce and report.failures else 0


def _run_comment(args: argparse.Namespace, gh: GhRunner) -> int:
    body = Path(args.body_file).read_text(encoding="utf-8")
    try:
        outcome = upsert_comment(gh, args.repo, args.pull, body)
    except subprocess.CalledProcessError as error:
        reason = (error.stderr or str(error)).strip().splitlines()[0]
        print(f"::warning title=Lighthouse comment not published::{escape_annotation(reason)}")
        return 0
    print(f"Lighthouse comment {outcome} on #{args.pull}")
    return 0


def main(argv: Sequence[str] | None = None, *, gh: GhRunner = run_gh) -> int:
    """Entry point; returns the process exit code."""
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("mode", help="resolve enforce/report from the workflow environment")
    report = commands.add_parser("report", help="evaluate the budgets and render the report")
    report.add_argument("--mode", choices=("report", "enforce"), required=True)
    report.add_argument("--reason", default="")
    report.add_argument("--results", default=".lighthouseci")
    report.add_argument("--config", default="lighthouserc.json")
    report.add_argument("--target", required=True, help="what was measured, for the footer")
    report.add_argument("--commit", required=True)
    report.add_argument("--summary", help="file to append the Markdown to ($GITHUB_STEP_SUMMARY)")
    report.add_argument("--comment-file", help="file to write the pull request comment body to")
    report.add_argument("--json", help="file to write the JSON summary to")
    comment = commands.add_parser(
        "comment", help="create or update the sticky pull request comment"
    )
    comment.add_argument("--repo", required=True)
    comment.add_argument("--pull", type=int, required=True)
    comment.add_argument("--body-file", required=True)
    args = parser.parse_args(argv)
    if args.command == "mode":
        return _run_mode()
    if args.command == "report":
        return _run_report(args)
    return _run_comment(args, gh)


if __name__ == "__main__":
    raise SystemExit(main())
