# Configuration contract — Helpdesk ↔ Azure

**This document is authoritative for the config/env names in this repository.** If a
variable name appears both here and in a template, here wins. If a template
introduces a name that is not in this document, that is a defect, and the
independence/invariant checks exist to make the adjacent classes of defect loud.

## The rule this contract exists to enforce

**A Key Vault secret name in `infra/` MUST be an environment variable that
`internal-portal/` or `llm-gateway/` already reads in source code.**

The failure this prevents is concrete. A template invents
`HELPDESK_OPENAI_KEY`, an operator writes that secret into the vault, the container
app resolves it, and the app still sees `OPENAI_API_KEY` as undefined — so the
application falls back to a default. For `AUTH_MODE` that means the no-login
`legacy` mode. For an API key it means an unauthenticated outbound call. The
deployment looks successful the whole time.

So the secret-name lists in `main.dev.bicepparam` / `main.prod.bicepparam` are
transcriptions of source-code reads, not design decisions. If you need a new
secret, the change is: add the read to the application first, add a test for it,
then add the name to the parameter file.

## Where the names came from

Extracted by reading the source, not by inventing them:

| Application | File | Read |
|---|---|---|
| Portal | `internal-portal/src/app.js`, `src/auth.js`, `src/ai.js`, `src/notify.js`, `src/rag.js`, `src/enterprise-routes.js`, `server.js` | `process.env.*` |
| Gateway | `llm-gateway/server.py`, `llm-gateway/automation/*` | `os.environ.get(...)` |

No name in `infra/` was chosen independently. Where a template needed a value that
the application has no variable for, the variable was **not** invented — see
"Deliberately absent" below.

## Portal (`ca-helpdesk-portal`) — `internal-portal`

### Secrets (Key Vault references, values written out of band)

| Name | Read at | Purpose | Required? |
|---|---|---|---|
| `OPENAI_API_KEY` | `src/ai.js` | Cloud LLM tier key. Omitted → portal uses the Ollama/LM Studio tier and never calls OpenAI. | No |
| `MINIERP_INTEGRATION_KEY` | `src/enterprise-routes.js` | Guards `POST /api/integrations/minierp/incidents`. Omitted → the route rejects callers. | Yes for the MiniERP route |
| `LAB_AUTH_USERS` | `src/auth.js` | JSON of `{"user":{"password":…,"role":…}}` for `AUTH_MODE=lab`. **A credential**, not configuration. | Yes when `AUTH_MODE=lab` |

`OPENAI_API_KEY` is optional on purpose: a helpdesk deployment with no cloud-LLM
budget should run entirely on the LAN tier, and requiring the key would force
someone to provision one they do not want.

### Non-secret environment (set in the parameter file)

| Name | Read at | Value in dev / prod | Note |
|---|---|---|---|
| `PORT` | `server.js` | `3000` | Must equal `portalTargetPort` and the `EXPOSE` in `internal-portal/Dockerfile`. |
| `DATA_DIR` | `src/app.js` | `/app/data` | Where `db.json` + `notifications.log` live inside the container. |
| `AUTH_MODE` | `src/auth.js` | `lab` | `lab` in **both** environments. `legacy` is the no-login demo path and must never reach a shared environment. |
| `ALLOWED_ORIGINS` | `src/app.js` | *(unset → `*`)* | **Left unset deliberately.** Behind APIM + Front Door, `*` in the app is acceptable because the gateway enforces its own CORS allowlist from the `allowedOrigins` parameter. A future wave that fronts the portal directly must set both and they must match. |
| `LLM_PROVIDER` | `src/ai.js` | `lmstudio` | Selects which LAN base the portal calls. `ollama` and `lmstudio` both talk to the gateway. |
| `LMSTUDIO_URL` | `src/ai.js` | `http://127.0.0.1:8787/v1` | Loopback **within the portal container** is wrong in a two-container topology — see "Known gap" below. |
| `OLLAMA_TIMEOUT_MS` | `src/ai.js` | `8000` | Per-call timeout. |
| `IT_WEBHOOK_URL` | `src/notify.js` | empty in both | Empty → the portal writes to `data/notifications.log` instead of posting. Honest in dev; an operator action in prod, recorded in the parameter file. |
| `IT_NOTIFY_TIMEOUT_MS` | `src/enterprise-routes.js` | `3000` | Bounds the webhook POST so a slow endpoint cannot stall an API route. |

### Portal variables deliberately NOT set by the infrastructure

| Name | Why not |
|---|---|
| `QDRANT_URL`, `QDRANT_COLLECTION` | Read by `src/rag.js`, which falls back to an in-memory cosine index when Qdrant is unreachable. **This stack declares no vector store.** Leaving them unset keeps the retrieval path on the in-memory fallback, which is the documented behaviour (`rag.js:9-11`). Setting `QDRANT_URL` to a host that does not exist would add a timeout on the request path for no benefit. |
| `OLLAMA_EMBED_MODEL`, `OLLAMA_URL` | Used only by the RAG path and the direct-Ollama tier. With `LLM_PROVIDER=lmstudio` neither is consulted for chat. |
| `OPENAI_MODEL`, `OLLAMA_MODEL`, `LMSTUDIO_MODEL` | Model ids with working in-source defaults (`ai.js:34-40`). Pinning them in IaC would make a model upgrade a template edit. Set per environment once the LAN model set is pinned. |
| `PORT_HOST`, `DATA_HOST_PATH`, `MEM_LIMIT`, `CPU_LIMIT`, `LOG_MAX_SIZE`, `LOG_MAX_FILE` | Docker Compose host-side concerns (`.env.example` §1, §5). They do not apply to a container platform and setting them would be configuration that reads as load-bearing and is not. |

## Automation worker (`ca-helpdesk-automation`) — `llm-gateway`

### Secrets

| Name | Read at | Purpose | Required? |
|---|---|---|---|
| `LLM_CLOUD_API_KEY` | `server.py:218` | Key for the hybrid-cloud failover base. Omitted → LAN-only mode, which is the correct default for a lab LAN. | No |

### Non-secret environment

| Name | Read at | Value | Note |
|---|---|---|---|
| `PORT` | `server.py:205` | `8787` | The canonical name. `GATEWAY_PORT` is a deprecated alias and is not used. |
| `GATEWAY_HOST` | `server.py:206` | `0.0.0.0` | Must be `0.0.0.0` in a container; `llm-gateway/Dockerfile:2` sets the same. |
| `LLM_TIMEOUT` | `server.py:202` | `120` | Matches the in-source default. |
| `LLM_MAX_RETRIES` | `server.py:211` | `2` | Matches the in-source default. |
| `LLM_PII_MASKING` | `server.py:213` | `1` | **On in both environments.** Ticket text carries phone numbers and national-id numbers (docs/12-jd-demo-va-phong-van-python-ai.md) and the prompt leaves the LAN. |

### Gateway variables deliberately NOT set

| Name | Why not |
|---|---|
| `LLM_UPSTREAM`, `LLM_CLOUD_UPSTREAM` | Both are LAN addresses (`192.168.1.8:1234` in `.env.example`) that are meaningful only on the lab network. Committing them into a parameter file bakes one machine's address into a shared deployment. The worker-side value belongs in the parameter file **per environment** once the LAN model set is pinned; that is an operator action, not a default. |
| `LLM_LOG_PATH`, `LLM_LOG_MAX_MB` | The default writes telemetry to `./logs/llm-telemetry.jsonl` inside the container, which is lost on restart. Correct target is the Log Analytics workspace the monitoring module creates; wiring it is an open item in `COMPLETION-MATRIX.md`, not a silent default. |
| `LLM_MODEL_*`, `LLM_CHAT_MODEL`, `LLM_EMBED_MODEL` | Model ids with in-source defaults (`server.py:46-59`). Same reasoning as the portal model ids. |
| `LLM_CB_*`, `LLM_RETRY_BASE_MS`, `LLM_QUOTA_TOKENS_PER_DAY`, `LLM_COST_PER_1M_USD` | Working defaults. The quota being 0 (unlimited) is a cost decision an operator makes per environment, not a safe default to enshrine in a template. |

## Names the infrastructure owns

These have no application-side variable, because they are consumed by Azure
platform features rather than by the process. They are **outputs of the
deployment**, recorded so a runbook reads them instead of guessing.

| Name | Source | Consumed by |
|---|---|---|
| `AZURE_CLIENT_ID` | `helpdeskPortalIdentityClientId` / `helpdeskAutomationIdentityClientId` | Container Apps binds the identity directly; no env var needed. Named only for out-of-band `az login --allow-no-subscriptions` debugging. |
| Key Vault secret **references** | `infra/modules/container-app/main.bicep` | ACA resolves each at start-up using the bound identity. The reference is `(name, keyVaultUrl, identity)`; the env var name is the secret name. |
| `helpdeskAutomationQueueName` = `helpdesk-automation-jobs` | `infra/modules/service-bus/main.bicep` | The queue the worker consumes. |
| `helpdeskAutomationDeadLetterQueueName` = `helpdesk-automation-dlq` | same | Monitoring target. A non-empty DLQ is a ticket. |
| `helpdeskPostgresFqdn`, `helpdeskRedisHostName`, `helpdeskStorageBlobEndpoint`, `helpdeskServiceBusEndpoint` | data-tier modules | The application assembles credentials itself; **no connection string is emitted**, so there is no connection string to put in a vault. |

## Known gaps in this contract

Recorded rather than papered over. Each is a real inconsistency between the
templates and the running application.

1. **The portal's LLM base points at loopback.** `LMSTUDIO_URL` is
   `http://127.0.0.1:8787/v1`, which resolves inside the *portal* container. The
   gateway runs in a *different* container. In a two-container topology the portal
   must reach the gateway by its environment-internal hostname, which is
   `ca-helpdesk-automation.<environment default domain>`. The template does not
   compute that hostname because the ACA internal FQDN is only known after the
   environment exists. **Resolution:** wire it in the deployment wave from
   `helpdeskContainerAppsEnvironmentId`'s sibling output, or run the gateway
   in-process. Tracked in `COMPLETION-MATRIX.md`.
2. **No configuration schema is emitted into the apps.** ACA's `secretRef` model
   means the app resolves secrets itself; there is no schema file to drift. The
   check that would catch a typo in a secret name does not exist at the platform
   level. **Mitigation in place:** the name lists in this document are transcribed
   from source, and `validate.sh` step 6 asserts committed images and ids are
   placeholders.
3. **`AUTH_MODE=lab` is not Entra.** The APIM `validate-jwt` policy in
   `infra/apim-policies/operation-protected.xml` validates a token the portal
   does not currently mint. The portal authenticates locally with
   `LAB_AUTH_USERS`. So today the gateway's protected operations would reject
   every real caller. **This is the single largest gap between the templates and
   the application**, and it is why every matrix row is `NOT_DEPLOYED` rather than
   `IMPLEMENTED_TESTED`. Resolution is either an Entra app registration (which
   `modules/managed-identity` deliberately does not create, because nothing reads
   one today) or dropping `protected: true` in the operation list. A decision, not
   a config value.