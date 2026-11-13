# AWS policies

Every AWS policy People Portal depends on, kept here so the org setup is
reviewable in the repo rather than reconstructed from console clicks.

Placeholders in angle brackets are substituted per environment. Nothing here is
applied automatically; these are the documents you paste into IAM and
Organizations. `AWSClient` reads only the resulting ids and ARNs, through the
environment variables named below.

| File | What it is | Where it attaches | Feeds |
|---|---|---|---|
| `deny-all-scp.json` | Service control policy denying every action | The **Suspended OU**, and per-account by the budget action | `AWS_DENY_ALL_SCP_ID` |
| `app-iam-policy.json` | Permissions for the server's own IAM user | That user | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `budget-enforcement-trust-policy.json` | Lets AWS Budgets assume the enforcement role | `BudgetEnforcementRole`, as its trust policy | `AWS_BUDGET_ACTION_ROLE_ARN` |
| `budget-enforcement-permissions.json` | Lets that role attach the DenyAll SCP | `BudgetEnforcementRole`, as a permissions policy | same |

## The two identities, and why there are two

The server's IAM user does everything the app does synchronously: creating
accounts, moving them between OUs, writing budgets, S3. All three SDK clients in
`AWSClient` are constructed without explicit credentials, so they resolve from
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the environment.

`BudgetEnforcementRole` is not the app. The app only writes its ARN into a budget
action and walks away. Days later, when a team's actual spend reaches 100% of its
budget, the **Budgets service** assumes that role and attaches the DenyAll SCP to
that one account, with the server possibly not running at all. AWS will not act
on your behalf using your keys, so it needs an identity of its own. That is also
why `app-iam-policy.json` carries `iam:PassRole`: handing a role to a service is
itself a permission.

Instead of `budget-enforcement-permissions.json` you may attach the AWS managed
policy `AWSBudgetsActionsWithAWSResourceControlAccess`. It covers the same
Organizations actions plus IAM, EC2 and RDS controls that budget actions can also
apply. Broader than this app needs; AWS keeps it current. Either way the trust
policy is still required, since a managed policy cannot make a role assumable.

## Suspended accounts

Archiving a team moves its account into the Suspended OU and deletes its budget.
It does **not** attach anything. The account only goes inert because
`deny-all-scp.json` is already attached to that OU, so verify the attachment or
archived accounts keep running and keep spending.

Attach it to the Suspended OU only. Attaching a deny-everything SCP to the
organization **Root** denies every action in every account including the
management account, and locks you out of the console you would use to undo it.

## Applying these

1. **SCP** — Organizations → Policies → Service control policies → Create policy,
   paste `deny-all-scp.json`, name it `DenyAll`. Attach it to the Suspended OU.
   Its `p-...` id goes in `AWS_DENY_ALL_SCP_ID`.
2. **App user policy** — IAM → Policies → Create policy → JSON, paste
   `app-iam-policy.json` with the placeholders filled, attach to the server's user.
3. **Budget role** — IAM → Roles → Create role → Custom trust policy, paste
   `budget-enforcement-trust-policy.json`, then attach
   `budget-enforcement-permissions.json` inline. Name it `BudgetEnforcementRole`;
   its ARN goes in `AWS_BUDGET_ACTION_ROLE_ARN`.

Service control policies must be enabled for the organization before step 1. If
the Policies page offers "Enable service control policies", do that first.

## Related environment variables

`AWS_ORG_ROOT_ID`, `AWS_NONPROD_OU_ID`, `AWS_SUSPENDED_OU_ID` and
`AWS_MANAGEMENT_ACCOUNT_ID` are ids read straight from the console, not policies.
`AWS_ADMIN_ROLE_NAME` names the admin role created *inside* each member account by
`CreateAccount`, which the app later assumes for console links. It is unrelated to
`BudgetEnforcementRole`, and changing it breaks console links for accounts created
under the old name.

Missing `AWS_DENY_ALL_SCP_ID` or `AWS_BUDGET_ACTION_ROLE_ARN` is not fatal:
`createBudgetEnforcementAction` logs a warning and skips, so provisioning still
succeeds and alerts still fire, without the automatic cutoff. Missing
`AWS_SUSPENDED_OU_ID` *is* fatal to archiving, which throws rather than degrading.
