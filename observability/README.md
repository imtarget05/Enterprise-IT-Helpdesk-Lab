# Observability - Enterprise IT Helpdesk

Self-contained Prometheus + Grafana + Alertmanager stack for this repo. It lives
here rather than in a shared folder, so cloning **this** repository is enough to
see the whole runtime picture - which is what a reviewer, a demo or a debugging
session actually needs.

## Quickstart

```bash
cd Enterprise-IT-Helpdesk-Lab/observability
docker compose up -d
docker compose config                     # validate without starting
```

| Service | Port | URL |
|---|---|---|
| Prometheus | 9107 | http://localhost:9107 (`Status -> Targets`) |
| Grafana | 3207 | http://localhost:3207 (admin / `$GF_SECURITY_ADMIN_PASSWORD`, default `admin`) |
| Alertmanager | 9307 | http://localhost:9307 |

Reload a config change without a restart:

```bash
curl -XPOST http://localhost:9107/-/reload
```

## Scrape targets

| Job | Metrics path | Port | Service |
|---|---|---|---|
| `llm-gateway` | `/metrics` | 8787 | vendored `llm-gateway/` |
| `helpdesk-node` | `/metrics` | 3000 | Enterprise IT Helpdesk |
| `helpdesk-flask` | `/metrics` | 5001 | Enterprise IT Helpdesk |

## Dashboards

- `project-it-helpdesk.json` - IT Helpdesk - Node + Flask portal ticket/asset counts, request rate
- `golden-signals.json` - Golden signals - QPS / error rate / P95 / saturation per scrape job
- `llm-platform.json` - LLM platform - traffic, latency, token usage, cost governance

## Metrics this repo exposes

| Endpoint | Service | Series |
|---|---|---|
| `GET /metrics` | Node portal (`:3000`) | `helpdesk_tickets_total/_open/_resolved/_critical`, `helpdesk_assets_total/_active`, `helpdesk_licenses_total`, `helpdesk_uptime_seconds`, `http_requests_total{method,route,status}` |
| `GET /metrics` | Flask python-portal (`:5001`) | `ticket_count`, `tickets_open`, `assets_total`, `process_uptime_seconds`, `http_requests_total` |
| `GET /metrics` | llm-gateway (vendored) | `llm_requests_total`, `llm_latency_seconds`, `llm_quota_denied_total` |

## Alerts

`prometheus/alerts.yml` has two groups. `gateway`: upstream down, scrape down, 5xx ratio > 5%, P95 > 2s, circuit breaker open. `services`: any scrape target down for 2m.

## SLOs

`slo.yaml` holds the machine-readable SLI / target / window / error-budget table.

## Operational notes

- Grafana `admin` + a default password is fine for a local demo. For anything
  shared, set `GF_SECURITY_ADMIN_PASSWORD` and keep anonymous access off.
- Every `/metrics` endpoint is aggregate-only and unauthenticated, because a
  Prometheus scraper carries no session cookie. Business detail stays behind the
  existing auth-protected endpoints.
- A target that is not running shows `DOWN`; it never blocks the other jobs.
- Ports are offset per project (Prometheus 9107) so several portfolios can run
  at the same time. Override with `PROMETHEUS_PORT` / `GRAFANA_PORT` /
  `ALERTMANAGER_PORT`.
- Docker is required. CI asserts these configs parse; it does not start the stack.
