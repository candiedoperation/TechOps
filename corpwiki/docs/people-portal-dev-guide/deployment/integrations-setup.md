---
sidebar_position: 5
---

# Slack and AWS Setup

Step by step for the two integrations that need real accounts configured before
People Portal can use them. Authentik and Gitea have their own pages:
[OpenID Provider Configuration](./oidc-provider-config.md) and the Gitea section
of [Local Development](./local-development.md).

:::tip Scripted where possible
Authentik and Gitea are reconciled by `peopleportal/server/scripts/bootstrap-authentik.sh`
and `bootstrap-gitea.sh`, both idempotent. Slack and AWS are not scripted: both
require account creation and credential issuing that has to be done by a human in
a browser.
:::

## Slack

A bot token comes from installing a Slack app into a workspace. You must be a
workspace admin, or have one approve the install.

1. **api.slack.com/apps** → **Create New App** → **From scratch**. Name it and
   pick the workspace. For staging, use a **separate free workspace**, not the
   production one, or test invitations will mail real members.
2. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**. Add the scopes in
   the table below.
3. **Install to Workspace** at the top of that page, and approve the consent screen.
4. Copy the **Bot User OAuth Token**, which starts with `xoxb-`, into
   `PEOPLEPORTAL_SLACK_BOT_TOKEN`.
5. Set `PEOPLEPORTAL_SLACK_INVITE_URL` to the workspace invite link.

### Scopes

Derived from the nine Web API methods the server calls:

| Method | Scope |
|---|---|
| `auth.test` | none |
| `chat.postMessage` | `chat:write` |
| `conversations.create`, `.archive`, `.invite`, `.kick` | `channels:manage`, `groups:write` for private |
| `conversations.list`, `.members` | `channels:read`, `groups:read` |
| `users.lookupByEmail` | `users:read`, `users:read.email` |

:::warning `users:read.email` is separate
It is requested independently of `users:read` and is easy to miss in the picker.
Without it `users.lookupByEmail` fails, which breaks member onboarding.
:::

Unlike an AWS secret key, a Slack bot token stays visible on the OAuth page, so
you can come back for it. Adding a scope after installing requires reinstalling
the app, which issues a **new** token you must paste in again.

`SLACK_ACCESSTOKEN` appears in some deployment environments but nowhere in the
server source. Only `PEOPLEPORTAL_SLACK_BOT_TOKEN` is read.

## AWS

People Portal provisions a dedicated AWS account per team, budgets it, and
archives it on request. That needs an organization, two OUs, an SCP, an IAM user
and one role.

Policy documents for everything below are in `peopleportal/server/aws/`.

### 1. Organizational units

In **AWS Organizations** → **AWS accounts**, with **Root** selected, create two
OUs via **Actions** → **Create new**:

- one for active team accounts, feeding `AWS_NONPROD_OU_ID`
- one named `Suspended`, feeding `AWS_SUSPENDED_OU_ID`

Each OU's `ou-...` id appears under its name in the tree. The root's `r-...` id
goes in `AWS_ORG_ROOT_ID`, and the management account's 12 digits in
`AWS_MANAGEMENT_ACCOUNT_ID`.

### 2. The DenyAll SCP

**Organizations** → **Policies** → **Service control policies**. If the page
offers "Enable service control policies", do that first.

Create a policy named `DenyAll` from `aws/deny-all-scp.json`, then **attach it to
the Suspended OU**. Its id is only visible in the URL or on the detail page, not
in the list; it goes in `AWS_DENY_ALL_SCP_ID`.

:::danger Suspended OU only
Attaching a deny-everything SCP to **Root** denies every action in every account,
including the management account, and locks you out of the console you would use
to undo it.
:::

Archiving only *moves* an account into the Suspended OU. It attaches nothing. The
account goes inert solely because this SCP hangs on that OU, so verify the
attachment or archived accounts keep running and keep spending.

### 3. The application's IAM user

**IAM** → **Policies** → **Create policy** → **JSON**, paste
`aws/app-iam-policy.json` with `<MANAGEMENT_ACCOUNT_ID>` and `<S3_BUCKET_NAME>`
substituted. Then **IAM** → **Users** → **Create user**, no console access,
attach that policy directly, and under **Security credentials** create an access
key with use case **Application running outside AWS**.

:::warning Shown once
The secret access key is displayed exactly once, at creation. AWS stores only a
hash, so there is no way to read it back. If it is lost, create a new key and
delete the old one.
:::

Those two values become `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

### 4. The budget enforcement role

This one is optional. Without it, provisioning still works and alerts still fire,
but a team that blows its budget is not cut off automatically.

**IAM** → **Roles** → **Create role** → **Custom trust policy**, paste
`aws/budget-enforcement-trust-policy.json`. Attach
`aws/budget-enforcement-permissions.json` inline, or the AWS managed policy
`AWSBudgetsActionsWithAWSResourceControlAccess`, which is broader but maintained
by AWS. Name it `BudgetEnforcementRole`.

Its ARN goes in `AWS_BUDGET_ACTION_ROLE_ARN`, in the form
`arn:aws:iam::<account>:role/BudgetEnforcementRole`.

The role exists because the app is not the thing that acts. The app only writes
the ARN into a budget action; days later the **Budgets service** assumes that role
and attaches the SCP, possibly while the server is not running. AWS will not act
using your keys, so it needs an identity of its own. That is also why the app's
own policy carries `iam:PassRole`.

A managed policy cannot make a role assumable, so the trust policy is required
either way.

### 5. Environment variables

See the AWS section of [Environment Variables](./environment-variables.md) for
the full list and defaults.

:::danger Set these before deploying
`AWS_ORG_ROOT_ID`, `AWS_NONPROD_OU_ID` and `AWS_MANAGEMENT_ACCOUNT_ID` are read
in `AWSClient`'s constructor, which runs at module scope. Missing any one throws
before Express listens, so the server does not start at all rather than starting
without AWS.
:::

### 6. Enable it

AWS provisioning is gated on `awsClient` being present in
`ENABLED_TEAMSETTING_RESOURCES` in `peopleportal/server/src/config.ts`, and then
per team by the **Provision AWS Account** toggle in that team's settings. A team
with the toggle off is skipped silently, which reads as success.

Exercise **archive** before **provision**. Archive only moves an existing account
between OUs and is reversible. Provisioning creates a real AWS account, consumes
organization quota that a closed account holds for 90 days, and claims a globally
unique root email.
