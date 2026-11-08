# Horizon T6.2 read API

This is a **fail-closed implementation foundation, not a completed live ranking integration**. HTTP schemas and business behavior are implemented and tested with fictional repository fixtures. No production ranking tables, membership sources, executive policies, or durable audit schemas are invented.

## Run

Use Python 3.11+ and the existing TechOps Nx wrapper. From the repository root:

```sh
./nx run horizonserver:serve
./nx run horizonserver:test
./nx run horizonserver:lint
./nx run horizonserver:export-openapi
```

On the inspected machine, the default Python is too old. Select the installed supported interpreter:

```sh
PATH="/opt/homebrew/Caskroom/miniconda/base/bin:$PATH" ./nx run horizonserver:serve
```

Use the same prefix for backend tests/lint on this machine. Other machines should select their own supported Python. Dependencies install into the ignored `horizon/server/.venv`. The greeting remains at <http://127.0.0.1:8000/>; interactive OpenAPI is at <http://127.0.0.1:8000/docs>. `openapi.json` is a generated HTTP contract artifact, not storage or policy approval.

No People Portal SDK is needed by these endpoints. The old import only demonstrated SDK generation; removing that unused dependency avoids regenerating unrelated People Portal files when starting Horizon. No People Portal application or SDK files were changed.

## HTTP behavior

| Endpoint | Gate | Behavior when authorized and integration adapters exist |
| --- | --- | --- |
| GET `/api/me` | Valid Horizon JWT | Verified identity plus authorized project memberships from the approved repository adapter |
| GET `/api/semesters` | Valid Horizon JWT | Persisted project-bearing semesters, never dates invented by the API |
| GET `/api/rankings` | Valid JWT, executive, approved audit sink | Semester/run selection, role/project filters, stable page/pageSize pagination |
| GET `/api/rankings/members/{userPk}` | Same executive/audit gate | Persisted component/metric/evidence/explanation details and completed-run semester history |

No token or invalid token: **401**, including `WWW-Authenticate: Bearer`. Verified non-executive: **403** on ranking endpoints. Missing store or audit integration: **503**, never mock results or silently empty data. No matching completed publication/member: **404**. Invalid query: **422**. API responses use `Cache-Control: no-store`; errors do not echo query inputs, tokens, SQL, credentials, or library messages.

Queries use `seasonType=FALL|SPRING` (matching People Portal's season convention), `seasonYear=2000..2200`, `role=engineer|tech_lead`, optional `projectPk`, `run=latest|final|<uuid>`, `page=1..1000000`, `pageSize=1..100`. Member detail uses semester and run selection. Sorting is comparison group, rank (null last), user ID, project ID, then role. Empty filtered pages are valid; missing publications are not fabricated empty results.

`latest` selects the maximum completed run by `asOf`, with UUID as a deterministic tie breaker. `final` selects the latest completed final run, **without fallback**. The final-rule/timestamp/tie-break meaning is **provisional and requires Track 4 approval**: the repository has no ranking-run semantics to resolve it. Failed and running runs are excluded even when explicitly selected by UUID. No score is calculated in FastAPI. Insufficient-data overall scores and ranks must be null. Staleness is strictly greater than eight days since run `asOf`, independent of HTTP/query cache age.

Coverage as a 0–1 fraction, bucket weights as 0–1, 0–100 scores/percentiles, status literals, and detail-envelope names are implemented HTTP draft choices, not approved Track 4 storage/scoring contracts. Raw metrics, evidence references, and `claude_generated` explanations have separate typed fields. No request invokes Claude, Supabase HTTP, or People Portal.

## Authentik configuration — not configured here

The backend verifies **RS256 bearer JWTs** against explicit settings. There is no login endpoint, browser PKCE exchange, cookie authentication, dev token, username allowlist, or runtime auth bypass.

Set backend environment variables only after provider and Track 7 owner approval:

| Variable | Required owner-provided value |
| --- | --- |
| `HORIZON_AUTH_ISSUER` | Exact HTTPS issuer, including its intended trailing slash |
| `HORIZON_AUTH_AUDIENCE` | Audience assigned to Horizon API access tokens; not an unrelated client audience |
| `HORIZON_AUTH_JWKS_URL` | Fixed HTTPS JWKS URL from the approved provider metadata |
| `HORIZON_AUTH_USER_PK_CLAIM` | Approved top-level string claim containing the canonical Authentik member PK; OIDC `sub` is not assumed equivalent |
| `HORIZON_AUTH_NAME_CLAIM` | Approved top-level string display-name claim |
| `HORIZON_AUTH_EXEC_GROUPS_CLAIM` | Approved top-level string-array group claim |
| `HORIZON_AUTH_EXEC_GROUP` | Exact executive group value approved by Track 7; no default is supplied |

Signature, issuer, audience, expiry, issued-at and not-before (when present) are validated; exp/iat/iss/aud/sub and mapped identity/name are required. JWKS lookups use a bounded timeout/cache and only the configured URL, never token-supplied URLs. Missing executive mapping grants no executive access. Algorithm changes, nested/integer PK mappings, scopes, revocation requirements, and field-level permissions require owner review. Never relax these to make a sample token work.

The frontend still has an unavailable auth adapter and disabled live read gate. Its previous backend-cookie proposal differs from the newly requested SPA `oidc-client-ts` + PKCE/bearer design. **No hybrid has been enabled.** Yash must approve the browser-auth architecture, provider/client registration, scopes, callback/logout URLs, token storage/refresh strategy, and same-origin/CORS/CSRF behavior before frontend integration. Merely setting backend JWT variables does not complete frontend sign-in or enable ranking reads.

## Storage and audit blockers

`HORIZON_DATABASE_URL` is backend-only. `ReadDatabase` uses psycopg 3 pooling with bounded connections/waiters/timeouts, repeatable-read read-only transactions, a local statement timeout, parameterized diagnostic SQL, and lifespan cleanup. It performs no migrations. The pool is lazy; no ranking request can use it until a real repository adapter is implemented and reviewed.

`horizon/pipeline/schema.sql` defines deterministic `horizon_gt_features` source/identity/engineering tables only. It does not define `horizon_ranking`, ranking publications/runs, projects/semesters, or `project_members`. Roster snapshots are not authorized project memberships and ownership counts are not final scores. The existing Dagster write resource is unchanged; importing it into FastAPI would unnecessarily pull in Dagster and its write/schema behavior.

Therefore `get_store()` deliberately returns an unavailable adapter. The protocols describe an integration seam, not guessed table names or an approved SQL mapping. Actual persisted ranking queries, index plans, database pagination/history, field redaction and membership semantics remain **unimplemented** pending the Track 4/7 contracts. Future SQL should perform filtering/pagination in the database inside a coherent read snapshot; the fixture service currently filters typed in-memory persisted-output stand-ins for tests only.

`get_audit()` also deliberately fails closed. `RankingAudit.record_read` is an internal adapter seam, not an invented permanent log schema. The approved sink must durably accept the request before ranking rows are returned. There is no production audit sink, denied-request audit policy, retention policy, or success/failed-response event schema in this repository. These remain Track 7 blockers. Test spies are only verification, not production audit logging.

## Tests and optional local PostgreSQL

The default test suite uses entirely fictional records and FastAPI dependency overrides confined to tests. It validates signed ephemeral RSA JWTs and rejects invalid signature/issuer/audience/expiry/claims; there are no stored test secrets. It covers authorization, run rules, null scores, metadata, filtering, pagination, history, missing metrics/evidence, errors, audit failure, and OpenAPI.

There is no Docker or psql executable available in the inspected environment, and no explicit local test DSN was configured. The optional real-Postgres test therefore skips, rather than falling back to Supabase:

```sh
# Supply through a private local environment; never paste a credential into Git.
HORIZON_TEST_DATABASE_URL='<local-debug DSN>' ./nx run horizonserver:test
```

The test permits only loopback port 55432 and database `horizon_debug`, verifies a real read-only transaction and parameter binding, and does not create tables or alter existing records. Its execution would verify the pool, not missing production ranking SQL. `horizon/dev/local-debug` has a synthetic source-feature stack, not a persisted Track 4 publication fixture. No production database was accessed or changed.
