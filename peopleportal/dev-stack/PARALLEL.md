# Parallel dev stacks

Run several independent People Portal stacks side by side, one per pull
request, without touching the default `ppdev` stack from the README. Each
stack is a *slot*: its own Compose project, volumes, network, secrets, ports
and hostname, with state under `dev-stack/slots/<N>/` (gitignored).

## Quick start: one PR, one command

From `peopleportal/dev-stack`:

```bash
./scripts/pr.sh 123                    # worktree + deps + slot + default fixture + server + UI
./scripts/pr.sh 123 --fixture mystate  # same, loading the fixture "mystate" instead of "default"
./scripts/pr.sh 123 --no-start         # everything except starting the server and UI
./scripts/pr.sh 123 --down             # stop everything for PR 123 (data and worktree kept)
./scripts/pr.sh 123 --down --purge     # delete containers, volumes, slot state and the worktree
```

`pr.sh` fetches `pull/<n>/head` and checks it out as a detached git worktree
at `${PP_PR_DIR:-~/pp-pr}/<n>`, installs the worktree's server and webui
dependencies with `npm ci` (falling back to `npm install --no-package-lock`
when the lockfile is out of sync, and restoring any lockfile afterwards),
allocates the lowest free slot for that PR number (the mapping is recorded in
`slots/.prs` so it is stable across runs), brings the slot up, loads the
fixture, and starts the server and UI from the worktree on the slot's ports.
It ends by printing the slot URLs and the fixture's logins. Repeat for a
second PR and both stacks run at the same time.

Re-running it is safe: a clean worktree is moved to the current PR head, a
worktree with local changes is kept where it is with a warning, dependencies
are reinstalled only when the lockfile changed, and the server and UI are
restarted. `--down --purge` leaves a worktree with local changes in place and
prints the command to remove it.

## Manual workflow

The pieces `pr.sh` composes, usable on their own:

```bash
./scripts/up.sh --slot 2                       # containers, bootstrap, verify, slot env
./scripts/up.sh --pr 123                       # same, slot chosen from the PR number
./scripts/slot.sh list                         # every slot: project, containers, URL, server/UI state
./scripts/slot.sh urls 2                       # URLs and credential locations for slot 2
./scripts/slot.sh server 2 --dir ~/pp-pr/123/peopleportal   # portal server on slot 2's ports
./scripts/slot.sh ui 2 --dir ~/pp-pr/123/peopleportal       # Vite UI on slot 2's ports
./scripts/slot.sh stop-apps 2                  # stop the host server and UI only
./scripts/slot.sh down 2                       # stop containers, keep volumes
./scripts/slot.sh down 2 --purge               # remove containers, volumes, network and slots/2
```

Every slot command also accepts `pr:123` in place of a slot number. `--dir`
defaults to this checkout's `peopleportal`; point it at a worktree to run that
PR's code. Server and UI logs land in `slots/<N>/logs/`. `slot.sh` refuses to
act on slot 0, the default stack.

A slot's `up.sh` always writes `slots/<N>/portal.env` and `webui.env`
(`--write-env` is implied) and never creates or edits the checkout's
`peopleportal/server/.env.development` or `webui/.env.development.local`.

## Ports and hostnames

Slot `N` (1 to 99) gets a fixed block of ports: `20000 + N*20 + offset`.

| Offset | Service | Slot 1 | Slot 2 |
| ---: | --- | ---: | ---: |
| 0 | Portal backend | 20020 | 20040 |
| 1 | Vite UI | 20021 | 20041 |
| 2 | MongoDB | 20022 | 20042 |
| 3 | Redis | 20023 | 20043 |
| 4 | Authentik | 20024 | 20044 |
| 5 | Gitea | 20025 | 20045 |
| 6 | Gitea SSH | 20026 | 20046 |
| 7 | Mailpit inbox | 20027 | 20047 |
| 8 | SMTP | 20028 | 20048 |

The block stays below the OS ephemeral ranges (macOS 49152+, Linux 32768+).
These values are forced by `common.sh`, not read from your shell, so two slots
can never collide. The Compose project is `ppdev-sN`. Docker ports bind to
`127.0.0.1` as before.

Each slot is served under its own hostname, `ppN.localhost` (for example
<http://pp2.localhost:20041>). Browsers resolve `*.localhost` to loopback
without any `/etc/hosts` entry. The separate name matters because **cookies
ignore ports**: if every slot used `localhost`, their session cookies would
share one cookie jar and logging into one slot would log you out of, or
confuse, the others. Authentik redirect URIs, the portal base URL, Gitea's URL
and the server's CORS origin are all generated from that hostname. The UI is
bound to `127.0.0.1` explicitly because `*.localhost` names resolve to IPv4
only while Vite's default `localhost` binding may pick `::1`.

## Fixtures

A fixture is a reusable, complete state of a slot. There are two kinds:

- **Snapshot**: a directory under `fixtures/<name>/` produced by
  `fixture.sh save`, holding dumps of the live data.
- **Recipe**: a directory with a `seed.py` that builds the state through the
  Authentik API and Mongo on top of a running slot. `fixtures/default` is a
  recipe. Recipes are idempotent and are what gets committed.

```bash
./scripts/fixture.sh list                      # recipes and snapshots with dates
./scripts/fixture.sh save  mystate --slot 1    # snapshot slot 1 into fixtures/mystate
./scripts/fixture.sh load  default --slot 2    # seed the recipe into slot 2 (starts it if needed)
./scripts/fixture.sh load  mystate --slot 3    # restore a snapshot into slot 3
./scripts/fixture.sh check --slot 2            # verify Mongo references against Authentik
```

`load` refuses slot 0 unless you pass `--slot 0 --force-default`. Both `save`
and `load` stop the slot's host server and UI while they run and restart them
afterwards.

### What a snapshot captures

| Store | Captured | On load |
| --- | --- | --- |
| MongoDB `people-portal` | `mongodump` archive | `mongorestore --drop` |
| Authentik Postgres | `pg_dump` of the `authentik` database, including users, groups, memberships, OIDC clients and tokens | database dropped and recreated, then reconciled (below) |
| Gitea | tar of the Gitea volume (SQLite, repos, config) taken with Gitea stopped | volume emptied and extracted |
| Redis | not captured | `FLUSHALL` (cache only) |
| Mailpit | not captured | inbox cleared |
| S3 | nothing to capture; no S3 service exists in the stack | uploads still fail, as in the README |

`fixtures/<name>/meta.env` records the source slot, project, portal port,
hostname and creation time.

### How a snapshot stays consistent across slots

A restored Authentik database carries the source slot's secrets and URLs. The
loader realigns them with the target slot's `.env`:

1. The `akadmin` password and the `authentik-bootstrap-token` API token are
   rewritten from the target slot's `AUTHENTIK_BOOTSTRAP_PASSWORD` and
   `AUTHENTIK_BOOTSTRAP_TOKEN`.
2. `bootstrap-authentik.sh` reapplies the blueprint. The blueprint reads
   `PORTAL_BASE_URL`, `GITEA_URL` and the OIDC client secrets from the
   worker's environment, so the portal and Gitea OIDC clients end up with the
   target slot's redirect URIs and secrets.
3. The Gitea `devadmin` password is reset from the target `.env`, the stale
   API token file is removed and `bootstrap-gitea.sh` mints a new one.
4. If the source and target portal ports differ, `gitea-rehook.py` rewrites
   every admin, org and repo webhook from `host.docker.internal:<old>` to
   `host.docker.internal:<new>`, so Gitea calls this slot's server rather
   than the one the snapshot came from.
5. `fixture-check.py` walks every Mongo collection and verifies that each
   `teamPk`, `subteamPk`, `hiredSubteamPk` and `recruitingSubteamPks` value
   exists as an Authentik group, and each `userPk`, `inviterPk` and
   `requestorPk` as an Authentik user. Orphans are listed and `load` prints a
   warning.

Recipes avoid most of this: `seed.py` looks up the Authentik pks it creates
and writes those into Mongo, so the two stores agree whatever pks the slot
hands out.

### The default fixture

`fixture.sh load default --slot N` seeds a small but complete club. Every
seeded user has the password `portal-dev`. `akadmin` keeps the slot's
generated password from `slots/N/.env`.

| Login | Role |
| --- | --- |
| `akadmin` | Authentik superuser (renamed "Dev Admin") |
| `prez` | President, member of the Executive Board service team |
| `techlead` | Tech Lead on the root team **Orbit Platform** (owner) |
| `pmlead` | Project Manager in Orbit Leadership (hiring, AWS access, Slack, full Gitea bindles) |
| `swe1`, `swe2` | Engineers in Orbit Engineering (Gitea branch protection override and merge) |
| `designer` | Product Designer in Orbit Design (member management and subteam access) |
| `qa1` | QA Engineer in Orbit QA (no special bindles) |
| `permsadmin` | Operations in Orbit Management (permissions management and bindle sync) |
| `recruitowner` | Project Lead of **Beacon**, the recruiting team |
| `recruiter` | Hiring Manager in Beacon Leadership |
| `beaconeng`, `beacondesign` | Members of Beacon Engineering and Beacon Design |
| `nobindles` | Onboarded user with no team memberships |

Beacon is marked as recruiting for its Engineering and Design subteams with
role-specific questions configured. Ten applicants (`applicant1@example.test`
to `applicant10@example.test`) have applications spread across the stages
Applied, Interview, Rejected, Potential Hire and Hired, with stage history,
star ratings and, for the hired one, a hired role and subteam. Log in as
`recruiter` or `recruitowner` to exercise the recruitment UI.

## Gotchas

- **`NODE_ENV`.** The macOS shell on this machine exports
  `NODE_ENV=production`. Every stack script exports `development` itself and
  the slot server and UI are launched with it set, so nothing inherits the
  production value.
- **Dirty `package-lock.json`.** `./nx serve pplserver` runs `npm install`
  first, which rewrites `peopleportal/server/package-lock.json`. Restore it
  with `git checkout -- peopleportal/server/package-lock.json`. The slot
  scripts avoid this: `pr.sh` installs with `npm ci`, and `slot.sh server`
  runs `tsoa spec-and-routes` and `nodemon` directly through
  `npx --no-install`.
- **The default stack is never touched.** Slot commands refuse slot 0, and
  `fixture.sh load` needs `--force-default` to write to it. Use the README's
  `docker compose stop` and `reset.sh` for `ppdev`.
- **Slot env cannot leak from a checkout.** `slot.sh` sources
  `slots/N/portal.env` and `webui.env` into the process environment before
  starting the apps. Process env wins over `.env*` files for both dotenv and
  Vite, so a worktree's own `.env.development` cannot pull the server back to
  port 3000 or Mongo 27017.
- **PRs that change dev-stack files.** The slot and fixture scripts always run
  from this checkout's `dev-stack`, even when `--dir` points at a worktree.
  To test a PR's changes to the stack itself, run that worktree's scripts
  directly, with `STACK_SLOT` set, and expect state under its own
  `dev-stack/slots/`.
- **Docker memory.** Each slot runs eight containers (Postgres, two Authentik
  processes, Gitea, the OIDC bridge, Mongo, Redis, Mailpit). Budget roughly
  1.5 to 2 GB per slot on top of the default stack and raise Docker Desktop's
  memory limit before running three or more. `slot.sh down` frees memory while
  keeping data.
- **Port range.** Slots use `20000` to `21999`. If a port in a slot's block is
  already taken by something else, `up.sh` fails before starting containers
  and names it; pick another slot number rather than overriding ports.
- **CORS.** The server reads `PEOPLEPORTAL_CORS_ORIGINS` (comma separated,
  default `http://localhost:5173`). Slots set it to
  `http://ppN.localhost:<ui port>` in `portal.env`. In development the UI
  calls the API through the Vite proxy, so this only matters for browser
  requests made directly against the server port (for example the API docs);
  a PR based on a commit before this variable existed still works in a slot.
- **PRs older than #105.** The Vite `PP_DEV_PORTAL_PORT` proxy override was
  added in #105. A PR branched before it starts on the slot's UI port but
  proxies `/api` to `localhost:3000`, the default stack's server. `pr.sh`
  prints a warning when it sees such a checkout; rebase the PR to test it.
