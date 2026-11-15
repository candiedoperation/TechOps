# Landing V3

This project is now managed by the Nx monorepo build system.

## Available Commands

Instead of running local `npm` scripts, you now run `nx` commands from the **root of the monorepo**:

- **Dev Server**: `nx run landing-v3:serve` (or simply `nx serve landing-v3`)
- **Build**: `nx run landing-v3:build`
- **Start Prod**: `nx run landing-v3:start`
- **Lint**: `nx run landing-v3:lint`

_Note: Running commands like `nx build landing-v3` will automatically ensure that all workspace dependencies (like `@peopleportal/sdk`) are installed and built first!_
