# App Dev Horizon — Implementation Plan

Status: draft for Phase 0 review
Owner: TBD (needs a named executive sponsor before Phase 0 exits)
Companion docs: product strategy (source brief), `README.md` (frontend mock)

This plan translates the product strategy into a buildable system. It assumes
the existing App Dev Club infrastructure: **Authentik** (identity/teams),
**Gitea** (source control), **People Portal** (membership/roles), and
**MongoDB** (primary datastore). The frontend mock in this repo is a
non-connected preview of the target UI and is treated here as Phase 4 work,
not a starting point — per the strategy doc's sequencing decision, boundaries
and data quality come first.

---

## 1. Guiding constraints (carried from the product strategy)

These are non-negotiable and should gate every phase below, not just get
mentioned once:

- No individual-level metrics, ever — not in storage, not in an API response,
  not in a log line accessible to non-admins.
- Every warning must be traceable to raw evidence a project lead can inspect.
- "Insufficient data" is a first-class status, not an error state — the
  system must prefer silence over a false "Clear."
- Planned pauses must suppress risk signals, not just get flagged after the
  fact.
- No automated notifications until the pilot proves warnings are trusted
  (Phase 3 exit condition).

---

## 2. System architecture

```
┌─────────────┐   ┌─────────────┐   ┌───────────────┐
│  Authentik   │   │    Gitea     │   │ People Portal │
│ (teams, IdP) │   │ (repos, PRs) │   │  (staffing)   │
└──────┬───────┘   └──────┬───────┘   └───────┬───────┘
       │ nightly sync      │ polling/webhook   │ deferred (Phase 5+)
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                Ingestion & Boundary Service           │
│  - team hierarchy sync   - repo activity sync         │
│  - identity mapping      - boundary registry CRUD     │
└──────────────────────┬────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│                    MongoDB (source of record)         │
│  projects · boundaries · repo_snapshots · pr_events   │
│  weekly_snapshots · warnings · feedback · audit_log    │
└──────────────────────┬────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│                   Rule Engine (weekly job)             │
│  - baseline calculation  - rule evaluation             │
│  - warning generation    - snapshot versioning         │
└──────────────────────┬────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│                      API layer (REST)                 │
│  - RBAC via Authentik OIDC   - snapshot/project routes │
│  - feedback routes           - audit routes            │
└──────────────────────┬────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────┐
│         Frontend (the mock in this repo, wired up)    │
└─────────────────────────────────────────────────────┘
```

Design principles for this architecture:

- **The rule engine never talks to Gitea/Authentik directly.** It only reads
  from MongoDB's synced collections. This keeps signal computation
  deterministic and replayable against historical data (needed for Phase 2
  and Phase 5).
- **Snapshots are immutable once written.** A weekly snapshot plus the rule
  set version that produced it are the unit of historical truth. Re-running
  rules never mutates a past snapshot — it produces a new one.
- **Boundary changes are versioned, not overwritten.** A project's team/repo
  mapping has effective-date ranges so historical snapshots stay correct
  even after a reorg.

---

## 3. Data model (MongoDB collections)

### `projects`
Canonical project record. Independent of team names.

```
{
  _id, project_id (stable slug), display_name, lifecycle_state
    (new | active | maintenance | paused | archived),
  created_at, archived_at,
  data_owner_user_id,
  non_goals_ack: bool  // confirms leadership reviewed non-goals for this project
}
```

### `boundaries`
Time-sliced ownership record — this is the section 4 "boundary contract."

```
{
  _id, project_id,
  root_authentik_team_id, included_subteam_ids: [...],
  primary_repos: [{ gitea_repo_id, repo_slug }],
  shared_repos: [{ gitea_repo_id, repo_slug, shared_with_project_ids: [...] }],
  excluded_repos: [gitea_repo_id],
  effective_from, effective_to (null = current),
  data_owner_user_id,
  created_by, created_at
}
```
Indexed on `project_id` + `effective_from` for point-in-time lookups.

### `identity_map`
Gitea account → org identity, decoupled from PR/commit ingestion so it can be
corrected without re-ingesting history.

```
{ gitea_username, authentik_user_id, confidence: (confirmed|inferred), mapped_by, mapped_at }
```

### `repo_activity` (raw, append-only)
One document per sync cycle per repo — the least-processed layer, kept so
rules can be recalculated without re-hitting Gitea.

```
{
  repo_slug, synced_at,
  open_prs: [{ pr_id, opened_at, first_review_at, author_identity_ref, is_shared_repo_pr }],
  merged_prs: [...], closed_prs: [...],
  commit_days: [date],  // distinct days with commits, not commit counts
  contributor_identities: [identity_ref]  // de-duplicated via identity_map
}
```

### `weekly_snapshots`
The unit leadership actually reviews. One per project per week.

```
{
  _id, project_id, week_start, week_end,
  rule_set_version, generated_at,
  attention_status: (clear|watch|at_risk|insufficient_data|planned_pause),
  data_completeness_pct,
  metrics: { active_days, days_since_activity, open_prs, oldest_open_pr_days,
             review_latency_days, merged_count, active_contributors, ... },
  baselines: { /* same shape as metrics, trailing-window computed */ },
  warnings: [warning_id]
}
```

### `warnings`
One per triggered rule per snapshot — matches the structured fields from
strategy section 6.

```
{
  _id, snapshot_id, project_id, rule_id, rule_version,
  signal_name, current_value, baseline_value, time_window,
  trigger_threshold, severity, explanation, caveats,
  data_freshness, data_completeness_pct
}
```

### `feedback`
Attached to a snapshot and, where possible, a specific warning — the full
vocabulary from strategy section 7, not just helpful/not-helpful.

```
{
  _id, snapshot_id, warning_id (nullable), project_id,
  author_user_id, category: (helpful | not_useful | false_positive | missed_risk |
    planned_pause | expected_cycle | data_quality | risk_confirmed | risk_resolved),
  note, created_at
}
```

### `audit_log`
Every project-status change, boundary edit, and feedback write. Append-only.

```
{ _id, actor_user_id, action, target_type, target_id, before, after, at }
```

---

## 4. Phase plan

Each phase below maps to the strategy doc's validation roadmap, expanded into
engineering deliverables with exit criteria. Timeline estimates assume one
small backend-focused pod (2–3 engineers) plus part-time product/design.

### Phase 0 — Product alignment (1–2 weeks, no code)

| Deliverable | Owner | Notes |
|---|---|---|
| One-page product charter | Product | Decision the product supports, named sponsor |
| User & decision map | Product | Portfolio leader / project lead / admin, per strategy §2 |
| Written definition of "stalled"/"at risk" | Product + Eng | Becomes the seed for rule hypotheses in Phase 1 |
| Non-goals & privacy principles, signed off | Product + Sponsor | Directly from strategy §1 and §8 |
| Initial success metrics | Product | Seeds strategy §10 |

**Exit condition:** sponsor and stakeholders sign off in writing on what
decision this supports. No engineering work starts before this.

### Phase 1 — Boundary and data discovery (2–4 weeks)

Engineering deliverables:

1. **Authentik sync job** — nightly pull of team hierarchy into a
   `authentik_teams` staging collection (raw, not yet mapped to projects).
2. **Gitea sync job** — nightly pull of repo list + org membership into a
   `gitea_repos` staging collection, including which repos have *no* Gitea
   team/owner set (these become data-quality flags automatically).
3. **Boundary registry CRUD** — internal-only admin tool (can be a CLI or a
   bare-bones authenticated form) to create `projects` + `boundaries`
   documents. This is intentionally not the polished "Project boundaries"
   screen from the mock yet — that's Phase 4.
4. **Identity mapping seed** — script that proposes `identity_map` entries by
   matching Gitea usernames to Authentik/People Portal emails, flags
   ambiguous matches for a human (the data owner) to confirm.
5. **Source-of-truth matrix** — a document (not code) listing, for every data
   point the signal model needs, which system is authoritative and how fresh
   it is.

**Exit condition:** 3–5 representative real projects (spanning active,
paused, and a shared-repo case) are mapped end-to-end and a human can
correctly answer "which repos belong to this project" from the registry
alone.

### Phase 2 — Historical dry run (3–5 weeks)

Engineering deliverables:

1. **Backfill job** — run the Gitea sync against historical PR/commit data
   (as far back as the API reasonably allows) into `repo_activity`.
2. **Rule engine v0** — implement the MVP signal model (strategy §5) as pure
   functions over `repo_activity` + `boundaries`, each returning a
   `{value, baseline, window}` tuple. Keep this stateless and unit-testable —
   no side effects, no DB writes from the calculation functions themselves.
3. **Baseline calculator** — trailing-window (e.g., 8-week) median/percentile
   per project per signal, with a minimum-data-volume guard (strategy §6)
   that returns "insufficient data" instead of a misleading baseline for new
   projects.
4. **Snapshot generator** — batch job that produces `weekly_snapshots` +
   `warnings` for historical weeks, tagged with `rule_set_version`, **without
   any dashboard exposure**. Output reviewed via spreadsheet export or a
   read-only internal notebook, not the product UI.
5. **Rule calibration loop** — iterate thresholds against real history with
   project leads: which warnings would have been useful, which are noise.

**Exit condition:** a small, explicit rule set (aim for 5–8 rules) produces
warnings that project leads and leadership agree were understandable and
mostly correct across at least 3 different project types (steady, bursty,
paused).

### Phase 3 — Controlled pilot (4–6 weeks)

Engineering deliverables:

1. **API layer** — REST endpoints for: `GET /snapshots/latest`,
   `GET /projects/:id/snapshots`, `GET /projects/:id/boundary`,
   `POST /feedback`, `GET /audit`. Auth via Authentik OIDC; role check
   (portfolio leader / project lead / admin) enforced server-side, not just
   hidden in the UI.
2. **Live weekly job scheduling** — the Phase 2 batch pipeline now runs on a
   real weekly cadence (cron or scheduled job), writing current-week
   snapshots automatically.
3. **Wire the existing frontend mock to the real API** — replace the mock
   `projects` array in `app.js` with API calls; keep the same view/render
   structure since it was designed against this exact data shape
   (`metrics`, `boundary`, `evidence` with `current/baseline/window/threshold`,
   `history` already mirror the schema above).
4. **Feedback write path** — the mock's feedback modal already collects the
   full vocabulary from strategy §7; wire `POST /feedback` and confirm it
   writes to `audit_log` as well.
5. **Minimum aggregation thresholds** — enforce server-side (e.g., refuse to
   compute a "concentrated contributor" signal, or refuse to return
   contributor counts at all, below a configured team-size floor) so no
   response can be reverse-engineered into an individual metric.
6. **No outbound notifications** — confirm nothing pages/emails/Slacks
   anyone yet. Access is pull-only during the pilot.

Rollout mechanics:

- Limited group: a handful of portfolio leaders + the project leads whose
  projects were used in Phase 2.
- Weekly review ritual (strategy §9 Phase 3 steps 1–5) run as an actual
  recurring meeting, not just software — the software supports it, doesn't
  replace it yet.

**Exit condition:** pilot users consistently understand warnings without
engineering explaining them, and feedback volume/quality is enough to see
which rules are earning trust.

### Phase 4 — Initial release (3–4 weeks, mostly frontend + hardening)

1. **Finish the remaining mock surfaces for real** — Project boundaries
   (admin CRUD from Phase 1, now with a UI), Signal rules (read-only view of
   active rules/thresholds/versions), Review log (queryable `feedback` +
   `audit_log`).
2. **Data freshness & completeness UI** — surface `data_completeness_pct`
   and last-sync time everywhere a snapshot value is shown (already
   designed into the mock's coverage card and evidence "Window"/"Trigger"
   fields — extend the same pattern to every screen).
3. **Access control hardening** — role-based project visibility (a project
   lead sees only their projects' detail, portfolio leaders see the full
   queue), audit trail for every status/boundary change visible to admins.
4. **Load/perf pass** — confirm weekly job completes well within the review
   window for full project count; snapshot queries are indexed for the
   table/queue views.
5. **Expand access** per strategy §9 Phase 4, gated on all six bullet points
   in that section being true, not just shipped code.

### Phase 5 — ML readiness (not started until Phase 4 is stable for a full quarter)

Do not begin implementation here until:
- Enough consistent weekly snapshots exist (target: 12+ weeks per project
  minimum).
- Enough reviewed feedback labels exist to validate against.

When it starts: define the target precisely ("will this active project
experience a sustained delivery stall within 3 weeks"), use time-based
train/test splits, project-level separation (no leakage across weeks of the
same project into both train and test), and keep every prediction
explainable in the same evidence format already used for rule-based
warnings — this is a hard product requirement, not a nice-to-have, per
strategy §5 and §8.

---

## 5. Rule engine design notes

- Rules are small, pure, independently testable functions:
  `(projectHistory, baselineWindow) => { value, baseline, meetsMinimumData }`.
- A rule only fires if `meetsMinimumData` is true; otherwise it contributes
  to `insufficient_data` status, never to a false "Clear."
- `attention_status` is derived by combining fired rules, not by any single
  rule alone — strategy §6 requires multiple independent signals before
  "At risk."
- Every rule change ships with a version bump (`rule_set_version`) and past
  snapshots are never recomputed in place — only new snapshots use the new
  version. This preserves the "what did leadership see at the time" record
  needed for feedback to remain meaningful.
- Planned-pause and lifecycle-state checks run **before** any risk rule
  evaluates, short-circuiting to `planned_pause`/excluded status.

---

## 6. Security & privacy implementation checklist

- [ ] OIDC integration with Authentik for all API auth (no local password
      auth).
- [ ] Role claims mapped from Authentik groups; enforced server-side per
      endpoint.
- [ ] No endpoint returns per-contributor identifiers below the configured
      aggregation floor.
- [ ] `audit_log` is append-only at the DB layer (no update/delete grants for
      the app's service account on that collection).
- [ ] Contributor-concentration and similar signals are reviewed by
      product/legal for wording before Phase 3 pilot — strategy explicitly
      flags this as a dependency signal, not a performance one, and the UI
      copy must never blur that line.
- [ ] No outbound notification integrations exist in the codebase until
      strategy §9 Phase 3 exit condition is met.

---

## 7. Open questions to resolve before/during Phase 0

1. Who is the named executive sponsor? (blocks Phase 0 exit)
2. What's the authoritative source for staffing/role data, and is it ready?
   If not, staffing signals stay deferred past Phase 4 per strategy §5.
3. Gitea API rate limits / webhook availability — does polling suffice or is
   a webhook receiver needed for Phase 1 sync?
4. Where does the weekly job run (existing infra vs. new service)? Affects
   Phase 3 estimate.
5. Minimum aggregation threshold value (e.g., "don't show contributor count
   signals for teams under N people") — needs a product decision, not just
   an engineering default.

---

## 8. Relationship to this repo

The frontend in this repo (`index.html`, `styles.css`, `app.js`) is a
disconnected product-vision mock. Its data shapes (`metrics`, `boundary`,
`evidence[].{current,baseline,window,threshold}`, `history`) were designed to
mirror the `weekly_snapshots`/`warnings`/`boundaries` schema in this plan
closely enough that Phase 3's "wire the mock to the real API" step should be
closer to a data-source swap than a rebuild. It should **not** be treated as
a Phase 1 or Phase 2 deliverable — per the strategy doc's own sequencing
decision, boundaries and data quality come first.
