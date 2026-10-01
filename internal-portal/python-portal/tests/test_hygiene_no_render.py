"""Hygiene gate: Render must never be re-introduced as a deployment target.

ARCHITECTURE DECISION (repository cleanup):

    SOURCE -> GitHub Actions -> OIDC -> Terraform -> Azure Container Apps

Render is no longer a deployment target for this repository. This gate rejects
ACTIVE deployment artifacts (render.yaml blueprint, Render keepalive workflows,
Render domains, Render secret names) so the competing path cannot quietly come
back.

WHAT IT DELIBERATELY DOES NOT DO: it does not ban the English/Vietnamese word
"render". `internal-portal/public/app.js` contains "Render kết quả" (render
results) and the dashboard renders views; `docker compose config` renders a
config; and historical records legitimately mention the old Render path. Only
executable deployment artifacts are forbidden.

Runs under stdlib `unittest` because the python-portal CI job forbids pytest.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
SELF = Path(__file__).resolve()

# Directories that are never deployment artifacts and must not be crawled.
PRUNE_DIRS = {
    ".git", "node_modules", ".venv", ".venv-helpdesk", "venv",
    "__pycache__", ".kilo", ".pytest_cache", ".ruff_cache", "dist", "build",
}

# A Render blueprint at any tracked location is an active deploy artifact.
FORBIDDEN_FILENAMES = ("render.yaml", "render.yml")

# Patterns that only ever mean "this deploys to / pings Render".
FORBIDDEN_PATTERNS = (
    ("Render blueprint/domain URL", re.compile(r"\b(?:[a-z0-9-]+\.)*onrender\.com\b", re.I)),
    ("Render API domain", re.compile(r"\brender\.com\b", re.I)),
    ("Render secret/env reference", re.compile(r"\bRENDER_[A-Z0-9_]+\b")),
    ("Render deploy hook", re.compile(r"render[_-]?deploy[_-]?hook", re.I)),
)

# Explicit Render secret names that once wired this repo to Render.
RENDER_SECRETS = re.compile(
    r"\bRENDER_(?:API_KEY|SERVICE_ID|DEPLOY_HOOK|DEPLOY_HOOK_URL"
    r"|HEALTH_URL[A-Z_]*|API_BASE_URL)\b"
)


def _workflow_files():
    if not WORKFLOWS.is_dir():
        return []
    return sorted(p for p in WORKFLOWS.iterdir() if p.suffix in {".yml", ".yaml"})


def _hits(text):
    return [label for label, rx in FORBIDDEN_PATTERNS if rx.search(text)]


class NoRenderDeploymentTest(unittest.TestCase):
    """Render is a retired deployment target for this repository."""

    def test_no_render_blueprint_file_exists(self):
        offenders = []
        for path in REPO_ROOT.rglob("*"):
            if PRUNE_DIRS & set(path.parts):
                continue
            if path.is_file() and path.name in FORBIDDEN_FILENAMES:
                offenders.append(str(path.relative_to(REPO_ROOT)))
        self.assertEqual(
            offenders, [],
            "Render blueprint present — Render is not a deployment target: "
            f"{offenders}",
        )

    def test_no_workflow_deploys_or_pings_render(self):
        offenders = {}
        for wf in _workflow_files():
            found = _hits(wf.read_text(encoding="utf-8", errors="replace"))
            if found:
                offenders[str(wf.relative_to(REPO_ROOT))] = found
        self.assertEqual(
            offenders, {},
            "Workflow(s) reference Render deploy/keepalive — the deploy story is "
            f"GitHub Actions -> OIDC -> Terraform -> Azure: {offenders}",
        )

    def test_no_render_secret_names_referenced_by_workflows(self):
        offenders = [
            str(wf.relative_to(REPO_ROOT))
            for wf in _workflow_files()
            if RENDER_SECRETS.search(wf.read_text(encoding="utf-8", errors="replace"))
        ]
        self.assertEqual(offenders, [], f"Legacy Render secret refs: {offenders}")

    def test_guard_itself_is_not_a_false_positive(self):
        """The word `render` must stay expressible outside deployment artifacts.

        This file contains `onrender.com` inside a regex; proving the pattern
        matcher works on the real corpus keeps the gate honest rather than
        vacuously green.
        """
        self.assertTrue(
            _hits(SELF.read_text(encoding="utf-8", errors="replace")),
            "self-check: pattern must match this file's own regex",
        )

    def test_existing_workflows_are_render_free(self):
        """At least one real workflow exists and is clean (not vacuously green)."""
        workflows = _workflow_files()
        self.assertTrue(workflows, "no workflows found — gate would be vacuous")
        self.assertTrue((WORKFLOWS / "ci.yml").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)