---
sidebar_position: 1
---

# Local Development Guide

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

Application submission requires MongoDB transactions. The dev stack initializes
a single-node replica set named `ppdev` without deleting existing data. After
updating an existing stack, rerun `up.sh --write-env` and update an existing
server env file from the printed block. Its `PEOPLEPORTAL_MONGO_URL` must include
`replicaSet=ppdev&directConnection=true`, especially when using a custom port.

Open `http://localhost:5173`. Sign in as `akadmin` with the generated
`AUTHENTIK_BOOTSTRAP_PASSWORD` in this directory's `.env`. Skip initial Authentik
setup. The backend callback is `http://localhost:3000/api/auth/redirect`.
Use `localhost` consistently. Return to the Vite URL for hot reload.

`--write-env` creates `peopleportal/server/.env.development` only when absent
and prints the equivalent server env block. Keep that output private. Existing
server env files may shadow new settings: process environment wins, then `.env`,
`.env.development` and `.env.development.local` in first-value order.

## Ports and overrides


:::note Port clash with the wiki dev server
The Docusaurus wiki dev server (`npm start` in `corpwiki/`) is pinned to port `3001`, the same as the dev stack's default `GITEA_PORT`. If you run both, set `GITEA_PORT=3002` for the dev stack.
:::

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

## Manual setup (without the dev stack)

The steps below are the original manual instructions. Prefer the dev stack above; use this section only if you cannot run Docker or need to understand each piece.

### MongoDB Atlas

For the database, we use MongoDB Atlas. To set it up for local development:
1. Create an account on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a new project and cluster.
3. In the Database Access section, create a new user with read/write permissions.
4. In the Network Access section, add your IP address (or `0.0.0.0/0` for broad access during development).
5. Copy the connection string and set it as `PEOPLEPORTAL_MONGO_URL` in your server `.env` file.

### Authentik Setup

People Portal relies heavily on Authentik for OIDC authentication. You can host an Authentik instance locally using Docker Compose.

#### Docker Compose

Create a `docker-compose.yml` file for Authentik in a local directory configuration of your choosing:

```yaml
services:
  postgresql:
    env_file:
      - .env
    environment:
      POSTGRES_DB: ${PG_DB:-authentik}
      POSTGRES_PASSWORD: ${PG_PASS:?database password required}
      POSTGRES_USER: ${PG_USER:-authentik}
    healthcheck:
      interval: 30s
      retries: 5
      start_period: 20s
      test:
        - CMD-SHELL
        - pg_isready -d $${POSTGRES_DB} -U $${POSTGRES_USER}
      timeout: 5s
    image: docker.io/library/postgres:16-alpine
    restart: unless-stopped
    volumes:
      - database:/var/lib/postgresql/data
  server:
    command: server
    depends_on:
      postgresql:
        condition: service_healthy
    env_file:
      - .env
    environment:
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__NAME: ${PG_DB:-authentik}
      AUTHENTIK_POSTGRESQL__PASSWORD: ${PG_PASS}
      AUTHENTIK_POSTGRESQL__USER: ${PG_USER:-authentik}
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY:?secret key required}
    image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${AUTHENTIK_TAG:-2026.5.2}
    ports:
      - ${COMPOSE_PORT_HTTP:-9000}:9000
      - ${COMPOSE_PORT_HTTPS:-9443}:9443
    restart: unless-stopped
    volumes:
      - ./data:/data
      - ./custom-templates:/templates
  worker:
    command: worker
    depends_on:
      postgresql:
        condition: service_healthy
    env_file:
      - .env
    environment:
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__NAME: ${PG_DB:-authentik}
      AUTHENTIK_POSTGRESQL__PASSWORD: ${PG_PASS}
      AUTHENTIK_POSTGRESQL__USER: ${PG_USER:-authentik}
      AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY:?secret key required}
    image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}:${AUTHENTIK_TAG:-2026.5.2}
    restart: unless-stopped
    user: root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
      - ./certs:/certs
      - ./custom-templates:/templates
volumes:
  database:
    driver: local
```

#### Environment Variables (.env)

Next to your `docker-compose.yml`, create a `.env` file that includes the necessary variables. Ensure you replace the placeholder values securely:

```env
PG_DB=authentik
PG_USER=authentik
PG_PASS=your_secure_postgres_password
AUTHENTIK_SECRET_KEY=your_secure_randomly_generated_secret_key
COMPOSE_PORT_HTTP=9000
COMPOSE_PORT_HTTPS=9443
AUTHENTIK_ERROR_REPORTING=true
```

Run `docker compose up -d` to start Authentik. Then, navigate to `http://localhost:9000/if/flow/initial-setup/` to complete the initial setup and retrieve your initial user details (the default admin user is `akadmin`).

#### Authentik Application and Provider Configuration

Once Authentik is running, configure the Application and Provider to allow People Portal to authenticate users.

1. Log in to your Authentik instance as `akadmin`.
2. Navigate to **Applications** > **Applications**.
3. Click **Create with Provider** and enter:
   - **Name**: `People Portal`
   - **Provider Type**: `OAuth2/OpenID Provider`
4. In the Provider settings configuration:
   - **Authorization flow**: Select `default-provider-authorization-implicit-consent`
   - **Client Type**: `Confidential`
   - **Redirect URIs**: `http://localhost:3000/api/auth/redirect` (Replace `3000` with your backend server's port if running on a different port locally).
5. Take note of the **Client ID** and **Client Secret**. These correspond to the `PEOPLEPORTAL_OIDC_CLIENTID` and `PEOPLEPORTAL_OIDC_CLIENTSECRET` environment variables on your People Portal server.

#### Authentik Admin API Token

The People Portal server makes administrative calls to Authentik (creating groups, listing users, managing memberships) using a long-lived API token.

1. Navigate to **Directory** > **Tokens & App Passwords** and click **Create**.
2. Set **User** to `akadmin`.
3. Set **Intent** to `API Token`.
4. Uncheck **Expiring** so the token never expires.
5. Set the token as `PEOPLEPORTAL_AUTHENTIK_TOKEN` in your server `.env`.

#### Defining the `people_portal` Scope

For People Portal to work, ensure the `openid`, `profile`, `email`, and a custom `people_portal` scope are configured in your OpenID Provider.

To create the custom `people_portal` scope in Authentik:
1. Navigate to **Customization** > **Property Mappings**.
2. Click **Create** and select **Scope Mapping** (Map an OAuth Scope to User Properties).
3. Enter the following variables:
   - **Name**: `People Portal Scope`
   - **Scope Name**: `people_portal`
4. Use the following Python code for the filtering expression:
   ```python
   return {
       "pk": request.user.pk,
       "is_superuser": request.user.is_superuser,
       "attributes": request.user.attributes
   }
   ```
5. Click **Create**.
6. Go back to your **People Portal** Provider settings, under **Advanced Protocol Settings**, and add this new scope along with `openid`, `profile`, and `email`.

*(For further details, refer to the [OpenID Provider Configuration](./oidc-provider-config.md) and [Environment Variables](./environment-variables.md) docs).*

### Gitea Setup

Gitea is utilized for localized source version control integrated within People Portal. You can easily get it running via another Docker Compose file:

```yaml
version: "3"

networks:
  gitea:
    external: false

services:
  server:
    image: gitea/gitea:1.21.0
    container_name: gitea
    environment:
      - USER_UID=1000
      - USER_GID=1000
      - GITEA__database__DB_TYPE=sqlite3
    restart: always
    networks:
      - gitea
    volumes:
      - ./gitea:/data
      - /etc/timezone:/etc/timezone:ro
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "10000:3000"
      - "222:22"
```

Launch the stack with `docker compose up -d` and navigate to `http://localhost:10000` to finish the web initial configuration. Because it uses an SQLite setup for local dev, an external database instance isn't required.

Once configured, generate an administrator token within Gitea and map it to `PEOPLEPORTAL_GITEA_TOKEN`, keeping `PEOPLEPORTAL_GITEA_ENDPOINT` appropriately set to your web URL `http://localhost:10000` or comparable port.

:::tip Script the rest
`peopleportal/server/scripts/bootstrap-gitea.sh` creates the admin user, the API
token and the OIDC auth source, and sets that source's scopes. These live only in
Gitea's database and none of them can be created through its REST API, so a
bearer token cannot reconcile them and the app cannot do it at startup.

It auto-detects the running Gitea container and is idempotent, so re-running
changes nothing once the instance is correct. Run `bootstrap-authentik.sh` first:
it writes the OIDC client credentials to a gitignored `.oidc` that the Gitea
script reads.

```bash
cd peopleportal/server/scripts
AK_TOKEN=<authentik api token> ./bootstrap-authentik.sh http://localhost:3000
./bootstrap-gitea.sh
```

The generated admin password and API token land beside the scripts, both
gitignored. Put the token in `PEOPLEPORTAL_GITEA_TOKEN`.

Webhooks are deliberately absent from both scripts: the server reconciles those
itself on every start, via `GiteaClient/hooksetup.ts`.
:::

### Redis

The server uses Redis as a cache. It is optional, and without it startup logs
`PEOPLEPORTAL_REDIS_URL is unset; running without a cache` and carries on, but
running it locally matches deployed behaviour:

```bash
docker run -d --name people-portal-redis -p 6379:6379 --restart unless-stopped redis:alpine
```

Then set `PEOPLEPORTAL_REDIS_URL=redis://localhost:6379`.

### Running the Applications Locally

Server and UI are two Nx projects in one repository, run from the repo root.

#### 1. People Portal Server (Backend)

The backend handles all business logic, database connections, and authentication workflows.

##### Environment Variables

Configuration lives in `peopleportal/server/.env.development`, which is
gitignored. The loader layers `.env`, then `.env.<NODE_ENV>`, then
`.env.<NODE_ENV>.local`, and the real process environment always wins. For the
full list see the [Environment Variables](./environment-variables.md) guide.

Here is an example `.env` configuration combining what we've set up above for local testing:

```env
# Application Base
PEOPLEPORTAL_BASE_URL=http://localhost:3000
PEOPLEPORTAL_TOKEN_SECRET=your_secure_local_token_secret
PORT=3000

# MongoDB
PEOPLEPORTAL_MONGO_URL=mongodb+srv://<user>:<password>@<cluster-url>/<dbname>?retryWrites=true&w=majority

# Authentik OIDC
PEOPLEPORTAL_OIDC_DSCVURL=http://localhost:9000/application/o/people-portal/.well-known/openid-configuration
PEOPLEPORTAL_OIDC_CLIENTID=your_authentik_client_id
PEOPLEPORTAL_OIDC_CLIENTSECRET=your_authentik_client_secret

# Authentik Admin Client
PEOPLEPORTAL_AUTHENTIK_ENDPOINT=http://localhost:9000
PEOPLEPORTAL_AUTHENTIK_TOKEN=your_authentik_service_account_token

# Gitea
PEOPLEPORTAL_GITEA_ENDPOINT=http://localhost:10000
PEOPLEPORTAL_GITEA_TOKEN=your_gitea_admin_token

# Gitea Webhook Target
# Public URL the Gitea instance can reach to deliver webhooks. For local dev,
# this is typically the same as PEOPLEPORTAL_BASE_URL. If left unset, Gitea
# system hooks will be registered with broken `undefined/...` URLs on first run.
PEOPLEPORTAL_WEBHOOK_URL=http://localhost:3000

# Slack
# Bot User OAuth Token (xoxb-...) and the workspace invite URL.
# These are loaded eagerly — the server will fail to start if either is missing.
PEOPLEPORTAL_SLACK_BOT_TOKEN=<your-slack-bot-token>
PEOPLEPORTAL_SLACK_INVITE_URL=https://join.slack.com/t/your-workspace/shared_invite/...

# Node TLS (Only strictly necessary if connecting to instances with self-signed certs)
# NODE_TLS_REJECT_UNAUTHORIZED=0

# AWS (placeholders are fine unless you're working on AWS provisioning features)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_ORG_ROOT_ID=your-org-root-id
AWS_NONPROD_OU_ID=your-nonprod-ou-id
AWS_MANAGEMENT_ACCOUNT_ID=your-management-account-id
AWS_ADMIN_ROLE_NAME=OrganizationAccountAccessRole
AWS_DEFAULT_BUDGET_AMOUNT=20
AWS_BILLING_ALERT_EMAIL=you@example.com
S3_BUCKET_NAME=your-s3-bucket-name
```

##### Starting the Server

With your `.env` configured inside the backend repo, install the dependencies and start the local development server:

```bash
# From the repo root
./nx run pplserver:serve
```

The backend server should now be live at `http://localhost:3000`.

#### 2. People Portal UI (Frontend)

The frontend is built with Vite and React. In local development, the UI server will automatically proxy `/api` requests to your running backend (`http://localhost:3000`).

##### Starting the UI

No separate `.env` file is required for local UI development. 

```bash
./nx run pplui:serve
```

Or start both at once, which is usually what you want:

```bash
./nx run-many -t serve -p pplserver pplui
```

The UI will typically start on `http://localhost:5173`. Open this URL in your web browser to view your local People Portal. With both running, the frontend will be able to utilize your backend context and dependencies!
