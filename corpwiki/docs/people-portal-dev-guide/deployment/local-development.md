---
sidebar_position: 1
---

# Local Development Guide

:::info Default Ports
The Docusaurus documentation server (`npm start` in `corpwiki/`) is pinned to port `3001` to avoid colliding with the People Portal backend on port `3000`. If you need to change either port, update the `start` script in `corpwiki/package.json` and the `PORT` value in your server `.env`.
:::

This guide covers setting up dependencies for running the People Portal locally.

## Cloning the Repositories

Everything lives in one repository. The separate `PeoplePortalServer`,
`PeoplePortalUI` and `AppDev-CorpWiki` repos were folded into the **TechOps**
monorepo and are archived history.

```bash
git clone https://github.com/candiedoperation/TechOps.git
cd TechOps
```

The pieces you will touch:

| Path | Nx project | What it is |
|---|---|---|
| `peopleportal/server` | `pplserver` | Express API, also serves the built UI |
| `peopleportal/webui` | `pplui` | Vite + React frontend |
| `corpwiki` | | This wiki |

Tasks run through Nx from the repo root, never from inside a project directory.

## MongoDB Atlas

For the database, we use MongoDB Atlas. To set it up for local development:
1. Create an account on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Create a new project and cluster.
3. In the Database Access section, create a new user with read/write permissions.
4. In the Network Access section, add your IP address (or `0.0.0.0/0` for broad access during development).
5. Copy the connection string and set it as `PEOPLEPORTAL_MONGO_URL` in your server `.env` file.

## Authentik Setup

People Portal relies heavily on Authentik for OIDC authentication. You can host an Authentik instance locally using Docker Compose.

### Docker Compose

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

### Environment Variables (.env)

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

### Authentik Application and Provider Configuration

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

### Authentik Admin API Token

The People Portal server makes administrative calls to Authentik (creating groups, listing users, managing memberships) using a long-lived API token.

1. Navigate to **Directory** > **Tokens & App Passwords** and click **Create**.
2. Set **User** to `akadmin`.
3. Set **Intent** to `API Token`.
4. Uncheck **Expiring** so the token never expires.
5. Set the token as `PEOPLEPORTAL_AUTHENTIK_TOKEN` in your server `.env`.

### Defining the `people_portal` Scope

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

## Gitea Setup

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

## Redis

The server uses Redis as a cache. It is optional, and without it startup logs
`PEOPLEPORTAL_REDIS_URL is unset; running without a cache` and carries on, but
running it locally matches deployed behaviour:

```bash
docker run -d --name people-portal-redis -p 6379:6379 --restart unless-stopped redis:alpine
```

Then set `PEOPLEPORTAL_REDIS_URL=redis://localhost:6379`.

## Running the Applications Locally

Server and UI are two Nx projects in one repository, run from the repo root.

### 1. People Portal Server (Backend)

The backend handles all business logic, database connections, and authentication workflows.

#### Environment Variables

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

#### Starting the Server

With your `.env` configured inside the backend repo, install the dependencies and start the local development server:

```bash
# From the repo root
./nx run pplserver:serve
```

The backend server should now be live at `http://localhost:3000`.

### 2. People Portal UI (Frontend)

The frontend is built with Vite and React. In local development, the UI server will automatically proxy `/api` requests to your running backend (`http://localhost:3000`).

#### Starting the UI

No separate `.env` file is required for local UI development. 

```bash
./nx run pplui:serve
```

Or start both at once, which is usually what you want:

```bash
./nx run-many -t serve -p pplserver pplui
```

The UI will typically start on `http://localhost:5173`. Open this URL in your web browser to view your local People Portal. With both running, the frontend will be able to utilize your backend context and dependencies!
