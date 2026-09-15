# Horizon production audit — 2026-09-09

The audit repaired the existing backend, browser, collection pipeline, analytical
exports, and deployment setup in place. It preserved the pre-existing working tree
and published source/ranking artifacts. No production deployment, external model
call, live source seeding, or employment decision was performed.

## Bugs fixed

- **Production authentication:** the previous unconditional public-admin identity
  exposed named evidence and allowed unauthenticated reviews. Production now
  requires individual bearer tokens configured in `PHI_API_TOKENS`. Reviewer IDs
  are assigned by the server, not an arbitrary browser header. Audit, analytics,
  recruiting, profiles and résumés are protected. Admin and CI ingestion use
  separate secrets. Health and static rule definitions remain public.
- **Private files:** the local web server previously exposed the repository and
  data tree. It now serves only public UI assets and proxies allowed private
  artifacts through authentication. Path/symlink containment blocks escapes;
  directory listings are denied. The proxy retains artifact security headers and
  forwards reviewer/CI authentication headers. Browser sessions keep tokens in
  memory, and sign-out clears private state.
- **Source correctness:** equal timestamps no longer combine unrelated portal
  sources. Explicit empty versions work. Exact email/login conflicts are rejected
  or retained as unresolved evidence, and a canonical profile join cannot be
  overwritten by raw analytics. A named source binds its named analytics run.
  Candidate detail contains the exact joined source snapshot used for scoring.
- **Immutable versions:** changed content cannot overwrite an existing analytics
  or recruiting source ID. Content fingerprints make unchanged runs idempotent
  and preserve reviews. Ingestion and recruiting/review updates commit atomically,
  including audit history and run counters; failures roll back partial writes.
- **Missingness:** absent, incomplete, unlinked and unavailable metrics remain null
  through SQLite, profiles, scoring, JSON/JSONL and PostgreSQL. Invalid/nonfinite metric
  counts cannot become usable measurements. Ambiguous aliases remain separate;
  distinct counts across overlapping aliases are not blindly summed. Available
  scoring dimensions are renormalized instead of filling gaps with zero.
- **Human review:** portal roster members without scorable evidence stay visible
  with null scores/ranks. Employer matches no longer automatically exclude anyone.
  Application answers are not interviewer observations. Unscreened free text is
  held out of scoring and model calls. Optional model claims require supported,
  exact source citations and cannot alter deterministic numeric scores.
- **Review state:** stale browser responses cannot replace a different candidate
  or run. Invalid/colliding rank adjustments are rejected, required rationale is
  enforced, full review history is returned, and repeat edits by one reviewer do
  not count as independent reviewer agreement.
- **Artifact publication:** the official pipeline builds profiles and the JSON/JSONL
  ranking evidence export inside the historical run. One stable run ID
  flows through manifests and both databases. Output/input paths are resolved
  before subprocess execution; first native runs no longer require a previously
  recorded SSH probe. Collection failures preserve prior `latest`; publication
  uses atomic file replacement and a symlink, with conservative completed-run
  pruning and a process lock.
- **Browser artifacts:** main and standalone profile/analytics views authenticate
  reads and downloads and pin related artifacts to one run. Standalone pages
  provide the operator session control; the main UI accepts a host-provided
  token. Unsafe repository URL schemes are rejected.
- **Deployment:** Docker starts the actual API, uses a persistent SQLite location
  and non-root user, makes copied source readable regardless of local file modes,
  and excludes secrets/private source data. The fixture entrypoint is explicit in
  the live-test Compose file. The scheduled workflow calls the deployed admin API
  instead of writing an isolated runner database. PostgreSQL loads use explicit
  configuration, additive null-preserving schema changes, and idempotent conflict
  checks.

## Dead code and misleading integration removed

Removed always-successful privacy validators and their empty forbidden-key walker,
unused recruiting helpers/imports, and obsolete Mongo/InMemoryStore test plumbing.
Actual CI identity/fact-reference checks remain enforced; unused signal-reference
validation is now applied rather than discarded. `PrivacySafeModel` remains a
compatibility model name and is not represented as a redaction mechanism.

Documentation no longer claims implemented OIDC, Motor/Beanie runtime storage,
public production review access, automatic employer exclusion, or missing-roster
removal. The separate MongoDB service remains where People Portal requires it.
No source datasets, prior ranking results, design artifacts, or unrelated work
were removed.

## Integration and review policy

`run_pipeline.py` is the collection/publication entrypoint. It invokes
`build_member_profiles.py` and `scripts/build_llm_ranking_export.py`. It writes a
stable collection `manifest.json`
and a completed `pipeline-manifest.json` with file hashes. The profile source
retains exact identity decisions, canonical metric availability and provenance.
`--sync-api` posts the payload and matching source versions; `--load-postgres`
loads the same analytics ID into the optional analytical database.

The existing external ranking export retains its 35% technical execution / 35%
technical leadership / 30% club contribution rubric. It remains a provisional
review artifact. Its ranks are not automatically substituted into live recruiting.
The live rubric remains explicit and versioned at 55% contribution / 45% reviewed
ability, with missing dimensions omitted and remaining weights renormalized.
A stale external ranking result remains intact while its ranks and scores are
withheld from regenerated JSON/JSONL exports when source hashes no longer match.

Structured protected attributes and prestige fields are excluded from model
member cards. Unstructured text may still contain sensitive information. An
upstream human must screen and redact it before setting
`evidence_reviewed_for_scoring=true` or submitting external evidence exports to a
model. The assertion records trust in that screening step; it does not perform
screening. Human numeric interview ratings can be scoring inputs. These signals
support evidence review and do not determine employment selection or rejection.

## Checks and results

| Check | Result |
| --- | --- |
| Initial test state | Full collection failed on retired store imports; 383 tests passed when the two incompatible modules were omitted. |
| Final Python suite | **434 passed**, including the real PostgreSQL integration test; no skips with the isolated database configured. |
| Frontend regression tests | **4 passed**: late candidate response, previous-run response, stale review selection, and pinned artifact versions. |
| Syntax and static checks | Ruff, Python compileall, JavaScript syntax checks for all views/session helper, and Git whitespace check passed. |
| Dependency consistency | `pip check` passed. |
| Dependency vulnerability checks | Installed audit environment and pinned runtime `requirements.lock`: no known vulnerabilities reported by `pip-audit` at audit time. |
| Pipeline integration | Complete synthetic CLI orchestration, source/artifact hashing, deterministic rebuild, failed-write rollback, idempotence and safe pruning passed. |
| Existing-source rebuild | Isolated copy: 218 analytics members → 237 profiles/source candidates/signals/export cards; 48 lacked scorable evidence and remained unranked; repeat run idempotent; no LLM call. |
| Browser smoke | Anonymous rejection, named sign-in, candidate evidence, synthetic defer/save with reviewer attribution, persisted review after restart, main/standalone profiles and sign-out verified. Layout inspected. |
| Docker | Image built; non-root startup, protected reads, artifact headers, empty production store and SQLite persistence across restart passed. Both Compose files validate. |

The final tested Docker image is
`sha256:0c9c7010202a3d651c3de05b2b1167d3788d8efafb059347fbeb6dbe451aaeaf`.
Dockerfile.render has the same contents as Dockerfile. The dependency audit covers
Python packages, not an OS/container vulnerability scan or a full penetration test.

Reproduce the core checks from the repository root in an isolated environment:

```sh
python3 -m venv .venv-audit
.venv-audit/bin/pip install -e '.[test,llm,pipeline]'
.venv-audit/bin/python -m pytest -q
npm test
npm run check
.venv-audit/bin/ruff check backend scripts tests run_pipeline.py build_member_profiles.py load_postgres.py
.venv-audit/bin/python -m compileall -q backend scripts run_pipeline.py build_member_profiles.py load_postgres.py
.venv-audit/bin/python -m pip check
docker build -t horizon:audit .
```

Set `PHI_TEST_DATABASE_URL` to an **isolated test PostgreSQL database** to include
the loader integration test; otherwise that single test skips. Tests disable the
local `.env`, use synthetic inputs, and do not require a Gemini key. Runtime
container installs are constrained by `requirements.lock`; optional test tools
are outside that runtime constraint file.

## Remaining risks and deployment decisions

1. **Provisioning and authorization:** choose individual operator identities,
   rotate secrets, provision separate ingestion secrets, terminate HTTPS and
   configure the intended origins. Every named operator currently has admin
   access. Expiring tokens, SSO/OIDC, granular roles, rate limiting and enterprise
   access policy remain deployment/product decisions. Local mode is intentionally
   public and must not be used to expose private data.
2. **Storage operations:** select a single supervised API process for the SQLite
   deployment, persistent storage, backup/restore procedures and monitoring. The
   audit verified transactional rollback and restart persistence, not disaster
   recovery under load. File publication, API synchronization and PostgreSQL are
   separate systems; an optional sync failure requires retrying that completed
   version. The one-time migration from a real `latest` directory preserves the
   old directory under a hidden legacy name and has a brief rename transition.
3. **Existing publication migration:** the audit did not overwrite the existing
   published profiles, source ZIP, database or historical ranking result. Rebuild
   a new complete pipeline version and ingest it before relying on the corrected
   source contracts in a running deployment. Use a new version for legacy source
   records without content fingerprints; back up existing state first.
4. **Human evidence quality:** resolve ambiguous identities from exact account,
   email, repository and authored-commit evidence. Review collection gaps and PDF
   extraction statuses. Some existing PDFs produced parser repair warnings during
   the isolated rebuild. Successful extraction does not establish completeness,
   truth, or absence of protected information.
5. **Rubric calibration:** decide whether the two existing rubric purposes should
   remain separate. Validate the live discovery ordering with representative
   human reviews before wider use. Volume metrics remain descriptive indicators,
   not proof of ability. Keep outreach eligibility and every employment decision
   under explicit human control.
6. **Live infrastructure:** the fake-upstream integration and isolated PostgreSQL,
   container and browser checks ran. The live Gitea/People Portal fixture workflow
   was not run because its seeding force-refreshes adjacent fixture repositories.
   Real source credentials, network/rate limits, a production reverse proxy,
   scheduled deployment execution and optional external model calls remain
   unverified here. Native collection needs Git/SSH tooling and known hosts on
   its collection machine; the production image is configured to serve the API.

See [README](../README.md) for configuration and
[ranking data quality](ranking-data-quality.md) for field and artifact semantics.
