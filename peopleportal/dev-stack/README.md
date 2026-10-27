# People Portal local development stack

This stack provides Authentik, Gitea, MongoDB 7, Redis, Postgres and Mailpit,
including an OIDC bridge for Gitea. The portal server and UI run on the host
through the repository Nx wrapper. S3 object storage is a known gap.

## Quick start

Install Docker with Compose v2.20+, Bash, curl, OpenSSL, Python 3.9+, and
Node.js 22.12+ with npm. Python is used for the host port preflight; the
Authentik bootstrap and OIDC bridge use Python inside the pinned image.
Use macOS or Linux; Windows contributors need WSL2 with Docker integration
and must run these commands inside WSL2.

From a fresh clone:

```bash
cd peopleportal/dev-stack
./scripts/up.sh --write-env
cd ../..
./nx serve pplserver
# In a separate terminal from the repository root:
./nx serve pplui
```

Setup is noninteractive. It generates local credentials once, checks ports
before starting containers, starts healthy services, bootstraps Authentik and
Gitea, and runs `scripts/verify.sh`. Both up and verify print the selected ports.
The first image pull, bootstrap and Nx dependency install can take several minutes.

Application submission uses a MongoDB transaction. This stack initializes a
single-node replica set named `ppdev` automatically and preserves existing data.
After updating an existing stack, rerun `up.sh --write-env`. If the server env
file already exists, update its `PEOPLEPORTAL_MONGO_URL` from the printed block;
it must include `replicaSet=ppdev&directConnection=true`, including on custom ports.
Other development databases must also support transactions; MongoDB Atlas does.

Open <http://localhost:5173>. Sign in as `akadmin` with the generated
`AUTHENTIK_BOOTSTRAP_PASSWORD` in this directory's `.env`. Skip initial Authentik
setup. The backend callback is <http://localhost:3000/api/auth/redirect>.
Use `localhost` consistently. Return to the Vite URL for hot reload.

`--write-env` creates `peopleportal/server/.env.development` only when absent
and prints the equivalent server env block. Keep that output private. Existing
server env files may shadow new settings: process environment wins, then `.env`,
`.env.development` and `.env.development.local` in first-value order.

## Ports and overrides

| Service | Default port | Variable in dev-stack/.env |
| --- | ---: | --- |
| Portal backend | 3000 | `PORTAL_PORT` |
| Vite UI | 5173 | `WEBUI_PORT` |
| MongoDB | 27017 | `MONGO_PORT` |
| Redis | 6379 | `REDIS_PORT` |
| Authentik | 9000 | `AUTHENTIK_PORT` |
| Gitea | 3001 | `GITEA_PORT` |
| Gitea SSH | 2222 | `GITEA_SSH_PORT` |
| Mailpit inbox | 8025 | `MAILPIT_PORT` |
| SMTP | 1025 | `SMTP_PORT` |

Postgres is internal only. All published Docker ports bind to `127.0.0.1`;
`BIND_ADDRESS` must remain `127.0.0.1`. Vite keeps its normal localhost binding.
Use distinct free ports. `up.sh` fails before starting containers when a port is
unavailable, naming the exact variable to change. Ports already published by
running containers in this Compose project are accepted on a repeat run.
Stop the host portal and UI before rerunning setup.

Before the first setup, export overrides, for example:

```bash
export PORTAL_PORT=3100 WEBUI_PORT=5174 GITEA_PORT=3101 REDIS_PORT=6380
./scripts/up.sh --write-env
```

For later changes, stop this Compose project and the host apps, edit this
stack's `.env`, and clear `PORTAL_BASE_URL`, `AUTHENTIK_URL` or `GITEA_URL` when
changing their corresponding port. `gen-env.sh` derives empty URLs from
`PUBLIC_HOST` and the selected ports, while preserving nonempty settings.
Then rerun `up.sh --write-env` and update existing server/UI env files from the
printed block, since existing files are preserved. Do not stop other Docker
projects to resolve conflicts.

For alternate application ports, `portal-env.sh` prints `PP_DEV_PORTAL_PORT`
only when `PORTAL_PORT` differs from 3000, and `PP_DEV_WEBUI_PORT` only when
`WEBUI_PORT` differs from 5173. `--write-env` also creates
`peopleportal/webui/.env.development.local` with just those overrides if absent.
Without `--write-env`, copy the printed `PP_DEV_*` lines to that UI file yourself.
When returning to default ports, remove stale `PP_DEV_*` entries from existing
UI env files and your shell. Restart both host apps after changes.

Without `PP_DEV_*` variables, Vite behaves as before: `/api` proxies to
`http://localhost:3000`, its default port is 5173, and no host or `strictPort`
override is applied. An explicit `PP_DEV_WEBUI_PORT` enables `strictPort` so the
UI does not silently move away from its configured port. `PP_DEV_PORTAL_PORT`
changes only the API proxy target.

## Mail, Git and credentials

All portal, Authentik and Gitea mail lands in [Mailpit](http://localhost:8025),
with no external delivery. [Gitea](http://localhost:3001) has a generated
`devadmin` account with `GITEA_ADMIN_PASSWORD` in `.env` and a separate Authentik
OIDC client. The IPv4/IPv6 loopback bridge permits public discovery inside Gitea.
Host callbacks use `host.docker.internal` and the configured portal port.

`.env`, `.oidc`, `.gitea-token` and server/UI env files contain local settings
or generated secrets and are gitignored. Do not publish, share publicly or
reuse the credentials for real work.

## Known gaps

**S3 object storage is not included; resume/avatar uploads will fail.**
Garage, SeaweedFS and versitygw are candidates for a follow-up; no replacement
has been selected. No S3 image is pulled, started or checked. `S3_ENDPOINT`,
`S3_FORCE_PATH_STYLE`, `S3_BUCKET_NAME` and dummy credentials remain placeholders;
`http://s3.example.invalid` is deliberately nonfunctional. The server currently
ignores endpoint/path-style overrides and `AWS_ENABLED=false`, so adding a
storage service alone will not wire uploads. Server S3/AWS behavior is unchanged.

AWS provisioning, Organizations/Budgets, Slack actions and other external
integrations are unsupported locally. Dummy organization IDs and Slack values
satisfy startup checks only. Do not enable AWS provisioning on local teams.
Discord and photo checks remain disabled. Browser login/logout needs a separate
end-to-end test; the included smoke checks verify service APIs and OIDC discovery.

## Verify, stop and reset

From `peopleportal/dev-stack`:

```bash
./scripts/verify.sh
# Stops this project and preserves its data:
docker compose stop
./scripts/reset.sh
# Explicit noninteractive deletion of only the selected project's service data:
./scripts/reset.sh --yes
```

`verify.sh` checks all eight included containers and backing-service APIs with
17 checks, and exits 0 when all pass. It always prints a visible NOTE about S3.
Reset preserves stack and server/UI env files, deletes service data and exported
OIDC/token files, and changes the Gitea token on the next bootstrap. Update the
server env from the new output. Keep the same `COMPOSE_PROJECT_NAME` between
starting, stopping and resetting; the default project name is `ppdev`.
