# T6.1 / T6.2 completion audit — November 8, 2026

## Repository and branch integration

The branch details below describe the audit baseline, before the user's subsequent authorization to commit and publish this work to their fork.

- Repository: TechOps; branch: `feat/horizon-frontend`; HEAD `97d4dba`.
- Existing `horizon/webui/` was untracked before this increment. It was preserved and extended, not reset or regenerated.
- `origin`: `taran-vijay/track6horizon`; `upstream`: `candiedoperation/TechOps`.
- Both remotes were fetched. Local frontend and `origin/feat/horizon-frontend` are identical (0/0); frontend and `upstream/feat/horizon-identity-pull-requests` are identical (0/0).
- No new identity commits, changed files, conflicts, or API contracts need integration. No merge is necessary.
- Local `master`, origin/master and upstream/master point at `19c24b9`; frontend and upstream/master diverge by 2 frontend-side and 22 master-side commits, with merge base `42a7f77`. Master was not merged as part of this task.
- No commit, push, merge, rebase, reset, branch switch, PR, production deployment, or production data/schema operation was performed.

## Specifications and conflicts

Read root AGENTS.md/CLAUDE.md, relevant Nx skills, `horizon/features/README.md`, existing frontend integration documents/contracts/tests, server and pipeline/storage/schema, and local-debug documentation. The repository feature plan defines T6.1 broadly and T6.2 as member ranking read APIs. The user's detailed prompt adds concrete paths, JWT architecture, executive restrictions, eight-day age, pagination and response fields; those details are not an existing approved Track 4/7 database contract.

The primary design reference is `/Users/taranvijay/Downloads/app-dev-horizon-full-redesign-v8-light-filters.html`, read in full including styles and JavaScript. It supersedes earlier GitKraken-inspired layout direction. Its HTML/JavaScript was not copied into production. Its real company names, numbers, dates and example status conclusions were not imported as Horizon records.

Two authentication proposals conflict: existing frontend documents describe a Horizon-owned backend OIDC/cookie session (People Portal's pattern), whereas the detailed request describes SPA `oidc-client-ts`/PKCE and bearer tokens. Backend JWT verification is implemented as requested; frontend sign-in remains unavailable, without installing an unconfigured second auth flow or reusing People Portal cookies. Yash must approve one browser-auth flow before enabling it.

No checked-in `horizon_ranking`, final ranking-run/publication tables, project/semester tables, `project_members`, Horizon Track 7 policy implementation or durable ranking audit schema exists. The upstream identity branch introduces no additional dependency. Existing source-feature rows are not substituted for ranking outputs.

## T6.1 completion matrix

“Complete” below refers to the stated foundation behavior, not live auth/data acceptance. Overall T6.1 remains **Partial / externally blocked**.

| Criterion | Assessment | Source / test evidence |
| --- | --- | --- |
| Existing Nx React/TS/Vite application | Complete | `webui/project.json`, package/TS/Vite configs; Nx build/typecheck |
| Tailwind, Router, React Query | Complete | package.json, App.tsx, query-client.ts; app/query tests |
| Shared extensible application shell | Complete | routes.tsx, AppLayout.tsx, AppExperience; app navigation tests |
| Primary prototype layout | Complete for T6.1 structure; visual verification pending | portfolio/PortfolioPages.tsx, portfolio.css; portfolio integration tests. Browser preview permission was declined |
| Dashboard summaries, portfolio health, activity/status/change sections | Complete structure; live values Blocked | PortfolioDashboard; unavailable dashes or explicit fictional MSW data |
| Company/project browser and status/search filters | Complete preview interactions | PortfolioProjects; filters, empty selection and navigation tests |
| Selected project tabs and available snapshot selection | Complete preview interactions | PortfolioProvider, PortfolioProjects; keyboard tabs and snapshot query tests |
| Insights metric/search/status comparison controls | Complete preview structure | PortfolioInsights; metric and missing-data/filter tests |
| Requested canonical routes | Complete registration; live detail Partial | `/rankings`, `/rankings/members/:userPk`, `/projects`, `/projects/:projectPk`; demo/detail tests; legacy preview paths retained |
| Semester selection | Complete demo; live Blocked | provisional hooks and ranking read pages, multi-semester MSW tests |
| Typed tables, score bars, status badges | Complete reusable UI | DataTable, ScoreBar, StatusBadge; acceptance/query/demo tests. Score bounds supplied explicitly, not inferred |
| System/Light/Dark and preference persistence | Complete implementation and automated tests; visual verification pending | theme modules, theme-init.js, appearance/contrast tests. New layout was not visually inspected in the browser |
| Responsive/keyboard navigation | Complete implementation/interaction tests; responsive visual check Partial | AppLayout mobile dialog/top navigation; drawer and portfolio keyboard tests; responsive CSS reviewed, browser access unavailable |
| Loading/empty/error/stale/provisional/missing/401/403 states | Complete reusable/demo behavior | QueryState, States, MSW scenarios; existing and portfolio state tests |
| Run older than eight days | Complete helper/backend calculation; live Blocked | publication.ts, provisional/t62.ts, server/models.py; exact boundary tests; cache age is not used |
| Executive navigation and direct-route restrictions | Complete UI gate; approved live policy Blocked | route navigation metadata, AppLayout, ProtectedRoute executiveOnly; acceptance/auth tests. Missing isExec denies |
| Unauthenticated sign-in redirect | Complete guard behavior; live sign-in Blocked | ProtectedRoute and auth tests. Unconfigured auth remains explicitly unavailable |
| Authentik OIDC/PKCE login/logout | Blocked / not complete | adapter.ts remains unavailable. No provider, approved browser flow, callbacks or scopes |
| Centralized read client and caching/refetch | Complete infrastructure | client/transport/use-horizon-query; client/query/pagination tests |
| Live `/api/me`, `/api/semesters`, ranking/project reads | Blocked | No live registry or release gate enabled; backend storage/audit/auth dependencies unresolved |
| Only Horizon read APIs; no browser Supabase/People Portal/Claude | Complete boundary | transport and guarded providers; no such browser SDK/client introduced |
| Development demo excluded from production | Complete | explicit serve flag, loopback namespace, omitted credentials, MSW fail-closed handlers; gate tests and flagged production artifact scan |
| Progress charts and deep historical analysis | Deferred / Partial | Generic meter and status/table structures exist; verified milestones, rubric charts and real comparisons belong to T6.4–T6.6 |

## Reference implementation and intentional adaptations

Implemented top navigation/branding, maximum-width portfolio canvas, four summary cards, portfolio health/company cards, activity metrics, status breakdown, weekly changes, grouped company search/status filters, selected-project panel, Overview/Progress/Concerns/History tabs, available snapshot selection, and Insights comparison controls. Light surfaces, rounded cards, blue active controls, spacing and information hierarchy follow the reference; dark colors use existing semantic theme tokens.

Adaptations: retained Settings and executive-only ranking access; mobile navigation uses an accessible dialog; tabs support keyboard navigation; the snapshot selector lists actual available fixture checkpoints rather than implying every calendar date has data. Selecting history changes the query/snapshot, not just a cosmetic date label. Companies that no longer match filters cannot leave an unrelated detail panel visible. Insights show per-project metrics with company context rather than inventing a company-average scoring model. Confidence, verified delivery and unsupported metrics are unavailable, not hardcoded.

Deferred: production project-health API/schema, real company/project grouping contracts, verified SOW milestone charts, inferred concerns/recommendations, confidence calculations, cross-run comparison analytics, and full member-ranking/explorer/evidence workflows (T6.4–T6.6). Fictional component/history details remain demonstrable without claiming those live features are complete.

## T6.2 completion matrix

Overall: **Partial**. HTTP/security/service architecture works against isolated fixtures, but production storage binding and audit are deliberately unavailable.

| Criterion | Assessment | Evidence / limitation |
| --- | --- | --- |
| FastAPI structure, preserved greeting, `/docs` | Implemented | server/app, compatibility main.py, API/OpenAPI tests |
| Typed models, camelCase, safe consistent errors | Implemented HTTP draft | models.py, routers.py, main.py, generated openapi.json; schema/validation/error tests |
| `/api/me` | Implemented/tested with fixtures; live Blocked | Identity from validated principal; repository supplies memberships. No roster-as-membership shortcut |
| `/api/semesters` | Implemented/tested with fixtures; live Blocked | Repository supplies project-bearing semesters; no fabricated production semesters |
| Ranking list/filter/page/sort | Implemented/tested fixture service | services.py, test_api.py; actual SQL pagination Missing pending tables |
| latest/final/UUID and failed/running exclusion | Implemented/tested; final policy Partial | Latest completed final without fallback is provisional; no repository final-run semantics exist |
| Member components/metrics/percentiles/gaps/evidence/explanations/history | Implemented typed fixture behavior; live Blocked | Separate raw evidence and Claude explanation fields; complete-run semester history tests |
| No scoring inside HTTP API; null insufficient scores | Implemented | Pydantic validator and service pass-through; null-score tests |
| JWT issuer/audience/JWKS/signature/expiry/claim validation | Implemented/tested architecture; live Blocked | auth.py; ephemeral RSA signature and invalid-claim tests. No provider registration |
| current_user / require_exec; 401 vs 403 | Implemented/tested | auth.py plus API tests; no runtime bypass, no username/email privilege rule |
| Approved executive mapping / field policy | Blocked | Explicit owner-provided mapping required; real ranking store/audit unavailable |
| Durable executive audit logging | Missing approved sink; seam implemented | get_audit fails closed; spy/failure tests are not durable logging |
| psycopg 3 pool/read-only/cleanup/parameterization/safe DB errors | Infrastructure implemented | db.py and mock pool tests; optional local read-only integration test skips without explicit DSN |
| Confirmed ranking/membership SQL adapter | Missing / Track 4 blocked | No guessed schema, ORM, migration, source-count scoring or mock production fallback |
| Real local PostgreSQL fixture end-to-end | Not verified / Blocked environment | No Docker/psql executable or explicit test DSN; in-memory fixtures do not prove real database behavior |
| Nx backend test/lint and OpenAPI export | Implemented | horizonserver project targets; no unrelated SDK generation required |
| Frontend contract synchronization | Partial, intentionally gated | provisional/t62.ts documents actual HTTP names; older cursor demo contracts preserved, no automatic approval/activation |

## Configuration, ownership and verification

Final automated results on November 8:

- Frontend: **119 tests passed across 12 files**; Nx production build, typecheck, lint and formatting passed.
- Backend: **51 tests passed, 1 skipped**; Nx lint passed. The skip is the explicitly opt-in local PostgreSQL test; it is not a database-integration success.
- Existing unchanged pipeline: **24 tests passed**.
- Building with `VITE_HORIZON_DEMO=true` still excludes demo runtime, fictional records/company names, reserved mock paths and MSW worker; the artifact check passed.
- The two local Nx serve targets launched and listened on loopback ports 8000 and 5175. `/docs`, OpenAPI, authenticated fixture response shapes and anonymous rejection are verified by the in-process FastAPI TestClient tests, not by a live Authentik session.
- Browser navigation to the new preview was denied by the app's origin-permission gate. No alternate browser, curl-to-frontend, screenshot workaround or permission bypass was attempted. **Light/Dark visual inspection and responsive browser verification remain unverified for this increment.** Earlier November 1 screenshots do not represent this new layout.
- Python tests emit a Starlette/httpx deprecation warning; it does not fail tests. Dependency tooling findings are maintenance items, not silently fixed with forced unrelated upgrades.

See [server/README.md](server/README.md) for exact Nx commands, Python selection, backend JWT variables, local DB verification and endpoint semantics. Frontend:

```sh
./nx run horizonui:serve                 # secure unavailable-data preview, port 5174
./nx run horizonui:serve-demo            # explicit fictional MSW demo, port 5175
./nx run-many -t build typecheck lint test format-check -p horizonui
VITE_HORIZON_DEMO=true ./nx run horizonui:verify-production
```

Pending Yash / Track 4 / Track 7 decisions: Authentik issuer/audience/JWKS/claims and canonical PK mapping; executive group policy; backend-session vs SPA PKCE browser flow; final-run selection and asOf semantics; score/coverage/weight scales and status enums; real publication tables and project-membership/semester schemas; field/evidence redaction; durable audit schema, retention and denial events; approved read-only DB role/SSL/connection delivery; project-health/portfolio publication contract. Credentials stay backend-only and must be exchanged privately.

No live Authentik, database ranking query, audit sink or Supabase integration success is claimed. Tests use local fictional records and dependency overrides. The optional DB probe never falls back to production.

## Changed files and review boundaries

### Follow-up UI polish

The rankings filter row now has consistent 20px card-body insets, auto-fitting columns and equal-height controls. Component panels have matching insets; navigation labels and status badges no longer split across lines, and long descriptions/evidence references wrap within their containers. Added layout regression guards. Follow-up verification: 122 frontend tests passed, 51 backend tests passed with one optional database test skipped; build/typecheck/lint/format and production demo exclusion passed. Live-auth/database blockers are unchanged. Browser visual inspection remains subject to the earlier permission limitation.

T6.1: existing untracked `horizon/webui/` preserved/extended: app routes/layout/provider, executive hints/guard, semantic styles, ScoreBar, portfolio page/context/provider/CSS, draft portfolio/T6.2 types, MSW fixtures/parsers/handlers/provider, acceptance/interaction tests, documentation. Existing production auth/read gates stay closed.

T6.2: `horizon/server/main.py`, project.json, requirements.txt; new requirements-dev.txt, README.md, openapi.json, `app/{__init__,main,config,auth,db,errors,models,ports,services,routers,export_openapi}.py`, and `tests/{conftest,test_api,test_auth,test_db}.py`. This audit is new. Identity, pipeline, schema.sql, persistence and unrelated apps remain unchanged.

Recommended separate commits/PRs (not executed):

1. `feat(horizon): finish reference-aligned frontend foundation and isolated demo` — webui only. Clearly label live Authentik/read integration blocked, and deeper features deferred.
2. `feat(horizon): add fail-closed ranking API architecture and tests` — server plus this integration audit. Explicitly identify missing production repository/audit adapters rather than claiming T6.2 is complete.
