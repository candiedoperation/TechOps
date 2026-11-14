# T6.1 frontend foundation and refinement verification

Historical November 1 verification is retained below. See `../T6_COMPLETION_AUDIT.md` and `../server/README.md` for the November 8 design/audit/backend increment; the current shell uses Yash's top-navigation portfolio reference instead of the earlier sidebar direction.

Verified locally on November 1, 2026, on `feat/horizon-frontend`.

## Automated checks

```sh
./nx run-many -t build typecheck lint test format-check -p horizonui --output-style=static
```

- Nx recognizes `horizonui` as an application rooted at `horizon/webui`.
- Production Vite 7 build passes.
- TypeScript project checks pass, including tests and configuration files.
- ESLint passes with zero warnings.
- All 103 frontend tests pass across ten files, including the isolated fictional demo suite.
- Prettier formatting checks pass.

Tests cover navigation/direct links, disabled sign-in, mobile drawer route selection, protected children never mounting without verification, permissions, logout/cache cleanup even on failure, rejected external return targets, read-only same-origin requests, response validation, network/HTTP errors, 401/403 handling, React Query caching/refetch, a closed production read gate, and loading/empty/error/stale states. No real identities or records are used.

The development-only MSW suite also verifies explicit/loopback/build gating, rejection of production paths before fetch, omitted credentials, rejected unmarked responses, blocked unregistered API requests, deterministic semester/period fixtures, filtering/pagination/details/history, scenario cache isolation, loading cancellation, server-error retries, and unchanged sign-in/protected-route behavior.

Production exclusion is checked separately with the demo flag deliberately enabled:

```sh
VITE_HORIZON_DEMO=true ./nx run horizonui:verify-production --output-style=static
```

This rebuilds production and asserts emitted artifacts contain no demo runtime markers, fictional records, reserved read namespace, or MSW worker. See DEMO.md for the startup and isolation design.

Refinement coverage adds System/Light/Dark selection, preference restoration, live OS media-query events, cross-tab changes, blocked/corrupt storage recovery, listener cleanup, pre-render theme initialization, text/focus token contrast, expired/forbidden session states, backend current/stale/provisional/missing metadata, cursor-based pagination, filter-separated caches, pending-contract blocking, and aborting an in-flight read on unmount. The text-token checks assert at least 4.5:1 contrast for the tested foreground/surface pairs and 3:1 for focus/surface pairs; these checks are not a full accessibility audit.

The existing Horizon pipeline regression suite was also run without changing its code:

```sh
PATH="/opt/homebrew/Caskroom/miniconda/base/bin:$PATH" ./nx test horizon-dag --output-style=static
```

All **24 existing tests pass**. The PATH prefix selects this machine's installed Python 3.14 runtime; the default `/usr/bin/python3` is 3.9, below Horizon's Python 3.11 minimum. On another machine, select its supported Python runtime rather than copying that machine-specific path. The existing Nx target creates an ignored `horizon/.venv` for its test dependencies.

## Browser checks

- `./nx run horizonui:serve-demo` starts the explicit demo at <http://127.0.0.1:5175>; MSW intercepts fictional reads before the app mounts.
- Demo dashboard tables, ranking semester selection, pagination, name filtering, member component/evidence/history details, project signal/history details, stale warnings, and 401 suppression were verified in the browser.
- The DEMO DATA banner is present, the header remains Not connected, and Authentik remains disabled in demo mode.
- Demo mobile navigation and rankings were checked at 390 × 844; document width remained 390px with no page-wide overflow. Desktop and mobile screenshots were saved outside the repository.

- `./nx serve horizonui` starts the application at <http://127.0.0.1:5174>.
- Dashboard → Member Rankings → Project Health navigation works with the same sidebar/header.
- Feature direct links render their locked state and disabled period selector.
- The sign-in information page renders a disabled Authentik button and states that People Portal sessions are not used.
- The phone layout was inspected at 390 × 844. Its modal navigation opens, routes correctly, and closes after selection.
- The phone rankings view has no page-wide horizontal overflow; tables scroll inside their own region.
- Light and Dark selections were verified in the running browser and restored after full refresh. System resolved to the device's dark appearance. OS change events were tested with a simulated media query; the actual operating-system preference was not changed during verification.
- The refined Dark phone dashboard and Light phone settings were inspected at 390 × 844, including navigation to Settings through the mobile drawer. No page-wide horizontal overflow was observed in those views.
- Settings are available without sign-in or database connectivity; the appearance selector and preview buttons remain usable while auth/read gates are closed.

## Dependencies

The dependency lockfile resolves React 19, React Router 7, TanStack React Query 5, Vite 7, and Tailwind 4. The test runner was updated to Vitest 5.0.5 to remove critical advisories from the older Vitest/tinypool chain.

`npm audit --omit=dev` reports **zero vulnerabilities**. Full `npm audit` reports **12 moderate development-tooling findings** through ESLint/minimatch and related packages. These do not ship in the frontend production bundle. They remain a tooling maintenance item; no forced dependency downgrade/override or unrelated application change was applied.

The standalone Nx installation also reported existing-toolchain dependency advisories during its initial install. Its pinned workspace versions were preserved.

## Not verified / still blocked

- Live Authentik login, callback, session refresh/expiry, provider logout, and cross-account behavior.
- Actual backend 401/403 responses, field-level authorization, and access audit behavior.
- Real Horizon read-API paths, response schemas, member/project records, publication timestamps, and freshness states.
- Deployed SPA/API routing and production cookie/TLS settings.
- Supabase-backed API/pipeline connectivity or published Tracks 4/5 outputs.

All of the above require backend contracts and environments described in `BACKEND_HANDOFF.md`. Tests against local fixture responses are not a claim of live integration success.

`INTEGRATION_READINESS.md` contains the exact proposed auth route names, inspected PostgreSQL schema findings, unresolved Track 7 access decisions, draft DTO/hook status, and questions for the backend owners. None of those route proposals are implemented or enabled by this frontend work.

## Scope

All source changes are new files under `horizon/webui/`. Existing Horizon identity, pipeline, persistence, server, other TechOps applications, and root workspace configuration were preserved. No commit, push, merge, or pull request was performed.

## Suggested review metadata

Suggested commit message for this increment: `feat(horizon): add isolated development-only MSW demo`

Suggested PR title: `T6.1: Horizon frontend foundation, appearance, and isolated fictional demo`

Suggested PR description:

> Add and refine Horizon's React 19/TypeScript/Vite 7 application inside the existing Nx workspace with Tailwind 4, React Router 7, and React Query 5. Provide a compact responsive shell, System/Light/Dark appearance with first-render initialization, Settings, reusable states, explicit session expiry/denial handling, and draft ranking/project-health contracts with cursor-ready hooks. Authentication and protected reads remain unavailable until Horizon-owned backend sessions, approved read contracts, and Track 7 authorization exist. No Supabase or People Portal session access is introduced.
>
> Add an explicit loopback-only MSW demo with fictional rankings, project health, details/history, pagination/filters, and failure/publication scenarios. The demo uses shared query/transport paths without authenticating or unlocking protected routes, and is excluded from production even if its flag is set.
>
> Validation: production build, type-check, lint, formatting, 103 frontend tests, production artifact exclusion, and desktop/phone demo browser checks pass. The prior foundation/refinement pass also verified 24 existing pipeline tests. Live authentication and data acceptance criteria remain pending; see DEMO.md, INTEGRATION_READINESS.md, BACKEND_HANDOFF.md, and VERIFICATION.md. Production dependency audit is clean; 12 moderate development-tooling findings remain.
