# Completing T6.1: backend handoff

The frontend foundation runs without a database. It must remain disconnected until Horizon authentication, read APIs, and Track 7 authorization are available. Supabase access alone does not unblock protected website data.

The subsequent refinement adds appearance settings and **provisional** DTOs/hooks. [INTEGRATION_READINESS.md](./INTEGRATION_READINESS.md) records the current repository findings and exact proposed auth route names. Those names are proposals, not implemented or enabled endpoints; `src/api/contracts/registry.ts` remains pending with no registered URLs.

## 1. Horizon authentication contract

Agree with the backend/identity owner on:

- Horizon-owned sign-in initiation, OIDC callback, current-session read, and logout routes; HTTP methods and success/error response formats. **No endpoint names have been assumed.** People Portal's equivalents are architectural references, not Horizon contracts.
- The Authentik issuer/discovery URL, Horizon application/client registration, scopes, and exact allowed callback and post-logout URLs for local, staging, and production environments.
- A canonical member identifier, display-name field, and UI-visible capability format. Existing pipeline member IDs use the Authentik PK; agree how the signed-in subject maps to it instead of inferring identity from email.
- A separate Horizon session cookie and server-side token storage; cookie name, domain/path, HttpOnly/Secure/SameSite behavior, expiry/refresh rules, session rotation, and session store. Keep OIDC client secrets and access/refresh tokens out of Vite variables and browser storage.
- Same-origin API routing and safe return-path validation. The current transport deliberately refuses cross-origin cookie requests; a different deployment requires an explicit CORS/cookie review.
- CSRF protection for logout and any future mutations. The read client itself supports GET only.
- Whether logout ends just the Horizon session or also Authentik SSO. People Portal currently destroys its own session but does not perform provider logout; these are distinct behaviors.
- JSON 401/403 responses for API calls, with no HTML login redirect, protected response body, or credentials in errors.

Implement the resulting contract behind `HorizonAuthAdapter` in `src/auth/adapter.ts`. Add session-expiry/revalidation handling when its semantics are known. The default adapter currently cannot authenticate anyone.

## 2. Track 7 access policy

Obtain the approved member/project-lead/reviewer/admin visibility matrix, per-project restrictions, field/evidence redaction rules, and access-audit requirements. Enforce these on the backend **before** enabling any protected read. A signed-in member is not automatically permitted to read rankings or project evidence.

Agree how session changes and permission revocation are detected. Frontend cache clearing reduces accidental display; it cannot implement backend authorization. Verify expiry and revocation against a real backend before release.

## 3. Track 6 read APIs and Tracks 4/5 outputs

For each supported view, provide OpenAPI schemas or approved sample responses covering:

- Exact endpoint paths, query parameters, pagination/cursors, supported filters/sorts, and error envelopes.
- Available semester/reporting periods; canonical member and project IDs; score types, units, and nullable fields.
- Member ranking summary/detail/history and project health summary/detail/history, as implemented by T6.2/T6.3.
- Coverage and evidence references, including which fields each authorized role may see.
- Published timestamp, source/as-of timestamp, run/publication ID, and explicit current/stale/provisional/missing semantics.
- The difference between an empty authorized result, an unpublished period, insufficient evidence, unauthorized access, and service failure.

Draft response types now exist under `src/api/contracts/provisional/` for review. Reconcile them with approved OpenAPI, move approved types out of that folder, and implement runtime parsers before registering real operations. Use `useHorizonReadQuery` or cursor-based `useHorizonInfiniteReadQuery` and map publication freshness explicitly to `QueryState`. Never read database tables or saved Dagster files from React.

## 4. Supabase information (backend/pipeline owners only)

**No Supabase URL, browser key, password, or service-role key is needed by this frontend.** A dashboard invitation is separate from database connectivity and grants no frontend data permission.

To configure the Horizon backend/pipeline, coordinate securely with Yash on:

- Correct Supabase project/environment and database name, with development/staging isolation.
- Approved server-side connection method (direct or pooler), host/port, database role and minimum grants, TLS requirements, and network restrictions.
- How the existing `HORIZON_DATABASE_URL` is delivered through the team's server-side secret management. Do not paste the value into this README, frontend configuration, commits, or chat.
- Ownership of schema migrations and the actual persisted publication tables/views for Tracks 4/5, plus a completed pipeline run with publishable output.
- Read-only API access strategy, row/field policy enforcement, and audit responsibility. If Supabase RLS is involved, agree which role the API uses and where authorization is enforced; frontend permissions do not replace it.

The existing identity, persistence, pipeline, and server contracts have not been changed by T6.1's frontend foundation.

## 5. Final integration and release checks

1. Implement and test Horizon-owned authentication and Track 7 backend authorization.
2. Implement T6.2/T6.3 read endpoints against the approved published outputs.
3. Register typed read operations/parsers, then wire feature hooks into protected feature pages.
4. Enable the source release gate only after backend access tests pass. It is a development guard, not an authorization mechanism.
5. Verify live Authentik login, callback, refresh/expiry, logout, and direct/deep links. Test two users with different permissions and ensure caches do not cross accounts.
6. Verify real empty, loading, error, stale, provisional, and missing-result responses. Ensure 401/403 hide old data immediately.
7. Verify static-host SPA fallback, API routing, TLS/cookie settings, and the deployed Nx build.

Until those steps are complete, T6.1's live sign-in and real-data acceptance criteria remain open.
