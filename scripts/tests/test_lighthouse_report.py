"""Tests for ``scripts/lighthouse_report.py``: gate mode, budget evaluation, report rendering, comment."""

import json
import runpy
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lighthouse_report as lr  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HOME = "http://127.0.0.1:4173/"
METHODOLOGY = "http://127.0.0.1:4173/methodology"


def make_lhr(  # noqa: PLR0913
    url: str,
    *,
    perf: float | None = 0.95,
    a11y: float = 1,
    best: float = 1,
    seo: float = 1,
    lcp: float | None = 1800,
    cls: float = 0.0,
    tbt: float = 50,
    fcp: float = 900,
    interactive: float = 1500,
) -> dict[str, object]:
    """A minimal Lighthouse result carrying only the fields the report reads."""
    audits: dict[str, object] = {
        "cumulative-layout-shift": {"numericValue": cls},
        "total-blocking-time": {"numericValue": tbt},
        "first-contentful-paint": {"numericValue": fcp},
        "interactive": {"numericValue": interactive},
    }
    if lcp is not None:
        audits["largest-contentful-paint"] = {"numericValue": lcp}
    return {
        "finalUrl": url,
        "categories": {
            "performance": {"score": perf},
            "accessibility": {"score": a11y},
            "best-practices": {"score": best},
            "seo": {"score": seo},
        },
        "audits": audits,
    }


def write_results(directory: Path, *lhrs: dict[str, object]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for index, lhr in enumerate(lhrs):
        (directory / f"lhr-{index:03d}.json").write_text(json.dumps(lhr), encoding="utf-8")
    (directory / "manifest.json").write_text("[]", encoding="utf-8")  # must be ignored
    return directory


@pytest.fixture
def config() -> dict[str, object]:
    return json.loads((ROOT / "lighthouserc.json").read_text(encoding="utf-8"))


# --- gate mode ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("event", "base", "ref", "switch", "enforce"),
    [
        ("pull_request", "main", "12/merge", "", True),
        ("push", "", "main", "", True),
        ("workflow_dispatch", "", "main", "", True),
        ("pull_request", "feat/weather-aware-routing", "12/merge", "", False),
        ("push", "", "feat/weather-aware-routing", "false", False),
        ("workflow_dispatch", "", "some-branch", "", False),
        ("pull_request", "feat/weather-aware-routing", "12/merge", "true", True),
        ("push", "", "feat/weather-aware-routing", " TRUE ", True),
        ("pull_request", "main", "12/merge", "false", True),
    ],
)
def test_resolve_mode(event: str, base: str, ref: str, switch: str, enforce: bool) -> None:  # noqa: FBT001
    mode = lr.resolve_mode(event, base, ref, switch)

    assert mode.enforce is enforce
    assert mode.name == ("enforce" if enforce else "report")
    assert mode.reason


def test_resolve_mode_names_why_it_enforces() -> None:
    assert "main" in lr.resolve_mode("pull_request", "main", "1/merge", "").reason
    assert lr.SWITCH in lr.resolve_mode("push", "", "feat/x", "true").reason
    assert lr.SWITCH in lr.resolve_mode("push", "", "feat/x", "").reason


def test_resolve_mode_rejects_an_ambiguous_switch() -> None:
    with pytest.raises(ValueError, match="LIGHTHOUSE_ENFORCE"):
        lr.resolve_mode("push", "", "feat/x", "yes")


# --- budgets --------------------------------------------------------------------------------------


def test_the_repository_budgets_are_the_n1_budgets(config: dict[str, object]) -> None:
    budgets = {budget.key: budget for budget in lr.load_budgets(config)}

    assert budgets["categories:performance"].minimum == 0.9
    assert all(budgets[f"categories:{name}"].minimum == 1 for name in ("accessibility", "seo"))
    assert budgets["categories:best-practices"].minimum == 1
    assert budgets["largest-contentful-paint"].maximum == 2500
    assert budgets["cumulative-layout-shift"].maximum == 0.05
    assert budgets["total-blocking-time"].maximum == 200
    assert {budget.level for budget in budgets.values()} == {"error"}


def test_load_budgets_skips_assertions_that_are_off() -> None:
    config = {"ci": {"assert": {"aggregationMethod": "median-run", "assertions": {
        "categories:seo": ["off", {}],
        "total-blocking-time": ["warn", {"maxNumericValue": 300}],
    }}}}  # fmt: skip

    budgets = lr.load_budgets(config)

    assert [(b.key, b.level, b.maximum) for b in budgets] == [("total-blocking-time", "warn", 300)]


@pytest.mark.parametrize(
    "assertion",
    [
        ["error", {"minScore": 0.9, "maxLength": 1}],
        ["error", {"maxLength": 1}],
        ["error"],
        "error",
        ["fatal", {"minScore": 1}],
    ],
)
def test_load_budgets_rejects_assertions_it_cannot_evaluate(assertion: object) -> None:
    config = {"ci": {"assert": {"aggregationMethod": "median-run", "assertions": {"x": assertion}}}}

    with pytest.raises(ValueError, match="x"):
        lr.load_budgets(config)


def test_load_budgets_requires_the_median_run_aggregation() -> None:
    config = {"ci": {"assert": {"aggregationMethod": "pessimistic", "assertions": {}}}}

    with pytest.raises(ValueError, match="median-run"):
        lr.load_budgets(config)


# --- representative runs --------------------------------------------------------------------------


def test_the_representative_run_is_the_one_closest_to_the_median_fcp_and_interactive() -> None:
    fast = make_lhr(HOME, perf=0.99, fcp=800, interactive=1000)
    middle = make_lhr(HOME, perf=0.93, fcp=1000, interactive=1400)
    slow = make_lhr(HOME, perf=0.80, fcp=2000, interactive=3000)

    chosen = lr.representative_runs([slow, fast, middle])

    assert chosen == {HOME: middle}


def test_the_representative_runs_are_chosen_per_url_in_first_seen_order() -> None:
    home = [make_lhr(HOME, fcp=900), make_lhr(HOME, fcp=950), make_lhr(HOME, fcp=1000)]
    methodology = [make_lhr(METHODOLOGY, fcp=500), make_lhr(METHODOLOGY, fcp=600)]

    chosen = lr.representative_runs([*home, *methodology])

    assert list(chosen) == [HOME, METHODOLOGY]
    assert chosen[HOME] is home[1]
    assert chosen[METHODOLOGY] is methodology[1]  # an even count takes the upper median, like LHCI


def test_a_tie_keeps_the_earlier_run() -> None:
    first = make_lhr(HOME, perf=0.91)
    second = make_lhr(HOME, perf=0.92)

    assert lr.representative_runs([first, second])[HOME] is first


def test_a_run_without_a_metric_counts_as_zero_for_that_metric() -> None:
    complete = make_lhr(HOME, perf=0.91, interactive=1500)
    partial = make_lhr(HOME, perf=0.92)
    del partial["audits"]["interactive"]  # type: ignore[attr-defined]

    assert lr.representative_runs([complete, partial])[HOME] is complete


# --- evaluation -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("field", "value", "passes"),
    [
        ("perf", 0.9, True),
        ("perf", 0.89, False),
        ("a11y", 0.99, False),
        ("lcp", 2500, True),
        ("lcp", 2500.1, False),
        ("cls", 0.05, True),
        ("cls", 0.051, False),
        ("tbt", 200, True),
        ("tbt", 201, False),
    ],
)
def test_budget_boundaries_match_lhci(
    config: dict[str, object],
    field: str,
    value: float,
    passes: bool,  # noqa: FBT001
) -> None:
    budgets = lr.load_budgets(config)

    checks = lr.evaluate(make_lhr(HOME, **{field: value}), budgets)

    assert all(check.passed for check in checks) is passes


def test_a_budget_without_a_measurement_fails_instead_of_passing_silently(
    config: dict[str, object],
) -> None:
    budgets = lr.load_budgets(config)

    checks = lr.evaluate(make_lhr(HOME, perf=None, lcp=None), budgets)

    failed = {check.budget.key: check for check in checks if not check.passed}
    assert set(failed) == {"categories:performance", "largest-contentful-paint"}
    assert all(check.actual is None for check in failed.values())


# --- rendering ------------------------------------------------------------------------------------


def render(config: dict[str, object], mode: lr.Mode, *lhrs: dict[str, object]) -> lr.Report:
    budgets = lr.load_budgets(config)
    return lr.build_report(
        lhrs, budgets, mode, target="the local build served like Vercel", commit="0123456789abcdef"
    )


def test_a_passing_report_says_so_and_shows_every_page(config: dict[str, object]) -> None:
    report = render(
        config,
        lr.Mode(enforce=True, reason="pull requests into main"),
        make_lhr(HOME),
        make_lhr(METHODOLOGY),
    )

    assert report.failures == []
    assert lr.MARKER in report.markdown
    assert "all budgets met" in report.markdown
    assert "| `/` |" in report.markdown
    assert "| `/methodology` |" in report.markdown
    assert "0123456" in report.markdown
    assert "the local build served like Vercel" in report.markdown


def test_a_failing_report_names_the_misses_and_the_mode(config: dict[str, object]) -> None:
    lhr = make_lhr(HOME, perf=0.895, best=0.96, lcp=3004.2557)
    report = render(config, lr.Mode(enforce=False, reason="integration branch"), lhr)

    assert len(report.failures) == 3
    assert "3 budgets missed" in report.markdown
    assert "report-only" in report.markdown
    assert "89.5 ❌" in report.markdown
    assert "96 ❌" in report.markdown
    assert "3.00 s ❌" in report.markdown
    assert "100 ✅" in report.markdown


def test_an_enforced_failure_says_it_blocks(config: dict[str, object]) -> None:
    report = render(config, lr.Mode(enforce=True, reason="x"), make_lhr(HOME, tbt=450))

    assert "1 budget missed" in report.markdown
    assert "blocking" in report.markdown
    assert "450 ms ❌" in report.markdown


def test_a_warn_level_miss_is_shown_but_does_not_count_as_a_failure() -> None:
    config = {"ci": {"assert": {"aggregationMethod": "median-run", "assertions": {
        "total-blocking-time": ["warn", {"maxNumericValue": 100}],
    }}}}  # fmt: skip

    report = render(config, lr.Mode(enforce=True, reason="x"), make_lhr(HOME, tbt=150))

    assert report.failures == []
    assert "150 ms ⚠️" in report.markdown


def test_the_budget_row_and_unknown_audit_keys_are_rendered_generically() -> None:
    config = {"ci": {"assert": {"aggregationMethod": "median-run", "assertions": {
        "categories:performance": ["error", {"minScore": 0.9}],
        "speed-index": ["error", {"maxNumericValue": 3400}],
    }}}}  # fmt: skip
    lhr = make_lhr(HOME)
    lhr["audits"]["speed-index"] = {"numericValue": 2100.4}  # type: ignore[index]

    markdown = render(config, lr.Mode(enforce=True, reason="x"), lhr).markdown

    assert "| Budget | ≥ 90 | ≤ 3400 |" in markdown
    assert "| `/` | 95 ✅ | 2100.4 ✅ |" in markdown


def test_a_budget_without_a_measurement_is_shown_as_not_available(
    config: dict[str, object],
) -> None:
    report = render(config, lr.Mode(enforce=True, reason="x"), make_lhr(HOME, perf=None))

    assert "n/a ❌" in report.markdown
    assert [check.budget.key for _, check in report.failures] == ["categories:performance"]


def test_the_json_summary_carries_the_values_for_the_handoff(config: dict[str, object]) -> None:
    report = render(config, lr.Mode(enforce=False, reason="r"), make_lhr(HOME, perf=0.89))

    summary = report.summary

    assert summary["mode"] == "report"
    assert summary["budgets_met"] is False
    assert summary["pages"][0]["url"] == HOME  # type: ignore[index]
    assert summary["pages"][0]["values"]["categories:performance"] == 0.89  # type: ignore[index]
    assert summary["pages"][0]["failures"] == ["categories:performance"]  # type: ignore[index]


# --- command line: report -------------------------------------------------------------------------


def report_args(tmp_path: Path, mode: str) -> list[str]:
    return [
        "report",
        "--mode", mode,
        "--results", str(tmp_path / "results"),
        "--config", str(ROOT / "lighthouserc.json"),
        "--target", "the local build served like Vercel",
        "--commit", "0123456789abcdef",
        "--summary", str(tmp_path / "summary.md"),
        "--comment-file", str(tmp_path / "comment.md"),
        "--json", str(tmp_path / "summary.json"),
    ]  # fmt: skip


def test_report_publishes_everything_and_fails_only_when_the_mode_is_enforcing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_results(tmp_path / "results", make_lhr(HOME, perf=0.5), make_lhr(HOME, perf=0.5))

    assert lr.main(report_args(tmp_path, "report")) == 0
    assert "::warning" in capsys.readouterr().out
    assert lr.main(report_args(tmp_path, "enforce")) == 1
    assert "::error" in capsys.readouterr().out

    assert lr.MARKER in (tmp_path / "comment.md").read_text(encoding="utf-8")
    assert "budget" in (tmp_path / "summary.md").read_text(encoding="utf-8")
    assert (
        json.loads((tmp_path / "summary.json").read_text(encoding="utf-8"))["budgets_met"] is False
    )


def test_report_succeeds_when_the_budgets_are_met_in_either_mode(tmp_path: Path) -> None:
    write_results(tmp_path / "results", make_lhr(HOME), make_lhr(METHODOLOGY))

    assert lr.main(report_args(tmp_path, "enforce")) == 0
    assert lr.main(report_args(tmp_path, "report")) == 0


def test_report_appends_to_an_existing_job_summary(tmp_path: Path) -> None:
    write_results(tmp_path / "results", make_lhr(HOME))
    (tmp_path / "summary.md").write_text("earlier step\n", encoding="utf-8")

    lr.main(report_args(tmp_path, "report"))

    text = (tmp_path / "summary.md").read_text(encoding="utf-8")
    assert text.startswith("earlier step\n")
    assert "Lighthouse" in text


def test_report_without_the_optional_outputs_only_prints(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    write_results(tmp_path / "results", make_lhr(HOME, perf=0.5))
    args = report_args(tmp_path, "report")[:11]  # up to and including --commit <sha>

    assert lr.main(args) == 0

    assert "::warning" in capsys.readouterr().out
    assert sorted(path.name for path in tmp_path.iterdir()) == ["results"]


def test_report_fails_loudly_when_lighthouse_produced_no_results(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "results").mkdir()

    assert lr.main(report_args(tmp_path, "report")) == 2
    assert "no Lighthouse results" in capsys.readouterr().err


def test_report_escapes_annotation_text(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert lr.escape_annotation("50%\nnext\r") == "50%25%0Anext%0D"
    write_results(tmp_path / "results", make_lhr(HOME, perf=0.5))

    lr.main(report_args(tmp_path, "report"))

    assert "performance" in capsys.readouterr().out.lower()


# --- command line: mode ---------------------------------------------------------------------------


def test_mode_command_writes_the_step_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_BASE_REF", "main")
    monkeypatch.setenv("GITHUB_REF_NAME", "7/merge")
    monkeypatch.setenv(lr.SWITCH, "")

    assert lr.main(["mode"]) == 0

    assert output.read_text(encoding="utf-8").splitlines()[0] == "mode=enforce"
    assert "enforce" in capsys.readouterr().out


def test_mode_command_without_a_step_output_file_only_prints(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_BASE_REF", "feat/weather-aware-routing")
    monkeypatch.setenv("GITHUB_REF_NAME", "7/merge")
    monkeypatch.delenv(lr.SWITCH, raising=False)

    assert lr.main(["mode"]) == 0

    assert "report" in capsys.readouterr().out


def test_the_script_can_be_run_directly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["lighthouse_report.py", "mode"])
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("GITHUB_REF_NAME", "main")
    monkeypatch.delenv("GITHUB_BASE_REF", raising=False)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)

    with pytest.raises(SystemExit) as stopped:
        runpy.run_path(str(Path(lr.__file__)), run_name="__main__")

    assert stopped.value.code == 0


def test_mode_command_reports_a_bad_switch(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "push")
    monkeypatch.setenv("GITHUB_REF_NAME", "feat/x")
    monkeypatch.delenv("GITHUB_BASE_REF", raising=False)
    monkeypatch.setenv(lr.SWITCH, "maybe")

    assert lr.main(["mode"]) == 1
    assert "LIGHTHOUSE_ENFORCE" in capsys.readouterr().err


# --- sticky comment -------------------------------------------------------------------------------

BOT = {"login": "github-actions[bot]", "type": "Bot"}
HUMAN = {"login": "someone", "type": "User"}


class FakeGh:
    """Records ``gh api`` calls and answers like the GitHub API."""

    def __init__(self, comments: list[dict[str, object]]) -> None:
        self.comments = comments
        self.calls: list[tuple[list[str], str | None]] = []

    def __call__(self, args: Sequence[str], stdin: str | None = None) -> str:
        self.calls.append((list(args), stdin))
        if "--paginate" in args:
            return json.dumps([self.comments[:1], self.comments[1:]])  # --slurp: one array per page
        return json.dumps({"id": 99})


def test_the_comment_is_created_when_there_is_none() -> None:
    gh = FakeGh([{"id": 1, "user": HUMAN, "body": "LGTM"}])

    outcome = lr.upsert_comment(gh, "o/r", 7, f"{lr.MARKER}\nbody")

    assert outcome == "created"
    args, stdin = gh.calls[-1]
    assert args[:3] == ["api", "--method", "POST"]
    assert args[-1] == "repos/o/r/issues/7/comments"
    assert json.loads(stdin or "") == {"body": f"{lr.MARKER}\nbody"}


def test_the_existing_comment_of_the_bot_is_updated_in_place_across_pages() -> None:
    comments = [
        {"id": 1, "user": HUMAN, "body": f"{lr.MARKER} spoofed by a person"},
        {"id": 2, "user": BOT, "body": "something else"},
        {"id": 3, "user": BOT, "body": f"{lr.MARKER}\nold report"},
    ]
    gh = FakeGh(comments)

    outcome = lr.upsert_comment(gh, "o/r", 7, f"{lr.MARKER}\nnew report")

    assert outcome == "updated"
    args, stdin = gh.calls[-1]
    assert args[:3] == ["api", "--method", "PATCH"]
    assert args[-1] == "repos/o/r/issues/comments/3"
    assert json.loads(stdin or "")["body"].endswith("new report")


def test_comment_command_reads_the_body_file(tmp_path: Path) -> None:
    body = tmp_path / "comment.md"
    body.write_text(f"{lr.MARKER}\nhello", encoding="utf-8")
    gh = FakeGh([])

    code = lr.main(["comment", "--repo", "o/r", "--pull", "7", "--body-file", str(body)], gh=gh)

    assert code == 0
    assert json.loads(gh.calls[-1][1] or "")["body"].endswith("hello")


def test_a_comment_that_cannot_be_published_is_a_warning_not_a_failure(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    body = tmp_path / "comment.md"
    body.write_text(lr.MARKER, encoding="utf-8")

    def refuse(args: Sequence[str], stdin: str | None = None) -> str:
        raise subprocess.CalledProcessError(
            1, ["gh", *args], stderr="HTTP 403: Resource not accessible"
        )

    code = lr.main(["comment", "--repo", "o/r", "--pull", "7", "--body-file", str(body)], gh=refuse)

    assert code == 0
    assert "::warning" in capsys.readouterr().out


def test_run_gh_passes_arguments_and_stdin_to_the_gh_binary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        seen.update(command=command, **kwargs)
        return subprocess.CompletedProcess(command, 0, stdout='{"ok": true}', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert lr.run_gh(["api", "x"], '{"a": 1}') == '{"ok": true}'
    assert seen["command"] == ["gh", "api", "x"]
    assert seen["input"] == '{"a": 1}'
    assert seen["check"] is True
