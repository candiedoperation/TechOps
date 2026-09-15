# App Dev Horizon implementation status

## Connected surfaces

| Surface | Source | Current behavior |
| --- | --- | --- |
| Overview, projects, insights | `/snapshots/latest`, project snapshots/boundaries | Evidence-backed project warnings and coverage; no invented history. |
| Feedback and audit | `/feedback`, `/audit` | Authenticated writes and scoped reads. |
| Profiles | `/artifacts/{run}/…` | Main and standalone views pin a version and authenticate JSON/PDF access. |
| Analytics | `/analytics/*`, versioned analytics artifact | Named descriptive metrics; missing values remain null. |
| Recruiting | `/recruiting/*` | Versioned evidence, provisional discovery order, attributable human review and calibration. |
| CI assessments | `/ci/assessments`, project assessment routes | Deterministic baseline with optional cited LLM enrichment. |

## Storage and ingestion

Horizon uses SQLite for API state. Its repository serializes operations on a
shared connection and supports atomic source, run, and review transactions.
MongoDB belongs to the optional People Portal live fixture stack. PostgreSQL is
an optional analytical destination; the loader preserves metric missingness and
refuses conflicting writes to an existing run ID.

Project health remains pull-only. Team hierarchy is pulled first; repository
activity is folded per project/repository/ISO week. Backfill replays distinct
weeks so baselines use only prior observations. Aggregation eligibility and
planned-pause rules remain enforced. Tests drive the adapters against fake
upstreams; the destructive live fixture seeding workflow was not executed in
the production audit.

People Portal people, team hierarchy, recruiting evidence, and the project
catalog are pulled through the generated Python SDK with an explicit service
bearer. The catalog is the only project-to-repository mapping source: its
Authentik team PK, Shared Resource ID/Gitea namespace, friendly display name,
revision, effective dates, lead references, and identity issues are preserved
through Horizon's project/boundary fold. Horizon does not call the retired
project-health or Horizons routes and does not infer a mapping from Gitea orgs.

`run_pipeline.py` owns collection, profiles, recruiting sources, JSON/JSONL ranking
exports, manifests, and optional API/PostgreSQL ingestion. Historical runs
contain all derived artifacts. The shared run ID, source hashes, exact identity
proofs, and field availability survive every stage. Failed runs do not replace
the published latest artifacts. Identical source/run replay preserves reviews.

## Authentication and review boundaries

Production requires named bearer operator tokens; tokens identify reviewers on
the server. All configured operators currently have admin scope. OIDC, granular
project roles, and token expiry are not implemented. Local/demo/test access is
public only when no named tokens are configured. Private source files are served
by authenticated artifact routes, never by a generic repository file server.

Portal roster members remain visible even without evidence; missing evidence is
not a zero score. Employer and school prestige do not determine scores or
automatic eligibility. Structured interview ratings and available contribution
metrics drive a versioned deterministic rubric. Unstructured text requires an
explicit upstream human screening assertion before scoring or model use.
The LLM can enrich grounded claims, but cannot alter numeric scoring. Review and
eligibility decisions remain human actions; Horizon makes no employment decision.

The existing 35/35/30 JSON/JSONL ranking export remains a separate provisional artifact and
is not silently substituted for the live recruiting rubric. See
[ranking data quality](docs/ranking-data-quality.md) and
[production audit](docs/production-audit.md) for validation and remaining decisions.

## Deployment decisions still required

Provision individual operator and separate ingestion secrets; terminate HTTPS;
choose and supervise the scheduler; configure persistent storage, backups and
restoration; calibrate the discovery rubric with human reviewers; decide whether
granular authorization/SSO is required. Confirm the project aggregation floor and
authoritative team-size source. Polling is implemented; webhooks and outbound
notifications are not. No Phase 5/ML work was introduced.
