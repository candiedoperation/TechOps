---
sidebar_position: 3
---

# Environment Variables

Every variable the People Portal server reads, grouped by what it configures.

Loading is layered, lowest priority first, in `src/config/environment.ts`:
`.env`, then `.env.<NODE_ENV>`, then `.env.<NODE_ENV>.local`. Anything already in
the real process environment always wins, so container and CI values are never
clobbered by a stray file.

:::warning Required in production
Outside development and test, the server refuses to start unless all of these are
set and non-empty: `PEOPLEPORTAL_BASE_URL`, `PEOPLEPORTAL_MONGO_URL`,
`PEOPLEPORTAL_TOKEN_SECRET`, `PEOPLEPORTAL_OIDC_DSCVURL`,
`PEOPLEPORTAL_OIDC_CLIENTID`, `PEOPLEPORTAL_OIDC_CLIENTSECRET`,
`PEOPLEPORTAL_AUTHENTIK_ENDPOINT`, `PEOPLEPORTAL_AUTHENTIK_TOKEN`.
A present-but-empty value counts as missing.
:::

## Core

| Variable | Notes |
|---|---|
| `NODE_ENV` | `development`, `test` or `production`. Anything else throws. Default `development` |
| `PORT` | Listen port. Default `3000` |
| `PEOPLEPORTAL_BASE_URL` | Public origin. Builds the OIDC redirect and post-logout URLs |
| `PEOPLEPORTAL_WEBHOOK_URL` | Origin Gitea calls back on. Usually the same as above |
| `PEOPLEPORTAL_MONGO_URL` | MongoDB connection string |
| `PEOPLEPORTAL_REDIS_URL` | Cache. **Optional**: unset logs "running without a cache" and continues |
| `PEOPLEPORTAL_TOKEN_SECRET` | Session signing secret |

`PEOPLEPORTAL_TOKEN_SECRET` behaves differently by environment. In production it
is required and the server throws without it. In development it generates an
ephemeral one and warns, so sessions do not survive a restart.

## Authentication

| Variable | Notes |
|---|---|
| `PEOPLEPORTAL_AUTHENTIK_ENDPOINT` | Authentik base URL |
| `PEOPLEPORTAL_AUTHENTIK_TOKEN` | Admin API token, sent as `Bearer` |
| `PEOPLEPORTAL_OIDC_DSCVURL` | Discovery document URL |
| `PEOPLEPORTAL_OIDC_CLIENTID` | Client id from the Authentik provider |
| `PEOPLEPORTAL_OIDC_CLIENTSECRET` | Client secret |

The app requests `openid profile email people_portal offline_access`, and reads
`pk`, `is_superuser` and `attributes` from the custom scope. See
[OpenID Provider Configuration](./oidc-provider-config.md) for the provider side,
including what logout needs.

## Gitea

| Variable | Notes |
|---|---|
| `PEOPLEPORTAL_GITEA_ENDPOINT` | Gitea base URL |
| `PEOPLEPORTAL_GITEA_TOKEN` | Admin token. Needs `write:admin` for system webhooks |
| `PEOPLEPORTAL_GITEA_WEBHOOK_SECRET` | Shared secret. **Minimum 32 characters** |

The webhook secret is not optional once Gitea is enabled. `GiteaHookSetup` builds
the `Authorization: Bearer` header from it before creating either hook, and throws
below 32 characters, so a short value means **zero** hooks rather than partial
ones. Inbound webhooks are rejected with 401 unless the header matches, compared
with `timingSafeEqual`.

## Slack and Discord

| Variable | Notes |
|---|---|
| `PEOPLEPORTAL_SLACK_BOT_TOKEN` | Bot token. `SlackClient` throws at construction if unset |
| `PEOPLEPORTAL_SLACK_INVITE_URL` | Workspace invite link surfaced to new members |
| `PEOPLEPORTAL_DISCORD_BOT_TOKEN` | Optional |
| `PEOPLEPORTAL_DISCORD_SERVER_ID` | Optional |

Discord degrades: with either missing, the client logs "Discord integration
disabled" and the server starts normally. A bad token also degrades rather than
crashing, which it used to do at import time.

Slack scopes, from the nine Web API methods used: `chat:write`,
`channels:manage`, `channels:read`, `users:read`, `users:read.email`, plus
`groups:write` and `groups:read` for private channels. `users:read.email` is
requested separately from `users:read` and is easy to miss.

## Email

| Variable | Notes |
|---|---|
| `PEOPLEPORTAL_SMTP_HOST` | SMTP server |
| `PEOPLEPORTAL_SMTP_PORT` | `465` for SSL, `587` for STARTTLS |
| `PEOPLEPORTAL_SMTP_SECURE` | `true` or `false` |
| `PEOPLEPORTAL_SMTP_USER` | SMTP username |
| `PEOPLEPORTAL_SMTP_PASS` | SMTP password |
| `PEOPLEPORTAL_SMTP_DEFAULTFROM` | Default From address when a request does not set one |
| `PEOPLEPORTAL_EMAIL_CONREROUTE` | If set, mail is intercepted instead of sent |

`PEOPLEPORTAL_SMTP_DEFAULTFROM` is the From fallback, not `PEOPLEPORTAL_SMTP_USER`.
Set `PEOPLEPORTAL_EMAIL_CONREROUTE` on any environment seeded with real member
addresses, or onboarding mail reaches real people.

## Photo check

| Variable | Notes |
|---|---|
| `PHOTO_CHECK_ENABLED` | Off unless exactly `true` |
| `PHOTO_CHECK_URL` | Sidecar address. Default `http://localhost:8001` |
| `PHOTO_CHECK_FAIL_CLOSED` | `true` rejects uploads the service could not rule on |

Leave `PHOTO_CHECK_ENABLED` off until the sidecar is actually running, otherwise
every upload is waved through.

## AWS

| Variable | Notes |
|---|---|
| `AWS_ACCESS_KEY_ID` | Server's IAM user |
| `AWS_SECRET_ACCESS_KEY` | |
| `AWS_REGION` | Default `us-east-1` |
| `S3_BUCKET_NAME` | Resumes and avatars |
| `AWS_ORG_ROOT_ID` | Organization root, `r-...` |
| `AWS_NONPROD_OU_ID` | OU new team accounts are moved into |
| `AWS_SUSPENDED_OU_ID` | OU archived accounts move to |
| `AWS_MANAGEMENT_ACCOUNT_ID` | Payer account, where budgets live |
| `AWS_ADMIN_ROLE_NAME` | Role created inside each member account. Default `AppDevNonProductionRole` |
| `AWS_DEFAULT_BUDGET_AMOUNT` | Monthly USD limit. Default `50` |
| `AWS_BILLING_ALERT_EMAIL` | Budget alert recipient |
| `AWS_DENY_ALL_SCP_ID` | DenyAll SCP, `p-...` |
| `AWS_BUDGET_ACTION_ROLE_ARN` | Role AWS Budgets assumes to apply that SCP |

:::danger Three are load-bearing at import
`AWSClient`'s constructor throws without `AWS_ORG_ROOT_ID`, `AWS_NONPROD_OU_ID`
or `AWS_MANAGEMENT_ACCOUNT_ID`, and it is constructed at module scope. That throw
happens before Express listens, so a deployment missing one of them does not
disable AWS, it stops the server from booting.
:::

The rest degrade. Without `AWS_DENY_ALL_SCP_ID` or `AWS_BUDGET_ACTION_ROLE_ARN`,
budget enforcement logs a warning and skips while provisioning still succeeds.
Without `AWS_SUSPENDED_OU_ID`, archiving throws.

`AWS_ADMIN_ROLE_NAME` both names the role created inside new accounts and names
the role assumed for console links, so changing it breaks console access for
accounts created under the old name.

Policy documents live in `peopleportal/server/aws/`.

## Node

| Variable | Notes |
|---|---|
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` disables all TLS verification |
| `NODE_EXTRA_CA_CERTS` | Path to an extra CA bundle |

Setting `NODE_TLS_REJECT_UNAUTHORIZED=0` in production is refused at startup. For
internal or self-signed certificates use `NODE_EXTRA_CA_CERTS`, which trusts your
CA without disabling verification globally.
