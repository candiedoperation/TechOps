---
sidebar_position: 4
---

# CI/CD

How a commit becomes a running container, for both production and staging.

:::info Monorepo, not three repos
People Portal used to live in `PeoplePortalUI` and `PeoplePortalServer`, with a
third repo, `PeoplePortalDeploy`, assembling the image after a `repository_dispatch`
from each. That is no longer the case. The app is now part of the **TechOps**
monorepo and builds in one workflow. The old repositories are archived history;
their issues were transferred to TechOps.

`PeoplePortalDeploy` still exists, but only as the production VM's compose stack.
It no longer builds anything.
:::

## Production

### The build

`.github/workflows/deploy_peopleportal.yml` runs on pushes to `master` that touch
`peopleportal/**`, and on manual dispatch. It is one job:

1. Checkout, Node 20
2. `./nx run-many -t build -p pplserver pplui` — server and UI build together,
   because the server serves the UI's `dist` from a single container
3. QEMU + Buildx, then `docker/build-push-action` for `linux/amd64` and
   `linux/arm64`

The image is pushed to Docker Hub as `candiedoperation/people-portal:latest` and
`candiedoperation/people-portal:<sha>`. A concurrency group, `deploy-peopleportal`,
serialises runs without cancelling one in progress.

Two platforms because the servers are x86 and most of the team is on Apple
silicon, so the same tag has to run in both places.

### The release

Production is a two-container Compose stack on its own VM, in
`~/PeoplePortalDeploy`: the app, and Traefik terminating TLS via Let's Encrypt and
routing on `Host(${DOMAIN_NAME})`. Config comes from `.env` beside the compose
file.

Pushing the image does **not** deploy it. To pick up a new build:

```bash
cd ~/PeoplePortalDeploy
sudo docker compose pull app
sudo docker compose up -d app
```

:::warning `.env` is read at container creation
`docker restart` reuses the existing container and its environment. Anything you
changed in `.env` only takes effect after `up -d`, which recreates it.
:::

## Staging

Staging runs on a Coolify-managed host as a seven-container service:
people-portal, Authentik server and worker, Postgres, Mongo, Redis and Gitea.
Coolify owns the compose file and `.env`, regenerating both from its database on
every deploy, so edits made directly on the box are reverted by the next one.

Only `master` produces a published image, so staging builds branches locally with
`/opt/pp-deploy/pp-build.sh`:

```bash
/opt/pp-deploy/pp-build.sh feature/my-branch   # build and deploy
/opt/pp-deploy/pp-build.sh --no-deploy <branch>  # build only
/opt/pp-deploy/pp-build.sh --list              # branches on the remote
```

It clones TechOps, runs the Nx build and the image build inside containers (the
host has no Node), and tags the result `people-portal:branch-<sanitised>`, so
several branches can sit side by side. It then points the Coolify service's
`PP_IMAGE` at that tag and triggers a deploy.

:::warning It builds what is pushed
The script clones from GitHub. Local commits you have not pushed are invisible to
it, and it will happily rebuild the previous commit without saying so.
:::

:::danger The token lives on the box
Deployment reads `COOLIFY_API_TOKEN` from `/opt/pp-deploy/.coolify-env`, root-only,
mode 600. That token controls **every** application on the Coolify instance, and
the box is publicly reachable. It was deliberately kept off the host until the
deploy step was folded into the script. Use `--no-deploy` if you would rather
deploy from somewhere else.
:::

`force=true` on the deploy call is not optional: Coolify resolves `${PP_IMAGE}`
into the compose when the service is saved, so an ordinary deploy can reuse the
cached resolution and keep running the old image even though the variable changed.

### Staging images are local only

`people-portal:branch-*` tags exist solely on the staging host. They are in no
registry. If that host loses its images, staging cannot be restored without
re-running `pp-build.sh`. Returning to a published build means setting `PP_IMAGE`
to `candiedoperation/people-portal:latest` and redeploying.

## Sibling workflows

`deploy_landingv3.yml` and `deploy_corpwiki.yml` cover the other projects in the
monorepo. Each is scoped by path, so a change under `peopleportal/` will not
rebuild the wiki and vice versa.

## Secrets

The build workflow needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as repository
secrets. Repository rather than environment secrets, so the workflow runs without
manual approval gates.

For what the container itself needs at runtime, see
[Environment Variables](./environment-variables.md).
