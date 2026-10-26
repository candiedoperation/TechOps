# Horizon local debug stack

This stack runs a real local Authentik API and a separate local Postgres feature
store. Horizon uses a temporary Git repository and deterministic in-process
Gitea responses, so it exercises the full Dagster graph without contacting Gitea
or writing to Supabase.

## Run the full debug flow

From the Horizon directory:

```bash
.venv/bin/python scripts/local_debug.py all
```

The command creates a private `.env.debug` with random credentials, starts
Authentik and two local Postgres databases, seeds four synthetic Authentik
users, builds a temporary Git repository and mock PR/review responses, then
runs all Dagster assets and checks. `.env.debug` is ignored by Git. The local
Horizon Postgres database is bound only to `127.0.0.1:55432`; Authentik is
bound only to `127.0.0.1:19000`.

The mock roster includes two unique emails and two users sharing one email. The
Git fixture includes exact, ambiguous, and unmatched author emails; mock PR
reviews include matched and unmatched Gitea logins. This makes the identity
review cases visible in the check results.

Useful commands:

```bash
.venv/bin/python scripts/local_debug.py up
.venv/bin/python scripts/local_debug.py seed
.venv/bin/python scripts/local_debug.py run
.venv/bin/python scripts/local_debug.py run-gitea
.venv/bin/python scripts/local_debug.py status
.venv/bin/python scripts/local_debug.py down
```

`run` uses a temporary local Git repository and in-process Gitea responses.
`run-gitea` reads the configured fixture repository from Gitea, clones it over
SSH, and fetches real PR and review pages while still using only the local
Authentik roster and local Postgres database. It is useful for testing source
pagination and repository capture without writing to Supabase. It uses the
Gitea settings from `horizon/.env`; the database target is validated from
`.env.debug` and must remain on loopback.

To exercise retry behavior, run the same command twice with a fixed UUID:

```bash
.venv/bin/python scripts/local_debug.py run --run-id 00000000-0000-4000-8000-000000000001
```

Each persistence step replaces that run's snapshot instead of duplicating rows.

Every run writes its exact repository commit and source timestamps to
`horizon_gt_features.pipeline_runs`. Blame lines are bulk-loaded to
`blame_records`; ownership, identity, PR-review-count and PR-commit tables keep
run-scoped rows. A run is usable only when its manifest says `complete`; the
final Dagster asset checks row counts before marking it complete. Incomplete
runs can contain partial rows after a failure, so downstream queries should
join through `pipeline_runs` and filter `status = 'complete'`.

`down` stops containers and preserves their local volumes. The local Authentik
UI is available at <http://127.0.0.1:19000>. All usernames and `example.test`
emails are synthetic. The generated bootstrap password and API token remain in
the private, ignored `.env.debug` file.

The Authentik version is pinned to `2026.5.2`, matching People Portal's declared
compatibility ceiling. Do not point this debug stack at a real Authentik URL or
database; the runner validates loopback hosts, ports, and database name before
starting.
