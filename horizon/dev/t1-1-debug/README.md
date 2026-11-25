# T1.1 local source fixture

This isolated PostgreSQL-only stack uses Compose project `horizon-t1-1`, the loopback port
`127.0.0.1:55433`, and its own named volume. It does not use Authentik or People Portal and does
not connect to the shared Horizon/Auth stack.

From the repository root, save a private one-off password locally (the ignored `.env.local` is
not part of the feature branch), then start only this project. Python 3.11 or newer must be first
on `PATH` because Nx creates the Horizon virtual environment using `python3`. On the verification
machine used for this handoff, the system `python3` is 3.9 and Homebrew Python 3.11 is at
`/opt/homebrew/bin/python3.11`; create a temporary `python3` shim and prepend it:

```sh
mkdir -p /tmp/horizon-py311-bin
ln -sf /opt/homebrew/bin/python3.11 /tmp/horizon-py311-bin/python3
export PATH="/tmp/horizon-py311-bin:$PATH"
umask 077
if [ ! -f horizon/dev/t1-1-debug/.env.local ]; then
  printf 'HORIZON_T1_1_DB_PASSWORD=%s\n' "$(/opt/homebrew/bin/python3.11 -c 'import secrets; print(secrets.token_urlsafe(32))')" > horizon/dev/t1-1-debug/.env.local
fi
docker compose --project-name horizon-t1-1 --env-file horizon/dev/t1-1-debug/.env.local -f horizon/dev/t1-1-debug/compose.yml up -d
set -a
source horizon/dev/t1-1-debug/.env.local
set +a
export HORIZON_TEST_DATABASE_URL="postgresql://horizon_t1_1:${HORIZON_T1_1_DB_PASSWORD}@127.0.0.1:55433/horizon_t1_1_test"
./nx run horizon-dag:fixture
HORIZON_TEST_DATABASE_URL="$HORIZON_TEST_DATABASE_URL" ./nx run horizon-dag:test
```

The fixture uses a synthetic FALL 2026 People Portal project and in-process Gitea responses. The
runner validates it is writing to loopback Postgres, performs the real Dagster
`ingest_project_sources` materialization, reports the Dagster run ID, verifies all six table row
counts, and checks the committed `project_source_runs` row and three asset checks. The database
test verifies unchanged reruns update retrieval timestamps only, changed project/PR rows update,
and counts match persisted rows.

To stop the stack while preserving the isolated volume:

```sh
docker compose --project-name horizon-t1-1 --env-file horizon/dev/t1-1-debug/.env.local -f horizon/dev/t1-1-debug/compose.yml down
```

Only delete this stack's volume if you intend to discard its local fixture rows. Do not use
`down -v` against any other compose project.
