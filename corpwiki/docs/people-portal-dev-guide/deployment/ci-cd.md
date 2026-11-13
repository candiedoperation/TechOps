---
sidebar_position: 4
---

# CI/CD

How a commit becomes a running container.

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

Staging is up at **[appdev-corp.iancoutinho.net](https://appdev-corp.iancoutinho.net)**.
Contact Ian for access.

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
