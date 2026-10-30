# App Dev Wiki

The App Dev Club wiki, served at [wiki.appdevclub.com](https://wiki.appdevclub.com). It is a [Docusaurus](https://docusaurus.io/) site, and every page lives under `docs/`.

## Local development

```bash
npm ci
npm start
```

The dev server runs on [localhost:3001](http://localhost:3001), so it does not collide with the People Portal server on port 3000. Most edits reload without a restart.

## Build

```bash
npm run build
```

This writes the static site to `build/`. Broken internal links fail the build. If it runs out of memory, set `NODE_OPTIONS=--max-old-space-size=4096`.

Search is enabled only when `ALGOLIA_APP_ID` and `ALGOLIA_API_KEY` are set, so local builds have no search box.

## Deployment

Pushing changes under `corpwiki/` to `master` runs `.github/workflows/deploy_corpwiki.yml`, which builds the site and deploys it to Cloudflare Pages. There is no manual deploy step.
