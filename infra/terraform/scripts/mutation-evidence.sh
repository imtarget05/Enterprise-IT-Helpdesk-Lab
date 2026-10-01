#!/usr/bin/env bash
# Mutation evidence runner (ROADMAP execution contract 11).
#
# For each mutation: apply it, run `terraform test`, capture the FIRST failing
# assertion, then revert. Evidence counts only if the intended control failed
# for the intended reason, so the raw output of each run is kept.
#
# Usage: bash scripts/mutation-evidence.sh [output-dir]
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT_DIR="${1:-/tmp/tf-mutation-evidence}"
mkdir -p "$OUT_DIR"

mutate() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, before, after = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
if before not in src:
    sys.exit(f"ANCHOR NOT FOUND in {path}: {before!r}")
open(path, "w").write(src.replace(before, after, 1))
PY
}

run_case() {
  local id="$1" target_file="$2" test_file="$3" before="$4" after="$5"
  cp "$target_file" /tmp/.mutation-backup
  echo "=== $id : $target_file"
  echo "--- mutation applied"
  mutate "$target_file" "$before" "$after" || { echo "    (mutation failed to apply)"; return 1; }
  diff <(cat /tmp/.mutation-backup) <(cat "$target_file") | head -6 || true
  terraform test -filter="$test_file" > "$OUT_DIR/$id.log" 2>&1
  local rc=$?
  echo "--- terraform test exit=$rc (0 would be a BROKEN control)"
  grep -E 'Failure!|Success!|Error:|error_message =|must |MUST ' "$OUT_DIR/$id.log" | head -8
  cp /tmp/.mutation-backup "$target_file"
  echo "--- reverted"
  echo
}

run_case M1-keyvault-purge-protection modules/keyvault/main.tf tests/modules.tftest.hcl \
  'purge_protection_enabled      = true' 'purge_protection_enabled      = false'

run_case M2-postgres-require-secure-transport modules/database/main.tf tests/modules.tftest.hcl \
  'value     = "ON"' 'value     = "OFF"'

run_case M3-aca-subnet-delegation modules/network/main.tf tests/modules.tftest.hcl \
  'name = "Microsoft.App/environments"' 'name = "Microsoft.Sql/servers"'

run_case M4-servicebus-duplicate-detection modules/messaging/main.tf tests/modules.tftest.hcl \
  'requires_duplicate_detection            = true' 'requires_duplicate_detection            = false'

run_case M5-container-app-plain-http modules/apps/main.tf tests/modules.tftest.hcl \
  'allow_insecure_connections = false' 'allow_insecure_connections = true'

echo "raw logs: $OUT_DIR"
