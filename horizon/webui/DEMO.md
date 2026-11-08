# Local fictional demo

## Start

From the TechOps root, using the supported Node/npm version in README:

```sh
./nx run horizonui:serve-demo
```

Open <http://127.0.0.1:5175/dashboard>. This target explicitly sets `VITE_HORIZON_DEMO=true` for local development. No credentials, Supabase access, `.env`, or backend server are needed. Stop with Ctrl+C. Normal `./nx serve horizonui` on port 5174 remains a locked structural preview without demo records. The separate port isolates the worker from the normal preview's origin.

Stop development servers before verification or dependency installation: Nx targets install lockfile dependencies first. Restart after verification.

## Pages

- Dashboard: reference-aligned portfolio summary cards, grouped company health, activity/status sections, and fictional snapshot notes.
- Member Rankings: eight fictional members, three semesters, name/coverage filters, cursor pagination, semester selection, and detail links.
- Member detail: three components, coverage/gaps, fictional evidence references, semester selection, and historical scores.
- Projects: five fictional projects grouped into three fictional companies, four weekly snapshots, name/status filters, a selected-project panel, and Overview/Progress/Concerns/History tabs. `/project-health` remains a compatibility path.
- Insights: per-project comparison with company context, Activity/Open PRs/Review Latency controls, search/status filters, and explicit missing values.
- Project detail: component signals, coverage/gaps, fictional evidence references, period selection, and paginated historical component trends.

Fixtures are deterministic and authored here, never copied from real members/projects, Supabase, or pipeline outputs. Units explicitly say “illustrative.” Evidence has no real URLs. These draft DTOs are not an approved scoring model or production contract.

Every route has a **DEMO DATA** banner; member/component views also carry that label. The header still says **Not connected**: there is no demo authentication. Settings and sign-in retain their original behavior. The snapshot selector lists only available fictional reporting periods, not arbitrary dates. Deep historical analysis and verified milestone charts remain deferred.

## Response scenarios

Choose **Response scenario** in the banner. It applies to list/detail/history reads. Period/filter metadata remains available to keep selectors usable.

| Scenario     | Behavior                                                         |
| ------------ | ---------------------------------------------------------------- |
| success      | Normal fictional records                                         |
| empty        | No matching records                                              |
| loading      | Pending for 30 seconds; switch scenarios to cancel               |
| slow         | 1.5-second delay                                                 |
| error        | HTTP 500, shared transient-error retries, then retry UI          |
| unauthorized | HTTP 401, records hidden, session-expired UI; no simulated login |
| forbidden    | HTTP 403, records hidden, access-restricted UI                   |
| stale        | Records with an explicit stale-publication warning               |
| provisional  | Records marked as a non-final assessment                         |
| missing      | No published result; no fabricated zero scores                   |

Switching scenarios cancels pending reads, removes previous Horizon query results, and changes the cache namespace. Records and selections stay in memory. Refresh returns to success. Publication state comes from response metadata, not cache age.

## Isolation

1. Vite permits the bootstrap only for development `serve`, never `build` or `preview`, even with the flag set. The client additionally requires the explicit flag and a loopback hostname.
2. MSW must start before rendering demo pages. Startup failure shows an error, never a live-data fallback.
3. Demo contracts use only local `/__horizon_demo__/` paths and `reviewStatus: 'demo'`, never `approved`.
4. The demo client checks origin/namespace before fetching. Absolute, external, traversal, and live API paths are rejected. Requests omit credentials, reject redirects, and require `x-horizon-demo: fictional` before parsing.
5. MSW blocks unregistered programmatic requests, including remote APIs; only same-origin browser assets may pass through. No fallback live client or Supabase connection exists.
6. AuthProvider, the unavailable Authentik adapter, ProtectedRoute, production release gates, and session checks remain unchanged. Demo routes are fictional presentation routes, not authenticated sessions or protected-route exceptions.
7. A development-only middleware serves the worker; no worker is copied into `public/`. Production removes the dynamic demo runtime and fixtures. The worker stops when leaving the document or disposing the module.

The existing React Query hooks and shared read transport handle demo reads. `features/reads/ReadPages.tsx` imports no demo fixtures. Live integration can reuse these pages with a reviewed registry, the normal session-backed provider, and protected route registration. Do not redirect demo builders to production or mark provisional contracts approved without backend review.

## Verify

Stop the development server first. From the TechOps root:

```sh
./nx run-many -t build typecheck lint test format-check -p horizonui
VITE_HORIZON_DEMO=true ./nx run horizonui:verify-production
```

The second command deliberately sets the flag while building production and scans emitted artifacts for the demo runtime, fixtures, paths, and worker. Tests cover isolation gates, no-fetch rejection, credential omission, unmarked responses, MSW fail-closed behavior, parsed DTOs, pagination/filter/detail/history, scenario rendering, loading cancellation, unchanged sign-in, and protected routes remaining locked.

## Production blockers

- Horizon-owned Authentik provider configuration and backend session/login/logout contracts, callbacks/return URLs, secure-cookie/CSRF policy, and identity-to-member mapping.
- Approved Horizon read paths and response schemas for periods, filters, list/detail/history, pagination, score units/components, evidence visibility, freshness/completeness, and errors.
- Track 7 backend authorization rules and tests for every returned entity/field, including evidence. Frontend permission checks are not authorization enforcement.
- Backend-owned access to the right Supabase/Postgres environment, confirmed migrations/views/publication tables, and test publications. Coordinate role/connection/SSL/credentials privately with backend owners. **Never put database credentials, Supabase service-role keys, or direct browser database access in this frontend.** No Supabase information is needed for this demo.

See BACKEND_HANDOFF.md and INTEGRATION_READINESS.md for prior repository findings and contract questions. Demo verification does not verify live Authentik, live read APIs, Supabase, or Track 7 enforcement.
