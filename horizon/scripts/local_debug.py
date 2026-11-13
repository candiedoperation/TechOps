"""Run Horizon end to end against disposable local Authentik and Postgres data.

Gitea is replaced by a deterministic in-process resource and temporary local Git
repository. Authentik and Postgres are real local services started by Compose.
The database URL is checked before any pipeline run so this script cannot write
to Supabase or another remote database.
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import secrets
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID, uuid4

import httpx

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env.debug"
COMPOSE_FILE = ROOT / "dev" / "local-debug" / "compose.yml"
AUTHENTIK_PATH = "peopleportal.atheesh.org/onboardeduser"
AUTHENTIK_VERSION = "2026.5.2"


def read_env_file() -> dict[str, str]:
    if not ENV_FILE.is_file():
        raise RuntimeError("Local debug settings are missing; run `python scripts/local_debug.py up` first.")

    values: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", maxsplit=1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def write_local_env() -> None:
    if ENV_FILE.exists():
        values = read_env_file()
        _validate_local_targets(values)
        return

    auth_token = secrets.token_hex(32)
    db_password = secrets.token_hex(24)
    values = {
        "AUTHENTIK_TAG": AUTHENTIK_VERSION,
        "AUTHENTIK_SECRET_KEY": secrets.token_hex(48),
        "AUTHENTIK_DB_PASSWORD": secrets.token_hex(24),
        "AUTHENTIK_BOOTSTRAP_PASSWORD": secrets.token_urlsafe(32),
        "AUTHENTIK_BOOTSTRAP_TOKEN": auth_token,
        "HORIZON_DEBUG_DB_PASSWORD": db_password,
        "HORIZON_AUTHENTIK_URL": "http://127.0.0.1:19000",
        "HORIZON_AUTHENTIK_API_TOKEN": auth_token,
        "HORIZON_DATABASE_URL": (
            f"postgresql://horizon_debug:{db_password}@127.0.0.1:55432/horizon_debug"
        ),
    }
    contents = "# Generated local-only credentials. Do not commit or share.\n"
    contents += "".join(f"{key}={value}\n" for key, value in values.items())
    descriptor = os.open(ENV_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(contents)
    _validate_local_targets(values)
    print(f"Created private local settings at {ENV_FILE}")


def _validate_local_targets(values: dict[str, str]) -> None:
    auth_url = urlparse(values.get("HORIZON_AUTHENTIK_URL", ""))
    if auth_url.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Local debug Authentik must use a loopback URL on port 19000.")
    if auth_url.port != 19000:
        raise RuntimeError("Local debug Authentik must use port 19000.")

    database_url = urlparse(values.get("HORIZON_DATABASE_URL", ""))
    try:
        is_loopback = ipaddress.ip_address(database_url.hostname or "").is_loopback
    except ValueError:
        is_loopback = database_url.hostname == "localhost"
    if not is_loopback or database_url.port != 55432 or database_url.path != "/horizon_debug":
        raise RuntimeError(
            "Refusing to run debug data against a non-local database; expected "
            "127.0.0.1:55432/horizon_debug."
        )
    if not values.get("HORIZON_AUTHENTIK_API_TOKEN"):
        raise RuntimeError("The local Authentik API token is missing from .env.debug.")


def compose(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = [
        "docker",
        "compose",
        "--project-directory",
        str(ROOT),
        "--env-file",
        str(ENV_FILE),
        "-f",
        str(COMPOSE_FILE),
        *args,
    ]
    return subprocess.run(command, cwd=ROOT, check=check, text=True)


def up() -> None:
    write_local_env()
    compose("up", "-d")
    wait_for_services()


def wait_for_services() -> None:
    values = read_env_file()
    _validate_local_targets(values)
    deadline = time.monotonic() + 300
    last_status = "not ready"

    while time.monotonic() < deadline:
        try:
            response = httpx.get(
                f"{values['HORIZON_AUTHENTIK_URL'].rstrip('/')}/api/v3/core/users/",
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {values['HORIZON_AUTHENTIK_API_TOKEN']}",
                },
                params={"path": AUTHENTIK_PATH, "page": 1},
                timeout=5,
            )
            if response.is_success:
                break
            last_status = f"Authentik API returned HTTP {response.status_code}"
        except httpx.HTTPError as exc:
            last_status = type(exc).__name__
        time.sleep(3)
    else:
        raise RuntimeError(f"Local Authentik did not become ready: {last_status}.")

    from psycopg import OperationalError, connect

    database_url = values["HORIZON_DATABASE_URL"]
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            with connect(database_url, connect_timeout=3) as connection:
                connection.execute("SELECT 1")
            break
        except OperationalError:
            time.sleep(2)
    else:
        raise RuntimeError("Local Horizon Postgres did not become ready.")
    print("Local Authentik API and Horizon Postgres are ready.")


SEED_USERS = (
    ("horizon-debug-alice", "Horizon Debug Alice", "alice@example.test"),
    ("horizon-debug-bob", "Horizon Debug Bob", "bob@example.test"),
    ("horizon-debug-shared-a", "Horizon Debug Shared A", "shared@example.test"),
    ("horizon-debug-shared-b", "Horizon Debug Shared B", "shared@example.test"),
)


def _get_authentik_users(client: httpx.Client, base_url: str, token: str) -> list[dict]:
    users: list[dict] = []
    total_pages: int | None = None
    page = 1
    while total_pages is None or page <= total_pages:
        response = client.get(
            f"{base_url.rstrip('/')}/api/v3/core/users/",
            headers={"Authorization": f"Bearer {token}"},
            params={"path": AUTHENTIK_PATH, "page": page},
        )
        response.raise_for_status()
        payload = response.json()
        page_users = payload.get("results")
        pagination = payload.get("pagination")
        if not isinstance(page_users, list) or not isinstance(pagination, dict):
            raise RuntimeError("Local Authentik returned an invalid user page.")
        page_count = pagination.get("total_pages")
        if not isinstance(page_count, int) or page_count < 0:
            raise RuntimeError("Local Authentik returned invalid pagination metadata.")
        if total_pages is None:
            total_pages = page_count
        elif total_pages != page_count:
            raise RuntimeError("Local Authentik pagination changed during seeding.")
        users.extend(user for user in page_users if isinstance(user, dict))
        page += 1
    return users


def seed_authentik() -> None:
    values = read_env_file()
    _validate_local_targets(values)
    headers = {
        "Authorization": f"Bearer {values['HORIZON_AUTHENTIK_API_TOKEN']}",
        "Accept": "application/json",
    }
    with httpx.Client(timeout=15, headers=headers) as client:
        existing = _get_authentik_users(
            client,
            values["HORIZON_AUTHENTIK_URL"],
            values["HORIZON_AUTHENTIK_API_TOKEN"],
        )
        by_username = {
            user.get("username"): user
            for user in existing
            if isinstance(user.get("username"), str)
        }
        for username, name, email in SEED_USERS:
            body = {
                "username": username,
                "name": name,
                "email": email,
                "is_active": True,
                "path": AUTHENTIK_PATH,
                "type": "internal",
            }
            current = by_username.get(username)
            if current is None:
                response = client.post(
                    f"{values['HORIZON_AUTHENTIK_URL'].rstrip('/')}/api/v3/core/users/",
                    json=body,
                )
            else:
                response = client.patch(
                    f"{values['HORIZON_AUTHENTIK_URL'].rstrip('/')}/api/v3/core/users/{current['pk']}/",
                    json=body,
                )
            if not response.is_success:
                raise RuntimeError(
                    f"Could not seed local Authentik user {username}: "
                    f"HTTP {response.status_code}."
                )

        from pipeline.resources import AuthentikClient

        roster = AuthentikClient(
            base_url=values["HORIZON_AUTHENTIK_URL"],
            api_token=values["HORIZON_AUTHENTIK_API_TOKEN"],
        ).get_peopleportal_roster()
    seeded = {username for username, _, _ in SEED_USERS}
    present = {user.username for user in roster.users}
    missing = seeded - present
    if missing:
        raise RuntimeError(
            "Local Authentik is missing seeded users from the People Portal path filter."
        )
    print(f"Seeded and verified {len(seeded)} local Authentik users.")


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return completed.stdout.strip()


def create_mock_repository(repo: Path) -> list[tuple[str, str, str, datetime, str]]:
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
        text=True,
    )

    commits = (
        (
            "Horizon Debug Alice",
            "alice@example.test",
            "Add the base energy model",
            {
                "src/energy.py": (
                    "def estimate_energy(hours, watts):\n"
                    "    return hours * watts / 1000\n\n"
                    "def annual_energy(daily_kwh, days=365):\n"
                    "    return daily_kwh * days\n"
                ),
                "README.md": "# Horizon local fixture\n\nSynthetic data for local pipeline debugging.\n",
            },
        ),
        (
            "Horizon Debug Bob",
            "bob@example.test",
            "Add normalized reporting helpers",
            {
                "src/energy.py": (
                    "def estimate_energy(hours, watts):\n"
                    "    return hours * watts / 1000\n\n"
                    "def annual_energy(daily_kwh, days=365):\n"
                    "    return daily_kwh * days\n\n"
                    "def normalized_energy(kwh, occupants):\n"
                    "    return kwh / max(occupants, 1)\n"
                ),
                "src/report.py": (
                    "def summarize(site, kwh):\n"
                    "    return {\"site\": site, \"kwh\": kwh}\n"
                ),
            },
        ),
        (
            "Horizon Debug Shared",
            "shared@example.test",
            "Add ambiguous identity example",
            {
                "src/identity.py": (
                    "def canonical_member(raw_email):\n"
                    "    return raw_email.strip().lower()\n"
                ),
                "config.yml": "debug: true\nsource: synthetic\n",
            },
        ),
        (
            "Horizon Debug Unknown",
            "unmatched@example.test",
            "Document the fixture source",
            {
                "README.md": (
                    "# Horizon local fixture\n\n"
                    "Synthetic data for local pipeline debugging.\n\n"
                    "This repository has no external project data.\n"
                ),
            },
        ),
    )

    for author, email, message, files in commits:
        for relative_path, content in files.items():
            target = repo / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        _git(repo, "add", "--all")
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": author,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_COMMITTER_NAME": author,
            "GIT_COMMITTER_EMAIL": email,
        }
        subprocess.run(
            ["git", "-C", str(repo), "-c", f"user.name={author}", "-c", f"user.email={email}", "commit", "--quiet", "-m", message],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

    log = subprocess.run(
        ["git", "-C", str(repo), "log", "--reverse", "--format=%H%x00%an%x00%ae%x00%cI%x00%s"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    result: list[tuple[str, str, str, datetime, str]] = []
    for line in log.splitlines():
        sha, name, email, committed_at, message = line.split("\0", maxsplit=4)
        result.append(
            (
                sha,
                name,
                email,
                datetime.fromisoformat(committed_at),
                message,
            )
        )
    return result


def run_pipeline(*, live_gitea: bool = False, run_id: str | None = None) -> int:
    values = read_env_file()
    _validate_local_targets(values)
    os.environ["HORIZON_ENV_FILE"] = str(ENV_FILE)
    os.environ["HORIZON_AUTHENTIK_URL"] = values["HORIZON_AUTHENTIK_URL"]
    os.environ["HORIZON_AUTHENTIK_API_TOKEN"] = values["HORIZON_AUTHENTIK_API_TOKEN"]
    os.environ["HORIZON_DATABASE_URL"] = values["HORIZON_DATABASE_URL"]
    os.environ["DAGSTER_HOME"] = tempfile.mkdtemp(prefix="horizon-local-dagster-")
    sys.path.insert(0, str(ROOT))

    from pipeline.definitions import defs
    from pipeline.config import PipelineSettings
    from pipeline.resources import (
        AuthentikClient,
        GiteaClient,
        GitWorkspace,
        PullRequestCommit,
        PullRequestReview,
        PullRequestReviewSnapshot,
        Repository,
    )
    from pipeline.storage import PostgresResource

    class MockGiteaClient(GiteaClient):
        local_repo_path: str

        def get_repository(self, org: str, name: str) -> Repository:
            return Repository(
                org=org,
                name=name,
                ssh_url=Path(self.local_repo_path).resolve().as_uri(),
                default_branch="main",
                empty=False,
            )

        def get_pull_request_reviews(
            self, repository: Repository
        ) -> PullRequestReviewSnapshot:
            now = datetime.now(timezone.utc)
            return PullRequestReviewSnapshot(
                organization=repository.org,
                repository=repository.name,
                pull_request_count=2,
                retrieved_at=now,
                reviews=[
                    PullRequestReview(1, 101, "horizon-debug-alice", "APPROVED", now),
                    PullRequestReview(1, 102, "horizon-debug-bob", "REQUEST_CHANGES", now),
                    PullRequestReview(2, 201, "horizon-debug-alice", "COMMENT", now),
                    PullRequestReview(2, 202, "missing-gitea-login", "COMMENT", now),
                    PullRequestReview(2, 203, "horizon-debug-bob", "PENDING", None),
                ],
            )

        def get_pull_request_commits(self, repository: Repository) -> list[PullRequestCommit]:
            return [
                PullRequestCommit(
                    organization=repository.org,
                    repository=repository.name,
                    pull_request_number=1 if index < 2 else 2,
                    commit_sha=sha,
                    author_name=name,
                    author_email=email,
                    committed_at=committed_at,
                    message=message,
                )
                for index, (sha, name, email, committed_at, message) in enumerate(mock_commits)
            ]

    from tempfile import TemporaryDirectory

    with TemporaryDirectory(prefix="horizon-debug-fixture-") as scratch:
        scratch_path = Path(scratch)
        repo = scratch_path / "mock-repository"
        repo.mkdir()
        mock_commits = create_mock_repository(repo)

        if live_gitea:
            gitea_settings = PipelineSettings(_env_file=ROOT / ".env")
            gitea_resource = GiteaClient(
                base_url=gitea_settings.gitea_url,
                api_token=gitea_settings.gitea_api_token,
            )
            organization = "AmazonLeoSPRING2026"
            repository_name = "space-sustainability-app"
        else:
            gitea_resource = MockGiteaClient(local_repo_path=str(repo))
            organization = "horizon-debug"
            repository_name = "mock-repository"

        resources = {
            "gitea": gitea_resource,
            "authentik": AuthentikClient(
                base_url=values["HORIZON_AUTHENTIK_URL"],
                api_token=values["HORIZON_AUTHENTIK_API_TOKEN"],
            ),
            "workspace": GitWorkspace(root=str(scratch_path / "workspace")),
            "postgres": PostgresResource(
                database_url=values["HORIZON_DATABASE_URL"]
            ),
        }
        if run_id is None:
            run_id = str(uuid4())
        else:
            try:
                run_id = str(UUID(run_id))
            except ValueError as exc:
                raise ValueError("Dagster run IDs must be valid UUIDs.") from exc
        job = defs.resolve_implicit_global_asset_job_def()
        result = job.execute_in_process(
            run_config={
                "ops": {
                    "gitea_repository": {
                        "config": {"org": organization, "repo": repository_name}
                    }
                }
            },
            resources=resources,
            run_id=run_id,
            raise_on_error=False,
        )

    materialized: list[str] = []
    check_results: list[tuple[str, bool, str]] = []
    failures: list[tuple[str, str]] = []
    for event in result.all_events:
        if event.event_type_value == "ASSET_MATERIALIZATION":
            materialized.append(event.materialization.asset_key.to_user_string())
        elif event.event_type_value == "ASSET_CHECK_EVALUATION":
            evaluation = event.asset_check_evaluation_data
            check_results.append(
                (
                    str(getattr(evaluation, "check_name", "unknown")),
                    bool(getattr(evaluation, "passed", False)),
                    str(getattr(evaluation, "description", "")),
                )
            )
        elif event.event_type_value == "STEP_FAILURE":
            error = getattr(event.event_specific_data, "error", None)
            failures.append(
                (event.step_key, str(getattr(error, "message", "step failed"))[:500])
            )

    print(f"dagster_run_id={run_id}")
    print(f"gitea_mode={'live' if live_gitea else 'mock'}")
    print(f"pipeline_success={result.success}")
    print(f"materialized_assets={len(materialized)}/{len(defs.resolve_all_asset_keys())}")
    for name, passed, description in check_results:
        print(f"check={name} passed={passed} detail={description}")
    for step, error in failures:
        print(f"failed_step={step} error={error}")

    _print_local_row_counts(values["HORIZON_DATABASE_URL"], run_id)
    return 0 if result.success else 1


def _print_local_row_counts(database_url: str, run_id: str) -> None:
    from psycopg import connect, sql

    database = urlparse(database_url)
    if database.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Refusing to read counts from a non-local database.")
    with connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'horizon_gt_features' AND table_type = 'BASE TABLE' "
                "ORDER BY table_name"
            )
            tables = [row[0] for row in cursor.fetchall()]
            for table in tables:
                cursor.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'horizon_gt_features' AND table_name = %s "
                    "AND column_name IN ('run_id', 'dagster_run_id')",
                    (table,),
                )
                row = cursor.fetchone()
                if row is None:
                    continue
                cursor.execute(
                    sql.SQL("SELECT count(*) FROM {}.{} WHERE {} = %s").format(
                        sql.Identifier("horizon_gt_features"),
                        sql.Identifier(table),
                        sql.Identifier(row[0]),
                    ),
                    (run_id,),
                )
                print(f"local_table={table} rows={cursor.fetchone()[0]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=("up", "seed", "run", "run-gitea", "all", "status", "down"),
        help="Start services, seed Authentik, run the pipeline, or stop the stack.",
    )
    parser.add_argument(
        "--run-id",
        help="Optional Dagster run ID; reuse it to verify idempotent persistence retries.",
    )
    args = parser.parse_args()

    if args.command == "up":
        up()
    elif args.command == "seed":
        wait_for_services()
        seed_authentik()
    elif args.command == "run":
        wait_for_services()
        return run_pipeline(run_id=args.run_id)
    elif args.command == "run-gitea":
        wait_for_services()
        return run_pipeline(live_gitea=True, run_id=args.run_id)
    elif args.command == "all":
        up()
        seed_authentik()
        return run_pipeline()
    elif args.command == "status":
        write_local_env()
        compose("ps")
    elif args.command == "down":
        write_local_env()
        compose("down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
