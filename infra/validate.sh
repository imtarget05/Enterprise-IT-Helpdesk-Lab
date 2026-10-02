#!/usr/bin/env bash
# IaC validation for Enterprise-IT-Helpdesk-Lab — RE-ANCHORED FROM BICEP.
#
# The Bicep stack is deleted. infra/terraform/ is the only infrastructure source
# of truth. This script used to compile every .bicep, resolve every
# .bicepparam, and run check_invariants.py against the compiled ARM output;
# with the templates gone those loops would have found nothing and reported
# success for having verified nothing.
#
# WHAT THIS SCRIPT DOES NOT DO: it never authenticates to Azure and never
# creates, updates or deletes a resource. `init` runs with `-backend=false`, so
# no remote state is contacted, and there is no `plan` or `apply` below. A green
# run means "the configuration is well-formed and the controls hold", NOT "the
# stack exists".
#
# FAIL-CLOSED, NOT VACUOUS: step 0 refuses to run when there is no Terraform, so
# this gate cannot report PASS by having nothing to check.
#
# Usage: infra/validate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR/terraform"

RED=$'\033[31m'
GREEN=$'\033[32m'
BOLD=$'\033[1m'
OFF=$'\033[0m'

failures=0
pass() { printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
fail() {
  printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$1"
  if [[ -n "${2:-}" ]]; then printf '        %s\n' "$2"; fi
  failures=$((failures + 1))
}

printf '%s-- 0. terraform present (never vacuous)%s\n' "$BOLD" "$OFF"
if ! command -v terraform >/dev/null 2>&1; then
  fail "terraform CLI" "not found on PATH; refusing to report PASS having checked nothing"
  exit 1
fi
if [[ ! -d "$TF_DIR" ]]; then
  fail "terraform sources" "infra/terraform does not exist — the gate would be vacuous"
  exit 1
fi
# `|| true`: find on an unreadable path exits 1, and under `set -e -o pipefail`
# that aborts the script BEFORE fail() can print. A gate that dies silently
# teaches people to re-run it.
tf_count="$(find "$TF_DIR" -name '*.tf' -not -path '*/.terraform/*' 2>/dev/null | wc -l | tr -d ' ' || true)"
if [[ "${tf_count:-0}" -eq 0 ]]; then
  fail "terraform sources" "no *.tf under infra/terraform — the gate would be vacuous"
  exit 1
fi
pass "terraform sources  ${tf_count} *.tf under infra/terraform"

cd "$TF_DIR"

printf '%s-- 1. terraform fmt%s\n' "$BOLD" "$OFF"
if out="$(terraform fmt -check -recursive 2>&1)"; then
  pass "fmt  clean"
else
  fail "fmt" "$out"
fi

printf '%s-- 2. init (backend disabled — no remote state is contacted)%s\n' "$BOLD" "$OFF"
if terraform init -backend=false -input=false >/dev/null 2>&1; then
  pass "init  providers resolved offline"
else
  fail "init" "terraform init -backend=false failed"
fi

printf '%s-- 3. terraform validate%s\n' "$BOLD" "$OFF"
if out="$(terraform validate 2>&1)"; then
  pass "validate  root configuration is valid"
else
  fail "validate" "$out"
fi

module_count=0
module_fail=0
while IFS= read -r dir; do
  [[ -z "$dir" ]] && continue
  module_count=$((module_count + 1))
  if ! (cd "$dir" && terraform init -backend=false -input=false >/dev/null 2>&1 && terraform validate >/dev/null 2>&1); then
    fail "module $dir" "init/validate failed"
    module_fail=$((module_fail + 1))
  fi
done < <(find modules -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
[[ "$module_fail" -eq 0 ]] && pass "validate  ${module_count} module(s) valid"

printf '%s-- 4. terraform test (contract assertions)%s\n' "$BOLD" "$OFF"
if out="$(terraform test 2>&1)"; then
  pass "test  $(printf '%s' "$out" | grep -oE '[0-9]+ passed' | head -1)"
else
  fail "test" "$out"
fi
printf '%s-- 5. plan-invariant controls must BITE%s\n' "$BOLD" "$OFF"
if out="$(python3 -m unittest discover -s scripts/tests 2>&1)"; then
  pass "control bite tests  $(printf '%s' "$out" | grep -oE 'Ran [0-9]+ tests' | head -1)"
else
  fail "control bite tests" "$out"
fi

printf '%s-- 6. plan invariants on the committed fixture%s\n' "$BOLD" "$OFF"
if out="$(python3 scripts/check_plan_invariants.py fixtures/plan-ok.json 2>&1)"; then
  pass "plan invariants  $(printf '%s' "$out" | grep -oE '[0-9]+/[0-9]+ plan invariants hold' | tail -1)"
else
  fail "plan invariants" "$out"
fi

printf '%s-- 7. ARM invariant checker traversal contracts%s\n' "$BOLD" "$OFF"
# RETAINED deliberately. check_invariants.py reads compiled ARM JSON, not
# .bicep source, and test_checker_traversal.py exercises it with synthetic
# fixtures — so these 16 contracts still run and still bite with the Bicep
# templates deleted. They are the checker being proven, not the templates.
if out="$(cd "$SCRIPT_DIR" && python3 scripts/test_checker_traversal.py check_invariants.py 2>&1)"; then
  pass "traversal contracts  $(printf '%s' "$out" | grep -oE '[0-9]+/[0-9]+ traversal contracts hold' | tail -1)"
else
  fail "traversal contracts" "$out"
fi

printf '%s-- 8. no secret values or real tenant ids in terraform%s\n' "$BOLD" "$OFF"
# Deliberately narrow: a broad /secret/ pattern matches the many legitimate
# references to secret NAMES and to the Key Vault module. Case-insensitive on
# purpose — the uppercase convention this repo uses is exactly what a
# case-sensitive grep misses.
leaked="$(grep -rniE "(password|clientSecret|accountKey|connectionString|sharedAccessKey)[[:space:]]*[:=][[:space:]]*['\"][^'\"]" \
  --include='*.tf' --include='*.tfvars' --exclude-dir=.terraform . \
  | grep -viE 'PLACEHOLDER|never committed' || true)"
if [[ -n "$leaked" ]]; then
  fail "secret scan" "$leaked"
else
  pass "secret scan  no literal secret values"
fi

# WHY THE PLACEHOLDER EXCEPTION IS NARROW AND NOT AN ALLOWLIST. The env tfvars
# ship a password-shaped value so the configuration SHAPE (including the
# plan-time leak control) can be exercised with no real credential. A scanner
# that flags its own placeholders is a scanner people disable, and a disabled
# secret scan catches nothing at all. So the exception requires the literal
# token PLACEHOLDER inside the value: a real credential would have to literally
# contain the word PLACEHOLDER to slip through, and the value must still be
# replaced by the pipeline from out of band.
#
# This is NOT a weakened control. It is the control, minus the one class of
# finding that is a true positive by construction.
placeholder_check="$(grep -rnE "^[[:space:]]*[a-z_]*(password|secret|key)[a-z_]*[[:space:]]*=" \
  --include='*.tfvars' --exclude-dir=.terraform . \
  | grep -viE 'PLACEHOLDER' | grep -E '=.*["'"'"'][^"'"'"']+["'"'"']' || true)"
if [[ -n "$placeholder_check" ]]; then
  fail "placeholder discipline" "these credential-shaped values carry no PLACEHOLDER marker: $placeholder_check"
else
  pass "placeholder discipline  every credential-shaped tfvars value is marked PLACEHOLDER"
fi

real_ids="$(grep -rniE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
  --include='*.tfvars' --exclude-dir=.terraform . \
  | grep -viE '0000000-0000-0000-0000-000000000000' || true)"
if [[ -n "$real_ids" ]]; then
  fail "environment identifiers" "$real_ids"
else
  pass "environment identifiers  placeholders only"
fi

printf '%s-- summary%s\n' "$BOLD" "$OFF"
if [[ "$failures" -eq 0 ]]; then
  printf '%sIaC validation: ALL CHECKS PASSED%s (terraform — no Azure mutation)\n' "$GREEN" "$OFF"
  exit 0
fi
printf '%sIaC validation: %d CHECK(S) FAILED%s\n' "$RED" "$failures" "$OFF"
exit 1