# Fixtures

Reusable slot states for the parallel dev stacks. Usage and the full list of
what is captured are in [../PARALLEL.md](../PARALLEL.md); the commands are
`scripts/fixture.sh list|save|load|check`.

## Formats

A fixture is a directory `fixtures/<name>/` in one of two formats:

- **Recipe**: contains `seed.py`. Runs against a slot that is already up and
  builds the state through the Authentik API and `mongosh`. `fixture.sh load`
  exports the slot's settings (`AUTHENTIK_PORT`, `AUTHENTIK_BOOTSTRAP_TOKEN`,
  `COMPOSE_PROJECT_NAME`, ...) before running it. `default/` is a recipe; see
  PARALLEL.md for its users and logins (password `portal-dev`).
- **Snapshot**: produced by `fixture.sh save <name> --slot N`. Contains
  `mongo.archive.gz`, `authentik.pgdump`, `gitea-data.tar.gz` and `meta.env`.
  Loading realigns the Authentik admin password and token, reapplies the
  blueprint for this slot's OIDC redirect URIs and secrets, resets the Gitea
  admin password and token, and retargets Gitea webhooks to the new portal
  port.

Names must match `[A-Za-z0-9][A-Za-z0-9._-]*`. `save` refuses to overwrite a
recipe directory.

## Adding a recipe

1. Create `fixtures/<name>/seed.py`. Use `default/seed.py` as the template: it
   needs only the Python standard library and talks to Authentik over
   `http://127.0.0.1:$AUTHENTIK_PORT/api/v3` with the bootstrap token.
2. Create data the way the server does (same group names, attributes and
   Mongo document shapes) so the portal treats it as native.
3. Make it idempotent: look up existing groups and users before creating them
   and upsert Mongo documents, so a second `load` is harmless.
4. Write the Authentik pks you obtain into Mongo rather than hard-coding them;
   `fixture.sh check` verifies every cross-service reference afterwards.
5. Load it into a slot and run `fixture.sh check --slot N`.

Seeded credentials are local-only test data. Do not reuse them anywhere.

## Snapshots are not committed

Saved snapshots contain generated secrets and personal-looking data and are
gitignored; only recipe directories such as `default/` belong in git. Share a
state by writing a recipe, or pass the snapshot directory around out of band.
