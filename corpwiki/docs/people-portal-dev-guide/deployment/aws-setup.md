---
sidebar_position: 6
---

# AWS Setup

People Portal provisions a dedicated AWS account per team, budgets it, and
archives it on request. That needs an organization with two OUs, a service
control policy, an IAM user and one role.

Every policy document referenced here lives in `peopleportal/server/aws/`, so the
org setup is reviewable in the repo rather than reconstructed from console clicks.

None of this is scripted: it needs account creation and credentials issued by a
human in a browser.

## 1. Organizational units

**AWS Organizations** → **AWS accounts**. With **Root** selected, use **Actions**
→ **Create new** twice:

- one OU for active team accounts → `AWS_NONPROD_OU_ID`
- one named `Suspended` → `AWS_SUSPENDED_OU_ID`

Each OU's `ou-...` id is printed under its name in the tree. The root's `r-...`
id goes in `AWS_ORG_ROOT_ID`, and the management account's twelve digits in
`AWS_MANAGEMENT_ACCOUNT_ID`.

## 2. The DenyAll SCP

**Organizations** → **Policies** → **Service control policies**. If that page
offers "Enable service control policies", do it first.

Create a policy named `DenyAll` from `aws/deny-all-scp.json`, then **attach it to
the Suspended OU**.

Its id is not a column in the policy list. Open the policy and read it from the
URL, or from the ARN on the detail page. It goes in `AWS_DENY_ALL_SCP_ID`.

:::danger Attach to the Suspended OU, never Root
A deny-everything SCP on **Root** denies every action in every account, including
the management account, and locks you out of the console you would use to undo it.
The console will let you do it.
:::

Archiving a team only *moves* its account into the Suspended OU. It attaches
nothing. The account goes inert solely because this SCP hangs on that OU, so
verify the attachment or archived accounts keep running and keep spending.

## 3. The application's IAM user

**IAM** → **Policies** → **Create policy** → **JSON**. Paste
`aws/app-iam-policy.json` with `<MANAGEMENT_ACCOUNT_ID>` and `<S3_BUCKET_NAME>`
substituted.

Then **IAM** → **Users** → **Create user**, without console access. Attach that
policy directly. Under **Security credentials**, create an access key with use
case **Application running outside AWS**.

:::warning The secret is shown once
AWS displays the secret access key exactly once, at creation, and stores only a
hash. There is no console page, API call or CLI command that reads it back. If
it is lost, create a new key and delete the old one.
:::

The pair becomes `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. This user does
everything the app does synchronously: creating accounts, moving them between
OUs, writing budgets, and S3.

## 4. The budget enforcement role

Optional. Without it, provisioning still works and budget alerts still fire, but
a team that exhausts its budget is not cut off automatically.

**IAM** → **Roles** → **Create role** → **Custom trust policy**. Paste
`aws/budget-enforcement-trust-policy.json`, then attach
`aws/budget-enforcement-permissions.json` inline. Name it
`BudgetEnforcementRole`.

Its ARN goes in `AWS_BUDGET_ACTION_ROLE_ARN`, as
`arn:aws:iam::<account>:role/BudgetEnforcementRole`. The name is arbitrary, but
it must match what you put in that variable.

### Why a separate identity

The app never assumes this role. It writes the ARN into a budget action and walks
away. Days later, when a team's actual spend reaches 100% of its budget, the
**Budgets service** assumes the role and attaches the DenyAll SCP to that one
account, possibly while the server is not running at all. AWS will not act on
your behalf using your keys, so it needs an identity it is trusted to become.

That is also why the app's own policy carries `iam:PassRole`: handing a role to a
service is itself a permission.

You may substitute the AWS managed policy
`AWSBudgetsActionsWithAWSResourceControlAccess` for the permissions document. It
covers the same Organizations actions plus IAM, EC2 and RDS controls that budget
actions can also apply, and AWS keeps it current. The custom document is two
actions and nothing else.

:::warning A managed policy cannot replace the trust policy
Permissions and trust answer different questions. A managed policy grants what a
role may do; only the trust policy decides who may become it. Without it,
`CreateBudgetAction` fails because Budgets cannot assume the role at all.
:::

## 5. Environment variables

The full list and defaults are in the AWS section of
[Environment Variables](./environment-variables.md).

:::danger Three are read at import
`AWSClient`'s constructor throws without `AWS_ORG_ROOT_ID`, `AWS_NONPROD_OU_ID`
or `AWS_MANAGEMENT_ACCOUNT_ID`, and it is constructed at module scope. That throw
lands before Express listens, so a deployment missing one does not run without
AWS, it does not run at all. Set them before deploying.
:::

`AWS_ADMIN_ROLE_NAME` names the admin role created *inside* each member account
by `CreateAccount`, which the app later assumes to build console links. It is
unrelated to `BudgetEnforcementRole`, and changing it breaks console links for
accounts created under the old name.

## 6. Enabling it

Provisioning is gated twice. Globally, `awsClient` must be present in
`ENABLED_TEAMSETTING_RESOURCES` in `peopleportal/server/src/config.ts`. Per team,
the **Provision AWS Account** toggle must be on in that team's settings. A team
with the toggle off is skipped with a log line, which reads as success.

:::tip Exercise archive before provision
Archive only moves an existing account between OUs and is reversible.
Provisioning creates a real AWS account, consumes organization quota that a
closed account holds for 90 days, and claims a globally unique root email.
:::
