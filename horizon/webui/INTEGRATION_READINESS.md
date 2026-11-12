# T6.1 refinement and live-integration readiness

## Inspected baseline

Work remains on `feat/horizon-frontend`, in the existing standalone Nx workspace. The existing React routes, read client, query provider, tests, Python server, pipeline, and identity modules were inspected before the refinement. No backend implementation was replaced or modified.

- The frontend already had working Nx build/serve targets, structural Dashboard/Rankings/Project Health pages, protected component guards, and a disabled authentication adapter.
- The visual gaps were light-only hardcoded colors, very small typography, repeated spacing values, an oversized decorative hero, and no appearance preference. These are addressed by semantic tokens and a denser layout; the route registry and application shell remain intact.
- People Portal's theme provider uses `system`, `light`, and `dark` preferences, root theme classes, and local storage. Horizon follows those conventions independently, adding live system listeners, blocked-storage recovery, cross-tab updates, and initialization before first rendering.
- People Portal performs OIDC discovery, authorization-code/PKCE exchange, state verification, server-side access/refresh-token handling, and cookie sessions. Its `peopleportal_sid` session and Express/Bindles implementation are not reused by Horizon's Python server. The Horizon identity pipeline maps Git/Gitea attribution to Authentik PKs; it does not authenticate browser users.
- `horizon/server/main.py` still has only the greeting at `GET /`. No Horizon browser-auth, ranking, or project-health endpoints are implemented there.

## Appearance and UI

Settings → Appearance provides System (default), Light, and Dark. Only `horizon-ui-theme` is saved in local storage. There are no stored credentials or member/project results. System listens for `prefers-color-scheme` changes; a manual preference ignores them until System is selected again. Storage errors do not prevent the app from working.

`public/theme-init.js` runs synchronously in the document head, before the app module and generated styles. It resolves the saved preference and sets the root theme/color-scheme before rendering. Keep its storage key and accepted values aligned with `src/theme/appearance.ts`. The production host must serve this static asset and allow same-origin scripts in its CSP. No unsafe inline-script exception is required for this bootstrap.

All component colors use semantic CSS variables, including backgrounds, text, navigation, forms, tables, statuses, skeletons, focus outlines, and future chart series. Decorative gradient/orbit styling was removed. Buttons, controls, panels, table density, and typography now share a consistent hierarchy. The existing native mobile dialog, skip link, keyboard focus indicators, and reduced-motion behavior are retained.

## Proposed Horizon-owned authentication routes — NOT IMPLEMENTED

These exact paths are a proposal for backend-owner review, not callable frontend configuration:

| Method | Proposed path                                       | Contract to agree                                                                                                                                           |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/horizon/auth/login?return_to=<internal-path>` | Start a Horizon Authentik flow and redirect to the issuer. Validate `return_to` server-side against internal paths.                                         |
| GET    | `/api/horizon/auth/callback`                        | Validate state/PKCE, exchange code on the server, rotate the session, and redirect to the validated app path.                                               |
| GET    | `/api/horizon/auth/session`                         | Return minimal session identity, capability hints, and expiry, or a structured 401/403. Refresh credentials server-side where appropriate.                  |
| POST   | `/api/horizon/auth/logout`                          | Verify CSRF protection, destroy/revoke the Horizon session, expire its cookie, and return a safe response. Provider SSO logout behavior remains a decision. |

Draft JSON types live in `src/api/contracts/provisional/auth.ts`. They intentionally separate the OIDC subject from the Authentik member PK. Serialization of PKs must be agreed with the identity owner; no database/member identity contract was changed.

The frontend `AuthState` now distinguishes loading, unavailable, anonymous, authenticated, expired, forbidden, and error states. Expiry redirects preserve an internal path, query string, and fragment. Authorization denial suppresses cached results and shows a distinct restricted state; it does not pretend that another login grants access. Logout clears/hides local protected data even if server logout cannot be confirmed. The default adapter remains unavailable.

Before enabling this integration, agree on the Horizon Authentik client, issuer, scopes, local/staging/production callback URLs, post-logout behavior, and same-origin routing. Use an independent secure HttpOnly cookie, server-side token storage, per-flow state/PKCE, session rotation/expiry, and a production session store. Keep secrets on the backend. Review CSRF protection, cookie SameSite/path/domain, and proxy/TLS settings. Do not copy People Portal's development MemoryStore into production.

## Track 7 authorization decisions — NO POLICY INVENTED

People Portal uses OIDC authentication plus resource/Bindles checks and executive checks. Those existing permissions do not establish Horizon's evidence-access policy. The list below identifies decisions, not suggested role grants or permission names:

| Surface                      | Decision required from Track 7 owners                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Member-ranking lists         | Who can enumerate members, scores, filters, and semester results? What fields require redaction?   |
| Individual member profiles   | How do self, same-project, and other-member views differ?                                          |
| Component scores             | Which dimensions, coverage gaps, and uncertainty fields may each viewer see?                       |
| Evidence and source links    | Which source facts, questionnaire/experience evidence, links, and direct-source permissions apply? |
| Project-health results       | How is current project membership/lead responsibility evaluated? Which projects are visible?       |
| Project-health history       | Do historical results follow current access or access at publication time?                         |
| Reviewer information         | Who can see findings, review details, identity corrections, and audit records?                     |
| Administrative functionality | Which operations require explicit administrative authority, and what audit trail is required?      |

Enforce these rules on the backend for every read and returned field before data is exposed. UI capability strings remain opaque hints; no role-to-capability mapping is shipped. Decide audit fields, denied-access handling, permission revocation, and cache/session invalidation. The client fails closed on 401/403 and does not parse their response bodies.

## PostgreSQL/Supabase persistence findings

Horizon already has `PostgresResource` in `horizon/pipeline/storage.py`, backed by `psycopg`. It uses transactions and the canonical `HORIZON_DATABASE_URL`; `GITEA_ANALYTICS_DATABASE_URL` is an existing legacy alias. Generic `DATABASE_URL` is deliberately not accepted. Source/roster tokens have separate server-side configuration.

The checked-in SQL schema is `horizon/pipeline/schema.sql`. `ensure_schema()` applies its create/upgrade statements under an advisory transaction lock. This existing mechanism, rather than a competing migration framework, currently owns feature-store schema setup.

Verified checked-in tables in `horizon_gt_features`:

- `pipeline_runs`, including incomplete/complete status, source provenance, counts, and completion checks.
- `blame_records`, `file_ownership`, `member_repository_ownership`, and `member_ownership`.
- `member_roster_snapshot` and `git_identity_mapping`.
- `eligible_file_ownership` and `engineering_contribution`.
- `member_pr_review_counts` and `pr_linked_commit_messages`.

These are deterministic source/identity/contribution outputs, **not final member rankings or project-health publications**. The checked-in schema has no final Track 4 ranking or Track 5 project-health tables. `sow_llm_issues` is described as planned in the feature README, not implemented in this SQL schema. Database contents, deployed schema versions, and Supabase access were not inspected; repository support does not prove a live environment is configured.

Coordinate server-side project/environment, connection host/port or pooler, TLS/network requirements, database role/grants, secret delivery for `HORIZON_DATABASE_URL`, schema owner/version, and completed publishable runs with Yash. The invitation is separate from database connectivity. No Supabase URL, anon key, service-role key, or password is required by this frontend. No live tables or production data were changed.

## T6.2/T6.3 draft contracts and hooks

`src/api/contracts/provisional/` contains explicitly named provisional types for periods, available filters, cursor pagination, coverage, evidence references, member components/profile/history, health components/details/trends, and publication metadata. Score units and health labels are backend-defined; absent values stay null. No records, final ranking rubric, health thresholds, or role mappings are fabricated.

`src/api/contracts/registry.ts` has `reviewStatus: 'pending'` and **no registered endpoint builders**. The default auth adapter and source-level read gate remain unavailable/false. The provisional hooks return unavailable and make no network request, even with manual refetch. No guessed production ranking/health URLs are provided.

Once owners agree on OpenAPI, reconcile names/nullability/units, implement runtime validators, move the approved DTOs out of `provisional/`, and register confirmed `ReadOperation` builders. Registry review status is an integration guard, not an authorization control. Enabling it alone does not open the independent read/auth gate or provide backend access.

The generic query infrastructure supports cursor pagination, cancellation, refetch, bounded transient retries, and cache keys scoped to user, feature, period, page size, and filters. Single-page and infinite-page caches use separate keys. `Pagination` uses explicit backend cursor availability and disables controls while fetching. No page totals or next cursors are inferred.

`QueryState` accepts an internal `PublicationFreshness` display model. Only a reviewed response parser should populate it from backend metadata. It distinguishes current, stale, provisional, and missing; missing suppresses any cached result and provisional is explicitly labeled. Query cache staleness is separate from source/publication freshness.

## Questions for Yash / track owners

1. Can we reserve the four proposed `/api/horizon/auth/*` routes? Who owns the FastAPI OIDC/session implementation, Authentik registration, cookie/CSRF contract, and issuer logout decision?
2. Who owns Track 7's field/evidence visibility matrix and audit requirements, and where will the approved policy/capabilities be published?
3. Who owns T6.2/T6.3? Can they review the draft DTOs and provide endpoint/OpenAPI definitions, supported filters, periods, pagination, errors, and freshness semantics?
4. Which Supabase environment, connection method, least-privileged role, and secret-management workflow should the backend/pipeline use?
5. Where will final Track 4/5 outputs be persisted, who owns schema changes, and what identifies a complete publishable ranking/health result?
6. What local/staging environment can verify actual login, expiry, logout, permission denial, and real authorized reads?

## Next steps in dependency order

1. Approve authentication/session and Track 7 policy contracts.
2. Implement backend sessions and authorization tests; configure local/staging Authentik.
3. Confirm Track 4/5 publication persistence and implement authorized T6.2/T6.3 reads.
4. Approve DTOs/parsers, register actual reads, and replace locked feature previews with protected API-backed pages.
5. Enable integration only after backend access tests pass, then verify login/expiry/logout, redaction, account changes, pagination, and publication states in staging.

The shell/theme, frontend states, provisional contracts, and query infrastructure can be completed without Supabase. T6.1's live Authentik and real API-backed acceptance criteria remain blocked until the above dependencies exist.
