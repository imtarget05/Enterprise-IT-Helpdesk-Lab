#!/usr/bin/env bash
# Enterprise-IT-Helpdesk-Lab — Terraform remote state foundation (B1).
#
# SCOPE, precisely: this creates ONLY the control-plane foundation needed for
# `terraform init` to reach remote state. It creates NO application or compute
# resource — no AKS cluster, no node pool, no ACR, no Key Vault, no networking.
#
# WHY A REPO-OWNED FOUNDATION, NOT A SHARED ONE: until Phase 2 this Terraform
# root had NO backend block at all. That is worse than a wrong one — `terraform
# init` succeeded and wrote state to a laptop `.tfstate` that no other operator
# could read, silently. The portfolio pattern (partial backend + Entra auth +
# disabled shared key) is worth copying; another project's storage account is
# not. Isolation is enforced by tests/probe_backend_isolation.py, which fails if
# this repository ever names another portfolio project's state resources.
#
# COST: a Storage Account is not free. It bills a small amount per day for
# capacity and transactions. It is also NOT a compute-quota consumer — it does
# not touch the 10-vCPU regional ceiling. It is deliberately PERMANENT: it holds
# canonical Terraform state, so transient application teardown must never
# destroy it.
#
# NETWORK: public network access stays ENABLED, because a GitHub-hosted runner
# has no stable outbound IP to allow-list. This is a documented trade-off, not
# an oversight:
#     PUBLIC_NETWORK_REACHABLE + ENTRA_AUTH_REQUIRED + SHARED_KEY_DISABLED
# The control that matters is that SharedKey authorisation is refused
# server-side, so there is no key to leak. A private endpoint with an
# Azure-hosted runner is the hardened option if that is ever needed.
#
# IDEMPOTENT: safe to re-run. Every step reads back before it creates.
#
# Usage:
#   ./scripts/bootstrap_state.sh --dry-run          # intent, zero mutation
#   ALLOW_AZURE_MUTATION=1 ./scripts/bootstrap_state.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_ROOT="$(cd "$HERE/.." && pwd)"

STATE_RG="rg-helpdesk-tfstate"
STATE_SA="sthdhelpdesk"
STATE_CONTAINER="tfstate"
ENV_NAME="validation"
STATE_KEY="helpdesk/validation.terraform.tfstate"
LOCATION="${AZURE_LOCATION:-southeastasia}"
OWNER_CONTACT="${AZURE_OWNER_CONTACT:-platform-team@example.invalid}"

ROLE_BLOB_DATA_CONTRIBUTOR="ba92f5b4-2d11-453d-a403-e96b0029c9fe"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

FAILED=0
step() { printf '\n== %s\n' "$1"; }
ok()   { echo "   -> ok: $1"; }
fail() { echo "   -> FAILED: $1"; FAILED=1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "   [dry-run] $*"; return 0; fi; "$@"; }

command -v az >/dev/null 2>&1 || { echo "az CLI is required."; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required."; exit 2; }

# --- 0. Preflight ---------------------------------------------------------
step "preflight"
if ! SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null)"; then
  echo "   -> FAILED: not logged in. Run: az login && az account set --subscription <id>"
  exit 2
fi
TENANT_ID="$(az account show --query tenantId -o tsv)"
[ -n "$TENANT_ID" ] || { echo "   -> FAILED: tenantId is empty"; exit 2; }
echo "   subscription: $SUBSCRIPTION_ID"
echo "   tenant:       $TENANT_ID"
echo "   location:     $LOCATION"

if [ "$DRY_RUN" = "0" ] && [ "${ALLOW_AZURE_MUTATION:-0}" != "1" ]; then
  echo
  echo "This script MUTATES Azure (creates a resource group, a storage account and"
  echo "a container). Re-run with ALLOW_AZURE_MUTATION=1 to confirm:"
  echo "    ALLOW_AZURE_MUTATION=1 ./scripts/bootstrap_state.sh"
  exit 3
fi

# --- 1. State resource group + storage account + container ----------------
step "state foundation: $STATE_RG / $STATE_SA"

# Storage account names are globally unique across ALL of Azure, not just this
# subscription. The first attempt at `staksstate` failed with
# StorageAccountAlreadyTaken because someone else owns that name globally — and
# the failure surfaced only AFTER the resource group was created, leaving a half
# built foundation. Checking first turns a confusing mid-script failure into a
# clear preflight refusal.
#
# IDEMPOTENCY: an account this script already created is reported as
# nameAvailable=false too, so the check must be scoped to THIS resource group.
# "Taken, but by us" is a success state for a re-run, not a failure.
if [ "$DRY_RUN" != "1" ]; then
  if az storage account show -n "$STATE_SA" -g "$STATE_RG" -o none >/dev/null 2>&1; then
    ok "storage account '$STATE_SA' already exists in $STATE_RG (idempotent re-run)"
  else
    SA_AVAILABLE="$(az storage account check-name -n "$STATE_SA" --query nameAvailable -o tsv 2>/dev/null)"
    if [ "$SA_AVAILABLE" != "true" ]; then
      echo "   -> FAILED: the storage account name '$STATE_SA' is already taken GLOBALLY"
      echo "      (Azure names are unique across all subscriptions, not just this one)."
      echo "      Nothing was created. Choose another name and re-run."
      exit 4
    fi
    ok "storage account name '$STATE_SA' is available"
  fi
fi

run az group create --name "$STATE_RG" --location "$LOCATION" \
  --tags "project=helpdesk" "env=$ENV_NAME" "managedBy=terraform-bootstrap" "owner=$OWNER_CONTACT" \
  -o none || fail "could not create resource group $STATE_RG"

run az storage account create \
  --name "$STATE_SA" --resource-group "$STATE_RG" --location "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false \
# --- 2. Data-plane access for the bootstrap runner -------------------------
# Owner is a MANAGEMENT-plane role and carries no dataActions, so
# `az storage container create --auth-mode login` would 403 without this grant.
# Scope is the STORAGE ACCOUNT, not the resource group: the two have the same
# blast radius today, but RG scope silently widens the moment a second account
# is added. Least privilege, not convenience.
STATE_SA_SCOPE="/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$STATE_RG/providers/Microsoft.Storage/storageAccounts/$STATE_SA"
if [ "$DRY_RUN" != "1" ]; then
  STATE_SA_SCOPE="$(az storage account show -n "$STATE_SA" -g "$STATE_RG" --query id -o tsv 2>/dev/null)"
  [ -n "$STATE_SA_SCOPE" ] || fail "could not resolve the storage account id"
  echo "   storage account id: $STATE_SA_SCOPE"
fi

BOOTSTRAP_USER_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
if [ -z "$BOOTSTRAP_USER_ID" ] && [ "$DRY_RUN" != "1" ]; then
  fail "cannot resolve the signed-in user id; bootstrap must run as a user, not a SP"
fi

HAS_ROLE=0
if [ "$DRY_RUN" != "1" ]; then
  HAS_ROLE="$(az role assignment list --assignee "$BOOTSTRAP_USER_ID" \
    --scope "$STATE_SA_SCOPE" --include-inherited -o tsv 2>/dev/null \
    | grep -c "$ROLE_BLOB_DATA_CONTRIBUTOR" || true)"
fi
if [ "${HAS_ROLE:-0}" -ge 1 ] 2>/dev/null; then
  ok "runner already holds Storage Blob Data Contributor @ storage account"
else
  echo "   -> granting the runner Storage Blob Data Contributor @ storage account"
  run az role assignment create \
    --assignee-object-id "$BOOTSTRAP_USER_ID" \
    --assignee-principal-type User \
    --role "$ROLE_BLOB_DATA_CONTRIBUTOR" --scope "$STATE_SA_SCOPE" \
    -o none || fail "could not grant the runner Storage Blob Data Contributor"
  ok "runner data-plane role granted at storage-account scope"

  # Bounded wait for RBAC propagation. A role assignment returning from the
  # control plane does not mean the data plane accepted it yet; retrying a fixed
  # number of times and then giving up keeps a real permission problem from
  # hiding behind a retry loop.
  if [ "$DRY_RUN" != "1" ]; then
    echo "   -> waiting for the data-plane role to propagate"
    PROPAGATED=0
    attempt=1
    while [ "$attempt" -le 6 ]; do
      sleep 10
      if az storage container create --name "$STATE_CONTAINER" \
           --account-name "$STATE_SA" --auth-mode login -o none >/dev/null 2>&1; then
        PROPAGATED=1
        echo "   -> data-plane access confirmed after $((attempt * 10))s"
        break
      fi
      echo "   -> not propagated yet ($((attempt * 10))s), retrying"
      attempt=$((attempt + 1))
    done
    [ "$PROPAGATED" = "1" ] \
      || fail "the data-plane role did not take effect within 60s; check tenant conditional access"
    CONTAINER_READY=1
  fi
fi

if [ "${CONTAINER_READY:-0}" != "1" ]; then
  run az storage container create --name "$STATE_CONTAINER" \
    --account-name "$STATE_SA" --auth-mode login \
    -o none || fail "could not create container $STATE_CONTAINER"
fi

# --- 3. Verify the container through Entra, never a key -------------------
if [ "$DRY_RUN" != "1" ]; then
  step "verify container via Entra"
  az storage container list --account-name "$STATE_SA" --auth-mode login \
    --query "[?name=='${STATE_CONTAINER}'].name" -o tsv 2>/dev/null | grep -q "$STATE_CONTAINER" \
    && ok "container $STATE_CONTAINER is reachable with Entra auth (no account key)" \
    || fail "container $STATE_CONTAINER is not reachable via Entra"

  # Azure returns `null` rather than `false` for allowSharedKeyAccess when
  # SharedKey is disabled, because null IS the disabled default. Asserting on
  # the literal string "False" therefore reports a failure for a correctly
  # configured account — a control that cries wolf is a control that gets
  # disabled. Both `null` and `false` mean disabled; `true` is the only failure.
  SHARED_KEY="$(az storage account show -n "$STATE_SA" -g "$STATE_RG" \
    --query allowSharedKeyAccess -o tsv 2>/dev/null)"
  if [ "$SHARED_KEY" = "true" ] || [ "$SHARED_KEY" = "True" ]; then
    fail "allowSharedKeyAccess is $SHARED_KEY — SharedKey auth must be disabled"
  else
    ok "allowSharedKeyAccess=$SHARED_KEY (null and false both mean disabled) confirmed by read-back"
  fi
fi

# --- 4. Hand off ----------------------------------------------------------
cat <<OUT

Backend init:
  cd $TF_ROOT
  terraform init -reconfigure -backend-config=environments/$ENV_NAME/backend.hcl

State key:    $STATE_KEY
Container:    $STATE_CONTAINER
Auth (local): az login  (Entra; use_azuread_auth = true)
Auth (CI):    ARM_USE_OIDC=true ARM_USE_AZUREAD_AUTH=true + ARM_CLIENT_ID /
              ARM_TENANT_ID / ARM_SUBSCRIPTION_ID

CI_OIDC = NOT_CONFIGURED
  This repository has no GitHub OIDC identity of its own yet. B1 covers STATE
  FOUNDATION only; a repo-owned identity is a later, separate authorisation.
  The backend is already OIDC-compatible, so adding one needs no config change.

PERSISTENT — do not destroy during transient application teardown:
  $STATE_RG / $STATE_SA / $STATE_CONTAINER

This account CAN incur small ongoing storage cost. It is NOT compute quota.
OUT

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  echo "Bootstrap: PASS"
  exit 0
fi
echo "Bootstrap: FAIL"
exit 1
  --tags "project=helpdesk" "env=$ENV_NAME" "managedBy=terraform-bootstrap" \
  -o none || fail "could not create storage account $STATE_SA"

# SharedKey refusal is the CONTROL. With it on, an account key leaked from
# anywhere is not a usable credential against state.
run az storage account update --name "$STATE_SA" --resource-group "$STATE_RG" \
  --allow-shared-key-access false -o none \
  || fail "could not disable shared-key access on $STATE_SA"