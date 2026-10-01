#!/usr/bin/env bash
# Independence proof: this repository's IaC has NO dependency on any other
# repository, now or later.
#
# WHY THIS EXISTS. The templates in infra/ were bootstrapped from a sibling
# repository's infrastructure tree. That is a legitimate one-time copy of
# *concepts*, and it becomes a problem the moment anything in this repository
# reaches back out and reads from the other one: a shared module reference, a
# `using` path that climbs out of the tree, a symlink to a neighbouring checkout,
# or a git submodule. Each of those makes this repository unbuildable on a
# machine that does not happen to have its sibling in the same place, and the
# failure mode is a confusing Bicep path error rather than a clear statement.
#
# WHAT IS CHECKED, and what each one catches:
#   1. symlinks resolving outside the repository root
#   2. path references that climb out of the repository root (`../`), in
#      buildable files
#   3. named references to the sibling repositories the bootstrap came from
#   4. git submodules (a submodule is a dependency on another repository by
#      definition)
#   5. `loadTextContent` / `loadYamlContent` / `loadJsonContent` targets outside
#      the root -- the Bicep-native way of reading another repository's file
#
# WHY #2 IS EXEMPT FOR THE REPOSITORY'S OWN LAYOUT: `../` is legal and necessary
# inside the repo -- validate/negative/*.bicepparam point at ../../main.bicep.
# The check is on references that ESCAPE the repo root, not on the token `../`.
#
# IMPLEMENTATION NOTE, because it looks like an arbitrary restriction: this script
# contains NO `case` statement inside a `$( )`. The system bash on macOS is 3.2,
# which mis-parses a `case` inside command substitution and aborts the whole
# command substitution with a syntax error -- measured on this machine, not
# assumed. Prefix tests are written with `case`-free helpers instead, so the
# script runs identically on bash 3.2 and bash 5.
#
# Exit 0 = independent. Exit 1 = at least one violation. Every finding carries a
# file and a line number so it can be fixed without searching.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repository root, derived from this script's own location: infra/scripts -> repo.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED=$'\033[31m'
GREEN=$'\033[32m'
BOLD=$'\033[1m'
OFF=$'\033[0m'

failures=0

# WHY THE FINDINGS ARE PIPED THROUGH printf INSTEAD OF READ FROM $1: reading from
# stdin here would consume the script's own stdin, which on a developer machine is
# an interactive terminal. An earlier revision of this printed the header and no
# findings at all for exactly that reason -- a FAIL line with nothing under it is
# worse than no line, because it looks like the check passed.
fail() {
  local heading="$1"
  local detail="$2"
  printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$heading"
  printf '%s\n' "$detail" | while IFS= read -r line; do
    [[ -n "$line" ]] && printf '        %s\n' "$line"
  done
  failures=$((failures + 1))
}

pass() { printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$1"; }

# Files that legitimately talk about the sibling repositories by NAME, because
# their entire job is to record and enforce this independence. Excluding them by
# path is deliberate and narrow: a documentation file naming the source SHA is
# provenance, not a dependency. The check on actual PATH references (#2) is
# unaffected by this exclusion in spirit -- the excluded file is documentation,
# and a real `../` path reference in it would be a finding a reviewer should see.
DECLARATION_FILES='docs/enterprise-target/INFRA-ORIGIN.md'

is_declaration_file() {
  local rel="$1"
  case " ${DECLARATION_FILES} " in
    *" ${rel} "*) return 0 ;;
    *) return 1 ;;
  esac
}

# True when $1 starts with the literal string $2. Written without `case` because
# of the bash 3.2 command-substitution bug documented in the header.
starts_with() {
  [[ "${1#"$2"}" != "$1" ]]
}

# Files worth scanning. Binary assets are excluded because a grep over them
# produces noise rather than findings.
scan_files() {
  # shellcheck disable=SC2012
  find "$REPO_ROOT" \
    \( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ \) -prune -o \
    -type f \
    \( -name '*.bicep' -o -name '*.bicepparam' -o -name '*.yml' -o -name '*.yaml' \
       -o -name '*.sh' -o -name '*.py' -o -name '*.json' -o -name '*.md' \
       -o -name '*.js' -o -name 'Dockerfile*' \) -print
}

# --------------------------------------------------------------- 1. symlinks
# WHY THE RESOLUTION STEP: a symlink to a file INSIDE the repo is harmless and a
# symlink to a neighbouring checkout is not, and `find -type l` cannot tell them
# apart. So each link is resolved and the resolved path compared against the root.
printf '%s-- 1. no symlink escapes the repository root%s\n' "$BOLD" "$OFF"
escaping_links="$(
  find "$REPO_ROOT" \( -name .git -o -name node_modules \) -prune -o -type l -print 2>/dev/null \
  | while IFS= read -r link; do
      target="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$link" 2>/dev/null)"
      if [[ -n "$target" ]] && ! starts_with "$target" "$REPO_ROOT"; then
        printf '%s -> %s\n' "${link#"$REPO_ROOT"/}" "$target"
      fi
    done
)"
if [[ -n "$escaping_links" ]]; then
  fail "symlink escapes repo root" "$escaping_links"
else
  pass "symlink escapes repo root    none"
fi

# ----------------------------------------------- 2. relative paths that escape
# WHY THIS RESOLVES PATHS INSTEAD OF MATCHING `../` AS TEXT. `../` is everywhere
# and almost all of it is legitimate and in-tree: internal-portal/test/*.test.js
# does `require('../src/notify')`, infra/validate/negative/*.bicepparam does
# `using '../../main.bicep'`, and both resolve to files inside this repository. A
# text check that fired on the token would report dozens of false findings on the
# first run and would then be deleted. So every relative reference is resolved
# against its own file's directory and only a resolution that leaves the
# repository root is a violation.
#
# THE SCOPE IS infra/, .github/ and scripts/ -- the build and CI surface. The
# application's own test files are not build inputs and are left alone on
# purpose: reworking a passing test suite's require() paths is out of scope for
# an IaC independence proof, and those paths are demonstrably in-tree anyway.
printf '\n%s-- 2. no build file references a path outside the repository root%s\n' "$BOLD" "$OFF"
INFRA_SCOPE_RE='^(\.github/|infra/|scripts/)'
escape_hits="$(
  scan_files | while IFS= read -r f; do
      rel="${f#"$REPO_ROOT"/}"
      if is_declaration_file "$rel"; then continue; fi
      echo "$rel"
    done   | grep -E "$INFRA_SCOPE_RE"   | while IFS= read -r rel; do
      f="$REPO_ROOT/$rel"
      dir="$(cd "$(dirname "$f")" && pwd)"
      grep -nE "(\.\./)+[A-Za-z0-9_.-]" "$f" 2>/dev/null \
        | while IFS= read -r hit; do
            # Extract every path-ish token containing ../ from the matched line.
            printf '%s\n' "$hit" \
              | grep -oE "(\.\./)+[A-Za-z0-9_./-]*" \
              | while IFS= read -r token; do
                  resolved="$(cd "$dir" 2>/dev/null && cd "$(dirname "$f")" >/dev/null 2>&1; python3 -c 'import os,sys;print(os.path.normpath(os.path.join(sys.argv[1],sys.argv[2])))' "$dir" "$token")"
                  if [[ "$resolved" != "$REPO_ROOT" && "$resolved" != "$REPO_ROOT"/* ]]; then
                    printf '%s:%s  (%s resolves outside the repo)\n' "$rel" "$hit" "$token"
                  fi
                done
          done
    done
)"
if [[ -n "$escape_hits" ]]; then
  fail "out-of-root relative reference" "$escape_hits"
else
  pass "out-of-root relative reference    none (every ../ in infra/, .github/ and scripts/ resolves in-tree)"
fi

# ------------------------------------------ 3. named sibling-repo references
# WHY BY NAME AND NOT BY PATH: a template can name the other repository without
# spelling a filesystem path -- a module comment, an env var, a container image
# reference -- and a container image pointing at the sibling's registry IS a
# runtime dependency even though it is not a filesystem reference.
#
# WHY THE PATTERN IS THIS NARROW, AND WHY THAT MATTERS. A first attempt used a
# loose `factory` token and immediately fired on eight pre-existing hits, none of
# which were cross-repo dependencies: `scenarios/factory/` is THIS repository's
# own scenario corpus (README.md:211, scripts/collect-factory-evidence.sh:9),
# describing lab scenarios for a factory IT department. A check that fires on the
# repository's own subject matter is a check that gets deleted. So the pattern
# names the specific sibling identifiers -- the checkout directory names, the
# upstream image path -- and not a generic word.
#
# SCOPE: infra/, .github/ and scripts/, plus this script itself is excluded
# because the pattern lives in its source. Application test fixtures and README
# prose are out of scope for an IaC independence proof.
SIBLING_PATTERN='ent-maia|ent-factory|private/tmp/ent-|MAIA_[A-Z]|maia-maia-api|/MAIA/infra|MAIA Platform'
printf '\n%s-- 3. no reference to a bootstrap-source repository%s\n' "$BOLD" "$OFF"
sibling_hits="$(
  scan_files | while IFS= read -r f; do
      rel="${f#"$REPO_ROOT"/}"
      if is_declaration_file "$rel"; then continue; fi
      echo "$rel"
    done \
  | grep -E "$INFRA_SCOPE_RE" \
  | grep -v '^infra/scripts/check-independence\.sh$' \
  | while IFS= read -r rel; do
      grep -nEi "$SIBLING_PATTERN" "$REPO_ROOT/$rel" 2>/dev/null \
        | while IFS= read -r hit; do printf '%s:%s\n' "$rel" "$hit"; done
    done
)"
if [[ -n "$sibling_hits" ]]; then
  fail "bootstrap-source repository referenced" "$sibling_hits"
else
  pass "bootstrap-source repository referenced    none in infra/, .github/ or scripts/"
fi

# ------------------------------------------------------- 4. git submodules
# WHY CHECK BOTH THE FILE AND THE REGISTRATION: an untracked .gitmodules does
# nothing, and a submodule recorded without the file would be a local-only
# dependency CI never sees.
printf '\n%s-- 4. no git submodules%s\n' "$BOLD" "$OFF"
if [[ -f "$REPO_ROOT/.gitmodules" ]]; then
  fail "git submodule present" ".gitmodules exists at the repository root"
else
  pass "git submodule (.gitmodules)    absent"
fi
submodules="$(git -C "$REPO_ROOT" submodule status 2>/dev/null)"
if [[ -n "$submodules" ]]; then
  fail "git submodule present" "$submodules"
else
  pass "git submodule registrations    none"
fi

# ------------------------------------------ 5. bicep load*Content() targets
# WHY SEPARATE FROM #2: `loadTextContent('../../apim-policies/x.xml')` is the
# Bicep-native way of reading a file, and the Bicep compiler resolves it relative
# to the template rather than by any shell convention. A mistake there produces a
# compile error naming a path the author never wrote. The verdict is computed by
# resolving the target, not by matching text, so an in-tree policy file reads as
# fine and only a genuine escape is a finding.
printf '\n%s-- 5. no bicep load*Content() reads outside the repository root%s\n' "$BOLD" "$OFF"
# WHY A PYTHON HELPER FOR THIS ONE CHECK: extracting a single-quoted argument out
# of a `loadTextContent('...')` call means one quote inside another inside a $( ),
# and bash 3.2 on macOS mis-parses that. The scan is a regex over file contents,
# which is exactly what a short Python program is for, so it lives in
# infra/scripts/find_external_load_targets.py and is called with the repo root.
load_hits="$(python3 "$SCRIPT_DIR/find_external_load_targets.py" "$REPO_ROOT")"
load_total="$(python3 "$SCRIPT_DIR/find_external_load_targets.py" --count "$REPO_ROOT")"
if [[ -n "$load_hits" ]]; then
  fail "bicep load*Content target escapes the repo root" "$load_hits"
else
  pass "bicep load*Content targets resolve in-tree    $load_total call(s) checked"
fi

# ------------------------------------------------------------------ verdict
printf '\n'
if [[ $failures -eq 0 ]]; then
  printf '%s== independence: NO CROSS-REPOSITORY DEPENDENCY ==%s\n' "$GREEN" "$OFF"
  printf 'Checked under: %s\n' "$REPO_ROOT"
  exit 0
fi
printf '%s== independence: %d VIOLATION(S) ==%s\n' "$RED" "$failures" "$OFF"
exit 1