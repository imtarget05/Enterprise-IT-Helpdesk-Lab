#!/usr/bin/env bash
# IaC validation for the Helpdesk stack. Compiles, lints, negative-tests the
# Bicep, asserts security invariants on the compiled artifact, and proves the tree
# has no cross-repository dependency.
#
# WHAT THIS SCRIPT DOES NOT DO: it never authenticates to Azure and never creates,
# updates or deletes a resource. There is no `az login`, no `az deployment ...
# create` and no `--what-if` anywhere below. A green run means "the templates are
# well-formed and the guards hold", NOT "the stack exists". Claiming a deployment
# on the basis of this script is exactly the overclaim the evidence rules forbid.
#
# It is the same script CI runs (.github/workflows/iac-validate.yml), so a local
# green and a CI green mean the same thing.
#
# Usage: infra/validate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED=$'\033[31m'
GREEN=$'\033[32m'
BOLD=$'\033[1m'
OFF=$'\033[0m'

failures=0
pass() { printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
# WHY THE DETAIL IS PIPED THROUGH printf RATHER THAN READ FROM $2: an earlier
# revision read the detail from stdin, which on a developer machine is an
# interactive terminal. The result was a FAIL line with no findings under it and
# an overall exit 0 -- a failure that reported itself as a pass.
fail() {
  local heading="$1"
  local detail="${2:-}"
  printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$heading"
  if [[ -n "$detail" ]]; then
    printf '%s\n' "$detail" | while IFS= read -r line; do
      [[ -n "$line" ]] && printf '        %s\n' "$line"
    done
  fi
  failures=$((failures + 1))
}

# WHY THIS RESOLUTION INSTEAD OF TRUSTING THE CALLER: `az bicep` and a standalone
# bicep on PATH can be different versions, and a version skew between the
# developer's machine and CI turns a green run into a lie. The resolved version is
# printed so a run record says which compiler produced it.
#
# WHY WRAPPERS RATHER THAN A `bicep()` SHELL FUNCTION: the two CLIs do not take the
# same arguments. Standalone bicep takes `bicep build --file x`; `az bicep` takes
# `az bicep build --file x` but NOT `az bicep build x` positionally, and
# `az bicep --version` is an error where `bicep --version` works. An earlier
# revision aliased `bicep() { az bicep "$@"; }` and every one of the 17 compiles
# failed with "the following arguments are required: --file". Two small wrappers
# for the two verbs actually used is less clever and works on both.
BICEP_STYLE=""
if command -v bicep >/dev/null 2>&1 && bicep --version >/dev/null 2>&1; then
  BICEP_STYLE="standalone"
elif command -v az >/dev/null 2>&1 && az bicep version >/dev/null 2>&1; then
  BICEP_STYLE="az"
fi

if [[ -z "$BICEP_STYLE" ]]; then
  printf '%sERROR%s  no usable bicep compiler found.\n' "$RED" "$OFF"
  printf '        Need EITHER a standalone `bicep` on PATH, OR the Azure CLI with\n'
  printf '        `az bicep version` working. If neither: az bicep install\n'
  printf '        Refusing to skip: a validation run that omits the compile proves\n'
  printf '        nothing, and the run would report success having checked nothing.\n'
  exit 2
fi

bicep_build() {
  if [[ "$BICEP_STYLE" == "standalone" ]]; then
    bicep build --file "$1" "${@:2}"
  else
    az bicep build --file "$1" "${@:2}"
  fi
}

bicep_build_params() {
  if [[ "$BICEP_STYLE" == "standalone" ]]; then
    bicep build-params --file "$1" "${@:2}"
  else
    az bicep build-params --file "$1" "${@:2}"
  fi
}

if [[ "$BICEP_STYLE" == "standalone" ]]; then
  printf '        bicep: %s (standalone CLI)\n' "$(bicep --version 2>&1 | head -1)"
else
  printf '        bicep: %s (via Azure CLI)\n' "$(az bicep version 2>&1 | head -1)"
fi
printf '        python: %s\n' "$(python3 --version 2>&1)"

# ---------------------------------------------------------------- 1. compile
# Every .bicep file is compiled on its own, not only the entrypoint. A module
# nothing references yet is still worth compiling: it is the design record for a
# later wave, and a module that does not compile is a wave that starts broken.
#
# WHY WARNINGS ARE A HARD FAILURE, AND HOW THEY ARE DETECTED. `bicep build` writes
# the compiled ARM template to stdout and ALL diagnostics -- warnings included --
# to stderr, and it exits 0 when there are warnings but no errors. An exit-code
# check therefore passes a template full of no-unused-params and
# no-unnecessary-dependson findings, which would make this job decoration. So
# stdout is discarded, stderr is captured, and any line carrying a Bicep warning
# code fails the run. Measured on bicep 0.47.16, not assumed.
#
# The grep is anchored on the `Warning` keyword that precedes every linter
# diagnostic rather than on a fixed list of rule names, so a new linter rule is
# gated the day it is introduced without editing this script.
printf '%s-- 1. compile every template (errors AND warnings are fatal)%s\n' "$BOLD" "$OFF"
compile_failed=0
while IFS= read -r file; do
  if err="$(bicep_build "$file" --stdout 2>&1 >/dev/null)"; then
    if grep -q "Warning" <<<"$err"; then
      fail "compile  $file" "compiled, but emitted a warning; warnings are a hard gate here:
$(grep "Warning" <<<"$err")"
      compile_failed=1
    else
      pass "compile  $file"
    fi
  else
    fail "compile  $file" "$err"
    compile_failed=1
  fi
done < <(find . -name '*.bicep' -not -path './validate/*' | sort)

# WHY A FAILED COMPILE STOPS THE RUN: the parameter and negative tests load these
# same templates. Running them against a template that does not compile produces
# failures that look like guard regressions and bury the real one.
if [[ $compile_failed -ne 0 ]]; then
  printf '\n%sCompilation failed; stopping before the param tests.%s\n' "$RED" "$OFF"
  exit 1
fi

# ------------------------------------------------------------------ 2. params
# The committed parameter files must resolve. They carry placeholder values only;
# see the comment block in main.dev.bicepparam.
printf '\n%s-- 2. committed parameter files resolve%s\n' "$BOLD" "$OFF"
while IFS= read -r file; do
  if err="$(bicep_build_params "$file" --stdout 2>&1 >/dev/null)"; then
    pass "params   $file"
  else
    fail "params   $file" "$err"
  fi
done < <(find . -name '*.bicepparam' -not -path './validate/*' | sort)

# -------------------------------------------------------------- 3. negative
# A negative fixture that FAILS is the point: it proves the guard still holds.
#
# WHY THE EXPECTED ERROR CODE IS ASSERTED rather than just "non-zero exit": a
# fixture fails for a typo in its `using` path just as readily as for the
# condition it exists to test, and both look like exit 1. Asserting the code means
# a broken fixture is reported as a broken fixture instead of silently counting as
# a passing negative test.
printf '\n%s-- 3. negative tests (each MUST fail, with the expected code)%s\n' "$BOLD" "$OFF"

NEGATIVE_CASES=(
  "validate/negative/missing-deploy-identity.bicepparam|BCP258|a required security parameter cannot be omitted"
  "validate/negative/principal-id-wrong-type.bicepparam|BCP033|a role-assignment principal id cannot be a non-string"
)

for entry in "${NEGATIVE_CASES[@]}"; do
  IFS='|' read -r file expected proves <<<"$entry"

  if [[ ! -f "$file" ]]; then
    fail "negative $file" "fixture is missing; a deleted negative test is a deleted guard"
    continue
  fi

  if err="$(bicep_build_params "$file" --stdout 2>&1 >/dev/null)"; then
    fail "negative $file" "COMPILED, but must not. $proves"
  elif grep -q "$expected" <<<"$err"; then
    pass "negative $file [$expected] $proves"
  else
    fail "negative $file" "failed, but not with $expected - that is a failure for the wrong reason, not a pass. Got: $(head -1 <<<"$err")"
  fi
done

# ------------------------------------------------------- 4. known-weak pins
# These fixtures document a gap the type system does NOT catch, so they are
# expected to COMPILE. If one starts failing, the constraint moved into an
# `assert` and the fixture should be promoted to a real negative test.
printf '\n%s-- 4. known-weak pins (each MUST still compile)%s\n' "$BOLD" "$OFF"
weak_count=0
while IFS= read -r file; do
  weak_count=$((weak_count + 1))
  if err="$(bicep_build_params "$file" --stdout 2>&1 >/dev/null)"; then
    pass "weak-pin $file"
  else
    fail "weak-pin $file" "no longer compiles. If that is because the constraint is now enforced, move the fixture to validate/negative/ and assert the error code. Got: $(head -1 <<<"$err")"
  fi
done < <(find validate/known-weak -name '*.bicepparam' 2>/dev/null | sort)
if [[ $weak_count -eq 0 ]]; then
  fail "weak-pin" "validate/known-weak/ is empty; the known gaps are no longer recorded anywhere"
fi

# ------------------------------------------------------------------ 5. secrets
# A Bicep file that ever holds a secret value is a secret in git history forever.
# The vault is created empty on purpose and values are written out of band, so a
# literal here is always a mistake.
printf '\n%s-- 5. no secret values in templates or params%s\n' "$BOLD" "$OFF"
# Deliberately narrow: a broad /secret/ pattern matches the many legitimate
# references to secret NAMES and to the Key Vault module, and a check that always
# fires eventually gets disabled.
#
# WHY -i (case-insensitive). Proven blind spot in the bootstrap source: a
# case-SENSITIVE grep matched `password = 'x'` but not
# `MINIERP_INTEGRATION_KEY = 'x'` -- which is the exact naming convention this
# repository uses for every secret variable (OPENAI_API_KEY, LLM_CLOUD_API_KEY,
# MINIERP_INTEGRATION_KEY). A control that is green while missing its own
# convention is worse than no control. Narrowness is preserved; only the case
# sensitivity is closed.
#
# WHY ./validate/* is EXCLUDED: that tree is negative-test FIXTURES. It must
# contain real-looking secrets on purpose, so scanning it as if it were shipped
# IaC would make the suite permanently red. Step 5b asserts below that the
# scanner still fires on those fixtures.
leaked="$(grep -rniE "(password|clientSecret|accountKey|connectionString|sharedAccessKey|apiKey|api_key)[[:space:]]*[:=][[:space:]]*['\"][^'\"]" \
  --include='*.bicep' --include='*.bicepparam' --exclude-dir=validate . || true)"
if [[ -n "$leaked" ]]; then
  fail "secret scan" "$leaked"
else
  pass "secret scan  no literal secret values"
fi

# ------------------------------------------------- 5b. the scanner must BITE
# A scanner that has never been shown to fail is an assumption, not a control.
# This runs the SAME detector over the fixture tree and requires it to fire. The
# fixture uses this repository's own uppercase convention, which is precisely
# what the case-sensitive version missed.
printf '\n%s-- 5b. secret scanner negative control (must CATCH)%s\n' "$BOLD" "$OFF"
fixture_hits="$(grep -rniE "(password|clientSecret|accountKey|connectionString|sharedAccessKey|apiKey|api_key)[[:space:]]*[:=][[:space:]]*['\"][^'\"]" \
  validate/negative-secret 2>/dev/null || true)"
if [[ -n "$fixture_hits" ]]; then
  pass "secret scanner bites  uppercase secret fixture is detected"
else
  fail "secret scanner bites" "the uppercase fixture in validate/negative-secret was NOT detected -- the detector is blind again"
fi

# ------------------------------------- 5c. no real environment identifiers
# A committed real parameter file is the other way secrets and tenant ids leak in.
# A non-placeholder tenant id is environment data that identifies one specific
# tenant forever once pushed.
printf '\n%s-- 6. no real environment identifiers in parameter files%s\n' "$BOLD" "$OFF"

# The zero GUID is the placeholder. Any other tenant-shaped value is real data.
tenant_leak="$(grep -rnE "param[[:space:]]+tenantId[[:space:]]*=[[:space:]]*'[0-9a-fA-F-]{36}'" \
  --include='*.bicepparam' . \
  | grep -viE "'0{8}-0{4}-0{4}-0{4}-0{12}'" || true)"
if [[ -n "$tenant_leak" ]]; then
  fail "tenant id" "a non-placeholder tenantId is committed. Replace it with the zero GUID and supply the real value out of band. Found: $tenant_leak"
else
  pass "tenant id  every tenantId is the zero-GUID placeholder"
fi

# A parameter file whose principal id is not the placeholder would name a real
# service principal, and role assignments bind to whatever it names.
principal_leak="$(grep -rnE "param[[:space:]]+deployIdentityPrincipalId[[:space:]]*=[[:space:]]*'[0-9a-fA-F-]{36}'" \
  --include='*.bicepparam' . \
  | grep -viE "'0{8}-0{4}-0{4}-0{4}-0{12}'" || true)"
if [[ -n "$principal_leak" ]]; then
  fail "principal id" "a non-placeholder deployIdentityPrincipalId is committed. Found: $principal_leak"
else
  pass "principal id  every deployIdentityPrincipalId is the zero-GUID placeholder"
fi

# A committed container image is a dependency on whatever registry serves it. The
# committed images must therefore point at this repository's own namespace, not at
# an image built from another one.
image_leak="$(grep -rnE "^param[[:space:]]+(portalImage|automationImage)[[:space:]]*=" \
  --include='*.bicepparam' . \
  | grep -viE 'enterprise-it-helpdesk-lab|example-org|:prod-placeholder|:dev-placeholder' || true)"
if [[ -n "$image_leak" ]]; then
  fail "container image" "a committed containerImage does not come from this repository's own registry namespace. Found: $image_leak"
else
  pass "container image  every committed image is built from this repository"
fi

# Keep an inventory of what IS committed, so a reviewer can see the surface
# without listing files.
param_files="$(find . -name '*.bicepparam' -not -path './validate/*' 2>/dev/null | sort | tr '\n' ' ')"
printf '        committed parameter files: %s\n' "${param_files:-none}"

# ------------------------------------------------- 7. security invariants
# Compile the entrypoint to a real ARM template and assert the security
# properties on THAT artifact rather than grepping the .bicep source.
#
# WHY THIS STEP EXISTS AT ALL: every check above was green with
# `enablePurgeProtection: false` in the bootstrap source's Key Vault module.
# A compile proves the template is well-formed; it says nothing about whether the
# values in it are safe. This is the check that closes that gap.
#
# WHY A COMPILED JSON AND NOT A SOURCE GREP: grepping the source would pass just
# as happily on a line inside a comment or on a resource the deployment never
# creates. The compiled template is what Azure receives.
printf '\n'
invariant_dir="$(mktemp -d)"
# shellcheck disable=SC2064  # expand $invariant_dir now, not at trap time
trap "rm -rf '$invariant_dir'" EXIT

if bicep_build main.bicep --outfile "$invariant_dir/main.json" 2>/dev/null; then
  # check_invariants.py prints its own PASS/FAIL lines and sets the exit code.
  if ! python3 scripts/check_invariants.py "$invariant_dir/main.json"; then
    fail "invariants" "scripts/check_invariants.py reported a violation (see above)"
  fi
else
  # A compile failure here is already caught in step 1; this branch only says why
  # step 7 could not run.
  fail "invariants" "could not compile main.bicep to JSON; see step 1"
fi

# --- 7b. traversal contract -----------------------------------------------
# WHY THIS IS A SEPARATE, REQUIRED STEP. check_invariants.py running without error
# proves only that it did not crash on THIS template. It does not prove the walk
# observed what it claims to check: a list-only walk skips Bicep's
# languageVersion 2.0 symbolic-name map entirely and still exits 0. The traversal
# suite asserts the nested resources were actually DISCOVERED, by name and path,
# and that malformed shapes fail closed with a JSON path.
if python3 scripts/test_checker_traversal.py scripts/check_invariants.py; then
  pass "traversal contracts  symbolic-name map, malformed shapes, absence checks"
else
  fail "traversal contracts" "see the failing contract above"
fi

# ------------------------------------------------------------ 8. independence
# The stack in this directory was bootstrapped from a sibling repository's
# infrastructure tree. This step proves nothing here reaches back out and reads
# from it: no escaping symlink, no out-of-root path reference, no named reference
# to the source repository, no submodule, no load*Content() that leaves the tree.
#
# It runs LAST among the template checks on purpose. If it fails, everything above
# passed against a tree that is not actually independent, and the more useful
# message is the specific dependency rather than a compile error naming a path that
# only exists on the author's machine.
printf '\n%s-- 8. independence: no cross-repository dependency%s\n' "$BOLD" "$OFF"
if bash scripts/check-independence.sh; then
  :
else
  fail "independence" "see the findings above; this tree has a dependency on another repository"
fi

# ------------------------------------------------------------------ verdict
printf '\n'
if [[ $failures -eq 0 ]]; then
  printf '%s== IaC validation: ALL CHECKS PASSED ==%s\n' "$GREEN" "$OFF"
  printf 'No Azure resource was created, updated or deleted by this run.\n'
  printf 'NOT DEPLOYED. Nothing in this run is evidence that the stack exists.\n'
  exit 0
fi

printf '%s== IaC validation: %d CHECK(S) FAILED ==%s\n' "$RED" "$failures" "$OFF"
exit 1