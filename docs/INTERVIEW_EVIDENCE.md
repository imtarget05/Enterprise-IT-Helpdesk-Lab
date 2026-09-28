# Enterprise IT Helpdesk Lab — Interview Evidence Kit

> Lab portal + AD/GPO/DNS lab + PowerShell automation. Portal: **278 node tests
> pass / 1 skip** (Phase-2 suite; earlier README badge showed 269 — rerun
> `npm test` to confirm current count), 79 Flask + 68 API smoke + 55-route
> inventory; `docs/06-interview-qa.md` covers 30 VN Q&A — this file covers the
> software-control-plane STAR/system-design/demo. Phase-2: 6 portal tests.

---

## 1. STAR story

**Situation.** A 1–3 person IT team lost time to three pains: assets tracked in
Excel (always stale), every repeat incident re-diagnosed from scratch, and new
hires onboarded by hand (~20 min, wrong OUs, missing groups).

**Task.** Ship one internal portal (assets + ITIL tickets + licenses + AI
copilot + factory-ops runbooks) backed by scripted AD/lab automation, with
contract-tested APIs and an offline AI fallback so the lab works with no cloud.

**Action.**
- Node/Express portal, atomic JSON persistence, zero native deps; SPA (vanilla
  JS, dark mode, CSV export); lab-mode Bearer/RBAC auth with real login flow
  (Playwright `test-ui-e2e.sh`); OpenAPI contract validated in CI.
- 20 ITIL tickets (symptom→diagnosis→root-cause→fix→prevent), 5 factory
  runbooks + 12 structured ops scenarios, PowerShell AD bulk-provision/monitor
  scripts with AST-or-static lint fallback.
- AI copilot cascade: OpenAI (optional) → local Ollama → offline ITIL playbook
  fallback; 278 node tests (store/CSV/notifier, real-HTTP integration, RBAC,
  MiniERP receiver, Docker packaging) + 79 Flask + 68 smoke.

**Result.** 278 pass / 1 skip node suite; 20 tickets + 12 scenarios give every
interview answer a file pointer; onboarding/offboarding SOPs (docs 05/08/11)
turn tribal knowledge into runnable procedure.

## 2. System-design Q&A

**Q1: Why in-memory store + file backup instead of a full DB? (ADR-0001)**
A lab portal serves tens of users with JSON-scale data; Postgres would add a
container, migrations, and backup ops to every student's laptop. Atomic file
writes + baseline-restore (`fixtures/db.baseline.json`) give crash safety and
one-command demo reset. The OpenAPI contract is the migration seam — when
concurrent writers arrive, swap the store, not the API.

**Q2: Why a three-tier AI fallback instead of just OpenAI?**
Lab machines are often offline and keys must never ship in a student repo. The
cascade (OpenAI → Ollama → offline playbook) means the copilot degrades from
smart to useful to safe, never to broken. Each tier is independently testable
with the upper tiers stubbed.

**Q3: Why vanilla JS SPA instead of React?**
Zero build step: the portal runs from `node server.js` on any lab box, and the
UI/API contract tests assert on served HTML + routes without a bundler. React
pays off past component-scale complexity; this surface (tables, filters, CSV
export) never reaches it.

**Q4: SPOF / what does the lab portal NOT prove?**
Single-process + file store = no horizontal scale, no concurrent-write safety
beyond atomic replace. AD/GPO/DNS designs (docs 01–11) are lab-topology docs,
not production claims — the honest boundary is stated in each doc's scope line.

## 3. Live-demo script (5 steps)

```bash
# 1. Reset to the known-good baseline, then start
cp internal-portal/fixtures/db.baseline.json internal-portal/data/db.json
cd internal-portal && npm install && npm start   # -> http://localhost:3000
# 2. Log in via the real lab-auth form flow (Bearer token path)
open http://localhost:3000                        # login -> dashboard, assets, tickets
# 3. Raise a High-priority ticket -> instant alert + audit log entry
curl -s http://localhost:3000/api/tickets -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"Promo printer down","priority":"High"}'
# 4. Ask the AI copilot with no cloud keys -> offline playbook answer (never broken)
curl -s http://localhost:3000/api/ai/suggest -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"ticket_id":"..."}'
# 5. Export assets to CSV + run the contract suite
curl -s http://localhost:3000/api/assets/export -H "Authorization: Bearer $TOKEN" && npm test
```

| Step | URL | Expected |
|---|---|---|
| 2 | `http://localhost:3000` | Login → dashboard with assets/tickets/licenses |
| 3 | `POST /api/tickets` | High/Critical alert fires, audit log row |
| 4 | `POST /api/ai/suggest` | Offline ITIL playbook suggestion, no key needed |
| 5 | `/api/assets/export` + `npm test` | CSV download; 278 pass / 1 skip |
