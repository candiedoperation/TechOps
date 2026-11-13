# Horizon: git blame → Postgres, as a Dagster asset graph

## Context

`horizon/` on this branch is a deliberate reset — `backend/config.py`, `backend/errors.py`, a
28-line `main.py` serving `/health`, two tests. The full legacy app lives on
`add-horizon-to-monorepo`.

The target is the pipeline half: pull from Gitea and People Portal into Postgres, one feature
at a time. The first source is **git blame**, orchestrated with **Dagster**, built as a
sequence of small PRs — **never more than two Dagster assets per PR**, each reviewable by
someone who has not read the others.

> No notes exist from the earlier design conversation (no memory files for this project), so
> parts of this may re-derive decisions already made. Flag anything that contradicts them.

### Why blame first

Blame needs only a repo's `ssh_url` and `default_branch`. No commit list, no branch list, no
per-sha enrichment. Local git does the work: `O(1)` server calls per repo against
`O(commits + 2 × pulls)` for the commits path — ~25 round-trips versus ~1,750 for your 12 repos.

### Prior art, and what to avoid

`dagster_pilot/pilot.py` on the legacy branch declares 13 assets in one 155-line file against
entirely synthetic data, and `deterministic_features` is one unreadable 30-line statement
computing every feature at once. It is the shape this plan is explicitly not.

### Verified against the live environment

- SSH read access to Gitea works — `git ls-remote --heads git@git.appdevclub.com:…` returns heads.
- Postgres 16 running: container `appdev-gitea-analytics-postgres-1`, `127.0.0.1:5433`.
- git 2.54.0 and SSH keys present.
- `gitea_analytics` holds one legacy run: 145,311 blame lines / 64 members — a baseline.
- `data/amazon-leo-git-blame.txt` is a 14MB raw blame capture of a real org: 36,653 lines,
  11 author names, 13 identity pairs, 195 surviving commits, 254 files, 8,728 `previous`,
  1,131 `boundary`, 65 author≠committer. **It doubles as a test fixture and an end-to-end
  expected-output baseline.**

### The legacy bug this design prevents

`blame_repo` (`scripts/member_analytics.py:1452`) reimplemented blame in Python over the Gitea
`.diff` endpoint. It recorded `blame_lines: 0` for all 132 members — zero, not null — with no
warnings, and reported `blame_status: complete`. The call budget proves the diffs were never
fetched: 998 default-branch commits needed ≥998 `.diff` calls; the run recorded 815 total. It
returned `complete=True` because nothing threw.

Three structural consequences:
1. **Parsing is its own layer, pure and separately tested.** No network, no subprocess.
2. **Zero rows is a failure.** Enforced as Dagster asset checks, not convention.
3. **Every git blame field is stored.** Legacy parsed 2 of the 14 fields git emits and threw
   the rest away; recovering them later means re-cloning every repo.

## Working agreement — read this first

**Never commit, push, or open a PR.** The user does that themselves, at every checkpoint.
An agent's job ends at "the work for checkpoint N is on disk, tests pass, here is what
changed." Leave the working tree dirty and stop; do not `git add`, `git commit`, `git push`,
or `gh pr create`.

**One checkpoint at a time.** A checkpoint is one row of the PR ladder below — at most two
Dagster assets. Finish it, run `./nx run data_pipeline:check`, report, and stop. Do not start
the next checkpoint without being asked.

**Every checkpoint must stand alone.** Someone who has read none of the other PRs should be
able to review it. That is the reason for the two-asset cap, not a style preference.

## Handoff state

_Last updated: 2026-09-18. Update this section at the end of every checkpoint._

- **Branch:** `feat/horizon-blame-extract`, stacked on `feat/horizon-pipeline-scaffolding`
  because PR 2 edits files that exist only there. Open PR 2 with that branch as its **base**,
  not `master`, and retarget it to `master` once PR 1 merges.
- **PR 1 — scaffolding (0 assets): in review as #78**, approved with comments, all four
  addressed. `horizon/pipeline/` holds `config.py` (`PipelineSettings`), `resources.py` and
  `definitions.py`; the Nx project is `data_pipeline` and its env prefix is `HORIZON_`
  (`PHI_` kept as an alias because `horizon/.env` still uses it).
- **PR 2 — extract (`gitea_repository`, `blame_capture`): on disk, unreviewed, uncommitted.**
  `resources.py` now implements `GiteaClient.get_repository` (httpx, one call per repo) and
  `GitWorkspace` (clone lifecycle, `list_tracked_files`, `blame_file`); new
  `pipeline/assets/{source,capture}.py`, `pipeline/checks.py` (`capture_is_non_empty`).
  Tests: `test_resources_gitea.py`, `test_resources_workspace.py`, `test_assets_source.py`,
  `test_assets_capture.py`, `test_checks.py` — 50 passing, `data_pipeline:check` green.
- **Capture format is a contract with PR 3.** `blame_capture` writes the same preamble and
  `===== git blame <flags> -- <org>/<repo>:<path> =====` section header as
  `data/amazon-leo-git-blame.txt`, differing only in the flags recorded (`-M -C` are new).
  PR 3's parser must read both, so its header regex has to tolerate the flag list.
- **Dagster and PEP 563 do not mix.** `from __future__ import annotations` in a module holding
  an `@asset` or `@asset_check` makes Dagster reject the `context` annotation it asked for.
  The three affected modules opt out and say so in a comment; do not add it back.
- **Next checkpoint:** PR 3 — parse (1 asset: `blame_records`). `pipeline/blame_parser.py`,
  pure `str -> list[BlameRecord]`, all 14 fields, validated against the 14MB capture's known
  counts.
- **Identity key changed on 2026-09-17:** the canonical person identifier is the **Authentik
  user PK**, not `canonical_email`. This added `authentik_users` as a source asset and an
  `AuthentikClient` resource, split the old PR 12 into PR 12 (evidence) and PR 13 (resolution),
  and pushed the mart to PR 14 and partitioning to PR 15 — 18 assets across 15 PRs. PR 1 as
  shipped is unaffected: it declares no identity columns. `PipelineSettings` will need
  `authentik_url` and `authentik_api_token` added before PR 12.
- **Legacy source of truth:** branch `add-horizon-to-monorepo`. Read it with
  `git show add-horizon-to-monorepo:horizon/<path>`; do not merge it.
- **Environment facts already verified** (no need to re-check):
  - SSH read access to Gitea works from this machine.
  - Postgres 16 runs in Docker as `appdev-gitea-analytics-postgres-1` on `127.0.0.1:5433`,
    database and user both `gitea_analytics`.
  - `horizon/.env` has `PHI_GITEA_URL` and `PHI_GITEA_API_TOKEN` but **no database URL** —
    `HORIZON_DATABASE_URL` must be added before any live run.
  - git 2.54.0, SSH keys present.
  - Python is **3.14.7**; dagster 1.13.23 and dagster-webserver install and run on it.
  - The workspace has no root `package.json` — Nx is the `./nx` wrapper script, so the
    command is `./nx run data_pipeline:check`, not `pnpm nx …`.
  - **Nx `run-commands` loads `horizon/.env` into every task's environment.** Setting
    `HORIZON_ENV_FILE=''` does not stop it, because pydantic reads real environment variables
    regardless of dotenv settings. `tests/conftest.py` therefore scrubs the settings
    variables out of `os.environ` before any config module is imported. Without that, a test
    asserting an unset default passes or fails depending on whose machine it runs on.
- **Test fixture already on disk:** `horizon/data/amazon-leo-git-blame.txt`, a 14MB real
  capture. Its known counts are the parser's acceptance criteria (see Verification).
  Note `horizon/data/` is gitignored, so it is local-only — do not assume CI has it.

## Coverage matrix

### Every git blame field reaches a column

| git blame field | Stored as |
|---|---|
| header sha | `blame_commits.commit_sha`, `blame_attribution.commit_sha` |
| header line count | `blame_attribution.lines` |
| `author` | `blame_commits.author_name` |
| `author-mail` | `blame_commits.author_email` |
| `author-time` | `blame_commits.author_time` |
| `author-tz` | `blame_commits.author_tz` |
| `committer` | `blame_commits.committer_name` |
| `committer-mail` | `blame_commits.committer_email` |
| `committer-time` | `blame_commits.committer_time` |
| `summary` | `blame_commits.summary` |
| `filename` | `blame_attribution.source_path` |
| `previous` | `blame_attribution.moved_from` |
| `boundary` | `blame_commits.is_boundary` |
| blamed path | `blame_attribution.path` |

### Every derived attribute reaches an asset

| Family | Attribute | Asset | Column | PR |
|---|---|---|---|---|
| Identity | author name / email | all feature tables | `author_name`, `author_email` | 4 |
| | directory roster | `authentik_users` | `authentik_user_pk`, `username`, `email` | 12 |
| | alias evidence | `identity_candidates` | `tier`, `evidence`, `confidence` | 12 |
| | canonical identity | `identity_clusters` | `authentik_user_pk` | 13 |
| | identities per person | `identity_clusters` | `distinct_identities` | 13 |
| | how the match was made | `identity_clusters` | `match_method` | 13 |
| | git identity with no user | `identity_clusters` | `match_method = 'unmatched'` | 13 |
| Ownership | surviving lines | `member_ownership` | `surviving_lines` | 5 |
| | files owned | `member_ownership` | `files_owned` | 5 |
| | repositories | `member_ownership` | `repositories` | 5 |
| | share per **file** | `file_ownership` | `share` | 5 |
| | files majority-owned | `member_ownership` | `files_majority_owned` | 5 |
| | share per **repo** | `member_repo_ownership` | `share_of_repo` | 6 |
| | rank within repo | `member_repo_ownership` | `rank_in_repo` | 6 |
| | bus factor | `repo_concentration` | `bus_factor_50` | 7 |
| | concentration | `repo_concentration` | `hhi`, `top_author_share` | 7 |
| File mix | extension → class | `path_classification` | `path_class` | 8 |
| | lines by class | `member_file_mix` | `code_lines`, `docs_lines`, … | 8 |
| Time | first / last line | `member_activity` | `first_line_at`, `last_line_at` | 9 |
| | active days / weeks | `member_activity` | `active_days`, `active_weeks` | 9 |
| | median code age | `member_activity` | `median_commit_age_days` | 9 |
| | mean line age | `member_activity` | `mean_line_age_days` | 9 |
| | working timezone | `member_activity` | `usual_timezone` | 9 |
| Commits | surviving commits | `member_durability` | `surviving_commits` | 10 |
| | lines per commit | `member_durability` | `lines_per_surviving_commit` | 10 |
| | largest surviving commit | `member_durability` | `largest_surviving_commit_lines` | 10 |
| | what survived | `member_durability` | `top_summaries` | 10 |
| Process | author ≠ committer | `member_process_signals` | `rebased_commits`, `rebased_lines` | 11 |
| | authored→applied lag | `member_process_signals` | `median_apply_lag_days` | 11 |
| | moved / renamed lines | `member_process_signals` | `moved_lines`, `moved_files` | 11 |
| | initial-import lines | `member_process_signals` | `boundary_lines`, `boundary_commits` | 11 |
| | de-scaffolded ownership | `member_process_signals` | `non_boundary_lines` | 11 |

## Architecture

Six layers. Each layer has one job; no asset spans two.

```
 RESOURCES (shared, never assets)   GiteaClient · AuthentikClient · GitWorkspace · PostgresResource

 L1 source          L2 capture           L3 parse
 ┌───────────────┐  ┌────────────────┐   ┌────────────────┐
 │gitea_         │  │blame_capture   │   │blame_records   │
 │  repository   │─▶│ clone + blame  │──▶│ text → records │
 │ 1 API call    │  │ raw text→disk  │   │ PURE, no I/O   │
 └───────────────┘  └────────────────┘   └───────┬────────┘
      PR 2               PR 2                 PR 3
                                                 │
 L4 load  ┌──────────────────────────────────────┘
 ┌────────▼───────┐   ┌────────────────┐
 │blame_commits   │──▶│blame_          │         PR 4
 │  _table        │   │ attribution    │
 └────────┬───────┘   └───────┬────────┘
          └───────┬───────────┘
                  │
 L5 features      ▼    one family per PR — narrow, independently re-materializable
 ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
 │file_     │ │member_   │ │repo_     │ │path_     │ │member_   │ │member_   │
 │ownership │ │repo_     │ │concentr'n│ │class'n   │ │activity  │ │durability│
 │member_   │ │ownership │ │          │ │member_   │ │          │ │          │
 │ownership │ │          │ │          │ │file_mix  │ │          │ │          │
 └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
   PR 5         PR 6         PR 7         PR 8         PR 9        PR 10
      │              │            │            │            │           │
      │  ┌──────────┐│ ┌──────────┐           │            │           │
      │  │member_   ││ │authentik_│           │            │           │
      │  │process   ││ │users     │ PR 12–13  │            │           │
      │  │_signals  ││ │identity_ │           │            │           │
      │  │  PR 11   ││ │cand+clus │           │            │           │
      │  └────┬─────┘│ └────┬─────┘           │            │           │
      └───────┴──────┴──────┼─────────────────┴────────────┴───────────┘
 L6 mart                    ▼
                     ┌─────────────┐
                     │member_      │  PR 14   joins every feature
                     │  profile    │          through identity_clusters
                     └─────────────┘
```

**Why the cuts fall here.** L2 is the only asset touching network or filesystem, so it is the
only one that can be slow or flaky. L3 is pure, so it is exhaustively testable against fixture
text — the legacy failure mode. L4 is the only one writing the core tables. L5 assets are
narrow and independent: a broken timezone calculation cannot block ownership numbers, and each
re-materializes alone.

**Every feature asset is keyed on raw `(author_name, author_email)`.** Identity resolution
produces a *mapping* (`identity_clusters`) from that raw pair to an **Authentik user PK**, and
only the L6 mart joins through it. So identity can land at any point without re-keying a single
feature table, and a re-run of the directory changes no feature row.

**The canonical identifier is the Authentik user PK, not an email address.** An email is a
mutable attribute — people change addresses, and one person commits under several — so keying a
person on one of their emails silently splits or merges them the moment the directory changes.
Blame cannot supply a PK: git records only the name and email the author configured. The PK
therefore comes from the directory, which is why the roster is pulled as its own source asset.
Git identities that match no directory user are kept with a null PK rather than dropped.

**Resources, not assets:** a clone is an ephemeral working directory, not a data artifact.
`GitWorkspace` owns clone/cleanup so no asset has a tempdir in its return type.

## PR ladder

18 assets, 15 PRs, never more than two assets at once.

### Phase A — spine: blame into Postgres

**PR 1 — scaffolding (0 assets).** `dagster` in a new `orchestration` extra;
`pipeline/definitions.py` exposing an empty `Definitions`; resource stubs; `data_pipeline:serve`
Nx target running `dagster dev`. Confirms the UI boots and CI passes with an empty graph.

**PR 2 — extract (2: `gitea_repository`, `blame_capture`).** Plus `GiteaClient` (httpx) and
`GitWorkspace` resources. Blame runs `git blame --line-porcelain -w -M -C`; `-M`/`-C` follow
moves and copies so refactors do not silently reassign ownership. Raw text persisted so later
layers re-run without re-cloning. No Postgres.

**PR 3 — parse (1: `blame_records`).** `pipeline/blame_parser.py`, pure
`str → list[BlameRecord]`, emitting **all 14 fields**. Alone in its own PR because it is the
piece legacy got wrong.

**PR 4 — load (2: `blame_commits_table`, `blame_attribution_table`).** `schema.sql`, the
psycopg writer, reconciliation and FK checks.

### Phase B — features: one family per PR

**PR 5 — ownership (2: `file_ownership`, `member_ownership`).**
```
file_ownership    (run_id, org, repo, path, author_name, author_email, lines, share)
member_ownership  (run_id, author_name, author_email, surviving_lines,
                   files_owned, repositories, files_majority_owned, mean_file_share)
```
`share` is a window over each file's total. `files_majority_owned` counts files where
`share > 0.5` — immune to one person dumping a vendored directory.

**PR 6 — per-repo ownership (1: `member_repo_ownership`).**
```
member_repo_ownership (run_id, org, repo, author_name, author_email, lines,
                       share_of_repo, files_owned_in_repo,
                       files_majority_owned_in_repo, rank_in_repo)
```
The per-**repo** share, distinct from PR 5's per-**file** share. This is what answers "who owns
this project", and it is the input `repo_concentration` aggregates.

**PR 7 — concentration (1: `repo_concentration`).**
```
repo_concentration (run_id, org, repo, total_lines, distinct_authors,
                    top_author_email, top_author_share, hhi, bus_factor_50)
```
`bus_factor_50` is the smallest number of authors whose combined share reaches 50%. `hhi` is
the Herfindahl index (sum of squared shares). The "what happens if one person leaves" asset.

**PR 8 — file mix (2: `path_classification`, `member_file_mix`).**
```
path_classification (run_id, org, repo, path, extension, path_class)
                     path_class ∈ code|docs|config|lockfile|data|generated|other
member_file_mix     (run_id, author_name, author_email,
                     code_lines, docs_lines, config_lines, lockfile_lines,
                     data_lines, generated_lines, other_lines)
```
Classification is a **stored table, applied after collection** — not a collection-time
allowlist. Legacy's `SOURCE_EXTENSIONS` / `SKIP_BLAME_NAMES` (`:46`, `:53`) baked the judgment
into the data and could never be revised without re-cloning. Here the rules can change and the
table re-materializes in seconds.

**PR 9 — activity window (1: `member_activity`).**
```
member_activity (run_id, author_name, author_email, first_line_at, last_line_at,
                 active_days, active_weeks, median_commit_age_days,
                 mean_line_age_days, usual_timezone)
```
Ages measured from the run's `started_at`. **Caveat for the PR body:** a true line-weighted
median needs an expensive lateral expansion, so this ships `median_commit_age_days`
(unweighted, over commits) alongside `mean_line_age_days` (line-weighted). Both are honest;
neither is a weighted median.

**PR 10 — durability (1: `member_durability`).**
```
member_durability (run_id, author_name, author_email, surviving_commits,
                   lines_per_surviving_commit, largest_surviving_commit_lines,
                   top_summaries)
```
**Caveat for the PR body:** true durability is surviving lines ÷ lines originally written, and
blame cannot supply the denominator — that needs the commits API. This ships surviving lines
*per surviving commit*, a proxy. Naming it `durability` without that note would overclaim.

**PR 11 — process signals (1: `member_process_signals`).**
```
member_process_signals (run_id, author_name, author_email,
                        rebased_commits, rebased_lines, median_apply_lag_days,
                        moved_lines, moved_files,
                        boundary_commits, boundary_lines, non_boundary_lines)
```
`non_boundary_lines` is the de-scaffolded ownership number and is arguably the headline metric
— initial-import lines are where bulk vendored and generated content lands (1,131 in the
Amazon Leo capture). `rebased_*` comes from author≠committer (65 lines there): a rebase, an
applied patch, or pair-programming attribution. `median_apply_lag_days` is
`committer_time − author_time`, the only use of `committer_time` and a direct measure of how
long work waited before it was applied.

**PR 12 — identity evidence (2: `authentik_users`, `identity_candidates`).**
```
authentik_users     (run_id, authentik_user_pk, username, email, name, is_active)
identity_candidates (run_id, left_email, right_email, tier, evidence, confidence)
```
The roster is a **source asset**, alongside `gitea_repository` at L1, and `AuthentikClient`
joins the resource set. It exists because blame cannot supply a user PK — git records only the
name and email the author configured — so the PK has to come from the directory. Ids are
normalised with `str(pk)` to match the existing `_authentik_id` helper, so the column is `TEXT`
and survives Authentik changing its id type. If the deployment fronts Authentik with People
Portal, that is the same asset pointed at a different directory; the column does not change.

Blame supplies alias evidence for free: 11 author names produced 13 (name, email) pairs, with
`Michael McCarroll` under 3 emails. Reuse legacy's tiered model from
`scripts/propose_identity_aliases.py:50` — `exact_name_and_shared_org`, `exact_name_only`,
`token_and_shared_org` — and its token helpers (`identity_alias_keys:94`), which already
exclude shared email domains because a university domain identifies a population, not a person.

**PR 13 — identity resolution (1: `identity_clusters`).**
```
identity_clusters (run_id, author_name, author_email, authentik_user_pk,
                   distinct_identities, match_method, confidence, reviewed)
   match_method ∈ directory_email | directory_alias | exact_name | manual | unmatched
```
The one table that answers "which person is this". `authentik_user_pk` is **nullable**: a git
identity that matches no directory user gets a row with `match_method = 'unmatched'` rather
than being dropped, because outside contributors, bots and stale addresses are all real and
silently losing them is how a pipeline starts lying about coverage.

**Only a directory-email match auto-resolves.** Everything weaker lands with `reviewed = false`
for a human, exactly as `identity_candidates` does. This is the discipline legacy lost when
`resolve_member` silently stored `RibaDiba <abrmod74@gmail.com>` as a login — an email masquerading
as an identifier is the precise failure this column change exists to prevent.

### Phase C — mart and scale

**PR 14 — mart (1: `member_profile`).** One wide row per member per run, keyed on
`authentik_user_pk` and joining every L5 table through `identity_clusters`, so consumers do not
write eight-way joins. Raw identity stays visible alongside the canonical one. Unmatched git
identities are still reported, grouped under a null PK, so the numbers reconcile to the totals
in `blame_attribution` rather than quietly shrinking to the roster.

**PR 15 — partitioning (0 new assets).** Convert to `DynamicPartitionsDefinition` keyed on
`org/repo`, so blaming a whole org is a partition backfill rather than a new code path.
Deliberately last: partitioning is a concept change, and mixing it with new assets makes both
harder to review.

## Asset checks

| Check | On | Fails when |
|---|---|---|
| `capture_is_non_empty` | `blame_capture` | zero bytes captured — the legacy silent-zero case |
| `records_carry_every_field` | `blame_records` | any of the 14 git blame fields is never populated |
| `records_parse_completely` | `blame_records` | any captured file yields zero records |
| `attribution_lines_reconcile` | `blame_attribution_table` | `SUM(lines)` ≠ parsed total |
| `every_attribution_has_a_commit` | `blame_attribution_table` | FK orphans |
| `file_shares_sum_to_one` | `file_ownership` | any file's shares miss 1.0 by > 1e-6 |
| `repo_shares_sum_to_one` | `member_repo_ownership` | any repo's shares miss 1.0 by > 1e-6 |
| `bus_factor_is_bounded` | `repo_concentration` | `bus_factor_50` < 1 or > `distinct_authors` |
| `every_path_is_classified` | `path_classification` | any blamed path has no class |
| `file_mix_totals_match` | `member_file_mix` | class lines ≠ `member_ownership.surviving_lines` |
| `activity_within_run_window` | `member_activity` | `last_line_at` > run `started_at` |
| `boundary_lines_are_a_subset` | `member_process_signals` | `boundary_lines` > `surviving_lines` |
| `roster_is_non_empty` | `authentik_users` | the directory returned zero users |
| `clusters_are_total` | `identity_clusters` | any raw identity has no row — an `unmatched` row is fine, a missing one is not |
| `pk_resolves_to_a_known_user` | `identity_clusters` | a non-null `authentik_user_pk` is absent from `authentik_users` |
| `one_pk_per_raw_identity` | `identity_clusters` | a raw identity maps to more than one PK in a run |
| `profile_covers_all_members` | `member_profile` | row count ≠ distinct `authentik_user_pk`, plus one row per unmatched identity |

## Core schema (PR 4)

```sql
CREATE SCHEMA IF NOT EXISTS horizon;

CREATE TABLE IF NOT EXISTS horizon.runs (
    run_id      TEXT PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    gitea_url   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'running',   -- running|complete|partial|failed
    warnings    JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE TABLE IF NOT EXISTS horizon.repositories (
    run_id         TEXT NOT NULL REFERENCES horizon.runs(run_id) ON DELETE CASCADE,
    organization   TEXT NOT NULL,
    repository     TEXT NOT NULL,
    default_branch TEXT,
    ssh_url        TEXT,
    html_url       TEXT,
    head_sha       TEXT,
    blamed_files   INTEGER NOT NULL DEFAULT 0,
    skipped_files  INTEGER NOT NULL DEFAULT 0,
    blame_status   TEXT NOT NULL DEFAULT 'pending', -- pending|complete|partial|failed|skipped
    PRIMARY KEY (run_id, organization, repository)
);

-- One row per commit with surviving lines; per-commit blame fields live here
-- rather than repeating on every attribution row.
CREATE TABLE IF NOT EXISTS horizon.blame_commits (
    run_id          TEXT NOT NULL,
    organization    TEXT NOT NULL,
    repository      TEXT NOT NULL,
    commit_sha      TEXT NOT NULL,
    author_name     TEXT NOT NULL,
    author_email    TEXT NOT NULL,
    author_time     TIMESTAMPTZ,
    author_tz       TEXT,
    committer_name  TEXT,
    committer_email TEXT,
    committer_time  TIMESTAMPTZ,
    summary         TEXT,
    is_boundary     BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (run_id, organization, repository, commit_sha),
    FOREIGN KEY (run_id, organization, repository)
        REFERENCES horizon.repositories(run_id, organization, repository) ON DELETE CASCADE
);

-- Surviving line counts per file per commit. source_path is blame's `filename`,
-- which differs from path under -M/-C when the line originated elsewhere, so it
-- belongs in the key. moved_from is blame's `previous`.
CREATE TABLE IF NOT EXISTS horizon.blame_attribution (
    run_id       TEXT NOT NULL,
    organization TEXT NOT NULL,
    repository   TEXT NOT NULL,
    path         TEXT NOT NULL,
    commit_sha   TEXT NOT NULL,
    source_path  TEXT NOT NULL,
    moved_from   TEXT,
    lines        INTEGER NOT NULL CHECK (lines > 0),
    PRIMARY KEY (run_id, organization, repository, path, commit_sha, source_path),
    FOREIGN KEY (run_id, organization, repository, commit_sha)
        REFERENCES horizon.blame_commits(run_id, organization, repository, commit_sha)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS blame_commits_author_idx
    ON horizon.blame_commits (author_email, run_id);
CREATE INDEX IF NOT EXISTS blame_attribution_path_idx
    ON horizon.blame_attribution (run_id, organization, repository, path);
```

Each L5 PR adds its own `CREATE TABLE IF NOT EXISTS` to `schema.sql`. Feature tables are
materialized, not views, so Dagster tracks freshness and a failed feature does not silently
serve stale numbers.

**One aggregation trap to flag in review:** the attribution↔commits join fans each commit
across every file it touched, so any commit-level count must use `COUNT(DISTINCT commit_sha)`.
A plain `COUNT(*)` counts file-commit pairs and inflates `rebased_commits`, `boundary_commits`,
and `surviving_commits`.

## Assumptions

- **New `horizon` schema**, same database; `gitea_analytics` untouched as a baseline.
- **Run-scoped rows** — blame is a snapshot of *now*, so without `run_id` a rerun destroys the
  previous answer.
- **The Authentik user PK is the canonical person identifier**, never an email. Emails are
  mutable and plural per person; a PK is neither. Blame cannot produce one, so it comes from the
  directory roster, and a git identity matching no user keeps a null PK instead of vanishing.
- **Raw git identity preserved everywhere except the mart.** Legacy resolved early and on
  failure stored the raw string as though it were a login.
- **Classification after collection, never during.** See PR 8.
- **httpx, not the curl-subprocess client** (`:162`) — that hack exists for commit pages, which
  this does not touch.

## What blame cannot provide

Stated once so no PR overclaims: deleted or rewritten code, churn, additions and deletions, PR
reviews, issues, `Co-authored-by` trailers, and non-default-branch work are all out of reach.
**Nor can it supply a user identity.** Git stores whatever name and email the author configured;
it has no link to a directory account, which is why the Authentik roster is a separate source
and why `match_method` records how each link was inferred rather than asserting it as fact.
They arrive later from the commits and pulls endpoints as separate increments.

## Files

```
horizon/pipeline/
  __init__.py
  config.py        PipelineSettings: gitea_url, gitea_api_token, database_url,
                                     authentik_url, authentik_api_token
  resources.py     GiteaClient · AuthentikClient · GitWorkspace · PostgresResource
  blame_parser.py  PURE: str -> list[BlameRecord]   (all 14 fields)
  identity.py      PURE: tiered alias heuristics, union-find, git identity -> user PK
  classify.py      PURE: path -> path_class
  assets/
    source.py      gitea_repository, authentik_users
    capture.py     blame_capture
    parse.py       blame_records
    load.py        blame_commits_table, blame_attribution_table
    features/      ownership.py repo_ownership.py concentration.py
                   file_mix.py activity.py durability.py
                   process.py identity.py
    mart.py        member_profile
  checks.py
  schema.sql
  definitions.py
horizon/tests/   one test module per asset module
```

`horizon/project.json`: `install-deps` → `.[test,pipeline,orchestration]`; `build`/`lint`
extended to `pipeline`; new `dagster` target.

## Verification

**Every PR** must pass `./nx run data_pipeline:check` (build, test, lint). Additionally:

- PR 1: `dagster dev` boots; `Definitions` loads with zero assets.
- PR 2: `blame_capture` materializes against a **local** throwaway git repo built in a
  tmpdir — a local path is a valid clone source, so no network is needed.
- PR 3: `blame_parser.py` parses `data/amazon-leo-git-blame.txt` and reproduces its known counts —
  36,653 lines, 11 author names, 13 identity pairs, 195 commits, 254 files, 8,728 `previous`,
  1,131 `boundary`, 65 author≠committer. A real 14MB capture, not a synthetic fixture.
- PR 4: rows land; `attribution_lines_reconcile` passes; a deliberately truncated capture makes
  it fail.
- PRs 5–11: each feature table reconciles against `blame_attribution`, and each PR body carries
  a worked example — one member's numbers and the SQL that produced them.
- PR 12: the roster pulls a non-empty user list, and every returned PK is a non-empty string.
- PR 13: `Michael McCarroll`'s 3 emails resolve to **one** `authentik_user_pk`; assert no two
  *different* people collapse onto one PK, using the known-distinct pairs in the capture; and
  assert an address with no directory user lands as `unmatched` rather than disappearing.
- PR 14: profile row count equals distinct `authentik_user_pk` plus the unmatched identities, and
  its line totals still reconcile to `blame_attribution`.
- PR 15: two partitions backfill independently; one failing does not block the other.

**End to end, after PR 14:**

```bash
export HORIZON_DATABASE_URL='postgresql://gitea_analytics:…@127.0.0.1:5433/gitea_analytics'
cd horizon && .venv/bin/dagster asset materialize -m pipeline.definitions --select '*'
```

```bash
docker exec appdev-gitea-analytics-postgres-1 psql -U gitea_analytics -d gitea_analytics -c "
  SELECT authentik_user_pk, username, surviving_lines, non_boundary_lines, code_lines,
         files_majority_owned, surviving_commits, active_weeks,
         first_line_at::date, last_line_at::date
  FROM horizon.member_profile ORDER BY non_boundary_lines DESC LIMIT 10;"
```

Cross-check the top-owner *ranking* against `gitea_analytics.member_metrics` for the same repo.
Totals will differ — legacy filtered by extension and used `-w` without `-M -C` — but a ranking
disagreement means the parser is wrong.

## Ladder after this

1. org repo listing → blame every repo (partition backfill)
2. roster coverage — which directory users have **zero** surviving lines. The roster itself
   arrives in PR 12, so this is now a query over `authentik_users` left-joined to
   `member_profile`, not a new ingestion.
3. further Gitea features (commits, PRs, reviews, issues) as independent increments
