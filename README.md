<img width="64" height="64" alt="App Dev Club Logo" src="https://github.com/user-attachments/assets/4dca5aa5-448f-4efd-b9a0-5c2484c5c191" />

# Tech Ops

Welcome to the main source of all internal technology for the [App Dev Club](https://appdevclub.com). The Tech Ops infrastructure housed in this repository is central to all our operations, powering everything from recruitment, finances, event management, and team provisioning to our public-facing web presence.

This project is structured as a modern **Nx Monorepo**, allowing us to seamlessly manage multiple applications, libraries, and deployments from a single, unified codebase.

## Monorepo Components

This repository contains several distinct applications and services:

### People Portal
The engine behind People Portal. It orchestrates People and Team Management, Recruitment, and Shared Resource Management workflows. It also handles event management, executive permissions, SSO service integrations, team provisioning, and user onboarding. It enforces dynamic permissions via a custom authorization layer called **Bindles**. 

> [!NOTE]
> The [peopleportal](./peopleportal) directory contains all People Portal assets, including the UI, server backend, and Docker deployment configurations.

### Landing Page
The official App Dev Club landing page, currently hosted at [appdevclub.com](https://appdevclub.com). It serves as the front door for prospective members, partners, and sponsors. The source code is located in the [landing-v3](./landing-v3) directory.

### Corp Wiki
The App Dev Wiki, hosted at [wiki.appdevclub.com](https://wiki.appdevclub.com). This is our central knowledge base for internal documentation, guides, and organizational memory. The source code is located in the [corpwiki](./corpwiki) directory.

### Horizon
Scaffolding and initial architecture for the new App Dev **Horizon** project. The source code is located in the [horizon](./horizon) directory.

---

## Quick start for contributors

For People Portal, install Docker with Compose v2.20+, Bash, curl, OpenSSL and
Python 3.9+, plus Node.js 22.12+ and npm for the application. Windows contributors
need WSL2 with Docker integration. From a fresh clone:

```bash
cd peopleportal/dev-stack
./scripts/up.sh --write-env
cd ../..
./nx serve pplserver
# In a second terminal, from the repo root:
./nx serve pplui
```

Open <http://localhost:5173> and log in as `akadmin` using
`AUTHENTIK_BOOTSTRAP_PASSWORD` from the generated `peopleportal/dev-stack/.env`.
Mail lands in [Mailpit](http://localhost:8025). The stack also provides Gitea,
MongoDB and Redis. S3 object storage is not included; resume/avatar uploads
will fail until a local S3 option is added. Garage, SeaweedFS and versitygw are
candidates for a follow-up; no replacement has been selected. S3 env variables
remain placeholders.
AWS provisioning is also unsupported locally; see the [dev-stack README](./peopleportal/dev-stack/README.md) and
[local development guide](./corpwiki/docs/people-portal-dev-guide/deployment/local-development.md).

## Workflows & CI/CD

We rely on GitHub Actions and Nx's powerful task running capabilities to automate our development lifecycle. The available workflows include:

- **People Portal Deployment**: Automatically builds the multi-architecture Docker image (Frontend + Backend) and pushes it to Docker Hub upon changes to the `peopleportal/` directory.
- **Landing Page Deployment**: Builds and deploys the landing page directly to Cloudflare Pages upon changes to `landing-v3/`.
- **Corp Wiki Deployment**: Builds and deploys the wiki documentation site to Cloudflare Pages upon changes to the `corpwiki/` directory.

### Running Tasks Locally

Because this is an Nx workspace, you can use the provided `./nx` wrapper to execute tasks for any project. For exact commands and setup instructions, please visit the specific component folders and see the instructions there.

```bash
# Example commands
./nx build pplsdk-ts
./nx serve pplserver
./nx serve pplui
./nx serve landing-v3
```
