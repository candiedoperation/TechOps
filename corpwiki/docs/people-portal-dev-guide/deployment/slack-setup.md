---
sidebar_position: 5
---

# Slack Setup

People Portal creates channels, invites and removes members, and looks people up
by email. All of that runs through one bot token, which comes from installing a
Slack app into a workspace. You must be a workspace admin, or have one approve
the install.

Slack cannot be self-hosted, so there is nothing to script here and no local
equivalent. Staging and production each need their own workspace.

## Creating the app

1. Go to **api.slack.com/apps** → **Create New App** → **From scratch**. Name it
   and pick the workspace.
2. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**. Add the scopes
   below.
3. **Install to Workspace** at the top of that page, and approve the consent
   screen.
4. Copy the **Bot User OAuth Token**, starting `xoxb-`, into
   `PEOPLEPORTAL_SLACK_BOT_TOKEN`.
5. Set `PEOPLEPORTAL_SLACK_INVITE_URL` to the workspace's invite link.

:::warning Use a separate workspace for staging
Invitations go out through Slack's own infrastructure, not your SMTP settings, so
`PEOPLEPORTAL_EMAIL_CONREROUTE` will not catch them. A staging workspace wired to
real member addresses mails real members. Seed it with addresses you control, via
a catch-all domain or plus-addressing on one mailbox.
:::

## Scopes

Derived from the nine Web API methods in `clients/SlackClient/index.ts`:

| Method | Scope |
|---|---|
| `auth.test` | none |
| `chat.postMessage` | `chat:write` |
| `conversations.create`, `.archive`, `.invite`, `.kick` | `channels:manage`, plus `groups:write` for private channels |
| `conversations.list`, `.members` | `channels:read`, plus `groups:read` for private channels |
| `users.lookupByEmail` | `users:read`, `users:read.email` |

:::warning `users:read.email` is requested separately
It is a distinct entry from `users:read` and easy to miss in the picker. Without
it `users.lookupByEmail` fails, which breaks member onboarding.
:::

## Token handling

Unlike an AWS secret key, a bot token stays visible on the OAuth page, so you can
return for it rather than rotating when you lose it.

Adding a scope after installing requires reinstalling the app, which issues a
**new** token. Paste it in again wherever the old one lives.

To rotate deliberately: **OAuth & Permissions** → **Reinstall to Workspace** for a
fresh token, or **Settings** → **Install App** → **Revoke** first if you need the
old one dead immediately.

:::danger Treat a leaked token as compromised
Slack scans public surfaces for `xoxb-` tokens and revokes ones it finds, so a
token pasted into a chat, an issue or a log may stop working on its own. Rotate
rather than hoping.
:::

## Variables

| Variable | Notes |
|---|---|
| `PEOPLEPORTAL_SLACK_BOT_TOKEN` | The `xoxb-` token. `SlackClient` throws at construction if unset |
| `PEOPLEPORTAL_SLACK_INVITE_URL` | Workspace invite link surfaced to new members |

`SLACK_ACCESSTOKEN` appears in some deployment environments but is read nowhere in
the server source. Only `PEOPLEPORTAL_SLACK_BOT_TOKEN` matters.

## Verifying

`SlackClient` validates lazily: it constructs successfully against any non-empty
string, so startup logging `Initializing Shared Resource Client: slackClient`
proves only that the variable is set. A placeholder token fails at the first real
API call, surfacing as `invalid_auth` in the container logs rather than at boot.
