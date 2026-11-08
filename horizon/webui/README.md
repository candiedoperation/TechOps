# Horizon web UI — T6.1 foundation

Current design direction follows Yash's `app-dev-horizon-full-redesign-v8-light-filters.html`: top navigation, portfolio dashboard, grouped project browser, and Insights. System/Light/Dark themes and the isolated MSW demo remain supported. See [the November 8 audit](../T6_COMPLETION_AUDIT.md) for current completion status; older refinement notes are historical. Live Authentik, ranking storage and approved authorization/audit integration remain blocked.

Horizon's React application lives inside the existing TechOps Nx workspace. It follows People Portal's per-application npm and explicit `project.json` target conventions. No root package manifest or separate Nx workspace is required.

## Run locally

Use Node **22.12+ on the 22.x line, 24.x, or 26+**, with npm. The verified environment used Node 26.10.0 and npm 11.19.1. The test runner requires these supported Node versions.

From the **TechOps repository root**:

```sh
./nx run horizonui:install-deps
./nx serve horizonui
```

Open <http://127.0.0.1:5174>. This is a separate port from People Portal. No Supabase, credentials, `.env`, or backend service is required. The checked-in npm lockfile is installed with `npm ci`; other targets run that prerequisite automatically. Stop the server before reinstalling dependencies in another terminal.

```sh
./nx build horizonui
./nx run horizonui:typecheck
./nx lint horizonui
./nx test horizonui
./nx run horizonui:format-check
./nx preview horizonui
```

Production output: `horizon/webui/dist/`. Preview: <http://127.0.0.1:4174>. The development and preview servers bind to the loopback address. A production static host must rewrite application paths such as `/rankings` to `index.html` while keeping API requests routed to their backend.

For one verification pass:

```sh
./nx run-many -t build typecheck lint test format-check -p horizonui
```

## What works now

For explicitly local, entirely fictional data, run `./nx run horizonui:serve-demo` and open <http://127.0.0.1:5175>. See [DEMO.md](./DEMO.md) for pages, scenarios, safeguards, and production exclusion checks. This does not enable real sign-in or protected production reads.

- Responsive top navigation, native mobile navigation dialog, shared header/footer, keyboard focus styles, skip link, and reduced-motion support.
- Dashboard, Member Rankings, Project Health, Settings, sign-in information, and not-found routes. Only structural previews are public; protected feature components do not mount without a verified Horizon session.
- System (default), Light, and Dark appearance, live OS changes, local preference persistence, and synchronous first-render theme initialization. Appearance works without authentication or Supabase.
- Reusable cards, typed tables, and accessible loading, empty, error, and stale-data states.
- One app-wide React Query client with caching, retries for transient failures, focus refetching, abort signals, and keys scoped to the signed-in user and feature parameters.
- A runtime-validated, GET-only Horizon read transport. It handles network failures, non-JSON responses, and 401/403 before parsing response bodies.
- An authentication adapter boundary modeled on People Portal's backend-owned OIDC/session pattern. Its current implementation always reports **unavailable**; sign-in cannot succeed.
- Provisional ranking/project-health contracts and hooks, an empty pending-review contract registry, cursor pagination, and backend-driven publication-state rendering. These are draft integration preparation, not deployed API contracts.
- Automated tests use explicitly isolated fixtures. The optional local demo uses deterministic fictional fixtures through MSW, never real records.

## What is intentionally unavailable

Outside the explicit development demo, there are no real member rows, project scores, charts, reporting periods, or fabricated API routes. Placeholder dashes mean **not available**, not zero. Period selectors and Authentik sign-in are disabled. Demo records and reserved paths are excluded from production JavaScript; Authentik remains unavailable even in demo mode.

`src/app/integrations.ts` keeps read access disabled in source. There is no `.env` authentication bypass, local-storage token, People Portal cookie reuse, direct Supabase client, or direct pipeline-output access. Manually invoking a disabled query's `refetch` still cannot cause a protected network request.

The backend currently provides only the greeting at `GET /`. That greeting is not a protected Horizon data API and is not used as a substitute for one. Local tests verify proposed transport behavior against test-only responses; they do not prove that live Horizon APIs or Authentik work.

## How to add a page

Create the page under `src/features/<feature>/` and register it in `src/app/routes.tsx`. A navigation label/icon and `protected: true` can be supplied in that entry; an optional permission string must come from the approved backend policy. The shared layout and sidebar derive their routes from this registry, so no layout changes are needed.

The current ranking and health routes are public structural previews. Their data sections use `ProtectedRoute`; replace previews with registered protected feature pages when the backend contracts are ready. UI permission checks improve navigation only. **The backend must authorize every read and every returned field.**

## Architecture

```text
src/
  app/                 Route registry, integration release gate, error boundary
  auth/                Auth adapter contract, provider, protected-route gate
  api/                 Read client, provider, query client, query hooks
    contracts/         Pending-review registry and explicitly provisional DTOs/hooks
  components/layout/   Shared shell and navigation
  components/ui/       Cards, tables, reusable query states
  features/            Dashboard, rankings, project health, settings, sign-in pages
  theme/               Appearance preference, provider, semantic theme handling
  demo/                Development-only MSW fixtures, contracts, provider, scenario controls
  test/                Shared jsdom setup
```

Provider order is Appearance → Query Client → Auth → Horizon Read Client → Router pages. The read provider receives current auth state and clears cached queries when access is denied. Logout immediately hides protected content and clears the cache, including when the backend logout operation fails. Authentication and result data remain in memory, not browser storage. Only the appearance preference is stored in `localStorage`, under `horizon-ui-theme`.

`ReadOperation<T>` requires a backend-confirmed path and a parser from `unknown` to the expected response type. This prevents TypeScript casts from silently treating malformed JSON as trusted data. `useHorizonReadQuery` and `useHorizonInfiniteReadQuery` supply React Query's cancellation signal. `QueryState` renders result states and suppresses cached results after an access denial. Map API-provided freshness into its `freshness` prop; cache age alone does not establish the freshness of pipeline data. A missing operation or pending contract review never triggers a request.

Design preserves the prototype-inspired blue identity and existing layout while refining panel separation, navigation density, and restrained surfaces using developer-tool principles. No prototype or GitKraken source, data, or branding is copied. Component colors, spacing, and radii are centralized in `src/styles.css`.

See [BACKEND_HANDOFF.md](./BACKEND_HANDOFF.md) for the contracts needed to finish live integration.

See [INTEGRATION_READINESS.md](./INTEGRATION_READINESS.md) for the inspected persistence architecture, exact proposed authentication routes (not implemented), Track 7 decisions, provisional API contracts, and questions for Yash.
