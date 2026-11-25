#!/usr/bin/env bash
# Run Track 4 end to end on the staging box, in its own containers.
#
#   bash run-on-staging.sh            seed a fresh database and run the graph
#   bash run-on-staging.sh --tests    also run the pytest suite, database tests included
#   bash run-on-staging.sh --ui       also start Dagster on 127.0.0.1:3070 (tunnel to view)
#   bash run-on-staging.sh --down     remove everything this script created
#
# It creates only horizon-t4-* containers, a horizon-t4 network and a
# horizon-t4-venv volume. Postgres publishes no port; Dagster binds 127.0.0.1.
# It never touches the Coolify stack, its postgres, or /opt/pp-deploy.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HORIZON="$(cd "$HERE/../.." && pwd)"
NET=horizon-t4
PG=horizon-t4-pg
UI=horizon-t4-dagster
VENV=horizon-t4-venv
PY_IMAGE=python:3.11-slim
SECRET="$HERE/.pg-password"

down() {
  docker rm -f "$PG" "$UI" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f "$SECRET"
}

TESTS=0 UI_ON=0
for arg in "$@"; do
  case "$arg" in
    --down) down; docker volume rm "$VENV" >/dev/null 2>&1 || true
            echo "Removed the horizon-t4 containers, network and volume."; exit 0 ;;
    --tests) TESTS=1 ;;
    --ui) UI_ON=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Always start from an empty database so the seed is the only data.
down
umask 077
head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$SECRET"
PASSWORD="$(cat "$SECRET")"
URL="postgresql://horizon:${PASSWORD}@${PG}:5432/horizon"

docker network create "$NET" >/dev/null
docker volume create "$VENV" >/dev/null 2>&1 || true
docker run -d --name "$PG" --network "$NET" --restart unless-stopped \
  -e POSTGRES_USER=horizon -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=horizon \
  postgres:16 >/dev/null
echo -n "Waiting for Postgres"
until docker exec "$PG" pg_isready -U horizon -d horizon >/dev/null 2>&1; do echo -n .; sleep 1; done
echo " ready."

py() {
  docker run --rm --network "$NET" -v "$HORIZON:/src" -v "$VENV:/venv" -w /src \
    -e HORIZON_ENV_FILE= -e HORIZON_DATABASE_URL="$URL" \
    -e TEST_POSTGRES_URL="postgresql://horizon:${PASSWORD}@${PG}:5432/postgres" \
    -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" -e PYTHONDONTWRITEBYTECODE=1 \
    "$@"
}

echo "Installing the pipeline (cached in the $VENV volume until pyproject.toml changes)..."
py "$PY_IMAGE" bash -c 'want=$(sha256sum pyproject.toml | cut -c1-16)
  [ "$(cat /venv/.installed 2>/dev/null)" = "$want" ] && exit 0
  [ -x /venv/bin/python ] || python -m venv /venv
  /venv/bin/pip install -q -e ".[test,pipeline,orchestration]" && echo "$want" > /venv/.installed'

echo "Seeding a synthetic FALL 2026 semester..."
py "$PY_IMAGE" /venv/bin/python dev/t4-staging/seed.py

echo "Running ranking_run through publish_ranking..."
py "$PY_IMAGE" bash -c 'set -o pipefail; /venv/bin/python dev/t4-staging/run_t4.py --compare-v1 2>&1 | grep -vE "dagster - (DEBUG|INFO)"'
echo "v1 vs v2 compare report: $HERE/out/"

if [ "$TESTS" = 1 ]; then
  echo "Running the test suite (database tests included)..."
  py "$PY_IMAGE" /venv/bin/python -m pytest -q -p no:cacheprovider tests
fi

if [ "$UI_ON" = 1 ]; then
  docker run -d --name "$UI" --network "$NET" -p 127.0.0.1:3070:3070 \
    -v "$HORIZON:/src" -v "$VENV:/venv" -w /src \
    -e HORIZON_ENV_FILE= -e HORIZON_DATABASE_URL="$URL" -e DAGSTER_HOME=/tmp/dagster-home \
    "$PY_IMAGE" bash -c 'mkdir -p $DAGSTER_HOME && /venv/bin/dagster-webserver -h 0.0.0.0 -p 3070 -m pipeline.definitions' >/dev/null
  echo "Dagster UI on the box at 127.0.0.1:3070. From your Mac:"
  echo "  ssh -N -L 3070:127.0.0.1:3070 appdev-staging   then open http://localhost:3070"
fi
echo "Done. Remove everything with: bash $0 --down"
