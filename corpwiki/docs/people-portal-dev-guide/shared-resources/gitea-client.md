# Gitea Client

The Gitea client syncs each team's Authentik group to a Gitea team inside the team's Gitea organization. Every Gitea team is created with `includes_all_repositories`, so its permission applies to **all** repositories in that organization.

## Bindle to Gitea permission mapping

The team permission is computed by `computeGiteaTeamAccess` and applied on every sync. Precedence is admin > write > read.

| Bindle                                                                        | Effect                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| _(none)_                                                                      | Team permission `read`                                                                     |
| `repo:brprotect-approvals`, `repo:brprotect-merge`, `repo:brprotect-override` | Team permission `write` (also whitelists the team for the matching branch protection rule) |
| `repo:allowcreate`                                                            | Team permission `write`, plus "can create repositories"                                    |
| `repo:admin`                                                                  | Team permission `admin`, plus "can create repositories"                                    |

`owner` is never assigned. Gitea does not accept it as a team permission through the API and silently treats it as none.

## `repo:admin` (Repository Administration)

A Gitea team with permission `admin` gives its members **repository owner** access on every repository in the organization. Members can:

- change repository settings, webhooks, collaborators and branch protection;
- manage the repository's Actions secrets, variables and runners;
- delete or transfer the repository.

It does **not** grant organization-level access. Organization secrets, variables and settings still require the organization's built-in Owners team.

Treat this as a dangerous bindle and grant it sparingly. It is intentionally not part of the default team template.

## Assigning it

1. Open the team in People Portal and choose **Manage Subteams**.
2. Pick the subteam, open **GiteaClient**, and enable **Repository Administration**.
3. Run **Sync Shared Permissions**.

Notes:

- The root team maps to the `PeoplePortalTeamOwners` Gitea team and is synced with `read` permission. Members must therefore be in the **subteam** that holds the bindle.
- Team owners and executives can grant the bindle.
