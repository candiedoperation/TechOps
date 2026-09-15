# App Dev Horizon

App Dev Horizon is a FastAPI backend plus the existing product-vision frontend. The backend serves immutable weekly snapshots, evidence-linked warnings, versioned project boundaries, review feedback, audit history, signal-rule definitions, and pull-only source sync jobs.

## Local development

Local mode uses SQLite and seeds seven demo projects. The command below uses an ephemeral in-memory database; omit `PHI_SQLITE_PATH=:memory:` to use the default persistent file. Upstream services are not required for a first run.

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[test,pipeline]'
.venv/bin/pip install -e ../peopleportal/sdk/python/src
PHI_ENV_FILE='' PHI_ENVIRONMENT=local PHI_SQLITE_PATH=:memory: .venv/bin/uvicorn backend.main:app --reload --port 8000
```

From the monorepo root, the equivalent Nx targets are `./nx run
pplsdk-py:generate`, `./nx run horizon:install-deps`, `./nx run horizon:serve-api`,
`./nx run horizon:serve`, and `./nx run horizon:test`. The generated Python SDK
is installed from `peopleportal/sdk/python/src`; the Horizon adapter sends an
explicit service bearer token on generated client operations.

In another terminal, serve the frontend with the local same-origin API proxy:

```bash
npm run dev
```

Open <http://localhost:4173>. The proxy forwards API routes to
`http://127.0.0.1:8000`, which keeps local browser requests same-origin. Set
`PHI_API_BASE` when starting `scripts/serve_local.py` if your API runs elsewhere.

## Authentication and production deployment

Local, demo, and test environments allow public demo access only when no operator
tokens are configured. All other environments require a bearer token from
`PHI_API_TOKENS`, a JSON object mapping each reviewer name to a unique random
secret of at least 24 characters. The server assigns the reviewer identity;
`X-Reviewer-Id` cannot impersonate another reviewer in production. These are
trusted operator accounts with administrative access, not a granular role system.
OIDC/JWT validation is not implemented. `PHI_DEV_AUTH` is obsolete.

Standalone artifact views provide an **Operator session** control; the main UI
receives authentication from its host integration. Tokens stay in page memory
and are cleared on sign-out or reload. A hosting integration may set
`window.PHI_API_TOKEN` in the main UI to a string or async token provider. Keep
tokens out of checked-in HTML. Admin ingestion uses a separate
`PHI_ADMIN_SYNC_TOKEN`; CI ingestion uses `PHI_AGENT_INGEST_TOKEN`.
The upstream People Portal machine credential is `PEOPLEPORTAL_SERVICE_TOKEN`;
Horizon sends it as a bearer token and People Portal maps it to the existing
temporary service-superuser path.

`compose.production.yaml` runs the API and the same-origin web proxy, binds both
ports to loopback, persists SQLite in a named volume, and mounts pipeline artifacts
read-only. Supply the required secrets via your deployment environment, then run:

```bash
docker compose -f compose.production.yaml up -d --build
```

Place the web service behind your HTTPS reverse proxy. Configure
`PHI_ARTIFACT_ROOT` when running the API outside Compose and `PHI_CORS_ORIGINS`
(JSON array) only if you intentionally use separate browser/API origins. The
production image contains no source data, `.env`, or database. Production startup
does not seed demo projects. Back up SQLite and artifact versions before upgrading;
see [the audit and deployment notes](docs/production-audit.md).

## Admin sync endpoints (single-process hosts like Render)

`scripts/run_jobs.py` needs a second process sharing the SQLite file, which a
single Render web service can't offer (its persistent disk attaches to one
service only). `POST /admin/sync/{nightly,weekly,backfill,reset}`
run the same jobs in-process on the service that owns the database instead;
every route requires an `X-Admin-Sync-Token` header matching
`PHI_ADMIN_SYNC_TOKEN`, and refuses all requests when that setting is unset.

- `POST /admin/sync/reset?confirm=erase-all-data` — wipes every row in every
  collection, including immutable weekly snapshots. Irreversible; meant as a
  one-time step to clear the bundled demo fixtures before pointing the
  service at a real org for the first time.
- `POST /admin/sync/backfill?weeks=N` and `POST /admin/sync/nightly` — see
  "Live data" below for what each does and the order to run them in.

## Live data

Point the service at a real Gitea organization and People Portal backend, then drive
the pipeline with `scripts/run_jobs.py`. The service starts no scheduler of its
own, so these commands are the supported entrypoints for cron, a systemd timer,
or a Kubernetes CronJob.

```bash
export PHI_ENVIRONMENT=production PHI_SQLITE_PATH='/persistent/horizon.db'
export PHI_GITEA_URL='https://gitea.example.org' PHI_GITEA_API_TOKEN='…' PHI_GITEA_ORG='appdev'
export PHI_PEOPLE_PORTAL_URL='https://people.example.org' PHI_PEOPLE_PORTAL_API_TOKEN='…'

scripts/run_jobs.py backfill --weeks 10   # once, to seed baselines
scripts/run_jobs.py nightly               # nightly
scripts/run_jobs.py weekly                # weekly, after the last nightly run
```

Each command prints a JSON run report and refuses to start when the upstream
configuration is incomplete; `--allow-incomplete` overrides that check.

Three things are required before any warning can appear:

- **A boundary record per project.** `POST /boundaries` declares the project's
  root Authentik team and its repositories. Repositories outside every boundary
  are never attributed to a project, so a portfolio with no boundaries renders
  entirely as `insufficient_data`.
- **A backfill before the first snapshot.** Signals compare against a trailing
  8-week baseline and need at least four *prior* weekly observations, so a fresh
  database produces no warnings until roughly five weeks of history exist.
  `backfill` replays Gitea one week at a time to create them; a single wide-range
  replay produces one observation and never opens the gate.
- **Team sizes from People Portal.** Contributor counts are retained only when the
  owning team meets `PHI_AGGREGATION_FLOOR`, and the size comes from the team
  hierarchy pull. Without it, contributor signals stay suppressed by design.

Raw pulls land in append-only staging collections (`repo_activity_staging`,
`repo_activity_evidence`, `authentik_teams`, `gitea_repos`) and are folded into
the modelled `repo_activity` collection the rules read. Staging is the archive;
`repo_activity` is a projection, so the in-progress week is refreshed in place
rather than duplicated. The API and jobs use the same SQLite repository. Run
standalone jobs against the same persistent database file, or use the deployed
admin endpoints when a scheduler cannot share that file.

## Docker-backed People Portal and intelligence live stack

`compose.live-test.yaml` provides a Dockerized People Portal server on
<http://localhost:3100>, the Project Health Intelligence API on
<http://localhost:8000>, a static dashboard on <http://localhost:4173>,
persistent local Gitea on <http://localhost:10000>, and MongoDB on
`localhost:27018`. People Portal local-mock mode supplies the directory and ATS
routes consumed by the generated Python SDK (`/api/org/people`,
`/api/org/teams`, `/api/projects/catalog`, and `/api/ats/*`). Horizon pulls team
hierarchy and the authoritative project catalog with that SDK and pulls
repository activity from Gitea. The retired custom project-health routes and
Gitea-org discovery fallback are not used. The Gitea seed uses snapshots of
`../peopleportal/ui`, `../peopleportal/server`, and
`../AppDev-CorpWiki`, creates the other portfolio repositories, and writes ten
weeks of synthetic activity (hundreds of commits) so the baseline rules open.

```bash
docker compose -f compose.live-test.yaml up -d mongodb gitea people-portal-server --build --wait
docker compose -f compose.live-test.yaml exec -T --user git gitea \
  gitea admin user create --username phi-admin \
  --password phi-local-admin-password --email phi-admin@example.invalid \
  --admin --must-change-password=false
.venv/bin/python scripts/seed_live_gitea.py
.venv/bin/python scripts/run_live_stack_test.py

# Start the Dockerized intelligence API and dashboard after the Gitea seed.
docker compose -f compose.live-test.yaml up -d project-health-api project-health-dashboard --build --wait
```

The Gitea administrator command is needed only for a new volume. The seed is
otherwise repeatable: it recreates a read-only API token in the ignored
`.live-test-token` file and force-refreshes the fixture repositories.

Then open <http://localhost:4173>. Stop the stack with
`docker compose -f compose.live-test.yaml down`; add `--volumes` only when an
intentional full reset of the local fixture data is wanted.

## Storage and upstream configuration

Horizon uses SQLite, configured by `PHI_SQLITE_PATH`. PostgreSQL is an optional
analytical export destination through `load_postgres.py`; it is not the API's
operational store. MongoDB in the live test stack belongs to People Portal.

Useful upstream settings include `PHI_AGGREGATION_FLOOR` (default 5),
`PHI_RULE_SET_VERSION`, `PHI_GITEA_URL`, `PHI_GITEA_API_TOKEN`, `PHI_GITEA_ORG`,
`PHI_PEOPLE_PORTAL_URL`, and `PHI_PEOPLE_PORTAL_API_TOKEN`. The People Portal
token is the upstream `PEOPLEPORTAL_SERVICE_TOKEN`; Horizon's Authentik team
adapter remains a fallback when People Portal is not configured.

## API surface

- `GET /snapshots/latest` — accessible current queue and project projections.
- `GET /projects/{id}/snapshots` — immutable project snapshot history.
- `GET /projects/{id}/boundary` — point-in-time boundary record.
- `POST /feedback` — review feedback plus an audit entry.
- `GET /audit` — scoped review/audit log.
- `GET /rules` — active rule definitions and version.
- `GET /boundaries` and `POST /boundaries` — admin boundary listing/version creation.
- `GET /health` — service and notification-mode status.
- `GET /analytics/summary`, `/analytics/members`, `/analytics/members/{login}`,
  `/analytics/organizations`, `/analytics/repositories`, `/analytics/runs` — Gitea
  member analytics (see below).
- `POST /admin/sync/member-analytics` — ingest one analytics run (sync-token gated).

Warnings must include inspectable raw evidence references. Contributor counts and related series are omitted entirely when the configured aggregation floor is not met. Planned pauses short-circuit rule evaluation and are never emitted as risk warnings. No email, Slack, paging, or other outbound notification integration exists.

## Gitea member analytics

The Gitea analytics view and the `/analytics/*` routes report **named, per-person**
contribution metrics: commits, additions/deletions, pull requests, reviews,
issues, active days, and current line ownership from `git blame`.

Named analytics, profiles, recruiting evidence, audit history, and downloadable
résumés require operator authentication outside local/demo/test mode. Project
aggregation gates suppress contributor counts; `PrivacySafeModel` is a legacy
model base name, not an identity redactor. Do not use a generic static file server
at the repository root: use the allowlisted same-origin proxy, which retrieves
private artifacts through authenticated API routes.

The numbers are descriptive activity indicators, **not a performance score**.
Volume is shaped by task size, role, collaboration style, generated code, and
repository history, and should not be used alone for personnel decisions.

### Collect and ingest

`scripts/member_analytics.py` collects a run; the ingest route loads it:

```bash
.venv/bin/python scripts/member_analytics.py \
  --discover-project-orgs --native-history --native-blame \
  --json data/horizon/manual/analytics.json

curl -X POST http://127.0.0.1:8000/admin/sync/member-analytics \
  -H "X-Admin-Sync-Token: $PHI_ADMIN_SYNC_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path": "data/horizon/manual/analytics.json"}'
```

`path` accepts an `analytics.json` file or a pipeline run directory; `payload`
takes the JSON inline instead. Paths must resolve inside `PHI_ARTIFACT_ROOT`.
A run ID is immutable: identical re-ingestion is a no-op, and different content
under the same ID is rejected. Use a new ID for a new collection. Runs are retained
and addressable with `?run_id=`; the routes default to the newest.

### How identities are reported

- **Roster members** are Gitea organization members.
- **Unmatched identities** (`roster_member: false`) are commit identities the
  collector could not confidently match to a roster member. They may be a
  second identity for someone already listed rather than another person, so
  they sort below every roster member and are badged `unmatched`. Only exact
  Gitea-login or full-email evidence, plus unambiguous high-confidence aliases
  within the same organization, are attributed automatically; ambiguous
  conflicts and fuzzy similarities remain separate review candidates.
- **Service accounts** (`service_or_admin`) are automation and admin accounts —
  anything ending in `[bot]`, `-bot`, or `_bot`, plus `gitadmin`. They sort last
  and are excluded from people counts.
- A member with all-zero metrics remains visible in the Members audit with an
  explicit no-activity explanation. Portal roster members stay in the recruiting
  queue even with no scorable evidence, with null scores and no provisional rank.
  Complete observed zeros remain distinct from missing measurements.
- A run's `warnings` are surfaced on the Members page. A non-empty list means
  part of the run is **missing**, not zero: a repository with pull requests
  disabled returns HTTP 404 and contributes no PR, review, or approval data.

### Official Horizon integration

The official platform owns the complete read-only pipeline and its browser
artifacts. `run_pipeline.py` runs the in-repo collector, writes timestamped
snapshots under `data/horizon/`, and builds the People Portal + Gitea profile
artifact and JSON/JSONL ranking evidence export inside the same versioned run.
The main `Profiles` tab reads authenticated,
version-pinned artifacts; standalone views remain at `/analytics/` and `/profiles/`.
The pipeline publishes `latest` only after all requested artifacts validate.
A complete `pipeline-manifest.json` records file hashes, and the stable collection
`manifest.json` identifies the shared API/PostgreSQL run.

The profile build also emits `data/horizon/latest/recruiting-source.json`.
It contains deduplicated People Portal application/interview evidence, bounded
résumé evidence extracted locally from retrieved PDFs, structured employment
evidence for outreach eligibility, and joined Gitea member metrics. Missing or
ambiguous employment evidence is `needs_review`. Employer matches are context
for a human; they do not automatically exclude anyone or alter scores. Active roster
membership is independent from application outcome: members with only rejected
People Portal applications remain in the profile and Gitea join, with that
history preserved as a reviewable field rather than treated as a talent signal.

```bash
python3 run_pipeline.py --api-history --no-blame --sync-api
```

`--sync-api` requires the official API to be running and uses
`PHI_ADMIN_SYNC_TOKEN` from `.env`; omit it when only static artifacts are
needed. To ingest an existing run manually, use the admin endpoint:

```bash
curl -X POST http://127.0.0.1:8000/admin/sync/member-analytics \
  -H "X-Admin-Sync-Token: $PHI_ADMIN_SYNC_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path": "data/horizon/latest/analytics.json"}'
```

The API-history mode is safe for local machines without a loaded SSH key. Use
the default command when native SSH history and blame are available.

## Recruiting signal pipeline

The `Recruiting` view is an evidence-first reviewer workspace. It presents a
provisional discovery ordering from the newest Gitea member-analytics run.
A normalized People Portal ATS export can optionally enrich a later run, but it
is not required to produce the discovery queue. The ordering is not a hiring
decision; the list is gated by explicit human review.

- club organization contribution indicators from member statistics;
- concrete impact evidence extracted from the resume, when supplied; and
- interview evidence from People Portal, when supplied.

Employer names, school names, and other prestige proxies are retained only as
context and are explicitly excluded from the score. The LLM, when configured,
extracts source-backed claims, supporting text, and caveats only; it cannot
change numeric components or the ordering. It also flags contradictions,
duplicate evidence, and incomplete profiles for human inspection. Each candidate must then be
**confirmed, adjusted with a reason, or deferred by a human**. Review writes
update the run, candidate detail, review history, and append-only audit log.
Engineering ability and App Dev Club contribution are stored as separate
deterministic scores; the combined discovery order is a versioned weighted
rubric. The shortlist additionally requires an explicit human eligibility
decision of `eligible`.
The recruiting page also exposes evidence coverage and reviewer-calibration
telemetry, including second-review agreement and disagreement flags.

### API and source contract

- `GET /recruiting/overview` — provisional candidates, review counts, and the
  scoring policy.
- `GET /recruiting/audit` — source coverage, review completion, reviewer
  agreement, calibration flags, and recent reviewer activity for a run.
- `GET /recruiting/shortlist` — only candidates explicitly confirmed or
  adjusted by a human reviewer.
- `GET /recruiting/candidates/{member_login}` — both source summaries,
  evidence references, excluded context, and the current human review.
- `POST /recruiting/run` — generate a new provisional run from the newest
  member-analytics run and any optional People Portal enrichment.
- `POST /recruiting/reviews` — confirm, adjust, or defer one candidate.
- `POST /admin/sync/recruiting` — service-token-gated People Portal pull plus
  pipeline run. The live integration reads the authenticated generated SDK
  operations: `GET /api/org/people`, `GET /api/ats/openteams`, and the generated
  `GET /api/ats/applications/{teamId}/{applicationId}/info` operation.

With no People Portal source ingested, the pipeline uses Gitea member
statistics only and does not fabricate resume or interview evidence. Data
completeness and human review remain separate fields. The live People Portal
integration uses the service-authenticated generated Python SDK and keeps the
bounded API mapping in `backend/people_portal.py`; it no longer requires a
browser ZIP or tabular export for live syncs. The API returns bounded profile fields, application
responses, ratings, notes, and source references. Raw PDF bytes and arbitrary
resume URLs are never sent to Horizon.

Recruiting data is personal data. Production reads and writes require the named
operator tokens described above. Local/demo review writes remain public unless
tokens are configured. Review records, candidate state, run counts, and audit
entries commit atomically. Re-running unchanged inputs returns the same run and
preserves human reviews. Conflicting source IDs are rejected; empty source versions
are valid. The detail page shows the exact source snapshot used by its run.

Unstructured résumé/interview text is held out of scoring and model calls until
an upstream human screening step explicitly sets
`evidence_reviewed_for_scoring=true`. Screen and redact protected information and
prestige proxies before setting this assertion; the flag does not perform that
review itself. Application answers are not interviewer observations. Structured
human interview ratings can contribute to the deterministic rubric. Optional LLM
claims must cite exact supported source text and cannot change scores.

The live recruiting rubric combines contribution and reviewed ability at 55/45,
renormalizing only available dimensions. The separate existing ranking export
keeps its 35/35/30 rubric and is marked as awaiting human evidence screening;
Horizon does not automatically import its LLM ranks into live recruiting or make
employment decisions. See [ranking data quality](docs/ranking-data-quality.md).

## Tests

```bash
.venv/bin/python -m pytest -q
npm test
.venv/bin/ruff check backend scripts tests run_pipeline.py build_member_profiles.py load_postgres.py
```

## Repository-based project signals

Weekly code signals and cumulative progress use bounded Gitea default-branch
evidence. They are separate from both recruiting rankings and the committed-plan
CI assessment below. Enable them with `PHI_LLM_ENABLED=true`, a configured
`PHI_GEMINI_API_KEY`, and the optional `.[llm]` dependency. `.env` is read by
default; process environment variables override it. A process started with
`PHI_LLM_ENABLED=false` stays disabled even if `.env` enables LLMs. No key values
are returned by these endpoints.

All qualitative-analysis paths use Gemini structured JSON output. The shared
`PHI_GEMINI_MODEL` defaults to `gemini-2.5-flash`; the per-path
`PHI_LLM_*_MODEL` variables remain available as optional overrides.
Signal requests use `PHI_LLM_SIGNAL_TIMEOUT_SECONDS` (60 seconds); the outer
weekly and cumulative compute limits default to 90 seconds. CI model settings
do not select the weekly or cumulative model.

- `POST /admin/sync/weekly` defaults to the latest **completed** ISO week.
  An explicit week must start on Monday and be completed. Disabled LLM mode
  selects rules; enabled but misconfigured mode reports an error. Provider
  failures are retryable, with failed project IDs in a `partial` job result.
  `snapshots_written` excludes previously cached projects.
- `POST /projects/{id}/snapshots/at?date=YYYY-MM-DD` computes a completed week.
  `GET` reads cached data. Provider/fetch failures and missing mappings create
  no immutable snapshot; later retries can succeed.
- `POST /projects/{id}/progress/at?date=YYYY-MM-DD` computes progress through
  that exact UTC date. The ending partial week is never written to the weekly
  cache. Today's checkpoints expire after `PHI_CUMULATIVE_PROVISIONAL_TTL_MINUTES`
  (360 by default); historical dates are cached separately, including dates
  within the same week. Future dates are rejected. Cache-only progress reads
  mark stale checkpoints as missing so clients can request a refresh.

Metadata-only weeks disclose that no diffs were reviewed and cap confidence at
0.5. Larger weeks use bounded diff excerpts. Fetch errors are distinct from quiet
weeks; capped history retains collected counts and reports truncation. Weekly
findings and citations survive persistence, and cumulative citations must match
the supplied weeks or findings. Incremental synthesis uses completed-week
anchors and periodically rebuilds older context. Versions `llm-signal-v2` and
`cumulative-v5` avoid reusing judgments from the older behavior; existing data
is retained. Checkpoint storage migrates its unique index to exact dates on startup.

## CI project-health agent (v2 — LLM-driven)

Each project has a lifecycle of roughly 3 months. At kickoff the tech lead
provides free-form context (goals, delivery requirements, milestones, risks).
The agent decomposes this into a week-by-week plan using an LLM, which the
project lead then distributes to the team. Every week the CI pipeline runs an
assessment: the LLM reads the committed plan, the week's structured CI evidence,
and an optional narrative progress update from the lead, then produces a health
signal (`clear`, `watch`, `at_risk`) with inspectable citations and recommendations.

**Architecture guarantee:** the deterministic rule engine always runs first and
produces a baseline. The LLM can only worsen that verdict (raise severity / lower
score), never improve it. Hallucinated optimism and prompt injection in the
progress summary are structurally inert. If the LLM call fails for any reason,
the deterministic baseline is returned unchanged.

### Quickstart — deterministic only (no API key required)

```bash
.venv/bin/python scripts/run_ci_assessment.py \
  --project-id project-health-intelligence \
  --spec fixtures/project-health-spec.yaml \
  --evidence fixtures/ci-evidence-week-3.json \
  --output project-health-assessment.json
```

### Enable LLM enrichment

Install the optional dependency and set your API key:

```bash
pip install -e '.[llm]'
export PHI_GEMINI_API_KEY='replace-with-gemini-key'
export PHI_LLM_ENABLED=true
```

Then run with `--llm` and optionally a narrative progress update:

```bash
.venv/bin/python scripts/run_ci_assessment.py \
  --project-id project-health-intelligence \
  --spec fixtures/project-health-spec.yaml \
  --evidence fixtures/ci-evidence-week-3.json \
  --llm \
  --progress-summary "Auth module is complete and deployed to staging. \
The team is halfway through the data pipeline work for week 3." \
  --output project-health-assessment.json
```

### Kickoff — decompose free-form context into a weekly plan

The tech lead's project context is turned into a structured spec via the API:

```bash
curl -X POST http://localhost:8000/projects/my-project/spec/decompose \
  -H 'Content-Type: application/json' \
  -d '{
    "context": "We are building a data pipeline that ingests activity from Gitea \
and surfaces health signals for engineering leadership. Delivery is 12 weeks. \
The first milestone is a working ingestion adapter at week 4. The second is \
a live dashboard at week 8. Final acceptance is a production-ready service at week 12.",
    "lifecycle_weeks": 12
  }'
```

The response includes the generated `spec` (with `spec_version`) for review.
Commit the spec to the repository before submitting CI assessments so the
version string is stable across all submissions for the project lifetime.

### LLM configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PHI_LLM_ENABLED` | `false` | Set `true` to enable LLM enrichment. |
| `PHI_GEMINI_API_KEY` | — | Gemini API key. Required when LLM is enabled. |
| `PHI_GEMINI_MODEL` | `gemini-2.5-flash` | Shared Gemini model used when a path-specific override is not set. |
| `PHI_LLM_ASSESSMENT_MODEL` | `PHI_GEMINI_MODEL` | Model for weekly assessments (runs on every CI push). |
| `PHI_LLM_DECOMPOSITION_MODEL` | `PHI_GEMINI_MODEL` | Model for kickoff spec decomposition (runs once per project). |
| `PHI_LLM_SIGNAL_MODEL` | `PHI_GEMINI_MODEL` | Optional override for weekly project signals. |
| `PHI_LLM_CUMULATIVE_MODEL` | `PHI_GEMINI_MODEL` | Optional override for cumulative progress. |
| `PHI_LLM_RECRUITING_MODEL` | `PHI_GEMINI_MODEL` | Optional override for reviewer-gated recruiting evidence synthesis. |
| `PHI_LLM_TIMEOUT_SECONDS` | `20.0` | Per-request timeout. Decomposition uses 3× this value, capped at 120 s. |

The deterministic path requires no API key or embeddings. Existing production
deployments must provision the named operator tokens before enabling private reads.

### GitHub Actions workflow

`.github/workflows/project-health.yml` runs on push and pull request, uploads
the JSON assessment, and runs Python, browser regression, and lint checks. The
assessment risk verdict is non-blocking by default; failing tests fail the job. Set
`FAIL_ON_PROJECT_HEALTH_RISK=true` to make `at_risk` or `insufficient_data`
assessments fail CI. Set `PROJECT_HEALTH_INGEST_URL` and the
`PHI_AGENT_INGEST_TOKEN` secret to POST the assessment to the dashboard.
Add `PHI_GEMINI_API_KEY` as a repository secret and pass `--llm` to the
CLI invocation to enable LLM enrichment in CI.

### API endpoints (CI agent)

- `POST /ci/assessments` (alias `/ci/evidence`) — submit `{project_id, spec, spec_format, evidence}`.
  The `evidence` object accepts an optional `progress_summary` string (free-form
  narrative from the project lead; must not contain @handles, email addresses,
  or git co-author trailers).
- `POST /projects/{id}/spec/decompose` — decompose free-form context into a structured spec (admin/portfolio_leader only).
- `GET /projects/{id}/assessments/latest` — most recent assessment.
- `GET /projects/{id}/assessments` — full assessment history.
- `GET /projects/{id}/weekly-tasks` — outstanding tasks from the latest assessment.

Assessments are append-only; submitting the same project and commit SHA is
idempotent. Policy states (`planned_pause`, `insufficient_data`) short-circuit
before the LLM is called — they are never LLM-generated.

The pure rule tests cover baselines, minimum-data guards, evidence, pause suppression, immutability of inputs, and the aggregation floor. See [STATUS.md](STATUS.md) for the frontend-to-endpoint map, assumptions, and remaining stubs.
