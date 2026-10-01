#!/usr/bin/env bash
# IaC validation for Enterprise IT Helpdesk Lab.
# Compiles Bicep templates, validates parameter files, and checks security invariants.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
OFF=$'\033[0m'

failures=0
pass() { printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
fail() {
  printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$1"
  if [[ -n "${2:-}" ]]; then printf '        %s\n' "$2"; fi
  failures=$((failures + 1))
}

BICEP_CMD=""
if command -v bicep >/dev/null 2>&1; then
  BICEP_CMD="bicep"
elif [ -x "$HOME/.azure/bin/bicep" ]; then
  BICEP_CMD="$HOME/.azure/bin/bicep"
elif command -v az >/dev/null 2>&1 && az bicep version >/dev/null 2>&1; then
  BICEP_CMD="az bicep"
else
  printf '%sERROR%s  bicep CLI not found.\n' "$RED" "$OFF"
  exit 2
fi

printf '%s-- 1. compile every template (errors and warnings fatal)%s\n' "$BOLD" "$OFF"
while IFS= read -r -d '' bicep_file; do
  rel_path="${bicep_file#"$SCRIPT_DIR"/}"
  stderr_out=$( $BICEP_CMD build "$bicep_file" --stdout 2>&1 >/dev/null || true )
  if [[ -n "$stderr_out" ]]; then
    fail "compile $rel_path" "$stderr_out"
  else
    pass "compile $rel_path"
  fi
done < <(find . -type f -name "*.bicep" -print0 | sort -z)

printf '\n%s-- 2. committed parameter files resolve%s\n' "$BOLD" "$OFF"
while IFS= read -r -d '' param_file; do
  rel_path="${param_file#"$SCRIPT_DIR"/}"
  stderr_out=$( $BICEP_CMD build-params "$param_file" --stdout 2>&1 >/dev/null || true )
  if [[ -n "$stderr_out" ]]; then
    fail "params  $rel_path" "$stderr_out"
  else
    pass "params  $rel_path"
  fi
done < <(find parameters -type f -name "*.bicepparam" -print0 | sort -z)

printf '\n%s-- 3. traversal contract tests%s\n' "$BOLD" "$OFF"
if python3 scripts/test_checker_traversal.py check_invariants.py; then
  pass "16/16 traversal contracts hold"
else
  fail "traversal contracts failed"
fi

printf '\n%s-- 4. compile root template & assert invariants%s\n' "$BOLD" "$OFF"
TMP_ARM=$(mktemp)
$BICEP_CMD build main.bicep --outfile "$TMP_ARM" >/dev/null 2>&1
if python3 check_invariants.py "$TMP_ARM"; then
  pass "all security invariants held on main.bicep"
else
  fail "security invariants violated on main.bicep"
fi
rm -f "$TMP_ARM"

printf '\n%s-- 5. no secret values or real tenant IDs in parameter files%s\n' "$BOLD" "$OFF"
for f in parameters/*.bicepparam; do
  if grep -E "tenantId\s*=\s*'00000000-0000-0000-0000-000000000000'" "$f" >/dev/null 2>&1; then
    pass "tenant id is zero-GUID placeholder in $f"
  else
    fail "tenant id in $f is not zero-GUID placeholder"
  fi
done

if [[ $failures -gt 0 ]]; then
  printf '\n%s== IaC validation: %d CHECK(S) FAILED ==%s\n' "$RED" "$failures" "$OFF"
  exit 1
fi

printf '\n%s== IaC validation: ALL CHECKS PASSED ==%s\n' "$GREEN" "$OFF"
printf 'No Azure resource was created, updated or deleted by this run.\n'
